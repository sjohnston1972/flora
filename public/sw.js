// Flora service worker
// Strategy:
//   - /api/*               : never intercept — always live network
//   - navigations (HTML)   : network-first so deploys land immediately;
//                            fall back to cached shell when offline
//   - icons / manifest /
//     /api/photos/*        : cache-first (large, immutable-ish)
//   - everything else (CDN
//     scripts, leaflet css): cache-first with background refresh
//
// Bump CACHE_VERSION to force clients to drop old cached shells.
const CACHE_VERSION = 'flora-v3';
const CORE = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Identify, journal POST/GET/DELETE, etc — must hit the network.
  if (url.pathname.startsWith('/api/identify') || url.pathname.startsWith('/api/journal') || url.pathname === '/api/health') {
    return;
  }

  // Photos in R2 — cache-first, they don't change once written.
  if (url.pathname.startsWith('/api/photos/')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // App shell navigations — network-first so new deploys land instantly.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || new Response('Offline', { status: 503 })))
    );
    return;
  }

  // Everything else (icons, manifest, CDN scripts) — cache-first.
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
      const copy = res.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
    }
    return res;
  } catch (e) {
    return cached || new Response('Offline', { status: 503 });
  }
}
