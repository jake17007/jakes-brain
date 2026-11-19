// Goals: long-term goals. The list shows each goal's progress and time left; a goal's page
// (#/goals/<id>) has its why, milestones, check-ins and status. Data: /api/goals (server/apps/goals.js).
import * as kit from '../../kit.js';
import { formSheet } from '../../form.js';

const {
  api, el, fmt, toast, haptic, navbar, navButton, section, emptyState, confirmSheet, actionSheet,
  holdReload, releaseReload, icon, nav,
} = kit;

const AREAS = [
  ['health', 'Health'], ['career', 'Career'], ['money', 'Money'],
  ['relationships', 'Relationships'], ['personal', 'Personal'], ['other', 'Other'],
];
const AREA_LABEL = Object.fromEntries(AREAS);
const STATUS_TITLE = { active: 'Active', paused: 'Paused', done: 'Achieved', dropped: 'Dropped' };
const STALE_DAYS = 30;          // an active goal with no check-in for this long gets a nudge
const HOLD_KEY = 'goals:typing';

let root = null;
let view = null;                // { kind: 'list' } | { kind: 'goal', id }
let goals = [];
let goal = null;                // the open goal (full, with milestones and check-ins)
let loaded = false;
let listeners = [];

export default {
  mount(rootEl, ctx) {
    root = rootEl;
    listen(window, 'jakesdata:online', refresh);
    listen(window, 'jakesdata:foreground', refresh);
    listen(document, 'visibilitychange', () => { if (!document.hidden) refresh(); });
    open(ctx.sub);
  },
  route(sub) { open(sub); },
  unmount() {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    releaseReload(HOLD_KEY);
    root = null;
    goal = null;
    loaded = false;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

function open(sub) {
  const id = /^\d+$/.test(String(sub || '')) ? Number(sub) : null;
  view = id ? { kind: 'goal', id } : { kind: 'list' };
  if (view.kind === 'goal' && (!goal || goal.id !== id)) goal = null;
  render();
  refresh();
}

// Claude can change goals from elsewhere, so every return to the app reloads. Never re-render
// over a milestone being typed.
async function refresh() {
  if (!root) return;
  const want = view;
  try {
    if (want.kind === 'list') {
      const data = await api('/api/goals');
      if (!root || view !== want) return;
      goals = data.goals || [];
      loaded = true;
    } else {
      const data = await api(`/api/goals/${want.id}`);
      if (!root || view !== want) return;
      goal = data.goal;
    }
    if (!typing()) render();
  } catch (err) {
    if (!root || view !== want) return;
    if (err && err.status === 404 && want.kind === 'goal') {
      toast('That goal is gone');
      nav.replace('#/goals');
    }
    /* otherwise keep what is on screen; the banner reports an outage */
  }
}

function typing() {
  const active = document.activeElement;
  return Boolean(root && active && root.contains(active) && active.matches('input, textarea') && active.value.trim());
}

function render() {
  if (!root) return;
  releaseReload(HOLD_KEY);
  if (view.kind === 'list') renderList();
  else renderGoal();
}

// ---------------------------------------------------------------- formatting

const dayDate = (key) => new Date(`${key}T12:00:00`);

function daysUntil(key) {
  const today = dayDate(fmt.dayKey());
  return Math.round((dayDate(key) - today) / 86_400_000);
}

function span(days) {
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  const months = Math.round(days / 30.44);
  if (months < 12) return `${months} months`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} yr ${rest} mo` : `${years} year${years === 1 ? '' : 's'}`;
}

// "10 months left", "Due today", "3 weeks overdue"
function timeLeft(key) {
  const days = daysUntil(key);
  if (days === 0) return { text: 'Due today', late: false };
  if (days < 0) return { text: `${span(-days)} overdue`, late: true };
  return { text: `${span(days)} left`, late: false };
}

const longDate = (key) => fmt.date(dayDate(key), { month: 'short', day: 'numeric', year: true });

function num(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function withUnit(n, unit) {
  if (n === null || n === undefined) return '—';
  if (!unit) return num(n);
  return /^[$€£¥]$/.test(unit) ? `${unit}${num(n)}` : `${num(n)} ${unit}`;
}

// "$18,500 of $50,000" / "24 of 30 books"
function ofLine(current, target, unit) {
  if (!unit || /^[$€£¥]$/.test(unit)) return `${withUnit(current, unit)} of ${withUnit(target, unit)}`;
  return `${current === null || current === undefined ? '—' : num(current)} of ${withUnit(target, unit)}`;
}

const pct = (p) => `${Math.round(p * 100)}%`;

function checkinAge(key) {
  const days = -daysUntil(key);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${span(days)} ago`;
}

const isMetric = (g) => g.target_value !== null && g.target_value !== undefined;

function stale(g) {
  if (g.status !== 'active') return false;
  const since = g.last_checkin || g.created_at.slice(0, 10);
  return -daysUntil(since) >= STALE_DAYS;
}

function progressBar(g) {
  const fill = el('div', { class: 'gl-fill' });
  fill.style.width = pct(g.progress || 0);
  return el('div', { class: `gl-bar${g.status === 'done' ? ' done' : ''}`, role: 'progressbar',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round((g.progress || 0) * 100)) }, fill);
}

function areaTag(area) {
  return el('span', { class: 'gl-area' }, el('span', { class: 'gl-dot', dataset: { area } }), AREA_LABEL[area] || 'Other');
}

// ---------------------------------------------------------------- list

function renderList() {
  const byStatus = (s) => goals.filter((g) => g.status === s);
  const groups = ['active', 'paused', 'done', 'dropped']
    .map((s) => [s, byStatus(s)])
    .filter(([, list]) => list.length);
  root.replaceChildren(
    navbar({ title: 'Goals', right: [navButton({ label: 'New goal', icon: 'plus', onClick: () => editGoal(null) })] }),
    el('div', { class: 'app-content' },
      loaded && !goals.length
        ? el('div', { class: 'gl-empty' },
          el('p', { text: 'No goals yet.' }),
          el('p', { class: 'muted', text: 'Add the big things you are working toward over months or years. Break them into milestones, and check in every few weeks.' }),
          el('button', { class: 'button', type: 'button', text: 'Add a goal', 'on:click': () => editGoal(null) }))
        : null,
      groups.map(([status, list]) => [
        section(status === 'active' ? `Active · ${list.length}` : STATUS_TITLE[status]),
        el('div', { class: 'card gl-list' }, list.map(goalRow)),
      ])));
}

function goalRow(g) {
  const sub = [areaTag(g.area)];
  if (g.status === 'done' && g.done_at) sub.push(el('span', { text: `Achieved ${fmt.date(g.done_at)}` }));
  else if (g.target_date && g.status !== 'dropped') {
    const left = timeLeft(g.target_date);
    sub.push(el('span', { class: left.late && g.status === 'active' ? 'late' : '', text: left.text }));
  }
  let detail = null;
  if (g.status === 'active' || g.status === 'paused') {
    if (isMetric(g)) detail = ofLine(g.current_value, g.target_value, g.unit);
    else if (g.next_milestone) detail = `Next: ${g.next_milestone}`;
  }
  return el('button', { class: `gl-row status-${g.status}`, type: 'button', 'on:click': () => nav.go(`#/goals/${g.id}`) },
    el('div', { class: 'gl-top' },
      el('span', { class: 'gl-title', text: g.title }),
      g.progress !== null ? el('span', { class: 'gl-pct', text: pct(g.progress) }) : null,
      icon('chevron-right', { size: 18 })),
    g.progress !== null && g.status !== 'dropped' ? progressBar(g) : null,
    el('div', { class: 'gl-sub' }, sub.map((node, i) => (i ? [el('span', { class: 'sep', text: '·' }), node] : node))),
    detail ? el('div', { class: 'gl-detail', text: detail }) : null,
    stale(g) ? el('div', { class: 'gl-nudge', text: g.last_checkin ? `No check-in for ${span(-daysUntil(g.last_checkin))}` : 'No check-ins yet' }) : null);
}

// ---------------------------------------------------------------- one goal

function renderGoal() {
  const bar = navbar({
    title: 'Goal',
    back: true,
    right: goal ? [navButton({ label: 'Edit', onClick: () => editGoal(goal) })] : [],
  });
  if (!goal) {
    root.replaceChildren(bar, el('div', { class: 'app-content' }));
    return;
  }
  const g = goal;
  root.replaceChildren(bar, el('div', { class: 'app-content gl-page' },
    headCard(g),
    g.why ? [section('Why'), el('div', { class: 'card gl-why', text: g.why })] : null,
    milestonesBlock(g),
    checkinsBlock(g),
    statusButtons(g)));
}

function headCard(g) {
  const meta = [areaTag(g.area)];
  if (g.target_date) {
    meta.push(el('span', { text: `by ${longDate(g.target_date)}` }));
    if (g.status === 'active' || g.status === 'paused') {
      const left = timeLeft(g.target_date);
      meta.push(el('span', { class: left.late ? 'late' : '', text: left.text }));
    }
  }
  let progressLine = null;
  if (g.status === 'done') progressLine = `Achieved ${fmt.date(g.done_at || g.updated_at)}`;
  else if (g.progress_source === 'metric') progressLine = `${ofLine(g.current_value, g.target_value, g.unit)} · started at ${withUnit(g.start_value, g.unit)}`;
  else if (g.progress_source === 'milestones') progressLine = `${g.milestones_done} of ${g.milestones_total} milestones`;
  return el('div', { class: 'card gl-head' },
    el('div', { class: 'gl-head-top' },
      el('h2', { class: 'gl-head-title', text: g.title }),
      g.status !== 'active' ? el('span', { class: `gl-pill ${g.status}`, text: STATUS_TITLE[g.status] }) : null),
    el('div', { class: 'gl-sub' }, meta.map((node, i) => (i ? [el('span', { class: 'sep', text: '·' }), node] : node))),
    g.progress !== null
      ? el('div', { class: 'gl-progress' },
        el('div', { class: 'gl-big', text: pct(g.progress) }),
        progressBar(g),
        progressLine ? el('div', { class: 'gl-detail', text: progressLine }) : null)
      : el('p', { class: 'gl-hint', text: 'Add milestones or a number to aim for (Edit) to see progress.' }));
}

function milestonesBlock(g) {
  const input = el('input', {
    class: 'input gl-add-input', type: 'text', placeholder: 'Add a milestone', maxlength: '300',
    autocapitalize: 'sentences', enterkeyhint: 'done', 'aria-label': 'New milestone', autocomplete: 'off',
  });
  const add = el('button', { class: 'gl-add-btn', type: 'submit', text: 'Add', disabled: true });
  const sync = () => {
    add.disabled = !input.value.trim();
    if (document.activeElement === input && input.value.trim()) holdReload(HOLD_KEY);
    else releaseReload(HOLD_KEY);
  };
  input.addEventListener('input', sync);
  input.addEventListener('focus', sync);
  input.addEventListener('blur', () => releaseReload(HOLD_KEY));
  const form = el('form', { class: 'gl-add', autocomplete: 'off' }, input, add);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    add.disabled = true;
    try {
      const data = await api(`/api/goals/${g.id}/milestones`, { method: 'POST', body: { text: value } });
      if (!root || !goal || goal.id !== g.id) return;
      haptic('success');
      goal = data.goal;
      releaseReload(HOLD_KEY);
      render();
      const again = root.querySelector('.gl-add-input');
      if (again) again.focus();
    } catch (err) {
      add.disabled = false;
      toast(err.message, { kind: 'error' });
    }
  });
  return [
    section('Milestones'),
    el('div', { class: 'card gl-milestones' },
      g.milestones.map((m) => milestoneRow(g, m)),
      form),
  ];
}

function milestoneRow(g, m) {
  const check = el('button', {
    class: 'gl-check', type: 'button', role: 'checkbox', 'aria-checked': String(m.done),
    'aria-label': m.done ? 'Mark as not done' : 'Mark as done',
    'on:click': () => toggleMilestone(g, m),
  }, icon('check', { size: 14, strokeWidth: 2.6 }));
  const due = m.due_date && !m.done ? timeLeft(m.due_date) : null;
  return el('div', { class: `gl-ms${m.done ? ' done' : ''}` },
    check,
    el('button', { class: 'gl-ms-text', type: 'button', 'on:click': () => editMilestone(g, m) },
      el('span', { class: 'gl-ms-label', text: m.text }),
      m.done && m.done_at ? el('span', { class: 'gl-ms-due', text: `Done ${fmt.date(m.done_at, { month: 'short', day: 'numeric' })}` }) : null,
      due ? el('span', { class: `gl-ms-due${due.late ? ' late' : ''}`, text: `${longDate(m.due_date)} · ${due.text}` }) : null));
}

async function toggleMilestone(g, m) {
  haptic('light');
  const before = goal;
  // Flip it on screen first; the server's answer replaces it.
  goal = { ...goal, milestones: goal.milestones.map((x) => (x.id === m.id ? { ...x, done: !m.done } : x)) };
  render();
  try {
    const data = await api(`/api/goals/${g.id}/milestones/${m.id}`, { method: 'PATCH', body: { done: !m.done } });
    if (!root || !goal || goal.id !== g.id) return;
    goal = data.goal;
    if (!m.done && goal.milestones.every((x) => x.done) && goal.status === 'active') haptic('success');
    render();
  } catch (err) {
    if (!root) return;
    goal = before;
    render();
    toast(err.message, { kind: 'error' });
  }
}

async function editMilestone(g, m) {
  const result = await formSheet({
    title: 'Milestone',
    canDelete: true,
    fields: [
      { key: 'text', label: 'Milestone', value: m.text, required: true },
      { key: 'due_date', label: 'Aim to finish by (optional)', type: 'date', value: m.due_date || '' },
    ],
  });
  if (!result) return;
  try {
    let data;
    if (result === 'delete') {
      const ok = await confirmSheet({ title: 'Delete this milestone?', message: m.text, confirmLabel: 'Delete', destructive: true });
      if (!ok) return;
      data = await api(`/api/goals/${g.id}/milestones/${m.id}`, { method: 'DELETE' });
    } else {
      data = await api(`/api/goals/${g.id}/milestones/${m.id}`, { method: 'PATCH', body: { text: result.text, due_date: result.due_date || null } });
    }
    if (!root || !goal || goal.id !== g.id) return;
    goal = data.goal;
    render();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

function checkinsBlock(g) {
  let hint;
  if (g.last_checkin) hint = `Last check-in ${checkinAge(g.last_checkin)}.`;
  else hint = 'A short note every few weeks keeps a long goal moving.';
  return [
    section('Check-ins'),
    el('button', { class: 'button gl-checkin-btn', type: 'button', text: 'Check in', 'on:click': () => checkIn(g) }),
    el('p', { class: `gl-hint${stale(g) ? ' nudge' : ''}`, text: hint }),
    g.checkins.length
      ? el('div', { class: 'card gl-checkins' }, g.checkins.map((c) => checkinRow(g, c)))
      : null,
  ];
}

function checkinRow(g, c) {
  return el('button', { class: 'gl-ci', type: 'button', 'on:click': () => checkinActions(g, c) },
    el('div', { class: 'gl-ci-top' },
      el('span', { class: 'gl-ci-date', text: fmt.date(dayDate(c.date), { month: 'short', day: 'numeric' }) }),
      c.value !== null ? el('span', { class: 'gl-ci-value', text: withUnit(c.value, g.unit) }) : null),
    c.note ? el('div', { class: 'gl-ci-note', text: c.note }) : null);
}

async function checkinActions(g, c) {
  const choice = await actionSheet({
    title: fmt.date(dayDate(c.date), { weekday: 'long', month: 'long', day: 'numeric', year: true }),
    actions: [{ label: 'Delete check-in', value: 'delete', destructive: true }],
  });
  if (choice !== 'delete') return;
  try {
    const data = await api(`/api/goals/${g.id}/checkins/${c.id}`, { method: 'DELETE' });
    if (!root || !goal || goal.id !== g.id) return;
    goal = data.goal;
    render();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

async function checkIn(g) {
  const fields = [{ key: 'note', label: 'How is it going?', type: 'textarea', placeholder: 'What moved, what is in the way, what is next' }];
  if (isMetric(g)) fields.push({ key: 'value', label: `Where you are now${g.unit ? ` (${g.unit})` : ''}`, type: 'number', value: g.current_value ?? '' });
  fields.push({ key: 'date', label: 'Date', type: 'date', value: fmt.dayKey() });
  const result = await formSheet({ title: 'Check in', fields, saveLabel: 'Save' });
  if (!result) return;
  const body = { note: result.note, date: result.date || null };
  // Send the number when it moved, or when it is all this check-in says.
  if (isMetric(g) && result.value !== null && (result.value !== g.current_value || !result.note)) body.value = result.value;
  if (!body.note && body.value === undefined) {
    toast('Write a note or update the number', { kind: 'error' });
    return;
  }
  try {
    const data = await api(`/api/goals/${g.id}/checkins`, { method: 'POST', body });
    if (!root || !goal || goal.id !== g.id) return;
    haptic('success');
    goal = data.goal;
    render();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

function statusButtons(g) {
  const btn = (label, status, cls = '') => el('button', {
    class: `button ${cls}`.trim(), type: 'button', text: label, 'on:click': () => setStatus(g, status),
  });
  const buttons = [];
  if (g.status === 'active') buttons.push(btn('Mark as achieved', 'done'), btn('Pause', 'paused'), btn('Drop this goal', 'dropped', 'destructive'));
  else if (g.status === 'paused') buttons.push(btn('Resume', 'active'), btn('Mark as achieved', 'done'), btn('Drop this goal', 'dropped', 'destructive'));
  else buttons.push(btn('Make active again', 'active'));
  return el('div', { class: 'gl-status' }, buttons);
}

async function setStatus(g, status) {
  if (status === 'dropped') {
    const ok = await confirmSheet({
      title: 'Drop this goal?',
      message: 'It moves to Dropped with its milestones and check-ins kept. You can make it active again later.',
      confirmLabel: 'Drop goal',
      destructive: true,
    });
    if (!ok) return;
  }
  try {
    const data = await api(`/api/goals/${g.id}`, { method: 'PATCH', body: { status } });
    if (!root || !goal || goal.id !== g.id) return;
    haptic(status === 'done' ? 'success' : 'light');
    if (status === 'done') toast('Goal achieved');
    goal = data.goal;
    render();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

// ---------------------------------------------------------------- new / edit goal

function goalFields(g) {
  return [
    { key: 'title', label: 'Goal', value: g ? g.title : '', required: true, placeholder: 'Run a marathon' },
    { key: 'why', label: 'Why it matters', type: 'textarea', value: g ? g.why : '', placeholder: 'What changes when you get there' },
    { key: 'area', label: 'Area', type: 'select', value: g ? g.area : 'personal', options: AREAS.map(([value, label]) => ({ value, label })) },
    { key: 'target_date', label: 'Target date (optional)', type: 'date', value: g ? g.target_date || '' : '' },
    { key: 'unit', label: 'Measure it with a number? Unit (optional)', value: g ? g.unit : '', placeholder: '$, lb, books, miles' },
    { key: 'start_value', label: 'Starting number', type: 'number', value: g ? g.start_value ?? '' : '' },
    { key: 'target_value', label: 'Target number', type: 'number', value: g ? g.target_value ?? '' : '' },
    { key: 'current_value', label: 'Where you are now', type: 'number', value: g ? g.current_value ?? '' : '' },
  ];
}

async function editGoal(g) {
  const result = await formSheet({ title: g ? 'Edit goal' : 'New goal', fields: goalFields(g), canDelete: Boolean(g), saveLabel: g ? 'Save' : 'Add' });
  if (!result) return;
  try {
    if (result === 'delete') {
      const ok = await confirmSheet({
        title: 'Delete this goal?',
        message: `"${g.title}" and its milestones and check-ins will be deleted. To keep the history, drop it instead.`,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      await api(`/api/goals/${g.id}`, { method: 'DELETE' });
      haptic('success');
      goal = null;
      nav.replace('#/goals');
      return;
    }
    if (g) {
      const data = await api(`/api/goals/${g.id}`, { method: 'PATCH', body: result });
      if (!root) return;
      goal = data.goal;
      render();
    } else {
      const data = await api('/api/goals', { method: 'POST', body: result });
      if (!root) return;
      haptic('success');
      goal = data.goal;
      nav.go(`#/goals/${data.goal.id}`);
    }
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
