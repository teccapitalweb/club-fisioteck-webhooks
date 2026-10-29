'use strict';
// Reglas puras de la ENCUESTA de la portada, las PREGUNTAS SIN RESPUESTA de la guía y las VISITAS (adaptado de Zoorigen).
// Sin Firebase y sin red. Privacidad: lo que llega de una persona anónima pasa primero por estas reglas
// (lista blanca de claves, largos fijos, texto de la guía sin correos, teléfonos ni enlaces).
const crypto = require('crypto');

const CLAVES_RESPUESTA = Object.freeze(['meta', 'p1', 'origen', 'area', 'reto', 'experiencia', 'urgencia', 'freno']);
const ORDEN_PREGUNTAS = Object.freeze(['meta', 'p1', 'origen', 'area', 'reto', 'experiencia', 'urgencia', 'freno']);
const MAX_SESSION_ID = 100;
const MAX_VALOR_RESPUESTA = 80;
const MAX_AVISO_VERSION = 40;

const limpiarTexto = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const recortar = (v, n) => String(v).slice(0, n);
const esObjeto = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Número de WhatsApp: acepta +, espacios, guiones o paréntesis, pero guarda solo dígitos (8 a 15). '' si no es válido.
function normalizarNumero(valor) {
  if (typeof valor !== 'string') return '';
  const t = valor.trim();
  if (!/^\+?[0-9 ()\-.]+$/.test(t)) return '';
  const digitos = t.replace(/\D/g, '');
  return /^[0-9]{8,15}$/.test(digitos) ? digitos : '';
}

// Cuerpo de POST /api/encuesta → { ok:false, error } | { ok:true, ignorar, valor }
function validarEncuesta(cuerpo) {
  if (!esObjeto(cuerpo)) return { ok: false, error: 'Los datos enviados no son válidos.' };
  const sessionId = typeof cuerpo.sessionId === 'string' ? limpiarTexto(cuerpo.sessionId) : '';
  if (!sessionId || sessionId.length > MAX_SESSION_ID) return { ok: false, error: 'sessionId debe ser texto de 1 a ' + MAX_SESSION_ID + ' caracteres.' };
  if (!esObjeto(cuerpo.respuestas)) return { ok: false, error: 'respuestas debe ser un objeto.' };
  const respuestas = {};
  for (const [clave, valor] of Object.entries(cuerpo.respuestas)) {
    if (!CLAVES_RESPUESTA.includes(clave)) return { ok: false, error: 'La respuesta "' + recortar(clave, 30) + '" no está permitida.' };
    const limpio = typeof valor === 'string' ? limpiarTexto(valor) : '';
    if (!limpio) return { ok: false, error: 'La respuesta "' + clave + '" debe ser texto.' };
    if (limpio.length > MAX_VALOR_RESPUESTA) return { ok: false, error: 'La respuesta "' + clave + '" es demasiado larga.' };
    respuestas[clave] = limpio;
  }
  if (typeof cuerpo.completada !== 'boolean') return { ok: false, error: 'completada debe ser verdadero o falso.' };
  const valor = { sessionId, respuestas, completada: cuerpo.completada };
  if (cuerpo.contacto !== undefined && cuerpo.contacto !== null) {
    const c = cuerpo.contacto;
    if (!esObjeto(c)) return { ok: false, error: 'contacto debe ser un objeto.' };
    const numero = normalizarNumero(c.numero);
    if (!numero) return { ok: false, error: 'El número debe tener solo dígitos, de 8 a 15.' };
    if (c.avisoAceptado !== true) return { ok: false, error: 'Falta aceptar el aviso de privacidad.' };
    const version = typeof c.avisoVersion === 'string' ? limpiarTexto(c.avisoVersion) : '';
    if (!version || version.length > MAX_AVISO_VERSION) return { ok: false, error: 'avisoVersion debe ser texto de 1 a ' + MAX_AVISO_VERSION + ' caracteres.' };
    valor.contacto = numero; valor.avisoAceptado = true; valor.avisoVersion = version;
  }
  return { ok: true, ignorar: !Object.keys(respuestas).length && !valor.contacto, valor };
}

// ── Preguntas sin respuesta de la guía ──
const MAX_TEXTO_CHATBOT = 120, MAX_ENTRADA_CHATBOT = 1000, MIN_TEXTO_CHATBOT = 3, MAX_CLAVE = 80;
const DOMINIOS = 'com|mx|org|net|edu|gob|gov|io|co|info|app|dev|me|tv|ly|us|es|ar|cl|pe|biz|xyz|site|online|store|shop|link|page';
const RE_CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RE_URL = new RegExp('\\b(?:https?:\\/\\/|www\\.)\\S+|\\b[a-z0-9-]{2,}(?:\\.[a-z0-9-]+)*\\.(?:' + DOMINIOS + ')\\b(?:\\/\\S*)?', 'gi');
const RE_USUARIO = /(^|\s)@[A-Za-z0-9_.]{2,}/g;
const RE_TELEFONO = /\+?\d(?:[\s().-]{0,2}\d){6,}/g;

function limpiarTextoGuia(valor) {
  if (typeof valor !== 'string') return '';
  let t = limpiarTexto(valor.slice(0, MAX_ENTRADA_CHATBOT));
  t = t.replace(RE_CORREO, ' ').replace(RE_URL, ' ').replace(RE_USUARIO, '$1').replace(RE_TELEFONO, ' ');
  t = t.replace(/\s+/g, ' ').replace(/\s+([,;:.])/g, '$1').trim();
  t = recortar(t, MAX_TEXTO_CHATBOT).trim();
  return t.length < MIN_TEXTO_CHATBOT ? '' : t;
}
function claveGuia(valor) {
  const base = String(valor == null ? '' : valor).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (base.length <= MAX_CLAVE) return base;
  return base.slice(0, MAX_CLAVE - 9).trimEnd() + '-' + crypto.createHash('sha256').update(base).digest('hex').slice(0, 8);
}
function validarSinRespuesta(cuerpo) {
  if (!esObjeto(cuerpo)) return { ok: false, error: 'Los datos enviados no son válidos.' };
  if (typeof cuerpo.texto !== 'string') return { ok: false, error: 'texto debe ser un texto.' };
  const ejemplo = limpiarTextoGuia(cuerpo.texto), clave = ejemplo ? claveGuia(ejemplo) : '';
  if (!ejemplo || !clave) return { ok: true, ignorar: true };
  return { ok: true, ignorar: false, valor: { clave, ejemplo } };
}
function combinarSinRespuesta(previo, { ejemplo }, ahora) {
  const p = esObjeto(previo) ? previo : null;
  const veces = p && Number(p.veces) > 0 ? Math.floor(Number(p.veces)) : 0;
  return { ejemplo: p && p.ejemplo ? p.ejemplo : ejemplo, veces: veces + 1, primeraMs: p && p.primeraMs ? p.primeraMs : ahora, ultimaMs: ahora };
}

// ── Visitas (contador agregado: solo suma por día y página; nunca IP, cookies ni quién fue) ──
const PAGINAS = Object.freeze(['portada', 'aviso-privacidad', 'otra']);
const ALIAS = Object.freeze({ '': 'portada', '/': 'portada', index: 'portada', inicio: 'portada', landing: 'portada', portada: 'portada', 'aviso-de-privacidad': 'aviso-privacidad', 'aviso-privacidad': 'aviso-privacidad', privacidad: 'aviso-privacidad' });
function normalizarPagina(valor) {
  const t = String(valor == null ? '' : valor).toLowerCase().trim().replace(/[?#].*$/, '').replace(/\.html?$/, '').replace(/^\/+|\/+$/g, '').slice(0, 60);
  return Object.prototype.hasOwnProperty.call(ALIAS, t) ? ALIAS[t] : 'otra';
}
function visitaNoRastreable(headers = {}) { return String(headers.dnt || '').trim() === '1' || String(headers['sec-gpc'] || '').trim() === '1'; }
function diaMexico(fecha = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha); }

// ── Resumen para el panel ──
function contar(filas, clave) {
  const m = {};
  filas.forEach(f => { const v = f.respuestas[clave]; if (v) m[v] = (m[v] || 0) + 1; });
  return Object.entries(m).map(([valor, n]) => ({ valor, n })).sort((a, b) => b.n - a.n);
}
// Junta las copias de una misma sesión (parcial y completa): se queda con las respuestas más recientes y completa si alguna lo fue.
function unirSesiones(docs) {
  const mapa = new Map();
  docs.slice().sort((a, b) => (a.creadoMs || 0) - (b.creadoMs || 0)).forEach(d => {
    const s = mapa.get(d.sessionId) || { sessionId: d.sessionId, respuestas: {}, completada: false, creadoMs: d.creadoMs || 0, ultimaMs: 0 };
    Object.assign(s.respuestas, d.respuestas || {});
    s.completada = s.completada || d.completada === true;
    s.ultimaMs = Math.max(s.ultimaMs, d.creadoMs || 0);
    if (d.contacto) { s.contacto = d.contacto; s.avisoVersion = d.avisoVersion || ''; }
    mapa.set(d.sessionId, s);
  });
  return [...mapa.values()];
}
function resumirEncuesta(docs) {
  const sesiones = unirSesiones(docs);
  const completadas = sesiones.filter(s => s.completada);
  const abandono = {};
  sesiones.filter(s => !s.completada).forEach(s => {
    const siguiente = ORDEN_PREGUNTAS.find(k => !(k in s.respuestas));
    if (siguiente) abandono[siguiente] = (abandono[siguiente] || 0) + 1;
  });
  const leads = sesiones.filter(s => s.contacto).sort((a, b) => b.ultimaMs - a.ultimaMs).map(s => ({
    numero: s.contacto, perfil: s.respuestas.p1 || '', area: s.respuestas.area || '', urgencia: s.respuestas.urgencia || '', freno: s.respuestas.freno || '',
    caliente: s.respuestas.urgencia === 'Lo antes posible', avisoVersion: s.avisoVersion, fecha: s.ultimaMs ? new Date(s.ultimaMs).toISOString() : null
  }));
  return {
    sesiones: sesiones.length, completadas: completadas.length, tasa: sesiones.length ? Math.round(completadas.length / sesiones.length * 100) : 0,
    perfiles: contar(sesiones, 'p1'), origen: contar(sesiones, 'origen'), areas: contar(sesiones, 'area'), metas: contar(sesiones, 'meta'),
    urgencia: contar(sesiones, 'urgencia'), frenos: contar(sesiones, 'freno'),
    abandono: Object.entries(abandono).map(([clave, n]) => ({ clave, n })).sort((a, b) => b.n - a.n), leads
  };
}

module.exports = {
  CLAVES_RESPUESTA, ORDEN_PREGUNTAS, MAX_TEXTO_CHATBOT, normalizarNumero, validarEncuesta, limpiarTextoGuia, claveGuia, validarSinRespuesta,
  combinarSinRespuesta, PAGINAS, normalizarPagina, visitaNoRastreable, diaMexico, unirSesiones, resumirEncuesta
};
