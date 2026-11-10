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
  const llamar = async (ruta, cuerpo, quien) => { const r = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { Authorization: quien ? 'Bearer ' + quien : '', 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json().catch(() => ({})) }; };
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
