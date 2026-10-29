'use strict';

// ══ BITÁCORA EN MEMORIA ══
// Guarda los últimos errores que el servidor escribió con console.error para que el panel de administración
// los muestre en "Estado del sistema". Vive solo en la memoria del proceso: al publicar o reiniciar el servidor
// empieza vacía (la persistente, en Firestore, está en bitacora-servidor.js).
// Nunca guarda correos, claves ni tokens: todo pasa por limpiarTexto antes de entrar.

const { limpiarTexto } = require('./texto-seguro');

const MAXIMO = 100;
const entradas = [];
let destino = null; // opcional: bitacora-servidor.js guarda también lo importante en Firestore
const arranque = new Date();
let contador = 0;

function texto(arg) {
  if (arg instanceof Error) return arg.message || String(arg);
  if (typeof arg === 'string') return arg;
  try { return JSON.stringify(arg); } catch (_) { return String(arg); }
}

function registrar(nivel, args) {
  try {
    const partes = args.map(texto).filter(Boolean);
    if (!partes.length) return;
    contador += 1;
    entradas.push({ n: contador, nivel, en: new Date().toISOString(), mensaje: limpiarTexto(partes.join(' '), 280) });
    if (entradas.length > MAXIMO) entradas.splice(0, entradas.length - MAXIMO);
    if (destino && nivel === 'error') destino(entradas[entradas.length - 1].mensaje);
  } catch (_) { /* la bitácora nunca rompe al servidor */ }
}

// Envuelve console.error una sola vez por proceso.
function instalar(consola = console) {
  if (consola.error && consola.error.__ftBitacora) return;
  const original = consola.error.bind(consola);
  const envuelto = (...args) => { registrar('error', args); return original(...args); };
  envuelto.__ftBitacora = true;
  consola.error = envuelto;
}

function recientes(limite = 30) {
  return entradas.slice(-limite).reverse();
}

function fijarDestino(fn) { destino = typeof fn === 'function' ? fn : null; }

module.exports = { instalar, registrar, recientes, fijarDestino, arranque: () => arranque, total: () => contador };
