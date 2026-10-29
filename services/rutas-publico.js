'use strict';
// Rutas PÚBLICAS de la portada (sin sesión) y su lectura en el panel de administración.
//   POST /api/encuesta                   copia parcial o completa de la encuesta (anónima; el número de WhatsApp es opcional y exige aceptar el aviso)
//   POST /api/chatbot/sin-respuesta      pregunta que la Guía no supo contestar (sin correos, teléfonos ni enlaces)
//   POST /api/visita                     contador anónimo de visitas (dispositivo, país, origen, hora); siempre responde 204
//   GET  /api/admin/encuesta             resumen de la encuesta y prospectos (solo administradores)
//   GET  /api/admin/chatbot/sin-respuesta preguntas sin respuesta (solo administradores)
//   GET  /api/admin/visitas?periodo=hoy  registro de visitas · GET /api/admin/metricas?dias=84  métricas por día (solo administradores)
// Límites por IP en memoria (la IP nunca se guarda). Colecciones solo del servidor: encuestasProspectos, chatbotSinRespuesta, visitasDiarias.
const crypto = require('crypto');
const E = require('./encuesta');
const V = require('./visitas');
const { esAdminPorToken } = require('./certificados');

const LIMITES = { encuesta: [30, 3600000], sinRespuesta: [30, 3600000], visitas: [120, 600000], global: [3000, 3600000] };

function montarRutasPublico(app, deps) {
  const { db, admin } = deps;
  const FieldValue = admin && admin.firestore && admin.firestore.FieldValue;
  const usos = new Map();
  const dentroDelLimite = (clave, [max, ventana]) => {
    const t = Date.now();
    const lista = (usos.get(clave) || []).filter(x => t - x < ventana);
    if (lista.length >= max) { usos.set(clave, lista); return false; }
    lista.push(t); usos.set(clave, lista);
    if (usos.size > 20000) usos.clear();
    return true;
  };
  const ipDe = req => { const h = req.headers['x-forwarded-for']; return String(Array.isArray(h) ? h[0] : (h || '')).split(',')[0].trim() || req.ip || 'desconocida'; };
  const limitarPublico = (req, res, tipo) => {
    if (!dentroDelLimite(tipo + ':' + ipDe(req), LIMITES[tipo]) || !dentroDelLimite(tipo + ':global', LIMITES.global)) {
      res.status(429).json({ error: 'Demasiadas solicitudes. Intenta más tarde.' }); return false;
    }
    return true;
  };
  async function sesionAdmin(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    let d; try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
    if (!esAdminPorToken(d)) { res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' }); return null; }
    return d;
  }
  const soloAdmin = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { if (await sesionAdmin(req, res)) await fn(req, res); }
    catch (e) { console.error('[público admin]', req.path, e && e.message); res.status(500).json({ error: 'No se pudo completar la operación.' }); }
  };

  // ----- Encuesta -----
  app.post('/api/encuesta', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!limitarPublico(req, res, 'encuesta')) return;
      const r = E.validarEncuesta(req.body);
      if (!r.ok) return res.status(400).json({ error: r.error });
      if (r.ignorar) return res.json({ ok: true });
      // Varias copias de la misma sesión son normales (parcial y completa): el panel las junta.
      await db.collection('encuestasProspectos').doc(crypto.randomUUID()).set({ ...r.valor, creadoMs: Date.now() });
      res.json({ ok: true });
    } catch (e) { console.error('[encuesta]', e && e.message); res.status(500).json({ error: 'No se pudo guardar tu respuesta.' }); }
  });

  // ----- Preguntas sin respuesta de la guía -----
  app.post('/api/chatbot/sin-respuesta', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!limitarPublico(req, res, 'sinRespuesta')) return;
      const r = E.validarSinRespuesta(req.body);
      if (!r.ok) return res.status(400).json({ error: r.error });
      if (r.ignorar) return res.json({ ok: true });
      const ref = db.collection('chatbotSinRespuesta').doc(r.valor.clave);
      await db.runTransaction(async tx => {
        const actual = await tx.get(ref);
        tx.set(ref, E.combinarSinRespuesta(actual.exists ? actual.data() : null, r.valor, Date.now()));
      });
      res.json({ ok: true });
    } catch (e) { console.error('[sin-respuesta]', e && e.message); res.status(500).json({ error: 'No se pudo guardar la pregunta.' }); }
  });

  // ----- Visitas: contador anónimo y sin cookies (como Alintec); nunca estorba: siempre 204 -----
  // Cuenta visitas, personas distintas del día (HMAC diario de IP + navegador, sin guardar ninguno), dispositivo, país, origen (Facebook,
  // Instagram, Google…) y hora. Quien administra no cuenta. Respeta «No rastrear». Se puede apagar en Configuración (config/club.contadorVisitas = false).
  const claveVisitas = () => crypto.createHmac('sha256', process.env.CERT_SIGNING_KEY || 'fisioteck-sin-llave').update('metricas-visitas').digest('hex');
  let banderaVisitas = { t: 0, v: true };
  async function contadorEncendido() {
    const cache = process.env.VISITAS_CACHE_MS !== undefined && Number(process.env.VISITAS_CACHE_MS) >= 0 ? Number(process.env.VISITAS_CACHE_MS) : 60000;
    if (Date.now() - banderaVisitas.t < cache) return banderaVisitas.v;
    try { const s = await db.collection('config').doc('club').get(); banderaVisitas = { t: Date.now(), v: !(s.exists && s.data().contadorVisitas === false) }; }
    catch (_) { banderaVisitas = { t: Date.now(), v: true }; }
    return banderaVisitas.v;
  }
  app.post('/api/visita', async (req, res) => {
    try {
      if (E.visitaNoRastreable(req.headers)) return res.status(204).end();
      const ipVisita = V.ipDeSolicitud(req.headers, req.ip);
      if (!dentroDelLimite('visitas:' + ipVisita, LIMITES.visitas) || !dentroDelLimite('visitas:global', LIMITES.global)) return res.status(204).end();
      if (!(await contadorEncendido())) return res.status(204).end();
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
      b = b && typeof b === 'object' ? b : {};
      let miembro = null;
      const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (m) {
        try {
          const d = await admin.auth().verifyIdToken(m[1]);
          if (esAdminPorToken(d)) return res.status(204).end(); // quien administra no cuenta como visita
          if (d.email_verified === true && d.email) miembro = { uid: d.uid, email: d.email, nombre: d.name || String(d.email).split('@')[0] };
        } catch (_) { /* sesión vencida: se cuenta como visita anónima */ }
      }
      const resultado = await V.registrarVisita(db, FieldValue, {
        pagina: String(b.pagina || ''), referrer: String(b.ref || '').slice(0, 300), utm: String(b.utm || '').slice(0, 40),
        fbclid: b.fbclid === true, igshid: b.igshid === true, ip: ipVisita, pais: V.paisDeIp(ipVisita), userAgent: req.headers['user-agent'], secreto: claveVisitas(), miembro,
        origen: b.origen && typeof b.origen === 'object' ? { ref: String(b.origen.ref || '').slice(0, 300), utm: String(b.origen.utm || '').slice(0, 40), ua: String(b.origen.ua || '').slice(0, 300), t: Number(b.origen.t) || 0, fb: b.origen.fb === true, ig: b.origen.ig === true } : null,
        obtenerCreada: async () => { const u = await admin.auth().getUser(miembro.uid); return Date.parse(u && u.metadata && u.metadata.creationTime) || null; }
      });
      if (resultado && resultado.contada) V.marcarVisitaOk();
    } catch (e) { V.marcarVisitaError(e); console.error('[visitas] no se registró la visita:', e && e.message); }
    res.status(204).end();
  });

  // ----- Administrador -----
  app.get('/api/admin/encuesta', soloAdmin(async (req, res) => {
    const sn = await db.collection('encuestasProspectos').orderBy('creadoMs', 'desc').limit(2000).get();
    res.json(E.resumirEncuesta(sn.docs.map(d => d.data())));
  }));
  app.get('/api/admin/chatbot/sin-respuesta', soloAdmin(async (req, res) => {
    const sn = await db.collection('chatbotSinRespuesta').limit(500).get();
    res.json({ preguntas: sn.docs.map(d => d.data()).sort((a, b) => b.veces - a.veces || b.ultimaMs - a.ultimaMs).map(p => ({ texto: p.ejemplo, veces: p.veces, ultimaMs: p.ultimaMs })) });
  }));
  // Registro de visitas por periodo (hoy, ayer, 7 o 30 días): cada visita se guarda sola al ocurrir
  app.get('/api/admin/visitas', soloAdmin(async (req, res) => {
    const datos = await V.leerRegistroVisitas(db, { periodo: String(req.query.periodo || 'hoy') });
    res.json({ ok: true, encendido: await contadorEncendido(), ...datos });
  }));
  // Métricas por día: visitas, personas distintas, dispositivos, países, origen, horas, miembros que entraron y de dónde llegaron las cuentas
  app.get('/api/admin/metricas', soloAdmin(async (req, res) => {
    const datos = await V.leerMetricas(db, { dias: req.query.dias }, { esMiembro: deps.tieneMembresia });
    res.json({ ok: true, encendido: await contadorEncendido(), ...datos });
  }));
}

module.exports = { montarRutasPublico };
