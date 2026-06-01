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

      // 2. Try to find page ID from multiple possible fields
      const pageId = payment.notes?.payment_page_id 
        || payment.payment_page_id 
        || payment.invoice_id  // Payment Pages sometimes use invoice_id
        || null;

      console.log('Payment page ID:', pageId);
      console.log('Payment notes:', JSON.stringify(payment.notes));
      console.log('Payment description:', payment.description);

      // 3. Try to find a matching workshop
      let workshopId = null;

      if (pageId && pageId !== GENERAL_PAYMENT_PAGE_ID) {
        const { data: ws } = await supabase
          .from('workshops')
          .select('id')
          .eq('razorpay_page_id', pageId)
          .single();
        if (ws) workshopId = ws.id;
        else console.warn('No workshop found for page ID:', pageId);
      }

      // 4. If page ID is the general page OR no workshop found → save as unassigned
      const isGeneral = pageId === GENERAL_PAYMENT_PAGE_ID || (!workshopId && !pageId) || (!workshopId && pageId);

      if (isGeneral) {
        console.log('Routing to unassigned payments:', payerName, '₹' + amountINR);

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
          message: `💰 New unassigned payment: ₹${amountINR} from ${payerName} — needs assignment`,
          read: false
        });

        return res.json({ received: true });
      }

      // 5. Workshop payment flow
      const participantId = await generateId('participants', 'P');
      const { error: pErr } = await supabase.from('participants').insert({
        id: participantId,
        full_name: payerName,
        phone: payerPhone,
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

      // 6. Increment razorpay_pax on the workshop
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
        description: workshopId ? `Workshop ${workshopId} — ${payerName}` : `Razorpay payment — ${payerName}`
      });

      if (payErr) {
        console.error('Error saving payment:', payErr);
        return res.status(500).json({ error: 'Failed to save payment' });
      }

      console.log('Payment saved:', paymentId, '₹' + amountINR);

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
