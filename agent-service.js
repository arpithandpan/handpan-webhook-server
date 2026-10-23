// ── WHATSAPP AGENT (draft mode) ──
// When someone messages the studio number, this drafts a reply with Claude
// and saves it in wa_drafts. Arpit sees the draft in the dashboard chat and
// sends it as is, edits it, or throws it away. Nothing is sent on its own.
//
// Flow:
//   1. whatsapp-service.js logs the incoming message and calls onIncoming().
//   2. We wait DEBOUNCE_MS, because people often send 2–3 messages in a row.
//   3. draftFor(phone) reads the chat, the person's classes/fees/trial and
//      the business facts (agent-knowledge.js), asks Claude, saves the draft.
//   4. A sweep every 10 minutes catches anything missed (e.g. a restart
//      during the wait).
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

const CATEGORIES = ['trial', 'fees', 'payment', 'schedule', 'reschedule', 'zoom_link', 'workshop', 'performance', 'teaching', 'handpan_buying', 'greeting', 'complaint', 'other'];

let supabase = null, whatsapp = null, studentPortal = null, trialBooking = null, onDraftHook = null;
const timers = {};          // phone → debounce timer
const running = new Set();  // phones being drafted right now
let sweepTimer = null;

function init(client, deps) {
  supabase = client;
  whatsapp = deps.whatsapp;
  studentPortal = deps.studentPortal;
  trialBooking = deps.trialBooking;
  onDraftHook = deps.onDraft || null;
}

function enabled() {
  const mode = String(process.env.AGENT_MODE || 'draft').trim().toLowerCase();
  return mode !== 'off' && !!String(process.env.ANTHROPIC_API_KEY || '').trim();
}
function status() { return { enabled: enabled(), mode: enabled() ? 'draft' : 'off', model: MODEL }; }

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
    category: { type: 'string', enum: CATEGORIES },
    needs_arpit: { type: 'boolean', description: 'true when Arpit must decide or act himself (see ALWAYS ARPIT\'S CALL).' },
    note_for_arpit: { type: 'string', description: 'One short line for Arpit: what they want and anything he must do. Empty if nothing.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
  },
  required: ['needs_reply', 'reply', 'category', 'needs_arpit', 'note_for_arpit', 'confidence'],
  additionalProperties: false
};

async function callClaude(live, history) {
  const body = {
    model: MODEL,
    max_tokens: 3000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: [
      { type: 'text', text: RULES + '\n\nKNOWLEDGE\n' + KNOWLEDGE, cache_control: { type: 'ephemeral' } }
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
    const { data: saved, error: insErr } = await supabase.from('wa_drafts').insert(row).select().single();
    if (insErr) throw new Error('wa_drafts: ' + insErr.message);
    console.log(`Agent draft (${row.status}, ${row.category}${row.needs_arpit ? ', needs Arpit' : ''}) → ${phone} · $${row.cost_usd}`);
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

function startWorker() {
  if (sweepTimer) return;
  console.log('WhatsApp agent: ' + (enabled() ? 'DRAFT mode, model ' + MODEL : 'off (no ANTHROPIC_API_KEY or AGENT_MODE=off)'));
  if (!enabled()) return;
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

// POST /api/agent/drafts/:id/dismiss
async function dismissHandler(req, res) {
  try {
    await supabase.from('wa_drafts').update({ status: 'dismissed', decided_at: new Date().toISOString() }).eq('id', String(req.params.id || '')).eq('status', 'pending');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not dismiss' }); }
}

// POST /api/agent/redraft { phone } → a fresh draft now
async function redraftHandler(req, res) {
  const r = await draftFor(req.body?.phone, { force: true });
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.json({ ok: true, draft: r.draft });
}

module.exports = { init, status, startWorker, onIncoming, onManualReply, draftFor, listHandler, sendHandler, dismissHandler, redraftHandler, _test: { liveData, historyText, callClaude, SCHEMA } };
