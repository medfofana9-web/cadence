// Reads tags from audio files, cleans up messy names, and finds real artwork.

export const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|alac|aif|aiff|webm)$/i;

export { readTags } from './tags.js';

/* ---------- Name cleanup ---------- */
const JUNK = /\s*[\(\[\{][^\)\]\}]*\b(official|visuali[sz]er|video|audio|lyrics?|lyric video|hd|hq|4k|explicit|clean|sub\.?|subtitulad[oa]|prod\.?|music video|mv|remaster(ed)?)\b[^\)\]\}]*[\)\]\}]/gi;
const TAIL = /\s*(\||–|—|_|-)?\s*(\d0'?s music!?|\d{4} audio|official (music )?(video|audio)|lyrics?|lyric video|visuali[sz]er|sub\.? espa[ñn]ol.*|letra.*|\w+ music audio|music audio|audio|klickaud|hd|hq)\s*$/i;
const isJunk = s => new RegExp(JUNK.source, 'i').test(s);
const EMOJI = /[\p{Extended_Pictographic}️‍]/gu;
const UPLOADERS = /^(unknown artist|unknown|various artists|danny|sb kush|solo un canal.*|dawah\d*|reema\d*|.*\d{3,}|.*_)$/i;
const RELIGIOUS = /\b(surah|sura|quran|qur'?an|taraweeh|tarawih|tilawa|tilawat|recitation|juz|ayah|ayat|dua|du'a|adhan|azan|nasheed)\b/i;
const TALK = /\b(lecture|khutbah|khutba|sermon|reminder|podcast|episode|ep\.)\b/i;

/** Names that look like an uploading channel rather than a performer. */
const CHANNELISH = /\b(quran|music|tv|official|channel|records|recordz|vevo|lyrics?|beats|vibes|hype|world|nation|daily|hub|zone|media|audio|sounds?|plug|central|forgotten|uploads?|archive|mixtapes?|slowed|reverb|nightcore|lofi|edits?)\b|^listen|listentoit|\d{2,}$|^(various|unknown)/i;
export const looksLikeChannel = (a, channels = []) => !a || UPLOADERS.test(a) || CHANNELISH.test(a) || channels.some(c => norm(c) === norm(a));

/** YouTube's channel categories end up in the genre tag of downloads; they aren't genres. */
const YT_CATS = /^(music|people & blogs|education|howto & style|entertainment|film & animation|gaming|comedy|news & politics|sports|travel & events|nonprofits & activism|autos & vehicles|pets & animals|science & technology|other|unknown|genre)$/i;
export const cleanGenre = g => (g && !YT_CATS.test(g.trim()) ? g.trim() : '');
/** "A, B, B" → "A, B"; "A/B" → "A & B" */
export const tidyArtist = a => [...new Set(String(a || '').replace(/\s*\/\s*/g, ' & ').split(/\s*,\s*/).filter(Boolean))].join(', ');

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
/** Strips what download sites and apps add to file names: "facebook-audio-", "y2mate.com - ", "(128 kbps)", "(1)", video IDs… */
const SOURCE = /^(?:\[?(?:www\.)?[a-z0-9-]+\.(?:com|net|org|cc|io|to|me|app|co)\]?|facebook|fb|instagram|insta|ig|tiktok|snaptik|ssstik|musicaldown|youtube|yt|ytmp3|y2mate|x2download|savefrom|savetube|mp3juices?|soundcloud|sc|klickaud|notube|onlymp3|ytshorts|twitter|x\.com|snapchat|whatsapp|telegram|spotify|spotdl|downloaded|download)(?:[\s._-]*(?:audio|video|mp3|mp4|music|download|reel|reels|aud|vid|dl|app|com|net|\d{6,}))*(?:[\s._-]+|$)/i;
export function prepRaw(s) {
  s = String(s || '');
  if (/Ã|â€|Â/.test(s)) { try { s = decodeURIComponent(escape(s)); } catch {} }
  if (!/\s/.test(s) && /[-_.]/.test(s)) s = s.replace(/[-_.]+/g, ' ');
  let prev;
  do { prev = s; s = s.replace(SOURCE, '').trim(); } while (s !== prev && s);
  s = s
    .replace(/\s*[\[(]?(?:www\.)?[a-z0-9-]+\.(?:com|net|org|cc|io|to|me|app)[\])]?\s*/gi, ' ')
    .replace(/\s*[\[(]?\d{2,3}\s?k(?:bps)?[\])]?(?=\s|$)/gi, '')
    .replace(/\s*\((?:\d|copy)\)\s*$|\s+copy$/i, '')
    .replace(/[\s_-]+\[?(?=[A-Za-z0-9_-]{11}\]?$)(?=[^\s]*\d)(?=[^\s]*[A-Z])(?=[^\s]*[a-z])[A-Za-z0-9_-]{11}\]?$/, '')
    .replace(/\s{2,}/g, ' ').trim();
  return s;
}
/** Splits "Benny the Butcher x Drake Buffalo" using artists already in your library. */
function splitKnown(text, known) {
  if (!known?.length) return null;
  const set = new Map(known.map(a => [norm(a), a]));
  const words = text.split(/\s+/);
  const joinW = new Set(['x', '&', 'and', 'feat', 'feat.', 'ft', 'ft.', 'featuring', 'with', ',']);
  const take = (from) => { for (let k = words.length - 1; k > from; k--) { const cand = words.slice(from, k).join(' '); if (set.has(norm(cand))) return [k, set.get(norm(cand))]; } return null; };
  const first = take(0); if (!first) return null;
  let [end, artist] = first;
  while (end < words.length - 1 && joinW.has(words[end].toLowerCase())) {
    const more = take(end + 1); if (!more) break;
    artist += ' & ' + more[1]; end = more[0];
  }
  // "Known x Other Song": the second artist isn't in the library yet; most often it's one word ("Drake")
  if (end < words.length - 2 && joinW.has(words[end].toLowerCase())) { artist += ' & ' + words[end + 1]; end += 2; }
  const title = words.slice(end).join(' ');
  return title ? { artist, title } : null;
}
/** Mostly-capitals names ("DRAKE", "JE VEUX REALISER REMIX") become normal case; short acronyms (DJ, VDA) stay. */
const fixCaps = (s, isArtist) => {
  const ws = s.split(/\s+/).filter(w => /\p{L}/u.test(w));
  const caps = ws.filter(w => w === w.toUpperCase() && w.length > 1).length;
  if (!ws.length || caps / ws.length < .6) return s;
  const keep = w => isArtist ? w.length <= 3 : !/[aeiouy]/i.test(w);
  return s.replace(/\p{L}[\p{L}']*/gu, w => keep(w) ? w : w[0] + w.slice(1).toLowerCase());
};
/** "Bayjay Sundaygar Dearboy Slowed + Reverb" → artist Sundaygar Dearboy when that artist is already in the library. */
function findKnown(text, known) {
  const t = ' ' + norm(text) + ' ';
  for (const k of known) {
    const n = norm(k); if (!n || n.split(' ').length < 2 || !t.includes(' ' + n + ' ')) continue;
    const words = text.split(/\s+/), kw = n.split(' ');
    for (let i = 0; i + kw.length <= words.length; i++) {
      if (words.slice(i, i + kw.length).map(norm).join(' ') === n) {
        const title = [...words.slice(0, i), ...words.slice(i + kw.length)].join(' ').replace(/^(?:[-–—&,\s]|x\s)+|(?:[-–—&,\s]|\sx)+$/gi, '').trim();
        return title ? { artist: k, title } : null;
      }
    }
  }
  return null;
}
const titleCase = s => s.replace(/\p{L}[\p{L}']{3,}/gu, w => w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w);

/** Turns a messy tag/file name into { title, artist, album }. */
export function cleanNames(tags, fileName, known = [], channels = []) {
  let raw = prepRaw(tags.title || fileName.replace(/\.[^.]+$/, ''));
  if (!raw) raw = prepRaw(fileName.replace(/\.[^.]+$/, ''));
  let artist = (tags.artist || '').trim();
  let album = (tags.album || '').trim();
  if (!/\s/.test(raw) && raw.includes('_')) raw = raw.replace(/_/g, ' ');
  raw = raw.replace(/^\d{1,3}[\s.\-_]+(?=\D)/, ''); // "09 Circo Loco"
  const uploaderArtist = !artist || UPLOADERS.test(artist) || channels.some(c => norm(c) === norm(artist)) || CHANNELISH.test(artist);
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
    const inL = !!artist && norm(left).includes(norm(artist)), inR = !!artist && norm(right).includes(norm(artist));
    if (RELIGIOUS.test(left) && !RELIGIOUS.test(right)) { title = left; artist = right; }
    // the tag artist is usually the uploading channel ("HYPE", "Forgotten"); the real artist is on the left
    else if (uploaderArtist || inL || (!inR && left.split(/\s+/).length <= 6)) { artist = left; title = right; }
    else if (inR && !inL) { title = left; }
  }
  // Quran videos: "Melodious recitation _ Surah Ad-Dukhan 40-59", "Reciter - Calming Recitation - Al-Isra 78-111"
  if (RELIGIOUS.test(raw)) {
    const SURAH = /\bsurah?\b|\b(?:al|an|ar|as|at|ad|adh|ash|az|ya|ta)-[a-z']+\s+\d+(?:\s*-\s*\d+)?/i;
    const DESC = /recitation|calming|melodious|beautiful|emotional|heart|style|relaxing|soothing|quran|tilawa/i;
    const segs = raw.split(/\s+[-_|•·]\s+/).map(tidy).filter(Boolean);
    const seg = segs.find(x => /\bsurah?\b/i.test(x)) || segs.find(x => SURAH.test(x) && !DESC.test(x));
    if (seg && title !== seg && (DESC.test(title) || !SURAH.test(title))) title = /\bsurah?\b/i.test(seg) ? seg : 'Surah ' + seg;
    const person = segs.find(x => x !== seg && !RELIGIOUS.test(x) && !DESC.test(x) && x.split(/\s+/).length <= 4 && !/[\u0600-\u06FF]/.test(x) && !/^(night|part|ep|episode|day)\b/i.test(x));
    if (person && (DESC.test(title) || title === seg) && !segs.some(x => norm(x) === norm(tags.artist || '')) && /quran|karim|recitation|channel|tv|official/i.test(tags.artist || '')) artist = person;
    else if (person && norm(artist) === norm(segs[0]) === false && /quran|karim/i.test(artist)) artist = person;
  }
  // "[Reciter]" in the title
  const br = raw.match(/\[([^\]]+)\]/);
  if (br && RELIGIOUS.test(raw) && !isJunk(`[${br[1]}]`)) { artist = br[1]; title = title.replace(br[0], ''); }

  if (!artist || uploaderArtist || artist === raw) {
    const sp = splitKnown(tidy(title), known) || findKnown(tidy(title), known);
    if (sp) { artist = sp.artist; title = sp.title; }
    else if (artist && !UPLOADERS.test(artist) && (CHANNELISH.test(artist) || channels.some(c => norm(c) === norm(artist)))) artist = 'Unknown Artist';
  }
  title = (titleCase(fixCaps(tidy(title))) || tidy(raw)).replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  if (!title || /^\d+$/.test(title)) title = 'Untitled';
  if (title === title.toLowerCase() && /[a-z]/.test(title)) title = title.replace(/(^|\s)(\p{L})/gu, (m, sp, c) => sp + c.toUpperCase());
  artist = fixCaps(tidy(artist.replace(/_/g, ' & ').replace(/\s*\/\s*/g, ' & ')), true) || 'Unknown Artist';
  artist = [...new Set(artist.split(/\s*,\s*/))].join(', ');
  const kn = known.find(k => norm(k) === norm(artist));
  if (kn) artist = kn; else if (artist === artist.toLowerCase() && /[a-z]/.test(artist)) artist = artist.replace(/(^|\s)(\p{L})/gu, (m, sp, c) => sp + c.toUpperCase());
  if (UPLOADERS.test(artist)) artist = 'Unknown Artist';
  if (!album || /^unknown album$/i.test(album)) album = '';
  if (RELIGIOUS.test(raw)) { const cap = x => x.replace(/(^|\s)(\p{Ll})/gu, (m, sp, c) => sp + c.toUpperCase()).replace(/(\s)(And|Of|The|In|Verse)\b/g, (m, sp, w) => sp + w.toLowerCase()).replace(/^./, c => c.toUpperCase()); title = cap(title); artist = cap(artist); }
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

/**
 * Finds the real song on Apple's catalog: proper title, artist, album, genre, year and big artwork.
 * Strict on purpose — a wrong match is worse than no match:
 *  - the artist must be known and must match (a song with the same title by someone else is rejected)
 *  - the title must match closely in both directions ("Come Back" never matches "Come Back to Me")
 *  - when both lengths are known, they must be within 20 seconds of each other
 */
export async function lookup(t) {
  const artist = (t.artist || '').replace(/ (feat\.|ft\.|featuring) .*$/i, '').trim();
  if (!artist || /^unknown/i.test(artist)) return null;
  const artists = artist.split(/\s*(?:&|,| x | and )\s*/i).map(norm).filter(Boolean);
  let res;
  try { res = await itunes(`${artist} ${t.title}`, 'song', 25); } catch { return null; }
  let best = null, bestScore = 0;
  for (const r of res) {
    const ts = titleMatch(t.title, r.trackName);
    if (ts < .75) continue;
    const ra = norm(r.artistName);
    const as = artists.some(a => a && (ra.includes(a) || a.includes(ra))) ? 1 : overlap(artist, r.artistName);
    if (as < .6) continue;
    let score = ts + as;
    if (t.duration && r.trackTimeMillis) {
      const diff = Math.abs(t.duration - r.trackTimeMillis / 1000);
      if (diff > 20) continue;
      if (diff <= 4) score += .5;
    }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (!best) return null;
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
/**
 * For files with no usable artist: asks Apple's catalog what the whole name is, and accepts an answer only if
 * the song's real title AND one of its artists both appear in the file name, together cover most of it,
 * and (when known) the length matches within 20 seconds.
 */
export async function identify(text, duration) {
  const words = norm(text).split(' ').filter(Boolean);
  if (words.length < 2) return null;
  let res;
  try { res = await itunes(text, 'song', 25); } catch { return null; }
  const has = phrase => { const p = norm(phrase); return p && (' ' + words.join(' ') + ' ').includes(' ' + p + ' '); };
  let best = null, bestScore = 0;
  for (const r of res) {
    const tw = norm(r.trackName).split(' ').filter(Boolean);
    if (!tw.length || !has(r.trackName)) continue;
    const artists = r.artistName.split(/\s*(?:&|,| x | and | feat\. | featuring )\s*/i).filter(Boolean);
    const hit = artists.filter(has);
    if (!hit.length) continue;
    const covered = new Set([...tw, ...hit.flatMap(a => norm(a).split(' '))]);
    const coverage = words.filter(w => covered.has(w) || ['x', 'and', 'feat', 'ft', 'with'].includes(w)).length / words.length;
    if (coverage < .7) continue;
    let score = coverage + hit.length * .2;
    if (duration && r.trackTimeMillis) { const diff = Math.abs(duration - r.trackTimeMillis / 1000); if (diff > 20) continue; if (diff <= 4) score += .5; }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (!best) return null;
  return { title: best.trackName, artist: best.artistName, album: (best.collectionName || '').replace(/ - (Single|EP)$/, ''), genre: best.primaryGenreName, year: (best.releaseDate || '').slice(0, 4), artUrl: (best.artworkUrl100 || '').replace('100x100bb', '1200x1200bb'), explicit: best.trackExplicitness === 'explicit' };
}
/** Title similarity counted against the longer title, so extra or missing words lower the score. */
function titleMatch(a, b) {
  const A = norm(a).split(' ').filter(Boolean), B = norm(b).split(' ').filter(Boolean);
  if (!A.length || !B.length) return 0;
  const sb = new Set(B); let n = 0; for (const w of new Set(A)) if (sb.has(w)) n++;
  return n / Math.max(new Set(A).size, sb.size);
}
/** True when a saved match clearly belongs to a different artist than the file says. */
export function wrongArtist(fileArtist, matchedArtist) {
  const a = (fileArtist || '').replace(/ (feat\.|ft\.|featuring) .*$/i, '');
  if (!a || /^unknown/i.test(a)) return true;
  const parts = a.split(/\s*(?:&|,| x | and )\s*/i).map(norm).filter(Boolean), m = norm(matchedArtist);
  return !parts.some(p => m.includes(p) || p.includes(m)) && overlap(a, matchedArtist) < .6;
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
/**
 * Lyrics from LRCLIB, accepted only when they are for this exact song:
 *  - title matches closely and the artist matches (never a same-titled song by someone else)
 *  - time-synced lyrics only when the released song is within 3 seconds of your file's length,
 *    otherwise the words would run early or late (edited, sped-up or cut versions)
 *  - plain lyrics when the title and artist match but the length differs (up to 45 seconds)
 */
export async function findLyrics(t) {
  const artist = (t.artist || '').replace(/ (feat\.|ft\.|featuring) .*$/i, '').trim();
  if (!artist || /^unknown/i.test(artist) || !t.title) return { v: 2, none: true, reason: 'unknown' };
  const cands = [];
  const get = async url => { try { const r = await fetch(url); if (r.ok) { const j = await r.json(); (Array.isArray(j) ? j : [j]).forEach(x => x && cands.push(x)); } } catch {} };
  const q = new URLSearchParams({ artist_name: artist, track_name: t.title });
  if (t.duration) q.set('duration', Math.round(t.duration));
  await get('https://lrclib.net/api/get?' + q);
  await get('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: t.title, artist_name: artist }));
  if (!cands.length) await get('https://lrclib.net/api/search?' + new URLSearchParams({ q: `${artist} ${t.title}` }));
  let synced = null, plain = null, sawSong = false;
  for (const c of cands) {
    if (c.instrumental) continue;
    if (titleMatch(t.title, c.trackName) < .85 || wrongArtist(t.artist, c.artistName)) continue;
    sawSong = true;
    const dd = t.duration && c.duration ? Math.abs(t.duration - c.duration) : null;
    if (c.syncedLyrics && dd !== null && dd <= 3 && (!synced || dd < synced.dd)) synced = { dd, text: c.syncedLyrics, plain: c.plainLyrics };
    if (c.plainLyrics && (dd === null || dd <= 45) && (!plain || (dd ?? 99) < plain.dd)) plain = { dd: dd ?? 99, text: c.plainLyrics };
  }
  if (synced) return { v: 2, synced: synced.text, plain: synced.plain || '' };
  if (plain) return { v: 2, synced: '', plain: plain.text, lengthDiffers: true };
  return { v: 2, none: true, reason: sawSong ? 'length' : 'notfound' };
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
