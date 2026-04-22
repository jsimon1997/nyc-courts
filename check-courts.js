#!/usr/bin/env node
/**
 * Phone-agent runner.
 *
 * For each facility listed in facilities-to-call.json, dials the phone number
 * stored in courts-db.json via Retell AI, asks about court availability for
 * the upcoming Saturday & Sunday, and appends the structured result (plus
 * transcript) to data/availability.json.
 *
 * Requires env vars: RETELL_API_KEY, RETELL_AGENT_ID, RETELL_FROM_NUMBER.
 */

const fs   = require('fs');
const path = require('path');

const ROOT        = __dirname;
const COURTS_DB   = path.join(ROOT, 'courts-db.json');
const TARGETS     = path.join(ROOT, 'facilities-to-call.json');
const OUTPUT_DIR  = path.join(ROOT, 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'availability.json');

const RETELL_BASE         = 'https://api.retellai.com';
const POLL_INTERVAL_MS    = 15_000;
const POLL_TIMEOUT_MS     = 20 * 60 * 1000;
const DEDUPE_WINDOW_HOURS = 12; // skip a facility if it was called within this many hours

// --- date helpers ----------------------------------------------------------

function nextWeekendNY() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const todayNY = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  let daysToSat = (6 - dow + 7) % 7;
  if (daysToSat === 0) daysToSat = 7; // always *upcoming* weekend, never today
  const sat = new Date(todayNY.getTime() + daysToSat * 86_400_000);
  const sun = new Date(sat.getTime() + 86_400_000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { saturday: iso(sat), sunday: iso(sun) };
}

// --- phone normalization ---------------------------------------------------

function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  throw new Error(`cannot normalize phone: ${raw}`);
}

// --- IO --------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function appendResult(record) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const current = fs.existsSync(OUTPUT_FILE) ? readJson(OUTPUT_FILE) : [];
  current.push(record);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(current, null, 2) + '\n', 'utf8');
}

function recentlyCalled(records, facilityId, nowMs) {
  const cutoff = nowMs - DEDUPE_WINDOW_HOURS * 60 * 60 * 1000;
  return records.some((r) => {
    if (r.facility_id !== facilityId) return false;
    const t = Date.parse(r.batch_timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
}

// --- Retell API ------------------------------------------------------------

async function retell(endpoint, { method = 'GET', body, apiKey } = {}) {
  const res = await fetch(`${RETELL_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Retell ${method} ${endpoint} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function createCall({ apiKey, agentId, fromNumber, toNumber, vars }) {
  const out = await retell('/v2/create-phone-call', {
    method: 'POST',
    apiKey,
    body: {
      from_number: fromNumber,
      to_number: toNumber,
      override_agent_id: agentId,
      retell_llm_dynamic_variables: vars,
    },
  });
  return out.call_id;
}

async function waitForCall({ apiKey, callId }) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const call = await retell(`/v2/get-call/${callId}`, { apiKey });
    if (call.call_status === 'ended' && call.call_analysis) return call;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`call ${callId} did not complete within ${POLL_TIMEOUT_MS / 1000}s`);
}

// --- main ------------------------------------------------------------------

async function main() {
  const apiKey     = process.env.RETELL_API_KEY;
  const agentId    = process.env.RETELL_AGENT_ID;
  const fromNumber = process.env.RETELL_FROM_NUMBER;
  if (!apiKey || !agentId || !fromNumber) {
    throw new Error('missing one of: RETELL_API_KEY, RETELL_AGENT_ID, RETELL_FROM_NUMBER');
  }

  const { facility_ids } = readJson(TARGETS);
  const courts           = readJson(COURTS_DB);
  const byId             = new Map(courts.map((c) => [c.id, c]));

  const existingRecords = fs.existsSync(OUTPUT_FILE) ? readJson(OUTPUT_FILE) : [];
  const { saturday, sunday } = nextWeekendNY();
  const batchTs = new Date().toISOString();
  const nowMs   = Date.now();

  console.log(`Batch ${batchTs} — target weekend: ${saturday} / ${sunday}`);

  let errors = 0;

  for (const id of facility_ids) {
    const facility = byId.get(id);
    if (!facility) {
      console.warn(`[skip] unknown id ${id}`);
      continue;
    }
    const { name, phone } = facility;
    if (!phone) {
      console.warn(`[skip] ${name}: no phone number in courts-db.json`);
      continue;
    }
    if (recentlyCalled(existingRecords, id, nowMs)) {
      console.log(`[skip] ${name}: called within last ${DEDUPE_WINDOW_HOURS}h`);
      continue;
    }

    let toNumber;
    try {
      toNumber = toE164(phone);
    } catch (e) {
      console.warn(`[skip] ${name}: ${e.message}`);
      continue;
    }

    console.log(`[call] ${name} → ${toNumber}`);
    const record = {
      batch_timestamp: batchTs,
      facility_id: id,
      facility_name: name,
      phone: toNumber,
      target_saturday: saturday,
      target_sunday: sunday,
    };

    try {
      const callId = await createCall({
        apiKey, agentId, fromNumber, toNumber,
        vars: { facility_name: name, saturday_date: saturday, sunday_date: sunday },
      });
      const call     = await waitForCall({ apiKey, callId });
      const analysis = call.call_analysis || {};
      Object.assign(record, {
        call_id:              call.call_id,
        call_status:          call.call_status,
        disconnection_reason: call.disconnection_reason || null,
        duration_ms:          call.duration_ms || null,
        call_summary:         analysis.call_summary || null,
        user_sentiment:       analysis.user_sentiment || null,
        custom_analysis_data: analysis.custom_analysis_data || null,
        transcript:           call.transcript || null,
      });
      console.log(`[done] ${name}`);
    } catch (e) {
      record.error = e.message;
      errors += 1;
      console.error(`[error] ${name}: ${e.message}`);
    }

    appendResult(record);
  }

  if (errors > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
