const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasResenas, validarResena, resumir, crearLimitador } = require('../services/resenas');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, data: () => v }; },
    async set(v) { datos.set(ruta, JSON.parse(JSON.stringify(v))); }
  });
  const col = nombre => {
    const filtros = []; let orden = null, lim = 1e9;
    const q = {
      doc: id => ref(nombre + '/' + id),
      where(c, o, v) { filtros.push([c, v]); return q; },
      orderBy(c) { orden = c; return q; }, limit(n) { lim = n; return q; },
      async get() {
        let docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === 2)
          .filter(([, v]) => filtros.every(([c, val]) => v[c] === val)).map(([k, v]) => ({ id: k.split('/')[1], data: () => v }));
        if (orden) docs.sort((a, b) => Number(b.data()[orden]) - Number(a.data()[orden]));
        return { docs: docs.slice(0, lim) };
      }
    };
    return q;
  };
  return { collection: col, datos };
}

const catalogo = { courses: [{ courseId: 11, title: 'Curso A', lessons: [{}] }, { courseId: 12, title: 'Curso B', lessons: [{}] }] };
const tokens = {
  socio: { uid: 'u1', email: 'a@mail.com', email_verified: true },
  otro: { uid: 'u2', email: 'b@mail.com', email_verified: true },
  admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }
};
const cert = (uid, cursoId, extra = {}) => ({ uid, cursoId: String(cursoId), cursoTitulo: 'Curso ' + cursoId, nombre: 'Ana Torres', emitidoEn: '2026-10-20T00:00:00.000Z', revocado: false, ...extra });

async function levantar(semilla) {
  const db = fakeDb(semilla);
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const app = express(); app.use(express.json());
  montarRutasResenas(app, { db, admin, cargarCatalogo: () => catalogo });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, token = 'socio') => {
    const r = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, cerrar: () => srv.close() };
}

test('valida estrellas, curso y comentario', () => {
  assert.throws(() => validarResena({ cursoId: 1, estrellas: 6 }), /1 a 5/);
  assert.throws(() => validarResena({ cursoId: '', estrellas: 3 }), /Curso/);
  assert.equal(validarResena({ cursoId: 1, estrellas: 4, comentario: 'x'.repeat(900) }).comentario.length, 500);
});

test('el limitador frena después de 20 por hora', () => {
  const lim = crearLimitador({ max: 2 });
  lim('u'); lim('u');
  assert.throws(() => lim('u'), /Demasiadas/);
});

test('resumen: promedio, histograma y por curso', () => {
  const r = resumir([{ cursoId: '1', curso: 'A', estrellas: 5 }, { cursoId: '1', curso: 'A', estrellas: 3 }, { cursoId: '2', curso: 'B', estrellas: 4 }]);
  assert.equal(r.total, 3); assert.equal(r.promedio, 4); assert.equal(r.histograma[5], 1);
  assert.equal(r.porCurso[0].curso, 'A'); // mismo promedio (4): gana el de más reseñas
});

test('solo califica quien terminó el curso, y recalificar actualiza la misma reseña', async () => {
  const s = await levantar({ 'certificados/FT-1': cert('u1', 11), 'members/u1': { name: 'Ana Torres' } });
  try {
    assert.equal((await s.llamar('/api/resenas', { cursoId: 12, estrellas: 5 })).status, 403);
    assert.equal((await s.llamar('/api/resenas', { cursoId: 11, estrellas: 5, comentario: 'Excelente' })).cuerpo.actualizada, false);
    assert.equal((await s.llamar('/api/resenas', { cursoId: 11, estrellas: 4 })).cuerpo.actualizada, true);
    assert.equal(s.db.datos.get('resenas/u1__11').estrellas, 4);
    assert.equal((await s.llamar('/api/resenas', { cursoId: 11, estrellas: 5 }, 'otro')).status, 403);
  } finally { s.cerrar(); }
});

test('un certificado revocado no permite calificar', async () => {
  const s = await levantar({ 'certificados/FT-1': cert('u1', 11, { revocado: true }) });
  try { assert.equal((await s.llamar('/api/resenas', { cursoId: 11, estrellas: 5 })).status, 403); } finally { s.cerrar(); }
});

test('GET mias devuelve lo calificado y los cursos terminados', async () => {
  const s = await levantar({ 'certificados/FT-1': cert('u1', 11), 'certificados/FT-2': cert('u1', 12), 'resenas/u1__11': { uid: 'u1', cursoId: '11', estrellas: 5, comentario: 'ok' } });
  try {
    const r = await s.llamar('/api/resenas/mias');
    assert.equal(r.cuerpo.resenas.length, 1);
    assert.equal(r.cuerpo.terminados.length, 2);
  } finally { s.cerrar(); }
});

test('el panel de administrador lee todas las reseñas; un socio no', async () => {
  const s = await levantar({
    'resenas/u1__11': { uid: 'u1', cursoId: '11', curso: 'Curso A', estrellas: 5, comentario: 'Genial', nombre: 'Ana', email: 'a@mail.com', actualizadaMs: 2 },
    'resenas/u2__11': { uid: 'u2', cursoId: '11', curso: 'Curso A', estrellas: 3, comentario: '', nombre: 'Luis', email: 'b@mail.com', actualizadaMs: 1 }
  });
  try {
    assert.equal((await s.llamar('/api/admin/resenas')).status, 403);
    const r = await s.llamar('/api/admin/resenas', null, 'admin');
    assert.equal(r.cuerpo.total, 2); assert.equal(r.cuerpo.promedio, 4); assert.equal(r.cuerpo.resenas[0].nombre, 'Ana');
  } finally { s.cerrar(); }
});

test('moderación: el administrador oculta y vuelve a mostrar una reseña; no cuenta en el promedio y no se borra', async () => {
  const s = await levantar({
    'resenas/u1__11': { uid: 'u1', cursoId: '11', curso: 'Curso A', estrellas: 5, comentario: 'Genial', nombre: 'Ana', email: 'a@mail.com', actualizadaMs: 2 },
    'resenas/u2__11': { uid: 'u2', cursoId: '11', curso: 'Curso A', estrellas: 1, comentario: 'Ofensivo', nombre: 'Luis', email: 'b@mail.com', actualizadaMs: 1 }
  });
  try {
    assert.equal((await s.llamar('/api/admin/resenas/u2__11/ocultar', { oculta: true })).status, 403);
    assert.equal((await s.llamar('/api/admin/resenas/no__existe/ocultar', { oculta: true }, 'admin')).status, 404);
    assert.equal((await s.llamar('/api/admin/resenas/u2__11/ocultar', { oculta: true }, 'admin')).status, 200);
    const r = (await s.llamar('/api/admin/resenas', null, 'admin')).cuerpo;
    assert.equal(r.total, 1); assert.equal(r.promedio, 5); assert.equal(r.ocultas, 1);
    assert.equal(r.resenas.length, 2, 'la oculta se sigue viendo en el panel para poder mostrarla');
    assert.equal(r.resenas.find(x => x.id === 'u2__11').oculta, true);
    assert.equal((await s.llamar('/api/admin/resenas/u2__11/ocultar', { oculta: false }, 'admin')).cuerpo.oculta, false);
    assert.equal((await s.llamar('/api/admin/resenas', null, 'admin')).cuerpo.total, 2);
  } finally { s.cerrar(); }
});
