const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasCreditos, normalizarClave, claveValida, evaluarCupon, leerCatalogo } = require('../services/creditos');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); },
    collection: n => col(ruta + '/' + n), doc: n => ref(ruta + '/' + n)
  });
  const col = nombre => {
    const filtros = []; let lim = 1e9, orden = null;
    const q = {
      doc: id => ref(nombre + '/' + id), where(c, o, v) { filtros.push([c, v]); return q; },
      orderBy(c) { orden = c; return q; }, limit(n) { lim = n; return q; },
      async get() {
        const prof = nombre.split('/').length + 1;
        let docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === prof)
          .filter(([, v]) => filtros.every(([c, val]) => v[c] === val)).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        if (orden) docs.sort((a, b) => Number(b.data()[orden]) - Number(a.data()[orden]));
        return { docs: docs.slice(0, lim), empty: !docs.length };
      }
    };
    return q;
  };
  return { collection: col, datos, async runTransaction(fn) { return fn({ get: r => r.get(), set: (r, v, o) => r.set(v, o) }); } };
}

const tokens = {
  gratis: { uid: 'g1', email: 'g@mail.com', email_verified: true },
  socio: { uid: 's1', email: 's@mail.com', email_verified: true },
  sinCorreo: { uid: 'g2', email: 'x@mail.com', email_verified: false },
  admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }
};
const base = () => ({
  'members/g1': { name: 'Gratis', email: 'g@mail.com', status: 'registered' },
  'members/g2': { name: 'Sin Correo', email: 'x@mail.com', status: 'registered' },
  'members/s1': { name: 'Socio', email: 's@mail.com', status: 'active' }
});

async function levantar(semilla) {
  const db = fakeDb(semilla);
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const app = express(); app.use(express.json());
  montarRutasCreditos(app, { db, admin, tieneMembresia: m => m.status === 'active' });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const url = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, token = 'gratis') => {
    const r = await fetch(url + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, cerrar: () => srv.close() };
}
const MAT = leerCatalogo()[0].id;

test('claves de cupón: sin acentos ni símbolos, de 3 a 30 caracteres', () => {
  assert.equal(normalizarClave(' Canal-100 ñ '), 'CANAL100N');
  assert.equal(claveValida('AB'), false);
  assert.equal(claveValida('CANAL100'), true);
});

test('evaluarCupon: audiencia, vencimiento, cupo y una vez por cuenta', () => {
  const c = { activo: true, creditos: 100, publico: 'gratuitos', usos: 0 };
  assert.equal(evaluarCupon(c, { membresia: false }), null);
  assert.equal(evaluarCupon(c, { membresia: true }).codigo, 403);
  assert.equal(evaluarCupon({ ...c, publico: 'miembros' }, { membresia: false }).codigo, 403);
  assert.equal(evaluarCupon({ ...c, venceMs: 1 }, { membresia: false, ahora: 5 }).codigo, 410);
  assert.equal(evaluarCupon({ ...c, maxUsos: 2, usos: 2 }, { membresia: false }).codigo, 410);
  assert.equal(evaluarCupon({ ...c, activo: false }, { membresia: false }).codigo, 409);
  assert.equal(evaluarCupon(c, { membresia: false, yaCanjeo: true }).codigo, 409);
});

test('el admin regala créditos a una cuenta gratuita y ella los ve con su aviso', async () => {
  const s = await levantar(base());
  try {
    assert.equal((await s.llamar('/api/admin/creditos/regalar', { email: 'g@mail.com', cantidad: 100 }, 'gratis')).status, 403);
    assert.equal((await s.llamar('/api/admin/creditos/regalar', { email: 'g@mail.com', cantidad: 5000 }, 'admin')).status, 400);
    const r = await s.llamar('/api/admin/creditos/regalar', { email: 'g@mail.com', cantidad: 150, mensaje: '¡Bienvenida!' }, 'admin');
    assert.equal(r.cuerpo.saldo, 150);
    const e = await s.llamar('/api/creditos');
    assert.equal(e.cuerpo.saldo, 150);
    assert.equal(e.cuerpo.membresia, false);
    assert.equal(e.cuerpo.aviso.mensaje, '¡Bienvenida!');
    assert.equal(e.cuerpo.materiales[0].url, undefined); // el catálogo no revela el archivo
    await s.llamar('/api/creditos/aviso-visto', {});
    assert.equal((await s.llamar('/api/creditos')).cuerpo.aviso, null);
  } finally { s.cerrar(); }
});

test('canjear: sin saldo no deja; con saldo descuenta una sola vez y entrega el enlace', async () => {
  const s = await levantar({ ...base(), 'members/g1': { name: 'Gratis', status: 'registered', creditos: 150 } });
  try {
    assert.equal((await s.llamar('/api/materiales/' + MAT + '/enlace')).status, 402);
    const a = await s.llamar('/api/creditos/canjear', { materialId: MAT });
    assert.equal(a.cuerpo.saldo, 50);
    const b = await s.llamar('/api/creditos/canjear', { materialId: MAT });
    assert.equal(b.cuerpo.saldo, 50); assert.equal(b.cuerpo.yaTenia, true);
    assert.equal((await s.llamar('/api/materiales/' + MAT + '/enlace')).status, 200);
    assert.equal((await s.llamar('/api/creditos/canjear', { materialId: 'no-existe' })).status, 404);
    const sin = await levantar({ ...base(), 'members/g1': { status: 'registered', creditos: 40 } });
    try { assert.equal((await sin.llamar('/api/creditos/canjear', { materialId: MAT })).status, 402); } finally { sin.cerrar(); }
  } finally { s.cerrar(); }
});

test('material gratuito: la membresía sola no lo abre; el miembro lo abre con retos (y entonces no puede canjearlo) y cualquiera con créditos', async () => {
  const s = await levantar(base());
  try {
    assert.equal((await s.llamar('/api/materiales/' + MAT + '/enlace', null, 'socio')).status, 402, 'sin retos ni créditos no abre');
    const e = (await s.llamar('/api/creditos', null, 'socio')).cuerpo, m = e.materiales.find(x => x.id === MAT);
    assert.equal(m.abiertoPorRetos, false); assert.ok(m.requiereRetos >= 1); assert.equal(m.faltanRetos, m.requiereRetos);
    // el miembro supera los retos pedidos: se abre sin créditos y el canje se rechaza
    const superados = Object.fromEntries([...Array(m.requiereRetos).keys()].map(i => ['q-' + i, { mejor: 5, total: 5, xp: 10 }]));
    await s.db.collection('members').doc('s1').collection('progress').doc('retos').set({ superados });
    assert.equal((await s.llamar('/api/materiales/' + MAT + '/enlace', null, 'socio')).status, 200);
    assert.equal((await s.llamar('/api/creditos/canjear', { materialId: MAT }, 'socio')).status, 409);
    // una cuenta gratuita no avanza con retos, solo con créditos
    await s.db.collection('members').doc('g1').collection('progress').doc('retos').set({ superados });
    assert.equal((await s.llamar('/api/materiales/' + MAT + '/enlace', null, 'gratis')).status, 402);
  } finally { s.cerrar(); }
});

test('cupones: crear, canjear una sola vez, audiencia y tarjeta sin revelar la clave', async () => {
  const s = await levantar(base());
  try {
    const c = await s.llamar('/api/admin/creditos/cupones', { clave: 'Canal 100', creditos: 100, publico: 'gratuitos', maxUsos: 5 }, 'admin');
    assert.equal(c.status, 201); assert.equal(c.cuerpo.cupon.clave, 'CANAL100');
    assert.equal((await s.llamar('/api/admin/creditos/cupones', { clave: 'CANAL100', creditos: 10 }, 'admin')).status, 409);

    const tarjeta = await s.llamar('/api/creditos/cupon-activo');
    assert.equal(tarjeta.cuerpo.hay, true); assert.equal(tarjeta.cuerpo.creditos, 100); assert.equal(JSON.stringify(tarjeta.cuerpo).includes('CANAL100'), false);
    assert.equal((await s.llamar('/api/creditos/cupon-activo', null, 'socio')).cuerpo.hay, false); // los socios no son su audiencia

    assert.equal((await s.llamar('/api/creditos/cupon', { clave: 'canal-100' })).cuerpo.saldo, 100);
    assert.equal((await s.llamar('/api/creditos/cupon', { clave: 'CANAL100' })).status, 409); // una vez por cuenta
    assert.equal((await s.llamar('/api/creditos/cupon', { clave: 'CANAL100' }, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/creditos/cupon', { clave: 'CANAL100' }, 'sinCorreo')).status, 403); // correo sin confirmar
    assert.equal((await s.llamar('/api/creditos/cupon-activo')).cuerpo.hay, false); // ya lo canjeó

    const canjes = await s.llamar('/api/admin/creditos/cupones/CANAL100/canjes', null, 'admin');
    assert.equal(canjes.cuerpo.canjes.length, 1);
    await s.llamar('/api/admin/creditos/cupones/CANAL100/estado', { activo: false }, 'admin');
    assert.equal(s.db.datos.get('cuponesCreditos/CANAL100').activo, false);
  } finally { s.cerrar(); }
});

test('adivinar claves se frena tras 10 intentos fallidos', async () => {
  const s = await levantar(base());
  try {
    for (let i = 0; i < 10; i++) assert.equal((await s.llamar('/api/creditos/cupon', { clave: 'NOEXISTE' + i })).status, 404);
    assert.equal((await s.llamar('/api/creditos/cupon', { clave: 'OTRACLAVE' })).status, 429);
  } finally { s.cerrar(); }
});

test('el resumen del admin cuenta regalos, cupones y canjes', async () => {
  const s = await levantar({ ...base(), 'members/g1': { email: 'g@mail.com', status: 'registered', creditos: 0 } });
  try {
    await s.llamar('/api/admin/creditos/regalar', { uid: 'g1', cantidad: 200 }, 'admin');
    await s.llamar('/api/creditos/canjear', { materialId: MAT });
    const r = await s.llamar('/api/admin/creditos', null, 'admin');
    assert.equal(r.cuerpo.regalados, 200); assert.equal(r.cuerpo.canjeados, 100); assert.equal(r.cuerpo.canjesPorMaterial[0].n, 1);
  } finally { s.cerrar(); }
});

test('aviso "Hay un cupón para ti" y tarjeta "Lo sentimos" cuando se agotó', async () => {
  const s = await levantar(base());
  try {
    await s.llamar('/api/admin/creditos/cupones', { clave: 'LIMITE1', creditos: 100, publico: 'todos', maxUsos: 1 }, 'admin');
    const a = await s.llamar('/api/creditos/cupon-disponible');
    assert.equal(a.cuerpo.hay, true); assert.equal(a.cuerpo.cantidad, 1); assert.equal(a.cuerpo.creditos, 100); assert.equal(a.cuerpo.limitado, true);
    assert.equal(JSON.stringify(a.cuerpo).includes('LIMITE1'), false); // nunca la clave
    assert.equal((await s.llamar('/api/creditos/cupon-disponible', null, 'admin')).cuerpo.hay, false);
    assert.equal((await s.llamar('/api/creditos/cupon', { clave: 'LIMITE1' })).status, 200);
    const tarde = await s.llamar('/api/creditos/cupon', { clave: 'LIMITE1' }, 'socio');
    assert.equal(tarde.status, 410); assert.equal(tarde.cuerpo.codigo, 'cupon-agotado'); assert.equal(tarde.cuerpo.limite, 1);
    // Agotado para otros, pero la tarjeta SIGUE saliendo a quien aún no lo canjea (así ve que la dinámica es real); quien ya lo canjeó ya no la ve
    const aunSale = (await s.llamar('/api/creditos/cupon-disponible', null, 'socio')).cuerpo; assert.equal(aunSale.hay, true); assert.equal(aunSale.agotado, true);
    assert.equal((await s.llamar('/api/creditos/cupon-disponible')).cuerpo.hay, false);
  } finally { s.cerrar(); }
});
