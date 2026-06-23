const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──
// book.html calls /api/create-payment-link and /api/workshop/:id/availability
// directly from the browser, from a different origin than this server, so we need to
// allow that. This is just response headers, doesn't affect the Razorpay webhook route
// (which reads the raw body separately) or any other logic.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── SUPABASE ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── GENERAL PAYMENT PAGE ID ──
const GENERAL_PAYMENT_PAGE_ID = 'pl_SvxuRdqY2rd7ge';

// ── TICKET PRICING ──
// Pricing now lives per-workshop on the workshops table (price_per_head for
// participants, observer_price for audience passes), set from the dashboard.
// Never trusted from the client — /api/create-payment-link always looks up
// the workshop's own prices in Supabase before computing the charge.

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── HELPERS ──
async function generateId(table, prefix) {
  const { data } = await supabase
    .from(table)
    .select('id')
    .like('id', `${prefix}-%`)
    .order('id', { ascending: false })
    .limit(1);
  if (data && data.length > 0) {
    const lastNum = parseInt(data[0].id.replace(`${prefix}-`, ''));
    return `${prefix}-${String(lastNum + 1).padStart(3, '0')}`;
  }
  return `${prefix}-001`;
}

// generateId() looks up the current max each time it's called, so calling
// it N times back-to-back before anything is actually inserted hands back
// the same id N times over — nothing in between bumps the max. This
// queries the max once and builds the rest of the sequence locally, which
// is what inserting a whole group of people in one go needs.
async function generateSequentialIds(table, prefix, count) {
  const { data } = await supabase
    .from(table)
    .select('id')
    .like('id', `${prefix}-%`)
    .order('id', { ascending: false })
    .limit(1);

  let nextNum = 1;
  if (data && data.length > 0) {
    nextNum = parseInt(data[0].id.replace(`${prefix}-`, '')) + 1;
  }

  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(`${prefix}-${String(nextNum + i).padStart(3, '0')}`);
  }
  return ids;
}

// ── IDEMPOTENCY CHECKS ──
async function isAlreadyProcessed(razorpayPaymentId) {
  const { data, error } = await supabase
    .from('payments')
    .select('id')
    .eq('razorpay_payment_id', razorpayPaymentId)
    .limit(1);
  if (error) { console.warn('Idempotency check error:', error.message); return false; }
  return data && data.length > 0;
}

async function isAlreadyUnassigned(razorpayPaymentId) {
  const { data, error } = await supabase
    .from('unassigned_payments')
    .select('id')
    .eq('razorpay_payment_id', razorpayPaymentId)
    .limit(1);
  if (error) { console.warn('Unassigned idempotency check error:', error.message); return false; }
  return data && data.length > 0;
}

// ── NORMALISE YES/NO ──
function normaliseYesNo(val) {
  if (!val) return null;
  const v = val.toString().trim().toLowerCase();
  if (['yes','y','yeah','yep','yup','true','1','ok','okay'].includes(v)) return 'Yes';
  if (['no','n','nope','nah','false','0'].includes(v)) return 'No';
  return val.trim();
}

// ── COUNT TOTAL PEOPLE ON A PARTICIPANT ROW ──
// Legacy rows (from the old Payment Page flow) don't have participant_count /
// observer_count set, so we fall back to "1 participant, 0 observers" — the
// same assumption the old code made implicitly with its "+1 pax" logic.
function rowPeopleCounts(row) {
  return {
    participantCount: row.participant_count ?? 1,
    observerCount: row.observer_count ?? 0,
  };
}

// ── EXTRACT ALL FIELDS FROM PAYMENT ──
// This is the single source of truth for what we capture from Razorpay.
// All fields are extracted here. Adding a new field in future = just add it here.
function extractPaymentFields(payment) {
  const notes = payment.notes || {};

  // Core fields
  const name   = notes.name || payment.customer_name || 'Unknown';
  const phone  = payment.contact || null;
  const email  = payment.email || null;
  const amount = payment.amount / 100;

  // Custom note fields — try all known key variants
  const bringingOwn = notes.bringingOwnHandpan
    || notes['handpans_will_be_provided_bringing_your_own?_(yes/no)']
    || notes['handpans_will_be_provided_bringing_your_own?(yes/no)']
    || notes['handpans_will_be_provided._bringing_your_own?_(yes/no)']
    || notes['bringing_your_own']
    || null;

  // Page ID (used by the old Payment Page matching flow)
  const pageId = notes.payment_page_id
    || payment.payment_page_id
    || payment.invoice_id
    || null;

  // NEW: workshop + ticket info, set by /api/create-payment-link for
  // bookings made through book.html. Won't be present on payments
  // from manually-created Payment Pages — that's fine, those fall back to
  // page_id / date+amount matching below, same as before.
  const workshopIdFromNotes = notes.workshopId || null;
  const participantCount = notes.participants !== undefined
    ? (parseInt(notes.participants, 10) || 0)
    : null;
  const observerCount = notes.observers !== undefined
    ? (parseInt(notes.observers, 10) || 0)
    : null;

  // NEW: guest names for additional participants, the handpan-count
  // breakdown for a group, and the per-head price used to charge this
  // booking — all stashed in notes by /api/create-payment-link so the
  // webhook can build one row per person without re-querying anything.
  let guestNames = [];
  if (notes.guestNames !== undefined) {
    try {
      const parsed = JSON.parse(notes.guestNames);
      if (Array.isArray(parsed)) guestNames = parsed;
    } catch (e) {
      // malformed — fall back to no guest names rather than failing the whole webhook
    }
  }

  const ownHandpanCount = notes.ownHandpanCount !== undefined
    ? (parseInt(notes.ownHandpanCount, 10) || 0)
    : null;

  const participantPrice = notes.participantPrice !== undefined
    ? (parseFloat(notes.participantPrice) || null)
    : null;

  return {
    name,
    phone,
    email,
    amount,
    pageId,
    bringingOwn,        // raw value as typed by user
    bringingOwnNorm: normaliseYesNo(bringingOwn),   // normalised for filters
    workshopIdFromNotes,
    participantCount,   // null if not present (old-flow payment)
    observerCount,       // null if not present (old-flow payment)
    guestNames,          // [] if not present
    ownHandpanCount,      // null if not present (old-flow payment)
    participantPrice,    // null if not present (old-flow payment)
  };
}

// ── WORKSHOP MATCHING ──
async function findWorkshopById(workshopId) {
  if (!workshopId) return null;
  const { data } = await supabase
    .from('workshops')
    .select('id')
    .eq('id', workshopId)
    .single();
  return data ? data.id : null;
}

async function findWorkshopByPageId(pageId) {
  if (!pageId) return null;
  const { data } = await supabase
    .from('workshops')
    .select('id')
    .eq('razorpay_page_id', pageId)
    .single();
  return data ? data.id : null;
}

async function findWorkshopByDateAndAmount(amountINR, paymentDateStr) {
  try {
    const { data: workshops } = await supabase
      .from('workshops')
      .select('id, date, price_per_head, venue')
      .neq('archived', true)
      .order('date', { ascending: true });

    if (!workshops) return null;
    const payDate = new Date(paymentDateStr);
    const matches = workshops.filter(w => {
      if (!w.date || !w.price_per_head) return false;
      const wsDate = new Date(w.date);
      const diffDays = (wsDate - payDate) / (1000 * 60 * 60 * 24);
      if (diffDays < 0 || diffDays > 45) return false;
      const pph = Number(w.price_per_head);
      return Math.abs(amountINR - pph) <= pph * 0.05;
    });
    return matches.length ? matches[0] : null;
  } catch (e) {
    console.error('findWorkshopByDateAndAmount error:', e.message);
    return null;
  }
}

// ── SAVE PARTICIPANT (with full raw payload backup) ──
// This function saves all known fields + the full raw Razorpay payment object.
// Even if new columns are added to Supabase later, the raw_payload always has everything.
async function saveParticipant(participantId, fields, workshopId, matchMethod, rawPayment) {
  const { name, phone, email, amount, bringingOwn } = fields;
  const today = new Date().toISOString().split('T')[0];

  // Default to "1 participant, 0 observers" for old-flow payments where
  // notes.participants / notes.observers weren't set.
  const participantCount = fields.participantCount ?? 1;
  const observerCount = fields.observerCount ?? 0;

  const record = {
    id: participantId,
    full_name: name,
    razorpay_name: name,
    phone: phone || null,
    email: email || null,
    workshop_id: workshopId,
    amount_paid: amount,
    participant_count: participantCount,
    observer_count: observerCount,
    payment_mode: 'Razorpay UPI',
    booking_source: 'Razorpay UPI',
    checked_in: false,
    date: today,
    bringing_own_handpan: bringingOwn || null,
    razorpay_payment_id: rawPayment.id || null,
    raw_payload: rawPayment, // full Razorpay payment object — never lose data
    notes: `Auto-created via Razorpay webhook (matched by ${matchMethod}). Payment ID: ${rawPayment.id}`
  };

  const { error } = await supabase.from('participants').insert(record);

  if (error) {
    console.error('Error saving participant:', error.message);
    // Send a dashboard notification so the failure is visible
    await supabase.from('notifications').insert({
      type: 'warning',
      message: `⚠️ Failed to save participant ${name} — Payment ${rawPayment.id}. Error: ${error.message}`,
      read: false
    });
    return { success: false, error: error.message };
  }

  console.log('Participant saved:', participantId, name, '— all fields captured');
  return { success: true };
}

// ── BUILD ONE ROW PER PERSON FOR A NEW-FLOW BOOKING ──
// Bookings made through book.html always set notes.participants, which is
// what tells us we have real per-person data to split out. This builds one
// row for the lead and one for each remaining ticket, filling any blank
// guest name with a placeholder Arpit can rename in person. Pure function,
// no DB calls, so it's easy to test directly with different inputs.
function buildParticipantRows(ids, fields, workshopId, matchMethod, rawPayment, today) {
  const pCount = fields.participantCount ?? 1;
  const oCount = fields.observerCount ?? 0;
  const guestNamesRaw = Array.isArray(fields.guestNames) ? fields.guestNames : [];

  // The lead, then one entry per remaining ticket. Guest numbering starts
  // at 2 since the lead is implicitly person 1.
  const names = [fields.name];
  for (let i = 0; i < pCount - 1; i++) {
    const provided = (guestNamesRaw[i] || '').toString().trim();
    names.push(provided || `${fields.name}'s Guest ${i + 1}`);
  }

  // The handpan question is a group-level aggregate, shown identically on
  // every card from this booking — plain Yes/No for a solo booking, or
  // "X of Y" once there's more than one ticket.
  let handpanDisplay;
  if (pCount <= 1) {
    handpanDisplay = fields.bringingOwn || null;
  } else {
    const ownCount = fields.ownHandpanCount != null ? fields.ownHandpanCount : 0;
    handpanDisplay = `${ownCount} of ${pCount}`;
  }

  return names.map((name, idx) => {
    const isLead = idx === 0;
    return {
      id: ids[idx],
      full_name: name,
      razorpay_name: isLead ? fields.name : null,
      phone: fields.phone || null,
      email: fields.email || null,
      workshop_id: workshopId,
      amount_paid: fields.participantPrice != null ? fields.participantPrice : fields.amount,
      participant_count: 1,
      observer_count: isLead ? oCount : 0,
      payment_mode: 'Razorpay UPI',
      booking_source: 'Razorpay UPI',
      checked_in: false,
      date: today,
      bringing_own_handpan: handpanDisplay,
      razorpay_payment_id: rawPayment.id || null,
      lead_name: isLead ? null : fields.name,
      guest_count: isLead ? (names.length - 1) : null,
      raw_payload: rawPayment, // full Razorpay payment object — never lose data
      notes: `Auto-created via Razorpay webhook (matched by ${matchMethod}). Payment ID: ${rawPayment.id}. Person ${idx + 1} of ${names.length}.`
    };
  });
}

// ── SAVE A WHOLE GROUP OF PEOPLE FROM ONE BOOKING ──
async function saveParticipantGroup(rows) {
  const { error } = await supabase.from('participants').insert(rows);

  if (error) {
    console.error('Error saving participant group:', error.message);
    await supabase.from('notifications').insert({
      type: 'warning',
      message: `⚠️ Failed to save ${rows.length} participant row(s) for ${rows[0]?.full_name || 'unknown'} — Payment ${rows[0]?.razorpay_payment_id}. Error: ${error.message}`,
      read: false
    });
    return { success: false, error: error.message };
  }

  console.log('Participant group saved:', rows.length, 'rows —', rows.map(r => r.id).join(', '));
  return { success: true };
}

// ── CREATE PAYMENT LINK ──
// Called by book.html when someone taps "Reserve my spot".
// Creates a Razorpay Payment Link for the exact amount (computed here, not
// trusted from the client) and stashes workshopId + ticket counts in notes
// so the webhook below can match and count this booking accurately.
app.post('/api/create-payment-link', express.json(), async (req, res) => {
  try {
    const {
      workshopId, participants, observers,
      name, phone, email,
      bringingOwnHandpan,
      guestNames, ownHandpanCount
    } = req.body || {};

    if (!workshopId || !name || !phone || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const pCount = Number(participants) || 0;
    const oCount = Number(observers) || 0;
    if (pCount + oCount <= 0) {
      return res.status(400).json({ error: 'At least one ticket is required' });
    }

    // 1. Look up the workshop, its capacity (if set), and its prices
    const { data: workshop, error: wsError } = await supabase
      .from('workshops')
      .select('id, participant_capacity, observer_capacity, price_per_head, observer_price, archived')
      .eq('id', workshopId)
      .single();

    if (wsError || !workshop || workshop.archived) {
      return res.status(404).json({ error: 'Workshop not found' });
    }

    // 2. If capacity is configured, re-check availability before charging.
    // This is the server-side guard against the race condition where two
    // people both see "1 spot left" and try to book it at the same time.
    if (workshop.participant_capacity != null || workshop.observer_capacity != null) {
      const { data: existing, error: existingErr } = await supabase
        .from('participants')
        .select('participant_count, observer_count')
        .eq('workshop_id', workshopId);

      if (existingErr) {
        console.error('Availability check error:', existingErr.message);
        return res.status(500).json({ error: 'Failed to check availability' });
      }

      let participantsSold = 0;
      let observersSold = 0;
      for (const row of (existing || [])) {
        const counts = rowPeopleCounts(row);
        participantsSold += counts.participantCount;
        observersSold += counts.observerCount;
      }

      if (workshop.participant_capacity != null
          && participantsSold + pCount > workshop.participant_capacity) {
        return res.status(409).json({ error: 'Not enough participant slots remaining' });
      }
      if (workshop.observer_capacity != null
          && observersSold + oCount > workshop.observer_capacity) {
        return res.status(409).json({ error: 'Not enough audience pass slots remaining' });
      }
    }

    // 3. Compute the amount server-side from this workshop's own prices —
    // never trust an amount from the client, and never fall back to a
    // guessed price. If a price isn't set for a ticket type someone's
    // actually trying to buy, fail clearly instead of charging ₹0 for it.
    const participantPrice = Number(workshop.price_per_head) || 0;
    const observerPrice = Number(workshop.observer_price) || 0;

    if (pCount > 0 && participantPrice <= 0) {
      return res.status(400).json({ error: 'Participant price is not set for this workshop yet' });
    }
    if (oCount > 0 && observerPrice <= 0) {
      return res.status(400).json({ error: 'Audience pass price is not set for this workshop yet' });
    }

    const amountRupees = pCount * participantPrice + oCount * observerPrice;
    const amountPaise = amountRupees * 100;

    const ticketSummary = `${pCount} participant${pCount === 1 ? '' : 's'}`
      + (oCount ? `, ${oCount} audience pass${oCount === 1 ? '' : 'es'}` : '');

    // 4. Create the Razorpay Payment Link
    const auth = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString('base64');

    const rzpRes = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        description: `${workshopId} — ${ticketSummary}`,
        customer: { name, contact: phone, email },
        notify: { sms: true, email: true },
        reminder_enable: true,
        callback_url: `https://arpitpandey.com/pages/book?ws=${encodeURIComponent(workshopId)}`,
        callback_method: 'get',
        notes: {
          workshopId,
          participants: String(pCount),
          observers: String(oCount),
          name,
          phone,
          email,
          bringingOwnHandpan: bringingOwnHandpan || '',
          guestNames: JSON.stringify(Array.isArray(guestNames) ? guestNames.filter(n => (n || '').toString().trim()) : []),
          ownHandpanCount: String(ownHandpanCount != null ? ownHandpanCount : 0),
          participantPrice: String(participantPrice)
        }
      })
    });

    const rzpData = await rzpRes.json();

    if (!rzpRes.ok) {
      console.error('Razorpay payment link error:', rzpData);
      return res.status(502).json({
        error: 'Failed to create payment link',
        detail: rzpData.error?.description || 'Unknown error'
      });
    }

    return res.json({ short_url: rzpData.short_url, id: rzpData.id });
  } catch (err) {
    console.error('create-payment-link error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── WORKSHOP INFO + AVAILABILITY ──
// Called by book.html on page load. Returns everything the page needs to
// render itself for this workshop: date, time, venue, prices, and how many
// participant / audience pass slots are left. book.html no longer hardcodes
// any of this — it's a single template that works for any workshop ID.
app.get('/api/workshop/:id/availability', async (req, res) => {
  try {
    const workshopId = req.params.id;

    const { data: workshop, error: wsError } = await supabase
      .from('workshops')
      .select('id, date, venue, workshop_time, venue_map_url, price_per_head, observer_price, participant_capacity, observer_capacity, archived')
      .eq('id', workshopId)
      .single();

    if (wsError || !workshop || workshop.archived) {
      return res.status(404).json({ error: 'Workshop not found' });
    }

    const { data: rows, error } = await supabase
      .from('participants')
      .select('participant_count, observer_count')
      .eq('workshop_id', workshopId);

    if (error) {
      console.error('Availability query error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch availability' });
    }

    let participantsSold = 0;
    let observersSold = 0;
    for (const row of (rows || [])) {
      const counts = rowPeopleCounts(row);
      participantsSold += counts.participantCount;
      observersSold += counts.observerCount;
    }

    const result = {
      workshopId,
      date: workshop.date,
      time: workshop.workshop_time || null,
      venue: workshop.venue || null,
      venueMapUrl: workshop.venue_map_url || null,
      participantPrice: workshop.price_per_head != null ? Number(workshop.price_per_head) : null,
      observerPrice: workshop.observer_price != null ? Number(workshop.observer_price) : null,
      participantsSold,
      observersSold
    };

    if (workshop.participant_capacity != null) {
      result.participantsRemaining = Math.max(0, workshop.participant_capacity - participantsSold);
    }
    if (workshop.observer_capacity != null) {
      result.observersRemaining = Math.max(0, workshop.observer_capacity - observersSold);
    }

    return res.json(result);
  } catch (err) {
    console.error('availability error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── WAITLIST SIGNUP ──
// Called by book.html when someone on a sold-out workshop submits the
// "which month works for you" prompt. Always source: 'Website' here — the
// dashboard's manual-entry form writes to Supabase directly like every
// other section does, it doesn't go through this endpoint.
app.post('/api/waitlist', express.json(), async (req, res) => {
  try {
    const { name, phone, email, preferredMonth } = req.body || {};

    if (!name || !phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const waitlistId = await generateId('workshop_waitlist', 'WL');

    const { error } = await supabase.from('workshop_waitlist').insert({
      id: waitlistId,
      full_name: name,
      phone,
      email: email || null,
      preferred_month: preferredMonth || null,
      source: 'Website',
      contacted: false
    });

    if (error) {
      console.error('Error saving waitlist entry:', error.message);
      return res.status(500).json({ error: 'Failed to save waitlist entry' });
    }

    let monthLabel = 'a future workshop';
    if (preferredMonth) {
      const d = new Date(`${preferredMonth}T00:00:00`);
      if (!isNaN(d)) monthLabel = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }

    await supabase.from('notifications').insert({
      type: 'info',
      message: `📋 New waitlist signup: ${name} — interested in ${monthLabel}`,
      read: false
    });

    return res.json({ id: waitlistId });
  } catch (err) {
    console.error('waitlist error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── RAZORPAY WEBHOOK ──
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // 1. Verify signature
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(req.body)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.warn('Invalid Razorpay webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(req.body.toString());
    console.log('Webhook event:', event.event);

    // ── PAYMENT CAPTURED ──
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const fields = extractPaymentFields(payment);
      const today = new Date().toISOString().split('T')[0];

      console.log('Payment:', payment.id, '₹' + fields.amount, 'from', fields.name);
      console.log('Notes:', JSON.stringify(payment.notes));

      const isGeneral = fields.pageId === GENERAL_PAYMENT_PAGE_ID;

      // 2. Idempotency — skip if already processed
      if (isGeneral) {
        if (await isAlreadyUnassigned(payment.id)) {
          console.log('Duplicate unassigned — skipping:', payment.id);
          return res.json({ received: true, skipped: 'duplicate' });
        }
      } else {
        if (await isAlreadyProcessed(payment.id)) {
          console.log('Duplicate workshop payment — skipping:', payment.id);
          return res.json({ received: true, skipped: 'duplicate' });
        }
      }

      // 3. Route general payments to unassigned
      if (isGeneral) {
        const unassignedId = await generateId('unassigned_payments', 'UP');
        const { error } = await supabase.from('unassigned_payments').insert({
          id: unassignedId,
          amount: fields.amount,
          payer_name: fields.name,
          payer_phone: fields.phone,
          payer_email: fields.email,
          razorpay_payment_id: payment.id,
          razorpay_order_id: payment.order_id || null,
          date: today,
          status: 'pending',
          notes: `Auto-created from Razorpay payment ${payment.id}`
        });

        if (error) {
          console.error('Error saving unassigned:', error.message);
          return res.status(500).json({ error: 'Failed to save unassigned payment' });
        }

        await supabase.from('notifications').insert({
          type: 'payment',
          message: `💸 New unassigned payment: ₹${fields.amount} from ${fields.name} — needs assignment`,
          read: false
        });

        return res.json({ received: true, routed: 'unassigned', id: unassignedId });
      }

      // 4. Match workshop
      let workshopId = null;
      let matchMethod = null;

      // NEW: try a direct match via workshopId stashed in notes by
      // /api/create-payment-link. This is the most reliable match, and is
      // checked first. Old-flow payments (from manually-created Payment
      // Pages) won't have this, so they fall through to the checks below
      // exactly as before.
      if (fields.workshopIdFromNotes) {
        workshopId = await findWorkshopById(fields.workshopIdFromNotes);
        if (workshopId) {
          matchMethod = 'notes_workshop_id';
          console.log('Workshop matched by notes.workshopId:', workshopId);
        }
      }

      if (!workshopId) {
        workshopId = await findWorkshopByPageId(fields.pageId);
        if (workshopId) {
          matchMethod = 'page_id';
          console.log('Workshop matched by page_id:', workshopId);
        } else {
          const matched = await findWorkshopByDateAndAmount(fields.amount, today);
          if (matched) {
            workshopId = matched.id;
            matchMethod = 'date_amount';
            console.log('Workshop matched by date+amount:', workshopId);
          }
        }
      }

      // 5. No workshop match → unassigned
      if (!workshopId) {
        const unassignedId = await generateId('unassigned_payments', 'UP');
        await supabase.from('unassigned_payments').insert({
          id: unassignedId,
          amount: fields.amount,
          payer_name: fields.name,
          payer_phone: fields.phone,
          payer_email: fields.email,
          razorpay_payment_id: payment.id,
          date: today,
          status: 'pending',
          notes: `No workshop match found. Payment ${payment.id}`
        });

        await supabase.from('notifications').insert({
          type: 'warning',
          message: `⚠️ No workshop matched for payment ₹${fields.amount} from ${fields.name} — moved to unassigned`,
          read: false
        });

        return res.json({ received: true, routed: 'unassigned_no_match', id: unassignedId });
      }

      // 6. Save participant(s) with full payload — one row per person for
      // new-flow bookings (which always carry notes.participants), or the
      // original single row for old-flow Payment Page payments that don't
      // have per-person data to split out.
      let participantIds;
      if (fields.participantCount != null) {
        const pCount = fields.participantCount ?? 1;
        const ids = await generateSequentialIds('participants', 'P', pCount);
        const rows = buildParticipantRows(ids, fields, workshopId, matchMethod, payment, today);
        const result = await saveParticipantGroup(rows);

        if (!result.success) {
          return res.status(500).json({ error: 'Failed to save participants', detail: result.error });
        }
        participantIds = ids;
      } else {
        const participantId = await generateId('participants', 'P');
        const result = await saveParticipant(participantId, fields, workshopId, matchMethod, payment);

        if (!result.success) {
          return res.status(500).json({ error: 'Failed to save participant', detail: result.error });
        }
        participantIds = [participantId];
      }

      // Workshop stats (pax / revenue / profit / margin) are now recomputed
      // automatically by a database trigger whenever participants or payments
      // change. Nothing to update here.

      // 8. Save payment record
      const paymentId = await generateId('payments', 'PAY');
      const { error: payErr } = await supabase.from('payments').insert({
        id: paymentId,
        razorpay_payment_id: payment.id,
        reference_id: workshopId,
        payer_name: fields.name,
        amount: fields.amount,
        payment_mode: 'Razorpay UPI',
        type: 'income',
        category: 'workshop',
        synced_from_razorpay: true,
        date: today,
        description: `Workshop ${workshopId} — ${fields.name}`
      });

      if (payErr) {
        console.error('Error saving payment record:', payErr.message);
      }

      // 9. Success notification
      await supabase.from('notifications').insert({
        type: 'payment',
        message: `✅ New booking: ₹${fields.amount} from ${fields.name} → ${workshopId} (${matchMethod})`,
        read: false
      });

      return res.json({ received: true, routed: 'workshop', workshopId, participantIds, paymentId });
    }

    // ── PAYMENT FAILED ──
    if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      const name = payment.notes?.name || payment.customer_name || 'Unknown';
      console.log('Payment failed:', payment.id);
      await supabase.from('notifications').insert({
        type: 'warning',
        message: `⚠️ Payment failed: ₹${payment.amount / 100} from ${name} — ID ${payment.id}`,
        read: false
      });
    }

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── START ──
app.listen(PORT, () => {
  console.log(`Handpan webhook server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
