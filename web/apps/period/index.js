// Period app: a cycle tracker. A summary card (days until the next period, period day, or
// late), a month calendar (logged flow, predicted periods, fertile window, ovulation), the
// averages, and past periods. Tapping today or a past day opens a sheet: flow (none ..
// heavy), symptoms, note. Data: /api/period (server/apps/period.js) — the server works out
// periods, averages and predictions; the phone sends its own local `today`.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, navButton, section, emptyState, confirmSheet, holdReload, releaseReload, icon } = kit;

const HOLD_KEY = 'period:sheet';
const FLOWS = [
  { value: null, label: 'None' },
  { value: 'spotting', label: 'Spotting' },
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'heavy', label: 'Heavy' },
];
const SYMPTOMS = [
  ['cramps', 'Cramps'], ['headache', 'Headache'], ['bloating', 'Bloating'], ['tender_breasts', 'Tender breasts'],
  ['acne', 'Acne'], ['fatigue', 'Fatigue'], ['mood_swings', 'Mood swings'], ['back_pain', 'Back pain'],
  ['nausea', 'Nausea'], ['cravings', 'Cravings'], ['insomnia', 'Insomnia'], ['anxiety', 'Anxiety'],
];
const BLEEDING = new Set(['light', 'medium', 'heavy']);
const PHASES = {
  period: 'Period', follicular: 'Follicular phase', fertile: 'Fertile window', ovulation: 'Ovulation (est.)',
  luteal: 'Luteal phase', late: 'Period late',
};

let state = null;
let els = null;
let listeners = [];
let sheet = null;
let midnightTimer = 0;

export default {
  mount(root) {
    const today = fmt.dayKey();
    state = {
      today, loaded: false, inflight: false, from: null,
      days: new Map(), summary: null,
      month: today.slice(0, 7), // 'YYYY-MM' in view
    };
    const add = navButton({ icon: 'plus', label: 'Log today', onClick: () => openDay(state.today) });
    const hero = el('section', { class: 'card hero', 'aria-live': 'polite' });
    const calendar = el('section', { class: 'card cal', 'aria-label': 'Calendar' });
    const statsTitle = section('Averages');
    const stats = el('div', { class: 'card stats' });
    const historyTitle = section('Past periods');
    const history = el('ul', { class: 'card list history', 'aria-label': 'Past periods' });
    const historyEmpty = emptyState('Periods you log show up here.');
    const footnote = el('p', { class: 'footnote', text: 'Predictions are estimates from your averages. They are not medical advice or birth control.' });

    root.append(navbar({ title: 'Period', right: [add] }),
      el('div', { class: 'app-content' }, hero, calendar, statsTitle, stats, historyTitle, history, historyEmpty, footnote));
    els = { root, hero, calendar, stats, history, historyEmpty };

    render();
    load();
    listen(window, 'jakesdata:online', load);
    listen(window, 'jakesdata:foreground', load);
    listen(document, 'visibilitychange', () => { if (!document.hidden) load(); });
    scheduleMidnight();
  },

  unmount() {
    closeSheet();
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    clearTimeout(midnightTimer);
    midnightTimer = 0;
    releaseReload(HOLD_KEY);
    state = null;
    els = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

function scheduleMidnight() {
  clearTimeout(midnightTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
  midnightTimer = setTimeout(() => { load(); scheduleMidnight(); }, Math.max(1000, next - now));
}

// ---------------------------------------------------------------- day keys (local)

function parseDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(key, n) {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return fmt.dayKey(d);
}

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return fmt.dayKey(d).slice(0, 7);
}

const shortDate = (key) => fmt.date(parseDay(key));
const longDate = (key) => fmt.date(parseDay(key), { weekday: 'short' });

// ---------------------------------------------------------------- data

async function load({ from } = {}) {
  if (!state || state.inflight) return;
  state.inflight = true;
  const today = fmt.dayKey();
  const start = from || state.from || addDays(today, -400);
  try {
    const data = await api(`/api/period?today=${today}&from=${start}`);
    if (!state) return;
    if (state.today !== today && state.month === state.today.slice(0, 7)) state.month = today.slice(0, 7);
    state.today = today;
    state.from = start;
    state.days = new Map((data.days || []).map((d) => [d.date, d]));
    applySummary(data);
    state.loaded = true;
    render();
  } catch {
    /* keep what is on screen; the banner reports an outage */
  } finally {
    if (state) state.inflight = false;
  }
}

function applySummary(s) {
  state.summary = { periods: s.periods || [], stats: s.stats || null, current: s.current || null, prediction: s.prediction || null };
}

function failureMessage(verb, err) {
  if (err && err.status) return `Couldn't ${verb}: ${err.message}`;
  return `Couldn't ${verb} — the PC is unreachable`;
}

// ---------------------------------------------------------------- render

function render() {
  if (!state || !els) return;
  renderHero();
  renderCalendar();
  renderStats();
  renderHistory();
}

function renderHero() {
  const s = state.summary;
  const cur = s && s.current;
  const pred = s && s.prediction;
  const kids = [];
  let action;
  if (!state.loaded) {
    kids.push(el('p', { class: 'hero-sub', text: 'Loading…' }));
  } else if (!cur || !pred) {
    kids.push(el('p', { class: 'hero-eyebrow', text: 'Get started' }),
      el('p', { class: 'hero-big small', text: 'Log your last period' }),
      el('p', { class: 'hero-sub', text: 'Tap the first day it started on the calendar, or log today.' }));
    action = { label: 'Period started today', onClick: () => openDay(state.today, { flow: 'medium' }) };
  } else if (cur.on_period) {
    kids.push(el('p', { class: 'hero-eyebrow', text: 'Period' }),
      el('p', { class: 'hero-big', text: `Day ${cur.period_day}` }),
      el('p', { class: 'hero-sub', text: `Next one expected ${shortDate(pred.next_start)}` }));
    action = { label: 'Log today', onClick: () => openDay(state.today) };
  } else if (pred.late_by > 0) {
    kids.push(el('p', { class: 'hero-eyebrow late', text: 'Late' }),
      el('p', { class: 'hero-big', text: pred.late_by === 1 ? '1 day' : `${pred.late_by} days` }),
      el('p', { class: 'hero-sub', text: `Expected ${longDate(pred.next_start)} · cycle day ${cur.cycle_day}` }));
    action = { label: 'Period started today', onClick: () => openDay(state.today, { flow: 'medium' }) };
  } else {
    const n = pred.days_until;
    kids.push(el('p', { class: 'hero-eyebrow', text: 'Next period' }),
      el('p', { class: 'hero-big', text: n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days` }),
      el('p', { class: 'hero-sub', text: `${longDate(pred.next_start)} · cycle day ${cur.cycle_day}` }));
    action = { label: 'Period started today', onClick: () => openDay(state.today, { flow: 'medium' }) };
  }
  if (cur && PHASES[cur.phase] && cur.phase !== 'period' && cur.phase !== 'late') {
    kids.push(el('span', { class: `phase phase-${cur.phase}`, text: PHASES[cur.phase] }));
  }
  if (action) kids.push(el('button', { class: 'hero-action', type: 'button', text: action.label, 'on:click': action.onClick }));
  els.hero.replaceChildren(...kids);
}

// Predicted period days, fertile days and ovulation days from today on.
function predictedMarks() {
  const marks = { period: new Set(), fertile: new Set(), ovulation: new Set() };
  const pred = state.summary && state.summary.prediction;
  if (!pred) return marks;
  for (const p of pred.upcoming || []) {
    for (let d = p.start; d <= p.end; d = addDays(d, 1)) if (d > state.today) marks.period.add(d);
    const ov = addDays(p.start, -14);
    for (let d = addDays(ov, -5); d <= addDays(ov, 1); d = addDays(d, 1)) marks.fertile.add(d);
    marks.ovulation.add(ov);
  }
  return marks;
}

function renderCalendar() {
  const month = state.month;
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const prev = el('button', { class: 'cal-nav', type: 'button', 'aria-label': 'Previous month', 'on:click': () => changeMonth(-1) }, icon('chevron-left'));
  const next = el('button', { class: 'cal-nav', type: 'button', 'aria-label': 'Next month', 'on:click': () => changeMonth(1) }, icon('chevron-right'));
  const head = el('div', { class: 'cal-head' }, prev, el('h2', { class: 'cal-title', text: title }), next);

  // Week starts on Sunday, like iOS Calendar in the US.
  const weekdays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(2026, 10, 1 + i); // Nov 1 2026 is a Sunday
    weekdays.push(el('span', { class: 'wd', text: d.toLocaleDateString(undefined, { weekday: 'narrow' }) }));
  }
  const marks = predictedMarks();
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(el('span', { class: 'cell blank', 'aria-hidden': 'true' }));
  const daysIn = new Date(y, m, 0).getDate();
  for (let day = 1; day <= daysIn; day++) {
    const key = `${month}-${String(day).padStart(2, '0')}`;
    cells.push(dayCell(key, day, marks));
  }
  const legend = el('div', { class: 'legend', 'aria-hidden': 'true' },
    el('span', { class: 'lg lg-period' }, el('i'), 'Period'),
    el('span', { class: 'lg lg-predicted' }, el('i'), 'Predicted'),
    el('span', { class: 'lg lg-fertile' }, el('i'), 'Fertile'),
    el('span', { class: 'lg lg-ovulation' }, el('i'), 'Ovulation'));
  els.calendar.replaceChildren(head, el('div', { class: 'grid weekdays' }, weekdays), el('div', { class: 'grid days' }, cells), legend);
}

function dayCell(key, n, marks) {
  const logged = state.days.get(key);
  const future = key > state.today;
  const cls = ['cell'];
  const parts = [];
  if (key === state.today) cls.push('today');
  if (future) cls.push('future');
  if (logged && BLEEDING.has(logged.flow)) { cls.push('period', `flow-${logged.flow}`); parts.push(`${logged.flow} flow`); }
  else if (logged && logged.flow === 'spotting') { cls.push('spotting'); parts.push('spotting'); }
  else if (marks.period.has(key)) { cls.push('predicted'); parts.push('predicted period'); }
  if (!cls.includes('period') && marks.ovulation.has(key)) { cls.push('ovulation'); parts.push('estimated ovulation'); }
  else if (!cls.includes('period') && !cls.includes('predicted') && marks.fertile.has(key)) { cls.push('fertile'); parts.push('fertile window'); }
  const hasExtra = logged && (logged.symptoms.length || logged.note);
  if (hasExtra) parts.push('notes logged');
  const label = `${fmt.date(parseDay(key), { weekday: 'long', month: 'long' })}${parts.length ? `, ${parts.join(', ')}` : ''}`;
  const btn = el('button', {
    class: cls.join(' '), type: 'button', 'aria-label': label,
    'aria-disabled': future ? 'true' : null, tabindex: future ? '-1' : null,
  }, el('span', { class: 'num', text: String(n) }), hasExtra ? el('span', { class: 'extra', 'aria-hidden': 'true' }) : null);
  if (!future) btn.addEventListener('click', () => openDay(key));
  return btn;
}

function changeMonth(delta) {
  haptic('light');
  state.month = addMonths(state.month, delta);
  renderCalendar();
  const monthStart = `${state.month}-01`;
  if (state.from && monthStart < state.from) load({ from: monthStart });
}

function renderStats() {
  const st = state.summary && state.summary.stats;
  if (!st) {
    els.stats.replaceChildren(el('div', { class: 'kv' }, el('span', { class: 'k', text: 'Loading…' })));
    return;
  }
  const kv = (k, v) => el('div', { class: 'kv' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));
  const rows = [
    kv('Cycle length', st.defaulted ? '28 days (assumed)' : `${fmtNum(st.avg_cycle)} days`),
    kv('Period length', `${fmtNum(st.avg_period)} days${state.summary.periods.length ? '' : ' (assumed)'}`),
    kv('Cycles logged', String(st.cycles_tracked)),
  ];
  if (st.shortest_cycle !== null) rows.push(kv('Range', st.shortest_cycle === st.longest_cycle ? `${st.shortest_cycle} days` : `${st.shortest_cycle}–${st.longest_cycle} days`));
  els.stats.replaceChildren(...rows);
}

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function renderHistory() {
  const periods = (state.summary && state.summary.periods) || [];
  els.history.replaceChildren(...periods.slice(0, 24).map((p) => {
    const range = p.start === p.end ? shortDate(p.start) : `${shortDate(p.start)} – ${shortDate(p.end)}`;
    const meta = `${p.length} ${p.length === 1 ? 'day' : 'days'}${p.cycle_length ? ` · ${p.cycle_length}-day cycle` : ''}`;
    return el('li', { class: 'row' },
      el('button', { class: 'hist', type: 'button', 'aria-label': `${range}, ${meta}`, 'on:click': () => jumpTo(p.start) },
        el('span', { class: 'bar', 'aria-hidden': 'true' }),
        el('span', { class: 'range', text: range }),
        el('span', { class: 'meta', text: meta })));
  }));
  els.history.hidden = periods.length === 0;
  els.historyEmpty.hidden = !(state.loaded && periods.length === 0);
}

function jumpTo(key) {
  haptic('light');
  state.month = key.slice(0, 7);
  renderCalendar();
  els.calendar.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- day sheet

function openDay(key, preset = {}) {
  if (!state || !els || key > state.today) return;
  closeSheet();
  const existing = state.days.get(key);
  let flow = preset.flow !== undefined ? preset.flow : existing ? existing.flow : null;
  const symptoms = new Set(existing ? existing.symptoms : []);

  const flowBtns = FLOWS.map((f) => el('button', {
    class: 'seg', type: 'button', role: 'radio', 'aria-checked': String(f.value === flow), text: f.label,
    'on:click': () => {
      haptic('light');
      flow = f.value;
      for (const [i, b] of flowBtns.entries()) b.setAttribute('aria-checked', String(FLOWS[i].value === flow));
    },
  }));
  const chips = SYMPTOMS.map(([value, label]) => {
    const chip = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(symptoms.has(value)), text: label });
    chip.addEventListener('click', () => {
      haptic('light');
      if (symptoms.has(value)) symptoms.delete(value); else symptoms.add(value);
      chip.setAttribute('aria-pressed', String(symptoms.has(value)));
    });
    return chip;
  });
  const note = el('textarea', { class: 'input note', rows: '2', maxlength: '500', placeholder: 'Note', 'aria-label': 'Note' });
  note.value = existing ? existing.note : '';

  const save = el('button', { class: 'primary', type: 'button', text: 'Save' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const data = await api(`/api/period/days/${key}?today=${state.today}`, {
        method: 'PUT', body: { flow, symptoms: [...symptoms], note: note.value },
      });
      if (!state) return;
      if (data.day && (data.day.flow || data.day.symptoms.length || data.day.note)) state.days.set(key, data.day);
      else state.days.delete(key);
      applySummary(data.summary || {});
      state.loaded = true;
      render();
      haptic('success');
      closeSheet();
    } catch (err) {
      if (!state) return;
      save.disabled = false;
      toast(failureMessage('save', err), { kind: 'error' });
      haptic('error');
    }
  });

  const groups = [
    el('div', { class: 'group form' },
      el('h2', { class: 'title', text: key === state.today ? `Today · ${longDate(key)}` : longDate(key) }),
      el('p', { class: 'label', text: 'Flow' }),
      el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Flow' }, flowBtns),
      el('p', { class: 'label', text: 'Symptoms' }),
      el('div', { class: 'chips' }, chips),
      note,
      save),
  ];
  if (existing) {
    groups.push(el('div', { class: 'group' }, el('button', {
      class: 'cancel destructive', type: 'button', text: 'Clear day',
      'on:click': async () => {
        const ok = await confirmSheet({ title: `Clear ${shortDate(key)}?`, message: 'Its flow, symptoms and note are removed.', confirmLabel: 'Clear', destructive: true });
        if (ok && state) clearDay(key);
      },
    })));
  }
  groups.push(el('div', { class: 'group' }, el('button', { class: 'cancel', type: 'button', text: 'Cancel', 'on:click': () => closeSheet() })));

  const backdrop = el('div', { class: 'backdrop', 'on:click': () => closeSheet() });
  const panel = el('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Log ${longDate(key)}` }, groups);
  const node = el('div', { class: 'sheet' }, backdrop, panel);
  const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); closeSheet(); } };
  const onViewport = () => {
    const vv = window.visualViewport;
    if (!vv || !sheet) return;
    const covered = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    panel.style.transform = covered > 0 ? `translateY(-${Math.round(covered)}px)` : '';
  };
  document.addEventListener('keydown', onKey);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewport);
    window.visualViewport.addEventListener('scroll', onViewport);
  }
  for (const stale of els.root.querySelectorAll(':scope > .sheet')) stale.remove();
  els.root.append(node);
  holdReload(HOLD_KEY);
  sheet = { node, onKey, onViewport };
  haptic('light');
}

async function clearDay(key) {
  closeSheet();
  try {
    const data = await api(`/api/period/days/${key}?today=${state.today}`, { method: 'DELETE' });
    if (!state) return;
    state.days.delete(key);
    applySummary(data.summary || {});
    render();
  } catch (err) {
    if (!state) return;
    toast(failureMessage('clear the day', err), { kind: 'error' });
    haptic('error');
  }
}

function closeSheet() {
  if (!sheet) return;
  const { node, onKey, onViewport } = sheet;
  sheet = null;
  document.removeEventListener('keydown', onKey);
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', onViewport);
    window.visualViewport.removeEventListener('scroll', onViewport);
  }
  releaseReload(HOLD_KEY);
  node.classList.add('out');
  setTimeout(() => node.remove(), 170);
}
