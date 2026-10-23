// zoom-service.js
// Zoom attendance auto-log. Runs inside the Railway webhook server.
//
// Flow:
//   1. Zoom calls POST /api/webhooks/zoom when a meeting ends. We verify the
//      signature and store the meeting in zoom_meetings as 'pending'. Nothing
//      else happens in the request, so Zoom always gets a fast 200.
//   2. A worker runs every 5 minutes. For pending meetings that ended at least
//      10 minutes ago (Zoom's report data lags), it pulls the participant
//      report, cleans it, matches people to students and logs classes.
//   3. People it cannot match (20+ minutes) go to zoom_unmatched. The
//      dashboard shows them and Arpit picks the student in one tap.
//   4. Trial meetings ("trial" or "trail" in the title): people who are not
//      known students go straight into the trials table instead of review.
//      Only email and saved Zoom names count as a match there, never a bare
//      first name or the topic, so a new "Sasha" is not logged as an old one.
//
// Never throws out to the server. Every failure becomes a log line, a
// retry, or a dashboard notification.

const crypto = require('crypto');

const ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID || '';
const CLIENT_ID = process.env.ZOOM_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || '';
const WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET || '';

const MIN_MINUTES = Number(process.env.ZOOM_MIN_MINUTES) || 20;   // attendance needed to count a class
const TRIAL_MIN_MINUTES = Number(process.env.ZOOM_TRIAL_MIN_MINUTES) || 10;   // a trial attendee needs this much
const REPORT_DELAY_MIN = 10;                                        // wait this long after a meeting ends
const MAX_ATTEMPTS = 6;                                             // then give up and notify
const WORKER_EVERY_MS = 5 * 60 * 1000;

// Host and co-facilitator never count as students. Extra entries can be added
// from Railway without a code change (comma separated).
function envList(name) {
  return String(process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
}
const IGNORE_EMAILS = ['arpitbam@gmail.com', 'arpithandpan@gmail.com', 'ankitasinha1803@gmail.com']
  .concat(envList('ZOOM_IGNORE_EMAILS')).map(normEmail);
const IGNORE_NAMES = ['Arpit Pandey', 'Arpit', 'Ankita Sinha', 'Ankita', 'iPad (4)']
  .concat(envList('ZOOM_IGNORE_NAMES')).map(normName);

let supabase = null;
function init(client) { supabase = client; }
let trialHook = null;
function setTrialHook(fn) { trialHook = fn; }

function isConfigured() { return !!(ACCOUNT_ID && CLIENT_ID && CLIENT_SECRET); }

// ── small helpers ──
function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function normName(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function firstWord(s) { return normName(s).split(' ')[0] || ''; }
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }
// "Handpan Trial - Adrienne", "free trial", "TRAIL class" → true. Matches whole words only.
function isTrialTopic(topic) {
  const t = ' ' + normName(topic) + ' ';
  return [' trial ', ' trials ', ' trail ', ' trails '].some(w => t.includes(w));
}
function istDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d)) return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function prettyDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd || '';
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return Number(m[3]) + ' ' + mons[Number(m[2]) - 1];
}

async function notify(type, message) {
  try { await supabase.from('notifications').insert({ type, message, read: false }); }
  catch (e) { console.error('zoom notify failed:', e.message); }
}

// ── AUTO FEE REQUEST (zero-touch renewals) ──
// When a student's classes hit 0, create the next fee request automatically
// by copying their most recent request (same classes, amount, currency).
// "Whatever they took last time is what renews." The WhatsApp worker in
// whatsapp-service.js then picks the new pending request up and sends the
// fee_link template by itself. A special case (discount, package change) is
// handled the old way: Arpit cancels the auto request in the dashboard and
// creates one by hand — a manual request always wins.
//
// Gated by AUTO_FEE_REQUESTS = 'on' in Railway, so it can be rolled out
// together with WA_STUDENT_SENDS. Off = the old "send a fee link" alert.
function autoFeeRequestsOn() {
  return String(process.env.AUTO_FEE_REQUESTS || '').trim().toLowerCase() === 'on';
}

function currentMonthYM() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
}

async function nextFeeRequestId() {
  const { data } = await supabase.from('fee_requests')
    .select('id').like('id', 'FR-%').order('id', { ascending: false }).limit(1);
  if (data && data.length > 0) {
    const lastNum = parseInt(data[0].id.replace('FR-', ''), 10) || 0;
    return 'FR-' + String(lastNum + 1).padStart(3, '0');
  }
  return 'FR-001';
}

// Returns { created: true, id, classes, amount, currency } when a renewal
// request was made, or { created: false, reason } otherwise. Never throws.
async function maybeAutoRenewal(student) {
  try {
    if (!autoFeeRequestsOn()) return { created: false, reason: 'off' };

    // Already being chased? Then nothing to do — one pending request at a time.
    const { data: pending } = await supabase.from('fee_requests')
      .select('id').eq('student_id', student.id).eq('status', 'pending').limit(1);
    if (pending && pending.length) return { created: false, reason: 'pending_exists' };

    // Copy the most recent non-cancelled request as the package template.
    const { data: prevRows } = await supabase.from('fee_requests')
      .select('id, classes, amount, currency, list_amount, discount_pct, status')
      .eq('student_id', student.id).neq('status', 'cancelled')
      .order('id', { ascending: false }).limit(1);
    const prev = prevRows && prevRows[0];
    if (!prev || !(Number(prev.amount) > 0)) return { created: false, reason: 'no_previous' };

    const id = await nextFeeRequestId();
    const { error } = await supabase.from('fee_requests').insert({
      id,
      student_id: student.id,
      classes: prev.classes,
      amount: prev.amount,
      currency: prev.currency || 'INR',
      list_amount: prev.list_amount || null,
      discount_pct: prev.discount_pct || null,
      month: currentMonthYM(),
      note: 'Auto renewal (copied from ' + prev.id + ')',
      status: 'pending'
    });
    if (error) {
      console.error('auto fee request insert failed:', student.id, error.message);
      return { created: false, reason: error.message };
    }
    console.log('Auto fee request created:', id, 'for', student.id, '(from ' + prev.id + ')');
    return { created: true, id, classes: prev.classes, amount: prev.amount, currency: (prev.currency || 'INR').toUpperCase() };
  } catch (e) {
    console.error('maybeAutoRenewal error:', e.message);
    return { created: false, reason: e.message };
  }
}

// ── 1. WEBHOOK ──
function hmac(msg) { return crypto.createHmac('sha256', WEBHOOK_SECRET).update(msg).digest('hex'); }

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function webhookHandler(req, res) {
  try {
    if (!WEBHOOK_SECRET) {
      console.warn('Zoom webhook hit but ZOOM_WEBHOOK_SECRET is not set');
      return res.status(503).json({ error: 'Zoom not configured' });
    }
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
    let body;
    try { body = JSON.parse(raw); } catch (e) { return res.status(400).json({ error: 'Bad JSON' }); }

    // Zoom checks the URL when it is saved in the app. The reply proves we
    // hold the secret token, nothing else is revealed.
    if (body.event === 'endpoint.url_validation') {
      const plainToken = body.payload && body.payload.plainToken;
      if (!plainToken) return res.status(400).json({ error: 'Missing plainToken' });
      console.log('Zoom URL validation OK');
      return res.status(200).json({ plainToken, encryptedToken: hmac(plainToken) });
    }

    // Everything else must carry a valid signature.
    const ts = req.headers['x-zm-request-timestamp'];
    const sig = req.headers['x-zm-signature'];
    const expected = 'v0=' + hmac('v0:' + ts + ':' + raw);
    if (!ts || !sig || !safeEqual(sig, expected)) {
      console.warn('Invalid Zoom webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    // Replay guard: reject events older than 10 minutes.
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) {
      console.warn('Stale Zoom webhook timestamp');
      return res.status(401).json({ error: 'Stale request' });
    }

    console.log('Zoom event:', body.event);

    // Live state for the dashboard's Today card (who is in the room right now).
    try { liveEvent(body); } catch (e) { console.warn('zoom live state:', e.message); }

    if (body.event === 'meeting.ended') {
      const o = (body.payload && body.payload.object) || {};
      if (!o.uuid) return res.status(200).json({ received: true, skipped: 'no uuid' });
      const { error } = await supabase.from('zoom_meetings').upsert({
        uuid: o.uuid,
        meeting_id: o.id != null ? String(o.id) : null,
        topic: o.topic || null,
        host_id: o.host_id || null,
        start_time: o.start_time || null,
        end_time: o.end_time || new Date().toISOString(),
        duration: o.duration != null ? Number(o.duration) || null : null,
        status: 'pending',
        raw: body
      }, { onConflict: 'uuid', ignoreDuplicates: true });
      if (error) {
        console.error('zoom_meetings insert failed:', error.message);
        await notify('warning', `⚠️ Zoom meeting "${o.topic || o.id}" ended but could not be saved: ${error.message}`);
        return res.status(500).json({ error: 'Could not save meeting' });
      }
      console.log('Zoom meeting queued:', o.uuid, o.topic);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Zoom webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── 1b. LIVE STATE ──
// Zoom tells us when a meeting starts, when people join and leave, and when
// it ends. We keep that in memory (one small entry per meeting) so the Today
// card can say "Ananya is waiting" or "Live · 23 min". A restart only loses
// the picture for meetings already running; the card then falls back to the
// clock, which is what it did before.
const LIVE = new Map();              // meeting id → state
const LIVE_KEEP_MS = 30 * 60 * 1000; // ended meetings stay 30 min for "Class done"

function isHostish(pt, hostId) {
  if (!pt) return false;
  if (hostId && pt.id && pt.id === hostId) return true;
  if (pt.email && IGNORE_EMAILS.includes(normEmail(pt.email))) return true;
  const nn = normName(pt.user_name);
  return !!(nn && IGNORE_NAMES.includes(nn));
}
function liveEntry(o) {
  const id = String(o.id || '');
  let m = LIVE.get(id);
  if (!m || (o.uuid && m.uuid && m.uuid !== o.uuid && m.endedAt)) {
    m = { meetingId: id, uuid: o.uuid || null, topic: o.topic || '', startedAt: null, endedAt: null, hostIn: false, people: new Map(), bothSince: null };
    LIVE.set(id, m);
  }
  if (o.uuid) m.uuid = o.uuid;
  if (o.topic) m.topic = o.topic;
  return m;
}
function liveRecalc(m, at) {
  const both = m.hostIn && [...m.people.values()].some(p => p.n > 0);
  if (both && !m.bothSince) m.bothSince = at;
}
function liveEvent(body) {
  const ev = body.event || '';
  if (!/^meeting\.(started|ended|participant_joined|participant_left|participant_jbh_waiting)$/.test(ev)) return;
  const o = (body.payload && body.payload.object) || {};
  if (!o.id) return;
  const now = new Date(body.event_ts || Date.now()).toISOString();
  const m = liveEntry(o);
  if (ev === 'meeting.started') { m.startedAt = o.start_time || now; m.endedAt = null; return; }
  if (ev === 'meeting.ended') { m.endedAt = o.end_time || now; m.hostIn = false; m.people.clear(); return; }
  const pt = o.participant || {};
  // Waiting in the lobby because the host has not started the meeting yet.
  // The person shows as "waiting" but holds no device count, so the real
  // join (when the host starts) and the leave still pair up.
  if (ev === 'meeting.participant_jbh_waiting') {
    if (isHostish(pt, o.host_id)) return;
    const k = normEmail(pt.email) || normName(pt.user_name) || String(pt.user_id || pt.participant_uuid || '');
    if (!k || m.people.has(k)) return;
    m.people.set(k, { name: String(pt.user_name || pt.email || 'Someone').trim(), since: pt.date_time || now, n: 0, lobby: true });
    m.endedAt = null;
    return;
  }
  if (!m.startedAt) m.startedAt = now;
  m.endedAt = null;
  const at = (ev === 'meeting.participant_joined' ? pt.join_time : pt.leave_time) || now;
  if (isHostish(pt, o.host_id)) {
    m.hostIn = ev === 'meeting.participant_joined';
    if (m.hostIn) liveRecalc(m, at);
    return;
  }
  // One person can join on two devices or rejoin, so key by name/email, and
  // count the devices: they only leave when the last one does.
  const key = normEmail(pt.email) || normName(pt.user_name) || String(pt.user_id || pt.participant_uuid || '');
  if (!key) return;
  const cur = m.people.get(key) || { name: String(pt.user_name || pt.email || 'Someone').trim(), since: at, n: 0 };
  if (ev === 'meeting.participant_joined') {
    cur.n += 1; if (cur.n === 1 && !cur.lobby) cur.since = at;
    cur.lobby = false;
    m.people.set(key, cur);
    liveRecalc(m, at);
  } else {
    cur.n -= 1;
    if (cur.n <= 0) m.people.delete(key); else m.people.set(key, cur);
  }
}
function liveList() {
  const cut = Date.now() - LIVE_KEEP_MS;
  const out = [];
  for (const [id, m] of LIVE) {
    if (m.endedAt && new Date(m.endedAt).getTime() < cut) { LIVE.delete(id); continue; }
    if (!m.endedAt && m.startedAt && Date.now() - new Date(m.startedAt).getTime() > 6 * 3600e3) { LIVE.delete(id); continue; }
    out.push({
      meetingId: m.meetingId, topic: m.topic, startedAt: m.startedAt, endedAt: m.endedAt,
      hostIn: m.hostIn, bothSince: m.bothSince,
      people: [...m.people.values()].map(p => ({ name: p.name, since: p.since, lobby: !!p.lobby }))
    });
  }
  return out;
}
function liveHandler(req, res) {
  res.json({ ok: true, now: new Date().toISOString(), meetings: liveList() });
}

// ── 2. ZOOM API ──
let _tok = null, _tokExp = 0;
async function zoomToken(force) {
  if (!force && _tok && Date.now() < _tokExp - 60000) return _tok;
  const auth = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const r = await fetch('https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' + encodeURIComponent(ACCOUNT_ID), {
    method: 'POST', headers: { 'Authorization': 'Basic ' + auth }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Zoom sign-in failed: ' + (j.reason || j.error || ('HTTP ' + r.status)));
  _tok = j.access_token;
  _tokExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return _tok;
}

// Zoom rule: a UUID that starts with "/" or contains "//" must be encoded twice.
function encodeUuid(uuid) {
  const once = encodeURIComponent(uuid);
  return (uuid.startsWith('/') || uuid.includes('//')) ? encodeURIComponent(once) : once;
}

async function zoomGet(url) {
  let r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + await zoomToken() } });
  if (r.status === 401) r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + await zoomToken(true) } });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

async function fetchParticipants(uuid) {
  const out = [];
  let next = '';
  for (let page = 0; page < 20; page++) {
    const url = 'https://api.zoom.us/v2/report/meetings/' + encodeUuid(uuid) + '/participants?page_size=300'
      + (next ? '&next_page_token=' + encodeURIComponent(next) : '');
    const { r, j } = await zoomGet(url);
    if (r.status === 404 || j.code === 3001) {
      const e = new Error('Zoom report not ready yet (' + (j.message || 'HTTP 404') + ')');
      e.notReady = true;
      throw e;
    }
    if (!r.ok) throw new Error('Zoom report error HTTP ' + r.status + (j.message ? ': ' + j.message : ''));
    (j.participants || []).forEach(p => out.push(p));
    next = j.next_page_token || '';
    if (!next) break;
  }
  return out;
}

// ── 3. CLEANING ──
// Drops host, ignore list and waiting-room rows. Merges rejoins of the same
// person (by email, else by name) and adds up their minutes.
function cleanParticipants(rows, hostId) {
  const people = new Map();
  for (const p of rows || []) {
    if (p.status === 'in_waiting_room') continue;
    const email = normEmail(p.user_email);
    const name = String(p.name || '').trim();
    const nn = normName(name);
    if (hostId && p.id && p.id === hostId) continue;
    if (email && IGNORE_EMAILS.includes(email)) continue;
    if (nn && IGNORE_NAMES.includes(nn)) continue;
    if (!email && !nn) continue;

    const key = email ? 'e:' + email : 'n:' + nn;
    const cur = people.get(key) || { key, email: email || null, names: [], seconds: 0 };
    cur.seconds += Number(p.duration) || 0;
    if (name && !cur.names.includes(name)) cur.names.push(name);
    people.set(key, cur);
  }
  // A person who joined once signed in (email) and once as a guest (name only)
  // is still one person: fold name-only entries into an email entry with the same name.
  for (const [key, p] of people) {
    if (!key.startsWith('n:')) continue;
    const twin = [...people.values()].find(o => o.email && o.names.some(n => normName(n) === key.slice(2)));
    if (twin) { twin.seconds += p.seconds; people.delete(key); }
  }
  return [...people.values()].map(p => ({ ...p, name: p.names[0] || p.email || '', minutes: Math.round(p.seconds / 60) }));
}

// ── 4. MATCHING ──
function buildIndex(students) {
  const byEmail = new Map(), byName = new Map(), byFirst = new Map();
  const put = (map, k, s) => {
    if (!k) return;
    if (map.has(k) && map.get(k) && map.get(k).id !== s.id) map.set(k, null);   // two students share it → ambiguous
    else if (!map.has(k)) map.set(k, s);
  };
  for (const s of students) {
    if (s.email) put(byEmail, normEmail(s.email), s);
    for (const z of (s.zoom_names || [])) {
      if (isEmail(z)) put(byEmail, normEmail(z), s);
      else put(byName, normName(z), s);
    }
    put(byName, normName(s.full_name), s);
    const f = firstWord(s.full_name);
    if (f.length >= 3) put(byFirst, f, s);
  }
  return { byEmail, byName, byFirst };
}

function matchPerson(person, idx, strict) {
  if (person.email && idx.byEmail.get(person.email)) return { student: idx.byEmail.get(person.email), how: 'email' };
  for (const n of person.names) {
    const s = idx.byName.get(normName(n));
    if (s) return { student: s, how: 'zoom name' };
  }
  if (strict) return null;   // trial meetings: no first-name guesses
  for (const n of person.names) {
    const nn = normName(n);
    const s = !nn.includes(' ') ? idx.byFirst.get(nn) : null;   // "Sahana" alone → Sahana
    if (s) return { student: s, how: 'first name' };
  }
  return null;
}

// Students named in the meeting topic, by full name, first name or payer name.
function studentsInTopic(topic, students) {
  const t = ' ' + normName(topic) + ' ';
  if (!t.trim()) return [];
  return students.filter(s => {
    const terms = [normName(s.full_name), firstWord(s.full_name), normName(s.payer_name), firstWord(s.payer_name)]
      .filter(x => x && x.length >= 3);
    return terms.some(x => t.includes(' ' + x + ' '));
  });
}

// Pure: decide what to do with a cleaned meeting. No DB calls, easy to test.
function planMeeting(people, students, topic) {
  const isTrial = isTrialTopic(topic);
  const idx = buildIndex(students);
  const byStudent = new Map();   // student id → { student, minutes, names, email, how }
  const unmatched = [];
  for (const p of people) {
    const m = matchPerson(p, idx, isTrial);
    if (!m) { unmatched.push(p); continue; }
    const cur = byStudent.get(m.student.id) || { student: m.student, minutes: 0, names: [], email: null, how: m.how };
    cur.minutes += p.minutes;
    p.names.forEach(n => { if (!cur.names.includes(n)) cur.names.push(n); });
    if (p.email && !cur.email) cur.email = p.email;
    byStudent.set(m.student.id, cur);
  }

  // Topic match: only when it is unambiguous. One student named in the topic,
  // not already matched, and exactly one unmatched person who stayed long enough.
  const learn = [];
  const longUnmatched = unmatched.filter(p => p.minutes >= MIN_MINUTES);
  const topicStudents = isTrial ? [] : studentsInTopic(topic, students).filter(s => !byStudent.has(s.id));
  if (topicStudents.length === 1 && longUnmatched.length === 1) {
    const p = longUnmatched[0], s = topicStudents[0];
    byStudent.set(s.id, { student: s, minutes: p.minutes, names: p.names.slice(), email: p.email, how: 'meeting topic' });
    learn.push({ student: s, names: p.names, email: p.email });
    unmatched.splice(unmatched.indexOf(p), 1);
  }

  const toLog = [...byStudent.values()].filter(x => x.minutes >= MIN_MINUTES);
  const short = [...byStudent.values()].filter(x => x.minutes < MIN_MINUTES);
  if (isTrial) {
    const trials = unmatched.filter(p => p.minutes >= TRIAL_MIN_MINUTES);
    const ignoredShort = unmatched.filter(p => p.minutes < TRIAL_MIN_MINUTES);
    return { toLog, short, review: [], trials, ignoredShort, learn, isTrial };
  }
  const review = unmatched.filter(p => p.minutes >= MIN_MINUTES);
  const ignoredShort = unmatched.filter(p => p.minutes < MIN_MINUTES);
  return { toLog, short, review, trials: [], ignoredShort, learn, isTrial };
}

// ── 5. DB WRITES ──
// Classes paid for = sum of classes on fee payments that are not marked unpaid.
// Same rule as the dashboard's Remaining column.
async function paidClasses(studentId) {
  const { data } = await supabase.from('fee_payments').select('classes, paid').eq('student_id', studentId);
  return (data || []).filter(f => f.paid !== false).reduce((a, f) => a + (Number(f.classes) || 0), 0);
}

// Log one class. Skips if the student already has any class on that date.
// First class of a brand new student (nothing paid, nothing logged) is a free trial.
async function logClass({ student, classDate, minutes, meetingUuid, how }) {
  const { data: sameDay } = await supabase.from('class_log').select('id')
    .eq('student_id', student.id).eq('class_date', classDate).limit(1);
  if (sameDay && sameDay.length) return { skipped: 'already_logged' };

  const paid = await paidClasses(student.id);
  const { data: logs } = await supabase.from('class_log').select('id, is_free').eq('student_id', student.id);
  const allLogs = logs || [];
  const isFree = paid === 0 && allLogs.length === 0;
  const note = (isFree ? 'Free trial · ' : '') + 'Auto from Zoom · ' + minutes + ' min';

  const { error } = await supabase.from('class_log').insert({
    student_id: student.id, class_date: classDate, note, is_free: isFree,
    source: 'zoom', zoom_meeting_uuid: meetingUuid || null
  });
  if (error) {
    if (error.code === '23505') return { skipped: 'already_logged' };
    throw new Error('class_log insert failed for ' + student.id + ': ' + error.message);
  }

  const name = student.full_name || student.id;
  if (isFree) {
    await notify('info', `🎥 Free trial logged from Zoom: ${name} · ${prettyDate(classDate)} · ${minutes} min`);
  } else {
    const taken = allLogs.filter(l => !l.is_free).length + 1;
    const remaining = paid - taken;
    await notify('info', `🎥 Class logged from Zoom: ${name} · ${prettyDate(classDate)} · ${minutes} min (${how})`);
    if (remaining <= 0) {
      const deficit = remaining === 0
        ? `0 classes left after the ${prettyDate(classDate)} class`
        : `${-remaining} unpaid class${remaining === -1 ? '' : 'es'} after ${prettyDate(classDate)}`;
      const auto = await maybeAutoRenewal(student);
      if (auto.created) {
        const sym = auto.currency === 'INR' ? '₹' : auto.currency + ' ';
        await notify('payment', `💳 ${name} has ${deficit}. Renewal ${auto.id} created automatically (${auto.classes} classes, ${sym}${auto.amount}) — the WhatsApp link goes out by itself. Cancel ${auto.id} in the dashboard if the package should change.`);
      } else if (auto.reason === 'pending_exists') {
        await notify('payment', `💳 ${name} has ${deficit}. A fee request is already pending for them.`);
      } else {
        await notify('payment', `💳 ${name} has ${deficit}. Time to send a fee link.`);
      }
    }
  }
  return { logged: true, isFree };
}

// Remember new Zoom names / email on the student so the next class matches by itself.
async function learnNames(studentId, names, email) {
  const { data: s } = await supabase.from('students').select('id, full_name, email, zoom_names').eq('id', studentId).maybeSingle();
  if (!s) return;
  const list = Array.isArray(s.zoom_names) ? s.zoom_names.slice() : [];
  const have = new Set(list.map(x => isEmail(x) ? normEmail(x) : normName(x)));
  have.add(normName(s.full_name));
  if (s.email) have.add(normEmail(s.email));
  let changed = false;
  for (const n of names || []) {
    const k = normName(n);
    if (k && !have.has(k)) { list.push(String(n).trim()); have.add(k); changed = true; }
  }
  const e = normEmail(email);
  if (e && !have.has(e)) { list.push(e); changed = true; }
  if (changed) {
    const { error } = await supabase.from('students').update({ zoom_names: list }).eq('id', studentId);
    if (error) console.error('learnNames failed:', studentId, error.message);
  }
}

async function failMeeting(m, err) {
  const attempts = (Number(m.attempts) || 0) + 1;
  const final = attempts >= MAX_ATTEMPTS;
  await supabase.from('zoom_meetings').update({
    attempts, last_error: err.message, status: final ? 'error' : 'pending',
    processed_at: final ? new Date().toISOString() : null
  }).eq('uuid', m.uuid);
  console.warn('Zoom meeting', m.uuid, 'attempt', attempts, 'failed:', err.message);
  if (final) {
    await notify('warning', `⚠️ Zoom attendance could not be read for "${m.topic || m.meeting_id}" on ${prettyDate(istDate(m.start_time))}: ${err.message}. Log it by hand if it was a class.`);
  }
}

async function processMeeting(m) {
  let rows;
  try {
    rows = await fetchParticipants(m.uuid);
    if (!rows.length) { const e = new Error('Zoom returned no participants yet'); e.notReady = true; throw e; }
  } catch (e) { return failMeeting(m, e); }

  const classDate = istDate(m.start_time || m.end_time);
  const people = cleanParticipants(rows, m.host_id);

  if (!people.length) {
    await supabase.from('zoom_meetings').update({
      status: 'no_attendees', processed_at: new Date().toISOString(), last_error: null,
      result: { classDate, participantsRows: rows.length, people: 0 }
    }).eq('uuid', m.uuid);
    console.log('Zoom meeting', m.uuid, 'had no students (host only)');
    return;
  }

  try {
    const { data: stuRows, error: sErr } = await supabase.from('students')
      .select('id, full_name, email, payer_name, zoom_names, status, archived');
    if (sErr) throw new Error('students lookup failed: ' + sErr.message);
    const students = (stuRows || []).filter(s => !s.archived);

    const plan = planMeeting(people, students, m.topic);
    const logged = [];

    for (const x of plan.toLog) {
      const r = await logClass({ student: x.student, classDate, minutes: x.minutes, meetingUuid: m.uuid, how: x.how });
      logged.push({ student: x.student.id, minutes: x.minutes, how: x.how, ...r });
    }
    for (const l of plan.learn) await learnNames(l.student.id, l.names, l.email);

    // A known student who was there, but for less than MIN_MINUTES in this
    // meeting: not counted. Say so, so a dropped connection never goes
    // unnoticed. Quiet if that day's class is already logged (for example
    // from a second meeting after a restart).
    for (const x of plan.short) {
      if (!x.minutes) continue;
      const { data: sameDay } = await supabase.from('class_log').select('id')
        .eq('student_id', x.student.id).eq('class_date', classDate).limit(1);
      if (sameDay && sameDay.length) continue;
      const name = x.student.full_name || x.student.id;
      await notify('warning', `⏱️ ${name} joined only ${x.minutes} min on ${prettyDate(classDate)}, so the class wasn't counted. Log it from the dashboard if the class happened.`);
    }

    // A trial booked from the website: mark that booking attended instead of
    // adding a second trials row for the same person.
    if (trialHook && m.meeting_id) {
      const mins = Math.max(0, ...people.map(p => p.minutes || 0));
      let booked = false;
      try { booked = await trialHook(m.meeting_id, mins); } catch (e) { console.error('trial hook failed:', e.message); }
      if (booked) {
        if (plan.trials.length) await notify('info', `🎥 Booked trial attended: ${plan.trials.map(p => p.name || p.email).join(', ')} (${mins} min). Marked on the Students page.`);
        plan.trials = [];
        plan.review = plan.review.filter(p => !plan.isTrial);
      }
    }

    // Trial attendees → trials table. One row per meeting + person, so a retry
    // never duplicates. If the insert fails, the person falls back to review.
    const trialsAdded = [];
    for (const p of plan.trials) {
      const { error } = await supabase.from('trials').upsert({
        full_name: p.name || p.email || 'Unknown', contact: p.email || null, trial_date: classDate,
        source: 'zoom', status: 'pending', notes: m.topic || null,
        zoom_meeting_uuid: m.uuid, zoom_person_key: p.key
      }, { onConflict: 'zoom_meeting_uuid,zoom_person_key', ignoreDuplicates: true });
      if (error) { console.error('trials insert failed, sending to review:', error.message); plan.review.push(p); }
      else trialsAdded.push(p);
    }
    if (trialsAdded.length) {
      const who = trialsAdded.map(p => `${p.name || p.email} (${p.minutes} min)`).join(', ');
      await notify('info', `🎥 Trial from Zoom: ${who} on ${prettyDate(classDate)}. Added to Trial classes on the Students page.`);
    }

    for (const p of plan.review) {
      const { error } = await supabase.from('zoom_unmatched').upsert({
        meeting_uuid: m.uuid, person_key: p.key, class_date: classDate, topic: m.topic || null,
        zoom_name: p.name || null, zoom_email: p.email || null, minutes: p.minutes, status: 'pending'
      }, { onConflict: 'meeting_uuid,person_key', ignoreDuplicates: true });
      if (error) throw new Error('zoom_unmatched insert failed: ' + error.message);
    }
    if (plan.review.length) {
      const who = plan.review.map(p => `${p.name || p.email} (${p.minutes} min)`).join(', ');
      await notify('warning', `🎥 Zoom: ${who} attended "${m.topic || 'a meeting'}" on ${prettyDate(classDate)} but ${plan.review.length === 1 ? 'is' : 'are'} not linked to a student. Review on the Students page.`);
    }

    await supabase.from('zoom_meetings').update({
      status: 'done', processed_at: new Date().toISOString(), last_error: null,
      result: {
        classDate, logged,
        short: plan.short.map(x => ({ student: x.student.id, minutes: x.minutes })),
        review: plan.review.map(p => ({ name: p.name, email: p.email, minutes: p.minutes })),
        trials: trialsAdded.map(p => ({ name: p.name, email: p.email, minutes: p.minutes })),
        ignoredShort: plan.ignoredShort.map(p => ({ name: p.name, minutes: p.minutes }))
      }
    }).eq('uuid', m.uuid);
    console.log('Zoom meeting', m.uuid, 'done. Logged', logged.length, 'review', plan.review.length, 'trials', trialsAdded.length);
  } catch (e) {
    return failMeeting(m, e);
  }
}

// ── 6. WORKER ──
let _running = false, _lastRun = null, _lastError = null;
async function processPending() {
  if (!supabase || !isConfigured() || _running) return { ran: false };
  _running = true;
  try {
    const cutoff = new Date(Date.now() - REPORT_DELAY_MIN * 60 * 1000).toISOString();
    const { data, error } = await supabase.from('zoom_meetings').select('*')
      .eq('status', 'pending').lte('received_at', cutoff).order('received_at', { ascending: true }).limit(10);
    if (error) throw new Error(error.message);
    for (const m of data || []) await processMeeting(m);
    _lastRun = new Date().toISOString(); _lastError = null;
    return { ran: true, processed: (data || []).length };
  } catch (e) {
    _lastError = e.message;
    console.error('Zoom worker error:', e.message);
    return { ran: true, error: e.message };
  } finally { _running = false; }
}

function startWorker() {
  if (!isConfigured()) {
    console.log('Zoom worker idle: ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not set');
    return;
  }
  console.log('Zoom worker on: every 5 min, min ' + MIN_MINUTES + ' min to count a class');
  setTimeout(processPending, 60 * 1000);
  setInterval(processPending, WORKER_EVERY_MS);
  // Meeting sync engine: reconcile Zoom with the planned week a few times a
  // day. syncMeetings() guards itself on the ZOOM_AUTO_MEETINGS flag.
  console.log('Zoom meeting sync: ' + (autoMeetingsOn() ? 'ON (every 6h)' : 'off (ZOOM_AUTO_MEETINGS not set)'));
  setTimeout(() => syncMeetings().catch(e => console.error('zoom sync error:', e.message)), 90 * 1000);
  setInterval(() => syncMeetings().catch(e => console.error('zoom sync error:', e.message)), SYNC_EVERY_MS);
}

function status() {
  return {
    configured: isConfigured(),
    webhookSecret: !!WEBHOOK_SECRET,
    minMinutes: MIN_MINUTES,
    trialMinMinutes: TRIAL_MIN_MINUTES,
    autoMeetings: autoMeetingsOn() ? 'on' : 'off',
    lastRun: _lastRun,
    lastError: _lastError
  };
}

// ── 8. MEETING SYNC ENGINE (server-created meetings) ──
// The database is the source of truth; Zoom is made to mirror it.
// Every few hours (and on /api/zoom/sync-now) this builds the definitive
// list of classes for the next 7 days from class_schedule (weekly slots)
// plus class_exceptions (skip / move), then reconciles Zoom against it:
// a planned class with no meeting gets one created; a stored meeting whose
// time changed gets updated; a stored meeting no longer planned is deleted.
// Meetings are created under the host account with the student's name in
// the topic ("Handpan Class with Trina") so attendance matching works.
// Gated by ZOOM_AUTO_MEETINGS = 'on' so it can be rolled out deliberately.
const HOST_EMAIL = process.env.ZOOM_HOST_EMAIL || 'arpithandpan@gmail.com';
const SYNC_DAYS = 7;
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;   // reconcile 4x a day

function autoMeetingsOn() {
  return String(process.env.ZOOM_AUTO_MEETINGS || '').trim().toLowerCase() === 'on';
}

async function zoomApi(method, path, body) {
  const doFetch = async (tok) => fetch('https://api.zoom.us/v2' + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let r = await doFetch(await zoomToken());
  if (r.status === 401) r = await doFetch(await zoomToken(true));
  if (r.status === 204) return { ok: true, data: null };
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: j.message || ('HTTP ' + r.status) };
  return { ok: true, data: j };
}

function addDaysIst(offset) {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000 + offset * 24 * 3600 * 1000);
  return { ymd: ist.toISOString().slice(0, 10), weekday: ist.getUTCDay() };
}

// The definitive class list for the window: { 'S-011|2026-10-19': {…} }
async function planWindow() {
  const { data: schedules } = await supabase.from('class_schedule')
    .select('student_id, weekday, time_ist, duration_min, student_tz, active').eq('active', true);
  const from = addDaysIst(0).ymd, to = addDaysIst(SYNC_DAYS + 7).ymd;
  const { data: exceptions } = await supabase.from('class_exceptions')
    .select('student_id, original_date, action, new_date, new_time_ist')
    .gte('original_date', from).lte('original_date', to);
  const { data: students } = await supabase.from('students').select('id, full_name, archived');
  const nameById = {};
  for (const s of (students || [])) if (!s.archived) nameById[s.id] = s.full_name;

  const plan = {};
  for (let i = 0; i < SYNC_DAYS; i++) {
    const { ymd, weekday } = addDaysIst(i);
    for (const sc of (schedules || [])) {
      if (sc.weekday !== weekday || !nameById[sc.student_id]) continue;
      plan[sc.student_id + '|' + ymd] = {
        student_id: sc.student_id, name: nameById[sc.student_id], date: ymd,
        time: String(sc.time_ist).slice(0, 5), duration: sc.duration_min || 60,
        tz: sc.student_tz || 'Asia/Kolkata'
      };
    }
  }
  // Exceptions: a skip removes the slot; a move removes it and adds the new one.
  for (const ex of (exceptions || [])) {
    const key = ex.student_id + '|' + ex.original_date;
    const original = plan[key];
    if (ex.action === 'skip') { delete plan[key]; continue; }
    if (ex.action === 'move' && ex.new_date) {
      const base = original || { student_id: ex.student_id, name: nameById[ex.student_id], duration: 60, tz: 'Asia/Kolkata' };
      delete plan[key];
      if (!base.name) continue;
      plan[ex.student_id + '|' + ex.new_date] = {
        ...base, date: ex.new_date,
        time: ex.new_time_ist ? String(ex.new_time_ist).slice(0, 5) : base.time
      };
    }
  }
  // Drop classes already underway or past (30 min grace).
  const now = Date.now();
  for (const k of Object.keys(plan)) {
    const p = plan[k];
    const t = new Date(p.date + 'T' + p.time + ':00+05:30').getTime();
    if (isNaN(t) || t < now + 30 * 60 * 1000) delete plan[k];
  }
  return plan;
}

async function syncMeetings() {
  if (!supabase || !isConfigured()) return { skipped: 'zoom not configured' };
  if (!autoMeetingsOn()) return { skipped: 'ZOOM_AUTO_MEETINGS is off' };

  const plan = await planWindow();
  const from = addDaysIst(0).ymd, to = addDaysIst(SYNC_DAYS + 7).ymd;
  const { data: stored, error } = await supabase.from('class_meetings')
    .select('*').eq('status', 'scheduled').gte('class_date', from).lte('class_date', to);
  if (error) return { error: error.message };

  const storedByKey = {};
  for (const m of (stored || [])) storedByKey[m.student_id + '|' + m.class_date] = m;

  let created = 0, updated = 0, cancelled = 0;

  // 1. Planned but missing, or present with a changed time.
  for (const [key, p] of Object.entries(plan)) {
    const existing = storedByKey[key];
    const startIst = p.date + 'T' + p.time + ':00';
    if (!existing) {
      const topic = 'Handpan Class with ' + p.name;
      const res = await zoomApi('POST', '/users/' + encodeURIComponent(HOST_EMAIL) + '/meetings', {
        topic, type: 2, start_time: startIst, timezone: 'Asia/Kolkata', duration: p.duration,
        settings: { join_before_host: true, waiting_room: false, approval_type: 2 }
      });
      if (!res.ok) { await notify('warning', `⚠️ Could not create Zoom meeting for ${p.name} on ${prettyDate(p.date)}: ${res.error}`); continue; }
      const { error: insErr } = await supabase.from('class_meetings').insert({
        student_id: p.student_id, class_date: p.date, time_ist: p.time, duration_min: p.duration,
        student_tz: p.tz, zoom_meeting_id: String(res.data.id), join_url: res.data.join_url, status: 'scheduled'
      });
      if (insErr) { console.error('class_meetings insert failed:', insErr.message); await zoomApi('DELETE', '/meetings/' + res.data.id); continue; }
      created++;
    } else if (String(existing.time_ist).slice(0, 5) !== p.time) {
      const res = await zoomApi('PATCH', '/meetings/' + existing.zoom_meeting_id, {
        start_time: startIst, timezone: 'Asia/Kolkata', duration: p.duration
      });
      if (!res.ok) { await notify('warning', `⚠️ Could not move Zoom meeting for ${p.name} on ${prettyDate(p.date)}: ${res.error}`); continue; }
      await supabase.from('class_meetings')
        .update({ time_ist: p.time, duration_min: p.duration, reminder_sent_on: null })
        .eq('id', existing.id);
      await notify('info', `🔁 ${p.name}'s class on ${prettyDate(p.date)} moved to ${p.time} IST — Zoom updated automatically.`);
      updated++;
    }
  }

  // 2. Stored but no longer planned → cancel.
  for (const [key, m] of Object.entries(storedByKey)) {
    if (plan[key]) continue;
    const res = await zoomApi('DELETE', '/meetings/' + m.zoom_meeting_id);
    if (!res.ok && res.status !== 404) { await notify('warning', `⚠️ Could not cancel Zoom meeting ${m.zoom_meeting_id} (${m.student_id}, ${prettyDate(m.class_date)}): ${res.error}`); continue; }
    await supabase.from('class_meetings').update({ status: 'cancelled' }).eq('id', m.id);
    cancelled++;
  }

  if (created || updated || cancelled) {
    await notify('info', `📅 Zoom sync: ${created} meeting(s) created, ${updated} moved, ${cancelled} cancelled for the coming week.`);
  }
  console.log('Zoom sync done:', { created, updated, cancelled, planned: Object.keys(plan).length });
  return { created, updated, cancelled, planned: Object.keys(plan).length };
}

// ── 7. REVIEW LIST: pick a student for an unmatched person ──
// Logs the class with the same rules as the worker, remembers the Zoom name
// on the student, and clears any other pending rows for the same person.
async function resolveUnmatched(id, studentId) {
  const { data: row } = await supabase.from('zoom_unmatched').select('*').eq('id', id).maybeSingle();
  if (!row) return { status: 404, error: 'Review item not found' };
  if (row.status !== 'pending') return { status: 409, error: 'Already ' + row.status };
  const { data: student } = await supabase.from('students').select('id, full_name, email, archived').eq('id', studentId).maybeSingle();
  if (!student || student.archived) return { status: 404, error: 'Student not found' };

  await learnNames(student.id, row.zoom_name ? [row.zoom_name] : [], row.zoom_email);

  const { data: same } = await supabase.from('zoom_unmatched').select('*')
    .eq('status', 'pending').eq('person_key', row.person_key).order('class_date', { ascending: true });
  const items = (same && same.length) ? same : [row];

  const results = [];
  for (const it of items) {
    const r = await logClass({ student, classDate: it.class_date, minutes: it.minutes, meetingUuid: it.meeting_uuid, how: 'picked in dashboard' });
    await supabase.from('zoom_unmatched').update({ status: 'resolved', student_id: student.id, resolved_at: new Date().toISOString() }).eq('id', it.id);
    results.push({ id: it.id, classDate: it.class_date, ...r });
  }
  return { status: 200, student: student.full_name, results };
}

module.exports = {
  init, setTrialHook, zoomApi, webhookHandler, liveHandler, startWorker, processPending, resolveUnmatched, status, syncMeetings,
  _test: { liveEvent, liveList, LIVE, processMeeting, cleanParticipants, planMeeting, buildIndex, matchPerson, studentsInTopic, isTrialTopic, encodeUuid, istDate, normName, hmac, MIN_MINUTES, TRIAL_MIN_MINUTES }
};
