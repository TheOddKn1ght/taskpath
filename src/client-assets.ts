import { resolve } from 'node:path';
import { sourceRelease, stampRelease, type ClientRelease } from './client-release';

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' });
// Called only after the HTTP handler's explicit asset allowlist has matched.
export async function clientAsset(directory: string, name: string, release: ClientRelease = sourceRelease()) {
  if (release.assets && resolve(directory) === release.directory) {
    const bytes = release.assets.get(name);
    if (!bytes) throw new Error('Asset missing from build manifest.');
    return new Uint8Array(bytes);
  }
  const sourceName = name.endsWith('.js') && !name.startsWith('vendor/') ? name.replace(/\.js$/, '.ts') : name;
  const snapshot = resolve(directory) === release.directory ? release.sources?.get(sourceName) : undefined;
  if (snapshot) {
    const text = new TextDecoder().decode(snapshot);
    if (sourceName.endsWith('.ts')) return stampRelease(transpiler.transformSync(text), release);
    if (/\.(html|js|css|webmanifest|json|svg)$/.test(name)) return stampRelease(text, release);
    return new Uint8Array(snapshot);
  }
  const file = Bun.file(resolve(directory, name));
  if (name.endsWith('.js') && !name.startsWith('vendor/') && !await file.exists()) {
    return stampRelease(transpiler.transformSync(await Bun.file(resolve(directory, sourceName)).text()), release);
  }
  return file;
}
