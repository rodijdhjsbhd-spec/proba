'use strict';

/*
 * Service worker Гигахрущёвки.
 *  - пуши ЖЭК: показывает уведомление, по нажатию открывает игру;
 *  - без связи: вместо «нет интернета» браузера — своя страничка (сама игра не кешируется,
 *    чтобы после обновления сервера не застрять на старой версии).
 */
const CACHE = 'gh-offline-v2';
const OFFLINE = ['/offline.html', '/icons/icon-192.png', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
    return;
  }
  // значки офлайн-страницы: сначала сеть, из кеша — только когда сети нет
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && OFFLINE.includes(url.pathname)) e.respondWith(fetch(e.request).catch(() => caches.match(url.pathname)));
});

self.addEventListener('push', (e) => {
  let msg = {};
  try {
    msg = e.data ? e.data.json() : {};
  } catch {
    msg = { body: e.data ? e.data.text() : '' };
  }
  // срочность решает сервер (за задраенной дверью туман — не тревога); старые сообщения — по теме
  const urgent = typeof msg.urgent === 'boolean' ? msg.urgent : ['fog', 'siren', 'death', 'danger'].includes(msg.tag);
  e.waitUntil(
    self.registration.showNotification(msg.title || 'ЖЭК', {
      body: msg.body || '',
      tag: msg.tag || 'zhek',
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: urgent ? [500, 200, 500, 200, 500] : [80, 90, 80],
      requireInteraction: urgent,
      data: { url: msg.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin);
  if (url.origin !== self.location.origin) url = new URL('/', self.location.origin);
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // только окно самой игры: не Пульт ЖЭК и не страница «нет связи»
      const open = list.find((c) => ['/', '/index.html'].includes(new URL(c.url).pathname));
      return open ? open.focus() : self.clients.openWindow(url.href);
    }),
  );
});
