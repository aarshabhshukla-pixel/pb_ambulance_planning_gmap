// Ambulance Planner – service worker
// Caches the app itself so it opens instantly and works offline.
// Map tiles and place search always come from the network (they are not cached).
const VERSION = 'ambulance-planner-v7';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'leaflet.css',
  'leaflet.js',
  'exo2-latin.woff2',
  'exo2-latin-ext.woff2',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'route.html',
  'team.html',
  'route.js',
  'common.js',
  'db.js',
  'supabase.js',
  'xlsx.js',
  'qrcode.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tiles, search: network only
  if (url.pathname.startsWith('/api/')) return;      // server functions: never cache
  if (url.pathname.endsWith('/config.js')) {          // settings: always the latest, cached copy only when offline
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; }).catch(() => caches.match(req)));
    return;
  }

  // Pages: network first so new deployments show up, cache as offline fallback
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match(url.pathname.includes('team') ? 'team.html' : url.pathname.includes('route') ? 'route.html' : 'index.html')))
    );
    return;
  }

  // Static files: cache first, then network
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});
