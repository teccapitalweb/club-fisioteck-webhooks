'use strict';
// LIBROS DE LECTURA (adaptado de Alintec): biblioteca de libros que el administrador publica desde el panel y que los miembros desbloquean
// superando retos (un libro pide cierto número de retos). El enlace de lectura solo lo entrega el servidor a quien lo desbloqueó:
// el navegador nunca lo ve antes de tiempo. Datos: colección `libros` (titulo, autor, descripcion, portada, url, requiereRetos, orden, activo).
//  GET  /api/libros                       lista con el estado de cada libro para ti (nunca incluye el enlace)
//  POST /api/libros/:id/enlace            { url, titulo } solo si ya lo desbloqueaste (o eres administrador)
//  GET  /api/admin/libros                 todos, con enlace y estado
//  POST /api/admin/libros                 crear
//  POST /api/admin/libros/:id/actualizar  editar / pausar
//  POST /api/admin/libros/:id/eliminar    borrar
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { esAdminPorToken } = require('./certificados');
const { limpiarTexto } = require('./texto-seguro');

const COL = 'libros', MAX_RETOS = 200;
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const idValido = v => /^[A-Za-z0-9_-]{1,64}$/.test(String(v));
const urlHttps = v => { try { const u = new URL(String(v)); return u.protocol === 'https:' && String(v).length <= 500; } catch (_) { return false; } };

// Limpia y valida lo que manda el panel
function libroLimpio(b, parcial = false) {
  const salida = {};
  const tiene = k => b && b[k] !== undefined;
  if (!parcial || tiene('titulo')) { const t = limpiarTexto(b.titulo, 120); if (t.length < 3) throw errorHttp(400, 'Escribe el título del libro (mínimo 3 letras).'); salida.titulo = t; }
  if (!parcial || tiene('autor')) salida.autor = limpiarTexto(b.autor, 100);
  if (!parcial || tiene('descripcion')) salida.descripcion = limpiarTexto(b.descripcion, 400);
  if (!parcial || tiene('portada')) { const p = String(b.portada || '').trim(); if (p && !(urlHttps(p) || /^assets\/[\w./-]{1,200}$/.test(p))) throw errorHttp(400, 'La portada debe ser un enlace https o una imagen de assets/.'); salida.portada = p; }
  if (!parcial || tiene('url')) { const u = String(b.url || '').trim(); if (!urlHttps(u)) throw errorHttp(400, 'El enlace de lectura debe empezar con https://'); salida.url = u; }
  if (!parcial || tiene('requiereRetos')) { const n = Number(b.requiereRetos); if (!Number.isInteger(n) || n < 1 || n > MAX_RETOS) throw errorHttp(400, 'Los retos requeridos deben ser un entero de 1 a ' + MAX_RETOS + '.'); salida.requiereRetos = n; }
  if (tiene('paginas')) { const n = Number(b.paginas); salida.paginas = Number.isInteger(n) && n > 0 && n < 5000 ? n : 0; }
  if (!parcial || tiene('licencia')) salida.licencia = limpiarTexto(b.licencia, 60);
  if (!parcial || tiene('fuente')) salida.fuente = limpiarTexto(b.fuente, 80);
  if (!parcial || tiene('idioma')) salida.idioma = limpiarTexto(b.idioma, 20);
  if (tiene('licenciaUrl') || !parcial) { const u = String(b.licenciaUrl || '').trim(); if (u && !urlHttps(u)) throw errorHttp(400, 'El enlace de la licencia debe empezar con https://'); salida.licenciaUrl = u; }
  if (tiene('fuenteUrl') || !parcial) { const u = String(b.fuenteUrl || '').trim(); if (u && !urlHttps(u)) throw errorHttp(400, 'El enlace de la fuente debe empezar con https://'); salida.fuenteUrl = u; }
  if (tiene('orden')) { const o = Number(b.orden); salida.orden = Number.isInteger(o) ? Math.min(Math.max(o, 0), 999) : 0; }
  if (tiene('activo')) salida.activo = b.activo === true;
  return salida;
}

// Enlace firmado: base64url(uid.libro.caducidad).hmac. Sin sesión no se puede fabricar ni reutilizar después de 15 minutos.
const LLAVE = () => process.env.LIBROS_KEY || process.env.CERT_SIGNING_KEY || (LLAVE.azar = LLAVE.azar || crypto.randomBytes(32).toString('hex'));
function firmarAcceso(uid, libro, ahora = Date.now()) {
  const carga = Buffer.from([uid, libro, ahora + 15 * 60 * 1000].join('|')).toString('base64url');
  return carga + '.' + crypto.createHmac('sha256', LLAVE()).update(carga).digest('hex');
}
function accesoValido(token, libro, ahora = Date.now()) {
  const [carga, firma] = String(token).split('.');
  if (!carga || !firma) return false;
  const esperada = crypto.createHmac('sha256', LLAVE()).update(carga).digest('hex');
  if (firma.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return false;
  const [, l, caduca] = Buffer.from(carga, 'base64url').toString().split('|');
  return l === libro && Number(caduca) > ahora;
}

// deps: { db, admin, tieneMembresia(miembro) }
function montarRutasLibros(app, deps) {
  const { db, admin } = deps;
  const FieldValue = admin && admin.firestore && admin.firestore.FieldValue;
  const marca = () => (FieldValue && FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date());

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (soloAdmin, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const d = await sesion(req, res); if (!d) return;
      if (soloAdmin && !esAdminPorToken(d)) return res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' });
      await fn(req, res, d);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[libros]', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };
  const miembroDe = async uid => { const s = await db.collection('members').doc(uid).get(); return s.exists ? (s.data() || {}) : null; };
  const retosHechos = async uid => { const s = await db.collection('members').doc(uid).collection('progress').doc('retos').get(); return s.exists ? Object.keys((s.data() || {}).superados || {}).length : 0; };
  const todos = async () => (await db.collection(COL).get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0) || (a.requiereRetos || 0) - (b.requiereRetos || 0) || String(a.titulo).localeCompare(String(b.titulo), 'es'));
  const leer = async id => { if (!idValido(id)) throw errorHttp(400, 'Libro inválido.'); const s = await db.collection(COL).doc(String(id)).get(); if (!s.exists) throw errorHttp(404, 'Ese libro no existe.'); return { id: String(id), ...s.data() }; };

  // Libros base de licencia abierta (data/libros-base.json): se crean una sola vez y después los maneja el administrador
  async function sembrar() {
    let base = []; try { base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'libros-base.json'), 'utf8')).libros || []; } catch (_) { return 0; }
    const existentes = new Set((await db.collection(COL).get()).docs.map(d => d.id));
    let n = 0;
    for (const l of base) if (!existentes.has(l.id)) { const { id, ...resto } = l; await db.collection(COL).doc(id).set({ ...resto, base: true, creadoEn: marca() }); n++; }
    // Como Alintec, cada libro pide más retos que el anterior (5, 10, 15…). Una sola vez, y solo si el administrador no había cambiado el 10 original.
    for (const l of base) {
      if (!existentes.has(l.id)) continue;
      const ref = db.collection(COL).doc(l.id), s = await ref.get(), d = s.exists ? (s.data() || {}) : {};
      if (d.base === true && !d.umbralEscalonado) await ref.set(d.requiereRetos === 10 ? { requiereRetos: l.requiereRetos, umbralEscalonado: true } : { umbralEscalonado: true }, { merge: true });
    }
    return n;
  }
  deps.sembrarLibros = sembrar;

  // ---------- Miembros ----------
  app.get('/api/libros', envolver(false, async (req, res, d) => {
    const m = await miembroDe(d.uid), admin_ = esAdminPorToken(d), membresia = admin_ || !!(m && deps.tieneMembresia(m)), hechos = await retosHechos(d.uid);
    const libros = (await todos()).filter(l => l.activo !== false).map(l => ({ id: l.id, titulo: l.titulo, autor: l.autor || '', descripcion: l.descripcion || '', portada: l.portada || '', licencia: l.licencia || '', licenciaUrl: l.licenciaUrl || '', fuente: l.fuente || '', fuenteUrl: l.fuenteUrl || '', idioma: l.idioma || '', paginas: l.paginas || 0, requiere: l.requiereRetos, desbloqueado: membresia && hechos >= l.requiereRetos, faltan: Math.max(0, l.requiereRetos - hechos) }));
    res.json({ ok: true, membresia, retosHechos: hechos, libros });
  }));
  app.post('/api/libros/:id/enlace', envolver(false, async (req, res, d) => {
    const l = await leer(req.params.id);
    if (l.activo === false && !esAdminPorToken(d)) throw errorHttp(404, 'Ese libro no está disponible.');
    if (!esAdminPorToken(d)) {
      const m = await miembroDe(d.uid);
      if (!(m && deps.tieneMembresia(m))) throw errorHttp(402, 'Los libros son para miembros: activa tu membresía y supera retos para abrirlos.');
      const hechos = await retosHechos(d.uid);
      if (hechos < l.requiereRetos) throw errorHttp(403, 'Te faltan ' + (l.requiereRetos - hechos) + ' reto' + (l.requiereRetos - hechos === 1 ? '' : 's') + ' para abrir este libro.');
    }
    if (l.archivo) { // libro propio (PDF en libros-privados/): se entrega con un enlace firmado que caduca en 15 minutos
      const base = (process.env.API_PUBLICA || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
      return res.json({ ok: true, url: base + '/api/libros/' + encodeURIComponent(l.id) + '/archivo?t=' + firmarAcceso(d.uid, l.id), titulo: l.titulo, propio: true });
    }
    res.json({ ok: true, url: l.url, titulo: l.titulo });
  }));

  // El visor del navegador no puede mandar el token de sesión dentro de un iframe: se usa el enlace firmado de arriba (uid + libro + caducidad)
  app.get('/api/libros/:id/archivo', async (req, res) => {
    try {
      const id = String(req.params.id);
      if (!idValido(id) || !accesoValido(String(req.query.t || ''), id)) return res.status(403).send('Enlace vencido. Vuelve a abrir el libro desde el Club.');
      const l = await leer(id);
      if (!l.archivo || l.activo === false) return res.status(404).send('Libro no disponible.');
      const ruta = path.join(__dirname, '..', 'libros-privados', path.basename(String(l.archivo)));
      if (!fs.existsSync(ruta)) return res.status(404).send('Libro no disponible.');
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="' + id + '.pdf"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(ruta).pipe(res);
    } catch (e) { res.status(e && e.status ? e.status : 500).send('No se pudo abrir el libro.'); }
  });

  // ---------- Administrador ----------
  app.get('/api/admin/libros', envolver(true, async (req, res) => { const lista = await todos(); res.json({ ok: true, libros: lista, total: lista.length, activos: lista.filter(l => l.activo !== false).length }); }));
  app.post('/api/admin/libros', envolver(true, async (req, res) => {
    const b = req.body || {}, l = libroLimpio(b), id = 'lb_' + crypto.randomBytes(5).toString('hex');
    if (l.orden === undefined) l.orden = 0;
    await db.collection(COL).doc(id).set({ ...l, activo: b.activo !== false, creadoEn: marca() });
    res.status(201).json({ ok: true, id });
  }));
  app.post('/api/admin/libros/:id/actualizar', envolver(true, async (req, res) => { const l = await leer(req.params.id); await db.collection(COL).doc(l.id).set(libroLimpio(req.body || {}, true), { merge: true }); res.json({ ok: true }); }));
  app.post('/api/admin/libros/:id/eliminar', envolver(true, async (req, res) => { const l = await leer(req.params.id); await db.collection(COL).doc(l.id).delete(); res.json({ ok: true }); }));
}

module.exports = { montarRutasLibros, libroLimpio, firmarAcceso, accesoValido };
