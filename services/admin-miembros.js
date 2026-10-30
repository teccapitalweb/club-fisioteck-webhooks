'use strict';
// ADMINISTRACIÓN (adaptado de Alintec y Zoorigen): pagos desde Stripe, papelera de miembros y seguimiento de retos y XP.
//  POST /api/admin/pagos/sincronizar              trae de Stripe los cobros (pagados y rechazados) que no quedaron guardados y al día el estado de cada suscripción
//  POST /api/admin/miembros/:uid/eliminar         manda al miembro a la papelera (no entra más; se puede restaurar)
//  GET  /api/admin/papelera                       miembros en la papelera
//  POST /api/admin/papelera/:uid/restaurar        lo devuelve tal como estaba
//  POST /api/admin/papelera/:uid/eliminar-definitivo   libera su correo para que pueda crear una cuenta nueva
//  GET  /api/admin/retos-xp                       XP, nivel, retos por tipo, racha y adelanto de cada miembro
// El avance, los certificados, los logros y los pagos del miembro NUNCA se borran: eliminar solo retira la cuenta del Club.
const { esAdminPorToken } = require('./certificados');
const { nivelDe } = require('./logros');
const { limpiarTexto } = require('./texto-seguro');
const { suscripcionViva } = require('./suscripcion');

const COL_ACCIONES = 'adminAcciones', COL_PAPELERA = 'miembrosPapelera', MAX_MIEMBROS = 500;
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const dia = ms => new Date(ms).toISOString().slice(0, 10);
const TIPOS = { q: 'quiz', o: 'orden', d: 'detective', h: 'historia' };

// ---------- Lógica pura (se prueba sin Stripe ni Firebase) ----------
// ¿Ya está guardado este cobro? Por id de factura; los primeros cobros (del pago inicial) no traen id: se comparan por día y monto.
function yaGuardado(pagos, { id, fecha, monto, rechazado }) {
  return (pagos || []).some(p => {
    const pid = p && (p.stripeInvoiceId || p.invoiceId);
    if (pid) return pid === id;
    const fallido = p && (p.estado === 'failed' || p.status === 'failed');
    return !rechazado && !fallido && String(p.date || '').slice(0, 10) === fecha && Number(p.amount) === monto;
  });
}
// Cobros de Stripe que faltan en el miembro + cambios de estado según su suscripción
function planearSincronizacion(miembro, facturas, suscripcion) {
  const nuevos = [];
  (facturas || []).forEach(f => {
    if (f.status === 'paid' && f.amount_paid > 0) {
      const ms = ((f.status_transitions && f.status_transitions.paid_at) || f.created) * 1000, monto = f.amount_paid / 100;
      if (yaGuardado(miembro.payments, { id: f.id, fecha: dia(ms), monto })) return;
      const anual = f.lines && f.lines.data && f.lines.data[0] && f.lines.data[0].price && f.lines.data[0].price.recurring && f.lines.data[0].price.recurring.interval === 'year';
      nuevos.push({ date: dia(ms), amount: monto, currency: String(f.currency || 'mxn').toUpperCase(), concept: f.billing_reason === 'subscription_create' ? (anual ? 'Membresía anual' : 'Membresía mensual') : (anual ? 'Renovación anual' : 'Renovación mensual'),
        status: 'paid', stripeInvoiceId: f.id, stripeSubscriptionId: f.subscription || '', paymentMethod: 'Stripe', sincronizado: true });
    } else if ((f.status === 'open' || f.status === 'uncollectible') && (f.attempt_count || 0) > 0) {
      const ms = (f.created || 0) * 1000, monto = (f.amount_due || 0) / 100;
      if (yaGuardado(miembro.payments, { id: f.id, fecha: dia(ms), monto, rechazado: true })) return;
      nuevos.push({ date: dia(ms), amount: monto, currency: 'MXN', method: 'Stripe', estado: 'failed', status: 'failed', concept: 'Cobro rechazado', invoiceId: f.id, sincronizado: true });
    }
  });
  const cambios = {};
  if (suscripcion) {
    const fin = suscripcion.current_period_end ? dia(suscripcion.current_period_end * 1000) : '';
    if (fin && ['active', 'trialing', 'past_due'].includes(suscripcion.status) && miembro.nextPaymentDate !== fin && !suscripcion.cancel_at_period_end) cambios.nextPaymentDate = fin;
    if (suscripcion.status === 'active' && suscripcion.cancel_at_period_end && miembro.status !== 'cancelled') Object.assign(cambios, { status: 'cancelled', accessUntil: fin, cancelledAt: dia(Date.now()), nextPaymentDate: fin });
    if (suscripcion.status === 'active' && !suscripcion.cancel_at_period_end && miembro.status === 'cancelled') Object.assign(cambios, { status: 'active', accessUntil: '', cancelledAt: '', nextPaymentDate: fin || miembro.nextPaymentDate || '' });
  }
  return { nuevos, cambios };
}

// deps: { db, admin, stripe, ahora? }
function montarRutasAdminMiembros(app, deps) {
  const { db, admin, stripe } = deps;
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
  async function anotar(d, accion, miembro, texto, datos = {}) {
    const id = ahora().toISOString().replace(/[-:.TZ]/g, '') + '-' + Math.random().toString(36).slice(2, 8);
    await db.collection(COL_ACCIONES).doc(id).set({ en: ahora().toISOString(), quien: String(d.email || '').toLowerCase(), accion, uid: miembro ? miembro.uid : '', miembro: miembro ? limpiarTexto(miembro.name || miembro.email || '', 80) : '',
      correo: miembro ? String(miembro.email || '').toLowerCase().slice(0, 120) : '', texto: limpiarTexto(texto, 240), datos });
  }
  const uidValido = uid => { if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(uid))) throw errorHttp(400, 'Miembro inválido.'); return String(uid); };
  async function autenticacion(uid, cambios) { try { if (admin.auth().updateUser) await admin.auth().updateUser(uid, cambios); } catch (e) { /* la cuenta de acceso ya no existe */ } }

  // ---------- Pagos desde Stripe ----------
  app.post('/api/admin/pagos/sincronizar', conAdmin('sincronizar', async (req, res, d) => {
    if (!stripe) throw errorHttp(503, 'Stripe no está configurado en este servidor.');
    const sn = await db.collection('members').get();
    const miembros = sn.docs.map(x => ({ uid: x.id, ...x.data() })).filter(m => m.stripeSubscriptionId).slice(0, MAX_MIEMBROS);
    const r = { suscripciones: miembros.length, revisados: 0, nuevos: 0, rechazados: 0, actualizados: 0, errores: 0 };
    for (const m of miembros) {
      try {
        const [lista, sub] = await Promise.all([stripe.invoices.list({ subscription: m.stripeSubscriptionId, limit: 100 }), stripe.subscriptions.retrieve(m.stripeSubscriptionId).catch(() => null)]);
        r.revisados += (lista.data || []).length;
        const plan = planearSincronizacion(m, lista.data, sub);
        const upd = {};
        if (plan.nuevos.length) {
          upd.payments = [...(Array.isArray(m.payments) ? m.payments : []), ...plan.nuevos];
          r.nuevos += plan.nuevos.filter(p => p.status === 'paid').length; r.rechazados += plan.nuevos.filter(p => p.status === 'failed').length;
          const ultimo = plan.nuevos.filter(p => p.status === 'paid').map(p => p.date).sort().pop();
          if (ultimo && (!m.lastPaymentDate || ultimo > m.lastPaymentDate)) upd.lastPaymentDate = ultimo;
        }
        Object.assign(upd, plan.cambios);
        if (Object.keys(upd).length) { upd.updatedAt = FieldValue && FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : ahora().toISOString(); await db.collection('members').doc(m.uid).update(upd); r.actualizados++; }
      } catch (e) { r.errores++; console.warn('Sincronización de pagos · miembro', m.uid, '·', e.message); }
    }
    await anotar(d, 'sincronizar-pagos', null, 'Trajo pagos desde Stripe: ' + r.nuevos + ' nuevos, ' + r.rechazados + ' rechazados, ' + r.actualizados + ' miembros actualizados', r);
    res.json({ ok: true, ...r });
  }));

  // ---------- Papelera de miembros ----------
  app.post('/api/admin/miembros/:uid/eliminar', conAdmin('eliminar', async (req, res, d) => {
    const uid = uidValido(req.params.uid), s = await db.collection('members').doc(uid).get();
    if (!s.exists) throw errorHttp(404, 'Ese miembro no existe.');
    const m = { uid, ...s.data() };
    if (esAdminPorToken({ email: m.email, email_verified: true })) throw errorHttp(403, 'Una cuenta de administrador no se elimina desde aquí.');
    // Se pregunta a Stripe (no solo al estado guardado): una suscripción viva seguiría cobrando a una cuenta que ya no existe
    if (await suscripcionViva(stripe, m)) throw errorHttp(409, 'Su suscripción de Stripe sigue viva y podría volver a cobrarle. Primero usa «Quitar acceso» (cancela el cobro) y luego elimínalo.');
    const copia = { ...s.data(), uid, eliminadoPor: String(d.email || ''), eliminadoEn: ahora().toISOString(), mensajeEliminar: limpiarTexto(req.body && req.body.mensaje, 200) };
    await db.collection(COL_PAPELERA).doc(uid).set(copia);
    await autenticacion(uid, { disabled: true });
    try { const dir = await db.collection('directorio').doc(uid).get(); if (dir.exists) await db.collection('directorio').doc(uid).set({ publicado: false }, { merge: true }); } catch (e) { /* sin tarjeta */ }
    await db.collection('members').doc(uid).delete();
    await anotar(d, 'eliminar-miembro', m, 'Mandó a la papelera (su avance, certificados y pagos se conservan)' + (copia.mensajeEliminar ? ' · ' + copia.mensajeEliminar : ''), {});
    res.json({ ok: true });
  }));
  app.get('/api/admin/papelera', conAdmin('papelera', async (req, res) => {
    const sn = await db.collection(COL_PAPELERA).limit(300).get();
    const filas = sn.docs.map(x => { const v = x.data() || {}; return { uid: x.id, name: v.name || '', email: v.email || '', plan: v.plan || '', status: v.status || '', pagos: Array.isArray(v.payments) ? v.payments.length : 0, eliminadoPor: v.eliminadoPor || '', eliminadoEn: v.eliminadoEn || '', mensaje: v.mensajeEliminar || '' }; })
      .sort((a, b) => String(b.eliminadoEn).localeCompare(String(a.eliminadoEn)));
    res.json({ ok: true, miembros: filas });
  }));
  app.post('/api/admin/papelera/:uid/restaurar', conAdmin('restaurar', async (req, res, d) => {
    const uid = uidValido(req.params.uid), s = await db.collection(COL_PAPELERA).doc(uid).get();
    if (!s.exists) throw errorHttp(404, 'Ese miembro no está en la papelera.');
    if ((await db.collection('members').doc(uid).get()).exists) throw errorHttp(409, 'Ese miembro ya tiene una cuenta activa.');
    const { eliminadoPor, eliminadoEn, mensajeEliminar, ...datos } = s.data() || {}; delete datos.uid;
    await db.collection('members').doc(uid).set({ ...datos, restauradoPor: String(d.email || ''), restauradoEn: ahora().toISOString() });
    await autenticacion(uid, { disabled: false });
    await db.collection(COL_PAPELERA).doc(uid).delete();
    await anotar(d, 'restaurar-miembro', { uid, ...datos }, 'Lo restauró desde la papelera', {});
    res.json({ ok: true });
  }));
  app.post('/api/admin/papelera/:uid/eliminar-definitivo', conAdmin('eliminar-definitivo', async (req, res, d) => {
    const uid = uidValido(req.params.uid), s = await db.collection(COL_PAPELERA).doc(uid).get();
    if (!s.exists) throw errorHttp(404, 'Ese miembro no está en la papelera.');
    const v = { uid, ...s.data() };
    try { if (admin.auth().deleteUser) await admin.auth().deleteUser(uid); } catch (e) { /* ya no existe */ }
    await db.collection(COL_PAPELERA).doc(uid).delete();
    await anotar(d, 'eliminar-definitivo', v, 'Eliminó su cuenta de acceso para siempre (su avance y certificados se conservan)', {});
    res.json({ ok: true });
  }));

  // ---------- Retos y XP ----------
  app.get('/api/admin/retos-xp', conAdmin('retos-xp', async (req, res) => {
    const [ms, cl] = await Promise.all([db.collection('members').limit(MAX_MIEMBROS).get(), db.collection('retosClasificacion').limit(MAX_MIEMBROS).get()]);
    const clas = {}; cl.docs.forEach(x => { clas[x.id] = x.data() || {}; });
    const leer = async (uid, doc) => { try { const s = await db.collection('members').doc(uid).collection('progress').doc(doc).get(); return s.exists ? (s.data() || {}) : {}; } catch (_) { return {}; } };
    const filas = await Promise.all(ms.docs.map(async x => {
      const m = x.data() || {}, uid = x.id, [retos, logros, premios] = await Promise.all([leer(uid, 'retos'), leer(uid, 'logros'), leer(uid, 'premios')]);
      const ids = Object.keys(retos.superados || {}), porTipo = { quiz: 0, orden: 0, detective: 0, historia: 0 };
      ids.forEach(id => { const t = TIPOS[String(id).charAt(0)]; if (t && String(id).charAt(1) === '-') porTipo[t]++; });
      const xp = Number((clas[uid] || {}).xp) || 0, n = nivelDe(xp);
      return { uid, name: m.name || '', email: m.email || '', plan: m.plan || '', status: m.status || '', xp, nivel: n.nombre, nivelIndice: n.indice, retos: ids.length, porTipo, racha: Number(logros.racha) || 0, ultimaVisita: logros.ultimaVisita || '', adelanto: premios.adelantoRetos ? String(premios.adelantoRetos.cursoId || '') : '', ranking: !(clas[uid] || {}).oculto };
    }));
    filas.sort((a, b) => b.xp - a.xp || b.retos - a.retos);
    const conXp = filas.filter(f => f.xp > 0), porNivel = {}, porTipo = { quiz: 0, orden: 0, detective: 0, historia: 0 };
    filas.forEach(f => { porNivel[f.nivel] = (porNivel[f.nivel] || 0) + 1; Object.keys(porTipo).forEach(t => { porTipo[t] += f.porTipo[t]; }); });
    res.json({ ok: true, resumen: { miembros: filas.length, conXp: conXp.length, xpTotal: conXp.reduce((t, f) => t + f.xp, 0), xpPromedio: conXp.length ? Math.round(conXp.reduce((t, f) => t + f.xp, 0) / conXp.length) : 0, retosSuperados: filas.reduce((t, f) => t + f.retos, 0), adelantosUsados: filas.filter(f => f.adelanto).length, porNivel, porTipo }, miembros: filas });
  }));

  // ---------- Moderación del directorio ----------
  // La lista de tarjetas ocultas vive en directorioModeracion/{uid} (solo la escribe el servidor): así una persona no puede "quitar" la marca
  // borrando y volviendo a crear su tarjeta. El Club recibe las ocultas en GET /api/directorio/meta y no las muestra.
  const COL_MOD = 'directorioModeracion';
  const tarjetaCorta = (uid, t, mod) => ({ uid, nombre: t.nombre || '', puesto: t.puesto || '', empresa: t.empresa || '', ciudad: t.ciudad || '', especialidad: t.especialidad || '', bio: t.bio || '', estado: t.estado || '', publicado: t.publicado === true, oculta: !!(mod && mod.oculta), ocultaPor: (mod && mod.por) || '', ocultaEn: (mod && mod.en) || '', motivo: (mod && mod.motivo) || '' });
  app.get('/api/admin/directorio', conAdmin('directorio', async (req, res) => {
    const [ts, ms] = await Promise.all([db.collection('directorio').limit(500).get(), db.collection(COL_MOD).limit(500).get()]);
    const mod = {}; ms.docs.forEach(x => { mod[x.id] = x.data() || {}; });
    const tarjetas = ts.docs.map(x => tarjetaCorta(x.id, x.data() || {}, mod[x.id]));
    res.json({ ok: true, tarjetas, resumen: { total: tarjetas.length, visibles: tarjetas.filter(t => t.publicado && !t.oculta).length, privadas: tarjetas.filter(t => !t.publicado).length, ocultas: tarjetas.filter(t => t.oculta).length } });
  }));
  const tarjetaDe = async uid => { const s = await db.collection('directorio').doc(uidValido(uid)).get(); if (!s.exists) throw errorHttp(404, 'Esa tarjeta no existe.'); return { uid, ...s.data() }; };
  app.post('/api/admin/directorio/:uid/ocultar', conAdmin('dir-ocultar', async (req, res, d) => {
    const t = await tarjetaDe(req.params.uid), motivo = limpiarTexto(req.body && req.body.motivo, 200);
    await db.collection(COL_MOD).doc(t.uid).set({ oculta: true, por: String(d.email || ''), en: ahora().toISOString(), motivo });
    await db.collection('directorio').doc(t.uid).set({ visible: false }, { merge: true });
    await anotar(d, 'directorio-ocultar', { uid: t.uid, name: t.nombre }, 'Ocultó la tarjeta del directorio' + (motivo ? ' · ' + motivo : ''), { motivo });
    res.json({ ok: true });
  }));
  app.post('/api/admin/directorio/:uid/mostrar', conAdmin('dir-mostrar', async (req, res, d) => {
    const t = await tarjetaDe(req.params.uid);
    await db.collection(COL_MOD).doc(t.uid).delete();
    await db.collection('directorio').doc(t.uid).set({ visible: true }, { merge: true });
    await anotar(d, 'directorio-mostrar', { uid: t.uid, name: t.nombre }, 'Volvió a mostrar la tarjeta del directorio', {});
    res.json({ ok: true });
  }));
  app.post('/api/admin/directorio/:uid/eliminar', conAdmin('dir-eliminar', async (req, res, d) => {
    const t = await tarjetaDe(req.params.uid), motivo = limpiarTexto(req.body && req.body.motivo, 200);
    await db.collection('directorio').doc(t.uid).delete(); // si estaba oculta, la marca de moderación se conserva
    await anotar(d, 'directorio-eliminar', { uid: t.uid, name: t.nombre }, 'Eliminó la tarjeta del directorio' + (motivo ? ' · ' + motivo : ''), { motivo, nombre: t.nombre || '', empresa: t.empresa || '', bio: String(t.bio || '').slice(0, 200) });
    res.json({ ok: true });
  }));
}

module.exports = { montarRutasAdminMiembros, planearSincronizacion, yaGuardado };
