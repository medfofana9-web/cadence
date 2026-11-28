// The two narrator voices you picked, running right inside Fof Music (no Mac needed):
// deep American (am_onyx) and deep British (bm_lewis). Same voices the Mac uses for full narration.
// The voice model (~90 MB) downloads once and is kept by the browser.
const LIB = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const VOICES = { american: 'am_onyx', british: 'bm_lewis' };

let tts = null, loading = null;
export const ready = () => !!tts;
export function load(onProgress) {
  if (tts) return Promise.resolve(tts);
  if (!loading) loading = (async () => {
    const { KokoroTTS } = await import(LIB);
    const gpu = !!navigator.gpu && !/iPhone|iPad/.test(navigator.userAgent) && await navigator.gpu.requestAdapter().then(Boolean).catch(() => false);
    const seen = new Map();
    const progress = p => { if (p.status === 'progress' && p.total) { seen.set(p.file, [p.loaded, p.total]); let a = 0, b = 0; for (const [l, t] of seen.values()) { a += l; b += t; } onProgress?.(a / b); } };
    try { tts = await KokoroTTS.from_pretrained(MODEL, { dtype: gpu ? 'fp32' : 'q8', device: gpu ? 'webgpu' : 'wasm', progress_callback: progress }); }
    catch (e) { if (!gpu) throw e; tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback: progress }); }
    return tts;
  })().catch(e => { loading = null; throw e; });
  return loading;
}
/** One sentence → { samples: Float32Array, rate } */
export async function speak(text, voice = 'american', speed = 1) {
  const t = await load();
  const out = await t.generate(text, { voice: VOICES[voice] || voice, speed: .94 * speed });
  return { samples: out.audio, rate: out.sampling_rate };
}
