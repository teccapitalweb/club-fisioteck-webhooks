'use strict';

// ══ RECORDATORIOS DE PAGO · REGLAS PURAS (sin Firebase, sin red, sin reloj propio) ══
// Convierte en miembros a quienes se registraron y NUNCA han pagado. La serie es la MISMA que usan Alintec Food y FisioTeck:
// cada persona tiene su propio ciclo de 7 correos, con un DESCANSO de 4 días entre ciclos y un máximo de 3 ciclos.
// Aquí vive TODO lo que decide quién recibe qué y cuándo; se prueba en test/recordatorios-pago.test.js. Los pasos, montos, tiempos,
// descanso y máximo de ciclos están en UN solo bloque (SERIE y CONFIG): para cambiarlos se edita solo ese bloque.
//
//   Paso 1  «Hazte miembro + beneficios»  sin cupón       12 h después de registrarse (en los ciclos 2 y 3: al terminar el descanso)
//   Paso 2  cupón de $50  (vigente 24 h)                  24 h después del correo 1
//   Paso 3  cupón de $100 (vigente 24 h)                  12 h después de que VENCIÓ el cupón del paso 2
//   Pasos 4 a 7  $50 · $100 · $50 · $100                  mismo ritmo: 12 h después de que venció el cupón anterior
//   Descanso de 4 días después de que VENCE el cupón del paso 7; el ciclo vuelve a empezar (el paso 1 se repite, con otra apertura).
//   Máximo 3 ciclos: el último correo del tercer ciclo cierra la serie para siempre.
//
// Cada persona lleva su propio reloj. Todo sale entre 8:00 y 22:00 (hora de Ciudad de México); si una hora cae fuera, sale cuando abre.
// El descuento es solo sobre el plan MENSUAL: el primer mes cuesta el precio normal menos el cupón; desde el segundo mes, el precio normal.
// El estado de cada persona vive en recordatoriosPago/{uid} (colección SOLO del servidor; el navegador nunca la escribe).

const crypto = require('crypto');
// «Nunca ha pagado»: ningún pago registrado, ninguna fecha de acceso y ningún estado de membresía (activo, pagado o cancelado).
function nuncaHaTenidoPlan(miembro) {
  if (!miembro || typeof miembro !== 'object') return false;
  if (Array.isArray(miembro.payments) && miembro.payments.length) return false;
  if (miembro.lastPaymentDate || miembro.accessUntil || miembro.nextPaymentDate || miembro.stripeSubscriptionId) return false;
  return !['active', 'paid', 'cancelled'].includes(miembro.status);
}

const HORA = 3600000;
const DIA = 24 * HORA;

// ───────────── La serie: pasos, montos y tiempos (EL ÚNICO LUGAR QUE SE EDITA PARA CAMBIARLOS) ─────────────
// esperaMs se cuenta desde `desde`: 'registro' (solo el paso 1 del primer ciclo) | 'envio' (del paso anterior) | 'vencimiento' (del cupón del paso anterior).
const SERIE = Object.freeze([
  Object.freeze({ paso: 1, monto: 0, desde: 'registro', esperaMs: 12 * HORA }),
  Object.freeze({ paso: 2, monto: 50, desde: 'envio', esperaMs: 24 * HORA }),
  Object.freeze({ paso: 3, monto: 100, desde: 'vencimiento', esperaMs: 12 * HORA }),
  Object.freeze({ paso: 4, monto: 50, desde: 'vencimiento', esperaMs: 12 * HORA }),
  Object.freeze({ paso: 5, monto: 100, desde: 'vencimiento', esperaMs: 12 * HORA }),
  Object.freeze({ paso: 6, monto: 50, desde: 'vencimiento', esperaMs: 12 * HORA }),
  Object.freeze({ paso: 7, monto: 100, desde: 'vencimiento', esperaMs: 12 * HORA })
]);
const CONFIG = Object.freeze({
  serie: SERIE,
  maxCiclos: 3,                      // cuántas veces se repite la serie de 7 correos
  descansoMs: 4 * DIA,               // pausa entre un ciclo y el siguiente (desde que VENCE el cupón del paso 7)
  vigenciaCuponMs: 24 * HORA,        // lo que vale cada cupón desde que se manda el correo
  precioMesMXN: 199,                  // precio de lista del plan mensual (respaldo si no se puede leer de Stripe)
  horaInicio: 8,
  horaFin: 22,
  zona: 'America/Mexico_City',
  topeDiarioPorDefecto: 60,
  topeDiarioMaximo: 500,
  maxPorCorridaPorDefecto: 25,
  maxPorCorridaMaximo: 50,
  intervaloCronMs: 20 * 60 * 1000,    // cada cuánto revisa el servidor
  arrendamientoMs: 10 * 60 * 1000,    // tiempo que una instancia «reserva» el trabajo para que otra no envíe a la vez
  reservaPersonaMs: 24 * HORA,        // una reserva de envío más vieja que esto se considera perdida (el idempotency-key de Resend dura 24 h)
  esperaTrasFalloMs: 60 * 60 * 1000,  // si un envío falla, se reintenta a esa persona después de este tiempo
  maxFallosSeguidos: 6
});
const PASOS_TOTALES = SERIE.length;   // pasos de cada ciclo
const PASO_ULTIMO = SERIE[SERIE.length - 1].paso;
const MONTOS = Object.freeze([...new Set(SERIE.map(s => s.monto).filter(Boolean))]);
const definicion = paso => SERIE.find(s => s.paso === paso) || null;
const montoDelPaso = paso => (definicion(paso) || { monto: 0 }).monto;
const PLANES_DE_PAGO = Object.freeze(['mensual', 'anual', 'regalo', 'admin']);

// ───────────── Horario (hora de Ciudad de México, con Intl: soporta cambios de horario si alguna vez regresan) ─────────────
function partesMexico(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { anio: o.year, mes: o.month, dia: o.day, hora: o.hour % 24, minuto: o.minute, segundo: o.second };
}
const horaMexico = ms => partesMexico(ms).hora;
const dentroDeHorario = ms => { const h = horaMexico(ms); return h >= CONFIG.horaInicio && h < CONFIG.horaFin; };
// «2026-10-22» según el día de México
function diaMexico(ms) { const p = partesMexico(ms); return p.anio + '-' + String(p.mes).padStart(2, '0') + '-' + String(p.dia).padStart(2, '0'); }
// Cuando una hora cae fuera de 8:00-22:00, sale a las 8:00 (hoy si todavía no abre, mañana si ya cerró)
function ajustarAHorario(ms) {
  if (!Number.isFinite(ms)) return ms;
  if (dentroDeHorario(ms)) return ms;
  const p = partesMexico(ms);
  let falta = ((CONFIG.horaInicio - p.hora) * 60 - p.minuto) * 60000 - p.segundo * 1000;
  if (falta <= 0) falta += DIA;   // ya cerró: abre mañana
  let candidato = ms + falta;
  // Si un cambio de horario movió la hora, se corrige hasta caer justo a las 8:00
  for (let i = 0; i < 4 && !(horaMexico(candidato) === CONFIG.horaInicio && partesMexico(candidato).minuto === 0); i++) {
    const q = partesMexico(candidato);
    candidato += ((CONFIG.horaInicio - q.hora) * 60 - q.minuto) * 60000;
  }
  return candidato;
}

// ───────────── Estado de cada persona ─────────────
const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
function normalizarEstado(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const reserva = e.reserva && typeof e.reserva === 'object' && num(e.reserva.paso)
    ? { ciclo: Math.min(CONFIG.maxCiclos, Math.max(1, num(e.reserva.ciclo) || 1)), paso: num(e.reserva.paso), token: String(e.reserva.token || '').slice(0, 64), ms: num(e.reserva.ms), codigo: String(e.reserva.codigo || '').slice(0, 40),
      promoId: String(e.reserva.promoId || '').slice(0, 60), venceMs: num(e.reserva.venceMs) }
    : null;
  const cerrada = ['convertida', 'pago'].includes(e.cerrada) ? e.cerrada : '';
  return {
    registroMs: num(e.registroMs),
    ciclo: Math.min(CONFIG.maxCiclos, Math.max(1, num(e.ciclo) || 1)),   // ciclo del último correo enviado (1 a maxCiclos)
    paso: Math.min(PASO_ULTIMO, num(e.paso)),                // último paso ENVIADO en ese ciclo (0 = ninguno)
    ultimoEnvioMs: num(e.ultimoEnvioMs),
    enviados: num(e.enviados),
    cuponCodigo: typeof e.cuponCodigo === 'string' ? e.cuponCodigo.slice(0, 40) : '',
    cuponPromoId: typeof e.cuponPromoId === 'string' ? e.cuponPromoId.slice(0, 60) : '',
    cuponMonto: num(e.cuponMonto),
    cuponVenceMs: num(e.cuponVenceMs),
    finalizado: e.finalizado === true,                      // ya se envió el último correo del último ciclo: no habrá más correos
    baja: e.baja === true,                                // se dio de baja desde el enlace de un correo (para siempre)
    bajaMs: num(e.bajaMs),
    optOut: e.optOut === true,                              // dijo que no quiere promociones (casilla al registrarse o interruptor del perfil)
    optOutMs: num(e.optOutMs),
    optOutOrigen: ['registro', 'perfil'].includes(e.optOutOrigen) ? e.optOutOrigen : '',
    cerrada,
    cerradaMs: num(e.cerradaMs),
    conversion: e.conversion && typeof e.conversion === 'object'
      ? { ms: num(e.conversion.ms), ciclo: num(e.conversion.ciclo), paso: num(e.conversion.paso), codigo: String(e.conversion.codigo || '').slice(0, 40), conCupon: e.conversion.conCupon === true } : null,
    reserva,
    fallos: num(e.fallos),
    reintentarMs: num(e.reintentarMs),
    ultimoError: typeof e.ultimoError === 'string' ? e.ultimoError.slice(0, 120) : ''
  };
}

// ───────────── Quién entra a la serie ─────────────
const minusculas = v => String(v == null ? '' : v).trim().toLowerCase();
// Reglas que NO necesitan red. miembro / usuario: miembros/{uid} y usuarios/{uid}. cuenta: { emailVerified, disabled } de Firebase Auth o null si
// todavía no se consultó. tieneAcceso(miembro): la regla de membresía vigente del servidor.
function elegibilidad({ miembro, usuario = null, cuenta = null, estado = null, tieneAcceso = () => false, correosAdmin = [], ahoraMs = Date.now() }) {
  if (!miembro || typeof miembro !== 'object') return { ok: false, motivo: 'sin-registro' };
  const correo = minusculas(miembro.email);
  if (!correo || !correo.includes('@')) return { ok: false, motivo: 'sin-correo' };
  if (miembro.role === 'admin' || correosAdmin.map(minusculas).includes(correo)) return { ok: false, motivo: 'admin' };
  const e = normalizarEstado(estado);
  if (e.baja) return { ok: false, motivo: 'baja' };
  if (e.optOut) return { ok: false, motivo: 'no-quiere' };
  if (e.cerrada === 'convertida') return { ok: false, motivo: 'convertida' };
  if (e.cerrada === 'pago') return { ok: false, motivo: 'ya-pago' };
  if (!nuncaHaTenidoPlan(miembro)) return { ok: false, motivo: 'ya-pago' };
  if (PLANES_DE_PAGO.includes(miembro.planTipo || miembro.plan)) return { ok: false, motivo: 'ya-pago' };
  if (tieneAcceso(miembro)) return { ok: false, motivo: 'membresia' };
  if (serieTerminada(e)) return { ok: false, motivo: 'serie-cerrada' };
  if (cuenta) {
    if (cuenta.disabled === true) return { ok: false, motivo: 'cuenta-deshabilitada' };
    if (cuenta.emailVerified !== true) return { ok: false, motivo: 'correo-sin-verificar' };
  }
  return { ok: true, motivo: '' };
}

// La serie termina para siempre cuando ya se envió el último correo del último ciclo (el cupón de ese correo sigue valiendo sus 24 h)
function serieTerminada(estado) {
  const e = normalizarEstado(estado);
  return e.finalizado || (e.ciclo >= CONFIG.maxCiclos && e.paso >= PASO_ULTIMO);
}

// Qué correo toca después (solo el lugar, sin horas): { ciclo, paso } o null si ya no hay más.
function posicionSiguiente(estado) {
  const e = normalizarEstado(estado);
  if (e.cerrada || e.baja || e.optOut || serieTerminada(e)) return null;
  if (e.paso === 0 && e.enviados === 0) return { ciclo: 1, paso: 1 };
  if (e.paso >= PASO_ULTIMO) return { ciclo: e.ciclo + 1, paso: 1 };
  return { ciclo: e.ciclo, paso: e.paso + 1 };
}

// Qué correo sigue y desde cuándo puede salir. null = ya no hay más correos.
// registroMs: cuándo se registró la persona (miembros.createdAt o Firebase Auth).
function siguienteEnvio(estado, registroMs) {
  const e = normalizarEstado(estado);
  if (e.cerrada || e.baja || e.optOut || serieTerminada(e)) return null;
  const vence = e.cuponVenceMs || (e.ultimoEnvioMs ? e.ultimoEnvioMs + CONFIG.vigenciaCuponMs : 0);
  let ciclo = e.ciclo; let paso = e.paso + 1; let debeSalirMs;
  if (e.paso === 0 && e.enviados === 0) {            // todavía no se le ha enviado nada
    const base = num(registroMs) || e.registroMs;
    if (!base) return null;
    ciclo = 1; paso = 1; debeSalirMs = base + definicion(1).esperaMs;
  } else if (e.paso >= PASO_ULTIMO) {                // terminó un ciclo: descanso y empieza el siguiente (otra vez desde el paso 1)
    if (!vence) return null;
    ciclo = e.ciclo + 1; paso = 1; debeSalirMs = vence + CONFIG.descansoMs;
  } else {
    const d = definicion(paso);
    const base = d.desde === 'envio' ? e.ultimoEnvioMs : vence;
    if (!base) return null;
    debeSalirMs = base + d.esperaMs;
  }
  const def = definicion(paso);
  return { ciclo, paso, monto: def.monto, debeSalirMs, saleMs: ajustarAHorario(debeSalirMs) };
}

// Una persona debe recibir su siguiente correo ahora si ya llegó su hora, estamos en horario y no está en espera por un fallo
function tocaAhora(estado, registroMs, ahoraMs) {
  const s = siguienteEnvio(estado, registroMs);
  if (!s) return null;
  const e = normalizarEstado(estado);
  if (e.reintentarMs && ahoraMs < e.reintentarMs) return null;
  if (e.fallos >= CONFIG.maxFallosSeguidos) return null;
  return s.saleMs <= ahoraMs && dentroDeHorario(ahoraMs) ? s : null;
}

// ───────────── Cambios de estado (siempre devuelven un estado NUEVO) ─────────────
function estadoTrasReservar(estado, { ciclo = 1, paso, token, ahoraMs, codigo = '', promoId = '', venceMs = 0 }) {
  return { ...normalizarEstado(estado), reserva: { ciclo, paso, token, ms: ahoraMs, codigo, promoId, venceMs } };
}
function reservaPerdida(estado, ahoraMs) {
  const e = normalizarEstado(estado);
  return Boolean(e.reserva && ahoraMs - e.reserva.ms >= CONFIG.reservaPersonaMs);
}
function estadoTrasEnviar(estado, { ciclo = 1, paso, ahoraMs, codigo = '', promoId = '', venceMs = 0 }) {
  const e = normalizarEstado(estado);
  const monto = montoDelPaso(paso);
  return {
    ...e, ciclo, paso, ultimoEnvioMs: ahoraMs, enviados: e.enviados + 1, reserva: null, fallos: 0, reintentarMs: 0, ultimoError: '',
    cuponCodigo: monto ? codigo : '', cuponPromoId: monto ? promoId : '', cuponMonto: monto, cuponVenceMs: monto ? venceMs : 0,
    // El último correo del último ciclo cierra la serie para siempre
    finalizado: e.finalizado || (ciclo >= CONFIG.maxCiclos && paso >= PASO_ULTIMO)
  };
}
function estadoTrasFallo(estado, { ahoraMs, mensaje = '' }) {
  const e = normalizarEstado(estado);
  return { ...e, reserva: null, fallos: e.fallos + 1, reintentarMs: ahoraMs + CONFIG.esperaTrasFalloMs, ultimoError: String(mensaje).slice(0, 120) };
}
function estadoTrasBaja(estado, { ahoraMs }) { return { ...normalizarEstado(estado), baja: true, bajaMs: ahoraMs, reserva: null }; }
function estadoTrasPreferencia(estado, { quiere, ahoraMs, origen = 'perfil' }) {
  const e = normalizarEstado(estado);
  // Quien se dio de baja desde un correo no vuelve a recibir promociones; solo se puede decir «no» (nunca volver a «sí»)
  if (e.baja) return { ...e, optOut: true };
  return quiere ? { ...e, optOut: false, optOutMs: 0, optOutOrigen: '' } : { ...e, optOut: true, optOutMs: ahoraMs, optOutOrigen: origen === 'registro' ? 'registro' : 'perfil' };
}
function estadoTrasPago(estado, { ahoraMs, codigo = '', paso = 0, conCupon = false }) {
  const e = normalizarEstado(estado);
  return {
    ...e, cerrada: conCupon ? 'convertida' : 'pago', cerradaMs: ahoraMs, reserva: null,
    conversion: { ms: ahoraMs, ciclo: e.ciclo, paso: paso || e.paso, codigo: codigo || (conCupon ? e.cuponCodigo : ''), conCupon }
  };
}

// ───────────── Cupón vigente de una persona (lo que ve en su panel y lo que el pago aplica solo) ─────────────
function cuponVigente(estado, { miembro = null, tieneAcceso = () => false, ahoraMs = Date.now(), precioMes = CONFIG.precioMesMXN, correosAdmin = [] } = {}) {
  const e = normalizarEstado(estado);
  if (!e.cuponCodigo || !e.cuponMonto || e.cuponVenceMs <= ahoraMs) return null;
  if (e.baja || e.optOut || e.cerrada) return null;   // quien dijo no a las promociones tampoco ve la barra (el código escrito a mano sigue sirviendo en Stripe)
  if (miembro) {
    if (miembro.role === 'admin' || correosAdmin.map(minusculas).includes(minusculas(miembro.email))) return null;
    if (!nuncaHaTenidoPlan(miembro) || tieneAcceso(miembro)) return null;
  }
  return { codigo: e.cuponCodigo, promoId: e.cuponPromoId, ciclo: e.ciclo, paso: e.paso, monto: e.cuponMonto, precioMes, precioFinal: Math.max(0, precioMes - e.cuponMonto), venceMs: e.cuponVenceMs, restanteMs: e.cuponVenceMs - ahoraMs };
}

// ───────────── Etapa que se muestra en el panel ─────────────
// 'sin-elegir' no existe aquí: la etapa describe a quien está o estuvo en la serie.
function etapaDe({ estado, motivoNoElegible = '', ahoraMs, registroMs = 0 }) {
  const e = normalizarEstado(estado);
  if (e.cerrada === 'convertida') return { etapa: 'convertida', texto: 'Convertida con cupón' };
  if (e.cerrada === 'pago' || motivoNoElegible === 'ya-pago' || motivoNoElegible === 'membresia') return { etapa: 'pago', texto: 'Pagó o ya es miembro' };
  if (e.baja || motivoNoElegible === 'baja') return { etapa: 'baja', texto: 'Se dio de baja' };
  if (e.optOut || motivoNoElegible === 'no-quiere') return { etapa: 'baja', texto: 'No quiere promociones' };
  if (e.cuponCodigo && e.cuponVenceMs > ahoraMs) return { etapa: 'cupon-vigente', texto: 'Cupón vigente' };
  if (serieTerminada(e)) return { etapa: 'cerrada', texto: 'Terminó sus ' + CONFIG.maxCiclos + ' ciclos' };
  if (motivoNoElegible === 'correo-sin-verificar') return { etapa: 'sin-verificar', texto: 'Correo sin verificar' };
  if (motivoNoElegible === 'admin' || motivoNoElegible === 'sin-correo' || motivoNoElegible === 'cuenta-deshabilitada' || motivoNoElegible === 'sin-registro') return { etapa: 'excluida', texto: 'No recibe correos' };
  if (e.enviados > 0 && e.paso >= PASO_ULTIMO && e.ciclo < CONFIG.maxCiclos) return { etapa: 'descanso', texto: 'En descanso antes del ciclo ' + (e.ciclo + 1) };
  if (e.enviados > 0) return { etapa: 'enviado', texto: 'Esperando su siguiente correo' };
  return { etapa: 'en-espera', texto: registroMs || e.registroMs ? 'En espera de su primer correo' : 'En espera' };
}

// ───────────── Tope diario y por corrida ─────────────
function normalizarConfig(c) {
  const d = c && typeof c === 'object' ? c : {};
  const entero = (v, def, max) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.min(max, Math.floor(Number(v))) : def);
  return {
    modo: d.modo === 'activo' ? 'activo' : 'apagado',
    topeDiario: entero(d.topeDiario, CONFIG.topeDiarioPorDefecto, CONFIG.topeDiarioMaximo),
    maxPorCorrida: entero(d.maxPorCorrida, CONFIG.maxPorCorridaPorDefecto, CONFIG.maxPorCorridaMaximo)
  };
}
function cupoDeEnvios({ topeDiario, enviadosHoy, maxPorCorrida }) {
  return Math.max(0, Math.min(topeDiario - Math.max(0, enviadosHoy), maxPorCorrida));
}

// ───────────── Bloqueo por arrendamiento (para que dos instancias nunca envíen a la vez) ─────────────
function arrendamientoVigente(lease, ahoraMs) { return Boolean(lease && num(lease.venceMs) > ahoraMs && lease.propietario); }
// Devuelve el arrendamiento nuevo si se puede tomar (libre, vencido o ya es mío); null si lo tiene otra instancia
function tomarArrendamiento(lease, propietario, ahoraMs, ttlMs = CONFIG.arrendamientoMs) {
  if (arrendamientoVigente(lease, ahoraMs) && lease.propietario !== propietario) return null;
  return { propietario, venceMs: ahoraMs + ttlMs, tomadoMs: arrendamientoVigente(lease, ahoraMs) ? num(lease.tomadoMs) : ahoraMs };
}

// ───────────── Baja firmada ─────────────
// La clave se DERIVA de CERT_SIGNING_KEY con una etiqueta propia: no hace falta ninguna variable nueva en Railway y el enlace de baja
// no sirve para falsificar certificados (ni al revés). Si CERT_SIGNING_KEY cambia, los enlaces de baja ya enviados dejan de valer.
const ETIQUETA_BAJA = 'fisioteck/recordatorios-pago/baja/v1';
function claveDeBaja(claveMaestra) {
  if (!claveMaestra) return null;
  return crypto.createHmac('sha256', String(claveMaestra)).update(ETIQUETA_BAJA).digest();
}
function firmarBaja(clave, uid) {
  if (!clave) return '';
  return crypto.createHmac('sha256', clave).update('baja:' + String(uid)).digest('hex').slice(0, 40);
}
function bajaValida(clave, uid, firma) {
  if (!clave || typeof uid !== 'string' || typeof firma !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !/^[0-9a-f]{40}$/.test(firma)) return false;
  const esperada = Buffer.from(firmarBaja(clave, uid)); const dada = Buffer.from(firma);
  return esperada.length === dada.length && crypto.timingSafeEqual(esperada, dada);
}

// ───────────── Variantes estables (la misma persona y paso siempre da la misma variante: un reintento no cambia el correo) ─────────────
function variante(uid, paso, total) {
  const h = crypto.createHash('sha256').update(String(uid) + '|' + paso).digest();
  return h.readUInt16BE(0) % Math.max(1, total);
}

// Código promocional legible: FT50-XXXXXX (sin letras que se confunden)
function codigoAleatorio(monto, bytes = crypto.randomBytes(6)) {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of bytes) s += alfabeto[b % alfabeto.length];
  return 'FT' + monto + '-' + s;
}

module.exports = {
  HORA, DIA, SERIE, CONFIG, PASOS_TOTALES, PASO_ULTIMO, MONTOS, PLANES_DE_PAGO, definicion, montoDelPaso,
  partesMexico, horaMexico, dentroDeHorario, diaMexico, ajustarAHorario,
  normalizarEstado, elegibilidad, serieTerminada, posicionSiguiente, siguienteEnvio, tocaAhora,
  estadoTrasReservar, reservaPerdida, estadoTrasEnviar, estadoTrasFallo, estadoTrasBaja, estadoTrasPreferencia, estadoTrasPago,
  cuponVigente, etapaDe, normalizarConfig, cupoDeEnvios, arrendamientoVigente, tomarArrendamiento,
  ETIQUETA_BAJA, claveDeBaja, firmarBaja, bajaValida, variante, codigoAleatorio
};
