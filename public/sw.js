// Syft Service Worker — enables "Add to Home Screen" on iOS/Android
// NOTE: We intentionally do NOT cache the main HTML (/app) so updates deploy instantly.
// Only static assets (icons, manifest) are cached.
const CACHE_NAME = 'syft-v2';
const STATIC = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // Nuke any old caches (including v1 which cached /app HTML)
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Always network-first for: HTML pages, API calls, auth
  if (url.includes('/api/') || url.includes('/auth/') ||
      url.endsWith('/app') || url.endsWith('/business')) return;

  // Cache-first for static assets only
  if (STATIC.some(u => url.endsWith(u))) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
