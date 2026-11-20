// Finances: net worth, cash, credit-card debt and crypto from SimpleFIN Bridge, like a small
// Monarch. Routes (sub of #/finances/…):
//   ''              net worth + chart, totals by type, accounts, recent transactions
//   a/<id>          one account: balance, its chart, its transactions, type / hide / rename
//   transactions    every transaction, newest first
// Data: /api/finances* (server/apps/finances.js). Read-only: nothing here moves money.
import * as kit from '../../kit.js';
import { formSheet } from '../../form.js';

const {
  api, el, fmt, toast, haptic, navbar, navButton, section, emptyState, confirmSheet, actionSheet,
  holdReload, releaseReload, icon, nav, store,
} = kit;

const TYPES = [
  ['cash', 'Cash'], ['credit', 'Credit cards'], ['crypto', 'Crypto'],
  ['investment', 'Investments'], ['loan', 'Loans'], ['other', 'Other'],
];
const TYPE_ONE = { cash: 'Cash', credit: 'Credit card', crypto: 'Crypto', investment: 'Investment', loan: 'Loan', other: 'Other' };
const RANGES = [['30', '1M'], ['90', '3M'], ['365', '1Y'], ['all', 'All']];
const HOLD_KEY = 'finances:typing';
const RANGE_KEY = 'finances.range';
const STALE_MS = 3 * 86_400_000;

let root = null;
let view = { kind: 'home' };
let data = null;          // GET /api/finances
let points = null;        // history for the chart on screen
let txs = null;           // { transactions, more } for the list on screen
let listeners = [];
let seq = 0;
let locked = false;
let autoFaceTried = false;

// ---------------------------------------------------------------- lock (PIN / Face ID)
// The PC answers 423 until this tab holds an unlock token (5 minutes, extended on use). In the
// iPhone app, a key kept in the Keychain behind Face ID / the passcode unlocks without the PIN.
const TOKEN_KEY = 'finances.unlock';
const DEVICE_KEY = 'finances.deviceId';
const canDeviceKey = () => Boolean(window.JakesData && window.JakesData.canDeviceKey);
const session = {
  get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch { /* private mode */ } },
};
const deviceId = () => store.get(DEVICE_KEY, '') || '';

async function fapi(path, opts = {}) {
  try {
    return await api(path, { ...opts, headers: { ...(opts.headers || {}), 'X-Finances-Unlock': session.get(TOKEN_KEY) } });
  } catch (err) {
    if (err && err.status === 423) showLock();
    throw err;
  }
}

function nativeKey(message) {
  return new Promise((resolve) => {
    const request = Math.random().toString(36).slice(2);
    let timer = 0;
    const done = (detail) => { window.removeEventListener('jakesdata:devicekey', onEvent); clearTimeout(timer); resolve(detail); };
    const onEvent = (e) => { if (e.detail && e.detail.request === request) done(e.detail); };
    window.addEventListener('jakesdata:devicekey', onEvent);
    timer = setTimeout(() => done({ ok: false, error: 'failed' }), 120_000);
    try { window.webkit.messageHandlers.native.postMessage({ type: 'devicekey', request, ...message }); }
    catch { done({ ok: false, error: 'failed' }); }
  });
}

function showLock() {
  session.set(TOKEN_KEY, '');
  if (locked) return;
  locked = true;
  render();
  if (!autoFaceTried && deviceId() && canDeviceKey()) {
    autoFaceTried = true;
    unlockWithFace();
  }
}

async function unlocked(token, { offerFace = false } = {}) {
  session.set(TOKEN_KEY, token);
  locked = false;
  haptic('success');
  render();
  refresh();
  if (offerFace && canDeviceKey() && !deviceId()) {
    const ok = await confirmSheet({ title: 'Use Face ID next time?', message: 'Unlock Finances with Face ID or your iPhone passcode instead of the PIN.', confirmLabel: 'Use Face ID' });
    if (ok) await enableFace();
  }
}

async function enableFace() {
  try {
    const { device_id, device_key } = await fapi('/api/finances/lock/device', { method: 'POST' });
    const saved = await nativeKey({ action: 'store', id: device_id, key: device_key });
    if (!saved.ok) return toast(saved.error === 'nopasscode' ? 'Set a passcode on this iPhone first' : "Couldn't save the Face ID key", { kind: 'error' });
    store.set(DEVICE_KEY, device_id);
    toast('Face ID unlock is on');
  } catch (err) {
    toast(err && err.status ? err.message : "Couldn't reach the PC", { kind: 'error' });
  }
}

async function unlockWithFace() {
  const id = deviceId();
  const got = await nativeKey({ action: 'unlock', id });
  if (!got.ok) {
    if (got.error === 'missing') store.del(DEVICE_KEY);
    if (got.error !== 'cancelled') toast('Face ID unlock is not available. Use the PIN.', { kind: 'error' });
    return render();
  }
  try {
    const { token } = await api('/api/finances/unlock', { method: 'POST', body: { device_id: id, device_key: got.key } });
    unlocked(token);
  } catch (err) {
    if (err && err.status === 401) { store.del(DEVICE_KEY); nativeKey({ action: 'clear', id }); }
    toast(err && err.status ? err.message : "Couldn't reach the PC", { kind: 'error' });
    render();
  }
}

function renderLock() {
  const bar = navbar({ title: 'Finances', back: view.kind !== 'home' });
  const pin = el('input', {
    class: 'input fn-pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8',
    autocomplete: 'off', placeholder: 'PIN', 'aria-label': 'Finances PIN',
  });
  const go = el('button', { type: 'submit', class: 'button fn-connect', text: 'Unlock' });
  const form = el('form', { class: 'fn-connect-form', autocomplete: 'off' }, pin, go);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pin.value) return;
    go.disabled = true;
    try {
      const { token } = await api('/api/finances/unlock', { method: 'POST', body: { pin: pin.value } });
      unlocked(token, { offerFace: true });
    } catch (err) {
      haptic('error');
      toast(err && err.status ? err.message : "Couldn't reach the PC", { kind: 'error' });
      pin.value = '';
      go.disabled = false;
      pin.focus();
    }
  });
  const face = deviceId() && canDeviceKey()
    ? el('button', { type: 'button', class: 'button fn-face', text: 'Unlock with Face ID', 'on:click': () => unlockWithFace() }) : null;
  root.replaceChildren(bar, el('div', { class: 'app-content' },
    el('section', { class: 'card fn-setup fn-lock' },
      el('h2', { text: 'Finances is locked' }),
      el('p', { class: 'muted', text: face ? 'Use Face ID or your PIN.' : 'Enter your Finances PIN.' }),
      face, form)));
  if (!face) pin.focus();
}

async function pinSheet(title) {
  const result = await formSheet({ title, fields: [
    { key: 'pin', label: 'New PIN (4 to 8 digits)', type: 'password', required: true },
    { key: 'again', label: 'Type it again', type: 'password', required: true },
  ] });
  if (!result || result === 'delete') return null;
  if (!/^\d{4,8}$/.test(result.pin)) { toast('The PIN must be 4 to 8 digits', { kind: 'error' }); return null; }
  if (result.pin !== result.again) { toast("The PINs don't match", { kind: 'error' }); return null; }
  return result.pin;
}

async function lockMenu() {
  let status;
  try { status = await api('/api/finances/lock'); } catch { return toast("Couldn't reach the PC", { kind: 'error' }); }
  if (!status.enabled) {
    const pin = await pinSheet('Lock Finances with a PIN');
    if (!pin) return;
    try {
      const { token } = await fapi('/api/finances/lock/pin', { method: 'POST', body: { pin } });
      session.set(TOKEN_KEY, token);
      toast('Finances now needs your PIN');
      if (canDeviceKey()) {
        const ok = await confirmSheet({ title: 'Also unlock with Face ID?', message: 'Use Face ID or your iPhone passcode instead of typing the PIN.', confirmLabel: 'Use Face ID' });
        if (ok) await enableFace();
      }
    } catch (err) { toast(err && err.status ? err.message : "Couldn't reach the PC", { kind: 'error' }); }
    return;
  }
  const actions = [{ label: 'Lock Now', value: 'now' }];
  if (canDeviceKey() && !deviceId()) actions.push({ label: 'Unlock with Face ID', value: 'face' });
  actions.push({ label: 'Change PIN', value: 'change' }, { label: 'Turn Off PIN Lock', value: 'off', destructive: true });
  const choice = await actionSheet({ title: 'Finances lock', actions });
  if (choice === 'now') {
    try { await api('/api/finances/lock/now', { method: 'POST', headers: { 'X-Finances-Unlock': session.get(TOKEN_KEY) } }); } catch { /* the token expires anyway */ }
    showLock();
  }
  if (choice === 'face') await enableFace();
  if (choice === 'change') {
    const pin = await pinSheet('Change PIN');
    if (!pin) return;
    try { const { token } = await fapi('/api/finances/lock/pin', { method: 'POST', body: { pin } }); session.set(TOKEN_KEY, token); toast('PIN changed'); }
    catch (err) { if (err && err.status !== 423) toast(err.message || "Couldn't reach the PC", { kind: 'error' }); }
  }
  if (choice === 'off') {
    const ok = await confirmSheet({ title: 'Turn off the PIN lock?', message: 'Finances will open without a PIN or Face ID.', confirmLabel: 'Turn Off', destructive: true });
    if (!ok) return;
    try {
      await fapi('/api/finances/lock/pin', { method: 'DELETE' });
      if (deviceId()) { nativeKey({ action: 'clear', id: deviceId() }); store.del(DEVICE_KEY); }
      toast('PIN lock is off');
    } catch (err) { if (err && err.status !== 423) toast(err.message || "Couldn't reach the PC", { kind: 'error' }); }
  }
}

export default {
  mount(rootEl, ctx) {
    root = rootEl;
    listen(window, 'jakesdata:online', () => refresh());
    listen(window, 'jakesdata:foreground', () => refresh());
    open(ctx.sub);
  },
  route(sub) { open(sub); },
  unmount() {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    releaseReload(HOLD_KEY);
    root = null;
    data = null;
    autoFaceTried = false;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

function open(sub) {
  const parts = String(sub || '').split('/').filter(Boolean);
  if (parts[0] === 'a' && parts[1]) view = { kind: 'account', id: parts[1] };
  else if (parts[0] === 'transactions') view = { kind: 'transactions' };
  else view = { kind: 'home' };
  points = null;
  txs = null;
  window.scrollTo(0, 0);
  render();
  refresh();
}

const range = () => {
  const r = store.get(RANGE_KEY, '90');
  return RANGES.some(([v]) => v === r) ? r : '90';
};

async function refresh() {
  if (!root) return;
  const token = ++seq;
  const want = view;
  try {
    const account = want.kind === 'account' ? want.id : null;
    const [overview, history, list] = await Promise.all([
      fapi('/api/finances'),
      want.kind === 'transactions' ? null : fapi(`/api/finances/history?days=${range()}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
      want.kind === 'home' ? fapi('/api/finances/transactions?limit=8')
        : fapi(`/api/finances/transactions?limit=50${account ? `&account=${encodeURIComponent(account)}` : ''}`),
    ]);
    if (!root || token !== seq || view !== want) return;
    data = overview;
    locked = false;
    points = history ? history.points : null;
    txs = list;
    if (!typing()) render();
  } catch (err) {
    if (!root || token !== seq || view !== want) return;
    if (err && err.status === 423) return;
    if (err && err.status === 404 && want.kind === 'account') {
      toast('That account is gone');
      nav.replace('#/finances');
      return;
    }
    if (!data) {
      root.replaceChildren(navbar({ title: 'Finances', back: want.kind !== 'home' }),
        el('div', { class: 'app-content' }, emptyState(err && err.status ? `Couldn't load: ${err.message}` : "Couldn't load — the PC is unreachable")));
    }
  }
}

function typing() {
  const active = document.activeElement;
  return Boolean(root && active && root.contains(active) && active.matches('input, textarea') && active.value.trim());
}

function render() {
  if (!root) return;
  if (locked) return renderLock();
  if (view.kind === 'account') return renderAccount();
  if (view.kind === 'transactions') return renderTransactions();
  return renderHome();
}

// ---------------------------------------------------------------- formatting

function money(n, { currency = 'USD', cents = true, sign = false } = {}) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const opts = { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 };
  let body;
  if (/^[A-Z]{3}$/.test(currency)) {
    body = Math.abs(v).toLocaleString('en-US', { style: 'currency', currency, ...opts });
  } else {
    body = `${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 8 })} ${currency}`;
  }
  if (v < 0) return `−${body}`;
  return sign && v > 0 ? `+${body}` : body;
}

// "$1.2k" style for chart labels
function shortMoney(n) {
  const v = Math.abs(n);
  const s = v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : `$${Math.round(v)}`;
  return n < 0 ? `−${s}` : s;
}

const accountName = (a) => a.nickname || a.name;
const dayKeyOf = (iso) => fmt.dayKey(new Date(iso));

function updatedLine() {
  const s = data.sync;
  if (s.last_success) return `Updated ${fmt.relTime(s.last_success) === 'now' ? 'just now' : `${fmt.relTime(s.last_success)} ago`}`;
  return s.last_attempt ? 'Not updated yet' : 'Waiting for the first update';
}

// ---------------------------------------------------------------- chart

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

// pts: [{date, net_worth}] oldest first. The readout above shows the value under the finger.
function chart(pts, readout, fallback) {
  const W = 340;
  const H = 140;
  const pad = { l: 2, r: 2, t: 10, b: 18 };
  const box = el('div', { class: 'fn-chart' });
  if (!pts || pts.length < 2) {
    box.append(el('div', { class: 'fn-chart-empty muted', text: 'The chart fills in as balances are recorded each day.' }));
    return box;
  }
  const vals = pts.map((p) => p.net_worth);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) { hi += Math.max(1, Math.abs(hi) * 0.02); lo -= Math.max(1, Math.abs(lo) * 0.02); }
  const span = hi - lo;
  lo -= span * 0.12;
  hi += span * 0.12;
  const x = (i) => pad.l + ((W - pad.l - pad.r) * i) / (pts.length - 1);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
  const up = vals[vals.length - 1] >= vals[0];
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: `fn-chart-svg ${up ? 'up' : 'down'}`, role: 'img',
    'aria-label': `From ${money(vals[0], { cents: false })} to ${money(vals[vals.length - 1], { cents: false })}` });
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.net_worth).toFixed(1)}`).join(' ');
  svg.append(svgEl('polygon', { class: 'fn-area', points: `${x(0)},${H - pad.b} ${line} ${x(pts.length - 1)},${H - pad.b}` }));
  svg.append(svgEl('polyline', { class: 'fn-line', points: line }));
  const tick = (i, anchor) => {
    const t = svgEl('text', { x: x(i), y: H - 3, class: 'fn-tick', 'text-anchor': anchor });
    t.textContent = fmt.date(new Date(`${pts[i].date}T12:00:00`));
    svg.append(t);
  };
  tick(0, 'start');
  tick(pts.length - 1, 'end');
  const cross = svgEl('line', { y1: pad.t, y2: H - pad.b, class: 'fn-cross', visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4.5, class: 'fn-dot', visibility: 'hidden' });
  svg.append(cross, dot);
  const pick = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1))));
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(pts[i].net_worth));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    readout.textContent = `${fmt.date(new Date(`${pts[i].date}T12:00:00`), { weekday: 'short' })}: ${money(pts[i].net_worth)}`;
  };
  const clear = () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    readout.textContent = fallback;
  };
  svg.addEventListener('pointermove', pick);
  svg.addEventListener('pointerdown', pick);
  svg.addEventListener('pointerleave', clear);
  svg.addEventListener('pointercancel', clear);
  box.append(svg);
  return box;
}

// "+$1,204.50 (0.9%) past 3 months" over the range on the chart, so the colour of the line and
// the change always agree. History shorter than the range says "since <first day>".
const RANGE_WORDS = { 30: 'past month', 90: 'past 3 months', 365: 'past year' };
function rangeChange(pts) {
  if (!pts || pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const delta = Math.round((last.net_worth - first.net_worth) * 100) / 100;
  const firstDay = new Date(`${first.date}T12:00:00`);
  const covered = Math.round((new Date(`${last.date}T12:00:00`) - firstDay) / 86_400_000) + 1;
  const want = range();
  const words = want !== 'all' && covered >= Number(want) - 1 ? RANGE_WORDS[want] : `since ${fmt.date(firstDay)}`;
  const pctText = first.net_worth ? ` (${(Math.abs(delta / first.net_worth) * 100).toFixed(1)}%)` : '';
  return el('div', { class: `fn-change ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`, text: `${money(delta, { sign: true })}${pctText} ${words}` });
}

function rangePicker() {
  const current = range();
  return el('div', { class: 'segmented fn-range', role: 'group', 'aria-label': 'Chart range' },
    ...RANGES.map(([value, label]) => el('button', {
      type: 'button', text: label, 'aria-pressed': String(current === value),
      'on:click': () => {
        if (current === value) return;
        store.set(RANGE_KEY, value);
        haptic('light');
        refresh();
      },
    })));
}

// ---------------------------------------------------------------- home

function renderHome() {
  const more = navButton({ icon: 'more', label: 'Finances options', onClick: () => homeMenu() });
  const refreshBtn = navButton({ icon: 'refresh', label: 'Update balances', onClick: () => syncNow(refreshBtn) });
  const connected = data && data.connected;
  const bar = navbar({ title: 'Finances', right: connected ? [refreshBtn, more] : (data && data.accounts.length ? [more] : []) });
  if (!data) {
    root.replaceChildren(bar, el('div', { class: 'app-content' }, el('div', { class: 'muted fn-loading', text: 'Loading…' })));
    return;
  }
  if (!connected && !data.accounts.length) {
    root.replaceChildren(bar, el('div', { class: 'app-content' }, connectCard()));
    return;
  }
  const s = data.summary;
  const visible = data.accounts.filter((a) => !a.hidden);
  const hidden = data.accounts.filter((a) => a.hidden);

  const changeLine = rangeChange(points);
  const fallback = changeLine ? changeLine.textContent : '';
  const readout = el('div', { class: 'fn-readout muted', text: fallback });

  const hero = el('section', { class: 'card fn-hero' },
    el('div', { class: 'fn-label', text: 'Net worth' }),
    el('div', { class: 'fn-big', text: money(s.net_worth) }),
    changeLine,
    readout,
    chart(points, readout, fallback),
    rangePicker());

  const totals = [];
  const kv = (label, value, cls = '') => el('li', { class: 'kv' }, el('span', { class: 'k', text: label }), el('span', { class: `v ${cls}`, text: value }));
  totals.push(kv('Cash', money(s.cash)));
  totals.push(kv('Credit card debt', s.credit ? money(-s.credit) : money(0), s.credit ? 'fn-neg' : ''));
  totals.push(kv('Crypto', money(s.crypto)));
  if (s.investment) totals.push(kv('Investments', money(s.investment)));
  if (s.loan) totals.push(kv('Loans', money(-s.loan), 'fn-neg'));
  if (s.other) totals.push(kv('Other', money(s.other)));

  const groups = TYPES.map(([type, label]) => [type, label, visible.filter((a) => a.type === type)]).filter(([, , list]) => list.length);

  root.replaceChildren(bar, el('div', { class: 'app-content fn-page' },
    statusNotes(),
    hero,
    runwayCard(),
    goalCard(),
    section('Totals'),
    el('ul', { class: 'card list fn-totals' }, ...totals),
    ...groups.flatMap(([type, label, list]) => [
      el('div', { class: 'fn-section-row' }, section(label), el('span', { class: 'fn-section-sum muted', text: money(list.reduce((n, a) => n + a.balance, 0)) })),
      el('div', { class: 'card fn-accounts' }, ...list.map(accountRow)),
    ]),
    hidden.length ? [section('Hidden from net worth'), el('div', { class: 'card fn-accounts' }, ...hidden.map(accountRow))] : null,
    el('div', { class: 'fn-section-row' }, section('Recent transactions'),
      txs && txs.transactions.length ? el('button', { type: 'button', class: 'fn-link', text: 'See All', 'on:click': () => nav.go('#/finances/transactions') }) : null),
    txList(txs, { showAccount: true, emptyText: 'No transactions in the last few weeks.' }),
    el('p', { class: 'muted fn-foot', text: `${updatedLine()} · from SimpleFIN Bridge. Read-only.` })));
}

function statusNotes() {
  if (!data) return null;
  const out = [];
  const s = data.sync;
  if (!data.connected) {
    out.push(el('div', { class: 'card fn-note', role: 'status' },
      el('div', { text: 'Not connected to SimpleFIN. Balances below are the last ones recorded.' }),
      el('button', { type: 'button', class: 'fn-link', text: 'Connect', 'on:click': () => connectSheet() })));
  }
  if (s.last_error) out.push(el('div', { class: 'card fn-note warn', role: 'status', text: s.last_error }));
  for (const m of s.messages || []) out.push(el('div', { class: 'card fn-note warn', role: 'status', text: m }));
  return out.length ? out : null;
}

function accountRow(a) {
  const when = a.balance_date || a.updated_at;
  const stale = when && Date.now() - Date.parse(when) > STALE_MS;
  const age = when ? fmt.relTime(when) : '';
  const updated = !age ? null : age === 'now' ? 'Updated just now' : /^\d+[mhd]$/.test(age) ? `Updated ${age} ago` : `Updated ${age}`;
  const sub = [a.org, updated].filter(Boolean).join(' · ');
  return el('button', { type: 'button', class: `fn-acct${a.hidden ? ' hidden' : ''}`, 'on:click': () => nav.go(`#/finances/a/${a.id}`) },
    el('span', { class: 'fn-acct-text' },
      el('span', { class: 'fn-acct-name', text: accountName(a) }),
      sub ? el('span', { class: `fn-acct-sub${stale ? ' stale' : ''}`, text: sub }) : null),
    el('span', { class: `fn-acct-bal${a.balance < 0 ? ' fn-neg' : ''}`, text: money(a.balance, { currency: a.currency }) }),
    icon('chevron-right', { size: 18 }));
}

function txList(list, { showAccount, emptyText }) {
  if (!list) return el('div', { class: 'muted fn-loading', text: 'Loading…' });
  if (!list.transactions.length) return emptyState(emptyText);
  const box = el('div', { class: 'card fn-txs' });
  let lastDay = null;
  for (const t of list.transactions) {
    const day = dayKeyOf(t.posted);
    if (day !== lastDay) {
      box.append(el('div', { class: 'fn-tx-day', text: fmt.date(new Date(`${day}T12:00:00`), { weekday: 'short' }) }));
      lastDay = day;
    }
    const title = t.payee || t.description || 'Transaction';
    const sub = [showAccount ? t.account : null, t.payee && t.description && t.description !== t.payee ? t.description : null].filter(Boolean).join(' · ');
    box.append(el('div', { class: 'fn-tx' },
      el('span', { class: 'fn-tx-text' },
        el('span', { class: 'fn-tx-title', text: title }),
        sub ? el('span', { class: 'fn-tx-sub', text: sub }) : null),
      t.pending ? el('span', { class: 'fn-pill', text: 'Pending' }) : null,
      el('span', { class: `fn-tx-amt${t.amount > 0 ? ' in' : ''}`, text: money(t.amount, { sign: true }) })));
  }
  return box;
}

function loadMoreButton(account) {
  if (!txs || !txs.more) return null;
  const btn = el('button', { type: 'button', class: 'button fn-more', text: 'Load More' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const last = txs.transactions[txs.transactions.length - 1];
    try {
      const next = await fapi(`/api/finances/transactions?limit=50&before=${encodeURIComponent(last.posted)}${account ? `&account=${encodeURIComponent(account)}` : ''}`);
      if (!root) return;
      txs = { transactions: [...txs.transactions, ...next.transactions], more: next.more };
      render();
    } catch (err) {
      btn.disabled = false;
      toast(err && err.status ? err.message : "Couldn't load — the PC is unreachable", { kind: 'error' });
    }
  });
  return btn;
}

async function syncNow(btn) {
  if (btn) btn.disabled = true;
  toast('Updating from SimpleFIN…');
  try {
    data = await fapi('/api/finances/sync', { method: 'POST', timeout: 90_000 });
    haptic('success');
    if (data.sync.last_error) toast(data.sync.last_error, { kind: 'error', ms: 4000 });
    else toast('Balances updated');
    refresh();
  } catch (err) {
    toast(err && err.status ? err.message : "Couldn't update — the PC is unreachable", { kind: 'error', ms: 4000 });
    if (btn) btn.disabled = false;
  }
}

// The Goals goal that follows net worth (one check-in a day, made on the PC after each update).
// Runway: how many months cash (after card debt) lasts at normal spending, with no income.
function runwayCard() {
  const r = data && data.runway;
  if (!r || r.months === null) return null;
  const monthsText = (m) => (m >= 24 ? `${Math.round(m / 12 * 10) / 10} years` : `${m} month${m === 1 ? '' : 's'}`);
  return el('section', { class: 'card fn-runway' },
    el('div', { class: 'fn-label', text: 'Runway' }),
    el('div', { class: `fn-runway-big${r.months < 3 ? ' fn-neg' : ''}`, text: monthsText(r.months) }),
    el('div', { class: 'fn-runway-line', text: `${money(r.cash, { cents: false })} cash + ${money(r.crypto, { cents: false })} crypto + ${money(r.available_credit, { cents: false })} credit ÷ ${money(r.monthly_spending, { cents: false })}/month spending` }),
    el('div', { class: 'fn-runway-note', text: `${monthsText(r.months_cash_only)} on cash alone. Spending from your last ${r.days} days, not counting transfers between your accounts. Income not included.` }));
}

function goalCard() {
  const g = data && data.goal_link;
  if (!g) return null;
  const pct = g.progress === null ? null : Math.round(g.progress * 100);
  const fill = el('div', { class: 'fn-goal-fill' });
  fill.style.width = `${pct || 0}%`;
  const bits = [g.target_value !== null ? `${money(g.current_value ?? 0, { cents: false })} of ${money(g.target_value, { cents: false })}` : null,
    g.target_date ? `by ${fmt.date(new Date(`${g.target_date}T12:00:00`), { year: true })}` : null].filter(Boolean).join(' · ');
  return el('button', { type: 'button', class: 'card fn-goal', 'on:click': () => nav.go(`#/goals/${g.goal_id}`) },
    el('div', { class: 'fn-goal-top' },
      el('span', { class: 'fn-goal-title', text: g.title }),
      pct !== null ? el('span', { class: 'fn-goal-pct', text: `${pct}%` }) : null,
      icon('chevron-right', { size: 18 })),
    el('div', { class: 'fn-goal-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct || 0) }, fill),
    el('div', { class: 'fn-goal-sub', text: bits ? `${bits} · updated from net worth` : 'Updated from net worth' }));
}

async function goalPicker() {
  let goals = [];
  try {
    ({ goals } = await api('/api/goals?status=active'));
  } catch (err) {
    return toast(err && err.status ? err.message : "Couldn't load goals — the PC is unreachable", { kind: 'error' });
  }
  const link = data.goal_link;
  const measured = goals.filter((g) => g.unit === '$' && g.target_value !== null && g.target_value !== undefined);
  const choice = await actionSheet({
    title: 'Net worth goal',
    message: 'After each update, today’s net worth is checked in on this goal.',
    actions: [
      ...measured.map((g) => ({ label: g.title, value: g.id, selected: Boolean(link && link.goal_id === g.id && !link.auto) })),
      { label: 'Automatic (your one $ money goal)', value: 'auto', selected: Boolean(link && link.auto) },
      { label: 'Off', value: 'off', selected: !link },
    ],
  });
  if (choice === null) return;
  try {
    data = await fapi('/api/finances/goal', { method: 'PUT', body: { goal: choice === 'auto' ? null : choice === 'off' ? 0 : choice } });
    haptic('success');
    render();
  } catch (err) {
    toast(err && err.status ? err.message : "Couldn't save — the PC is unreachable", { kind: 'error' });
  }
}

async function homeMenu() {
  const actions = [];
  actions.push({ label: 'PIN / Face ID Lock', value: 'lock' });
  actions.push({ label: data.goal_link ? `Net Worth Goal: ${data.goal_link.title}` : 'Net Worth Goal: Off', value: 'goal' });
  if (data.connected) actions.push({ label: 'Replace SimpleFIN Connection', value: 'replace' }, { label: 'Disconnect SimpleFIN', value: 'disconnect', destructive: true });
  else actions.push({ label: 'Connect SimpleFIN', value: 'replace' });
  const choice = await actionSheet({ title: 'Finances', message: data.connected ? updatedLine() : '', actions });
  if (choice === 'lock') return lockMenu();
  if (choice === 'goal') return goalPicker();
  if (choice === 'replace') return connectSheet();
  if (choice === 'disconnect') {
    const ok = await confirmSheet({
      title: 'Disconnect SimpleFIN?',
      message: 'The PC forgets the saved SimpleFIN access. Balances and history recorded so far stay here.',
      confirmLabel: 'Disconnect', destructive: true,
    });
    if (!ok) return;
    try {
      await fapi('/api/finances/connect', { method: 'DELETE' });
      toast('Disconnected');
      refresh();
    } catch (err) {
      toast(err && err.status ? err.message : "Couldn't disconnect — the PC is unreachable", { kind: 'error' });
    }
  }
}

// ---------------------------------------------------------------- connecting

const STEPS = [
  'Open bridge.simplefin.org and sign in.',
  'Check that Chase, Wells Fargo and Coinbase are connected there (add any that are missing).',
  'Go to Apps, tap New Connection, and copy the setup token it shows.',
  'Paste it here and tap Connect.',
];

function connectForm({ onDone } = {}) {
  const input = el('textarea', {
    class: 'input fn-token', rows: '3', placeholder: 'Paste your SimpleFIN setup token',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'SimpleFIN setup token',
  });
  const go = el('button', { type: 'submit', class: 'button fn-connect', text: 'Connect', disabled: true });
  const sync = () => {
    go.disabled = !input.value.trim();
    if (input.value.trim()) holdReload(HOLD_KEY); else releaseReload(HOLD_KEY);
  };
  input.addEventListener('input', sync);
  const form = el('form', { class: 'fn-connect-form', autocomplete: 'off' }, input, go);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = input.value.trim();
    if (!token) return;
    go.disabled = true;
    go.textContent = 'Connecting…';
    try {
      data = await fapi('/api/finances/connect', { method: 'POST', body: { token }, timeout: 120_000 });
      input.value = '';
      releaseReload(HOLD_KEY);
      haptic('success');
      toast(`Connected · ${data.accounts.length} account${data.accounts.length === 1 ? '' : 's'}`);
      if (onDone) onDone();
      refresh();
    } catch (err) {
      haptic('error');
      toast(err && err.status ? err.message : "Couldn't connect — the PC is unreachable", { kind: 'error', ms: 5000 });
      go.textContent = 'Connect';
      go.disabled = false;
    }
  });
  return form;
}

function connectCard() {
  return el('section', { class: 'card fn-setup' },
    el('h2', { text: 'Connect your accounts' }),
    el('p', { class: 'muted', text: 'Finances reads balances and transactions through SimpleFIN Bridge, the $1.50/month service you already pay for. It is read-only: nothing here can move money.' }),
    el('ol', { class: 'fn-steps' }, ...STEPS.map((s, i) => el('li', null,
      i === 0 ? [el('a', { href: 'https://bridge.simplefin.org/', target: '_blank', rel: 'noopener noreferrer', text: 'Open bridge.simplefin.org' }), el('span', { text: ' and sign in.' })] : s))),
    connectForm(),
    el('p', { class: 'muted fn-fine', text: 'The PC claims the token once and keeps the resulting access in a private file. It never appears in the app again.' }));
}

function connectSheet() {
  // A plain in-page sheet: the token field must stay a textarea, which formSheet does not size well.
  const close = () => { releaseReload(HOLD_KEY); scrim.remove(); };
  const panel = el('div', { class: 'card fn-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Connect SimpleFIN' },
    el('div', { class: 'fn-sheet-head' },
      el('h2', { text: 'Connect SimpleFIN' }),
      el('button', { type: 'button', class: 'fn-sheet-close', 'aria-label': 'Close', 'on:click': close }, icon('close', { size: 20 }))),
    el('ol', { class: 'fn-steps' }, ...STEPS.map((s, i) => el('li', null,
      i === 0 ? [el('a', { href: 'https://bridge.simplefin.org/', target: '_blank', rel: 'noopener noreferrer', text: 'Open bridge.simplefin.org' }), el('span', { text: ' and sign in.' })] : s))),
    connectForm({ onDone: close }));
  const scrim = el('div', { class: 'fn-scrim', 'on:click': (e) => { if (e.target === scrim) close(); } }, panel);
  root.append(scrim);
  panel.querySelector('textarea').focus();
}

// ---------------------------------------------------------------- one account

function renderAccount() {
  const a = data && data.accounts.find((x) => x.id === view.id);
  const more = navButton({ icon: 'more', label: 'Account options', onClick: () => accountMenu(a) });
  const bar = navbar({ title: a ? accountName(a) : 'Account', back: true, right: a ? [more] : [] });
  if (!a) {
    root.replaceChildren(bar, el('div', { class: 'app-content' }, el('div', { class: 'muted fn-loading', text: data ? 'That account is gone.' : 'Loading…' })));
    return;
  }
  const meta = [a.org, TYPE_ONE[a.type], a.hidden ? 'Hidden from net worth' : null].filter(Boolean).join(' · ');
  const changeLine = rangeChange(points);
  const asOf = `As of ${fmt.date(a.balance_date || a.updated_at, { time: true })}`;
  const readout = el('div', { class: 'fn-readout muted', text: changeLine ? changeLine.textContent : asOf });
  const extra = [el('li', { class: 'kv' }, el('span', { class: 'k', text: 'Balance updated' }), el('span', { class: 'v', text: asOf.replace('As of ', '') }))];
  if (a.type === 'credit' && a.credit_limit !== null) {
    extra.push(el('li', { class: 'kv' }, el('span', { class: 'k', text: 'Credit limit' }), el('span', { class: 'v', text: money(a.credit_limit) })));
    extra.push(el('li', { class: 'kv' }, el('span', { class: 'k', text: 'Available credit' }), el('span', { class: 'v', text: money(a.available_credit) })));
  } else if (a.available !== null && a.available !== undefined && a.available !== a.balance) {
    extra.push(el('li', { class: 'kv' }, el('span', { class: 'k', text: a.type === 'credit' ? 'Available credit' : 'Available' }), el('span', { class: 'v', text: money(a.available, { currency: a.currency }) })));
  }
  if (a.holdings_value) extra.push(el('li', { class: 'kv' }, el('span', { class: 'k', text: 'Holdings value' }), el('span', { class: 'v', text: money(a.holdings_value) })));
  if (a.nickname) extra.push(el('li', { class: 'kv' }, el('span', { class: 'k', text: 'Bank’s name' }), el('span', { class: 'v', text: a.name })));
  root.replaceChildren(bar, el('div', { class: 'app-content fn-page' },
    el('section', { class: 'card fn-hero' },
      el('div', { class: 'fn-label', text: meta }),
      el('div', { class: `fn-big${a.balance < 0 ? ' fn-neg' : ''}`, text: money(a.balance, { currency: a.currency }) }),
      changeLine,
      readout,
      chart(points, readout, readout.textContent),
      rangePicker()),
    extra.length ? el('ul', { class: 'card list' }, ...extra) : null,
    section('Transactions'),
    txList(txs, { showAccount: false, emptyText: 'No transactions recorded for this account yet.' }),
    loadMoreButton(a.id)));
}

async function accountMenu(a) {
  const choice = await actionSheet({
    title: accountName(a),
    actions: [
      { label: 'Rename', value: 'rename' },
      { label: `Account Type: ${TYPE_ONE[a.type]}`, value: 'type' },
      { label: a.hidden ? 'Count in Net Worth' : 'Hide from Net Worth', value: 'hide' },
      ...(a.type === 'credit' ? [{ label: a.credit_limit ? `Credit Limit: ${money(a.credit_limit, { cents: false })}` : 'Set Credit Limit', value: 'limit' }] : []),
    ],
  });
  if (choice === 'rename') {
    const result = await formSheet({ title: 'Rename account', fields: [{ key: 'nickname', label: 'Name', value: accountName(a), placeholder: a.name }] });
    if (!result || result === 'delete') return;
    const nickname = result.nickname === a.name ? '' : result.nickname;
    return patchAccount(a, { nickname });
  }
  if (choice === 'type') {
    const type = await actionSheet({
      title: 'Account type',
      message: 'Decides which total it counts toward.',
      actions: [
        { label: `Automatic (${TYPE_ONE[a.type_auto]})`, value: 'auto', selected: a.type === a.type_auto },
        ...TYPES.map(([value]) => ({ label: TYPE_ONE[value], value, selected: a.type === value && a.type !== a.type_auto })),
      ],
    });
    if (type === null) return;
    return patchAccount(a, { type });
  }
  if (choice === 'hide') return patchAccount(a, { hidden: !a.hidden });
  if (choice === 'limit') {
    const result = await formSheet({ title: 'Credit limit', fields: [{ key: 'limit', label: 'Limit in dollars (blank to clear)', type: 'number', value: a.credit_limit === null ? '' : String(a.credit_limit) }] });
    if (!result || result === 'delete') return;
    return patchAccount(a, { credit_limit: result.limit === null || Number.isNaN(result.limit) ? null : result.limit });
  }
}

async function patchAccount(a, body) {
  try {
    await fapi(`/api/finances/accounts/${encodeURIComponent(a.id)}`, { method: 'PATCH', body });
    haptic('success');
    refresh();
  } catch (err) {
    toast(err && err.status ? err.message : "Couldn't save — the PC is unreachable", { kind: 'error' });
  }
}

// ---------------------------------------------------------------- all transactions

function renderTransactions() {
  const bar = navbar({ title: 'Transactions', back: true });
  root.replaceChildren(bar, el('div', { class: 'app-content fn-page' },
    txList(txs, { showAccount: true, emptyText: 'No transactions yet.' }),
    loadMoreButton(null)));
}

