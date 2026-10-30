const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasQuiz, validarClases } = require('../services/quiz');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); },
    collection: n => ({ doc: id => ref(ruta + '/' + n + '/' + id) })
  });
  return { collection: n => ({ doc: id => ref(n + '/' + id) }), datos };
}
const tokens = { socio: { uid: 's1', email: 's@mail.com' }, prueba: { uid: 'p1', email: 'p@mail.com' }, gratis: { uid: 'g1', email: 'g@mail.com' }, admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true } };
const PREG = { clases: { 0: [{ tipo: 'multiple', pregunta: '¿A?', opciones: ['x', 'y', 'z'], correcta: 2 }, { tipo: 'vof', pregunta: '¿V?', correcta: 1 }] } };

async function levantar() {
  const db = fakeDb({ 'members/s1': { status: 'active' }, 'members/p1': { trialCourseId: 1 }, 'members/g1': {}, 'preguntasCurso/1': PREG });
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const app = express(); app.use(express.json());
  montarRutasQuiz(app, { db, admin, tieneMembresia: m => m.status === 'active' });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const llamar = async (ruta, cuerpo, token = 'socio', metodo) => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + ruta, { method: metodo || (cuerpo ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, cerrar: () => srv.close() };
}

test('el servidor califica y revela la correcta solo al contestar', async () => {
  const s = await levantar();
  try {
    assert.deepEqual((await s.llamar('/api/cursos/1/quiz', { sessionIndex: 0, pregunta: 0, respuesta: 2 })).cuerpo, { acertada: true, correcta: 2 });
    assert.deepEqual((await s.llamar('/api/cursos/1/quiz', { sessionIndex: 0, pregunta: 1, respuesta: 0 })).cuerpo, { acertada: false, correcta: 1 });
    assert.equal((await s.llamar('/api/cursos/1/quiz', { sessionIndex: 0, pregunta: 0, respuesta: 9 })).status, 400);
    assert.equal((await s.llamar('/api/cursos/1/quiz', { sessionIndex: 0, pregunta: 7, respuesta: 0 })).status, 404);
    assert.equal((await s.llamar('/api/cursos/1/quiz', { sessionIndex: 'x', pregunta: 0, respuesta: 0 })).status, 400);
  } finally { s.cerrar(); }
});

test('acceso: la cuenta gratuita no; la prueba solo en su curso', async () => {
  const s = await levantar();
  try {
    const b = { sessionIndex: 0, pregunta: 0, respuesta: 0 };
    assert.equal((await s.llamar('/api/cursos/1/quiz', b, 'gratis')).status, 402);
    assert.equal((await s.llamar('/api/cursos/1/quiz', b, 'prueba')).status, 200);
    assert.equal((await s.llamar('/api/cursos/2/quiz', b, 'prueba')).status, 402);
    assert.equal((await s.llamar('/api/cursos/1/quiz', b, 'sin-sesion')).status, 401);
  } finally { s.cerrar(); }
});

test('solo el administrador lee y guarda las respuestas', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/preguntas-curso/1', null, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/preguntas-curso/1', null, 'admin')).cuerpo.clases[0][0].correcta, 2);
    const mala = { clases: { 0: [{ tipo: 'multiple', pregunta: 'Q', opciones: ['a', 'b'], correcta: 5 }] } };
    assert.equal((await s.llamar('/api/admin/preguntas-curso/1', mala, 'admin', 'PUT')).status, 400);
    const buena = { clases: { 2: [{ tipo: 'vof', pregunta: 'Q', correcta: 0 }] } };
    assert.equal((await s.llamar('/api/admin/preguntas-curso/1', buena, 'admin', 'PUT')).status, 200);
    assert.deepEqual(Object.keys(s.db.datos.get('preguntasCurso/1').clases), ['2']);
  } finally { s.cerrar(); }
});

test('validarClases descarta clases sin preguntas y rechaza índices fuera de rango', () => {
  assert.deepEqual(validarClases({ 1: [] }, 5), { ok: true, clases: {} });
  assert.equal(validarClases({ 9: [] }, 5).ok, false);
});

test('el quiz guarda quién acertó qué (el servidor lo usa para exigir las preguntas al completar la clase)', async () => {
  const s = await levantar();
  try {
    await s.llamar('/api/cursos/1/quiz', { sessionIndex: 0, pregunta: 0, respuesta: 2 });
    await s.llamar('/api/cursos/1/quiz', { sessionIndex: 0, pregunta: 1, respuesta: 0 });
    await s.llamar('/api/cursos/1/quiz', { sessionIndex: 0, pregunta: 1, respuesta: 1 });
    const g = s.db.datos.get('members/s1/progress/quiz');
    assert.deepEqual(g.c_1_0, { 0: true, 1: true }, 'una vez acertada, se queda acertada');
    assert.equal(s.db.datos.has('members/a1/progress/quiz'), false);
  } finally { s.cerrar(); }
});

test('el servidor entrega las preguntas de la clase sin revelar la correcta, solo con acceso', async () => {
  const s = await levantar();
  try {
    const r = await s.llamar('/api/cursos/1/clases/0/preguntas');
    assert.equal(r.status, 200); assert.equal(r.cuerpo.preguntas.length, 2);
    assert.deepEqual(r.cuerpo.preguntas[0], { tipo: 'multiple', pregunta: '¿A?', opciones: ['x', 'y', 'z'], _k: 0 });
    assert.equal(JSON.stringify(r.cuerpo).includes('correcta'), false, 'no se filtra la respuesta');
    assert.equal((await s.llamar('/api/cursos/1/clases/0/preguntas', null, 'prueba')).status, 200, 'la prueba gratuita de ese curso también');
    assert.equal((await s.llamar('/api/cursos/1/clases/0/preguntas', null, 'gratis')).status, 402);
    assert.deepEqual((await s.llamar('/api/cursos/1/clases/5/preguntas')).cuerpo.preguntas, [], 'clase sin preguntas');
  } finally { s.cerrar(); }
});
