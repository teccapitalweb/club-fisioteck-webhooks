const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasAvisos } = require('../services/avisos');
const { montarRutasLibros, libroLimpio } = require('../services/libros');
const dc = require('../services/datos-curiosos');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); },
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
const tokens = { ana: { uid: 'ana' }, beto: { uid: 'beto' }, vip: { uid: 'vip' }, gratis: { uid: 'gratis' }, admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true } };
async function levantar(semilla, montar) {
  const db = fakeDb(semilla), app = express(); app.use(express.json());
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  montar(app, { db, admin, tieneMembresia: m => m.status === 'active' });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, quien = 'ana') => { const r = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + quien, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json() }; };
  return { db, llamar, cerrar: () => srv.close() };
}

test('avisos del foro: solo avisa al autor del tema, una vez por respuesta, y solo si la respuesta es de quien lo pide', async () => {
  const s = await levantar({ 'forum_posts/p1': { authorId: 'ana', title: 'Dolor de hombro' }, 'forum_posts/p1/replies/r1': { authorId: 'beto', authorName: 'Beto R.', body: 'Yo empezaría con control escapular' }, 'forum_posts/p1/replies/r2': { authorId: 'ana', authorName: 'Ana', body: 'Gracias' } }, montarRutasAvisos);
  try {
    assert.equal((await s.llamar('/api/avisos/foro', { postId: 'p1', replyId: 'r1' }, 'ana')).status, 403); // no es su respuesta
    const r = await s.llamar('/api/avisos/foro', { postId: 'p1', replyId: 'r1' }, 'beto');
    assert.equal(r.cuerpo.avisado, true);
    assert.equal((await s.llamar('/api/avisos/foro', { postId: 'p1', replyId: 'r1' }, 'beto')).cuerpo.avisado, false); // no se repite
    assert.equal((await s.llamar('/api/avisos/foro', { postId: 'p1', replyId: 'r2' }, 'ana')).cuerpo.avisado, false); // responder a tu propio tema
    assert.equal((await s.llamar('/api/avisos/foro', { postId: 'p1', replyId: 'nada' }, 'beto')).status, 404);
    const lista = (await s.llamar('/api/avisos', null, 'ana')).cuerpo.avisos;
    assert.equal(lista.length, 1); assert.equal(lista[0].quien, 'Beto R.'); assert.equal(lista[0].titulo, 'Dolor de hombro'); assert.equal(lista[0].leido, false);
    assert.equal((await s.llamar('/api/avisos', null, 'beto')).cuerpo.avisos.length, 0);
    await s.llamar('/api/avisos/r1/leido', {}, 'ana');
    assert.equal((await s.llamar('/api/avisos', null, 'ana')).cuerpo.avisos[0].leido, true);
  } finally { s.cerrar(); }
});

test('datos curiosos: martes y viernes desde las 7, el menos enviado primero y una sola vez al día', async () => {
  assert.equal(dc.tocaEnviar(new Date('2026-10-27T14:00:00Z')), true); // martes 8:00 MX
  assert.equal(dc.tocaEnviar(new Date('2026-10-27T12:00:00Z')), false); // martes 6:00 MX: aún no
  assert.equal(dc.tocaEnviar(new Date('2026-10-28T14:00:00Z')), false); // miércoles
  assert.equal(dc.elegirDato([{ id: 'a', veces: 2 }, { id: 'b', veces: 0 }, { id: 'c', veces: 0, activo: false }]).id, 'b');
  assert.equal(dc.validarDato({ texto: 'corto' }) !== null, true);
  const s = await levantar({}, (app, deps) => { const sv = dc.crearServicio(deps); sv.montarRutas(app); s0 = sv; });
  try {
    const sv = s0;
    assert.equal((await sv.sembrar()), dc.BANCO_INICIAL.length);
    const dia = new Date('2026-10-27T14:00:00Z');
    const r1 = await sv.revisarEnvio(dia); assert.equal(r1.enviado, true);
    assert.equal((await sv.revisarEnvio(dia)).motivo, 'ya-enviado');
    assert.equal((await sv.revisarEnvio(new Date('2026-10-28T14:00:00Z'))).motivo, 'no-toca');
    const avisos = [...s.db.datos.keys()].filter(k => k.startsWith('member_notifications/curioso_'));
    assert.equal(avisos.length, 1); assert.equal(s.db.datos.get(avisos[0]).category, 'curioso');
    assert.equal((await s.llamar('/api/admin/datos-curiosos', null, 'ana')).status, 403);
    const alta = await s.llamar('/api/admin/datos-curiosos', { texto: 'La rodilla es la articulación más grande del cuerpo humano.', tema: 'Anatomía', enviarAhora: true }, 'admin');
    assert.equal(alta.status, 201);
    assert.equal((await s.llamar('/api/admin/datos-curiosos', { texto: 'corto' }, 'admin')).status, 400);
    const lista = (await s.llamar('/api/admin/datos-curiosos', null, 'admin')).cuerpo;
    assert.equal(lista.total, dc.BANCO_INICIAL.length + 1);
    await s.llamar('/api/admin/datos-curiosos/' + alta.cuerpo.id + '/actualizar', { activo: false }, 'admin');
    assert.equal(s.db.datos.get('datosCuriosos/' + alta.cuerpo.id).activo, false);
    await s.llamar('/api/admin/datos-curiosos/' + alta.cuerpo.id + '/eliminar', {}, 'admin');
    assert.equal(s.db.datos.has('datosCuriosos/' + alta.cuerpo.id), false);
  } finally { s.cerrar(); }
});
let s0;

test('libros: el enlace solo sale a quien tiene membresía y los retos pedidos; el administrador gestiona el catálogo', async () => {
  const s = await levantar({
    'members/vip': { status: 'active' }, 'members/gratis': { status: 'registered' },
    'members/vip/progress/retos': { superados: { 'q-1': {}, 'q-2': {}, 'o-1': {} } }, 'members/gratis/progress/retos': { superados: { 'q-1': {}, 'q-2': {}, 'q-3': {}, 'q-4': {} } }
  }, montarRutasLibros);
  try {
    const a = await s.llamar('/api/admin/libros', { titulo: 'Anatomía para fisioterapeutas', autor: 'Equipo FisioTeck', descripcion: 'Guía de lectura', url: 'https://drive.google.com/file/d/abc/view', requiereRetos: 3, orden: 1 }, 'admin');
    assert.equal(a.status, 201);
    const b = await s.llamar('/api/admin/libros', { titulo: 'Libro avanzado', url: 'https://ejemplo.com/libro.pdf', requiereRetos: 10, orden: 2 }, 'admin');
    await s.llamar('/api/admin/libros', { titulo: 'Pausado', url: 'https://ejemplo.com/p.pdf', requiereRetos: 1, activo: false }, 'admin');
    assert.equal((await s.llamar('/api/admin/libros', { titulo: 'Sin enlace', url: 'javascript:alert(1)', requiereRetos: 2 }, 'admin')).status, 400);
    assert.equal((await s.llamar('/api/admin/libros', { titulo: 'x', url: 'https://a.com/b', requiereRetos: 2 }, 'admin')).status, 400);
    assert.equal((await s.llamar('/api/admin/libros', { titulo: 'Demasiados', url: 'https://a.com/b', requiereRetos: 999 }, 'admin')).status, 400);
    assert.equal((await s.llamar('/api/admin/libros', null, 'vip')).status, 403);

    const lista = (await s.llamar('/api/libros', null, 'vip')).cuerpo;
    assert.equal(lista.libros.length, 2); assert.equal(lista.retosHechos, 3);
    assert.equal(lista.libros[0].desbloqueado, true); assert.equal(lista.libros[1].desbloqueado, false); assert.equal(lista.libros[1].faltan, 7);
    assert.equal(JSON.stringify(lista).includes('drive.google'), false); // nunca el enlace en la lista
    assert.equal((await s.llamar('/api/libros/' + a.cuerpo.id + '/enlace', {}, 'vip')).cuerpo.url, 'https://drive.google.com/file/d/abc/view');
    assert.equal((await s.llamar('/api/libros/' + b.cuerpo.id + '/enlace', {}, 'vip')).status, 403); // faltan retos
    assert.equal((await s.llamar('/api/libros/' + a.cuerpo.id + '/enlace', {}, 'gratis')).status, 402); // sin membresía aunque tenga retos
    assert.equal((await s.llamar('/api/libros', null, 'gratis')).cuerpo.libros[0].desbloqueado, false);
    assert.equal((await s.llamar('/api/libros/' + b.cuerpo.id + '/enlace', {}, 'admin')).status, 200);

    await s.llamar('/api/admin/libros/' + b.cuerpo.id + '/actualizar', { requiereRetos: 2 }, 'admin');
    assert.equal((await s.llamar('/api/libros/' + b.cuerpo.id + '/enlace', {}, 'vip')).status, 200);
    await s.llamar('/api/admin/libros/' + b.cuerpo.id + '/eliminar', {}, 'admin');
    assert.equal((await s.llamar('/api/libros', null, 'vip')).cuerpo.libros.length, 1);
    assert.throws(() => libroLimpio({ titulo: 'Bien', url: 'http://inseguro.com', requiereRetos: 2 }));
  } finally { s.cerrar(); }
});

test('libros propios (PDF): enlace firmado que caduca, solo con membresía y retos', async () => {
  const { firmarAcceso, accesoValido } = require('../services/libros');
  assert.equal(accesoValido(firmarAcceso('u', 'lb'), 'lb'), true);
  assert.equal(accesoValido(firmarAcceso('u', 'lb'), 'otro'), false); // sirve para ese libro y no para otro
  assert.equal(accesoValido(firmarAcceso('u', 'lb', Date.now() - 16 * 60 * 1000), 'lb'), false); // caducado
  assert.equal(accesoValido('basura.firma', 'lb'), false);
  const retos = {}; for (let i = 1; i <= 10; i++) retos['q-' + i] = {};
  const s = await levantar({ 'members/vip': { status: 'active' }, 'members/gratis': { status: 'registered' }, 'members/vip/progress/retos': { superados: retos }, 'members/ana': { status: 'active' }, 'members/ana/progress/retos': { superados: { 'q-1': {} } },
    'libros/propio': { titulo: 'Libro propio', archivo: 'ejercicio-terapeutico.pdf', requiereRetos: 10, paginas: 100, activo: true } }, montarRutasLibros);
  try {
    const lista = (await s.llamar('/api/libros', null, 'vip')).cuerpo; assert.equal(lista.libros[0].paginas, 100); assert.equal(JSON.stringify(lista).includes('ejercicio-terapeutico.pdf'), false);
    assert.equal((await s.llamar('/api/libros/propio/enlace', {}, 'ana')).status, 403); // faltan retos
    assert.equal((await s.llamar('/api/libros/propio/enlace', {}, 'gratis')).status, 402);
    const e = await s.llamar('/api/libros/propio/enlace', {}, 'vip'); assert.equal(e.status, 200); assert.ok(e.cuerpo.url.includes('/api/libros/propio/archivo?t='));
    const ok = await fetch(e.cuerpo.url); assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'application/pdf');
    assert.equal((await ok.arrayBuffer()).byteLength > 10000, true);
    assert.equal((await fetch(e.cuerpo.url.split('?')[0] + '?t=mal.firma')).status, 403);
    assert.equal((await fetch(e.cuerpo.url.replace('/propio/', '/otro/'))).status, 403);
  } finally { s.cerrar(); }
});
