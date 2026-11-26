// The Quran: surah list, Arabic text with translation, and verse-by-verse recitation.
const API = 'https://api.alquran.cloud/v1';
export const RECITERS = [
  { id: 'ar.alafasy', name: 'Mishary Alafasy' },
  { id: 'ar.abdulbasitmurattal', name: 'Abdul Basit' },
  { id: 'ar.husary', name: 'Mahmoud Al-Husary' },
  { id: 'ar.minshawi', name: 'Al-Minshawi' },
  { id: 'ar.mahermuaiqly', name: 'Maher Al-Muaiqly' },
  { id: 'ar.saoodshuraym', name: 'Saud Al-Shuraim' },
];
const get = async (path, key) => {
  try { const c = localStorage.getItem(key); if (c) return JSON.parse(c); } catch {}
  const r = await fetch(API + path); if (!r.ok) throw new Error('quran ' + r.status);
  const j = (await r.json()).data;
  try { localStorage.setItem(key, JSON.stringify(j)); } catch {}
  return j;
};
export const surahs = () => get('/surah', 'fof-q-list');
/** Arabic, English (Saheeh International) and the reciter's audio for one surah. */
export async function surah(n, reciter) {
  const [ar, en] = await get(`/surah/${n}/editions/quran-uthmani,en.sahih`, 'fof-q-' + n);
  let audio = null;
  try { audio = await get(`/surah/${n}/${reciter}`, `fof-q-${n}-${reciter}`); } catch {}
  return ar.ayahs.map((a, i) => ({ n: a.numberInSurah, g: a.number, ar: a.text, en: en.ayahs[i]?.text || '', audio: audio?.ayahs?.[i]?.audio || `https://cdn.islamic.network/quran/audio/128/${reciter}/${a.number}.mp3` }));
}
const arts = new Map();
/** A plain cover for the lock screen: deep green with the surah's name. */
export function cover(name, arabic) {
  const k = name; if (arts.has(k)) return arts.get(k);
  const c = document.createElement('canvas'); c.width = c.height = 600; const x = c.getContext('2d');
  x.fillStyle = '#163029'; x.fillRect(0, 0, 600, 600);
  x.strokeStyle = 'rgba(214,190,128,.55)'; x.lineWidth = 3;
  for (const r of [0, Math.PI / 4]) { x.save(); x.translate(300, 250); x.rotate(r); x.strokeRect(-95, -95, 190, 190); x.restore(); }
  x.fillStyle = '#e9dcb4'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '64px "Geeza Pro","Noto Naskh Arabic","Amiri",serif'; x.fillText(arabic || '', 300, 252);
  x.font = '600 34px -apple-system,system-ui,sans-serif'; x.fillText(name, 300, 470);
  x.fillStyle = 'rgba(233,220,180,.6)'; x.font = '26px -apple-system,system-ui,sans-serif'; x.fillText('Quran', 300, 520);
  const u = c.toDataURL('image/jpeg', .86); arts.set(k, u); return u;
}
