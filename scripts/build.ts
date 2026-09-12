import { mkdir, rename, rm } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';

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
  const source = resolve(root, 'public'), output = resolve(root, 'dist/public');
  const staging = resolve(root, 'dist/.client-build');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  let before = 0, after = 0;
  try {
    const files = [...new Bun.Glob('**/*').scanSync({ cwd: source, onlyFiles: true })].sort();
    for (const name of files) {
      if (name.endsWith(".d.ts")) continue;
      const input = Bun.file(resolve(source, name));
      const destination = resolve(staging, name.replace(/\.ts$/, '.js'));
      await mkdir(dirname(destination), { recursive: true });
      const extension = extname(name);
      if (extension === '.ts' || extension === '.js' || extension === '.css') {
        const result = await Bun.build({
          entrypoints: [resolve(source, name)], target: 'browser',
          format: name === 'theme.ts' ? 'iife' : 'esm',
          // Preserve the module graph: the page and worker must each have one
          // offline-state module, not independent copies inside every bundle.
          external: ['*'], minify: true, sourcemap: 'none', env: 'disable',
        });
        if (!result.success) throw new AggregateError(result.logs, `Could not minify ${name}`);
        if (result.outputs.length !== 1) throw new Error(`Unexpected outputs for ${name}`);
        await Bun.write(destination, result.outputs[0]);
      } else if (extension === '.html') {
        await Bun.write(destination, (await compactHTML(await input.text())).trim());
      } else if (extension === '.webmanifest' || extension === '.json') {
        await Bun.write(destination, JSON.stringify(await input.json()));
      } else if (extension === '.svg') {
        // Our SVG is already compact; do not alter path geometry or attributes.
        await Bun.write(destination, (await input.text()).trim());
      } else {
        // Keep binary icons and the vendored license/provenance intact.
        await Bun.write(destination, input);
      }
      if (['.ts', '.js', '.css', '.html', '.webmanifest', '.json', '.svg'].includes(extension)) {
        before += input.size;
        after += Bun.file(destination).size;
      }
    }
    // Never leave a partially minified tree after a compilation failure.
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    console.log(`Client built: ${(before / 1024).toFixed(1)} → ${(after / 1024).toFixed(1)} KiB (${Math.round((1 - after / before) * 100)}% smaller).`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) await buildClient();
