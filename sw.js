const CACHE = 'cleartext-v3';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Немає обробника 'fetch' навмисно — застосунок працює лише онлайн,
// кешування не потрібне, а порожній обробник лише додає накладні витрати
// на кожен запит (саме на це вказує попередження браузера).
