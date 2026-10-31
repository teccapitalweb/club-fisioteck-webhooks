const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasMateriales, validarMaterialesCurso, validarLibre, desbloqueado } = require('../services/materiales');
const { montarRutasAcceso } = require('../services/acceso');
const { montarRutasCreditos, leerCatalogo, setMaterialesLibres } = require('../services/creditos');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); },
    collection: n => ({ doc: id => ref(ruta + '/' + n + '/' + id) })
  });
  const col = nombre => {
    const q = { doc: id => ref(nombre + '/' + id), where() { return q; }, limit() { return q; },
      async get() { const prof = nombre.split('/').length + 1; const docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === prof).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v })); return { docs, empty: !docs.length }; } };
    return q;
  };
  return { collection: col, datos, async runTransaction(fn) { return fn({ get: r => r.get(), set: (r, v, o) => r.set(v, o) }); } };
}

const catalogo = { courses: [1, 2].map(id => ({ courseId: id, title: 'C' + id, lessons: [{ isPreview: true }, {}, {}] })) };
const tokens = { socio: { uid: 's1', email: 's@mail.com', email_verified: true }, prueba: { uid: 'p1', email: 'p@mail.com', email_verified: true }, gratis: { uid: 'g1', email: 'g@mail.com', email_verified: true }, admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true } };
const hoy = new Date(Date.now() - 6 * 3600e3).toISOString().split('T')[0];
const MATS = [{ titulo: 'Guía inicial', url: 'https://drive.google.com/file/d/AAA/view', desbloqueaEnClase: 0 }, { titulo: 'Protocolo', url: 'https://drive.google.com/file/d/BBB/view', desbloqueaEnClase: 2 }];

async function levantar(extra = {}) {
  const db = fakeDb({
    'members/s1': { status: 'active', payments: [{ date: hoy, amount: 249 }] },
    'members/p1': { status: 'registered', trialCourseId: 1 },
    'members/g1': { status: 'registered' },
    'materialesCurso/1': { materiales: MATS },
    'materialesCurso/2': { materiales: MATS },
    ...extra
  });
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const deps = { db, admin, cargarCatalogo: () => catalogo, tieneMembresia: m => m.status === 'active' };
  const app = express(); app.use(express.json());
  montarRutasAcceso(app, deps); montarRutasMateriales(app, deps); montarRutasCreditos(app, deps);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const url = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, token = 'socio', metodo) => {
    const r = await fetch(url + ruta, { method: metodo || (cuerpo ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, cerrar: () => srv.close() };
}
const avance = (...i) => ({ 'members/s1/progress/courses': { c_1: { completed: i }, c_2: { completed: i } } });

test('validarMaterialesCurso: título y enlace juntos, enlace http(s) y clase dentro del curso', () => {
  assert.equal(validarMaterialesCurso([{ titulo: 'A', url: '' }], 3).ok, false);
  assert.equal(validarMaterialesCurso([{ titulo: 'A', url: 'javascript:alert(1)' }], 3).ok, false);
  assert.equal(validarMaterialesCurso([{ titulo: 'A', url: 'https://x.com/a', desbloqueaEnClase: 9 }], 3).ok, false);
  const v = validarMaterialesCurso([{ titulo: ' A ', url: 'https://x.com/a', desbloqueaEnClase: '2' }, { titulo: '', url: '' }], 3);
  assert.equal(v.ok, true); assert.equal(v.materiales.length, 1); assert.equal(v.materiales[0].desbloqueaEnClase, 2);
});

test('desbloqueado: 0 desde el inicio; N al terminar la clase N', () => {
  assert.equal(desbloqueado({ desbloqueaEnClase: 0 }, new Set()), true);
  assert.equal(desbloqueado({ desbloqueaEnClase: 2 }, new Set([0])), false);
  assert.equal(desbloqueado({ desbloqueaEnClase: 2 }, new Set([0, 1])), true);
});

test('la lista no revela enlaces y cada material se abre según las clases terminadas', async () => {
  const s = await levantar(avance(0));
  try {
    const l = await s.llamar('/api/cursos/1/materiales');
    assert.equal(l.cuerpo.nivel, 'miembro');
    assert.equal(JSON.stringify(l.cuerpo).includes('drive.google'), false);
    assert.deepEqual(l.cuerpo.materiales.map(m => m.estado), ['abierto', 'bloqueado-clase']);
    assert.equal((await s.llamar('/api/cursos/1/materiales/0/enlace', {})).cuerpo.url, MATS[0].url);
    const bloq = await s.llamar('/api/cursos/1/materiales/1/enlace', {});
    assert.equal(bloq.status, 403); assert.match(bloq.cuerpo.error, /clase 2/);
    s.db.datos.set('members/s1/progress/courses', { c_1: { completed: [0, 1] } });
    assert.equal((await s.llamar('/api/cursos/1/materiales/1/enlace', {})).status, 200);
    assert.equal((await s.llamar('/api/cursos/1/materiales/9/enlace', {})).status, 404);
  } finally { s.cerrar(); }
});

test('sin membresía: la cuenta gratuita no los abre; la prueba solo abre los de SU curso', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/cursos/1/materiales/0/enlace', {}, 'gratis')).status, 402);
    assert.equal((await s.llamar('/api/cursos/1/materiales', null, 'gratis')).cuerpo.materiales[0].estado, 'sin-acceso');
    assert.equal((await s.llamar('/api/cursos/1/materiales/0/enlace', {}, 'prueba')).status, 200);
    assert.equal((await s.llamar('/api/cursos/2/materiales/0/enlace', {}, 'prueba')).status, 402);
  } finally { s.cerrar(); }
});

test('con el escalonado, un curso aún cerrado no entrega materiales', async () => {
  const s = await levantar({ 'config/club': { escalonadoActivo: true } });
  try {
    assert.equal((await s.llamar('/api/cursos/2/materiales', null)).cuerpo.nivel, 'cerrado');
    assert.equal((await s.llamar('/api/cursos/2/materiales/0/enlace', {})).status, 403);
  } finally { s.cerrar(); }
});

test('el administrador ve y guarda los materiales del curso con sus enlaces', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/materiales-curso/1', null, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/materiales-curso/1', null, 'admin')).cuerpo.materiales[1].url, MATS[1].url);
    assert.equal((await s.llamar('/api/admin/materiales-curso/1', { materiales: [{ titulo: 'X', url: 'https://x.com/a', desbloqueaEnClase: 7 }] }, 'admin', 'PUT')).status, 400);
    assert.equal((await s.llamar('/api/admin/materiales-curso/1', { materiales: [{ titulo: 'Nuevo', url: 'https://x.com/a', desbloqueaEnClase: 3 }] }, 'admin', 'PUT')).status, 200);
    assert.equal(s.db.datos.get('materialesCurso/1').materiales[0].titulo, 'Nuevo');
  } finally { s.cerrar(); }
});

test('materiales libres: el panel los sube, se canjean con créditos y el enlace sigue privado', async () => {
  const s = await levantar({ 'members/g1': { status: 'registered', creditos: 150 } });
  try {
    assert.equal((await s.llamar('/api/admin/materiales-libres', { id: 'pdf-777', titulo: 'Guía libre', url: 'https://x.com/libre.pdf' }, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/materiales-libres', { id: 'pdf-777', titulo: 'Guía libre', url: 'no-es-url' }, 'admin')).status, 400);
    assert.equal((await s.llamar('/api/admin/materiales-libres', { id: 'pdf-777', titulo: 'Guía libre', desc: 'Para todos', url: 'https://x.com/libre.pdf' }, 'admin')).status, 200);
    const e = await s.llamar('/api/creditos', null, 'gratis');
    const m = e.cuerpo.materiales.find(x => x.id === 'pdf-777');
    assert.ok(m); assert.equal(m.url, undefined);
    assert.equal((await s.llamar('/api/materiales/pdf-777/enlace', null, 'gratis')).status, 402);
    assert.equal((await s.llamar('/api/creditos/canjear', { materialId: 'pdf-777' }, 'gratis')).status, 200);
    assert.equal((await s.llamar('/api/materiales/pdf-777/enlace', null, 'gratis')).cuerpo.url, 'https://x.com/libre.pdf');
    assert.equal((await s.llamar('/api/materiales/pdf-777/enlace', null, 'socio')).status, 402); // el miembro lo abre con retos o con créditos, no solo por tener membresía
    // retirarlo
    assert.equal((await s.llamar('/api/admin/materiales-libres/pdf-777', null, 'admin', 'DELETE')).status, 200);
    assert.equal(leerCatalogo().some(x => x.id === 'pdf-777'), false);
  } finally { s.cerrar(); setMaterialesLibres([]); }
});

test('validarLibre exige título, enlace y costo razonable', () => {
  assert.equal(validarLibre({ id: 'a b', titulo: 'x', url: 'https://x.com' }).ok, false);
  assert.equal(validarLibre({ id: 'pdf-1', titulo: '', url: 'https://x.com' }).ok, false);
  assert.equal(validarLibre({ id: 'pdf-1', titulo: 'x', url: 'https://x.com', costo: 0 }).ok, false);
  assert.equal(validarLibre({ id: 'pdf-1', titulo: 'x', url: 'https://x.com', costo: 150 }).material.costo, 150);
});

test('prueba gratuita: los materiales de SU curso se abren todos menos el último, sin esperar a terminar clases', async () => {
  const s = await levantar();
  try {
    const lista = (await s.llamar('/api/cursos/1/materiales', null, 'prueba')).cuerpo.materiales, n = lista.length;
    assert.ok(n >= 2);
    lista.forEach((x, i) => assert.equal(x.estado, i < n - 1 ? 'abierto' : 'sin-acceso', 'material ' + i));
    assert.equal((await s.llamar('/api/cursos/1/materiales/' + (n - 1) + '/enlace', {}, 'prueba')).status, 402);
    assert.equal((await s.llamar('/api/cursos/1/materiales/' + (n - 2) + '/enlace', {}, 'prueba')).status, 200);
  } finally { s.cerrar(); }
});
