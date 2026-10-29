'use strict';
// AVISOS PERSONALES (campana): hoy, "alguien respondió tu tema del foro".
// El foro vive en Firestore (lo escribe el navegador), así que el aviso lo crea el SERVIDOR después de comprobar que la respuesta existe
// y es de quien lo pide: nadie puede mandarle avisos falsos a otra persona. Se guardan en members/{uid}/avisos/{replyId} (un aviso por respuesta).
//  POST /api/avisos/foro        { postId, replyId }   avisa al autor del tema (no a ti mismo)
//  GET  /api/avisos                                   avisos de los últimos 30 días (más nuevos primero)
//  POST /api/avisos/:id/leido                         marca uno como leído
//  POST /api/avisos/leidos                            marca todos como leídos
const { limpiarTexto } = require('./texto-seguro');

const DIAS = 30, MAX = 40;
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const idValido = v => /^[A-Za-z0-9_-]{1,128}$/.test(String(v));

function montarRutasAvisos(app, deps) {
  const { db, admin } = deps;
  const ahora = deps.ahora || (() => Date.now());
  const refAvisos = uid => db.collection('members').doc(uid).collection('avisos');

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
      console.error('[avisos ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };

  app.post('/api/avisos/foro', envolver('foro', async (req, res, d) => {
    const { postId, replyId } = req.body || {};
    if (!idValido(postId) || !idValido(replyId)) throw errorHttp(400, 'Datos inválidos.');
    const post = await db.collection('forum_posts').doc(String(postId)).get();
    if (!post.exists) throw errorHttp(404, 'Ese tema no existe.');
    const respuesta = await db.collection('forum_posts').doc(String(postId)).collection('replies').doc(String(replyId)).get();
    if (!respuesta.exists) throw errorHttp(404, 'Esa respuesta no existe.');
    const p = post.data() || {}, r = respuesta.data() || {};
    if (r.authorId !== d.uid) throw errorHttp(403, 'Solo quien responde puede avisar.');
    if (!p.authorId || p.authorId === d.uid) return res.json({ ok: true, avisado: false }); // responder a tu propio tema no avisa a nadie
    const ref = refAvisos(p.authorId).doc(String(replyId));
    if ((await ref.get()).exists) return res.json({ ok: true, avisado: false });
    await ref.set({ tipo: 'foro', postId: String(postId), titulo: limpiarTexto(p.title, 120), quien: limpiarTexto(r.authorName || 'Alguien', 60), fragmento: limpiarTexto(r.body, 140), ms: ahora(), leido: false });
    res.json({ ok: true, avisado: true });
  }));

  app.get('/api/avisos', envolver('lista', async (req, res, d) => {
    const sn = await refAvisos(d.uid).limit(100).get(), corte = ahora() - DIAS * 864e5;
    const avisos = sn.docs.map(x => ({ id: x.id, ...x.data() })).filter(a => (a.ms || 0) >= corte).sort((a, b) => b.ms - a.ms).slice(0, MAX);
    res.json({ ok: true, avisos });
  }));

  app.post('/api/avisos/leidos', envolver('leidos', async (req, res, d) => {
    const sn = await refAvisos(d.uid).limit(100).get();
    await Promise.all(sn.docs.filter(x => (x.data() || {}).leido !== true).map(x => refAvisos(d.uid).doc(x.id).set({ leido: true }, { merge: true })));
    res.json({ ok: true });
  }));
  app.post('/api/avisos/:id/leido', envolver('leido', async (req, res, d) => {
    if (!idValido(req.params.id)) throw errorHttp(400, 'Aviso inválido.');
    const ref = refAvisos(d.uid).doc(String(req.params.id));
    if (!(await ref.get()).exists) throw errorHttp(404, 'Ese aviso no existe.');
    await ref.set({ leido: true }, { merge: true });
    res.json({ ok: true });
  }));
}

module.exports = { montarRutasAvisos };
