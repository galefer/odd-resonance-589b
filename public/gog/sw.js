const CACHE = 'jush-public-shell-v4',
  offline = '/gog/offline.html';
const shellAssets = ['/gog/mobile-app.css', '/gog/mobile-nav.js', '/gog/duel/common.js'];
self.addEventListener('install', (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([offline, ...shellAssets]))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('jush-public-shell-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET' || u.pathname.startsWith('/gog/api/')) return;
  if (e.request.mode === 'navigate') e.respondWith(fetch(e.request).catch(() => caches.match(offline)));
  else if (shellAssets.includes(u.pathname))
    e.respondWith(fetch(e.request).catch(() => caches.match(u.pathname)));
});
