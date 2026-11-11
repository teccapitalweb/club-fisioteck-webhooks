'use strict';
// CLASES EN VIVO AUTOMÁTICAS: Zoom (reunión con grabación) → Bunny → grabación lista y reproducible (Zoom y Bunny simulados)
process.env.ADMIN_EMAILS = 'jefa@fisioteck.test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { crearClasesAuto, firmarEmbed, elegirArchivo } = require('../services/clases-auto');
const { montarRutasWebinars } = require('../services/webinars');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla || {}));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { const nuevo = JSON.parse(JSON.stringify(v)); datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...nuevo } : nuevo); },
    async delete() { datos.delete(ruta); },
    collection: n => col(ruta + '/' + n), doc: n => ref(ruta + '/' + n)
  });
  const col = nombre => {
    let lim = 1e9;
    const q = {
      doc: id => ref(nombre + '/' + id), limit(n) { lim = n; return q; },
      async get() {
        const prof = nombre.split('/').length + 1;
        const docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === prof).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        return { docs: docs.slice(0, lim), empty: !docs.length };
      }
    };
    return q;
  };
  return { collection: col, datos };
}

const ENV = { ZOOM_ACCOUNT_ID: 'acc', ZOOM_CLIENT_ID: 'cid', ZOOM_CLIENT_SECRET: 'sec', ZOOM_HOST_EMAIL: 'host@fisioteck.test', ZOOM_WEBHOOK_SECRET_TOKEN: 'secreto-webhook',
  BUNNY_STREAM_LIBRARY_ID: '1234', BUNNY_STREAM_API_KEY: 'api-key', BUNNY_STREAM_TOKEN_KEY: 'token-key' };
const tokens = { jefa: { uid: 'jefa', email: 'jefa@fisioteck.test', email_verified: true }, ana: { uid: 'ana' }, gratis: { uid: 'gratis' } };
const VIDEO = '5f2b8a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

// Zoom y Bunny simulados: guardan lo que reciben y responden lo que se configure
function fakeRed(cfg) {
  const llamadas = [];
  const fn = async (url, opts = {}) => {
    llamadas.push({ url: String(url), metodo: opts.method || 'GET', cuerpo: opts.body ? JSON.parse(opts.body) : null, cab: opts.headers || {} });
    const resp = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json });
    const u = String(url);
    if (u.startsWith('https://zoom.us/oauth/token')) return resp(200, { access_token: 'zoom-token', expires_in: 3600 });
    if (u.includes('/meetings') && opts.method === 'POST') return resp(201, { id: 91234567890, join_url: 'https://zoom.us/j/91234567890?pwd=x', start_url: 'https://zoom.us/s/91234567890?zak=y' });
    if (u.includes('/recordings')) return resp(200, { recording_files: cfg.archivos || [] });
    if (u.includes('/videos/fetch')) return cfg.bunnyFetch ? resp(cfg.bunnyFetch.status, cfg.bunnyFetch.json) : resp(200, { success: true, id: VIDEO });
    if (u.includes('/videos/' + VIDEO)) return resp(200, { status: cfg.estadoBunny == null ? 4 : cfg.estadoBunny });
    return resp(404, {});
  };
  fn.llamadas = llamadas;
  return fn;
}

async function levantar(cfg = {}, semilla = {}, env = ENV) {
  const db = fakeDb({ 'members/ana': { status: 'active' }, 'members/gratis': { status: 'inactive' }, ...semilla });
  const app = express();
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const red = fakeRed(cfg);
  const clasesAuto = crearClasesAuto({ db, admin, env, fetch: red });
  clasesAuto.montarWebhook(app); // antes de express.json(), igual que en server.js
  app.use(express.json());
  clasesAuto.montarRutas(app);
  montarRutasWebinars(app, { db, admin, tieneMembresia: m => m.status === 'active', clasesAuto });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, quien, metodo) => { const r = await fetch(base + ruta, { method: metodo || (cuerpo ? 'POST' : 'GET'), headers: { Authorization: quien ? 'Bearer ' + quien : '', 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json().catch(() => ({})) }; };
  const zoomEvento = async (evento, { firmar = true, ts = Math.floor(Date.now() / 1000), secreto = ENV.ZOOM_WEBHOOK_SECRET_TOKEN } = {}) => {
    const crudo = JSON.stringify(evento);
    const cab = { 'Content-Type': 'application/json', 'x-zm-request-timestamp': String(ts) };
    cab['x-zm-signature'] = firmar ? 'v0=' + crypto.createHmac('sha256', secreto).update('v0:' + ts + ':' + crudo).digest('hex') : 'v0=mal';
    const r = await fetch(base + '/api/zoom/webhook', { method: 'POST', headers: cab, body: crudo });
    return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
  };
  return { db, red, llamar, zoomEvento, clasesAuto, cerrar: () => srv.close() };
}
const grabacion = (id, archivos) => ({ event: 'recording.completed', download_token: 'dl-token', payload: { object: { id, uuid: 'u', topic: 'Clase', recording_files: archivos || [
  { id: 'a1', file_type: 'M4A', recording_type: 'audio_only', status: 'completed', download_url: 'https://zoom.us/rec/download/audio' },
  { id: 'v1', file_type: 'MP4', recording_type: 'shared_screen_with_speaker_view', status: 'completed', download_url: 'https://zoom.us/rec/download/video' }] } } });
const HOY = { id: 'prueba-1', title: 'Prueba de Zoom', date: '2026-12-01', time: '18:00', duration: 60 };

test('zoom: el administrador crea la reunión con grabación en la nube y queda registrada; un miembro no puede', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/clases-auto/zoom', HOY, 'ana')).status, 403);
    assert.equal((await s.llamar('/api/admin/clases-auto/zoom', { ...HOY, time: '6pm' }, 'jefa')).status, 400);
    const r = await s.llamar('/api/admin/clases-auto/zoom', HOY, 'jefa');
    assert.equal(r.status, 200); assert.equal(r.cuerpo.meetingId, '91234567890'); assert.match(r.cuerpo.joinUrl, /^https:\/\/zoom\.us\/j\//);
    const crear = s.red.llamadas.find(l => l.metodo === 'POST' && l.url.includes('/meetings'));
    assert.ok(crear.url.includes('host%40fisioteck.test'), 'se crea con la cuenta organizadora de la consultora');
    assert.equal(crear.cuerpo.settings.auto_recording, 'cloud'); assert.equal(crear.cuerpo.timezone, 'America/Mexico_City'); assert.equal(crear.cuerpo.start_time, '2026-12-01T18:00:00');
    assert.equal(crear.cab.Authorization, 'Bearer zoom-token');
    const guardada = s.db.datos.get('clasesAuto/91234567890');
    assert.equal(guardada.claseId, 'prueba-1'); assert.equal(guardada.estado, 'esperando');
  } finally { s.cerrar(); }
});

test('zoom: sin las credenciales de Zoom en el servidor responde 503 con un mensaje claro', async () => {
  const s = await levantar({}, {}, { ...ENV, ZOOM_CLIENT_SECRET: '' });
  try {
    const r = await s.llamar('/api/admin/clases-auto/zoom', HOY, 'jefa');
    assert.equal(r.status, 503); assert.match(r.cuerpo.error, /Falta configurar Zoom/);
  } finally { s.cerrar(); }
});

test('webhook: valida el endpoint, rechaza firmas falsas y avisos viejos', async () => {
  const s = await levantar();
  try {
    const v = await s.zoomEvento({ event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } }, { firmar: false });
    assert.equal(v.cuerpo.plainToken, 'abc123');
    assert.equal(v.cuerpo.encryptedToken, crypto.createHmac('sha256', ENV.ZOOM_WEBHOOK_SECRET_TOKEN).update('abc123').digest('hex'));
    assert.equal((await s.zoomEvento(grabacion('91234567890'), { firmar: false })).status, 401);
    assert.equal((await s.zoomEvento(grabacion('91234567890'), { secreto: 'otro' })).status, 401);
    assert.equal((await s.zoomEvento(grabacion('91234567890'), { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401, 'un aviso de hace una hora ya no vale');
    assert.equal(s.red.llamadas.filter(l => l.url.includes('videos/fetch')).length, 0);
  } finally { s.cerrar(); }
});

test('grabación: Zoom avisa, Bunny descarga el MP4, y al terminar la clase queda con su video (una sola vez aunque Zoom repita el aviso)', async () => {
  const s = await levantar();
  try {
    await s.llamar('/api/admin/clases-auto/zoom', HOY, 'jefa');
    assert.equal((await s.zoomEvento(grabacion('55555555'))).cuerpo.ignorado, true, 'una reunión ajena se ignora');
    const r = await s.zoomEvento(grabacion('91234567890'));
    assert.equal(r.status, 200); assert.equal(r.cuerpo.ok, true);
    const fetchBunny = s.red.llamadas.filter(l => l.url.includes('/videos/fetch'));
    assert.equal(fetchBunny.length, 1);
    assert.ok(fetchBunny[0].cuerpo.url.startsWith('https://zoom.us/rec/download/video?access_token=dl-token'), 'se elige el MP4 y se usa el token de descarga de Zoom');
    assert.equal(fetchBunny[0].cab.AccessKey, 'api-key');
    assert.equal(s.db.datos.get('clasesAuto/91234567890').estado, 'subiendo');
    assert.equal((await s.zoomEvento(grabacion('91234567890'))).cuerpo.repetido, true);
    assert.equal(s.red.llamadas.filter(l => l.url.includes('/videos/fetch')).length, 1, 'el aviso repetido no sube el video otra vez');
    // todavía procesando: la clase aún no tiene video
    assert.equal(s.db.datos.get('clasesPrueba/prueba-1'), undefined);
    // el administrador abre el panel: se revisa Bunny, que ya terminó
    const lista = await s.llamar('/api/admin/clases-auto', null, 'jefa');
    assert.equal(lista.cuerpo.entradas[0].estado, 'lista'); assert.equal(lista.cuerpo.zoomListo, true);
    assert.equal(s.db.datos.get('clasesPrueba/prueba-1').grabacionVideoId, VIDEO);
  } finally { s.cerrar(); }
});

test('grabación: una clase real queda enlazada en webinarsPrivados y el panel no la borra al guardar el enlace', async () => {
  const s = await levantar();
  try {
    await s.llamar('/api/admin/clases-auto/zoom', { ...HOY, id: '1730000000' }, 'jefa');
    await s.zoomEvento(grabacion('91234567890'));
    await s.clasesAuto.refrescarPendientes();
    assert.equal(s.db.datos.get('webinarsPrivados/1730000000').grabacionVideoId, VIDEO);
    // el administrador edita la clase y vuelve a guardar el enlace: la grabación automática se conserva
    await s.llamar('/api/admin/webinars-enlaces', { id: '1730000000', titulo: 'Clase', link: 'https://zoom.us/j/91234567890' }, 'jefa');
    assert.equal(s.db.datos.get('webinarsPrivados/1730000000').grabacionVideoId, VIDEO);
    assert.equal(s.db.datos.get('webinarsPrivados/1730000000').link, 'https://zoom.us/j/91234567890');
    // y vaciar el enlace tampoco la borra, porque ya hay grabación
    await s.llamar('/api/admin/webinars-enlaces', { id: '1730000000', titulo: 'Clase' }, 'jefa');
    assert.ok(s.db.datos.get('webinarsPrivados/1730000000'));
  } finally { s.cerrar(); }
});

test('grabación: errores visibles (sin MP4, Bunny rechaza, Bunny falla al procesar) y reintento', async () => {
  const s1 = await levantar();
  try {
    await s1.llamar('/api/admin/clases-auto/zoom', HOY, 'jefa');
    await s1.zoomEvento(grabacion('91234567890', [{ id: 'a', file_type: 'M4A', status: 'completed', download_url: 'https://zoom.us/x' }]));
    assert.match(s1.db.datos.get('clasesAuto/91234567890').error, /no incluye un archivo MP4/);
  } finally { s1.cerrar(); }
  const s2 = await levantar({ bunnyFetch: { status: 401, json: {} } });
  try {
    await s2.llamar('/api/admin/clases-auto/zoom', HOY, 'jefa');
    await s2.zoomEvento(grabacion('91234567890'));
    const e = s2.db.datos.get('clasesAuto/91234567890'); assert.equal(e.estado, 'error'); assert.match(e.error, /API Key/);
  } finally { s2.cerrar(); }
  const s3 = await levantar({ estadoBunny: 5, archivos: [{ id: 'v2', file_type: 'MP4', recording_type: 'active_speaker', status: 'completed', download_url: 'https://zoom.us/rec/download/v2' }] });
  try {
    await s3.llamar('/api/admin/clases-auto/zoom', HOY, 'jefa');
    await s3.zoomEvento(grabacion('91234567890'));
    await s3.clasesAuto.refrescarPendientes();
    assert.equal(s3.db.datos.get('clasesAuto/91234567890').estado, 'error');
    const re = await s3.llamar('/api/admin/clases-auto/91234567890/reintentar', {}, 'jefa');
    assert.equal(re.status, 200);
    const sube = s3.red.llamadas.filter(l => l.url.includes('/videos/fetch')).pop();
    assert.ok(sube.cuerpo.url.includes('rec/download/v2?access_token=zoom-token'), 'el reintento pide el archivo a Zoom con el token de la app');
    assert.equal(s3.db.datos.get('clasesAuto/91234567890').estado, 'subiendo');
    assert.equal((await s3.llamar('/api/admin/clases-auto/91234567890/reintentar', {}, 'ana')).status, 403);
  } finally { s3.cerrar(); }
});

test('reproducción: el miembro recibe un enlace firmado de Bunny; sin plan no; la prueba solo la ve un administrador', async () => {
  const s = await levantar({}, {
    'webinarsPrivados/1730000000': { link: 'https://zoom.us/j/1', grabacionVideoId: VIDEO },
    'webinarsPrivados/1730000001': { link: 'https://zoom.us/j/2', recordingUrl: 'https://drive.google.com/file/d/xyz/view' },
    'clasesPrueba/prueba-7': { title: 'P', grabacionVideoId: VIDEO }
  });
  try {
    const ok = await s.llamar('/api/webinars/1730000000/enlace?tipo=grabacion', null, 'ana');
    assert.equal(ok.status, 200); assert.equal(ok.cuerpo.embed, true);
    assert.match(ok.cuerpo.url, new RegExp('^https://iframe\\.mediadelivery\\.net/embed/1234/' + VIDEO + '\\?token=[0-9a-f]{64}&expires=\\d+$'));
    const drive = await s.llamar('/api/webinars/1730000001/enlace?tipo=grabacion', null, 'ana');
    assert.equal(drive.cuerpo.url, 'https://drive.google.com/file/d/xyz/view'); assert.equal(drive.cuerpo.embed, undefined);
    assert.equal((await s.llamar('/api/webinars/1730000000/enlace?tipo=grabacion', null, 'gratis')).status, 402);
    assert.equal((await s.llamar('/api/webinars/prueba-7/enlace?tipo=grabacion', null, 'ana')).status, 404, 'una clase de prueba no se abre a un miembro');
    assert.equal((await s.llamar('/api/webinars/prueba-7/enlace?tipo=grabacion', null, 'jefa')).cuerpo.embed, true);
    const ids = (await s.llamar('/api/webinars/grabaciones', null, 'ana')).cuerpo.ids.sort();
    assert.deepEqual(ids, ['1730000000', '1730000001'], 'el miembro no ve las pruebas');
    assert.ok((await s.llamar('/api/webinars/grabaciones', null, 'jefa')).cuerpo.ids.includes('prueba-7'));
    assert.deepEqual((await s.llamar('/api/webinars/grabaciones', null, 'gratis')).cuerpo.ids, []);
  } finally { s.cerrar(); }
});

test('utilidades: firma de reproducción y elección del archivo de Zoom', () => {
  const url = firmarEmbed(VIDEO, ENV, 1700000000000);
  const esperado = crypto.createHash('sha256').update('token-key' + VIDEO + (1700000000 + 900)).digest('hex');
  assert.ok(url.includes('token=' + esperado) && url.includes('expires=1700000900'));
  assert.equal(firmarEmbed(VIDEO, { ...ENV, BUNNY_STREAM_TOKEN_KEY: '' }), null);
  assert.equal(firmarEmbed('no-es-un-video', ENV), null);
  const f = elegirArchivo([{ id: 1, file_type: 'MP4', recording_type: 'gallery_view', status: 'completed', download_url: 'u1' }, { id: 2, file_type: 'MP4', recording_type: 'shared_screen_with_speaker_view', status: 'completed', download_url: 'u2' }, { id: 3, file_type: 'MP4', recording_type: 'active_speaker', status: 'processing', download_url: 'u3' }]);
  assert.equal(f.id, 2);
  assert.equal(elegirArchivo([{ id: 4, file_type: 'CHAT', download_url: 'u' }]), null);
});

test('editar una clase de prueba no borra su grabación; si un vínculo ya se perdió, la lista del administrador lo repara', async () => {
  const s = await levantar();
  try {
    await s.llamar('/api/admin/clases-auto/zoom', HOY, 'jefa');
    await s.llamar('/api/admin/clases-prueba', { id: 'prueba-1', title: 'Prueba de Zoom', date: '2026-12-01', time: '18:00', duration: 60, instructor: 'Wendo' }, 'jefa');
    await s.zoomEvento(grabacion('91234567890'));
    await s.clasesAuto.refrescarPendientes();
    assert.equal(s.db.datos.get('clasesPrueba/prueba-1').grabacionVideoId, VIDEO);
    // el administrador edita la clase (agrega la especialidad del ponente): la grabación se conserva
    const ed = await s.llamar('/api/admin/clases-prueba', { id: 'prueba-1', title: 'Prueba de Zoom', date: '2026-12-01', time: '18:00', duration: 60, instructor: 'Wendo', instructorRole: 'Fisioterapeuta general' }, 'jefa');
    assert.equal(ed.status, 200);
    const c = s.db.datos.get('clasesPrueba/prueba-1');
    assert.equal(c.instructorRole, 'Fisioterapeuta general'); assert.equal(c.grabacionVideoId, VIDEO); assert.equal(c.tieneGrabacion, true);
    // clase ya dañada por una edición antigua (sin el vínculo): la lista del administrador lo repara
    const danada = { ...c }; delete danada.grabacionVideoId; danada.tieneGrabacion = false;
    s.db.datos.set('clasesPrueba/prueba-1', danada);
    assert.equal(s.db.datos.get('clasesPrueba/prueba-1').grabacionVideoId, undefined);
    assert.equal((await s.llamar('/api/admin/clases-auto', null, 'jefa')).status, 200);
    assert.equal(s.db.datos.get('clasesPrueba/prueba-1').grabacionVideoId, VIDEO, 'el vínculo se repara');
    // si la clase ya no existe (se eliminó), no se vuelve a crear
    s.db.datos.delete('clasesPrueba/prueba-1');
    await s.llamar('/api/admin/clases-auto', null, 'jefa');
    assert.equal(s.db.datos.has('clasesPrueba/prueba-1'), false);
  } finally { s.cerrar(); }
});
