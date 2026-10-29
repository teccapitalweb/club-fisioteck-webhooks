'use strict';
// HISTORIAL DEL SERVIDOR + ACCIONES DE MIEMBROS CON BITÁCORA
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { FakeFirestore } = require('./helpers/fake-firestore');
const { crearBitacoraServidor } = require('../services/bitacora-servidor');
const { montarRutasServidor } = require('../services/rutas-servidor');

const SILENCIO = { log() {}, warn() {}, error() {} };
const falsoProceso = () => ({ pid: 1, on() {}, uptime: () => 5 });
const tokens = { admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }, socio: { uid: 's1', email: 's@mail.com', email_verified: true } };

test('bitácora: un cierre limpio es una publicación; sin cierre limpio es un reinicio inesperado; los errores iguales se agrupan', async () => {
  const db = new FakeFirestore({});
  const t0 = new Date('2026-10-22T10:00:00Z');
  const a = crearBitacoraServidor({ db, admin: {}, ahora: () => t0, proceso: falsoProceso(), consola: SILENCIO });
  await a.iniciar();
  a.registrarError('Webhook falló para ana@mail.com en sub_1Abcdefgh1234');
  a.registrarError('Webhook falló para beto@mail.com en sub_9Zzzzzzzz9999');
  await a.cerrar(); // apagado normal (publicación)
  const t1 = new Date('2026-10-22T10:30:00Z');
  const b = crearBitacoraServidor({ db, admin: {}, ahora: () => t1, proceso: falsoProceso(), consola: SILENCIO });
  await b.iniciar();
  // esta instancia muere sin cierre limpio
  const t2 = new Date('2026-10-22T11:00:00Z');
  const c = crearBitacoraServidor({ db, admin: {}, ahora: () => t2, proceso: falsoProceso(), consola: SILENCIO });
  await c.iniciar();
  const h = await c.leerHistorial({ dias: 7 });
  assert.equal(h.resumen.reinicios, 3);
  assert.equal(h.resumen.reiniciosInesperados, 1, 'solo la instancia sin cierre limpio cuenta como inesperada');
  assert.equal(h.errores.length, 1, 'los dos errores se agrupan como el mismo problema');
  assert.equal(h.errores[0].cuenta, 2);
  assert.equal(JSON.stringify(h).includes('@mail.com'), false, 'nunca se guardan correos');
  const n = await c.reconocerReinicios();
  assert.equal(n, 1);
  assert.equal((await c.leerHistorial({ dias: 7 })).resumen.reiniciosInesperados, 0);
});

async function levantar(seed = {}) {
  const db = new FakeFirestore({ 'members/m1': { name: 'Ana', email: 'ana@mail.com', status: 'registered', payments: [{ date: '2026-09-01', amount: 199 }], progreso: 'x' }, 'members/m2': { name: 'Beto', email: 'beto@mail.com', status: 'active', nextPaymentDate: '2099-01-01' }, ...seed });
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const bitacora = crearBitacoraServidor({ db, admin, proceso: falsoProceso(), consola: SILENCIO });
  const app = express(); app.use(express.json());
  montarRutasServidor(app, { db, admin, bitacora, ahora: () => new Date('2026-10-26T16:15:00Z') });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const llamar = async (ruta, cuerpo, token = 'admin') => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, cerrar: () => srv.close() };
}

test('acciones de miembros: solo administración, con validación y todo queda en la bitácora con quién lo hizo', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/miembros/m1/regalar', { dias: 30 }, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/miembros/m1/regalar', { dias: 30 }, null)).status, 401);
    assert.equal((await s.llamar('/api/admin/miembros/noexiste/regalar', { dias: 30 })).status, 404);
    assert.equal((await s.llamar('/api/admin/miembros/m1/regalar', { dias: 999 })).status, 400);
    assert.equal((await s.llamar('/api/admin/miembros/m1/activar', { plan: 'vip' })).status, 400);

    const g = await s.llamar('/api/admin/miembros/m1/regalar', { dias: 30, mensaje: 'Por tu apoyo en el congreso' });
    assert.equal(g.status, 200); assert.equal(g.cuerpo.hasta, '2026-11-25');
    const m1 = s.db.value('members/m1');
    assert.equal(m1.status, 'active'); assert.equal(m1.nextPaymentDate, '2026-11-25'); assert.equal(m1.regalos[0].mensaje, 'Por tu apoyo en el congreso');
    assert.equal(m1.payments.length, 1, 'el historial de pagos se conserva');

    // regalar a quien ya tiene acceso suma al acceso actual
    assert.equal((await s.llamar('/api/admin/miembros/m2/regalar', { dias: 10 })).cuerpo.hasta, '2099-01-11');

    assert.equal((await s.llamar('/api/admin/miembros/m1/activar', { plan: 'anual' })).cuerpo.hasta, '2027-10-26');
    assert.equal(s.db.value('members/m1').activadoPor, 'teccapitalweb@gmail.com');

    assert.equal((await s.llamar('/api/admin/miembros/m1/cancelar', { mensaje: 'Lo pidió por WhatsApp' })).status, 200);
    const c = s.db.value('members/m1');
    assert.equal(c.status, 'inactive'); assert.equal(c.progreso, 'x'); assert.equal(c.payments.length, 1); assert.equal(c.regalos.length, 1, 'cancelar no borra nada del historial');

    const log = (await s.llamar('/api/admin/acciones')).cuerpo.acciones;
    assert.equal(log.length, 4);
    assert.deepEqual(log.map(x => x.accion).sort(), ['activar', 'cancelar', 'regalar', 'regalar']);
    assert.ok(log.every(x => x.quien === 'teccapitalweb@gmail.com' && x.en.startsWith('2026-10-26')));
    assert.match(log.find(x => x.miembro === 'Ana' && x.accion === 'regalar').texto, /Regaló 30 días/);
    assert.equal((await s.llamar('/api/admin/acciones', null, 'socio')).status, 403);
  } finally { s.cerrar(); }
});

test('historial del panel: solo administración y responde aunque no haya datos', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/servidor/historial', null, 'socio')).status, 403);
    const h = await s.llamar('/api/admin/servidor/historial?dias=7');
    assert.equal(h.status, 200); assert.equal(h.cuerpo.disponible, true); assert.equal(h.cuerpo.resumen.reinicios, 0);
    const r = await s.llamar('/api/admin/servidor/reconocer-reinicios', {});
    assert.equal(r.status, 200); assert.equal(r.cuerpo.reconocidos, 0);
  } finally { s.cerrar(); }
});
