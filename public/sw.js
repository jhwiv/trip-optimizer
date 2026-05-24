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
// CRITICAL: Cloudflare Pages serves `index.html` (text/html, 200) when a hashed
// asset is missing (e.g. a stale shell references an old chunk hash). If we
// blindly cached that, dynamic imports throw "Failed to fetch dynamically
// imported module" forever. So we *validate* the response content-type matches
// what the URL implies, never cache mismatches, and surface a real network
// error to the caller so the app can self-heal.
function expectedTypeFor(pathname) {
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) return 'javascript';
  if (pathname.endsWith('.css')) return 'css';
  if (pathname.endsWith('.json')) return 'json';
  if (pathname.endsWith('.svg')) return 'svg';
  return null; // images / fonts / other binary — don't validate
}
function contentTypeMatches(resp, expected) {
  if (!expected) return true;
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) return false; // never HTML for hashed assets
  if (expected === 'javascript') return ct.includes('javascript') || ct.includes('ecmascript');
  if (expected === 'css') return ct.includes('css');
  if (expected === 'json') return ct.includes('json');
  if (expected === 'svg') return ct.includes('svg');
  return true;
}
async function cacheFirst(request, cacheName) {
  const url = new URL(request.url);
  const expected = expectedTypeFor(url.pathname);
  const cached = await caches.match(request);
  if (cached && contentTypeMatches(cached, expected)) return cached;
  // If cache was poisoned with HTML (or any wrong type), evict it before refetch.
  if (cached && !contentTypeMatches(cached, expected)) {
    try {
      const cache = await caches.open(cacheName);
      await cache.delete(request);
    } catch (_) { /* ignore */ }
  }
  // Force a network fetch that bypasses any HTTP cache layer too.
  const resp = await fetch(request, { cache: 'no-store' });
  if (resp && resp.ok && contentTypeMatches(resp, expected)) {
    const cache = await caches.open(cacheName);
    cache.put(request, resp.clone()).catch(() => {});
    return resp;
  }
  // Wrong content-type means CF returned the SPA shell for a missing chunk.
  // Synthesize a real 404 so dynamic imports fail fast and the app's PDF
  // catch-handler can trigger a hard reload to pick up the fresh shell.
  if (resp && resp.ok && !contentTypeMatches(resp, expected)) {
    return new Response('', { status: 404, statusText: 'Asset hash not in current deploy' });
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
