'use strict';

// ══ RECORDATORIOS DE PAGO · SERVICIO (Firestore + Stripe + Resend) ══
// Las reglas puras están en recordatorios-pago.js y los textos en recordatorios-correo.js; aquí solo se juntan con las lecturas y escrituras.
//
// Colecciones SOLO DEL SERVIDOR (el navegador nunca las escribe; las reglas de Firestore v6 publicadas las niegan con su comodín final):
//   recordatoriosPago/{uid}                  el estado de cada persona: ciclo, paso, cupón, baja, preferencia, cierre, reserva de envío
//   recordatoriosEstadisticas/global         enviados por paso, cupones creados, pagos con cupón (por paso), convertidas
//   recordatoriosEstadisticas/dia-AAAA-MM-DD cuántos se enviaron ese día (para el tope diario)
//   config/recordatorios                     { modo: 'activo' | 'apagado' (ARRANCA APAGADO), topeDiario, maxPorCorrida }
//   config/recordatoriosArrendamiento        el bloqueo para que dos instancias del servidor nunca envíen a la vez
//
// Garantías de envío: (1) ciclos de 7 pasos con descanso de 4 días y máximo 3 ciclos por persona (todo en SERIE/CONFIG de recordatorios-pago.js); (2) bloqueo por arrendamiento entre instancias; (3) bloqueo por persona con
// una reserva guardada ANTES de llamar a Resend (con el código del cupón dentro); (4) clave de idempotencia por persona y paso en Resend (un
// reinicio a mitad reenvía exactamente el mismo correo y Resend lo ignora si ya salió); (5) si Resend falla o limita, el paso NO se marca como enviado.

const crypto = require('crypto');
const R = require('./recordatorios-pago');
const C = require('./recordatorios-correo');

const ID_CUPON = monto => 'FISIOTECK_RECORDATORIO_' + monto;
const MARCA = 'fisioteck';
const aMs = v => {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return 0; } }
  if (typeof v === 'object' && Number.isFinite(Number(v._seconds))) return Number(v._seconds) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};
const noExiste = err => Boolean(err && (err.code === 'resource_missing' || err.statusCode === 404 || err.status === 404));
const pausa = ms => new Promise(r => setTimeout(r, ms));
const TOPE_FILAS = 5000;

function crearServicio({
  db, auth, stripe, enviarCorreo, correoConfigurado = () => true, tieneAcceso, correosAdmin = () => [], claveBaja, urls, leerPrecioMes, leerCursosPrueba = async () => new Map(),
  reloj = () => Date.now(), pausaEntreEnviosMs = 1500, registro = console, instancia = crypto.randomBytes(6).toString('hex')
}) {
  // Sin la llave de firmas (enlaces de baja) o sin correo configurado NO se envía nada
  const listoParaEnviar = () => Boolean(claveBaja) && Boolean(correoConfigurado());
  const refPersona = uid => db.collection('recordatoriosPago').doc(uid);
  const refConfig = () => db.collection('config').doc('recordatorios');
  const refArrendamiento = () => db.collection('config').doc('recordatoriosArrendamiento');
  const refGlobal = () => db.collection('recordatoriosEstadisticas').doc('global');
  const refDia = ms => db.collection('recordatoriosEstadisticas').doc('dia-' + R.diaMexico(ms));
  const admins = () => correosAdmin().map(c => String(c).toLowerCase());

  // ───────── Configuración (interruptor que ARRANCA APAGADO) ─────────
  const leerConfig = async () => {
    const snap = await refConfig().get();
    return R.normalizarConfig(snap.exists ? snap.data() : null);
  };
  const fijarModo = async (modo, quien = '') => {
    if (!['activo', 'apagado'].includes(modo)) throw new Error('Modo inválido');
    await refConfig().set({ modo, actualizadoEn: reloj(), actualizadoPor: String(quien).slice(0, 160) }, { merge: true });
    return leerConfig();
  };
  const fijarLimites = async ({ topeDiario, maxPorCorrida }) => {
    const c = R.normalizarConfig({ topeDiario, maxPorCorrida });
    await refConfig().set({ topeDiario: c.topeDiario, maxPorCorrida: c.maxPorCorrida, actualizadoEn: reloj() }, { merge: true });
    return leerConfig();
  };

  // ───────── Stripe: producto, cupones base y códigos únicos ─────────
  // Un cupón base por monto, con ID fijo, marcado como de FisioTeck (el checkout solo lo aplica al plan mensual). Si ya existe, se reutiliza.
  const asegurarCuponBase = async monto => {
    const id = ID_CUPON(monto);
    try {
      const existente = await stripe.coupons.retrieve(id);
      if (existente && existente.metadata && existente.metadata.marca && existente.metadata.marca !== MARCA) throw new Error('El cupón ' + id + ' pertenece a otra marca');
      return id;
    } catch (err) { if (!noExiste(err)) throw err; }
    try {
      await stripe.coupons.create({
        id, name: 'FisioTeck · ' + C.pesos(monto) + ' menos en el primer mes', amount_off: monto * 100, currency: 'mxn', duration: 'once',
        metadata: { marca: MARCA, uso: 'recordatorios-pago' }
      });
    } catch (err) { if (!(err && /already exists|ya existe/i.test(String(err.message || '')))) throw err; }
    return id;
  };
  // Un código promocional ÚNICO por envío: un solo uso, 24 h, solo primera compra, solo el plan mensual (el checkout solo lo aplica a ese plan)
  const crearCodigo = async ({ monto, uid, paso, ciclo = 1, venceMs, prueba = false }) => {
    const cupon = await asegurarCuponBase(monto);
    let ultimo;
    for (let intento = 0; intento < 4; intento++) {
      const code = R.codigoAleatorio(monto);
      try {
        const promo = await stripe.promotionCodes.create({
          coupon: cupon, code, max_redemptions: 1, expires_at: Math.floor(venceMs / 1000), restrictions: { first_time_transaction: true },
          metadata: { marca: MARCA, uid: uid || '', paso: String(paso), ciclo: String(ciclo), prueba: prueba ? 'si' : 'no' }
        });
        return { codigo: (promo && promo.code) || code, promoId: (promo && promo.id) || '' };
      } catch (err) { ultimo = err; if (!(err && /already exists|ya existe/i.test(String(err.message || '')))) break; }
    }
    throw ultimo;
  };

  // ───────── Estadísticas guardadas ─────────
  const leerGlobal = async () => {
    const s = await refGlobal().get();
    const d = s.exists ? (s.data() || {}) : {};
    const mapa = (obj, claves) => Object.fromEntries(claves.map(k => [k, Math.max(0, Math.floor(Number(obj && obj[k]) || 0))]));
    const pasos = R.SERIE.map(x => 'p' + x.paso);
    const montos = R.MONTOS.map(m => 'm' + m);
    const ciclos = Array.from({ length: R.CONFIG.maxCiclos }, (_, i) => 'c' + (i + 1));
    return {
      desdeMs: Number(d.desdeMs) || 0,
      enviadosPaso: mapa(d.enviadosPaso, pasos),
      enviadosCiclo: mapa(d.enviadosCiclo, ciclos),
      cuponesCreados: mapa(d.cuponesCreados, montos),
      pagosConCuponPaso: mapa(d.pagosConCuponPaso, pasos),
      pagosConCuponCiclo: mapa(d.pagosConCuponCiclo, ciclos),
      pagosTrasCorreoPaso: mapa(d.pagosTrasCorreoPaso, ['p0', ...pasos]),
      convertidas: Math.max(0, Math.floor(Number(d.convertidas) || 0)),
      pagosSinCupon: Math.max(0, Math.floor(Number(d.pagosSinCupon) || 0)),
      bajas: Math.max(0, Math.floor(Number(d.bajas) || 0))
    };
  };
  const sumarGlobal = async cambios => {
    try {
      await db.runTransaction(async tx => {
        const s = await tx.get(refGlobal());
        const d = s.exists ? (s.data() || {}) : {};
        const nuevo = { ...d, desdeMs: d.desdeMs || reloj() };
        for (const [ruta, n] of cambios) {
          const partes = ruta.split('.');
          if (partes.length === 1) nuevo[partes[0]] = (Number(nuevo[partes[0]]) || 0) + n;
          else { const sub = { ...(nuevo[partes[0]] || {}) }; sub[partes[1]] = (Number(sub[partes[1]]) || 0) + n; nuevo[partes[0]] = sub; }
        }
        tx.set(refGlobal(), nuevo);
      });
    } catch (err) { registro.error('Estadística de recordatorios no guardada:', err && err.message); }
  };
  const enviadosHoy = async ms => {
    const s = await refDia(ms).get();
    return s.exists ? Math.max(0, Math.floor(Number((s.data() || {}).enviados) || 0)) : 0;
  };
  const sumarDia = async ms => {
    try {
      await db.runTransaction(async tx => {
        const s = await tx.get(refDia(ms));
        tx.set(refDia(ms), { enviados: (s.exists ? Math.floor(Number((s.data() || {}).enviados) || 0) : 0) + 1, dia: R.diaMexico(ms) });
      });
    } catch (err) { registro.error('Contador diario de recordatorios no guardado:', err && err.message); }
  };

  // ───────── Lectura de personas ─────────
  const cacheCuentas = new Map();   // uid -> { ms, cuenta }
  const VIGENCIA_CUENTA_MS = 10 * 60 * 1000;
  const cuentasDe = async (uids, ahoraMs) => {
    const salida = new Map();
    const faltan = [];
    for (const uid of uids) {
      const c = cacheCuentas.get(uid);
      if (c && ahoraMs - c.ms < VIGENCIA_CUENTA_MS) salida.set(uid, c.cuenta); else faltan.push(uid);
    }
    for (let i = 0; i < faltan.length; i += 100) {
      const lote = faltan.slice(i, i + 100);
      try {
        const r = await auth.getUsers(lote.map(uid => ({ uid })));
        for (const u of r.users || []) {
          const cuenta = { emailVerified: u.emailVerified === true, disabled: u.disabled === true, creadoMs: aMs(u.metadata && u.metadata.creationTime), existe: true };
          cacheCuentas.set(u.uid, { ms: ahoraMs, cuenta }); salida.set(u.uid, cuenta);
        }
        for (const n of r.notFound || []) { const cuenta = { emailVerified: false, disabled: false, creadoMs: 0, existe: false }; cacheCuentas.set(n.uid, { ms: ahoraMs, cuenta }); salida.set(n.uid, cuenta); }
      } catch (err) { registro.error('No se pudo consultar Firebase Auth:', err && err.message); }
    }
    return salida;
  };
  const olvidarCuenta = uid => cacheCuentas.delete(uid);

  const leerColeccion = async nombre => {
    const snap = await db.collection(nombre).limit(TOPE_FILAS).get();
    return snap.docs.map(d => ({ id: d.id, data: d.data() || {} }));
  };

  // Todas las cuentas con lo necesario para decidir. Solo consulta Firebase Auth de quien pasa las reglas locales.
  const analizar = async ahoraMs => {
    const [miembros, estados, titulosCurso] = await Promise.all([leerColeccion('members'), leerColeccion('recordatoriosPago'), leerCursosPrueba()]);
    const porEstado = new Map(estados.map(x => [x.id, x.data]));
    const cursoDePrueba = new Map(miembros.map(m => [m.id, titulosCurso.get(String(m.data.trialCourseId == null ? '' : m.data.trialCourseId)) || '']));
    const pre = miembros.map(({ id, data }) => {
      const e = porEstado.get(id) || null;
      const el = R.elegibilidad({ miembro: data, estado: e, tieneAcceso, correosAdmin: admins(), ahoraMs });
      return { uid: data.uid || id, id, miembro: data, estado: e, local: el };
    });
    const paraAuth = pre.filter(f => f.local.ok).map(f => f.id);
    const cuentas = await cuentasDe(paraAuth, ahoraMs);
    const filas = pre.map(f => {
      const cuenta = cuentas.get(f.id) || null;
      let el = f.local;
      if (el.ok && cuenta) { if (!cuenta.existe) el = { ok: false, motivo: 'cuenta-inexistente' }; else if (cuenta.disabled) el = { ok: false, motivo: 'cuenta-deshabilitada' }; else if (!cuenta.emailVerified) el = { ok: false, motivo: 'correo-sin-verificar' }; }
      const estado = R.normalizarEstado(f.estado);
      const registroMs = estado.registroMs || aMs(f.miembro.createdAt) || (cuenta && cuenta.creadoMs) || 0;
      const sig = el.ok ? R.siguienteEnvio(estado, registroMs) : null;
      const etapa = R.etapaDe({ estado, motivoNoElegible: el.ok ? '' : el.motivo, ahoraMs, registroMs });
      return {
        uid: f.id, nombre: String(f.miembro.name || f.miembro.displayName || '').slice(0, 120), correo: String(f.miembro.email || '').toLowerCase(),
        cursoPrueba: cursoDePrueba.get(f.id) || '', estado, estadoCrudo: f.estado, registroMs, elegible: el.ok, motivo: el.ok ? '' : el.motivo,
        siguiente: sig, etapa: etapa.etapa, etapaTexto: etapa.texto, toca: el.ok ? R.tocaAhora(estado, registroMs, ahoraMs) : null
      };
    });
    return { filas };
  };

  // ───────── Envío de un paso ─────────
  const enlaces = uid => ({ urlCompra: urls.compra, urlBaja: urls.baja(uid, R.firmarBaja(claveBaja, uid)) });
  const armarYEnviar = async ({ uid, correo, nombre, cursoPrueba, ciclo = 1, paso, codigo, venceMs, primerAviso, prueba = false, idempotencia = '' }) => {
    const precioMes = await leerPrecioMes();
    const { urlCompra, urlBaja } = enlaces(uid || 'prueba');
    const p = C.plantilla({ paso, ciclo, uid, nombre, cursoPrueba, precioMes, codigo, venceMs, urlCompra, urlBaja, primerAviso, prueba });
    return enviarCorreo({
      para: correo, asunto: p.asunto, html: p.html, texto: p.text,
      headers: { 'List-Unsubscribe': '<' + urlBaja + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: [{ name: 'tipo', value: 'recordatorio-pago' }, { name: 'ciclo', value: String(ciclo) }, { name: 'paso', value: String(paso) }],
      idempotencyKey: idempotencia || undefined
    });
  };

  // Transacción: guarda la reserva ANTES de llamar a Resend. Devuelve la reserva (nueva o la que quedó de un reinicio) o null si ya no toca.
  const reservar = async ({ uid, ciclo, paso, registroMs, ahoraMs }) => db.runTransaction(async tx => {
    const s = await tx.get(refPersona(uid));
    const e = R.normalizarEstado(s.exists ? s.data() : null);
    if (e.baja || e.optOut || e.cerrada) return null;
    const pos = R.posicionSiguiente(e);
    const esLaReserva = Boolean(e.reserva && e.reserva.ciclo === ciclo && e.reserva.paso === paso);
    if (!pos || pos.ciclo !== ciclo || pos.paso !== paso) return esLaReserva && pos ? { ...e.reserva, retomada: true } : null;
    if (esLaReserva && !R.reservaPerdida(e, ahoraMs)) return { ...e.reserva, retomada: true };
    const token = crypto.randomBytes(8).toString('hex');
    const nuevo = R.estadoTrasReservar({ ...e, registroMs: e.registroMs || registroMs }, { ciclo, paso, token, ahoraMs });
    tx.set(refPersona(uid), nuevo, { merge: true });
    return { ...nuevo.reserva, retomada: false };
  });
  const completarReserva = (uid, reserva) => db.runTransaction(async tx => {
    const s = await tx.get(refPersona(uid));
    const e = R.normalizarEstado(s.exists ? s.data() : null);
    if (!e.reserva || e.reserva.token !== reserva.token) return false;
    tx.set(refPersona(uid), { ...e, reserva }, { merge: true });
    return true;
  });
  const confirmarEnvio = (uid, { ciclo, paso, ahoraMs, codigo, promoId, venceMs, token }) => db.runTransaction(async tx => {
    const s = await tx.get(refPersona(uid));
    const e = R.normalizarEstado(s.exists ? s.data() : null);
    if (e.enviados > 0 && (e.ciclo > ciclo || (e.ciclo === ciclo && e.paso >= paso))) return false;   // ya estaba confirmado
    tx.set(refPersona(uid), R.estadoTrasEnviar(e, { ciclo, paso, ahoraMs, codigo, promoId, venceMs }), { merge: false });
    void token;
    return true;
  });
  const registrarFallo = (uid, mensaje, ahoraMs) => db.runTransaction(async tx => {
    const s = await tx.get(refPersona(uid));
    if (!s.exists) return;
    tx.set(refPersona(uid), R.estadoTrasFallo(s.data(), { ahoraMs, mensaje }));
  });

  const enviarPersona = async fila => {
    const { ciclo, paso } = fila.toca;
    const ahoraMs = reloj();
    const reserva = await reservar({ uid: fila.uid, ciclo, paso, registroMs: fila.registroMs, ahoraMs });
    if (!reserva) return { estado: 'omitido' };
    let { codigo = '', promoId = '', venceMs = 0 } = reserva;
    const monto = R.montoDelPaso(paso);
    try {
      if (monto && !codigo) {
        venceMs = ahoraMs + R.CONFIG.vigenciaCuponMs;
        const c = await crearCodigo({ monto, uid: fila.uid, paso, ciclo, venceMs });
        codigo = c.codigo; promoId = c.promoId;
        await completarReserva(fila.uid, { ...reserva, codigo, promoId, venceMs });
        await sumarGlobal([['cuponesCreados.m' + monto, 1]]);
      }
      const r = await armarYEnviar({
        uid: fila.uid, correo: fila.correo, nombre: fila.nombre, cursoPrueba: fila.cursoPrueba, ciclo, paso, codigo, venceMs,
        primerAviso: fila.estado.enviados === 0, idempotencia: 'fisioteck-recordatorio-' + fila.uid + '-c' + ciclo + '-p' + paso
      });
      if (!r || r.ok !== true) {
        const mensaje = 'Resend ' + ((r && (r.status || r.motivo)) || 'sin respuesta');
        await registrarFallo(fila.uid, mensaje, reloj());
        return { estado: 'fallo', mensaje, limite: Boolean(r && (r.status === 429 || r.motivo === 'limite')), esperarSegundos: r && r.esperarSegundos || 0, sinConfigurar: Boolean(r && r.motivo === 'sin-configurar') };
      }
      const confirmado = await confirmarEnvio(fila.uid, { ciclo, paso, ahoraMs: reloj(), codigo, promoId, venceMs, token: reserva.token });
      if (confirmado) { await sumarGlobal([['enviadosPaso.p' + paso, 1], ['enviadosCiclo.c' + ciclo, 1]]); await sumarDia(reloj()); }
      return { estado: 'enviado', ciclo, paso, codigo, retomada: Boolean(reserva.retomada) };
    } catch (err) {
      registro.error('Recordatorio no enviado:', err && err.message);
      try { await registrarFallo(fila.uid, err && err.message, reloj()); } catch (_) { /* se reintenta en la siguiente corrida */ }
      return { estado: 'fallo', mensaje: err && err.message };
    }
  };

  // ───────── Arrendamiento (bloqueo entre instancias) ─────────
  const tomarArrendamiento = ahoraMs => db.runTransaction(async tx => {
    const s = await tx.get(refArrendamiento());
    const nuevo = R.tomarArrendamiento(s.exists ? s.data() : null, instancia, ahoraMs);
    if (!nuevo) return false;
    tx.set(refArrendamiento(), nuevo);
    return true;
  });
  const soltarArrendamiento = () => db.runTransaction(async tx => {
    const s = await tx.get(refArrendamiento());
    if (s.exists && (s.data() || {}).propietario === instancia) tx.set(refArrendamiento(), { propietario: '', venceMs: 0 });
  }).catch(() => {});

  // ───────── Una corrida: manda lo que ya toca, dentro del horario y de los topes ─────────
  const procesar = async ({ ensayo = false } = {}) => {
    const ahoraMs = reloj();
    const cfg = await leerConfig();
    if (!ensayo && cfg.modo !== 'activo') return { omitido: 'apagado' };
    if (!ensayo && !listoParaEnviar()) return { omitido: 'sin-configurar' };
    if (!ensayo && !R.dentroDeHorario(ahoraMs)) return { omitido: 'fuera-de-horario' };
    if (!ensayo && !(await tomarArrendamiento(ahoraMs))) return { omitido: 'otra-instancia' };
    try {
      const { filas } = await analizar(ahoraMs);
      const hoy = await enviadosHoy(ahoraMs);
      const cupo = R.cupoDeEnvios({ topeDiario: cfg.topeDiario, enviadosHoy: hoy, maxPorCorrida: cfg.maxPorCorrida });
      const vencidas = filas.filter(f => f.elegible && f.siguiente && f.siguiente.debeSalirMs <= ahoraMs && !(f.estado.reintentarMs && ahoraMs < f.estado.reintentarMs) && f.estado.fallos < R.CONFIG.maxFallosSeguidos)
        .sort((a, b) => a.siguiente.debeSalirMs - b.siguiente.debeSalirMs);
      if (ensayo) {
        return {
          ensayo: true, modo: cfg.modo, dentroDeHorario: R.dentroDeHorario(ahoraMs), enviadosHoy: hoy, topeDiario: cfg.topeDiario, cupo, vencidas: vencidas.length,
          recibirian: vencidas.slice(0, Math.max(cupo, 0) || 0).map(f => ({ uid: f.uid, nombre: f.nombre, correo: f.correo, ciclo: f.siguiente.ciclo, paso: f.siguiente.paso, monto: f.siguiente.monto, debioSalirMs: f.siguiente.debeSalirMs })),
          restantes: Math.max(0, vencidas.length - cupo), sinCreditos: cupo === 0
        };
      }
      const resultado = { enviados: 0, fallos: 0, omitidos: 0, vencidas: vencidas.length, cupo };
      let pendientesPorEnviar = vencidas.slice(0, cupo);
      pendientesPorEnviar = pendientesPorEnviar.map(f => ({ ...f, toca: R.tocaAhora(f.estado, f.registroMs, ahoraMs) })).filter(f => f.toca);
      for (const f of pendientesPorEnviar) {
        const r = await enviarPersona(f);
        if (r.estado === 'enviado') { resultado.enviados++; registro.log('Recordatorio de pago', r.paso, 'enviado a', f.correo); }
        else if (r.estado === 'fallo') {
          resultado.fallos++;
          if (r.sinConfigurar) { resultado.omitido = 'sin-configurar'; break; }
          if (r.limite) { resultado.limite = true; resultado.esperarSegundos = r.esperarSegundos || 0; break; }     // Resend limitó: se detiene la corrida
        } else resultado.omitidos++;
        if (pausaEntreEnviosMs) await pausa(pausaEntreEnviosMs);
      }
      return resultado;
    } finally {
      if (!ensayo) await soltarArrendamiento();
    }
  };

  // ───────── Panel: resumen y lista ─────────
  const resumen = async () => {
    const ahoraMs = reloj();
    const [cfg, { filas }, global, hoy] = await Promise.all([leerConfig(), analizar(ahoraMs), leerGlobal(), enviadosHoy(ahoraMs)]);
    const cupo = R.cupoDeEnvios({ topeDiario: cfg.topeDiario, enviadosHoy: hoy, maxPorCorrida: cfg.maxPorCorrida });
    const elegibles = filas.filter(f => f.elegible);
    const conteo = { elegibles: elegibles.length, porVerificar: filas.filter(f => f.motivo === 'correo-sin-verificar').length };
    for (const f of filas) { conteo[f.etapa] = (conteo[f.etapa] || 0) + 1; }
    const proximos = elegibles.filter(f => f.siguiente).sort((a, b) => a.siguiente.saleMs - b.siguiente.saleMs).slice(0, 25)
      .map(f => ({ uid: f.uid, nombre: f.nombre, correo: f.correo, ciclo: f.siguiente.ciclo, paso: f.siguiente.paso, monto: f.siguiente.monto, saleMs: f.siguiente.saleMs }));
    // Lo que ya le tocaba sale en la próxima revisión (dentro del horario): esa es la hora real del primer envío
    const efectivo = (saleMs, ahora) => (saleMs > ahora ? saleMs : R.ajustarAHorario(ahora));
    const recientes = filas.filter(f => f.estado.ultimoEnvioMs > 0).sort((a, b) => b.estado.ultimoEnvioMs - a.estado.ultimoEnvioMs).slice(0, 10)
      .map(f => ({ uid: f.uid, nombre: f.nombre, correo: f.correo, ciclo: f.estado.ciclo, paso: f.estado.paso, monto: R.montoDelPaso(f.estado.paso), enviadoMs: f.estado.ultimoEnvioMs }));
    return {
      ahoraMs, modo: cfg.modo, topeDiario: cfg.topeDiario, maxPorCorrida: cfg.maxPorCorrida, enviadosHoy: hoy, faltanHoy: Math.max(0, cfg.topeDiario - hoy), cupoCorrida: cupo,
      dentroDeHorario: R.dentroDeHorario(ahoraMs), calificarian: elegibles.length,
      primerEnvioMs: proximos.length ? efectivo(proximos[0].saleMs, ahoraMs) : 0, proximos, recientes, conteo,
      listasAhora: elegibles.filter(f => f.siguiente && f.siguiente.debeSalirMs <= ahoraMs).length,
      serie: R.SERIE.map(s => ({ paso: s.paso, monto: s.monto, esperaHoras: Math.round(s.esperaMs / R.HORA), desde: s.desde })),
      maxCiclos: R.CONFIG.maxCiclos, descansoDias: Math.round(R.CONFIG.descansoMs / R.DIA), vigenciaHoras: Math.round(R.CONFIG.vigenciaCuponMs / R.HORA),
      estadisticas: global
    };
  };
  const ETAPAS = ['todas', 'listas-ahora', 'programadas', 'en-espera', 'enviado', 'cupon-vigente', 'descanso', 'convertida', 'pago', 'baja', 'cerrada', 'sin-verificar', 'excluida'];
  const listado = async ({ q = '', etapa = 'todas', pagina = 1, porPagina = 25 } = {}) => {
    const ahoraMs = reloj();
    const { filas } = await analizar(ahoraMs);
    const texto = String(q || '').trim().toLowerCase().slice(0, 80);
    let lista = filas.filter(f => f.etapa !== 'excluida' || f.motivo !== 'admin');
    // “Listas ahora” = ya les toca su siguiente correo (salen en la próxima revisión dentro del horario); “Programadas” = les toca más adelante
    if (etapa === 'listas-ahora') lista = lista.filter(f => f.elegible && f.siguiente && f.siguiente.debeSalirMs <= ahoraMs);
    else if (etapa === 'programadas') lista = lista.filter(f => f.elegible && f.siguiente && f.siguiente.debeSalirMs > ahoraMs);
    else if (ETAPAS.includes(etapa) && etapa !== 'todas') lista = lista.filter(f => f.etapa === etapa);
    if (texto) lista = lista.filter(f => (f.correo + ' ' + f.nombre.toLowerCase()).includes(texto));
    lista.sort((a, b) => (b.registroMs || 0) - (a.registroMs || 0));
    const total = lista.length;
    const p = Math.max(1, Math.floor(pagina) || 1);
    const items = lista.slice((p - 1) * porPagina, p * porPagina).map(f => ({
      uid: f.uid, nombre: f.nombre, correo: f.correo, etapa: f.etapa, estado: f.etapaTexto, ciclo: f.estado.ciclo, paso: f.estado.paso, enviados: f.estado.enviados, registroMs: f.registroMs,
      proximoMs: f.siguiente ? f.siguiente.saleMs : 0, vencida: Boolean(f.siguiente && f.siguiente.saleMs <= ahoraMs), proximoPaso: f.siguiente ? f.siguiente.paso : 0, proximoCiclo: f.siguiente ? f.siguiente.ciclo : 0,
      cuponVenceMs: f.estado.cuponVenceMs > ahoraMs ? f.estado.cuponVenceMs : 0, cursoPrueba: f.cursoPrueba, motivo: f.motivo
    }));
    return { total, pagina: p, porPagina, hayMas: p * porPagina < total, items };
  };

  // ───────── Correo de PRUEBA para el administrador (cupón real, restringido, marcado prueba; no toca estados ni estadísticas) ─────────
  const enviarPrueba = async ({ paso, ciclo = 1, correo, nombre }) => {
    if (!R.definicion(paso)) throw new Error('Paso inválido');
    ciclo = Math.min(R.CONFIG.maxCiclos, Math.max(1, Math.floor(Number(ciclo)) || 1));
    const monto = R.montoDelPaso(paso);
    const venceMs = reloj() + R.CONFIG.vigenciaCuponMs;
    const c = monto ? await crearCodigo({ monto, uid: '', paso, ciclo, venceMs, prueba: true }) : { codigo: '', promoId: '' };
    const r = await armarYEnviar({ uid: 'prueba-' + paso, correo, nombre, cursoPrueba: '', ciclo, paso, codigo: c.codigo, venceMs: monto ? venceMs : 0, primerAviso: paso === 1 && ciclo === 1, prueba: true });
    if (!r || r.ok !== true) { const e = new Error(r && r.motivo === 'sin-configurar' ? 'El correo no está configurado en el servidor (falta RESEND_API_KEY o MAIL_FROM)' : 'No se pudo enviar el correo de prueba'); e.status = 502; throw e; }
    return { ciclo, paso, codigo: c.codigo, venceMs: monto ? venceMs : 0 };
  };

  // ───────── Baja y preferencia ─────────
  const darDeBaja = async uid => {
    const m = await db.collection('members').doc(uid).get();
    if (!m.exists) return false;
    let nueva = false;
    await db.runTransaction(async tx => {
      const s = await tx.get(refPersona(uid));
      const e = R.normalizarEstado(s.exists ? s.data() : null);
      nueva = !e.baja;
      tx.set(refPersona(uid), R.estadoTrasBaja(s.exists ? s.data() : null, { ahoraMs: reloj() }), { merge: false });
    });
    if (nueva) await sumarGlobal([['bajas', 1]]);
    return true;
  };
  const fijarPreferencia = async (uid, quiere, origen = 'perfil') => {
    let resultado = null;
    await db.runTransaction(async tx => {
      const s = await tx.get(refPersona(uid));
      const nuevo = R.estadoTrasPreferencia(s.exists ? s.data() : null, { quiere, ahoraMs: reloj(), origen });
      tx.set(refPersona(uid), nuevo, { merge: false });
      resultado = nuevo;
    });
    return { recibe: !resultado.optOut && !resultado.baja, baja: resultado.baja };
  };
  const leerPreferencia = async uid => {
    const s = await refPersona(uid).get();
    const e = R.normalizarEstado(s.exists ? s.data() : null);
    return { recibe: !e.optOut && !e.baja, baja: e.baja, optOut: e.optOut };
  };

  // ───────── Cupón de la persona y pago ─────────
  const miCupon = async (uid, miembro) => {
    const s = await refPersona(uid).get();
    if (!s.exists) return null;
    const precioMes = await leerPrecioMes().catch(() => R.CONFIG.precioMesMXN);
    return R.cuponVigente(s.data(), { miembro, tieneAcceso, ahoraMs: reloj(), precioMes, correosAdmin: admins() });
  };
  // El cupón que el checkout aplica solo: se comprueba también en Stripe (activo, sin vencer y sin usar) y que sea de FisioTeck
  const cuponParaCheckout = async (uid, miembro) => {
    const c = await miCupon(uid, miembro);
    if (!c || !c.promoId) return null;
    try {
      const promo = await stripe.promotionCodes.retrieve(c.promoId);
      const sigueVivo = promo && promo.active !== false && (!promo.expires_at || promo.expires_at * 1000 > reloj() + 30000) &&
        (!promo.max_redemptions || (promo.times_redeemed || 0) < promo.max_redemptions) && (!promo.metadata || !promo.metadata.marca || promo.metadata.marca === MARCA);
      return sigueVivo ? c : null;
    } catch (err) { return null; }
  };
  // Webhook de pago: cierra la serie de la persona y suma estadísticas. Nunca toca códigos ni pagos de otras marcas ni los códigos de prueba.
  // promoId / codigo: el código promocional que se canjeó en ese pago (si lo hubo); marca y prueba salen de la metadata de ese código en Stripe.
  const registrarPago = async ({ uid, promoId = '', codigo = '', pasoCupon = 0, marca = MARCA, prueba = false, ahoraMs = reloj() }) => {
    if (!uid) return { cerrada: false };
    const conCupon = Boolean(promoId || codigo) && marca === MARCA && !prueba;
    let antes = null; let yaCerrada = false; let paso = 0;
    await db.runTransaction(async tx => {
      const s = await tx.get(refPersona(uid));
      antes = R.normalizarEstado(s.exists ? s.data() : null);
      if (antes.cerrada === 'convertida' || antes.cerrada === 'pago') { yaCerrada = true; return; }
      paso = conCupon ? (pasoCupon || (codigo && codigo === antes.cuponCodigo ? antes.paso : 0)) : 0;
      tx.set(refPersona(uid), R.estadoTrasPago(s.exists ? s.data() : null, { ahoraMs, codigo: conCupon ? (codigo || antes.cuponCodigo) : '', paso, conCupon }), { merge: false });
    });
    if (yaCerrada) return { cerrada: false, yaCerrada: true };
    const cambios = [['pagosTrasCorreoPaso.p' + antes.paso, 1]];
    if (conCupon) { cambios.push(['convertidas', 1]); if (paso >= 1) { cambios.push(['pagosConCuponPaso.p' + paso, 1]); cambios.push(['pagosConCuponCiclo.c' + antes.ciclo, 1]); } } else cambios.push(['pagosSinCupon', 1]);
    await sumarGlobal(cambios);
    return { cerrada: true, conCupon, paso, ciclo: antes.ciclo, pasoAlPagar: antes.paso };
  };

  return {
    listoParaEnviar, leerConfig, fijarModo, fijarLimites, asegurarCuponBase, crearCodigo, analizar, procesar, resumen, listado, enviarPrueba,
    darDeBaja, fijarPreferencia, leerPreferencia, miCupon, cuponParaCheckout, registrarPago, leerGlobal, olvidarCuenta, instancia, ETAPAS
  };
}

module.exports = { crearServicio, ID_CUPON, MARCA, aMs };
