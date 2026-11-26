'use strict';
// RED PROFESIONAL del Directorio (como ICADEM): los miembros se CONECTAN entre sí.
//   - Una relación por pareja en `conexiones/{idPar}` (idPar = huella de los dos uid ordenados):
//     { par: [a, b], de, para, estado: 'pendiente' | 'aceptada', creadoMs, actualizadoMs, gen }
//   - Enviar solicitud exige tener la tarjeta del directorio PUBLICADA (y que la del otro también lo esté).
//   - Protecciones: máximo 30 solicitudes por día, y 24 horas de espera para reintentar con la misma persona.
//   - Avisos en la campana: al recibir una solicitud y al ser aceptado.
//   - El navegador nunca toca Firestore: todo va por estas rutas y el uid sale del token firmado.
// Rutas:
//   GET  /api/red                  → conexiones, solicitudes recibidas y enviadas (con nombre y tarjeta), y estados por uid
//   POST /api/red/solicitar        { uid }  envía una solicitud
//   POST /api/red/:uid/aceptar | rechazar | cancelar | eliminar
const { createHash } = require('crypto');
const { esAdminPorToken } = require('./certificados');
const { crearAviso } = require('./avisos');

const COL = 'conexiones', COL_LIMITES = 'conexionesLimites';
const MAX_POR_DIA = 30, ESPERA_MS = 24 * 3600 * 1000;
const uidValido = u => typeof u === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(u);
const idPar = (a, b) => createHash('sha256').update(JSON.stringify([a, b].sort())).digest('hex').slice(0, 40);
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };

// Estado de una relación VISTO por `uid`: ninguna | enviada | recibida | conectado
function estadoDe(rel, uid) {
  if (!rel) return 'ninguna';
  if (rel.estado === 'aceptada') return 'conectado';
  if (rel.estado === 'pendiente') return rel.de === uid ? 'enviada' : 'recibida';
  return 'ninguna';
}

// deps: { db, admin, tieneMembresia }
function montarRutasRed(app, deps) {
  const { db, admin } = deps;
  const ahora = deps.ahora || (() => Date.now());
  const rel = (a, b) => db.collection(COL).doc(idPar(a, b));
  const tarjeta = async uid => { const s = await db.collection('directorio').doc(uid).get(); return s.exists ? (s.data() || {}) : null; };

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { const d = await sesion(req, res); if (d) await fn(req, res, d); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[red ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };

  // Relaciones donde participa `uid`: dos consultas simples (como remitente y como destinatario)
  async function relacionesDe(uid) {
    const [a, b] = await Promise.all([
      db.collection(COL).where('de', '==', uid).limit(500).get(),
      db.collection(COL).where('para', '==', uid).limit(500).get()
    ]);
    const filas = new Map();
    [...a.docs, ...b.docs].forEach(x => { const v = x.data() || {}; if (v.estado === 'pendiente' || v.estado === 'aceptada') filas.set(x.id, { id: x.id, ...v }); });
    return [...filas.values()];
  }
  async function conectadosDe(uid) {
    return (await relacionesDe(uid)).filter(r => r.estado === 'aceptada').map(r => (r.par || []).find(u => u !== uid)).filter(Boolean);
  }

  app.get('/api/red', envolver('lista', async (req, res, d) => {
    const lista = await relacionesDe(d.uid);
    const estados = {}; lista.forEach(r => { const otro = (r.par || []).find(u => u !== d.uid); if (otro) estados[otro] = estadoDe(r, d.uid); });
    const resumen = async otro => {
      const t = await tarjeta(otro);
      return { uid: otro, nombre: (t && t.nombre) || 'Miembro', puesto: (t && t.puesto) || '', especialidad: (t && t.especialidad) || '', foto: (t && typeof t.foto === 'string' && t.foto.indexOf('data:image/jpeg;base64,') === 0) ? t.foto : '', avatar: (t && t.avatar) || '', publicado: !!(t && t.publicado === true && t.visible !== false) };
    };
    const arma = async filas => Promise.all(filas.map(async r => { const otro = (r.par || []).find(u => u !== d.uid); return { ...(await resumen(otro)), desdeMs: Number(r.actualizadoMs) || 0 }; }));
    const conexiones = await arma(lista.filter(r => r.estado === 'aceptada'));
    const recibidas = await arma(lista.filter(r => r.estado === 'pendiente' && r.para === d.uid));
    const enviadas = await arma(lista.filter(r => r.estado === 'pendiente' && r.de === d.uid));
    res.json({ ok: true, conexiones, recibidas, enviadas, estados, total: conexiones.length });
  }));

  app.post('/api/red/solicitar', envolver('solicitar', async (req, res, d) => {
    const otro = String((req.body || {}).uid || '').trim();
    if (!uidValido(otro) || otro === d.uid) throw errorHttp(400, 'Elige a otra persona del directorio para conectar.');
    const [mia, suya, previo, lim] = await Promise.all([tarjeta(d.uid), tarjeta(otro), rel(d.uid, otro).get(), db.collection(COL_LIMITES).doc(d.uid).get()]);
    if (!mia || mia.publicado !== true) throw errorHttp(409, 'Publica tu tarjeta del directorio antes de conectar.');
    if (!suya || suya.publicado !== true || suya.visible === false) throw errorHttp(404, 'Ese perfil no está disponible.');
    const r = previo.exists ? (previo.data() || {}) : null;
    const estado = estadoDe(r, d.uid);
    if (estado === 'conectado' || estado === 'enviada') return res.json({ ok: true, estado });
    if (estado === 'recibida') throw errorHttp(409, 'Esta persona ya te envió una solicitud: respóndela en la pestaña Solicitudes.');
    if (r && Number(r.actualizadoMs) && ahora() - Number(r.actualizadoMs) < ESPERA_MS) throw errorHttp(429, 'Espera 24 horas antes de enviar otra solicitud a esta persona.');
    const t = ahora(), dia = new Date(t).toISOString().slice(0, 10);
    const cuenta = lim.exists ? (lim.data() || {}) : {};
    const enviadasHoy = cuenta.dia === dia ? Number(cuenta.enviadas) || 0 : 0;
    if (enviadasHoy >= MAX_POR_DIA) throw errorHttp(429, 'Llegaste al límite de solicitudes de hoy. Inténtalo mañana.');
    const gen = (Number(r && r.gen) || 0) + 1;
    await rel(d.uid, otro).set({ par: [d.uid, otro].sort(), de: d.uid, para: otro, estado: 'pendiente', gen, creadoMs: (r && Number(r.creadoMs)) || t, actualizadoMs: t });
    await db.collection(COL_LIMITES).doc(d.uid).set({ dia, enviadas: enviadasHoy + 1, actualizadoMs: t });
    await crearAviso(db, otro, 'red_sol_' + idPar(d.uid, otro) + '_' + gen, { tipo: 'conexion', titulo: 'Nueva solicitud de conexión', texto: ((mia.nombre || 'Un profesional') + ' quiere conectar contigo en el Directorio.').slice(0, 140), pagina: 'directorio' });
    res.json({ ok: true, estado: 'enviada' });
  }));

  app.post('/api/red/:uid/:accion', envolver('responder', async (req, res, d) => {
    const otro = String(req.params.uid || '').trim(), accion = String(req.params.accion || '');
    if (!uidValido(otro) || otro === d.uid || !['aceptar', 'rechazar', 'cancelar', 'eliminar'].includes(accion)) throw errorHttp(400, 'Solicitud inválida.');
    const previo = await rel(d.uid, otro).get();
    const r = previo.exists ? (previo.data() || {}) : null;
    if (!r) throw errorHttp(404, 'Esa solicitud ya no existe.');
    const t = ahora();
    if (accion === 'aceptar') {
      if (r.estado === 'aceptada') return res.json({ ok: true, estado: 'conectado' });
      if (!(r.estado === 'pendiente' && r.para === d.uid)) throw errorHttp(409, 'Solo puedes aceptar solicitudes que te enviaron.');
      const mia = await tarjeta(d.uid);
      if (!mia || mia.publicado !== true) throw errorHttp(409, 'Publica tu tarjeta del directorio antes de aceptar.');
      await rel(d.uid, otro).set({ ...r, estado: 'aceptada', actualizadoMs: t });
      await crearAviso(db, r.de, 'red_ok_' + idPar(d.uid, otro) + '_' + (Number(r.gen) || 1), { tipo: 'conexion', titulo: '¡Nueva conexión!', texto: (((mia && mia.nombre) || 'Un profesional') + ' aceptó tu solicitud: ya están conectados.').slice(0, 140), pagina: 'directorio' });
      return res.json({ ok: true, estado: 'conectado' });
    }
    if (accion === 'rechazar' && !(r.estado === 'pendiente' && r.para === d.uid)) throw errorHttp(409, 'Esa solicitud no es para ti.');
    if (accion === 'cancelar' && !(r.estado === 'pendiente' && r.de === d.uid)) throw errorHttp(409, 'Solo puedes cancelar solicitudes que enviaste.');
    if (accion === 'eliminar' && r.estado !== 'aceptada') throw errorHttp(409, 'Aún no están conectados.');
    // rechazar / cancelar / eliminar: la relación vuelve a cero, con la marca de tiempo para la espera de 24 horas
    await rel(d.uid, otro).set({ par: [d.uid, otro].sort(), de: r.de || d.uid, para: r.para || otro, estado: 'ninguna', gen: Number(r.gen) || 1, creadoMs: Number(r.creadoMs) || t, actualizadoMs: accion === 'eliminar' ? 0 : t });
    res.json({ ok: true, estado: 'ninguna' });
  }));

  return { conectadosDe, relacionesDe };
}

module.exports = { montarRutasRed, estadoDe, idPar, MAX_POR_DIA };
