'use strict';
// Referidos (reglas puras, sin red ni Firebase). Adaptado de Zoorigen.
// Solo invitan los socios con membresía vigente. Un invitado es VÁLIDO cuando confirmó su correo (lo verifica el
// servidor con Firebase Auth), es una cuenta nueva y pasó el control de dispositivos. Con 4 invitados válidos el
// anfitrión gana el "Premio por invitar": abrir UN curso antes de su fecha (ver rutas-referidos.js).
//
// Límite honesto del control anti-fraude: compara el identificador que guarda el navegador (localStorage), una
// "huella" ligera y la IP. Una persona que borra datos, usa incógnito u otro dispositivo NO se detecta. Dos familiares
// en la misma casa pueden compartir IP: por eso la huella solo cuenta junto con la IP y nunca la IP sola.

const ESTADOS = Object.freeze({ VALIDO: 'valido', PENDIENTE: 'pendiente-correo', RECHAZADO: 'rechazado' });

// Hitos del invitado: el anfitrión gana XP UNA sola vez por hito
const HITOS = Object.freeze([
  { clave: 'pago', texto: 'Tu invitado pagó una suscripción', puntos: 120 },
  { clave: 'retos5', texto: 'Tu invitado superó 5 retos', puntos: 40 },
  { clave: 'retos15', texto: 'Tu invitado superó 15 retos', puntos: 80 }
]);
const RETOS_PARA_HITO = Object.freeze({ retos5: 5, retos15: 15 });
const MAX_INVITADOS_CON_XP = 6;          // solo los primeros 6 invitados válidos suman XP
const INVITADOS_PARA_PREMIO = 4;         // "Premio por invitar"
const DIAS_MAXIMOS_CUENTA_NUEVA = 14;
const MAX_DISPOSITIVOS_ANFITRION = 20;

const MOTIVOS = Object.freeze({
  'codigo-inexistente': 'Ese código de invitación no existe',
  'mismo-usuario': 'No puedes usar tu propio código de invitación',
  'dispositivo-anfitrion': 'Se registró desde el mismo dispositivo de quien lo invitó',
  'dispositivo-invitado': 'Ya hay otra persona invitada desde ese mismo dispositivo',
  'cuenta-antigua': 'Esa cuenta ya existía antes de la invitación',
  'anfitrion-sin-membresia': 'Quien te invitó no tiene una membresía vigente, por eso esta invitación no cuenta'
});

// ── Código y enlace ──
const URL_REGISTRO = 'https://club.fisioteck.com/';
const CODIGO_REGEX = /^FT-[A-Z0-9_-]{6}$/;
const codigoDeUid = uid => 'FT-' + String(uid).substring(0, 6).toUpperCase();
const enlaceDeCodigo = codigo => `${URL_REGISTRO}?ref=${encodeURIComponent(codigo)}`;
function normalizarCodigo(codigo) {
  if (typeof codigo !== 'string') return null;
  const limpio = codigo.trim().toUpperCase();
  return CODIGO_REGEX.test(limpio) ? limpio : null;
}

// ── Datos del dispositivo (vienen del navegador: se validan tipo, forma y largo) ──
const ID_DISPOSITIVO = /^[A-Za-z0-9_-]{8,64}$/;
const HUELLA = /^[A-Za-z0-9+/=_-]{6,128}$/;
function validarDispositivo({ deviceId, huella } = {}) {
  if (typeof deviceId !== 'string' || !ID_DISPOSITIVO.test(deviceId.trim())) return null;
  if (typeof huella !== 'string' || !HUELLA.test(huella.trim())) return null;
  return { deviceId: deviceId.trim(), huella: huella.trim() };
}
function ipDeSolicitud(headers = {}, ipSocket = '') {
  const cabecera = headers['x-forwarded-for'];
  const primero = String(Array.isArray(cabecera) ? cabecera[0] : (cabecera || '')).split(',')[0].trim();
  const ip = primero || String(ipSocket || '').trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : '';
}
const combo = (huella, ip) => (huella && ip ? `${huella}|${ip}` : null);

function normalizarDispositivosAnfitrion(guardado) {
  const g = guardado && typeof guardado === 'object' ? guardado : {};
  const lista = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  return { ids: lista(g.ids), huellas: lista(g.huellas), combos: lista(g.combos) };
}
function agregarDispositivo(guardado, { deviceId, huella, ip }) {
  const d = normalizarDispositivosAnfitrion(guardado);
  const mete = (lista, valor) => (valor && !lista.includes(valor) ? [...lista, valor].slice(-MAX_DISPOSITIVOS_ANFITRION) : lista);
  return { ids: mete(d.ids, deviceId), huellas: mete(d.huellas, huella), combos: mete(d.combos, combo(huella, ip)) };
}
function mismoDispositivo(a, b) {
  if (a.deviceId && b.deviceId && a.deviceId === b.deviceId) return true;
  const ca = combo(a.huella, a.ip), cb = combo(b.huella, b.ip);
  return Boolean(ca && cb && ca === cb);
}

const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : 0));
const antesQue = (a, b) => (ms(a.creadoMs) - ms(b.creadoMs)) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
const ordenarInvitados = lista => [...lista].sort(antesQue);

// Control de dispositivos de UN invitado. Devuelve null si pasa, o la clave del motivo si se rechaza.
function evaluarDispositivo(invitado, anfitrion, otros = [], { soloAnteriores = false } = {}) {
  if (invitado.uid === invitado.anfitrionUid) return 'mismo-usuario';
  const host = normalizarDispositivosAnfitrion(anfitrion);
  const cInv = combo(invitado.huella, invitado.ip);
  if ((invitado.deviceId && host.ids.includes(invitado.deviceId)) || (cInv && host.combos.includes(cInv))) return 'dispositivo-anfitrion';
  const choca = otros.some(o => o.uid !== invitado.uid && o.estado === ESTADOS.VALIDO &&
    (!soloAnteriores || antesQue(o, invitado) < 0) && mismoDispositivo(o, invitado));
  return choca ? 'dispositivo-invitado' : null;
}

// ¿El invitado ya pagó? Solo con señales que el navegador NO puede escribir (las reglas de Firestore bloquean
// `payments`): un cobro registrado por el servidor. Una activación manual del administrador no cuenta.
function invitadoPago(miembro) {
  const m = miembro && typeof miembro === 'object' ? miembro : {};
  return Array.isArray(m.payments) && m.payments.some(p => p && Number(p.amount) > 0 && p.status !== 'failed');
}

function cuentaNueva(creationTime, ahora = Date.now()) {
  const t = Date.parse(creationTime);
  if (Number.isNaN(t)) return true;
  return ahora - t <= DIAS_MAXIMOS_CUENTA_NUEVA * 86400000;
}

// ── Hitos ──
function normalizarHitos(guardado) {
  const g = guardado && typeof guardado === 'object' ? guardado : {};
  return { pago: g.pago === true, retos5: g.retos5 === true, retos15: g.retos15 === true };
}
function actualizarHitos(guardado, { pago = false, retosSuperados = 0 } = {}) {
  const antes = normalizarHitos(guardado);
  const despues = {
    pago: antes.pago || pago === true,
    retos5: antes.retos5 || retosSuperados >= RETOS_PARA_HITO.retos5,
    retos15: antes.retos15 || retosSuperados >= RETOS_PARA_HITO.retos15
  };
  return { hitos: despues, nuevos: HITOS.filter(h => despues[h.clave] && !antes[h.clave]).map(h => h.clave) };
}
function listaDeHitos(hitos, valido) {
  const h = normalizarHitos(hitos);
  return HITOS.map(x => ({ clave: x.clave, texto: x.texto, puntos: x.puntos, logrado: Boolean(valido && h[x.clave]) }));
}
const puntosDeHitos = hitos => { const h = normalizarHitos(hitos); return HITOS.reduce((t, x) => t + (h[x.clave] ? x.puntos : 0), 0); };

// Resumen de los invitados de un anfitrión (ya ordenados del más antiguo al más nuevo)
function resumirInvitados(invitados) {
  let conXp = 0, validos = 0, pendientes = 0, rechazados = 0, xp = 0;
  const detalle = invitados.map(i => {
    let puntos = 0, cuenta = false;
    if (i.estado === ESTADOS.VALIDO) {
      validos += 1;
      if (conXp < MAX_INVITADOS_CON_XP) { conXp += 1; cuenta = true; puntos = puntosDeHitos(i.hitos); xp += puntos; }
    } else if (i.estado === ESTADOS.PENDIENTE) pendientes += 1;
    else rechazados += 1;
    return { uid: i.uid, puntos, conPuntos: cuenta };
  });
  return { validos, pendientes, rechazados, xp, detalle };
}

// Nombre público: primer nombre + inicial del apellido ("María G."). Nunca un correo ni un teléfono.
function aliasDeNombre(nombre) {
  const palabras = String(nombre == null ? '' : nombre).replace(/\s+/g, ' ').trim().split(' ')
    .filter(p => p && !/[@\d]/.test(p) && /^[\p{L}][\p{L}'.-]*$/u.test(p));
  if (!palabras.length) return 'Miembro';
  const primero = palabras[0].slice(0, 20);
  if (palabras.length === 1) return primero;
  const apellido = palabras.length >= 3 ? palabras[palabras.length - 2] : palabras[1];
  return primero + ' ' + apellido[0].toLocaleUpperCase('es-MX') + '.';
}

// ── Premio por invitar ──
// Estado guardado en members/{uid}/progress/premios: { ganados: ['referidos-1'], usados: [{ clave, cursoId, fecha }] }
// Claves de premio: invitar a 4 amigos y llegar a los niveles Profesional y Maestro. Cada una abre UN curso antes de su fecha.
const { LEVELS } = require('./logros'); // los premios de nivel usan los mismos umbrales que los niveles (Profesional y Maestro)
const PREMIOS = { 'referidos-1': { titulo: 'Premio por invitar', requisito: INVITADOS_PARA_PREMIO + ' invitados válidos' }, 'nivel-profesional': { titulo: 'Nivel Profesional', minXp: LEVELS[1].min }, 'nivel-maestro': { titulo: 'Nivel Maestro', minXp: LEVELS[4].min } };
function normalizarPremios(guardado) {
  const g = guardado && typeof guardado === 'object' ? guardado : {};
  return {
    ganados: Array.isArray(g.ganados) ? [...new Set(g.ganados.filter(x => PREMIOS[x]))] : [],
    usados: Array.isArray(g.usados) ? g.usados.filter(u => u && PREMIOS[u.clave] && typeof u.cursoId === 'string').map(u => ({ clave: u.clave, cursoId: u.cursoId, fecha: String(u.fecha || '') })) : []
  };
}
const premioGanado = invitadosValidos => invitadosValidos >= INVITADOS_PARA_PREMIO;

module.exports = {
  ESTADOS, HITOS, MAX_INVITADOS_CON_XP, INVITADOS_PARA_PREMIO, DIAS_MAXIMOS_CUENTA_NUEVA, MOTIVOS,
  codigoDeUid, enlaceDeCodigo, normalizarCodigo, validarDispositivo, ipDeSolicitud, normalizarDispositivosAnfitrion,
  agregarDispositivo, mismoDispositivo, evaluarDispositivo, invitadoPago, ordenarInvitados, cuentaNueva,
  normalizarHitos, actualizarHitos, listaDeHitos, puntosDeHitos, resumirInvitados, aliasDeNombre, normalizarPremios, premioGanado, PREMIOS
};
