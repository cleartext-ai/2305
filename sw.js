const CACHE = 'cleartext-v2';
const OFFLINE_URL = 'offline.html';

// При встановленні — кешуємо офлайн-сторінку і головну
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll([
      '/',
      '/index.html',
      OFFLINE_URL
    ])).catch(() =>
      caches.open(CACHE).then(cache => cache.add(OFFLINE_URL))
    )
  );
  self.skipWaiting();
});

// Активація — очищаємо старий кеш
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Перехоплення запитів
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Пропускаємо API запити без перехоплення
  const url = e.request.url;
  if (url.includes('generativelanguage.googleapis.com')) return;
  if (url.includes('firestore.googleapis.com')) return;
  if (url.includes('firebase')) return;
  if (url.includes('fonts.googleapis.com')) return;
  if (url.includes('fonts.gstatic.com')) return;

  // Навігаційні запити (відкриття сторінки) — показуємо офлайн якщо немає мережі
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match(OFFLINE_URL)
      )
    );
    return;
  }

  // Інші ресурси — спочатку кеш, потім мережа
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).catch(() => caches.match(OFFLINE_URL));
    })
  );
});
