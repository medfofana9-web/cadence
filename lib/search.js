// Search index: built once when the library changes, so typing never rescans every song.

export const fold = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

function within1(a, b) {
  // true when a and b differ by at most one edit (typo tolerance)
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Scores one search term against a set of words. 0 = no match. */
function termScore(term, words, full) {
  let best = 0;
  for (const w of words) {
    if (w === term) return 10;
    if (w.startsWith(term)) best = Math.max(best, 7);
    else if (term.length >= 3 && w.includes(term)) best = Math.max(best, 4);
    else if (term.length >= 4 && (within1(term, w) || within1(term, w.slice(0, term.length)))) best = Math.max(best, 3);
  }
  if (!best && term.length >= 4 && full.replace(/ /g, '').includes(term)) best = 3;
  return best;
}

export class Index {
  constructor() { this.items = []; }
  build(entries) { // entries: [{ kind, key, text, primary, weight }]
    this.items = entries.map(e => { const full = fold(e.text); const prim = fold(e.primary); return { ...e, full, prim, words: [...new Set(full.split(' '))] }; });
  }
  search(q, limit = 200) {
    const terms = fold(q).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    for (const it of this.items) {
      let s = 0;
      for (const t of terms) { const ts = termScore(t, it.words, it.full); if (!ts) { s = 0; break; } s += ts; }
      if (!s) continue;
      if (it.prim.startsWith(terms.join(' '))) s += 12;
      else if (it.prim.includes(terms.join(' '))) s += 5;
      out.push([s + (it.weight || 0), it]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
  }
}
