'use strict';
// BUZÓN PRIVADO: chat miembro ↔ administración (una conversación por miembro, como ICADEM)
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasSoporteChat, limpiarTexto, limpiarTema } = require('../services/soporte-chat');

function fakeDb(semilla = {}) {
  const datos = new Map(Object.entries(semilla)); let seq = 0;
  const ref = ruta => ({ id: ruta.split('/').pop(),
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...v } : { ...v }); },
    async delete() { datos.delete(ruta); }, collection: n => col(ruta + '/' + n) });
  const col = ruta => {
    const docs = (orden, dir, tope) => {
      let l = [...datos.keys()].filter(k => k.startsWith(ruta + '/') && !k.slice(ruta.length + 1).includes('/')).map(k => ({ id: k.split('/').pop(), v: datos.get(k) }));
      if (orden) l.sort((a, b) => (dir === 'desc' ? (b.v[orden] || 0) - (a.v[orden] || 0) : (a.v[orden] || 0) - (b.v[orden] || 0)));
      if (tope) l = l.slice(0, tope);
      return l.map(x => ({ id: x.id, data: () => x.v }));
    };
    const consulta = (orden, dir, tope) => ({ orderBy: (c, d) => consulta(c, d || 'asc', tope), limit: n => consulta(orden, dir, n), async get() { return { docs: docs(orden, dir, tope) }; } });
    return { doc: id => ref(ruta + '/' + (id || 'auto' + (++seq))), ...consulta(null, null, null) };
  };
  return { datos, collection: n => col(n) };
}

async function levantar(semilla, reloj) {
  const db = fakeDb({
    'members/u1': { name: 'Ana Torres', email: 'ana@mail.com', status: 'active' },
    'members/u2': { name: 'Beto Ruiz', email: 'beto@mail.com', status: 'registered' },
    ...semilla
  });
  const tokens = {
    admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true },
    ana: { uid: 'u1', email: 'ana@mail.com', email_verified: true },
    beto: { uid: 'u2', email: 'beto@mail.com', email_verified: true },
    nadie: { uid: 'u9', email: 'nadie@mail.com', email_verified: true }
  };
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const app = express(); app.use(express.json());
  montarRutasSoporteChat(app, { db, admin, ahora: reloj });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, metodo = 'GET', cuerpo, token) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
  };
  return { db, llamar, cerrar: () => srv.close() };
}
const rid = n => String(n).padStart(20, 'x');

test('limpieza: texto vacío o gigante se rechaza; el tema solo acepta los cinco válidos', () => {
  assert.throws(() => limpiarTexto('   '), /Escribe un mensaje/);
  assert.throws(() => limpiarTexto('a'.repeat(3001)), /3000/);
  assert.equal(limpiarTexto('  hola\r\nequipo  '), 'hola\nequipo');
  assert.equal(limpiarTema('cobros'), 'cobros');
  assert.equal(limpiarTema('inventado'), null);
});

test('el miembro escribe, nace SU conversación y el administrador la ve con el contador sin leer', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Hola' })).status, 401, 'sin sesión no hay chat');
    assert.equal((await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Hola' }, 'nadie')).status, 403, 'sin registro no hay chat');
    const a = await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'No puedo entrar a mi curso', tema: 'cuenta', clientRequestId: rid(1) }, 'ana');
    assert.equal(a.status, 201); assert.equal(a.cuerpo.repetido, false);
    const mia = (await s.llamar('/api/soporte-chat', 'GET', null, 'ana')).cuerpo;
    assert.equal(mia.conversacion.tema, 'cuenta'); assert.equal(mia.conversacion.estado, 'abierto');
    assert.equal(mia.mensajes.length, 1); assert.equal(mia.mensajes[0].de, 'miembro');
    assert.equal((await s.llamar('/api/admin/soporte-chat', 'GET', null, 'ana')).status, 403, 'un miembro no abre el buzón del admin');
    const buzon = (await s.llamar('/api/admin/soporte-chat', 'GET', null, 'admin')).cuerpo;
    assert.equal(buzon.conversaciones.length, 1); assert.equal(buzon.sinLeer, 1);
    assert.equal(buzon.conversaciones[0].correo, 'ana@mail.com'); assert.equal(buzon.conversaciones[0].ultimoDe, 'miembro');
    // beto (cuenta gratuita registrada) también puede escribir: el soporte no exige membresía
    assert.equal((await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Quiero saber precios', clientRequestId: rid(2) }, 'beto')).status, 201);
    assert.equal((await s.llamar('/api/admin/soporte-chat', 'GET', null, 'admin')).cuerpo.conversaciones.length, 2);
  } finally { s.cerrar(); }
});

test('reintentar el mismo envío no duplica; el mismo id con otro texto se rechaza', async () => {
  const s = await levantar();
  try {
    await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Hola equipo', clientRequestId: rid(7) }, 'ana');
    const otra = await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Hola equipo', clientRequestId: rid(7) }, 'ana');
    assert.equal(otra.status, 201); assert.equal(otra.cuerpo.repetido, true);
    assert.equal((await s.llamar('/api/soporte-chat', 'GET', null, 'ana')).cuerpo.mensajes.length, 1, 'sigue habiendo UN mensaje');
    assert.equal((await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Otro texto', clientRequestId: rid(7) }, 'ana')).status, 409);
    assert.equal((await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Hola', clientRequestId: 'corto' }, 'ana')).status, 400, 'id inválido');
  } finally { s.cerrar(); }
});

test('la respuesta del administrador llega con aviso en la campana y los no-leídos se ponen al día al leer', async () => {
  const s = await levantar();
  try {
    await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Mi pago no aparece', tema: 'cobros', clientRequestId: rid(1) }, 'ana');
    assert.equal((await s.llamar('/api/admin/soporte-chat/u9', 'GET', null, 'admin')).status, 404);
    assert.equal((await s.llamar('/api/admin/soporte-chat/u9/mensajes', 'POST', { mensaje: 'Hola' }, 'admin')).status, 404, 'el admin no abre conversaciones que no existen');
    const abierta = (await s.llamar('/api/admin/soporte-chat/u1', 'GET', null, 'admin')).cuerpo;
    assert.equal(abierta.mensajes.length, 1);
    assert.equal((await s.llamar('/api/admin/soporte-chat', 'GET', null, 'admin')).cuerpo.sinLeer, 0, 'abrirla la marca leída');
    const r = await s.llamar('/api/admin/soporte-chat/u1/mensajes', 'POST', { mensaje: 'Ya lo revisamos: tu pago sí entró.', clientRequestId: rid(2) }, 'admin');
    assert.equal(r.status, 201);
    const aviso = [...s.db.datos.keys()].find(k => k.startsWith('members/u1/avisos/buzon_'));
    assert.ok(aviso, 'el miembro recibe el aviso en la campana');
    assert.equal(s.db.datos.get(aviso).pagina, 'soporte');
    const vistazo = (await s.llamar('/api/soporte-chat?vistazo=1', 'GET', null, 'ana')).cuerpo;
    assert.equal(vistazo.conversacion.sinLeerMiembro, 1, 'el vistazo del punto rojo NO marca leído');
    assert.equal(s.db.datos.get(aviso).leido, false, 'el aviso de la campana sigue pendiente mientras no lo lea');
    const mia = (await s.llamar('/api/soporte-chat', 'GET', null, 'ana')).cuerpo;
    assert.equal(mia.mensajes.length, 2); assert.equal(mia.mensajes[1].de, 'admin'); assert.equal(mia.mensajes[1].nombre, 'Equipo FisioTeck');
    assert.equal((await s.llamar('/api/soporte-chat', 'GET', null, 'ana')).cuerpo.conversacion.sinLeerMiembro, 0, 'leerla la pone al día');
    assert.equal(s.db.datos.get(aviso).leido, true, 'al leer el chat, el aviso de la campana también queda leído');
  } finally { s.cerrar(); }
});

test('resolver, reabrir, y que un mensaje nuevo del miembro la reabra solo', async () => {
  const s = await levantar();
  try {
    await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Duda de mi factura', clientRequestId: rid(1) }, 'ana');
    assert.equal((await s.llamar('/api/admin/soporte-chat/u1/estado', 'POST', { estado: 'resuelto' }, 'admin')).cuerpo.estado, 'resuelto');
    assert.equal((await s.llamar('/api/soporte-chat', 'GET', null, 'ana')).cuerpo.conversacion.estado, 'resuelto');
    assert.equal((await s.llamar('/api/admin/soporte-chat/u1/estado', 'POST', { estado: 'raro' }, 'admin')).status, 400);
    await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'Una cosa más…', clientRequestId: rid(2) }, 'ana');
    assert.equal((await s.llamar('/api/soporte-chat', 'GET', null, 'ana')).cuerpo.conversacion.estado, 'abierto', 'escribir reabre la conversación');
    assert.equal((await s.llamar('/api/admin/soporte-chat/u1/estado', 'POST', { estado: 'abierto' }, 'admin')).cuerpo.estado, 'abierto');
  } finally { s.cerrar(); }
});

test('el tema se guarda solo (crea la conversación si no existía) y el límite de envíos frena el exceso', async () => {
  let t = 1700000000000; const reloj = () => t;
  const s = await levantar({}, reloj);
  try {
    assert.equal((await s.llamar('/api/soporte-chat/tema', 'POST', { tema: 'cursos' }, 'ana')).cuerpo.tema, 'cursos');
    assert.equal((await s.llamar('/api/soporte-chat', 'GET', null, 'ana')).cuerpo.conversacion.tema, 'cursos');
    assert.equal((await s.llamar('/api/soporte-chat/tema', 'POST', { tema: 'x' }, 'ana')).status, 400);
    for (let i = 0; i < 30; i++) { t += 1000; assert.equal((await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'm' + i, clientRequestId: rid(100 + i) }, 'ana')).status, 201); }
    t += 1000;
    assert.equal((await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'uno más', clientRequestId: rid(999) }, 'ana')).status, 429, 'más de 30 en una hora se frena');
    t += 3600 * 1000 + 1000;
    assert.equal((await s.llamar('/api/soporte-chat/mensajes', 'POST', { mensaje: 'ya pasó la hora', clientRequestId: rid(998) }, 'ana')).status, 201);
  } finally { s.cerrar(); }
});
