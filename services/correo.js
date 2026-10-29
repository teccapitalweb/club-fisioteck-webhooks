'use strict';
// CORREOS DEL CLUB FISIOTECK · plantillas y envío por Resend (igual que Alintec y Zoorigen).
// El correo estándar de Firebase sale de firebaseapp.com (dominio compartido) y suele terminar en spam. Aquí se arma un correo con la
// identidad de FisioTeck y se envía desde un dominio propio verificado en Resend.
// Variables de entorno (Railway, nunca en el código):
//   RESEND_API_KEY  llave de Resend
//   MAIL_FROM       remitente verificado en Resend, p. ej. "FisioTeck <no-reply@fisioteck.com>"
//   CLUB_URL        (opcional) dirección del Club; por defecto https://club.fisioteck.com
// Sin RESEND_API_KEY o MAIL_FROM no se envía por Resend: los correos de bienvenida/pago siguen por EmailJS y la verificación
// usa el correo estándar de Firebase como respaldo.

const SITIO = 'https://www.fisioteck.com';
const CLUB = () => String(process.env.CLUB_URL || 'https://club.fisioteck.com').replace(/\/+$/, '');
const CONTACTO = 'teccapitalweb@gmail.com';

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const limpiar = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 200);
const primerNombre = nombre => limpiar(nombre, 60).split(' ')[0].slice(0, 30);

const llaveResend = () => (process.env.RESEND_API_KEY || '').trim();
const remitente = () => (process.env.MAIL_FROM || '').trim();
const configurado = () => Boolean(llaveResend() && remitente());

// `detalleHtml` va entre el párrafo y el botón; `pieHtml` (opcional) reemplaza el bloque del enlace copiable; `pieLegal` (opcional) va al final.
function marco({ titulo, saludo, parrafo, textoBoton, enlace, notaFinal, detalleHtml = '', pieHtml = '', pieLegal = '' }) {
  const link = esc(enlace);
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background:#EEF3F8;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF3F8;padding:28px 14px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #D8E3EE;">
        <tr><td style="background:#0B3A66;padding:26px 28px;text-align:center;border-bottom:4px solid #159E92;">
          <div style="font-size:26px;font-weight:800;color:#FFFFFF;letter-spacing:-.4px;">FisioTeck</div>
          <div style="font-size:12px;font-weight:600;color:#BFE6E1;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">Club de fisioterapia</div>
        </td></tr>
        <tr><td style="padding:30px 28px;">
          <h1 style="margin:0 0 12px;font-size:21px;color:#0B1A30;">${esc(saludo)}</h1>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#33475B;">${esc(parrafo)}</p>
          ${detalleHtml}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
            <tr><td style="border-radius:10px;background:#0D5FA0;">
              <a href="${link}" style="display:inline-block;padding:14px 26px;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;">${esc(textoBoton)}</a>
            </td></tr>
          </table>
          ${pieHtml || `<p style="margin:0 0 6px;font-size:12.5px;line-height:1.5;color:#5B6E82;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
          <p style="margin:0 0 20px;font-size:11.5px;line-height:1.5;color:#0D5FA0;word-break:break-all;">${link}</p>`}
          <p style="margin:0;font-size:12.5px;line-height:1.5;color:#5B6E82;">${esc(notaFinal)}</p>
        </td></tr>
      </table>
      ${pieLegal || `<p style="margin:14px 0 0;font-size:11.5px;color:#7C8DA0;">FisioTeck · fisioteck.com</p>`}
    </td></tr>
  </table>
</body></html>`;
}

// ───── Plantillas ─────
function plantillaVerificacion({ nombre, enlace }) {
  const n = primerNombre(nombre);
  const saludo = (n ? 'Hola ' + n : 'Hola') + ', confirma tu correo';
  const parrafo = 'Para activar tu cuenta y entrar al Club FisioTeck, confirma que este correo es tuyo.';
  const notaFinal = 'Si tú no creaste esta cuenta, ignora este mensaje: no se activará nada.';
  const asunto = 'Verifica tu correo · FisioTeck';
  return { asunto, html: marco({ titulo: asunto, saludo, parrafo, textoBoton: 'Verificar mi correo', enlace, notaFinal }), texto: `${saludo}\n\n${parrafo}\n\nConfirma tu correo aquí:\n${enlace}\n\n${notaFinal}\n` };
}

function plantillaRestablecer({ enlace }) {
  const saludo = 'Restablece tu contraseña';
  const parrafo = 'Recibimos una solicitud para crear una nueva contraseña en tu cuenta del Club FisioTeck. El enlace es válido por 1 hora.';
  const notaFinal = 'Si tú no lo pediste, ignora este mensaje: tu contraseña actual sigue funcionando.';
  const asunto = 'Restablece tu contraseña · FisioTeck';
  return { asunto, html: marco({ titulo: asunto, saludo, parrafo, textoBoton: 'Crear nueva contraseña', enlace, notaFinal }), texto: `${saludo} (válido por 1 hora):\n${enlace}\n\n${notaFinal}\n` };
}

// Correo cuando se emite un certificado (una sola vez). El PDF va adjunto si se pudo generar.
function plantillaCertificado({ nombre, curso, folio, clases, conAdjunto }) {
  const urlPanel = CLUB() + '/';
  const urlVerificar = CLUB() + '/verificar/?folio=' + encodeURIComponent(String(folio || ''));
  const n = primerNombre(nombre);
  const nombreCurso = limpiar(curso, 120) || 'tu curso';
  const saludo = n ? `¡Felicidades, ${n}!` : '¡Felicidades!';
  const linea = Number(clases) > 0 ? `${Number(clases)} ${Number(clases) === 1 ? 'clase' : 'clases'} · ` : '';
  const detalleHtml = `<p style="margin:0 0 18px;font-size:17px;font-weight:700;line-height:1.4;color:#0B1A30;">${esc(nombreCurso)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;background:#F2F7FC;border:1px solid #D8E3EE;border-radius:10px;">
            <tr><td style="padding:14px 16px;font-size:13px;line-height:1.6;color:#33475B;">
              ${esc(linea)}Folio del certificado:<br>
              <strong style="font-size:15px;letter-spacing:.5px;color:#0B1A30;">${esc(folio)}</strong>
            </td></tr>
          </table>`;
  const nota = conAdjunto ? 'Adjuntamos tu certificado en PDF. ' : '';
  const pieHtml = `<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#33475B;">${esc(nota)}Puedes descargarlo de nuevo cuando quieras desde el Club, en la sección <strong>Mis certificados</strong>.</p>
          <p style="margin:0 0 20px;font-size:12.5px;line-height:1.6;color:#5B6E82;">Cualquier persona puede comprobar que es auténtico aquí:<br>
            <a href="${esc(urlVerificar)}" style="color:#0D5FA0;word-break:break-all;">${esc(urlVerificar)}</a></p>`;
  const asunto = `Completaste ${limpiar(nombreCurso, 80)}: tu certificado está listo`;
  const notaFinal = 'Este aviso se envía una sola vez, cuando se emite tu certificado.';
  return {
    asunto, urlPanel, urlVerificar,
    html: marco({ titulo: 'Tu certificado · FisioTeck', saludo, parrafo: 'Completaste el curso:', textoBoton: 'Abrir el Club', enlace: urlPanel, notaFinal, detalleHtml, pieHtml }),
    texto: `${saludo}\n\nCompletaste el curso: ${nombreCurso}\nFolio del certificado: ${folio}\n\n${nota}Descárgalo de nuevo desde el Club (Mis certificados): ${urlPanel}\nVerificación pública: ${urlVerificar}\n\n${notaFinal}\n`
  };
}

// ───── Envío ─────
// Devuelve { ok:true } | { ok:false, motivo, status?, esperarSegundos? }; nunca lanza.
// adjuntos: [{ filename, content(base64) }]. headers/tags/replyTo/idempotencyKey opcionales (correos masivos).
async function enviarConResend({ para, asunto, html, texto, adjuntos, headers, tags, replyTo, idempotencyKey }, { apiKey, from, fetchImpl } = {}) {
  const llave = apiKey !== undefined ? apiKey : llaveResend();
  const de = from !== undefined ? from : remitente();
  if (!llave || !de) return { ok: false, motivo: 'sin-configurar' };
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, motivo: 'sin-fetch' };
  try {
    const r = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + llave, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 250) } : {}) },
      body: JSON.stringify({
        from: de, to: [para], subject: asunto, html, text: texto,
        ...(Array.isArray(adjuntos) && adjuntos.length ? { attachments: adjuntos } : {}),
        ...(headers && typeof headers === 'object' && Object.keys(headers).length ? { headers } : {}),
        ...(Array.isArray(tags) && tags.length ? { tags } : {}),
        ...(replyTo ? { reply_to: replyTo } : {})
      })
    });
    if (!r.ok) {
      let cuerpo = '';
      try { cuerpo = String(await r.text()).slice(0, 160); } catch (_) { /* sin cuerpo */ }
      console.error('[Correo] Resend respondió', r.status, cuerpo);
      let esperar = 0;
      try { esperar = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : 0) || 0; } catch (_) { esperar = 0; }
      return { ok: false, motivo: r.status === 429 ? 'limite' : 'rechazado', status: r.status, ...(esperar ? { esperarSegundos: esperar } : {}) };
    }
    return { ok: true };
  } catch (err) {
    console.error('[Correo] No se pudo enviar:', err && err.message);
    return { ok: false, motivo: 'error-red' };
  }
}

// Envía el correo del certificado con el PDF adjunto. Devuelve true/false; nunca lanza. Sin Resend configurado no hace nada.
async function enviarCorreoCertificado(cert, { apiKey, from, fetchImpl, generarPdf } = {}) {
  const c = cert || {};
  const llave = apiKey !== undefined ? apiKey : llaveResend(), de = from !== undefined ? from : remitente();
  if (!llave || !de || !c.email || !c.folio) return false;
  let adjunto = null;
  try {
    const generar = generarPdf || require('./certificado-pdf').generarPdf;
    const pdf = await generar(c, CLUB() + '/verificar/?folio=' + encodeURIComponent(String(c.folio)));
    adjunto = { filename: 'Certificado-' + String(c.folio).replace(/[^A-Za-z0-9_-]/g, '') + '.pdf', content: Buffer.from(pdf).toString('base64') };
  } catch (err) { console.warn('[Correo] No se pudo generar el PDF del certificado:', err && err.message); }
  const p = plantillaCertificado({ nombre: c.nombre, curso: c.cursoTitulo, folio: c.folio, clases: c.clases, conAdjunto: Boolean(adjunto) });
  const r = await enviarConResend({ para: c.email, asunto: p.asunto, html: p.html, texto: p.texto, adjuntos: adjunto ? [adjunto] : [], idempotencyKey: 'cert-' + c.folio }, { apiKey: llave, from: de, fetchImpl });
  return Boolean(r && r.ok);
}

// Firebase genera un enlace que abre su página genérica. Se conserva solo el código y se manda al Club (club-correo.js lo procesa).
function enlacePropio(enlaceFirebase, modo) {
  try {
    const codigo = new URL(enlaceFirebase).searchParams.get('oobCode');
    if (codigo) return CLUB() + '/?modo=' + encodeURIComponent(modo) + '&oobCode=' + encodeURIComponent(codigo);
  } catch (_) { /* enlace inesperado: se usa tal cual */ }
  return enlaceFirebase;
}

module.exports = {
  marco, plantillaVerificacion, plantillaRestablecer, plantillaCertificado, enviarConResend, enviarCorreoCertificado, enlacePropio,
  configurado, primerNombre, esc, limpiar, CLUB, SITIO, CONTACTO
};
