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

      // 2. Find workshop by payment page ID
      const pageId = payment.notes?.payment_page_id || payment.payment_page_id || null;
      let workshopId = null;

      if (pageId) {
        const { data: ws } = await supabase
          .from('workshops')
          .select('id')
          .eq('razorpay_page_id', pageId)
          .single();
        if (ws) workshopId = ws.id;
        else console.warn('No workshop found for page ID:', pageId);
      }

      // 3. Create participant record
      const participantId = await generateId('participants', 'P');
      const { error: pErr } = await supabase.from('participants').insert({
        id: participantId,
        full_name: payerName,
        phone: payerPhone,
        email: payerEmail,
        workshop_id: workshopId,
        amount_paid: amountINR,
        payment_mode: paymentMode,
        booking_source: 'Razorpay UPI',
        checked_in: false,
        date: today,
        notes: `Auto-created from Razorpay payment ${payment.id}`
      });

      if (pErr) {
        console.error('Error creating participant:', pErr);
      } else {
        console.log('Participant created:', participantId, payerName);
      }

      // 4. Increment razorpay_pax on the workshop
      if (workshopId) {
        const { data: ws } = await supabase
          .from('workshops')
          .select('razorpay_pax, total_pax')
          .eq('id', workshopId)
          .single();

        if (ws) {
          await supabase
            .from('workshops')
            .update({
              razorpay_pax: (ws.razorpay_pax || 0) + 1,
              total_pax: (ws.total_pax || 0) + 1
            })
            .eq('id', workshopId);
        }
      }

      // 5. Create payment record
      const paymentId = await generateId('payments', 'PAY');
      const { error: payErr } = await supabase.from('payments').insert({
        id: paymentId,
        razorpay_payment_id: payment.id,
        reference_id: workshopId,
        payer_name: payerName,
        email: payerEmail,
        contact: payerPhone,
        amount: amountINR,
        payment_mode: paymentMode,
        type: 'income',
        category: 'workshop',
        synced_from_razorpay: true,
        date: today,
        description: workshopId ? `Workshop ${workshopId} — ${payerName}` : `Razorpay payment — ${payerName}`,
        raw: payment
      });

      if (payErr) {
        console.error('Error saving payment:', payErr);
        return res.status(500).json({ error: 'Failed to save payment' });
      }

      console.log('Payment saved:', paymentId, '₹' + amountINR);

      // 6. Send notification
      await supabase.from('notifications').insert({
        type: 'payment',
        message: `💰 New payment: ₹${amountINR} from ${payerName}${workshopId ? ' (' + workshopId + ')' : ''} — ${paymentId}`,
        read: false
      });
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
