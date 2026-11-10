'use strict';
// CLASES EN VIVO AUTOMÁTICAS: Zoom (reunión con grabación en la nube) → Bunny Stream → la grabación aparece sola en «Grabaciones».
//
//  Flujo:
//   1) El administrador programa la clase y pide crear la reunión de Zoom (POST /api/admin/clases-auto/zoom). La reunión se crea con grabación
//      automática en la nube y el servidor guarda a qué clase pertenece (clasesAuto/{idReunión}).
//   2) Cuando Zoom termina de procesar la grabación avisa al servidor (POST /api/zoom/webhook, evento recording.completed, con firma).
//   3) El servidor le pide a Bunny que descargue el video desde Zoom (videos/fetch) y guarda el id del video.
//   4) Cuando Bunny termina de procesarlo (estado 4) la grabación queda lista y se enlaza con la clase (webinarsPrivados/{id} o clasesPrueba/{id}).
//   5) Los miembros la reproducen con un enlace firmado de corta duración (nunca se expone el video ni las llaves).
//
//  Variables de entorno (Railway):
//   ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET   app «Server-to-Server OAuth» de Zoom (permisos: meeting:write:admin, cloud_recording:read:admin)
//   ZOOM_HOST_EMAIL                                       correo de la cuenta de Zoom que organiza y graba las clases
//   ZOOM_WEBHOOK_SECRET_TOKEN                             «Secret Token» del evento recording.completed
//   BUNNY_STREAM_LIBRARY_ID, BUNNY_STREAM_API_KEY, BUNNY_STREAM_TOKEN_KEY (+ BUNNY_STREAM_PLAYER_HOST, BUNNY_PLAYBACK_TTL_SECONDS)
//
//  GOOGLE MEET (misma idea, sin avisos de Zoom: el servidor revisa cada pocos minutos):
//   1) POST /api/admin/clases-auto/meet crea un espacio de Meet con grabación automática (API de Meet) y guarda a qué clase pertenece.
//   2) Cuando pasa la hora, el servidor busca en la API de Meet si ya hay una grabación generada (se guarda en el Drive de la cuenta organizadora).
//   3) La descarga de Drive y la sube a Bunny sin guardarla en disco (en flujo continuo); después sigue igual que con Zoom.
//   Variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (de la cuenta de Google Workspace que organiza y graba; se obtienen una vez con
//   scripts/google-token.js). Scopes: meetings.space.created, meetings.space.settings y drive.readonly.
//  MEET CON UNA CUENTA DE GMAIL (sin Workspace, sin API de Meet): el administrador crea y graba la reunión a mano (la grabación queda en el Drive de la cuenta)
//   y el servidor VIGILA ese Drive. Si no pones enlace, el servidor CREA la reunión de Meet solo (evento de Google Calendar con su enlace de Meet; permiso calendar.events).
//   POST /api/admin/clases-auto/drive registra la clase con su enlace de Meet; pasada la hora, busca un MP4 nuevo del Drive
//   (por el código del enlace en el nombre, o el único del horario) y lo pasa a Bunny igual que con Meet. Solo necesita el permiso drive.readonly.
//  Administrador:  POST /api/admin/clases-auto/zoom                  { id, title, date, time, duration } → { joinUrl, startUrl, meetingId }
//                  GET  /api/admin/clases-auto                       → { entradas: [...] } (estado de cada grabación; refresca las pendientes)
//                  POST /api/admin/clases-auto/:meetingId/reintentar → vuelve a pedir la grabación a Zoom y a subirla a Bunny
//  Zoom:           POST /api/zoom/webhook                            (firma HMAC; también responde la validación del endpoint)
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const express = require('express');
const { esAdminPorToken } = require('./certificados');

const COL = 'clasesAuto';
const ZOOM_API = 'https://api.zoom.us/v2', ZOOM_OAUTH = 'https://zoom.us/oauth/token', BUNNY_API = 'https://video.bunnycdn.com';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const MEET_API = 'https://meet.googleapis.com/v2', DRIVE_API = 'https://www.googleapis.com/drive/v3', GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const ESPERA_MAX_MS = 48 * 3600 * 1000; // si 48 h después de la clase no hay grabación, se avisa en el panel
const hmac = (clave, texto) => crypto.createHmac('sha256', clave).update(texto).digest('hex');
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const texto = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const idReunion = v => { const s = String(v == null ? '' : v).trim(); if (!/^[A-Za-z0-9_-]{5,60}$/.test(s)) throw errorHttp(400, 'Identificador de reunión inválido.'); return s; };
const idClase = v => { const s = String(v == null ? '' : v).trim(); if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw errorHttp(400, 'Identificador de clase inválido.'); return s; };

// Enlace de reproducción firmado de Bunny (mismo esquema que los videos de los cursos). null si Bunny no está configurado.
function firmarEmbed(videoId, env = process.env, ahoraMs = Date.now()) {
  const lib = env.BUNNY_STREAM_LIBRARY_ID || '', clave = env.BUNNY_STREAM_TOKEN_KEY || '';
  if (!lib || !clave || !/^[0-9a-f-]{20,}$/i.test(String(videoId || ''))) return null;
  const host = String(env.BUNNY_STREAM_PLAYER_HOST || 'https://iframe.mediadelivery.net').replace(/\/$/, '');
  const ttl = Math.max(60, Math.min(Number(env.BUNNY_PLAYBACK_TTL_SECONDS) || 900, 3600));
  const expires = Math.floor(ahoraMs / 1000) + ttl;
  const token = crypto.createHash('sha256').update(clave + videoId + expires).digest('hex');
  return host + '/embed/' + encodeURIComponent(lib) + '/' + encodeURIComponent(videoId) + '?token=' + token + '&expires=' + expires;
}

// De varios archivos de la grabación, el MP4 de mejor vista (pantalla compartida con orador > orador activo > cualquier MP4)
function elegirArchivo(archivos) {
  const ok = (archivos || []).filter(f => f && String(f.file_type).toUpperCase() === 'MP4' && (!f.status || f.status === 'completed') && f.download_url);
  const orden = ['shared_screen_with_speaker_view', 'shared_screen_with_gallery_view', 'active_speaker', 'shared_screen', 'gallery_view'];
  for (const t of orden) { const f = ok.find(x => x.recording_type === t); if (f) return f; }
  return ok[0] || null;
}

function crearClasesAuto(deps) {
  const { db, admin } = deps, env = deps.env || process.env, fetchFn = deps.fetch || global.fetch, ahora = deps.ahora || (() => Date.now());
  const zoomListo = () => !!(env.ZOOM_ACCOUNT_ID && env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET && env.ZOOM_HOST_EMAIL);
  const bunnyListo = () => !!(env.BUNNY_STREAM_LIBRARY_ID && env.BUNNY_STREAM_API_KEY);
  let tokenZoom = { valor: '', hasta: 0 };

  async function accesoZoom(forzar) {
    if (!zoomListo()) throw errorHttp(503, 'Falta configurar Zoom en el servidor (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET y ZOOM_HOST_EMAIL).');
    if (!forzar && tokenZoom.valor && tokenZoom.hasta > ahora() + 60000) return tokenZoom.valor;
    const basic = Buffer.from(env.ZOOM_CLIENT_ID + ':' + env.ZOOM_CLIENT_SECRET).toString('base64');
    let r; try { r = await fetchFn(ZOOM_OAUTH + '?grant_type=account_credentials&account_id=' + encodeURIComponent(env.ZOOM_ACCOUNT_ID), { method: 'POST', headers: { Authorization: 'Basic ' + basic } }); }
    catch (_) { throw errorHttp(502, 'No pudimos conectar con Zoom.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw errorHttp(502, 'Zoom rechazó las credenciales de la app (' + (j.reason || j.error || r.status) + ').');
    tokenZoom = { valor: j.access_token, hasta: ahora() + (Number(j.expires_in) || 3600) * 1000 };
    return tokenZoom.valor;
  }
  async function zoom(ruta, opts, reintento) {
    const token = await accesoZoom(!!reintento);
    let r; try { r = await fetchFn(ZOOM_API + ruta, { ...(opts || {}), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }); }
    catch (_) { throw errorHttp(502, 'No pudimos conectar con Zoom.'); }
    if (r.status === 401 && !reintento) return zoom(ruta, opts, true);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw errorHttp(502, 'Zoom respondió con error ' + r.status + (j.message ? ': ' + j.message : '') + '.');
    return j;
  }
  async function bunny(ruta, opts) {
    if (!bunnyListo()) throw errorHttp(503, 'Falta configurar Bunny en el servidor (BUNNY_STREAM_LIBRARY_ID y BUNNY_STREAM_API_KEY).');
    let r; try { r = await fetchFn((env.BUNNY_API_BASE || BUNNY_API) + '/library/' + encodeURIComponent(env.BUNNY_STREAM_LIBRARY_ID) + ruta, { ...(opts || {}), headers: { AccessKey: env.BUNNY_STREAM_API_KEY, Accept: 'application/json', 'Content-Type': 'application/json' } }); }
    catch (_) { throw errorHttp(502, 'No pudimos conectar con Bunny.'); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw errorHttp(502, 'Bunny rechazó la API Key de la biblioteca.');
    if (!r.ok) throw errorHttp(502, 'Bunny respondió con error ' + r.status + (j.message ? ': ' + j.message : '') + '.');
    return j;
  }

  // La grabación lista se enlaza con la clase: webinarsPrivados/{id} (clase real) o clasesPrueba/{id} (prueba de administradores)
  async function enlazarVideo(claseId, videoId) {
    const col = /^prueba-/.test(claseId) ? 'clasesPrueba' : 'webinarsPrivados';
    await db.collection(col).doc(claseId).set({ grabacionVideoId: videoId, tieneGrabacion: true }, { merge: true });
  }
  const marcar = (id, campos) => db.collection(COL).doc(id).set({ ...campos, actualizado: new Date(ahora()).toISOString() }, { merge: true });

  // Sube a Bunny la grabación de una reunión. archivo = un elemento de recording_files; token = access_token de descarga de Zoom.
  async function subirABunny(id, entrada, archivo, token) {
    const url = archivo.download_url + (archivo.download_url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
    const titulo = texto((entrada.titulo || 'Clase en vivo') + ' · ' + (entrada.fecha || ''), 150);
    const r = await bunny('/videos/fetch', { method: 'POST', body: JSON.stringify({ url, title: titulo }) });
    const videoId = String(r.id || r.guid || '').toLowerCase();
    if (!videoId) throw errorHttp(502, 'Bunny no devolvió el id del video.');
    await marcar(id, { estado: 'subiendo', videoId, archivoZoom: String(archivo.id || ''), error: '' });
    return videoId;
  }

  // Revisa en Bunny las grabaciones que se están procesando; las que terminaron quedan enlazadas con su clase.
  async function refrescarPendientes() {
    if (!bunnyListo()) return;
    const sn = await db.collection(COL).limit(100).get();
    for (const d of sn.docs) {
      const e = d.data() || {};
      if (e.estado !== 'subiendo' || !e.videoId) continue;
      try {
        const v = await bunny('/videos/' + encodeURIComponent(e.videoId), { method: 'GET' });
        if (v.status === 4) { await enlazarVideo(e.claseId, e.videoId); await marcar(d.id, { estado: 'lista', error: '' }); }
        else if (v.status === 5 || v.status === 6) await marcar(d.id, { estado: 'error', error: 'Bunny no pudo procesar el video (estado ' + v.status + ').' });
      } catch (err) { /* si Bunny no responde ahora, se vuelve a intentar la próxima vez */ }
    }
  }

  async function procesarGrabacion(cuerpo) {
    const obj = (cuerpo.payload && cuerpo.payload.object) || {}, id = String(obj.id || '');
    if (!/^\d{5,20}$/.test(id)) return { ignorado: true };
    const ref = db.collection(COL).doc(id), s = await ref.get();
    if (!s.exists) return { ignorado: true }; // una reunión que no creó este sistema
    const entrada = s.data() || {};
    const archivo = elegirArchivo(obj.recording_files);
    if (!archivo) { await marcar(id, { estado: 'error', error: 'Zoom avisó de la grabación, pero no incluye un archivo MP4.' }); return { error: true }; }
    if ((entrada.estado === 'subiendo' || entrada.estado === 'lista') && entrada.archivoZoom === String(archivo.id || '')) return { repetido: true }; // Zoom reintenta los avisos
    try { await subirABunny(id, entrada, archivo, cuerpo.download_token || ''); return { ok: true }; }
    catch (e) { await marcar(id, { estado: 'error', error: texto(e.message, 300) }); return { error: true }; }
  }

  // ===== GOOGLE MEET =====
  const meetListo = () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
  let tokenGoogle = { valor: '', hasta: 0 };
  async function accesoGoogle(forzar) {
    if (!meetListo()) throw errorHttp(503, 'Falta conectar la cuenta de Google en el servidor (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN).');
    if (!forzar && tokenGoogle.valor && tokenGoogle.hasta > ahora() + 60000) return tokenGoogle.valor;
    let r; try { r = await fetchFn(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }).toString() }); }
    catch (_) { throw errorHttp(502, 'No pudimos conectar con Google.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw errorHttp(502, 'Google rechazó la conexión de la cuenta (' + (j.error_description || j.error || r.status) + '). Hay que volver a conectarla con scripts/google-token.js.');
    tokenGoogle = { valor: j.access_token, hasta: ahora() + (Number(j.expires_in) || 3600) * 1000 };
    return tokenGoogle.valor;
  }
  async function google(url, opts, reintento, crudo) {
    const token = await accesoGoogle(!!reintento);
    let r; try { r = await fetchFn(url, { ...(opts || {}), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }); }
    catch (_) { throw errorHttp(502, 'No pudimos conectar con Google.'); }
    if (r.status === 401 && !reintento) return google(url, opts, true, crudo);
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw errorHttp(502, 'Google respondió con error ' + r.status + (j.error && j.error.message ? ': ' + j.error.message : '') + '.'); }
    return crudo ? r : r.json().catch(() => ({}));
  }
  const idArchivoDrive = v => { const t = String(v || ''); const m = t.match(/\/d\/([A-Za-z0-9_-]+)/); return m ? m[1] : t.split('/').pop(); };

  // Busca la mejor grabación ya generada de un espacio de Meet (null si todavía no hay)
  async function buscarGrabacionMeet(spaceName) {
    const filtro = encodeURIComponent('space.name = "' + spaceName + '"');
    const cr = await google(MEET_API + '/conferenceRecords?filter=' + filtro);
    let mejor = null;
    for (const c of (cr.conferenceRecords || [])) {
      const rs = await google(MEET_API + '/' + c.name + '/recordings');
      for (const r of (rs.recordings || [])) {
        if (r.state !== 'FILE_GENERATED' || !r.driveDestination || !r.driveDestination.file) continue;
        const dur = Date.parse(r.endTime || '') - Date.parse(r.startTime || '') || 0;
        if (!mejor || dur > mejor.dur) mejor = { fileId: idArchivoDrive(r.driveDestination.file), nombre: r.name, dur };
      }
    }
    return mejor;
  }

  // Crea un evento en el Calendar de la cuenta con su enlace de Meet (funciona con Gmail; no invita a nadie)
  async function crearEnlaceMeetConCalendar({ titulo, inicioMs, duracion, descripcion }) {
    const cuerpo = {
      summary: titulo, description: descripcion || '',
      start: { dateTime: new Date(inicioMs).toISOString(), timeZone: 'America/Mexico_City' },
      end: { dateTime: new Date(inicioMs + duracion * 60000).toISOString(), timeZone: 'America/Mexico_City' },
      conferenceData: { createRequest: { requestId: crypto.randomBytes(12).toString('hex'), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
    };
    let ev;
    try { ev = await google(CALENDAR_API + '/calendars/primary/events?conferenceDataVersion=1', { method: 'POST', body: JSON.stringify(cuerpo) }); }
    catch (e) {
      if (/\b403\b/.test(e.message)) throw errorHttp(502, 'Google no dejó crear la reunión: falta el permiso de Calendar. Activa Google Calendar API en tu proyecto y vuelve a conectar la cuenta con scripts/google-token.js --drive.');
      throw e;
    }
    const enlace = ev.hangoutLink || (((ev.conferenceData || {}).entryPoints || []).find(p => p.entryPointType === 'video') || {}).uri || '';
    if (!codigoMeet(enlace)) throw errorHttp(502, 'Google creó el evento pero no devolvió el enlace de Meet. Inténtalo de nuevo.');
    return enlace;
  }

  // MEET CON GMAIL: busca en el Drive de la cuenta conectada el MP4 de la clase (null si todavía no aparece)
  const codigoMeet = v => { const m = String(v || '').match(/meet\.google\.com\/(?:lookup\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})/i); return m ? m[1].toLowerCase() : ''; };
  async function buscarGrabacionDrive(e) {
    // Consulta sencilla (sin orden ni opciones de unidades compartidas): el filtro fino se hace aquí, para no depender de detalles del buscador de Drive
    const desde = new Date((e.inicioMs || 0) - 30 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const q = "mimeType = 'video/mp4' and trashed = false and createdTime >= '" + desde + "'";
    let r;
    try { r = await google(DRIVE_API + '/files?q=' + encodeURIComponent(q) + '&pageSize=50&fields=' + encodeURIComponent('files(id,name,size,createdTime,ownedByMe)')); }
    catch (err) { throw errorHttp(502, 'Al buscar en el Drive: ' + err.message); }
    const hasta = (e.finMs || 0) + 6 * 3600000, minus = t => String(t || '').toLowerCase();
    const candidatos = (r.files || []).filter(x => x.ownedByMe !== false && Number(x.size) > 0 && Date.parse(x.createdTime || '') <= hasta);
    // Meet nombra el video con el TÍTULO del evento (o con el código si la reunión no tiene título): se busca primero por código, luego por título
    const porCodigo = e.codigo ? candidatos.filter(x => minus(x.name).includes(e.codigo)) : [];
    const titulo = minus(e.titulo).trim(), porTitulo = titulo ? candidatos.filter(x => minus(x.name).includes(titulo)) : [];
    const especificos = porCodigo.length ? porCodigo : porTitulo;
    const pool = especificos.length ? especificos : candidatos;
    if (!pool.length) return null;
    // Con coincidencia por código o título se toma el video más grande (si la grabación se cortó en partes, la principal); sin coincidencia y con varios, no se adivina
    if (pool.length > 1 && !especificos.length) { const err = errorHttp(409, 'Hay ' + pool.length + ' grabaciones en ese horario y no se sabe cuál es la de esta clase. Agrega la correcta a mano (enlace de la grabación en la clase) y marca esta como resuelta.'); err.definitivo = true; throw err; }
    const elegido = pool.slice().sort((p, q2) => Number(q2.size) - Number(p.size))[0];
    return { fileId: elegido.id, nombre: elegido.name, dur: 0 };
  }

  // Sube a Bunny un archivo en flujo continuo (PUT con Content-Length): no se guarda en el disco del servidor
  function subirFlujoABunny(videoId, tam, flujo) {
    return new Promise((resolve, reject) => {
      const base = new URL((env.BUNNY_API_BASE || BUNNY_API) + '/library/' + encodeURIComponent(env.BUNNY_STREAM_LIBRARY_ID) + '/videos/' + encodeURIComponent(videoId));
      const cliente = base.protocol === 'http:' ? http : https;
      const req = cliente.request(base, { method: 'PUT', headers: { AccessKey: env.BUNNY_STREAM_API_KEY, 'Content-Type': 'application/octet-stream', 'Content-Length': String(tam) } }, resp => {
        let cuerpo = ''; resp.on('data', d => { cuerpo += d; });
        resp.on('end', () => (resp.statusCode >= 200 && resp.statusCode < 300) ? resolve() : reject(errorHttp(502, 'Bunny rechazó la subida del video (' + resp.statusCode + ').')));
      });
      req.on('error', () => reject(errorHttp(502, 'Se cortó la conexión con Bunny al subir el video.')));
      flujo.on('error', () => { req.destroy(); reject(errorHttp(502, 'Se cortó la descarga desde Google Drive.')); });
      flujo.pipe(req);
    });
  }

  // Pasa la grabación de Drive a Bunny
  async function transferirDriveABunny(id, entrada, grab) {
    const meta = await google(DRIVE_API + '/files/' + encodeURIComponent(grab.fileId) + '?fields=size,name,mimeType&supportsAllDrives=true');
    const tam = Number(meta.size) || 0;
    if (!tam) throw errorHttp(502, 'Google Drive no informó el tamaño de la grabación.');
    const v = await bunny('/videos', { method: 'POST', body: JSON.stringify({ title: texto((entrada.titulo || 'Clase en vivo') + ' · ' + (entrada.fecha || ''), 150) }) });
    const videoId = String(v.guid || v.id || '').toLowerCase();
    if (!videoId) throw errorHttp(502, 'Bunny no devolvió el id del video.');
    const r = await google(DRIVE_API + '/files/' + encodeURIComponent(grab.fileId) + '?alt=media&supportsAllDrives=true', { method: 'GET' }, false, true);
    await subirFlujoABunny(videoId, tam, Readable.fromWeb(r.body));
    await marcar(id, { estado: 'subiendo', videoId, archivoDrive: grab.fileId, error: '' });
    return videoId;
  }

  let revisando = false;
  async function revisarMeet() {
    if (revisando || !meetListo() || !bunnyListo()) return;
    revisando = true;
    try {
      const sn = await db.collection(COL).limit(100).get();
      for (const d of sn.docs) {
        const e = d.data() || {};
        if ((e.proveedor !== 'meet' && e.proveedor !== 'drive') || e.estado !== 'esperando' || ahora() < (e.inicioMs || 0)) continue;
        try {
          const grab = e.proveedor === 'drive' ? await buscarGrabacionDrive(e) : await buscarGrabacionMeet(e.spaceName);
          if (!grab) { if (ahora() > (e.finMs || 0) + ESPERA_MAX_MS) await marcar(d.id, { estado: 'error', error: e.proveedor === 'drive' ? 'Pasaron 48 horas y no apareció ninguna grabación nueva en el Drive. Revisa que hayas pulsado Grabar en Meet y que el video aparezca en el Drive de la cuenta conectada.' : 'Pasaron 48 horas y Meet no generó ninguna grabación. Revisa que la cuenta organizadora tenga la grabación habilitada y que alguien con permiso haya entrado a la reunión.' }); continue; }
          await marcar(d.id, { estado: 'descargando', error: '' });
          try { await transferirDriveABunny(d.id, e, grab); }
          catch (err) { await marcar(d.id, { estado: 'error', error: texto(err.message, 300) }); }
        } catch (err) { await marcar(d.id, err.definitivo ? { estado: 'error', error: texto(err.message, 300) } : { error: texto(err.message, 300) }); } // se vuelve a intentar en la próxima revisión
      }
    } finally { revisando = false; }
  }
  // Cada pocos minutos: busca grabaciones nuevas de Meet y revisa las que Bunny está procesando
  function iniciarRevision(cadaMs) {
    const t = setInterval(() => { revisarMeet().then(refrescarPendientes).catch(e => console.warn('[clases-auto revisión]', e && e.message)); }, cadaMs || 3 * 60 * 1000);
    if (t.unref) t.unref();
    return t;
  }

  function montarWebhook(app) {
    // Va ANTES de express.json(): la firma de Zoom se calcula sobre el cuerpo exacto
    app.post('/api/zoom/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
      const secreto = env.ZOOM_WEBHOOK_SECRET_TOKEN;
      if (!secreto) return res.status(503).json({ error: 'Falta ZOOM_WEBHOOK_SECRET_TOKEN en el servidor.' });
      const crudo = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      let cuerpo; try { cuerpo = JSON.parse(crudo); } catch (_) { return res.status(400).json({ error: 'Cuerpo inválido.' }); }
      if (cuerpo && cuerpo.event === 'endpoint.url_validation') {
        const plain = String((cuerpo.payload || {}).plainToken || '');
        return res.json({ plainToken: plain, encryptedToken: hmac(secreto, plain) });
      }
      const ts = String(req.headers['x-zm-request-timestamp'] || ''), firma = String(req.headers['x-zm-signature'] || '');
      const esperada = 'v0=' + hmac(secreto, 'v0:' + ts + ':' + crudo);
      const a = Buffer.from(firma), b = Buffer.from(esperada);
      const valida = a.length === b.length && crypto.timingSafeEqual(a, b) && Math.abs(ahora() / 1000 - Number(ts)) < 5 * 60;
      if (!valida) return res.status(401).json({ error: 'Firma inválida.' });
      try {
        const r = cuerpo.event === 'recording.completed' ? await procesarGrabacion(cuerpo) : { ignorado: true };
        res.json({ ok: true, ...r });
      } catch (e) { console.error('[zoom webhook]', e && e.message); res.json({ ok: true, error: true }); } // 200: Zoom no debe reintentar sin parar
    });
  }

  function montarRutas(app) {
    async function sesionAdmin(req, res) {
      const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
      let d; try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
      if (!esAdminPorToken(d)) { res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' }); return null; }
      return d;
    }
    const envolver = (etiqueta, fn) => async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      try { const d = await sesionAdmin(req, res); if (!d) return; await fn(req, res, d); }
      catch (e) {
        if (e && e.status) return res.status(e.status).json({ error: e.message });
        console.error('[clases-auto ' + etiqueta + ']', e && e.message); res.status(500).json({ error: 'No se pudo completar la operación.' });
      }
    };

    app.post('/api/admin/clases-auto/zoom', envolver('zoom', async (req, res, d) => {
      const b = req.body || {}, claseId = idClase(b.id), date = texto(b.date, 10), time = texto(b.time, 5), titulo = texto(b.title, 160);
      if (!titulo) throw errorHttp(400, 'El título es obligatorio.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw errorHttp(400, 'Escribe la fecha y la hora de la clase.');
      const duracion = Math.max(15, Math.min(480, Math.round(Number(b.duration)) || 60));
      const m = await zoom('/users/' + encodeURIComponent(env.ZOOM_HOST_EMAIL || '') + '/meetings', {
        method: 'POST',
        body: JSON.stringify({
          topic: titulo, type: 2, start_time: date + 'T' + time + ':00', timezone: 'America/Mexico_City', duration: duracion,
          settings: { auto_recording: 'cloud', join_before_host: false, waiting_room: false, mute_upon_entry: true, participant_video: false, host_video: true }
        })
      });
      const meetingId = String(m.id || '');
      if (!meetingId || !m.join_url) throw errorHttp(502, 'Zoom no devolvió la reunión.');
      await db.collection(COL).doc(meetingId).set({ meetingId, claseId, titulo, fecha: date + ' ' + time, estado: 'esperando', error: '', creado: new Date(ahora()).toISOString(), por: texto(d.email, 200) });
      res.json({ ok: true, meetingId, joinUrl: m.join_url, startUrl: m.start_url || '' });
    }));

    app.post('/api/admin/clases-auto/meet', envolver('meet', async (req, res, d) => {
      const b = req.body || {}, claseId = idClase(b.id), date = texto(b.date, 10), time = texto(b.time, 5), titulo = texto(b.title, 160);
      if (!titulo) throw errorHttp(400, 'El título es obligatorio.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw errorHttp(400, 'Escribe la fecha y la hora de la clase.');
      const duracion = Math.max(15, Math.min(480, Math.round(Number(b.duration)) || 60));
      const sp = await google(MEET_API + '/spaces', { method: 'POST', body: JSON.stringify({ config: { accessType: 'OPEN', entryPointAccess: 'ALL', artifactConfig: { recordingConfig: { autoRecordingGeneration: 'ON' } } } }) });
      const spaceName = String(sp.name || '');
      if (!/^spaces\/[A-Za-z0-9_-]+$/.test(spaceName) || !sp.meetingUri) throw errorHttp(502, 'Google no devolvió la reunión de Meet.');
      const inicioMs = Date.parse(date + 'T' + time + ':00-06:00') || 0, id = 'meet-' + spaceName.slice(7);
      await db.collection(COL).doc(id).set({ proveedor: 'meet', meetingId: id, spaceName, claseId, titulo, fecha: date + ' ' + time, inicioMs, finMs: inicioMs + duracion * 60000, estado: 'esperando', error: '', creado: new Date(ahora()).toISOString(), por: texto(d.email, 200) });
      res.json({ ok: true, meetingId: id, joinUrl: sp.meetingUri, startUrl: '' });
    }));

    app.post('/api/admin/clases-auto/drive', envolver('drive', async (req, res, d) => {
      const b = req.body || {}, claseId = idClase(b.id), date = texto(b.date, 10), time = texto(b.time, 5), titulo = texto(b.title, 160);
      let enlace = texto(b.link, 500);
      if (!titulo) throw errorHttp(400, 'El título es obligatorio.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw errorHttp(400, 'Escribe la fecha y la hora de la clase.');
      if (enlace && !codigoMeet(enlace)) throw errorHttp(400, 'El enlace tiene que ser de Google Meet (por ejemplo https://meet.google.com/abc-defg-hij). Déjalo vacío para que se cree solo.');
      if (!meetListo()) throw errorHttp(503, 'Falta conectar la cuenta de Google en el servidor (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN).');
      const duracion = Math.max(15, Math.min(480, Math.round(Number(b.duration)) || 60)), inicioMs = Date.parse(date + 'T' + time + ':00-06:00') || 0, id = 'drive-' + claseId;
      const creado = !enlace;
      if (creado) enlace = await crearEnlaceMeetConCalendar({ titulo, inicioMs, duracion, descripcion: texto(b.desc, 500) });
      const codigo = codigoMeet(enlace);
      await db.collection(COL).doc(id).set({ proveedor: 'drive', meetingId: id, codigo, claseId, titulo, fecha: date + ' ' + time, inicioMs, finMs: inicioMs + duracion * 60000, estado: 'esperando', error: '', creado: new Date(ahora()).toISOString(), por: texto(d.email, 200) });
      res.json({ ok: true, meetingId: id, joinUrl: enlace, startUrl: '', creado });
    }));

    app.get('/api/admin/clases-auto', envolver('lista', async (req, res) => {
      await refrescarPendientes();
      const sn = await db.collection(COL).limit(100).get();
      const entradas = sn.docs.map(x => ({ ...(x.data() || {}), id: x.id })).sort((p, q) => String(q.creado || '').localeCompare(String(p.creado || '')));
      res.json({ ok: true, entradas, zoomListo: zoomListo(), meetListo: meetListo(), bunnyListo: bunnyListo() });
    }));

    app.post('/api/admin/clases-auto/:id/reintentar', envolver('reintentar', async (req, res) => {
      const id = idReunion(req.params.id), s = await db.collection(COL).doc(id).get();
      if (!s.exists) throw errorHttp(404, 'No encontramos esa reunión.');
      if (['meet', 'drive'].includes((s.data() || {}).proveedor)) { await marcar(id, { estado: 'esperando', error: '', inicioMs: 0 }); revisarMeet().catch(() => {}); return res.json({ ok: true }); } // se vuelve a buscar en la próxima revisión
      const r = await zoom('/meetings/' + encodeURIComponent(id) + '/recordings', { method: 'GET' });
      const archivo = elegirArchivo(r.recording_files);
      if (!archivo) throw errorHttp(404, 'Zoom todavía no tiene una grabación MP4 de esta reunión.');
      await subirABunny(id, s.data() || {}, archivo, await accesoZoom());
      res.json({ ok: true });
    }));
  }

  return { montarWebhook, montarRutas, refrescarPendientes, revisarMeet, iniciarRevision, firmarEmbed: id => firmarEmbed(id, env, ahora()), procesarGrabacion };
}

module.exports = { crearClasesAuto, firmarEmbed, elegirArchivo };
