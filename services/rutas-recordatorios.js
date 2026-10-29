'use strict';
// RUTAS: recordatorios de pago (baja, cupón de la persona, preferencia y panel de administración)
// Públicas (la firma del enlace es la prueba):
//   GET  /baja-recordatorios?u=<uid>&t=<firma>   página de confirmación (NO da de baja: los lectores de correo abren los enlaces)
//   POST /baja-recordatorios?u=<uid>&t=<firma>   da de baja (el botón de la página y el «un clic» de Gmail/Yahoo)
// Con sesión de Firebase:
//   GET  /api/recordatorios/mi-cupon             el cupón vigente de ESTA cuenta (o null)
//   GET/POST /api/recordatorios/preferencia      { recibe } · el interruptor de Mi perfil
// Administración (correo verificado de ADMIN_EMAILS):
//   GET  /api/admin/recordatorios                interruptor, envíos de hoy, próximos envíos, conteos y estadísticas
//   GET  /api/admin/recordatorios/lista          tabla por persona con búsqueda y filtro por etapa
//   POST /api/admin/recordatorios/modo           { modo: 'activo' | 'apagado', confirmo: true }
//   POST /api/admin/recordatorios/limites        { topeDiario, maxPorCorrida }
//   POST /api/admin/recordatorios/ensayo         quién recibiría qué correo ahora (sin enviar ni crear cupones)
//   POST /api/admin/recordatorios/prueba         { paso: 1..7 | 'todos', ciclo? } manda a quien administra un correo de prueba
const express = require('express');
const R = require('./recordatorios-pago');
const C = require('./recordatorios-correo');
const { esAdminPorToken } = require('./certificados');
const { ventana } = require('./rutas-auth');

const esc = C.esc;
const UID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;
const AZUL = '#0D5FA0';

function pagina(titulo, cuerpoHtml, estado = 200) {
  return { estado, html: `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex,nofollow">
<title>${esc(titulo)} · FisioTeck</title></head>
<body style="margin:0;background:#EEF3F8;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#0B1A30;">
  <div style="max-width:480px;margin:40px auto;padding:0 14px;">
    <div style="background:#FFFFFF;border:1px solid #D8E3EE;border-radius:16px;overflow:hidden;">
      <div style="background:#0B3A66;padding:22px 24px;text-align:center;border-bottom:4px solid #159E92;">
        <img src="${C.URL_LOGO}" width="64" height="64" alt="FisioTeck" style="display:block;margin:0 auto 8px;border-radius:50%;border:2px solid #FFFFFF;">
        <div style="font-size:22px;font-weight:800;color:#FFFFFF;">FisioTeck</div>
      </div>
      <div style="padding:26px 24px;">${cuerpoHtml}</div>
    </div>
    <p style="font-size:12px;line-height:1.6;color:#7C8DA0;text-align:center;margin:14px 0 0;">FisioTeck · <a href="${C.URL_AVISO}" style="color:#5B6E82;">Aviso de privacidad</a></p>
  </div>
</body></html>` };
}
const paginaInvalida = () => pagina('Enlace no válido', '<h1 style="margin:0 0 10px;font-size:21px;">Enlace no válido</h1><p style="margin:0;font-size:15px;line-height:1.6;color:#33475B;">Este enlace de baja no es válido o está incompleto. Si quieres dejar de recibir promociones, escríbenos a ' + esc(C.CORREO_CONTACTO) + ' y lo hacemos por ti.</p>', 400);
const paginaConfirmar = (uid, firma) => pagina('Darte de baja',
  `<h1 style="margin:0 0 10px;font-size:21px;">¿Ya no quieres recibir promociones?</h1>
   <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#33475B;">Si confirmas, dejaremos de enviarte recordatorios y promociones sobre la membresía, incluidos los códigos de descuento. Tu cuenta y los servicios del Club no cambian.</p>
   <form method="POST" action="/baja-recordatorios?u=${encodeURIComponent(uid)}&amp;t=${encodeURIComponent(firma)}"><button type="submit" style="border:0;background:${AZUL};color:#FFFFFF;font-size:15px;font-weight:700;padding:13px 24px;border-radius:10px;cursor:pointer;">Sí, darme de baja</button></form>
   <p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#5B6E82;">Si fue un error, simplemente cierra esta página: no se hizo ningún cambio.</p>`);
const paginaListo = () => pagina('Listo',
  `<h1 style="margin:0 0 10px;font-size:21px;">Listo, ya no te enviaremos promociones</h1>
   <p style="margin:0;font-size:15px;line-height:1.6;color:#33475B;">Te diste de baja de los recordatorios y promociones por correo. No volverás a recibirlos. Tu cuenta sigue igual, y si algún día quieres la membresía, estará en <a href="${C.URL_COMPRA}" style="color:${AZUL};">el Club FisioTeck</a>.</p>`);
const paginaError = () => pagina('No se pudo completar', '<h1 style="margin:0 0 10px;font-size:21px;">No se pudo completar</h1><p style="margin:0;font-size:15px;line-height:1.6;color:#33475B;">Intenta de nuevo en unos minutos. Si el problema sigue, escríbenos a ' + esc(C.CORREO_CONTACTO) + '.</p>', 500);

function errorHttp(status, mensaje, codigo) { const e = new Error(mensaje); e.status = status; if (codigo) e.codigo = codigo; return e; }

// deps: { db, admin, recordatorios (servicio), claveBaja }
function montarRutasRecordatorios(app, deps) {
  const { db, admin, recordatorios, claveBaja } = deps;
  const limites = { baja: new Map(), sesion: new Map() };
  const limitar = (mapa, clave, maximo) => { if (!ventana(mapa, clave, 60 * 1000, maximo)) throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.'); };
  const analizadorJson = express.json({ limit: '1kb' });
  const analizadorForm = express.urlencoded({ extended: false, limit: '1kb' });

  const responderPagina = (res, p) => res.status(p.estado).set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/html; charset=utf-8' }).send(p.html);
  const datosBaja = req => {
    const uid = typeof req.query.u === 'string' ? req.query.u : '';
    const firma = typeof req.query.t === 'string' ? req.query.t : '';
    return { uid, firma, valido: UID_VALIDO.test(uid) && R.bajaValida(claveBaja(), uid, firma) };
  };

  app.get('/baja-recordatorios', (req, res) => {
    try { limitar(limites.baja, req.ip || 'ip', 60); } catch (_) { return responderPagina(res, pagina('Demasiadas solicitudes', '<p>Espera un momento e intenta de nuevo.</p>', 429)); }
    const d = datosBaja(req);
    return responderPagina(res, d.valido ? paginaConfirmar(d.uid, d.firma) : paginaInvalida());
  });
  app.post('/baja-recordatorios', analizadorForm, async (req, res) => {
    try { limitar(limites.baja, req.ip || 'ip', 30); } catch (_) { return responderPagina(res, pagina('Demasiadas solicitudes', '<p>Espera un momento e intenta de nuevo.</p>', 429)); }
    const d = datosBaja(req);
    if (!d.valido) return responderPagina(res, paginaInvalida());
    try { await recordatorios.darDeBaja(d.uid); return responderPagina(res, paginaListo()); } // si la cuenta ya no existe, igual «listo»
    catch (err) { console.error('[Recordatorios baja]', err && err.message); return responderPagina(res, paginaError()); }
  });

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (generico, etiqueta, soloAdmin, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const d = await sesion(req, res); if (!d) return undefined;
      if (soloAdmin && !esAdminPorToken(d)) return res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' });
      limitar(limites.sesion, d.uid, 30);
      return await fn(req, res, d);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.message, ...(err.codigo ? { codigo: err.codigo } : {}) });
      console.error('[Recordatorios ' + etiqueta + ']', err && err.message);
      return res.status(500).json({ error: generico });
    }
  };
  const bitacora = (d, texto) => console.log('[Recordatorios admin]', d.email, '·', texto);

  // ----- Cuenta -----
  app.get('/api/recordatorios/mi-cupon', envolver('No se pudo consultar tu cupón', 'mi-cupon', false, async (req, res, d) => {
    const snap = await db.collection('members').doc(d.uid).get();
    const cupon = snap.exists ? await recordatorios.miCupon(d.uid, snap.data()) : null;
    return res.json({ ok: true, cupon: cupon ? { codigo: cupon.codigo, monto: cupon.monto, precioMes: cupon.precioMes, precioFinal: cupon.precioFinal, venceMs: cupon.venceMs, restanteMs: cupon.restanteMs } : null });
  }));
  app.get('/api/recordatorios/preferencia', envolver('No se pudo leer tu preferencia', 'preferencia', false, async (req, res, d) => {
    const p = await recordatorios.leerPreferencia(d.uid);
    return res.json({ ok: true, recibe: p.recibe, baja: p.baja });
  }));
  app.post('/api/recordatorios/preferencia', analizadorJson, envolver('No se pudo guardar tu preferencia', 'preferencia', false, async (req, res, d) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof b.recibe !== 'boolean') throw errorHttp(400, 'Indica si quieres recibir promociones (true o false).');
    const p = await recordatorios.fijarPreferencia(d.uid, b.recibe, b.origen === 'registro' ? 'registro' : 'perfil');
    return res.json({ ok: true, recibe: p.recibe, baja: p.baja });
  }));

  // ----- Administración -----
  app.get('/api/admin/recordatorios', envolver('No se pudo leer el estado de los recordatorios', 'estado', true, async (req, res, d) => {
    const resumen = await recordatorios.resumen();
    return res.json({ ok: true, generado: new Date().toISOString(), configurado: Boolean(recordatorios.listoParaEnviar()), correoAdmin: String(d.email || '').toLowerCase(), ...resumen });
  }));
  app.get('/api/admin/recordatorios/lista', envolver('No se pudo leer la lista', 'lista', true, async (req, res) => {
    const etapa = recordatorios.ETAPAS.includes(req.query.etapa) ? req.query.etapa : 'todas';
    const lista = await recordatorios.listado({ q: String(req.query.q || '').slice(0, 80), etapa, pagina: parseInt(req.query.pagina, 10) || 1 });
    return res.json({ ok: true, etapa, ...lista });
  }));
  app.post('/api/admin/recordatorios/modo', analizadorJson, envolver('No se pudo cambiar el interruptor', 'modo', true, async (req, res, d) => {
    const modo = req.body && req.body.modo;
    if (!['activo', 'apagado'].includes(modo)) throw errorHttp(400, 'El modo debe ser «activo» o «apagado».');
    if (modo === 'activo') {
      if (req.body.confirmo !== true) throw errorHttp(400, 'Para activarlo hay que confirmar en la ventana del panel.');
      if (!recordatorios.listoParaEnviar()) throw errorHttp(409, 'No se puede activar: falta configurar el correo (RESEND_API_KEY y MAIL_FROM) o la llave de firmas (CERT_SIGNING_KEY) en el servidor.', 'sin-configurar');
    }
    const cfg = await recordatorios.fijarModo(modo, d.email);
    bitacora(d, modo === 'activo' ? 'activó los recordatorios de pago' : 'apagó los recordatorios de pago');
    return res.json({ ok: true, modo: cfg.modo });
  }));
  app.post('/api/admin/recordatorios/limites', analizadorJson, envolver('No se pudieron guardar los límites', 'limites', true, async (req, res, d) => {
    const b = req.body || {};
    const ok = v => Number.isInteger(v) && v >= 1;
    if (!ok(b.topeDiario) || !ok(b.maxPorCorrida)) throw errorHttp(400, 'Escribe números enteros mayores que cero.');
    if (b.topeDiario > R.CONFIG.topeDiarioMaximo) throw errorHttp(400, 'El tope diario máximo es ' + R.CONFIG.topeDiarioMaximo + '.');
    if (b.maxPorCorrida > R.CONFIG.maxPorCorridaMaximo) throw errorHttp(400, 'El máximo por corrida es ' + R.CONFIG.maxPorCorridaMaximo + '.');
    const cfg = await recordatorios.fijarLimites({ topeDiario: b.topeDiario, maxPorCorrida: b.maxPorCorrida });
    bitacora(d, `cambió los límites: ${cfg.topeDiario} al día y ${cfg.maxPorCorrida} por corrida`);
    return res.json({ ok: true, topeDiario: cfg.topeDiario, maxPorCorrida: cfg.maxPorCorrida });
  }));
  app.post('/api/admin/recordatorios/ensayo', analizadorJson, envolver('No se pudo hacer el ensayo', 'ensayo', true, async (req, res, d) => {
    const r = await recordatorios.procesar({ ensayo: true });
    bitacora(d, `ensayo: ${r.recibirian.length} personas recibirían un correo ahora`);
    return res.json({ ok: true, ...r });
  }));
  app.post('/api/admin/recordatorios/prueba', analizadorJson, envolver('No se pudo enviar el correo de prueba', 'prueba', true, async (req, res, d) => {
    const correo = String(d.email || '').toLowerCase();
    if (!correo.includes('@')) throw errorHttp(400, 'Tu sesión no tiene correo.');
    const pedido = req.body && req.body.paso;
    const ciclo = Math.min(R.CONFIG.maxCiclos, Math.max(1, Math.floor(Number(req.body && req.body.ciclo)) || 1));
    const pasos = pedido === 'todos' ? R.SERIE.map(s => s.paso) : [Number(pedido)];
    if (!pasos.every(p => Number.isInteger(p) && R.definicion(p))) throw errorHttp(400, 'Elige un paso de 1 a ' + R.PASO_ULTIMO + ' o «todos».');
    if (!recordatorios.listoParaEnviar()) throw errorHttp(409, 'No se puede enviar: falta configurar el correo (RESEND_API_KEY y MAIL_FROM) o CERT_SIGNING_KEY en el servidor.', 'sin-configurar');
    const enviados = [];
    for (const paso of pasos) {
      enviados.push(await recordatorios.enviarPrueba({ paso, ciclo, correo, nombre: d.name || '' }));
      if (pasos.length > 1) await new Promise(r => setTimeout(r, 1200));
    }
    bitacora(d, `se mandó a sí mismo ${pasos.length} correo(s) de prueba (vuelta ${ciclo})`);
    return res.json({ ok: true, enviados, para: correo });
  }));
}

module.exports = { montarRutasRecordatorios, paginaConfirmar, paginaListo, paginaInvalida };
