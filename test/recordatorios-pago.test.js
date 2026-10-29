'use strict';

// RECORDATORIOS DE PAGO · reglas puras y textos de los correos.
// La serie es la de Alintec: 7 correos por vuelta, descanso de 4 días, máximo 3 vueltas. Todo sale entre 8:00 y 22:00 de Ciudad de México.
// Ejecutar: node --test test/recordatorios-pago.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../services/recordatorios-pago');
const C = require('../services/recordatorios-correo');

const { HORA, DIA } = R;
// Un instante en hora de México (UTC-6 todo el año desde 2022)
const mx = (anio, mes, dia, h = 12, min = 0) => Date.UTC(anio, mes - 1, dia, h + 6, min);
const miembroNuevo = (extra = {}) => ({ email: 'ana@example.com', name: 'Ana Pérez', role: 'member', planActivo: false, planTipo: null, planInicio: null, ...extra });

// Avanza a una persona por toda la serie enviando cada correo EXACTAMENTE cuando le toca. Devuelve la lista de envíos.
function recorrer(registroMs, { hasta = Infinity, baja = false } = {}) {
  let estado = R.normalizarEstado({ registroMs });
  const envios = [];
  for (let i = 0; i < 40 && envios.length < hasta; i++) {
    const s = R.siguienteEnvio(estado, registroMs);
    if (!s) break;
    const monto = s.monto;
    estado = R.estadoTrasEnviar(estado, { ciclo: s.ciclo, paso: s.paso, ahoraMs: s.saleMs, codigo: monto ? 'FT' + monto + '-XXXXXX' : '', promoId: monto ? 'promo_x' : '', venceMs: monto ? s.saleMs + R.CONFIG.vigenciaCuponMs : 0 });
    envios.push({ ...s, estado });
  }
  void baja;
  return { envios, estado };
}

test('la serie: 7 pasos, montos 0/50/100/50/100/50/100, 3 vueltas y descanso de 4 días en UNA constante', () => {
  assert.equal(R.PASOS_TOTALES, 7);
  assert.deepEqual(R.SERIE.map(s => s.monto), [0, 50, 100, 50, 100, 50, 100]);
  assert.deepEqual(R.SERIE.map(s => s.paso), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(R.CONFIG.maxCiclos, 3);
  assert.equal(R.CONFIG.descansoMs, 4 * DIA);
  assert.equal(R.CONFIG.vigenciaCuponMs, 24 * HORA);
  assert.deepEqual(R.MONTOS, [50, 100]);
  assert.equal(R.SERIE[0].esperaMs, 12 * HORA);
  assert.equal(R.SERIE[1].esperaMs, 24 * HORA);
  for (const s of R.SERIE.slice(2)) { assert.equal(s.desde, 'vencimiento'); assert.equal(s.esperaMs, 12 * HORA); }
  assert.ok(Object.isFrozen(R.SERIE) && Object.isFrozen(R.CONFIG));
});

test('horario: de 8:00 a 22:00 de Ciudad de México; antes sale al abrir, después, al día siguiente', () => {
  assert.equal(R.dentroDeHorario(mx(2026, 10, 22, 7, 59)), false);
  assert.equal(R.dentroDeHorario(mx(2026, 10, 22, 8, 0)), true);
  assert.equal(R.dentroDeHorario(mx(2026, 10, 22, 21, 59)), true);
  assert.equal(R.dentroDeHorario(mx(2026, 10, 22, 22, 0)), false);
  assert.equal(R.ajustarAHorario(mx(2026, 10, 22, 5, 30)), mx(2026, 10, 22, 8, 0), 'antes de abrir: hoy a las 8');
  assert.equal(R.ajustarAHorario(mx(2026, 10, 22, 23, 15)), mx(2026, 10, 23, 8, 0), 'después de cerrar: mañana a las 8');
  assert.equal(R.ajustarAHorario(mx(2026, 10, 22, 22, 0)), mx(2026, 10, 23, 8, 0));
  assert.equal(R.ajustarAHorario(mx(2026, 10, 22, 13, 20)), mx(2026, 10, 22, 13, 20), 'dentro del horario no se mueve');
});

test('horario: cruces de día, de mes y de año, y verano e invierno caen a las 8:00 en punto', () => {
  assert.equal(R.ajustarAHorario(mx(2026, 12, 31, 22, 30)), mx(2027, 1, 1, 8, 0));
  assert.equal(R.ajustarAHorario(mx(2026, 2, 28, 23, 59)), mx(2026, 3, 1, 8, 0));
  for (const [a, m, d] of [[2026, 1, 15], [2026, 7, 15], [2026, 4, 5], [2026, 10, 25], [2026, 3, 8]]) {
    const ms = R.ajustarAHorario(mx(a, m, d, 23, 0));
    const p = R.partesMexico(ms);
    assert.equal(p.hora, 8, `${a}-${m}-${d}`); assert.equal(p.minuto, 0);
  }
  assert.equal(R.diaMexico(mx(2026, 10, 22, 23, 30)), '2026-10-22', 'a las 23:30 de México ya es otro día en UTC, pero sigue siendo el 22');
  assert.equal(R.diaMexico(mx(2026, 10, 22, 0, 5)), '2026-10-22');
  assert.equal(R.ajustarAHorario(NaN) !== R.ajustarAHorario(NaN), true, 'un valor inválido no se inventa una hora');
});

test('elegibilidad: solo quien NUNCA pagó, con correo, sin baja y con la serie abierta', () => {
  const ok = R.elegibilidad({ miembro: miembroNuevo(), cuenta: { emailVerified: true, disabled: false } });
  assert.deepEqual(ok, { ok: true, motivo: '' });
  const motivo = (miembro, extra = {}) => R.elegibilidad({ miembro, cuenta: { emailVerified: true }, ...extra }).motivo;
  assert.equal(motivo(null), 'sin-registro');
  assert.equal(motivo(miembroNuevo({ email: '' })), 'sin-correo');
  assert.equal(motivo(miembroNuevo({ role: 'admin' })), 'admin');
  assert.equal(motivo(miembroNuevo({ email: 'Jefe@FisioTeck.com' }), { correosAdmin: ['jefe@fisioteck.com'] }), 'admin', 'administradores por correo, sin importar mayúsculas');
  assert.equal(motivo(miembroNuevo({ status: 'active' })), 'ya-pago', 'ya tuvo un plan alguna vez');
  assert.equal(motivo(miembroNuevo({ lastPaymentDate: '2026-10-01' })), 'ya-pago');
  assert.equal(motivo(miembroNuevo({ planTipo: 'regalo' })), 'ya-pago');
  assert.equal(motivo(miembroNuevo(), { tieneAcceso: () => true }), 'membresia');
  assert.equal(motivo(miembroNuevo(), { estado: { baja: true } }), 'baja');
  assert.equal(motivo(miembroNuevo(), { estado: { optOut: true } }), 'no-quiere');
  assert.equal(motivo(miembroNuevo(), { estado: { cerrada: 'convertida' } }), 'convertida');
  assert.equal(motivo(miembroNuevo(), { estado: { cerrada: 'pago' } }), 'ya-pago');
  assert.equal(motivo(miembroNuevo(), { estado: { finalizado: true, ciclo: 3, paso: 7, enviados: 21 } }), 'serie-cerrada');
  assert.equal(R.elegibilidad({ miembro: miembroNuevo(), cuenta: { emailVerified: false } }).motivo, 'correo-sin-verificar');
  assert.equal(R.elegibilidad({ miembro: miembroNuevo(), cuenta: { emailVerified: true, disabled: true } }).motivo, 'cuenta-deshabilitada');
  // Sin consultar a Firebase Auth todavía (cuenta null): solo se aplican las reglas locales
  assert.equal(R.elegibilidad({ miembro: miembroNuevo(), cuenta: null }).ok, true);
});

test('calendario del primer correo: 12 h después de registrarse (y si cae de noche, a las 8:00)', () => {
  const registro = mx(2026, 10, 22, 10, 0);
  const s = R.siguienteEnvio({}, registro);
  assert.deepEqual([s.ciclo, s.paso, s.monto], [1, 1, 0]);
  assert.equal(s.debeSalirMs, registro + 12 * HORA);
  assert.equal(s.saleMs, mx(2026, 10, 23, 8, 0), '10:00 + 12 h = 22:00, ya cerró: sale al día siguiente a las 8:00');
  const tarde = mx(2026, 10, 22, 21, 0);        // 21:00 + 12 h = 9:00 del día siguiente: dentro del horario
  assert.equal(R.siguienteEnvio({}, tarde).saleMs, tarde + 12 * HORA);
  assert.equal(R.siguienteEnvio({}, 0), null, 'sin fecha de registro no se programa');
});

test('calendario completo: 1 sin cupón, 2 a las 24 h, 3 a 7 doce horas después de vencer el cupón anterior', () => {
  const registro = mx(2026, 10, 22, 8, 0);
  const { envios } = recorrer(registro, { hasta: 7 });
  assert.equal(envios.length, 7);
  assert.deepEqual(envios.map(e => e.paso), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(envios.map(e => e.monto), [0, 50, 100, 50, 100, 50, 100]);
  for (const e of envios) assert.equal(e.ciclo, 1);
  // Mientras no haya ajuste de horario, las horas son exactas
  assert.equal(envios[0].debeSalirMs, registro + 12 * HORA);
  assert.equal(envios[1].debeSalirMs, envios[0].estado.ultimoEnvioMs + 24 * HORA);
  for (let i = 2; i < 7; i++) {
    const anterior = envios[i - 1].estado;
    assert.equal(envios[i].debeSalirMs, anterior.cuponVenceMs + 12 * HORA, 'paso ' + (i + 1) + ': 12 h después de que venció el cupón anterior');
  }
  for (const e of envios) assert.ok(R.dentroDeHorario(e.saleMs), 'todo sale dentro del horario');
  // El cupón del paso 1 no existe; los demás duran 24 h desde que sale el correo
  assert.equal(envios[0].estado.cuponCodigo, '');
  assert.equal(envios[1].estado.cuponVenceMs, envios[1].estado.ultimoEnvioMs + 24 * HORA);
});

test('descanso de 4 días tras vencer el cupón del paso 7; el paso 1 se repite en las vueltas 2 y 3', () => {
  const registro = mx(2026, 10, 22, 8, 0);
  const { envios } = recorrer(registro);
  assert.equal(envios.length, 21, '3 vueltas de 7 correos');
  const vuelta = n => envios.filter(e => e.ciclo === n);
  assert.deepEqual(vuelta(1).map(e => e.paso), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(vuelta(2).map(e => e.paso), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(vuelta(3).map(e => e.paso), [1, 2, 3, 4, 5, 6, 7]);
  const ultimo1 = vuelta(1)[6]; const primero2 = vuelta(2)[0];
  assert.equal(primero2.debeSalirMs, ultimo1.estado.cuponVenceMs + 4 * DIA, 'descanso de 4 días desde que venció el cupón del paso 7');
  assert.equal(primero2.monto, 0, 'el paso 1 de la vuelta 2 vuelve a ser sin cupón');
  const ultimo2 = vuelta(2)[6]; const primero3 = vuelta(3)[0];
  assert.equal(primero3.debeSalirMs, ultimo2.estado.cuponVenceMs + 4 * DIA);
  // En la vuelta 2 el paso 2 sale 24 h después del paso 1 de esa vuelta (igual que en la 1)
  assert.equal(vuelta(2)[1].debeSalirMs, vuelta(2)[0].estado.ultimoEnvioMs + 24 * HORA);
});

test('máximo 3 vueltas: el último correo de la tercera cierra la serie para siempre', () => {
  const { envios, estado } = recorrer(mx(2026, 10, 22, 8, 0));
  const ultimo = envios[envios.length - 1];
  assert.deepEqual([ultimo.ciclo, ultimo.paso], [3, 7]);
  assert.equal(estado.finalizado, true);
  assert.equal(R.serieTerminada(estado), true);
  assert.equal(R.siguienteEnvio(estado, 1), null);
  assert.equal(R.posicionSiguiente(estado), null);
  assert.equal(R.tocaAhora(estado, 1, mx(2027, 5, 1, 12)), null);
  assert.equal(R.etapaDe({ estado, ahoraMs: mx(2030, 1, 1) }).etapa, 'cerrada');
  // Antes del último correo todavía no está terminada
  assert.equal(R.serieTerminada(envios[envios.length - 2].estado), false);
  assert.equal(envios.filter(e => e.estado.finalizado).length, 1, 'solo el último correo marca el cierre');
  assert.ok(envios.filter(e => e.ciclo === 1 || e.ciclo === 2).every(e => !e.estado.finalizado));
});

test('posicionSiguiente: sin horas, solo el lugar que toca', () => {
  assert.deepEqual(R.posicionSiguiente({}), { ciclo: 1, paso: 1 });
  assert.deepEqual(R.posicionSiguiente({ ciclo: 1, paso: 3, enviados: 3 }), { ciclo: 1, paso: 4 });
  assert.deepEqual(R.posicionSiguiente({ ciclo: 1, paso: 7, enviados: 7 }), { ciclo: 2, paso: 1 });
  assert.deepEqual(R.posicionSiguiente({ ciclo: 2, paso: 7, enviados: 14 }), { ciclo: 3, paso: 1 });
  assert.equal(R.posicionSiguiente({ ciclo: 3, paso: 7, enviados: 21 }), null);
  assert.equal(R.posicionSiguiente({ baja: true }), null);
  assert.equal(R.posicionSiguiente({ cerrada: 'convertida' }), null);
  assert.equal(R.posicionSiguiente({ optOut: true }), null);
});

test('tocaAhora: solo si ya llegó la hora, estamos en horario y no hay espera por un fallo', () => {
  const registro = mx(2026, 10, 22, 8, 0);
  const sale = registro + 12 * HORA;                          // 20:00, dentro de horario
  assert.equal(R.tocaAhora({}, registro, sale - 1), null);
  assert.deepEqual(R.tocaAhora({}, registro, sale) && [R.tocaAhora({}, registro, sale).ciclo, R.tocaAhora({}, registro, sale).paso], [1, 1]);
  // Ya tocaba pero son las 23:00: espera a abrir
  assert.equal(R.tocaAhora({}, registro, mx(2026, 10, 22, 23, 0)), null);
  assert.ok(R.tocaAhora({}, registro, mx(2026, 10, 23, 8, 0)), 'al abrir al día siguiente, sale');
  // Fallo reciente: se espera
  const fallado = R.estadoTrasFallo({ registroMs: registro }, { ahoraMs: sale, mensaje: 'Resend 429' });
  assert.equal(R.tocaAhora(fallado, registro, sale + 10 * 60000), null);
  assert.ok(R.tocaAhora(fallado, registro, sale + R.CONFIG.esperaTrasFalloMs + 1));
  // Demasiados fallos seguidos: se detiene hasta que alguien lo revise
  assert.equal(R.tocaAhora({ registroMs: registro, fallos: R.CONFIG.maxFallosSeguidos }, registro, sale + 5 * DIA), null);
});

test('un fallo NO marca el paso como enviado; un envío limpia reserva y fallos', () => {
  const base = R.estadoTrasReservar({ registroMs: 5 }, { ciclo: 1, paso: 1, token: 'abc', ahoraMs: 100 });
  assert.deepEqual([base.reserva.ciclo, base.reserva.paso, base.reserva.token], [1, 1, 'abc']);
  const fallo = R.estadoTrasFallo(base, { ahoraMs: 200, mensaje: 'x'.repeat(500) });
  assert.equal(fallo.paso, 0); assert.equal(fallo.enviados, 0); assert.equal(fallo.reserva, null);
  assert.equal(fallo.fallos, 1); assert.equal(fallo.ultimoError.length, 120);
  const enviado = R.estadoTrasEnviar(fallo, { ciclo: 1, paso: 1, ahoraMs: 300 });
  assert.equal(enviado.paso, 1); assert.equal(enviado.enviados, 1); assert.equal(enviado.fallos, 0); assert.equal(enviado.reintentarMs, 0); assert.equal(enviado.ultimoError, '');
  assert.equal(R.reservaPerdida(base, 100 + R.CONFIG.reservaPersonaMs - 1), false);
  assert.equal(R.reservaPerdida(base, 100 + R.CONFIG.reservaPersonaMs), true);
  assert.equal(R.reservaPerdida({}, 1e15), false);
});

test('cupón vigente: dura 24 h, es solo de quien nunca pagó y desaparece con baja, pago o fin de plazo', () => {
  const ahora = mx(2026, 10, 22, 12);
  const estado = R.estadoTrasEnviar({}, { ciclo: 2, paso: 3, ahoraMs: ahora, codigo: 'FT100-ABC234', promoId: 'promo_1', venceMs: ahora + 24 * HORA });
  const c = R.cuponVigente(estado, { ahoraMs: ahora + 5 * HORA, precioMes: 249 });
  assert.equal(c.codigo, 'FT100-ABC234'); assert.equal(c.monto, 100); assert.equal(c.precioFinal, 149); assert.equal(c.precioMes, 249);
  assert.equal(c.restanteMs, 19 * HORA); assert.equal(c.ciclo, 2); assert.equal(c.paso, 3); assert.equal(c.promoId, 'promo_1');
  assert.equal(R.cuponVigente(estado, { ahoraMs: ahora + 24 * HORA }), null, 'venció');
  assert.equal(R.cuponVigente({ ...estado, baja: true }, { ahoraMs: ahora }), null);
  assert.equal(R.cuponVigente({ ...estado, optOut: true }, { ahoraMs: ahora }), null, 'quien dijo no a las promociones no ve la barra de cupón');
  assert.equal(R.cuponVigente({ ...estado, cerrada: 'pago' }, { ahoraMs: ahora }), null);
  assert.equal(R.cuponVigente({}, { ahoraMs: ahora }), null);
  assert.equal(R.cuponVigente(estado, { ahoraMs: ahora, miembro: miembroNuevo({ role: 'admin' }) }), null, 'el administrador no ve cupón');
  assert.equal(R.cuponVigente(estado, { ahoraMs: ahora, miembro: miembroNuevo(), correosAdmin: ['ana@example.com'] }), null);
  assert.equal(R.cuponVigente(estado, { ahoraMs: ahora, miembro: miembroNuevo(), tieneAcceso: () => true }), null, 'un miembro no ve cupón');
  assert.equal(R.cuponVigente(estado, { ahoraMs: ahora, miembro: miembroNuevo({ lastPaymentDate: '2026-10-01' }) }), null, 'quien ya pagó alguna vez no ve cupón');
  assert.ok(R.cuponVigente(estado, { ahoraMs: ahora, miembro: miembroNuevo() }));
  // El paso 1 de cualquier vuelta no deja cupón
  assert.equal(R.cuponVigente(R.estadoTrasEnviar(estado, { ciclo: 3, paso: 1, ahoraMs: ahora + 9 * DIA }), { ahoraMs: ahora + 9 * DIA }), null);
});

test('baja y preferencia: la baja es definitiva; quien dijo no no vuelve a un sí por accidente', () => {
  const baja = R.estadoTrasBaja({ paso: 2, enviados: 2 }, { ahoraMs: 50 });
  assert.equal(baja.baja, true); assert.equal(baja.bajaMs, 50);
  assert.equal(R.siguienteEnvio(baja, 1), null);
  assert.equal(R.etapaDe({ estado: baja, ahoraMs: 60 }).etapa, 'baja');
  const quiereDeNuevo = R.estadoTrasPreferencia(baja, { quiere: true, ahoraMs: 70 });
  assert.equal(quiereDeNuevo.baja, true); assert.equal(quiereDeNuevo.optOut, true, 'quien se dio de baja no vuelve a recibir promociones aunque marque «sí»');
  const no = R.estadoTrasPreferencia({}, { quiere: false, ahoraMs: 80, origen: 'registro' });
  assert.deepEqual([no.optOut, no.optOutOrigen, no.optOutMs], [true, 'registro', 80]);
  assert.equal(R.siguienteEnvio(no, 1), null);
  const si = R.estadoTrasPreferencia(no, { quiere: true, ahoraMs: 90 });
  assert.deepEqual([si.optOut, si.optOutOrigen], [false, '']);
  assert.equal(R.estadoTrasPreferencia({}, { quiere: false, ahoraMs: 1, origen: 'otro' }).optOutOrigen, 'perfil');
});

test('pago: cierra la serie como convertida (con su vuelta y paso) o como pago sin cupón', () => {
  const e = R.estadoTrasEnviar({}, { ciclo: 2, paso: 4, ahoraMs: 10, codigo: 'FT50-AAAAAA', promoId: 'p', venceMs: 10 + 24 * HORA });
  const conv = R.estadoTrasPago(e, { ahoraMs: 20, conCupon: true });
  assert.equal(conv.cerrada, 'convertida');
  assert.deepEqual([conv.conversion.ciclo, conv.conversion.paso, conv.conversion.codigo, conv.conversion.conCupon], [2, 4, 'FT50-AAAAAA', true]);
  assert.equal(R.siguienteEnvio(conv, 1), null);
  const sin = R.estadoTrasPago(e, { ahoraMs: 20, conCupon: false });
  assert.equal(sin.cerrada, 'pago'); assert.equal(sin.conversion.conCupon, false); assert.equal(sin.conversion.codigo, '');
  assert.equal(R.etapaDe({ estado: conv, ahoraMs: 30 }).etapa, 'convertida');
  assert.equal(R.etapaDe({ estado: sin, ahoraMs: 30 }).etapa, 'pago');
});

test('etapas del panel: en espera, enviado, cupón vigente, descanso, cerrada, baja, convertida', () => {
  const ahora = mx(2026, 10, 22, 12);
  assert.equal(R.etapaDe({ estado: {}, ahoraMs: ahora, registroMs: 5 }).etapa, 'en-espera');
  const vigente = R.estadoTrasEnviar({}, { ciclo: 1, paso: 2, ahoraMs: ahora, codigo: 'FT50-X', venceMs: ahora + 24 * HORA });
  assert.equal(R.etapaDe({ estado: vigente, ahoraMs: ahora + HORA }).etapa, 'cupon-vigente');
  assert.equal(R.etapaDe({ estado: vigente, ahoraMs: ahora + 25 * HORA }).etapa, 'enviado');
  const finDeVuelta = R.estadoTrasEnviar({ ciclo: 1 }, { ciclo: 1, paso: 7, ahoraMs: ahora, codigo: 'FT100-X', venceMs: ahora + 24 * HORA });
  assert.equal(R.etapaDe({ estado: finDeVuelta, ahoraMs: ahora + 30 * HORA }).etapa, 'descanso');
  assert.match(R.etapaDe({ estado: finDeVuelta, ahoraMs: ahora + 30 * HORA }).texto, /ciclo 2/);
  assert.equal(R.etapaDe({ estado: {}, motivoNoElegible: 'correo-sin-verificar', ahoraMs: ahora }).etapa, 'sin-verificar');
  assert.equal(R.etapaDe({ estado: {}, motivoNoElegible: 'admin', ahoraMs: ahora }).etapa, 'excluida');
  assert.equal(R.etapaDe({ estado: {}, motivoNoElegible: 'ya-pago', ahoraMs: ahora }).etapa, 'pago');
  assert.equal(R.etapaDe({ estado: { optOut: true }, ahoraMs: ahora }).etapa, 'baja');
});

test('estado: se normaliza con datos raros y nunca pasa de la vuelta 3 ni del paso 7', () => {
  const e = R.normalizarEstado({ ciclo: 99, paso: 99, enviados: -4, cuponCodigo: 5, cerrada: 'rara', reserva: { paso: 2, ciclo: 9, token: 'x'.repeat(200) }, ultimoError: 'e'.repeat(300) });
  assert.equal(e.ciclo, 3); assert.equal(e.paso, 7); assert.equal(e.enviados, 0); assert.equal(e.cuponCodigo, ''); assert.equal(e.cerrada, '');
  assert.equal(e.reserva.ciclo, 3); assert.equal(e.reserva.token.length, 64); assert.equal(e.ultimoError.length, 120);
  assert.equal(R.normalizarEstado(null).ciclo, 1);
  assert.equal(R.normalizarEstado('texto').paso, 0);
});

test('topes: apagado por defecto; 60 al día y 25 por corrida (configurables, con máximos)', () => {
  assert.deepEqual(R.normalizarConfig(null), { modo: 'apagado', topeDiario: 60, maxPorCorrida: 25 });
  assert.deepEqual(R.normalizarConfig({ modo: 'activo', topeDiario: 100, maxPorCorrida: 10 }), { modo: 'activo', topeDiario: 100, maxPorCorrida: 10 });
  assert.equal(R.normalizarConfig({ modo: 'cualquier cosa' }).modo, 'apagado');
  assert.equal(R.normalizarConfig({ topeDiario: 99999 }).topeDiario, R.CONFIG.topeDiarioMaximo);
  assert.equal(R.normalizarConfig({ maxPorCorrida: 999 }).maxPorCorrida, R.CONFIG.maxPorCorridaMaximo);
  assert.equal(R.normalizarConfig({ topeDiario: -3, maxPorCorrida: 0 }).topeDiario, 60);
  assert.equal(R.cupoDeEnvios({ topeDiario: 60, enviadosHoy: 0, maxPorCorrida: 25 }), 25);
  assert.equal(R.cupoDeEnvios({ topeDiario: 60, enviadosHoy: 50, maxPorCorrida: 25 }), 10);
  assert.equal(R.cupoDeEnvios({ topeDiario: 60, enviadosHoy: 60, maxPorCorrida: 25 }), 0);
  assert.equal(R.cupoDeEnvios({ topeDiario: 60, enviadosHoy: 75, maxPorCorrida: 25 }), 0);
});

test('arrendamiento: dos instancias nunca lo tienen a la vez; si vence, otra lo toma', () => {
  const t = 1_000_000;
  const a = R.tomarArrendamiento(null, 'A', t);
  assert.ok(a && a.propietario === 'A' && a.venceMs === t + R.CONFIG.arrendamientoMs);
  assert.equal(R.tomarArrendamiento(a, 'B', t + 1000), null, 'B no puede mientras A lo tenga');
  assert.ok(R.tomarArrendamiento(a, 'A', t + 1000), 'A puede renovarlo');
  const b = R.tomarArrendamiento(a, 'B', t + R.CONFIG.arrendamientoMs + 1);
  assert.equal(b.propietario, 'B', 'vencido: lo toma B');
  assert.equal(R.arrendamientoVigente({ propietario: '', venceMs: t + 999999 }, t), false);
  assert.equal(R.arrendamientoVigente(null, t), false);
});

test('baja firmada: HMAC derivado de la llave de certificados, sin variables nuevas; no se puede falsificar', () => {
  const clave = R.claveDeBaja('llave-maestra-de-prueba');
  assert.ok(Buffer.isBuffer(clave) && clave.length === 32);
  assert.equal(R.claveDeBaja(''), null);
  assert.notDeepEqual(clave, R.claveDeBaja('otra-llave'));
  assert.notEqual(clave.toString('hex'), require('crypto').createHash('sha256').update('llave-maestra-de-prueba').digest('hex'), 'no es la llave maestra a secas');
  const firma = R.firmarBaja(clave, 'uid123');
  assert.match(firma, /^[0-9a-f]{40}$/);
  assert.equal(R.bajaValida(clave, 'uid123', firma), true);
  assert.equal(R.bajaValida(clave, 'uid124', firma), false, 'la firma es de otra cuenta');
  assert.equal(R.bajaValida(clave, 'uid123', firma.replace(/.$/, c => (c === '0' ? '1' : '0'))), false);
  assert.equal(R.bajaValida(clave, 'uid123', firma.toUpperCase()), false);
  assert.equal(R.bajaValida(clave, 'uid123', ''), false);
  assert.equal(R.bajaValida(clave, '../x', firma), false);
  assert.equal(R.bajaValida(null, 'uid123', firma), false);
  assert.equal(R.bajaValida(R.claveDeBaja('otra-llave'), 'uid123', firma), false, 'cambiar la llave invalida los enlaces viejos');
  assert.equal(R.firmarBaja(null, 'uid123'), '');
});

test('variantes estables y códigos legibles', () => {
  assert.equal(R.variante('u1', 2, 4), R.variante('u1', 2, 4));
  const vistas = new Set(Array.from({ length: 200 }, (_, i) => R.variante('usuario' + i, 2, 4)));
  assert.deepEqual([...vistas].sort(), [0, 1, 2, 3], 'todas las variantes se usan');
  assert.match(R.codigoAleatorio(50), /^FT50-[A-HJKMNP-Z2-9]{6}$/);
  assert.match(R.codigoAleatorio(100), /^FT100-[A-HJKMNP-Z2-9]{6}$/);
  assert.notEqual(R.codigoAleatorio(50), R.codigoAleatorio(50));
});

// ─────────────────────────────────── Correos ───────────────────────────────────

const datosCorreo = (extra = {}) => ({
  uid: 'u1', nombre: 'Ana Pérez', cursoPrueba: '', precioMes: 249, codigo: 'FT50-ABC234', venceMs: mx(2026, 10, 23, 12),
  urlBaja: 'https://api.test/baja-recordatorios?u=u1&t=abc', primerAviso: false, ...extra
});
const sinEmojis = t => !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u.test(t);

test('correo: los 21 correos (3 vueltas por 7 pasos) llevan nombre, precio claro, botón, código, baja, aviso, ubicación y no tienen emojis', () => {
  for (let ciclo = 1; ciclo <= 3; ciclo++) {
    for (const s of R.SERIE) {
      const t = C.plantilla(datosCorreo({ ciclo, paso: s.paso, codigo: s.monto ? 'FT' + s.monto + '-ABC234' : '', venceMs: s.monto ? mx(2026, 10, 23, 12) : 0 }));
      const nombre = `vuelta ${ciclo} paso ${s.paso}`;
      assert.ok(t.asunto.length > 10 && t.asunto.length < 90, nombre + ': asunto de largo razonable: ' + t.asunto);
      assert.ok(sinEmojis(t.asunto + t.html + t.text), nombre + ': sin emojis');
      assert.ok(!/!/.test(t.asunto) && t.asunto !== t.asunto.toUpperCase(), nombre + ': asunto sobrio');
      assert.match(t.asunto, /^Ana,/, nombre + ': asunto personal con el primer nombre');
      assert.match(t.html, /Hola Ana,/);
      assert.match(t.html, /https:\/\/club\.fisioteck\.com\//, nombre + ': botón a la suscripción');
      assert.match(t.html, /FisioTeck ·/);
      assert.match(t.html, /aviso-de-privacidad\.html/);
      assert.match(t.html, /baja-recordatorios\?u=u1&amp;t=abc/, nombre + ': enlace de baja (escapado)');
      assert.match(t.text, /baja-recordatorios\?u=u1&t=abc/, nombre + ': enlace de baja en texto plano');
      assert.match(t.text, /FisioTeck ·/);
      assert.ok(!/linear-gradient|gradient/i.test(t.html), nombre + ': colores sólidos');
      assert.equal(t.monto, s.monto);
      if (s.monto) {
        assert.ok(t.html.includes('FT' + s.monto + '-ABC234') && t.text.includes('FT' + s.monto + '-ABC234'), nombre + ': muestra el código');
        assert.ok(t.text.includes('Tu primer mes: $' + (249 - s.monto) + ' (en lugar de $249)'), nombre + ': transparencia de precio');
        assert.match(t.text, /Desde el segundo mes: \$249, y puedes cancelar cuando quieras/);
        assert.match(t.html, /vale 24 horas|Vence el/i);
      } else {
        assert.ok(!t.html.includes('Tu código personal'), nombre + ': el paso 1 no lleva cupón');
        assert.match(t.html, /Cursos grabados con certificado/);
        assert.match(t.html, /Material descargable de cada curso/);
        assert.match(t.html, /Herramientas clínicas/);
      }
    }
  }
});

test('correo: las vueltas 2 y 3 cambian asuntos y apertura (no es el mismo correo repetido)', () => {
  const uids = ['u1', 'u2', 'u3', 'u4', 'u5'];
  for (const uid of uids) {
    const a1 = C.plantilla(datosCorreo({ uid, ciclo: 1, paso: 1, codigo: '' }));
    const a2 = C.plantilla(datosCorreo({ uid, ciclo: 2, paso: 1, codigo: '' }));
    const a3 = C.plantilla(datosCorreo({ uid, ciclo: 3, paso: 1, codigo: '' }));
    assert.notEqual(a1.asunto, a2.asunto); assert.notEqual(a2.asunto, a3.asunto); assert.notEqual(a1.asunto, a3.asunto);
    assert.match(a2.html, /volvemos a escribirte|Volvemos a escribirte/i, 'la vuelta 2 abre con «volvemos a escribirte»');
    assert.match(a3.html, /tercera y última vuelta/i);
    assert.doesNotMatch(a1.html, /volvemos a escribirte/i);
    // Un mismo paso de cobro cambia de asunto entre vueltas
    const b1 = C.plantilla(datosCorreo({ uid, ciclo: 1, paso: 2 })).asunto;
    const b2 = C.plantilla(datosCorreo({ uid, ciclo: 2, paso: 2 })).asunto;
    assert.notEqual(b1, b2);
  }
  assert.match(C.plantilla(datosCorreo({ ciclo: 2, paso: 2 })).html, /segunda vuelta/);
  assert.match(C.plantilla(datosCorreo({ ciclo: 3, paso: 2 })).html, /tercera y última vuelta/);
});

test('correo: hay 3 o 4 variantes de asunto por paso y la persona recibe siempre la misma (un reintento no cambia el correo)', () => {
  for (const s of R.SERIE) assert.equal(C.ASUNTOS[s.paso].length, 4, 'paso ' + s.paso);
  for (const v of [2, 3]) for (const tipo of ['beneficios', 'bajo', 'alto', 'cierre']) assert.ok(C.ASUNTOS_VUELTA[v][tipo].length >= 3, `vuelta ${v} ${tipo}`);
  for (const s of R.SERIE) {
    const vistos = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(uid => C.asunto({ uid, ciclo: 1, paso: s.paso, nombre: 'Ana', monto: s.monto, precioMes: 249 })));
    assert.ok(vistos.size >= 3, 'paso ' + s.paso + ': se reparten al menos 3 variantes');
  }
  assert.equal(C.asunto({ uid: 'x', ciclo: 1, paso: 2, nombre: 'Ana', monto: 50, precioMes: 249 }), C.asunto({ uid: 'x', ciclo: 1, paso: 2, nombre: 'Ana', monto: 50, precioMes: 249 }));
  // Dos correos seguidos del mismo tipo (pasos 2 y 4, por ejemplo) no llevan el mismo asunto
  for (const uid of ['a', 'b', 'c', 'd', 'e', 'f']) for (const ciclo of [2, 3]) {
    const ass = [2, 4, 6].map(p => C.asunto({ uid, ciclo, paso: p, nombre: 'Ana', monto: 50, precioMes: 249 }));
    assert.equal(new Set(ass).size, 3, `${uid} vuelta ${ciclo}`);
  }
  // Sin nombre: asunto sin coma inicial y con mayúscula
  const sinNombre = C.asunto({ uid: 'a', ciclo: 1, paso: 2, nombre: '', monto: 50, precioMes: 249 });
  assert.match(sinNombre, /^[A-Z$]/); assert.doesNotMatch(sinNombre, /^,/);
});

test('correo: el último de la vuelta 1 y 2 avisa una pausa; el último de la vuelta 3 dice que no habrá más', () => {
  const v1 = C.plantilla(datosCorreo({ ciclo: 1, paso: 7, codigo: 'FT100-AAAAAA' }));
  const v3 = C.plantilla(datosCorreo({ ciclo: 3, paso: 7, codigo: 'FT100-AAAAAA' }));
  assert.match(v1.html, /pausa de unos días/); assert.doesNotMatch(v1.html, /no te enviaremos más/);
  assert.match(v3.html, /no te enviaremos más recordatorios/); assert.match(v3.html, /Este es nuestro último correo/);
});

test('correo: personaliza con el curso de prueba y ESCAPA todo lo que viene de personas', () => {
  const t = C.plantilla(datosCorreo({ paso: 2, cursoPrueba: 'Manejo de <b>fauna</b> & "reptiles"', nombre: '<img src=x onerror=alert(1)> Ana' }));
  assert.match(t.html, /Elegiste «Manejo de &lt;b&gt;fauna&lt;\/b&gt; &amp; &quot;reptiles&quot;»/);
  assert.ok(!t.html.includes('<img src=x'), 'el nombre no inserta HTML');
  assert.ok(!t.html.includes('onerror=alert(1)>'), 'sin atributos inyectados');
  assert.match(t.html, /Hola &lt;img/);
  const code = C.plantilla(datosCorreo({ paso: 2, codigo: '"><script>x</script>' }));
  assert.ok(!code.html.includes('<script>'));
  const baja = C.plantilla(datosCorreo({ paso: 2, urlBaja: 'https://x/"><script>1</script>' }));
  assert.ok(!baja.html.includes('<script>'));
  assert.equal(C.esc(null), '');
});

test('correo: el primer correo de cada persona lleva el aviso visible con su enlace de baja; los demás no', () => {
  const primero = C.plantilla(datosCorreo({ ciclo: 1, paso: 1, codigo: '', primerAviso: true }));
  assert.match(primero.html, /Te escribimos porque tienes una cuenta en FisioTeck y todavía no eres miembro/);
  assert.match(primero.html, />darme de baja</);
  assert.match(primero.text, /Te escribimos porque tienes una cuenta/);
  const siguiente = C.plantilla(datosCorreo({ ciclo: 1, paso: 2, primerAviso: false }));
  assert.doesNotMatch(siguiente.html, /Te escribimos porque tienes una cuenta/);
  // El pie con el motivo y la baja SIEMPRE está
  assert.match(siguiente.html, /Recibes este correo porque creaste una cuenta en fisioteck\.com/);
  assert.match(siguiente.html, /No quiero recibir recordatorios ni promociones/);
});

test('correo de prueba: el asunto lo marca y usa la misma plantilla; sin enlace de baja no se rompe', () => {
  const t = C.plantilla(datosCorreo({ paso: 3, prueba: true, urlBaja: '' }));
  assert.match(t.asunto, /^\[PRUEBA\] /);
  assert.doesNotMatch(t.html, /No quiero recibir/);
  assert.equal(C.plantilla({}).monto, 0, 'sin datos arma el paso 1');
  assert.equal(C.plantilla({ paso: 99 }).paso, 1);
  assert.equal(C.plantilla({ paso: 2, ciclo: 77 }).ciclo, 3);
});
