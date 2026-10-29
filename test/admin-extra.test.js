const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasAdminExtra, validarCursoCatalogo, numeroDeClase } = require('../services/admin-extra');

const G1 = '58fa738a-ed77-44be-95be-29c81407366e', G2 = '1d8e1055-b3c0-46e0-b728-e84c6f6bf35d';

function fakeDb() {
  const datos = new Map();
  return { datos, collection: n => ({ doc: id => ({ async get() { const v = datos.get(n + '/' + id); return { exists: v !== undefined, data: () => v }; }, async set(v) { datos.set(n + '/' + id, JSON.parse(JSON.stringify(v))); } }) }) };
}
async function levantar({ env = {}, fetchFalso } = {}) {
  const db = fakeDb();
  const admin = { auth: () => ({ verifyIdToken: async t => { if (t === 'admin') return { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }; if (t === 'socio') return { uid: 's1', email: 's@mail.com', email_verified: true }; throw new Error('x'); } }) };
  const registrados = [];
  const app = express(); app.use(express.json());
  montarRutasAdminExtra(app, { db, admin, env, fetch: fetchFalso, registrarCatalogoExtra: c => registrados.push(c) });
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
