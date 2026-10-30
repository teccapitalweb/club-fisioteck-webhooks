'use strict';
// SOPORTE: reportes de los miembros que llegan al panel del administrador
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasSoporte, validarReporte } = require('../services/soporte');

function fakeDb(semilla = {}) {
  const datos = new Map(Object.entries(semilla)); let seq = 0;
  const ref = ruta => ({ id: ruta.split('/').pop(),
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...v } : { ...v }); },
    async delete() { datos.delete(ruta); }, collection: n => col(ruta + '/' + n) });
  const col = ruta => {
    const docs = (filtro, orden, tope) => { let l = [...datos.keys()].filter(k => k.startsWith(ruta + '/') && !k.slice(ruta.length + 1).includes('/')).map(k => ({ id: k.split('/').pop(), v: datos.get(k) })); if (filtro) l = l.filter(x => x.v[filtro[0]] === filtro[1]); if (orden) l.sort((a, b) => b.v[orden] - a.v[orden]); if (tope) l = l.slice(0, tope); return l.map(x => ({ id: x.id, data: () => x.v })); };
    const consulta = (filtro, orden, tope) => ({ where: (c, _o, val) => consulta([c, val], orden, tope), orderBy: c => consulta(filtro, c, tope), limit: n => consulta(filtro, orden, n), async get() { return { docs: docs(filtro, orden, tope) }; } });
    return { doc: id => ref(ruta + '/' + id), async add(v) { const id = 'r' + (++seq); datos.set(ruta + '/' + id, { ...v }); return { id }; }, ...consulta(null, null, null) };
  };
  return { datos, collection: n => col(n) };
}
async function levantar(semilla, reloj) {
  const db = fakeDb(semilla);
  const tokens = { admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }, ana: { uid: 'u1', email: 'ana@mail.com', email_verified: true }, beto: { uid: 'u2', email: 'beto@mail.com', email_verified: true } };
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const app = express(); app.use(express.json()); montarRutasSoporte(app, { db, admin, ahora: reloj });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, metodo = 'GET', cuerpo, token) => { const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json().catch(() => ({})) }; };
  return { db, llamar, cerrar: () => srv.close() };
}

test('validación del reporte', () => {
  assert.ok(validarReporte({ tipo: 'queja', mensaje: 'corto' }).error);
  const r = validarReporte({ tipo: 'inventado', mensaje: 'No me carga el video <b>de la clase 3</b> en el celular' }).reporte;
  assert.equal(r.tipo, 'otro'); assert.equal(r.mensaje.includes('<'), false); assert.ok(r.asunto.length > 0);
});

test('un miembro envía un reporte, ve solo los suyos y el administrador los ve todos', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/soporte', 'POST', { mensaje: 'No me carga el video de la clase 3' })).status, 401);
    const a = await s.llamar('/api/soporte', 'POST', { tipo: 'problema', asunto: 'Video', mensaje: 'No me carga el video de la clase 3' }, 'ana');
    assert.equal(a.status, 200);
    await s.llamar('/api/soporte', 'POST', { tipo: 'sugerencia', mensaje: 'Me gustaría un curso de pediatría' }, 'beto');
    const mios = (await s.llamar('/api/soporte/mios', 'GET', null, 'ana')).cuerpo.reportes;
    assert.equal(mios.length, 1); assert.equal(mios[0].estado, 'nuevo'); assert.equal(mios[0].email, undefined, 'no devuelve datos de más');
    assert.equal((await s.llamar('/api/admin/soporte', 'GET', null, 'ana')).status, 403);
    const todos = (await s.llamar('/api/admin/soporte', 'GET', null, 'admin')).cuerpo;
    assert.equal(todos.conteo.total, 2); assert.equal(todos.conteo.nuevo, 2); assert.equal(todos.reportes[0].email.includes('@'), true);
  } finally { s.cerrar(); }
});

test('el administrador responde, cambia el estado y el miembro recibe un aviso; también puede borrar', async () => {
  const s = await levantar();
  try {
    const id = (await s.llamar('/api/soporte', 'POST', { tipo: 'queja', mensaje: 'El certificado salió con otro nombre' }, 'ana')).cuerpo.id;
    assert.equal((await s.llamar('/api/admin/soporte/' + id, 'POST', { estado: 'resuelto' }, 'ana')).status, 403);
    assert.equal((await s.llamar('/api/admin/soporte/' + id, 'POST', { estado: 'raro' }, 'admin')).status, 400);
    assert.equal((await s.llamar('/api/admin/soporte/' + id, 'POST', { respuesta: 'Ya lo corregimos, descárgalo otra vez.' }, 'admin')).status, 200);
    const mio = (await s.llamar('/api/soporte/mios', 'GET', null, 'ana')).cuerpo.reportes[0];
    assert.equal(mio.estado, 'revision'); assert.ok(mio.respuesta.includes('corregimos'));
    assert.ok([...s.db.datos.keys()].some(k => k.startsWith('members/u1/avisos/soporte_')), 'avisa en la campana');
    assert.equal((await s.llamar('/api/admin/soporte/' + id, 'POST', { estado: 'resuelto' }, 'admin')).status, 200);
    assert.equal((await s.llamar('/api/admin/soporte/' + id, 'DELETE', null, 'admin')).status, 200);
    assert.equal((await s.llamar('/api/admin/soporte', 'GET', null, 'admin')).cuerpo.conteo.total, 0);
  } finally { s.cerrar(); }
});

test('límite: 5 reportes por hora por persona', async () => {
  const s = await levantar();
  try {
    let ultimo; for (let i = 0; i < 6; i++) ultimo = await s.llamar('/api/soporte', 'POST', { mensaje: 'Reporte número ' + i + ' con detalle suficiente' }, 'ana');
    assert.equal(ultimo.status, 429);
    assert.equal((await s.llamar('/api/soporte', 'POST', { mensaje: 'Otra persona sí puede enviar el suyo' }, 'beto')).status, 200);
  } finally { s.cerrar(); }
});
