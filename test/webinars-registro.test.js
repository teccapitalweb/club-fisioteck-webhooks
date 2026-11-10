'use strict';
// CLASES EN VIVO: inscripción de los miembros (solo con membresía vigente), lista propia y baja
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasWebinars } = require('../services/webinars');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v) { datos.set(ruta, JSON.parse(JSON.stringify(v))); },
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
const tokens = { ana: { uid: 'ana' }, beto: { uid: 'beto' }, gratis: { uid: 'gratis' } };
async function levantar() {
  const db = fakeDb({ 'members/ana': { status: 'active' }, 'members/beto': { status: 'active' }, 'members/gratis': { status: 'inactive' } });
  const app = express(); app.use(express.json());
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  montarRutasWebinars(app, { db, admin, tieneMembresia: m => m.status === 'active' });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, quien, metodo) => { const r = await fetch(base + ruta, { method: metodo || (cuerpo ? 'POST' : 'GET'), headers: { Authorization: quien ? 'Bearer ' + quien : '', 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json().catch(() => ({})) }; };
  return { db, llamar, cerrar: () => srv.close() };
}

test('clases en vivo: un miembro se inscribe, ve su lista y puede darse de baja', async () => {
  const s = await levantar();
  try {
    assert.deepEqual((await s.llamar('/api/webinars/registros', null, 'ana')).cuerpo.ids, []);
    const r = await s.llamar('/api/webinars/1730000000/registro', { registrado: true }, 'ana');
    assert.equal(r.status, 200); assert.equal(r.cuerpo.registrado, true);
    await s.llamar('/api/webinars/abc-2/registro', {}, 'ana'); // sin el campo: cuenta como inscribirse
    assert.deepEqual((await s.llamar('/api/webinars/registros', null, 'ana')).cuerpo.ids.sort(), ['1730000000', 'abc-2']);
    assert.deepEqual((await s.llamar('/api/webinars/registros', null, 'beto')).cuerpo.ids, [], 'cada quien ve solo lo suyo');
    const baja = await s.llamar('/api/webinars/1730000000/registro', { registrado: false }, 'ana');
    assert.equal(baja.cuerpo.registrado, false);
    assert.deepEqual((await s.llamar('/api/webinars/registros', null, 'ana')).cuerpo.ids, ['abc-2']);
  } finally { s.cerrar(); }
});

test('clases en vivo: sin membresía no se inscribe; sin sesión o con un id raro se rechaza', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/webinars/55/registro', { registrado: true }, 'gratis')).status, 402);
    assert.deepEqual((await s.llamar('/api/webinars/registros', null, 'gratis')).cuerpo.ids, []);
    assert.equal((await s.llamar('/api/webinars/55/registro', { registrado: true }, '')).status, 401);
    assert.equal((await s.llamar('/api/webinars/ab%20cd/registro', { registrado: true }, 'ana')).status, 400);
    assert.equal(s.db.datos.has('members/gratis/clases_vivo/55'), false);
  } finally { s.cerrar(); }
});

// ---------- Clases de prueba (solo administradores) ----------
test('clases de prueba: solo un administrador las crea, lista y borra; un miembro recibe 403', async () => {
  process.env.ADMIN_EMAILS = 'jefa@fisioteck.test';
  tokens.jefa = { uid: 'jefa', email: 'jefa@fisioteck.test', email_verified: true };
  const s = await levantar();
  try {
    const cuerpo = { title: 'Prueba de Meet', date: '2026-12-01', time: '18:00', duration: 45, link: 'https://meet.google.com/abc-defg-hij', instructor: 'Equipo' };
    assert.equal((await s.llamar('/api/admin/clases-prueba', cuerpo, 'ana')).status, 403, 'un miembro no puede crear pruebas');
    assert.equal((await s.llamar('/api/admin/clases-prueba', null, 'ana')).status, 403, 'ni verlas');
    const creada = await s.llamar('/api/admin/clases-prueba', cuerpo, 'jefa');
    assert.equal(creada.status, 200); assert.match(creada.cuerpo.clase.id, /^prueba-/); assert.equal(creada.cuerpo.clase.prueba, true); assert.equal(creada.cuerpo.clase.tieneEnlace, true); assert.equal(creada.cuerpo.clase.duration, 45);
    const id = creada.cuerpo.clase.id;
    // editar la misma clase conserva el id
    const edit = await s.llamar('/api/admin/clases-prueba', { ...cuerpo, id, title: 'Prueba editada', duration: 5000 }, 'jefa');
    assert.equal(edit.cuerpo.clase.id, id); assert.equal(edit.cuerpo.clase.duration, 480, 'la duración se limita a 480');
    const lista = (await s.llamar('/api/admin/clases-prueba', null, 'jefa')).cuerpo.clases;
    assert.equal(lista.length, 1); assert.equal(lista[0].title, 'Prueba editada');
    // nunca se mezcla con las clases reales ni con la colección de enlaces de los miembros
    assert.equal(s.db.datos.has('webinarsPrivados/' + id), false);
    assert.equal((await s.llamar('/api/admin/clases-prueba/' + id, null, 'ana', 'DELETE')).status, 403);
    assert.equal((await s.llamar('/api/admin/clases-prueba/' + id, null, 'jefa', 'DELETE')).status, 200);
    assert.equal((await s.llamar('/api/admin/clases-prueba', null, 'jefa')).cuerpo.clases.length, 0);
  } finally { s.cerrar(); delete process.env.ADMIN_EMAILS; }
});

test('clases de prueba: se rechazan datos incompletos, enlaces raros y ids que no son de prueba', async () => {
  process.env.ADMIN_EMAILS = 'jefa@fisioteck.test';
  tokens.jefa = { uid: 'jefa', email: 'jefa@fisioteck.test', email_verified: true };
  const s = await levantar();
  try {
    const ok = { title: 'X', date: '2026-12-01', time: '18:00' };
    assert.equal((await s.llamar('/api/admin/clases-prueba', ok, 'jefa')).status, 200, 'con datos completos sí se guarda');
    assert.equal((await s.llamar('/api/admin/clases-prueba', { ...ok, title: '' }, 'jefa')).status, 400);
    assert.equal((await s.llamar('/api/admin/clases-prueba', { ...ok, date: '1 de diciembre' }, 'jefa')).status, 400);
    assert.equal((await s.llamar('/api/admin/clases-prueba', { ...ok, time: '6pm' }, 'jefa')).status, 400);
    assert.equal((await s.llamar('/api/admin/clases-prueba', { ...ok, link: 'javascript:alert(1)' }, 'jefa')).status, 400);
    assert.equal((await s.llamar('/api/admin/clases-prueba', { ...ok, id: '1730000000' }, 'jefa')).status, 400, 'no se puede pisar una clase real');
    assert.equal((await s.llamar('/api/admin/clases-prueba/1730000000', null, 'jefa', 'DELETE')).status, 400);
    assert.equal((await s.llamar('/api/admin/clases-prueba', ok, '')).status, 401);
  } finally { s.cerrar(); delete process.env.ADMIN_EMAILS; }
});
