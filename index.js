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

/**
 * Idempotency check — returns true if this Razorpay payment ID has already
 * been processed (exists in payments table). Prevents duplicate inserts when
 * Razorpay retries the same webhook event.
 */
async function isAlreadyProcessed(razorpayPaymentId) {
  const { data, error } = await supabase
    .from('payments')
    .select('id')
    .eq('razorpay_payment_id', razorpayPaymentId)
    .limit(1);
  if (error) {
    console.warn('Idempotency check error:', error.message);
    return false; // fail open — better to process than to silently skip
  }
  return data && data.length > 0;
}

/**
 * Same check for unassigned_payments table.
 */
async function isAlreadyUnassigned(razorpayPaymentId) {
  const { data, error } = await supabase
    .from('unassigned_payments')
    .select('id')
    .eq('razorpay_payment_id', razorpayPaymentId)
    .limit(1);
  if (error) {
    console.warn('Unassigned idempotency check error:', error.message);
    return false;
  }
  return data && data.length > 0;
}

/**
 * Fallback: match payment to a workshop by date + amount.
 */
async function findWorkshopByDateAndAmount(amountINR, paymentDateStr) {
  try {
    const { data: workshops, error } = await supabase
      .from('workshops')
      .select('id, date, price_per_head, venue')
      .neq('archived', true)
      .order('date', { ascending: true });

    if (error || !workshops) return null;

    const payDate = new Date(paymentDateStr);

    const matches = workshops.filter(w => {
      if (!w.date || !w.price_per_head) return false;

      const wsDate   = new Date(w.date);
      const diffDays = (wsDate - payDate) / (1000 * 60 * 60 * 24);

      if (diffDays < 0 || diffDays > 45) return false;

      const pph       = Number(w.price_per_head);
      const tolerance = pph * 0.05;
      return Math.abs(amountINR - pph) <= tolerance;
    });

    return matches.length ? matches[0] : null;
  } catch (e) {
    console.error('findWorkshopByDateAndAmount error:', e.message);
    return null;
  }
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
    console.log('Webhook event received:', event.event);

    // ── PAYMENT CAPTURED ──
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;

      const payerName   = payment.notes?.name || payment.customer_name || 'Unknown';
      const payerPhone  = payment.contact || '';
      const payerEmail  = payment.email || '';
      const amountINR   = payment.amount / 100;
      const paymentMode = 'Razorpay UPI';
      const today       = new Date().toISOString().split('T')[0];

      // Parse custom Payment Page notes into readable format
      const noteParts = [];
      const notes = payment.notes || {};
      // Bringing own handpan - try all known key variants
      const bringingOwn = notes['handpans_will_be_provided_bringing_your_own?_(yes/no)']
        || notes['handpans_will_be_provided_bringing_your_own?(yes/no)']
        || notes['handpans_will_be_provided._bringing_your_own?_(yes/no)']
        || notes['bringing_your_own'];
      // Normalise yes/no answers to clean "Yes" / "No"
      function normaliseYesNo(val) {
        if (!val) return null;
        const v = val.toString().trim().toLowerCase();
        if (['yes', 'y', 'yeah', 'yep', 'yup', 'true', '1', 'ok', 'okay'].includes(v)) return 'Yes';
        if (['no', 'n', 'nope', 'nah', 'false', '0'].includes(v)) return 'No';
        return val.trim(); // keep original if unrecognised
      }
      if (bringingOwn) noteParts.push('Bringing own handpan: ' + bringingOwn);
      // Photo/video consent - try all known key variants
      const photoOk = notes['okay_to_take_your_photo/video_at_the_workshop?_(yes/no)']
        || notes['okay_to_take_your_photo/video_at_the_workshop?(yes/no)']
        || notes['photo_video_consent'];
      if (photoOk) noteParts.push('Photo/video OK: ' + photoOk);
      // Any other custom notes keys (excluding name and payment_page_id)
      const skipKeys = ['name', 'payment_page_id', 'upi_app_name'];
      Object.entries(notes).forEach(([k, v]) => {
        if (!skipKeys.includes(k) && k !== 'handpans_will_be_provided_bringing_your_own?(yes/no)'
          && k !== 'handpans_will_be_provided._bringing_your_own?_(yes/no)'
          && k !== 'okay_to_take_your_photo/video_at_the_workshop?(yes/no)'
          && k !== 'okay_to_take_your_photo/video_at_the_workshop?_(yes/no)'
          && !noteParts.some(p => p.includes(String(v)))) {
          // Format key: replace underscores with spaces, capitalise
          const label = k.replace(/_/g, ' ').replace(/\(.*?\)/g, '').trim();
          noteParts.push(label + ': ' + v);
        }
      });
      const customNotes = noteParts.length ? noteParts.join(' | ') : null;

      console.log('Processing payment ID:', payment.id, '₹' + amountINR, 'from', payerName);

      // 2. Try to find page ID from multiple possible fields
      const pageId = payment.notes?.payment_page_id
        || payment.payment_page_id
        || payment.invoice_id
        || null;

      console.log('Payment page ID:', pageId);
      console.log('Payment notes:', JSON.stringify(payment.notes));
      console.log('Amount (INR):', amountINR);

      // ── IDEMPOTENCY CHECK ──
      // If this payment ID was already processed, skip entirely and return 200
      // so Razorpay stops retrying. This is the fix for duplicate participants.
      const isGeneral = pageId === GENERAL_PAYMENT_PAGE_ID;

      if (isGeneral) {
        const alreadyUnassigned = await isAlreadyUnassigned(payment.id);
        if (alreadyUnassigned) {
          console.log('Duplicate unassigned webhook — skipping:', payment.id);
          return res.json({ received: true, skipped: 'duplicate', payment_id: payment.id });
        }
      } else {
        const alreadyProcessed = await isAlreadyProcessed(payment.id);
        if (alreadyProcessed) {
          console.log('Duplicate workshop payment webhook — skipping:', payment.id);
          return res.json({ received: true, skipped: 'duplicate', payment_id: payment.id });
        }
      }

      // 3. Try to find matching workshop — first by page ID, then by date+amount
      let workshopId = null;
      let matchMethod = null;

      // 3a. Match by razorpay_page_id stored on workshop
      if (pageId && !isGeneral) {
        const { data: ws } = await supabase
          .from('workshops')
          .select('id')
          .eq('razorpay_page_id', pageId)
          .single();

        if (ws) {
          workshopId  = ws.id;
          matchMethod = 'page_id';
          console.log('Workshop matched by page ID:', workshopId);
        } else {
          console.warn('No workshop found for page ID:', pageId, '— trying date+amount fallback');
        }
      }

      // 3b. Fallback: match by date + amount if no page ID match
      if (!workshopId && !isGeneral) {
        const matched = await findWorkshopByDateAndAmount(amountINR, today);
        if (matched) {
          workshopId  = matched.id;
          matchMethod = 'date_amount';
          console.log(`Workshop matched by date+amount fallback: ${workshopId} (${matched.venue})`);
        }
      }

      // 4. Route to unassigned if general page OR no workshop match found
      const routeToUnassigned = isGeneral || !workshopId;

      if (routeToUnassigned) {
        console.log('Routing to unassigned payments:', payerName, '₹' + amountINR,
          isGeneral ? '(general page)' : '(no workshop match)');

        const unassignedId = await generateId('unassigned_payments', 'UP');
        const { error: upErr } = await supabase.from('unassigned_payments').insert({
          id: unassignedId,
          amount: amountINR,
          payer_name: payerName,
          payer_phone: payerPhone,
          payer_email: payerEmail,
          razorpay_payment_id: payment.id,
          razorpay_order_id: payment.order_id || null,
          date: today,
          status: 'pending',
          notes: `Auto-created from Razorpay payment ${payment.id}`
        });

        if (upErr) {
          console.error('Error saving unassigned payment:', upErr);
          return res.status(500).json({ error: 'Failed to save unassigned payment' });
        }

        console.log('Unassigned payment saved:', unassignedId, '₹' + amountINR, 'from', payerName);

        await supabase.from('notifications').insert({
          type: 'payment',
          message: `💸 New unassigned payment: ₹${amountINR} from ${payerName} — needs assignment`,
          read: false
        });

        return res.json({ received: true, routed: 'unassigned', id: unassignedId });
      }

      // 5. Workshop payment flow — create participant
      const participantId = await generateId('participants', 'P');
      const { error: pErr } = await supabase.from('participants').insert({
        id: participantId,
        full_name: payerName,
        razorpay_name: payerName,
        phone: payerPhone,
        email: payerEmail || null,
        workshop_id: workshopId,
        amount_paid: amountINR,
        payment_mode: paymentMode,
        booking_source: 'Razorpay UPI',
        checked_in: false,
        date: today,
        bringing_own_handpan: bringingOwn || null,
        photo_video_consent: photoOk || null,
        notes: `Auto-created via Razorpay webhook (matched by ${matchMethod}). Payment ID: ${payment.id}`
      });

      if (pErr) {
        console.error('Error creating participant:', pErr);
      } else {
        console.log('Participant created:', participantId, payerName);
      }

      // 6. Increment razorpay_pax and update workshop revenue
      const { data: ws } = await supabase
        .from('workshops')
        .select('razorpay_pax, total_pax, total_revenue, total_expense')
        .eq('id', workshopId)
        .single();

      if (ws) {
        const newRzpPax   = (ws.razorpay_pax   || 0) + 1;
        const newTotalPax = (ws.total_pax       || 0) + 1;
        const newRevenue  = (ws.total_revenue   || 0) + amountINR;
        const newProfit   = newRevenue - (ws.total_expense || 0);
        const newMargin   = newRevenue ? newProfit / newRevenue : 0;

        await supabase
          .from('workshops')
          .update({
            razorpay_pax:  newRzpPax,
            total_pax:     newTotalPax,
            total_revenue: newRevenue,
            net_profit:    newProfit,
            margin:        newMargin
          })
          .eq('id', workshopId);
      }

      // 7. Create payment record
      const paymentId = await generateId('payments', 'PAY');
      const { error: payErr } = await supabase.from('payments').insert({
        id: paymentId,
        razorpay_payment_id: payment.id,
        reference_id: workshopId,
        payer_name: payerName,
        amount: amountINR,
        payment_mode: paymentMode,
        type: 'income',
        category: 'workshop',
        synced_from_razorpay: true,
        date: today,
        description: `Workshop ${workshopId} — ${payerName}`
      });

      if (payErr) {
        console.error('Error saving payment:', payErr);
        return res.status(500).json({ error: 'Failed to save payment' });
      }

      console.log('Payment saved:', paymentId, '₹' + amountINR);

      await supabase.from('notifications').insert({
        type: 'payment',
        message: `✅ Workshop payment: ₹${amountINR} from ${payerName} → ${workshopId} (${matchMethod})`,
        read: false
      });

      return res.json({ received: true, routed: 'workshop', workshopId, participantId, paymentId });
    }

    // ── PAYMENT FAILED ──
    if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      const payerName = payment.notes?.name || payment.customer_name || 'Unknown';
      console.log('Payment failed:', payment.id, '₹' + payment.amount / 100);

      await supabase.from('notifications').insert({
        type: 'warning',
        message: `⚠️ Payment failed: ₹${payment.amount / 100} from ${payerName} — ID ${payment.id}`,
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
  console.log(`Health check: http://localhost:${PORT}/health`);
});
