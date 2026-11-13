// Artwork helpers: small thumbnails for lists, and colors pulled from the artwork for backgrounds.

async function bitmap(src) {
  if (src instanceof Blob) return await createImageBitmap(src);
  const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async'; img.src = src;
  await img.decode(); return img;
}

/** 360px square JPEG used in grids and lists, so scrolling never decodes 1200px covers. */
export async function thumbnail(blob, size = 360) {
  try {
    const bm = await bitmap(blob);
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const x = c.getContext('2d');
    const s = Math.min(bm.width, bm.height);
    x.drawImage(bm, (bm.width - s) / 2, (bm.height - s) / 2, s, s, 0, 0, size, size);
    bm.close?.();
    return c.convertToBlob ? await c.convertToBlob({ type: 'image/jpeg', quality: .86 }) : await new Promise(r => c.toBlob(r, 'image/jpeg', .86));
  } catch { return null; }
}

const toHex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2rgb(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * Two background colors from the artwork: a deep base and a lighter companion.
 * Both are darkened enough that white text always stays readable on top.
 */
export async function artColors(src) {
  try {
    const bm = await bitmap(src);
    const c = document.createElement('canvas'); c.width = c.height = 28;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bm, 0, 0, 28, 28);
    const d = x.getImageData(0, 0, 28, 28).data;
    const buckets = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
      if (l < .06 || l > .96) continue;
      const key = s < .12 ? 'gray' : Math.round(h / 24);
      const w = .25 + s * (1 - Math.abs(l - .5));
      const b = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 };
      b.w += w; b.r += d[i] * w; b.g += d[i + 1] * w; b.b += d[i + 2] * w;
      buckets.set(key, b);
    }
    const ranked = [...buckets.values()].sort((a, b) => b.w - a.w).map(b => [b.r / b.w, b.g / b.w, b.b / b.w]);
    if (!ranked.length) return null;
    const tone = (rgb, light) => { const [h, s] = rgb2hsl(...rgb); return toHex(hsl2rgb(h, Math.min(s, .55), light)); };
    const a = ranked[0], b = ranked[1] || ranked[0];
    return { base: tone(a, .2), glow: tone(b, .34), accent: tone(a, .62) };
  } catch { return null; }
}
