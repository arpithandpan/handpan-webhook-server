// ── MY CLASSES (personal page: arpitpandey.com/my#<token>) ──
// Each person gets one secret link. The page shows their next class with the
// Zoom link, upcoming classes in their own time zone, a pay button when a fee
// link is waiting, and payments with invoices. Students can move or skip a
// class themselves, inside Arpit's rules:
//
//   • At least NOTICE_HOURS before the class.
//   • At most MAX_CHANGES changes per month (move or skip, counted by the
//     month of the original class). Changes Arpit makes in the dashboard
//     never count.
//   • A skipped class can be booked again ("make-up") at any free time until
//     the end of that month. Booking the make-up is not a new change.
//   • A skipped class not made up by month end does not carry over: the
//     worker logs it in class_log ("Skipped, not made up") so it counts.
//
// Everything goes through class_exceptions, the same table the dashboard,
// reminders, Zoom sync and the trial calendar already read. Free times come
// from the trial booking engine (Arpit's windows, minus every class, trial
// and buffer), so a move can never clash with anything.
//
// The link belongs to the person (portal_people), not to one service, so
// workshops and later services can join the same page.
//
// Env:
//   WA_PORTAL_TEMPLATES  – 'on' once class_changed + my_classes_link are approved
//   PORTAL_CHARGE_SKIPS  – 'off' stops the month-end count of un-made-up skips
//   WA_LOGIN_TEMPLATE    – 'on' once the login_code (Authentication) template is approved

const crypto = require('crypto');

let supabase = null, whatsapp = null, trialBooking = null;
function init(client, deps) {
  supabase = client;
  deps = deps || {};
  whatsapp = deps.whatsapp || null;
  trialBooking = deps.trialBooking || null;
}

const NOTICE_HOURS = 12;
const MAX_CHANGES = 2;
const HORIZON_DAYS = 28;
const MOVE_WINDOW_DAYS = 6;
const MOVE_MAX_AHEAD_DAYS = 35;
const SITE = 'https://arpitpandey.com';
const IST = 'Asia/Kolkata';
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.TRIAL_FROM_EMAIL || 'classes@arpitpandey.com';
const ARPIT_EMAIL = process.env.TRIAL_ARPIT_EMAIL || 'arpithandpan@gmail.com';

function templatesOn() { return String(process.env.WA_PORTAL_TEMPLATES || '').trim().toLowerCase() === 'on'; }
function chargeSkipsOn() { return String(process.env.PORTAL_CHARGE_SKIPS || '').trim().toLowerCase() !== 'off'; }

// ── TIME HELPERS ──
function tzOffsetMin(d, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - d.getTime()) / 60000);
}
function zonedToUtc(ymd, hhmm, tz) {
  const guess = new Date(`${ymd}T${hhmm}:00Z`);
  const off = tzOffsetMin(guess, tz);
  let t = new Date(guess.getTime() - off * 60000);
  const off2 = tzOffsetMin(t, tz);
  if (off2 !== off) t = new Date(guess.getTime() - off2 * 60000);
  return t;
}
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekdayOf(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); }
function istYmd(ms) { return new Date(ms + 330 * MIN).toISOString().slice(0, 10); }
function istHhmm(ms) { return new Date(ms + 330 * MIN).toISOString().slice(11, 16); }
function istMs(ymd, hhmm) { return new Date(`${ymd}T${String(hhmm).slice(0, 5)}:00+05:30`).getTime(); }
function monthEnd(ymd) { const d = new Date(ymd.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); }
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } }
function localYmd(ms, tz) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms)); }
function localMinutes(ms, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).split(':');
  return (+p[0]) * 60 + (+p[1]);
}
function tzLabel(tz) {
  if (tz === IST || tz === 'Asia/Calcutta') return 'IST';
  try {
    const n = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName');
    if (n && !/^GMT/.test(n.value)) return n.value;
  } catch (e) { /* fall through */ }
  return String(tz).split('/').pop().replace(/_/g, ' ') + ' time';
}
function tzCity(tz) {
  if (tz === IST || tz === 'Asia/Calcutta') return 'India';
  return String(tz).split('/').pop().replace(/_/g, ' ');
}
// "Mon, 26 Oct, 7:00 PM" in a zone (used in messages).
function prettyIn(ms, tz) {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  return date + ', ' + time;
}
function prettyDate(ymd) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(ymd + 'T00:00:00Z'));
}
function monthName(ymd) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long' }).format(new Date(ymd.slice(0, 7) + '-01T00:00:00Z'));
}
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function linkFor(token) { return SITE + '/my#' + token; }
function last10(s) { return String(s || '').replace(/\D/g, '').slice(-10); }

async function notify(type, message) {
  try { await supabase.from('notifications').insert({ type, message, read: false }); }
  catch (e) { console.error('portal notify failed:', e.message); }
}

// ── PEOPLE + LINKS ──
async function personByToken(token) {
  const t = String(token || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(t)) return null;
  const { data } = await supabase.from('portal_people').select('*').eq('token', t).maybeSingle();
  return data || null;
}

// Get (or make) the link row for a student. reset = new token, old link stops working.
async function linkForStudent(studentId, reset) {
  const { data: s } = await supabase.from('students').select('id, full_name, phone, email').eq('id', studentId).maybeSingle();
  if (!s) return { error: 'Student not found' };
  const { data: existing } = await supabase.from('portal_people').select('*').eq('student_id', studentId).maybeSingle();
  if (existing && !reset) return { token: existing.token, url: linkFor(existing.token) };
  const token = newToken();
  if (existing) {
    const { error } = await supabase.from('portal_people')
      .update({ token, token_reset_at: new Date().toISOString(), name: s.full_name, phone: s.phone, email: s.email }).eq('id', existing.id);
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase.from('portal_people')
      .insert({ token, student_id: s.id, name: s.full_name, phone: s.phone, email: s.email });
    if (error) return { error: error.message };
  }
  return { token, url: linkFor(token) };
}

// ── STUDENT DATA ──
async function loadStudent(studentId) {
  const [st, sch, ex, fp, fr, cl] = await Promise.all([
    supabase.from('students').select('*').eq('id', studentId).maybeSingle(),
    supabase.from('class_schedule').select('*').eq('student_id', studentId).eq('active', true),
    supabase.from('class_exceptions').select('*').eq('student_id', studentId)
      .gte('original_date', addDays(istYmd(Date.now()), -70)),
    supabase.from('fee_payments').select('id, classes, amount, currency, paid, payment_date, month').eq('student_id', studentId),
    supabase.from('fee_requests').select('id, classes, amount, currency, status, month').eq('student_id', studentId).eq('status', 'pending')
      .order('id', { ascending: false }).limit(1),
    supabase.from('class_log').select('id, is_free').eq('student_id', studentId)
  ]);
  if (st.error) throw new Error('students: ' + st.error.message);
  if (sch.error) throw new Error('class_schedule: ' + sch.error.message);
  if (ex.error) throw new Error('class_exceptions: ' + ex.error.message);
  const student = st.data;
  if (!student) return null;
  const rows = sch.data || [];
  const paidRows = (fp.data || []).filter(f => f.paid !== false);
  const paid = paidRows.reduce((a, f) => a + (Number(f.classes) || 0), 0);
  const taken = (cl.data || []).filter(l => !l.is_free).length;
  const tzRow = rows.find(r => r.student_tz && validTz(r.student_tz));
  return {
    student, rows, exceptions: ex.data || [], paidRows,
    left: paid - taken,
    pending: (fr.data || [])[0] || null,
    tz: tzRow ? tzRow.student_tz : IST,
    zoom: (rows.find(r => r.zoom_link) || {}).zoom_link || null
  };
}

// Weekly rows + exceptions → concrete classes between fromMs and toMs.
// key = the original IST date (how class_exceptions names a class).
function buildClasses(ctx, fromMs, toMs) {
  const occ = {};
  const startYmd = addDays(istYmd(fromMs), -3), endYmd = addDays(istYmd(toMs), 3);
  for (const row of ctx.rows) {
    const tz = row.student_tz && validTz(row.student_tz) ? row.student_tz : IST;
    const dur = Number(row.duration_min) || 60;
    const anchoredLocal = row.local_time != null && row.local_weekday != null && tz !== IST;
    for (let d = startYmd; d <= endYmd; d = addDays(d, 1)) {
      let start;
      if (anchoredLocal) {
        if (weekdayOf(d) !== Number(row.local_weekday)) continue;
        start = zonedToUtc(d, String(row.local_time).slice(0, 5), tz).getTime();
      } else {
        if (weekdayOf(d) !== Number(row.weekday)) continue;
        start = istMs(d, row.time_ist);
      }
      if (isNaN(start)) continue;
      const key = istYmd(start);
      occ[key] = { key, start, dur, base: start, moved: false, makeup: false, ex: null };
    }
  }
  for (const ex of ctx.exceptions) {
    const key = String(ex.original_date).slice(0, 10);
    const base = occ[key];
    if (ex.action === 'skip') { delete occ[key]; continue; }
    if (ex.action === 'move' && ex.new_date && ex.new_time_ist) {
      const start = istMs(String(ex.new_date).slice(0, 10), ex.new_time_ist);
      if (isNaN(start)) continue;
      occ[key] = { key, start, dur: base ? base.dur : 60, base: base ? base.base : null, moved: !ex.makeup, makeup: !!ex.makeup, ex };
    }
  }
  return Object.values(occ).filter(o => o.start + o.dur * MIN > fromMs && o.start <= toMs).sort((a, b) => a.start - b.start);
}

function changesUsed(ctx, ym) {
  return ctx.exceptions.filter(e => String(e.original_date).slice(0, 7) === ym)
    .reduce((a, e) => a + (Number(e.student_changes) || 0), 0);
}

function pendingMakeups(ctx, now) {
  const today = istYmd(now);
  return ctx.exceptions
    .filter(e => e.action === 'skip' && Number(e.student_changes) > 0 && !e.charged_at && monthEnd(String(e.original_date).slice(0, 10)) >= today)
    .map(e => ({ key: String(e.original_date).slice(0, 10), deadline: monthEnd(String(e.original_date).slice(0, 10)) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ── PUBLIC: GET /api/my/:token ──
async function dataHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const person = await personByToken(req.params.token);
    if (!person) return res.status(404).json({ ok: false, code: 'bad_link', error: 'This link is not valid any more.' });
    supabase.from('portal_people').update({ last_seen_at: new Date().toISOString() }).eq('id', person.id).then(() => {}, () => {});

    const out = { ok: true, name: firstName(person.name), whatsapp: '919019576583', classes: null };
    if (person.student_id) {
      const ctx = await loadStudent(person.student_id);
      if (ctx && !ctx.student.archived) {
        out.name = firstName(ctx.student.full_name);
        out.classes = await classesView(ctx);
      }
    }
    res.json(out);
  } catch (e) {
    console.error('portal data error:', e.message);
    res.status(500).json({ ok: false, error: 'Could not load your page right now. Please try again in a minute.' });
  }
}

async function classesView(ctx) {
  const now = Date.now();
  const list = buildClasses(ctx, now, now + HORIZON_DAYS * DAY);
  const pending = ctx.pending;
  const months = {};
  const view = list.map((o, i) => {
    const ym = o.key.slice(0, 7);
    if (months[ym] == null) months[ym] = Math.max(0, MAX_CHANGES - changesUsed(ctx, ym));
    return {
      key: o.key, start: new Date(o.start).toISOString(), min: o.dur,
      moved: o.moved, makeup: o.makeup,
      canChange: o.start - now >= NOTICE_HOURS * HOUR,
      later: !!pending && ctx.left >= 0 && i >= ctx.left
    };
  });
  const thisMonth = istYmd(now).slice(0, 7);
  if (months[thisMonth] == null) months[thisMonth] = Math.max(0, MAX_CHANGES - changesUsed(ctx, thisMonth));
  for (const m of pendingMakeups(ctx, now)) {
    const ym = m.key.slice(0, 7);
    if (months[ym] == null) months[ym] = Math.max(0, MAX_CHANGES - changesUsed(ctx, ym));
  }

  // Payments + invoices (newest first).
  const pays = ctx.paidRows.slice().sort((a, b) => String(b.payment_date || '').localeCompare(String(a.payment_date || ''))).slice(0, 6);
  let invByFee = {};
  if (pays.length) {
    const { data: inv } = await supabase.from('invoices').select('id, source_id, cancelled')
      .eq('source_table', 'fee_payments').in('source_id', pays.map(p => p.id));
    for (const r of (inv || [])) if (!r.cancelled) invByFee[r.source_id] = r.id;
  }
  return {
    tz: ctx.tz, tzCity: tzCity(ctx.tz), tzLabel: tzLabel(ctx.tz),
    zoom: ctx.zoom,
    noticeHours: NOTICE_HOURS, maxChanges: MAX_CHANGES,
    changesLeft: months,
    upcoming: view,
    makeups: pendingMakeups(ctx, now),
    left: ctx.left,
    pay: pending ? { id: pending.id, classes: pending.classes, amount: Number(pending.amount), currency: (pending.currency || 'INR').toUpperCase(), url: SITE + '/pages/pay?r=' + encodeURIComponent(pending.id) } : null,
    payments: pays.map(p => ({ date: p.payment_date, amount: Number(p.amount), currency: (p.currency || 'INR').toUpperCase(), classes: p.classes, invoice: invByFee[p.id] || null }))
  };
}

// ── FREE TIMES ──
// mode 'move': within MOVE_WINDOW_DAYS either side of the class's normal
// time (so it stays in about the same week). mode 'makeup': any time until
// the end of the skipped class's month. The class being moved never blocks
// its own move.
async function freeTimes(ctx, mode, key) {
  if (!trialBooking) throw new Error('slot engine missing');
  const settings = await trialBooking.getSettings();
  const now = Date.now();
  const today = istYmd(now);
  let lastYmd = monthEnd(key), lo = -Infinity, hi = Infinity, cur = null;
  if (mode === 'move') {
    cur = buildClasses(ctx, now - DAY, now + 60 * DAY).find(o => o.key === key);
    if (!cur) return [];
    const anchor = cur.base != null ? cur.base : cur.start;
    lo = anchor - MOVE_WINDOW_DAYS * DAY; hi = anchor + MOVE_WINDOW_DAYS * DAY;
    lastYmd = istYmd(Math.min(hi, now + MOVE_MAX_AHEAD_DAYS * DAY));
  }
  if (lastYmd < today) return [];
  const daysAhead = Math.max(0, Math.round((new Date(lastYmd + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / DAY));
  const s = { ...settings, days_ahead: daysAhead, min_notice_hours: Math.max(NOTICE_HOURS, settings.min_notice_hours) };
  let busy = await trialBooking.busyIntervals(now, now + (daysAhead + 2) * DAY);
  if (cur) {
    busy = busy.filter(b => !(Math.abs(b.s - cur.start) < MIN && String(b.what || '').endsWith(' ' + ctx.student.id)));
  }
  const len = 60;
  const slots = trialBooking._test.computeSlots(s, busy, now, len);
  const [ds, de] = Array.isArray(settings.booker_day) ? settings.booker_day : [420, 1380];
  return slots.filter(t => {
    if (istYmd(t) > lastYmd || t < lo || t > hi) return false;
    const m = localMinutes(t, ctx.tz);
    return m >= ds && m + len <= de;
  });
}

async function ctxForToken(token) {
  const person = await personByToken(token);
  if (!person || !person.student_id) return null;
  const ctx = await loadStudent(person.student_id);
  if (!ctx || ctx.student.archived) return null;
  return ctx;
}

// GET /api/my/:token/times?mode=move|makeup&key=YYYY-MM-DD
async function timesHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const ctx = await ctxForToken(req.params.token);
    if (!ctx) return res.status(404).json({ ok: false, error: 'This link is not valid any more.' });
    const mode = req.query.mode === 'makeup' ? 'makeup' : 'move';
    const key = String(req.query.key || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return res.status(400).json({ ok: false, error: 'Pick a class first.' });
    const slots = await freeTimes(ctx, mode, key);
    res.json({ ok: true, slots: slots.map(t => new Date(t).toISOString()) });
  } catch (e) {
    console.error('portal times error:', e.message);
    res.status(500).json({ ok: false, error: 'Could not load free times right now. Please try again in a minute.' });
  }
}

// ── CHANGES ──
async function upsertException(studentId, key, fields) {
  const { data: rows } = await supabase.from('class_exceptions').select('*')
    .eq('student_id', studentId).eq('original_date', key).order('id', { ascending: false });
  const existing = (rows || [])[0];
  const stamp = { updated_at: new Date().toISOString() };
  if (existing) {
    const { error } = await supabase.from('class_exceptions').update({ ...fields, ...stamp }).eq('id', existing.id);
    if (error) throw new Error(error.message);
    return existing;
  }
  const { error } = await supabase.from('class_exceptions').insert({ student_id: studentId, original_date: key, ...fields, ...stamp });
  if (error) throw new Error(error.message);
  return null;
}

// POST /api/my/:token/change  { action: 'move'|'skip'|'makeup', key, start? }
async function changeHandler(req, res) {
  try {
    const ctx = await ctxForToken(req.params.token);
    if (!ctx) return res.status(404).json({ ok: false, error: 'This link is not valid any more.' });
    const b = req.body || {};
    const action = String(b.action || '');
    const key = String(b.key || '');
    if (!['move', 'skip', 'makeup'].includes(action) || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      return res.status(400).json({ ok: false, error: 'Something was missing. Please try again.' });
    }
    const now = Date.now();
    const sid = ctx.student.id;
    const name = ctx.student.full_name || sid;
    const tz = ctx.tz;
    const existing = ctx.exceptions.find(e => String(e.original_date).slice(0, 10) === key) || null;
    const prevChanges = existing ? (Number(existing.student_changes) || 0) : 0;

    let was = null, nowText = null, arpitText = null, newStart = null;

    if (action === 'makeup') {
      const m = pendingMakeups(ctx, now).find(x => x.key === key);
      if (!m) return res.status(409).json({ ok: false, error: 'This class has no make-up to book.' });
      newStart = new Date(String(b.start || '')).getTime();
      const free = await freeTimes(ctx, 'makeup', key);
      if (isNaN(newStart) || !free.includes(newStart)) return res.status(409).json({ ok: false, code: 'taken', error: 'Sorry, that time was just taken. Please pick another one.' });
      await upsertException(sid, key, { action: 'move', new_date: istYmd(newStart), new_time_ist: istHhmm(newStart), makeup: true, student_changes: prevChanges });
      was = 'Skipped class from ' + prettyDate(key);
      nowText = prettyIn(newStart, tz) + ' (' + tzLabel(tz) + ')';
      arpitText = `🔁 ${name} booked a make-up via My classes: ${prettyIn(newStart, IST)} IST (${prettyIn(newStart, tz)} their time), for the class skipped on ${prettyDate(key)}.`;
    } else {
      const cur = buildClasses(ctx, now - DAY, now + 60 * DAY).find(o => o.key === key);
      if (!cur) return res.status(409).json({ ok: false, error: 'That class is not on your schedule any more.' });
      if (cur.start - now < NOTICE_HOURS * HOUR) {
        return res.status(409).json({ ok: false, code: 'too_late', error: `Changes need at least ${NOTICE_HOURS} hours notice. Please message Arpit on WhatsApp.` });
      }
      const ym = key.slice(0, 7);
      if (changesUsed(ctx, ym) >= MAX_CHANGES) {
        return res.status(409).json({ ok: false, code: 'limit', error: `You've used both changes for ${monthName(key)}. Please message Arpit on WhatsApp.` });
      }
      was = prettyIn(cur.start, tz) + ' (' + tzLabel(tz) + ')';
      if (action === 'move') {
        newStart = new Date(String(b.start || '')).getTime();
        const free = await freeTimes(ctx, 'move', key);
        if (isNaN(newStart) || !free.includes(newStart)) return res.status(409).json({ ok: false, code: 'taken', error: 'Sorry, that time was just taken. Please pick another one.' });
        await upsertException(sid, key, { action: 'move', new_date: istYmd(newStart), new_time_ist: istHhmm(newStart), makeup: !!cur.makeup, student_changes: prevChanges + 1 });
        nowText = prettyIn(newStart, tz) + ' (' + tzLabel(tz) + ')';
        arpitText = `📅 ${name} moved a class via My classes: ${prettyIn(cur.start, IST)} IST → ${prettyIn(newStart, IST)} IST (${prettyIn(newStart, tz)} their time).`;
      } else {
        await upsertException(sid, key, { action: 'skip', new_date: null, new_time_ist: null, makeup: false, student_changes: prevChanges + 1 });
        const deadline = prettyDate(monthEnd(key));
        nowText = 'Skipped. You can pick a make-up time until ' + deadline;
        arpitText = `⏸️ ${name} skipped a class via My classes: ${prettyIn(cur.start, IST)} IST. They can book a make-up until ${deadline}.`;
      }
    }

    await notify('info', arpitText);
    const sent = await confirmToStudent(ctx, req.params.token, was, nowText);
    res.json({ ok: true, sent });
  } catch (e) {
    console.error('portal change error:', e.message);
    res.status(500).json({ ok: false, error: 'Could not save that change. Please try again, or message Arpit on WhatsApp.' });
  }
}

async function confirmToStudent(ctx, token, was, nowText) {
  const s = ctx.student;
  const out = { whatsapp: false, email: false };
  if (templatesOn() && whatsapp && s.phone) {
    const r = await whatsapp.sendTemplate(s.phone, 'class_changed', [firstName(s.full_name), was, nowText]).catch(() => null);
    out.whatsapp = !!(r && r.ok);
  }
  if (s.email) {
    const r = await sendMail({
      to: s.email,
      subject: 'Your handpan class was changed',
      html: mailShell(`
        <h1 style="margin:0 0 14px;font-size:20px;color:#500018;font-weight:600;">Done, ${esc(firstName(s.full_name))}</h1>
        <p style="margin:0 0 6px;"><strong style="color:#500018;">Was:</strong> ${esc(was)}</p>
        <p style="margin:0 0 18px;"><strong style="color:#500018;">Now:</strong> ${esc(nowText)}</p>
        <p style="margin:0 0 20px;line-height:1.6;">Your Zoom link stays the same.</p>
        <p style="margin:0;"><a href="${esc(linkFor(token))}" style="display:inline-block;background:#500018;color:#F5EEE5;text-decoration:none;padding:12px 22px;border-radius:40px;font-weight:600;">Open My classes</a></p>`),
      text: `Your handpan class was changed. Was: ${was}. Now: ${nowText}. Your Zoom link stays the same. My classes: ${linkFor(token)}`
    }).catch(() => ({ ok: false }));
    out.email = !!r.ok;
  }
  return out;
}

// ── PUBLIC: POST /api/my/request-link { contact } ──
// Always answers the same way, so nobody can test which numbers are students.
const _reqHits = new Map();
// Minutes until `key` may try again (0 = now).
function waitMinutes(key, max, windowMs) {
  const list = (_reqHits.get(key) || []).filter(t => Date.now() - t < windowMs);
  if (list.length < max) return 0;
  return Math.max(1, Math.ceil((list[0] + windowMs - Date.now()) / 60000));
}
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const list = (_reqHits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { _reqHits.set(key, list); return true; }
  list.push(now); _reqHits.set(key, list);
  return false;
}

async function requestLinkHandler(req, res) {
  const generic = { ok: true };
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const raw = String((req.body || {}).contact || '').trim().slice(0, 120);
    if (!raw) return res.status(400).json({ ok: false, error: 'Please enter your phone number or email.' });
    const isMail = raw.includes('@');
    const key = isMail ? raw.toLowerCase() : last10(raw);
    if (!isMail && key.length < 7) return res.status(400).json({ ok: false, error: 'Please enter a valid phone number or email.' });
    if (tooMany('ip:' + ip, 10, HOUR) || tooMany('c:' + key, 3, HOUR)) {
      return res.status(429).json({ ok: false, error: 'Too many tries. Please wait a while and try again.' });
    }

    const { data: students } = await supabase.from('students').select('id, full_name, phone, extra_phones, email, archived');
    const match = (students || []).find(s => {
      if (s.archived) return false;
      if (isMail) return String(s.email || '').trim().toLowerCase() === key;
      const phones = [s.phone].concat(Array.isArray(s.extra_phones) ? s.extra_phones : []);
      return phones.some(p => last10(p) && last10(p) === key);
    });
    if (!match) { res.json(generic); return; }

    const link = await linkForStudent(match.id, false);
    if (link.error) { console.error('portal link error:', link.error); res.json(generic); return; }

    let waOk = false, mailOk = false;
    if (templatesOn() && whatsapp) {
      const phones = isMail ? [match.phone] : [match.phone].concat(match.extra_phones || []).filter(p => last10(p) === key);
      for (const p of phones.filter(Boolean)) {
        const r = await whatsapp.sendTemplate(p, 'my_classes_link', [firstName(match.full_name), link.url]).catch(() => null);
        if (r && r.ok) waOk = true;
      }
    }
    if (match.email) {
      const r = await sendMail({
        to: match.email,
        subject: 'Your My classes link',
        html: mailShell(`
          <h1 style="margin:0 0 14px;font-size:20px;color:#500018;font-weight:600;">Hi ${esc(firstName(match.full_name))}</h1>
          <p style="margin:0 0 20px;line-height:1.6;">Here is your personal link. It has your schedule, Zoom link and payments, and you can move a class from there.</p>
          <p style="margin:0 0 20px;"><a href="${esc(link.url)}" style="display:inline-block;background:#500018;color:#F5EEE5;text-decoration:none;padding:12px 22px;border-radius:40px;font-weight:600;">Open My classes</a></p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#6B5150;">This link is just for you, so please don't share it.</p>`),
        text: `Hi ${firstName(match.full_name)}, here is your My classes link: ${link.url} (just for you, please don't share it).`
      }).catch(() => ({ ok: false }));
      mailOk = !!r.ok;
    }
    if (!waOk && !mailOk) {
      await notify('warning', `🔗 ${match.full_name} asked for their My classes link, but it could not be sent automatically. Copy it from their row on the Students page and send it.`);
    }
    res.json(generic);
  } catch (e) {
    console.error('portal request-link error:', e.message);
    res.json(generic);
  }
}

// ── LOGIN CODE (6 digits, WhatsApp + email) ──
// POST /api/my/request-code { contact }  → always { ok, resendIn }
// POST /api/my/verify-code  { contact, code } → { ok, token } or { ok:false, left }
// Codes live in memory for 10 minutes (a restart only means "send again").
// A contact that matches nobody still gets a code record (with a random
// code nobody knows), so the page behaves the same either way and nobody
// can test which numbers belong to students. Only a hash of the code is kept.
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_TRIES = 5;
const CODE_RESEND_S = 30;
const _codes = new Map();   // contactKey → { hash, token, exp, tries, sentAt }

function loginTemplateOn() { return String(process.env.WA_LOGIN_TEMPLATE || '').trim().toLowerCase() === 'on'; }
function contactKey(raw) {
  const v = String(raw || '').trim().slice(0, 120);
  if (!v) return null;
  if (v.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? { key: v.toLowerCase(), mail: true } : null;
  const d = last10(v);
  return d.length >= 7 ? { key: d, mail: false } : null;
}
function hashCode(key, code) { return crypto.createHash('sha256').update(key + '|' + code).digest('hex'); }

async function findStudent(c) {
  const { data: students } = await supabase.from('students').select('id, full_name, phone, extra_phones, email, archived');
  return (students || []).find(s => {
    if (s.archived) return false;
    if (c.mail) return String(s.email || '').trim().toLowerCase() === c.key;
    const phones = [s.phone].concat(Array.isArray(s.extra_phones) ? s.extra_phones : []);
    return phones.some(p => last10(p) && last10(p) === c.key);
  }) || null;
}

// WhatsApp Authentication template: body "{{1}} is your verification code"
// plus a Copy code button, both carrying the code.
async function sendLoginCodeWa(phone, code) {
  const to = whatsapp && whatsapp.normalizePhone ? whatsapp.normalizePhone(phone) : String(phone || '').replace(/\D/g, '');
  if (!to || !process.env.WHATSAPP_PROD_TOKEN || !process.env.WHATSAPP_PROD_PHONE_ID) return { ok: false };
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + process.env.WHATSAPP_PROD_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.WHATSAPP_PROD_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: 'login_code', language: { code: 'en' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }
          ]
        }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('login code WA failed:', j && j.error && j.error.message); return { ok: false }; }
    return { ok: true };
  } catch (e) { console.error('login code WA error:', e.message); return { ok: false }; }
}

async function requestCodeHandler(req, res) {
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const c = contactKey((req.body || {}).contact);
    if (!c) return res.status(400).json({ ok: false, error: 'Please enter a valid phone number or email.' });
    const prev = _codes.get(c.key);
    if (prev && Date.now() - prev.sentAt < CODE_RESEND_S * 1000) {
      return res.json({ ok: true, resendIn: Math.ceil((CODE_RESEND_S * 1000 - (Date.now() - prev.sentAt)) / 1000) });
    }
    if (tooMany('ip:' + ip, 10, HOUR) || tooMany('c:' + c.key, 5, HOUR)) {
      const mins = Math.max(waitMinutes('ip:' + ip, 10, HOUR), waitMinutes('c:' + c.key, 5, HOUR)) || 60;
      return res.status(429).json({ ok: false, code: 'limit', retryMin: mins,
        error: 'Too many codes asked for. You can ask for a new one in ' + mins + (mins === 1 ? ' minute.' : ' minutes.') });
    }
    for (const [k, v] of _codes) if (Date.now() > v.exp) _codes.delete(k);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const match = await findStudent(c);
    let token = null;
    if (match) {
      const link = await linkForStudent(match.id, false);
      if (!link.error) token = link.token;
    }
    _codes.set(c.key, { hash: hashCode(c.key, code), token, exp: Date.now() + CODE_TTL_MS, tries: 0, sentAt: Date.now() });
    res.json({ ok: true, resendIn: CODE_RESEND_S });

    if (!match || !token) return;
    let waOk = false, mailOk = false;
    if (loginTemplateOn()) {
      const phones = c.mail ? [match.phone] : [match.phone].concat(match.extra_phones || []).filter(p => last10(p) === c.key);
      for (const p of phones.filter(Boolean)) { const r = await sendLoginCodeWa(p, code); if (r.ok) waOk = true; }
    }
    if (match.email) {
      const url = linkFor(token);
      const r = await sendMail({
        to: match.email,
        subject: code + ' is your login code',
        html: mailShell(`
          <p style="margin:0 0 8px;">Hi ${esc(firstName(match.full_name))}, your login code is</p>
          <p style="margin:0 0 18px;font-size:34px;letter-spacing:8px;font-weight:700;color:#500018;">${code}</p>
          <p style="margin:0 0 20px;line-height:1.6;">It works for 10 minutes. Or just tap the button to log in.</p>
          <p style="margin:0 0 20px;"><a href="${esc(url)}" style="display:inline-block;background:#500018;color:#F5EEE5;text-decoration:none;padding:12px 22px;border-radius:40px;font-weight:600;">Log in</a></p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#6B5150;">Didn't ask for this? You can ignore this email.</p>`),
        text: `Your login code is ${code}. It works for 10 minutes. Or log in here: ${url}`
      }).catch(() => ({ ok: false }));
      mailOk = !!r.ok;
    }
    if (!waOk && !mailOk) {
      await notify('warning', `🔗 ${match.full_name} tried to log in, but the code could not be sent (no email on file${loginTemplateOn() ? ' and WhatsApp failed' : ', WhatsApp login code is off'}). Copy their My classes link from the Students page and send it.`);
    }
  } catch (e) {
    console.error('portal request-code error:', e.message);
    if (!res.headersSent) res.json({ ok: true, resendIn: CODE_RESEND_S });
  }
}

async function verifyCodeHandler(req, res) {
  try {
    const c = contactKey((req.body || {}).contact);
    const code = String((req.body || {}).code || '').replace(/\D/g, '');
    if (!c || code.length !== 6) return res.status(400).json({ ok: false, error: 'Please enter the 6-digit code.' });
    const rec = _codes.get(c.key);
    if (!rec || Date.now() > rec.exp) { _codes.delete(c.key); return res.status(410).json({ ok: false, code: 'expired', error: 'This code has expired. Please send a new one.' }); }
    if (rec.tries >= CODE_MAX_TRIES) return res.status(429).json({ ok: false, code: 'locked', error: 'Too many wrong tries. Please send a new code.' });
    const a = Buffer.from(rec.hash), b = Buffer.from(hashCode(c.key, code));
    if (rec.token && a.length === b.length && crypto.timingSafeEqual(a, b)) {
      _codes.delete(c.key);
      return res.json({ ok: true, token: rec.token });
    }
    rec.tries++;
    const left = CODE_MAX_TRIES - rec.tries;
    if (left <= 0) return res.status(429).json({ ok: false, code: 'locked', error: 'Too many wrong tries. Please send a new code.' });
    res.status(401).json({ ok: false, code: 'wrong', left, error: `That code didn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.` });
  } catch (e) {
    console.error('portal verify-code error:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
}

// ── PUBLIC: GET /api/my/:token/invoice/:id ── (only the person's own invoices)
async function invoiceHandler(req, res, deps) {
  try {
    const ctx = await ctxForToken(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'Not found' });
    const { data: row } = await supabase.from('invoices').select('*').eq('id', req.params.id).maybeSingle();
    const mine = row && row.source_table === 'fee_payments' && !row.cancelled && ctx.paidRows.some(p => p.id === row.source_id);
    if (!mine) return res.status(404).json({ error: 'Not found' });
    const { pdf } = await deps.getPdf(supabase, row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + deps.pdfFilename(row) + '"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  } catch (e) {
    console.error('portal invoice error:', e.message);
    res.status(500).json({ error: 'Could not open the invoice right now' });
  }
}

// ── ADMIN: POST /api/portal/link { studentId, reset } ──
async function adminLinkHandler(req, res) {
  try {
    const b = req.body || {};
    const r = await linkForStudent(String(b.studentId || ''), !!b.reset);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true, url: r.url });
  } catch (e) {
    console.error('portal admin link error:', e.message);
    res.status(500).json({ error: 'Could not make the link' });
  }
}

// ── MAIL ──
async function sendMail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Arpit Pandey <' + FROM_EMAIL + '>', to: [to], subject, html, text, reply_to: ARPIT_EMAIL })
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); return { ok: false, error: j.message || ('HTTP ' + r.status) }; }
  return { ok: true };
}
function mailShell(inner) {
  return `<div style="background:#F5EEE5;padding:28px 16px;font-family:Helvetica,Arial,sans-serif;color:#5A4645;">
  <div style="max-width:520px;margin:0 auto;background:#FFFDFA;border-radius:16px;padding:28px 24px;">
  ${inner}
  <p style="margin:28px 0 0;font-size:13px;color:#6B5150;">Arpit Pandey · Handpan artist and teacher<br>
  <a href="https://arpitpandey.com" style="color:#500018;">arpitpandey.com</a></p>
  </div></div>`;
}

// ── WORKER: month end ──
// A skip the student made, with no make-up booked by the end of that month,
// is counted as a class (class_log), so it doesn't carry over.
let _timer = null, _busy = false;
async function tick() {
  if (_busy || !supabase || !chargeSkipsOn()) return;
  _busy = true;
  try {
    const monthStart = istYmd(Date.now()).slice(0, 7) + '-01';
    const { data: rows, error } = await supabase.from('class_exceptions').select('*')
      .eq('action', 'skip').gt('student_changes', 0).is('charged_at', null).lt('original_date', monthStart);
    if (error) throw new Error(error.message);
    for (const ex of (rows || [])) {
      const day = String(ex.original_date).slice(0, 10);
      const { error: logErr } = await supabase.from('class_log').insert({
        student_id: ex.student_id, class_date: day, is_free: false, source: 'portal',
        note: 'Skipped, not made up (My classes)'
      });
      if (logErr && logErr.code !== '23505') { console.error('portal charge log failed:', ex.student_id, logErr.message); continue; }
      await supabase.from('class_exceptions').update({ charged_at: new Date().toISOString() }).eq('id', ex.id);
      const { data: s } = await supabase.from('students').select('full_name').eq('id', ex.student_id).maybeSingle();
      await notify('info', `🧾 ${(s && s.full_name) || ex.student_id} skipped the ${prettyDate(day)} class and didn't book a make-up, so it was counted as taken. Delete that class log entry if you want to let it go.`);
    }
  } catch (e) { console.error('portal worker error:', e.message); }
  finally { _busy = false; }
}
function startWorker() {
  if (_timer) return;
  setTimeout(tick, 60 * 1000);
  _timer = setInterval(tick, 30 * 60 * 1000);
  console.log('My classes worker started (WhatsApp ' + (templatesOn() ? 'on' : 'off, email only') + ', login code on WhatsApp ' + (loginTemplateOn() ? 'on' : 'off') + ')');
}

module.exports = {
  init, startWorker, dataHandler, timesHandler, changeHandler, requestLinkHandler, requestCodeHandler, verifyCodeHandler, invoiceHandler, adminLinkHandler, linkForStudent,
  _test: { _codes, buildClasses, changesUsed, pendingMakeups, monthEnd, freeTimes, loadStudent, tick, tooMany, _reqHits }
};
