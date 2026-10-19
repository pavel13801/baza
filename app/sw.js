// Офлайн-оболочка приложения. Данные базы кэширует само приложение (IndexedDB), здесь — только файлы сайта.
// Есть сеть — файлы всегда свежие с сервера; нет сети — из кэша. Так новая версия видна с первого открытия.
const VERSION = 'baza-1.1.2';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'md.js', 'demo.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', e => {
  // cache: 'reload' — мимо HTTP-кэша браузера (GitHub Pages разрешает держать файлы 10 минут)
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Свои файлы: сначала сеть (с проверкой свежести), при ошибке или долгом ответе — кэш.
// Чужие запросы (Apps Script, YouTube) не трогаем.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = () => cache.match(key, { ignoreSearch: true });
      const network = fetch(req, { cache: 'no-cache' }).then(res => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      });
      const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
        return (await cached()) || (await network); // сеть медленная — показываем кэш, если он есть
      } catch (err) {
        return (await cached()) || Response.error();
      }
    }),
  );
});
