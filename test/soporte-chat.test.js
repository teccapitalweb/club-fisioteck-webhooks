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
    const docs = (orden, dir, tope, filtro) => {
      let l = [...datos.keys()].filter(k => k.startsWith(ruta + '/') && !k.slice(ruta.length + 1).includes('/')).map(k => ({ id: k.split('/').pop(), v: datos.get(k) }));
      if (filtro) l = l.filter(x => x.v[filtro[0]] === filtro[1]);
      if (orden) l.sort((a, b) => (dir === 'desc' ? (b.v[orden] || 0) - (a.v[orden] || 0) : (a.v[orden] || 0) - (b.v[orden] || 0)));
      if (tope) l = l.slice(0, tope);
      return l.map(x => ({ id: x.id, data: () => x.v }));
    };
    const consulta = (orden, dir, tope, filtro) => ({ where: (c, _o, val) => consulta(orden, dir, tope, [c, val]), orderBy: (c, d) => consulta(c, d || 'asc', tope, filtro), limit: n => consulta(orden, dir, n, filtro), async get() { return { docs: docs(orden, dir, tope, filtro) }; } });
    return { doc: id => ref(ruta + '/' + (id || 'auto' + (++seq))), ...consulta(null, null, null, null) };
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

test('reportes del formulario anterior: pasan al Buzón una sola vez, con su respuesta, sin duplicar y sin avisar de lo viejo', async () => {
  const s = await levantar({
    'soporte/r1': { uid: 'u2', nombre: 'Beto Ruiz', email: 'beto@mail.com', tipo: 'problema', asunto: 'Video', mensaje: 'No me carga el video de la clase 3 en el celular', estado: 'nuevo', creadoMs: 1700000000000, respuesta: '', respondidoMs: 0 },
    'soporte/r2': { uid: 'u1', nombre: 'Ana Torres', email: 'ana@mail.com', tipo: 'queja', asunto: 'Cobro doble', mensaje: 'Me cobraron dos veces este mes', estado: 'revision', creadoMs: 1700000100000, respuesta: 'Ya lo revisamos y te devolvimos el cobro de más.', respondidoMs: 1700000200000 }
  });
  try {
    const buzon = (await s.llamar('/api/admin/soporte-chat', 'GET', null, 'admin')).cuerpo;
    assert.equal(buzon.conversaciones.length, 2, 'los dos reportes viejos ya están en el Buzón');
    const beto = buzon.conversaciones.find(c => c.uid === 'u2'), ana = buzon.conversaciones.find(c => c.uid === 'u1');
    assert.equal(beto.ultimoDe, 'miembro'); assert.equal(beto.sinLeerAdmin, 1, 'sin respuesta = por responder');
    assert.equal(ana.ultimoDe, 'admin'); assert.equal(ana.sinLeerAdmin, 0); assert.equal(ana.sinLeerMiembro, 0, 'lo viejo no enciende el punto rojo del miembro');
    const hiloAna = (await s.llamar('/api/admin/soporte-chat/u1', 'GET', null, 'admin')).cuerpo.mensajes;
    assert.equal(hiloAna.length, 2); assert.equal(hiloAna[0].importado, true, 'se marca que viene del formulario anterior'); assert.equal(hiloAna[0].de, 'miembro'); assert.match(hiloAna[0].texto, /Cobro doble/); assert.equal(hiloAna[1].de, 'admin');
    assert.equal((await s.llamar('/api/soporte-chat', 'GET', null, 'ana')).cuerpo.mensajes.length, 2, 'el miembro ve su historial anterior en su chat');
    assert.ok(s.db.datos.get('config/soporte_chat_migrado'), 'queda la marca de que ya se migró');
    // volver a listar no duplica nada
    await s.llamar('/api/admin/soporte-chat', 'GET', null, 'admin');
    assert.equal((await s.llamar('/api/admin/soporte-chat/u1', 'GET', null, 'admin')).cuerpo.mensajes.length, 2);
  } finally { s.cerrar(); }
});

test('reportes nuevos que lleguen por el formulario viejo (Club sin actualizar) también caen en el Buzón y su respuesta avisa al miembro', async () => {
  const db = fakeDb({ 'members/u1': { name: 'Ana Torres', email: 'ana@mail.com', status: 'active' } });
  const app = express(); app.use(express.json());
  const tokens = { admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }, ana: { uid: 'u1', email: 'ana@mail.com', email_verified: true } };
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const chat = montarRutasSoporteChat(app, { db, admin });
  require('../services/soporte').montarRutasSoporte(app, { db, admin, alGuardarReporte: chat.importarReporte, enviarCorreo: async () => ({ ok: true }) });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, metodo = 'GET', cuerpo, token) => { const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json().catch(() => ({})) }; };
  try {
    const nuevo = await llamar('/api/soporte', 'POST', { tipo: 'problema', asunto: 'No entra', mensaje: 'No puedo entrar al curso de rodilla desde ayer' }, 'ana');
    assert.equal(nuevo.status, 200);
    let buzon = (await llamar('/api/admin/soporte-chat', 'GET', null, 'admin')).cuerpo;
    assert.equal(buzon.conversaciones.length, 1); assert.equal(buzon.conversaciones[0].sinLeerAdmin, 1); assert.equal(buzon.conversaciones[0].ultimoDe, 'miembro');
    const r = await llamar('/api/admin/soporte/' + nuevo.cuerpo.id, 'POST', { respuesta: 'Ya te abrimos el curso, intenta de nuevo.' }, 'admin');
    assert.equal(r.status, 200);
    buzon = (await llamar('/api/admin/soporte-chat', 'GET', null, 'admin')).cuerpo;
    assert.equal(buzon.conversaciones[0].ultimoDe, 'admin'); assert.equal(buzon.conversaciones[0].sinLeerAdmin, 0, 'ya respondida: nada sin leer para el equipo'); assert.equal(buzon.conversaciones[0].sinLeerMiembro, 1, 'la respuesta nueva enciende el punto rojo del miembro');
    const mia = (await llamar('/api/soporte-chat', 'GET', null, 'ana')).cuerpo;
    assert.equal(mia.mensajes.length, 2); assert.equal(mia.mensajes[1].texto, 'Ya te abrimos el curso, intenta de nuevo.');
  } finally { srv.close(); }
});
