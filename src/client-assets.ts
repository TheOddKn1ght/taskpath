import { resolve } from 'node:path';

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' });
// Called only after the HTTP handler's explicit asset allowlist has matched.
export async function clientAsset(directory: string, name: string) {
  const file = Bun.file(resolve(directory, name));
  if (name.endsWith('.js') && !name.startsWith('vendor/') && !await file.exists()) {
    return transpiler.transformSync(await Bun.file(resolve(directory, name.replace(/\.js$/, '.ts'))).text());
  }
  return file;
}
