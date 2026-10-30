'use strict';
// AVISOS GLOBALES E INTERRUPTORES DEL CLUB: solo el administrador, con validación y límite
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasAvisosConfig, validarCambios, validarAviso, normalizarConfig } = require('../services/avisos-config');

function fakeDb() {
  const col = {};
  const coleccion = n => (col[n] = col[n] || new Map());
  let seq = 0;
  const ref = (n, id) => ({
    id, async get() { const v = coleccion(n).get(id); return { exists: v !== undefined, id, data: () => v }; },
    async set(v, o) { coleccion(n).set(id, o && o.merge ? { ...(coleccion(n).get(id) || {}), ...v } : { ...v }); },
    async delete() { coleccion(n).delete(id); }
  });
  return { _col: col, collection: n => ({
    doc: id => ref(n, id),
    async add(v) { const id = 'a' + (++seq); coleccion(n).set(id, { ...v }); return { id }; },
    orderBy() { return { limit: () => ({ async get() { return { docs: [...coleccion(n).entries()].reverse().map(([id, v]) => ({ id, data: () => v })) }; } }) }; }
  }) };
}
async function levantar() {
  const db = fakeDb();
  const tokens = { admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }, socio: { uid: 's1', email: 's@mail.com', email_verified: true } };
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }), firestore: { FieldValue: { serverTimestamp: () => 'ahora' } } };
  const app = express(); app.use(express.json());
  montarRutasAvisosConfig(app, { db, admin });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, metodo = 'GET', cuerpo, token) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
  };
  return { db, llamar, cerrar: () => srv.close() };
}

test('validación: aviso global, interruptor de clases en vivo y avisos de la campana', () => {
  assert.equal(validarCambios({ avisoGlobal: { activo: true, texto: 'ab' } }).error.includes('mínimo 4'), true);
  assert.deepEqual(validarCambios({ clasesEnVivoPronto: null }).cambios, { clasesEnVivoPronto: null });
  assert.ok(validarCambios({ clasesEnVivoPronto: 'si' }).error);
  assert.ok(validarCambios({ otraCosa: true }).error);
  assert.equal(validarCambios({ avisoGlobal: { activo: true, texto: '<b>Hola club</b>', tono: 'aviso' } }).cambios.avisoGlobal.texto.includes('<'), false);
  assert.ok(validarAviso({ titulo: 'x', mensaje: '' }).error);
  assert.ok(validarAviso({ titulo: 'x', mensaje: 'y', enlace: 'http://mal.com' }).error, 'el enlace debe ser https');
  assert.equal(validarAviso({ titulo: 'Nuevo curso', mensaje: 'Ya está', categoria: 'course', enlace: 'https://fisioteck.com' }).aviso.category, 'course');
  assert.equal(normalizarConfig({}).clasesEnVivoPronto, null);
});

test('rutas: solo el administrador cambia el aviso global; la configuración pública no revela nada interno', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/config', 'POST', { clasesEnVivoPronto: true })).status, 401);
    assert.equal((await s.llamar('/api/admin/config', 'POST', { clasesEnVivoPronto: true }, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/config', 'POST', { avisoGlobal: { activo: true, texto: 'Mañana hay clase en vivo', tono: 'info' }, clasesEnVivoPronto: true }, 'admin')).status, 200);
    const pub = (await s.llamar('/api/config-publica')).cuerpo;
    assert.equal(pub.avisoGlobal.activo, true); assert.equal(pub.clasesEnVivoPronto, true);
    assert.deepEqual(Object.keys(pub).sort(), ['avisoGlobal', 'clasesEnVivoPronto', 'ok']);
  } finally { s.cerrar(); }
});

test('rutas: avisos a todos solo del administrador, con validación, y se pueden quitar', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/avisos', 'POST', { titulo: 'a', mensaje: 'b' }, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/avisos', 'POST', { titulo: '', mensaje: 'b' }, 'admin')).status, 400);
    const ok = await s.llamar('/api/admin/avisos', 'POST', { titulo: 'Nuevo curso', mensaje: 'Ya puedes verlo', categoria: 'course' }, 'admin');
    assert.equal(ok.status, 200);
    assert.equal(s.db._col.member_notifications.get(ok.cuerpo.id).title, 'Nuevo curso');
    assert.equal((await s.llamar('/api/admin/avisos', 'GET', null, 'admin')).cuerpo.avisos.length, 1);
    assert.equal((await s.llamar('/api/admin/avisos/' + ok.cuerpo.id, 'DELETE', null, 'admin')).status, 200);
    assert.equal(s.db._col.member_notifications.size, 0);
  } finally { s.cerrar(); }
});

test('rutas: límite de avisos por hora', async () => {
  const s = await levantar();
  try {
    let ultimo;
    for (let i = 0; i < 21; i++) ultimo = await s.llamar('/api/admin/avisos', 'POST', { titulo: 'Aviso ' + i, mensaje: 'Texto' }, 'admin');
    assert.equal(ultimo.status, 429);
  } finally { s.cerrar(); }
});
