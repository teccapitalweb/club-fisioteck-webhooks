'use strict';
// CLASES EN VIVO AUTOMÁTICAS con GOOGLE MEET: espacio con grabación automática → el servidor busca la grabación → Drive → Bunny (en flujo) → lista
// Google Meet y Drive se simulan; Bunny es un servidor HTTP local para comprobar de verdad la subida en flujo.
process.env.ADMIN_EMAILS = 'jefa@fisioteck.test';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { crearClasesAuto } = require('../services/clases-auto');

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

const VIDEO = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const CONTENIDO = Buffer.from('contenido-de-la-grabacion-'.repeat(2000)); // ~52 KB
const tokens = { jefa: { uid: 'jefa', email: 'jefa@fisioteck.test', email_verified: true }, ana: { uid: 'ana' } };

// Bunny local: recibe el PUT del video y lo guarda para compararlo
function bunnyLocal() {
  const recibido = { put: null };
  const srv = http.createServer((req, res) => {
    const partes = []; req.on('data', d => partes.push(d)); req.on('end', () => {
      recibido.put = { metodo: req.method, ruta: req.url, cab: req.headers, cuerpo: Buffer.concat(partes) };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"success":true}');
    });
  });
  return new Promise(r => srv.listen(0, () => r({ srv, recibido, base: 'http://127.0.0.1:' + srv.address().port })));
}

async function levantar(cfg = {}, env = {}) {
  const bunny = await bunnyLocal();
  const E = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', GOOGLE_REFRESH_TOKEN: 'grefresh', BUNNY_STREAM_LIBRARY_ID: '1234', BUNNY_STREAM_API_KEY: 'api-key', BUNNY_STREAM_TOKEN_KEY: 'tk', BUNNY_API_BASE: bunny.base, ...env };
  const db = fakeDb({ 'members/ana': { status: 'active' } });
  const reloj = { t: Date.parse('2026-12-01T23:00:00Z') }; // 17:00 en CDMX
  const llamadas = [];
  const fetchSim = async (url, opts = {}) => {
    const u = String(url); llamadas.push({ url: u, metodo: opts.method || 'GET', cuerpo: opts.body, cab: opts.headers || {} });
    const resp = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return cfg.tokenMalo ? resp(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) : resp(200, { access_token: 'g-token', expires_in: 3600 });
    if (u === 'https://meet.googleapis.com/v2/spaces' && opts.method === 'POST') return resp(200, { name: 'spaces/abcDEF123xyz', meetingUri: 'https://meet.google.com/abc-defg-hij', meetingCode: 'abc-defg-hij' });
    if (u.startsWith('https://meet.googleapis.com/v2/conferenceRecords?')) return resp(200, { conferenceRecords: cfg.conferencias === undefined ? [{ name: 'conferenceRecords/c1' }] : cfg.conferencias });
    if (u.endsWith('/conferenceRecords/c1/recordings')) return resp(200, { recordings: cfg.grabaciones || [] });
    if (u.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) return cfg.calendarSinPermiso ? resp(403, { error: { message: 'Request had insufficient authentication scopes.' } }) : resp(200, cfg.calendarSinEnlace ? { id: 'ev1' } : { id: 'ev1', hangoutLink: 'https://meet.google.com/zzz-yyyy-xxx' });
    if (u.startsWith('https://www.googleapis.com/drive/v3/files?') && cfg.rechazaFecha && decodeURIComponent(u).includes('createdTime >=')) { cfg.consultasDrive = (cfg.consultasDrive || []).concat(decodeURIComponent(u)); return resp(400, { error: { message: 'Invalid Value' } }); }
    if (u.startsWith('https://www.googleapis.com/drive/v3/files?') && cfg.driveListaError) return resp(400, { error: { message: 'Invalid Value' } });
    if (u.startsWith('https://www.googleapis.com/drive/v3/files?')) { cfg.consultasDrive = (cfg.consultasDrive || []).concat(decodeURIComponent(u)); return resp(200, { files: cfg.archivosDrive || [] }); }
    if (u.includes('/drive/v3/files/') && u.includes('fields=')) return cfg.driveError ? resp(403, { error: { message: 'The user does not have sufficient permissions for this file.' } }) : resp(200, { size: String(CONTENIDO.length), name: 'clase.mp4', mimeType: 'video/mp4' });
    if (u.includes('/drive/v3/files/') && u.includes('alt=media')) return { status: 200, ok: true, body: new Response(CONTENIDO).body, json: async () => ({}) };
    if (u.endsWith('/videos') && opts.method === 'POST') return resp(200, { guid: VIDEO });
    if (u.includes('/videos/' + VIDEO)) return resp(200, { status: cfg.estadoBunny == null ? 4 : cfg.estadoBunny });
    return resp(404, {});
  };
  const app = express(); app.use(express.json());
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const ca = crearClasesAuto({ db, admin, env: E, fetch: fetchSim, ahora: () => reloj.t });
  ca.montarRutas(app);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, quien, metodo) => { const r = await fetch(base + ruta, { method: metodo || (cuerpo ? 'POST' : 'GET'), headers: { Authorization: quien ? 'Bearer ' + quien : '', 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json().catch(() => ({})) }; };
  return { db, ca, reloj, llamadas, llamar, bunny, cerrar: () => { srv.close(); bunny.srv.close(); } };
}
const CLASE = { id: 'prueba-1', title: 'Prueba de Meet', date: '2026-12-01', time: '17:00', duration: 60 };
const REC = (state, ini, fin, file) => ({ name: 'conferenceRecords/c1/recordings/r' + ini, state, startTime: ini, endTime: fin, driveDestination: file ? { file, exportUri: 'https://drive.google.com/file/d/' + file + '/view' } : undefined });

test('meet: el administrador crea el espacio con grabación automática; un miembro no; sin cuenta conectada responde 503', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/clases-auto/meet', CLASE, 'ana')).status, 403);
    assert.equal((await s.llamar('/api/admin/clases-auto/meet', { ...CLASE, date: 'hoy' }, 'jefa')).status, 400);
    const r = await s.llamar('/api/admin/clases-auto/meet', CLASE, 'jefa');
    assert.equal(r.status, 200); assert.equal(r.cuerpo.joinUrl, 'https://meet.google.com/abc-defg-hij'); assert.equal(r.cuerpo.meetingId, 'meet-abcDEF123xyz');
    const crear = s.llamadas.find(l => l.url === 'https://meet.googleapis.com/v2/spaces');
    const cfg = JSON.parse(crear.cuerpo).config;
    assert.equal(cfg.artifactConfig.recordingConfig.autoRecordingGeneration, 'ON'); assert.equal(cfg.accessType, 'OPEN', 'los alumnos entran sin pedir permiso');
    assert.equal(crear.cab.Authorization, 'Bearer g-token');
    const doc = s.db.datos.get('clasesAuto/meet-abcDEF123xyz');
    assert.equal(doc.proveedor, 'meet'); assert.equal(doc.claseId, 'prueba-1'); assert.equal(doc.estado, 'esperando'); assert.equal(doc.spaceName, 'spaces/abcDEF123xyz');
    assert.equal(doc.inicioMs, Date.parse('2026-12-01T23:00:00Z')); assert.equal(doc.finMs, Date.parse('2026-12-02T00:00:00Z'));
  } finally { s.cerrar(); }
  const s2 = await levantar({}, { GOOGLE_REFRESH_TOKEN: '' });
  try {
    const r = await s2.llamar('/api/admin/clases-auto/meet', CLASE, 'jefa');
    assert.equal(r.status, 503); assert.match(r.cuerpo.error, /conectar la cuenta de Google/);
    assert.equal((await s2.llamar('/api/admin/clases-auto', null, 'jefa')).cuerpo.meetListo, false);
  } finally { s2.cerrar(); }
  const s3 = await levantar({ tokenMalo: true });
  try {
    const r = await s3.llamar('/api/admin/clases-auto/meet', CLASE, 'jefa');
    assert.equal(r.status, 502); assert.match(r.cuerpo.error, /volver a conectarla/);
  } finally { s3.cerrar(); }
});

test('meet: la grabación se detecta sola, pasa de Drive a Bunny sin cambios y queda enlazada con la clase', async () => {
  const s = await levantar({ grabaciones: [
    REC('STARTED', '2026-12-01T23:00:00Z', '2026-12-01T23:02:00Z', 'archivo-corto'),
    REC('FILE_GENERATED', '2026-12-01T23:00:00Z', '2026-12-01T23:05:00Z', 'corta-1'),
    REC('FILE_GENERATED', '2026-12-01T23:10:00Z', '2026-12-02T00:00:00Z', 'larga-2')] });
  try {
    await s.llamar('/api/admin/clases-auto/meet', CLASE, 'jefa');
    s.reloj.t = Date.parse('2026-12-01T22:00:00Z'); await s.ca.revisarMeet();
    assert.equal(s.db.datos.get('clasesAuto/meet-abcDEF123xyz').estado, 'esperando', 'antes de la hora no se busca nada');
    assert.equal(s.llamadas.filter(l => l.url.includes('conferenceRecords')).length, 0);
    s.reloj.t = Date.parse('2026-12-02T00:10:00Z'); await s.ca.revisarMeet();
    const e = s.db.datos.get('clasesAuto/meet-abcDEF123xyz');
    assert.equal(e.estado, 'subiendo'); assert.equal(e.videoId, VIDEO); assert.equal(e.archivoDrive, 'larga-2', 'se elige la grabación más larga que ya está generada');
    assert.ok(s.llamadas.some(l => l.url.includes('/files/larga-2?alt=media')));
    const put = s.bunny.recibido.put;
    assert.equal(put.metodo, 'PUT'); assert.equal(put.ruta, '/library/1234/videos/' + VIDEO);
    assert.equal(put.cab.accesskey, 'api-key'); assert.equal(Number(put.cab['content-length']), CONTENIDO.length);
    assert.ok(put.cuerpo.equals(CONTENIDO), 'Bunny recibió exactamente los bytes de la grabación');
    // sin repetir: otra revisión no vuelve a subirla
    s.bunny.recibido.put = null; await s.ca.revisarMeet(); assert.equal(s.bunny.recibido.put, null);
    // Bunny termina de procesarla
    await s.ca.refrescarPendientes();
    assert.equal(s.db.datos.get('clasesAuto/meet-abcDEF123xyz').estado, 'lista');
    assert.equal(s.db.datos.get('clasesPrueba/prueba-1').grabacionVideoId, VIDEO);
  } finally { s.cerrar(); }
});

test('meet: sin grabación todavía se sigue esperando; si Google falla queda el error a la vista; reintentar lo vuelve a buscar; a las 48 h se avisa', async () => {
  const s1 = await levantar({ grabaciones: [REC('ENDED', '2026-12-01T23:00:00Z', '2026-12-02T00:00:00Z', null)] });
  try {
    await s1.llamar('/api/admin/clases-auto/meet', CLASE, 'jefa');
    s1.reloj.t = Date.parse('2026-12-02T00:30:00Z'); await s1.ca.revisarMeet();
    assert.equal(s1.db.datos.get('clasesAuto/meet-abcDEF123xyz').estado, 'esperando', 'el archivo aún no se genera: se espera');
    s1.reloj.t = Date.parse('2026-12-04T01:00:00Z'); await s1.ca.revisarMeet();
    const e = s1.db.datos.get('clasesAuto/meet-abcDEF123xyz'); assert.equal(e.estado, 'error'); assert.match(e.error, /48 horas/);
  } finally { s1.cerrar(); }
  const s2 = await levantar({ grabaciones: [REC('FILE_GENERATED', '2026-12-01T23:00:00Z', '2026-12-02T00:00:00Z', 'f1')], driveError: true });
  try {
    await s2.llamar('/api/admin/clases-auto/meet', CLASE, 'jefa');
    s2.reloj.t = Date.parse('2026-12-02T00:10:00Z'); await s2.ca.revisarMeet();
    const e = s2.db.datos.get('clasesAuto/meet-abcDEF123xyz'); assert.equal(e.estado, 'error'); assert.match(e.error, /permisos|permissions|403/);
    assert.equal((await s2.llamar('/api/admin/clases-auto/meet-abcDEF123xyz/reintentar', {}, 'ana')).status, 403);
    const re = await s2.llamar('/api/admin/clases-auto/meet-abcDEF123xyz/reintentar', {}, 'jefa');
    assert.equal(re.status, 200);
    await new Promise(r => setTimeout(r, 100)); // el reintento arranca la búsqueda en segundo plano (vuelve a fallar con el mismo permiso)
    assert.equal(s2.db.datos.get('clasesAuto/meet-abcDEF123xyz').estado, 'error');
  } finally { s2.cerrar(); }
});

// ---------- Meet con una cuenta de Gmail (sin Workspace): se vigila el Drive ----------
const ENLACE = 'https://meet.google.com/abc-defg-hij';
const ARCH = (id, nombre, creado, size = '5000') => ({ id, name: nombre, size, createdTime: creado });

test('drive: el administrador registra la clase con su enlace de Meet; se valida el enlace y que la cuenta de Google esté conectada', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/clases-auto/drive', { ...CLASE, link: ENLACE }, 'ana')).status, 403);
    assert.equal((await s.llamar('/api/admin/clases-auto/drive', { ...CLASE, link: 'https://zoom.us/j/123' }, 'jefa')).status, 400, 'tiene que ser un enlace de Meet');
    const r = await s.llamar('/api/admin/clases-auto/drive', { ...CLASE, link: ENLACE + '?authuser=0' }, 'jefa');
    assert.equal(r.status, 200); assert.equal(r.cuerpo.meetingId, 'drive-prueba-1');
    const doc = s.db.datos.get('clasesAuto/drive-prueba-1');
    assert.equal(doc.proveedor, 'drive'); assert.equal(doc.codigo, 'abc-defg-hij'); assert.equal(doc.claseId, 'prueba-1'); assert.equal(doc.estado, 'esperando');
    assert.equal(s.llamadas.filter(l => l.url.includes('meet.googleapis.com')).length, 0, 'no usa la API de Meet: solo el Drive');
  } finally { s.cerrar(); }
  const s2 = await levantar({}, { GOOGLE_REFRESH_TOKEN: '' });
  try { assert.equal((await s2.llamar('/api/admin/clases-auto/drive', { ...CLASE, link: ENLACE }, 'jefa')).status, 503); } finally { s2.cerrar(); }
});

test('drive: encuentra el MP4 de la clase por el código del enlace, lo pasa a Bunny en flujo y queda enlazado; ignora lo de otras reuniones', async () => {
  const cfg = { archivosDrive: [
    ARCH('otra-reunion', 'xyz-qwer-tyu (2026-12-01 17:00 GMT-6) - Recording.mp4', '2026-12-01T23:30:00Z'),
    ARCH('la-nuestra', 'abc-defg-hij (2026-12-01 17:02 GMT-6) - Recording.mp4', '2026-12-02T00:20:00Z'),
    ARCH('vacio', 'abc-defg-hij (2026-12-01 17:02 GMT-6) - Recording.mp4', '2026-12-02T00:21:00Z', '0'),
    ARCH('de-la-semana-siguiente', 'abc-defg-hij (2026-12-09 17:00 GMT-6) - Recording.mp4', '2026-12-09T23:30:00Z')] };
  const s = await levantar(cfg);
  try {
    await s.llamar('/api/admin/clases-auto/drive', { ...CLASE, link: ENLACE }, 'jefa');
    s.reloj.t = Date.parse('2026-12-01T22:00:00Z'); await s.ca.revisarMeet();
    assert.equal(s.db.datos.get('clasesAuto/drive-prueba-1').estado, 'esperando'); assert.equal((cfg.consultasDrive || []).length, 0, 'antes de la hora no se consulta el Drive');
    s.reloj.t = Date.parse('2026-12-02T00:30:00Z'); await s.ca.revisarMeet();
    const consulta = cfg.consultasDrive[0];
    assert.ok(consulta.includes("mimeType = 'video/mp4'") && consulta.includes("createdTime >= '2026-12-01T22:30:00Z'"), 'busca MP4 creados desde 30 min antes de la clase (fecha sin milisegundos)');
    assert.ok(!consulta.includes('orderBy') && !consulta.includes('includeItemsFromAllDrives'), 'consulta sencilla: sin orden ni unidades compartidas');
    const e = s.db.datos.get('clasesAuto/drive-prueba-1');
    assert.equal(e.estado, 'subiendo'); assert.equal(e.archivoDrive, 'la-nuestra'); assert.equal(e.videoId, VIDEO);
    assert.ok(s.bunny.recibido.put.cuerpo.equals(CONTENIDO));
    await s.ca.refrescarPendientes();
    assert.equal(s.db.datos.get('clasesAuto/drive-prueba-1').estado, 'lista'); assert.equal(s.db.datos.get('clasesPrueba/prueba-1').grabacionVideoId, VIDEO);
  } finally { s.cerrar(); }
});

test('drive: sin código en el nombre usa el único video del horario; si hay varios no adivina y lo deja a la vista; sin video espera y a las 48 h avisa', async () => {
  const s1 = await levantar({ archivosDrive: [ARCH('unico', 'Reunión sin título (2026-12-01 17:00 GMT-6).mp4', '2026-12-02T00:20:00Z')] });
  try {
    await s1.llamar('/api/admin/clases-auto/drive', { ...CLASE, link: ENLACE }, 'jefa');
    s1.reloj.t = Date.parse('2026-12-02T00:30:00Z'); await s1.ca.revisarMeet();
    assert.equal(s1.db.datos.get('clasesAuto/drive-prueba-1').archivoDrive, 'unico');
  } finally { s1.cerrar(); }
  const s2 = await levantar({ archivosDrive: [ARCH('a', 'una cosa.mp4', '2026-12-02T00:10:00Z'), ARCH('b', 'otra cosa.mp4', '2026-12-02T00:20:00Z')] });
  try {
    await s2.llamar('/api/admin/clases-auto/drive', { ...CLASE, link: ENLACE }, 'jefa');
    s2.reloj.t = Date.parse('2026-12-02T00:30:00Z'); await s2.ca.revisarMeet();
    const e = s2.db.datos.get('clasesAuto/drive-prueba-1'); assert.equal(e.estado, 'error'); assert.match(e.error, /Hay 2 grabaciones/);
    assert.equal(s2.bunny.recibido.put, null, 'no se sube nada si hay duda');
  } finally { s2.cerrar(); }
  const s3 = await levantar({ archivosDrive: [] });
  try {
    await s3.llamar('/api/admin/clases-auto/drive', { ...CLASE, link: ENLACE }, 'jefa');
    s3.reloj.t = Date.parse('2026-12-02T00:30:00Z'); await s3.ca.revisarMeet();
    assert.equal(s3.db.datos.get('clasesAuto/drive-prueba-1').estado, 'esperando');
    s3.reloj.t = Date.parse('2026-12-04T01:00:00Z'); await s3.ca.revisarMeet();
    const e = s3.db.datos.get('clasesAuto/drive-prueba-1'); assert.equal(e.estado, 'error'); assert.match(e.error, /no apareció ninguna grabación nueva en el Drive/);
  } finally { s3.cerrar(); }
});

test('drive: sin enlace, el servidor crea la reunión de Meet solo (evento de Calendar) y la registra; los errores de permiso se explican', async () => {
  const s = await levantar();
  try {
    const r = await s.llamar('/api/admin/clases-auto/drive', { ...CLASE, desc: 'Clase de prueba' }, 'jefa');
    assert.equal(r.status, 200); assert.equal(r.cuerpo.joinUrl, 'https://meet.google.com/zzz-yyyy-xxx'); assert.equal(r.cuerpo.creado, true);
    const ev = s.llamadas.find(l => l.url.includes('/calendar/v3/') && l.metodo === 'POST');
    assert.ok(ev.url.includes('conferenceDataVersion=1'));
    const cuerpo = JSON.parse(ev.cuerpo);
    assert.equal(cuerpo.summary, 'Prueba de Meet'); assert.equal(cuerpo.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
    assert.equal(cuerpo.start.dateTime, '2026-12-01T23:00:00.000Z'); assert.equal(cuerpo.end.dateTime, '2026-12-02T00:00:00.000Z'); assert.equal(cuerpo.attendees, undefined, 'no invita a nadie');
    assert.equal(ev.cab.Authorization, 'Bearer g-token');
    assert.equal(s.db.datos.get('clasesAuto/drive-prueba-1').codigo, 'zzz-yyyy-xxx');
    // con un enlace puesto a mano no crea nada en Calendar
    s.llamadas.length = 0;
    const m = await s.llamar('/api/admin/clases-auto/drive', { ...CLASE, id: 'prueba-2', link: ENLACE }, 'jefa');
    assert.equal(m.cuerpo.creado, false); assert.equal(s.llamadas.filter(l => l.url.includes('/calendar/')).length, 0);
  } finally { s.cerrar(); }
  const s2 = await levantar({ calendarSinPermiso: true });
  try {
    const r = await s2.llamar('/api/admin/clases-auto/drive', CLASE, 'jefa');
    assert.equal(r.status, 502); assert.match(r.cuerpo.error, /falta el permiso de Calendar/);
    assert.equal(s2.db.datos.get('clasesAuto/drive-prueba-1'), undefined, 'si no se pudo crear la reunión no se registra nada');
  } finally { s2.cerrar(); }
  const s3 = await levantar({ calendarSinEnlace: true });
  try { assert.equal((await s3.llamar('/api/admin/clases-auto/drive', CLASE, 'jefa')).status, 502); } finally { s3.cerrar(); }
});

test('drive: caso real de Meet con Calendar: el video se llama como el TÍTULO de la clase, no como el código; se ignoran videos ajenos y de otros días', async () => {
  const cfg = { archivosDrive: [
    { id: 'ajeno', name: 'PRUEBA 2 - 2026/11/10 12:47 CST - Recording', size: '9000', createdTime: '2026-12-02T00:10:00Z', ownedByMe: false },
    { id: 'real', name: 'PRUEBA 2 - 2026/12/01 17:02 CST - Recording', size: '5000', createdTime: '2026-12-02T00:08:00Z', ownedByMe: true },
    { id: 'otra-clase', name: 'CLASE 4 Y 5. - Recording', size: '7000', createdTime: '2026-12-02T00:05:00Z', ownedByMe: true }] };
  const s = await levantar(cfg);
  try {
    await s.llamar('/api/admin/clases-auto/drive', { ...CLASE, title: 'PRUEBA 2', link: ENLACE }, 'jefa');
    s.reloj.t = Date.parse('2026-12-02T00:30:00Z'); await s.ca.revisarMeet();
    const e = s.db.datos.get('clasesAuto/drive-prueba-1');
    assert.equal(e.estado, 'subiendo'); assert.equal(e.archivoDrive, 'real');
  } finally { s.cerrar(); }
  // si Google rechaza la búsqueda, el panel dice QUÉ falló (y se vuelve a intentar en la próxima revisión)
  const s2 = await levantar({ driveListaError: true });
  try {
    await s2.llamar('/api/admin/clases-auto/drive', { ...CLASE, link: ENLACE }, 'jefa');
    s2.reloj.t = Date.parse('2026-12-02T00:30:00Z'); await s2.ca.revisarMeet();
    const e = s2.db.datos.get('clasesAuto/drive-prueba-1');
    assert.equal(e.estado, 'esperando'); assert.match(e.error, /Al buscar en el Drive: Google respondió con error 400: Invalid Value/);
  } finally { s2.cerrar(); }
});

test('drive: una clase con la hora de inicio dañada (en 0, como la dejaba un reintento anterior) se repara sola y la búsqueda usa la fecha correcta', async () => {
  const cfg = { archivosDrive: [ARCH('real', 'PRUEBA 2 - 2026/12/01 17:02 CST - Recording', '2026-12-02T00:08:00Z')] };
  const s = await levantar(cfg);
  try {
    await s.llamar('/api/admin/clases-auto/drive', { ...CLASE, title: 'PRUEBA 2', link: ENLACE }, 'jefa');
    const doc = s.db.datos.get('clasesAuto/drive-prueba-1'); s.db.datos.set('clasesAuto/drive-prueba-1', { ...doc, inicioMs: 0 }); // estado dañado
    s.reloj.t = Date.parse('2026-12-02T00:30:00Z'); await s.ca.revisarMeet();
    assert.ok(cfg.consultasDrive[0].includes("createdTime >= '2026-12-01T22:30:00Z'"), 'la fecha sale de la hora escrita de la clase, no de 1969');
    assert.equal(s.db.datos.get('clasesAuto/drive-prueba-1').archivoDrive, 'real');
  } finally { s.cerrar(); }
  // «Reintentar» / «Buscar ahora» no borra la hora de la clase y fuerza la búsqueda aunque la clase aún no haya empezado
  const s2 = await levantar({ archivosDrive: [ARCH('x', 'PRUEBA 2 - Recording', '2026-12-01T22:40:00Z')] });
  try {
    await s2.llamar('/api/admin/clases-auto/drive', { ...CLASE, title: 'PRUEBA 2', link: ENLACE }, 'jefa');
    s2.reloj.t = Date.parse('2026-12-01T22:35:00Z'); // 10:35 h antes de las 17:00 CDMX del 1-dic: aún no empieza
    await s2.ca.revisarMeet(); assert.equal(s2.db.datos.get('clasesAuto/drive-prueba-1').estado, 'esperando');
    await s2.llamar('/api/admin/clases-auto/drive-prueba-1/reintentar', {}, 'jefa');
    await new Promise(r => setTimeout(r, 150));
    const e = s2.db.datos.get('clasesAuto/drive-prueba-1');
    assert.equal(e.inicioMs, Date.parse('2026-12-01T23:00:00Z'), 'la hora de la clase se conserva');
    assert.equal(e.archivoDrive, 'x'); assert.equal(e.forzar, false);
  } finally { s2.cerrar(); }
});

test('drive: si Google rechaza el filtro por fecha, se reintenta sin él y la fecha se filtra en el servidor (no se toman videos viejos)', async () => {
  const cfg = { rechazaFecha: true, archivosDrive: [
    ARCH('viejo', 'PRUEBA 2 - 2026/11/06 - Recording', '2026-11-06T23:57:00Z'),
    ARCH('nuevo', 'PRUEBA 2 - 2026/12/01 17:02 CST - Recording', '2026-12-02T00:08:00Z')] };
  const s = await levantar(cfg);
  try {
    await s.llamar('/api/admin/clases-auto/drive', { ...CLASE, title: 'PRUEBA 2', link: ENLACE }, 'jefa');
    s.reloj.t = Date.parse('2026-12-02T00:30:00Z'); await s.ca.revisarMeet();
    assert.equal(cfg.consultasDrive.length, 2, 'primero con fecha y luego sin ella');
    assert.ok(!cfg.consultasDrive[1].includes('createdTime >='));
    assert.equal(s.db.datos.get('clasesAuto/drive-prueba-1').archivoDrive, 'nuevo');
  } finally { s.cerrar(); }
});

test('eliminar una clase automática: solo un administrador; el video de Bunny se borra únicamente si se pide', async () => {
  const s = await levantar({ grabaciones: [REC('FILE_GENERATED', '2026-12-01T23:00:00Z', '2026-12-02T00:00:00Z', 'f1')] });
  try {
    await s.llamar('/api/admin/clases-auto/meet', CLASE, 'jefa');
    s.reloj.t = Date.parse('2026-12-02T00:10:00Z'); await s.ca.revisarMeet();
    assert.equal(s.db.datos.get('clasesAuto/meet-abcDEF123xyz').videoId, VIDEO);
    assert.equal((await s.llamar('/api/admin/clases-auto/meet-abcDEF123xyz', null, 'ana', 'DELETE')).status, 403);
    assert.ok(s.db.datos.has('clasesAuto/meet-abcDEF123xyz'));
    // sin ?bunny=1 el video de Bunny se conserva
    const r1 = await s.llamar('/api/admin/clases-auto/meet-abcDEF123xyz', null, 'jefa', 'DELETE');
    assert.equal(r1.status, 200); assert.equal(r1.cuerpo.borrado, true); assert.equal(r1.cuerpo.bunnyBorrado, false);
    assert.equal(s.llamadas.filter(l => l.metodo === 'DELETE').length, 0);
    assert.equal(s.db.datos.has('clasesAuto/meet-abcDEF123xyz'), false);
    // lo que no existe no da error
    assert.equal((await s.llamar('/api/admin/clases-auto/meet-abcDEF123xyz', null, 'jefa', 'DELETE')).cuerpo.borrado, false);
  } finally { s.cerrar(); }
  const s2 = await levantar({ grabaciones: [REC('FILE_GENERATED', '2026-12-01T23:00:00Z', '2026-12-02T00:00:00Z', 'f1')] });
  try {
    await s2.llamar('/api/admin/clases-auto/meet', CLASE, 'jefa');
    s2.reloj.t = Date.parse('2026-12-02T00:10:00Z'); await s2.ca.revisarMeet();
    const r = await s2.llamar('/api/admin/clases-auto/meet-abcDEF123xyz?bunny=1', null, 'jefa', 'DELETE');
    assert.equal(r.cuerpo.bunnyBorrado, true);
    const borrado = s2.llamadas.find(l => l.metodo === 'DELETE');
    assert.ok(borrado.url.endsWith('/videos/' + VIDEO), 'se borra ese video de Bunny');
    assert.equal(s2.db.datos.has('clasesAuto/meet-abcDEF123xyz'), false);
  } finally { s2.cerrar(); }
});

