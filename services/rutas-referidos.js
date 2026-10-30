'use strict';
// Rutas de REFERIDOS y del PREMIO POR INVITAR (adaptado de Zoorigen).
//   POST /api/referidos/registrar  { codigo, deviceId, huella }  el invitado se registra con el código de quien lo invitó (idempotente)
//   GET  /api/referidos/estado     la pantalla "Invitar amigos" del socio: código, enlace, invitados (solo alias), hitos y premio
//   POST /api/premios/usar         { cursoId } canjea el premio por UN curso abierto antes de su fecha
//   GET  /api/admin/referidos      todas las invitaciones, para el panel (solo administradores)
// Colecciones solo del servidor: referidos/{uidInvitado}, dispositivosAnfitrion/{uid}, codigosReferido/{CODIGO},
// members/{uid}/progress/premios. El navegador no las toca (reglas de Firestore).
const R = require('./referidos');
const { esAdminPorToken, cursoDeCatalogo } = require('./certificados');

const MAX_INVITADOS_LEIDOS = 200;
const LECTURAS_POR_MINUTO = 60;
const ESCRITURAS_POR_MINUTO = 10;

function errorHttp(status, mensaje) { const e = new Error(mensaje); e.status = status; return e; }

function crearLimitadorMinuto() {
  const usos = new Map();
  return (clave, max) => {
    const t = Date.now();
    const recientes = (usos.get(clave) || []).filter(x => t - x < 60000);
    if (recientes.length >= max) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.');
    recientes.push(t); usos.set(clave, recientes);
    if (usos.size > 5000) usos.clear();
  };
}

// deps: { db, admin, cargarCatalogo(), tieneMembresia(miembro), evaluarAcceso?(uid, decoded) }
function montarRutasReferidos(app, deps) {
  const { db, admin } = deps;
  const ESTADOS = R.ESTADOS;
  const limitar = crearLimitadorMinuto();

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (etiqueta, soloAdmin, fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const d = await sesion(req, res); if (!d) return;
      if (soloAdmin && !esAdminPorToken(d)) return res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' });
      await fn(req, res, d);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[referidos ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };

  const miembroDe = async uid => { const s = await db.collection('members').doc(uid).get(); return s.exists ? (s.data() || {}) : null; };
  const esMiembroVigente = async uid => { const m = await miembroDe(uid); return !!(m && (deps.tieneMembresia(m) || m.role === 'admin')); };

  async function leerUsuariosAuth(uids) {
    const mapa = new Map();
    for (let i = 0; i < uids.length; i += 100) {
      try {
        const r = await admin.auth().getUsers(uids.slice(i, i + 100).map(uid => ({ uid })));
        for (const u of r.users || []) mapa.set(u.uid, { emailVerified: u.emailVerified === true, creationTime: u.metadata && u.metadata.creationTime });
      } catch (e) { console.error('[referidos] No se pudo consultar Firebase Auth:', e && e.message); }
    }
    return mapa;
  }

  async function buscarAnfitrion(codigo) {
    const r = await db.collection('codigosReferido').doc(codigo).get();
    const uid = r.exists ? r.data().uid : null;
    return typeof uid === 'string' && uid && (await db.collection('members').doc(uid).get()).exists ? uid : null;
  }
  async function asegurarCodigo(uid) {
    const codigo = R.codigoDeUid(uid), ref = db.collection('codigosReferido').doc(codigo);
    if (!(await ref.get()).exists) await ref.set({ uid, codigo, creadoMs: Date.now() });
    return codigo;
  }
  async function dispositivosDeAnfitrion(uid) {
    const [guardado, propio] = await Promise.all([db.collection('dispositivosAnfitrion').doc(uid).get(), db.collection('referidos').doc(uid).get()]);
    let disp = R.normalizarDispositivosAnfitrion(guardado.exists ? guardado.data() : null);
    if (propio.exists) disp = R.agregarDispositivo(disp, propio.data());
    return disp;
  }
  async function guardarDispositivoAnfitrion(uid, dispositivo) {
    const ref = db.collection('dispositivosAnfitrion').doc(uid);
    const snap = await ref.get();
    const actual = snap.exists ? snap.data() : null;
    const nuevo = R.agregarDispositivo(actual, dispositivo);
    if (snap.exists && JSON.stringify(nuevo) === JSON.stringify(R.normalizarDispositivosAnfitrion(actual))) return;
    await ref.set({ uid, ...nuevo, actualizadoMs: Date.now() }, { merge: true });
  }
  const idDe = req => { const v = req.get('x-device-id'); return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v.trim()) ? v.trim() : null; };

  async function retosSuperadosDe(uid) {
    const s = await db.collection('members').doc(uid).collection('progress').doc('retos').get();
    return s.exists ? Object.keys((s.data() || {}).superados || {}).length : 0;
  }

  // Pone al día los invitados de un anfitrión: pendiente -> válido/rechazado cuando Firebase confirma su correo,
  // y los hitos (pagó, 5 retos, 15 retos) de quienes suman XP. Un hito logrado no se pierde.
  async function sincronizarInvitados(hostUid) {
    const snap = await db.collection('referidos').where('anfitrionUid', '==', hostUid).limit(MAX_INVITADOS_LEIDOS).get();
    const invitados = R.ordenarInvitados(snap.docs.map(d => ({ ...d.data(), uid: d.id })));
    if (!invitados.length) return invitados;

    const pendientes = invitados.filter(i => i.estado === ESTADOS.PENDIENTE);
    if (pendientes.length) {
      const dispositivos = await dispositivosDeAnfitrion(hostUid);
      const verificados = await leerUsuariosAuth(pendientes.map(i => i.uid));
      // Si quien invitó ya no tiene membresía, el invitado se queda pendiente (no se rechaza): cuenta cuando renueve.
      let anfitrionEsMiembro = null;
      for (const i of pendientes) {
        const info = verificados.get(i.uid);
        if (!info || !info.emailVerified) continue;
        if (anfitrionEsMiembro === null) anfitrionEsMiembro = await esMiembroVigente(hostUid);
        if (!anfitrionEsMiembro) continue;
        const motivo = R.evaluarDispositivo({ ...i, anfitrionUid: hostUid }, dispositivos, invitados);
        const cambios = motivo ? { estado: ESTADOS.RECHAZADO, motivo: R.MOTIVOS[motivo] } : { estado: ESTADOS.VALIDO, motivo: null };
        await db.collection('referidos').doc(i.uid).set(cambios, { merge: true });
        Object.assign(i, cambios);
      }
    }
    const conXp = invitados.filter(i => i.estado === ESTADOS.VALIDO).slice(0, R.MAX_INVITADOS_CON_XP);
    for (const i of conXp) {
      const m = await miembroDe(i.uid);
      const { hitos, nuevos } = R.actualizarHitos(i.hitos, { pago: R.invitadoPago(m), retosSuperados: await retosSuperadosDe(i.uid) });
      if (nuevos.length) await db.collection('referidos').doc(i.uid).set({ hitos }, { merge: true });
      i.hitos = hitos;
    }
    return invitados;
  }

  // ----- Premios (members/{uid}/progress/premios) -----
  const refPremios = uid => db.collection('members').doc(uid).collection('progress').doc('premios');
  async function leerPremios(uid) { const s = await refPremios(uid).get(); return R.normalizarPremios(s.exists ? s.data() : null); }
  // Un premio ganado no se pierde aunque un invitado cambie después: solo se AGREGAN claves a `ganados`.
  // xpTotal = XP del servidor (logros) + XP de los invitados; con él se ganan los premios de nivel.
  // Invitados que ya confirmaron su correo (para las insignias Embajador y La manada crece). Lectura ligera: no recalcula nada.
  deps.referidosValidosDe = async uid => (await db.collection('referidos').where('anfitrionUid', '==', uid).limit(MAX_INVITADOS_LEIDOS).get()).docs.filter(x => (x.data() || {}).estado === R.ESTADOS.VALIDO).length;
  async function xpTotalDe(uid, d, xpInvitados) {
    if (!deps.estadoLogros) return xpInvitados;
    try { const e = await deps.estadoLogros(uid, d); return (e.xp || 0) + xpInvitados; } catch (_) { return xpInvitados; }
  }
  async function ponerAlDiaPremios(uid, invitadosValidos, xpTotal) {
    const g = await leerPremios(uid);
    const nuevos = [];
    if (R.premioGanado(invitadosValidos)) nuevos.push('referidos-1');
    Object.keys(R.PREMIOS).forEach(c => { const p = R.PREMIOS[c]; if (p.minXp !== undefined && Number.isFinite(xpTotal) && xpTotal >= p.minXp) nuevos.push(c); });
    const faltan = nuevos.filter(c => !g.ganados.includes(c));
    if (faltan.length) {
      g.ganados = [...g.ganados, ...faltan];
      await refPremios(uid).set({ ganados: g.ganados, usados: g.usados, actualizadoMs: Date.now() }, { merge: true });
      // Campana: un aviso por cada premio nuevo (como Zoorigen)
      const { crearAviso } = require('./avisos');
      faltan.forEach(clave => { const p = R.PREMIOS[clave] || {}; crearAviso(db, uid, 'premio_' + clave, { tipo: 'premio', titulo: '¡Ganaste un premio!', texto: (p.titulo || 'Premio') + ': abre un curso antes de su fecha.', pagina: 'achievements' }); });
    }
    return g;
  }
  function listaPremios(g, validos, xpTotal) {
    return Object.keys(R.PREMIOS).map(clave => {
      const p = R.PREMIOS[clave], uso = g.usados.find(u => u.clave === clave);
      return { clave, titulo: p.titulo, requisito: p.requisito || (p.minXp + ' XP'), minXp: p.minXp || null, ganado: g.ganados.includes(clave), usado: uso ? { cursoId: uso.cursoId, fecha: uso.fecha } : null,
        faltan: p.minXp !== undefined ? Math.max(0, p.minXp - xpTotal) : Math.max(0, R.INVITADOS_PARA_PREMIO - validos) };
    });
  }

  // ----- Invitado -----
  app.post('/api/referidos/registrar', envolver('registrar', false, async (req, res, d) => {
    const uid = d.uid;
    limitar('reg:' + uid, ESCRITURAS_POR_MINUTO);
    const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
    const codigo = R.normalizarCodigo(cuerpo.codigo);
    if (!codigo) throw errorHttp(400, 'El código de invitación no es válido.');
    const dispositivo = R.validarDispositivo(cuerpo);
    if (!dispositivo) throw errorHttp(400, 'No pudimos identificar tu dispositivo.');
    const responder = (estado, motivo) => res.json({ ok: true, estado, ...(motivo ? { motivo } : {}) });

    const previo = await db.collection('referidos').doc(uid).get();
    if (previo.exists) {
      const lista = await sincronizarInvitados(previo.data().anfitrionUid);
      const mio = lista.find(i => i.uid === uid) || previo.data();
      return responder(mio.estado, mio.motivo);
    }
    const anfitrionUid = await buscarAnfitrion(codigo);
    if (!anfitrionUid) return responder(ESTADOS.RECHAZADO, R.MOTIVOS['codigo-inexistente']);
    if (anfitrionUid === uid) return responder(ESTADOS.RECHAZADO, R.MOTIVOS['mismo-usuario']);
    // Solo invitan los socios: si quien invita no tiene membresía vigente, la invitación no cuenta y NO se guarda nada.
    if (!(await esMiembroVigente(anfitrionUid))) return responder(ESTADOS.RECHAZADO, R.MOTIVOS['anfitrion-sin-membresia']);

    const ip = R.ipDeSolicitud(req.headers, req.ip);
    const ua = String(req.get('user-agent') || '').slice(0, 200);
    const info = (await leerUsuariosAuth([uid])).get(uid);
    const correoConfirmado = info ? info.emailVerified : d.email_verified === true;
    const [dispositivosAnfitrion, snapInv] = await Promise.all([
      dispositivosDeAnfitrion(anfitrionUid),
      db.collection('referidos').where('anfitrionUid', '==', anfitrionUid).limit(MAX_INVITADOS_LEIDOS).get()
    ]);
    const otros = snapInv.docs.map(x => ({ ...x.data(), uid: x.id }));
    const yo = { uid, anfitrionUid, ...dispositivo, ip, creadoMs: Date.now() };

    let motivo = null;
    if (info && !R.cuentaNueva(info.creationTime)) motivo = 'cuenta-antigua';
    else motivo = R.evaluarDispositivo(yo, dispositivosAnfitrion, otros);
    const estado = motivo ? ESTADOS.RECHAZADO : (correoConfirmado ? ESTADOS.VALIDO : ESTADOS.PENDIENTE);

    const ref = db.collection('referidos').doc(uid);
    const r = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) return { existente: snap.data() };
      tx.set(ref, { anfitrionUid, codigo, ...dispositivo, ip, ua, creadoMs: yo.creadoMs, estado, motivo: motivo ? R.MOTIVOS[motivo] : null, hitos: R.normalizarHitos(null) });
      return { nuevo: true };
    });
    if (r.existente) return responder(r.existente.estado, r.existente.motivo);
    await guardarDispositivoAnfitrion(uid, { ...dispositivo, ip });

    // Dos invitados que se registran a la vez desde el mismo dispositivo: se queda el que llegó primero
    if (estado === ESTADOS.VALIDO) {
      const actual = await db.collection('referidos').where('anfitrionUid', '==', anfitrionUid).limit(MAX_INVITADOS_LEIDOS).get();
      const todos = actual.docs.map(x => ({ ...x.data(), uid: x.id }));
      const yoGuardado = todos.find(i => i.uid === uid);
      const choque = yoGuardado && R.evaluarDispositivo({ ...yoGuardado, anfitrionUid }, dispositivosAnfitrion, todos, { soloAnteriores: true });
      if (choque) {
        const cambios = { estado: ESTADOS.RECHAZADO, motivo: R.MOTIVOS[choque] };
        await ref.set(cambios, { merge: true });
        return responder(cambios.estado, cambios.motivo);
      }
    }
    return responder(estado, motivo ? R.MOTIVOS[motivo] : null);
  }));

  // ----- Anfitrión -----
  app.get('/api/referidos/estado', envolver('estado', false, async (req, res, d) => {
    const uid = d.uid;
    limitar('lec:' + uid, LECTURAS_POR_MINUTO);
    if (!(await esMiembroVigente(uid)) && !esAdminPorToken(d)) throw errorHttp(402, 'Invitar amigos es para miembros. Activa tu membresía para obtener tu enlace de invitación.');
    const deviceId = idDe(req);
    if (deviceId) {
      const huella = req.get('x-huella');
      await guardarDispositivoAnfitrion(uid, { deviceId, ip: R.ipDeSolicitud(req.headers, req.ip), huella: typeof huella === 'string' && /^[A-Za-z0-9+/=_-]{6,128}$/.test(huella.trim()) ? huella.trim() : null });
    }
    const codigo = await asegurarCodigo(uid);
    const invitados = await sincronizarInvitados(uid);
    const resumen = R.resumirInvitados(invitados);
    const xpTotal = await xpTotalDe(uid, d, resumen.xp);
    const premios = await ponerAlDiaPremios(uid, resumen.validos, xpTotal);
    const lista = [];
    for (const [n, i] of invitados.entries()) {
      const perfil = (await miembroDe(i.uid)) || {};
      const item = { alias: R.aliasDeNombre(perfil.name), fecha: i.creadoMs ? new Date(i.creadoMs).toISOString() : null, estado: i.estado, hitos: R.listaDeHitos(i.hitos, i.estado === ESTADOS.VALIDO), puntos: resumen.detalle[n].puntos };
      if (i.motivo) item.motivo = i.motivo;
      if (i.estado === ESTADOS.VALIDO && !resumen.detalle[n].conPuntos) item.sinPuntos = true;
      lista.push(item);
    }
    const uso = premios.usados.find(u => u.clave === 'referidos-1');
    res.json({
      ok: true, codigo, enlace: R.enlaceDeCodigo(codigo), validos: resumen.validos, pendientes: resumen.pendientes, rechazados: resumen.rechazados,
      invitados: lista, puntosTotales: resumen.xp, xpTotal, premios: listaPremios(premios, resumen.validos, xpTotal),
      premio: { clave: 'referidos-1', requisito: R.INVITADOS_PARA_PREMIO + ' invitados válidos', faltan: Math.max(0, R.INVITADOS_PARA_PREMIO - resumen.validos), ganado: premios.ganados.includes('referidos-1'), usado: uso ? { cursoId: uso.cursoId, fecha: uso.fecha } : null }
    });
  }));

  app.post('/api/premios/usar', envolver('usar', false, async (req, res, d) => {
    const uid = d.uid;
    limitar('usar:' + uid, ESCRITURAS_POR_MINUTO);
    const cursoId = typeof (req.body || {}).cursoId === 'string' || typeof (req.body || {}).cursoId === 'number' ? String(req.body.cursoId).trim() : '';
    if (!cursoId || cursoId.length > 200) throw errorHttp(400, 'Falta el curso que quieres abrir.');
    if (esAdminPorToken(d)) throw errorHttp(400, 'Las cuentas de administrador ya tienen todos los cursos abiertos.');
    const miembro = await miembroDe(uid);
    if (!miembro || !deps.tieneMembresia(miembro)) throw errorHttp(402, 'Necesitas una membresía activa para usar tu premio.');
    const curso = cursoDeCatalogo(deps.cargarCatalogo(), cursoId);
    if (!curso) throw errorHttp(404, 'Ese curso no existe.');
    if (miembro.trialCourseId !== undefined && miembro.trialCourseId !== null && String(miembro.trialCourseId) === String(curso.courseId)) throw errorHttp(409, 'Ese curso ya es tu curso de prueba.');
    if (deps.evaluarAcceso) {
      const { acceso } = await deps.evaluarAcceso(uid, d);
      const info = acceso.cursos && acceso.cursos[String(curso.courseId)];
      if (!acceso.escalonado || (info && info.abierto)) throw errorHttp(409, 'Ese curso ya está abierto para ti.');
    }
    // Pone al día el premio ganado antes de buscar uno libre
    const resumen = R.resumirInvitados(await sincronizarInvitados(uid));
    await ponerAlDiaPremios(uid, resumen.validos, await xpTotalDe(uid, d, resumen.xp));
    const claveElegida = typeof (req.body || {}).clave === 'string' ? req.body.clave : '';

    const ref = refPremios(uid);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const g = R.normalizarPremios(snap.exists ? snap.data() : null);
      if (g.usados.some(u => u.cursoId === String(curso.courseId))) throw errorHttp(409, 'Ese curso ya fue abierto con un premio.');
      if (claveElegida && !g.ganados.includes(claveElegida)) throw errorHttp(403, 'Ese premio todavía no lo has ganado.');
      if (claveElegida && g.usados.some(u => u.clave === claveElegida)) throw errorHttp(409, 'Ese premio ya lo usaste.');
      const libre = claveElegida || g.ganados.find(c => !g.usados.some(u => u.clave === c));
      if (!libre) throw errorHttp(403, 'Todavía no tienes un premio disponible. Invita a ' + Math.max(0, R.INVITADOS_PARA_PREMIO - resumen.validos) + ' persona(s) más.');
      tx.set(ref, { ganados: g.ganados, usados: [...g.usados, { clave: libre, cursoId: String(curso.courseId), fecha: new Date().toISOString() }], actualizadoMs: Date.now() }, { merge: true });
    });
    res.json({ ok: true, cursoId: String(curso.courseId) });
  }));

  // ----- Administrador -----
  app.get('/api/admin/referidos', envolver('admin', true, async (req, res) => {
    const snap = await db.collection('referidos').limit(1000).get();
    const filas = snap.docs.map(x => ({ ...x.data(), uid: x.id }));
    const nombres = new Map();
    for (const f of filas) for (const u of [f.uid, f.anfitrionUid]) if (!nombres.has(u)) { const m = await miembroDe(u); nombres.set(u, m ? { nombre: m.name || '', email: m.email || '' } : { nombre: '', email: '' }); }
    const porAnfitrion = {};
    filas.forEach(f => { const a = porAnfitrion[f.anfitrionUid] || (porAnfitrion[f.anfitrionUid] = { anfitrionUid: f.anfitrionUid, validos: 0, pendientes: 0, rechazados: 0 }); if (f.estado === ESTADOS.VALIDO) a.validos++; else if (f.estado === ESTADOS.PENDIENTE) a.pendientes++; else a.rechazados++; });
    res.json({
      total: filas.length, validos: filas.filter(f => f.estado === ESTADOS.VALIDO).length, pendientes: filas.filter(f => f.estado === ESTADOS.PENDIENTE).length, rechazados: filas.filter(f => f.estado === ESTADOS.RECHAZADO).length,
      pagaron: filas.filter(f => f.estado === ESTADOS.VALIDO && f.hitos && f.hitos.pago).length,
      anfitriones: Object.values(porAnfitrion).map(a => ({ ...a, ...nombres.get(a.anfitrionUid) })).sort((a, b) => b.validos - a.validos),
      invitaciones: filas.sort((a, b) => (b.creadoMs || 0) - (a.creadoMs || 0)).map(f => ({ invitado: nombres.get(f.uid), anfitrion: nombres.get(f.anfitrionUid), estado: f.estado, motivo: f.motivo || null, pago: !!(f.hitos && f.hitos.pago), fecha: f.creadoMs ? new Date(f.creadoMs).toISOString() : null }))
    });
  }));
}

module.exports = { montarRutasReferidos };
