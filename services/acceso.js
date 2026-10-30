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
// El calendario cuenta DÍAS DEL CALENDARIO en hora de México (el día del primer pago es el día 0; el curso 2 se abre 8 días después, a las 00:00).
// Antes se contaban bloques de 24 horas desde la hora exacta del pago, y el contador «Restan N días» bajaba a mitad del día (y a las 6 p. m. con fechas sin hora).
const fmtDiaMx = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
const diaMx = f => fmtDiaMx.format(f);
const diasEntreDias = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DIA);
const sumarDiasDia = (dia, n) => new Date(Date.parse(dia + 'T00:00:00Z') + n * DIA).toISOString().slice(0, 10);
const inicioDeDiaMx = dia => new Date(dia + 'T00:00:00-06:00'); // México no usa horario de verano
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
  const d = new Date(String(v).length === 10 ? v + 'T12:00:00Z' : v); // una fecha sin hora cae a mediodía UTC: en México sigue siendo ese mismo día
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

// Vencimientos con reactivación (como Alintec): si entre un pago y el siguiente pasó más que el periodo pagado (más una gracia de 7 días), la membresía se venció
// y luego se volvió a pagar. Devuelve [{ vencioDia, reanudoDia }] en días de México.
function reanudaciones(m) {
  const pagos = (Array.isArray(m.payments) ? m.payments : []).filter(p => p && p.status !== 'failed' && p.estado !== 'failed' && !(Number(p.amount) <= 0))
    .map(p => ({ f: fechaDe(p.date), anual: /anual/i.test(String(p.concept || p.plan || '')) || (!p.concept && !p.plan && m.plan === 'anual') })).filter(p => p.f).sort((a, b) => a.f - b.f);
  const out = [];
  for (let i = 1; i < pagos.length; i++) {
    const cubre = pagos[i - 1].anual ? 366 : 31, fin = new Date(pagos[i - 1].f.getTime() + cubre * DIA);
    if (pagos[i].f - fin > 7 * DIA) out.push({ vencioDia: diaMx(fin), reanudoDia: diaMx(pagos[i].f) });
  }
  return out;
}

// Último pago válido (no fallido, con monto) de la lista de pagos.
function ultimoPago(m) {
  const f = (Array.isArray(m.payments) ? m.payments : []).filter(p => p && p.status !== 'failed' && p.estado !== 'failed' && !(Number(p.amount) <= 0))
    .map(p => fechaDe(p.date)).filter(Boolean).sort((a, b) => b - a);
  return f[0] || null;
}

// Miembro antiguo: conserva lo que ya vio y el resto sigue el calendario desde el día de su último pago.
const CLASES_PARA_CONSERVAR = 2;
function accesoAntiguoRenovado({ miembro, ids, conf, pivote, ahora, adelantados, iniciados, avances, retosSuperados, retosHechos }) {
  const hoyMx = diaMx(ahora || new Date()), pivoteDia = diaMx(pivote);
  // Un curso cuenta como visto con al menos CLASES_PARA_CONSERVAR clases terminadas; con una sola se vuelve a cerrar y entra al calendario.
  const vistos = new Set(avances ? Object.keys(avances).filter(id => avances[id] >= CLASES_PARA_CONSERVAR) : (iniciados || []).map(String));
  const cursos = {}; let j = 0;
  ids.forEach((id, k) => {
    if (vistos.has(id)) { cursos[id] = { abierto: true, iniciado: true }; return; }
    j++;
    const diaApertura = sumarDiasDia(pivoteDia, j * conf.dias);
    cursos[id] = diaApertura <= hoyMx ? { abierto: true }
      : { abierto: false, abreEn: inicioDeDiaMx(diaApertura).toISOString(), dias: Math.max(1, diasEntreDias(hoyMx, diaApertura)), orden: k };
  });
  (adelantados || []).forEach(id => { if (cursos[String(id)]) cursos[String(id)] = { abierto: true, porPremio: true }; });
  const prog = progresoAdelanto(retosHechos, conf.retosParaAdelantar);
  return {
    escalonado: true, diasEntreCursos: conf.dias, retosParaAdelantar: conf.retosParaAdelantar,
    retosSuperados: retosSuperados || 0, adelantos: 0, adelanto: { estado: 'no-disponible', motivo: 'renovacion', cursoId: null, ...prog }, retosParaSiguiente: null,
    abiertos: Object.values(cursos).filter(c => c.abierto).length, total: ids.length, orden: ids, cursos, reanudada: true,
    inicio: pivote.toISOString(), diaMembresia: Math.max(0, diasEntreDias(pivoteDia, hoyMx)) + 1, antiguoRenovado: true
  };
}

// Calcula qué cursos tiene abiertos un socio con membresía. Función pura (se prueba sin Firebase).
function calcularAcceso({ miembro, catalogo, cfg, retosSuperados, ahora, esAdmin, adelantados, conMembresia = true, retosHechos, adelantoRetos = null, iniciados = [], avances = null }) {
  const conf = configEscalonado(cfg);
  const ids = (catalogo.courses || []).map(c => String(c.courseId));
  const abiertoTodo = motivo => ({ escalonado: false, motivo, cursos: Object.fromEntries(ids.map(id => [id, { abierto: true }])) });
  if (esAdmin) return abiertoTodo('admin');
  if (!conMembresia) return abiertoTodo('sin-membresia'); // el escalonado es solo para socios; las cuentas gratuitas se rigen por la prueba y la vista previa
  if (!conf.activo) return abiertoTodo('apagado');

  const inicio = inicioMembresia(miembro);
  const desde = fechaDe(conf.desde);
  if (!inicio) return abiertoTodo('anterior');
  if (!conf.paraTodos && desde && inicio < desde) {
    // Miembro antiguo: lo que ya empezó a ver se le conserva abierto y los cursos que no ha visto entran al calendario desde el día de su último pago
    // (el primero a N días del pago, y así cada N días). Sin pagos registrados no se sabe desde cuándo contar: todo abierto.
    const pivote = ultimoPago(miembro);
    if (!pivote) return abiertoTodo('anterior');
    return accesoAntiguoRenovado({ miembro, ids, conf, pivote, ahora, adelantados, iniciados, avances, retosSuperados, retosHechos });
  }

  const trial = miembro.trialCourseId !== undefined && miembro.trialCourseId !== null ? String(miembro.trialCourseId) : null;
  const primero = trial && ids.includes(trial) ? trial : ids[0];
  const orden = [primero, ...ids.filter(id => id !== primero)];

  const hoyMx = diaMx(ahora || new Date()), inicioMx = diaMx(inicio);
  const dias = Math.max(0, diasEntreDias(inicioMx, hoyMx));
  const nRetos = retosSuperados || 0;
  // Día en que se abre cada curso: el primero (la prueba) desde el pago; los demás cada N días. Si la membresía se venció y se volvió a pagar,
  // lo que ya estaba abierto al vencer se conserva y los que seguían cerrados se vuelven a fechar: el primero a N días de la reactivación y los demás cada N días.
  const aperturaDia = orden.map((_, k) => sumarDiasDia(inicioMx, k * conf.dias));
  const ciclos = reanudaciones(miembro);
  ciclos.forEach(c => {
    const abiertosAlVencer = aperturaDia.filter(d => d <= c.vencioDia).length;
    for (let k = abiertosAlVencer, j = 1; k < orden.length; k++, j++) aperturaDia[k] = sumarDiasDia(c.reanudoDia, j * conf.dias);
  });
  const abiertos = aperturaDia.filter(d => d <= hoyMx).length;

  const cursos = {};
  orden.forEach((id, k) => {
    if (k < abiertos) { cursos[id] = { abierto: true }; return; }
    const diaApertura = aperturaDia[k], abreEn = inicioDeDiaMx(diaApertura);
    cursos[id] = { abierto: false, abreEn: abreEn.toISOString(), dias: Math.max(1, diasEntreDias(hoyMx, diaApertura)), orden: k };
  });
  // Lo que el miembro ya empezó a ver se le conserva abierto (nadie pierde un curso en marcha)
  (iniciados || []).forEach(id => { const c = cursos[String(id)]; if (c && !c.abierto) cursos[String(id)] = { abierto: true, iniciado: true }; });
  // Cursos abiertos con el "Premio por invitar" (4 invitados válidos): quedan abiertos para siempre
  (adelantados || []).forEach(id => { if (cursos[String(id)]) cursos[String(id)] = { abierto: true, porPremio: true }; });
  // Curso abierto con el adelanto por retos (una sola vez)
  if (adelantoRetos && cursos[String(adelantoRetos)]) cursos[String(adelantoRetos)] = { abierto: true, porRetos: true };
  const prog = progresoAdelanto(retosHechos, conf.retosParaAdelantar);
  // Los retos solo adelantan el PRIMER curso de los N días (el que sigue a la prueba) y solo en la primera membresía: quien vuelve a pagar tras vencerse ya no puede adelantar con retos.
  const candidato = orden[1] && cursos[orden[1]] && !cursos[orden[1]].abierto ? orden[1] : null;
  const adelanto = adelantoRetos ? { estado: 'usado', cursoId: String(adelantoRetos), ...prog }
    : ciclos.length ? { estado: 'no-disponible', motivo: 'renovacion', cursoId: null, ...prog }
    : candidato ? { estado: 'disponible', cursoId: candidato, ...prog } : { estado: 'sin-cursos', cursoId: null, ...prog };
  return {
    escalonado: true, diasEntreCursos: conf.dias, retosParaAdelantar: conf.retosParaAdelantar,
    retosSuperados: nRetos, adelantos: adelantoRetos ? 1 : 0, adelanto,
    retosParaSiguiente: adelanto.estado === 'disponible' ? Math.max(0, conf.retosParaAdelantar - prog.total) : null,
    abiertos, total: orden.length, orden, cursos, reanudada: ciclos.length > 0,
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
const INTENTOS_PARA_REVELAR = 3;
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
  async function evaluar(uid, decoded, soloLeer) {
    const [mSnap, cfgSnap] = await Promise.all([db.collection('members').doc(uid).get(), db.collection('config').doc('club').get()]);
    const miembro = mSnap.exists ? (mSnap.data() || {}) : {};
    const retos = await leerRetos(uid);
    const premios = await db.collection('members').doc(uid).collection('progress').doc('premios').get();
    const adelantados = premios.exists ? ((premios.data() || {}).usados || []).map(u => u && u.cursoId).filter(Boolean) : [];
    const datosPremios = premios.exists ? (premios.data() || {}) : {};
    const progCursos = await db.collection('members').doc(uid).collection('progress').doc('courses').get();
    const datosProg = progCursos.exists ? (progCursos.data() || {}) : {};
    const avances = Object.fromEntries(Object.keys(datosProg).filter(k => /^c_/.test(k) && datosProg[k] && Array.isArray(datosProg[k].completed)).map(k => [k.slice(2), datosProg[k].completed.length]));
    const iniciados = Object.keys(datosProg).filter(k => /^c_/.test(k) && datosProg[k] && Array.isArray(datosProg[k].completed) && datosProg[k].completed.length > 0).map(k => k.slice(2));
    const params = {
      iniciados, avances, miembro, catalogo: deps.cargarCatalogo(), cfg: cfgSnap.exists ? cfgSnap.data() : {},
      retosSuperados: Object.keys(retos).length, retosHechos: retos, ahora: new Date(), esAdmin: esAdminPorToken(decoded), adelantados, conMembresia: deps.tieneMembresia(miembro)
    };
    let guardado = datosPremios.adelantoRetos && datosPremios.adelantoRetos.cursoId ? String(datosPremios.adelantoRetos.cursoId) : null;
    let acceso = calcularAcceso({ ...params, adelantoRetos: guardado });
    // Primera vez que se completan los retos pedidos: se abre el curso que seguía y se guarda para que no se repita
    if (!soloLeer && acceso.escalonado && !guardado && acceso.adelanto.estado === 'disponible' && acceso.adelanto.ok) {
      guardado = acceso.adelanto.cursoId;
      await db.collection('members').doc(uid).collection('progress').doc('premios').set({ adelantoRetos: { cursoId: guardado, fecha: new Date().toISOString(), retos: acceso.adelanto.total }, actualizadoMs: Date.now() }, { merge: true });
      acceso = calcularAcceso({ ...params, adelantoRetos: guardado });
    }
    return { miembro, acceso, retos, cfg: cfgSnap.exists ? cfgSnap.data() : {} };
  }
  deps.evaluarAcceso = evaluar;

  // Diagnóstico para el administrador: por qué un miembro ve sus cursos abiertos o cerrados (solo lectura, no guarda nada)
  //  GET /api/admin/acceso-miembro/:uid  →  datos de su cuenta, la configuración del calendario y el resultado
  app.get('/api/admin/acceso-miembro/:uid', async (req, res) => {
    try {
      const d = await sesion(req, res); if (!d) return;
      if (!esAdminPorToken(d)) return res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' });
      const uid = String(req.params.uid);
      const snap = await db.collection('members').doc(uid).get();
      if (!snap.exists) return res.status(404).json({ error: 'Ese miembro no existe.' });
      const m = snap.data() || {};
      const { acceso, cfg } = await evaluar(uid, { uid, email: m.email || '', email_verified: false }, true);
      const catalogo = deps.cargarCatalogo().courses || [];
      const fechas = (Array.isArray(m.payments) ? m.payments : []).map(p => p && p.date).filter(Boolean);
      res.json({
        miembro: { nombre: m.name || '', email: m.email || '', status: m.status || '', plan: m.plan || '', tieneMembresia: !!deps.tieneMembresia(m), activadoEn: m.activadoEn || '', giftedAt: m.giftedAt || '', startDate: m.startDate || '', lastPaymentDate: m.lastPaymentDate || '', accessUntil: m.accessUntil || '', nextPaymentDate: m.nextPaymentDate || '', pagos: fechas },
        calendario: { activo: cfg.escalonadoActivo === true, dias: cfg.escalonadoDias || 8, desde: cfg.escalonadoDesde || '', paraTodos: cfg.escalonadoParaTodos === true },
        inicioCalculado: acceso.inicio || '', motivo: acceso.motivo || (acceso.escalonado ? 'calendario' : ''), escalonado: !!acceso.escalonado, abiertos: Object.values(acceso.cursos || {}).filter(c => c.abierto).length, total: catalogo.length,
        cursos: catalogo.map(c => ({ id: String(c.courseId), titulo: c.title, abierto: !!(acceso.cursos[String(c.courseId)] || {}).abierto, dias: (acceso.cursos[String(c.courseId)] || {}).dias || 0 }))
      });
    } catch (e) { console.error('[acceso-miembro]', e.message); res.status(500).json({ error: 'No se pudo revisar el acceso.' }); }
  });

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
      if (!deps.tieneMembresia(miembro) && !esAdminPorToken(d)) return res.status(402).json({ error: 'Los retos son solo para miembros.' });

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
      // Detective: los lugares correctos que faltaron NO se muestran de inmediato; solo después de INTENTOS_PARA_REVELAR intentos sin superarlo (como Alintec)
      let revelar = false, intentosRestantes = 0;
      if (det) {
        const doc = (await refRetos(d.uid).get()), intentos = { ...(doc.exists ? ((doc.data() || {}).intentos || {}) : {}) };
        if (supera) { if (intentos[retoId]) { delete intentos[retoId]; await refRetos(d.uid).set({ intentos }, { merge: true }); } }
        else {
          intentos[retoId] = (Number(intentos[retoId]) || 0) + 1;
          if (intentos[retoId] >= INTENTOS_PARA_REVELAR) { revelar = true; delete intentos[retoId]; } else intentosRestantes = INTENTOS_PARA_REVELAR - intentos[retoId];
          await refRetos(d.uid).set({ intentos }, { merge: true });
        }
      }
      const { acceso } = await evaluar(d.uid, d);
      res.json({ ...(det ? { aciertos: det.aciertos, sobran: det.sobran, faltan: revelar ? det.faltan : [], faltanCuantos: det.faltan.length, revelado: revelar, intentosRestantes } : {}), supera, nuevo, xp: nuevo ? previos[retoId].xp : 0, ok, total, retosSuperados: Object.keys(previos).length, adelantos: acceso.adelantos || 0, retosParaSiguiente: acceso.retosParaSiguiente || null, adelanto: acceso.adelanto || null, escalonado: !!acceso.escalonado });
    } catch (e) { console.error('[retos] completar', e.message); res.status(500).json({ error: 'No se pudo registrar tu reto.' }); }
  });
}

module.exports = { configEscalonado, inicioMembresia, calcularAcceso, calificarQuiz, calificarOrden, calificarDetective, progresoAdelanto, xpDeRetoSuperado, montarRutasAcceso };
