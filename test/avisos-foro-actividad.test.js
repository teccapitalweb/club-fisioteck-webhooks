'use strict';
// AVISOS DEL FORO A LOS MIEMBROS: al autor «respondió tu tema»; a los demás con plan «hay nuevas respuestas» (uno por tema y persona, una vez por respuesta)
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasAvisos } = require('../services/avisos');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); },
    collection: n => col(ruta + '/' + n), doc: n => ref(ruta + '/' + n)
  });
  const col = nombre => {
    let lim = 1e9, filtro = null;
    const q = {
      doc: id => ref(nombre + '/' + id), limit(n) { lim = n; return q; },
      where(campo, op, valores) { filtro = d => valores.includes(d[campo]); return q; },
      async get() {
        const prof = nombre.split('/').length + 1;
        let docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === prof).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        if (filtro) docs = docs.filter(x => filtro(x.data()));
        return { docs: docs.slice(0, lim), empty: !docs.length };
      }
    };
    return q;
  };
  return { collection: col, datos };
}
const tokens = { ana: { uid: 'ana' }, beto: { uid: 'beto' }, caro: { uid: 'caro' }, dani: { uid: 'dani' }, gratis: { uid: 'gratis' } };
async function levantar(semilla) {
  const db = fakeDb(semilla), app = express(); app.use(express.json());
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  // plan vigente: la misma idea que memberHasPremiumAccess (estado activo)
  montarRutasAvisos(app, { db, admin, tieneMembresia: m => m.status === 'active' });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, quien) => { const r = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + quien, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json().catch(() => ({})) }; };
  return { db, llamar, cerrar: () => srv.close() };
}
const semilla = () => ({
  'members/ana': { status: 'active' }, 'members/beto': { status: 'active' }, 'members/caro': { status: 'active' }, 'members/dani': { status: 'active' }, 'members/gratis': { status: 'inactive' },
  'forum_posts/p1': { authorId: 'ana', title: 'Dolor de hombro', body: 'texto largo del tema' },
  'forum_posts/p1/replies/r1': { authorId: 'beto', authorName: 'Beto R.', body: 'Yo empezaría con control escapular' },
  'forum_posts/p1/replies/r2': { authorId: 'caro', authorName: 'Caro', body: 'Coincido con Beto' },
  'forum_posts/p2': { authorId: 'ana', title: 'Hola a todos', sinTitulo: true, body: 'Estoy evaluando opciones para especializarme' },
  'forum_posts/p2/replies/r9': { authorId: 'ana', authorName: 'Ana', body: 'Gracias por sus respuestas' }
});

test('foro: el autor recibe «respondió tu tema» y los demás miembros con plan «hay nuevas respuestas» (no quien responde ni quien no tiene plan)', async () => {
  const s = await levantar(semilla());
  try {
    const r = await s.llamar('/api/avisos/foro', { postId: 'p1', replyId: 'r1' }, 'beto');
    assert.equal(r.cuerpo.avisado, true); assert.equal(r.cuerpo.actividad, 2); // caro y dani
    const ana = (await s.llamar('/api/avisos', null, 'ana')).cuerpo.avisos;
    assert.equal(ana.length, 1); assert.equal(ana[0].tipo, 'foro'); assert.equal(ana[0].quien, 'Beto R.');
    const caro = (await s.llamar('/api/avisos', null, 'caro')).cuerpo.avisos;
    assert.equal(caro.length, 1); assert.equal(caro[0].tipo, 'foro-act'); assert.equal(caro[0].postId, 'p1'); assert.equal(caro[0].titulo, 'Dolor de hombro'); assert.equal(caro[0].leido, false);
    assert.equal((await s.llamar('/api/avisos', null, 'beto')).cuerpo.avisos.length, 0, 'quien responde no se avisa a sí mismo');
    assert.equal((await s.llamar('/api/avisos', null, 'gratis')).cuerpo.avisos.length, 0, 'sin plan no recibe');
    // la misma respuesta no se avisa dos veces
    const otra = await s.llamar('/api/avisos/foro', { postId: 'p1', replyId: 'r1' }, 'beto');
    assert.equal(otra.cuerpo.avisado, false); assert.equal(otra.cuerpo.actividad, 0);
    // una segunda respuesta renueva el mismo aviso (uno por tema y persona) y también avisa a Beto, que no es el autor
    const r2 = await s.llamar('/api/avisos/foro', { postId: 'p1', replyId: 'r2' }, 'caro');
    assert.equal(r2.cuerpo.actividad, 2); // beto y dani
    assert.equal((await s.llamar('/api/avisos', null, 'dani')).cuerpo.avisos.length, 1, 'un solo aviso por tema');
    assert.equal((await s.llamar('/api/avisos', null, 'beto')).cuerpo.avisos.length, 1);
    assert.equal((await s.llamar('/api/avisos', null, 'ana')).cuerpo.avisos.length, 2, 'el autor recibe un aviso por cada respuesta');
  } finally { s.cerrar(); }
});

test('foro: si el autor responde a su propio tema, el aviso general llega a los demás con plan y sin título se usa el comienzo del mensaje', async () => {
  const s = await levantar(semilla());
  try {
    const r = await s.llamar('/api/avisos/foro', { postId: 'p2', replyId: 'r9' }, 'ana');
    assert.equal(r.cuerpo.avisado, false); assert.equal(r.cuerpo.actividad, 3); // beto, caro y dani
    const beto = (await s.llamar('/api/avisos', null, 'beto')).cuerpo.avisos;
    assert.equal(beto.length, 1); assert.equal(beto[0].tipo, 'foro-act');
    assert.ok(beto[0].titulo.startsWith('Estoy evaluando'), 'sin título se muestra el comienzo del mensaje');
    assert.equal((await s.llamar('/api/avisos', null, 'ana')).cuerpo.avisos.length, 0);
  } finally { s.cerrar(); }
});

test('foro: un aviso general se puede marcar como leído', async () => {
  const s = await levantar(semilla());
  try {
    await s.llamar('/api/avisos/foro', { postId: 'p1', replyId: 'r1' }, 'beto');
    const a = (await s.llamar('/api/avisos', null, 'caro')).cuerpo.avisos[0];
    assert.equal((await s.llamar('/api/avisos/' + a.id + '/leido', {}, 'caro')).status, 200);
    assert.equal((await s.llamar('/api/avisos', null, 'caro')).cuerpo.avisos[0].leido, true);
  } finally { s.cerrar(); }
});
