'use strict';
// JUEGOS DINÁMICOS DE CLASE (como Alintec: sopa de letras, memorama, rompecabezas y ahorcado al terminar la clase).
// El juego de cada clase vive en Firestore (juegosCurso/{cursoId}) y solo se entrega a quien ya tiene acceso al curso
// (membresía, prueba gratuita de ese curso o administrador); el sitio público (content.json) no trae las palabras ni los pares.
// Igual que en Alintec, los juegos no ocultan ninguna respuesta (las palabras se muestran en el propio juego) y el servidor no
// exige resolverlos para guardar el avance: lo exige el visor de clases del Club. Las preguntas sí las califica el servidor (services/quiz.js).
//
//  Socio/cuenta:  GET /api/cursos/:cursoId/clases/:indice/juego   →  { juego: { tipo, datos } | null }
//  Administrador: GET/PUT /api/admin/juegos-curso/:cursoId        { clases: { "<indice de clase>": { tipo, datos } } }
//
// Esquema de datos por tipo (el mismo de Alintec):
//   sopa_letras   { palabras: ['TEXTO', ...] }                          3 a 10 palabras de 3 a 12 letras
//   memorama      { pares: [{ termino, definicion }, ...] }             3 a 10 pares
//   rompecabezas  { dificultad: '3'|'4'|'5', imagenUrl: '' }            imagen vacía = portada del curso
//   ahorcado      { palabras: [{ palabra, pista }, ...] }               1 a 10 palabras de 3 a 16 letras
const { esAdminPorToken } = require('./certificados');

const COL = 'juegosCurso';
const TIPOS = ['sopa_letras', 'memorama', 'rompecabezas', 'ahorcado'];
const texto = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function errorHttp(status, mensaje) { const e = new Error(mensaje); e.status = status; return e; }
const soloLetras = p => String(p == null ? '' : p).toUpperCase().replace(/Ñ/g, '\u0001').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\u0001/g, 'Ñ').replace(/[^A-ZÑ]/g, '');
// Solo http(s), assets/ o una imagen incrustada: nunca javascript: ni otros esquemas
const urlSegura = u => {
  const s = String(u == null ? '' : u).trim();
  if (/^(https?:\/\/|assets\/)/i.test(s)) return s.length <= 1000 ? s : '';
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(s) && s.length <= 300000 ? s : '';
};

// Juego de una clase que manda el panel → { ok, juego } | { ok:false, error }. juego null = sin juego.
function validarJuego(j, etiqueta) {
  if (j == null) return { ok: true, juego: null };
  if (typeof j !== 'object' || Array.isArray(j) || !TIPOS.includes(j.tipo)) return { ok: false, error: etiqueta + ': tipo de juego inválido.' };
  const d = j.datos && typeof j.datos === 'object' ? j.datos : {};
  if (j.tipo === 'sopa_letras') {
    const palabras = [...new Set((Array.isArray(d.palabras) ? d.palabras : []).map(soloLetras).filter(p => p.length >= 3 && p.length <= 12))].slice(0, 10);
    if (palabras.length < 3) return { ok: false, error: etiqueta + ': la sopa de letras necesita al menos 3 palabras de 3 a 12 letras.' };
    return { ok: true, juego: { tipo: j.tipo, datos: { palabras } } };
  }
  if (j.tipo === 'memorama') {
    const pares = (Array.isArray(d.pares) ? d.pares : []).map(p => ({ termino: texto(p && p.termino, 80), definicion: texto(p && p.definicion, 160) })).filter(p => p.termino && p.definicion).slice(0, 10);
    if (pares.length < 3) return { ok: false, error: etiqueta + ': el memorama necesita al menos 3 pares completos.' };
    return { ok: true, juego: { tipo: j.tipo, datos: { pares } } };
  }
  if (j.tipo === 'rompecabezas') {
    return { ok: true, juego: { tipo: j.tipo, datos: { dificultad: ['3', '4', '5'].includes(String(d.dificultad)) ? String(d.dificultad) : '3', imagenUrl: urlSegura(d.imagenUrl) } } };
  }
  const palabras = (Array.isArray(d.palabras) ? d.palabras : []).map(p => ({ palabra: soloLetras(p && p.palabra), pista: texto(p && p.pista, 160) })).filter(p => p.palabra.length >= 3 && p.palabra.length <= 16).slice(0, 10);
  if (!palabras.length) return { ok: false, error: etiqueta + ': el ahorcado necesita al menos 1 palabra de 3 letras o más.' };
  return { ok: true, juego: { tipo: j.tipo, datos: { palabras } } };
}

function validarClasesJuego(clases, maxClases) {
  if (!clases || typeof clases !== 'object' || Array.isArray(clases)) return { ok: false, error: 'Formato inválido.' };
  const out = {};
  for (const k of Object.keys(clases)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= maxClases) return { ok: false, error: 'La clase ' + (i + 1) + ' no existe.' };
    const v = validarJuego(clases[k], 'Clase ' + (i + 1));
    if (!v.ok) return v;
    if (v.juego) out[String(i)] = v.juego;
  }
  return { ok: true, clases: out };
}

// Lo que sale hacia el alumno (misma forma que sanitizarJuego de Alintec): nada fuera del esquema
function sanitizarJuego(juego) {
  if (!juego || typeof juego !== 'object') return null;
  const v = validarJuego(juego, 'juego');
  return v.ok ? v.juego : null;
}

function montarRutasJuegos(app, deps) {
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
      console.error('[juegos ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };
  const leer = async id => { const s = await db.collection(COL).doc(String(id)).get(); return s.exists ? ((s.data() || {}).clases || {}) : {}; };

  app.get('/api/cursos/:cursoId/clases/:indice/juego', envolver('entregar', false, async (req, res, d) => {
    const cursoId = String(req.params.cursoId), i = Number(req.params.indice);
    if (!Number.isInteger(i) || i < 0) throw errorHttp(400, 'Datos inválidos.');
    if (!esAdminPorToken(d)) {
      const mSnap = await db.collection('members').doc(d.uid).get();
      const miembro = mSnap.exists ? (mSnap.data() || {}) : {};
      const prueba = miembro.trialCourseId !== undefined && miembro.trialCourseId !== null && String(miembro.trialCourseId) === cursoId;
      if (!deps.tieneMembresia(miembro) && !prueba) throw errorHttp(402, 'Los juegos son parte de la membresía.');
    }
    res.json({ juego: sanitizarJuego((await leer(cursoId))[String(i)]) });
  }));

  app.get('/api/admin/juegos-curso/:cursoId', envolver('admin-leer', true, async (req, res) => { res.json({ clases: await leer(req.params.cursoId) }); }));
  app.put('/api/admin/juegos-curso/:cursoId', envolver('admin-guardar', true, async (req, res, d) => {
    const cursoId = String(req.params.cursoId);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(cursoId)) throw errorHttp(400, 'Curso inválido.');
    const v = validarClasesJuego((req.body || {}).clases, 300);
    if (!v.ok) throw errorHttp(400, v.error);
    await db.collection(COL).doc(cursoId).set({ courseId: cursoId, clases: v.clases, actualizadoPor: d.email, actualizadoMs: Date.now() });
    res.json({ ok: true });
  }));
}

module.exports = { montarRutasJuegos, validarJuego, validarClasesJuego, sanitizarJuego };
