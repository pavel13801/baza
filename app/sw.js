// Офлайн-оболочка приложения. Данные базы кэширует само приложение (IndexedDB), здесь — только файлы сайта.
// При выпуске новой версии поменяйте VERSION, чтобы телефоны подтянули обновление.
const VERSION = 'baza-1.1.1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'md.js', 'demo.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Свои файлы: сразу из кэша, параллельно обновляем кэш из сети. Чужие запросы (Apps Script, YouTube) не трогаем.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req)
        .then(res => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
