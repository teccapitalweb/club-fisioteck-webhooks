'use strict';
// PREGUNTAS DE CLASE (como Alintec: el quiz lo califica el servidor). El sitio público (content.json) trae el texto y las opciones
// de cada pregunta, pero NO cuál es la correcta: esa vive en Firestore (preguntasCurso/{cursoId}) y solo se revela al contestar.
//
//  Socio/cuenta:  POST /api/cursos/:cursoId/quiz   { sessionIndex, pregunta, respuesta }  →  { acertada, correcta }
//  Administrador: GET/PUT /api/admin/preguntas-curso/:cursoId   { clases: { "<indice de clase>": [ {tipo,pregunta,opciones?,correcta} ] } }
//
// Para completar una clase con preguntas hay que acertar al menos el 60 % (lo exige services/progreso.js); equivocarse se puede repetir. Se pide el mismo acceso que para completar la clase
// (membresía, prueba gratuita de ese curso o administrador).
const { esAdminPorToken } = require('./certificados');

const COL = 'preguntasCurso';
const texto = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function errorHttp(status, mensaje) { const e = new Error(mensaje); e.status = status; return e; }

// Preguntas de una clase que manda el panel → { ok, preguntas } | { ok:false, error }
function validarPreguntas(lista, etiqueta) {
  if (!Array.isArray(lista) || lista.length > 30) return { ok: false, error: etiqueta + ': lista de preguntas inválida.' };
  const out = [];
  for (const q of lista) {
    const pregunta = texto(q && q.pregunta, 300);
    if (!pregunta) continue;
    if (q.tipo === 'vof') {
      if (q.correcta !== 0 && q.correcta !== 1) return { ok: false, error: etiqueta + ': marca si es verdadero o falso.' };
      out.push({ tipo: 'vof', pregunta, correcta: q.correcta });
      continue;
    }
    const opciones = (Array.isArray(q.opciones) ? q.opciones : []).map(o => texto(o, 200));
    if (opciones.length < 2 || opciones.length > 6 || opciones.some(o => !o)) return { ok: false, error: etiqueta + ': cada pregunta necesita de 2 a 6 opciones con texto.' };
    if (!Number.isInteger(q.correcta) || q.correcta < 0 || q.correcta >= opciones.length) return { ok: false, error: etiqueta + ': la respuesta correcta no es válida.' };
    out.push({ tipo: 'multiple', pregunta, opciones, correcta: q.correcta });
  }
  return { ok: true, preguntas: out };
}

function validarClases(clases, maxClases) {
  if (!clases || typeof clases !== 'object' || Array.isArray(clases)) return { ok: false, error: 'Formato inválido.' };
  const out = {};
  for (const k of Object.keys(clases)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= maxClases) return { ok: false, error: 'La clase ' + (i + 1) + ' no existe.' };
    const v = validarPreguntas(clases[k], 'Clase ' + (i + 1));
    if (!v.ok) return v;
    if (v.preguntas.length) out[String(i)] = v.preguntas;
  }
  return { ok: true, clases: out };
}

function montarRutasQuiz(app, deps) {
  const { db, admin } = deps;
  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (etiqueta, soloAdmin, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const d = await sesion(req, res); if (!d) return;
      if (soloAdmin && !esAdminPorToken(d)) return res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' });
      await fn(req, res, d);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[quiz ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };
  const leer = async id => { const s = await db.collection(COL).doc(String(id)).get(); return s.exists ? ((s.data() || {}).clases || {}) : {}; };

  app.post('/api/cursos/:cursoId/quiz', envolver('calificar', false, async (req, res, d) => {
    const cursoId = String(req.params.cursoId), b = req.body || {};
    const i = Number(b.sessionIndex), k = Number(b.pregunta), r = Number(b.respuesta);
    if (![i, k, r].every(Number.isInteger) || i < 0 || k < 0 || r < 0) throw errorHttp(400, 'Datos inválidos.');
    if (!esAdminPorToken(d)) {
      const mSnap = await db.collection('members').doc(d.uid).get();
      const miembro = mSnap.exists ? (mSnap.data() || {}) : {};
      const prueba = miembro.trialCourseId !== undefined && miembro.trialCourseId !== null && String(miembro.trialCourseId) === cursoId;
      if (!deps.tieneMembresia(miembro) && !prueba) throw errorHttp(402, 'Las preguntas son parte de la membresía.');
    }
    const q = ((await leer(cursoId))[String(i)] || [])[k];
    if (!q) throw errorHttp(404, 'Esa pregunta no existe.');
    const max = q.tipo === 'vof' ? 1 : q.opciones.length - 1;
    if (r > max) throw errorHttp(400, 'Respuesta inválida.');
    const acertada = r === q.correcta;
    // Se guarda quién acertó qué: sin esto el servidor no podría exigir las preguntas para completar la clase
    if (!esAdminPorToken(d)) {
      const refQ = db.collection('members').doc(d.uid).collection('progress').doc('quiz'), clave = 'c_' + cursoId + '_' + i;
      const previo = ((await refQ.get()).data() || {})[clave] || {};
      await refQ.set({ [clave]: { ...previo, [k]: previo[k] === true || acertada } }, { merge: true });
    }
    res.json({ acertada, correcta: q.correcta });
  }));

  app.get('/api/admin/preguntas-curso/:cursoId', envolver('admin-leer', true, async (req, res) => { res.json({ clases: await leer(req.params.cursoId) }); }));
  app.put('/api/admin/preguntas-curso/:cursoId', envolver('admin-guardar', true, async (req, res, d) => {
    const cursoId = String(req.params.cursoId);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(cursoId)) throw errorHttp(400, 'Curso inválido.');
    const v = validarClases((req.body || {}).clases, 300);
    if (!v.ok) throw errorHttp(400, v.error);
    await db.collection(COL).doc(cursoId).set({ courseId: cursoId, clases: v.clases, actualizadoPor: d.email, actualizadoMs: Date.now() });
    res.json({ ok: true });
  }));
}

module.exports = { montarRutasQuiz, validarPreguntas, validarClases };
