// ── PUSH NOTIFICATIONS (Studio app on Arpit's phone / iPad / browser) ──
// The dashboard asks for permission, subscribes the device and sends the
// subscription here (POST /api/push/subscribe). This file sends pushes to
// every subscribed device, honouring each device's own switches.
//
// Keys: web push needs a VAPID key pair. It is made once, automatically, and
// kept in the private table push_keys (RLS on, no policies: only this server
// with the secret key can read it). Nothing to paste anywhere.
//
// Kinds (each device can switch any of them off):
//   wa       – someone messaged the studio WhatsApp
//   draft    – the agent wrote a draft reply (replaces the wa push silently)
//   payment  – money in, failed payments
//   trial    – new trial booked
//   alert    – everything else marked urgent (Zoom, My bookings changes…)
//
// Quiet hours: prefs.quiet = true keeps that device silent 11 PM – 7 AM IST.
// Pushes in quiet hours are simply not sent; the dashboard still has
// everything.

const webpush = require('web-push');

const SUBJECT = 'mailto:arpithandpan@gmail.com';
const KINDS = ['wa', 'draft', 'payment', 'trial', 'alert'];
const DEFAULT_PREFS = { wa: true, draft: true, payment: true, trial: true, alert: true, quiet: false };
const QUIET_FROM = 23 * 60, QUIET_TO = 7 * 60;   // IST minutes

let supabase = null;
let keys = null;          // { publicKey, privateKey }
let keysPromise = null;

function init(client) { supabase = client; }

// ── KEYS ──
async function loadKeys() {
  if (keys) return keys;
  if (keysPromise) return keysPromise;
  keysPromise = (async () => {
    const { data, error } = await supabase.from('push_keys').select('*').eq('id', 1).maybeSingle();
    if (error) throw new Error('push_keys: ' + error.message);
    let k = data;
    if (!k) {
      const g = webpush.generateVAPIDKeys();
      const ins = await supabase.from('push_keys').insert({ id: 1, public_key: g.publicKey, private_key: g.privateKey }).select().single();
      if (ins.error) {
        // Two requests raced: read what the other one saved.
        const again = await supabase.from('push_keys').select('*').eq('id', 1).maybeSingle();
        if (!again.data) throw new Error('push_keys insert: ' + ins.error.message);
        k = again.data;
      } else k = ins.data;
      console.log('Push: new VAPID keys created');
    }
    keys = { publicKey: k.public_key, privateKey: k.private_key };
    webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
    return keys;
  })();
  try { return await keysPromise; } finally { keysPromise = null; }
}

function cleanPrefs(p) {
  const out = { ...DEFAULT_PREFS };
  if (p && typeof p === 'object') for (const k of Object.keys(DEFAULT_PREFS)) if (typeof p[k] === 'boolean') out[k] = p[k];
  return out;
}
function istMinutes(d) { const t = new Date(d.getTime() + 330 * 60000); return t.getUTCHours() * 60 + t.getUTCMinutes(); }
function inQuiet(now) { const m = istMinutes(now); return m >= QUIET_FROM || m < QUIET_TO; }

// ── SEND ──
// payload: { title, body, tag, url, badge, renotify }
async function send(kind, payload) {
  try {
    if (!supabase || !KINDS.includes(kind)) return 0;
    const { data: subs, error } = await supabase.from('push_subscriptions').select('*');
    if (error) { console.error('push subs query:', error.message); return 0; }
    if (!subs || !subs.length) return 0;
    await loadKeys();
    const quietNow = inQuiet(new Date());
    const body = JSON.stringify(payload);
    let sent = 0;
    await Promise.allSettled(subs.map(async s => {
      const prefs = cleanPrefs(s.prefs);
      if (!prefs[kind]) return;
      if (prefs.quiet && quietNow) return;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 6 * 3600, urgency: kind === 'draft' ? 'normal' : 'high' });
        sent++;
        supabase.from('push_subscriptions').update({ last_ok_at: new Date().toISOString(), fail_count: 0 }).eq('id', s.id).then(() => {}, () => {});
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) {
          // The device unsubscribed or the app was removed.
          try { await supabase.from('push_subscriptions').delete().eq('id', s.id); } catch (err) {}
          console.log('Push: removed expired subscription', s.id);
        } else {
          console.error('Push send failed (' + (code || e.message) + ')');
          supabase.from('push_subscriptions').update({ fail_count: (Number(s.fail_count) || 0) + 1 }).eq('id', s.id).then(() => {}, () => {});
        }
      }
    }));
    return sent;
  } catch (e) {
    console.error('Push send error:', e.message);
    return 0;
  }
}

// Conversations with unread messages, for the number on the app icon.
async function unreadChats() {
  try {
    const { data } = await supabase.from('wa_messages').select('phone').eq('direction', 'in').is('read_at', null).neq('type', 'reaction').limit(500);
    return new Set((data || []).map(r => r.phone)).size;
  } catch (e) { return undefined; }
}

// ── HOOKS ──
function onWhatsApp(phone, type, info) {
  if (type === 'reaction') return;
  (async () => {
    const badge = await unreadChats();
    await send('wa', {
      title: (info && info.who) || ('+' + phone),
      body: (info && info.preview) || 'New message',
      tag: 'wa-' + phone,
      renotify: true,
      url: '/pages/dashboard#wa=' + phone,
      badge
    });
  })();
}

function onDraft(draft, who) {
  if (!draft || draft.status !== 'pending') return;
  send('draft', {
    title: '✦ Draft ready · ' + (who || ('+' + draft.phone)),
    body: (draft.needs_arpit && draft.note ? 'Needs you: ' + draft.note + '\n' : '') + String(draft.body || '').slice(0, 160),
    tag: 'wa-' + draft.phone,      // replaces the message push for this chat
    renotify: false,
    url: '/pages/dashboard#wa=' + draft.phone
  });
}

// Urgent dashboard notifications (from notify-mailer). WhatsApp replies are
// skipped here because onWhatsApp already pushed them the moment they came in.
function onNotification(n) {
  const msg = String(n.message || '');
  if (/WhatsApp reply to/i.test(msg)) return;
  let kind = 'alert', url = '/pages/dashboard#sec=notifications';
  if (n.type === 'payment' || /payment/i.test(msg)) { kind = 'payment'; url = '/pages/dashboard#sec=payments'; }
  if (/New trial booked/i.test(msg)) { kind = 'trial'; url = '/pages/dashboard#sec=classes'; }
  send(kind, { title: 'Studio', body: msg.replace(/\s+/g, ' ').slice(0, 220), tag: 'n-' + n.id, renotify: true, url });
}

// ── DASHBOARD ENDPOINTS (admin only) ──
async function keyHandler(req, res) {
  try { const k = await loadKeys(); res.json({ publicKey: k.publicKey }); }
  catch (e) { res.status(500).json({ error: 'Push is not set up yet: ' + e.message }); }
}

// POST /api/push/subscribe { subscription: {endpoint, keys:{p256dh,auth}}, label, prefs }
async function subscribeHandler(req, res) {
  try {
    const sub = req.body?.subscription || {};
    const endpoint = String(sub.endpoint || '');
    const p256dh = String(sub.keys?.p256dh || ''), auth = String(sub.keys?.auth || '');
    if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return res.status(400).json({ error: 'Bad subscription' });
    const row = {
      endpoint, p256dh, auth,
      label: String(req.body?.label || '').slice(0, 80) || null,
      user_email: req.adminEmail || null,
      prefs: cleanPrefs(req.body?.prefs),
      fail_count: 0
    };
    const { data: have } = await supabase.from('push_subscriptions').select('id, prefs').eq('endpoint', endpoint).maybeSingle();
    if (have) {
      if (!req.body?.prefs) row.prefs = cleanPrefs(have.prefs);
      await supabase.from('push_subscriptions').update(row).eq('id', have.id);
    } else {
      const { error } = await supabase.from('push_subscriptions').insert(row);
      if (error) throw new Error(error.message);
    }
    res.json({ ok: true, prefs: row.prefs });
  } catch (e) {
    console.error('push subscribe error:', e.message);
    res.status(500).json({ error: 'Could not save this device: ' + e.message });
  }
}

// POST /api/push/prefs { endpoint, prefs }   → { prefs }
// POST /api/push/prefs { endpoint }          → just read them
async function prefsHandler(req, res) {
  try {
    const endpoint = String(req.body?.endpoint || '');
    const { data: have } = await supabase.from('push_subscriptions').select('id, prefs').eq('endpoint', endpoint).maybeSingle();
    if (!have) return res.status(404).json({ error: 'not_subscribed' });
    if (req.body?.prefs) {
      const prefs = cleanPrefs({ ...cleanPrefs(have.prefs), ...req.body.prefs });
      await supabase.from('push_subscriptions').update({ prefs }).eq('id', have.id);
      return res.json({ ok: true, prefs });
    }
    res.json({ ok: true, prefs: cleanPrefs(have.prefs) });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function unsubscribeHandler(req, res) {
  try {
    await supabase.from('push_subscriptions').delete().eq('endpoint', String(req.body?.endpoint || ''));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// POST /api/push/test → a test push to every device
async function testHandler(req, res) {
  const n = await send('alert', { title: 'Studio', body: 'Test notification. Notifications are working 🎶', tag: 'test', renotify: true, url: '/pages/dashboard' });
  res.json({ ok: true, sent: n });
}

module.exports = { init, send, onWhatsApp, onDraft, onNotification, keyHandler, subscribeHandler, prefsHandler, unsubscribeHandler, testHandler, _test: { cleanPrefs, inQuiet } };
