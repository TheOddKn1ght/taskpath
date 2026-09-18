import { test, expect } from 'bun:test';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { compactHTML } from '../scripts/build';
import { createHandler } from '../src/server';
import { Store } from '../src/store';
import { sourceRelease, stampRelease, releaseForDirectory, BUILD_MANIFEST } from '../src/client-release';

const root = resolve(import.meta.dir, '..');
const sourceName = (name: string) => name.endsWith('.js') && !name.startsWith('vendor/') ? name.replace(/\.js$/, '.ts') : name;
const built = resolve(root, 'dist/public');
const hasBuild = await Bun.file(resolve(built, BUILD_MANIFEST)).exists();
const release = hasBuild ? releaseForDirectory(built) : sourceRelease('built');
const ASSET_VERSION = release.version;

test('HTML compaction preserves inline spacing, entities, attributes and literal text', async () => {
  const source = '<!doctype html>\n<p title="a  b">Hello \n <strong>world</strong> &amp; friends&nbsp;!</p><!-- discard -->\n<pre>  a\n b &lt;c&gt;</pre><textarea> a\n  b</textarea><script>let x = "a  b";</script><style>p::after{content:"a  b"}</style>';
  const result = await compactHTML(source);
  expect(result).toContain('<p title="a  b">Hello <strong>world</strong> &amp; friends&nbsp;!</p>');
  expect(result).toContain('<pre>  a\n b &lt;c&gt;</pre><textarea> a\n  b</textarea>');
  expect(result).toContain('<script>let x = "a  b";</script><style>p::after{content:"a  b"}</style>');
  expect(result).not.toContain('discard');
});

test.skipIf(!hasBuild)('minified client preserves module exports, reachable imports, PWA assets and CSP', async () => {
  const scan = new Bun.Transpiler({ loader: 'js' });
  const files = [...new Bun.Glob('**/*').scanSync({ cwd: built, onlyFiles: true })];
  expect(files.some(name => name.endsWith('.map') || name.endsWith('.ts'))).toBe(false);
  for (const name of files.filter(name => name.endsWith('.js'))) {
    const output = await Bun.file(resolve(built, name)).text();
    const source = await Bun.file(resolve(root, 'public', sourceName(name))).text();
    expect(scan.scan(output).exports.sort()).toEqual(new Bun.Transpiler({loader: name.startsWith('vendor/') ? 'js' : 'ts'}).scan(source).exports.sort());
    for (const { path } of scan.scan(output).imports) {
      const target = path.startsWith(`/assets/${ASSET_VERSION}/`)
        ? resolve(built, path.slice(`/assets/${ASSET_VERSION}/`.length))
        : resolve(built, dirname(name), path);
      expect(await Bun.file(target).exists()).toBe(true);
    }
    expect(output).not.toContain('sourceMappingURL');
    expect(output).not.toContain('__TASKPATH_RELEASE__');
  }
  // These are separate runtimes: one shared state inside the page bundle and
  // ciphertext-only state inside the worker. Neither fetches child modules.
  for (const name of ['app.js', 'sw.js']) expect(scan.scan(await Bun.file(resolve(built, name)).text()).imports).toEqual([]);
  expect(scan.scan(await Bun.file(resolve(built, 'vault-ui.js')).text()).imports.some(i => i.path === './offline.js')).toBe(true);
  expect(scan.scan(await Bun.file(resolve(built, 'theme.js')).text()).exports).toEqual([]);
  const store = new Store();
  try {
    const handler = createHandler(store, undefined, undefined, undefined, built);
    for (const name of files.filter(name => /\.(js|css|html|webmanifest|png|svg)$/.test(name))) {
      const path = name === 'index.html' ? '/' : name === 'sw.js' ? '/sw.js' : `/assets/${ASSET_VERSION}/${name}`;
      const response = (await handler(new Request('http://localhost' + path)))!;
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(await Bun.file(resolve(built, name)).arrayBuffer()));
    }
    expect((await handler(new Request(`http://localhost/assets/${ASSET_VERSION}/.taskpath-build.json`)))!.status).not.toBe(200);
    const html = await Bun.file(resolve(built, 'index.html')).text();
    for (const [, url] of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) {
      expect((await handler(new Request('http://localhost' + url)))!.status).toBe(200);
    }
    expect(await Bun.file(resolve(built, 'manifest.webmanifest')).json()).toEqual(JSON.parse(stampRelease(await Bun.file(resolve(root, 'public/manifest.webmanifest')).text(), release)));
    expect(await Bun.file(resolve(built, 'vendor/marked.LICENSE.md')).text()).toBe(await Bun.file(resolve(root, 'public/vendor/marked.LICENSE.md')).text());
    for (const name of ['style.css', 'index.html', 'manifest.webmanifest']) {
      expect(Bun.file(resolve(built, name)).size).toBeLessThan(Bun.file(resolve(root, 'public', sourceName(name))).size);
    }
  } finally { store.close(); }
});

test.skipIf(!hasBuild)('bundled worker precaches and serves the offline shell without standalone JavaScript modules', async () => {
  type WorkerEvent = { waitUntil(promise: Promise<void>): void; request?: Pick<Request, 'url' | 'method' | 'mode'>; respondWith?(promise: Promise<Response>): void };
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const fetched: string[] = [], cached: string[] = [];
  const responses = new Map<string, Response>();
  let offline = false;
  const store = new Store();
  try {
    const handler = createHandler(store, undefined, undefined, undefined, built);
    runInNewContext(await Bun.file(resolve(built, 'sw.js')).text(), {
      TextEncoder, TextDecoder, URL, Response, AbortSignal, setTimeout,
      self: { location: { origin: 'http://localhost' }, addEventListener: (name: string, callback: (event: WorkerEvent) => void) => handlers.set(name, callback) },
      caches: { open: async () => ({ put: async (path: string, response: Response) => { cached.push(path); responses.set(path, response); }, match: async (path: string) => responses.get(path)?.clone() }) },
      fetch: async (path: string) => { if (offline) throw new TypeError('Offline'); fetched.push(path); return handler(new Request('http://localhost' + path)); },
    });
    let installation: Promise<void> | undefined;
    handlers.get('install')!({ waitUntil(promise) { installation = promise; } });
    await installation;
    const prefix = `/assets/${ASSET_VERSION}/`;
    expect(fetched.filter(path => path.endsWith('.js')).sort()).toEqual(['app.js', 'privacy.js', 'pwa.js', 'theme.js'].map(name => prefix + name));
    expect(cached.sort()).toEqual(fetched.sort());
    expect(cached).toContain('/offline-shell');
    expect(cached).toContain(prefix + 'style.css');
    expect(cached).toContain(prefix + 'themes/nord/manifest.webmanifest');
    const shell = await Bun.file(resolve(built, 'index.html')).text();
    for (const [, url] of shell.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)) expect(cached).toContain(url);
    offline = true;
    for (const path of ['/', '/login', prefix + 'app.js', prefix + 'theme.js']) {
      let response: Promise<Response> | undefined;
      handlers.get('fetch')!({ request: { url: 'http://localhost' + path, method: 'GET', mode: path.endsWith('.js') ? 'cors' : 'navigate' }, waitUntil() {}, respondWith(promise) { response = promise; } });
      expect(response).toBeDefined();
      expect(await (await response!).text()).toBe(path.endsWith('.js') ? await Bun.file(resolve(built, path.slice(prefix.length))).text() : shell);
    }
  } finally { store.close(); }
});
