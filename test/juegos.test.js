const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasJuegos, validarJuego, validarClasesJuego, sanitizarJuego } = require('../services/juegos');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, data: () => v }; },
    async set(v) { datos.set(ruta, JSON.parse(JSON.stringify(v))); }
  });
  return { collection: n => ({ doc: id => ref(n + '/' + id) }), datos };
}
const tokens = { socio: { uid: 's1', email: 's@mail.com' }, prueba: { uid: 'p1', email: 'p@mail.com' }, gratis: { uid: 'g1', email: 'g@mail.com' }, admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true } };
const JUEGOS = {
  clases: {
    0: { tipo: 'sopa_letras', datos: { palabras: ['MÚSCULO', 'Hueso', 'nervio'] } },
    2: { tipo: 'ahorcado', datos: { palabras: [{ palabra: 'Rótula', pista: 'Hueso de la rodilla' }] } }
  }
};

async function levantar() {
  const db = fakeDb({ 'members/s1': { status: 'active' }, 'members/p1': { trialCourseId: 1 }, 'members/g1': {}, 'juegosCurso/1': JUEGOS });
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const app = express(); app.use(express.json());
  montarRutasJuegos(app, { db, admin, tieneMembresia: m => m.status === 'active' });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const llamar = async (ruta, cuerpo, token = 'socio', metodo) => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + ruta, { method: metodo || (cuerpo ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, cerrar: () => srv.close() };
}

test('el socio recibe el juego de la clase; sin juego devuelve null', async () => {
  const s = await levantar();
  try {
    const r = await s.llamar('/api/cursos/1/clases/0/juego');
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.juego.tipo, 'sopa_letras');
    assert.deepEqual(r.cuerpo.juego.datos.palabras, ['MUSCULO', 'HUESO', 'NERVIO']);
    assert.equal((await s.llamar('/api/cursos/1/clases/1/juego')).cuerpo.juego, null);
    assert.equal((await s.llamar('/api/cursos/9/clases/0/juego')).cuerpo.juego, null);
    assert.equal((await s.llamar('/api/cursos/1/clases/x/juego')).status, 400);
  } finally { s.cerrar(); }
});

test('acceso: la cuenta gratuita no; la prueba solo en su curso; sin sesión 401', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/cursos/1/clases/0/juego', null, 'gratis')).status, 402);
    assert.equal((await s.llamar('/api/cursos/1/clases/0/juego', null, 'prueba')).status, 200);
    assert.equal((await s.llamar('/api/cursos/2/clases/0/juego', null, 'prueba')).status, 402);
    assert.equal((await s.llamar('/api/cursos/1/clases/0/juego', null, 'admin')).status, 200);
    assert.equal((await s.llamar('/api/cursos/1/clases/0/juego', null, 'sin-sesion')).status, 401);
  } finally { s.cerrar(); }
});

test('solo el administrador lee y guarda los juegos', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/juegos-curso/1', null, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/juegos-curso/1', { clases: {} }, 'socio', 'PUT')).status, 403);
    assert.equal((await s.llamar('/api/admin/juegos-curso/1', null, 'admin')).cuerpo.clases[2].tipo, 'ahorcado');
    const buena = { clases: { 1: { tipo: 'memorama', datos: { pares: [{ termino: 'a', definicion: 'b' }, { termino: 'c', definicion: 'd' }, { termino: 'e', definicion: 'f' }] } } } };
    assert.equal((await s.llamar('/api/admin/juegos-curso/5', buena, 'admin', 'PUT')).status, 200);
    assert.equal(s.db.datos.get('juegosCurso/5').clases[1].datos.pares.length, 3);
    assert.equal((await s.llamar('/api/admin/juegos-curso/5', { clases: { 999: buena.clases[1] } }, 'admin', 'PUT')).status, 400);
    assert.equal((await s.llamar('/api/admin/juegos-curso/bad%20id', buena, 'admin', 'PUT')).status, 400);
  } finally { s.cerrar(); }
});

test('validarJuego: reglas de cada tipo', () => {
  assert.equal(validarJuego(null, 'x').juego, null);
  assert.equal(validarJuego({ tipo: 'otro', datos: {} }, 'x').ok, false);
  assert.equal(validarJuego({ tipo: 'sopa_letras', datos: { palabras: ['uno', 'dos'] } }, 'x').ok, false);
  assert.equal(validarJuego({ tipo: 'sopa_letras', datos: { palabras: ['ab', 'cd', 'ef'] } }, 'x').ok, false);
  assert.equal(validarJuego({ tipo: 'memorama', datos: { pares: [{ termino: 'a', definicion: '' }] } }, 'x').ok, false);
  assert.equal(validarJuego({ tipo: 'ahorcado', datos: { palabras: [{ palabra: 'ab' }] } }, 'x').ok, false);
  const r = validarJuego({ tipo: 'rompecabezas', datos: { dificultad: 9, imagenUrl: 'javascript:alert(1)' } }, 'x');
  assert.deepEqual(r.juego.datos, { dificultad: '3', imagenUrl: '' });
  assert.equal(validarJuego({ tipo: 'rompecabezas', datos: { dificultad: '4', imagenUrl: 'https://x.mx/a.png' } }, 'x').juego.datos.imagenUrl, 'https://x.mx/a.png');
  assert.equal(validarJuego({ tipo: 'rompecabezas', datos: { imagenUrl: 'assets/a.webp' } }, 'x').juego.datos.imagenUrl, 'assets/a.webp');
});

test('sanitizarJuego solo deja el esquema del tipo', () => {
  assert.equal(sanitizarJuego(null), null);
  assert.equal(sanitizarJuego('texto'), null);
  const j = sanitizarJuego({ tipo: 'ahorcado', secreto: 1, datos: { extra: 1, palabras: [{ palabra: 'Ñandú', pista: 'Ave', otro: 2 }] } });
  assert.deepEqual(j, { tipo: 'ahorcado', datos: { palabras: [{ palabra: 'ÑANDU', pista: 'Ave' }] } });
  assert.equal(validarClasesJuego([], 5).ok, false);
});
