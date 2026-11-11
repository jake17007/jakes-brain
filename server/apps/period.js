// Period: a menstrual cycle tracker. One row per logged day (flow, symptoms, note); periods,
// cycle lengths and predictions are worked out from those days on every read. Routes:
//   GET    /api/period                     -> { today, days, periods, stats, current, prediction }
//   GET    /api/period/days/:date          -> { day }   (an empty day when nothing is logged)
//   PUT    /api/period/days/:date {flow?, symptoms?, note?} -> { day, summary }  upsert (fields left out keep their value)
//   DELETE /api/period/days/:date          -> { summary }  clear the day (idempotent)
//   PUT    /api/period/range {start, end, flow?} -> { summary }  set the flow on every day start..end
//                                            (default "medium"; symptoms and notes are kept). Handy for back-filling.
//
// flow is one of none | spotting | light | medium | heavy (null/"none" = no bleeding that day).
// symptoms is a list from SYMPTOMS below. note is free text (max 500).
// A period is a run of light/medium/heavy days; a gap of one unlogged day inside a run does
// not end it, and spotting never starts one. A cycle runs from one period's start to the next.
//
// Every reply's maths uses `today` from the query (the phone's local 'YYYY-MM-DD'; default
// the server's local date) and `days` covers `from`..`to` (defaults: 13 months back .. today).
// summary = { periods, stats, current, prediction } (the GET without `days`).
//   periods:    [{ start, end, length, cycle_length }]  newest first; cycle_length = days to the next start (null for the latest)
//   stats:      { avg_cycle, avg_period, cycles_tracked, shortest_cycle, longest_cycle, defaulted }
//               averages use the last 6 cycles of 15..60 days; defaulted = true while fewer than one such cycle exists (28 / 5 assumed)
//   current:    { cycle_day, on_period, period_day, phase } or null before the first period
//               phase: period | follicular | fertile | ovulation | luteal | late
//   prediction: { next_start, next_end, days_until, late_by, ovulation, fertile_start, fertile_end, upcoming: [{start,end}] x3 } or null
// Predictions are estimates from averages only.
import { readJsonBody, HttpError } from '../http.js';

const FLOWS = ['spotting', 'light', 'medium', 'heavy'];
const BLEEDING = new Set(['light', 'medium', 'heavy']);
const SYMPTOMS = [
  'cramps', 'headache', 'bloating', 'tender_breasts', 'acne', 'fatigue', 'mood_swings',
  'back_pain', 'nausea', 'cravings', 'insomnia', 'anxiety',
];
const NOTE_MAX = 500;
const DEFAULT_CYCLE = 28;
const DEFAULT_PERIOD = 5;
const LUTEAL_DAYS = 14;        // ovulation ≈ next start − 14
const CYCLES_FOR_AVG = 6;
const CYCLE_MIN = 15;
const CYCLE_MAX = 60;
const RANGE_MAX_DAYS = 15;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export default {
  id: 'period',
  migrations: [
    {
      id: 'period-1',
      sql: `
        CREATE TABLE IF NOT EXISTS period_days (
          date       TEXT PRIMARY KEY,
          flow       TEXT,
          symptoms   TEXT NOT NULL DEFAULT '[]',
          note       TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );
      `,
    },
  ],
  register(r, ctx) {
    const repo = periodRepo(ctx.db);
    const summaryFor = (query) => summarize(repo.all(), todayFrom(query));

    r.get('/api/period', (req, res, { query }) => {
      const today = todayFrom(query);
      const to = query.to !== undefined ? needDay(query.to, 'to') : today;
      const from = query.from !== undefined ? needDay(query.from, 'from') : addDays(today, -400);
      if (from > to) throw new HttpError(400, 'from is after to');
      const all = repo.all();
      return { today, from, to, days: all.filter((d) => d.date >= from && d.date <= to), ...summarize(all, today) };
    });

    r.get('/api/period/days/:date', (req, res, { params }) => {
      const date = needDay(params.date, 'date');
      return { day: repo.get(date) || emptyDay(date) };
    });

    r.put('/api/period/days/:date', async (req, res, { params, query }) => {
      const today = todayFrom(query);
      const date = needDay(params.date, 'date');
      if (date > today) throw new HttpError(400, 'date is in the future');
      const body = await readJsonBody(req);
      const current = repo.get(date) || emptyDay(date);
      const next = { ...current };
      if (body.flow !== undefined) next.flow = validateFlow(body.flow);
      if (body.symptoms !== undefined) next.symptoms = validateSymptoms(body.symptoms);
      if (body.note !== undefined) next.note = validateNote(body.note);
      if (body.flow === undefined && body.symptoms === undefined && body.note === undefined) {
        throw new HttpError(400, 'nothing to update: send flow, symptoms and/or note');
      }
      const day = repo.put(next);
      return { day: day || emptyDay(date), summary: summaryFor(query) };
    });

    r.delete('/api/period/days/:date', (req, res, { params, query }) => {
      repo.remove(needDay(params.date, 'date'));
      return { summary: summaryFor(query) };
    });

    r.put('/api/period/range', async (req, res, { query }) => {
      const today = todayFrom(query);
      const body = await readJsonBody(req);
      const start = needDay(body.start, 'start');
      const end = body.end === undefined || body.end === null ? start : needDay(body.end, 'end');
      if (start > end) throw new HttpError(400, 'start is after end');
      if (end > today) throw new HttpError(400, 'end is in the future');
      if (diffDays(start, end) + 1 > RANGE_MAX_DAYS) throw new HttpError(400, `a range is at most ${RANGE_MAX_DAYS} days`);
      const flow = body.flow === undefined ? 'medium' : validateFlow(body.flow);
      repo.transaction(() => {
        for (let d = start; d <= end; d = addDays(d, 1)) {
          const current = repo.get(d) || emptyDay(d);
          repo.put({ ...current, flow });
        }
      });
      return { summary: summaryFor(query) };
    });
  },
};

// ---------------------------------------------------------------- validation

function validateFlow(flow) {
  if (flow === null || flow === 'none' || flow === '') return null;
  if (typeof flow !== 'string' || !FLOWS.includes(flow)) throw new HttpError(400, `flow must be one of none, ${FLOWS.join(', ')}`);
  return flow;
}

function validateSymptoms(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'symptoms must be a list');
  for (const s of list) {
    if (!SYMPTOMS.includes(s)) throw new HttpError(400, `unknown symptom "${String(s).slice(0, 40)}" (use: ${SYMPTOMS.join(', ')})`);
  }
  return SYMPTOMS.filter((s) => list.includes(s));
}

function validateNote(note) {
  if (note === null) return '';
  if (typeof note !== 'string') throw new HttpError(400, 'note must be a string');
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX) throw new HttpError(400, `note is too long (max ${NOTE_MAX} characters)`);
  if (CONTROL_CHARS.test(trimmed)) throw new HttpError(400, 'note contains control characters');
  return trimmed;
}

// ---------------------------------------------------------------- day keys ('YYYY-MM-DD', UTC maths)

const two = (n) => String(n).padStart(2, '0');

function parseDay(raw) {
  const m = DATE_RE.exec(String(raw));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return keyOf(dt);
}

function needDay(raw, name) {
  const day = parseDay(raw);
  if (!day) throw new HttpError(400, `${name} must be a valid YYYY-MM-DD date`);
  return day;
}

function keyOf(dt) {
  return `${dt.getUTCFullYear()}-${two(dt.getUTCMonth() + 1)}-${two(dt.getUTCDate())}`;
}

function toUtc(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return keyOf(new Date(Date.UTC(y, m - 1, d + n)));
}

function diffDays(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function todayFrom(query = {}) {
  if (query.today === undefined) return localToday();
  return needDay(query.today, 'today');
}

// ---------------------------------------------------------------- the maths

// Runs of bleeding days (a single unlogged/spotting day inside a run is bridged).
export function findPeriods(days) {
  const bleeding = days.filter((d) => BLEEDING.has(d.flow)).map((d) => d.date).sort();
  const periods = [];
  for (const date of bleeding) {
    const last = periods[periods.length - 1];
    if (last && diffDays(last.end, date) <= 2) last.end = date;
    else periods.push({ start: date, end: date });
  }
  return periods.map((p) => ({ ...p, length: diffDays(p.start, p.end) + 1 }));
}

const round1 = (n) => Math.round(n * 10) / 10;

export function summarize(days, today) {
  const asc = findPeriods(days.filter((d) => d.date <= today));
  for (let i = 0; i < asc.length; i++) {
    asc[i].cycle_length = i + 1 < asc.length ? diffDays(asc[i].start, asc[i + 1].start) : null;
  }
  const usable = asc.map((p) => p.cycle_length).filter((n) => n !== null && n >= CYCLE_MIN && n <= CYCLE_MAX);
  const recent = usable.slice(-CYCLES_FOR_AVG);
  // The latest period may still be going on, so it only counts toward the average once over.
  const finished = asc.filter((p) => p.end < addDays(today, -1)).slice(-CYCLES_FOR_AVG);
  const avgCycle = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : DEFAULT_CYCLE;
  const avgPeriod = finished.length ? finished.reduce((a, p) => a + p.length, 0) / finished.length : DEFAULT_PERIOD;
  const stats = {
    avg_cycle: round1(avgCycle),
    avg_period: round1(avgPeriod),
    cycles_tracked: usable.length,
    shortest_cycle: usable.length ? Math.min(...usable) : null,
    longest_cycle: usable.length ? Math.max(...usable) : null,
    defaulted: recent.length === 0,
  };
  const periods = asc.slice().reverse();
  const last = asc[asc.length - 1];
  if (!last) return { periods, stats, current: null, prediction: null };

  const cycle = Math.round(avgCycle);
  const periodLen = Math.max(1, Math.round(avgPeriod));
  const cycleDay = diffDays(last.start, today) + 1;
  // Still on it when the last bleeding day is today, or yesterday and today has no flow logged
  // yet (spotting logged today ends it).
  const todayRow = days.find((d) => d.date === today);
  const onPeriod = last.end === today || (last.end === addDays(today, -1) && !(todayRow && todayRow.flow));

  let nextStart = addDays(last.start, cycle);
  const lateBy = !onPeriod && today > nextStart ? diffDays(nextStart, today) : 0;
  // Once late, the next one is "any day now": keep showing the overdue date rather than skipping a cycle.
  const ovulation = addDays(nextStart, -LUTEAL_DAYS);
  const fertileStart = addDays(ovulation, -5);
  const fertileEnd = addDays(ovulation, 1);
  const upcoming = [];
  for (let i = 0; i < 3; i++) {
    const s = addDays(nextStart, i * cycle);
    upcoming.push({ start: s, end: addDays(s, periodLen - 1) });
  }

  let phase;
  if (onPeriod) phase = 'period';
  else if (lateBy > 0) phase = 'late';
  else if (today === ovulation) phase = 'ovulation';
  else if (today >= fertileStart && today <= fertileEnd) phase = 'fertile';
  else if (today < fertileStart) phase = 'follicular';
  else phase = 'luteal';

  return {
    periods,
    stats,
    current: {
      cycle_day: cycleDay,
      on_period: onPeriod,
      period_day: onPeriod ? diffDays(last.start, today) + 1 : null,
      phase,
    },
    prediction: {
      next_start: nextStart,
      next_end: addDays(nextStart, periodLen - 1),
      days_until: Math.max(0, diffDays(today, nextStart)),
      late_by: lateBy,
      ovulation,
      fertile_start: fertileStart,
      fertile_end: fertileEnd,
      upcoming,
    },
  };
}

// ---------------------------------------------------------------- repo

function emptyDay(date) {
  return { date, flow: null, symptoms: [], note: '', updated_at: null };
}

function rowToDay(row) {
  let symptoms = [];
  try {
    const parsed = JSON.parse(row.symptoms || '[]');
    if (Array.isArray(parsed)) symptoms = parsed.filter((s) => SYMPTOMS.includes(s));
  } catch { /* a bad row reads as no symptoms */ }
  return { date: String(row.date), flow: FLOWS.includes(row.flow) ? row.flow : null, symptoms, note: row.note || '', updated_at: row.updated_at };
}

function periodRepo(db) {
  const allStmt = db.prepare('SELECT * FROM period_days ORDER BY date ASC');
  const getStmt = db.prepare('SELECT * FROM period_days WHERE date = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO period_days (date, flow, symptoms, note, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET flow = excluded.flow, symptoms = excluded.symptoms, note = excluded.note, updated_at = excluded.updated_at
  `);
  const deleteStmt = db.prepare('DELETE FROM period_days WHERE date = ?');

  const get = (date) => {
    const row = getStmt.get(date);
    return row ? rowToDay(row) : null;
  };

  return {
    all: () => allStmt.all().map(rowToDay),
    get,
    // A day with nothing on it is removed rather than stored empty.
    put(day) {
      if (!day.flow && !day.symptoms.length && !day.note) {
        deleteStmt.run(day.date);
        return null;
      }
      upsertStmt.run(day.date, day.flow, JSON.stringify(day.symptoms), day.note, new Date().toISOString());
      return get(day.date);
    },
    remove(date) {
      deleteStmt.run(date);
    },
    transaction(fn) {
      db.exec('BEGIN');
      try {
        fn();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
