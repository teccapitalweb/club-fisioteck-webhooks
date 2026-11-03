const test = require('node:test');
const assert = require('node:assert/strict');
const { crearMiembrosPublico } = require('../services/miembros-publico');

const dbFalsa = (n, lecturas) => ({ collection: nombre => { assert.equal(nombre, 'members'); return { where: (campo, op, estados) => { assert.equal(campo, 'status'); assert.equal(op, 'in'); assert.deepEqual(estados, ['active', 'paid', 'cancelled']); return { count: () => ({ get: async () => { lecturas.n++; return { data: () => ({ count: n }) }; } }) }; } }; } });

test('cuenta miembros con membresía vigente y guarda el resultado 10 minutos', async () => {
  const lecturas = { n: 0 }; let t = 1000;
  const s = crearMiembrosPublico({ db: dbFalsa(120, lecturas), ahora: () => t });
  assert.equal(await s.contar(), 120);
  t += 9 * 60 * 1000; assert.equal(await s.contar(), 120); assert.equal(lecturas.n, 1, 'usa la memoria');
  t += 2 * 60 * 1000; await s.contar(); assert.equal(lecturas.n, 2, 'pasados 10 min vuelve a contar');
});

test('la ruta pública devuelve solo el número y no se cae si Firestore falla', async () => {
  const rutas = {}; const app = { get: (r, f) => { rutas[r] = f; } };
  const s = crearMiembrosPublico({ db: dbFalsa(7, { n: 0 }) }); s.montarRutas(app);
  let cuerpo, estado = 200; const res = { set() {}, json: c => { cuerpo = c; }, status: e => { estado = e; return res; } };
  await rutas['/api/miembros-publico']({}, res);
  assert.deepEqual(cuerpo, { miembros: 7 });
  const malo = crearMiembrosPublico({ db: { collection: () => { throw new Error('cuota'); } } }); malo.montarRutas(app);
  await rutas['/api/miembros-publico']({}, res); assert.equal(estado, 503);
});
