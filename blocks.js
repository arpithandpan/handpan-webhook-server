// ── BLOCK TIME (Arpit's leave, illness, travel) ──
// Arpit blocks a day, a range of days, or a few hours. Then, by itself:
//  • every weekly class (or moved / make-up class) in that time is skipped
//    with a class_exceptions row that carries block_id. It is never counted,
//    and the student can book a make-up on My bookings (like their own skip).
//  • each student gets an email (and WhatsApp template class_cancelled_by_arpit
//    once WA_BLOCK_TEMPLATE=on) with a "pick a make-up time" link.
//  • booked trials in that time are cancelled with the usual "pick a new
//    time" email (trialBooking.cancelTrial).
//  • the time is busy for the trial page and My bookings (busyIntervals
//    reads the blocks table), and calendar invites update by themselves
//    (the calendar worker sees the skips).
// Unblocking deletes the skips that are still plain skips (a make-up the
// student already booked stays) and tells those students the class is back.
//
// Table blocks (blocks.sql). Admin routes in index.js.

const IST = 'Asia/Kolkata';
const studio = require('./studio-time');   // the days and hours Arpit enters are on his own clock
const MIN = 60000, DAY = 86400000;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.TRIAL_FROM_EMAIL || 'classes@arpitpandey.com';
const ARPIT_EMAIL = process.env.TRIAL_ARPIT_EMAIL || 'arpithandpan@gmail.com';
const SITE = 'https://arpitpandey.com';

let supabase = null, whatsapp = null, trialBooking = null, portal = null, push = null;
function init(client, deps = {}) {
  supabase = client; whatsapp = deps.whatsapp || null; trialBooking = deps.trialBooking || null;
  portal = deps.studentPortal || null; push = deps.push || null;
}
function waOn() { return String(process.env.WA_BLOCK_TEMPLATE || '').trim().toLowerCase() === 'on'; }

// ── time helpers ──
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } }
function istYmd(ms) { return new Date(Number(ms) + 330 * MIN).toISOString().slice(0, 10); }
function istHhmm(ms) { return new Date(Number(ms) + 330 * MIN).toISOString().slice(11, 16); }
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekdayOf(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); }
function istMs(ymd, hhmm) { return new Date(ymd + 'T' + String(hhmm).slice(0, 5) + ':00+05:30').getTime(); }
function zonedToUtc(ymd, hhmm, tz) { return trialBooking._test.zonedToUtc(ymd, hhmm, tz).getTime(); }
function fmt(ms, tz, opts) { return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(ms)); }
function dayText(ms, tz) { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms)).replace(',', ''); }
function timeText(ms, tz) { return fmt(ms, tz, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?([AP]M)$/i, ' $1'); }
function tzName(tz) { return tz === IST || tz === 'Asia/Calcutta' ? 'IST' : String(tz).split('/').pop().replace(/_/g, ' ') + ' time'; }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Body { mode: 'day'|'hours', from: 'YYYY-MM-DD', to?: 'YYYY-MM-DD', start?: 'HH:MM', end?: 'HH:MM', note?, tz? } → { s, e } in ms.
// The dates and hours are Arpit's own wall clock (b.tz from the dashboard, else the studio zone).
function rangeOf(b) {
  const from = String(b.from || ''), to = String(b.to || b.from || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return { error: 'Pick valid dates' };
  if (to > addDays(from, 60)) return { error: 'Block at most 60 days at once' };
  if (b.mode === 'hours') {
    if (from !== to) return { error: 'Hours can only be blocked on one day' };
    if (!/^\d{2}:\d{2}$/.test(String(b.start || '')) || !/^\d{2}:\d{2}$/.test(String(b.end || ''))) return { error: 'Pick a start and end time' };
    const z = validTz(b.tz) ? b.tz : studio.tz();
    let s = studio.toUtc(from, b.start, z), e = studio.toUtc(from, b.end, z);
    if (e <= s) e = studio.toUtc(addDays(from, 1), b.end, z);   // e.g. 10 PM to 1 AM
    return { s, e };
  }
  const z = validTz(b.tz) ? b.tz : studio.tz();
  return { s: studio.toUtc(from, '00:00', z), e: studio.toUtc(addDays(to, 1), '00:00', z) };
}

// Every class and booked trial that overlaps [s, e).
async function affected(s, e) {
  const fromYmd = addDays(istYmd(s), -1), toYmd = addDays(istYmd(e), 1);
  const [sch, st, ex, tr] = await Promise.all([
    supabase.from('class_schedule').select('*').eq('active', true),
    supabase.from('students').select('id, full_name, email, extra_emails, phone, archived, status'),
    supabase.from('class_exceptions').select('*').gte('original_date', addDays(fromYmd, -14)).lte('original_date', addDays(toYmd, 14)),
    supabase.from('trials').select('id, full_name, start_at, duration_min, status, email').eq('status', 'booked')
      .gte('start_at', new Date(s - DAY).toISOString()).lte('start_at', new Date(e + DAY).toISOString())
  ]);
  for (const r of [sch, st, ex, tr]) if (r.error) throw new Error(r.error.message);
  const students = Object.fromEntries((st.data || []).map(x => [x.id, x]));
  const exBy = {};
  for (const x of ex.data || []) exBy[x.student_id + '|' + String(x.original_date).slice(0, 10)] = x;
  const classes = [];
  const seen = new Set();
  for (const row of sch.data || []) {
    const stu = students[row.student_id];
    if (!stu || stu.archived) continue;
    const tz = row.student_tz && validTz(row.student_tz) ? row.student_tz : IST;
    const local = row.local_time != null && row.local_weekday != null && tz !== IST;
    const dur = (Number(row.duration_min) || 60) * MIN;
    for (let d = addDays(fromYmd, -1); d <= addDays(toYmd, 1); d = addDays(d, 1)) {
      let start;
      if (local) { if (weekdayOf(d) !== Number(row.local_weekday)) continue; start = zonedToUtc(d, String(row.local_time).slice(0, 5), tz); }
      else { if (weekdayOf(d) !== Number(row.weekday)) continue; start = istMs(d, row.time_ist); }
      if (isNaN(start)) continue;
      const key = istYmd(start);
      const x = exBy[row.student_id + '|' + key];
      if (x && (x.action === 'skip' || x.action === 'move')) continue;   // already off, or moved (handled below)
      if (start < e && start + dur > s && !seen.has(row.student_id + '|' + key)) {
        seen.add(row.student_id + '|' + key);
        classes.push({ studentId: row.student_id, name: stu.full_name, key, start, tz, dur: dur / MIN, ex: null });
      }
    }
  }
  // Moved and make-up classes landing in the block.
  for (const x of ex.data || []) {
    if (x.action !== 'move' || !x.new_date || !x.new_time_ist) continue;
    const stu = students[x.student_id];
    if (!stu || stu.archived) continue;
    const start = istMs(String(x.new_date).slice(0, 10), x.new_time_ist);
    const key = String(x.original_date).slice(0, 10);
    if (start < e && start + 60 * MIN > s && !seen.has(x.student_id + '|' + key)) {
      seen.add(x.student_id + '|' + key);
      const row = (sch.data || []).find(r => r.student_id === x.student_id);
      const tz = row && row.student_tz && validTz(row.student_tz) ? row.student_tz : IST;
      classes.push({ studentId: x.student_id, name: stu.full_name, key, start, tz, dur: 60, ex: x });
    }
  }
  classes.sort((a, b) => a.start - b.start);
  const trials = (tr.data || []).map(t => ({ id: t.id, name: t.full_name, start: new Date(t.start_at).getTime(), dur: Number(t.duration_min) || 45 }))
    .filter(t => t.start < e && t.start + t.dur * MIN > s).sort((a, b) => a.start - b.start);
  return { classes, trials, students };
}

function summary(a) {
  return {
    classes: a.classes.map(c => ({ studentId: c.studentId, name: c.name, when: dayText(c.start, studio.tz()) + ', ' + timeText(c.start, studio.tz()) + ' ' + studio.label(), key: c.key, moved: !!c.ex })),
    trials: a.trials.map(t => ({ id: t.id, name: t.name, when: dayText(t.start, studio.tz()) + ', ' + timeText(t.start, studio.tz()) + ' ' + studio.label() }))
  };
}

// ── messages ──
async function mail(to, subject, html, text) {
  if (!RESEND_API_KEY || !to || !to.length) return { ok: false, error: 'no email' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Arpit Pandey <' + FROM_EMAIL + '>', to, subject, html, text, reply_to: ARPIT_EMAIL })
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return { ok: false, error: j.message || ('HTTP ' + r.status) }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
function shell(inner) {
  return '<div style="background:#F5EEE5;padding:28px 16px;font-family:Helvetica,Arial,sans-serif;color:#5A4645;"><div style="max-width:520px;margin:0 auto;background:#FFFDFA;border-radius:16px;padding:28px 24px;">' + inner +
    '<p style="margin:28px 0 0;font-size:13px;color:#6B5150;">Arpit Pandey · Handpan artist and teacher<br><a href="' + SITE + '" style="color:#500018;">arpitpandey.com</a></p></div></div>';
}
function btn(href, label) { return '<p style="margin:22px 0;"><a href="' + href + '" style="display:inline-block;background:#500018;color:#fff;text-decoration:none;padding:13px 26px;border-radius:40px;font-weight:600;">' + esc(label) + '</a></p>'; }
function emailsOf(s) {
  const out = [];
  for (const e of [s.email].concat(String(s.extra_emails || '').split(/[,;\s]+/))) { const v = String(e || '').trim().toLowerCase(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !out.includes(v)) out.push(v); }
  return out;
}
async function myLink(studentId) {
  try { if (portal && portal.linkForStudent) { const l = await portal.linkForStudent(studentId); if (l && l.url) return l.url; } } catch (e) {}
  return SITE + '/my';
}

// One message per student, listing all their cancelled classes.
async function tellStudents(byStudent, students, kind) {
  const results = [];
  for (const [sid, list] of Object.entries(byStudent)) {
    const s = students[sid]; if (!s) continue;
    const tz = list[0].tz;
    const lines = list.map(c => dayText(c.start, tz) + ' at ' + timeText(c.start, tz) + (tz === IST ? ' IST' : ' (' + tzName(tz) + ')'));
    const link = await myLink(sid);
    let m;
    if (kind === 'cancel') {
      m = await mail(emailsOf(s), list.length === 1 ? 'Your handpan class on ' + dayText(list[0].start, tz) + ' is cancelled' : 'Some of your handpan classes are cancelled',
        shell('<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(firstName(s.full_name)) + ',</p>' +
          '<p style="margin:0 0 12px;line-height:1.55;">I’m not available then, so ' + (list.length === 1 ? 'this class is' : 'these classes are') + ' cancelled:</p>' +
          '<p style="margin:0 0 12px;line-height:1.7;"><b>' + lines.map(esc).join('<br>') + '</b></p>' +
          '<p style="margin:0;line-height:1.55;">' + (list.length === 1 ? 'It won’t' : 'They won’t') + ' be counted. You can book a make-up class at any free time this month.</p>' +
          btn(link, 'Pick a make-up time') + '<p style="margin:0;line-height:1.55;color:#6B5150;font-size:14px;">Sorry for the change. Your calendar updates by itself.</p>'),
        'Hi ' + firstName(s.full_name) + ', I am not available then, so these classes are cancelled: ' + lines.join('; ') + '. They will not be counted. Book a make-up: ' + link);
      if (waOn() && whatsapp && s.phone) {
        await whatsapp.sendTemplate(s.phone, 'class_cancelled_by_arpit', [firstName(s.full_name), lines.join(', ')]).catch(() => null);
      }
    } else {
      m = await mail(emailsOf(s), 'Good news: your handpan class is back on',
        shell('<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(firstName(s.full_name)) + ',</p>' +
          '<p style="margin:0 0 12px;line-height:1.55;">My plans changed, so ' + (list.length === 1 ? 'this class is' : 'these classes are') + ' back on as usual:</p>' +
          '<p style="margin:0 0 12px;line-height:1.7;"><b>' + lines.map(esc).join('<br>') + '</b></p>' +
          '<p style="margin:0;line-height:1.55;">Same Zoom link. If it doesn’t suit you any more, you can move or skip it on your page.</p>' + btn(link, 'See my classes')),
        'Hi ' + firstName(s.full_name) + ', these classes are back on: ' + lines.join('; ') + '. Same Zoom link. ' + link);
    }
    results.push({ studentId: sid, email: m.ok ? 'sent' : m.error });
  }
  return results;
}

async function notify(type, message) { try { await supabase.from('notifications').insert({ type, message, read: false }); } catch (e) {} }

// ── handlers ──
async function previewHandler(req, res) {
  try {
    const r = rangeOf(req.body || {}); if (r.error) return res.status(400).json({ ok: false, error: r.error });
    const a = await affected(r.s, r.e);
    res.json({ ok: true, ...summary(a) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

async function createHandler(req, res) {
  try {
    const b = req.body || {};
    const r = rangeOf(b); if (r.error) return res.status(400).json({ ok: false, error: r.error });
    const a = await affected(r.s, r.e);
    const note = String(b.note || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 200) || null;
    const { data: blk, error } = await supabase.from('blocks').insert({
      start_at: new Date(r.s).toISOString(), end_at: new Date(r.e).toISOString(), all_day: b.mode !== 'hours', note
    }).select().single();
    if (error) throw new Error('blocks: ' + error.message);
    // 1. Classes → skips tagged with this block.
    const byStudent = {};
    for (const c of a.classes) {
      const fields = { action: 'skip', new_date: null, new_time_ist: null, makeup: false, block_id: blk.id, updated_at: new Date().toISOString() };
      const { data: rows } = await supabase.from('class_exceptions').select('id').eq('student_id', c.studentId).eq('original_date', c.key);
      const q = rows && rows.length
        ? supabase.from('class_exceptions').update({ ...fields, prev: c.ex ? { action: c.ex.action, new_date: c.ex.new_date, new_time_ist: c.ex.new_time_ist, makeup: c.ex.makeup } : null }).eq('id', rows[0].id)
        : supabase.from('class_exceptions').insert({ student_id: c.studentId, original_date: c.key, student_changes: 0, ...fields });
      const { error: e2 } = await q;
      if (e2) { await notify('warning', '🔴 Block: could not cancel ' + c.name + '’s class on ' + c.key + ': ' + e2.message + '. Skip it on the Schedule page.'); continue; }
      (byStudent[c.studentId] = byStudent[c.studentId] || []).push(c);
    }
    // 2. Trials → cancelled with the usual email.
    const trialOut = [];
    for (const t of a.trials) {
      const x = trialBooking ? await trialBooking.cancelTrial(t.id).catch(e => ({ ok: false, error: e.message })) : { ok: false, error: 'no trial module' };
      trialOut.push({ id: t.id, ok: !!x.ok });
      if (!x.ok) await notify('warning', '🔴 Block: could not cancel ' + t.name + '’s trial: ' + (x.error || 'unknown') + '. Cancel it on the Students page.');
    }
    // 3. Tell the students.
    const told = await tellStudents(byStudent, a.students, 'cancel');
    await supabase.from('blocks').update({ affected: { classes: summary(a).classes, trials: summary(a).trials, told } }).eq('id', blk.id);
    const failed = told.filter(t => t.email !== 'sent');
    await notify(failed.length ? 'warning' : 'info', (failed.length ? '⚠️ ' : '⛔ ') + 'Blocked ' + (b.mode === 'hours' ? dayText(r.s, studio.tz()) + ' ' + timeText(r.s, studio.tz()) + '–' + timeText(r.e, studio.tz()) : dayText(r.s, studio.tz()) + (studio.ymd(r.e - 1) !== studio.ymd(r.s) ? ' to ' + dayText(r.e - 1, studio.tz()) : '')) +
      ': ' + Object.keys(byStudent).length + ' student' + (Object.keys(byStudent).length === 1 ? '' : 's') + ' told, ' + a.trials.length + ' trial' + (a.trials.length === 1 ? '' : 's') + ' cancelled.' +
      (failed.length ? ' Email failed for ' + failed.map(f => (a.students[f.studentId] || {}).full_name || f.studentId).join(', ') + ', message them yourself.' : ''));
    res.json({ ok: true, id: blk.id, classes: a.classes.length, trials: a.trials.length, told });
  } catch (e) { console.error('block create error:', e.message); res.status(500).json({ ok: false, error: e.message }); }
}

async function removeHandler(req, res) {
  try {
    const id = Number(req.params.id);
    const { data: blk } = await supabase.from('blocks').select('*').eq('id', id).maybeSingle();
    if (!blk || blk.removed_at) return res.status(404).json({ ok: false, error: 'Block not found' });
    const { data: rows, error } = await supabase.from('class_exceptions').select('*').eq('block_id', id);
    if (error) throw new Error(error.message);
    const [{ data: studs }, { data: sch }] = await Promise.all([
      supabase.from('students').select('id, full_name, email, extra_emails, phone, archived'),
      supabase.from('class_schedule').select('*').eq('active', true)
    ]);
    const students = Object.fromEntries((studs || []).map(x => [x.id, x]));
    const byStudent = {};
    for (const x of rows || []) {
      if (x.action !== 'skip') { await supabase.from('class_exceptions').update({ block_id: null }).eq('id', x.id); continue; }  // a make-up was booked: keep it
      let start;
      if (x.prev && x.prev.action === 'move') {
        await supabase.from('class_exceptions').update({ ...x.prev, block_id: null, prev: null, updated_at: new Date().toISOString() }).eq('id', x.id);
        start = istMs(String(x.prev.new_date).slice(0, 10), x.prev.new_time_ist);
      } else {
        await supabase.from('class_exceptions').delete().eq('id', x.id);
        const row = (sch || []).find(r => r.student_id === x.student_id);
        start = row ? istMs(String(x.original_date).slice(0, 10), row.time_ist) : istMs(String(x.original_date).slice(0, 10), '12:00');
        if (row && row.local_time != null && row.student_tz && row.student_tz !== IST) {
          // Local-anchored slot: rebuild the start from the student's own clock (same IST date key).
          for (const d of [addDays(String(x.original_date).slice(0, 10), -1), String(x.original_date).slice(0, 10), addDays(String(x.original_date).slice(0, 10), 1)]) {
            if (weekdayOf(d) !== Number(row.local_weekday)) continue;
            const t = zonedToUtc(d, String(row.local_time).slice(0, 5), row.student_tz);
            if (istYmd(t) === String(x.original_date).slice(0, 10)) start = t;
          }
        }
      }
      if (start < Date.now()) continue;   // nothing to tell about past classes
      const row = (sch || []).find(r => r.student_id === x.student_id);
      const tz = row && row.student_tz && validTz(row.student_tz) ? row.student_tz : IST;
      (byStudent[x.student_id] = byStudent[x.student_id] || []).push({ start, tz });
    }
    await supabase.from('blocks').update({ removed_at: new Date().toISOString() }).eq('id', id);
    const told = await tellStudents(byStudent, students, 'restore');
    await notify('info', '✅ Unblocked ' + dayText(new Date(blk.start_at).getTime(), studio.tz()) + ': ' + told.length + ' student' + (told.length === 1 ? '' : 's') + ' told their class is back on. Cancelled trials stay cancelled.');
    res.json({ ok: true, restored: told.length });
  } catch (e) { console.error('block remove error:', e.message); res.status(500).json({ ok: false, error: e.message }); }
}

async function listHandler(req, res) {
  try {
    const { data, error } = await supabase.from('blocks').select('*').is('removed_at', null)
      .gte('end_at', new Date(Date.now() - 7 * DAY).toISOString()).order('start_at', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ ok: true, blocks: data || [] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}

// For busyIntervals: active blocks as { s, e, what }.
async function busyBlocks(fromMs, toMs) {
  if (!supabase) return [];
  const { data, error } = await supabase.from('blocks').select('id, start_at, end_at').is('removed_at', null)
    .lte('start_at', new Date(toMs + DAY).toISOString()).gte('end_at', new Date(fromMs - DAY).toISOString());
  if (error) return [];
  return (data || []).map(b => ({ s: new Date(b.start_at).getTime(), e: new Date(b.end_at).getTime(), what: 'blocked ' + b.id }));
}

module.exports = { init, previewHandler, createHandler, removeHandler, listHandler, busyBlocks, _test: { rangeOf, affected, summary } };
