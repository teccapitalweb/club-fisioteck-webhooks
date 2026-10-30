'use strict';
// MODERACIÓN DEL FORO POR EL SERVIDOR: solo el administrador
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasForoAdmin } = require('../services/foro-admin');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla)); let seq = 0;
  const ref = ruta => ({
    id: ruta.split('/').pop(),
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...v } : { ...v }); },
    async delete() { datos.delete(ruta); },
    collection: n => col(ruta + '/' + n)
  });
  const col = ruta => ({
    doc: id => ref(ruta + '/' + id),
    async add(v) { const id = 'n' + (++seq); datos.set(ruta + '/' + id, { ...v }); return { id }; },
    async get() { const docs = [...datos.keys()].filter(k => k.startsWith(ruta + '/') && !k.slice(ruta.length + 1).includes('/')).map(k => ({ id: k.split('/').pop(), data: () => datos.get(k) })); return { docs }; }
  });
  return { datos, collection: n => col(n) };
}
async function levantar(semilla) {
  const db = fakeDb(semilla);
  const tokens = { admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }, socio: { uid: 's1', email: 's@mail.com', email_verified: true } };
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }), firestore: { FieldValue: { serverTimestamp: () => 'ahora' } } };
  const app = express(); app.use(express.json()); montarRutasForoAdmin(app, { db, admin });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, metodo, cuerpo, token) => { const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json().catch(() => ({})) }; };
  return { db, llamar, cerrar: () => srv.close() };
}
const semilla = () => ({ 'forum_posts/p1': { title: 'Tema', body: 'x', replyCount: 2 }, 'forum_posts/p1/replies/r1': { body: 'a' }, 'forum_posts/p1/replies/r2': { body: 'b' } });

test('foro: solo el administrador borra respuestas y baja el contador, y borra temas con sus respuestas', async () => {
  const s = await levantar(semilla());
  try {
    assert.equal((await s.llamar('/api/admin/foro/temas/p1/respuestas/r1', 'DELETE', null, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/foro/temas/p1/respuestas/r1', 'DELETE')).status, 401);
    assert.equal((await s.llamar('/api/admin/foro/temas/p1/respuestas/r1', 'DELETE', null, 'admin')).status, 200);
    assert.equal(s.db.datos.get('forum_posts/p1').replyCount, 1);
    assert.equal(s.db.datos.has('forum_posts/p1/replies/r1'), false);
    assert.equal((await s.llamar('/api/admin/foro/temas/p1/respuestas/r1', 'DELETE', null, 'admin')).status, 404);
    const t = await s.llamar('/api/admin/foro/temas/p1', 'DELETE', null, 'admin');
    assert.equal(t.status, 200); assert.equal(t.cuerpo.respuestasBorradas, 1);
    assert.equal(s.db.datos.has('forum_posts/p1'), false); assert.equal(s.db.datos.has('forum_posts/p1/replies/r2'), false);
    assert.equal((await s.llamar('/api/admin/foro/temas/..%2Fx', 'DELETE', null, 'admin')).status === 200, false);
  } finally { s.cerrar(); }
});

test('foro: un tema oficial lo publica el servidor como Equipo FisioTeck, solo si eres administrador', async () => {
  const s = await levantar({});
  try {
    assert.equal((await s.llamar('/api/admin/foro/temas', 'POST', { titulo: 'Reglas', mensaje: 'Sean amables' }, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/foro/temas', 'POST', { titulo: 'a', mensaje: '' }, 'admin')).status, 400);
    const r = await s.llamar('/api/admin/foro/temas', 'POST', { titulo: 'Reglas del foro', mensaje: 'Sean amables <script>', categoria: 'tips' }, 'admin');
    assert.equal(r.status, 200);
    const t = s.db.datos.get('forum_posts/' + r.cuerpo.id);
    assert.equal(t.authorName, 'Equipo FisioTeck'); assert.equal(t.official, true); assert.equal(t.category, 'tips'); assert.equal(t.body.includes('<'), false);
  } finally { s.cerrar(); }
});
