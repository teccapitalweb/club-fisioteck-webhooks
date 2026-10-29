'use strict';

// RECORDATORIOS DE PAGO · servicio con Firestore y Stripe simulados, reloj controlado y «correos» guardados en una lista.
// Ejecutar: node --test test/recordatorios-servicio.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore, FakeTimestamp } = require('./helpers/fake-firestore');
const { crearServicio, ID_CUPON } = require('../services/recordatorios-servicio');
const R = require('../services/recordatorios-pago');

const { HORA, DIA } = R;
const mx = (anio, mes, dia, h = 12, min = 0) => Date.UTC(anio, mes - 1, dia, h + 6, min);
const SILENCIO = { log() {}, error() {}, warn() {} };
const CLAVE = R.claveDeBaja('llave-de-prueba');

function miembro(extra = {}) {
  return { email: 'x@example.com', name: 'Persona', role: 'member', planActivo: false, planTipo: null, planInicio: null, ultimoPago: null, planVence: null, ...extra };
}

// Un mundo de prueba: base de datos, Auth, Stripe, correo y reloj
function mundo({ seed = {}, correoOk = true, verificados = null } = {}) {
  const t = { ahora: mx(2026, 10, 22, 10, 0) };
  const db = new FakeFirestore(seed);
  const cuentas = {};
  const auth = {
    getUsers: async ids => {
      const users = []; const notFound = [];
      for (const { uid } of ids) {
        if (!db._data.has('members/' + uid)) { notFound.push({ uid }); continue; }
        const v = verificados ? verificados[uid] !== false : true;
        users.push({ uid, emailVerified: v, disabled: Boolean(cuentas[uid] && cuentas[uid].disabled), metadata: { creationTime: new Date(t.ahora - 40 * DIA).toUTCString() } });
      }
      return { users, notFound };
    }
  };
  const cupones = new Map(); const codigos = new Map(); const creados = { cupones: [], codigos: [] };
  const err404 = id => Object.assign(new Error('No such: ' + id), { code: 'resource_missing' });
  const stripe = {
    prices: { retrieve: async id => ({ id, unit_amount: 19900, product: 'prod_mensual' }) },
    coupons: {
      retrieve: async id => { if (!cupones.has(id)) throw err404(id); return cupones.get(id); },
      create: async d => { cupones.set(d.id, d); creados.cupones.push(d); return d; }
    },
    promotionCodes: {
      create: async d => {
        if ([...codigos.values()].some(c => c.code === d.code)) throw new Error('Promotion code already exists');
        const p = { id: 'promo_' + (codigos.size + 1), active: true, times_redeemed: 0, ...d };
        codigos.set(p.id, p); creados.codigos.push(p); return p;
      },
      retrieve: async id => { if (!codigos.has(id)) throw err404(id); return codigos.get(id); }
    }
  };
  const correos = [];
  const control = { ok: correoOk, resultado: null, lanzar: false };
  const enviarCorreo = async args => {
    if (control.lanzar) throw new Error('corte de luz');
    if (control.resultado) return control.resultado;
    correos.push(args);
    return control.ok ? { ok: true } : { ok: false, motivo: 'sin-configurar' };
  };
  const nuevo = (opciones = {}) => crearServicio({
    db, auth, stripe, enviarCorreo, correoConfigurado: () => true, claveBaja: CLAVE,
    tieneAcceso: m => m && m.planActivo === true, correosAdmin: () => ['jefe@fisioteck.com'],
    urls: { compra: 'https://club.fisioteck.com/', baja: (uid, firma) => 'https://api.test/baja-recordatorios?u=' + uid + '&t=' + firma },
    leerPrecioMes: async () => 249, leerCursosPrueba: async () => new Map([['1', 'Manejo de reptiles']]),
    reloj: () => t.ahora, pausaEntreEnviosMs: 0, registro: SILENCIO, ...opciones
  });
  return { t, db, stripe, cupones, codigos, creados, correos, control, nuevo, cuentas };
}
const registrado = (ms, extra = {}) => miembro({ createdAt: new FakeTimestamp(ms), ...extra });
const activar = (m, extra = {}) => m.db._data.set('config/recordatorios', { modo: 'activo', ...extra });

test('ARRANCA APAGADO: sin interruptor no sale ningún correo y el ensayo no envía nada', async () => {
  const m = mundo({ seed: { 'members/ana': registrado(mx(2026, 10, 21, 8)) } });
  const s = m.nuevo();
  assert.equal((await s.leerConfig()).modo, 'apagado');
  assert.deepEqual(await s.procesar(), { omitido: 'apagado' });
  assert.equal(m.correos.length, 0);
  const ensayo = await s.procesar({ ensayo: true });
  assert.equal(ensayo.ensayo, true); assert.equal(ensayo.modo, 'apagado');
  assert.equal(ensayo.recibirian.length, 1, 'el ensayo muestra quién recibiría un correo ahora');
  assert.equal(ensayo.recibirian[0].paso, 1);
  assert.equal(m.correos.length, 0, 'el ensayo NO envía');
  assert.equal(m.db._data.has('recordatoriosPago/ana'), false, 'el ensayo no cambia nada');
});

test('fuera de horario no se envía; sin llave de firmas o sin correo configurado tampoco', async () => {
  const m = mundo({ seed: { 'members/ana': registrado(mx(2026, 10, 20, 8)) } });
  activar(m);
  m.t.ahora = mx(2026, 10, 22, 23, 0);
  assert.deepEqual(await m.nuevo().procesar(), { omitido: 'fuera-de-horario' });
  m.t.ahora = mx(2026, 10, 22, 12, 0);
  assert.deepEqual(await m.nuevo({ claveBaja: null }).procesar(), { omitido: 'sin-configurar' });
  assert.deepEqual(await m.nuevo({ correoConfigurado: () => false }).procesar(), { omitido: 'sin-configurar' });
  assert.equal(m.correos.length, 0);
});

test('primer envío: solo a quien nunca pagó, con correo verificado y sin baja; lleva List-Unsubscribe y clave de idempotencia', async () => {
  const hace = h => mx(2026, 10, 22, 10) - h * HORA;
  const m = mundo({
    seed: {
      'members/ana': registrado(hace(30), { email: 'ana@example.com', name: 'Ana Pérez' }),
      'members/reciente': registrado(hace(2), { email: 'reciente@example.com' }),
      'members/paga': registrado(hace(30), { email: 'paga@example.com', lastPaymentDate: '2026-10-01', planActivo: true }),
      'members/ex': registrado(hace(30), { email: 'ex@example.com', payments: [{ date: '2025-01-01' }] }),
      'members/admin': registrado(hace(30), { email: 'jefe@fisioteck.com' }),
      'members/rol': registrado(hace(30), { email: 'rol@example.com', role: 'admin' }),
      'members/sinverificar': registrado(hace(30), { email: 'sv@example.com' }),
      'members/baja': registrado(hace(30), { email: 'baja@example.com' }),
      'members/noquiere': registrado(hace(30), { email: 'nq@example.com' }),
      'recordatoriosPago/baja': { baja: true, bajaMs: 1 },
      'recordatoriosPago/noquiere': { optOut: true, optOutOrigen: 'registro' }
    },
    verificados: { sinverificar: false }
  });
  activar(m);
  const r = await m.nuevo().procesar();
  assert.equal(r.enviados, 1, JSON.stringify(r));
  assert.equal(m.correos.length, 1);
  const c = m.correos[0];
  assert.equal(c.para, 'ana@example.com');
  assert.match(c.asunto, /^Ana,/);
  assert.equal(c.headers['List-Unsubscribe'].startsWith('<https://api.test/baja-recordatorios?u=ana&t='), true);
  assert.equal(c.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(c.idempotencyKey, 'fisioteck-recordatorio-ana-c1-p1');
  assert.deepEqual(c.tags.map(t => t.name), ['tipo', 'ciclo', 'paso']);
  assert.match(c.html, /Te escribimos porque tienes una cuenta/, 'el primer correo lleva el aviso visible');
  const est = m.db.value('recordatoriosPago/ana');
  assert.deepEqual([est.ciclo, est.paso, est.enviados, est.reserva], [1, 1, 1, null]);
  assert.equal(est.cuponCodigo, '', 'el paso 1 no tiene cupón');
  assert.equal(m.creados.codigos.length, 0);
  assert.equal(m.db.value('recordatoriosEstadisticas/dia-2026-10-22').enviados, 1);
  assert.equal(m.db.value('recordatoriosEstadisticas/global').enviadosPaso.p1, 1);
  // Nada para nadie más; al repetir la corrida no se manda otra vez
  assert.equal((await m.nuevo().procesar()).enviados, 0);
  assert.equal(m.correos.length, 1);
});

test('calendario con el reloj: cupón de $50 a las 24 h, $100 doce horas después de que venció, con el cupón de Stripe correcto', async () => {
  const registro = mx(2026, 10, 22, 8);
  const m = mundo({ seed: { 'members/ana': registrado(registro, { email: 'ana@example.com', name: 'Ana' }) } });
  activar(m);
  const s = m.nuevo();
  m.t.ahora = registro + 12 * HORA;                                       // 20:00
  assert.equal((await s.procesar()).enviados, 1);                         // paso 1
  m.t.ahora += 23 * HORA;
  assert.equal((await s.procesar()).enviados, 0, 'faltan 24 h para el paso 2');
  m.t.ahora = registro + 12 * HORA + 24 * HORA;                           // día siguiente 20:00
  assert.equal((await s.procesar()).enviados, 1);                         // paso 2: $50
  const e2 = m.db.value('recordatoriosPago/ana');
  assert.deepEqual([e2.ciclo, e2.paso, e2.cuponMonto], [1, 2, 50]);
  assert.match(e2.cuponCodigo, /^FT50-[A-Z2-9]{6}$/);
  assert.equal(e2.cuponVenceMs, m.t.ahora + 24 * HORA);
  // Cupón base con ID fijo, limitado al producto del plan mensual, y código único
  assert.equal(m.creados.cupones.length, 1);
  const base = m.creados.cupones[0];
  assert.equal(base.id, 'FISIOTECK_RECORDATORIO_50');
  assert.deepEqual([base.amount_off, base.currency, base.duration], [5000, 'mxn', 'once']);
  assert.equal(base.applies_to, undefined, 'el checkout de FisioTeck usa precio dinámico: el cupón no se ata a un producto');
  assert.equal(base.metadata.marca, 'fisioteck');
  const promo = m.creados.codigos[0];
  assert.equal(promo.coupon, 'FISIOTECK_RECORDATORIO_50');
  assert.equal(promo.code, e2.cuponCodigo);
  assert.equal(promo.max_redemptions, 1);
  assert.equal(promo.expires_at, Math.floor(e2.cuponVenceMs / 1000));
  assert.equal(promo.restrictions.first_time_transaction, true);
  assert.deepEqual([promo.metadata.marca, promo.metadata.uid, promo.metadata.paso, promo.metadata.ciclo, promo.metadata.prueba], ['fisioteck', 'ana', '2', '1', 'no']);
  assert.match(m.correos[1].html, new RegExp(e2.cuponCodigo));
  // Dentro de las 24 h el cupón está vigente para su panel y para el pago
  const c = await s.miCupon('ana', m.db.value('members/ana'));
  assert.deepEqual([c.codigo, c.monto, c.precioFinal, c.paso], [e2.cuponCodigo, 50, 199, 2]);
  assert.equal((await s.cuponParaCheckout('ana', m.db.value('members/ana'))).promoId, 'promo_1');
  // Paso 3: 12 h DESPUÉS de que venció (36 h después del envío anterior), con el cupón de $100
  m.t.ahora = e2.cuponVenceMs + 11 * HORA;
  assert.ok(!(await s.procesar()).enviados, 'faltando una hora, no sale');
  m.t.ahora = e2.cuponVenceMs + 12 * HORA;                                // 8:00 de la mañana: dentro de horario
  assert.equal((await s.procesar()).enviados, 1);
  const e3 = m.db.value('recordatoriosPago/ana');
  assert.deepEqual([e3.paso, e3.cuponMonto], [3, 100]);
  assert.match(e3.cuponCodigo, /^FT100-/);
  assert.equal(m.creados.cupones.length, 2, 'se crea el cupón base de $100 una sola vez');
  assert.equal(await s.miCupon('ana', m.db.value('members/ana')) !== null, true);
  assert.equal(m.db.value('recordatoriosEstadisticas/global').cuponesCreados.m100, 1);
});

test('las tres vueltas completas: 21 correos, descanso de 4 días y la serie se cierra sola al final', async () => {
  const registro = mx(2026, 10, 22, 8);
  const m = mundo({ seed: { 'members/ana': registrado(registro, { email: 'ana@example.com', name: 'Ana' }) } });
  activar(m);
  const s = m.nuevo();
  m.t.ahora = registro;
  const historial = [];
  for (let i = 0; i < 4000 && historial.length < 25; i++) {
    m.t.ahora += 20 * 60 * 1000;                                           // la revisión de cada 20 minutos
    const antes = m.correos.length;
    const r = await s.procesar();
    if (m.correos.length > antes) { const e = m.db.value('recordatoriosPago/ana'); historial.push({ ciclo: e.ciclo, paso: e.paso, ms: m.t.ahora, vence: e.cuponVenceMs }); }
    void r;
    if (R.serieTerminada(m.db.value('recordatoriosPago/ana') || {}) && m.t.ahora > registro + 60 * DIA) break;
  }
  assert.equal(historial.length, 21, 'exactamente 21 correos, ni uno más');
  assert.deepEqual(historial.map(h => h.ciclo), [...Array(7).fill(1), ...Array(7).fill(2), ...Array(7).fill(3)]);
  assert.deepEqual(historial.map(h => h.paso), [...Array(3)].flatMap(() => [1, 2, 3, 4, 5, 6, 7]));
  assert.ok(historial[7].ms - historial[6].vence >= 4 * DIA, 'descanso de al menos 4 días tras vencer el cupón del paso 7');
  assert.ok(historial[7].ms - historial[6].vence < 4 * DIA + 14 * HORA, 'y no mucho más (a lo sumo hasta la siguiente apertura)');
  const final = m.db.value('recordatoriosPago/ana');
  assert.equal(final.finalizado, true);
  // Muchos días después: nada más
  m.t.ahora += 90 * DIA;
  assert.equal((await s.procesar()).enviados, 0);
  assert.equal(m.correos.length, 21);
  const g = m.db.value('recordatoriosEstadisticas/global');
  assert.equal(g.enviadosCiclo.c1, 7); assert.equal(g.enviadosCiclo.c2, 7); assert.equal(g.enviadosCiclo.c3, 7);
  assert.deepEqual([g.enviadosPaso.p1, g.enviadosPaso.p7], [3, 3]);
  const ultimo = m.correos[20];
  assert.match(ultimo.html, /no te enviaremos más/);
  assert.match(m.correos[7].html, /volvemos a escribirte/i);
  // El paso 1 de las vueltas 2 y 3 NO repite el aviso de primer correo
  assert.doesNotMatch(m.correos[7].html, /Te escribimos porque tienes una cuenta/);
  // Claves de idempotencia únicas por vuelta y paso
  assert.equal(new Set(m.correos.map(c => c.idempotencyKey)).size, 21);
});

test('topes: 60 por día y 25 por corrida (configurables); se envía en orden de antigüedad', async () => {
  const seed = {};
  for (let i = 1; i <= 8; i++) seed['members/u' + i] = registrado(mx(2026, 10, 20, 8) + i * 1000, { email: `u${i}@example.com`, name: 'U' + i });
  const m = mundo({ seed });
  activar(m, { topeDiario: 5, maxPorCorrida: 3 });
  m.t.ahora = mx(2026, 10, 22, 12);
  const s = m.nuevo();
  assert.equal((await s.procesar()).enviados, 3, 'máximo 3 por corrida');
  assert.equal((await s.procesar()).enviados, 2, 'el día admite 5 en total');
  assert.equal((await s.procesar()).enviados, 0, 'tope diario alcanzado');
  assert.deepEqual(m.correos.map(c => c.para), ['u1@example.com', 'u2@example.com', 'u3@example.com', 'u4@example.com', 'u5@example.com']);
  const res = await s.resumen();
  assert.equal(res.enviadosHoy, 5); assert.equal(res.faltanHoy, 0); assert.equal(res.cupoCorrida, 0);
  // Al día siguiente se retoma
  m.t.ahora = mx(2026, 10, 23, 9);
  assert.equal((await s.procesar()).enviados, 3);
  // Por defecto: 60 y 25
  const por = await mundo().nuevo().leerConfig();
  assert.deepEqual([por.topeDiario, por.maxPorCorrida], [60, 25]);
  assert.deepEqual(await s.fijarLimites({ topeDiario: 80, maxPorCorrida: 10 }), { modo: 'activo', topeDiario: 80, maxPorCorrida: 10 });
});

test('si Resend falla o limita, el paso NO se marca como enviado y se reintenta después; el cupón creado se reutiliza', async () => {
  const registro = mx(2026, 10, 22, 8);
  const m = mundo({ seed: { 'members/ana': registrado(registro - 2 * DIA, { email: 'ana@example.com' }), 'members/beto': registrado(registro - 2 * DIA + 5, { email: 'beto@example.com' }) } });
  activar(m);
  const s = m.nuevo();
  m.t.ahora = registro + 3 * HORA;
  m.control.resultado = { ok: false, motivo: 'limite', status: 429, esperarSegundos: 7 };
  const r = await s.procesar();
  assert.equal(r.enviados, 0); assert.equal(r.limite, true); assert.equal(r.esperarSegundos, 7);
  assert.equal(r.fallos, 1, 'se detiene en el primer límite: no sigue golpeando a Resend');
  const e = m.db.value('recordatoriosPago/ana');
  assert.deepEqual([e.paso, e.enviados, e.fallos, e.reserva], [0, 0, 1, null]);
  assert.match(e.ultimoError, /429/);
  assert.equal(m.db._data.has('recordatoriosPago/beto'), false, 'a Beto ni se le intentó');
  // Dentro de la hora de espera no se reintenta
  m.control.resultado = null;
  m.t.ahora += 30 * 60000;
  assert.equal((await s.procesar()).enviados, 1, 'Beto sí sale (a él no se le había intentado); Ana espera su hora');
  assert.equal(m.db.value('recordatoriosPago/ana').paso, 0);
  m.t.ahora += 31 * 60000;
  assert.equal((await s.procesar()).enviados, 1, 'pasada la hora de espera, Ana recibe su correo');
  assert.equal(m.db.value('recordatoriosPago/ana').paso, 1);
  assert.equal(m.db.value('recordatoriosEstadisticas/dia-2026-10-22').enviados, 2, 'los fallos no cuentan para el tope');
  // Un error de red lanzado tampoco marca el paso
  const m2 = mundo({ seed: { 'members/ana': registrado(registro - 2 * DIA, { email: 'ana@example.com' }) } });
  activar(m2); m2.t.ahora = registro + 3 * HORA; m2.control.lanzar = true;
  const r2 = await m2.nuevo().procesar();
  assert.equal(r2.enviados, 0); assert.equal(m2.db.value('recordatoriosPago/ana').paso, 0);
});

test('reinicio a mitad de un envío: la reserva guarda el código; el reintento usa el MISMO código y la MISMA clave, sin crear otro cupón', async () => {
  const registro = mx(2026, 10, 22, 8);
  const prev = { ...R.normalizarEstado({ registroMs: registro }), ciclo: 1, paso: 1, enviados: 1, ultimoEnvioMs: registro + 12 * HORA };
  const m = mundo({ seed: { 'members/ana': registrado(registro, { email: 'ana@example.com' }), 'recordatoriosPago/ana': prev } });
  activar(m);
  const s = m.nuevo();
  m.t.ahora = prev.ultimoEnvioMs + 24 * HORA;
  m.control.lanzar = true;                                                 // el servidor «se cae» al llamar a Resend
  await s.procesar();
  const a = m.db.value('recordatoriosPago/ana');
  assert.equal(a.paso, 1, 'no se marcó como enviado');
  assert.equal(m.creados.codigos.length, 1);
  // Aun si la reserva quedara colgada (sin fallo registrado), la siguiente corrida la retoma con el mismo código
  m.db._data.set('recordatoriosPago/ana', { ...a, reserva: { ciclo: 1, paso: 2, token: 'tok', ms: m.t.ahora, codigo: 'FT50-ZZZZZZ', promoId: 'promo_1', venceMs: m.t.ahora + 24 * HORA }, fallos: 0, reintentarMs: 0 });
  m.control.lanzar = false;
  const nuevaInstancia = m.nuevo({ instancia: 'otra' });
  assert.equal((await nuevaInstancia.procesar()).enviados, 1);
  assert.equal(m.creados.codigos.length, 1, 'no se creó un segundo código');
  assert.equal(m.correos[0].idempotencyKey, 'fisioteck-recordatorio-ana-c1-p2');
  assert.ok(m.correos[0].html.includes('FT50-ZZZZZZ'), 'sale el código reservado');
  assert.equal(m.db.value('recordatoriosPago/ana').cuponCodigo, 'FT50-ZZZZZZ');
});

test('dos instancias a la vez: nunca mandan dos veces el mismo correo (arrendamiento y bloqueo por persona)', async () => {
  const seed = {};
  for (let i = 1; i <= 6; i++) seed['members/u' + i] = registrado(mx(2026, 10, 20, 8) + i, { email: `u${i}@example.com` });
  const m = mundo({ seed });
  activar(m);
  m.t.ahora = mx(2026, 10, 22, 12);
  m.db.lenta = true;                                                       // las lecturas tardan: dos solicitudes ven el mismo estado viejo
  const [a, b] = await Promise.all([m.nuevo({ instancia: 'A' }).procesar(), m.nuevo({ instancia: 'B' }).procesar()]);
  const total = (a.enviados || 0) + (b.enviados || 0);
  assert.equal(total, 6);
  assert.equal(m.correos.length, 6, 'cada persona recibió un solo correo');
  assert.equal(new Set(m.correos.map(c => c.para)).size, 6);
  assert.ok([a.omitido, b.omitido].includes('otra-instancia'), 'una de las dos cedió el paso');
});

test('arrendamiento ocupado por otra instancia: la corrida no hace nada', async () => {
  const m = mundo({ seed: { 'members/ana': registrado(mx(2026, 10, 20, 8), { email: 'ana@example.com' }) } });
  activar(m); m.t.ahora = mx(2026, 10, 22, 12);
  m.db._data.set('config/recordatoriosArrendamiento', { propietario: 'otra', venceMs: m.t.ahora + 5 * 60000, tomadoMs: m.t.ahora });
  assert.deepEqual(await m.nuevo({ instancia: 'yo' }).procesar(), { omitido: 'otra-instancia' });
  assert.equal(m.correos.length, 0);
  m.t.ahora += 6 * 60000;                                                   // venció
  assert.equal((await m.nuevo({ instancia: 'yo' }).procesar()).enviados, 1);
  assert.equal(m.db.value('config/recordatoriosArrendamiento').propietario, '', 'al terminar lo suelta');
});

test('baja y preferencia: quien se da de baja o dice no deja de recibir, para siempre', async () => {
  const m = mundo({ seed: { 'members/ana': registrado(mx(2026, 10, 20, 8), { email: 'ana@example.com' }), 'members/beto': registrado(mx(2026, 10, 20, 8), { email: 'beto@example.com' }) } });
  activar(m); m.t.ahora = mx(2026, 10, 22, 12);
  const s = m.nuevo();
  assert.equal(await s.darDeBaja('ana'), true);
  assert.equal(await s.darDeBaja('fantasma'), false, 'una cuenta que no existe no crea nada');
  assert.equal(m.db._data.has('recordatoriosPago/fantasma'), false);
  assert.equal((await s.procesar()).enviados, 1);
  assert.deepEqual(m.correos.map(c => c.para), ['beto@example.com']);
  assert.equal(m.db.value('recordatoriosEstadisticas/global').bajas, 1);
  await s.darDeBaja('ana');
  assert.equal(m.db.value('recordatoriosEstadisticas/global').bajas, 1, 'darse de baja dos veces no cuenta doble');
  assert.deepEqual(await s.leerPreferencia('ana'), { recibe: false, baja: true, optOut: false });
  // Preferencia desde el perfil
  assert.deepEqual(await s.fijarPreferencia('beto', false), { recibe: false, baja: false });
  assert.equal(m.db.value('recordatoriosPago/beto').optOutOrigen, 'perfil');
  m.t.ahora += 2 * DIA;
  assert.equal((await s.procesar()).enviados, 0, 'Beto dijo que no');
  assert.deepEqual(await s.fijarPreferencia('beto', true), { recibe: true, baja: false });
  assert.deepEqual(await s.fijarPreferencia('ana', true), { recibe: false, baja: true }, 'quien se dio de baja no vuelve');
  // La casilla al crear la cuenta
  await s.fijarPreferencia('nueva', false, 'registro');
  assert.equal(m.db.value('recordatoriosPago/nueva').optOutOrigen, 'registro');
});

test('cupón de la persona: desaparece al vencer, al darse de baja, al pagar y no se muestra a members ni a administradores', async () => {
  const registro = mx(2026, 10, 20, 8);
  const prev = R.estadoTrasEnviar({ registroMs: registro, ciclo: 1, paso: 1, enviados: 1 }, { ciclo: 1, paso: 2, ahoraMs: mx(2026, 10, 22, 12), codigo: 'FT50-AAAAAA', promoId: 'promo_1', venceMs: mx(2026, 10, 23, 12) });
  const m = mundo({ seed: { 'members/ana': registrado(registro, { email: 'ana@example.com' }), 'recordatoriosPago/ana': prev } });
  m.codigos.set('promo_1', { id: 'promo_1', active: true, times_redeemed: 0, max_redemptions: 1, expires_at: Math.floor(mx(2026, 10, 23, 12) / 1000), metadata: { marca: 'fisioteck' } });
  const s = m.nuevo();
  m.t.ahora = mx(2026, 10, 22, 18);
  const ana = m.db.value('members/ana');
  assert.ok(await s.miCupon('ana', ana));
  assert.equal(await s.miCupon('ana', { ...ana, planActivo: true }), null, 'un miembro no ve el cupón');
  assert.equal(await s.miCupon('ana', { ...ana, role: 'admin' }), null);
  assert.equal(await s.miCupon('ana', { ...ana, email: 'jefe@fisioteck.com' }), null);
  assert.equal(await s.miCupon('nadie', ana), null, 'quien no tiene estado no tiene cupón');
  // Stripe es la última palabra para el pago: si el código ya se usó, venció o es de otra marca, no se aplica
  assert.ok(await s.cuponParaCheckout('ana', ana));
  m.codigos.get('promo_1').times_redeemed = 1;
  assert.equal(await s.cuponParaCheckout('ana', ana), null, 'ya canjeado');
  m.codigos.get('promo_1').times_redeemed = 0; m.codigos.get('promo_1').active = false;
  assert.equal(await s.cuponParaCheckout('ana', ana), null, 'desactivado');
  m.codigos.get('promo_1').active = true; m.codigos.get('promo_1').metadata.marca = 'alintec';
  assert.equal(await s.cuponParaCheckout('ana', ana), null, 'de otra marca');
  m.codigos.get('promo_1').metadata.marca = 'fisioteck';
  m.t.ahora = mx(2026, 10, 23, 12) + 1;
  assert.equal(await s.miCupon('ana', ana), null, 'venció');
  m.t.ahora = mx(2026, 10, 22, 18);
  await s.darDeBaja('ana');
  assert.equal(await s.miCupon('ana', ana), null);
});

test('pago: cierra la serie como convertida (con vuelta y paso), suma estadísticas y no cuenta dos veces; ignora otras marcas y pruebas', async () => {
  const registro = mx(2026, 10, 20, 8);
  const estado = R.estadoTrasEnviar({ registroMs: registro, ciclo: 2, paso: 3, enviados: 10 }, { ciclo: 2, paso: 4, ahoraMs: mx(2026, 10, 22, 12), codigo: 'FT50-AAAAAA', promoId: 'promo_1', venceMs: mx(2026, 10, 23, 12) });
  const m = mundo({ seed: { 'members/ana': registrado(registro), 'members/beto': registrado(registro), 'members/caro': registrado(registro), 'members/dani': registrado(registro),
    'recordatoriosPago/ana': estado, 'recordatoriosPago/beto': estado, 'recordatoriosPago/caro': estado } });
  const s = m.nuevo();
  const r = await s.registrarPago({ uid: 'ana', promoId: 'promo_1', codigo: 'FT50-AAAAAA', pasoCupon: 4, marca: 'fisioteck' });
  assert.deepEqual([r.cerrada, r.conCupon, r.paso, r.ciclo], [true, true, 4, 2]);
  const e = m.db.value('recordatoriosPago/ana');
  assert.equal(e.cerrada, 'convertida'); assert.deepEqual([e.conversion.ciclo, e.conversion.paso, e.conversion.codigo], [2, 4, 'FT50-AAAAAA']);
  const g = m.db.value('recordatoriosEstadisticas/global');
  assert.deepEqual([g.convertidas, g.pagosConCuponPaso.p4, g.pagosConCuponCiclo.c2, g.pagosTrasCorreoPaso.p4], [1, 1, 1, 1]);
  // Segunda notificación del mismo pago: no cuenta otra vez
  assert.equal((await s.registrarPago({ uid: 'ana', promoId: 'promo_1', marca: 'fisioteck' })).yaCerrada, true);
  assert.equal(m.db.value('recordatoriosEstadisticas/global').convertidas, 1);
  // Código de OTRA marca o de prueba: se cierra la serie (ya pagó) pero NO cuenta como conversión de estos correos
  const otra = await s.registrarPago({ uid: 'beto', promoId: 'promo_x', codigo: 'ALINTEC20', marca: 'alintec' });
  assert.deepEqual([otra.cerrada, otra.conCupon], [true, false]);
  const prueba = await s.registrarPago({ uid: 'caro', promoId: 'promo_p', codigo: 'FT50-PRUEBA', marca: 'fisioteck', prueba: true });
  assert.deepEqual([prueba.cerrada, prueba.conCupon], [true, false]);
  const g2 = m.db.value('recordatoriosEstadisticas/global');
  assert.equal(g2.convertidas, 1); assert.equal(g2.pagosSinCupon, 2);
  assert.equal(m.db.value('recordatoriosPago/beto').cerrada, 'pago');
  // Pagó sin ningún código
  const sin = await s.registrarPago({ uid: 'dani' });
  assert.deepEqual([sin.cerrada, sin.conCupon], [true, false]);
  assert.equal(m.db.value('recordatoriosPago/dani').cerrada, 'pago');
  // Cerradas: ya no reciben nada
  activar(m); m.t.ahora = mx(2026, 10, 30, 12);
  assert.equal((await s.procesar()).enviados, 0);
});

test('correo de prueba: va al correo pedido, con cupón REAL marcado como prueba, sin tocar estados ni estadísticas', async () => {
  const m = mundo({ seed: { 'members/ana': registrado(mx(2026, 10, 20, 8), { email: 'ana@example.com' }) } });
  const s = m.nuevo();
  const r = await s.enviarPrueba({ paso: 3, ciclo: 2, correo: 'jefe@fisioteck.com', nombre: 'Jorge' });
  assert.deepEqual([r.ciclo, r.paso], [2, 3]); assert.match(r.codigo, /^FT100-/);
  assert.equal(m.correos.length, 1);
  assert.equal(m.correos[0].para, 'jefe@fisioteck.com');
  assert.match(m.correos[0].asunto, /^\[PRUEBA\] /);
  const promo = m.creados.codigos[0];
  assert.equal(promo.metadata.prueba, 'si'); assert.equal(promo.metadata.uid, '');
  assert.equal(promo.max_redemptions, 1); assert.equal(promo.restrictions.first_time_transaction, true);
  assert.equal([...m.db._data.keys()].some(k => k.startsWith('recordatoriosPago/') || k.startsWith('recordatoriosEstadisticas/')), false);
  const p1 = await s.enviarPrueba({ paso: 1, correo: 'jefe@fisioteck.com' });
  assert.equal(p1.codigo, '');
  assert.equal(m.creados.codigos.length, 1, 'el paso 1 no crea cupón');
  await assert.rejects(() => s.enviarPrueba({ paso: 9, correo: 'jefe@fisioteck.com' }), /Paso inválido/);
  // Si el correo no está configurado, avisa con claridad
  m.control.ok = false;
  await assert.rejects(() => s.enviarPrueba({ paso: 2, correo: 'jefe@fisioteck.com' }), e => e.status === 502);
});

test('resumen y lista del panel: calificarían, próximos envíos, etapas, búsqueda y filtros', async () => {
  const registro = mx(2026, 10, 21, 8);
  const m = mundo({
    seed: {
      'members/ana': registrado(registro, { email: 'ana@example.com', name: 'Ana', trialCourseId: 1 }),
      'members/beto': registrado(registro + 1, { email: 'beto@example.com', name: 'Beto' }),
      'members/paga': registrado(registro, { email: 'paga@example.com', lastPaymentDate: '2026-10-01' }),
      'members/admin': registrado(registro, { email: 'jefe@fisioteck.com' }),
      'members/baja': registrado(registro, { email: 'baja@example.com' }),
      'recordatoriosPago/baja': { baja: true }
    }
  });
  m.t.ahora = mx(2026, 10, 22, 12);
  const s = m.nuevo();
  const res = await s.resumen();
  assert.equal(res.modo, 'apagado'); assert.equal(res.calificarian, 2);
  assert.equal(res.dentroDeHorario, true);
  assert.equal(res.proximos.length, 2); assert.equal(res.primerEnvioMs, m.t.ahora, 'ya les tocaba: sale en la próxima revisión, no en una fecha pasada');
  assert.ok(res.proximos.every(p => p.saleMs <= m.t.ahora));
  assert.equal(res.serie.length, 7); assert.equal(res.maxCiclos, 3); assert.equal(res.descansoDias, 4);
  assert.equal(res.conteo.baja, 1);
  assert.equal(res.estadisticas.enviadosPaso.p7, 0);
  const todos = await s.listado();
  assert.equal(todos.total, 4, 'el administrador no aparece');
  assert.ok(!todos.items.some(i => i.correo === 'jefe@fisioteck.com'));
  const ana = todos.items.find(i => i.correo === 'ana@example.com');
  assert.deepEqual([ana.etapa, ana.cursoPrueba, ana.proximoPaso, ana.proximoCiclo], ['en-espera', 'Manejo de reptiles', 1, 1]);
  assert.equal((await s.listado({ etapa: 'baja' })).total, 1);
  assert.equal((await s.listado({ q: 'BETO' })).total, 1);
  assert.equal((await s.listado({ q: 'nadie' })).total, 0);
  assert.equal((await s.listado({ etapa: 'pago' })).total, 1);
  assert.equal((await s.listado({ porPagina: 1 })).hayMas, true);
  assert.ok(s.ETAPAS.includes('descanso') && s.ETAPAS.includes('cupon-vigente'));
  assert.equal(res.listasAhora, 2); assert.deepEqual(res.recientes, []);
  assert.equal((await s.listado({ etapa: 'listas-ahora' })).total, 2);
  assert.equal((await s.listado({ etapa: 'programadas' })).total, 0);
  // Después de enviar el primer correo, aparecen en «Últimos correos enviados» y pasan a «programadas»
  activar(m);
  await s.procesar();
  const despues = await s.resumen();
  assert.equal(despues.recientes.length, 2); assert.deepEqual([despues.recientes[0].ciclo, despues.recientes[0].paso], [1, 1]);
  assert.ok(despues.recientes[0].enviadoMs >= despues.recientes[1].enviadoMs);
  assert.equal((await s.listado({ etapa: 'programadas' })).total, 2); assert.equal((await s.listado({ etapa: 'listas-ahora' })).total, 0);
});

test('interruptor: fijarModo valida y guarda quién lo cambió', async () => {
  const m = mundo();
  const s = m.nuevo();
  assert.equal((await s.fijarModo('activo', 'jefe@fisioteck.com')).modo, 'activo');
  assert.equal(m.db.value('config/recordatorios').actualizadoPor, 'jefe@fisioteck.com');
  assert.equal((await s.fijarModo('apagado')).modo, 'apagado');
  await assert.rejects(() => s.fijarModo('encendido'), /Modo inválido/);
});

test('cupones base de Stripe: ID fijo, idempotentes y sin tocar los de otra marca', async () => {
  const m = mundo();
  const s = m.nuevo();
  assert.equal(ID_CUPON(50), 'FISIOTECK_RECORDATORIO_50');
  await s.asegurarCuponBase(50); await s.asegurarCuponBase(50);
  assert.equal(m.creados.cupones.length, 1, 'se crea una sola vez');
  const m2 = mundo();
  m2.cupones.set('FISIOTECK_RECORDATORIO_100', { id: 'FISIOTECK_RECORDATORIO_100', metadata: { marca: 'alintec' } });
  await assert.rejects(() => m2.nuevo().asegurarCuponBase(100), /otra marca/);
  // Si dos servidores lo crean a la vez y Stripe dice «ya existe», sigue adelante
  const m3 = mundo();
  const original = m3.stripe.coupons.create;
  m3.stripe.coupons.create = async d => { await original(d); throw new Error('Coupon already exists'); };
  assert.equal(await m3.nuevo().asegurarCuponBase(50), 'FISIOTECK_RECORDATORIO_50');
  // Códigos duplicados: reintenta con otro
  const m4 = mundo();
  let primera = true; const crear = m4.stripe.promotionCodes.create;
  m4.stripe.promotionCodes.create = async d => { if (primera) { primera = false; throw new Error('Promotion code already exists'); } return crear(d); };
  const c = await m4.nuevo().crearCodigo({ monto: 50, uid: 'ana', paso: 2, venceMs: Date.now() + DIA });
  assert.match(c.codigo, /^FT50-/);
});
