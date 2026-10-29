const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasAdminMiembros, planearSincronizacion } = require('../services/admin-miembros');

function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); },
    async update(v) { datos.set(ruta, { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) }); },
    async delete() { datos.delete(ruta); },
    collection: n => col(ruta + '/' + n), doc: n => ref(ruta + '/' + n)
  });
  const col = nombre => {
    let lim = 1e9; const filtros = [];
    const q = {
      doc: id => ref(nombre + '/' + id), limit(n) { lim = n; return q; }, where(c, o, v) { filtros.push([c, v]); return q; },
      async get() {
        const prof = nombre.split('/').length + 1;
        const docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === prof).filter(([, v]) => filtros.every(([c, val]) => v[c] === val)).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        return { docs: docs.slice(0, lim), empty: !docs.length };
      }
    };
    return q;
  };
  return { collection: col, datos };
}
const tokens = { admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }, socio: { uid: 's1', email: 's@m.com', email_verified: true } };
async function levantar(semilla, stripe) {
  const db = fakeDb(semilla), app = express(); app.use(express.json());
  const cuentas = [];
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; }, updateUser: async (uid, c) => { cuentas.push(['update', uid, c]); }, deleteUser: async uid => { cuentas.push(['delete', uid]); } }) };
  montarRutasAdminMiembros(app, { db, admin, stripe });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, quien = 'admin', metodo) => {
    const r = await fetch(base + ruta, { method: metodo || (cuerpo ? 'POST' : 'GET'), headers: { Authorization: 'Bearer ' + quien, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { db, cuentas, llamar, cerrar: () => srv.close() };
}
const seg = f => Math.floor(new Date(f + 'T12:00:00Z').getTime() / 1000);

test('planearSincronizacion: agrega cobros pagados y rechazados que faltan, sin duplicar', () => {
  const miembro = { status: 'active', nextPaymentDate: '2026-01-01', payments: [{ date: '2026-09-01', amount: 199, status: 'paid' }, { stripeInvoiceId: 'in_viejo', date: '2026-08-01', amount: 199, status: 'paid' }] };
  const facturas = [
    { id: 'in_1', status: 'paid', amount_paid: 19900, created: seg('2026-09-01'), status_transitions: { paid_at: seg('2026-09-01') }, subscription: 'sub_1', billing_reason: 'subscription_create', lines: { data: [{ price: { recurring: { interval: 'month' } } }] } }, // ya estaba (mismo día y monto)
    { id: 'in_viejo', status: 'paid', amount_paid: 19900, created: seg('2026-08-01'), status_transitions: { paid_at: seg('2026-08-01') } }, // ya estaba por id
    { id: 'in_2', status: 'paid', amount_paid: 19900, created: seg('2026-10-01'), status_transitions: { paid_at: seg('2026-10-01') }, subscription: 'sub_1', billing_reason: 'subscription_cycle', lines: { data: [{ price: { recurring: { interval: 'month' } } }] } },
    { id: 'in_3', status: 'open', amount_due: 19900, attempt_count: 2, created: seg('2026-10-05') },
    { id: 'in_cero', status: 'paid', amount_paid: 0, created: seg('2026-10-06') }
  ];
  const r = planearSincronizacion(miembro, facturas, { status: 'active', current_period_end: seg('2026-11-01'), cancel_at_period_end: false });
  assert.deepEqual(r.nuevos.map(p => p.stripeInvoiceId || p.invoiceId), ['in_2', 'in_3']);
  assert.equal(r.nuevos[0].concept, 'Renovación mensual'); assert.equal(r.nuevos[1].status, 'failed');
  assert.equal(r.cambios.nextPaymentDate, '2026-11-01');
  assert.equal(planearSincronizacion({ ...miembro, payments: [...miembro.payments, ...r.nuevos] }, facturas, null).nuevos.length, 0); // segunda vez: nada nuevo
});

test('planearSincronizacion: cancelación y reactivación hechas desde Stripe', () => {
  const fin = seg('2026-12-01');
  const c = planearSincronizacion({ status: 'active', payments: [] }, [], { status: 'active', current_period_end: fin, cancel_at_period_end: true }).cambios;
  assert.equal(c.status, 'cancelled'); assert.equal(c.accessUntil, '2026-12-01');
  const r = planearSincronizacion({ status: 'cancelled', accessUntil: '2026-12-01', payments: [] }, [], { status: 'active', current_period_end: fin, cancel_at_period_end: false }).cambios;
  assert.equal(r.status, 'active'); assert.equal(r.accessUntil, '');
});

test('sincronizar desde el panel: solo administradores, guarda los pagos y deja bitácora', async () => {
  const stripe = {
    invoices: { list: async () => ({ data: [{ id: 'in_9', status: 'paid', amount_paid: 199900, created: seg('2026-10-10'), status_transitions: { paid_at: seg('2026-10-10') }, subscription: 'sub_9', lines: { data: [{ price: { recurring: { interval: 'year' } } }] }, billing_reason: 'subscription_cycle' }, { id: 'in_10', status: 'open', amount_due: 199900, attempt_count: 1, created: seg('2026-10-12') }] }) },
    subscriptions: { retrieve: async () => ({ status: 'active', current_period_end: seg('2027-10-10'), cancel_at_period_end: false }) }
  };
  const s = await levantar({ 'members/m1': { name: 'Ana', email: 'a@m.com', status: 'active', plan: 'anual', stripeSubscriptionId: 'sub_9', payments: [] }, 'members/m2': { name: 'Sin Stripe', status: 'registered' } }, stripe);
  try {
    assert.equal((await s.llamar('/api/admin/pagos/sincronizar', {}, 'socio')).status, 403);
    const r = await s.llamar('/api/admin/pagos/sincronizar', {});
    assert.equal(r.status, 200); assert.equal(r.cuerpo.nuevos, 1); assert.equal(r.cuerpo.rechazados, 1); assert.equal(r.cuerpo.suscripciones, 1);
    const m = s.db.datos.get('members/m1');
    assert.equal(m.payments.length, 2); assert.equal(m.payments[0].concept, 'Renovación anual'); assert.equal(m.nextPaymentDate, '2027-10-10');
    assert.equal((await s.llamar('/api/admin/pagos/sincronizar', {})).cuerpo.nuevos, 0); // idempotente
    assert.ok([...s.db.datos.keys()].some(k => k.startsWith('adminAcciones/')));
  } finally { s.cerrar(); }
});

test('papelera: eliminar conserva el avance, bloquea el acceso y se puede restaurar o borrar para siempre', async () => {
  const s = await levantar({
    'members/m1': { name: 'Ana', email: 'a@m.com', status: 'registered', payments: [{ date: '2026-01-01', amount: 199 }] }, 'members/m1/progress/courses': { c_1: { completed: [0, 1] } },
    'members/m2': { name: 'Paga', email: 'p@m.com', status: 'active', stripeSubscriptionId: 'sub_x' }, 'members/a1': { name: 'Admin', email: 'teccapitalweb@gmail.com', status: 'registered' }, 'directorio/m1': { publicado: true, nombre: 'Ana' }
  });
  try {
    assert.equal((await s.llamar('/api/admin/miembros/m1/eliminar', {}, 'socio')).status, 403);
    assert.equal((await s.llamar('/api/admin/miembros/m2/eliminar', {})).status, 409); // suscripción activa
    assert.equal((await s.llamar('/api/admin/miembros/a1/eliminar', {})).status, 403); // administrador
    assert.equal((await s.llamar('/api/admin/miembros/m1/eliminar', { mensaje: 'duplicado' })).status, 200);
    assert.equal(s.db.datos.has('members/m1'), false);
    assert.ok(s.db.datos.get('members/m1/progress/courses'), 'el avance se conserva');
    assert.equal(s.db.datos.get('directorio/m1').publicado, false);
    assert.deepEqual(s.cuentas[0], ['update', 'm1', { disabled: true }]);
    const lista = await s.llamar('/api/admin/papelera');
    assert.equal(lista.cuerpo.miembros.length, 1); assert.equal(lista.cuerpo.miembros[0].pagos, 1);
    assert.equal((await s.llamar('/api/admin/papelera/m1/restaurar', {})).status, 200);
    assert.equal(s.db.datos.get('members/m1').name, 'Ana'); assert.equal(s.db.datos.get('members/m1').eliminadoEn, undefined);
    assert.equal(s.db.datos.has('miembrosPapelera/m1'), false);
    await s.llamar('/api/admin/miembros/m1/eliminar', {});
    assert.equal((await s.llamar('/api/admin/papelera/m1/eliminar-definitivo', {})).status, 200);
    assert.ok(s.cuentas.some(c => c[0] === 'delete' && c[1] === 'm1'));
    assert.ok(s.db.datos.get('members/m1/progress/courses'), 'el avance sigue ahí');
  } finally { s.cerrar(); }
});

test('retos y XP: resumen, por tipo y adelanto de cada miembro', async () => {
  const s = await levantar({
    'members/m1': { name: 'Ana', email: 'a@m.com', status: 'active', plan: 'mensual' }, 'members/m2': { name: 'Beto', email: 'b@m.com', status: 'registered' },
    'members/m1/progress/retos': { superados: { 'q-1': { mejor: 3, total: 3 }, 'o-1': {}, 'd-d-sala': {}, 'h-1': {} } }, 'members/m1/progress/logros': { racha: 4, ultimaVisita: '2026-10-27' }, 'members/m1/progress/premios': { adelantoRetos: { cursoId: '77' } },
    'retosClasificacion/m1': { xp: 2600, retos: 4 }, 'retosClasificacion/m2': { xp: 40, retos: 0 }
  });
  try {
    assert.equal((await s.llamar('/api/admin/retos-xp', null, 'socio')).status, 403);
    const r = (await s.llamar('/api/admin/retos-xp')).cuerpo;
    assert.equal(r.miembros[0].name, 'Ana'); assert.equal(r.miembros[0].nivel, 'Profesional'); assert.equal(r.miembros[0].racha, 4); assert.equal(r.miembros[0].adelanto, '77');
    assert.equal(r.miembros[0].retos, 4); assert.equal(r.miembros[0].porTipo.quiz, 1);
    assert.equal(r.resumen.miembros, 2); assert.equal(r.resumen.xpTotal, 2640); assert.equal(r.resumen.adelantosUsados, 1); assert.equal(r.resumen.porNivel.Profesional, 1);
  } finally { s.cerrar(); }
});

test('moderación del directorio: ocultar, mostrar y eliminar con bitácora; el Club recibe las ocultas', async () => {
  const { montarRutasDirectorio } = require('../services/directorio');
  const db = fakeDb({ 'directorio/t1': { nombre: 'Ana', publicado: true, bio: 'Texto' }, 'directorio/t2': { nombre: 'Beto', publicado: false }, 'members/t1': { status: 'active' }, 'directorioContacto/t1': { whatsapp: '5551112222' } });
  const app = express(); app.use(express.json());
  const cuentas = [];
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; }, updateUser: async () => {}, deleteUser: async () => {} }) };
  montarRutasAdminMiembros(app, { db, admin, stripe: null });
  montarRutasDirectorio(app, { db, admin, tieneMembresia: m => m.status === 'active' });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const ll = async (ruta, cuerpo, quien = 'admin') => { const r = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + quien, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return { status: r.status, cuerpo: await r.json() }; };
  try {
    assert.equal((await ll('/api/admin/directorio', null, 'socio')).status, 403);
    const l1 = (await ll('/api/admin/directorio')).cuerpo; assert.equal(l1.resumen.total, 2); assert.equal(l1.resumen.visibles, 1); assert.equal(l1.resumen.privadas, 1);
    assert.equal((await ll('/api/admin/directorio/t1/ocultar', { motivo: 'contenido ofensivo' }, 'socio')).status, 403);
    assert.equal((await ll('/api/admin/directorio/t1/ocultar', { motivo: 'contenido ofensivo' })).status, 200);
    const l2 = (await ll('/api/admin/directorio')).cuerpo; assert.equal(l2.resumen.ocultas, 1); assert.equal(l2.tarjetas.find(t => t.uid === 't1').motivo, 'contenido ofensivo');
    const meta = (await ll('/api/directorio/meta', null, 'socio')).cuerpo; assert.deepEqual(meta.ocultas, ['t1']);
    assert.equal(meta.contactos.t1, undefined); // sin contacto de una tarjeta oculta
    assert.ok([...db.datos.keys()].some(k => k.startsWith('adminAcciones/')));
    // borrar y volver a crear la tarjeta no quita la marca de moderación
    assert.equal((await ll('/api/admin/directorio/t1/eliminar', { motivo: 'reincidencia' })).status, 200);
    assert.equal(db.datos.has('directorio/t1'), false); assert.equal(db.datos.has('directorioModeracion/t1'), true);
    db.datos.set('directorio/t1', { nombre: 'Ana de nuevo', publicado: true });
    assert.deepEqual((await ll('/api/directorio/meta', null, 'socio')).cuerpo.ocultas, ['t1']);
    assert.equal((await ll('/api/admin/directorio/t1/mostrar', {})).status, 200);
    assert.deepEqual((await ll('/api/directorio/meta', null, 'socio')).cuerpo.ocultas, []);
    assert.equal((await ll('/api/admin/directorio/nadie/ocultar', {})).status, 404);
  } finally { srv.close(); }
});
