'use strict';
// SUSCRIPCIÓN DE STRIPE: reglas que comparten el cobro, el webhook y el panel (como Alintec y Zoorigen).
//  · bloqueoDeCobro: no se abre un segundo cobro si la persona ya tiene una suscripción que sigue viva.
//  · cambiosPorSuscripcion: customer.subscription.updated → estado del miembro (cancelar/reactivar desde el portal, past_due, unpaid).
//  · cambiosPorCobroFallido: un cobro rechazado NO corta el acceso mientras Stripe reintenta; deja unos días de gracia.
//  · cancelarEnStripe: cancelación inmediata (quitar acceso desde el panel); si Stripe falla no se toca nada.
const DIAS_GRACIA = 7;
const dos = n => String(n).padStart(2, '0');
const fmtFecha = d => d.getUTCFullYear() + '-' + dos(d.getUTCMonth() + 1) + '-' + dos(d.getUTCDate());
const deSegundos = s => (Number(s) > 0 ? fmtFecha(new Date(Number(s) * 1000)) : '');
function aFecha(v) {
  if (!v) return null;
  const d = v.toDate ? v.toDate() : new Date(String(v).length === 10 ? v + 'T23:59:59' : v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function errorHttp(status, mensaje, codigo) { const e = new Error(mensaje); e.status = status; if (codigo) e.codigo = codigo; return e; }

// Fin del periodo pagado de una factura o suscripción (la fecha real de Stripe, no "hoy + 1 mes")
function finDePeriodo(obj) {
  if (!obj) return '';
  if (obj.current_period_end) return deSegundos(obj.current_period_end);
  const linea = obj.lines && obj.lines.data && obj.lines.data[0];
  return linea && linea.period && linea.period.end ? deSegundos(linea.period.end) : '';
}

// ¿Se puede abrir un cobro nuevo? → null si sí; { status, mensaje, codigo } si no.
function bloqueoDeCobro(m, tieneMembresia) {
  if (!m || !m.stripeSubscriptionId || m.suscripcionTerminada) return null;
  if (m.pagoPendiente) return { status: 409, codigo: 'pago-pendiente', mensaje: 'Tu último cobro fue rechazado y Stripe lo sigue intentando. Actualiza tu tarjeta en «Gestionar en Stripe» para no pagar dos veces.' };
  if (!tieneMembresia(m)) return null;
  if (m.status === 'cancelled') return { status: 409, codigo: 'reactivar', mensaje: 'Tu membresía está cancelada pero sigue vigente hasta el ' + (m.accessUntil || m.nextPaymentDate || '') + '. Reactívala en lugar de pagar de nuevo.' };
  return { status: 409, codigo: 'ya-activa', mensaje: 'Ya tienes una membresía activa. No hace falta pagar de nuevo.' };
}

// customer.subscription.updated → cambios al miembro (null = no tocar)
function cambiosPorSuscripcion(sub, m) {
  if (!sub || !m) return null;
  if (m.stripeSubscriptionId && m.stripeSubscriptionId !== sub.id) return null; // suscripción vieja: no manda
  if (m.status === 'inactive' && m.canceladoPor) return null; // el administrador quitó el acceso: no se revierte
  const fin = finDePeriodo(sub);
  switch (sub.status) {
    case 'active':
    case 'trialing':
      if (sub.cancel_at_period_end) return { status: 'cancelled', cancelledAt: m.cancelledAt || fmtFecha(new Date()), accessUntil: fin || m.nextPaymentDate || '', stripeCancelled: true, pagoPendiente: false };
      return { status: 'active', accessUntil: '', cancelledAt: '', stripeCancelled: false, pagoPendiente: false, paymentFailedAt: '', ...(fin ? { nextPaymentDate: fin } : {}) };
    case 'past_due':
      return { pagoPendiente: true };
    case 'unpaid':
    case 'incomplete_expired':
    case 'canceled':
      // Stripe dejó de intentar: el acceso termina (quien canceló a fin de periodo y no debía nada conserva su fecha)
      if (m.status === 'cancelled' && !m.pagoPendiente) return { pagoPendiente: false, suscripcionTerminada: true };
      return { status: 'inactive', accessUntil: '', pagoPendiente: false, suscripcionTerminada: true };
    default:
      return null;
  }
}

// invoice.payment_failed → el acceso sigue hasta el fin de su periodo o, como mínimo, DIAS_GRACIA días desde hoy
function cambiosPorCobroFallido(m, hoy) {
  const hoyStr = fmtFecha(hoy);
  const gracia = new Date(hoy); gracia.setUTCDate(gracia.getUTCDate() + DIAS_GRACIA);
  const actual = aFecha(m && (m.accessUntil || m.nextPaymentDate));
  const cambios = { paymentFailedAt: hoyStr, pagoPendiente: true };
  if (m && m.status === 'cancelled') return cambios; // ya cancelada: conserva su fecha
  if (!actual || actual < gracia) cambios.accessUntil = fmtFecha(gracia);
  return cambios;
}

// Cancela YA la suscripción (quitar acceso). Una suscripción que ya no existe o ya está cancelada cuenta como cancelada.
async function cancelarEnStripe(stripe, subId) {
  if (!subId) return { cancelada: false, sinSuscripcion: true };
  if (!stripe) throw errorHttp(503, 'Stripe no está configurado: no se quitó el acceso para no seguir cobrando sin control.');
  try { await stripe.subscriptions.cancel(subId); return { cancelada: true }; }
  catch (e) {
    const msg = String(e && e.message || '');
    if ((e && e.code === 'resource_missing') || /canceled|cancelled/i.test(msg)) return { cancelada: true, yaEstaba: true };
    throw errorHttp(502, 'Stripe no pudo cancelar la suscripción (' + msg.slice(0, 120) + '). No se quitó el acceso para no seguir cobrando.');
  }
}

// ¿La suscripción de Stripe sigue viva (puede volver a cobrar)?
async function suscripcionViva(stripe, m) {
  if (!m || !m.stripeSubscriptionId) return false;
  if (stripe) {
    try { const s = await stripe.subscriptions.retrieve(m.stripeSubscriptionId); return !['canceled', 'incomplete_expired'].includes(s.status); }
    catch (e) { if (e && e.code === 'resource_missing') return false; }
  }
  return !m.suscripcionTerminada && (['active', 'paid', 'cancelled'].includes(m.status) || !!m.pagoPendiente);
}

// REVISIÓN PERIÓDICA DE SUSCRIPCIONES: sustituye al aviso customer.subscription.updated cuando no se puede
// agregar al webhook (sin acceso al panel de Stripe). El servidor le pregunta a Stripe por cada suscripción
// guardada y aplica los mismos cambios que aplicaría el aviso: cancelar o reactivar desde el portal de Stripe,
// pago pendiente (past_due) y suscripción terminada (unpaid/canceled). Solo escribe cuando algo cambió.
async function sincronizarSuscripciones(db, stripe, { limite = 400, ahora = () => new Date() } = {}) {
  const r = { revisados: 0, cambiados: 0, errores: 0 };
  if (!db || !stripe) return r;
  const sn = await db.collection('members').limit(limite).get();
  for (const doc of sn.docs) {
    const m = { uid: doc.id, ...(doc.data() || {}) };
    if (!m.stripeSubscriptionId || m.suscripcionTerminada) continue;
    r.revisados++;
    let sub;
    try { sub = await stripe.subscriptions.retrieve(m.stripeSubscriptionId); }
    catch (e) {
      if (e && e.code === 'resource_missing') sub = { id: m.stripeSubscriptionId, status: 'canceled' }; // ya no existe en Stripe
      else { r.errores++; continue; }
    }
    const cambios = cambiosPorSuscripcion(sub, m);
    if (!cambios) continue;
    const distinto = Object.keys(cambios).some(k => String(m[k] === undefined || m[k] === null ? '' : m[k]) !== String(cambios[k] === undefined || cambios[k] === null ? '' : cambios[k]));
    if (!distinto) continue;
    await db.collection('members').doc(m.uid).update({ ...cambios, updatedAt: ahora().toISOString() });
    console.log('[suscripciones] ' + (m.email || m.uid) + ' → ' + (cambios.status || 'sin cambio de estado') + (cambios.pagoPendiente ? ' · pago pendiente' : '') + (cambios.suscripcionTerminada ? ' · terminada' : ''));
    r.cambiados++;
  }
  return r;
}

module.exports = { bloqueoDeCobro, cambiosPorSuscripcion, cambiosPorCobroFallido, cancelarEnStripe, suscripcionViva, finDePeriodo, sincronizarSuscripciones, DIAS_GRACIA };
