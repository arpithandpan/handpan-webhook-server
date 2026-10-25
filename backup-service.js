// ── WEEKLY DATA BACKUP ──
// Every Sunday after 9 AM IST the server emails Arpit a copy of the database:
// one CSV file per table (opens in Excel / Numbers / Google Sheets).
// Tables are found automatically, so new tables are included without a code
// change. Tables holding keys, tokens or login codes are skipped.
//
// It remembers the last backup through a dashboard notification
// ("💾 Weekly backup sent …"), so a restart never sends it twice.
//
// Env BACKUP_EMAIL_TO (default arpithandpan@gmail.com). BACKUP=off stops it.
// POST /api/backup/run (admin) sends one now.

let supabase = null;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.TRIAL_FROM_EMAIL || 'classes@arpitpandey.com';
const TO = process.env.BACKUP_EMAIL_TO || 'arpithandpan@gmail.com';
const SKIP = /(key|token|secret|session|code|otp|login|push_)/i;
const PAGE = 1000;
const MAX_BYTES = 35 * 1024 * 1024;   // Resend allows 40 MB per email

function init(client) { supabase = client; }
function on() { return String(process.env.BACKUP || '').trim().toLowerCase() !== 'off'; }

async function listTables() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1/';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const r = await fetch(url, { headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/openapi+json' } });
  if (!r.ok) throw new Error('table list: HTTP ' + r.status);
  const j = await r.json();
  const names = Object.keys(j.definitions || {}).length ? Object.keys(j.definitions) : Object.keys(j.paths || {}).map(p => p.replace(/^\//, '')).filter(p => p && !p.startsWith('rpc/'));
  return names.filter(n => !SKIP.test(n)).sort();
}

async function readAll(table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + PAGE - 1);
    if (error) throw new Error(table + ': ' + error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

function cell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

function istDate(d) { return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10); }

async function run(reason) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const tables = await listTables();
  const files = [], counts = [], failed = [];
  let bytes = 0;
  for (const t of tables) {
    try {
      const rows = await readAll(t);
      const csv = toCsv(rows);
      const b = Buffer.from(csv, 'utf8');
      if (bytes + b.length > MAX_BYTES) { failed.push(t + ' (too big for one email)'); continue; }
      bytes += b.length;
      files.push({ filename: t + '.csv', content: b.toString('base64') });
      counts.push([t, rows.length]);
    } catch (e) { failed.push(t + ' (' + e.message + ')'); }
  }
  const day = istDate(new Date());
  const total = counts.reduce((a, c) => a + c[1], 0);
  const list = counts.map(([t, n]) => '<tr><td style="padding:2px 14px 2px 0;">' + t + '</td><td style="text-align:right;">' + n + '</td></tr>').join('');
  const html = '<div style="font-family:Helvetica,Arial,sans-serif;color:#3d2b1f;font-size:14px;">' +
    '<p>Weekly backup of the studio database, ' + day + '. ' + counts.length + ' tables, ' + total + ' rows. Each table is attached as a CSV file.</p>' +
    '<p>Keep this email. To restore anything, send the file to Claude.</p>' +
    '<table style="border-collapse:collapse;font-size:13px;">' + list + '</table>' +
    (failed.length ? '<p style="color:#a3341f;">Not included: ' + failed.join(', ') + '</p>' : '') + '</div>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Studio backup <' + FROM_EMAIL + '>', to: [TO], subject: '💾 Studio backup · ' + day + ' · ' + total + ' rows', html, attachments: files })
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('email: ' + (j.message || ('HTTP ' + r.status))); }
  await supabase.from('notifications').insert({
    type: failed.length ? 'warning' : 'info',
    message: '💾 Weekly backup sent to ' + TO + ' (' + counts.length + ' tables, ' + total + ' rows' + (failed.length ? ', ' + failed.length + ' not included' : '') + ')' + (reason ? ' · ' + reason : ''),
    read: false
  });
  console.log('Backup sent:', counts.length, 'tables,', total, 'rows,', Math.round(bytes / 1024), 'KB');
  return { tables: counts.length, rows: total, kb: Math.round(bytes / 1024), failed };
}

// Sunday (IST) from 9 AM, once per week.
async function due() {
  const st = require('./studio-time'), off = st.offsetMin() * 60000;
  const ist = new Date(Date.now() + off);   // Arpit's own clock
  if (ist.getUTCDay() !== 0 || ist.getUTCHours() < 9) return false;
  // Only a backup sent today (Sunday, IST) counts; one sent by hand earlier in the week doesn't skip Sunday's.
  const since = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - off).toISOString();
  const { data } = await supabase.from('notifications').select('id').like('message', '💾 Weekly backup sent%').not('message', 'like', '%sent by hand%').gte('created_at', since).limit(1);
  return !(data && data.length);
}

let _timer = null, _busy = false, _failDay = '';
function startWorker() {
  if (_timer) return;
  console.log('Weekly backup: ' + (on() ? 'Sundays 9 AM IST to ' + TO : 'off'));
  const tick = async () => {
    if (_busy || !on()) return;
    _busy = true;
    try { if (await due()) await run(); }
    catch (e) {
      console.error('Backup failed:', e.message);
      const d = istDate(new Date());
      if (_failDay !== d) { _failDay = d; try { await supabase.from('notifications').insert({ type: 'warning', message: '🔴 Weekly backup failed: ' + e.message, read: false }); } catch (er) {} }
    } finally { _busy = false; }
  };
  setTimeout(tick, 2 * 60 * 1000);
  _timer = setInterval(tick, 30 * 60 * 1000);
}

async function runHandler(req, res) {
  if (_busy) return res.status(409).json({ error: 'busy' });
  _busy = true;
  try { res.json({ ok: true, ...(await run('sent by hand')) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
  finally { _busy = false; }
}

module.exports = { init, startWorker, run, runHandler, _test: { toCsv, listTables } };
