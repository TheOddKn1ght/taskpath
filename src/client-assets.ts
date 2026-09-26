import { clientStyles } from './client-styles.ts';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { build, transform } from 'esbuild';
import {
  sourceRelease,
  stampRelease,
  type ClientRelease,
} from './client-release.ts';

async function transpile(text: string): Promise<string> {
  const result = await transform(text, { loader: 'ts', target: 'esnext' });
  return result.code;
}

const bundles = new Map<string, Promise<string>>();
export async function bundleClient(
  entry: string,
  release: ClientRelease,
  minify = false,
) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    minify,
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': JSON.stringify(
        minify ? 'production' : 'development',
      ),
    },
    write: false,
    plugins: [
      {
        name: 'source-snapshot',
        setup(pluginBuild) {
          pluginBuild.onResolve(
            { filter: /^\/assets\/__TASKPATH_RELEASE__\/offline\.js$/ },
            () => ({ path: resolve(release.directory!, 'offline.ts') }),
          );
          // The Markdown module types its lexer via the vendored .d.ts but
          // must execute the sibling JavaScript implementation.
          pluginBuild.onResolve({ filter: /vendor\/marked\.d\.ts$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path.replace(/marked\.d\.ts$/, 'marked.js')),
          }));
          pluginBuild.onLoad({ filter: /\.[tj]sx?$/ }, (args) => {
            const root = release.directory
              ? realpathSync(release.directory)
              : undefined;
            if (!root || !release.sources || !args.path.startsWith(root + '/'))
              return;
            const name = args.path.slice(root.length + 1),
              bytes = release.sources.get(name);
            if (!bytes)
              throw new Error('Source not in release snapshot: ' + name);
            return {
              contents: new TextDecoder().decode(bytes),
              loader: name.endsWith('.tsx')
                ? 'tsx'
                : name.endsWith('.ts')
                  ? 'ts'
                  : 'js',
              resolveDir: dirname(args.path),
            };
          });
        },
      },
    ],
  });
  if (!result.outputFiles || result.outputFiles.length !== 1)
    throw new Error('Expected one client bundle');
  return stampRelease(result.outputFiles[0]!.text, release);
}
// Only explicit HTTP asset routes call this function. TSX components are bundled,
// never exposed as arbitrary source URLs or separate React runtimes.
export async function clientAsset(
  directory: string,
  name: string,
  release: ClientRelease = sourceRelease(),
): Promise<string | Uint8Array<ArrayBuffer>> {
  if (release.assets && resolve(directory) === release.directory) {
    const bytes = release.assets.get(name);
    if (!bytes) throw new Error('Asset missing from build manifest.');
    return new Uint8Array(bytes);
  }
  if (name === 'style.css' && release.sources && resolve(directory) === release.directory) return stampRelease(await clientStyles(release), release);
  const sourceName =
    name.endsWith('.js') && !name.startsWith('vendor/')
      ? name.replace(/\.js$/, '.ts')
      : name;
  if (
    (name === 'app.js' || name === 'sw.js') &&
    resolve(directory) === release.directory
  ) {
    const key = release.version + ':' + name;
    let cached = bundles.get(key);
    if (!cached) {
      cached = bundleClient(
        resolve(directory, name === 'app.js' ? 'app.tsx' : 'sw.ts'),
        release,
      );
      for (const old of bundles.keys())
        if (!old.startsWith(release.version + ':')) bundles.delete(old);
      bundles.set(key, cached);
      cached.catch(() => bundles.delete(key));
    }
    return cached;
  }
  const snapshot =
    resolve(directory) === release.directory
      ? release.sources?.get(sourceName)
      : undefined;
  if (snapshot) {
    const text = new TextDecoder().decode(snapshot);
    if (sourceName.endsWith('.ts'))
      return stampRelease((await transpile(text)).replaceAll('./vendor/marked.d.ts', './vendor/marked.js'), release);
    if (/\.(html|js|css|webmanifest|json|svg)$/.test(name))
      return stampRelease(text, release);
    return new Uint8Array(snapshot);
  }
  const tsx = resolve(directory, name.replace(/\.js$/, '.tsx'));
  if (name.endsWith('.js') && existsSync(tsx))
    return bundleClient(tsx, release, !!release.assets);
  if (
    name.endsWith('.js') &&
    !name.startsWith('vendor/') &&
    !existsSync(resolve(directory, name))
  ) {
    const transpiled = await transpile(readFileSync(resolve(directory, sourceName), 'utf8'));
    return stampRelease(transpiled.replaceAll('./vendor/marked.d.ts', './vendor/marked.js'), release);
  }
  const raw = readFileSync(resolve(directory, name));
  if (/\.(html|js|css|webmanifest|json|svg)$/.test(name)) return new TextDecoder().decode(raw);
  return new Uint8Array(raw);
}
