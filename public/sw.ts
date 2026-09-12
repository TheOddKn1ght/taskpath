declare const self: ServiceWorkerGlobalScope;
import { sync } from '/assets/accounts-v16/offline.js';
const CACHE = 'taskpath-shell-accounts-v16';
const ROOT = '/assets/accounts-v16/';
const FILES = ['pickers.js', 'picker-model.js', 'dom.js', 'errors.js', 'style.css', 'app.js', 'dates.js', 'navigation.js', 'theme.js', 'vault-ui.js', 'crypto.js', 'persistence.js', 'markdown.js', 'vendor/marked.js',
  'tags.js', 'realtime.js', 'offline.js', 'offline-model.js', 'export-markdown.js', 'pwa.js', 'push.js', 'manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'].map(file => ROOT + file);
for (const theme of ['light', 'dark', 'gruvbox-light', 'gruvbox-dark', 'nord', 'catppuccin', 'rose-pine']) {
  for (const file of ['favicon.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) FILES.push(`${ROOT}themes/${theme}/${file}`);
}
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const remaining = ['/offline-shell', ...FILES];
  // Bound the burst and retry temporary proxy throttling as the full icon set downloads.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (remaining.length) {
      const path = remaining.shift()!;
      let response;
      for (let attempt = 0; attempt < 6; attempt++) {
        response = await fetch(path, { cache: 'reload' });
        if (response.status !== 429 || attempt === 5) break;
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, Math.min(2 ** attempt, 8) * 1000));
      }
      if (!response?.ok || response.redirected) throw new Error('Incomplete encrypted shell');
      await cache.put(path, response);
    }
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
self.addEventListener('push', event => {
  // Never fetch task data or load vault keys, even on remembered devices.
  let token = '';
  try { const data: unknown = event.data?.json(); if (data && typeof data === 'object' && 'token' in data && typeof data.token === 'string' && /^[\w-]{32,100}$/.test(data.token)) token = data.token; } catch {}
  event.waitUntil(self.registration.showNotification('Taskpath reminder', {
    body: 'You have a reminder in Taskpath.', icon: ROOT + 'icon-192.png',
    tag: 'taskpath-reminder-' + token, renotify: false,
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin && ['/', '/login'].includes(new URL(client.url).pathname));
    if (existing) await existing.focus(); else await self.clients.openWindow('/');
  })());
});
