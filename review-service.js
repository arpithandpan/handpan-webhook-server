// review-service.js
// Weekly AI review of the studio. Claude reads one week of what happened and writes a
// short report for Arpit:
//   1. New questions: things students and leads asked that the studio has no answer
//      for yet (gift vouchers, weekend batches...), grouped, with how often.
//   2. Teach the agent: short "Studio facts" lines Arpit can approve with one tap.
//      Approved lines are added to the agent's notes (dashboard → WhatsApp agent).
//   3. Errors: repeating problems grouped by their likely cause, with a fix note.
//   4. The week in numbers (counted in code, not by Claude).
// Runs Sundays at 9 AM IST once there is at least a week of data, and on demand from
// System health ("Run review now"). Nothing is changed without Arpit's tap.
//
// Data Claude sees: inbound message text for the chats the agent passed to Arpit or
// where Arpit rewrote the draft, the agent's notes on them, error messages and counts.
// Phone numbers are cut to the last 4 digits before anything leaves the server.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = (process.env.REVIEW_MODEL || process.env.AGENT_MODEL || 'claude-sonnet-5-5').trim();
const RUN_DAY = 0, RUN_HHMM = '09:00';            // Sunday, IST
const MIN_DATA_DAYS = 6;

let supabase = null, deps = {};
let KNOWLEDGE = '';
try { KNOWLEDGE = require('./agent-knowledge').KNOWLEDGE || ''; } catch (e) {}
let running = false;

const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const since = d => new Date(Date.now() - d * 86400000).toISOString();
const short = p => { const d = String(p || '').replace(/\D/g, ''); return d ? '…' + d.slice(-4) : '?'; };
// Phone numbers and emails inside message text are masked before they go to Claude.
const scrub = t => String(t || '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\+?\d[\d\s().-]{7,}\d/g, m => short(m));
async function getJson(key, dflt) { try { const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle(); return (data && data.value) || dflt; } catch (e) { return dflt; } }
async function putJson(key, value) { const { error } = await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' }); if (error) throw new Error(error.message); }
// Test accounts (students whose id starts with S-DEMO, plus TEST_PHONES in Railway) are left
// out of the review, so testing the agent never shows up as real work.
async function testPhones() {
  const set = new Set(String(process.env.TEST_PHONES || '').split(',').map(x => x.replace(/\D/g, '')).filter(Boolean));
  try { const { data } = await supabase.from('students').select('id, phone').like('id', 'S-DEMO%'); (data || []).forEach(s => { const d = String(s.phone || '').replace(/\D/g, ''); if (d) set.add(d); }); } catch (e) {}
  return set;
}
async function rows(table, build) { try { const r = await build(supabase.from(table)); return r.data || []; } catch (e) { return []; } }

// ── 1. GATHER ──
async function gather(days) {
  const from = since(days);
  const tests = await testPhones();
  const drafts = (await rows('wa_drafts', x => x.select('id, phone, in_wa_id, status, body, sent_text, edited, category, needs_arpit, note, person_kind, created_at').gte('created_at', from).order('created_at', { ascending: true }).limit(400))).filter(d => !tests.has(String(d.phone || '').replace(/\D/g, '')));
  const interesting = drafts.filter(d => d.needs_arpit || d.edited || d.category === 'other' || d.status === 'no_reply' && d.note);
  const ids = [...new Set(interesting.map(d => d.in_wa_id).filter(Boolean))];
  const msgs = ids.length ? await rows('wa_messages', x => x.select('wa_id, body, type').in('wa_id', ids)) : [];
  const text = Object.fromEntries(msgs.map(m => [m.wa_id, scrub(m.body).slice(0, 400)]));
  const asks = interesting.map(d => ({
    who: (d.person_kind || 'unknown') + ' ' + short(d.phone),
    asked: text[d.in_wa_id] || '(not text)',
    category: d.category, passed_to_arpit: !!d.needs_arpit, agent_note: scrub(d.note),
    agent_draft: d.body ? scrub(d.body).slice(0, 300) : '',
    arpit_sent_instead: d.edited && d.sent_text ? scrub(d.sent_text).slice(0, 300) : ''
  })).slice(0, 80);
  const errors = (await rows('system_errors', x => x.select('source, location, message, count, first_at, last_at').gte('last_at', from).order('count', { ascending: false }).limit(40)))
    .map(e => ({ where: e.source + (e.location ? ' / ' + e.location : ''), message: scrub(e.message).slice(0, 220), count: e.count, last: e.last_at }));
  const fixes = (await getJson('health_fixes', [])).filter(f => f.at >= from).map(f => f.title + (f.detail ? ': ' + f.detail : '')).slice(0, 20);
  // numbers, counted here
  const [cls, trials, studs, fees, pays] = await Promise.all([
    rows('class_log', x => x.select('id, is_free').gte('class_date', from.slice(0, 10))),
    rows('trials', x => x.select('id, status, created_at').gte('created_at', from)),
    rows('students', x => x.select('id, join_date').gte('join_date', from.slice(0, 10))),
    rows('fee_requests', x => x.select('id, status, created_at, student_id')),
    rows('payments', x => x.select('amount, type, date').gte('date', from.slice(0, 10)))
  ]);
  const income = pays.filter(p => p.type === 'income').reduce((a, p) => a + Number(p.amount || 0), 0);
  const week = {
    classes: cls.length, trials_booked: trials.length, new_students: studs.length,
    fee_links_unpaid: fees.filter(f => f.status === 'pending' && !/^S-DEMO/i.test(String(f.student_id || ''))).length,
    income_inr: Math.round(income),
    agent_drafts: drafts.length, agent_auto_sent: drafts.filter(d => d.status === 'sent' && !d.edited && d.sent_text == null).length,
    agent_passed_to_you: drafts.filter(d => d.needs_arpit).length, agent_rewritten_by_you: drafts.filter(d => d.edited).length,
    fixed_by_itself: fixes.length, errors_seen: errors.reduce((a, e) => a + (e.count || 0), 0)
  };
  const agentSet = await getJson('agent', {});
  return { asks, errors, fixes, week, prev_week: await prevWeek(days), notes: String(agentSet.notes || '') };
}

// The same numbers for the window just before, so the dashboard can show ↑ / ↓ next to each.
// Only counts, nothing goes to Claude from here.
async function prevWeek(days) {
  try {
    const a = since(days * 2), b = since(days);
    const [cls, trials, studs, drafts] = await Promise.all([
      rows('class_log', x => x.select('id').gte('class_date', a.slice(0, 10)).lt('class_date', b.slice(0, 10))),
      rows('trials', x => x.select('id').gte('created_at', a).lt('created_at', b)),
      rows('students', x => x.select('id').gte('join_date', a.slice(0, 10)).lt('join_date', b.slice(0, 10))),
      rows('wa_drafts', x => x.select('id, needs_arpit').gte('created_at', a).lt('created_at', b))
    ]);
    const fixes = (await getJson('health_fixes', [])).filter(f => f.at >= a && f.at < b);
    return { classes: cls.length, trials_booked: trials.length, new_students: studs.length, agent_drafts: drafts.length, agent_passed_to_you: drafts.filter(d => d.needs_arpit).length, fixed_by_itself: fixes.length };
  } catch (e) { return null; }
}

// ── 2. ASK CLAUDE ──
const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two or three plain sentences for Arpit about how the week went and the one thing most worth his attention.' },
    new_questions: { type: 'array', items: { type: 'object', properties: {
      topic: { type: 'string', description: 'Short name, e.g. "Gift vouchers"' },
      count: { type: 'integer' },
      examples: { type: 'array', items: { type: 'string' }, description: 'Up to 2 short paraphrased examples, no names or numbers' },
      idea: { type: 'string', description: 'One sentence: what Arpit could offer or answer' }
    }, required: ['topic', 'count', 'examples', 'idea'], additionalProperties: false } },
    teach_agent: { type: 'array', items: { type: 'object', properties: {
      fact: { type: 'string', description: 'One line Arpit can add to the agent notes, written as a fact, e.g. "Gift vouchers: not offered yet, say Arpit will share details soon."' },
      why: { type: 'string', description: 'Which questions this would have answered' },
      needs_arpit_input: { type: 'boolean', description: 'true when the line has a placeholder Arpit must fill (a price, a date). Use [square brackets] for the blank.' }
    }, required: ['fact', 'why', 'needs_arpit_input'], additionalProperties: false } },
    errors: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, likely_cause: { type: 'string' }, fix_note: { type: 'string', description: 'What should change, for the developer' }, count: { type: 'integer' }, serious: { type: 'boolean' }
    }, required: ['title', 'likely_cause', 'fix_note', 'count', 'serious'], additionalProperties: false } }
  },
  required: ['summary', 'new_questions', 'teach_agent', 'errors'],
  additionalProperties: false
};
const RULES = `You review one week of Arpit's handpan studio (online 1:1 classes, workshops in Bengaluru, performances).
Write for Arpit: short, plain, warm, no jargon, no em dashes.
- new_questions: only real gaps, things people asked that the agent could not answer or Arpit had to handle. Group similar ones. Skip normal booking/fee/schedule chat that went fine. Empty list is fine.
- teach_agent: at most 5 lines, only facts that would have let the agent answer a real question from this week. Read MAIN KNOWLEDGE first: if the answer is already there and the agent still got it wrong or passed it on, do NOT suggest a line for it, list it under errors instead (title like "Agent ignored its knowledge", serious=false, fix_note says which rule). Never invent prices, dates or policies: put a [blank] and set needs_arpit_input. Do not repeat what the existing notes already say. Where Arpit rewrote a draft, learn from what he sent instead.
- errors: group by likely cause, skip one-offs that look harmless. serious = could lose money, a student, or a message.
- Never include phone numbers, emails or full names.`;

async function askClaude(data) {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set on the server');
  const body = {
    model: MODEL, max_tokens: 4000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: RULES,
    messages: [{ role: 'user', content:
      'THE WEEK IN NUMBERS\n' + JSON.stringify(data.week) +
      '\n\nMAIN KNOWLEDGE THE AGENT ALREADY HAS\n' + KNOWLEDGE.slice(0, 12000) +
      '\n\nAGENT NOTES ARPIT ALREADY HAS\n' + (data.notes.trim() || '(none)') +
      '\n\nCHATS THE AGENT PASSED TO ARPIT, OR WHERE ARPIT REWROTE THE REPLY\n' + JSON.stringify(data.asks) +
      '\n\nERRORS (server and dashboard)\n' + JSON.stringify(data.errors) +
      '\n\nFIXED BY ITSELF\n' + JSON.stringify(data.fixes) +
      '\n\nWrite the weekly review.' }]
  };
  const r = await fetch(API_URL, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Claude HTTP ' + r.status);
  const t = (j.content || []).find(b => b.type === 'text');
  if (!t) throw new Error('Claude returned no text');
  const u = j.usage || {};
  return { out: JSON.parse(t.text), cost_usd: Math.round(((u.input_tokens || 0) * 3 + (u.output_tokens || 0) * 15) / 1e6 * 10000) / 10000 };
}

// ── 3. RUN ──
async function run(opts = {}) {
  if (running) return { busy: true };
  running = true;
  try {
    const data = await gather(opts.days || 7);
    const { out, cost_usd } = await askClaude(data);
    const report = {
      at: new Date().toISOString(), days: opts.days || 7, manual: !!opts.manual, cost_usd,
      week: data.week, prev_week: data.prev_week || null, summary: out.summary || '',
      new_questions: (out.new_questions || []).slice(0, 8),
      teach_agent: (out.teach_agent || []).slice(0, 5).map((f, i) => ({ id: 'f' + Date.now().toString(36) + i, ...f, state: 'new' })),
      errors: (out.errors || []).slice(0, 8),
      asked_count: data.asks.length
    };
    await putJson('ai_review', report);
    const n = report.teach_agent.length + report.new_questions.length;
    if (deps.push) deps.push.send('alert', { title: 'Weekly review', body: '📋 ' + (report.summary.split('. ')[0] || 'Your weekly review is ready') + (n ? ' · ' + n + ' suggestion' + (n === 1 ? '' : 's') : ''), tag: 'ai-review', url: '/pages/dashboard#sec=health' });
    console.log('AI review done: ' + report.new_questions.length + ' new questions, ' + report.teach_agent.length + ' facts, ' + report.errors.length + ' error groups, $' + cost_usd);
    return { ok: true, report };
  } finally { running = false; }
}

// Sunday 9 AM IST, once there is a week of data.
async function tick() {
  try {
    const now = require('./studio-time').shifted(), day = now.toISOString().slice(0, 10);   // Arpit's own Sunday
    if (now.getUTCDay() !== RUN_DAY || now.toISOString().slice(11, 16) < RUN_HHMM) return;
    const st = await getJson('ai_review_state', {});
    if (st.lastAuto === day) return;
    const first = st.firstSeen || day;
    if ((Date.parse(day) - Date.parse(first)) / 86400000 < MIN_DATA_DAYS) { await putJson('ai_review_state', { ...st, firstSeen: first, lastAuto: day, skipped: 'not enough data yet' }); return; }
    await putJson('ai_review_state', { ...st, firstSeen: first, lastAuto: day });
    await run();
  } catch (e) { console.error('AI review failed:', e.message); }
}

function init(client, d = {}) { supabase = client; deps = d; }
async function startWorker() {
  const st = await getJson('ai_review_state', {});
  if (!st.firstSeen) await putJson('ai_review_state', { ...st, firstSeen: istNow().toISOString().slice(0, 10) }).catch(() => {});
  setInterval(tick, 15 * 60 * 1000);
  setTimeout(tick, 2 * 60 * 1000);
  console.log('AI review: Sundays 9 AM IST (' + MODEL + ')');
}

// ── 4. ENDPOINTS (admin) ──
async function getHandler(req, res) {
  const [report, st] = await Promise.all([getJson('ai_review', null), getJson('ai_review_state', {})]);
  res.json({ ok: true, report, running, firstSeen: st.firstSeen || null, key: !!String(process.env.ANTHROPIC_API_KEY || '').trim() });
}
async function runHandler(req, res) {
  try { const r = await run({ manual: true, days: Math.min(30, Math.max(1, Number(req.body && req.body.days) || 7)) }); if (r.busy) return res.status(409).json({ error: 'A review is already running' }); res.json(r); }
  catch (e) { console.error('AI review failed:', e.message); res.status(500).json({ error: 'Review failed: ' + e.message }); }
}
// POST /api/review/fact { id, action: 'add' | 'skip', text? }  → add puts the line into the agent notes
async function factHandler(req, res) {
  try {
    const b = req.body || {};
    const report = await getJson('ai_review', null);
    const f = report && (report.teach_agent || []).find(x => x.id === b.id);
    if (!f) return res.status(404).json({ error: 'Suggestion not found' });
    if (b.action === 'add') {
      const line = String(b.text || f.fact).replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!line) return res.status(400).json({ error: 'Empty line' });
      if (/\[[^\]]*\]/.test(line)) return res.status(400).json({ error: 'Fill in the [blank] first' });
      const agent = await getJson('agent', {});
      const notes = String(agent.notes || '').trim();
      if (!notes.toLowerCase().includes(line.toLowerCase())) {
        agent.notes = (notes ? notes + '\n' : '') + line;
        if (agent.notes.length > 4000) return res.status(400).json({ error: 'The agent notes are full. Tidy them in WhatsApp agent first.' });
        await putJson('agent', agent);
        if (deps.agentReload) try { await deps.agentReload(); } catch (e) {}
      }
      f.state = 'added'; f.fact = line;
    } else f.state = 'skipped';
    await putJson('ai_review', report);
    res.json({ ok: true, report });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = { init, startWorker, run, getHandler, runHandler, factHandler, _test: { gather, SCHEMA, RULES, tick, setDeps: (c, d) => { supabase = c; deps = d || {}; } } };
