// invoice-service.js
// Runs inside the Railway webhook server after a Razorpay payment has been
// saved. Creates the invoice row, renders the PDF, stores it, emails it, and
// records the outcome. Never throws out to the webhook: every failure turns
// into a dashboard notification so the booking itself is never at risk.

const { buildInvoicePdf, amountInWords, BIZ } = require('./invoice-pdf');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.INVOICE_FROM_EMAIL || 'invoices@arpitpandey.com';
const REPLY_TO = process.env.INVOICE_REPLY_TO || BIZ.email;
const BUCKET = 'invoices';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthLabel(iso) {
  const d = new Date(String(iso || '').slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return '';
  return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}
// Server runs in UTC. Invoice and payment dates should be India's date.
function todayIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function fmtNo(n) { return 'INV-' + String(n).padStart(3, '0'); }
function slug(s) { return (s || 'invoice').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'invoice'; }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function notify(supabase, type, message) {
  try { await supabase.from('notifications').insert({ type, message, read: false }); }
  catch (e) { console.error('notify failed:', e.message); }
}

// ── email copy ──
function emailText(no) {
  return 'Hi,\n\nPlease find attached your invoice ' + no + '.\n\nThank you for being part of the journey.\n\nWarm regards,\nArpit Pandey\nhttps://arpitpandey.com/\nhttps://www.instagram.com/pandeyarpit';
}
function emailHtml(no) {
  return '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">'
    + '<p>Hi,</p>'
    + '<p>Please find attached your invoice <strong>' + esc(no) + '</strong>.</p>'
    + '<p>Thank you for being part of the journey.</p>'
    + '<p>Warm regards,<br>Arpit Pandey<br>'
    + '<a href="https://arpitpandey.com/" style="color:#500018;">arpitpandey.com</a> · '
    + '<a href="https://www.instagram.com/pandeyarpit" style="color:#500018;">@pandeyarpit</a></p>'
    + '</div>';
}

async function sendViaResend({ to, cc, subject, text, html, filename, pdfBuffer }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const ccList = (Array.isArray(cc) ? cc : (cc ? [cc] : [])).filter(a => a && a.toLowerCase() !== String(to).toLowerCase());
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: BIZ.name + ' <' + FROM_EMAIL + '>',
      to: [to],
      ...(ccList.length ? { cc: ccList } : {}),
      reply_to: REPLY_TO,
      subject,
      text,
      html,
      attachments: [{ filename, content: pdfBuffer.toString('base64') }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || ('Resend HTTP ' + res.status));
  return data.id || null;
}

// ── Shared helpers used by both the webhook flow and the dashboard endpoints ──

// Map an invoices table row to what buildInvoicePdf expects.
function invoiceFromRow(r) {
  const lines = (r.line_items || []).map(l => ({ desc: l.desc || l.description || '', sub: l.sub || '', qty: Number(l.qty) || 1, rate: Number(l.rate) || 0 }));
  const status = r.cancelled ? 'cancelled' : (r.payment_received_date ? 'paid' : 'due');
  return {
    number: fmtNo(r.invoice_number),
    date: r.invoice_date,
    status,
    dueDate: r.due_date || undefined,
    cancelledAt: r.cancelled_at ? String(r.cancelled_at).slice(0, 10) : '',
    currency: (r.currency || 'INR').toUpperCase(),
    billed: {
      name: r.billed_name || '', company: r.billed_company || '', address: r.billed_address || r.billed_city || '',
      state: r.billed_state || '', country: r.billed_country || '', email: r.billed_email || '', phone: r.billed_phone || '',
      gstin: r.billed_gstin || ''
    },
    servicePeriod: r.service_period || '',
    payment: { date: r.payment_received_date || '', mode: r.payment_mode || '', ref: r.payment_reference || '' },
    amountPaid: Number(r.amount_paid) || 0,
    lines,
    notes: r.notes || '',
    showPan: !!r.show_pan || !!r.pan, showBank: !!r.show_bank, showAddress: !!r.show_address
  };
}
function pdfFilename(r) { return fmtNo(r.invoice_number) + '_' + slug(r.billed_name) + '.pdf'; }
function pdfStoragePath(r) { return String(r.invoice_date || todayIST()).slice(0, 4) + '/' + pdfFilename(r); }

// Render the PDF for a row and store it. Returns { pdf, path }.
async function renderAndStore(supabase, row) {
  const pdf = await buildInvoicePdf(invoiceFromRow(row));
  const path = pdfStoragePath(row);
  const { error } = await supabase.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true });
  if (error) throw new Error('Storage upload failed: ' + error.message);
  await supabase.from('invoices').update({ pdf_path: path }).eq('id', row.id);
  return { pdf, path };
}

// Fetch the stored PDF for a row, or render (and store) it if missing.
async function getPdf(supabase, row) {
  if (row.pdf_path) {
    const { data, error } = await supabase.storage.from(BUCKET).download(row.pdf_path);
    if (!error && data) return { pdf: Buffer.from(await data.arrayBuffer()), path: row.pdf_path };
  }
  return renderAndStore(supabase, row);
}

// Email a row's PDF. Returns the address it went to. Throws on failure.
async function emailInvoice(supabase, row, pdf, to) {
  const addr = (to || row.billed_email || '').trim();
  if (!addr) throw new Error('No email address on this invoice');
  const no = fmtNo(row.invoice_number);
  await sendViaResend({ to: addr, subject: 'Your invoice from Arpit Pandey (' + no + ')', text: emailText(no), html: emailHtml(no), filename: pdfFilename(row), pdfBuffer: pdf });
  await supabase.from('invoices').update({ sent: true, sent_at: new Date().toISOString(), email_sent_to: addr, email_error: null }).eq('id', row.id);
  return addr;
}

/**
 * Create, store and email one invoice.
 *
 * job = {
 *   sourceTable: 'participants' | 'fee_payments',
 *   sourceId: 'P-042' | 'FP-031',
 *   razorpayPaymentId: 'pay_xxx',
 *   billed: { name, email, phone, country },
 *   currency: 'INR',
 *   paymentDate: 'YYYY-MM-DD',
 *   paymentMode: 'Razorpay UPI',
 *   servicePeriod: 'September 2026' | null   (workshops only; class fees carry none)
 *   lines: [{ desc, qty, rate }]
 * }
 */
async function createAndSendInvoice(supabase, job) {
  const tag = job.razorpayPaymentId || job.sourceId;
  try {
    // 0. Already invoiced? A replayed webhook should never make a second one.
    const { data: existing } = await supabase
      .from('invoices').select('id, invoice_number')
      .eq('payment_reference', job.razorpayPaymentId).eq('auto_generated', true).limit(1);
    if (existing && existing.length) {
      console.log('Invoice already exists for', tag, fmtNo(existing[0].invoice_number));
      return { skipped: 'exists', invoiceNumber: existing[0].invoice_number };
    }

    const today = todayIST();
    const currency = (job.currency || 'INR').toUpperCase();
    const lines = (job.lines || []).map(l => ({ desc: l.desc, qty: Number(l.qty) || 1, rate: Number(l.rate) || 0 }));
    const total = Math.round(lines.reduce((a, l) => a + l.qty * l.rate, 0) * 100) / 100;
    const words = amountInWords(total, currency);

    const row = {
      invoice_number: null,
      invoice_date: today,
      source_table: job.sourceTable || null,
      source_id: job.sourceId || null,
      billed_name: job.billed.name || 'Customer',
      billed_email: job.billed.email || null,
      billed_phone: job.billed.phone || null,
      billed_city: null,
      payment_received_date: job.paymentDate || today,
      payment_mode: job.paymentMode || 'Razorpay UPI',
      payment_reference: job.razorpayPaymentId || null,
      line_items: lines,
      total_amount: total,
      amount_in_words: words,
      currency,
      service_period: job.servicePeriod || null,
      auto_generated: true,
      sent: false
    };

    // 1 + 2. Reserve a number from the shared atomic counter and insert.
    // If the number is already taken (counter drifted behind the table),
    // take the next one and try again, a few times. A duplicate on
    // payment_reference means another webhook delivery beat us: skip.
    let invoiceId = null, invoiceNumber = null, no = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const { data: num, error: numErr } = await supabase.rpc('next_invoice_number');
      invoiceNumber = Number(Array.isArray(num) ? num[0] : num);
      if (numErr || !(invoiceNumber > 0)) throw new Error('Could not reserve invoice number: ' + (numErr?.message || 'empty'));
      no = fmtNo(invoiceNumber);
      row.invoice_number = invoiceNumber;

      const { data: inserted, error: insErr } = await supabase.from('invoices').insert(row).select('id').single();
      if (!insErr) { invoiceId = inserted.id; break; }

      const msg = (insErr.message || '') + ' ' + (insErr.details || '');
      if (insErr.code === '23505' && /payment_reference/.test(msg)) {
        console.log('Invoice already created by another delivery for', tag);
        return { skipped: 'exists' };
      }
      if (insErr.code === '23505' && /invoice_number/.test(msg)) {
        console.warn('Invoice number', no, 'already taken, retrying (attempt ' + attempt + ')');
        continue;
      }
      throw new Error('Insert failed: ' + insErr.message + (insErr.details ? ' (' + insErr.details + ')' : ''));
    }
    if (!invoiceId) throw new Error('Could not find a free invoice number after 5 attempts');

    // 3. PDF.
    const pdf = await buildInvoicePdf({
      number: no,
      date: today,
      status: 'paid',
      currency,
      billed: { name: row.billed_name, email: row.billed_email, phone: row.billed_phone, country: job.billed.country || '' },
      servicePeriod: row.service_period || '',
      payment: { date: row.payment_received_date, mode: row.payment_mode, ref: row.payment_reference },
      lines
    });
    const filename = no + '_' + slug(row.billed_name) + '.pdf';

    // 4. Store it. A storage failure is logged but does not stop the email.
    let pdfPath = null;
    try {
      const path = today.slice(0, 4) + '/' + filename;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
      pdfPath = path;
      await supabase.from('invoices').update({ pdf_path: pdfPath }).eq('id', invoiceId);
    } catch (e) {
      console.error('Invoice PDF upload failed:', e.message);
      await notify(supabase, 'warning', `⚠️ Invoice ${no} created but the PDF could not be stored: ${e.message}`);
    }

    // 5. Email, if we have an address.
    if (!row.billed_email) {
      await notify(supabase, 'info', `🧾 Invoice ${no} created for ${row.billed_name} but no email on the booking. Send it from the dashboard.`);
      return { invoiceId, invoiceNumber, emailed: false };
    }

    try {
      const cc = (job.cc || []).filter(a => a && a.toLowerCase() !== String(row.billed_email).toLowerCase());
      await sendViaResend({
        to: row.billed_email,
        cc,
        subject: 'Your invoice from Arpit Pandey (' + no + ')',
        text: emailText(no),
        html: emailHtml(no),
        filename,
        pdfBuffer: pdf
      });
      const sentTo = [row.billed_email].concat(cc).join(', ');
      await supabase.from('invoices').update({ sent: true, sent_at: new Date().toISOString(), email_sent_to: sentTo, email_error: null }).eq('id', invoiceId);
      await notify(supabase, 'info', `🧾 Invoice ${no} sent to ${sentTo} (${row.billed_name})`);
      return { invoiceId, invoiceNumber, emailed: true };
    } catch (e) {
      console.error('Invoice email failed:', e.message);
      await supabase.from('invoices').update({ sent: false, email_error: e.message }).eq('id', invoiceId);
      await notify(supabase, 'warning', `⚠️ Invoice ${no} created but the email to ${row.billed_email} failed: ${e.message}. Use Resend in the dashboard.`);
      return { invoiceId, invoiceNumber, emailed: false, error: e.message };
    }
  } catch (e) {
    console.error('createAndSendInvoice error:', e.message);
    await notify(supabase, 'warning', `⚠️ Auto invoice failed for ${job.billed?.name || 'customer'} (${tag}): ${e.message}. Create it from the dashboard.`);
    return { error: e.message };
  }
}

// ── Job builders, called from server.js ──

// Workshop booking: one invoice to the lead for the whole group.
async function invoiceWorkshopBooking(supabase, { workshopId, fields, payment, participantIds, today }) {
  const { data: ws } = await supabase.from('workshops').select('date, price_per_head, observer_price').eq('id', workshopId).single();
  const pCount = fields.participantCount ?? 1;
  const oCount = fields.observerCount ?? 0;
  const pPrice = fields.participantPrice != null ? fields.participantPrice : Number(ws?.price_per_head) || 0;
  const oPrice = Number(ws?.observer_price) || 0;
  const period = monthLabel(ws?.date) || monthLabel(todayIST());

  const lines = [];
  if (pCount > 0) lines.push({ desc: 'Handpan Workshop, ' + period, qty: pCount, rate: pPrice });
  if (oCount > 0 && oPrice > 0) lines.push({ desc: 'Audience pass', qty: oCount, rate: oPrice });

  // Old-flow payments have no per-head price; fall back to one line at the paid amount.
  const lineTotal = lines.reduce((a, l) => a + l.qty * l.rate, 0);
  if (!lines.length || Math.abs(lineTotal - fields.amount) > 1) {
    lines.length = 0;
    lines.push({ desc: 'Handpan Workshop, ' + period, qty: 1, rate: fields.amount });
  }

  return createAndSendInvoice(supabase, {
    sourceTable: 'participants',
    sourceId: participantIds[0],
    razorpayPaymentId: payment.id,
    billed: { name: fields.name, email: fields.email, phone: fields.phone },
    currency: 'INR',
    paymentDate: todayIST(),
    paymentMode: 'Razorpay UPI',
    servicePeriod: period,
    lines
  });
}

// Class fee from pay.html, INR or foreign currency.
// No service period on these: classes can be rescheduled and stretch past a
// month, so the invoice states only what was bought (the class count). The
// month chosen on the fee request still lives in fee_requests / fee_payments
// for Arpit's own records; it is not shown to the student anywhere.
async function invoiceFeePayment(supabase, { feeId, studentName, student, classes, amountMajor, currency, payment, today, feeMonth, payerEmail, payerPhone }) {
  // Show qty = classes only when the per-class rate divides cleanly, so the
  // invoice total always equals exactly what was paid. Otherwise one line at
  // the full amount with the class count in the description.
  const qty = classes > 0 ? classes : 1;
  const rate = Math.round((amountMajor / qty) * 100) / 100;
  const clean = Math.round(rate * qty * 100) === Math.round(amountMajor * 100);
  const lines = clean
    ? [{ desc: 'Online Handpan Classes', qty, rate }]
    : [{ desc: 'Online Handpan Classes' + (classes > 0 ? ' (' + classes + ' classes)' : ''), qty: 1, rate: amountMajor }];

  return createAndSendInvoice(supabase, {
    sourceTable: 'fee_payments',
    sourceId: feeId,
    razorpayPaymentId: payment.id,
    // The address typed at payment time wins (it may be a parent paying). The
    // student's address on file is copied in, so nothing is lost either way.
    billed: { name: studentName, email: payerEmail || payment.notes?.email || student?.email || null, phone: payerPhone || payment.notes?.phone || student?.phone || payment.contact || null, country: student?.country || '' },
    cc: student?.email ? [student.email] : [],
    currency,
    paymentDate: todayIST(),
    paymentMode: currency === 'INR' ? 'Razorpay UPI' : 'Razorpay International',
    servicePeriod: null,
    lines
  });
}

module.exports = { createAndSendInvoice, invoiceWorkshopBooking, invoiceFeePayment, invoiceFromRow, renderAndStore, getPdf, emailInvoice, pdfFilename, buildInvoicePdf };
