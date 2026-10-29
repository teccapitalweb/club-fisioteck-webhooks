'use strict';
// CORREOS DE CUENTA con la plantilla de FisioTeck (en lugar del correo estándar de Firebase, que sale de firebaseapp.com y cae en spam).
//  POST /api/auth/send-verification   (sesión)  genera el enlace oficial de Firebase y manda el correo de confirmación.
//        · ya verificado → { ok:true, yaVerificado:true }  · sin Resend configurado → 503 codigo 'correo-no-configurado' (el sitio usa el de Firebase)
//        · límite: 1 por minuto y 6 por hora por cuenta
//  POST /api/auth/reset-password      (público)  { email }  manda el enlace para crear una nueva contraseña.
//        · responde igual exista o no la cuenta (no revela quién está registrado) · límite por IP y por correo
const correo = require('./correo');

function ventana(mapa, clave, ventanaMs, maximo, ahora = Date.now()) {
  const a = mapa.get(clave);
  if (!a || ahora >= a.hasta) { mapa.set(clave, { n: 1, hasta: ahora + ventanaMs }); return true; }
  a.n += 1;
  return a.n <= maximo;
}
function limpiarMapa(mapa, ahora = Date.now()) { if (mapa.size > 5000) for (const [k, v] of mapa) if (ahora >= v.hasta) mapa.delete(k); }

function montarRutasAuth(app, deps) {
  const { admin } = deps;
  const enviar = deps.enviarCorreo || correo.enviarConResend;
  const porMinuto = new Map(), porHora = new Map(), resetIp = new Map(), resetCorreo = new Map();

  function falla(res, e, generico) {
    if (e && e.status) return res.status(e.status).json({ error: e.message, ...(e.codigo ? { codigo: e.codigo } : {}) });
    console.error('[auth correo]', e && e.message);
    return res.status(500).json({ error: generico });
  }
  const err = (status, mensaje, codigo) => { const e = new Error(mensaje); e.status = status; if (codigo) e.codigo = codigo; return e; };

  app.post('/api/auth/send-verification', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (!m) throw err(401, 'Inicia sesión para continuar.');
      let d;
      try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { throw err(401, 'Tu sesión no es válida o expiró.'); }
      if (!d.email) throw err(400, 'Tu cuenta no tiene correo electrónico.');
      if (d.email_verified === true) return res.json({ ok: true, yaVerificado: true });
      if (!ventana(porMinuto, d.uid, 60 * 1000, 1)) throw err(429, 'Espera un minuto antes de pedir otro correo.');
      if (!ventana(porHora, d.uid, 60 * 60 * 1000, 6)) throw err(429, 'Pediste muchos correos. Intenta de nuevo en un rato.');
      limpiarMapa(porMinuto); limpiarMapa(porHora);
      if (!correo.configurado() && !deps.enviarCorreo) throw err(503, 'El envío de correos de FisioTeck todavía no está configurado.', 'correo-no-configurado');
      const enlace = correo.enlacePropio(await admin.auth().generateEmailVerificationLink(d.email, { url: correo.CLUB() + '/' }), 'verifyEmail');
      const p = correo.plantillaVerificacion({ nombre: d.name, enlace });
      const r = await enviar({ para: d.email, asunto: p.asunto, html: p.html, texto: p.texto });
      if (!r || !r.ok) throw err(502, 'No se pudo enviar el correo de verificación.');
      res.json({ ok: true });
    } catch (e) { falla(res, e, 'No se pudo enviar el correo de verificación.'); }
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const email = String((req.body || {}).email || '').trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400, 'Escribe un correo válido.');
      if (!ventana(resetIp, String(req.ip || 'desconocida'), 10 * 60 * 1000, 8)) throw err(429, 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.');
      limpiarMapa(resetIp); limpiarMapa(resetCorreo);
      // segunda petición del mismo correo en menos de 1 min: se responde igual, sin reenviar
      if (!ventana(resetCorreo, email, 60 * 1000, 1)) return res.json({ ok: true });
      if (!correo.configurado() && !deps.enviarCorreo) throw err(503, 'El envío de correos de FisioTeck todavía no está configurado.', 'correo-no-configurado');
      let existe = true;
      try { await admin.auth().getUserByEmail(email); } catch (_) { existe = false; }
      if (existe) {
        const enlace = correo.enlacePropio(await admin.auth().generatePasswordResetLink(email, { url: correo.CLUB() + '/' }), 'resetPassword');
        const p = correo.plantillaRestablecer({ enlace });
        const r = await enviar({ para: email, asunto: p.asunto, html: p.html, texto: p.texto });
        if (!r || !r.ok) throw err(502, 'No se pudo enviar el correo.');
      }
      res.json({ ok: true });
    } catch (e) { falla(res, e, 'No se pudo enviar el correo de restablecimiento.'); }
  });
}

module.exports = { montarRutasAuth, ventana };
