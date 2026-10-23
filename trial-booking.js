// ── TRIAL BOOKING (public trial page → Zoom + emails + Arpit's calendar) ──
// People from ads open arpitpandey.com/pages/trial, pick a free slot shown in
// their own time zone, and book a free 45 minute trial. This module owns:
//
//   1. Booking settings (app_settings row 'trial_booking', edited from the
//      dashboard). Every rule below is a setting with a safe default.
//   2. The slot engine. One function decides which start times are free:
//      Mon to Fri only, inside Arpit's IST windows, never clashing with a
//      weekly class (DST-correct for US students), a skip/move exception, a
//      booked trial or a blocked date, with a buffer around everything, at
//      least N hours ahead, at most N days ahead, and never leaving Arpit
//      less than `rest_hours` between a late night and an early morning.
//      Phase 2 (plan picker, move page) reuses this same engine.
//   3. POST /api/trial/book: re-checks the slot on the server, enforces one
//      trial per person, inserts the trial (a unique index on start_at is the
//      double-booking lock), creates the Zoom meeting, emails the person and
//      Arpit a calendar invite (.ics), WhatsApps the person when the template
//      is approved, and alerts Arpit.
//   4. A small worker: reminder email 1 hour before, and marks trials nobody
//      joined as no-show so the dashboard stays honest.
//
// Env:
//   RESEND_API_KEY            – already set (invoices, alerts)
//   TRIAL_FROM_EMAIL          – default classes@arpitpandey.com (domain is verified in Resend)
//   TRIAL_ARPIT_EMAIL         – default arpithandpan@gmail.com (gets the calendar invite)
//   WA_TRIAL_TEMPLATES        – 'on' once trial_confirmation + trial_reminder are approved

const crypto = require('crypto');

let supabase = null;
let whatsapp = null;
let zoomApi = null;
let notifyFn = null;

function init(client, deps) {
  supabase = client;
  deps = deps || {};
  whatsapp = deps.whatsapp || null;
  zoomApi = deps.zoomApi || null;
  notifyFn = deps.notify || null;
}

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.TRIAL_FROM_EMAIL || 'classes@arpitpandey.com';
const ARPIT_EMAIL = process.env.TRIAL_ARPIT_EMAIL || 'arpithandpan@gmail.com';
const HOST_EMAIL = process.env.ZOOM_HOST_EMAIL || 'arpithandpan@gmail.com';
const IST = 'Asia/Kolkata';

function waTemplatesOn() {
  return String(process.env.WA_TRIAL_TEMPLATES || '').trim().toLowerCase() === 'on';
}

// ── 1. SETTINGS ──
// Times are minutes after midnight IST of the window's own day. An evening
// window may run past midnight (1500 = 1:00 AM next day); it still belongs to
// the weekday it started on, so Friday 7 PM to Saturday 1 AM is a Friday window.
const DEFAULTS = {
  enabled: true,
  weekdays: [1, 2, 3, 4, 5],                 // 0 = Sunday
  windows: [[360, 540], [1140, 1500]],        // 6–9 AM, 7 PM–1 AM IST
  class_min: 60,
  trial_min: 45,
  buffer_min: 15,
  days_ahead: 14,
  min_notice_hours: 12,
  rest_hours: 7,                              // minimum gap across a night
  booker_day: [420, 1380],                    // slot must sit 7 AM–11 PM in the booker's own time
  price_inr: 1500,
  price_usd: 18,
  whatsapp: '919019576583',
  blocked_dates: []                           // ['2026-12-25', …] IST dates with no slots at all
};

let _settingsCache = null, _settingsAt = 0;
async function getSettings(force) {
  if (!force && _settingsCache && Date.now() - _settingsAt < 60 * 1000) return _settingsCache;
  let stored = {};
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'trial_booking').maybeSingle();
    if (data && data.value && typeof data.value === 'object') stored = data.value;
  } catch (e) { console.error('trial settings read failed:', e.message); }
  _settingsCache = sanitizeSettings(stored);
  _settingsAt = Date.now();
  return _settingsCache;
}

// Anything odd in the stored row falls back to the default for that field,
// so a typo in the dashboard can never take the page down.
function sanitizeSettings(raw) {
  const s = { ...DEFAULTS };
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
  if (Array.isArray(raw.weekdays)) {
    const w = [...new Set(raw.weekdays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (w.length) s.weekdays = w;
  }
  if (Array.isArray(raw.windows)) {
    const w = raw.windows
      .map(p => Array.isArray(p) ? [num(p[0], 0, 1439), num(p[1], 1, 1800)] : [null, null])
      .filter(p => p[0] != null && p[1] != null && p[1] > p[0]);
    if (w.length) s.windows = w.sort((a, b) => a[0] - b[0]);
  }
  for (const [k, lo, hi] of [['class_min', 15, 240], ['trial_min', 15, 180], ['buffer_min', 0, 120],
    ['days_ahead', 1, 60], ['min_notice_hours', 0, 168], ['rest_hours', 0, 12],
    ['price_inr', 0, 1e6], ['price_usd', 0, 1e5]]) {
    const n = num(raw[k], lo, hi); if (n != null) s[k] = n;
  }
  if (Array.isArray(raw.booker_day) && raw.booker_day.length === 2) {
    const a = num(raw.booker_day[0], 0, 1439), b = num(raw.booker_day[1], 1, 1440);
    if (a != null && b != null && b > a) s.booker_day = [a, b];
  }
  if (typeof raw.whatsapp === 'string' && /^\d{8,15}$/.test(raw.whatsapp.trim())) s.whatsapp = raw.whatsapp.trim();
  if (Array.isArray(raw.blocked_dates)) s.blocked_dates = raw.blocked_dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d)));
  return s;
}

// ── 2. TIME HELPERS ──
function tzOffsetMin(d, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}
function zonedToUtc(ymd, hhmm, tz) {
  const guess = new Date(`${ymd}T${hhmm}:00Z`);
  const off = tzOffsetMin(guess, tz);
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
function istYmd(d) { return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10); }
function istMidnight(ymd) { return new Date(ymd + 'T00:00:00+05:30').getTime(); }
const MIN = 60000;

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

// "Mon 20 Oct, 9:15 PM" in a given zone.
function prettyIn(d, tz) {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  return date + ', ' + time;
}
function tzLabel(tz) {
  if (tz === IST || tz === 'Asia/Calcutta') return 'IST';
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
    const n = p.find(x => x.type === 'timeZoneName');
    if (n && !/^GMT/.test(n.value)) return n.value;            // EDT, PST, …
    return String(tz).split('/').pop().replace(/_/g, ' ') + ' time';   // Berlin time
  } catch (e) { return tz; }
}

// ── 3. BUSY TIMES ──
// Every interval Arpit is already teaching in [fromMs, toMs], as {s, e} ms.
async function busyIntervals(fromMs, toMs) {
  const busy = [];
  const fromYmd = addDays(istYmd(new Date(fromMs)), -2);
  const toYmd = addDays(istYmd(new Date(toMs)), 2);

  // All the reads at once (they don't depend on each other), so the trial
  // page and My bookings wait for one round trip instead of five.
  const [sch, exq, tq, gq, wq, hq] = await Promise.all([
    supabase.from('class_schedule')
      .select('student_id, weekday, time_ist, local_weekday, local_time, student_tz, duration_min, active')
      .eq('active', true),
    supabase.from('class_exceptions')
      .select('student_id, original_date, action, new_date, new_time_ist')
      .gte('original_date', addDays(fromYmd, -14)).lte('original_date', addDays(toYmd, 14)),
    supabase.from('trials')
      .select('id, start_at, duration_min, status')
      .eq('status', 'booked')
      .gte('start_at', new Date(fromMs - 86400000).toISOString())
      .lte('start_at', new Date(toMs + 86400000).toISOString()),
    supabase.from('gigs').select('id, event_date, event_time, duration, status, archived')
      .gte('event_date', fromYmd).lte('event_date', toYmd),
    supabase.from('workshops').select('id, date, workshop_time, cancelled, archived')
      .gte('date', fromYmd).lte('date', toYmd),
    // Weekly times held by a self-enrolment request (requested / offered / approved, not yet paid).
    supabase.from('enrol_requests').select('id, slot_weekday, slot_time, local_weekday, local_time, tz')
      .in('status', ['requested', 'offered', 'approved'])
  ]);
  const { data: rows, error } = sch;
  if (error) throw new Error('class_schedule: ' + error.message);
  const { data: exRows, error: exErr } = exq;
  if (exErr) throw new Error('class_exceptions: ' + exErr.message);
  const exKey = {};
  for (const e of (exRows || [])) exKey[e.student_id + '|' + String(e.original_date).slice(0, 10)] = e;
  const holds = (hq && !hq.error ? hq.data || [] : []).filter(h => h.slot_weekday != null && h.slot_time)
    .map(h => ({ student_id: 'hold-' + h.id, weekday: h.slot_weekday, time_ist: h.slot_time, local_weekday: h.local_weekday, local_time: h.local_time, student_tz: h.tz, duration_min: 60 }));

  for (const row of [...(rows || []), ...holds]) {
    const dur = (Number(row.duration_min) || 60) * MIN;
    const tz = row.student_tz || IST;
    const anchoredLocal = row.local_time != null && row.local_weekday != null && tz !== IST;
    for (let d = fromYmd; d <= toYmd; d = addDays(d, 1)) {
      let start = null;
      if (anchoredLocal) {
        if (weekdayOf(d) !== Number(row.local_weekday)) continue;
        start = zonedToUtc(d, String(row.local_time).slice(0, 5), tz);
      } else {
        if (weekdayOf(d) !== Number(row.weekday)) continue;
        start = new Date(`${d}T${String(row.time_ist).slice(0, 5)}:00+05:30`);
      }
      if (isNaN(start)) continue;
      const ex = exKey[row.student_id + '|' + istYmd(start)];
      if (ex && (ex.action === 'skip' || ex.action === 'move')) continue;
      busy.push({ s: start.getTime(), e: start.getTime() + dur, what: 'class ' + row.student_id });
    }
  }
  // Classes moved to a new date/time.
  for (const e of (exRows || [])) {
    if (e.action !== 'move' || !e.new_date || !e.new_time_ist) continue;
    const s = new Date(`${String(e.new_date).slice(0, 10)}T${String(e.new_time_ist).slice(0, 5)}:00+05:30`).getTime();
    if (!isNaN(s)) busy.push({ s, e: s + 60 * MIN, what: 'moved ' + e.student_id });
  }

  // Booked trials.
  const { data: trials, error: tErr } = tq;
  if (tErr) throw new Error('trials: ' + tErr.message);
  for (const t of (trials || [])) {
    const s = new Date(t.start_at).getTime();
    if (!isNaN(s)) busy.push({ s, e: s + (Number(t.duration_min) || 45) * MIN, what: 'trial ' + t.id });
  }

  // Performances and workshops: Arpit is away, plus travel and setup time.
  // A read error here only logs; it never stops trials or class moves.
  if (gq.error) console.error('busy: gigs read failed:', gq.error.message);
  for (const g of (gq.data || [])) {
    if (g.archived || g.status === 'cancelled') continue;
    const b = eventBlock(String(g.event_date).slice(0, 10), g.event_time, durationMin(g.duration) || 120);
    if (b) busy.push({ ...b, what: 'performance ' + g.id });
  }
  if (wq.error) console.error('busy: workshops read failed:', wq.error.message);
  for (const w of (wq.data || [])) {
    if (w.archived || w.cancelled) continue;
    const b = eventBlock(String(w.date).slice(0, 10), w.workshop_time, 150);
    if (b) busy.push({ ...b, what: 'workshop ' + w.id });
  }
  return busy.filter(b => b.e >= fromMs - 86400000 && b.s <= toMs + 86400000);
}

// "7 PM", "19:00", "4:00 PM - 6:30 PM" → minutes after midnight, or null.
function clockMin(txt) {
  const m = String(txt || '').match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2] || 0); const mer = (m[3] || '').toUpperCase();
  if (h > 23 || mi > 59) return null;
  if (mer === 'PM' && h < 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
// "2 hours", "90 min", "1.5 hrs" → minutes, or 0.
function durationMin(txt) {
  const t = String(txt || '').toLowerCase();
  const n = parseFloat(t);
  if (!n) return 0;
  return /h/.test(t) ? Math.round(n * 60) : /m/.test(t) ? Math.round(n) : Math.round(n * 60);
}
// Block 2 hours before (travel, setup) to 1 hour after. No time given →
// the whole day, to be safe.
const EVENT_BEFORE_MIN = 120, EVENT_AFTER_MIN = 60;
function eventBlock(ymd, timeTxt, defaultLen) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const dayStart = new Date(`${ymd}T00:00:00+05:30`).getTime();
  const parts = String(timeTxt || '').split(/\s*(?:-|–|to)\s*/i);
  const s = clockMin(parts[0]);
  if (s == null) return { s: dayStart, e: dayStart + 24 * 60 * MIN };
  let e = parts[1] ? clockMin(parts[1]) : null;
  // "4 - 6 PM": the first part has no AM/PM, borrow the second one's.
  let start = s;
  if (e != null && !/AM|PM/i.test(parts[0]) && /PM/i.test(parts[1]) && start < 12 * 60 && start + 12 * 60 < e + 60) start += 12 * 60;
  if (e == null || e <= start) e = start + defaultLen;
  return { s: dayStart + (start - EVENT_BEFORE_MIN) * MIN, e: dayStart + (e + EVENT_AFTER_MIN) * MIN };
}

// ── 4. SLOT ENGINE ──
// Pure function (no I/O) so it can be unit tested. Candidates sit on the
// class grid (class length + buffer from each window start), so a trial
// always takes a spot a weekly class could later use.
function computeSlots(settings, busy, nowMs, lengthMin) {
  const s = settings;
  const len = (lengthMin || s.trial_min) * MIN;
  const step = (s.class_min + s.buffer_min) * MIN;
  const buf = s.buffer_min * MIN;
  const rest = s.rest_hours * 60 * MIN;
  const earliest = nowMs + s.min_notice_hours * 60 * MIN;
  const today = istYmd(new Date(nowMs));
  const lastMs = istMidnight(addDays(today, s.days_ahead + 1));
  const blocked = new Set(s.blocked_dates || []);
  const out = [];

  for (let i = 0; i <= s.days_ahead; i++) {
    const day = addDays(today, i);
    if (!s.weekdays.includes(weekdayOf(day))) continue;
    if (blocked.has(day)) continue;
    const base = istMidnight(day);
    for (const [ws, we] of s.windows) {
      for (let t = base + ws * MIN; t + s.class_min * MIN <= base + we * MIN; t += step) {
        if (t < earliest || t >= lastMs) continue;
        const end = t + len;
        if (blocked.has(istYmd(new Date(t)))) continue;
        let ok = true;
        for (const b of busy) {
          // Overlap with buffer on both sides.
          if (t < b.e + buf && end + buf > b.s) { ok = false; break; }
          // Night rest: a gap that spans 3 AM IST must be at least rest_hours.
          if (rest > 0) {
            const gapStart = b.e <= t ? b.e : end;
            const gapEnd = b.e <= t ? t : b.s;
            if (gapEnd > gapStart && gapEnd - gapStart < rest && spans3am(gapStart, gapEnd)) { ok = false; break; }
          }
        }
        if (ok) out.push(t);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
// Grid candidates that are gone ONLY because a real class or trial sits on
// them (direct overlap). Buffer and night-rest casualties stay hidden, and
// blocked dates never show as "booked" - that would be fake scarcity.
function computeBooked(settings, busy, nowMs, lengthMin) {
  const s = settings;
  const len = (lengthMin || s.trial_min) * MIN;
  const step = (s.class_min + s.buffer_min) * MIN;
  const earliest = nowMs + s.min_notice_hours * 60 * MIN;
  const today = istYmd(new Date(nowMs));
  const lastMs = istMidnight(addDays(today, s.days_ahead + 1));
  const blocked = new Set(s.blocked_dates || []);
  const out = [];
  for (let i = 0; i <= s.days_ahead; i++) {
    const day = addDays(today, i);
    if (!s.weekdays.includes(weekdayOf(day))) continue;
    if (blocked.has(day)) continue;
    const base = istMidnight(day);
    for (const [ws, we] of s.windows) {
      for (let t = base + ws * MIN; t + s.class_min * MIN <= base + we * MIN; t += step) {
        if (t < earliest || t >= lastMs) continue;
        if (blocked.has(istYmd(new Date(t)))) continue;
        const end = t + len;
        if (busy.some(b => t < b.e && end > b.s)) out.push(t);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
function spans3am(a, b) {
  // Is there an IST 03:00 inside (a, b)?
  const day = istYmd(new Date(a));
  for (let k = 0; k <= 1; k++) {
    const three = istMidnight(addDays(day, k)) + 180 * MIN;
    if (three > a && three < b) return true;
  }
  return false;
}

async function freeSlots(lengthMin) {
  const settings = await getSettings();
  const now = Date.now();
  const busy = await busyIntervals(now, now + (settings.days_ahead + 2) * 86400000);
  return { settings, slots: computeSlots(settings, busy, now, lengthMin), booked: computeBooked(settings, busy, now, lengthMin) };
}

// ── 5. EXCHANGE RATES (approximate local price) ──
let _rates = null, _ratesAt = 0;
async function usdRates() {
  if (_rates && Date.now() - _ratesAt < 12 * 3600 * 1000) return _rates;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    if (j && j.result === 'success' && j.rates) { _rates = j.rates; _ratesAt = Date.now(); }
  } catch (e) { console.error('exchange rates fetch failed:', e.message); }
  return _rates;
}
function roundNice(n) {
  if (n >= 1000) return Math.round(n / 10) * 10;
  if (n >= 100) return Math.round(n);
  return Math.round(n * 2) / 2;   // nearest half unit, e.g. €16.5
}

// ── 6. PUBLIC: GET /api/trial/slots?cur=EUR ──
let _fullAlertAt = 0;
async function slotsHandler(req, res) {
  try {
    const { settings, slots, booked } = await freeSlots();
    // Every bookable slot for the whole window is taken - tell Arpit, once a day.
    if (settings.enabled && !slots.length && booked.length && Date.now() - _fullAlertAt > 22 * 3600 * 1000) {
      _fullAlertAt = Date.now();
      notify('trial_full', 'Trial slots full: every bookable trial slot for the next ' + settings.days_ahead + ' days is taken. Open more windows in Trial booking settings if you want more trials.');
    }
    let approx = null;
    const cur = String(req.query.cur || '').toUpperCase();
    if (/^[A-Z]{3}$/.test(cur) && cur !== 'USD' && cur !== 'INR') {
      const rates = await usdRates();
      if (rates && rates[cur]) approx = { currency: cur, amount: roundNice(settings.price_usd * rates[cur]) };
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      open: settings.enabled,
      slots: settings.enabled ? slots.map(t => new Date(t).toISOString()) : [],
      booked: settings.enabled ? booked.map(t => new Date(t).toISOString()) : [],
      trialMin: settings.trial_min,
      bookerDay: settings.booker_day,
      prices: { inr: settings.price_inr, usd: settings.price_usd },
      approx,
      whatsapp: settings.whatsapp
    });
  } catch (e) {
    console.error('trial slots error:', e.message);
    res.status(500).json({ ok: false, error: 'Could not load slots right now. Please try again in a minute.' });
  }
}

// ── 7. PUBLIC: POST /api/trial/book ──
const _hits = new Map();   // ip → [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const list = (_hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now);
  _hits.set(ip, list);
  return list.length > 6;
}
function digits(s) { return String(s || '').replace(/\D/g, ''); }
function isEmail(s) { return /^[^\s@,;()"'<>]+@[^\s@,;()"'<>]+\.[^\s@,;()"'<>]{2,}$/.test(String(s || '').trim()); }
function clean(s, max) { return String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

async function alreadyHadTrial(phoneDigits, email) {
  const last10 = phoneDigits.slice(-10);
  const em = email.toLowerCase();
  const { data: t } = await supabase.from('trials').select('id, status, phone, email, contact')
    .or(`phone.ilike.%${last10},email.eq.${em},contact.ilike.%${last10}%,contact.ilike.${em}`)
    .neq('status', 'cancelled').limit(1);
  if (t && t.length) return 'trial';
  const { data: s } = await supabase.from('students').select('id, phone, email, archived')
    .or(`phone.ilike.%${last10},email.ilike.${em}`).limit(5);
  if ((s || []).some(x => !x.archived)) return 'student';
  return null;
}

const HANDPAN = { yes: 'Has a handpan', not_yet: 'No handpan yet', planning: 'Planning to buy' };

async function bookHandler(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  try {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true });                       // honeypot: quietly ignore bots
    if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'Too many tries. Please wait a few minutes and try again.' });

    const name = clean(b.name, 80);
    const email = clean(b.email, 120).toLowerCase();
    const dial = digits(b.dial).slice(0, 4);
    const local = digits(b.phone).replace(/^0+/, '');
    const phone = dial + local;
    const tz = validTz(b.tz) ? String(b.tz) : IST;
    const handpan = HANDPAN[b.handpan] ? b.handpan : null;
    const startIso = String(b.start || '');
    const start = new Date(startIso);

    if (name.length < 2) return res.status(400).json({ ok: false, field: 'name', error: 'Please enter your name.' });
    if (!isEmail(email)) return res.status(400).json({ ok: false, field: 'email', error: 'Please enter a valid email.' });
    if (!dial || local.length < 6 || phone.length > 15) return res.status(400).json({ ok: false, field: 'phone', error: 'Please enter a valid phone number.' });
    if (!handpan) return res.status(400).json({ ok: false, field: 'handpan', error: 'Please tell me if you have a handpan.' });
    if (isNaN(start)) return res.status(400).json({ ok: false, error: 'Please pick a time.' });

    const settings = await getSettings();
    if (!settings.enabled) return res.status(409).json({ ok: false, error: 'Trial bookings are paused right now. Please message Arpit on WhatsApp.' });

    const had = await alreadyHadTrial(phone, email);
    if (had) {
      return res.status(409).json({ ok: false, code: 'repeat', error: had === 'student'
        ? 'Looks like you are already a student. Message Arpit on WhatsApp to book a class.'
        : 'Looks like you have already booked a free trial. Message Arpit on WhatsApp and he will sort it out.' });
    }

    // The slot must still be free right now, by the same engine the page used.
    const { slots } = await freeSlots();
    if (!slots.includes(start.getTime())) {
      return res.status(409).json({ ok: false, code: 'slot_taken', error: 'Sorry, that time was just taken. Please pick another one.' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const trialDate = istYmd(start);
    const { data: row, error: insErr } = await supabase.from('trials').insert({
      full_name: name, contact: email, email, phone, phone_dial: dial, tz,
      has_handpan: handpan, trial_date: trialDate, start_at: start.toISOString(),
      duration_min: settings.trial_min, source: 'booking', status: 'booked',
      manage_token: token, notes: HANDPAN[handpan]
    }).select().single();
    if (insErr) {
      // 23505 = unique violation on the start_at lock: someone booked it a moment ago.
      if (insErr.code === '23505') return res.status(409).json({ ok: false, code: 'slot_taken', error: 'Sorry, that time was just taken. Please pick another one.' });
      console.error('trial insert failed:', insErr.message);
      return res.status(500).json({ ok: false, error: 'Could not book right now. Please try again, or message Arpit on WhatsApp.' });
    }

    // Zoom meeting. A failure keeps the booking (a lead matters more) and
    // tells Arpit to send a link by hand.
    let joinUrl = null, meetingId = null;
    if (zoomApi) {
      const startIst = trialDate + 'T' + new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(start) + ':00';
      for (let attempt = 0; attempt < 2 && !joinUrl; attempt++) {
        const z = await zoomApi('POST', '/users/' + encodeURIComponent(HOST_EMAIL) + '/meetings', {
          topic: 'Handpan Trial - ' + name, type: 2, start_time: startIst, timezone: IST,
          duration: settings.trial_min,
          settings: { join_before_host: false, waiting_room: true, approval_type: 2 }
        });
        if (z.ok && z.data) { joinUrl = z.data.join_url; meetingId = String(z.data.id); }
        else console.error('trial zoom create failed:', z.error);
      }
      if (joinUrl) await supabase.from('trials').update({ zoom_meeting_id: meetingId, join_url: joinUrl }).eq('id', row.id);
    }

    const t = { ...row, join_url: joinUrl, zoom_meeting_id: meetingId };
    const results = await Promise.allSettled([
      sendGuestEmail(t, settings),
      sendArpitInvite(t),
      waTemplatesOn() && whatsapp ? whatsapp.sendTemplate(phone, 'trial_confirmation',
        [firstName(name), prettyIn(start, tz) + ' (' + tzLabel(tz) + ')', joinUrl || 'Arpit will send the Zoom link shortly']) : Promise.resolve(null)
    ]);
    const failed = results.map((r, i) => (r.status === 'rejected' || (r.value && r.value.ok === false)) ? ['email', 'calendar invite', 'WhatsApp'][i] : null).filter(Boolean);

    // Currency check: +91 number booking from outside India, or the reverse.
    const indianPhone = dial === '91';
    const indianTz = tz === IST || tz === 'Asia/Calcutta';
    const mismatch = indianPhone !== indianTz ? ` Check currency: ${indianPhone ? '+91 number' : 'non-Indian number'} but booking from ${tz}.` : '';

    await notify(joinUrl ? 'info' : 'warning',
      `🎉 New trial booked: ${name} · ${prettyIn(start, IST)} IST (${prettyIn(start, tz)} their time) · +${phone} · ${HANDPAN[handpan]}.` +
      (joinUrl ? '' : ' ⚠️ Zoom meeting could not be created, please send them a link.') +
      (failed.length ? ` ⚠️ Could not send: ${failed.join(', ')}.` : '') + mismatch);

    res.json({
      ok: true,
      start: start.toISOString(),
      whenLocal: prettyIn(start, tz),
      tzLabel: tzLabel(tz),
      joinUrl,
      calendarUrl: googleCalUrl(t)
    });
  } catch (e) {
    console.error('trial book error:', e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again, or message Arpit on WhatsApp.' });
  }
}

function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }

// Same pipeline as everything else: a notifications row, which notify-mailer
// then emails and WhatsApps to Arpit.
async function notify(type, message) {
  try {
    if (notifyFn) await notifyFn(type, message);
    else await supabase.from('notifications').insert({ type, message, read: false });
  } catch (e) { console.error('trial notify failed:', e.message); }
}

// ── 8. CALENDAR + EMAIL ──
function icsStamp(d) { return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function buildIcs(t, method) {
  const start = new Date(t.start_at);
  const end = new Date(start.getTime() + (t.duration_min || 45) * MIN);
  const desc = (t.join_url ? 'Join on Zoom: ' + t.join_url + '\n\n' : '') +
    'Free handpan trial with Arpit Pandey.\nNeed to change it? WhatsApp Arpit: https://wa.me/919019576583';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Arpit Pandey//Handpan Trials//EN', 'CALSCALE:GREGORIAN',
    'METHOD:' + (method || 'REQUEST'),
    'BEGIN:VEVENT',
    'UID:trial-' + t.id + '@arpitpandey.com',
    'DTSTAMP:' + icsStamp(Date.now()),
    'DTSTART:' + icsStamp(start),
    'DTEND:' + icsStamp(end),
    'SUMMARY:' + icsEscape('Handpan trial · ' + t.full_name + ' with Arpit'),
    'DESCRIPTION:' + icsEscape(desc),
    'LOCATION:' + icsEscape(t.join_url || 'Zoom'),
    'ORGANIZER;CN=Arpit Pandey:mailto:' + FROM_EMAIL,
    'ATTENDEE;CN=' + icsEscape(t.full_name) + ';ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:' + t.email,
    'ATTENDEE;CN=Arpit Pandey;ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:' + ARPIT_EMAIL,
    'STATUS:' + (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'), 'SEQUENCE:' + (method === 'CANCEL' ? '1' : '0'),
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Handpan trial in 15 minutes', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
}
function googleCalUrl(t) {
  const start = new Date(t.start_at);
  const end = new Date(start.getTime() + (t.duration_min || 45) * MIN);
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: 'Handpan trial with Arpit',
    dates: icsStamp(start) + '/' + icsStamp(end),
    details: (t.join_url ? 'Join on Zoom: ' + t.join_url : 'Zoom link coming by email')
  });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}

async function sendMail({ to, subject, html, text, ics, replyTo }) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  const body = { from: 'Arpit Pandey <' + FROM_EMAIL + '>', to: [to], subject, html, text, reply_to: replyTo || ARPIT_EMAIL };
  if (ics) {
    const method = /METHOD:CANCEL/.test(ics) ? 'CANCEL' : 'REQUEST';
    body.attachments = [{ filename: method === 'CANCEL' ? 'cancel.ics' : 'invite.ics', content: Buffer.from(ics).toString('base64'), content_type: 'text/calendar; method=' + method + '; charset=UTF-8' }];
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
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

async function sendGuestEmail(t, settings) {
  const start = new Date(t.start_at);
  const when = prettyIn(start, t.tz) + ' (' + tzLabel(t.tz) + ')';
  const wa = 'https://wa.me/' + settings.whatsapp + '?text=' + encodeURIComponent('Hi Arpit, about my trial on ' + prettyIn(start, t.tz));
  const html = mailShell(`
  <p style="margin:0 0 6px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#500018;">You're booked</p>
  <h1 style="margin:0 0 16px;font-size:22px;color:#500018;font-weight:600;">Your free handpan trial</h1>
  <p style="margin:0 0 16px;line-height:1.6;">Hi ${esc(firstName(t.full_name))}, I'm looking forward to meeting you.</p>
  <p style="margin:0 0 6px;"><strong style="color:#500018;">When:</strong> ${esc(when)}</p>
  <p style="margin:0 0 20px;"><strong style="color:#500018;">Length:</strong> ${t.duration_min} minutes, 1:1 on Zoom</p>
  ${t.join_url
    ? `<p style="margin:0 0 20px;"><a href="${esc(t.join_url)}" style="display:inline-block;background:#500018;color:#F5EEE5;text-decoration:none;padding:12px 22px;border-radius:40px;font-weight:600;">Join on Zoom</a></p>`
    : `<p style="margin:0 0 20px;">I'll send you the Zoom link shortly.</p>`}
  <p style="margin:0 0 8px;line-height:1.6;">Before we meet: keep your handpan nearby if you have one, find a quiet spot, and join from a laptop or phone with Zoom.</p>
  <p style="margin:0;line-height:1.6;">Need to change the time? <a href="${esc(wa)}" style="color:#500018;">Message me on WhatsApp</a>.</p>`);
  const text = `Hi ${firstName(t.full_name)}, your free handpan trial is booked for ${when}. ` +
    (t.join_url ? `Join on Zoom: ${t.join_url}. ` : `I'll send the Zoom link shortly. `) +
    `Need to change it? WhatsApp me: ${wa}`;
  return sendMail({ to: t.email, subject: 'Your handpan trial · ' + prettyIn(start, t.tz), html, text, ics: buildIcs(t) });
}

async function sendArpitInvite(t) {
  const start = new Date(t.start_at);
  const html = mailShell(`
  <h1 style="margin:0 0 14px;font-size:20px;color:#500018;font-weight:600;">New trial: ${esc(t.full_name)}</h1>
  <p style="margin:0 0 6px;"><strong>When:</strong> ${esc(prettyIn(start, IST))} IST (${esc(prettyIn(start, t.tz))} ${esc(tzLabel(t.tz))})</p>
  <p style="margin:0 0 6px;"><strong>WhatsApp:</strong> +${esc(t.phone)}</p>
  <p style="margin:0 0 6px;"><strong>Email:</strong> ${esc(t.email)}</p>
  <p style="margin:0 0 6px;"><strong>Handpan:</strong> ${esc(HANDPAN[t.has_handpan] || '—')}</p>
  ${t.join_url ? `<p style="margin:12px 0 0;"><a href="${esc(t.join_url)}" style="color:#500018;">Zoom link</a></p>` : '<p style="margin:12px 0 0;color:#a00;">Zoom meeting was not created. Send a link by hand.</p>'}`);
  return sendMail({ to: ARPIT_EMAIL, subject: 'Trial booked · ' + t.full_name + ' · ' + prettyIn(start, IST) + ' IST', html, text: 'New trial: ' + t.full_name, ics: buildIcs(t), replyTo: t.email });
}

// ── 9. CANCEL (dashboard ✕ button) ──
// Marks the trial cancelled, deletes its Zoom meeting, and emails the person
// and Arpit a calendar cancellation so the event disappears from both
// calendars. The person also gets a link to book a new time.
async function cancelTrial(id) {
  const { data: t, error } = await supabase.from('trials').select('*').eq('id', id).maybeSingle();
  if (error || !t) return { status: 404, error: 'Trial not found' };
  if (t.status !== 'booked') return { status: 409, error: 'Only upcoming trials can be cancelled' };

  const { error: upErr } = await supabase.from('trials').update({ status: 'cancelled' }).eq('id', id);
  if (upErr) return { status: 500, error: 'Could not update: ' + upErr.message };

  const done = { zoom: null, email: null, calendar: null };
  if (t.zoom_meeting_id && zoomApi) {
    const z = await zoomApi('DELETE', '/meetings/' + t.zoom_meeting_id).catch(e => ({ ok: false, error: e.message }));
    done.zoom = z.ok || z.status === 404 ? 'deleted' : ('failed: ' + z.error);
  }
  const settings = await getSettings();
  if (t.email && t.start_at) {
    const start = new Date(t.start_at);
    const when = prettyIn(start, t.tz || IST) + ' (' + tzLabel(t.tz || IST) + ')';
    const wa = 'https://wa.me/' + settings.whatsapp + '?text=' + encodeURIComponent('Hi Arpit, my trial on ' + prettyIn(start, t.tz || IST) + ' was cancelled.');
    const r = await sendMail({
      to: t.email, subject: 'Your handpan trial was cancelled · ' + prettyIn(start, t.tz || IST),
      html: mailShell(`
        <h1 style="margin:0 0 14px;font-size:20px;color:#500018;font-weight:600;">Your trial was cancelled</h1>
        <p style="margin:0 0 16px;line-height:1.6;">Hi ${esc(firstName(t.full_name))}, your free handpan trial on ${esc(when)} has been cancelled. Sorry for the change.</p>
        <p style="margin:0 0 20px;"><a href="https://arpitpandey.com/pages/trial" style="display:inline-block;background:#500018;color:#F5EEE5;text-decoration:none;padding:12px 22px;border-radius:40px;font-weight:600;">Pick a new time</a></p>
        <p style="margin:0;line-height:1.6;">Questions? <a href="${esc(wa)}" style="color:#500018;">Message me on WhatsApp</a>.</p>`),
      text: `Hi ${firstName(t.full_name)}, your handpan trial on ${when} has been cancelled. Pick a new time: https://arpitpandey.com/pages/trial`,
      ics: buildIcs(t, 'CANCEL')
    }).catch(e => ({ ok: false, error: e.message }));
    done.email = r.ok ? 'sent' : ('failed: ' + r.error);
    const a = await sendMail({
      to: ARPIT_EMAIL, subject: 'Trial cancelled · ' + t.full_name + ' · ' + prettyIn(start, IST) + ' IST',
      html: mailShell(`<p style="margin:0;">You cancelled ${esc(t.full_name)}'s trial on ${esc(prettyIn(start, IST))} IST. The calendar event is removed and they were emailed.</p>`),
      text: 'Trial cancelled: ' + t.full_name, ics: buildIcs(t, 'CANCEL')
    }).catch(e => ({ ok: false, error: e.message }));
    done.calendar = a.ok ? 'removed' : ('failed: ' + a.error);
  }
  return { status: 200, ok: true, ...done };
}
async function cancelHandler(req, res) {
  try {
    const r = await cancelTrial(String(req.params.id || ''));
    res.status(r.status).json(r);
  } catch (e) {
    console.error('trial cancel error:', e.message);
    res.status(500).json({ error: 'Could not cancel right now' });
  }
}

// ── 10. WORKER: reminders + no-shows ──
let _timer = null, _busy = false;
async function tick() {
  if (_busy || !supabase) return;
  _busy = true;
  try {
    const now = Date.now();
    // Reminder ~1 hour before.
    const { data: due } = await supabase.from('trials').select('*')
      .eq('status', 'booked').is('reminder_sent_at', null)
      .gte('start_at', new Date(now).toISOString())
      .lte('start_at', new Date(now + 65 * MIN).toISOString());
    for (const t of (due || [])) {
      const start = new Date(t.start_at);
      await supabase.from('trials').update({ reminder_sent_at: new Date().toISOString() }).eq('id', t.id);
      const when = prettyIn(start, t.tz || IST) + ' (' + tzLabel(t.tz || IST) + ')';
      await sendMail({
        to: t.email, subject: 'Starting soon: your handpan trial',
        html: mailShell(`<h1 style="margin:0 0 14px;font-size:20px;color:#500018;font-weight:600;">See you soon, ${esc(firstName(t.full_name))}</h1>
          <p style="margin:0 0 18px;">Your trial starts at ${esc(when)}.</p>
          ${t.join_url ? `<p><a href="${esc(t.join_url)}" style="display:inline-block;background:#500018;color:#F5EEE5;text-decoration:none;padding:12px 22px;border-radius:40px;font-weight:600;">Join on Zoom</a></p>` : ''}`),
        text: `Your handpan trial starts at ${when}. ${t.join_url || ''}`
      }).catch(() => null);
      if (waTemplatesOn() && whatsapp) {
        await whatsapp.sendTemplate(t.phone, 'trial_reminder', [firstName(t.full_name), when, t.join_url || 'see your email']).catch(() => null);
      }
    }
    // No-show: still 'booked' 3 hours after it ended means Zoom saw nobody.
    const { data: past } = await supabase.from('trials').select('id, full_name, start_at, duration_min')
      .eq('status', 'booked').lte('start_at', new Date(now - 4 * 3600 * 1000).toISOString());
    for (const t of (past || [])) {
      await supabase.from('trials').update({ status: 'no_show' }).eq('id', t.id);
      await notify('info', `🙈 ${t.full_name} didn't join the trial on ${prettyIn(new Date(t.start_at), IST)} IST. Marked no-show on the Students page.`);
    }
  } catch (e) { console.error('trial worker error:', e.message); }
  finally { _busy = false; }
}
function startWorker() {
  if (_timer) return;
  setTimeout(tick, 20 * 1000);
  _timer = setInterval(tick, 5 * 60 * 1000);
  console.log('Trial booking worker started');
}

// ── 11. ZOOM ATTENDANCE HOOK ──
// Called by zoom-service when a meeting ends. If the meeting is a booked
// trial, mark it attended (status pending = took the trial, not yet a
// student) and tell the caller so it doesn't add a duplicate trials row.
async function markAttended(meetingId, minutes) {
  if (!meetingId) return false;
  const { data: t } = await supabase.from('trials').select('id, status, full_name')
    .eq('zoom_meeting_id', String(meetingId)).maybeSingle();
  if (!t) return false;
  if (t.status === 'booked' || t.status === 'no_show') {
    await supabase.from('trials').update({ status: 'pending', attended_min: minutes || null }).eq('id', t.id);
  }
  return true;
}

module.exports = {
  init, slotsHandler, bookHandler, cancelHandler, cancelTrial, startWorker, markAttended, getSettings, freeSlots, busyIntervals,
  _test: { eventBlock, durationMin, computeSlots, computeBooked, sanitizeSettings, DEFAULTS, buildIcs, spans3am, istYmd, zonedToUtc }
};
