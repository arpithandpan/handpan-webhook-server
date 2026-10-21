// workshop-messages.js
// WhatsApp messages around a workshop, sent from the studio number:
//   1. confirmation    as soon as a booking lands (older bookings: on the next tick)
//   2. day-before      reminder at 7 PM IST the evening before
//   3. two-hours       reminder 2 hours before the start
//   4. review          11 AM IST the next day: thanks + "Leave a review" button
//   5. follow-up       11 AM IST three days later, one of two:
//                        brought their own handpan → online classes, first one free
//                        everyone else             → "thinking of getting your own? reply here"
// One message, one ask, on different days. Only the person who booked gets
// messages (guest rows share their phone). If Arpit uses check-in at a
// workshop, 4 and 5 go only to people who came.
// Each send is stamped on the participant row (wa_confirm_at, wa_day_before_at,
// wa_two_hours_at, wa_thanks_at, wa_followup_at) so nothing goes twice.
// Railway WA_WORKSHOP_TEMPLATES=on turns real sending on. Anything else = dry-run:
// the log says what would go and nothing is stamped.

const EVERY_MS = 2 * 60 * 1000;
const FALLBACK_MAP = 'https://arpitpandey.com/workshops';

let supabase = null, whatsapp = null, timer = null, running = false;
function init(client, deps) { supabase = client; whatsapp = deps.whatsapp; }
function on() { return String(process.env.WA_WORKSHOP_TEMPLATES || '').trim().toLowerCase() === 'on'; }
// Railway WA_INVOICE_DOCS=on: the confirmation goes as workshop_confirmation_v2
// with the invoice PDF on top. Off (or no invoice in time) = the old text-only one.
function docsOn() { return String(process.env.WA_INVOICE_DOCS || '').trim().toLowerCase() === 'on'; }
const INVOICE_WAIT_MS = 5 * 60 * 1000;   // how long a confirmation waits for its invoice PDF
const firstSeen = new Map();             // participant id -> when this worker first saw it unconfirmed
const { invoiceDocLink } = require('./invoice-service');

// The stored invoice for this booking: the lead's row or any guest row of the group.
async function bookingInvoice(p, all) {
  const ids = [p.id].concat(all.filter(x => x.lead_name && x.lead_name === p.full_name).map(x => x.id));
  const { data } = await supabase.from('invoices')
    .select('id, pdf_path, cancelled').eq('source_table', 'participants').in('source_id', ids)
    .not('pdf_path', 'is', null).order('invoice_number', { ascending: false }).limit(1);
  const row = (data || []).find(r => !r.cancelled);
  return row || null;
}

// Same parsing as the booking code: "4:00 PM", "16:00", "4:00 PM - 5:30 PM".
function startUtc(dateStr, timeStr) {
  if (!dateStr) return null;
  let h = 23, mi = 59;
  const m = String(timeStr || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/);
  if (m) {
    h = parseInt(m[1], 10); mi = parseInt(m[2], 10);
    let mer = m[3];
    if (!mer) { const later = String(timeStr).slice(m.index + m[0].length).match(/(AM|PM|am|pm)/); mer = later ? later[1] : null; }
    if (mer) { mer = mer.toUpperCase(); if (mer === 'PM' && h < 12) h += 12; if (mer === 'AM' && h === 12) h = 0; }
  }
  const d = new Date(`${String(dateStr).slice(0, 10)}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+05:30`);
  return isNaN(d) ? null : d;
}
const istAt = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00+05:30`);
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function todayIst() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
function prettyDate(ymd) { return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }); }
function prettyTime(d) { return d.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// "Yes", "No", or for group bookings "2 of 3".
function bringsOwn(v) {
  const s = String(v || '').trim();
  if (/^yes$/i.test(s)) return true;
  const m = s.match(/^(\d+)\s+of\s+\d+$/i);
  return !!(m && Number(m[1]) > 0);
}
async function notify(type, message) {
  try { await supabase.from('notifications').insert({ type, message, read: false }); } catch (e) {}
}

async function send(p, kind, template, params, stampCol, ws, opts) {
  const who = clean(p.full_name) || p.id;
  if (!on()) { console.log(`Workshop dry-run: would send ${template} (${kind}) to ${who} for ${ws.id}`); return; }
  let r = await whatsapp.sendTemplate(p.phone, template, params.map(clean), opts);
  // The invoice version failed (template not approved yet, PDF link refused):
  // send the plain confirmation instead, so the booking message never goes missing.
  if (!r.ok && opts && opts.fallbackTemplate) {
    console.error(`Workshop ${template} to ${who} failed (${r.error}), sending ${opts.fallbackTemplate}`);
    r = await whatsapp.sendTemplate(p.phone, opts.fallbackTemplate, params.map(clean));
  }
  // Stamp either way so a bad number never loops; a failure becomes one alert.
  await supabase.from('participants').update({ [stampCol]: new Date().toISOString() }).eq('id', p.id);
  if (!r.ok) await notify('warning', `⚠️ Workshop ${kind} to ${who} (${ws.id}) failed: ${r.error}. Message them by hand.`);
}

async function processPending() {
  if (!supabase || !whatsapp || running) return;
  running = true;
  try {
    const today = todayIst();
    const { data: wss, error } = await supabase.from('workshops')
      .select('id, date, workshop_time, venue, venue_map_url, archived, cancelled')
      .gte('date', addDays(today, -1)).order('date', { ascending: true });
    if (error) { console.error('workshop-messages: workshops query', error.message); return; }
    const now = Date.now();
    for (const ws of (wss || [])) {
      if (ws.archived || ws.cancelled) continue;
      const ymd = String(ws.date).slice(0, 10);
      const start = startUtc(ymd, ws.workshop_time);
      if (!start) continue;
      const { data: ps } = await supabase.from('participants')
        .select('id, full_name, phone, lead_name, archived, checked_in, bringing_own_handpan, wa_confirm_at, wa_day_before_at, wa_two_hours_at, wa_thanks_at, wa_followup_at')
        .eq('workshop_id', ws.id);
      const all = (ps || []).filter(p => !p.archived);
      const leads = all.filter(p => !p.lead_name && p.phone);
      const usesCheckIn = all.some(p => p.checked_in);
      const date = prettyDate(ymd), time = prettyTime(start), venue = clean(ws.venue) || 'the venue', map = ws.venue_map_url || FALLBACK_MAP;
      const dayBefore = istAt(addDays(ymd, -1), '19:00').getTime();
      const thanksAt = istAt(addDays(ymd, 1), '11:00').getTime();
      const thanksEnd = istAt(addDays(ymd, 1), '23:59').getTime();
      const followAt = istAt(addDays(ymd, 3), '11:00').getTime();
      const followEnd = istAt(addDays(ymd, 3), '23:59').getTime();
      for (const p of leads) {
        const name = firstName(p.full_name);
        const confirmedAgo = p.wa_confirm_at ? now - new Date(p.wa_confirm_at).getTime() : Infinity;
        // 1. Confirmation, while the workshop is still ahead
        if (!p.wa_confirm_at && now < start.getTime()) {
          const params = [name, date, time, venue, map];
          if (docsOn()) {
            const inv = await bookingInvoice(p, all);
            const doc = inv ? await invoiceDocLink(supabase, inv) : null;
            if (doc) {
              await send(p, 'confirmation', 'workshop_confirmation_v2', params, 'wa_confirm_at', ws,
                { document: doc, fallbackTemplate: 'workshop_confirmation' });
              firstSeen.delete(p.id);
              continue;
            }
            // No invoice PDF yet: the webhook may still be making it. Wait a few ticks.
            if (!firstSeen.has(p.id)) firstSeen.set(p.id, now);
            if (now - firstSeen.get(p.id) < INVOICE_WAIT_MS) continue;
            firstSeen.delete(p.id);
          }
          await send(p, 'confirmation', 'workshop_confirmation', params, 'wa_confirm_at', ws);
          continue;   // reminders wait for the next tick
        }
        // 2. Day before, 7 PM (skip if they only just got the confirmation)
        if (!p.wa_day_before_at && now >= dayBefore && now < start.getTime() - 3 * 3600 * 1000 && confirmedAgo > 3 * 3600 * 1000) {
          await send(p, 'day-before reminder', 'workshop_reminder', [name, 'tomorrow', time, venue, map], 'wa_day_before_at', ws);
          continue;
        }
        // 3. Two hours before
        if (!p.wa_two_hours_at && now >= start.getTime() - 2 * 3600 * 1000 && now < start.getTime() && confirmedAgo > 30 * 60 * 1000) {
          await send(p, '2-hour reminder', 'workshop_reminder', [name, 'today', time, venue, map], 'wa_two_hours_at', ws);
          continue;
        }
        // 4 + 5 only for people who came (when Arpit uses check-in at this workshop)
        const came = !usesCheckIn || all.some(x => (x.id === p.id || x.lead_name === p.full_name) && x.checked_in);
        if (!came) continue;
        // 4. Next day 11 AM: thanks + review button
        if (!p.wa_thanks_at && now >= thanksAt && now <= thanksEnd) {
          await send(p, 'review request', 'workshop_review', [name], 'wa_thanks_at', ws);
          continue;
        }
        // 5. Three days later 11 AM: one gentle next step
        if (!p.wa_followup_at && now >= followAt && now <= followEnd) {
          const tpl = bringsOwn(p.bringing_own_handpan) ? 'workshop_followup_classes' : 'workshop_followup_handpan';
          await send(p, 'follow-up', tpl, [name], 'wa_followup_at', ws);
        }
      }
    }
  } catch (e) {
    console.error('workshop-messages error:', e.message);
  } finally { running = false; }
}

function startWorker() {
  console.log('Workshop messages: worker started (' + (on() ? 'sending ON' : 'off, dry-run') + ')');
  setTimeout(processPending, 30 * 1000);
  timer = setInterval(processPending, EVERY_MS);
}

module.exports = { init, startWorker, processPending, _test: { startUtc, bringsOwn, prettyDate } };
