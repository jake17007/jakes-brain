import { api, el, fmt, toast, haptic, confirmSheet, navbar, navButton, section, emptyState, holdReload, releaseReload } from '../../kit.js';

const hm = (min) => (min == null ? '–' : `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`);
const t12 = (t) => {
  const h = Number(t.slice(0, 2));
  return `${((h + 11) % 12) + 1}:${t.slice(3)} ${h < 12 ? 'AM' : 'PM'}`;
};
const dayLabel = (d) => fmt.date(new Date(`${d}T12:00:00`), { weekday: 'short', month: 'short', day: 'numeric' });

let cleanup = null;

export default {
  async mount(root) {
    let entries = [];
    let summary = null;
    let goalH = 8;
    let sheet = null;

    const body = el('div', { class: 'app-content sl-body' });
    root.append(
      navbar({ title: 'Sleep', right: [navButton({ icon: 'plus', label: 'Log sleep', onClick: () => openSheet() })] }),
      body,
    );

    async function load() {
      try {
        const [e, s, st] = await Promise.all([
          api('/api/sleep/entries?days=60'),
          api('/api/sleep/summary?days=7'),
          api('/api/settings'),
        ]);
        entries = e.entries;
        summary = s;
        const g = Number(st.settings?.['sleep.goal_hours']);
        goalH = g >= 3 && g <= 14 ? g : 8;
        render();
      } catch (err) {
        body.replaceChildren(emptyState(`Couldn't load sleep: ${err.message}`));
      }
    }

    async function setGoal(h) {
      h = Math.min(12, Math.max(5, h));
      goalH = h;
      try { await api('/api/settings', { method: 'PATCH', body: { 'sleep.goal_hours': h } }); } catch (err) { toast(err.message, { kind: 'error' }); }
      load();
    }

    function chart() {
      const last = entries.slice(0, 14).reverse();
      const goal = goalH * 60;
      const top = Math.max(goal, ...last.map((x) => x.minutes)) * 1.05;
      return el('div', { class: 'sl-chart' },
        el('div', { class: 'sl-goal', style: { bottom: `${(goal / top) * 100}%` } }),
        ...last.map((x) => el('div', { class: 'sl-col', title: `${dayLabel(x.date)} · ${hm(x.minutes)}` },
          el('div', { class: `sl-bar${x.minutes >= goal ? ' ok' : ''}`, style: { height: `${(x.minutes / top) * 100}%` } }),
          el('span', { text: dayLabel(x.date).split(' ')[0].slice(0, 1) }))));
    }

    function render() {
      const nodes = [];
      const s = summary;
      nodes.push(el('div', { class: 'sl-card' },
        el('div', { class: 'sl-big', text: s?.nights ? hm(s.avg_minutes) : '–' }),
        el('div', { class: 'sl-sub', text: s?.nights ? `average over ${s.nights} night${s.nights > 1 ? 's' : ''} (last 7 days)` : 'No nights logged in the last 7 days' }),
        el('div', { class: 'sl-stats' },
          stat('Quality', s?.avg_quality != null ? `${s.avg_quality}/5` : '–'),
          stat('Resting HR', s?.avg_hr != null ? `${Math.round(s.avg_hr)} bpm` : '–'),
          stat('Sleep debt', s?.nights ? hm(s.debt_minutes) : '–'),
          stat('Bedtime range', s?.bedtime_spread_minutes != null ? hm(s.bedtime_spread_minutes) : '–')),
        el('div', { class: 'sl-goalrow' },
          el('span', { text: `Goal ${goalH}h` }),
          el('button', { text: '−', 'aria-label': 'Lower goal', 'on:click': () => setGoal(goalH - 0.5) }),
          el('button', { text: '+', 'aria-label': 'Raise goal', 'on:click': () => setGoal(goalH + 0.5) }))));

      if (!entries.length) {
        nodes.push(emptyState('Nothing logged yet. Tap + to add last night.'));
      } else {
        nodes.push(section(entries.length < 14 ? 'Recent nights' : 'Last 14 nights'), chart(), section('Log'));
        nodes.push(el('div', { class: 'sl-list' }, ...entries.map((x) => el('button', { class: 'sl-row', 'on:click': () => openSheet(x) },
          el('div', { class: 'sl-rowmain' },
            el('div', { class: 'sl-rowtitle', text: dayLabel(x.date) }),
            el('div', { class: 'sl-rowsub', text: `${t12(x.bedtime)} → ${t12(x.wake_time)}${x.resting_hr ? ` · ${x.resting_hr} bpm` : ''}` })),
          el('div', { class: 'sl-rowright' },
            el('div', { class: 'sl-rowdur', text: hm(x.minutes) }),
            x.quality ? el('div', { class: 'sl-rowsub', text: '●'.repeat(x.quality) + '○'.repeat(5 - x.quality) }) : null)))));
      }
      body.replaceChildren(...nodes);
    }

    const stat = (label, value) => el('div', { class: 'sl-stat' }, el('div', { class: 'sl-statv', text: value }), el('div', { class: 'sl-statl', text: label }));

    function openSheet(entry) {
      if (sheet) return;
      const last = entries[0];
      const f = {
        date: entry?.date || fmt.dayKey(new Date()),
        bedtime: entry?.bedtime || last?.bedtime || '23:00',
        wake_time: entry?.wake_time || last?.wake_time || '07:00',
        quality: entry?.quality ?? null,
        resting_hr: entry?.resting_hr ?? '',
        notes: entry?.notes || '',
      };
      const input = (type, key, extra = {}) => el('input', { type, value: f[key], class: 'sl-input', ...extra, 'on:input': (e) => { f[key] = e.target.value; } });
      const stars = el('div', { class: 'sl-quality' });
      const drawStars = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => el('button', {
        class: f.quality === n ? 'on' : '', text: String(n),
        'on:click': () => { f.quality = f.quality === n ? null : n; haptic('light'); drawStars(); },
      })));
      drawStars();
      const field = (label, node) => el('label', { class: 'sl-field' }, el('span', { text: label }), node);

      const close = () => { sheet.remove(); sheet = null; releaseReload('sleep-sheet'); };
      const save = async () => {
        const payload = {
          date: f.date, bedtime: f.bedtime, wake_time: f.wake_time, quality: f.quality,
          resting_hr: f.resting_hr === '' ? null : Number(f.resting_hr), notes: f.notes,
        };
        try {
          if (entry) await api(`/api/sleep/entries/${entry.id}`, { method: 'PATCH', body: payload });
          else await api('/api/sleep/entries', { method: 'POST', body: payload });
          haptic('success');
          close();
          load();
        } catch (err) { toast(err.message, { kind: 'error' }); haptic('error'); }
      };
      const del = async () => {
        if (!(await confirmSheet({ title: 'Delete this night?', message: dayLabel(entry.date), confirmLabel: 'Delete', destructive: true }))) return;
        try { await api(`/api/sleep/entries/${entry.id}`, { method: 'DELETE' }); close(); load(); } catch (err) { toast(err.message, { kind: 'error' }); }
      };

      sheet = el('div', { class: 'sl-sheetwrap' },
        el('div', { class: 'sl-scrim', 'on:click': close }),
        el('div', { class: 'sl-sheet' },
          el('div', { class: 'sl-sheethead' },
            el('button', { text: 'Cancel', 'on:click': close }),
            el('strong', { text: entry ? 'Edit night' : 'Log sleep' }),
            el('button', { class: 'primary', text: 'Save', 'on:click': save })),
          field('Woke up on', input('date', 'date')),
          el('div', { class: 'sl-two' }, field('Bedtime', input('time', 'bedtime')), field('Wake time', input('time', 'wake_time'))),
          field('Quality (1–5)', stars),
          field('Resting heart rate (bpm)', input('number', 'resting_hr', { inputmode: 'numeric', min: '30', max: '220' })),
          field('Notes', el('textarea', { class: 'sl-input', rows: '3', text: f.notes, 'on:input': (e) => { f.notes = e.target.value; } })),
          entry ? el('button', { class: 'sl-delete', text: 'Delete night', 'on:click': del }) : null));
      holdReload('sleep-sheet');
      root.append(sheet);
    }

    cleanup = () => { releaseReload('sleep-sheet'); };
    await load();
  },

  unmount() { cleanup?.(); cleanup = null; },
};
