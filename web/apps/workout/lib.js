// Shared helpers for the Workout app: units, number formatting, set labels, the exercise
// library cache, the in-progress workout draft (localStorage + the server copy), form-video
// links, timers outside the app, the end-of-timer ding, and the logger's history line and
// weight suggestion.
import { api, store, debounce, fmt, toast } from '../../kit.js';
import { formSheet } from '../../form.js';

export const LB_PER_KG = 2.2046226218;
export const M_PER_MI = 1609.344;
export const MUSCLES = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Legs', 'Glutes', 'Core', 'Cardio', 'Full Body', 'Other'];
export const EQUIPMENT = ['Barbell', 'Dumbbell', 'Machine', 'Cable', 'Bodyweight', 'Kettlebell', 'Band', 'Other'];
export const KIND_LABELS = { weight: 'Weight & reps', reps: 'Reps only', time: 'Duration', cardio: 'Distance & time' };
export const SET_KIND_LABELS = { normal: 'Normal set', warmup: 'Warm-up set', drop: 'Drop set', failure: 'Failure set' };
export const REST_CHOICES = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300];
export const HOLD_CHOICES = [15, 20, 30, 45, 60, 90, 120];
export const DEFAULT_REST = 90;

// ---------------------------------------------------------------- units

let units = store.get('workout.units', 'lb') === 'kg' ? 'kg' : 'lb';
export const getUnits = () => units;
export const distUnit = () => (units === 'kg' ? 'km' : 'mi');
const DISTANCE_METERS = { m: 1, yd: 0.9144, km: 1000, mi: M_PER_MI };
export const distanceUnit = (unit, weightUnit = units) => Object.hasOwn(DISTANCE_METERS, unit) ? unit : (weightUnit === 'kg' ? 'km' : 'mi');
export const metersToDistance = (meters, unit, weightUnit = units) => meters / DISTANCE_METERS[distanceUnit(unit, weightUnit)];
export const distanceToMeters = (distance, unit, weightUnit = units) => distance * DISTANCE_METERS[distanceUnit(unit, weightUnit)];

export async function loadUnits() {
  try {
    const { settings } = await api('/api/settings');
    const u = settings && settings['workout.units'];
    if (u === 'kg' || u === 'lb') {
      units = u;
      store.set('workout.units', u);
    }
  } catch { /* keep the cached choice */ }
  return units;
}

export async function setUnits(u) {
  units = u === 'kg' ? 'kg' : 'lb';
  store.set('workout.units', units);
  try { await api('/api/settings', { method: 'PATCH', body: { 'workout.units': units } }); } catch { /* local still applies */ }
}

const trim = (n, digits = 1) => {
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
};

// kg -> number in the given unit (rounded for display)
export const kgTo = (kg, u = units) => (u === 'kg' ? kg : kg * LB_PER_KG);
export const toKg = (v, u = units) => (u === 'kg' ? v : v / LB_PER_KG);
export const metersTo = (m, u = units) => (u === 'kg' ? m / 1000 : m / M_PER_MI);
export const toMeters = (v, u = units) => (u === 'kg' ? v * 1000 : v * M_PER_MI);

export const fmtWeight = (kg, u = units) => (kg === null || kg === undefined ? '' : trim(kgTo(kg, u), 1));
export const fmtDist = (m, u = units) => (m === null || m === undefined ? '' : trim(metersTo(m, u), 2));
export const fmtVolume = (kg) => `${Math.round(kgTo(kg)).toLocaleString()} ${units}`;

// seconds -> "1:30" / "1:02:05"
export function fmtClock(sec) {
  if (sec === null || sec === undefined || sec === '') return '';
  const s = Math.max(0, Math.round(Number(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

// seconds -> "1h 5m" / "45m" / "40s"
export function fmtLong(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return `${m}m`;
  return `${s}s`;
}

// Typed digits -> clock text: "130" -> "1:30", "45" -> "45", "10000" -> "1:00:00".
export function digitsToClock(raw) {
  const d = String(raw).replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 6);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, -2)}:${d.slice(-2)}`;
  return `${d.slice(0, -4)}:${d.slice(-4, -2)}:${d.slice(-2)}`;
}

export function clockToSeconds(text) {
  if (text === null || text === undefined || text === '') return null;
  const parts = String(text).split(':').map((p) => Number(p || 0));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// One set as short text: "135 lb × 8", "× 12", "1:30", "1.5 mi · 12:00"
export function setText(kind, s, exerciseDistanceUnit = '') {
  if (kind === 'weight') {
    const w = s.weight_kg ? `${fmtWeight(s.weight_kg)} ${units}` : '';
    return w ? `${w} × ${s.reps ?? 0}` : `${s.reps ?? 0} reps`;
  }
  if (kind === 'reps') return `${s.reps ?? 0} reps`;
  if (kind === 'time') return fmtClock(s.seconds || 0);
  const parts = [];
  if (s.meters) parts.push(`${trim(metersToDistance(s.meters, exerciseDistanceUnit), 2)} ${distanceUnit(exerciseDistanceUnit)}`);
  if (s.seconds) parts.push(fmtClock(s.seconds));
  return parts.join(' · ') || '—';
}

// Labels for a list of sets: warm-ups "W", drops "D", failures "F", normal sets numbered.
export function setLabels(sets) {
  let n = 0;
  return sets.map((s) => {
    if (s.kind === 'warmup') return 'W';
    if (s.kind === 'drop') return 'D';
    if (s.kind === 'failure') return 'F';
    n += 1;
    return String(n);
  });
}

export const e1rm = (w, r) => (!w || !r ? 0 : r <= 1 ? w : w * (1 + r / 30));

export const PR_LABELS = {
  weight: 'Heaviest weight', e1rm: 'Best est. 1RM', volume: 'Best set volume',
  reps: 'Most reps', time: 'Longest time', distance: 'Longest distance',
};

export function prValue(type, value) {
  if (type === 'weight' || type === 'e1rm') return `${fmtWeight(value)} ${units}`;
  if (type === 'volume') return fmtVolume(value);
  if (type === 'reps') return `${value} reps`;
  if (type === 'time') return fmtClock(value);
  return `${fmtDist(value)} ${distUnit()}`;
}

// ---------------------------------------------------------------- exercise library

let library = null;
let libraryInflight = null;
export function loadLibrary(force = false) {
  if (library && !force) return Promise.resolve(library);
  if (!libraryInflight) {
    libraryInflight = api('/api/workout/exercises')
      .then((data) => {
        library = data.exercises || [];
        return library;
      })
      .finally(() => { libraryInflight = null; });
  }
  return libraryInflight;
}
export const cachedLibrary = () => library || [];
export const exerciseById = (id) => (library || []).find((e) => e.id === id) || null;

// ---------------------------------------------------------------- the in-progress workout

const ACTIVE_KEY = 'workout.active';
const PUSHED_KEY = 'workout.activePushed'; // started_at of the draft the server has seen
let uidSeq = 0;
export const uid = () => `${Date.now().toString(36)}${(uidSeq++).toString(36)}`;

export function blankSet(kind = 'normal') {
  return { uid: uid(), kind, w: '', r: '', t: '', d: '', done: false };
}

// Server set (kg / m / s) -> draft set (strings in the current units)
export function draftSet(s, done = false, exerciseDistanceUnit = '') {
  // Short history labels may round distances; editable targets must round-trip exactly.
  const distance = s.meters === null || s.meters === undefined ? '' : trim(metersToDistance(s.meters, exerciseDistanceUnit), 6);
  return {
    uid: uid(),
    kind: s.kind || 'normal',
    w: s.weight_kg ? fmtWeight(s.weight_kg) : '',
    r: s.reps === null || s.reps === undefined ? '' : String(s.reps),
    t: s.seconds ? fmtClock(s.seconds) : '',
    d: distance,
    d_source: distance,
    d_unit_source: distanceUnit(exerciseDistanceUnit),
    meters_source: s.meters ?? null,
    done,
  };
}

// Draft set -> server set, or null when it has nothing in it.
export function serverSet(kind, s, u, exerciseDistanceUnit = '') {
  const n = (v) => {
    const x = Number(String(v).replace(',', '.'));
    return v === '' || !Number.isFinite(x) || x < 0 ? null : x;
  };
  const out = { kind: s.kind, weight_kg: null, reps: null, seconds: null, meters: null };
  if (kind === 'weight') {
    const w = n(s.w);
    out.weight_kg = w === null ? null : Math.round(toKg(w, u) * 1000) / 1000;
    out.reps = n(s.r) === null ? null : Math.round(n(s.r));
    if (!out.reps && !out.weight_kg) return null;
  } else if (kind === 'reps') {
    out.reps = n(s.r) === null ? null : Math.round(n(s.r));
    if (!out.reps) return null;
  } else if (kind === 'time') {
    out.seconds = clockToSeconds(s.t);
    if (!out.seconds) return null;
  } else {
    const d = n(s.d);
    out.meters = d === null ? null : s.d === s.d_source && s.d_unit_source === distanceUnit(exerciseDistanceUnit, u) && typeof s.meters_source === 'number'
      ? s.meters_source : Math.round(distanceToMeters(d, exerciseDistanceUnit, u) * 1000) / 1000;
    out.seconds = clockToSeconds(s.t);
    if (!out.meters && !out.seconds) return null;
  }
  return out;
}

export function draftExercise(ex, sets, rest) {
  return {
    uid: uid(),
    exercise_id: ex.exercise_id ?? ex.id,
    name: ex.name,
    kind: ex.kind,
    muscle: ex.muscle,
    rest: rest !== undefined ? rest : (ex.kind === 'cardio' ? 0 : DEFAULT_REST),
    note: ex.note || '',
    prescription: ex.prescription || '',
    distance_unit: ex.distance_unit || '',
    sets,
  };
}

export function readActive() {
  const d = store.get(ACTIVE_KEY, null);
  return d && typeof d === 'object' && Array.isArray(d.exercises) ? d : null;
}

const pushActive = debounce(() => {
  const d = readActive();
  if (!d) return;
  api('/api/workout/active', { method: 'PUT', body: { active: d } })
    .then(() => store.set(PUSHED_KEY, d.started_at))
    .catch(() => {});
}, 1200);

export function writeActive(draft) {
  draft.updated = Date.now();
  store.set(ACTIVE_KEY, draft);
  pushActive();
}

export async function clearActive() {
  pushActive.cancel();
  store.del(ACTIVE_KEY);
  store.del(PUSHED_KEY);
  try { await api('/api/workout/active', { method: 'DELETE' }); } catch { /* best effort */ }
}

// Picks the newer of this device's draft and the server's (a workout started on the PC
// shows up on the phone and the other way round).
export async function syncActive() {
  const local = readActive();
  try {
    const { active } = await api('/api/workout/active');
    const remote = active && Array.isArray(active.exercises) ? active : null;
    if (remote && (!local || (remote.updated || 0) > (local.updated || 0))) {
      store.set(ACTIVE_KEY, remote);
      return remote;
    }
    if (!remote && local) {
      // The server forgot it (finished or discarded elsewhere) only if it was pushed before.
      if (store.get(PUSHED_KEY, null) === local.started_at) {
        store.del(ACTIVE_KEY);
        store.del(PUSHED_KEY);
        return null;
      }
    }
  } catch { /* offline: use what this device has */ }
  return readActive();
}

// ---------------------------------------------------------------- form videos

// The exercise's saved form video, else a YouTube search for it. Links open with
// target=_blank, which the iPhone shell hands to the YouTube app.
export function formVideoUrl(exerciseId, name) {
  const saved = exerciseById(exerciseId)?.video_url;
  return saved || `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} proper form`)}`;
}

// Sheet to set or clear an exercise's own video link. Resolves with the saved exercise, or null.
export async function editVideoLink(exerciseId, name) {
  const current = exerciseById(exerciseId)?.video_url || '';
  const result = await formSheet({
    title: 'Form video',
    fields: [{
      key: 'video_url', label: `Video link for ${name}`, type: 'url', value: current,
      placeholder: 'https://youtube.com/… (empty = search YouTube)',
    }],
  });
  if (!result || result === 'delete') return null;
  try {
    const { exercise } = await api(`/api/workout/exercises/${exerciseId}`, { method: 'PATCH', body: { video_url: result.video_url } });
    const cached = exerciseById(exerciseId);
    if (cached) cached.video_url = exercise.video_url;
    toast(exercise.video_url ? 'Video link saved' : 'Video link cleared');
    return exercise;
  } catch (err) {
    toast(err && err.status ? `Couldn't save: ${err.message}` : "Couldn't save — the PC is unreachable", { kind: 'error' });
    return null;
  }
}

// ---------------------------------------------------------------- timers outside the app

// In the iPhone shell (window.JakesData.canTimer, app 1.5+), a running rest or hold timer is
// mirrored natively: a Live Activity counts down on the lock screen and in the Dynamic Island,
// and a notification dings when it ends, even with the app closed.
//   start  — (re)schedule for `end` (epoch ms)
//   finish — the timer ran out in the app: end the Live Activity, leave the notification
//            (it is the ding, and cancelling it here could race it)
//   stop   — skipped or cancelled: drop the notification and end the Live Activity
function postNative(message) {
  try {
    const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
    if (handler && typeof handler.postMessage === 'function') handler.postMessage(message);
  } catch { /* not in the shell */ }
}
export const nativeTimer = {
  get supported() { return Boolean(window.JakesData && window.JakesData.canTimer); },
  start(end, { label, title, body }) {
    if (this.supported) postNative({ type: 'timer', action: 'start', end: Math.round(end), label, title, body });
  },
  finish() { if (this.supported) postNative({ type: 'timer', action: 'finish' }); },
  stop() { if (this.supported) postNative({ type: 'timer', action: 'stop' }); },
};

// ---------------------------------------------------------------- the ding

// A two-strike bell made with Web Audio, for the browser (PC). In the iPhone shell the
// timer's notification sound is the ding, so this stays quiet there and never plays twice.
// Browsers only allow sound after a tap, so taps that start timers call unlockAudio().
let audio = null;
export function unlockAudio() {
  if (nativeTimer.supported) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audio) audio = new Ctx();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  } catch { audio = null; }
}
export function ding() {
  if (nativeTimer.supported) return;
  unlockAudio();
  if (!audio) return;
  const start = audio.currentTime + 0.03;
  strike(start);
  strike(start + 0.35);
}
function strike(at) {
  // A bell-like partial set on E6, each partial fading on its own.
  for (const [ratio, peak, fade] of [[1, 0.32, 1.2], [2.76, 0.1, 0.55], [5.4, 0.04, 0.28]]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1318.5 * ratio;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + fade);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + fade + 0.05);
  }
}

// ---------------------------------------------------------------- history line + suggestion

// Sessions are { started_at, sets } from /api/workout/recent, newest first. Warm-ups are left out.
const workSets = (sets) => sets.filter((s) => s.kind !== 'warmup');

// What one session is "worth" for the trend, by exercise kind (null when it has nothing).
function sessionBest(kind, sets) {
  const work = workSets(sets);
  if (!work.length) return null;
  if (kind === 'weight') {
    const top = Math.max(...work.map((s) => s.weight_kg || 0));
    return top > 0 ? top : Math.max(...work.map((s) => s.reps || 0)) || null;
  }
  if (kind === 'reps') return Math.max(...work.map((s) => s.reps || 0)) || null;
  if (kind === 'time') return Math.max(...work.map((s) => s.seconds || 0)) || null;
  return Math.max(...work.map((s) => s.meters || 0)) || Math.max(...work.map((s) => s.seconds || 0)) || null;
}

// One line, computed from the numbers (no AI): "Top set 125 → 135 lb over 5 workouts · best est. 1RM 168 lb".
export function historySummary(kind, sessions, exerciseDistanceUnit = '') {
  const points = sessions.map((s) => sessionBest(kind, s.sets)).filter((v) => v !== null);
  if (!points.length) return 'Warm-ups only so far';
  const newest = points[0];
  const oldest = points[points.length - 1];
  const n = sessions.length;
  const span = n === 1 ? 'last workout' : `over ${n} workouts`;
  const weighted = kind === 'weight' && sessions.some((s) => workSets(s.sets).some((x) => x.weight_kg > 0));
  let show;
  let what;
  if (weighted) {
    show = (v) => `${fmtWeight(v)} ${units}`;
    what = 'Top set';
  } else if (kind === 'weight' || kind === 'reps') {
    show = (v) => `${v} reps`;
    what = 'Most reps';
  } else if (kind === 'time') {
    show = fmtClock;
    what = 'Longest';
  } else {
    const hasDistance = sessions.some((s) => s.sets.some((x) => x.meters));
    show = hasDistance ? (v) => `${trim(metersToDistance(v, exerciseDistanceUnit), 2)} ${distanceUnit(exerciseDistanceUnit)}` : fmtClock;
    what = 'Longest';
  }
  let line;
  if (n === 1) line = `${what} ${show(newest)} last workout`;
  else if (Math.abs(newest - oldest) < 1e-6) line = `${what} steady at ${show(newest)} ${span}`;
  else line = `${what} ${show(oldest)} → ${show(newest)} ${span}`;
  if (weighted) {
    const best = Math.max(...sessions.flatMap((s) => workSets(s.sets).map((x) => e1rm(x.weight_kg, x.reps))));
    if (best > 0) line += ` · best est. 1RM ${fmtWeight(best)} ${units}`;
  }
  return line;
}

// "Nov 12" + "135×8, 135×8, 135×6 lb" for the expanded history list.
export function historyRow(kind, session, exerciseDistanceUnit = '') {
  const work = workSets(session.sets);
  const sets = work.length ? work : session.sets;
  let text;
  if (kind === 'weight' && sets.some((s) => s.weight_kg > 0)) {
    text = `${sets.map((s) => `${fmtWeight(s.weight_kg || 0)}×${s.reps ?? 0}`).join(', ')} ${units}`;
  } else if (kind === 'weight' || kind === 'reps') {
    text = `${sets.map((s) => s.reps ?? 0).join(', ')} reps`;
  } else {
    text = sets.map((s) => setText(kind, s, exerciseDistanceUnit)).join(', ');
  }
  return { date: fmt.date(session.started_at), text };
}

// "8–12 reps", "3 × 8–12", "3x10", "5 reps" -> [low, high]; null when no rep target is written.
export function parseRepRange(prescription) {
  const t = String(prescription || '');
  let m = t.match(/(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*reps?\b/i)
    || t.match(/\d{1,2}\s*[x×]\s*(\d{1,2})\s*(?:-|–|—)\s*(\d{1,2})/i);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return lo > 0 && hi >= lo && hi <= 50 ? [lo, hi] : null;
  }
  m = t.match(/\d{1,2}\s*[x×]\s*(\d{1,2})(?!\s*(?:-|–|—|\d))/i) || t.match(/\b(\d{1,2})\s*reps?\b/i);
  if (m) {
    const reps = Number(m[1]);
    return reps > 0 && reps <= 50 ? [reps, reps] : null;
  }
  return null;
}

// How much to add, in the display unit, by equipment (bigger jumps for legs on a barbell or machine).
function stepFor(equipment, muscle) {
  const legs = muscle === 'Legs' || muscle === 'Glutes';
  const lb = units === 'lb';
  if (equipment === 'Barbell') return lb ? (legs ? 10 : 5) : (legs ? 5 : 2.5);
  if (equipment === 'Machine') return lb ? (legs ? 10 : 5) : (legs ? 5 : 2.5);
  if (equipment === 'Dumbbell') return lb ? 5 : 2;
  if (equipment === 'Kettlebell') return lb ? 9 : 4;
  return lb ? 5 : 2.5;
}

// Next workout's weight for a weight-and-reps exercise, from the last two workouts with it.
// With a rep range in the routine (e.g. 8–12): every set at the top weight reached the top of
// the range -> add a step and go back to the bottom; missed the bottom twice running at that
// weight -> back off 10%; otherwise same weight, one more rep. Without a range: every set at
// the top weight matched the first set's reps -> add a step; otherwise stay and match it.
// Returns { weight_kg, reps, reason } or null (no weighted sets logged yet).
export function suggestNext(sessions, { prescription = '', equipment = 'Other', muscle = '' } = {}) {
  if (!sessions || !sessions.length) return null;
  const weighted = (s) => s.kind !== 'warmup' && s.weight_kg > 0 && s.reps > 0;
  const last = sessions[0].sets.filter(weighted);
  if (!last.length) return null;
  const top = Math.max(...last.map((s) => s.weight_kg));
  const atTop = last.filter((s) => Math.abs(s.weight_kg - top) < 0.01);
  const minReps = Math.min(...atTop.map((s) => s.reps));
  const firstReps = atTop[0].reps;
  const step = stepFor(equipment, muscle);
  const up = toKg(kgTo(top) + step);
  const w = (kg) => `${fmtWeight(kg)} ${units}`;
  const range = parseRepRange(prescription);
  if (range) {
    const [lo, hi] = range;
    if (minReps >= hi) {
      return { weight_kg: up, reps: lo, reason: `You hit ${hi} reps on every set at ${w(top)}, so add ${step} ${units}.` };
    }
    if (minReps < lo) {
      const before = (sessions[1]?.sets || []).filter((s) => weighted(s) && Math.abs(s.weight_kg - top) < 0.01);
      if (before.length && Math.min(...before.map((s) => s.reps)) < lo) {
        const back = toKg(Math.max(step, Math.round((kgTo(top) * 0.9) / step) * step));
        return { weight_kg: back, reps: lo, reason: `Under ${lo} reps at ${w(top)} two workouts running, so drop about 10%.` };
      }
      return { weight_kg: top, reps: lo, reason: `Under ${lo} reps last time. Stay at ${w(top)} and aim for ${lo}.` };
    }
    return { weight_kg: top, reps: Math.min(hi, minReps + 1), reason: `Add a rep before adding weight (${lo}–${hi} reps).` };
  }
  if (atTop.every((s) => s.reps >= firstReps)) {
    return { weight_kg: up, reps: firstReps, reason: `You got ${firstReps} reps on every set at ${w(top)}, so add ${step} ${units}.` };
  }
  return { weight_kg: top, reps: firstReps, reason: `Reps fell to ${minReps} last time. Match ${firstReps} on every set first.` };
}
