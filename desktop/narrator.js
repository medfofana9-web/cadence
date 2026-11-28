// Fof Music for Mac: turns books into audiobooks.
// Put an EPUB or PDF in ~/Music/Fof Music Books. The Mac reads it aloud chapter by chapter (on its own chip, no cloud, free)
// and saves tagged MP3s in ~/Music/Fof Music/Audiobooks, where the normal song import picks them up and syncs them.
// The first book also sets up the voice (a one-time download of about 3 GB).
const { app, powerSaveBlocker, dialog, Notification } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');

const HOME = os.homedir();
const BOOKS = path.join(HOME, 'Music', 'Fof Music Books');
const DONE = path.join(BOOKS, 'Narrated');
const OUT = path.join(HOME, 'Music', 'Fof Music', 'Audiobooks');
const BOOK = /\.(epub|pdf)$/i;
const SITE = 'https://medfofana9-web.github.io/cadence/';
const dir = () => path.join(app.getPath('userData'), 'narrator');
const BASE = ['soundfile', 'mutagen', 'imageio-ffmpeg', 'beautifulsoup4', 'lxml', 'pymupdf'];
const PKGS = engine => [...(engine === 'kokoro' ? ['kokoro', 'misaki[en]'] : ['chatterbox-tts==0.1.7']), ...BASE];

let status = { busy: false, line: '', book: '' }, onChange = () => {}, child = null, timer = null, blocker = null;
const set = s => { status = { ...status, ...s }; onChange(status); };
const log = m => { try { fs.appendFileSync(path.join(dir(), 'narrator.log'), `[${new Date().toISOString()}] ${m}\n`); } catch {} };

function get(url, dest) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'user-agent': 'FofMusicMac' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return get(new URL(r.headers.location, url).toString(), dest).then(res, rej); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error(`${url} → ${r.statusCode}`)); }
      const f = fs.createWriteStream(dest + '.part'); r.pipe(f);
      f.on('finish', () => f.close(() => { fs.renameSync(dest + '.part', dest); res(dest); }));
      f.on('error', rej);
    }).on('error', rej);
  });
}

/** uv runs Python and installs the voice model's packages into its own cache; nothing touches the rest of the Mac. */
async function uv() {
  const bin = path.join(dir(), 'uv');
  if (fs.existsSync(bin)) return bin;
  set({ line: 'Setting up the narrator…' });
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const tgz = path.join(dir(), 'uv.tar.gz');
  await get(`https://github.com/astral-sh/uv/releases/latest/download/uv-${arch}-apple-darwin.tar.gz`, tgz);
  await new Promise((res, rej) => execFile('tar', ['-xzf', tgz, '-C', dir(), '--strip-components=1'], e => (e ? rej(e) : res())));
  fs.chmodSync(bin, 0o755);
  return bin;
}
/** The narration scripts come from the live site, so improvements arrive without reinstalling the Mac app. */
async function scripts() {
  for (const f of ['narrate.py', 'epub_text.py', 'voice.json']) {
    try { await get(`${SITE}tools/audiobook/${f}?t=${Date.now()}`, path.join(dir(), f)); } catch (e) { if (!fs.existsSync(path.join(dir(), f)) && f !== 'voice.json') throw e; }
  }
  let v = { engine: 'chatterbox', voice: 'default' };
  try { v = { ...v, ...JSON.parse(fs.readFileSync(path.join(dir(), 'voice.json'), 'utf8')) }; } catch {}
  if (v.ref) { try { await get(`${SITE}tools/audiobook/refs/${v.ref}`, path.join(dir(), 'refs', v.ref)); v.voice = path.join(dir(), 'refs', v.ref); } catch {} }
  return v;
}

async function nextBook() {
  let ents = []; try { ents = await fsp.readdir(BOOKS); } catch { return null; }
  const list = [];
  for (const n of ents) {
    if (n.startsWith('.') || !BOOK.test(n)) continue;
    const p = path.join(BOOKS, n);
    try { const st = await fsp.stat(p); if (st.isFile() && Date.now() - st.mtimeMs > 5000) list.push({ p, n, m: st.mtimeMs }); } catch {}
  }
  list.sort((a, b) => a.m - b.m);
  return list[0] || null;
}

async function run() {
  if (status.busy) return;
  const b = await nextBook(); if (!b) return;
  set({ busy: true, book: b.n.replace(BOOK, ''), line: 'Getting ready…' });
  blocker = powerSaveBlocker.start('prevent-app-suspension');
  try {
    fs.mkdirSync(path.join(dir(), 'refs'), { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
    const bin = await uv(), v = await scripts();
    log(`start ${b.n} with ${v.engine}/${v.voice}`);
    const args = ['run', '--quiet', '--python', '3.11', ...PKGS(v.engine).flatMap(p => ['--with', p]), path.join(dir(), 'narrate.py'), b.p, OUT, '--engine', v.engine, '--voice', v.voice];
    const code = await new Promise(res => {
      child = spawn(bin, args, { cwd: dir(), env: { ...process.env, UV_CACHE_DIR: path.join(dir(), 'cache'), UV_PYTHON_INSTALL_DIR: path.join(dir(), 'python'), PYTORCH_ENABLE_MPS_FALLBACK: '1', HF_HOME: path.join(dir(), 'models'), PATH: `${dir()}:/usr/bin:/bin:/usr/sbin:/sbin` } });
      let buf = '';
      child.stdout.on('data', d => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.step === 'book') set({ book: m.title, line: `${m.chapters} chapters` });
          if (m.step === 'loading') set({ line: 'Loading the voice (the first time takes a while)…' });
          if (m.step === 'progress') set({ line: `Chapter ${m.n} of ${m.of} · ${Math.round(m.chunk / Math.max(1, m.chunks) * 100)}%` });
          if (m.step === 'chapter') { set({ line: `Chapter ${m.n} of ${m.of} done` }); onChange(status, 'chapter'); log(`chapter ${m.n}/${m.of} in ${m.seconds}s`); }
        }
      });
      child.stderr.on('data', d => { const s = String(d); if (/error|Traceback/i.test(s)) log(s.slice(0, 2000)); if (/Downloading|Installed|Prepared/i.test(s)) set({ line: 'Downloading the voice (one time, about 3 GB)…' }); });
      child.on('close', res);
      child.on('error', e => { log('spawn ' + e.message); res(-1); });
    });
    child = null;
    if (code === 0) {
      fs.mkdirSync(DONE, { recursive: true });
      await fsp.rename(b.p, path.join(DONE, b.n)).catch(() => {});
      try { new Notification({ title: 'Audiobook ready', body: `${status.book} is in Fof Music.` }).show(); } catch {}
      log(`done ${b.n}`);
    } else if (code !== null) {
      log(`failed ${b.n} (exit ${code})`);
      try { new Notification({ title: 'Couldn’t finish the audiobook', body: `${status.book}: it will try again later.` }).show(); } catch {}
      await new Promise(r => setTimeout(r, 10 * 60 * 1000)); // don't retry in a tight loop
    }
  } catch (e) { log('error ' + (e.stack || e)); await new Promise(r => setTimeout(r, 10 * 60 * 1000)); }
  finally {
    if (blocker !== null) { try { powerSaveBlocker.stop(blocker); } catch {} blocker = null; }
    set({ busy: false, line: '', book: '' });
    setTimeout(run, 3000);
  }
}

async function addBook(win) {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], message: 'Pick a book to turn into an audiobook', filters: [{ name: 'Books', extensions: ['epub', 'pdf'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  fs.mkdirSync(BOOKS, { recursive: true });
  for (const f of r.filePaths) await fsp.copyFile(f, path.join(BOOKS, path.basename(f)));
  setTimeout(run, 6000);
  return r.filePaths.map(f => path.basename(f).replace(BOOK, '').replace(/\s*\(z-lib.*\)$/i, '')).join(', ');
}

function start(cb) {
  onChange = cb || onChange;
  try { fs.mkdirSync(BOOKS, { recursive: true }); fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(dir(), { recursive: true }); } catch {}
  try { fs.watch(BOOKS, () => { clearTimeout(timer); timer = setTimeout(run, 7000); }); } catch {}
  setInterval(run, 5 * 60 * 1000);
  setTimeout(run, 20000);
}
function stop() { if (child) try { child.kill(); } catch {} }

module.exports = { start, stop, addBook, status: () => status, BOOKS, OUT };
