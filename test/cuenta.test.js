const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasCuenta } = require('../services/cuenta');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v) { datos.set(ruta, JSON.parse(JSON.stringify(v))); },
    async update(v) { datos.set(ruta, { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) }); },
    async delete() { datos.delete(ruta); },
    collection: n => col(ruta + '/' + n), doc: n => ref(ruta + '/' + n), path: ruta
  });
  const col = nombre => {
    let lim = 1e9; const filtros = [];
    const q = {
      doc: id => ref(nombre + '/' + id), limit(n) { lim = n; return q; }, where(c, o, v) { filtros.push([c, v]); return q; },
      async get() {
        const prof = nombre.split('/').length + 1;
        const docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === prof).filter(([, v]) => filtros.every(([c, val]) => v[c] === val)).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        return { docs: docs.slice(0, lim), empty: !docs.length };
      }
    };
    return q;
  };
  // como Firestore real: borra el documento y todo lo que cuelga de él
  const recursiveDelete = async r => { for (const k of [...datos.keys()]) if (k === r.path || k.startsWith(r.path + '/')) datos.delete(k); };
  return { collection: col, recursiveDelete, datos };
}
const tokens = { admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }, socio: { uid: 's1', email: 'S@m.com', email_verified: true } };
async function levantar(semilla, stripe, extra) {
  const db = fakeDb(semilla), app = express(); app.use(express.json());
  const borrados = [];
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; }, deleteUser: async uid => { borrados.push(uid); } }) };
  montarRutasCuenta(app, { db, admin, stripe, ...(extra || {}) });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (cuerpo, quien = 'socio', ruta = '/api/cuenta/eliminar') => {
    const r = await fetch(base + ruta, { method: 'POST', headers: { Authorization: 'Bearer ' + quien, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { db, borrados, llamar, cerrar: () => srv.close() };
}
const semilla = () => ({
  'members/s1': { name: 'Ana', email: 's@m.com', stripeSubscriptionId: 'sub_1' },
  'members/s1/progress/retos': { x: 1 },
  'members/s1/logros/a': { x: 1 },
  'members/s2': { name: 'Otra', email: 'o@m.com' },
  'directorio/s1': { nombre: 'Ana' },
  'canjes/s1': { saldo: 100 },
  'certificados/F1': { uid: 's1', folio: 'F1' },
  'certificados/F2': { uid: 's2', folio: 'F2' },
  'resenas/s1__c1': { uid: 's1' },
  'forum_posts/p1': { authorId: 's1', title: 'a' },
  'forum_posts/p1/replies/r1': { authorId: 's2' },
  'forum_posts/p2': { authorId: 's2', title: 'b' },
  'referidos/s1': { anfitrionUid: 's2' },
  'referidos/s3': { anfitrionUid: 's1' },
  'codigosReferido/ABC': { uid: 's1' },
  'pending_members/s@m.com': { email: 's@m.com' }
});

test('eliminar cuenta: pide la palabra de confirmación y no borra nada sin ella', async () => {
  const s = await levantar(semilla(), { subscriptions: { cancel: async () => ({}) } });
  const r = await s.llamar({ confirmar: 'no' });
  assert.equal(r.status, 400); assert.ok(s.db.datos.has('members/s1')); assert.deepEqual(s.borrados, []); s.cerrar();
});

test('eliminar cuenta: cancela Stripe y borra todo lo de la persona sin tocar lo de otras', async () => {
  const canceladas = [];
  const s = await levantar(semilla(), { subscriptions: { cancel: async id => { canceladas.push(id); return {}; } } });
  const r = await s.llamar({ confirmar: 'eliminar' });
  assert.equal(r.status, 200); assert.deepEqual(canceladas, ['sub_1']); assert.deepEqual(s.borrados, ['s1']);
  const d = s.db.datos;
  for (const k of ['members/s1', 'members/s1/progress/retos', 'members/s1/logros/a', 'directorio/s1', 'canjes/s1', 'certificados/F1', 'resenas/s1__c1', 'forum_posts/p1', 'forum_posts/p1/replies/r1', 'referidos/s1', 'codigosReferido/ABC', 'pending_members/s@m.com'])
    assert.ok(!d.has(k), k + ' debía borrarse');
  for (const k of ['members/s2', 'certificados/F2', 'forum_posts/p2', 'referidos/s3']) assert.ok(d.has(k), k + ' no debía tocarse');
  assert.equal(d.get('referidos/s3').anfitrionUid, ''); s.cerrar();
});

test('eliminar cuenta: si Stripe falla no se borra nada (para no seguir cobrando)', async () => {
  const s = await levantar(semilla(), { subscriptions: { cancel: async () => { throw new Error('timeout'); } } });
  const r = await s.llamar({ confirmar: 'ELIMINAR' });
  assert.equal(r.status, 502); assert.ok(s.db.datos.has('members/s1')); assert.deepEqual(s.borrados, []); s.cerrar();
});

test('eliminar cuenta: una suscripción que ya no existe en Stripe no impide borrar', async () => {
  const s = await levantar(semilla(), { subscriptions: { cancel: async () => { const e = new Error('No such subscription'); e.code = 'resource_missing'; throw e; } } });
  assert.equal((await s.llamar({ confirmar: 'ELIMINAR' })).status, 200); assert.deepEqual(s.borrados, ['s1']); s.cerrar();
});

test('eliminar cuenta: administradores y visitantes sin sesión no pueden', async () => {
  const s = await levantar(semilla(), { subscriptions: { cancel: async () => ({}) } });
  assert.equal((await s.llamar({ confirmar: 'ELIMINAR' }, 'admin')).status, 403);
  assert.equal((await s.llamar({ confirmar: 'ELIMINAR' }, 'nadie')).status, 401);
  assert.deepEqual(s.borrados, []); s.cerrar();
});

// ---- Cosas que el Club hacía en Firestore y ahora hace el servidor (reglas estrictas) ----
const VINCULAR = '/api/cuenta/vincular', VENCIMIENTO = '/api/cuenta/vencimiento';
const pagos = [{ date: '2026-10-01', amount: 199 }];
const semillaVinculo = extra => ({
  'members/viejo1': { email: 's@m.com', status: 'active', plan: 'mensual', payments: pagos, stripeCustomerId: 'cus_1', nextPaymentDate: '2026-12-01' },
  'members/otro': { email: 'otro@m.com', status: 'active', payments: pagos },
  ...extra
});

test('vincular: pasa los pagos del documento con su mismo correo a la cuenta de quien inició sesión', async () => {
  const s = await levantar(semillaVinculo({ 'members/s1': { name: 'Ana', email: 's@m.com', status: 'registered' } }), null);
  const r = await s.llamar({}, 'socio', VINCULAR);
  assert.equal(r.status, 200); assert.deepEqual(r.cuerpo, { existe: true, vinculado: true });
  const m = s.db.datos.get('members/s1');
  assert.equal(m.status, 'active'); assert.equal(m.plan, 'mensual'); assert.equal(m.stripeCustomerId, 'cus_1'); assert.deepEqual(m.payments, pagos);
  assert.ok(s.db.datos.has('members/viejo1'), 'el documento viejo no se borra'); s.cerrar();
});

test('vincular: crea la cuenta si todavía no tenía documento', async () => {
  const s = await levantar(semillaVinculo({}), null);
  const r = await s.llamar({}, 'socio', VINCULAR);
  assert.equal(r.cuerpo.vinculado, true); assert.equal(s.db.datos.get('members/s1').status, 'active'); s.cerrar();
});

test('vincular: solo consulta dice si existe pero no cambia nada', async () => {
  const s = await levantar(semillaVinculo({ 'members/s1': { email: 's@m.com', status: 'registered' } }), null);
  const r = await s.llamar({ soloConsulta: true }, 'socio', VINCULAR);
  assert.deepEqual(r.cuerpo, { existe: true, vinculado: false }); assert.equal(s.db.datos.get('members/s1').status, 'registered'); s.cerrar();
});

test('vincular: con dos documentos con pagos no mezcla cuentas', async () => {
  const s = await levantar(semillaVinculo({ 'members/viejo2': { email: 's@m.com', payments: pagos }, 'members/s1': { email: 's@m.com', status: 'registered' } }), null);
  const r = await s.llamar({}, 'socio', VINCULAR);
  assert.equal(r.cuerpo.vinculado, false); assert.equal(s.db.datos.get('members/s1').status, 'registered'); s.cerrar();
});

test('vincular: sin sesión no puede y no toca documentos de otras personas', async () => {
  const s = await levantar(semillaVinculo({ 'members/s1': { email: 's@m.com', status: 'registered' } }), null);
  assert.equal((await s.llamar({}, 'nadie', VINCULAR)).status, 401);
  assert.equal(s.db.datos.get('members/otro').status, 'active'); s.cerrar();
});

test('vencimiento: marca inactiva solo si el servidor confirma que ya venció', async () => {
  const semilla = () => ({ 'members/s1': { status: 'active', nextPaymentDate: '2020-01-01' } });
  let s = await levantar(semilla(), null, { tieneMembresia: () => false });
  assert.deepEqual((await s.llamar({ razon: 'vencimiento' }, 'socio', VENCIMIENTO)).cuerpo, { actualizado: true });
  assert.equal(s.db.datos.get('members/s1').status, 'inactive'); s.cerrar();
  s = await levantar(semilla(), null, { tieneMembresia: () => true });
  assert.deepEqual((await s.llamar({}, 'socio', VENCIMIENTO)).cuerpo, { actualizado: false });
  assert.equal(s.db.datos.get('members/s1').status, 'active'); s.cerrar();
});
