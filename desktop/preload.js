// The bridge between the Mac app and the Fof Music page. The page asks for nothing it doesn't need.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fofDesktop', {
  version: '1',
  /** the Mac app found songs in your folders: [{ path, name, size, mtime }] */
  onFiles: fn => ipcRenderer.on('files', (_e, list) => fn(list)),
  /** reads one song's bytes so the page can import it */
  read: path => ipcRenderer.invoke('read', path),
  exists: path => ipcRenderer.invoke('exists', path),
  /** what's playing, for the menu bar */
  state: s => ipcRenderer.send('state', s),
  /** menu bar buttons: toggle / next / prev */
  onControl: fn => ipcRenderer.on('control', (_e, a) => fn(a)),
  folders: () => ipcRenderer.invoke('folders'),
  addFolder: () => ipcRenderer.invoke('add-folder'),
  scanNow: () => ipcRenderer.send('scan-now'),
  /** pick an EPUB/PDF; the Mac narrates it into an audiobook */
  addBook: () => ipcRenderer.invoke('add-book'),
  /** a book sent from your phone: saved into the Books folder for narration */
  saveBook: (name, voice, bytes) => ipcRenderer.invoke('save-book', name, voice, bytes),
  narrator: () => ipcRenderer.invoke('narrator'),
  onNarrator: fn => ipcRenderer.on('narrator', (_e, s) => fn(s)),
});
