// CryptoFumble service worker — exists only so phones will offer
// "Add to Home Screen" / "Install app" (Phase 1 PWA quick win).
//
// Strategy is deliberately minimal and safe for a live-price calculator:
// network-first for everything, falling back to a cached copy ONLY when
// there's no network at all. It never caches (or answers from cache while
// online) anything under /.netlify/ — those are the live price/share/feed
// API calls, and serving a stale one instead of hitting the network would
// silently show wrong numbers. Bump CACHE_NAME when the shell files below
// change so old installs pick up the new versions instead of a stale cache.
const CACHE_NAME = 'cryptofumble-shell-v1';
const SHELL_URLS = ['/', '/ru/', '/favicon-32.png', '/favicon-180.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs for the static shell — everything else
  // (API calls, cross-origin fonts/analytics, non-GET requests) passes
  // straight through untouched.
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/.netlify/')) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// ---- Web Push (Фаза 48: new all-time-high alerts) ----
// Payload sent by netlify/functions/check-ath.js is always JSON:
// { title, body, url, tag }. icon/badge reuse the site's own PWA icons
// (already part of the install shell cached above).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'CryptoFumble';
  const options = {
    body: data.body || '',
    icon: '/favicon-180.png',
    badge: '/favicon-32.png',
    tag: data.tag || 'cryptofumble-ath',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const targetPath = new URL(targetUrl, self.location.origin).pathname;
      for (const client of windowClients) {
        if (client.url.includes(targetPath) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
