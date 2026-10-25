// studio-time.js
// "Arpit's clock": the time zone Arpit is working in right now. India by default.
//
// Only things that follow Arpit's own day use it:
//   trial and make-up slot windows, blocked days he enters, the agent's
//   night/weekend hours, phone quiet hours, the morning check, the Sunday
//   review and backup, and how the dashboard shows times to him.
//
// Things it must NEVER touch: students' class times (class_schedule is kept in
// each student's own zone), class_exceptions date keys, Zoom meetings,
// calendar invites, anything a student sees. Changing the studio zone sends
// nothing to anyone.
//
// Stored in app_settings key "studio_tz": { tz, since, history: [{ tz, since }] }.
// Read once at start and every minute after, so every caller can ask for it
// without waiting (tz() is sync).

const DEFAULT_TZ = 'Asia/Kolkata';
const MIN = 60000;
let supabase = null;
let _tz = DEFAULT_TZ, _row = null, _timer = null;

function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return !!tz; } catch (e) { return false; } }
function tz() { return _tz; }

async function refresh() {
  if (!supabase) return _tz;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'studio_tz').maybeSingle();
    const v = data && data.value;
    if (v && validTz(v.tz)) { _tz = v.tz; _row = v; }
  } catch (e) { /* keep the last known zone */ }
  return _tz;
}
function init(client) {
  supabase = client;
  refresh();
  if (!_timer) { _timer = setInterval(refresh, MIN); if (_timer.unref) _timer.unref(); }
}

// ── clock helpers (all in the studio zone unless a zone is passed) ──
function parts(ms = Date.now(), zone = _tz) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  const ymd = p.year + '-' + p.month + '-' + p.day, hhmm = p.hour + ':' + p.minute;
  return { ymd, hhmm, weekday: new Date(ymd + 'T00:00:00Z').getUTCDay(), minutes: (+p.hour) * 60 + (+p.minute), second: +p.second };
}
// Minutes the zone is ahead of UTC at that moment (IST = 330, Berlin = 60 or 120).
function offsetMin(ms = Date.now(), zone = _tz) {
  const p = parts(ms, zone);
  const asUtc = Date.UTC(+p.ymd.slice(0, 4), +p.ymd.slice(5, 7) - 1, +p.ymd.slice(8, 10), +p.hhmm.slice(0, 2), +p.hhmm.slice(3, 5), p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MIN);
}
// A Date shifted so its getUTC* fields read as the studio's wall clock.
// (Drop-in for the old `new Date(Date.now() + 330 * 60000)`.)
function shifted(ms = Date.now(), zone = _tz) { return new Date(ms + offsetMin(ms, zone) * MIN); }
// Wall-clock date + "HH:MM" in a zone → the real moment (ms). Handles DST.
function toUtc(ymd, hhmm, zone = _tz) {
  const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), +String(hhmm).slice(0, 2), +String(hhmm).slice(3, 5));
  let t = guess - offsetMin(guess, zone) * MIN;
  const t2 = guess - offsetMin(t, zone) * MIN;
  return t2;
}
function ymd(ms = Date.now(), zone = _tz) { return parts(ms, zone).ymd; }
function midnight(day, zone = _tz) { return toUtc(day, '00:00', zone); }
// Short label for a zone: IST, CET, EDT, … or "Berlin time".
function label(zone = _tz, ms = Date.now()) {
  if (zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta') return 'IST';
  try {
    for (const loc of ['en-US', 'en-GB']) {
      const n = new Intl.DateTimeFormat(loc, { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find(x => x.type === 'timeZoneName');
      if (n && !/^(GMT|UTC)/.test(n.value)) return n.value;
    }
  } catch (e) {}
  return String(zone).split('/').pop().replace(/_/g, ' ') + ' time';
}
function place(zone = _tz) {
  if (zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta') return 'India';
  return String(zone).split('/').pop().replace(/_/g, ' ');
}

// ── API ──
// GET /api/studio-time → { tz, label, place, since, history, default }
async function getHandler(req, res) {
  await refresh();
  res.json({ tz: _tz, label: label(), place: place(), since: _row && _row.since || null, history: (_row && _row.history) || [], default: DEFAULT_TZ });
}
// POST /api/studio-time { tz } → saves. Sends nothing to anyone.
async function setHandler(req, res) {
  try {
    const want = String((req.body || {}).tz || '').trim();
    if (!validTz(want)) return res.status(400).json({ error: 'Not a time zone: ' + want });
    await refresh();
    if (want === _tz) return res.json({ ok: true, tz: _tz, label: label(), place: place(), changed: false });
    const hist = ((_row && _row.history) || []).concat([{ tz: _tz, until: new Date().toISOString() }]).slice(-20);
    const value = { tz: want, since: new Date().toISOString(), history: hist };
    const { error } = await supabase.from('app_settings').upsert({ key: 'studio_tz', value }, { onConflict: 'key' });
    if (error) return res.status(500).json({ error: error.message });
    _tz = want; _row = value;
    console.log('Studio time zone: ' + want);
    res.json({ ok: true, tz: _tz, label: label(), place: place(), changed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = { init, refresh, tz, validTz, parts, offsetMin, shifted, toUtc, ymd, midnight, label, place, getHandler, setHandler, DEFAULT_TZ, _set: z => { _tz = z; } };
