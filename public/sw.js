const CACHE_NAME = 'alea-lims-offline-v3';

const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/admin',
  '/staff',
  '/live-display',
  '/admin-login',
  '/staff-login',
  '/manifest.json',
  '/manifest.json?v=2',
  '/favicon.ico?v=2',
  '/favicon-32x32.png?v=2',
  '/pwa-192x192.png?v=2',
  '/pwa-512x512.png?v=2',
  '/apple-touch-icon.png?v=2',
  '/assets/aistudio/IMG_20261119_111655_480ab481.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await Promise.allSettled(
          APP_SHELL_URLS.map(async (url) => {
            try {
              const res = await fetch(new Request(url, { cache: 'reload' }));
              if (res && res.ok) {
                await cache.put(url, res);
              }
            } catch {
              // ignore individual optional pre-cache failures
            }
          })
        );
      } finally {
        await self.skipWaiting();
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never intercept non-GET requests (mutations are handled by IndexedDB + Offline Sync Queue)
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Cache Google Fonts stylesheets & font files for clean offline typography
  if (
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com'
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((res) => {
            if (res && res.ok) {
              cache.put(request, res.clone()).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || (await networkPromise) || new Response('', { status: 504 });
      })()
    );
    return;
  }

  // Skip other cross-origin requests
  if (url.origin !== self.location.origin) return;

  // Never cache /api/ calls in Service Worker — IndexedDB handles offline structured API mirrors & sync queue
  if (url.pathname.startsWith('/api/')) return;

  // Skip Vite dev HMR / client module ping endpoints if present
  if (url.pathname.startsWith('/@vite') || url.pathname.startsWith('/__vite')) return;

  const isNavigation = request.mode === 'navigate' || request.destination === 'document';
  const isManifestOrIcon =
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/pwa-') ||
    url.pathname.startsWith('/apple-touch-icon') ||
    url.pathname.startsWith('/favicon') ||
    url.pathname.startsWith('/assets/aistudio/');

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const networkRequest =
          isNavigation || isManifestOrIcon ? new Request(request, { cache: 'no-cache' }) : request;
        const networkResponse = await fetch(networkRequest);

        if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
          cache.put(request, networkResponse.clone()).catch(() => {});
          if (isNavigation) {
            cache.put('/', networkResponse.clone()).catch(() => {});
          }
        }

        return networkResponse;
      } catch {
        const cached = await cache.match(request, { ignoreSearch: isNavigation });
        if (cached) return cached;

        if (isNavigation) {
          const fallbackShell =
            (await cache.match('/')) ||
            (await cache.match('/index.html')) ||
            (await cache.match('/admin')) ||
            (await cache.match('/staff'));
          if (fallbackShell) return fallbackShell;
        }

        return new Response('Offline — cached app shell unavailable.', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});
