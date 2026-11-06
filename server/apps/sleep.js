// Sleep & health log (sleep + resting heart rate). Routes, all under /api/sleep:
//   GET    /api/sleep/entries?days=30   -> { entries: [...] } newest first (days 1..365, default 30)
//   POST   /api/sleep/entries           body { date, bedtime, wake_time, quality?, resting_hr?, notes? }
//                                       date = the morning you woke up (YYYY-MM-DD). One entry per date:
//                                       posting an existing date updates it. -> 201 { entry }
//   PATCH  /api/sleep/entries/:id       body: any of the fields above (date included)
//   DELETE /api/sleep/entries/:id       -> 204
//   GET    /api/sleep/summary?days=7    -> { days, nights, avg_minutes, avg_quality, avg_hr,
//                                            goal_minutes, debt_minutes, bedtime_spread_minutes }
// Fields: bedtime/wake_time 'HH:MM' (24h), quality 1-5 or null, resting_hr 30-220 or null.
// minutes slept is computed (wake - bed, across midnight) and returned as `minutes`.
// Goal comes from settings key `sleep.goal_hours` (default 8). Tables: sleep_entries.
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const slept = (bed, wake) => (toMin(wake) - toMin(bed) + 1440) % 1440 || 1440;

function intOrNull(v, lo, hi, name) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${name} must be ${lo}-${hi}`);
  return n;
}

function clean(b, base = {}) {
  const o = { ...base };
  if ('date' in b) { if (!DATE.test(b.date || '')) throw new HttpError(400, 'date must be YYYY-MM-DD'); o.date = b.date; }
  if ('bedtime' in b) { if (!TIME.test(b.bedtime || '')) throw new HttpError(400, 'bedtime must be HH:MM'); o.bedtime = b.bedtime; }
  if ('wake_time' in b) { if (!TIME.test(b.wake_time || '')) throw new HttpError(400, 'wake_time must be HH:MM'); o.wake_time = b.wake_time; }
  if ('quality' in b) o.quality = intOrNull(b.quality, 1, 5, 'quality');
  if ('resting_hr' in b) o.resting_hr = intOrNull(b.resting_hr, 30, 220, 'resting_hr');
  if ('notes' in b) o.notes = String(b.notes ?? '').slice(0, 2000);
  if (!o.date || !o.bedtime || !o.wake_time) throw new HttpError(400, 'date, bedtime and wake_time are required');
  return o;
}

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

export default {
  id: 'sleep',
  migrations: [{
    id: 'sleep-1',
    sql: `CREATE TABLE IF NOT EXISTS sleep_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      bedtime TEXT NOT NULL,
      wake_time TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      quality INTEGER,
      resting_hr INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  }],

  register(r, ctx) {
    const { db } = ctx;
    const get = (id) => db.prepare('SELECT * FROM sleep_entries WHERE id = ?').get(id);
    const days = (q, def) => Math.min(365, Math.max(1, parseInt(q.days, 10) || def));
    const since = (n) => {
      const d = new Date(); d.setDate(d.getDate() - n);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    const goalMinutes = () => {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'sleep.goal_hours'").get();
      let h = 8;
      try { const v = Number(JSON.parse(row?.value)); if (v >= 3 && v <= 14) h = v; } catch { /* default */ }
      return Math.round(h * 60);
    };
    const plain = (row) => (row ? { ...row } : row);

    r.get('/api/sleep/entries', (req, res, { query }) => {
      const rows = db.prepare('SELECT * FROM sleep_entries WHERE date >= ? ORDER BY date DESC').all(since(days(query, 30)));
      return { entries: rows.map(plain) };
    });

    r.post('/api/sleep/entries', async (req, res) => {
      const o = clean(await readJsonBody(req));
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO sleep_entries (date, bedtime, wake_time, minutes, quality, resting_hr, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(date) DO UPDATE SET bedtime=excluded.bedtime, wake_time=excluded.wake_time, minutes=excluded.minutes,
          quality=excluded.quality, resting_hr=excluded.resting_hr, notes=excluded.notes, updated_at=excluded.updated_at`)
        .run(o.date, o.bedtime, o.wake_time, slept(o.bedtime, o.wake_time), o.quality ?? null, o.resting_hr ?? null, o.notes ?? '', now, now);
      sendJson(res, 201, { entry: plain(db.prepare('SELECT * FROM sleep_entries WHERE date = ?').get(o.date)) });
    });

    r.patch('/api/sleep/entries/:id', async (req, res, { params }) => {
      const cur = get(Number(params.id));
      if (!cur) throw new HttpError(404, 'entry not found');
      const o = clean(await readJsonBody(req), plain(cur));
      const clash = db.prepare('SELECT id FROM sleep_entries WHERE date = ? AND id != ?').get(o.date, cur.id);
      if (clash) throw new HttpError(409, 'an entry for that date already exists');
      db.prepare('UPDATE sleep_entries SET date=?, bedtime=?, wake_time=?, minutes=?, quality=?, resting_hr=?, notes=?, updated_at=? WHERE id=?')
        .run(o.date, o.bedtime, o.wake_time, slept(o.bedtime, o.wake_time), o.quality ?? null, o.resting_hr ?? null, o.notes ?? '', new Date().toISOString(), cur.id);
      return { entry: plain(get(cur.id)) };
    });

    r.delete('/api/sleep/entries/:id', (req, res, { params }) => {
      const info = db.prepare('DELETE FROM sleep_entries WHERE id = ?').run(Number(params.id));
      if (!Number(info.changes)) throw new HttpError(404, 'entry not found');
      sendEmpty(res, 204);
    });

    r.get('/api/sleep/summary', (req, res, { query }) => {
      const n = days(query, 7);
      const rows = db.prepare('SELECT * FROM sleep_entries WHERE date >= ? ORDER BY date DESC').all(since(n - 1));
      const goal = goalMinutes();
      const mins = rows.map((x) => x.minutes);
      // wrap the evening so 23:30 and 00:30 sit close together
      const beds = rows.map((x) => { const m = toMin(x.bedtime); return m < 720 ? m + 1440 : m; });
      return {
        days: n,
        nights: rows.length,
        avg_minutes: mins.length ? Math.round(avg(mins)) : null,
        avg_quality: avg(rows.filter((x) => x.quality).map((x) => x.quality)),
        avg_hr: avg(rows.filter((x) => x.resting_hr).map((x) => x.resting_hr)),
        goal_minutes: goal,
        debt_minutes: mins.reduce((a, m) => a + Math.max(0, goal - m), 0),
        bedtime_spread_minutes: beds.length > 1 ? Math.max(...beds) - Math.min(...beds) : null,
      };
    });
  },
};
