import { db, kv, persist, storageInfo, isQuotaError } from './lib/store.js';
import * as meta from './lib/meta.js';
import * as cloud from './lib/cloud.js';
import { Engine, IS_IOS } from './lib/engine.js';
import { Index, fold } from './lib/search.js';
import { thumbnail, artColors } from './lib/image.js';

/* =====================================================================
   State
   ===================================================================== */
const S = {
  tracks: new Map(), playlists: new Map(), art: new Map(), thumbs: new Map(), plCovers: new Map(),
  history: [], log: [], ctxs: [], searches: [], dupIgnore: [],
  lists: {}, vlists: {}, route: 'home', param: '', settings: {}, version: null, user: null,
  scroll: {}, freshNav: false, index: new Index(), indexDirty: true, lastSync: 0, ver: 0,
};
const P = {
  queue: [], idx: -1, shuffle: false, repeat: 'off', context: '', contextRoute: '', mode: null, seed: null,
  autoAdded: new Set(), played: [], objUrls: new Map(), counted: false, panel: 'lyrics',
  lyrics: null, lyricLine: -1, follow: true, sleepAt: 0, sleepEnd: false, speed: 1,
  listen: null, preloadFor: null, fadeStarted: false,
};
const DEFAULTS = {
  autoplay: true, accent: 'coral', autoFix: true, volume: 1, theme: 'dark', density: 'comfortable', reduceMotion: false,
  crossfade: 0, gapless: true, leveling: true, hideExplicit: false, keepHistory: true, songSort: 'added', songDir: -1,
};
const ACCENTS = { coral: ['#ff6a4d', '255,106,77', '#1a0703'], amber: ['#f5b041', '245,176,65', '#1d1302'], sky: ['#5ab4ff', '90,180,255', '#03121f'], mint: ['#4fd1a1', '79,209,161', '#02180f'], lilac: ['#b69cff', '182,156,255', '#120a24'], rose: ['#ff5c8a', '255,92,138', '#22040f'] };
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1c1c1f"/><path d="M42 66a7 7 0 1 1-4-6.3V36l22-4.5v28.8a7 7 0 1 1-4-6.3V40.6l-14 2.9z" fill="#3a3a3f"/></svg>');
const DAY = 86400000;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const engine = new Engine($('#audio'), $('#audio-b'));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const mainArtist = a => (a || '').split(/ feat\. | ft\. | featuring | & |, | x | with /i)[0].trim();
const albumArtist = t => t.albumArtist && !/various/i.test(t.albumArtist) ? t.albumArtist : mainArtist(t.artist);
const shuffleArr = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const count = n => `${n} song${n === 1 ? '' : 's'}`;
const total = ts => { const s = ts.reduce((a, t) => a + (t.duration || 0), 0); const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`; };
const ago = ms => { if (!ms) return '—'; const d = (Date.now() - ms) / DAY; if (d < 1) return 'Today'; if (d < 2) return 'Yesterday'; if (d < 7) return `${Math.floor(d)} days ago`; return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined }); };
const hours = s => { const h = s / 3600; return h >= 1 ? `${h.toFixed(h >= 10 ? 0 : 1)} hr` : `${Math.round(s / 60)} min`; };
const bytes = n => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(0) + ' MB';

/** Every song the app should show (respects “Hide explicit songs”). */
const visible = () => [...S.tracks.values()].filter(t => !(S.settings.hideExplicit && t.explicit));
const byAdded = (a, b) => (b.addedAt || 0) - (a.addedAt || 0);

let toastT;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? ` <button class="toast-act">${esc(action[0])}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); action[1](); };
  t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2600);
}

/* =====================================================================
   Artwork
   ===================================================================== */
function artOf(t, size = 'thumb') {
  if (!t) return PLACEHOLDER;
  if (size === 'thumb' && S.thumbs.has(t.id)) return S.thumbs.get(t.id);
  if (S.art.has(t.id)) return S.art.get(t.id);
  if (t.cloud) { const u = cloud.cachedUrl('art/' + t.id); if (u) return u; }
  return PLACEHOLDER;
}
function swapUrl(map, id, blob) { const old = map.get(id); if (old?.startsWith('blob:')) URL.revokeObjectURL(old); map.set(id, URL.createObjectURL(blob)); }
/** Saves full artwork plus a small thumbnail, and remembers the artwork's colors on the song. */
async function setArt(t, blob) {
  await db.put('art', t.id, blob); swapUrl(S.art, t.id, blob);
  const th = await thumbnail(blob);
  if (th) { await db.put('thumbs', t.id, th); swapUrl(S.thumbs, t.id, th); }
  t.colors = await artColors(th || blob);
}
/** Older songs get thumbnails and colors in the background, a few at a time, without blocking anything. */
function backfillArt() {
  const todo = [...S.tracks.values()].filter(t => S.art.has(t.id) && (!S.thumbs.has(t.id) || !t.colors));
  if (!todo.length) return;
  const step = async () => {
    const t = todo.shift(); if (!t) { render(); return; }
    const blob = await db.get('art', t.id);
    if (blob) { if (!S.thumbs.has(t.id)) { const th = await thumbnail(blob); if (th) { await db.put('thumbs', t.id, th); swapUrl(S.thumbs, t.id, th); } } if (!t.colors) t.colors = await artColors(S.thumbs.get(t.id) || blob); await db.put('tracks', t.id, t); }
    (window.requestIdleCallback || setTimeout)(step);
  };
  step();
}
function colorsOf(ts) { for (const t of ts) if (t?.colors) return t.colors; return null; }
function ambient(colors) { return colors ? `--amb-base:${colors.base};--amb-glow:${colors.glow};--amb-accent:${colors.accent}` : ''; }

/* =====================================================================
   Persistence
   ===================================================================== */
async function saveTrack(t, { sync = true } = {}) {
  S.tracks.set(t.id, t); S.indexDirty = true; S.ver++;
  try { await db.put('tracks', t.id, t); } catch (e) { if (isQuotaError(e)) quotaWarning(); throw e; }
  if (sync && S.user && t.cloud) cloud.saveTrack(t).catch(e => syncFailed(e));
}
async function savePlaylist(p) {
  p.updatedAt = Date.now();
  S.playlists.set(p.id, p); S.indexDirty = true;
  await db.put('playlists', p.id, p);
  if (S.user) cloud.savePlaylist(p).catch(e => syncFailed(e));
  renderSidebar();
}
async function saveSettings() { await kv.set('settings', S.settings); applySettings(); queueStatePush(); }
function applySettings() {
  const [hex, rgb, ink] = ACCENTS[S.settings.accent] || ACCENTS.coral;
  const r = document.documentElement;
  r.style.setProperty('--accent', hex); r.style.setProperty('--tint', rgb); r.style.setProperty('--accent-ink', ink);
  r.dataset.theme = S.settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : S.settings.theme;
  r.dataset.density = S.settings.density;
  r.dataset.motion = S.settings.reduceMotion ? 'reduce' : 'full';
  document.querySelector('meta[name=theme-color]').content = r.dataset.theme === 'light' ? '#f6f5f3' : '#09090a';
}
let quotaShown = 0;
function quotaWarning() { if (Date.now() - quotaShown < 10000) return; quotaShown = Date.now(); toast('This device is out of space for Cadence. Remove some songs or free up storage.'); }
let syncWarned = 0;
function syncFailed(e) { console.warn('sync', e); if (Date.now() - syncWarned > 60000) { syncWarned = Date.now(); toast(navigator.onLine ? 'Couldn’t sync just now. Changes are saved here and will sync later.' : 'You’re offline. Changes are saved on this device.'); } }

/* listening state that follows you between devices */
let pushT;
function queueStatePush() {
  if (!S.user) return;
  clearTimeout(pushT);
  pushT = setTimeout(() => {
    const { volume, ...settings } = S.settings;
    cloud.pushState({ history: S.history.slice(0, 200), log: S.log.slice(-3000), ctxs: S.ctxs, searches: S.searches, settings, settingsAt: S.settingsAt || 0, dupIgnore: S.dupIgnore }).then(() => { S.lastSync = Date.now(); }).catch(e => syncFailed(e));
  }, 4000);
}

/* =====================================================================
   Boot
   ===================================================================== */
async function boot() {
  persist();
  S.settings = { ...DEFAULTS, ...(await kv.get('settings', {})) };
  applySettings();
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applySettings);
  const [tracks, pls, arts, thumbs] = await Promise.all([db.all('tracks'), db.all('playlists'), db.all('art'), db.all('thumbs')]);
  for (const [id, t] of tracks) S.tracks.set(id, t);
  for (const [id, p] of pls) S.playlists.set(id, p);
  for (const [id, b] of arts) (id.startsWith('pl:') ? S.plCovers : S.art).set(id.replace(/^pl:/, ''), URL.createObjectURL(b));
  for (const [id, b] of thumbs) S.thumbs.set(id, URL.createObjectURL(b));
  [S.history, S.log, S.ctxs, S.searches, S.dupIgnore, S.settingsAt] = await Promise.all([kv.get('history', []), kv.get('log', []), kv.get('ctxs', []), kv.get('searches', []), kv.get('dupIgnore', []), kv.get('settingsAt', 0)]);
  engine.setVolume(S.settings.volume ?? 1);
  $('#p-vol').value = Math.round((S.settings.volume ?? 1) * 100); paintRange($('#p-vol'));
  const saved = await kv.get('player', null);
  if (saved?.queue?.length) {
    P.queue = saved.queue.filter(id => S.tracks.has(id));
    P.idx = Math.min(Math.max(saved.idx, 0), P.queue.length - 1);
    Object.assign(P, { shuffle: !!saved.shuffle, repeat: saved.repeat || 'off', context: saved.context || '', contextRoute: saved.contextRoute || '', mode: saved.mode || null, seed: saved.seed || null });
    P.played = (saved.played || []).filter(id => S.tracks.has(id));
    if (P.idx >= 0 && P.queue.length) { const ok = await loadTrack(P.queue[P.idx], { autoplay: false, quiet: true }); if (ok && saved.time) seekWhenReady(saved.time); }
  }
  renderSidebar();
  window.addEventListener('hashchange', route);
  route();
  updateModes();
  backfillArt();
  repairMatches();
  initCloud();
  checkVersion();
  setInterval(checkVersion, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkVersion(); if (S.user && Date.now() - S.lastSync > 60000) syncDown(); } else { flushListen(); savePlayer(true); } });
  window.addEventListener('online', () => { if (S.user) syncDown(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
function seekWhenReady(t) { const el = engine.el; const go_ = () => { try { el.currentTime = t; } catch {} onTime(); }; el.readyState >= 1 ? go_() : el.addEventListener('loadedmetadata', go_, { once: true }); }

async function initCloud() {
  if (!cloud.cloudConfigured()) return;
  try {
    S.user = await cloud.user();
    if (S.user) syncDown();
    const c = await cloud.sb();
    c.auth.onAuthStateChange((_e, session) => {
      const was = S.user?.id; S.user = session?.user || null;
      if (S.user && S.user.id !== was) syncDown();
      if (S.route === 'settings') render();
    });
  } catch (e) { console.warn('cloud', e); }
}

async function syncDown() {
  if (!S.user) return;
  try {
    const rows = await cloud.pullTracks();
    if (rows) {
      let changed = false;
      for (const r of rows) {
        const local = S.tracks.get(r.id);
        if (r.deleted) { if (local) { await removeLocal(r.id); changed = true; } continue; }
        const merged = { ...r.data, local: !!local?.local, cloud: true, plays: Math.max(local?.plays || 0, r.data.plays || 0), lastPlayed: Math.max(local?.lastPlayed || 0, r.data.lastPlayed || 0) };
        if (!local || JSON.stringify(local) !== JSON.stringify(merged)) { S.tracks.set(r.id, merged); await db.put('tracks', r.id, merged); changed = true; }
      }
      const needArt = rows.filter(r => !r.deleted && !S.art.has(r.id)).map(r => r.id);
      if (needArt.length) { await cloud.fileUrls(needArt.map(id => 'art/' + id)); changed = true; cacheCloudArt(needArt); }
      if (changed) { S.indexDirty = true; render(); }
    }
    const pls = await cloud.pullPlaylists();
    if (pls) {
      for (const r of pls) {
        if (r.deleted) { S.playlists.delete(r.id); await db.del('playlists', r.id); continue; }
        const local = S.playlists.get(r.id);
        if (!local || (r.data.updatedAt || 0) > (local.updatedAt || 0)) { S.playlists.set(r.id, r.data); await db.put('playlists', r.id, r.data); }
        if (r.data.cover && !S.plCovers.has(r.id)) cachePlaylistCover(r.id);
      }
      renderSidebar();
    }
    const st = await cloud.pullState();
    if (st?.data) mergeState(st.data);
    S.lastSync = Date.now();
    queueStatePush();
  } catch (e) { syncFailed(e); }
}
function mergeState(d) {
  const seen = new Set(S.log.map(e => e.id + e.at));
  S.log = [...S.log, ...(d.log || []).filter(e => !seen.has(e.id + e.at))].sort((a, b) => a.at - b.at).slice(-5000);
  S.history = [...new Set([...S.history, ...(d.history || [])])].slice(0, 200);
  if (d.ctxs) S.ctxs = [...S.ctxs, ...d.ctxs.filter(c => !S.ctxs.some(x => x.route === c.route))].sort((a, b) => b.at - a.at).slice(0, 16);
  if (d.searches && !S.searches.length) S.searches = d.searches;
  if (d.dupIgnore) S.dupIgnore = [...new Set([...S.dupIgnore, ...d.dupIgnore])];
  if (d.settings && (d.settingsAt || 0) > (S.settingsAt || 0)) { S.settings = { ...S.settings, ...d.settings }; S.settingsAt = d.settingsAt; kv.set('settings', S.settings); kv.set('settingsAt', S.settingsAt); applySettings(); }
  kv.set('log', S.log); kv.set('history', S.history); kv.set('ctxs', S.ctxs); kv.set('dupIgnore', S.dupIgnore);
}
async function cacheCloudArt(ids) {
  for (const id of ids) {
    const u = cloud.cachedUrl('art/' + id); const t = S.tracks.get(id); if (!u || !t) continue;
    try { const b = await (await fetch(u)).blob(); if (b.size) { await setArt(t, b); await db.put('tracks', t.id, t); } } catch {}
  }
  render();
}
async function cachePlaylistCover(id) {
  try { await cloud.fileUrls(['art/pl-' + id]); const u = cloud.cachedUrl('art/pl-' + id); if (!u) return; const b = await (await fetch(u)).blob(); if (b.size) { await db.put('art', 'pl:' + id, b); swapUrl(S.plCovers, id, b); render(); } } catch {}
}

/* =====================================================================
   Updates
   ===================================================================== */
async function checkVersion() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = await r.json();
    if (!S.version) S.version = version;
    else if (version !== S.version) $('#update-bar').classList.add('show');
  } catch {}
}
async function applyUpdate() {
  flushListen(); await savePlayer(true);
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  location.reload();
}

/* =====================================================================
   Routing (keeps scroll position when you go back)
   ===================================================================== */
function go(r) { S.freshNav = true; location.hash = '#/' + r; }
$('#main').addEventListener('scroll', () => { S.scroll[location.hash] = $('#main').scrollTop; mountVisible(); }, { passive: true });
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')) || 'home';
  const i = h.indexOf('/');
  S.route = i < 0 ? h : h.slice(0, i);
  S.param = i < 0 ? '' : h.slice(i + 1);
  const libRoutes = ['songs', 'artists', 'albums', 'liked', 'playlist', 'artist', 'album', 'library', 'smart', 'insights', 'duplicates', 'history'];
  $$('[data-route]').forEach(a => {
    const r = a.dataset.route;
    a.classList.toggle('active', r === S.route || (r === 'library' && libRoutes.includes(S.route)));
  });
  $$('#sidebar-playlists .nav-link').forEach(a => a.classList.toggle('active', (S.route === 'playlist' || S.route === 'smart') && a.dataset.pl === S.param));
  render();
  const y = S.freshNav ? 0 : (S.scroll[location.hash] || 0);
  S.freshNav = false;
  $('#main').scrollTop = y;
  mountVisible();
}
const VIEWS = {};
function render() {
  S.lists = {}; S.vlists = {};
  if (S.indexDirty) rebuildIndex();
  const v = VIEWS[S.route] || VIEWS.home;
  const view = $('#view');
  const y = $('#main').scrollTop;
  view.innerHTML = v();
  if (!S.freshNav) $('#main').scrollTop = y;
  afterRender();
}
function afterRender() {
  if (S.route === 'search') { const i = $('#search-input'); if (i && document.activeElement !== i && !('ontouchstart' in window)) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  if (S.route === 'import') bindImport();
  $$('[data-sortable]').forEach(el => makeSortable(el, el.dataset.sortable));
  mountVisible();
  markPlaying();
}

/* =====================================================================
   Building blocks
   ===================================================================== */
const COLW = { album: 'minmax(0,1fr)', added: '110px', plays: '64px', last: '110px' };
const COLNAME = { album: 'Album', added: 'Added', plays: 'Plays', last: 'Last played' };
function listKey(ids, context) { const k = 'l' + Object.keys(S.lists).length; S.lists[k] = ids; ids.context = context; return k; }
function gridFor(opts) { return `${opts.sortable ? '28px ' : ''}32px 44px minmax(0,1.4fr) ${opts.cols.map(c => COLW[c]).join(' ')} 36px 56px 36px`; }
function rowHtml(t, i, key, opts) {
  return `<div class="track${opts.sortable ? " has-handle" : ""}" data-id="${t.id}" data-list="${key}" data-i="${i}" style="grid-template-columns:${gridFor(opts)}">
    ${opts.sortable ? '<div class="handle" title="Drag to reorder"><svg><use href="#i-grip"/></svg></div>' : ''}
    <div class="num"><span class="n">${i + 1}</span><span class="eq"><i></i><i></i><i></i></span><svg class="hover-icon"><use href="#i-play"/></svg></div>
    <div class="th"><img loading="lazy" decoding="async" src="${artOf(t)}" alt=""></div>
    <div class="tmain"><div class="tt ellipsis">${esc(t.title)}${t.explicit ? '<span class="explicit">E</span>' : ''}</div><div class="ta ellipsis"><a href="#/artist/${encodeURIComponent(mainArtist(t.artist))}">${esc(t.artist)}</a></div></div>
    ${opts.cols.map(c => c === 'album' ? `<div class="tc ellipsis">${t.album ? `<a href="#/album/${encodeURIComponent(t.album + '\u0001' + albumArtist(t))}">${esc(t.album)}</a>` : `<span class="dim">${esc(t.category === 'Music' ? '' : t.category)}</span>`}</div>`
      : c === 'added' ? `<div class="tc">${ago(t.addedAt)}</div>` : c === 'plays' ? `<div class="tc num-r">${t.plays || 0}</div>` : `<div class="tc">${ago(t.lastPlayed)}</div>`).join('')}
    <button class="icon-btn like-btn ${t.liked ? 'on' : ''}" data-action="like" data-id="${t.id}" aria-label="Like"><svg><use href="#i-heart"/></svg></button>
    <div class="td">${fmt(t.duration)}</div>
    <button class="icon-btn more" data-action="track-menu" data-id="${t.id}" aria-label="More"><svg><use href="#i-more"/></svg></button>
  </div>`;
}
/** A song list. Long lists only draw the rows on screen, so thousands of songs scroll smoothly. */
function trackRows(tracks, opts = {}) {
  opts = { cols: ['album'], context: '', header: true, ...opts };
  const ids = tracks.map(t => t.id);
  const key = opts.key || listKey(ids, opts.context);
  if (opts.key) { S.lists[key] = ids; ids.context = opts.context; }
  const head = opts.header ? `<div class="tracks-head" style="grid-template-columns:${gridFor(opts)}">${opts.sortable ? '<div></div>' : ''}<div class="c">#</div><div></div>${hcell('title', 'Title', opts)}${opts.cols.map(c => hcell(c, COLNAME[c], opts)).join('')}<div></div>${hcell('time', '<svg><use href="#i-clock"/></svg>', opts, true)}<div></div></div>` : '';
  if (tracks.length > 120 && !opts.sortable) {
    S.vlists[key] = { tracks, opts };
    return `${head}<div class="vlist" data-vl="${key}" style="height:calc(${tracks.length} * var(--row-h))"><div class="vl-inner"></div></div>`;
  }
  return `${head}<div class="tracks" ${opts.sortable ? `data-sortable="${opts.sortable}"` : ''}>${tracks.map((t, i) => rowHtml(t, i, key, opts)).join('')}</div>`;
}
function hcell(k, label, opts, right) {
  if (!opts.sortKey) return `<div class="${right ? 'r' : ''}">${label}</div>`;
  const on = opts.sortKey === k;
  return `<button class="hsort ${on ? 'on' : ''} ${right ? 'r' : ''}" data-action="sort-col" data-sort="${k}" data-scope="${opts.sortScope || 'songs'}">${label}${on ? `<svg class="${opts.sortDir > 0 ? 'up' : ''}"><use href="#i-down"/></svg>` : ''}</button>`;
}
let rowH = 0;
function mountVisible() {
  const main = $('#main'); if (!Object.keys(S.vlists).length) return;
  rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 56;
  const mr = main.getBoundingClientRect();
  for (const el of $$('.vlist')) {
    const v = S.vlists[el.dataset.vl]; if (!v) continue;
    const top = el.getBoundingClientRect().top - mr.top;
    const start = Math.max(0, Math.floor(-top / rowH) - 10), end = Math.min(v.tracks.length, Math.ceil((mr.height - top) / rowH) + 10);
    if (el._r === `${start}-${end}`) continue;
    el._r = `${start}-${end}`;
    const inner = el.firstElementChild;
    inner.style.transform = `translateY(${start * rowH}px)`;
    inner.innerHTML = v.tracks.slice(start, end).map((t, k) => rowHtml(t, start + k, el.dataset.vl, v.opts)).join('');
  }
  markPlaying();
}
window.addEventListener('resize', () => { $$('.vlist').forEach(el => { el._r = ''; }); mountVisible(); }, { passive: true });

function trackCard(t, key, i) {
  return `<div class="card" data-play-list="${key}" data-i="${i}" title="${esc(t.title)} · ${esc(t.artist)}">
    <div class="cover"><img loading="lazy" decoding="async" src="${artOf(t)}" alt=""><span class="hover-play"><svg><use href="#i-play"/></svg></span></div>
    <div class="t ellipsis">${esc(t.title)}</div><div class="s ellipsis">${esc(t.artist)}</div></div>`;
}
function collageHtml(tracks, custom) {
  if (custom) return `<img loading="lazy" src="${custom}" alt="">`;
  const arts = [...new Set(tracks.map(t => artOf(t)).filter(a => a !== PLACEHOLDER))];
  if (arts.length >= 4) return `<div class="collage">${arts.slice(0, 4).map(a => `<img loading="lazy" decoding="async" src="${a}" alt="">`).join('')}</div>`;
  return `<img loading="lazy" decoding="async" src="${arts[0] || PLACEHOLDER}" alt="">`;
}
function collCard({ href, title, sub, tracks, round = false, img, badge }) {
  const key = listKey(tracks.map(t => t.id), title);
  return `<div class="card ${round ? 'round' : ''}" data-href="${esc(href)}">
    <div class="cover">${img ? `<img loading="lazy" decoding="async" src="${img}" alt="">` : collageHtml(tracks)}${badge ? `<span class="badge-cover">${badge}</span>` : ''}${tracks.length ? `<button class="hover-play" data-play-list="${key}" data-i="0" data-ctx-route="${esc(href)}" aria-label="Play"><svg><use href="#i-play"/></svg></button>` : ''}</div>
    <div class="t ellipsis">${esc(title)}</div><div class="s ellipsis">${esc(sub || '')}</div></div>`;
}
function tile({ href, title, tracks, img }) {
  const key = listKey(tracks.map(t => t.id), title);
  return `<div class="tile" data-href="${esc(href)}"><div class="tile-art">${img ? `<img loading="lazy" src="${img}" alt="">` : collageHtml(tracks)}</div><div class="tile-t ellipsis">${esc(title)}</div>
    <button class="tile-play" data-play-list="${key}" data-i="0" data-ctx-route="${esc(href)}" aria-label="Play ${esc(title)}"><svg><use href="#i-play"/></svg></button></div>`;
}
function shelf(title, inner, { more, sub } = {}) {
  if (!inner) return '';
  return `<section class="section"><div class="section-head"><div><h2>${esc(title)}</h2>${sub ? `<div class="section-sub">${esc(sub)}</div>` : ''}</div>${more ? `<a href="#/${more}" class="see-all">See all</a>` : ''}</div><div class="shelf">${inner}</div></section>`;
}
function emptyLib() {
  return `<div class="empty-state"><div class="empty-mark"><svg><use href="#i-note"/></svg></div>
    <h2>Your library is empty</h2><p>Bring in the music from your computer. Messy names get cleaned up and album artwork is found automatically.</p>
    <a class="btn primary" href="#/import"><svg><use href="#i-upload"/></svg>Add music</a></div>`;
}
function collHead({ img, tracks, eyebrow, title, meta: m, round, actions = '', ctxRoute, custom }) {
  const key = listKey(tracks.map(t => t.id), title);
  const colors = colorsOf(tracks);
  return `<header class="coll-head" style="${ambient(colors)}">
    <div class="coll-art ${round ? 'round' : ''}">${img ? `<img src="${img}" alt="">` : collageHtml(tracks, custom)}</div>
    <div class="coll-info"><div class="eyebrow">${esc(eyebrow)}</div><h1 class="${title.length > 28 ? 'long' : ''}">${esc(title)}</h1><div class="meta">${m}</div>
    <div class="row-actions">${tracks.length ? `<button class="btn primary" data-play-list="${key}" data-i="0" data-ctx-route="${esc(ctxRoute || '')}"><svg><use href="#i-play"/></svg>Play</button>
    <button class="btn" data-play-list="${key}" data-shuffle="1" data-ctx-route="${esc(ctxRoute || '')}"><svg><use href="#i-shuffle"/></svg>Shuffle</button>` : ''}${actions}</div></div></header>`;
}
const back = () => `<button class="icon-btn back-btn" data-action="back" aria-label="Back"><svg><use href="#i-back"/></svg></button>`;

/* =====================================================================
   Library intelligence: groups, smart playlists, moods, similarity
   ===================================================================== */
let gCache = { key: '', map: {} };
function groups(kind) {
  const key = S.tracks.size + ':' + S.ver + ':' + S.settings.hideExplicit;
  if (gCache.key !== key) gCache = { key, map: {} };
  if (gCache.map[kind]) return gCache.map[kind];
  const m = new Map();
  for (const t of visible()) {
    let k;
    if (kind === 'artist') k = mainArtist(t.artist);
    else if (kind === 'album') { if (!t.album) continue; k = `${t.album}\u0001${albumArtist(t)}`; }
    else if (kind === 'mix') k = t.category === 'Music' ? (t.genre || 'Music') : t.category;
    else if (kind === 'genre') { if (!t.genre) continue; k = t.genre; }
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return (gCache.map[kind] = m);
}
function playCounts(filter) { const c = new Map(); for (const e of S.log) if (!filter || filter(e)) c.set(e.id, (c.get(e.id) || 0) + 1); return c; }
const isNight = e => { const h = new Date(e.at).getHours(); return h >= 22 || h < 4; };
const SMART = {
  'most-played': { title: 'Most Played', desc: 'The songs you play the most', get: ts => ts.filter(t => t.plays > 0).sort((a, b) => b.plays - a.plays || (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 50) },
  'recently-played': { title: 'Recently Played', desc: 'What you’ve listened to lately', get: () => S.history.map(id => S.tracks.get(id)).filter(t => t && visible().includes(t)).slice(0, 50) },
  'recently-added': { title: 'Recently Added', desc: 'Added in the last 30 days', get: ts => ts.filter(t => Date.now() - (t.addedAt || 0) < 30 * DAY).sort(byAdded) },
  'recently-loved': { title: 'Recently Loved', desc: 'Songs you liked in the last month', get: ts => ts.filter(t => t.liked && Date.now() - (t.likedAt || 0) < 30 * DAY).sort((a, b) => b.likedAt - a.likedAt) },
  'rediscover': { title: 'Rediscover', desc: 'Songs you loved but haven’t played in over a month', get: ts => ts.filter(t => (t.plays >= 2 || t.liked) && t.lastPlayed && Date.now() - t.lastPlayed > 30 * DAY).sort((a, b) => (b.plays || 0) - (a.plays || 0)) },
  'forgotten-favorites': { title: 'Forgotten Favorites', desc: 'Liked songs you haven’t played in 45 days', get: ts => ts.filter(t => t.liked && t.lastPlayed && Date.now() - t.lastPlayed > 45 * DAY) },
  'late-night': { title: 'Late Night', desc: 'What you play between 10 pm and 4 am', get: ts => { const c = playCounts(isNight); return ts.filter(t => c.get(t.id)).sort((a, b) => c.get(b.id) - c.get(a.id)); } },
  'never-played': { title: 'Never Played', desc: 'In your library but not played yet', get: ts => ts.filter(t => !t.plays).sort(byAdded) },
};
const smartList = k => SMART[k] ? SMART[k].get(visible()) : [];
const MOODS = {
  chill: { title: 'Chill', test: t => /r&b|soul|jazz|ambient|lo-?fi|acoustic|chill|reggae/i.test(t.genre || '') },
  focus: { title: 'Focus', test: t => /classical|instrumental|ambient|piano|soundtrack|lo-?fi|new age/i.test(t.genre || '') },
  energy: { title: 'Energy', test: t => /hip-?hop|rap|dance|electronic|afro|reggaeton|edm|house|drill|trap/i.test(t.genre || '') },
  latenight: { title: 'Late Night', test: t => playCounts(isNight).has(t.id), note: 'From what you play after 10 pm' },
  rnb: { title: 'R&B', test: t => /r&b|soul/i.test(t.genre || '') },
  hiphop: { title: 'Hip-Hop', test: t => /hip-?hop|rap/i.test(t.genre || '') },
  afrobeats: { title: 'Afrobeats', test: t => /afro|african|highlife|amapiano|naija/i.test(`${t.genre || ''}`) },
  throwbacks: { title: 'Throwbacks', test: t => t.year && +t.year <= new Date().getFullYear() - 10, note: 'Released 10+ years ago' },
};
const moodList = k => MOODS[k] ? visible().filter(MOODS[k].test) : [];

/** Songs from your library that fit a seed: same artist, same kind of music, songs you like; avoids repeats. */
function similar(seeds, n = 15, exclude = new Set()) {
  seeds = (Array.isArray(seeds) ? seeds : [seeds]).filter(Boolean);
  if (!seeds.length) return [];
  const recent = new Set([...P.played.slice(-40), ...P.queue.slice(Math.max(0, P.idx - 40)), ...S.history.slice(0, 25), ...exclude]);
  const seedArtists = new Set(seeds.map(t => mainArtist(t.artist)));
  const seedGenres = new Set(seeds.map(t => t.genre).filter(Boolean));
  const seedCats = new Set(seeds.map(t => t.category));
  const related = relatedArtists([...seedArtists]);
  const seedIds = new Set(seeds.map(t => t.id));
  const scored = visible().filter(t => !seedIds.has(t.id)).map(t => {
    const a = mainArtist(t.artist);
    let s = Math.random() * 1.6;
    s += seedCats.has(t.category) ? 3 : -6;
    if (seedArtists.has(a)) s += 2.2;
    else if (related.has(a)) s += 1.6;
    if (t.genre && seedGenres.has(t.genre)) s += 2;
    if (t.liked) s += 1.2;
    s += Math.min(t.plays || 0, 12) * .08;
    if (recent.has(t.id)) s -= 4;
    return [s, t];
  }).sort((a, b) => b[0] - a[0]);
  // spread artists out so the same artist doesn't play back to back
  const out = []; let lastA = mainArtist(seeds[seeds.length - 1].artist);
  const pool = scored.map(x => x[1]);
  while (out.length < n && pool.length) {
    let k = pool.findIndex(t => mainArtist(t.artist) !== lastA);
    if (k < 0) k = 0;
    const t = pool.splice(k, 1)[0]; out.push(t.id); lastA = mainArtist(t.artist);
  }
  return out;
}
/** Artists connected to these ones by real data: shared genres and appearing together in your playlists. */
function relatedArtists(names) {
  const set = new Set(names), out = new Set();
  const genres = new Set(visible().filter(t => set.has(mainArtist(t.artist))).map(t => t.genre).filter(Boolean));
  for (const t of visible()) if (t.genre && genres.has(t.genre)) out.add(mainArtist(t.artist));
  for (const p of S.playlists.values()) {
    const as = p.tracks.map(id => S.tracks.get(id)).filter(Boolean).map(t => mainArtist(t.artist));
    if (as.some(a => set.has(a))) as.forEach(a => out.add(a));
  }
  names.forEach(n => out.delete(n)); out.delete('Unknown Artist');
  return out;
}
/** Cadence Flow: endless listening weighted by what you like and play. */
function flowPicks(n = 15) {
  const counts = playCounts(e => Date.now() - e.at < 90 * DAY);
  const recent = new Set([...P.played.slice(-60), ...P.queue.slice(Math.max(0, P.idx - 30), P.idx + 1)]);
  const pool = visible().filter(t => !recent.has(t.id)).map(t => [Math.random() * (1 + (t.liked ? 3 : 0) + Math.min(counts.get(t.id) || 0, 8) * .5 + (t.plays ? .5 : 1)), t]);
  pool.sort((a, b) => b[0] - a[0]);
  const out = []; let lastA = '';
  for (const [, t] of pool) { if (out.length >= n) break; if (mainArtist(t.artist) === lastA) continue; out.push(t.id); lastA = mainArtist(t.artist); }
  return out;
}

/* =====================================================================
   Views
   ===================================================================== */
function greeting() { const h = new Date().getHours(); return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function mixName(k) { return ['Quran & Recitation', 'Talks & Lectures', 'Nasheeds'].includes(k) ? k : `${k} Mix`; }
function hrefFor(ctx) { return ctx.route.replace(/^#\/?/, ''); }

VIEWS.home = () => {
  const all = visible();
  if (!all.length) return `<div class="page-head"><div><h1>${greeting()}</h1><div class="lede">Your soundtrack starts here.</div></div></div>${emptyLib()}`;
  const cur = current();
  const recent = SMART['recently-played'].get();
  const hero = cur || recent[0] || [...all].sort(byAdded)[0];
  const resumeAt = cur && engine.el.currentTime > 5 && engine.el.paused ? engine.el.currentTime : 0;
  const heroKey = listKey([hero.id], 'Home');
  const ctxTiles = S.ctxs.map(c => ctxTile(c)).filter(Boolean).slice(0, 6);
  const mixes = [...groups('mix')].sort((a, b) => b[1].length - a[1].length);
  const smartCards = Object.entries(SMART).map(([k, d]) => [k, d, d.get(all)]).filter(([k, , ts]) => ts.length >= 3 && k !== 'recently-played');
  const liked = all.filter(t => t.liked);
  const artistScore = new Map();
  for (const t of all) { const a = mainArtist(t.artist); if (a === 'Unknown Artist') continue; artistScore.set(a, (artistScore.get(a) || 0) + (t.plays || 0) + (t.liked ? 5 : 0) + .01); }
  const favArtists = [...artistScore].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const hasTaste = [...artistScore.values()].some(v => v >= 1);
  const added = [...all].sort(byAdded).slice(0, 16); const addedKey = listKey(added.map(t => t.id), 'Recently Added');
  const recentKey = listKey(recent.map(t => t.id), 'Recently Played');
  const discover = recent.length ? similar(recent.slice(0, 6), 12).map(id => S.tracks.get(id)).filter(t => (t.plays || 0) <= 1) : [];
  const discoverKey = listKey(discover.map(t => t.id), 'Discover');
  const moods = Object.entries(MOODS).map(([k, m]) => [k, m, moodList(k).length]).filter(x => x[2]);
  return `
  <div class="page-head home-head"><div><div class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>${greeting()}</h1><div class="lede">${cur ? 'Pick up right where you left off.' : 'Your soundtrack starts here.'}</div></div>
    <button class="btn flow-btn" data-action="flow"><svg><use href="#i-flow"/></svg>Cadence Flow</button></div>
  <section class="hero" style="${ambient(hero.colors)}">
    <div class="hero-art" data-play-list="${heroKey}" data-i="0"><img src="${artOf(hero, 'full')}" alt=""></div>
    <div class="hero-info"><div class="eyebrow">${cur ? 'Continue listening' : recent.length ? 'Last played' : 'Newest in your library'}</div>
      <h1 class="ellipsis">${esc(hero.title)}</h1><div class="sub ellipsis">${esc(hero.artist)}${hero.album ? ' · ' + esc(hero.album) : ''}</div>
      <div class="row-actions">${cur ? `<button class="btn primary" data-action="toggle"><svg><use href="#i-${engine.el.paused ? 'play' : 'pause'}"/></svg>${engine.el.paused ? (resumeAt ? `Resume at ${fmt(resumeAt)}` : 'Play') : 'Pause'}</button>` : `<button class="btn primary" data-play-list="${heroKey}" data-i="0"><svg><use href="#i-play"/></svg>Play</button>`}
      <button class="btn ghost" data-action="radio" data-id="${hero.id}"><svg><use href="#i-radio"/></svg>Song radio</button></div></div>
  </section>
  ${ctxTiles.length ? `<section class="section"><div class="section-head"><h2>Jump back in</h2></div><div class="tiles">${ctxTiles.join('')}</div></section>` : ''}
  ${recent.length ? shelf('Recently played', recent.slice(0, 16).map((t, i) => trackCard(t, recentKey, i)).join(''), { more: 'smart/recently-played' }) : ''}
  ${shelf('Made for you', [
    ...smartCards.map(([k, d, ts]) => collCard({ href: 'smart/' + k, title: d.title, sub: d.desc, tracks: ts, badge: '<svg><use href="#i-spark"/></svg>' })),
    ...mixes.map(([k, ts]) => collCard({ href: 'mix/' + k, title: mixName(k), sub: count(ts.length), tracks: ts })),
    liked.length ? collCard({ href: 'liked', title: 'Liked Songs', sub: count(liked.length), tracks: liked }) : '',
  ].join(''), { sub: 'Built from your own library and listening' })}
  ${moods.length ? `<section class="section"><div class="section-head"><div><h2>Moods</h2><div class="section-sub">Sessions from songs in your library</div></div></div><div class="chips mood-chips">${moods.map(([k, m, n]) => `<button class="chip mood" data-href="mood/${k}">${esc(m.title)}<span>${n}</span></button>`).join('')}</div></section>` : ''}
  ${discover.length >= 3 ? shelf('Discover in your library', discover.map((t, i) => trackCard(t, discoverKey, i)).join(''), { sub: 'Songs you rarely play that match what you’ve been listening to' }) : ''}
  ${shelf('Recently added', added.map((t, i) => trackCard(t, addedKey, i)).join(''), { more: 'songs' })}
  ${favArtists.length ? shelf(hasTaste ? 'Favorite artists' : 'Artists', favArtists.map(([a]) => { const ts = groups('artist').get(a) || []; return collCard({ href: 'artist/' + a, title: a, sub: count(ts.length), tracks: ts, round: true, img: artOf(ts.find(t => S.thumbs.has(t.id) || S.art.has(t.id)) || ts[0]) }); }).join(''), { more: 'artists' }) : ''}
  ${S.log.length >= 5 ? `<a class="insights-link" href="#/insights"><svg><use href="#i-chart"/></svg><div><b>Your listening</b><span>${hours(S.log.reduce((a, e) => a + (e.s || 0), 0))} so far · see your top songs and artists</span></div><svg class="chev"><use href="#i-back"/></svg></a>` : ''}`;
};
function ctxTile(c) {
  const h = hrefFor(c); const [r, ...rest] = h.split('/'); const p = rest.join('/');
  let tracks = [], title = c.title, img;
  if (r === 'album') tracks = groups('album').get(p) || [];
  else if (r === 'artist') { tracks = groups('artist').get(p) || []; img = artOf(tracks[0]); }
  else if (r === 'playlist') { const pl = S.playlists.get(p); if (!pl) return ''; tracks = pl.tracks.map(id => S.tracks.get(id)).filter(Boolean); title = pl.name; img = S.plCovers.get(p); }
  else if (r === 'smart') { tracks = smartList(p); title = SMART[p]?.title; }
  else if (r === 'mix') tracks = groups('mix').get(p) || [];
  else if (r === 'mood') { tracks = moodList(p); title = MOODS[p]?.title; }
  else if (r === 'liked') tracks = visible().filter(t => t.liked);
  if (!tracks.length || !title) return '';
  return tile({ href: h, title, tracks, img });
}

VIEWS.search = () => {
  const q = S.param;
  const input = `<div class="search-box"><svg><use href="#i-search"/></svg><input id="search-input" class="input" placeholder="Songs, artists, albums, playlists, genres" value="${esc(q)}" autocomplete="off" spellcheck="false" enterkeyhint="search">${q ? '<button class="icon-btn small clear-q" data-action="clear-q" aria-label="Clear"><svg><use href="#i-x"/></svg></button>' : ''}</div>`;
  if (!q) {
    const gs = [...groups('mix')].sort((a, b) => b[1].length - a[1].length);
    return `<div class="page-head"><h1>Search</h1></div>${input}
      ${S.searches.length ? `<section class="section"><div class="section-head"><h2>Recent searches</h2><a class="see-all" data-action="clear-searches">Clear</a></div><div class="chips">${S.searches.map(s => `<button class="chip" data-search="${esc(s)}">${esc(s)}</button>`).join('')}</div></section>` : ''}
      ${gs.length ? `<section class="section"><div class="section-head"><h2>Browse your library</h2></div><div class="genre-grid">${gs.map(([k, ts]) => { const c = colorsOf(ts); return `<div class="genre" data-href="mix/${esc(k)}" style="${ambient(c)}"><span>${esc(k)}</span><small>${count(ts.length)}</small><img loading="lazy" src="${artOf(ts.find(t => S.thumbs.has(t.id)) || ts[0])}" alt=""></div>`; }).join('')}</div></section>` : ''}`;
  }
  const res = S.index.search(q, 300);
  const songs = res.filter(r => r.kind === 'song').map(r => S.tracks.get(r.key)).filter(Boolean).filter(t => !(S.settings.hideExplicit && t.explicit));
  const artists = res.filter(r => r.kind === 'artist').slice(0, 12);
  const albums = res.filter(r => r.kind === 'album').slice(0, 12);
  const pls = res.filter(r => r.kind === 'playlist').slice(0, 8);
  const genres = res.filter(r => r.kind === 'genre').slice(0, 8);
  if (!res.length) return `<div class="page-head"><h1>Search</h1></div>${input}<div class="empty-state small"><h2>No results for “${esc(q)}”</h2><p>Check the spelling, or try an artist, album or genre.</p></div>`;
  const top = res[0];
  const songKey = listKey(songs.map(t => t.id), 'Search');
  let topHtml = '';
  if (top.kind === 'song') { const t = S.tracks.get(top.key); topHtml = `<div class="top-result sr-item" data-play-list="${songKey}" data-i="0" style="${ambient(t.colors)}"><img src="${artOf(t)}" alt=""><div><div class="eyebrow">Song</div><h2 class="ellipsis">${esc(t.title)}</h2><div class="muted ellipsis">${esc(t.artist)}</div></div><span class="hover-play show"><svg><use href="#i-play"/></svg></span></div>`; }
  else { const ts = top.kind === 'artist' ? groups('artist').get(top.key) : top.kind === 'album' ? groups('album').get(top.key) : top.kind === 'genre' ? groups('genre').get(top.key) : S.playlists.get(top.key)?.tracks.map(id => S.tracks.get(id)).filter(Boolean);
    const href = top.kind === 'playlist' ? 'playlist/' + top.key : top.kind === 'genre' ? 'mix/' + top.key : top.kind + '/' + top.key;
    topHtml = `<div class="top-result sr-item" data-href="${esc(href)}" style="${ambient(colorsOf(ts || []))}"><div class="${top.kind === 'artist' ? 'round' : ''} tr-art">${collageHtml(ts || [])}</div><div><div class="eyebrow">${{ artist: 'Artist', album: 'Album', playlist: 'Playlist', genre: 'Genre' }[top.kind]}</div><h2 class="ellipsis">${esc(top.primary)}</h2><div class="muted">${count((ts || []).length)}</div></div></div>`; }
  return `<div class="page-head"><h1>Search</h1></div>${input}
    <div class="search-top"><section><div class="section-head"><h2>Top result</h2></div>${topHtml}</section>
    ${songs.length ? `<section><div class="section-head"><h2>Songs</h2></div>${trackRows(songs.slice(0, 5), { key: songKey, context: 'Search', header: false, cols: [] })}</section>` : ''}</div>
    ${artists.length ? shelf('Artists', artists.map(r => { const ts = groups('artist').get(r.key) || []; return collCard({ href: 'artist/' + r.key, title: r.key, sub: 'Artist', tracks: ts, round: true, img: artOf(ts[0]) }); }).join('')) : ''}
    ${albums.length ? shelf('Albums', albums.map(r => { const ts = groups('album').get(r.key) || []; const [al, ar] = r.key.split('\u0001'); return collCard({ href: 'album/' + r.key, title: al, sub: ar, tracks: ts }); }).join('')) : ''}
    ${pls.length ? shelf('Playlists', pls.map(r => { const p = S.playlists.get(r.key); return p ? collCard({ href: 'playlist/' + p.id, title: p.name, sub: count(p.tracks.length), tracks: p.tracks.map(id => S.tracks.get(id)).filter(Boolean), img: S.plCovers.get(p.id) }) : ''; }).join('')) : ''}
    ${genres.length ? `<section class="section"><div class="section-head"><h2>Genres</h2></div><div class="chips">${genres.map(r => `<button class="chip" data-href="mix/${esc(r.key)}">${esc(r.key)}</button>`).join('')}</div></section>` : ''}
    ${songs.length > 5 ? `<section class="section"><div class="section-head"><h2>All songs</h2><span class="muted">${songs.length}</span></div>${trackRows(songs, { context: 'Search', cols: ['album'] })}</section>` : ''}`;
};
function rebuildIndex() {
  const e = [];
  for (const t of S.tracks.values()) e.push({ kind: 'song', key: t.id, text: `${t.title} ${t.artist} ${t.album || ''} ${t.genre || ''}`, primary: t.title, weight: 1.2 + Math.min(t.plays || 0, 20) * .1 + (t.liked ? 1 : 0) });
  for (const [a, ts] of groups('artist')) e.push({ kind: 'artist', key: a, text: a, primary: a, weight: 2 + Math.min(ts.length, 10) * .1 });
  for (const [k] of groups('album')) { const [al, ar] = k.split('\u0001'); e.push({ kind: 'album', key: k, text: `${al} ${ar}`, primary: al, weight: 1 }); }
  for (const p of S.playlists.values()) e.push({ kind: 'playlist', key: p.id, text: p.name, primary: p.name, weight: 1.5 });
  for (const [g] of groups('genre')) e.push({ kind: 'genre', key: g, text: g, primary: g, weight: .5 });
  S.index.build(e); S.indexDirty = false;
}

const SORTS = {
  title: (a, b) => a.title.localeCompare(b.title), artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
  album: (a, b) => (a.album || '￿').localeCompare(b.album || '￿') || (+a.trackNo || 0) - (+b.trackNo || 0),
  added: (a, b) => (a.addedAt || 0) - (b.addedAt || 0), plays: (a, b) => (a.plays || 0) - (b.plays || 0),
  last: (a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0), time: (a, b) => (a.duration || 0) - (b.duration || 0),
};
function sorted(ts, key, dir) { const f = SORTS[key] || SORTS.added; return [...ts].sort((a, b) => f(a, b) * dir); }
VIEWS.songs = () => {
  const all = visible(); if (!all.length) return `<div class="page-head"><h1>Songs</h1></div>${emptyLib()}`;
  const cats = [...new Set(all.map(t => t.category))];
  const [cat, filter] = [cats.includes(S.param) ? S.param : '', S.songFilter || ''];
  let list = all.filter(t => !cat || t.category === cat);
  if (filter) { const f = fold(filter); list = list.filter(t => fold(`${t.title} ${t.artist} ${t.album}`).includes(f)); }
  list = sorted(list, S.settings.songSort, S.settings.songDir);
  const k = listKey(list.map(t => t.id), cat || 'Songs');
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Songs</h1></div>
    <div class="row-actions"><button class="btn primary" data-play-list="${k}" data-i="0"><svg><use href="#i-play"/></svg>Play</button><button class="btn" data-play-list="${k}" data-shuffle="1"><svg><use href="#i-shuffle"/></svg>Shuffle</button></div></div>
    <div class="toolbar">${cats.length > 1 ? `<div class="chips">${['', ...cats].map(c => `<button class="chip ${c === cat ? 'on' : ''}" data-href="songs${c ? '/' + esc(c) : ''}">${esc(c || 'All')}</button>`).join('')}</div>` : '<div></div>'}
    <div class="filter-box"><svg><use href="#i-search"/></svg><input class="input" id="song-filter" placeholder="Filter songs" value="${esc(filter)}"></div></div>
    <div class="list-meta muted">${count(list.length)} · ${total(list)}</div>
    ${trackRows(list, { key: k, context: cat || 'Songs', cols: ['album', 'added', 'plays'], sortKey: S.settings.songSort, sortDir: S.settings.songDir, sortScope: 'songs' })}`;
};
const artistImg = ts => artOf(ts.find(t => S.thumbs.has(t.id) || S.art.has(t.id)) || ts[0]);
VIEWS.artists = () => {
  const g = [...groups('artist')].sort((a, b) => a[0].localeCompare(b[0]));
  if (!g.length) return `<div class="page-head"><h1>Artists</h1></div>${emptyLib()}`;
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Artists</h1></div><span class="muted">${g.length}</span></div><div class="grid">${g.map(([a, ts]) => collCard({ href: 'artist/' + a, title: a, sub: count(ts.length), tracks: ts, round: true, img: artistImg(ts) })).join('')}</div>`;
};
VIEWS.artist = () => {
  const name = S.param; const ts = groups('artist').get(name) || [];
  if (!ts.length) return `${back()}<div class="empty-state small"><h2>Artist not found</h2></div>`;
  const popular = [...ts].sort((a, b) => (b.plays || 0) - (a.plays || 0) || (b.liked - a.liked) || byAdded(a, b));
  const albums = [...groups('album')].filter(([k, a]) => k.split('\u0001')[1] === name || a.some(t => mainArtist(t.artist) === name));
  const rel = [...relatedArtists([name])].map(a => [a, groups('artist').get(a)]).filter(x => x[1]).slice(0, 12);
  const appears = visible().filter(t => mainArtist(t.artist) !== name && t.artist.includes(name));
  const listened = ts.reduce((a, t) => a + (t.plays || 0), 0);
  return `${back()}${collHead({ img: artistImg(ts), tracks: popular, eyebrow: 'Artist', title: name, meta: `${count(ts.length)}${albums.length ? ` · ${albums.length} album${albums.length > 1 ? 's' : ''}` : ''}${listened ? ` · ${listened} play${listened > 1 ? 's' : ''}` : ''}`, round: true, ctxRoute: 'artist/' + name,
    actions: `<button class="btn ghost" data-action="radio-artist" data-name="${esc(name)}"><svg><use href="#i-radio"/></svg>Artist radio</button>` })}
    <section class="section"><div class="section-head"><h2>${listened ? 'Popular in your library' : 'Songs'}</h2></div>${trackRows(popular.slice(0, ts.length > 8 ? 5 : 8), { context: name, header: false, cols: ['album'] })}</section>
    ${albums.length ? shelf('Albums', albums.map(([k, a]) => collCard({ href: 'album/' + k, title: k.split('\u0001')[0], sub: a[0].year || count(a.length), tracks: a })).join('')) : ''}
    ${ts.length > 8 ? `<section class="section"><div class="section-head"><h2>All songs</h2></div>${trackRows(sorted(ts, 'title', 1), { context: name, cols: ['album', 'plays'] })}</section>` : ''}
    ${appears.length ? shelf('Featured on', appears.map((t, i) => trackCard(t, listKey(appears.map(x => x.id), name), i)).join('')) : ''}
    ${rel.length ? shelf('Similar artists in your library', rel.map(([a, x]) => collCard({ href: 'artist/' + a, title: a, sub: 'Artist', tracks: x, round: true, img: artistImg(x) })).join(''), { sub: 'Same genres or the same playlists' }) : ''}`;
};
VIEWS.albums = () => {
  const g = [...groups('album')].sort((a, b) => a[0].localeCompare(b[0]));
  if (!g.length) return `<div class="page-head"><h1>Albums</h1></div>${visible().length ? '<div class="empty-state small"><h2>No albums yet</h2><p>Songs with an album name show up here. You can add one from a song’s Edit info.</p></div>' : emptyLib()}`;
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Albums</h1></div><span class="muted">${g.length}</span></div><div class="grid">${g.map(([k, ts]) => { const [al, ar] = k.split('\u0001'); return collCard({ href: 'album/' + k, title: al, sub: ar, tracks: ts }); }).join('')}</div>`;
};
VIEWS.album = () => {
  const [al, ar] = S.param.split('\u0001');
  const ts = [...(groups('album').get(S.param) || [])].sort((a, b) => (+a.disc || 1) - (+b.disc || 1) || (+a.trackNo || 999) - (+b.trackNo || 999) || a.title.localeCompare(b.title));
  if (!ts.length) return `${back()}<div class="empty-state small"><h2>Album not found</h2></div>`;
  const year = ts.find(t => t.year)?.year;
  return `${back()}${collHead({ img: artOf(ts[0], 'full'), tracks: ts, eyebrow: 'Album', title: al, ctxRoute: 'album/' + S.param,
    meta: `<a href="#/artist/${encodeURIComponent(ar)}" class="strong">${esc(ar)}</a>${year ? ' · ' + year : ''} · ${count(ts.length)}, ${total(ts)}${ts[0].genre ? ' · ' + esc(ts[0].genre) : ''}`,
    actions: `<button class="btn ghost" data-action="add-all" data-list-ids="${ts.map(t => t.id).join(',')}"><svg><use href="#i-plus"/></svg>Add to playlist</button>` })}
    ${trackRows(ts, { context: al, cols: ['plays'] })}`;
};
VIEWS.liked = () => {
  const ts = visible().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
  return `${collHead({ img: null, tracks: ts, eyebrow: 'Playlist', title: 'Liked Songs', ctxRoute: 'liked', meta: ts.length ? `${count(ts.length)} · ${total(ts)}` : 'Tap the heart on any song to save it here.' })}${ts.length ? trackRows(ts, { context: 'Liked Songs', cols: ['album', 'added'] }) : ''}`;
};
VIEWS.playlist = () => {
  const p = S.playlists.get(S.param);
  if (!p) return `<div class="empty-state small"><h2>Playlist not found</h2></div>`;
  let ts = p.tracks.map(id => S.tracks.get(id)).filter(t => t && !(S.settings.hideExplicit && t.explicit));
  const sort = p.sort || 'custom', f = S.plFilter?.[p.id] || '';
  if (f) ts = ts.filter(t => fold(`${t.title} ${t.artist} ${t.album}`).includes(fold(f)));
  if (sort !== 'custom') ts = sorted(ts, sort, sort === 'added' ? -1 : 1);
  const canDrag = sort === 'custom' && !f;
  return `${collHead({ img: null, custom: S.plCovers.get(p.id), tracks: p.tracks.map(id => S.tracks.get(id)).filter(Boolean), eyebrow: 'Playlist', title: p.name, ctxRoute: 'playlist/' + p.id,
      meta: p.tracks.length ? `${count(p.tracks.length)} · ${total(p.tracks.map(id => S.tracks.get(id)).filter(Boolean))}` : 'Add songs from any song’s ••• menu, or the Add songs button.',
      actions: `<button class="btn ghost" data-action="pl-add-songs" data-pl="${p.id}"><svg><use href="#i-plus"/></svg>Add songs</button><button class="icon-btn" data-action="playlist-menu" data-pl="${p.id}" aria-label="Playlist options"><svg><use href="#i-more"/></svg></button>` })}
    ${p.tracks.length ? `<div class="toolbar"><div class="seg">${[['custom', 'Custom order'], ['title', 'Title'], ['artist', 'Artist'], ['added', 'Recently added']].map(([k, l]) => `<button class="${k === sort ? 'on' : ''}" data-action="pl-sort" data-pl="${p.id}" data-sort="${k}">${l}</button>`).join('')}</div>
      <div class="filter-box"><svg><use href="#i-search"/></svg><input class="input" id="pl-filter" data-pl="${p.id}" placeholder="Find in playlist" value="${esc(f)}"></div></div>
      ${trackRows(ts, { context: p.name, key: 'pl:' + p.id, sortable: canDrag ? 'pl:' + p.id : '', cols: ['album', 'added'] })}` : ''}`;
};
VIEWS.smart = () => {
  const d = SMART[S.param]; if (!d) return `<div class="empty-state small"><h2>Not found</h2></div>`;
  const ts = smartList(S.param);
  return `${back()}${collHead({ img: null, tracks: ts, eyebrow: 'Smart playlist · updates itself', title: d.title, ctxRoute: 'smart/' + S.param, meta: `${esc(d.desc)}${ts.length ? ` · ${count(ts.length)}` : ''}`,
      actions: ts.length ? `<button class="btn ghost" data-action="save-list" data-name="${esc(d.title)}" data-list-ids="${ts.map(t => t.id).join(',')}">Save as playlist</button>` : '' })}
    ${ts.length ? trackRows(ts, { context: d.title, cols: ['album', S.param === 'recently-added' ? 'added' : S.param === 'never-played' ? 'added' : 'plays', 'last'] }) : '<div class="empty-state small"><p>Nothing here yet. This fills in as you listen.</p></div>'}`;
};
VIEWS.mix = () => {
  const k = S.param; const ts = groups('mix').get(k) || groups('genre').get(k) || [];
  return `${back()}${collHead({ img: null, tracks: ts, eyebrow: 'Mix', title: mixName(k), ctxRoute: 'mix/' + k, meta: `Every ${esc(k)} song in your library · ${count(ts.length)} · ${total(ts)}` })}${trackRows(sorted(ts, 'plays', -1), { context: mixName(k), cols: ['album', 'plays'] })}`;
};
VIEWS.mood = () => {
  const m = MOODS[S.param]; if (!m) return `<div class="empty-state small"><h2>Not found</h2></div>`;
  const ts = moodList(S.param);
  return `${back()}${collHead({ img: null, tracks: shuffleArr(ts), eyebrow: 'Mood', title: m.title, ctxRoute: 'mood/' + S.param, meta: `${esc(m.note || 'Matched by genre')} · ${count(ts.length)}` })}${trackRows(ts, { context: m.title, cols: ['album'] })}`;
};
VIEWS.library = () => {
  const pls = [...S.playlists.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const row = (href, icon, label, n) => `<a class="lib-row" href="#/${href}"><svg><use href="#i-${icon}"/></svg><span>${label}</span><span class="muted">${n ?? ''}</span><svg class="chev"><use href="#i-back"/></svg></a>`;
  const smarts = Object.entries(SMART).map(([k, d]) => [k, d, d.get(visible())]).filter(x => x[2].length);
  return `<div class="page-head"><h1>Library</h1><a class="icon-btn" href="#/settings" aria-label="Settings"><svg><use href="#i-gear"/></svg></a></div>
    <div class="lib-rows">${row('songs', 'note', 'Songs', visible().length)}${row('artists', 'mic', 'Artists', groups('artist').size)}${row('albums', 'album', 'Albums', groups('album').size)}${row('liked', 'heart', 'Liked Songs', visible().filter(t => t.liked).length)}${S.log.length ? row('insights', 'chart', 'Your listening', '') : ''}</div>
    <section class="section"><div class="section-head"><h2>Playlists</h2><a class="see-all" data-action="new-playlist">New playlist</a></div>
    ${pls.length ? `<div class="grid">${pls.map(p => collCard({ href: 'playlist/' + p.id, title: p.name, sub: count(p.tracks.length), tracks: p.tracks.map(id => S.tracks.get(id)).filter(Boolean), img: S.plCovers.get(p.id) })).join('')}</div>` : '<p class="muted">No playlists yet.</p>'}</section>
    ${smarts.length ? `<section class="section"><div class="section-head"><h2>Smart playlists</h2></div><div class="grid">${smarts.map(([k, d, ts]) => collCard({ href: 'smart/' + k, title: d.title, sub: count(ts.length), tracks: ts, badge: '<svg><use href="#i-spark"/></svg>' })).join('')}</div></section>` : ''}`;
};
VIEWS.history = () => {
  const ts = P.played.slice().reverse().map(id => S.tracks.get(id)).filter(Boolean);
  return `${back()}<div class="page-head"><div><div class="eyebrow">This session</div><h1>Playback history</h1></div></div>${ts.length ? trackRows(ts, { context: 'History', cols: ['album'] }) : '<div class="empty-state small"><p>Songs you play show up here.</p></div>'}`;
};
VIEWS.insights = () => {
  const log = S.log;
  if (!log.length) return `${back()}<div class="page-head"><h1>Your listening</h1></div><div class="empty-state small"><h2>Nothing yet</h2><p>Play some music and your listening stats show up here. Only real plays count.</p></div>`;
  const secs = log.reduce((a, e) => a + (e.s || 0), 0);
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const thisMonth = log.filter(e => e.at >= month.getTime());
  const songC = playCounts(), artC = new Map(), genC = new Map();
  for (const e of log) { const t = S.tracks.get(e.id); if (!t) continue; const a = mainArtist(t.artist); artC.set(a, (artC.get(a) || 0) + (e.s || 0)); if (t.genre || t.category !== 'Music') { const g = t.genre || t.category; genC.set(g, (genC.get(g) || 0) + (e.s || 0)); } }
  const topSongs = [...songC].filter(([id]) => S.tracks.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topArtists = [...artC].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topGenres = [...genC].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const firsts = new Map(); for (const e of log) if (!firsts.has(e.id)) firsts.set(e.id, e.at);
  const discovered = [...firsts].filter(([id, at]) => Date.now() - at < 30 * DAY && S.tracks.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => S.tracks.get(id));
  const months = []; for (let i = 5; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); d.setHours(0, 0, 0, 0); const e = new Date(d); e.setMonth(e.getMonth() + 1); months.push([d.toLocaleDateString(undefined, { month: 'short' }), log.filter(x => x.at >= d && x.at < e).reduce((a, x) => a + (x.s || 0), 0)]); }
  const maxM = Math.max(...months.map(m => m[1]), 1);
  const hoursArr = Array(24).fill(0); for (const e of log) hoursArr[new Date(e.at).getHours()] += e.s || 0;
  const peak = hoursArr.indexOf(Math.max(...hoursArr));
  const tsKey = listKey(topSongs.map(([id]) => id), 'Your top songs');
  const maxA = topArtists[0]?.[1] || 1;
  return `${back()}<div class="page-head"><div><div class="eyebrow">Insights</div><h1>Your listening</h1><div class="lede">Based only on songs you’ve actually played in Cadence.</div></div></div>
    <div class="stats">
      <div class="stat"><b>${hours(secs)}</b><span>Total listening</span></div>
      <div class="stat"><b>${hours(thisMonth.reduce((a, e) => a + (e.s || 0), 0))}</b><span>This month</span></div>
      <div class="stat"><b>${new Set(log.map(e => e.id)).size}</b><span>Different songs</span></div>
      <div class="stat"><b>${new Date(2000, 0, 1, peak).toLocaleTimeString(undefined, { hour: 'numeric' })}</b><span>Your peak hour</span></div>
    </div>
    <div class="insight-grid">
      <section class="panel"><div class="section-head"><h2>Top songs</h2>${topSongs.length ? `<button class="btn small" data-play-list="${tsKey}" data-i="0"><svg><use href="#i-play"/></svg>Play</button>` : ''}</div>
        ${topSongs.map(([id, n], i) => { const t = S.tracks.get(id); return `<div class="rank" data-play-list="${tsKey}" data-i="${i}"><span class="rank-n">${i + 1}</span><img src="${artOf(t)}" alt=""><div class="ellipsis"><b class="ellipsis">${esc(t.title)}</b><span class="muted ellipsis">${esc(t.artist)}</span></div><span class="muted">${n} play${n > 1 ? 's' : ''}</span></div>`; }).join('')}</section>
      <section class="panel"><div class="section-head"><h2>Top artists</h2></div>
        ${topArtists.map(([a, s]) => `<a class="bar-row" href="#/artist/${encodeURIComponent(a)}"><span class="ellipsis">${esc(a)}</span><div class="bar"><i style="width:${Math.max(4, s / maxA * 100)}%"></i></div><span class="muted">${hours(s)}</span></a>`).join('')}
        ${topGenres.length ? `<div class="section-head" style="margin-top:22px"><h2>Genres</h2></div><div class="chips">${topGenres.map(([g, s]) => `<button class="chip" data-href="mix/${esc(g)}">${esc(g)} <span>${hours(s)}</span></button>`).join('')}</div>` : ''}</section>
      <section class="panel"><div class="section-head"><h2>Last 6 months</h2></div><div class="months">${months.map(([l, s]) => `<div class="mcol"><div class="mbar"><i style="height:${s / maxM * 100}%"></i></div><span>${l}</span><small>${s ? hours(s) : ''}</small></div>`).join('')}</div></section>
    </div>
    ${discovered.length ? shelf('Recently discovered', discovered.map((t, i) => trackCard(t, listKey(discovered.map(x => x.id), 'Recently discovered'), i)).join(''), { sub: 'First played in the last 30 days' }) : ''}`;
};

/* =====================================================================
   Duplicates
   ===================================================================== */
function duplicateGroups() {
  const m = new Map();
  for (const t of S.tracks.values()) { const k = meta.dupKey(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  const out = [];
  for (const [k, ts] of m) {
    if (ts.length < 2 || S.dupIgnore.includes(k)) continue;
    // same name AND close length: likely the same recording
    const close = ts.filter(t => ts.some(o => o !== t && Math.abs((o.duration || 0) - (t.duration || 0)) <= 3));
    if (close.length >= 2) out.push([k, close]);
  }
  return out;
}
VIEWS.duplicates = () => {
  const gs = duplicateGroups();
  return `${back()}<div class="page-head"><div><div class="eyebrow">Library</div><h1>Possible duplicates</h1><div class="lede">Songs with the same title and artist and nearly the same length. Nothing is removed unless you choose to, and files on your computer are never touched.</div></div></div>
    ${gs.length ? gs.map(([k, ts]) => `<section class="panel dup">${ts.map(t => `<div class="dup-row"><img src="${artOf(t)}" alt=""><div class="ellipsis"><b>${esc(t.title)}</b><span class="muted ellipsis">${esc(t.artist)} · ${fmt(t.duration)} · ${t.size ? bytes(t.size) : ''} · ${t.plays || 0} plays${t.liked ? ' · liked' : ''}</span><span class="dim ellipsis">${esc(t.file || '')}</span></div>
      <button class="btn small" data-action="play-one" data-id="${t.id}"><svg><use href="#i-play"/></svg></button><button class="btn small ghost" data-action="dup-remove" data-id="${t.id}">Remove this copy</button></div>`).join('')}
      <div class="row-actions"><button class="btn small ghost" data-action="dup-ignore" data-key="${esc(k)}">These are different songs</button></div></section>`).join('') : '<div class="empty-state small"><h2>No duplicates found</h2><p>Your library looks clean.</p></div>'}`;
};

/* =====================================================================
   Import
   ===================================================================== */
const IMP = { jobs: [], cancel: false, running: false, found: 0, added: 0, skipped: 0, failed: 0, maybeDup: 0 };
VIEWS.import = () => {
  const signedOut = cloud.cloudConfigured() && !S.user;
  const st = IMP;
  const failed = st.jobs.filter(j => j.state === 'error');
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Add music</h1><div class="lede">MP3, M4A, AAC, FLAC and WAV. Songs already in your library are skipped.</div></div></div>
    <div class="drop" id="drop">
      <div class="drop-icon"><svg><use href="#i-upload"/></svg></div>
      <div class="drop-text"><h2>${IS_IOS ? 'Add songs from Files' : 'Drop a folder or songs here'}</h2><p>${IS_IOS ? 'Pick songs saved in the Files app. Your full library is easiest to add from your computer, then sign in here to play it.' : 'Your Mac keeps songs in Music → Media → Music. Choose that folder to bring in everything.'}</p></div>
      <div class="row-actions">${IS_IOS ? '' : '<button class="btn primary" data-action="pick-folder"><svg><use href="#i-album"/></svg>Choose folder</button>'}<button class="btn ${IS_IOS ? 'primary' : ''}" data-action="pick-files"><svg><use href="#i-note"/></svg>Choose songs</button></div>
    </div>
    ${signedOut ? `<p class="note">You’re not signed in, so new songs stay on this device. <a href="#/settings/account">Sign in</a> to play them on your other devices too.</p>` : S.user ? `<p class="note"><svg><use href="#i-cloud"/></svg>New songs upload to your cloud library so your other devices can play them.</p>` : `<p class="note">Songs are saved in this browser on this device.</p>`}
    ${st.jobs.length ? `<div class="imp-stats" id="imp-stats">${impStats()}</div>
    <div class="imp-actions">${st.running ? '<button class="btn small ghost" data-action="imp-cancel">Cancel</button>' : ''}${!st.running && failed.length ? `<button class="btn small" data-action="imp-retry">Retry ${failed.length} failed</button>` : ''}${!st.running && st.maybeDup ? '<a class="btn small ghost" href="#/duplicates">Review possible duplicates</a>' : ''}${!st.running ? '<button class="btn small ghost" data-action="imp-clear">Clear list</button>' : ''}</div>
    <div class="import-list" id="import-list">${st.jobs.slice(0, 400).map(importRow).join('')}</div>` : ''}`;
};
function impStats() {
  const s = IMP, done = s.added + s.skipped + s.failed;
  return `<div class="imp-bar"><i style="width:${s.found ? done / s.found * 100 : 0}%"></i></div>
    <div class="imp-nums"><span><b>${s.found}</b> found</span><span><b>${s.added}</b> added</span><span><b>${s.skipped}</b> already here</span>${s.failed ? `<span class="err"><b>${s.failed}</b> need attention</span>` : ''}${s.maybeDup ? `<span><b>${s.maybeDup}</b> possible duplicates</span>` : ''}</div>`;
}
function importRow(j) {
  return `<div class="import-row" id="imp-${j.key}"><div class="th"><img src="${j.art || PLACEHOLDER}" alt=""></div>
    <div class="ellipsis"><div class="ellipsis strong">${esc(j.title || j.name)}</div><div class="ellipsis muted">${esc(j.artist || j.file.name)}</div></div>
    <div class="st ${j.state === 'done' ? 'ok' : j.state === 'error' ? 'err' : j.state === 'skip' ? 'dim' : ''}">${esc(j.status)}</div></div>`;
}
let statT;
function updateImportRow(j) {
  const el = document.getElementById('imp-' + j.key); if (el) el.outerHTML = importRow(j);
  clearTimeout(statT); statT = setTimeout(() => { const s = $('#imp-stats'); if (s) s.innerHTML = impStats(); }, 80);
}
function bindImport() {
  const d = $('#drop'); if (!d) return;
  d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('over'); });
  d.addEventListener('dragleave', () => d.classList.remove('over'));
}
async function filesFromDrop(dt) {
  const out = [];
  const walk = async entry => {
    if (entry.isFile) await new Promise(r => entry.file(f => { out.push(f); r(); }, r));
    else if (entry.isDirectory) { const reader = entry.createReader(); let batch; do { batch = await new Promise(r => reader.readEntries(r, () => r([]))); for (const e of batch) await walk(e); } while (batch.length); }
  };
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const e of entries) await walk(e); else out.push(...dt.files);
  return out;
}
async function importFiles(files, { retry = false } = {}) {
  const audio = files.filter(f => meta.AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
  if (!audio.length) { toast(files.length ? 'No songs found there. Cadence reads MP3, M4A, AAC, FLAC and WAV.' : 'Nothing selected'); return; }
  if (IMP.running) { toast('Still importing. Wait for it to finish first.'); return; }
  if (S.route !== 'import') go('import');
  if (!retry) Object.assign(IMP, { jobs: [], found: 0, added: 0, skipped: 0, failed: 0, maybeDup: 0 });
  const jobs = audio.map(f => ({ key: uid(), file: f, name: f.name.replace(/\.[^.]+$/, ''), status: 'Waiting', state: 'wait' }));
  if (retry) { IMP.failed -= jobs.length; IMP.jobs = IMP.jobs.filter(j => j.state !== 'error'); } else IMP.found = jobs.length;
  IMP.jobs.unshift(...jobs); IMP.cancel = false; IMP.running = true;
  render();
  const queue = [...jobs];
  const known = { hashes: new Set([...S.tracks.values()].map(t => t.hash).filter(Boolean)), keys: new Map([...S.tracks.values()].map(t => [meta.dupKey(t), t])) };
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length && !IMP.cancel) {
      const j = queue.shift();
      try { const r = await importOne(j, known); if (r === 'skip') IMP.skipped++; else { IMP.added++; if (r === 'maybe') IMP.maybeDup++; } }
      catch (e) {
        console.error(e); IMP.failed++; j.state = 'error';
        j.status = isQuotaError(e) ? 'Out of space' : e.message === 'unplayable' ? 'Can’t play this format' : 'Couldn’t read this file';
        updateImportRow(j);
        if (isQuotaError(e)) { IMP.cancel = true; quotaWarning(); }
      }
    }
  }));
  for (const j of queue) { j.state = 'skip'; j.status = 'Cancelled'; }
  IMP.running = false; S.indexDirty = true; S.ver++;
  if (S.route === 'import') render();
  const msg = IMP.cancel && queue.length ? `Stopped. Added ${count(IMP.added)}` : IMP.added ? `Added ${count(IMP.added)}${IMP.skipped ? ` · ${IMP.skipped} already here` : ''}` : IMP.skipped ? 'Those songs are already in your library' : 'Nothing was added';
  toast(msg, IMP.maybeDup ? ['Review duplicates', () => go('duplicates')] : null);
  queueStatePush();
}
async function importOne(j, known) {
  const f = j.file;
  j.status = 'Reading'; updateImportRow(j);
  const [hash, legacyId] = await Promise.all([meta.fingerprint(f), meta.trackId(f)]);
  if (known.hashes.has(hash) || S.tracks.has(hash) || S.tracks.has(legacyId)) {
    const t = S.tracks.get(hash) || S.tracks.get(legacyId) || [...S.tracks.values()].find(x => x.hash === hash);
    Object.assign(j, { state: 'skip', status: 'Already here', title: t?.title, artist: t?.artist, art: t ? artOf(t) : null }); updateImportRow(j); return 'skip';
  }
  known.hashes.add(hash);
  const tags = await meta.readTags(f);
  const names = meta.cleanNames(tags, f.name);
  const reliable = meta.isReliable(tags);
  const t = {
    id: hash, hash, ...(reliable ? { title: tags.title, artist: tags.artist, album: tags.album } : names),
    albumArtist: tags.albumArtist || '', genre: tags.genre || '', year: tags.year || '', trackNo: tags.track || '', disc: tags.disc || '',
    gain: tags.gain, file: f.name, size: f.size, type: f.type || '', addedAt: Date.now(), plays: 0, liked: false, local: true, cloud: false,
    original: { title: tags.title || '', artist: tags.artist || '', album: tags.album || '', genre: tags.genre || '', file: f.name },
  };
  const ft = (t.title.match(/\((?:feat\.?|ft\.?|with)\s+([^)]+)\)/i) || t.artist.match(/ (?:feat\.?|ft\.?|featuring) (.+)$/i) || [])[1];
  if (ft) t.featured = ft.split(/, | & /).map(s => s.trim());
  t.category = meta.categorize(t);
  Object.assign(j, { title: t.title, artist: t.artist }); updateImportRow(j);
  t.duration = await meta.audioDuration(f);
  if (!t.duration && !/\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i.test(f.name)) throw new Error('unplayable');
  let artBlob = tags.picture?.size > 2000 ? tags.picture : null;
  if (S.settings.autoFix && t.category === 'Music' && (!reliable || !artBlob)) {
    j.status = 'Finding artwork'; updateImportRow(j);
    const found = await meta.lookup({ title: t.title, artist: t.artist, duration: t.duration });
    if (found) {
      if (!reliable) Object.assign(t, { title: found.title, artist: found.artist, album: found.album || t.album });
      Object.assign(t, { genre: t.genre || found.genre || '', year: t.year || found.year || '', explicit: found.explicit, matched: true });
      if (!artBlob || !reliable) try { artBlob = await meta.fetchImage(found.artUrl); } catch {}
    }
  }
  if (!artBlob) { artBlob = await meta.makeCover(t.title, t.artist, t.category); t.designedCover = true; }
  t.category = meta.categorize(t);
  const dupOf = known.keys.get(meta.dupKey(t));
  if (dupOf && Math.abs((dupOf.duration || 0) - t.duration) <= 3) t.maybeDupOf = dupOf.id;
  known.keys.set(meta.dupKey(t), t);
  await db.put('audio', t.id, f);
  await setArt(t, artBlob);
  await saveTrack(t, { sync: false });
  Object.assign(j, { title: t.title, artist: t.artist, art: artOf(t) });
  if (S.user) {
    j.status = 'Uploading'; updateImportRow(j);
    try { await uploadTrack(t, f, artBlob); } catch (e) { syncFailed(e); j.state = 'done'; j.status = 'Added · upload later'; updateImportRow(j); return t.maybeDupOf ? 'maybe' : 'ok'; }
  }
  j.state = 'done'; j.status = t.maybeDupOf ? 'Added · possible duplicate' : S.user ? 'Added · in your cloud' : 'Added'; updateImportRow(j);
  return t.maybeDupOf ? 'maybe' : 'ok';
}
async function uploadTrack(t, audioBlob, artBlob) {
  await cloud.uploadFile('audio/' + t.id, audioBlob);
  if (artBlob) await cloud.uploadFile('art/' + t.id, artBlob);
  t.cloud = true;
  await saveTrack(t);
}

/* =====================================================================
   Settings
   ===================================================================== */
const SETTING_TABS = [['appearance', 'Appearance'], ['playback', 'Playback'], ['library', 'Library'], ['account', 'Account & Sync'], ['privacy', 'Privacy'], ['about', 'About']];
const sw = (key, label, sub) => `<div class="set-row"><div class="lbl"><b>${label}</b><span>${sub}</span></div><button class="switch ${S.settings[key] ? 'on' : ''}" role="switch" aria-checked="${!!S.settings[key]}" data-action="toggle-setting" data-key="${key}" aria-label="${label}"></button></div>`;
const seg = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${S.settings[key] === v ? 'on' : ''}" data-action="set" data-key="${key}" data-val="${v}">${l}</button>`).join('')}</div>`;
VIEWS.settings = () => {
  const tab = SETTING_TABS.some(t => t[0] === S.param) ? S.param : 'appearance';
  const body = {
    appearance: () => `<div class="settings-group">
      <div class="set-row"><div class="lbl"><b>Theme</b><span>The full-screen player always stays dark</span></div>${seg('theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match device']])}</div>
      <div class="set-row"><div class="lbl"><b>Accent color</b><span>Buttons, highlights and the playing song</span></div><div class="swatches">${Object.entries(ACCENTS).map(([k, [hex]]) => `<button class="swatch ${S.settings.accent === k ? 'on' : ''}" style="background:${hex}" data-action="set" data-key="accent" data-val="${k}" aria-label="${k}"></button>`).join('')}</div></div>
      <div class="set-row"><div class="lbl"><b>Layout</b><span>Compact fits more songs on screen</span></div>${seg('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']])}</div>
      ${sw('reduceMotion', 'Reduce motion', 'Turns off movement and transitions. Also follows your device setting.')}</div>`,
    playback: () => `<div class="settings-group">
      ${sw('autoplay', 'Autoplay', 'When your music ends, keep going with similar songs from your library')}
      ${IS_IOS ? `<div class="set-row"><div class="lbl"><b>Crossfade and gapless</b><span>Not available on iPhone and iPad. Apple only lets web apps play one song at a time in the background.</span></div></div>` : `
      <div class="set-row"><div class="lbl"><b>Crossfade</b><span>${S.settings.crossfade ? `Songs blend over ${S.settings.crossfade} seconds` : 'Off. Songs play one after another.'}</span></div><input type="range" class="setting-range" min="0" max="12" step="1" value="${S.settings.crossfade}" data-setting="crossfade" aria-label="Crossfade seconds"></div>
      ${sw('gapless', 'Gapless playback', 'Loads the next song early so there’s no pause between tracks')}`}
      ${sw('leveling', 'Volume leveling', 'Evens out loud and quiet songs using loudness info saved in your files (ReplayGain). Songs without it play as they are.')}
      ${sw('hideExplicit', 'Hide explicit songs', 'Uses Apple’s explicit labels found during import. Songs without a label are not hidden.')}</div>`,
    library: () => { const dups = duplicateGroups().length; const local = [...S.tracks.values()].filter(t => t.local).length; return `<div class="settings-group">
      ${sw('autoFix', 'Fix names and artwork on import', 'Cleans up titles like “Official Video” and looks up album artwork. Songs with complete tags keep their own names.')}
      <div class="set-row"><div class="lbl"><b>Fix all songs again</b><span>Re-checks names and artwork for songs you haven’t edited yourself</span></div><button class="btn" data-action="refix-all">Fix all</button></div>
      <div class="set-row"><div class="lbl"><b>Possible duplicates</b><span>${dups ? `${dups} group${dups > 1 ? 's' : ''} to review` : 'None found'}</span></div><a class="btn" href="#/duplicates">Review</a></div>
      <div class="set-row"><div class="lbl"><b>Storage on this device</b><span id="storage-used">${count(local)} saved here</span></div>${S.user ? '<button class="btn ghost" data-action="clear-device">Remove downloads</button>' : ''}</div></div>`; },
    account: () => {
      if (!cloud.cloudConfigured()) return `<div class="settings-group"><div class="set-row"><div class="lbl"><b>Cloud library isn’t connected yet</b><span>Your music is saved in this browser on this device only. Once the cloud is connected, you can sign in here and play your library on every device.</span></div></div></div>`;
      if (!S.user) return `<div class="settings-group"><div class="set-row block"><div class="lbl"><b>Sign in</b><span>Use the same login on every device to get the same library, playlists and likes. Each person’s library is private to them.</span></div>
        <form class="auth" data-action="noop"><input class="input" id="auth-email" type="email" placeholder="Email" autocomplete="email" required><input class="input" id="auth-pass" type="password" placeholder="Password (6+ characters)" autocomplete="current-password" required minlength="6">
        <div class="row-actions"><button class="btn primary" data-action="sign-in">Sign in</button><button class="btn" data-action="sign-up">Create account</button></div></form></div></div>`;
      const localOnly = [...S.tracks.values()].filter(t => t.local && !t.cloud).length;
      return `<div class="settings-group">
        <div class="set-row"><div class="lbl"><b>${esc(S.user.email)}</b><span>Signed in. Your library, playlists, likes and listening history sync to every device you sign in on.</span></div><button class="btn ghost" data-action="sign-out">Sign out</button></div>
        <div class="set-row"><div class="lbl"><b>Sync</b><span>${S.lastSync ? 'Last synced ' + new Date(S.lastSync).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Not synced yet'}${navigator.onLine ? '' : ' · offline'}</span></div><button class="btn" data-action="sync">Sync now</button></div>
        ${localOnly ? `<div class="set-row"><div class="lbl"><b>${count(localOnly)} only on this device</b><span>Upload them so your other devices can play them too</span></div><button class="btn primary" data-action="upload-local">Upload</button></div>` : ''}
        <div class="set-row"><div class="lbl"><b>Password</b><span>Change the password for this account</span></div><button class="btn ghost" data-action="change-pass">Change</button></div></div>`;
    },
    privacy: () => `<div class="settings-group">
      ${sw('keepHistory', 'Save listening history', 'Powers Recently Played, Insights, Rediscover and Late Night. Turn off to stop recording new plays.')}
      <div class="set-row"><div class="lbl"><b>Clear listening history</b><span>${S.log.length} plays recorded. Play counts on songs stay.</span></div><button class="btn ghost" data-action="clear-history">Clear</button></div>
      <div class="set-row"><div class="lbl"><b>Export my data</b><span>A file with your library details, playlists and listening history (no audio)</span></div><button class="btn" data-action="export">Export</button></div>
      <div class="set-row"><div class="lbl"><b>Delete everything on this device</b><span>Removes all songs, artwork and history saved in this browser</span></div><button class="btn danger" data-action="wipe-device">Delete</button></div>
      ${S.user ? `<div class="set-row"><div class="lbl"><b>Delete my cloud library</b><span>Permanently removes your songs, playlists and history from the cloud</span></div><button class="btn danger" data-action="wipe-cloud">Delete</button></div>` : ''}</div>
      <p class="fine">What Cadence stores: your song files and artwork, song details, playlists, likes, play counts and a log of what you played and when. On this device it lives in your browser’s storage. When you’re signed in, a copy is kept in your private cloud library so your other devices can use it. Nothing is shared with anyone else.</p>`,
    about: () => `<div class="settings-group">
      <div class="set-row"><div class="lbl"><b>Cadence</b><span>Version ${esc((S.version || 'dev').slice(0, 7))}</span></div><button class="btn" data-action="check-update">Check for updates</button></div>
      <div class="set-row"><div class="lbl"><b>Keyboard shortcuts</b><span>Space play/pause · ← → skip 10s · Shift ← → previous/next · L like · / search · Q up next</span></div></div>
      <div class="set-row"><div class="lbl"><b>Where artwork and lyrics come from</b><span>Artwork and song details: Apple’s public iTunes Search. Lyrics: LRCLIB, a free community lyrics library. Only songs they have are matched.</span></div></div></div>`,
  }[tab]();
  return `<div class="page-head"><h1>Settings</h1></div>
    <div class="settings-layout"><nav class="settings-nav">${SETTING_TABS.map(([k, l]) => `<a href="#/settings/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav><div>${body}</div></div>`;
};

/* =====================================================================
   Player
   ===================================================================== */
async function srcFor(t) {
  const blob = t.local ? await db.get('audio', t.id) : null;
  if (blob) {
    if (!P.objUrls.has(t.id)) P.objUrls.set(t.id, URL.createObjectURL(blob));
    for (const [id, u] of P.objUrls) if (id !== t.id && id !== current()?.id && id !== P.preloadFor) { URL.revokeObjectURL(u); P.objUrls.delete(id); }
    return P.objUrls.get(t.id);
  }
  if (t.cloud && S.user) return await cloud.fileUrl('audio/' + t.id);
  return null;
}
const gainFor = t => S.settings.leveling ? t.gain : undefined;
function current() { return S.tracks.get(P.queue[P.idx]); }

async function loadTrack(id, { autoplay = true, quiet = false } = {}) {
  const t = S.tracks.get(id); if (!t) return false;
  flushListen();
  const src = await srcFor(t);
  if (!src) {
    if (!quiet) toast(!t.local && t.cloud && !S.user ? 'Sign in to play songs from your cloud library' : !navigator.onLine && t.cloud ? 'You’re offline and this song isn’t saved on this device' : 'This song isn’t available on this device');
    return false;
  }
  P.preloadFor = null; P.fadeStarted = false; P.counted = false; P.lyrics = null; P.lyricLine = -1; P.follow = true;
  paintNow(t);
  try { await engine.load(src, { gainDb: gainFor(t), autoplay }); }
  catch (e) { if (e.name === 'NotAllowedError') { updatePlayIcons(); } else if (e.name !== 'AbortError') console.warn(e); }
  if (autoplay) P.played.push(t.id);
  startListen(t.id);
  updateMediaSession(t);
  savePlayer();
  if ($('#now').classList.contains('open')) renderPanel();
  return true;
}
async function playList(ids, start = 0, { shuffle = false, context = '', ctxRoute = '', mode = null, seed = null } = {}) {
  ids = ids.filter(id => S.tracks.has(id));
  if (!ids.length) return;
  if (shuffle) P.shuffle = true;
  if (P.shuffle) { const first = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[start]; ids = [first, ...shuffleArr(ids.filter(x => x !== first))]; start = 0; }
  Object.assign(P, { queue: ids, idx: start, autoAdded: new Set(), context, contextRoute: ctxRoute, mode, seed });
  if (ctxRoute) recordCtx(ctxRoute, context);
  updateModes();
  const ok = await loadTrack(P.queue[P.idx]);
  if (!ok) { const k = P.queue.findIndex((id, i) => i > start && (S.tracks.get(id)?.local || (S.user && S.tracks.get(id)?.cloud))); if (k > 0) { P.idx = k; loadTrack(P.queue[k]); } }
}
function recordCtx(route, title) {
  if (!title) return;
  S.ctxs = [{ route, title, at: Date.now() }, ...S.ctxs.filter(c => c.route !== route)].slice(0, 16);
  kv.set('ctxs', S.ctxs); queueStatePush();
}
/** What plays after the current song. Extends the queue with radio/Flow/autoplay picks when it runs out. */
function peekNext() {
  if (!P.queue.length) return null;
  if (P.idx + 1 < P.queue.length) return { id: P.queue[P.idx + 1], idx: P.idx + 1 };
  if (P.repeat === 'all') return { id: P.queue[0], idx: 0 };
  let more = [];
  if (P.mode === 'flow') more = flowPicks(15);
  else if (P.mode === 'radio') more = similar([S.tracks.get(P.seed), current()].filter(Boolean), 15);
  else if (S.settings.autoplay) more = similar([...P.queue.slice(Math.max(0, P.idx - 4), P.idx + 1)].map(id => S.tracks.get(id)), 12);
  more = more.filter(id => S.tracks.get(id)?.local || (S.user && S.tracks.get(id)?.cloud));
  if (!more.length) return null;
  more.forEach(id => P.autoAdded.add(id)); P.queue.push(...more); savePlayer();
  if (P.panel === 'queue' && $('#now').classList.contains('open')) renderQueue();
  return { id: P.queue[P.idx + 1], idx: P.idx + 1 };
}
async function next(auto = false) {
  if (!P.queue.length) return;
  if (auto && P.repeat === 'one') { engine.el.currentTime = 0; engine.el.play(); return; }
  const n = peekNext();
  if (!n) { if (auto) { engine.el.pause(); engine.el.currentTime = 0; toast('That’s the end of the queue'); } return; }
  P.idx = n.idx;
  const ok = await loadTrack(n.id);
  if (!ok && auto) next(true);
}
function prev() {
  if (engine.el.currentTime > 3 || P.idx <= 0) { engine.el.currentTime = 0; return; }
  P.idx--; loadTrack(P.queue[P.idx]);
}
function toggle() {
  if (!current()) { const ids = visible().sort(byAdded).map(t => t.id); if (ids.length) playList(ids, 0, { context: 'Your library' }); return; }
  if (!engine.el.src) return loadTrack(current().id);
  engine.el.paused ? engine.el.play().catch(() => {}) : engine.el.pause();
}
async function advanceTo(id, seconds) {
  const n = peekNext();
  if (!n || n.id !== id) return next(true);
  flushListen();
  P.idx = n.idx;
  await engine.advance(seconds);
}
engine.addEventListener('switched', () => {
  const t = current(); if (!t) return;
  P.counted = false; P.lyrics = null; P.lyricLine = -1; P.follow = true; P.preloadFor = null; P.fadeStarted = false;
  P.played.push(t.id); startListen(t.id);
  paintNow(t); updateMediaSession(t); updatePlayIcons(); savePlayer();
  if ($('#now').classList.contains('open')) renderPanel();
});

/* listening log (only real listening time counts) */
function startListen(id) { P.listen = { id, s: 0, at: Date.now() }; P.tick = 0; }
function flushListen() {
  const l = P.listen; P.listen = null;
  if (!l || l.s < 10 || !S.settings.keepHistory) return;
  S.log.push({ id: l.id, at: l.at, s: Math.round(l.s) });
  if (S.log.length > 5000) S.log = S.log.slice(-5000);
  kv.set('log', S.log); queueStatePush();
}
function addHistory(id) {
  if (!S.settings.keepHistory) return;
  S.history = [id, ...S.history.filter(x => x !== id)].slice(0, 200);
  kv.set('history', S.history);
}
let saveT;
function savePlayer(now) {
  clearTimeout(saveT);
  const w = () => kv.set('player', { queue: P.queue, idx: P.idx, shuffle: P.shuffle, repeat: P.repeat, context: P.context, contextRoute: P.contextRoute, mode: P.mode, seed: P.seed, played: P.played.slice(-100), time: engine.el.currentTime || 0 });
  if (now) return w();
  saveT = setTimeout(w, 500);
}

function paintRange(el) { el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%'); }
function paintNow(t) {
  $('#player').classList.remove('empty');
  const thumb = artOf(t), full = artOf(t, 'full');
  $('#p-art').src = thumb;
  const na = $('#now-art'); if (na.dataset.id !== t.id) { na.classList.remove('in'); void na.offsetWidth; na.src = full; na.dataset.id = t.id; na.classList.add('in'); }
  $('#p-title').textContent = t.title; $('#p-artist').textContent = t.artist;
  $('#now-title').textContent = t.title; $('#now-artist').textContent = t.artist;
  $('#now-artist').href = '#/artist/' + encodeURIComponent(mainArtist(t.artist));
  $('#now-from').textContent = P.mode === 'flow' ? 'Cadence Flow' : P.context ? 'Playing from ' + P.context : '';
  ['#p-like', '#now-like'].forEach(s => $(s).classList.toggle('on', !!t.liked));
  document.title = `${t.title} · ${t.artist}`;
  setNowBg(t.colors);
  $('#player').style.cssText = ambient(t.colors);
  markPlaying();
}
let bgLayer = 0;
function setNowBg(c) {
  const layers = $$('#now-bg .bgl');
  const key = c ? c.base + c.glow : 'none';
  if (layers[bgLayer].dataset.key === key) return;
  bgLayer = 1 - bgLayer;
  const l = layers[bgLayer]; l.dataset.key = key; l.style.cssText = ambient(c || { base: '#1b1b1f', glow: '#2a2a30', accent: '#555' });
  layers[bgLayer].classList.add('on'); layers[1 - bgLayer].classList.remove('on');
}
function markPlaying() {
  const id = P.queue[P.idx];
  $$('.track.playing').forEach(r => { if (r.dataset.id !== id) r.classList.remove('playing'); });
  if (id) $$(`.track[data-id="${id}"]`).forEach(r => r.classList.add('playing'));
}
function updatePlayIcons() {
  const paused = engine.el.paused;
  ['#p-play', '#now-play', '#p-play-mini'].forEach(s => { $(s + ' use').setAttribute('href', paused ? '#i-play' : '#i-pause'); $(s).setAttribute('aria-label', paused ? 'Play' : 'Pause'); });
  $('#now').classList.toggle('paused', paused);
  document.body.classList.toggle('is-paused', paused);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
}
function updateModes() {
  ['#p-shuffle', '#now-shuffle'].forEach(s => { $(s).classList.toggle('on', P.shuffle); $(s).setAttribute('aria-pressed', P.shuffle); });
  ['#p-repeat', '#now-repeat'].forEach(s => { $(s).classList.toggle('on', P.repeat !== 'off'); $(s + ' use').setAttribute('href', P.repeat === 'one' ? '#i-repeat1' : '#i-repeat'); $(s).setAttribute('aria-label', { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[P.repeat]); });
}
let seeking = false;
function onTime() {
  const el = engine.el, d = el.duration || 0, c = el.currentTime || 0;
  if (!seeking) {
    for (const s of ['#p-seek', '#now-seek']) { const r = $(s); r.value = d ? c / d * 1000 : 0; paintRange(r); }
    $('#p-cur').textContent = $('#now-cur').textContent = fmt(c);
    $('#p-dur').textContent = $('#now-dur').textContent = '-' + fmt(d - c);
  }
  $('#p-mini-bar').style.transform = `scaleX(${d ? c / d : 0})`;
  const t = current();
  if (P.listen && !el.paused) { const now = performance.now(); if (P.tick) P.listen.s += Math.min((now - P.tick) / 1000, 1.5); P.tick = now; }
  if (t && !P.counted && d && c > Math.min(30, d * .5)) { P.counted = true; t.plays = (t.plays || 0) + 1; t.lastPlayed = Date.now(); saveTrack(t); addHistory(t.id); }
  if (P.lyrics?.lines && P.panel === 'lyrics' && $('#now').classList.contains('open')) syncLyrics(c);
  if (P.sleepAt) { if (Date.now() >= P.sleepAt) { el.pause(); clearSleep(); toast('Sleep timer ended'); } else $('#sleep-btn span').textContent = fmt((P.sleepAt - Date.now()) / 1000); }
  // gapless / crossfade: buffer the next song near the end, then switch
  const remain = d - c;
  const cf = engine.dual ? S.settings.crossfade : 0;
  if (engine.dual && (S.settings.gapless || cf) && d && remain < Math.max(cf + 10, 15) && P.repeat !== 'one' && !P.sleepEnd && !el.paused) {
    const n = peekNext();
    if (n && P.preloadFor !== n.id) {
      P.preloadFor = n.id; const nt = S.tracks.get(n.id);
      srcFor(nt).then(src => { if (src && P.preloadFor === n.id) engine.preload(n.id, src, gainFor(nt)); });
    }
    if (cf && !P.fadeStarted && remain <= cf && remain > .4 && n && engine.hasSpare(n.id)) { P.fadeStarted = true; advanceTo(n.id, Math.min(cf, remain)); }
  }
  if (Math.floor(c) % 5 === 0) savePlayer();
  if ('mediaSession' in navigator && d && isFinite(d)) { try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: el.playbackRate || 1 }); } catch {} }
}
for (const el of engine.els) {
  const mine = fn => e => { if (e.target === engine.el) fn(e); };
  el.addEventListener('timeupdate', mine(onTime));
  el.addEventListener('loadedmetadata', mine(() => { const t = current(); if (t && isFinite(el.duration) && (!t.duration || Math.abs(t.duration - el.duration) > 2)) { t.duration = el.duration; saveTrack(t, { sync: false }); } onTime(); }));
  el.addEventListener('play', mine(() => { P.tick = 0; updatePlayIcons(); }));
  el.addEventListener('pause', mine(() => { P.tick = 0; updatePlayIcons(); savePlayer(); }));
  el.addEventListener('waiting', mine(() => $('#player').classList.add('buffering')));
  el.addEventListener('playing', mine(() => $('#player').classList.remove('buffering')));
  el.addEventListener('ended', mine(() => {
    if (P.sleepEnd) { clearSleep(); toast('Sleep timer ended'); return; }
    if (P.repeat === 'one') return next(true);
    if (P.preloadFor && engine.hasSpare(P.preloadFor)) return advanceTo(P.preloadFor, 0);
    next(true);
  }));
  el.addEventListener('error', mine(() => {
    if (!el.getAttribute('src')) return;
    const t = current(); const code = el.error?.code;
    toast(code === 4 ? `“${t?.title || 'This song'}” is in a format this browser can’t play` : code === 2 ? 'Network problem. Skipping ahead.' : `“${t?.title || 'This song'}” couldn’t be played. Skipping.`);
    setTimeout(() => next(true), 800);
  }));
}
function bindSeek(sel) {
  const r = $(sel);
  r.addEventListener('input', () => { seeking = true; paintRange(r); const d = engine.el.duration || 0; $('#p-cur').textContent = $('#now-cur').textContent = fmt(r.value / 1000 * d); });
  r.addEventListener('change', () => { const d = engine.el.duration || 0; engine.el.currentTime = r.value / 1000 * d; seeking = false; if (P.lyrics?.lines) syncLyrics(engine.el.currentTime, true); });
}
bindSeek('#p-seek'); bindSeek('#now-seek');
$('#p-vol').addEventListener('input', e => { const v = e.target.value / 100; engine.setVolume(v); paintRange(e.target); S.settings.volume = v; clearTimeout(e.target._t); e.target._t = setTimeout(() => kv.set('settings', S.settings), 300); $('#vol-icon use').setAttribute('href', v === 0 ? '#i-mute' : '#i-vol'); });

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || t.category || '', artwork: [{ src: artOf(t, 'full'), sizes: '1200x1200' }] }); } catch {}
  const h = { play: () => engine.el.play(), pause: () => engine.el.pause(), previoustrack: prev, nexttrack: () => next(), seekto: e => { engine.el.currentTime = e.seekTime; }, seekbackward: e => { engine.el.currentTime -= e.seekOffset || 10; }, seekforward: e => { engine.el.currentTime += e.seekOffset || 10; } };
  for (const [k, f] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, f); } catch {} }
}

/* sleep timer & speed */
function clearSleep() { P.sleepAt = 0; P.sleepEnd = false; $('#sleep-btn').classList.remove('on'); $('#sleep-btn span').textContent = 'Sleep'; }
function sleepMenu(e) {
  menu(e, [
    ['15 minutes', () => setSleep(15)], ['30 minutes', () => setSleep(30)], ['45 minutes', () => setSleep(45)], ['1 hour', () => setSleep(60)],
    ['End of this song', () => { clearSleep(); P.sleepEnd = true; $('#sleep-btn').classList.add('on'); $('#sleep-btn span').textContent = 'End of song'; }],
    ...(P.sleepAt || P.sleepEnd ? [null, ['Turn off sleep timer', clearSleep]] : []),
  ]);
}
function setSleep(m) { P.sleepEnd = false; P.sleepAt = Date.now() + m * 60000; $('#sleep-btn').classList.add('on'); toast(`Music stops in ${m < 60 ? m + ' minutes' : '1 hour'}`); }
const SPEEDS = [1, 1.25, 1.5, 2, .75];
function cycleSpeed() { P.speed = SPEEDS[(SPEEDS.indexOf(P.speed) + 1) % SPEEDS.length]; engine.setRate(P.speed); $('#speed-btn').textContent = P.speed + '×'; $('#speed-btn').classList.toggle('on', P.speed !== 1); }

/* =====================================================================
   Now playing: lyrics and queue
   ===================================================================== */
function openNow(panel) {
  if (!current()) return;
  const n = $('#now'); n.classList.add('open'); n.setAttribute('aria-hidden', 'false');
  if (panel) { P.panel = panel; n.classList.add('panel-open'); } else if (innerWidth <= 820) n.classList.remove('panel-open');
  history.pushState({ now: true }, ''); P.nowState = true;
  renderPanel();
}
function closeNow(fromPop) {
  const n = $('#now'); if (!n.classList.contains('open')) return;
  n.classList.remove('open', 'panel-open', 'lyrics-full'); n.setAttribute('aria-hidden', 'true');
  if (!fromPop && P.nowState) { P.nowState = false; history.back(); }
}
window.addEventListener('popstate', () => { if ($('#now').classList.contains('open')) { P.nowState = false; closeNow(true); } });
function setPanelTabs() {
  const show = $('#now').classList.contains('panel-open') || innerWidth > 820;
  $('#tab-lyrics').classList.toggle('on', show && P.panel === 'lyrics');
  $('#tab-queue').classList.toggle('on', show && P.panel === 'queue');
}
async function renderPanel() {
  setPanelTabs();
  const box = $('#now-panel');
  $('#lyrics-expand').hidden = P.panel !== 'lyrics';
  if (P.panel === 'queue') { $('#lyrics-return').hidden = true; return renderQueue(); }
  const t = current(); if (!t) return;
  if (!P.lyrics || P.lyrics.id !== t.id) {
    box.innerHTML = `<div class="lyrics-skel">${'<i></i>'.repeat(6)}</div>`;
    let l = await db.get('lyrics', t.id);
    if (!l) { l = await meta.findLyrics(t); if (l) db.put('lyrics', t.id, l); else l = { none: true, offline: !navigator.onLine }; }
    if (current()?.id !== t.id || P.panel !== 'lyrics') return;
    P.lyrics = { id: t.id, lines: l.synced ? meta.parseLrc(l.synced) : null, plain: l.plain, none: l.none, offline: l.offline };
    P.lyricLine = -1;
  }
  if (P.lyrics.lines?.length) box.innerHTML = `<div class="lyrics" id="lyrics">${P.lyrics.lines.map((x, i) => `<p data-t="${x.t}" data-i="${i}">${esc(x.text) || '♪'}</p>`).join('')}<div class="lyrics-credit">Lyrics from LRCLIB</div></div>`;
  else if (P.lyrics.plain) box.innerHTML = `<div class="lyrics plain">${P.lyrics.plain.split('\n').map(l => `<p>${esc(l) || '&nbsp;'}</p>`).join('')}<div class="lyrics-credit">Lyrics from LRCLIB · not time-synced</div></div>`;
  else box.innerHTML = `<div class="lyrics-empty"><h2>No lyrics</h2><p>${P.lyrics.offline ? 'You’re offline. Lyrics load when you’re back online.' : t.category !== 'Music' ? 'Lyrics are only looked up for music.' : 'LRCLIB doesn’t have lyrics for this song.'}</p></div>`;
  $('#lyrics-return').hidden = true;
  if (P.lyrics.lines) syncLyrics(engine.el.currentTime, true);
}
function syncLyrics(c, force) {
  const L = P.lyrics.lines; let i = -1;
  for (let k = 0; k < L.length; k++) { if (L[k].t <= c + .3) i = k; else break; }
  if (i === P.lyricLine && !force) return;
  P.lyricLine = i;
  const box = $('#lyrics'); if (!box) return;
  box.querySelector('p.on')?.classList.remove('on');
  const p = box.querySelector(`p[data-i="${i}"]`);
  if (p) { p.classList.add('on'); if (P.follow) { P.autoScrolling = true; p.scrollIntoView({ block: 'center', behavior: force || S.settings.reduceMotion ? 'auto' : 'smooth' }); setTimeout(() => { P.autoScrolling = false; }, 700); } }
}
['wheel', 'touchmove'].forEach(ev => $('#now-panel').addEventListener(ev, () => { if (P.panel === 'lyrics' && P.lyrics?.lines) { P.follow = false; $('#lyrics-return').hidden = false; } }, { passive: true }));

function renderQueue() {
  const box = $('#now-panel');
  const t = current();
  const row = (id, i, drag) => { const x = S.tracks.get(id); if (!x) return ''; return `<div class="track q" data-qi="${i}" data-id="${id}">${drag ? '<div class="handle" aria-label="Drag to reorder"><svg><use href="#i-grip"/></svg></div>' : '<div></div>'}<div class="th"><img loading="lazy" src="${artOf(x)}" alt=""></div><div class="tmain"><div class="tt ellipsis">${esc(x.title)}</div><div class="ta ellipsis">${esc(x.artist)}</div></div><div class="td">${fmt(x.duration)}</div>${drag ? `<button class="icon-btn small" data-action="queue-remove" data-qi="${i}" aria-label="Remove"><svg><use href="#i-x"/></svg></button>` : '<div></div>'}</div>`; };
  const up = P.queue.slice(P.idx + 1).map((id, k) => [id, P.idx + 1 + k]);
  const mine = up.filter(([id]) => !P.autoAdded.has(id)), auto = up.filter(([id]) => P.autoAdded.has(id));
  const hist = P.played.slice(0, -1).slice(-20).reverse();
  box.innerHTML = `<div class="queue-panel">
    ${t ? `<h3>Now playing</h3>${row(t.id, P.idx, false).replace('class="track q"', 'class="track q playing"')}` : ''}
    <div class="q-head"><h3>Up next${P.context && P.mode !== 'flow' ? ' · ' + esc(P.context) : ''}</h3><div class="q-tools">${mine.length ? '<button class="link" data-action="queue-clear">Clear</button>' : ''}<button class="link" data-action="queue-save">Save as playlist</button></div></div>
    <div class="q-list" data-sortable="queue">${mine.map(([id, i]) => row(id, i, true)).join('') || '<p class="q-empty">Nothing queued. Use Play next or Add to queue on any song.</p>'}</div>
    <div class="autoplay-row"><div><b>${P.mode === 'flow' ? 'Cadence Flow' : P.mode === 'radio' ? 'Radio' : 'Autoplay'}</b><span>${P.mode ? 'Keeps adding songs from your library' : 'Similar songs from your library keep playing when this ends'}</span></div>${P.mode ? `<button class="link" data-action="end-mode">Stop</button>` : `<button class="switch ${S.settings.autoplay ? 'on' : ''}" data-action="toggle-setting" data-key="autoplay" aria-label="Autoplay"></button>`}</div>
    ${auto.length ? `<div class="q-list" data-sortable="queue">${auto.map(([id, i]) => row(id, i, true)).join('')}</div>` : ''}
    ${hist.length ? `<details class="q-hist"><summary>History</summary>${hist.map(id => { const x = S.tracks.get(id); return x ? `<div class="track q" data-id="${id}" data-hist="1"><div></div><div class="th"><img loading="lazy" src="${artOf(x)}" alt=""></div><div class="tmain"><div class="tt ellipsis">${esc(x.title)}</div><div class="ta ellipsis">${esc(x.artist)}</div></div><div class="td">${fmt(x.duration)}</div><div></div></div>` : ''; }).join('')}</details>` : ''}
  </div>`;
  $$('#now-panel [data-sortable]').forEach(el => makeSortable(el, 'queue'));
}

/** Drag to reorder (mouse and touch) using the grip handle. */
function makeSortable(list, scope) {
  if (list._sortable) return; list._sortable = true;
  list.addEventListener('pointerdown', e => {
    const h = e.target.closest('.handle'); if (!h) return;
    const row = h.closest('.track'); if (!row) return;
    e.preventDefault();
    row.classList.add('dragging'); list.classList.add('sorting');
    const move = ev => {
      const rows = [...list.querySelectorAll('.track:not(.dragging)')];
      const after = rows.find(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
      if (after) list.insertBefore(row, after); else list.appendChild(row);
      const sc = list.closest('#now-panel') || $('#main'); const b = sc.getBoundingClientRect();
      if (ev.clientY < b.top + 50) sc.scrollTop -= 12; else if (ev.clientY > b.bottom - 50) sc.scrollTop += 12;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      row.classList.remove('dragging'); list.classList.remove('sorting');
      S.justDragged = Date.now();
      finishSort(scope, list);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });
}
function finishSort(scope, list) {
  if (scope === 'queue') {
    const head = P.queue.slice(0, P.idx + 1);
    const ids = $$('#now-panel .q-list .track').map(r => r.dataset.id);
    const rest = P.queue.slice(P.idx + 1).filter(id => !ids.includes(id));
    P.queue = [...head, ...ids, ...rest]; savePlayer(); renderQueue();
  } else if (scope.startsWith('pl:')) {
    const p = S.playlists.get(scope.slice(3)); if (!p) return;
    p.tracks = [...list.querySelectorAll('.track')].map(r => r.dataset.id);
    savePlaylist(p); render();
  }
}

/* =====================================================================
   Menus & sheets
   ===================================================================== */
function menu(e, items) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => it === null ? '<hr>' : `<button role="menuitem" data-mi="${i}" class="${it[2] || ''}">${esc(it[0])}</button>`).join('');
  document.body.appendChild(m);
  const anchor = e?.target?.closest?.('button,.track') || e?.target;
  const r = anchor?.getBoundingClientRect?.() || { left: innerWidth / 2, bottom: innerHeight / 2, top: innerHeight / 2, right: innerWidth / 2 };
  const w = m.offsetWidth, h = m.offsetHeight;
  let x = Math.min(r.right - w, innerWidth - w - 10), y = r.bottom + 6;
  if (x < 10) x = Math.min(r.left, innerWidth - w - 10);
  if (y + h > innerHeight - 10) y = Math.max(10, r.top - h - 6);
  m.style.left = Math.max(10, x) + 'px'; m.style.top = y + 'px';
  m.querySelector('button')?.focus({ preventScroll: true });
  m.addEventListener('click', ev => { const b = ev.target.closest('[data-mi]'); if (!b) return; ev.stopPropagation(); closeMenus(); items[+b.dataset.mi][1](); });
  m.addEventListener('keydown', ev => { const bs = [...m.querySelectorAll('button')]; const i = bs.indexOf(document.activeElement); if (ev.key === 'ArrowDown') { ev.preventDefault(); bs[(i + 1) % bs.length].focus(); } if (ev.key === 'ArrowUp') { ev.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); } });
}
document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeMenus(); }, true);
function closeMenus() { $$('.menu').forEach(m => m.remove()); }
function sheet(html, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const bd = root.firstElementChild;
  bd.addEventListener('click', e => { if (e.target === bd || e.target.closest('[data-close]')) closeSheet(); });
  onMount?.(bd.firstElementChild);
  if (!('ontouchstart' in window)) bd.querySelector('input:not([type=file])')?.focus();
}
function closeSheet() { $('#sheet-root').innerHTML = ''; }
function confirmSheet(title, body, okLabel, onOk, danger = true) {
  sheet(`<h2>${esc(title)}</h2><p class="muted">${esc(body)}</p><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok">${esc(okLabel)}</button></div>`, el => { el.querySelector('#cf-ok').onclick = async () => { closeSheet(); await onOk(); }; });
}

function trackMenu(e, id) {
  const t = S.tracks.get(id); if (!t) return;
  menu(e, [
    ['Play next', () => { insertNext([id]); toast('Plays next'); }],
    ['Add to queue', () => { addQueue([id]); toast('Added to queue'); }],
    ['Add to playlist…', () => addToPlaylistSheet([id])],
    ['Song radio', () => radio(id)],
    null,
    ['Go to artist', () => go('artist/' + mainArtist(t.artist))],
    ...(t.album ? [['Go to album', () => go('album/' + t.album + '\u0001' + albumArtist(t))]] : []),
    ...(S.route === 'playlist' ? [['Remove from this playlist', () => removeFromPlaylist(S.param, id)]] : []),
    null,
    ['Edit info', () => editSheet(id)],
    [t.liked ? 'Remove from Liked Songs' : 'Like', () => like(id)],
    ['Remove from library', () => confirmDelete(id), 'danger'],
  ]);
}
function insertNext(ids) { if (!current()) return playList(ids); P.queue.splice(P.idx + 1, 0, ...ids); ids.forEach(id => P.autoAdded.delete(id)); savePlayer(); P.preloadFor = null; if (P.panel === 'queue') renderQueue(); }
function addQueue(ids) { if (!current()) return playList(ids); const fa = P.queue.findIndex((id, i) => i > P.idx && P.autoAdded.has(id)); P.queue.splice(fa < 0 ? P.queue.length : fa, 0, ...ids); P.preloadFor = null; savePlayer(); if (P.panel === 'queue') renderQueue(); }
function radio(id) { const t = S.tracks.get(id); if (!t) return; P.shuffle = false; playList([id, ...similar(t, 20)], 0, { context: `${t.title} Radio`, mode: 'radio', seed: id }); toast(`${t.title} Radio · from your library`); }
function flow() { const ids = flowPicks(20); if (!ids.length) return toast('Add some music first'); P.shuffle = false; playList(ids, 0, { context: 'Cadence Flow', mode: 'flow' }); toast('Cadence Flow · endless music from your library'); }

async function like(id) {
  const t = S.tracks.get(id); if (!t) return;
  t.liked = !t.liked; t.likedAt = t.liked ? Date.now() : 0;
  await saveTrack(t);
  $$(`.like-btn[data-id="${id}"]`).forEach(b => b.classList.toggle('on', t.liked));
  if (current()?.id === id) ['#p-like', '#now-like'].forEach(s => $(s).classList.toggle('on', t.liked));
  toast(t.liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
  if (S.route === 'liked') render();
}

function addToPlaylistSheet(ids) {
  const pls = [...S.playlists.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  sheet(`<h2>Add to playlist</h2>
    <div class="inline-form"><input class="input" id="new-pl" placeholder="New playlist name"><button class="btn primary" id="new-pl-go">Create</button></div>
    <div class="pl-pick">${pls.map(p => `<button class="pl-opt" data-pl-add="${p.id}"><span class="pl-thumb">${S.plCovers.get(p.id) ? `<img src="${S.plCovers.get(p.id)}" alt="">` : collageHtml(p.tracks.map(id => S.tracks.get(id)).filter(Boolean))}</span><span class="ellipsis">${esc(p.name)}</span><span class="muted">${p.tracks.length}</span></button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button></div>`, el => {
    const create = async () => { const name = el.querySelector('#new-pl').value.trim(); if (!name) return; const p = { id: uid(), name, tracks: [...new Set(ids)], createdAt: Date.now() }; await savePlaylist(p); closeSheet(); toast(`Added to ${name}`, ['Open', () => go('playlist/' + p.id)]); };
    el.querySelector('#new-pl-go').onclick = create;
    el.querySelector('#new-pl').onkeydown = e => { if (e.key === 'Enter') create(); };
    el.querySelectorAll('[data-pl-add]').forEach(b => b.onclick = async () => { const p = S.playlists.get(b.dataset.plAdd); const fresh = ids.filter(id => !p.tracks.includes(id)); p.tracks.push(...fresh); await savePlaylist(p); closeSheet(); toast(fresh.length ? `Added to ${p.name}` : `Already in ${p.name}`); if (S.route === 'playlist' && S.param === p.id) render(); });
  });
}
function addSongsSheet(pid) {
  const p = S.playlists.get(pid);
  const draw = (el, q) => {
    const list = q ? S.index.search(q, 80).filter(r => r.kind === 'song').map(r => S.tracks.get(r.key)).filter(Boolean) : visible().sort(byAdded).slice(0, 60);
    el.querySelector('#as-list').innerHTML = list.map(t => `<div class="as-row"><img src="${artOf(t)}" alt=""><div class="ellipsis"><b class="ellipsis">${esc(t.title)}</b><span class="muted ellipsis">${esc(t.artist)}</span></div><button class="btn small ${p.tracks.includes(t.id) ? 'added' : ''}" data-as="${t.id}">${p.tracks.includes(t.id) ? 'Added' : 'Add'}</button></div>`).join('') || '<p class="muted">No matches</p>';
  };
  sheet(`<h2>Add to ${esc(p.name)}</h2><div class="filter-box wide"><svg><use href="#i-search"/></svg><input class="input" id="as-q" placeholder="Search your library"></div><div id="as-list" class="as-list"></div><div class="actions"><button class="btn primary" data-close>Done</button></div>`, el => {
    draw(el, '');
    el.querySelector('#as-q').oninput = e => draw(el, e.target.value);
    el.querySelector('#as-list').onclick = async e => { const b = e.target.closest('[data-as]'); if (!b) return; const id = b.dataset.as; if (p.tracks.includes(id)) p.tracks = p.tracks.filter(x => x !== id); else p.tracks.push(id); await savePlaylist(p); b.classList.toggle('added', p.tracks.includes(id)); b.textContent = p.tracks.includes(id) ? 'Added' : 'Add'; };
  });
  const obs = new MutationObserver(() => { if (!$('#sheet-root').children.length) { obs.disconnect(); if (S.route === 'playlist') render(); } });
  obs.observe($('#sheet-root'), { childList: true });
}
async function removeFromPlaylist(pid, id) { const p = S.playlists.get(pid); const i = p.tracks.indexOf(id); p.tracks = p.tracks.filter(x => x !== id); await savePlaylist(p); render(); toast('Removed from playlist', ['Undo', async () => { p.tracks.splice(i, 0, id); await savePlaylist(p); render(); }]); }
function newPlaylist(ids = []) {
  sheet(`<h2>New playlist</h2><input class="input full" id="pl-name" placeholder="Playlist name"><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pl-create">Create</button></div>`, el => {
    const go_ = async () => { const name = el.querySelector('#pl-name').value.trim(); if (!name) return; const p = { id: uid(), name, tracks: ids, createdAt: Date.now() }; await savePlaylist(p); closeSheet(); go('playlist/' + p.id); };
    el.querySelector('#pl-create').onclick = go_; el.querySelector('#pl-name').onkeydown = e => { if (e.key === 'Enter') go_(); };
  });
}
function playlistMenu(e, pid) {
  const p = S.playlists.get(pid);
  menu(e, [
    ['Rename', () => sheet(`<h2>Rename playlist</h2><input class="input full" id="pl-name" value="${esc(p.name)}"><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pl-save">Save</button></div>`, el => { const save = async () => { p.name = el.querySelector('#pl-name').value.trim() || p.name; await savePlaylist(p); closeSheet(); render(); }; el.querySelector('#pl-save').onclick = save; el.querySelector('#pl-name').onkeydown = ev => { if (ev.key === 'Enter') save(); }; })],
    ['Change cover…', () => pickImage(async f => { const b = await thumbnail(f, 800) || f; await db.put('art', 'pl:' + p.id, b); swapUrl(S.plCovers, p.id, b); p.cover = true; await savePlaylist(p); if (S.user) cloud.uploadFile('art/pl-' + p.id, b).catch(syncFailed); render(); })],
    ...(p.cover ? [['Use song artwork as cover', async () => { await db.del('art', 'pl:' + p.id); S.plCovers.delete(p.id); p.cover = false; await savePlaylist(p); render(); }]] : []),
    ['Playlist radio', () => { const ts = p.tracks.map(id => S.tracks.get(id)).filter(Boolean); if (!ts.length) return; P.shuffle = false; const base = shuffleArr(p.tracks); playList([...base, ...similar(ts.slice(0, 10), 15, new Set(base))], 0, { context: `${p.name} Radio`, mode: 'radio', seed: base[0] }); toast(`${p.name} Radio · your playlist plus similar songs from your library`); }],
    ['Duplicate', async () => { const c = { ...p, id: uid(), name: p.name + ' copy', tracks: [...p.tracks], cover: false, createdAt: Date.now() }; await savePlaylist(c); go('playlist/' + c.id); }],
    null,
    ['Delete playlist', () => confirmSheet(`Delete “${p.name}”?`, 'The songs stay in your library.', 'Delete', async () => { S.playlists.delete(pid); await db.del('playlists', pid); await db.del('art', 'pl:' + pid); S.plCovers.delete(pid); if (S.user) cloud.deletePlaylist(pid).catch(syncFailed); renderSidebar(); go('library'); }), 'danger'],
  ]);
}
function pickImage(cb) { const inp = $('#art-input'); inp.value = ''; inp.onchange = () => { const f = inp.files[0]; if (f) cb(f); }; inp.click(); }
function renderSidebar() {
  $('#sidebar-playlists').innerHTML = [...S.playlists.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => `<a class="nav-link pl-link" data-pl="${p.id}" href="#/playlist/${p.id}"><span class="pl-dot">${S.plCovers.get(p.id) ? `<img src="${S.plCovers.get(p.id)}" alt="">` : ''}</span><span class="ellipsis">${esc(p.name)}</span></a>`).join('') || '<p class="side-empty">Create a playlist with the + button.</p>';
}

function editSheet(id) {
  const t = S.tracks.get(id);
  let newArt = null;
  const cats = ['Music', 'Quran & Recitation', 'Nasheeds', 'Talks & Lectures'];
  const f = (k, l, v, extra = '') => `<label class="field"><span>${l}</span><input class="input" id="ed-${k}" value="${esc(v || '')}" ${extra}></label>`;
  sheet(`<h2>Edit info</h2>
    <div class="edit-art"><div class="coll-art small"><img id="ed-art" src="${artOf(t, 'full')}" alt=""></div>
      <div class="edit-art-btns"><button class="btn small" id="ed-find">Find artwork & details</button><button class="btn small ghost" id="ed-upload">Use my own image</button><button class="btn small ghost" id="ed-design">Use a plain cover</button></div></div>
    ${f('title', 'Title', t.title)}${f('artist', 'Artist', t.artist)}
    <div class="two">${f('album', 'Album', t.album)}${f('albumArtist', 'Album artist', t.albumArtist, 'placeholder="Same as artist"')}</div>
    <div class="three">${f('genre', 'Genre', t.genre)}${f('year', 'Year', t.year, 'inputmode="numeric"')}${f('trackNo', 'Track #', t.trackNo, 'inputmode="numeric"')}</div>
    <label class="field"><span>Type</span><select class="input" id="ed-cat">${cats.map(c => `<option ${c === t.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <p class="fine">File: ${esc(t.file || '')}</p>
    <div class="actions">${t.original?.title ? '<button class="btn ghost small left" id="ed-restore">Restore original details</button>' : ''}<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ed-save">Save</button></div>`, el => {
    const v = k => el.querySelector('#ed-' + k);
    v('find').onclick = async () => {
      v('find').disabled = true; v('find').textContent = 'Looking…';
      const found = await meta.lookup({ title: v('title').value, artist: v('artist').value, duration: t.duration });
      v('find').disabled = false; v('find').textContent = 'Find artwork & details';
      if (!found) return toast(navigator.onLine ? 'No match found. Try fixing the title or artist first.' : 'You’re offline');
      v('title').value = found.title; v('artist').value = found.artist; v('album').value = found.album; v('genre').value = found.genre || v('genre').value; v('year').value = found.year || v('year').value;
      try { newArt = await meta.fetchImage(found.artUrl); v('art').src = URL.createObjectURL(newArt); } catch {}
    };
    v('upload').onclick = () => pickImage(file => { newArt = file; v('art').src = URL.createObjectURL(file); });
    v('design').onclick = async () => { newArt = await meta.makeCover(v('title').value, v('artist').value, v('cat').value); v('art').src = URL.createObjectURL(newArt); };
    if (v('restore')) v('restore').onclick = () => { const o = t.original; v('title').value = o.title || t.title; v('artist').value = o.artist || t.artist; v('album').value = o.album || ''; v('genre').value = o.genre || ''; toast('Original details filled in. Save to keep them.'); };
    v('save').onclick = async () => {
      const prev = { title: t.title, artist: t.artist, album: t.album, genre: t.genre };
      Object.assign(t, { title: v('title').value.trim() || t.title, artist: v('artist').value.trim() || 'Unknown Artist', album: v('album').value.trim(), albumArtist: v('albumArtist').value.trim(), genre: v('genre').value.trim(), year: v('year').value.trim(), trackNo: v('trackNo').value.trim(), category: v('cat').value, edited: true });
      t.edits = [...(t.edits || []), { at: Date.now(), before: prev }].slice(-10);
      await db.del('lyrics', t.id);
      if (newArt) { await setArt(t, newArt); t.designedCover = false; if (S.user && t.cloud) cloud.uploadFile('art/' + t.id, newArt).catch(syncFailed); }
      S.ver++; await saveTrack(t);
      closeSheet(); render(); if (current()?.id === t.id) { paintNow(t); updateMediaSession(t); P.lyrics = null; }
      toast('Saved');
    };
  });
}
async function removeLocal(id) {
  S.tracks.delete(id); S.ver++; S.indexDirty = true;
  await Promise.all(['tracks', 'audio', 'art', 'thumbs', 'lyrics'].map(s => db.del(s, id)));
  for (const m of [S.art, S.thumbs]) { const u = m.get(id); if (u?.startsWith('blob:')) URL.revokeObjectURL(u); m.delete(id); }
}
function confirmDelete(id) {
  const t = S.tracks.get(id);
  confirmSheet(`Remove “${t.title}”?`, `It’s removed from Cadence${S.user && t.cloud ? ' on all your devices' : ''}. The original file on your computer is not touched.`, 'Remove', async () => {
    await removeLocal(id);
    for (const p of S.playlists.values()) if (p.tracks.includes(id)) { p.tracks = p.tracks.filter(x => x !== id); savePlaylist(p); }
    if (S.user && t.cloud) cloud.deleteTrack(id).catch(syncFailed);
    const qi = P.queue.indexOf(id);
    if (qi >= 0) { P.queue.splice(qi, 1); if (qi < P.idx) P.idx--; else if (qi === P.idx) { engine.el.pause(); P.idx = Math.min(P.idx, P.queue.length - 1); if (P.queue.length) loadTrack(P.queue[P.idx], { autoplay: false }); } savePlayer(); }
    render(); toast('Removed from your library');
  });
}
/** The song's details as they were in the file, before any clean-up or lookup. */
async function originalOf(t) {
  if (t.original?.file || t.original?.title) return { ...t.original, file: t.original.file || t.file };
  const blob = t.local ? await db.get('audio', t.id) : null;
  const tags = blob ? await meta.readTags(blob) : {};
  t.original = { title: tags.title || '', artist: tags.artist || '', album: tags.album || '', genre: tags.genre || '', file: t.file || '' };
  return t.original;
}
async function fileArt(t) {
  const blob = t.local ? await db.get('audio', t.id) : null;
  if (blob) { const tags = await meta.readTags(blob); if (tags.picture?.size > 2000) return tags.picture; }
  return null;
}
/**
 * Re-checks one song from its original file details. Applies a lookup only when it passes the strict
 * artist + title + length checks; otherwise puts back the cleaned-up file details and the file's own artwork.
 */
async function rematch(t, { online = navigator.onLine } = {}) {
  const o = await originalOf(t);
  const reliable = meta.isReliable(o);
  const base = reliable ? { title: o.title, artist: o.artist, album: o.album } : meta.cleanNames(o, o.file || t.file || '');
  const found = online && meta.categorize({ ...t, ...base }) === 'Music' ? await meta.lookup({ ...base, duration: t.duration }) : null;
  let art = null;
  if (found) {
    Object.assign(t, reliable ? base : { title: found.title, artist: found.artist, album: found.album || base.album });
    Object.assign(t, { genre: o.genre || found.genre || '', year: found.year || t.year, explicit: found.explicit, matched: true });
    art = await fileArt(t);
    if (!art || !reliable) try { art = await meta.fetchImage(found.artUrl); } catch {}
  } else {
    Object.assign(t, base, { genre: o.genre || '', year: reliable ? t.year : '', explicit: undefined, matched: false });
    art = await fileArt(t);
  }
  t.category = meta.categorize(t);
  t.designedCover = !art;
  if (!art) art = await meta.makeCover(t.title, t.artist, t.category);
  await setArt(t, art); await db.del('lyrics', t.id);
  if (S.user && t.cloud) cloud.uploadFile('art/' + t.id, art).catch(syncFailed);
  await saveTrack(t);
  if (current()?.id === t.id) { paintNow(t); updateMediaSession(t); P.lyrics = null; }
  return !!found;
}
/** One-time repair: songs that an older, looser lookup gave the wrong artist or artwork. */
async function repairMatches() {
  if (await kv.get('repair-v2')) return;
  const bad = [];
  for (const t of S.tracks.values()) {
    if (!t.matched || t.edited) continue;
    const o = await originalOf(t);
    if (meta.isReliable(o)) continue;
    const base = meta.cleanNames(o, o.file || t.file || '');
    if (meta.wrongArtist(base.artist, t.artist)) bad.push(t);
  }
  for (const t of bad) await rematch(t);
  await kv.set('repair-v2', true);
  if (bad.length) { S.ver++; render(); toast(`Fixed ${count(bad.length)} that had the wrong artist or artwork`); }
}
async function refixAll() {
  const ts = [...S.tracks.values()].filter(t => !t.edited);
  if (!navigator.onLine) return toast('You’re offline');
  toast(`Checking ${count(ts.length)}…`);
  let matched = 0;
  for (const t of ts) if (await rematch(t)) matched++;
  S.ver++; render(); toast(`Done · ${matched} matched to the right song, the rest keep their own details`);
}
async function uploadLocal() {
  const ts = [...S.tracks.values()].filter(t => t.local && !t.cloud);
  let n = 0; toast(`Uploading ${count(ts.length)}…`);
  for (const t of ts) { try { const a = await db.get('audio', t.id); const art = await db.get('art', t.id); if (a) { await uploadTrack(t, a, art); n++; } } catch (e) { syncFailed(e); break; } }
  toast(`Uploaded ${count(n)}`); render();
}
function exportData() {
  const data = { exportedAt: new Date().toISOString(), app: 'Cadence', songs: [...S.tracks.values()].map(({ colors, ...t }) => t), playlists: [...S.playlists.values()], listeningLog: S.log, recentlyPlayed: S.history, settings: S.settings };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `cadence-export-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* =====================================================================
   Events
   ===================================================================== */
document.addEventListener('click', async e => {
  if (S.justDragged && Date.now() - S.justDragged < 300) return;
  const a = e.target.closest('[data-action]');
  const playBtn = e.target.closest('[data-play-list]');
  const href = e.target.closest('[data-href]');
  if (e.target.closest('a[href^="#/"]') && !a) { if (e.target.closest('#now')) closeNow(); S.freshNav = true; return; }
  if (a) {
    if (a.tagName !== 'INPUT') e.preventDefault();
    e.stopPropagation();
    const id = a.dataset.id;
    switch (a.dataset.action) {
      case 'noop': return;
      case 'toggle': return toggle();
      case 'next': return next();
      case 'prev': return prev();
      case 'shuffle': {
        P.shuffle = !P.shuffle;
        if (P.queue.length) { const rest = P.queue.slice(P.idx + 1); P.queue = [...P.queue.slice(0, P.idx + 1), ...(P.shuffle ? shuffleArr(rest) : rest)]; P.preloadFor = null; }
        updateModes(); savePlayer(); if (P.panel === 'queue' && $('#now').classList.contains('open')) renderQueue();
        return toast(P.shuffle ? 'Shuffle on' : 'Shuffle off');
      }
      case 'repeat': P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; P.preloadFor = null; updateModes(); savePlayer(); return toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat this song' }[P.repeat]);
      case 'like': return like(id);
      case 'like-current': return current() && like(current().id);
      case 'track-menu': return trackMenu(e, id);
      case 'track-menu-current': return current() && trackMenu(e, current().id);
      case 'open-now': return openNow();
      case 'close-now': return closeNow();
      case 'open-lyrics': return openNow('lyrics');
      case 'open-queue': return openNow('queue');
      case 'tab-lyrics': case 'tab-queue': {
        const p = a.dataset.action.slice(4); const n = $('#now');
        if (innerWidth <= 820 && n.classList.contains('panel-open') && P.panel === p) n.classList.remove('panel-open'); else { P.panel = p; n.classList.add('panel-open'); }
        if (p === 'queue') n.classList.remove('lyrics-full');
        return renderPanel();
      }
      case 'lyrics-full': return $('#now').classList.toggle('lyrics-full');
      case 'lyrics-return': P.follow = true; $('#lyrics-return').hidden = true; return syncLyrics(engine.el.currentTime, true);
      case 'queue-remove': { const i = +a.dataset.qi; const [rm] = P.queue.splice(i, 1); P.autoAdded.delete(rm); P.preloadFor = null; savePlayer(); return renderQueue(); }
      case 'queue-clear': P.queue = [...P.queue.slice(0, P.idx + 1), ...P.queue.slice(P.idx + 1).filter(id => P.autoAdded.has(id))]; P.preloadFor = null; savePlayer(); return renderQueue();
      case 'queue-save': { const ids = [...new Set(P.queue.slice(Math.max(0, P.idx)))]; return ids.length ? newPlaylist(ids) : null; }
      case 'end-mode': P.mode = null; P.queue = P.queue.filter((qid, i) => i <= P.idx || !P.autoAdded.has(qid)); P.autoAdded = new Set(); savePlayer(); return renderQueue();
      case 'speed': return cycleSpeed();
      case 'sleep': return sleepMenu(e);
      case 'radio': return radio(id);
      case 'flow': return flow();
      case 'radio-artist': { const ts = groups('artist').get(a.dataset.name) || []; if (!ts.length) return; P.shuffle = false; const seed = ts[Math.floor(Math.random() * ts.length)]; playList([...shuffleArr(ts.map(t => t.id)).slice(0, 6), ...similar(ts, 20, new Set(ts.map(t => t.id)))], 0, { context: `${a.dataset.name} Radio`, mode: 'radio', seed: seed.id }); return toast(`${a.dataset.name} Radio · from your library`); }
      case 'play-one': return playList([id], 0, { context: 'Duplicates' });
      case 'new-playlist': return newPlaylist();
      case 'playlist-menu': return playlistMenu(e, a.dataset.pl);
      case 'pl-add-songs': return addSongsSheet(a.dataset.pl);
      case 'pl-sort': { const p = S.playlists.get(a.dataset.pl); p.sort = a.dataset.sort; await savePlaylist(p); return render(); }
      case 'add-all': return addToPlaylistSheet(a.dataset.listIds.split(','));
      case 'save-list': return newPlaylist(a.dataset.listIds.split(','));
      case 'pick-folder': { const i = $('#folder-input'); i.value = ''; return i.click(); }
      case 'pick-files': { const i = $('#file-input'); i.value = ''; return i.click(); }
      case 'imp-cancel': IMP.cancel = true; return toast('Stopping after the songs in progress…');
      case 'imp-retry': return importFiles(IMP.jobs.filter(j => j.state === 'error').map(j => j.file), { retry: true });
      case 'imp-clear': IMP.jobs = []; return render();
      case 'sort-col': { const k = a.dataset.sort; if (S.settings.songSort === k) S.settings.songDir *= -1; else { S.settings.songSort = k; S.settings.songDir = ['title', 'artist', 'album'].includes(k) ? 1 : -1; } await saveSettings(); return render(); }
      case 'toggle-setting': S.settings[a.dataset.key] = !S.settings[a.dataset.key]; a.classList.toggle('on', S.settings[a.dataset.key]); S.settingsAt = Date.now(); kv.set('settingsAt', S.settingsAt); await saveSettings(); if (['hideExplicit'].includes(a.dataset.key)) { S.ver++; S.indexDirty = true; render(); } return;
      case 'set': S.settings[a.dataset.key] = a.dataset.val; S.settingsAt = Date.now(); kv.set('settingsAt', S.settingsAt); await saveSettings(); return render();
      case 'back': return history.length > 1 ? history.back() : go('home');
      case 'clear-searches': S.searches = []; kv.set('searches', []); return render();
      case 'clear-q': go('search'); return;
      case 'apply-update': return applyUpdate();
      case 'check-update': { await checkVersion(); if (!$('#update-bar').classList.contains('show')) toast('You’re on the newest version'); return; }
      case 'refix-all': return refixAll();
      case 'upload-local': return uploadLocal();
      case 'dup-remove': return confirmDelete(id);
      case 'dup-ignore': S.dupIgnore.push(a.dataset.key); kv.set('dupIgnore', S.dupIgnore); queueStatePush(); return render();
      case 'clear-device': return confirmSheet('Remove downloads?', 'Songs stay in your cloud library and stream when you play them.', 'Remove', async () => { for (const t of S.tracks.values()) if (t.cloud && t.local) { await db.del('audio', t.id); t.local = false; await saveTrack(t, { sync: false }); } render(); }, false);
      case 'clear-history': return confirmSheet('Clear listening history?', 'Recently Played, Insights and Late Night start fresh. Play counts on songs stay.', 'Clear', async () => { S.log = []; S.history = []; S.ctxs = []; await Promise.all([kv.set('log', []), kv.set('history', []), kv.set('ctxs', [])]); queueStatePush(); render(); });
      case 'export': return exportData();
      case 'wipe-device': return confirmSheet('Delete everything on this device?', 'All songs, artwork, playlists and history saved in this browser are removed. Your cloud library (if you’re signed in) is not affected.', 'Delete everything', async () => { engine.el.pause(); for (const s of ['tracks', 'audio', 'art', 'thumbs', 'lyrics', 'playlists', 'kv']) await db.clear(s); location.hash = '#/home'; location.reload(); });
      case 'wipe-cloud': return confirmSheet('Delete your cloud library?', 'Your songs, playlists and history are permanently removed from the cloud. Songs saved on this device stay here.', 'Delete from cloud', async () => { toast('Deleting…'); try { await cloud.deleteEverything(); for (const t of S.tracks.values()) { t.cloud = false; if (!t.local) await removeLocal(t.id); else await db.put('tracks', t.id, t); } toast('Your cloud library was deleted'); render(); } catch (err) { syncFailed(err); } });
      case 'change-pass': return sheet(`<h2>Change password</h2><input class="input full" id="np" type="password" placeholder="New password (6+ characters)" autocomplete="new-password"><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="np-go">Save</button></div>`, el => { el.querySelector('#np-go').onclick = async () => { const v = el.querySelector('#np').value; if (v.length < 6) return toast('Use at least 6 characters'); try { await cloud.changePassword(v); closeSheet(); toast('Password changed'); } catch (err) { toast(err.message); } }; });
      case 'sign-in': case 'sign-up': {
        const email = $('#auth-email').value.trim(), pass = $('#auth-pass').value;
        if (!email || pass.length < 6) return toast('Enter your email and a password of 6+ characters');
        a.disabled = true;
        try {
          if (a.dataset.action === 'sign-in') await cloud.signIn(email, pass);
          else { const live = await cloud.signUp(email, pass); if (!live) { a.disabled = false; return toast('Check your email to confirm your account, then sign in here'); } }
          S.user = await cloud.user(); await syncDown(); render();
          const localOnly = [...S.tracks.values()].filter(t => t.local && !t.cloud).length;
          toast('Signed in', localOnly ? [`Upload ${localOnly} song${localOnly > 1 ? 's' : ''}`, uploadLocal] : null);
        } catch (err) { a.disabled = false; toast(/invalid login/i.test(err.message) ? 'Email or password is wrong' : err.message || 'Couldn’t sign in'); }
        return;
      }
      case 'sign-out': await cloud.signOut(); S.user = null; return render();
      case 'sync': await syncDown(); return toast(S.lastSync && Date.now() - S.lastSync < 5000 ? 'Up to date' : 'Couldn’t sync');
    }
    return;
  }
  if (playBtn) {
    e.preventDefault(); e.stopPropagation();
    const ids = S.lists[playBtn.dataset.playList] || [];
    const ctxRoute = playBtn.dataset.ctxRoute || collectionRoute();
    return playList(ids, +(playBtn.dataset.i || 0), { shuffle: !!playBtn.dataset.shuffle, context: ids.context || contextName(), ctxRoute });
  }
  const chip = e.target.closest('[data-search]');
  if (chip) return go('search/' + chip.dataset.search);
  if (href) { e.preventDefault(); return go(href.dataset.href); }
  const qrow = e.target.closest('.track.q');
  if (qrow && !e.target.closest('button,.handle')) {
    if (qrow.dataset.hist) return insertNext([qrow.dataset.id]) || next();
    if (qrow.dataset.qi) { P.idx = +qrow.dataset.qi; await loadTrack(P.queue[P.idx]); return renderQueue(); }
    return;
  }
  const row = e.target.closest('.track[data-list]');
  if (row && !e.target.closest('button,.handle,a')) { const ids = S.lists[row.dataset.list]; return playList(ids, +row.dataset.i, { context: ids.context || contextName(), ctxRoute: collectionRoute() }); }
  const lyr = e.target.closest('.lyrics p[data-t]');
  if (lyr) { engine.el.currentTime = +lyr.dataset.t; P.follow = true; $('#lyrics-return').hidden = true; if (engine.el.paused) engine.el.play(); }
});
function collectionRoute() { return ['album', 'artist', 'playlist', 'smart', 'mix', 'mood', 'liked'].includes(S.route) ? location.hash.replace(/^#\/?/, '') && decodeURIComponent(location.hash.replace(/^#\/?/, '')) : ''; }
function contextName() {
  if (S.route === 'mix') return mixName(S.param);
  if (S.route === 'artist') return S.param;
  if (S.route === 'album') return S.param.split('\u0001')[0];
  if (S.route === 'playlist') return S.playlists.get(S.param)?.name || 'Playlist';
  if (S.route === 'smart') return SMART[S.param]?.title;
  if (S.route === 'mood') return MOODS[S.param]?.title;
  return { home: 'Home', songs: 'Songs', liked: 'Liked Songs', search: 'Search' }[S.route] || '';
}
document.addEventListener('contextmenu', e => { const r = e.target.closest('.track[data-id]'); if (r && !r.classList.contains('q')) { e.preventDefault(); trackMenu({ target: r.querySelector('.more') || r }, r.dataset.id); } });
document.addEventListener('dblclick', e => { if (e.target.closest('.p-track')) openNow(); });

let searchT;
document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'search-input') {
    clearTimeout(searchT);
    const q = e.target.value;
    searchT = setTimeout(() => {
      history.replaceState(null, '', '#/search' + (q ? '/' + encodeURIComponent(q) : ''));
      S.param = q; const pos = e.target.selectionStart; render();
      const i = $('#search-input'); if (i) { i.focus(); i.setSelectionRange(pos, pos); }
    }, 90);
  } else if (id === 'song-filter' || id === 'pl-filter') {
    clearTimeout(searchT);
    const v = e.target.value, pl = e.target.dataset.pl;
    searchT = setTimeout(() => { if (pl) (S.plFilter ||= {})[pl] = v; else S.songFilter = v; render(); const i = $('#' + id); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } }, 120);
  } else if (e.target.dataset.setting === 'crossfade') {
    S.settings.crossfade = +e.target.value; paintRange(e.target); e.target.closest('.set-row').querySelector('.lbl span').textContent = S.settings.crossfade ? `Songs blend over ${S.settings.crossfade} seconds` : 'Off. Songs play one after another.';
    clearTimeout(e.target._t); e.target._t = setTimeout(() => { S.settingsAt = Date.now(); kv.set('settingsAt', S.settingsAt); saveSettings(); }, 300);
  }
});
let navIdx = -1;
document.addEventListener('keydown', e => {
  const tgt = e.target;
  if (tgt.id === 'search-input') {
    const items = $$('#view .sr-item, #view .tracks .track, #view .card');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); navIdx = Math.max(-1, Math.min(items.length - 1, navIdx + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((x, i) => x.classList.toggle('kb', i === navIdx)); items[navIdx]?.scrollIntoView({ block: 'nearest' }); return;
    }
    if (e.key === 'Enter') {
      const q = tgt.value.trim(); if (q) { S.searches = [q, ...S.searches.filter(s => s !== q)].slice(0, 8); kv.set('searches', S.searches); }
      const it = items[Math.max(navIdx, 0)]; if (it) { it.click(); } navIdx = -1; return;
    }
    navIdx = -1; return;
  }
  if (tgt.matches('input,textarea,select,[contenteditable]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { if ($('#sheet-root').children.length) return closeSheet(); if ($('.menu')) return closeMenus(); return closeNow(); }
  if (e.key === ' ' && !tgt.matches('button,a')) { e.preventDefault(); toggle(); }
  if (e.key === 'ArrowRight' && e.shiftKey) next(); else if (e.key === 'ArrowRight' && !tgt.matches('[role=menuitem]')) engine.el.currentTime += 10;
  if (e.key === 'ArrowLeft' && e.shiftKey) prev(); else if (e.key === 'ArrowLeft' && !tgt.matches('[role=menuitem]')) engine.el.currentTime -= 10;
  if (e.key.toLowerCase() === 'l' && current()) like(current().id);
  if (e.key.toLowerCase() === 'q') $('#now').classList.contains('open') && P.panel === 'queue' ? closeNow() : openNow('queue');
  if (e.key === '/') { e.preventDefault(); go('search'); }
});
$('#file-input').addEventListener('change', e => importFiles([...e.target.files]));
$('#folder-input').addEventListener('change', e => importFiles([...e.target.files]));
window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dragging-files'); } });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging-files'); });
window.addEventListener('drop', async e => { document.body.classList.remove('dragging-files'); if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); $('#drop')?.classList.remove('over'); importFiles(await filesFromDrop(e.dataTransfer)); });
window.addEventListener('pagehide', () => { flushListen(); savePlayer(true); });

// swipe down to close the full player on phones
(() => {
  let y0 = null, x0 = null; const n = $('#now');
  n.addEventListener('touchstart', e => { if (e.target.closest('.now-right,input,.q-list')) return; y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; }, { passive: true });
  n.addEventListener('touchend', e => { if (y0 === null) return; const dy = e.changedTouches[0].clientY - y0, dx = e.changedTouches[0].clientX - x0; if (dy > 90 && Math.abs(dx) < 60) closeNow(); else if (Math.abs(dx) > 80 && Math.abs(dy) < 40 && e.target.closest('.now-art')) dx < 0 ? next() : prev(); y0 = null; });
})();

boot();
