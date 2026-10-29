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
}

module.exports = { montarRutasCuenta, crearEliminadorDeCuenta, PALABRA };
