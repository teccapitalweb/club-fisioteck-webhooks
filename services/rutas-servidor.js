'use strict';
// ADMINISTRACIÓN: historial del servidor, acciones sobre miembros y bitácora de quién hizo qué.
//  GET  /api/admin/servidor/historial?dias=30        reinicios, caídas, errores agrupados y último aviso de Stripe
//  POST /api/admin/servidor/reconocer-reinicios      marca los reinicios inesperados ya revisados como publicaciones normales
//  GET  /api/admin/acciones?limite=100               bitácora: quién hizo qué desde el panel (nunca se borra)
//  POST /api/admin/miembros/:uid/activar             { plan: 'mensual'|'anual', dias?, mensaje? }  activa sin cobro (cortesía o ajuste)
//  POST /api/admin/miembros/:uid/regalar             { dias?: 1..365 (30), mensaje? }              suma días al acceso actual
//  POST /api/admin/miembros/:uid/cancelar            { mensaje? }                                  cancela YA su suscripción de Stripe y pasa la cuenta a sin membresía
// Nada se borra: solo cambia el estado de acceso. El avance, los certificados, los pagos y el historial del miembro se conservan.
const { esAdminPorToken } = require('./certificados');
const { limpiarTexto, aFecha } = require('./texto-seguro');
const { cancelarEnStripe } = require('./suscripcion');

const COL_ACCIONES = 'adminAcciones';
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const dos = n => String(n).padStart(2, '0');
const fmtFecha = d => d.getUTCFullYear() + '-' + dos(d.getUTCMonth() + 1) + '-' + dos(d.getUTCDate());

function montarRutasServidor(app, deps) {
  const { db, admin, bitacora } = deps;
  const FieldValue = admin && admin.firestore && admin.firestore.FieldValue;
  const ahora = deps.ahora || (() => new Date());

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    let d; try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
    if (!esAdminPorToken(d)) { res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' }); return null; }
    return d;
  }
  const conAdmin = (etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { const d = await sesion(req, res); if (d) await fn(req, res, d); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[admin ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };

  // Bitácora: una línea por acción, con quién, a quién y cuándo. Nunca se borra.
  async function anotar(d, accion, miembro, texto, datos = {}) {
    const id = ahora().toISOString().replace(/[-:.TZ]/g, '') + '-' + Math.random().toString(36).slice(2, 8);
    await db.collection(COL_ACCIONES).doc(id).set({
      en: ahora().toISOString(), quien: String(d.email || '').toLowerCase(), accion, uid: miembro ? miembro.uid : '', miembro: miembro ? limpiarTexto(miembro.name || miembro.email || '', 80) : '',
      correo: miembro ? String(miembro.email || '').toLowerCase().slice(0, 120) : '', texto: limpiarTexto(texto, 240), datos
    });
  }
  async function leerMiembro(uid) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(uid))) throw errorHttp(400, 'Miembro inválido.');
    const s = await db.collection('members').doc(uid).get();
    if (!s.exists) throw errorHttp(404, 'Ese miembro no existe.');
    return { uid, ...s.data() };
  }
  const mensajeDe = b => limpiarTexto(b && b.mensaje, 200);
  const marca = () => (FieldValue && FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : ahora().toISOString());

  // ----- Historial del servidor -----
  app.get('/api/admin/servidor/historial', conAdmin('historial', async (req, res) => {
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);
    if (!bitacora) return res.json({ ok: true, disponible: false });
    res.json({ ok: true, disponible: true, ...(await bitacora.leerHistorial({ dias })) });
  }));
  app.post('/api/admin/servidor/reconocer-reinicios', conAdmin('reconocer', async (req, res, d) => {
    const n = bitacora ? await bitacora.reconocerReinicios() : 0;
    await anotar(d, 'reconocer-reinicios', null, 'Marcó ' + n + ' reinicio(s) inesperado(s) como publicaciones normales', { n });
    res.json({ ok: true, reconocidos: n });
  }));

  // ----- Bitácora de acciones -----
  app.get('/api/admin/acciones', conAdmin('acciones', async (req, res) => {
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 100, 1), 500);
    const sn = await db.collection(COL_ACCIONES).orderBy('en', 'desc').limit(limite).get();
    res.json({ ok: true, acciones: sn.docs.map(x => ({ id: x.id, ...x.data() })) });
  }));

  // ----- Acciones sobre miembros (con bitácora) -----
  app.post('/api/admin/miembros/:uid/activar', conAdmin('activar', async (req, res, d) => {
    const m = await leerMiembro(req.params.uid), b = req.body || {};
    if (!['mensual', 'anual'].includes(b.plan)) throw errorHttp(400, 'El plan debe ser mensual o anual.');
    const dias = b.dias === undefined ? (b.plan === 'anual' ? 365 : 30) : Number(b.dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 730) throw errorHttp(400, 'Los días deben ser un entero de 1 a 730.');
    const hasta = ahora(); hasta.setUTCDate(hasta.getUTCDate() + dias);
    await db.collection('members').doc(m.uid).update({
      status: 'active', plan: b.plan, nextPaymentDate: fmtFecha(hasta), accessUntil: '', cancelledAt: '', canceladoPor: '', activadoManualmente: true, activadoPor: String(d.email || ''), activadoEn: ahora().toISOString(), updatedAt: marca()
    });
    await anotar(d, 'activar', m, 'Activó el plan ' + b.plan + ' sin cobro por ' + dias + ' días' + (mensajeDe(b) ? ' · ' + mensajeDe(b) : ''), { plan: b.plan, dias, hasta: fmtFecha(hasta), mensaje: mensajeDe(b) });
    res.json({ ok: true, plan: b.plan, hasta: fmtFecha(hasta) });
  }));

  app.post('/api/admin/miembros/:uid/regalar', conAdmin('regalar', async (req, res, d) => {
    const m = await leerMiembro(req.params.uid), b = req.body || {};
    const dias = b.dias === undefined ? 30 : Number(b.dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 365) throw errorHttp(400, 'Los días deben ser un entero de 1 a 365.');
    const hoy = ahora(); hoy.setUTCHours(0, 0, 0, 0);
    const actual = aFecha(m.accessUntil || m.nextPaymentDate);
    const base = Math.max(hoy.getTime(), actual ? actual.getTime() : 0);
    const nueva = new Date(base); nueva.setUTCDate(nueva.getUTCDate() + dias);
    const upd = { status: 'active', nextPaymentDate: fmtFecha(nueva), giftedAt: fmtFecha(hoy), updatedAt: marca() };
    if (m.accessUntil) upd.accessUntil = fmtFecha(nueva);
    const regalo = { fecha: ahora().toISOString(), dias, por: String(d.email || ''), mensaje: mensajeDe(b) };
    if (FieldValue && FieldValue.arrayUnion) upd.regalos = FieldValue.arrayUnion(regalo); else upd.regalos = [...(Array.isArray(m.regalos) ? m.regalos : []), regalo];
    await db.collection('members').doc(m.uid).update(upd);
    await anotar(d, 'regalar', m, 'Regaló ' + dias + ' días (hasta el ' + fmtFecha(nueva) + ')' + (regalo.mensaje ? ' · ' + regalo.mensaje : ''), { dias, hasta: fmtFecha(nueva), mensaje: regalo.mensaje });
    res.json({ ok: true, hasta: fmtFecha(nueva) });
  }));

  app.post('/api/admin/miembros/:uid/cancelar', conAdmin('cancelar', async (req, res, d) => {
    const m = await leerMiembro(req.params.uid), b = req.body || {};
    // Primero se cancela el cobro en Stripe: si Stripe falla, no se quita el acceso (si no, se le seguiría cobrando sin acceso)
    const st = await cancelarEnStripe(deps.stripe, m.suscripcionTerminada ? '' : m.stripeSubscriptionId);
    await db.collection('members').doc(m.uid).update({ status: 'inactive', accessUntil: '', pagoPendiente: false, ...(m.stripeSubscriptionId ? { suscripcionTerminada: true, stripeCancelled: true } : {}), canceladoPor: String(d.email || ''), canceladoEn: ahora().toISOString(), updatedAt: marca() });
    await anotar(d, 'cancelar', m, 'Quitó el acceso' + (st.cancelada ? ' y canceló su suscripción en Stripe' : '') + ' (la cuenta pasa a sin membresía; todo su historial se conserva)' + (mensajeDe(b) ? ' · ' + mensajeDe(b) : ''), { mensaje: mensajeDe(b), stripeCancelada: !!st.cancelada });
    res.json({ ok: true, stripeCancelada: !!st.cancelada });
  }));
}

module.exports = { montarRutasServidor, COL_ACCIONES };
