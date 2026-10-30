const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const crypto = require('crypto');
const { esAdminPorToken: esAdminDeToken } = require('./services/certificados');
const escH = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Límite de intentos por persona/IP en cobros y cancelaciones (en memoria)
const usosPago = new Map();
function limitarPago(req, res, next) {
  const clave = (req.firebaseUser && req.firebaseUser.uid) || req.ip || 'x', t = Date.now();
  const l = (usosPago.get(clave) || []).filter(x => t - x < 60000);
  if (l.length >= 10) return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto e intenta de nuevo.' });
  l.push(t); usosPago.set(clave, l); if (usosPago.size > 5000) usosPago.clear();
  next();
}
const iguales = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const fs = require('fs');
const path = require('path');

// ===== FIREBASE INIT =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ===== BITÁCORA DEL SERVIDOR: reinicios, caídas y errores agrupados (se ven en el panel → Estado del servidor) =====
const bitacoraMemoria = require('./services/bitacora-memoria');
const bitacoraServidor = require('./services/bitacora-servidor').crearBitacoraServidor({ db, admin });
bitacoraMemoria.instalar();
bitacoraMemoria.fijarDestino(mensaje => bitacoraServidor.registrarError(mensaje));

// ===== STRIPE INIT =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Price IDs LEGACY — se conservan SOLO para reconocer suscripciones viejas
// (creadas antes de los precios dinámicos) en los filtros multi-proyecto.
// Los checkouts nuevos ya NO los usan: se arma price_data dinámico.
const PRICE_MENSUAL = process.env.STRIPE_PRICE_MENSUAL || 'price_1TPYw1PBgqsOPfUYOJBKrQiu';
const PRICE_ANUAL = process.env.STRIPE_PRICE_ANUAL || 'price_1TPYxlPBgqsOPfUYsgjdFsVM';

// ===== PRECIOS DINÁMICOS desde Firestore (config/club) =====
// El admin los edita en su panel → Configuración → Precios de la Membresía.
async function leerPreciosConfig() {
  try {
    const snap = await db.collection('config').doc('club').get();
    const c = snap.exists ? snap.data() : {};
    const precioMes = Number(c.precioMes) > 0 ? Number(c.precioMes) : 199;
    const precioAno = Number(c.precioAno) > 0 ? Number(c.precioAno) : 1999;
    return { precioMes, precioAno };
  } catch (e) {
    console.error('Error leyendo precios config:', e.message);
    return { precioMes: 199, precioAno: 1999 };
  }
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'teccapitalweb@gmail.com';

// ===== EMAILJS CONFIG =====
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || '';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || '';
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || '';
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || '';

// Correos del Club: primero Resend (dominio propio de FisioTeck); si no está configurado, EmailJS como hasta ahora.
const correoSvc = require('./services/correo');
const suscripcion = require('./services/suscripcion'); // doble cobro, cobro rechazado, cambios de la suscripción en Stripe
async function sendEmailJS(toEmail, subject, htmlMessage) {
  if (correoSvc.configurado()) {
    const texto = String(htmlMessage).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const r = await correoSvc.enviarConResend({ para: toEmail, asunto: subject, html: htmlMessage, texto });
    if (r.ok) { console.log(`Resend sent to: ${toEmail}`); return; }
    console.warn('Resend no pudo enviar (' + (r.motivo || 'error') + '); se intenta con EmailJS.');
  }
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY) {
    console.warn('EmailJS no está configurado; se omite el correo saliente.');
    return;
  }
  try {
    const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: {
          to_email: toEmail,
          subject: subject,
          message: htmlMessage
        }
      })
    });
    if (response.ok) {
      console.log(`EmailJS sent to: ${toEmail}`);
    } else {
      const text = await response.text();
      console.error(`EmailJS error: ${text}`);
    }
  } catch(e) {
    console.error('EmailJS error:', e.message);
  }
}

async function sendEmailToClient(email, name, plan, amount) {
  // Monto dinámico: usa el que realmente se cobró; si no llega, sin cifra (nunca un precio viejo fijo)
  const _per = plan === 'anual' ? 'año' : 'mes';
  const _lbl = plan === 'anual' ? 'Plan Anual' : 'Plan Mensual';
  const planLabel = (typeof amount === 'number' && amount > 0)
    ? `${_lbl} ($${amount.toLocaleString('es-MX')} MXN/${_per})`
    : _lbl;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#f8f9fa;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#0B1A30,#1565C0);padding:32px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:1.5rem;letter-spacing:2px;">CLUB FISIOTECK</h1>
        <p style="color:rgba(255,255,255,.7);margin:8px 0 0;font-size:.9rem;">Tu membresía está activa</p>
      </div>
      <div style="padding:28px 32px;">
        <p style="font-size:1rem;color:#333;">Hola <strong>${name || 'Socio'}</strong>,</p>
        <p style="color:#555;line-height:1.6;">Gracias por unirte al Club FisioTeck. Tu suscripción <strong>${planLabel}</strong> ya está activa.</p>
        <p style="color:#555;line-height:1.6;">Ahora tienes acceso completo a:</p>
        <ul style="color:#555;line-height:1.8;">
          <li>Todos los cursos grabados</li>
          <li>Cursos en vivo y webinars</li>
          <li>Herramientas clínicas profesionales</li>
          <li>Foro exclusivo de la comunidad</li>
          <li>Biblioteca de PDFs y recursos</li>
        </ul>
        <div style="text-align:center;margin:24px 0;">
          <a href="https://club.fisioteck.com" style="display:inline-block;padding:14px 32px;background:#1565C0;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Ir al Club FisioTeck →</a>
        </div>
        <p style="color:#999;font-size:.8rem;text-align:center;">Si tienes dudas, contáctanos por WhatsApp.</p>
      </div>
    </div>
  `;
  await sendEmailJS(email, '¡Bienvenido al Club FisioTeck! Tu membresía está activa', html);
}

async function sendEmailToAdmin(email, name, plan, amount) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#f0f7ff;border:1px solid #d0e3f7;border-radius:12px;padding:24px;">
      <h2 style="color:#1565C0;margin:0 0 16px;">Nuevo pago recibido</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:8px 0;color:#666;width:120px;">Nombre:</td><td style="padding:8px 0;color:#333;font-weight:600;">${name || 'Sin nombre'}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Email:</td><td style="padding:8px 0;color:#333;">${email}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Plan:</td><td style="padding:8px 0;color:#333;font-weight:600;">${plan === 'anual' ? 'Anual' : 'Mensual'}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Monto:</td><td style="padding:8px 0;color:#1565C0;font-weight:700;font-size:1.1rem;">$${amount} MXN</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Fecha:</td><td style="padding:8px 0;color:#333;">${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Método:</td><td style="padding:8px 0;color:#333;">Stripe</td></tr>
      </table>
    </div>
  `;
  await sendEmailJS(ADMIN_EMAIL, `Nuevo pago: ${name || email} - ${plan === 'anual' ? 'Anual' : 'Mensual'}`, html);
}

// ===== HELPER: Save admin notification =====
async function notifyAdmin(type, data) {
  try {
    await db.collection('notifications').add({
      type: type,
      club: 'fisioteck',
      ...data,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`Notification saved: ${type} - ${data.memberEmail || ''}`);
  } catch(e) {
    console.error('Notification error:', e.message);
  }
}

// ===== EXPRESS APP =====
const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT: Stripe webhook needs raw body BEFORE json parser
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

// JSON parser for all other routes
app.use(express.json());
app.set('trust proxy', 1);
const ORIGENES = new Set(['https://club.fisioteck.com', 'https://www.fisioteck.com', 'https://fisioteck.com', 'https://teccapitalweb.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://localhost:8790', 'http://127.0.0.1:8790']
  .concat(String(process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)));
app.use(cors({ origin: (origen, cb) => cb(null, !origen || ORIGENES.has(origen)) })); // sin Origin (servidor a servidor, Stripe) pasa; un sitio no autorizado no recibe permiso del navegador

// ===== BUNNY STREAM: catálogo y reproducción firmada =====
const BUNNY_CATALOG_PATH = path.join(__dirname, 'data', 'bunny-catalog.json');
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || '';
const BUNNY_STREAM_TOKEN_KEY = process.env.BUNNY_STREAM_TOKEN_KEY || '';
const BUNNY_STREAM_PLAYER_HOST = (process.env.BUNNY_STREAM_PLAYER_HOST || 'https://iframe.mediadelivery.net').replace(/\/$/, '');
const BUNNY_PLAYBACK_TTL_SECONDS = Math.max(60, Math.min(Number(process.env.BUNNY_PLAYBACK_TTL_SECONDS) || 900, 3600));

// Cursos creados o editados desde el panel (colección catalogoVideo): se suman al catálogo del archivo para poder reproducirse.
// Se guardan en memoria y se refrescan cada 10 minutos (al guardar desde el panel se actualizan al instante; leer la colección cada minuto gastaba miles de lecturas al día).
let catalogoExtra = {};
function registrarCatalogoExtra(curso) { catalogoExtra[String(curso.courseId)] = curso; }
async function refrescarCatalogoExtra() {
  try {
    const sn = await db.collection('catalogoVideo').get();
    const nuevo = {};
    sn.docs.forEach(d => { const c = d.data(); if (c && c.courseId !== undefined) nuevo[String(c.courseId)] = c; });
    catalogoExtra = nuevo;
  } catch (e) { console.error('No se pudo leer catalogoVideo:', e.message); }
}
refrescarCatalogoExtra();
setInterval(refrescarCatalogoExtra, 10 * 60000).unref();

function loadBunnyCatalog() {
  const base = fs.existsSync(BUNNY_CATALOG_PATH) ? JSON.parse(fs.readFileSync(BUNNY_CATALOG_PATH, 'utf8')) : { libraryId: '', courses: [] };
  const extra = Object.values(catalogoExtra);
  if (!extra.length) return base;
  const ids = new Set(extra.map(c => String(c.courseId)));
  return { ...base, courses: [...(base.courses || []).filter(c => !ids.has(String(c.courseId))), ...extra] };
}

function findCatalogLesson(catalog, courseId, lessonId) {
  const course = (catalog.courses || []).find(item => String(item.courseId) === String(courseId));
  if (!course) return null;
  const lesson = (course.lessons || []).find(item => String(item.lessonId) === String(lessonId));
  return lesson ? { course, lesson } : null;
}

async function requireFirebaseUser(req, res, next) {
  try {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    req.firebaseUser = await admin.auth().verifyIdToken(match[1]);
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Tu sesión no es válida o expiró.' });
  }
}

function memberHasPremiumAccess(member) {
  if (!member || !['active', 'paid', 'cancelled'].includes(member.status)) return false;
  const rawExpiry = member.accessUntil || member.nextPaymentDate;
  if (!rawExpiry) return member.status === 'active' || member.status === 'paid';
  const expiry = rawExpiry.toDate ? rawExpiry.toDate() : new Date(String(rawExpiry).length === 10 ? rawExpiry + 'T23:59:59' : rawExpiry);
  return !Number.isNaN(expiry.getTime()) && expiry >= new Date();
}

app.post('/api/video-playback', requireFirebaseUser, async (req, res) => {
  try {
    const { courseId, lessonId } = req.body || {};
    if (courseId === undefined || lessonId === undefined) {
      return res.status(400).json({ error: 'courseId y lessonId son obligatorios.' });
    }

    const catalog = loadBunnyCatalog();
    const entry = findCatalogLesson(catalog, courseId, lessonId);
    if (!entry) return res.status(404).json({ error: 'La clase no existe en el catálogo de video.' });

    const memberDoc = await db.collection('members').doc(req.firebaseUser.uid).get();
    if (!memberDoc.exists) return res.status(403).json({ error: 'Completa tu registro gratuito para continuar.' });

    // Prueba gratuita: quien eligió un curso lo ve completo (ver /api/prueba-gratuita).
    const trialId = memberDoc.data().trialCourseId;
    const tieneMembresia = memberHasPremiumAccess(memberDoc.data());
    // La prueba cubre todas las clases del curso elegido MENOS la última (como Zoorigen y Alintec).
    const isTrial = trialId !== undefined && trialId !== null && String(trialId) === String(courseId)
      && Number(entry.lesson.index) < (entry.course.lessons || []).length - 1;
    // La clase marcada como vista previa en el catálogo se puede VER sin membresía (como Alintec)
    const esVistaPrevia = entry.lesson.isPreview === true;
    if (!isTrial && !tieneMembresia && !esVistaPrevia) {
      return res.status(402).json({ error: 'Esta clase se desbloquea con la membresía.' });
    }
    // Cursos escalonados: con membresía, el curso debe estar abierto (ver services/acceso.js).
    if (!isTrial && tieneMembresia) {
      const { acceso } = await depsAcceso.evaluarAcceso(req.firebaseUser.uid, req.firebaseUser);
      const info = acceso.cursos && acceso.cursos[String(courseId)];
      if (info && !info.abierto) {
        return res.status(403).json({ error: 'Este curso se abre en ' + info.dias + ' día' + (info.dias === 1 ? '' : 's') + ', o antes si superas retos.', abreEn: info.abreEn, dias: info.dias });
      }
    }

    const libraryId = BUNNY_STREAM_LIBRARY_ID || catalog.libraryId || '';
    const videoId = entry.lesson.bunnyVideoId || '';
    if (!libraryId || !BUNNY_STREAM_TOKEN_KEY) {
      return res.status(503).json({ error: 'Bunny Stream todavía no está configurado en el servidor.' });
    }
    if (!videoId) return res.status(409).json({ error: 'Este video está pendiente de migración a Bunny.' });

    const expires = Math.floor(Date.now() / 1000) + BUNNY_PLAYBACK_TTL_SECONDS;
    const token = crypto.createHash('sha256').update(BUNNY_STREAM_TOKEN_KEY + videoId + expires).digest('hex');
    const embedUrl = `${BUNNY_STREAM_PLAYER_HOST}/embed/${encodeURIComponent(libraryId)}/${encodeURIComponent(videoId)}?token=${token}&expires=${expires}&autoplay=true`;
    res.set('Cache-Control', 'no-store');
    return res.json({ embedUrl, expiresAt: new Date(expires * 1000).toISOString(), preview: isTrial && !tieneMembresia });
  } catch (error) {
    console.error('Bunny playback error:', error.message);
    return res.status(500).json({ error: 'No se pudo preparar la reproducción.' });
  }
});

// ===== PRUEBA GRATUITA: cada cuenta registrada elige UN curso completo, una sola vez =====
// GET  → { estado: 'pendiente' | 'elegida' | 'no-aplica', cursoId, elegibles: [ids] }
// POST { courseId } → guarda trialCourseId en members/{uid}. Irreversible. Quien ya es miembro no la necesita.
function pruebaGratuitaEstado(member, catalog) {
  const elegibles = (catalog.courses || []).filter(c => (c.lessons || []).length > 0).map(c => c.courseId);
  if (memberHasPremiumAccess(member)) return { estado: 'no-aplica', cursoId: null, elegibles };
  if (member.trialCourseId !== undefined && member.trialCourseId !== null) {
    return { estado: 'elegida', cursoId: member.trialCourseId, elegibles };
  }
  // Solo cuentas nuevas: quien ya fue miembro (pagos, vencido, cancelado) no recibe una prueba.
  const fueMiembro = member.status !== 'registered' || (Array.isArray(member.payments) && member.payments.length > 0);
  if (fueMiembro) return { estado: 'no-aplica', cursoId: null, elegibles };
  return { estado: 'pendiente', cursoId: null, elegibles };
}

app.get('/api/prueba-gratuita', requireFirebaseUser, async (req, res) => {
  try {
    const memberDoc = await db.collection('members').doc(req.firebaseUser.uid).get();
    if (!memberDoc.exists) return res.status(403).json({ error: 'Completa tu registro gratuito para continuar.' });
    res.set('Cache-Control', 'no-store');
    return res.json(pruebaGratuitaEstado(memberDoc.data(), loadBunnyCatalog()));
  } catch (error) {
    console.error('Prueba gratuita (estado):', error.message);
    return res.status(500).json({ error: 'No se pudo consultar tu prueba gratuita.' });
  }
});

app.post('/api/prueba-gratuita', requireFirebaseUser, async (req, res) => {
  try {
    const courseId = req.body && req.body.courseId;
    const catalog = loadBunnyCatalog();
    const curso = (catalog.courses || []).find(c => String(c.courseId) === String(courseId) && (c.lessons || []).length > 0);
    if (!curso) return res.status(400).json({ error: 'Ese curso no está disponible como prueba.' });

    const ref = db.collection('members').doc(req.firebaseUser.uid);
    const resultado = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { codigo: 403, error: 'Completa tu registro gratuito para continuar.' };
      const estado = pruebaGratuitaEstado(snap.data(), catalog);
      if (estado.estado === 'no-aplica') return { codigo: 409, error: 'Tu membresía ya incluye todos los cursos.' };
      if (estado.estado === 'elegida') return { codigo: 409, error: 'Ya elegiste tu curso de prueba.', cursoId: estado.cursoId };
      tx.update(ref, {
        trialCourseId: curso.courseId,
        trialStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { codigo: 200, cursoId: curso.courseId };
    });
    if (resultado.codigo !== 200) return res.status(resultado.codigo).json({ error: resultado.error, cursoId: resultado.cursoId });
    return res.json({ estado: 'elegida', cursoId: resultado.cursoId });
  } catch (error) {
    console.error('Prueba gratuita (elegir):', error.message);
    return res.status(500).json({ error: 'No se pudo guardar tu curso de prueba.' });
  }
});

// ===== HELPER: Find member by email =====
async function findMemberByEmail(email) {
  const snapshot = await db.collection('members')
    .where('email', '==', email.toLowerCase())
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return { uid: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

// Miembro de un aviso de Stripe: por la cuenta guardada en la suscripción, luego por la suscripción y al final por correo
// (si la persona cambia de correo, sus renovaciones no se pierden; como Alintec y Zoorigen)
async function miembroDeStripe({ uid, subscriptionId, email }) {
  if (uid) { const d = await db.collection('members').doc(String(uid)).get(); if (d.exists) return { uid: d.id, ...d.data() }; }
  if (subscriptionId) {
    const s = await db.collection('members').where('stripeSubscriptionId', '==', String(subscriptionId)).limit(1).get();
    if (!s.empty) return { uid: s.docs[0].id, ...s.docs[0].data() };
  }
  return email ? findMemberByEmail(email) : null;
}

// ===== HELPER: Determine plan type from price ID =====
// ⛔ Filtro multi-proyecto (2da capa): valida por price ID real, cubre casos
// donde el otro club NO manda metadata.source (el filtro por source se salta
// si "src" viene vacío) y también pagos únicos sin suscripción (cursos, etc).
function isOwnPrice(priceId) {
  return !!priceId && (priceId === PRICE_MENSUAL || priceId === PRICE_ANUAL);
}

function getPlanFromPrice(priceId) {
  if (priceId === PRICE_ANUAL) return 'anual';
  if (priceId === PRICE_MENSUAL) return 'mensual';
  return null;
}

// ===== API: Create Stripe Checkout Session (soporta popup 'hosted' y 'embedded') =====
app.post('/api/create-checkout', requireFirebaseUser, limitarPago, async (req, res) => {
  try {
    const { plan, mode } = req.body || {};
    // El correo y el uid salen de la sesión, nunca del cuerpo de la petición
    const email = String(req.firebaseUser.email || '').toLowerCase(), uid = req.firebaseUser.uid;
    if (!plan || !email) {
      return res.status(400).json({ error: 'Plan and email required' });
    }
    if (!['mensual', 'anual'].includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido (mensual o anual)' });
    }
    // Sin doble cobro: quien ya tiene una suscripción viva no abre otra (como Zoorigen)
    const yaMiembro = (await db.collection('members').doc(uid).get()).data();
    const bloqueo = suscripcion.bloqueoDeCobro(yaMiembro, memberHasPremiumAccess);
    if (bloqueo) return res.status(bloqueo.status).json({ error: bloqueo.mensaje, codigo: bloqueo.codigo });

    // ← PRECIO DINÁMICO: se lee de config/club en Firestore en cada checkout.
    // Ya no se usan los Price IDs fijos de Stripe para checkouts nuevos.
    const { precioMes, precioAno } = await leerPreciosConfig();
    const montoMXN = plan === 'anual' ? precioAno : precioMes;

    // Stripe rechaza cargos menores a $10 MXN — avisar claro
    if (montoMXN < 10) {
      return res.status(400).json({ error: 'El precio configurado ($' + montoMXN + ' MXN) es menor al mínimo de Stripe ($10 MXN). Revisa Configuración en el panel admin.' });
    }

    const sessionConfig = {
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      // «Agregar código» solo en el plan MENSUAL: los códigos de descuento no valen para el plan anual
      ...(plan === 'mensual' ? { allow_promotion_codes: true } : {}),
      // Sin Stripe Link (pago directo con tarjeta, sin verificación por teléfono), como Zoorigen
      wallet_options: { link: { display: 'never' } },
      line_items: [{
        price_data: {
          currency: 'mxn',
          unit_amount: Math.round(montoMXN * 100),
          recurring: { interval: plan === 'anual' ? 'year' : 'month' },
          product_data: {
            name: `Club FisioTeck · Plan ${plan === 'anual' ? 'Anual' : 'Mensual'}`
          }
        },
        quantity: 1
      }],
      metadata: {
        firebaseUid: uid || '',
        plan: plan,
        source: 'fisioteck-club'
      },
      subscription_data: {
        metadata: {
          firebaseUid: uid || '',
          plan: plan,
          source: 'fisioteck-club'
        }
      }
    };

    // 🆕 Modo POPUP (frontend nuevo con vigilarPago). El popup abre esta URL directa.
    if (mode === 'hosted') {
      sessionConfig.ui_mode = 'hosted';
      sessionConfig.success_url = 'https://club.fisioteck.com/?session_id={CHECKOUT_SESSION_ID}';
      sessionConfig.cancel_url = 'https://club.fisioteck.com/';
    } else {
      // Modo EMBEDDED (compatibilidad con frontend viejo)
      sessionConfig.ui_mode = 'embedded';
      sessionConfig.return_url = 'https://club.fisioteck.com?session_id={CHECKOUT_SESSION_ID}';
    }

    // Recordatorios de pago: si la persona tiene un cupón vigente (y eligió el plan mensual), se aplica solo
    const cuponAplicado = await recordatorios.aplicarCupon(sessionConfig, uid, plan, email);
    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionConfig);
    } catch (errorCupon) {
      // Si Stripe rechaza el cupón (venció justo ahora) la persona paga como siempre: nunca se le bloquea el pago
      if (!cuponAplicado) throw errorCupon;
      console.warn('[Recordatorios] Stripe rechazó el cupón; se crea el pago sin él:', errorCupon && errorCupon.message);
      session = await stripe.checkout.sessions.create(recordatorios.sinCupon(sessionConfig));
    }

    res.json({
      url: session.url || null,                   // frontend nuevo (popup)
      clientSecret: session.client_secret || null // frontend viejo (embedded)
    });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Error creating checkout session' });
  }
});

// ===== API: Portal de facturación de Stripe (método de pago, facturas) — como «Gestionar en Stripe» de Alintec =====
app.post('/api/billing-portal', requireFirebaseUser, limitarPago, async (req, res) => {
  try {
    const m = (await db.collection('members').doc(req.firebaseUser.uid).get()).data() || {};
    let customer = m.stripeCustomerId || '';
    if (!customer && m.stripeSubscriptionId) { try { customer = (await stripe.subscriptions.retrieve(m.stripeSubscriptionId)).customer || ''; } catch (_) { customer = ''; } }
    if (!customer) return res.status(404).json({ error: 'Todavía no tienes una suscripción de pago con tarjeta.' });
    const ses = await stripe.billingPortal.sessions.create({ customer, return_url: 'https://club.fisioteck.com/' });
    res.json({ url: ses.url });
  } catch (err) {
    console.error('Billing portal error:', err.message);
    res.status(500).json({ error: 'El portal de Stripe todavía no está activado. Escríbenos y lo resolvemos.' });
  }
});

// ===== API: Check session status (after payment) =====
app.get('/api/checkout-status/:sessionId', requireFirebaseUser, limitarPago, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    res.json({
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_email || session.customer_details?.email || ''
    });
  } catch (err) {
    res.status(500).json({ error: 'Error checking session' });
  }
});

// ===== STRIPE WEBHOOK HANDLER =====
async function handleStripeWebhook(req, res) {
  let event;

  // Verify webhook signature
  try {
    if (!STRIPE_WEBHOOK_SECRET) { console.error('Webhook rechazado: falta STRIPE_WEBHOOK_SECRET (nunca se aceptan eventos sin firma).'); return res.status(400).send('Webhook no configurado'); }
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error');
  }

  console.log(`Stripe event received: ${event.type}`);
  bitacoraServidor.registrarAvisoStripe(event.type, true);

  // Se procesa ANTES de responder: si algo falla se contesta 500 y Stripe reintenta; un evento ya procesado no se repite
  const refEvento = db.collection('stripeEventos').doc(String(event.id));
  try {
    if ((await refEvento.get()).exists) return res.json({ received: true, repetido: true });
    switch (event.type) {

      // ===== CHECKOUT COMPLETED (first payment) =====
      case 'checkout.session.completed': {
        const session = event.data.object;

        // ⚠️ FILTRO MULTI-PROYECTO: esta cuenta Stripe es compartida por varios
        // proyectos (IMDIIL, etc.). Si el pago trae un 'source' de OTRO proyecto,
        // lo ignoramos. Los pagos de FisioTeck llevan source 'fisioteck-club'.
        // (Pagos viejos sin source se siguen procesando para no romper nada.)
        const src = session.metadata?.source || '';
        if (src && src !== 'fisioteck-club') {
          console.log(`Ignorado: pago de otro proyecto (source=${src})`);
          bitacoraServidor.registrarIgnorado(event.type);
          break;
        }

        // ⛔ 2da capa: validar price real — SOLO cuando NO viene source.
        // Con precios dinámicos (price_data) el price ID es generado y no
        // coincide con los legacy, pero nuestros checkouts SIEMPRE traen
        // source='fisioteck-club' (pasan por la capa 1). Esta capa queda para
        // pagos viejos sin source (price fijo legacy → pasa) y pagos de otros
        // proyectos sin source (price ajeno → se ignora).
        if (!src) {
          try {
            let checkPriceId = null;
            if (session.subscription) {
              const subCheck = await stripe.subscriptions.retrieve(session.subscription);
              checkPriceId = subCheck.items?.data?.[0]?.price?.id || null;
            } else {
              const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
              checkPriceId = items?.data?.[0]?.price?.id || null;
            }
            if (!isOwnPrice(checkPriceId)) {
              console.log(`Ignorado: price de otro proyecto/no es membresía FisioTeck (${checkPriceId})`);
              break;
            }
          } catch (e) {
            console.warn('No se pudo validar price, se continúa:', e.message);
          }
        }

        const email = (session.customer_email || session.customer_details?.email || '').toLowerCase();
        const firebaseUid = session.metadata?.firebaseUid || '';
        const planFromMeta = session.metadata?.plan || '';

        if (!email) {
          console.log('No email in checkout session');
          break;
        }
        // Solo un pago confirmado activa la membresía (como Zoorigen)
        if (session.payment_status && !['paid', 'no_payment_required'].includes(session.payment_status)) {
          console.log(`Checkout sin pago confirmado (${session.payment_status}): ${email}`);
          break;
        }

        // Get subscription details
        let planType = planFromMeta;
        let subscriptionId = session.subscription || '';

        if (subscriptionId && !planType) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          // Con precios dinámicos el price ID no está en la lista legacy:
          // primero metadata de la sub, luego el intervalo real, luego legacy.
          planType = sub.metadata?.plan
            || (sub.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'anual' : null)
            || getPlanFromPrice(sub.items?.data?.[0]?.price?.id || '')
            || 'mensual';
        }
        if (!planType) planType = 'mensual';

        console.log(`Checkout completed: ${email} - Plan: ${planType}`);

        const now = new Date().toISOString().split('T')[0];
        // Monto REAL cobrado (session.amount_total viene en centavos y siempre
        // está presente en checkout.session.completed). Fallback: config actual.
        let amount;
        if (session.amount_total) {
          amount = session.amount_total / 100;
        } else {
          const _cfg = await leerPreciosConfig();
          amount = planType === 'anual' ? _cfg.precioAno : _cfg.precioMes;
        }
        const nextDate = new Date();
        if (planType === 'anual') {
          nextDate.setFullYear(nextDate.getFullYear() + 1);
        } else {
          nextDate.setMonth(nextDate.getMonth() + 1);
        }
        // Fecha real del fin del periodo en Stripe (si se puede leer); la calculada queda de respaldo
        let finStripe = '';
        if (subscriptionId) { try { finStripe = suscripcion.finDePeriodo(await stripe.subscriptions.retrieve(subscriptionId)); } catch (e) { /* respaldo */ } }
        const nextPaymentStr = finStripe || nextDate.toISOString().split('T')[0];

        const paymentRecord = {
          date: now,
          amount: amount,
          currency: 'MXN',
          concept: planType === 'anual' ? 'Membresía anual' : 'Membresía mensual',
          status: 'paid',
          stripeSessionId: session.id || '',
          stripeSubscriptionId: subscriptionId,
          paymentMethod: 'Stripe'
        };

        // Try to find member by UID first, then by email
        let member = null;
        if (firebaseUid) {
          const doc = await db.collection('members').doc(firebaseUid).get();
          if (doc.exists) {
            member = { uid: firebaseUid, ...doc.data() };
          }
        }
        if (!member) {
          member = await findMemberByEmail(email);
        }

        if (member) {
          await db.collection('members').doc(member.uid).update({
            status: 'active',
            accessUntil: '', cancelledAt: '', paymentFailedAt: '', canceladoPor: '',
            pagoPendiente: false, suscripcionTerminada: false, stripeCancelled: false,
            plan: planType,
            lastPaymentDate: now,
            nextPaymentDate: nextPaymentStr,
            paymentMethod: 'Stripe',
            stripeCustomerId: session.customer || '',
            stripeSubscriptionId: subscriptionId,
            payments: admin.firestore.FieldValue.arrayUnion(paymentRecord),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`Member updated: ${email}`);
          await recordatorios.cerrarSerie(session, member.uid); // deja de recibir recordatorios de pago (nunca lanza)

          // Send emails
          await sendEmailToClient(email, member.name || '', planType, amount);
          await sendEmailToAdmin(email, member.name || email, planType, amount);

          await notifyAdmin('new_payment', {
            memberName: member.name || email,
            memberEmail: email,
            plan: planType,
            amount: amount
          });
        } else {
          await db.collection('pending_members').doc(email).set({
            email: email,
            name: session.customer_details?.name || '',
            plan: planType,
            status: 'active',
            startDate: now,
            lastPaymentDate: now,
            nextPaymentDate: nextPaymentStr,
            paymentMethod: 'Stripe',
            stripeCustomerId: session.customer || '',
            stripeSubscriptionId: subscriptionId,
            payments: [paymentRecord],
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`Pending member created: ${email}`);

          // Send emails
          await sendEmailToClient(email, session.customer_details?.name || '', planType, amount);
          await sendEmailToAdmin(email, session.customer_details?.name || email, planType, amount);

          await notifyAdmin('new_payment', {
            memberName: session.customer_details?.name || email,
            memberEmail: email,
            plan: planType,
            amount: amount,
            note: 'Pendiente de registro'
          });
        }
        break;
      }

      // ===== INVOICE PAID (recurring payments) =====
      case 'invoice.paid': {
        const invoice = event.data.object;
        const email = (invoice.customer_email || '').toLowerCase();
        const subscriptionId = invoice.subscription || '';

        if (!email || !subscriptionId) break;

        if (invoice.billing_reason === 'subscription_create') {
          console.log(`Skipping first invoice for ${email} (handled by checkout)`);
          break;
        }

        console.log(`Recurring payment received: ${email}`);

        let planType = 'mensual';
        const priceId = invoice.lines?.data?.[0]?.price?.id || '';
        const lineInterval = invoice.lines?.data?.[0]?.price?.recurring?.interval || '';

        // ⛔ Filtro multi-proyecto: con precios dinámicos el price ID ya no es
        // fijo, así que la identidad se valida por metadata.source de la
        // SUSCRIPCIÓN (nuestros checkouts la graban siempre). El check de price
        // legacy queda solo como fallback para subs viejas sin metadata.
        let subMeta = {}, subFin = '';
        try {
          const subForMeta = await stripe.subscriptions.retrieve(subscriptionId);
          subMeta = subForMeta.metadata || {};
          subFin = suscripcion.finDePeriodo(subForMeta);
        } catch (e) {
          console.warn('No se pudo leer metadata de la sub:', e.message);
        }
        if (subMeta.source && subMeta.source !== 'fisioteck-club') {
          console.log(`Ignorado: renovación de otro proyecto (source=${subMeta.source})`);
          break;
        }
        if (!subMeta.source && priceId && !isOwnPrice(priceId)) {
          console.log(`Ignorado: renovación de otro proyecto (price=${priceId})`);
          break;
        }

        // Plan: metadata → intervalo real → price legacy → default
        planType = subMeta.plan
          || (lineInterval === 'year' ? 'anual' : (lineInterval === 'month' ? 'mensual' : null))
          || (priceId ? getPlanFromPrice(priceId) : null)
          || 'mensual';

        const now = new Date().toISOString().split('T')[0];
        // Monto REAL cobrado en la renovación (invoice.amount_paid en centavos).
        let amount;
        if (invoice.amount_paid) {
          amount = invoice.amount_paid / 100;
        } else {
          const _cfg = await leerPreciosConfig();
          amount = planType === 'anual' ? _cfg.precioAno : _cfg.precioMes;
        }
        const nextDate = new Date();
        if (planType === 'anual') {
          nextDate.setFullYear(nextDate.getFullYear() + 1);
        } else {
          nextDate.setMonth(nextDate.getMonth() + 1);
        }

        const paymentRecord = {
          date: now,
          amount: amount,
          currency: 'MXN',
          concept: planType === 'anual' ? 'Renovación anual' : 'Renovación mensual',
          status: 'paid',
          stripeInvoiceId: invoice.id || '',
          stripeSubscriptionId: subscriptionId,
          paymentMethod: 'Stripe'
        };

        const member = await miembroDeStripe({ uid: subMeta.firebaseUid, subscriptionId, email });
        if (member && member.status === 'inactive' && member.canceladoPor) {
          console.warn(`Renovación de un miembro al que el administrador quitó el acceso: ${email} (revisa Stripe)`);
        } else if (member) {
          await db.collection('members').doc(member.uid).update({
            status: 'active',
            accessUntil: '', cancelledAt: '', paymentFailedAt: '',
            pagoPendiente: false, suscripcionTerminada: false,
            lastPaymentDate: now,
            nextPaymentDate: suscripcion.finDePeriodo(invoice) || subFin || nextDate.toISOString().split('T')[0],
            payments: admin.firestore.FieldValue.arrayUnion(paymentRecord),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`Recurring payment recorded: ${email}`);

          await notifyAdmin('renewal', {
            memberName: member.name || email,
            memberEmail: email,
            plan: planType,
            amount: amount
          });
        }
        break;
      }

      // ===== SUBSCRIPTION CANCELLED =====
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const stripeCustomerId = subscription.customer;

        // ⛔ Filtro multi-proyecto: si la sub cancelada no es de FisioTeck, ignorar.
        // Sin este filtro, cancelar en otro club marca al miembro como cancelado aquí también.
        const subPriceId = subscription.items?.data?.[0]?.price?.id || '';
        const subSource = subscription.metadata?.source || '';
        if (subSource && subSource !== 'fisioteck-club') {
          console.log(`Ignorado (deleted): sub de otro proyecto (source=${subSource})`);
          break;
        }
        // Check de price legacy SOLO si la sub no trae source (subs viejas):
        // las subs nuevas con precio dinámico traen source='fisioteck-club'
        // pero un price ID generado que no está en la lista legacy.
        if (!subSource && subPriceId && !isOwnPrice(subPriceId)) {
          console.log(`Ignorado (deleted): price de otro proyecto (${subPriceId})`);
          break;
        }

        let email = '';
        try {
          const customer = await stripe.customers.retrieve(stripeCustomerId);
          email = (customer.email || '').toLowerCase();
        } catch(e) {
          console.error('Error fetching customer:', e.message);
        }

        console.log(`Subscription cancelled: ${email || subscription.id}`);

        const member = await miembroDeStripe({ uid: subscription.metadata?.firebaseUid, subscriptionId: subscription.id, email });
        if (member) {
          // 🛡️ Guarda anti-stale: solo cancelar si la sub coincide con la guardada
          if (member.stripeSubscriptionId && member.stripeSubscriptionId !== subscription.id) {
            console.log(`Ignorado (deleted): sub.id ${subscription.id} no coincide con guardada ${member.stripeSubscriptionId}`);
            break;
          }

          const now = new Date().toISOString().split('T')[0];
          // El administrador ya quitó el acceso: no se le devuelve. Cobro rechazado sin resolver: el acceso termina hoy.
          if (member.status === 'inactive' || member.pagoPendiente) {
            await db.collection('members').doc(member.uid).update({
              status: 'inactive', accessUntil: '', pagoPendiente: false, suscripcionTerminada: true, stripeCancelled: true,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            break;
          }
          const accessUntil = member.accessUntil || member.nextPaymentDate || now;

          await db.collection('members').doc(member.uid).update({
            status: 'cancelled',
            cancelledAt: member.cancelledAt || now,
            accessUntil: accessUntil,
            suscripcionTerminada: true, stripeCancelled: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`Member cancelled via Stripe event: ${email}`);
          // No notification here — already sent by /api/cancel-subscription
        }
        break;
      }

      // ===== PAYMENT FAILED =====
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const email = (invoice.customer_email || '').toLowerCase();

        if (!email) break;

        // ⛔ Filtro multi-proyecto: si el fallo es de otro club, ignorar.
        // Identidad por metadata.source de la suscripción (precios dinámicos);
        // el check de price legacy queda como fallback para subs sin metadata.
        const failedPriceId = invoice.lines?.data?.[0]?.price?.id || '';
        let failedSubMeta = {};
        if (invoice.subscription) {
          try {
            const failedSub = await stripe.subscriptions.retrieve(invoice.subscription);
            failedSubMeta = failedSub.metadata || {};
          } catch (e) { /* si no se puede leer, caemos al check por price */ }
        }
        if (failedSubMeta.source && failedSubMeta.source !== 'fisioteck-club') {
          console.log(`Ignorado (payment_failed): sub de otro proyecto (source=${failedSubMeta.source})`);
          break;
        }
        if (!failedSubMeta.source && failedPriceId && !isOwnPrice(failedPriceId)) {
          console.log(`Ignorado (payment_failed): price de otro proyecto (${failedPriceId})`);
          break;
        }

        console.log(`Payment failed: ${email}`);

        const member = await miembroDeStripe({ uid: failedSubMeta.firebaseUid, subscriptionId: invoice.subscription, email });
        if (member) {
          // No se corta el acceso al primer rechazo: Stripe reintenta. Queda «pago pendiente» con unos días de gracia;
          // si Stripe se rinde, customer.subscription.updated/deleted cierra el acceso.
          const cambios = suscripcion.cambiosPorCobroFallido(member, new Date());
          await db.collection('members').doc(member.uid).update({
            ...cambios,
            payments: admin.firestore.FieldValue.arrayUnion({ date: new Date().toISOString().split('T')[0], amount: (invoice.amount_due || 0) / 100, currency: 'MXN', method: 'Stripe', estado: 'failed', status: 'failed', concept: 'Cobro rechazado', invoiceId: invoice.id || '' }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          const hastaTxt = cambios.accessUntil || member.accessUntil || member.nextPaymentDate || '';
          sendEmailJS(email, 'No pudimos cobrar tu membresía del Club FisioTeck', '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;"><h2 style="color:#0A3E68;">No pudimos cobrar tu membresía</h2><p>Hola <strong>' + escH(member.name || 'Socio') + '</strong>, el cobro de tu membresía fue rechazado. Stripe lo volverá a intentar en los próximos días' + (hastaTxt ? ' y conservas tu acceso hasta el <strong>' + escH(hastaTxt) + '</strong>' : '') + '.</p><p>Para no perderlo, actualiza tu tarjeta en el Club (Membresía → Gestionar en Stripe): <a href="https://club.fisioteck.com">club.fisioteck.com</a>. No vuelvas a suscribirte: se te cobraría dos veces.</p><p style="color:#777;font-size:.85rem;">Si ya lo resolviste, ignora este mensaje.</p></div>');

          await notifyAdmin('payment_failed', {
            memberName: member.name || email,
            memberEmail: email,
            plan: member.plan || 'mensual'
          });
        }
        break;
      }

      // ===== SUBSCRIPTION UPDATED (cancelar/reactivar desde Stripe, past_due, unpaid) =====
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const subSource = sub.metadata?.source || '';
        const subPriceId = sub.items?.data?.[0]?.price?.id || '';
        if (subSource && subSource !== 'fisioteck-club') { console.log(`Ignorado (updated): sub de otro proyecto (source=${subSource})`); break; }
        if (!subSource && subPriceId && !isOwnPrice(subPriceId)) { console.log(`Ignorado (updated): price de otro proyecto (${subPriceId})`); break; }
        const member = await miembroDeStripe({ uid: sub.metadata?.firebaseUid, subscriptionId: sub.id });
        const cambios = suscripcion.cambiosPorSuscripcion(sub, member);
        if (member && cambios) {
          await db.collection('members').doc(member.uid).update({ ...cambios, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          console.log(`Suscripción actualizada (${sub.status}${sub.cancel_at_period_end ? ', cancela al final del periodo' : ''}): ${member.email || member.uid}`);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
    await refEvento.set({ tipo: event.type, ms: Date.now() });
    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'No se pudo procesar el evento.' });
  }
}

// ===== API: Check member status (for Club site) =====
app.get('/api/member/:email', requireFirebaseUser, limitarPago, async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    // Solo la propia persona (o un administrador) puede consultar sus pagos
    if (email !== String(req.firebaseUser.email || '').toLowerCase() && !esAdminDeToken(req.firebaseUser)) return res.status(403).json({ error: 'No puedes consultar los datos de otra persona.' });
    const member = await findMemberByEmail(email);
    if (member) {
      res.json({
        status: member.status,
        plan: member.plan || 'mensual',
        startDate: member.startDate || member.lastPaymentDate || '',
        nextPaymentDate: member.nextPaymentDate || '',
        paymentMethod: member.paymentMethod || '',
        payments: member.payments || []
      });
    } else {
      const pending = await db.collection('pending_members').doc(email).get();
      if (pending.exists) {
        res.json(pending.data());
      } else {
        res.status(404).json({ error: 'Member not found' });
      }
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== API: Link pending member to registered user =====
app.post('/api/link-member', requireFirebaseUser, limitarPago, async (req, res) => {
  try {
    // Solo se liga el pago pendiente del correo de la propia sesión a la propia cuenta
    const email = String(req.firebaseUser.email || '').toLowerCase(), uid = req.firebaseUser.uid;
    if (!email || !uid) return res.status(400).json({ error: 'Email and UID required' });

    const pendingDoc = await db.collection('pending_members').doc(email.toLowerCase()).get();
    if (pendingDoc.exists) {
      const pendingData = pendingDoc.data();
      await db.collection('members').doc(uid).update({
        status: pendingData.status || 'active',
        plan: pendingData.plan || 'mensual',
        startDate: pendingData.startDate || '',
        lastPaymentDate: pendingData.lastPaymentDate || '',
        nextPaymentDate: pendingData.nextPaymentDate || '',
        paymentMethod: pendingData.paymentMethod || '',
        stripeCustomerId: pendingData.stripeCustomerId || '',
        stripeSubscriptionId: pendingData.stripeSubscriptionId || '',
        payments: pendingData.payments || [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('pending_members').doc(email.toLowerCase()).delete();
      console.log(`Linked pending member: ${email} -> ${uid}`);
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'No pending data' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== API: Cancel subscription (from Club dashboard) =====
app.post('/api/cancel-subscription', requireFirebaseUser, limitarPago, async (req, res) => {
  try {
    // Solo se cancela la suscripción de la persona que inició sesión
    const uid = req.firebaseUser.uid, email = String(req.firebaseUser.email || '').toLowerCase();
    if (!email && !uid) return res.status(400).json({ error: 'Email or UID required' });

    let member = null;
    let memberDocId = null;

    if (uid) {
      const doc = await db.collection('members').doc(uid).get();
      if (doc.exists) {
        member = doc.data();
        memberDocId = uid;
      }
    }
    if (!member && email) {
      const found = await findMemberByEmail(email);
      if (found) {
        member = found;
        memberDocId = found.uid;
      }
    }

    if (!member || !memberDocId) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const memberEmail = (member.email || email || '').toLowerCase();
    console.log(`Cancel request from: ${memberEmail}`);

    // Cancel in Stripe
    let stripeCancelled = false, finPeriodo = null;
    const subId = member.stripeSubscriptionId;
    if (subId) {
      try {
        const subAct = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
        if (subAct && subAct.current_period_end) finPeriodo = new Date(subAct.current_period_end * 1000).toISOString().split('T')[0];
        stripeCancelled = true;
        console.log(`Stripe subscription cancelled: ${subId}`);
      } catch (stripeErr) {
        console.error('Stripe cancel error:', stripeErr.message);
        if (stripeErr.code === 'resource_missing' || stripeErr.message.includes('cancel')) {
          stripeCancelled = true;
        }
      }
    } else {
      stripeCancelled = true;
    }

    const now = new Date().toISOString().split('T')[0];
    const accessUntil = finPeriodo || member.nextPaymentDate || now;

    await db.collection('members').doc(memberDocId).update({
      status: 'cancelled',
      cancelledAt: now,
      accessUntil: accessUntil,
      stripeCancelled: stripeCancelled,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Member cancelled: ${memberEmail} | Stripe: ${stripeCancelled} | Access until: ${accessUntil}`);

    // Send cancellation email to client
    const cancelClientHtml = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#f8f9fa;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#0B1A30,#37474F);padding:32px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:1.5rem;letter-spacing:2px;">CLUB FISIOTECK</h1>
          <p style="color:rgba(255,255,255,.7);margin:8px 0 0;font-size:.9rem;">Tu membresía ha sido cancelada</p>
        </div>
        <div style="padding:28px 32px;">
          <p style="font-size:1rem;color:#333;">Hola <strong>${escH(member.name || 'Socio')}</strong>,</p>
          <p style="color:#555;line-height:1.6;">Tu suscripción al Club FisioTeck ha sido cancelada exitosamente. No se realizarán más cobros.</p>
          <div style="background:#FFF3E0;border:1px solid #FFE0B2;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="color:#E65100;font-weight:600;margin:0 0 4px;">Acceso hasta: ${accessUntil}</p>
            <p style="color:#BF360C;font-size:.85rem;margin:0;">Puedes seguir usando todos los beneficios del club hasta esa fecha.</p>
          </div>
          <p style="color:#555;line-height:1.6;">Si cambias de opinión, siempre puedes volver a suscribirte desde el club.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="https://club.fisioteck.com" style="display:inline-block;padding:14px 32px;background:#1565C0;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Volver al Club →</a>
          </div>
          <p style="color:#999;font-size:.8rem;text-align:center;">¡Gracias por haber sido parte del Club FisioTeck!</p>
        </div>
      </div>
    `;
    sendEmailJS(memberEmail, 'Tu membresía del Club FisioTeck ha sido cancelada', cancelClientHtml);

    // Send cancellation email to admin
    const cancelAdminHtml = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#FFF3E0;border:1px solid #FFE0B2;border-radius:12px;padding:24px;">
        <h2 style="color:#E65100;margin:0 0 16px;">Cancelación de membresía</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#666;width:120px;">Nombre:</td><td style="padding:8px 0;color:#333;font-weight:600;">${member.name || 'Sin nombre'}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Email:</td><td style="padding:8px 0;color:#333;">${memberEmail}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Plan:</td><td style="padding:8px 0;color:#333;font-weight:600;">${(member.plan || 'mensual') === 'anual' ? 'Anual' : 'Mensual'}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Acceso hasta:</td><td style="padding:8px 0;color:#E65100;font-weight:700;">${accessUntil}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Cancelado:</td><td style="padding:8px 0;color:#333;">${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Stripe:</td><td style="padding:8px 0;color:#333;">${stripeCancelled ? 'Cancelado ' : 'Pendiente '}</td></tr>
        </table>
      </div>
    `;
    sendEmailJS(ADMIN_EMAIL, `Cancelación: ${member.name || memberEmail} - ${(member.plan || 'mensual') === 'anual' ? 'Anual' : 'Mensual'}`, cancelAdminHtml);

    await notifyAdmin('cancellation', {
      memberName: member.name || memberEmail,
      memberEmail: memberEmail,
      plan: member.plan || 'mensual',
      accessUntil: accessUntil,
      cancelledAt: now
    });

    res.json({
      success: true,
      stripeCancelled: stripeCancelled,
      accessUntil: accessUntil
    });

  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== API: Reactivar una suscripción cancelada que todavía no vence =====
app.post('/api/reactivate-subscription', requireFirebaseUser, limitarPago, async (req, res) => {
  try {
    const uid = req.firebaseUser.uid, ref = db.collection('members').doc(uid), doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontramos tu cuenta.' });
    const m = doc.data() || {};
    if (m.status !== 'cancelled' || !m.stripeSubscriptionId || m.suscripcionTerminada) return res.status(409).json({ error: 'Tu suscripción no está cancelada o ya terminó. Suscríbete de nuevo desde el Club.' });
    await stripe.subscriptions.update(m.stripeSubscriptionId, { cancel_at_period_end: false });
    await ref.update({ status: 'active', accessUntil: '', cancelledAt: '', stripeCancelled: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (err) {
    console.error('Reactivate error:', err.message);
    res.status(500).json({ error: 'No se pudo reactivar tu suscripción.' });
  }
});

// ===== API: Fetch news from NewsData.io (with 6h cache) =====
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || ''; // antes estaba escrita en el código: rota esa clave en newsdata.io y ponla como variable de entorno

// Noticias guardadas en Firestore con tarea diaria y aviso en la campana (services/noticias.js, como Alintec y Zoorigen).
// La ruta /api/news vive ahí; este bloque viejo (NewsData directo con caché en memoria) se reemplazó.
const noticiasSvc = require('./services/noticias').crearNoticias({ db, admin });
noticiasSvc.montarRutas(app);
// Tarea de noticias: al arrancar (1 min después) y luego cada 12 horas; solo si hay NEWSDATA_API_KEY
if (NEWSDATA_API_KEY) {
  const sincronizarNoticias = () => noticiasSvc.sincronizar().then(r => { if (r.ok && r.nuevas) console.log('📰 Noticias nuevas guardadas:', r.nuevas); else if (!r.ok) console.warn('📰 Noticias:', r.motivo); }).catch(e => console.warn('📰 Noticias:', e && e.message));
  setTimeout(sincronizarNoticias, 60 * 1000);
  setInterval(sincronizarNoticias, 12 * 60 * 60 * 1000);
}

// ===== API: Expirar miembros vencidos (barrida masiva) =====
// Marca 'inactive' a todos los miembros cuyo periodo pagado ya venció.
// Respeta la fecha real de cada usuario (Stripe: nextPaymentDate, legacy Shopify: startDate + período).
// Puede ejecutarse manualmente o programarse en cron-job.org (recomendado: diario).
//
// Uso: POST /api/expire-inactive-members?token=XXX
//   - Requiere ADMIN_TOKEN en Railway env vars para seguridad
//   - ?dryRun=1 para probar sin escribir (solo devuelve lista)
function calcularFechaVencimientoBackend(data) {
  if (!data) return null;
  const parseDate = (str) => {
    if (!str) return null;
    const d = new Date(str + 'T23:59:59');
    return isNaN(d.getTime()) ? null : d;
  };

  if (data.accessUntil) return parseDate(data.accessUntil);
  if (data.nextPaymentDate) return parseDate(data.nextPaymentDate);
  if (data.startDate) {
    const start = new Date(data.startDate + 'T00:00:00');
    if (isNaN(start.getTime())) return null;
    const plan = data.plan || 'mensual';
    const venc = new Date(start);
    if (plan === 'anual') venc.setFullYear(venc.getFullYear() + 1);
    else venc.setMonth(venc.getMonth() + 1);
    venc.setHours(23, 59, 59, 999);
    return venc;
  }
  return null;
}

app.post('/api/expire-inactive-members', async (req, res) => {
  try {
    // Seguridad: exigir token admin
    // Encabezado x-admin-token (recomendado), cuerpo o ?token= (como lo indica la documentación para cron-job.org)
    const providedToken = String(req.get('x-admin-token') || req.body?.token || req.query.token || '');
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
    if (!ADMIN_TOKEN || !iguales(providedToken, ADMIN_TOKEN)) {
      return res.status(401).json({ error: 'No autorizado.' });
    }

    const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
    const now = new Date();
    const nowStr = now.toISOString().split('T')[0];

    // Sólo revisar estatus que pueden vencer
    const snapshot = await db.collection('members')
      .where('status', 'in', ['active', 'paid', 'cancelled'])
      .get();

    const expired = [];
    const kept = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const venc = calcularFechaVencimientoBackend(data);

      if (venc && now > venc) {
        expired.push({
          uid: doc.id,
          email: data.email || '',
          name: data.name || '',
          plan: data.plan || 'mensual',
          previousStatus: data.status,
          vencimiento: venc.toISOString().split('T')[0],
          origen: data.nextPaymentDate ? 'stripe' : (data.startDate ? 'legacy' : 'accessUntil')
        });

        if (!dryRun) {
          try {
            await doc.ref.update({
              status: 'inactive',
              autoExpiredAt: nowStr,
              autoExpiredFrom: data.status,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } catch (updErr) {
            console.error(`Error expirando ${doc.id}:`, updErr.message);
          }
        }
      } else {
        kept.push({ uid: doc.id, email: data.email || '', vencimiento: venc ? venc.toISOString().split('T')[0] : 'sin-fecha' });
      }
    }

    console.log(`[expire] ${dryRun ? 'DRY RUN' : 'APLICADO'}: ${expired.length} expirados, ${kept.length} vigentes`);

    res.json({
      dryRun: dryRun,
      expiredCount: expired.length,
      keptCount: kept.length,
      expired: expired,
      timestamp: now.toISOString()
    });
  } catch (err) {
    console.error('Expire error:', err);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// ===== CERTIFICADOS Y RUTAS DE ADMINISTRADOR (services/certificados.js) =====
const depsCert = { db, admin, cargarCatalogo: loadBunnyCatalog, enviarCorreoCertificado: c => correoSvc.enviarCorreoCertificado(c) };
require('./services/certificados').montarRutasCertificados(app, depsCert);
// Correos de cuenta con la plantilla de FisioTeck: confirmar correo y restablecer contraseña
require('./services/rutas-auth').montarRutasAuth(app, { admin });

// ===== AVANCE POR CLASE (services/progreso.js): solo el servidor escribe el avance =====
const depsAcceso = { db, admin, cargarCatalogo: loadBunnyCatalog, tieneMembresia: memberHasPremiumAccess, emitirCertificadoAuto: depsCert.emitirCertificadoAuto };
// Recordatorios de pago por correo con cupones (arrancan APAGADOS: el administrador los activa desde el panel)
const recordatorios = require('./services/recordatorios').crearRecordatorios({ db, admin, stripe, tieneMembresia: memberHasPremiumAccess, cargarCatalogo: loadBunnyCatalog, leerPreciosConfig, apiPublica: 'https://web-production-cd020.up.railway.app' });
recordatorios.montarRutas(app);
// Historial del servidor y acciones de miembros con bitácora de quién hizo qué (services/rutas-servidor.js)
require('./services/rutas-servidor').montarRutasServidor(app, { db, admin, stripe, bitacora: bitacoraServidor });
require('./services/admin-extra').montarRutasAdminExtra(app, { db, admin, stripe, registrarCatalogoExtra, cargarCatalogo: loadBunnyCatalog }); // Bunny, catálogo de cursos nuevos y estado de servicios
require('./services/acceso').montarRutasAcceso(app, depsAcceso); // /api/acceso, /api/retos (escalonado y retos calificados)
require('./services/resenas').montarRutasResenas(app, depsAcceso); // reseñas de cursos (solo quien tiene el certificado)
require('./services/rutas-referidos').montarRutasReferidos(app, depsAcceso); // referidos y premio por invitar
require('./services/creditos').montarRutasCreditos(app, depsAcceso); // créditos y cupones (cuentas con y sin membresía)
require('./services/directorio').montarRutasDirectorio(app, depsAcceso); // directorio VIP: contacto privado, VIP verificado y certificados
require('./services/cuenta').montarRutasCuenta(app, { db, admin, stripe, tieneMembresia: memberHasPremiumAccess }); // eliminar mi cuenta (borra todo lo de la persona)
require('./services/admin-miembros').montarRutasAdminMiembros(app, { db, admin, stripe }); // pagos desde Stripe, papelera de miembros y retos y XP del panel
require('./services/avisos-config').montarRutasAvisosConfig(app, { db, admin }); // aviso global del Club, «clases en vivo pronto» y avisos a todos desde el panel
require('./services/foro-admin').montarRutasForoAdmin(app, { db, admin }); // moderación del foro y temas oficiales del equipo
require('./services/soporte').montarRutasSoporte(app, { db, admin }); // quejas, sugerencias y problemas de los miembros hacia el panel del administrador
require('./services/avisos').montarRutasAvisos(app, { db, admin }); // avisos personales de la campana (respuestas del foro)
require('./services/webinars').montarRutasWebinars(app, depsAcceso); // clases en vivo: enlace y grabación solo para miembros (nunca en content.json)
require('./services/libros').montarRutasLibros(app, depsAcceso); // libros de lectura que se abren con retos
depsAcceso.sembrarLibros().catch(e => console.warn('Libros base (siembra):', e.message));
const datosCuriosos = require('./services/datos-curiosos').crearServicio({ db, admin }); // dato curioso martes y viernes en la campana
datosCuriosos.montarRutas(app);
datosCuriosos.sembrar().catch(e => console.warn('Datos curiosos (siembra):', e.message));
setInterval(() => datosCuriosos.revisarEnvio().catch(e => console.warn('Datos curiosos (envío):', e.message)), 3600 * 1000).unref();
require('./services/logros').montarRutasLogros(app, depsAcceso); // XP, racha, insignias, reto del día y flashcards: los calcula el servidor
require('./services/materiales').montarRutasMateriales(app, depsAcceso); // materiales de curso (por clase) y materiales libres, con enlaces privados
require('./services/quiz').montarRutasQuiz(app, depsAcceso); // preguntas de clase: la respuesta correcta solo la conoce el servidor
require('./services/juegos').montarRutasJuegos(app, depsAcceso); // juegos dinámicos de clase: solo se entregan a quien tiene acceso al curso
depsAcceso.refrescarMaterialesLibres().catch(e => console.error('materialesLibres:', e.message));
setInterval(() => depsAcceso.refrescarMaterialesLibres().catch(() => {}), 10 * 60000).unref(); // cada 10 min: antes cada minuto leía toda la colección y gastaba miles de lecturas al día
require('./services/rutas-publico').montarRutasPublico(app, depsAcceso); // encuesta de la portada, guía sin respuesta y visitas
require('./services/progreso').montarRutasProgreso(app, depsAcceso);

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'Club FisioTeck Webhook Server (Stripe)',
    endpoints: [
      'POST /webhooks/stripe',
      'POST /api/create-checkout',
      'GET /api/checkout-status/:sessionId',
      'GET /api/member/:email',
      'POST /api/link-member',
      'POST /api/cancel-subscription',
      'POST /api/video-playback (requiere Firebase ID token)',
      'POST /api/certificados/emitir · GET /api/certificados/:folio (requiere Firebase ID token para emitir)',
      'POST /api/encuesta · POST /api/chatbot/sin-respuesta · POST /api/visita (públicas, con límites)',
      'GET /api/cursos/:cursoId/materiales · POST /api/cursos/:cursoId/materiales/:indice/enlace (requiere Firebase ID token)',
      'GET /api/creditos · POST /api/creditos/canjear · POST /api/creditos/cupon · GET /api/materiales/:id/enlace (requiere Firebase ID token)',
      'POST /api/referidos/registrar · GET /api/referidos/estado · POST /api/premios/usar (requiere Firebase ID token)',
      'POST /api/resenas · GET /api/resenas/mias (requiere Firebase ID token)',
      'GET /api/acceso · GET /api/retos · POST /api/retos/completar (requiere Firebase ID token)',
      'POST /api/cursos/:cursoId/progreso · GET /api/cursos/progreso (requiere Firebase ID token)',
      'GET /api/admin/bunny-catalogo · POST /api/admin/catalogo-curso · GET /api/admin/estado (solo administradores)',
      'GET /api/admin/* (solo administradores)',
      'POST /api/expire-inactive-members (requiere ?token=)'
    ]
  });
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`Club FisioTeck Webhook Server (Stripe) running on port ${PORT}`);
  recordatorios.iniciarTarea();
  bitacoraServidor.iniciar().catch(e => console.warn('Bitácora del servidor no iniciada:', e && e.message));
  // Limpieza diaria: se borran los identificadores anónimos de visitantes de días viejos (solo sirven para contar únicos del propio día)
  const limpiarVisitas = () => require('./services/visitas').limpiarVisitantesAntiguos(db).then(n => { if (n) console.log('🧹 Visitantes antiguos borrados:', n); }).catch(e => console.warn('Limpieza de visitas:', e && e.message));
  setTimeout(limpiarVisitas, 5 * 60 * 1000).unref(); setInterval(limpiarVisitas, 24 * 3600 * 1000).unref();
  // Suscripciones al día SIN el aviso customer.subscription.updated (no hay acceso al panel de Stripe para
  // agregarlo al webhook): cada 6 horas se le pregunta a Stripe y se aplican los mismos cambios.
  const sincronizarSuscripciones = () => suscripcion.sincronizarSuscripciones(db, stripe)
    .then(r => { if (r.cambiados || r.errores) console.log('🔄 Suscripciones: ' + r.revisados + ' revisadas, ' + r.cambiados + ' actualizadas' + (r.errores ? ', ' + r.errores + ' con error' : '')); })
    .catch(e => console.warn('Suscripciones:', e && e.message));
  setTimeout(sincronizarSuscripciones, 2 * 60 * 1000).unref(); setInterval(sincronizarSuscripciones, 6 * 3600 * 1000).unref();
});
