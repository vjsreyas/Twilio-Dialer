'use strict';
/* global Twilio, Phone */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const OUTCOMES = [
  { k: 'no_answer', label: 'No answer', key: '1' },
  { k: 'hung_up', label: 'Hung up', key: '2' },
  { k: 'not_interested', label: 'Not interested', key: '3' },
  { k: 'potential', label: 'Potential', key: '4' },
  { k: 'meeting', label: 'Meeting booked', key: '5' },
];
const LABELS = {
  new: 'New', no_answer: 'No answer', hung_up: 'Hung up', not_interested: 'Not interested', potential: 'Potential', meeting: 'Meeting booked',
  // outcomes saved by the previous version of the app
  voicemail: 'Voicemail', callback: 'Callback', interested: 'Interested', wrong_number: 'Wrong number', dnc: 'Do not call',
};
const LINE = { completed: 'Answered', 'no-answer': 'No answer', busy: 'Busy', failed: 'Failed', canceled: 'Cancelled' };
const TO_CALL = new Set(['new', 'no_answer', 'callback', 'voicemail']);
const QUEUE_FILTERS = [['tocall', 'To call'], ['all', 'All leads'], ['new', 'New'], ['potential', 'Potential'], ['meeting', 'Meeting booked'], ['no_answer', 'No answer'], ['hung_up', 'Hung up'], ['not_interested', 'Not interested']];
const US_ZONES = [['America/New_York', 'US East'], ['America/Chicago', 'US Central'], ['America/Denver', 'US Mountain'], ['America/Los_Angeles', 'US West']];
const QUEUE_LIMIT = 300;
const TABLE_LIMIT = 500;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};

const S = {
  pw: '', leads: [], today: [], log: [], history: [],
  current: null, editing: false,
  device: null, call: null, callLead: null, phase: 'idle', // idle | calling | ringing | live | wrap
  startedAt: null, tick: null, lastCall: null, saving: false,
  qFilter: store.get('dialerQFilter', 'tocall'), qSearch: '',
  selected: new Set(), editingCallId: null,
};
try { S.pw = sessionStorage.getItem('dialerPw') || ''; } catch (e) { /* ignore */ }

// ---------- small helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach((c) => c != null && el.append(c));
  return el;
}
let toastT;
function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || 4200);
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const hh = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function fmtWhen(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'Today ' + time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday ' + time;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ' ' + time;
}
const talkOf = (c) => (c.talkSec != null ? c.talkSec : (c.durationSec || 0));
const isAnswered = (c) => (c.dialStatus ? c.dialStatus === 'completed' && talkOf(c) > 0 : talkOf(c) > 0);
function startOfDay(daysAgo) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (daysAgo || 0)); return d.toISOString(); }
function download(name, text, type) { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove(); }
function fillSelect(sel, opts, value) { sel.replaceChildren(...opts.map(([v, t]) => h('option', { value: v, text: t }))); if (value != null) sel.value = value; }
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg || 'Copied.'); return true; } catch (e) { toast('Could not copy. Select it and copy by hand.'); return false; }
}

// ---------- api ----------
async function api(path, opts = {}) {
  const headers = Object.assign({ 'x-app-password': S.pw }, opts.body ? { 'content-type': 'application/json' } : {}, opts.headers || {});
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  if (r.status === 401) { showLogin('Wrong password'); throw new Error('Not signed in'); }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
  return r;
}
const getJSON = async (path, opts) => (await api(path, opts)).json();
const postJSON = (path, body, method) => getJSON(path, { method: method || 'POST', body: JSON.stringify(body) });

// ---------- login ----------
function showLogin(msg) {
  $('#app').hidden = true; $('#login').hidden = false; $('#loginErr').textContent = msg || ''; S.pw = '';
  try { sessionStorage.removeItem('dialerPw'); } catch (e) { /* ignore */ }
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); S.pw = $('#pw').value; $('#loginErr').textContent = '';
  try {
    await api('/api/state');
    try { sessionStorage.setItem('dialerPw', S.pw); } catch (e2) { /* ignore */ }
    start();
  } catch (err) { if (err.message !== 'Not signed in') $('#loginErr').textContent = err.message; }
});
$('#signOut').addEventListener('click', () => { if (S.call) { toast('Hang up first.'); return; } showLogin(''); });

let started = false;
async function start() {
  $('#login').hidden = true; $('#app').hidden = false;
  if (started) { refresh(); return; }
  started = true;
  setupStatic();
  showTab(store.get('dialerTab', 'dialer'));
  await refresh();
  initDevice();
  setInterval(() => { if (S.phase === 'idle' && !S.editing) refresh(); }, 60000);
}

// ---------- tabs and clocks ----------
function showTab(name) {
  if (!$('#tab-' + name)) name = 'dialer';
  $$('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + name; });
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  store.set('dialerTab', name);
  if (name === 'leads') renderLeadsTable();
  if (name === 'log') loadLog();
  if (name === 'guest') loadGuests();
}
$$('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.addEventListener('click', (e) => { const a = e.target.closest('[data-goto]'); if (a) { e.preventDefault(); showTab(a.dataset.goto); } });

const clockFmt = {};
function clockText(tz) {
  clockFmt[tz] = clockFmt[tz] || new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return clockFmt[tz].format(new Date());
}
function drawClocks() {
  $('#ckUK').textContent = clockText('Europe/London');
  $('#ckUS').textContent = clockText($('#usZone').value);
  $('#ckIN').textContent = clockText('Asia/Kolkata');
}

function setupStatic() {
  fillSelect($('#usZone'), US_ZONES, store.get('dialerUsZone', 'America/New_York'));
  $('#usZone').addEventListener('change', () => { store.set('dialerUsZone', $('#usZone').value); drawClocks(); });
  drawClocks(); setInterval(drawClocks, 10000);

  fillSelect($('#qFilter'), QUEUE_FILTERS, S.qFilter);
  fillSelect($('#lFilter'), [['all', 'All statuses']].concat(Object.entries(LABELS).slice(0, 6)), 'all');
  fillSelect($('#logOutcome'), [['all', 'All outcomes'], ['answered', 'Answered only'], ['none', 'Not logged']].concat(OUTCOMES.map((o) => [o.k, o.label])), 'all');
  const countries = [['', 'No default (need +code)']].concat(Phone.COUNTRIES.map(([c, n]) => [c, n + ' (+' + c + ')']));
  fillSelect($('#defCode'), countries, store.get('dialerDefCode', '44'));

  $('#keypad').append(...'123456789*0#'.split('').map((d) => h('button', { type: 'button', text: d, onclick: () => sendDigit(d) })));
  $('#outcomes').append(...OUTCOMES.map((o) => h('button', { type: 'button', class: 'oc', 'data-k': o.k, onclick: () => saveOutcome(o.k) }, o.label, h('small', { text: 'key ' + o.key }))));
}

// ---------- data ----------
async function refresh() {
  let st, today;
  try { [st, today] = await Promise.all([getJSON('/api/state'), getJSON('/api/calls?since=' + encodeURIComponent(startOfDay()))]); } catch (e) { return; }
  S.leads = st.leads; S.today = today.calls;
  if (S.current) S.current = S.leads.find((l) => l.id === S.current.id) || null;
  $('#leadCount').textContent = S.leads.length;
  renderStats(); renderQueue(); renderLead();
  if (!$('#tab-leads').hidden) { renderLeadsTable(); analyse(); }
}

function renderStats() {
  const c = S.today;
  const goal = Math.max(1, parseInt(store.get('dialerGoal', '30'), 10) || 30);
  $('#tCalls').textContent = c.length;
  if (document.activeElement !== $('#goalIn')) $('#goalIn').value = goal;
  $('#gFill').style.width = Math.min(100, Math.round(c.length / goal * 100)) + '%';
  $('#gBar').classList.toggle('done', c.length >= goal);
  $('#gBar').setAttribute('aria-valuemax', goal); $('#gBar').setAttribute('aria-valuenow', Math.min(goal, c.length));
  $('#tAns').textContent = c.filter(isAnswered).length;
  $('#tTalk').textContent = fmtDur(c.reduce((s, x) => s + talkOf(x), 0));
  $('#tPot').textContent = c.filter((x) => x.outcome === 'potential').length;
  $('#tMeet').textContent = c.filter((x) => x.outcome === 'meeting').length;
}
$('#goalIn').addEventListener('change', (e) => {
  const g = Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 30));
  store.set('dialerGoal', String(g)); renderStats();
});

// ---------- queue ----------
function matchLead(l, q) {
  if (!q) return true;
  const qd = q.replace(/\D/g, '');
  return [l.name, l.company, l.country, l.email, l.phone].some((v) => String(v || '').toLowerCase().includes(q)) || (qd.length >= 3 && l.phone.includes(qd));
}
function queueLeads() {
  const f = S.qFilter, q = S.qSearch.trim().toLowerCase();
  return S.leads
    .filter((l) => (f === 'all' ? true : f === 'tocall' ? TO_CALL.has(l.status) : l.status === f) && matchLead(l, q))
    .sort((a, b) => (a.attempts - b.attempts) || String(a.lastCallAt || '').localeCompare(String(b.lastCallAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}
function renderQueue() {
  const list = queueLeads(), box = $('#qList');
  $('#qMeta').textContent = list.length + (list.length === 1 ? ' lead' : ' leads') + (S.qFilter === 'tocall' ? ' to call' : '');
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'empty', text: S.leads.length ? 'Nothing matches.' : 'No leads yet. Add some in the Leads tab.' }));
    return;
  }
  const items = list.slice(0, QUEUE_LIMIT).map((l) => h('button', {
    class: 'q-item', type: 'button', 'aria-current': String(!!S.current && S.current.id === l.id), onclick: () => pick(l.id),
  },
  h('span', { class: 'n', text: l.name || l.phone }),
  h('span', { class: 'badge', 'data-s': l.status, text: LABELS[l.status] || l.status }),
  h('span', { class: 's', text: [l.phone, l.company, l.country || Phone.countryOf(l.phone)].filter(Boolean).join(' · ') })));
  if (list.length > QUEUE_LIMIT) items.push(h('div', { class: 'q-more', text: 'Showing ' + QUEUE_LIMIT + ' of ' + list.length + '. Search to narrow down.' }));
  box.replaceChildren(...items);
  const cur = box.querySelector('[aria-current=true]');
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}
$('#qSearch').addEventListener('input', (e) => { S.qSearch = e.target.value; renderQueue(); });
$('#qFilter').addEventListener('change', (e) => { S.qFilter = e.target.value; store.set('dialerQFilter', S.qFilter); renderQueue(); });

function busyMsg() {
  if (S.phase === 'wrap') return 'Pick an outcome (or Skip logging) first.';
  if (S.phase !== 'idle') return 'Finish the current call first.';
  return null;
}
function pick(id) {
  const m = busyMsg(); if (m) { toast(m); return; }
  S.current = S.leads.find((l) => l.id === id) || null;
  S.editing = false; $('#editForm').hidden = true;
  renderQueue(); renderLead(); loadHistory();
}
function nextLeadId() {
  const list = queueLeads();
  if (!list.length) return null;
  const i = S.current ? list.findIndex((l) => l.id === S.current.id) : -1;
  const n = list[i + 1] || list.find((l) => !S.current || l.id !== S.current.id);
  return n ? n.id : null;
}
function nextLead() {
  const m = busyMsg(); if (m) { toast(m); return; }
  const id = nextLeadId();
  if (!id) { toast('No more leads in this list.'); return; }
  pick(id);
}
$('#nextBtn').addEventListener('click', nextLead);
$('#startBtn').addEventListener('click', nextLead);

// ---------- lead panel ----------
function renderLead() {
  const l = S.current;
  $('#emptyLead').hidden = !!l; $('#leadView').hidden = !l;
  if (!l) return;
  $('#lName').textContent = l.name || 'No name';
  $('#lCompany').textContent = l.company || ''; $('#lCompany').hidden = !l.company;
  $('#lStatus').textContent = LABELS[l.status] || l.status; $('#lStatus').dataset.s = l.status;
  $('#lPhone').textContent = l.phone;
  $('#lCountry').textContent = l.country || Phone.countryOf(l.phone) || '—';
  $('#lEmail').textContent = l.email || '—';
  $('#lAttempts').textContent = l.attempts || 0;
  $('#lLast').textContent = l.lastCallAt ? fmtWhen(l.lastCallAt) : 'Never';
  $('#lNotes').hidden = !l.notes; $('#lNotes').textContent = l.notes || '';
  renderCallBar();
}
function setPhase(p) { S.phase = p; renderCallBar(); }
function renderCallBar() {
  const p = S.phase, inCall = p === 'calling' || p === 'ringing' || p === 'live';
  $('#idleBar').hidden = p !== 'idle';
  $('#inCall').hidden = !inCall;
  $('#wrap').hidden = p !== 'wrap';
  $('#callState').textContent = { calling: 'Calling…', ringing: 'Ringing…', live: 'Connected' }[p] || '';
  $('#callBtn').disabled = !S.device;
  $('#editBtn').disabled = $('#delBtn').disabled = p !== 'idle';
}

function renderHistory() {
  const box = $('#history');
  if (!S.history.length) { box.replaceChildren(h('div', { class: 'empty', text: 'No calls yet.' })); return; }
  box.replaceChildren(...S.history.map((c) => h('div', { class: 'h-item' },
    h('span', { class: 'h-when', text: fmtWhen(c.startedAt) }),
    h('span', { class: 'h-meta', text: [c.dialStatus ? LINE[c.dialStatus] || c.dialStatus : null, talkOf(c) ? fmtDur(talkOf(c)) + ' talk' : null].filter(Boolean).join(' · ') }),
    c.outcome ? h('span', { class: 'badge', 'data-s': c.outcome, text: LABELS[c.outcome] || c.outcome }) : h('span', { class: 'badge', text: 'Not logged' }),
    c.notes ? h('span', { class: 'h-note', text: c.notes }) : null)));
}
async function loadHistory() {
  const l = S.current; if (!l) return;
  try {
    const r = await getJSON('/api/calls?leadId=' + encodeURIComponent(l.id));
    if (S.current && S.current.id === l.id) { S.history = r.calls; renderHistory(); }
  } catch (e) { /* keep old */ }
}

$('#copyBtn').addEventListener('click', () => S.current && copyText(S.current.phone, 'Number copied.'));
$('#editBtn').addEventListener('click', () => {
  const l = S.current; if (!l || S.phase !== 'idle') return;
  S.editing = true; $('#editForm').hidden = false;
  $('#eName').value = l.name || ''; $('#ePhone').value = l.phone; $('#eCompany').value = l.company || '';
  $('#eCountry').value = l.country || ''; $('#eEmail').value = l.email || ''; $('#eNotes').value = l.notes || '';
  $('#eName').focus();
});
$('#editCancel').addEventListener('click', () => { S.editing = false; $('#editForm').hidden = true; });
$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const l = S.current; if (!l) return;
  try {
    await postJSON('/api/leads/' + encodeURIComponent(l.id), {
      name: $('#eName').value, phone: $('#ePhone').value, company: $('#eCompany').value,
      country: $('#eCountry').value, email: $('#eEmail').value, notes: $('#eNotes').value, defaultCode: $('#defCode').value,
    }, 'PATCH');
    S.editing = false; $('#editForm').hidden = true; toast('Lead saved.'); await refresh();
  } catch (err) { toast(err.message); }
});
$('#delBtn').addEventListener('click', async () => {
  const l = S.current; if (!l || S.phase !== 'idle') return;
  if (!confirm('Delete ' + (l.name || l.phone) + '? Their calls stay in the call log.')) return;
  const next = nextLeadId();
  try {
    await postJSON('/api/leads/delete', { ids: [l.id] });
    S.current = null; await refresh();
    if (next && next !== l.id) pick(next);
    toast('Lead deleted.');
  } catch (err) { toast(err.message); }
});

// ---------- phone line ----------
async function initDevice() {
  const line = (s, t) => { $('#line').dataset.s = s; $('#lineTxt').textContent = t; };
  try {
    const { token } = await getJSON('/api/token');
    S.device = new Twilio.Device(token, { logLevel: 1, codecPreferences: ['opus', 'pcmu'], closeProtection: true });
    S.device.on('error', (e) => toast(e.message || 'Phone line error'));
    S.device.on('tokenWillExpire', async () => { try { S.device.updateToken((await getJSON('/api/token')).token); } catch (e) { line('bad', 'Reconnect needed'); } });
    line('ok', 'Line ready');
  } catch (e) { line('bad', 'Line not connected'); toast(e.message); }
  renderCallBar();
}

async function startCall() {
  const l = S.current;
  if (!l || S.phase !== 'idle') return;
  if (!S.device) { toast('Phone line is not connected yet.'); return; }
  S.editing = false; $('#editForm').hidden = true;
  S.callLead = l; S.startedAt = null; $('#timer').textContent = '00:00';
  setPhase('calling');
  try {
    const call = await S.device.connect({ params: { To: l.phone, LeadId: l.id } });
    S.call = call;
    call.on('ringing', () => { if (S.phase === 'calling') setPhase('ringing'); });
    call.on('accept', () => { S.startedAt = Date.now(); setPhase('live'); S.tick = setInterval(drawTimer, 500); drawTimer(); });
    ['disconnect', 'cancel', 'reject'].forEach((ev) => call.on(ev, endCall));
    call.on('error', (e) => { toast(e.message || 'Call error'); endCall(); });
  } catch (e) {
    toast(e.message || 'Could not start the call'); S.call = null; setPhase('idle');
  }
}
function drawTimer() {
  if (!S.startedAt) return;
  const s = Math.floor((Date.now() - S.startedAt) / 1000);
  $('#timer').textContent = fmtDur(s).padStart(5, '0');
}
function sidOf(c) { return c ? ((c.parameters && c.parameters.CallSid) || c.outboundConnectionId || null) : null; }
function endCall() {
  if (S.phase === 'idle' || S.phase === 'wrap') return;
  clearInterval(S.tick);
  const dur = S.startedAt ? Math.round((Date.now() - S.startedAt) / 1000) : 0;
  S.lastCall = { sid: sidOf(S.call), leadId: S.callLead.id, durationSec: dur };
  S.call = null; setMute(false); togglePad(false);
  $('#wrapTitle').textContent = S.startedAt ? 'Call ended · ' + fmtDur(dur) : 'Not answered';
  $('#wrapNotes').value = '';
  $$('#outcomes .oc').forEach((b) => { b.disabled = false; b.classList.toggle('suggest', !S.startedAt && b.dataset.k === 'no_answer'); });
  setPhase('wrap');
  loadHistory();
}
async function saveOutcome(k) {
  if (S.phase !== 'wrap' || !S.lastCall || S.saving) return;
  S.saving = true; $$('#outcomes .oc').forEach((b) => { b.disabled = true; });
  const cur = S.current;
  const sameLead = cur && cur.id === S.lastCall.leadId;
  const next = sameLead ? nextLeadId() : null;
  try {
    await postJSON('/api/calls/outcome', { callSid: S.lastCall.sid, leadId: S.lastCall.leadId, outcome: k, durationSec: S.lastCall.durationSec, notes: $('#wrapNotes').value });
    S.lastCall = null; setPhase('idle');
    await refresh();
    toast('Saved as ' + LABELS[k] + '.' + (next ? ' Next lead is up.' : ''));
    if (next) pick(next); else loadHistory();
  } catch (e) {
    toast(e.message); $$('#outcomes .oc').forEach((b) => { b.disabled = false; });
  } finally { S.saving = false; }
}
$('#skipBtn').addEventListener('click', () => { if (S.phase !== 'wrap') return; S.lastCall = null; setPhase('idle'); refresh(); loadHistory(); });

function setMute(m) { if (S.call) S.call.mute(m); $('#muteBtn').setAttribute('aria-pressed', String(m)); $('#muteBtn').textContent = m ? 'Unmute' : 'Mute'; }
function togglePad(open) { $('#keypad').hidden = !open; $('#padBtn').setAttribute('aria-expanded', String(open)); }
function sendDigit(d) { if (S.call && S.phase === 'live') S.call.sendDigits(d); }
$('#callBtn').addEventListener('click', startCall);
$('#hangBtn').addEventListener('click', () => { if (S.call) S.call.disconnect(); else endCall(); });
$('#muteBtn').addEventListener('click', () => { if (S.call) setMute(!S.call.isMuted()); });
$('#padBtn').addEventListener('click', () => togglePad($('#keypad').hidden));

document.addEventListener('keydown', (e) => {
  if ($('#app').hidden || $('#tab-dialer').hidden) return;
  if (e.key === 'Escape' && S.call) { e.preventDefault(); S.call.disconnect(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (S.phase === 'wrap') { const o = OUTCOMES.find((x) => x.key === k); if (o) { e.preventDefault(); saveOutcome(o.k); } return; }
  if (S.phase === 'live') {
    if (!$('#keypad').hidden && /^[0-9*#]$/.test(k)) { sendDigit(k); return; }
    if (k === 'm') setMute(!S.call.isMuted());
    return;
  }
  if (S.phase === 'idle') {
    if (k === 'c' && S.current) { e.preventDefault(); startCall(); } else if (k === 'n') { e.preventDefault(); nextLead(); }
  }
});

// ---------- bulk import ----------
const HEAD = {
  phone: /(phone|mobile|cell|\btel\b|telephone|whats ?app|contact (no|num|#)|^(number|no|ph|mob|ph no|phone no)$)/,
  email: /e ?mail/,
  company: /(company|business|organi[sz]ation|firm|employer|account name|brand|^org$)/,
  country: /(country|nation)/,
  notes: /(note|comment|remark|description)/,
  first: /(first name|given name|^first$|^fname$)/,
  last: /(last name|surname|family name|^last$|^lname$)/,
  name: /(name|^contact$|contact person|^person$|^client$|^customer$|^lead$)/,
};
const FIELDS = [['name', 'Name *'], ['last', 'Last name (joined to name)'], ['phone', 'Phone *'], ['company', 'Company'], ['country', 'Country'], ['email', 'Email'], ['notes', 'Notes']];
const IMP = { rows: [], headerIdx: -1, width: 0, map: null, ready: [], skipped: [] };

function parseRows(text, delim) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell.trim() === '') { q = true; cell = ''; }
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  while (rows.length && rows[rows.length - 1].every((x) => !x.trim())) rows.pop();
  return rows.map((r) => r.map((x) => x.trim()));
}
function guessDelim(text) {
  const sample = text.split(/\r?\n/).slice(0, 30).join('\n');
  if (sample.includes('\t')) return '\t';
  const commas = (sample.match(/,/g) || []).length, semis = (sample.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}
function looksPhone(v) {
  const s = String(v || '').trim(), d = s.replace(/\D/g, '');
  return /^[^a-z@]*$/i.test(s.replace(/\b(ext|x)\b/gi, '')) && d.length >= 7 && d.length <= 15 && /^[+(\d]/.test(s.replace(/^[^\d+(]*:\s*/, ''));
}
const normHead = (c) => String(c || '').toLowerCase().replace(/[_\-.:]+/g, ' ').replace(/\s+/g, ' ').trim();
function colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = rows[i].map(normHead);
    if (!r.some(Boolean) || rows[i].some(looksPhone)) continue;
    const hasPhone = r.some((c) => HEAD.phone.test(c));
    const hasName = r.some((c) => HEAD.name.test(c) || HEAD.first.test(c));
    if (hasPhone && (hasName || r.filter(Boolean).length > 1)) return i;
  }
  return -1;
}
function bestCol(cands, score) { let best = -1, bs = -Infinity; for (const i of cands) { const s = score(i); if (s > bs) { bs = s; best = i; } } return best; }
function mapFromHeader(head, body) {
  const hd = head.map(normHead), all = hd.map((_, i) => i);
  const map = { name: -1, last: -1, phone: -1, company: -1, country: -1, email: -1, notes: -1, first: -1 };
  map.phone = bestCol(all.filter((i) => HEAD.phone.test(hd[i])), (i) => body.filter((r) => looksPhone(r[i])).length);
  const used = new Set([map.phone]);
  for (const f of ['email', 'company', 'country', 'notes', 'first', 'last']) {
    map[f] = all.find((i) => !used.has(i) && HEAD[f].test(hd[i]));
    if (map[f] == null) map[f] = -1; else used.add(map[f]);
  }
  map.name = bestCol(all.filter((i) => !used.has(i) && HEAD.name.test(hd[i])),
    (i) => (/^(full )?name$/.test(hd[i]) ? 1e6 : 0) + (/name/.test(hd[i]) ? 5e5 : 0) + body.filter((r) => r[i]).length);
  if (map.first >= 0 && (map.name < 0 || !/name/.test(hd[map.name]))) map.name = map.first;
  else map.last = -1; // a real full-name column exists: don't glue a surname on
  delete map.first;
  return map;
}
function mapFromContent(rows, width) {
  const map = { name: -1, last: -1, phone: -1, company: -1, country: -1, email: -1, notes: -1 };
  const filled = (c) => rows.filter((r) => r[c]).length || 1;
  map.phone = bestCol([...Array(width).keys()], (c) => rows.filter((r) => looksPhone(r[c])).length);
  if (map.phone >= 0 && rows.filter((r) => looksPhone(r[map.phone])).length < filled(map.phone) * 0.5) map.phone = -1;
  const used = new Set([map.phone]);
  for (let c = 0; c < width; c++) {
    if (used.has(c)) continue;
    if (rows.filter((r) => /@/.test(r[c] || '')).length > filled(c) * 0.5) { map.email = c; used.add(c); }
  }
  const text = [];
  for (let c = 0; c < width; c++) if (!used.has(c) && rows.filter((r) => /[a-z]/i.test(r[c] || '')).length >= filled(c) * 0.5) text.push(c);
  if (text[0] != null) map.name = text[0];
  if (text[1] != null) map.company = text[1];
  return map;
}

function analyse() {
  const text = $('#bulk').value.replace(/^﻿/, '');
  if (!text.trim()) { IMP.rows = []; IMP.map = null; $('#mapBox').hidden = true; $('#preview').replaceChildren(); updateImportBtn(); return; }
  const rows = parseRows(text, guessDelim(text));
  const width = Math.max(...rows.map((r) => r.length));
  const hi = findHeaderRow(rows);
  const body = rows.slice(hi + 1).filter((r) => r.some(Boolean));
  const sameShape = IMP.map && IMP.width === width && IMP.headerIdx === hi && IMP.headSig === (hi >= 0 ? rows[hi].join('|') : '');
  IMP.rows = rows; IMP.width = width; IMP.headerIdx = hi; IMP.headSig = hi >= 0 ? rows[hi].join('|') : '';
  if (!sameShape) IMP.map = hi >= 0 ? mapFromHeader(rows[hi], body) : mapFromContent(body, width);
  renderMapping(); buildPreview();
}
function renderMapping() {
  const box = $('#mapBox'), hi = IMP.headerIdx;
  const sample = (c) => { const r = IMP.rows.slice(hi + 1).find((x) => x[c]); return r ? r[c] : ''; };
  const opts = [['-1', '— not used —']];
  for (let c = 0; c < IMP.width; c++) {
    const label = hi >= 0 && IMP.rows[hi][c] ? IMP.rows[hi][c] : 'Column ' + colLetter(c);
    const s = sample(c);
    opts.push([String(c), label + (s ? ' (e.g. ' + s.slice(0, 24) + ')' : '')]);
  }
  box.replaceChildren(h('div', { class: 'map-h', text: hi >= 0 ? 'Columns found from the header in row ' + (hi + 1) + '. Fix any that are wrong:' : 'No header row found, columns guessed from the data. Fix any that are wrong:' }));
  for (const [f, label] of FIELDS) {
    if (f === 'last' && IMP.map.last < 0 && hi < 0) continue;
    const sel = h('select', { 'data-f': f, onchange: (e) => { IMP.map[f] = Number(e.target.value); buildPreview(); } });
    fillSelect(sel, opts, String(IMP.map[f]));
    box.append(h('label', {}, label, sel));
  }
  box.hidden = false;
}
function buildPreview() {
  const m = IMP.map, code = $('#defCode').value, hi = IMP.headerIdx;
  const have = new Set(S.leads.map((l) => l.phone)), seen = new Map();
  const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
  IMP.ready = []; IMP.skipped = [];
  IMP.rows.forEach((r, idx) => {
    if (idx <= hi || !r.some(Boolean)) return;
    const row = idx + 1;
    const name = [get(r, m.name), get(r, m.last)].filter(Boolean).join(' ');
    const raw = get(r, m.phone);
    const phone = Phone.normalize(raw, code);
    let reason = null;
    if (!name) reason = 'Missing name';
    else if (!raw) reason = 'Missing number';
    else if (!phone) reason = (!code && !/^\s*(\+|00)/.test(raw)) ? 'No country code (pick a default country above)' : 'Invalid number "' + raw.slice(0, 30) + '"';
    else if (have.has(phone)) reason = 'Already in your leads';
    else if (seen.has(phone)) reason = 'Same number as row ' + seen.get(phone);
    if (reason) { IMP.skipped.push({ row, name, reason }); return; }
    seen.set(phone, row);
    IMP.ready.push({ row, name, phone, company: get(r, m.company), country: get(r, m.country), email: get(r, m.email), notes: get(r, m.notes) });
  });
  renderPreview();
}
function renderPreview() {
  const box = $('#preview'), ready = IMP.ready, sk = IMP.skipped;
  const parts = [h('div', { class: 'pv-sum' }, h('span', {}, h('b', { class: 'ok', text: ready.length }), ' ready to import'), sk.length ? h('span', {}, h('b', { class: 'no', text: sk.length }), ' will be skipped') : null)];
  if (ready.length) {
    const tb = h('tbody', {}, ready.slice(0, 8).map((l) => h('tr', {},
      h('td', { class: 'muted', text: l.row }), h('td', { text: l.name }), h('td', { class: 'nowrap', text: l.phone }),
      h('td', { text: l.company }), h('td', { text: l.country || Phone.countryOf(l.phone) }))));
    parts.push(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Row', 'Name', 'Phone', 'Company', 'Country'].map((t) => h('th', { text: t })))), tb)));
    if (ready.length > 8) parts.push(h('div', { class: 'muted small', text: '…and ' + (ready.length - 8) + ' more.' }));
  }
  if (sk.length) {
    parts.push(h('details', { class: 'pv-skip' }, h('summary', { text: 'See the ' + sk.length + ' skipped rows' }),
      h('ul', {}, sk.slice(0, 500).map((s) => h('li', { text: 'Row ' + s.row + (s.name ? ' (' + s.name + ')' : '') + ': ' + s.reason })))));
  }
  box.replaceChildren(...parts);
  updateImportBtn();
}
function updateImportBtn() {
  const n = IMP.ready.length && IMP.rows.length ? IMP.ready.length : 0;
  $('#importBtn').disabled = !n;
  $('#importBtn').textContent = n ? 'Import ' + n + (n === 1 ? ' lead' : ' leads') : 'Import leads';
}
let anT;
$('#bulk').addEventListener('input', () => { clearTimeout(anT); anT = setTimeout(analyse, 200); });
$('#defCode').addEventListener('change', () => { store.set('dialerDefCode', $('#defCode').value); if (IMP.map) buildPreview(); });
$('#clearBulk').addEventListener('click', () => { $('#bulk').value = ''; IMP.map = null; analyse(); });
$('#fileBtn').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (/\.(xlsx|xls|numbers|ods)$/i.test(f.name)) { toast('That is a spreadsheet file. Save it as CSV first, or select the cells and paste them here.', 6000); return; }
  $('#bulk').value = await f.text(); IMP.map = null; analyse();
});
$('#importBtn').addEventListener('click', async () => {
  if (!IMP.ready.length) return;
  $('#importBtn').disabled = true;
  try {
    const r = await postJSON('/api/leads/import', { leads: IMP.ready, defaultCode: $('#defCode').value });
    toast('Imported ' + r.added + (r.added === 1 ? ' lead.' : ' leads.') + (r.skipped.length ? ' ' + r.skipped.length + ' skipped by the server.' : ''));
    $('#bulk').value = ''; IMP.map = null;
    await refresh(); analyse();
  } catch (err) { toast(err.message); updateImportBtn(); }
});

$('#oneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await postJSON('/api/leads/import', { defaultCode: $('#defCode').value, leads: [{ name: $('#aName').value, phone: $('#aPhone').value, company: $('#aCompany').value, country: $('#aCountry').value, email: $('#aEmail').value }] });
    if (!r.added) { toast('Not added: ' + (r.skipped[0] ? r.skipped[0].reason : 'unknown reason')); return; }
    toast('Lead added.');
    ['#aName', '#aPhone', '#aCompany', '#aCountry', '#aEmail'].forEach((id) => { $(id).value = ''; });
    $('#aName').focus(); await refresh();
  } catch (err) { toast(err.message); }
});

// ---------- leads table ----------
function tableLeads() {
  const q = $('#lSearch').value.trim().toLowerCase(), f = $('#lFilter').value;
  return S.leads.filter((l) => (f === 'all' || l.status === f) && matchLead(l, q));
}
function renderLeadsTable() {
  const list = tableLeads(), tb = $('#leadsTbl tbody');
  for (const id of S.selected) if (!S.leads.some((l) => l.id === id)) S.selected.delete(id);
  tb.replaceChildren(...list.slice(0, TABLE_LIMIT).map((l) => h('tr', {},
    h('td', { class: 'cb' }, h('input', { type: 'checkbox', 'aria-label': 'Select ' + (l.name || l.phone), checked: S.selected.has(l.id), onchange: (e) => { if (e.target.checked) S.selected.add(l.id); else S.selected.delete(l.id); updateSel(); } })),
    h('td', {}, h('button', { class: 'linkish', type: 'button', text: l.name || '(no name)', onclick: () => { showTab('dialer'); pick(l.id); } })),
    h('td', { class: 'nowrap', text: l.phone }),
    h('td', { text: l.company || '' }),
    h('td', { text: l.country || Phone.countryOf(l.phone) }),
    h('td', {}, h('span', { class: 'badge', 'data-s': l.status, text: LABELS[l.status] || l.status })),
    h('td', { class: 'num', text: l.attempts || 0 }),
    h('td', { class: 'nowrap muted', text: l.lastCallAt ? fmtWhen(l.lastCallAt) : '—' }))));
  if (!list.length) tb.append(h('tr', {}, h('td', { colspan: 8, class: 'empty', text: S.leads.length ? 'Nothing matches.' : 'No leads yet.' })));
  $('#leadsMeta').textContent = list.length > TABLE_LIMIT ? 'Showing ' + TABLE_LIMIT + ' of ' + list.length + '. Search to narrow down.' : list.length + ' leads';
  updateSel();
}
function updateSel() {
  const vis = tableLeads().slice(0, TABLE_LIMIT);
  $('#delSel').disabled = !S.selected.size;
  $('#delSel').textContent = S.selected.size ? 'Delete ' + S.selected.size + ' selected' : 'Delete selected';
  $('#selAll').checked = vis.length > 0 && vis.every((l) => S.selected.has(l.id));
}
$('#lSearch').addEventListener('input', renderLeadsTable);
$('#lFilter').addEventListener('change', renderLeadsTable);
$('#selAll').addEventListener('change', (e) => { tableLeads().slice(0, TABLE_LIMIT).forEach((l) => (e.target.checked ? S.selected.add(l.id) : S.selected.delete(l.id))); renderLeadsTable(); });
$('#delSel').addEventListener('click', async () => {
  const ids = Array.from(S.selected);
  if (S.callLead && S.phase !== 'idle' && ids.includes(S.callLead.id)) { toast('One of these is on the current call.'); return; }
  if (!ids.length || !confirm('Delete ' + ids.length + ' leads? Their calls stay in the call log.')) return;
  try {
    const r = await postJSON('/api/leads/delete', { ids });
    S.selected.clear(); toast('Deleted ' + r.deleted + ' leads.'); await refresh(); renderLeadsTable();
  } catch (err) { toast(err.message); }
});

// ---------- call log ----------
async function loadLog() {
  const v = $('#logRange').value;
  const since = v === 'all' ? '' : startOfDay(v === 'today' ? 0 : Number(v) - 1);
  try { S.log = (await getJSON('/api/calls?limit=20000' + (since ? '&since=' + encodeURIComponent(since) : ''))).calls; } catch (e) { return; }
  renderLog();
}
function logCalls() {
  const q = $('#logSearch').value.trim().toLowerCase(), o = $('#logOutcome').value, qd = q.replace(/\D/g, '');
  return S.log.filter((c) => {
    if (o === 'answered' && !isAnswered(c)) return false;
    if (o === 'none' && c.outcome) return false;
    if (o !== 'all' && o !== 'answered' && o !== 'none' && c.outcome !== o) return false;
    if (!q) return true;
    return [c.name, c.company, c.notes, c.phone].some((v) => String(v || '').toLowerCase().includes(q)) || (qd.length >= 3 && c.phone.includes(qd));
  });
}
function renderLog() {
  const list = logCalls(), tb = $('#logTbl tbody');
  const talk = list.reduce((s, c) => s + talkOf(c), 0), ans = list.filter(isAnswered).length;
  $('#logSum').replaceChildren(
    h('span', {}, h('b', { text: list.length }), ' calls'),
    h('span', {}, h('b', { text: ans }), ' answered'),
    h('span', {}, h('b', { text: fmtDur(talk) }), ' talk time'),
    h('span', {}, h('b', { text: ans ? fmtDur(talk / ans) : '0:00' }), ' avg answered call'),
    h('span', {}, h('b', { text: list.filter((c) => c.outcome === 'potential').length }), ' potential'),
    h('span', {}, h('b', { text: list.filter((c) => c.outcome === 'meeting').length }), ' meetings'));
  const rows = [];
  for (const c of list.slice(0, 2000)) {
    const editing = S.editingCallId === c.id;
    rows.push(h('tr', { class: 'clickable' + (editing ? ' editing' : ''), onclick: (e) => { if (e.target.closest('button,a')) return; S.editingCallId = editing ? null : c.id; renderLog(); } },
      h('td', { class: 'nowrap', text: fmtWhen(c.startedAt) }),
      h('td', {}, c.leadExists ? h('button', { class: 'linkish', type: 'button', text: c.name || '(no name)', onclick: () => { showTab('dialer'); pick(c.leadId); } }) : h('span', { class: 'muted', text: (c.name || '(no name)') + ' (deleted)' }),
        c.company ? h('div', { class: 'muted small', text: c.company }) : null),
      h('td', { class: 'nowrap', text: c.phone }),
      h('td', {}, h('span', { class: 'line-tag', 'data-s': c.dialStatus || '', text: c.dialStatus ? LINE[c.dialStatus] || c.dialStatus : '—' })),
      h('td', { class: 'num', text: talkOf(c) ? fmtDur(talkOf(c)) : '—' }),
      h('td', {}, c.outcome ? h('span', { class: 'badge', 'data-s': c.outcome, text: LABELS[c.outcome] || c.outcome }) : h('span', { class: 'muted small', text: 'Not logged' })),
      h('td', { class: 'note', text: c.notes || '' })));
    if (editing) {
      const sel = h('select', { 'aria-label': 'Outcome' });
      fillSelect(sel, [['', '— outcome —']].concat(OUTCOMES.map((o) => [o.k, o.label])), OUTCOMES.some((o) => o.k === c.outcome) ? c.outcome : '');
      const ta = h('textarea', { rows: 2, 'aria-label': 'Note', placeholder: 'Note: email, follow-up details…' }); ta.value = c.notes || '';
      const saveBtn = h('button', { class: 'btn primary sm', type: 'button', text: 'Save', onclick: async () => {
        try {
          await postJSON('/api/calls/' + encodeURIComponent(c.id), Object.assign({ notes: ta.value }, sel.value ? { outcome: sel.value } : {}), 'PATCH');
          S.editingCallId = null; toast('Call updated.'); await loadLog(); refresh();
        } catch (err) { toast(err.message); }
      } });
      rows.push(h('tr', { class: 'editing' }, h('td', { colspan: 7 }, h('div', { class: 'edit-cell' }, sel, ta, saveBtn))));
    }
  }
  if (!list.length) rows.push(h('tr', {}, h('td', { colspan: 7, class: 'empty', text: 'No calls in this period.' })));
  tb.replaceChildren(...rows);
}
$('#logRange').addEventListener('change', loadLog);
$('#logOutcome').addEventListener('change', renderLog);
$('#logSearch').addEventListener('input', renderLog);
$('#exportBtn').addEventListener('click', async () => {
  try { download('call-log-' + new Date().toISOString().slice(0, 10) + '.csv', await (await api('/api/export.csv')).text(), 'text/csv'); } catch (e) { toast(e.message); }
});

// ---------- guest links ----------
function guestUrl(token) { return location.origin + '/g/' + token; }
async function loadGuests() {
  const box = $('#guestList');
  let list = [];
  try { list = (await getJSON('/api/guest')).guests; } catch (e) { return; }
  if (!list.length) { box.replaceChildren(h('div', { class: 'empty', text: 'No active guest links.' })); return; }
  box.replaceChildren(...list.map((g) => {
    const inp = h('input', { type: 'text', readonly: true, value: guestUrl(g.token), 'aria-label': 'Guest link' });
    const mins = Math.max(0, Math.ceil((g.expiresAt - Date.now()) / 60000));
    return h('div', { class: 'g-item' },
      h('div', { class: 'row between' }, h('b', { text: g.masked }), h('span', { class: 'badge', text: g.calls + '/' + g.maxCalls + ' calls · ' + mins + ' min left' })),
      h('div', { class: 'g-row' }, inp,
        h('button', { class: 'btn sm', type: 'button', text: 'Copy', onclick: () => copyText(inp.value, 'Link copied.') }),
        h('button', { class: 'btn sm danger-t', type: 'button', text: 'Revoke', onclick: async () => { try { await api('/api/guest/' + encodeURIComponent(g.token), { method: 'DELETE' }); toast('Guest link revoked.'); loadGuests(); } catch (e) { toast(e.message); } } })));
  }));
}
$('#guestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await postJSON('/api/guest/create', { number: $('#gNumber').value.trim(), minutes: Number($('#gMinutes').value), maxCalls: Number($('#gMaxCalls').value), maxCallSeconds: Number($('#gMaxSec').value) });
    $('#gNumber').value = '';
    await copyText(guestUrl(r.token), 'Link created and copied.');
    loadGuests();
  } catch (err) { toast(err.message); }
});

if (S.pw) api('/api/state').then(start).catch(() => showLogin(''));
