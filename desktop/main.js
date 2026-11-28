// Fof Music for Mac
// - opens at login, quietly, and keeps playing when the window is closed
// - imports new songs from your music folders in the background (no browser tab needed)
// - menu bar mini player; the keyboard's play/pause/next keys work through macOS Now Playing
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, session, protocol } = require('electron');
const narrator = require('./narrator');
const { Readable } = require('stream');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const SITE = 'https://medfofana9-web.github.io/cadence/';
const HOME = os.homedir();
const AUDIO = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|alac|aif|aiff)$/i;
const CFG = () => path.join(app.getPath('userData'), 'settings.json');

let win = null, tray = null, quitting = false, state = { title: '', artist: '', playing: false };
let cfg = { folders: null, openAtLogin: true, showTitle: true };

if (!app.requestSingleInstanceLock()) { app.quit(); }
// songs already on this Mac play straight from your folders, with no internet needed
protocol.registerSchemesAsPrivileged([{ scheme: 'fofile', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }]);
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff', alac: 'audio/mp4' };
async function serveFile(req) {
  const p = decodeURIComponent(new URL(req.url).pathname);
  const okDir = folders().some(d => path.resolve(p).startsWith(path.resolve(d) + path.sep));
  if (!okDir || !AUDIO.test(p)) return new Response('no', { status: 403 });
  let st; try { st = await fsp.stat(p); } catch { return new Response('gone', { status: 404 }); }
  const type = MIME[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (m) {
    const start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
    const end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (start >= st.size) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${st.size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })), { status: 206, headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(p)), { status: 200, headers: { ...base, 'Content-Length': String(st.size) } });
}
app.on('second-instance', () => show());

function loadCfg() { try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG(), 'utf8')) }; } catch {} }
function saveCfg() { try { fs.mkdirSync(path.dirname(CFG()), { recursive: true }); fs.writeFileSync(CFG(), JSON.stringify(cfg, null, 2)); } catch {} }

/** Folders new songs land in. The Fof Music Helper moves downloads into one of these. */
function defaultFolders() {
  const c = [
    path.join(HOME, 'Music', 'Fof Music'),
    path.join(HOME, 'Music', 'Fof Music Inbox'),
    path.join(HOME, 'Downloads', 'Fof Music'),
    path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Fof Music Inbox'),
  ];
  // whatever folder the helper script moves songs into
  try {
    const sh = fs.readFileSync(path.join(HOME, 'Music', 'Fof Music Helper', 'move-songs.sh'), 'utf8');
    for (const m of sh.matchAll(/^\s*(?:export\s+)?(?:DEST|TARGET|OUT|LIBRARY|DST|INBOX)[A-Z_]*=["']?([^"'\n]+)["']?/gm)) c.unshift(m[1].replace(/^\$HOME|^~/, HOME));
  } catch {}
  return [...new Set(c)].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}
const folders = () => { const f = cfg.folders && cfg.folders.length ? cfg.folders : defaultFolders(); return f.some(d => narrator.OUT.startsWith(path.resolve(d) + path.sep)) || !fs.existsSync(narrator.OUT) ? f : [...f, narrator.OUT]; };

async function walk(dir, depth, out) {
  let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3 && e.name !== 'Removed from Fof Music') await walk(p, depth + 1, out); continue; }
    if (!AUDIO.test(e.name)) continue;
    try { const st = await fsp.stat(p); if (st.size > 1024 && Date.now() - st.mtimeMs > 4000) out.push({ path: p, name: e.name, size: st.size, mtime: Math.round(st.mtimeMs) }); } catch {}
  }
}
let scanT = null, ready = false, lastList = '';
async function scan(force = false) {
  if (!win || !ready) return;
  const out = []; for (const d of folders()) await walk(d, 0, out);
  const sig = out.map(f => f.path + f.size + f.mtime).join('|');
  if (!force && sig === lastList) return;
  lastList = sig;
  win.webContents.send('files', out);
}
const soon = () => { clearTimeout(scanT); scanT = setTimeout(() => scan(), 5000); };
const watchers = [];
function watchAll() {
  while (watchers.length) try { watchers.pop().close(); } catch {}
  for (const d of folders()) try { watchers.push(fs.watch(d, { recursive: true }, soon)); } catch {}
}

function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, show: !hidden,
    title: 'Fof Music', titleBarStyle: 'hiddenInset', backgroundColor: '#0a0a0b',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setUserAgent(win.webContents.getUserAgent() + ' FofMusicDesktop/1');
  win.loadURL(SITE);
  win.webContents.on('did-finish-load', () => { ready = true; setTimeout(() => scan(true), 8000); });
  if (process.env.FOF_SMOKE) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const r = await win.webContents.executeJavaScript(`(async () => JSON.stringify({ bridge: !!window.fofDesktop, view: document.querySelector('#view')?.children.length || 0, title: document.title, desktop: document.documentElement.classList.contains('desktop-app'), folders: await window.fofDesktop.folders(), file: await (async () => { const f = (await window.fofDesktop.folders())[0]; if (!f) return 'no folder'; const u = 'fofile://local' + (f + '/test tone.wav').split('/').map(encodeURIComponent).join('/'); const r = await fetch(u, { headers: { Range: 'bytes=0-99' } }); const a = new Audio(u); const ok = await new Promise(res => { a.onloadedmetadata = () => res('audio ' + a.duration.toFixed(1) + 's'); a.onerror = () => res('audio error'); setTimeout(() => res('audio timeout'), 8000); }); return r.status + ' ' + (await r.arrayBuffer()).byteLength + ' ' + ok; })() }))()`).catch(e => String(e));
    const img = await win.webContents.capturePage();
    fs.writeFileSync('/tmp/fof-smoke.png', img.toPNG()); fs.writeFileSync('/tmp/fof-smoke.txt', r + '\ntray:' + !!tray);
    quitting = true; app.quit();
  }, 15000));
  win.webContents.on('did-fail-load', (_e, code) => { if (code !== -3) setTimeout(() => win && win.loadURL(SITE), 15000); });
  // links to other sites open in your browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(SITE)) { e.preventDefault(); shell.openExternal(url); } });
  // closing the window keeps the music playing; quit from the menu bar
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); if (app.dock) app.dock.hide(); } });
}
function show() { if (!win) return; if (app.dock) app.dock.show(); win.show(); win.focus(); }

const trayImg = () => { const i = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png')); i.setTemplateImage(true); return i; };
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function control(a) { if (win) win.webContents.send('control', a); }
function buildMenu() {
  const fl = folders();
  const menu = Menu.buildFromTemplate([
    { label: state.title ? short(state.title, 40) : 'Nothing playing', enabled: false },
    ...(state.artist ? [{ label: short(state.artist, 40), enabled: false }] : []),
    { type: 'separator' },
    { label: state.playing ? 'Pause' : 'Play', click: () => control('toggle') },
    { label: 'Next', click: () => control('next') },
    { label: 'Previous', click: () => control('prev') },
    { label: 'Fof Flow', click: () => control('flow') },
    { type: 'separator' },
    ...(narrator.status().busy ? [{ label: `Narrating ${short(narrator.status().book, 30)}`, enabled: false }, { label: narrator.status().line, enabled: false }, { type: 'separator' }] : []),
    { label: 'Open Fof Music', click: show },
    { label: 'Check for new songs', click: () => scan(true) },
    { label: 'Audiobooks', submenu: [
      { label: 'Add a book…', click: () => narrator.addBook(win) },
      { label: 'Open the Books folder', click: () => shell.openPath(narrator.BOOKS) },
      { label: 'Open the narrator log', click: () => shell.openPath(path.join(app.getPath('userData'), 'narrator', 'narrator.log')) },
    ] },
    { label: 'Folders it watches', submenu: [
      ...(fl.length ? fl.map(d => ({ label: d.replace(HOME, '~'), click: () => shell.openPath(d) })) : [{ label: 'None yet', enabled: false }]),
      { type: 'separator' },
      { label: 'Add a folder…', click: addFolder },
      ...(cfg.folders ? [{ label: 'Go back to the usual folders', click: () => { cfg.folders = null; saveCfg(); watchAll(); buildMenu(); scan(true); } }] : []),
    ] },
    { label: 'Show song in menu bar', type: 'checkbox', checked: cfg.showTitle, click: m => { cfg.showTitle = m.checked; saveCfg(); paintTray(); } },
    { label: 'Open at login', type: 'checkbox', checked: cfg.openAtLogin, click: m => { cfg.openAtLogin = m.checked; saveCfg(); login(); } },
    { type: 'separator' },
    { label: 'Quit Fof Music', accelerator: 'Command+Q', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}
function paintTray() { if (!tray) return; tray.setTitle(cfg.showTitle && state.title ? ' ' + short(state.title, 22) : ''); tray.setToolTip(state.title ? `${state.title} · ${state.artist}` : 'Fof Music'); buildMenu(); }
async function addFolder() {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'], message: 'Pick a folder where your songs are saved' });
  if (r.canceled || !r.filePaths[0]) return null;
  cfg.folders = [...new Set([...folders(), r.filePaths[0]])]; saveCfg(); watchAll(); buildMenu(); scan(true);
  return r.filePaths[0];
}
function login() { try { app.setLoginItemSettings({ openAtLogin: !!cfg.openAtLogin, openAsHidden: true, args: ['--hidden'] }); } catch {} }

ipcMain.handle('read', async (_e, p) => {
  // only files inside the folders being watched
  const ok = folders().some(d => path.resolve(p).startsWith(path.resolve(d) + path.sep));
  if (!ok) throw new Error('not in a watched folder');
  return fsp.readFile(p);
});
ipcMain.handle('exists', (_e, p) => folders().some(d => path.resolve(p).startsWith(path.resolve(d) + path.sep)) && fs.existsSync(p));
ipcMain.handle('folders', () => folders());
ipcMain.handle('add-book', () => narrator.addBook(win));
ipcMain.handle('narrator', () => narrator.status());
ipcMain.handle('add-folder', () => addFolder());
ipcMain.on('scan-now', () => scan(true));
ipcMain.on('state', (_e, s) => { state = { ...state, ...s }; paintTray(); });

app.whenReady().then(() => {
  loadCfg();
  protocol.handle('fofile', serveFile);
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(perm)));
  tray = new Tray(trayImg());
  tray.on('double-click', show);
  paintTray();
  createWindow(hidden);
  if (hidden && app.dock) app.dock.hide();
  login();
  watchAll();
  narrator.start((st, ev) => { buildMenu(); if (win) win.webContents.send('narrator', st); if (ev === 'chapter') { watchAll(); setTimeout(() => scan(true), 3000); } });
  setInterval(() => scan(), 60 * 1000);
  setInterval(() => { if (!fs.existsSync(folders()[0] || '/nonexistent')) return; if (!watchers.length) watchAll(); }, 5 * 60 * 1000);
});
app.on('activate', show);
app.on('before-quit', () => { quitting = true; narrator.stop(); });
app.on('window-all-closed', e => e.preventDefault());
