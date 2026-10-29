// Cursos escalonados y retos que adelantan la apertura (como Alintec y Zoorigen).
//
// Con membresía y el escalonado activo (config/club.escalonadoActivo = true, lo enciende el administrador), como en Alintec y Zoorigen:
//   - Los miembros ANTIGUOS (quienes pagaron antes de `escalonadoDesde`, la fecha en que se encendió) conservan tal cual su avance, su historial y todo lo
//     que ya tenían abierto. Solo si el administrador marca "aplicar también a miembros antiguos" (escalonadoParaTodos = true) se les aplica la regla.
//   - El calendario de un miembro empieza cuando PAGA (su primer pago), no cuando creó su cuenta.
//   - El primer curso es el que el socio eligió en su prueba gratuita (o el primero del catálogo) y está abierto desde el inicio.
//   - Cada `escalonadoDias` días (8 por defecto) se abre el siguiente curso, en el orden del catálogo.
//   - ADELANTO POR RETOS (una sola vez): con `retosParaAdelantar` retos superados (12 por defecto, al menos 2 de cada tipo: quiz, ordena,
//     detective e historia) se abre, sin esperar, el curso que se abriría a los 8 días. Se guarda y no se repite para los demás cursos.
//   - Quien pagó antes de `escalonadoDesde` (la fecha en que se encendió) conserva todo abierto.
//   - Los administradores ven todo abierto.
// Los retos se califican AQUÍ con data/retos-claves.json; el navegador solo manda sus respuestas.
const fs = require('fs');
const path = require('path');
const { esAdminPorToken } = require('./certificados');

const DIA = 864e5;
const limitar = (n, min, max) => Math.max(min, Math.min(max, n));

function leerClavesRetos() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'retos-claves.json'), 'utf8')); }
  catch (_) { return { quiz: {}, orden: {} }; }
}

function configEscalonado(cfg) {
  const c = cfg || {};
  return {
    activo: c.escalonadoActivo === true,
    dias: limitar(Math.round(Number(c.escalonadoDias)) || 8, 1, 60),
    desde: typeof c.escalonadoDesde === 'string' ? c.escalonadoDesde : null,
    paraTodos: c.escalonadoParaTodos === true,
    retosParaAdelantar: limitar(Math.round(Number(c.retosParaAdelantar)) || 12, 4, 17)
  };
}

const TIPOS_RETO = { q: 'quiz', o: 'orden', d: 'detective', h: 'historia' };
const MIN_POR_TIPO = 2;
// Avance hacia el adelanto: total de retos superados y cuántos de cada tipo (el tipo sale del inicio del id: q-, o-, d-, h-)
function progresoAdelanto(superados, necesarios) {
  const ids = Object.keys(superados || {});
  const porTipo = { quiz: 0, orden: 0, detective: 0, historia: 0 };
  ids.forEach(id => { const t = TIPOS_RETO[String(id).charAt(0)]; if (t && String(id).charAt(1) === '-') porTipo[t]++; });
  const total = Object.values(porTipo).reduce((a, b) => a + b, 0);
  const variado = Object.values(porTipo).every(n => n >= MIN_POR_TIPO);
  return { total, porTipo, necesarios, minPorTipo: MIN_POR_TIPO, ok: total >= necesarios && variado };
}

function fechaDe(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  const d = new Date(String(v).length === 10 ? v + 'T00:00:00Z' : v);
  return isNaN(d) ? null : d;
}

// Primer día de membresía = fecha de referencia para el calendario Y para saber si el miembro es ANTIGUO (anterior a la fecha en que se encendió el escalonado):
//  1) el primer PAGO registrado (no la creación de la cuenta);
//  2) sin pagos registrados: la activación del administrador, el regalo o el inicio de membresía;
//  3) sin nada de eso (miembros muy antiguos): la fecha más vieja entre su último pago y el alta de la cuenta, para que NUNCA se tome por nuevo a quien ya
//     era miembro y solo tiene un cobro reciente de renovación.
function inicioMembresia(m) {
  const menor = lista => { const f = lista.map(fechaDe).filter(Boolean).sort((x, y) => x - y); return f[0] || null; };
  const pagos = menor((Array.isArray(m.payments) ? m.payments : []).map(p => p && p.date));
  return pagos || menor([m.activadoEn, m.giftedAt, m.membresiaInicio]) || menor([m.lastPaymentDate, m.startDate]);
}

// Calcula qué cursos tiene abiertos un socio con membresía. Función pura (se prueba sin Firebase).
function calcularAcceso({ miembro, catalogo, cfg, retosSuperados, ahora, esAdmin, adelantados, conMembresia = true, retosHechos, adelantoRetos = null, iniciados = [] }) {
  const conf = configEscalonado(cfg);
  const ids = (catalogo.courses || []).map(c => String(c.courseId));
  const abiertoTodo = motivo => ({ escalonado: false, motivo, cursos: Object.fromEntries(ids.map(id => [id, { abierto: true }])) });
  if (esAdmin) return abiertoTodo('admin');
  if (!conMembresia) return abiertoTodo('sin-membresia'); // el escalonado es solo para socios; las cuentas gratuitas se rigen por la prueba y la vista previa
  if (!conf.activo) return abiertoTodo('apagado');

  const inicio = inicioMembresia(miembro);
  const desde = fechaDe(conf.desde);
  if (!inicio || (!conf.paraTodos && desde && inicio < desde)) return abiertoTodo('anterior');

  const trial = miembro.trialCourseId !== undefined && miembro.trialCourseId !== null ? String(miembro.trialCourseId) : null;
  const primero = trial && ids.includes(trial) ? trial : ids[0];
  const orden = [primero, ...ids.filter(id => id !== primero)];

  const dias = Math.max(0, Math.floor(((ahora || new Date()) - inicio) / DIA));
  const nRetos = retosSuperados || 0;
  const abiertos = Math.min(orden.length, 1 + Math.floor(dias / conf.dias));

  const cursos = {};
  orden.forEach((id, k) => {
    if (k < abiertos) { cursos[id] = { abierto: true }; return; }
    const abreEn = new Date(inicio.getTime() + k * conf.dias * DIA);
    cursos[id] = { abierto: false, abreEn: abreEn.toISOString(), dias: Math.max(1, Math.ceil((abreEn - (ahora || new Date())) / DIA)), orden: k };
  });
  // Lo que el miembro ya empezó a ver se le conserva abierto (nadie pierde un curso en marcha)
  (iniciados || []).forEach(id => { const c = cursos[String(id)]; if (c && !c.abierto) cursos[String(id)] = { abierto: true, iniciado: true }; });
  // Cursos abiertos con el "Premio por invitar" (4 invitados válidos): quedan abiertos para siempre
  (adelantados || []).forEach(id => { if (cursos[String(id)]) cursos[String(id)] = { abierto: true, porPremio: true }; });
  // Curso abierto con el adelanto por retos (una sola vez)
  if (adelantoRetos && cursos[String(adelantoRetos)]) cursos[String(adelantoRetos)] = { abierto: true, porRetos: true };
  const prog = progresoAdelanto(retosHechos, conf.retosParaAdelantar);
  const candidato = orden.find(id => cursos[id] && !cursos[id].abierto) || null;
  const adelanto = adelantoRetos ? { estado: 'usado', cursoId: String(adelantoRetos), ...prog } : candidato ? { estado: 'disponible', cursoId: candidato, ...prog } : { estado: 'sin-cursos', cursoId: null, ...prog };
  return {
    escalonado: true, diasEntreCursos: conf.dias, retosParaAdelantar: conf.retosParaAdelantar,
    retosSuperados: nRetos, adelantos: adelantoRetos ? 1 : 0, adelanto,
    retosParaSiguiente: adelanto.estado === 'disponible' ? Math.max(0, conf.retosParaAdelantar - prog.total) : null,
    abiertos, total: orden.length, orden, cursos,
    inicio: inicio.toISOString(), diaMembresia: dias + 1
  };
}

// ----- Calificación de retos -----
function calificarQuiz(claves, respuestas) {
  const total = claves.length;
  let ok = 0;
  claves.forEach((c, i) => { if (respuestas && Number.isInteger(respuestas[i]) && respuestas[i] === c) ok++; });
  return { ok, total, supera: total > 0 && ok / total >= 0.6 };
}

function calificarOrden(totalPasos, orden) {
  return Array.isArray(orden) && orden.length === totalPasos && orden.every((v, i) => v === i);
}

// XP de un reto superado (una sola vez por reto): 6 XP, o 10 si es perfecto (como Alintec y Zoorigen); "ordena" siempre es perfecto al superarse.
const XP_RETO = 6, XP_RETO_PERFECTO = 10;
function xpDeRetoSuperado(tipo, ok, total, det) {
  const perfecto = tipo === 'orden' || (tipo === 'detective' ? !!(det && det.perfecto) : total > 0 && ok === total);
  return perfecto ? XP_RETO_PERFECTO : XP_RETO;
}

// Detective: cada error es un círculo { x, y, r } en % de la imagen. Se supera con al menos el 75 % de errores señalados y máximo 3 marcas de más.
function calificarDetective(errores, marcas) {
  const lista = Array.isArray(marcas) ? marcas.slice(0, 12).filter(m => m && Number.isFinite(Number(m.x)) && Number.isFinite(Number(m.y))).map(m => ({ x: Number(m.x), y: Number(m.y) })) : [];
  const usados = new Set(), aciertos = [];
  lista.forEach((m, i) => {
    const k = errores.findIndex((e, j) => !usados.has(j) && Math.hypot(m.x - e.x, m.y - e.y) <= e.r);
    if (k >= 0) { usados.add(k); aciertos.push(i); }
  });
  const ok = usados.size, total = errores.length, sobran = lista.length - ok;
  return { ok, total, sobran, aciertos, faltan: errores.filter((e, j) => !usados.has(j)), supera: total > 0 && ok / total >= 0.75 && sobran <= 3, perfecto: total > 0 && ok === total && sobran === 0 };
}

// deps: { db, admin, cargarCatalogo(), tieneMembresia(miembro) }
function montarRutasAcceso(app, deps) {
  const { db, admin } = deps;

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const refRetos = uid => db.collection('members').doc(uid).collection('progress').doc('retos');
  // Los retos que la persona ya había superado en el sistema anterior (progress/achievements, que ya no se puede escribir desde el navegador)
  // se pasan una sola vez a progress/retos para que cuenten en los cursos escalonados, los libros y el XP. Su XP ya viene en xpHeredado: aquí valen 0.
  async function migrarRetosHeredados(uid, doc) {
    if (doc && doc.heredado) return doc.superados || {};
    const superados = { ...((doc && doc.superados) || {}) };
    try {
      const claves = leerClavesRetos();
      const viejo = await db.collection('members').doc(uid).collection('progress').doc('achievements').get();
      const hechos = viejo.exists ? (((viejo.data() || {}).retos || {}).hechos || {}) : {};
      Object.keys(hechos).forEach(id => {
        const m = String(id).match(/^(q|o|d|h)-/), h = hechos[id] || {};
        const grupo = m && { q: claves.quiz, o: claves.orden, d: claves.detective, h: claves.historia }[m[1]];
        if (grupo && grupo[id] && !superados[id] && Number(h.mejor) > 0) superados[id] = { fecha: String(h.fecha || '').slice(0, 10), mejor: Number(h.mejor) || 0, total: Number(h.total) || 0, xp: 0, heredado: true };
      });
    } catch (_) { /* sin historial anterior */ }
    await refRetos(uid).set({ superados, heredado: true }, { merge: true });
    return superados;
  }
  async function leerRetos(uid) { const s = await refRetos(uid).get(); return migrarRetosHeredados(uid, s.exists ? (s.data() || {}) : null); }
  deps.leerRetosSuperados = leerRetos;

  // Reutilizable por el resto del servidor (video, progreso)
  async function evaluar(uid, decoded) {
    const [mSnap, cfgSnap] = await Promise.all([db.collection('members').doc(uid).get(), db.collection('config').doc('club').get()]);
    const miembro = mSnap.exists ? (mSnap.data() || {}) : {};
    const retos = await leerRetos(uid);
    const premios = await db.collection('members').doc(uid).collection('progress').doc('premios').get();
    const adelantados = premios.exists ? ((premios.data() || {}).usados || []).map(u => u && u.cursoId).filter(Boolean) : [];
    const datosPremios = premios.exists ? (premios.data() || {}) : {};
    const progCursos = await db.collection('members').doc(uid).collection('progress').doc('courses').get();
    const datosProg = progCursos.exists ? (progCursos.data() || {}) : {};
    const iniciados = Object.keys(datosProg).filter(k => /^c_/.test(k) && datosProg[k] && Array.isArray(datosProg[k].completed) && datosProg[k].completed.length > 0).map(k => k.slice(2));
    const params = {
      iniciados, miembro, catalogo: deps.cargarCatalogo(), cfg: cfgSnap.exists ? cfgSnap.data() : {},
      retosSuperados: Object.keys(retos).length, retosHechos: retos, ahora: new Date(), esAdmin: esAdminPorToken(decoded), adelantados, conMembresia: deps.tieneMembresia(miembro)
    };
    let guardado = datosPremios.adelantoRetos && datosPremios.adelantoRetos.cursoId ? String(datosPremios.adelantoRetos.cursoId) : null;
    let acceso = calcularAcceso({ ...params, adelantoRetos: guardado });
    // Primera vez que se completan los retos pedidos: se abre el curso que seguía y se guarda para que no se repita
    if (acceso.escalonado && !guardado && acceso.adelanto.estado === 'disponible' && acceso.adelanto.ok) {
      guardado = acceso.adelanto.cursoId;
      await db.collection('members').doc(uid).collection('progress').doc('premios').set({ adelantoRetos: { cursoId: guardado, fecha: new Date().toISOString(), retos: acceso.adelanto.total }, actualizadoMs: Date.now() }, { merge: true });
      acceso = calcularAcceso({ ...params, adelantoRetos: guardado });
    }
    return { miembro, acceso, retos };
  }
  deps.evaluarAcceso = evaluar;

  app.get('/api/acceso', async (req, res) => {
    try {
      const d = await sesion(req, res); if (!d) return;
      const { miembro, acceso } = await evaluar(d.uid, d);
      res.set('Cache-Control', 'no-store');
      res.json({ membresia: deps.tieneMembresia(miembro), ...acceso });
    } catch (e) { console.error('[acceso]', e.message); res.status(500).json({ error: 'No se pudo consultar tu acceso.' }); }
  });

  app.get('/api/retos', async (req, res) => {
    try {
      const d = await sesion(req, res); if (!d) return;
      res.set('Cache-Control', 'no-store');
      res.json({ superados: await leerRetos(d.uid) });
    } catch (e) { console.error('[retos]', e.message); res.status(500).json({ error: 'No se pudieron cargar tus retos.' }); }
  });

  // { retoId, tipo: 'quiz', respuestas: { "<indice de pregunta>": <opción elegida> } }  |  { retoId, tipo: 'orden', orden: [0,1,2,...] }
  app.post('/api/retos/completar', async (req, res) => {
    try {
      const d = await sesion(req, res); if (!d) return;
      const { retoId, tipo, respuestas, orden, marcas } = req.body || {};
      const claves = leerClavesRetos();
      const mSnap = await db.collection('members').doc(d.uid).get();
      if (!mSnap.exists) return res.status(403).json({ error: 'Completa tu registro gratuito para continuar.' });
      const miembro = mSnap.data() || {};
      const conTrial = miembro.trialCourseId !== undefined && miembro.trialCourseId !== null;
      if (!deps.tieneMembresia(miembro) && !conTrial && !esAdminPorToken(d)) return res.status(402).json({ error: 'Los retos son para miembros y para quien ya eligió su curso de prueba.' });

      let supera = false, ok = 0, total = 0, det = null;
      if (tipo === 'quiz' && claves.quiz[retoId]) {
        const r = calificarQuiz(claves.quiz[retoId], respuestas); supera = r.supera; ok = r.ok; total = r.total;
      } else if (tipo === 'orden' && claves.orden[retoId]) {
        total = claves.orden[retoId]; supera = calificarOrden(total, orden); ok = supera ? total : 0;
      } else if (tipo === 'historia' && claves.historia && claves.historia[retoId]) {
        const r = calificarQuiz(claves.historia[retoId], respuestas); supera = r.supera; ok = r.ok; total = r.total;
      } else if (tipo === 'detective' && claves.detective && claves.detective[retoId]) {
        det = calificarDetective(claves.detective[retoId], marcas); supera = det.supera; ok = det.ok; total = det.total;
      } else return res.status(400).json({ error: 'Ese reto no existe.' });

      const previos = await leerRetos(d.uid);
      // Modo historia: cada mundo se abre al superar el anterior
      const mundo = tipo === 'historia' ? Number(String(retoId).replace('h-', '')) : 0;
      if (mundo > 1 && !previos['h-' + (mundo - 1)]) return res.status(403).json({ error: 'Supera el mundo anterior para abrir este.' });
      let nuevo = false;
      if (supera && !previos[retoId]) {
        nuevo = true;
        previos[retoId] = { fecha: new Date().toISOString().split('T')[0], mejor: ok, total, xp: xpDeRetoSuperado(tipo, ok, total, det) };
        await refRetos(d.uid).set({ superados: previos }, { merge: true });
      } else if (supera && previos[retoId] && ok > previos[retoId].mejor) {
        previos[retoId].mejor = ok;
        await refRetos(d.uid).set({ superados: previos }, { merge: true });
      }
      const { acceso } = await evaluar(d.uid, d);
      res.json({ ...(det ? { aciertos: det.aciertos, sobran: det.sobran, faltan: det.faltan } : {}), supera, nuevo, xp: nuevo ? previos[retoId].xp : 0, ok, total, retosSuperados: Object.keys(previos).length, adelantos: acceso.adelantos || 0, retosParaSiguiente: acceso.retosParaSiguiente || null, adelanto: acceso.adelanto || null, escalonado: !!acceso.escalonado });
    } catch (e) { console.error('[retos] completar', e.message); res.status(500).json({ error: 'No se pudo registrar tu reto.' }); }
  });
}

module.exports = { configEscalonado, inicioMembresia, calcularAcceso, calificarQuiz, calificarOrden, calificarDetective, progresoAdelanto, xpDeRetoSuperado, montarRutasAcceso };
