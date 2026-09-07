// invoice-pdf.js
// The one invoice renderer for Arpit Pandey. Used by the Railway webhook
// server for auto invoices and (later) by the dashboard for manual ones.
// Real text PDF via pdfkit. Fonts live in ./fonts next to this file.
//
// Handles every case with one template:
//   status      paid | due | cancelled (plus partially paid within 'due')
//   currency    INR or any foreign currency in CURRENCY
//   customer    student (name, email, phone) or company (address, GSTIN)
//   tax         no GST today; flip BIZ.gst.registered and it becomes a
//               compliant tax invoice with CGST/SGST or IGST, or zero-rated export
//
// The BIZ block is the only thing that should ever need editing.

const PDFDocument = require('pdfkit');
const path = require('path');

const FONTS = {
  R: path.join(__dirname, 'fonts', 'Figtree-Regular.ttf'),
  M: path.join(__dirname, 'fonts', 'Figtree-Medium.ttf'),
  B: path.join(__dirname, 'fonts', 'Figtree-Bold.ttf'),
  XB: path.join(__dirname, 'fonts', 'Figtree-ExtraBold.ttf'),
};

// ── Identity. Locked 07 Sep 2026. ──
const BIZ = {
  name: 'Arpit Pandey',
  role: 'Handpan Artist & Educator',
  city: 'Bengaluru, Karnataka, India',
  fullAddress: '',                       // optional, only printed when inv.showAddress is true
  email: 'arpithandpan@gmail.com',
  phone: '+91 90195 76583',
  website: 'arpitpandey.com',
  pan: 'AYLPP5050A',                     // only printed when inv.showPan is true
  state: 'Karnataka',
  stateCode: '29',
  bank: { name: 'HDFC Bank', acName: 'Arpit Pandey', acNo: '50100873491552', ifsc: 'HDFC0000278', upi: 'arpitbam-1@okhdfcbank' },
  gst: {
    registered: false,                   // flip to true after registering
    gstin: '',                           // e.g. 29AYLPP5050A1Z5
    rate: 18,                            // percent, applied when registered
    sac: '999293',                       // SAC for commercial training and coaching services
  },
  dueDays: 14,                           // default payment terms for unpaid invoices
};

const CURRENCY = {
  INR: { sym: '\u20B9', word: 'Rupees', minor: 'Paise', locale: 'en-IN' },
  USD: { sym: '$', word: 'US Dollars', minor: 'Cents', locale: 'en-US' },
  EUR: { sym: '\u20AC', word: 'Euros', minor: 'Cents', locale: 'en-IE' },
  GBP: { sym: '\u00A3', word: 'Pounds', minor: 'Pence', locale: 'en-GB' },
  AUD: { sym: 'A$', word: 'Australian Dollars', minor: 'Cents', locale: 'en-AU' },
  CAD: { sym: 'C$', word: 'Canadian Dollars', minor: 'Cents', locale: 'en-CA' },
  SGD: { sym: 'S$', word: 'Singapore Dollars', minor: 'Cents', locale: 'en-SG' },
  AED: { sym: 'AED ', word: 'Dirhams', minor: 'Fils', locale: 'en-AE' },
};

const TNUM = ['tnum'];   // tabular numerals so digits line up in columns
const T = { ink: '#1a1a1a', accent: '#111111', accentInk: '#ffffff', rule: '#1a1a1a', muted: '#666666', band: '#f5f5f5', box: '#f4f4f4', faint: '#888888' };

// ── helpers ──
function longDate(iso) {
  if (!iso) return '';
  const dt = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(dt)) return String(iso);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}
function addDays(iso, n) {
  const dt = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(dt)) return '';
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
}
function money(n, cur) {
  const c = CURRENCY[cur] || CURRENCY.INR;
  const v = Number(n || 0);
  const hasMinor = Math.round(v * 100) % 100 !== 0;
  const min = cur && cur !== 'INR' ? 2 : (hasMinor ? 2 : 0);
  return v.toLocaleString(c.locale, { minimumFractionDigits: min, maximumFractionDigits: 2 });
}
function sym(cur) { return (CURRENCY[cur] || CURRENCY.INR).sym.trim(); }
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = n => n < 20 ? ONES[n] : (TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
const three = n => (Math.floor(n / 100) ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? two(n % 100) : '');
function wordsIndian(num) {
  if (num === 0) return 'Zero';
  let out = '';
  const crore = Math.floor(num / 1e7); num %= 1e7;
  const lakh = Math.floor(num / 1e5); num %= 1e5;
  const thou = Math.floor(num / 1e3); num %= 1e3;
  if (crore) out += three(crore) + ' Crore ';
  if (lakh) out += two(lakh) + ' Lakh ';
  if (thou) out += two(thou) + ' Thousand ';
  if (num) out += three(num);
  return out.trim();
}
function wordsIntl(num) {
  if (num === 0) return 'Zero';
  const parts = [], scales = ['', ' Thousand', ' Million', ' Billion'];
  let i = 0;
  while (num > 0) { const chunk = num % 1000; if (chunk) parts.unshift(three(chunk) + scales[i]); num = Math.floor(num / 1000); i++; }
  return parts.join(' ').trim();
}
function amountInWords(n, cur) {
  const c = CURRENCY[cur] || CURRENCY.INR;
  const whole = Math.floor(Number(n) || 0);
  const minor = Math.round(((Number(n) || 0) - whole) * 100);
  const fn = !cur || cur === 'INR' ? wordsIndian : wordsIntl;
  let s = c.word + ' ' + fn(whole);
  if (minor) s += ' and ' + fn(minor) + ' ' + c.minor;
  return s + ' Only';
}
function oblique(doc, text, x, y, opts) {
  // pdfkit's y axis runs downward, so a negative skew leans the tops of letters to the right like a true italic.
  doc.save(); const k = -0.16; doc.transform(1, 0, k, 1, -k * y, 0); doc.text(text, x, y, opts); doc.restore();
}
function drawCheck(doc, x, y, s, color) {
  doc.save().lineWidth(s * 0.18).strokeColor(color).lineCap('round').lineJoin('round')
    .moveTo(x, y + s * 0.55).lineTo(x + s * 0.38, y + s * 0.9).lineTo(x + s, y + s * 0.15).stroke().restore();
}
function drawCross(doc, x, y, s, color) {
  doc.save().lineWidth(s * 0.18).strokeColor(color).lineCap('round')
    .moveTo(x + s * 0.1, y + s * 0.1).lineTo(x + s * 0.9, y + s * 0.9)
    .moveTo(x + s * 0.9, y + s * 0.1).lineTo(x + s * 0.1, y + s * 0.9).stroke().restore();
}
function drawClock(doc, x, y, s, color) {
  doc.save().lineWidth(s * 0.16).strokeColor(color).lineCap('round')
    .circle(x + s / 2, y + s / 2, s * 0.44).stroke()
    .moveTo(x + s / 2, y + s * 0.25).lineTo(x + s / 2, y + s / 2).lineTo(x + s * 0.72, y + s * 0.62).stroke().restore();
}
function drawHalf(doc, x, y, s, color) {
  doc.save().lineWidth(s * 0.16).strokeColor(color).fillColor(color)
    .circle(x + s / 2, y + s / 2, s * 0.44).stroke()
    .path(`M ${x + s / 2} ${y + s * 0.06} A ${s * 0.44} ${s * 0.44} 0 0 1 ${x + s / 2} ${y + s * 0.94} Z`).fill().restore();
}

// ── tax computation ──
// Returns { subtotal, taxable, lines:[{label, amount}], total, taxNote }
function computeTotals(inv, subtotal) {
  const cur = inv.currency || 'INR';
  const isExport = cur !== 'INR' || (inv.billed.country && !/india/i.test(inv.billed.country));
  const out = { subtotal, taxLines: [], total: subtotal, taxNote: '' };
  if (!BIZ.gst.registered) {
    // Only businesses care about this line. Students get a clean invoice.
    const business = !!(inv.billed.company || inv.billed.gstin || inv.showPan);
    out.taxNote = business ? 'No GST charged. Supplier is not registered under GST.' : '';
    return out;
  }
  if (isExport) {
    out.taxLines.push({ label: 'IGST @ 0% (export of services)', amount: 0 });
    out.taxNote = 'Zero-rated export of services under LUT.';
    return out;
  }
  const rate = Number(inv.taxRate != null ? inv.taxRate : BIZ.gst.rate) || 0;
  const billedState = (inv.billed.state || BIZ.state).trim().toLowerCase();
  const intra = billedState === BIZ.state.toLowerCase();
  const tax = Math.round(subtotal * rate) / 100;
  if (intra) {
    const half = Math.round(tax * 50) / 100;
    out.taxLines.push({ label: 'CGST @ ' + rate / 2 + '%', amount: half });
    out.taxLines.push({ label: 'SGST @ ' + rate / 2 + '%', amount: half });
  } else {
    out.taxLines.push({ label: 'IGST @ ' + rate + '%', amount: tax });
  }
  out.total = Math.round((subtotal + tax) * 100) / 100;
  return out;
}

/**
 * inv = {
 *   number: 'INV-042', date: 'YYYY-MM-DD',
 *   status: 'paid' | 'due' | 'cancelled',   (defaults: paid if payment.date, else due)
 *   dueDate: 'YYYY-MM-DD',                   (defaults to date + BIZ.dueDays when due)
 *   cancelledAt: 'YYYY-MM-DD',
 *   currency: 'INR',
 *   billed: { name, company, address, state, country, email, phone, gstin },
 *   servicePeriod: 'September 2026',
 *   payment: { date, mode, ref },
 *   amountPaid: 0,                           (for partial payments on a due invoice)
 *   lines: [{ desc, sub, qty, rate, sac }],
 *   notes: '',
 *   showBank: false,  showPan: false,  showAddress: false,
 *   taxRate: undefined                        (override BIZ.gst.rate per invoice)
 * }
 * Resolves to a Buffer.
 */
function buildInvoicePdf(inv) {
  return new Promise((resolve, reject) => {
    const cur = inv.currency || 'INR';
    const C = CURRENCY[cur] || CURRENCY.INR;
    const isExport = cur !== 'INR';
    const status = inv.cancelled ? 'cancelled' : (inv.status || (inv.payment && inv.payment.date ? 'paid' : 'due'));
    const dueDate = status === 'due' ? (inv.dueDate || addDays(inv.date, BIZ.dueDays)) : '';
    const gstOn = BIZ.gst.registered;
    const docTitle = gstOn ? (isExport ? 'EXPORT INVOICE' : 'TAX INVOICE') : 'INVOICE';

    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: inv.number + (inv.billed.name ? ' ' + inv.billed.name : ''), Author: BIZ.name } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    Object.entries(FONTS).forEach(([k, p]) => doc.registerFont(k, p));

    const PW = doc.page.width, PH = doc.page.height;
    const MX = 16 * 2.8346, MY = 18 * 2.8346;
    const L = MX, R = PW - MX, W = R - L;
    const BOTTOM = PH - MY;
    let page = 1;

    // Drawn last on each page so it sits over the black bars, not under them.
    const watermark = () => {
      if (status !== 'cancelled') return;
      doc.save().opacity(0.08).fillColor('#b4452c').font('XB').fontSize(88);
      const txt = 'CANCELLED', cs = 8;
      const tw = doc.widthOfString(txt, { characterSpacing: cs });
      doc.rotate(-26, { origin: [PW / 2, PH / 2] })
        .text(txt, (PW - tw) / 2, PH / 2 - 56, { lineBreak: false, characterSpacing: cs });
      doc.restore();
    };
    const footerLine = () => {
      doc.font('R').fontSize(8.5).fillColor('#999999')
        .text(BIZ.name + '  ·  ' + inv.number + '  ·  Page ' + page, L, BOTTOM + 14, { width: W, align: 'center' });
    };
    const finishPage = () => { footerLine(); watermark(); };
    const newPage = () => { finishPage(); doc.addPage(); page++; return MY; };

    // ── header ──
    let y = MY;
    doc.font('B').fontSize(22).fillColor(T.ink).text(BIZ.name, L, y, { characterSpacing: -0.2 });
    doc.font('R').fontSize(10.5).fillColor(T.muted);
    const hdr = [BIZ.role, (inv.showAddress && BIZ.fullAddress) ? BIZ.fullAddress : BIZ.city, BIZ.email + '  ·  ' + BIZ.phone];
    if (gstOn && BIZ.gst.gstin) hdr.push('GSTIN: ' + BIZ.gst.gstin);
    if (inv.showPan || gstOn) hdr.push('PAN: ' + BIZ.pan);
    hdr.forEach((t, i) => doc.text(t, L, y + 33 + i * 15.5, { width: W * 0.55 }));

    doc.font('B').fontSize(22).fillColor(T.accent).text(docTitle, L, y, { width: W, align: 'right', characterSpacing: 0.6 });
    const meta = [['No', inv.number], ['Date', longDate(inv.date)]];
    if (status === 'due' && dueDate) meta.push(['Due', longDate(dueDate)]);
    if (inv.servicePeriod) meta.push(['Period', inv.servicePeriod]);
    doc.fontSize(10.5);
    let valW = 0; meta.forEach(m => { doc.font('B'); valW = Math.max(valW, doc.widthOfString(m[1])); });
    valW = Math.ceil(valW) + 4;   // a little slack so the widest value never wraps
    const valX = R - valW;
    meta.forEach((m, i) => {
      doc.font('R').fillColor(T.muted).text(m[0], valX - 60, y + 33 + i * 15.5, { width: 54, align: 'right' });
      doc.font('B').fillColor(T.ink).text(m[1], valX, y + 33 + i * 15.5, { width: valW });
    });
    y = MY + 33 + Math.max(hdr.length, meta.length) * 15.5 + 12;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(1.1).strokeColor(T.rule).stroke();
    y += 16;

    // ── BILLED TO (left) + PAYMENT / PAY TO (right) ──
    doc.font('B').fontSize(8.5).fillColor(T.muted).text('BILLED TO', L, y, { characterSpacing: 0.6 });
    let ly = y + 14;
    doc.font('B').fontSize(12).fillColor(T.ink).text(inv.billed.name || '', L, ly, { width: W * 0.55 }); ly += 18;
    doc.font('R').fontSize(10.5).fillColor(T.ink);
    const bl = [];
    if (inv.billed.company) bl.push(inv.billed.company);
    if (inv.billed.address) bl.push(inv.billed.address);
    if (inv.billed.state && gstOn && !isExport) bl.push(inv.billed.state);
    if (inv.billed.country && isExport) bl.push(inv.billed.country);
    if (inv.billed.email) bl.push(inv.billed.email);
    if (inv.billed.phone) bl.push(inv.billed.phone);
    if (inv.billed.gstin) bl.push('GSTIN: ' + inv.billed.gstin);
    bl.forEach(t => { const h = doc.heightOfString(t, { width: W * 0.55 }); doc.text(t, L, ly, { width: W * 0.55 }); ly += Math.max(15.5, h + 2); });

    const rx = L + W * 0.62, rw = W * 0.38;
    doc.font('B').fontSize(8.5).fillColor(T.muted).text(status === 'due' ? 'PAY TO' : 'PAYMENT', rx, y, { width: rw, align: 'right', characterSpacing: 0.6 });
    let ry = y + 14;
    const kv = (k, v) => {
      doc.font('R').fontSize(10.5).fillColor(T.muted); const kw = doc.widthOfString(k + '  ');
      doc.font('M').fillColor(T.ink); const vw = doc.widthOfString(v);
      doc.font('R').fillColor(T.muted).text(k + '  ', R - kw - vw, ry, { lineBreak: false });
      doc.font('M').fillColor(T.ink).text(v, R - vw, ry, { lineBreak: false });
      ry += 15.5;
    };
    if (status === 'paid') {
      if (inv.payment.date) kv('Received', longDate(inv.payment.date));
      if (inv.payment.mode) kv('Mode', inv.payment.mode);
      if (inv.payment.ref) kv('Ref', inv.payment.ref);
      kv('Currency', cur);
    } else if (status === 'due') {
      kv('UPI', BIZ.bank.upi);
      kv('Bank', BIZ.bank.name);
      kv('A/c', BIZ.bank.acNo);
      kv('IFSC', BIZ.bank.ifsc);
      kv('A/c name', BIZ.bank.acName);
    } else {
      if (inv.cancelledAt) kv('Cancelled', longDate(inv.cancelledAt));
      kv('Currency', cur);
    }
    y = Math.max(ly, ry) + 10;

    // ── items ──
    let subtotal = 0;
    (inv.lines || []).forEach(ln => { subtotal += (Number(ln.qty) || 0) * (Number(ln.rate) || 0); });
    subtotal = Math.round(subtotal * 100) / 100;
    const tot = computeTotals(inv, subtotal);
    const total = tot.total;
    const paid = status === 'due' ? Math.min(Number(inv.amountPaid) || 0, total) : (status === 'paid' ? total : 0);
    const partial = status === 'due' && paid > 0;
    const balance = Math.round((total - paid) * 100) / 100;

    // ── status banner ──
    const cfg = partial
      ? { bg: '#eef3f8', bd: '#b9cfe4', c1: '#2b5c8a', c2: '#3c6f9c', main: 'PARTIALLY PAID', icon: drawHalf,
          sub: sym(cur) + money(paid, cur) + ' received' + (inv.payment && inv.payment.date ? ' on ' + longDate(inv.payment.date) : '') + '. Balance ' + sym(cur) + money(balance, cur) + (dueDate ? ' due by ' + longDate(dueDate) : '') + '.' }
      : {
        paid: { bg: '#e9f3ec', bd: '#bcd9c4', c1: '#2f7d4f', c2: '#3f8a5e', main: 'PAYMENT RECEIVED', icon: drawCheck,
          sub: 'Thank you. ' + (inv.payment.date ? 'Paid on ' + longDate(inv.payment.date) : '') + (inv.payment.mode ? ' via ' + inv.payment.mode : '') },
        due: { bg: '#fdf4e3', bd: '#eacf9e', c1: '#9a6a12', c2: '#a97b2a', main: 'PAYMENT DUE', icon: drawClock,
          sub: dueDate ? 'Please pay by ' + longDate(dueDate) + ' using the details above' : 'Please pay using the details above' },
        cancelled: { bg: '#faece8', bd: '#e2b3a4', c1: '#b4452c', c2: '#b4452c', main: 'INVOICE CANCELLED', icon: drawCross,
          sub: (inv.cancelledAt ? 'Cancelled on ' + longDate(inv.cancelledAt) + '. ' : '') + 'This invoice is void and not payable.' },
      }[status];
    {
      const bh = 46;
      doc.rect(L, y, W, bh).fillAndStroke(cfg.bg, cfg.bd);
      doc.font('B').fontSize(12).fillColor(cfg.c1);
      const mw = doc.widthOfString(cfg.main) + 17;
      const mx = L + (W - mw) / 2;
      cfg.icon(doc, mx, y + 10, 10, cfg.c1);
      doc.text(cfg.main, mx + 16, y + 9, { lineBreak: false });
      doc.font('R').fontSize(10).fillColor(cfg.c2).text(cfg.sub, L, y + 26, { width: W, align: 'center' });
      y += bh + 16;
    }

    // ── table ──
    const cQty = 46, cRate = 88, cAmt = 100, pad = 10;
    const xAmt = R - cAmt, xRate = xAmt - cRate, xQty = xRate - cQty;
    const descW = xQty - L - pad * 2;
    const tableHead = () => {
      doc.rect(L, y, W, 28).fill(T.accent);
      doc.font('B').fontSize(11).fillColor(T.accentInk);
      doc.text('Description', L + pad, y + 8.5);
      doc.text('Qty', xQty, y + 8.5, { width: cQty - pad, align: 'right' });
      doc.text('Rate (' + sym(cur) + ')', xRate, y + 8.5, { width: cRate - pad, align: 'right' });
      doc.text('Amount (' + sym(cur) + ')', xAmt, y + 8.5, { width: cAmt - pad, align: 'right' });
      y += 28;
    };
    tableHead();
    (inv.lines || []).forEach((ln, i) => {
      const qty = Number(ln.qty) || 0, rate = Number(ln.rate) || 0, amt = qty * rate;
      const sub = [ln.sub, gstOn ? 'SAC ' + (ln.sac || BIZ.gst.sac) : ''].filter(Boolean).join('  ·  ');
      doc.font('R').fontSize(11.5);
      const dh = doc.heightOfString(ln.desc || '', { width: descW, lineGap: 2 });
      let sh = 0;
      if (sub) { doc.fontSize(9.5); sh = doc.heightOfString(sub, { width: descW }) + 2; }
      const rowH = Math.max(31, dh + sh + 17);
      if (y + rowH > BOTTOM - 40) { y = newPage(); tableHead(); }
      if (i % 2 === 1) doc.rect(L, y, W, rowH).fill(T.band);
      doc.font('R').fontSize(11.5).fillColor(T.ink).text(ln.desc || '', L + pad, y + 9, { width: descW, lineGap: 2 });
      if (sub) doc.fontSize(9.5).fillColor(T.muted).text(sub, L + pad, y + 9 + dh + 2, { width: descW });
      doc.font('R').fontSize(11.5).fillColor(T.ink);
      doc.text(String(qty), xQty, y + 9, { width: cQty - pad, align: 'right', features: TNUM });
      doc.text(money(rate, cur), xRate, y + 9, { width: cRate - pad, align: 'right', features: TNUM });
      doc.text(money(amt, cur), xAmt, y + 9, { width: cAmt - pad, align: 'right', features: TNUM });
      y += rowH;
    });

    // ── totals ──
    const extraRows = tot.taxLines.length + (partial ? 2 : 0) + (tot.taxLines.length ? 1 : 0);
    if (y + 60 + extraRows * 16 + 60 > BOTTOM) y = newPage();
    y += 10;
    const tr = (label, val, bold) => {
      doc.font(bold ? 'B' : 'R').fontSize(11).fillColor(bold ? T.ink : T.muted);
      doc.text(label, xAmt - 160, y, { width: 150, align: 'right' });
      doc.font(bold ? 'B' : 'R').fillColor(T.ink).text(money(val, cur), xAmt, y, { width: cAmt - pad, align: 'right', features: TNUM });
      y += 18;
    };
    if (tot.taxLines.length) {
      tr('Subtotal', tot.subtotal);
      tot.taxLines.forEach(t => tr(t.label, t.amount));
      y += 4;
    }
    doc.rect(L, y, W, 36).fill(T.accent);
    doc.font('B').fontSize(13.5).fillColor(T.accentInk);
    doc.text(sym(cur) + money(total, cur), xAmt, y + 11, { width: cAmt - pad, align: 'right', features: TNUM });
    doc.text('TOTAL', xAmt - 80, y + 11, { width: 70, align: 'right' });
    y += 42;
    if (partial) {
      tr('Paid', paid);
      tr('Balance due', balance, true);
      y += 2;
    }
    doc.font('R').fontSize(10).fillColor(T.muted);
    oblique(doc, amountInWords(partial ? balance : total, cur) + (partial ? ' (balance)' : ''), L, y, { width: W, align: 'right' });
    y += 16;
    if (tot.taxNote) { doc.font('R').fontSize(10).fillColor(T.muted).text(tot.taxNote, L, y, { width: W, align: 'right' }); y += 14; }

    // ── optional bank block on a paid or cancelled invoice ──
    if (inv.showBank && status !== 'due') {
      y += 12;
      const bh2 = 68;
      doc.rect(L, y, W, bh2).fill(T.box);
      doc.font('B').fontSize(10.5).fillColor(T.ink).text('BANK DETAILS', L + 12, y + 11, { characterSpacing: 0.4 });
      doc.font('R').fillColor(T.ink)
        .text('UPI: ' + BIZ.bank.upi + '   ·   ' + BIZ.bank.name + '   ·   A/c name: ' + BIZ.bank.acName, L + 12, y + 29)
        .text('A/c no: ' + BIZ.bank.acNo + '   ·   IFSC: ' + BIZ.bank.ifsc, L + 12, y + 46);
      y += bh2;
    }

    // ── notes ──
    if (inv.notes) {
      y += 14;
      doc.font('B').fontSize(8.5).fillColor(T.muted).text('NOTES', L, y, { characterSpacing: 0.6 }); y += 13;
      doc.font('R').fontSize(10.5).fillColor(T.ink).text(inv.notes, L, y, { width: W, lineGap: 2 });
      y += doc.heightOfString(inv.notes, { width: W, lineGap: 2 });
    }

    // ── declarations pinned to the page bottom ──
    const decl = [];
    let pos = 'Place of supply: ' + BIZ.state + ', India.';
    if (isExport) pos += ' Export of services to ' + (inv.billed.country || 'a recipient outside India') + '. Consideration received in ' + cur + '.';
    decl.push(pos);
    decl.push('This is a computer-generated invoice and does not require a signature. Services rendered by ' + BIZ.name + ' as an individual.');
    decl.push('Questions about this invoice: ' + BIZ.email + '  ·  ' + BIZ.website);
    doc.font('R').fontSize(9);
    const dh = decl.reduce((a, t) => a + doc.heightOfString(t, { width: W }) + 4, 0);
    let dy = BOTTOM - dh;
    if (dy < y + 20) { y = newPage(); dy = BOTTOM - dh; }
    doc.moveTo(L, dy - 12).lineTo(R, dy - 12).lineWidth(0.5).strokeColor('#cccccc').stroke();
    decl.forEach(t => { doc.font('R').fontSize(9).fillColor(T.faint).text(t, L, dy, { width: W }); dy += doc.heightOfString(t, { width: W }) + 4; });
    finishPage();

    doc.end();
  });
}

module.exports = { buildInvoicePdf, amountInWords, longDate, money, computeTotals, BIZ, CURRENCY };
