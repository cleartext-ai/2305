const CACHE = 'cleartext-v1';
const OFFLINE_URL = 'offline.html';

// При встановленні — кешуємо офлайн-сторінку
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll([OFFLINE_URL]))
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
  // Тільки GET запити і не API запити
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('generativelanguage.googleapis.com')) return;
  if (e.request.url.includes('firestore.googleapis.com')) return;
  if (e.request.url.includes('firebase')) return;

  e.respondWith(
    fetch(e.request).catch(() =>
      caches.match(OFFLINE_URL)
    )
  );
});
