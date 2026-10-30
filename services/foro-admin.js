'use strict';
// MODERACIÓN DEL FORO POR EL SERVIDOR (como Zoorigen): solo el administrador borra temas y respuestas o publica como «Equipo FisioTeck».
// Los miembros siguen escribiendo y borrando lo suyo en Firestore con las reglas de siempre; esto es solo la parte del equipo.
//   POST   /api/admin/foro/temas                               { titulo, categoria, mensaje }  publica un tema oficial
//   DELETE /api/admin/foro/temas/:id                           borra el tema y todas sus respuestas
//   DELETE /api/admin/foro/temas/:id/respuestas/:rid           borra una respuesta y baja el contador
const { esAdminPorToken } = require('./certificados');

const CATEGORIAS = ['general', 'dudas', 'casos', 'tips', 'recursos'];
const limpiar = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const idValido = v => /^[A-Za-z0-9_-]{1,128}$/.test(String(v));
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };

function montarRutasForoAdmin(app, deps) {
  const { db, admin } = deps;
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
    catch (e) { if (e && e.status) return res.status(e.status).json({ error: e.message }); console.error('[foro-admin ' + etiqueta + ']', e && e.message); res.status(500).json({ error: 'No se pudo completar la operación.' }); }
  };
  const posts = () => db.collection('forum_posts');

  app.post('/api/admin/foro/temas', conAdmin('publicar', async (req, res, d) => {
    const b = req.body || {}, titulo = limpiar(b.titulo, 120), mensaje = limpiar(b.mensaje, 4000);
    if (titulo.length < 4 || mensaje.length < 4) throw errorHttp(400, 'Escribe un título y un mensaje.');
    const ref = await posts().add({ title: titulo, body: mensaje, category: CATEGORIAS.includes(b.categoria) ? b.categoria : 'general', authorId: d.uid, authorName: 'Equipo FisioTeck', replyCount: 0, official: true, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true, id: ref.id });
  }));
  app.delete('/api/admin/foro/temas/:id', conAdmin('borrar-tema', async (req, res) => {
    if (!idValido(req.params.id)) throw errorHttp(400, 'Datos inválidos.');
    const ref = posts().doc(req.params.id);
    if (!(await ref.get()).exists) throw errorHttp(404, 'Ese tema ya no existe.');
    const rs = await ref.collection('replies').get();
    for (const x of rs.docs) await ref.collection('replies').doc(x.id).delete();
    await ref.delete();
    res.json({ ok: true, respuestasBorradas: rs.docs.length });
  }));
  app.delete('/api/admin/foro/temas/:id/respuestas/:rid', conAdmin('borrar-respuesta', async (req, res) => {
    if (!idValido(req.params.id) || !idValido(req.params.rid)) throw errorHttp(400, 'Datos inválidos.');
    const ref = posts().doc(req.params.id), s = await ref.get();
    if (!s.exists) throw errorHttp(404, 'Ese tema ya no existe.');
    const resp = ref.collection('replies').doc(req.params.rid);
    if (!(await resp.get()).exists) throw errorHttp(404, 'Esa respuesta ya no existe.');
    await resp.delete();
    await ref.set({ replyCount: Math.max(0, (Number((s.data() || {}).replyCount) || 1) - 1) }, { merge: true });
    res.json({ ok: true });
  }));
}

module.exports = { montarRutasForoAdmin };
