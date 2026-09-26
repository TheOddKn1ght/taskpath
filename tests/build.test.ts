import { test } from 'node:test';
import { expect } from '@std/expect';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { compactHTML } from '../scripts/build.ts';
import { clientStyles } from '../src/client-styles.ts';
import { createHandler } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { sourceRelease, stampRelease, releaseForDirectory, BUILD_MANIFEST } from '../src/client-release.ts';
import { readText, readBytes, fileExists, fileSize, walkFiles, scanExports, scanImports, bytesEqual } from './test-utils.ts';

const here = new URL('.', import.meta.url).pathname;
const root = resolve(here, '..');
const sourceName = (name: string) => name === 'app.js' ? 'app.tsx' : name.endsWith('.js') && !name.startsWith('vendor/') ? name.replace(/\.js$/, '.ts') : name;
const built = resolve(root, 'dist/public');
const hasBuild = fileExists(resolve(built, BUILD_MANIFEST));
const release = hasBuild ? releaseForDirectory(built) : sourceRelease('built');
const ASSET_VERSION = release.version;

test('HTML compaction preserves inline spacing, entities, attributes and literal text', async () => {
  const source = '<!doctype html>\n<p title="a  b">Hello \n <strong>world</strong> &amp; friends&nbsp;!</p><!-- discard -->\n<pre>  a\n b &lt;c&gt;</pre><textarea> a\n  b</textarea><script>let x = "a  b";</script><style>p::after{content:"a  b"}</style>';
  const result = compactHTML(source);
  expect(result).toContain('<p title="a  b">Hello <strong>world</strong> &amp; friends&nbsp;!</p>');
  expect(result).toContain('<pre>  a\n b &lt;c&gt;</pre><textarea> a\n  b</textarea>');
  expect(result).toContain('<script>let x = "a  b";</script><style>p::after{content:"a  b"}</style>');
  expect(result).not.toContain('discard');
});

test('minified client preserves module exports, reachable imports, PWA assets and CSP', { skip: !hasBuild }, async () => {
  const files = [...walkFiles(built)];
  expect(files.some(name => name.endsWith('.map') || name.endsWith('.ts'))).toBe(false);
  for (const name of files.filter(name => name.endsWith('.js'))) {
    const output = readText(resolve(built, name));
    const source = readText(resolve(root, 'public', sourceName(name)));
    expect(scanExports(output).sort()).toEqual(scanExports(source).sort());
    for (const { path } of scanImports(output)) {
      const target = path.startsWith(`/assets/${ASSET_VERSION}/`)
        ? resolve(built, path.slice(`/assets/${ASSET_VERSION}/`.length))
        : resolve(built, dirname(name), path);
      expect(fileExists(target)).toBe(true);
    }
    expect(output).not.toContain('sourceMappingURL');
    expect(output).not.toContain('__TASKPATH_RELEASE__');
  }
  // These are separate runtimes: one shared state inside the page bundle and
  // ciphertext-only state inside the worker. Neither fetches child modules.
  for (const name of ['app.js', 'sw.js']) expect(scanImports(readText(resolve(built, name)))).toEqual([]);
  expect(readText(resolve(built, 'sw.js'))).not.toContain('react.production');
  expect(scanExports(readText(resolve(built, 'theme.js')))).toEqual([]);
  const store = new Store();
  try {
    const handler = createHandler(store, undefined, undefined, undefined, built);
    for (const name of files.filter(name => /\.(js|css|html|webmanifest|png|svg)$/.test(name))) {
      const path = name === 'index.html' ? '/' : name === 'sw.js' ? '/sw.js' : `/assets/${ASSET_VERSION}/${name}`;
      const response = (await handler(new Request('http://localhost' + path)))!;
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
      expect(bytesEqual(new Uint8Array(await response.arrayBuffer()), readBytes(resolve(built, name)))).toBe(true);
    }
    expect((await handler(new Request(`http://localhost/assets/${ASSET_VERSION}/.taskpath-build.json`)))!.status).not.toBe(200);
    const html = readText(resolve(built, 'index.html'));
    for (const [, url] of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) {
      expect((await handler(new Request('http://localhost' + url)))!.status).toBe(200);
    }
    expect(JSON.parse(readText(resolve(built, 'manifest.webmanifest')))).toEqual(JSON.parse(stampRelease(readText(resolve(root, 'public/manifest.webmanifest')), release)));
    expect(readText(resolve(built, 'vendor/marked.LICENSE.md'))).toBe(readText(resolve(root, 'public/vendor/marked.LICENSE.md')));
    for (const name of ['style.css', 'index.html', 'manifest.webmanifest']) {
      const source = name === 'style.css' ? await clientStyles(sourceRelease()) : readText(resolve(root, 'public', sourceName(name)));
      expect(fileSize(resolve(built, name))).toBeLessThan(new TextEncoder().encode(stampRelease(source,release)).length);
    }
    expect(files.filter(name => name.endsWith('.css'))).toEqual(['style.css']);
    expect(readText(resolve(built, 'style.css'))).not.toContain('@import');
  } finally { store.close(); }
});

test('bundled worker precaches and serves the offline shell without standalone JavaScript modules', { skip: !hasBuild }, async () => {
  type WorkerEvent = { waitUntil(promise: Promise<void>): void; request?: Pick<Request, 'url' | 'method' | 'mode'>; respondWith?(promise: Promise<Response>): void };
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const fetched: string[] = [], cached: string[] = [];
  const responses = new Map<string, Response>();
  let offline = false;
  const store = new Store();
  try {
    const handler = createHandler(store, undefined, undefined, undefined, built);
    runInNewContext(readText(resolve(built, 'sw.js')), {
      TextEncoder, TextDecoder, URL, Response, AbortSignal, setTimeout,
      self: { location: { origin: 'http://localhost' }, addEventListener: (name: string, callback: (event: WorkerEvent) => void) => handlers.set(name, callback) },
      caches: { open: async () => ({ put: async (path: string, response: Response) => { cached.push(path); responses.set(path, response); }, match: async (path: string) => responses.get(path)?.clone() }) },
      fetch: async (path: string) => { if (offline) throw new TypeError('Offline'); fetched.push(path); return handler(new Request('http://localhost' + path)); },
    });
    let installation: Promise<void> | undefined;
    handlers.get('install')!({ waitUntil(promise) { installation = promise; } });
    await installation;
    const prefix = `/assets/${ASSET_VERSION}/`;
    expect(fetched.filter(path => path.endsWith('.js')).sort()).toEqual(['app.js', 'theme.js'].map(name => prefix + name));
    expect(cached.sort()).toEqual(fetched.sort());
    expect(cached).toContain('/offline-shell');
    expect(cached).toContain(prefix + 'style.css');
    for (const theme of ['midnight', 'plum', 'ocean', 'sand', 'lavender', 'ice']) {
      for (const asset of ['manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) expect(cached).toContain(prefix + 'themes/' + theme + '/' + asset);
    }
    const shell = readText(resolve(built, 'index.html'));
    for (const [, url] of shell.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)) expect(cached).toContain(url);
    offline = true;
    for (const path of ['/', '/login', prefix + 'app.js', prefix + 'theme.js']) {
      let response: Promise<Response> | undefined;
      handlers.get('fetch')!({ request: { url: 'http://localhost' + path, method: 'GET', mode: path.endsWith('.js') ? 'cors' : 'navigate' }, waitUntil() {}, respondWith(promise) { response = promise; } });
      expect(response).toBeDefined();
      expect(await (await response!).text()).toBe(path.endsWith('.js') ? readText(resolve(built, path.slice(prefix.length))) : shell);
    }
  } finally { store.close(); }
});
