'use strict';
// DIRECTORIO VIP (adaptado de Alintec y Zoorigen).
//  - La tarjeta (directorio/{uid}) la escribe cada persona desde el Club y la ven todas las cuentas con sesión.
//  - El contacto (WhatsApp, correo, LinkedIn, sitio web, Instagram) vive aparte, en directorioContacto/{uid}, que solo lee el servidor
//    y entrega únicamente a quien tiene membresía vigente (o a un administrador). Así un navegador no puede leer teléfonos de otros.
//  - El servidor dice quién es VIP verificado (membresía vigente) y cuántos certificados reales tiene cada tarjeta publicada.
const { esAdminPorToken } = require('./certificados');

const CAMPOS = { whatsapp: 20, email: 80, linkedin: 120, web: 120, instagram: 60, cedula: 20 };
// La cédula profesional solo se entrega a otros miembros si su dueño marcó "mostrar cédula" (cedulaVisible)
const COL_TARJETAS = 'directorio', COL_CONTACTO = 'directorioContacto', COL_EXTRA = 'directorioExtra';
const CACHE_MS = 60 * 1000;
// Alcance de cada canal de contacto (quién puede verlo): todos los miembros vigentes, solo mis conexiones, o nadie
const ALCANCES = ['miembros', 'conexiones', 'oculto'];
const CANALES_ALCANCE = ['whatsapp', 'email', 'linkedin', 'web', 'instagram'];
// Portada personalizada (VIP): color propio o foto panorámica reducida por el navegador (JPEG, máx. ~180 KB en base64)
const PORTADA_FOTO_MAX = 190000;

function errorHttp(status, mensaje) { const e = new Error(mensaje); e.status = status; return e; }

// Limpia y valida lo que manda el navegador (solo texto, con límites)
function contactoLimpio(body) {
  const salida = {};
  for (const [campo, limite] of Object.entries(CAMPOS)) {
    const valor = String((body && body[campo]) || '').trim().replace(/\s+/g, ' ');
    if (valor.length > limite) throw errorHttp(400, 'El campo ' + campo + ' es demasiado largo.');
    salida[campo] = valor;
  }
  if (salida.whatsapp && !/^[0-9+() -]{8,20}$/.test(salida.whatsapp)) throw errorHttp(400, 'Escribe tu WhatsApp con lada, solo números.');
  if (salida.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(salida.email)) throw errorHttp(400, 'Escribe un correo válido.');
  if (salida.cedula && !/^[A-Za-z0-9 -]{4,20}$/.test(salida.cedula)) throw errorHttp(400, 'Escribe tu cédula solo con letras y números.');
  salida.cedulaVisible = !!(body && (body.cedulaVisible === true || body.cedulaVisible === 'true'));
  const alcances = (body && typeof body.alcances === 'object' && body.alcances) || {};
  salida.alcances = {};
  CANALES_ALCANCE.forEach(c => { salida.alcances[c] = ALCANCES.includes(alcances[c]) ? alcances[c] : 'miembros'; });
  return salida;
}

// ¿Este canal se le entrega a quien mira? (el dueño siempre ve lo suyo; el administrador también)
function canalVisible(alcance, { duenio = false, admin = false, conectado = false } = {}) {
  if (duenio || admin) return true;
  const a = ALCANCES.includes(alcance) ? alcance : 'miembros';
  if (a === 'oculto') return false;
  if (a === 'conexiones') return conectado;
  return true; // 'miembros': cualquier miembro vigente
}

// deps: { db, admin, tieneMembresia(miembro) }
function montarRutasDirectorio(app, deps) {
  const { db, admin } = deps;
  let cache = { t: 0, datos: null };

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { const d = await sesion(req, res); if (d) await fn(req, res, d); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[directorio ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };
  const miembroDe = async uid => { const s = await db.collection('members').doc(uid).get(); return s.exists ? (s.data() || {}) : null; };

  // Tarjetas publicadas, quién tiene membresía vigente, certificados válidos y portadas personalizadas (cada minuto como máximo)
  async function datosPublicos() {
    if (cache.datos && Date.now() - cache.t < CACHE_MS) return cache.datos;
    const sn = await db.collection(COL_TARJETAS).where('publicado', '==', true).limit(300).get();
    const uids = sn.docs.map(d => d.id), vip = [], certificados = {}, portadas = {};
    await Promise.all(uids.map(async uid => {
      const m = await miembroDe(uid);
      if (m && deps.tieneMembresia(m)) vip.push(uid);
      try {
        const cs = await db.collection('certificados').where('uid', '==', uid).get();
        const n = cs.docs.filter(x => { const c = x.data() || {}; return !c.revocado; }).length;
        if (n) certificados[uid] = n;
      } catch (_) { /* sin certificados */ }
      try {
        const ex = await db.collection(COL_EXTRA).doc(uid).get();
        if (ex.exists) { const v = ex.data() || {}; const p = {}; if (v.portadaHex) p.hex = v.portadaHex; if (v.portadaFoto) p.foto = v.portadaFoto; if (Object.keys(p).length) portadas[uid] = p; }
      } catch (_) { /* sin portada personalizada */ }
    }));
    cache = { t: Date.now(), datos: { uids, vip, certificados, portadas } };
    return cache.datos;
  }

  app.get('/api/directorio/meta', envolver('meta', async (req, res, d) => {
    const yo = await miembroDe(d.uid);
    const esAdmin = esAdminPorToken(d);
    const viewerVip = esAdmin || !!(yo && deps.tieneMembresia(yo));
    const base = await datosPublicos();
    const vip = new Set(base.vip);
    if (viewerVip) vip.add(d.uid); else vip.delete(d.uid);
    // Conexiones del que mira: los canales con alcance "solo mis conexiones" solo se entregan a sus conexiones
    let misConexiones = [];
    try { if (deps.conectadosDe) misConexiones = await deps.conectadosDe(d.uid); } catch (_) { /* sin red todavía */ }
    const conectadosSet = new Set(misConexiones);
    const contactos = {};
    if (viewerVip) {
      await Promise.all(base.uids.map(async uid => {
        const c = await db.collection(COL_CONTACTO).doc(uid).get();
        if (!c.exists) return;
        const x = c.data() || {}, al = (x.alcances && typeof x.alcances === 'object') ? x.alcances : {}, util = {};
        const quien = { duenio: uid === d.uid, admin: esAdmin, conectado: conectadosSet.has(uid) };
        Object.keys(CAMPOS).forEach(k => {
          if (!(typeof x[k] === 'string' && x[k])) return;
          if (k === 'cedula') { if (x.cedulaVisible === true) util[k] = x[k]; return; }
          if (canalVisible(al[k], quien)) util[k] = x[k];
        });
        if (Object.keys(util).length) contactos[uid] = util;
      }));
    }
    const mio = await db.collection(COL_CONTACTO).doc(d.uid).get();
    const miContacto = {};
    if (mio.exists) {
      const x = mio.data() || {};
      Object.keys(CAMPOS).forEach(k => { miContacto[k] = typeof x[k] === 'string' ? x[k] : ''; });
      miContacto.cedulaVisible = x.cedulaVisible === true;
      miContacto.alcances = {}; CANALES_ALCANCE.forEach(c => { miContacto.alcances[c] = ALCANCES.includes((x.alcances || {})[c]) ? x.alcances[c] : 'miembros'; });
    }
    // Tarjetas que el equipo ocultó (moderación): el Club no las muestra aunque su dueño las vuelva a publicar
    const ocultas = (await db.collection('directorioModeracion').limit(500).get()).docs.filter(x => (x.data() || {}).oculta === true).map(x => x.id);
    ocultas.forEach(u => { delete contactos[u]; });
    const portadas = {}; Object.keys(base.portadas).forEach(u => { if (!ocultas.includes(u) && vip.has(u)) portadas[u] = base.portadas[u]; });
    res.json({ ok: true, viewerVip, vip: [...vip], certificados: base.certificados, contactos, miContacto, ocultas, portadas, misConexiones });
  }));

  app.post('/api/directorio/contacto', envolver('contacto', async (req, res, d) => {
    const contacto = contactoLimpio(req.body);
    await db.collection(COL_CONTACTO).doc(d.uid).set({ uid: d.uid, ...contacto, actualizadoEn: Date.now() }, { merge: true });
    cache.t = 0;
    res.json({ ok: true, contacto });
  }));

  // Portada personalizada de la tarjeta (solo VIP): color propio o foto panorámica (el navegador la reduce; aquí solo se valida)
  app.post('/api/directorio/portada', envolver('portada', async (req, res, d) => {
    const yo = await miembroDe(d.uid);
    if (!(esAdminPorToken(d) || (yo && deps.tieneMembresia(yo)))) throw errorHttp(403, 'La portada personalizada es un beneficio de la membresía.');
    const b = req.body || {}, ref = db.collection(COL_EXTRA).doc(d.uid);
    if (b.reset === true) { await ref.set({ uid: d.uid, portadaHex: '', portadaFoto: '', actualizadoMs: Date.now() }); cache.t = 0; return res.json({ ok: true, portada: null }); }
    const salida = {};
    if (b.hex !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(b.hex))) throw errorHttp(400, 'Elige un color de portada válido.');
      salida.portadaHex = String(b.hex); salida.portadaFoto = '';
    }
    if (b.fotoDataUrl !== undefined) {
      const f = String(b.fotoDataUrl || '');
      if (f.indexOf('data:image/jpeg;base64,') !== 0 || f.length > PORTADA_FOTO_MAX || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(f)) throw errorHttp(400, 'No pudimos usar esa imagen de portada. Sube otra foto.');
      salida.portadaFoto = f; salida.portadaHex = '';
    }
    if (!Object.keys(salida).length) throw errorHttp(400, 'No hay nada que guardar.');
    await ref.set({ uid: d.uid, ...salida, actualizadoMs: Date.now() }, { merge: true });
    cache.t = 0;
    res.json({ ok: true, portada: { hex: salida.portadaHex || '', foto: salida.portadaFoto ? true : false } });
  }));
}

module.exports = { montarRutasDirectorio, contactoLimpio, canalVisible, CAMPOS, ALCANCES, CANALES_ALCANCE };
