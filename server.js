const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Stripe = require('stripe');

// ===== FIREBASE INIT =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ===== STRIPE INIT =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Price IDs
const PRICE_MENSUAL = process.env.STRIPE_PRICE_MENSUAL || 'price_1TPYw1PBgqsOPfUYOJBKrQiu';
const PRICE_ANUAL = process.env.STRIPE_PRICE_ANUAL || 'price_1TPYxlPBgqsOPfUYsgjdFsVM';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'teccapitalweb@gmail.com';

// ===== EMAILJS CONFIG =====
const EMAILJS_SERVICE_ID = 'service_s3q0xp7';
const EMAILJS_TEMPLATE_ID = 'template_109lwi6';
const EMAILJS_PUBLIC_KEY = 'iIBc65PznIzD84KgR';
const EMAILJS_PRIVATE_KEY = '75xg9N1EQU1Cy2MEfK75k';

async function sendEmailJS(toEmail, subject, htmlMessage) {
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

async function sendEmailToClient(email, name, plan) {
  const planLabel = plan === 'anual' ? 'Plan Anual ($1,999 MXN/año)' : 'Plan Mensual ($249 MXN/mes)';
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
function getPlanFromPrice(priceId) {
  if (priceId === PRICE_ANUAL) return 'anual';
  if (priceId === PRICE_MENSUAL) return 'mensual';
  return null;
}

// ===== API: Create Stripe Checkout Session (for embedded/popup) =====
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { plan, email, uid } = req.body;
    if (!plan || !email) {
      return res.status(400).json({ error: 'Plan and email required' });
    }

    const priceId = plan === 'anual' ? PRICE_ANUAL : PRICE_MENSUAL;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        firebaseUid: uid || '',
        plan: plan
      },
      ui_mode: 'embedded',
      return_url: 'https://club.fisioteck.com?session_id={CHECKOUT_SESSION_ID}',
    });

    res.json({ clientSecret: session.client_secret });
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
          const priceId = sub.items?.data?.[0]?.price?.id || '';
          planType = getPlanFromPrice(priceId) || 'mensual';
        }
        if (!planType) planType = 'mensual';

        console.log(`Checkout completed: ${email} - Plan: ${planType}`);

        const now = new Date().toISOString().split('T')[0];
        const amount = planType === 'anual' ? 1999 : 249;
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
          await sendEmailToClient(email, member.name || '', planType);
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
          await sendEmailToClient(email, session.customer_details?.name || '', planType);
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
        if (priceId) {
          planType = getPlanFromPrice(priceId) || 'mensual';
        }

        const now = new Date().toISOString().split('T')[0];
        const amount = planType === 'anual' ? 1999 : 249;
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
          const now = new Date().toISOString().split('T')[0];
          const accessUntil = member.nextPaymentDate || now;

          await db.collection('members').doc(member.uid).update({
            status: 'cancelled',
            cancelledAt: now,
            accessUntil: accessUntil,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`Member cancelled: ${email}`);

          await notifyAdmin('cancellation', {
            memberName: member.name || email,
            memberEmail: email,
            plan: member.plan || 'mensual',
            accessUntil: accessUntil,
            cancelledAt: now
          });
        }
        break;
      }

      // ===== PAYMENT FAILED =====
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const email = (invoice.customer_email || '').toLowerCase();

        if (!email) break;

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
      'POST /api/cancel-subscription'
    ]
  });
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`Club FisioTeck Webhook Server (Stripe) running on port ${PORT}`);
});
