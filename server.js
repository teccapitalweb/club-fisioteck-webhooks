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

// ===== HELPER: Save admin notification =====
async function notifyAdmin(type, data) {
  try {
    await db.collection('notifications').add({
      type: type,
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

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).send('Error processing webhook');
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
