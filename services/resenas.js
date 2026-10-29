// Reseñas de cursos (como Zoorigen y Alintec).
//  - Solo califica quien terminó el curso, es decir, quien tiene su certificado vigente (collection certificados).
//  - Una reseña por persona y curso (resenas/{uid}__{cursoId}); si vuelve a calificar, se actualiza la misma.
//  - Solo el servidor escribe y lee: no se publica ningún comentario en el sitio. El administrador las ve en el panel.
//    Sin regla de Firestore: el navegador no las toca.
//  POST /api/resenas        { cursoId, estrellas: 1-5, comentario?: hasta 500 }  (sesión de Firebase)
//  GET  /api/resenas/mias   → { resenas: [...], terminados: [{ cursoId, curso, emitidoEn }] }
//  GET  /api/admin/resenas  → { total, promedio, histograma, porCurso, resenas } (solo administradores)
const { esAdminPorToken, cursoDeCatalogo } = require('./certificados');

const COL = 'resenas';
const MAX_COMENTARIO = 500;
const MAX_POR_HORA = 20;
const TOPE_LECTURA = 2000;

function errorHttp(status, mensaje) { const e = new Error(mensaje); e.status = status; return e; }

function validarResena({ cursoId, estrellas, comentario }) {
  const id = String(cursoId == null ? '' : cursoId).trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw errorHttp(400, 'Curso inválido');
  const n = Number(estrellas);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw errorHttp(400, 'Elige de 1 a 5 estrellas');
  if (comentario != null && typeof comentario !== 'string') throw errorHttp(400, 'El comentario debe ser texto');
  const texto = String(comentario || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_COMENTARIO);
  return { cursoId: id, estrellas: n, comentario: texto };
}

function crearLimitador({ ahora = () => Date.now(), max = MAX_POR_HORA } = {}) {
  const usos = new Map();
  return uid => {
    const t = ahora();
    const recientes = (usos.get(uid) || []).filter(x => t - x < 3600000);
    if (recientes.length >= max) throw errorHttp(429, 'Demasiadas reseñas seguidas. Intenta más tarde.');
    recientes.push(t); usos.set(uid, recientes);
  };
}

// Promedio, histograma y resumen por curso
function resumir(resenas) {
  const histograma = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const porCurso = {};
  resenas.forEach(r => {
    histograma[r.estrellas]++;
    const c = porCurso[r.cursoId] || (porCurso[r.cursoId] = { cursoId: r.cursoId, curso: r.curso, n: 0, suma: 0 });
    c.n++; c.suma += r.estrellas;
  });
  const total = resenas.length;
  return {
    total, promedio: total ? Math.round(resenas.reduce((t, r) => t + r.estrellas, 0) / total * 100) / 100 : 0, histograma,
    porCurso: Object.values(porCurso).map(c => ({ cursoId: c.cursoId, curso: c.curso, n: c.n, promedio: Math.round(c.suma / c.n * 100) / 100 })).sort((a, b) => b.promedio - a.promedio || b.n - a.n)
  };
}

function montarRutasResenas(app, deps) {
  const { db, admin } = deps;
  const limitar = crearLimitador();

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
      console.error('[reseñas ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };

  const certificadosVigentes = async uid => {
    const sn = await db.collection('certificados').where('uid', '==', uid).get();
    return sn.docs.map(x => x.data()).filter(c => !c.revocado);
  };

  app.post('/api/resenas', envolver('guardar', false, async (req, res, d) => {
    limitar(d.uid);
    const r = validarResena(req.body || {});
    // Solo quien terminó el curso (tiene su certificado vigente) puede calificarlo
    const cert = (await certificadosVigentes(d.uid)).find(c => String(c.cursoId) === r.cursoId);
    if (!cert) throw errorHttp(403, 'Solo puedes calificar los cursos que ya terminaste.');
    const ref = db.collection(COL).doc(d.uid + '__' + r.cursoId);
    const previa = await ref.get();
    const m = await db.collection('members').doc(d.uid).get();
    const curso = cursoDeCatalogo(deps.cargarCatalogo(), r.cursoId);
    const ahora = Date.now();
    const doc = {
      uid: d.uid, nombre: String((m.exists && m.data().name) || cert.nombre || '').slice(0, 120), email: d.email || '',
      cursoId: r.cursoId, curso: (curso && curso.title) || cert.cursoTitulo || '', estrellas: r.estrellas, comentario: r.comentario,
      creadaMs: previa.exists ? previa.data().creadaMs : ahora, actualizadaMs: ahora
    };
    await ref.set(doc);
    res.json({ ok: true, actualizada: previa.exists, cursoId: doc.cursoId, estrellas: doc.estrellas, comentario: doc.comentario });
  }));

  app.get('/api/resenas/mias', envolver('mias', false, async (req, res, d) => {
    const [mias, certs] = await Promise.all([db.collection(COL).where('uid', '==', d.uid).get(), certificadosVigentes(d.uid)]);
    res.json({
      resenas: mias.docs.map(x => x.data()).map(r => ({ cursoId: r.cursoId, estrellas: r.estrellas, comentario: r.comentario })),
      terminados: certs.sort((a, b) => String(b.emitidoEn).localeCompare(String(a.emitidoEn))).map(c => ({ cursoId: String(c.cursoId), curso: c.cursoTitulo, emitidoEn: c.emitidoEn }))
    });
  }));

  // Moderación: ocultar o mostrar una reseña (no se borra nada)
  app.post('/api/admin/resenas/:id/ocultar', envolver('ocultar', true, async (req, res, d) => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw errorHttp(400, 'Reseña inválida.');
    const ref = db.collection(COL).doc(id), s = await ref.get();
    if (!s.exists) throw errorHttp(404, 'Esa reseña no existe.');
    const oculta = (req.body || {}).oculta !== false;
    await ref.set({ oculta, ocultaPor: oculta ? String(d.email || '') : '', ocultaMs: oculta ? Date.now() : 0 }, { merge: true });
    res.json({ ok: true, oculta });
  }));

  app.get('/api/admin/resenas', envolver('admin', true, async (req, res) => {
    const tope = Math.min(Math.max(Number(req.query.limite) || 1000, 1), TOPE_LECTURA);
    const sn = await db.collection(COL).orderBy('actualizadaMs', 'desc').limit(tope).get();
    const lista = sn.docs.map(x => ({ id: x.id, ...x.data() }));
    // Las reseñas ocultas por el administrador no cuentan en el promedio ni en las gráficas, pero se siguen viendo para poder mostrarlas otra vez
    res.json({ ...resumir(lista.filter(r => !r.oculta)), ocultas: lista.filter(r => r.oculta).length, resenas: lista.map(r => ({ id: r.id, oculta: !!r.oculta, nombre: r.nombre, email: r.email, cursoId: r.cursoId, curso: r.curso, estrellas: r.estrellas, comentario: r.comentario, actualizadaMs: r.actualizadaMs })) });
  }));
}

module.exports = { montarRutasResenas, validarResena, crearLimitador, resumir, MAX_COMENTARIO };
