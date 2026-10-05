/* Lumina Calendar — service worker (offline-first app shell).
 * Bump VERSION whenever you publish a new build so users receive the update. */
const VERSION = 'lumina-v1.1.0';
const CORE = [
  './',
  './index.html',
  './css/app.css',
  './js/icons.js',
  './js/i18n.js',
  './js/core.js',
  './js/nlp.js',
  './js/store.js',
  './js/app.js',
  './manifest.webmanifest',
  './privacy.html'
];
const EXTRA = [
  './icons/favicon.ico',
  './icons/icon.svg',
  './icons/icon-96.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      return cache.addAll(CORE).then(function () {
        return Promise.all(EXTRA.map(function (url) { return cache.add(url).catch(function () { /* optional */ }); }));
      });
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the app shell from the cache, fall back to the network.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(function (cached) {
        const network = fetch(req).then(function (res) {
          if (res && res.ok) caches.open(VERSION).then(function (c) { c.put('./index.html', res.clone()); });
          return res;
        }).catch(function () { return cached; });
        return cached || network;
      })
    );
    return;
  }

  // Everything else: cache first, then refresh the cache in the background (stale-while-revalidate).
  event.respondWith(
    caches.match(req).then(function (cached) {
      const network = fetch(req).then(function (res) {
        if (res && res.ok) caches.open(VERSION).then(function (c) { c.put(req, res.clone()); });
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
