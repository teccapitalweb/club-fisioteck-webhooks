'use strict';
// Rutas de administrador para el panel (solo con correo de administrador verificado):
//   GET  /api/admin/bunny-catalogo   colecciones y videos de la biblioteca de Bunny Stream (nunca devuelve la llave)
//   POST /api/admin/catalogo-curso   registra las clases de un curso creado o editado en el panel, para que se pueda reproducir
//   GET  /api/admin/estado           semáforo de servicios (servidor, base de datos, Stripe, Bunny, correos, certificados…)
const { esAdminPorToken } = require('./certificados');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PESO = { ok: 0, aviso: 1, error: 2 };
const iniciadoMs = Date.now();

function numeroDeClase(titulo) { const m = /\d+/.exec(String(titulo || '').replace(/\.[a-z0-9]{2,4}$/i, '')); return m ? parseInt(m[0], 10) : 0; }
function minutosTexto(seg) { const m = Math.round(Number(seg) / 60); return m > 0 ? m + ' min' : ''; }

// Valida y normaliza el curso que manda el panel. Devuelve { ok:false, error } o { ok:true, curso }.
function validarCursoCatalogo(cuerpo) {
  const c = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const courseId = String(c.courseId == null ? '' : c.courseId).trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(courseId)) return { ok: false, error: 'Curso inválido.' };
  const title = String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) return { ok: false, error: 'El curso necesita título.' };
  if (!Array.isArray(c.lessons) || c.lessons.length > 200) return { ok: false, error: 'Las clases no son válidas.' };
  const lessons = [];
  for (let i = 0; i < c.lessons.length; i++) {
    const l = c.lessons[i] || {};
    const lessonId = String(l.lessonId == null ? '' : l.lessonId).trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(lessonId)) return { ok: false, error: 'La clase ' + (i + 1) + ' no tiene un identificador válido.' };
    const bunnyVideoId = String(l.bunnyVideoId || '').trim();
    if (bunnyVideoId && !GUID.test(bunnyVideoId)) return { ok: false, error: 'La clase ' + (i + 1) + ': el ID de Bunny no es válido.' };
    lessons.push({ lessonId, title: String(l.title || 'Clase ' + (i + 1)).slice(0, 200), index: i, isPreview: l.isPreview === true, videoProvider: bunnyVideoId ? 'bunny' : 'otro', bunnyVideoId });
  }
  const collectionId = String(c.collectionId || '').trim();
  return { ok: true, curso: { courseId: /^\d+$/.test(courseId) ? Number(courseId) : courseId, title, collectionId: GUID.test(collectionId) ? collectionId : '', lessons } };
}

function montarRutasAdminExtra(app, deps) {
  const { db, admin } = deps;
  const env = deps.env || process.env;
  const llamar = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  const biblioteca = () => env.BUNNY_STREAM_LIBRARY_ID || '';
  const llaveApi = () => env.BUNNY_STREAM_API_KEY || '';

  async function sesionAdmin(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    let d; try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
    if (!esAdminPorToken(d)) { res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' }); return null; }
    return d;
  }
  const soloAdmin = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { const d = await sesionAdmin(req, res); if (d) await fn(req, res, d); }
    catch (e) { console.error('[admin-extra]', req.path, e && e.message); res.status(e && e.status ? e.status : 500).json({ error: e && e.status ? e.message : 'No se pudo completar la operación.' }); }
  };

  const pausa = ms => new Promise(r => setTimeout(r, ms));
  // Bunny limita cuántas consultas acepta a la vez: se reintenta si responde 429 o un error del servidor
  async function bunnyGet(ruta) {
    if (!llamar) throw Object.assign(new Error('Este servidor no puede llamar a Bunny.'), { status: 503 });
    let ultimo = 0;
    for (let intento = 1; intento <= 3; intento++) {
      const opciones = { headers: { AccessKey: llaveApi(), accept: 'application/json' } };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opciones.signal = AbortSignal.timeout(15000);
      let r;
      try { r = await llamar('https://video.bunnycdn.com/library/' + encodeURIComponent(biblioteca()) + ruta, opciones); }
      catch (e) { ultimo = 0; if (intento < 3) { await pausa(300 * intento); continue; } throw Object.assign(new Error('Bunny no respondió a tiempo.'), { status: 502 }); }
      if (r.ok) return r.json();
      ultimo = r.status;
      if ((r.status === 429 || r.status >= 500) && intento < 3) { await pausa(400 * intento); continue; }
      break;
    }
    throw Object.assign(new Error('Bunny respondió ' + ultimo + (ultimo === 401 || ultimo === 403 ? ' (revisa BUNNY_STREAM_API_KEY)' : '') + '.'), { status: 502 });
  }
  // Consulta varias listas con un máximo de 3 a la vez (antes eran todas de golpe)
  async function enParalelo(lista, limite, fn) {
    const salida = new Array(lista.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(limite, lista.length) }, async () => { while (i < lista.length) { const k = i++; salida[k] = await fn(lista[k]); } }));
    return salida;
  }
  async function listarTodo(ruta) {
    const items = [];
    for (let pagina = 1; pagina <= 30; pagina++) {
      const d = await bunnyGet(ruta + (ruta.includes('?') ? '&' : '?') + 'page=' + pagina + '&itemsPerPage=100');
      const lote = Array.isArray(d.items) ? d.items : [];
      items.push(...lote);
      if (lote.length < 100) break;
    }
    return items;
  }

  const cacheCatalogo = { datos: null, t: 0 };
  app.get('/api/admin/bunny-catalogo', soloAdmin(async (req, res) => {
    if (!biblioteca() || !llaveApi()) return res.status(503).json({ error: 'Bunny todavía no está configurado en el servidor (BUNNY_STREAM_LIBRARY_ID y BUNNY_STREAM_API_KEY).' });
    // Lo último que salió bien se recuerda 5 minutos; si Bunny falla se usa el catálogo guardado en el servidor para que el panel no se quede sin él
    if (cacheCatalogo.datos && Date.now() - cacheCatalogo.t < 5 * 60 * 1000) return res.json({ ok: true, catalogo: cacheCatalogo.datos, origen: 'reciente' });
    let colecciones, catalogo;
    try {
    colecciones = await listarTodo('/collections');
    catalogo = await enParalelo(colecciones, 3, async col => {
      const videos = (await listarTodo('/videos?collection=' + encodeURIComponent(col.guid))).filter(v => v.status === 4);
      const sesiones = videos.map((v, k) => ({ numero: numeroDeClase(v.title) || k + 1, titulo: String(v.title || '').replace(/\.[a-z0-9]{2,4}$/i, ''), videoId: v.guid, duracion: minutosTexto(v.length) }))
        .sort((a, b) => a.numero - b.numero);
      return { titulo: col.name, collectionId: col.guid, sesiones };
    });
    } catch (e) {
      console.error('[admin-extra] bunny-catalogo:', e && e.message);
      const guardado = deps.cargarCatalogo ? deps.cargarCatalogo() : null;
      const cursos = guardado && Array.isArray(guardado.courses) ? guardado.courses : [];
      if (!cursos.length) throw e;
      const respaldo = cursos.map(c => ({ titulo: c.title, collectionId: c.collectionId || '', sesiones: (c.lessons || []).filter(l => l.bunnyVideoId).map((l, k) => ({ numero: numeroDeClase(l.title) || k + 1, titulo: String(l.title || ''), videoId: l.bunnyVideoId, duracion: '' })) }));
      return res.json({ ok: true, catalogo: respaldo, origen: 'guardado', aviso: (e && e.message ? e.message + ' ' : '') + 'Se muestra el catálogo guardado en el servidor.' });
    }
    cacheCatalogo.datos = catalogo; cacheCatalogo.t = Date.now();
    res.json({ ok: true, catalogo, origen: 'bunny' });
  }));

  app.post('/api/admin/catalogo-curso', soloAdmin(async (req, res, d) => {
    const v = validarCursoCatalogo(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    await db.collection('catalogoVideo').doc(String(v.curso.courseId)).set({ ...v.curso, actualizadoPor: d.email, actualizadoMs: Date.now() });
    if (deps.registrarCatalogoExtra) deps.registrarCatalogoExtra(v.curso);
    res.json({ ok: true, clases: v.curso.lessons.length, conVideo: v.curso.lessons.filter(l => l.bunnyVideoId).length });
  }));

  // ----- Semáforo de servicios -----
  async function revisar() {
    const lista = [];
    const agrega = (id, nombre, estado, detalle) => lista.push({ id, nombre, estado, detalle });
    const horas = (Date.now() - iniciadoMs) / 36e5;
    agrega('servidor', 'Servidor', 'ok', 'Activo hace ' + (horas < 1 ? Math.max(1, Math.round(horas * 60)) + ' min' : horas < 48 ? horas.toFixed(1) + ' h' : Math.round(horas / 24) + ' días') + '.');
    try {
      const s = await db.collection('config').doc('club').get();
      const c = s.exists ? s.data() : {};
      agrega('bd', 'Base de datos y precios', 'ok', Number(c.precioMes) > 0 && Number(c.precioAno) > 0 ? 'Firestore responde. Mensual $' + c.precioMes + ' · anual $' + c.precioAno + '.' : 'Firestore responde, pero los precios no se han guardado desde el panel (se usan $249 y $1,999).');
      if (!(Number(c.precioMes) > 0)) lista[lista.length - 1].estado = 'aviso';
      agrega('visitas', 'Contador de visitas', 'ok', c.contadorVisitas === true ? 'Encendido: suma visitas por día y página.' : 'Apagado (puedes encenderlo en Encuesta y visitas).');
    } catch (e) { agrega('bd', 'Base de datos y precios', 'error', 'No se pudo leer Firestore: ' + String(e && e.message).slice(0, 80)); }
    agrega('stripe', 'Stripe · cobros', env.STRIPE_SECRET_KEY ? 'ok' : 'error', env.STRIPE_SECRET_KEY ? 'Llave configurada.' : 'Falta STRIPE_SECRET_KEY: no se pueden crear cobros.');
    agrega('stripe-avisos', 'Stripe · avisos de pago', env.STRIPE_WEBHOOK_SECRET ? 'ok' : 'aviso', env.STRIPE_WEBHOOK_SECRET ? 'Firma de avisos configurada.' : 'Falta STRIPE_WEBHOOK_SECRET: los pagos no activarían membresías.');
    if (!biblioteca() || !llaveApi() || !env.BUNNY_STREAM_TOKEN_KEY) {
      agrega('bunny', 'Videos de los cursos (Bunny)', 'aviso', 'Faltan variables: ' + [!biblioteca() && 'BUNNY_STREAM_LIBRARY_ID', !llaveApi() && 'BUNNY_STREAM_API_KEY', !env.BUNNY_STREAM_TOKEN_KEY && 'BUNNY_STREAM_TOKEN_KEY'].filter(Boolean).join(', ') + '.');
    } else {
      try { await bunnyGet('/collections?page=1&itemsPerPage=1'); agrega('bunny', 'Videos de los cursos (Bunny)', 'ok', 'La biblioteca responde.'); }
      catch (e) { agrega('bunny', 'Videos de los cursos (Bunny)', 'error', 'No respondió: ' + String(e && e.message).slice(0, 80)); }
    }
    // Los correos del Club salen por Resend (dominio propio); EmailJS es solo el respaldo antiguo
    const resend = Boolean(String(env.RESEND_API_KEY || '').trim() && String(env.MAIL_FROM || '').trim());
    const emailjs = ['EMAILJS_SERVICE_ID', 'EMAILJS_TEMPLATE_ID', 'EMAILJS_PUBLIC_KEY', 'EMAILJS_PRIVATE_KEY'].every(k => env[k]);
    agrega('correos', 'Correos', resend || emailjs ? 'ok' : 'aviso', resend ? 'Resend configurado: salen los correos de confirmación, bienvenida, cancelación y certificados.' : emailjs ? 'EmailJS configurado (respaldo antiguo). Recomendado: configura Resend con RESEND_API_KEY y MAIL_FROM.' : 'No hay servicio de correo: faltan RESEND_API_KEY y MAIL_FROM. No salen los correos de confirmación, bienvenida ni cancelación.');
    agrega('certificados', 'Certificados', env.CERT_SIGNING_KEY ? 'ok' : 'error', env.CERT_SIGNING_KEY ? 'Llave de firma configurada.' : 'Falta CERT_SIGNING_KEY: no se pueden emitir certificados.');
    const admins = String(env.ADMIN_EMAILS || 'teccapitalweb@gmail.com,fisiotec25@gmail.com').split(',').filter(s => s.trim()).length;
    agrega('admins', 'Administradores autorizados', 'ok', admins + ' correo' + (admins === 1 ? '' : 's') + ' con acceso.');
    const peor = lista.reduce((p, s) => Math.max(p, PESO[s.estado]), 0);
    return { ok: true, generado: new Date().toISOString(), resumen: ['ok', 'aviso', 'error'][peor], servicios: lista, uptimeSeg: Math.round((Date.now() - iniciadoMs) / 1000) };
  }
  app.get('/api/admin/estado', soloAdmin(async (req, res) => { res.json(await revisar()); }));
}

module.exports = { montarRutasAdminExtra, validarCursoCatalogo, numeroDeClase };
