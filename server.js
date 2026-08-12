const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ===== FIREBASE INIT =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

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
    const precioMes = Number(c.precioMes) > 0 ? Number(c.precioMes) : 249;
    const precioAno = Number(c.precioAno) > 0 ? Number(c.precioAno) : 1999;
    return { precioMes, precioAno };
  } catch (e) {
    console.error('Error leyendo precios config:', e.message);
    return { precioMes: 249, precioAno: 1999 };
  }
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'teccapitalweb@gmail.com';

// ===== EMAILJS CONFIG =====
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || '';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || '';
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || '';
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || '';

async function sendEmailJS(toEmail, subject, htmlMessage) {
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
        <p style="font-size:1rem;color:#333;">¡Hola <strong>${name || 'Socio'}</strong>! 👋</p>
        <p style="color:#555;line-height:1.6;">Gracias por unirte al Club FisioTeck. Tu suscripción <strong>${planLabel}</strong> ya está activa.</p>
        <p style="color:#555;line-height:1.6;">Ahora tienes acceso completo a:</p>
        <ul style="color:#555;line-height:1.8;">
          <li>📚 Todos los cursos grabados</li>
          <li>🎓 Cursos en vivo y webinars</li>
          <li>🛠️ Herramientas clínicas profesionales</li>
          <li>💬 Foro exclusivo de la comunidad</li>
          <li>📄 Biblioteca de PDFs y recursos</li>
        </ul>
        <div style="text-align:center;margin:24px 0;">
          <a href="https://club.fisioteck.com" style="display:inline-block;padding:14px 32px;background:#1565C0;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Ir al Club FisioTeck →</a>
        </div>
        <p style="color:#999;font-size:.8rem;text-align:center;">Si tienes dudas, contáctanos por WhatsApp.</p>
      </div>
    </div>
  `;
  await sendEmailJS(email, '¡Bienvenido al Club FisioTeck! Tu membresía está activa 🎉', html);
}

async function sendEmailToAdmin(email, name, plan, amount) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#f0f7ff;border:1px solid #d0e3f7;border-radius:12px;padding:24px;">
      <h2 style="color:#1565C0;margin:0 0 16px;">💰 Nuevo pago recibido</h2>
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
  await sendEmailJS(ADMIN_EMAIL, `💰 Nuevo pago: ${name || email} - ${plan === 'anual' ? 'Anual' : 'Mensual'}`, html);
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
app.use(cors());

// ===== BUNNY STREAM: catálogo y reproducción firmada =====
const BUNNY_CATALOG_PATH = path.join(__dirname, 'data', 'bunny-catalog.json');
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || '';
const BUNNY_STREAM_TOKEN_KEY = process.env.BUNNY_STREAM_TOKEN_KEY || '';
const BUNNY_STREAM_PLAYER_HOST = (process.env.BUNNY_STREAM_PLAYER_HOST || 'https://iframe.mediadelivery.net').replace(/\/$/, '');
const BUNNY_PLAYBACK_TTL_SECONDS = Math.max(60, Math.min(Number(process.env.BUNNY_PLAYBACK_TTL_SECONDS) || 900, 3600));

function loadBunnyCatalog() {
  if (!fs.existsSync(BUNNY_CATALOG_PATH)) return { libraryId: '', courses: [] };
  return JSON.parse(fs.readFileSync(BUNNY_CATALOG_PATH, 'utf8'));
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
    if (!match) return res.status(401).json({ error: 'Inicia sesión para reproducir esta clase.' });
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

    const isPreview = entry.lesson.isPreview === true;
    if (!isPreview && !memberHasPremiumAccess(memberDoc.data())) {
      return res.status(402).json({ error: 'Esta clase se desbloquea con la membresía.' });
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
    return res.json({ embedUrl, expiresAt: new Date(expires * 1000).toISOString(), preview: isPreview });
  } catch (error) {
    console.error('Bunny playback error:', error.message);
    return res.status(500).json({ error: 'No se pudo preparar la reproducción.' });
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
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { plan, email, uid, mode } = req.body;
    if (!plan || !email) {
      return res.status(400).json({ error: 'Plan and email required' });
    }
    if (!['mensual', 'anual'].includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido (mensual o anual)' });
    }

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

    const session = await stripe.checkout.sessions.create(sessionConfig);

    res.json({
      url: session.url || null,                   // frontend nuevo (popup)
      clientSecret: session.client_secret || null // frontend viejo (embedded)
    });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Error creating checkout session' });
  }
});

// ===== API: Check session status (after payment) =====
app.get('/api/checkout-status/:sessionId', async (req, res) => {
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
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET
      );
    } else {
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe event received: ${event.type}`);

  // RESPOND IMMEDIATELY to Stripe (avoid timeout)
  res.json({ received: true });

  // Process in background
  try {
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
            plan: planType,
            lastPaymentDate: now,
            nextPaymentDate: nextDate.toISOString().split('T')[0],
            paymentMethod: 'Stripe',
            stripeCustomerId: session.customer || '',
            stripeSubscriptionId: subscriptionId,
            payments: admin.firestore.FieldValue.arrayUnion(paymentRecord),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`Member updated: ${email}`);

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
            nextPaymentDate: nextDate.toISOString().split('T')[0],
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
        let subMeta = {};
        try {
          const subForMeta = await stripe.subscriptions.retrieve(subscriptionId);
          subMeta = subForMeta.metadata || {};
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

        const member = await findMemberByEmail(email);
        if (member) {
          await db.collection('members').doc(member.uid).update({
            status: 'active',
            lastPaymentDate: now,
            nextPaymentDate: nextDate.toISOString().split('T')[0],
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

        if (!email) break;

        console.log(`Subscription cancelled: ${email}`);

        const member = await findMemberByEmail(email);
        if (member) {
          // 🛡️ Guarda anti-stale: solo cancelar si la sub coincide con la guardada
          if (member.stripeSubscriptionId && member.stripeSubscriptionId !== subscription.id) {
            console.log(`Ignorado (deleted): sub.id ${subscription.id} no coincide con guardada ${member.stripeSubscriptionId}`);
            break;
          }

          const now = new Date().toISOString().split('T')[0];
          const accessUntil = member.nextPaymentDate || now;

          await db.collection('members').doc(member.uid).update({
            status: 'cancelled',
            cancelledAt: now,
            accessUntil: accessUntil,
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

        const member = await findMemberByEmail(email);
        if (member) {
          await db.collection('members').doc(member.uid).update({
            status: 'inactive',
            paymentFailedAt: new Date().toISOString().split('T')[0],
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          await notifyAdmin('payment_failed', {
            memberName: member.name || email,
            memberEmail: email,
            plan: member.plan || 'mensual'
          });
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
}

// ===== API: Check member status (for Club site) =====
app.get('/api/member/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
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
app.post('/api/link-member', async (req, res) => {
  try {
    const { email, uid } = req.body;
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
app.post('/api/cancel-subscription', async (req, res) => {
  try {
    const { email, uid } = req.body;
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
    let stripeCancelled = false;
    const subId = member.stripeSubscriptionId;
    if (subId) {
      try {
        await stripe.subscriptions.cancel(subId);
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
    const accessUntil = member.nextPaymentDate || now;

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
          <p style="font-size:1rem;color:#333;">Hola <strong>${member.name || 'Socio'}</strong>,</p>
          <p style="color:#555;line-height:1.6;">Tu suscripción al Club FisioTeck ha sido cancelada exitosamente. No se realizarán más cobros.</p>
          <div style="background:#FFF3E0;border:1px solid #FFE0B2;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="color:#E65100;font-weight:600;margin:0 0 4px;">📅 Acceso hasta: ${accessUntil}</p>
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
        <h2 style="color:#E65100;margin:0 0 16px;">⚠️ Cancelación de membresía</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#666;width:120px;">Nombre:</td><td style="padding:8px 0;color:#333;font-weight:600;">${member.name || 'Sin nombre'}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Email:</td><td style="padding:8px 0;color:#333;">${memberEmail}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Plan:</td><td style="padding:8px 0;color:#333;font-weight:600;">${(member.plan || 'mensual') === 'anual' ? 'Anual' : 'Mensual'}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Acceso hasta:</td><td style="padding:8px 0;color:#E65100;font-weight:700;">${accessUntil}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Cancelado:</td><td style="padding:8px 0;color:#333;">${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Stripe:</td><td style="padding:8px 0;color:#333;">${stripeCancelled ? 'Cancelado ✅' : 'Pendiente ⚠️'}</td></tr>
        </table>
      </div>
    `;
    sendEmailJS(ADMIN_EMAIL, `⚠️ Cancelación: ${member.name || memberEmail} - ${(member.plan || 'mensual') === 'anual' ? 'Anual' : 'Mensual'}`, cancelAdminHtml);

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

// ===== API: Fetch news from NewsData.io (with 6h cache) =====
const NEWSDATA_API_KEY = 'pub_0e241a225e664d0c8e13129875265f78';
let newsCache = { articles: [], lastFetch: 0 };
const NEWS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

app.get('/api/news', async (req, res) => {
  try {
    // Return cache if still valid
    if (newsCache.articles.length > 0 && (Date.now() - newsCache.lastFetch) < NEWS_CACHE_TTL) {
      console.log('Serving cached news');
      return res.json({ articles: newsCache.articles });
    }

    const url = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_API_KEY}&q=fisioterapia OR rehabilitacion OR ortopedia&language=es&category=health&size=10`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('NewsData error: ' + response.status);
    const data = await response.json();

    let results = data.results || [];

    if (results.length === 0) {
      // Fallback: broader health search
      const url2 = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_API_KEY}&q=medicina deportiva OR terapia fisica&language=es&category=health&size=10`;
      const res2 = await fetch(url2);
      if (res2.ok) {
        const data2 = await res2.json();
        results = data2.results || [];
      }
    }

    const articles = results.map(a => ({
      title: a.title || '',
      description: a.description || '',
      content: a.content || '',
      url: a.link || '',
      image: a.image_url || null,
      publishedAt: a.pubDate || '',
      source: { name: a.source_name || 'Noticias' }
    }));

    // Remove duplicates by title
    const seen = new Set();
    const uniqueArticles = articles.filter(a => {
      const key = a.title.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Update cache
    newsCache = { articles: uniqueArticles, lastFetch: Date.now() };
    console.log(`News fetched and cached: ${uniqueArticles.length} articles`);

    res.json({ articles: uniqueArticles });
  } catch(err) {
    console.error('News fetch error:', err.message);
    // Return stale cache if available
    if (newsCache.articles.length > 0) {
      return res.json({ articles: newsCache.articles });
    }
    res.status(500).json({ error: 'Error fetching news' });
  }
});

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
    const providedToken = req.query.token || req.body?.token || '';
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
    if (!ADMIN_TOKEN || providedToken !== ADMIN_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized. Provide ?token=YOUR_ADMIN_TOKEN' });
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
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

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
      'POST /api/expire-inactive-members (requiere ?token=)'
    ]
  });
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`Club FisioTeck Webhook Server (Stripe) running on port ${PORT}`);
});
