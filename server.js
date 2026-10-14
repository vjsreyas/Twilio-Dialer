'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');
const Phone = require('./public/phone.js');

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
// Twilio's own ceiling is 4 hours. Set MAX_CALL_SECONDS lower if you want a safety cut-off.
const MAX_CALL_SECONDS = Math.min(14400, Number(env.MAX_CALL_SECONDS || 14400));
const DATA_FILE = env.DATA_FILE || path.join(__dirname, 'data.json');

const OUTCOMES = new Set(['no_answer', 'hung_up', 'not_interested', 'potential', 'meeting']);

// ---------- storage (one JSON file; fine for a few thousand leads) ----------
let db = { leads: [], calls: [] };
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
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
function leadFields(r) {
  return {
    name: clean(r.name, 120), company: clean(r.company, 120), country: clean(r.country, 60),
    email: clean(r.email, 160), notes: clean(r.notes, 1000),
  };
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
// Open guest links (guest types the number): UK mobiles (07x) and ordinary 01/02 landlines only.
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

// Twilio calls these. Signature-checked so only Twilio can trigger a dial.
const validateTwilio = env.INSECURE_SKIP_SIGNATURE_CHECK === '1'
  ? (req, res, next) => next()
  : (req, res, next) => {
    const sig = req.get('X-Twilio-Signature') || '';
    const url = 'https://' + req.get('host') + req.originalUrl;
    if (sig && twilio.validateRequest(env.TWILIO_AUTH_TOKEN, sig, url, req.body || {})) return next();
    console.warn('Rejected ' + req.path + ' request: ' + (sig ? 'Twilio signature does not match.' : 'no Twilio signature (not from Twilio).'));
    console.warn('  URL used for the check: ' + url);
    console.warn('  Fix: make TWILIO_AUTH_TOKEN in .env your real Auth Token, and make the TwiML App Voice URL exactly https://YOUR-URL/voice');
    res.status(403).send('Forbidden');
  };
const twilioForm = express.urlencoded({ extended: false });

app.post('/voice', twilioForm, validateTwilio, (req, res) => {
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
    const dest = g.number || normalizeUK(req.body.To);
    if (!dest) return block('guest number is not an allowed UK number');
    g.calls++;
    console.log('Guest call to ' + maskNumber(dest) + ' (' + g.calls + '/' + g.maxCalls + ')');
    const gd = vr.dial({ callerId: env.TWILIO_CALLER_ID, answerOnBridge: true, timeLimit: g.maxSeconds });
    gd.number(dest);
    return res.type('text/xml').send(vr.toString());
  }
  // Main dialer: the number must belong to a saved lead (any country).
  const lead = db.leads.find((l) => l.id === req.body.LeadId);
  if (!lead) return block('unknown lead');
  if (Phone.normalize(req.body.To) !== lead.phone) return block('number does not match lead');
  db.calls.push({
    id: crypto.randomUUID(), leadId: lead.id, name: lead.name, company: lead.company, phone: lead.phone,
    startedAt: new Date().toISOString(), callSid: req.body.CallSid || null,
    dialStatus: null, talkSec: null, durationSec: null, outcome: null, notes: '',
  });
  save();
  const dial = vr.dial({ callerId: env.TWILIO_CALLER_ID, answerOnBridge: true, timeLimit: MAX_CALL_SECONDS, action: '/voice/status', method: 'POST' });
  dial.number(lead.phone);
  res.type('text/xml').send(vr.toString());
});

// Twilio posts here when the dialed leg ends: real answered/no-answer/busy status and billed talk seconds.
app.post('/voice/status', twilioForm, validateTwilio, (req, res) => {
  const c = req.body.CallSid ? db.calls.find((x) => x.callSid === req.body.CallSid) : null;
  if (c) {
    c.dialStatus = String(req.body.DialCallStatus || '') || null;
    c.talkSec = Math.max(0, Number(req.body.DialCallDuration) || 0);
    c.endedAt = new Date().toISOString();
    save();
  }
  res.type('text/xml').send(new twilio.twiml.VoiceResponse().toString());
});

const json = express.json({ limit: '20mb' });

// ----- guest links: admin side (password) -----
app.use(['/g', '/api/guest'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.post('/api/guest/create', auth, json, (req, res) => {
  pruneGuests();
  if (guests.size >= GUEST_MAX_ACTIVE) return res.status(400).json({ error: 'Too many active guest links. Revoke one first.' });
  // number is optional: leave it empty and the guest types a UK number themselves.
  const rawNumber = String((req.body || {}).number || '').trim();
  const number = rawNumber ? normalizeIntl(rawNumber) : null;
  if (rawNumber && !number) return res.status(400).json({ error: 'Use the full international format, like +447123456789' });
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

// ----- main app -----
app.get('/api/token', auth, (req, res) => {
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY, env.TWILIO_API_SECRET, { identity: 'dialer', ttl: 3600 });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: env.TWILIO_TWIML_APP_SID, incomingAllow: false }));
  res.json({ token: token.toJwt() });
});

app.get('/api/state', auth, (req, res) => {
  const byLead = new Map();
  for (const c of db.calls) {
    const s = byLead.get(c.leadId) || { attempts: 0, lastCallAt: null };
    s.attempts++;
    if (!s.lastCallAt || c.startedAt > s.lastCallAt) s.lastCallAt = c.startedAt;
    byLead.set(c.leadId, s);
  }
  const leads = db.leads.map((l) => Object.assign({ status: 'new' }, l, byLead.get(l.id) || { attempts: 0, lastCallAt: null }));
  res.json({ leads });
});

app.post('/api/leads/import', auth, json, (req, res) => {
  const rows = Array.isArray(req.body.leads) ? req.body.leads : [];
  const code = req.body.defaultCode;
  const have = new Set(db.leads.map((l) => l.phone));
  let added = 0;
  const skipped = [];
  rows.forEach((r, i) => {
    const row = Number(r.row) || i + 1;
    const f = leadFields(r);
    const phone = Phone.normalize(r.phone, code);
    if (!f.name) return skipped.push({ row, reason: 'Missing name' });
    if (!phone) return skipped.push({ row, reason: 'Invalid number' });
    if (have.has(phone)) return skipped.push({ row, reason: 'Already in your leads' });
    db.leads.push(Object.assign({ id: crypto.randomUUID() }, f, { phone, status: 'new', createdAt: new Date().toISOString() }));
    have.add(phone);
    added++;
  });
  if (added) save();
  res.json({ added, skipped });
});

app.patch('/api/leads/:id', auth, json, (req, res) => {
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const b = req.body || {};
  const f = leadFields(Object.assign({}, lead, b));
  if (!f.name) return res.status(400).json({ error: 'Name is required' });
  if (b.phone != null) {
    const phone = Phone.normalize(b.phone, b.defaultCode);
    if (!phone) return res.status(400).json({ error: 'That number is not valid. Include the country code, like +44...' });
    if (phone !== lead.phone && db.leads.some((l) => l.phone === phone)) return res.status(400).json({ error: 'Another lead already has that number' });
    lead.phone = phone;
  }
  Object.assign(lead, f);
  save();
  res.json({ ok: true });
});

app.post('/api/leads/delete', auth, json, (req, res) => {
  const ids = new Set(Array.isArray(req.body.ids) ? req.body.ids : []);
  const before = db.leads.length;
  db.leads = db.leads.filter((l) => !ids.has(l.id)); // call log entries are kept
  save();
  res.json({ deleted: before - db.leads.length });
});

// Newest first. Filters: leadId, since (ISO time), limit.
app.get('/api/calls', auth, (req, res) => {
  const since = req.query.since ? Date.parse(String(req.query.since)) : NaN;
  const leadId = req.query.leadId ? String(req.query.leadId) : null;
  const limit = Math.min(20000, Number(req.query.limit) || 5000);
  const leads = new Map(db.leads.map((l) => [l.id, l]));
  const calls = [];
  for (let i = db.calls.length - 1; i >= 0 && calls.length < limit; i--) {
    const c = db.calls[i];
    if (leadId && c.leadId !== leadId) continue;
    if (!Number.isNaN(since) && Date.parse(c.startedAt) < since) continue;
    const l = leads.get(c.leadId);
    calls.push(Object.assign({}, c, { name: (l && l.name) || c.name || '', company: (l && l.company) || c.company || '', leadExists: !!l }));
  }
  res.json({ calls });
});

app.post('/api/calls/outcome', auth, json, (req, res) => {
  const { callSid, leadId, outcome, durationSec, notes } = req.body || {};
  if (!OUTCOMES.has(outcome)) return res.status(400).json({ error: 'Unknown outcome' });
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead) return res.status(404).json({ error: 'Unknown lead' });
  let call = callSid ? db.calls.find((c) => c.callSid === callSid) : null;
  if (!call) call = db.calls.slice().reverse().find((c) => c.leadId === leadId && !c.outcome);
  if (!call) {
    call = { id: crypto.randomUUID(), leadId, name: lead.name, company: lead.company, phone: lead.phone, startedAt: new Date().toISOString(), callSid: callSid || null };
    db.calls.push(call);
  }
  call.outcome = outcome;
  call.durationSec = Math.max(0, Math.min(Number(durationSec) || 0, MAX_CALL_SECONDS + 60));
  call.notes = clean(notes, 2000);
  lead.status = outcome;
  save();
  res.json({ ok: true });
});

// Fix an outcome or add a note to a call later (from the Call log tab).
app.patch('/api/calls/:id', auth, json, (req, res) => {
  const call = db.calls.find((c) => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  const b = req.body || {};
  if (b.outcome != null) {
    if (!OUTCOMES.has(b.outcome)) return res.status(400).json({ error: 'Unknown outcome' });
    call.outcome = b.outcome;
    const lead = db.leads.find((l) => l.id === call.leadId);
    const latest = db.calls.slice().reverse().find((c) => c.leadId === call.leadId);
    if (lead && latest === call) lead.status = b.outcome;
  }
  if (b.notes != null) call.notes = clean(b.notes, 2000);
  save();
  res.json({ ok: true });
});

app.get('/api/export.csv', auth, (req, res) => {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const leads = new Map(db.leads.map((l) => [l.id, l]));
  const lines = [['started_at', 'name', 'company', 'phone', 'line_status', 'talk_sec', 'outcome', 'notes', 'call_sid'].join(',')];
  for (const c of db.calls) {
    const l = leads.get(c.leadId) || {};
    const talk = c.talkSec != null ? c.talkSec : c.durationSec;
    lines.push([c.startedAt, l.name || c.name, l.company || c.company, c.phone, c.dialStatus, talk, c.outcome, c.notes, c.callSid].map(q).join(','));
  }
  res.type('text/csv').send(lines.join('\n'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'That list is too big to send at once. Split it in two.' : 'Server error' });
});

app.listen(PORT, () => {
  console.log('Dialer running on http://localhost:' + PORT);
  console.log('Next: expose it over https (see README) and set the TwiML App Voice URL to https://YOUR-URL/voice');
});
