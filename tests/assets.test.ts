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
    // Missing themed icons must not break the worker's all-or-nothing offline install.
    for (const theme of ['light', 'dark', 'gruvbox-light', 'gruvbox-dark', 'nord', 'catppuccin', 'rose-pine']) {
      const base = `/assets/${ASSET_VERSION}/themes/${theme}/`;
      const manifest = await (await get(base + 'manifest.webmanifest'))!.json();
      expect(manifest.id).toBe('/'); // Theme changes retain the same installed-app identity.
      expect(manifest.start_url).toBe('/');
      for (const icon of manifest.icons) {
        expect(icon.src).toStartWith(base);
        const response = (await get(icon.src))!;
        expect(response.headers.get('Content-Type')).toBe('image/png');
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.subarray(1, 4).toString()).toBe('PNG');
        expect(bytes.readUInt32BE(16)).toBe(Number(icon.sizes.split('x')[0]));
        expect(bytes.readUInt32BE(20)).toBe(Number(icon.sizes.split('x')[1]));
      }
      expect((await (await get(base + 'apple-touch-icon.png'))!.arrayBuffer()).byteLength).toBeGreaterThan(100);
      expect(await (await get(base + 'favicon.svg'))!.text()).toContain('<svg');
    }
    for (const path of ['/app.js', '/app.ts', '/assets/' + ASSET_VERSION + '/app.ts', '/assets/' + ASSET_VERSION + '/types.d.ts', '/src/server.ts']) expect((await get(path))!.status).not.toBe(200);
    const script = await (await get(`/assets/${ASSET_VERSION}/app.js`))!.text();
    expect(() => new Bun.Transpiler({ loader: 'js' }).scan(script)).not.toThrow();
    expect(script).not.toContain('import type');
    const worker = await (await get('/sw.js'))!.text();
    expect(worker).toContain(`/assets/${ASSET_VERSION}/offline.js`);
    expect(worker).toContain('taskpath-shell-' + ASSET_VERSION);
    expect(worker).not.toContain('skipWaiting');
    expect(worker).toMatch(/name\.startsWith\(['"]taskpath-shell-accounts-['"]\)/);
    expect(await Bun.file('public/vendor/marked.LICENSE.md').exists()).toBe(true);
    expect(await Bun.file('.dockerignore').text()).toContain('!public/vendor/marked.LICENSE.md');
  } finally { store.close(); }
});
