const CACHE = 'cleartext-v3';

// При встановленні — кешуємо index.html
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.add('/index.html'))
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

// Навігаційні запити — спочатку кеш, потім мережа
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // API запити — не чіпаємо
  const url = e.request.url;
  if (url.includes('generativelanguage.googleapis.com')) return;
  if (url.includes('firestore.googleapis.com')) return;
  if (url.includes('firebase')) return;

  // Навігація (відкриття сторінки) — кеш якщо немає мережі
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Оновлюємо кеш при успішному завантаженні
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
  }
});
