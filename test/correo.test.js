const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const correo = require('../services/correo');
const { montarRutasAuth } = require('../services/rutas-auth');

const fetchFalso = (estado = 200, registro = []) => async (url, op) => { registro.push({ url, op, cuerpo: JSON.parse(op.body) }); return { ok: estado < 400, status: estado, text: async () => 'x', headers: { get: () => '7' } }; };

test('plantillas: escapan datos de personas y llevan el enlace', () => {
  const p = correo.plantillaVerificacion({ nombre: '<b>Ana</b> Pérez', enlace: 'https://club.fisioteck.com/?modo=verifyEmail&oobCode=abc' });
  assert.equal(p.html.includes('<b>Ana</b>'), false);
  assert.match(p.html, /FisioTeck/);
  assert.match(p.texto, /oobCode=abc/);
  const c = correo.plantillaCertificado({ nombre: 'Luis', curso: '<script>x</script>', folio: 'FT-AAAA-BBBB', clases: 3, conAdjunto: true });
  assert.equal(c.html.includes('<script>'), false);
  assert.match(c.html, /Adjuntamos tu certificado/);
  assert.match(c.urlVerificar, /folio=FT-AAAA-BBBB/);
});

test('enviarConResend: sin configurar no envía; con límite avisa cuánto esperar', async () => {
  assert.deepEqual(await correo.enviarConResend({ para: 'a@b.com', asunto: 's', html: 'h', texto: 't' }, { apiKey: '', from: '' }), { ok: false, motivo: 'sin-configurar' });
  const reg = [];
  const ok = await correo.enviarConResend({ para: 'a@b.com', asunto: 's', html: 'h', texto: 't', idempotencyKey: 'k1' }, { apiKey: 'K', from: 'FisioTeck <x@y.com>', fetchImpl: fetchFalso(200, reg) });
  assert.equal(ok.ok, true);
  assert.equal(reg[0].op.headers.Authorization, 'Bearer K'); assert.equal(reg[0].op.headers['Idempotency-Key'], 'k1');
  const lim = await correo.enviarConResend({ para: 'a@b.com', asunto: 's', html: 'h', texto: 't' }, { apiKey: 'K', from: 'F <x@y.com>', fetchImpl: fetchFalso(429) });
  assert.equal(lim.motivo, 'limite'); assert.equal(lim.esperarSegundos, 7);
});

test('correo del certificado: adjunta el PDF y no envía sin correo del titular', async () => {
  const reg = [];
  const cert = { folio: 'FT-AAAA-BBBB', email: 'a@b.com', nombre: 'Ana', cursoTitulo: 'Curso', clases: 4 };
  const ok = await correo.enviarCorreoCertificado(cert, { apiKey: 'K', from: 'F <x@y.com>', fetchImpl: fetchFalso(200, reg), generarPdf: async () => Buffer.from('%PDF') });
  assert.equal(ok, true);
  assert.equal(reg[0].cuerpo.attachments[0].filename, 'Certificado-FT-AAAA-BBBB.pdf');
  assert.equal(Buffer.from(reg[0].cuerpo.attachments[0].content, 'base64').toString(), '%PDF');
  assert.equal(await correo.enviarCorreoCertificado({ ...cert, email: '' }, { apiKey: 'K', from: 'F <x@y.com>', fetchImpl: fetchFalso() }), false);
  // si el PDF falla, el correo sale igual sin adjunto
  const reg2 = [];
  assert.equal(await correo.enviarCorreoCertificado(cert, { apiKey: 'K', from: 'F <x@y.com>', fetchImpl: fetchFalso(200, reg2), generarPdf: async () => { throw new Error('x'); } }), true);
  assert.equal(reg2[0].cuerpo.attachments, undefined);
});

async function levantar({ verificado = false } = {}) {
  const enviados = [];
  const admin = { auth: () => ({
    verifyIdToken: async t => { if (t !== 'ok') throw new Error('x'); return { uid: 'u1', email: 'u@mail.com', name: 'Uri', email_verified: verificado }; },
    generateEmailVerificationLink: async () => 'https://x.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=COD1',
    generatePasswordResetLink: async () => 'https://x.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=COD2',
    getUserByEmail: async e => { if (e !== 'u@mail.com') throw new Error('no'); return {}; }
  }) };
  const app = express(); app.use(express.json());
  montarRutasAuth(app, { admin, enviarCorreo: async c => { enviados.push(c); return { ok: true }; } });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const llamar = async (ruta, cuerpo, token) => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(cuerpo || {}) });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, enviados, cerrar: () => srv.close() };
}

test('verificación: manda el enlace propio, limita a 1 por minuto y no reenvía a quien ya verificó', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/auth/send-verification')).status, 401);
    assert.equal((await s.llamar('/api/auth/send-verification', {}, 'ok')).status, 200);
    assert.match(s.enviados[0].texto, /\?modo=verifyEmail&oobCode=COD1/);
    assert.equal(s.enviados[0].para, 'u@mail.com');
    assert.equal((await s.llamar('/api/auth/send-verification', {}, 'ok')).status, 429);
  } finally { s.cerrar(); }
  const v = await levantar({ verificado: true });
  try { assert.equal((await v.llamar('/api/auth/send-verification', {}, 'ok')).cuerpo.yaVerificado, true); assert.equal(v.enviados.length, 0); } finally { v.cerrar(); }
});

test('restablecer: responde igual exista o no la cuenta y solo envía a cuentas reales', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/auth/reset-password', { email: 'malo' })).status, 400);
    const a = await s.llamar('/api/auth/reset-password', { email: 'nadie@mail.com' });
    const b = await s.llamar('/api/auth/reset-password', { email: 'U@mail.com' });
    assert.deepEqual(a.cuerpo, b.cuerpo);
    assert.equal(s.enviados.length, 1);
    assert.match(s.enviados[0].texto, /modo=resetPassword&oobCode=COD2/);
  } finally { s.cerrar(); }
});
