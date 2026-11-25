'use strict';
// BUZÓN PRIVADO: chat privado miembro ↔ administración (como ICADEM). Cada miembro tiene UNA conversación
// permanente con el equipo; todo el historial vive en el mismo hilo y nadie más puede leerlo.
//   Miembro:
//     GET  /api/soporte-chat                 su conversación y mensajes (?vistazo=1 no marca leído: solo para el punto rojo)
//     POST /api/soporte-chat/tema            { tema }  guarda el tema de la consulta (membresia|cobros|cuenta|cursos|otro)
//     POST /api/soporte-chat/mensajes        { mensaje, tema, clientRequestId }  envía (idempotente: reintentar no duplica)
//   Administrador:
//     GET  /api/admin/soporte-chat           todas las conversaciones (más recientes primero) + total sin leer
//     GET  /api/admin/soporte-chat/:uid      una conversación con sus mensajes (marca leído)
//     POST /api/admin/soporte-chat/:uid/mensajes  { mensaje, clientRequestId }  responde (el miembro recibe aviso en la campana)
//     POST /api/admin/soporte-chat/:uid/estado    { estado: 'abierto' | 'resuelto' }
// Datos en `soporte_conversaciones/{uid}` (+ subcolección `mensajes`). El navegador NUNCA toca Firestore directo:
// el UID siempre sale del token firmado, así que una cuenta no puede abrir conversaciones ajenas.
const { esAdminPorToken } = require('./certificados');
const { crearAviso } = require('./avisos');

const COLECCION = 'soporte_conversaciones';
const TEMAS = ['membresia', 'cobros', 'cuenta', 'cursos', 'otro'];
const MAX_TEXTO = 3000;
const MAX_MENSAJES = 200; // los más recientes que se entregan por consulta
const POR_HORA = 30, POR_DIA = 120; // mensajes del miembro (un chat real necesita más margen que los reportes)

function limpiarTexto(v) {
  const t = String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!t) { const e = new Error('Escribe un mensaje antes de enviarlo.'); e.codigo = 400; throw e; }
  if (t.length > MAX_TEXTO) { const e = new Error('El mensaje no puede superar ' + MAX_TEXTO + ' caracteres.'); e.codigo = 400; throw e; }
  return t;
}
const limpiarTema = v => (TEMAS.includes(String(v || '').trim().toLowerCase()) ? String(v).trim().toLowerCase() : null);
const limpiarRequestId = v => {
  if (v == null || v === '') return '';
  const id = String(v);
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(id)) { const e = new Error('Identificador de mensaje inválido.'); e.codigo = 400; throw e; }
  return id;
};

function serializarConversacion(id, d = {}) {
  return {
    uid: d.uid || id,
    nombre: d.nombre || 'Miembro FisioTeck', correo: d.correo || '',
    tema: TEMAS.includes(d.tema) ? d.tema : 'membresia',
    estado: d.estado === 'resuelto' ? 'resuelto' : 'abierto',
    ultimoMensaje: d.ultimoMensaje || '', ultimoDe: d.ultimoDe || null,
    sinLeerAdmin: Number(d.sinLeerAdmin) || 0, sinLeerMiembro: Number(d.sinLeerMiembro) || 0,
    creadoMs: Number(d.creadoMs) || 0, actualizadoMs: Number(d.actualizadoMs) || 0,
    resueltoMs: Number(d.resueltoMs) || 0, resueltoPor: d.resueltoPor || null
  };
}
const serializarMensaje = doc => {
  const d = doc.data() || {};
  return { id: doc.id, de: d.de === 'admin' ? 'admin' : 'miembro', nombre: d.nombre || '', texto: d.texto || '', creadoMs: Number(d.creadoMs) || 0 };
};

// deps: { db, admin, ahora? }
function montarRutasSoporteChat(app, deps) {
  const { db, admin } = deps;
  const ahora = deps.ahora || (() => Date.now());
  const conv = uid => db.collection(COLECCION).doc(String(uid));
  const mensajesDe = uid => conv(uid).collection('mensajes');
  const envios = new Map(); // uid → [ms de envíos] (límite de mensajes por hora y por día)

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  async function miembroDe(uid) {
    const s = await db.collection('members').doc(String(uid)).get();
    return s.exists ? (s.data() || {}) : null;
  }
  function limitar(uid) {
    const t = ahora(), lista = (envios.get(uid) || []).filter(x => t - x < 864e5);
    if (lista.filter(x => t - x < 36e5).length >= POR_HORA || lista.length >= POR_DIA) {
      const e = new Error('Enviaste muchos mensajes en poco tiempo. Espera un momento, el equipo ya puede leer los anteriores.'); e.codigo = 429; throw e;
    }
    lista.push(t); envios.set(uid, lista);
    if (envios.size > 2000) envios.delete(envios.keys().next().value);
  }
  async function leerMensajes(uid) {
    const s = await mensajesDe(uid).orderBy('creadoMs', 'desc').limit(MAX_MENSAJES).get();
    return s.docs.map(serializarMensaje).reverse();
  }
  // Al leer el chat, los avisos de la campana sobre respuestas del equipo ya no están pendientes (nunca lanza)
  async function avisosLeidos(uid) {
    try {
      const sn = await db.collection('members').doc(String(uid)).collection('avisos').limit(100).get();
      await Promise.all(sn.docs.filter(x => { const a = x.data() || {}; return a.tipo === 'soporte' && a.leido !== true; })
        .map(x => db.collection('members').doc(String(uid)).collection('avisos').doc(x.id).set({ leido: true }, { merge: true })));
    } catch (e) { console.warn('[soporte-chat avisos]', e && e.message); }
  }
  // ───────── Reportes del formulario anterior (colección «soporte») ─────────
  // Cada reporte viejo se vuelve un mensaje del miembro (y su respuesta, un mensaje del equipo) dentro de SU conversación, para que todo esté en el
  // mismo lugar. Es idempotente: los mensajes llevan un id fijo (rep_<id>), así que repetirlo no duplica nada.
  //   opciones.avisar: la respuesta es nueva y el miembro debe enterarse (punto rojo); en la migración inicial no.
  async function importarReporte(id, v, opciones = {}) {
    if (!v || !v.uid || !id) return false;
    const uid = String(v.uid), base = Number(v.creadoMs) || ahora();
    const mensaje = String(v.mensaje || '').trim(); if (!mensaje) return false;
    const asunto = String(v.asunto || '').trim(), sinPuntos = asunto.replace(/…$/, '');
    const textoMiembro = ((asunto && !mensaje.startsWith(sinPuntos) ? asunto + '\n\n' : '') + mensaje).slice(0, MAX_TEXTO);
    const respuesta = String(v.respuesta || '').trim().slice(0, MAX_TEXTO), respMs = Number(v.respondidoMs) || (base + 1);
    const nombre = String(v.nombre || v.email || 'Miembro FisioTeck').slice(0, 160);
    const refM = mensajesDe(uid).doc('rep_' + id), refR = mensajesDe(uid).doc('rep_' + id + '_r');
    const [prevM, prevR] = await Promise.all([refM.get(), refR.get()]);
    let nuevoMiembro = false, nuevaRespuesta = false;
    if (!prevM.exists) { await refM.set({ de: 'miembro', uid, nombre, texto: textoMiembro, creadoMs: base, importado: true }); nuevoMiembro = true; }
    if (respuesta && (!prevR.exists || (prevR.data() || {}).texto !== respuesta)) {
      await refR.set({ de: 'admin', uid: '', nombre: 'Equipo FisioTeck', texto: respuesta, creadoMs: respMs, importado: true });
      nuevaRespuesta = !prevR.exists;
    }
    if (!nuevoMiembro && !nuevaRespuesta) return false;
    const s = await conv(uid).get(), previa = s.exists ? (s.data() || {}) : null;
    const ultimoMs = respuesta ? respMs : base, ultimoDe = respuesta ? 'admin' : 'miembro', ultimoTexto = (respuesta || textoMiembro).slice(0, 240);
    const esElMasReciente = !previa || ultimoMs >= (Number(previa.actualizadoMs) || 0);
    await conv(uid).set({
      uid, nombre: (previa && previa.nombre) || nombre, correo: (previa && previa.correo) || String(v.email || '').toLowerCase().slice(0, 220),
      tema: (previa && TEMAS.includes(previa.tema)) ? previa.tema : 'otro',
      creadoMs: previa && Number(previa.creadoMs) ? Math.min(Number(previa.creadoMs), base) : base,
      sinLeerAdmin: (previa ? Number(previa.sinLeerAdmin) || 0 : 0) + (nuevoMiembro && !respuesta && v.estado === 'nuevo' ? 1 : 0),
      sinLeerMiembro: (previa ? Number(previa.sinLeerMiembro) || 0 : 0) + (nuevaRespuesta && opciones.avisar ? 1 : 0),
      ...(esElMasReciente ? { ultimoMensaje: ultimoTexto, ultimoDe, actualizadoMs: ultimoMs, estado: v.estado === 'resuelto' && respuesta ? 'resuelto' : 'abierto', resueltoMs: 0, resueltoPor: null } : {})
    }, { merge: true });
    return true;
  }

  // Una sola vez: pasa al Buzón los reportes que ya existían (marca en config/soporte_chat_migrado)
  let migracion = null;
  async function migrarSiHaceFalta() {
    if (migracion) return migracion;
    migracion = (async () => {
      try {
        const marca = db.collection('config').doc('soporte_chat_migrado');
        if ((await marca.get()).exists) return 0;
        const sn = await db.collection('soporte').orderBy('creadoMs', 'desc').limit(300).get();
        let n = 0;
        for (const x of sn.docs.slice().reverse()) { if (await importarReporte(x.id, x.data() || {}, { avisar: false })) n++; }
        await marca.set({ ms: ahora(), reportes: n });
        return n;
      } catch (e) { console.warn('[soporte-chat migrar]', e && e.message); migracion = null; return 0; }
    })();
    return migracion;
  }

  const responder = (res, err, donde) => {
    const codigo = Number(err && err.codigo) || 500;
    if (codigo === 500) console.error('[soporte-chat ' + donde + ']', err && err.message);
    res.status(codigo).json({ error: codigo === 500 ? 'No se pudo consultar el buzón. Intenta de nuevo.' : err.message });
  };

  // ───────── Miembro ─────────
  app.get('/api/soporte-chat', async (req, res) => {
    try {
      const d = await sesion(req, res); if (!d) return;
      res.set('Cache-Control', 'private, no-store');
      const s = await conv(d.uid).get();
      if (!s.exists) return res.json({ ok: true, conversacion: null, mensajes: [] });
      const datos = s.data() || {};
      if (req.query.vistazo !== '1' && Number(datos.sinLeerMiembro) > 0) { await conv(d.uid).set({ sinLeerMiembro: 0 }, { merge: true }); datos.sinLeerMiembro = 0; await avisosLeidos(d.uid); }
      res.json({ ok: true, conversacion: serializarConversacion(s.id, datos), mensajes: req.query.vistazo === '1' ? [] : await leerMensajes(d.uid) });
    } catch (e) { responder(res, e, 'mia'); }
  });

  app.post('/api/soporte-chat/tema', async (req, res) => {
    try {
      const d = await sesion(req, res); if (!d) return;
      const tema = limpiarTema((req.body || {}).tema);
      if (!tema) return res.status(400).json({ error: 'Selecciona un tema válido.' });
      const miembro = await miembroDe(d.uid);
      if (!miembro) return res.status(403).json({ error: 'Completa tu registro gratuito para continuar.' });
      const s = await conv(d.uid).get(), t = ahora();
      await conv(d.uid).set({
        tema,
        ...(s.exists ? {} : {
          uid: d.uid, nombre: String(miembro.name || d.name || d.email || 'Miembro FisioTeck').slice(0, 160),
          correo: String(miembro.email || d.email || '').toLowerCase().slice(0, 220),
          estado: 'abierto', sinLeerAdmin: 0, sinLeerMiembro: 0, creadoMs: t, actualizadoMs: t
        })
      }, { merge: true });
      res.json({ ok: true, tema });
    } catch (e) { responder(res, e, 'tema'); }
  });

  app.post('/api/soporte-chat/mensajes', async (req, res) => {
    try {
      const d = await sesion(req, res); if (!d) return;
      const texto = limpiarTexto((req.body || {}).mensaje);
      const tema = limpiarTema((req.body || {}).tema);
      const requestId = limpiarRequestId((req.body || {}).clientRequestId);
      const miembro = await miembroDe(d.uid);
      if (!miembro) return res.status(403).json({ error: 'Completa tu registro gratuito para continuar.' });
      const refMsg = requestId ? mensajesDe(d.uid).doc('c_' + requestId) : mensajesDe(d.uid).doc();
      const previoMsg = await refMsg.get();
      if (previoMsg.exists) {
        const viejo = previoMsg.data() || {};
        if (viejo.texto !== texto || viejo.uid !== d.uid) return res.status(409).json({ error: 'Este envío ya corresponde a otro mensaje.' });
        return res.status(201).json({ ok: true, id: refMsg.id, repetido: true });
      }
      limitar(d.uid);
      const nombre = String(miembro.name || d.name || d.email || 'Miembro FisioTeck').slice(0, 160);
      const s = await conv(d.uid).get(), previa = s.exists ? (s.data() || {}) : null, t = ahora();
      await refMsg.set({ de: 'miembro', uid: d.uid, nombre, texto, creadoMs: t });
      await conv(d.uid).set({
        uid: d.uid, nombre, correo: String(miembro.email || d.email || '').toLowerCase().slice(0, 220),
        tema: (previa && TEMAS.includes(previa.tema)) ? previa.tema : (tema || 'membresia'),
        estado: 'abierto', ultimoMensaje: texto.slice(0, 240), ultimoDe: 'miembro',
        sinLeerAdmin: ((previa && Number(previa.sinLeerAdmin)) || 0) + 1, sinLeerMiembro: 0,
        actualizadoMs: t, resueltoMs: 0, resueltoPor: null, ...(previa ? {} : { creadoMs: t })
      }, { merge: true });
      res.status(201).json({ ok: true, id: refMsg.id, repetido: false });
    } catch (e) { responder(res, e, 'enviar'); }
  });

  // ───────── Administrador ─────────
  async function soloAdmin(req, res) {
    const d = await sesion(req, res); if (!d) return null;
    if (!esAdminPorToken(d)) { res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' }); return null; }
    return d;
  }

  app.get('/api/admin/soporte-chat', async (req, res) => {
    try {
      if (!await soloAdmin(req, res)) return;
      res.set('Cache-Control', 'private, no-store');
      await migrarSiHaceFalta();
      const s = await db.collection(COLECCION).orderBy('actualizadoMs', 'desc').limit(250).get();
      const conversaciones = s.docs.map(x => serializarConversacion(x.id, x.data()));
      res.json({ ok: true, conversaciones, sinLeer: conversaciones.reduce((n, c) => n + c.sinLeerAdmin, 0) });
    } catch (e) { responder(res, e, 'lista'); }
  });

  app.get('/api/admin/soporte-chat/:uid', async (req, res) => {
    try {
      if (!await soloAdmin(req, res)) return;
      res.set('Cache-Control', 'private, no-store');
      const uid = String(req.params.uid || '').trim();
      const s = await conv(uid).get();
      if (!s.exists) return res.status(404).json({ error: 'Esa conversación no existe.' });
      const datos = s.data() || {};
      if (Number(datos.sinLeerAdmin) > 0) { await conv(uid).set({ sinLeerAdmin: 0 }, { merge: true }); datos.sinLeerAdmin = 0; }
      res.json({ ok: true, conversacion: serializarConversacion(s.id, datos), mensajes: await leerMensajes(uid) });
    } catch (e) { responder(res, e, 'abrir'); }
  });

  app.post('/api/admin/soporte-chat/:uid/mensajes', async (req, res) => {
    try {
      const d = await soloAdmin(req, res); if (!d) return;
      const uid = String(req.params.uid || '').trim();
      const texto = limpiarTexto((req.body || {}).mensaje);
      const requestId = limpiarRequestId((req.body || {}).clientRequestId);
      const s = await conv(uid).get();
      if (!s.exists) return res.status(404).json({ error: 'Esa conversación no existe.' });
      const refMsg = requestId ? mensajesDe(uid).doc('a_' + requestId) : mensajesDe(uid).doc();
      const previoMsg = await refMsg.get();
      if (previoMsg.exists) {
        const viejo = previoMsg.data() || {};
        if (viejo.texto !== texto || viejo.uid !== (d.uid || '')) return res.status(409).json({ error: 'Este envío ya corresponde a otro mensaje.' });
        return res.status(201).json({ ok: true, id: refMsg.id, repetido: true });
      }
      const previa = s.data() || {}, t = ahora();
      await refMsg.set({ de: 'admin', uid: d.uid || '', nombre: 'Equipo FisioTeck', texto, creadoMs: t });
      await conv(uid).set({
        estado: 'abierto', ultimoMensaje: texto.slice(0, 240), ultimoDe: 'admin',
        sinLeerMiembro: (Number(previa.sinLeerMiembro) || 0) + 1, sinLeerAdmin: 0,
        actualizadoMs: t, resueltoMs: 0, resueltoPor: null
      }, { merge: true });
      // Campana del miembro: un aviso por respuesta (idempotente por id del mensaje; nunca lanza)
      await crearAviso(db, uid, 'buzon_' + refMsg.id, { tipo: 'soporte', titulo: 'Te respondió el equipo FisioTeck', texto: texto.slice(0, 140), pagina: 'soporte' });
      res.status(201).json({ ok: true, id: refMsg.id, repetido: false });
    } catch (e) { responder(res, e, 'responder'); }
  });

  app.post('/api/admin/soporte-chat/:uid/estado', async (req, res) => {
    try {
      const d = await soloAdmin(req, res); if (!d) return;
      const uid = String(req.params.uid || '').trim();
      const estado = (req.body || {}).estado === 'resuelto' ? 'resuelto' : (req.body || {}).estado === 'abierto' ? 'abierto' : null;
      if (!estado) return res.status(400).json({ error: 'Estado de conversación inválido.' });
      const s = await conv(uid).get();
      if (!s.exists) return res.status(404).json({ error: 'Esa conversación no existe.' });
      const t = ahora();
      await conv(uid).set({
        estado, actualizadoMs: t,
        resueltoMs: estado === 'resuelto' ? t : 0,
        resueltoPor: estado === 'resuelto' ? (d.email || d.uid || null) : null
      }, { merge: true });
      res.json({ ok: true, estado });
    } catch (e) { responder(res, e, 'estado'); }
  });

  return { importarReporte, migrarSiHaceFalta };
}

module.exports = { montarRutasSoporteChat, limpiarTexto, limpiarTema, serializarConversacion, COLECCION, TEMAS, MAX_TEXTO, MAX_MENSAJES };
