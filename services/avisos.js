'use strict';
// AVISOS PERSONALES (campana): hoy, "alguien respondió tu tema del foro".
// El foro vive en Firestore (lo escribe el navegador), así que el aviso lo crea el SERVIDOR después de comprobar que la respuesta existe
// y es de quien lo pide: nadie puede mandarle avisos falsos a otra persona. Se guardan en members/{uid}/avisos/{replyId} (un aviso por respuesta).
//  POST /api/avisos/foro        { postId, replyId }   avisa al autor del tema («respondió tu tema», no a ti mismo) y a los demás miembros con plan («hay nuevas respuestas»), una vez por respuesta
//  GET  /api/avisos                                   avisos de los últimos 30 días (más nuevos primero)
//  POST /api/avisos/:id/leido                         marca uno como leído
//  POST /api/avisos/leidos                            marca todos como leídos
const { limpiarTexto } = require('./texto-seguro');

const DIAS = 30, MAX = 40, MAX_MIEMBROS = 500;
const ESTADOS = ['active', 'paid', 'cancelled'];
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const idValido = v => /^[A-Za-z0-9_-]{1,128}$/.test(String(v));

function montarRutasAvisos(app, deps) {
  const { db, admin } = deps;
  // Quién tiene plan vigente: la misma regla del servidor (si no se la pasan, basta el estado)
  const tieneMembresia = deps.tieneMembresia || (m => ESTADOS.includes((m || {}).status));
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
    const titulo = p.sinTitulo ? limpiarTexto(p.body, 90) : limpiarTexto(p.title, 120);
    let avisado = false;
    // 1) Al autor del tema: «X respondió tu tema» (no si responde a su propio tema)
    if (p.authorId && p.authorId !== d.uid) {
      const ref = refAvisos(p.authorId).doc(String(replyId));
      if (!(await ref.get()).exists) {
        await ref.set({ tipo: 'foro', postId: String(postId), titulo, quien: limpiarTexto(r.authorName || 'Alguien', 60), fragmento: limpiarTexto(r.body, 140), ms: ahora(), leido: false });
        avisado = true;
      }
    }
    // 2) A los demás miembros con plan: «hay nuevas respuestas». Un solo aviso por tema y por persona (si ya tenía uno, se renueva), y solo una vez por respuesta
    let actividad = 0;
    if (r.avisadoActividad !== true) try {
      const sn = await db.collection('members').where('status', 'in', ESTADOS).limit(MAX_MIEMBROS).get();
      const destinos = sn.docs.filter(x => x.id !== d.uid && x.id !== p.authorId && tieneMembresia(x.data() || {})).map(x => x.id);
      for (let i = 0; i < destinos.length; i += 25) {
        await Promise.all(destinos.slice(i, i + 25).map(uid => refAvisos(uid).doc('act-' + String(postId)).set({ tipo: 'foro-act', postId: String(postId), titulo, quien: '', fragmento: 'Hay nuevas respuestas en este tema.', ms: ahora(), leido: false })));
      }
      actividad = destinos.length;
      await db.collection('forum_posts').doc(String(postId)).collection('replies').doc(String(replyId)).set({ avisadoActividad: true }, { merge: true });
    } catch (e) { console.warn('[avisos foro actividad]', e && e.message); } // el aviso general es un extra: nunca debe tirar el aviso al autor
    res.json({ ok: true, avisado, actividad });
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

// Aviso personal creado por el PROPIO servidor (certificado emitido, insignia nueva, premio ganado...), como Zoorigen.
// Un aviso por id: si ya existe no se repite. Nunca lanza (un aviso jamas debe tirar la operacion que lo origina).
async function crearAviso(db, uid, id, datos) {
  try {
    if (!db || !uid || !/^[A-Za-z0-9_.:-]{1,128}$/.test(String(id))) return false;
    const ref = db.collection('members').doc(String(uid)).collection('avisos').doc(String(id));
    if ((await ref.get()).exists) return false;
    await ref.set({ tipo: limpiarTexto(datos.tipo, 20) || 'sistema', titulo: limpiarTexto(datos.titulo, 120), fragmento: limpiarTexto(datos.texto, 140), pagina: limpiarTexto(datos.pagina, 30), ms: Date.now(), leido: false });
    return true;
  } catch (e) { console.warn('[avisos crear]', e && e.message); return false; }
}

module.exports = { montarRutasAvisos, crearAviso };
