import { db, kv, persist, storageInfo, isQuotaError } from './lib/store.js';
import * as meta from './lib/meta.js';
import { findSong, fetchFirstImage, artistPhoto, artistTop, dz } from './lib/identify.js';
import * as cloud from './lib/cloud.js';
import { Engine, IS_IOS } from './lib/engine.js';
import { NativeAudio } from './lib/native.js';
import * as pods from './lib/podcasts.js';
import * as quran from './lib/quran.js';
import * as feysal from './lib/feysal.js';
import { YtAudio } from './lib/yt.js';
import * as narrator from './lib/voice.js';
import { Index, fold } from './lib/search.js';
import { thumbnail, artColors } from './lib/image.js';
/** The version these files belong to (stamped when published); a phone holding older files updates itself. */
const BUILD = 'dev';
/** Running inside the Fof Music iPhone app rather than a browser. */
const IN_APP = !!window.Capacitor?.isNativePlatform?.() || /FofMusicApp/.test(navigator.userAgent);

/* =====================================================================
   State
   ===================================================================== */
/** Artwork kept as files until a screen shows it, so opening the app doesn't prepare 2,000 images up front. */
class LazyUrls extends Map {
  get(k) { const v = super.get(k); if (v instanceof Blob) { const u = URL.createObjectURL(v); super.set(k, u); return u; } return v; }
}
const S = {
  tracks: new Map(), ext: new Map(), playlists: new Map(), art: new LazyUrls(), thumbs: new LazyUrls(), plCovers: new Map(),
  history: [], log: [], ctxs: [], searches: [], dupIgnore: [], channels: [], fixes: { artists: {}, names: {} }, folder: null, folderState: '',
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
  autoplay: true, accent: 'fof', autoFix: true, askUnsure: false, autoOffline: true, volume: 1, theme: 'dark', density: 'comfortable', reduceMotion: false,
  crossfade: 0, gapless: true, flowBlend: true, eq: 'off', eqGains: [0, 0, 0, 0, 0], leveling: true, hideExplicit: false, keepHistory: true, songSort: 'added', songDir: -1,
};
const ACCENTS = { fof: ['#ff2e3e', '255,46,62', '#ffffff'], coral: ['#ff6a4d', '255,106,77', '#1a0703'], amber: ['#f5b041', '245,176,65', '#1d1302'], sky: ['#5ab4ff', '90,180,255', '#03121f'], mint: ['#4fd1a1', '79,209,161', '#02180f'], lilac: ['#b69cff', '182,156,255', '#120a24'], rose: ['#ff5c8a', '255,92,138', '#22040f'] };
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1c1c1f"/><path d="M42 66a7 7 0 1 1-4-6.3V36l22-4.5v28.8a7 7 0 1 1-4-6.3V40.6l-14 2.9z" fill="#3a3a3f"/></svg>');
const DAY = 86400000;
/** Podcast episodes and Quran recitations play through the same player as songs but aren't part of your library. */
const T = id => S.tracks.get(id) || S.ext.get(id);
let extT;
function saveExt(t) { S.ext.set(t.id, t); clearTimeout(extT); extT = setTimeout(() => kv.set('ext', [...S.ext.values()].filter(x => x.kind !== 'yt').slice(-300)), 400); }

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
/** In the installed iPhone app the phone's own player plays the music (gapless, crossfade, solid in the background). */
const NATIVE = (() => { try { const C = window.Capacitor; return C?.isPluginAvailable?.('FofPlayer') ? C.registerPlugin('FofPlayer') : null; } catch { return null; } })();
const ytAudio = new YtAudio($('#yt-host'));
const engine = NATIVE ? new Engine(new NativeAudio(0, NATIVE), new NativeAudio(1, NATIVE), ytAudio) : new Engine($('#audio'), $('#audio-b'), ytAudio);
if (NATIVE) engine.native = true;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const mainArtist = a => (a || '').split(/ feat\. | ft\. | featuring | & |, | x | with /i)[0].trim();
const artistCredits = value => {
  const credit = (value || '').replace(/\s*\((?:feat\.?|ft\.?|featuring)\s+([^()]+)\)/gi, ' & $1');
  return [...new Set(credit.split(/\s+(?:feat\.?|ft\.?|featuring|&|x|with)\s+|,\s+/i).map(name => name.trim()).filter(Boolean))];
};
const genreFamilies = new Map([
  ['Hip-Hop', ['Hip-Hop/Rap', 'Hip Hop/Rap', 'Hip-Hop', 'Hip Hop']],
  ['R&B', ['R&B/Soul', 'R&B']],
]);
const genreAliases = new Map([...genreFamilies].flatMap(([name, aliases]) => aliases.map(alias => [alias.toLowerCase(), name])));
const browseGenre = genre => genreAliases.get(genre.trim().toLowerCase()) || genre;
const albumArtist = t => t.albumArtist && !/various/i.test(t.albumArtist) ? t.albumArtist : mainArtist(t.artist);
const shuffleArr = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const count = n => `${n} song${n === 1 ? '' : 's'}`;
const total = ts => { const s = ts.reduce((a, t) => a + (t.duration || 0), 0); const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`; };
const DF = { y: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), n: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }) };
const ago = ms => { if (!ms) return '—'; const d = (Date.now() - ms) / DAY; if (d < 1) return 'Today'; if (d < 2) return 'Yesterday'; if (d < 7) return `${Math.floor(d)} days ago`; return (d > 300 ? DF.y : DF.n).format(ms); };
const hours = s => { const h = s / 3600; return h >= 1 ? `${h.toFixed(h >= 10 ? 0 : 1)} hr` : `${Math.round(s / 60)} min`; };
const bytes = n => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(0) + ' MB';

/** Every song the app should show (respects “Hide explicit songs”). */
const visible = () => [...S.tracks.values()].filter(t => t.category !== 'Audiobooks' && !(S.settings.hideExplicit && t.explicit));
/** Audiobooks: chapters are library files tagged “Audiobook”; album = book, artist = author. */
const isBook = t => !!t && t.category === 'Audiobooks';
/** What kind of listening this is, so the player shows the right controls. */
const playCtx = t => !t ? 'music' : isBook(t) ? 'book' : (['ayah', 'surahrec', 'yt'].includes(t.kind) || t.category === 'Quran & Recitation') ? 'quran' : (t.kind === 'episode' || t.category === 'Talks & Lectures') ? 'talk' : 'music';
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
  if (t.ext) return t.art || PLACEHOLDER;
  if (size === 'thumb' && S.thumbs.has(t.id)) return S.thumbs.get(t.id);
  if (S.art.has(t.id)) return S.art.get(t.id);
  if (t.cloud) { const u = cloud.cachedUrl('art/' + t.id, t.store === 'r2' || cloud.r2On()); if (u) return u; }
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
/* Open Fof Music tabs and windows keep each other up to date, and only one of them does background work. */
const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('fof-music') : null;
const tell = m => { try { tabs?.postMessage(m); } catch {} };
let tabsT;
function listenToOtherTabs() {
  if (!tabs) return;
  tabs.onmessage = async ({ data: m }) => {
    if (m.k === 'gone') {
      if (!S.tracks.has(m.id)) return;
      S.tracks.delete(m.id);
      for (const map of [S.art, S.thumbs]) { const u = map.get(m.id); if (u?.startsWith('blob:')) URL.revokeObjectURL(u); map.delete(m.id); }
    } else if (m.k === 'track') {
      const t = await db.get('tracks', m.id); if (!t) return;
      S.tracks.set(m.id, t);
      const [a, th] = await Promise.all([db.get('art', m.id), db.get('thumbs', m.id)]);
      if (a) swapUrl(S.art, m.id, a); if (th) swapUrl(S.thumbs, m.id, th);
    } else return;
    S.ver++; S.indexDirty = true;
    clearTimeout(tabsT); tabsT = setTimeout(() => { render(); renderSidebar(); }, 500);
  };
}
/** Runs background work (folder checks, uploads, identifying) in only one open tab at a time. */
const oneTab = (name, fn) => navigator.locks ? navigator.locks.request('fof-' + name, { ifAvailable: true }, lock => lock ? fn() : null) : fn();
async function saveTrack(t, { sync = true } = {}) {
  if (t.ext) return saveExt(t);
  S.tracks.set(t.id, t); S.indexDirty = true; S.ver++;
  try { await db.put('tracks', t.id, t); } catch (e) { if (isQuotaError(e)) quotaWarning(); throw e; }
  tell({ k: 'track', id: t.id });
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
  if (NATIVE) applyEQ();
  const [hex, rgb, ink] = ACCENTS[S.settings.accent] || ACCENTS.fof;
  const r = document.documentElement;
  r.style.setProperty('--accent', hex); r.style.setProperty('--tint', rgb); r.style.setProperty('--accent-ink', ink);
  r.dataset.theme = S.settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : S.settings.theme;
  r.dataset.density = S.settings.density;
  r.dataset.motion = S.settings.reduceMotion ? 'reduce' : 'full';
  document.querySelector('meta[name=theme-color]').content = r.dataset.theme === 'light' ? '#f6f5f3' : '#09090a';
}
let quotaShown = 0;
function quotaWarning() { if (Date.now() - quotaShown < 10000) return; quotaShown = Date.now(); toast('This device is out of space for Fof Music. Remove some songs or free up storage.'); }
let syncWarned = 0;
// Plain-English versions of the errors that can reach the screen
function friendlyError(err, fallback = 'Something went wrong. Try again.') {
  const m = String(err?.message || err || '');
  if (!navigator.onLine) return 'You’re offline. Connect to the internet and try again.';
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed|timeout|timed out|503|502|504|540/i.test(m)) return 'Can’t reach your cloud library right now. Your music on this device still plays. Try again in a minute.';
  if (/invalid login|invalid credentials/i.test(m)) return 'Email or password is wrong';
  if (/email not confirmed/i.test(m)) return 'Confirm your email first, then sign in';
  if (/already registered|already exists/i.test(m)) return 'That email already has an account. Sign in instead.';
  if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a minute and try again.';
  if (/password/i.test(m) && /least|short|weak/i.test(m)) return 'Use a longer password (6+ characters)';
  return m && m.length < 90 && !/^[A-Z_]+$/.test(m) ? m : fallback;
}
let syncRetryT;
function syncFailed(e) { console.warn('sync', e); clearTimeout(syncRetryT); syncRetryT = setTimeout(() => { if (S.user) syncDown(); }, 120000); if (Date.now() - syncWarned > 60000) { syncWarned = Date.now(); toast(navigator.onLine ? 'Couldn’t sync just now. Changes are saved here and will sync later.' : 'You’re offline. Changes are saved on this device.'); } }

/* listening state that follows you between devices */
const DEV = (() => {
  let id = ''; try { id = localStorage.getItem('fof-dev') || ''; if (!id) { id = uid(); localStorage.setItem('fof-dev', id); } } catch { id = uid(); }
  const ua = navigator.userAgent;
  const name = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'PC' : 'other device';
  return { id, name };
})();
function playerSnapMine() { const r = S.remotePlayer; S.remotePlayer = null; const s = playerSnap(); S.remotePlayer = r; return s; }
/** What's playing here, so another device can carry on from the same spot. */
function playerSnap() {
  if (!P.queue.length || P.idx < 0) return S.remotePlayer || null;
  const lo = Math.max(0, P.idx - 200);
  const mine = { queue: P.queue.slice(lo, lo + 500), idx: P.idx - lo, time: Math.round(spotNow()), playing: !engine.el.paused, sentAt: Date.now(), at: P.activeAt || 0, dev: DEV.id, devName: DEV.name, shuffle: P.shuffle, repeat: P.repeat, context: P.context, contextRoute: P.contextRoute, mode: P.mode, seed: P.seed };
  // never overwrite a newer spot from another device with an older one from here
  return (S.remotePlayer?.at || 0) > mine.at ? S.remotePlayer : mine;
}
/** Another device played more recently than this one: line up the same queue at the same spot, paused, ready to go. */
async function adoptPlayer(r, { live = false } = {}) {
  if (r?.dev !== DEV.id && (r?.at || 0) > (S.remotePlayer?.at || 0)) S.remotePlayer = r;
  if (!r?.queue?.length || r.dev === DEV.id || !engine.el.paused) return;
  if (!live && (r.at || 0) <= (P.activeAt || 0) + 1000) return;
  const curId = r.queue[r.idx]; if (!T(curId)) return;
  // still playing over there (or was, moments ago): carry on here at the same moment, playing
  const play = !document.hidden && r.playing && (live || Date.now() - (r.sentAt || 0) < 3 * 60000);
  const time = Math.max(0, (r.time || 0) + (play ? Math.max(0, Date.now() - (r.sentAt || Date.now())) / 1000 : 0));
  const len = T(curId).duration || 0; const at0 = len && time > len - 3 ? Math.max(0, len - 3) : time;
  const same = current()?.id === curId;
  if (same && Math.abs(spotNow() - at0) < 4 && !play) { P.activeAt = r.at; savePlayer(true); return; } // already here
  const queue = r.queue.filter(id => T(id)), idx = queue.indexOf(curId);
  Object.assign(P, { queue, idx, shuffle: !!r.shuffle, repeat: r.repeat || 'off', context: r.context || '', contextRoute: r.contextRoute || '', mode: r.mode || null, seed: r.seed || null, autoAdded: new Set(), activeAt: r.at, resumeId: curId, resumeAt: at0 });
  const ok = same ? true : await loadTrack(curId, { autoplay: play, quiet: true });
  if (ok && same) { try { engine.el.currentTime = at0; } catch {} if (play) engine.el.play()?.catch?.(() => {}); }
  else if (ok && at0 && !play) seekWhenReady(at0);
  P.activeAt = r.at; savePlayer(true); paintTime();
  if (P.panel === 'queue') renderQueue();
  if (S.route === 'home') render();
  const from = r.devName || 'other device', title = T(curId).title;
  if (!play) return toast(`Picked up from your ${from}: ${title}${at0 > 5 ? ' at ' + fmt(at0) : ''}`);
  // a browser may refuse to start sound until you tap once: offer the button
  setTimeout(() => { if (engine.el.paused && current()?.id === curId) toast(`Continue “${title}” from your ${from}?`, ['Play here', () => engine.el.play()]); else toast(`Continuing from your ${from}`); }, 1500);
}

/* Live link: the device you're using plays; the others step aside */
const LIVE = { on: false, starting: false, helloAt: 0 };
async function liveStart() {
  if (!S.user || LIVE.on || LIVE.starting) return;
  LIVE.starting = true;
  try { LIVE.on = await cloud.live(onLive); } catch { LIVE.on = false; }
  LIVE.starting = false;
  if (LIVE.on) liveHello(); else setTimeout(liveStart, 60000);
}
function liveCheck() { if (S.user && LIVE.on && !cloud.liveOn()) { LIVE.on = false; liveStart(); } }
function liveSay(t) { if (LIVE.on) cloud.liveSend({ t, dev: DEV.id, devName: DEV.name, snap: playerSnapMine() }); }
/** Opening the app here: ask whether another device is playing right now. */
function liveHello() {
  if (!LIVE.on || document.hidden) return;
  LIVE.helloAt = Date.now(); liveSay('hello');
  clearTimeout(LIVE.retry);
  LIVE.retry = setTimeout(() => { if (engine.el.paused && LIVE.helloAt) { LIVE.helloAt = Date.now(); liveSay('hello'); LIVE.retry = setTimeout(() => { if (engine.el.paused && LIVE.helloAt) { LIVE.helloAt = Date.now(); liveSay('hello'); } }, 5000); } }, 3000);
}
function onLive(m) {
  if (!m || m.dev === DEV.id) return;
  if (m.t === 'hello') { if (!engine.el.paused) liveSay('state'); return; }
  if (m.t === 'take') { if (!engine.el.paused) { engine.el.pause(); toast(`Now playing on your ${m.devName || 'other device'}`); } return; }
  if (m.t === 'state' && m.snap?.playing && Date.now() - LIVE.helloAt < 8000 && engine.el.paused && !document.hidden) { LIVE.helloAt = 0; adoptPlayer(m.snap, { live: true }); }
}
let pullingLight = false;
/** A quick check for where you left off elsewhere, when you come back to the app. */
async function pullLight() {
  if (!S.user || pullingLight || Date.now() - (S.lastPull || 0) < 4000) return;
  pullingLight = true; S.lastPull = Date.now();
  try { const st = await cloud.pullState(); if (st?.data) mergeState(st.data); } catch {}
  pullingLight = false;
}
let pushT;
function queueStatePush(now) {
  if (!S.user) return;
  clearTimeout(pushT);
  P.pushedAt = Date.now();
  pushT = setTimeout(() => {
    const { volume, ...settings } = S.settings;
    cloud.pushState({ history: S.history.slice(0, 200), log: S.log.slice(-3000), ctxs: S.ctxs, searches: S.searches, settings, settingsAt: S.settingsAt || 0, dupIgnore: S.dupIgnore, channels: S.channels, fixes: S.fixes, pod: { subs: S.pod.subs, prog: S.pod.prog }, eps: Object.keys(S.pod.prog).slice(-150).map(id => S.ext.get(id)).filter(Boolean).map(({ path, local, ...e }) => e), quran: S.quranSpot || null, quranSaved: S.quranSaved || [], want: (S.want || []).slice(0, 400), bookQueue: S.bookQueue || [], bookmarks: S.bookmarks || [], player: playerSnap() }).then(() => { S.lastSync = Date.now(); }).catch(e => syncFailed(e));
  }, now ? 0 : 4000);
}

/* =====================================================================
   Boot
   ===================================================================== */
async function boot() {
  persist();
  S.settings = { ...DEFAULTS, ...(await kv.get('settings', {})) };
  if (!S.settings.fofRed) { S.settings.fofRed = true; if (S.settings.accent === 'coral') S.settings.accent = 'fof'; kv.set('settings', S.settings); } // one-time move to the FOF red
  applySettings();
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applySettings);
  const [tracks, pls, arts, thumbs] = await Promise.all([db.all('tracks'), db.all('playlists'), db.all('art'), db.all('thumbs')]);
  for (const [id, t] of tracks) S.tracks.set(id, t);
  for (const t of await kv.get('ext', [])) { if (t.kind === 'episode') t.title = pods.tidy(t.title); S.ext.set(t.id, t); }
  for (const t of feysal.all()) S.ext.set(t.id, t);
  S.pod = await kv.get('pod', { subs: [], prog: {}, saved: {} });
  S.quranSpot = await kv.get('quranSpot', null);
  S.quranSaved = await kv.get('quranSaved', []);
  CHECK.lists = await kv.get('playlistChecks', []);
  S.bookQueue = await kv.get('bookQueue', []); S.bookmarks = await kv.get('bookmarks', []); S.want = await kv.get('want', []); S.wantNew = await kv.get('wantNew', 0);
  S.cleanNoArt = await kv.get('cleanNoArt', []); S.qOff = await kv.get('qOff', {}); S.offPaths = await kv.get('offPaths', {}); S.deskPaths = window.fofDesktop ? await kv.get('deskPaths', {}) : {};
  for (const [id, p] of pls) S.playlists.set(id, p);
  for (const [id, b] of arts) { if (id.startsWith('pl:')) S.plCovers.set(id.slice(3), URL.createObjectURL(b)); else S.art.set(id, b); }
  for (const [id, b] of thumbs) S.thumbs.set(id, b);
  [S.history, S.log, S.ctxs, S.searches, S.dupIgnore, S.settingsAt, S.channels, S.folder, S.fixes] = await Promise.all([kv.get('history', []), kv.get('log', []), kv.get('ctxs', []), kv.get('searches', []), kv.get('dupIgnore', []), kv.get('settingsAt', 0), kv.get('channels', []), kv.get('folder', null), kv.get('fixes', { artists: {}, names: {} })]);
  engine.setVolume(S.settings.volume ?? 1);
  $('#p-vol').value = Math.round((S.settings.volume ?? 1) * 100); paintRange($('#p-vol'));
  const saved = await kv.get('player', null);
  // the spot is also kept in quick storage, which survives the app being swiped away mid-save
  try { const q = JSON.parse(localStorage.getItem('fof-spot') || 'null'); if (saved && q && saved.queue?.[saved.idx] === q.id && q.time > (saved.time || 0)) saved.time = q.time; } catch {}
  if (saved?.queue?.length) {
    P.queue = saved.queue.filter(id => T(id));
    P.idx = Math.min(Math.max(saved.idx, 0), P.queue.length - 1);
    Object.assign(P, { shuffle: !!saved.shuffle, repeat: saved.repeat || 'off', context: saved.context || '', contextRoute: saved.contextRoute || '', mode: saved.mode || null, seed: saved.seed || null, activeAt: saved.at || 0 });
    P.played = (saved.played || []).filter(id => S.tracks.has(id));
    // remember the spot even if the song can't load yet (on the phone, songs wait for sign-in to finish)
    if (P.idx >= 0 && P.queue.length) { P.resumeId = P.queue[P.idx]; P.resumeAt = saved.time || 0; const ok = await loadTrack(P.queue[P.idx], { autoplay: false, quiet: true }); if (ok && saved.time) seekWhenReady(saved.time); }
  }
  if (/iP(hone|ad|od)/.test(navigator.userAgent) && !navigator.standalone && !IN_APP) { document.documentElement.classList.add('ios-browser'); try { if (!localStorage.getItem('cadence-a2hs')) { localStorage.setItem('cadence-a2hs', '1'); setTimeout(() => toast('For full screen: tap Share, then Add to Home Screen'), 2500); } } catch {} }
  renderSidebar();
  listenToOtherTabs();
  window.addEventListener('hashchange', route);
  route();
  S.bootDone = true;
  warmThumbs();
  updateModes();
  backfillArt();
  repairMatches().then(recleanNames).then(restoreTags).then(() => scanFolder()).then(identifyLibrary).then(() => fillGenres());
  initCloud();
  checkVersion();
  setInterval(checkVersion, 10 * 60 * 1000);
  // new songs saved to the connected folder show up within a couple of minutes, even mid-song
  setInterval(() => { if (S.folder && S.folderState !== 'needs-permission' && !IMP.running) scanFolder(); }, 30 * 1000);
  // songs that couldn't upload earlier (bad Wi-Fi, signed out) go up on their own
  setInterval(() => autoUpload(), 5 * 60 * 1000);
  setTimeout(autoOffline, 20000); setInterval(autoOffline, 15 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkVersion(); if (S.folder && Date.now() - (S.lastScan || 0) > 30000) scanFolder(); liveCheck(); liveHello(); if (S.user && Date.now() - S.lastSync > 60000) syncDown(); else pullLight(); } else { flushListen(); savePlayer(true); queueStatePush(true); } });
  addEventListener('focus', () => { liveCheck(); liveHello(); pullLight(); });
  window.addEventListener('online', () => { if (S.user) { syncDown(); setTimeout(autoUpload, 5000); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (IN_APP) { renewReminder(); siriHooks(); }
  setTimeout(() => { try { checkWants(); } catch {} }, 6000);
  setTimeout(() => growPlaylists().catch(e => console.warn('grow', e)), 60000); setInterval(() => growPlaylists().catch(() => {}), 20 * 60 * 1000);
}
/** "Hey Siri, play Fof Flow" and the home screen widget hand their request to the app here. */
function siriRun(a) {
  if (a === 'flow') flow();
  else if (a === 'liked') { const ids = visible().filter(t => t.liked).sort(byAdded).map(t => t.id); if (ids.length) playList(ids, 0, { shuffle: true, context: 'Liked Songs', ctxRoute: 'liked' }); }
  else if (a === 'quran') S.quranSpot ? qResume() : go('quran');
  else if (a === 'toggle') toggle();
  else if (a === 'next') next();
  else if (a?.startsWith('want/')) wantFromText(a.slice(5));
}
async function siriHooks() {
  const nat = window.Capacitor?.Plugins?.FofNative; if (!nat) return;
  try { nat.addListener('siri', e => siriRun(e.action)); const i = await nat.info(); if (i?.siri) setTimeout(() => siriRun(i.siri), 800); } catch {}
}
/** The installed iPhone app (SideStore). Free signing lasts 7 days: SideStore renews it, and this is the backup reminder. */
async function renewReminder() {
  const nat = window.Capacitor?.Plugins?.FofNative; if (!nat) return;
  try {
    const i = await nat.info(); if (!i?.expires) return;
    const left = (new Date(i.expires) - Date.now()) / 864e5; if (left > 2) return;
    toast(`Fof Music needs a refresh ${left < 1 ? 'today' : `in ${Math.ceil(left)} days`} or it stops opening`, ['Renew', () => nat.openSideStore()]);
  } catch {}
}
function seekWhenReady(t) { const el = engine.el; const go_ = () => { try { el.currentTime = t; } catch {} onTime(); }; el.readyState >= 1 ? go_() : el.addEventListener('loadedmetadata', go_, { once: true }); }

async function initCloud() {
  if (!cloud.cloudConfigured()) return;
  try {
    S.user = await cloud.user();
    if (S.user) { liveStart(); syncDown().then(() => setTimeout(autoUpload, 5000)); }
    const c = await cloud.sb();
    c.auth.onAuthStateChange((_e, session) => {
      const was = S.user?.id; S.user = session?.user || null;
      if (S.user && S.user.id !== was) { liveStart(); syncDown().then(() => setTimeout(autoUpload, 5000)); }
      if (S.route === 'settings') render();
    });
  } catch (e) { checkLibraryFailed = true; console.warn('cloud', e); }
  finally { checkAuthPending = false; if (S.route === 'import' && S.param === 'check') render(); }
}

let artRepaired = false;
async function syncDown() {
  if (!S.user) return;
  try {
    checkPulls++;
    if (S.route === 'import' && S.param === 'check') render();
    const rows = await cloud.pullTracks();
    if (rows) {
      let changed = false;
      for (const r of rows) {
        const local = T(r.id);
        if (r.deleted) { if (local) { await removeLocal(r.id); changed = true; } continue; }
        const merged = { ...r.data, local: !!local?.local, downloaded: !!local?.downloaded, cloud: true, plays: Math.max(local?.plays || 0, r.data.plays || 0), lastPlayed: Math.max(local?.lastPlayed || 0, r.data.lastPlayed || 0) };
        if (!local || JSON.stringify(local) !== JSON.stringify(merged)) { S.tracks.set(r.id, merged); await db.put('tracks', r.id, merged); changed = true; }
      }
      const needArt = rows.filter(r => !r.deleted && !S.art.has(r.id)).map(r => r.id);
      if (needArt.length) {
        const isR2 = id => T(id)?.store === 'r2' || cloud.r2On();
        await cloud.fileUrls(needArt.filter(isR2).map(id => 'art/' + id), true);
        await cloud.fileUrls(needArt.filter(id => !isR2(id)).map(id => 'art/' + id));
        changed = true; cacheCloudArt(needArt);
      }
      if (changed) { S.indexDirty = true; bgRender(); }
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
    liveStart();
    const firstSync = !S.lastSync; S.lastSync = Date.now();
    if (firstSync && window.fofDesktop) setTimeout(() => window.fofDesktop.scanNow(), 3000);
    queueStatePush();
    // songs added on this device before signing in go up to the cloud on their own
    if ([...S.tracks.values()].some(t => t.local && !t.cloud) && !uploading) await uploadLocal({ quiet: true });
    migrateToR2();
    if (!artRepaired) { artRepaired = true; repairArt(); }
    checkLibraryFailed = !rows;
  } catch (e) { checkLibraryFailed = true; syncFailed(e); }
  finally { checkPulls--; if (S.route === 'import' && S.param === 'check') render(); }
}
function mergeState(d) {
  const seen = new Set(S.log.map(e => e.id + e.at));
  S.log = [...S.log, ...(d.log || []).filter(e => !seen.has(e.id + e.at))].sort((a, b) => a.at - b.at).slice(-5000);
  S.history = [...new Set([...S.history, ...(d.history || [])])].slice(0, 200);
  if (d.ctxs) S.ctxs = [...S.ctxs, ...d.ctxs.filter(c => !S.ctxs.some(x => x.route === c.route))].sort((a, b) => b.at - a.at).slice(0, 16);
  if (d.searches && !S.searches.length) S.searches = d.searches;
  if (d.dupIgnore) S.dupIgnore = [...new Set([...S.dupIgnore, ...d.dupIgnore])];
  if (d.channels) { S.channels = [...new Set([...S.channels, ...d.channels])]; kv.set('channels', S.channels); }
  if (d.fixes) { S.fixes = { artists: { ...d.fixes.artists, ...S.fixes.artists }, names: { ...d.fixes.names, ...S.fixes.names } }; kv.set('fixes', S.fixes); }
  if (d.settings && (d.settingsAt || 0) > (S.settingsAt || 0)) { S.settings = { ...S.settings, ...d.settings }; S.settingsAt = d.settingsAt; kv.set('settings', S.settings); kv.set('settingsAt', S.settingsAt); applySettings(); }
  if (d.pod) {
    const subs = [...S.pod.subs]; for (const x of d.pod.subs || []) if (!subs.some(y => y.id === x.id)) subs.push(x);
    const prog = { ...S.pod.prog }; for (const [k, v] of Object.entries(d.pod.prog || {})) if (!prog[k] || (v.at || 0) > (prog[k].at || 0)) prog[k] = v;
    S.pod = { ...S.pod, subs, prog }; kv.set('pod', S.pod);
  }
  for (const e of d.eps || []) if (!S.ext.has(e.id)) S.ext.set(e.id, e);
  if (d.bookmarks) { const seen = new Set((S.bookmarks || []).map(b => b.id + b.at)); S.bookmarks = [...(S.bookmarks || []), ...d.bookmarks.filter(b => !seen.has(b.id + b.at))].sort((a, b) => b.at - a.at); kv.set('bookmarks', S.bookmarks); }
  if (d.bookQueue) { const m = new Map((S.bookQueue || []).map(b => [b.id, b])); for (const b of d.bookQueue) if (!m.has(b.id) || (b.at || 0) > (m.get(b.id).at || 0)) m.set(b.id, b); S.bookQueue = [...m.values()].sort((a, b) => b.added - a.added); kv.set('bookQueue', S.bookQueue); if (DESK_BOOKS) setTimeout(takeBooks, 2000); if (S.route === 'books') render(); }
  if (d.want) { const m = new Map((S.want || []).map(w => [w.key + (w.arrived ? '+' : ''), w])); for (const w of d.want) { const k = w.key + (w.arrived ? '+' : ''); if (!m.has(k) && !(w.arrived ? false : (S.want || []).some(x => x.key === w.key && x.arrived))) m.set(k, w); } S.want = [...m.values()].sort((a, b) => b.at - a.at); kv.set('want', S.want); }
  if (d.quranSaved) { const m = new Map((S.quranSaved || []).map(x => [x.s + ':' + x.v, x])); for (const x of d.quranSaved) if (!m.has(x.s + ':' + x.v)) m.set(x.s + ':' + x.v, x); S.quranSaved = [...m.values()]; kv.set('quranSaved', S.quranSaved); }
  if (d.quran && (d.quran.at || 0) > (S.quranSpot?.at || 0)) { S.quranSpot = d.quran; kv.set('quranSpot', S.quranSpot); }
  if (d.player) adoptPlayer(d.player);
  kv.set('log', S.log); kv.set('history', S.history); kv.set('ctxs', S.ctxs); kv.set('dupIgnore', S.dupIgnore);
}
async function cacheCloudArt(ids) {
  const list = [...ids]; let done = 0, last = Date.now();
  const worker = async () => {
    for (let id; (id = list.shift());) {
      const t = T(id); const u = t && cloud.cachedUrl('art/' + id, t.store === 'r2' || cloud.r2On()); if (!u) continue;
      try {
        const r = await fetch(u); if (!r.ok) continue;
        const b = await r.blob(); if (!b.size || !/^image\//.test(b.type)) continue;
        await setArt(t, b); await db.put('tracks', t.id, t); done++;
      } catch {}
      if (Date.now() - last > 1500) { last = Date.now(); S.indexDirty = true; render(); }
    }
  };
  await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
  if (done) { S.indexDirty = true; render(); }
}
/** Artwork saved while files were moving can be an error page instead of a picture: drop it so it downloads again. */
async function repairArt() {
  const bad = [];
  for (const t of S.tracks.values()) {
    if (!S.art.has(t.id) || S.thumbs.has(t.id)) continue;
    const b = await db.get('art', t.id);
    if (!b || !/^image\//.test(b.type || '') || !(await thumbnail(b))) { await db.del('art', t.id); const u = S.art.get(t.id); if (u?.startsWith('blob:')) URL.revokeObjectURL(u); S.art.delete(t.id); bad.push(t.id); }
  }
  if (!bad.length || !S.user) return;
  const isR2 = id => T(id)?.store === 'r2' || cloud.r2On();
  await cloud.fileUrls(bad.filter(isR2).map(id => 'art/' + id), true);
  await cloud.fileUrls(bad.filter(id => !isR2(id)).map(id => 'art/' + id));
  render(); cacheCloudArt(bad);
}
async function cachePlaylistCover(id) {
  try { const r2 = S.playlists.get(id)?.coverStore === 'r2'; await cloud.fileUrls(['art/pl-' + id], r2); const u = cloud.cachedUrl('art/pl-' + id, r2); if (!u) return; const b = await (await fetch(u)).blob(); if (b.size) { await db.put('art', 'pl:' + id, b); swapUrl(S.plCovers, id, b); render(); } } catch {}
}

/* =====================================================================
   Updates
   ===================================================================== */
/* Updates: the app picks up a new version on its own.
   Nothing playing → it refreshes right away. Music playing → it waits until you pause or leave the app,
   and the Update bar lets you do it now. */
let pendingUpdate = '';
async function checkVersion() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = await r.json();
    if (!S.version) S.version = BUILD !== 'dev' ? BUILD : version;
    if (version === 'dev' || version === S.version) return;
    pendingUpdate = version;
    let last = {}; try { last = JSON.parse(sessionStorage.getItem('fof-fresh') || '{}'); } catch {}
    const recentlyTried = last.v === version && Date.now() - (last.t || 0) < 120000; // the site can take a minute to publish everywhere
    if (!recentlyTried && engine.el.paused && !IMP.running) { try { sessionStorage.setItem('fof-fresh', JSON.stringify({ v: version, t: Date.now() })); } catch {} return applyUpdate(); }
    $('#update-bar').classList.add('show');
  } catch {}
}
function updateWhenQuiet() {
  if (!pendingUpdate || IMP.running || P.mem) return;
  setTimeout(() => { if (pendingUpdate && engine.el.paused && !IMP.running && !P.mem) applyUpdate(); }, 1500);
}
for (const el of engine.els) el.addEventListener('pause', () => { if (document.hidden || IN_APP) updateWhenQuiet(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) updateWhenQuiet(); });
async function applyUpdate() {
  flushListen(); await savePlayer(true);
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  try { await fetch('./', { cache: 'reload' }); await fetch('index.html', { cache: 'reload' }); } catch {}
  location.reload();
}

/* =====================================================================
   Routing (keeps scroll position when you go back)
   ===================================================================== */
function go(r) { S.freshNav = true; location.hash = '#/' + r; }
$('#main').addEventListener('scroll', () => { S.scroll[location.hash] = $('#main').scrollTop; mountSoon(); }, { passive: true });
function route(ev) {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')) || 'home';
  if (h === 'drive' && ev?.oldURL && !ev.oldURL.includes('#/drive')) S.driveFrom = decodeURIComponent(ev.oldURL.split('#/')[1] || 'home');
  document.documentElement.classList.toggle('drive-on', h === 'drive');
  const i = h.indexOf('/');
  S.route = i < 0 ? h : h.slice(0, i);
  S.param = i < 0 ? '' : h.slice(i + 1);
  const libRoutes = ['books', 'book', 'songs', 'artists', 'albums', 'liked', 'playlist', 'artist', 'album', 'library', 'smart', 'insights', 'duplicates', 'history', 'replay', 'import', 'dz-artist', 'dz-album'];
  $$('[data-route]').forEach(a => {
    const r = a.dataset.route;
    a.classList.toggle('active', r === S.route || (r === 'library' && libRoutes.includes(S.route)) || (r === 'podcasts' && ['show', 'topic'].includes(S.route)) || (r === 'quran' && ['feysal', 'reciters'].includes(S.route)));
  });
  $$('#sidebar-playlists .nav-link').forEach(a => a.classList.toggle('active', (S.route === 'playlist' || S.route === 'smart') && a.dataset.pl === S.param));
  render();
  const y = S.freshNav ? 0 : (S.scroll[location.hash] || 0);
  S.freshNav = false;
  $('#main').scrollTop = y;
  mountVisible();
}
const VIEWS = {};
/* Background updates (sync, imports, artwork) redraw the page only if something on it changed,
   and wait until you stop scrolling, so nothing flickers while you browse. */
let lastHTML = '', lastPage = '', renderT = 0, lastScroll = 0;
$('#main').addEventListener('scroll', () => { lastScroll = Date.now(); }, { passive: true });
/** For changes that arrive in the background (new songs syncing in): at most one redraw every few seconds. */
let bgT = 0, bgLast = 0;
function bgRender() { const wait = Math.max(0, 4000 - (Date.now() - bgLast)); clearTimeout(bgT); bgT = setTimeout(() => { bgLast = Date.now(); render(); }, wait); }
function render() {
  const page = S.route + '/' + (S.param || '');
  const nav = S.freshNav || page !== lastPage;
  if (!nav && Date.now() - lastScroll < 900) { clearTimeout(renderT); renderT = setTimeout(render, 1000); return; }
  clearTimeout(renderT);
  const keepLists = S.lists, keepV = S.vlists;
  S.lists = {}; S.vlists = {}; listN = 0;
  if (S.indexDirty) rebuildIndex();
  const v = VIEWS[S.route] || VIEWS.home;
  const view = $('#view');
  const y = $('#main').scrollTop;
  const html = v();
  if (!nav && html === lastHTML) { gridRest = null; S.lists = keepLists; S.vlists = keepV; markPlaying(); paintTime(); return; }
  lastHTML = html; lastPage = page;
  view.innerHTML = html;
  if (!S.freshNav) $('#main').scrollTop = y;
  afterRender();
}
function afterRender() {
  if (S.route === 'search') { const i = $('#search-input'); if (i && document.activeElement !== i && !('ontouchstart' in window)) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  if (S.route === 'search') refreshDiscover();
  if (S.route === 'import' && $('#drop')) bindImport();
  if (S.route === 'new') bindDiscover();
  if (S.route === 'podcasts') bindPodSearch();
  if (S.route === 'books') { const q = $('#bk-q'), so = $('#bk-sort'); if (q) q.oninput = () => { S.bookQ = q.value; clearTimeout(q._t); q._t = setTimeout(() => { render(); const n = $('#bk-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); }; if (so) so.onchange = () => { S.bookSort = so.value; render(); }; }
  if (S.route === 'quran' || S.route === 'reciters') bindQuran();
  paintTime();
  requestAnimationFrame(() => $$('.shelf').forEach(sh => sh.closest('.section')?.classList.toggle('fits', sh.scrollWidth <= sh.clientWidth + 4)));
  fillBigGrid();
  renderBadge();
  $$('[data-sortable]').forEach(el => makeSortable(el, el.dataset.sortable));
  mountVisible();
  markPlaying();
}

/* =====================================================================
   Building blocks
   ===================================================================== */
const COLW = { album: 'minmax(0,1fr)', added: '110px', plays: '64px', last: '110px' };
const COLNAME = { album: 'Album', added: 'Added', plays: 'Plays', last: 'Last played' };
let listN = 0;
function listKey(ids, context) { const k = 'l' + (listN++); S.lists[k] = ids; ids.context = context; return k; }
function gridFor(opts) { return `${opts.sortable ? '28px ' : ''}32px 44px minmax(0,1.4fr) ${opts.cols.map(c => COLW[c]).join(' ')} 36px 56px 36px`; }
function rowHtml(t, i, key, opts) {
  return `<div class="track${opts.sortable ? " has-handle" : ""}" data-id="${t.id}" data-list="${key}" data-i="${i}" style="grid-template-columns:${gridFor(opts)}">
    ${opts.sortable ? '<div class="handle" title="Drag to reorder"><svg><use href="#i-grip"/></svg></div>' : ''}
    <div class="num"><span class="n">${i + 1}</span><span class="eq"><i></i><i></i><i></i></span><svg class="hover-icon"><use href="#i-play"/></svg></div>
    <div class="th"><img loading="lazy" decoding="async" src="${artOf(t)}" alt=""></div>
    <div class="tmain"><div class="tt ellipsis">${esc(t.title)}${t.explicit ? '<span class="explicit">E</span>' : ''}${t.downloaded ? '<svg class="saved-mark" aria-label="On this device"><use href="#i-saved"/></svg>' : ''}</div><div class="ta ellipsis">${artistCredits(t.artist).map(name => `<a href="#/artist/${encodeURIComponent(name)}">${esc(name)}</a>`).join(', ')}</div></div>
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
const VCH = 10; // rows per block: blocks are added and removed as you scroll, rows already on screen are never redrawn
function mountVisible() {
  const main = $('#main'); if (!Object.keys(S.vlists).length) return;
  if (!rowH) rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 56;
  const mh = main.clientHeight, mtop = main.getBoundingClientRect().top;
  let added = false;
  for (const el of $$('.vlist')) {
    const v = S.vlists[el.dataset.vl]; if (!v) continue;
    const top = el.getBoundingClientRect().top - mtop;
    const first = Math.max(0, Math.floor((-top - mh * .75) / rowH)), last = Math.min(v.tracks.length, Math.ceil((mh * 1.75 - top) / rowH));
    const c0 = Math.floor(first / VCH), c1 = Math.max(c0, Math.ceil(last / VCH) - 1);
    const key = c0 + '-' + c1; if (el._r === key) continue; el._r = key;
    const inner = el.firstElementChild;
    if (inner.style.transform) inner.style.transform = '';
    const have = new Map([...inner.children].map(ch => [+ch.dataset.c, ch]));
    for (const [c, ch] of have) if (c < c0 || c > c1) ch.remove();
    for (let c = c0; c <= c1; c++) {
      if (have.has(c) && have.get(c).isConnected) continue;
      const s0 = c * VCH; if (s0 >= v.tracks.length) break;
      const div = document.createElement('div'); div.className = 'vl-chunk'; div.dataset.c = c; div.style.transform = `translateY(${s0 * rowH}px)`;
      div.innerHTML = v.tracks.slice(s0, s0 + VCH).map((t, k) => rowHtml(t, s0 + k, el.dataset.vl, v.opts)).join('');
      inner.appendChild(div); added = true;
    }
  }
  if (added) markPlaying();
}
let vlRaf = 0;
const mountSoon = () => { if (!vlRaf) vlRaf = requestAnimationFrame(() => { vlRaf = 0; mountVisible(); }); };
window.addEventListener('resize', () => { rowH = 0; $$('.vlist').forEach(el => { el._r = ''; const i = el.firstElementChild; if (i) i.innerHTML = ''; }); mountVisible(); }, { passive: true });

function trackCard(t, key, i) {
  return `<div class="card" data-play-list="${key}" data-i="${i}" title="${esc(t.title)} · ${esc(t.artist)}">
    <div class="cover"><img loading="lazy" decoding="async" src="${artOf(t)}" alt=""><span class="hover-play"><svg><use href="#i-play"/></svg></span></div>
    <div class="t ellipsis">${esc(t.title)}</div><div class="s ellipsis">${esc(t.artist)}</div></div>`;
}
/** The first few distinct covers in a list, without touching the rest of it. */
/** Big grids show the first screens right away and add the rest a moment later, so the page opens instantly. */
/** Gets cover thumbnails ready in spare moments after opening, so long lists scroll without a hitch. */
function warmThumbs() {
  const ids = [...S.thumbs.keys()]; let i = 0;
  const idle = window.requestIdleCallback || (f => setTimeout(() => f({ timeRemaining: () => 8 }), 50));
  const step = d => { while (i < ids.length && d.timeRemaining() > 2) { S.thumbs.get(ids[i++]); } if (i < ids.length) idle(step); };
  setTimeout(() => idle(step), 1500);
}
let gridRest = null;
function bigGrid(items, card) { if (items.length <= 48) return `<div class="grid">${items.map(card).join('')}</div>`; gridRest = { items: items.slice(48), card, lists: S.lists }; return `<div class="grid" id="big-grid">${items.slice(0, 48).map(card).join('')}</div>`; }
function fillBigGrid() {
  const rest = gridRest; gridRest = null; const el = $('#big-grid'); if (!rest || !el) return;
  let i = 0; const step = () => { if (!el.isConnected || S.lists !== rest.lists) return; el.insertAdjacentHTML('beforeend', rest.items.slice(i, i + 24).map(rest.card).join('')); i += 24; if (i < rest.items.length) setTimeout(step, 16); else if (S.scroll[location.hash] && $('#main').scrollTop < S.scroll[location.hash]) $('#main').scrollTop = S.scroll[location.hash]; };
  setTimeout(step, 0);
}
function firstArts(tracks, n) { const out = new Set(); for (const t of tracks) { const a = artOf(t); if (a !== PLACEHOLDER) out.add(a); if (out.size >= n) break; } return [...out]; }
function collageHtml(tracks, custom) {
  if (custom) return `<img loading="lazy" src="${custom}" alt="">`;
  const arts = firstArts(tracks, 4);
  if (arts.length >= 4) return `<div class="collage">${arts.slice(0, 4).map(a => `<img loading="lazy" decoding="async" src="${a}" alt="">`).join('')}</div>`;
  return `<img loading="lazy" decoding="async" src="${arts[0] || PLACEHOLDER}" alt="">`;
}
function collCard({ href, title, sub, tracks, round = false, img, badge }) {
  const key = listKey(tracks.map(t => t.id), title);
  return `<div class="card ${round ? 'round' : ''}" data-href="${esc(href)}">
    <div class="cover">${img ? `<img loading="lazy" decoding="async" src="${img}" alt="">` : collageHtml(tracks)}${badge ? `<span class="badge-cover">${badge}</span>` : ''}${tracks.length ? `<button class="hover-play" data-play-list="${key}" data-i="0" data-ctx-route="${esc(href)}" aria-label="Play"><svg><use href="#i-play"/></svg></button>` : ''}</div>
    <div class="t ellipsis">${esc(title)}</div><div class="s ellipsis">${esc(sub || '')}</div></div>`;
}
function mixCard(m) {
  const href = 'daily/' + m.n, key = listKey(m.tracks.map(t => t.id), `Daily Mix ${m.n}`);
  const lead = m.tracks.find(t => S.art.has(t.id) && !t.designedCover) || m.tracks[0];
  const c = lead?.colors || colorsOf(m.tracks);
  return `<div class="card mix" data-href="${href}" style="${ambient(c)}">
    <div class="cover"><img loading="lazy" decoding="async" src="${artOf(lead)}" alt="">
      <div class="mix-band"><span>Daily Mix</span><b>${String(m.n).padStart(2, '0')}</b>${m.genre ? `<em>${esc(m.genre)}</em>` : ''}</div>
      <button class="hover-play" data-play-list="${key}" data-i="0" data-ctx-route="${href}" aria-label="Play"><svg><use href="#i-play"/></svg></button></div>
    <div class="t ellipsis">${esc(m.sub)}</div><div class="s ellipsis">${count(m.tracks.length)}</div></div>`;
}
function tile({ href, title, tracks, img }) {
  const key = listKey(tracks.map(t => t.id), title);
  return `<div class="tile" data-href="${esc(href)}"><div class="tile-art">${img ? `<img loading="lazy" src="${img}" alt="">` : collageHtml(tracks)}</div><div class="tile-t ellipsis">${esc(title)}</div>
    <button class="tile-play" data-play-list="${key}" data-i="0" data-ctx-route="${esc(href)}" aria-label="Play ${esc(title)}"><svg><use href="#i-play"/></svg></button></div>`;
}
function shelf(title, inner, { more, sub } = {}) {
  if (!inner) return '';
  return `<section class="section"><div class="section-head"><div><h2>${esc(title)}</h2>${sub ? `<div class="section-sub">${esc(sub)}</div>` : ''}</div><div class="shelf-tools">${more ? `<a href="#/${more}" class="see-all">See all</a>` : ''}<button class="icon-btn small shelf-nav" data-action="shelf-prev" aria-label="Scroll back"><svg><use href="#i-back"/></svg></button><button class="icon-btn small shelf-nav" data-action="shelf-next" aria-label="Scroll forward"><svg class="flip"><use href="#i-back"/></svg></button></div></div><div class="shelf">${inner}</div></section>`;
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
    else if (kind === 'creditedArtist') {
      for (const name of artistCredits(t.artist)) {
        if (!m.has(name)) m.set(name, []);
        m.get(name).push(t);
      }
      continue;
    }
    else if (kind === 'album') { if (!t.album) continue; k = `${t.album}\u0001${albumArtist(t)}`; }
    else if (kind === 'mix') k = browseGenre(t.category === 'Music' ? (t.genre || 'Music') : t.category);
    else if (kind === 'genre') { if (!t.genre) continue; k = browseGenre(t.genre); }
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return (gCache.map[kind] = m);
}
function mixTracks(name) {
  const key = browseGenre(name);
  return [...new Set([...(groups('mix').get(key) || []), ...(groups('genre').get(key) || [])])];
}
function playCounts(filter) { const c = new Map(); for (const e of S.log) if (!filter || filter(e)) c.set(e.id, (c.get(e.id) || 0) + 1); return c; }
/** Same counts, worked out once and reused until you play something new (the moments shelves ask for them often). */
const countMemo = new Map();
function memoCounts(key, filter) { const v = S.log.length + ':' + Math.floor(Date.now() / 36e5); const m = countMemo.get(key); if (m && m.v === v) return m.c; const c = playCounts(filter); countMemo.set(key, { v, c }); return c; }
const isNight = e => { const h = new Date(e.at).getHours(); return h >= 22 || h < 4; };
const SMART = {
  'most-played': { title: 'Most Played', desc: 'The songs you play the most', get: ts => ts.filter(t => t.plays > 0).sort((a, b) => b.plays - a.plays || (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 50) },
  'recently-played': { title: 'Recently Played', desc: 'What you’ve listened to lately', get: () => S.history.map(id => T(id)).filter(t => t && visible().includes(t)).slice(0, 50) },
  'recently-added': { title: 'Recently Added', desc: 'Added in the last 30 days', get: ts => ts.filter(t => Date.now() - (t.addedAt || 0) < 30 * DAY).sort(byAdded) },
  'recently-loved': { title: 'Recently Loved', desc: 'Songs you liked in the last month', get: ts => ts.filter(t => t.liked && Date.now() - (t.likedAt || 0) < 30 * DAY).sort((a, b) => b.likedAt - a.likedAt) },
  'rediscover': { title: 'Rediscover', desc: 'Songs you loved but haven’t played in over a month', get: ts => ts.filter(t => (t.plays >= 2 || t.liked) && t.lastPlayed && Date.now() - t.lastPlayed > 30 * DAY).sort((a, b) => (b.plays || 0) - (a.plays || 0)) },
  'forgotten-favorites': { title: 'Forgotten Favorites', desc: 'Liked songs you haven’t played in 45 days', get: ts => ts.filter(t => t.liked && t.lastPlayed && Date.now() - t.lastPlayed > 45 * DAY) },
  'late-night': { title: 'Late Night', desc: 'What you play between 10 pm and 4 am', get: ts => { const c = memoCounts('night', isNight); return ts.filter(t => c.get(t.id)).sort((a, b) => c.get(b.id) - c.get(a.id)); } },
  'never-played': { title: 'Never Played', desc: 'In your library but not played yet', get: ts => ts.filter(t => !t.plays).sort(byAdded) },
};
/** Music only: recitations, lectures, nasheeds and books never enter mixes, Flow, radio or smart playlists. */
const musicOnly = () => visible().filter(isSong);
const smartList = k => SMART[k] ? SMART[k].get(musicOnly()) : [];
const MOODS = {
  chill: { title: 'Chill', test: t => /r&b|soul|jazz|ambient|lo-?fi|acoustic|chill|reggae/i.test(t.genre || '') },
  focus: { title: 'Focus', test: t => /classical|instrumental|ambient|piano|soundtrack|lo-?fi|new age/i.test(t.genre || '') },
  energy: { title: 'Energy', test: t => /hip-?hop|rap|dance|electronic|afro|reggaeton|edm|house|drill|trap/i.test(t.genre || '') },
  latenight: { title: 'Late Night', test: t => memoCounts('night', isNight).has(t.id), note: 'From what you play after 10 pm' },
  rnb: { title: 'R&B', test: t => /r&b|soul/i.test(t.genre || '') },
  hiphop: { title: 'Hip-Hop', test: t => /hip-?hop|rap/i.test(t.genre || '') },
  afrobeats: { title: 'Afrobeats', test: t => /afro|african|highlife|amapiano|naija/i.test(`${t.genre || ''}`) },
  throwbacks: { title: 'Throwbacks', test: t => t.year && +t.year <= new Date().getFullYear() - 10, note: 'Released 10+ years ago' },
};
const moodList = k => MOODS[k] ? musicOnly().filter(t => (t.moods || []).includes(k) || (!(t.moods || []).length && MOODS[k].test(t))) : [];
MOODS.afrobeats.test = t => /afro|african|highlife|amapiano|naija|soukous|coup[eé]|ndombolo|makossa|zouk|bongo|gqom|azonto|hiplife/i.test(t.genre || '');
MOODS.party = { title: 'Party', test: t => /dance|amapiano|afro|soukous|coup[eé]|reggaeton|dancehall|house/i.test(t.genre || '') };
MOODS.workout = { title: 'Workout', test: () => false, note: 'Songs you tagged Workout' };
const MOOD_KEYS = ['chill', 'focus', 'energy', 'party', 'workout', 'latenight', 'throwbacks'];
const GENRES = ['Hip-Hop', 'R&B', 'Afrobeats', 'Amapiano', 'Soukous', 'Coupé-Décalé', 'Highlife', 'Dancehall', 'Reggae', 'Pop', 'Drill', 'Gospel', 'Jazz', 'Rock', 'Latin', 'Country'];

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
  const scored = musicOnly().filter(t => !seedIds.has(t.id)).map(t => {
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
  const genres = new Set(musicOnly().filter(t => set.has(mainArtist(t.artist))).map(t => t.genre).filter(Boolean));
  for (const t of musicOnly()) if (t.genre && genres.has(t.genre)) out.add(mainArtist(t.artist));
  for (const p of S.playlists.values()) {
    const as = p.tracks.map(id => T(id)).filter(Boolean).map(t => mainArtist(t.artist));
    if (as.some(a => set.has(a))) as.forEach(a => out.add(a));
  }
  names.forEach(n => out.delete(n)); out.delete('Unknown Artist');
  return out;
}
/** Fof Flow: endless listening weighted by what you like and play. */
function flowPicks(n = 15) {
  const counts = playCounts(e => Date.now() - e.at < 90 * DAY);
  const recent = new Set([...P.played.slice(-60), ...P.queue.slice(Math.max(0, P.idx - 30), P.idx + 1)]);
  const pool = musicOnly().filter(t => !recent.has(t.id)).map(t => [Math.random() * (1 + (t.liked ? 3 : 0) + Math.min(counts.get(t.id) || 0, 8) * .5 + (t.plays ? .5 : 1)), t]);
  pool.sort((a, b) => b[0] - a[0]);
  // smart order: each song leads into one with a similar feel (genre, loudness, era) so the mix flows
  const cand = pool.slice(0, n * 3).map(x => x[1]);
  const fit = (a, b) => {
    if (!a) return 0;
    let v = 0;
    if (a.genre && b.genre) v += a.genre === b.genre ? 2.2 : -.8;
    if ((a.category || 'Music') !== (b.category || 'Music')) v -= 4;
    if (mainArtist(a.artist) === mainArtist(b.artist)) v -= 6;
    if (isFinite(a.gain) && isFinite(b.gain)) v -= Math.min(Math.abs(a.gain - b.gain), 9) / 3;
    if (a.year && b.year) v -= Math.min(Math.abs(a.year - b.year), 30) / 12;
    return v;
  };
  const out = []; let prev = current();
  while (out.length < n && cand.length) {
    let bi = 0, bv = -Infinity;
    cand.forEach((t, i) => { const v = fit(prev, t) + Math.random() * 1.2 - i * .02; if (v > bv) { bv = v; bi = i; } });
    const [t] = cand.splice(bi, 1); out.push(t.id); prev = t;
  }
  return out;
}

/* =====================================================================
   Daily mixes: groups of artists you play together, reshuffled every day
   ===================================================================== */
function seeded(str) { let h = 1779033703 ^ str.length; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 3432918353); return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; }; }
let mixCache = { key: '', mixes: [] };
function dailyMixes() {
  const day = new Date().toDateString();
  const key = day + S.ver + S.tracks.size;
  if (mixCache.key === key) return mixCache.mixes;
  const music = visible().filter(t => t.category === 'Music' && t.artist !== 'Unknown Artist');
  const out = [];
  if (music.length >= 20) {
    const counts = playCounts(e => Date.now() - e.at < 60 * DAY);
    const arts = [...groups('artist')].filter(([a, ts]) => a !== 'Unknown Artist' && ts[0].category === 'Music')
      .map(([a, ts]) => [a, ts, ts.reduce((s2, t) => s2 + (t.plays || 0) + (t.liked ? 3 : 0) + (counts.get(t.id) || 0) * .5, 0) + ts.length * .4]);
    const byGenre = new Map();
    for (const x of arts) { const g = x[1].find(t => t.genre)?.genre || ''; if (!byGenre.has(g)) byGenre.set(g, []); byGenre.get(g).push(x); }
    let clusters = [];
    for (const [g, list] of byGenre) {
      list.sort((a, b) => b[2] - a[2]);
      const songs = list.reduce((n, x) => n + x[1].length, 0);
      if (!g || songs > 150) { for (let i = 0; i < list.length; i += 10) clusters.push([g, list.slice(i, i + 10)]); }
      else clusters.push([g, list]);
    }
    clusters = clusters.map(([g, list]) => [g, list, list.reduce((n, x) => n + x[2], 0), list.reduce((n, x) => n + x[1].length, 0)]).filter(c => c[3] >= 10).sort((a, b) => b[2] - a[2]).slice(0, 6);
    clusters.forEach(([g, list], i) => {
      const rnd = seeded(day + g + i);
      const pool = list.flatMap(([, ts, sc]) => ts.map(t => [t, rnd() * (1 + Math.min(sc, 20) * .08 + (t.liked ? .6 : 0))]));
      const tracks = pool.sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0]);
      const names = list.slice(0, 3).map(x => x[0]);
      out.push({ n: i + 1, genre: g, tracks, sub: names.join(', ') + (list.length > 3 ? ' and more' : '') });
    });
  }
  mixCache = { key, mixes: out };
  return out;
}
function becauseYouPlayed() {
  const seen = new Set(), out = [];
  for (const id of S.history) {
    const t = T(id); if (!t || t.category !== 'Music') continue;
    const a = mainArtist(t.artist); if (seen.has(a) || a === 'Unknown Artist') continue; seen.add(a);
    const own = groups('artist').get(a) || [];
    const ids = similar(own.slice(0, 8), 14, new Set(own.map(x => x.id))).filter(id2 => mainArtist(T(id2)?.artist) !== a);
    if (ids.length >= 6) out.push([a, ids.map(x => T(x))]);
    if (out.length >= 2) break;
  }
  return out;
}
VIEWS.daily = () => {
  const m = dailyMixes()[+S.param - 1];
  if (!m) return `${back()}<div class="empty-state small"><h2>This mix isn’t available</h2><p>Mixes appear once you have at least 20 songs with artists.</p></div>`;
  return `${back()}${collHead({ img: null, tracks: m.tracks, eyebrow: `Daily Mix · ${m.genre || 'Your artists'} · new every day`, title: `Daily Mix ${m.n}`, ctxRoute: 'daily/' + m.n, meta: `${esc(m.sub)} · ${count(m.tracks.length)}`, actions: dlButton(m.tracks) })}${trackRows(m.tracks, { context: `Daily Mix ${m.n}`, cols: ['album'] })}`;
};

/* =====================================================================
   Views
   ===================================================================== */
function greeting() { const h = new Date().getHours(); return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function mixName(k) { return ['Quran & Recitation', 'Talks & Lectures', 'Nasheeds'].includes(k) ? k : `${k} Mix`; }
function hrefFor(ctx) { return ctx.route.replace(/^#\/?/, ''); }

VIEWS.home = () => {
  const all = visible();
  if (!all.length) return `<div class="page-head"><div><h1>Home</h1></div></div>${emptyLib()}`;
  const cur = current();
  const recent = SMART['recently-played'].get();
  const hero = cur || recent[0] || [...all].sort(byAdded)[0];
  const resumeAt = cur && engine.el.paused ? (spotNow() > 5 ? spotNow() : 0) : 0;
  const heroKey = listKey([hero.id], 'Home');
  // recent places first, then fill with mixes and your own lists so the grid never looks empty
  const seenR = new Set(); const pad = [...dailyMixes().slice(0, 4).map((m, i) => ({ route: '#/daily/' + (i + 1), title: 'Daily Mix' })), { route: '#/liked', title: 'Liked Songs' }, ...Object.entries(SMART).filter(([k]) => k !== 'recently-played').map(([k, d]) => ({ route: '#/smart/' + k, title: d.title }))];
  let ctxTiles = [...S.ctxs, ...pad].filter(c => { const r = hrefFor(c); if (seenR.has(r)) return false; seenR.add(r); return true; }).map(c => ctxTile(c)).filter(Boolean).slice(0, 6);
  if (ctxTiles.length % 2) ctxTiles = ctxTiles.slice(0, -1);
  const dailies = dailyMixes();
  const mixes = [...groups('mix')].filter(([k, ts]) => !(dailies.length && k === 'Music' && ts.length > all.length * .5)).sort((a, b) => b[1].length - a[1].length);
  const because = becauseYouPlayed();
  const smartCards = Object.entries(SMART).map(([k, d]) => [k, d, d.get(all)]).filter(([k, , ts]) => ts.length >= 3 && k !== 'recently-played');
  const liked = all.filter(t => t.liked);
  const artistScore = new Map();
  for (const t of all) { const a = mainArtist(t.artist); if (a === 'Unknown Artist') continue; artistScore.set(a, (artistScore.get(a) || 0) + (t.plays || 0) + (t.liked ? 5 : 0) + .01); }
  const favArtists = [...artistScore].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const hasTaste = [...artistScore.values()].some(v => v >= 1);
  const added = [...all].sort(byAdded).slice(0, 16); const addedKey = listKey(added.map(t => t.id), 'Recently Added');
  const recentKey = listKey(recent.map(t => t.id), 'Recently Played');
  const discover = recent.length ? similar(recent.slice(0, 6), 12).map(id => T(id)).filter(t => (t.plays || 0) <= 1) : [];
  const discoverKey = listKey(discover.map(t => t.id), 'Discover');
  const moods = Object.entries(MOODS).map(([k, m]) => [k, m, moodList(k).length]).filter(x => x[2]);
  return `
  <div class="page-head home-head"><div><h1>Home</h1></div>
    <div class="home-acts"><a class="btn drive-btn" href="#/drive" aria-label="Drive mode"><svg><use href="#i-car"/></svg><span>Drive</span></a><button class="btn flow-btn" data-action="flow"><svg><use href="#i-flow"/></svg>Fof Flow</button></div></div>
  <section class="hero ${cur ? 'live' : ''}" style="${richAmbient(hero.colors)}">
    <div class="hero-art" data-play-list="${heroKey}" data-i="0"><img src="${artOf(hero, 'full')}" alt=""></div>
    <div class="hero-info"><div class="eyebrow">${cur ? '<span class="when-playing">Now Playing</span><span class="when-paused">Paused</span>' : recent.length ? 'Recently Played' : 'Recently Added'}</div>
      <h1 class="ellipsis">${cur ? '<span class="eq hero-eq"><i></i><i></i><i></i></span>' : ''}${esc(hero.title)}</h1><div class="sub ellipsis">${esc(hero.artist)}${hero.album ? ' · ' + esc(hero.album) : ''}</div>
      ${cur ? '<div class="hero-progress"><i id="hero-bar"></i></div>' : ''}
      <div class="row-actions">${cur ? `<button class="btn primary" data-action="toggle"><span class="when-playing"><svg><use href="#i-pause"/></svg>Pause</span><span class="when-paused"><svg><use href="#i-play"/></svg>${resumeAt ? `Resume at ${fmt(resumeAt)}` : 'Resume'}</span></button>` : `<button class="btn primary" data-play-list="${heroKey}" data-i="0"><svg><use href="#i-play"/></svg>Play</button>`}
      ${hero.kind === 'ayah' || hero.kind === 'surahrec' ? `<a class="btn ghost" href="#/quran/${hero.surah}"><svg><use href="#i-quran"/></svg>Open reader</a>` : hero.kind === 'episode' ? `<a class="btn ghost" href="#/show/${hero.showId}"><svg><use href="#i-podcast"/></svg>Show</a>` : hero.kind === 'yt' ? `<a class="btn ghost" href="#/feysal/${hero.albumKey}"><svg><use href="#i-quran"/></svg>All recitations</a>` : `<button class="btn ghost" data-action="radio" data-id="${hero.id}"><svg><use href="#i-radio"/></svg>Song radio</button>`}</div></div>
  </section>
  ${S.wantNew ? (() => { const got = wants().filter(w => w.arrived).sort((a, b) => b.arrived - a.arrived).slice(0, S.wantNew); return `<a class="check-banner want-banner" href="#/import/want"><div class="cb-stack">${got.slice(0, 3).map(w => `<img src="${esc(w.art)}" alt="">`).join('')}</div><div><b>${count(S.wantNew)} from your Want list ${S.wantNew === 1 ? 'is' : 'are'} here</b><span>${esc(got.slice(0, 2).map(w => w.title).join(', '))}${S.wantNew > 2 ? ' and more' : ''}</span></div><svg class="chev"><use href="#i-back"/></svg></a>`; })() : ''}
  ${(() => { const n = reviewList().length; return n ? `<a class="check-banner" href="#/review"><div class="cb-stack">${reviewList().slice(0, 3).map(t => `<img src="${artOf(t)}" alt="">`).join('')}</div><div><b>${count(n)} to check</b><span>Quick look at names Fof Music wasn’t sure about</span></div><svg class="chev"><use href="#i-back"/></svg></a>` : ''; })()}
  ${ctxTiles.length ? `<section class="section"><div class="section-head"><h2>Jump back in</h2></div><div class="tiles">${ctxTiles.join('')}</div></section>` : ''}
  ${dailies.length ? shelf('Daily Mixes', dailies.map(mixCard).join('')) : ''}
  ${recent.length ? shelf('Recently Played', recent.slice(0, 16).map((t, i) => trackCard(t, recentKey, i)).join(''), { more: 'smart/recently-played' }) : ''}
  ${shelf('Made for You', [
    ...smartCards.map(([k, d, ts]) => collCard({ href: 'smart/' + k, title: d.title, sub: d.desc, tracks: ts, badge: '<svg><use href="#i-spark"/></svg>' })),
    ...mixes.map(([k, ts]) => collCard({ href: 'mix/' + k, title: mixName(k), sub: count(ts.length), tracks: ts })),
    liked.length ? collCard({ href: 'liked', title: 'Liked Songs', sub: count(liked.length), tracks: liked }) : '',
  ].join(''))}
  ${moods.length ? `<section class="section"><div class="section-head"><div><h2>Moods</h2></div></div><div class="chips mood-chips">${moods.map(([k, m, n]) => `<button class="chip mood" data-href="mood/${k}">${esc(m.title)}<span>${n}</span></button>`).join('')}</div></section>` : ''}
  ${because.map(([a, ts]) => { const k = listKey(ts.map(t => t.id), 'Because you played ' + a); return shelf(`More Like ${a}`, ts.map((t, i) => trackCard(t, k, i)).join('')); }).join('')}
  ${discover.length >= 3 ? shelf('Rediscover', discover.map((t, i) => trackCard(t, discoverKey, i)).join('')) : ''}
  ${shelf('Recently Added', added.map((t, i) => trackCard(t, addedKey, i)).join(''), { more: 'songs' })}
  ${favArtists.length ? shelf(hasTaste ? 'Favorite Artists' : 'Artists', favArtists.map(([a]) => { const ts = groups('artist').get(a) || []; return collCard({ href: 'artist/' + a, title: a, sub: count(ts.length), tracks: ts, round: true, img: artistImg(ts, a) }); }).join(''), { more: 'artists' }) : ''}
  ${S.log.length >= 5 ? `<a class="insights-link" href="#/replay"><svg><use href="#i-chart"/></svg><div><b>Replay</b><span>${hours(S.log.reduce((a, e) => a + (e.s || 0), 0))} listened</span></div><svg class="chev"><use href="#i-back"/></svg></a>` : ''}`;
};
function ctxTile(c) {
  const h = hrefFor(c); const [r, ...rest] = h.split('/'); const p = rest.join('/');
  let tracks = [], title = c.title, img;
  if (r === 'album') tracks = groups('album').get(p) || [];
  else if (r === 'artist') { tracks = groups('creditedArtist').get(p) || []; img = artOf(tracks[0]); }
  else if (r === 'playlist') { const pl = S.playlists.get(p); if (!pl) return ''; tracks = pl.tracks.map(id => T(id)).filter(Boolean); title = pl.name; img = S.plCovers.get(p); }
  else if (r === 'smart') { tracks = smartList(p); title = SMART[p]?.title; }
  else if (r === 'mix') tracks = mixTracks(p);
  else if (r === 'mood') { tracks = moodList(p); title = MOODS[p]?.title; }
  else if (r === 'daily') { const m = dailyMixes()[+p - 1]; if (!m) return ''; tracks = m.tracks; title = `Daily Mix ${m.n}`; }
  else if (r === 'liked') tracks = visible().filter(t => t.liked);
  if (!tracks.length || !title) return '';
  return tile({ href: h, title, tracks, img });
}


const discoverCache = new Map();
let discoverTimer, discoverVersion = 0;
function catalogLookup(query) {
  return new Promise((resolve, reject) => {
    const callback = 'fofCatalog' + uid();
    const script = document.createElement('script');
    const finish = (error, data) => {
      clearTimeout(timeout);
      script.remove();
      delete window[callback];
      if (error) reject(error);
      else resolve(data.results.filter(t => t.kind === 'song' && t.trackName && t.artistName));
    };
    const timeout = setTimeout(() => finish(Error('Catalog request timed out')), 8000);
    window[callback] = data => data && Array.isArray(data.results)
      ? finish(null, data)
      : finish(Error('Invalid catalog response'));
    script.onerror = () => finish(Error('Catalog unavailable'));
    const params = new URLSearchParams({ term: query, country: 'US', media: 'music', entity: 'song', limit: '30', callback });
    script.src = 'https://itunes.apple.com/search?' + params;
    document.head.append(script);
  });
}
function discoverRows(results) {
  const key = (title, artist) => fold(title) + '\u0000' + fold(artist);
  const library = new Set([...S.tracks.values()].flatMap(t => [
    key(t.title, t.artist),
    ...artistCredits(t.artist).map(a => key(t.title, a)),
  ]));
  const seen = new Set();
  const rows = results.filter(t => {
    if (S.settings.hideExplicit && t.trackExplicitness === 'explicit') return false;
    const id = key(t.trackName, t.artistName);
    if (library.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!rows.length) return '<p class="muted">No new songs found in the catalog.</p>';
  return rows.slice(0, 15).map(t => {
    const query = encodeURIComponent(t.artistName + ' ' + t.trackName + ' official audio');
    const detail = [t.artistName, t.collectionName, t.trackTimeMillis ? fmt(t.trackTimeMillis / 1000) : ''].filter(Boolean);
    return `<div class="toolbar" style="gap:12px;margin-bottom:12px">
      <div style="min-width:0"><div class="ellipsis">${esc(t.trackName)}</div><div class="muted ellipsis">${esc(detail.join(' · '))}</div></div>
      <a class="btn small" href="https://www.youtube.com/results?search_query=${query}" target="_blank" rel="noopener noreferrer">Find official audio</a>
    </div>`;
  }).join('');
}
function refreshDiscover() {
  clearTimeout(discoverTimer);
  const version = ++discoverVersion;
  const box = $('#discover-results');
  const query = S.param.trim();
  if (!box || query.length < 2) return;
  const key = query.toLowerCase();
  if (discoverCache.has(key)) {
    box.innerHTML = discoverRows(discoverCache.get(key));
    return;
  }
  box.textContent = 'Searching the music catalog…';
  discoverTimer = setTimeout(async () => {
    const stillCurrent = () => version === discoverVersion && box.isConnected;
    try {
      const results = await catalogLookup(query);
      if (discoverCache.size >= 40) discoverCache.delete(discoverCache.keys().next().value);
      discoverCache.set(key, results);
      if (stillCurrent()) box.innerHTML = discoverRows(results);
    } catch {
      if (stillCurrent()) box.innerHTML = '<p>Catalog search is unavailable. <button class="chip" data-action="discover-retry">Try again</button></p>';
    }
  }, 400);
}

VIEWS.search = () => {
  const q = S.param;
  const input = `<div class="search-box"><svg><use href="#i-search"/></svg><input id="search-input" class="input" aria-label="Search music" placeholder="Songs, artists, albums" value="${esc(q)}" autocomplete="off" spellcheck="false" enterkeyhint="search">${q ? '<button class="icon-btn small clear-q" data-action="clear-q" aria-label="Clear"><svg><use href="#i-x"/></svg></button>' : ''}</div>`;
  if (!q) {
    const gs = [...groups('mix')].sort((a, b) => b[1].length - a[1].length);
    return `<div class="page-head"><h1>Search</h1></div>${input}
      ${S.searches.length ? `<section class="section"><div class="section-head"><h2>Recent searches</h2><a class="see-all" data-action="clear-searches">Clear</a></div><div class="chips">${S.searches.map(s => `<button class="chip" data-search="${esc(s)}">${esc(s)}</button>`).join('')}</div></section>` : ''}
      ${gs.length ? `<section class="section"><div class="section-head"><h2>Browse your library</h2></div><div class="genre-grid">${gs.map(([k, ts]) => { const c = colorsOf(ts); return `<div class="genre" data-href="mix/${esc(k)}" style="${ambient(c)}"><span>${esc(k)}</span><small>${count(mixTracks(k).length)}</small><img loading="lazy" src="${artOf(ts.find(t => S.thumbs.has(t.id)) || ts[0])}" alt=""></div>`; }).join('')}</div></section>` : ''}`;
  }
  const filter = S.searchView || 'all';
  const tabs = `<div class="chips" aria-label="Search filters">${[['all', 'All'], ['library', 'In Library'], ['discover', 'Discover']].map(([key, label]) => `<button class="chip ${key === filter ? 'on' : ''}" aria-pressed="${key === filter}" data-action="search-view" data-view="${key}">${label}</button>`).join('')}</div>`;
  const page = `<div class="page-head"><h1>Search</h1></div>${input}${tabs}`;
  const discover = filter === 'library' ? '' : `<section class="section"><div class="section-head"><div><h2>Discover</h2><div class="section-sub">iTunes catalog</div></div></div><div id="discover-results" class="muted" aria-live="polite">${q.trim().length < 2 ? 'Enter at least two characters to search the catalog.' : ''}</div></section>`;
  if (filter === 'discover') return page + discover;
  const res = S.index.search(q, 300).filter(r => r.kind !== 'song' || !(S.settings.hideExplicit && T(r.key)?.explicit));
  const songs = res.filter(r => r.kind === 'song').map(r => T(r.key)).filter(Boolean).filter(t => !(S.settings.hideExplicit && t.explicit));
  const artists = res.filter(r => r.kind === 'artist').slice(0, 12);
  const albums = res.filter(r => r.kind === 'album').slice(0, 12);
  const pls = res.filter(r => r.kind === 'playlist').slice(0, 8);
  const genres = res.filter(r => r.kind === 'genre').slice(0, 8);
  if (!res.length) return `${page}<section class="section"><div class="section-head"><h2>In Library</h2></div><p class="muted">No library matches for “${esc(q)}”.</p></section>${discover}`;
  const top = res[0];
  const songKey = listKey(songs.map(t => t.id), 'Search');
  let topHtml = '';
  if (top.kind === 'song') { const t = T(top.key); topHtml = `<div class="top-result sr-item" data-play-list="${songKey}" data-i="0" style="${ambient(t.colors)}"><img src="${artOf(t)}" alt=""><div><div class="eyebrow">Song</div><h2 class="ellipsis">${esc(t.title)}</h2><div class="muted ellipsis">${esc(t.artist)}</div></div><span class="hover-play show"><svg><use href="#i-play"/></svg></span></div>`; }
  else { const ts = top.kind === 'artist' ? groups('creditedArtist').get(top.key) : top.kind === 'album' ? groups('album').get(top.key) : top.kind === 'genre' ? mixTracks(top.key) : S.playlists.get(top.key)?.tracks.map(id => T(id)).filter(Boolean);
    const href = top.kind === 'playlist' ? 'playlist/' + top.key : top.kind === 'genre' ? 'mix/' + top.key : top.kind + '/' + top.key;
    topHtml = `<div class="top-result sr-item" data-href="${esc(href)}" style="${ambient(colorsOf(ts || []))}"><div class="${top.kind === 'artist' ? 'round' : ''} tr-art">${collageHtml(ts || [])}</div><div><div class="eyebrow">${{ artist: 'Artist', album: 'Album', playlist: 'Playlist', genre: 'Genre' }[top.kind]}</div><h2 class="ellipsis">${esc(top.primary)}</h2><div class="muted">${count((ts || []).length)}</div></div></div>`; }
  return `${page}<div class="section-head" style="margin-top:24px"><h2>In Library</h2></div>
    <div class="search-top"><section><div class="section-head"><h2>Top result</h2></div>${topHtml}</section>
    ${songs.length ? `<section><div class="section-head"><h2>Songs</h2></div>${trackRows(songs.slice(0, 5), { key: songKey, context: 'Search', header: false, cols: [] })}</section>` : ''}</div>
    ${artists.length ? shelf('Artists', artists.map(r => { const ts = groups('creditedArtist').get(r.key) || []; return collCard({ href: 'artist/' + r.key, title: r.key, sub: count(ts.length), tracks: ts, round: true, img: artOf(ts[0]) }); }).join('')) : ''}
    ${albums.length ? shelf('Albums', albums.map(r => { const ts = groups('album').get(r.key) || []; const [al, ar] = r.key.split('\u0001'); return collCard({ href: 'album/' + r.key, title: al, sub: ar, tracks: ts }); }).join('')) : ''}
    ${pls.length ? shelf('Playlists', pls.map(r => { const p = S.playlists.get(r.key); return p ? collCard({ href: 'playlist/' + p.id, title: p.name, sub: count(p.tracks.length), tracks: p.tracks.map(id => T(id)).filter(Boolean), img: S.plCovers.get(p.id) }) : ''; }).join('')) : ''}
    ${genres.length ? `<section class="section"><div class="section-head"><h2>Genres</h2></div><div class="chips">${genres.map(r => `<button class="chip" data-href="mix/${esc(r.key)}">${esc(r.key)}</button>`).join('')}</div></section>` : ''}
    ${songs.length > 5 ? `<section class="section"><div class="section-head"><h2>All songs</h2><span class="muted">${songs.length}</span></div>${trackRows(songs, { context: 'Search', cols: ['album'] })}</section>` : ''}${discover}`;
};
function rebuildIndex() {
  const e = [];
  for (const t of S.tracks.values()) e.push({ kind: 'song', key: t.id, text: `${t.title} ${t.artist} ${t.album || ''} ${t.genre || ''}`, primary: t.title, weight: 1.2 + Math.min(t.plays || 0, 20) * .1 + (t.liked ? 1 : 0) });
  for (const [a, ts] of groups('creditedArtist')) e.push({ kind: 'artist', key: a, text: a, primary: a, weight: 2 + Math.min(ts.length, 10) * .1 });
  for (const [k] of groups('album')) { const [al, ar] = k.split('\u0001'); e.push({ kind: 'album', key: k, text: `${al} ${ar}`, primary: al, weight: 1 }); }
  for (const p of S.playlists.values()) e.push({ kind: 'playlist', key: p.id, text: p.name, primary: p.name, weight: 1.5 });
  for (const [g] of groups('genre')) e.push({ kind: 'genre', key: g, text: [g, ...(genreFamilies.get(g) || [])].join(' '), primary: g, weight: .5 });
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
    ${trackRows(list, { key: k, context: cat || 'Songs', cols: ['album', ...(list.some(t => Date.now() - (t.addedAt || 0) > DAY) ? ['added'] : []), ...(list.some(t => t.plays) ? ['plays'] : [])], sortKey: S.settings.songSort, sortDir: S.settings.songDir, sortScope: 'songs' })}`;
};
/** Artist pictures: a real photo when Deezer has one for this exact name, otherwise one of their covers. */
const ARTIST_PICS = {}; let picsLoaded = false, picQueue = [], picBusy = false, picRender;
kv.get('artistPics', {}).then(v => { Object.assign(ARTIST_PICS, v); picsLoaded = true; });
async function nextPic() {
  if (picBusy || !navigator.onLine) return; picBusy = true;
  while (picQueue.length) {
    const name = picQueue.shift(); const k = fold(name); if (k in ARTIST_PICS) continue;
    try { ARTIST_PICS[k] = await artistPhoto(name) || ''; } catch { break; }
    kv.set('artistPics', ARTIST_PICS);
    if (ARTIST_PICS[k]) { clearTimeout(picRender); picRender = setTimeout(() => { if (['artists', 'artist', 'home'].includes(S.route)) render(); }, 800); }
    await new Promise(r => setTimeout(r, 250));
  }
  picBusy = false;
}
const artistImg = (ts, name) => {
  if (name && picsLoaded && !/^unknown/i.test(name)) { const k = fold(name); if (ARTIST_PICS[k]) return ARTIST_PICS[k]; if (!(k in ARTIST_PICS) && !picQueue.includes(name)) { picQueue.push(name); setTimeout(nextPic, 300); } }
  return artOf(ts.find(t => S.thumbs.has(t.id) || S.art.has(t.id)) || ts[0]);
};
VIEWS.artists = () => {
  const g = [...groups('creditedArtist')].sort((a, b) => a[0].localeCompare(b[0]));
  if (!g.length) return `<div class="page-head"><h1>Artists</h1></div>${emptyLib()}`;
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Artists</h1></div><span class="muted">${g.length}</span></div>${bigGrid(g, ([a, ts]) => collCard({ href: 'artist/' + a, title: a, sub: count(ts.length), tracks: ts, round: true, img: artistImg(ts, a) }))}`;
};
VIEWS.artist = () => {
  if (S.param === feysal.NAME) return VIEWS.feysal();
  const name = S.param; const ts = groups('creditedArtist').get(name) || [];
  if (!ts.length) return `${back()}<div class="empty-state small"><h2>Artist not found</h2></div>`;
  const popular = [...ts].sort((a, b) => (b.plays || 0) - (a.plays || 0) || (b.liked - a.liked) || byAdded(a, b));
  const albums = [...groups('album')].filter(([k, a]) => k.split('\u0001')[1] === name || a.some(t => mainArtist(t.artist) === name));
  const rel = [...relatedArtists([name])].map(a => [a, groups('artist').get(a)]).filter(x => x[1]).slice(0, 12);
  const listened = ts.reduce((a, t) => a + (t.plays || 0), 0);
  return `${back()}${collHead({ img: artistImg(ts, name), tracks: popular, eyebrow: 'Artist', title: name, meta: `${count(ts.length)}${albums.length ? ` · ${albums.length} album${albums.length > 1 ? 's' : ''}` : ''}${listened ? ` · ${listened} play${listened > 1 ? 's' : ''}` : ''}`, round: true, ctxRoute: 'artist/' + name,
    actions: `<button class="btn ghost" data-action="radio-artist" data-name="${esc(name)}"><svg><use href="#i-radio"/></svg>Artist radio</button>${dlButton(ts)}${groups('artist').has(name) ? `<button class="btn ghost" data-action="artist-genre" data-name="${esc(name)}">${esc(ts.find(t => t.genre)?.genre || 'Set genre')}</button>` : ''}` })}
    <section class="section"><div class="section-head"><h2>${listened ? 'Popular in your library' : 'Songs'}</h2></div>${trackRows(popular.slice(0, ts.length > 8 ? 5 : 8), { context: name, header: false, cols: ['album'] })}</section>
    ${albums.length ? shelf('Albums', albums.map(([k, a]) => collCard({ href: 'album/' + k, title: k.split('\u0001')[0], sub: a[0].year || count(a.length), tracks: a })).join('')) : ''}
    ${ts.length > 8 ? `<section class="section"><div class="section-head"><h2>All songs</h2></div>${trackRows(sorted(ts, 'title', 1), { context: name, cols: ['album', 'plays'] })}</section>` : ''}
    ${rel.length ? shelf('Similar Artists', rel.map(([a, x]) => collCard({ href: 'artist/' + a, title: a, sub: 'Artist', tracks: x, round: true, img: artistImg(x, a) })).join('')) : ''}`;
};
VIEWS.albums = () => {
  const g = [...groups('album')].sort((a, b) => a[0].localeCompare(b[0]));
  if (!g.length) return `<div class="page-head"><h1>Albums</h1></div>${visible().length ? '<div class="empty-state small"><h2>No albums yet</h2><p>Songs with an album name show up here. You can add one from a song’s Edit info.</p></div>' : emptyLib()}`;
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Albums</h1></div><span class="muted">${g.length}</span></div>${bigGrid(g, ([k, ts]) => { const [al, ar] = k.split('\u0001'); return collCard({ href: 'album/' + k, title: al, sub: ar, tracks: ts }); })}`;
};
VIEWS.album = () => {
  { const [al, ar] = String(S.param).split('\u0001'); if (ar === feysal.NAME) { const a = feysal.ALBUMS.find(x => x.title === al); return VIEWS.feysal(a?.k); } }
  const [al, ar] = S.param.split('\u0001');
  const ts = [...(groups('album').get(S.param) || [])].sort((a, b) => (+a.disc || 1) - (+b.disc || 1) || (+a.trackNo || 999) - (+b.trackNo || 999) || a.title.localeCompare(b.title));
  if (!ts.length) return `${back()}<div class="empty-state small"><h2>Album not found</h2></div>`;
  const year = ts.find(t => t.year)?.year;
  return `${back()}${collHead({ img: artOf(ts[0], 'full'), tracks: ts, eyebrow: 'Album', title: al, ctxRoute: 'album/' + S.param,
    meta: `<a href="#/artist/${encodeURIComponent(ar)}" class="strong">${esc(ar)}</a>${year ? ' · ' + year : ''} · ${count(ts.length)}, ${total(ts)}${ts[0].genre ? ' · ' + esc(ts[0].genre) : ''}`,
    actions: `${dlButton(ts)}<button class="btn ghost" data-action="add-all" data-list-ids="${ts.map(t => t.id).join(',')}"><svg><use href="#i-plus"/></svg>Add to playlist</button>` })}
    ${trackRows(ts, { context: al, cols: ['plays'] })}`;
};
VIEWS.liked = () => {
  const ts = visible().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
  return `${collHead({ img: null, tracks: ts, eyebrow: 'Playlist', title: 'Liked Songs', ctxRoute: 'liked', meta: ts.length ? `${count(ts.length)} · ${total(ts)}` : 'Tap the heart on any song to save it here.', actions: dlButton(ts) })}${ts.length ? trackRows(ts, { context: 'Liked Songs', cols: ['album', 'added'] }) : ''}`;
};
VIEWS.playlist = () => {
  const p = S.playlists.get(S.param);
  if (!p) return `<div class="empty-state small"><h2>Playlist not found</h2></div>`;
  let ts = p.tracks.map(id => T(id)).filter(t => t && !(S.settings.hideExplicit && t.explicit));
  const sort = p.sort || 'custom', f = S.plFilter?.[p.id] || '';
  if (f) ts = ts.filter(t => fold(`${t.title} ${t.artist} ${t.album}`).includes(fold(f)));
  if (sort !== 'custom') ts = sorted(ts, sort, sort === 'added' ? -1 : 1);
  const canDrag = sort === 'custom' && !f;
  return `${collHead({ img: null, custom: S.plCovers.get(p.id), tracks: p.tracks.map(id => T(id)).filter(Boolean), eyebrow: 'Playlist', title: p.name, ctxRoute: 'playlist/' + p.id,
      meta: p.tracks.length ? `${count(p.tracks.length)} · ${total(p.tracks.map(id => T(id)).filter(Boolean))}` : 'Add songs from any song’s ••• menu, or the Add songs button.',
      actions: `${dlButton(p.tracks.map(id => T(id)).filter(Boolean))}<button class="btn ghost" data-action="pl-add-songs" data-pl="${p.id}"><svg><use href="#i-plus"/></svg>Add songs</button><button class="icon-btn" data-action="playlist-menu" data-pl="${p.id}" aria-label="Playlist options"><svg><use href="#i-more"/></svg></button>` })}
    ${growBox(p)}
    ${p.tracks.length ? `<div class="toolbar"><div class="seg">${[['custom', 'Custom order'], ['title', 'Title'], ['artist', 'Artist'], ['added', 'Recently added']].map(([k, l]) => `<button class="${k === sort ? 'on' : ''}" data-action="pl-sort" data-pl="${p.id}" data-sort="${k}">${l}</button>`).join('')}</div>
      <div class="filter-box"><svg><use href="#i-search"/></svg><input class="input" id="pl-filter" data-pl="${p.id}" placeholder="Find in playlist" value="${esc(f)}"></div></div>
      ${trackRows(ts, { context: p.name, key: 'pl:' + p.id, sortable: canDrag ? 'pl:' + p.id : '', cols: ['album', 'added'] })}` : ''}
    ${p.missing?.length ? `<section class="section"><div class="section-head"><div><h2>Not in your library yet</h2><div class="section-sub">${p.missing.length} from your Apple Music playlist. Add them to Fof Music and they drop into this playlist on their own.</div></div><button class="btn small ghost" data-action="copy-missing" data-pl="${p.id}">Copy list</button></div>
      <div class="missing-list">${p.missing.map(m => `<div class="miss"><span class="ellipsis">${esc(m.title)}</span><span class="muted ellipsis">${esc(m.artist || '')}</span></div>`).join('')}</div></section>` : ''}`;
};
VIEWS.smart = () => {
  const d = SMART[S.param]; if (!d) return `<div class="empty-state small"><h2>Not found</h2></div>`;
  const ts = smartList(S.param);
  return `${back()}${collHead({ img: null, tracks: ts, eyebrow: d.moment ? 'Made for you · updates daily' : 'Smart playlist · updates itself', title: d.title, ctxRoute: 'smart/' + S.param, meta: `${esc(d.desc)}${ts.length ? ` · ${count(ts.length)}` : ''}`,
      actions: ts.length ? `${dlButton(ts)}<button class="btn ghost" data-action="save-list" data-name="${esc(d.title)}" data-list-ids="${ts.map(t => t.id).join(',')}">Save as playlist</button>` : '' })}
    ${ts.length ? trackRows(ts, { context: d.title, cols: ['album', S.param === 'recently-added' ? 'added' : S.param === 'never-played' ? 'added' : 'plays', 'last'] }) : '<div class="empty-state small"><p>Nothing here yet. This fills in as you listen.</p></div>'}`;
};
VIEWS.mix = () => {
  const k = browseGenre(S.param); const ts = mixTracks(k);
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
  const smarts = Object.entries(SMART).filter(([, d]) => !d.moment).map(([k, d]) => [k, d, d.get(visible())]).filter(x => x[2].length);
  return `<div class="page-head"><h1>Library</h1><a class="icon-btn" href="#/settings" aria-label="Settings"><svg><use href="#i-gear"/></svg></a></div>
    <div class="lib-rows">${row('books', 'book', 'Audiobooks', books().size || '')}${row('songs', 'note', 'Songs', visible().length)}${row('artists', 'mic', 'Artists', groups('creditedArtist').size)}${row('albums', 'album', 'Albums', groups('album').size)}${row('liked', 'heart', 'Liked Songs', visible().filter(t => t.liked).length)}${S.log.length ? row('replay', 'spark', 'Replay ' + new Date().getFullYear(), '') + row('insights', 'chart', 'Your listening', '') : ''}${row('import', 'upload', 'Add music', '')}${row('cleanup', 'check', 'Clean Up', cleanupCount() || '')}${reviewList().length ? row('review', 'check', 'Check these', reviewList().length) : ''}</div>
    ${momentShelf()}
    <section class="section"><div class="section-head"><h2>Playlists</h2><div class="row-actions"><a class="see-all" data-action="pick-playlists">Import from Apple Music</a><a class="see-all" data-action="new-playlist">New playlist</a></div></div>
    ${pls.length ? `<div class="grid">${pls.map(p => collCard({ href: 'playlist/' + p.id, title: p.name, sub: count(p.tracks.length), tracks: p.tracks.map(id => T(id)).filter(Boolean), img: S.plCovers.get(p.id) })).join('')}</div>` : '<p class="muted">No playlists yet.</p>'}</section>
    ${smarts.length ? `<section class="section"><div class="section-head"><h2>Smart playlists</h2></div><div class="grid">${smarts.map(([k, d, ts]) => collCard({ href: 'smart/' + k, title: d.title, sub: count(ts.length), tracks: ts, badge: '<svg><use href="#i-spark"/></svg>' })).join('')}</div></section>` : ''}`;
};
VIEWS.history = () => {
  const ts = P.played.slice().reverse().map(id => T(id)).filter(Boolean);
  return `${back()}<div class="page-head"><div><div class="eyebrow">This session</div><h1>Playback history</h1></div></div>${ts.length ? trackRows(ts, { context: 'History', cols: ['album'] }) : '<div class="empty-state small"><p>Songs you play show up here.</p></div>'}`;
};
VIEWS.insights = () => {
  const log = S.log;
  if (!log.length) return `${back()}<div class="page-head"><h1>Your listening</h1></div><div class="empty-state small"><h2>Nothing yet</h2><p>Play some music and your listening stats show up here. Only real plays count.</p></div>`;
  const secs = log.reduce((a, e) => a + (e.s || 0), 0);
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const thisMonth = log.filter(e => e.at >= month.getTime());
  const songC = playCounts(), artC = new Map(), genC = new Map();
  for (const e of log) { const t = T(e.id); if (!t) continue; const a = mainArtist(t.artist); artC.set(a, (artC.get(a) || 0) + (e.s || 0)); if (t.genre || t.category !== 'Music') { const g = t.genre || t.category; genC.set(g, (genC.get(g) || 0) + (e.s || 0)); } }
  const topSongs = [...songC].filter(([id]) => S.tracks.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topArtists = [...artC].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topGenres = [...genC].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const firsts = new Map(); for (const e of log) if (!firsts.has(e.id)) firsts.set(e.id, e.at);
  const discovered = [...firsts].filter(([id, at]) => Date.now() - at < 30 * DAY && S.tracks.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => T(id));
  const months = []; for (let i = 5; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); d.setHours(0, 0, 0, 0); const e = new Date(d); e.setMonth(e.getMonth() + 1); months.push([d.toLocaleDateString(undefined, { month: 'short' }), log.filter(x => x.at >= d && x.at < e).reduce((a, x) => a + (x.s || 0), 0)]); }
  const maxM = Math.max(...months.map(m => m[1]), 1);
  const hoursArr = Array(24).fill(0); for (const e of log) hoursArr[new Date(e.at).getHours()] += e.s || 0;
  const peak = hoursArr.indexOf(Math.max(...hoursArr));
  const tsKey = listKey(topSongs.map(([id]) => id), 'Your top songs');
  const maxA = topArtists[0]?.[1] || 1;
  return `${back()}<div class="page-head"><div><div class="eyebrow">Insights</div><h1>Your listening</h1><div class="lede">Based only on songs you’ve actually played in Fof Music.</div></div></div>
    <div class="stats">
      <div class="stat"><b>${hours(secs)}</b><span>Total listening</span></div>
      <div class="stat"><b>${hours(thisMonth.reduce((a, e) => a + (e.s || 0), 0))}</b><span>This month</span></div>
      <div class="stat"><b>${new Set(log.map(e => e.id)).size}</b><span>Different songs</span></div>
      <div class="stat"><b>${new Date(2000, 0, 1, peak).toLocaleTimeString(undefined, { hour: 'numeric' })}</b><span>Your peak hour</span></div>
    </div>
    <div class="insight-grid">
      <section class="panel"><div class="section-head"><h2>Top songs</h2>${topSongs.length ? `<button class="btn small" data-play-list="${tsKey}" data-i="0"><svg><use href="#i-play"/></svg>Play</button>` : ''}</div>
        ${topSongs.map(([id, n], i) => { const t = T(id); return `<div class="rank" data-play-list="${tsKey}" data-i="${i}"><span class="rank-n">${i + 1}</span><img src="${artOf(t)}" alt=""><div class="ellipsis"><b class="ellipsis">${esc(t.title)}</b><span class="muted ellipsis">${esc(t.artist)}</span></div><span class="muted">${n} play${n > 1 ? 's' : ''}</span></div>`; }).join('')}</section>
      <section class="panel"><div class="section-head"><h2>Top artists</h2></div>
        ${topArtists.map(([a, s]) => `<a class="bar-row" href="#/artist/${encodeURIComponent(a)}"><span class="ellipsis">${esc(a)}</span><div class="bar"><i style="width:${Math.max(4, s / maxA * 100)}%"></i></div><span class="muted">${hours(s)}</span></a>`).join('')}
        ${topGenres.length ? `<div class="section-head" style="margin-top:22px"><h2>Genres</h2></div><div class="chips">${topGenres.map(([g, s]) => `<button class="chip" data-href="mix/${esc(g)}">${esc(g)} <span>${hours(s)}</span></button>`).join('')}</div>` : ''}</section>
      <section class="panel"><div class="section-head"><h2>Last 6 months</h2></div><div class="months">${months.map(([l, s]) => `<div class="mcol"><div class="mbar"><i style="height:${s / maxM * 100}%"></i></div><span>${l}</span><small>${s ? hours(s) : ''}</small></div>`).join('')}</div></section>
    </div>
    ${discovered.length ? shelf('New to You', discovered.map((t, i) => trackCard(t, listKey(discovered.map(x => x.id), 'Recently discovered'), i)).join(''), {}) : ''}`;
};

/* =====================================================================
   Review tray: songs Fof Music isn't sure about
   ===================================================================== */
function needsReview(t, always = false) {
  if (!S.settings.askUnsure && !always) return false; // songs that can't be identified keep their cleaned-up name
  if (t.reviewed || t.edited || t.matched) return false;
  if (t.artist === 'Unknown Artist' || meta.looksLikeChannel(t.artist, S.channels)) return true;
  if (t.category !== 'Music') return false;
  if (t.designedCover) return true;
  const o = t.original;
  // artist came straight from a download's tag, with no "Artist - Title" in the name to confirm it
  return !!(o && !meta.isReliable(o) && o.artist && fold(o.artist) === fold(t.artist) && !/\s[-–—]\s/.test(o.title || ''));
}
const reviewList = (always = false) => [...S.tracks.values()].filter(t => needsReview(t, always)).sort(byAdded);
function reviewRow(t) {
  const chan = t.original?.artist && fold(t.original.artist) === fold(t.artist) ? t.artist : '';
  return `<div class="rv" data-rv="${t.id}">
    <button class="rv-art" data-action="rv-art" data-id="${t.id}" title="Change artwork"><img src="${artOf(t)}" alt=""><span>Change</span></button>
    <div class="rv-fields">
      <input class="input rv-title" value="${esc(t.title)}" aria-label="Title" data-f="title">
      <input class="input rv-artist ${t.artist === 'Unknown Artist' ? 'empty' : ''}" value="${esc(t.artist === 'Unknown Artist' ? '' : t.artist)}" placeholder="Who is the artist?" aria-label="Artist" data-f="artist" list="artist-list">
      <div class="rv-meta"><span class="dim ellipsis">${esc(t.original?.file || t.file || '')}</span>${chan ? `<button class="link" data-action="rv-channel" data-id="${t.id}" data-name="${esc(chan)}">Is “${esc(chan)}” a channel, not the artist?</button>` : ''}</div>
      <div class="chips small">${GENRES.slice(0, 10).map(g => `<button class="chip ${t.genre === g ? 'on' : ''}" data-action="rv-genre" data-id="${t.id}" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div>
    </div>
    <div class="rv-actions"><button class="btn small" data-action="play-one" data-id="${t.id}" aria-label="Play"><svg><use href="#i-play"/></svg></button><button class="btn small primary" data-action="rv-ok" data-id="${t.id}">Keep</button></div>
  </div>`;
}
VIEWS.review = () => {
  const list = reviewList(true);
  const artists = knownArtists();
  return `${back()}<div class="page-head"><div><div class="eyebrow">Library</div><h1>Songs to Name</h1><div class="lede">Not found in Apple Music, Deezer or by sound. Fix the name or keep it.</div></div>
    ${list.length > 1 ? `<button class="btn ghost" data-action="rv-all">Keep all</button>` : ''}</div>
    <datalist id="artist-list">${artists.map(a => `<option value="${esc(a)}">`).join('')}</datalist>
    ${list.length ? `<div class="rv-list">${list.map(reviewRow).join('')}</div>` : '<div class="empty-state small"><div class="empty-mark"><svg><use href="#i-check"/></svg></div><h2>All clear</h2><p>Every song has a name and artist Fof Music is confident about.</p></div>'}`;
};
async function saveReview(id, { approve = false } = {}) {
  const t = T(id); const row = document.querySelector(`[data-rv="${id}"]`); if (!t || !row) return;
  const title = row.querySelector('[data-f=title]').value.trim(), artist = row.querySelector('[data-f=artist]').value.trim();
  const before = t.artist, beforeTitle = t.title;
  if (title) t.title = title;
  t.artist = artist || 'Unknown Artist';
  if (artist && before !== artist) {
    // "Bayjay Sundaygar Dearboy Slowed + Reverb" with artist Sundaygar Dearboy → "Bayjay Slowed + Reverb"
    const re = new RegExp('(^|\\s)' + artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'i');
    const stripped = t.title.replace(re, ' ').replace(/^\s*[-–—x&,]\s*|\s*[-–—&,]\s*$/gi, '').replace(/\s{2,}/g, ' ').trim();
    if (stripped && stripped !== t.title) { t.title = stripped; row.querySelector('[data-f=title]').value = stripped; }
  }
  if (artist && before !== artist && t.original?.artist && fold(t.original.artist) === fold(before) && !S.channels.includes(before) && meta.looksLikeChannel(before)) { S.channels.push(before); kv.set('channels', S.channels); }
  t.category = meta.categorize(t);
  learnFix(t, { title: beforeTitle, artist: before });
  if (approve) t.reviewed = true;
  if (t.designedCover && (title || artist)) { const art = await meta.makeCover(t.title, t.artist, t.category); await setArt(t, art); }
  S.ver++; await saveTrack(t);
  if (approve && artist && artist !== 'Unknown Artist' && navigator.onLine && !t.matched) {
    // a confirmed artist lets the strict catalog lookup try again for real artwork
    const found = await meta.lookup({ title: t.title, artist: t.artist, duration: t.duration });
    if (found) { try { const b = await meta.fetchImage(found.artUrl); await setArt(t, b); t.designedCover = false; } catch {} Object.assign(t, { album: t.album || found.album, genre: t.genre || found.genre, year: t.year || found.year, matched: true }); await saveTrack(t); }
  }
}
async function markChannel(name) {
  if (!S.channels.includes(name)) { S.channels.push(name); await kv.set('channels', S.channels); queueStatePush(); }
  let n = 0;
  for (const t of S.tracks.values()) {
    if (t.edited || fold(t.artist) !== fold(name)) continue;
    const o = await originalOf(t);
    const base = meta.cleanNames(o, o.file || t.file || '', knownArtists(), S.channels);
    Object.assign(t, { title: base.title, artist: base.artist }); t.category = meta.categorize(t);
    if (t.designedCover) await setArt(t, await meta.makeCover(t.title, t.artist, t.category));
    await saveTrack(t); n++;
  }
  S.ver++; render(); toast(`“${name}” won’t be used as an artist again${n > 1 ? ` · ${n} songs updated` : ''}`);
}
/** Setting a genre on one song also fills it in for that artist's other songs that have none. */
async function setGenre(id, g) {
  const t = T(id); if (!t) return;
  t.genre = t.genre === g ? '' : g; t.genreByUser = true;
  await saveTrack(t);
  const others = [...S.tracks.values()].filter(x => x !== t && t.genre && mainArtist(x.artist) === mainArtist(t.artist) && x.artist !== 'Unknown Artist' && !x.genre);
  for (const x of others) { x.genre = t.genre; await saveTrack(x); }
  S.ver++;
  if (others.length) toast(`Also set ${t.genre} for ${count(others.length)} by ${mainArtist(t.artist)}`);
}

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
  if (S.param === 'check') return checkPlaylistView();
  if (S.param === 'want') return wantView();
  if (!S.param && !IMP.jobs.length && wants().some(w => !w.arrived)) return wantView();
  const signedOut = cloud.cloudConfigured() && !S.user;
  const st = IMP;
  const failed = st.jobs.filter(j => j.state === 'error');
  return `<div class="page-head"><div><h1>Add Music</h1></div></div>${addTabs('files')}<div class="lede add-lede">MP3, M4A, AAC, FLAC or WAV</div>
    <div class="drop" id="drop">
      <div class="drop-icon"><svg><use href="#i-upload"/></svg></div>
      <div class="drop-text"><h2>${IS_IOS ? 'Add songs from Files' : 'Drop a folder or songs here'}</h2><p>${IS_IOS ? 'Choose songs from Files.' : 'Drop songs or a folder here.'}</p></div>
      <div class="row-actions">${IS_IOS ? '' : '<button class="btn primary" data-action="pick-folder"><svg><use href="#i-album"/></svg>Choose folder</button>'}<button class="btn ${IS_IOS ? 'primary' : ''}" data-action="pick-files"><svg><use href="#i-note"/></svg>Choose songs</button></div>
    </div>
    ${CAN_WATCH ? `<div class="folder-card">${S.folder ? `<div class="fc-icon on"><svg><use href="#i-check"/></svg></div><div class="fc-text"><b>Watching “${esc(S.folder.name)}”</b><span>${S.lastScan ? 'Checked ' + new Date(S.lastScan).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'New songs are added automatically'}</span></div><button class="btn small" data-action="scan-folder">Check now</button><button class="btn small ghost" data-action="disconnect-folder">Stop</button>`
      : `<div class="fc-icon"><svg><use href="#i-flow"/></svg></div><div class="fc-text"><b>Watch a folder</b><span>New songs saved there are added automatically</span></div><button class="btn small primary" data-action="connect-folder">Connect folder</button>`}</div>` : ''}
    <div class="folder-card"><div class="fc-icon"><svg><use href="#i-note"/></svg></div><div class="fc-text"><b>Apple Music playlists</b><span>In Music: File › Library › Export Playlist, then choose the file here</span></div><button class="btn small" data-action="pick-playlists">Choose playlist files</button></div>
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
async function importFiles(files, { retry = false, background = false } = {}) {
  const audio = files.filter(f => meta.AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
  if (!audio.length) { toast(files.length ? 'No songs found there. Fof Music reads MP3, M4A, AAC, FLAC and WAV.' : 'Nothing selected'); return; }
  if (IMP.running) { toast('Still importing. Wait for it to finish first.'); return; }
  if (S.route !== 'import' && !background) go('import');
  if (!retry) Object.assign(IMP, { jobs: [], found: 0, added: 0, skipped: 0, failed: 0, maybeDup: 0 });
  const jobs = audio.map(f => ({ key: uid(), file: f, name: f.name.replace(/\.[^.]+$/, ''), status: 'Waiting', state: 'wait' }));
  if (retry) { IMP.failed -= jobs.length; IMP.jobs = IMP.jobs.filter(j => j.state !== 'error'); } else IMP.found = jobs.length;
  IMP.jobs.unshift(...jobs); IMP.cancel = false; IMP.running = true;
  if (S.route === 'import') render(); else if (background) toast(`Adding ${count(jobs.length)} from your folder…`);
  const queue = [...jobs];
  const known = { hashes: new Set([...S.tracks.values()].map(t => t.hash).filter(Boolean)), keys: new Map([...S.tracks.values()].map(t => [meta.dupKey(t), t])) };
  await Promise.all(Array.from({ length: IS_IOS ? 3 : 6 }, async () => {
    while (queue.length && !IMP.cancel) {
      const j = queue.shift();
      try { const r = await importOne(j, known); if (r === 'skip') IMP.skipped++; else { IMP.added++; if (r === 'maybe') IMP.maybeDup++; } }
      catch (e) {
        console.error(e); IMP.failed++; j.state = 'error';
        j.status = isQuotaError(e) ? 'Out of space' : e.message === 'unplayable' ? 'Can’t play this format' : e.message === 'empty' ? 'Empty or broken file' : 'Couldn’t read this file';
        updateImportRow(j);
        if (isQuotaError(e)) { IMP.cancel = true; quotaWarning(); }
      }
    }
  }));
  for (const j of queue) { j.state = 'skip'; j.status = 'Cancelled'; }
  IMP.running = false; S.indexDirty = true; S.ver++;
  setTimeout(() => { fillGenres(); rematchPlaylists(); DC.owned = null; checkWants(); }, 1000);
  if (S.route === 'import') render();
  const msg = IMP.cancel && queue.length ? `Stopped. Added ${count(IMP.added)}` : IMP.added ? `Added ${count(IMP.added)}${IMP.skipped ? ` · ${IMP.skipped} already here` : ''}` : IMP.skipped ? 'Those songs are already in your library' : 'Nothing was added';
  const toCheck = reviewList().length;
  toast(background && IMP.added ? `Added ${count(IMP.added)} from your folder` : msg, IMP.maybeDup ? ['Review duplicates', () => go('duplicates')] : toCheck && IMP.added ? [`Check ${toCheck}`, () => go('review')] : null);
  if (S.route !== 'import') render();
  queueStatePush();
  setTimeout(autoUpload, 3000);
}
async function importOne(j, known) {
  const f = j.file;
  j.status = 'Reading'; updateImportRow(j);
  if (f.size < 20000) throw new Error('empty');
  const [hash, legacyId] = await Promise.all([meta.fingerprint(f), meta.trackId(f)]);
  if (known.hashes.has(hash) || S.tracks.has(hash) || S.tracks.has(legacyId)) {
    const t = T(hash) || T(legacyId) || [...S.tracks.values()].find(x => x.hash === hash);
    Object.assign(j, { state: 'skip', status: 'Already here', title: t?.title, artist: t?.artist, art: t ? artOf(t) : null }); updateImportRow(j); return 'skip';
  }
  known.hashes.add(hash);
  const tags = await meta.readTags(f);
  const names = applyFixes(meta.cleanNames(tags, f.name, knownArtists(), S.channels), { file: f.name, title: tags.title });
  const reliable = meta.isReliable(tags) || !!names.fixed;
  const t = {
    id: hash, hash, ...(reliable ? { title: tags.title, artist: tags.artist, album: tags.album } : names),
    albumArtist: tags.albumArtist || '', genre: meta.cleanGenre(tags.genre), year: tags.year || '', trackNo: tags.track || '', disc: tags.disc || '',
    gain: tags.gain, file: f.name, ...(f.folderPath ? { folderPath: f.folderPath } : {}), size: f.size, type: f.type || '', addedAt: Date.now(), plays: 0, liked: false, local: true, cloud: false,
    original: { title: tags.title || '', artist: tags.artist || '', album: tags.album || '', genre: tags.genre || '', file: f.name },
  };
  const ft = (t.title.match(/\((?:feat\.?|ft\.?|with)\s+([^)]+)\)/i) || t.artist.match(/ (?:feat\.?|ft\.?|featuring) (.+)$/i) || [])[1];
  if (ft) t.featured = ft.split(/, | & /).map(s => s.trim());
  t.artist = meta.tidyArtist(t.artist);
  if (!t.genre && t.artist !== 'Unknown Artist') { const sib = [...S.tracks.values()].find(x => x.genre && mainArtist(x.artist) === mainArtist(t.artist)); if (sib) t.genre = sib.genre; }
  t.category = meta.categorize(t);
  if (tags.read && t.category === 'Audiobooks') t.read = tags.read;
  Object.assign(j, { title: t.title, artist: t.artist }); updateImportRow(j);
  t.duration = await meta.audioDuration(f);
  if (!t.duration && !/\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i.test(f.name)) throw new Error('unplayable');
  let artBlob = tags.picture?.size > 2000 ? tags.picture : null;
  if (S.settings.autoFix && t.category === 'Music' && (!reliable || !artBlob)) {
    j.status = 'Identifying'; updateImportRow(j);
    const found = await findSong({ title: t.title, artist: t.artist }, { blob: f, duration: t.duration }).catch(() => null);
    if (found) {
      if (!reliable) Object.assign(t, { title: found.title, artist: meta.tidyArtist(found.artist), album: found.album || t.album });
      Object.assign(t, { genre: t.genre || found.genre || '', year: t.year || found.year || '', explicit: found.explicit, matched: true, matchedVia: found.via });
      if (!artBlob || !reliable) artBlob = await fetchFirstImage(found.artUrls) || artBlob;
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
  const where = await cloud.uploadFile('audio/' + t.id, audioBlob);
  if (artBlob) await cloud.uploadFile('art/' + t.id, artBlob);
  t.store = where === 'r2' ? 'r2' : 'sb';
  t.cloud = true;
  await saveTrack(t);
}

/* =====================================================================
   Move song files from Supabase storage to Cloudflare R2 (runs once, on the computer that has the songs)
   ===================================================================== */
let migrating = false;
async function migrateToR2() {
  if (migrating || !S.user || !cloud.r2On() || !navigator.onLine) return;
  const todo = [...S.tracks.values()].filter(t => t.cloud && t.store !== 'r2');
  if (!todo.length) return;
  // the computer with the original files does this; a phone would have to download everything first
  if (todo.filter(t => t.local).length < todo.length * .5) return;
  migrating = true;
  let moved = 0; const old = [];
  toast(`Moving ${count(todo.length)} to your new storage…`);
  for (const t of todo) {
    try {
      const audio = (t.local && await db.get('audio', t.id)) || await cloud.supabaseBlob('audio/' + t.id);
      if (!audio) continue;
      const art = await db.get('art', t.id) || await cloud.supabaseBlob('art/' + t.id);
      await cloud.uploadFile('audio/' + t.id, audio);
      if (art) await cloud.uploadFile('art/' + t.id, art);
      t.store = 'r2'; await saveTrack(t);
      old.push('audio/' + t.id, 'art/' + t.id); moved++;
      if (moved % 25 === 0) toast(`Moved ${moved} of ${todo.length}…`);
    } catch (e) { console.warn('move', e); }
  }
  for (const p of S.playlists.values()) if (p.cover && p.coverStore !== 'r2') { const b = await db.get('art', 'pl:' + p.id); if (b) { await cloud.uploadFile('art/pl-' + p.id, b).catch(() => {}); p.coverStore = 'r2'; old.push('art/pl-' + p.id); await savePlaylist(p); } }
  if (old.length) await cloud.removeSupabaseFiles(old).catch(() => {});
  migrating = false;
  toast(moved === todo.length ? `All ${count(moved)} moved. Streaming is now free and unlimited.` : `Moved ${moved} of ${todo.length}. The rest will finish next time.`);
}

/* =====================================================================
   Offline: keep songs on this device (phone)
   ===================================================================== */
let downloading = false;
async function downloadSongs(ids, label) {
  if (downloading) return toast('Already downloading…');
  const ts = ids.map(id => T(id)).filter(t => t && t.cloud && !t.local);
  if (!ts.length) return toast('Already on this device');
  if (!S.user) return toast('Sign in first');
  downloading = true; let n = 0;
  toast(`Downloading ${count(ts.length)}${label ? ' from ' + label : ''}…`);
  for (const t of ts) {
    try {
      const u = await cloud.fileUrl('audio/' + t.id, t.store === 'r2'); if (!u) continue;
      const b = await (await fetch(u)).blob(); if (!b.size) continue;
      await db.put('audio', t.id, b); t.local = true; t.downloaded = true; await saveTrack(t, { sync: false }); n++;
      if (n % 5 === 0) toast(`Downloaded ${n} of ${ts.length}…`);
    } catch (e) { if (isQuotaError(e)) { quotaWarning(); break; } }
  }
  downloading = false; render();
  toast(`${count(n)} saved for offline listening`);
}
async function removeDownloads(ids) {
  let n = 0;
  for (const id of ids) { const t = T(id); if (t?.cloud && t.local && t.downloaded) { await db.del('audio', id); t.local = false; t.downloaded = false; await saveTrack(t, { sync: false }); n++; } }
  render(); toast(`Removed ${count(n)} from this device. They still stream.`);
}
/** Download button for a collection: only on devices where those songs stream from the cloud. */
function dlButton(ts) {
  const cloudOnes = ts.filter(t => t.cloud);
  if (!S.user || !cloudOnes.length) return '';
  const missing = cloudOnes.filter(t => !t.local).length;
  if (!missing && !cloudOnes.some(t => t.downloaded)) return '';
  const ids = cloudOnes.map(t => t.id).join(',');
  return missing ? `<button class="btn ghost" data-action="dl" data-ids="${ids}"><svg><use href="#i-download"/></svg>Download</button>`
    : `<button class="btn ghost dl-done" data-action="dl-remove" data-ids="${ids}"><svg><use href="#i-check"/></svg>Downloaded</button>`;
}

/* =====================================================================
   Playlists from Apple Music (File → Library → Export Playlist)
   ===================================================================== */
async function readText(file) {
  const b = new Uint8Array(await file.arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  return new TextDecoder('utf-8').decode(b);
}
/** Returns [{ name, items: [{ title, artist, album, duration }] }] from .txt, .xml or .m3u exports. */
function parsePlaylists(text, fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  if (/^\s*<\?xml|<plist/i.test(text)) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const dictVal = el => { const o = {}; const kids = [...(el?.children || [])]; for (let i = 0; i < kids.length; i += 2) { const k = kids[i]?.textContent; const v = kids[i + 1]; if (!k || !v) continue; o[k] = v.tagName === 'dict' ? v : v.tagName === 'array' ? v : v.textContent; } return o; };
    const root = dictVal(doc.querySelector('plist > dict'));
    const tracks = {};
    if (root.Tracks?.children) { const kids = [...root.Tracks.children]; for (let i = 0; i < kids.length; i += 2) { const d = dictVal(kids[i + 1]); tracks[kids[i].textContent] = { title: d.Name || '', artist: d.Artist || d['Album Artist'] || '', album: d.Album || '', duration: d['Total Time'] ? +d['Total Time'] / 1000 : 0 }; } }
    const out = [];
    for (const pl of [...(root.Playlists?.children || [])]) {
      const d = dictVal(pl);
      if (d.Master || d['Distinguished Kind'] || d.Folder || /^(library|music|downloaded|music videos|tv shows|movies|podcasts|audiobooks)$/i.test(d.Name || '')) continue;
      const items = [...(d['Playlist Items']?.children || [])].map(it => tracks[dictVal(it)['Track ID']]).filter(Boolean);
      if (items.length) out.push({ name: d.Name || base, items });
    }
    if (!out.length && Object.keys(tracks).length) out.push({ name: base, items: Object.values(tracks) });
    return out;
  }
  if (/^#EXTM3U/m.test(text) || /\.m3u8?$/i.test(fileName)) {
    const items = [];
    for (const line of text.split(/\r?\n/)) { const m = line.match(/^#EXTINF:(-?\d+)[^,]*,(.*)$/); if (m) { const [artist, ...rest] = m[2].split(' - '); items.push(rest.length ? { artist, title: rest.join(' - '), duration: +m[1] } : { artist: '', title: m[2], duration: +m[1] }); } }
    return items.length ? [{ name: base, items }] : [];
  }
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim());
  const head = (lines.shift() || '').split('\t').map(h => h.trim().toLowerCase());
  const col = n => head.indexOf(n);
  const [ti, ai, al, tm] = [col('name'), col('artist'), col('album'), col('time')];
  if (ti < 0) return [];
  const items = lines.map(l => l.split('\t')).map(c => ({ title: c[ti] || '', artist: ai >= 0 ? c[ai] || '' : '', album: al >= 0 ? c[al] || '' : '', duration: tm >= 0 ? +c[tm] || 0 : 0 })).filter(x => x.title);
  return items.length ? [{ name: base, items }] : [];
}
/** Finds an exported song in your library: title must match closely, artist must agree, length breaks ties. */
function matchSong(it) {
  let best = null, bestScore = 0;
  for (const t of S.tracks.values()) {
    const ts = meta.titleMatch(it.title, t.title); if (ts < .8) continue;
    const ok = !it.artist || !meta.wrongArtist(it.artist, t.artist) || (t.original?.artist && !meta.wrongArtist(it.artist, t.original.artist));
    if (!ok) continue;
    let sc = ts + (it.artist ? 1 : 0);
    if (it.duration && t.duration) { const d = Math.abs(it.duration - t.duration); if (d <= 4) sc += .5; else if (d > 30) sc -= .5; }
    if (sc > bestScore) { bestScore = sc; best = t; }
  }
  return best;
}
async function importPlaylistFiles(files) {
  let made = 0, matched = 0, missing = 0;
  for (const f of files) {
    let lists;
    try { lists = parsePlaylists(await readText(f), f.name); } catch { lists = []; }
    if (!lists.length) { toast(`Couldn’t read “${f.name}”. Export it from the Music app as Unicode Text.`); continue; }
    for (const L of lists) {
      const ids = [], miss = [];
      for (const it of L.items) { const t = matchSong(it); if (t && !ids.includes(t.id)) ids.push(t.id); else if (!t) miss.push({ title: it.title, artist: it.artist }); }
      const existing = [...S.playlists.values()].find(p => p.name === L.name && p.importedFrom === 'Apple Music');
      const p = existing || { id: uid(), name: L.name, tracks: [], createdAt: Date.now(), importedFrom: 'Apple Music' };
      p.tracks = [...new Set([...p.tracks, ...ids])]; p.missing = miss;
      await savePlaylist(p); made++; matched += ids.length; missing += miss.length;
    }
  }
  if (made) { render(); toast(`${made} playlist${made > 1 ? 's' : ''} added · ${matched} songs found${missing ? ` · ${missing} not in your library yet` : ''}`, made === 1 ? ['Open', () => go('playlist/' + [...S.playlists.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0].id)] : null); }
}
/** Songs you add later fill in the playlists they were missing from. */
async function rematchPlaylists() {
  for (const p of S.playlists.values()) {
    if (!p.missing?.length) continue;
    const still = []; let added = 0;
    for (const it of p.missing) { const t = matchSong(it); if (t && !p.tracks.includes(t.id)) { p.tracks.push(t.id); added++; } else if (!t) still.push(it); }
    if (added) { p.missing = still; await savePlaylist(p); }
  }
}

/* =====================================================================
   Genres: look up each artist once (Apple's catalog, exact name only)
   ===================================================================== */
let genreRun = false;
async function fillGenres() {
  if (genreRun || !navigator.onLine) return; genreRun = true;
  const known = await kv.get('artistGenre', {});
  const need = new Map();
  for (const t of S.tracks.values()) {
    if (t.genre || t.category !== 'Music' || t.artist === 'Unknown Artist' || meta.looksLikeChannel(t.artist, S.channels)) continue;
    const a = mainArtist(t.artist); const k = fold(a);
    if (k in known) { if (known[k]) { t.genre = known[k]; await saveTrack(t); } continue; }
    need.set(k, a);
  }
  let found = 0, done = 0;
  S.genreProgress = { done: 0, total: need.size };
  for (const [k, a] of need) {
    let g = null;
    try { g = await meta.artistGenre(a); } catch (e) { if (e.message === 'rate') { await new Promise(r => setTimeout(r, 60000)); try { g = await meta.artistGenre(a); } catch { break; } } }
    if (g === null) { await new Promise(r => setTimeout(r, 3200)); continue; }
    known[k] = g; done++; S.genreProgress.done = done;
    if (g) {
      found++;
      for (const t of S.tracks.values()) if (!t.genre && t.category === 'Music' && fold(mainArtist(t.artist)) === k) { t.genre = g; await saveTrack(t); }
    }
    if (done % 10 === 0) { await kv.set('artistGenre', known); S.ver++; if (['home', 'library', 'settings'].includes(S.route)) render(); }
    await new Promise(r => setTimeout(r, 3200)); // Apple allows about 20 lookups a minute
  }
  await kv.set('artistGenre', known);
  S.genreProgress = null; genreRun = false; S.ver++;
  if (found) { render(); toast(`Added genres for ${found} artist${found > 1 ? 's' : ''}`); }
}

/* =====================================================================
   Auto-import from a connected folder (Chrome on a computer)
   ===================================================================== */
const CAN_WATCH = 'showDirectoryPicker' in window;
async function connectFolder() {
  try {
    const h = await window.showDirectoryPicker({ id: 'cadence-music', mode: 'read', startIn: 'downloads' });
    S.folder = h; await kv.set('folder', h);
    // songs already in the folder that you've imported before are recognized and skipped
    toast(`Connected “${h.name}”. Checking for songs…`);
    await scanFolder({ user: true });
    render();
  } catch (e) { if (e.name !== 'AbortError') toast('Couldn’t connect that folder'); }
}
async function disconnectFolder() { S.folder = null; S.folderState = ''; await kv.set('folder', null); await kv.set('folderSeen', []); render(); }
let scanning = false;
const REMOVED_DIR = 'Removed from Fof Music';
/**
 * When a song is removed from the library, its file in the watched folder moves into a "Removed from Fof Music"
 * folder there (never deleted, so you can still get it back). Needs edit permission for the folder, asked once.
 */
async function moveOutOfFolder(t) {
  if (!S.folder || !t) return false;
  try {
    let perm = await S.folder.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await S.folder.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    // find the file: by the path saved at import, otherwise by name and size anywhere in the folder
    let dir = S.folder, fh = null;
    if (t.folderPath) {
      try { const parts = t.folderPath.split('/'); for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p); fh = await dir.getFileHandle(parts.at(-1)); } catch { dir = S.folder; fh = null; }
    }
    if (!fh && t.file) {
      const look = async (d, depth) => {
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'directory') { if (depth < 3 && name !== REMOVED_DIR && !name.startsWith('.')) { const r = await look(h, depth + 1); if (r) return r; } continue; }
          if (name === t.file) { const f = await h.getFile(); if (!t.size || f.size === t.size) return [d, h]; }
        }
        return null;
      };
      const r = await look(S.folder, 0); if (r) [dir, fh] = r;
    }
    if (!fh || !fh.move) return false;
    const bin = await S.folder.getDirectoryHandle(REMOVED_DIR, { create: true });
    let name = fh.name, n = 1;
    const exists = async nm => { try { await bin.getFileHandle(nm); return true; } catch { return false; } };
    while (await exists(name)) name = fh.name.replace(/(\.[^.]+)?$/, ` (${n++})$1`);
    await fh.move(bin, name);
    return true;
  } catch (e) { console.warn('move out of folder', e); return false; }
}
/** Looks through the connected folder (and its subfolders) for songs Fof Music hasn't seen and imports them quietly. */
function scanFolder(o = {}) { return oneTab('scan', () => scanFolderNow(o)); }
async function scanFolderNow({ user = false } = {}) {
  if (!S.folder || scanning || IMP.running) return;
  let perm = await S.folder.queryPermission?.({ mode: 'read' }).catch(() => 'denied');
  if (perm !== 'granted' && user) perm = await S.folder.requestPermission({ mode: 'read' }).catch(() => 'denied');
  if (perm !== 'granted') { S.folderState = 'needs-permission'; renderFolderBanner(); return; }
  S.folderState = 'ok'; renderFolderBanner();
  scanning = true;
  try {
    const seen = new Set(await kv.get('folderSeen', []));
    const fresh = [], keys = [];
    const walk = async (dir, depth, path = []) => {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') { if (depth < 3 && !name.startsWith('.') && name !== REMOVED_DIR) await walk(h, depth + 1, [...path, name]); continue; }
        if (!meta.AUDIO_EXT.test(name)) continue;
        const f = await h.getFile().catch(() => null); if (!f) continue;
        f.folderPath = [...path, name].join('/');
        const key = `${name}|${f.size}|${f.lastModified}`;
        keys.push(key);
        if (!seen.has(key)) fresh.push(f);
      }
    };
    await walk(S.folder, 0);
    S.lastScan = Date.now();
    if (fresh.length) await importFiles(fresh, { background: true });
    await kv.set('folderSeen', [...new Set([...seen, ...keys])].slice(-20000));
    if (user && !fresh.length) toast('No new songs in that folder');
  } catch (e) { console.warn('scan', e); if (user) toast('Couldn’t read that folder'); }
  scanning = false;
}
function renderFolderBanner() {
  const b = $('#folder-bar'); if (!b) return;
  b.hidden = S.folderState !== 'needs-permission';
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
      ${IS_IOS && !NATIVE ? `<div class="set-row"><div class="lbl"><b>Crossfade and gapless</b><span>Not available on iPhone and iPad. Apple only lets web apps play one song at a time in the background.</span></div></div>` : `
      <div class="set-row"><div class="lbl"><b>Crossfade</b><span>${S.settings.crossfade ? `Songs blend over ${S.settings.crossfade} seconds` : 'Off. Songs play one after another.'}</span></div><input type="range" class="setting-range" min="0" max="12" step="1" value="${S.settings.crossfade}" data-setting="crossfade" aria-label="Crossfade seconds"></div>
      ${sw('gapless', 'Gapless playback', 'Loads the next song early so there’s no pause between tracks')}`}
      ${IS_IOS && !NATIVE ? '' : sw('flowBlend', 'Smooth Fof Flow', 'Fof Flow orders songs so each one leads into the next and blends them together')}
      <button class="set-row" data-action="eq"><div class="lbl"><b>Sound</b><span>${esc(EQ_NAMES[S.settings.eq] || 'Custom')}${NATIVE ? '' : ' · works in the iPhone app'}</span></div>${icon('back', 'chev')}</button>
      ${sw('leveling', 'Volume leveling', 'Evens out loud and quiet songs using loudness info saved in your files (ReplayGain). Songs without it play as they are.')}
      ${sw('hideExplicit', 'Hide explicit songs', 'Uses Apple’s explicit labels found during import. Songs without a label are not hidden.')}</div>`,
    library: () => { const dups = duplicateGroups().length; const local = [...S.tracks.values()].filter(t => t.local).length; return `<div class="settings-group">
      ${sw('autoFix', 'Fix names and artwork on import', 'Recognizes each song by its sound, then checks Apple Music and Deezer for the real name and album artwork. Songs with complete tags keep their own names.')}
      <div class="set-row"><div class="lbl"><b>Fix all songs again</b><span>Re-checks names and artwork for songs you haven’t edited yourself</span></div><button class="btn" data-action="refix-all">Fix all</button></div>
      ${CAN_WATCH ? `<div class="set-row"><div class="lbl"><b>Auto-import folder</b><span>${S.folder ? `Watching “${esc(S.folder.name)}”` : 'Not connected. New songs saved to a folder you pick are added automatically.'}</span></div>${S.folder ? '<button class="btn ghost" data-action="disconnect-folder">Stop watching</button>' : '<button class="btn" data-action="connect-folder">Connect folder</button>'}</div>` : ''}
      ${IN_APP || IS_IOS ? `<a class="set-row" href="#/offline"><div class="lbl"><b>Offline</b><span>${S.settings.autoOffline === false ? 'Off' : 'Choose what stays on this phone'}</span></div>${icon('back', 'chev')}</a>` : ''}
      ${sw('askUnsure', 'Ask me about songs it can’t identify', 'Off: songs that aren’t found by sound or in Apple Music or Deezer keep their cleaned-up name and a designed cover. On: they’re listed in Check these.')}
      ${(() => { const n = reviewList(true).length; return `<div class="set-row"><div class="lbl"><b>Songs to name</b><span>${n ? `${count(n)} not found in any catalog` : 'Every song is named'}</span></div>${n ? '<a class="btn" href="#/review">Fix</a>' : ''}</div>`; })()}
      ${S.channels.length ? `<div class="set-row"><div class="lbl"><b>Channels, not artists</b><span>${S.channels.map(esc).join(', ')}</span></div><button class="btn ghost" data-action="clear-channels">Reset</button></div>` : ''}
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
      <p class="fine">What Fof Music stores: your song files and artwork, song details, playlists, likes, play counts and a log of what you played and when. On this device it lives in your browser’s storage. When you’re signed in, a copy is kept in your private cloud library so your other devices can use it. Nothing is shared with anyone else.</p>`,
    about: () => `<div class="settings-group">
      <div class="set-row"><div class="lbl"><b>Fof Music</b><span>Version ${esc((S.version || 'dev').slice(0, 7))}</span></div><button class="btn" data-action="check-update">Check for updates</button></div>
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
  if (t.kind === 'yt') return 'yt:' + t.vid;
  if (t.ext) {
    if (t.path) return t.path;
    if (t.local) { const b = await db.get('audio', t.id); if (b) { if (!P.objUrls.has(t.id)) P.objUrls.set(t.id, URL.createObjectURL(b)); return P.objUrls.get(t.id); } }
    return (NATIVE ? t.url : t.url?.replace(/^http:/, 'https:')) || null;
  }
  if (NATIVE && S.offPaths?.[t.id]?.path) return S.offPaths[t.id].path; // saved on this phone for offline
  if (window.fofDesktop && S.deskPaths?.[t.id] && !t.local && await window.fofDesktop.exists(S.deskPaths[t.id]).catch(() => false)) return 'fofile://local' + S.deskPaths[t.id].split('/').map(encodeURIComponent).join('/'); // the file on this Mac
  if (!t.local && P.prefetchId === t.id && P.objUrls.has(t.id)) return P.objUrls.get(t.id); // downloaded ahead while the last song played
  const blob = t.local ? await db.get('audio', t.id) : null;
  if (blob) {
    if (!P.objUrls.has(t.id)) P.objUrls.set(t.id, URL.createObjectURL(blob));
    for (const [id, u] of P.objUrls) if (id !== t.id && id !== current()?.id && id !== P.preloadFor && id !== P.prefetchId) { URL.revokeObjectURL(u); P.objUrls.delete(id); }
    return P.objUrls.get(t.id);
  }
  if (t.local && !blob) { t.local = false; t.downloaded = false; await saveTrack(t, { sync: false }); } // the file was removed elsewhere
  if (t.cloud && S.user) { try { return await cloud.fileUrl('audio/' + t.id, t.store === 'r2' || cloud.r2On()); } catch (e) { console.warn('file', e); return null; } }
  return null;
}
const gainFor = t => S.settings.leveling ? t.gain : undefined;
function current() { return T(P.queue[P.idx]); }

async function loadTrack(id, { autoplay = true, quiet = false } = {}) {
  const t = T(id); if (!t) return false;
  flushListen();
  const src = await srcFor(t);
  if (!src) {
    if (!quiet) toast(!t.local && t.cloud && !S.user ? 'Sign in to play songs from your cloud library' : !navigator.onLine && t.cloud ? 'You’re offline and this song isn’t saved on this device' : t.cloud && cloud.lastFileError ? `Couldn’t reach your music (${cloud.lastFileError}). Try again in a moment.` : (isBook(t) ? 'This chapter isn’t on this device yet. It’ll be ready once it syncs.' : 'This song isn’t available on this device'));
    return false;
  }
  P.preloadFor = null; P.fadeStarted = false; P.counted = false; P.lyrics = null; P.lyricLine = -1; P.follow = true; if (P.resumeId !== id) { P.resumeAt = 0; P.resumeId = null; }
  if (isBook(t)) { const pr = S.pod.prog[t.id]; if (pr && !pr.done && pr.t > 5) { P.resumeAt = pr.t; P.resumeId = t.id; } bookSpeed(true); } else if (P.bookRate) bookSpeed(false);
  if (t.kind === 'episode') { const pr = S.pod.prog[t.id]; if (pr && !pr.done && pr.t > 5) { P.resumeAt = pr.t; P.resumeId = t.id; } }
  paintNow(t);
  try { await engine.load(src, { gainDb: gainFor(t), autoplay }); }
  catch (e) { if (e.name === 'NotAllowedError') { updatePlayIcons(); } else if (e.name !== 'AbortError') console.warn(e); }
  if (autoplay) P.played.push(t.id);
  startListen(t.id);
  updateMediaSession(t);
  savePlayer();
  if ($('#now').classList.contains('open')) renderPanel();
  if (S.route === 'feysal') render();
  return true;
}
async function playList(ids, start = 0, { shuffle = false, context = '', ctxRoute = '', mode = null, seed = null } = {}) {
  ids = ids.filter(id => T(id));
  if (!ids.length) return;
  if (shuffle) P.shuffle = true;
  if (P.shuffle) { const first = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[start]; ids = [first, ...shuffleArr(ids.filter(x => x !== first))]; start = 0; }
  Object.assign(P, { queue: ids, idx: start, autoAdded: new Set(), context, contextRoute: ctxRoute, mode, seed });
  if (ctxRoute) recordCtx(ctxRoute, context);
  updateModes();
  const ok = await loadTrack(P.queue[P.idx]);
  if (!ok) { const k = P.queue.findIndex((id, i) => i > start && (T(id)?.local || (S.user && T(id)?.cloud))); if (k > 0) { P.idx = k; loadTrack(P.queue[k]); } }
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
  if (current()?.ext || (current() && !isSong(current()))) return null; // a podcast, lecture, recitation or book ends where it ends; only music autoplays
  let more = [];
  if (P.mode === 'flow') more = flowPicks(15);
  else if (P.mode === 'radio') more = similar([T(P.seed), current()].filter(Boolean), 15);
  else if (S.settings.autoplay) more = similar([...P.queue.slice(Math.max(0, P.idx - 4), P.idx + 1)].map(id => T(id)), 12);
  more = more.filter(id => T(id)?.local || (S.user && T(id)?.cloud));
  if (!more.length) return null;
  more.forEach(id => P.autoAdded.add(id)); P.queue.push(...more); savePlayer();
  if (P.panel === 'queue' && $('#now').classList.contains('open')) renderQueue();
  if (P.panel === 'artist' && $('#now').classList.contains('open')) renderPanel();
  return { id: P.queue[P.idx + 1], idx: P.idx + 1 };
}
async function next(auto = false) {
  if (!P.queue.length) return;
  if (auto && P.repeat === 'one') { engine.el.currentTime = 0; engine.el.play(); return; }
  const n = peekNext();
  if (!n) { if (auto) { engine.el.pause(); engine.el.currentTime = 0; toast('That’s the end of the queue'); } return; }
  if (!auto) { try { noteSkip(); } catch (e) { console.warn('skip', e); } }
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
  if (!l || l.s < 10 || !S.settings.keepHistory || T(l.id)?.kind === 'ayah') return;
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
/** Where you are in the current song, including a spot that hasn't been applied yet. */
function spotNow() { const c = engine.el.currentTime || 0; return c > 0.5 ? c : (P.resumeId && P.resumeId === current()?.id ? P.resumeAt || 0 : c); }
function savePlayer(now) {
  clearTimeout(saveT);
  const w = () => kv.set('player', { queue: P.queue, idx: P.idx, shuffle: P.shuffle, repeat: P.repeat, context: P.context, contextRoute: P.contextRoute, mode: P.mode, seed: P.seed, played: P.played.slice(-100), time: spotNow(), at: P.activeAt || 0 });
  try { const t = current(); if (t) localStorage.setItem('fof-spot', JSON.stringify({ id: t.id, time: spotNow() })); } catch {}
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
  $('#now-mini-title').textContent = t.title; $('#now-mini-artist').textContent = t.artist; $('#now-mini-art').src = artOf(t);
  if (t.ext) delete $('#now-artist').dataset.action; else $('#now-artist').dataset.action = 'artist-more';
  document.body.classList.toggle('book-mode', isBook(t));
  // the player adapts to what's playing: music, a book, a talk (podcast or lecture) or Quran
  const ctx = playCtx(t); for (const c of ['music', 'book', 'talk', 'quran']) document.body.classList.toggle('ctx-' + c, ctx === c);
  { const sp = $('#p-speed'); if (sp) sp.textContent = (P.speed || 1) + '×'; }
  { const tl = $('#tab-lyrics'); if (tl) tl.lastChild.textContent = isBook(t) ? 'Chapters' : 'Lyrics'; }
  $('#now-artist').href = isBook(t) ? '#/book/' + encodeURIComponent(bookKey(t)) : t.kind === 'yt' ? '#/feysal/' + t.albumKey : t.kind === 'episode' ? '#/show/' + t.showId : t.kind === 'ayah' ? '#/quran/' + t.surah : '#/artist/' + encodeURIComponent(mainArtist(t.artist));
  $('#now-from').textContent = P.mode === 'flow' ? 'Fof Flow' : P.context ? 'Playing from ' + P.context : '';
  ['#p-like', '#now-like'].forEach(s => $(s).classList.toggle('on', !!t.liked));
  document.title = `${t.title} · ${t.artist}`;
  setNowBg(t.colors);
  setBackdrop(t.colors);
  $('#player').style.cssText = ambient(t.colors);
  if (S.route === 'drive') paintDrive(t);
  markPlaying();
}
let bgLayer = 0, bdLayer = 0;
/** Richer version of an artwork color for the backdrop; greys stay grey-ish instead of turning neon. */
function vivid(hex, light, boost) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) hex = '#2a2a33';
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l0 = (mx + mn) / 2;
  let h = 0; const s0 = d ? d / (1 - Math.abs(2 * l0 - 1)) : 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const s1 = Math.min(.6, s0 < .08 ? s0 : s0 * boost + .06);
  const c = (1 - Math.abs(2 * light - 1)) * s1, x = c * (1 - Math.abs(h % 2 - 1)), m = light - c / 2;
  const [R, G, B] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return '#' + [R, G, B].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
/** The whole app sits on a slow-moving field of color taken from the song that's playing. */
const richAmbient = c => c ? `--amb-base:${vivid(c.base, .26, 1.5)};--amb-glow:${vivid(c.glow, .4, 1.8)};--amb-accent:${vivid(c.accent, .58, 2)}` : '';
function setBackdrop(c) {
  const layers = $$('#backdrop .bd'); if (layers.length < 2) return;
  const key = c ? c.base + c.glow + c.accent : 'none';
  if (layers[bdLayer].dataset.key === key) return;
  bdLayer = 1 - bdLayer;
  const l = layers[bdLayer]; l.dataset.key = key;
  l.style.cssText = c ? `--amb-base:${vivid(c.base, .3, 1.6)};--amb-glow:${vivid(c.glow, .44, 2)};--amb-accent:${vivid(c.accent, .56, 2.2)}` : '';
  l.classList.add('on'); layers[1 - bdLayer].classList.remove('on');
}
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
  $$('.pod-ep').forEach(r => r.classList.toggle('playing', r.dataset.id === id));
  qMark();
}
function updatePlayIcons() {
  const paused = engine.el.paused;
  ['#p-play', '#now-play', '#p-play-mini'].forEach(s => { $(s + ' use').setAttribute('href', paused ? '#i-play' : '#i-pause'); $(s).setAttribute('aria-label', paused ? 'Play' : 'Pause'); });
  $('#now').classList.toggle('paused', paused);
  document.body.classList.toggle('is-paused', paused);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
  if (S.route === 'books' || S.route === 'book') { clearTimeout(updatePlayIcons.t); updatePlayIcons.t = setTimeout(render, 120); }
  if (isBook(current()) && P.panel === 'lyrics' && $('#now').classList.contains('open')) renderPanel();
}
function updateModes() {
  ['#p-shuffle', '#now-shuffle'].forEach(s => { $(s).classList.toggle('on', P.shuffle); $(s).setAttribute('aria-pressed', P.shuffle); });
  if (P.panel === 'queue' && $('#now').classList.contains('open')) $$('.q-mode').forEach(b => b.classList.toggle('on', b.dataset.action === 'shuffle' ? P.shuffle : P.repeat !== 'off'));
  ['#p-repeat', '#now-repeat'].forEach(s => { $(s).classList.toggle('on', P.repeat !== 'off'); $(s + ' use').setAttribute('href', P.repeat === 'one' ? '#i-repeat1' : '#i-repeat'); $(s).setAttribute('aria-label', { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[P.repeat]); });
}
let seeking = false;
let lastSpotSave = 0;
let prefetching = false;
async function prefetchNext() {
  const n = peekNext(); if (!n || prefetching || P.prefetchId === n.id) return;
  const t = T(n.id); if (!t || t.local || !t.cloud || !S.user) return;
  prefetching = true; const id = t.id;
  try {
    const u = await cloud.fileUrl('audio/' + id, t.store === 'r2' || cloud.r2On());
    const r = u && await fetch(u);
    if (r?.ok) {
      const raw = await r.blob();
      const type = /^audio\//.test(raw.type) ? raw.type : 'audio/mpeg';
      const old = P.objUrls.get(P.prefetchId); if (P.prefetchId && old?.startsWith('blob:') && P.prefetchId !== current()?.id) { URL.revokeObjectURL(old); P.objUrls.delete(P.prefetchId); }
      P.objUrls.set(id, URL.createObjectURL(new Blob([raw], { type }))); P.prefetchId = id;
    }
  } catch (e) { console.warn('prefetch', e); }
  prefetching = false;
}
/** Every progress bar and time label shows where the song really is — including a paused spot that hasn't been reloaded yet. */
function paintTime() {
  const el = engine.el, t = current(), c = spotNow(), d = el.duration || t?.duration || 0, f = d ? Math.min(1, c / d) : 0;
  if (!seeking) {
    for (const s of ['#p-seek', '#now-seek']) { const r = $(s); r.value = f * 1000; paintRange(r); }
    $('#p-cur').textContent = $('#now-cur').textContent = fmt(c);
    $('#p-dur').textContent = $('#now-dur').textContent = '-' + fmt(Math.max(0, d - c));
  }
  $('#p-mini-bar').style.transform = `scaleX(${f})`;
  const hb = document.getElementById('hero-bar'); if (hb) hb.style.transform = `scaleX(${f})`;
}
function onTime() {
  const el = engine.el, d = el.duration || 0, c = el.currentTime || 0;
  if (isBook(current()) && Math.floor(c * 4) % 4 === 0) bookTime(current(), c);
  if (!el.paused && Date.now() - lastSpotSave > 5000) { lastSpotSave = Date.now(); P.activeAt = Date.now(); savePlayer(true); } // the spot survives the app being closed
  if (!el.paused && S.user && Date.now() - (P.pushedAt || 0) > 90000) queueStatePush(); // other devices see roughly where you are
  paintTime(); qTick(c);
  const t = current();
  if (P.listen && !el.paused) { const now = performance.now(); if (P.tick) P.listen.s += Math.min((now - P.tick) / 1000, 1.5); P.tick = now; }
  if (t && !t.ext && !P.counted && d && c > Math.min(30, d * .5)) { P.counted = true; t.plays = (t.plays || 0) + 1; t.lastPlayed = Date.now(); saveTrack(t); addHistory(t.id); }
  if (P.lyrics?.lines && P.panel === 'lyrics' && $('#now').classList.contains('open')) syncLyrics(c);
  if (P.sleepAt) { if (Date.now() >= P.sleepAt) { el.pause(); clearSleep(); toast('Sleep timer ended'); } else $('#sleep-btn span').textContent = fmt((P.sleepAt - Date.now()) / 1000); }
  // iPhone plays one song at a time: download the next one in the background so skipping starts instantly
  if (!engine.dual && c > 4 && !el.paused && navigator.onLine) prefetchNext();
  // gapless / crossfade: buffer the next song near the end, then switch
  const remain = d - c;
  const cf = engine.dual && !current()?.ext && !isBook(current()) ? (S.settings.crossfade || (P.mode === 'flow' && S.settings.flowBlend !== false ? 6 : 0)) : 0;
  if (engine.dual && (S.settings.gapless || cf) && !isBook(current()) && d && remain < Math.max(cf + 10, 15) && P.repeat !== 'one' && !P.sleepEnd && !el.paused) {
    const n = peekNext();
    if (n && P.preloadFor !== n.id) {
      P.preloadFor = n.id; const nt = T(n.id);
      srcFor(nt).then(src => { if (src && P.preloadFor === n.id) engine.preload(n.id, src, gainFor(nt)); });
    }
    if (cf && !P.fadeStarted && remain <= cf && remain > .4 && n && engine.hasSpare(n.id)) { P.fadeStarted = true; advanceTo(n.id, Math.min(cf, remain)); }
  }
  if (Math.floor(c) % 5 === 0) savePlayer();
  if (t?.kind === 'episode' && d && !el.paused && Math.floor(c) % 5 === 0) podProgress(t, c, d);
  if (isBook(t) && d && !el.paused && Math.floor(c) % 5 === 0) bookProgress(t, c, d);
  if ('mediaSession' in navigator && d && isFinite(d)) { try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: el.playbackRate || 1 }); } catch {} }
}
for (const el of engine.all) {
  const mine = fn => e => { if (e.target === engine.el) fn(e); };
  el.addEventListener('timeupdate', mine(onTime));
  el.addEventListener('loadedmetadata', mine(() => { const t = current(); if (t && isFinite(el.duration) && (!t.duration || Math.abs(t.duration - el.duration) > 2)) { t.duration = el.duration; saveTrack(t, { sync: false }); } onTime(); }));
  el.addEventListener('play', mine(() => { P.tick = 0; updatePlayIcons(); }));
  el.addEventListener('playing', mine(() => { if (!P.isPlaying) liveSay('take'); P.isPlaying = true; P.activeAt = Date.now(); }));
  // iPhone ignores a jump made before a song starts loading; make it once playback begins
  el.addEventListener('playing', mine(() => { if (P.resumeAt && current()?.id === P.resumeId) { const at = P.resumeAt; P.resumeAt = 0; P.resumeId = null; if (Math.abs(el.currentTime - at) > 2 && (!el.duration || at < el.duration - 1)) el.currentTime = at; } }));
  el.addEventListener('pause', mine(() => { P.tick = 0; if (P.isPlaying) { P.isPlaying = false; P.activeAt = Date.now(); queueStatePush(); } updatePlayIcons(); savePlayer(); }));
  el.addEventListener('waiting', mine(() => $('#player').classList.add('buffering')));
  el.addEventListener('playing', mine(() => $('#player').classList.remove('buffering')));
  el.addEventListener('ended', mine(() => {
    if (P.mem && current()?.kind === 'ayah') { memStep(); return; }
    { const t = current(); if (t?.kind === 'episode') podProgress(t, el.duration, el.duration); if (isBook(t)) bookProgress(t, el.duration, el.duration); }
    if (P.sleepEnd) { clearSleep(); toast('Sleep timer ended'); return; }
    if (P.repeat === 'one') return next(true);
    if (P.preloadFor && engine.hasSpare(P.preloadFor)) return advanceTo(P.preloadFor, 0);
    next(true);
  }));
  el.addEventListener('error', mine(async () => {
    const src = el.getAttribute('src'); if (!src) return;
    if (el.error?.noApi) { updatePlayIcons(); toast(navigator.onLine ? 'YouTube isn’t reachable right now. Try again in a moment.' : 'You’re offline. These recitations need the internet.'); return; }
    const t = current(); const code = el.error?.code;
    // the iPhone's player can refuse a streamed song it would happily play once downloaded (missing file type,
    // range quirks): download it once and play that copy instead of skipping
    if (t && /^https?:/.test(src) && !(P.streamRetry ||= new Set()).has(t.id)) {
      P.streamRetry.add(t.id);
      try {
        const r = await fetch(src);
        if (r.ok) {
          const raw = await r.blob();
          const ext = (t.file || '').split('.').pop().toLowerCase();
          const type = /^audio\//.test(raw.type) ? raw.type : ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg' }[ext] || 'audio/mpeg');
          const url = URL.createObjectURL(new Blob([raw], { type }));
          const old = P.objUrls.get(t.id); if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
          P.objUrls.set(t.id, url);
          if (current()?.id === t.id) { const at = el.currentTime || P.resumeAt || 0; await engine.load(url, { gainDb: gainFor(t), autoplay: true }).catch(() => {}); if (at > 1) P.resumeAt = at; return; }
        } else console.warn('stream', r.status, src.split('?')[0]);
      } catch (e) { console.warn('stream', e); }
    }
    toast(code === 4 ? `“${t?.title || 'This song'}” is in a format this browser can’t play` : code === 2 ? 'Network problem. Skipping ahead.' : `“${t?.title || 'This song'}” couldn’t be played. Skipping.`);
    setTimeout(() => next(true), 800);
  }));
}
function bindSeek(sel) {
  const r = $(sel);
  let drag = null, endedAt = 0, idle = null;
  // A drag that loses its last event must never leave the bar frozen: when nothing is holding it, let go.
  const release = () => { clearTimeout(idle); idle = null; if (!drag && seeking) { seeking = false; paintTime(); } };
  const duration = () => {
    const d = engine.el.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  const preview = () => {
    seeking = true;
    paintRange(r);
    const d = duration(), time = r.valueAsNumber / 1000 * d;
    $('#p-cur').textContent = $('#now-cur').textContent = fmt(time);
    $('#p-dur').textContent = $('#now-dur').textContent = '-' + fmt(d - time);
  };
  const commit = () => {
    seeking = false; clearTimeout(idle); idle = null;
    const d = duration();
    if (d) {
      if (P.resumeId === current()?.id) P.resumeAt = 0;
      engine.el.currentTime = r.valueAsNumber / 1000 * d;
      P.activeAt = Date.now(); setTimeout(() => { savePlayer(true); queueStatePush(); }, 300);
      if (P.lyrics?.lines) syncLyrics(engine.el.currentTime, true);
    }
    paintTime();
  };
  const move = e => {
    const bounds = r.getBoundingClientRect();
    r.value = Math.round(Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)) * 1000);
    preview();
  };
  const finish = e => {
    if (drag?.pointerId !== e.pointerId) return;
    const shouldSeek = e.type === 'pointerup' && drag.track === current()?.id &&
      drag.el === engine.el && drag.src === engine.el.getAttribute('src');
    drag = null; endedAt = Date.now();
    r.classList.remove('dragging');
    if (shouldSeek) {
      move(e);
      commit();
      haptic();
    } else {
      seeking = false;
      paintTime();
    }
  };
  // On iPhone the slider also reacts on its own to the same finger. Those extra events arrive after the drag
  // has already been applied and used to re-freeze the bar, so they're ignored; the finger drag below is the only path.
  const nativeEcho = () => !drag && (Date.now() - endedAt < 1000 || r.dataset.touch === '1');
  r.addEventListener('input', () => {
    if (nativeEcho()) { paintTime(); return; }
    preview();
    clearTimeout(idle); if (!drag && !r.matches(':active')) idle = setTimeout(release, 1500);
  });
  r.addEventListener('change', () => { if (nativeEcho()) { seeking = false; paintTime(); return; } commit(); });
  r.addEventListener('touchstart', e => { r.dataset.touch = '1'; e.preventDefault(); }, { passive: false });
  r.addEventListener('blur', () => {
    if (!drag && seeking) { seeking = false; paintTime(); }
  });
  r.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || !e.isPrimary || !duration()) return;
    try { r.setPointerCapture(e.pointerId); } catch { return; }
    e.preventDefault();
    drag = { pointerId: e.pointerId, track: current()?.id, el: engine.el, src: engine.el.getAttribute('src') };
    r.classList.add('dragging');
    move(e);
  });
  r.addEventListener('pointermove', e => { if (drag?.pointerId === e.pointerId) move(e); });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) r.addEventListener(event, finish);
}
bindSeek('#p-seek'); bindSeek('#now-seek');
$('#p-vol').addEventListener('input', e => { const v = e.target.value / 100; engine.setVolume(v); paintRange(e.target); S.settings.volume = v; clearTimeout(e.target._t); e.target._t = setTimeout(() => kv.set('settings', S.settings), 300); $('#vol-icon use').setAttribute('href', v === 0 ? '#i-mute' : '#i-vol'); });

let npArtKey = '', npArtData = '';
async function nativeNowPlaying(t) {
  if (!NATIVE || !t || engine.ytOn) return;
  const art = artOf(t, 'full'), info = { id: engine.i, title: t.title, artist: t.artist, album: t.album || t.category || '', duration: engine.el.duration || t.duration || 0, book: isBook(t) };
  if (art && art !== PLACEHOLDER) {
    if (/^https?:/.test(art)) info.art = art;
    else {
      if (npArtKey !== t.id) { try { const b = await fetch(art).then(r => r.blob()); npArtData = await new Promise(r => { const f = new FileReader(); f.onload = () => r(String(f.result).split(',')[1]); f.readAsDataURL(b); }); npArtKey = t.id; } catch { npArtData = ''; } }
      if (npArtKey === t.id && npArtData) { info.artKey = t.id; info.artData = npArtData; }
    }
  }
  NATIVE.nowPlaying(info).catch(() => {});
  NATIVE.widget({ title: t.title, artist: t.artist, playing: !engine.el.paused, artData: info.artData }).catch(() => {});
}
if (NATIVE) {
  NATIVE.addListener('remote', e => {
    const a = e.action, el = engine.el;
    if (a === 'play' || a === 'resume') el.play();
    else if (a === 'pause') el.pause();
    else if (a === 'interrupted') el.interrupted?.();
    else if (a === 'toggle') toggle();
    else if (a === 'next') next();
    else if (a === 'prev') prev();
    else if (a === 'seek' && isFinite(e.time)) el.currentTime = e.time;
    else if (a === 'back15') el.currentTime = Math.max(0, el.currentTime - 15);
    else if (a === 'fwd30') el.currentTime = Math.min((el.duration || 1e9) - 1, el.currentTime + 30);
  });
  for (const el of engine.els) for (const ev of ['play', 'pause', 'loadedmetadata']) el.addEventListener(ev, () => { if (el === engine.el) nativeNowPlaying(current()); });
}
/* The YouTube player stays on screen while it plays: over the artwork in Now Playing, otherwise a small card above the player. */
let ytRaf = 0, ytFast = 0;
/** Follows the artwork smoothly for a moment after something moves, then checks a few times a second. */
function kickYt() { ytFast = performance.now() + 1000; placeYt(); }
function placeYt() {
  cancelAnimationFrame(ytRaf); clearTimeout(ytRaf); ytRaf = 0;
  const h = $('#yt-host'), show = engine.ytOn && h.classList.contains('on');
  h.classList.toggle('show', show);
  if (!show) return;
  const now = $('#now'), open = now.classList.contains('open'), art = $('.now-art');
  const covered = open && now.classList.contains('panel-open') && innerWidth <= 820;
  let r = open && !covered ? art.getBoundingClientRect() : null;
  if (r && r.width < 40) r = null;
  if (!r) {
    const w = innerWidth <= 760 ? 176 : 224, ht = Math.round(w * 9 / 16);
    const pb = open ? { top: innerHeight - 250 } : $('#player').getBoundingClientRect();
    r = { left: innerWidth - w - 14, top: Math.max(8, pb.top - ht - 12), width: w, height: ht };
  }
  h.classList.toggle('big', open);
  Object.assign(h.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  ytRaf = performance.now() < ytFast ? requestAnimationFrame(placeYt) : setTimeout(placeYt, 400);
}
$('#yt-host').insertAdjacentHTML('beforeend', '<button class="yt-open" data-action="yt-open" aria-label="Open Now Playing"><svg><use href="#i-expand"/></svg></button>');
$('#yt-host .yt-open').addEventListener('click', e => { e.stopPropagation(); openNow(); });
for (const ev of ['play', 'playing', 'pause', 'loadedmetadata']) ytAudio.addEventListener(ev, kickYt);
addEventListener('resize', kickYt);

function updateMediaSession(t) {
  kickYt();
  if (NATIVE && t.kind !== 'yt') return nativeNowPlaying(t);
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || t.category || '', artwork: [{ src: artOf(t, 'full'), sizes: '1200x1200' }] }); } catch {}
  // a music app: the lock screen and Control Center show previous / next song. Registering the 10-second skips
  // makes iPhone show those instead, so they are left off.
  const bk = isBook(t), el = engine.el; // books: 15 / 30 second skips on the lock screen, like Audible
  const h = { play: () => el.play(), pause: () => el.pause(), previoustrack: bk ? null : prev, nexttrack: bk ? null : () => next(), seekto: e => { engine.el.currentTime = e.seekTime; }, seekbackward: bk ? () => { engine.el.currentTime = Math.max(0, engine.el.currentTime - 15); } : null, seekforward: bk ? () => { engine.el.currentTime += 30; } : null };
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
function cycleSpeed() { P.speed = SPEEDS[(SPEEDS.indexOf(P.speed) + 1) % SPEEDS.length]; engine.setRate(P.speed); { const sp = $('#p-speed'); if (sp) sp.textContent = P.speed + '×'; } if (isBook(current())) { P.bookRate = true; S.settings.bookSpeed = P.speed; saveSettings(); } $('#speed-btn').textContent = P.speed + '×'; $('#speed-btn').classList.toggle('on', P.speed !== 1); }

/* =====================================================================
   Now playing: lyrics and queue
   ===================================================================== */
/**
 * iPhone: the cover flies between the mini player and the full player, the way Apple Music does it.
 * A copy of the cover moves between the two spots while the sheet slides; the real covers are hidden meanwhile.
 */
function coverFlight(opening) {
  if (innerWidth > 820 || document.documentElement.dataset.motion === 'reduce' || !$('#p-art')?.src) return;
  const n = $('#now'), mini = $('#p-art'), big = $('#now-art');
  const m = mini.getBoundingClientRect(); if (!m.width) return;
  // the big cover's spot once the sheet has finished sliding (measured against the sheet itself)
  const sr = n.getBoundingClientRect(), br = big.parentElement.getBoundingClientRect();
  const end = { left: br.left - sr.left, top: br.top - sr.top, width: br.width, height: br.height };
  if (!end.width) return;
  const from = opening ? { left: m.left, top: m.top, width: m.width, height: m.height, r: 11 } : { ...end, r: 14 };
  const to = opening ? { ...end, r: 14 } : { left: m.left, top: m.top, width: m.width, height: m.height, r: 11 };
  const img = document.createElement('img'); img.src = big.src || mini.src; img.alt = '';
  img.style.cssText = `position:fixed;z-index:80;object-fit:cover;pointer-events:none;left:0;top:0;width:${from.width}px;height:${from.height}px;border-radius:${from.r}px;transform:translate(${from.left}px,${from.top}px);box-shadow:0 18px 40px rgba(0,0,0,.45)`;
  document.body.appendChild(img);
  big.style.opacity = '0'; mini.style.opacity = '0';
  const a = img.animate([
    { transform: `translate(${from.left}px,${from.top}px)`, width: from.width + 'px', height: from.height + 'px', borderRadius: from.r + 'px' },
    { transform: `translate(${to.left}px,${to.top}px)`, width: to.width + 'px', height: to.height + 'px', borderRadius: to.r + 'px' },
  ], { duration: 520, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' });
  const done = () => { img.remove(); big.style.opacity = ''; mini.style.opacity = ''; };
  a.onfinish = done; a.oncancel = done; setTimeout(done, 800);
}
function openNow(panel) {
  if (!current()) return;
  const n = $('#now'); if (!panel && !n.classList.contains('open')) coverFlight(true); n.classList.add('open'); n.setAttribute('aria-hidden', 'false'); document.body.classList.add('now-is-open');
  if (panel) { P.panel = panel; n.classList.add('panel-open'); } else if (innerWidth <= 820) n.classList.remove('panel-open');
  history.pushState({ now: true }, ''); P.nowState = true;
  renderPanel(); kickYt();
}
function closeNow(fromPop) {
  const n = $('#now'); if (!n.classList.contains('open')) return;
  if (!n.classList.contains('panel-open')) coverFlight(false);
  n.classList.remove('open', 'panel-open', 'lyrics-full'); n.setAttribute('aria-hidden', 'true'); document.body.classList.remove('now-is-open');
  kickYt();
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
  if (P.panel === 'artist') { $('#lyrics-return').hidden = true; box.innerHTML = t.ext ? '<div class="am-empty">Nothing more to show for this one.</div>' : `<div class="am-panel">${artistMore(t)}</div>`; fillDiscover(); return; }
  if (t.kind === 'ayah' || t.kind === 'surahrec') {
    const cv = curVerse(), a = QR.text.get(cv.s)?.[cv.v - 1]; if (!a) qTextNow(cv.s).then(() => renderPanel()).catch(() => {});
    box.innerHTML = a ? `<div class="lyrics q-now"><p class="q-now-ar" dir="rtl" lang="ar">${esc(a.ar)}</p><p class="q-now-en">${esc(a.en)}</p><div class="lyrics-credit">Translation: Saheeh International</div></div>` : '';
    $('#lyrics-return').hidden = true; return;
  }
  if (isBook(t)) { box.innerHTML = chapterPanel(t); $('#lyrics-return').hidden = true; return; }
  if (t.kind === 'episode') { box.innerHTML = `<div class="lyrics plain pod-notes"><h3>${esc(t.title)}</h3><p>${esc((t.about || '').replace(/<[^>]+>/g, ' ')) || 'No show notes.'}</p></div>`; $('#lyrics-return').hidden = true; return; }
  if (!P.lyrics || P.lyrics.id !== t.id) {
    box.innerHTML = `<div class="lyrics-skel">${'<i></i>'.repeat(6)}</div>`;
    let l = await db.get('lyrics', t.id);
    if (!l || l.v !== 2) { if (!navigator.onLine) l = { none: true, offline: true }; else { l = await meta.findLyrics(t); db.put('lyrics', t.id, l); } }
    if (current()?.id !== t.id || P.panel !== 'lyrics') return;
    P.lyrics = { id: t.id, lines: l.synced && !l.hidden ? meta.parseLrc(l.synced) : null, plain: l.hidden ? '' : l.plain, none: l.none || l.hidden, offline: l.offline, reason: l.hidden ? 'hidden' : l.reason, lengthDiffers: l.lengthDiffers };
    P.lyricLine = -1;
  }
  const off = t.lyricOffset || 0;
  const tools = `<div class="lyrics-tools">${P.lyrics.lines ? `<span>Timing</span><button class="link" data-action="lyr-offset" data-d="-0.5">Earlier</button><b>${off > 0 ? '+' : ''}${off.toFixed(1)}s</b><button class="link" data-action="lyr-offset" data-d="0.5">Later</button><span class="sep">·</span>` : ''}<button class="link" data-action="lyr-wrong">Wrong lyrics?</button></div>`;
  if (P.lyrics.lines?.length) box.innerHTML = `<div class="lyrics" id="lyrics">${P.lyrics.lines.map((x, i) => `<p data-t="${x.t}" data-i="${i}">${esc(x.text) || '♪'}</p>`).join('')}<div class="lyrics-credit">Lyrics from LRCLIB</div>${tools}</div>`;
  else if (P.lyrics.plain) box.innerHTML = `<div class="lyrics plain">${P.lyrics.plain.split('\n').map(l => `<p>${esc(l) || '&nbsp;'}</p>`).join('')}<div class="lyrics-credit">Lyrics from LRCLIB · not time-synced${P.lyrics.lengthDiffers ? ' because your file’s length is different from the released song' : ''}</div>${tools}</div>`;
  else box.innerHTML = `<div class="lyrics-empty"><h2>No lyrics</h2><p>${P.lyrics.offline ? 'You’re offline. Lyrics load when you’re back online.' : P.lyrics.reason === 'hidden' ? 'You hid the lyrics for this song.' : t.category !== 'Music' ? 'Lyrics are only looked up for music.' : P.lyrics.reason === 'unknown' ? 'Add the artist in Edit info so the right lyrics can be found.' : P.lyrics.reason === 'length' ? 'Lyrics exist, but your file’s length is too different from the released song to match them safely.' : 'No lyrics found for this exact song.'}</p>${P.lyrics.reason === 'hidden' ? '<button class="pill-btn" data-action="lyr-retry">Look again</button>' : ''}</div>`;
  $('#lyrics-return').hidden = true;
  if (P.lyrics.lines) syncLyrics(engine.el.currentTime, true);
}
function syncLyrics(c, force) {
  const L = P.lyrics.lines; let i = -1;
  c += current()?.lyricOffset ? -current().lyricOffset : 0;
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
  const row = (id, i, drag) => { const x = T(id); if (!x) return ''; return `<div class="track q" data-qi="${i}" data-id="${id}">${drag ? '<div class="handle" aria-label="Drag to reorder"><svg><use href="#i-grip"/></svg></div>' : '<div></div>'}<div class="th"><img loading="lazy" src="${artOf(x)}" alt=""></div><div class="tmain"><div class="tt ellipsis">${esc(x.title)}</div><div class="ta ellipsis">${esc(x.artist)}</div></div><div class="td">${fmt(x.duration)}</div>${drag ? `<button class="icon-btn small" data-action="queue-remove" data-qi="${i}" aria-label="Remove"><svg><use href="#i-x"/></svg></button>` : '<div></div>'}</div>`; };
  const up = P.queue.slice(P.idx + 1).map((id, k) => [id, P.idx + 1 + k]);
  const mine = up.filter(([id]) => !P.autoAdded.has(id)), auto = up.filter(([id]) => P.autoAdded.has(id));
  const hist = P.played.slice(0, -1).slice(-20).reverse();
  box.innerHTML = `<div class="queue-panel">
    ${t ? `<h3>Now playing</h3>${row(t.id, P.idx, false).replace('class="track q"', 'class="track q playing"')}` : ''}
    <div class="q-head"><h3>Up next${P.context && P.mode !== 'flow' ? ' · ' + esc(P.context) : ''}</h3><div class="q-tools"><button class="q-mode ${P.shuffle ? 'on' : ''}" data-action="shuffle" aria-label="Shuffle"><svg><use href="#i-shuffle"/></svg></button><button class="q-mode ${P.repeat !== 'off' ? 'on' : ''}" data-action="repeat" aria-label="Repeat"><svg><use href="${P.repeat === 'one' ? '#i-repeat1' : '#i-repeat'}"/></svg></button>${mine.length ? '<button class="link" data-action="queue-clear">Clear</button>' : ''}<button class="link" data-action="queue-save">Save as playlist</button></div></div>
    <div class="q-list" data-sortable="queue">${mine.map(([id, i]) => row(id, i, true)).join('') || '<p class="q-empty">Nothing queued. Use Play next or Add to queue on any song.</p>'}</div>
    <div class="autoplay-row"><div><b>${P.mode === 'flow' ? 'Fof Flow' : P.mode === 'radio' ? 'Radio' : 'Autoplay'}</b><span>${P.mode ? 'Keeps adding songs from your library' : 'Similar songs from your library keep playing when this ends'}</span></div>${P.mode ? `<button class="link" data-action="end-mode">Stop</button>` : `<button class="switch ${S.settings.autoplay ? 'on' : ''}" data-action="toggle-setting" data-key="autoplay" aria-label="Autoplay"></button>`}</div>
    ${auto.length ? `<div class="q-list" data-sortable="queue">${auto.map(([id, i]) => row(id, i, true)).join('')}</div>` : ''}
    ${hist.length ? `<details class="q-hist"><summary>History</summary>${hist.map(id => { const x = T(id); return x ? `<div class="track q" data-id="${id}" data-hist="1"><div></div><div class="th"><img loading="lazy" src="${artOf(x)}" alt=""></div><div class="tmain"><div class="tt ellipsis">${esc(x.title)}</div><div class="ta ellipsis">${esc(x.artist)}</div></div><div class="td">${fmt(x.duration)}</div><div></div></div>` : ''; }).join('')}</details>` : ''}
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

function trackMenu(e, id, { player = false } = {}) {
  const t = T(id); if (!t) return;
  menu(e, [
    ...(player ? [['Sleep timer…', () => setTimeout(() => sleepMenu(e), 50)], [`Speed · ${engine.rate || 1}×`, () => cycleSpeed()], null] : []),
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
function radio(id) { const t = T(id); if (!t) return; P.shuffle = false; playList([id, ...similar(t, 20)], 0, { context: `${t.title} Radio`, mode: 'radio', seed: id }); toast(`${t.title} Radio · from your library`); }
function flow() { const ids = flowPicks(20); if (!ids.length) return toast('Add some music first'); P.shuffle = false; playList(ids, 0, { context: 'Fof Flow', mode: 'flow' }); toast('Fof Flow · endless music from your library'); }

async function like(id) {
  const t = T(id); if (!t) return;
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
    <div class="pl-pick">${pls.map(p => `<button class="pl-opt" data-pl-add="${p.id}"><span class="pl-thumb">${S.plCovers.get(p.id) ? `<img src="${S.plCovers.get(p.id)}" alt="">` : collageHtml(p.tracks.map(id => T(id)).filter(Boolean))}</span><span class="ellipsis">${esc(p.name)}</span><span class="muted">${p.tracks.length}</span></button>`).join('')}</div>
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
    const list = q ? S.index.search(q, 80).filter(r => r.kind === 'song').map(r => T(r.key)).filter(Boolean) : visible().sort(byAdded).slice(0, 60);
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
async function removeFromPlaylist(pid, id) { const p = S.playlists.get(pid); const i = p.tracks.indexOf(id); p.tracks = p.tracks.filter(x => x !== id); p.removed = [...new Set([...(p.removed || []), id])]; await savePlaylist(p); render(); toast('Removed from playlist', ['Undo', async () => { p.tracks.splice(i, 0, id); p.removed = (p.removed || []).filter(x => x !== id); await savePlaylist(p); render(); }]); }
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
    ['Change cover…', () => pickImage(async f => { const b = await thumbnail(f, 800) || f; await db.put('art', 'pl:' + p.id, b); swapUrl(S.plCovers, p.id, b); p.cover = true; if (S.user) { const w = await cloud.uploadFile('art/pl-' + p.id, b).catch(syncFailed); if (w) p.coverStore = w; } await savePlaylist(p); render(); })],
    ...(p.cover ? [['Use song artwork as cover', async () => { await db.del('art', 'pl:' + p.id); S.plCovers.delete(p.id); p.cover = false; await savePlaylist(p); render(); }]] : []),
    ['Playlist radio', () => { const ts = p.tracks.map(id => T(id)).filter(Boolean); if (!ts.length) return; P.shuffle = false; const base = shuffleArr(p.tracks); playList([...base, ...similar(ts.slice(0, 10), 15, new Set(base))], 0, { context: `${p.name} Radio`, mode: 'radio', seed: base[0] }); toast(`${p.name} Radio · your playlist plus similar songs from your library`); }],
    ['Duplicate', async () => { const c = { ...p, id: uid(), name: p.name + ' copy', tracks: [...p.tracks], cover: false, createdAt: Date.now() }; await savePlaylist(c); go('playlist/' + c.id); }],
    null,
    ['Delete playlist', () => confirmSheet(`Delete “${p.name}”?`, 'The songs stay in your library.', 'Delete', async () => { S.playlists.delete(pid); await db.del('playlists', pid); await db.del('art', 'pl:' + pid); S.plCovers.delete(pid); if (S.user) cloud.deletePlaylist(pid).catch(syncFailed); renderSidebar(); go('library'); }), 'danger'],
  ]);
}
function pickImage(cb) { const inp = $('#art-input'); inp.value = ''; inp.onchange = () => { const f = inp.files[0]; if (f) cb(f); }; inp.click(); }
function renderBadge() { const n = reviewList().length; const el = $('#review-link'); if (!el) return; el.hidden = !n; el.querySelector('.badge-n').textContent = n; }
function renderSidebar() {
  renderBadge();
  $('#sidebar-playlists').innerHTML = [...S.playlists.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => `<a class="nav-link pl-link" data-pl="${p.id}" href="#/playlist/${p.id}"><span class="pl-dot">${S.plCovers.get(p.id) ? `<img src="${S.plCovers.get(p.id)}" alt="">` : ''}</span><span class="ellipsis">${esc(p.name)}</span></a>`).join('') || '<button class="nav-link side-new" data-action="new-playlist"><svg><use href="#i-plus"/></svg>New playlist</button>';
}

function editSheet(id) {
  const t = T(id);
  let newArt = null;
  const cats = ['Music', 'Quran & Recitation', 'Nasheeds', 'Talks & Lectures'];
  const f = (k, l, v, extra = '') => `<label class="field"><span>${l}</span><input class="input" id="ed-${k}" value="${esc(v || '')}" ${extra}></label>`;
  sheet(`<h2>Edit info</h2>
    <div class="edit-art"><div class="coll-art small"><img id="ed-art" src="${artOf(t, 'full')}" alt=""></div>
      <div class="edit-art-btns"><button class="btn small" id="ed-find">Find artwork & details</button><button class="btn small ghost" id="ed-upload">Use my own image</button><button class="btn small ghost" id="ed-design">Use a plain cover</button></div></div>
    ${f('title', 'Title', t.title)}${f('artist', 'Artist', t.artist)}
    <div class="two">${f('album', 'Album', t.album)}${f('albumArtist', 'Album artist', t.albumArtist, 'placeholder="Same as artist"')}</div>
    <div class="three">${f('genre', 'Genre', t.genre)}${f('year', 'Year', t.year, 'inputmode="numeric"')}${f('trackNo', 'Track #', t.trackNo, 'inputmode="numeric"')}</div>
    <div class="field"><span class="field-l">Quick genre</span><div class="chips small" id="ed-genres">${GENRES.map(g => `<button class="chip ${t.genre === g ? 'on' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div></div>
    <div class="field"><span class="field-l">Moods</span><div class="chips small" id="ed-moods">${MOOD_KEYS.filter(k => k !== 'latenight' && k !== 'throwbacks').map(k => `<button class="chip ${(t.moods || []).includes(k) ? 'on' : ''}" data-m="${k}">${esc(MOODS[k].title)}</button>`).join('')}</div></div>
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
    el.querySelector('#ed-genres').onclick = e => { const b = e.target.closest('[data-g]'); if (!b) return; e.preventDefault(); const on = !b.classList.contains('on'); el.querySelectorAll('#ed-genres .chip').forEach(c => c.classList.remove('on')); if (on) { b.classList.add('on'); v('genre').value = b.dataset.g; } else v('genre').value = ''; };
    el.querySelector('#ed-moods').onclick = e => { const b = e.target.closest('[data-m]'); if (b) { e.preventDefault(); b.classList.toggle('on'); } };
    v('upload').onclick = () => pickImage(file => { newArt = file; v('art').src = URL.createObjectURL(file); });
    v('design').onclick = async () => { newArt = await meta.makeCover(v('title').value, v('artist').value, v('cat').value); v('art').src = URL.createObjectURL(newArt); };
    if (v('restore')) v('restore').onclick = () => { const o = t.original; v('title').value = o.title || t.title; v('artist').value = o.artist || t.artist; v('album').value = o.album || ''; v('genre').value = o.genre || ''; toast('Original details filled in. Save to keep them.'); };
    v('save').onclick = async () => {
      const prev = { title: t.title, artist: t.artist, album: t.album, genre: t.genre };
      t.moods = [...el.querySelectorAll('#ed-moods .chip.on')].map(b => b.dataset.m);
      Object.assign(t, { title: v('title').value.trim() || t.title, artist: v('artist').value.trim() || 'Unknown Artist', album: v('album').value.trim(), albumArtist: v('albumArtist').value.trim(), genre: v('genre').value.trim(), year: v('year').value.trim(), trackNo: v('trackNo').value.trim(), category: v('cat').value, edited: true });
      t.edits = [...(t.edits || []), { at: Date.now(), before: prev }].slice(-10);
      learnFix(t, prev);
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
  tell({ k: 'gone', id });
  for (const m of [S.art, S.thumbs]) { const u = m.get(id); if (u?.startsWith('blob:')) URL.revokeObjectURL(u); m.delete(id); }
}
function confirmDelete(id) {
  const t = T(id);
  confirmSheet(`Remove “${t.title}”?`, `It’s removed from Fof Music${S.user && t.cloud ? ' on all your devices' : ''}.${S.folder ? ` Its file moves out of “${S.folder.name}” into a “${REMOVED_DIR}” folder, so it isn’t added again.` : ' The original file on your computer is not touched.'}`, 'Remove', async () => {
    const moved = await moveOutOfFolder(t);
    await removeLocal(id);
    for (const p of S.playlists.values()) if (p.tracks.includes(id)) { p.tracks = p.tracks.filter(x => x !== id); savePlaylist(p); }
    if (S.user && t.cloud) cloud.deleteTrack(id).catch(syncFailed);
    const qi = P.queue.indexOf(id);
    if (qi >= 0) { P.queue.splice(qi, 1); if (qi < P.idx) P.idx--; else if (qi === P.idx) { engine.el.pause(); P.idx = Math.min(P.idx, P.queue.length - 1); if (P.queue.length) loadTrack(P.queue[P.idx], { autoplay: false }); } savePlayer(); }
    render(); toast(moved ? `Removed · file moved to “${REMOVED_DIR}”` : 'Removed from your library');
  });
}
/* Corrections you make are remembered: the same file name, or the same wrong artist, is fixed the same way next time. */
const fixKey = o => fold(meta.prepRaw(String(o.file || o.title || '').replace(/\.[^.]+$/, '')));
function applyFixes(base, o) {
  const n = S.fixes.names[fixKey(o)]; if (n) return { ...base, ...n, fixed: true };
  const a = S.fixes.artists[fold(base.artist || '')]; return a ? { ...base, artist: a } : base;
}
function learnFix(t, before) {
  if (before.title === t.title && before.artist === t.artist) return;
  const o = t.original || {};
  const k = fixKey({ file: o.file || t.file, title: o.title }); if (k) S.fixes.names[k] = { title: t.title, artist: t.artist };
  // a wrong artist is remembered only when no confirmed song in the library really is by that artist
  const wrong = before.artist;
  if (wrong && wrong !== t.artist && !/^unknown/i.test(wrong) && !/^unknown/i.test(t.artist) && ![...S.tracks.values()].some(x => x !== t && x.artist === wrong && (x.matched || x.edited || x.reviewed))) S.fixes.artists[fold(wrong)] = t.artist;
  const names = Object.entries(S.fixes.names); if (names.length > 3000) S.fixes.names = Object.fromEntries(names.slice(-3000));
  kv.set('fixes', S.fixes); queueStatePush();
}
/** Artist names already in your library, used to split names like "Benny the Butcher x Drake Buffalo". */
function knownArtists() {
  const out = new Set();
  for (const t of S.tracks.values()) { if (!t.artist || /^unknown/i.test(t.artist) || meta.looksLikeChannel(t.artist, S.channels)) continue; out.add(t.artist.replace(/ feat\. .*$/, '')); t.artist.split(/ feat\. | & |, | x /i).forEach(a => a.trim() && out.add(a.trim())); }
  return [...out].filter(a => a.length > 1).sort((a, b) => b.length - a.length);
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
async function rematch(t, { online = navigator.onLine, keepMatch = false } = {}) {
  const o = await originalOf(t);
  const reliable = meta.isReliable(o);
  const base = reliable ? { title: o.title, artist: o.artist, album: o.album } : applyFixes(meta.cleanNames(o, o.file || t.file || '', knownArtists().filter(a => a !== t.artist), S.channels), o);
  const music = meta.categorize({ ...t, ...base }) === 'Music';
  const blob = online && music && t.local ? await db.get('audio', t.id).catch(() => null) : null;
  const found = online && music ? await findSong(base, { blob, duration: t.duration }).catch(() => null) : null;
  // an automatic pass never undoes an earlier match just because a catalog didn't answer this time
  if (!found && keepMatch && t.matched) return false;
  let art = null;
  if (found) {
    Object.assign(t, reliable || base.fixed ? { title: base.title, artist: base.artist, album: base.album || found.album } : { title: found.title, artist: found.artist, album: found.album || base.album });
    Object.assign(t, { genre: meta.cleanGenre(o.genre) || found.genre || '', year: found.year || t.year, explicit: found.explicit, matched: true, matchedVia: found.via });
    art = await fileArt(t);
    if (!art || !reliable) art = await fetchFirstImage(found.artUrls) || art;
  } else {
    Object.assign(t, base, { genre: meta.cleanGenre(o.genre), year: reliable ? t.year : '', explicit: undefined, matched: false });
    art = await fileArt(t);
  }
  t.artist = meta.tidyArtist(t.artist);
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
/** One-time pass: songs without a confirmed match are listened to and looked up again (on the device that has the files). */
function identifyLibrary() { return oneTab('identify', identifyLibraryNow); }
async function identifyLibraryNow() {
  if (await kv.get('identify-v2') || !navigator.onLine) return;
  // only songs that need it: messy names or a placeholder cover (songs with proper tags already have both right)
  const todo = [...S.tracks.values()].filter(t => t.local && !t.edited && !t.reviewed && t.category === 'Music' && (t.designedCover || (!t.matched && !meta.isReliable(t.original || {}))));
  if (!todo.length) { await kv.set('identify-v2', true); return; }
  let found = 0;
  for (const t of todo) { if (!navigator.onLine) return; try { if (await rematch(t, { keepMatch: true })) found++; } catch (e) { console.warn('identify', e); } await new Promise(r => setTimeout(r, 1500)); } // gentle on Apple's search limits
  await kv.set('identify-v2', true);
  S.ver++; render();
  if (found) toast(`Identified ${count(found)} by sound and fixed their names and artwork`);
}
/** One-time repair: songs whose own tags were right ("Sugarcane - Remix" by Camidoh) but were split into the wrong title and artist. */
function restoreTags() { return oneTab('identify', restoreTagsNow); }
async function restoreTagsNow() {
  if (await kv.get('restore-tags-v1')) return;
  const todo = [...S.tracks.values()].filter(t => !t.edited && t.original && meta.isReliable(t.original) && (t.title !== t.original.title || t.artist !== meta.tidyArtist(t.original.artist)));
  for (const t of todo) { try { await rematch(t, { keepMatch: false }); } catch (e) { console.warn('restore', e); } await new Promise(r => setTimeout(r, 1200)); }
  await kv.set('restore-tags-v1', true);
  if (todo.length) { S.ver++; render(); toast(`Put back the proper names on ${count(todo.length)}`); }
}
/** One-time clean-up with the improved name rules (download-site labels, joined artist + title, odd characters). */
async function recleanNames() {
  if (await kv.get('reclean-v4')) return;
  const known = knownArtists();
  const todo = [];
  for (const t of S.tracks.values()) {
    if (t.edited) continue;
    const g = meta.cleanGenre(t.genre), a = meta.tidyArtist(t.artist);
    if (g !== (t.genre || '') || a !== t.artist) { t.genre = g; t.artist = a; await saveTrack(t); }
    if (t.matched) continue;
    const o = await originalOf(t);
    if (meta.isReliable(o)) continue;
    const base = meta.cleanNames(o, o.file || t.file || '', known.filter(a => a !== t.artist), S.channels);
    if (base.title !== t.title || base.artist !== t.artist || t.artist === 'Unknown Artist') todo.push(t);
  }
  let changed = 0;
  for (const t of todo) { const before = t.title + t.artist; await rematch(t); if (t.title + t.artist !== before) changed++; }
  await kv.set('reclean-v4', true);
  if (changed) { S.ver++; render(); toast(`Cleaned up ${count(changed)} with messy names`); }
}
async function refixAll() {
  const ts = [...S.tracks.values()].filter(t => !t.edited);
  if (!navigator.onLine) return toast('You’re offline');
  toast(`Checking ${count(ts.length)}…`);
  let matched = 0;
  for (const t of ts) if (await rematch(t)) matched++;
  S.ver++; render(); toast(`Done · ${matched} matched to the right song, the rest keep their own details`);
}
let uploading = false;
/** Quietly uploads songs that are still only on this device. */
function autoUpload() { return oneTab('upload', autoUploadNow); }
/** On the phone: liked songs and your most played are kept on the device, so they play with no signal. */
function autoOffline() { return oneTab('offline', autoOfflineNow); }
const isOff = t => t.local || !!(NATIVE && S.offPaths?.[t.id]);
const songExt = t => ((t.file || '').match(/\.(mp3|m4a|aac|flac|wav|ogg|opus|aiff?)$/i)?.[1] || 'mp3').toLowerCase();
/** Drops phone copies the system cleared to free space, so they're saved again. */
async function checkOffPaths() {
  if (!NATIVE || !S.offPaths) return;
  let gone = 0;
  for (const [id, v] of Object.entries(S.offPaths)) {
    const r = await NATIVE.hasFile({ name: v.name }).catch(() => null);
    if (r && !r.path) { delete S.offPaths[id]; gone++; } else if (r?.path && r.path !== v.path) v.path = r.path;
  }
  if (gone) kv.set('offPaths', S.offPaths);
}
async function autoOfflineNow(manual = false) {
  if (!(IN_APP || IS_IOS) || !S.user || !navigator.onLine || downloading || S.settings.autoOffline === false) return;
  const o = offSet();
  if (o.wifiOnly && !onWifi()) { if (manual) toast('Waiting for Wi-Fi. Turn off “Only on Wi-Fi” to save now.'); return; }
  downloading = true;
  try {
    await checkOffPaths();
    const all = [...S.tracks.values()].filter(t => t.cloud && !t.ext);
    const ranked = all.slice().sort((a, b) => (b.plays || 0) - (a.plays || 0) || (b.addedAt || 0) - (a.addedAt || 0));
    const top = o.top < 0 ? ranked : o.top ? ranked.filter(t => t.plays > 0).slice(0, o.top) : [];
    const upnext = o.upnext ? P.queue.slice(P.idx + 1, P.idx + 11).map(id => T(id)).filter(t => t && t.cloud) : [];
    const want = [...new Set([...upnext, ...(o.liked ? all.filter(t => t.liked) : []), ...top])].filter(t => !isOff(t));
    const cap = o.limitGB ? o.limitGB * 1e9 : Infinity;
    let used = all.filter(isOff).reduce((x, t) => x + (t.size || (t.duration || 200) * 24000), 0);
    let n = 0, fails = 0, i = 0;
    const one = async t => {
      const sz = t.size || (t.duration || 200) * 24000; if (used + sz > cap) return false;
      if (!navigator.onLine || (o.wifiOnly && !onWifi()) || S.settings.autoOffline === false) return false;
      try {
        const u = await cloud.fileUrl('audio/' + t.id, t.store === 'r2' || cloud.r2On()); if (!u) return true;
        if (NATIVE) {
          const name = 'song-' + t.id + '.' + songExt(t);
          const x = await NATIVE.download({ url: u, name }); if (!x?.path) return true;
          S.offPaths[t.id] = { path: x.path, name, size: sz }; if (++n % 10 === 0) kv.set('offPaths', S.offPaths);
        } else {
          const b = await (await fetch(u)).blob(); if (!b.size) return true;
          await db.put('audio', t.id, b); t.local = true; t.downloaded = true; t.autoSaved = true; await saveTrack(t, { sync: false }); n++;
        }
        used += sz; fails = 0; return true;
      } catch (e) { if (isQuotaError(e)) return false; return ++fails < 5; }
    };
    // three at a time; stops at the space limit, when Wi-Fi drops, or after repeated failures (phone full)
    await Promise.all([0, 1, 2].map(async () => { while (i < want.length) { const t = want[i++]; if (current()?.id === t.id && !NATIVE) continue; if (!(await one(t))) { i = want.length; break; } } }));
    if (NATIVE) kv.set('offPaths', S.offPaths);
    if (manual) toast(n ? `${count(n)} saved to this phone` : want.length ? 'Couldn’t save more right now' : 'Everything you chose is already on this phone');
  } finally { downloading = false; }
  if (o.podcasts) await podAutoSave().catch(() => {});
  await offlineQuran(o).catch(e => console.warn('quran offline', e));
}
function autoUploadNow() {
  if (!S.user || !navigator.onLine || uploading || IMP.running) return;
  if ([...S.tracks.values()].some(t => t.local && !t.cloud)) return uploadLocal({ quiet: true });
}
async function uploadLocal({ quiet = false } = {}) {
  if (uploading) return;
  const ts = [...S.tracks.values()].filter(t => t.local && !t.cloud);
  if (!ts.length) return; uploading = true;
  let n = 0, failed = 0, lastErr = null; if (!quiet) toast(`Uploading ${count(ts.length)} to your cloud library…`);
  // One song that won't upload used to stop every song after it; now it's skipped and the rest keep going.
  for (const t of ts) {
    if (!navigator.onLine) break;
    try { const a = await db.get('audio', t.id); const art = await db.get('art', t.id); if (a) { await uploadTrack(t, a, art); n++; } }
    catch (e) { failed++; lastErr = e; console.warn('Upload failed:', t.title, e); }
  }
  uploading = false;
  if (failed && lastErr) syncFailed(lastErr);
  if (n || !quiet) toast(`${count(n)} now on all your devices` + (failed ? ` · ${failed} couldn't upload, will retry` : '')); render();
}
function exportData() {
  const data = { exportedAt: new Date().toISOString(), app: 'Fof Music', songs: [...S.tracks.values()].map(({ colors, ...t }) => t), playlists: [...S.playlists.values()], listeningLog: S.log, recentlyPlayed: S.history, settings: S.settings };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `cadence-export-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* =====================================================================
   Events
   ===================================================================== */
// Small taps you can feel. Android uses vibrate; iPhone (iOS 18+) gives a tick when a switch control is toggled.
const haptic = (() => {
  if (navigator.vibrate) return () => { try { navigator.vibrate(8); } catch {} };
  const lab = document.createElement('label'); lab.setAttribute('aria-hidden', 'true');
  lab.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;left:-10px;top:0';
  const sw = document.createElement('input'); sw.type = 'checkbox'; sw.setAttribute('switch', ''); sw.tabIndex = -1;
  lab.appendChild(sw); document.body.appendChild(lab);
  return () => { try { lab.click(); } catch {} };
})();
const HAPTIC = new Set(['toggle', 'next', 'prev', 'like-current', 'like', 'shuffle', 'repeat', 'play-track', 'close-now', 'open-now']);
// AirPlay: Safari can hand the audio to an Apple TV, a Fire TV with AirPlay, or a speaker.
if (window.WebKitPlaybackTargetAvailabilityEvent) {
  if (NATIVE) $('#airplay-btn').hidden = false;
  for (const el of [$('#audio'), $('#audio-b')]) el.addEventListener('webkitplaybacktargetavailabilitychanged', e => { if (e.availability === 'available') $('#airplay-btn').hidden = false; });
}
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
    if (HAPTIC.has(a.dataset.action)) haptic();
    if (ACT2[a.dataset.action]) return ACT2[a.dataset.action](a, e);
    switch (a.dataset.action) {
      case 'noop': return;
      case 'pod-play': return podPlay(id);
      case 'book-play': return bookPlay(a.dataset.book, id);
      case 'skip-back': { const el = engine.el; el.currentTime = Math.max(0, el.currentTime - 15); return; }
      case 'skip-fwd': { const el = engine.el; el.currentTime = Math.min((el.duration || 1e9) - 1, el.currentTime + 30); return; }
      case 'book-restart': return bookRestart(a.dataset.book);
      case 'read-queued': return readQueued(id);
      case 'listen-queued': return readQueued(id, null, true);
      case 'bookmark': return addBookmark();
      case 'bookmark-go': return goBookmark(id, +a.dataset.t);
      case 'book-finish': { for (const c of bookChapters(a.dataset.book)) S.pod.prog[c.id] = { t: c.duration || 0, d: c.duration || 0, done: true, at: Date.now() }; podSave(); toast('Marked as finished'); return render(); }
      case 'book-filter': S.bookFilter = a.dataset.f; return render();
      case 'book-read': { const ch = bookChapters(a.dataset.book); const c = ch.find(x => x.id === current()?.id) || ch[bookSpot(a.dataset.book).i]; return c && openReader(c.id); }
      case 'read-now': return current() && openReader(current().id);
      case 'rd-open': RD.id = id; return paintReader();
      case 'artist-more': e.preventDefault(); return artistSheet();
      case 'want': { e.stopPropagation(); try { return toggleWant(JSON.parse(a.dataset.w)); } catch { return; } }
      case 'want-x': { e.stopPropagation(); S.want = wants().filter(w => w.key !== a.dataset.key || w.arrived); saveWant(); updateAddTabs(); return render(); }
      case 'get': e.stopPropagation(); return getSheet(a.dataset.key);
      case 'get-all': return getSheet(null, { all: true });
      case 'get-next': { const open = wants().filter(w => !w.arrived); const i = open.findIndex(w => w.key === a.dataset.key); const nx = open[i + 1]; return nx ? getSheet(nx.key, { all: true }) : closeSheet(); }
      case 'get-go': return getGo(a.dataset.k, a.dataset.q);
      case 'want-share': return navigator.share?.({ title: 'Songs I want', text: wants().filter(w => !w.arrived).map(w => `${w.artist} – ${w.title}`).join('\n') }).catch(() => {});
      case 'shazam-help': return shazamHelp();
      case 'dz-preview': return dzPreview(a);
      case 'dc-type': DC.type = id; DC.results = null; render(); return dcSearch();
      case 'yt': { e.stopPropagation(); dzStop(false); const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(a.dataset.q + ' official video'); if (IN_APP) location.href = url; else window.open(url, '_blank', 'noopener'); return; }
      case 'go-artist': { closeSheet?.(); closeNow(); return setTimeout(() => go('artist/' + encodeURIComponent(a.dataset.name)), 60); }
      case 'rp-story': return replayStory();
      case 'eq': return eqSheet();
      case 'eq-preset': return setEQ(id);
      case 'q-play': { const [n, v] = id.split(':').map(Number); const cur = current(); if (cur?.kind === 'ayah' && cur.surah === n && cur.n === v) return toggle(); return qPlay(n, v); }
      case 'q-resume': return qResume();
      case 'q-set-reciter': return qSetReciter(id);
      case 'q-sample': e.stopPropagation(); return qSample(id);
      case 'q-tab': QR.tab = id; return render();
      case 'q-rf': QR.rf = id; return render();
      case 'q-view': S.settings.qView = id; saveSettings(); return render();
      case 'q-verse': { const [n, v] = id.split(':').map(Number); return qVerseSheet(n, v); }
      case 'q-rep': { const [n, v] = id.split(':').map(Number); QR.memDraft = { s: n, from: v, to: v, each: 3, range: 1, gap: 1, speed: 1, hide: false }; return memStart(); }
      case 'q-save': { const [n, v] = id.split(':').map(Number); return qSave(n, v); }
      case 'q-copy': { const [n, v] = id.split(':').map(Number); try { await navigator.clipboard.writeText(verseText(n, v)); toast('Copied'); } catch { toast('Couldn’t copy'); } return; }
      case 'q-share': { const [n, v] = id.split(':').map(Number); return navigator.share?.({ text: verseText(n, v) }).catch(() => {}); }
      case 'q-mem': { const n = +id; try { await qTextNow(n); } catch {} if (!QR.list) QR.list = await quran.surahs().catch(() => null); return memSheet(n); }
      case 'mem-step': { const [k, d] = id.split(':'); return memAdjust(k, +d); }
      case 'mem-start': return memStart();
      case 'pod-dl': return podDownload(id);
      case 'pod-follow': return podFollow(id);
      case 'pod-clear': PC.results = null; PC.q = ''; return render();
      case 'shelf-prev': case 'shelf-next': { const sh = a.closest('.section')?.querySelector('.shelf'); if (sh) sh.scrollBy({ left: (a.dataset.action === 'shelf-next' ? 1 : -1) * sh.clientWidth * .85, behavior: 'smooth' }); return; }
      case 'airplay': try { engine.el.webkitShowPlaybackTargetPicker(); } catch { toast('AirPlay isn’t available here'); } return;
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
      case 'track-menu-current': return current() && trackMenu(e, current().id, { player: true });
      case 'open-now': return openNow();
      case 'close-now': return closeNow();
      case 'open-lyrics': return openNow('lyrics');
      case 'open-queue': return openNow('queue');
      case 'tab-lyrics': case 'tab-queue': case 'tab-artist': {
        const p = a.dataset.action.slice(4); const n = $('#now');
        if (innerWidth <= 820 && n.classList.contains('panel-open') && P.panel === p) n.classList.remove('panel-open'); else { P.panel = p; n.classList.add('panel-open'); } kickYt();
        if (p === 'queue') n.classList.remove('lyrics-full');
        if (p !== 'lyrics') n.classList.remove('lyrics-full');
        for (const k of ['lyrics', 'artist', 'queue']) $('#ic-' + k)?.classList.toggle('on-panel', n.classList.contains('panel-open') && P.panel === k);
        return renderPanel();
      }
      case 'dl': return downloadSongs(a.dataset.ids.split(','), '');
      case 'dl-remove': return confirmSheet('Remove downloads?', 'These songs leave this device but still stream from your cloud library.', 'Remove', () => removeDownloads(a.dataset.ids.split(',')), false);
      case 'pick-playlists': { const i = $('#pl-file-input'); i.value = ''; return i.click(); }
      case 'copy-missing': { const p = S.playlists.get(a.dataset.pl); try { await navigator.clipboard.writeText(p.missing.map(m => `${m.artist ? m.artist + ' - ' : ''}${m.title}`).join('\n')); toast('Copied the list'); } catch { toast('Couldn’t copy'); } return; }
      case 'connect-folder': return connectFolder();
      case 'disconnect-folder': return disconnectFolder();
      case 'scan-folder': return scanFolder({ user: true });
      case 'clear-channels': S.channels = []; await kv.set('channels', []); queueStatePush(); return render();
      case 'rv-ok': { const row = a.closest('.rv'); await saveReview(id, { approve: true }); row?.classList.add('done'); setTimeout(() => { if (S.route === 'review') render(); }, 260); renderBadge(); return; }
      case 'rv-all': for (const t of reviewList(true)) { t.reviewed = true; await saveTrack(t); } render(); return toast('All marked as good');
      case 'rv-channel': return markChannel(a.dataset.name);
      case 'rv-genre': { await setGenre(id, a.dataset.g); const t = T(id); a.parentElement.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.g === t.genre)); return; }
      case 'rv-art': return pickImage(async f => { const t = T(id); await setArt(t, f); t.designedCover = false; await saveTrack(t); if (S.user && t.cloud) cloud.uploadFile('art/' + t.id, f).catch(syncFailed); render(); });
      case 'artist-genre': { const name = a.dataset.name; return menu(e, [...GENRES.map(g => [g, async () => { const ts = groups('artist').get(name) || []; for (const t of ts) { t.genre = g; t.genreByUser = true; await saveTrack(t); } S.ver++; render(); toast(`${name}: ${g} · ${count(ts.length)}`); }]), null, ['Other…', () => sheet(`<h2>Genre for ${esc(name)}</h2><input class="input full" id="gn" placeholder="e.g. Ndombolo"><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="gn-ok">Save</button></div>`, el => { el.querySelector('#gn-ok').onclick = async () => { const g = el.querySelector('#gn').value.trim(); if (!g) return; for (const t of groups('artist').get(name) || []) { t.genre = g; t.genreByUser = true; await saveTrack(t); } S.ver++; closeSheet(); render(); }; })]]); }
      case 'lyr-offset': { const t = current(); if (!t) return; t.lyricOffset = Math.round(((t.lyricOffset || 0) + +a.dataset.d) * 10) / 10; await saveTrack(t); renderPanel(); return; }
      case 'lyr-wrong': { const t = current(); if (!t) return; await db.put('lyrics', t.id, { v: 2, none: true, hidden: true }); P.lyrics = null; renderPanel(); return toast('Lyrics hidden for this song', ['Undo', async () => { await db.del('lyrics', t.id); P.lyrics = null; renderPanel(); }]); }
      case 'lyr-retry': { const t = current(); if (!t) return; await db.del('lyrics', t.id); P.lyrics = null; return renderPanel(); }
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
      case 'radio-artist': { const ts = groups('creditedArtist').get(a.dataset.name) || []; if (!ts.length) return; P.shuffle = false; const seed = ts[Math.floor(Math.random() * ts.length)]; playList([...shuffleArr(ts.map(t => t.id)).slice(0, 6), ...similar(ts, 20, new Set(ts.map(t => t.id)))], 0, { context: `${a.dataset.name} Radio`, mode: 'radio', seed: seed.id }); return toast(`${a.dataset.name} Radio · from your library`); }
      case 'play-one': return playList([id], 0, { context: 'Duplicates' });
      case 'new-playlist': return newPlaylist();
      case 'playlist-menu': return playlistMenu(e, a.dataset.pl);
      case 'pl-add-songs': return addSongsSheet(a.dataset.pl);
      case 'pl-sort': { const p = S.playlists.get(a.dataset.pl); p.sort = a.dataset.sort; await savePlaylist(p); return render(); }
      case 'add-all': return addToPlaylistSheet(a.dataset.listIds.split(','));
      case 'save-list': return newPlaylist(a.dataset.listIds.split(','));
      case 'check-pick': return $('#check-file')?.click();
      case 'check-filter': CHECK.filter = a.dataset.filter; CHECK.page = 0; return render();
      case 'check-page': CHECK.page = +a.dataset.page; render(); return $('#check-query')?.scrollIntoView({ block: 'center' });
      case 'check-export': return checkExport(false);
      case 'check-copy': return checkExport(true);
      case 'check-paste': return sheet('<h2>Paste track list</h2><textarea class="input full" aria-label="Track list" id="check-pasted" placeholder="Artist - Song" rows="8"></textarea><div class="actions"><button class="btn primary" data-action="check-add-paste">Check tracks</button></div>');
      case 'check-add-paste': {
        const lists = checkText($('#check-pasted').value, 'Pasted list');
        if (!lists.length) return toast('Enter one Artist - Song entry per line.');
        closeSheet(); return addChecks(lists);
      }
      case 'check-decision': {
        const list = checkSelected(), i = +a.dataset.i;
        const row = checkResults(list)[i];
        if (!row?.match) return;
        return sheet('<h2>Same recording?</h2><p>' + esc(row.item.title) + ' · ' + esc(row.item.artist) + '</p><p>In your library: ' + esc(row.match.title) + ' · ' + esc(row.match.artist) + '</p><div class="actions"><button class="btn" data-action="check-record" data-i="' + i + '" data-match="missing">Keep missing</button><button class="btn primary" data-action="check-record" data-i="' + i + '" data-match="' + esc(row.match.id) + '">Same recording</button></div>');
      }
      case 'check-record': checkSelected().decisions[a.dataset.i] = a.dataset.match; closeSheet(); return saveChecks();
      case 'check-reset': delete checkSelected().decisions[a.dataset.i]; return saveChecks();
      case 'pick-folder': { const i = $('#folder-input'); i.value = ''; return i.click(); }
      case 'pick-files': { const i = $('#file-input'); i.value = ''; return i.click(); }
      case 'imp-cancel': IMP.cancel = true; return toast('Stopping after the songs in progress…');
      case 'imp-retry': return importFiles(IMP.jobs.filter(j => j.state === 'error').map(j => j.file), { retry: true });
      case 'imp-clear': IMP.jobs = []; return render();
      case 'sort-col': { const k = a.dataset.sort; if (S.settings.songSort === k) S.settings.songDir *= -1; else { S.settings.songSort = k; S.settings.songDir = ['title', 'artist', 'album'].includes(k) ? 1 : -1; } await saveSettings(); return render(); }
      case 'toggle-setting': S.settings[a.dataset.key] = !S.settings[a.dataset.key]; a.classList.toggle('on', S.settings[a.dataset.key]); S.settingsAt = Date.now(); kv.set('settingsAt', S.settingsAt); await saveSettings(); if (['hideExplicit'].includes(a.dataset.key)) { S.ver++; S.indexDirty = true; render(); } if (a.dataset.key === 'askUnsure') { renderBadge(); render(); } return;
      case 'set': S.settings[a.dataset.key] = a.dataset.val; S.settingsAt = Date.now(); kv.set('settingsAt', S.settingsAt); await saveSettings(); return render();
      case 'back': return history.length > 1 ? history.back() : go('home');
      case 'clear-searches': S.searches = []; kv.set('searches', []); return render();
      case 'search-view': S.searchView = a.dataset.view; render(); $('[data-action="search-view"][aria-pressed="true"]')?.focus(); return;
      case 'discover-retry': refreshDiscover(); return;
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
      case 'wipe-cloud': return confirmSheet('Delete your cloud library?', 'Your songs, playlists and history are permanently removed from the cloud. Songs saved on this device stay here.', 'Delete from cloud', async () => { toast('Deleting…'); try { await Promise.all([...S.tracks.values()].filter(t => t.store === 'r2').map(t => cloud.deleteTrack(t.id).catch(() => {}))); await cloud.deleteEverything(); for (const t of S.tracks.values()) { t.cloud = false; if (!t.local) await removeLocal(t.id); else await db.put('tracks', t.id, t); } toast('Your cloud library was deleted'); render(); } catch (err) { syncFailed(err); } });
      case 'change-pass': return sheet(`<h2>Change password</h2><input class="input full" id="np" type="password" placeholder="New password (6+ characters)" autocomplete="new-password"><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="np-go">Save</button></div>`, el => { el.querySelector('#np-go').onclick = async () => { const v = el.querySelector('#np').value; if (v.length < 6) return toast('Use at least 6 characters'); try { await cloud.changePassword(v); closeSheet(); toast('Password changed'); } catch (err) { toast(friendlyError(err, 'Couldn’t change the password. Try again.')); } }; });
      case 'sign-in': case 'sign-up': {
        const email = $('#auth-email').value.trim(), pass = $('#auth-pass').value;
        if (!email || pass.length < 6) return toast('Enter your email and a password of 6+ characters');
        a.disabled = true;
        try {
          const net = err => /failed to fetch|networkerror|load failed|fetch failed/i.test(String(err?.message || err));
          const tryIt = () => a.dataset.action === 'sign-in' ? cloud.signIn(email, pass) : null;
          if (a.dataset.action === 'sign-in') { try { await tryIt(); } catch (e1) { if (!net(e1)) throw e1; toast('Connecting…'); await new Promise(r => setTimeout(r, 3000)); await tryIt(); } }
          else { const live = await cloud.signUp(email, pass); if (!live) { a.disabled = false; return toast('Check your email to confirm your account, then sign in here'); } }
          S.user = await cloud.user(); await syncDown(); render();
          const localOnly = [...S.tracks.values()].filter(t => t.local && !t.cloud).length;
          toast(localOnly ? 'Signed in · uploading your songs' : 'Signed in');
        } catch (err) { a.disabled = false; toast(friendlyError(err, 'Couldn’t sign in. Try again.')); }
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
function collectionRoute() { return ['album', 'artist', 'playlist', 'smart', 'mix', 'mood', 'liked', 'daily'].includes(S.route) ? location.hash.replace(/^#\/?/, '') && decodeURIComponent(location.hash.replace(/^#\/?/, '')) : ''; }
function contextName() {
  if (S.route === 'mix') return mixName(S.param);
  if (S.route === 'artist') return S.param;
  if (S.route === 'album') return S.param.split('\u0001')[0];
  if (S.route === 'playlist') return S.playlists.get(S.param)?.name || 'Playlist';
  if (S.route === 'smart') return SMART[S.param]?.title;
  if (S.route === 'mood') return MOODS[S.param]?.title;
  if (S.route === 'daily') return `Daily Mix ${S.param}`;
  return { home: 'Home', songs: 'Songs', liked: 'Liked Songs', search: 'Search' }[S.route] || '';
}
document.addEventListener('contextmenu', e => { const r = e.target.closest('.track[data-id]'); if (r && !r.classList.contains('q')) { e.preventDefault(); trackMenu({ target: r.querySelector('.more') || r }, r.dataset.id); } });
document.addEventListener('dblclick', e => { if (e.target.closest('.p-track')) openNow(); });

let searchT;
document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'check-query') {
    const pos = e.target.selectionStart;
    CHECK.query = e.target.value; CHECK.page = 0; render();
    const input = $('#check-query'); input?.focus(); input?.setSelectionRange(pos, pos);
    return;
  }
  if (id === 'search-input') {
    clearTimeout(searchT);
    const q = e.target.value;
    searchT = setTimeout(() => {
      if (S.route !== 'search' || !e.target.isConnected) return;
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
document.addEventListener('change', async e => {
  if (e.target.id === 'check-list') { CHECK.selected = e.target.value; resetCheck(); return render(); }
  if (e.target.id !== 'check-file') return;
  const files = [...e.target.files]; e.target.value = '';
  const lists = [];
  for (const file of files) {
    try {
      if (file.size > 12000000) throw Error('File too large');
      const name = file.name.replace(/\.[^.]+$/, '');
      if (/\.xlsx$/i.test(file.name)) lists.push({ name, items: await checkSpreadsheet(file) });
      else lists.push(...checkText(await readText(file), name));
    } catch { toast('Couldn’t read ' + file.name + '. Try exporting the track list as CSV.'); }
  }
  if (files.length) await addChecks(lists);
});
document.addEventListener('change', e => { const rv = e.target.closest('.rv'); if (rv && e.target.dataset.f) saveReview(rv.dataset.rv); });
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
$('#book-input').addEventListener('change', e => { const f = e.target.files[0]; if (f) sendBook(f); });
$('#pl-file-input').addEventListener('change', e => importPlaylistFiles([...e.target.files]));
$('#folder-input').addEventListener('change', e => importFiles([...e.target.files]));
window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dragging-files'); } });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging-files'); });
window.addEventListener('drop', async e => { document.body.classList.remove('dragging-files'); if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); $('#drop')?.classList.remove('over'); importFiles(await filesFromDrop(e.dataTransfer)); });
window.addEventListener('pagehide', () => { flushListen(); savePlayer(true); });

// mini player: swipe up opens the full player, swipe sideways skips
(() => {
  let x0 = null, y0 = null; const pl = $('#player');
  pl.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  pl.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (dy < -40 && Math.abs(dx) < 50) openNow();
    else if (Math.abs(dx) > 60 && Math.abs(dy) < 40) { pl.classList.add(dx < 0 ? 'swipe-l' : 'swipe-r'); setTimeout(() => pl.classList.remove('swipe-l', 'swipe-r'), 300); haptic(); dx < 0 ? next() : prev(); }
  }, { passive: true });
})();
// swipe down to close the full player on phones
(() => {
  let y0 = null, x0 = null; const n = $('#now');
  n.addEventListener('touchstart', e => { if (e.target.closest('.now-right,input,.q-list')) return; y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; }, { passive: true });
  n.addEventListener('touchend', e => { if (y0 === null) return; const dy = e.changedTouches[0].clientY - y0, dx = e.changedTouches[0].clientX - x0; if (dy > 90 && Math.abs(dx) < 60) closeNow(); else if (Math.abs(dx) > 80 && Math.abs(dy) < 40 && e.target.closest('.now-art')) dx < 0 ? next() : prev(); y0 = null; });
})();

bindReader();
boot();

/* =====================================================================
   Podcasts
   ===================================================================== */
const PC = { shows: new Map(), eps: new Map(), topic: new Map(), loading: new Set(), q: '', results: null, suggest: [] };
const icon = (n, cls = '') => `<svg class="${cls}"><use href="#i-${n}"/></svg>`;
function podSave() { clearTimeout(podSave.t); podSave.t = setTimeout(() => { kv.set('pod', S.pod); queueStatePush(); }, 400); }
function podProgress(t, c, d) { S.pod.prog[t.id] = { t: Math.round(c), d: Math.round(d), done: d - c < 30, at: Date.now() }; saveExt(t); podSave(); }
const following = id => S.pod.subs.some(s => s.id === String(id));
/** Fetches once, then redraws the page if you're still on it. */
function podLoad(key, fn) {
  if (PC.loading.has(key)) return; PC.loading.add(key);
  const r = S.route;
  fn().catch(e => console.warn('podcasts', e)).finally(() => { PC.loading.delete(key); PC.done = (PC.done || new Set()).add(key); if (S.route === r) render(); });
}
function showEps(id) {
  if (!PC.eps.has(id) && !PC.done?.has('e' + id)) podLoad('e' + id, async () => { const r = await pods.episodes(id); if (r.show) PC.shows.set(id, r.show); r.episodes.forEach(e => S.ext.has(e.id) || null); PC.eps.set(id, r.episodes); });
  return PC.eps.get(id);
}
function timeLeft(ep) {
  const pr = S.pod.prog[ep.id]; const d = ep.duration || pr?.d || 0;
  if (pr?.done) return 'Played';
  const left = pr && pr.t > 5 ? d - pr.t : d;
  if (!left) return 'Play';
  const m = Math.max(1, Math.round(left / 60)); const txt = m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60 ? (m % 60) + ' min' : ''}`.trim() : `${m} min`;
  return pr && pr.t > 5 ? `${txt} left` : txt;
}
const epDate = ms => { if (!ms) return ''; const d = (Date.now() - ms) / DAY; return d < 1 ? 'Today' : d < 2 ? 'Yesterday' : d < 7 ? new Date(ms).toLocaleDateString(undefined, { weekday: 'long' }) : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined }); };
function epRow(ep, { art = true } = {}) {
  PC.ep = PC.ep || new Map(); PC.ep.set(ep.id, ep);
  const pr = S.pod.prog[ep.id], saved = T(ep.id)?.path || T(ep.id)?.local, pct = pr && ep.duration ? Math.min(100, pr.t / (pr.d || ep.duration) * 100) : 0;
  return `<div class="pod-ep${current()?.id === ep.id ? ' playing' : ''}" data-action="pod-play" data-id="${esc(ep.id)}">
    ${art ? `<img class="pod-ep-art" loading="lazy" src="${esc(ep.art)}" alt="">` : ''}
    <div class="pod-ep-main"><div class="pod-ep-date">${esc(epDate(ep.date))}</div><div class="pod-ep-t">${esc(ep.title)}</div>${ep.about ? `<div class="pod-ep-d">${esc(ep.about.replace(/<[^>]+>/g, ' '))}</div>` : ''}
      <div class="pod-ep-foot"><span class="pod-pill">${icon(current()?.id === ep.id && !engine.el.paused ? 'pause' : 'play')}${esc(timeLeft(ep))}</span>${pct && !pr.done ? `<span class="pod-bar"><i style="width:${pct}%"></i></span>` : ''}
      <button class="icon-btn small pod-dl${saved ? ' on' : ''}" data-action="pod-dl" data-id="${esc(ep.id)}" aria-label="${saved ? 'Saved on this device' : 'Save for offline'}">${icon(saved ? 'saved' : 'download')}</button></div></div></div>`;
}
function showTile(sh) { PC.shows.set(sh.id, sh); return `<a class="pod-show" href="#/show/${sh.id}"><img loading="lazy" src="${esc(sh.art)}" alt=""><div class="t ellipsis">${esc(sh.title)}</div><div class="s ellipsis">${esc(sh.author)}</div></a>`; }
function upNext() {
  const inProg = Object.entries(S.pod.prog).filter(([id, p]) => !p.done && p.t > 5 && S.ext.has(id)).sort((a, b) => b[1].at - a[1].at).map(([id]) => S.ext.get(id));
  const fresh = S.pod.subs.map(s => (PC.eps.get(s.id) || [])[0]).filter(e => e && !S.pod.prog[e.id]);
  const seen = new Set(); return [...inProg, ...fresh].filter(e => !seen.has(e.id) && seen.add(e.id)).slice(0, 12);
}
function upCard(ep) {
  PC.ep = PC.ep || new Map(); PC.ep.set(ep.id, ep);
  const pr = S.pod.prog[ep.id], pct = pr && ep.duration ? Math.min(100, pr.t / ep.duration * 100) : 0;
  return `<div class="pod-up" data-action="pod-play" data-id="${esc(ep.id)}"><div class="pod-up-art"><img loading="lazy" src="${esc(ep.art)}" alt=""></div>
    <div class="pod-up-meta"><div class="pod-ep-date">${pr ? 'Resume' : esc(epDate(ep.date))}</div><div class="pod-up-t">${esc(ep.title)}</div><div class="pod-up-foot">${esc(timeLeft(ep))}${pct ? `<span class="pod-bar"><i style="width:${pct}%"></i></span>` : ''}</div></div></div>`;
}
/* =====================================================================
   Audiobooks: your own books, narrated on your Mac, with your place saved on every device
   ===================================================================== */
const bookKey = t => `${t.album || t.title}\u0001${t.albumArtist || t.artist}`;
function books() {
  const m = new Map();
  for (const t of S.tracks.values()) { if (!isBook(t)) continue; const k = bookKey(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  for (const ts of m.values()) ts.sort((a, b) => (parseInt(a.trackNo) || 0) - (parseInt(b.trackNo) || 0) || (a.file || '').localeCompare(b.file || ''));
  return m;
}
const bookChapters = key => books().get(key) || [];
function bookProgress(t, c, d) { S.pod.prog[t.id] = { t: Math.round(c), d: Math.round(d), done: d - c < 3, at: Date.now() }; podSave(); }
/** Where you are in a book: the chapter you last listened to (or the next one if you finished it). */
function bookSpot(key) {
  const ch = bookChapters(key); if (!ch.length) return null;
  let last = -1, at = 0;
  ch.forEach((t, i) => { const p = S.pod.prog[t.id]; if (p && p.at > at) { at = p.at; last = i; } });
  if (last < 0) return { i: 0, t: 0, started: false, at: 0 };
  const p = S.pod.prog[ch[last].id];
  if (p.done) return last + 1 < ch.length ? { i: last + 1, t: 0, started: true, at } : { i: 0, t: 0, started: true, finished: true, at };
  return { i: last, t: p.t, started: true, at };
}
function bookStats(key) {
  const ch = bookChapters(key), total = ch.reduce((a, t) => a + (t.duration || 0), 0);
  // one progress model for the whole app: finished chapters count in full, the playing chapter counts live, others by saved position
  const heard = ch.reduce((a, t) => { if (current()?.id === t.id && engine.el.currentTime) return a + Math.min(engine.el.currentTime, t.duration || engine.el.duration || 0); const p = S.pod.prog[t.id]; return a + (p ? (p.done ? (t.duration || p.d || 0) : Math.min(p.t, t.duration || p.t)) : 0); }, 0);
  return { total, left: Math.max(0, total - heard), pct: total ? Math.min(100, heard / total * 100) : 0 };
}
const leftTxt = s => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60 ? (m % 60) + ' min' : ''}`.trim() : `${m} min`; };
async function bookPlay(key, id) {
  const ch = bookChapters(key); if (!ch.length) return;
  let i = id ? ch.findIndex(t => t.id === id) : -1;
  if (i < 0) { const sp = bookSpot(key); i = sp.i; }
  if (current()?.id === ch[i].id) return toggle();
  const t = ch[i], p = S.pod.prog[t.id];
  if (id && p?.done) delete S.pod.prog[t.id]; // tapping a finished chapter plays it again from the start
  await playList(ch.map(x => x.id), i, { context: t.album || 'Audiobook', ctxRoute: 'book/' + encodeURIComponent(key) });
}
function bookRestart(key) {
  confirmSheet('Start this book over?', 'Your place in every chapter is cleared on all your devices.', 'Start over', async () => {
    for (const t of bookChapters(key)) delete S.pod.prog[t.id];
    podSave(); render(); bookPlay(key);
  });
}
/** Books keep their own speed (many people listen faster); music always goes back to normal speed. */
function bookSpeed(on) {
  const r = on ? (S.settings.bookSpeed || 1) : 1;
  P.bookRate = on; P.speed = r; engine.setRate(r);
  const b = $('#speed-btn'); if (b) { b.textContent = r + '×'; b.classList.toggle('on', r !== 1); }
}
function chapterPanel(t) {
  const key = bookKey(t), ch = bookChapters(key);
  return `<div class="book-chapters"><div class="bc-head"><b>${esc(t.album || 'Chapters')}</b><span>${esc(t.artist)}</span><button class="pill-btn bc-read" data-action="read-now">${icon('read')}Read along</button></div>${chapterList(ch, key)}</div>`;
}
/** Long chapters are recorded in parts ("Part One (2 of 3)"). Show them under one numbered chapter; each part still plays on its own. */
function chapterList(ch, key) {
  const out = []; let n = 0, last = null;
  ch.forEach((c, i) => {
    const m = /^(.*) \((\d+) of (\d+)\)$/.exec(c.title || '');
    if (m && last === m[1]) { out.push(chapterRow(c, i, key, { part: `Part ${m[2]}`, sub: true })); return; }
    n++; last = m ? m[1] : null;
    if (m) { out.push(`<div class="ch-group"><span class="ch-n">${n}</span><span class="ch-t">${esc(m[1])}</span><span class="ch-time">${m[3]} parts</span></div>`); out.push(chapterRow(c, i, key, { part: `Part ${m[2]}`, sub: true })); }
    else out.push(chapterRow(c, i, key, { n }));
  });
  return out.join('');
}
function chapterRow(c, i, key, o = {}) {
  const p = S.pod.prog[c.id], on = current()?.id === c.id, d = c.duration || p?.d || 0;
  const state = p?.done ? 'Finished' : p && p.t > 5 && d ? `${leftTxt(d - p.t)} left` : d ? leftTxt(d) : '';
  const pct = p && !p.done && d ? Math.min(100, p.t / d * 100) : 0;
  return `<div class="chapter${on ? ' playing' : ''}${p?.done ? ' done' : ''}${o.sub ? ' sub' : ''}" data-action="book-play" data-book="${esc(key)}" data-id="${esc(c.id)}">
    <span class="ch-n">${on && !engine.el.paused ? '<span class="eq"><i></i><i></i><i></i></span>' : p?.done ? icon('check') : o.sub ? '' : o.n || i + 1}</span>
    <span class="ch-main"><span class="ch-t ellipsis">${esc(o.part || c.title)}</span>${pct ? `<span class="pod-bar"><i style="width:${pct}%"></i></span>` : ''}</span>
    <span class="ch-time">${esc(state)}</span></div>`;
}
function bookCover(t, cls = '') { return `<div class="book-cover ${cls}"><img loading="lazy" decoding="async" src="${artOf(t, cls ? 'full' : 'thumb')}" alt=""></div>`; }
function bookCard([key, ch]) {
  const st = bookStats(key), sp = bookSpot(key);
  return `<a class="book-card" href="#/book/${encodeURIComponent(key)}">${bookCover(ch[0])}
    <div class="bk-t ellipsis">${esc(ch[0].album || ch[0].title)}</div><div class="bk-s ellipsis">${esc(ch[0].artist)}</div>
    <div class="bk-foot">${sp?.finished ? 'Finished' : sp?.started ? `<span class="pod-bar"><i style="width:${st.pct}%"></i></span>${esc(leftTxt(st.left))} left` : esc(leftTxt(st.total))}</div></a>`;
}
/** Reads an EPUB's cover, title and author in the browser, so a book shows its real cover while it waits to be narrated. */
async function epubInfo(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()), view = new DataView(bytes.buffer), dec = new TextDecoder();
    let end = bytes.length - 22; while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--; if (end < 0) return {};
    const files = new Map(); let pos = view.getUint32(end + 16, true);
    for (let i = 0; i < view.getUint16(end + 10, true); i++) { const nl = view.getUint16(pos + 28, true); files.set(dec.decode(bytes.subarray(pos + 46, pos + 46 + nl)), { m: view.getUint16(pos + 10, true), size: view.getUint32(pos + 20, true), off: view.getUint32(pos + 42, true) }); pos += 46 + nl + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true); }
    const read = async name => { const f = files.get(name); if (!f) return null; const st = f.off + 30 + view.getUint16(f.off + 26, true) + view.getUint16(f.off + 28, true); const d = bytes.subarray(st, st + f.size); return f.m === 8 ? new Uint8Array(await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : d; };
    const xml = async n => { const b = await read(n); return b && new DOMParser().parseFromString(dec.decode(b), 'application/xml'); };
    const opfPath = (await xml('META-INF/container.xml'))?.querySelector('rootfile')?.getAttribute('full-path'); if (!opfPath) return {};
    const opf = await xml(opfPath), base = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';
    const title = opf.getElementsByTagName('dc:title')[0]?.textContent?.trim(), author = opf.getElementsByTagName('dc:creator')[0]?.textContent?.trim();
    const about = (new DOMParser().parseFromString(opf.getElementsByTagName('dc:description')[0]?.textContent || '', 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    const items = [...opf.getElementsByTagName('item')], metaCover = [...opf.getElementsByTagName('meta')].find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
    const it = items.find(i => i.getAttribute('id') === metaCover) || items.find(i => /cover-image/.test(i.getAttribute('properties') || '')) || items.find(i => /image/.test(i.getAttribute('media-type') || '') && /cover/i.test(i.getAttribute('href') || ''));
    let cover = null;
    if (it) { const raw = await read(decodeURIComponent(base + it.getAttribute('href')).replace(/[^/]+\/\.\.\//g, '')); if (raw) { const bmp = await createImageBitmap(new Blob([raw])); const h = 420, w = Math.round(bmp.width / bmp.height * h); const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0, w, h); cover = c.toDataURL('image/jpeg', .8); } }
    return { title, author, cover, about };
  } catch (e) { console.warn('epub', e); return {}; }
}
/** Phone (or any device): the book goes to your private cloud storage; Fof Music on your Mac picks it up and narrates it. */
function sendBook(f) {
  if (!/\.(epub|pdf)$/i.test(f.name)) return toast('Pick an EPUB or PDF book');
  const name = f.name.replace(/\.(epub|pdf)$/i, '').replace(/\s*\((?:z-lib|z-library|1lib)[^)]*\)\s*$/i, '').trim();
  sheet(`<h2>Which voice should read it?</h2><p class="muted">${esc(name)}</p><div class="voice-pick"><button class="btn primary" data-v="american">Deep American voice</button><button class="btn" data-v="british">Deep British voice</button></div><div class="actions"><button class="btn ghost" data-close>Cancel</button></div>`, el => {
    el.querySelectorAll('[data-v]').forEach(b => b.onclick = async () => {
      closeSheet(); toast('Adding your book…'); narrator.load().catch(() => {});
      const id = 'bk' + Date.now().toString(36), ext = f.name.split('.').pop().toLowerCase(), path = `books/${id}.${ext}`;
      try {
        const store = await cloud.uploadFile(path, new Blob([f], { type: ext === 'pdf' ? 'application/pdf' : 'application/epub+zip' }));
        const info = /\.epub$/i.test(f.name) ? await epubInfo(f) : {};
        S.bookQueue = [{ id, name: info.title ? `${info.title}${info.author ? ` (${info.author})` : ''}` : name, file: f.name, path, r2: store === 'r2', voice: b.dataset.v, cover: info.cover || null, about: info.about || '', status: 'waiting', added: Date.now(), at: Date.now() }, ...(S.bookQueue || [])];
        kv.set('bookQueue', S.bookQueue); queueStatePush(); render();
        toast('Added. Tap it to start listening.');
      } catch (e) { toast('Couldn’t send the book. Try again in a moment.'); console.warn(e); }
    });
  });
}
function bookQueueHtml() {
  const q = (S.bookQueue || []).filter(b => b.status !== 'done'); if (!q.length) return '';
  return `<section class="section"><div class="section-head"><h2>Being narrated</h2></div><div class="book-queue">${q.map(b => `<div class="bq"><span class="bq-ic">${icon('book')}</span><span class="bq-main"><b class="ellipsis">${esc(b.name)}</b><span class="muted ellipsis">${esc(b.status === 'waiting' ? 'Waiting for your Mac' : b.status === 'failed' ? 'Your Mac couldn’t narrate this one' : b.line || 'Narrating on your Mac…')} · ${b.voice === 'british' ? 'British voice' : 'American voice'}</span></span></div>`).join('')}</div></section>`;
}
/** On the Mac: pick up books sent from other devices and hand them to the narrator. */
const DESK_BOOKS = !!window.fofDesktop?.saveBook;
let taking = false;
async function takeBooks() {
  if (!DESK_BOOKS || taking || !S.user) return; taking = true;
  try {
    for (const b of (S.bookQueue || []).filter(x => x.status === 'waiting')) {
      const url = await cloud.fileUrl(b.path, b.r2); if (!url) continue;
      const r = await fetch(url); if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      if ((!b.cover || b.about === undefined) && /\.epub$/i.test(b.file || '')) { const i2 = await epubInfo(new Blob([buf])); b.cover = b.cover || i2.cover || null; b.about = i2.about || ''; }
      await window.fofDesktop.saveBook(b.file || b.name + '.epub', b.voice, new Uint8Array(buf));
      Object.assign(b, { status: 'narrating', line: 'Starting on your Mac…', at: Date.now() });
      kv.set('bookQueue', S.bookQueue); queueStatePush();
    }
  } catch (e) { console.warn('books', e); } finally { taking = false; }
}
if (DESK_BOOKS) {
  setInterval(takeBooks, 2 * 60 * 1000); setTimeout(takeBooks, 20000);
  window.fofDesktop.onNarrator?.(st => {
    const b = (S.bookQueue || []).find(x => x.status === 'narrating' && st.file && (x.file || '') === st.file); if (!b) return;
    const line = st.event === 'done' ? '' : st.line || '';
    if (st.event === 'done') Object.assign(b, { status: 'done', at: Date.now() });
    else if (st.event === 'failed') Object.assign(b, { status: 'failed', at: Date.now() });
    else if (line && line !== b.line && Date.now() - (b.at || 0) > 60000) Object.assign(b, { line, at: Date.now() }); else return;
    kv.set('bookQueue', S.bookQueue); queueStatePush(); if (S.route === 'books') render();
  });
}
/* ---------- Reader: Read along (sentence lights up as it's spoken) and Page (paper, like Apple Books) ---------- */
const RD = { id: null, mode: 'along', idx: -1, page: 0, v: null };
const rdT = id => RD.v?.map.get(id) || T(id);
const rdList = t => RD.v?.map.has(t?.id) ? RD.v.list : bookChapters(bookKey(t));
const rdPrefs = () => ({ mode: 'along', theme: 'paper', size: 19, ...(S.settings.reader || {}) });
function rdSave(p) { S.settings.reader = { ...rdPrefs(), ...p }; saveSettings(); }
const rdText = t => t?.read?.s || null;
function rdIndexAt(t, sec) { const s = rdText(t); if (!s) return -1; const ms = sec * 1000 + 120; let lo = 0, hi = s.length - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m][0] <= ms) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
/** Opens the reader on a chapter: the one playing, else where you left off in that book. */
function vSave(t, i) {
  const [bid, ch] = t.id.split(':'); const k = 'v:' + bid, old = S.pod.prog[k];
  if (old && old.ch === +ch && Math.abs((old.i || 0) - i) < 3 && Date.now() - old.at < 15000) return;
  S.pod.prog[k] = { ch: +ch, i, title: t.title, n: RD.v.list.length, at: Date.now() }; podSave();
}
/** Read a book that hasn't been narrated yet, straight from its EPUB. */
async function epubChapters(buf) {
  const bytes = new Uint8Array(buf), view = new DataView(bytes.buffer), dec = new TextDecoder();
  let end = bytes.length - 22; while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  const files = new Map(); let pos = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) { const nl = view.getUint16(pos + 28, true); files.set(dec.decode(bytes.subarray(pos + 46, pos + 46 + nl)), { m: view.getUint16(pos + 10, true), size: view.getUint32(pos + 20, true), off: view.getUint32(pos + 42, true) }); pos += 46 + nl + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true); }
  const read = async name => { const f = files.get(name); if (!f) return null; const st = f.off + 30 + view.getUint16(f.off + 26, true) + view.getUint16(f.off + 28, true); const d = bytes.subarray(st, st + f.size); return dec.decode(f.m === 8 ? new Uint8Array(await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : d); };
  const norm = p => { const out = []; for (const x of p.split('/')) { if (x === '..') out.pop(); else if (x && x !== '.') out.push(x); } return out.join('/'); };
  const opfPath = new DOMParser().parseFromString(await read('META-INF/container.xml'), 'application/xml').querySelector('rootfile').getAttribute('full-path');
  const opf = new DOMParser().parseFromString(await read(opfPath), 'application/xml'), base = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';
  const items = new Map([...opf.getElementsByTagName('item')].map(i => [i.getAttribute('id'), i.getAttribute('href')]));
  const tocT = new Map();
  try {
    const ncxHref = [...opf.getElementsByTagName('item')].find(i => /dtbncx/.test(i.getAttribute('media-type') || ''))?.getAttribute('href');
    if (ncxHref) { const nx = new DOMParser().parseFromString(await read(norm(base + ncxHref)), 'application/xml'), nb = norm(base + ncxHref).replace(/[^/]+$/, '');
      for (const np of nx.querySelectorAll('navMap > navPoint')) { const src = np.querySelector('content')?.getAttribute('src')?.split('#')[0]; const tt = np.querySelector('navLabel text')?.textContent.trim(); if (src && tt && !tocT.has(norm(nb + decodeURIComponent(src)))) tocT.set(norm(nb + decodeURIComponent(src)), tt); } }
  } catch {}
  const skip = /^(international acclaim|contents|table of contents|copyright|about the (author|publisher)|also by|dedication|acknowledg|praise|a preview|index|notes|bibliography|selected bibliography)/i;
  const groups = [];
  for (const ref of opf.getElementsByTagName('itemref')) {
    const href = items.get(ref.getAttribute('idref')); if (!href) continue;
    const path = norm(base + decodeURIComponent(href)), html = await read(path); if (!html) continue;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const paras = [...doc.body.querySelectorAll('p,h1,h2,h3,h4,li,blockquote,div')].filter(e => !e.querySelector('p,li,div,h1,h2,h3,h4,blockquote')).map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const head = tocT.get(path) || (tocT.size ? null : doc.querySelector('h1,h2,h3')?.textContent.replace(/\s+/g, ' ').trim() || '');
    if (head !== null || !groups.length) groups.push({ head: head || '', paras: [] });
    groups[groups.length - 1].paras.push(...paras);
  }
  const out = [], bookTitle = (opf.getElementsByTagName('dc:title')[0]?.textContent || '').trim().toLowerCase();
  for (let { head, paras } of groups) {
    const bt2 = bookTitle.replace(/^the /, ''); paras = paras.filter(p => { const l = p.toLowerCase(); return l !== bookTitle && l !== bt2 && l !== head.toLowerCase(); });
    // some books put each printed line in its own paragraph; put sentences back together
    paras = paras.reduce((o, p) => { const pr = o[o.length - 1]; if (pr && !(p === p.toUpperCase() || pr === pr.toUpperCase()) && !/[.!?:;"”’)\]]$/.test(pr) && (/^[a-z]/.test(p) || pr.split(' ').length <= 12)) o[o.length - 1] = pr + ' ' + p; else o.push(p); return o; }, []);
    while (paras[0] && paras[0].split(' ').length <= 8 && head.toLowerCase().includes(paras[0].toLowerCase().replace(/[.:]$/, ''))) paras.shift();
    if (paras.join(' ').split(' ').length < 60 || skip.test(head)) continue;
    if (/^(law|chapter|part|rule) \d+$/i.test(head) && paras[0] && paras[0].split(' ').length <= 14 && !/[.!?]$/.test(paras[0])) { let name = paras.shift(); while (paras[0] && paras[0].split(' ').length <= 8 && !/[.!?]$/.test(paras[0]) && name.split(' ').length < 18 && !/^(judgment|transgression|observance|interpretation|keys to power|reversal|image|authority)/i.test(paras[0])) name += ' ' + paras.shift(); head = `${head}: ${name}`; }
    const s = []; for (const p of paras) { if (p === head) continue; const sents = p.split(/(?<=[.!?…”"])\s+(?=[A-Z“"‘(])/); sents.forEach((x, k) => s.push([0, x, k === sents.length - 1 ? 1 : 0])); }
    const tc = x => x.toLowerCase().replace(/(^|[\s(“"-])(\w)/g, (m, a, c) => a + c.toUpperCase()).replace(/\b(Of|The|A|An|And|In|On|To|For|Or|With|At|By)\b/g, (w, _, i, str) => i && str[i - 2] !== ':' ? w.toLowerCase() : w);
    out.push({ title: head.length > 2 && head.length < 120 ? (/[a-z]/.test(head.replace(/^(law|chapter|part)/i, '').split(':')[1] || head) && head !== head.toUpperCase() ? (head.includes(':') ? head.split(':')[0].replace(/^LAW/, 'Law') + ': ' + tc(head.split(':').slice(1).join(':').trim()) : head) : tc(head)) : `Part ${out.length + 1}`, read: { v: 1, s } });
  }
  return out;
}
/* Device voice for books still waiting to be narrated: reads sentence by sentence and lights each one up. */
const TTS = { on: false, n: 0 };
function ttsVoice() {
  const vs = speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang));
  const pref = [/Evan.*(Enhanced|Premium)/i, /Nathan.*(Enhanced|Premium)/i, /Aaron/i, /Reed.*(Enhanced|Premium)/i, /Tom.*(Enhanced|Premium)/i, /(Enhanced|Premium)/i, /Daniel/i, /Alex/i, /Google UK English Male/i, /Google US English/i];
  for (const r of pref) { const v = vs.find(x => r.test(x.name)); if (v) return v; }
  return vs[0] || null;
}
function ttsStop() { TTS.on = false; TTS.n++; ttsHalt(); if (RD.id) rdControls(); }
let AC = null;
// the "director": say names, numbers and pauses the way a narrator would
const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' '), TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const numW = n => n < 20 ? ONES[n] : n < 100 ? TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '') : n < 1000 ? ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numW(n % 100) : '') : String(n);
const yearW = n => n >= 2000 && n <= 2009 ? 'two thousand' + (n % 10 ? ' ' + ONES[n % 10] : '') : numW(Math.floor(n / 100)) + ' ' + (n % 100 === 0 ? 'hundred' : n % 100 < 10 ? 'oh ' + ONES[n % 100] : numW(n % 100));
const ROM = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVII: 17, XVIII: 18 };
const ORDW = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth'];
const RULERS = /^(Louis|Henry|Charles|Elizabeth|George|Edward|William|Richard|James|Philip|Frederick|Napoleon|Pope|Peter|Ivan|Alexander|Leo|Pius|Gregory|John|Mary|Catherine|Ferdinand|Francis)$/;
const sayText = x => x
  .replace(/\b([A-Z][a-z]+) ([IVX]{1,5})\b/g, (m, a, r) => RULERS.test(a) && ROM[r] ? `${a} the ${ORDW[ROM[r]]}` : m)
  .replace(/\b(Law|Chapter|Part|Book|Rule|Lesson|Step) (\d{1,3})\b/g, (m, a, n) => `${a} ${numW(+n).replace(/^./, c => c.toUpperCase())}`)
  .replace(/\b(1[1-9]\d\d|20\d\d)s\b/g, (m, y) => yearW(+y).replace(/y$/, 'ie') + 's')
  .replace(/\b(in|of|by|since|until|from|to|year|around) (1[1-9]\d\d|20\d\d)\b/g, (m, a, y) => `${a} ${yearW(+y)}`)
  .replace(/\bMr\./g, 'Mister').replace(/\bMrs\./g, 'Missus').replace(/\bDr\./g, 'Doctor').replace(/\be\.g\./g, 'for example').replace(/\bi\.e\./g, 'that is').replace(/&/g, ' and ').replace(/%/g, ' percent')
  .replace(/\s*[—–]\s*/g, ', ').replace(/\b([Ff])\*ck/g, '$1uck').replace(/\b([Ss])h\*t/g, '$1hit').replace(/[*_#[\]]/g, '');
/** Plays the chapter from sentence i in the voice you picked for this book, a sentence or two ahead so there are no gaps. */
async function ttsFrom(i) {
  const t = rdT(RD.id), s = rdText(t); if (!s) return;
  ttsHalt(); const my = ++TTS.n; TTS.on = true; RD.userScrolled = 0;
  try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); await AC.resume(); } catch {}
  rdControls();
  const voice = RD.v?.voice || 'american';
  if (!narrator.ready()) {
    $('#rd-left').textContent = `Getting the ${voice === 'british' ? 'British' : 'American'} voice ready…`;
    try { await narrator.load(f => { if (my === TTS.n) $('#rd-left').textContent = `Getting the ${voice === 'british' ? 'British' : 'American'} voice ready · ${Math.round(f * 100)}%`; }); }
    catch (e) { console.warn('voice', e); if (my === TTS.n) { toast('Couldn’t load the narrator voice. Check your connection and try again.'); ttsStop(); } return; }
    if (my !== TTS.n) return; rdControls();
  }
  // groups of whole sentences (one paragraph at most, ~320 characters) give the voice context, so it reads fluently
  const groups = []; for (let k = 0; k < s.length;) { const g = [k]; let len = s[k][1].length; while (!s[k][2] && k + 1 < s.length && len + s[k + 1][1].length < 320) { k++; g.push(k); len += s[k][1].length; } groups.push(g); k++; }
  let gi = groups.findIndex(g => g.includes(i)); if (gi < 0) gi = 0;
  const cache = new Map(), gen = n => { if (!cache.has(n) && n < groups.length) cache.set(n, narrator.speak(sayText(groups[n].map(k => s[k][1]).join(' ')), voice).catch(() => null)); return cache.get(n); };
  const play = async n => {
    if (my !== TTS.n || !TTS.on) return;
    if (n >= groups.length) { const ch = rdList(t), x = ch.findIndex(c => c.id === t.id); if (ch[x + 1]) { RD.id = ch[x + 1].id; paintReader(); setTimeout(() => ttsFrom(0), 300); } else ttsStop(); return; }
    const g = groups[n]; rdFollow(0, false, g[0]);
    const a = await gen(n); for (let q = 1; q <= 3; q++) gen(n + q);
    if (my !== TTS.n || !TTS.on) return;
    if (!a) return play(n + 1);
    const rate = S.settings.bookSpeed || 1, buf = AC.createBuffer(1, a.samples.length, a.rate); buf.copyToChannel(a.samples, 0);
    const src = AC.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate; src.connect(AC.destination);
    TTS.src = src;
    // move the highlight through the group by each sentence's share of the text
    const total = g.reduce((x, k) => x + s[k][1].length, 0), dur = buf.duration / rate; let acc = 0;
    g.slice(1).forEach((k, m) => { acc += s[g[m]][1].length; setTimeout(() => { if (TTS.src === src) rdFollow(0, false, k); }, acc / total * dur * 1000); });
    src.onended = () => { if (TTS.src === src) setTimeout(() => play(n + 1), (s[g[g.length - 1]][2] ? 380 : 120) / rate); };
    src.start();
  };
  play(gi);
}
function ttsHalt() { try { TTS.src?.stop(); } catch {} TTS.src = null; try { speechSynthesis.cancel(); } catch {} }
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};
/** Books added before covers were read from the file: fetch the cover once from the book itself. */
const coverTried = new Set();
async function fillCovers() {
  if (!S.user) return;
  for (const b of (S.bookQueue || []).filter(x => !x.cover && x.status !== 'done' && /\.epub$/i.test(x.file || '') && !coverTried.has(x.id))) {
    coverTried.add(b.id);
    try { const url = await cloud.fileUrl(b.path, b.r2); if (!url) continue; const info = await epubInfo(new Blob([await (await fetch(url)).arrayBuffer()])); if (info.cover) { b.cover = info.cover; b.at = Date.now(); kv.set('bookQueue', S.bookQueue); queueStatePush(); if (S.route === 'books') render(); } } catch (e) { console.warn('cover', e); }
  }
}
async function readQueued(id, buf, play = false) {
  const b = (S.bookQueue || []).find(x => x.id === id); if (!b) return;
  if (!/\.epub$/i.test(b.file || '')) return toast('Reading before narration works for EPUB books');
  toast('Opening the book…');
  try {
    if (!buf) { const url = await cloud.fileUrl(b.path, b.r2); if (!url) throw Error('no link'); buf = await (await fetch(url)).arrayBuffer(); }
    const chs = await epubChapters(buf);
    if (!chs.length) return toast('Couldn’t find the text in this book');
    const title = b.name.replace(/\s*\(.*$/, ''), list = chs.map((c, i) => ({ id: `${b.id}:${i}`, title: c.title, album: title, artist: '', read: c.read, art: b.cover }));
    RD.v = { map: new Map(list.map(c => [c.id, c])), list, voice: b.voice || 'american' };
    const sp = S.pod.prog['v:' + b.id], start = sp && list[sp.ch] ? sp.ch : 0, at = sp && list[sp.ch] ? sp.i || 0 : 0;
    openReader(list[start].id);
    if (at) setTimeout(() => rdFollow(0, true, at), 350);
    if (play) setTimeout(() => ttsFrom(at), 400);
    return true;
  } catch (e) { console.warn(e); toast('Couldn’t open the book right now. Try again in a moment.'); }
}
function openReader(id) {
  const t = rdT(id); if (!t) return;
  const p = rdPrefs(); RD.id = id; RD.mode = RD.v?.map.has(id) ? 'page' : p.mode; RD.idx = -1; RD.page = -1;
  const el = $('#reader'); el.hidden = false; requestAnimationFrame(() => el.classList.add('open'));
  document.body.classList.add('reading');
  history.pushState({ reader: true }, '');
  paintReader();
}
function closeReader() { const el = $('#reader'); if (el.hidden) return; ttsStop(); RD.v = null; el.classList.remove('open'); document.body.classList.remove('reading'); setTimeout(() => { el.hidden = true; $('#rd-body').innerHTML = ''; }, 320); RD.id = null; }
window.addEventListener('popstate', () => { if (RD.id) closeReader(); });
function rdSpot(t) { // where to start reading: the playing position, else your saved place in this chapter
  if (RD.v?.map.has(t.id)) return 0;
  if (current()?.id === t.id) return engine.el.currentTime || 0;
  const p = S.pod.prog[t.id]; return p && !p.done ? p.t : 0;
}
function paintReader() {
  const t = rdT(RD.id); if (!t) return;
  const p = rdPrefs(), el = $('#reader'), s = rdText(t), ch = rdList(t), n = ch.findIndex(c => c.id === t.id);
  el.classList.toggle('rd-textonly', !!RD.v?.map.has(t.id)); el.dataset.mode = RD.mode; el.dataset.theme = p.theme; el.style.setProperty('--rd-size', p.size + 'px');
  el.style.cssText += ';' + ambient(t.colors || colorsOf(ch));
  $('#rd-book').textContent = t.album || ''; $('#rd-ch').textContent = t.title;
  $$('#reader .seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === RD.mode));
  const body = $('#rd-body');
  if (!s) { body.innerHTML = `<div class="rd-none"><h2>The text isn’t in this chapter</h2><p>Books narrated from now on include the text, so you can read along. Narrate this book again to add it.</p></div>`; rdControls(); return; }
  let html = '', para = [];
  const flush = (sub) => { if (para.length) html += `<p class="rd-p${sub ? ' rd-sub' : ''}">${para.join(' ')}</p>`; para = []; };
  s.forEach(([ms, txt, end], i) => { if (end && !para.length && txt.length < 60 && txt === txt.toUpperCase() && /[A-Z]/.test(txt)) { para.push(`<span class="rd-s" data-i="${i}" data-ms="${ms}">${esc(txt)}</span>`); return flush(true); } para.push(`<span class="rd-s" data-i="${i}" data-ms="${ms}">${esc(txt)}</span>`); if (end) flush(); });
  flush();
  const nextCh = ch[n + 1];
  body.innerHTML = `<div class="rd-flow"><div class="rd-head"><div class="rd-eyebrow">${esc(t.album || '')}</div><h1>${esc(t.title)}</h1></div>${html}
    <div class="rd-end">${nextCh ? `<button class="rd-next" data-action="rd-open" data-id="${esc(nextCh.id)}"><span>Next</span><b>${esc(nextCh.title)}</b></button>` : `<div class="rd-fin">The end</div>`}</div></div>`;
  RD.idx = -1; RD.page = -1;
  if (RD.v?.map.has(t.id) && S.pod.prog['v:' + t.id.split(':')[0]]?.ch !== +t.id.split(':')[1]) vSave(t, 0);
  if (RD.mode === 'page') rdPaginate();
  rdFollow(rdSpot(t), true);
  rdControls();
}
function rdPaginate() {
  const body = $('#rd-body'), flow = body.querySelector('.rd-flow'); if (!flow) return;
  body.style.setProperty('--pw', body.clientWidth + 'px');
  requestAnimationFrame(() => { RD.pages = Math.max(1, Math.round(flow.scrollWidth / body.clientWidth)); rdPageLabel(); });
}
function rdPageLabel() { const b = $('#rd-body'); const i = Math.round(b.scrollLeft / Math.max(1, b.clientWidth)); RD.page = i;
  if (RD.v?.map.has(RD.id) && !TTS.on) { clearTimeout(rdPageLabel.t); rdPageLabel.t = setTimeout(() => { const br = b.getBoundingClientRect(); const first = [...b.querySelectorAll('.rd-s')].find(x => { const r = x.getClientRects()[0]; return r && r.left >= br.left - 2 && r.left < br.right; }); if (first) vSave(rdT(RD.id), +first.dataset.i); }, 600); } $('#rd-pos').textContent = RD.mode === 'page' ? `${i + 1} of ${RD.pages || 1}` : ''; }
function rdTurn(dir) { const b = $('#rd-body'); RD.userScrolled = Date.now(); const to = Math.max(0, Math.min((RD.pages || 1) - 1, Math.round(b.scrollLeft / b.clientWidth) + dir)); b.scrollTo({ left: to * b.clientWidth, behavior: 'smooth' }); }
/** Lights up the sentence being spoken and keeps it in view (or turns to its page). */
function rdFollow(sec, jump = false, at = null) {
  const t = rdT(RD.id); if (!t || !rdText(t) || (RD.v?.map.has(t.id) && at === null)) return;
  const i = at !== null ? at : rdIndexAt(t, sec); if (i === RD.idx && !jump) return;
  const body = $('#rd-body'), old = body.querySelector('.rd-s.cur'); if (old) old.classList.remove('cur');
  body.querySelectorAll('.rd-s.past').forEach(x => { if (+x.dataset.i >= i) x.classList.remove('past'); });
  const cur = body.querySelector(`.rd-s[data-i="${i}"]`); if (!cur) return;
  for (let k = Math.max(0, RD.idx < 0 || RD.idx > i ? 0 : RD.idx); k < i; k++) body.querySelector(`.rd-s[data-i="${k}"]`)?.classList.add('past');
  cur.classList.add('cur'); RD.idx = i;
  if (RD.v?.map.has(t.id)) vSave(t, i);
  if (RD.userScrolled && Date.now() - RD.userScrolled < 4000 && !jump) return;
  const place = () => { const cr = cur.getClientRects()[0] || cur.getBoundingClientRect(), br = body.getBoundingClientRect();
  if (RD.mode === 'page') { const pg = Math.floor((cr.left - br.left + body.scrollLeft + 2) / body.clientWidth); if (pg !== RD.page) { body.scrollTo({ left: pg * body.clientWidth, behavior: jump ? 'instant' : 'smooth' }); RD.page = pg; } }
  else body.scrollTo({ top: cur.parentElement.offsetTop + (cr.top - cur.parentElement.getBoundingClientRect().top) - body.clientHeight * .36, behavior: jump ? 'instant' : 'smooth' }); };
  place(); if (jump) { requestAnimationFrame(place); setTimeout(place, 450); }
}
function rdControls() {
  const t = rdT(RD.id); if (!t) return;
  if (RD.v?.map.has(t.id)) { $('#rd-play use').setAttribute('href', TTS.on ? '#i-pause' : '#i-play'); $('#rd-speed').textContent = (S.settings.bookSpeed || 1) + '×'; if (!TTS.on) $('#rd-left').textContent = 'Tap play or any sentence'; $('#rd-voice').textContent = RD.v.voice === 'british' ? 'British' : 'American'; return; }
  const playing = current()?.id === t.id && !engine.el.paused;
  $('#rd-play use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#rd-speed').textContent = (isBook(current()) ? P.speed || 1 : rdPrefs().speed || S.settings.bookSpeed || 1) + '×';
  const d = (current()?.id === t.id ? engine.el.duration : 0) || t.duration || 0, c = current()?.id === t.id ? engine.el.currentTime : rdSpot(t);
  $('#rd-bar i').style.width = d ? Math.min(100, c / d * 100) + '%' : '0';
  $('#rd-left').textContent = d ? `${leftTxt(d - c)} left in chapter` : '';
}
/** Play from a sentence (or from where you are). */
async function rdPlayAt(i) {
  const t = rdT(RD.id); if (!t) return;
  const at = i >= 0 && rdText(t) ? rdText(t)[i][0] / 1000 : null;
  if (current()?.id !== t.id) {
    const key = bookKey(t), ch = bookChapters(key);
    if (at !== null) { S.pod.prog[t.id] = { t: Math.max(0, at - .2), d: t.duration || 0, done: false, at: Date.now() }; }
    await playList(ch.map(x => x.id), ch.findIndex(x => x.id === t.id), { context: t.album || 'Audiobook', ctxRoute: 'book/' + encodeURIComponent(key) });
  } else {
    if (at !== null) { engine.el.currentTime = Math.max(0, at - .2); if (engine.el.paused) engine.el.play(); }
    else toggle();
  }
  RD.userScrolled = 0; setTimeout(rdControls, 150);
}
// keep the reader in step with playback
setInterval(() => {
  if (!RD.id || $('#reader').hidden) return;
  const c = current();
  if (c && isBook(c) && c.id !== RD.id && bookKey(c) === bookKey(rdT(RD.id) || {}) && !engine.el.paused) { RD.id = c.id; paintReader(); return; }
  if (c?.id === RD.id && !engine.el.paused) rdFollow(engine.el.currentTime);
  rdControls();
}, 250);
function bindReader() {
  const r = $('#reader'), body = $('#rd-body');
  r.addEventListener('click', e => {
    const a = e.target.closest('[data-rd]'); if (a) { e.stopPropagation(); const k = a.dataset.rd;
      if (k === 'close') { history.back(); return; }
      if (k === 'mode') { RD.mode = a.dataset.mode; rdSave({ mode: RD.mode }); paintReader(); return; }
      if (k === 'play') { if (RD.v?.map.has(RD.id)) return TTS.on ? ttsStop() : ttsFrom(Math.max(0, RD.idx)); return rdPlayAt(current()?.id === RD.id ? -1 : RD.idx); }
      if (k === 'back') { if (current()?.id === RD.id) engine.el.currentTime = Math.max(0, engine.el.currentTime - 15); return; }
      if (k === 'fwd') { if (current()?.id === RD.id) engine.el.currentTime += 30; return; }
      if (k === 'speed' && RD.v?.map.has(RD.id)) { S.settings.bookSpeed = SPEEDS[(SPEEDS.indexOf(S.settings.bookSpeed || 1) + 1) % SPEEDS.length]; saveSettings(); if (TTS.on) ttsFrom(RD.idx); rdControls(); return; }
      if (k === 'speed') { if (isBook(current())) cycleSpeed(); else { const v = SPEEDS[(SPEEDS.indexOf(S.settings.bookSpeed || 1) + 1) % SPEEDS.length]; S.settings.bookSpeed = v; saveSettings(); } rdControls(); return; }
      if (k === 'chapters') return rdChapters();
      if (k === 'voice') return rdVoice();
      if (k === 'aa') return rdLook();
      return;
    }
    const sp = e.target.closest('.rd-s');
    if (RD.swiped && Date.now() - RD.swiped < 400) return;
    if (RD.mode === 'page') { // tap the edges to turn, like a book
      const x = e.clientX / window.innerWidth;
      if (x < .22) return rdTurn(-1); if (x > .78) return rdTurn(1);
    }
    if (sp && RD.v?.map.has(RD.id)) { haptic(); ttsFrom(+sp.dataset.i); }
    else if (sp) { haptic(); rdPlayAt(+sp.dataset.i); }
  });
  const mark = () => { RD.userScrolled = Date.now(); };
  body.addEventListener('touchstart', mark, { passive: true }); body.addEventListener('wheel', mark, { passive: true });
  body.addEventListener('scroll', () => { if (RD.mode === 'page') rdPageLabel(); }, { passive: true });
  let sx = null, sy = 0;
  body.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  body.addEventListener('touchend', e => { if (sx === null || RD.mode !== 'page') return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null; if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { RD.swiped = Date.now(); rdTurn(dx < 0 ? 1 : -1); } }, { passive: true });
  window.addEventListener('resize', () => { if (RD.id && RD.mode === 'page') { rdPaginate(); rdFollow(rdSpot(rdT(RD.id)), true); } });
  document.addEventListener('keydown', e => { if (!RD.id || $('#reader').hidden) return; if (e.key === 'Escape') history.back(); if (RD.mode === 'page' && e.key === 'ArrowRight') rdTurn(1); if (RD.mode === 'page' && e.key === 'ArrowLeft') rdTurn(-1); if (e.key === ' ') { e.preventDefault(); rdPlayAt(-1); } });
}
/** "Chapter 3 of 12 · 4 hr 10 min left in book" under the player's progress bar. */
function bookTime(t, c) {
  const el = $('#now-booktime'); if (!el) return;
  const key = bookKey(t), ch = bookChapters(key), n = ch.findIndex(x => x.id === t.id), rate = P.speed || 1;
  const left = bookStats(key).left / rate; // same number the book page shows (at 1×)
  const q = narratingFor(t.album), total = ofTotal(q?.line) || ch.length;
  el.textContent = `Chapter ${n + 1} of ${total} · ${leftTxt(left)} left${q ? ' so far' : ' in book'}${rate !== 1 ? ` at ${rate}×` : ''}`;
}
/** Bookmarks: save the spot you're at (in any book), see them on the book page, tap to jump back. */
function addBookmark() {
  const t = current(); if (!isBook(t)) return;
  const at = Math.round(engine.el.currentTime || 0), s = rdText(t), i = s ? rdIndexAt(t, at) : -1;
  S.bookmarks = [{ id: t.id, t: at, quote: i >= 0 ? s[i][1].slice(0, 160) : '', at: Date.now() }, ...(S.bookmarks || [])].slice(0, 500);
  kv.set('bookmarks', S.bookmarks); queueStatePush(); haptic(); toast('Bookmarked');
}
function bookmarksHtml(key) {
  const ch = bookChapters(key), ids = new Set(ch.map(c => c.id)), list = (S.bookmarks || []).filter(b => ids.has(b.id));
  if (!list.length) return '';
  return `<section class="section"><div class="section-head"><h2>Bookmarks</h2></div><div class="bk-marks">${list.map(b => { const c = T(b.id); return `<button class="bk-mark" data-action="bookmark-go" data-id="${esc(b.id)}" data-t="${b.t}"><span class="bm-ic">${icon('mark')}</span><span class="bm-main"><b>${esc(c?.title || '')} · ${fmt(b.t)}</b>${b.quote ? `<em>“${esc(b.quote)}”</em>` : ''}</span></button>`; }).join('')}</div></section>`;
}
async function goBookmark(id, at) {
  const t = T(id); if (!t) return; const ch = bookChapters(bookKey(t));
  S.pod.prog[id] = { t: at, d: t.duration || 0, done: false, at: Date.now() };
  if (current()?.id === id) { engine.el.currentTime = at; if (engine.el.paused) engine.el.play(); return; }
  await playList(ch.map(x => x.id), ch.findIndex(x => x.id === id), { context: t.album || 'Audiobook', ctxRoute: 'book/' + encodeURIComponent(bookKey(t)) });
}
/** Switch narrator for a book that's playing in the app's own voice. */
function rdVoice() {
  if (!RD.v) return toast('This book was narrated on your Mac in its voice');
  const b = (S.bookQueue || []).find(x => x.id === RD.v.list[0].id.split(':')[0]), cur = RD.v.voice || 'american';
  sheet(`<h2>Narrator</h2><div class="voice-pick">${[['american', 'Deep American voice'], ['british', 'Deep British voice']].map(([k, l]) => `<button class="btn ${k === cur ? 'primary' : ''}" data-v="${k}">${k === cur ? icon('check') : ''}${l}</button>`).join('')}</div>${b && b.status === 'narrating' ? '<p class="muted" style="font-size:13px;margin:10px 0 0">Your Mac already started narrating this book, so its saved chapters keep the first voice. Playback here switches right away.</p>' : ''}`, el => {
    el.querySelectorAll('[data-v]').forEach(x => x.onclick = () => {
      closeSheet(); const v = x.dataset.v; RD.v.voice = v;
      if (b) { b.voice = v; b.at = Date.now(); kv.set('bookQueue', S.bookQueue); queueStatePush(); }
      rdControls(); if (TTS.on) ttsFrom(Math.max(0, RD.idx));
      toast(v === 'british' ? 'Deep British voice' : 'Deep American voice');
    });
  });
}
function rdChapters() {
  const t = rdT(RD.id), ch = rdList(t);
  sheet(`<h2>${esc(t.album || 'Chapters')}</h2><div class="rd-chlist">${ch.map((c, i) => `<button class="rd-chrow${c.id === RD.id ? ' on' : ''}" data-id="${esc(c.id)}"><span class="ch-n">${i + 1}</span><span class="ellipsis">${esc(c.title)}</span><span class="ch-time">${c.duration ? leftTxt(c.duration) : ''}</span></button>`).join('')}</div>`, el => {
    el.querySelectorAll('.rd-chrow').forEach(b => b.onclick = () => { closeSheet(); RD.id = b.dataset.id; paintReader(); });
    el.querySelector('.rd-chrow.on')?.scrollIntoView({ block: 'center' });
  });
}
function rdLook() {
  const p = rdPrefs();
  sheet(`<h2>Text</h2><div class="rd-look">
    <div class="rd-sizes"><button data-sz="-1" aria-label="Smaller text">A</button><button data-sz="1" aria-label="Larger text">A</button></div>
    <div class="rd-themes">${[['paper', 'Paper'], ['sepia', 'Sepia'], ['gray', 'Gray'], ['night', 'Night']].map(([k, l]) => `<button class="rd-th th-${k}${p.theme === k ? ' on' : ''}" data-th="${k}"><span>Aa</span><em>${l}</em></button>`).join('')}</div>
    <p class="muted rd-look-note">Themes change Page mode. Read along always uses the book’s colors.</p></div>`, el => {
    el.querySelectorAll('[data-sz]').forEach(b => b.onclick = () => { const sz = Math.max(15, Math.min(30, rdPrefs().size + +b.dataset.sz)); rdSave({ size: sz }); $('#reader').style.setProperty('--rd-size', sz + 'px'); if (RD.mode === 'page') { rdPaginate(); rdFollow(rdSpot(rdT(RD.id)), true); } });
    el.querySelectorAll('[data-th]').forEach(b => b.onclick = () => { rdSave({ theme: b.dataset.th }); el.querySelectorAll('[data-th]').forEach(x => x.classList.toggle('on', x === b)); $('#reader').dataset.theme = b.dataset.th; });
  });
}
const BOOK_HOW = `Tap <b>Add a book</b> and pick an EPUB or PDF, on your iPhone or your Mac. Your Mac reads it aloud chapter by chapter in the background, and the chapters show up here on all your devices. EPUB files sound best.`;
/** A book still being narrated on the Mac (matched to the queue item by its title). */
const qKey = s => fold(String(s || '').replace(/\(.*?\)/g, '').replace(/^the /i, '')).replace(/[^a-z0-9]/g, '').slice(0, 24);
function bookRecord(album) { const k = qKey(album); return (S.bookQueue || []).find(b => qKey(b.name).startsWith(k) || k.startsWith(qKey(b.name))); }
function narratingFor(album) { const k = qKey(album); return (S.bookQueue || []).find(b => b.status !== 'done' && b.status !== 'failed' && (qKey(b.name).startsWith(k) || k.startsWith(qKey(b.name)))); }
const ofTotal = line => +((/of (\d+)/.exec(line || '') || [])[1] || 0);
const readyTxt = (ch, q) => { const n = ofTotal(q?.line); return n ? `${ch.length} of ${n} chapters ready` : `${ch.length} chapter${ch.length === 1 ? '' : 's'} ready`; };
const pctOf = line => { const m = /Chapter (\d+) of (\d+)/.exec(line || ''); return m ? Math.round((+m[1] - 1) / +m[2] * 100) : 0; };
function ring(pct, color) { const c = 2 * Math.PI * 14, d = Math.max(2, c * pct / 100); return `<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="3"/><circle cx="18" cy="18" r="14" fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="${d} ${c}" transform="rotate(-90 18 18)" stroke-linecap="round"/></svg>`; }
function bookTile([key, ch]) {
  const t = ch[0], st = bookStats(key), sp = bookSpot(key), q = narratingFor(t.album), playing = ch.some(c => c.id === current()?.id) && !engine.el.paused;
  const badge = q ? `<span class="bt-badge">${ring(pctOf(q.line), '#ff9f0a')}</span>`
    : `<button class="bt-badge bt-play" data-action="book-play" data-book="${esc(key)}" aria-label="${playing ? 'Pause' : 'Listen'}">${sp?.started && !sp.finished ? ring(st.pct, '#fff') : ''}${icon(playing ? 'pause' : 'play')}</button>`;
  const sub = q ? `Preparing · ${readyTxt(ch, q)}` : sp?.finished ? 'Finished' : sp?.started ? `${Math.round(st.pct)}% · ${leftTxt(st.left)} left` : `${t.artist} · ${leftTxt(st.total)}`;
  return `<div class="bt"><div class="bt-art"><a class="bt-cover" href="#/book/${encodeURIComponent(key)}">${bookCover(t, 'big')}</a>${badge}</div>
    <a class="bt-t ellipsis" href="#/book/${encodeURIComponent(key)}">${esc(t.album || t.title)}</a><div class="bt-s ellipsis">${esc(sub)}</div></div>`;
}
function queueTile(b) {
  return `<div class="bt"><div class="bt-art"><div class="bt-cover" data-action="read-queued" data-id="${esc(b.id)}" role="button">${b.cover ? `<div class="book-cover big"><img src="${b.cover}" alt=""></div>` : `<div class="book-cover big bt-blank"><span>${esc(b.name.replace(/\s*\(.*$/, ''))}</span></div>`}</div>${/\.epub$/i.test(b.file || '') ? `<button class="bt-badge bt-play" data-action="listen-queued" data-id="${esc(b.id)}" aria-label="Listen">${b.status === 'narrating' ? ring(pctOf(b.line), '#ff9f0a') : ''}${icon('play')}</button>` : `<span class="bt-badge">${ring(pctOf(b.line), '#ff9f0a')}</span>`}</div>
    <div class="bt-t ellipsis">${esc(b.name.replace(/\s*\(.*$/, ''))}</div><div class="bt-s ellipsis">${b.voice === 'british' ? 'British voice' : 'American voice'} · ${S.pod.prog['v:' + b.id] ? `${Math.round((S.pod.prog['v:' + b.id].ch / (S.pod.prog['v:' + b.id].n || 1)) * 100)}% · Continue` : 'Ready to play'}</div></div>`;
}
VIEWS.books = () => {
  setTimeout(fillCovers, 300);
  const all = [...books()].map(([k, ch]) => [k, ch, bookSpot(k)]);
  const pending = (S.bookQueue || []).filter(b => b.status !== 'done' && !all.some(([, ch]) => narratingFor(ch[0].album) === b));
  const add = `<button class="pill-btn bk-add" data-action="add-book">${icon('plus')}Add a book</button>`;
  if (!all.length && !pending.length) return `<div class="page-head"><h1>Audiobooks</h1></div><div class="empty-state book-empty">${icon('book')}<h2>Your own audiobooks</h2><p>${BOOK_HOW}</p><button class="btn primary" data-action="add-book">${icon('plus')}Add a book</button></div>`;
  const going = all.filter(x => x[2]?.started && !x[2].finished).sort((a, b) => b[2].at - a[2].at);
  const vGoing = pending.map(b => [b, S.pod.prog['v:' + b.id]]).filter(x => x[1]).sort((a, b) => b[1].at - a[1].at)[0];
  const pick = vGoing && (!going[0] || vGoing[1].at > going[0][2].at) ? null : going[0] || all.find(x => !narratingFor(x[1][0].album)) || all[0];
  let hero = '';
  if (!pick && vGoing) {
    const [b, sp] = vGoing, pct = sp.n ? Math.round(sp.ch / sp.n * 100) : 0;
    hero = `<div class="bk-hero-row"><a data-action="read-queued" data-id="${esc(b.id)}" role="button">${b.cover ? `<div class="book-cover big"><img src="${b.cover}" alt=""></div>` : `<div class="book-cover big bt-blank"><span>${esc(b.name.replace(/\s*\(.*$/, ''))}</span></div>`}</a><div class="bk-hero-meta">
        <div class="bk-eb">Continue listening</div><a class="bk-ht" data-action="read-queued" data-id="${esc(b.id)}" role="button">${esc(b.name.replace(/\s*\(.*$/, ''))}</a><div class="bk-ha">${esc((/\((.*)\)/.exec(b.name) || [])[1] || '')}</div>
        <div class="bk-hc ellipsis">${esc(sp.title || '')}</div><div class="bk-hp"><span class="pod-bar"><i style="width:${pct}%"></i></span>${pct}%</div></div></div>
      <div class="bk-acts"><button class="bk-btn light" data-action="listen-queued" data-id="${esc(b.id)}">${icon(TTS.on && RD.v?.list[0].id.startsWith(b.id + ':') ? 'pause' : 'play')}Continue</button><button class="bk-btn glass" data-action="read-queued" data-id="${esc(b.id)}">${icon('read')}Read</button></div>`;
  }
  if (pick) {
    const [k, ch, sp] = pick, st = bookStats(k), t = ch[sp.i] || ch[0], playing = ch.some(c => c.id === current()?.id) && !engine.el.paused;
    hero = `<div class="bk-hero-row"><a href="#/book/${encodeURIComponent(k)}">${bookCover(t, 'big')}</a><div class="bk-hero-meta">
        <div class="bk-eb">${sp.started && !sp.finished ? 'Continue listening' : narratingFor(t.album) ? 'Preparing · ' + readyTxt(ch, narratingFor(t.album)) : 'Start listening'}</div><a class="bk-ht" href="#/book/${encodeURIComponent(k)}">${esc(t.album || t.title)}</a><div class="bk-ha">${esc(t.artist)}</div>
        <div class="bk-hc ellipsis">${esc(t.title)}</div><div class="bk-hp"><span class="pod-bar"><i style="width:${st.pct}%"></i></span>${esc(leftTxt(sp.started ? st.left : st.total))}${sp.started ? ' left' : ''}</div></div></div>
      <div class="bk-acts"><button class="bk-btn light" data-action="book-play" data-book="${esc(k)}">${icon(playing ? 'pause' : 'play')}${playing ? 'Pause' : 'Listen'}</button><button class="bk-btn glass" data-action="book-read" data-book="${esc(k)}">${icon('read')}Read</button></div>`;
  }
  const f = S.bookFilter || 'all';
  const bq = fold(S.bookQ || ''), sortBy = S.bookSort || 'recent';
  const list = all.filter(([, ch]) => !bq || fold(`${ch[0].album} ${ch[0].artist}`).includes(bq)).sort((a, b) => sortBy === 'title' ? (a[1][0].album || '').localeCompare(b[1][0].album || '') : sortBy === 'author' ? (a[1][0].artist || '').localeCompare(b[1][0].artist || '') : (b[2]?.at || b[1][0].addedAt || 0) - (a[2]?.at || a[1][0].addedAt || 0)).filter(([, ch, sp]) => f === 'all' || (f === 'listening' && sp?.started && !sp.finished) || (f === 'finished' && sp?.finished) || (f === 'narrating' && narratingFor(ch[0].album)));
  const tiles = [...(f === 'all' || f === 'narrating' ? pending.map(queueTile) : []), ...list.map(([k, ch]) => bookTile([k, ch]))];
  const chips = [['all', 'All'], ['listening', 'Listening'], ['narrating', 'Narrating'], ['finished', 'Finished']].map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-action="book-filter" data-f="${k}">${l}</button>`).join('');
  const lead = pick ? pick[1][pick[2].i] || pick[1][0] : null, bg = lead ? artOf(lead, 'full') : vGoing?.[0].cover;
  return `<section class="bk-hero">${bg ? `<div class="bk-hero-bg"><img src="${bg}" alt=""></div>` : ''}<div class="bk-hero-in">
      <div class="bk-top"><h1>Audiobooks</h1>${add}</div>${hero}</div></section>
    <div class="bk-tools"><div class="chips bk-chips">${chips}</div><div class="bk-find"><label class="bk-search">${icon('search')}<input id="bk-q" type="search" placeholder="Search books" value="${esc(S.bookQ || '')}" autocomplete="off"></label><select id="bk-sort" class="bk-sort" aria-label="Sort">${[['recent', 'Recent'], ['title', 'Title'], ['author', 'Author']].map(([k, l]) => `<option value="${k}" ${sortBy === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    ${tiles.length ? `<div class="bk-grid">${tiles.join('')}</div>` : `<p class="muted bk-none">No books here yet.</p>`}
    <p class="muted book-how">${BOOK_HOW}</p>`;
};
VIEWS.book = () => {
  const key = S.param, ch = bookChapters(key);
  if (!ch.length) return `${back()}<div class="empty-state small"><p>This book isn’t in your library.</p></div>`;
  const t0 = ch[0], st = bookStats(key), sp = bookSpot(key), playingHere = ch.some(c => c.id === current()?.id) && !engine.el.paused, q = narratingFor(t0.album);
  const label = playingHere ? 'Pause' : sp.finished ? 'Listen again' : sp.started ? 'Resume' : 'Start listening';
  return `<section class="bk-detail"><div class="bk-hero-bg"><img src="${artOf(t0, 'full')}" alt=""></div><div class="bk-detail-in">${back()}
      ${bookCover(t0, 'big')}<h1>${esc(t0.album || t0.title)}</h1><div class="bk-ha">${esc(t0.artist)}</div>
      <div class="bk-by">${bookRecord(t0.album) ? `Narrated by Fof · ${bookRecord(t0.album).voice === 'british' ? 'Deep British voice' : 'Deep American voice'}` : ''}</div>
      <div class="bk-facts">${q ? `${esc(readyTxt(ch, q))} · ${esc(leftTxt(st.total))} so far${sp.started && !sp.finished ? ` · ${esc(leftTxt(st.left))} left of that` : ''}` : `${ch.length} chapter${ch.length === 1 ? '' : 's'} · ${esc(leftTxt(st.total))}${sp.started && !sp.finished ? ` · ${esc(leftTxt(st.left))} left` : ''}`}</div>
      ${sp.started && !sp.finished ? `<div class="bk-dp"><span class="pod-bar"><i style="width:${st.pct}%"></i></span></div><div class="bk-at ellipsis">${esc(ch[sp.i].title)}</div>` : ''}
      <div class="bk-acts"><button class="bk-btn light" data-action="book-play" data-book="${esc(key)}">${icon(playingHere ? 'pause' : 'play')}${label}</button><button class="bk-btn glass" data-action="book-read" data-book="${esc(key)}">${icon('read')}Read</button></div>
      <div class="bk-links">${sp.started ? `<button class="link bk-restart" data-action="book-restart" data-book="${esc(key)}">Start over</button>` : ''}${!sp.finished ? `<button class="link bk-restart" data-action="book-finish" data-book="${esc(key)}">Mark as finished</button>` : ''}</div></div></section>
    ${bookRecord(t0.album)?.about ? `<section class="section bk-about"><div class="section-head"><h2>About this book</h2></div><p>${esc(bookRecord(t0.album).about)}</p></section>` : ''}
    ${bookmarksHtml(key)}<section class="section bk-chs"><div class="section-head"><h2>Chapters</h2></div><div class="book-chapters">${chapterList(ch, key)}</div></section>`;
};
VIEWS.podcasts = () => {
  S.pod.subs.forEach(s => showEps(s.id));
  const topicTiles = pods.TOPICS.map(t => `<a class="pod-topic" href="#/topic/${t.key}" style="--c:${t.color}"><span>${t.name}</span></a>`).join('');
  const up = upNext();
  const latest = S.pod.subs.flatMap(s => (PC.eps.get(s.id) || []).slice(0, 3)).sort((a, b) => b.date - a.date).slice(0, 8);
  const starter = S.pod.subs.length ? null : topicShows('islam');
  return `<div class="page-head"><h1>Podcasts</h1></div>
    <div class="pod-search"><label class="search-box">${icon('search')}<input id="pod-q" class="input" type="search" placeholder="Shows, episodes, topics" autocomplete="off" value="${esc(PC.q)}" enterkeyhint="search"></label><div class="pod-suggest" id="pod-suggest"></div></div>
    <div id="pod-results">${PC.results ? podResults() : ''}</div>
    ${up.length ? `<section class="section"><div class="section-head"><h2>Up Next</h2></div><div class="shelf pod-up-shelf">${up.map(upCard).join('')}</div></section>` : ''}
    <section class="section"><div class="section-head"><h2>Browse Topics</h2></div><div class="pod-topics">${topicTiles}</div></section>
    ${latest.length ? `<section class="section"><div class="section-head"><h2>New Episodes</h2></div><div class="pod-eps">${latest.map(e => epRow(e)).join('')}</div></section>` : ''}
    ${S.pod.subs.length ? `<section class="section"><div class="section-head"><h2>Your Shows</h2></div><div class="pod-shows">${S.pod.subs.map(showTile).join('')}</div></section>` : ''}
    ${starter?.length ? `<section class="section"><div class="section-head"><h2>Popular in Islam</h2></div><div class="pod-shows">${starter.slice(0, 12).map(showTile).join('')}</div></section>` : ''}`;
};
function topicShows(key) {
  const t = pods.TOPICS.find(x => x.key === key); if (!t) return [];
  if (!PC.topic.has(key) && !PC.done?.has('t' + key)) podLoad('t' + key, async () => PC.topic.set(key, await pods.search(t.term, 40)));
  return PC.topic.get(key);
}
VIEWS.topic = () => {
  const t = pods.TOPICS.find(x => x.key === S.param) || pods.TOPICS[0];
  const shows = topicShows(t.key);
  return `${back()}<div class="page-head"><h1>${esc(t.name)}</h1></div>${shows ? `<div class="pod-shows">${shows.map(showTile).join('')}</div>` : '<div class="pod-loading">Loading shows…</div>'}`;
};
VIEWS.show = () => {
  const id = S.param, eps = showEps(id), sh = PC.shows.get(id) || S.pod.subs.find(s => s.id === id);
  if (!sh) return `${back()}<div class="pod-loading">Loading…</div>`;
  const f = following(id);
  return `${back()}<div class="pod-head"><img src="${esc(sh.art)}" alt=""><div><h1>${esc(sh.title)}</h1><div class="muted">${esc(sh.author)}</div>
      <div class="pod-head-actions">${eps?.length ? `<button class="btn primary" data-action="pod-play" data-id="${esc(eps.find(e => !S.pod.prog[e.id]?.done)?.id || eps[0].id)}">${icon('play')}${S.pod.prog[eps[0].id] ? 'Resume' : 'Latest Episode'}</button>` : ''}
      <button class="btn" data-action="pod-follow" data-id="${esc(id)}">${f ? icon('check') + 'Following' : icon('plus') + 'Follow'}</button></div></div></div>
    <section class="section"><div class="section-head"><h2>Episodes</h2></div>${!eps ? '<div class="pod-loading">Loading episodes…</div>' : eps.length ? `<div class="pod-eps">${eps.map(e => epRow(e, { art: false })).join('')}</div>` : '<p class="muted pod-none">This show’s episodes aren’t available right now.</p>'}</section>`;
};
function podResults() {
  const r = PC.results || [];
  if (!r.length) return `<p class="muted pod-none">No shows found for “${esc(PC.q)}”.</p>`;
  return `<section class="section"><div class="section-head"><h2>Results</h2><a class="see-all" data-action="pod-clear">Clear</a></div><div class="pod-shows">${r.map(showTile).join('')}</div></section>`;
}
function bindPodSearch() {
  const inp = $('#pod-q'); if (!inp || inp._b) return; inp._b = true;
  const box = $('#pod-suggest');
  let n = 0;
  inp.addEventListener('input', () => {
    PC.q = inp.value; clearTimeout(inp._t); const q = inp.value.trim(), my = ++n;
    if (!q) { box.innerHTML = ''; return; }
    inp._t = setTimeout(async () => {
      const r = await pods.search(q, 8); if (my !== n) return;
      box.innerHTML = r.length ? r.map(sh => { PC.shows.set(sh.id, sh); return `<a class="pod-sug" href="#/show/${sh.id}"><img src="${esc(sh.art)}" alt=""><span><b class="ellipsis">${esc(sh.title)}</b><em class="ellipsis">${esc(sh.author)}</em></span></a>`; }).join('') : '';
    }, 180);
  });
  inp.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return; e.preventDefault(); inp.blur(); box.innerHTML = '';
    PC.results = await pods.search(inp.value, 30); $('#pod-results').innerHTML = podResults();
  });
}
async function podPlay(id) {
  const ep = PC.ep?.get(id) || S.ext.get(id); if (!ep) return;
  if (current()?.id === id) return toggle();
  const merged = { ...(S.ext.get(id) || {}), ...ep }; saveExt(merged);
  const list = (PC.eps.get(ep.showId) || [ep]);
  const i = Math.max(0, list.findIndex(e => e.id === id));
  // later episodes of the same show (older ones, in order) follow, so a series keeps going
  const ids = list.slice(i).map(e => { if (!S.ext.has(e.id)) saveExt(e); return e.id; }).slice(0, 20);
  await playList(ids, 0, { context: ep.album, ctxRoute: 'show/' + ep.showId, mode: 'podcast' });
}
async function podDownload(id) {
  const ep = S.ext.get(id) || PC.ep?.get(id); if (!ep) return;
  const t = { ...ep, ...(S.ext.get(id) || {}) };
  if (t.path || t.local) {
    if (NATIVE) await NATIVE.removeFile({ name: 'pod-' + id.slice(4) + '.' + (t.fileExt || 'mp3') }).catch(() => {});
    else await db.del('audio', id).catch(() => {});
    delete t.path; t.local = false; saveExt(t); toast('Removed from this device'); return render();
  }
  toast('Saving episode…');
  try {
    if (NATIVE) { const r = await NATIVE.download({ url: t.url, name: 'pod-' + id.slice(4) + '.' + (t.fileExt || 'mp3') }); t.path = r.path; }
    else { const b = await fetch(t.url.replace(/^http:/, 'https:')).then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); }); await db.put('audio', id, b); t.local = true; }
    saveExt(t); toast('Saved for offline'); render();
  } catch (e) { console.warn(e); toast(NATIVE ? 'Couldn’t save this episode. Try again.' : 'This show only saves for offline in the iPhone app'); }
}
/** The iPhone app keeps the newest episode of every show you follow ready for no-signal listening. */
async function podAutoSave() {
  if (!NATIVE || !navigator.onLine || offSet().podcasts === false) return;
  for (const s of S.pod.subs) {
    const r = await pods.episodes(s.id).catch(() => null); const ep = r?.episodes?.[0]; if (!ep || S.ext.get(ep.id)?.path || S.pod.prog[ep.id]?.done) continue;
    try { const x = await NATIVE.download({ url: ep.url, name: 'pod-' + ep.id.slice(4) + '.' + ep.fileExt }); saveExt({ ...ep, ...(S.ext.get(ep.id) || {}), path: x.path }); } catch {}
  }
}
function podFollow(id) {
  const sh = PC.shows.get(id); if (!sh) return;
  if (following(id)) { S.pod.subs = S.pod.subs.filter(s => s.id !== id); toast('Unfollowed'); }
  else { S.pod.subs.unshift(sh); toast(`Following ${sh.title}`); setTimeout(podAutoSave, 1500); }
  podSave(); render();
}

/* =====================================================================
   Quran
   ===================================================================== */
const QR = { list: null, juz: null, text: new Map(), audio: new Map(), timing: new Map(), recs: null, tab: 'surah', q: '', rq: '', rf: 'all', curV: 0, daily: null };
const reciterId = () => S.settings.reciter || 'ar.alafasy';
const recById = id => QR.recs?.find(r => r.id === id) || (id.startsWith('ar.') ? { id, name: 'Mishary Alafasy', kind: 'verse', follows: true } : null);
const rec = () => recById(reciterId()) || { id: 'ar.alafasy', name: 'Mishary Alafasy', kind: 'verse', follows: true };
const surahName = s => s.name.replace(/^سُورَةُ\s*/, '');
function qLoad(key, fn) { if (!PC.done?.has(key)) podLoad(key, fn); }
function qList() { if (!QR.list) qLoad('qlist', async () => { QR.list = await quran.surahs(); }); return QR.list; }
function qRecs() { if (!QR.recs) qLoad('qrecs', async () => { QR.recs = await quran.reciters(); }); return QR.recs; }
function qText(n) { if (!QR.text.has(n)) qLoad('qt' + n, async () => QR.text.set(n, await quran.text(n))); return QR.text.get(n); }
async function qTextNow(n) { if (!QR.text.has(n)) QR.text.set(n, await quran.text(n)); return QR.text.get(n); }
async function qTimingNow(r, n) { if (!r.read) return null; const k = r.read + ':' + n; if (!QR.timing.has(k)) { try { QR.timing.set(k, await quran.timing(r.read, n)); } catch { return null; } } return QR.timing.get(k); }
/** Which verse is playing right now, for any reciter. */
function curVerse() {
  const t = current(); if (!t) return null;
  if (t.kind === 'ayah') return { s: t.surah, v: t.n };
  if (t.kind === 'surahrec') return { s: t.surah, v: QR.curV || 1 };
  return null;
}
const initials = n => n.replace(/^(sheikh|shaik|shaikh)\s+/i, '').split(/[\s-]+/).filter(w => !/^(al|as|ash|ar|az|bin|ibn)$/i.test(w)).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const AV_COLORS = [['#1f3b33', '#9fd1bf'], ['#3d3320', '#e6c98a'], ['#2a2f45', '#b7c2f0'], ['#3a2430', '#efb6cb'], ['#203a3a', '#9fd8d8'], ['#33283f', '#cdb8ee'], ['#3d2a20', '#f0c2a2'], ['#2f3320', '#d6e09a']];
const avatar = (r, cls = '') => { let h = 0; for (const c of r.name) h = (h * 31 + c.charCodeAt(0)) | 0; const [bg, fg] = AV_COLORS[Math.abs(h) % AV_COLORS.length]; return `<span class="q-av ${cls}" style="background:${bg};color:${fg}">${esc(initials(r.name))}</span>`; };

/** Imam Feysal Mohammed: his recitations, streamed from Tarteel Network's YouTube uploads. */
VIEWS.feysal = (tab) => {
  const cat = feysal.catalog(), k = cat[tab || S.param] ? (tab || S.param) : 'complete', al = feysal.ALBUMS.find(a => a.k === k);
  const tracks = cat[k], total = feysal.all().length, mins = Math.round(tracks.reduce((n, t) => n + t.duration, 0) / 60);
  const cur = current(), here = cur?.kind === 'yt' ? cur : null;
  return `${back()}${collHead({ img: tracks[0].art, tracks, eyebrow: 'Reciter', title: feysal.NAME, ctxRoute: 'feysal/' + k,
    meta: `${esc(al.title)} · ${tracks.length} surahs · ${mins >= 60 ? Math.floor(mins / 60) + ' hr ' + (mins % 60) + ' min' : mins + ' min'} · ${total} recitations in all` })}
    ${here && here.albumKey !== k ? `<a class="q-continue fy-now" href="#/feysal/${here.albumKey}"><div><div class="q-c-eyebrow">Now playing</div><div class="q-c-t">${esc(here.title)}</div><div class="q-c-s">${esc(here.album)}</div></div><span class="q-c-play">${icon('play')}</span></a>` : ''}
    <div class="seg q-seg fy-seg" role="tablist">${feysal.ALBUMS.map(a => `<a role="tab" aria-selected="${a.k === k}" class="${a.k === k ? 'on' : ''}" href="#/feysal/${a.k}">${esc(a.tab)}</a>`).join('')}</div>
    ${trackRows(tracks, { cols: [], context: feysal.NAME + ' · ' + al.title, key: 'fy-' + k })}
    <p class="muted fy-note">Streams from Tarteel Network on YouTube. Needs an internet connection.</p>`;
};
VIEWS.quran = () => {
  if (S.param) { const [n, v] = String(S.param).split('.').map(Number); if (v) QR.scrollTo = v; return quranReader(n); }
  const list = qList(), spot = S.quranSpot, r = rec(); qRecs();
  const sname = spot && list?.[spot.surah - 1];
  if (!QR.daily) { const [s, v] = quran.DAILY[Math.floor(Date.now() / 864e5) % quran.DAILY.length]; QR.daily = { s, v }; quran.verse(s, v).then(x => { QR.daily = x; if (S.route === 'quran' && !S.param) render(); }).catch(() => {}); }
  const d = QR.daily;
  const q = QR.q.trim().toLowerCase();
  const rows = list ? list.filter(s => !q || String(s.number) === q || s.englishName.toLowerCase().replace(/[-']/g, '').includes(q.replace(/[-']/g, '')) || s.englishNameTranslation.toLowerCase().includes(q) || s.name.includes(q)) : null;
  let body = '';
  if (QR.tab === 'surah') body = rows ? (rows.length ? `<div class="settings-group q-list">${rows.map(s => `<a class="q-row" href="#/quran/${s.number}"><span class="q-n">${s.number}</span><span class="q-main"><b>${esc(s.englishName)}</b><em>${esc(s.englishNameTranslation)} · ${s.numberOfAyahs} verses</em></span><span class="q-ar" dir="rtl" lang="ar">${esc(surahName(s))}</span></a>`).join('')}</div>` : `<p class="muted pod-none">No surah matches “${esc(QR.q)}”.</p>`) : '<div class="pod-loading">Loading…</div>';
  else if (QR.tab === 'juz') {
    if (!QR.juz) qLoad('qjuz', async () => { QR.juz = await quran.juzs(); });
    body = QR.juz && list ? `<div class="settings-group q-list">${QR.juz.map((j, i) => { const nx = QR.juz[i + 1]; const end = !nx ? { surah: 114, ayah: 6 } : nx.ayah > 1 ? { surah: nx.surah, ayah: nx.ayah - 1 } : { surah: nx.surah - 1, ayah: list[nx.surah - 2].numberOfAyahs };
      return `<a class="q-row" href="#/quran/${j.surah}.${j.ayah}"><span class="q-n">${i + 1}</span><span class="q-main"><b>Juz ${i + 1}</b><em>${esc(list[j.surah - 1].englishName)} ${j.ayah} – ${end.surah !== j.surah ? esc(list[end.surah - 1].englishName) + ' ' : ''}${end.ayah}</em></span>${icon('back', 'chev')}</a>`; }).join('')}</div>` : '<div class="pod-loading">Loading…</div>';
  } else {
    const saved = (S.quranSaved || []).slice().sort((a, b) => b.at - a.at);
    body = saved.length ? `<div class="settings-group q-list">${saved.map(x => { const s = list?.[x.s - 1]; const a = QR.text.get(x.s)?.[x.v - 1]; if (!a) qText(x.s);
      return `<a class="q-saved" href="#/quran/${x.s}.${x.v}"><div class="q-saved-ref">${esc(s?.englishName || 'Surah ' + x.s)} · ${x.v}</div>${a ? `<div class="q-saved-ar" dir="rtl" lang="ar">${esc(a.ar)}</div><div class="q-saved-en">${esc(a.en)}</div>` : ''}</a>`; }).join('')}</div>` : `<div class="empty-state small"><h2>No saved verses yet</h2><p>Press and hold any verse to save it here.</p></div>`;
  }
  return `<div class="page-head"><h1>Quran</h1></div>
    ${sname ? `<div class="q-continue" data-action="q-resume"><div><div class="q-c-eyebrow">Continue · ${esc(recById(spot.reciter || reciterId())?.name || r.name)}</div><div class="q-c-t">${esc(sname.englishName)}</div><div class="q-c-s">Verse ${spot.ayah} of ${sname.numberOfAyahs}</div><div class="q-c-bar"><i style="width:${Math.max(2, spot.ayah / sname.numberOfAyahs * 100)}%"></i></div></div><span class="q-c-play">${icon('play')}</span></div>` : ''}
    ${d?.ar ? `<a class="q-daily" href="#/quran/${d.s}.${d.v}"><div class="q-daily-ref">Verse of the day · ${esc(d.name)} ${d.v}</div><div class="q-daily-ar" dir="rtl" lang="ar">${esc(d.ar)}</div><div class="q-daily-en">${esc(d.en)}</div></a>` : ''}
    <div class="settings-group q-group"><a class="set-row" href="#/reciters"><span>Reciter</span><span class="set-val">${esc(r.name)}${icon('back', 'chev')}</span></a>
      <a class="set-row fy-row" href="#/feysal"><span class="fy-row-main"><img src="${feysal.catalog().complete[11].art}" alt=""><span><b>${esc(feysal.NAME)}</b><em>${feysal.all().length} recitations</em></span></span>${icon('back', 'chev')}</a></div>
    <div class="seg q-seg" role="tablist">${[['surah', 'Surah'], ['juz', 'Juz'], ['saved', 'Saved']].map(([k, l]) => `<button role="tab" aria-selected="${QR.tab === k}" class="${QR.tab === k ? 'on' : ''}" data-action="q-tab" data-id="${k}">${l}</button>`).join('')}</div>
    ${QR.tab === 'surah' ? `<label class="search-box q-search">${icon('search')}<input id="q-find" class="input" type="search" placeholder="Surah name or number" value="${esc(QR.q)}" autocomplete="off" enterkeyhint="search"></label>` : ''}
    <div id="q-body">${body}</div>`;
};

function quranReader(n) {
  const list = qList(), s = list?.[n - 1], ayahs = qText(n), r = rec(); qRecs();
  if (!s) return `${back()}<div class="pod-loading">Loading…</div>`;
  const cv = curVerse(), on = cv?.s === n ? cv.v : 0;
  const page = S.settings.qView === 'page';
  const bism = n !== 1 && n !== 9 ? '<div class="q-bism" dir="rtl" lang="ar">بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ</div>' : '';
  const head = `<div class="qr-head"><div class="qr-head-ar" dir="rtl" lang="ar">${esc(surahName(s))}</div><h1>${esc(s.englishName)}</h1><div class="muted">${esc(s.englishNameTranslation)} · ${s.numberOfAyahs} verses · ${esc(r.name)}</div>
    <div class="pod-head-actions"><button class="btn primary" data-action="q-play" data-id="${n}:1">${icon('play')}Play</button><button class="btn" data-action="q-mem" data-id="${n}">${icon('repeat')}Memorize</button></div>
    <div class="seg q-view">${[['verse', 'Verses'], ['page', 'Pages']].map(([k, l]) => `<button class="${(page ? 'page' : 'verse') === k ? 'on' : ''}" data-action="q-view" data-id="${k}">${l}</button>`).join('')}</div>
    ${r.kind === 'surah' && !r.follows ? `<p class="muted q-note">${esc(r.name)} plays the whole surah, so verses don’t light up as he recites.</p>` : ''}${quran.has(r, n) ? '' : `<p class="muted q-note">${esc(r.name)} hasn’t recorded this surah. Pick another reciter to listen.</p>`}</div>`;
  if (!ayahs) return `${back()}${head}<div class="pod-loading">Loading…</div>`;
  const hide = P.mem?.hide && P.mem.s === n ? ' mem-hide' : '';
  if (page) {
    const pages = []; for (const a of ayahs) { const last = pages[pages.length - 1]; if (!last || last.page !== a.page) pages.push({ page: a.page, juz: a.juz, ayahs: [a] }); else last.ayahs.push(a); }
    return `${back()}${head}<div class="q-pages${hide}">${pages.map((p, i) => `<section class="q-page"><div class="q-page-top"><span>Juz ${p.juz}</span><span>Page ${p.page}</span><span>${esc(s.englishName)}</span></div>
      ${i === 0 ? `<div class="q-banner" dir="rtl" lang="ar">سُورَةُ ${esc(surahName(s))}</div>${bism}` : ''}
      <div class="q-flow" dir="rtl" lang="ar">${p.ayahs.map(a => `<span class="q-pv${a.n === on ? ' on' : ''}" data-v="${a.n}" data-action="q-verse" data-id="${n}:${a.n}">${esc(a.ar)} <span class="q-orn">﴿${quran.arNum(a.n)}﴾</span></span>`).join(' ')}</div></section>`).join('')}</div>`;
  }
  const saved = new Set((S.quranSaved || []).filter(x => x.s === n).map(x => x.v));
  return `${back()}${head}<div class="q-verses${hide}">${bism}${ayahs.map(a => `<div class="q-v${a.n === on ? ' on' : ''}" data-v="${a.n}" data-action="q-play" data-id="${n}:${a.n}"><div class="q-v-ar" dir="rtl" lang="ar">${esc(a.ar)} <span class="q-orn">﴿${quran.arNum(a.n)}﴾</span></div><div class="q-v-en">${esc(a.en)}</div>${saved.has(a.n) ? `<span class="q-v-saved">${icon('heart')}</span>` : ''}</div>`).join('')}</div>`;
}

/* ---------- reciters ---------- */
const SHELVES = [
  ['Featured', ['Alafasy', 'Yasser Al-Dosari', 'Islam Sobhi', 'Abdul Basit', 'Nasser Alqatami', 'Maher Al-Muaiqly', 'Saad Al-Ghamdi', 'Ahmed Al-Ajmi']],
  ['Calm and slow', ['Al-Husary', 'Minshawi', 'Raad Al Kurdi', 'Mansour Al-Salemi', 'Idrees Abkr', 'Hazza Al-Balushi', 'Muhammad Ayyub', 'Abdullah Basfar']],
  ['Haramain imams', ['Sudais', 'Shuraim', 'Bandar Balilah', 'Abdullah Al-Johany', 'Yasser Al-Dosari', 'Ali Jaber', 'Khalid Al-Jileel', 'Al-Hudhaifi']],
];
const simple = s => s.toLowerCase().replace(/[^a-z]/g, '').replace(/(.)\1/g, '$1');
function recRow(r) {
  const on = r.id === reciterId();
  return `<div class="q-rec${on ? ' on' : ''}" data-action="q-set-reciter" data-id="${esc(r.id)}">${avatar(r)}<span class="q-rec-main"><b>${esc(r.name)}</b><em>${[r.style, r.follows ? 'Follows verses' : 'Whole surah'].filter(Boolean).join(' · ')}</em></span>
    <button class="icon-btn small q-sample${QR.sampling === r.id ? ' on' : ''}" data-action="q-sample" data-id="${esc(r.id)}" aria-label="Hear a sample">${icon(QR.sampling === r.id ? 'pause' : 'play')}</button>${on ? icon('check', 'q-check') : '<span class="q-check"></span>'}</div>`;
}
VIEWS.reciters = () => {
  const recs = qRecs();
  if (!recs) return `${back()}<div class="page-head"><h1>Reciters</h1></div><div class="pod-loading">Loading reciters…</div>`;
  const q = simple(QR.rq);
  const pool = recs.filter(r => QR.rf === 'all' || (QR.rf === 'follows' ? r.follows : /Mujawwad/.test(r.style || '')));
  const found = q ? pool.filter(r => simple(r.name).includes(q)) : pool;
  const pick = name => recs.find(r => !/Warsh|Qalon|Dori|Sosi/.test(r.style || '') && simple(r.name).includes(simple(name)));
  const shelves = !q && QR.rf === 'all' ? SHELVES.map(([t, names]) => { const rs = [...new Set(names.map(pick).filter(Boolean))]; return rs.length ? `<section class="section"><div class="section-head"><h2>${t}</h2></div><div class="shelf q-tiles">${rs.map(r => `<div class="q-tile${r.id === reciterId() ? ' on' : ''}" data-action="q-set-reciter" data-id="${esc(r.id)}">${avatar(r, 'big')}<span>${esc(r.name)}</span></div>`).join('')}</div></section>` : ''; }).join('') : '';
  const sorted = [...found].sort((a, b) => a.name.localeCompare(b.name));
  return `${back()}<div class="page-head"><h1>Reciters</h1></div>
    <label class="search-box">${icon('search')}<input id="rec-find" class="input" type="search" placeholder="Search ${recs.length} reciters" value="${esc(QR.rq)}" autocomplete="off" enterkeyhint="search"></label>
    <div class="seg q-seg">${[['all', 'All'], ['follows', 'Follows verses'], ['muj', 'Mujawwad']].map(([k, l]) => `<button class="${QR.rf === k ? 'on' : ''}" data-action="q-rf" data-id="${k}">${l}</button>`).join('')}</div>
    <div id="rec-body">${shelves}<section class="section"><div class="section-head"><h2>${q ? 'Results' : 'All reciters'}</h2><span class="muted">${sorted.length}</span></div>${sorted.length ? `<div class="settings-group q-recs">${sorted.map(recRow).join('')}</div>` : `<p class="muted pod-none">No reciter matches “${esc(QR.rq)}”.</p>`}</section></div>`;
};
let sampleEl;
async function qSample(id) {
  const r = recById(id); if (!r) return;
  if (sampleEl) { sampleEl.pause(); sampleEl = null; }
  if (QR.sampling === id) { QR.sampling = null; return render(); }
  try {
    const url = r.kind === 'verse' ? (await quran.verseAudio(1, r.id))[1] : quran.surahUrl(r, 1);
    if (!engine.el.paused) engine.el.pause();
    sampleEl = new Audio(url); QR.sampling = id; render();
    const stop = () => { if (QR.sampling === id) { QR.sampling = null; sampleEl?.pause(); sampleEl = null; render(); } };
    sampleEl.addEventListener('ended', stop); sampleEl.addEventListener('error', () => { toast('Couldn’t play a sample right now'); stop(); });
    await sampleEl.play(); setTimeout(stop, 12000);
  } catch { QR.sampling = null; render(); }
}
async function qSetReciter(id) {
  const r = recById(id); if (!r) return;
  S.settings.reciter = id; await saveSettings(); haptic(); toast(r.name);
  const cv = curVerse();
  if (cv) qPlay(cv.s, cv.v, { keepPaused: engine.el.paused }); // switch voices without losing your place
  render();
}

/* ---------- playing ---------- */
async function qPlay(n, from = 1, { keepPaused = false } = {}) {
  const list = QR.list || await quran.surahs().catch(() => null); QR.list = list;
  const s = list?.[n - 1]; if (!s) return toast('Couldn’t load the Quran. Check your connection.');
  const r = rec();
  if (!quran.has(r, n)) return toast(`${r.name} hasn’t recorded ${s.englishName}. Pick another reciter.`);
  const art = quran.cover(s.englishName, surahName(s));
  if (r.kind === 'verse') {
    let audio = QR.audio.get(n + r.id), ayahs;
    try { ayahs = await qTextNow(n); if (!audio) { audio = await quran.verseAudio(n, r.id); QR.audio.set(n + r.id, audio); } } catch { return toast('Couldn’t load this surah. Check your connection.'); }
    const ids = ayahs.map((a, i) => { const id = `qur:${r.id}:${a.g}`; S.ext.set(id, { ...keepPath(id), id, ext: true, kind: 'ayah', surah: n, n: a.n, g: a.g, title: `${s.englishName} · Verse ${a.n}`, artist: r.name, album: 'Quran', category: 'Quran', art, url: audio[i] }); return id; });
    saveExt(S.ext.get(ids[0]));
    const ord = P.mem ? memOrder(ids) : null;
    await playList(ord || ids, ord ? 0 : Math.max(0, from - 1), { context: s.englishName, ctxRoute: 'quran/' + n, mode: 'quran' });
  } else {
    const ids = list.filter(x => x.number >= n && quran.has(r, x.number)).slice(0, 20).map(x => { const id = `qs:${r.id}:${x.number}`; S.ext.set(id, { ...keepPath(id), id, ext: true, kind: 'surahrec', surah: x.number, title: x.englishName, artist: r.name, album: 'Quran', category: 'Quran', art: quran.cover(x.englishName, surahName(x)), url: quran.surahUrl(r, x.number), read: r.read }); return id; });
    saveExt(S.ext.get(ids[0]));
    const tm = await qTimingNow(r, n);
    QR.curV = from;
    if (from > 1 && tm?.[from - 1]) { P.resumeId = ids[0]; P.resumeAt = tm[from - 1][0] / 1000; }
    await playList(ids, 0, { context: s.englishName, ctxRoute: 'quran/' + n, mode: 'quran' });
    if (from > 1 && tm?.[from - 1]) seekWhenReady(tm[from - 1][0] / 1000);
  }
  if (keepPaused) setTimeout(() => engine.el.pause(), 300);
}
/** Keeps the highlighted verse in step with a whole-surah recording, and runs Memorize repeats. */
function qTick(c) {
  const t = current(); if (t?.kind !== 'surahrec') return;
  const tm = QR.timing.get(t.read + ':' + t.surah);
  if (!tm) { if (t.read && !QR.loadingT) { QR.loadingT = true; quran.timing(t.read, t.surah).then(x => QR.timing.set(t.read + ':' + t.surah, x)).catch(() => {}).finally(() => { QR.loadingT = false; }); } return; }
  const ms = c * 1000;
  if (P.mem && P.mem.s === t.surah && !P.mem.wait) {
    const m = P.mem, end = tm[m.v - 1]?.[1];
    if (end && ms >= end - 60) return memStep(() => { engine.el.currentTime = tm[m.v - 1][0] / 1000; });
  }
  let v = tm.findIndex(([a, b]) => ms >= a && ms < b) + 1;
  if (!v) v = ms >= (tm[tm.length - 1]?.[1] || Infinity) ? tm.length : QR.curV;
  if (v && v !== QR.curV) { QR.curV = v; qMark(); }
}
function qMark() {
  const cv = curVerse(); if (!cv) return;
  S.quranSpot = { surah: cv.s, ayah: cv.v, reciter: reciterId(), at: Date.now() }; kv.set('quranSpot', S.quranSpot); queueStatePush();
  if (P.panel === 'lyrics' && $('#now').classList.contains('open')) renderPanel();
  if (S.route !== 'quran' || parseInt(S.param) !== cv.s) return;
  $$('.q-v.on, .q-pv.on').forEach(v => v.classList.remove('on'));
  const v = document.querySelector(`.q-v[data-v="${cv.v}"], .q-pv[data-v="${cv.v}"]`); if (!v) return;
  v.classList.add('on');
  if (!QR.userScroll || Date.now() - QR.userScroll > 4000) v.scrollIntoView({ block: 'center', behavior: S.settings.reduceMotion ? 'auto' : 'smooth' });
}
$('#main').addEventListener('touchmove', () => { QR.userScroll = Date.now(); }, { passive: true });
$('#main').addEventListener('wheel', () => { QR.userScroll = Date.now(); }, { passive: true });
function qResume() { const sp = S.quranSpot; if (!sp) return go('quran'); if (sp.reciter && sp.reciter !== reciterId()) { S.settings.reciter = sp.reciter; saveSettings(); } qPlay(sp.surah, sp.ayah); }

/* ---------- verse actions (press and hold) ---------- */
function qVerseSheet(n, v) {
  const s = QR.list?.[n - 1], a = QR.text.get(n)?.[v - 1]; if (!a) return;
  const saved = (S.quranSaved || []).some(x => x.s === n && x.v === v);
  sheet(`<div class="q-vs"><div class="q-vs-ref">${esc(s?.englishName || '')} · Verse ${v}</div><div class="q-vs-ar" dir="rtl" lang="ar">${esc(a.ar)}</div><div class="q-vs-en">${esc(a.en)}</div>
    <div class="settings-group q-vs-acts">
      <button class="set-row" data-action="q-play" data-id="${n}:${v}" data-close><span>Play from here</span>${icon('play')}</button>
      <button class="set-row" data-action="q-rep" data-id="${n}:${v}" data-close><span>Repeat this verse</span><span class="muted">3×</span></button>
      <button class="set-row" data-action="q-save" data-id="${n}:${v}" data-close><span>${saved ? 'Remove from Saved' : 'Save verse'}</span>${icon('heart')}</button>
      <button class="set-row" data-action="q-copy" data-id="${n}:${v}" data-close><span>Copy</span>${icon('copy')}</button>
      ${navigator.share ? `<button class="set-row" data-action="q-share" data-id="${n}:${v}" data-close><span>Share</span>${icon('share')}</button>` : ''}
    </div></div>`);
}
const verseText = (n, v) => { const s = QR.list?.[n - 1], a = QR.text.get(n)?.[v - 1]; return a ? `${a.ar}\n\n${a.en}\n\n— ${s?.englishName || ''} ${n}:${v}` : ''; };
function qSave(n, v) {
  S.quranSaved = S.quranSaved || [];
  const i = S.quranSaved.findIndex(x => x.s === n && x.v === v);
  if (i >= 0) { S.quranSaved.splice(i, 1); toast('Removed from Saved'); } else { S.quranSaved.push({ s: n, v, at: Date.now() }); toast('Saved'); haptic(); }
  kv.set('quranSaved', S.quranSaved); queueStatePush(); render();
}
function bindQuran() {
  const f = $('#q-find'); if (f && !f._b) { f._b = true; f.addEventListener('input', () => { QR.q = f.value; const pos = f.selectionStart; render(); const g = $('#q-find'); g?.focus(); try { g.setSelectionRange(pos, pos); } catch {} }); }
  const rf = $('#rec-find'); if (rf && !rf._b) { rf._b = true; rf.addEventListener('input', () => { QR.rq = rf.value; const pos = rf.selectionStart; render(); const g = $('#rec-find'); g?.focus(); try { g.setSelectionRange(pos, pos); } catch {} }); }
  const box = $('.q-verses'); if (box && !box._b) {
    box._b = true; let tm, held = false;
    const start = e => { const v = e.target.closest('.q-v'); if (!v) return; held = false; tm = setTimeout(() => { held = true; haptic(); const [n, x] = v.dataset.id.split(':').map(Number); qVerseSheet(n, x); }, 480); };
    const cancel = () => clearTimeout(tm);
    box.addEventListener('touchstart', start, { passive: true }); box.addEventListener('touchend', cancel); box.addEventListener('touchmove', cancel, { passive: true });
    box.addEventListener('contextmenu', e => { const v = e.target.closest('.q-v'); if (!v) return; e.preventDefault(); const [n, x] = v.dataset.id.split(':').map(Number); qVerseSheet(n, x); });
    box.addEventListener('click', e => { if (held) { e.stopPropagation(); e.preventDefault(); held = false; } }, true);
  }
  if (QR.scrollTo && S.route === 'quran') { const el = document.querySelector(`.q-v[data-v="${QR.scrollTo}"], .q-pv[data-v="${QR.scrollTo}"]`); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); QR.scrollTo = 0; } }
}

/* ---------- memorize ---------- */
function memSheet(n, preset) {
  const s = QR.list?.[n - 1]; if (!s) return;
  const m = Object.assign({ s: n, from: 1, to: Math.min(5, s.numberOfAyahs), each: 3, range: 2, gap: 2, speed: 1, hide: false }, S.settings.memo || {}, preset || {}, { s: n });
  m.from = Math.min(m.from, s.numberOfAyahs); m.to = Math.min(Math.max(m.to, m.from), s.numberOfAyahs);
  QR.memDraft = m;
  const stp = (k, label, val) => `<div class="set-row"><span>${label}</span><span class="stepper"><button data-action="mem-step" data-id="${k}:-1" aria-label="Less">−</button><b>${val}</b><button data-action="mem-step" data-id="${k}:1" aria-label="More">+</button></span></div>`;
  const plays = (m.to - m.from + 1) * m.each * m.range;
  sheet(`<div id="mem-sheet"><h2>Memorize</h2><p class="muted">${esc(s.englishName)} · ${esc(rec().name)}</p>
    <div class="settings-group">${stp('from', 'From verse', m.from)}${stp('to', 'To verse', m.to)}${stp('each', 'Repeat each verse', m.each + '×')}${stp('range', 'Repeat the range', m.range + '×')}${stp('gap', 'Pause between repeats', m.gap + ' sec')}${stp('speed', 'Speed', m.speed + '×')}
      <div class="set-row"><div class="lbl"><b>Hide verses while it plays</b><span>The verse being recited is blurred so you can test yourself</span></div><button class="switch ${m.hide ? 'on' : ''}" role="switch" aria-checked="${m.hide}" data-action="mem-step" data-id="hide:1" aria-label="Hide verses"></button></div></div>
    <p class="muted mem-sum">${plays} play${plays === 1 ? '' : 's'}</p>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-action="mem-start" data-close>Start</button></div></div>`);
}
function memAdjust(k, d) {
  const m = QR.memDraft, max = QR.list[m.s - 1].numberOfAyahs;
  if (k === 'from') { m.from = Math.max(1, Math.min(max, m.from + d)); if (m.to < m.from) m.to = m.from; }
  else if (k === 'to') m.to = Math.max(m.from, Math.min(max, m.to + d));
  else if (k === 'each') m.each = Math.max(1, Math.min(20, m.each + d));
  else if (k === 'range') m.range = Math.max(1, Math.min(20, m.range + d));
  else if (k === 'gap') m.gap = Math.max(0, Math.min(10, m.gap + d));
  else if (k === 'speed') { const sp = [0.5, 0.6, 0.7, 0.75, 0.85, 1, 1.15, 1.25]; m.speed = sp[Math.max(0, Math.min(sp.length - 1, sp.indexOf(m.speed) + d))] || 1; }
  else if (k === 'hide') m.hide = !m.hide;
  memSheet(m.s, m);
}
/** A verse-by-verse queue already in Memorize order: each verse, then the range again. */
function memOrder(ids) {
  const m = P.mem; return ids.slice(m.from - 1, m.to);
}
async function memStart() {
  const m = QR.memDraft; if (!m) return;
  S.settings.memo = { each: m.each, range: m.range, gap: m.gap, speed: m.speed, hide: m.hide }; saveSettings();
  P.mem = { ...m, v: m.from, rep: 1, rrep: 1, wait: false };
  P.repeat = 'off'; P.shuffle = false; updateModes();
  engine.setRate(m.speed); P.speed = m.speed;
  await qPlay(m.s, m.from);
  if (S.route === 'quran') render();
}
function memEnd(msg) { if (!P.mem) return; P.mem = null; engine.setRate(1); P.speed = 1; engine.el.pause(); toast(msg || 'Memorize finished'); if (S.route === 'quran') render(); }
/** Called at the end of each verse while memorizing. `seek` jumps back for whole-surah recordings. */
function memStep(seek) {
  const m = P.mem; if (!m || m.wait) return true;
  const surahRec = current()?.kind === 'surahrec';
  let target;
  if (m.rep < m.each) { m.rep++; target = m.v; }
  else if (m.v < m.to) { m.rep = 1; m.v++; target = m.v; }
  else if (m.rrep < m.range) { m.rrep++; m.rep = 1; m.v = m.from; target = m.v; }
  else { memEnd(); return true; }
  m.wait = true; engine.el.pause();
  const go = async () => {
    if (!P.mem) return;
    m.wait = false;
    if (surahRec) { const tm = QR.timing.get(current().read + ':' + m.s); if (tm?.[target - 1]) engine.el.currentTime = tm[target - 1][0] / 1000; QR.curV = target; qMark(); engine.el.play(); }
    else { const k = P.queue.findIndex(id => T(id)?.n === target); if (k >= 0) { P.idx = k; await loadTrack(P.queue[k]); } }
  };
  setTimeout(go, Math.max(150, m.gap * 1000));
  return true;
}

/* =====================================================================
   Replay: your year in music
   ===================================================================== */
function replayData(year = new Date().getFullYear()) {
  const a = new Date(year, 0, 1).getTime(), b = new Date(year + 1, 0, 1).getTime();
  const log = S.log.filter(e => e.at >= a && e.at < b && S.tracks.has(e.id));
  const secs = log.reduce((x, e) => x + (e.s || 0), 0);
  const song = new Map(), art = new Map(), gen = new Map(), months = Array(12).fill(0), hours = Array(24).fill(0);
  for (const e of log) {
    const t = S.tracks.get(e.id), s = e.s || 0;
    const c = song.get(e.id) || { n: 0, s: 0 }; c.n++; c.s += s; song.set(e.id, c);
    const ar = mainArtist(t.artist); if (ar && !/^unknown/i.test(ar)) art.set(ar, (art.get(ar) || 0) + s);
    const g = t.genre || (t.category !== 'Music' ? t.category : ''); if (g) gen.set(g, (gen.get(g) || 0) + s);
    const d = new Date(e.at); months[d.getMonth()] += s; hours[d.getHours()] += s;
  }
  const topSongs = [...song].sort((x, y) => y[1].n - x[1].n || y[1].s - x[1].s).slice(0, 25).map(([id, c]) => ({ t: S.tracks.get(id), n: c.n }));
  const topArtists = [...art].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([name, s]) => ({ name, hours: s / 3600, ts: groups('artist').get(name) || [] }));
  const ph = hours.indexOf(Math.max(...hours));
  return { year, secs, hours: secs / 3600, songs: song.size, artists: art.size, topSongs, topArtists, topGenre: [...gen].sort((x, y) => y[1] - x[1])[0]?.[0] || '', months, peak: ph, plays: log.length };
}
const peakText = h => h >= 21 || h < 4 ? 'late at night' : h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : 'in the evening';
const hrs = h => h >= 10 ? Math.round(h).toLocaleString() : h.toFixed(1);
const hoursText = h => h < 1 ? `${Math.max(1, Math.round(h * 60))} minutes` : `${hrs(h)} hours`;
VIEWS.replay = () => {
  const r = replayData();
  if (r.plays < 5) return `${back()}<div class="page-head"><h1>Replay ${r.year}</h1></div><div class="empty-state small"><h2>Keep listening</h2><p>Your Replay fills in as you play music this year. Only real listening counts.</p></div>`;
  const key = listKey(r.topSongs.map(x => x.t.id), `Replay ${r.year}`);
  const mMax = Math.max(...r.months, 1), nowM = new Date().getMonth();
  return `${back()}<div class="page-head"><div><h1>Replay ${r.year}</h1><div class="section-sub">Updated as you listen</div></div></div>
    <button class="rp-story-btn" data-action="rp-story" style="${ambient(r.topSongs[0]?.t.colors)}"><img src="${artOf(r.topSongs[0]?.t, 'full')}" alt=""><span><b>Your ${r.year} story</b><em>${hoursText(r.hours)}, your top song, artist and more</em></span>${icon('play')}</button>
    <div class="rp-stats"><div class="stat"><span>${r.hours < 1 ? 'Minutes' : 'Hours'}</span><b>${r.hours < 1 ? Math.max(1, Math.round(r.hours * 60)) : hrs(r.hours)}</b></div><div class="stat"><span>Songs</span><b>${r.songs.toLocaleString()}</b></div><div class="stat"><span>Artists</span><b>${r.artists.toLocaleString()}</b></div><div class="stat"><span>Top genre</span><b class="ellipsis">${esc(r.topGenre || '—')}</b></div></div>
    <section class="section"><div class="section-head"><h2>Top Songs</h2><button class="btn small" data-play-list="${key}" data-i="0">${icon('play')}Play all</button></div>
      <div class="rp-list">${r.topSongs.slice(0, 10).map((x, i) => `<div class="rp-row" data-play-list="${key}" data-i="${i}"><span class="rp-rank">${i + 1}</span><img loading="lazy" src="${artOf(x.t)}" alt=""><span class="rp-main"><b class="ellipsis">${esc(x.t.title)}</b><em class="ellipsis">${esc(x.t.artist)} · ${x.n} play${x.n === 1 ? '' : 's'}</em></span></div>`).join('')}</div></section>
    <section class="section"><div class="section-head"><h2>Top Artists</h2></div><div class="shelf">${r.topArtists.map(a => collCard({ href: 'artist/' + a.name, title: a.name, sub: `${hrs(a.hours)} hours`, tracks: a.ts, round: true, img: artistImg(a.ts, a.name) })).join('')}</div></section>
    <section class="section"><div class="section-head"><h2>Hours by Month</h2></div><div class="rp-months">${r.months.slice(0, nowM + 1).map((s, i) => `<div class="rp-m"><i style="height:${Math.max(3, s / mMax * 100)}%"></i><span>${new Date(r.year, i, 1).toLocaleDateString(undefined, { month: 'narrow' })}</span></div>`).join('')}</div>
      <p class="muted rp-note">You listen most ${peakText(r.peak)}.</p></section>`;
};
function replayStory() {
  const r = replayData(); if (r.plays < 5) return;
  const top = r.topSongs[0]?.t, ta = r.topArtists[0];
  const cards = [
    { c: '#2a1846', h: `<div class="rs-eyebrow">Replay ${r.year}</div><div class="rs-lead">This year you spent</div><div class="rs-big">${r.hours < 1 ? Math.max(1, Math.round(r.hours * 60)) : hrs(r.hours)}</div><div class="rs-lead">${r.hours < 1 ? 'minutes' : 'hours'} with your music.</div><p class="rs-sub">${r.hours >= 24 ? `That’s ${Math.round(r.hours / 24)} full days. ` : ''}Most of it ${peakText(r.peak)}.</p>` },
    top && { c: top.colors?.base ? vivid(top.colors.base, .24, 1.4) : '#3b1f2b', h: `<div class="rs-eyebrow">Your top song</div><img class="rs-art" src="${artOf(top, 'full')}" alt=""><div class="rs-title">${esc(top.title)}</div><div class="rs-sub">${esc(top.artist)}</div><p class="rs-sub">Played ${r.topSongs[0].n} times</p>` },
    ta && { c: '#14304a', h: `<div class="rs-eyebrow">Your top artist</div><img class="rs-art round" src="${artistImg(ta.ts, ta.name)}" alt=""><div class="rs-title">${esc(ta.name)}</div><p class="rs-sub">${hrs(ta.hours)} hours together</p>` },
    { c: '#3a2410', h: `<div class="rs-eyebrow">On repeat</div>${r.topSongs.slice(0, 5).map((x, i) => `<div class="rs-row"><span>${i + 1}</span><img src="${artOf(x.t)}" alt=""><span><b>${esc(x.t.title)}</b><em>${esc(x.t.artist)}</em></span></div>`).join('')}` },
    { c: '#12342c', h: `<div class="rs-eyebrow">Replay ${r.year}</div><div class="rs-grid"><div><span>Hours</span><b>${hrs(r.hours)}</b></div><div><span>Songs</span><b>${r.songs}</b></div><div><span>Artists</span><b>${r.artists}</b></div><div><span>Top genre</span><b>${esc(r.topGenre || '—')}</b></div></div>${navigator.share ? '<button class="rs-share" data-rs="share">Share</button>' : ''}` },
  ].filter(Boolean);
  const el = document.createElement('div'); el.className = 'rs'; el.setAttribute('role', 'dialog');
  el.innerHTML = `<div class="rs-bars">${cards.map(() => '<i><b></b></i>').join('')}</div><button class="rs-x" data-rs="close" aria-label="Close">${icon('x')}</button><div class="rs-card"></div>`;
  document.body.appendChild(el);
  let i = 0, timer;
  const show = k => {
    i = k; if (i >= cards.length) return close(); if (i < 0) i = 0;
    el.style.background = cards[i].c; const card = el.querySelector('.rs-card'); card.innerHTML = cards[i].h; card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
    el.querySelectorAll('.rs-bars i').forEach((b, j) => { b.className = j < i ? 'done' : j === i ? 'cur' : ''; });
    clearTimeout(timer); timer = setTimeout(() => show(i + 1), 6500); haptic();
  };
  const close = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-rs]');
    if (b?.dataset.rs === 'close') return close();
    if (b?.dataset.rs === 'share') { clearTimeout(timer); return navigator.share({ title: `My Fof Music Replay ${r.year}`, text: `${hrs(r.hours)} hours of music in ${r.year}. Top song: ${top?.title || ''} by ${top?.artist || ''}. Top artist: ${ta?.name || ''}.` }).catch(() => {}); }
    show(e.clientX < innerWidth / 3 ? i - 1 : i + 1);
  });
  show(0);
}

/* =====================================================================
   Sound (equalizer, played by the iPhone app's player)
   ===================================================================== */
const EQ_PRESETS = { off: [0, 0, 0, 0, 0], bass: [6, 4, 0, 0, 0], lessbass: [-6, -3, 0, 0, 0], vocal: [-2, -1, 3, 3, 1], treble: [0, 0, 0, 3, 6], loud: [5, 2, 0, 2, 4], night: [2, 1, 0, -2, -4], spoken: [-4, -2, 3, 3, 0] };
const EQ_NAMES = { off: 'Off', bass: 'Bass Booster', lessbass: 'Bass Reducer', vocal: 'Vocal Booster', treble: 'Treble Booster', loud: 'Loudness', night: 'Late Night', spoken: 'Spoken Word', custom: 'Custom' };
const EQ_BANDS = ['60', '250', '1K', '4K', '12K'];
function applyEQ() { if (NATIVE) NATIVE.setEQ({ gains: S.settings.eqGains || [0, 0, 0, 0, 0] }).catch(() => {}); }
function setEQ(k) {
  S.settings.eq = k; if (EQ_PRESETS[k]) S.settings.eqGains = [...EQ_PRESETS[k]];
  applyEQ(); saveSettings(); haptic();
  if ($('#eq-sheet')) eqSheet();
}
function eqSheet() {
  const g = S.settings.eqGains || [0, 0, 0, 0, 0];
  sheet(`<div id="eq-sheet"><h2>Sound</h2>${NATIVE ? '' : '<p class="muted eq-note">The equalizer plays through the iPhone app. Your choice is saved and used there.</p>'}
    <div class="settings-group eq-presets">${Object.keys(EQ_PRESETS).map(k => `<button class="set-row" data-action="eq-preset" data-id="${k}"><span>${EQ_NAMES[k]}</span>${S.settings.eq === k ? icon('check', 'eq-check') : ''}</button>`).join('')}</div>
    <div class="eq-sliders">${g.map((v, i) => `<label class="eq-band"><span class="eq-db">${v > 0 ? '+' : ''}${v}</span><input type="range" min="-12" max="12" step="1" value="${v}" data-band="${i}" aria-label="${EQ_BANDS[i]} hertz"><span class="eq-hz">${EQ_BANDS[i]}</span></label>`).join('')}</div>
    <div class="actions"><button class="btn primary" data-close>Done</button></div></div>`, el => {
    el.querySelectorAll('[data-band]').forEach(r => r.addEventListener('input', () => {
      const gains = [...(S.settings.eqGains || [0, 0, 0, 0, 0])]; gains[+r.dataset.band] = +r.value;
      S.settings.eqGains = gains; S.settings.eq = Object.keys(EQ_PRESETS).find(k => EQ_PRESETS[k].every((x, i) => x === gains[i])) || 'custom';
      r.parentElement.querySelector('.eq-db').textContent = (r.value > 0 ? '+' : '') + r.value;
      el.querySelectorAll('.eq-check').forEach(c => c.remove());
      applyEQ(); clearTimeout(r._t); r._t = setTimeout(saveSettings, 400);
    }));
  });
}

/* =====================================================================
   More by this artist (player button + tap the artist's name)
   ===================================================================== */
function artistMore(t, { sheetMode = false } = {}) {
  const names = artistCredits(t.artist).filter(n => n && !/^unknown/i.test(n)).slice(0, sheetMode ? 1 : 3);
  if (!names.length) return '<div class="am-empty">No artist info for this song.</div>';
  const blocks = names.map(name => {
    const all = groups('creditedArtist').get(name) || [];
    const others = all.filter(x => x.id !== t.id).sort((a, b) => (b.plays || 0) - (a.plays || 0) || (b.liked - a.liked) || byAdded(a, b));
    const shown = others.slice(0, sheetMode ? 5 : 10);
    const key = listKey(others.map(x => x.id), name);
    return `<section class="am-block"><div class="am-head"><img class="am-av" src="${artistImg(all, name)}" alt=""><div class="am-name"><span>More by</span><b class="ellipsis">${esc(name)}</b></div>
        ${others.length ? `<button class="am-play" data-play-list="${key}" data-i="0" aria-label="Play all by ${esc(name)}">${icon('play')}</button>` : ''}</div>
      ${shown.length ? `<div class="am-list">${shown.map((x, i) => `<div class="am-row${current()?.id === x.id ? ' playing' : ''}" data-play-list="${key}" data-i="${i}"><img loading="lazy" src="${artOf(x)}" alt=""><span class="am-main"><b class="ellipsis">${esc(x.title)}</b><em class="ellipsis">${esc(x.album || x.artist)}${x.plays ? ` · ${x.plays} play${x.plays === 1 ? '' : 's'}` : ''}</em></span></div>`).join('')}</div>`
        : `<p class="am-empty">This is the only ${esc(name)} song in your library.</p>`}
      ${sheetMode ? '' : `<div class="am-dz" data-artist="${esc(name)}"></div>`}
      <button class="am-link" data-action="go-artist" data-name="${esc(name)}">${others.length > shown.length ? `See all ${others.length + 1} songs from ${esc(name)}` : `Go to ${esc(name)}`}${icon('back', 'chev')}</button></section>`;
  }).join('');
  const rel = sheetMode ? [] : [...relatedArtists(names)].filter(a => !names.includes(a)).map(a => [a, groups('artist').get(a)]).filter(x => x[1]).slice(0, 10);
  return blocks + (rel.length ? `<section class="am-block"><div class="am-sub">Similar artists</div><div class="am-rel">${rel.map(([a, x]) => `<button class="am-rel-item" data-action="go-artist" data-name="${esc(a)}"><img loading="lazy" src="${artistImg(x, a)}" alt=""><span class="ellipsis">${esc(a)}</span></button>`).join('')}</div></section>` : '');
}
function artistSheet() {
  const t = current(); if (!t || t.ext) return;
  sheet(`<div class="am-sheet">${artistMore(t, { sheetMode: true })}</div>`);
}

/** "Not in your library yet": the artist's popular songs you don't have, with 30-second previews. */
const nrm = x => (x || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)|\[.*?\]|feat\..*$|ft\..*$/g, '').replace(/[^a-z0-9]/g, '');
async function fillDiscover() {
  for (const box of $$('.am-dz')) {
    const name = box.dataset.artist; if (box.dataset.done) continue; box.dataset.done = '1';
    let top = []; try { top = await artistTop(name); } catch {}
    if (!box.isConnected) return;
    const have = new Set(visible().map(t => nrm(t.title)));
    const missing = top.filter(r => !have.has(nrm(r.title))).filter((r, i, a) => a.findIndex(x => nrm(x.title) === nrm(r.title)) === i).slice(0, 6);
    if (!missing.length) continue;
    box.innerHTML = `<div class="am-sub">Not in your library yet</div><div class="am-list">${missing.map(r => `<div class="am-row am-dz-row" data-action="dz-preview" data-url="${esc(r.preview)}" data-title="${esc(r.title)}"><span class="am-dz-art"><img loading="lazy" src="${esc(r.art)}" alt=""><span class="am-dz-btn">${icon(DZ.url === r.preview ? 'pause' : 'play')}</span></span><span class="am-main"><b class="ellipsis">${esc(r.title)}</b><em class="ellipsis">${esc(r.album)} · Preview</em></span>${wantBtn({ ...r, artist: name })}<button class="am-yt" data-action="yt" data-q="${esc(name + ' ' + r.title)}" aria-label="Watch on YouTube"><svg viewBox="0 0 28 20"><rect width="28" height="20" rx="5.5" fill="#ff0033"/><path d="M11.2 6v8l7-4z" fill="#fff"/></svg></button></div>`).join('')}</div>`;
  }
}
const DZ = { el: null, url: '', resume: false };
function dzStop(resume = true) {
  if (DZ.el) { DZ.el.pause(); DZ.el = null; }
  DZ.url = ''; $$('.am-dz-row').forEach(r => { r.classList.remove('previewing'); const b = r.querySelector('.am-dz-btn'); if (b) b.innerHTML = icon('play'); });
  if (resume && DZ.resume) engine.el.play();
  DZ.resume = false;
}
function dzPreview(row) {
  const url = row.dataset.url;
  if (DZ.url === url) return dzStop();
  const wasPlaying = DZ.el ? DZ.resume : !engine.el.paused;
  dzStop(false); DZ.resume = wasPlaying;
  if (!engine.el.paused) engine.el.pause();
  DZ.el = new Audio(url); DZ.url = url;
  row.classList.add('previewing'); row.querySelector('.am-dz-btn').innerHTML = icon('pause');
  DZ.el.addEventListener('ended', () => dzStop());
  DZ.el.addEventListener('error', () => { toast('Couldn’t play this preview'); dzStop(); });
  DZ.el.play().catch(() => dzStop());
}
for (const el of engine.els) el.addEventListener('play', () => { if (DZ.el) dzStop(false); });

/* =====================================================================
   Discover (Add Music): suggestions from your library, and search any song
   ===================================================================== */
const DC = { q: '', type: 'track', results: null, sugg: null, loading: false, n: 0 };

const CHECK = { lists: [], selected: '', filter: 'missing', query: '', page: 0 };
let checkPulls = 0, checkAuthPending = true, checkLibraryFailed = false;
const checkLoading = () => checkPulls || (checkAuthPending && cloud.cloudConfigured());
const checkLabels = { all: 'All', owned: 'In FOF Music', missing: 'Missing', review: 'Review Version' };
const checkTitle = title => fold((title || '').replace(/\s*[\[(](?:feat\.?|ft\.?|featuring)\s+[^\])]+[\])]/gi, '').replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, ''));
const checkBase = title => checkTitle((title || '').replace(/\s*[-–—(\[]\s*[^)\]]*\b(?:live|remix|acoustic|remaster(?:ed)?|instrumental|radio edit|sped up|slowed|demo|version)\b.*$/i, '').replace(/\s+(?:live|remix|acoustic|instrumental|radio edit|sped up|slowed|demo)$/i, ''));
const checkSeconds = value => {
  const text = String(value ?? '').trim();
  if (/^\d+(?::\d{2}){1,2}$/.test(text)) return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  return Math.max(0, Number(text) || 0);
};

function checkCsv(text) {
  const rows = [[]];
  let value = '', quoted = false;
  const delimiter = text.split(/\r?\n/)[0].includes('\t') ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { value += '"'; i++; }
    else if (char === '"' && (quoted || !value)) quoted = !quoted;
    else if (!quoted && (char === delimiter || char === '\n' || char === '\r')) {
      rows.at(-1).push(value); value = '';
      if (char !== delimiter) { rows.push([]); if (char === '\r' && text[i + 1] === '\n') i++; }
    } else value += char;
  }
  rows.at(-1).push(value);
  return rows;
}

function checkRows(rows) {
  const header = rows.shift()?.map(fold) || [];
  const col = (...names) => header.findIndex(value => names.includes(value));
  const title = col('song', 'title', 'name', 'track name');
  if (title < 0) return [];
  return rows.filter(row => row[title]?.trim()).map(row => ({
    title: row[title].trim(), artist: row[col('artist', 'artists', 'artist name')]?.trim() || '',
    duration: checkSeconds(row[col('duration', 'duration seconds', 'time')]),
    id: row[col('id', 'track id')] || '', source: row[col('apple music playlists', 'apple music playlist', 'playlist', 'source playlist')] || '',
    url: row[col('apple music track url', 'url', 'track url', 'apple music track')] || '',
  }));
}

// Read the small set of XML parts needed for a normal, unencrypted .xlsx file.
async function checkSpreadsheet(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw Error('Invalid spreadsheet');
  const files = new Map(), decoder = new TextDecoder();
  let pos = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw Error('Invalid spreadsheet index');
    const nameLength = view.getUint16(pos + 28, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    files.set(name, { method: view.getUint16(pos + 10, true), size: view.getUint32(pos + 20, true), full: view.getUint32(pos + 24, true), offset: view.getUint32(pos + 42, true) });
    pos += 46 + nameLength + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
  }
  async function xml(name) {
    const part = files.get(name);
    if (!part) return null;
    if (part.full > 12000000 || ![0, 8].includes(part.method)) throw Error('Unsupported spreadsheet part');
    const p = part.offset;
    const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
    const data = bytes.subarray(start, start + part.size);
    const stream = part.method === 8 ? new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')) : null;
    let raw = stream ? '' : decoder.decode(data);
    if (stream) {
      const reader = stream.getReader();
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 12000000) { await reader.cancel(); throw Error('Spreadsheet part too large'); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    }
    return new DOMParser().parseFromString(raw, 'application/xml');
  }
  const book = await xml('xl/workbook.xml');
  const sheets = [...(book?.getElementsByTagName('sheet') || [])];
  const sheet = sheets.find(item => item.getAttribute('name') === 'Missing Songs') || sheets[0];
  const rels = await xml('xl/_rels/workbook.xml.rels');
  const target = [...(rels?.getElementsByTagName('Relationship') || [])].find(r => r.getAttribute('Id') === sheet?.getAttribute('r:id'))?.getAttribute('Target');
  if (!target) return [];
  const sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  const doc = await xml(sheetPath);
  const strings = [...((await xml('xl/sharedStrings.xml'))?.getElementsByTagName('si') || [])].map(el => [...el.getElementsByTagName('t')].map(t => t.textContent).join(''));
  const rows = [...(doc?.getElementsByTagName('row') || [])].map(row => {
    const values = [];
    for (const cell of row.getElementsByTagName('c')) {
      const letters = cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0];
      if (!letters) continue;
      const col = [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      if (col > 100) continue;
      const value = cell.getElementsByTagName('v')[0]?.textContent || '';
      const type = cell.getAttribute('t');
      values[col] = type === 's' ? strings[Number(value)] || '' : type === 'inlineStr' ? [...cell.getElementsByTagName('t')].map(x => x.textContent).join('') : value;
    }
    return values;
  });
  const linkDoc = await xml(sheetPath.replace(/([^/]+)$/, '_rels/$1.rels'));
  const linkMap = new Map([...(linkDoc?.getElementsByTagName('Relationship') || [])].map(el => [el.getAttribute('Id'), el.getAttribute('Target')]));
  const linkCol = rows[0]?.findIndex(v => fold(v) === 'apple music track');
  if (linkCol >= 0) {
    for (const link of doc.getElementsByTagName('hyperlink')) {
      const address = link.getAttribute('ref')?.match(/^([A-Z]+)(\d+)$/);
      if (!address) continue;
      const col = [...address[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
      if (col === linkCol && rows[Number(address[2]) - 1]) rows[Number(address[2]) - 1][col] = linkMap.get(link.getAttribute('r:id')) || '';
    }
  }
  return checkRows(rows);
}

function checkText(text, name) {
  const table = checkRows(checkCsv(text.replace(/^\uFEFF/, '')));
  if (table.length) return [{ name, items: table }];
  const exported = parsePlaylists(text, name);
  if (exported.length) return exported;
  const items = text.split(/\r?\n/).map(line => {
    const split = line.indexOf(' - ');
    return split < 0 ? null : { artist: line.slice(0, split).trim(), title: line.slice(split + 3).trim() };
  }).filter(item => item?.title && item.artist);
  return items.length ? [{ name, items }] : [];
}

function checkResults(list) {
  const titles = new Map(), versions = new Map();
  for (const track of S.tracks.values()) {
    const title = checkTitle(track.title), base = checkBase(track.title);
    if (!title) continue;
    if (!titles.has(title)) titles.set(title, []);
    titles.get(title).push(track);
    if (base && base !== title) {
      if (!versions.has(base)) versions.set(base, []);
      versions.get(base).push(track);
    }
  }
  return list.items.map((item, i) => {
    const choice = list.decisions?.[i];
    if (choice === 'missing') return { item, i, status: 'missing' };
    if (choice && S.tracks.has(choice)) return { item, i, status: 'owned', match: S.tracks.get(choice) };
    const title = checkTitle(item.title), base = checkBase(item.title);
    const wanted = artistCredits(item.artist).map(fold);
    let review;
    for (const track of new Set([...(titles.get(title) || []), ...(base !== title ? titles.get(base) || [] : []), ...(versions.get(base) || [])])) {
      const artists = artistCredits(track.artist).map(fold);
      if (wanted.length && artists.length && !wanted.some(artist => artists.includes(artist))) continue;
      const exact = title === checkTitle(track.title);
      const distance = item.duration && track.duration ? Math.abs(item.duration - track.duration) : 0;
      if (exact && wanted.length && artists.length && distance <= 8 && ((item.duration && track.duration) || wanted[0] === artists[0])) return { item, i, status: 'owned', match: track };
      if (!review || exact) review = track;
    }
    return { item, i, status: review ? 'review' : 'missing', match: review };
  });
}

const checkSelected = () => CHECK.lists.find(list => list.id === CHECK.selected) || CHECK.lists[0];
function resetCheck() { CHECK.filter = 'missing'; CHECK.query = ''; CHECK.page = 0; }
async function saveChecks() { await kv.set('playlistChecks', CHECK.lists); render(); }
async function addChecks(lists) {
  const valid = lists.filter(list => list.items.length);
  if (!valid.length) return toast('No tracks found. Try a playlist export, CSV, or Artist - Song lines.');
  const added = valid.map(list => ({ ...list, id: uid(), decisions: {} }));
  CHECK.lists = [...added, ...CHECK.lists]; CHECK.selected = added[0].id; resetCheck();
  await saveChecks();
}
function checkPlaylistView() {
  const list = checkSelected();
  const loading = checkLoading();
  const head = '<div class="page-head"><h1>Add Music</h1></div>' + addTabs('check');
  const form = '<div class="row-actions"><button class="btn" data-action="check-pick">Choose playlist or tracker file</button><input id="check-file" type="file" accept=".xlsx,.csv,.txt,.xml,.m3u,.m3u8,.tsv" hidden multiple><button class="btn" data-action="check-paste">Paste track list</button></div>';
  if (!list) return head + form + '<p class="note">Compare Apple Music exports, your Excel tracker, or a pasted list with the songs in your library.</p>';
  const all = loading ? [] : checkResults(list);
  const query = fold(CHECK.query);
  const filtered = all.filter(r => (CHECK.filter === 'all' || r.status === CHECK.filter) && (!query || fold([r.item.title, r.item.artist, r.item.source].join(' ')).includes(query)));
  const page = Math.min(CHECK.page, Math.max(0, Math.ceil(filtered.length / 100) - 1));
  const shown = filtered.slice(page * 100, (page + 1) * 100);
  const results = shown.map(({ item, status, match, i }) => {
    const key = status === 'owned' && match ? listKey([match.id], list.name) : '';
    return `<div class="dc-row" style="gap:10px"><div class="dc-main" style="min-width:0"><b class="ellipsis">${esc(item.title)}</b><em class="ellipsis">${esc([item.artist, item.duration ? fmt(item.duration) : '', item.source].filter(Boolean).join(' · '))}</em>
    ${status === 'review' ? `<span class="muted">Possible match · ${esc(match.title)} · ${esc(match.artist)} · ${match.duration ? fmt(match.duration) : 'Unknown duration'}</span>` : ''}</div>
    <div><span class="dc-have">${checkLabels[status]}</span>
    ${key ? `<button class="btn small" data-play-list="${key}" data-i="0">Play</button>` : ''}
    ${status === 'review' ? `<button class="btn small" data-action="check-decision" data-i="${i}">Decide</button>` : ''}
    ${list.decisions?.[i] ? `<button class="btn small" data-action="check-reset" data-i="${i}">Reset</button>` : ''}</div></div>`;
  }).join('');
  return head + form + `<section class="section"><label for="check-list">Saved lists</label><select id="check-list" class="input">${CHECK.lists.map(l => `<option value="${esc(l.id)}" ${l.id === list.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
  ${loading ? '<p class="note" role="status">Checking your synced library…</p>' : `<p class="note">${checkLibraryFailed ? 'Sync failed. Results use the available library. ' : ''}Checked against ${count(S.tracks.size)}. Saved lists stay on this device.</p>
  <div class="chips">${Object.entries(checkLabels).map(([key, label]) => `<button class="chip ${CHECK.filter === key ? 'on' : ''}" aria-pressed="${CHECK.filter === key}" data-action="check-filter" data-filter="${key}">${label} · ${key === 'all' ? all.length : all.filter(row => row.status === key).length}</button>`).join('')}</div>
  <input id="check-query" class="input full" aria-label="Filter playlist check" placeholder="Filter song, artist or playlist" value="${esc(CHECK.query)}">
  <div class="row-actions"><button class="btn small" data-action="check-export">Export missing CSV</button><button class="btn small" data-action="check-copy">Copy missing batch</button></div>
  <div class="dc-list">${results || '<p class="note">No songs in this view.</p>'}</div>
  ${filtered.length > 100 ? `<div class="row-actions"><button class="btn small" data-action="check-page" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>Previous</button><span>Page ${page + 1} of ${Math.ceil(filtered.length / 100)}</span><button class="btn small" data-action="check-page" data-page="${page + 1}" ${page + 1 >= Math.ceil(filtered.length / 100) ? 'disabled' : ''}>Next</button></div>` : ''}`}</section>`;
}

async function checkExport(copy) {
  const list = checkSelected();
  if (!list || checkLoading()) return;
  const rows = checkResults(list).filter(row => row.status === 'missing').map(row => row.item);
  if (!rows.length) return toast('No missing tracks to export.');
  if (copy) {
    const batch = CHECK.filter === 'missing' && !CHECK.query ? Math.min(CHECK.page, Math.ceil(rows.length / 100) - 1) : 0;
    const selected = rows.slice(batch * 100, (batch + 1) * 100);
    const text = selected.map(t => [t.artist, t.title].filter(Boolean).join(' - ')).join('\n');
    try { await navigator.clipboard.writeText(text); toast(`Copied ${selected.length} missing tracks`); }
    catch { sheet('<h2>Missing tracks</h2><textarea class="input full" readonly rows="10">' + esc(text) + '</textarea>'); }
    return;
  }
  const csv = value => '"' + String(value || '').replace(/^[=+\-@\t\r]/, "'$&").replaceAll('"', '""') + '"';
  const text = [['ID', 'Song', 'Artist', 'Duration', 'Source playlist', 'Track URL'], ...rows.map(t => [t.id, t.title, t.artist, t.duration, t.source, t.url])].map(row => row.map(csv).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'FOF-Music-Missing.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const addTabs = on => `<div class="seg q-seg add-tabs"><a class="${on === 'want' ? 'on' : ''}" href="#/import/want">${wantTabLabel()}</a><a class="${on === 'check' ? 'on' : ''}" href="#/import/check">Playlist Check</a><a class="${on === 'files' ? 'on' : ''}" href="#/import/files">Add files</a></div><a class="add-new-link" href="#/new">${icon('new')}<span>Find new songs in <b>New</b></span>${icon('back', 'chev')}</a>`;
function ownedKeys() {
  if (DC.owned && DC.ownedAt === S.tracks.size) return DC.owned;
  const m = new Set();
  for (const t of visible()) { const ti = nrm(t.title); m.add(ti + '|' + nrm(mainArtist(t.artist))); for (const a of artistCredits(t.artist)) m.add(ti + '|' + nrm(a)); }
  DC.owned = m; DC.ownedAt = S.tracks.size; return m;
}
const owns = (title, artist) => ownedKeys().has(nrm(title) + '|' + nrm(artist));
const dzTrack = r => ({ id: r.id, title: r.title_short || r.title, artist: r.artist?.name || '', album: r.album?.title || '', art: r.album?.cover_medium || r.album?.cover || '', preview: r.preview || '' });
/** One song row: preview on the cover, YouTube button, or "In library". */
function dcRow(r) {
  const have = owns(r.title, r.artist);
  return `<div class="dc-row${have ? '' : ' am-dz-row'}" ${have || !r.preview ? '' : `data-action="dz-preview" data-url="${esc(r.preview)}"`}>
    <span class="am-dz-art dc-art"><img loading="lazy" src="${esc(r.art)}" alt="">${have || !r.preview ? '' : `<span class="am-dz-btn">${icon(DZ.url === r.preview ? 'pause' : 'play')}</span>`}</span>
    <span class="dc-main"><b class="ellipsis">${esc(r.title)}</b><em class="ellipsis">${esc(r.artist)}${r.album ? ' · ' + esc(r.album) : ''}</em></span>
    ${have ? '<span class="dc-have">In library</span>' : `${wantBtn(r)}<button class="am-yt" data-action="yt" data-q="${esc(r.artist + ' ' + r.title)}" aria-label="Watch on YouTube"><svg viewBox="0 0 28 20"><rect width="28" height="20" rx="5.5" fill="#ff0033"/><path d="M11.2 6v8l7-4z" fill="#fff"/></svg></button>`}</div>`;
}
function dcCard(r) {
  return `<div class="dc-card am-dz-row" data-action="dz-preview" data-url="${esc(r.preview)}"><span class="am-dz-art dc-cover"><img loading="lazy" src="${esc(r.art).replace('/250x250-', '/500x500-')}" alt=""><span class="am-dz-btn">${icon(DZ.url === r.preview ? 'pause' : 'play')}</span></span>
    <div class="dc-card-t"><span class="dc-main"><b class="ellipsis">${esc(r.title)}</b><em class="ellipsis">${esc(r.artist)}</em></span>${wantBtn(r)}<button class="am-yt" data-action="yt" data-q="${esc(r.artist + ' ' + r.title)}" aria-label="Watch on YouTube"><svg viewBox="0 0 28 20"><rect width="28" height="20" rx="5.5" fill="#ff0033"/><path d="M11.2 6v8l7-4z" fill="#fff"/></svg></button></div></div>`;
}
async function dzArtistId(name) {
  DC.aid = DC.aid || new Map(); if (DC.aid.has(name)) return DC.aid.get(name);
  const s = await dz('search/artist?limit=5&q=' + encodeURIComponent(name)); const w = nrm(name);
  const a = (s?.data || []).find(x => nrm(x.name) === w); DC.aid.set(name, a?.id || 0); return a?.id || 0;
}
const DZ_GENRES = [[/afro|african|amapiano|highlife|coupe|zouk|ndombolo|bongo/i, 2], [/hip.?hop|rap|drill|trap/i, 116], [/r&b|rnb|soul/i, 165], [/pop/i, 132], [/reggae|dancehall/i, 144], [/dance|house|edm|electro/i, 113], [/latin|reggaeton/i, 197], [/rock/i, 152], [/jazz/i, 129], [/gospel|christian/i, 173]];
async function loadSuggestions() {
  const all = visible().filter(t => (t.category || 'Music') === 'Music');
  const score = new Map(); for (const t of all) { const a = mainArtist(t.artist); if (/^unknown/i.test(a)) continue; score.set(a, (score.get(a) || 0) + (t.plays || 0) * 2 + (t.liked ? 6 : 0) + 1); }
  const fav = [...score].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const out = { because: [], loved: [], genre: null };
  const seen = new Set(); const keep = r => { const k = nrm(r.title) + '|' + nrm(r.artist); if (seen.has(k) || owns(r.title, r.artist) || !r.preview) return false; seen.add(k); return true; };
  // because you play your top artists: their related artists' biggest songs
  for (const name of fav.slice(0, 3)) {
    const id = await dzArtistId(name); if (!id) continue;
    const rel = (await dz(`artist/${id}/related?limit=8`))?.data || [];
    const tops = await Promise.all(rel.slice(0, 8).map(a => dz(`artist/${a.id}/top?limit=3`).then(j => (j?.data || []).map(r => ({ ...dzTrack(r), artist: r.artist?.name || a.name })))));
    const picks = tops.map(t => t.filter(keep)[0]).filter(Boolean);
    if (picks.length >= 3) out.because.push({ name, items: picks });
    if (out.because.length >= 2) break;
  }
  // more from the artists you play most
  const lovedTops = await Promise.all(fav.slice(0, 8).map(async name => { const id = await dzArtistId(name); if (!id) return []; return ((await dz(`artist/${id}/top?limit=10`))?.data || []).map(r => ({ ...dzTrack(r), artist: r.artist?.name || name })); }));
  for (const top of lovedTops) out.loved.push(...top.filter(keep).slice(0, 2));
  // the chart for your favorite genre
  const g = new Map(); for (const t of all) if (t.genre) g.set(t.genre, (g.get(t.genre) || 0) + 1 + (t.plays || 0));
  const topG = [...g].sort((a, b) => b[1] - a[1]).map(x => x[0]).find(x => DZ_GENRES.some(([re]) => re.test(x)));
  if (topG) { const gid = DZ_GENRES.find(([re]) => re.test(topG))[1]; const ch = ((await dz(`chart/${gid}/tracks?limit=40`))?.data || []).map(dzTrack).filter(keep).slice(0, 12); if (ch.length) out.genre = { name: topG, items: ch }; }
  return out;
}
/* ---------- the New tab: what's new for you, in one place ---------- */
function loadNew() {
  const here = () => S.route === 'new' && !DC.q;
  if (!DC.sugg && !DC.cacheTried) { DC.cacheTried = true; kv.get('discover', null).then(c => { if (c && Date.now() - c.at < 12 * 36e5 && !DC.sugg) { DC.sugg = c.v; if (here()) render(); } }); }
  if (!DC.fresh && !DC.loading && navigator.onLine) { DC.loading = true; loadSuggestions().then(x => { DC.sugg = x; DC.fresh = true; kv.set('discover', { at: Date.now(), v: x }); }).catch(e => { console.warn('discover', e); DC.sugg = DC.sugg || { because: [], loved: [], genre: null }; }).finally(() => { DC.loading = false; if (here()) render(); }); }
  if (!DC.rel && !DC.relLoading && navigator.onLine) {
    DC.relLoading = true;
    kv.get('releases', null).then(c => { if (c && !DC.rel) { DC.rel = c.v; if (here()) render(); } });
    kv.get('newsongs', null).then(c => { if (c && !DC.newSongs) { DC.newSongs = c.v; if (here()) render(); } });
    newReleases().then(async x => {
      DC.rel = x; kv.set('releases', { at: Date.now(), v: x });
      // the strongest song from each new release
      const albums = await Promise.all(x.slice(0, 12).map(a => dz('album/' + a.id).catch(() => null)));
      DC.newSongs = albums.filter(Boolean).flatMap(al => { const ts = (al.tracks?.data || []).filter(r => r.preview); const best = ts.slice().sort((p, q) => (q.rank || 0) - (p.rank || 0))[0]; return best ? [{ ...dzTrack(best), artist: best.artist?.name || al.artist?.name || '', album: al.title, art: al.cover_medium, date: al.release_date }] : []; });
      kv.set('newsongs', { at: Date.now(), v: DC.newSongs });
      if (here()) render();
    }).catch(() => {});
  }
}
const relKind = a => a.type === 'single' ? 'NEW SINGLE' : a.type === 'ep' ? 'NEW EP' : 'NEW ALBUM';
function heroRelease(a) {
  const ts = groups('creditedArtist').get(a.artist) || [], plays = ts.reduce((n, t) => n + (t.plays || 0), 0);
  const big = (a.art || '').replace('/250x250-', '/1000x1000-');
  return `<a class="nw-hero" href="#/dz-album/${a.id}"><div class="nw-eyebrow">${relKind(a)} · ${esc(relDate(a.date))}</div><div class="nw-title ellipsis">${esc(a.title)}</div><div class="nw-sub ellipsis">${esc(a.artist)}</div>
    <div class="nw-img"><img loading="lazy" src="${esc(big)}" alt=""><div class="nw-note">${plays ? `You’ve played ${esc(a.artist)} ${plays} time${plays === 1 ? '' : 's'}.` : `From ${esc(a.artist)}, an artist in your library.`}</div></div></a>`;
}
function updatedPlaylists() {
  const wk = Date.now() - 7 * DAY, out = [];
  for (const p of S.playlists.values()) { const n = (p.added || []).filter(x => !x.removed && x.at > wk && p.tracks.includes(x.id)).length; if (n) out.push({ href: 'playlist/' + p.id, title: p.name, sub: `${n} new this week`, tracks: p.tracks.map(id => T(id)).filter(Boolean), img: S.plCovers.get(p.id) }); }
  for (const k of ['on-repeat', 'recently-loved', 'drive', 'workout']) { const d = SMART[k]; const ts = d?.get(musicOnly()) || []; if (ts.length >= 5) out.push({ href: 'smart/' + k, title: d.title, sub: 'Updated today', tracks: ts }); }
  return out;
}
VIEWS.new = () => {
  loadNew();
  const sg = DC.sugg;
  const search = `<label class="search-box dc-search">${icon('search')}<input id="dc-q" class="input" type="search" placeholder="Search any song, artist or album" value="${esc(DC.q)}" autocomplete="off" enterkeyhint="search"></label>`;
  if (DC.q) return `<div class="page-head"><h1>New</h1></div>${search}<div class="seg q-seg">${[['track', 'Songs'], ['artist', 'Artists'], ['album', 'Albums']].map(([k, l]) => `<button class="${DC.type === k ? 'on' : ''}" data-action="dc-type" data-id="${k}">${l}</button>`).join('')}</div><div id="dc-body">${dcResults()}</div>`;
  const songs = (DC.newSongs || []).filter(r => r.preview);
  const upd = updatedPlaylists();
  const loading = !sg && !DC.rel;
  return `<div class="page-head"><h1>New</h1></div>${search}
    ${DC.rel?.length ? `<div class="nw-heroes">${DC.rel.slice(0, 8).map(heroRelease).join('')}</div>` : ''}
    ${songs.length ? `<section class="section"><div class="section-head"><h2>Best New Songs for You</h2></div><div class="nw-grid">${songs.map(dcRow).join('')}</div></section>` : ''}
    ${upd.length ? `<section class="section"><div class="section-head"><h2>Updated Playlists</h2></div><div class="shelf">${upd.map(collCard).join('')}</div></section>` : ''}
    ${loading ? `<div class="pod-loading">${navigator.onLine ? 'Finding what’s new for you…' : 'Connect to the internet to see what’s new.'}</div>` : ''}
    ${sg ? `${sg.because.map(b => `<section class="section"><div class="section-head"><h2>Because you play ${esc(b.name)}</h2></div><div class="shelf dc-shelf">${b.items.map(dcCard).join('')}</div></section>`).join('')}
      ${sg.loved.length ? `<section class="section"><div class="section-head"><h2>More from artists you love</h2></div><div class="nw-grid">${sg.loved.slice(0, 12).map(dcRow).join('')}</div></section>` : ''}
      ${sg.genre ? `<section class="section"><div class="section-head"><h2>Popular in ${esc(sg.genre.name)}</h2></div><div class="shelf dc-shelf">${sg.genre.items.map(dcCard).join('')}</div></section>` : ''}` : ''}`;
};
function dcResults() {
  const r = DC.results;
  if (!r) return '<div class="pod-loading">Searching…</div>';
  if (!r.length) return `<p class="muted pod-none">Nothing found for “${esc(DC.q)}”.</p>`;
  if (DC.type === 'track') return `<div class="dc-list">${r.map(dcRow).join('')}</div>`;
  if (DC.type === 'artist') return `<div class="dc-list">${r.map(a => { const have = (groups('creditedArtist').get(a.name) || []).length; return `<a class="dc-row" href="#/dz-artist/${a.id}"><img class="dc-art round" loading="lazy" src="${esc(a.picture_medium || '')}" alt=""><span class="dc-main"><b class="ellipsis">${esc(a.name)}</b><em>${have ? `${count(have)} in your library` : 'Not in your library yet'}</em></span>${icon('back', 'chev')}</a>`; }).join('')}</div>`;
  return `<div class="dc-list">${r.map(a => `<a class="dc-row" href="#/dz-album/${a.id}"><img class="dc-art" loading="lazy" src="${esc(a.cover_medium || '')}" alt=""><span class="dc-main"><b class="ellipsis">${esc(a.title)}</b><em class="ellipsis">${esc(a.artist?.name || '')} · ${a.nb_tracks || ''} songs</em></span>${icon('back', 'chev')}</a>`).join('')}</div>`;
}
async function dcSearch() {
  const q = DC.q.trim(), my = ++DC.n; if (!q) return;
  const path = DC.type === 'track' ? 'search' : 'search/' + DC.type;
  const j = await dz(`${path}?limit=30&q=${encodeURIComponent(q)}`); if (my !== DC.n) return;
  DC.results = DC.type === 'track' ? (j?.data || []).map(dzTrack) : (j?.data || []);
  const b = $('#dc-body'); if (b) b.innerHTML = dcResults();
}
function bindDiscover() {
  const i = $('#dc-q'); if (!i || i._b) return; i._b = true;
  i.addEventListener('input', () => {
    const had = !!DC.q; DC.q = i.value; DC.results = null; clearTimeout(i._t);
    if (!DC.q.trim() || !had) { const pos = i.selectionStart; render(); const g = $('#dc-q'); g?.focus(); try { g.setSelectionRange(pos, pos); } catch {} }
    if (DC.q.trim()) i._t = setTimeout(dcSearch, 250);
  });
}
VIEWS['dz-artist'] = () => {
  const id = S.param; DC.art = DC.art || new Map();
  if (!DC.art.has(id)) { DC.art.set(id, null); Promise.all([dz('artist/' + id), dz(`artist/${id}/top?limit=50`)]).then(([a, t]) => { DC.art.set(id, { a, tracks: (t?.data || []).map(dzTrack) }); if (S.route === 'dz-artist') render(); }); }
  const d = DC.art.get(id);
  if (!d) return `${back()}<div class="pod-loading">Loading…</div>`;
  const missing = d.tracks.filter(r => !owns(r.title, r.artist)), have = d.tracks.length - missing.length;
  return `${back()}<div class="pod-head"><img class="round-img" src="${esc(d.a?.picture_big || '')}" alt=""><div><h1>${esc(d.a?.name || '')}</h1><div class="muted">${have ? `${have} of their top ${d.tracks.length} in your library` : 'None in your library yet'}</div>
      ${groups('creditedArtist').has(d.a?.name) ? `<div class="pod-head-actions"><a class="btn" href="#/artist/${encodeURIComponent(d.a.name)}">Your songs</a></div>` : ''}</div></div>
    <section class="section"><div class="section-head"><h2>Popular songs</h2></div><div class="dc-list">${d.tracks.map(dcRow).join('')}</div></section>`;
};
VIEWS['dz-album'] = () => {
  const id = S.param; DC.alb = DC.alb || new Map();
  if (!DC.alb.has(id)) { DC.alb.set(id, null); dz('album/' + id).then(a => { DC.alb.set(id, a); if (S.route === 'dz-album') render(); }); }
  const a = DC.alb.get(id);
  if (!a) return `${back()}<div class="pod-loading">Loading…</div>`;
  const tracks = (a.tracks?.data || []).map(r => ({ ...dzTrack(r), album: a.title, art: a.cover_medium }));
  return `${back()}<div class="pod-head"><img src="${esc(a.cover_big || '')}" alt=""><div><h1>${esc(a.title)}</h1><div class="muted">${esc(a.artist?.name || '')}${a.release_date ? ' · ' + a.release_date.slice(0, 4) : ''}</div></div></div>
    <section class="section"><div class="dc-list">${tracks.map(dcRow).join('')}</div></section>`;
};

/* =====================================================================
   Want list: songs you don't have yet, one tap to get them, and they check
   themselves off when the file arrives
   ===================================================================== */
const wantKey = (title, artist) => nrm(title) + '|' + nrm(artist);
const wants = () => S.want || (S.want = []);
const isWanted = (title, artist) => wants().some(w => !w.arrived && w.key === wantKey(title, artist));
function saveWant() { kv.set('want', S.want); queueStatePush(); }
function wantBtn(r) {
  const on = isWanted(r.title, r.artist);
  return `<button class="want-btn${on ? ' on' : ''}" data-action="want" data-w="${esc(JSON.stringify({ title: r.title, artist: r.artist, album: r.album || '', art: r.art || '', preview: r.preview || '' }))}" aria-label="${on ? 'Remove from Want list' : 'Add to Want list'}">${icon(on ? 'check' : 'plus')}</button>`;
}
function toggleWant(r) {
  const k = wantKey(r.title, r.artist), w = wants(), i = w.findIndex(x => x.key === k && !x.arrived);
  if (i >= 0) { w.splice(i, 1); toast('Removed from Want list'); }
  else { w.unshift({ ...r, key: k, at: Date.now() }); toast('Added to Want list'); haptic(); }
  saveWant();
  $$(`.want-btn[data-w]`).forEach(b => { try { const x = JSON.parse(b.dataset.w); const on = isWanted(x.title, x.artist); b.classList.toggle('on', on); b.innerHTML = icon(on ? 'check' : 'plus'); } catch {} });
  if (S.route === 'import' && S.param === 'want') render();
  updateAddTabs();
}
/** When a wanted song shows up in the library, check it off. */
function checkWants() {
  let n = 0;
  for (const w of wants()) if (!w.arrived && owns(w.title, w.artist)) { w.arrived = Date.now(); n++; }
  if (n) { S.wantNew = (S.wantNew || 0) + n; kv.set('wantNew', S.wantNew); saveWant(); if (S.route === 'home' || (S.route === 'import' && S.param === 'want')) render(); toast(`${count(n)} from your Want list ${n === 1 ? 'is' : 'are'} here`); }
}
function updateAddTabs() { const t = document.querySelector('.add-tabs a[href="#/import/want"]'); if (t) t.textContent = wantTabLabel(); }
const wantTabLabel = () => { const n = wants().filter(w => !w.arrived).length; return n ? `Want · ${n}` : 'Want'; };
function wantView() {
  const open = wants().filter(w => !w.arrived), got = wants().filter(w => w.arrived).sort((a, b) => b.arrived - a.arrived).slice(0, 30);
  if (S.wantNew) { S.wantNew = 0; kv.set('wantNew', 0); }
  const row = (w, done) => `<div class="dc-row${done || !w.preview ? '' : ' am-dz-row'}" ${done || !w.preview ? '' : `data-action="dz-preview" data-url="${esc(w.preview)}"`}>
      <span class="am-dz-art dc-art"><img loading="lazy" src="${esc(w.art)}" alt="">${done || !w.preview ? '' : `<span class="am-dz-btn">${icon('play')}</span>`}</span>
      <span class="dc-main"><b class="ellipsis">${esc(w.title)}</b><em class="ellipsis">${esc(w.artist)}${done ? '' : ' · ' + esc(wantAgo(w.at))}</em></span>
      ${done ? '<span class="dc-have">In library</span>' : `<button class="btn small get-btn" data-action="get" data-key="${esc(w.key)}">Get</button><button class="icon-btn small want-x" data-action="want-x" data-key="${esc(w.key)}" aria-label="Remove">${icon('x')}</button>`}</div>`;
  return `<div class="page-head"><div><h1>Add Music</h1></div></div>${addTabs('want')}
    ${open.length ? `<div class="row-actions want-actions"><button class="btn primary" data-action="get-all">${icon('download')}Get all</button>${navigator.share ? `<button class="btn" data-action="want-share">${icon('share')}Share list</button>` : ''}</div>
      <div class="dc-list">${open.map(w => row(w)).join('')}</div>`
    : `<div class="empty-state small"><h2>Your Want list is empty</h2><p>Tap + next to any song you don’t have, in Discover, search or the player, to save it here.</p></div>`}
    ${got.length ? `<section class="section"><div class="section-head"><h2>Arrived</h2></div><div class="dc-list">${got.map(w => row(w, true)).join('')}</div></section>` : ''}
    ${waysCard()}`;
}
const wantAgo = t => { const d = (Date.now() - t) / 864e5; return d < 1 ? 'added today' : d < 2 ? 'added yesterday' : `added ${Math.floor(d)} days ago`; };

/* ---------- Get: open the song where you can buy or download it ---------- */
async function getSheet(key, { all = false } = {}) {
  const open = wants().filter(w => !w.arrived);
  const w = open.find(x => x.key === key) || (all ? open[0] : null); if (!w) return;
  const q = `${w.artist} ${w.title}`;
  const idx = open.indexOf(w);
  const links = [
    ['itunes', 'iTunes Store', 'Buy the song file', '#fa2d48', '♪'],
    ['bandcamp', 'Bandcamp', 'If the artist sells there', '#1da0c3', 'b'],
    ['amazon', 'Amazon Music', 'MP3 download', '#ff9900', 'a'],
    ['youtube', 'YouTube', 'Watch the video', '#ff0033', '▶'],
  ];
  sheet(`<div class="get-sheet"><div class="get-head"><img src="${esc(w.art)}" alt=""><div><b>${esc(w.title)}</b><span>${esc(w.artist)}</span></div></div>
    <div class="settings-group">${links.map(([k, l, sub, c, g]) => `<button class="set-row get-link" data-action="get-go" data-k="${k}" data-q="${esc(q)}"><span class="get-ic" style="background:${c}">${g}</span><span class="lbl"><b>${l}</b><span id="get-${k}">${sub}</span></span>${icon('back', 'chev')}</button>`).join('')}</div>
    <p class="muted get-note">Songs you buy go into your Downloads or the Music app, and Fof Music adds them on its own.</p>
    ${all && open.length > 1 ? `<div class="actions"><span class="muted">${idx + 1} of ${open.length}</span><button class="btn primary" data-action="get-next" data-key="${esc(w.key)}">Next song</button></div>` : ''}</div>`);
  // price and direct store page from Apple's catalog
  try {
    const j = await new Promise(res => { const cb = '__it' + Math.random().toString(36).slice(2), s = document.createElement('script'); window[cb] = v => { delete window[cb]; s.remove(); res(v); }; s.onerror = () => res(null); s.src = `https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${encodeURIComponent(q)}&callback=${cb}`; document.head.appendChild(s); setTimeout(() => res(null), 8000); });
    const hit = (j?.results || []).find(r => nrm(r.trackName) === nrm(w.title)) || j?.results?.[0];
    if (hit) { w.itunes = hit.trackViewUrl; const el = $('#get-itunes'); if (el) el.textContent = hit.trackPrice > 0 ? `Buy the song file · $${hit.trackPrice.toFixed(2)}` : 'Open in the iTunes Store'; }
  } catch {}
}
function getGo(k, q) {
  const w = wants().find(x => nrm(x.artist + ' ' + x.title) === nrm(q));
  const e = encodeURIComponent(q);
  const url = k === 'itunes' ? (w?.itunes ? w.itunes.replace('music.apple.com', 'itunes.apple.com') + (w.itunes.includes('?') ? '&' : '?') + 'app=itunes' : `https://www.apple.com/us/search/${e}?src=itunes_serp`)
    : k === 'bandcamp' ? `https://bandcamp.com/search?q=${e}&item_type=t`
    : k === 'amazon' ? `https://www.amazon.com/s?k=${e}&i=digital-music`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' official video')}`;
  if (IN_APP) location.href = url; else window.open(url, '_blank', 'noopener');
}

/* ---------- new releases from artists in your library ---------- */
async function newReleases() {
  const all = visible().filter(t => (t.category || 'Music') === 'Music');
  const score = new Map(); for (const t of all) { const a = mainArtist(t.artist); if (/^unknown/i.test(a)) continue; score.set(a, (score.get(a) || 0) + (t.plays || 0) * 2 + (t.liked ? 6 : 0) + 1); }
  const fav = [...score].sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 20);
  const cutoff = Date.now() - 75 * 864e5;
  const lists = await Promise.all(fav.map(async name => { const id = await dzArtistId(name); if (!id) return []; const j = await dz(`artist/${id}/albums?limit=8`); return (j?.data || []).filter(a => Date.parse(a.release_date) >= cutoff).map(a => ({ id: a.id, title: a.title, artist: name, date: a.release_date, art: a.cover_medium, type: a.record_type })); }));
  const seen = new Set();
  return lists.flat().filter(a => !seen.has(a.id) && seen.add(a.id)).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 16);
}
const relDate = d => { const t = Date.parse(d), days = (Date.now() - t) / 864e5; return days < 7 ? 'This week' : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
function releaseCard(a) { return `<a class="dc-card" href="#/dz-album/${a.id}"><span class="dc-cover"><img loading="lazy" src="${esc(a.art).replace('/250x250-', '/500x500-')}" alt="">${(Date.now() - Date.parse(a.date)) / 864e5 < 14 ? '<span class="rel-new">NEW</span>' : ''}</span><div class="dc-card-t"><span class="dc-main"><b class="ellipsis">${esc(a.title)}</b><em class="ellipsis">${esc(a.artist)} · ${a.type === 'single' ? 'Single' : a.type === 'ep' ? 'EP' : 'Album'} · ${relDate(a.date)}</em></span></div></a>`; }

/* ---------- ways in ---------- */
function waysCard() {
  return `<section class="section"><div class="section-head"><h2>Ways to add songs</h2></div><div class="settings-group ways">
    <div class="set-row"><span class="get-ic" style="background:#34c759">${icon('check')}</span><div class="lbl"><b>Mac Downloads</b><span>Songs and zips you download on your Mac go in on their own.</span></div></div>
    <div class="set-row"><span class="get-ic" style="background:#0a84ff">☁</span><div class="lbl"><b>From your iPhone</b><span>Save a song to Files › iCloud Drive › Fof Music Inbox. It shows up about a minute later.</span></div></div>
    <div class="set-row"><span class="get-ic" style="background:#fa2d48">♪</span><div class="lbl"><b>iTunes Store purchases</b><span>Songs you buy are added from the Music app on your Mac.</span></div></div>
    <button class="set-row" data-action="shazam-help"><span class="get-ic" style="background:#0088ff">S</span><div class="lbl"><b>Shazam to Want list</b><span>Hear a song you like, run the Shortcut, and it’s saved here.</span></div>${icon('back', 'chev')}</button>
  </div></section>`;
}
function shazamHelp() {
  sheet(`<h2>Shazam to Want list</h2><p class="muted">Set this up once on your iPhone. After that, say “Hey Siri, Want this song” while music is playing nearby.</p>
    <ol class="steps"><li>Open the <b>Shortcuts</b> app and tap <b>+</b>.</li><li>Add the action <b>Shazam It</b> (search “Shazam”).</li><li>Add <b>Text</b> with the <b>Artist</b> variable, “ - ”, and the <b>Title</b> variable.</li><li>Add <b>URL Encode</b> on that Text, then another <b>Text</b>: <code>fofmusic://want/</code> followed by the encoded text.</li><li>Add <b>Open URLs</b> with that last Text.</li><li>Name it <b>Want this song</b>.</li></ol>
    <div class="actions"><button class="btn primary" data-close>Done</button></div>`);
}
/** "fofmusic://want/Artist - Title" from the Shortcut. */
async function wantFromText(text) {
  const [artist, ...rest] = decodeURIComponent(text).split(' - '); const title = rest.join(' - ').trim();
  if (!title) return;
  let r = { title, artist: artist.trim(), album: '', art: '', preview: '' };
  try { const j = await dz(`search?limit=5&q=${encodeURIComponent(`artist:"${r.artist}" track:"${title}"`)}`); const hit = j?.data?.[0]; if (hit) r = { ...dzTrack(hit), artist: hit.artist?.name || r.artist }; } catch {}
  if (owns(r.title, r.artist)) return toast(`${r.title} is already in your library`);
  if (!isWanted(r.title, r.artist)) toggleWant(r);
  go('import/want');
}

/* =====================================================================
   Made for your moments: playlists that build themselves from how you listen
   ===================================================================== */
const isSong = t => t && !t.ext && (t.category || 'Music') === 'Music';
let rcMemo = { k: '', v: new Map() };
function recentPlays() {
  const k = S.log.length + ':' + Math.floor(Date.now() / DAY);
  if (rcMemo.k !== k) rcMemo = { k, v: playCounts(e => Date.now() - e.at < 30 * DAY) };
  return rcMemo.v;
}
/** a small, steady wobble so moments feel fresh each day without changing on every redraw */
const dayWobble = id => { let h = Math.floor(Date.now() / DAY); for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0; return (Math.abs(h) % 100) / 100; };
function favRank(ts, n, extra = () => 0) {
  const rc = recentPlays();
  return ts.map(t => [t, (rc.get(t.id) || 0) * 3 + Math.min(t.plays || 0, 40) + (t.liked ? 8 : 0) + extra(t) + dayWobble(t.id) * 4]).sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
}
const G_ENERGY = /hip-?hop|rap|drill|trap|dance|edm|house|electro|afro|amapiano|reggaeton|dancehall|grime|gqom|naija|crunk|club|bounce/i;
const G_HIPHOP = /hip-?hop|rap|drill|trap|grime/i;
const G_CALM = /classical|instrumental|ambient|piano|soundtrack|lo-?fi|new age|jazz|acoustic|chill/i;
const G_SUNDAY = /gospel|worship|christian|soul|r&b|jazz|acoustic|neo-?soul|inspirational/i;
const hourCounts = (key, test) => memoCounts(key, e => test(new Date(e.at)));
const MOMENT = {
  'workout': { title: 'Workout', c: ['#ff453a', '#ff9f0a'], desc: 'High-energy songs you play the most', get: ts => favRank(ts.filter(t => isSong(t) && ((t.moods || []).some(m => m === 'workout' || m === 'energy') || G_ENERGY.test(t.genre || ''))), 50, t => (t.moods || []).includes('workout') ? 10 : 0) },
  'drive': { title: 'Drive', c: ['#0a84ff', '#5e5ce6'], desc: 'What you play on the way to work and home, plus your favorites', get: ts => { const c = hourCounts('commute', d => { const h = d.getHours(), w = d.getDay(); return w > 0 && w < 6 && ((h >= 6 && h < 9) || (h >= 15 && h < 19)); }); return favRank(ts.filter(t => isSong(t) && (c.get(t.id) || t.liked || (t.plays || 0) >= 3)), 50, t => (c.get(t.id) || 0) * 4); } },
  'on-repeat': { title: 'On Repeat', c: ['#bf5af2', '#5e5ce6'], desc: 'What you can’t stop playing this month', get: ts => { const rc = recentPlays(); return ts.filter(t => isSong(t) && (rc.get(t.id) || 0) >= 3).sort((a, b) => rc.get(b.id) - rc.get(a.id) || (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 40); } },
  'afrobeats': { title: 'Afrobeats', c: ['#ff9f0a', '#30a14e'], desc: 'Your Afrobeats, Amapiano and African favorites', get: ts => favRank(ts.filter(t => isSong(t) && MOODS.afrobeats.test(t)), 60) },
  'hip-hop-heat': { title: 'Hip-Hop Heat', c: ['#ff2d55', '#7a0c24'], desc: 'The rap you play the most right now', get: ts => favRank(ts.filter(t => isSong(t) && G_HIPHOP.test(t.genre || '')), 50, t => (recentPlays().get(t.id) || 0) * 2) },
  'late-night': { ...SMART['late-night'], c: ['#2c2c6c', '#7d3c98'], get: ts => { const c = memoCounts('night', isNight); return favRank(ts.filter(t => isSong(t) && c.get(t.id)), 50, t => c.get(t.id) * 4); } },
  'focus': { title: 'Focus', c: ['#30b0c7', '#1f5f73'], desc: 'Calm, steady songs for getting work done', get: ts => favRank(ts.filter(t => isSong(t) && ((t.moods || []).some(m => m === 'focus' || m === 'chill') || G_CALM.test(t.genre || ''))), 50) },
  'old-school': { title: 'Old School', c: ['#b08d57', '#5b4636'], desc: 'Songs from 15+ years ago that you still love', get: ts => favRank(ts.filter(t => isSong(t) && +t.year && +t.year <= new Date().getFullYear() - 15), 60) },
  'sunday': { title: 'Sunday Morning', c: ['#ffcc00', '#ff8a00'], desc: 'What you play on Sunday mornings, plus soul and gospel', get: ts => { const c = hourCounts('sunday', d => d.getDay() === 0 && d.getHours() >= 7 && d.getHours() < 14); return favRank(ts.filter(t => isSong(t) && (c.get(t.id) || G_SUNDAY.test(t.genre || ''))), 50, t => (c.get(t.id) || 0) * 4); } },
};
delete SMART['late-night'];
for (const [k, m] of Object.entries(MOMENT)) SMART[k] = { ...m, moment: true };
SMART['recently-loved'].get = ts => ts.filter(t => t.liked && Date.now() - (t.likedAt || 0) < 30 * DAY).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
function momentTile(k) {
  const d = SMART[k], ts = d.get(musicOnly()); if (ts.length < 8) return '';
  const key = listKey(ts.map(t => t.id), d.title);
  const arts = firstArts(ts, 3);
  return `<div class="card moment" data-href="smart/${k}"><div class="cover m-tile" style="--m1:${d.c[0]};--m2:${d.c[1]}">
    <div class="m-art">${arts.map(a => `<img loading="lazy" decoding="async" src="${a}" alt="">`).join('')}</div>
    <div class="m-name">${esc(d.title)}</div>
    <button class="hover-play" data-play-list="${key}" data-i="0" data-ctx-route="smart/${k}" aria-label="Play"><svg><use href="#i-play"/></svg></button></div>
    <div class="t ellipsis">${esc(d.title)}</div><div class="s ellipsis">${count(ts.length)} · updates daily</div></div>`;
}
const MOMENT_ORDER = () => { const h = new Date().getHours(), sun = new Date().getDay() === 0; const first = sun && h < 14 ? ['sunday'] : h >= 21 || h < 4 ? ['late-night'] : (h >= 6 && h < 9) || (h >= 15 && h < 19) ? ['drive'] : h < 17 ? ['focus'] : ['workout']; return [...new Set([...first, 'on-repeat', 'drive', 'workout', 'afrobeats', 'hip-hop-heat', 'late-night', 'focus', 'old-school', 'sunday'])]; };
function momentShelf() {
  const tiles = MOMENT_ORDER().map(momentTile).filter(Boolean);
  const loved = smartList('recently-loved');
  if (loved.length >= 3) tiles.splice(1, 0, collCard({ href: 'smart/recently-loved', title: 'Recently Loved', sub: count(loved.length), tracks: loved, badge: '<svg><use href="#i-heart"/></svg>' }));
  return tiles.length ? `<section class="section"><div class="section-head"><div><h2>Made for your moments</h2><div class="section-sub">Built from what you play and when</div></div></div><div class="shelf">${tiles.join('')}</div></section>` : '';
}

/* =====================================================================
   Playlists that grow: songs you love that fit a playlist are added to it;
   songs you keep skipping in it leave
   ===================================================================== */
function plProfile(p) {
  const ts = p.tracks.map(id => T(id)).filter(isSong), artists = new Map(), genres = new Map();
  for (const t of ts) { const a = fold(mainArtist(t.artist)); artists.set(a, (artists.get(a) || 0) + 1); if (t.genre) genres.set(t.genre, (genres.get(t.genre) || 0) + 1); }
  return { n: ts.length, artists, genres, withGenre: [...genres.values()].reduce((x, y) => x + y, 0) };
}
function growScore(t, pr) {
  const a = fold(mainArtist(t.artist)), ac = pr.artists.get(a) || 0;
  const gs = t.genre && pr.withGenre ? (pr.genres.get(t.genre) || 0) / pr.withGenre : 0;
  const genreOk = !t.genre || !pr.withGenre || gs >= .15;
  if (ac && genreOk) return 3 + Math.min(ac, 4) * .5 + gs * 3;
  if (!ac && gs >= .5 && (t.liked || (t.plays || 0) >= 8)) return 2 + gs * 2;
  return 0;
}
let growing = false;
async function growPlaylists(force = false) {
  if (growing || (S.user && !S.lastSync)) return;
  const last = await kv.get('growAt', 0); if (!force && Date.now() - last < 60 * 60 * 1000) return;
  growing = true;
  try {
    await kv.set('growAt', Date.now());
    const rc = recentPlays();
    const cands = visible().filter(t => isSong(t) && (t.liked || (t.plays || 0) >= 5 || (rc.get(t.id) || 0) >= 3));
    const pls = [...S.playlists.values()].filter(p => p.auto !== false && p.tracks.length >= 8);
    const picks = new Map(); // song → best playlists (a song joins at most two)
    for (const p of pls) {
      const pr = plProfile(p); if (pr.n < 8) continue;
      const have = new Set(p.tracks), gone = new Set(p.removed || []);
      for (const t of cands) { if (have.has(t.id) || gone.has(t.id)) continue; const sc = growScore(t, pr); if (sc) { if (!picks.has(t.id)) picks.set(t.id, []); picks.get(t.id).push([p, sc]); } }
    }
    const per = new Map();
    for (const [id, list] of picks) for (const [p, sc] of list.sort((a, b) => b[1] - a[1]).slice(0, 2)) { if (!per.has(p.id)) per.set(p.id, []); per.get(p.id).push([id, sc]); }
    let total = 0;
    for (const [pid, list] of per) {
      const p = S.playlists.get(pid); const wk = Date.now() - 7 * DAY;
      const thisWeek = (p.added || []).filter(x => x.at > wk).length; const room = Math.max(0, 12 - thisWeek); if (!room) continue;
      const take = list.sort((a, b) => b[1] - a[1]).slice(0, Math.min(6, room)); if (!take.length) continue;
      const now = Date.now();
      for (const [id] of take) { if (!p.tracks.includes(id)) p.tracks.push(id); }
      const t0 = id => T(id);
      p.added = [...(p.added || []).filter(x => x.at > now - 30 * DAY), ...take.map(([id]) => ({ id, at: now, why: t0(id)?.liked ? 'You liked it' : `You’ve played it ${t0(id)?.plays || 0} times` }))];
      await savePlaylist(p); total += take.length;
    }
    if (total) { S.ver++; bgRender(); }
  } finally { growing = false; }
}
function growBox(p) {
  if (p.tracks.length < 8 && !(p.added || []).length) return '';
  const wk = Date.now() - 7 * DAY;
  const fresh = (p.added || []).filter(x => x.at > wk && p.tracks.includes(x.id) && T(x.id));
  const on = p.auto !== false;
  const sw2 = `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-action="grow-toggle" data-pl="${p.id}" aria-label="Add songs on its own"></button>`;
  if (!fresh.length) return `<div class="grow-bar"><span>${icon('new')}</span><div><b>Grows on its own</b><em>${on ? 'Adds songs you love that fit, and drops ones you keep skipping' : 'Off · this playlist only changes when you change it'}</em></div>${sw2}</div>`;
  return `<section class="grow-box"><div class="grow-head"><div><b>Added for you this week</b><em>${count(fresh.length)} that fit this playlist</em></div><button class="btn small ghost" data-action="grow-undo-all" data-pl="${p.id}">Undo all</button>${sw2}</div>
    <div class="grow-list">${fresh.map(x => { const t = T(x.id); return `<div class="grow-row"><img loading="lazy" src="${artOf(t)}" alt=""><div class="ellipsis"><b class="ellipsis">${esc(t.title)}</b><em class="ellipsis">${esc(t.artist)} · ${esc(x.why || '')}</em></div><button class="btn small ghost" data-action="grow-undo" data-pl="${p.id}" data-id="${x.id}">Undo</button></div>`; }).join('')}</div></section>`;
}
async function growUndo(pid, ids) {
  const p = S.playlists.get(pid); if (!p) return;
  const set = new Set(ids);
  p.tracks = p.tracks.filter(x => !set.has(x));
  p.removed = [...new Set([...(p.removed || []), ...ids])];
  p.added = (p.added || []).filter(x => !set.has(x.id));
  await savePlaylist(p); render();
}
/** Skipping a song early three times while playing a playlist takes it out of that playlist. */
function noteSkip() {
  const t = current(); if (!isSong(t)) return;
  const r = P.contextRoute || ''; if (!r.startsWith('playlist/')) return;
  const p = S.playlists.get(r.slice(9)); if (!p || p.auto === false || !p.tracks.includes(t.id)) return;
  if (engine.el.currentTime > 30 || engine.el.currentTime < 1) return;
  p.skips = p.skips || {}; p.skips[t.id] = (p.skips[t.id] || 0) + 1;
  if (p.skips[t.id] < 3) { db.put('playlists', p.id, p); return; }
  delete p.skips[t.id];
  const i = p.tracks.indexOf(t.id);
  p.tracks = p.tracks.filter(x => x !== t.id); p.removed = [...new Set([...(p.removed || []), t.id])];
  savePlaylist(p);
  toast(`Took “${t.title}” out of ${p.name}. You skipped it 3 times.`, ['Undo', async () => { p.tracks.splice(i, 0, t.id); p.removed = p.removed.filter(x => x !== t.id); await savePlaylist(p); render(); }]);
}

/* =====================================================================
   Clean Up: one place to tidy the library, with 30-day undo
   ===================================================================== */
const JUNK_RES = [
  /\s*[\(\[][^\)\]]*\bofficial\b[^\)\]]*\b(?:video|audio|lyrics?|visuali[sz]er|mv)\b[^\)\]]*[\)\]]/gi,
  /\s*[\(\[]\s*(?:official\s+)?(?:music\s+video|lyrics?|lyric\s+video|audio|video|visuali[sz]er|hd|hq|4k|mv|m\/v)\s*[\)\]]/gi,
  /\s+[-–|]\s*official\s+(?:music\s+)?(?:video|audio|lyric\s+video|visuali[sz]er)\s*$/i,
  /\s*[\(\[]?(?:www\.)?[a-z0-9-]+\.(?:com|net|org)[\)\]]?(?=\s|$)/gi,
  /^(?:y2mate|ytmp3|x2download|savefrom|savetube|mp3juices?)(?:\.\w+)?\s*[-_–]\s*/i,
  /\s*\.(?:mp3|m4a|wav|flac)$/i,
];
function cleanTitle(t) {
  let s = String(t.title || '');
  for (const re of JUNK_RES) s = s.replace(re, '');
  const a = mainArtist(t.artist);
  if (a && !/^unknown/i.test(a)) { const re = new RegExp('^' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+[-–—]\\s+', 'i'); const x = s.replace(re, ''); if (x.trim()) s = x; }
  if (/_/.test(s) && !/\s/.test(s.replace(/_/g, ''))) s = s.replace(/_+/g, ' ');
  s = s.replace(/^\s*[-–|]\s+/, '').replace(/\s{2,}/g, ' ').trim();
  return s || t.title;
}
function cleanupScan() {
  const songs = [...S.tracks.values()].filter(t => isSong(t));
  const names = songs.filter(t => !t.edited && cleanTitle(t) !== t.title).map(t => ({ t, to: cleanTitle(t) }));
  const covers = songs.filter(t => t.designedCover && !/^unknown/i.test(t.artist || '') && !(S.cleanNoArt || []).includes(t.id));
  const byKey = new Map();
  for (const t of songs) { if (/^unknown/i.test(t.artist || '')) continue; const k = fold(t.artist); if (!k) continue; if (!byKey.has(k)) byKey.set(k, new Map()); const m = byKey.get(k); m.set(t.artist, (m.get(t.artist) || 0) + 1); }
  const artists = [];
  for (const m of byKey.values()) if (m.size > 1) { const ranked = [...m].sort((a, b) => b[1] - a[1] || (/[A-Z]/.test(b[0]) - /[A-Z]/.test(a[0]))); artists.push({ to: ranked[0][0], from: ranked.slice(1).map(x => x[0]), n: ranked.slice(1).reduce((x, y) => x + y[1], 0) }); }
  return { names, covers, artists, dups: duplicateGroups().length, eyes: reviewList().length };
}
let cleanMemo = { v: -1, at: 0, r: null };
function cleanupCached() { if (!cleanMemo.r || cleanMemo.v !== S.ver || Date.now() - cleanMemo.at > 60000) cleanMemo = { v: S.ver, at: Date.now(), r: cleanupScan() }; return cleanMemo.r; }
function cleanupCount() { try { const c = cleanupCached(); return c.names.length + c.covers.length + c.artists.reduce((x, y) => x + y.n, 0) + c.dups + c.eyes; } catch { return 0; } }
const CU = { busy: '', open: '' };
async function cleanLog() { const l = await kv.get('cleanLog', []); return l.filter(x => Date.now() - x.at < 30 * DAY); }
async function pushLog(entry) { const l = await cleanLog(); l.unshift(entry); await kv.set('cleanLog', l.slice(0, 40)); S.cleanLogCache = l.slice(0, 40); }
async function fixNames(list) {
  const items = [];
  for (const { t, to } of list) { const before = t.title; if (to === before) continue; t.title = to; learnFix(t, { title: before, artist: t.artist }); if (t.designedCover) await setArt(t, await meta.makeCover(t.title, t.artist, t.category)); await saveTrack(t); items.push({ id: t.id, f: 'title', from: before, to }); }
  return items;
}
async function fixArtists(groups) {
  const items = [];
  for (const g of groups) for (const t of S.tracks.values()) if (g.from.includes(t.artist)) { const before = t.artist; t.artist = g.to; await saveTrack(t); items.push({ id: t.id, f: 'artist', from: before, to: g.to }); }
  return items;
}
async function fixCovers(ts, progress) {
  const items = []; let i = 0;
  for (const t of ts) {
    i++; progress?.(i, ts.length);
    if (!navigator.onLine) break;
    try {
      const found = await Promise.race([meta.lookup({ title: t.title, artist: t.artist, duration: t.duration }), new Promise(r => setTimeout(() => r(undefined), 15000))]);
      if (found === undefined) continue;
      if (!found?.artUrl) { S.cleanNoArt = [...new Set([...(S.cleanNoArt || []), t.id])]; continue; }
      const b = await Promise.race([meta.fetchImage(found.artUrl), new Promise(r => setTimeout(() => r(null), 15000))]); if (!b) continue;
      await setArt(t, b); t.designedCover = false; Object.assign(t, { album: t.album || found.album, genre: t.genre || found.genre, year: t.year || found.year });
      await saveTrack(t); if (S.user && t.cloud) cloud.uploadFile('art/' + t.id, b).catch(() => {});
      items.push({ id: t.id, f: 'cover', from: 'designed', to: 'found' });
    } catch (e) { console.warn('cover', e); }
  }
  kv.set('cleanNoArt', S.cleanNoArt || []);
  return items;
}
async function runCleanup(kind) {
  if (CU.busy) return;
  const c = cleanupScan(); CU.busy = kind; render();
  try {
    let items = [];
    if (kind === 'names' || kind === 'all') items = items.concat(await fixNames(c.names));
    if (kind === 'artists' || kind === 'all') items = items.concat(await fixArtists(c.artists));
    if (kind === 'covers' || kind === 'all') items = items.concat(await fixCovers(c.covers, (i, n) => { const el = $('#cu-prog'); if (el) el.textContent = `Finding covers… ${i} of ${n}`; }));
    S.ver++;
    if (items.length) { await pushLog({ id: uid(), at: Date.now(), kind, n: items.length, items }); toast(`Fixed ${count(items.length)}`, ['Undo', () => undoCleanup(0)]); }
    else toast(kind === 'covers' ? 'No new covers found right now' : 'Nothing to fix');
  } finally { CU.busy = ''; cleanMemo.r = null; render(); }
}
async function undoCleanup(i) {
  const l = await cleanLog(); const e = l[i]; if (!e) return;
  let n = 0;
  for (const it of e.items) {
    const t = T(it.id); if (!t) continue;
    if (it.f === 'cover') { await setArt(t, await meta.makeCover(t.title, t.artist, t.category)); t.designedCover = true; S.cleanNoArt = [...new Set([...(S.cleanNoArt || []), t.id])]; await saveTrack(t); n++; continue; }
    if (t[it.f] !== it.to) continue; // changed again since; leave it
    t[it.f] = it.from; await saveTrack(t); n++;
  }
  if (e.items.some(x => x.f === 'cover')) kv.set('cleanNoArt', S.cleanNoArt || []);
  l.splice(i, 1); await kv.set('cleanLog', l); S.cleanLogCache = l; S.ver++; cleanMemo.r = null; render();
  toast(`Put back ${count(n)}`);
}
const CU_LABEL = { all: 'Fix all', names: 'Fixed names', artists: 'Matched artist names', covers: 'Found covers' };
VIEWS.cleanup = () => {
  const c = cleanupCached(); const log = S.cleanLogCache || []; if (!S.cleanLogCache) cleanLog().then(l => { S.cleanLogCache = l; if (S.route === 'cleanup') render(); });
  const total = c.names.length + c.covers.length + c.artists.length;
  const card = (k, title, n, sub, body, act) => `<section class="cu-card${CU.open === k ? ' open' : ''}"><button class="cu-head" data-action="cu-open" data-id="${k}"><div class="cu-n${n ? '' : ' ok'}">${n ? n : icon('check')}</div><div class="cu-t"><b>${title}</b><em>${sub}</em></div>${act || ''}${icon('back', 'chev')}</button>${CU.open === k && body ? `<div class="cu-body">${body}</div>` : ''}</section>`;
  const fixBtn = (k, n) => n ? `<span class="btn small" data-action="cu-run" data-id="${k}" role="button">${CU.busy === k ? 'Fixing…' : 'Fix'}</span>` : '';
  const more = n => n > 40 ? `<div class="cu-more muted">and ${n - 40} more</div>` : '';
  return `${back()}<div class="page-head"><div><div class="eyebrow">Library</div><h1>Clean Up</h1><div class="lede">${total || c.dups || c.eyes ? 'Tidy names, covers and artists in one tap. Everything can be put back for 30 days.' : 'Your library is clean.'}</div></div>
      ${total ? `<button class="btn primary" data-action="cu-run" data-id="all"${CU.busy ? ' disabled' : ''}>${CU.busy ? 'Working…' : 'Fix all'}</button>` : ''}</div>
    ${CU.busy ? `<div class="cu-prog" id="cu-prog" role="status">${CU.busy === 'covers' || CU.busy === 'all' ? 'Working…' : 'Fixing…'}</div>` : ''}
    <div class="cu-list">
    ${card('names', 'Names to fix', c.names.length, c.names.length ? 'Extra words like “Official Video” or the artist’s name in the title' : 'Every song name looks clean', c.names.slice(0, 40).map(({ t, to }) => `<div class="cu-row"><img loading="lazy" src="${artOf(t)}" alt=""><div class="ellipsis"><s class="ellipsis">${esc(t.title)}</s><b class="ellipsis">${esc(to)}</b></div></div>`).join('') + more(c.names.length), fixBtn('names', c.names.length))}
    ${card('covers', 'Missing covers', c.covers.length, c.covers.length ? 'Songs with a placeholder cover. Real artwork is looked up online.' : 'Every song has its real cover', c.covers.slice(0, 40).map(t => `<div class="cu-row"><img loading="lazy" src="${artOf(t)}" alt=""><div class="ellipsis"><b class="ellipsis">${esc(t.title)}</b><em class="ellipsis">${esc(t.artist)}</em></div></div>`).join('') + more(c.covers.length), fixBtn('covers', c.covers.length))}
    ${card('artists', 'Mixed-up artist names', c.artists.length, c.artists.length ? 'The same artist spelled different ways' : 'Each artist is spelled one way', c.artists.slice(0, 40).map(g => `<div class="cu-row text"><div class="ellipsis"><s class="ellipsis">${g.from.map(esc).join(', ')}</s><b class="ellipsis">${esc(g.to)} · ${count(g.n)}</b></div></div>`).join('') + more(c.artists.length), fixBtn('artists', c.artists.length))}
    <a class="cu-card link" href="#/duplicates"><div class="cu-head"><div class="cu-n${c.dups ? '' : ' ok'}">${c.dups || icon('check')}</div><div class="cu-t"><b>Possible duplicates</b><em>${c.dups ? 'You choose which copy to keep. Nothing is removed on its own.' : 'No duplicates found'}</em></div>${icon('back', 'chev')}</div></a>
    <a class="cu-card link" href="#/review"><div class="cu-head"><div class="cu-n${c.eyes ? '' : ' ok'}">${c.eyes || icon('check')}</div><div class="cu-t"><b>Needs your eyes</b><em>${c.eyes ? 'Songs Fof Music couldn’t name for sure' : 'Nothing needs checking'}</em></div>${icon('back', 'chev')}</div></a>
    </div>
    ${log.length ? `<section class="section"><div class="section-head"><h2>Recent fixes</h2></div><div class="settings-group">${log.map((e, i) => `<div class="set-row"><div class="lbl"><b>${CU_LABEL[e.kind] || 'Fixed'} · ${count(e.n)}</b><span>${new Date(e.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · can be put back until ${new Date(e.at + 30 * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div><button class="btn small ghost" data-action="cu-undo" data-id="${i}">Undo</button></div>`).join('')}</div></section>` : ''}`;
};

/* =====================================================================
   Offline: what stays on this phone
   ===================================================================== */
const OFF_DEF = { top: -1, liked: true, upnext: true, podcasts: true, quran: true, limitGB: 0, wifiOnly: true };
const offSet = () => ({ ...OFF_DEF, ...(S.settings.offline || {}) });
async function setOff(k, v) { S.settings.offline = { ...offSet(), [k]: v }; await saveSettings(); render(); setTimeout(autoOffline, 800); }
const onWifi = () => { const c = navigator.connection; if (!c || !c.type) return true; return c.type === 'wifi' || c.type === 'ethernet'; };
async function storageUse() {
  const songs = [...S.tracks.values()].filter(isOff);
  const ext = [...S.ext.values()].filter(t => t.path || t.local);
  const est = (n, ts) => ts.reduce((x, t) => x + (t.size || (t.duration || 200) * 24000), 0);
  const lib = [...S.tracks.values()].filter(t => t.cloud || t.local);
  const r = { libSize: est(0, lib), libN: lib.length, music: est(0, songs), podcasts: est(0, ext.filter(t => t.kind === 'episode')), quran: est(0, ext.filter(t => t.kind === 'ayah' || t.kind === 'surahrec')), songs: songs.length, eps: ext.filter(t => t.kind === 'episode').length, free: null };
  try { const e = await navigator.storage?.estimate?.(); if (e?.quota) r.free = Math.max(0, e.quota - e.usage); } catch {}
  return r;
}
VIEWS.offline = () => {
  const o = offSet(); const u = S.offUse; if (!u || Date.now() - (S.offUseAt || 0) > 15000) { S.offUseAt = Date.now(); storageUse().then(x => { S.offUse = x; if (S.route === 'offline') render(); }); }
  const used = u ? u.music + u.podcasts + u.quran : 0, cap = o.limitGB ? o.limitGB * 1e9 : Math.max(1, (u?.libSize || 0) + (u ? u.podcasts + u.quran : 0));
  const pct = x => Math.max(x ? .8 : 0, Math.min(100, x / cap * 100)).toFixed(1);
  const tg = (k, label, sub) => `<div class="set-row"><div class="lbl"><b>${label}</b><span>${sub}</span></div><button class="switch ${o[k] ? 'on' : ''}" role="switch" aria-checked="${!!o[k]}" data-action="off-set" data-id="${k}" aria-label="${label}"></button></div>`;
  const pick = (k, vals, fmtV) => `<div class="seg small">${vals.map(v => `<button class="${o[k] === v ? 'on' : ''}" data-action="off-pick" data-id="${k}" data-v="${v}">${fmtV(v)}</button>`).join('')}</div>`;
  const on = S.settings.autoOffline !== false;
  return `${back()}<div class="page-head"><div><div class="eyebrow">Settings</div><h1>Offline</h1><div class="lede">Choose what stays on this phone, so it plays with no signal.</div></div></div>
    <section class="off-store"><div class="off-top"><b>${u ? bytes(used) : '…'}</b><span class="muted">${o.limitGB ? `of ${o.limitGB} GB` : u ? `${u.songs.toLocaleString()} of ${count(u.libN)} on this phone` : ''}</span></div>
      <div class="off-bar"><i class="m" style="width:${u ? pct(u.music) : 0}%"></i><i class="p" style="width:${u ? pct(u.podcasts) : 0}%"></i><i class="q" style="width:${u ? pct(u.quran) : 0}%"></i></div>
      <div class="off-key"><span><i class="m"></i>Music ${u ? `· ${count(u.songs)}` : ''}</span><span><i class="p"></i>Podcasts ${u ? `· ${u.eps}` : ''}</span><span><i class="q"></i>Quran</span></div></section>
    <div class="settings-group">${sw('autoOffline', 'Keep music on this phone', 'Saves what you choose below and keeps it up to date')}</div>
    <div class="settings-group${on ? '' : ' dim'}">
      <div class="set-row"><div class="lbl"><b>Songs</b><span>${o.top < 0 ? 'Your whole library, most played first' : 'Your most played, kept fresh'}</span></div>${pick('top', [-1, 250, 100, 0], v => v < 0 ? 'All' : v ? 'Top ' + v : 'None')}</div>
      ${tg('liked', 'Liked Songs', 'Every song you like')}
      ${tg('upnext', 'Up next', 'The next songs in your queue, saved ahead')}
      ${tg('podcasts', 'Podcasts', 'The newest episode of each show you follow')}
      ${tg('quran', 'Quran', 'The last 3 surahs you listened to')}
    </div>
    <div class="settings-group">
      <div class="set-row"><div class="lbl"><b>Space limit</b><span>Stops saving new songs past this</span></div>${pick('limitGB', [0, 32, 16, 8], v => v ? v + ' GB' : 'None')}</div>
      ${tg('wifiOnly', 'Only on Wi-Fi', 'Saves songs only when you’re on Wi-Fi')}
      <div class="set-row"><div class="lbl"><b>Save now</b><span>${downloading ? 'Saving…' : 'Runs on its own every 15 minutes'}</span></div><button class="btn" data-action="off-now">Save now</button></div>
      <div class="set-row"><div class="lbl"><b>Remove songs from this phone</b><span>Turns off “Keep music on this phone”. Songs you saved yourself stay.</span></div><button class="btn ghost" data-action="off-clear">Remove</button></div>
    </div>`;
};
/** Quran audio kept on the phone: { 'rid:n': { at, files: { id: path } } } for the last 3 surahs you played. */
const keepPath = id => { for (const v of Object.values(S.qOff || {})) if (v.files?.[id]) return { path: v.files[id] }; return {}; };
async function offlineQuran(o) {
  if (!NATIVE) return;
  S.qOff = S.qOff || await kv.get('qOff', {});
  const seen = [];
  if (o.quran) for (const id of S.history) { const m = /^(qur|qs):(.+):(\d+)$/.exec(id); if (!m) continue; const t = S.ext.get(id); const n = t?.surah || (m[1] === 'qs' ? +m[3] : 0); if (!n || seen.some(x => x.n === n)) continue; seen.push({ n, rid: m[2] }); if (seen.length >= 3) break; }
  const keys = new Set(seen.map(x => x.rid + ':' + x.n));
  for (const [k, v] of Object.entries(S.qOff)) if (!keys.has(k)) { for (const [id, path] of Object.entries(v.files || {})) { await NATIVE.removeFile({ name: path.split('/').pop() }).catch(() => {}); const t = S.ext.get(id); if (t?.path === path) delete t.path; } delete S.qOff[k]; }
  await kv.set('qOff', S.qOff);
  for (const { n, rid } of seen) {
    const k = rid + ':' + n; if (S.qOff[k]?.done) continue;
    const r = recById(rid); if (!r) continue;
    let items = [];
    try {
      if (r.kind === 'verse') { const audio = QR.audio.get(n + r.id) || await quran.verseAudio(n, r.id); QR.audio.set(n + r.id, audio); const ayahs = await qTextNow(n); items = ayahs.map((a, i) => ({ id: `qur:${r.id}:${a.g}`, url: audio[i] })); }
      else items = [{ id: `qs:${r.id}:${n}`, url: quran.surahUrl(r, n) }];
    } catch { continue; }
    const rec0 = S.qOff[k] = S.qOff[k] || { at: Date.now(), files: {} };
    let ok = true;
    for (const it of items) {
      if (rec0.files[it.id]) continue;
      if (!it.url || !navigator.onLine || (offSet().wifiOnly && !onWifi())) { ok = false; break; }
      try { const x = await NATIVE.download({ url: it.url, name: 'q-' + it.id.replace(/[^\w]/g, '_') + '.mp3' }); rec0.files[it.id] = x.path; const t = S.ext.get(it.id); if (t) t.path = x.path; } catch { ok = false; break; }
    }
    rec0.done = ok; await kv.set('qOff', S.qOff);
  }
}

/* =====================================================================
   Drive mode: big buttons only
   ===================================================================== */
function driveNow() {
  const t = current();
  return t ? `<img class="dr-art" id="dr-art" src="${artOf(t, 'full')}" alt=""><div class="dr-meta"><b class="ellipsis" id="dr-title">${esc(t.title)}</b><span class="ellipsis" id="dr-artist">${esc(t.artist)}</span></div>`
    : `<div class="dr-art dr-empty">${icon('note')}</div><div class="dr-meta"><b id="dr-title">Nothing playing</b><span id="dr-artist">Tap Fof Flow to start</span></div>`;
}
VIEWS.drive = () => {
  const lastEp = Object.entries(S.pod?.prog || {}).filter(([id, p]) => !p.done && S.ext.get(id)).sort((a, b) => (b[1].at || 0) - (a[1].at || 0))[0];
  return `<div class="drive">
    <div class="dr-top"><button class="dr-x" data-action="drive-exit" aria-label="Leave Drive mode">${icon('x')}</button><span class="dr-clock" id="dr-clock">${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span><span class="dr-x-sp"></span></div>
    <div class="dr-now" id="dr-now">${driveNow()}</div>
    <div class="dr-ctl"><button data-action="prev" aria-label="Previous">${icon('prev')}</button><button class="dr-play" data-action="toggle" aria-label="Play or pause"><span class="when-playing">${icon('pause')}</span><span class="when-paused">${icon('play')}</span></button><button data-action="next" aria-label="Next">${icon('next')}</button></div>
    <div class="dr-grid">
      <button class="dr-tile flow" data-action="flow">${icon('flow')}<b>Fof Flow</b></button>
      <button class="dr-tile" data-action="drive-pod">${icon('podcast')}<b>Podcasts</b><em class="ellipsis">${lastEp ? esc(S.ext.get(lastEp[0]).title) : 'Newest episode'}</em></button>
      <button class="dr-tile" data-action="drive-quran">${icon('quran')}<b>Quran</b><em class="ellipsis">${S.quranSpot ? 'Pick up where you left off' : 'Start listening'}</em></button>
      <button class="dr-tile" data-action="drive-maps">${icon('car')}<b>Directions</b><em>Apple or Google Maps</em></button>
    </div></div>`;
};
function paintDrive(t) {
  const box = $('#dr-now'); if (!box || !t) return;
  if ($('#dr-title')?.textContent !== t.title || $('#dr-artist')?.textContent !== t.artist) box.innerHTML = driveNow();
}
setInterval(() => { const c = $('#dr-clock'); if (c) c.textContent = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }, 15000);
async function drivePod() {
  const lastEp = Object.entries(S.pod?.prog || {}).filter(([id, p]) => !p.done && S.ext.get(id)).sort((a, b) => (b[1].at || 0) - (a[1].at || 0))[0];
  if (lastEp) return podPlay(lastEp[0]);
  for (const s of S.pod?.subs || []) { const r = await pods.episodes(s.id).catch(() => null); const ep = r?.episodes?.[0]; if (ep) { PC.ep = PC.ep || new Map(); PC.ep.set(ep.id, ep); saveExt({ ...ep, ...(S.ext.get(ep.id) || {}) }); return podPlay(ep.id); } }
  toast('Follow a show in Podcasts first');
}
function driveMaps() {
  const open = u => { if (IN_APP) location.href = u; else window.open(u, '_blank'); };
  sheet(`<h2>Directions</h2><p class="muted">Your music keeps playing while you drive.</p>
    <input id="dr-dest" class="input full" placeholder="Where to? (optional)" autocomplete="off" enterkeyhint="go">
    <div class="dr-maps"><button class="btn primary big" data-m="apple">Apple Maps</button><button class="btn big" data-m="google">Google Maps</button></div>`, el => {
    el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
      const q = el.querySelector('#dr-dest').value.trim(), e = encodeURIComponent(q);
      const u = b.dataset.m === 'apple' ? (q ? `https://maps.apple.com/?daddr=${e}&dirflg=d` : 'https://maps.apple.com/') : IS_IOS ? (q ? `comgooglemaps://?daddr=${e}&directionsmode=driving` : 'comgooglemaps://') : (q ? `https://www.google.com/maps/dir/?api=1&destination=${e}&travelmode=driving` : 'https://www.google.com/maps');
      closeSheet(); open(u);
      if (b.dataset.m === 'google' && IS_IOS) setTimeout(() => { if (!document.hidden) open(q ? `https://www.google.com/maps/dir/?api=1&destination=${e}&travelmode=driving` : 'https://www.google.com/maps'); }, 1200);
    });
  });
}

/* actions for the screens above */
const ACT2 = {
  'add-book': async () => {
    if (window.fofDesktop?.addBook) { const r = await window.fofDesktop.addBook(); if (r) toast(`Narrating ${r} on this Mac. Chapters show up here as they’re ready.`); return; }
    if (!S.user) return toast('Sign in first, so your Mac can pick up the book');
    const i = $('#book-input'); i.value = ''; i.click();
  },
  'grow-toggle': async a => { const p = S.playlists.get(a.dataset.pl); if (!p) return; p.auto = p.auto === false; await savePlaylist(p); render(); toast(p.auto ? 'This playlist will grow on its own' : 'Auto-add is off for this playlist'); if (p.auto) growPlaylists(true).catch(() => {}); },
  'grow-undo': a => growUndo(a.dataset.pl, [a.dataset.id]),
  'grow-undo-all': a => { const p = S.playlists.get(a.dataset.pl); const wk = Date.now() - 7 * DAY; return growUndo(a.dataset.pl, (p?.added || []).filter(x => x.at > wk).map(x => x.id)); },
  'cu-open': a => { CU.open = CU.open === a.dataset.id ? '' : a.dataset.id; render(); },
  'cu-run': (a, e) => { e.stopPropagation(); return runCleanup(a.dataset.id); },
  'cu-undo': a => undoCleanup(+a.dataset.id),
  'off-set': a => setOff(a.dataset.id, !offSet()[a.dataset.id]),
  'off-pick': a => setOff(a.dataset.id, +a.dataset.v),
  'off-now': () => { toast('Saving to this phone…'); return autoOfflineNow(true).then(() => { S.offUseAt = 0; render(); }); },
  'off-clear': async () => { const ids = [...S.tracks.values()].filter(t => t.autoSaved && t.local).map(t => t.id); const paths = Object.entries(S.offPaths || {}); if (!ids.length && !paths.length) return toast('Nothing saved on its own'); S.settings.autoOffline = false; await saveSettings(); for (const [, v] of paths) await NATIVE?.removeFile({ name: v.name }).catch(() => {}); S.offPaths = {}; await kv.set('offPaths', {}); if (ids.length) await removeDownloads(ids); else toast(`Removed ${count(paths.length)} from this phone. They still stream.`); S.offUseAt = 0; render(); },
  'drive-exit': () => go(S.driveFrom && S.driveFrom !== 'drive' ? S.driveFrom : 'home'),
  'drive-pod': () => drivePod(),
  'drive-quran': () => S.quranSpot ? qResume() : qPlay(1),
  'drive-maps': () => driveMaps(),
};

/* for checking things from the console */
window.__fof = { epubChapters, readQueued, epubInfo, openReader, rdFollow: s => rdFollow(s, true), growPlaylists, cleanupScan, runCleanup, undoCleanup, S, P };

/* =====================================================================
   Mac app: imports new songs from your folders in the background and
   shows what's playing in the menu bar
   ===================================================================== */
const DESK = window.fofDesktop || null;
if (DESK) {
  document.documentElement.classList.add('desktop-app');
  let busy = false, pending = null;
  const waitIdle = async () => { for (let i = 0; i < 600 && IMP.running; i++) await new Promise(r => setTimeout(r, 1000)); return !IMP.running; };
  async function deskImport(list) {
    // a list that arrives mid-import is kept and handled right after, never dropped
    if (busy) { pending = list; return; }
    busy = true;
    try {
      // wait until the library has loaded and any import in progress has finished
      for (let i = 0; i < 120 && (IMP.running || !S.tracks.size && !S.bootDone); i++) await new Promise(r => setTimeout(r, 1000));
      // your library has to arrive from the cloud first, so nothing already in it is added twice
      if (cloud.cloudConfigured() && (!S.user || !S.lastSync)) { setTimeout(() => DESK.scanNow(), 30000); return; }
      // one time: earlier versions could mark songs as done without adding them, so look at everything again
      if (!(await kv.get('deskSeenReset2', false))) { await kv.set('deskSeen', []); await kv.set('deskSeenReset2', true); }
      const seen = new Set(await kv.get('deskSeen', []));
      const byFile = new Map([...S.tracks.values()].map(t => [`${t.file || t.original?.file || ''}|${t.size || 0}`, t]));
      const have = new Set(byFile.keys());
      // songs already in your library that are also on this Mac play from the file, so they work with no internet
      const paths = {}; for (const f of list) { const t = byFile.get(`${f.name}|${f.size}`); if (t) paths[t.id] = f.path; }
      S.deskPaths = paths; kv.set('deskPaths', paths);
      const key = f => `${f.name}|${f.size}|${f.mtime}`;
      const fresh = list.filter(f => !seen.has(key(f)) && !have.has(`${f.name}|${f.size}`));
      const failed = new Set();
      for (let i = 0; i < fresh.length; i += 100) {
        const part = fresh.slice(i, i + 100);
        const read = await Promise.all(part.map(f => DESK.read(f.path).then(b => new File([b], f.name, { lastModified: f.mtime, type: '' })).catch(() => null)));
        part.forEach((f, k) => { if (!read[k]) failed.add(key(f)); });
        const files = read.filter(Boolean);
        // only count a batch as done once it has really gone through the importer
        if (!(await waitIdle())) { part.forEach(f => failed.add(key(f))); continue; }
        if (files.length) await importFiles(files, { background: true });
        for (const f of part) if (!failed.has(key(f))) seen.add(key(f));
        await kv.set('deskSeen', [...seen].slice(-30000));
      }
      if (fresh.length) setTimeout(autoUpload, 3000);
      for (const f of list) if (!failed.has(key(f))) seen.add(key(f));
      await kv.set('deskSeen', [...seen].slice(-30000));
      // anything that couldn't be read (still syncing, locked) gets another try in a couple of minutes
      if (failed.size) setTimeout(() => DESK.scanNow(), 120000);
    } catch (e) { console.warn('mac import', e); } finally {
      busy = false;
      if (pending) { const l = pending; pending = null; deskImport(l); }
    }
  }
  DESK.onFiles(deskImport);
  DESK.onControl(a => { if (a === 'toggle') toggle(); else if (a === 'next') next(); else if (a === 'prev') prev(); else if (a === 'flow') flow(); });
  const tell2 = () => { const t = current(); DESK.state({ title: t?.title || '', artist: t?.artist || '', playing: !engine.el.paused }); };
  engine.el.addEventListener('play', tell2); engine.el.addEventListener('pause', tell2); engine.el.addEventListener('loadedmetadata', tell2);
  setInterval(tell2, 5000);
}
