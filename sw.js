// Network first for the app itself (so updates land right away), cached copy when offline.
const CACHE = 'cadence-shell-2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'lib/store.js', 'lib/meta.js', 'lib/tags.js', 'lib/cloud.js', 'lib/engine.js', 'lib/search.js', 'lib/image.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.endsWith('version.json')) return;
  e.respondWith(fetch(e.request.mode === 'navigate' ? e.request.url : e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
