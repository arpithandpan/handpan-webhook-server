// enquiries.js
// Performance (gig) enquiries and general contact messages from the website.
//
// POST /api/enquiry
//   body: { kind: 'performance' | 'contact', name, email, phone?, eventType?, eventDate?,
//           city?, venue?, audience?, duration?, budget?, message?, source?, page?, website? }
//   - "website" is a honeypot. Bots fill it, people never see it.
//   - Saved to the `enquiries` table (see enquiries.sql), then:
//       1. a row in `notifications` (shows in the dashboard and pushes to the Studio app)
//       2. an email to Arpit with every detail, reply-to set to the person
//   - The page only shows "sent" after the row is saved. Emails failing does not lose the enquiry.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.ENQUIRY_FROM_EMAIL || process.env.TRIAL_FROM_EMAIL || 'classes@arpitpandey.com';
const ARPIT_EMAIL = process.env.ENQUIRY_TO_EMAIL || process.env.TRIAL_ARPIT_EMAIL || 'arpithandpan@gmail.com';

let supabase = null;
function init(client) { supabase = client; }

const _hits = new Map();
let _all = [];
function rateLimited(ip) {
  const now = Date.now();
  const list = (_hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now);
  _hits.set(ip, list);
  if (_hits.size > 5000) { for (const [k, v] of _hits) { if (!v.some(t => now - t < 10 * 60 * 1000)) _hits.delete(k); } }
  _all = _all.filter(t => now - t < 60 * 60 * 1000); _all.push(now);
  return list.length > 5 || _all.length > 120;   // per visitor, plus a site-wide hourly ceiling
}
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max); }
function isEmail(s) { return /^[^\s@,;()"<>]+@[^\s@,;()"'<>]+\.[^\s@,;()"'<>]{2,}$/.test(String(s || '').trim()); }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

const KINDS = ['performance', 'contact'];

async function nextId() {
  const { data } = await supabase.from('enquiries').select('id').like('id', 'EQ-%').order('created_at', { ascending: false }).limit(1);
  const last = data && data[0] ? parseInt(String(data[0].id).replace('EQ-', ''), 10) : 0;
  return 'EQ-' + String((isNaN(last) ? 0 : last) + 1).padStart(3, '0');
}

async function sendMail({ to, subject, html, text, replyTo }) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Arpit Pandey <' + FROM_EMAIL + '>', to: [to], subject, html, text, reply_to: replyTo || ARPIT_EMAIL })
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return { ok: false, error: j.message || ('HTTP ' + r.status) }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
function shell(inner) {
  return `<div style="background:#F5EEE5;padding:28px 16px;font-family:Helvetica,Arial,sans-serif;color:#4F3B3C;">
  <div style="max-width:560px;margin:0 auto;background:#FFFDFA;border-radius:16px;padding:28px 24px;">${inner}
  <p style="margin:28px 0 0;font-size:13px;color:#6B5150;">Arpit Pandey · Handpan artist and teacher<br><a href="https://arpitpandey.com" style="color:#500018;">arpitpandey.com</a></p></div></div>`;
}

async function handler(req, res) {
  try {
    const b = req.body || {};
    if (clean(b.website, 200)) return res.json({ ok: true });            // honeypot: pretend it worked
    // Railway's proxy appends the real client address last, so the last entry can't be faked by the visitor.
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',').pop().trim();
    if (rateLimited(ip)) return res.status(429).json({ error: 'Too many messages in a short time. Please try again in a few minutes, or email arpithandpan@gmail.com.' });

    const kind = KINDS.includes(b.kind) ? b.kind : 'contact';
    const row = {
      kind,
      full_name: clean(b.name, 80),
      email: clean(b.email, 120).toLowerCase(),
      phone: clean(b.phone, 24) || null,
      event_type: clean(b.eventType, 60) || null,
      event_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.eventDate || '')) ? b.eventDate : null,
      city: clean(b.city, 80) || null,
      venue: clean(b.venue, 120) || null,
      audience: clean(b.audience, 40) || null,
      duration: clean(b.duration, 40) || null,
      budget: clean(b.budget, 40) || null,
      message: String(b.message == null ? '' : b.message).replace(/[<>]/g, ' ').trim().slice(0, 3000) || null,
      source: clean(b.source, 80) || null,
      page: clean(b.page, 160) || null,
      status: 'new'
    };
    const errors = {};
    if (row.full_name.length < 2) errors.name = 'Please enter your name.';
    if (!isEmail(row.email)) errors.email = 'Please enter a valid email address.';
    if (row.phone && row.phone.replace(/\D/g, '').length < 7) errors.phone = 'Please check the phone number.';
    if (kind === 'performance' && !row.event_type) errors.eventType = 'Please choose the type of event.';
    if (kind === 'contact' && (!row.message || row.message.length < 5)) errors.message = 'Please write a short message.';
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Please check the highlighted fields.', fields: errors });

    let id = await nextId(), saved = false, lastErr = null;
    for (let i = 0; i < 3 && !saved; i++) {
      const { error } = await supabase.from('enquiries').insert(Object.assign({ id }, row));
      if (!error) { saved = true; break; }
      lastErr = error;
      if (error.code === '23505') { id = 'EQ-' + Date.now().toString(36).toUpperCase(); continue; }
      break;
    }
    if (!saved) {
      console.error('enquiry insert failed:', lastErr && lastErr.message);
      return res.status(500).json({ error: 'We could not save your message just now. Please email arpithandpan@gmail.com or message on WhatsApp.' });
    }

    const first = row.full_name.split(' ')[0];
    const what = kind === 'performance' ? 'performance enquiry' : 'message';
    const summary = kind === 'performance'
      ? [row.event_type, row.event_date, [row.city, row.venue].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
      : (row.message || '').slice(0, 80);
    await supabase.from('notifications').insert({
      type: 'info',
      message: `✉️ New ${what} from ${row.full_name}${summary ? ': ' + summary : ''} · reply to ${row.email}${row.phone ? ' / ' + row.phone : ''} (${id})`,
      read: false
    }).then(() => {}, () => {});

    const lines = [
      ['Name', row.full_name], ['Email', row.email], ['Phone', row.phone], ['Event', row.event_type], ['Date', row.event_date],
      ['City', row.city], ['Venue', row.venue], ['Audience', row.audience], ['Duration', row.duration], ['Budget', row.budget],
      ['Found via', row.source], ['Page', row.page]
    ].filter(([, v]) => v);
    const table = lines.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6B5150;vertical-align:top;">${k}</td><td style="padding:6px 0;color:#2A1418;"><b>${esc(v)}</b></td></tr>`).join('');
    const msgHtml = row.message ? `<p style="margin:18px 0 6px;color:#6B5150;">Message</p><p style="margin:0;white-space:pre-wrap;color:#2A1418;">${esc(row.message)}</p>` : '';
    sendMail({
      to: ARPIT_EMAIL,
      replyTo: row.email,
      subject: (kind === 'performance' ? 'Performance enquiry: ' : 'Website message: ') + row.full_name + (row.event_date ? ' · ' + row.event_date : ''),
      html: shell(`<h2 style="margin:0 0 14px;font-family:Georgia,serif;color:#500018;">New ${what} (${id})</h2><table style="border-collapse:collapse;font-size:15px;">${table}</table>${msgHtml}<p style="margin:20px 0 0;font-size:14px;">Reply to this email to answer ${esc(first)} directly.</p>`),
      text: `New ${what} (${id})\n` + lines.map(([k, v]) => k + ': ' + v).join('\n') + (row.message ? '\n\n' + row.message : '')
    }).then(r => { if (!r.ok) console.warn('enquiry mail to Arpit failed:', r.error); });
    return res.json({ ok: true, id });
  } catch (e) {
    console.error('enquiry error:', e);
    return res.status(500).json({ error: 'Something went wrong on our side. Please email arpithandpan@gmail.com.' });
  }
}

module.exports = { init, handler, _test: { clean, isEmail, rateLimited } };
