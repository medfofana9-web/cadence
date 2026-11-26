// Finds the real song behind a file, the way Shazam does: by how it sounds, then by name in two catalogs.
//  1. AcoustID (audio fingerprint) → title, artist, album; cover from the Cover Art Archive
//  2. Apple Music and Deezer by name (Deezer is much stronger on African music)
// Every answer comes with a confidence. Fof Music applies "sure" answers on its own and only keeps a
// cleaned-up guess when nothing is found.
import { CONFIG } from '../config.js';
import { lookup, identify, norm, overlap, titleMatch } from './meta.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastAcoustid = 0;

/* ---------- 1. by sound ---------- */
let cp = null;
/** An audio fingerprint of the first two minutes (only that part is decoded, so long files stay light). */
export async function fingerprintOf(blob, duration) {
  if (!blob || blob.size < 20000) return null;
  const mp3 = /mpeg|mp3/i.test(blob.type) || /\.mp3$/i.test(blob.name || '');
  // MP3 can be cut anywhere; other formats are only read when small enough to decode whole
  let part = blob;
  if (duration > 150) { if (mp3) part = blob.slice(0, Math.ceil(blob.size * 135 / duration)); else if (blob.size > 40e6) return null; }
  try {
    cp ||= import('./chromaprint/index.js');
    const { processAudioFile } = await cp;
    for await (const fp of processAudioFile(await part.arrayBuffer())) return fp;
  } catch (e) { console.warn('fingerprint', e); }
  return null;
}

const joinArtists = as => (as || []).map((a, i) => a.name + (i < as.length - 1 ? (a.joinphrase || ', ') : '')).join('').trim();

/** Asks AcoustID which recording this fingerprint is. Returns null unless the match is strong. */
export async function bySound(fp, duration) {
  if (!fp || !duration || !CONFIG.acoustidKey) return null;
  const wait = 400 - (Date.now() - lastAcoustid); if (wait > 0) await sleep(wait); // their limit is 3 a second
  lastAcoustid = Date.now();
  const body = new URLSearchParams({ client: CONFIG.acoustidKey, format: 'json', meta: 'recordings releasegroups compress', duration: Math.round(duration), fingerprint: fp });
  let j;
  try { const r = await fetch('https://api.acoustid.org/v2/lookup', { method: 'POST', body }); j = await r.json(); } catch { return null; }
  if (j.status !== 'ok') { console.warn('acoustid', j.error?.message); return null; }
  let best = null;
  for (const res of j.results || []) {
    if (res.score < .85) continue;
    for (const rec of res.recordings || []) {
      if (!rec.title || !rec.artists?.length) continue;
      if (rec.duration && Math.abs(rec.duration - duration) > 15) continue;
      const groups = (rec.releasegroups || []);
      // prefer the original album or single over compilations and live albums
      const rank = g => (g.type === 'Album' ? 3 : g.type === 'Single' ? 2 : g.type === 'EP' ? 2 : 1) - (g.secondarytypes?.length ? 2 : 0);
      groups.sort((a, b) => rank(b) - rank(a));
      const score = res.score + (groups.length ? .05 : 0) + (rec.sources || 0) / 1000;
      if (!best || score > best.score) best = { score, title: rec.title, artist: joinArtists(rec.artists), album: groups[0]?.title || '', groups: groups.map(g => g.id), year: '' };
    }
  }
  if (!best) return null;
  best.artUrls = best.groups.slice(0, 4).map(id => `https://coverartarchive.org/release-group/${id}/front-1200`);
  return best;
}

/* ---------- 2. by name ---------- */
function jsonp(url) {
  return new Promise(res => {
    const cb = '__dz' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const done = v => { delete window[cb]; s.remove(); res(v); };
    window[cb] = done; s.onerror = () => done(null); setTimeout(() => done(null), 10000);
    s.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
    document.head.appendChild(s);
  });
}
async function deezer(q) { const j = await jsonp('https://api.deezer.com/search?limit=25&q=' + encodeURIComponent(q)); return j?.data || []; }
const fromDeezer = r => ({ title: r.title, artist: r.artist?.name || '', album: r.album?.title || '', year: '', artUrl: r.album?.cover_xl || r.album?.cover_big || '', explicit: !!r.explicit_lyrics, source: 'deezer' });

/** Same strict rules as the Apple lookup: artist and full title must match, lengths within 20 seconds. */
async function deezerLookup(t) {
  const artist = (t.artist || '').replace(/ (feat\.|ft\.|featuring) .*$/i, '').trim();
  if (!artist || /^unknown/i.test(artist)) return null;
  const artists = artist.split(/\s*(?:&|,| x | and )\s*/i).map(norm).filter(Boolean);
  let res = await deezer(`artist:"${artist}" track:"${t.title}"`);
  if (!res.length) res = await deezer(`${artist} ${t.title}`);
  let best = null, bestScore = 0;
  for (const r of res) {
    const ts = titleMatch(t.title, r.title_short || r.title); if (ts < .75) continue;
    const ra = norm(r.artist?.name);
    const as = artists.some(a => a && (ra.includes(a) || a.includes(ra))) ? 1 : overlap(artist, r.artist?.name || ''); if (as < .6) continue;
    let score = ts + as;
    if (t.duration && r.duration) { const d = Math.abs(t.duration - r.duration); if (d > 20) continue; if (d <= 4) score += .5; }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best ? fromDeezer(best) : null;
}
/** For names with no clear artist: the song's title and one of its artists must both be in the name. */
async function deezerIdentify(text, duration) {
  const words = norm(text).split(' ').filter(Boolean); if (words.length < 2) return null;
  const has = p => { const n = norm(p); return n && (' ' + words.join(' ') + ' ').includes(' ' + n + ' '); };
  let best = null, bestScore = 0;
  for (const r of await deezer(text)) {
    const title = r.title_short || r.title; if (!has(title) || !has(r.artist?.name || '')) continue;
    const covered = new Set([...norm(title).split(' '), ...norm(r.artist.name).split(' ')]);
    const coverage = words.filter(w => covered.has(w) || ['x', 'and', 'feat', 'ft', 'with'].includes(w)).length / words.length;
    if (coverage < .7) continue;
    let score = coverage;
    if (duration && r.duration) { const d = Math.abs(duration - r.duration); if (d > 20) continue; if (d <= 4) score += .5; }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best ? fromDeezer(best) : null;
}

const same = (a, b) => a && b && titleMatch(a.title, b.title) >= .75 && (norm(a.artist).includes(norm(b.artist).split(' ')[0]) || norm(b.artist).includes(norm(a.artist).split(' ')[0]) || overlap(a.artist, b.artist) >= .6);

/**
 * The best answer for one song, or null.
 *   base: cleaned-up { title, artist } from the file name / tags
 *   blob: the audio, for listening (optional)
 * Returns { title, artist, album, genre, year, artUrls[], explicit, confidence: 'sure' | 'likely', via }
 */
export async function findSong(base, { blob, duration } = {}) {
  const guess = { ...base, duration };
  const text = `${/^unknown/i.test(base.artist || '') ? '' : base.artist} ${base.title}`.trim();
  // by sound first: it doesn't care what the file is called
  const fp = blob ? await fingerprintOf(blob, duration) : null;
  const heard = fp ? await bySound(fp, duration) : null;
  // by name in both catalogs (using the heard name when we have one, since it's the real one)
  const q = heard ? { title: heard.title, artist: heard.artist, duration } : guess;
  const [apple, dz] = await Promise.all([
    lookup(q).then(r => r || (heard ? null : identify(text, duration))).catch(() => null),
    deezerLookup(q).then(r => r || (heard ? null : deezerIdentify(text, duration))).catch(() => null),
  ]);
  if (apple) apple.source = 'apple';
  const named = apple || dz;
  if (!heard && !named) return null;
  const main = heard || named;
  const agree = [heard, apple, dz].filter(x => x && same(x, main)).length;
  const confidence = heard || agree >= 2 ? 'sure' : 'likely';
  // artwork: the catalogs' covers are the cleanest; the Cover Art Archive is the fallback for heard songs
  const art = [apple, dz].filter(x => x && same(x, main)).map(x => x.artUrl).filter(Boolean);
  if (heard) art.push(...heard.artUrls);
  const meta = [apple, dz].find(x => x && same(x, main));
  return {
    title: main.title, artist: main.artist,
    album: (heard?.album || meta?.album || '').replace(/ - (Single|EP)$/, ''),
    genre: apple && same(apple, main) ? apple.genre : '', year: apple?.year || '',
    explicit: meta?.explicit, artUrls: [...new Set(art)], confidence,
    via: [heard && 'sound', apple && same(apple, main) && 'apple', dz && same(dz, main) && 'deezer'].filter(Boolean).join('+'),
  };
}

/** First artwork that actually downloads. */
export async function fetchFirstImage(urls) {
  for (const u of urls || []) {
    try { const r = await fetch(u); if (r.ok) { const b = await r.blob(); if (b.size > 2000 && b.type.startsWith('image/')) return b; } } catch {}
  }
  return null;
}

/** A real photo of the artist from Deezer, only when the name matches exactly (otherwise null). */
export async function artistPhoto(name) {
  const j = await jsonp('https://api.deezer.com/search/artist?limit=5&q=' + encodeURIComponent(name));
  if (!j) throw new Error('offline');
  const hit = (j.data || []).find(a => norm(a.name) === norm(name) && a.picture_xl && !/\/artist\/\/|images\/artist\/\//.test(a.picture_xl));
  return hit ? hit.picture_xl : null;
}
