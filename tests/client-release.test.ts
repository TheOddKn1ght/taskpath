import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fingerprint, sourceRelease, builtRelease, stampRelease, digest, BUILD_MANIFEST } from '../src/client-release';
import { clientAsset } from '../src/client-assets';
const bytes = (value: string) => new TextEncoder().encode(value);

test('fingerprints are deterministic, order-independent and bind paths, bytes, mode and toolchain', () => {
  const inputs = [['a', bytes('bc')], ['d', bytes('ef')]] as const;
  const id = fingerprint(inputs, 'source', 'bun-fixture');
  expect(fingerprint([...inputs].reverse(), 'source', 'bun-fixture')).toBe(id);
  expect(fingerprint(inputs, 'built', 'bun-fixture')).not.toBe(id);
  expect(fingerprint(inputs, 'source', 'other-bun')).not.toBe(id);
  expect(fingerprint([['ab', bytes('c')], inputs[1]], 'source', 'bun-fixture')).not.toBe(id);
  expect(fingerprint([['a', bytes('bd')], inputs[1]], 'source', 'bun-fixture')).not.toBe(id);
});

test('source fingerprints change with assets and build configuration, not README, mtime or declarations', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'taskpath-fingerprint-'));
  const put = (name: string, value: string) => { mkdirSync(resolve(root, name, '..'), { recursive: true }); writeFileSync(resolve(root, name), value); };
  try {
    for (const name of ['scripts/build.ts', 'src/client-assets.ts', 'src/client-styles.ts', 'src/client-release.ts', 'package.json', 'bun.lock', 'tsconfig.base.json', 'tsconfig.json', 'tsconfig.browser.json', 'tsconfig.worker.json']) put(name, name.endsWith('.json') ? '{}' : 'fixture');
    put('public/app.tsx', 'export const url = "/assets/__TASKPATH_RELEASE__/app.js";');
    const first = sourceRelease('source', root);
    put('README.md', 'Documentation changed'); put('public/types.d.ts', 'interface Example {}');
    expect(sourceRelease('source', root).version).toBe(first.version);
    put('public/app.tsx', 'export const url = "/assets/__TASKPATH_RELEASE__/app.js";');
    expect(sourceRelease('source', root).version).toBe(first.version);
    put('public/app.tsx', 'export const changed = true;');
    const second = sourceRelease('source', root);
    expect(second.version).not.toBe(first.version);
    // Requests already resolving the previous release retain its source bytes.
    expect(await clientAsset(resolve(root, 'public'), 'app.js', first)).toContain(`/assets/${first.version}/app.js`);
    put('scripts/build.ts', 'new minification options');
    expect(sourceRelease('source', root).version).not.toBe(second.version);
    const third = sourceRelease('source', root);
    put('public/icon.png', 'new binary asset');
    expect(sourceRelease('source', root).version).not.toBe(third.version);
    const fourth = sourceRelease('source', root);
    put('public/ui/styles/board.css', '.board { gap: 20px; }');
    expect(sourceRelease('source', root).version).not.toBe(fourth.version);
    expect(stampRelease('__TASKPATH_RELEASE__ __TASKPATH_RELEASE__', first)).toBe(`${first.version} ${first.version}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('production uses a verified immutable build snapshot and rejects damaged or incomplete artifacts', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'taskpath-build-manifest-'));
  const version = fingerprint([['app.js', bytes('fixture')]], 'built');
  const assets = { 'index.html': `<script src="/assets/${version}/app.js"></script>`, 'sw.js': `const cache="taskpath-shell-${version}";`, 'app.js': 'export const value = 1;' };
  try {
    for (const [name, text] of Object.entries(assets)) writeFileSync(resolve(directory, name), text);
    writeFileSync(resolve(directory, BUILD_MANIFEST), JSON.stringify({ format: 1, version, files: Object.fromEntries(Object.entries(assets).map(([name, text]) => [name, digest(text)])) }));
    const release = builtRelease(directory);
    expect(release.version).toBe(version);
    writeFileSync(resolve(directory, 'app.js'), 'modified after server startup');
    expect(new TextDecoder().decode(await clientAsset(directory, 'app.js', release) as Uint8Array)).toBe(assets['app.js']);
    expect(() => builtRelease(directory)).toThrow('damaged');
    writeFileSync(resolve(directory, 'app.js'), assets['app.js']);
    rmSync(resolve(directory, 'sw.js'));
    expect(() => builtRelease(directory)).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Tailwind CSS uses release snapshots and existing theme variables without a reset', async () => {
  const { clientStyles } = await import('../src/client-styles');
  const release = sourceRelease();
  const snapshot = {...release, version:release.version + '-css-fixture', sources:new Map(release.sources)};
  snapshot.sources.set('ui/snapshot-check.tsx',bytes('<div className="p-[137px] text-muted"/>'));
  const css = await clientStyles(snapshot);
  expect(css).toContain('137px');
  expect(css).toContain('color: var(--muted)');
  expect(css).not.toContain('@tailwind');
  expect(css).not.toContain('@theme');
  expect(css).not.toContain('box-sizing: border-box;\n  margin: 0;');
  expect(await clientAsset(snapshot.directory!, 'style.css', snapshot)).toBe(css);
  expect(await clientStyles(release)).not.toContain('137px');
});

test('stylesheet fragments are inlined in order from the snapshot and missing imports fail', async () => {
  const { clientStyles } = await import('../src/client-styles');
  const release = sourceRelease();
  const snapshot = {...release, version:release.version + '-imports', sources:new Map(release.sources)};
  snapshot.sources.set('style.css',bytes('@import "./ui/styles/first.css";\n@import "./ui/styles/second.css";'));
  snapshot.sources.set('ui/styles/first.css',bytes('.fixture { color: red; }'));
  snapshot.sources.set('ui/styles/second.css',bytes('.fixture { color: blue; }'));
  const css = await clientStyles(snapshot);
  expect(css).not.toContain('@import');
  expect(css.indexOf('color: red')).toBeGreaterThan(-1);
  expect(css.indexOf('color: blue')).toBeGreaterThan(css.indexOf('color: red'));
  const missing = {...snapshot, version:snapshot.version + '-missing', sources:new Map(snapshot.sources)};
  missing.sources.delete('ui/styles/first.css');
  await expect(clientStyles(missing)).rejects.toThrow('Missing stylesheet');
});
