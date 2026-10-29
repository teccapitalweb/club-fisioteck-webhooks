const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasDirectorio, contactoLimpio } = require('../services/directorio');

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
        const prof = nombre.split('/').length + 1;
        const docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === prof)
          .filter(([, v]) => filtros.every(([c, val]) => v[c] === val)).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        return { docs: docs.slice(0, lim), empty: !docs.length };
      }
    };
    return q;
  };
  return { collection: col, datos };
}
const tokens = { vip: { uid: 'v1', email: 'v@m.com' }, gratis: { uid: 'g1', email: 'g@m.com' }, admin: { uid: 'a1', email: 'teccapitalweb@gmail.com' } };
async function levantar(semilla) {
  const db = fakeDb(semilla), app = express(); app.use(express.json());
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return { ...tokens[t], email_verified: true }; } }) };
  montarRutasDirectorio(app, { db, admin, tieneMembresia: m => m.status === 'active' });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, quien = 'vip') => {
    const r = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + quien, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { db, llamar, cerrar: () => srv.close() };
}
const base = () => ({
  'members/v1': { status: 'active' }, 'members/g1': { status: 'registered' }, 'members/v2': { status: 'active' },
  'directorio/v1': { publicado: true, nombre: 'Ana' }, 'directorio/g1': { publicado: true, nombre: 'Gris' }, 'directorio/v2': { publicado: true, nombre: 'Beto' },
  'directorioContacto/v2': { whatsapp: '5551234567', email: 'b@m.com' }, 'directorioContacto/g1': { whatsapp: '5559999999' },
  'directorioContacto/v3': { cedula: '12345678', cedulaVisible: false }, 'directorioContacto/v1': { cedula: '99887766', cedulaVisible: true }, 'certificados/c1': { uid: 'v2', revocado: false }, 'certificados/c2': { uid: 'v2', revocado: true }
});

test('el contacto solo lo recibe quien tiene membresía; el VIP verificado y los certificados los decide el servidor', async () => {
  const s = await levantar(base());
  try {
    const vip = await s.llamar('/api/directorio/meta', null, 'vip');
    assert.equal(vip.cuerpo.viewerVip, true); assert.deepEqual(vip.cuerpo.contactos.v2, { whatsapp: '5551234567', email: 'b@m.com' });
    assert.ok(vip.cuerpo.vip.includes('v1') && vip.cuerpo.vip.includes('v2') && !vip.cuerpo.vip.includes('g1'));
    assert.equal(vip.cuerpo.certificados.v2, 1); // el revocado no cuenta
    const gratis = await s.llamar('/api/directorio/meta', null, 'gratis');
    assert.equal(gratis.cuerpo.viewerVip, false); assert.deepEqual(gratis.cuerpo.contactos, {});
    assert.equal(JSON.stringify(gratis.cuerpo).includes('5551234567'), false);
    assert.deepEqual(gratis.cuerpo.miContacto, { whatsapp: '5559999999', email: '', linkedin: '', web: '', instagram: '', cedula: '', cedulaVisible: false });
    assert.equal(vip.cuerpo.contactos.v1.cedula, '99887766'); // visible: se entrega
    assert.equal(JSON.stringify(vip.cuerpo).includes('12345678'), false); // oculta: no sale
    assert.equal((await s.llamar('/api/directorio/meta', null, 'nadie')).status, 401);
  } finally { s.cerrar(); }
});

test('guardar contacto: valida y solo escribe el propio', async () => {
  const s = await levantar(base());
  try {
    const ok = await s.llamar('/api/directorio/contacto', { whatsapp: '52 238 123 4567', email: 'ana@m.com', instagram: '@ana' }, 'vip');
    assert.equal(ok.status, 200); assert.equal(s.db.datos.get('directorioContacto/v1').email, 'ana@m.com');
    assert.equal((await s.llamar('/api/directorio/contacto', { email: 'no-es-correo' }, 'vip')).status, 400);
    assert.equal((await s.llamar('/api/directorio/contacto', { whatsapp: 'abc' }, 'vip')).status, 400);
    assert.throws(() => contactoLimpio({ web: 'x'.repeat(200) }));
  } finally { s.cerrar(); }
});
