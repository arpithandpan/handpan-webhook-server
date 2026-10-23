// ── WHATSAPP SERVICE (student-facing, production number) ──
// Sends approved WhatsApp templates to STUDENTS from the production number
// "Handpan with Arpit" (+91 93801 40907) via Meta's Cloud API, and runs a
// small worker that automates fee links and payment reminders.
//
// This is completely separate from the dashboard-alert WhatsApp setup
// (notify pipeline, test number, WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).
// This file only ever uses the PROD pair below.
//
// Env:
//   WHATSAPP_PROD_TOKEN      – system-user token (handpan-server, never expires)
//   WHATSAPP_PROD_PHONE_ID   – phone number id of +91 93801 40907
//   WA_STUDENT_SENDS         – 'on' to actually send to students.
//                              Anything else = dry-run: the worker logs what
//                              it WOULD send but sends nothing and marks
//                              nothing, so turning it on later picks those
//                              same rows up for real.
//
// How the worker automates fee links:
//   1. Arpit creates a fee request from the dashboard (same as always).
//   2. Every 2 minutes this worker looks for pending fee_requests with
//      wa_sent_at IS NULL, sends the approved 'fee_link' template to the
//      student's phone, and stamps wa_sent_at.
//   3. Still pending after 3 days → one 'payment_reminder' template,
//      stamped in wa_reminder_at.
//   4. Still pending after 7 days → a dashboard notification for Arpit
//      (which the notify pipeline already emails/WhatsApps to him),
//      stamped in wa_escalated_at.
//
// Columns used on fee_requests (added 16 Oct 2026):
//   wa_sent_at, wa_reminder_at, wa_escalated_at  – all timestamptz, null = not done.
//   Old pending rows were backfilled with wa_sent_at = NOW() at migration
//   time so this worker never re-sends requests Arpit already handled by hand.

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const PAY_BASE = 'https://arpitpandey.com/pages/pay?r=';
const TEMPLATE_LANG = 'en';

const TICK_MS = 2 * 60 * 1000;          // worker cadence
const REMINDER_AFTER_MS = 3 * 24 * 60 * 60 * 1000;   // 3 days
const ESCALATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days

// Class reminders: send when the class starts within this window.
// The worker ticks every 2 minutes, so a 65 minute window with a
// once-per-day stamp means exactly one reminder, roughly an hour before.
const CLASS_REMINDER_WINDOW_MIN = 65;
// v3 (Active 22 Oct 2026) adds a "See you there" quick-reply button; a tap
// arrives as a normal inbound message and opens the 24 h window.
// Railway CLASS_REMINDER_TEMPLATE=class_reminder_v2 switches back if needed.
const CLASS_REMINDER_TEMPLATE = (process.env.CLASS_REMINDER_TEMPLATE || 'class_reminder_v3').trim();

// Friendly timezone labels for the reminder text. Anything not listed
// falls back to the raw offset Intl gives us.
const TZ_LABELS = {
  'Asia/Kolkata': 'IST',
  'America/New_York': 'ET',
  'America/Los_Angeles': 'PT',
  'America/Vancouver': 'PT'
};

let supabase = null;
let timer = null;
let ticking = false;

// In-process retry memory: requestId → failed attempts this process life.
// After 3 failed sends we stamp the row anyway (with a warning notification)
// so one bad phone number can never wedge the whole queue.
const failCounts = {};
const MAX_ATTEMPTS = 3;

function init(client) { supabase = client; }

// The WhatsApp agent (agent-service.js) plugs in here, so this file never
// needs to require it: onIncoming(phone, type) for every new incoming
// message, onManualReply(phone, draftId) whenever Arpit sends by hand.
let hooks = {};
function setHooks(h) { hooks = Object.assign({}, hooks, h || {}); }

function configured() {
  return !!(process.env.WHATSAPP_PROD_TOKEN && process.env.WHATSAPP_PROD_PHONE_ID);
}

function studentSendsOn() {
  return String(process.env.WA_STUDENT_SENDS || '').trim().toLowerCase() === 'on';
}

function status() {
  const phoneId = process.env.WHATSAPP_PROD_PHONE_ID || '';
  return {
    configured: configured(),
    studentSends: studentSendsOn() ? 'on' : 'off (dry-run)',
    phoneId: phoneId ? phoneId.slice(0, 4) + '…' + phoneId.slice(-4) : null,
    workerRunning: !!timer
  };
}

// ── PHONE NORMALISATION ──
// WhatsApp wants countrycode+number, digits only, no plus.
// '98765 43210' → '919876543210'; '+91 98765 43210' → same;
// '+1 (305) 555-0123' → '13055550123'. 10 bare digits are assumed Indian.
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) return '91' + d;
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1);
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

// ── MONTH LABEL ('2026-10' → 'October 2026') ──
function monthLong(ym) {
  const m = String(ym || '').match(/^(\d{4})-(\d{2})$/); if (!m) return '';
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return names[Number(m[2]) - 1] + ' ' + m[1];
}

// ── PACKAGE LABEL for {{2}} ──
// '4 classes (October 2026)', '1 class', '12 classes (3 months)…' — whatever
// the fee request says. Month is included when the request has one.
function packageLabel(classes, month) {
  const n = parseInt(classes, 10) || 0;
  const base = n === 1 ? '1 class' : `${n} classes`;
  const ml = monthLong(month);
  return ml ? `${base} (${ml})` : base;
}

// ── SEND ONE TEMPLATE ──
// bodyParams is an array of strings for {{1}}, {{2}}, … in order.
// Returns { ok, id } or { ok:false, error }.
// opts.document = { link, filename } puts a PDF in the template's Document
// header (the template must have been approved with a Document header).
async function sendTemplate(toPhone, templateName, bodyParams, opts) {
  if (!configured()) return { ok: false, error: 'WhatsApp prod env vars missing' };
  const to = normalizePhone(toPhone);
  if (!to) return { ok: false, error: 'No usable phone number' };

  try {
    const res = await fetch(`${GRAPH_BASE}/${process.env.WHATSAPP_PROD_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_PROD_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: TEMPLATE_LANG },
          components: [
            ...(opts && opts.document && opts.document.link ? [{
              type: 'header',
              parameters: [{ type: 'document', document: { link: opts.document.link, filename: opts.document.filename || 'Invoice.pdf' } }]
            }] : []),
            {
              type: 'body',
              parameters: (bodyParams || []).map(t => ({ type: 'text', text: String(t) }))
            }
          ]
        }
      })
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      console.error(`WA send failed (${templateName} → ${to}):`, msg);
      await logOutgoingTemplate(to, templateName, bodyParams, null, msg);
      return { ok: false, error: msg };
    }
    const id = data?.messages?.[0]?.id || null;
    console.log(`WA sent: ${templateName} → ${to} (${id})`);
    await logOutgoingTemplate(to, templateName, bodyParams, id, null);
    return { ok: true, id };
  } catch (e) {
    console.error(`WA send error (${templateName}):`, e.message);
    await logOutgoingTemplate(to, templateName, bodyParams, null, e.message);
    return { ok: false, error: e.message };
  }
}

// ── CONVERSATION LOG (wa_messages) ──
// Every message in and out of the studio number is saved so the dashboard
// can show whole conversations. Logging must never break sending, so all
// of this swallows its own errors.
// Returns 'dup' when Meta re-delivers a message we already have.
async function logMessage(row) {
  try {
    const { error } = await supabase.from('wa_messages').insert(row);
    if (error && /duplicate key/i.test(error.message)) return 'dup';
    if (error) console.error('wa_messages insert failed:', error.message);
  } catch (e) { console.error('wa_messages insert error:', e.message); }
  return 'ok';
}

// Template bodies come from Meta, so the log shows the exact text the
// student saw. Cached for 6 hours; refreshed early (at most every 10 min)
// when a template is missing, e.g. one approved this morning.
let _tplCache = null, _tplAt = 0, _tplTriedAt = 0, _tplApproved = new Set();
async function templateBodies(force) {
  const fresh = _tplCache && Date.now() - _tplAt < 6 * 3600 * 1000;
  if (fresh && !force) return _tplCache;
  if (Date.now() - _tplTriedAt < 10 * 60 * 1000) return _tplCache || {};
  _tplTriedAt = Date.now();
  const waba = process.env.WHATSAPP_PROD_WABA_ID || '1652322909800354';
  try {
    const res = await fetch(`${GRAPH_BASE}/${waba}/message_templates?fields=name,language,components&limit=200`, {
      headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_PROD_TOKEN}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    const map = {};
    const approved = new Set();
    for (const t of (data.data || [])) {
      const body = (t.components || []).find(c => c.type === 'BODY');
      if (body && body.text && (!map[t.name] || t.language === TEMPLATE_LANG)) map[t.name] = body.text;
      if (String(t.status || '').toUpperCase() === 'APPROVED') approved.add(t.name);
    }
    _tplApproved = approved;
    _tplCache = map; _tplAt = Date.now();
  } catch (e) {
    console.error('WA template list fetch failed:', e.message);
  }
  return _tplCache || {};
}

function renderTemplate(text, params) {
  return String(text).replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const v = (params || [])[Number(n) - 1];
    return v == null ? m : String(v);
  });
}

async function logOutgoingTemplate(to, templateName, bodyParams, waId, error) {
  let bodies = await templateBodies();
  if (!bodies[templateName]) bodies = await templateBodies(true);
  const text = bodies[templateName];
  await logMessage({
    direction: 'out',
    phone: to,
    wa_id: waId || null,
    type: 'template',
    template: templateName,
    params: (bodyParams || []).map(String),
    body: text ? renderTemplate(text, bodyParams) : null,
    status: waId ? 'sent' : 'failed',
    status_at: new Date().toISOString(),
    error: error || null
  });
}

// Delivery receipts from Meta: sent → delivered → read, or failed.
// Never move backwards (a late 'delivered' must not undo 'read').
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };
async function applyStatus(st) {
  try {
    const next = String(st.status || '');
    if (!st.id || !next) return;
    const { data: row } = await supabase.from('wa_messages').select('id, status').eq('wa_id', st.id).maybeSingle();
    if (!row) return;
    if (next !== 'failed' && (STATUS_RANK[row.status] || 0) >= (STATUS_RANK[next] || 0)) return;
    const err = next === 'failed' ? (st.errors?.[0]?.title || st.errors?.[0]?.message || 'failed') : null;
    const when = st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString();
    await supabase.from('wa_messages').update({ status: next, status_at: when, ...(err ? { error: err } : {}) }).eq('id', row.id);
  } catch (e) { console.error('WA status update failed:', e.message); }
}

// ── DASHBOARD NOTIFICATION HELPER ──
async function notify(type, message) {
  try {
    await supabase.from('notifications').insert({ type, message, read: false });
  } catch (e) {
    console.error('WA notify insert failed:', e.message);
  }
}

// ── LOAD PENDING REQUESTS + THEIR STUDENTS ──
async function pendingWithStudents(filter) {
  let q = supabase
    .from('fee_requests')
    .select('id, student_id, classes, amount, month, status, wa_sent_at, wa_reminder_at, wa_escalated_at')
    .eq('status', 'pending');
  q = filter(q);
  const { data: reqs, error } = await q.limit(20);
  if (error) { console.error('WA worker query error:', error.message); return []; }
  if (!reqs || !reqs.length) return [];

  const ids = [...new Set(reqs.map(r => r.student_id).filter(Boolean))];
  const { data: students } = await supabase
    .from('students')
    .select('*')
    .in('id', ids);
  const byId = {};
  for (const s of (students || [])) byId[s.id] = s;
  return reqs.map(r => ({ request: r, student: byId[r.student_id] || null }));
}

function firstName(full) {
  return String(full || '').trim().split(/\s+/)[0] || 'there';
}

// ── STAMP A TIMESTAMP COLUMN ON A REQUEST ──
async function stamp(requestId, column) {
  const { error } = await supabase.from('fee_requests')
    .update({ [column]: new Date().toISOString() })
    .eq('id', requestId);
  if (error) console.error(`WA stamp ${column} failed for ${requestId}:`, error.message);
}

// ── HANDLE ONE SEND (shared by fee links and reminders) ──
// Sends the template; on success stamps and notifies. On repeated failure
// stamps anyway with a warning so the queue never wedges.
async function sendForRequest({ request, student }, templateName, stampColumn, okMessage) {
  const label = packageLabel(request.classes, request.month);
  const link = PAY_BASE + encodeURIComponent(request.id);

  if (!student || student.archived) {
    await stamp(request.id, stampColumn);
    await notify('warning', `⚠️ WhatsApp ${templateName} skipped for ${request.id} — student missing or archived. Send manually if needed.`);
    return;
  }
  if (!normalizePhone(student.phone)) {
    await stamp(request.id, stampColumn);
    await notify('warning', `⚠️ WhatsApp ${templateName} skipped for ${student.full_name} (${request.id}) — no usable phone number on file. Send manually.`);
    return;
  }

  if (!studentSendsOn()) {
    // Dry-run: log only, stamp nothing, so these send for real once the
    // switch is turned on.
    console.log(`WA dry-run: would send ${templateName} to ${student.full_name} for ${request.id} (${label})`);
    return;
  }

  const result = await sendToAllPhones(student, templateName, [firstName(student.full_name), label, link]);

  if (result.ok) {
    await stamp(request.id, stampColumn);
    await notify('info', okMessage(student, label));
    return;
  }

  failCounts[request.id + ':' + stampColumn] = (failCounts[request.id + ':' + stampColumn] || 0) + 1;
  if (failCounts[request.id + ':' + stampColumn] >= MAX_ATTEMPTS) {
    await stamp(request.id, stampColumn);
    await notify('warning', `⚠️ WhatsApp ${templateName} to ${student.full_name} (${request.id}) failed ${MAX_ATTEMPTS} times — ${result.error}. Send manually.`);
  }
}

// ── CLASS REMINDERS ──
// class_schedule holds each regular student's weekly slot in IST plus the
// stable join link of their recurring Zoom meeting. About an hour before a
// class, send the class_reminder template with the time written in the
// student's own timezone. reminder_sent_on (a date) guards against the
// 2-minute tick sending twice.
function istParts(d) {
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return { ymd: ist.toISOString().slice(0, 10), weekday: ist.getUTCDay(), hhmm: ist.toISOString().slice(11, 16) };
}

function localTimeLabel(dateUtc, tz) {
  try {
    const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(dateUtc);
    const label = TZ_LABELS[tz];
    if (label) return `${t} ${label}`;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(dateUtc);
    return parts;
  } catch (e) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(dateUtc) + ' IST';
  }
}

// ── TIMEZONE HELPERS ──
// Offset (minutes) of `tz` from UTC at instant `d`. Positive east of UTC.
function tzOffsetMin(d, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}

// Wall-clock date + time in `tz` → the real instant (Date). DST-correct.
function zonedToUtc(ymd, hhmm, tz) {
  const guess = new Date(`${ymd}T${hhmm}:00Z`);
  let off = tzOffsetMin(guess, tz);
  let t = new Date(guess.getTime() - off * 60000);
  const off2 = tzOffsetMin(t, tz);
  if (off2 !== off) t = new Date(guess.getTime() - off2 * 60000);
  return t;
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); }

// ── WEEKLY SCHEDULE → CONCRETE CLASSES ──
// Returns [{ row, utc, istDate, moved }] for classes whose IST date is today
// or tomorrow. Rules:
//  • A row with local_weekday + local_time is anchored to the student's own
//    clock (student_tz), so US classes stay at the same local time across
//    daylight saving and the IST time shifts automatically.
//  • Otherwise the row is anchored to IST (weekday + time_ist), as before.
//  • class_exceptions (by student + original IST date): 'skip' drops the
//    class; 'move' drops it and adds one at new_date + new_time_ist (IST).
async function planScheduleOccurrences(now) {
  const today = istParts(now).ymd;
  const days = [today, addDays(today, 1)];

  const { data: rows, error } = await supabase
    .from('class_schedule')
    .select('id, student_id, weekday, time_ist, local_weekday, local_time, student_tz, zoom_link, active, reminder_sent_on, self_reminder_on')
    .eq('active', true);
  if (error) { console.error('class_schedule query error:', error.message); return []; }
  if (!rows || !rows.length) return [];

  const { data: exRows } = await supabase
    .from('class_exceptions')
    .select('student_id, original_date, action, new_date, new_time_ist')
    .gte('original_date', addDays(today, -14))
    .lte('original_date', addDays(today, 14));
  const { data: movedIn } = await supabase
    .from('class_exceptions')
    .select('student_id, original_date, action, new_date, new_time_ist')
    .eq('action', 'move')
    .in('new_date', days);
  const exKey = {};
  for (const e of (exRows || [])) exKey[e.student_id + '|' + String(e.original_date).slice(0, 10)] = e;

  const out = [];
  for (const row of rows) {
    const tz = row.student_tz || 'Asia/Kolkata';
    const anchoredLocal = row.local_time != null && row.local_weekday != null && tz !== 'Asia/Kolkata';
    const candidates = [];
    if (anchoredLocal) {
      const lt = String(row.local_time).slice(0, 5);
      for (let i = -2; i <= 2; i++) {
        const L = addDays(today, i);
        if (weekdayOf(L) !== Number(row.local_weekday)) continue;
        const utc = zonedToUtc(L, lt, tz);
        candidates.push({ utc, istDate: istParts(utc).ymd });
      }
    } else {
      for (const D of days) {
        if (weekdayOf(D) !== Number(row.weekday)) continue;
        const utc = new Date(`${D}T${String(row.time_ist).slice(0, 5)}:00+05:30`);
        candidates.push({ utc, istDate: D });
      }
    }
    for (const c of candidates) {
      if (!days.includes(c.istDate) || isNaN(c.utc)) continue;
      const ex = exKey[row.student_id + '|' + c.istDate];
      if (ex && (ex.action === 'skip' || ex.action === 'move')) continue;
      out.push({ row, utc: c.utc, istDate: c.istDate, moved: false });
    }
  }

  // Classes moved INTO today/tomorrow (use the student's active row for link/tz).
  for (const e of (movedIn || [])) {
    const row = rows.find(r => r.student_id === e.student_id);
    if (!row || !e.new_time_ist) continue;
    const D = String(e.new_date).slice(0, 10);
    const utc = new Date(`${D}T${String(e.new_time_ist).slice(0, 5)}:00+05:30`);
    if (isNaN(utc)) continue;
    out.push({ row, utc, istDate: D, moved: true });
  }
  return out;
}

// ── ALL PHONES FOR A STUDENT ──
// students.phone is the main number. students.extra_phones (text[], optional)
// holds extra numbers, e.g. both parents of a child. Every student message
// (fee link, payment reminder, class reminder) goes to all of them. A second
// payment is impossible: the pay page shows "already paid" and the server
// rejects it. Duplicates and unusable numbers are dropped.
function allPhones(student) {
  const list = [student.phone].concat(Array.isArray(student.extra_phones) ? student.extra_phones : []);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const n = normalizePhone(raw);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// Send one template to every number of a student. ok if at least one went.
async function sendToAllPhones(student, templateName, params) {
  const phones = allPhones(student);
  if (!phones.length) return { ok: false, error: 'No usable phone number' };
  let ok = false, lastError = '';
  for (const ph of phones) {
    const r = await sendTemplate(ph, templateName, params);
    if (r.ok) ok = true; else lastError = r.error;
  }
  return ok ? { ok: true } : { ok: false, error: lastError };
}

async function processClassReminders() {
  const now = new Date();
  const { ymd, weekday } = istParts(now);

  // Server-created meetings (class_meetings) are the preferred source: they
  // carry the exact date, time and fresh join link, reschedules included.
  // The weekly class_schedule rows with a hand-pasted zoom_link remain as a
  // fallback for any student who has no meeting row today (pre-engine data).
  const studentsWithMeetingToday = new Set();
  let sent = 0;

  const { data: meets } = await supabase
    .from('class_meetings')
    .select('id, student_id, class_date, time_ist, student_tz, join_url, status, reminder_sent_on, self_reminder_on')
    .eq('class_date', ymd);
  for (const m of (meets || [])) {
    studentsWithMeetingToday.add(m.student_id);
    if (m.status !== 'scheduled') continue;
    const hhmm = String(m.time_ist).slice(0, 5);
    const classUtc = new Date(`${ymd}T${hhmm}:00+05:30`);
    if (isNaN(classUtc)) continue;
    const minutesUntil = (classUtc - now) / 60000;
    if (minutesUntil <= 0 || minutesUntil > CLASS_REMINDER_WINDOW_MIN) continue;

    // Arpit's own heads-up, independent of student sends and Meta approvals:
    // one dashboard notification per class, which the alert pipeline already
    // delivers to his WhatsApp and email.
    if (m.self_reminder_on !== ymd) {
      const { data: s0 } = await supabase.from('students').select('full_name').eq('id', m.student_id).maybeSingle();
      await notify('info', `⏰ Upcoming class: ${s0?.full_name || m.student_id} today at ${hhmm} IST (in about ${Math.round(minutesUntil)} min).`);
      await supabase.from('class_meetings').update({ self_reminder_on: ymd }).eq('id', m.id);
    }

    if (m.reminder_sent_on === ymd || !m.join_url) continue;

    const { data: student } = await supabase.from('students')
      .select('*').eq('id', m.student_id).maybeSingle();
    if (!student || student.archived || !normalizePhone(student.phone)) {
      await supabase.from('class_meetings').update({ reminder_sent_on: ymd }).eq('id', m.id);
      await notify('warning', `⚠️ Class reminder skipped for ${student?.full_name || m.student_id} — no usable phone or student missing.`);
      continue;
    }
    const timeLabel = localTimeLabel(classUtc, m.student_tz || 'Asia/Kolkata');
    if (!studentSendsOn()) {
      console.log(`WA dry-run: would send class reminder to ${student.full_name} (${timeLabel}, server meeting)`);
      continue;
    }
    const result = await sendToAllPhones(student, CLASS_REMINDER_TEMPLATE, [firstName(student.full_name), timeLabel, m.join_url]);
    if (result.ok) {
      await supabase.from('class_meetings').update({ reminder_sent_on: ymd }).eq('id', m.id);
      await notify('info', `⏰ Class reminder sent to ${student.full_name} on WhatsApp — today at ${timeLabel}.`);
      sent++;
    } else {
      const key = 'clm:' + m.id + ':' + ymd;
      failCounts[key] = (failCounts[key] || 0) + 1;
      if (failCounts[key] >= MAX_ATTEMPTS) {
        await supabase.from('class_meetings').update({ reminder_sent_on: ymd }).eq('id', m.id);
        await notify('warning', `⚠️ Class reminder to ${student.full_name} failed ${MAX_ATTEMPTS} times — ${result.error}. Remind them manually.`);
      }
    }
  }

  // Weekly schedule (the normal path: each student's permanent Zoom link).
  // planScheduleOccurrences() turns the weekly rows into concrete classes for
  // today and tomorrow (IST), honouring skips/moves in class_exceptions and
  // students whose slot is anchored to their own local time (DST-safe).
  const occ = await planScheduleOccurrences(now);
  for (const o of occ) {
    const row = o.row;
    if (o.istDate === ymd && studentsWithMeetingToday.has(row.student_id)) continue;   // engine row already handled today

    const classUtc = o.utc;
    const minutesUntil = (classUtc - now) / 60000;
    if (minutesUntil <= 0 || minutesUntil > CLASS_REMINDER_WINDOW_MIN) continue;
    const istHHMM = istParts(classUtc).hhmm;
    const stampDay = o.istDate;

    // Arpit's own heads-up (works without Meta approval).
    if (row.self_reminder_on !== stampDay) {
      const { data: s0 } = await supabase.from('students').select('full_name').eq('id', row.student_id).maybeSingle();
      await notify('info', `⏰ Upcoming class: ${s0?.full_name || row.student_id} today at ${istHHMM} IST (in about ${Math.round(minutesUntil)} min)${o.moved ? ' (rescheduled)' : ''}.`);
      await supabase.from('class_schedule').update({ self_reminder_on: stampDay }).eq('id', row.id);
      row.self_reminder_on = stampDay;
    }

    if (row.reminder_sent_on === stampDay) continue;          // already reminded for this class
    if (!row.zoom_link) continue;                             // nothing to send without a link

    const { data: student } = await supabase.from('students')
      .select('*').eq('id', row.student_id).maybeSingle();
    if (!student || student.archived || !normalizePhone(student.phone)) {
      await supabase.from('class_schedule').update({ reminder_sent_on: stampDay }).eq('id', row.id);
      await notify('warning', `⚠️ Class reminder skipped for ${student?.full_name || row.student_id} — no usable phone or student missing.`);
      continue;
    }

    const timeLabel = localTimeLabel(classUtc, row.student_tz || 'Asia/Kolkata');

    if (!studentSendsOn()) {
      console.log(`WA dry-run: would send class reminder to ${student.full_name} (${timeLabel})`);
      continue;
    }

    const result = await sendToAllPhones(student, CLASS_REMINDER_TEMPLATE, [firstName(student.full_name), timeLabel, row.zoom_link]);
    if (result.ok) {
      await supabase.from('class_schedule').update({ reminder_sent_on: stampDay }).eq('id', row.id);
      row.reminder_sent_on = stampDay;
      await notify('info', `⏰ Class reminder sent to ${student.full_name} on WhatsApp — today at ${timeLabel}.`);
      sent++;
    } else {
      const key = 'cls:' + row.id + ':' + stampDay;
      failCounts[key] = (failCounts[key] || 0) + 1;
      if (failCounts[key] >= MAX_ATTEMPTS) {
        await supabase.from('class_schedule').update({ reminder_sent_on: stampDay }).eq('id', row.id);
        await notify('warning', `⚠️ Class reminder to ${student.full_name} failed ${MAX_ATTEMPTS} times — ${result.error}. Remind them manually.`);
      }
    }
  }
  return { reminders: sent };
}

// ── ONE WORKER PASS ──
async function processPending() {
  if (!supabase || !configured()) return { skipped: 'not configured' };

  // 1. New fee requests → fee_link template.
  const fresh = await pendingWithStudents(q => q.is('wa_sent_at', null));
  for (const row of fresh) {
    await sendForRequest(row, 'fee_link', 'wa_sent_at',
      (s, label) => `📲 Fee link sent to ${s.full_name} on WhatsApp — ${label} (${row.request.id})`);
  }

  // 2. Sent 3+ days ago, still pending, no reminder yet → payment_reminder.
  const remindBefore = new Date(Date.now() - REMINDER_AFTER_MS).toISOString();
  const due = await pendingWithStudents(q => q.not('wa_sent_at', 'is', null).is('wa_reminder_at', null).lt('wa_sent_at', remindBefore));
  for (const row of due) {
    await sendForRequest(row, 'payment_reminder', 'wa_reminder_at',
      (s, label) => `🔁 Payment reminder sent to ${s.full_name} on WhatsApp — ${label} (${row.request.id})`);
  }

  // 3. Sent 7+ days ago, still pending → escalate to Arpit once.
  const escalateBefore = new Date(Date.now() - ESCALATE_AFTER_MS).toISOString();
  const stale = await pendingWithStudents(q => q.not('wa_sent_at', 'is', null).is('wa_escalated_at', null).lt('wa_sent_at', escalateBefore));
  for (const { request, student } of stale) {
    await stamp(request.id, 'wa_escalated_at');
    await notify('warning', `⏰ ${student?.full_name || request.student_id}'s fee (${request.id}, ${packageLabel(request.classes, request.month)}) is unpaid 7 days after the WhatsApp link. Might be time for a personal follow-up.`);
  }

  // 4. Class reminders (about an hour before each scheduled class).
  const cls = await processClassReminders();

  return { fresh: fresh.length, reminders: due.length, escalated: stale.length, classReminders: cls.reminders };
}

// ── INCOMING MESSAGES (webhook from Meta) ──
// Students can reply to the studio number. Nobody's phone holds that number,
// so Meta delivers every incoming message here and we surface it as a
// dashboard notification — which the alert pipeline already forwards to
// Arpit's WhatsApp and email. Statuses (sent/delivered/read) are ignored.
//
// Env:
//   WHATSAPP_VERIFY_TOKEN – any secret string; the same value is typed into
//                           the Meta webhook config. Meta sends it back once
//                           during setup to prove the URL is really ours.

// GET: Meta's one-time URL verification handshake.
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

// ── REPLIES FROM THE DASHBOARD ──
// Meta lets a business send free text only within 24 hours of the person's
// last message ("customer service window"). After that only approved
// templates go through; REPLY_TEMPLATE is the one that reopens the chat.
const REPLY_TEMPLATE = process.env.WA_REPLY_TEMPLATE || 'arpit_replied';
const WINDOW_MS = 24 * 60 * 60 * 1000;

async function lastIncomingAt(phone) {
  const { data } = await supabase.from('wa_messages')
    .select('created_at').eq('phone', phone).eq('direction', 'in').neq('type', 'reaction')
    .order('created_at', { ascending: false }).limit(1);
  const t = data && data[0] ? new Date(data[0].created_at).getTime() : 0;
  return isNaN(t) ? 0 : t;
}

async function sendText(toPhone, text) {
  if (!configured()) return { ok: false, error: 'WhatsApp prod env vars missing' };
  const to = normalizePhone(toPhone);
  if (!to) return { ok: false, error: 'No usable phone number' };
  try {
    const res = await fetch(`${GRAPH_BASE}/${process.env.WHATSAPP_PROD_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_PROD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: text } })
    });
    const data = await res.json();
    if (!res.ok) {
      const code = data?.error?.code;
      // 131047 = more than 24 hours since the person's last message
      const msg = code === 131047 ? 'window_closed' : (data?.error?.message || `HTTP ${res.status}`);
      console.error(`WA text failed (→ ${to}):`, data?.error?.message || res.status);
      return { ok: false, error: msg };
    }
    const id = data?.messages?.[0]?.id || null;
    console.log(`WA text sent → ${to} (${id})`);
    return { ok: true, id, to };
  } catch (e) {
    console.error('WA text error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── MEDIA (photos, voice notes, videos, documents) ──
// Meta keeps incoming files only for a while, so each one is copied into the
// private Supabase Storage bucket 'wa-media' as it arrives. Its path goes into
// wa_messages.params.media { path, mime, size, name }. The dashboard asks this
// server for the file (GET /api/wa/media/:waId); the bucket itself stays private.
const MEDIA_BUCKET = 'wa-media';
const MEDIA_MAX = 16 * 1024 * 1024;   // WhatsApp's own limit for audio/video; plenty for photos
let _bucketReady = false;
async function ensureMediaBucket() {
  if (_bucketReady) return;
  try {
    const { error } = await supabase.storage.createBucket(MEDIA_BUCKET, { public: false });
    if (error && !/already exists|duplicate/i.test(error.message)) console.error('wa-media bucket:', error.message);
  } catch (e) { console.error('wa-media bucket error:', e.message); }
  _bucketReady = true;
}
const MEDIA_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf' };
function mediaExt(mime, name) {
  const m = String(mime || '').split(';')[0].trim();
  if (MEDIA_EXT[m]) return MEDIA_EXT[m];
  const n = String(name || '').match(/\.([a-z0-9]{1,5})$/i);
  return n ? n[1].toLowerCase() : 'bin';
}
async function fetchMetaMedia(mediaId) {
  const auth = { 'Authorization': `Bearer ${process.env.WHATSAPP_PROD_TOKEN}` };
  const meta = await (await fetch(`${GRAPH_BASE}/${mediaId}`, { headers: auth })).json();
  if (!meta || !meta.url) throw new Error(meta?.error?.message || 'Meta gave no file link');
  if (Number(meta.file_size) > MEDIA_MAX) throw new Error('file is bigger than 16 MB');
  const r = await fetch(meta.url, { headers: auth });
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, mime: String(meta.mime_type || r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim() };
}
async function storeMedia(waId, buf, mime, name) {
  await ensureMediaBucket();
  const path = new Date().toISOString().slice(0, 7) + '/' + String(waId).replace(/[^A-Za-z0-9._-]/g, '_') + '.' + mediaExt(mime, name);
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, buf, { contentType: mime, upsert: true });
  if (error) throw new Error(error.message);
  return { path, mime, size: buf.length, name: name || null };
}
async function saveIncomingMedia(waId, mediaId, name) {
  try {
    const m = await fetchMetaMedia(mediaId);
    const info = await storeMedia(waId, m.buf, m.mime, name);
    await supabase.from('wa_messages').update({ params: { media: info } }).eq('wa_id', waId);
    return info;
  } catch (e) {
    console.error('WA media save failed (' + waId + '):', e.message);
    return null;
  }
}

// GET /api/wa/media/:waId   (admin only) → the file itself
async function mediaHandler(req, res) {
  try {
    const waId = String(req.params.waId || '');
    const { data } = await supabase.from('wa_messages').select('wa_id, media_id, params').eq('wa_id', waId).limit(1);
    const row = data && data[0];
    if (!row) return res.status(404).json({ error: 'Message not found' });
    let info = row.params && !Array.isArray(row.params) ? row.params.media : null;
    // Arrived before this feature, or the copy failed: try Meta once more.
    if ((!info || !info.path) && row.media_id) info = await saveIncomingMedia(row.wa_id, row.media_id, null);
    if (!info || !info.path) return res.status(410).json({ error: 'This file is no longer available' });
    const { data: blob, error } = await supabase.storage.from(MEDIA_BUCKET).download(info.path);
    if (error || !blob) return res.status(404).json({ error: 'File missing from storage' });
    res.setHeader('Content-Type', info.mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (info.name) res.setHeader('Content-Disposition', 'inline; filename="' + String(info.name).replace(/["\r\n]/g, '') + '"');
    res.send(Buffer.from(await blob.arrayBuffer()));
  } catch (e) {
    console.error('WA media handler error:', e.message);
    res.status(500).json({ error: 'Could not load the file' });
  }
}

// What WhatsApp accepts for each message type. Anything else goes as a document.
function mediaKind(mime) {
  if (mime === 'image/jpeg' || mime === 'image/png') return 'image';
  if (['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'].includes(mime)) return 'audio';
  if (mime === 'video/mp4' || mime === 'video/3gpp') return 'video';
  return 'document';
}

// POST /api/wa/send-media  { phone, name, mime, data (base64), caption }   (admin only)
async function sendMediaHandler(req, res) {
  try {
    if (!configured()) return res.status(503).json({ error: 'WhatsApp is not configured' });
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    const name = String(req.body?.name || 'file').slice(0, 120);
    const mime = String(req.body?.mime || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const caption = String(req.body?.caption || '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
    const buf = Buffer.from(String(req.body?.data || ''), 'base64');
    if (!phone) return res.status(400).json({ error: 'No phone number' });
    if (!buf.length) return res.status(400).json({ error: 'No file attached' });
    if (buf.length > MEDIA_MAX) return res.status(400).json({ error: 'File is bigger than 16 MB' });
    const kind = mediaKind(mime);
    if (kind === 'image' && buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Photos can be up to 5 MB on WhatsApp' });
    const last = await lastIncomingAt(phone);
    if (!last || Date.now() - last > WINDOW_MS) return res.status(409).json({ error: 'window_closed' });
    const to = normalizePhone(phone);
    const auth = { 'Authorization': `Bearer ${process.env.WHATSAPP_PROD_TOKEN}` };
    // 1. Upload the file to Meta
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', mime);
    fd.append('file', new Blob([buf], { type: mime }), name);
    const up = await fetch(`${GRAPH_BASE}/${process.env.WHATSAPP_PROD_PHONE_ID}/media`, { method: 'POST', headers: auth, body: fd });
    const upJ = await up.json();
    if (!up.ok || !upJ.id) return res.status(502).json({ error: upJ?.error?.message || 'Upload to WhatsApp failed' });
    // 2. Send it
    const part = { id: upJ.id };
    if (caption && kind !== 'audio') part.caption = caption;
    if (kind === 'document') part.filename = name;
    const sr = await fetch(`${GRAPH_BASE}/${process.env.WHATSAPP_PROD_PHONE_ID}/messages`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: kind, [kind]: part })
    });
    const sj = await sr.json();
    if (!sr.ok) {
      const code = sj?.error?.code;
      return res.status(code === 131047 ? 409 : 502).json({ error: code === 131047 ? 'window_closed' : (sj?.error?.message || 'Send failed') });
    }
    const waId = sj?.messages?.[0]?.id || null;
    // 3. Keep our own copy so it shows in the dashboard later
    let info = null;
    try { info = await storeMedia(waId || ('out-' + Date.now()), buf, mime, name); } catch (e) { console.error('WA media copy failed:', e.message); }
    const row = {
      direction: 'out', phone: to, wa_id: waId, type: kind, body: caption || (kind === 'document' ? name : null),
      media_id: upJ.id, params: info ? { media: info } : null,
      status: 'sent', status_at: new Date().toISOString(), created_at: new Date().toISOString()
    };
    await logMessage(row);
    console.log(`WA ${kind} sent → ${to} (${waId})`);
    res.json({ ok: true, row });
  } catch (e) {
    console.error('WA send-media error:', e.message);
    res.status(500).json({ error: 'Could not send right now' });
  }
}

// Free-text reply inside the 24-hour window, logged like every other message.
// Used by the reply box and by the agent's "Send draft".
// → { ok, row } or { ok: false, status, error }
async function sendReply(phoneRaw, textRaw) {
  const phone = String(phoneRaw || '').replace(/\D/g, '');
  const text = String(textRaw || '').replace(/\r\n/g, '\n').trim();
  if (!phone) return { ok: false, status: 400, error: 'No phone number' };
  if (!text) return { ok: false, status: 400, error: 'Write a message first' };
  if (text.length > 4000) return { ok: false, status: 400, error: 'Message is too long (max 4,000 characters)' };
  const last = await lastIncomingAt(phone);
  if (!last || Date.now() - last > WINDOW_MS) return { ok: false, status: 409, error: 'window_closed' };
  const r = await sendText(phone, text);
  if (!r.ok) return { ok: false, status: r.error === 'window_closed' ? 409 : 502, error: r.error };
  const row = {
    direction: 'out', phone: r.to, wa_id: r.id, type: 'text', body: text,
    status: 'sent', status_at: new Date().toISOString(), created_at: new Date().toISOString()
  };
  await logMessage(row);
  return { ok: true, row };
}

// POST /api/wa/reply  { phone, text, draftId? }   (admin only)
// draftId: the agent draft Arpit edited before sending, if any.
async function replyHandler(req, res) {
  try {
    const r = await sendReply(req.body?.phone, req.body?.text);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    if (hooks.onManualReply) hooks.onManualReply(r.row.phone, req.body?.draftId || null);
    res.json({ ok: true, row: r.row });
  } catch (e) {
    console.error('WA reply handler error:', e.message);
    res.status(500).json({ error: 'Could not send right now' });
  }
}

// GET /api/wa/reply-template  →  { name, available, body }   (admin only)
async function replyTemplateStatus(req, res) {
  let bodies = await templateBodies();
  if (!_tplApproved.has(REPLY_TEMPLATE)) bodies = await templateBodies(true);
  res.json({ name: REPLY_TEMPLATE, available: _tplApproved.has(REPLY_TEMPLATE), body: bodies[REPLY_TEMPLATE] || null });
}

// POST /api/wa/reopen  { phone, name }   (admin only)
// Sends the approved reply template so the person can answer and reopen
// the 24-hour window.
async function reopenHandler(req, res) {
  try {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'No phone number' });
    await templateBodies();
    if (!_tplApproved.has(REPLY_TEMPLATE)) return res.status(409).json({ error: 'The "' + REPLY_TEMPLATE + '" template is not approved yet' });
    const r = await sendTemplate(phone, REPLY_TEMPLATE, [firstName(req.body?.name || '')]);
    if (!r.ok) return res.status(502).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (e) {
    console.error('WA reopen handler error:', e.message);
    res.status(500).json({ error: 'Could not send right now' });
  }
}

// Find which student a phone number belongs to, for a friendly name.
async function studentByPhone(waPhone) {
  const digits = String(waPhone || '').replace(/\D/g, '');
  if (!digits) return null;
  const { data: students } = await supabase.from('students').select('*');
  for (const s of (students || [])) {
    if (s.archived) continue;
    const nums = [s.phone].concat(Array.isArray(s.extra_phones) ? s.extra_phones : []);
    for (const raw of nums) {
      const p = String(raw || '').replace(/\D/g, '');
      if (!p) continue;
      if (digits.endsWith(p.slice(-10)) || p.endsWith(digits.slice(-10))) return s;
    }
  }
  return null;
}

function describeMessage(msg) {
  if (msg.type === 'text') return msg.text?.body || '';
  if (msg.type === 'button') return msg.button?.text || '[button reply]';
  if (msg.type === 'interactive') return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[interactive reply]';
  if (msg.type === 'image') return '[photo]';
  if (msg.type === 'audio') return '[voice note]';
  if (msg.type === 'video') return '[video]';
  if (msg.type === 'document') return '[document]';
  if (msg.type === 'sticker') return '[sticker]';
  if (msg.type === 'location') return '[location]';
  if (msg.type === 'reaction') return msg.reaction?.emoji ? `reacted ${msg.reaction.emoji}` : 'removed a reaction';
  return '[' + (msg.type || 'message') + ']';
}

// POST: every event for the studio number lands here. Always answer 200
// fast so Meta does not retry; failures become log lines.
async function incomingHandler(req, res) {
  res.sendStatus(200);
  try {
    const body = req.body || {};
    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const contactName = value.contacts?.[0]?.profile?.name || null;
        // Only the studio number's traffic belongs in the conversation log.
        const prodId = process.env.WHATSAPP_PROD_PHONE_ID;
        const isStudio = !prodId || !value.metadata?.phone_number_id || value.metadata.phone_number_id === prodId;
        if (isStudio) for (const st of (value.statuses || [])) await applyStatus(st);
        for (const msg of (value.messages || [])) {
          const from = msg.from;                       // e.g. '919739742036'
          const text = describeMessage(msg);
          const isReaction = msg.type === 'reaction';
          let dup = false;
          const media = msg.image || msg.audio || msg.video || msg.document || msg.sticker || null;
          if (isStudio) {
            dup = (await logMessage({
              direction: 'in',
              phone: String(from || '').replace(/\D/g, ''),
              contact_name: contactName,
              wa_id: msg.id || null,
              type: msg.type || 'text',
              body: isReaction ? null : (msg.type === 'text' ? (msg.text?.body || '') : (media?.caption || text)),
              reaction_to: isReaction ? (msg.reaction?.message_id || null) : null,
              emoji: isReaction ? (msg.reaction?.emoji || '') : null,
              media_id: media?.id || null,
              created_at: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : new Date().toISOString(),
              // A reaction needs no attention, so it never counts as unread.
              read_at: isReaction ? new Date().toISOString() : null
            })) === 'dup';
          }
          if (dup) continue;   // Meta retried a webhook we already handled
          if (isStudio && hooks.onIncoming) {
            try { hooks.onIncoming(String(from || '').replace(/\D/g, ''), msg.type); } catch (e) { console.error('agent hook error:', e.message); }
          }
          // Copy the file now, while Meta still has it. Runs in the background.
          if (isStudio && media && media.id && msg.id) saveIncomingMedia(msg.id, media.id, media.filename || null);
          const student = await studentByPhone(from);
          const who = student ? student.full_name : (contactName ? `${contactName} (+${from})` : '+' + from);
          const preview = String(text).slice(0, 160);
          // A thumbs-up on a reminder is not worth a phone alert. It still
          // shows in the dashboard conversation.
          if (!isReaction) {
            await notify('info', `💬 WhatsApp reply to Handpan with Arpit — ${who}: "${preview}"${String(text).length > 160 ? '…' : ''} Reply in the dashboard (WhatsApp page)`);
          }
          console.log('WA incoming:', who, '-', preview);
        }
      }
    }
  } catch (e) {
    console.error('WA incoming handler error:', e.message);
  }
}

// ── WORKER LOOP ──
function startWorker() {
  if (!configured()) {
    console.log('WhatsApp service: prod env vars missing, worker not started');
    return;
  }
  console.log(`WhatsApp service: worker started (student sends ${studentSendsOn() ? 'ON' : 'off — dry-run'})`);
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await processPending(); }
    catch (e) { console.error('WA worker tick error:', e.message); }
    finally { ticking = false; }
  };
  setTimeout(tick, 15 * 1000);            // first pass shortly after boot
  timer = setInterval(tick, TICK_MS);
}

module.exports = { init, setHooks, sendReply, status, startWorker, processPending, sendTemplate, normalizePhone, verifyWebhook, incomingHandler, replyHandler, replyTemplateStatus, reopenHandler, mediaHandler, sendMediaHandler, _test: { planScheduleOccurrences, zonedToUtc, tzOffsetMin } };
