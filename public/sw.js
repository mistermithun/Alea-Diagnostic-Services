const CACHE_NAME = 'alea-lims-network-first-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
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

  // Never intercept non-GET requests (POST/PUT/DELETE mutations)
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Skip cross-origin requests and non-HTTP(S) schemes
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Never cache or intercept API calls or SSE streams — live reports, auth & billing must always be real-time
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
      try {
        // Strict Network-First: revalidate HTML navigations, manifest, and brand icons so updates appear immediately
        const networkRequest =
          isNavigation || isManifestOrIcon ? new Request(request, { cache: 'no-cache' }) : request;
        const networkResponse = await fetch(networkRequest);

        if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, networkResponse.clone()).catch(() => {});
        }

        return networkResponse;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;

        if (isNavigation) {
          const fallbackShell = await caches.match('/');
          if (fallbackShell) return fallbackShell;
        }

        return new Response('Offline — unable to reach Alea Diagnostic Services server.', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});
