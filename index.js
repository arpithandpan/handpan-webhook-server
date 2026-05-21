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

// ── RAZORPAY WEBHOOK ──
// Must use raw body for signature verification
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Verify webhook signature
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

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;

      // Get payment page ID to find workshop
      const paymentPageId = payment.payment_page_id || 
                            payment.notes?.payment_page_id ||
                            null;

      let workshopId = null;

      // Look up workshop by razorpay_page_id
      if (paymentPageId) {
        const { data: workshops } = await supabase
          .from('workshops')
          .select('id')
          .eq('razorpay_page_id', paymentPageId)
          .single();

        if (workshops) {
          workshopId = workshops.id;
        } else {
          console.warn('No workshop found for payment_page_id:', paymentPageId);
        }
      }

      // Generate sequential payment ID
      const { data: lastPayment } = await supabase
        .from('payments')
        .select('id')
        .like('id', 'PAY-%')
        .order('id', { ascending: false })
        .limit(1);

      let newId = 'PAY-001';
      if (lastPayment && lastPayment.length > 0) {
        const lastNum = parseInt(lastPayment[0].id.replace('PAY-', ''));
        newId = 'PAY-' + String(lastNum + 1).padStart(3, '0');
      }

      // Save payment to Supabase
      const { error } = await supabase.from('payments').insert({
        id: newId,
        razorpay_payment_id: payment.id,
        reference_id: workshopId,
        payer_name: payment.customer_name || payment.notes?.name || 'Unknown',
        email: payment.email,
        contact: payment.contact,
        amount: payment.amount / 100, // Razorpay sends paise
        payment_mode: (payment.method || 'razorpay').toLowerCase(),
        type: 'income',
        category: 'workshop',
        synced_from_razorpay: true,
        date: new Date().toISOString().split('T')[0],
        raw: payment
      });

      if (error) {
        console.error('Error saving payment:', error);
        return res.status(500).json({ error: 'Failed to save payment' });
      }

      console.log('Payment saved:', newId, '₹' + payment.amount / 100);
    }

    if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      console.log('Payment failed:', payment.id, '₹' + payment.amount / 100);
      // Log failed payment but don't save to payments table
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
