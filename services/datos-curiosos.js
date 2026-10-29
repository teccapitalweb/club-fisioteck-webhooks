'use strict';
// DATOS CURIOSOS (adaptado de Alintec y Zoorigen): un banco de datos de fisioterapia y rehabilitación que llega a todos los miembros como
// aviso en la campana, 2 por semana (martes y viernes, desde las 7:00 a.m. hora de México). Sale primero el menos enviado, para que todos
// se repartan antes de repetirse. El administrador puede agregar, editar, pausar, borrar y mandar el que quiera "ahora".
//  GET  /api/admin/datos-curiosos            { datos, total, activos, temas, ultimoEnvio }
//  POST /api/admin/datos-curiosos            { texto, tema, enviarAhora? }
//  POST /api/admin/datos-curiosos/:id/actualizar   { texto?, tema?, activo? }
//  POST /api/admin/datos-curiosos/:id/eliminar
//  POST /api/admin/datos-curiosos/:id/enviar       lo manda ahora a todos
// Datos con fines educativos generales: no sustituyen el criterio clínico.
const crypto = require('crypto');
const { esAdminPorToken } = require('./certificados');
const { limpiarTexto } = require('./texto-seguro');

const COL = 'datosCuriosos', COL_AVISOS = 'member_notifications', CFG = ['config', 'datosCuriosos'];
const DIAS_DE_ENVIO = [2, 5]; // martes y viernes
const HORA_DE_ENVIO = 7;
const TEMAS = ['Anatomía', 'Fisiología', 'Ejercicio', 'Dolor', 'Rehabilitación', 'Postura', 'Historia', 'Neurociencia', 'Prevención', 'General'];
const MIN = 20, MAX = 400;

const BANCO_INICIAL = [
  { tema: 'Anatomía', texto: 'El cuerpo humano adulto tiene 206 huesos, pero un recién nacido tiene cerca de 300: muchos se fusionan durante el crecimiento.' },
  { tema: 'Anatomía', texto: 'El tendón de Aquiles es el más grueso y resistente del cuerpo humano, y conecta los músculos de la pantorrilla con el talón.' },
  { tema: 'Anatomía', texto: 'El músculo masetero, que se usa para masticar, es de los más fuertes del cuerpo en relación con su tamaño.' },
  { tema: 'Anatomía', texto: 'La columna vertebral tiene 33 vértebras en el desarrollo y, en el adulto, algunas se fusionan para formar el sacro y el cóccix.' },
  { tema: 'Anatomía', texto: 'El fémur es el hueso más largo y fuerte del cuerpo humano; puede soportar cargas muchas veces superiores al peso corporal.' },
  { tema: 'Anatomía', texto: 'Cada pie tiene 26 huesos y más de 100 entre músculos, tendones y ligamentos: casi una cuarta parte de los huesos del cuerpo están en los pies.' },
  { tema: 'Fisiología', texto: 'El tejido óseo se renueva constantemente: aproximadamente cada diez años se reemplaza buena parte del esqueleto adulto.' },
  { tema: 'Fisiología', texto: 'Los músculos no empujan, solo se contraen y jalan: por eso trabajan en pares, uno que flexiona y otro que extiende.' },
  { tema: 'Fisiología', texto: 'El cartílago articular no tiene vasos sanguíneos propios; recibe sus nutrientes del líquido sinovial, que circula cuando la articulación se mueve.' },
  { tema: 'Fisiología', texto: 'La musculatura es el principal tejido que consume glucosa en el cuerpo durante el ejercicio, por eso el movimiento ayuda a regular el azúcar en sangre.' },
  { tema: 'Ejercicio', texto: 'Tras unas semanas de entrenamiento de fuerza, las primeras mejoras vienen sobre todo del sistema nervioso, que aprende a reclutar mejor las fibras musculares.' },
  { tema: 'Ejercicio', texto: 'El dolor muscular tardío (agujetas) suele aparecer entre 24 y 72 horas después de un ejercicio al que el cuerpo no está acostumbrado.' },
  { tema: 'Ejercicio', texto: 'Caminar a paso ligero unos 150 minutos por semana es la recomendación de actividad física moderada que la OMS plantea para adultos.' },
  { tema: 'Ejercicio', texto: 'El calentamiento eleva la temperatura muscular y la lubricación articular, y prepara al sistema nervioso para moverse con más precisión.' },
  { tema: 'Dolor', texto: 'El dolor es una alarma del sistema nervioso, no una medida exacta del daño: puede existir mucho dolor con poca lesión, y al revés.' },
  { tema: 'Dolor', texto: 'Mantenerse activo y volver al movimiento de forma gradual suele ayudar más a la recuperación del dolor lumbar que el reposo prolongado en cama.' },
  { tema: 'Dolor', texto: 'El dolor crónico se define, en general, como el que persiste por más de tres meses, cuando ya no cumple su función de alarma.' },
  { tema: 'Rehabilitación', texto: 'La movilización temprana, cuando es segura, reduce complicaciones como la debilidad muscular y las úlceras por presión en pacientes hospitalizados.' },
  { tema: 'Rehabilitación', texto: 'Tras un periodo de inmovilización, el músculo puede perder fuerza con rapidez: por eso la rehabilitación busca recuperar movimiento y carga de forma progresiva.' },
  { tema: 'Rehabilitación', texto: 'En rehabilitación neurológica, la repetición de tareas con intención y retroalimentación favorece la neuroplasticidad, la capacidad del cerebro de reorganizarse.' },
  { tema: 'Postura', texto: 'La mejor postura es la próxima: cambiar de posición con frecuencia suele ser más útil que intentar mantener una postura "perfecta" mucho tiempo.' },
  { tema: 'Postura', texto: 'Estar sentado largos periodos se asocia con mayores riesgos para la salud; interrumpirlo con breves pausas de movimiento ayuda a contrarrestarlo.' },
  { tema: 'Historia', texto: 'La palabra "fisioterapia" proviene del griego physis (naturaleza) y therapeia (tratamiento): tratamiento por medios naturales y físicos.' },
  { tema: 'Historia', texto: 'La Primera Guerra Mundial impulsó el desarrollo de la fisioterapia moderna por la necesidad de rehabilitar a gran cantidad de soldados.' },
  { tema: 'Neurociencia', texto: 'El cerebro de un adulto conserva la capacidad de cambiar: el aprendizaje y el movimiento pueden formar nuevas conexiones entre neuronas a cualquier edad.' },
  { tema: 'Neurociencia', texto: 'La propiocepción es el "sentido de posición" del cuerpo: nos permite saber dónde están nuestras articulaciones sin mirarlas, y se entrena con ejercicios de equilibrio.' },
  { tema: 'Prevención', texto: 'El equilibrio y la fuerza de piernas son dos de los factores que más ayudan a prevenir caídas en las personas mayores.' },
  { tema: 'Prevención', texto: 'Dormir lo suficiente favorece la recuperación muscular y el rendimiento: gran parte de la reparación de tejidos ocurre durante el sueño.' },
  { tema: 'Prevención', texto: 'Los ejercicios de fuerza con cargas progresivas también ayudan a mantener la densidad ósea y la masa muscular con la edad.' },
  { tema: 'General', texto: 'Una articulación sana se nutre con el movimiento: el cartílago necesita compresión y descompresión alternadas para recibir sus nutrientes.' }
].map((d, i) => ({ id: 'base_' + String(i + 1).padStart(2, '0'), ...d }));

const fechaMexico = (ahora = new Date()) => new Date(ahora.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const horaMexico = (ahora = new Date()) => new Date(ahora.getTime() - 6 * 3600 * 1000).getUTCHours();
const tocaEnviar = (ahora = new Date()) => DIAS_DE_ENVIO.includes(new Date(fechaMexico(ahora) + 'T12:00:00Z').getUTCDay()) && horaMexico(ahora) >= HORA_DE_ENVIO;

// El siguiente dato: entre los activos, el menos enviado y, a igualdad, el más antiguo o nunca enviado
function elegirDato(datos) {
  const activos = (datos || []).filter(d => d.activo !== false);
  if (!activos.length) return null;
  return activos.slice().sort((a, b) => (Number(a.veces) || 0) - (Number(b.veces) || 0) || String(a.ultimoEnvio || '').localeCompare(String(b.ultimoEnvio || '')) || (a.id < b.id ? -1 : 1))[0];
}
function validarDato({ texto, tema }) {
  const t = String(texto || '').trim();
  if (t.length < MIN) return 'El dato debe tener al menos ' + MIN + ' caracteres.';
  if (t.length > MAX) return 'El dato no puede pasar de ' + MAX + ' caracteres.';
  if (tema && !TEMAS.includes(tema)) return 'Elige un tema de la lista.';
  return null;
}
const nuevoId = () => 'dc_' + crypto.randomBytes(6).toString('hex');

// deps: { db, admin }
function crearServicio(deps) {
  const { db, admin } = deps;
  const FieldValue = admin && admin.firestore && admin.firestore.FieldValue;
  const marca = () => (FieldValue && FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date());

  async function sembrar() {
    const col = db.collection(COL), existentes = new Set((await col.get()).docs.map(d => d.id));
    let n = 0;
    for (const d of BANCO_INICIAL) if (!existentes.has(d.id)) { await col.doc(d.id).set({ tema: d.tema, texto: d.texto, activo: true, veces: 0, base: true }); n++; }
    return n;
  }
  async function publicar(dato, dia) {
    await db.collection(COL_AVISOS).doc('curioso_' + dia + '_' + dato.id).set({ category: 'curioso', title: 'Dato curioso' + (dato.tema ? ' · ' + dato.tema : ''), message: dato.texto, link: '', createdAt: marca() });
    await db.collection(COL).doc(dato.id).set({ veces: (Number(dato.veces) || 0) + 1, ultimoEnvio: dia }, { merge: true });
  }
  // Se revisa cada hora: martes y viernes desde las 7:00 a.m. sale uno, una sola vez por día
  async function revisarEnvio(ahora = new Date(), forzar = false) {
    const hoy = fechaMexico(ahora);
    if (!forzar && !tocaEnviar(ahora)) return { enviado: false, motivo: 'no-toca' };
    const cfg = db.collection(CFG[0]).doc(CFG[1]), previo = await cfg.get();
    if (!forzar && previo.exists && (previo.data() || {}).ultimoEnvio === hoy) return { enviado: false, motivo: 'ya-enviado' };
    const lista = (await db.collection(COL).get()).docs.map(d => ({ id: d.id, ...d.data() })), dato = elegirDato(lista);
    if (!dato) return { enviado: false, motivo: 'sin-datos' };
    await cfg.set({ ultimoEnvio: hoy, ultimoDato: dato.id }, { merge: true });
    await publicar(dato, hoy);
    return { enviado: true, dato: dato.id };
  }

  function montarRutas(app) {
    async function sesion(req, res) {
      const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
      let d; try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
      if (!esAdminPorToken(d)) { res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' }); return null; }
      return d;
    }
    const conAdmin = (fn) => async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      try { const d = await sesion(req, res); if (d) await fn(req, res, d); }
      catch (e) { if (e && e.status) return res.status(e.status).json({ error: e.message }); console.error('[datos curiosos]', e && e.message); res.status(500).json({ error: 'No se pudo completar la operación.' }); }
    };
    const err = (s, m) => { const e = new Error(m); e.status = s; return e; };
    const leer = async id => { const s = await db.collection(COL).doc(String(id)).get(); if (!s.exists) throw err(404, 'Ese dato no existe.'); return { id: String(id), ...s.data() }; };

    app.get('/api/admin/datos-curiosos', conAdmin(async (req, res) => {
      await sembrar();
      const lista = (await db.collection(COL).get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.base ? 0 : 1) - (a.base ? 0 : 1) || String(a.id).localeCompare(String(b.id)));
      const cfg = await db.collection(CFG[0]).doc(CFG[1]).get();
      res.json({ ok: true, datos: lista, total: lista.length, activos: lista.filter(d => d.activo !== false).length, temas: TEMAS, ultimoEnvio: cfg.exists ? (cfg.data() || {}).ultimoEnvio || '' : '' });
    }));
    app.post('/api/admin/datos-curiosos', conAdmin(async (req, res) => {
      const b = req.body || {}, malo = validarDato(b);
      if (malo) throw err(400, malo);
      const id = nuevoId(), dato = { tema: TEMAS.includes(b.tema) ? b.tema : 'General', texto: limpiarTexto(b.texto, MAX), activo: true, veces: 0 };
      await db.collection(COL).doc(id).set({ ...dato, creadoEn: marca() });
      if (b.enviarAhora === true) await publicar({ id, ...dato }, fechaMexico());
      res.status(201).json({ ok: true, id });
    }));
    app.post('/api/admin/datos-curiosos/:id/actualizar', conAdmin(async (req, res) => {
      const act = await leer(req.params.id), b = req.body || {}, upd = {};
      if (b.texto !== undefined || b.tema !== undefined) { const malo = validarDato({ texto: b.texto !== undefined ? b.texto : act.texto, tema: b.tema }); if (malo) throw err(400, malo); }
      if (b.texto !== undefined) upd.texto = limpiarTexto(b.texto, MAX);
      if (b.tema !== undefined) upd.tema = b.tema || 'General';
      if (b.activo !== undefined) upd.activo = b.activo === true;
      await db.collection(COL).doc(act.id).set(upd, { merge: true });
      res.json({ ok: true });
    }));
    app.post('/api/admin/datos-curiosos/:id/eliminar', conAdmin(async (req, res) => { const act = await leer(req.params.id); await db.collection(COL).doc(act.id).delete(); res.json({ ok: true }); }));
    app.post('/api/admin/datos-curiosos/:id/enviar', conAdmin(async (req, res) => { const act = await leer(req.params.id); await publicar(act, fechaMexico()); res.json({ ok: true }); }));
  }
  return { sembrar, publicar, revisarEnvio, montarRutas };
}

module.exports = { crearServicio, BANCO_INICIAL, TEMAS, fechaMexico, tocaEnviar, elegirDato, validarDato };
