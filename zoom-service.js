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
//
// Never throws out to the server. Every failure becomes a log line, a
// retry, or a dashboard notification.

const crypto = require('crypto');

const ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID || '';
const CLIENT_ID = process.env.ZOOM_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || '';
const WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET || '';

const MIN_MINUTES = Number(process.env.ZOOM_MIN_MINUTES) || 20;   // attendance needed to count a class
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

function isConfigured() { return !!(ACCOUNT_ID && CLIENT_ID && CLIENT_SECRET); }

// ── small helpers ──
function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function normName(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function firstWord(s) { return normName(s).split(' ')[0] || ''; }
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }
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

function matchPerson(person, idx) {
  if (person.email && idx.byEmail.get(person.email)) return { student: idx.byEmail.get(person.email), how: 'email' };
  for (const n of person.names) {
    const s = idx.byName.get(normName(n));
    if (s) return { student: s, how: 'zoom name' };
  }
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
  const idx = buildIndex(students);
  const byStudent = new Map();   // student id → { student, minutes, names, email, how }
  const unmatched = [];
  for (const p of people) {
    const m = matchPerson(p, idx);
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
  const topicStudents = studentsInTopic(topic, students).filter(s => !byStudent.has(s.id));
  if (topicStudents.length === 1 && longUnmatched.length === 1) {
    const p = longUnmatched[0], s = topicStudents[0];
    byStudent.set(s.id, { student: s, minutes: p.minutes, names: p.names.slice(), email: p.email, how: 'meeting topic' });
    learn.push({ student: s, names: p.names, email: p.email });
    unmatched.splice(unmatched.indexOf(p), 1);
  }

  const toLog = [...byStudent.values()].filter(x => x.minutes >= MIN_MINUTES);
  const short = [...byStudent.values()].filter(x => x.minutes < MIN_MINUTES);
  const review = unmatched.filter(p => p.minutes >= MIN_MINUTES);
  const ignoredShort = unmatched.filter(p => p.minutes < MIN_MINUTES);
  return { toLog, short, review, ignoredShort, learn };
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
    if (remaining === 0) {
      await notify('payment', `💳 ${name} has 0 classes left after the ${prettyDate(classDate)} class. Time to send a fee link.`);
    } else if (remaining < 0) {
      await notify('payment', `💳 ${name} has ${-remaining} unpaid class${remaining === -1 ? '' : 'es'} after ${prettyDate(classDate)}. Send a fee link.`);
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
        ignoredShort: plan.ignoredShort.map(p => ({ name: p.name, minutes: p.minutes }))
      }
    }).eq('uuid', m.uuid);
    console.log('Zoom meeting', m.uuid, 'done. Logged', logged.length, 'review', plan.review.length);
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
}

function status() {
  return {
    configured: isConfigured(),
    webhookSecret: !!WEBHOOK_SECRET,
    minMinutes: MIN_MINUTES,
    lastRun: _lastRun,
    lastError: _lastError
  };
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
  init, webhookHandler, startWorker, processPending, resolveUnmatched, status,
  _test: { cleanParticipants, planMeeting, buildIndex, matchPerson, studentsInTopic, encodeUuid, istDate, normName, hmac, MIN_MINUTES }
};
