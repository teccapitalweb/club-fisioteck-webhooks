const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasAdminExtra, validarCursoCatalogo, numeroDeClase } = require('../services/admin-extra');

const G1 = '58fa738a-ed77-44be-95be-29c81407366e', G2 = '1d8e1055-b3c0-46e0-b728-e84c6f6bf35d';

function fakeDb() {
  const datos = new Map();
  return { datos, collection: n => ({ doc: id => ({ async get() { const v = datos.get(n + '/' + id); return { exists: v !== undefined, data: () => v }; }, async set(v) { datos.set(n + '/' + id, JSON.parse(JSON.stringify(v))); } }) }) };
}
async function levantar({ env = {}, fetchFalso, cargarCatalogo, stripe } = {}) {
  const db = fakeDb();
  const admin = { auth: () => ({ verifyIdToken: async t => { if (t === 'admin') return { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }; if (t === 'socio') return { uid: 's1', email: 's@mail.com', email_verified: true }; throw new Error('x'); } }) };
  const registrados = [];
  const app = express(); app.use(express.json());
  montarRutasAdminExtra(app, { db, admin, env, stripe, fetch: fetchFalso, cargarCatalogo, registrarCatalogoExtra: c => registrados.push(c) });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const url = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, token = 'admin') => {
    const r = await fetch(url + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, registrados, cerrar: () => srv.close() };
}

test('numeroDeClase toma el primer entero del título', () => {
  assert.equal(numeroDeClase('Sesión 03.mp4'), 3);
  assert.equal(numeroDeClase('Introducción'), 0);
});

test('validarCursoCatalogo exige título, ids y GUID de Bunny', () => {
  assert.equal(validarCursoCatalogo({ courseId: 1, title: '', lessons: [] }).ok, false);
  assert.equal(validarCursoCatalogo({ courseId: 'a b', title: 'X', lessons: [] }).ok, false);
  assert.equal(validarCursoCatalogo({ courseId: 1, title: 'X', lessons: [{ lessonId: 5, bunnyVideoId: 'no-es-guid' }] }).ok, false);
  const v = validarCursoCatalogo({ courseId: '170', title: ' Curso  nuevo ', lessons: [{ lessonId: 5, title: 'Clase 1', isPreview: true, bunnyVideoId: G1 }, { lessonId: 6 }] });
  assert.equal(v.ok, true); assert.equal(v.curso.courseId, 170); assert.equal(v.curso.title, 'Curso nuevo');
  assert.equal(v.curso.lessons[0].index, 0); assert.equal(v.curso.lessons[1].index, 1); assert.equal(v.curso.lessons[0].isPreview, true);
});

test('las rutas exigen administrador', async () => {
  const s = await levantar();
  try {
    for (const r of ['/api/admin/bunny-catalogo', '/api/admin/estado']) {
      assert.equal((await s.llamar(r, null, 'socio')).status, 403);
    }
    assert.equal((await s.llamar('/api/admin/catalogo-curso', { courseId: 1, title: 'X', lessons: [] }, 'socio')).status, 403);
  } finally { s.cerrar(); }
});

test('Bunny: sin configurar avisa; configurado lista colecciones y videos terminados sin revelar la llave', async () => {
  const sin = await levantar();
  try { assert.equal((await sin.llamar('/api/admin/bunny-catalogo')).status, 503); } finally { sin.cerrar(); }

  const llamadas = [];
  const fetchFalso = async (url, opts) => {
    llamadas.push({ url, llave: opts && opts.headers && opts.headers.AccessKey });
    const json = u => ({ ok: true, status: 200, json: async () => u });
    if (/\/collections\?/.test(url)) return json({ items: [{ guid: 'c1', name: 'Curso uno' }] });
    return json({ items: [{ guid: G2, title: 'Sesión 02.mp4', status: 4, length: 3300 }, { guid: G1, title: 'Sesión 01.mp4', status: 4, length: 3480 }, { guid: 'x', title: 'Sesión 03', status: 2, length: 10 }] });
  };
  const s = await levantar({ env: { BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_STREAM_API_KEY: 'llave-secreta' }, fetchFalso });
  try {
    const r = await s.llamar('/api/admin/bunny-catalogo');
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.catalogo[0].titulo, 'Curso uno');
    assert.deepEqual(r.cuerpo.catalogo[0].sesiones.map(x => [x.numero, x.videoId, x.duracion]), [[1, G1, '58 min'], [2, G2, '55 min']]);
    assert.equal(JSON.stringify(r.cuerpo).includes('llave-secreta'), false);
    assert.ok(llamadas.every(l => l.llave === 'llave-secreta' && l.url.startsWith('https://video.bunnycdn.com/library/123/')));
  } finally { s.cerrar(); }
});

test('registrar un curso nuevo lo guarda y avisa al servidor para poder reproducirlo', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/catalogo-curso', { courseId: 5, title: 'X', lessons: [{ lessonId: 1, bunnyVideoId: 'malo' }] })).status, 400);
    const r = await s.llamar('/api/admin/catalogo-curso', { courseId: 170, title: 'Curso nuevo', lessons: [{ lessonId: 1, title: 'Clase 1', isPreview: true, bunnyVideoId: G1 }, { lessonId: 2, bunnyVideoId: G2 }] });
    assert.equal(r.status, 200); assert.equal(r.cuerpo.conVideo, 2);
    assert.equal(s.registrados.length, 1);
    assert.equal(s.db.datos.get('catalogoVideo/170').lessons[1].bunnyVideoId, G2);
  } finally { s.cerrar(); }
});

test('estado: semáforo con el peor resultado y sin revelar llaves', async () => {
  const s = await levantar({ env: { STRIPE_SECRET_KEY: 'sk_x', CERT_SIGNING_KEY: 'k' } });
  try {
    const r = await s.llamar('/api/admin/estado');
    assert.equal(r.status, 200);
    const por = Object.fromEntries(r.cuerpo.servicios.map(x => [x.id, x.estado]));
    assert.equal(por.stripe, 'ok'); assert.equal(por['stripe-avisos'], 'aviso'); assert.equal(por.certificados, 'ok'); assert.equal(por.bunny, 'aviso'); assert.equal(por.servidor, 'ok');
    assert.equal(r.cuerpo.resumen, 'aviso');
    assert.equal(JSON.stringify(r.cuerpo).includes('sk_x'), false);
  } finally { s.cerrar(); }
  const roto = await levantar({ env: {} });
  try { assert.equal((await roto.llamar('/api/admin/estado')).cuerpo.resumen, 'error'); } finally { roto.cerrar(); }
});

test('Bunny: si Bunny falla o rechaza, el panel recibe el catálogo guardado en el servidor (no un 502)', async () => {
  const guardado = { courses: [{ title: 'Curso guardado', collectionId: 'c9', lessons: [{ title: 'Sesión 01', bunnyVideoId: G1 }, { title: 'Sesión 02', bunnyVideoId: G2 }] }] };
  let intentos = 0;
  const fetchFalso = async () => { intentos++; return { ok: false, status: 429, json: async () => ({}) }; };
  const s = await levantar({ env: { BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_STREAM_API_KEY: 'llave-secreta' }, fetchFalso, cargarCatalogo: () => guardado });
  try {
    const r = await s.llamar('/api/admin/bunny-catalogo');
    assert.equal(r.status, 200); assert.equal(r.cuerpo.origen, 'guardado');
    assert.equal(r.cuerpo.catalogo[0].titulo, 'Curso guardado');
    assert.deepEqual(r.cuerpo.catalogo[0].sesiones.map(x => [x.numero, x.videoId]), [[1, G1], [2, G2]]);
    assert.match(r.cuerpo.aviso, /429/); assert.equal(JSON.stringify(r.cuerpo).includes('llave-secreta'), false);
    assert.ok(intentos >= 3, 'reintenta antes de rendirse');
  } finally { s.cerrar(); }
});

test('Bunny: sin catálogo guardado y con Bunny caído responde el error real', async () => {
  const s = await levantar({ env: { BUNNY_STREAM_LIBRARY_ID: '123', BUNNY_STREAM_API_KEY: 'k' }, fetchFalso: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  try { const r = await s.llamar('/api/admin/bunny-catalogo'); assert.equal(r.status, 502); assert.match(r.cuerpo.error, /401/); } finally { s.cerrar(); }
});

// ---- Prueba real de reproducción en el semáforo ----
const ENV_BUNNY = { BUNNY_STREAM_LIBRARY_ID: '111', BUNNY_STREAM_API_KEY: 'api', BUNNY_STREAM_TOKEN_KEY: 'token-secreto', STRIPE_SECRET_KEY: 'sk', CERT_SIGNING_KEY: 'k' };
const CATALOGO = { libraryId: '999', courses: [{ title: 'C', lessons: [{ title: 'Sesión 01', bunnyVideoId: G1 }] }] };
const resp = (ok, status, cuerpo) => ({ ok, status, json: async () => cuerpo || {}, text: async () => (typeof cuerpo === 'string' ? cuerpo : '') });
async function reproduccion(fetchFalso) {
  const s = await levantar({ env: ENV_BUNNY, fetchFalso, cargarCatalogo: () => CATALOGO });
  try { const r = await s.llamar('/api/admin/estado'); return r.cuerpo.servicios.find(x => x.id === 'bunny-reproduccion'); } finally { s.cerrar(); }
}

test('reproducción: Bunny acepta el enlace firmado -> ok, y se firma con la llave del servidor y el referer del Club', async () => {
  const visto = [];
  const fetchFalso = async (url, o) => { visto.push({ url, referer: o && o.headers && o.headers.Referer }); if (/iframe\.mediadelivery\.net/.test(url)) return resp(true, 200, '<html><title>Reproductor</title></html>'); return resp(true, 200, { items: [] }); };
  const x = await reproduccion(fetchFalso);
  assert.equal(x.estado, 'ok');
  const embed = visto.find(v => /iframe\.mediadelivery\.net/.test(v.url));
  assert.match(embed.url, /\/embed\/111\/58fa738a-ed77-44be-95be-29c81407366e\?token=[0-9a-f]{64}&expires=\d+/);
  assert.equal(embed.referer, 'https://club.fisioteck.com/');
});

test('reproducción: Bunny responde 403 -> error con las causas (llave de token y dominios permitidos)', async () => {
  const fetchFalso = async url => /iframe\.mediadelivery\.net/.test(url) ? resp(true, 200, '<html><title>403</title></html>') : resp(true, 200, { items: [] });
  const x = await reproduccion(fetchFalso);
  assert.equal(x.estado, 'error'); assert.match(x.detalle, /403/); assert.match(x.detalle, /BUNNY_STREAM_TOKEN_KEY/); assert.match(x.detalle, /Allowed Domains/);
  assert.equal(JSON.stringify(x).includes('token-secreto'), false);
});

test('reproducción: el video no existe en la biblioteca configurada -> error que nombra las dos bibliotecas', async () => {
  const fetchFalso = async url => /\/videos\//.test(url) ? resp(false, 404, {}) : resp(true, 200, { items: [] });
  const x = await reproduccion(fetchFalso);
  assert.equal(x.estado, 'error'); assert.match(x.detalle, /biblioteca 111/); assert.match(x.detalle, /999/); assert.match(x.detalle, /BUNNY_STREAM_LIBRARY_ID/);
});

test('estado: revisa si el portal de clientes de Stripe está activo (solo lectura)', async () => {
  const con = (list) => ({ billingPortal: { configurations: { list } } });
  const probar = async stripe => { const s = await levantar({ env: { STRIPE_SECRET_KEY: 'sk_test' }, stripe }); try { return (await s.llamar('/api/admin/estado')).cuerpo.servicios.find(x => x.id === 'stripe-portal'); } finally { s.cerrar(); } };
  assert.equal((await probar(con(async () => ({ data: [{ id: 'bpc_1' }] })))).estado, 'ok');
  const falta = await probar(con(async () => ({ data: [] }))); assert.equal(falta.estado, 'aviso'); assert.match(falta.detalle, /Portal de clientes/);
  assert.equal((await probar(con(async () => { throw new Error('sin permiso'); }))).estado, 'aviso');
  assert.equal(await probar(undefined), undefined, 'sin Stripe no se muestra');
});
