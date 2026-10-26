// ── WHATSAPP AGENT (draft mode) ──
// When someone messages the studio number, this drafts a reply with Claude
// and saves it in wa_drafts. Arpit sees the draft in the dashboard chat and
// sends it as is, edits it, or throws it away. In 'auto' mode safe replies
// go out by themselves, and when Arpit must decide, a short holding reply
// ("let me check and get back to you") goes out while the real draft waits.
//
// Flow:
//   1. whatsapp-service.js logs the incoming message and calls onIncoming().
//   2. We wait DEBOUNCE_MS, because people often send 2–3 messages in a row.
//   3. draftFor(phone) reads the chat, the person's classes/fees/trial and
//      the business facts (agent-knowledge.js), asks Claude, saves the draft.
//   4. A sweep every 10 minutes catches anything missed (e.g. a restart
//      during the wait).
//
// Settings (dashboard → More → WhatsApp agent, app_settings row 'agent'):
//   on, mode ('draft' | 'auto'), when {weekend, night, blocked, inclass, always},
//   night [fromMin, toMin] IST, wait_min, pause_min (after Arpit replies by
//   hand, that chat gets drafts only for this long), notes (extra facts).
//   In 'auto' mode a SAFE draft is sent by itself after wait_min, but only at
//   the times picked in 'when'. Anything else stays a draft, as before.
//
// Env:
//   ANTHROPIC_API_KEY   – Claude API key (required; without it the agent is off)
//   AGENT_MODE          – 'draft' (default) or 'off'
//   AGENT_MODEL         – default 'claude-sonnet-5-5'
//   AGENT_DAILY_MAX     – drafts per day for the whole studio (default 150)

const { KNOWLEDGE, RULES } = require('./agent-knowledge');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = (process.env.AGENT_MODEL || 'claude-sonnet-5-5').trim();
const DEBOUNCE_MS = 40 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const PER_PHONE_DAILY_MAX = 15;
const DAILY_MAX = Number(process.env.AGENT_DAILY_MAX) || 150;
const SITE = 'https://arpitpandey.com';
// $ per million tokens (Sonnet 5.5). Only used for the cost column.
const PRICE_IN = 2, PRICE_OUT = 10, PRICE_CACHE_READ = 0.10, PRICE_CACHE_WRITE = 2.5;

const CATEGORIES = ['trial', 'fees', 'payment', 'schedule', 'reschedule', 'zoom_link', 'workshop', 'performance', 'teaching', 'handpan_buying', 'greeting', 'general', 'complaint', 'other'];

let supabase = null, whatsapp = null, studentPortal = null, trialBooking = null, onDraftHook = null, liveZoom = null;
const timers = {};          // phone → debounce timer
const running = new Set();  // phones being drafted right now
let sweepTimer = null;

function init(client, deps) {
  supabase = client;
  whatsapp = deps.whatsapp;
  studentPortal = deps.studentPortal;
  trialBooking = deps.trialBooking;
  onDraftHook = deps.onDraft || null;
  liveZoom = deps.liveZoom || null;
  loadSettings().catch(() => {});
}

// ── SETTINGS ──
const SET_DEFAULTS = {
  on: true, mode: 'draft',
  when: { weekend: true, night: true, blocked: true, inclass: true, always: false },
  night: [23 * 60, 8 * 60], wait_min: 5, pause_min: 60, notes: ''
};
// Kinds of question the agent may answer on its own. Money problems, changes,
// complaints, teaching and anything 'other' always wait for Arpit.
const SAFE_CATS = ['trial', 'fees', 'schedule', 'zoom_link', 'workshop', 'greeting', 'general'];
// Holding replies ("let me check and get back to you") may go out by themselves
// only if they say nothing that could be a promise.
const HOLD_BLOCK = /[0-9₹$€£%]|https?:|www\.|@|\b(yes|yeah|yep|sure|confirm(ed)?|done|booked|scheduled|available|free|discount|refund|price|cost|fee|fees|paid|payment|cancel(led)?|moved?|reschedul\w*|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|haan|ho jayega|pakka|no problem|of course|definitely|will do|i'll send|i will send|sending)\b/i;
const HOLD_NO_CATS = ['complaint'];
function holdingOk(out) {
  const t = String(out && out.holding_reply || '').trim();
  if (!t || t.length > 200 || t.split(/\n/).length > 2) return '';
  if (HOLD_NO_CATS.includes(String(out.category).toLowerCase())) return '';
  if (HOLD_BLOCK.test(t)) return '';
  return t;
}
let SET = JSON.parse(JSON.stringify(SET_DEFAULTS)), _setAt = 0;
function cleanSettings(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const s = JSON.parse(JSON.stringify(SET_DEFAULTS));
  if (typeof raw.on === 'boolean') s.on = raw.on;
  if (raw.mode === 'auto' || raw.mode === 'draft') s.mode = raw.mode;
  if (raw.when && typeof raw.when === 'object') for (const k of Object.keys(s.when)) if (typeof raw.when[k] === 'boolean') s.when[k] = raw.when[k];
  if (Array.isArray(raw.night) && raw.night.length === 2) {
    const a = Number(raw.night[0]), b = Number(raw.night[1]);
    if ([a, b].every(n => Number.isInteger(n) && n >= 0 && n < 1440) && a !== b) s.night = [a, b];
  }
  const w = Number(raw.wait_min);
  if (Number.isInteger(w) && w >= 1 && w <= 60) s.wait_min = w;
  const pm = Number(raw.pause_min);
  if (Number.isInteger(pm) && pm >= 0 && pm <= 480) s.pause_min = pm;
  if (typeof raw.notes === 'string') s.notes = raw.notes.replace(/\r\n/g, '\n').slice(0, 4000);
  return s;
}
async function loadSettings(force) {
  if (!supabase) return SET;
  if (!force && Date.now() - _setAt < 60 * 1000) return SET;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'agent').maybeSingle();
    SET = cleanSettings(data && data.value);
    _setAt = Date.now();
  } catch (e) { console.error('agent settings read failed:', e.message); }
  return SET;
}

function keyOk() {
  const mode = String(process.env.AGENT_MODE || 'draft').trim().toLowerCase();
  return mode !== 'off' && !!String(process.env.ANTHROPIC_API_KEY || '').trim();
}
function enabled() { return keyOk() && SET.on; }
function status() { return { enabled: enabled(), mode: enabled() ? SET.mode : 'off', model: MODEL }; }

// Is now one of the times Arpit picked for auto-send?
async function autoWindow(now) {
  const w = SET.when;
  if (w.always) return 'always';
  const ist = require('./studio-time').shifted(now);   // Arpit's own clock (India unless he moved)
  const day = ist.getUTCDay(), min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (w.weekend && (day === 0 || day === 6)) return 'weekend';
  if (w.night) {
    const [a, b] = SET.night;
    if (a > b ? (min >= a || min < b) : (min >= a && min < b)) return 'night';
  }
  if (w.inclass && liveZoom) {
    try { if ((liveZoom() || []).some(m => m.hostIn && !m.endedAt)) return 'inclass'; } catch (e) {}
  }
  if (w.blocked) {
    try {
      const iso = new Date(now).toISOString();
      const { data } = await supabase.from('blocks').select('id').is('removed_at', null).lte('start_at', iso).gt('end_at', iso).limit(1);
      if (data && data.length) return 'blocked';
    } catch (e) {}
  }
  return null;
}
// The draft itself must be a plain, sure, info-only answer.
// firstContact: nothing sent by hand or by the agent in this chat yet. Only
// then may a performance enquiry get its first "please share the details" reply.
function isSafe(out, firstContact) {
  const cat = String(out && out.category).toLowerCase();
  const catOk = SAFE_CATS.includes(cat) || (cat === 'performance' && firstContact);
  const conf = String(out && out.confidence).toLowerCase();
  return !!(out && out.needs_reply && String(out.reply || '').trim() && !out.needs_arpit && out.safe_to_autosend &&
    (conf === 'high' || conf === 'medium') && catOk);
}

// ── TIME HELPERS ──
function fmt(ms, tz, withDay) {
  const o = { timeZone: tz || 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true };
  if (withDay !== false) Object.assign(o, { weekday: 'short', day: 'numeric', month: 'short' });
  return new Intl.DateTimeFormat('en-GB', o).format(new Date(ms)).replace(/\s?(am|pm)$/i, m => ' ' + m.trim().toUpperCase());
}
function istYmd(ms) { return new Date(ms + 330 * 60000).toISOString().slice(0, 10); }
function last10(s) { return String(s || '').replace(/\D/g, '').slice(-10); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

// ── WHO IS THIS? ──
async function findStudent(phone) {
  const k = last10(phone);
  if (!k) return null;
  const { data } = await supabase.from('students').select('*');
  const match = (s) => [s.phone].concat(Array.isArray(s.extra_phones) ? s.extra_phones : []).some(p => p && last10(p) === k);
  return (data || []).find(s => !s.archived && match(s)) || null;
}
async function findTrial(phone) {
  const k = last10(phone);
  if (!k) return null;
  const { data } = await supabase.from('trials').select('*').ilike('phone', '%' + k).order('created_at', { ascending: false }).limit(1);
  return (data || [])[0] || null;
}
async function findWorkshopBookings(phone) {
  const k = last10(phone);
  if (!k) return [];
  const { data } = await supabase.from('participants').select('id, full_name, workshop_id, participant_count, observer_count, bringing_own_handpan, archived').ilike('phone', '%' + k);
  const rows = (data || []).filter(r => !r.archived);
  if (!rows.length) return [];
  const { data: wss } = await supabase.from('workshops').select('*').in('id', [...new Set(rows.map(r => r.workshop_id))]);
  return rows.map(r => ({ row: r, ws: (wss || []).find(w => w.id === r.workshop_id) || null }));
}

// ── LIVE DATA FOR ONE CHAT ──
async function liveData(phone, contactName) {
  const now = Date.now();
  const lines = [];
  lines.push('Now: ' + fmt(now) + ' IST.');
  let kind = 'unknown', name = contactName || '';

  const student = await findStudent(phone).catch(() => null);
  if (student) {
    kind = 'student'; name = student.full_name;
    lines.push(`This person is an existing STUDENT: ${student.full_name}${student.status && student.status !== 'Active' ? ' (status: ' + student.status + ')' : ''}.`);
    try {
      const ctx = await studentPortal._test.loadStudent(student.id);
      if (ctx) {
        const tz = ctx.tz || 'Asia/Kolkata';
        if (tz !== 'Asia/Kolkata') lines.push(`Their time zone: ${tz}.`);
        const list = studentPortal._test.buildClasses(ctx, now, now + 21 * 86400000).slice(0, 4);
        if (list.length) {
          lines.push('Their next classes: ' + list.map(o => fmt(o.start) + ' IST' + (tz !== 'Asia/Kolkata' ? ' (' + fmt(o.start, tz) + ' their time)' : '') + (o.moved ? ' [moved]' : o.makeup ? ' [make-up]' : '')).join('; ') + '.');
        } else lines.push('They have no classes scheduled in the next 3 weeks.');
        if (ctx.zoom) lines.push('Their Zoom link (same every week): ' + ctx.zoom);
        lines.push(`Paid classes left: ${ctx.left}.`);
        if (ctx.pending) {
          const cur = (ctx.pending.currency || 'INR').toUpperCase();
          const amt = cur === 'INR' ? '₹' + Number(ctx.pending.amount).toLocaleString('en-IN') : (cur === 'USD' ? '$' : cur + ' ') + Number(ctx.pending.amount);
          lines.push(`They have an UNPAID fee link: ${amt} for ${ctx.pending.classes} classes. Pay here: ${SITE}/pages/pay?r=${encodeURIComponent(ctx.pending.id)}`);
        } else lines.push('No unpaid fee link right now.');
        const link = await studentPortal.linkForStudent(student.id, false).catch(() => null);
        if (link && link.url) lines.push('Their personal My bookings link (to see, move or skip classes): ' + link.url);
      }
    } catch (e) { console.error('agent student context error:', e.message); }
  }

  if (!student) {
    const trial = await findTrial(phone).catch(() => null);
    if (trial) {
      kind = 'trial'; name = trial.full_name || name;
      const when = trial.start_at ? fmt(new Date(trial.start_at).getTime()) + ' IST' + (trial.tz && trial.tz !== 'Asia/Kolkata' ? ' (' + fmt(new Date(trial.start_at).getTime(), trial.tz) + ' their time)' : '') : 'no time set';
      lines.push(`This person booked a FREE TRIAL: ${trial.full_name}, ${when}, status: ${trial.status}.` +
        ({ yes: ' They have a handpan.', not_yet: ' They said they do NOT have a handpan yet.', planning: ' They are planning to buy a handpan.' }[trial.has_handpan] || '') +
        (trial.join_url && trial.status === 'booked' ? ' Trial Zoom link: ' + trial.join_url : ''));
    }
  }

  const ws = await findWorkshopBookings(phone).catch(() => []);
  const today = istYmd(now);
  const upcomingBooked = ws.filter(x => x.ws && String(x.ws.date).slice(0, 10) >= today && !x.ws.cancelled);
  if (upcomingBooked.length) {
    if (kind === 'unknown') { kind = 'workshop'; name = upcomingBooked[0].row.full_name || name; }
    for (const x of upcomingBooked) {
      lines.push(`They are BOOKED for a workshop: ${x.ws.title || 'Handpan workshop'} on ${String(x.ws.date).slice(0, 10)}${x.ws.workshop_time ? ', ' + x.ws.workshop_time : ''}${x.ws.venue ? ', ' + x.ws.venue : ''}. Participants: ${x.row.participant_count || 1}${x.row.observer_count ? ', audience: ' + x.row.observer_count : ''}.`);
    }
  } else if (ws.length && kind === 'unknown') {
    kind = 'workshop'; name = ws[0].row.full_name || name;
    lines.push('They attended a past workshop.');
  }

  // Weekly classes request in progress (self-enrolment).
  try {
    const k = last10(phone);
    const { data: er } = await supabase.from('enrol_requests').select('status, plan, slot_weekday, slot_time, pay_by').ilike('phone', '%' + k).in('status', ['invited', 'requested', 'offered', 'approved']).order('created_at', { ascending: false }).limit(1);
    const r = (er || [])[0];
    if (r) {
      const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const t = r.slot_weekday != null ? D[r.slot_weekday] + ' ' + (h => ((h[0] % 12) || 12) + ':' + String(h[1]).padStart(2, '0') + (h[0] < 12 ? ' AM' : ' PM'))(String(r.slot_time || '00:00').split(':').map(Number)) + ' IST' : '';
      lines.push('Weekly classes request: ' + ({ invited: 'they have the link but have not picked a time yet', requested: 'they asked for ' + t + ' (' + r.plan + '), waiting for Arpit to confirm', offered: 'Arpit offered ' + t + ', waiting for them to accept', approved: 'confirmed for ' + t + ', waiting for their payment' + (r.pay_by ? ' (held until ' + fmt(new Date(r.pay_by).getTime()) + ' IST)' : '') })[r.status] + '. Their personal link is in their email.');
      if (kind === 'unknown') kind = 'enrolling';
    }
  } catch (e) {}
  // Time Arpit blocked (leave, travel): never offer or promise these.
  try {
    const { data: bl } = await supabase.from('blocks').select('start_at, end_at, all_day').is('removed_at', null).gte('end_at', new Date(now).toISOString()).lte('start_at', new Date(now + 30 * 86400000).toISOString());
    if (bl && bl.length) lines.push('Arpit is AWAY (no classes, trials or calls): ' + bl.map(b => b.all_day ? fmt(new Date(b.start_at).getTime(), 'Asia/Kolkata', true).split(',')[0] + (new Date(b.end_at) - new Date(b.start_at) > 86400000 ? ' to ' + fmt(new Date(b.end_at).getTime() - 1, 'Asia/Kolkata', true).split(',')[0] : '') : fmt(new Date(b.start_at).getTime()) + ' to ' + fmt(new Date(b.end_at).getTime(), 'Asia/Kolkata', false) + ' IST').join('; ') + '.');
  } catch (e) {}

  if (kind === 'unknown') lines.push(`This person is NEW (not a student, no trial booked)${name ? '. WhatsApp name: ' + name : ''}.`);

  // Upcoming workshops for everyone.
  try {
    const { data: wss } = await supabase.from('workshops').select('*').gte('date', today).order('date', { ascending: true }).limit(6);
    const open = (wss || []).filter(w => !w.archived && !w.cancelled);
    lines.push(open.length
      ? 'Upcoming workshops: ' + open.map(w => `${String(w.date).slice(0, 10)}${w.workshop_time ? ' ' + w.workshop_time : ''}${w.venue ? ' at ' + w.venue : ''}${w.booking_open === false ? ' (booking not open yet)' : ' (book at ' + SITE + '/pages/book?ws=' + encodeURIComponent(w.id) + ')'}`).join('; ') + '.'
      : 'Upcoming workshops: none scheduled right now.');
  } catch (e) {}

  // A few free trial times for new people and trial leads.
  if (kind !== 'student' && trialBooking) {
    try {
      const { slots } = await trialBooking.freeSlots();
      const next = (slots || []).slice(0, 6);
      if (next.length) lines.push('Next free trial times (only mention if useful, booking is on the trial page): ' + next.map(ms => fmt(ms) + ' IST').join('; ') + '.');
    } catch (e) {}
  }
  return { kind, name, text: lines.join('\n') };
}

// ── CHAT HISTORY ──
const TPL_LABEL = {
  class_reminder: 'Class reminder', class_reminder_v2: 'Class reminder', class_reminder_v3: 'Class reminder',
  fee_link: 'Fee link', payment_reminder: 'Payment reminder', fee_receipt: 'Fee receipt',
  trial_confirmation: 'Trial confirmation', trial_reminder: 'Trial reminder', arpit_replied: 'Arpit replied',
  class_changed: 'Class changed', my_classes_link: 'My bookings link',
  workshop_confirmation: 'Workshop confirmation', workshop_confirmation_v2: 'Workshop confirmation'
};
function describe(r) {
  if (r.type === 'reaction') return r.emoji ? `[reacted ${r.emoji}]` : '[removed a reaction]';
  const media = { image: 'photo', audio: 'voice note', video: 'video', document: 'document', sticker: 'sticker', location: 'location' }[r.type];
  let body = r.body || '';
  if (media) body = `[${media}]` + (body && !/^\[/.test(body) ? ' ' + body : '');
  return body || `[${r.type}]`;
}
function historyText(rows, name) {
  return rows.map(r => {
    const when = fmt(new Date(r.created_at).getTime());
    let who;
    if (r.direction === 'in') who = firstName(name) || 'Them';
    else if (r.template) who = 'Auto message (' + (TPL_LABEL[r.template] || r.template) + ')';
    else who = 'Arpit';
    return `[${when}] ${who}: ${describe(r)}`;
  }).join('\n');
}

// ── CLAUDE ──
const SCHEMA = {
  type: 'object',
  properties: {
    needs_reply: { type: 'boolean', description: 'false when nothing needs saying (thanks, ok, emoji, a "See you there" tap).' },
    reply: { type: 'string', description: 'The WhatsApp message to send, written as Arpit. Empty when needs_reply is false.' },
    category: { type: 'string', enum: CATEGORIES, description: 'teaching = only teaching material or feedback on playing. general = what a handpan is, about Arpit, his music, other harmless facts. Questions about classes are schedule, fees or trial.' },
    needs_arpit: { type: 'boolean', description: 'true when Arpit must decide or act himself (see ALWAYS ARPIT\'S CALL).' },
    note_for_arpit: { type: 'string', description: 'One short line for Arpit: what they want and anything he must do. Empty if nothing.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    holding_reply: { type: 'string', description: 'Only when needs_arpit is true: a very short acknowledgement that can go out right away while Arpit decides ("Thanks! Let me check this and get back to you shortly."). No answer, promise, price, number, date, link. Empty for complaints, upset or personal messages, and when needs_arpit is false.' },
    safe_to_autosend: { type: 'boolean', description: 'true ONLY when the reply just gives facts fully covered by KNOWLEDGE or LIVE DATA (fees, timings, trial link, how classes work, their own next class or Zoom link, workshop dates, what a handpan is, about Arpit), or is the first reply to a performance enquiry that only asks for the event details; makes no promise, price or change; and would be fine to send without Arpit reading it first. false for anything else.' }
  },
  required: ['needs_reply', 'reply', 'category', 'needs_arpit', 'note_for_arpit', 'confidence', 'holding_reply', 'safe_to_autosend'],
  additionalProperties: false
};

async function callClaude(live, history) {
  const body = {
    model: MODEL,
    max_tokens: 3000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: [
      { type: 'text', text: RULES + '\n\nKNOWLEDGE\n' + KNOWLEDGE + (SET.notes.trim() ? '\n\nLATEST NOTES FROM ARPIT (newer than the facts above; if they disagree, these win)\n' + SET.notes.trim() : ''), cache_control: { type: 'ephemeral' } }
    ],
    messages: [{
      role: 'user',
      content: 'LIVE DATA for this chat:\n' + live.text +
        '\n\nCONVERSATION (oldest first; reply to the latest message(s) from them):\n' + history +
        '\n\nDraft Arpit\'s next WhatsApp reply.'
    }]
  };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY.trim(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || ('Claude HTTP ' + res.status));
  if (j.stop_reason === 'refusal') throw new Error('Claude declined to draft this one');
  const textBlock = (j.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text (stop: ' + j.stop_reason + ')');
  let out;
  try { out = JSON.parse(textBlock.text); } catch (e) { throw new Error('Could not read Claude\'s answer'); }
  const u = j.usage || {};
  const cost = ((u.input_tokens || 0) * PRICE_IN + (u.output_tokens || 0) * PRICE_OUT +
    (u.cache_read_input_tokens || 0) * PRICE_CACHE_READ + (u.cache_creation_input_tokens || 0) * PRICE_CACHE_WRITE) / 1e6;
  return { out, usage: u, cost };
}

// ── DRAFT ONE CHAT ──
async function countToday(phone) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let q = supabase.from('wa_drafts').select('id', { count: 'exact', head: true }).gte('created_at', since);
  if (phone) q = q.eq('phone', phone);
  const { count } = await q;
  return count || 0;
}

// force: redo even if a draft for the latest message already exists.
async function draftFor(phone, opts) {
  opts = opts || {};
  phone = String(phone || '').replace(/\D/g, '');
  if (!phone || !enabled()) return { ok: false, error: 'Agent is off' };
  if (running.has(phone)) return { ok: false, error: 'Already drafting' };
  running.add(phone);
  try {
    const { data: rowsDesc, error } = await supabase.from('wa_messages').select('*').eq('phone', phone)
      .order('created_at', { ascending: false }).limit(30);
    if (error) throw new Error(error.message);
    const rows = (rowsDesc || []).slice().reverse();
    const ins = rows.filter(r => r.direction === 'in' && r.type !== 'reaction');
    const lastIn = ins[ins.length - 1];
    if (!lastIn) return { ok: false, error: 'No message from them' };
    const lastInMs = new Date(lastIn.created_at).getTime();
    if (Date.now() - lastInMs > WINDOW_MS) return { ok: false, error: 'Chat window is closed' };
    // Arpit already answered by hand after their last message.
    const answered = rows.some(r => r.direction === 'out' && !r.template && new Date(r.created_at).getTime() > lastInMs);
    if (answered && !opts.force) return { ok: false, error: 'Already answered' };
    if (!opts.force) {
      const { data: have } = await supabase.from('wa_drafts').select('id').eq('phone', phone).eq('in_wa_id', lastIn.wa_id).limit(1);
      if (have && have.length) return { ok: false, error: 'Draft already made' };
    }
    if (await countToday(phone) >= PER_PHONE_DAILY_MAX) return { ok: false, error: 'Daily limit for this chat reached' };
    if (await countToday(null) >= DAILY_MAX) return { ok: false, error: 'Daily draft limit reached' };

    await loadSettings();
    const contactName = (rows.slice().reverse().find(r => r.contact_name) || {}).contact_name || '';
    const live = await liveData(phone, contactName);
    const { out, usage, cost } = await callClaude(live, historyText(rows.slice(-20), live.name));

    // Anything still pending for this chat is now out of date.
    await supabase.from('wa_drafts').update({ status: 'superseded', decided_at: new Date().toISOString() }).eq('phone', phone).eq('status', 'pending');
    const reply = String(out.reply || '').trim();
    const row = {
      phone, in_wa_id: lastIn.wa_id || null,
      status: out.needs_reply && reply ? 'pending' : 'no_reply',
      body: reply || null,
      category: CATEGORIES.includes(String(out.category).toLowerCase()) ? String(out.category).toLowerCase() : 'other',
      needs_arpit: !!out.needs_arpit,
      note: String(out.note_for_arpit || '').trim() || null,
      confidence: ['high', 'medium', 'low'].includes(String(out.confidence).toLowerCase()) ? String(out.confidence).toLowerCase() : null,
      person_kind: live.kind,
      model: MODEL,
      tokens_in: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      tokens_out: usage.output_tokens || 0,
      cost_usd: Math.round(cost * 1e6) / 1e6
    };
    // Auto-send: a safe draft at one of the picked times goes out after wait_min,
    // unless Arpit sends, edits or throws it away first.
    const firstContact = !rows.some(r => r.direction === 'out' && !r.template && r.type !== 'reaction');
    // Arpit is talking to them himself: drafts only for pause_min after his last reply.
    const lastMine = rows.filter(r => r.direction === 'out' && !r.template && r.type !== 'reaction' && !(r.params && r.params.auto)).pop();
    const paused = lastMine && SET.pause_min > 0 && Date.now() - new Date(lastMine.created_at).getTime() < SET.pause_min * 60000;
    const canAuto = row.status === 'pending' && SET.mode === 'auto' && !opts.force && !paused && await autoWindow(Date.now());
    if (canAuto && isSafe(out, firstContact)) row.auto_at = new Date(Date.now() + SET.wait_min * 60000).toISOString();
    // Arpit must decide: a short holding reply goes out by itself, the real draft waits for him.
    // Saved first, so the dashboard (newest pending per chat) keeps showing the real draft.
    const hold = canAuto && !row.auto_at && row.needs_arpit ? holdingOk(out) : '';
    if (hold) {
      const { error: hErr } = await supabase.from('wa_drafts').insert(Object.assign({}, row, {
        body: hold, needs_arpit: false, note: 'Holding reply, sent while you decide', confidence: 'high',
        tokens_in: 0, tokens_out: 0, cost_usd: 0, auto_at: new Date(Date.now() + SET.wait_min * 60000).toISOString()
      }));
      if (hErr) console.error('Agent holding reply not saved:', hErr.message);
      else row.note = (row.note ? row.note + ' ' : '') + '(A short "let me check" reply goes out by itself.)';
    }
    const { data: saved, error: insErr } = await supabase.from('wa_drafts').insert(row).select().single();
    if (insErr) throw new Error('wa_drafts: ' + insErr.message);
    console.log(`Agent draft (${row.status}, ${row.category}${row.needs_arpit ? ', needs Arpit' : ''}${row.auto_at ? ', auto' : ''}${hold ? ', holding reply' : ''}) → ${phone} · $${row.cost_usd}`);
    if (onDraftHook && saved && !opts.force) { try { onDraftHook(saved, live.name); } catch (e) {} }
    return { ok: true, draft: saved };
  } catch (e) {
    console.error('Agent draft error (' + phone + '):', e.message);
    return { ok: false, error: e.message };
  } finally {
    running.delete(phone);
  }
}

// Called by whatsapp-service for every new incoming message on the studio number.
function onIncoming(phone, msgType) {
  if (!enabled() || msgType === 'reaction') return;
  phone = String(phone || '').replace(/\D/g, '');
  if (!phone) return;
  clearTimeout(timers[phone]);
  timers[phone] = setTimeout(() => { delete timers[phone]; draftFor(phone); }, DEBOUNCE_MS);
}

// Arpit sent something by hand: drafts for this chat are out of date.
async function onManualReply(phone, draftId) {
  try {
    phone = String(phone || '').replace(/\D/g, '');
    const now = new Date().toISOString();
    if (draftId) await supabase.from('wa_drafts').update({ status: 'sent', edited: true, decided_at: now }).eq('id', draftId).eq('status', 'pending');
    await supabase.from('wa_drafts').update({ status: 'superseded', decided_at: now }).eq('phone', phone).eq('status', 'pending');
  } catch (e) { console.error('agent onManualReply error:', e.message); }
}

// Every 10 minutes: chats whose last message from them (in the last 6 hours)
// has no draft and no reply yet.
async function sweep() {
  if (!enabled()) return;
  try {
    const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const { data } = await supabase.from('wa_messages').select('phone, created_at, direction, type')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(500);
    const lastByPhone = {};
    for (const r of (data || [])) if (!lastByPhone[r.phone] && r.type !== 'reaction' && !r.template) lastByPhone[r.phone] = r;
    for (const phone of Object.keys(lastByPhone)) {
      const r = lastByPhone[phone];
      if (r.direction !== 'in' || timers[phone]) continue;
      if (Date.now() - new Date(r.created_at).getTime() < DEBOUNCE_MS) continue;
      await draftFor(phone);   // skips itself when a draft already exists
    }
  } catch (e) { console.error('agent sweep error:', e.message); }
}

// Every minute: send safe drafts whose wait is over.
let autoBusy = false;
async function autoSend() {
  if (autoBusy || !supabase) return;
  autoBusy = true;
  try {
    await loadSettings();
    const { data } = await supabase.from('wa_drafts').select('*').eq('status', 'pending').not('auto_at', 'is', null)
      .lte('auto_at', new Date().toISOString()).limit(10);
    for (const d of (data || [])) {
      const stop = async (why) => { await supabase.from('wa_drafts').update({ auto_at: null }).eq('id', d.id); console.log('Agent auto-send skipped (' + why + ') → ' + d.phone); };
      if (!enabled() || SET.mode !== 'auto') { await stop('auto is off'); continue; }
      // They wrote again since: a fresh draft is coming, don't send the old one.
      const { data: last } = await supabase.from('wa_messages').select('wa_id, direction, template, created_at').eq('phone', d.phone).order('created_at', { ascending: false }).limit(5);
      const lastIn = (last || []).find(r => r.direction === 'in');
      if (lastIn && d.in_wa_id && lastIn.wa_id !== d.in_wa_id) { await stop('newer message'); continue; }
      if ((last || []).some(r => r.direction === 'out' && !r.template && new Date(r.created_at) > new Date(d.created_at))) { await stop('Arpit replied'); continue; }
      // Claim it first so two runs can never send it twice.
      const { data: claimed } = await supabase.from('wa_drafts').update({ status: 'sending' }).eq('id', d.id).eq('status', 'pending').select('id');
      if (!claimed || !claimed.length) continue;
      const text = String(d.body || '').trim();
      const r = await whatsapp.sendReply(d.phone, text);
      if (!r.ok) {
        await supabase.from('wa_drafts').update({ status: 'pending', auto_at: null }).eq('id', d.id);
        console.error('Agent auto-send failed → ' + d.phone + ': ' + r.error);
        continue;
      }
      const now = new Date().toISOString();
      await supabase.from('wa_drafts').update({ status: 'sent', auto_sent: true, sent_text: text, edited: false, decided_at: now, sent_wa_id: r.row?.wa_id || null }).eq('id', d.id);
      if (r.row?.wa_id) await supabase.from('wa_messages').update({ params: { auto: true } }).eq('wa_id', r.row.wa_id);
      console.log('Agent auto-sent → ' + d.phone);
    }
  } catch (e) { console.error('agent auto-send error:', e.message); }
  finally { autoBusy = false; }
}

function startWorker() {
  if (sweepTimer) return;
  setInterval(autoSend, 60 * 1000);
  console.log('WhatsApp agent: ' + (keyOk() ? 'on, model ' + MODEL + ' (on/off and auto-send come from dashboard settings)' : 'off (no ANTHROPIC_API_KEY or AGENT_MODE=off)'));
  if (!keyOk()) return;
  setTimeout(sweep, 90 * 1000);
  sweepTimer = setInterval(sweep, 10 * 60 * 1000);
}

// ── DASHBOARD ENDPOINTS (admin only) ──
// GET /api/agent/drafts → { status, drafts: [pending drafts] }
async function listHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const { data, error } = await supabase.from('wa_drafts').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    res.json({ status: status(), drafts: data || [] });
  } catch (e) {
    res.status(500).json({ error: 'Could not load drafts: ' + e.message, status: status(), drafts: [] });
  }
}

// POST /api/agent/drafts/:id/send  { text }
async function sendHandler(req, res) {
  try {
    const id = String(req.params.id || '');
    const { data: d } = await supabase.from('wa_drafts').select('*').eq('id', id).maybeSingle();
    if (!d) return res.status(404).json({ error: 'Draft not found' });
    if (d.status !== 'pending') return res.status(409).json({ error: 'This draft was already handled' });
    const text = String(req.body?.text != null ? req.body.text : d.body || '').replace(/\r\n/g, '\n').trim();
    if (!text) return res.status(400).json({ error: 'The draft is empty' });
    const r = await whatsapp.sendReply(d.phone, text);
    if (!r.ok) return res.status(r.status || 502).json({ error: r.error });
    const now = new Date().toISOString();
    await supabase.from('wa_drafts').update({ status: 'sent', sent_text: text, edited: text !== String(d.body || '').trim(), decided_at: now, sent_wa_id: r.row?.wa_id || null }).eq('id', id);
    res.json({ ok: true, row: r.row });
  } catch (e) {
    console.error('agent send error:', e.message);
    res.status(500).json({ error: 'Could not send right now' });
  }
}

// POST /api/agent/drafts/:id/hold → don't auto-send this one, keep it as a draft
async function holdHandler(req, res) {
  try {
    await supabase.from('wa_drafts').update({ auto_at: null }).eq('id', String(req.params.id || '')).eq('status', 'pending');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not stop it' }); }
}

// POST /api/agent/drafts/:id/dismiss
async function dismissHandler(req, res) {
  try {
    await supabase.from('wa_drafts').update({ status: 'dismissed', decided_at: new Date().toISOString() }).eq('id', String(req.params.id || '')).eq('status', 'pending');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not dismiss' }); }
}

// GET /api/agent/settings → settings, status, 7-day numbers, main knowledge
async function settingsGetHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    await loadSettings(true);
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data } = await supabase.from('wa_drafts').select('status, edited, auto_sent').gte('created_at', since).limit(2000);
    const rows = (data || []).filter(r => r.status !== 'no_reply');
    const stats = {
      drafts: rows.length,
      as_is: rows.filter(r => r.status === 'sent' && !r.edited && !r.auto_sent).length,
      edited: rows.filter(r => r.status === 'sent' && r.edited).length,
      auto: rows.filter(r => r.status === 'sent' && r.auto_sent).length
    };
    res.json({ ok: true, settings: SET, status: status(), key: keyOk(), stats, knowledge: KNOWLEDGE, now_auto: SET.mode === 'auto' ? await autoWindow(Date.now()) : null });
  } catch (e) { res.status(500).json({ error: 'Could not load agent settings: ' + e.message }); }
}

// POST /api/agent/settings { …partial settings }
async function settingsSaveHandler(req, res) {
  try {
    await loadSettings(true);
    const b = req.body || {};
    const merged = Object.assign({}, SET, b, { when: Object.assign({}, SET.when, b.when || {}) });
    const clean = cleanSettings(merged);
    const { error } = await supabase.from('app_settings').upsert({ key: 'agent', value: clean }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    SET = clean; _setAt = Date.now();
    // Turning auto off stops anything still waiting.
    if (SET.mode !== 'auto' || !SET.on) await supabase.from('wa_drafts').update({ auto_at: null }).eq('status', 'pending').not('auto_at', 'is', null);
    res.json({ ok: true, settings: SET, status: status() });
  } catch (e) { res.status(500).json({ error: 'Could not save: ' + e.message }); }
}

// POST /api/agent/test { text } → what the agent would reply to a new person. Nothing is saved or sent.
async function testHandler(req, res) {
  try {
    if (!keyOk()) return res.status(409).json({ error: 'The agent has no Claude key' });
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Type a question first' });
    await loadSettings(true);
    const live = await liveData('0000000000', '');
    const hist = '[' + fmt(Date.now()) + '] Them: ' + text;
    const { out } = await callClaude(live, hist);
    res.json({ ok: true, reply: String(out.reply || '').trim(), needs_reply: !!out.needs_reply, needs_arpit: !!out.needs_arpit,
      note: String(out.note_for_arpit || '').trim(), category: out.category, safe: isSafe(out, true),
      holding: out.needs_arpit ? holdingOk(out) : '' });
  } catch (e) { res.status(500).json({ error: 'Test failed: ' + e.message }); }
}

// POST /api/agent/redraft { phone } → a fresh draft now
async function redraftHandler(req, res) {
  const r = await draftFor(req.body?.phone, { force: true });
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.json({ ok: true, draft: r.draft });
}

module.exports = { init, status, startWorker, onIncoming, onManualReply, draftFor, listHandler, sendHandler, dismissHandler, redraftHandler, holdHandler,
  settingsGetHandler, settingsSaveHandler, testHandler, _test: { liveData, historyText, callClaude, SCHEMA, cleanSettings, autoWindow, isSafe, autoSend, setSettings: (s) => { SET = cleanSettings(s); _setAt = Date.now(); } } };
