// Tag readers for every common format: MP3 (ID3), M4A/AAC/ALAC (MP4 atoms) and FLAC (Vorbis comments).
// Each returns { title, artist, album, albumArtist, genre, year, track, disc, gain, picture } with only the fields found.

const td = (enc) => { try { return new TextDecoder(enc); } catch { return new TextDecoder('utf-8'); } };
const UTF8 = td('utf-8'), LATIN1 = td('latin1');
const num = s => { const m = String(s || '').match(/\d+/); return m ? m[0] : ''; };
const gainOf = s => { const m = String(s || '').match(/(-?\d+(?:\.\d+)?)\s*dB/i); return m ? parseFloat(m[1]) : undefined; };

export async function readTags(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const sig = String.fromCharCode(...head.slice(0, 4));
    if (sig.startsWith('ID3')) return await id3(file, head);
    if (sig === 'fLaC') return await flac(file);
    if (String.fromCharCode(...head.slice(4, 8)) === 'ftyp') return await mp4(file);
  } catch (e) { console.warn('tags', file.name, e); }
  return {};
}

/* ---------- ID3v2 ---------- */
const syncsafe = (b, o) => (b[o] & 0x7f) << 21 | (b[o + 1] & 0x7f) << 14 | (b[o + 2] & 0x7f) << 7 | (b[o + 3] & 0x7f);
function text(bytes, enc) {
  try {
    if (enc === 0) return LATIN1.decode(bytes);
    if (enc === 1) return td('utf-16').decode(bytes);
    if (enc === 2) return td('utf-16be').decode(bytes);
    return UTF8.decode(bytes);
  } catch { return ''; }
}
const first = s => s.replace(/\u0000+$/g, '').split('\u0000')[0].trim();

async function id3(file, head) {
  const tags = {};
  const ver = head[3];
  const size = syncsafe(head, 6);
  const b = new Uint8Array(await file.slice(10, 10 + Math.min(size, 16 * 1024 * 1024)).arrayBuffer());
  let o = 0;
  if (head[5] & 0x40) o += ver === 4 ? syncsafe(b, 0) : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) + 4;
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  const map = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TCON: 'genre', TCO: 'genre', TYER: 'year', TYE: 'year', TDRC: 'year', TRCK: 'track', TRK: 'track', TPOS: 'disc', TPA: 'disc', TPE2: 'albumArtist', TP2: 'albumArtist' };
  while (o + hdr < b.length) {
    const id = String.fromCharCode(...b.subarray(o, o + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fs;
    if (ver === 2) fs = (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5];
    else if (ver === 4) fs = syncsafe(b, o + 4);
    else fs = ((b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7]) >>> 0;
    if (!fs) break;
    const d = b.subarray(o + hdr, o + hdr + fs);
    o += hdr + fs;
    if (map[id]) tags[map[id]] = first(text(d.subarray(1), d[0]));
    else if (id === 'TXXX' || id === 'TXX') {
      const parts = text(d.subarray(1), d[0]).split('\u0000').filter(Boolean);
      if (/replaygain_track_gain/i.test(parts[0] || '')) tags.gain = gainOf(parts[1]);
    } else if (id === 'APIC' || id === 'PIC') {
      const enc = d[0];
      let p, mime;
      if (id === 'PIC') { mime = 'image/' + String.fromCharCode(...d.subarray(1, 4)).toLowerCase().replace('jpg', 'jpeg'); p = 4; }
      else { const e = d.indexOf(0, 1); mime = LATIN1.decode(d.subarray(1, e)) || 'image/jpeg'; p = e + 1; }
      const picType = d[p]; p++;
      if (enc === 1 || enc === 2) { while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2; p += 2; }
      else { while (p < d.length && d[p] !== 0) p++; p++; }
      if (!tags.picture || picType === 3) tags.picture = new Blob([d.slice(p)], { type: mime.includes('/') ? mime : 'image/jpeg' });
    }
  }
  if (tags.genre) tags.genre = tags.genre.replace(/^\((\d+)\)/, '').trim();
  return finish(tags);
}

/* ---------- MP4 / M4A ---------- */
async function mp4(file) {
  // walk top-level boxes to find moov (it can sit at the end of the file)
  let pos = 0, moov = null;
  while (pos < file.size) {
    const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    if (h.byteLength < 8) break;
    let size = h.getUint32(0); const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    let hl = 8;
    if (size === 1) { size = Number(h.getBigUint64(8)); hl = 16; }
    if (size === 0) size = file.size - pos;
    if (size < 8) break;
    if (type === 'moov') { if (size > 48 * 1024 * 1024) return {}; moov = new Uint8Array(await file.slice(pos + hl, pos + size).arrayBuffer()); break; }
    pos += size;
  }
  if (!moov) return {};
  const tags = {};
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const walk = (start, end, path) => {
    let p = start;
    while (p + 8 <= end) {
      const size = dv.getUint32(p); const type = String.fromCharCode(moov[p + 4], moov[p + 5], moov[p + 6], moov[p + 7]);
      if (size < 8 || p + size > end) break;
      const body = p + 8;
      if (type === 'udta' || type === 'ilst') walk(body, p + size, path + '/' + type);
      else if (type === 'meta') walk(body + 4, p + size, path + '/meta');
      else if (path.endsWith('/ilst')) item(type, body, p + size);
      p += size;
    }
  };
  const item = (type, start, end) => {
    let p = start, mean = '', name = '';
    while (p + 8 <= end) {
      const size = dv.getUint32(p); const t = String.fromCharCode(moov[p + 4], moov[p + 5], moov[p + 6], moov[p + 7]);
      if (size < 8) break;
      if (t === 'name') name = UTF8.decode(moov.subarray(p + 12, p + size));
      if (t === 'mean') mean = UTF8.decode(moov.subarray(p + 12, p + size));
      if (t === 'data') {
        const kind = dv.getUint32(p + 8) & 0xffffff; const v = moov.subarray(p + 16, p + size);
        const str = () => UTF8.decode(v).trim();
        switch (type) {
          case '©nam': tags.title = str(); break;
          case '©ART': tags.artist = str(); break;
          case '©alb': tags.album = str(); break;
          case 'aART': tags.albumArtist = str(); break;
          case '©gen': tags.genre = str(); break;
          case '©day': tags.year = str(); break;
          case 'trkn': if (v.length >= 4) tags.track = String((v[2] << 8) | v[3]); break;
          case 'disk': if (v.length >= 4) tags.disc = String((v[2] << 8) | v[3]); break;
          case 'covr': if (!tags.picture) tags.picture = new Blob([v.slice()], { type: kind === 14 ? 'image/png' : 'image/jpeg' }); break;
          case '----': if (/replaygain_track_gain/i.test(name)) tags.gain = gainOf(str()); break;
        }
      }
      p += size;
    }
    void mean;
  };
  walk(0, moov.length, '');
  return finish(tags);
}

/* ---------- FLAC ---------- */
async function flac(file) {
  const tags = {};
  let pos = 4;
  for (let i = 0; i < 64; i++) {
    const h = new Uint8Array(await file.slice(pos, pos + 4).arrayBuffer());
    if (h.length < 4) break;
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4 || type === 6) {
      const b = new Uint8Array(await file.slice(pos + 4, pos + 4 + len).arrayBuffer());
      const dv = new DataView(b.buffer);
      if (type === 4) {
        let p = 0; const vlen = dv.getUint32(p, true); p += 4 + vlen;
        const n = dv.getUint32(p, true); p += 4;
        for (let k = 0; k < n && p < b.length; k++) {
          const l = dv.getUint32(p, true); p += 4;
          const s = UTF8.decode(b.subarray(p, p + l)); p += l;
          const eq = s.indexOf('='); const key = s.slice(0, eq).toUpperCase(), val = s.slice(eq + 1).trim();
          const m = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist', GENRE: 'genre', DATE: 'year', YEAR: 'year', TRACKNUMBER: 'track', DISCNUMBER: 'disc' }[key];
          if (m && !tags[m]) tags[m] = val;
          if (key === 'REPLAYGAIN_TRACK_GAIN') tags.gain = gainOf(val);
        }
      } else {
        let p = 0; const ptype = dv.getUint32(p); p += 4;
        const ml = dv.getUint32(p); p += 4; const mime = LATIN1.decode(b.subarray(p, p + ml)); p += ml;
        const dl = dv.getUint32(p); p += 4 + dl + 16;
        const datal = dv.getUint32(p); p += 4;
        if (!tags.picture || ptype === 3) tags.picture = new Blob([b.slice(p, p + datal)], { type: mime || 'image/jpeg' });
      }
    }
    pos += 4 + len;
    if (last) break;
  }
  return finish(tags);
}

function finish(t) {
  if (t.year) t.year = num(t.year).slice(0, 4);
  if (t.track) t.track = num(t.track);
  if (t.disc) t.disc = num(t.disc);
  for (const k of Object.keys(t)) if (t[k] === '' || t[k] === undefined) delete t[k];
  return t;
}
