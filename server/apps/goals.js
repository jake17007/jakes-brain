// Goals: long-term goals with a why, an area, a target date, milestones and dated check-ins. Routes:
//   GET    /api/goals?status=active|paused|done|dropped|all  -> { goals: [summary], areas, statuses }  (default all)
//   POST   /api/goals {title, why?, area?, target_date?, unit?, start_value?, target_value?, current_value?}
//                                            -> 201 { goal }
//   GET    /api/goals/:id                    -> { goal }   with milestones (in order) and checkins (newest first)
//   PATCH  /api/goals/:id {any POST field, status?} -> { goal }
//   DELETE /api/goals/:id                    -> 204 (its milestones and check-ins go too)
//   POST   /api/goals/:id/milestones {text, due_date?}                 -> 201 { goal }
//   PATCH  /api/goals/:id/milestones/:mid {text?, done?, due_date?}    -> { goal }
//   DELETE /api/goals/:id/milestones/:mid                              -> { goal }
//   POST   /api/goals/:id/checkins {note?, value?, date?}              -> 201 { goal }  note or value required
//   DELETE /api/goals/:id/checkins/:cid                                -> { goal }
//
// area is one of AREAS below (default personal); status is active | paused | done | dropped.
// Dates are 'YYYY-MM-DD' (target_date and due_date may be null; a check-in's date defaults to today).
// Measurable goals: set target_value (and start_value, unit), e.g. "Save $50k" start 10000, target
// 50000, unit "$". A check-in with a value moves current_value to the value of the latest-dated
// check-in that has one (back to start_value when none is left). Goals without a number can use
// milestones instead. Every { goal } also carries:
//   progress (0..1 or null), progress_source ('metric' | 'milestones' | null; a done goal is 1),
//   milestones_total, milestones_done, next_milestone (first open one's text), last_checkin (date or null).
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';
import { now, parseId, text, day, localDay } from './_lib.js';

const AREAS = ['health', 'career', 'money', 'relationships', 'personal', 'other'];
const STATUSES = ['active', 'paused', 'done', 'dropped'];
const NUM_MAX = 1e12;

export default {
  id: 'goals',
  migrations: [
    {
      id: 'goals-1',
      sql: `
        CREATE TABLE IF NOT EXISTS goals (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          title         TEXT    NOT NULL,
          why           TEXT    NOT NULL DEFAULT '',
          area          TEXT    NOT NULL DEFAULT 'personal',
          status        TEXT    NOT NULL DEFAULT 'active',
          target_date   TEXT,
          unit          TEXT    NOT NULL DEFAULT '',
          start_value   REAL,
          target_value  REAL,
          current_value REAL,
          done_at       TEXT,
          created_at    TEXT    NOT NULL,
          updated_at    TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS goals_milestones (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id    INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          text       TEXT    NOT NULL,
          done       INTEGER NOT NULL DEFAULT 0,
          due_date   TEXT,
          position   INTEGER NOT NULL DEFAULT 0,
          done_at    TEXT,
          created_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS goals_milestones_goal ON goals_milestones(goal_id, position);
        CREATE TABLE IF NOT EXISTS goals_checkins (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id    INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          date       TEXT    NOT NULL,
          note       TEXT    NOT NULL DEFAULT '',
          value      REAL,
          created_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS goals_checkins_goal ON goals_checkins(goal_id, date);
      `,
    },
  ],
  register(r, { db }) {
    const repo = goalsRepo(db);

    r.get('/api/goals', (req, res, { query }) => {
      const status = query.status === undefined || query.status === '' ? 'all' : query.status;
      if (status !== 'all' && !STATUSES.includes(status)) {
        throw new HttpError(400, `status must be all or one of ${STATUSES.join(', ')}`);
      }
      const goals = repo.list().filter((g) => status === 'all' || g.status === status);
      return { goals, areas: AREAS, statuses: STATUSES };
    });

    r.post('/api/goals', async (req, res) => {
      const body = await readJsonBody(req);
      const id = repo.create(clean(body));
      sendJson(res, 201, { goal: repo.full(id) });
    });

    r.get('/api/goals/:id', (req, res, { params }) => ({ goal: repo.full(repo.need(parseId(params.id)).id) }));

    r.patch('/api/goals/:id', async (req, res, { params }) => {
      const current = repo.need(parseId(params.id));
      const body = await readJsonBody(req);
      if (!Object.keys(body).length) throw new HttpError(400, 'nothing to update');
      repo.update(current, clean(body, current));
      return { goal: repo.full(current.id) };
    });

    r.delete('/api/goals/:id', (req, res, { params }) => {
      const goal = repo.need(parseId(params.id));
      repo.remove(goal.id);
      sendEmpty(res, 204);
    });

    r.post('/api/goals/:id/milestones', async (req, res, { params }) => {
      const goal = repo.need(parseId(params.id));
      const body = await readJsonBody(req);
      repo.addMilestone(goal.id, text(body.text, 'text', { max: 300, required: true }), day(body.due_date, 'due_date'));
      sendJson(res, 201, { goal: repo.full(goal.id) });
    });

    r.patch('/api/goals/:id/milestones/:mid', async (req, res, { params }) => {
      const goal = repo.need(parseId(params.id));
      const milestone = repo.needMilestone(goal.id, parseId(params.mid));
      const body = await readJsonBody(req);
      const next = { ...milestone };
      if (body.text !== undefined) next.text = text(body.text, 'text', { max: 300, required: true });
      if (body.due_date !== undefined) next.due_date = day(body.due_date, 'due_date');
      if (body.done !== undefined) {
        if (typeof body.done !== 'boolean') throw new HttpError(400, 'done must be true or false');
        next.done = body.done ? 1 : 0;
      }
      repo.updateMilestone(next, milestone);
      return { goal: repo.full(goal.id) };
    });

    r.delete('/api/goals/:id/milestones/:mid', (req, res, { params }) => {
      const goal = repo.need(parseId(params.id));
      repo.removeMilestone(repo.needMilestone(goal.id, parseId(params.mid)).id);
      return { goal: repo.full(goal.id) };
    });

    r.post('/api/goals/:id/checkins', async (req, res, { params }) => {
      const goal = repo.need(parseId(params.id));
      const body = await readJsonBody(req);
      const note = text(body.note, 'note', { max: 4000 });
      const value = number(body.value, 'value');
      if (!note && value === null) throw new HttpError(400, 'send a note and/or a value');
      repo.addCheckin(goal.id, day(body.date, 'date') || localDay(), note, value);
      sendJson(res, 201, { goal: repo.full(goal.id) });
    });

    r.delete('/api/goals/:id/checkins/:cid', (req, res, { params }) => {
      const goal = repo.need(parseId(params.id));
      repo.removeCheckin(goal.id, parseId(params.cid));
      return { goal: repo.full(goal.id) };
    });
  },
};

// ---------------------------------------------------------------- validation

function number(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > NUM_MAX) {
    throw new HttpError(400, `${name} must be a number`);
  }
  return value;
}

// The whole goal row after applying `body` on top of `base` (the current row on a PATCH).
function clean(body, base = {}) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'send a JSON object');
  const m = { ...base, ...body };
  const area = m.area === undefined || m.area === null || m.area === '' ? 'personal' : m.area;
  if (!AREAS.includes(area)) throw new HttpError(400, `area must be one of ${AREAS.join(', ')}`);
  const status = m.status === undefined ? 'active' : m.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
  const target = number(m.target_value, 'target_value');
  let start = number(m.start_value, 'start_value');
  let current = number(m.current_value, 'current_value');
  // A number to aim for needs somewhere to start from: the current value, else zero.
  if (target !== null && start === null) start = current ?? 0;
  if (target !== null && current === null) current = start;
  return {
    title: text(m.title, 'title', { max: 200, required: true }),
    why: text(m.why, 'why', { max: 4000 }),
    area,
    status,
    target_date: day(m.target_date, 'target_date'),
    unit: text(m.unit, 'unit', { max: 20 }),
    start_value: start,
    target_value: target,
    current_value: current,
  };
}

// ---------------------------------------------------------------- repo

function goalsRepo(db) {
  const getStmt = db.prepare('SELECT * FROM goals WHERE id = ?');
  const allStmt = db.prepare('SELECT * FROM goals');
  const milestonesStmt = db.prepare('SELECT * FROM goals_milestones WHERE goal_id = ? ORDER BY position, id');
  const checkinsStmt = db.prepare('SELECT * FROM goals_checkins WHERE goal_id = ? ORDER BY date DESC, id DESC');
  const countsStmt = db.prepare(`
    SELECT goal_id, COUNT(*) AS total, SUM(done) AS done,
           (SELECT text FROM goals_milestones n WHERE n.goal_id = m.goal_id AND n.done = 0 ORDER BY position, id LIMIT 1) AS next
    FROM goals_milestones m GROUP BY goal_id`);
  const lastCheckinStmt = db.prepare('SELECT goal_id, MAX(date) AS last FROM goals_checkins GROUP BY goal_id');

  const need = (id) => {
    const row = getStmt.get(id);
    if (!row) throw new HttpError(404, 'goal not found');
    return row;
  };

  const touch = (id) => db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(now(), id);

  // Check-ins with a value drive current_value: the latest-dated one wins.
  const syncCurrent = (goalId) => {
    const latest = db.prepare('SELECT value FROM goals_checkins WHERE goal_id = ? AND value IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1').get(goalId);
    const goal = need(goalId);
    db.prepare('UPDATE goals SET current_value = ?, updated_at = ? WHERE id = ?')
      .run(latest ? latest.value : goal.start_value, now(), goalId);
  };

  const shape = (row, counts = {}, last = null) => {
    const total = Number(counts.total || 0);
    const done = Number(counts.done || 0);
    const metric = row.target_value !== null && row.start_value !== null && row.target_value !== row.start_value;
    let progress = null;
    let source = null;
    if (metric) {
      const cur = row.current_value ?? row.start_value;
      progress = clamp01((cur - row.start_value) / (row.target_value - row.start_value));
      source = 'metric';
    } else if (total) {
      progress = done / total;
      source = 'milestones';
    }
    if (row.status === 'done') progress = 1;
    return {
      id: row.id,
      title: row.title,
      why: row.why,
      area: row.area,
      status: row.status,
      target_date: row.target_date,
      unit: row.unit,
      start_value: row.start_value,
      target_value: row.target_value,
      current_value: row.current_value,
      progress: progress === null ? null : Math.round(progress * 1000) / 1000,
      progress_source: source,
      milestones_total: total,
      milestones_done: done,
      next_milestone: counts.next || null,
      last_checkin: last,
      done_at: row.done_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  };

  const full = (id) => {
    const row = need(id);
    const milestones = milestonesStmt.all(id).map((m) => ({
      id: m.id, text: m.text, done: Boolean(m.done), due_date: m.due_date, done_at: m.done_at, created_at: m.created_at,
    }));
    const checkins = checkinsStmt.all(id).map((c) => ({ id: c.id, date: c.date, note: c.note, value: c.value, created_at: c.created_at }));
    const counts = {
      total: milestones.length,
      done: milestones.filter((m) => m.done).length,
      next: (milestones.find((m) => !m.done) || {}).text,
    };
    return { ...shape(row, counts, checkins[0] ? checkins[0].date : null), milestones, checkins };
  };

  return {
    need,
    full,

    list() {
      const counts = new Map(countsStmt.all().map((c) => [c.goal_id, c]));
      const lasts = new Map(lastCheckinStmt.all().map((c) => [c.goal_id, c.last]));
      const order = (g) => STATUSES.indexOf(g.status);
      return allStmt.all()
        .map((row) => shape(row, counts.get(row.id), lasts.get(row.id) || null))
        .sort((a, b) => order(a) - order(b)
          || (a.status === 'done' ? String(b.done_at || '').localeCompare(String(a.done_at || '')) : 0)
          || (a.target_date === null) - (b.target_date === null)
          || String(a.target_date || '').localeCompare(String(b.target_date || ''))
          || b.id - a.id);
    },

    create(g) {
      const stamp = now();
      const made = db.prepare(`
        INSERT INTO goals (title, why, area, status, target_date, unit, start_value, target_value, current_value, done_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(g.title, g.why, g.area, g.status, g.target_date, g.unit, g.start_value, g.target_value, g.current_value,
          g.status === 'done' ? stamp : null, stamp, stamp);
      return Number(made.lastInsertRowid);
    },

    update(current, g) {
      const stamp = now();
      const doneAt = g.status === 'done' ? current.done_at || stamp : null;
      db.prepare(`
        UPDATE goals SET title = ?, why = ?, area = ?, status = ?, target_date = ?, unit = ?, start_value = ?,
          target_value = ?, current_value = ?, done_at = ?, updated_at = ? WHERE id = ?`)
        .run(g.title, g.why, g.area, g.status, g.target_date, g.unit, g.start_value, g.target_value, g.current_value,
          doneAt, stamp, current.id);
    },

    remove(id) {
      db.prepare('DELETE FROM goals WHERE id = ?').run(id);
    },

    needMilestone(goalId, id) {
      const row = db.prepare('SELECT * FROM goals_milestones WHERE id = ? AND goal_id = ?').get(id, goalId);
      if (!row) throw new HttpError(404, 'milestone not found');
      return row;
    },

    addMilestone(goalId, textValue, due) {
      const { pos } = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM goals_milestones WHERE goal_id = ?').get(goalId);
      db.prepare('INSERT INTO goals_milestones (goal_id, text, due_date, position, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(goalId, textValue, due, pos, now());
      touch(goalId);
    },

    updateMilestone(next, prev) {
      const doneAt = next.done ? prev.done_at || now() : null;
      db.prepare('UPDATE goals_milestones SET text = ?, due_date = ?, done = ?, done_at = ? WHERE id = ?')
        .run(next.text, next.due_date, next.done, doneAt, next.id);
      touch(next.goal_id);
    },

    removeMilestone(id) {
      const row = db.prepare('SELECT goal_id FROM goals_milestones WHERE id = ?').get(id);
      db.prepare('DELETE FROM goals_milestones WHERE id = ?').run(id);
      if (row) touch(row.goal_id);
    },

    addCheckin(goalId, date, note, value) {
      db.prepare('INSERT INTO goals_checkins (goal_id, date, note, value, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(goalId, date, note, value, now());
      if (value !== null) syncCurrent(goalId);
      else touch(goalId);
    },

    removeCheckin(goalId, id) {
      const row = db.prepare('SELECT * FROM goals_checkins WHERE id = ? AND goal_id = ?').get(id, goalId);
      if (!row) throw new HttpError(404, 'check-in not found');
      db.prepare('DELETE FROM goals_checkins WHERE id = ?').run(id);
      if (row.value !== null) syncCurrent(goalId);
      else touch(goalId);
    },
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
