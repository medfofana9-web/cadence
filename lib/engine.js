// One playback engine for the whole app. Two audio elements take turns so the next song can be
// buffered ahead of time (gapless) and blended in (crossfade). Only one is ever "active".

export const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class Engine extends EventTarget {
  constructor(a, b) {
    super();
    this.els = [a, b];
    this.i = 0;
    this.master = 1;
    this.gain = new Map([[a, 1], [b, 1]]);
    this.fade = new Map([[a, 1], [b, 1]]);
    this.spareKey = null;
    this.fading = null;
    this.rate = 1;
  }
  get el() { return this.els[this.i]; }
  get spare() { return this.els[1 - this.i]; }
  /** Dual mode buffers the next song in the second element. iPhone/iPad only allow one playing element in the background. */
  get dual() { return !IS_IOS; }

  apply(el) { try { el.volume = Math.max(0, Math.min(1, this.master * this.gain.get(el) * this.fade.get(el))); } catch {} }
  setVolume(v) { this.master = v; this.els.forEach(e => this.apply(e)); }
  setRate(r) { this.rate = r; this.els.forEach(e => { e.playbackRate = r; }); }
  /** ReplayGain in dB → volume factor. Browsers can only turn sound down, so loud tracks are lowered to match. */
  static factor(db) { return db === undefined || db === null || isNaN(db) ? 1 : Math.min(1, Math.pow(10, (db + 0) / 20)); }

  load(src, { gainDb, autoplay = true } = {}) {
    this.cancelFade();
    const el = this.el;
    this.spare.pause();
    if (this.spareKey) { this.spare.removeAttribute('src'); this.spare.load(); this.spareKey = null; }
    this.gain.set(el, Engine.factor(gainDb)); this.fade.set(el, 1); this.apply(el);
    el.src = src; el.playbackRate = this.rate;
    return autoplay ? el.play() : Promise.resolve();
  }

  /** Buffers the next song while this one is still playing. */
  preload(key, src, gainDb) {
    if (!this.dual || this.spareKey === key) return;
    const s = this.spare;
    s.pause(); s.preload = 'auto'; s.src = src; s.playbackRate = this.rate;
    this.gain.set(s, Engine.factor(gainDb)); this.fade.set(s, 0); this.apply(s);
    s.load();
    this.spareKey = key;
  }
  hasSpare(key) { return this.dual && this.spareKey === key; }

  /** Switches to the buffered song. seconds = 0 gives a gapless cut, otherwise a crossfade. */
  async advance(seconds = 0) {
    const out = this.el, inn = this.spare;
    this.i = 1 - this.i; this.spareKey = null;
    inn.currentTime = 0;
    this.fade.set(inn, seconds ? 0 : 1); this.apply(inn);
    try { await inn.play(); } catch (e) { this.dispatchEvent(new Event('playfail')); }
    this.dispatchEvent(new Event('switched'));
    if (!seconds) { out.pause(); return; }
    const t0 = performance.now(), dur = seconds * 1000;
    this.cancelFade();
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const ease = k * k * (3 - 2 * k);
      this.fade.set(inn, ease); this.fade.set(out, 1 - ease); this.apply(inn); this.apply(out);
      if (k < 1) this.fading = setTimeout(tick, 50);
      else { out.pause(); this.fade.set(out, 1); this.fading = null; }
    };
    tick();
  }
  cancelFade() {
    if (!this.fading) return;
    clearTimeout(this.fading); this.fading = null;
    this.spare.pause();
    this.fade.set(this.el, 1); this.apply(this.el);
  }
}
