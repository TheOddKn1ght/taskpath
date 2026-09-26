import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';

const here = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
export const RELEASE_TOKEN = '__TASKPATH_RELEASE__';
export const SOURCE_DIRECTORY = resolve(here, '../public');
export const BUILD_MANIFEST = '.taskpath-build.json';
const root = resolve(here, '..');
export interface ClientRelease { version: string; sources?: Map<string, Uint8Array>; assets?: Map<string, Uint8Array>; directory?: string }
export interface BuildManifest { format: 1; version: string; files: Record<string, string> }
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Length-delimited paths and bytes avoid ambiguous concatenations. No timestamps,
// absolute paths, environment variables, Git metadata or user data enter the hash.
export function fingerprint(entries: Iterable<readonly [string, Uint8Array]>, mode: 'source' | 'built', toolchain = 'deno-esbuild:0.25.0') {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(['taskpath-client', 1, mode, toolchain]));
  for (const [name, bytes] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(JSON.stringify([name, bytes.byteLength])); hash.update(bytes);
  }
  return 'accounts-' + hash.digest('hex').slice(0, 32);
}

function walkFiles(directory: string, dot = false): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!dot && entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(directory, full).split(sep).join('/'));
    }
  };
  walk(directory);
  return out;
}

export function sourceRelease(mode: 'source' | 'built' = 'source', projectRoot = root): ClientRelease {
  const directory = resolve(projectRoot, 'public');
  const sources = new Map<string, Uint8Array>();
  for (const name of walkFiles(directory)) {
    if (!name.endsWith('.d.ts')) sources.set(name, readFileSync(resolve(directory, name)));
  }
  const inputs = [...sources].map(([name, bytes]) => ['public/' + name, bytes] as const);
  for (const name of ['scripts/build.ts', 'src/client-assets.ts', 'src/client-styles.ts', 'src/client-release.ts', 'package.json', 'deno.json', 'tsconfig.base.json', 'tsconfig.json', 'tsconfig.browser.json', 'tsconfig.worker.json']) {
    try { inputs.push([name, readFileSync(resolve(projectRoot, name))]); } catch { /* optional during transition */ }
  }
  return { version: fingerprint(inputs, mode), sources, directory };
}
export function stampRelease(text: string, release: ClientRelease): string { return text.replaceAll(RELEASE_TOKEN, release.version); }

// Production trusts its verified artifact manifest, not the current source tree
// or runtime version. This also permits running a build on another machine.
export function builtRelease(directory: string): ClientRelease {
  try {
    const manifest: unknown = JSON.parse(readFileSync(resolve(directory, BUILD_MANIFEST), 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !('format' in manifest) || manifest.format !== 1 ||
      !('version' in manifest) || typeof manifest.version !== 'string' || !/^accounts-[a-f0-9]{32}$/.test(manifest.version) ||
      !('files' in manifest) || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error();
    const files = manifest.files as Record<string, unknown>;
    if (!files['index.html'] || !files['sw.js']) throw new Error();
    const names = walkFiles(directory, true).filter(name => name !== BUILD_MANIFEST).sort();
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(files).sort())) throw new Error();
    const assets = new Map<string, Uint8Array>();
    for (const [name, checksum] of Object.entries(files)) {
      if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || name.includes('\\') ||
        typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error();
      const bytes = readFileSync(resolve(directory, name));
      if (digest(bytes) !== checksum) throw new Error();
      assets.set(name, bytes);
    }
    if (!new TextDecoder().decode(assets.get('index.html')).includes(`/assets/${(manifest as BuildManifest).version}/`) ||
      !new TextDecoder().decode(assets.get('sw.js')).includes('taskpath-shell-' + (manifest as BuildManifest).version)) throw new Error();
    return { version: (manifest as BuildManifest).version, assets, directory: resolve(directory) };
  } catch { throw new Error('Client build missing, outdated or damaged. Run deno task build before starting production.'); }
}
export function releaseForDirectory(directory: string): ClientRelease {
  if (resolve(directory) === SOURCE_DIRECTORY) return sourceRelease();
  if (!existsSync(resolve(directory, BUILD_MANIFEST))) throw new Error('Client build manifest missing. Run deno task build.');
  return builtRelease(directory);
}
