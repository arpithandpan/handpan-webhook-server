// studio-calendar.js
// Arpit's own "Studio" calendar in Google Calendar, written by the server from
// the dashboard data, so it is always right and never needs touching by hand.
//
//   classes    every weekly class, with moves, skips and make-ups already applied
//   trials     booked trial classes
//   workshops  and performances (gigs)
//   away       blocked days (leave, travel)
//
// All times are sent to Google as exact moments (UTC). Google shows them in
// whatever time zone Arpit's phone or calendar is in, so it works the same in
// India, Berlin or anywhere else. Students are never guests on these events,
// so nothing here ever emails a student.
//
// It only ever touches events it created itself (tagged studio=1). Anything
// else in the calendar is left alone.
//
// Guards (read only, results shown in System health):
//   stray  old weekly class series still sitting in Arpit's personal
//          calendars (made by hand or by Zoom), which students may also see
//   zoom   every active student's Zoom meeting still exists and is
//          "recurring, no fixed time" (type 3), so the link never changes
//
// Setup (Railway variables):
//   GOOGLE_SA_JSON            the service account key (whole JSON, one line)
//   GOOGLE_STUDIO_CALENDAR    the Studio calendar's ID (shared with the service
//                             account: "Make changes to events")
//   GOOGLE_WATCH_CALENDARS    optional, comma separated calendars to check for
//                             old class series (shared: "See all event details")
// Without GOOGLE_SA_JSON + GOOGLE_STUDIO_CALENDAR the sync stays off.

const crypto = require('crypto');

let supabase = null, deps = {};
const IST = 'Asia/Kolkata';
const MIN = 60000, DAY = 86400000;
const SYNC_MS = 10 * MIN, GUARD_MS = 6 * 60 * MIN;
const PAST_DAYS = 2, AHEAD_DAYS = 70;
const DASH = 'https://arpitpandey.com/pages/dashboard';
const studio = require('./studio-time');

const state = { lastSync: null, lastError: null, counts: null, stray: [], strayAt: null, zoom: [], zoomAt: null, guardError: null };

function init(client, opts = {}) { supabase = client; deps = opts || {}; }
function cfg() {
  let sa = null;
  try { sa = process.env.GOOGLE_SA_JSON ? JSON.parse(process.env.GOOGLE_SA_JSON) : null; } catch (e) { sa = null; }
  return {
    sa,
    studio: String(process.env.GOOGLE_STUDIO_CALENDAR || '').trim(),
    watch: String(process.env.GOOGLE_WATCH_CALENDARS || '').split(',').map(x => x.trim()).filter(Boolean)
  };
}
function enabled() { const c = cfg(); return !!(c.sa && c.sa.client_email && c.sa.private_key && c.studio); }

// ── GOOGLE AUTH (service account, JWT) ──
let _tok = null, _tokExp = 0;
function b64u(x) { return Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function token() {
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  const { sa } = cfg();
  if (!sa) throw new Error('GOOGLE_SA_JSON missing or not valid JSON');
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(String(sa.private_key).replace(/\\n/g, '\n'));
  const jwt = head + '.' + body + '.' + sig.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Google sign-in failed: ' + (j.error_description || j.error || r.status));
  _tok = j.access_token; _tokExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return _tok;
}
async function gcal(method, path, body) {
  const r = await fetch('https://www.googleapis.com/calendar/v3' + path, {
    method, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return { ok: true, status: 204, data: null };
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j, error: r.ok ? null : ((j.error && j.error.message) || ('HTTP ' + r.status)) };
}
const enc = encodeURIComponent;

// ── DATES ──
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } }
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekdayOf(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); }
function partsIn(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return { ymd: p.year + '-' + p.month + '-' + p.day, hhmm: p.hour + ':' + p.minute };
}
function offsetMin(ms, tz) {
  const p = partsIn(ms, tz);
  const asUtc = Date.UTC(+p.ymd.slice(0, 4), +p.ymd.slice(5, 7) - 1, +p.ymd.slice(8, 10), +p.hhmm.slice(0, 2), +p.hhmm.slice(3, 5));
  return Math.round((asUtc - Math.floor(ms / MIN) * MIN) / MIN);
}
function zonedToUtc(ymd, hhmm, tz) {
  const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), +hhmm.slice(0, 2), +hhmm.slice(3, 5));
  let t = guess - offsetMin(guess, tz) * MIN;
  t = guess - offsetMin(t, tz) * MIN;
  return t;
}
function istYmd(ms) { return partsIn(ms, IST).ymd; }
function hhmm(v) { return String(v || '').slice(0, 5); }
function label(ms, tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' ' + (TZ_SHORT[tz] || tz); } catch (e) { return ''; }
}
const TZ_SHORT = { 'Asia/Kolkata': 'IST', 'America/New_York': 'ET', 'America/Toronto': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Edmonton': 'MT', 'America/Los_Angeles': 'PT', 'America/Vancouver': 'PT', 'Europe/London': 'UK', 'Europe/Berlin': 'CET', 'Asia/Dubai': 'GST', 'Asia/Singapore': 'SGT' };

// "7 PM", "19:00", "4:00 PM - 6:30 PM" → minutes after midnight.
function clockMin(txt) {
  const m = String(txt || '').match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2] || 0); const mer = (m[3] || '').toUpperCase();
  if (h > 23 || mi > 59) return null;
  if (mer === 'PM' && h < 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
function durationMin(txt) {
  const t = String(txt || '').toLowerCase(); const n = parseFloat(t);
  if (!n) return 0;
  return /h/.test(t) ? Math.round(n * 60) : /m/.test(t) ? Math.round(n) : Math.round(n * 60);
}
// A workshop or gig on an Indian date with a free-text time → { s, e } or an all-day day.
function eventSpan(ymd, timeTxt, defaultLen) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const parts = String(timeTxt || '').split(/\s*(?:-|–|to)\s*/i);
  let s = clockMin(parts[0]);
  if (s == null) return { allDay: ymd };
  let e = parts[1] ? clockMin(parts[1]) : null;
  if (e != null && !/AM|PM/i.test(parts[0]) && /PM/i.test(parts[1]) && s < 720 && s + 720 < e + 60) s += 720;
  if (e == null || e <= s) e = s + defaultLen;
  const day0 = zonedToUtc(ymd, '00:00', IST);
  return { s: day0 + s * MIN, e: day0 + e * MIN };
}

// ── WHAT THE CALENDAR SHOULD HOLD ──
// Every item: { key, title, s, e } or { key, title, allDay: 'YYYY-MM-DD', endDay }
async function desired() {
  const now = Date.now(), from = now - PAST_DAYS * DAY, to = now + AHEAD_DAYS * DAY;
  const fromYmd = addDays(istYmd(from), -1), toYmd = addDays(istYmd(to), 1);
  const q = (p) => p.then(r => { if (r.error) throw new Error(r.error.message); return r.data || []; });
  const soft = (p, what) => p.then(r => { if (r.error) { console.error('studio calendar: ' + what + ' read failed:', r.error.message); return []; } return r.data || []; });
  const [slots, exs, students, trials, gigs, wss, blocks] = await Promise.all([
    q(supabase.from('class_schedule').select('*').eq('active', true)),
    q(supabase.from('class_exceptions').select('student_id, original_date, action, new_date, new_time_ist, makeup').gte('original_date', addDays(fromYmd, -14)).lte('original_date', addDays(toYmd, 14))),
    q(supabase.from('students').select('id, full_name, archived')),
    soft(supabase.from('trials').select('*').eq('status', 'booked').gte('start_at', new Date(from).toISOString()).lte('start_at', new Date(to).toISOString()), 'trials'),
    soft(supabase.from('gigs').select('*').gte('event_date', fromYmd).lte('event_date', toYmd), 'gigs'),
    soft(supabase.from('workshops').select('*').gte('date', fromYmd).lte('date', toYmd), 'workshops'),
    soft(supabase.from('blocks').select('*').is('removed_at', null).lte('start_at', new Date(to).toISOString()).gte('end_at', new Date(from).toISOString()), 'blocks')
  ]);
  const name = Object.fromEntries(students.filter(s => !s.archived).map(s => [s.id, s.full_name || s.id]));
  const exKey = {};
  for (const e of exs) exKey[e.student_id + '|' + String(e.original_date).slice(0, 10)] = e;
  const slotOf = {};
  for (const r of slots) if (!slotOf[r.student_id]) slotOf[r.student_id] = r;
  const out = [];
  const classItem = (sid, slot, s, dur, kind, origYmd) => {
    const tz = slot && slot.student_tz && validTz(slot.student_tz) ? slot.student_tz : IST;
    const nm = name[sid] || sid;
    const lines = [];
    if (slot && slot.zoom_link) lines.push('Zoom: ' + slot.zoom_link);
    if (tz !== IST) lines.push('Their time: ' + label(s, tz));
    if (kind === 'moved') lines.push('Moved from ' + new Date(origYmd + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }));
    if (kind === 'makeup') lines.push('Make-up class');
    lines.push('Open in Studio: ' + DASH);
    return { key: 'class|' + sid + '|' + (origYmd || istYmd(s)), title: nm + (kind === 'makeup' ? ' · make-up' : kind === 'moved' ? ' · moved' : ' · class'), s, e: s + dur * MIN, desc: lines.join('\n'), color: kind === 'class' ? null : '5', kind: 'class' };
  };
  // Weekly classes, anchored in the student's own zone when they have a local time.
  for (const row of slots) {
    if (!name[row.student_id]) continue;
    const dur = Number(row.duration_min) || 60;
    const tz = row.student_tz && validTz(row.student_tz) ? row.student_tz : IST;
    const local = row.local_time != null && row.local_weekday != null && tz !== IST;
    for (let d = fromYmd; d <= toYmd; d = addDays(d, 1)) {
      let s;
      if (local) { if (weekdayOf(d) !== Number(row.local_weekday)) continue; s = zonedToUtc(d, hhmm(row.local_time), tz); }
      else { if (weekdayOf(d) !== Number(row.weekday)) continue; s = zonedToUtc(d, hhmm(row.time_ist), IST); }
      if (isNaN(s) || s < from || s > to) continue;
      const ex = exKey[row.student_id + '|' + istYmd(s)];
      if (ex && (ex.action === 'skip' || ex.action === 'move')) continue;
      out.push(classItem(row.student_id, row, s, dur, 'class'));
    }
  }
  // Moved classes and make-ups (stored as a move of the original date).
  for (const e of exs) {
    if (e.action !== 'move' || !e.new_date || !e.new_time_ist || !name[e.student_id]) continue;
    const s = zonedToUtc(String(e.new_date).slice(0, 10), hhmm(e.new_time_ist), IST);
    if (isNaN(s) || s < from || s > to) continue;
    const slot = slotOf[e.student_id];
    out.push(classItem(e.student_id, slot, s, Number(slot && slot.duration_min) || 60, e.makeup ? 'makeup' : 'moved', String(e.original_date).slice(0, 10)));
  }
  for (const t of trials) {
    const s = new Date(t.start_at).getTime(); if (isNaN(s)) continue;
    const lines = [];
    if (t.join_url) lines.push('Zoom: ' + t.join_url);
    if (t.tz && t.tz !== IST && validTz(t.tz)) lines.push('Their time: ' + label(s, t.tz));
    if (t.has_handpan) lines.push('Own handpan: ' + t.has_handpan);
    lines.push('Open in Studio: ' + DASH);
    out.push({ key: 'trial|' + t.id, title: (t.full_name || 'Someone') + ' · trial', s, e: s + (Number(t.duration_min) || 45) * MIN, desc: lines.join('\n'), color: '2', kind: 'trial' });
  }
  for (const w of wss) {
    if (w.archived || w.cancelled) continue;
    const sp = eventSpan(String(w.date).slice(0, 10), w.workshop_time, 150); if (!sp) continue;
    const title = 'Workshop · ' + (w.venue || w.title || w.id);
    out.push(sp.allDay ? { key: 'ws|' + w.id, title, allDay: sp.allDay, desc: 'Open in Studio: ' + DASH, color: '11', kind: 'workshop' }
      : { key: 'ws|' + w.id, title, s: sp.s, e: sp.e, desc: (w.venue ? w.venue + '\n' : '') + 'Open in Studio: ' + DASH, color: '11', kind: 'workshop' });
  }
  for (const g of gigs) {
    if (g.archived || g.status === 'cancelled') continue;
    const sp = eventSpan(String(g.event_date).slice(0, 10), g.event_time, durationMin(g.duration) || 120); if (!sp) continue;
    const title = 'Performance · ' + (g.client || g.title || g.venue || g.id);
    out.push(sp.allDay ? { key: 'gig|' + g.id, title, allDay: sp.allDay, desc: 'Open in Studio: ' + DASH, color: '3', kind: 'gig' }
      : { key: 'gig|' + g.id, title, s: sp.s, e: sp.e, desc: 'Open in Studio: ' + DASH, color: '3', kind: 'gig' });
  }
  for (const b of blocks) {
    const s = new Date(b.start_at).getTime(), e = new Date(b.end_at).getTime(); if (isNaN(s) || isNaN(e)) continue;
    const title = 'Away' + (b.note ? ' · ' + b.note : '');
    if (b.all_day) out.push({ key: 'away|' + b.id, title, allDay: studio.ymd(s), endDay: studio.ymd(e - 1) === studio.ymd(s) ? null : addDays(studio.ymd(e - 1), 1), desc: 'Blocked in Studio. No classes or trials.', color: '8', kind: 'away' });
    else out.push({ key: 'away|' + b.id, title, s, e, desc: 'Blocked in Studio. No classes or trials.', color: '8', kind: 'away' });
  }
  return out;
}

function eventId(key) { return 'st' + crypto.createHash('sha1').update(key).digest('hex'); }   // 0-9a-f fits Google's id rules
function toEvent(it) {
  const ev = {
    summary: it.title, description: it.desc || '',
    extendedProperties: { private: { studio: '1', key: it.key } },
    reminders: { useDefault: false, overrides: it.kind === 'class' || it.kind === 'trial' ? [{ method: 'popup', minutes: 10 }] : [] },
    transparency: it.kind === 'away' ? 'transparent' : 'opaque'
  };
  if (it.color) ev.colorId = it.color;
  if (it.allDay) { ev.start = { date: it.allDay }; ev.end = { date: it.endDay || addDays(it.allDay, 1) }; }
  else { ev.start = { dateTime: new Date(it.s).toISOString(), timeZone: 'UTC' }; ev.end = { dateTime: new Date(it.e).toISOString(), timeZone: 'UTC' }; }
  ev.extendedProperties.private.h = crypto.createHash('sha1').update(JSON.stringify([ev.summary, ev.description, ev.start, ev.end, ev.colorId || ''])).digest('hex').slice(0, 16);
  return ev;
}

// ── SYNC ──
let _busy = false;
async function sync() {
  if (!enabled()) return { skipped: 'not set up' };
  if (_busy) return { skipped: 'already running' };
  _busy = true;
  try {
    const cal = enc(cfg().studio);
    const want = {};
    for (const it of await desired()) want[eventId(it.key)] = toEvent(it);
    // What is there now (ours only), in the same window.
    const have = {};
    let pageToken = '';
    const tMin = new Date(Date.now() - (PAST_DAYS + 1) * DAY).toISOString(), tMax = new Date(Date.now() + (AHEAD_DAYS + 2) * DAY).toISOString();
    do {
      const r = await gcal('GET', '/calendars/' + cal + '/events?privateExtendedProperty=studio%3D1&showDeleted=false&singleEvents=true&maxResults=2500&timeMin=' + enc(tMin) + '&timeMax=' + enc(tMax) + (pageToken ? '&pageToken=' + enc(pageToken) : ''));
      if (!r.ok) throw new Error('read Studio calendar: ' + r.error);
      for (const ev of (r.data.items || [])) have[ev.id] = ev;
      pageToken = r.data.nextPageToken || '';
    } while (pageToken);
    let added = 0, changed = 0, removed = 0;
    for (const id of Object.keys(want)) {
      const ev = want[id], cur = have[id];
      if (cur && cur.extendedProperties && cur.extendedProperties.private && cur.extendedProperties.private.h === ev.extendedProperties.private.h) continue;
      if (cur) { const r = await gcal('PUT', '/calendars/' + cal + '/events/' + id, ev); if (!r.ok) throw new Error('update event: ' + r.error); changed++; continue; }
      let r = await gcal('POST', '/calendars/' + cal + '/events', { ...ev, id });
      if (r.status === 409) r = await gcal('PUT', '/calendars/' + cal + '/events/' + id, { ...ev, status: 'confirmed' });   // was deleted earlier: bring it back
      if (!r.ok) throw new Error('add event: ' + r.error);
      added++;
    }
    for (const id of Object.keys(have)) {
      if (want[id]) continue;
      const r = await gcal('DELETE', '/calendars/' + cal + '/events/' + id + '?sendUpdates=none');
      if (!r.ok && r.status !== 410 && r.status !== 404) throw new Error('remove event: ' + r.error);
      removed++;
    }
    state.lastSync = new Date().toISOString(); state.lastError = null;
    state.counts = { events: Object.keys(want).length, added, changed, removed };
    if (added || changed || removed) console.log('Studio calendar: +' + added + ' ~' + changed + ' -' + removed);
    return { ok: true, ...state.counts };
  } catch (e) {
    state.lastError = e.message;
    console.error('Studio calendar sync failed:', e.message);
    return { ok: false, error: e.message };
  } finally { _busy = false; }
}

// ── GUARDS ──
// Old weekly class series in Arpit's personal calendars. These came from the
// old way (hand-made Google events, Zoom invites) and drift from the truth.
const CLASS_RX = /handpan\s*(beginner\s*)?(class|classes|lesson|session)/i;
async function strayCheck() {
  const { watch } = cfg();
  if (!watch.length) return [];
  const found = [];
  const tMin = new Date().toISOString(), tMax = new Date(Date.now() + 28 * DAY).toISOString();
  for (const calId of watch) {
    const r = await gcal('GET', '/calendars/' + enc(calId) + '/events?singleEvents=true&maxResults=500&orderBy=startTime&timeMin=' + enc(tMin) + '&timeMax=' + enc(tMax));
    if (!r.ok) { found.push({ calendar: calId, error: r.error }); continue; }
    const seen = {};
    for (const ev of (r.data.items || [])) {
      if (ev.status === 'cancelled' || !ev.recurringEventId) continue;            // only repeating series
      if (!CLASS_RX.test(ev.summary || '') || /trial/i.test(ev.summary || '')) continue;
      const org = String((ev.organizer && ev.organizer.email) || '').toLowerCase();
      if (org.endsWith('@arpitpandey.com')) continue;                              // our own invites
      if (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.studio) continue;
      if (seen[ev.recurringEventId]) continue;
      seen[ev.recurringEventId] = 1;
      const guests = (ev.attendees || []).map(a => String(a.email || '').toLowerCase()).filter(e => e && !/arpitbam@|arpithandpan@/.test(e));
      const at = ev.start && (ev.start.dateTime || ev.start.date);
      found.push({ calendar: calId, title: ev.summary, next: at, studentGuests: guests.length, organizer: org });
    }
  }
  return found;
}
// Every active student's meeting: still there, still type 3 (one permanent link, no times in Zoom).
async function zoomCheck() {
  if (!deps.zoomApi) return [];
  const { data, error } = await supabase.from('class_schedule').select('student_id, zoom_link, active').eq('active', true);
  if (error) throw new Error(error.message);
  const { data: st } = await supabase.from('students').select('id, full_name');
  const nm = Object.fromEntries((st || []).map(s => [s.id, s.full_name || s.id]));
  // A meeting in Zoom's "Recently Deleted" can still answer GET /meetings/{id},
  // so a meeting only counts as alive when it is also in the account's list.
  const live = new Set(); let next = '', listed = false;
  for (let i = 0; i < 10; i++) {
    const l = await deps.zoomApi('GET', '/users/me/meetings?type=scheduled&page_size=300' + (next ? '&next_page_token=' + next : ''));
    if (!l.ok) break;
    listed = true;
    for (const m of (l.data.meetings || [])) live.add(String(m.id));
    next = l.data.next_page_token || ''; if (!next) break;
  }
  // Only trust the list if it shows at least one of our meetings (so a list that
  // leaves out "no fixed time" meetings can never raise a false alarm).
  const ours = (data || []).map(r => (String(r.zoom_link || '').match(/\/j\/(\d+)/) || [])[1]).filter(Boolean);
  if (!ours.some(id => live.has(String(id)))) listed = false;
  const out = [];
  for (const r of (data || [])) {
    const id = (String(r.zoom_link || '').match(/\/j\/(\d+)/) || [])[1];
    if (!id) { out.push({ student: nm[r.student_id] || r.student_id, problem: 'no Zoom link' }); continue; }
    const m = await deps.zoomApi('GET', '/meetings/' + id);
    if (!m.ok) { out.push({ student: nm[r.student_id] || r.student_id, problem: m.status === 404 ? 'Zoom meeting was deleted' : 'Zoom check failed: ' + m.error }); continue; }
    if (listed && !live.has(String(id))) { out.push({ student: nm[r.student_id] || r.student_id, problem: 'Zoom meeting is in Recently Deleted (recover it in Zoom within 7 days)' }); continue; }
    if (Number(m.data.type) !== 3) out.push({ student: nm[r.student_id] || r.student_id, problem: 'Zoom meeting has fixed times again (type ' + m.data.type + ')' });
  }
  return out;
}
async function guards() {
  try {
    if (enabled() || cfg().watch.length) { state.stray = await strayCheck(); state.strayAt = new Date().toISOString(); }
    state.zoom = await zoomCheck(); state.zoomAt = new Date().toISOString();
    state.guardError = null;
  } catch (e) { state.guardError = e.message; console.error('Studio calendar guards failed:', e.message); }
  return status();
}

function status() {
  const c = cfg();
  return { enabled: enabled(), serviceAccount: c.sa ? c.sa.client_email : null, watching: c.watch, ...state };
}

function startWorker() {
  console.log('Studio calendar: ' + (enabled() ? 'on (every 10 min)' : 'off (GOOGLE_SA_JSON / GOOGLE_STUDIO_CALENDAR not set)'));
  setTimeout(() => { sync(); guards(); }, 60 * 1000);
  setInterval(sync, SYNC_MS);
  setInterval(guards, GUARD_MS);
}

module.exports = { init, startWorker, sync, guards, status, _test: { desired, toEvent, eventId, eventSpan, zonedToUtc } };
