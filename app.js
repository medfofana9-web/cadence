import { db, kv, persist } from './lib/store.js';
import * as meta from './lib/meta.js';
import * as cloud from './lib/cloud.js';

/* ================= State ================= */
const S = {
  tracks: new Map(), playlists: new Map(), art: new Map(), history: [], searches: [],
  lists: {}, route: 'home', param: '', settings: {}, version: null, user: null,
};
const P = { queue: [], idx: -1, shuffle: false, repeat: 'off', context: '', contextRoute: '', autoAdded: new Set(), objUrl: null, counted: false, panel: 'lyrics', lyrics: null, lyricLine: -1, sleepAt: 0, sleepEnd: false, speed: 1 };
const DEFAULTS = { autoplay: true, accent: 'coral', autoFix: true, volume: 1 };
const ACCENTS = { coral: ['#ff6a4d', '255,106,77', '#1a0703'], amber: ['#f5b041', '245,176,65', '#1d1302'], sky: ['#5ab4ff', '90,180,255', '#03121f'], mint: ['#4fd1a1', '79,209,161', '#02180f'], lilac: ['#b69cff', '182,156,255', '#120a24'], white: ['#f4f4f5', '244,244,245', '#000000'] };
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1c1c1f"/><path d="M42 66a7 7 0 1 1-4-6.3V36l22-4.5v28.8a7 7 0 1 1-4-6.3V40.6l-14 2.9z" fill="#3a3a3f"/></svg>');

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const audio = $('#audio');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const mainArtist = a => (a || '').split(/ feat\. | & |, | x /i)[0].trim();
const tracksArr = () => [...S.tracks.values()];
const byAdded = (a, b) => (b.addedAt || 0) - (a.addedAt || 0);
const shuffleArr = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }

/* ================= Artwork ================= */
function artOf(t) {
  if (!t) return PLACEHOLDER;
  if (S.art.has(t.id)) return S.art.get(t.id);
  if (t.cloud) { const u = cloud.cachedUrl('art/' + t.id); if (u) return u; }
  return PLACEHOLDER;
}
async function setArt(id, blob) {
  await db.put('art', id, blob);
  const old = S.art.get(id); if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
  S.art.set(id, URL.createObjectURL(blob));
}

/* ================= Persistence ================= */
async function saveTrack(t, { sync = true } = {}) {
  S.tracks.set(t.id, t);
  await db.put('tracks', t.id, t);
  if (sync && S.user) cloud.saveTrack(t).catch(e => console.warn('sync', e));
}
async function savePlaylist(p) {
  p.updatedAt = Date.now();
  S.playlists.set(p.id, p);
  await db.put('playlists', p.id, p);
  if (S.user) cloud.savePlaylist(p).catch(() => {});
  renderSidebarPlaylists();
}
async function saveSettings() { await kv.set('settings', S.settings); applySettings(); }
function applySettings() {
  const [hex, rgb, ink] = ACCENTS[S.settings.accent] || ACCENTS.coral;
  const r = document.documentElement.style;
  r.setProperty('--accent', hex); r.setProperty('--tint', rgb); r.setProperty('--accent-ink', ink);
  r.setProperty('--accent-2', hex);
}

/* ================= Boot ================= */
async function boot() {
  persist();
  S.settings = { ...DEFAULTS, ...(await kv.get('settings', {})) };
  applySettings();
  for (const [id, t] of await db.all('tracks')) S.tracks.set(id, t);
  for (const [id, p] of await db.all('playlists')) S.playlists.set(id, p);
  for (const [id, b] of await db.all('art')) S.art.set(id, URL.createObjectURL(b));
  S.history = await kv.get('history', []);
  S.searches = await kv.get('searches', []);
  audio.volume = S.settings.volume ?? 1; $('#p-vol').value = Math.round(audio.volume * 100); paintRange($('#p-vol'));
  const saved = await kv.get('player', null);
  if (saved?.queue?.length) {
    P.queue = saved.queue.filter(id => S.tracks.has(id)); P.idx = Math.min(saved.idx, P.queue.length - 1);
    P.shuffle = saved.shuffle; P.repeat = saved.repeat; P.context = saved.context || ''; P.contextRoute = saved.contextRoute || '';
    if (P.idx >= 0) { await loadTrack(P.queue[P.idx], false); if (saved.time) audio.currentTime = saved.time; }
  }
  renderSidebarPlaylists();
  window.addEventListener('hashchange', route);
  route();
  updateModes();
  initCloud();
  checkVersion();
  setInterval(checkVersion, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function initCloud() {
  if (!cloud.cloudConfigured()) return;
  try {
    S.user = await cloud.user();
    if (S.user) await syncDown();
    const c = await cloud.sb();
    c.auth.onAuthStateChange((_e, session) => {
      const was = !!S.user; S.user = session?.user || null;
      if (!was && S.user) syncDown();
      if (S.route === 'settings') render();
    });
  } catch (e) { console.warn('cloud', e); }
}

async function syncDown() {
  try {
    const rows = await cloud.pullTracks();
    if (rows) {
      let changed = false;
      for (const r of rows) {
        const local = S.tracks.get(r.id);
        if (r.deleted) { if (local) { await removeLocal(r.id); changed = true; } continue; }
        const merged = { ...r.data, ...(local ? { local: local.local, plays: Math.max(local.plays || 0, r.data.plays || 0), liked: r.data.liked } : { local: false }), cloud: true };
        if (!local || JSON.stringify(local) !== JSON.stringify(merged)) { S.tracks.set(r.id, merged); await db.put('tracks', r.id, merged); changed = true; }
      }
      const needArt = rows.filter(r => !r.deleted && !S.art.has(r.id)).map(r => 'art/' + r.id);
      if (needArt.length) { await cloud.fileUrls(needArt); changed = true; cacheCloudArt(needArt.map(p => p.slice(4))); }
      if (changed) render();
    }
    const pls = await cloud.pullPlaylists();
    if (pls) {
      for (const r of pls) {
        if (r.deleted) { S.playlists.delete(r.id); await db.del('playlists', r.id); continue; }
        const local = S.playlists.get(r.id);
        if (!local || (r.data.updatedAt || 0) > (local.updatedAt || 0)) { S.playlists.set(r.id, r.data); await db.put('playlists', r.id, r.data); }
      }
      renderSidebarPlaylists();
    }
  } catch (e) { console.warn('syncDown', e); }
}
async function cacheCloudArt(ids) {
  for (const id of ids) {
    const u = cloud.cachedUrl('art/' + id); if (!u) continue;
    try { const b = await (await fetch(u)).blob(); if (b.size) await setArt(id, b); } catch {}
  }
}

/* ================= Version / updates ================= */
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
  await savePlayer();
  const reg = await navigator.serviceWorker?.getRegistration();
  await reg?.update().catch(() => {});
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  location.reload();
}

/* ================= Routing ================= */
function go(r) { location.hash = '#/' + r; }
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')) || 'home';
  const i = h.indexOf('/');
  S.route = i < 0 ? h : h.slice(0, i);
  S.param = i < 0 ? '' : h.slice(i + 1);
  $$('[data-route]').forEach(a => {
    const r = a.dataset.route;
    const on = r === S.route || (r === 'library' && ['songs', 'artists', 'albums', 'liked', 'playlist', 'artist', 'album', 'library'].includes(S.route));
    a.classList.toggle('active', on && !(r === 'library' && innerWidth > 820));
  });
  $$('#sidebar-playlists .nav-link').forEach(a => a.classList.toggle('active', S.route === 'playlist' && a.dataset.pl === S.param));
  render();
  $('#main').scrollTop = 0;
}
function render() {
  S.lists = {};
  const views = { home: vHome, search: vSearch, songs: vSongs, artists: vArtists, artist: vArtist, albums: vAlbums, album: vAlbum, liked: vLiked, playlist: vPlaylist, mix: vMix, library: vLibrary, import: vImport, settings: vSettings, category: vMix };
  const v = views[S.route] || vHome;
  const view = $('#view');
  view.innerHTML = v();
  view.style.animation = 'none'; void view.offsetWidth; view.style.animation = '';
  afterRender();
}
function afterRender() {
  if (S.route === 'search') { const i = $('#search-input'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  if (S.route === 'import') bindImport();
  markPlaying();
}

/* ================= Building blocks ================= */
function listKey(ids) { const k = 'l' + Object.keys(S.lists).length; S.lists[k] = ids; return k; }
function trackRows(tracks, { key, numbers = true, context = '' } = {}) {
  const ids = tracks.map(t => t.id);
  key = key || listKey(ids); S.lists[key] = ids; S.lists[key].context = context || S.lists[key].context;
  const head = `<div class="tracks-head"><div>#</div><div></div><div>Title</div><div>Album</div><div></div><div style="text-align:right">Time</div><div></div></div>`;
  return `${head}<div class="tracks">${tracks.map((t, i) => `
    <div class="track" data-id="${t.id}" data-list="${key}" data-i="${i}">
      <div class="num"><span class="n">${numbers ? i + 1 : ''}</span><span class="eq"><i></i><i></i><i></i></span></div>
      <div class="th"><img loading="lazy" src="${artOf(t)}" alt=""></div>
      <div style="min-width:0"><div class="tt ellipsis">${esc(t.title)}${t.explicit ? ' <span class="dim" style="font-size:11px">E</span>' : ''}</div><div class="ta ellipsis">${esc(t.artist)}</div></div>
      <div class="tal ellipsis">${esc(t.album || t.category || '')}</div>
      <button class="icon-btn like-btn ${t.liked ? 'on' : ''}" data-action="like" data-id="${t.id}" title="Like"><svg><use href="#i-heart"/></svg></button>
      <div class="td">${fmt(t.duration)}</div>
      <button class="icon-btn more" data-action="track-menu" data-id="${t.id}" title="More"><svg><use href="#i-more"/></svg></button>
    </div>`).join('')}</div>`;
}
function trackCard(t, key, i) {
  return `<div class="card" data-play-list="${key}" data-i="${i}">
    <div class="cover"><img loading="lazy" src="${artOf(t)}" alt=""><div class="hover-play"><svg><use href="#i-play"/></svg></div></div>
    <div class="t ellipsis">${esc(t.title)}</div><div class="s ellipsis">${esc(t.artist)}</div></div>`;
}
function collage(tracks) {
  const arts = [...new Set(tracks.map(artOf).filter(a => a !== PLACEHOLDER))];
  if (arts.length >= 4) return `<div class="cover collage">${arts.slice(0, 4).map(a => `<img loading="lazy" src="${a}" alt="">`).join('')}`;
  return `<div class="cover"><img loading="lazy" src="${arts[0] || PLACEHOLDER}" alt="">`;
}
function collCard({ href, title, sub, tracks, round = false, img }) {
  const key = listKey(tracks.map(t => t.id));
  const cover = img ? `<div class="cover"><img loading="lazy" src="${img}" alt="">` : collage(tracks);
  return `<div class="card ${round ? 'round' : ''}" data-href="${href}">${cover}<div class="hover-play" data-play-list="${key}" data-i="0"><svg><use href="#i-play"/></svg></div></div>
    <div class="t ellipsis">${esc(title)}</div><div class="s ellipsis">${esc(sub || '')}</div></div>`;
}
function shelf(title, inner, more) {
  if (!inner) return '';
  return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${more ? `<a href="#/${more}">See all</a>` : ''}</div><div class="shelf">${inner}</div></section>`;
}
function emptyLib() {
  return `<div class="empty-state"><div class="drop" style="border:0;background:none;padding:0"><div class="big-icon"><svg><use href="#i-note"/></svg></div></div>
    <h2>Your library is empty</h2><p>Bring in the music from your computer. Names get cleaned up and real artwork is found automatically.</p>
    <a class="btn primary" href="#/import"><svg><use href="#i-upload"/></svg>Add music</a></div>`;
}
const total = ts => { const s = ts.reduce((a, t) => a + (t.duration || 0), 0); const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`; };
const count = n => `${n} song${n === 1 ? '' : 's'}`;
function collHead({ img, tracks, eyebrow, title, meta, round, actions = '' }) {
  const key = listKey(tracks.map(t => t.id));
  return `<div class="coll-head"><div class="coll-art ${round ? 'round' : ''}">${img ? `<img src="${img}" alt="">` : collage(tracks).replace('class="cover', 'style="width:100%;height:100%" class="cover') + '</div>'}</div>
    <div style="min-width:0"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><div class="meta">${meta}</div>
    <div class="row-actions">${tracks.length ? `<button class="btn primary" data-play-list="${key}" data-i="0"><svg><use href="#i-play"/></svg>Play</button>
    <button class="btn" data-play-list="${key}" data-shuffle="1"><svg><use href="#i-shuffle"/></svg>Shuffle</button>` : ''}${actions}</div></div></div>`;
}

/* ================= Groupings ================= */
function groups(kind) {
  const m = new Map();
  for (const t of tracksArr()) {
    let k;
    if (kind === 'artist') k = mainArtist(t.artist);
    else if (kind === 'album') { if (!t.album) continue; k = `${t.album}\u0001${mainArtist(t.artist)}`; }
    else if (kind === 'mix') k = t.category === 'Music' ? (t.genre || 'Music') : t.category;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return m;
}
function recentTracks(n = 20) { return S.history.map(id => S.tracks.get(id)).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).slice(0, n); }

/* ================= Views ================= */
function vHome() {
  const all = tracksArr();
  if (!all.length) return `<div class="page-head"><h1>${greeting()}</h1></div>${emptyLib()}`;
  const recent = recentTracks(14);
  const hero = recent[0] || all.sort(byAdded)[0];
  const heroKey = listKey((recent.length ? recent : [hero]).map(t => t.id));
  const added = [...all].sort(byAdded).slice(0, 14); const addedKey = listKey(added.map(t => t.id));
  const recKey = listKey(recent.map(t => t.id));
  const mixes = [...groups('mix')].filter(([, ts]) => ts.length >= 1).sort((a, b) => b[1].length - a[1].length);
  const artists = [...groups('artist')].filter(([a]) => a !== 'Unknown Artist').sort((a, b) => plays(b[1]) - plays(a[1]) || b[1].length - a[1].length).slice(0, 14);
  const liked = all.filter(t => t.liked);
  const pls = [...S.playlists.values()];
  const rotation = [...all].filter(t => t.plays).sort((a, b) => b.plays - a.plays).slice(0, 14); const rotKey = listKey(rotation.map(t => t.id));
  return `
  <div class="page-head"><div><div class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>${greeting()}</h1></div></div>
  <div class="hero"><div class="hero-bg" style="background-image:url('${artOf(hero)}')"></div>
    <div class="hero-inner"><div class="hero-art"><img src="${artOf(hero)}" alt=""></div>
    <div style="min-width:0"><div class="eyebrow">${recent.length ? 'Pick up where you left off' : 'Newest in your library'}</div>
    <h1 class="ellipsis">${esc(hero.title)}</h1><div class="sub">${esc(hero.artist)}${hero.album ? ' · ' + esc(hero.album) : ''}</div>
    <div class="row-actions"><button class="btn primary" data-play-list="${heroKey}" data-i="0"><svg><use href="#i-play"/></svg>Play</button>
    <button class="btn ghost" data-action="radio" data-id="${hero.id}">Start a station</button></div></div></div></div>
  ${shelf('Made for you', mixes.map(([k, ts]) => collCard({ href: 'mix/' + k, title: mixName(k), sub: `${count(ts.length)}`, tracks: ts })).join('') + (liked.length ? collCard({ href: 'liked', title: 'Liked Songs', sub: count(liked.length), tracks: liked }) : ''))}
  ${recent.length ? shelf('Recently played', recent.map((t, i) => trackCard(t, recKey, i)).join('')) : ''}
  ${shelf('Recently added', added.map((t, i) => trackCard(t, addedKey, i)).join(''), 'songs')}
  ${rotation.length >= 4 ? shelf('On repeat', rotation.map((t, i) => trackCard(t, rotKey, i)).join('')) : ''}
  ${pls.length ? shelf('Your playlists', pls.map(p => collCard({ href: 'playlist/' + p.id, title: p.name, sub: count(p.tracks.length), tracks: p.tracks.map(id => S.tracks.get(id)).filter(Boolean) })).join('')) : ''}
  ${artists.length ? shelf('Artists', artists.map(([a, ts]) => collCard({ href: 'artist/' + a, title: a, sub: 'Artist', tracks: ts, round: true, img: artOf(ts.find(t => S.art.has(t.id)) || ts[0]) })).join(''), 'artists') : ''}`;
}
const plays = ts => ts.reduce((a, t) => a + (t.plays || 0), 0);
function greeting() { const h = new Date().getHours(); return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function mixName(k) { return k === 'Quran & Recitation' ? 'Quran & Recitation' : k === 'Talks & Lectures' ? 'Talks & Lectures' : k === 'Nasheeds' ? 'Nasheeds' : `${k} Mix`; }

function vSearch() {
  const q = S.param;
  const input = `<div class="search-box"><svg><use href="#i-search"/></svg><input id="search-input" class="input" placeholder="Songs, artists, albums" value="${esc(q)}" autocomplete="off" spellcheck="false"></div>`;
  if (!q) {
    const gs = [...groups('mix')];
    const colors = ['#7a2e22', '#1f4d45', '#2c3567', '#5b3a12', '#4a2350', '#1e4a2a', '#5a1f33', '#203f5c'];
    return `<div class="page-head"><h1>Search</h1></div>${input}
      ${S.searches.length ? `<section class="section"><div class="section-head"><h2>Recent searches</h2><a data-action="clear-searches">Clear</a></div><div class="chips" style="margin:0">${S.searches.map(s => `<button class="chip" data-search="${esc(s)}">${esc(s)}</button>`).join('')}</div></section>` : ''}
      ${gs.length ? `<section class="section"><div class="section-head"><h2>Browse</h2></div><div class="genre-grid">${gs.map(([k, ts], i) => `<div class="genre" data-href="mix/${esc(k)}" style="background:${colors[i % colors.length]}">${esc(k)}<img src="${artOf(ts.find(t => S.art.has(t.id)) || ts[0])}" alt=""></div>`).join('')}</div></section>` : ''}`;
  }
  const n = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const terms = n(q).split(/\s+/).filter(Boolean);
  const hit = t => { const h = n(`${t.title} ${t.artist} ${t.album} ${t.genre} ${t.category}`); return terms.every(w => h.includes(w)); };
  const songs = tracksArr().filter(hit).sort((a, b) => (n(b.title).startsWith(terms[0]) - n(a.title).startsWith(terms[0])) || (b.plays || 0) - (a.plays || 0));
  const artists = [...groups('artist')].filter(([a]) => terms.every(w => n(a).includes(w)));
  const albums = [...groups('album')].filter(([k]) => terms.every(w => n(k).includes(w)));
  if (!songs.length && !artists.length) return `<div class="page-head"><h1>Search</h1></div>${input}<div class="empty-state"><h2>No results for “${esc(q)}”</h2><p>Check the spelling, or try an artist or album name.</p></div>`;
  const top = artists[0] && (!songs[0] || n(artists[0][0]).startsWith(terms[0])) ? null : songs[0];
  return `<div class="page-head"><h1>Search</h1></div>${input}
    ${artists.length ? shelf('Artists', artists.map(([a, ts]) => collCard({ href: 'artist/' + a, title: a, sub: 'Artist', tracks: ts, round: true, img: artOf(ts.find(t => S.art.has(t.id)) || ts[0]) })).join('')) : ''}
    ${songs.length ? `<section class="section"><div class="section-head"><h2>Songs</h2></div>${trackRows(songs.slice(0, 50), { context: 'Search' })}</section>` : ''}
    ${albums.length ? shelf('Albums', albums.map(([k, ts]) => { const [al, ar] = k.split('\u0001'); return collCard({ href: 'album/' + k, title: al, sub: ar, tracks: ts }); }).join('')) : ''}`;
}

const SORTS = { added: ['Recently added', byAdded], title: ['Title', (a, b) => a.title.localeCompare(b.title)], artist: ['Artist', (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title)], plays: ['Most played', (a, b) => (b.plays || 0) - (a.plays || 0)] };
function vSongs() {
  const all = tracksArr(); if (!all.length) return `<div class="page-head"><h1>Songs</h1></div>${emptyLib()}`;
  const sort = S.settings.songSort || 'added';
  const cats = [...new Set(all.map(t => t.category))];
  const cat = S.param && cats.includes(S.param) ? S.param : '';
  const list = all.filter(t => !cat || t.category === cat).sort(SORTS[sort][1]);
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Songs</h1></div>
    <div class="row-actions"><div class="seg">${Object.entries(SORTS).map(([k, [l]]) => `<button class="${k === sort ? 'on' : ''}" data-action="sort" data-sort="${k}">${l}</button>`).join('')}</div></div></div>
    ${cats.length > 1 ? `<div class="chips"><button class="chip ${!cat ? 'on' : ''}" data-href="songs">All</button>${cats.map(c => `<button class="chip ${c === cat ? 'on' : ''}" data-href="songs/${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
    <div class="row-actions" style="margin-bottom:18px">${(() => { const k = listKey(list.map(t => t.id)); return `<button class="btn primary" data-play-list="${k}" data-i="0"><svg><use href="#i-play"/></svg>Play</button><button class="btn" data-play-list="${k}" data-shuffle="1"><svg><use href="#i-shuffle"/></svg>Shuffle</button>`; })()}<span class="muted" style="align-self:center;font-size:13px">${count(list.length)} · ${total(list)}</span></div>
    ${trackRows(list, { context: cat || 'Songs' })}`;
}
function vArtists() {
  const g = [...groups('artist')].sort((a, b) => a[0].localeCompare(b[0]));
  if (!g.length) return `<div class="page-head"><h1>Artists</h1></div>${emptyLib()}`;
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Artists</h1></div></div><div class="grid">${g.map(([a, ts]) => collCard({ href: 'artist/' + a, title: a, sub: count(ts.length), tracks: ts, round: true, img: artOf(ts.find(t => S.art.has(t.id)) || ts[0]) })).join('')}</div>`;
}
function vArtist() {
  const name = S.param; const ts = (groups('artist').get(name) || []).sort((a, b) => (b.plays || 0) - (a.plays || 0) || byAdded(a, b));
  const albums = [...groups('album')].filter(([k]) => k.split('\u0001')[1] === name);
  const img = artOf(ts.find(t => S.art.has(t.id)) || ts[0]);
  return `<button class="icon-btn" data-action="back" style="margin-bottom:8px"><svg><use href="#i-back"/></svg></button>
    ${collHead({ img, tracks: ts, eyebrow: 'Artist', title: name, meta: `${count(ts.length)} · ${total(ts)}`, round: true, actions: `<button class="btn ghost" data-action="radio-artist" data-name="${esc(name)}">Station</button>` })}
    <section class="section"><div class="section-head"><h2>Songs</h2></div>${trackRows(ts, { context: name })}</section>
    ${albums.length ? shelf('Albums', albums.map(([k, a]) => collCard({ href: 'album/' + k, title: k.split('\u0001')[0], sub: (a[0].year || '') + '', tracks: a })).join('')) : ''}`;
}
function vAlbums() {
  const g = [...groups('album')].sort((a, b) => a[0].localeCompare(b[0]));
  if (!g.length) return `<div class="page-head"><h1>Albums</h1></div>${tracksArr().length ? '<div class="empty-state"><h2>No albums yet</h2><p>Songs with an album name show up here. You can add one from a song’s Edit info.</p></div>' : emptyLib()}`;
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Albums</h1></div></div><div class="grid">${g.map(([k, ts]) => { const [al, ar] = k.split('\u0001'); return collCard({ href: 'album/' + k, title: al, sub: ar, tracks: ts }); }).join('')}</div>`;
}
function vAlbum() {
  const [al, ar] = S.param.split('\u0001');
  const ts = (groups('album').get(S.param) || []).sort((a, b) => (parseInt(a.trackNo) || 99) - (parseInt(b.trackNo) || 99));
  return `<button class="icon-btn" data-action="back" style="margin-bottom:8px"><svg><use href="#i-back"/></svg></button>
    ${collHead({ img: artOf(ts[0]), tracks: ts, eyebrow: 'Album', title: al, meta: `<a href="#/artist/${encodeURIComponent(ar)}" style="color:var(--text);font-weight:600">${esc(ar)}</a>${ts[0]?.year ? ' · ' + ts[0].year : ''} · ${count(ts.length)}, ${total(ts)}` })}
    ${trackRows(ts, { context: al })}`;
}
function vLiked() {
  const ts = tracksArr().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
  return `${collHead({ img: null, tracks: ts, eyebrow: 'Playlist', title: 'Liked Songs', meta: ts.length ? `${count(ts.length)} · ${total(ts)}` : 'Tap the heart on any song to save it here.' })}${ts.length ? trackRows(ts, { context: 'Liked Songs' }) : ''}`;
}
function vPlaylist() {
  const p = S.playlists.get(S.param);
  if (!p) return `<div class="empty-state"><h2>Playlist not found</h2></div>`;
  const ts = p.tracks.map(id => S.tracks.get(id)).filter(Boolean);
  return `${collHead({ img: null, tracks: ts, eyebrow: 'Playlist', title: p.name, meta: ts.length ? `${count(ts.length)} · ${total(ts)}` : 'Add songs from any song’s ••• menu.', actions: `<button class="icon-btn" data-action="playlist-menu" data-pl="${p.id}"><svg><use href="#i-more"/></svg></button>` })}
    ${ts.length ? trackRows(ts, { context: p.name, key: 'pl:' + p.id }) : ''}`;
}
function vMix() {
  const k = S.param; const ts = shuffleArr(groups('mix').get(k) || []);
  return `<button class="icon-btn" data-action="back" style="margin-bottom:8px"><svg><use href="#i-back"/></svg></button>
    ${collHead({ img: null, tracks: ts, eyebrow: 'Mix', title: mixName(k), meta: `${count(ts.length)} · ${total(ts)} · Refreshes every visit` })}${trackRows(ts, { context: mixName(k) })}`;
}
function vLibrary() {
  const pls = [...S.playlists.values()];
  const row = (href, icon, label, n) => `<a class="nav-link" href="#/${href}" style="padding:14px 4px;border-bottom:1px solid var(--line);border-radius:0;font-size:17px"><svg style="color:var(--accent)"><use href="#i-${icon}"/></svg>${label}<span class="muted" style="margin-left:auto;font-size:14px">${n ?? ''}</span></a>`;
  return `<div class="page-head"><h1>Library</h1><a class="icon-btn" href="#/settings"><svg><use href="#i-gear"/></svg></a></div>
    ${row('songs', 'note', 'Songs', S.tracks.size)}${row('artists', 'mic', 'Artists', groups('artist').size)}${row('albums', 'album', 'Albums', groups('album').size)}${row('liked', 'heart', 'Liked Songs', tracksArr().filter(t => t.liked).length)}
    <section class="section"><div class="section-head"><h2>Playlists</h2><a data-action="new-playlist">New playlist</a></div>
    ${pls.length ? `<div class="grid">${pls.map(p => collCard({ href: 'playlist/' + p.id, title: p.name, sub: count(p.tracks.length), tracks: p.tracks.map(id => S.tracks.get(id)).filter(Boolean) })).join('')}</div>` : '<p class="muted">No playlists yet.</p>'}</section>`;
}

/* ================= Import ================= */
const importJobs = [];
function vImport() {
  const signedOut = cloud.cloudConfigured() && !S.user;
  return `<div class="page-head"><div><div class="eyebrow">Library</div><h1>Add music</h1></div></div>
    <div class="drop" id="drop"><div class="big-icon"><svg><use href="#i-upload"/></svg></div>
      <h2>Drop your music here</h2><p>Drag in your whole Music folder or any songs. MP3, M4A, FLAC, WAV and more. Songs already in your library are skipped.</p>
      <div class="row-actions" style="justify-content:center"><button class="btn primary" data-action="pick-folder"><svg><use href="#i-album"/></svg>Choose a folder</button><button class="btn" data-action="pick-files"><svg><use href="#i-note"/></svg>Choose songs</button></div>
    </div>
    ${signedOut ? `<p class="muted" style="margin-top:14px;font-size:13px">You’re not signed in, so new songs will only be on this device. <a href="#/settings" style="color:var(--accent)">Sign in</a> to have them on all your devices.</p>` : ''}
    <div class="tips">
      <div class="tip"><b>On a Mac</b><span>Your songs are in Music → Media → Music. Choose that folder and everything inside comes in.</span></div>
      <div class="tip"><b>Names cleaned up</b><span>Titles like “Lyrics 🔥” or “Official Visualizer” are fixed, and real album artwork is found.</span></div>
      <div class="tip"><b>Change anything later</b><span>Open a song’s ••• menu and choose Edit info to fix a name or swap the artwork.</span></div>
    </div>
    <div class="import-list" id="import-list">${importJobs.map(importRow).join('')}</div>`;
}
function importRow(j) {
  return `<div class="import-row" id="imp-${j.key}"><div class="th"><img src="${j.art || PLACEHOLDER}" alt=""></div>
    <div style="min-width:0"><div class="ellipsis" style="font-weight:500">${esc(j.title || j.name)}</div><div class="ellipsis muted" style="font-size:13px">${esc(j.artist || j.name)}</div></div>
    <div class="st ${j.state === 'done' ? 'ok' : j.state === 'error' ? 'err' : ''}">${esc(j.status)}</div></div>`;
}
function updateImportRow(j) { const el = document.getElementById('imp-' + j.key); if (el) el.outerHTML = importRow(j); }
function bindImport() {
  const d = $('#drop'); if (!d) return;
  d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('over'); });
  d.addEventListener('dragleave', () => d.classList.remove('over'));
}

async function filesFromDrop(dt) {
  const out = [];
  const walk = async entry => {
    if (entry.isFile) { await new Promise(r => entry.file(f => { out.push(f); r(); }, r)); }
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch; do { batch = await new Promise(r => reader.readEntries(r, () => r([]))); for (const e of batch) await walk(e); } while (batch.length);
    }
  };
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const e of entries) await walk(e); else out.push(...dt.files);
  return out;
}

async function importFiles(files) {
  files = files.filter(f => meta.AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
  if (!files.length) { toast('No songs found there'); return; }
  if (S.route !== 'import') go('import');
  const jobs = files.map(f => ({ key: uid(), file: f, name: f.name.replace(/\.[^.]+$/, ''), status: 'Waiting', state: 'wait' }));
  importJobs.unshift(...jobs);
  const list = $('#import-list'); if (list) list.innerHTML = importJobs.map(importRow).join('');
  let added = 0, skipped = 0;
  const work = async j => {
    try {
      const r = await importOne(j);
      if (r === 'skip') skipped++; else added++;
    } catch (e) { console.error(e); j.state = 'error'; j.status = 'Couldn’t read'; updateImportRow(j); }
  };
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) await work(queue.shift()); }));
  toast(added ? `Added ${count(added)}${skipped ? ` · ${skipped} already here` : ''}` : 'Those songs are already in your library');
}

async function importOne(j) {
  const f = j.file;
  const id = await meta.trackId(f);
  if (S.tracks.has(id)) { j.state = 'done'; j.status = 'Already here'; const t = S.tracks.get(id); j.title = t.title; j.artist = t.artist; j.art = artOf(t); updateImportRow(j); return 'skip'; }
  j.status = 'Reading'; updateImportRow(j);
  const tags = await meta.readTags(f);
  const names = meta.cleanNames(tags, f.name);
  const t = { id, ...names, genre: tags.genre || '', year: tags.year || '', trackNo: tags.track || '', file: f.name, size: f.size, type: f.type || 'audio/mpeg', addedAt: Date.now(), plays: 0, liked: false, local: true, cloud: false };
  t.category = meta.categorize(t);
  j.title = t.title; j.artist = t.artist; updateImportRow(j);
  let artBlob = null;
  if (S.settings.autoFix && t.category === 'Music') {
    j.status = 'Finding artwork'; updateImportRow(j);
    const found = await meta.lookup(t);
    if (found) {
      Object.assign(t, { title: found.title, artist: found.artist, album: found.album || t.album, genre: found.genre || t.genre, year: found.year || t.year, explicit: found.explicit, matched: true });
      try { artBlob = await meta.fetchImage(found.artUrl); } catch {}
    }
  }
  if (!artBlob && tags.picture?.size > 2000) artBlob = tags.picture;
  if (!artBlob) { artBlob = await meta.makeCover(t.title, t.artist, t.category); t.designedCover = true; }
  t.category = meta.categorize(t);
  t.duration = await meta.audioDuration(f);
  await db.put('audio', id, f);
  await setArt(id, artBlob);
  await saveTrack(t, { sync: false });
  j.title = t.title; j.artist = t.artist; j.art = artOf(t);
  if (S.user) {
    j.status = 'Uploading'; updateImportRow(j);
    await uploadTrack(t, f, artBlob);
  }
  j.state = 'done'; j.status = S.user ? 'Added · in cloud' : 'Added'; updateImportRow(j);
  return 'ok';
}
async function uploadTrack(t, audioBlob, artBlob) {
  await cloud.uploadFile('audio/' + t.id, audioBlob);
  if (artBlob) await cloud.uploadFile('art/' + t.id, artBlob);
  t.cloud = true;
  await saveTrack(t);
}

/* ================= Settings ================= */
function vSettings() {
  const sw = (key, label, sub) => `<div class="set-row"><div class="lbl"><b>${label}</b><span>${sub}</span></div><button class="switch ${S.settings[key] ? 'on' : ''}" data-action="toggle-setting" data-key="${key}"></button></div>`;
  let account;
  if (!cloud.cloudConfigured()) account = `<div class="set-row"><div class="lbl"><b>Cloud library</b><span>Not connected yet. Songs stay on this device for now.</span></div></div>`;
  else if (!S.user) account = `<div class="set-row" style="display:block"><div class="lbl" style="margin-bottom:12px"><b>Sign in</b><span>Use the same login on every device to get the same library.</span></div>
      <div class="field"><input class="input" id="auth-email" type="email" placeholder="Email" autocomplete="email"></div>
      <div class="field"><input class="input" id="auth-pass" type="password" placeholder="Password" autocomplete="current-password"></div>
      <div class="row-actions"><button class="btn primary" data-action="sign-in">Sign in</button><button class="btn" data-action="sign-up">Create account</button></div></div>`;
  else {
    const localOnly = tracksArr().filter(t => t.local && !t.cloud).length;
    account = `<div class="set-row"><div class="lbl"><b>${esc(S.user.email)}</b><span>Signed in · your library syncs to every device</span></div><button class="btn ghost" data-action="sign-out">Sign out</button></div>
      <div class="set-row"><div class="lbl"><b>Sync now</b><span>Pull changes made on your other devices</span></div><button class="btn" data-action="sync">Sync</button></div>
      ${localOnly ? `<div class="set-row"><div class="lbl"><b>${count(localOnly)} only on this device</b><span>Upload them so your phone can play them too</span></div><button class="btn primary" data-action="upload-local">Upload</button></div>` : ''}`;
  }
  return `<div class="page-head"><h1>Settings</h1></div>
    <div class="settings-group"><h3>Account</h3>${account}</div>
    <div class="settings-group"><h3>Playback</h3>
      ${sw('autoplay', 'Autoplay', 'When your music ends, keep playing similar songs from your library')}
    </div>
    <div class="settings-group"><h3>Look</h3>
      <div class="set-row"><div class="lbl"><b>Accent color</b><span>Buttons, highlights and the playing song</span></div>
      <div class="swatches">${Object.entries(ACCENTS).map(([k, [hex]]) => `<button class="swatch ${S.settings.accent === k ? 'on' : ''}" style="background:${hex}" data-action="accent" data-accent="${k}" title="${k}"></button>`).join('')}</div></div>
    </div>
    <div class="settings-group"><h3>Library</h3>
      ${sw('autoFix', 'Fix names and artwork on import', 'Clean up messy titles and find real album artwork')}
      <div class="set-row"><div class="lbl"><b>Fix all songs again</b><span>Re-check every song’s name and artwork</span></div><button class="btn" data-action="refix-all">Fix all</button></div>
      <div class="set-row"><div class="lbl"><b>Storage on this device</b><span id="storage-used">${count(S.tracks.size)}</span></div><button class="btn ghost" data-action="clear-device">Remove downloads</button></div>
    </div>
    <div class="settings-group"><h3>About</h3>
      <div class="set-row"><div class="lbl"><b>Cadence</b><span>Version ${esc((S.version || 'dev').slice(0, 7))}</span></div><button class="btn" data-action="check-update">Check for updates</button></div>
    </div>`;
}

/* ================= Player ================= */
async function srcFor(t) {
  const blob = t.local ? await db.get('audio', t.id) : null;
  if (blob) { if (P.objUrl) URL.revokeObjectURL(P.objUrl); P.objUrl = URL.createObjectURL(blob); return P.objUrl; }
  if (t.cloud) return await cloud.fileUrl('audio/' + t.id);
  return null;
}
async function loadTrack(id, autoplay = true) {
  const t = S.tracks.get(id); if (!t) return;
  const src = await srcFor(t);
  if (!src) { toast(S.user || !cloud.cloudConfigured() ? 'That song isn’t available on this device' : 'Sign in to play songs from your cloud library'); return false; }
  audio.src = src; audio.playbackRate = P.speed;
  P.counted = false; P.lyrics = null; P.lyricLine = -1;
  paintNow(t);
  if (autoplay) { try { await audio.play(); } catch (e) { console.warn(e); } }
  updateMediaSession(t);
  savePlayer();
  if ($('#now').classList.contains('open') && P.panel === 'lyrics') renderPanel();
  prefetchNext();
  return true;
}
function prefetchNext() {
  const ids = P.queue.slice(P.idx + 1, P.idx + 4).map(id => S.tracks.get(id)).filter(t => t && t.cloud && !t.local);
  if (ids.length && S.user) cloud.fileUrls(ids.map(t => 'audio/' + t.id)).catch(() => {});
}
function current() { return S.tracks.get(P.queue[P.idx]); }

async function playList(ids, start = 0, { shuffle = false, context = '' } = {}) {
  ids = ids.filter(id => S.tracks.has(id));
  if (!ids.length) return;
  if (shuffle) { P.shuffle = true; const first = ids[Math.floor(Math.random() * ids.length)]; ids = [first, ...shuffleArr(ids.filter(x => x !== first))]; start = 0; }
  else if (P.shuffle) { const first = ids[start]; ids = [first, ...shuffleArr(ids.filter((x, i) => i !== start))]; start = 0; }
  P.queue = ids; P.idx = start; P.autoAdded = new Set();
  P.context = context; P.contextRoute = location.hash;
  updateModes();
  await loadTrack(P.queue[P.idx]);
}
async function next(auto = false) {
  if (!P.queue.length) return;
  if (auto && P.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (P.idx + 1 < P.queue.length) { P.idx++; return loadTrack(P.queue[P.idx]); }
  if (P.repeat === 'all') { P.idx = 0; return loadTrack(P.queue[0]); }
  if (S.settings.autoplay) {
    const more = similar(current(), 12);
    if (more.length) { more.forEach(id => P.autoAdded.add(id)); P.queue.push(...more); P.idx++; return loadTrack(P.queue[P.idx]); }
  }
  if (auto) { audio.pause(); audio.currentTime = 0; }
}
function prev() {
  if (audio.currentTime > 3 || P.idx === 0) { audio.currentTime = 0; return; }
  P.idx--; loadTrack(P.queue[P.idx]);
}
function toggle() { if (!audio.src) { const ids = tracksArr().sort(byAdded).map(t => t.id); if (ids.length) playList(ids, 0, { context: 'Your library' }); return; } audio.paused ? audio.play() : audio.pause(); }

/** Picks songs from your library that fit what's playing: same artist, same kind of music, songs you like. */
function similar(seed, n = 12) {
  if (!seed) return [];
  const recent = new Set([...P.queue.slice(-30), ...S.history.slice(0, 20)]);
  const sa = mainArtist(seed.artist);
  const scored = tracksArr().filter(t => t.id !== seed.id).map(t => {
    let s = Math.random() * 1.5;
    if (t.category === seed.category) s += 3; else s -= 4;
    if (mainArtist(t.artist) === sa) s += 2.5;
    if (t.artist.includes(sa) || seed.artist.includes(mainArtist(t.artist))) s += 1;
    if (t.genre && t.genre === seed.genre) s += 2;
    if (t.album && t.album === seed.album) s += .5;
    if (t.liked) s += 1.2;
    s += Math.min(t.plays || 0, 10) * .1;
    if (recent.has(t.id)) s -= 3;
    return [s, t.id];
  }).sort((a, b) => b[0] - a[0]);
  return scored.slice(0, n).map(x => x[1]);
}

function addHistory(id) {
  S.history = [id, ...S.history.filter(x => x !== id)].slice(0, 200);
  kv.set('history', S.history);
}
let saveT;
function savePlayer() { clearTimeout(saveT); saveT = setTimeout(() => kv.set('player', { queue: P.queue, idx: P.idx, shuffle: P.shuffle, repeat: P.repeat, context: P.context, contextRoute: P.contextRoute, time: audio.currentTime || 0 }), 400); }

function paintRange(el) { const p = (el.value - el.min) / (el.max - el.min) * 100; el.style.setProperty('--p', p + '%'); }
function paintNow(t) {
  $('#player').classList.remove('empty');
  const art = artOf(t);
  $('#p-art').src = art; $('#now-art').src = art; $('#now-bg').src = art;
  $('#p-title').textContent = t.title; $('#p-artist').textContent = t.artist;
  $('#now-title').textContent = t.title; $('#now-artist').textContent = t.artist;
  $('#now-from').textContent = P.context ? 'Playing from ' + P.context : '';
  ['#p-like', '#now-like'].forEach(s => $(s).classList.toggle('on', !!t.liked));
  document.title = `${t.title} · ${t.artist}`;
  markPlaying();
}
function markPlaying() {
  const id = P.queue[P.idx];
  $$('.track').forEach(r => r.classList.toggle('playing', r.dataset.id === id));
  document.body.classList.toggle('paused', audio.paused);
}
function updatePlayIcons() {
  const icon = audio.paused ? '#i-play' : '#i-pause';
  ['#p-play', '#now-play', '#p-play-mini'].forEach(s => $(s + ' use').setAttribute('href', icon));
  $('#now').classList.toggle('paused', audio.paused);
  document.body.classList.toggle('paused', audio.paused);
}
function updateModes() {
  ['#p-shuffle', '#now-shuffle'].forEach(s => $(s).classList.toggle('on', P.shuffle));
  ['#p-repeat', '#now-repeat'].forEach(s => { $(s).classList.toggle('on', P.repeat !== 'off'); $(s + ' use').setAttribute('href', P.repeat === 'one' ? '#i-repeat1' : '#i-repeat'); });
}
let seeking = false;
function onTime() {
  const d = audio.duration || 0, c = audio.currentTime || 0;
  if (!seeking) {
    for (const s of ['#p-seek', '#now-seek']) { const el = $(s); el.value = d ? c / d * 1000 : 0; paintRange(el); }
    $('#p-cur').textContent = $('#now-cur').textContent = fmt(c);
    $('#p-dur').textContent = $('#now-dur').textContent = '-' + fmt(d - c);
  }
  $('#p-mini-bar').style.width = (d ? c / d * 100 : 0) + '%';
  const t = current();
  if (t && !P.counted && c > Math.min(30, d * .5)) {
    P.counted = true; t.plays = (t.plays || 0) + 1; t.lastPlayed = Date.now(); saveTrack(t); addHistory(t.id);
  }
  if (P.lyrics?.lines && P.panel === 'lyrics') syncLyrics(c);
  if (P.sleepAt && Date.now() >= P.sleepAt) { audio.pause(); clearSleep(); toast('Sleep timer ended'); }
  if (P.sleepAt) $('#sleep-btn span').textContent = fmt((P.sleepAt - Date.now()) / 1000);
  if (Math.floor(c) % 5 === 0) savePlayer();
  if ('mediaSession' in navigator && d && isFinite(d)) { try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: audio.playbackRate }); } catch {} }
}
audio.addEventListener('timeupdate', onTime);
audio.addEventListener('loadedmetadata', () => { const t = current(); if (t && (!t.duration || Math.abs(t.duration - audio.duration) > 2) && isFinite(audio.duration)) { t.duration = audio.duration; saveTrack(t, { sync: false }); } onTime(); });
audio.addEventListener('play', updatePlayIcons);
audio.addEventListener('pause', () => { updatePlayIcons(); savePlayer(); });
audio.addEventListener('ended', () => { if (P.sleepEnd) { clearSleep(); toast('Sleep timer ended'); return; } next(true); });
audio.addEventListener('error', () => { if (audio.src) toast('That song couldn’t be played'); });

function bindSeek(sel) {
  const el = $(sel);
  el.addEventListener('input', () => { seeking = true; paintRange(el); const d = audio.duration || 0; const c = el.value / 1000 * d; $('#p-cur').textContent = $('#now-cur').textContent = fmt(c); });
  el.addEventListener('change', () => { const d = audio.duration || 0; audio.currentTime = el.value / 1000 * d; seeking = false; });
}
bindSeek('#p-seek'); bindSeek('#now-seek');
$('#p-vol').addEventListener('input', e => { audio.volume = e.target.value / 100; paintRange(e.target); S.settings.volume = audio.volume; kv.set('settings', S.settings); });

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || t.category || '', artwork: [{ src: artOf(t), sizes: '800x800', type: 'image/jpeg' }] });
  const h = { play: () => audio.play(), pause: () => audio.pause(), previoustrack: prev, nexttrack: () => next(), seekto: e => { audio.currentTime = e.seekTime; }, seekbackward: () => { audio.currentTime -= 10; }, seekforward: () => { audio.currentTime += 10; } };
  for (const [k, f] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, f); } catch {} }
}

/* Sleep timer & speed */
function clearSleep() { P.sleepAt = 0; P.sleepEnd = false; $('#sleep-btn').classList.remove('on'); $('#sleep-btn span').textContent = 'Sleep'; }
function sleepMenu(e) {
  menu(e, [
    ['15 minutes', () => setSleep(15)], ['30 minutes', () => setSleep(30)], ['45 minutes', () => setSleep(45)], ['1 hour', () => setSleep(60)],
    ['End of this song', () => { clearSleep(); P.sleepEnd = true; $('#sleep-btn').classList.add('on'); $('#sleep-btn span').textContent = 'End of song'; }],
    ...(P.sleepAt || P.sleepEnd ? [null, ['Turn off', clearSleep]] : []),
  ]);
}
function setSleep(m) { P.sleepEnd = false; P.sleepAt = Date.now() + m * 60000; $('#sleep-btn').classList.add('on'); toast(`Music stops in ${m < 60 ? m + ' minutes' : '1 hour'}`); }
const SPEEDS = [1, 1.25, 1.5, 2, .75];
function cycleSpeed() { P.speed = SPEEDS[(SPEEDS.indexOf(P.speed) + 1) % SPEEDS.length]; audio.playbackRate = P.speed; $('#speed-btn').textContent = P.speed + '×'; $('#speed-btn').classList.toggle('on', P.speed !== 1); }

/* ================= Now playing ================= */
function openNow(panel) {
  if (!current()) return;
  const n = $('#now'); n.classList.add('open'); n.setAttribute('aria-hidden', 'false');
  if (panel) { P.panel = panel; n.classList.add('panel-open'); } else if (innerWidth <= 820) n.classList.remove('panel-open');
  renderPanel();
}
function closeNow() { const n = $('#now'); n.classList.remove('open', 'panel-open'); n.setAttribute('aria-hidden', 'true'); }
async function renderPanel() {
  $('#tab-lyrics').classList.toggle('on', P.panel === 'lyrics' && ($('#now').classList.contains('panel-open') || innerWidth > 820));
  $('#tab-queue').classList.toggle('on', P.panel === 'queue' && ($('#now').classList.contains('panel-open') || innerWidth > 820));
  const box = $('#now-panel');
  if (P.panel === 'queue') return renderQueue();
  const t = current(); if (!t) return;
  if (!P.lyrics || P.lyrics.id !== t.id) {
    box.innerHTML = `<div class="lyrics-empty">Finding lyrics…</div>`;
    let l = await db.get('lyrics', t.id);
    if (!l) { l = await meta.findLyrics(t) || { none: true }; db.put('lyrics', t.id, l); }
    if (current()?.id !== t.id) return;
    P.lyrics = { id: t.id, lines: l.synced ? meta.parseLrc(l.synced) : null, plain: l.plain, none: l.none };
    P.lyricLine = -1;
  }
  if (P.panel !== 'lyrics') return;
  if (P.lyrics.lines?.length) box.innerHTML = `<div class="lyrics" id="lyrics">${P.lyrics.lines.map((x, i) => `<p data-t="${x.t}" data-i="${i}">${esc(x.text) || '♪'}</p>`).join('')}</div>`;
  else if (P.lyrics.plain) box.innerHTML = `<div class="lyrics plain">${P.lyrics.plain.split('\n').map(l => `<p>${esc(l) || '&nbsp;'}</p>`).join('')}</div>`;
  else box.innerHTML = `<div class="lyrics-empty"><h2 style="color:#fff;margin-bottom:6px">No lyrics</h2>Lyrics for this one aren’t available.</div>`;
  if (P.lyrics.lines) syncLyrics(audio.currentTime, true);
}
function syncLyrics(c, force) {
  const L = P.lyrics.lines; let i = -1;
  for (let k = 0; k < L.length; k++) { if (L[k].t <= c + .25) i = k; else break; }
  if (i === P.lyricLine && !force) return;
  P.lyricLine = i;
  const box = $('#lyrics'); if (!box) return;
  box.querySelectorAll('p.on').forEach(p => p.classList.remove('on'));
  const p = box.querySelector(`p[data-i="${i}"]`);
  if (p) { p.classList.add('on'); p.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' }); }
}
function renderQueue() {
  const box = $('#now-panel');
  const up = P.queue.slice(P.idx + 1);
  const t = current();
  const row = (id, i) => { const x = S.tracks.get(id); if (!x) return ''; return `<div class="track" data-qi="${i}"><div class="th"><img src="${artOf(x)}" alt=""></div><div style="min-width:0"><div class="tt ellipsis">${esc(x.title)}</div><div class="ta ellipsis">${esc(x.artist)}</div></div><div class="td">${fmt(x.duration)}</div><button class="icon-btn" data-action="queue-remove" data-qi="${i}" title="Remove"><svg><use href="#i-x"/></svg></button></div>`; };
  const mine = up.map((id, k) => [id, P.idx + 1 + k]).filter(([id]) => !P.autoAdded.has(id));
  const auto = up.map((id, k) => [id, P.idx + 1 + k]).filter(([id]) => P.autoAdded.has(id));
  box.innerHTML = `<div class="queue-panel">
    ${t ? `<h3>Now playing</h3><div class="track"><div class="th"><img src="${artOf(t)}" alt=""></div><div style="min-width:0"><div class="tt ellipsis" style="color:var(--accent)">${esc(t.title)}</div><div class="ta ellipsis">${esc(t.artist)}</div></div><div class="td">${fmt(t.duration)}</div><div></div></div>` : ''}
    <h3>Up next${P.context ? ' · ' + esc(P.context) : ''}</h3>${mine.map(([id, i]) => row(id, i)).join('') || '<p class="muted" style="padding:0 10px">Nothing queued.</p>'}
    <div class="autoplay-row"><div><b>Autoplay</b><div class="muted" style="font-size:13px">Similar songs keep playing when this ends</div></div><button class="switch ${S.settings.autoplay ? 'on' : ''}" data-action="toggle-setting" data-key="autoplay"></button></div>
    ${auto.length ? `<h3>Autoplay</h3>${auto.map(([id, i]) => row(id, i)).join('')}` : ''}</div>`;
}

/* ================= Menus & sheets ================= */
function menu(e, items) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'menu';
  m.innerHTML = items.map((it, i) => it === null ? '<hr>' : `<button data-mi="${i}" class="${it[2] || ''}">${it[0]}</button>`).join('');
  document.body.appendChild(m);
  const r = e?.target?.closest('button')?.getBoundingClientRect?.() || { left: innerWidth / 2, bottom: innerHeight / 2, top: innerHeight / 2 };
  const w = m.offsetWidth, h = m.offsetHeight;
  let x = Math.min(r.left, innerWidth - w - 10), y = r.bottom + 6;
  if (y + h > innerHeight - 10) y = Math.max(10, r.top - h - 6);
  m.style.left = Math.max(10, x) + 'px'; m.style.top = y + 'px';
  m.addEventListener('click', ev => { const b = ev.target.closest('[data-mi]'); if (!b) return; closeMenus(); items[+b.dataset.mi][1](); });
  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
}
function closeMenus() { $$('.menu').forEach(m => m.remove()); }
function sheet(html, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop"><div class="sheet">${html}</div></div>`;
  const bd = root.firstElementChild;
  bd.addEventListener('click', e => { if (e.target === bd || e.target.closest('[data-close]')) closeSheet(); });
  onMount?.(bd.firstElementChild);
  bd.querySelector('input')?.focus();
}
function closeSheet() { $('#sheet-root').innerHTML = ''; }

function trackMenu(e, id) {
  const t = S.tracks.get(id); if (!t) return;
  menu(e, [
    ['Play next', () => { insertNext([id]); toast('Plays next'); }],
    ['Add to queue', () => { addQueue([id]); toast('Added to queue'); }],
    ['Add to playlist…', () => addToPlaylistSheet([id])],
    ['Start a station', () => radio(id)],
    null,
    ['Go to artist', () => go('artist/' + mainArtist(t.artist))],
    ...(t.album ? [['Go to album', () => go('album/' + t.album + '\u0001' + mainArtist(t.artist))]] : []),
    ...(S.route === 'playlist' ? [['Remove from this playlist', () => removeFromPlaylist(S.param, id)]] : []),
    null,
    ['Edit info', () => editSheet(id)],
    [t.liked ? 'Unlike' : 'Like', () => like(id)],
    ['Delete from library', () => confirmDelete(id), 'danger'],
  ]);
}
function insertNext(ids) { if (!P.queue.length) return playList(ids); P.queue.splice(P.idx + 1, 0, ...ids); savePlayer(); if (P.panel === 'queue') renderQueue(); }
function addQueue(ids) { if (!P.queue.length) return playList(ids); const firstAuto = P.queue.findIndex((id, i) => i > P.idx && P.autoAdded.has(id)); P.queue.splice(firstAuto < 0 ? P.queue.length : firstAuto, 0, ...ids); savePlayer(); }
function radio(id) { const t = S.tracks.get(id); const ids = [id, ...similar(t, 30)]; P.shuffle = false; playList(ids, 0, { context: `${t.title} Station` }); }

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
    <div class="field"><div style="display:flex;gap:8px"><input class="input" id="new-pl" placeholder="New playlist name" style="flex:1"><button class="btn primary" id="new-pl-go">Create</button></div></div>
    <div>${pls.map(p => `<button class="nav-link" style="width:100%" data-pl-add="${p.id}"><svg><use href="#i-note"/></svg>${esc(p.name)}<span class="muted" style="margin-left:auto">${p.tracks.length}</span></button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button></div>`, el => {
    const create = async () => { const name = el.querySelector('#new-pl').value.trim(); if (!name) return; const p = { id: uid(), name, tracks: [...ids], createdAt: Date.now() }; await savePlaylist(p); closeSheet(); toast(`Added to ${name}`); };
    el.querySelector('#new-pl-go').onclick = create;
    el.querySelector('#new-pl').onkeydown = e => { if (e.key === 'Enter') create(); };
    el.querySelectorAll('[data-pl-add]').forEach(b => b.onclick = async () => { const p = S.playlists.get(b.dataset.plAdd); const fresh = ids.filter(id => !p.tracks.includes(id)); p.tracks.push(...fresh); await savePlaylist(p); closeSheet(); toast(fresh.length ? `Added to ${p.name}` : `Already in ${p.name}`); });
  });
}
async function removeFromPlaylist(pid, id) { const p = S.playlists.get(pid); p.tracks = p.tracks.filter(x => x !== id); await savePlaylist(p); render(); }
function newPlaylist() {
  sheet(`<h2>New playlist</h2><div class="field"><input class="input" id="pl-name" placeholder="Playlist name"></div><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pl-create">Create</button></div>`, el => {
    const go_ = async () => { const name = el.querySelector('#pl-name').value.trim(); if (!name) return; const p = { id: uid(), name, tracks: [], createdAt: Date.now() }; await savePlaylist(p); closeSheet(); go('playlist/' + p.id); };
    el.querySelector('#pl-create').onclick = go_; el.querySelector('#pl-name').onkeydown = e => { if (e.key === 'Enter') go_(); };
  });
}
function playlistMenu(e, pid) {
  const p = S.playlists.get(pid);
  menu(e, [
    ['Rename', () => sheet(`<h2>Rename playlist</h2><div class="field"><input class="input" id="pl-name" value="${esc(p.name)}"></div><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pl-save">Save</button></div>`, el => { el.querySelector('#pl-save').onclick = async () => { p.name = el.querySelector('#pl-name').value.trim() || p.name; await savePlaylist(p); closeSheet(); render(); }; })],
    ['Delete playlist', async () => { if (!confirm(`Delete “${p.name}”? The songs stay in your library.`)) return; S.playlists.delete(pid); await db.del('playlists', pid); if (S.user) cloud.deletePlaylist(pid); renderSidebarPlaylists(); go('home'); }, 'danger'],
  ]);
}
function renderSidebarPlaylists() {
  $('#sidebar-playlists').innerHTML = [...S.playlists.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => `<a class="nav-link ellipsis" data-pl="${p.id}" href="#/playlist/${p.id}">${esc(p.name)}</a>`).join('');
}

function editSheet(id) {
  const t = S.tracks.get(id);
  let newArt = null;
  const cats = ['Music', 'Quran & Recitation', 'Nasheeds', 'Talks & Lectures'];
  sheet(`<h2>Edit info</h2>
    <div class="edit-art"><div class="coll-art"><img id="ed-art" src="${artOf(t)}" alt=""></div>
      <div class="row-actions" style="flex-direction:column;align-items:flex-start;gap:8px"><button class="btn" id="ed-find">Find artwork & details</button><button class="btn ghost" id="ed-upload">Use my own image</button><button class="btn ghost" id="ed-design">Use a plain cover</button></div></div>
    <div class="field"><label>Title</label><input class="input" id="ed-title" value="${esc(t.title)}"></div>
    <div class="field"><label>Artist</label><input class="input" id="ed-artist" value="${esc(t.artist)}"></div>
    <div class="field"><label>Album</label><input class="input" id="ed-album" value="${esc(t.album || '')}"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div class="field"><label>Genre</label><input class="input" id="ed-genre" value="${esc(t.genre || '')}"></div>
    <div class="field"><label>Type</label><select class="input" id="ed-cat">${cats.map(c => `<option ${c === t.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
    <p class="muted" style="font-size:12px;margin:0">Original file: ${esc(t.file || '')}</p>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ed-save">Save</button></div>`, el => {
    const v = k => el.querySelector('#ed-' + k);
    v('find').onclick = async () => {
      v('find').disabled = true; v('find').textContent = 'Looking…';
      const found = await meta.lookup({ title: v('title').value, artist: v('artist').value });
      v('find').disabled = false; v('find').textContent = 'Find artwork & details';
      if (!found) return toast('No match found. Try fixing the title or artist first.');
      v('title').value = found.title; v('artist').value = found.artist; v('album').value = found.album; v('genre').value = found.genre || '';
      try { newArt = await meta.fetchImage(found.artUrl); v('art').src = URL.createObjectURL(newArt); } catch {}
    };
    v('upload').onclick = () => { const inp = $('#art-input'); inp.value = ''; inp.onchange = () => { const f = inp.files[0]; if (f) { newArt = f; v('art').src = URL.createObjectURL(f); } }; inp.click(); };
    v('design').onclick = async () => { newArt = await meta.makeCover(v('title').value, v('artist').value, v('cat').value); v('art').src = URL.createObjectURL(newArt); };
    v('save').onclick = async () => {
      Object.assign(t, { title: v('title').value.trim() || t.title, artist: v('artist').value.trim() || 'Unknown Artist', album: v('album').value.trim(), genre: v('genre').value.trim(), category: v('cat').value, edited: true });
      await db.del('lyrics', t.id);
      if (newArt) { await setArt(t.id, newArt); if (S.user && t.cloud) cloud.uploadFile('art/' + t.id, newArt).catch(() => {}); }
      await saveTrack(t);
      closeSheet(); render(); if (current()?.id === t.id) { paintNow(t); updateMediaSession(t); }
      toast('Saved');
    };
  });
}
async function removeLocal(id) {
  S.tracks.delete(id); await db.del('tracks', id); await db.del('audio', id); await db.del('art', id); await db.del('lyrics', id);
  const u = S.art.get(id); if (u) URL.revokeObjectURL(u); S.art.delete(id);
}
async function confirmDelete(id) {
  const t = S.tracks.get(id);
  if (!confirm(`Delete “${t.title}” from your library${S.user && t.cloud ? ' on all your devices' : ''}?`)) return;
  await removeLocal(id);
  for (const p of S.playlists.values()) if (p.tracks.includes(id)) { p.tracks = p.tracks.filter(x => x !== id); savePlaylist(p); }
  if (S.user && t.cloud) cloud.deleteTrack(id).catch(() => {});
  const qi = P.queue.indexOf(id);
  if (qi >= 0) { P.queue.splice(qi, 1); if (qi < P.idx) P.idx--; else if (qi === P.idx) { audio.pause(); if (P.queue.length) loadTrack(P.queue[Math.min(P.idx, P.queue.length - 1)], false); } }
  render(); toast('Deleted');
}

async function refixAll() {
  const ts = tracksArr().filter(t => !t.edited);
  toast(`Checking ${count(ts.length)}…`);
  let fixed = 0;
  for (const t of ts) {
    if (t.category !== 'Music') continue;
    const found = await meta.lookup(t);
    if (!found) continue;
    Object.assign(t, { title: found.title, artist: found.artist, album: found.album || t.album, genre: found.genre || t.genre, year: found.year || t.year, matched: true });
    try { const b = await meta.fetchImage(found.artUrl); await setArt(t.id, b); t.designedCover = false; if (S.user && t.cloud) await cloud.uploadFile('art/' + t.id, b); } catch {}
    await saveTrack(t); fixed++;
  }
  render(); toast(`Updated ${count(fixed)}`);
}
async function uploadLocal() {
  const ts = tracksArr().filter(t => t.local && !t.cloud);
  let n = 0; toast(`Uploading ${count(ts.length)}…`);
  for (const t of ts) {
    try { const a = await db.get('audio', t.id); const art = await db.get('art', t.id); if (a) { await uploadTrack(t, a, art); n++; } } catch (e) { console.warn(e); }
  }
  toast(`Uploaded ${count(n)}`); render();
}

/* ================= Events ================= */
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-action]');
  const playBtn = e.target.closest('[data-play-list]');
  const href = e.target.closest('[data-href]');
  if (a) {
    e.preventDefault(); e.stopPropagation();
    const id = a.dataset.id;
    switch (a.dataset.action) {
      case 'toggle': return toggle();
      case 'next': return next();
      case 'prev': return prev();
      case 'shuffle': P.shuffle = !P.shuffle; if (P.queue.length) { const cur = P.queue[P.idx]; const rest = P.queue.slice(P.idx + 1); P.queue = [...P.queue.slice(0, P.idx + 1), ...(P.shuffle ? shuffleArr(rest) : rest)]; void cur; } updateModes(); savePlayer(); if (P.panel === 'queue') renderQueue(); return toast(P.shuffle ? 'Shuffle on' : 'Shuffle off');
      case 'repeat': P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; updateModes(); savePlayer(); return toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat this song' }[P.repeat]);
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
        return renderPanel();
      }
      case 'queue-remove': { const i = +a.dataset.qi; P.queue.splice(i, 1); savePlayer(); return renderQueue(); }
      case 'speed': return cycleSpeed();
      case 'sleep': return sleepMenu(e);
      case 'radio': return radio(id);
      case 'radio-artist': { const ts = groups('artist').get(a.dataset.name) || []; if (ts.length) radio(ts[Math.floor(Math.random() * ts.length)].id); return; }
      case 'new-playlist': return newPlaylist();
      case 'playlist-menu': return playlistMenu(e, a.dataset.pl);
      case 'pick-folder': { const i = $('#folder-input'); i.value = ''; return i.click(); }
      case 'pick-files': { const i = $('#file-input'); i.value = ''; return i.click(); }
      case 'sort': S.settings.songSort = a.dataset.sort; await saveSettings(); return render();
      case 'toggle-setting': S.settings[a.dataset.key] = !S.settings[a.dataset.key]; a.classList.toggle('on', S.settings[a.dataset.key]); return saveSettings();
      case 'accent': S.settings.accent = a.dataset.accent; await saveSettings(); return render();
      case 'back': return history.length > 1 ? history.back() : go('home');
      case 'clear-searches': S.searches = []; kv.set('searches', []); return render();
      case 'apply-update': return applyUpdate();
      case 'check-update': { await checkVersion(); if (!$('#update-bar').classList.contains('show')) toast('You’re on the newest version'); return; }
      case 'refix-all': return refixAll();
      case 'upload-local': return uploadLocal();
      case 'clear-device': {
        if (!confirm(S.user ? 'Remove downloaded songs from this device? They stay in your cloud library.' : 'This removes every song from this device. Continue?')) return;
        for (const t of tracksArr()) { if (S.user && t.cloud) { await db.del('audio', t.id); t.local = false; await saveTrack(t, { sync: false }); } else if (!S.user) await removeLocal(t.id); }
        return render();
      }
      case 'sign-in': case 'sign-up': {
        const email = $('#auth-email').value.trim(), pass = $('#auth-pass').value;
        if (!email || pass.length < 6) return toast('Enter your email and a password of 6+ characters');
        try {
          if (a.dataset.action === 'sign-in') await cloud.signIn(email, pass);
          else { const live = await cloud.signUp(email, pass); if (!live) return toast('Check your email to confirm, then sign in'); }
          S.user = await cloud.user(); await syncDown(); render(); toast('Signed in');
        } catch (err) { toast(err.message || 'Couldn’t sign in'); }
        return;
      }
      case 'sign-out': await cloud.signOut(); S.user = null; return render();
      case 'sync': await syncDown(); return toast('Up to date');
    }
    return;
  }
  if (playBtn) {
    e.preventDefault(); e.stopPropagation();
    const ids = S.lists[playBtn.dataset.playList] || [];
    return playList(ids, +(playBtn.dataset.i || 0), { shuffle: !!playBtn.dataset.shuffle, context: ids.context || contextName() });
  }
  const chip = e.target.closest('[data-search]');
  if (chip) { go('search/' + chip.dataset.search); return; }
  if (href) { e.preventDefault(); go(href.dataset.href); return; }
  const qrow = e.target.closest('[data-qi]');
  if (qrow && !e.target.closest('button')) { P.idx = +qrow.dataset.qi; loadTrack(P.queue[P.idx]); return renderQueue(); }
  const row = e.target.closest('.track[data-list]');
  if (row) { const ids = S.lists[row.dataset.list]; return playList(ids, +row.dataset.i, { context: ids.context || contextName() }); }
  const lyr = e.target.closest('.lyrics p[data-t]');
  if (lyr) { audio.currentTime = +lyr.dataset.t; if (audio.paused) audio.play(); }
});
function contextName() {
  if (S.route === 'artist' || S.route === 'mix') return S.route === 'mix' ? mixName(S.param) : S.param;
  if (S.route === 'album') return S.param.split('\u0001')[0];
  if (S.route === 'playlist') return S.playlists.get(S.param)?.name || 'Playlist';
  return { home: 'Home', songs: 'Songs', liked: 'Liked Songs', search: 'Search' }[S.route] || '';
}
document.addEventListener('contextmenu', e => { const r = e.target.closest('.track[data-id]'); if (r) { e.preventDefault(); trackMenu({ target: r.querySelector('.more') }, r.dataset.id); } });

let searchT;
document.addEventListener('input', e => {
  if (e.target.id !== 'search-input') return;
  clearTimeout(searchT);
  const q = e.target.value;
  searchT = setTimeout(() => {
    history.replaceState(null, '', '#/search' + (q ? '/' + encodeURIComponent(q) : ''));
    S.param = q; const pos = e.target.selectionStart; render();
    const i = $('#search-input'); if (i) i.setSelectionRange(pos, pos);
  }, 140);
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'search-input' && e.key === 'Enter' && e.target.value.trim()) { const q = e.target.value.trim(); S.searches = [q, ...S.searches.filter(s => s !== q)].slice(0, 8); kv.set('searches', S.searches); return; }
  if (e.target.matches('input,textarea,select')) return;
  if (e.key === 'Escape') { closeSheet(); closeMenus(); closeNow(); }
  if (e.key === ' ') { e.preventDefault(); toggle(); }
  if (e.key === 'ArrowRight' && e.shiftKey) next(); else if (e.key === 'ArrowRight') audio.currentTime += 10;
  if (e.key === 'ArrowLeft' && e.shiftKey) prev(); else if (e.key === 'ArrowLeft') audio.currentTime -= 10;
  if (e.key.toLowerCase() === 'l' && current()) like(current().id);
  if (e.key === '/' ) { e.preventDefault(); go('search'); }
});
$('#file-input').addEventListener('change', e => importFiles([...e.target.files]));
$('#folder-input').addEventListener('change', e => importFiles([...e.target.files]));
window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async e => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); $('#drop')?.classList.remove('over'); importFiles(await filesFromDrop(e.dataTransfer)); });
window.addEventListener('beforeunload', () => kv.set('player', { queue: P.queue, idx: P.idx, shuffle: P.shuffle, repeat: P.repeat, context: P.context, time: audio.currentTime || 0 }));

// swipe down to close the full player on phones
(() => { let y0 = null; const n = $('#now'); n.addEventListener('touchstart', e => { if (e.target.closest('.now-right,input')) return; y0 = e.touches[0].clientY; }, { passive: true }); n.addEventListener('touchend', e => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 90) closeNow(); y0 = null; }); })();

boot();
