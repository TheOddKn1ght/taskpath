import { localState, sync } from './offline.js';
const CACHE = 'taskpath-shell-v1';
const FILES = ['/offline-shell', '/login', '/style.css', '/app.js', '/dates.js', '/theme.js', '/login.js',
  '/offline.js', '/offline-model.js', '/export-markdown.js', '/pwa.js', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // /login may redirect when already signed in; cache the public static login shell.
  await Promise.all(FILES.map(async path => {
    const response = await fetch(path === '/login' ? '/login-shell' : path, { cache: 'reload' });
    if (!response.ok || response.redirected) throw new Error('Incomplete offline shell');
    await cache.put(path, response);
  }));
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('taskpath-shell-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate' && ['/', '/login'].includes(url.pathname)) {
    event.respondWith((async () => {
      try { return await fetch(event.request, { signal: AbortSignal.timeout(4000) }); }
      catch {
        const record = await localState();
        const path = url.pathname === '/' && record.board && !record.locked ? '/offline-shell' : '/login';
        return await caches.match(path) || Response.error();
      }
    })());
  } else if (FILES.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then(cached => cached || fetch(event.request)));
  }
});
self.addEventListener('sync', event => {
  if (event.tag === 'taskpath-sync') event.waitUntil(sync());
});
