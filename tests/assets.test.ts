import { test } from 'node:test';
import { expect } from '@std/expect';
import { Store } from '../src/store.ts';
import { createHandler } from '../src/server.ts';
import { sourceRelease } from '../src/client-release.ts';
import { fileExists, readText, scanExports, scanImports } from './test-utils.ts';
const ASSET_VERSION = sourceRelease().version;

test('public shells use versioned assets and every service-worker shell resource exists', async () => {
  const store = new Store();
  try {
    const handle = createHandler(store), get = (path: string) => handle(new Request('http://localhost' + path));
    const shell = await get('/'), html = await shell!.text();
    expect(html).toContain('vault-locked');
    expect(html).not.toContain('__TASKPATH_RELEASE__');
    expect((await get('/assets/accounts-v18/app.js'))!.status).not.toBe(200);
    expect((await get('/assets/__TASKPATH_RELEASE__/app.js'))!.status).not.toBe(200);
    expect(shell!.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const urls = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map(m => m[1]).filter(u => u !== '/login');
    for (const url of urls) { expect(url.startsWith(`/assets/${ASSET_VERSION}/`)).toBe(true); expect((await get(url))!.status).toBe(200); }
    for (const file of ['api.js', 'api-client.js', 'crypto.js', 'persistence.js', 'markdown.js', 'vendor/marked.js', 'offline-model.js', 'offline.js', 'tags.js', 'realtime.js']) expect((await get(`/assets/${ASSET_VERSION}/${file}`))!.status).toBe(200);
    // Missing themed icons must not break the worker's all-or-nothing offline install.
    for (const theme of ['light', 'dark', 'gruvbox-light', 'gruvbox-dark', 'nord', 'catppuccin', 'rose-pine', 'midnight', 'plum', 'ocean', 'sand', 'lavender', 'ice']) {
      const base = `/assets/${ASSET_VERSION}/themes/${theme}/`;
      const manifest = await (await get(base + 'manifest.webmanifest'))!.json();
      expect(manifest.id).toBe('/'); // Theme changes retain the same installed-app identity.
      expect(manifest.start_url).toBe('/');
      for (const icon of manifest.icons) {
        expect(icon.src.startsWith(base)).toBe(true);
        const response = (await get(icon.src))!;
        expect(response.headers.get('Content-Type')).toBe('image/png');
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(new TextDecoder().decode(bytes.subarray(1, 4))).toBe('PNG');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(view.getUint32(16)).toBe(Number(icon.sizes.split('x')[0]));
        expect(view.getUint32(20)).toBe(Number(icon.sizes.split('x')[1]));
      }
      expect((await (await get(base + 'apple-touch-icon.png'))!.arrayBuffer()).byteLength).toBeGreaterThan(100);
      expect(await (await get(base + 'favicon.svg'))!.text()).toContain('<svg');
    }
    for (const path of ['/app.js', '/app.ts', '/assets/' + ASSET_VERSION + '/app.ts', '/assets/' + ASSET_VERSION + '/types.d.ts', '/src/server.ts']) expect((await get(path))!.status).not.toBe(200);
    const script = await (await get(`/assets/${ASSET_VERSION}/app.js`))!.text();
    expect(() => scanExports(script)).not.toThrow();
    expect(script).not.toContain('import type');
    const worker = await (await get('/sw.js'))!.text();
    expect(scanImports(worker)).toEqual([]);
    expect(worker).toContain('taskpath-shell-' + ASSET_VERSION);
    expect(worker).not.toContain('skipWaiting');
    expect(worker).toMatch(/name\.startsWith\(['"]taskpath-shell-accounts-['"]\)/);
    expect(fileExists('public/vendor/marked.LICENSE.md')).toBe(true);
    expect(readText('.dockerignore')).toContain('!public/vendor/marked.LICENSE.md');
  } finally { store.close(); }
});
