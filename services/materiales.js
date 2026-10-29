'use strict';
// MATERIALES: los de cada curso y los libres (Material PDF). Sus enlaces NUNCA viajan en content.json: viven en Firestore y
// solo el servidor los entrega a quien corresponde. Son dos cosas independientes:
//
//  · Materiales de CURSO (materialesCurso/{cursoId}): acompañan al curso. Se abren con membresía vigente (y el curso abierto
//    por el escalonado) o con la prueba gratuita de ESE curso, y se van desbloqueando según las clases terminadas:
//    cada material dice "desbloqueaEnClase": 0 = desde el inicio, N = al terminar la clase N.
//  · Materiales LIBRES (materialesLibres/{id}): la biblioteca "Material PDF". Los abren los miembros, o cualquier cuenta que
//    los canje con créditos (ver services/creditos.js). No dependen de ningún curso ni de las clases.
//
//  Socio/cuenta:
//   GET  /api/cursos/:cursoId/materiales                    lista (sin enlaces) con el estado de cada uno
//   POST /api/cursos/:cursoId/materiales/:indice/enlace     entrega el enlace si ya está desbloqueado
//  Administrador (panel):
//   GET  /api/admin/materiales-curso/:cursoId     ·  PUT /api/admin/materiales-curso/:cursoId   { materiales: [...] }
//   GET  /api/admin/materiales-libres  ·  POST /api/admin/materiales-libres  ·  DELETE /api/admin/materiales-libres/:id
const { esAdminPorToken, cursoDeCatalogo } = require('./certificados');
const { setMaterialesLibres } = require('./creditos');

const COL_CURSO = 'materialesCurso';
const COL_LIBRES = 'materialesLibres';
const MAX_MATERIALES = 40;

// Los archivos que viven en el propio Club (assets/...) se guardan con ruta relativa y se completan con CLUB_URL
const urlAbsoluta = u => /^https?:\/\//i.test(String(u || '')) ? u : String(process.env.CLUB_URL || 'https://club.fisioteck.com/').replace(/\/?$/, '/') + String(u || '').replace(/^\//, '');
function errorHttp(status, mensaje) { const e = new Error(mensaje); e.status = status; return e; }
const texto = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function urlValida(u) { try { const x = new URL(String(u).trim()); return x.protocol === 'https:' || x.protocol === 'http:'; } catch (_) { return false; } }

// Lista de materiales de un curso que manda el panel → { ok, materiales } | { ok:false, error }
function validarMaterialesCurso(lista, maxClase) {
  if (!Array.isArray(lista) || lista.length > MAX_MATERIALES) return { ok: false, error: 'La lista de materiales no es válida.' };
  const out = [];
  for (let i = 0; i < lista.length; i++) {
    const m = lista[i] || {};
    const titulo = texto(m.titulo, 120), url = String(m.url || '').trim();
    if (!titulo && !url) continue;
    if (!titulo || !url) return { ok: false, error: 'El material ' + (i + 1) + ' necesita título y enlace.' };
    if (!urlValida(url)) return { ok: false, error: 'El enlace del material ' + (i + 1) + ' no es válido.' };
    const n = Number(m.desbloqueaEnClase == null || m.desbloqueaEnClase === '' ? 0 : m.desbloqueaEnClase);
    if (!Number.isInteger(n) || n < 0 || n > Math.max(0, maxClase)) return { ok: false, error: 'El material ' + (i + 1) + ': la clase que lo desbloquea debe ser de 1 a ' + maxClase + ' (o 0 para tenerlo desde el inicio).' };
    out.push({ titulo, url, desbloqueaEnClase: n });
  }
  return { ok: true, materiales: out };
}

// Material libre que manda el panel
function validarLibre(c) {
  c = c && typeof c === 'object' ? c : {};
  const id = String(c.id == null ? '' : c.id).trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return { ok: false, error: 'Identificador inválido.' };
  const titulo = texto(c.titulo, 160);
  if (!titulo) return { ok: false, error: 'El material necesita título.' };
  if (!urlValida(c.url)) return { ok: false, error: 'El enlace no es válido.' };
  const costo = c.costo === undefined || c.costo === null || c.costo === '' ? null : Number(c.costo);
  if (costo !== null && (!Number.isInteger(costo) || costo < 1 || costo > 10000)) return { ok: false, error: 'El costo en créditos debe ser un entero de 1 a 10000.' };
  const thumb = String(c.thumbnail || '').trim();
  const retos = c.requiereRetos === undefined || c.requiereRetos === null || c.requiereRetos === '' ? null : Number(c.requiereRetos);
  if (retos !== null && (!Number.isInteger(retos) || retos < 1 || retos > 200)) return { ok: false, error: 'Los retos para desbloquear deben ser un entero de 1 a 200.' };
  return { ok: true, material: { id, titulo, desc: texto(c.desc, 400), tipo: texto(c.tipo || 'pdf', 20), url: String(c.url).trim(), thumbnail: urlValida(thumb) ? thumb : '', categoria: texto(c.categoria, 60), size: texto(c.size, 20), ...(costo ? { costo } : {}), ...(retos ? { requiereRetos: retos } : {}) } };
}

// ¿Está desbloqueado este material con las clases terminadas? (completadas = Set de índices base 0)
const desbloqueado = (m, completadas) => !(m.desbloqueaEnClase > 0) || completadas.has(m.desbloqueaEnClase - 1);

// deps: { db, admin, cargarCatalogo(), tieneMembresia(miembro), evaluarAcceso?(uid, decoded) }
function montarRutasMateriales(app, deps) {
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
      console.error('[materiales ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };

  const leerCurso = async id => { const s = await db.collection(COL_CURSO).doc(String(id)).get(); return s.exists ? ((s.data() || {}).materiales || []) : []; };
  async function progreso(uid, cursoId) {
    const s = await db.collection('members').doc(uid).collection('progress').doc('courses').get();
    const reg = s.exists ? (s.data() || {})['c_' + cursoId] : null;
    return new Set((reg && Array.isArray(reg.completed) ? reg.completed : []).filter(Number.isInteger));
  }
  // nivel de acceso de esta persona a ESTE curso: admin | miembro | prueba | cerrado (escalonado) | ninguno
  async function nivelDeAcceso(uid, decoded, cursoId) {
    if (esAdminPorToken(decoded)) return 'admin';
    const mSnap = await db.collection('members').doc(uid).get();
    const miembro = mSnap.exists ? (mSnap.data() || {}) : {};
    if (deps.tieneMembresia(miembro)) {
      if (deps.evaluarAcceso) { const { acceso } = await deps.evaluarAcceso(uid, decoded); const info = acceso.cursos && acceso.cursos[String(cursoId)]; if (info && !info.abierto) return 'cerrado'; }
      return 'miembro';
    }
    return miembro.trialCourseId !== undefined && miembro.trialCourseId !== null && String(miembro.trialCourseId) === String(cursoId) ? 'prueba' : 'ninguno';
  }

  // ----- Materiales de curso: socio -----
  app.get('/api/cursos/:cursoId/materiales', envolver('lista', false, async (req, res, d) => {
    const cursoId = String(req.params.cursoId);
    const [lista, nivel] = await Promise.all([leerCurso(cursoId), nivelDeAcceso(d.uid, d, cursoId)]);
    const hechas = nivel === 'ninguno' || nivel === 'cerrado' ? new Set() : await progreso(d.uid, cursoId);
    res.json({
      nivel,
      materiales: lista.map((m, i) => {
        const abierto = (nivel === 'admin') || (nivel === 'miembro' && desbloqueado(m, hechas)) || (nivel === 'prueba' && i < lista.length - 1);
        return { indice: i, titulo: m.titulo, desbloqueaEnClase: m.desbloqueaEnClase || 0, estado: abierto ? 'abierto' : nivel === 'miembro' ? 'bloqueado-clase' : nivel === 'cerrado' ? 'curso-cerrado' : 'sin-acceso' };
      })
    });
  }));

  app.post('/api/cursos/:cursoId/materiales/:indice/enlace', envolver('enlace', false, async (req, res, d) => {
    const cursoId = String(req.params.cursoId), i = Number(req.params.indice);
    const lista = await leerCurso(cursoId), m = Number.isInteger(i) ? lista[i] : null;
    if (!m) throw errorHttp(404, 'Ese material no existe.');
    const nivel = await nivelDeAcceso(d.uid, d, cursoId);
    if (nivel === 'ninguno') throw errorHttp(402, 'Los materiales del curso son parte de la membresía.');
    if (nivel === 'cerrado') throw errorHttp(403, 'Este curso todavía no se abre para ti.');
    if (nivel === 'prueba') { if (i >= lista.length - 1) throw errorHttp(402, 'El último material del curso se abre con la membresía.'); }
    else if (nivel !== 'admin' && !desbloqueado(m, await progreso(d.uid, cursoId))) throw errorHttp(403, 'Se desbloquea al terminar la clase ' + m.desbloqueaEnClase + '.');
    res.json({ url: urlAbsoluta(m.url), titulo: m.titulo });
  }));

  // ----- Materiales de curso: administrador -----
  app.get('/api/admin/materiales-curso/:cursoId', envolver('admin-curso', true, async (req, res) => { res.json({ materiales: await leerCurso(req.params.cursoId) }); }));
  app.put('/api/admin/materiales-curso/:cursoId', envolver('admin-curso-guardar', true, async (req, res, d) => {
    const cursoId = String(req.params.cursoId);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(cursoId)) throw errorHttp(400, 'Curso inválido.');
    const curso = cursoDeCatalogo(deps.cargarCatalogo(), cursoId);
    const v = validarMaterialesCurso((req.body || {}).materiales, curso ? (curso.lessons || []).length : 200);
    if (!v.ok) throw errorHttp(400, v.error);
    await db.collection(COL_CURSO).doc(cursoId).set({ courseId: cursoId, materiales: v.materiales, actualizadoPor: d.email, actualizadoMs: Date.now() });
    res.json({ ok: true, total: v.materiales.length });
  }));

  // ----- Materiales libres: administrador -----
  async function refrescarLibres() { const sn = await db.collection(COL_LIBRES).get(); setMaterialesLibres(sn.docs.map(x => x.data())); }
  deps.refrescarMaterialesLibres = refrescarLibres;
  app.get('/api/admin/materiales-libres', envolver('admin-libres', true, async (req, res) => {
    const sn = await db.collection(COL_LIBRES).get();
    res.json({ materiales: sn.docs.map(x => x.data()) });
  }));
  app.post('/api/admin/materiales-libres', envolver('admin-libres-guardar', true, async (req, res, d) => {
    const v = validarLibre(req.body);
    if (!v.ok) throw errorHttp(400, v.error);
    await db.collection(COL_LIBRES).doc(v.material.id).set({ ...v.material, actualizadoPor: d.email, actualizadoMs: Date.now() });
    await refrescarLibres();
    res.json({ ok: true, id: v.material.id });
  }));
  app.delete('/api/admin/materiales-libres/:id', envolver('admin-libres-borrar', true, async (req, res) => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw errorHttp(400, 'Identificador inválido.');
    // Firestore: se marca como retirado (no se borra el documento para no perder los canjes ya hechos)
    await db.collection(COL_LIBRES).doc(id).set({ id, retirado: true, titulo: 'Retirado', url: 'https://retirado.invalid/', actualizadoMs: Date.now() });
    await refrescarLibres();
    res.json({ ok: true });
  }));
}

module.exports = { montarRutasMateriales, validarMaterialesCurso, validarLibre, desbloqueado };
