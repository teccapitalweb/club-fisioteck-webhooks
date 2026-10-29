// Eliminar mi cuenta (Mi perfil): la persona puede borrar su cuenta cuando quiera y se borra TODO lo suyo.
//  POST /api/cuenta/eliminar  { confirmar: "ELIMINAR" }  (sesión de Firebase)
// Orden: 1) cancela su suscripción de Stripe de inmediato (si falla, NO se borra nada para no seguir cobrando),
//        2) borra sus datos del Club (miembro y todo lo que cuelga de él, avance, logros, certificados, reseñas, directorio, referidos,
//           créditos, foro), 3) borra su acceso (Firebase Auth). Los cuentas de administrador no se pueden borrar desde aquí.
// Stripe conserva sus propios registros de cobros por obligación fiscal; aquí no se guarda nada de eso.
const { esAdminPorToken } = require('./certificados');

const PALABRA = 'ELIMINAR';
const TOPE = 2000;

function errorHttp(status, mensaje) { const e = new Error(mensaje); e.status = status; return e; }

// Borra un documento y todo lo que cuelga de él (subcolecciones). En Firestore real usa recursiveDelete.
async function borrarConHijos(db, ref) {
  if (typeof db.recursiveDelete === 'function') { await db.recursiveDelete(ref); return; }
  await ref.delete();
}

async function borrarPorCampo(db, coleccion, campo, valor, { hijos = false } = {}) {
  let n = 0;
  const sn = await db.collection(coleccion).where(campo, '==', valor).limit(TOPE).get();
  for (const doc of sn.docs) {
    const ref = db.collection(coleccion).doc(doc.id);
    if (hijos) await borrarConHijos(db, ref); else await ref.delete();
    n++;
  }
  return n;
}

function crearEliminadorDeCuenta({ db, admin, stripe }) {
  return async function eliminarCuenta(uid, email) {
    const resumen = { stripe: 'sin suscripción', borrados: 0 };
    const mref = db.collection('members').doc(uid), ms = await mref.get(), m = ms.exists ? ms.data() || {} : {};
    const correo = String(email || m.email || '').toLowerCase();

    // 1) Cobros: se cancela YA. Si Stripe falla por otra razón, se detiene todo.
    if (m.stripeSubscriptionId && stripe && stripe.subscriptions) {
      try { await stripe.subscriptions.cancel(m.stripeSubscriptionId); resumen.stripe = 'cancelada'; }
      catch (e) {
        if (e && (e.code === 'resource_missing' || /No such subscription|canceled/i.test(String(e.message)))) resumen.stripe = 'ya estaba cancelada';
        else throw errorHttp(502, 'No pudimos cancelar tu suscripción en este momento. No se borró nada; inténtalo de nuevo en unos minutos.');
      }
    }

    // 2) Datos del Club. Cada paso es independiente: si uno falla no impide los demás (el administrador puede reintentar).
    const pasos = [
      () => borrarConHijos(db, mref),
      () => db.collection('directorio').doc(uid).delete(),
      () => db.collection('directorioModeracion').doc(uid).delete(),
      () => db.collection('canjes').doc(uid).delete(),
      () => db.collection('referidos').doc(uid).delete(),
      () => db.collection('dispositivosAnfitrion').doc(uid).delete(),
      () => db.collection('recordatoriosPago').doc(uid).delete(),
      () => db.collection('metricasMiembros').doc(uid).delete(),
      () => db.collection('retosClasificacion').doc(uid).delete(),
      () => db.collection('miembrosPapelera').doc(uid).delete(),
      () => correo ? db.collection('pending_members').doc(correo).delete() : null,
      () => borrarPorCampo(db, 'certificados', 'uid', uid),
      () => borrarPorCampo(db, 'resenas', 'uid', uid),
      () => borrarPorCampo(db, 'codigosReferido', 'uid', uid),
      () => borrarPorCampo(db, 'forum_posts', 'authorId', uid, { hijos: true }),
      // quienes la invitaron ya no apuntan a una cuenta que no existe
      async () => { const sn = await db.collection('referidos').where('anfitrionUid', '==', uid).limit(TOPE).get(); for (const d of sn.docs) await db.collection('referidos').doc(d.id).update({ anfitrionUid: '' }); }
    ];
    for (const paso of pasos) { try { await paso(); resumen.borrados++; } catch (e) { console.error('[eliminar cuenta] paso omitido:', e && e.message); } }

    // 3) Acceso
    try { const au = admin.auth(); if (au.deleteUser) await au.deleteUser(uid); } catch (e) { if (!e || e.code !== 'auth/user-not-found') throw errorHttp(500, 'Se borraron tus datos, pero no se pudo cerrar tu acceso. Escríbenos para terminarlo.'); }
    return resumen;
  };
}

function montarRutasCuenta(app, deps) {
  const { db, admin, stripe } = deps;
  const eliminar = crearEliminadorDeCuenta({ db, admin, stripe });
  app.post('/api/cuenta/eliminar', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (!m) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
      let d; try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { return res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); }
      if (esAdminPorToken(d)) return res.status(403).json({ error: 'Las cuentas de administrador no se pueden eliminar desde aquí.' });
      if (!req.body || String(req.body.confirmar || '').trim().toUpperCase() !== PALABRA) return res.status(400).json({ error: 'Escribe ' + PALABRA + ' para confirmar.' });
      const r = await eliminar(d.uid, d.email);
      console.log('[cuenta eliminada] uid ' + d.uid + ' · stripe: ' + r.stripe);
      res.json({ ok: true });
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[eliminar cuenta]', e && e.message);
      res.status(500).json({ error: 'No se pudo eliminar la cuenta. Inténtalo de nuevo.' });
    }
  });

  // ---- Lo que el Club hacía directamente en Firestore y las reglas estrictas ya no permiten desde el navegador ----
  async function conSesion(req, res, fn) {
    res.set('Cache-Control', 'private, no-store');
    try {
      const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (!m) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
      let d; try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { return res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); }
      await fn(d);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[cuenta]', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  }

  // Pago hecho antes de crear la cuenta del Club: el documento del socio está con otro id pero con su mismo correo.
  // { soloConsulta: true } solo dice si existe ese otro documento; sin eso, y con el correo verificado, pasa los pagos a la cuenta
  // de quien inició sesión SOLO si hay exactamente un documento con pagos (así no se mezclan cuentas ajenas). El documento viejo no se borra.
  app.post('/api/cuenta/vincular', (req, res) => conSesion(req, res, async d => {
    const uid = d.uid, email = String(d.email || '').toLowerCase();
    if (!uid || !email) return res.json({ existe: false, vinculado: false });
    const sn = await db.collection('members').where('email', '==', email).limit(5).get();
    const otros = sn.docs.filter(x => x.id !== uid).map(x => ({ id: x.id, datos: x.data() || {} }));
    const salida = { existe: otros.length > 0, vinculado: false };
    if (req.body && req.body.soloConsulta === true) return res.json(salida);
    if (d.email_verified !== true) return res.json(salida);
    const ref = db.collection('members').doc(uid), propio = await ref.get(), mio = propio.exists ? propio.data() || {} : {};
    if (Array.isArray(mio.payments) && mio.payments.length) return res.json(salida);
    const candidatos = otros.filter(x => Array.isArray(x.datos.payments) && x.datos.payments.length > 0);
    if (candidatos.length !== 1) return res.json(salida);
    const c = candidatos[0].datos, mezcla = {};
    ['plan', 'payments', 'nextPaymentDate', 'paymentMethod', 'status', 'stripeCustomerId', 'stripeSubscriptionId'].forEach(k => { if (c[k]) mezcla[k] = c[k]; });
    if (propio.exists) await ref.update(mezcla); else await ref.set({ ...mezcla, name: d.name || '', email });
    console.log('[vincular] pagos del documento ' + candidatos[0].id + ' → ' + uid);
    res.json({ existe: true, vinculado: true });
  }));

  // El Club avisa que la membresía parece vencida; el servidor lo comprueba con sus propios datos antes de marcarla "inactive"
  app.post('/api/cuenta/vencimiento', (req, res) => conSesion(req, res, async d => {
    const ref = db.collection('members').doc(d.uid), s = await ref.get();
    if (!s.exists) return res.json({ actualizado: false });
    const m = s.data() || {};
    if (!['active', 'paid', 'cancelled'].includes(m.status) || (deps.tieneMembresia && deps.tieneMembresia(m))) return res.json({ actualizado: false });
    const razon = String((req.body && req.body.razon) || 'vencimiento').replace(/[^\wÁ-ú .,-]/g, '').slice(0, 40) || 'vencimiento';
    await ref.update({ status: 'inactive', expiredAt: new Date().toISOString().split('T')[0], expiredReason: razon });
    res.json({ actualizado: true });
  }));
}

module.exports = { montarRutasCuenta, crearEliminadorDeCuenta, PALABRA };
