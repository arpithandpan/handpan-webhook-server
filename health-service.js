// health-service.js
// Keeps an eye on the whole studio system and tells Arpit when something needs him.
//
// Four parts, all inside the Railway server, no AI involved:
//   1. Job watch: every background job (reminders, agent, Zoom sync, invoices...)
//      is timed. If a job stops running or keeps failing, that is an issue.
//   2. Service checks every 5 minutes: database, WhatsApp, Razorpay, Zoom, email.
//   3. Data checks every 30 minutes: payments not recorded, invoices that failed,
//      fee links unpaid for a week, messages that failed, drafts left waiting...
//   4. Error log: server errors (console.error) and errors from the dashboard
//      are counted in the system_errors table. A burst of the same error is an issue.
//
// Telling Arpit:
//   - When something turns bad, one notification row is written that starts
//     with 🔴. notify-mailer already sends those to the phone (push), email and
//     the alerts WhatsApp. Nothing else had to change for that.
//   - When it is fine again, a ✅ push (no email, no WhatsApp).
//   - Still bad after 6 hours: one reminder. Never a stream of the same alert.
//   - 8:30 AM IST: a morning check. All good → a quiet push. Something open →
//     one ⚠️ notification with the short list (push + email + WhatsApp).
// The dashboard reads everything from GET /api/health/status (More → System health).

const VERSION = 'health-3';
const SERVICE_EVERY = 5 * 60 * 1000;
const DATA_EVERY = 30 * 60 * 1000;
const REALERT_MS = 6 * 3600 * 1000;
const DIGEST_HHMM = '08:30';

let supabase = null, deps = {};
const state = {
  startedAt: new Date().toISOString(),
  services: {},          // key → { key, label, status: ok|warn|bad, detail, at }
  jobs: {},              // key → { key, label, every, lastStart, lastOk, lastErr, err, runs, fails, streak, running }
  issues: {},            // key → { key, level: warn|bad, title, detail, action, since, area }
  lastServiceRun: null, lastDataRun: null
};
let alertMemo = {};      // key → { level, sentAt }  (persisted in app_settings 'health_alerts')
let snoozed = {};        // key → until ISO          (persisted in app_settings 'health_snooze')
let lastDigestDay = null;

// ── 1. JOB WATCH ──
// Patches setInterval once, before the workers start. Every interval created
// from a module file is wrapped so its runs are timed. Nothing else changes:
// same callback, same timing, errors still go where they went before.
const JOB_LABELS = {
  'agent-service:autoSend': 'WhatsApp agent: auto replies',
  'agent-service:sweep': 'WhatsApp agent: drafts',
  'backup-service:tick': 'Daily backup',
  'calendar-invites:tick': 'Calendar invites',
  'enrolment:run': 'Weekly class links',
  'notify-mailer:processPending': 'Alert emails and WhatsApp',
  'settlement-worker:processUnsettled': 'Razorpay settlements',
  'student-portal:tick': 'Student portal reminders',
  'trial-booking:tick': 'Trial reminders',
  'whatsapp-service:tick': 'Class reminders on WhatsApp',
  'workshop-messages:processPending': 'Workshop messages',
  'zoom-service:processPending': 'Zoom attendance',
  'zoom-service:syncMeetings': 'Zoom meeting sync',
  'zoom-service:renewalCheck': 'Fee renewals',
  'review-service:tick': 'Weekly AI review'
};
function jobKeyFor(fn, stack) {
  const m = String(stack || '').split('\n').map(l => l.match(/([a-z0-9-]+)\.js:\d+/i)).find(x => x && x[1] !== 'health-service');
  const file = m ? m[1] : 'server';
  let name = fn && fn.name && fn.name !== 'bound ' ? fn.name.replace(/^bound /, '') : '';
  if (!name) { const c = String(fn).match(/([A-Za-z_$][\w$]*)\s*\(/g); if (c) { const pick = c.map(x => x.replace(/\s*\($/, '')).find(x => !/^(catch|then|console|setTimeout|if|async)$/.test(x)); if (pick) name = pick; } }
  return file + ':' + (name || 'job');
}
function watchJobs() {
  if (global.__healthPatched) return;
  global.__healthPatched = true;
  const orig = global.setInterval;
  global.setInterval = function (fn, ms, ...args) {
    if (typeof fn !== 'function' || !ms || ms < 30000) return orig(fn, ms, ...args);
    const stack = new Error().stack;
    // Only our own server files are watched; library timers and this file are left alone.
    const caller = String(stack).split('\n').slice(2).find(l => /\.js:\d+/.test(l)) || '';
    if (/node_modules|node:|health-service\.js/.test(caller)) return orig(fn, ms, ...args);
    const key = jobKeyFor(fn, stack);
    let k = key, n = 2; while (state.jobs[k]) k = key + '#' + (n++);
    const j = state.jobs[k] = { key: k, label: JOB_LABELS[key] || key, every: ms, lastStart: null, lastOk: null, lastErr: null, err: null, runs: 0, fails: 0, streak: 0, running: false };
    const wrapped = function () {
      j.lastStart = new Date().toISOString(); j.runs++; j.running = true;
      const done = (e) => {
        j.running = false;
        if (e) { j.fails++; j.streak++; j.lastErr = new Date().toISOString(); j.err = String(e && e.message || e).slice(0, 300); }
        else { j.streak = 0; j.lastOk = new Date().toISOString(); }
      };
      try {
        const r = fn.apply(this, args);
        if (r && typeof r.then === 'function') r.then(() => done(), (e) => { done(e); console.error('Job ' + j.label + ' failed:', e && e.message || e); });
        else done();
      } catch (e) { done(e); console.error('Job ' + j.label + ' failed:', e && e.message || e); }
    };
    return orig(wrapped, ms);
  };
}

// ── 4. ERROR LOG ──
// console.error is counted (not replaced): the message still prints as before.
const errBuf = new Map();   // sig → { source, where, message, count, first, last }
function normalizeMsg(s) {
  return String(s || '').replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/\b(pay|order|plink|inv)_[A-Za-z0-9]+/g, '$1_#')
    .replace(/[+]?\d[\d\s-]{5,}\d/g, 'N').replace(/\d+/g, 'n').replace(/\s+/g, ' ').trim().slice(0, 240);
}
function recordError(source, where, message) {
  const msg = String(message || '').slice(0, 500);
  if (!msg) return;
  const sig = source + '|' + where + '|' + normalizeMsg(msg);
  const now = new Date().toISOString();
  const e = errBuf.get(sig) || { source, where, message: msg, sig, count: 0, first: now, last: now };
  e.count++; e.last = now; e.message = msg;
  errBuf.set(sig, e);
  if (errBuf.size > 300) errBuf.delete(errBuf.keys().next().value);
}
function watchConsole() {
  if (global.__healthConsole) return;
  global.__healthConsole = true;
  const orig = console.error.bind(console);
  console.error = function (...a) {
    orig(...a);
    try {
      const st = new Error().stack.split('\n').slice(2).map(l => l.match(/([a-z0-9-]+)\.js:\d+/i)).find(Boolean);
      const where = st ? st[1] : 'server';
      if (where === 'health-service') return;
      recordError('server', where, a.map(x => x instanceof Error ? x.message : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
    } catch (e) {}
  };
  process.on('unhandledRejection', (r) => recordError('server', 'unhandled', r && r.message || String(r)));
}
async function flushErrors() {
  if (!supabase || !errBuf.size) return;
  const rows = [...errBuf.values()]; errBuf.clear();
  for (const r of rows) {
    try {
      const sigHash = require('crypto').createHash('sha1').update(r.sig).digest('hex').slice(0, 24);
      const { data: ex } = await supabase.from('system_errors').select('id, count').eq('sig', sigHash).maybeSingle();
      if (ex) await supabase.from('system_errors').update({ count: (ex.count || 0) + r.count, last_at: r.last, message: r.message, resolved: false }).eq('id', ex.id);
      else await supabase.from('system_errors').insert({ sig: sigHash, source: r.source, location: r.where, message: r.message, count: r.count, first_at: r.first, last_at: r.last });
    } catch (e) { /* table missing: keep quiet, the status page says so */ }
  }
}

// ── HELPERS ──
const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const istYmd = (d = istNow()) => d.toISOString().slice(0, 10);
const istHHMM = () => istNow().toISOString().slice(11, 16);
const ago = (iso) => iso ? Date.now() - new Date(iso).getTime() : Infinity;
const mins = (ms) => Math.round(ms / 60000);
function setService(key, label, status, detail) { state.services[key] = { key, label, status, detail, at: new Date().toISOString() }; }
function setIssue(key, level, title, detail, action, area, name) {
  const prev = state.issues[key];
  state.issues[key] = { key, level, title, detail: detail || '', action: action || null, area: area || 'system', name: name || null, since: prev ? prev.since : new Date().toISOString() };
}
async function timed(p, ms = 12000) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after ' + ms / 1000 + 's')), ms))]);
}
async function loadJson(key, dflt) {
  try { const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle(); return (data && data.value) || dflt; } catch (e) { return dflt; }
}
async function saveJson(key, value) {
  try { await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' }); } catch (e) {}
}

// ── 2. SERVICE CHECKS ──
async function checkServices() {
  const checks = [];
  // Database
  checks.push((async () => {
    const t0 = Date.now();
    try {
      const { error } = await timed(supabase.from('students').select('id', { head: true, count: 'exact' }).limit(1));
      if (error) throw new Error(error.message);
      const ms = Date.now() - t0;
      setService('db', 'Database', ms > 4000 ? 'warn' : 'ok', ms > 4000 ? 'Slow: ' + ms + ' ms' : 'Responding in ' + ms + ' ms');
    } catch (e) { setService('db', 'Database', 'bad', 'Not responding: ' + e.message); }
  })());
  // WhatsApp (studio number)
  checks.push((async () => {
    const tok = process.env.WHATSAPP_PROD_TOKEN, id = process.env.WHATSAPP_PROD_PHONE_ID;
    if (!tok || !id) return setService('wa', 'WhatsApp', 'warn', 'Not set up on the server');
    try {
      const r = await timed(fetch('https://graph.facebook.com/v21.0/' + id + '?fields=display_phone_number,quality_rating,status', { headers: { Authorization: 'Bearer ' + tok } }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
      const q = String(j.quality_rating || '').toUpperCase();
      setService('wa', 'WhatsApp', q === 'RED' ? 'bad' : q === 'YELLOW' ? 'warn' : 'ok', 'Connected' + (q ? ' · quality ' + q.toLowerCase() : ''));
    } catch (e) { setService('wa', 'WhatsApp', 'bad', 'Meta is refusing the connection: ' + e.message); }
  })());
  // Razorpay
  checks.push((async () => {
    const k = process.env.RAZORPAY_KEY_ID, s = process.env.RAZORPAY_KEY_SECRET;
    if (!k || !s) return setService('rzp', 'Payments (Razorpay)', 'warn', 'Not set up on the server');
    try {
      const r = await timed(fetch('https://api.razorpay.com/v1/payments?count=1', { headers: { Authorization: 'Basic ' + Buffer.from(k + ':' + s).toString('base64') } }));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setService('rzp', 'Payments (Razorpay)', 'ok', 'Connected');
    } catch (e) { setService('rzp', 'Payments (Razorpay)', 'bad', 'Razorpay is not answering: ' + e.message); }
  })());
  // Zoom
  checks.push((async () => {
    if (!deps.zoomApi || !process.env.ZOOM_CLIENT_ID) return setService('zoom', 'Zoom', 'warn', 'Not set up on the server');
    try {
      const r = await timed(deps.zoomApi('GET', '/users/me'));
      // The app is not allowed to read user details, and does not need to. Zoom answering
      // with a scope error still proves the sign-in works, which is all this checks.
      if (!r || (!r.ok && !/scope/i.test(String(r.error || '')))) throw new Error((r && r.error) || 'no answer');
      setService('zoom', 'Zoom', 'ok', 'Connected');
    } catch (e) { setService('zoom', 'Zoom', 'bad', 'Zoom sign-in failed: ' + e.message); }
  })());
  // Email (Resend)
  checks.push((async () => {
    const key = process.env.RESEND_API_KEY;
    if (!key) return setService('mail', 'Email', 'warn', 'Not set up on the server');
    try {
      const r = await timed(fetch('https://api.resend.com/domains', { headers: { Authorization: 'Bearer ' + key } }));
      const j = await r.json().catch(() => ({}));
      // A send-only key (the studio uses one) may not list domains. That answer still proves the key is real.
      if ((r.status === 401 || r.status === 403) && !/restricted|only send/i.test(JSON.stringify(j))) throw new Error('key refused');
      // Some Resend keys may only send; anything but an auth error means the key works.
      setService('mail', 'Email', 'ok', 'Connected');
    } catch (e) { setService('mail', 'Email', 'bad', 'Resend refused the key: ' + e.message); }
  })());
  await Promise.allSettled(checks);

  for (const s of Object.values(state.services)) {
    const key = 'svc:' + s.key;
    if (s.status === 'bad') setIssue(key, 'bad', s.label + ' is down', s.detail, null, 'service', s.label);
    else delete state.issues[key];
  }

  // Jobs: stalled or failing
  for (const j of Object.values(state.jobs)) {
    const key = 'job:' + j.key;
    const late = j.lastStart ? ago(j.lastStart) : ago(state.startedAt);
    const stalled = late > j.every * 3 + 120000;
    if (stalled) setIssue(key, late > 3600000 ? 'bad' : 'warn', j.label + ' has stopped', 'Last ran ' + (j.lastStart ? mins(late) + ' min ago' : 'never since the server started') + ', it should run every ' + mins(j.every) + ' min. A Railway redeploy usually fixes this.', null, 'job', j.label);
    else if (j.streak >= 3) setIssue(key, 'bad', j.label + ' keeps failing', 'Failed ' + j.streak + ' times in a row: ' + (j.err || 'unknown error'), null, 'job', j.label);
    else delete state.issues[key];
  }
  state.lastServiceRun = new Date().toISOString();
}

// Test accounts (student ids starting S-DEMO, plus TEST_PHONES in Railway) never raise issues.
let _tp = null, _tpAt = 0;
async function testPhones() {
  if (_tp && Date.now() - _tpAt < 30 * 60 * 1000) return _tp;
  const set = new Set(String(process.env.TEST_PHONES || '').split(',').map(x => x.replace(/\D/g, '')).filter(Boolean));
  try { const { data } = await supabase.from('students').select('id, phone').like('id', 'S-DEMO%'); (data || []).forEach(s => { const d = String(s.phone || '').replace(/\D/g, ''); if (d) set.add(d); }); } catch (e) {}
  _tp = set; _tpAt = Date.now(); return set;
}
// ── 3. DATA CHECKS ──
async function q(table, build) { const r = await build(supabase.from(table)); if (r.error) throw new Error(table + ': ' + r.error.message); return r.data || []; }
async function checkData() {
  const run = async (key, fn) => { try { await fn(); } catch (e) { console.warn('health data check ' + key + ':', e.message); } };
  const since = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  // Razorpay has a captured payment that we never recorded (webhook missed)
  await run('rzp-missing', async () => {
    const k = process.env.RAZORPAY_KEY_ID, s = process.env.RAZORPAY_KEY_SECRET; if (!k || !s) return;
    const from = Math.floor((Date.now() - 48 * 3600 * 1000) / 1000), to = Math.floor((Date.now() - 20 * 60 * 1000) / 1000);
    const r = await timed(fetch('https://api.razorpay.com/v1/payments?count=50&from=' + from + '&to=' + to, { headers: { Authorization: 'Basic ' + Buffer.from(k + ':' + s).toString('base64') } }));
    if (!r.ok) return;
    const items = ((await r.json()).items || []).filter(p => p.status === 'captured');
    if (!items.length) { delete state.issues['data:rzp-missing']; return; }
    const ids = items.map(p => p.id), seen = new Set();
    for (const t of ['payments', 'fee_payments', 'participants', 'unassigned_payments']) {
      const rows = await q(t, x => x.select('razorpay_payment_id').in('razorpay_payment_id', ids)).catch(() => []);
      rows.forEach(r => seen.add(r.razorpay_payment_id));
    }
    const fr = await q('fee_requests', x => x.select('razorpay_payment_id').in('razorpay_payment_id', ids)).catch(() => []);
    fr.forEach(r => seen.add(r.razorpay_payment_id));
    const gg = await q('gigs', x => x.select('advance_payment_id, balance_payment_id')).catch(() => []);
    gg.forEach(r => { if (r.advance_payment_id) seen.add(r.advance_payment_id); if (r.balance_payment_id) seen.add(r.balance_payment_id); });
    const missing = items.filter(p => !seen.has(p.id));
    for (const k of Object.keys(state.issues)) if (k.startsWith('data:rzp:') && !missing.some(m => 'data:rzp:' + m.id === k)) delete state.issues[k];
    for (const m of missing.slice(0, 5)) {
      const amt = (m.currency === 'INR' ? '₹' : m.currency + ' ') + (m.amount / 100);
      const who = [m.notes && (m.notes.name || m.notes.full_name), m.email, m.contact].filter(Boolean).join(', ');
      const what = m.description || (m.notes && (m.notes.purpose || m.notes.type)) || '';
      const at = new Date(m.created_at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      setIssue('data:rzp:' + m.id, 'bad', 'Payment of ' + amt + ' not recorded',
        'Razorpay has it but the dashboard does not. ' + at + (who ? ' · ' + who : '') + (what ? ' · ' + what : '') + ' · ' + m.id + '. If this was not a studio payment, tap "Not a studio payment".',
        { label: 'Open in Razorpay', url: 'https://dashboard.razorpay.com/app/payments/' + m.id, ignore: 'Not a studio payment' }, 'payments');
    }
    delete state.issues['data:rzp-missing'];
  });

  // Invoice emails that failed
  await run('invoice-failed', async () => {
    const rows = await q('invoices', x => x.select('id, billed_name, email_error, created_at').not('email_error', 'is', null).gte('created_at', since(24 * 7)).limit(20));
    const open = rows.filter(r => r.email_error);
    if (open.length) setIssue('data:invoice-failed', 'warn', open.length + ' invoice email' + (open.length > 1 ? 's' : '') + ' failed', open.slice(0, 3).map(r => (r.billed_name || r.id) + ': ' + String(r.email_error).slice(0, 80)).join(' · '), { label: 'Open invoices', sec: 'invoices' }, 'payments');
    else delete state.issues['data:invoice-failed'];
  });

  // Fee links unpaid for 7+ days
  await run('fee-old', async () => {
    const rows = await q('fee_requests', x => x.select('id, student_id, created_at').eq('status', 'pending').lte('created_at', since(24 * 7)).limit(50));
    if (rows.length) {
      const studs = await q('students', x => x.select('id, full_name').in('id', rows.map(r => r.student_id).filter(Boolean))).catch(() => []);
      const nm = Object.fromEntries(studs.map(s => [s.id, s.full_name]));
      setIssue('data:fee-old', 'warn', rows.length + ' fee link' + (rows.length > 1 ? 's' : '') + ' unpaid for 7+ days', rows.slice(0, 4).map(r => nm[r.student_id] || r.student_id).join(', ') + (rows.length > 4 ? ' and ' + (rows.length - 4) + ' more' : ''), { label: 'Open Fee Tracker', sec: 'fee-payments' }, 'payments');
    } else delete state.issues['data:fee-old'];
  });

  // WhatsApp messages that failed in the last 24 h
  await run('wa-failed', async () => {
    const tp = await testPhones();
    const rows = (await q('wa_messages', x => x.select('id, phone, error, created_at').eq('direction', 'out').eq('status', 'failed').gte('created_at', since(24)).limit(30))).filter(r => !/sent again automatically/i.test(String(r.error || '')) && !tp.has(String(r.phone || '')));
    if (rows.length) setIssue('data:wa-failed', rows.length >= 5 ? 'bad' : 'warn', rows.length + ' WhatsApp message' + (rows.length > 1 ? 's' : '') + ' failed today', 'Latest to +' + rows[0].phone + (rows[0].error ? ': ' + String(rows[0].error).slice(0, 100) : '') + '.', { label: 'Open Inbox', sec: 'whatsapp' }, 'whatsapp');
    else delete state.issues['data:wa-failed'];
  });

  // Agent drafts waiting for Arpit for 3+ hours
  await run('drafts-old', async () => {
    const tp2 = await testPhones();
    let rows = (await q('wa_drafts', x => x.select('id, phone, created_at').eq('status', 'pending').lte('created_at', since(3)).gte('created_at', since(72)).limit(30))).filter(r => !tp2.has(String(r.phone || '')));
    // Only count people whose last message is still theirs (Arpit may have answered from his phone).
    const phones = [...new Set(rows.map(r => r.phone))];
    if (phones.length) {
      const msgs = await q('wa_messages', x => x.select('phone, direction, created_at, type').in('phone', phones).gte('created_at', since(96)).order('created_at', { ascending: false }).limit(500)).catch(() => []);
      const last = {}; msgs.forEach(m => { if (!last[m.phone] && m.type !== 'reaction') last[m.phone] = m; });
      rows = rows.filter(r => last[r.phone] && last[r.phone].direction === 'in');
    }
    if (rows.length) setIssue('data:drafts-old', 'warn', rows.length + ' reply draft' + (rows.length > 1 ? 's' : '') + ' waiting 3+ hours', 'People are waiting for an answer.', { label: 'Open Inbox', sec: 'whatsapp' }, 'whatsapp');
    else delete state.issues['data:drafts-old'];
  });

  // Questions the agent could not answer this week (input for the AI review later)
  await run('needs-arpit', async () => {
    const rows = await q('wa_drafts', x => x.select('id, category').eq('needs_arpit', true).gte('created_at', since(24 * 7)).limit(200)).catch(() => []);
    const by = {}; rows.forEach(r => { const c = r.category || 'other'; by[c] = (by[c] || 0) + 1; });
    state.asked = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count }));
  });

  // Today's and tomorrow's class meetings without a Zoom link
  await run('zoom-links', async () => {
    const today = istYmd(), tomorrow = istYmd(new Date(istNow().getTime() + 86400000));
    const rows = await q('class_meetings', x => x.select('id, student_id, class_date, time_ist, join_url, status').in('class_date', [today, tomorrow]).eq('status', 'scheduled')).catch(() => []);
    const noLink = rows.filter(r => !r.join_url);
    const trials = await q('trials', x => x.select('id, full_name, start_at, join_url, status').eq('status', 'booked').gte('start_at', new Date().toISOString()).lte('start_at', new Date(Date.now() + 36 * 3600 * 1000).toISOString())).catch(() => []);
    const tNo = trials.filter(t => !t.join_url);
    const n = noLink.length + tNo.length;
    if (n) setIssue('data:zoom-links', 'warn', n + ' upcoming class' + (n > 1 ? 'es have' : ' has') + ' no Zoom link', [...noLink.map(r => r.student_id + ' ' + r.class_date + ' ' + (r.time_ist || '')), ...tNo.map(t => 'Trial: ' + (t.full_name || t.id))].slice(0, 4).join(' · '), { label: 'Open Schedule', sec: 'schedule' }, 'classes');
    else delete state.issues['data:zoom-links'];
  });

  // Error bursts (same error 3+ times in the last hour)
  await run('errors', async () => {
    const rows = await q('system_errors', x => x.select('id, source, location, message, count, last_at').eq('resolved', false).gte('last_at', since(1)).order('last_at', { ascending: false }).limit(20)).catch(() => []);
    state.recentErrors = rows;
    const burst = rows.filter(r => (r.count || 0) >= 3);
    if (burst.length) setIssue('data:errors', 'warn', burst.length + ' error' + (burst.length > 1 ? 's' : '') + ' repeating', burst.slice(0, 2).map(r => (r.location || r.source) + ': ' + String(r.message).slice(0, 90)).join(' · '), null, 'errors');
    else delete state.issues['data:errors'];
  });
  state.lastDataRun = new Date().toISOString();
}


// ── 5. AUTO-FIX ──
// Only fixes that cannot hurt: never touches money records by hand, never sends a
// student the same thing twice, never changes a setting. Every fix is logged and
// shown under "Fixed by itself" in System health. Anything else stays an alert.
let fixes = [];            // newest first, persisted in app_settings 'health_fixes'
let fixDone = {};          // key → ISO, things already tried once (app_settings 'health_fixdone')
async function logFix(title, detail) {
  fixes.unshift({ at: new Date().toISOString(), title, detail: detail || '' });
  fixes = fixes.slice(0, 40);
  await saveJson('health_fixes', fixes);
  console.log('Health auto-fix:', title, detail ? '· ' + detail : '');
}
async function markTried(key) { fixDone[key] = new Date().toISOString(); const keys = Object.keys(fixDone); if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete fixDone[k]; await saveJson('health_fixdone', fixDone); }
const TRANSIENT = /something went wrong|unknown error|service (is )?(temporarily )?unavailable|temporar|timed? ?out|timeout|rate limit|try again|internal|ECONN|ETIMEDOUT|socket|fetch failed|network|5\d\d\b/i;

// a) Razorpay took the money but our webhook never arrived: replay it to our own
//    webhook, signed with our secret. The normal payment code then runs exactly as
//    if Razorpay had delivered it (it already ignores duplicates).
async function fixMissedPayments() {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET, k = process.env.RAZORPAY_KEY_ID, s = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !k || !s) return;
  for (const issue of Object.values(state.issues).filter(i => i.key.startsWith('data:rzp:'))) {
    const id = issue.key.slice('data:rzp:'.length);
    if (fixDone['rzp:' + id] || (snoozed[issue.key] && new Date(snoozed[issue.key]) > new Date())) continue;
    try {
      const r = await timed(fetch('https://api.razorpay.com/v1/payments/' + id, { headers: { Authorization: 'Basic ' + Buffer.from(k + ':' + s).toString('base64') } }));
      if (!r.ok) continue;
      const p = await r.json();
      if (p.status !== 'captured' || Date.now() - p.created_at * 1000 < 45 * 60 * 1000) continue;   // give Razorpay's own retries a chance first
      await markTried('rzp:' + id);
      const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: p } }, replayed_by: 'health' });
      const sig = require('crypto').createHmac('sha256', secret).update(body).digest('hex');
      const w = await timed(fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body }), 30000);
      const amt = (p.currency === 'INR' ? '₹' : p.currency + ' ') + (p.amount / 100);
      if (w.ok) { delete state.issues[issue.key]; await logFix('Recorded a missed payment of ' + amt, 'Razorpay never told the server about ' + id + ', so it was fetched and recorded the normal way (invoice and messages included).'); }
      else console.warn('health: replay of ' + id + ' answered ' + w.status);
    } catch (e) { console.warn('health: payment replay ' + id + ':', e.message); }
  }
}

// b) Invoice email failed for a passing reason: send it once more.
async function fixInvoiceEmails() {
  if (!deps.invoice) return;
  const rows = await q('invoices', x => x.select('*').not('email_error', 'is', null).gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()).limit(20)).catch(() => []);
  for (const row of rows) {
    if (!row.email_error || fixDone['inv:' + row.id]) continue;
    if (/invalid|not a valid|bounce|does not exist|no email|suppress|blocked|unsubscribed/i.test(row.email_error)) continue;
    if (Date.now() - new Date(row.created_at).getTime() < 30 * 60 * 1000) continue;
    await markTried('inv:' + row.id);
    try {
      const { pdf } = await deps.invoice.getPdf(supabase, row);
      const to = await deps.invoice.emailInvoice(supabase, row, pdf);
      await logFix('Invoice email sent again', (row.billed_name || row.id) + ' · to ' + to);
    } catch (e) { console.warn('health: invoice resend ' + row.id + ':', e.message); }
  }
}

// c) A WhatsApp message failed for a passing reason (Meta hiccup, timeout): send
//    it once more. Never for templates with a button or a PDF (we can't rebuild
//    those exactly), never when the chat window is closed, never twice.
let tplShape = null, tplShapeAt = 0;
async function templateShapes() {
  if (tplShape && Date.now() - tplShapeAt < 6 * 3600 * 1000) return tplShape;
  const waba = process.env.WHATSAPP_PROD_WABA_ID || '1652322909800354';
  const r = await timed(fetch('https://graph.facebook.com/v21.0/' + waba + '/message_templates?fields=name,components&limit=200', { headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_PROD_TOKEN } }));
  const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  tplShape = {};
  for (const t of j.data || []) {
    const comps = t.components || [];
    const simple = !comps.some(c => (c.type === 'HEADER' && c.format && c.format !== 'TEXT') || (c.type === 'HEADER' && /\{\{/.test(c.text || '')) || (c.type === 'BUTTONS' && JSON.stringify(c).includes('{{')));
    tplShape[t.name] = simple;
  }
  tplShapeAt = Date.now();
  return tplShape;
}
async function fixWhatsApp() {
  if (!deps.whatsapp || !process.env.WHATSAPP_PROD_TOKEN) return;
  const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString(), until = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = await q('wa_messages', x => x.select('id, phone, type, template, params, body, error, created_at').eq('direction', 'out').eq('status', 'failed').gte('created_at', since).lte('created_at', until).limit(20)).catch(() => []);
  for (const m of rows) {
    if (fixDone['wa:' + m.id] || !TRANSIENT.test(String(m.error || '')) || /sent again/i.test(String(m.error || ''))) continue;
    await markTried('wa:' + m.id);
    try {
      let r = null;
      if (m.type === 'text' && m.body) r = await deps.whatsapp.sendReply(m.phone, m.body);
      else if (m.type === 'template' && m.template && Array.isArray(m.params)) {
        const shapes = await templateShapes();
        if (shapes[m.template] !== true) continue;
        r = await deps.whatsapp.sendTemplate(m.phone, m.template, m.params);
      } else continue;
      if (r && r.ok) {
        await supabase.from('wa_messages').update({ error: String(m.error || 'failed') + ' · sent again automatically' }).eq('id', m.id);
        await logFix('WhatsApp message sent again', '+' + m.phone + (m.template ? ' · ' + m.template : '') + ' · first try failed: ' + String(m.error).slice(0, 80));
      }
    } catch (e) { console.warn('health: WA resend ' + m.id + ':', e.message); }
  }
}

// d) An agent reply stuck half-sent (server restarted mid-send): give it back to Arpit.
async function fixStuckDrafts() {
  const rows = await q('wa_drafts', x => x.select('id, phone, created_at').eq('status', 'sending').lte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString()).limit(20)).catch(() => []);
  for (const d of rows) {
    const { error } = await supabase.from('wa_drafts').update({ status: 'pending', auto_at: null }).eq('id', d.id).eq('status', 'sending');
    if (!error) await logFix('Unstuck a reply draft', 'A draft for +' + d.phone + ' got stuck while sending. It is back in the Inbox for you to send.');
  }
}

// e) Old errors that stopped happening are closed, so the list stays honest.
async function fixOldErrors() {
  try { await supabase.from('system_errors').update({ resolved: true }).eq('resolved', false).lte('last_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()); } catch (e) {}
}

// f) A background job has stopped (stuck or never coming back): restart the server.
//    Railway starts it again straight away and every job starts fresh. At most twice
//    a day, never in the first 30 minutes after a start, so it can never loop.
async function fixStalledJobs() {
  if (Date.now() - new Date(state.startedAt).getTime() < 30 * 60 * 1000) return;
  const stalled = Object.values(state.jobs).filter(j => { const late = j.lastStart ? Date.now() - new Date(j.lastStart).getTime() : Date.now() - new Date(state.startedAt).getTime(); return late > Math.max(j.every * 3 + 120000, 30 * 60 * 1000); });
  if (!stalled.length) return;
  const day = istYmd(); const rs = await loadJson('health_restarts', {});
  const n = rs.day === day ? rs.n || 0 : 0;
  if (n >= 2) return;
  await saveJson('health_restarts', { day, n: n + 1 });
  await logFix('Restarted the server', stalled.map(j => j.label).join(', ') + ' had stopped running. Restart ' + (n + 1) + ' of 2 allowed today.');
  console.error('Health: restarting the server because these jobs stopped: ' + stalled.map(j => j.label).join(', '));
  setTimeout(() => process.exit(1), 1500);
}

async function autoFix() {
  for (const [name, fn] of [['payments', fixMissedPayments], ['invoices', fixInvoiceEmails], ['whatsapp', fixWhatsApp], ['drafts', fixStuckDrafts], ['errors', fixOldErrors], ['jobs', fixStalledJobs]]) {
    try { await fn(); } catch (e) { console.warn('health auto-fix ' + name + ':', e.message); }
  }
}
// ── ALERTS ──
async function notifyRow(type, message) {
  try { await supabase.from('notifications').insert({ type, message, read: false }); } catch (e) {}
}
async function alertTransitions() {
  const now = Date.now();
  let changed = false;
  for (const i of Object.values(state.issues)) {
    if (i.level !== 'bad') continue;
    if (snoozed[i.key] && new Date(snoozed[i.key]).getTime() > now) continue;
    const memo = alertMemo[i.key];
    if (!memo || now - memo.sentAt > REALERT_MS) {
      await notifyRow('warning', '🔴 ' + i.title + '. ' + i.detail);
      alertMemo[i.key] = { level: i.level, sentAt: now, title: i.title, name: i.name };
      changed = true;
    }
  }
  for (const key of Object.keys(alertMemo)) {
    if (!state.issues[key] || state.issues[key].level !== 'bad') {
      const m = alertMemo[key];
      delete alertMemo[key]; changed = true;
      const body = m.name ? '✅ ' + m.name + ' is working again.' : '✅ Sorted: ' + (m.title || 'an earlier problem') + '.';
      if (deps.push) deps.push.send('alert', { title: 'Studio', body, tag: 'health-' + key, url: '/pages/dashboard#sec=health' });
    }
  }
  if (changed) await saveJson('health_alerts', alertMemo);
}
async function morningDigest() {
  const day = istYmd(), hm = istHHMM();
  if (lastDigestDay === day || hm < DIGEST_HHMM || hm > '10:30') return;
  lastDigestDay = day;
  await saveJson('health_digest', { day });
  const open = Object.values(state.issues).filter(i => !(snoozed[i.key] && new Date(snoozed[i.key]).getTime() > Date.now()));
  const fixed = fixes.filter(f => Date.now() - new Date(f.at).getTime() < 24 * 3600 * 1000).length;
  const fixedTxt = fixed ? ' Fixed by itself in the last day: ' + fixed + '.' : '';
  if (!open.length) {
    if (deps.push) deps.push.send('alert', { title: 'Morning check', body: '✅ Everything is running fine.' + fixedTxt, tag: 'health-digest', url: '/pages/dashboard#sec=health' });
    return;
  }
  const list = open.slice().sort((a, b) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1)).slice(0, 5).map(i => (i.level === 'bad' ? '🔴 ' : '⚠️ ') + i.title).join('; ');
  await notifyRow('warning', '⚠️ Morning check: ' + open.length + ' thing' + (open.length > 1 ? 's need' : ' needs') + ' you. ' + list + '.' + fixedTxt);
}

// ── LOOP ──
let svcBusy = false, dataBusy = false;
async function serviceTick() {
  if (svcBusy) return; svcBusy = true;
  try { await checkServices(); await flushErrors(); await fixStalledJobs().catch(() => {}); await alertTransitions(); await morningDigest(); }
  catch (e) { console.warn('health service tick:', e.message); }
  finally { svcBusy = false; }
}
async function dataTick() {
  if (dataBusy) return; dataBusy = true;
  try { await checkData(); await autoFix(); await checkData(); await alertTransitions(); }
  catch (e) { console.warn('health data tick:', e.message); }
  finally { dataBusy = false; }
}

function init(client, d = {}) {
  supabase = client; deps = d;
  watchJobs(); watchConsole();
}
async function startWorker() {
  alertMemo = await loadJson('health_alerts', {});
  delete alertMemo['data:rzp-missing'];
  fixes = await loadJson('health_fixes', []); if (!Array.isArray(fixes)) fixes = [];
  fixDone = await loadJson('health_fixdone', {});   // replaced by one issue per payment in health-2
  snoozed = await loadJson('health_snooze', {});
  const dg = await loadJson('health_digest', {}); lastDigestDay = dg.day || null;
  // Using the untouched timer so the watcher does not watch itself.
  setTimeout(() => { serviceTick(); dataTick(); }, 90 * 1000);
  setInterval(serviceTick, SERVICE_EVERY);
  setInterval(dataTick, DATA_EVERY);
  console.log('Health watch on (' + VERSION + '): ' + Object.keys(state.jobs).length + ' jobs watched');
}

// ── ENDPOINTS ──
function publicIssue(i) { return { ...i, snoozedUntil: snoozed[i.key] || null }; }
function statusHandler(req, res) {
  const issues = Object.values(state.issues).map(publicIssue).sort((a, b) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));
  const active = issues.filter(i => !(i.snoozedUntil && new Date(i.snoozedUntil) > new Date()));
  res.json({
    ok: true, version: VERSION, startedAt: state.startedAt,
    checkedAt: state.lastServiceRun, dataCheckedAt: state.lastDataRun,
    overall: active.some(i => i.level === 'bad') ? 'bad' : active.length ? 'warn' : 'ok',
    services: Object.values(state.services),
    jobs: Object.values(state.jobs).map(j => ({ key: j.key, label: j.label, every: j.every, lastStart: j.lastStart, lastOk: j.lastOk, lastErr: j.lastErr, err: j.err, runs: j.runs, fails: j.fails, streak: j.streak,
      status: state.issues['job:' + j.key] ? state.issues['job:' + j.key].level : 'ok' })),
    issues, asked: state.asked || [], errors: (state.recentErrors || []).slice(0, 10), fixes: fixes.slice(0, 15)
  });
}
async function runHandler(req, res) {
  await Promise.allSettled([serviceTick(), dataTick()]);
  statusHandler(req, res);
}
async function snoozeHandler(req, res) {
  const key = String(req.body?.key || ''); const hours = Math.min(key.startsWith('data:rzp:') ? 24 * 3650 : 168, Math.max(1, Number(req.body?.hours) || 24));
  if (!key) return res.status(400).json({ error: 'key required' });
  snoozed[key] = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await saveJson('health_snooze', snoozed);
  res.json({ ok: true, until: snoozed[key] });
}
// Errors from the dashboard / website. Public, so it is small and rate limited.
const hits = new Map();
function clientErrorHandler(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const now = Date.now(), h = hits.get(ip) || [];
  const recent = h.filter(t => now - t < 60000); recent.push(now); hits.set(ip, recent);
  if (hits.size > 2000) hits.clear();
  if (recent.length > 10) return res.status(429).json({ ok: false });
  const b = req.body || {};
  const page = String(b.page || 'site').replace(/[^a-z0-9._/-]/gi, '').slice(0, 60) || 'site';
  const msg = String(b.message || '').slice(0, 400);
  const at = String(b.at || '').slice(0, 160);
  if (msg) recordError(/dashboard/.test(page) ? 'dashboard' : 'site', page, msg + (at ? ' @ ' + at : ''));
  res.json({ ok: true });
}
async function resolveErrorHandler(req, res) {
  try { await supabase.from('system_errors').update({ resolved: true }).eq('id', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = { init, startWorker, statusHandler, runHandler, snoozeHandler, clientErrorHandler, resolveErrorHandler, recordError,
  _test: { state, autoFix, fixMissedPayments, fixInvoiceEmails, fixWhatsApp, fixStuckDrafts, fixStalledJobs, getFixes: () => fixes, jobKeyFor, normalizeMsg, checkServices, checkData, alertTransitions, morningDigest, setIssue, flushErrors, errBuf, setDeps: (c, d) => { supabase = c; deps = d; } } };
