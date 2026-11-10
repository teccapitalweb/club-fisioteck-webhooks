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
//  Administrador:  POST /api/admin/clases-auto/zoom                  { id, title, date, time, duration } → { joinUrl, startUrl, meetingId }
//                  GET  /api/admin/clases-auto                       → { entradas: [...] } (estado de cada grabación; refresca las pendientes)
//                  POST /api/admin/clases-auto/:meetingId/reintentar → vuelve a pedir la grabación a Zoom y a subirla a Bunny
//  Zoom:           POST /api/zoom/webhook                            (firma HMAC; también responde la validación del endpoint)
const crypto = require('crypto');
const express = require('express');
const { esAdminPorToken } = require('./certificados');

const COL = 'clasesAuto';
const ZOOM_API = 'https://api.zoom.us/v2', ZOOM_OAUTH = 'https://zoom.us/oauth/token', BUNNY_API = 'https://video.bunnycdn.com';
const hmac = (clave, texto) => crypto.createHmac('sha256', clave).update(texto).digest('hex');
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const texto = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const idReunion = v => { const s = String(v == null ? '' : v).trim(); if (!/^\d{5,20}$/.test(s)) throw errorHttp(400, 'Identificador de reunión inválido.'); return s; };
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
    let r; try { r = await fetchFn(BUNNY_API + '/library/' + encodeURIComponent(env.BUNNY_STREAM_LIBRARY_ID) + ruta, { ...(opts || {}), headers: { AccessKey: env.BUNNY_STREAM_API_KEY, Accept: 'application/json', 'Content-Type': 'application/json' } }); }
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

    app.get('/api/admin/clases-auto', envolver('lista', async (req, res) => {
      await refrescarPendientes();
      const sn = await db.collection(COL).limit(100).get();
      const entradas = sn.docs.map(x => ({ ...(x.data() || {}), id: x.id })).sort((p, q) => String(q.creado || '').localeCompare(String(p.creado || '')));
      res.json({ ok: true, entradas, zoomListo: zoomListo(), bunnyListo: bunnyListo() });
    }));

    app.post('/api/admin/clases-auto/:id/reintentar', envolver('reintentar', async (req, res) => {
      const id = idReunion(req.params.id), s = await db.collection(COL).doc(id).get();
      if (!s.exists) throw errorHttp(404, 'No encontramos esa reunión.');
      const r = await zoom('/meetings/' + encodeURIComponent(id) + '/recordings', { method: 'GET' });
      const archivo = elegirArchivo(r.recording_files);
      if (!archivo) throw errorHttp(404, 'Zoom todavía no tiene una grabación MP4 de esta reunión.');
      await subirABunny(id, s.data() || {}, archivo, await accesoZoom());
      res.json({ ok: true });
    }));
  }

  return { montarWebhook, montarRutas, refrescarPendientes, firmarEmbed: id => firmarEmbed(id, env, ahora()), procesarGrabacion };
}

module.exports = { crearClasesAuto, firmarEmbed, elegirArchivo };
