// The Quran: text, translation, juz, and reciters from two sources:
//  - alquran.cloud: one recording per verse (follows along exactly)
//  - mp3quran.net: 240+ reciters, one recording per surah, with verse timings for most
import { kv } from './store.js';

const AQ = 'https://api.alquran.cloud/v1', MQ = 'https://mp3quran.net/api/v3';
async function cached(key, days, fn) {
  const c = await kv.get(key, null);
  if (c && Date.now() - c.at < days * 864e5) return c.v;
  try { const v = await fn(); if (v) kv.set(key, { at: Date.now(), v }); return v; }
  catch (e) { if (c) return c.v; throw e; }
}
const j = async u => { const r = await fetch(u); if (!r.ok) throw new Error('quran ' + r.status); return r.json(); };

export const surahs = () => cached('q-surahs', 365, async () => (await j(AQ + '/surah')).data);
export const juzs = () => cached('q-juz', 365, async () => (await j(AQ + '/meta')).data.juzs.references);

/** Arabic, English (Saheeh International), page and juz for every verse of a surah. */
export const text = n => cached('q-text-' + n, 365, async () => {
  const [ar, en] = (await j(`${AQ}/surah/${n}/editions/quran-uthmani,en.sahih`)).data;
  return ar.ayahs.map((a, i) => {
    let t = a.text;
    if (n !== 1 && a.numberInSurah === 1 && /^بِسْمِ/.test(t)) t = t.split(' ').slice(4).join(' '); // the Bismillah is shown once above the surah
    return { n: a.numberInSurah, g: a.number, ar: t, en: en.ayahs[i]?.text || '', page: a.page, juz: a.juz };
  });
});
/** Per-verse audio links for a verse-by-verse reciter. */
export const verseAudio = (n, ed) => cached(`q-va-${n}-${ed}`, 60, async () => (await j(`${AQ}/surah/${n}/${ed}`)).data.ayahs.map(a => a.audio));

const VERSE_NAMES = { 'ar.alafasy': 'Mishary Alafasy', 'ar.abdulsamad': 'Abdul Basit Abdul Samad', 'ar.husary': 'Mahmoud Khalil Al-Husary', 'ar.husarymujawwad': 'Mahmoud Khalil Al-Husary', 'ar.mahermuaiqly': 'Maher Al-Muaiqly', 'ar.abdurrahmaansudais': 'Abdul Rahman Al-Sudais', 'ar.saoodshuraym': 'Saud Al-Shuraim', 'ar.shaatree': 'Abu Bakr Al-Shatri', 'ar.ahmedajamy': 'Ahmed Al-Ajmi', 'ar.hudhaify': 'Ali Al-Hudhaifi', 'ar.muhammadayyoub': 'Muhammad Ayyub', 'ar.muhammadjibreel': 'Muhammad Jibreel', 'ar.abdullahbasfar': 'Abdullah Basfar', 'ar.hanirifai': 'Hani Ar-Rifai', 'ar.ibrahimakhbar': 'Ibrahim Al-Akhdar', 'ar.aymanswoaid': 'Ayman Suwaid', 'ar.minshawi': 'Mohamed Siddiq Al-Minshawi' };
const key = name => {
  const w = name.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(x => x && !/^(al|as|ash|ar|az|abu|bin|ibn|sheikh|shaik|shaikh|mohammed|muhammad|mohammad|mohamed|abdul|abdel|abd)$/.test(x));
  return (w.pop() || '').replace(/^(al|as|ash|ar|az)/, '').replace(/(.)\1/g, '$1').replace(/[iy]$/, '').slice(0, 4);
};
const slug = s => s.replace(/^https?:\/\/[^/]+\/audio\//, '').replace(/\/$/, '');

/** Every reciter we can play, best known first in their own list. */
export const reciters = () => cached('q-reciters-v1', 7, async () => {
  const out = Object.entries(VERSE_NAMES).filter(([id]) => id !== 'ar.minshawi').map(([id, name]) => ({ id, name, kind: 'verse', style: /mujawwad/.test(id) ? 'Mujawwad' : '', follows: true }));
  let mq = [], reads = [];
  try { [mq, reads] = await Promise.all([j(MQ + '/reciters?language=eng').then(d => d.reciters), j(MQ + '/ayat_timing/reads')]); } catch {}
  const timing = new Map(reads.map(r => [slug(r.folder_url), r.id]));
  const taken = new Set(out.filter(r => !r.style).map(r => key(r.name)));
  for (const r of mq) for (const m of r.moshaf) {
    const hafs = /Hafs/.test(m.name), muj = /Mojawwad|Mujawwad/i.test(m.name);
    if (hafs && !muj && taken.has(key(r.name))) continue; // already in the verse-by-verse list
    const style = [muj ? 'Mujawwad' : '', hafs ? '' : (m.name.match(/Rewayat (\w+)/)?.[1] || '')].filter(Boolean).join(' · ');
    out.push({ id: 'mq:' + slug(m.server), name: r.name.replace(/\s+/g, ' ').trim(), kind: 'surah', server: m.server, style, surahs: m.surah_list, read: timing.get(slug(m.server)) || 0, follows: !!timing.get(slug(m.server)) });
  }
  return out;
});
/** When each verse starts and ends in a whole-surah recording (milliseconds). */
export const timing = (read, n) => cached(`q-t-${read}-${n}`, 120, async () => (await j(`${MQ}/ayat_timing?surah=${n}&read=${read}`)).map(x => [x.start_time, x.end_time]));
export const surahUrl = (r, n) => r.server + String(n).padStart(3, '0') + '.mp3';
export const has = (r, n) => r.kind === 'verse' || (',' + r.surahs + ',').includes(',' + n + ',');

export const DAILY = [[2, 286], [2, 255], [94, 5], [94, 6], [65, 3], [2, 152], [13, 28], [3, 139], [39, 53], [2, 186], [40, 60], [29, 69], [8, 46], [16, 128], [20, 114], [3, 173], [9, 51], [12, 87], [21, 87], [25, 63], [31, 18], [33, 41], [49, 13], [55, 13], [57, 4], [64, 11], [67, 2], [93, 3], [93, 5], [2, 45], [2, 153], [3, 159], [4, 28], [6, 162], [11, 88], [14, 7], [17, 24], [28, 24], [30, 21], [35, 2], [42, 30], [50, 16], [2, 201], [3, 8], [7, 156], [18, 10], [20, 25], [23, 118], [46, 15], [59, 22]];
export const verse = (s, v) => cached(`q-v-${s}-${v}`, 365, async () => { const [a, e] = (await j(`${AQ}/ayah/${s}:${v}/editions/quran-uthmani,en.sahih`)).data; return { s, v, ar: a.text, en: e.text, name: a.surah.englishName }; });

const arts = new Map();
/** A plain cover for the lock screen: deep green with the surah's name. */
export function cover(name, arabic) {
  if (arts.has(name)) return arts.get(name);
  const c = document.createElement('canvas'); c.width = c.height = 600; const x = c.getContext('2d');
  x.fillStyle = '#163029'; x.fillRect(0, 0, 600, 600);
  x.strokeStyle = 'rgba(214,190,128,.55)'; x.lineWidth = 3;
  for (const r of [0, Math.PI / 4]) { x.save(); x.translate(300, 250); x.rotate(r); x.strokeRect(-95, -95, 190, 190); x.restore(); }
  x.fillStyle = '#e9dcb4'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '64px "Geeza Pro","Noto Naskh Arabic","Amiri",serif'; x.fillText(arabic || '', 300, 252);
  x.font = '600 34px -apple-system,system-ui,sans-serif'; x.fillText(name, 300, 470);
  x.fillStyle = 'rgba(233,220,180,.6)'; x.font = '26px -apple-system,system-ui,sans-serif'; x.fillText('Quran', 300, 520);
  const u = c.toDataURL('image/jpeg', .86); arts.set(name, u); return u;
}
export const arNum = n => Number(n).toLocaleString('ar-EG');
