import { test, expect } from 'bun:test';
import { resolve, dirname } from 'node:path';
import { compactHTML } from '../scripts/build';
import { createHandler, ASSET_VERSION } from '../src/server';
import { Store } from '../src/store';

const root = resolve(import.meta.dir, '..');
const sourceName = (name: string) => name.endsWith('.js') && !name.startsWith('vendor/') ? name.replace(/\.js$/, '.ts') : name;
const built = resolve(root, 'dist/public');
const hasBuild = await Bun.file(resolve(built, 'index.html')).exists() && (await Bun.file(resolve(built, 'index.html')).text()).includes(`/assets/${ASSET_VERSION}/`);

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
  }
  expect(scan.scan(await Bun.file(resolve(built, 'app.js')).text()).imports.some(i => i.path === './offline.js')).toBe(true);
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
    const html = await Bun.file(resolve(built, 'index.html')).text();
    for (const [, url] of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) {
      expect((await handler(new Request('http://localhost' + url)))!.status).toBe(200);
    }
    expect(await Bun.file(resolve(built, 'manifest.webmanifest')).json()).toEqual(await Bun.file(resolve(root, 'public/manifest.webmanifest')).json());
    expect(await Bun.file(resolve(built, 'vendor/marked.LICENSE.md')).text()).toBe(await Bun.file(resolve(root, 'public/vendor/marked.LICENSE.md')).text());
    for (const name of ['app.js', 'style.css', 'index.html', 'sw.js', 'manifest.webmanifest']) {
      expect(Bun.file(resolve(built, name)).size).toBeLessThan(Bun.file(resolve(root, 'public', sourceName(name))).size);
    }
  } finally { store.close(); }
});
