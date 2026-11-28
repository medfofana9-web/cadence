// YouTube's official player, shaped like an <audio> element so the queue, next/previous, the progress bar,
// resume and sync all work unchanged. Used for recitations that are only published on YouTube.
// YouTube's rules ask that the player stays visible, so it shows as the artwork while it plays.

let apiP = null;
function api() {
  if (window.YT?.Player) return Promise.resolve();
  return apiP ||= new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); res(); };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true;
    s.onerror = () => { apiP = null; rej(new Error('YouTube unavailable')); };
    document.head.appendChild(s);
  });
}
const idOf = src => String(src || '').replace(/^yt:/, '');

export class YtAudio extends EventTarget {
  constructor(host) {
    super();
    Object.assign(this, { host, _src: '', _loaded: '', _t: 0, _d: NaN, _paused: true, _vol: 1, _rate: 1, _poll: 0, _ready: null, p: null, error: null, preload: 'auto', readyState: 0 });
  }
  fire(type) { this.dispatchEvent(new Event(type)); }
  player() {
    return this._ready ||= api().then(() => new Promise(res => {
      const div = document.createElement('div'); this.host.appendChild(div);
      this.p = new window.YT.Player(div, {
        width: '100%', height: '100%',
        playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, iv_load_policy: 3, fs: 0, origin: location.origin },
        events: { onReady: () => { this.p.setVolume(Math.round(this._vol * 100)); res(this.p); }, onStateChange: e => this.state(e.data), onError: e => this.fail(e.data) },
      });
    })).catch(e => { this._ready = null; this.fail(-1); throw e; });
  }

  get src() { return this._src; }
  set src(v) {
    this._src = v || ''; this._t = 0; this._d = NaN; this.error = null; this.readyState = 0; this._paused = true; this.stopPoll();
    if (!v) { this.p?.stopVideo?.(); this._loaded = ''; return; }
    this.host.classList.add('on');
    // only line it up when nothing asked to play it straight away (play() loads and starts it in one go)
    this.player().then(p => { if (this._src !== v || this._loaded === idOf(v) || !this._paused) return; this._loaded = idOf(v); p.cueVideoById({ videoId: idOf(v), startSeconds: this._t }); }).catch(() => {});
  }
  getAttribute(n) { return n === 'src' ? this._src || null : null; }
  removeAttribute(n) { if (n === 'src') this.src = ''; }
  load() {}

  play() {
    if (!this._src) return Promise.resolve();
    const v = this._src;
    this._paused = false; this.fire('play');
    return this.player().then(p => {
      if (this._src !== v || this._paused) return;
      if (this._loaded !== idOf(v)) { this._loaded = idOf(v); p.loadVideoById({ videoId: idOf(v), startSeconds: this._t }); }
      else if (p.getPlayerState?.() === 5) p.loadVideoById({ videoId: idOf(v), startSeconds: this._t }); // a lined-up video can ignore playVideo
      else p.playVideo();
    });
  }
  pause() {
    const was = !this._paused; this._paused = true; this.stopPoll();
    try { this._t = this.p?.getCurrentTime?.() ?? this._t; this.p?.pauseVideo?.(); } catch {}
    if (was) this.fire('pause');
  }
  get paused() { return this._paused; }
  /** While YouTube shows an ad first, the player reports the ad's clock; the recitation's spot is kept instead. */
  get live() { try { return this._loaded === idOf(this._src) && [1, 2, 3].includes(this.p?.getPlayerState?.()); } catch { return false; } }
  get currentTime() { try { const t = this.p?.getCurrentTime?.(); if (this.live && t > 0) return t; } catch {} return this._t; }
  set currentTime(v) {
    this._t = v;
    try {
      if (this._loaded !== idOf(this._src)) {} // applied when it loads
      else if (this.p?.getPlayerState?.() === 5) this.p.cueVideoById({ videoId: idOf(this._src), startSeconds: v }); // a jump on a lined-up video would start it playing
      else this.p?.seekTo?.(v, true);
    } catch {}
    this.fire('timeupdate');
  }
  get duration() { try { const d = this.p?.getDuration?.(); if (d > 0 && this.live) return d; } catch {} return this._d; }
  set duration(_) {}
  get volume() { return this._vol; }
  set volume(v) { this._vol = v; try { this.p?.setVolume?.(Math.round(v * 100)); } catch {} }
  get playbackRate() { return this._rate; }
  set playbackRate(r) { this._rate = r; try { this.p?.setPlaybackRate?.(r); } catch {} }
  /** Hides the picture when a song from your own library takes over. */
  release() { this.pause(); this.host.classList.remove('on'); }

  state(s) {
    if (s === 1) { // playing
      if (this.readyState < 1) { this.readyState = 4; this.fire('loadedmetadata'); }
      if (this._paused) { this._paused = false; this.fire('play'); }
      this.fire('playing'); this.startPoll();
    } else if (s === 2) { // paused (by YouTube, e.g. the phone was locked)
      this.stopPoll(); if (!this._paused) { this._paused = true; this.fire('pause'); }
    } else if (s === 3) this.fire('waiting');
    else if (s === 0) { this.stopPoll(); this._paused = true; this._t = 0; this.fire('ended'); }
    else if (s === 5 && this.duration > 0 && this.readyState < 1) { this.readyState = 1; this.fire('loadedmetadata'); }
  }
  fail(code) {
    this.stopPoll(); this._paused = true;
    // 2: bad id · 5: player problem · 100: removed · 101/150: owner doesn't allow embedding
    this.error = { code: [100, 101, 150, 2].includes(code) ? 4 : 2, noApi: code === -1 };
    this.fire('error');
  }
  startPoll() { this.stopPoll(); this._poll = setInterval(() => this.fire('timeupdate'), 250); }
  stopPoll() { clearInterval(this._poll); this._poll = 0; }
}
