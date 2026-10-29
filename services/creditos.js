'use strict';
// CRÉDITOS y CUPONES (adaptado de Alintec y Zoorigen). Son completamente independientes de los referidos y del XP.
//  - Los créditos son para TODAS las cuentas (con o sin membresía). Se obtienen por regalo del administrador o por un cupón con clave.
//  - 100 créditos canjean UN material descargable del catálogo privado (data/materiales.json). La dirección del archivo
//    solo la entrega el servidor a quien lo canjeó o a quien tiene membresía vigente.
//  - Todo se guarda desde el servidor y dentro de transacciones: el navegador no puede escribir saldo ni canjes (reglas de Firestore).
// Datos: members/{uid}.creditos / creditosCanjeados / creditosAviso · creditos_movimientos/{id} · cuponesCreditos/{CLAVE} (+ /canjes/{uid})
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { esAdminPorToken } = require('./certificados');

const COSTO_POR_DEFECTO = 100;
const MAX_REGALO = 1000;
const MAX_CUPON = 1000;
const MAX_FALLOS_CUPON_POR_HORA = 10;
const COL_MOV = 'creditos_movimientos';
const COL_CUPONES = 'cuponesCreditos';
// Los archivos que viven en el propio Club (assets/...) se guardan con ruta relativa y se completan con la dirección del Club (CLUB_URL)
const urlAbsoluta = u => /^https?:\/\//i.test(String(u || '')) ? u : String(process.env.CLUB_URL || 'https://club.fisioteck.com/').replace(/\/?$/, '/') + String(u || '').replace(/^\//, '');

function errorHttp(status, mensaje) { const e = new Error(mensaje); e.status = status; return e; }

// Materiales libres que el administrador sube desde el panel (colección materialesLibres): se suman a los del archivo
// data/materiales.json y, si comparten id, mandan los del panel. El servidor los refresca cada minuto (ver server.js).
let materialesLibresExtra = [];
function setMaterialesLibres(lista) { materialesLibresExtra = Array.isArray(lista) ? lista : []; }

function leerCatalogo() {
  let base = [], costoBase = COSTO_POR_DEFECTO;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'materiales.json'), 'utf8'));
    if (Number(c.costoPorDefecto) > 0) costoBase = Number(c.costoPorDefecto);
    base = c.materiales || [];
  } catch (_) { /* sin archivo: solo los del panel */ }
  const ids = new Set(materialesLibresExtra.map(m => String(m.id)));
  return [...base.filter(m => !ids.has(String(m.id))), ...materialesLibresExtra]
    .filter(m => !m.retirado && /^[A-Za-z0-9_-]{1,80}$/.test(String(m.id))).map(m => ({ ...m, id: String(m.id), costo: Number(m.costo) > 0 ? Number(m.costo) : costoBase }));
}

// ── Cupones: clave y reglas (puras) ──
const quitarAcentos = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '');
function normalizarClave(valor) { return quitarAcentos(valor).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function claveValida(clave) { return /^[A-Z0-9]{3,30}$/.test(clave); }
function claveAleatoria() {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), b => letras[b % letras.length]).join('');
}
const AUDIENCIAS = ['todos', 'gratuitos', 'miembros'];

// ¿Puede esta persona canjear este cupón ahora? Devuelve null si sí, o { codigo, error }.
function evaluarCupon(cupon, { membresia, ahora = Date.now(), yaCanjeo = false }) {
  if (!cupon) return { codigo: 404, error: 'Ese cupón no existe.' };
  if (cupon.activo === false) return { codigo: 409, error: 'Ese cupón está pausado.' };
  if (cupon.venceMs && ahora > cupon.venceMs) return { codigo: 410, error: 'Ese cupón ya venció.', motivo: 'cupon-vencido' };
  if (cupon.maxUsos && (cupon.usos || 0) >= cupon.maxUsos) return { codigo: 410, error: 'Ese cupón ya se agotó.', motivo: 'cupon-agotado' };
  if (cupon.publico === 'gratuitos' && membresia) return { codigo: 403, error: 'Ese cupón es solo para cuentas sin membresía.' };
  if (cupon.publico === 'miembros' && !membresia) return { codigo: 403, error: 'Ese cupón es solo para miembros.' };
  if (yaCanjeo) return { codigo: 409, error: 'Ya canjeaste este cupón.' };
  return null;
}

// deps: { db, admin, tieneMembresia(miembro) }
const RETOS_POR_DEFECTO = 5; // retos que pide un material libre si no trae `requiereRetos`
function montarRutasCreditos(app, deps) {
  const { db, admin } = deps;
  const fallos = new Map(); // uid -> marcas de tiempo de intentos fallidos de cupón
  const registrarFallo = uid => { const t = Date.now(); const l = (fallos.get(uid) || []).filter(x => t - x < 3600000); l.push(t); fallos.set(uid, l); if (fallos.size > 5000) fallos.clear(); };
  const demasiados = uid => { const t = Date.now(); return (fallos.get(uid) || []).filter(x => t - x < 3600000).length >= MAX_FALLOS_CUPON_POR_HORA; };

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
      if (e && e.status) return res.status(e.status).json(Object.assign({ error: e.message }, e.codigoCupon ? { codigo: e.codigoCupon, limite: e.limite || 0 } : {}));
      console.error('[créditos ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };

  const refMiembro = uid => db.collection('members').doc(uid);
  const miembroDe = async uid => { const s = await refMiembro(uid).get(); return s.exists ? (s.data() || {}) : null; };
  const nuevoId = () => crypto.randomBytes(9).toString('hex');
  const entero = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
  const unlocked = (miembro, id) => !!(miembro && miembro.creditosCanjeados && miembro.creditosCanjeados[id]);
  // Retos superados de la persona (cuentan solo los ids reales de retos)
  const retosHechosDe = async uid => { const s = await db.collection('members').doc(uid).collection('progress').doc('retos').get(); return s.exists ? Object.keys((s.data() || {}).superados || {}).length : 0; };
  const retosPedidos = m => { const n = Number(m.requiereRetos); return Number.isInteger(n) && n >= 1 && n <= 200 ? n : RETOS_POR_DEFECTO; };
  // Material gratuito: se abre con CRÉDITOS (cualquier cuenta) o con RETOS (solo miembros con membresía vigente). La membresía sola no lo abre.
  const abiertoPorRetos = (m, membresia, hechos) => !!membresia && hechos >= retosPedidos(m);
  const vistaMaterial = (m, miembro, membresia, hechos) => ({ id: m.id, titulo: m.titulo, desc: m.desc, tipo: m.tipo, thumbnail: m.thumbnail || '', costo: m.costo, desbloqueado: unlocked(miembro, m.id),
    requiereRetos: retosPedidos(m), abiertoPorRetos: abiertoPorRetos(m, membresia, hechos), incluidoEnMembresia: abiertoPorRetos(m, membresia, hechos), faltanRetos: Math.max(0, retosPedidos(m) - hechos) });

  // ---------- Socio / cuenta gratuita ----------
  app.get('/api/creditos', envolver('estado', false, async (req, res, d) => {
    const esAdm = esAdminPorToken(d);
    const miembro = (await miembroDe(d.uid)) || (esAdm ? {} : null);
    if (!miembro) throw errorHttp(403, 'Completa tu registro gratuito para continuar.');
    const membresia = esAdm || deps.tieneMembresia(miembro), hechos = await retosHechosDe(d.uid);
    res.json({
      saldo: miembro.creditos || 0, costo: COSTO_POR_DEFECTO, membresia, retosHechos: hechos,
      // El administrador ve TODOS los materiales desbloqueados (solo él: ninguna cuenta de miembro recibe esto)
      materiales: leerCatalogo().map(m => esAdm ? { ...vistaMaterial(m, miembro, true, 9999), desbloqueado: true, abiertoPorRetos: true, incluidoEnMembresia: true, faltanRetos: 0 } : vistaMaterial(m, miembro, membresia, hechos)),
      aviso: miembro.creditosAviso && !miembro.creditosAviso.visto ? { cantidad: miembro.creditosAviso.cantidad, mensaje: miembro.creditosAviso.mensaje || '', ms: miembro.creditosAviso.ms } : null
    });
  }));

  app.post('/api/creditos/aviso-visto', envolver('aviso', false, async (req, res, d) => {
    const miembro = await miembroDe(d.uid);
    if (miembro && miembro.creditosAviso) await refMiembro(d.uid).set({ creditosAviso: { ...miembro.creditosAviso, visto: true } }, { merge: true });
    res.json({ ok: true });
  }));

  app.post('/api/creditos/canjear', envolver('canjear', false, async (req, res, d) => {
    const id = String((req.body || {}).materialId || '');
    const mat = leerCatalogo().find(m => m.id === id);
    if (!mat) throw errorHttp(404, 'Ese material no existe.');
    const ref = refMiembro(d.uid);
    const mi = await miembroDe(d.uid);
    if (mi && !unlocked(mi, id) && abiertoPorRetos(mat, deps.tieneMembresia(mi), await retosHechosDe(d.uid))) throw errorHttp(409, 'Ya puedes abrir este material con tus retos: no necesitas gastar créditos.');
    const r = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw errorHttp(403, 'Completa tu registro gratuito para continuar.');
      const m = snap.data() || {};
      if (unlocked(m, id)) return { saldo: m.creditos || 0, yaTenia: true };
      const saldo = m.creditos || 0;
      if (saldo < mat.costo) throw errorHttp(402, 'Te faltan ' + (mat.costo - saldo) + ' créditos para este material.');
      const nuevo = saldo - mat.costo;
      tx.set(ref, { creditos: nuevo, creditosCanjeados: { ...(m.creditosCanjeados || {}), [id]: Date.now() } }, { merge: true });
      tx.set(db.collection(COL_MOV).doc(nuevoId()), { tipo: 'canje', uid: d.uid, email: d.email || '', cantidad: -mat.costo, saldoDespues: nuevo, materialId: id, ms: Date.now() });
      return { saldo: nuevo, yaTenia: false };
    });
    res.json({ ok: true, ...r, materialId: id });
  }));

  // Entrega del archivo: solo quien lo canjeó, quien tiene membresía vigente o un administrador
  app.get('/api/materiales/:id/enlace', envolver('enlace', false, async (req, res, d) => {
    const mat = leerCatalogo().find(m => m.id === String(req.params.id));
    if (!mat || !mat.url) throw errorHttp(404, 'Ese material no está disponible.');
    const miembro = await miembroDe(d.uid);
    if (!miembro) throw errorHttp(403, 'Completa tu registro gratuito para continuar.');
    if (!(unlocked(miembro, mat.id) || esAdminPorToken(d) || abiertoPorRetos(mat, deps.tieneMembresia(miembro), await retosHechosDe(d.uid)))) throw errorHttp(402, deps.tieneMembresia(miembro) ? 'Supera ' + retosPedidos(mat) + ' retos o canjéalo con créditos.' : 'Canjéalo con créditos. Con membresía también se desbloquea superando retos.');
    if (deps.registrarEventoLogro && /^pdf-/.test(mat.id)) deps.registrarEventoLogro(d.uid, 'pdf', mat.id);
    res.json({ url: urlAbsoluta(mat.url), titulo: mat.titulo });
  }));

  // ---------- Cupones ----------
  // Tarjeta "Hay un cupón para ti": NUNCA revela la clave; solo cuántos créditos y hasta cuándo.
  app.get('/api/creditos/cupon-activo', envolver('cupon-activo', false, async (req, res, d) => {
    const miembro = await miembroDe(d.uid);
    if (!miembro) return res.json({ hay: false });
    const membresia = deps.tieneMembresia(miembro);
    const sn = await db.collection(COL_CUPONES).where('activo', '==', true).limit(50).get();
    const ahora = Date.now();
    for (const x of sn.docs.map(y => y.data()).sort((a, b) => (b.creadoMs || 0) - (a.creadoMs || 0))) {
      const yaCanjeo = (await db.collection(COL_CUPONES).doc(x.clave).collection('canjes').doc(d.uid).get()).exists;
      if (!evaluarCupon({ ...x, maxUsos: 0 }, { membresia, ahora, yaCanjeo })) return res.json({ hay: true, creditos: x.creditos, venceMs: x.venceMs || null, agotado: !!(x.maxUsos && (x.usos || 0) >= x.maxUsos) });
    }
    res.json({ hay: false });
  }));

  // Aviso del Inicio (como Zoorigen): cuántos cupones hay para esta persona, sin revelar nunca la clave. "ids" son identificadores internos, no claves.
  app.get('/api/creditos/cupon-disponible', envolver('cupon-disponible', false, async (req, res, d) => {
    const miembro = await miembroDe(d.uid);
    if (!miembro || esAdminPorToken(d)) return res.json({ hay: false });
    const membresia = deps.tieneMembresia(miembro), ahora = Date.now();
    const sn = await db.collection(COL_CUPONES).where('activo', '==', true).limit(50).get();
    const libres = [];
    for (const x of sn.docs.map(y => y.data())) {
      const yaCanjeo = (await db.collection(COL_CUPONES).doc(x.clave).collection('canjes').doc(d.uid).get()).exists;
      if (!evaluarCupon({ ...x, maxUsos: 0 }, { membresia, ahora, yaCanjeo })) libres.push(x);
    }
    if (!libres.length) return res.json({ hay: false });
    res.json({ hay: true, cantidad: libres.length, creditos: Math.max(...libres.map(x => x.creditos || 0)), limitado: libres.some(x => x.maxUsos || x.venceMs), agotado: libres.every(x => x.maxUsos && (x.usos || 0) >= x.maxUsos), ids: libres.map(x => String(x.creadoMs || 0)) });
  }));

  app.post('/api/creditos/cupon', envolver('cupon', false, async (req, res, d) => {
    if (demasiados(d.uid)) throw errorHttp(429, 'Demasiados intentos. Prueba de nuevo en una hora.');
    if (d.email_verified !== true) throw errorHttp(403, 'Confirma tu correo para canjear cupones.');
    const clave = normalizarClave((req.body || {}).clave || '');
    if (!claveValida(clave)) { registrarFallo(d.uid); throw errorHttp(400, 'Escribe una clave válida.'); }
    const refCupon = db.collection(COL_CUPONES).doc(clave), refMi = refMiembro(d.uid);
    const refCanje = refCupon.collection('canjes').doc(d.uid);
    let r;
    try {
      r = await db.runTransaction(async tx => {
        const [cs, ms, ys] = await Promise.all([tx.get(refCupon), tx.get(refMi), tx.get(refCanje)]);
        if (!ms.exists) throw errorHttp(403, 'Completa tu registro gratuito para continuar.');
        const cupon = cs.exists ? cs.data() : null, miembro = ms.data() || {};
        const neg = evaluarCupon(cupon, { membresia: deps.tieneMembresia(miembro), yaCanjeo: ys.exists });
        if (neg) { const e = errorHttp(neg.codigo, neg.error); e.cuentaFallo = neg.codigo === 404; if (neg.motivo) { e.codigoCupon = neg.motivo; e.limite = cupon && cupon.maxUsos || 0; } throw e; }
        const nuevo = (miembro.creditos || 0) + cupon.creditos;
        tx.set(refMi, { creditos: nuevo }, { merge: true });
        tx.set(refCanje, { uid: d.uid, email: d.email || '', creditos: cupon.creditos, ms: Date.now() });
        tx.set(refCupon, { usos: (cupon.usos || 0) + 1, entregados: (cupon.entregados || 0) + cupon.creditos }, { merge: true });
        tx.set(db.collection(COL_MOV).doc(nuevoId()), { tipo: 'cupon', uid: d.uid, email: d.email || '', cantidad: cupon.creditos, saldoDespues: nuevo, cupon: clave, ms: Date.now() });
        return { creditos: cupon.creditos, saldo: nuevo };
      });
    } catch (e) { if (e && (e.cuentaFallo || e.status === 400)) registrarFallo(d.uid); throw e; }
    res.json({ ok: true, ...r });
  }));

  // ---------- Administrador ----------
  async function socioPorUidOCorreo(uid, email) {
    if (uid) { const m = await miembroDe(String(uid)); return m ? { uid: String(uid), ...m } : null; }
    if (email) { const q = await db.collection('members').where('email', '==', String(email).trim().toLowerCase()).limit(1).get(); return q.docs.length ? { uid: q.docs[0].id, ...q.docs[0].data() } : null; }
    return null;
  }

  app.post('/api/admin/creditos/regalar', envolver('regalar', true, async (req, res, d) => {
    const { uid, email, cantidad, mensaje } = req.body || {};
    const n = entero(cantidad, 1, MAX_REGALO);
    if (!n) throw errorHttp(400, 'La cantidad debe ser un entero de 1 a ' + MAX_REGALO + '.');
    const socio = await socioPorUidOCorreo(uid, email);
    if (!socio) throw errorHttp(404, 'No se encontró esa cuenta.');
    const texto = String(mensaje || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const ref = refMiembro(socio.uid);
    const r = await db.runTransaction(async tx => {
      const snap = await tx.get(ref), m = snap.data() || {};
      const nuevo = (m.creditos || 0) + n;
      tx.set(ref, { creditos: nuevo, creditosAviso: { cantidad: n, mensaje: texto, ms: Date.now(), visto: false } }, { merge: true });
      tx.set(db.collection(COL_MOV).doc(nuevoId()), { tipo: 'regalo', uid: socio.uid, email: socio.email || '', cantidad: n, saldoDespues: nuevo, por: d.email, mensaje: texto, ms: Date.now() });
      return { saldo: nuevo };
    });
    res.json({ ok: true, uid: socio.uid, ...r });
  }));

  app.get('/api/admin/creditos', envolver('resumen', true, async (req, res) => {
    const sn = await db.collection(COL_MOV).orderBy('ms', 'desc').limit(300).get();
    const movs = sn.docs.map(x => x.data());
    const porMaterial = {};
    movs.filter(m => m.tipo === 'canje').forEach(m => { porMaterial[m.materialId] = (porMaterial[m.materialId] || 0) + 1; });
    const titulos = Object.fromEntries(leerCatalogo().map(m => [m.id, m.titulo]));
    res.json({
      regalados: movs.filter(m => m.tipo === 'regalo').reduce((t, m) => t + m.cantidad, 0),
      porCupon: movs.filter(m => m.tipo === 'cupon').reduce((t, m) => t + m.cantidad, 0),
      canjeados: movs.filter(m => m.tipo === 'canje').reduce((t, m) => t - m.cantidad, 0),
      canjesPorMaterial: Object.entries(porMaterial).map(([id, n]) => ({ id, titulo: titulos[id] || id, n })).sort((a, b) => b.n - a.n),
      movimientos: movs.slice(0, 100)
    });
  }));

  app.get('/api/admin/creditos/cupones', envolver('cupones', true, async (req, res) => {
    const sn = await db.collection(COL_CUPONES).limit(200).get();
    res.json({ cupones: sn.docs.map(x => x.data()).sort((a, b) => (b.creadoMs || 0) - (a.creadoMs || 0)) });
  }));

  app.post('/api/admin/creditos/cupones', envolver('crear-cupon', true, async (req, res, d) => {
    const { clave: claveIn, creditos, venceMs, maxUsos, publico } = req.body || {};
    const n = entero(creditos, 1, MAX_CUPON);
    if (!n) throw errorHttp(400, 'Los créditos deben ser un entero de 1 a ' + MAX_CUPON + '.');
    const clave = claveIn ? normalizarClave(claveIn) : claveAleatoria();
    if (!claveValida(clave)) throw errorHttp(400, 'La clave debe tener de 3 a 30 letras o números.');
    const aud = AUDIENCIAS.includes(publico) ? publico : 'todos';
    let vence = null;
    if (venceMs !== undefined && venceMs !== null && venceMs !== '') { vence = Number(venceMs); if (!Number.isFinite(vence) || vence < Date.now()) throw errorHttp(400, 'La fecha de vencimiento ya pasó.'); }
    let max = null;
    if (maxUsos !== undefined && maxUsos !== null && maxUsos !== '') { max = entero(maxUsos, 1, 100000); if (!max) throw errorHttp(400, 'El cupo debe ser un entero positivo.'); }
    const ref = db.collection(COL_CUPONES).doc(clave);
    if ((await ref.get()).exists) throw errorHttp(409, 'Ya existe un cupón con esa clave.');
    const cupon = { clave, creditos: n, venceMs: vence, maxUsos: max, publico: aud, usos: 0, entregados: 0, activo: true, creadoMs: Date.now(), creadoPor: d.email };
    await ref.set(cupon);
    res.status(201).json({ cupon });
  }));

  app.post('/api/admin/creditos/cupones/:clave/estado', envolver('estado-cupon', true, async (req, res) => {
    const ref = db.collection(COL_CUPONES).doc(normalizarClave(req.params.clave));
    if (!(await ref.get()).exists) throw errorHttp(404, 'Ese cupón no existe.');
    await ref.set({ activo: (req.body || {}).activo === true }, { merge: true });
    res.json({ ok: true });
  }));

  app.get('/api/admin/creditos/cupones/:clave/canjes', envolver('canjes', true, async (req, res) => {
    const sn = await db.collection(COL_CUPONES).doc(normalizarClave(req.params.clave)).collection('canjes').limit(500).get();
    res.json({ canjes: sn.docs.map(x => x.data()).sort((a, b) => (b.ms || 0) - (a.ms || 0)) });
  }));
}

module.exports = { montarRutasCreditos, normalizarClave, claveValida, claveAleatoria, evaluarCupon, leerCatalogo, setMaterialesLibres, COSTO_POR_DEFECTO };
