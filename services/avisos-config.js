'use strict';
// AVISOS GLOBALES E INTERRUPTORES DEL CLUB (como Zoorigen, pero conectados de punta a punta con el Club)
// Todo lo escribe el SERVIDOR después de comprobar que quien lo pide es administrador y de validar el contenido.
//   GET    /api/config-publica      sin sesión: { avisoGlobal, clasesEnVivoPronto }  (el Club lo lee para el aviso de arriba y «Clases en vivo pronto»)
//   GET    /api/admin/config        valores guardados
//   POST   /api/admin/config        { avisoGlobal: { activo, texto, tono }, clasesEnVivoPronto: true|false|null }  (solo las claves enviadas)
//   GET    /api/admin/avisos        últimos avisos de la campana enviados a todos
//   POST   /api/admin/avisos        { categoria, titulo, mensaje, enlace }  envía un aviso a la campana de todos los miembros
//   DELETE /api/admin/avisos/:id    quita un aviso de la campana
const { esAdminPorToken } = require('./certificados');

const TONOS = ['info', 'aviso'];
const CATEGORIAS = ['course', 'live', 'pdf', 'promo', 'general'];
const MAX_AVISO = 240, MAX_TITULO = 80, MAX_MENSAJE = 180, POR_HORA = 20;
const limpiar = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const esObjeto = v => !!v && typeof v === 'object' && !Array.isArray(v);
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };

function normalizarConfig(d) {
  d = esObjeto(d) ? d : {};
  const a = esObjeto(d.avisoGlobal) ? d.avisoGlobal : {};
  return {
    avisoGlobal: { activo: a.activo === true, texto: typeof a.texto === 'string' ? limpiar(a.texto, MAX_AVISO) : '', tono: TONOS.includes(a.tono) ? a.tono : 'info' },
    clasesEnVivoPronto: typeof d.clasesEnVivoPronto === 'boolean' ? d.clasesEnVivoPronto : null
  };
}
// Cuerpo de POST /api/admin/config -> { error } | { cambios }
function validarCambios(cuerpo) {
  if (!esObjeto(cuerpo) || !Object.keys(cuerpo).length) return { error: 'No hay nada que guardar.' };
  const cambios = {};
  for (const k of Object.keys(cuerpo)) {
    const v = cuerpo[k];
    if (k === 'clasesEnVivoPronto') {
      if (v !== null && typeof v !== 'boolean') return { error: '«Clases en vivo pronto» debe ser sí, no o automático.' };
      cambios.clasesEnVivoPronto = v;
    } else if (k === 'avisoGlobal') {
      if (!esObjeto(v) || typeof v.activo !== 'boolean') return { error: 'El aviso no es válido.' };
      const texto = limpiar(v.texto, MAX_AVISO), tono = v.tono === undefined ? 'info' : v.tono;
      if (v.activo && texto.length < 4) return { error: 'Escribe el texto del aviso (mínimo 4 letras) o apágalo.' };
      if (!TONOS.includes(tono)) return { error: 'El tono del aviso no es válido.' };
      cambios.avisoGlobal = { activo: v.activo, texto, tono };
    } else return { error: 'Hay un ajuste que no existe.' };
  }
  return { cambios };
}
function validarAviso(b) {
  b = esObjeto(b) ? b : {};
  const titulo = limpiar(b.titulo, MAX_TITULO), mensaje = limpiar(b.mensaje, MAX_MENSAJE), categoria = CATEGORIAS.includes(b.categoria) ? b.categoria : 'general';
  let enlace = String(b.enlace || '').trim();
  if (!titulo || !mensaje) return { error: 'Completa el título y el mensaje.' };
  if (enlace && !/^https:\/\/[^\s<>"']{3,300}$/i.test(enlace)) return { error: 'El enlace debe empezar con https://' };
  return { aviso: { category: categoria, title: titulo, message: mensaje, link: enlace } };
}

function montarRutasAvisosConfig(app, deps) {
  const { db, admin } = deps;
  const ahora = deps.ahora || (() => Date.now());
  const refConfig = () => db.collection('config').doc('club');
  let cache = null, cacheMs = 0;
  const envios = new Map(); // límite por hora y por administrador

  async function sesionAdmin(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    let d; try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
    if (!esAdminPorToken(d)) { res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' }); return null; }
    return d;
  }
  const conAdmin = (etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { const d = await sesionAdmin(req, res); if (d) await fn(req, res, d); }
    catch (e) { if (e && e.status) return res.status(e.status).json({ error: e.message }); console.error('[avisos-config ' + etiqueta + ']', e && e.message); res.status(500).json({ error: 'No se pudo completar la operación.' }); }
  };

  app.get('/api/config-publica', async (req, res) => {
    try {
      if (!cache || ahora() - cacheMs > 60000) { const s = await refConfig().get(); cache = normalizarConfig(s.exists ? s.data() : {}); cacheMs = ahora(); }
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ ok: true, avisoGlobal: cache.avisoGlobal.activo ? cache.avisoGlobal : { activo: false, texto: '', tono: 'info' }, clasesEnVivoPronto: cache.clasesEnVivoPronto });
    } catch (e) { res.json({ ok: true, avisoGlobal: { activo: false, texto: '', tono: 'info' }, clasesEnVivoPronto: null }); }
  });
  app.get('/api/admin/config', conAdmin('leer', async (req, res) => { const s = await refConfig().get(); res.json({ ok: true, ...normalizarConfig(s.exists ? s.data() : {}) }); }));
  app.post('/api/admin/config', conAdmin('guardar', async (req, res, d) => {
    const r = validarCambios(req.body); if (r.error) throw errorHttp(400, r.error);
    await refConfig().set({ ...r.cambios, actualizadoEn: new Date(ahora()).toISOString(), actualizadoPorCorreo: String(d.email || '') }, { merge: true });
    cache = null;
    const s = await refConfig().get(); res.json({ ok: true, ...normalizarConfig(s.exists ? s.data() : {}) });
  }));

  app.get('/api/admin/avisos', conAdmin('listar', async (req, res) => {
    const sn = await db.collection('member_notifications').orderBy('createdAt', 'desc').limit(50).get();
    res.json({ ok: true, avisos: sn.docs.map(x => { const v = x.data() || {}; return { id: x.id, categoria: v.category || 'general', titulo: v.title || '', mensaje: v.message || '', enlace: v.link || '', creadoPor: v.createdBy || '' }; }) });
  }));
  app.post('/api/admin/avisos', conAdmin('crear', async (req, res, d) => {
    const clave = String(d.email || d.uid), t = ahora(), usados = (envios.get(clave) || []).filter(x => t - x < 3600000);
    if (usados.length >= POR_HORA) throw errorHttp(429, 'Enviaste muchos avisos en poco tiempo. Espera un rato.');
    const r = validarAviso(req.body); if (r.error) throw errorHttp(400, r.error);
    const ref = await db.collection('member_notifications').add({ ...r.aviso, createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: String(d.email || '') });
    envios.set(clave, [...usados, t]);
    res.json({ ok: true, id: ref.id });
  }));
  app.delete('/api/admin/avisos/:id', conAdmin('borrar', async (req, res) => {
    const id = String(req.params.id || ''); if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw errorHttp(400, 'Datos inválidos.');
    await db.collection('member_notifications').doc(id).delete();
    res.json({ ok: true });
  }));
}

module.exports = { montarRutasAvisosConfig, normalizarConfig, validarCambios, validarAviso };
