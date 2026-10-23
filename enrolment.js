// ── WEEKLY CLASSES: REQUEST → APPROVE → PAY (self-enrolment) ──
// Flow agreed 22 Oct 2026:
//  1. invite      Arpit (or, later, the trial hook) creates a personal link
//                 arpitpandey.com/enroll/<token> and WhatsApps it
//                 (template weekly_classes_invite, button param = token).
//  2. requested   The person picks a weekly time (only free times, shown in
//                 their own zone) and a plan. The slot is HELD (trial page,
//                 My bookings moves and other requests can't take it).
//                 Arpit gets a push + a "Needs you" row in Today.
//  3. approved    Arpit taps Approve: a student row (status "Enrolling") and a
//                 fee request are made. The WhatsApp worker sends the fee
//                 link by itself (fee_link template); we also email it.
//     offered     Or Arpit offers another time; the person accepts in one tap
//                 (→ approved) or picks something else.
//     declined    Polite email, slot freed.
//  4. paid        Webhook → onFeePaid: weekly slot added to class_schedule,
//                 a recurring "no fixed time" Zoom meeting (type 3, one
//                 permanent link) is created, student set Active, trial
//                 marked converted, confirmation by email + My classes link
//                 on WhatsApp. The calendar invite worker sends the invite.
//  Timers (worker, every 10 min):
//     requested 24 h with no answer  → reminder push to Arpit (once)
//     requested 5 days               → expired, slot freed, person told
//     approved 24 h unpaid           → reminder email to the person (once)
//     approved 72 h unpaid           → expired: fee request cancelled,
//                                      "Enrolling" student archived, slot freed
//
// Table enrol_requests (RLS on, server only). See enrol.sql.

const crypto = require('crypto');
const tb = require('./trial-booking');

let supabase = null, whatsapp = null, zoomApi = null, push = null, portal = null;

const SITE = 'https://arpitpandey.com';
const PAY_BASE = SITE + '/pages/pay?r=';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.TRIAL_FROM_EMAIL || 'classes@arpitpandey.com';
const ARPIT_EMAIL = process.env.TRIAL_ARPIT_EMAIL || 'arpithandpan@gmail.com';
const HOST_EMAIL = process.env.ZOOM_HOST_EMAIL || 'arpithandpan@gmail.com';
const TEMPLATE = 'weekly_classes_invite';
const IST = 'Asia/Kolkata';
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const HOLD = ['requested', 'offered', 'approved'];
const OPEN = ['invited', 'requested', 'offered', 'approved'];
const PAY_WINDOW = 72 * HOUR, ARPIT_REMIND = 24 * HOUR, REQUEST_EXPIRE = 5 * DAY, PAY_REMIND = 24 * HOUR;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CANADA = /^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Montreal|Moncton|Whitehorse|Yellowknife|Iqaluit|Glace_Bay|Goose_Bay)$/;

function init(client, deps = {}) {
  supabase = client;
  whatsapp = deps.whatsapp || null;
  zoomApi = deps.zoomApi || null;
  push = deps.push || null;
  portal = deps.studentPortal || null;
}
function templateOn() { return String(process.env.WA_ENROL_TEMPLATE || '').trim().toLowerCase() === 'on'; }

// ── TIME ──
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } }
function partsIn(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { ymd: p.year + '-' + p.month + '-' + p.day, hhmm: (p.hour === '24' ? '00' : p.hour) + ':' + p.minute, weekday: wd };
}
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekdayOf(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); }
function zonedToUtc(ymd, hhmm, tz) { return tb._test.zonedToUtc(ymd, hhmm, tz).getTime(); }
function time12(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); }
function nice(ms, tz) {
  const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return p.weekday + ' ' + p.day + ' ' + p.month + ', ' + p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toUpperCase();
}
function tzName(tz) { if (tz === IST || tz === 'Asia/Calcutta') return 'IST'; return String(tz).split('/').pop().replace(/_/g, ' ') + ' time'; }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Weekly slot from a chosen first-class timestamp. Students outside India keep
// their own clock time (local anchor), like the Schedule page does.
function slotFrom(startMs, tz) {
  const ist = partsIn(startMs, IST);
  const loc = partsIn(startMs, tz);
  const anchored = tz !== IST && tz !== 'Asia/Calcutta';
  return { slot_weekday: ist.weekday, slot_time: ist.hhmm, local_weekday: anchored ? loc.weekday : null, local_time: anchored ? loc.hhmm : null };
}
// Next class of a weekly slot that is at least `noticeMs` away.
function nextOccurrence(row, noticeMs) {
  const tz = row.tz && validTz(row.tz) ? row.tz : IST;
  const local = row.local_time != null && row.local_weekday != null;
  const zone = local ? tz : IST, wd = local ? row.local_weekday : row.slot_weekday, hm = String(local ? row.local_time : row.slot_time).slice(0, 5);
  let d = partsIn(Date.now(), zone).ymd;
  for (let i = 0; i < 15; i++, d = addDays(d, 1)) {
    if (weekdayOf(d) !== Number(wd)) continue;
    const t = zonedToUtc(d, hm, zone);
    if (t >= Date.now() + noticeMs) return t;
  }
  return null;
}

// ── PRICES (Arpit's rule: ₹ in India, $18 abroad, C$25 in Canada; quarterly 10% off) ──
function priceFor(row, settings) {
  const dial = String(row.phone_dial || '').replace(/\D/g, '') || (String(row.phone || '').replace(/\D/g, '').startsWith('91') ? '91' : '');
  const tz = row.tz || '';
  if (dial === '91' || tz === IST || tz === 'Asia/Calcutta') return { currency: 'INR', per: settings.price_inr || 1500, symbol: '₹' };
  if (CANADA.test(tz) || /canada/i.test(row.country || '')) return { currency: 'CAD', per: 25, symbol: 'C$' };
  return { currency: 'USD', per: settings.price_usd || 18, symbol: '$' };
}
function plansFor(price) {
  const q = Math.round(price.per * 12 * 0.9);
  return {
    monthly: { key: 'monthly', label: 'Monthly', classes: 4, amount: price.per * 4, list: null, discount: null },
    quarterly: { key: 'quarterly', label: 'Quarterly', classes: 12, amount: q, list: price.per * 12, discount: 10 }
  };
}
function money(n, price) { return price.symbol + Number(n).toLocaleString(price.currency === 'INR' ? 'en-IN' : 'en-US'); }

// ── FREE WEEKLY TIMES ──
// A time can be a weekly slot when the first class (within the next 7 days,
// at least min-notice away) is free of everything, and the 3 weeks after it
// don't clash with another weekly class or hold. One-off things in later
// weeks (a trial, a moved class) are Arpit's to sort out.
async function weeklySlots() {
  const s = await tb.getSettings();
  const now = Date.now();
  const busy = await tb.busyIntervals(now, now + 30 * DAY);
  const first = tb._test.computeSlots({ ...s, days_ahead: 7 }, busy, now, s.class_min);
  const rec = busy.filter(b => /^class /.test(b.what || ''));
  const buf = s.buffer_min * MIN, len = s.class_min * MIN;
  const ok = first.filter(t => [1, 2, 3].every(k => {
    const a = t + k * 7 * DAY, e = a + len;
    return !rec.some(b => a < b.e + buf && e + buf > b.s);
  }));
  return { settings: s, slots: ok };
}
function bookerOk(t, tz, settings) {
  const [a, b] = settings.booker_day || [420, 1380];
  const p = partsIn(t, tz); const m = Number(p.hhmm.slice(0, 2)) * 60 + Number(p.hhmm.slice(3, 5));
  return m >= a && m + settings.class_min <= b;
}

// ── DATA ──
async function byToken(token) {
  if (!/^[a-f0-9]{24,64}$/.test(String(token || ''))) return null;
  const { data } = await supabase.from('enrol_requests').select('*').eq('token', token).maybeSingle();
  return data || null;
}
async function byId(id) {
  const { data } = await supabase.from('enrol_requests').select('*').eq('id', id).maybeSingle();
  return data || null;
}
async function update(id, fields) {
  const { error } = await supabase.from('enrol_requests').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error('enrol_requests: ' + error.message);
}
async function notify(type, message) {
  try { await supabase.from('notifications').insert({ type, message, read: false }); } catch (e) { console.error('enrol notify failed:', e.message); }
}
function pushArpit(title, body, tag) {
  if (!push || !push.send) return;
  push.send('trial', { title, body, tag: tag || 'enrol', renotify: true, url: '/pages/dashboard#sec=today' }).catch(() => {});
}

// ── EMAIL ──
function shell(inner) {
  return '<div style="background:#F5EEE5;padding:28px 16px;font-family:Helvetica,Arial,sans-serif;color:#5A4645;"><div style="max-width:520px;margin:0 auto;background:#FFFDFA;border-radius:16px;padding:28px 24px;">' + inner +
    '<p style="margin:28px 0 0;font-size:13px;color:#6B5150;">Arpit Pandey · Handpan artist and teacher<br><a href="' + SITE + '" style="color:#500018;">arpitpandey.com</a></p></div></div>';
}
function btn(href, label) { return '<p style="margin:22px 0;"><a href="' + href + '" style="display:inline-block;background:#500018;color:#fff;text-decoration:none;padding:13px 26px;border-radius:40px;font-weight:600;">' + esc(label) + '</a></p>'; }
async function mail(to, subject, html, text) {
  if (!RESEND_API_KEY || !to) return { ok: false, error: !to ? 'no email' : 'RESEND_API_KEY not set' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Arpit Pandey <' + FROM_EMAIL + '>', to: [to], subject, html: shell(html), text, reply_to: ARPIT_EMAIL })
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return { ok: false, error: j.message || ('HTTP ' + r.status) }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
function slotText(row) {
  const tz = row.tz || IST;
  const t = row.first_start ? new Date(row.first_start).getTime() : nextOccurrence(row, 0);
  if (!t) return DAYS[row.slot_weekday] + 's ' + time12(row.slot_time) + ' IST';
  const p = partsIn(t, tz);
  return DAYS[p.weekday] + 's at ' + time12(p.hhmm) + (tz === IST ? ' IST' : ' (' + tzName(tz) + ')');
}
function linkFor(row) { return SITE + '/enroll/' + row.token; }

// ── VIEW for the person's page ──
async function view(row) {
  const settings = await tb.getSettings();
  const price = priceFor(row, settings);
  const plans = plansFor(price);
  const tz = row.tz && validTz(row.tz) ? row.tz : IST;
  const out = {
    ok: true, status: row.status, name: firstName(row.full_name), tz, tzName: tzName(tz),
    currency: price.currency, symbol: price.symbol,
    plans: Object.values(plans).map(p => ({ key: p.key, label: p.label, classes: p.classes, amount: p.amount, text: money(p.amount, price), list: p.list ? money(p.list, price) : null, discount: p.discount })),
    whatsapp: settings.whatsapp
  };
  if (row.slot_weekday != null) {
    const first = row.status === 'paid' && row.first_class_at ? new Date(row.first_class_at).getTime() : nextOccurrence(row, (settings.min_notice_hours || 12) * HOUR);
    out.request = { plan: row.plan, slot: slotText(row), first: first ? nice(first, tz) : null, planText: plans[row.plan] ? plans[row.plan].label + ' · ' + plans[row.plan].classes + ' classes' : '', amount: plans[row.plan] ? money(row.amount || plans[row.plan].amount, price) : '' };
  }
  if (row.status === 'approved') { out.payUrl = PAY_BASE + encodeURIComponent(row.fee_request_id || ''); out.payBy = row.pay_by ? nice(new Date(row.pay_by).getTime(), tz) : null; }
  if (row.status === 'offered') out.offerNote = row.offer_note || null;
  if (row.status === 'paid') out.myLink = SITE + '/my';
  if (row.status === 'invited' || row.status === 'offered' || row.status === 'requested') {
    const { slots } = await weeklySlots();
    out.slots = slots.filter(t => bookerOk(t, tz, settings)).map(t => new Date(t).toISOString());
    out.classMin = settings.class_min;
  }
  return out;
}

// ── PUBLIC HANDLERS ──
async function getHandler(req, res) {
  try {
    const row = await byToken(req.params.token);
    res.set('Cache-Control', 'no-store');
    if (!row || row.status === 'cancelled') return res.status(404).json({ ok: false, error: 'This link is not valid any more. Message Arpit on WhatsApp and he will send a new one.' });
    if (row.status === 'expired' || row.status === 'declined') return res.json({ ok: true, status: row.status, name: firstName(row.full_name), whatsapp: (await tb.getSettings()).whatsapp });
    res.json(await view(row));
  } catch (e) { console.error('enrol get error:', e.message); res.status(500).json({ ok: false, error: 'Could not load right now. Please try again in a minute.' }); }
}

const _hits = new Map();
function limited(key) {
  const now = Date.now(); const list = (_hits.get(key) || []).filter(t => now - t < 10 * MIN); list.push(now); _hits.set(key, list); return list.length > 12;
}

async function requestHandler(req, res) {
  try {
    if (limited('r:' + (req.ip || ''))) return res.status(429).json({ ok: false, error: 'Too many tries. Please wait a few minutes.' });
    const row = await byToken(req.params.token);
    if (!row || !['invited', 'requested', 'offered'].includes(row.status)) return res.status(409).json({ ok: false, error: 'This request can’t be changed now. Message Arpit on WhatsApp.' });
    const b = req.body || {};
    const start = new Date(b.start).getTime();
    const plan = b.plan === 'monthly' ? 'monthly' : b.plan === 'quarterly' ? 'quarterly' : null;
    if (!plan) return res.status(400).json({ ok: false, error: 'Please pick a plan.' });
    if (isNaN(start)) return res.status(400).json({ ok: false, error: 'Please pick a time.' });
    let tz = row.tz && validTz(row.tz) ? row.tz : IST;
    if (b.tz && validTz(b.tz) && (!row.tz || row.status === 'invited')) tz = b.tz;
    // Release this person's own hold first, so they can keep or change it.
    const before = { status: row.status };
    if (row.status !== 'invited') await update(row.id, { status: 'invited' });
    const { settings, slots } = await weeklySlots();
    if (!slots.includes(start)) {
      if (before.status !== 'invited') await update(row.id, { status: before.status });
      return res.status(409).json({ ok: false, code: 'slot_taken', error: 'Sorry, that time was just taken. Please pick another one.' });
    }
    const price = priceFor({ ...row, tz }, settings);
    const p = plansFor(price)[plan];
    const fields = {
      status: 'requested', tz, plan, classes: p.classes, amount: p.amount, list_amount: p.list, discount_pct: p.discount, currency: price.currency,
      first_start: new Date(start).toISOString(), ...slotFrom(start, tz), requested_at: new Date().toISOString(), arpit_reminded_at: null, offer_note: null
    };
    await update(row.id, fields);
    const r2 = { ...row, ...fields };
    const changed = before.status !== 'invited';
    const msg = (changed ? '🔁 Weekly class request changed: ' : '🔴 New weekly class request: ') + row.full_name + ' · ' + DAYS[r2.slot_weekday].slice(0, 3) + ' ' + time12(r2.slot_time) + ' IST' +
      (tz !== IST ? ' (' + time12(partsIn(start, tz).hhmm) + ' ' + tzName(tz) + ')' : '') + ' · ' + p.label + ' ' + money(p.amount, price) + '. Approve it in Today.';
    await notify('trial', msg);
    pushArpit('🗓️ ' + firstName(row.full_name) + ' wants weekly classes', DAYS[r2.slot_weekday].slice(0, 3) + ' ' + time12(r2.slot_time) + ' IST · ' + p.label, 'enrol-' + row.id);
    res.json(await view(r2));
  } catch (e) { console.error('enrol request error:', e.message); res.status(500).json({ ok: false, error: 'Could not send right now. Please try again.' }); }
}

// Accept Arpit's counter-offer: Arpit already agreed, so straight to approved.
async function acceptHandler(req, res) {
  try {
    const row = await byToken(req.params.token);
    if (!row || row.status !== 'offered') return res.status(409).json({ ok: false, error: 'This offer is no longer open.' });
    const r = await approveRow(row, { by: 'student' });
    if (!r.ok) return res.status(409).json(r);
    res.json(await view(await byId(row.id)));
  } catch (e) { console.error('enrol accept error:', e.message); res.status(500).json({ ok: false, error: 'Could not confirm right now. Please try again.' }); }
}

// After approval: switch plan (same time, no new approval) → the fee link amount changes.
async function planHandler(req, res) {
  try {
    const row = await byToken(req.params.token);
    if (!row || row.status !== 'approved') return res.status(409).json({ ok: false, error: 'The plan can’t be changed now. Message Arpit on WhatsApp.' });
    const plan = req.body?.plan === 'monthly' ? 'monthly' : req.body?.plan === 'quarterly' ? 'quarterly' : null;
    if (!plan) return res.status(400).json({ ok: false, error: 'Pick a plan' });
    if (plan === row.plan) return res.json(await view(row));
    const { data: fr } = await supabase.from('fee_requests').select('id, status').eq('id', row.fee_request_id).maybeSingle();
    if (!fr || fr.status !== 'pending') return res.status(409).json({ ok: false, error: fr && fr.status === 'paid' ? 'This is already paid.' : 'The payment link has ended. Message Arpit on WhatsApp.' });
    const settings = await tb.getSettings();
    const price = priceFor(row, settings);
    const p = plansFor(price)[plan];
    const { error } = await supabase.from('fee_requests').update({
      classes: p.classes, amount: p.amount, list_amount: p.list, discount_pct: p.discount,
      note: 'Weekly classes · ' + p.label + ' · ' + DAYS[row.slot_weekday].slice(0, 3) + ' ' + time12(row.slot_time) + ' IST'
    }).eq('id', fr.id).eq('status', 'pending');
    if (error) throw new Error('fee_requests: ' + error.message);
    await update(row.id, { plan, classes: p.classes, amount: p.amount, list_amount: p.list, discount_pct: p.discount });
    await notify('info', '🔁 ' + row.full_name + ' switched to the ' + p.label.toLowerCase() + ' plan (' + money(p.amount, price) + '). ' + fr.id + ' now asks for that amount.');
    res.json({ ...(await view(await byId(row.id))), switched: p.label });
  } catch (e) { console.error('enrol plan error:', e.message); res.status(500).json({ ok: false, error: 'Could not change the plan right now. Please try again.' }); }
}
// After approval: wants another time → release the time and the fee link; the
// new pick goes back to Arpit for approval. The "Enrolling" student is kept and reused.
async function releaseHandler(req, res) {
  try {
    const row = await byToken(req.params.token);
    if (!row || row.status !== 'approved') return res.status(409).json({ ok: false, error: 'This can’t be changed now.' });
    if (row.fee_request_id) {
      const { data: fr } = await supabase.from('fee_requests').select('status').eq('id', row.fee_request_id).maybeSingle();
      if (fr && fr.status === 'paid') return res.status(409).json({ ok: false, error: 'This is already paid. Message Arpit on WhatsApp to change your time.' });
      await supabase.from('fee_requests').update({ status: 'cancelled' }).eq('id', row.fee_request_id).eq('status', 'pending');
    }
    const asked = slotText(row);
    await update(row.id, { status: 'invited', fee_request_id: null, pay_by: null, approved_at: null, pay_reminded_at: null });
    await notify('info', '🔁 ' + row.full_name + ' wants a different weekly time than ' + asked + '. The time and the fee link are released; their new pick will come to Today for approval.');
    res.json({ ...(await view(await byId(row.id))), released: true });
  } catch (e) { console.error('enrol release error:', e.message); res.status(500).json({ ok: false, error: 'Could not do that right now. Please try again.' }); }
}

// ── STUDENT + FEE REQUEST ──
async function nextId(table, prefix) {
  const { data } = await supabase.from(table).select('id').like('id', prefix + '-%');
  let max = 0;
  for (const r of (data || [])) { const n = parseInt(String(r.id).slice(prefix.length + 1), 10); if (n > max) max = n; }
  return prefix + '-' + String(max + 1).padStart(3, '0');
}
async function findStudent(row) {
  const last10 = String(row.phone || '').replace(/\D/g, '').slice(-10);
  const em = String(row.email || '').toLowerCase();
  const ors = [];
  if (last10.length >= 8) ors.push('phone.ilike.%' + last10);
  if (em) ors.push('email.ilike.' + em);
  if (!ors.length) return null;
  const { data } = await supabase.from('students').select('*').or(ors.join(',')).limit(5);
  return (data || []).find(s => !s.archived) || null;
}
async function ensureStudent(row, price) {
  if (row.student_id) {
    const { data } = await supabase.from('students').select('*').eq('id', row.student_id).maybeSingle();
    if (data && !data.archived) return { student: data, created: false };
  }
  const found = await findStudent(row);
  if (found) return { student: found, created: false };
  for (let i = 0; i < 3; i++) {
    const id = await nextId('students', 'S');
    const body = {
      id, full_name: row.full_name, phone: row.phone ? '+' + String(row.phone).replace(/\D/g, '') : null, email: row.email || null,
      status: 'Enrolling', monthly_fee: price.per, fee_basis: 'class', currency: price.currency,
      country: row.country || null, total_classes: 0, total_paid: 0,
      description: 'Self-enrolment (request #' + row.id + ')' + (row.trial_id ? ' after trial ' + row.trial_id : '')
    };
    const { data, error } = await supabase.from('students').insert(body).select().single();
    if (!error) return { student: data, created: true };
    if (error.code !== '23505') throw new Error('students: ' + error.message);
  }
  throw new Error('Could not make a student ID');
}
async function createFeeRequest(row, student) {
  const ym = new Date(Date.now() + 330 * MIN).toISOString().slice(0, 7);
  for (let i = 0; i < 3; i++) {
    const id = await nextId('fee_requests', 'FR');
    const { error } = await supabase.from('fee_requests').insert({
      id, student_id: student.id, classes: row.classes, amount: row.amount, currency: row.currency,
      list_amount: row.list_amount || null, discount_pct: row.discount_pct || null, month: ym,
      note: 'Weekly classes · ' + (row.plan === 'quarterly' ? 'Quarterly' : 'Monthly') + ' · ' + DAYS[row.slot_weekday].slice(0, 3) + ' ' + time12(row.slot_time) + ' IST',
      status: 'pending'
    });
    if (!error) return id;
    if (error.code !== '23505') throw new Error('fee_requests: ' + error.message);
  }
  throw new Error('Could not make a fee request ID');
}

async function approveRow(row, { by } = {}) {
  if (!['requested', 'offered'].includes(row.status)) return { ok: false, error: 'Already ' + row.status };
  const settings = await tb.getSettings();
  const price = priceFor(row, settings);
  const { student, created } = await ensureStudent(row, price);
  const feeId = await createFeeRequest(row, student);
  const payBy = new Date(Date.now() + PAY_WINDOW).toISOString();
  await update(row.id, { status: 'approved', student_id: student.id, student_created: created, fee_request_id: feeId, approved_at: new Date().toISOString(), pay_by: payBy, pay_reminded_at: null });
  const r = { ...row, student_id: student.id, fee_request_id: feeId, pay_by: payBy };
  const tz = row.tz || IST;
  const payUrl = PAY_BASE + encodeURIComponent(feeId);
  const plan = plansFor(price)[row.plan];
  await mail(row.email, 'Confirmed: your weekly handpan class 🎶',
    '<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(firstName(row.full_name)) + ',</p>' +
    '<p style="margin:0 0 12px;line-height:1.55;">' + (by === 'student' ? 'You’re confirmed for ' : 'I’ve confirmed your weekly class: ') + '<b>' + esc(slotText(r)) + '</b>, ' + esc(plan.label.toLowerCase()) + ' plan (' + plan.classes + ' classes, ' + esc(money(row.amount, price)) + ').</p>' +
    '<p style="margin:0;line-height:1.55;">Pay to lock the time in. It’s held for you until <b>' + esc(nice(new Date(payBy).getTime(), tz)) + '</b>.</p>' + btn(payUrl, 'Pay ' + money(row.amount, price)) +
    '<p style="margin:0;line-height:1.55;color:#6B5150;font-size:14px;">After paying you’ll get your Zoom link, an invoice and a calendar invite.</p>',
    'Hi ' + firstName(row.full_name) + ', your weekly class (' + slotText(r) + ') is confirmed. Pay here to lock it in: ' + payUrl);
  await notify('info', '✅ Weekly classes approved for ' + row.full_name + ' (' + student.id + (created ? ', new' : '') + ') · ' + feeId + ' · pay by ' + nice(new Date(payBy).getTime(), IST) + ' IST.' + (by === 'student' ? ' They accepted your other time.' : ''));
  return { ok: true, studentId: student.id, feeRequestId: feeId, payUrl };
}

// ── ON PAYMENT (called from the Razorpay webhook after the fee request is paid) ──
async function onFeePaid(feeRequestId) {
  try {
    if (!feeRequestId) return null;
    const { data: row } = await supabase.from('enrol_requests').select('*').eq('fee_request_id', feeRequestId).maybeSingle();
    if (!row || row.status === 'paid') return null;
    const settings = await tb.getSettings();
    const tz = row.tz && validTz(row.tz) ? row.tz : IST;
    const { data: student } = await supabase.from('students').select('*').eq('id', row.student_id).maybeSingle();
    const name = (student && student.full_name) || row.full_name;
    // Late payment after expiry: the money is saved by the webhook; tell Arpit.
    const lapsed = row.status !== 'approved';
    // 1. Weekly slot (skip if they already have an active one at this time).
    const { data: have } = await supabase.from('class_schedule').select('id, weekday, time_ist').eq('student_id', row.student_id).eq('active', true);
    let slotId = null;
    const same = (have || []).find(h => Number(h.weekday) === Number(row.slot_weekday) && String(h.time_ist).slice(0, 5) === String(row.slot_time).slice(0, 5));
    if (same) slotId = same.id;
    else {
      const { data: ins, error } = await supabase.from('class_schedule').insert({
        student_id: row.student_id, weekday: row.slot_weekday, time_ist: row.slot_time, local_weekday: row.local_weekday, local_time: row.local_time,
        student_tz: tz, duration_min: settings.class_min || 60, active: true
      }).select().single();
      if (error) throw new Error('class_schedule: ' + error.message);
      slotId = ins.id;
    }
    // 2. Zoom: recurring, no fixed time (type 3) → one permanent link.
    let joinUrl = null, meetingId = null;
    if (zoomApi) {
      for (let i = 0; i < 2 && !joinUrl; i++) {
        const z = await zoomApi('POST', '/users/' + encodeURIComponent(HOST_EMAIL) + '/meetings', {
          topic: 'Handpan Class · ' + name, type: 3, timezone: tz, duration: settings.class_min || 60,
          settings: { join_before_host: false, waiting_room: true, approval_type: 2 }
        });
        if (z.ok && z.data) { joinUrl = z.data.join_url; meetingId = String(z.data.id); }
        else console.error('enrol zoom create failed:', z.error);
      }
      if (joinUrl) await supabase.from('class_schedule').update({ zoom_link: joinUrl }).eq('id', slotId);
    }
    // 3. Student active, trial converted.
    if (student && /enrolling|break/i.test(String(student.status || ''))) {
      await supabase.from('students').update({ status: 'Active', join_date: new Date(Date.now() + 330 * MIN).toISOString().slice(0, 10) }).eq('id', row.student_id);
    }
    if (row.trial_id) await supabase.from('trials').update({ student_id: row.student_id, converted_at: new Date().toISOString() }).eq('id', row.trial_id).then(() => {}, () => {});
    const first = nextOccurrence({ ...row, tz }, (settings.min_notice_hours || 12) * HOUR);
    await update(row.id, { status: 'paid', paid_at: new Date().toISOString(), slot_id: String(slotId), zoom_meeting_id: meetingId, first_class_at: first ? new Date(first).toISOString() : null });
    // 4. Tell the student.
    const firstTxt = first ? nice(first, tz) + (tz === IST ? ' IST' : ' (' + tzName(tz) + ')') : slotText(row);
    await mail(row.email, 'You’re in! Your weekly handpan class 🎶',
      '<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(firstName(name)) + ',</p>' +
      '<p style="margin:0 0 12px;line-height:1.55;">Thanks, your payment came through. Your class is every week, <b>' + esc(slotText(row)) + '</b>. First class: <b>' + esc(firstTxt) + '</b>.</p>' +
      (joinUrl ? '<p style="margin:0 0 6px;line-height:1.55;">Your Zoom link (the same every week):</p>' + btn(joinUrl, 'Join on Zoom') : '<p style="line-height:1.55;">Your Zoom link is on its way.</p>') +
      '<p style="margin:0;line-height:1.55;">You’ll get a reminder an hour before each class. To move or skip a class: <a href="' + SITE + '/my" style="color:#500018;">arpitpandey.com/my</a></p>',
      'Hi ' + firstName(name) + ', you are in! Weekly class: ' + slotText(row) + '. First class: ' + firstTxt + '. Zoom: ' + (joinUrl || 'coming soon'));
    if (portal && portal.linkForStudent && whatsapp && row.phone) {
      try {
        const link = await portal.linkForStudent(row.student_id);
        if (link && link.url) await whatsapp.sendTemplate(row.phone, 'my_classes_link', [firstName(name), link.url]);
      } catch (e) { console.error('enrol my-link WhatsApp failed:', e.message); }
    }
    await notify('payment', '🎉 ' + name + ' is enrolled: ' + DAYS[row.slot_weekday].slice(0, 3) + ' ' + time12(row.slot_time) + ' IST weekly, first class ' + (first ? nice(first, IST) + ' IST' : '?') + '.' +
      (joinUrl ? ' Zoom meeting created.' : ' ⚠️ Zoom meeting could not be created, add the link on the Schedule page.') +
      (lapsed ? ' ⚠️ They paid after the request had ' + row.status + ', check the time is still free.' : ''));
    return { ok: true, slotId, joinUrl };
  } catch (e) {
    console.error('enrol onFeePaid failed:', e.message);
    await notify('warning', '🔴 Payment for ' + feeRequestId + ' came in, but setting up the weekly class failed: ' + e.message + '. Add the slot on the Schedule page.');
    return { ok: false, error: e.message };
  }
}

// ── ADMIN ──
function clean(s, max) { return String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
async function invite({ trialId, name, phone, email, tz, country, send }) {
  let base = { full_name: clean(name, 80), phone: String(phone || '').replace(/\D/g, ''), email: clean(email, 120).toLowerCase() || null, tz: tz && validTz(tz) ? tz : null, country: clean(country, 60) || null, source: 'manual' };
  if (trialId) {
    const { data: t } = await supabase.from('trials').select('*').eq('id', trialId).maybeSingle();
    if (!t) throw new Error('No trial ' + trialId);
    const dial = String(t.phone_dial || '').replace(/\D/g, '');
    let ph = String(t.phone || '').replace(/\D/g, '') || (/@/.test(t.contact || '') ? '' : String(t.contact || '').replace(/\D/g, ''));
    if (dial && ph && !ph.startsWith(dial) && ph.length <= 10) ph = dial + ph;
    if (!dial && ph.length === 10) ph = '91' + ph;
    base = { full_name: t.full_name, phone: ph, phone_dial: dial || (ph.startsWith('91') && ph.length === 12 ? '91' : null),
      email: (t.email || (/@/.test(t.contact || '') ? t.contact : '') || '').toLowerCase() || null,
      tz: t.tz && validTz(t.tz) ? t.tz : null, source: 'trial', trial_id: t.id };
  }
  if (!base.full_name) throw new Error('Name needed');
  if (!base.phone_dial && base.phone.startsWith('91') && base.phone.length === 12) base.phone_dial = '91';
  // One open request per person: reuse it.
  const last10 = base.phone.slice(-10);
  if (last10.length >= 8) {
    const { data: open } = await supabase.from('enrol_requests').select('*').in('status', OPEN).ilike('phone', '%' + last10).limit(1);
    if (open && open.length) return finishInvite(open[0], send, true);
  }
  const token = crypto.randomBytes(16).toString('hex');
  const { data: row, error } = await supabase.from('enrol_requests').insert({ ...base, token, status: 'invited', invited_at: new Date().toISOString() }).select().single();
  if (error) throw new Error('enrol_requests: ' + error.message);
  return finishInvite(row, send, false);
}
async function finishInvite(row, send, reused) {
  const link = linkFor(row);
  let wa = null;
  if (send !== false && templateOn() && whatsapp && row.phone) {
    wa = await whatsapp.sendTemplate(row.phone, TEMPLATE, [firstName(row.full_name)], { buttonUrlParam: row.token });
    if (wa && wa.ok) await update(row.id, { invite_sent_at: new Date().toISOString() });
  }
  return { ok: true, id: row.id, link, reused, whatsapp: wa ? (wa.ok ? 'sent' : 'failed: ' + wa.error) : (templateOn() ? 'no phone' : 'template off') };
}
async function inviteHandler(req, res) {
  try { res.json(await invite(req.body || {})); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}
async function listHandler(req, res) {
  try {
    const { data, error } = await supabase.from('enrol_requests').select('*').in('status', ['requested', 'offered', 'approved']).order('requested_at', { ascending: true });
    if (error) throw new Error(error.message);
    const settings = await tb.getSettings();
    res.json({ ok: true, requests: (data || []).map(r => {
      const price = priceFor(r, settings);
      const tz = r.tz || IST;
      const t = r.first_start ? new Date(r.first_start).getTime() : null;
      return {
        id: r.id, status: r.status, name: r.full_name, phone: r.phone, email: r.email, tz,
        slotIst: DAYS[r.slot_weekday] ? DAYS[r.slot_weekday].slice(0, 3) + ' ' + time12(r.slot_time) + ' IST' : '',
        slotLocal: t && tz !== IST ? time12(partsIn(t, tz).hhmm) + ' ' + tzName(tz) : null,
        plan: r.plan, classes: r.classes, amount: money(r.amount || 0, price), trialId: r.trial_id,
        requestedAt: r.requested_at, approvedAt: r.approved_at, payBy: r.pay_by, feeRequestId: r.fee_request_id, studentId: r.student_id, offerNote: r.offer_note
      };
    }) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}
async function approveHandler(req, res) {
  try {
    const row = await byId(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json(await approveRow(row, { by: 'arpit' }));
  } catch (e) { console.error('enrol approve error:', e.message); res.status(500).json({ ok: false, error: e.message }); }
}
// Offer another time: body { weekday: 0-6 (IST), time: 'HH:MM' (IST), note? }
async function offerHandler(req, res) {
  try {
    const row = await byId(req.params.id);
    if (!row || !['requested', 'offered'].includes(row.status)) return res.status(409).json({ ok: false, error: 'Not open' });
    const wd = Number(req.body?.weekday), hm = String(req.body?.time || '');
    if (!(wd >= 0 && wd <= 6) || !/^\d{2}:\d{2}$/.test(hm)) return res.status(400).json({ ok: false, error: 'Pick a day and time' });
    let d = partsIn(Date.now() + 12 * HOUR, IST).ymd;
    while (weekdayOf(d) !== wd) d = addDays(d, 1);
    const start = zonedToUtc(d, hm, IST);
    const tz = row.tz && validTz(row.tz) ? row.tz : IST;
    const asked = slotText(row);
    await update(row.id, { status: 'offered', first_start: new Date(start).toISOString(), ...slotFrom(start, tz), offer_note: clean(req.body?.note, 300) || null, offered_at: new Date().toISOString() });
    const r = await byId(row.id);
    await mail(row.email, 'About your weekly handpan class time',
      '<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(firstName(row.full_name)) + ',</p>' +
      '<p style="margin:0 0 12px;line-height:1.55;">Thanks for your request. ' + esc(asked) + ' doesn’t work on my side, but <b>' + esc(slotText(r)) + '</b> does.' + (r.offer_note ? ' ' + esc(r.offer_note) : '') + '</p>' +
      '<p style="margin:0;line-height:1.55;">If that suits you, confirm with one tap. Or pick another time on the same page.</p>' + btn(linkFor(r), 'See the new time'),
      'Hi ' + firstName(row.full_name) + ', ' + asked + ' does not work, but ' + slotText(r) + ' does. Confirm or pick another time: ' + linkFor(r));
    res.json({ ok: true, slot: slotText(r) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}
async function declineHandler(req, res) {
  try {
    const row = await byId(req.params.id);
    if (!row || !['requested', 'offered'].includes(row.status)) return res.status(409).json({ ok: false, error: 'Not open' });
    await update(row.id, { status: 'declined', decided_at: new Date().toISOString() });
    const note = clean(req.body?.note, 300);
    await mail(row.email, 'About your weekly handpan classes',
      '<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(firstName(row.full_name)) + ',</p>' +
      '<p style="margin:0 0 12px;line-height:1.55;">Thank you for wanting to learn with me. I’m not able to take on this weekly class right now.' + (note ? ' ' + esc(note) : '') + '</p>' +
      '<p style="margin:0;line-height:1.55;">Nothing has been charged. If anything changes I’ll be in touch, and you’re welcome to message me anytime.</p>',
      'Hi ' + firstName(row.full_name) + ', thank you for your request. I am not able to take on this weekly class right now. Nothing has been charged.');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

// ── WORKER ──
async function expire(row, why) {
  await update(row.id, { status: 'expired', decided_at: new Date().toISOString() });
  if (row.fee_request_id) await supabase.from('fee_requests').update({ status: 'cancelled' }).eq('id', row.fee_request_id).eq('status', 'pending');
  if (row.student_created && row.student_id) {
    const { data: st } = await supabase.from('students').select('status').eq('id', row.student_id).maybeSingle();
    if (st && /enrolling/i.test(st.status || '')) await supabase.from('students').update({ archived: true }).eq('id', row.student_id);
  }
  return why;
}
async function tick() {
  const { data, error } = await supabase.from('enrol_requests').select('*').in('status', HOLD);
  if (error) { if (!/does not exist/i.test(error.message)) console.error('enrol worker:', error.message); return; }
  const now = Date.now();
  for (const r of (data || [])) {
    try {
      if (r.status === 'requested' && r.requested_at) {
        const age = now - new Date(r.requested_at).getTime();
        if (age > REQUEST_EXPIRE) {
          await expire(r);
          await mail(r.email, 'About your weekly handpan class request', '<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(firstName(r.full_name)) + ',</p><p style="margin:0;line-height:1.55;">Sorry, I couldn’t confirm your weekly class time in time, so it’s free again. Message me on WhatsApp and we’ll find a time together.</p>', 'Sorry, I could not confirm your weekly class time in time. Message me on WhatsApp and we will find a time.');
          await notify('warning', '⌛ ' + r.full_name + '’s weekly class request expired after 5 days without an answer. The time is free again.');
        } else if (age > ARPIT_REMIND && !r.arpit_reminded_at) {
          await update(r.id, { arpit_reminded_at: new Date().toISOString() });
          await notify('warning', '⏰ ' + r.full_name + ' has been waiting a day for your answer on weekly classes (' + DAYS[r.slot_weekday].slice(0, 3) + ' ' + time12(r.slot_time) + ' IST). Approve it in Today.');
          pushArpit('⏰ ' + firstName(r.full_name) + ' is waiting a day', 'Weekly class request · ' + DAYS[r.slot_weekday].slice(0, 3) + ' ' + time12(r.slot_time) + ' IST', 'enrol-' + r.id);
        }
      }
      if (r.status === 'offered' && r.offered_at && now - new Date(r.offered_at).getTime() > REQUEST_EXPIRE) {
        await expire(r);
        await notify('info', '⌛ ' + r.full_name + ' didn’t answer your other time for 5 days, so the request expired.');
      }
      if (r.status === 'approved' && r.pay_by) {
        const left = new Date(r.pay_by).getTime() - now;
        if (left <= 0) {
          await expire(r);
          await mail(r.email, 'Your weekly class time is free again', '<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(firstName(r.full_name)) + ',</p><p style="margin:0;line-height:1.55;">The time I held for you has been released because the payment didn’t come through. If you still want to learn, just message me and we’ll find a time.</p>', 'The weekly class time I held for you has been released. Message me if you still want to learn.');
          await notify('warning', '⌛ ' + r.full_name + ' didn’t pay within 3 days. The weekly time is free again and ' + (r.fee_request_id || 'the fee link') + ' is cancelled.');
        } else if (now - new Date(r.approved_at || r.pay_by).getTime() > PAY_REMIND && !r.pay_reminded_at) {
          await update(r.id, { pay_reminded_at: new Date().toISOString() });
          const settings = await tb.getSettings(); const price = priceFor(r, settings);
          await mail(r.email, 'Reminder: your weekly class time is held until ' + nice(new Date(r.pay_by).getTime(), r.tz || IST),
            '<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(firstName(r.full_name)) + ',</p><p style="margin:0;line-height:1.55;">Just a reminder: <b>' + esc(slotText(r)) + '</b> is held for you until <b>' + esc(nice(new Date(r.pay_by).getTime(), r.tz || IST)) + '</b>.</p>' + btn(PAY_BASE + encodeURIComponent(r.fee_request_id), 'Pay ' + money(r.amount, price)),
            'Reminder: your weekly class time is held until ' + nice(new Date(r.pay_by).getTime(), r.tz || IST) + '. Pay: ' + PAY_BASE + r.fee_request_id);
        }
      }
    } catch (e) { console.error('enrol worker row ' + r.id + ':', e.message); }
  }
}
let _timer = null, _busy = false;
function startWorker() {
  if (_timer) return;
  console.log('Enrolment: worker on (every 10 min), WhatsApp invite template ' + (templateOn() ? 'on' : 'off'));
  const run = async () => { if (_busy) return; _busy = true; try { await tick(); } catch (e) { console.error('enrol tick:', e.message); } finally { _busy = false; } };
  setTimeout(run, 90 * 1000);
  _timer = setInterval(run, 10 * MIN);
}

module.exports = {
  init, startWorker, getHandler, requestHandler, acceptHandler, planHandler, releaseHandler, inviteHandler, listHandler, approveHandler, offerHandler, declineHandler, onFeePaid, invite, weeklySlots,
  _test: { priceFor, plansFor, slotFrom, nextOccurrence, partsIn, tick }
};
