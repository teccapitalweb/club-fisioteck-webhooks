'use strict';
// CLASES EN VIVO: el enlace de la sesión (Zoom/Meet) y el de la grabación NUNCA viajan en content.json (es público).
// Viven en Firestore (webinarsPrivados/{id}) y el servidor solo los entrega a quien tiene membresía vigente (como Zoorigen).
//  Socio:          GET    /api/webinars/:id/enlace?tipo=vivo|grabacion   → { url }   (402 sin membresía)
//  Administrador:  GET    /api/admin/webinars-enlaces                     → { webinars: [{ id, link, recordingUrl }] }
//                  POST   /api/admin/webinars-enlaces                     { id, titulo?, link?, recordingUrl? }
//                  DELETE /api/admin/webinars-enlaces/:id
const { esAdminPorToken } = require('./certificados');

const COL = 'webinarsPrivados';
function errorHttp(status, mensaje) { const e = new Error(mensaje); e.status = status; return e; }
const idValido = v => { const s = String(v == null ? '' : v).trim(); if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw errorHttp(400, 'Identificador de sesión inválido.'); return s; };
function urlOpcional(v, campo) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  let u; try { u = new URL(s); } catch (_) { throw errorHttp(400, 'El ' + campo + ' no es un enlace válido.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw errorHttp(400, 'El ' + campo + ' debe empezar con https://');
  return s.slice(0, 1000);
}

function montarRutasWebinars(app, deps) {
  const { db, admin } = deps;
  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); } catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (etiqueta, soloAdmin, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const d = await sesion(req, res); if (!d) return;
      if (soloAdmin && !esAdminPorToken(d)) return res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' });
      await fn(req, res, d);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[webinars ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };

  app.get('/api/webinars/:id/enlace', envolver('enlace', false, async (req, res, d) => {
    const id = idValido(req.params.id), tipo = req.query.tipo === 'grabacion' ? 'grabacion' : 'vivo';
    if (!esAdminPorToken(d)) {
      const m = await db.collection('members').doc(d.uid).get();
      if (!deps.tieneMembresia(m.exists ? (m.data() || {}) : {})) throw errorHttp(402, 'Las clases en vivo son parte de la membresía.');
    }
    const s = await db.collection(COL).doc(id).get(), w = s.exists ? (s.data() || {}) : {};
    const url = tipo === 'grabacion' ? w.recordingUrl : w.link;
    if (!url) throw errorHttp(404, tipo === 'grabacion' ? 'Esta sesión todavía no tiene grabación.' : 'El enlace de esta sesión aún no está listo.');
    res.json({ url });
  }));

  app.get('/api/admin/webinars-enlaces', envolver('admin-lista', true, async (req, res) => {
    const sn = await db.collection(COL).limit(500).get();
    res.json({ ok: true, webinars: sn.docs.map(x => { const v = x.data() || {}; return { id: x.id, link: v.link || '', recordingUrl: v.recordingUrl || '' }; }) });
  }));
  app.post('/api/admin/webinars-enlaces', envolver('admin-guardar', true, async (req, res, d) => {
    const b = req.body || {}, id = idValido(b.id);
    const link = urlOpcional(b.link, 'enlace de la sesión'), recordingUrl = urlOpcional(b.recordingUrl, 'enlace de la grabación');
    if (!link && !recordingUrl) { await db.collection(COL).doc(id).delete(); return res.json({ ok: true, borrado: true }); }
    await db.collection(COL).doc(id).set({ link, recordingUrl, titulo: String(b.titulo || '').slice(0, 200), por: String(d.email || ''), en: new Date().toISOString() });
    res.json({ ok: true });
  }));
  app.delete('/api/admin/webinars-enlaces/:id', envolver('admin-borrar', true, async (req, res) => {
    await db.collection(COL).doc(idValido(req.params.id)).delete();
    res.json({ ok: true });
  }));
}

module.exports = { montarRutasWebinars };
