// notify-mailer.js
// Emails dashboard notifications to Arpit. Runs inside the Railway server.
//
// How it works: every part of the system already writes its notifications
// into the `notifications` table. This worker checks that table every
// 2 minutes and emails anything new, then marks it emailed. One place,
// catches everything — nothing else in the codebase needed changing.
//
// Channels are decided by category (see channelFor). Today only email is
// wired up; when WhatsApp is added later it plugs into the same routing.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL_TO = (process.env.NOTIFY_EMAIL_TO || 'arpithandpan@gmail.com').trim();
const NOTIFY_FROM = process.env.NOTIFY_FROM_EMAIL || 'notifications@arpitpandey.com';
const DASHBOARD_URL = 'https://arpitpandey.com/pages/dashboard';

const EVERY_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;

let supabase = null;
function init(client) { supabase = client; }

// ── ROUTING ──
// 'urgent' notifications will also go to WhatsApp once that exists.
// Everything goes to email. Routing looks at what the message is about,
// since the notifications table only stores type + message text.
function channelFor(n) {
  const msg = String(n.message || '');
  const urgent =
    n.type === 'payment'                       // money in, fee reminders
    || /payment failed/i.test(msg)             // student tried to pay, failed
    || /not linked to a student/i.test(msg);   // zoom review needed
  return { email: true, whatsapp: urgent };
}

// Subject: the message itself, trimmed. Emojis in the messages already
// say what kind of thing it is, so the inbox is scannable without opening.
function subjectFor(n) {
  let s = String(n.message || 'Dashboard notification').replace(/\s+/g, ' ').trim();
  if (s.length > 78) s = s.slice(0, 75) + '...';
  return s;
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function emailHtml(n) {
  return '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:520px;">'
    + '<p style="margin:0 0 14px;">' + esc(n.message) + '</p>'
    + '<p style="margin:0 0 18px;font-size:13px;color:#8a7a6a;">' + new Date(n.created_at || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) + ' IST</p>'
    + '<a href="' + DASHBOARD_URL + '" style="display:inline-block;background:#500018;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:14px;">Open dashboard</a>'
    + '</div>';
}

async function sendEmail(n) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Handpan Dashboard <' + NOTIFY_FROM + '>',
      to: [NOTIFY_EMAIL_TO],
      subject: subjectFor(n),
      text: String(n.message || '') + '\n\n' + DASHBOARD_URL,
      html: emailHtml(n)
    })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || data.error || ('Resend HTTP ' + res.status));
  }
}

// ── WORKER ──
let _running = false;
async function processPending() {
  if (!supabase || !RESEND_API_KEY || _running) return;
  _running = true;
  try {
    const { data, error } = await supabase.from('notifications')
      .select('id, type, message, created_at, email_attempts')
      .eq('emailed', false)
      .order('created_at', { ascending: true })
      .limit(15);
    if (error) { console.error('notify-mailer query error:', error.message); return; }

    for (const n of data || []) {
      try {
        await sendEmail(n);
        await supabase.from('notifications').update({ emailed: true }).eq('id', n.id);
      } catch (e) {
        const attempts = (Number(n.email_attempts) || 0) + 1;
        const giveUp = attempts >= MAX_ATTEMPTS;
        console.error('notify email failed (attempt ' + attempts + '):', e.message);
        // After MAX_ATTEMPTS we stop trying so one bad row can never block
        // the queue. The notification itself is still on the dashboard.
        await supabase.from('notifications')
          .update({ email_attempts: attempts, ...(giveUp ? { emailed: true } : {}) })
          .eq('id', n.id);
      }
    }
  } catch (e) {
    console.error('notify-mailer error:', e.message);
  } finally { _running = false; }
}

function startWorker() {
  if (!RESEND_API_KEY) { console.log('Notify mailer idle: RESEND_API_KEY not set'); return; }
  console.log('Notify mailer on: every 2 min → ' + NOTIFY_EMAIL_TO);
  setTimeout(processPending, 20 * 1000);
  setInterval(processPending, EVERY_MS);
}

module.exports = { init, startWorker, processPending, _test: { channelFor, subjectFor } };
