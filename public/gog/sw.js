const CACHE = 'jush-public-shell-v5',
  offline = '/gog/offline.html';
const shellAssets = ['/gog/tab-shell.js', '/gog/mobile-app.css', '/gog/mobile-nav.js', '/gog/duel/common.js'];
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
  else if (shellAssets.includes(u.pathname) && !u.search) {
    // Reuse the installed shell immediately and pick up asset edits for the next visit.
    const cache = caches.open(CACHE);
    const updated = fetch(e.request).then(async (response) => {
      if (response.ok) await (await cache).put(e.request, response.clone());
      return response;
    });
    e.waitUntil(updated.catch(() => {}));
    e.respondWith(cache.then((c) => c.match(e.request)).then((hit) => hit || updated));
  }
});
