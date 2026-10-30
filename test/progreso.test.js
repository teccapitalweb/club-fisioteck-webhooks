const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasProgreso } = require('../services/progreso');

// Firestore falso mínimo (get / set con merge)
function fakeDb(semilla = {}) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, data: () => v }; },
    async set(v, opts) { datos.set(ruta, opts && opts.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); },
    collection: n => ({ doc: id => ref(ruta + '/' + n + '/' + id) })
  });
  return { collection: n => ({ doc: id => ref(n + '/' + id) }), datos };
}

const catalogo = { courses: [{ courseId: 11, title: 'Curso', lessons: [{ lessonId: 1, isPreview: true }, { lessonId: 2 }, { lessonId: 3 }] }] };
const tokens = {
  socio: { uid: 'u1', email: 's@mail.com', email_verified: true },
  admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }
};
const conMembresia = m => m.status === 'active';

async function levantar(semilla) {
  const db = fakeDb(semilla);
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const app = express(); app.use(express.json());
  montarRutasProgreso(app, { db, admin, cargarCatalogo: () => catalogo, tieneMembresia: conMembresia });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, { token, cuerpo } = {}) => {
    const r = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, cerrar: () => srv.close() };
}
const marcar = (s, i, token = 'socio') => s.llamar('/api/cursos/11/progreso', { token, cuerpo: { leccion: i } });

test('exige sesión y valida la clase', async () => {
  const s = await levantar({ 'members/u1': { status: 'active' } });
  try {
    assert.equal((await s.llamar('/api/cursos/11/progreso', { cuerpo: { leccion: 0 } })).status, 401);
    assert.equal((await marcar(s, 9)).status, 400);
    assert.equal((await marcar(s, 'x')).status, 400);
    assert.equal((await s.llamar('/api/cursos/99/progreso', { token: 'socio', cuerpo: { leccion: 0 } })).status, 404);
  } finally { s.cerrar(); }
});

test('con membresía guarda en orden y rechaza saltarse clases', async () => {
  const s = await levantar({ 'members/u1': { status: 'active' } });
  try {
    assert.equal((await marcar(s, 2)).status, 409);
    assert.deepEqual((await marcar(s, 0)).cuerpo.completed, [0]);
    assert.deepEqual((await marcar(s, 0)).cuerpo.completed, [0]);
    assert.deepEqual((await marcar(s, 1)).cuerpo.completed, [0, 1]);
    const fin = await marcar(s, 2);
    assert.equal(fin.cuerpo.completo, true);
    assert.deepEqual(s.db.datos.get('members/u1/progress/courses').c_11.completed, [0, 1, 2]);
    const lectura = await s.llamar('/api/cursos/progreso', { token: 'socio' });
    assert.equal(lectura.cuerpo.cursos[0].completo, true);
  } finally { s.cerrar(); }
});

test('sin membresía: la clase de vista previa del catálogo sí se abre (como Alintec); las demás no', async () => {
  const s = await levantar({ 'members/u1': { status: 'registered' } });
  try {
    assert.equal((await marcar(s, 0)).status, 200, 'la clase isPreview se puede ver y marcar sin membresía');
    assert.equal((await marcar(s, 1)).status, 402);
    assert.equal((await marcar(s, 2)).status, 402);
  } finally { s.cerrar(); }
});

test('la prueba gratuita cubre el curso elegido menos la última clase', async () => {
  const s = await levantar({ 'members/u1': { status: 'registered', trialCourseId: 11 } });
  try {
    assert.equal((await marcar(s, 0)).status, 200);
    assert.equal((await marcar(s, 1)).status, 200);
    assert.equal((await marcar(s, 2)).status, 402); // la última queda para suscriptores
  } finally { s.cerrar(); }
});

test('una prueba de otro curso no abre este', async () => {
  const s = await levantar({ 'members/u1': { status: 'registered', trialCourseId: 99 } });
  try { assert.equal((await marcar(s, 1)).status, 402); } finally { s.cerrar(); }
});

test('el administrador no tiene restricciones', async () => {
  const s = await levantar({ 'members/a1': { status: 'registered' } });
  try { assert.equal((await marcar(s, 2, 'admin')).status, 200); } finally { s.cerrar(); }
});

test('sin documento de socio no guarda nada', async () => {
  const s = await levantar({});
  try { assert.equal((await marcar(s, 0)).status, 403); } finally { s.cerrar(); }
});

test('si la clase tiene preguntas, el servidor exige acertar al menos el 60 % para completarla', async () => {
  const preguntas = [{ tipo: 'vof', pregunta: 'a', correcta: 0 }, { tipo: 'vof', pregunta: 'b', correcta: 1 }, { tipo: 'vof', pregunta: 'c', correcta: 0 }];
  const s = await levantar({ 'members/u1': { status: 'active' }, 'members/a1': { status: 'registered' }, 'preguntasCurso/11': { clases: { '0': preguntas } } });
  try {
    assert.equal((await marcar(s, 0)).status, 409, 'sin contestar no se completa');
    await s.db.collection('members').doc('u1').collection('progress').doc('quiz').set({ c_11_0: { 0: true, 1: false, 2: false } });
    assert.equal((await marcar(s, 0)).status, 409, '1 de 3 no alcanza');
    await s.db.collection('members').doc('u1').collection('progress').doc('quiz').set({ c_11_0: { 0: true, 1: true, 2: false } });
    assert.equal((await marcar(s, 0)).status, 200, '2 de 3 sí');
    assert.equal((await marcar(s, 1)).status, 200, 'una clase sin preguntas no pide nada');
    assert.equal((await marcar(s, 0, 'admin')).status, 200, 'el administrador no tiene restricciones');
  } finally { s.cerrar(); }
});
