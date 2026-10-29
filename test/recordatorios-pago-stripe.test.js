'use strict';
// RECORDATORIOS DE PAGO · unión con el checkout y el webhook de Stripe (services/recordatorios.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./helpers/fake-firestore');
const { crearRecordatorios } = require('../services/recordatorios');
const R = require('../services/recordatorios-pago');

function mundo(seed = {}, promo = { active: true }) {
  const ahora = Date.now();
  const estado = R.estadoTrasEnviar({ registroMs: ahora - 3 * R.DIA, ciclo: 1, paso: 1, enviados: 1 }, { ciclo: 1, paso: 2, ahoraMs: ahora - 3600000, codigo: 'FT50-ABC234', promoId: 'promo_1', venceMs: ahora + 5 * R.HORA });
  const db = new FakeFirestore({ 'members/ana': { email: 'ana@example.com' }, 'recordatoriosPago/ana': estado, ...seed });
  const stripe = { promotionCodes: { retrieve: async () => ({ id: 'promo_1', ...promo }) } };
  const admin = { auth: () => ({}) };
  const rec = crearRecordatorios({ db, admin, stripe, tieneMembresia: m => m && m.status === 'active', cargarCatalogo: () => ({ courses: [] }), leerPreciosConfig: async () => ({ precioMes: 249, precioAno: 1999 }), apiPublica: 'https://api.test' });
  return { rec, db };
}

test('checkout: el cupón vigente se aplica solo al plan mensual y solo si el correo del checkout es el de la cuenta', async () => {
  const { rec } = mundo();
  const cfg = () => ({ metadata: { plan: 'mensual' } });
  const a = cfg();
  const c = await rec.aplicarCupon(a, 'ana', 'mensual', 'Ana@Example.com');
  assert.equal(c.codigo, 'FT50-ABC234');
  assert.deepEqual(a.discounts, [{ promotion_code: 'promo_1' }]);
  assert.equal(a.metadata.recordatorioCodigo, 'FT50-ABC234'); assert.equal(a.metadata.recordatorioPaso, '2');
  const sin = rec.sinCupon(a);
  assert.equal(sin.discounts, undefined); assert.equal(sin.metadata.recordatorioPromoId, undefined); assert.equal(sin.metadata.plan, 'mensual');
  assert.equal(await rec.aplicarCupon(cfg(), 'ana', 'anual', 'ana@example.com'), null, 'el plan anual no lleva descuento');
  assert.equal(await rec.aplicarCupon(cfg(), 'ana', 'mensual', 'otra@example.com'), null, 'el uid viene del navegador: el correo debe coincidir');
  assert.equal(await rec.aplicarCupon(cfg(), '', 'mensual', 'ana@example.com'), null);
});

test('checkout: si Stripe ya venció o agotó el código, no se aplica y se cobra normal', async () => {
  const { rec } = mundo({}, { active: false });
  const a = { metadata: {} };
  assert.equal(await rec.aplicarCupon(a, 'ana', 'mensual', 'ana@example.com'), null);
  assert.equal(a.discounts, undefined);
});

test('pago: con descuento aplicado queda convertida; sin descuento, solo «pagó»; nunca lanza', async () => {
  const { rec, db } = mundo();
  await rec.cerrarSerie({ metadata: { recordatorioPromoId: 'promo_1', recordatorioCodigo: 'FT50-ABC234', recordatorioPaso: '2' }, total_details: { amount_discount: 5000 } }, 'ana');
  const e = db.value('recordatoriosPago/ana');
  assert.equal(e.cerrada, 'convertida'); assert.equal(e.conversion.paso, 2); assert.equal(e.conversion.conCupon, true);
  const m2 = mundo();
  await m2.rec.cerrarSerie({ metadata: { recordatorioPromoId: 'promo_1' }, total_details: { amount_discount: 0 } }, 'ana');
  assert.equal(m2.db.value('recordatoriosPago/ana').cerrada, 'pago');
  await m2.rec.cerrarSerie({ metadata: {} }, ''); // sin uid: no hace nada ni lanza
});
