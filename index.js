const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── SUPABASE ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── GENERAL PAYMENT PAGE ID ──
const GENERAL_PAYMENT_PAGE_ID = 'pl_SvxuRdqY2rd7ge';

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── HELPERS ──
async function generateId(table, prefix) {
  const { data } = await supabase
    .from(table)
    .select('id')
    .like('id', `${prefix}-%`)
    .order('id', { ascending: false })
    .limit(1);
  if (data && data.length > 0) {
    const lastNum = parseInt(data[0].id.replace(`${prefix}-`, ''));
    return `${prefix}-${String(lastNum + 1).padStart(3, '0')}`;
  }
  return `${prefix}-001`;
}

// ── IDEMPOTENCY CHECKS ──
async function isAlreadyProcessed(razorpayPaymentId) {
  const { data, error } = await supabase
    .from('payments')
    .select('id')
    .eq('razorpay_payment_id', razorpayPaymentId)
    .limit(1);
  if (error) { console.warn('Idempotency check error:', error.message); return false; }
  return data && data.length > 0;
}

async function isAlreadyUnassigned(razorpayPaymentId) {
  const { data, error } = await supabase
    .from('unassigned_payments')
    .select('id')
    .eq('razorpay_payment_id', razorpayPaymentId)
    .limit(1);
  if (error) { console.warn('Unassigned idempotency check error:', error.message); return false; }
  return data && data.length > 0;
}

// ── NORMALISE YES/NO ──
function normaliseYesNo(val) {
  if (!val) return null;
  const v = val.toString().trim().toLowerCase();
  if (['yes','y','yeah','yep','yup','true','1','ok','okay'].includes(v)) return 'Yes';
  if (['no','n','nope','nah','false','0'].includes(v)) return 'No';
  return val.trim();
}

// ── EXTRACT ALL FIELDS FROM PAYMENT ──
// This is the single source of truth for what we capture from Razorpay.
// All fields are extracted here. Adding a new field in future = just add it here.
function extractPaymentFields(payment) {
  const notes = payment.notes || {};

  // Core fields
  const name   = notes.name || payment.customer_name || 'Unknown';
  const phone  = payment.contact || null;
  const email  = payment.email || null;
  const amount = payment.amount / 100;

  // Custom note fields — try all known key variants
  const bringingOwn = notes['handpans_will_be_provided_bringing_your_own?_(yes/no)']
    || notes['handpans_will_be_provided_bringing_your_own?(yes/no)']
    || notes['handpans_will_be_provided._bringing_your_own?_(yes/no)']
    || notes['bringing_your_own']
    || null;

  const photoConsent = notes['okay_to_take_your_photo/video_at_the_workshop?_(yes/no)']
    || notes['okay_to_take_your_photo/video_at_the_workshop?(yes/no)']
    || notes['photo_video_consent']
    || null;

  // Page ID
  const pageId = notes.payment_page_id
    || payment.payment_page_id
    || payment.invoice_id
    || null;

  return {
    name,
    phone,
    email,
    amount,
    pageId,
    bringingOwn,        // raw value as typed by user
    photoConsent,       // raw value as typed by user
    bringingOwnNorm: normaliseYesNo(bringingOwn),   // normalised for filters
    photoConsentNorm: normaliseYesNo(photoConsent), // normalised for filters
  };
}

// ── WORKSHOP MATCHING ──
async function findWorkshopByPageId(pageId) {
  if (!pageId) return null;
  const { data } = await supabase
    .from('workshops')
    .select('id')
    .eq('razorpay_page_id', pageId)
    .single();
  return data ? data.id : null;
}

async function findWorkshopByDateAndAmount(amountINR, paymentDateStr) {
  try {
    const { data: workshops } = await supabase
      .from('workshops')
      .select('id, date, price_per_head, venue')
      .neq('archived', true)
      .order('date', { ascending: true });

    if (!workshops) return null;
    const payDate = new Date(paymentDateStr);
    const matches = workshops.filter(w => {
      if (!w.date || !w.price_per_head) return false;
      const wsDate = new Date(w.date);
      const diffDays = (wsDate - payDate) / (1000 * 60 * 60 * 24);
      if (diffDays < 0 || diffDays > 45) return false;
      const pph = Number(w.price_per_head);
      return Math.abs(amountINR - pph) <= pph * 0.05;
    });
    return matches.length ? matches[0] : null;
  } catch (e) {
    console.error('findWorkshopByDateAndAmount error:', e.message);
    return null;
  }
}

// ── SAVE PARTICIPANT (with full raw payload backup) ──
// This function saves all known fields + the full raw Razorpay payment object.
// Even if new columns are added to Supabase later, the raw_payload always has everything.
async function saveParticipant(participantId, fields, workshopId, matchMethod, rawPayment) {
  const { name, phone, email, amount, bringingOwn, photoConsent, bringingOwnNorm, photoConsentNorm } = fields;
  const today = new Date().toISOString().split('T')[0];

  const record = {
    id: participantId,
    full_name: name,
    razorpay_name: name,
    phone: phone || null,
    email: email || null,
    workshop_id: workshopId,
    amount_paid: amount,
    payment_mode: 'Razorpay UPI',
    booking_source: 'Razorpay UPI',
    checked_in: false,
    date: today,
    bringing_own_handpan: bringingOwn || null,
    photo_video_consent: photoConsent || null,
    razorpay_payment_id: rawPayment.id || null,
    raw_payload: rawPayment, // full Razorpay payment object — never lose data
    notes: `Auto-created via Razorpay webhook (matched by ${matchMethod}). Payment ID: ${rawPayment.id}`
  };

  const { error } = await supabase.from('participants').insert(record);

  if (error) {
    console.error('Error saving participant:', error.message);
    // Send a dashboard notification so the failure is visible
    await supabase.from('notifications').insert({
      type: 'warning',
      message: `⚠️ Failed to save participant ${name} — Payment ${rawPayment.id}. Error: ${error.message}`,
      read: false
    });
    return { success: false, error: error.message };
  }

  console.log('Participant saved:', participantId, name, '— all fields captured');
  return { success: true };
}

// ── RAZORPAY WEBHOOK ──
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // 1. Verify signature
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(req.body)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.warn('Invalid Razorpay webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(req.body.toString());
    console.log('Webhook event:', event.event);

    // ── PAYMENT CAPTURED ──
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const fields = extractPaymentFields(payment);
      const today = new Date().toISOString().split('T')[0];

      console.log('Payment:', payment.id, '₹' + fields.amount, 'from', fields.name);
      console.log('Notes:', JSON.stringify(payment.notes));

      const isGeneral = fields.pageId === GENERAL_PAYMENT_PAGE_ID;

      // 2. Idempotency — skip if already processed
      if (isGeneral) {
        if (await isAlreadyUnassigned(payment.id)) {
          console.log('Duplicate unassigned — skipping:', payment.id);
          return res.json({ received: true, skipped: 'duplicate' });
        }
      } else {
        if (await isAlreadyProcessed(payment.id)) {
          console.log('Duplicate workshop payment — skipping:', payment.id);
          return res.json({ received: true, skipped: 'duplicate' });
        }
      }

      // 3. Route general payments to unassigned
      if (isGeneral) {
        const unassignedId = await generateId('unassigned_payments', 'UP');
        const { error } = await supabase.from('unassigned_payments').insert({
          id: unassignedId,
          amount: fields.amount,
          payer_name: fields.name,
          payer_phone: fields.phone,
          payer_email: fields.email,
          razorpay_payment_id: payment.id,
          razorpay_order_id: payment.order_id || null,
          date: today,
          status: 'pending',
          notes: `Auto-created from Razorpay payment ${payment.id}`
        });

        if (error) {
          console.error('Error saving unassigned:', error.message);
          return res.status(500).json({ error: 'Failed to save unassigned payment' });
        }

        await supabase.from('notifications').insert({
          type: 'payment',
          message: `💸 New unassigned payment: ₹${fields.amount} from ${fields.name} — needs assignment`,
          read: false
        });

        return res.json({ received: true, routed: 'unassigned', id: unassignedId });
      }

      // 4. Match workshop
      let workshopId = null;
      let matchMethod = null;

      workshopId = await findWorkshopByPageId(fields.pageId);
      if (workshopId) {
        matchMethod = 'page_id';
        console.log('Workshop matched by page_id:', workshopId);
      } else {
        const matched = await findWorkshopByDateAndAmount(fields.amount, today);
        if (matched) {
          workshopId = matched.id;
          matchMethod = 'date_amount';
          console.log('Workshop matched by date+amount:', workshopId);
        }
      }

      // 5. No workshop match → unassigned
      if (!workshopId) {
        const unassignedId = await generateId('unassigned_payments', 'UP');
        await supabase.from('unassigned_payments').insert({
          id: unassignedId,
          amount: fields.amount,
          payer_name: fields.name,
          payer_phone: fields.phone,
          payer_email: fields.email,
          razorpay_payment_id: payment.id,
          date: today,
          status: 'pending',
          notes: `No workshop match found. Payment ${payment.id}`
        });

        await supabase.from('notifications').insert({
          type: 'warning',
          message: `⚠️ No workshop matched for payment ₹${fields.amount} from ${fields.name} — moved to unassigned`,
          read: false
        });

        return res.json({ received: true, routed: 'unassigned_no_match', id: unassignedId });
      }

      // 6. Save participant with full payload
      const participantId = await generateId('participants', 'P');
      const result = await saveParticipant(participantId, fields, workshopId, matchMethod, payment);

      if (!result.success) {
        return res.status(500).json({ error: 'Failed to save participant', detail: result.error });
      }

      // 7. Update workshop stats
      const { data: ws } = await supabase
        .from('workshops')
        .select('razorpay_pax, total_pax, total_revenue, total_expense')
        .eq('id', workshopId)
        .single();

      if (ws) {
        const newRzpPax   = (ws.razorpay_pax || 0) + 1;
        const newTotalPax = (ws.total_pax || 0) + 1;
        const newRevenue  = (ws.total_revenue || 0) + fields.amount;
        const newProfit   = newRevenue - (ws.total_expense || 0);
        const newMargin   = newRevenue ? newProfit / newRevenue : 0;
        await supabase.from('workshops').update({
          razorpay_pax: newRzpPax,
          total_pax: newTotalPax,
          total_revenue: newRevenue,
          net_profit: newProfit,
          margin: newMargin
        }).eq('id', workshopId);
      }

      // 8. Save payment record
      const paymentId = await generateId('payments', 'PAY');
      const { error: payErr } = await supabase.from('payments').insert({
        id: paymentId,
        razorpay_payment_id: payment.id,
        reference_id: workshopId,
        payer_name: fields.name,
        amount: fields.amount,
        payment_mode: 'Razorpay UPI',
        type: 'income',
        category: 'workshop',
        synced_from_razorpay: true,
        date: today,
        description: `Workshop ${workshopId} — ${fields.name}`
      });

      if (payErr) {
        console.error('Error saving payment record:', payErr.message);
      }

      // 9. Success notification
      await supabase.from('notifications').insert({
        type: 'payment',
        message: `✅ New booking: ₹${fields.amount} from ${fields.name} → ${workshopId} (${matchMethod})`,
        read: false
      });

      return res.json({ received: true, routed: 'workshop', workshopId, participantId, paymentId });
    }

    // ── PAYMENT FAILED ──
    if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      const name = payment.notes?.name || payment.customer_name || 'Unknown';
      console.log('Payment failed:', payment.id);
      await supabase.from('notifications').insert({
        type: 'warning',
        message: `⚠️ Payment failed: ₹${payment.amount / 100} from ${name} — ID ${payment.id}`,
        read: false
      });
    }

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── START ──
app.listen(PORT, () => {
  console.log(`Handpan webhook server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
