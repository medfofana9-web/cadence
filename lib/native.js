// The iPhone app's own player, shaped like an <audio> element so the rest of Fof Music works unchanged.
// Two of these (players 0 and 1) let the next song load ahead and songs blend into each other, like on a computer.

const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
async function fileKey(blob) {
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', head));
  return [...h.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('') + '-' + blob.size;
}
const files = new Map(); // blob url → file path on the phone

export class NativeAudio extends EventTarget {
  constructor(id, player) {
    super();
    Object.assign(this, { id, P: player, _src: '', _t: 0, _d: NaN, _paused: true, _vol: 1, _rate: 1, readyState: 0, error: null, preload: 'auto', _seq: 0, _loadP: null, _pending: 0, _seekTimer: null, _seekId: 0 });
    const mine = f => e => { if (e.id === id) f(e); };
    player.addListener('time', mine(e => {
      this._heard = performance.now();
      // once the phone reports a spot near where we jumped to, the jump is done
      if (this._seekTimer !== null && Math.abs(e.t - this._t) < 1.5) this._clearSeek();
      if (this._seekTimer === null) this._t = e.t;
      if (e.d) this._d = e.d;
      this.fire('timeupdate');
    }));
    // If the phone goes quiet while a song is playing (it can after a jump), keep the clock moving here
    // so the bar and timer never stand still while you can hear the song.
    this._heard = 0; this._waiting = true;
    setInterval(() => {
      if (this._paused || this._waiting || !this._src || this.readyState < 1 || this._seekTimer !== null) return;
      const quiet = performance.now() - this._heard;
      if (quiet < 1000) return;
      this._t = Math.min(this._t + 0.5 * this._rate, Number.isFinite(this._d) && this._d > 0 ? this._d : Infinity);
      this.fire('timeupdate');
    }, 500);
    player.addListener('ready', mine(e => { if (e.d) this._d = e.d; this.readyState = 4; this.fire('loadedmetadata'); this.fire('durationchange'); this.fire('canplay'); }));
    player.addListener('state', mine(e => {
      this._waiting = e.state !== 'playing';
      if (e.state === 'playing') { if (this._paused) { this._paused = false; this.fire('play'); } this.fire('playing'); }
      else if (e.state === 'waiting' && !this._paused) this.fire('waiting');
    }));
    player.addListener('ended', mine(() => { this._paused = true; this.fire('ended'); }));
    player.addListener('error', mine(e => { this.error = { code: 4, message: e.message }; this.fire('error'); }));
    player.addListener('seeked', mine(e => {
      if (this._seekTimer === null || Math.abs(e.t - this._t) > 0.01) return;
      this._clearSeek();
      this.fire('seeked');
      this.fire('timeupdate');
    }));
  }
  fire(n) { this.dispatchEvent(new Event(n)); }

  _clearSeek() {
    clearTimeout(this._seekTimer);
    this._seekTimer = null;
    this._seekId++;
  }

  get src() { return this._src; }
  set src(v) {
    this._clearSeek(); this._pending = 0;
    this._src = v || ''; this._t = 0; this._d = NaN; this.readyState = 0; this.error = null; this._paused = true;
    this._loadP = v ? this._load() : null;
  }
  getAttribute(a) { return a === 'src' ? (this._src || null) : null; }
  removeAttribute(a) { if (a === 'src') { this._clearSeek(); this._src = ''; this._loadP = null; this._paused = true; this.P.stop({ id: this.id }).catch(() => {}); } }
  load() {}

  /** Songs saved in the app are handed to the phone's player as a file (once; it's kept). */
  async _resolve(url) {
    if (!url.startsWith('blob:')) return url;
    if (files.has(url)) return files.get(url);
    const b = await fetch(url).then(r => r.blob());
    const ext = /mp4|m4a|aac|alac/.test(b.type) ? 'm4a' : /flac/.test(b.type) ? 'flac' : /wav/.test(b.type) ? 'wav' : /ogg|opus/.test(b.type) ? 'ogg' : 'mp3';
    const name = (await fileKey(b)) + '.' + ext;
    const has = await this.P.hasFile({ name, size: b.size });
    if (has.path) { files.set(url, has.path); return has.path; }
    const CH = 1024 * 1024; let path = '';
    for (let o = 0; o < b.size; o += CH) path = (await this.P.writeFile({ name, data: await toB64(b.slice(o, o + CH)), append: o > 0 })).path;
    files.set(url, path); return path;
  }
  async _load() {
    const seq = ++this._seq;
    const url = await this._resolve(this._src);
    if (seq !== this._seq) return;
    const start = this._pending; this._pending = 0;
    await this.P.load({ id: this.id, url, autoplay: false, start });
    await this.P.setVolume({ id: this.id, volume: this._vol });
    await this.P.setRate({ id: this.id, rate: this._rate });
  }

  play() {
    if (!this._src) return Promise.reject(Object.assign(new Error('no source'), { name: 'NotSupportedError' }));
    const was = this._paused; this._paused = false; if (was) this.fire('play');
    return (this._loadP || Promise.resolve()).then(() => this.P.play({ id: this.id })).catch(e => { this.error = { code: 4, message: String(e?.message || e) }; this.fire('error'); });
  }
  pause() { const was = this._paused; this._paused = true; this.P.pause({ id: this.id }).catch(() => {}); if (!was) this.fire('pause'); }
  get paused() { return this._paused; }
  get currentTime() { return this._t; }
  set currentTime(v) {
    v = Math.max(0, +v || 0); this._t = v;
    if (!this._src) return;
    if (this.readyState < 1) { this._pending = v; return; }
    this._clearSeek();
    const id = this._seekId;
    const resumeUpdates = () => { if (this._seekId === id) this._clearSeek(); };
    // Keep the target visible while seeking, then trust native progress again even if the callback is lost.
    this._seekTimer = setTimeout(resumeUpdates, 1500);
    this.P.seek({ id: this.id, time: v }).catch(resumeUpdates);
  }
  get duration() { return this._d; }
  get volume() { return this._vol; }
  set volume(v) { this._vol = v; if (this._src) this.P.setVolume({ id: this.id, volume: v }).catch(() => {}); }
  get playbackRate() { return this._rate; }
  set playbackRate(r) { this._rate = r; if (this._src) this.P.setRate({ id: this.id, rate: r }).catch(() => {}); }
  webkitShowPlaybackTargetPicker() { this.P.routePicker().catch(() => {}); }
  /** Called when a phone call or Siri paused the sound. */
  interrupted() { if (!this._paused) { this._paused = true; this.fire('pause'); } }
}
