'use strict';
// Suscripción de Stripe (doble cobro, cobro rechazado, cambios desde Stripe, quitar acceso) y enlaces privados de clases en vivo.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { FakeFirestore } = require('./helpers/fake-firestore');
const sus = require('../services/suscripcion');
const { montarRutasServidor } = require('../services/rutas-servidor');
const { montarRutasAdminMiembros } = require('../services/admin-miembros');
const { montarRutasWebinars } = require('../services/webinars');

const vigente = m => ['active', 'paid', 'cancelled'].includes(m.status) && new Date((m.accessUntil || m.nextPaymentDate || '2099-01-01') + 'T23:59:59') >= new Date();
const seg = f => Math.floor(new Date(f + 'T12:00:00Z').getTime() / 1000);
const tokens = { admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }, socio: { uid: 'm1', email: 'ana@mail.com', email_verified: true }, libre: { uid: 'm9', email: 'x@mail.com', email_verified: true } };
const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; }, updateUser: async () => {} }) };

async function levantar(seed, montar) {
  const db = new FakeFirestore(seed), app = express(); app.use(express.json());
  montar(app, db);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const llamar = async (ruta, cuerpo, token = 'admin', metodo) => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + ruta, { method: metodo || (cuerpo ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { db, llamar, cerrar: () => srv.close() };
}
const leer = async (db, ruta) => { const [c, id] = ruta.split('/'); return (await db.collection(c).doc(id).get()).data(); };

test('doble cobro: se bloquea con suscripción viva, cancelada aún vigente o cobro pendiente; se permite si ya terminó', () => {
  assert.equal(sus.bloqueoDeCobro(null, vigente), null);
  assert.equal(sus.bloqueoDeCobro({ status: 'registered' }, vigente), null);
  assert.equal(sus.bloqueoDeCobro({ status: 'active', nextPaymentDate: '2099-01-01' }, vigente), null, 'cortesía sin Stripe: puede pagar');
  assert.equal(sus.bloqueoDeCobro({ status: 'active', nextPaymentDate: '2099-01-01', stripeSubscriptionId: 'sub_1' }, vigente).codigo, 'ya-activa');
  assert.equal(sus.bloqueoDeCobro({ status: 'cancelled', accessUntil: '2099-01-01', stripeSubscriptionId: 'sub_1' }, vigente).codigo, 'reactivar');
  assert.equal(sus.bloqueoDeCobro({ status: 'active', nextPaymentDate: '2000-01-01', pagoPendiente: true, stripeSubscriptionId: 'sub_1' }, vigente).codigo, 'pago-pendiente');
  assert.equal(sus.bloqueoDeCobro({ status: 'cancelled', accessUntil: '2099-01-01', stripeSubscriptionId: 'sub_1', suscripcionTerminada: true }, vigente), null);
  assert.equal(sus.bloqueoDeCobro({ status: 'cancelled', accessUntil: '2000-01-01', stripeSubscriptionId: 'sub_1' }, vigente), null, 'ya venció');
});

test('cobro rechazado: no corta el acceso; deja 7 días de gracia como mínimo y conserva un periodo más largo', () => {
  const hoy = new Date('2026-10-29T12:00:00Z');
  const a = sus.cambiosPorCobroFallido({ status: 'active', nextPaymentDate: '2026-10-29' }, hoy);
  assert.equal(a.status, undefined); assert.equal(a.pagoPendiente, true); assert.equal(a.accessUntil, '2026-11-05');
  assert.equal(sus.cambiosPorCobroFallido({ status: 'active', nextPaymentDate: '2026-12-20' }, hoy).accessUntil, undefined);
  assert.equal(sus.cambiosPorCobroFallido({ status: 'cancelled', accessUntil: '2026-10-30' }, hoy).accessUntil, undefined);
});

test('customer.subscription.updated: cancelar y reactivar desde Stripe, past_due, unpaid y suscripción vieja', () => {
  const m = { status: 'active', stripeSubscriptionId: 'sub_1', nextPaymentDate: '2026-11-01' };
  const c = sus.cambiosPorSuscripcion({ id: 'sub_1', status: 'active', cancel_at_period_end: true, current_period_end: seg('2026-11-15') }, m);
  assert.equal(c.status, 'cancelled'); assert.equal(c.accessUntil, '2026-11-15');
  const r = sus.cambiosPorSuscripcion({ id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: seg('2026-11-15') }, { ...m, status: 'cancelled', accessUntil: '2026-11-15' });
  assert.equal(r.status, 'active'); assert.equal(r.accessUntil, ''); assert.equal(r.nextPaymentDate, '2026-11-15');
  assert.deepEqual(sus.cambiosPorSuscripcion({ id: 'sub_1', status: 'past_due' }, m), { pagoPendiente: true });
  const u = sus.cambiosPorSuscripcion({ id: 'sub_1', status: 'unpaid' }, { ...m, pagoPendiente: true });
  assert.equal(u.status, 'inactive'); assert.equal(u.suscripcionTerminada, true);
  assert.equal(sus.cambiosPorSuscripcion({ id: 'sub_viejo', status: 'active' }, m), null);
  assert.equal(sus.cambiosPorSuscripcion({ id: 'sub_1', status: 'active' }, { ...m, status: 'inactive', canceladoPor: 'admin@x' }), null, 'no revierte lo que hizo el administrador');
});

test('fin de periodo: usa la fecha de Stripe de la suscripción o de la factura', () => {
  assert.equal(sus.finDePeriodo({ current_period_end: seg('2026-03-01') }), '2026-03-01');
  assert.equal(sus.finDePeriodo({ lines: { data: [{ period: { end: seg('2026-02-28') } }] } }), '2026-02-28');
  assert.equal(sus.finDePeriodo({}), '');
});

test('quitar acceso: cancela YA la suscripción en Stripe; si Stripe falla no toca nada', async () => {
  const cancelados = [];
  let falla = false;
  const stripe = { subscriptions: { cancel: async id => { if (falla) throw new Error('Stripe caído'); cancelados.push(id); return {}; } } };
  const s = await levantar({ 'members/m1': { name: 'Ana', email: 'ana@mail.com', status: 'active', stripeSubscriptionId: 'sub_1', nextPaymentDate: '2099-01-01' }, 'members/m3': { name: 'Cortesía', email: 'c@mail.com', status: 'active' } },
    (app, db) => montarRutasServidor(app, { db, admin, stripe }));
  try {
    falla = true;
    assert.equal((await s.llamar('/api/admin/miembros/m1/cancelar', {})).status, 502);
    assert.equal((await leer(s.db, 'members/m1')).status, 'active', 'sin cancelar en Stripe no se quita el acceso');
    falla = false;
    const r = await s.llamar('/api/admin/miembros/m1/cancelar', {});
    assert.equal(r.status, 200); assert.equal(r.cuerpo.stripeCancelada, true); assert.deepEqual(cancelados, ['sub_1']);
    const m = await leer(s.db, 'members/m1');
    assert.equal(m.status, 'inactive'); assert.equal(m.suscripcionTerminada, true); assert.equal(m.canceladoPor, 'teccapitalweb@gmail.com');
    assert.equal((await s.llamar('/api/admin/miembros/m3/cancelar', {})).status, 200, 'sin suscripción de Stripe solo quita el acceso');
    assert.deepEqual(cancelados, ['sub_1']);
  } finally { s.cerrar(); }
});

test('papelera: pregunta a Stripe si la suscripción sigue viva antes de eliminar', async () => {
  const estados = { sub_vivo: 'active', sub_muerto: 'canceled', sub_pendiente: 'past_due' };
  const stripe = { subscriptions: { retrieve: async id => ({ id, status: estados[id] }) } };
  const s = await levantar({
    'members/m1': { name: 'A', email: 'a@m.com', status: 'inactive', stripeSubscriptionId: 'sub_vivo' },
    'members/m2': { name: 'B', email: 'b@m.com', status: 'inactive', stripeSubscriptionId: 'sub_muerto' },
    'members/m4': { name: 'D', email: 'd@m.com', status: 'active', stripeSubscriptionId: 'sub_pendiente' }
  }, (app, db) => montarRutasAdminMiembros(app, { db, admin, stripe }));
  try {
    assert.equal((await s.llamar('/api/admin/miembros/m1/eliminar', {})).status, 409, 'inactiva en el Club pero Stripe sigue cobrando');
    assert.equal((await s.llamar('/api/admin/miembros/m4/eliminar', {})).status, 409);
    assert.equal((await s.llamar('/api/admin/miembros/m2/eliminar', {})).status, 200);
  } finally { s.cerrar(); }
});

test('clases en vivo: el enlace y la grabación solo llegan a miembros; el panel los guarda, valida y borra', async () => {
  const s = await levantar({ 'members/m1': { status: 'active', nextPaymentDate: '2099-01-01' }, 'members/m9': { status: 'registered' } },
    (app, db) => montarRutasWebinars(app, { db, admin, tieneMembresia: vigente }));
  try {
    assert.equal((await s.llamar('/api/admin/webinars-enlaces', { id: '17', link: 'https://zoom.us/j/1' }, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/webinars-enlaces', { id: '17', link: 'javascript:alert(1)' })).status, 400);
    assert.equal((await s.llamar('/api/admin/webinars-enlaces', { id: '17', titulo: 'Rodilla', link: 'https://zoom.us/j/1' })).status, 200);
    assert.equal((await s.llamar('/api/webinars/17/enlace?tipo=vivo', null, null)).status, 401);
    assert.equal((await s.llamar('/api/webinars/17/enlace?tipo=vivo', null, 'libre')).status, 402);
    const ok = await s.llamar('/api/webinars/17/enlace?tipo=vivo', null, 'socio');
    assert.equal(ok.status, 200); assert.equal(ok.cuerpo.url, 'https://zoom.us/j/1');
    assert.equal((await s.llamar('/api/webinars/17/enlace?tipo=grabacion', null, 'socio')).status, 404);
    assert.equal((await s.llamar('/api/admin/webinars-enlaces')).cuerpo.webinars.length, 1);
    assert.equal((await s.llamar('/api/admin/webinars-enlaces/17', null, 'admin', 'DELETE')).status, 200);
    assert.equal((await s.llamar('/api/webinars/17/enlace?tipo=vivo', null, 'socio')).status, 404);
  } finally { s.cerrar(); }
});
