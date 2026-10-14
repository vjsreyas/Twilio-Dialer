'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');

const env = process.env;
const REQUIRED = ['APP_PASSWORD', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_TWIML_APP_SID', 'TWILIO_CALLER_ID'];
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error('Missing settings in .env: ' + missing.join(', '));
  console.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (env.APP_PASSWORD.length < 8) {
  console.error('APP_PASSWORD must be at least 8 characters. It protects your Twilio account.');
  process.exit(1);
}

const PORT = Number(env.PORT || 3000);
const MAX_CALL_SECONDS = Number(env.MAX_CALL_SECONDS || 900);
const DAILY_CAP = Number(env.DAILY_CAP_PER_NUMBER || 0);
const MONTHLY_CAP = Number(env.MONTHLY_CAP_PER_NUMBER || 0);
const WINDOW_START_MIN = Number(env.WINDOW_START_HOUR || 9) * 60;
const WINDOW_END_MIN = Number(env.WINDOW_END_HOUR || 20) * 60;
const STATS_TZ = env.STATS_TZ || 'America/Chicago';
const COST_PER_MIN = 0.018; // $0.014 outbound call + $0.004 browser leg (estimate)
// Entries may be written as +E.164 or UK national format (020..., 07..., 01...); all are stored as E.164.
const TEST_NUMBERS = new Set(String(env.TEST_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => (s.startsWith('+') ? '+' + s.replace(/\D/g, '') : normalizeUK(s))).filter(Boolean));
const DATA_FILE = env.DATA_FILE || path.join(__dirname, 'data.json');

// ---------- guards: where we are allowed to dial ----------
// Caribbean, US-territory, premium-rate and Alaska area codes carry much higher per-minute rates
// or are not covered by the plain "US & Canada" rate. Blocked by default.
const BLOCKED_AREA_CODES = new Set([
  '242', '246', '264', '268', '284', '340', '345', '441', '473', '649', '664', '670', '671',
  '684', '721', '758', '767', '784', '787', '809', '829', '849', '868', '869', '876', '939',
  '907', '900', '976',
]);

const STATE_TZ = {
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', IN: 'America/New_York', KY: 'America/New_York', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/New_York', NH: 'America/New_York',
  NJ: 'America/New_York', NY: 'America/New_York', NC: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', VT: 'America/New_York',
  VA: 'America/New_York', WV: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago', IA: 'America/Chicago',
  KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', NE: 'America/Chicago', ND: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Denver', MT: 'America/Denver',
  NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

const CLOSED_STATUSES = new Set(['interested', 'not_interested', 'wrong_number', 'dnc']);
const ANSWERED = new Set(['callback', 'interested', 'not_interested', 'wrong_number', 'dnc']);
const OUTCOMES = new Set(['no_answer', 'voicemail', 'callback', 'interested', 'not_interested', 'wrong_number', 'dnc']);

// ---------- storage (one JSON file; fine for a few thousand leads) ----------
let db = { leads: [], calls: [], dnc: [] };
if (fs.existsSync(DATA_FILE)) {
  try {
    db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    console.error('Could not read ' + DATA_FILE + ': ' + e.message);
    process.exit(1);
  }
}
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- helpers ----------
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('+')) {
    const e164 = '+' + s.replace(/\D/g, '');
    if (TEST_NUMBERS.has(e164)) return e164;
  } else {
    const uk = normalizeUK(s);
    if (uk && TEST_NUMBERS.has(uk)) return uk;
  }
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  return '+1' + d;
}

const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

function localParts(tz, date) {
  const f = partsFormatter(tz);
  const p = Object.fromEntries(f.formatToParts(date || new Date()).map((x) => [x.type, x.value]));
  let h = parseInt(p.hour, 10);
  if (h === 24) h = 0;
  return { minutes: h * 60 + parseInt(p.minute, 10), ymd: p.year + '-' + p.month + '-' + p.day };
}

function formatLocal(tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date());
}

function leadTz(lead) {
  if (lead.timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: lead.timezone }); return lead.timezone; } catch (e) { /* fall through */ }
  }
  return STATE_TZ[String(lead.state || '').toUpperCase()] || null;
}

function callsByPhone() {
  const m = new Map();
  for (const c of db.calls) {
    if (!m.has(c.phone)) m.set(c.phone, []);
    m.get(c.phone).push(c);
  }
  return m;
}

function attemptsFor(phone, tz, byPhone) {
  const now = Date.now();
  const today = tz ? localParts(tz).ymd : null;
  let total = 0, todayN = 0, month = 0;
  for (const c of (byPhone.get(phone) || [])) {
    total++;
    const t = new Date(c.startedAt);
    if (now - t.getTime() <= 30 * 24 * 3600 * 1000) month++;
    if (today && localParts(tz, t).ymd === today) todayN++;
  }
  return { total, today: todayN, month };
}

function checkLead(lead, dncSet, byPhone) {
  const out = { ok: false, reason: null, localTime: null, attempts: 0 };
  const tz = leadTz(lead);
  if (tz) out.localTime = formatLocal(tz);
  const att = attemptsFor(lead.phone, tz, byPhone);
  out.attempts = att.total;
  if (dncSet.has(lead.phone) || lead.status === 'dnc') { out.reason = 'On the do-not-call list'; return out; }
  if (CLOSED_STATUSES.has(lead.status)) { out.reason = 'Closed: ' + lead.status.replace('_', ' '); return out; }
  if (TEST_NUMBERS.has(lead.phone)) { out.ok = true; out.reason = null; return out; }
  const area = lead.phone.slice(2, 5);
  if (BLOCKED_AREA_CODES.has(area)) { out.reason = 'Area code ' + area + ' is blocked (higher rates)'; return out; }
  if (!tz) { out.reason = 'Add a state or timezone to this lead'; return out; }
  const lp = localParts(tz);
  if (lp.minutes < WINDOW_START_MIN || lp.minutes >= WINDOW_END_MIN) {
    out.reason = 'Outside calling hours (' + out.localTime + ' there)';
    return out;
  }
  if (DAILY_CAP > 0 && att.today >= DAILY_CAP) { out.reason = 'Daily limit reached (' + DAILY_CAP + ' per number)'; return out; }
  if (MONTHLY_CAP > 0 && att.month >= MONTHLY_CAP) { out.reason = 'Monthly limit reached (' + MONTHLY_CAP + ' per number)'; return out; }
  out.ok = true;
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- guest links: temporary, memory-only, locked to one number ----------
// Nothing here is written to disk. Restarting the server wipes every guest link.
const guests = new Map(); // token -> { id, number, expiresAt, maxCalls, maxSeconds, calls }
const GUEST_MAX_ACTIVE = 5;
function pruneGuests() { const now = Date.now(); for (const [t, g] of guests) if (g.expiresAt <= now) guests.delete(t); }
function guestFor(token) { pruneGuests(); return guests.get(String(token || '')) || null; }
function normalizeIntl(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('+')) return null;
  const e164 = '+' + s.replace(/\D/g, '');
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}
function maskNumber(n) { return n ? n.slice(0, 3) + ' ••• ' + n.slice(-3) : 'Guest types a UK number'; }
// UK numbers only: mobiles (07x, not pagers/personal) and ordinary 01/02 landlines. Blocks 03/08/09 and premium/special rates.
function normalizeUK(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('0044')) d = d.slice(2);
  else if (d.startsWith('0')) d = '44' + d.slice(1);
  const e164 = '+' + d;
  return /^\+44(7[1-57-9]\d{8}|[12]\d{9})$/.test(e164) ? e164 : null;
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const fails = new Map();
function auth(req, res, next) {
  const ip = req.ip;
  let f = fails.get(ip);
  if (f && f.until && f.until <= Date.now()) { fails.delete(ip); f = null; }
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
  if (safeEqual(req.get('x-app-password') || '', env.APP_PASSWORD)) { fails.delete(ip); return next(); }
  const n = ((f && f.n) || 0) + 1;
  fails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
  return res.status(401).json({ error: 'Wrong password' });
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/twilio.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', '@twilio', 'voice-sdk', 'dist', 'twilio.min.js')));
app.get('/health', (req, res) => res.json({ ok: true }));

// Twilio calls this when the browser starts a call. Signature-checked; only imported leads can be dialed.
const validateTwilio = env.INSECURE_SKIP_SIGNATURE_CHECK === '1'
  ? (req, res, next) => next()
  : (req, res, next) => {
    const sig = req.get('X-Twilio-Signature') || '';
    const url = 'https://' + req.get('host') + req.originalUrl;
    if (sig && twilio.validateRequest(env.TWILIO_AUTH_TOKEN, sig, url, req.body || {})) return next();
    console.warn('Rejected /voice request: ' + (sig ? 'Twilio signature does not match.' : 'no Twilio signature (not from Twilio).'));
    console.warn('  URL used for the check: ' + url);
    console.warn('  Fix: make TWILIO_AUTH_TOKEN in .env your real Auth Token, and make the TwiML App Voice URL exactly this address.');
    res.status(403).send('Forbidden');
  };
app.use('/voice', (req, res, next) => { console.log('/voice hit: ' + req.method + ' from ' + (req.get('user-agent') || 'unknown')); next(); });

app.post('/voice', express.urlencoded({ extended: false }), validateTwilio, (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const block = (why) => {
    console.warn('Blocked call: ' + why);
    vr.say('This call is blocked.');
    vr.hangup();
    res.type('text/xml').send(vr.toString());
  };
  // Guest test calls: dial only the one number the guest link was made for. Nothing is saved.
  const from = String(req.body.From || '');
  if (req.body.GuestToken || from.startsWith('client:guest-')) {
    const g = guestFor(req.body.GuestToken);
    if (!g || from !== 'client:guest-' + g.id) return block('invalid or expired guest link');
    if (g.calls >= g.maxCalls) return block('guest call limit reached');
    // Locked link: always the one number. Open link: the guest types a UK number, checked here.
    const dest = g.number || normalizeUK(req.body.To);
    if (!dest) return block('guest number is not an allowed UK number');
    g.calls++;
    console.log('Guest call to ' + maskNumber(dest) + ' (' + g.calls + '/' + g.maxCalls + ')');
    const gd = vr.dial({ callerId: env.TWILIO_CALLER_ID, answerOnBridge: true, timeLimit: g.maxSeconds });
    gd.number(dest);
    return res.type('text/xml').send(vr.toString());
  }
  const lead = db.leads.find((l) => l.id === req.body.LeadId);
  const phone = normalizePhone(req.body.To);
  if (!lead) return block('unknown lead');
  if (!phone || phone !== lead.phone) return block('number does not match lead');
  const c = checkLead(lead, new Set(db.dnc), callsByPhone());
  if (!c.ok) return block(c.reason);
  db.calls.push({
    id: crypto.randomUUID(), leadId: lead.id, phone, startedAt: new Date().toISOString(),
    callSid: req.body.CallSid || null, durationSec: null, outcome: null, notes: '',
  });
  save();
  const dial = vr.dial({ callerId: env.TWILIO_CALLER_ID, answerOnBridge: true, timeLimit: MAX_CALL_SECONDS });
  dial.number(phone);
  res.type('text/xml').send(vr.toString());
});

const json = express.json({ limit: '5mb' });

// ----- guest links: admin side (password) -----
app.use(['/g', '/api/guest'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.post('/api/guest/create', auth, json, (req, res) => {
  pruneGuests();
  if (guests.size >= GUEST_MAX_ACTIVE) return res.status(400).json({ error: 'Too many active guest links. Revoke one first.' });
  // number is optional: leave it empty and the guest types a UK number themselves.
  const rawNumber = String((req.body || {}).number || '').trim();
  const number = rawNumber ? normalizeIntl(rawNumber) : null;
  if (rawNumber && !number) return res.status(400).json({ error: 'Use the full international format, like +447123456789' });
  if (number && number.startsWith('+1') && BLOCKED_AREA_CODES.has(number.slice(2, 5))) return res.status(400).json({ error: 'That area code is blocked (higher rates)' });
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || d));
  const minutes = clamp(req.body.minutes, 5, 240, 30);
  const g = {
    id: crypto.randomBytes(4).toString('hex'), number, expiresAt: Date.now() + minutes * 60000,
    maxCalls: clamp(req.body.maxCalls, 1, 5, 3), maxSeconds: clamp(req.body.maxCallSeconds, 30, 600, 300), calls: 0,
  };
  const token = crypto.randomBytes(18).toString('base64url');
  guests.set(token, g);
  res.json({ token, expiresAt: g.expiresAt, masked: maskNumber(number), maxCalls: g.maxCalls, maxSeconds: g.maxSeconds });
});

app.get('/api/guest', auth, (req, res) => {
  pruneGuests();
  res.json({ guests: Array.from(guests, ([token, g]) => ({ token, masked: maskNumber(g.number), calls: g.calls, maxCalls: g.maxCalls, expiresAt: g.expiresAt })) });
});

app.delete('/api/guest/:token', auth, (req, res) => {
  res.json({ ok: guests.delete(req.params.token) });
});

// ----- guest links: guest side (the secret link is the only credential) -----
app.get('/g/:token', (req, res) => {
  if (!guestFor(req.params.token)) return res.status(404).type('text').send('This link has expired or is not valid.');
  res.sendFile(path.join(__dirname, 'guest-page.html'));
});

app.get('/api/guest/:token/info', (req, res) => {
  const g = guestFor(req.params.token);
  if (!g) return res.status(404).json({ error: 'This link has expired or is not valid.' });
  res.json({ masked: g.number ? maskNumber(g.number) : null, needsNumber: !g.number, expiresAt: g.expiresAt, callsLeft: Math.max(0, g.maxCalls - g.calls), maxSeconds: g.maxSeconds });
});

app.get('/api/guest/:token/token', (req, res) => {
  const g = guestFor(req.params.token);
  if (!g) return res.status(404).json({ error: 'This link has expired or is not valid.' });
  if (g.calls >= g.maxCalls) return res.status(403).json({ error: 'No test calls left on this link.' });
  const ttl = Math.max(60, Math.min(3600, Math.floor((g.expiresAt - Date.now()) / 1000)));
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY, env.TWILIO_API_SECRET, { identity: 'guest-' + g.id, ttl });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: env.TWILIO_TWIML_APP_SID, incomingAllow: false }));
  res.json({ token: token.toJwt() });
});

app.get('/api/token', auth, (req, res) => {
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY, env.TWILIO_API_SECRET, { identity: 'dialer', ttl: 3600 });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: env.TWILIO_TWIML_APP_SID, incomingAllow: false }));
  res.json({ token: token.toJwt() });
});

app.get('/api/state', auth, (req, res) => {
  const dnc = new Set(db.dnc);
  const byPhone = callsByPhone();
  const leads = db.leads.map((l) => {
    const c = checkLead(l, dnc, byPhone);
    return Object.assign({}, l, { callable: c.ok, reason: c.reason, localTime: c.localTime, attempts: c.attempts });
  });
  const today = localParts(STATS_TZ).ymd;
  const todays = db.calls.filter((c) => localParts(STATS_TZ, new Date(c.startedAt)).ymd === today);
  const seconds = todays.reduce((s, c) => s + (c.durationSec || 0), 0);
  res.json({
    leads,
    stats: {
      calls: todays.length,
      talkMinutes: Math.round(seconds / 6) / 10,
      estCost: Math.round(seconds / 60 * COST_PER_MIN * 100) / 100,
      interested: todays.filter((c) => c.outcome === 'interested').length,
      answered: todays.filter((c) => ANSWERED.has(c.outcome)).length,
      tz: STATS_TZ,
    },
    limits: { daily: DAILY_CAP, monthly: MONTHLY_CAP, windowStart: WINDOW_START_MIN / 60, windowEnd: WINDOW_END_MIN / 60, maxCallSeconds: MAX_CALL_SECONDS },
  });
});

app.post('/api/leads/import', auth, json, (req, res) => {
  const rows = Array.isArray(req.body.leads) ? req.body.leads : [];
  const dnc = new Set(db.dnc);
  const have = new Set(db.leads.map((l) => l.phone));
  let added = 0;
  const skipped = [];
  rows.forEach((r, i) => {
    const phone = normalizePhone(r.phone);
    const row = i + 2;
    if (!phone) return skipped.push({ row, reason: 'Invalid US/Canada phone number' });
    if (have.has(phone)) return skipped.push({ row, reason: 'Duplicate number' });
    if (dnc.has(phone)) return skipped.push({ row, reason: 'On the do-not-call list' });
    const state = String(r.state || '').trim().toUpperCase().slice(0, 2);
    const timezone = String(r.timezone || '').trim();
    if (!timezone && !STATE_TZ[state] && !TEST_NUMBERS.has(phone)) return skipped.push({ row, reason: 'Missing or unknown state (or timezone)' });
    db.leads.push({
      id: crypto.randomUUID(), name: String(r.name || '').trim().slice(0, 120), company: String(r.company || '').trim().slice(0, 120),
      phone, state, timezone, notes: String(r.notes || '').trim().slice(0, 500), status: 'new', createdAt: new Date().toISOString(),
    });
    have.add(phone);
    added++;
  });
  save();
  res.json({ added, skipped });
});

app.post('/api/calls/outcome', auth, json, (req, res) => {
  const { callSid, leadId, outcome, durationSec, notes } = req.body || {};
  if (!OUTCOMES.has(outcome)) return res.status(400).json({ error: 'Unknown outcome' });
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead) return res.status(404).json({ error: 'Unknown lead' });
  let call = callSid ? db.calls.find((c) => c.callSid === callSid) : null;
  if (!call) call = db.calls.slice().reverse().find((c) => c.leadId === leadId && !c.outcome);
  if (!call) {
    call = { id: crypto.randomUUID(), leadId, phone: lead.phone, startedAt: new Date().toISOString(), callSid: callSid || null };
    db.calls.push(call);
  }
  call.outcome = outcome;
  call.durationSec = Math.max(0, Math.min(Number(durationSec) || 0, MAX_CALL_SECONDS + 60));
  call.notes = String(notes || '').slice(0, 1000);
  lead.status = outcome;
  if (outcome === 'dnc' && !db.dnc.includes(lead.phone)) db.dnc.push(lead.phone);
  save();
  res.json({ ok: true });
});

app.get('/api/export.csv', auth, (req, res) => {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['started_at', 'name', 'company', 'phone', 'outcome', 'duration_sec', 'call_sid', 'notes'].join(',')];
  for (const c of db.calls) {
    const l = db.leads.find((x) => x.id === c.leadId) || {};
    lines.push([c.startedAt, l.name, l.company, c.phone, c.outcome, c.durationSec, c.callSid, c.notes].map(q).join(','));
  }
  res.type('text/csv').send(lines.join('\n'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log('Dialer running on http://localhost:' + PORT);
  console.log('Next: expose it over https (see README) and set the TwiML App Voice URL to https://YOUR-URL/voice');
});
