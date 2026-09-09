import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { createHandler, ASSET_VERSION } from '../src/server';

test('public shells use versioned assets and every service-worker shell resource exists', async () => {
  const store = new Store();
  try {
    const handle = createHandler(store), get = (path: string) => handle(new Request('http://localhost' + path));
    const shell = await get('/'), html = await shell!.text();
    expect(html).toContain('vault-locked');
    expect(shell!.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const urls = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map(m => m[1]).filter(u => u !== '/login');
    for (const url of urls) { expect(url).toStartWith(`/assets/${ASSET_VERSION}/`); expect((await get(url))!.status).toBe(200); }
    for (const file of ['crypto.js', 'vault-ui.js', 'persistence.js', 'markdown.js', 'vendor/marked.js', 'offline-model.js', 'offline.js', 'tags.js', 'realtime.js']) expect((await get(`/assets/${ASSET_VERSION}/${file}`))!.status).toBe(200);
    expect((await get('/app.js'))!.status).not.toBe(200);
    const worker = await (await get('/sw.js'))!.text();
    expect(worker).toContain(`/assets/${ASSET_VERSION}/offline.js`);
    expect(worker).toContain('taskpath-shell-' + ASSET_VERSION);
    expect(worker).not.toContain('skipWaiting');
    expect(worker).toContain("name.startsWith('taskpath-shell-accounts-')");
    expect(await Bun.file('public/vendor/marked.LICENSE.md').exists()).toBe(true);
    expect(await Bun.file('.dockerignore').text()).toContain('!public/vendor/marked.LICENSE.md');
  } finally { store.close(); }
});
