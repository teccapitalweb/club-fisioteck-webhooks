const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

// ===== FIREBASE INIT =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

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
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'pfueck-wm.myshopify.com';

// Raw body needed for Shopify webhook verification
app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

// ===== VERIFY SHOPIFY WEBHOOK =====
function verifyShopifyWebhook(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true; // Skip verification if no secret
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return false;
  const hash = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
}

// ===== HELPER: Find member by email =====
async function findMemberByEmail(email) {
  const snapshot = await db.collection('members')
    .where('email', '==', email.toLowerCase())
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return { uid: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

// ===== HELPER: Determine plan type =====
function getPlanType(lineItems) {
  for (const item of lineItems) {
    const title = (item.title || '').toLowerCase();
    if (title.includes('club fisioteck')) {
      if (title.includes('anual') || title.includes('annual')) return 'anual';
      if (title.includes('mensual') || title.includes('monthly')) return 'mensual';
      return 'mensual';
    }
  }
  return null;
}

// ===== WEBHOOK: Order Created / Paid =====
app.post('/webhooks/orders/paid', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).send('Unauthorized');
    }
    const order = JSON.parse(req.body);
    const email = (order.email || order.contact_email || '').toLowerCase();
    const lineItems = order.line_items || [];
    const planType = getPlanType(lineItems);

    if (!email || !planType) {
      console.log('Order not related to Club FisioTeck or no email:', email);
      return res.status(200).send('OK - Not a Club order');
    }

    console.log(`Payment received: ${email} - Plan: ${planType}`);

    // Find or prepare member data
    const member = await findMemberByEmail(email);
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
      orderId: order.id?.toString() || '',
      paymentMethod: order.payment_gateway_names?.[0] || 'Shopify'
    };

    if (member) {
      // Update existing member
      await db.collection('members').doc(member.uid).update({
        status: 'active',
        plan: planType,
        lastPaymentDate: now,
        nextPaymentDate: nextDate.toISOString().split('T')[0],
        paymentMethod: order.payment_gateway_names?.[0] || 'Shopify',
        payments: admin.firestore.FieldValue.arrayUnion(paymentRecord),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`Member updated: ${email}`);
    } else {
      // Create pending member (will be linked when they register)
      await db.collection('pending_members').doc(email).set({
        email: email,
        name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
        phone: order.customer?.phone || '',
        plan: planType,
        status: 'active',
        startDate: now,
        lastPaymentDate: now,
        nextPaymentDate: nextDate.toISOString().split('T')[0],
        paymentMethod: order.payment_gateway_names?.[0] || 'Shopify',
        payments: [paymentRecord],
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`Pending member created: ${email}`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error processing webhook');
  }
});

// ===== WEBHOOK: Subscription cancelled =====
app.post('/webhooks/subscriptions/cancelled', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).send('Unauthorized');
    }
    const data = JSON.parse(req.body);
    const email = (data.email || data.customer_email || '').toLowerCase();

    if (!email) return res.status(200).send('OK - No email');

    console.log(`Subscription cancelled: ${email}`);

    const member = await findMemberByEmail(email);
    if (member) {
      await db.collection('members').doc(member.uid).update({
        status: 'inactive',
        cancelledAt: new Date().toISOString().split('T')[0],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`Member deactivated: ${email}`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

// ===== WEBHOOK: Subscription payment failed =====
app.post('/webhooks/subscriptions/failed', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).send('Unauthorized');
    }
    const data = JSON.parse(req.body);
    const email = (data.email || data.customer_email || '').toLowerCase();

    if (!email) return res.status(200).send('OK');

    console.log(`Payment failed: ${email}`);

    const member = await findMemberByEmail(email);
    if (member) {
      await db.collection('members').doc(member.uid).update({
        status: 'inactive',
        paymentFailedAt: new Date().toISOString().split('T')[0],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

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
      // Check pending members
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
      // Update the member document with payment data
      await db.collection('members').doc(uid).update({
        status: pendingData.status || 'active',
        plan: pendingData.plan || 'mensual',
        startDate: pendingData.startDate || '',
        lastPaymentDate: pendingData.lastPaymentDate || '',
        nextPaymentDate: pendingData.nextPaymentDate || '',
        paymentMethod: pendingData.paymentMethod || '',
        payments: pendingData.payments || [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // Delete pending record
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

    // 1. Find member in Firebase
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

    // 2. Find customer in Shopify by email
    let shopifyCancelled = false;
    if (SHOPIFY_ACCESS_TOKEN && memberEmail) {
      try {
        // Search customer by email
        const custRes = await fetch(
          `https://${SHOPIFY_STORE}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(memberEmail)}`,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
        const custData = await custRes.json();
        const customer = custData.customers?.[0];

        if (customer) {
          // Use GraphQL to find and cancel subscription contracts
          const graphqlRes = await fetch(
            `https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
            {
              method: 'POST',
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                query: `{
                  subscriptionContracts(first: 10, query: "customer_id:${customer.id}") {
                    edges {
                      node {
                        id
                        status
                      }
                    }
                  }
                }`
              })
            }
          );
          const graphqlData = await graphqlRes.json();
          const contracts = graphqlData.data?.subscriptionContracts?.edges || [];

          // Cancel each active subscription
          for (const edge of contracts) {
            if (edge.node.status === 'ACTIVE') {
              const cancelRes = await fetch(
                `https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
                {
                  method: 'POST',
                  headers: {
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    query: `mutation {
                      subscriptionContractCancel(subscriptionContractId: "${edge.node.id}") {
                        contract { id status }
                        userErrors { field message }
                      }
                    }`
                  })
                }
              );
              const cancelData = await cancelRes.json();
              const errors = cancelData.data?.subscriptionContractCancel?.userErrors || [];
              if (errors.length === 0) {
                console.log(`Shopify subscription cancelled: ${edge.node.id}`);
                shopifyCancelled = true;
              } else {
                console.log(`Shopify cancel error:`, errors);
              }
            }
          }

          if (contracts.length === 0) {
            console.log(`No active subscriptions found in Shopify for ${memberEmail}`);
            shopifyCancelled = true; // No subs to cancel = OK
          }
        } else {
          console.log(`Customer not found in Shopify: ${memberEmail}`);
          shopifyCancelled = true; // Customer not in Shopify = OK
        }
      } catch (shopifyErr) {
        console.error('Shopify API error:', shopifyErr.message);
        // Continue with Firebase update even if Shopify fails
      }
    }

    // 3. Update Firebase
    const now = new Date().toISOString().split('T')[0];
    const accessUntil = member.nextPaymentDate || now;

    await db.collection('members').doc(memberDocId).update({
      status: 'cancelled',
      cancelledAt: now,
      accessUntil: accessUntil,
      shopifyCancelled: shopifyCancelled,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Member cancelled: ${memberEmail} | Shopify: ${shopifyCancelled} | Access until: ${accessUntil}`);

    // Save notification for admin
    await notifyAdmin('cancellation', {
      memberName: member.name || memberEmail,
      memberEmail: memberEmail,
      plan: member.plan || 'mensual',
      accessUntil: accessUntil,
      cancelledAt: now
    });

    res.json({
      success: true,
      shopifyCancelled: shopifyCancelled,
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
    service: 'Club FisioTeck Webhook Server',
    endpoints: [
      'POST /webhooks/orders/paid',
      'POST /webhooks/subscriptions/cancelled',
      'POST /webhooks/subscriptions/failed',
      'GET /api/member/:email',
      'POST /api/link-member',
      'POST /api/cancel-subscription'
    ]
  });
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`Club FisioTeck Webhook Server running on port ${PORT}`);
});
