// Avance por clase. Lo escribe SOLO el servidor (las reglas de Firestore no dejan al socio escribir
// members/{uid}/progress/courses): así el certificado de un curso no depende de datos que mande el navegador.
//
// POST /api/cursos/:cursoId/progreso { leccion: <índice 0..n-1> }
//   - Con membresía vigente: cualquier clase.
//   - Sin membresía: la clase de vista previa del catálogo, o las clases del curso de prueba gratuita
//     (todas menos la última, como en Zoorigen y Alintec).
//   - Las clases se completan en orden: para marcar la clase N hay que tener completada la N-1.
//     Se desactiva con PROGRESO_EN_ORDEN=false.
//   - Los administradores no tienen restricciones.
// GET /api/cursos/progreso → { cursos: [{ cursoId, titulo, total, hechas, completo, completed: [...] }] }
const { cursoDeCatalogo, clasesCompletadas, esAdminPorToken } = require('./certificados');

function enOrden() { return String(process.env.PROGRESO_EN_ORDEN || 'true').toLowerCase() !== 'false'; }

// ¿Puede este socio marcar la clase `indice` del curso? Devuelve null si sí, o { codigo, error }.
function permisoParaClase({ curso, indice, miembro, tieneMembresia, esAdmin, hechas }) {
  const total = (curso.lessons || []).length;
  if (!esAdmin) {
    const enPrueba = miembro.trialCourseId !== undefined && miembro.trialCourseId !== null
      && String(miembro.trialCourseId) === String(curso.courseId) && indice < total - 1;
    const esVistaPrevia = !!((curso.lessons || [])[indice] && curso.lessons[indice].isPreview === true);
    if (!tieneMembresia && !enPrueba && !esVistaPrevia) {
      return { codigo: 402, error: 'Esta clase se desbloquea con la membresía.' };
    }
  }
  if (enOrden() && !esAdmin && indice > 0 && !hechas.has(indice) && !hechas.has(indice - 1)) {
    return { codigo: 409, error: 'Completa primero la clase ' + indice + '.' };
  }
  return null;
}

// deps: { db, admin, cargarCatalogo(), tieneMembresia(miembro) }
function montarRutasProgreso(app, deps) {
  const { db, admin } = deps;

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const ref = uid => db.collection('members').doc(uid).collection('progress').doc('courses');
  async function leer(uid) { const s = await ref(uid).get(); return s.exists ? (s.data() || {}) : {}; }
  const lista = (progreso, curso) => {
    const total = (curso.lessons || []).length;
    const reg = progreso['c_' + curso.courseId];
    return [...new Set((Array.isArray(reg && reg.completed) ? reg.completed : []).filter(i => Number.isInteger(i) && i >= 0 && i < total))].sort((a, b) => a - b);
  };

  app.get('/api/cursos/progreso', async (req, res) => {
    try {
      const d = await sesion(req, res); if (!d) return;
      const progreso = await leer(d.uid);
      res.set('Cache-Control', 'no-store');
      res.json({ cursos: (deps.cargarCatalogo().courses || []).map(c => {
        const completed = lista(progreso, c), total = (c.lessons || []).length;
        return { cursoId: c.courseId, titulo: c.title, total, hechas: completed.length, completo: total > 0 && completed.length >= total, completed };
      }) });
    } catch (e) { console.error('[progreso] leer', e.message); res.status(500).json({ error: 'No se pudo cargar tu avance.' }); }
  });

  app.post('/api/cursos/:cursoId/progreso', async (req, res) => {
    try {
      const d = await sesion(req, res); if (!d) return;
      const curso = cursoDeCatalogo(deps.cargarCatalogo(), req.params.cursoId);
      if (!curso) return res.status(404).json({ error: 'Ese curso no existe.' });
      const total = (curso.lessons || []).length;
      const indice = req.body && req.body.leccion;
      if (!Number.isInteger(indice) || indice < 0 || indice >= total) return res.status(400).json({ error: 'Esa clase no existe en el curso.' });

      const mSnap = await db.collection('members').doc(d.uid).get();
      if (!mSnap.exists) return res.status(403).json({ error: 'Completa tu registro gratuito para continuar.' });
      const miembro = mSnap.data() || {};
      const progreso = await leer(d.uid);
      const hechas = new Set(lista(progreso, curso));

      // Cursos escalonados: con membresía, el curso debe estar abierto (las clases de vista previa y de la prueba no cuentan).
      const enPrueba = miembro.trialCourseId !== undefined && miembro.trialCourseId !== null && String(miembro.trialCourseId) === String(curso.courseId);
      if (deps.evaluarAcceso && deps.tieneMembresia(miembro) && !enPrueba) {
        const { acceso } = await deps.evaluarAcceso(d.uid, d);
        const info = acceso.cursos && acceso.cursos[String(curso.courseId)];
        if (info && !info.abierto) return res.status(403).json({ error: 'Este curso se abre en ' + info.dias + ' día' + (info.dias === 1 ? '' : 's') + ', o antes si superas retos.', abreEn: info.abreEn });
      }

      const negado = permisoParaClase({ curso, indice, miembro, tieneMembresia: deps.tieneMembresia(miembro), esAdmin: esAdminPorToken(d), hechas });
      if (negado) return res.status(negado.codigo).json({ error: negado.error });

      // Si la clase tiene preguntas hay que haber acertado al menos el 60 % (el quiz lo califica el servidor, services/quiz.js)
      if (!esAdminPorToken(d) && !hechas.has(indice)) {
        const pSnap = await db.collection('preguntasCurso').doc(String(curso.courseId)).get();
        const preguntas = pSnap.exists ? (((pSnap.data() || {}).clases || {})[String(indice)] || []) : [];
        if (preguntas.length) {
          const qSnap = await db.collection('members').doc(d.uid).collection('progress').doc('quiz').get();
          const aciertos = Object.values(((qSnap.data() || {})['c_' + curso.courseId + '_' + indice]) || {}).filter(v => v === true).length;
          if (aciertos < Math.ceil(preguntas.length * 0.6)) return res.status(409).json({ error: 'Contesta las preguntas de la clase (acierta al menos el 60 %) para continuar.' });
        }
      }


      const yaEstabaCompleto = hechas.size >= total;
      hechas.add(indice);
      const completed = [...hechas].sort((a, b) => a - b);
      await ref(d.uid).set({ ['c_' + curso.courseId]: { completed, updatedAt: new Date().toISOString() } }, { merge: true });
      const respuesta = { cursoId: curso.courseId, completed, total, hechas: completed.length, completo: completed.length >= total };
      // Al terminar el curso el certificado se emite solo (como Alintec Food). El Club pregunta el nombre una vez, antes de enseñarlo.
      // XP por curso terminado (como Alintec): el servidor lo suma al total en services/logros.js; aquí solo se avisa del premio
      if (respuesta.completo && !yaEstabaCompleto) {
        try {
          const L = require('./logros'), todos = await ref(d.uid).get(), prog = todos.exists ? (todos.data() || {}) : {};
          const ordinal = (deps.cargarCatalogo().courses || []).filter(c => { const n = (c.lessons || []).length; return n > 0 && lista(prog, c).length >= n; }).length;
          const xpGanado = L.recompensaCurso(ordinal);
          if (xpGanado > 0 && Date.now() >= L.BONOS_DESDE_MS) {
            respuesta.bono = { xp: xpGanado, ordinal };
            require('./avisos').crearAviso(db, d.uid, 'bonoxp_' + curso.courseId, { tipo: 'logro', titulo: '+' + xpGanado + ' XP por tu curso', texto: 'Completaste tu curso número ' + ordinal + ' y ganaste ' + xpGanado + ' XP.', enlace: 'logros' }).catch(() => {});
          }
        } catch (e) { console.warn('[progreso] XP del curso:', e && e.message); }
      }
      if (respuesta.completo && !yaEstabaCompleto && deps.emitirCertificadoAuto) {
        try { Object.assign(respuesta, await deps.emitirCertificadoAuto({ uid: d.uid, email: d.email, curso, nombreCandidato: miembro.name })); }
        catch (e) { console.warn('[progreso] certificado automático:', e && e.message); }
      }
      res.json(respuesta);
    } catch (e) { console.error('[progreso] guardar', e.message); res.status(500).json({ error: 'No se pudo guardar tu avance.' }); }
  });
}

module.exports = { montarRutasProgreso, permisoParaClase, clasesCompletadas };
