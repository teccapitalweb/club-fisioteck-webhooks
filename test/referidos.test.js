const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const R = require('../services/referidos');
const { montarRutasReferidos } = require('../services/rutas-referidos');
const { montarRutasAcceso } = require('../services/acceso');

// ---------- Reglas puras ----------
test('el código sale del uid y el enlace lo lleva', () => {
  assert.equal(R.codigoDeUid('abc123XYZ'), 'FT-ABC123');
  assert.equal(R.normalizarCodigo(' ft-abc123 '), 'FT-ABC123');
  assert.equal(R.normalizarCodigo('ZOO-ABC123'), null);
  assert.match(R.enlaceDeCodigo('FT-ABC123'), /\?ref=FT-ABC123$/);
});

test('un dispositivo igual al del anfitrión o de otro invitado válido se rechaza', () => {
  const host = { ids: ['dispositivo-1'], huellas: [], combos: [] };
  assert.equal(R.evaluarDispositivo({ uid: 'i', anfitrionUid: 'h', deviceId: 'dispositivo-1' }, host), 'dispositivo-anfitrion');
  assert.equal(R.evaluarDispositivo({ uid: 'i', anfitrionUid: 'i' }, host), 'mismo-usuario');
  const otros = [{ uid: 'a', estado: R.ESTADOS.VALIDO, deviceId: 'dispositivo-2' }];
  assert.equal(R.evaluarDispositivo({ uid: 'b', anfitrionUid: 'h', deviceId: 'dispositivo-2' }, host, otros), 'dispositivo-invitado');
  assert.equal(R.evaluarDispositivo({ uid: 'b', anfitrionUid: 'h', deviceId: 'dispositivo-3' }, host, otros), null);
});

test('hitos: se ganan una vez, el pago solo cuenta con cobro registrado y el XP tiene tope de 6 invitados', () => {
  assert.equal(R.invitadoPago({ status: 'active' }), false);
  assert.equal(R.invitadoPago({ payments: [{ amount: 249 }] }), true);
  const a = R.actualizarHitos(null, { pago: true, retosSuperados: 5 });
  assert.deepEqual(a.nuevos, ['pago', 'retos5']);
  assert.deepEqual(R.actualizarHitos(a.hitos, { pago: true, retosSuperados: 5 }).nuevos, []);
  const validos = Array.from({ length: 8 }, (_, n) => ({ uid: 'u' + n, estado: R.ESTADOS.VALIDO, hitos: { pago: true } }));
  const r = R.resumirInvitados(validos);
  assert.equal(r.validos, 8);
  assert.equal(r.xp, 6 * 120);
});

test('alias público: nunca correo ni números', () => {
  assert.equal(R.aliasDeNombre('María Gómez Ruiz'), 'María G.');
  assert.equal(R.aliasDeNombre('ana@mail.com'), 'Miembro');
});

// ---------- Rutas (Firestore falso) ----------
function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); },
    collection: n => col(ruta + '/' + n), doc: n => ref(ruta + '/' + n)
  });
  const col = nombre => {
    const filtros = []; let lim = 1e9;
    const q = {
      doc: id => ref(nombre + '/' + id), where(c, o, v) { filtros.push([c, v]); return q; }, limit(n) { lim = n; return q; },
      async get() {
        const profundidad = nombre.split('/').length + 1;
        const docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === profundidad)
          .filter(([, v]) => filtros.every(([c, val]) => v[c] === val)).slice(0, lim).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        return { docs, empty: !docs.length };
      }
    };
    return q;
  };
  return {
    collection: col, datos,
    async runTransaction(fn) { return fn({ get: r => r.get(), set: (r, v, o) => r.set(v, o) }); }
  };
}

const catalogo = { courses: [1, 2, 3].map(id => ({ courseId: id, title: 'C' + id, lessons: [{ isPreview: true }, {}] })) };
const hoy = new Date().toISOString().split('T')[0];
const usuariosAuth = {};
async function levantar(semilla) {
  const db = fakeDb(semilla);
  const tokens = {};
  ['host', 'inv1', 'inv2', 'inv3', 'inv4', 'inv5'].forEach(u => { tokens[u] = { uid: u + 'uid123', email: u + '@mail.com', email_verified: false }; });
  tokens.admin = { uid: 'admin1', email: 'teccapitalweb@gmail.com', email_verified: true };
  const admin = { auth: () => ({
    verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; },
    getUsers: async ids => ({ users: ids.map(x => usuariosAuth[x.uid]).filter(Boolean) })
  }) };
  const deps = { db, admin, cargarCatalogo: () => catalogo, tieneMembresia: m => m.status === 'active', estadoLogros: async () => ({ xp: global.__xpPrueba || 0 }) };
  const app = express(); app.use(express.json());
  montarRutasAcceso(app, deps);
  montarRutasReferidos(app, deps);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, token = 'host') => {
    const r = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'x-device-id': 'dispositivo-host' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, cerrar: () => srv.close() };
}
const verificado = (uid, verificado = true) => { usuariosAuth[uid] = { uid, emailVerified: verificado, metadata: { creationTime: new Date().toUTCString() } }; };
const dispositivo = n => ({ deviceId: 'dispositivo-' + n, huella: 'huella-' + n + '-abc' });
const base = () => ({
  'members/hostuid123': { name: 'Ana Torres', status: 'active', payments: [{ date: hoy, amount: 249 }] },
  'config/club': { escalonadoActivo: true },
  ...Object.fromEntries([1, 2, 3, 4, 5].map(n => ['members/inv' + n + 'uid123', { name: 'Invitado ' + n + ' Pérez', status: 'registered' }]))
});

test('solo un socio con membresía tiene enlace; el código se registra para poder usarlo', async () => {
  const s = await levantar({ ...base(), 'members/inv1uid123': { status: 'registered' } });
  try {
    assert.equal((await s.llamar('/api/referidos/estado', null, 'inv1')).status, 402);
    const r = await s.llamar('/api/referidos/estado');
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.codigo, 'FT-HOSTUI');
    assert.ok(s.db.datos.get('codigosReferido/FT-HOSTUI'));
  } finally { s.cerrar(); }
});

test('el invitado queda pendiente hasta confirmar su correo, y luego válido', async () => {
  const s = await levantar(base());
  try {
    await s.llamar('/api/referidos/estado'); // crea el código
    verificado('inv1uid123', false);
    const a = await s.llamar('/api/referidos/registrar', { codigo: 'FT-HOSTUI', ...dispositivo(1) }, 'inv1');
    assert.equal(a.cuerpo.estado, 'pendiente-correo');
    verificado('inv1uid123', true);
    const b = await s.llamar('/api/referidos/registrar', { codigo: 'FT-HOSTUI', ...dispositivo(1) }, 'inv1'); // idempotente
    assert.equal(b.cuerpo.estado, 'valido');
    const est = await s.llamar('/api/referidos/estado');
    assert.equal(est.cuerpo.validos, 1);
    assert.equal(est.cuerpo.invitados[0].alias, 'Invitado 1'.split(' ')[0] + ' P.');
    assert.equal(est.cuerpo.invitados[0].alias.includes('@'), false);
  } finally { s.cerrar(); }
});

test('se rechaza: código inexistente, uno mismo, mismo dispositivo y anfitrión sin membresía', async () => {
  const s = await levantar({ ...base(), 'members/inv2uid123': { name: 'Dos Pérez', status: 'active', payments: [{ date: hoy, amount: 249 }] } });
  try {
    await s.llamar('/api/referidos/estado');
    verificado('inv1uid123'); verificado('hostuid123');
    assert.equal((await s.llamar('/api/referidos/registrar', { codigo: 'FT-NOEXIS', ...dispositivo(1) }, 'inv1')).cuerpo.estado, 'rechazado');
    assert.equal((await s.llamar('/api/referidos/registrar', { codigo: 'FT-HOSTUI', ...dispositivo(9) })).cuerpo.estado, 'rechazado'); // el host con su propio código
    assert.equal((await s.llamar('/api/referidos/registrar', { codigo: 'FT-HOSTUI', deviceId: 'dispositivo-host', huella: 'huella-host-abc' }, 'inv1')).cuerpo.estado, 'rechazado');
    // anfitrión sin membresía: no se guarda nada
    await s.llamar('/api/referidos/estado', null, 'inv2'); // inv2 sí es socio y tiene código
    s.db.datos.set('members/inv2uid123', { name: 'Dos Pérez', status: 'inactive' });
    verificado('inv3uid123');
    const r = await s.llamar('/api/referidos/registrar', { codigo: 'FT-INV2UI', ...dispositivo(3) }, 'inv3');
    assert.equal(r.cuerpo.estado, 'rechazado');
    assert.equal(s.db.datos.has('referidos/inv3uid123'), false);
  } finally { s.cerrar(); }
});

test('con 4 invitados válidos se gana el premio y abre un curso cerrado una sola vez', async () => {
  const s = await levantar(base());
  try {
    await s.llamar('/api/referidos/estado');
    // todavía sin premio
    assert.equal((await s.llamar('/api/premios/usar', { cursoId: 2 })).status, 403);
    for (const n of [1, 2, 3, 4]) {
      verificado('inv' + n + 'uid123');
      assert.equal((await s.llamar('/api/referidos/registrar', { codigo: 'FT-HOSTUI', ...dispositivo(n) }, 'inv' + n)).cuerpo.estado, 'valido');
    }
    const est = await s.llamar('/api/referidos/estado');
    assert.equal(est.cuerpo.validos, 4);
    assert.equal(est.cuerpo.premio.ganado, true);
    assert.equal((await s.llamar('/api/acceso')).cuerpo.cursos['2'].abierto, false);
    assert.equal((await s.llamar('/api/premios/usar', { cursoId: 2 })).status, 200);
    assert.equal((await s.llamar('/api/acceso')).cuerpo.cursos['2'].abierto, true);
    assert.equal((await s.llamar('/api/premios/usar', { cursoId: 2 })).status, 409); // ya abierto
    assert.equal((await s.llamar('/api/premios/usar', { cursoId: 3 })).status, 403); // el premio ya se usó
  } finally { s.cerrar(); }
});

test('el panel de administrador lista las invitaciones; un socio no', async () => {
  const s = await levantar(base());
  try {
    await s.llamar('/api/referidos/estado');
    verificado('inv1uid123');
    await s.llamar('/api/referidos/registrar', { codigo: 'FT-HOSTUI', ...dispositivo(1) }, 'inv1');
    assert.equal((await s.llamar('/api/admin/referidos')).status, 403);
    const r = await s.llamar('/api/admin/referidos', null, 'admin');
    assert.equal(r.cuerpo.total, 1);
    assert.equal(r.cuerpo.anfitriones[0].validos, 1);
  } finally { s.cerrar(); }
});

test('premios por nivel: Profesional y Maestro abren un curso cada uno, sumando el XP de invitados', async () => {
  const s = await levantar(base());
  try {
    global.__xpPrueba = 100;
    let est = (await s.llamar('/api/referidos/estado')).cuerpo;
    const prof = () => est.premios.find(p => p.clave === 'nivel-profesional');
    assert.equal(prof().ganado, false); assert.equal(prof().faltan, 2400);
    assert.equal((await s.llamar('/api/premios/usar', { cursoId: 2, clave: 'nivel-profesional' })).status, 403, 'sin ganarlo no se puede canjear');
    global.__xpPrueba = 2500;
    est = (await s.llamar('/api/referidos/estado')).cuerpo;
    assert.equal(prof().ganado, true); assert.equal(est.premios.find(p => p.clave === 'nivel-maestro').ganado, false);
    assert.equal((await s.llamar('/api/premios/usar', { cursoId: 2, clave: 'nivel-profesional' })).status, 200);
    assert.equal((await s.llamar('/api/premios/usar', { cursoId: 3, clave: 'nivel-profesional' })).status, 409, 'cada premio se usa una vez');
    assert.equal((await s.llamar('/api/premios/usar', { cursoId: 3 })).status, 403, 'ya no queda otro premio');
    global.__xpPrueba = 6100;
    est = (await s.llamar('/api/referidos/estado')).cuerpo;
    assert.equal(est.premios.find(p => p.clave === 'nivel-maestro').ganado, true);
    assert.equal((await s.llamar('/api/premios/usar', { cursoId: 3 })).status, 200);
    assert.equal(est.premios.filter(p => p.ganado).length, 2, 'un premio ganado no se pierde');
  } finally { global.__xpPrueba = 0; s.cerrar(); }
});
