import { mkdir, rename, rm } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { sourceRelease, stampRelease, digest, BUILD_MANIFEST, type BuildManifest } from '../src/client-release';

const root = resolve(import.meta.dir, '..');

// Collapse only ordinary HTML text whitespace. Preserve inline word separators,
// entities, and whitespace-sensitive elements; never rewrite attributes or JS.
export async function compactHTML(source: string) {
  let preserved = 0, text = '';
  return new HTMLRewriter()
    .on('pre, textarea, script, style', {
      element(element) {
        preserved++;
        element.onEndTag(() => { preserved--; });
      },
    })
    .onDocument({
      comments(comment) { comment.remove(); },
      text(chunk) {
        if (preserved) return;
        text += chunk.text;
        if (chunk.lastInTextNode) {
          chunk.replace(text.replace(/[\t\n\f\r ]+/g, ' '), { html: true });
          text = '';
        } else chunk.remove();
      },
    }).transform(new Response(source)).text();
}

export async function buildClient() {
  const release = sourceRelease('built');
  const source = resolve(root, 'public'), output = resolve(root, 'dist/public');
  const staging = resolve(root, 'dist/.client-build');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  let before = 0, after = 0;
  try {
    const files = [...new Bun.Glob('**/*').scanSync({ cwd: source, onlyFiles: true })].sort();
    for (const name of files) {
      if (name.endsWith(".d.ts") || name.startsWith("ui/")) continue;
      const input = Bun.file(resolve(source, name));
      const destination = resolve(staging, name.replace(/\.tsx?$/, '.js'));
      await mkdir(dirname(destination), { recursive: true });
      const extension = extname(name);
      if (extension === '.ts' || extension === '.tsx' || extension === '.js' || extension === '.css') {
        const bundled = name === 'app.tsx' || name === 'sw.ts';
        const result = await Bun.build({
          entrypoints: [resolve(source, name)], target: 'browser',
          format: name === 'theme.ts' ? 'iife' : 'esm',
          // Bundle each runtime once, so all app consumers share one offline
          // state. Individual module URLs remain available for the harness,
          // but are neither imported by the production app nor precached.
          external: bundled ? [] : ['*'], minify: true, sourcemap: 'none', env: 'disable',
          define: name === 'sw.ts' ? { TASKPATH_SHELL_FILES: JSON.stringify([
            'app.js', 'theme.js',
            ...files.filter(file => !file.includes('/') && ['.css', '.webmanifest', '.svg', '.png'].includes(extname(file))),
          ]) } : { 'process.env.NODE_ENV': JSON.stringify('production') },
          plugins: name === 'sw.ts' ? [{ name: 'worker-local-imports', setup(build) {
            // The source worker uses an absolute, versioned URL because it is
            // served from /sw.js. Resolve that URL only while bundling.
            build.onResolve({ filter: /^\/assets\/__TASKPATH_RELEASE__\/offline\.js$/ }, () => ({ path: resolve(source, 'offline.ts') }));
          } }] : [],
        });
        if (!result.success) throw new AggregateError(result.logs, `Could not minify ${name}`);
        if (result.outputs.length !== 1) throw new Error(`Unexpected outputs for ${name}`);
        await Bun.write(destination, stampRelease(await result.outputs[0].text(), release));
      } else if (extension === '.html') {
        await Bun.write(destination, stampRelease((await compactHTML(await input.text())).trim(), release));
      } else if (extension === '.webmanifest' || extension === '.json') {
        await Bun.write(destination, stampRelease(JSON.stringify(await input.json()), release));
      } else if (extension === '.svg') {
        // Our SVG is already compact; do not alter path geometry or attributes.
        await Bun.write(destination, stampRelease((await input.text()).trim(), release));
      } else {
        // Keep binary icons and the vendored license/provenance intact.
        await Bun.write(destination, input);
      }
      if (['.ts', '.tsx', '.js', '.css', '.html', '.webmanifest', '.json', '.svg'].includes(extension)) {
        before += input.size;
        after += Bun.file(destination).size;
      }
    }
    if (sourceRelease('built').version !== release.version) throw new Error('Client inputs changed during the build. Run bun run build again.');
    const manifest: BuildManifest = { format: 1, version: release.version, files: {} };
    for (const name of [...new Bun.Glob('**/*').scanSync({ cwd: staging, onlyFiles: true })].sort()) {
      manifest.files[name] = digest(new Uint8Array(await Bun.file(resolve(staging, name)).arrayBuffer()));
    }
    await Bun.write(resolve(staging, BUILD_MANIFEST), JSON.stringify(manifest));
    // Never leave a partially minified tree after a compilation failure.
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    console.log(`Client ${release.version} built: standalone app and worker bundles; ${(after / 1024).toFixed(1)} KiB total text assets (including standalone modules for checks; ${(before / 1024).toFixed(1)} KiB source).`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) await buildClient();
