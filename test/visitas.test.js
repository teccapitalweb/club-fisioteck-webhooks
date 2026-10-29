'use strict';
// MÉTRICAS DE VISITAS (como Alintec): dispositivo, país, origen (Facebook, Instagram…), personas distintas, hora y miembros.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./helpers/fake-firestore');
const V = require('../services/visitas');

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const UA_MOVIL = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const UA_IG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0';
const UA_FB = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 [FBAN/FB4A;FBAV/450.0]';
const FV = { serverTimestamp: () => 'ts' };

test('dispositivo: móvil, tablet o computadora; los bots no cuentan', () => {
  assert.equal(V.dispositivoDe(UA_PC), 'computadora');
  assert.equal(V.dispositivoDe(UA_MOVIL), 'movil');
  assert.equal(V.dispositivoDe('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'tablet');
  assert.equal(V.esBot('Googlebot/2.1 (+http://www.google.com/bot.html)'), true);
  assert.equal(V.esBot(''), true);
  assert.equal(V.esBot(UA_PC), false);
});

test('origen: utm, página que enlazó, app de red social, pistas de Meta y directo', () => {
  assert.equal(V.fuenteDe('', 'ig', UA_PC), 'instagram');
  assert.equal(V.fuenteDe('', 'facebook_ads', UA_PC), 'facebook');
  assert.equal(V.fuenteDe('https://l.facebook.com/l.php?u=x', '', UA_PC), 'facebook');
  assert.equal(V.fuenteDe('https://www.google.com/', '', UA_PC), 'google');
  assert.equal(V.fuenteDe('', '', UA_IG), 'instagram');
  assert.equal(V.fuenteDe('', '', UA_FB), 'facebook');
  assert.equal(V.fuenteDe('', '', UA_PC, { igshid: true }), 'instagram');
  assert.equal(V.fuenteDe('', '', UA_PC, { fbclid: true }), 'meta');
  assert.equal(V.fuenteDe('android-app://com.whatsapp', '', UA_PC), 'whatsapp');
  assert.equal(V.fuenteDe('https://www.fisioteck.com/', '', UA_PC), 'interno');
  assert.equal(V.fuenteDe('', '', UA_PC), 'directo');
  assert.equal(V.fuenteDe('https://blog.ejemplo.com/', '', UA_PC), 'otros');
});

test('país: se detecta por IP y solo se guarda el código; IP privada o inválida = ZZ', () => {
  assert.equal(V.paisDeIp('189.203.10.5'), 'MX');
  assert.equal(V.paisDeIp('8.8.8.8'), 'US');
  assert.equal(V.paisDeIp('10.0.0.4'), 'ZZ');
  assert.equal(V.paisDeIp(''), 'ZZ');
  assert.equal(V.ipDeSolicitud({ 'x-forwarded-for': '10.0.0.1, 189.203.10.5' }, '::1'), '189.203.10.5');
});

test('registrar y leer: visitas, personas distintas, dispositivo, país, origen y hora se cuentan por persona', async () => {
  const db = new FakeFirestore({});
  const ahora = new Date('2026-10-22T18:30:00Z'); // 12:30 en México
  const base = { ahora, secreto: 'k', pagina: 'landing', ip: '189.203.10.5', pais: 'MX', userAgent: UA_MOVIL, referrer: 'https://l.facebook.com/', utm: '' };
  const r1 = await V.registrarVisita(db, FV, base);
  assert.deepEqual([r1.contada, r1.nuevoVisitante], [true, true]);
  const r2 = await V.registrarVisita(db, FV, { ...base, pagina: 'acceso' });
  assert.equal(r2.nuevoVisitante, false, 'la misma persona el mismo día no suma como distinta');
  await V.registrarVisita(db, FV, { ...base, ip: '8.8.8.8', pais: 'US', userAgent: UA_PC, referrer: '', utm: 'instagram' });
  assert.equal((await V.registrarVisita(db, FV, { ...base, userAgent: 'Googlebot/2.1' })).contada, false, 'bot');
  assert.equal((await V.registrarVisita(db, FV, { ...base, pagina: 'inventada' })).contada, false, 'página desconocida');

  const m = await V.leerMetricas(db, { hoy: '2026-10-22', dias: 7 });
  const hoy = m.dias[m.dias.length - 1];
  assert.equal(hoy.dia, '2026-10-22');
  assert.deepEqual([hoy.total, hoy.unicos], [3, 2]);
  assert.deepEqual([hoy.dispositivos.movil, hoy.dispositivos.computadora], [1, 1]);
  assert.deepEqual([hoy.paises.MX, hoy.paises.US], [1, 1]);
  assert.deepEqual([hoy.fuentes.facebook, hoy.fuentes.instagram], [1, 1]);
  assert.equal(hoy.horas['12'], 3);
  assert.deepEqual([hoy.paginas.landing, hoy.paginas.acceso], [2, 1]);
  assert.equal(m.dias.length, 7); assert.equal(m.dias[0].total, 0, 'los días sin visitas salen en cero');
  assert.equal(m.recientes.length, 3);
  assert.equal(JSON.stringify(m).includes('189.203'), false, 'nunca se guarda la IP');

  const log = await V.leerRegistroVisitas(db, { periodo: 'hoy', hoy: '2026-10-22' });
  assert.equal(log.total, 3); assert.equal(log.items[0].pais !== undefined, true);
});

test('miembros: se registra su actividad y de dónde llegó la cuenta; la regla de membresía la pone el servidor', async () => {
  const db = new FakeFirestore({ 'members/u1': { status: 'active' } });
  const creadaMs = Date.parse('2026-10-22T18:00:00Z');
  await V.registrarVisita(db, FV, {
    ahora: new Date('2026-10-22T18:30:00Z'), secreto: 'k', pagina: 'club', ip: '189.203.10.5', pais: 'MX', userAgent: UA_MOVIL, referrer: '', utm: '',
    miembro: { uid: 'u1', email: 'a@b.com', nombre: 'Ana' },
    origen: { ref: 'https://l.facebook.com/', utm: '', ua: UA_MOVIL, t: Date.parse('2026-10-22T17:50:00Z') },
    obtenerCreada: async () => creadaMs
  });
  const m = await V.leerMetricas(db, { hoy: '2026-10-22', dias: 7 }, { esMiembro: x => x.status === 'active' });
  assert.equal(m.dias[m.dias.length - 1].miembros, 1);
  assert.equal(m.miembros[0].email, 'a@b.com');
  assert.deepEqual(m.origenes.map(o => [o.origen, o.vip]), [['facebook', true]]);
  assert.equal(V.origenDeCuenta({ ref: '', utm: 'ig', ua: UA_PC, t: creadaMs + 3600000 * 5 }, creadaMs), 'sin_dato', 'un origen posterior a la cuenta no se atribuye');
});
