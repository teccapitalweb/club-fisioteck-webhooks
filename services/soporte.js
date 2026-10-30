'use strict';
// SOPORTE: quejas, sugerencias, problemas y preguntas de los miembros. Llegan al panel del administrador (no a un número de WhatsApp).
//   POST   /api/soporte                    { tipo, asunto, mensaje, pagina }   el miembro envía un reporte (límite por hora y por día)
//   GET    /api/soporte/mios               sus reportes con el estado y la respuesta del equipo
//   GET    /api/admin/soporte              todos los reportes (más nuevos primero) + conteos
//   POST   /api/admin/soporte/:id          { estado, respuesta }  cambia el estado y/o responde (el miembro recibe un aviso en la campana)
//   DELETE /api/admin/soporte/:id          borra un reporte
// Todo se valida aquí; las reglas de Firestore no dejan que nadie escriba en `soporte` desde el navegador.
const { esAdminPorToken } = require('./certificados');

const TIPOS = ['queja', 'sugerencia', 'problema', 'pregunta', 'otro'];
const ESTADOS = ['nuevo', 'revision', 'resuelto'];
const POR_HORA = 5, POR_DIA = 12, MAX_ASUNTO = 100, MAX_MENSAJE = 2000, MAX_RESPUESTA = 1500;
const limpiar = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const idValido = v => /^[A-Za-z0-9_-]{1,128}$/.test(String(v));

function validarReporte(b) {
  b = b && typeof b === 'object' ? b : {};
  const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'otro', asunto = limpiar(b.asunto, MAX_ASUNTO), mensaje = limpiar(b.mensaje, MAX_MENSAJE);
  if (mensaje.length < 10) return { error: 'Cuéntanos con un poco más de detalle (al menos 10 letras).' };
  return { reporte: { tipo, asunto: asunto || (mensaje.slice(0, 60) + (mensaje.length > 60 ? '…' : '')), mensaje, pagina: limpiar(b.pagina, 40) } };
}

function montarRutasSoporte(app, deps) {
  const { db, admin } = deps;
  const ahora = deps.ahora || (() => Date.now());
  const col = () => db.collection('soporte');

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); } catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (etiqueta, soloAdmin, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const d = await sesion(req, res); if (!d) return;
      if (soloAdmin && !esAdminPorToken(d)) return res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' });
      await fn(req, res, d);
    } catch (e) { if (e && e.status) return res.status(e.status).json({ error: e.message }); console.error('[soporte ' + etiqueta + ']', e && e.message); res.status(500).json({ error: 'No se pudo completar la operación.' }); }
  };
  const publico = (id, v) => ({ id, tipo: v.tipo, asunto: v.asunto, mensaje: v.mensaje, estado: v.estado, creadoMs: v.creadoMs, respuesta: v.respuesta || '', respondidoMs: v.respondidoMs || 0 });

  app.post('/api/soporte', envolver('crear', false, async (req, res, d) => {
    const r = validarReporte(req.body); if (r.error) throw errorHttp(400, r.error);
    const t = ahora(), previos = (await col().where('uid', '==', d.uid).get()).docs.map(x => (x.data() || {}).creadoMs || 0);
    if (previos.filter(ms => t - ms < 3600000).length >= POR_HORA) throw errorHttp(429, 'Enviaste varios reportes en poco tiempo. Espera un rato y vuelve a intentar.');
    if (previos.filter(ms => t - ms < 86400000).length >= POR_DIA) throw errorHttp(429, 'Llegaste al límite de reportes de hoy. Mañana puedes enviar más.');
    let nombre = ''; try { const m = await db.collection('members').doc(d.uid).get(); nombre = limpiar((m.exists ? (m.data() || {}).name : '') || d.name || '', 80); } catch (_) { /* sin ficha */ }
    const doc = { uid: d.uid, email: String(d.email || '').slice(0, 160), nombre, ...r.reporte, estado: 'nuevo', creadoMs: t, creado: new Date(t).toISOString(), respuesta: '', respondidoMs: 0 };
    const id = require('crypto').randomBytes(10).toString('hex');
    await col().doc(id).set(doc);
    res.json({ ok: true, id });
  }));
  app.get('/api/soporte/mios', envolver('mios', false, async (req, res, d) => {
    const sn = await col().where('uid', '==', d.uid).get();
    res.json({ ok: true, reportes: sn.docs.map(x => publico(x.id, x.data() || {})).sort((a, b) => b.creadoMs - a.creadoMs).slice(0, 20) });
  }));

  app.get('/api/admin/soporte', envolver('listar', true, async (req, res) => {
    const sn = await col().orderBy('creadoMs', 'desc').limit(300).get();
    const lista = sn.docs.map(x => ({ id: x.id, ...(x.data() || {}) }));
    const conteo = { total: lista.length, nuevo: 0, revision: 0, resuelto: 0 }; lista.forEach(x => { if (conteo[x.estado] !== undefined) conteo[x.estado]++; });
    res.json({ ok: true, conteo, reportes: lista });
  }));
  app.post('/api/admin/soporte/:id', envolver('actualizar', true, async (req, res, d) => {
    if (!idValido(req.params.id)) throw errorHttp(400, 'Datos inválidos.');
    const ref = col().doc(req.params.id), s = await ref.get(); if (!s.exists) throw errorHttp(404, 'Ese reporte ya no existe.');
    const v = s.data() || {}, b = req.body || {}, cambios = {};
    if (b.estado !== undefined) { if (!ESTADOS.includes(b.estado)) throw errorHttp(400, 'Estado no válido.'); cambios.estado = b.estado; }
    let respondio = false;
    if (b.respuesta !== undefined) {
      const texto = limpiar(b.respuesta, MAX_RESPUESTA);
      if (texto && texto !== v.respuesta) { cambios.respuesta = texto; cambios.respondidoMs = ahora(); cambios.respondidoPor = String(d.email || ''); if (!cambios.estado && v.estado === 'nuevo') cambios.estado = 'revision'; respondio = true; }
    }
    if (!Object.keys(cambios).length) throw errorHttp(400, 'No hay nada que guardar.');
    await ref.set(cambios, { merge: true });
    if (respondio && v.uid) { try { await require('./avisos').crearAviso(db, v.uid, 'soporte_' + req.params.id + '_' + cambios.respondidoMs, { tipo: 'sistema', titulo: 'Respondimos tu reporte', texto: cambios.respuesta, pagina: 'account' }); } catch (_) { /* el aviso es un extra */ } }
    res.json({ ok: true });
  }));
  app.delete('/api/admin/soporte/:id', envolver('borrar', true, async (req, res) => {
    if (!idValido(req.params.id)) throw errorHttp(400, 'Datos inválidos.');
    await col().doc(req.params.id).delete();
    res.json({ ok: true });
  }));
}

module.exports = { montarRutasSoporte, validarReporte, TIPOS, ESTADOS };
