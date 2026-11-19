// Finances: net worth, cash, credit-card debt, crypto and investments from SimpleFIN Bridge
// (bridge.simplefin.org, which reads Chase, Wells Fargo, Coinbase and most US institutions).
// Read-only: nothing here can move money. Routes:
//   GET    /api/finances                      -> { connected, sync, summary, change, accounts }
//   GET    /api/finances/history?days=90&account=<id>
//                                             -> { points: [{date, net_worth, assets, debts}] }   days 7..3650 or 'all'
//                                                (with account: that account's balance as net_worth)
//   GET    /api/finances/transactions?account=<id>&before=<posted ISO>&limit=50
//                                             -> { transactions: [{account_id, account, id, posted, amount, description, payee, pending}], more }
//   PATCH  /api/finances/accounts/:id {type?, hidden?, nickname?}  -> { account }
//          type: auto | cash | credit | investment | crypto | loan | other ('auto' clears the override)
//   POST   /api/finances/sync                 -> same as GET /api/finances, after pulling fresh data
//                                                (at most once every 10 minutes; SimpleFIN allows ~24 pulls a day)
//   POST   /api/finances/connect {token}      -> same as GET /api/finances   (in-app only: the connector denies it)
//          token = a SimpleFIN setup token (base64 claim URL) or an access URL; only *.simplefin.org hosts
//   DELETE /api/finances/connect              -> 204  forgets the access URL; balances and history stay
//   PUT    /api/finances/goal {goal}          -> same as GET /api/finances. goal = an active goal measured in "$"
//                                                with a target, 0 = off, null = automatic (see below)
//
// Net-worth goal: after every successful pull, today's net worth becomes a check-in on the linked
// Goals goal (note "Net worth from Finances"; one per day, replaced on later pulls that day), so the
// goal's progress follows the money. Setting `finances.goal`: a goal id, 0 for off, or unset for
// automatic = the one active Money goal measured in "$" with a target, when there is exactly one.
// Check-ins go through the Goals routes on the loopback address, so Goals keeps its own rules.
// GET /api/finances adds goal_link: { goal_id, title, target_value, current_value, progress, target_date, auto } | null.
//
// The access URL (it carries the credentials) lives in DATA/finances/simplefin, mode 600. It is
// never stored in the database, never returned by a route and never logged.
//
// summary: { net_worth, assets, debts, cash, credit, investment, crypto, loan, other, as_of }
//   balances follow SimpleFIN's sign: money owed on a card or loan is negative. `credit` and `loan`
//   are reported as positive amounts owed. Hidden accounts count toward nothing.
// change: { days: 30, net_worth: <delta> | null } against the closest snapshot at least 30 days old.
// account: { id, name, nickname, org, type, type_auto, hidden, balance, available, currency,
//            balance_date, holdings_value, updated_at }
// One balance snapshot per account per day (the latest pull that day) feeds the history chart;
// a day with no pull carries the previous balance forward, and days before an account's first
// snapshot use that first balance. When a bank or card account first appears, its balances for
// the days its transactions cover (about 45) are rebuilt by walking those transactions back from
// today's balance; investment and crypto values move with prices, so they start flat instead.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonBody, sendEmpty, HttpError } from '../http.js';
import { now, text, localDay } from './_lib.js';

export const TYPES = ['cash', 'credit', 'investment', 'crypto', 'loan', 'other'];
const SYNC_EVERY_MS = 4 * 3600_000;
const FIRST_SYNC_DELAY_MS = 20_000;
const MANUAL_GAP_MS = 10 * 60_000;
const FIRST_HISTORY_DAYS = 40;      // under SimpleFIN's recommended 45-day maximum per pull
const OVERLAP_DAYS = 5;
const FETCH_TIMEOUT_MS = 45_000;
const MAIN_PORT = Number(process.env.JAKESDATA_PORT) || 4800;
const GOAL_SETTING = 'finances.goal';
const GOAL_NOTE = 'Net worth from Finances';

export default {
  id: 'finances',
  migrations: [
    {
      id: 'finances-1',
      sql: `
        CREATE TABLE IF NOT EXISTS finances_accounts (
          id             TEXT    PRIMARY KEY,
          org            TEXT    NOT NULL DEFAULT '',
          org_domain     TEXT    NOT NULL DEFAULT '',
          name           TEXT    NOT NULL DEFAULT '',
          nickname       TEXT    NOT NULL DEFAULT '',
          currency       TEXT    NOT NULL DEFAULT 'USD',
          balance        REAL    NOT NULL DEFAULT 0,
          available      REAL,
          balance_date   TEXT,
          holdings_value REAL,
          type_override  TEXT,
          hidden         INTEGER NOT NULL DEFAULT 0,
          created_at     TEXT    NOT NULL,
          updated_at     TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS finances_balances (
          account_id TEXT NOT NULL,
          date       TEXT NOT NULL,
          balance    REAL NOT NULL,
          PRIMARY KEY (account_id, date)
        );
        CREATE TABLE IF NOT EXISTS finances_transactions (
          account_id  TEXT    NOT NULL,
          id          TEXT    NOT NULL,
          posted      TEXT    NOT NULL,
          amount      REAL    NOT NULL,
          description TEXT    NOT NULL DEFAULT '',
          payee       TEXT    NOT NULL DEFAULT '',
          memo        TEXT    NOT NULL DEFAULT '',
          pending     INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (account_id, id)
        );
        CREATE INDEX IF NOT EXISTS finances_transactions_posted ON finances_transactions(posted DESC);
        CREATE TABLE IF NOT EXISTS finances_sync (
          id           INTEGER PRIMARY KEY CHECK (id = 1),
          last_attempt TEXT,
          last_success TEXT,
          last_error   TEXT    NOT NULL DEFAULT '',
          messages     TEXT    NOT NULL DEFAULT '[]'
        );
      `,
    },
  ],
  register(r, ctx) {
    const repo = financesRepo(ctx.db);
    const secretFile = path.join(ctx.dataDir, 'finances', 'simplefin');
    const log = ctx.log;
    let running = null;

    const readAccess = () => {
      try { return fs.readFileSync(secretFile, 'utf8').trim() || null; } catch { return null; }
    };
    const writeAccess = (url) => {
      fs.mkdirSync(path.dirname(secretFile), { recursive: true, mode: 0o700 });
      const tmp = `${secretFile}.tmp`;
      fs.writeFileSync(tmp, url, { mode: 0o600 });
      fs.renameSync(tmp, secretFile);
    };

    // ---- the net-worth goal
    const goalRow = (id) => {
      try { return ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) || null; } catch { return null; } // Goals not installed
    };
    function linkedGoal() {
      const raw = ctx.settings.get(GOAL_SETTING, null);
      if (raw === 0 || raw === '0') return null;
      if (raw !== null && raw !== undefined && raw !== '') {
        const row = goalRow(Number(raw));
        return row && row.status === 'active' && row.unit === '$' ? { row, auto: false } : null;
      }
      try {
        const rows = ctx.db.prepare("SELECT * FROM goals WHERE status = 'active' AND area = 'money' AND unit = '$' AND target_value IS NOT NULL").all();
        return rows.length === 1 ? { row: rows[0], auto: true } : null;
      } catch { return null; }
    }
    async function goalsApi(method, p, body) {
      const res = await fetch(`http://127.0.0.1:${MAIN_PORT}${p}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}`);
      return res.status === 204 ? null : res.json();
    }
    // Today's net worth as the goal's check-in: at most one per day, replaced when it changes.
    async function checkInGoal() {
      const link = linkedGoal();
      const { summary, accounts } = repo.overview();
      if (!link || !accounts.some((a) => !a.hidden)) return;
      const value = summary.net_worth;
      const today = localDay();
      try {
        const { goal } = await goalsApi('GET', `/api/goals/${link.row.id}`);
        const mine = goal.checkins.filter((c) => c.date === today && c.note === GOAL_NOTE);
        if (mine.length === 1 && mine[0].value === value) return;
        for (const c of mine) await goalsApi('DELETE', `/api/goals/${goal.id}/checkins/${c.id}`);
        await goalsApi('POST', `/api/goals/${goal.id}/checkins`, { date: today, value, note: GOAL_NOTE });
      } catch (err) {
        log.warn(`net-worth check-in on goal ${link.row.id} failed: ${err.message}`);
      }
    }

    const overview = () => {
      const link = linkedGoal();
      let goalLink = null;
      if (link) {
        const g = link.row;
        const span = g.target_value !== null && g.start_value !== null ? g.target_value - g.start_value : 0;
        goalLink = {
          goal_id: g.id, title: g.title, target_value: g.target_value, current_value: g.current_value, target_date: g.target_date,
          progress: span ? Math.max(0, Math.min(1, ((g.current_value ?? g.start_value) - g.start_value) / span)) : null, auto: link.auto,
        };
      }
      return { connected: Boolean(readAccess()), ...repo.overview(), goal_link: goalLink };
    };

    // One pull at a time; a second caller waits for the one in flight.
    function sync(reason) {
      if (running) return running;
      const access = readAccess();
      if (!access) return Promise.resolve(false);
      running = (async () => {
        const started = now();
        repo.markAttempt(started);
        try {
          const since = repo.lastSuccess();
          const days = since ? Math.min(FIRST_HISTORY_DAYS, Math.ceil((Date.now() - Date.parse(since)) / 86_400_000) + OVERLAP_DAYS) : FIRST_HISTORY_DAYS;
          const data = await fetchAccounts(access, { startDate: Math.floor(Date.now() / 1000) - days * 86_400 });
          const count = repo.store(data.accounts, started);
          repo.markSuccess(started, data.messages);
          log.info(`synced ${count} account${count === 1 ? '' : 's'} (${reason})`);
          await checkInGoal();
          return true;
        } catch (err) {
          const message = err instanceof HttpError ? err.message : 'Could not reach SimpleFIN';
          repo.markError(message);
          log.warn(`sync failed (${reason}): ${err && err.status ? `HTTP ${err.status}` : (err && err.name) || 'error'}`);
          return false;
        } finally {
          running = null;
        }
      })();
      return running;
    }

    setTimeout(() => { sync('startup'); }, FIRST_SYNC_DELAY_MS).unref();
    setInterval(() => { sync('schedule'); }, SYNC_EVERY_MS).unref();

    r.get('/api/finances', () => overview());

    r.get('/api/finances/history', (req, res, { query }) => {
      const raw = query.days === undefined || query.days === '' ? '90' : String(query.days);
      let days = null;
      if (raw !== 'all') {
        days = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
        if (!(days >= 7 && days <= 3650)) throw new HttpError(400, "days must be 7..3650 or 'all'");
      }
      const account = query.account ? String(query.account) : null;
      if (account && !repo.account(account)) throw new HttpError(404, 'account not found');
      return { points: repo.history(days, account) };
    });

    r.get('/api/finances/transactions', (req, res, { query }) => {
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be 1..200');
      const before = query.before ? String(query.before) : null;
      if (before && Number.isNaN(Date.parse(before))) throw new HttpError(400, 'before must be an ISO date');
      const account = query.account ? String(query.account) : null;
      if (account && !repo.account(account)) throw new HttpError(404, 'account not found');
      return repo.transactions({ account, before, limit });
    });

    r.patch('/api/finances/accounts/:id', async (req, res, { params }) => {
      const current = repo.account(params.id);
      if (!current) throw new HttpError(404, 'account not found');
      const body = await readJsonBody(req);
      if (!Object.keys(body).length) throw new HttpError(400, 'nothing to update');
      const next = { type_override: current.type_override, hidden: current.hidden, nickname: current.nickname };
      if (body.type !== undefined) {
        if (body.type !== 'auto' && !TYPES.includes(body.type)) throw new HttpError(400, `type must be auto or one of ${TYPES.join(', ')}`);
        next.type_override = body.type === 'auto' ? null : body.type;
      }
      if (body.hidden !== undefined) {
        if (typeof body.hidden !== 'boolean') throw new HttpError(400, 'hidden must be true or false');
        next.hidden = body.hidden;
      }
      if (body.nickname !== undefined) next.nickname = text(body.nickname, 'nickname', { max: 80 });
      repo.updateAccount(current.id, next);
      return { account: repo.accountOut(repo.account(current.id)) };
    });

    r.post('/api/finances/sync', async () => {
      if (!readAccess()) throw new HttpError(409, 'SimpleFIN is not connected yet');
      const last = repo.lastAttempt();
      if (!running && last && Date.now() - Date.parse(last) < MANUAL_GAP_MS) {
        throw new HttpError(429, 'Updated a few minutes ago. SimpleFIN allows about 24 updates a day, so try again in a little while.');
      }
      await sync('manual');
      return overview();
    });

    r.post('/api/finances/connect', async (req) => {
      const body = await readJsonBody(req);
      const token = typeof body.token === 'string' ? body.token.trim().replace(/\s+/g, '') : '';
      if (!token) throw new HttpError(400, 'Paste a SimpleFIN setup token');
      if (token.length > 2000) throw new HttpError(400, 'That is too long to be a SimpleFIN token');
      const access = /^https:\/\//i.test(token) ? checkedUrl(token, { needsCredentials: true }) : await claim(token);
      // Prove it works before saving it (a balances-only pull is cheap).
      await fetchAccounts(access, { balancesOnly: true });
      writeAccess(access);
      log.info('SimpleFIN connected');
      await sync('connect');
      return overview();
    });

    r.put('/api/finances/goal', async (req) => {
      const body = await readJsonBody(req);
      if (!Object.hasOwn(body, 'goal')) throw new HttpError(400, 'send { goal: <goal id> | 0 | null }');
      const goal = body.goal;
      if (goal === null) ctx.settings.patch({ [GOAL_SETTING]: null });
      else if (goal === 0) ctx.settings.patch({ [GOAL_SETTING]: 0 });
      else {
        if (!Number.isInteger(goal) || goal < 1) throw new HttpError(400, 'goal must be a goal id, 0 or null');
        const row = goalRow(goal);
        if (!row) throw new HttpError(404, 'goal not found');
        if (row.status !== 'active') throw new HttpError(409, 'that goal is not active');
        if (row.unit !== '$' || row.target_value === null) throw new HttpError(409, 'only a goal measured in $ with a target can follow net worth');
        ctx.settings.patch({ [GOAL_SETTING]: goal });
      }
      await checkInGoal();
      return overview();
    });

    r.delete('/api/finances/connect', (req, res) => {
      fs.rmSync(secretFile, { force: true });
      repo.markError('');
      log.info('SimpleFIN disconnected');
      sendEmpty(res, 204);
    });
  },
};

// ---------------------------------------------------------------- SimpleFIN protocol

// Only SimpleFIN's own hosts: this server POSTs to the claim URL and sends credentials to the
// access URL, so neither may point anywhere else (a LAN address, say).
function checkedUrl(raw, { needsCredentials }) {
  let u;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'That is not a SimpleFIN token or access URL'); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !(host === 'simplefin.org' || host.endsWith('.simplefin.org'))) {
    throw new HttpError(400, 'Only SimpleFIN (simplefin.org) links are accepted');
  }
  if (needsCredentials && (!u.username || !u.password)) throw new HttpError(400, 'That access URL has no credentials in it');
  return u.toString();
}

async function claim(setupToken) {
  let claimUrl;
  try {
    claimUrl = Buffer.from(setupToken, 'base64').toString('utf8').trim();
  } catch {
    throw new HttpError(400, 'That is not a SimpleFIN setup token');
  }
  if (!/^https:\/\//i.test(claimUrl)) throw new HttpError(400, 'That is not a SimpleFIN setup token');
  claimUrl = checkedUrl(claimUrl, { needsCredentials: false });
  let res;
  try {
    res = await fetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new HttpError(502, 'Could not reach SimpleFIN to claim the token');
  }
  if (res.status === 403) throw new HttpError(400, 'SimpleFIN says this setup token was already used or has expired. Make a new one at bridge.simplefin.org.');
  if (!res.ok) throw new HttpError(502, `SimpleFIN refused the token (HTTP ${res.status})`);
  return checkedUrl((await res.text()).trim(), { needsCredentials: true });
}

// GET {access}/accounts with Basic auth (fetch refuses credentials inside the URL).
// -> { accounts: [...], messages: [string] }
async function fetchAccounts(access, { startDate, balancesOnly = false } = {}) {
  const u = new URL(access);
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}/accounts`;
  const qs = new URLSearchParams();
  if (balancesOnly) qs.set('balances-only', '1');
  else {
    qs.set('pending', '1');
    if (startDate) qs.set('start-date', String(startDate));
  }
  let res;
  try {
    res = await fetch(`${base}?${qs}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new HttpError(502, 'Could not reach SimpleFIN');
  }
  if (res.status === 403) throw new HttpError(400, 'SimpleFIN rejected the saved access. Connect again with a new setup token.');
  if (res.status === 402) throw new HttpError(400, 'SimpleFIN says the subscription needs payment.');
  if (!res.ok) throw new HttpError(502, `SimpleFIN answered HTTP ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new HttpError(502, 'SimpleFIN sent something that is not JSON'); }
  const messages = [
    ...(Array.isArray(data.errors) ? data.errors : []),
    ...(Array.isArray(data.errlist) ? data.errlist.map((e) => (e && typeof e === 'object' ? e.msg || e.message : e)) : []),
  ].filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim().slice(0, 300)).slice(0, 10);
  return { accounts: Array.isArray(data.accounts) ? data.accounts : [], messages };
}

// ---------------------------------------------------------------- classification

const CRYPTO_ORG = /coinbase|kraken|gemini|binance|crypto\.com|bitstamp|cash app investing|river financial|strike/i;
const LOAN = /\b(loan|mortgage|heloc|student|auto ?finance|car payment)\b/i;
const CREDIT = /credit|card|visa|mastercard|master card|amex|american express|discover it|sapphire|freedom|slate|ink |active cash|autograph|reflect|platinum|signify|bilt|venture|quicksilver|savor/i;
const INVEST = /brokerage|invest|\bira\b|roth|401 ?\(?k\)?|403 ?\(?b\)?|hsa|retirement|robinhood|fidelity|schwab|vanguard|e\*?trade|webull|individual|joint taxable/i;
const CASH = /checking|savings|money market|\bcash\b|everyday|way2save|premier|total checking|\bspend\b/i;
const FIAT = /^[A-Z]{3}$/;

export function autoType({ org = '', name = '', currency = 'USD', balance = 0, holdings_value = null }) {
  const both = `${org} ${name}`;
  if (CRYPTO_ORG.test(org) || (currency && !FIAT.test(currency))) return 'crypto';
  if (LOAN.test(name)) return 'loan';
  if (CREDIT.test(name)) return 'credit';
  if (holdings_value || INVEST.test(both)) return 'investment';
  if (CASH.test(name)) return 'cash';
  return balance < 0 ? 'credit' : 'cash';
}

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const unixIso = (s) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};
const clip = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max) : '');

// ---------------------------------------------------------------- storage

function financesRepo(db) {
  const accGet = db.prepare('SELECT * FROM finances_accounts WHERE id = ?');
  const accAll = db.prepare('SELECT * FROM finances_accounts ORDER BY org COLLATE NOCASE, name COLLATE NOCASE');
  const accUpsert = db.prepare(`
    INSERT INTO finances_accounts (id, org, org_domain, name, currency, balance, available, balance_date, holdings_value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET org = excluded.org, org_domain = excluded.org_domain, name = excluded.name,
      currency = excluded.currency, balance = excluded.balance, available = excluded.available,
      balance_date = excluded.balance_date, holdings_value = excluded.holdings_value, updated_at = excluded.updated_at`);
  const accUpdate = db.prepare('UPDATE finances_accounts SET type_override = ?, hidden = ?, nickname = ? WHERE id = ?');
  const balUpsert = db.prepare(`INSERT INTO finances_balances (account_id, date, balance) VALUES (?, ?, ?)
    ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance`);
  const balBackfill = db.prepare('INSERT OR IGNORE INTO finances_balances (account_id, date, balance) VALUES (?, ?, ?)');
  const balAll = db.prepare('SELECT account_id, date, balance FROM finances_balances ORDER BY date');
  const txUpsert = db.prepare(`
    INSERT INTO finances_transactions (account_id, id, posted, amount, description, payee, memo, pending)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, id) DO UPDATE SET posted = excluded.posted, amount = excluded.amount,
      description = excluded.description, payee = excluded.payee, memo = excluded.memo, pending = excluded.pending`);
  // A pending charge usually comes back posted under a new id: drop the account's pending rows
  // in the pulled window before writing the fresh ones.
  const txDropPending = db.prepare('DELETE FROM finances_transactions WHERE account_id = ? AND pending = 1 AND posted >= ?');
  const syncGet = db.prepare('SELECT * FROM finances_sync WHERE id = 1');
  const syncEnsure = db.prepare('INSERT OR IGNORE INTO finances_sync (id) VALUES (1)');
  const syncAttempt = db.prepare('UPDATE finances_sync SET last_attempt = ? WHERE id = 1');
  const syncOk = db.prepare("UPDATE finances_sync SET last_success = ?, last_error = '', messages = ? WHERE id = 1");
  const syncErr = db.prepare('UPDATE finances_sync SET last_error = ? WHERE id = 1');

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const typeOf = (row) => row.type_override || autoType(row);

  function accountOut(row) {
    return {
      id: row.id, name: row.name, nickname: row.nickname, org: row.org, type: typeOf(row), type_auto: autoType(row),
      hidden: Boolean(row.hidden), balance: row.balance, available: row.available, currency: row.currency,
      balance_date: row.balance_date, holdings_value: row.holdings_value, updated_at: row.updated_at,
    };
  }

  function summarize(rows) {
    const s = { net_worth: 0, assets: 0, debts: 0, cash: 0, credit: 0, investment: 0, crypto: 0, loan: 0, other: 0, as_of: null };
    for (const row of rows) {
      if (row.hidden) continue;
      const type = typeOf(row);
      const b = row.balance;
      s.net_worth += b;
      if (b >= 0) s.assets += b; else s.debts -= b;
      if (type === 'credit' || type === 'loan') s[type] -= b; else s[type] += b;
      if (row.balance_date && (!s.as_of || row.balance_date > s.as_of)) s.as_of = row.balance_date;
    }
    for (const k of Object.keys(s)) if (typeof s[k] === 'number') s[k] = Math.round(s[k] * 100) / 100;
    return s;
  }

  // Net worth per day from the snapshots, carrying each account's last balance forward.
  function history(days, accountId = null) {
    const visible = new Set(accAll.all().filter((a) => (accountId ? a.id === accountId : !a.hidden)).map((a) => a.id));
    const rows = balAll.all().filter((r) => visible.has(r.account_id));
    if (!rows.length) return [];
    const byDate = new Map();
    // Before its first snapshot an account counts at that first balance, so an account that
    // appears later does not show up as a jump in net worth.
    const current = new Map();
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
      if (!current.has(r.account_id)) current.set(r.account_id, r.balance);
    }
    const first = rows[0].date;
    const last = localDay();
    const from = days ? localDay(new Date(Date.now() - (days - 1) * 86_400_000)) : first;
    const points = [];
    for (let d = new Date(`${first}T12:00:00`); localDay(d) <= last; d.setDate(d.getDate() + 1)) {
      const key = localDay(d);
      for (const r of byDate.get(key) || []) current.set(r.account_id, r.balance);
      if (key < from) continue;
      let assets = 0;
      let debts = 0;
      for (const b of current.values()) { if (b >= 0) assets += b; else debts -= b; }
      points.push({ date: key, net_worth: Math.round((assets - debts) * 100) / 100, assets: Math.round(assets * 100) / 100, debts: Math.round(debts * 100) / 100 });
    }
    return points;
  }

  return {
    account: (id) => accGet.get(String(id)) || null,
    accountOut,
    updateAccount(id, next) {
      accUpdate.run(next.type_override, next.hidden ? 1 : 0, next.nickname, id);
    },
    overview() {
      syncEnsure.run();
      const rows = accAll.all();
      const summary = summarize(rows);
      const pts = history(null);
      let change = { days: 30, net_worth: null };
      if (pts.length) {
        const target = localDay(new Date(Date.now() - 30 * 86_400_000));
        const old = [...pts].reverse().find((p) => p.date <= target);
        if (old) change = { days: 30, net_worth: Math.round((summary.net_worth - old.net_worth) * 100) / 100 };
      }
      const s = syncGet.get();
      let messages = [];
      try { messages = JSON.parse(s.messages || '[]'); } catch { /* keep [] */ }
      return {
        sync: { last_attempt: s.last_attempt, last_success: s.last_success, last_error: s.last_error, messages },
        summary, change, accounts: rows.map(accountOut),
      };
    },
    history,
    transactions({ account, before, limit }) {
      const where = [];
      const args = [];
      if (account) { where.push('t.account_id = ?'); args.push(account); }
      if (before) { where.push('t.posted < ?'); args.push(new Date(before).toISOString()); }
      const sql = `SELECT t.*, a.name AS account_name, a.nickname AS account_nickname FROM finances_transactions t
        LEFT JOIN finances_accounts a ON a.id = t.account_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.posted DESC, t.id DESC LIMIT ?`;
      const rows = db.prepare(sql).all(...args, limit + 1);
      return {
        transactions: rows.slice(0, limit).map((t) => ({
          account_id: t.account_id, account: t.account_nickname || t.account_name || '', id: t.id, posted: t.posted,
          amount: t.amount, description: t.description, payee: t.payee, pending: Boolean(t.pending),
        })),
        more: rows.length > limit,
      };
    },
    store(accounts, ts) {
      return tx(() => {
        let count = 0;
        for (const a of accounts) {
          if (!a || typeof a !== 'object' || a.id === undefined) continue;
          const org = a.org && typeof a.org === 'object' ? a.org : {};
          // A short stable hash: SimpleFIN ids are only unique per institution and may hold
          // characters that do not belong in a URL path.
          const orgKey = String(org.id || org.domain || org.name || 'org');
          const id = createHash('sha1').update(`${orgKey}\n${String(a.id)}`).digest('hex').slice(0, 16);
          const balance = money(a.balance);
          if (balance === null) continue;
          const holdings = Array.isArray(a.holdings) && a.holdings.length
            ? money(a.holdings.reduce((n, h) => n + (Number(h && h.market_value) || 0), 0)) : null;
          const balanceDate = unixIso(a['balance-date']) || ts;
          const orgName = clip(org.name || org.domain || '', 120);
          const name = clip(a.name || 'Account', 160);
          const currency = clip(a.currency || 'USD', 80) || 'USD';
          const isNew = !accGet.get(id);
          accUpsert.run(id, orgName, clip(org.domain || '', 120), name, currency, balance, money(a['available-balance']), balanceDate, holdings, ts, ts);
          const today = localDay(new Date(ts));
          balUpsert.run(id, today, balance);
          const txs = (Array.isArray(a.transactions) ? a.transactions : [])
            .filter((t) => t && t.id !== undefined)
            .map((t) => ({ t, amount: money(t.amount), when: unixIso(t.posted) || unixIso(t.transacted_at) }))
            .filter((x) => x.amount !== null && x.when);
          if (txs.length) txDropPending.run(id, txs.map((x) => x.when).sort()[0]);
          for (const { t, amount, when } of txs) {
            txUpsert.run(id, clip(String(t.id), 200), when, amount, clip(t.description || '', 300), clip(t.payee || '', 200), clip(t.memo || '', 300), t.pending ? 1 : 0);
          }
          const kind = autoType({ org: orgName, name, currency, balance, holdings_value: holdings });
          const settled = txs.filter((x) => !x.t.pending).map((x) => ({ day: localDay(new Date(x.when)), amount: x.amount }));
          if (isNew && settled.length && ['cash', 'credit', 'loan'].includes(kind)) {
            // End-of-day balance = today's balance minus everything that posted after that day.
            const d = new Date(`${settled.reduce((m, x) => (x.day < m ? x.day : m), today)}T12:00:00`);
            d.setDate(d.getDate() - 1);
            for (; localDay(d) < today; d.setDate(d.getDate() + 1)) {
              const key = localDay(d);
              const later = settled.reduce((n, x) => (x.day > key ? n + x.amount : n), 0);
              balBackfill.run(id, key, Math.round((balance - later) * 100) / 100);
            }
          }
          count += 1;
        }
        return count;
      });
    },
    lastSuccess: () => { syncEnsure.run(); return syncGet.get().last_success; },
    lastAttempt: () => { syncEnsure.run(); return syncGet.get().last_attempt; },
    markAttempt: (ts) => { syncEnsure.run(); syncAttempt.run(ts); },
    markSuccess: (ts, messages) => syncOk.run(ts, JSON.stringify(messages || [])),
    markError: (message) => { syncEnsure.run(); syncErr.run(message || ''); },
  };
}
