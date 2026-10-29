'use strict';
// Utilidades para guardar textos y fechas sin datos sensibles (correos, claves, tokens e ids de Stripe quedan recortados).

function limpiarTexto(texto, max = 300) {
  return String(texto === null || texto === undefined ? '' : texto)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[correo]')
    .replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_]{6,}/g, '[clave]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [token]')
    // ids de Stripe: solo los últimos 4 caracteres (sub_1Abc...wxyz queda sub_…wxyz)
    .replace(/\b(sub|cus|in|pi|ch|evt|price|prod|cs|ii|il|si|seti|pm|card|src|re)_([A-Za-z0-9]{6,})/g, (m, p, id) => p + '_…' + id.slice(-4))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function aFecha(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  let d = null;
  if (valor instanceof Date) d = valor;
  else if (typeof valor.toDate === 'function') { try { d = valor.toDate(); } catch (_) { d = null; } }
  else if (typeof valor === 'object' && typeof valor.seconds === 'number') d = new Date(valor.seconds * 1000);
  else if (typeof valor === 'number' && Number.isFinite(valor)) d = new Date(valor);
  else if (typeof valor === 'string') d = new Date(valor);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

module.exports = { limpiarTexto, aFecha };
