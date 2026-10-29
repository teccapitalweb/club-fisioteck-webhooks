'use strict';

// ══ BITÁCORA PERSISTENTE DEL SERVIDOR ══
// bitacora-memoria.js solo recuerda los últimos errores mientras el servidor sigue encendido. Esta guarda lo importante en
// Firestore (colecciones SOLO del servidor; las reglas las niegan al navegador) para que el panel pueda contar cuántas veces se
// reinició, si fue por una publicación o por una caída, y qué errores se repiten, aunque el servidor se haya reiniciado.
//
//  · servidorInstancias/{instancia}  latido cada 5 min y marca de cierre limpio (el servidor recibe SIGTERM al publicar).
//  · servidorEventos/{id}            un arranque por instancia (normal o inesperado) y, por día, cuántos avisos de Stripe de OTRAS
//                                    marcas se ignoraron ('ignorado-AAAA-MM-DD').
//  · servidorErrores/{clave}         errores AGRUPADOS por texto parecido: cuántas veces y la última vez.
//  · servidorEstado/stripe           último aviso de Stripe recibido y último que era de FisioTeck.
// Los eventos y errores técnicos se conservan 365 días (no son datos de miembros). Nunca guarda correos, claves ni ids completos de Stripe (admin-panel.limpiarTexto).
// Nada aquí puede romper al servidor: todo va en try/catch y con tiempos límite.

const crypto = require('crypto');
const { limpiarTexto, aFecha } = require('./texto-seguro');

const COL_EVENTOS = 'servidorEventos';
const COL_ERRORES = 'servidorErrores';
const COL_INSTANCIAS = 'servidorInstancias';
const DOC_STRIPE = ['servidorEstado', 'stripe'];
const INTERVALO_LATIDO_MS = 5 * 60 * 1000;
const INTERVALO_VACIADO_MS = 15 * 1000;
const UMBRAL_CAIDA_MS = 10 * 60 * 1000;     // más que esto sin servidor = caída; menos = reinicio
const RETENCION_DIAS = 365;
const TIEMPO_ESCRITURA_MS = 3000;
const MAX_CLAVES_POR_VACIADO = 40;
const MAX_ERRORES_GUARDADOS = 300;

const DIA_MS = 86400000;
const diaDe = fecha => new Date(fecha.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);

function conTiempo(promesa, ms) {
  let reloj;
  const limite = new Promise((_, rechazar) => { reloj = setTimeout(() => rechazar(new Error('tiempo agotado')), ms); });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(reloj));
}

// Texto "parecido" de un error: sin ids, números ni correos, para que el mismo problema se cuente junto.
function patronDe(mensaje) {
  return limpiarTexto(mensaje, 240)
    .replace(/\b(sub|cus|in|pi|ch|evt|price|prod|cs|ii|il)_[^\s"'),.:;]+/gi, '$1_…')
    .replace(/\b[0-9a-f]{20,}\b/gi, '…')
    .replace(/\d+/g, '#')
    .toLowerCase();
}
const claveDe = patron => crypto.createHash('sha1').update(patron).digest('hex').slice(0, 16);

function crearBitacoraServidor({
  db, admin, ahora = () => new Date(), proceso = process, consola = console, version = null, commit = null,
  intervaloLatidoMs = INTERVALO_LATIDO_MS, intervaloVaciadoMs = INTERVALO_VACIADO_MS, umbralCaidaMs = UMBRAL_CAIDA_MS
} = {}) {
  const arranque = ahora();
  const instancia = arranque.getTime().toString(36) + '-' + (proceso.pid || 0);
  const FieldValue = admin && admin.firestore && admin.firestore.FieldValue;
  let temporizadorLatido = null;
  let temporizadorVaciado = null;
  let contador = 0;
  let iniciado = false;
  const pendientes = { errores: new Map(), ignorados: new Map(), stripe: null };
  let estadoStripeMemoria = { ultimoEn: null, ultimoTipo: null, ultimoPropioEn: null, ultimoPropioTipo: null };

  const idEvento = (en, tipo) => en.toISOString().replace(/[-:.TZ]/g, '') + '-' + tipo + '-' + (++contador);
  const escribir = (ref, datos, opciones) => conTiempo(ref.set(datos, opciones), TIEMPO_ESCRITURA_MS);

  /* ── Registro en memoria (rápido, sin esperar a Firestore) ── */
  function registrarError(mensaje, { nivel = 'error' } = {}) {
    try {
      const patron = patronDe(mensaje);
      if (!patron) return;
      if (nivel === 'error' && /alta prioridad/i.test(String(mensaje))) nivel = 'alta';
      const clave = claveDe(patron);
      const previo = pendientes.errores.get(clave);
      const en = ahora();
      if (previo) { previo.cuenta += 1; previo.ultima = en; if (nivel === 'alta') previo.nivel = 'alta'; return; }
      if (pendientes.errores.size >= MAX_CLAVES_POR_VACIADO) return; // tope: no inundar la base de datos
      pendientes.errores.set(clave, { clave, patron, ejemplo: limpiarTexto(mensaje, 240), cuenta: 1, ultima: en, nivel });
    } catch (_) { /* nunca rompe */ }
  }

  function registrarIgnorado(tipo) {
    try {
      const en = ahora(); const dia = diaDe(en);
      const previo = pendientes.ignorados.get(dia) || { dia, en, cuenta: 0, tipos: {} };
      previo.cuenta += 1; previo.en = en;
      const t = String(tipo || 'otro').replace(/[^a-z._]/g, '').slice(0, 60) || 'otro';
      previo.tipos[t] = (previo.tipos[t] || 0) + 1;
      pendientes.ignorados.set(dia, previo);
    } catch (_) { /* nunca rompe */ }
  }

  // Último aviso de Stripe recibido (cualquier marca) y último que era de FisioTeck
  function registrarAvisoStripe(tipo, esPropio) {
    try {
      const en = ahora();
      const t = String(tipo || '').replace(/[^a-z._]/g, '').slice(0, 60);
      estadoStripeMemoria = { ...estadoStripeMemoria, ultimoEn: en, ultimoTipo: t };
      if (esPropio) estadoStripeMemoria = { ...estadoStripeMemoria, ultimoPropioEn: en, ultimoPropioTipo: t };
      pendientes.stripe = estadoStripeMemoria;
    } catch (_) { /* nunca rompe */ }
  }

  /* ── Vaciado a Firestore ── */
  async function vaciar() {
    const errores = [...pendientes.errores.values()]; pendientes.errores.clear();
    const ignorados = [...pendientes.ignorados.values()]; pendientes.ignorados.clear();
    const stripe = pendientes.stripe; pendientes.stripe = null;
    for (const e of errores) {
      try {
        const ref = db.collection(COL_ERRORES).doc(e.clave);
        await conTiempo(db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const previo = snap.exists ? (snap.data() || {}) : {};
          tx.set(ref, {
            patron: e.patron, ejemplo: e.ejemplo, nivel: e.nivel === 'alta' || previo.nivel === 'alta' ? 'alta' : (e.nivel === 'revisar' ? 'revisar' : 'error'),
            cuenta: (Number(previo.cuenta) || 0) + e.cuenta, primeraVez: previo.primeraVez || e.ultima, ultimaVez: e.ultima, instancia
          });
        }), TIEMPO_ESCRITURA_MS * 2);
      } catch (error) { consola.warn('Bitácora del servidor: no se pudo guardar un error:', error && error.message); }
    }
    for (const g of ignorados) {
      try {
        const ref = db.collection(COL_EVENTOS).doc('ignorado-' + g.dia);
        await conTiempo(db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const previo = snap.exists ? (snap.data() || {}) : {};
          const tipos = { ...(previo.tipos || {}) };
          for (const [k, n] of Object.entries(g.tipos)) tipos[k] = (Number(tipos[k]) || 0) + n;
          tx.set(ref, { tipo: 'stripe-ignorado', dia: g.dia, en: previo.en || g.en, ultimaVez: g.en, cuenta: (Number(previo.cuenta) || 0) + g.cuenta, tipos, normal: true });
        }), TIEMPO_ESCRITURA_MS * 2);
      } catch (error) { consola.warn('Bitácora del servidor: no se pudo guardar un aviso ignorado:', error && error.message); }
    }
    if (stripe) {
      try { await escribir(db.collection(DOC_STRIPE[0]).doc(DOC_STRIPE[1]), stripe, { merge: true }); }
      catch (error) { consola.warn('Bitácora del servidor: no se pudo guardar el último aviso de Stripe:', error && error.message); }
    }
  }

  async function latido(extra = {}) {
    try { await escribir(db.collection(COL_INSTANCIAS).doc(instancia), { ultimoLatido: ahora(), ...extra }, { merge: true }); }
    catch (error) { consola.warn('Bitácora del servidor: latido no guardado:', error && error.message); }
  }

  /* ── Arranque: ¿cómo terminó la instancia anterior? ── */
  async function evaluarAnteriores() {
    let docs = [];
    try { docs = (await conTiempo(db.collection(COL_INSTANCIAS).limit(200).get(), 6000)).docs; }
    catch (error) { consola.warn('Bitácora del servidor: no se pudo leer el estado anterior:', error && error.message); return { primera: true, inesperado: false, duracionSeg: 0, desde: null }; }
    const previas = docs.filter(d => d.id !== instancia).map(d => ({ id: d.id, ref: d.ref, data: d.data() || {} }));
    if (!previas.length) return { primera: true, inesperado: false, duracionSeg: 0, desde: null };
    const sinEvaluar = previas.filter(p => p.data.evaluada !== true);
    let inesperado = false; let desde = null;
    for (const p of sinEvaluar) {
      if (p.data.cierreLimpio !== true) {
        inesperado = true;
        const l = aFecha(p.data.ultimoLatido);
        if (l && (!desde || l < desde)) desde = l;
      }
      try { await escribir(p.ref, { evaluada: true }, { merge: true }); } catch (_) { /* se reintenta en el próximo arranque */ }
    }
    return { primera: false, inesperado, duracionSeg: desde ? Math.max(0, Math.round((arranque.getTime() - desde.getTime()) / 1000)) : 0, desde };
  }

  async function limpiarViejos() {
    const corte = ahora().getTime() - RETENCION_DIAS * DIA_MS;
    for (const [col, campo] of [[COL_EVENTOS, 'en'], [COL_ERRORES, 'ultimaVez'], [COL_INSTANCIAS, 'ultimoLatido']]) {
      try {
        const snap = await conTiempo(db.collection(col).orderBy(campo, 'asc').limit(150).get(), 6000);
        for (const d of snap.docs) {
          const f = aFecha((d.data() || {})[campo]);
          if (f && f.getTime() < corte) await conTiempo(d.ref.delete(), TIEMPO_ESCRITURA_MS); else break;
        }
      } catch (error) { consola.warn('Bitácora del servidor: limpieza de ' + col + ':', error && error.message); }
    }
  }

  async function iniciar() {
    if (iniciado) return;
    iniciado = true;
    const prev = await evaluarAnteriores();
    const motivo = prev.primera ? 'primer-arranque' : prev.inesperado ? 'inesperado' : 'publicacion';
    const normal = !prev.inesperado;
    const evento = {
      tipo: 'arranque', en: arranque, instancia, version, commit, motivo, normal,
      caida: prev.inesperado && prev.duracionSeg * 1000 > umbralCaidaMs
    };
    if (prev.inesperado) { evento.desde = prev.desde; evento.duracionSeg = prev.duracionSeg; }
    try { await escribir(db.collection(COL_EVENTOS).doc(idEvento(arranque, 'arranque')), evento); }
    catch (error) { consola.warn('Bitácora del servidor: no se pudo guardar el arranque:', error && error.message); }
    await latido({ arranque, version, commit, cierreLimpio: false });
    temporizadorLatido = setInterval(() => { latido(); }, intervaloLatidoMs);
    temporizadorVaciado = setInterval(() => { vaciar().catch(() => {}); }, intervaloVaciadoMs);
    for (const t of [temporizadorLatido, temporizadorVaciado]) if (t && t.unref) t.unref();
    // Apagado normal (publicación o mantenimiento de Railway): se marca como limpio para no contarlo como caída
    for (const senal of ['SIGTERM', 'SIGINT']) {
      if (proceso.on) proceso.on(senal, () => { cerrar().catch(() => {}); });
    }
    limpiarViejos().catch(() => {});
  }

  async function cerrar() {
    clearInterval(temporizadorLatido); clearInterval(temporizadorVaciado);
    try { await vaciar(); } catch (_) { /* nada */ }
    await latido({ cierreLimpio: true, cerradaEn: ahora() });
  }

  /* ── Lectura para el panel ── */
  async function leerHistorial({ dias = 30 } = {}) {
    const ahoraMs = ahora().getTime();
    const desdeMs = ahoraMs - dias * DIA_MS;
    await vaciar().catch(() => {});
    const [ev, er] = await Promise.all([
      db.collection(COL_EVENTOS).orderBy('en', 'desc').limit(400).get().catch(() => ({ docs: [] })),
      db.collection(COL_ERRORES).limit(MAX_ERRORES_GUARDADOS).get().catch(() => ({ docs: [] }))
    ]);
    const eventos = ev.docs.map(d => ({ id: d.id, ...(d.data() || {}) })).map(e => ({ ...e, enMs: (aFecha(e.en) || new Date(0)).getTime() })).filter(e => e.enMs >= desdeMs);
    const arranques = eventos.filter(e => e.tipo === 'arranque');
    const inesperados = arranques.filter(e => e.normal !== true);
    const ignorados = eventos.filter(e => e.tipo === 'stripe-ignorado');
    const errores = er.docs.map(d => ({ clave: d.id, ...(d.data() || {}) }))
      .map(e => ({ clave: e.clave, ejemplo: String(e.ejemplo || ''), patron: String(e.patron || ''), nivel: e.nivel === 'alta' ? 'alta' : (e.nivel === 'revisar' ? 'revisar' : 'error'), cuenta: Number(e.cuenta) || 0,
        primeraVez: (aFecha(e.primeraVez) || null), ultimaVez: (aFecha(e.ultimaVez) || null) }))
      .filter(e => e.ultimaVez && e.ultimaVez.getTime() >= desdeMs)
      .sort((a, b) => b.ultimaVez - a.ultimaVez)
      .map(e => ({ ...e, primeraVez: e.primeraVez && e.primeraVez.toISOString(), ultimaVez: e.ultimaVez.toISOString() }));
    let stripe = estadoStripeMemoria;
    try {
      const s = await conTiempo(db.collection(DOC_STRIPE[0]).doc(DOC_STRIPE[1]).get(), 4000);
      if (s.exists) { const d = s.data() || {}; stripe = { ultimoEn: aFecha(d.ultimoEn), ultimoTipo: d.ultimoTipo || null, ultimoPropioEn: aFecha(d.ultimoPropioEn), ultimoPropioTipo: d.ultimoPropioTipo || null }; }
    } catch (_) { /* se usa la memoria */ }
    const iso = f => { const x = aFecha(f); return x ? x.toISOString() : null; };
    return {
      dias, instancia, arranque: arranque.toISOString(), segundosActivo: Math.round(proceso.uptime ? proceso.uptime() : (ahoraMs - arranque.getTime()) / 1000),
      resumen: {
        reinicios: arranques.length, reiniciosInesperados: inesperados.length, caidas: arranques.filter(e => e.caida === true && e.normal !== true).length,
        erroresInternos: errores.filter(e => e.nivel !== 'revisar').reduce((t, e) => t + e.cuenta, 0), erroresDistintos: errores.filter(e => e.nivel !== 'revisar').length,
        porRevisar: errores.filter(e => e.nivel === 'revisar').reduce((t, e) => t + e.cuenta, 0),
        stripeIgnorados: ignorados.reduce((t, e) => t + (Number(e.cuenta) || 0), 0)
      },
      eventos: arranques.slice(0, 60).map(e => ({
        id: e.id, tipo: 'arranque', en: iso(e.en), normal: e.normal === true, motivo: String(e.motivo || ''), version: e.version || null,
        caida: e.caida === true, duracionSeg: Number.isFinite(e.duracionSeg) ? e.duracionSeg : null
      })),
      errores,
      stripeIgnorados: ignorados.map(e => ({ dia: e.dia, cuenta: Number(e.cuenta) || 0, tipos: e.tipos || {} })).sort((a, b) => (a.dia < b.dia ? 1 : -1)),
      stripe: { ultimoEn: iso(stripe.ultimoEn), ultimoTipo: stripe.ultimoTipo || null, ultimoPropioEn: iso(stripe.ultimoPropioEn), ultimoPropioTipo: stripe.ultimoPropioTipo || null }
    };
  }

  // «Marcarlos como publicaciones normales»: los reinicios inesperados ya revisados dejan de contar como problema
  async function reconocerReinicios() {
    const snap = await db.collection(COL_EVENTOS).orderBy('en', 'desc').limit(400).get();
    let n = 0;
    for (const d of snap.docs) {
      const e = d.data() || {};
      if (e.tipo === 'arranque' && e.normal !== true) { await d.ref.set({ normal: true, motivo: 'publicacion', reconocidoEn: ahora() }, { merge: true }); n += 1; }
    }
    return n;
  }

  return { instancia, iniciar, cerrar, vaciar, latido, registrarError, registrarIgnorado, registrarAvisoStripe, leerHistorial, reconocerReinicios, patronDe, claveDe };
}

module.exports = { crearBitacoraServidor, patronDe, claveDe, RETENCION_DIAS, COL_EVENTOS, COL_ERRORES, COL_INSTANCIAS };
