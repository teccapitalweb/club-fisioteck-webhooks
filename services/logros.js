'use strict';
// LOGROS, XP Y RACHA CALCULADOS POR EL SERVIDOR (como Alintec y Zoorigen: el navegador ya no escribe ni calcula nada de esto).
//  GET  /api/logros              evalúa y devuelve XP, nivel, racha, insignias (y cuáles se desbloquearon ahora)
//  POST /api/logros/visita       cuenta el día de hoy en la racha (una vez al día, hora de México) y evalúa
//  GET  /api/retos/clasificacion  top 20 del club (alias, avatar, XP y retos) y tu posición
//  POST /api/logros/bienvenida   +100 XP una sola vez al terminar el recorrido del panel
//  POST /api/logros/evento       { tipo: 'seccion'|'noticia'|'webinar', id }  (los PDF se cuentan solos al abrir el enlace)
//  GET  /api/retos/dia           la pregunta del reto del día { retoId, indice, hecho }
//  POST /api/retos/dia           { respuesta }  califica y da +25 XP una vez al día
//  POST /api/retos/cartas        +15 XP una vez al día por repasar flashcards
// Datos (solo el servidor escribe; el navegador solo lee su propia carpeta):
//  members/{uid}/progress/logros  { desbloqueadas:{id:fecha}, racha, ultimaVisita, stats:{...}, xpHeredado }
//  members/{uid}/progress/retos   { superados:{retoId:{fecha,mejor,total,xp}}, dia:{fecha,hecho}, cartasDia, xpExtra }
const fs = require('fs');
const path = require('path');
const { esAdminPorToken, cursoDeCatalogo, clasesCompletadas } = require('./certificados');

const LEVELS = [
  // Calibrado como Zoorigen: Profesional ≈ 22 % y Maestro ≈ 66 % del XP que se puede ganar en total (insignias, retos una sola vez, cursos,
  // invitados, práctica diaria con tope). Profesional no se alcanza solo con retos y Maestro pide terminar casi todo el Club.
  { nombre: 'Estudiante', min: 0 }, { nombre: 'Profesional', min: 2500 }, { nombre: 'Especialista', min: 3600 },
  { nombre: 'Experto', min: 4700 }, { nombre: 'Maestro FisioTeck', min: 6000 }
];
// id, nombre, descripción, XP, categoría y regla. (El navegador solo pone el ícono.)
const BADGES = [
  { id: 'first_class', nombre: 'Primera Clase', desc: 'Completa tu primera clase', xp: 50, cat: 'cursos', ok: s => s.totalLessons >= 1 },
  { id: 'first_course', nombre: 'Primer Curso', desc: 'Termina un curso completo', xp: 150, cat: 'cursos', ok: s => s.completedCourses >= 1 },
  { id: 'tri', nombre: 'Tricampeón', desc: 'Completa 3 cursos', xp: 300, cat: 'cursos', ok: s => s.completedCourses >= 3 },
  { id: 'half_dozen', nombre: 'Media Docena', desc: 'Completa 6 cursos', xp: 500, cat: 'cursos', ok: s => s.completedCourses >= 6 },
  { id: 'dominator', nombre: 'Dominador', desc: 'Completa 10 cursos', xp: 800, cat: 'cursos', ok: s => s.completedCourses >= 10 },
  { id: 'legend', nombre: 'Leyenda FisioTeck', desc: 'Completa los 14 cursos', xp: 1500, cat: 'cursos', ok: s => s.completedCourses >= 14 },
  { id: 'streak3', nombre: 'Racha de 3', desc: 'Entra al Club 3 días seguidos', xp: 100, cat: 'constancia', ok: s => s.streak >= 3 },
  { id: 'streak7', nombre: 'Racha de 7', desc: 'Entra 7 días seguidos', xp: 250, cat: 'constancia', ok: s => s.streak >= 7 },
  { id: 'streak30', nombre: 'Racha de 30', desc: 'Entra 30 días seguidos', xp: 700, cat: 'constancia', ok: s => s.streak >= 30 },
  { id: 'early_bird', nombre: 'Madrugador', desc: 'Entra antes de las 7am', xp: 75, cat: 'especial', ok: s => s.earlyBird },
  { id: 'night_owl', nombre: 'Noctámbulo', desc: 'Entra después de las 11pm', xp: 75, cat: 'especial', ok: s => s.nightOwl },
  { id: 'explorer', nombre: 'Explorador', desc: 'Visita todas las secciones', xp: 100, cat: 'especial', ok: s => s.sectionsVisited >= 7 },
  { id: 'reader', nombre: 'Lector Ávido', desc: 'Lee 5 noticias', xp: 100, cat: 'especial', ok: s => s.newsRead >= 5 },
  { id: 'pdf_collector', nombre: 'Coleccionista PDF', desc: 'Descarga 10 PDFs', xp: 200, cat: 'especial', ok: s => s.pdfsDownloaded >= 10 },
  { id: 'live_fan', nombre: 'En Vivo', desc: 'Asiste a un webinar', xp: 150, cat: 'especial', ok: s => s.webinarsAttended >= 1 },
  { id: 'founder', nombre: 'Socio Fundador', desc: 'Ser de los primeros 50 miembros', xp: 500, cat: 'especial', ok: s => s.isFounder },
  { id: 'reto_1', nombre: 'Primer Reto', desc: 'Supera tu primer reto', xp: 50, cat: 'especial', ok: s => s.retosHechos >= 1 },
  { id: 'reto_5', nombre: 'Retador', desc: 'Supera 5 retos distintos', xp: 150, cat: 'especial', ok: s => s.retosHechos >= 5 },
  { id: 'reto_perfecto', nombre: 'Sin Errores', desc: 'Responde un quiz completo sin fallar', xp: 200, cat: 'especial', ok: s => s.retosPerfectos >= 1 },
  // Comunidad: cuentan los invitados que ya confirmaron su correo (como Zoorigen)
  { id: 'embajador', nombre: 'Embajador', desc: 'Invita a 1 persona que confirme su cuenta', xp: 60, cat: 'especial', ok: s => s.invitadosValidos >= 1 },
  { id: 'manada_crece', nombre: 'La manada crece', desc: 'Invita a 4 personas que confirmen su cuenta', xp: 150, cat: 'especial', ok: s => s.invitadosValidos >= 4 }
];
const SECCIONES = ['home', 'library', 'courses-live', 'pdfs', 'news', 'community', 'forum', 'certificates', 'achievements', 'retos', 'atlas', 'eva', 'glossary', 'rehab-calc', 'rom', 'timer', 'account', 'subscription', 'referidos', 'directorio', 'settings', 'notifications', 'discount'];
const COL_CLASIFICACION = 'retosClasificacion';
const aliasDe = nombre => { const p = String(nombre || '').trim().split(/\s+/).filter(Boolean); if (!p.length) return 'Miembro'; return p.length > 1 ? p[0].slice(0, 20) + ' ' + p[1].charAt(0).toUpperCase() + '.' : p[0].slice(0, 20); };
const TOPE_XP_PRACTICA = 600; // lo máximo que suman en toda la vida el reto del día y las flashcards
const XP_BIENVENIDA = 100, XP_DIA = 25, XP_CARTAS = 15, MAX_IDS = 60, MAX_XP_HEREDADO = 5000;

const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', hourCycle: 'h23' });
const diaMexico = f => fmtDia.format(f);
const horaMexico = f => Number(fmtHora.format(f).slice(0, 2));
const sumarDias = (dia, n) => { const [a, m, d] = dia.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10); };

// XP de un reto superado: el que se guardó al superarlo; en los antiguos se calcula con la misma regla de siempre
function xpDeReto(id, r) {
  if (r && Number.isFinite(r.xp)) return r.xp;
  const mejor = Number(r && r.mejor) || 0, total = Number(r && r.total) || 0;
  return total ? mejor * 10 + (mejor / total >= 0.8 ? 20 : 0) : 25;
}
function nivelDe(xp) {
  let i = 0;
  LEVELS.forEach((l, k) => { if (xp >= l.min) i = k; });
  const nivel = LEVELS[i], sig = LEVELS[i + 1] || null;
  return { indice: i, nombre: nivel.nombre, min: nivel.min, siguiente: sig ? { nombre: sig.nombre, min: sig.min, faltan: sig.min - xp } : null, porcentaje: sig ? Math.min(100, Math.round((xp - nivel.min) / (sig.min - nivel.min) * 100)) : 100 };
}
// Racha: una vez por día de México; si ayer entró sigue, si no, vuelve a 1
function actualizarRacha(doc, ahora) {
  const hoy = diaMexico(ahora);
  if (doc.ultimaVisita === hoy) return { cambio: false, racha: doc.racha || 1 };
  const racha = doc.ultimaVisita === sumarDias(hoy, -1) ? (doc.racha || 0) + 1 : 1;
  const stats = { ...(doc.stats || {}) };
  const h = horaMexico(ahora);
  if (h < 7) stats.earlyBird = true;
  if (h >= 23) stats.nightOwl = true;
  return { cambio: true, racha, ultimaVisita: hoy, stats };
}

let clavesCache = null;
function leerClaves() {
  if (!clavesCache) { try { clavesCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'retos-claves.json'), 'utf8')); } catch (_) { clavesCache = { quiz: {}, orden: {} }; } }
  return clavesCache;
}
// Pregunta del día: la misma regla que usaba el Club (día / total de preguntas), ahora la decide el servidor
function retoDelDia(dia, claves = leerClaves()) {
  const todas = [];
  Object.keys(claves.quiz || {}).forEach(id => (claves.quiz[id] || []).forEach((c, i) => todas.push({ retoId: id, indice: i, correcta: c })));
  if (!todas.length) return null;
  const n = Math.floor(new Date(dia + 'T00:00:00Z').getTime() / 86400000);
  return todas[n % todas.length];
}

function montarRutasLogros(app, deps) {
  const { db, admin } = deps;
  const ahora = deps.ahora || (() => new Date());
  const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
  const refProg = (uid, doc) => db.collection('members').doc(uid).collection('progress').doc(doc);
  const leer = async (uid, doc) => { const s = await refProg(uid, doc).get(); return s.exists ? (s.data() || {}) : null; };

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); } catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { const d = await sesion(req, res); if (d) await fn(req, res, d); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[logros ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };

  // Primera vez: se conserva el historial que la persona ya tenía (insignias, racha y XP de retos del sistema anterior)
  async function migrarSiHaceFalta(uid) {
    const viejo = await leer(uid, 'achievements');
    const doc = { desbloqueadas: {}, racha: 0, ultimaVisita: '', stats: {}, xpHeredado: 0, migrado: true };
    if (viejo) {
      (Array.isArray(viejo.unlocked) ? viejo.unlocked : []).forEach(id => { if (BADGES.some(b => b.id === id)) doc.desbloqueadas[id] = 'anterior'; });
      doc.racha = Math.max(0, Math.min(Number(viejo.streak) || 0, 3650)); doc.ultimaVisita = /^\d{4}-\d{2}-\d{2}$/.test(String(viejo.lastVisit || '')) ? viejo.lastVisit : '';
      const st = viejo.stats || {};
      doc.stats = { earlyBird: st.earlyBird === true, nightOwl: st.nightOwl === true, newsRead: Math.min(Number(st.newsRead) || 0, MAX_IDS), webinarsAttended: Math.min(Number(st.webinarsAttended) || 0, MAX_IDS), pdfsDownloaded: Math.min(Number(st.pdfsDownloaded) || 0, MAX_IDS) };
      doc.xpHeredado = Math.max(0, Math.min(Number(viejo.retos && viejo.retos.xp) || 0, MAX_XP_HEREDADO));
    }
    return doc;
  }

  // Estado completo: lee todo, calcula, desbloquea lo nuevo y guarda
  async function estadoDe(uid, d, { cambios } = {}) {
    let doc = await leer(uid, 'logros');
    if (!doc) doc = await migrarSiHaceFalta(uid);
    if (cambios) doc = { ...doc, ...cambios, stats: { ...(doc.stats || {}), ...(cambios.stats || {}) } };
    const [progreso, retos, mSnap] = await Promise.all([leer(uid, 'courses'), leer(uid, 'retos'), db.collection('members').doc(uid).get()]);
    const miembro = mSnap.exists ? (mSnap.data() || {}) : {};
    const catalogo = deps.cargarCatalogo();
    let totalLessons = 0, completedCourses = 0;
    (catalogo.courses || []).forEach(c => {
      const total = (c.lessons || []).length, hechas = clasesCompletadas(progreso || {}, c.courseId, total);
      totalLessons += hechas; if (total > 0 && hechas >= total) completedCourses++;
    });
    const superados = (retos && retos.superados) || {};
    const st = doc.stats || {};
    let invitadosValidos = 0;
    try { if (deps.referidosValidosDe) invitadosValidos = Number(await deps.referidosValidosDe(uid)) || 0; } catch (_) { /* sin referidos */ }
    const stats = {
      totalLessons, completedCourses, streak: doc.racha || 0, earlyBird: st.earlyBird === true, nightOwl: st.nightOwl === true,
      sectionsVisited: (st.secciones || []).length, newsRead: Math.max((st.noticias || []).length, Number(st.newsRead) || 0),
      pdfsDownloaded: Math.max((st.pdfs || []).length, Number(st.pdfsDownloaded) || 0), webinarsAttended: Math.max((st.webinars || []).length, Number(st.webinarsAttended) || 0),
      isFounder: miembro.founder === true || miembro.fundador === true,
      invitadosValidos, retosHechos: Object.keys(superados).length, retosPerfectos: Object.values(superados).filter(r => r.total > 0 && r.mejor === r.total).length
    };
    const desbloqueadas = { ...(doc.desbloqueadas || {}) };
    const nuevas = [];
    BADGES.forEach(b => { if (!desbloqueadas[b.id] && b.ok(stats)) { desbloqueadas[b.id] = ahora().toISOString(); nuevas.push(b.id); } });
    const xpInsignias = BADGES.reduce((t, b) => t + (desbloqueadas[b.id] ? b.xp : 0), 0);
    const xpRetos = Object.entries(superados).reduce((t, [id, r]) => t + xpDeReto(id, r), 0) + Math.min(Number(retos && retos.xpExtra) || 0, TOPE_XP_PRACTICA) + (Number(doc.xpHeredado) || 0) + (doc.bienvenida ? XP_BIENVENIDA : 0);
    const xp = xpInsignias + xpRetos;
    // Clasificación del club: solo nombre público (nombre y la inicial del apellido), avatar elegido, XP y retos superados. Se actualiza si algo cambió.
    const alias = aliasDe(miembro.name || d.name || ''), avatar = /^a(0[1-9]|1[0-6])$/.test(String(miembro.avatar || '')) ? miembro.avatar : '', oculto = miembro.rankingOculto === true;
    const clas = { alias, avatar, oculto, xp, retos: stats.retosHechos };
    const cambioClas = !doc.clas || ['alias', 'avatar', 'oculto', 'xp', 'retos'].some(k => doc.clas[k] !== clas[k]);
    const nuevoDoc = { ...doc, desbloqueadas, clas };
    if (cambioClas) await db.collection(COL_CLASIFICACION).doc(uid).set({ ...clas, actualizadoMs: Date.now() });
    if (nuevas.length || cambios || cambioClas || !(await refProg(uid, 'logros').get()).exists) await refProg(uid, 'logros').set(nuevoDoc);
    return {
      xp, xpInsignias, xpRetos, nivel: nivelDe(xp), racha: doc.racha || 0,
      insignias: BADGES.map(b => ({ id: b.id, nombre: b.nombre, desc: b.desc, xp: b.xp, cat: b.cat, desbloqueada: !!desbloqueadas[b.id], fecha: desbloqueadas[b.id] && desbloqueadas[b.id] !== 'anterior' ? desbloqueadas[b.id] : null })),
      stats: { cursosCompletos: completedCourses, clases: totalLessons, retosSuperados: stats.retosHechos, retosPerfectos: stats.retosPerfectos, secciones: stats.sectionsVisited, noticias: stats.newsRead },
      hechos: superados, nuevas, bienvenida: !!doc.bienvenida, xpBienvenida: XP_BIENVENIDA
    };
  }
  deps.estadoLogros = estadoDe;

  app.get('/api/logros', envolver('estado', async (req, res, d) => { res.json(await estadoDe(d.uid, d)); }));

  app.post('/api/logros/visita', envolver('visita', async (req, res, d) => {
    let doc = await leer(d.uid, 'logros'); if (!doc) doc = await migrarSiHaceFalta(d.uid);
    const r = actualizarRacha(doc, ahora());
    res.json(await estadoDe(d.uid, d, r.cambio ? { cambios: { racha: r.racha, ultimaVisita: r.ultimaVisita, stats: r.stats } } : {}));
  }));

  // Clasificación del club: top 20 y tu posición. Solo expone alias, avatar, XP y retos superados (nunca correo, teléfono ni pagos).
  app.get('/api/retos/clasificacion', envolver('clasificacion', async (req, res, d) => {
    await estadoDe(d.uid, d); // pone al día tu propia fila
    const sn = await db.collection(COL_CLASIFICACION).limit(500).get();
    const filas = sn.docs.map(x => ({ uid: x.id, ...x.data() })).filter(r => !r.oculto && r.xp > 0).sort((a, b) => b.xp - a.xp || b.retos - a.retos || (a.uid < b.uid ? -1 : 1));
    const mia = filas.findIndex(r => r.uid === d.uid);
    res.json({ ok: true, total: filas.length, tuPosicion: mia >= 0 ? mia + 1 : null,
      filas: filas.slice(0, 20).map((r, i) => ({ posicion: i + 1, nombre: r.alias || 'Miembro', avatar: r.avatar || '', xp: r.xp, retos: r.retos || 0, esTu: r.uid === d.uid })) });
  }));

  // Premio de bienvenida: +100 XP una sola vez, al terminar el recorrido del panel
  app.post('/api/logros/bienvenida', envolver('bienvenida', async (req, res, d) => {
    let doc = await leer(d.uid, 'logros'); if (!doc) doc = await migrarSiHaceFalta(d.uid);
    const nuevo = !doc.bienvenida;
    const estado = await estadoDe(d.uid, d, nuevo ? { cambios: { bienvenida: true, bienvenidaEn: ahora().toISOString() } } : {});
    res.json({ ...estado, premioNuevo: nuevo });
  }));

  // Eventos que el servidor no puede ver solo: cada id cuenta una vez y hay un tope, para que no se pueda inflar
  const claveEvento = { seccion: 'secciones', noticia: 'noticias', webinar: 'webinars', pdf: 'pdfs' };
  async function registrarEvento(uid, tipo, id) {
    const campo = claveEvento[tipo]; if (!campo) throw errorHttp(400, 'Evento inválido.');
    id = String(id == null ? '' : id).replace(/[^\w.-]/g, '').slice(0, 60);
    if (!id) throw errorHttp(400, 'Evento inválido.');
    if (tipo === 'seccion' && !SECCIONES.includes(id)) return false;
    let doc = await leer(uid, 'logros'); if (!doc) doc = await migrarSiHaceFalta(uid);
    const lista = Array.isArray((doc.stats || {})[campo]) ? doc.stats[campo] : [];
    if (lista.includes(id) || lista.length >= MAX_IDS) return false;
    await refProg(uid, 'logros').set({ ...doc, stats: { ...(doc.stats || {}), [campo]: [...lista, id] } });
    return true;
  }
  deps.registrarEventoLogro = (uid, tipo, id) => registrarEvento(uid, tipo, id).catch(() => false);
  app.post('/api/logros/evento', envolver('evento', async (req, res, d) => {
    const b = req.body || {};
    if (b.tipo === 'pdf') throw errorHttp(400, 'Los PDF se cuentan solos.');
    if (b.tipo === 'webinar') { const m = await db.collection('members').doc(d.uid).get(); if (!esAdminPorToken(d) && !deps.tieneMembresia(m.exists ? m.data() : {})) throw errorHttp(402, 'Las clases en vivo son parte de la membresía.'); }
    await registrarEvento(d.uid, b.tipo, b.id);
    res.json(await estadoDe(d.uid, d));
  }));

  // ----- Reto del día y flashcards (XP una vez al día, decidido aquí) -----
  async function puedeJugar(uid, d) {
    if (esAdminPorToken(d)) return;
    const m = await db.collection('members').doc(uid).get();
    const miembro = m.exists ? (m.data() || {}) : {};
    if (!deps.tieneMembresia(miembro) && (miembro.trialCourseId === undefined || miembro.trialCourseId === null)) throw errorHttp(402, 'Los retos son para miembros y para quien ya eligió su curso de prueba.');
  }
  app.get('/api/retos/dia', envolver('dia', async (req, res, d) => {
    const hoy = diaMexico(ahora()), q = retoDelDia(hoy);
    if (!q) throw errorHttp(404, 'Todavía no hay preguntas.');
    const r = (await leer(d.uid, 'retos')) || {};
    res.json({ retoId: q.retoId, indice: q.indice, fecha: hoy, hecho: !!(r.dia && r.dia.fecha === hoy && r.dia.hecho), xp: XP_DIA });
  }));
  app.post('/api/retos/dia', envolver('dia-responder', async (req, res, d) => {
    await puedeJugar(d.uid, d);
    const hoy = diaMexico(ahora()), q = retoDelDia(hoy), k = Number((req.body || {}).respuesta);
    if (!q || !Number.isInteger(k) || k < 0 || k > 10) throw errorHttp(400, 'Respuesta inválida.');
    const r = (await leer(d.uid, 'retos')) || {};
    const yaHecho = !!(r.dia && r.dia.fecha === hoy && r.dia.hecho);
    const acertada = k === q.correcta;
    let xp = 0;
    if (acertada && !yaHecho) { xp = Math.min(XP_DIA, Math.max(0, TOPE_XP_PRACTICA - (Number(r.xpExtra) || 0))); await refProg(d.uid, 'retos').set({ dia: { fecha: hoy, hecho: true }, xpExtra: (Number(r.xpExtra) || 0) + xp }, { merge: true }); }
    res.json({ acertada, correcta: q.correcta, xp, hecho: yaHecho || acertada, estado: await estadoDe(d.uid, d) });
  }));
  app.post('/api/retos/cartas', envolver('cartas', async (req, res, d) => {
    await puedeJugar(d.uid, d);
    const hoy = diaMexico(ahora()), r = (await leer(d.uid, 'retos')) || {};
    let xp = 0;
    if (r.cartasDia !== hoy) { xp = Math.min(XP_CARTAS, Math.max(0, TOPE_XP_PRACTICA - (Number(r.xpExtra) || 0))); await refProg(d.uid, 'retos').set({ cartasDia: hoy, xpExtra: (Number(r.xpExtra) || 0) + xp }, { merge: true }); }
    res.json({ xp, estado: await estadoDe(d.uid, d) });
  }));
}

module.exports = { TOPE_XP_PRACTICA, montarRutasLogros, LEVELS, BADGES, nivelDe, xpDeReto, actualizarRacha, retoDelDia, diaMexico };
