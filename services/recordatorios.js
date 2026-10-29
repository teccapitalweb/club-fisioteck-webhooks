'use strict';
// RECORDATORIOS DE PAGO · unión con el servidor de FisioTeck (misma serie que Alintec y Zoorigen; ver recordatorios-pago.js).
// Envía correos (Resend) con cupones únicos de Stripe a quien se registró y NUNCA ha pagado. ARRANCA APAGADO: el administrador lo
// activa desde el panel. Para el pago y el arranque, server.js solo llama a:
//   rec.montarRutas(app)                         rutas de baja, cupón, preferencia y panel
//   rec.aplicarCupon(sessionConfig, uid, plan, email)   en create-checkout: aplica el cupón vigente al plan mensual
//   rec.cerrarSerie(session, uid)                en checkout.session.completed: cierra la serie de esa persona
//   rec.iniciarTarea()                           revisión cada 20 minutos (RECORDATORIOS_TAREA=off la desactiva)
const R = require('./recordatorios-pago');
const { crearServicio, MARCA } = require('./recordatorios-servicio');
const { montarRutasRecordatorios } = require('./rutas-recordatorios');
const { correosAdministrador } = require('./certificados');
const correo = require('./correo');

function crearRecordatorios({ db, admin, stripe, tieneMembresia, cargarCatalogo, leerPreciosConfig, apiPublica }) {
  const claveBaja = () => R.claveDeBaja(process.env.CERT_SIGNING_KEY || '');
  const API = () => String(process.env.API_URL || apiPublica || '').replace(/\/+$/, '');

  const servicio = crearServicio({
    db, auth: admin.auth(), stripe,
    enviarCorreo: args => correo.enviarConResend(args),
    correoConfigurado: () => correo.configurado(),
    tieneAcceso: m => tieneMembresia(m),
    correosAdmin: () => [...correosAdministrador()],
    claveBaja: claveBaja(),
    urls: {
      compra: correo.CLUB() + '/',
      baja: (uid, firma) => API() + '/baja-recordatorios?u=' + encodeURIComponent(uid) + '&t=' + encodeURIComponent(firma)
    },
    leerPrecioMes: async () => (await leerPreciosConfig()).precioMes,
    leerCursosPrueba: async () => { try { return new Map((cargarCatalogo().courses || []).map(c => [String(c.courseId), String(c.title || '').slice(0, 120)])); } catch (_) { return new Map(); } }
  });

  // Checkout: solo el plan mensual y solo si Stripe confirma que el código sigue vivo. Nunca bloquea el pago.
  async function aplicarCupon(sessionConfig, uid, plan, email) {
    if (plan !== 'mensual' || !uid) return null;
    try {
      const snap = await db.collection('members').doc(uid).get();
      const m = snap.exists ? snap.data() : null;
      // el uid llega del navegador: solo se aplica si el correo del checkout es el de esa cuenta
      if (!m || String(m.email || '').trim().toLowerCase() !== String(email || '').trim().toLowerCase()) return null;
      const c = await servicio.cuponParaCheckout(uid, m);
      if (!c) return null;
      sessionConfig.discounts = [{ promotion_code: c.promoId }];
      sessionConfig.metadata = { ...sessionConfig.metadata, recordatorioPromoId: c.promoId, recordatorioCodigo: c.codigo, recordatorioPaso: String(c.paso) };
      return c;
    } catch (e) { console.warn('[Recordatorios] No se pudo revisar el cupón; se cobra sin él:', e && e.message); return null; }
  }
  // Si Stripe rechaza el cupón (venció justo ahora), se vuelve a armar la sesión sin él
  function sinCupon(sessionConfig) {
    const normal = { ...sessionConfig, metadata: { ...sessionConfig.metadata } };
    delete normal.discounts; delete normal.metadata.recordatorioPromoId; delete normal.metadata.recordatorioCodigo; delete normal.metadata.recordatorioPaso;
    return normal;
  }

  // Tras un pago confirmado: la persona deja de ser elegible y, si pagó con un código de estos recordatorios, queda como convertida.
  async function cerrarSerie(session, uid) {
    try {
      if (!uid) return;
      let promoId = String((session.metadata && session.metadata.recordatorioPromoId) || '');
      let codigo = String((session.metadata && session.metadata.recordatorioCodigo) || '');
      let pasoCupon = Number(session.metadata && session.metadata.recordatorioPaso) || 0;
      const descuento = Number(session.total_details && session.total_details.amount_discount) || 0;
      if (descuento <= 0) { promoId = ''; codigo = ''; pasoCupon = 0; }
      const r = await servicio.registrarPago({ uid, promoId, codigo, pasoCupon, marca: promoId ? MARCA : '', prueba: false });
      if (r && r.cerrada) console.log('📧 Recordatorios: serie cerrada para', uid, r.conCupon ? '(convertida con cupón, paso ' + r.paso + ')' : '(pagó sin cupón)');
    } catch (e) { console.error('[Recordatorios] No se pudo cerrar la serie de', uid, '·', e && e.message); }
  }

  function iniciarTarea() {
    if ((process.env.RECORDATORIOS_TAREA || '').trim().toLowerCase() === 'off') return false;
    const corrida = () => servicio.procesar()
      .then(r => { if (r && (r.enviados || r.fallos)) console.log('📧 Recordatorios de pago · enviados:', r.enviados, '· fallos:', r.fallos, '· vencidas:', r.vencidas); })
      .catch(e => console.error('Recordatorios de pago (corrida) error:', e && e.message));
    setTimeout(corrida, 90 * 1000).unref();
    setInterval(corrida, R.CONFIG.intervaloCronMs).unref();
    console.log('📧 Recordatorios de pago: revisión cada 20 minutos (envía solo si el panel los activó)');
    return true;
  }

  return {
    servicio, aplicarCupon, sinCupon, cerrarSerie, iniciarTarea,
    montarRutas: app => montarRutasRecordatorios(app, { db, admin, recordatorios: servicio, claveBaja })
  };
}

module.exports = { crearRecordatorios };
