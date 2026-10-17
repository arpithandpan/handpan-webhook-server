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
const CLASS_REMINDER_TEMPLATE = 'class_reminder_v2';

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
async function sendTemplate(toPhone, templateName, bodyParams) {
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
          components: [{
            type: 'body',
            parameters: (bodyParams || []).map(t => ({ type: 'text', text: String(t) }))
          }]
        }
      })
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      console.error(`WA send failed (${templateName} → ${to}):`, msg);
      return { ok: false, error: msg };
    }
    const id = data?.messages?.[0]?.id || null;
    console.log(`WA sent: ${templateName} → ${to} (${id})`);
    return { ok: true, id };
  } catch (e) {
    console.error(`WA send error (${templateName}):`, e.message);
    return { ok: false, error: e.message };
  }
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
    .select('id, full_name, phone, archived')
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

  const result = await sendTemplate(student.phone, templateName, [firstName(student.full_name), label, link]);

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
  return { ymd: ist.toISOString().slice(0, 10), weekday: ist.getUTCDay() };
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
      .select('id, full_name, phone, archived').eq('id', m.student_id).maybeSingle();
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
    const result = await sendTemplate(student.phone, CLASS_REMINDER_TEMPLATE, [firstName(student.full_name), timeLabel, m.join_url]);
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

  const { data: rows, error } = await supabase
    .from('class_schedule')
    .select('id, student_id, weekday, time_ist, student_tz, zoom_link, active, reminder_sent_on, self_reminder_on')
    .eq('active', true)
    .eq('weekday', weekday);
  if (error) { console.error('class_schedule query error:', error.message); return { reminders: sent }; }
  if (!rows || !rows.length) return { reminders: sent };

  for (const row of rows) {
    if (studentsWithMeetingToday.has(row.student_id)) continue;   // engine row already handled today

    // Today's class moment in UTC, built from the IST date + IST slot time.
    const hhmm = String(row.time_ist).slice(0, 5);
    const classUtc = new Date(`${ymd}T${hhmm}:00+05:30`);
    if (isNaN(classUtc)) continue;
    const minutesUntil = (classUtc - now) / 60000;
    if (minutesUntil <= 0 || minutesUntil > CLASS_REMINDER_WINDOW_MIN) continue;

    // Arpit's own heads-up (works today, no Meta approval needed).
    if (row.self_reminder_on !== ymd) {
      const { data: s0 } = await supabase.from('students').select('full_name').eq('id', row.student_id).maybeSingle();
      await notify('info', `⏰ Upcoming class: ${s0?.full_name || row.student_id} today at ${hhmm} IST (in about ${Math.round(minutesUntil)} min).`);
      await supabase.from('class_schedule').update({ self_reminder_on: ymd }).eq('id', row.id);
    }

    if (row.reminder_sent_on === ymd) continue;              // already reminded today
    if (!row.zoom_link) continue;                             // nothing to send without a link

    const { data: student } = await supabase.from('students')
      .select('id, full_name, phone, archived').eq('id', row.student_id).maybeSingle();
    if (!student || student.archived || !normalizePhone(student.phone)) {
      await supabase.from('class_schedule').update({ reminder_sent_on: ymd }).eq('id', row.id);
      await notify('warning', `⚠️ Class reminder skipped for ${student?.full_name || row.student_id} — no usable phone or student missing.`);
      continue;
    }

    const timeLabel = localTimeLabel(classUtc, row.student_tz || 'Asia/Kolkata');

    if (!studentSendsOn()) {
      console.log(`WA dry-run: would send class reminder to ${student.full_name} (${timeLabel})`);
      continue;
    }

    const result = await sendTemplate(student.phone, CLASS_REMINDER_TEMPLATE, [firstName(student.full_name), timeLabel, row.zoom_link]);
    if (result.ok) {
      await supabase.from('class_schedule').update({ reminder_sent_on: ymd }).eq('id', row.id);
      await notify('info', `⏰ Class reminder sent to ${student.full_name} on WhatsApp — today at ${timeLabel}.`);
      sent++;
    } else {
      const key = 'cls:' + row.id + ':' + ymd;
      failCounts[key] = (failCounts[key] || 0) + 1;
      if (failCounts[key] >= MAX_ATTEMPTS) {
        await supabase.from('class_schedule').update({ reminder_sent_on: ymd }).eq('id', row.id);
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

module.exports = { init, status, startWorker, processPending, sendTemplate, normalizePhone };
