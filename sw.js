const CACHE = 'waseshibu-shell-v13';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Problem/answer assets are intentionally not persisted by the Service Worker.
  if (url.pathname.includes('/content/')) return;
  if (event.request.method !== 'GET') return;

  // Network-first prevents a stale index.html from pointing at deleted hashed assets.
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(event.request, response.clone());
      }
      return response;
    } catch (err) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw err;
    }
  })());
});
