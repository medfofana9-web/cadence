// Reads tags from audio files, cleans up messy names, and finds real artwork.

export const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|alac|aif|aiff|webm)$/i;

export { readTags } from './tags.js';

/* ---------- Name cleanup ---------- */
const JUNK = /\s*[\(\[\{][^\)\]\}]*\b(official|visuali[sz]er|video|audio|lyrics?|lyric video|hd|hq|4k|explicit|clean|sub\.?|subtitulad[oa]|prod\.?|music video|mv|remaster(ed)?)\b[^\)\]\}]*[\)\]\}]/gi;
const TAIL = /\s*(\||–|—|_)?\s*(official (music )?(video|audio)|lyrics?|lyric video|visuali[sz]er|sub\.? espa[ñn]ol.*|letra.*|\w+ music audio|music audio|audio|klickaud|hd|hq)\s*$/i;
const isJunk = s => new RegExp(JUNK.source, 'i').test(s);
const EMOJI = /[\p{Extended_Pictographic}️‍]/gu;
const UPLOADERS = /^(unknown artist|unknown|various artists|danny|sb kush|solo un canal.*|dawah\d*|reema\d*|.*\d{3,}|.*_)$/i;
const RELIGIOUS = /\b(surah|sura|quran|qur'?an|taraweeh|tarawih|tilawa|tilawat|recitation|juz|ayah|ayat|dua|du'a|adhan|azan|nasheed)\b/i;
const TALK = /\b(lecture|khutbah|khutba|sermon|reminder|podcast|episode|ep\.)\b/i;

export function categorize(t) {
  const s = `${t.title} ${t.artist} ${t.album} ${t.genre || ''}`;
  if (RELIGIOUS.test(s)) return /nasheed/i.test(s) ? 'Nasheeds' : 'Quran & Recitation';
  if (TALK.test(s)) return 'Talks & Lectures';
  return 'Music';
}

function tidy(s) {
  let prev, out = s || '';
  do { prev = out; out = tidy1(out); } while (out !== prev);
  return out;
}
function tidy1(s) {
  return (s || '')
    .replace(EMOJI, '')
    .replace(JUNK, '')
    .replace(TAIL, '')
    .replace(/(\d)_(\d)/g, '$1/$2')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—|•·_]+|[\s\-–—|•·_]+$/g, '')
    .trim();
}
const titleCase = s => s.replace(/\p{L}[\p{L}']{3,}/gu, w => w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w);

/** Turns a messy tag/file name into { title, artist, album }. */
export function cleanNames(tags, fileName) {
  let raw = tags.title || fileName.replace(/\.[^.]+$/, '');
  let artist = (tags.artist || '').trim();
  let album = (tags.album || '').trim();
  if (!/\s/.test(raw) && raw.includes('_')) raw = raw.replace(/_/g, ' ');
  raw = raw.replace(/^\d{1,3}[\s.\-_]+(?=\D)/, ''); // "09 Circo Loco"
  const uploaderArtist = !artist || UPLOADERS.test(artist);
  let title = raw;

  // "Title _ Part _ Part" (YouTube downloaders turn "|" into "_")
  let parts = title.split(/\s+_\s+|\s+\|\s+/).map(tidy).filter(Boolean);
  if (parts.length > 1) {
    const extra = parts.slice(1).filter(p => p.toLowerCase() !== artist.toLowerCase() && !/[؀-ۿ]/.test(p) && p.length < 30);
    title = [parts[0], ...extra.filter(p => /^(night|part|pt|ep|episode|day|vol)\b/i.test(p))].join(' · ');
  }
  // "Title • Artist"
  const dot = title.split(/\s+[•·]\s+/);
  if (dot.length === 2 && dot[1].toLowerCase() === artist.toLowerCase()) title = dot[0];
  else if (dot.length === 2 && !/^(night|part|ep)/i.test(dot[1]) && uploaderArtist) { title = dot[0]; artist = dot[1]; }

  // "Artist - Title"
  const dash = title.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) {
    const left = tidy(dash[0]), right = tidy(dash.slice(1).join(' - '));
    if (RELIGIOUS.test(left) && !RELIGIOUS.test(right)) { title = left; artist = right; }
    else if (uploaderArtist || right.toLowerCase() !== artist.toLowerCase()) {
      if (uploaderArtist || left.toLowerCase().includes(artist.toLowerCase().split(/[ ,&_]/)[0])) { artist = left; title = right; }
    }
  }
  // "[Reciter]" in the title
  const br = raw.match(/\[([^\]]+)\]/);
  if (br && RELIGIOUS.test(raw) && !isJunk(`[${br[1]}]`)) { artist = br[1]; title = title.replace(br[0], ''); }

  title = titleCase(tidy(title)) || tidy(raw);
  artist = tidy(artist.replace(/_/g, ' & ')) || 'Unknown Artist';
  artist = [...new Set(artist.split(/\s*,\s*/))].join(', ');
  if (UPLOADERS.test(artist)) artist = 'Unknown Artist';
  if (!album || /^unknown album$/i.test(album)) album = '';
  if (RELIGIOUS.test(raw)) { const cap = x => x.replace(/(^|\s)(\p{Ll})/gu, (m, sp, c) => sp + c.toUpperCase()).replace(/\b(And|Of|The|In|Verse)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase()); title = cap(title); artist = cap(artist); }
  // "feat." pulled into the artist line
  const ft = title.match(/\s*\((?:feat\.?|ft\.?|featuring)\s+([^)]+)\)/i);
  if (ft) { title = title.replace(ft[0], '').trim(); artist = `${artist} feat. ${ft[1]}`; }
  return { title, artist, album };
}

/* ---------- Artwork and details from Apple's free search ---------- */
const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)|\[.*?\]|feat\..*$|ft\..*$/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function overlap(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean)), B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

async function itunes(term, entity = 'song', limit = 8) {
  const url = `https://itunes.apple.com/search?media=music&entity=${entity}&limit=${limit}&term=${encodeURIComponent(term)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('lookup ' + r.status);
  return (await r.json()).results || [];
}

/** Finds the real song on Apple's catalog: proper title, artist, album, genre, year and big artwork. */
export async function lookup(t) {
  const artist = t.artist === 'Unknown Artist' ? '' : t.artist.replace(/ feat\..*$/, '');
  const queries = [`${artist} ${t.title}`.trim(), t.title];
  for (const q of queries) {
    let res;
    try { res = await itunes(q); } catch { return null; }
    let best = null, bestScore = 0;
    for (const r of res) {
      const ts = overlap(t.title, r.trackName);
      const as = artist ? overlap(artist, r.artistName) : 0.6;
      const score = ts * 0.65 + as * 0.35;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (best && bestScore >= 0.62) {
      return {
        title: best.trackName,
        artist: best.artistName,
        album: (best.collectionName || '').replace(/ - (Single|EP)$/, ''),
        genre: best.primaryGenreName,
        year: (best.releaseDate || '').slice(0, 4),
        artUrl: (best.artworkUrl100 || '').replace('100x100bb', '1200x1200bb'),
        explicit: best.trackExplicitness === 'explicit',
      };
    }
  }
  return null;
}

export async function artistImage(name) {
  // Apple's search has no artist photos; use the artist's most popular album cover instead.
  try {
    const res = await itunes(name, 'album', 5);
    const hit = res.find(r => overlap(name, r.artistName) > 0.7);
    return hit ? hit.artworkUrl100.replace('100x100bb', '600x600bb') : null;
  } catch { return null; }
}

export async function fetchImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('image ' + r.status);
  return await r.blob();
}

/* ---------- Designed covers for songs with no artwork ---------- */
const PALETTES = [
  ['#1f2a24', '#d8c9a3'], ['#231d2b', '#e8b9a6'], ['#13232b', '#a9d1d8'], ['#2b1a17', '#f0a382'],
  ['#1b1e2b', '#c3c8f0'], ['#26211a', '#e9cf8f'], ['#1a2620', '#9fd8b5'], ['#2a1c22', '#f2b3c4'],
];
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

export async function makeCover(title, artist, category) {
  const c = document.createElement('canvas'); c.width = c.height = 800;
  const x = c.getContext('2d');
  const h = hash(title + artist);
  const [bg, fg] = category === 'Quran & Recitation' ? ['#0f1f1b', '#d9c58f'] : PALETTES[h % PALETTES.length];
  x.fillStyle = bg; x.fillRect(0, 0, 800, 800);
  // soft light
  const g = x.createRadialGradient(560 + (h % 200) - 100, 220, 40, 560, 220, 700);
  g.addColorStop(0, fg + '33'); g.addColorStop(1, '#00000000');
  x.fillStyle = g; x.fillRect(0, 0, 800, 800);
  // geometric mark
  x.strokeStyle = fg + '55'; x.lineWidth = 2;
  const cx = 560, cy = 250, rings = 3 + (h % 4);
  for (let i = 0; i < rings; i++) { x.beginPath(); x.arc(cx, cy, 60 + i * 34, 0, Math.PI * 2); x.stroke(); }
  x.fillStyle = fg; x.beginPath(); x.arc(cx, cy, 14, 0, Math.PI * 2); x.fill();
  // type
  x.fillStyle = fg; x.textBaseline = 'alphabetic';
  x.font = '600 26px -apple-system, "SF Pro Text", Inter, Helvetica, Arial, sans-serif';
  x.globalAlpha = .75; x.fillText((artist || '').toUpperCase().slice(0, 40), 64, 710); x.globalAlpha = 1;
  x.font = '700 64px -apple-system, "SF Pro Display", Inter, Helvetica, Arial, sans-serif';
  const words = title.split(/\s+/); const lines = []; let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (x.measureText(t).width > 640 && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line);
  const shown = lines.slice(0, 3);
  if (lines.length > 3) shown[2] = shown[2].replace(/\s*\S*$/, '') + '…';
  shown.reverse().forEach((l, i) => x.fillText(l, 62, 650 - i * 72));
  return await new Promise(r => c.toBlob(r, 'image/jpeg', .9));
}

export function audioDuration(blob) {
  return new Promise(resolve => {
    const a = new Audio(); const url = URL.createObjectURL(blob);
    const done = d => { URL.revokeObjectURL(url); resolve(isFinite(d) ? d : 0); };
    a.preload = 'metadata'; a.onloadedmetadata = () => done(a.duration); a.onerror = () => done(0);
    setTimeout(() => done(a.duration || 0), 8000);
    a.src = url;
  });
}

/** Fingerprint from the file's actual bytes, so a renamed copy of the same song is still recognized. */
export async function fingerprint(file) {
  const parts = [new TextEncoder().encode(String(file.size)), new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()), new Uint8Array(await file.slice(Math.max(0, file.size - 64 * 1024)).arrayBuffer())];
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const buf = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Tags that look like real release info (not a YouTube download) are kept as they are. */
export function isReliable(tags) {
  return !!(tags.title && tags.artist && tags.album && !UPLOADERS.test(tags.artist) && !/unknown/i.test(tags.album) && !isJunk(tags.title) && !/ - /.test(tags.title));
}

/** Key used to spot the same song imported twice from different files. */
export const dupKey = t => `${norm(t.artist.split(/ feat\. | & |, /i)[0])}|${norm(t.title)}`;

export async function trackId(file) {
  const s = `${file.name}|${file.size}`;
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Lyrics (LRCLIB, free) ---------- */
export async function findLyrics(t) {
  const artist = t.artist.replace(/ feat\..*$/, '');
  const q = new URLSearchParams({ artist_name: artist, track_name: t.title });
  if (t.album) q.set('album_name', t.album);
  if (t.duration) q.set('duration', Math.round(t.duration));
  try {
    let r = await fetch('https://lrclib.net/api/get?' + q);
    if (r.ok) { const j = await r.json(); if (j.syncedLyrics || j.plainLyrics) return { synced: j.syncedLyrics || '', plain: j.plainLyrics || '' }; }
    r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams({ q: `${artist} ${t.title}` }));
    if (r.ok) {
      const list = await r.json();
      const hit = list.find(x => overlap(x.trackName, t.title) > .7 && (x.syncedLyrics || x.plainLyrics));
      if (hit) return { synced: hit.syncedLyrics || '', plain: hit.plainLyrics || '' };
    }
  } catch {}
  return null;
}

export function parseLrc(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const x of m) out.push({ t: +x[1] * 60 + +x[2], text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}
