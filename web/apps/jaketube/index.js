// JakeTube: a YouTube feed of a few channels (jvscholz, sentdex and Tina Huang unless the
// server's cfg.youtubeChannels says otherwise). Home (#/jaketube) = channel chips + the newest
// uploads as cards (16:9 thumb, a "Short" pill, channel · views · age). Watch
// (#/jaketube/v/<id>) = the YouTube player embedded, title, meta, "Open in YouTube", the
// description, then more from the same channel. The reload is held while a watch page is open.
//
// #/jaketube/watch/<id> still plays a file from the PC's video folders (<video> streamed from
// /api/jaketube/stream/<id>, "Resume from 12:34", progress saved every 5 s and on
// pause/unmount): the Day Log "Watch this vlog" button and Graph video nodes link there, but
// the home no longer lists those files.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, navButton, section, emptyState, holdReload, releaseReload, store, nav } = kit;

const CHANNEL_KEY = 'jaketube.feedChannel'; // the chip that was selected last time
const HOLD_WATCHING = 'jaketube:watching';
const HOLD_PLAYING = 'jaketube:playing';
const EMBED_URL = 'https://www.youtube-nocookie.com/embed/';
const MORE_MAX = 20;
const DESC_CLAMP_LINES = 4;
const DESC_CLAMP_CHARS = 240;
const SAVE_EVERY_MS = 5_000;
const RESUME_MIN_S = 5;                   // no "Resume from" inside the first 5 s (10 % of a short clip)
const RESUME_TAIL_S = 10;                 // or the last 10 s (5 % of a short clip): that one is watched
const WIDE_QUERY = '(min-width: 700px)';  // the watch page takes the whole window on the PC
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

let app = null; // { root, view, channel, channels, videos, videosKey, stale, homeScroll, listeners, wide }

export default {
  mount(root, ctx) {
    app = {
      root,
      view: null,
      channel: readStoredChannel(),
      channels: null,
      videos: null,
      videosKey: null,
      stale: false,
      homeScroll: 0,
      listeners: [],
      wide: window.matchMedia(WIDE_QUERY),
    };
    listen(window, 'jakesdata:online', onRefresh);
    listen(window, 'jakesdata:foreground', onRefresh);
    listen(document, 'visibilitychange', onVisibility);
    if (typeof app.wide.addEventListener === 'function') listen(app.wide, 'change', syncFullBleed);
    showRoute(ctx.sub);
  },

  route(sub) {
    if (app) showRoute(sub);
  },

  unmount() {
    if (!app) return;
    teardownView();
    for (const [target, type, fn] of app.listeners) target.removeEventListener(type, fn);
    app.root.classList.remove('full-bleed');
    app = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  app.listeners.push([target, type, fn]);
}

// The #app layer is the scroll container (the launcher owns it); root is its only child.
function scroller() {
  return app.root.parentElement || document.getElementById('app') || document.documentElement;
}

function showRoute(sub) {
  const s = String(sub == null ? '' : sub);
  const yt = /^v\/([A-Za-z0-9_-]{11})$/.exec(s);
  const file = /^watch\/([0-9a-f]{16})$/.exec(s);
  if (yt) showYouTube(yt[1]);
  else if (file) showFile(file[1]);
  else if (!s) showHome();
  else nav.replace('#/jaketube');
}

function onRefresh() {
  if (app && app.view && app.view.kind === 'home') loadFeed({ quiet: true });
}

function onVisibility() {
  if (!app || !app.view) return;
  if (document.hidden) {
    if (app.view.kind === 'file') saveProgress(app.view);
  } else if (app.view.kind === 'home') {
    loadFeed({ quiet: true });
  }
}

function teardownView() {
  const v = app.view;
  if (!v) return;
  app.view = null;
  if (v.kind === 'youtube') {
    v.frame.remove(); // stops the sound right away
    releaseReload(HOLD_WATCHING);
  } else if (v.kind === 'file') {
    stopSaving(v);
    saveProgress(v);
    releaseReload(HOLD_PLAYING);
    for (const off of v.off) off();
    v.off = [];
    try { v.video.pause(); } catch { /* never attached */ }
    v.video.removeAttribute('src');
    v.video.removeAttribute('poster');
    try { v.video.load(); } catch { /* ignore */ } // stops the download
  }
}

function syncFullBleed() {
  if (!app) return;
  const watching = Boolean(app.view && (app.view.kind === 'youtube' || app.view.kind === 'file'));
  app.root.classList.toggle('full-bleed', watching && app.wide.matches);
}

// ---------------------------------------------------------------- home (the feed)

function readStoredChannel() {
  const value = store.get(CHANNEL_KEY, '');
  return typeof value === 'string' ? value : '';
}

function showHome() {
  if (app.view && app.view.kind === 'home') {
    loadFeed({ quiet: true });
    return;
  }
  teardownView();
  syncFullBleed();

  const chips = el('div', { class: 'chips tube-chips', role: 'group', 'aria-label': 'Channel' });
  const note = el('p', { class: 'tube-stale', text: "Couldn't reach YouTube, so this is the last feed it got." });
  note.hidden = true;
  const list = el('div', { class: 'tube-list' });
  const empty = emptyState('No videos yet.');
  empty.hidden = true;
  const refresh = navButton({ label: 'Refresh', icon: 'refresh', onClick: () => {
    haptic('light');
    loadFeed({ force: true });
  } });
  app.root.replaceChildren(
    navbar({ title: 'JakeTube', right: [refresh] }),
    el('div', { class: 'app-content tube-home' }, chips, note, list, empty),
  );

  const view = { kind: 'home', chips, note, list, empty, cards: new Map(), seq: 0, loaded: false };
  app.view = view;

  renderChips();
  if (app.videos && app.videosKey === app.channel) {
    view.loaded = true;
    renderList();
  }
  loadFeed();
  requestAnimationFrame(() => {
    if (app && app.view === view) scroller().scrollTop = app.homeScroll;
  });
}

async function loadFeed({ quiet = false, force = false } = {}) {
  const v = app.view;
  if (!v || v.kind !== 'home') return;
  const seq = ++v.seq;
  const key = app.channel;
  const params = new URLSearchParams();
  if (key) params.set('channel', key);
  if (force) params.set('refresh', '1');
  const qs = params.toString();
  try {
    const data = await api(`/api/jaketube/feed${qs ? `?${qs}` : ''}`);
    if (!app || app.view !== v || v.seq !== seq) return;
    app.channels = data && Array.isArray(data.channels) ? data.channels.filter((c) => c && typeof c.id === 'string') : [];
    app.videos = data && Array.isArray(data.videos) ? data.videos : [];
    app.videosKey = key;
    app.stale = Boolean(data && data.stale);
    v.loaded = true;
    renderChips();
    renderList();
  } catch (err) {
    if (!app || app.view !== v || v.seq !== seq) return;
    if (err && err.status === 400 && app.channel) {
      // the remembered chip is gone from the config: back to All
      app.channel = '';
      store.del(CHANNEL_KEY);
      renderChips();
      loadFeed({ quiet, force });
      return;
    }
    if (!quiet) {
      toast(err && err.status ? `Couldn't load the feed: ${err.message}` : "Couldn't load the feed — the PC is unreachable", { kind: 'error' });
    }
  }
}

function renderChips() {
  const v = app.view;
  if (!v || v.kind !== 'home') return;
  const items = [{ id: '', name: 'All' }, ...(app.channels || [])];
  v.chips.replaceChildren(...items.map((c) => el('button', {
    class: 'chip', type: 'button', text: c.name, 'aria-pressed': String(app.channel === c.id),
    'on:click': () => selectChannel(c.id),
  })));
}

function selectChannel(id) {
  if (!app || app.channel === id) return;
  haptic('light');
  app.channel = id;
  if (id) store.set(CHANNEL_KEY, id);
  else store.del(CHANNEL_KEY);
  renderChips();
  loadFeed();
}

// Cards are kept by id across refreshes so images do not flicker; only their text is patched.
function renderList() {
  const v = app.view;
  if (!v || v.kind !== 'home') return;
  const videos = app.videos || [];
  const nodes = [];
  const keep = new Set();
  for (const video of videos) {
    let card = v.cards.get(video.id);
    if (!card) {
      card = makeCard(video);
      v.cards.set(video.id, card);
    }
    card.parts.title.textContent = video.title;
    card.parts.sub.textContent = subtitleOf(video);
    nodes.push(card);
    keep.add(video.id);
  }
  for (const id of [...v.cards.keys()]) if (!keep.has(id)) v.cards.delete(id);
  v.list.replaceChildren(...nodes);
  v.note.hidden = !app.stale;
  v.empty.hidden = !(v.loaded && videos.length === 0);
}

function makeCard(video) {
  const title = el('div', { class: 'tube-card-title' });
  const sub = el('div', { class: 'tube-card-sub' });
  const card = el('button', { class: 'tube-card', type: 'button', dataset: { id: video.id }, 'aria-label': video.title },
    feedThumb(video), el('div', { class: 'tube-card-text' }, title, sub));
  card.addEventListener('click', () => {
    haptic('light');
    nav.go(`#/jaketube/v/${video.id}`);
  });
  card.parts = { title, sub };
  return card;
}

// A 16:9 box with YouTube's thumbnail (its 4:3 letterbox is cropped away) and a "Short" pill.
function feedThumb(video) {
  const img = el('img', { src: video.thumb, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.remove(), { once: true });
  return el('div', { class: 'tube-thumb' }, img, video.short ? el('span', { class: 'tube-dur', text: 'Short' }) : null);
}

function subtitleOf(video) {
  const parts = [video.channel_name || ''];
  if (Number.isFinite(video.views)) parts.push(`${compact.format(video.views)} views`);
  parts.push(ago(video.published));
  return parts.filter(Boolean).join(' · ');
}

// "5 minutes ago" … "3 weeks ago", then the date.
function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (s < 3600) return unit(Math.max(1, Math.floor(s / 60)), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  if (s < 7 * 86400) return unit(Math.floor(s / 86400), 'day');
  if (s < 30 * 86400) return unit(Math.floor(s / (7 * 86400)), 'week');
  return fmt.date(t);
}

// ---------------------------------------------------------------- watch (YouTube)

async function showYouTube(id) {
  const current = app.view;
  if (current && current.kind === 'youtube' && current.id === id) return;
  if (current && current.kind === 'home') app.homeScroll = scroller().scrollTop;
  teardownView();
  scroller().scrollTop = 0;

  const bar = navbar({ title: 'JakeTube', back: true });
  // The page's own Referrer-Policy is same-origin; the embed refuses to play without a referrer.
  const frame = el('iframe', {
    class: 'tube-frame', src: `${EMBED_URL}${id}?autoplay=1&playsinline=1&rel=0`, title: 'YouTube video player',
    allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true,
    referrerpolicy: 'strict-origin-when-cross-origin',
  });
  const player = el('div', { class: 'tube-player' }, frame);
  const title = el('h2', { class: 'tube-title' });
  const meta = el('p', { class: 'tube-meta' });
  const open = el('a', { class: 'tube-resume', href: `https://www.youtube.com/watch?v=${id}`, target: '_blank', rel: 'noopener noreferrer', text: 'Open in YouTube' });
  const desc = el('p', { class: 'tube-desc' });
  desc.hidden = true;
  const more = el('button', { class: 'tube-more', type: 'button', text: 'Show more' });
  more.hidden = true;
  const upTitle = section('More from this channel');
  upTitle.hidden = true;
  const upList = el('div', { class: 'tube-upnext' });
  app.root.replaceChildren(
    bar,
    el('div', { class: 'app-content tube-watch' },
      player,
      el('div', { class: 'tube-info' }, title, meta, open, desc, more),
      el('div', { class: 'tube-aside' }, upTitle, upList)),
  );

  const view = { kind: 'youtube', id, bar, frame, player, title, meta, open, desc, more, upTitle, upList };
  app.view = view;
  holdReload(HOLD_WATCHING);
  syncFullBleed();
  more.addEventListener('click', () => {
    const clamped = desc.classList.toggle('clamped');
    more.textContent = clamped ? 'Show more' : 'Show less';
  });

  let item = Array.isArray(app.videos) ? app.videos.find((v) => v.id === id) || null : null;
  if (item) fillYouTube(view, item);
  try {
    const data = await api(`/api/jaketube/feed/${id}`);
    if (!app || app.view !== view) return;
    if (data && data.video) {
      item = data.video;
      fillYouTube(view, item);
    }
  } catch {
    if (!app || app.view !== view) return;
    if (!item) title.textContent = 'YouTube video'; // not in the feed (any more): the player still works
  }
  if (item) loadMore(view, item);
}

function fillYouTube(view, item) {
  view.bar.setTitle(item.channel_name || 'JakeTube');
  view.title.textContent = item.title;
  view.meta.textContent = [item.channel_name, Number.isFinite(item.views) ? `${compact.format(item.views)} views` : '', fmt.date(item.published, { year: true })]
    .filter(Boolean).join(' · ');
  view.player.classList.toggle('portrait', Boolean(item.short));
  if (item.url) view.open.href = item.url;
  const text = String(item.description || '').trim();
  view.desc.textContent = text;
  view.desc.hidden = !text;
  const long = text.length > DESC_CLAMP_CHARS || text.split('\n').length > DESC_CLAMP_LINES;
  view.desc.classList.toggle('clamped', long);
  view.more.hidden = !long;
  view.more.textContent = 'Show more';
}

async function loadMore(view, item) {
  let videos = Array.isArray(app.videos) && (app.videosKey === '' || app.videosKey === item.channel) ? app.videos : null;
  if (!videos) {
    try {
      const data = await api(`/api/jaketube/feed?channel=${encodeURIComponent(item.channel)}`);
      if (!app || app.view !== view) return;
      videos = data && Array.isArray(data.videos) ? data.videos : [];
    } catch {
      return;
    }
  }
  const next = videos.filter((v) => v.channel === item.channel && v.id !== item.id).slice(0, MORE_MAX);
  if (!next.length) return;
  view.upTitle.hidden = false;
  view.upList.replaceChildren(...next.map(moreRow));
}

function moreRow(video) {
  const row = el('button', { class: 'tube-up', type: 'button', 'aria-label': video.title },
    feedThumb(video),
    el('div', { class: 'tube-up-text' },
      el('div', { class: 'tube-up-title', text: video.title }),
      el('div', { class: 'tube-up-sub', text: subtitleOf(video) })));
  row.addEventListener('click', () => {
    haptic('light');
    nav.go(`#/jaketube/v/${video.id}`);
  });
  return row;
}

// ---------------------------------------------------------------- watch (a file on the PC)

// "2026-10-15.mp4" -> "Oct 15, 2026", "2026-10-15_19-07-48.mp4" -> "Oct 15, 2026 · 7:07 PM",
// anything else -> the stem.
function parseDateName(name) {
  const stem = String(name == null ? '' : name).replace(/\.[^.]+$/, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[_T ](\d{2})-(\d{2})-(\d{2}))?$/.exec(stem);
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  const valid = !Number.isNaN(d.getTime())
    && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
    && (!hasTime || (Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60));
  return valid ? { date: d, hasTime } : null;
}

function titleOf(video) {
  const name = String(video.name || '');
  const parsed = parseDateName(name);
  if (parsed) {
    const date = fmt.date(parsed.date, { year: true });
    return parsed.hasTime ? `${date} · ${fmt.time(parsed.date)}` : date;
  }
  const stem = name.replace(/\.[^.]+$/, '');
  return stem || video.title || 'Video';
}

function metaOf(video) {
  const parts = [video.channel_name || video.channel || ''];
  if (!parseDateName(video.name)) parts.push(fmt.date(video.mtime, { year: true }));
  parts.push(fmt.bytes(video.size));
  if (video.width && video.height) parts.push(`${video.width}×${video.height}`);
  return parts.filter(Boolean).join(' · ');
}

async function showFile(id) {
  const current = app.view;
  if (current && current.kind === 'file' && current.id === id) return;
  if (current && current.kind === 'home') app.homeScroll = scroller().scrollTop;
  teardownView();
  scroller().scrollTop = 0;

  const bar = navbar({ title: 'JakeTube', back: true });
  const video = el('video', {
    class: 'tube-video', controls: true, playsinline: true, 'webkit-playsinline': true, autoplay: true, preload: 'metadata',
  });
  const title = el('h2', { class: 'tube-title' });
  const meta = el('p', { class: 'tube-meta' });
  const resume = el('button', { class: 'tube-resume', type: 'button' });
  resume.hidden = true;
  const notice = el('p', { class: 'tube-notice' });
  notice.hidden = true;
  const player = el('div', { class: 'tube-player' }, video);
  app.root.replaceChildren(
    bar,
    el('div', { class: 'app-content tube-watch' },
      player,
      el('div', { class: 'tube-info' }, title, meta, resume, notice)),
  );

  const view = { kind: 'file', id, bar, video, player, title, meta, resume, notice, item: null, gone: false, pendingSeek: null, saveTimer: 0, lastSaved: null, off: [] };
  app.view = view;
  syncFullBleed();
  wireVideo(view);

  // The row first (one quick call): it carries the poster and the saved position, and a
  // bad id becomes a plain "gone" page instead of a failed stream.
  try {
    const data = await api(`/api/jaketube/videos/${id}`);
    if (!app || app.view !== view) return;
    view.item = data && data.video ? data.video : null;
  } catch (err) {
    if (!app || app.view !== view) return;
    view.gone = Boolean(err && err.status === 404);
    player.hidden = true; // nothing to play: no empty black box
    bar.setTitle(view.gone ? 'Gone' : 'JakeTube');
    title.textContent = view.gone ? 'This video is gone' : "Couldn't load this video";
    meta.textContent = view.gone
      ? 'It is no longer in any channel folder.'
      : (err && err.status ? err.message : 'The PC is unreachable.');
    return;
  }
  if (!view.item) return;
  fillFile(view);                               // poster + "Resume from" (the seek waits for loadedmetadata)
  video.src = `/api/jaketube/stream/${id}`;     // autoplay starts here
}

function wireVideo(view) {
  const { video } = view;
  const on = (type, fn) => {
    video.addEventListener(type, fn);
    view.off.push(() => video.removeEventListener(type, fn));
  };
  on('play', () => {
    holdReload(HOLD_PLAYING);
    startSaving(view);
  });
  on('pause', () => {
    releaseReload(HOLD_PLAYING);
    stopSaving(view);
    saveProgress(view);
  });
  on('ended', () => {
    releaseReload(HOLD_PLAYING);
    stopSaving(view);
    saveProgress(view, { ended: true });
  });
  on('loadedmetadata', () => {
    if (view.pendingSeek == null) return;
    const at = view.pendingSeek;
    view.pendingSeek = null;
    seekTo(view, at);
  });
  on('error', () => {
    if (view.gone) return;
    view.notice.textContent = "This file can't be played here.";
    view.notice.hidden = false;
  });
}

function fillFile(view) {
  const item = view.item;
  const { video } = view;
  const t = titleOf(item);
  view.bar.setTitle(t);
  view.title.textContent = t;
  view.meta.textContent = metaOf(item);
  if (item.thumb && !video.poster) video.poster = item.thumb;

  const p = item.progress;
  const duration = (p && p.duration) || item.duration || 0;
  const minStart = duration ? Math.min(RESUME_MIN_S, duration * 0.1) : RESUME_MIN_S;
  const tail = duration ? Math.min(RESUME_TAIL_S, duration * 0.05) : 0;
  if (p && p.seconds > minStart && (!duration || p.seconds < duration - tail)) {
    view.resume.textContent = `Resume from ${fmt.duration(p.seconds)}`;
    view.resume.hidden = false;
    view.resume.addEventListener('click', () => {
      haptic('light');
      seekTo(view, p.seconds);
      video.play().catch(() => {});
    });
    if (video.readyState >= 1) seekTo(view, p.seconds);
    else view.pendingSeek = p.seconds;
  }
}

function seekTo(view, seconds) {
  try {
    view.video.currentTime = Math.max(0, Number(seconds) || 0);
  } catch {
    /* not seekable yet */
  }
}

function startSaving(view) {
  clearInterval(view.saveTimer);
  view.saveTimer = setInterval(() => saveProgress(view), SAVE_EVERY_MS);
}

function stopSaving(view) {
  clearInterval(view.saveTimer);
  view.saveTimer = 0;
}

// PUT the position (deduped: the same tenth of a second is not sent twice).
function saveProgress(view, { ended = false } = {}) {
  if (!app || view.gone) return;
  const { video } = view;
  const duration = Number(video.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const seconds = ended ? duration : Number(video.currentTime);
  if (!Number.isFinite(seconds) || (seconds < 1 && !ended)) return;
  const rounded = Math.round(seconds * 10) / 10;
  if (view.lastSaved === rounded) return;
  view.lastSaved = rounded;
  const progress = { seconds: rounded, duration: Math.round(duration * 1000) / 1000, updated_at: new Date().toISOString() };
  if (view.item) view.item.progress = progress;
  api(`/api/jaketube/progress/${view.id}`, { method: 'PUT', body: { seconds: rounded, duration: progress.duration } }).catch(() => {});
}
