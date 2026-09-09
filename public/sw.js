import { sync } from '/assets/accounts-v3/offline.js';
const CACHE = 'taskpath-shell-accounts-v3';
const ROOT = '/assets/accounts-v3/';
const FILES = ['style.css', 'app.js', 'dates.js', 'theme.js', 'vault-ui.js', 'crypto.js', 'persistence.js', 'markdown.js', 'vendor/marked.js',
  'tags.js', 'realtime.js', 'offline.js', 'offline-model.js', 'export-markdown.js', 'pwa.js', 'manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'].map(file => ROOT + file);
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(['/offline-shell', ...FILES].map(async path => {
    const response = await fetch(path, { cache: 'reload' });
    if (!response.ok || response.redirected) throw new Error('Incomplete encrypted shell');
    await cache.put(path, response);
  }));
  // Waiting until every old window closes avoids mixing app generations.
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('taskpath-shell-accounts-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate' && ['/', '/login'].includes(url.pathname)) {
    event.respondWith((async () => {
      try { return await fetch(event.request, { signal: AbortSignal.timeout(4000) }); }
      catch { return await (await caches.open(CACHE)).match('/offline-shell') || Response.error(); }
    })());
  } else if (FILES.includes(url.pathname)) {
    event.respondWith((async () => await (await caches.open(CACHE)).match(url.pathname) || fetch(event.request))());
  }
});
self.addEventListener('sync', event => { if (event.tag === 'taskpath-accounts-sync') event.waitUntil(sync()); });
