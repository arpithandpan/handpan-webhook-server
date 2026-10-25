// ── CALENDAR INVITES (weekly classes) ──
// Every active weekly slot becomes ONE calendar series in the student's
// calendar (an .ics invite by email). When a class is moved, skipped or made
// up, from My bookings OR from the dashboard, the same series is re-sent with
// a higher SEQUENCE, so the student's calendar updates itself:
//   skip     → that date is removed (EXDATE)
//   move     → that date moves (an override with RECURRENCE-ID)
//   make-up  → stored as a move of the skipped date, so it shows the same way
//   slot off → the whole series is cancelled (METHOD:CANCEL)
//
// It does not hook into every place that changes classes. A worker compares
// the classes each student SHOULD see with what was last sent (a hash) every
// 10 minutes and sends only when something changed. That catches changes
// made anywhere, and a burst of edits goes out as one update.
//
// Env CALENDAR_INVITES:
//   off  (default) nothing is sent
//   test           everything goes to Arpit (subject says which student)
//   on             invites go to the students
// Switching test → on sends each student their first invite.
//
// Table calendar_invites (RLS on, server only): one row per weekly slot.
//
// v179 additions
//   • Delivery check: every invite's Resend id is checked after 15 min, 2 h and
//     24 h. Bounced / marked as spam / blocked → an alert to Arpit (dashboard +
//     phone). The list waits in app_settings 'invite_checks' so a restart keeps it.
//   • Zoom check before a first invite (new student, or back from a break): a
//     deleted meeting holds the invite and alerts Arpit; a meeting with fixed
//     times is switched to "no fixed time" first (same ID, same link).
//   • resend(): the student (My bookings) or Arpit (System health) can get the
//     same invite again. Same UID, so the calendar entry updates, never doubles.

const crypto = require('crypto');

let supabase = null;
let notifyFn = null;
let zoomApi = null;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.TRIAL_FROM_EMAIL || 'classes@arpitpandey.com';
const ARPIT_EMAIL = process.env.TRIAL_ARPIT_EMAIL || 'arpithandpan@gmail.com';
const IST = 'Asia/Kolkata';
const MIN = 60000, DAY = 86400000;
const TICK_MS = 10 * MIN;
const MAX_PER_RUN = 25;
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function init(client, opts = {}) { supabase = client; notifyFn = opts.notify || null; zoomApi = opts.zoomApi || null; }
async function alert(type, message) { if (notifyFn) { try { await notifyFn(type, message); } catch (e) {} } }
function mode() {
  const v = String(process.env.CALENDAR_INVITES || '').trim().toLowerCase();
  return v === 'on' || v === 'test' ? v : 'off';
}

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
function utcStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function localStamp(ymd, hhmm) { return ymd.replace(/-/g, '') + 'T' + hhmm.replace(':', '') + '00'; }
function esc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
// RFC 5545: lines longer than 75 octets are folded.
function fold(line) {
  const b = Buffer.from(line, 'utf8');
  if (b.length <= 75) return line;
  const out = []; let cur = '', len = 0;
  for (const ch of line) {
    const l = Buffer.byteLength(ch, 'utf8');
    if (len + l > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// ── TIME ZONE BLOCKS (Outlook needs them; Google and Apple read the name) ──
const US = (std, dst, sn, dn) => ['BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:' + std, 'TZOFFSETTO:' + dst, 'TZNAME:' + dn, 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:' + dst, 'TZOFFSETTO:' + std, 'TZNAME:' + sn, 'END:STANDARD'];
const EU = (std, dst, sn, dn, dh, sh) => ['BEGIN:DAYLIGHT', 'DTSTART:19700329T0' + dh + '0000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZOFFSETFROM:' + std, 'TZOFFSETTO:' + dst, 'TZNAME:' + dn, 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'DTSTART:19701025T0' + sh + '0000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'TZOFFSETFROM:' + dst, 'TZOFFSETTO:' + std, 'TZNAME:' + sn, 'END:STANDARD'];
const FIXED = (off, name) => ['BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:' + off, 'TZOFFSETTO:' + off, 'TZNAME:' + name, 'END:STANDARD'];
const CET = EU('+0100', '+0200', 'CET', 'CEST', 2, 3);
const VTZ = {
  'Asia/Kolkata': FIXED('+0530', 'IST'), 'Asia/Calcutta': FIXED('+0530', 'IST'),
  'Asia/Dubai': FIXED('+0400', '+04'), 'Asia/Singapore': FIXED('+0800', '+08'), 'Asia/Tokyo': FIXED('+0900', 'JST'),
  'America/New_York': US('-0500', '-0400', 'EST', 'EDT'), 'America/Toronto': US('-0500', '-0400', 'EST', 'EDT'), 'America/Detroit': US('-0500', '-0400', 'EST', 'EDT'),
  'America/Chicago': US('-0600', '-0500', 'CST', 'CDT'), 'America/Winnipeg': US('-0600', '-0500', 'CST', 'CDT'),
  'America/Denver': US('-0700', '-0600', 'MST', 'MDT'), 'America/Edmonton': US('-0700', '-0600', 'MST', 'MDT'),
  'America/Phoenix': FIXED('-0700', 'MST'),
  'America/Los_Angeles': US('-0800', '-0700', 'PST', 'PDT'), 'America/Vancouver': US('-0800', '-0700', 'PST', 'PDT'),
  'Europe/London': EU('+0000', '+0100', 'GMT', 'BST', 1, 2), 'Europe/Dublin': EU('+0000', '+0100', 'GMT', 'IST', 1, 2), 'Europe/Lisbon': EU('+0000', '+0100', 'WET', 'WEST', 1, 2),
  'Europe/Berlin': CET, 'Europe/Paris': CET, 'Europe/Amsterdam': CET, 'Europe/Madrid': CET, 'Europe/Rome': CET, 'Europe/Zurich': CET, 'Europe/Vienna': CET,
  'Europe/Brussels': CET, 'Europe/Stockholm': CET, 'Europe/Oslo': CET, 'Europe/Copenhagen': CET, 'Europe/Prague': CET, 'Europe/Warsaw': CET
};
function vtimezone(tz) { const b = VTZ[tz]; return b ? ['BEGIN:VTIMEZONE', 'TZID:' + tz, ...b, 'END:VTIMEZONE'] : []; }

// ── ONE SLOT → ONE SERIES ──
// A slot is anchored in the student's own time zone when it has local_time
// (US students keep their local time across daylight saving), otherwise in IST.
function slotRule(row) {
  const tz = row.student_tz && validTz(row.student_tz) ? row.student_tz : IST;
  const local = row.local_time != null && row.local_weekday != null && tz !== IST;
  return local
    ? { tz, weekday: Number(row.local_weekday), hhmm: String(row.local_time).slice(0, 5), dur: Number(row.duration_min) || 60 }
    : { tz: IST, weekday: Number(row.weekday), hhmm: String(row.time_ist).slice(0, 5), dur: Number(row.duration_min) || 60 };
}
function slotSig(row) { const r = slotRule(row); return [r.tz, r.weekday, r.hhmm, r.dur].join('|'); }
// The class's IST date key on the series' local date `ymd`.
function occOn(rule, ymd) { const ms = zonedToUtc(ymd, rule.hhmm, rule.tz); return { ms, key: istYmd(ms) }; }
// First series date on/after `fromYmd` (in the series' zone).
function firstOn(rule, fromYmd) { let d = fromYmd; for (let i = 0; i < 8 && weekdayOf(d) !== rule.weekday; i++) d = addDays(d, 1); return d; }

// Map each exception (keyed by the original class's IST date) to the series
// date it belongs to, from the anchor up to 26 weeks ahead.
function seriesDates(rule, anchor, weeks) {
  const out = {}; let d = anchor;
  for (let i = 0; i < weeks; i++) { const o = occOn(rule, d); out[o.key] = { ymd: d, ms: o.ms }; d = addDays(d, 7); }
  return out;
}

function buildIcs({ row, student, anchor, exceptions, seq, method }) {
  const rule = slotRule(row);
  const uid = 'class-' + row.id + '@arpitpandey.com';
  const name = student.full_name || 'Student';
  const zoom = row.zoom_link || '';
  const desc = (zoom ? 'Join on Zoom: ' + zoom + '\n\n' : '') +
    'Weekly handpan class with Arpit Pandey.\nTo move or skip a class: https://arpitpandey.com/my\nQuestions? WhatsApp +91 93801 40907';
  const weeks = Math.max(30, Math.ceil((Date.now() - new Date(anchor + 'T00:00:00Z').getTime()) / (7 * DAY)) + 30);
  const dates = seriesDates(rule, anchor, weeks);
  const exdates = [], overrides = [];
  for (const ex of exceptions) {
    const hit = dates[String(ex.original_date).slice(0, 10)];
    if (!hit) continue;
    const rid = localStamp(hit.ymd, rule.hhmm);
    if (ex.action === 'skip') exdates.push(rid);
    else if (ex.action === 'move' && ex.new_date && ex.new_time_ist) {
      const start = zonedToUtc(String(ex.new_date).slice(0, 10), String(ex.new_time_ist).slice(0, 5), IST);
      overrides.push({ rid, start, makeup: !!ex.makeup });
    }
  }
  exdates.sort(); overrides.sort((a, b) => a.rid.localeCompare(b.rid));
  const head = (extra) => [
    'UID:' + uid, 'DTSTAMP:' + utcStamp(Date.now()),
    'SUMMARY:' + esc('Handpan class · ' + name + ' with Arpit'),
    'DESCRIPTION:' + esc(desc), 'LOCATION:' + esc(zoom || 'Zoom'),
    'ORGANIZER;CN=Arpit Pandey:mailto:' + FROM_EMAIL,
    ...(emailsOf(student).length ? emailsOf(student) : [ARPIT_EMAIL]).map(e => 'ATTENDEE;CN=' + esc(name) + ';ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:' + e),
    'SEQUENCE:' + seq, ...extra
  ];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Arpit Pandey//Handpan Classes//EN', 'CALSCALE:GREGORIAN', 'METHOD:' + method, ...vtimezone(rule.tz)];
  lines.push('BEGIN:VEVENT', ...head([
    'DTSTART;TZID=' + rule.tz + ':' + localStamp(anchor, rule.hhmm),
    'DURATION:PT' + rule.dur + 'M',
    'RRULE:FREQ=WEEKLY;BYDAY=' + DAYS[rule.weekday],
    ...(exdates.length && method !== 'CANCEL' ? ['EXDATE;TZID=' + rule.tz + ':' + exdates.join(',')] : []),
    'STATUS:' + (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'),
    'TRANSP:OPAQUE'
  ]), ...(method === 'CANCEL' ? [] : ['BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Handpan class in 30 minutes', 'END:VALARM']), 'END:VEVENT');
  if (method !== 'CANCEL') for (const o of overrides) {
    lines.push('BEGIN:VEVENT', ...head([
      'RECURRENCE-ID;TZID=' + rule.tz + ':' + o.rid,
      'DTSTART:' + utcStamp(o.start), 'DURATION:PT' + rule.dur + 'M',
      'STATUS:CONFIRMED', 'TRANSP:OPAQUE'
    ]), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const ics = lines.map(fold).join('\r\n') + '\r\n';
  // What the student should see, without the parts that change on every send.
  const hash = crypto.createHash('sha256').update(lines.filter(l => !/^(DTSTAMP|SEQUENCE|METHOD):/.test(l)).join('\n')).digest('hex').slice(0, 32);
  return { ics, hash, summary: { exdates: exdates.length, moved: overrides.length } };
}

// Everyone who should get the invite: the student's email plus any extra
// ones (a parent, a partner) in students.extra_emails, comma separated.
function emailsOf(student) {
  const all = [student.email].concat(String(student.extra_emails || '').split(/[,;\s]+/));
  const out = [];
  for (const e of all) { const v = String(e || '').trim().toLowerCase(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !out.includes(v)) out.push(v); }
  return out;
}

// ── EMAIL ──
async function sendMail({ to, subject, html, text, ics, method }) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  const body = {
    from: 'Arpit Pandey <' + FROM_EMAIL + '>', to: String(to).split(',').map(x => x.trim()).filter(Boolean), subject, html, text, reply_to: ARPIT_EMAIL,
    attachments: [{ filename: method === 'CANCEL' ? 'cancel.ics' : 'invite.ics', content: Buffer.from(ics).toString('base64'), content_type: 'text/calendar; method=' + method + '; charset=UTF-8' }]
  };
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.message || ('HTTP ' + r.status) };
  return { ok: true, id: j.id || null };
}
function shell(inner) {
  return '<div style="background:#F5EEE5;padding:28px 16px;font-family:Helvetica,Arial,sans-serif;color:#5A4645;"><div style="max-width:520px;margin:0 auto;background:#FFFDFA;border-radius:16px;padding:28px 24px;">' + inner +
    '<p style="margin:28px 0 0;font-size:13px;color:#6B5150;">Arpit Pandey · Handpan artist and teacher<br><a href="https://arpitpandey.com" style="color:#500018;">arpitpandey.com</a></p></div></div>';
}
function mailFor(kind, student, test) {
  const first = String(student.full_name || '').trim().split(/\s+/)[0] || 'there';
  const tag = test ? '[TEST for ' + (student.full_name || student.id) + '] ' : '';
  if (kind === 'new') return {
    subject: tag + 'Your weekly handpan class · calendar invite',
    text: 'Hi ' + first + ', your weekly handpan class is attached as a calendar invite. Add it once and it stays up to date: when a class is moved or skipped, your calendar changes by itself. To move or skip a class: https://arpitpandey.com/my',
    html: shell('<p style="margin:0 0 14px;font-size:16px;">Hi ' + first + ',</p><p style="margin:0 0 14px;line-height:1.55;">Your weekly handpan class is attached as a calendar invite. Add it once and it stays up to date: when a class is moved or skipped, your calendar changes by itself.</p><p style="margin:0;line-height:1.55;">To move or skip a class: <a href="https://arpitpandey.com/my" style="color:#500018;">arpitpandey.com/my</a></p>')
  };
  if (kind === 'again') return {
    subject: tag + 'Your weekly handpan class · calendar invite',
    text: 'Hi ' + first + ', here is your weekly handpan class calendar invite again. Open it and add it (or tap Yes). If the class is already in your calendar, it just updates the same entry, so nothing shows twice. To move or skip a class: https://arpitpandey.com/my',
    html: shell('<p style="margin:0 0 14px;font-size:16px;">Hi ' + first + ',</p><p style="margin:0 0 14px;line-height:1.55;">Here is your weekly handpan class calendar invite again. Open it and add it (or tap Yes). If the class is already in your calendar, it just updates the same entry, so nothing shows twice.</p><p style="margin:0;line-height:1.55;">To move or skip a class: <a href="https://arpitpandey.com/my" style="color:#500018;">arpitpandey.com/my</a></p>')
  };
  if (kind === 'cancel') return {
    subject: tag + 'Weekly handpan class removed from your calendar',
    text: 'Hi ' + first + ', this removes your weekly handpan class from your calendar. If this is a mistake, just reply or WhatsApp me.',
    html: shell('<p style="margin:0 0 14px;font-size:16px;">Hi ' + first + ',</p><p style="margin:0;line-height:1.55;">This removes your weekly handpan class from your calendar. If this looks wrong, just reply or WhatsApp me.</p>')
  };
  return {
    subject: tag + 'Calendar update · your handpan classes',
    text: 'Hi ' + first + ', your class times changed, so here is the updated calendar invite. Your calendar should update by itself.',
    html: shell('<p style="margin:0 0 14px;font-size:16px;">Hi ' + first + ',</p><p style="margin:0;line-height:1.55;">Your class times changed, so here is the updated calendar invite. Your calendar should update by itself. You can always see your classes at <a href="https://arpitpandey.com/my" style="color:#500018;">arpitpandey.com/my</a>.</p>')
  };
}

// ── ZOOM CHECK before a first invite ──
// Returns { ok:true } to send, or { ok:false, why } to hold the invite.
// A meeting in Zoom's "Recently Deleted" still answers GET /meetings/{id}, so
// it only counts as alive when it is also in the account's meeting list (and
// that list is trusted only when it shows at least one of our meetings).
let _zoomList = { at: 0, ids: null };
async function zoomListed(ourIds) {
  if (Date.now() - _zoomList.at > 10 * MIN) {
    const ids = new Set(); let next = '', ok = false;
    for (let i = 0; i < 10; i++) {
      const l = await zoomApi('GET', '/users/me/meetings?type=scheduled&page_size=300' + (next ? '&next_page_token=' + next : ''));
      if (!l.ok) { ok = false; break; }
      ok = true;
      for (const m of (l.data.meetings || [])) ids.add(String(m.id));
      next = l.data.next_page_token || ''; if (!next) break;
    }
    _zoomList = { at: Date.now(), ids: ok ? ids : null };
  }
  const ids = _zoomList.ids;
  return ids && ourIds.some(id => ids.has(id)) ? ids : null;
}
function meetingId(link) { return (String(link || '').match(/\/j\/(\d+)/) || [])[1] || null; }
async function zoomGate(row, allSlots) {
  if (!zoomApi) return { ok: true };
  const id = meetingId(row.zoom_link);
  if (!id) return { ok: true };            // no link yet: the invite goes, and updates once a link is added
  const m = await zoomApi('GET', '/meetings/' + id);
  if (!m.ok && m.status === 404) return { ok: false, why: 'their Zoom meeting (' + id + ') was deleted. Make a new "no fixed time" meeting and put the link on their slot' };
  if (!m.ok) return { ok: true };          // Zoom hiccup: don't block the invite on it
  const ours = allSlots.map(r => meetingId(r.zoom_link)).filter(Boolean);
  const listed = await zoomListed(ours).catch(() => null);
  if (listed && !listed.has(String(id))) return { ok: false, why: 'their Zoom meeting (' + id + ') is in Zoom → Meetings → Recently Deleted. Recover it there (same link)' };
  if (Number(m.data.type) !== 3) {
    const p = await zoomApi('PATCH', '/meetings/' + id, { type: 3 });
    const after = p.ok ? await zoomApi('GET', '/meetings/' + id) : null;
    if (after && after.ok && Number(after.data.type) === 3 && after.data.join_url === m.data.join_url) {
      console.log('Calendar invites: Zoom ' + id + ' switched to no fixed time (same link)');
    } else {
      await alert('warning', '⚠️ Zoom meeting ' + id + ' still has fixed times (type ' + m.data.type + '). The calendar invite went out, but switch the meeting to "no fixed time" in Zoom so the link never expires.');
    }
  }
  return { ok: true };
}
const _heldSaid = {};   // slot → day already alerted

// ── DELIVERY CHECK ──
// Resend accepts a mail first and finds out later if the address bounced.
const CHECK_AT = [15 * MIN, 2 * 60 * MIN, 24 * 60 * MIN];
const BAD = { bounced: 'bounced (the address does not take mail)', complained: 'was marked as spam', failed: 'could not be sent', suppressed: 'was blocked (this address bounced before)' };
let _checks = null, _checkOff = false;
async function loadChecks() {
  if (_checks) return _checks;
  try { const { data } = await supabase.from('app_settings').select('value').eq('key', 'invite_checks').maybeSingle(); _checks = (data && Array.isArray(data.value)) ? data.value : []; }
  catch (e) { _checks = []; }
  return _checks;
}
async function saveChecks() { try { await supabase.from('app_settings').upsert({ key: 'invite_checks', value: _checks.slice(-200) }, { onConflict: 'key' }); } catch (e) {} }
async function trackDelivery(id, student, to, kind) {
  if (!id || _checkOff) return;
  await loadChecks();
  _checks.push({ id, student: student.full_name || student.id, sid: student.id, to, kind, at: Date.now(), n: 0 });
  await saveChecks();
}
async function checkDeliveries() {
  if (!RESEND_API_KEY || _checkOff) return;
  await loadChecks();
  if (!_checks.length) return;
  const now = Date.now(); let changed = false; const said = new Set();
  for (const c of _checks.slice()) {
    if (now - c.at < CHECK_AT[c.n]) continue;
    const r = await fetch('https://api.resend.com/emails/' + c.id, { headers: { Authorization: 'Bearer ' + RESEND_API_KEY } }).catch(() => null);
    if (r && (r.status === 401 || r.status === 403)) {
      _checkOff = true; _checks = []; await saveChecks();
      console.log('Calendar invites: delivery check off (this Resend key can only send). Use a full-access key to turn it on.');
      return;
    }
    if (!r || !r.ok) continue;             // try again next round
    const j = await r.json().catch(() => ({}));
    const ev = String(j.last_event || '');
    const done = () => { _checks.splice(_checks.indexOf(c), 1); changed = true; };
    if (BAD[ev]) {
      if (!said.has(c.to + ev)) await alert('warning', '📭 Calendar invite to ' + c.student + ' ' + BAD[ev] + ': ' + c.to + '. Fix their email in Students; the invite goes again by itself.');
      said.add(c.to + ev);
      console.log('Calendar invite ' + ev + ': ' + c.student + ' <' + c.to + '>');
      done();
    } else if (['delivered', 'opened', 'clicked'].includes(ev)) done();
    else { c.n++; changed = true; if (c.n >= CHECK_AT.length) done(); }
  }
  if (changed) await saveChecks();
}

// ── WORKER ──
async function load() {
  const today = istYmd(Date.now());
  const [sch, st, ex, rec] = await Promise.all([
    supabase.from('class_schedule').select('*'),
    supabase.from('students').select('*'),
    supabase.from('class_exceptions').select('student_id, original_date, action, new_date, new_time_ist, makeup'),
    supabase.from('calendar_invites').select('*')
  ]);
  for (const r of [sch, st, ex, rec]) if (r.error) throw new Error(r.error.message);
  return { today, slots: sch.data || [], students: st.data || [], exceptions: ex.data || [], records: rec.data || [] };
}

// Returns the list of actions; sends them unless dry.
async function run({ dry = false, only = null, again = null } = {}) {
  const m = mode();
  if (m === 'off' && !dry) return { mode: m, actions: [] };
  const d = await load();
  const studentById = Object.fromEntries(d.students.map(s => [s.id, s]));
  const recBySlot = Object.fromEntries(d.records.map(r => [String(r.slot_id), r]));
  const actions = [];
  for (const row of d.slots) {
    if (only && row.student_id !== only) continue;
    if (again && !again.has(String(row.id))) continue;
    const student = studentById[row.student_id];
    const rec = recBySlot[String(row.id)];
    const live = row.active !== false && student && !student.archived && !!student.email;
    if (!live) {
      if (rec && !rec.cancelled_at && rec.hash) actions.push({ kind: 'cancel', row, student: student || { id: row.student_id, email: rec.recipient }, rec });
      continue;
    }
    const sig = slotSig(row);
    const rule = slotRule(row);
    // The series starts at the next class when it's new or its day/time changed.
    const anchor = rec && rec.anchor && rec.slot_sig === sig && !rec.cancelled_at ? String(rec.anchor).slice(0, 10) : firstOn(rule, partsIn(Date.now() - rule.dur * MIN, rule.tz).ymd);
    const recipient = m === 'test' ? ARPIT_EMAIL : emailsOf(student).join(',');
    const seq = rec ? (Number(rec.seq) || 0) + 1 : 0;
    const exs = d.exceptions.filter(e => e.student_id === row.student_id && String(e.original_date).slice(0, 10) >= addDays(anchor, -1));
    const built = buildIcs({ row, student, anchor, exceptions: exs, seq, method: 'REQUEST' });
    const isNew = !rec || rec.cancelled_at || rec.recipient !== recipient || rec.slot_sig !== sig;
    if (!isNew && rec.hash === built.hash && !again) continue;
    actions.push({ kind: isNew ? 'new' : again ? 'again' : 'update', row, student, rec, anchor, sig, recipient, seq, built });
  }
  if (dry) return { mode: m, actions: actions.map(a => ({ kind: a.kind, student: a.student.full_name || a.student.id, slot: a.row.id, to: a.recipient || (a.rec && a.rec.recipient), changes: a.built ? a.built.summary : null })) };
  const done = [];
  for (const a of actions.slice(0, MAX_PER_RUN)) {
    try {
      if (a.kind === 'cancel') {
        const seq = (Number(a.rec.seq) || 0) + 1;
        const built = buildIcs({ row: a.row, student: a.student, anchor: String(a.rec.anchor || d.today).slice(0, 10), exceptions: [], seq, method: 'CANCEL' });
        const mail = mailFor('cancel', a.student, m === 'test');
        const r = await sendMail({ to: a.rec.recipient, ...mail, ics: built.ics, method: 'CANCEL' });
        if (!r.ok) throw new Error(r.error);
        await supabase.from('calendar_invites').update({ seq, cancelled_at: new Date().toISOString(), last_sent_at: new Date().toISOString() }).eq('id', a.rec.id);
      } else {
        if (a.kind === 'new') {
          const g = await zoomGate(a.row, d.slots.filter(r => r.active !== false));
          if (!g.ok) {
            const today = istYmd(Date.now());
            if (_heldSaid[a.row.id] !== today) { _heldSaid[a.row.id] = today; await alert('warning', '🔴 Calendar invite for ' + (a.student.full_name || a.row.student_id) + ' is on hold: ' + g.why + '. It goes out by itself once that is fixed.'); }
            console.log('Calendar invite held (' + (a.student.full_name || a.row.student_id) + '): ' + g.why);
            continue;
          }
        }
        const mail = mailFor(a.kind, a.student, m === 'test');
        const r = await sendMail({ to: a.recipient, ...mail, ics: a.built.ics, method: 'REQUEST' });
        if (!r.ok) throw new Error(r.error);
        await trackDelivery(r.id, a.student, a.recipient, a.kind);
        const row = { slot_id: String(a.row.id), student_id: a.row.student_id, recipient: a.recipient, seq: a.seq, hash: a.built.hash, slot_sig: a.sig, anchor: a.anchor, last_sent_at: new Date().toISOString(), cancelled_at: null };
        if (a.rec) await supabase.from('calendar_invites').update(row).eq('id', a.rec.id);
        else await supabase.from('calendar_invites').insert(row);
      }
      done.push(a.kind + ' ' + (a.student.full_name || a.student.id));
    } catch (e) {
      console.error('Calendar invite failed (' + (a.student.full_name || a.row.student_id) + '):', e.message);
      await alert('warning', '🔴 Calendar invite not sent to ' + (a.student.full_name || a.row.student_id) + ': ' + e.message);
    }
  }
  if (done.length) console.log('Calendar invites (' + m + '):', done.join(', '));
  return { mode: m, sent: done };
}

// Send the same invite again: { student } = all their live slots, { slot } = one.
// Same UID and a higher SEQUENCE, so the calendar updates the entry it has.
async function resend({ student = null, slot = null } = {}) {
  if (mode() === 'off') return { ok: false, code: 'off', error: 'Calendar invites are off' };
  let q = supabase.from('class_schedule').select('id, student_id, active');
  q = slot ? q.eq('id', slot) : q.eq('student_id', student);
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  const live = (data || []).filter(r => r.active !== false);
  if (!live.length) return { ok: false, code: 'no_slot', error: 'No active weekly class' };
  if (_busy) return { ok: false, code: 'busy', error: 'busy' };
  _busy = true;
  try {
    const r = await run({ only: live[0].student_id, again: new Set(live.map(x => String(x.id))) });
    return { ok: (r.sent || []).length > 0, sent: r.sent || [], mode: r.mode, error: (r.sent || []).length ? null : 'Not sent' };
  } finally { _busy = false; }
}

// Preview the .ics a student would get right now (dashboard / testing).
async function preview(studentId) {
  const d = await load();
  const student = d.students.find(s => s.id === studentId);
  if (!student) return { error: 'No student ' + studentId };
  const rows = d.slots.filter(r => r.student_id === studentId && r.active !== false);
  return rows.map(row => {
    const rule = slotRule(row);
    const rec = d.records.find(r => String(r.slot_id) === String(row.id));
    const anchor = rec && rec.anchor && rec.slot_sig === slotSig(row) ? String(rec.anchor).slice(0, 10) : firstOn(rule, partsIn(Date.now(), rule.tz).ymd);
    const b = buildIcs({ row, student, anchor, exceptions: d.exceptions.filter(e => e.student_id === studentId), seq: rec ? rec.seq : 0, method: 'REQUEST' });
    return { slot: row.id, anchor, changes: b.summary, ics: b.ics };
  });
}

let _timer = null, _busy = false;
function startWorker() {
  if (_timer) return;
  console.log('Calendar invites: ' + mode() + ' (every 10 min)');
  const tick = async () => {
    if (_busy || mode() === 'off') return;
    _busy = true;
    try { await run(); } catch (e) { console.error('Calendar invites run failed:', e.message); }
    finally { _busy = false; }
  };
  setTimeout(tick, 60 * 1000);
  _timer = setInterval(tick, TICK_MS);
  setInterval(() => { checkDeliveries().catch(e => console.error('Invite delivery check failed:', e.message)); }, 5 * MIN);
  // Can this Resend key read delivery status? (a send-only key answers 401)
  if (RESEND_API_KEY) fetch('https://api.resend.com/emails/00000000-0000-0000-0000-000000000000', { headers: { Authorization: 'Bearer ' + RESEND_API_KEY } })
    .then(r => { if (r.status === 401 || r.status === 403) { _checkOff = true; console.log('Invite delivery check: off (this Resend key can only send)'); } else console.log('Invite delivery check: on (15 min, 2 h, 24 h after each invite)'); })
    .catch(() => {});
}

// Admin endpoints
async function statusHandler(req, res) {
  try { res.json(await run({ dry: true })); } catch (e) { res.status(500).json({ error: e.message }); }
}
async function previewHandler(req, res) {
  try { res.json(await preview(String(req.query.student || ''))); } catch (e) { res.status(500).json({ error: e.message }); }
}
async function runHandler(req, res) {
  if (_busy) return res.status(409).json({ error: 'busy' });
  _busy = true;
  try { res.json(await run()); } catch (e) { res.status(500).json({ error: e.message }); }
  finally { _busy = false; }
}

module.exports = { init, startWorker, run, resend, preview, statusHandler, previewHandler, runHandler, checkDeliveries, _test: { buildIcs, slotRule, firstOn, zonedToUtc, fold, zoomGate, _set: o => { if ('zoomApi' in o) zoomApi = o.zoomApi; if ('checks' in o) _checks = o.checks; if ('off' in o) _checkOff = o.off; } } };
