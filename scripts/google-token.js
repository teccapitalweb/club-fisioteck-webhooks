#!/usr/bin/env node
'use strict';
// Obtiene UNA VEZ el «refresh token» de la cuenta de Google Workspace que organiza y graba las clases en vivo (Google Meet).
//
// Uso (en tu computadora, no en el servidor):
//   1) Crea en Google Cloud un «ID de cliente de OAuth» de tipo «Aplicación de escritorio» y copia su ID y su secreto (ver FISIOTECK/GUIA-AUTOMATIZACION-CLASES-EN-VIVO.md).
//   2) Ejecuta:   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-token.js
//      (en PowerShell:  $env:GOOGLE_CLIENT_ID='...'; $env:GOOGLE_CLIENT_SECRET='...'; node scripts/google-token.js)
//   3) Abre el enlace que aparece, entra con la cuenta organizadora y acepta los permisos.
//   4) Copia el valor que imprime el script en la variable GOOGLE_REFRESH_TOKEN de Railway.
//
// Con una cuenta de GMAIL (sin Google Workspace) agrega --drive: pide leer el Drive (recoger las grabaciones) y crear eventos de Calendar (crear la reunión de Meet desde el panel).
//      GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-token.js --drive
// El script no guarda nada en disco. Trata el refresh token como una contraseña: no lo pegues en el código ni en el chat.
const http = require('http');
const crypto = require('crypto');

const ID = process.env.GOOGLE_CLIENT_ID, SECRETO = process.env.GOOGLE_CLIENT_SECRET;
if (!ID || !SECRETO) { console.error('Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el entorno (ver las instrucciones al inicio de este archivo).'); process.exit(1); }
const SOLO_DRIVE = process.argv.includes('--drive');
const SCOPES = SOLO_DRIVE ? [
  'https://www.googleapis.com/auth/drive.readonly',          // recoger del Drive las grabaciones que Meet deja ahí
  'https://www.googleapis.com/auth/calendar.events'          // crear la reunión de Meet desde el panel (evento de Calendar con su enlace)
] : [
  'https://www.googleapis.com/auth/meetings.space.created',   // crear reuniones y ver lo que se creó con esta app
  'https://www.googleapis.com/auth/meetings.space.settings',  // activar la grabación automática del espacio
  'https://www.googleapis.com/auth/drive.readonly'            // descargar la grabación que Meet deja en el Drive de la cuenta organizadora
];

const estado = crypto.randomBytes(16).toString('hex');
const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/') { res.writeHead(404); return res.end(); }
  const volver = (txt, codigo) => { res.writeHead(codigo || 200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(txt); };
  if (u.searchParams.get('state') !== estado) return volver('Respuesta no válida. Vuelve a ejecutar el script.', 400);
  const error = u.searchParams.get('error'); if (error) { volver('Google respondió: ' + error, 400); console.error('Google respondió:', error); return cerrar(1); }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: u.searchParams.get('code') || '', client_id: ID, client_secret: SECRETO, redirect_uri: redirigir(), grant_type: 'authorization_code' }).toString() });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) throw new Error(j.error_description || j.error || ('Google no devolvió el refresh token (' + r.status + '). Si ya conectaste esta cuenta antes, revoca el acceso en myaccount.google.com/permissions y repite.'));
    volver('Listo. Vuelve a la terminal: ahí está el valor para GOOGLE_REFRESH_TOKEN. Ya puedes cerrar esta pestaña.');
    console.log('\nGOOGLE_REFRESH_TOKEN=' + j.refresh_token + '\n\nCópialo en Railway (Variables). No lo compartas.');
    cerrar(0);
  } catch (e) { volver('No se pudo completar: ' + e.message, 500); console.error('No se pudo completar:', e.message); cerrar(1); }
});
let puerto = 0;
const redirigir = () => 'http://127.0.0.1:' + puerto;
function cerrar(codigo) { setTimeout(() => { servidor.close(); process.exit(codigo); }, 300); }
servidor.listen(0, '127.0.0.1', () => {
  puerto = servidor.address().port;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: ID, redirect_uri: redirigir(), response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state: estado });
  console.log('Abre este enlace en tu navegador y entra con la cuenta de Google que ORGANIZA y GRABA las clases:\n\n' + url + '\n\nEsperando la respuesta de Google…');
});
