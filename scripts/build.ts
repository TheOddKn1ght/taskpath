import { clientStyles } from '../src/client-styles.ts';
import { mkdir, rename, rm, writeFile, stat, copyFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, extname, join, relative, sep } from 'node:path';
import { build, transform } from 'esbuild';
import { sourceRelease, stampRelease, digest, BUILD_MANIFEST, type BuildManifest } from '../src/client-release.ts';

const here = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const root = resolve(here, '..');

function walkFiles(directory: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(directory, full).split(sep).join('/'));
    }
  };
  walk(directory);
  return out;
}

// Collapse only ordinary HTML text whitespace. Preserve inline word separators,
// entities, and whitespace-sensitive elements; never rewrite attributes or JS.
// Dependency-free replacement for the previous HTMLRewriter pass.
export function compactHTML(source: string): string {
  const preserved = new Set(['pre', 'textarea', 'script', 'style']);
  const stack: string[] = [];
  let out = '';
  let i = 0;
  const insidePreserved = () => stack.some(t => preserved.has(t));
  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source[i] === '<') {
      const end = source.indexOf('>', i + 1);
      if (end === -1) { if (!insidePreserved()) out += source.slice(i).replace(/[\t\n\f\r ]+/g, ' '); else out += source.slice(i); break; }
      const tag = source.slice(i, end + 1);
      const match = /^<\/?([a-zA-Z0-9-]+)/.exec(tag);
      if (match) {
        const name = match[1]!.toLowerCase();
        if (tag.startsWith('</')) {
          const idx = stack.lastIndexOf(name);
          if (idx !== -1) stack.length = idx;
        } else if (!tag.endsWith('/>') && preserved.has(name)) {
          stack.push(name);
        } else if (!tag.startsWith('</') && !preserved.has(name)) {
          // Track non-preserved elements so end tags pop correctly.
          stack.push(name);
        }
      }
      out += tag;
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < source.length && source[j] !== '<' && !source.startsWith('<!--', j)) j++;
    const text = source.slice(i, j);
    out += insidePreserved() ? text : text.replace(/[\t\n\f\r ]+/g, ' ');
    i = j;
  }
  return out;
}

export async function buildClient() {
  const release = sourceRelease('built');
  const source = resolve(root, 'public'), output = resolve(root, 'dist/public');
  const staging = resolve(root, 'dist/.client-build');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  let before = 0, after = 0;
  try {
    const files = walkFiles(source).sort();
    for (const name of files) {
      if (name.endsWith('.d.ts') || name.startsWith('ui/')) continue;
      const inputPath = resolve(source, name);
      const destination = resolve(staging, name.replace(/\.tsx?$/, '.js'));
      await mkdir(dirname(destination), { recursive: true });
      const extension = extname(name);
      if (name === 'style.css') {
        const css = await clientStyles(release);
        const result = await transform(css, { loader: 'css', minify: true });
        await writeFile(destination, stampRelease(result.code, release));
      } else if (extension === '.ts' || extension === '.tsx' || extension === '.js' || extension === '.css') {
        const bundled = name === 'app.tsx' || name === 'sw.ts';
        if (bundled) {
          const result = await build({
            entryPoints: [inputPath], bundle: true, platform: 'browser',
            format: 'esm', minify: true, jsx: 'automatic', write: false,
            define: name === 'sw.ts' ? { TASKPATH_SHELL_FILES: JSON.stringify([
              'app.js', 'theme.js',
              ...files.filter(file => !file.includes('/') && ['.css', '.webmanifest', '.svg', '.png'].includes(extname(file))),
            ]) } : { 'process.env.NODE_ENV': JSON.stringify('production') },
            plugins: name === 'sw.ts' ? [{ name: 'worker-local-imports', setup(pluginBuild) {
              // The source worker uses an absolute, versioned URL because it is
              // served from /sw.js. Resolve that URL only while bundling.
              pluginBuild.onResolve({ filter: /^\/assets\/__TASKPATH_RELEASE__\/offline\.js$/ }, () => ({ path: resolve(source, 'offline.ts') }));
              // The Markdown module types its lexer via the vendored .d.ts but
              // must execute the sibling JavaScript implementation.
              pluginBuild.onResolve({ filter: /vendor\/marked\.d\.ts$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/marked\.d\.ts$/, 'marked.js')) }));
            } }] : [{ name: 'marked-alias', setup(pluginBuild) {
              pluginBuild.onResolve({ filter: /vendor\/marked\.d\.ts$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/marked\.d\.ts$/, 'marked.js')) }));
            } }],
          });
          if (!result.outputFiles || result.outputFiles.length !== 1) throw new Error(`Unexpected outputs for ${name}`);
          await writeFile(destination, stampRelease(result.outputFiles[0]!.text, release));
        } else if (extension === '.css') {
          const result = await transform(readFileSync(inputPath, 'utf8'), { loader: 'css', minify: true });
          await writeFile(destination, stampRelease(result.code, release));
        } else {
          // Individual module URLs remain available for the harness, but are
          // neither imported by the production app nor precached. Transpile
          // only; imports stay external.
          const loader = extension === '.tsx' ? 'tsx' : extension === '.ts' ? 'ts' : 'js';
          const result = await transform(readFileSync(inputPath, 'utf8'), { loader, format: name === 'theme.ts' ? 'iife' : 'esm', minify: true, jsx: 'automatic' });
          await writeFile(destination, stampRelease(result.code.replaceAll('./vendor/marked.d.ts', './vendor/marked.js'), release));
        }
      } else if (extension === '.html') {
        await writeFile(destination, stampRelease(compactHTML(readFileSync(inputPath, 'utf8')).trim(), release));
      } else if (extension === '.webmanifest' || extension === '.json') {
        await writeFile(destination, stampRelease(JSON.stringify(JSON.parse(readFileSync(inputPath, 'utf8'))), release));
      } else if (extension === '.svg') {
        // Our SVG is already compact; do not alter path geometry or attributes.
        await writeFile(destination, stampRelease(readFileSync(inputPath, 'utf8').trim(), release));
      } else {
        // Keep binary icons and the vendored license/provenance intact.
        await copyFile(inputPath, destination);
      }
      if (['.ts', '.tsx', '.js', '.css', '.html', '.webmanifest', '.json', '.svg'].includes(extension)) {
        before += statSync(inputPath).size;
        after += (await stat(destination)).size;
      }
    }
    if (sourceRelease('built').version !== release.version) throw new Error('Client inputs changed during the build. Run deno task build again.');
    const manifest: BuildManifest = { format: 1, version: release.version, files: {} };
    for (const name of walkFiles(staging).sort()) {
      manifest.files[name] = digest(new Uint8Array(readFileSync(resolve(staging, name))));
    }
    await writeFile(resolve(staging, BUILD_MANIFEST), JSON.stringify(manifest));
    // Never leave a partially minified tree after a compilation failure.
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    console.log(`Client ${release.version} built: standalone app and worker bundles; ${(after / 1024).toFixed(1)} KiB total text assets (including standalone modules for checks; ${(before / 1024).toFixed(1)} KiB source).`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) await buildClient();
