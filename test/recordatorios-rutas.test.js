'use strict';
// RECORDATORIOS DE PAGO · rutas (baja, cupón, preferencia y panel) con Firestore, Auth y Stripe simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { FakeFirestore } = require('./helpers/fake-firestore');
const { crearServicio } = require('../services/recordatorios-servicio');
const { montarRutasRecordatorios } = require('../services/rutas-recordatorios');
const R = require('../services/recordatorios-pago');

const CLAVE = R.claveDeBaja('llave-de-prueba');
const tokens = {
  ana: { uid: 'ana', email: 'ana@example.com', email_verified: true },
  miembro: { uid: 'miembro', email: 'm@example.com', email_verified: true },
  admin: { uid: 'adm', email: 'teccapitalweb@gmail.com', email_verified: true, name: 'Jefe' }
};
async function levantar(seed = {}) {
  const db = new FakeFirestore({ 'members/ana': { email: 'ana@example.com', name: 'Ana' }, 'members/miembro': { email: 'm@example.com', status: 'active' }, ...seed });
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; }, getUsers: async () => ({ users: [], notFound: [] }) }) };
  const enviados = [];
  const servicio = crearServicio({
    db, auth: admin.auth(), stripe: { coupons: { retrieve: async () => ({ metadata: { marca: 'fisioteck' } }), create: async d => d }, promotionCodes: { create: async d => ({ id: 'promo_1', ...d }), retrieve: async () => ({ active: true }) } },
    enviarCorreo: async a => { enviados.push(a); return { ok: true }; }, claveBaja: CLAVE, tieneAcceso: m => m && m.status === 'active',
    correosAdmin: () => ['teccapitalweb@gmail.com'], urls: { compra: 'https://club.fisioteck.com/', baja: (u, f) => '/baja-recordatorios?u=' + u + '&t=' + f },
    leerPrecioMes: async () => 249, pausaEntreEnviosMs: 0, registro: { log() {}, error() {}, warn() {} }
  });
  const app = express();
  montarRutasRecordatorios(app, { db, admin, recordatorios: servicio, claveBaja: () => CLAVE });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, { cuerpo, token, form } = {}) => {
    const r = await fetch(base + ruta, {
      method: cuerpo || form ? 'POST' : 'GET',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cuerpo ? { 'Content-Type': 'application/json' } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : form
    });
    const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch (_) { /* html */ }
    return { status: r.status, texto, json, cabeceras: r.headers };
  };
  return { llamar, db, enviados, servicio, cerrar: () => srv.close() };
}
const urlBaja = (uid, firma = R.firmarBaja(CLAVE, uid)) => `/baja-recordatorios?u=${uid}&t=${firma}`;

test('baja: el GET solo muestra la confirmación; el POST da de baja para siempre; firma falsa se rechaza', async () => {
  const s = await levantar();
  try {
    const g = await s.llamar(urlBaja('ana'));
    assert.equal(g.status, 200); assert.match(g.texto, /¿Ya no quieres recibir promociones\?/); assert.equal(g.cabeceras.get('cache-control'), 'no-store');
    assert.equal(s.db._data.has('recordatoriosPago/ana'), false, 'abrir el enlace no cambia nada');
    const p = await s.llamar(urlBaja('ana'), { form: 'List-Unsubscribe=One-Click' });
    assert.equal(p.status, 200); assert.match(p.texto, /ya no te enviaremos promociones/);
    assert.equal(s.db.value('recordatoriosPago/ana').baja, true);
    assert.equal((await s.llamar(urlBaja('beto', 'f'.repeat(40)), { form: 'x=1' })).status, 400);
    assert.equal((await s.llamar(urlBaja('beto', 'f'.repeat(40)))).status, 400);
    assert.equal(s.db._data.has('recordatoriosPago/beto'), false);
  } finally { s.cerrar(); }
});

test('preferencia: la persona la ve y la cambia; quien se dio de baja no puede volver a activarla', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/recordatorios/preferencia')).status, 401);
    assert.equal((await s.llamar('/api/recordatorios/preferencia', { token: 'ana' })).json.recibe, true);
    assert.equal((await s.llamar('/api/recordatorios/preferencia', { token: 'ana', cuerpo: { recibe: 'si' } })).status, 400);
    assert.equal((await s.llamar('/api/recordatorios/preferencia', { token: 'ana', cuerpo: { recibe: false } })).json.recibe, false);
    assert.equal((await s.llamar('/api/recordatorios/preferencia', { token: 'ana', cuerpo: { recibe: true } })).json.recibe, true);
    await s.llamar(urlBaja('ana'), { form: 'x=1' });
    assert.equal((await s.llamar('/api/recordatorios/preferencia', { token: 'ana', cuerpo: { recibe: true } })).json.recibe, false);
  } finally { s.cerrar(); }
});

test('mi cupón: solo el vigente de ESTA cuenta; un miembro no lo ve', async () => {
  const ahora = Date.now();
  const estado = R.estadoTrasEnviar({ registroMs: ahora - 3 * R.DIA, ciclo: 1, paso: 1, enviados: 1 }, { ciclo: 1, paso: 2, ahoraMs: ahora - 3600000, codigo: 'FT50-ABC234', promoId: 'promo_1', venceMs: ahora + 5 * R.HORA });
  const s = await levantar({ 'recordatoriosPago/ana': estado, 'recordatoriosPago/miembro': estado });
  try {
    const c = (await s.llamar('/api/recordatorios/mi-cupon', { token: 'ana' })).json.cupon;
    assert.equal(c.codigo, 'FT50-ABC234'); assert.equal(c.precioFinal, 199); assert.equal(c.promoId, undefined);
    assert.equal((await s.llamar('/api/recordatorios/mi-cupon', { token: 'miembro' })).json.cupon, null);
  } finally { s.cerrar(); }
});

test('panel: solo administración; el interruptor pide confirmación y arranca apagado', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/recordatorios', { token: 'ana' })).status, 403);
    const est = (await s.llamar('/api/admin/recordatorios', { token: 'admin' })).json;
    assert.equal(est.modo, 'apagado'); assert.equal(est.configurado, true);
    assert.equal((await s.llamar('/api/admin/recordatorios/modo', { token: 'admin', cuerpo: { modo: 'activo' } })).status, 400);
    assert.equal((await s.llamar('/api/admin/recordatorios/modo', { token: 'admin', cuerpo: { modo: 'activo', confirmo: true } })).json.modo, 'activo');
    assert.equal((await s.llamar('/api/admin/recordatorios/limites', { token: 'admin', cuerpo: { topeDiario: 0, maxPorCorrida: 5 } })).status, 400);
    assert.equal((await s.llamar('/api/admin/recordatorios/limites', { token: 'admin', cuerpo: { topeDiario: 40, maxPorCorrida: 10 } })).json.topeDiario, 40);
    assert.equal((await s.llamar('/api/admin/recordatorios/ensayo', { token: 'admin', cuerpo: {} })).json.ensayo, true);
    assert.equal(s.enviados.length, 0, 'el ensayo no envía');
    assert.equal((await s.llamar('/api/admin/recordatorios/lista', { token: 'admin' })).status, 200);
  } finally { s.cerrar(); }
});

test('correo de prueba: llega solo a quien administra, con cupón de prueba y asunto marcado', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/admin/recordatorios/prueba', { token: 'admin', cuerpo: { paso: 9 } })).status, 400);
    const r = (await s.llamar('/api/admin/recordatorios/prueba', { token: 'admin', cuerpo: { paso: 2 } })).json;
    assert.equal(r.para, 'teccapitalweb@gmail.com');
    assert.equal(s.enviados.length, 1); assert.match(s.enviados[0].asunto, /^\[PRUEBA\]/);
  } finally { s.cerrar(); }
});
