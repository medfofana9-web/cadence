// Podcasts from the Apple Podcasts directory: search as you type, show pages, and episodes.

function jsonp(url) {
  return new Promise(res => {
    const cb = '__pc' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    let t;
    const done = v => { clearTimeout(t); delete window[cb]; s.remove(); res(v); };
    window[cb] = done; s.onerror = () => done(null); t = setTimeout(() => done(null), 12000);
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}
const big = u => (u || '').replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/, '/600x600bb.$2');

export const TOPICS = [
  { key: 'islam', name: 'Islam', term: 'islam', color: '#2e5e4e' },
  { key: 'math', name: 'Math', term: 'mathematics', color: '#3d4f7a' },
  { key: 'education', name: 'Education', term: 'education teaching', color: '#7a4b2e' },
  { key: 'psychology', name: 'Psychology', term: 'psychology', color: '#5b3f7a' },
  { key: 'history', name: 'History', term: 'history', color: '#6e5a2e' },
  { key: 'health', name: 'Health', term: 'health', color: '#7a2e3d' },
];

export const show = r => ({ id: String(r.collectionId), title: r.collectionName || r.trackName || '', author: r.artistName || '', art: big(r.artworkUrl600 || r.artworkUrl100), genre: r.primaryGenreName || '', count: r.trackCount || 0, feed: r.feedUrl || '' });

const cache = new Map();
async function cached(key, ms, fn) {
  const c = cache.get(key); if (c && Date.now() - c.at < ms) return c.v;
  const v = await fn(); if (v) cache.set(key, { at: Date.now(), v }); return v || c?.v || null;
}

export async function search(q, limit = 25) {
  q = q.trim(); if (!q) return [];
  return cached('s:' + q.toLowerCase() + limit, 6e5, async () => {
    const j = await jsonp(`https://itunes.apple.com/search?media=podcast&entity=podcast&limit=${limit}&term=${encodeURIComponent(q)}`);
    return j ? (j.results || []).filter(r => r.collectionId).map(show) : null;
  }) || [];
}

/** A show and its latest episodes (newest first). */
export async function episodes(id, limit = 60) {
  return cached('e:' + id, 9e5, async () => {
    const j = await jsonp(`https://itunes.apple.com/lookup?id=${id}&entity=podcastEpisode&limit=${limit}`);
    if (!j?.results?.length) return null;
    const head = j.results.find(r => r.wrapperType === 'track' && r.kind === 'podcast') || j.results[0];
    const sh = show(head);
    let eps = j.results.filter(r => r.wrapperType === 'podcastEpisode' && r.episodeUrl).map(r => episode(r, sh));
    if (!eps.length && sh.feed) eps = await fromFeed(sh).catch(() => []);
    eps.sort((a, b) => b.date - a.date);
    return { show: sh, episodes: eps };
  }) || { show: null, episodes: [] };
}

export const episode = (r, sh) => ({
  id: 'pod:' + r.trackId, ext: true, kind: 'episode', title: r.trackName || 'Episode', artist: r.collectionName || sh?.title || '', album: r.collectionName || sh?.title || '',
  showId: String(r.collectionId || sh?.id || ''), art: big(r.artworkUrl600 || r.artworkUrl160 || sh?.art), url: r.episodeUrl, fileExt: r.episodeFileExtension || 'mp3',
  duration: (r.trackTimeMillis || 0) / 1000, date: r.releaseDate ? Date.parse(r.releaseDate) : 0, about: (r.shortDescription || r.description || '').slice(0, 600), category: 'Podcast',
});

const dur = v => { if (!v) return 0; if (/^\d+$/.test(v)) return +v; return v.split(':').reduce((a, x) => a * 60 + (+x || 0), 0); };
async function getText(url) {
  try { const r = await fetch(url); if (r.ok) return await r.text(); } catch {}
  const H = window.Capacitor?.Plugins?.CapacitorHttp; // the iPhone app can read any feed
  if (H) { const r = await H.get({ url, responseType: 'text' }); if (r.status < 400) return typeof r.data === 'string' ? r.data : ''; }
  return '';
}
/** Some shows only list their episodes in their own feed. */
async function fromFeed(sh) {
  const xml = await getText(sh.feed); if (!xml) return [];
  const d = new DOMParser().parseFromString(xml, 'text/xml');
  const tag = (el, n) => el.getElementsByTagName(n)[0];
  return [...d.getElementsByTagName('item')].slice(0, 100).map((it, i) => {
    const enc = tag(it, 'enclosure'); const url = enc?.getAttribute('url'); if (!url) return null;
    const guid = tag(it, 'guid')?.textContent || url;
    let h = 0; for (const c of guid) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return { id: 'pod:f' + sh.id + 'x' + (h >>> 0).toString(36), ext: true, kind: 'episode', title: tag(it, 'title')?.textContent?.trim() || 'Episode', artist: sh.title, album: sh.title, showId: sh.id,
      art: tag(it, 'itunes:image')?.getAttribute('href') || sh.art, url, fileExt: (url.split('?')[0].split('.').pop() || 'mp3').slice(0, 4), duration: dur(tag(it, 'itunes:duration')?.textContent),
      date: Date.parse(tag(it, 'pubDate')?.textContent || '') || 0, about: (tag(it, 'description')?.textContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600), category: 'Podcast' };
  }).filter(Boolean);
}
