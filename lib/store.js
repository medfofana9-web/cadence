// Local library storage (IndexedDB). Songs, audio files, artwork, lyrics and playlists live on this device.
const DB_NAME = 'cadence';
const STORES = ['tracks', 'audio', 'art', 'thumbs', 'lyrics', 'playlists', 'kv'];
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(r => { out = r; });
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, key) => tx(store, 'readonly', s => s.get(key)),
  put: (store, key, val) => tx(store, 'readwrite', s => { s.put(val, key); }),
  del: (store, key) => tx(store, 'readwrite', s => { s.delete(key); }),
  keys: (store) => tx(store, 'readonly', s => s.getAllKeys()),
  all: async (store) => {
    const db_ = await open();
    return new Promise((resolve, reject) => {
      const t = db_.transaction(store, 'readonly');
      const s = t.objectStore(store);
      const keys = s.getAllKeys(), vals = s.getAll();
      t.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
      t.onerror = () => reject(t.error);
    });
  },
  clear: (store) => tx(store, 'readwrite', s => { s.clear(); }),
};

export const kv = {
  async get(key, fallback) { const v = await db.get('kv', key); return v === undefined ? fallback : v; },
  set(key, val) { return db.put('kv', key, val); },
};

export async function storageInfo() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch { return null; }
}
export const isQuotaError = e => e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));

export async function persist() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
}
