// Trip Optimizer service worker
// Strategy:
//   - /assets/* (Vite content-hashed, immutable) -> cache-first
//   - / and navigations -> network-first, fall back to cached shell when offline
//   - icons + manifest -> cache-first
// The cache name bumps on every deploy via SW_VERSION so old shells are purged.

const SW_VERSION = 'v__BUILD_ID__';
const SHELL_CACHE = `trip-optimizer-shell-${SW_VERSION}`;
const ASSET_CACHE = `trip-optimizer-assets-${SW_VERSION}`;

const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/favicon-64.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Use no-cache so install pulls a fresh shell rather than an HTTP-cached one.
      cache.addAll(SHELL_URLS.map((u) => new Request(u, { cache: 'no-cache' })))
    ).then(() => self.skipWaiting()).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Network-first for HTML navigations: keep the shell fresh, fall back to cache when offline.
async function networkFirst(request) {
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (err) {
    const cached = await caches.match(request) || await caches.match('/');
    if (cached) return cached;
    throw err;
  }
}

// Cache-first for hashed assets: serve instantly, hydrate cache in the background.
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp && resp.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, resp.clone()).catch(() => {});
  }
  return resp;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin
  if (url.origin !== self.location.origin) return;

  // Never intercept the SW file itself or API calls
  if (url.pathname === '/sw.js') return;

  // HTML navigations -> network-first
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Hashed assets -> cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  // Icons / manifest / favicons -> cache-first against shell cache
  if (
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.webmanifest') ||
    url.pathname.endsWith('.ico')
  ) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }
  // Everything else: pass through
});

// Allow the page to trigger an immediate update (used by the install hint after a deploy)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
