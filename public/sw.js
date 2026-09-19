/*
 * The service worker.
 *
 * Its whole job is to make the app open when there is no network. It caches the shell —
 * the HTML, the JavaScript, the icon — and serves it from cache when a request fails.
 *
 * It deliberately does NOT cache API responses. Job data lives in IndexedDB, written by
 * the sync engine, which knows about cursors, conflicts and the outbox. A service worker
 * quietly replaying a stale API response would hand the app data the sync engine never
 * agreed to, and the two would disagree about what the technician is looking at.
 */
const SHELL = 'apex-field-shell-v2';
const SHELL_URLS = ['/field', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The sync engine owns the API. It handles failure better than a cache can.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first so a deployed change is picked up, cache as the fallback
  // so the app still opens in a basement.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;

          /*
           * A job page is only ever reached by client-side routing, so its document was
           * never fetched and so is never in the cache. Answering with the day shell would
           * put the day's list at a job's address — the technician reloads on site, and
           * gets a screen that is not the job they are standing in, with none of its
           * buttons, at a URL that says it is. Redirecting keeps the address and the
           * screen telling the same story, and one tap re-enters the job from IndexedDB.
           */
          if (url.pathname !== '/field' && url.pathname.startsWith('/field')) {
            return Response.redirect(new URL('/field', self.location.origin).href, 302);
          }
          return caches.match('/field');
        }),
    );
    return;
  }

  // Everything else: cache first, since built assets are content-hashed and immutable.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
