// settlement-worker.js
// Turns foreign-currency class fees into real INR revenue entries.
//
// The problem: when someone pays in USD/EUR/etc., the webhook records the
// fee in fee_payments (in that currency) but can NOT add it to the Payments
// ledger, because the ledger is in rupees and the webhook doesn't carry the
// INR amount. Until now Arpit had to copy the settled amount from Razorpay's
// settlement report by hand — which, in practice, didn't happen, so Total
// Revenue under-counted every foreign payment.
//
// The fix: Razorpay's payment entity itself carries base_amount (the INR
// equivalent charged), fee and tax (both in INR paise). Net INR that reaches
// the bank = base_amount - fee - tax. This worker polls fee_payments where
// currency != INR and settled_inr is still null, asks Razorpay for those
// numbers, writes a Payments ledger row, fills settled_inr, and leaves an
// info notification. Runs every 6 hours; one failed row just waits for the
// next cycle, nothing retries in a tight loop.

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

const EVERY_MS = 6 * 60 * 60 * 1000; // 6 hours
const BOOT_DELAY_MS = 45 * 1000;     // let the server settle first

let supabase = null;
function init(client) { supabase = client; }

async function fetchRazorpayPayment(paymentId) {
  const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/payments/' + encodeURIComponent(paymentId), {
    headers: { 'Authorization': 'Basic ' + auth }
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data.error && data.error.description) || ('Razorpay HTTP ' + res.status));
  }
  return res.json();
}

let _running = false;
async function processUnsettled() {
  if (!supabase || !RZP_KEY_ID || !RZP_KEY_SECRET || _running) return;
  _running = true;
  try {
    const { data: rows, error } = await supabase.from('fee_payments')
      .select('id, student_id, student_name, month, classes, amount, currency, razorpay_payment_id, settled_inr')
      .neq('currency', 'INR')
      .is('settled_inr', null)
      .eq('paid', true)
      .not('razorpay_payment_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(10);
    if (error) { console.error('settlement query error:', error.message); return; }
    if (!rows || !rows.length) return;

    for (const fp of rows) {
      try {
        const p = await fetchRazorpayPayment(fp.razorpay_payment_id);
        if (p.status !== 'captured') { console.log('settlement: ' + fp.id + ' not captured yet (' + p.status + '), will re-check'); continue; }
        const baseAmount = Number(p.base_amount);   // INR paise
        const fee = Number(p.fee) || 0;             // INR paise, Razorpay's cut
        const tax = Number(p.tax) || 0;             // INR paise, GST on the fee
        if (!(baseAmount > 0)) { console.log('settlement: ' + fp.id + ' has no base_amount, will re-check'); continue; }
        const netInr = Math.round((baseAmount - fee - tax)) / 100;
        if (!(netInr > 0)) { console.log('settlement: ' + fp.id + ' net came out <= 0, skipping'); continue; }

        // Idempotency: if the ledger already has this razorpay payment
        // (added by hand, or by an earlier half-finished run), only fill
        // settled_inr and move on — never double-count revenue.
        const { data: dup } = await supabase.from('payments')
          .select('id').eq('razorpay_payment_id', fp.razorpay_payment_id).limit(1);
        if (!dup || !dup.length) {
          const { data: payNum } = await supabase.rpc('next_payment_number');
          const paymentId = payNum != null ? `PAY-${String(payNum).padStart(3, '0')}` : `PAY-${Date.now()}`;
          const { error: payErr } = await supabase.from('payments').insert({
            id: paymentId,
            razorpay_payment_id: fp.razorpay_payment_id,
            reference_id: fp.student_id,
            payer_name: fp.student_name,
            amount: netInr,
            payment_mode: 'Razorpay International',
            type: 'income',
            category: 'class',
            synced_from_razorpay: true,
            date: new Date().toISOString().slice(0, 10),
            description: `Fee settlement — ${fp.student_name} (${fp.id}) · ${fp.amount} ${fp.currency} → ₹${netInr} net of Razorpay fees`
          });
          if (payErr) { console.error('settlement ledger insert failed for ' + fp.id + ':', payErr.message); continue; }
        }

        const { error: updErr } = await supabase.from('fee_payments')
          .update({ settled_inr: netInr }).eq('id', fp.id);
        if (updErr) { console.error('settlement settled_inr update failed for ' + fp.id + ':', updErr.message); continue; }

        await supabase.from('notifications').insert({
          type: 'info',
          message: `💱 ₹${netInr.toLocaleString('en-IN')} added to revenue for ${fp.student_name}'s ${fp.amount} ${fp.currency} fee (${fp.id}), net of Razorpay fees.`,
          read: false
        });
        console.log('settlement: ' + fp.id + ' → ₹' + netInr);
      } catch (e) {
        console.error('settlement failed for ' + fp.id + ':', e.message);
      }
    }
  } catch (e) {
    console.error('settlement worker error:', e.message);
  } finally { _running = false; }
}

function startWorker() {
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) { console.log('Settlement worker idle: Razorpay keys not set'); return; }
  console.log('Settlement worker on: every 6 h, foreign fees → INR ledger');
  setTimeout(processUnsettled, BOOT_DELAY_MS);
  setInterval(processUnsettled, EVERY_MS);
}

module.exports = { init, startWorker, processUnsettled };
