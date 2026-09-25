import type { ClientRelease } from './client-release';

// Compile only the immutable release snapshot, never scan a changing checkout.
// Lazy imports keep the production server independent of build-only packages.
const compiled = new Map<string, Promise<string>>();
export function clientStyles(release: ClientRelease): Promise<string> {
  const cached = compiled.get(release.version);
  if (cached) return cached;
  const result = (async () => {
    if (!release.sources) throw new Error('CSS compilation requires a source snapshot.');
    const { compile } = await import('tailwindcss');
    const { Scanner } = await import('@tailwindcss/oxide');
    const text = (name:string) => {
      const bytes = release.sources!.get(name);
      if (!bytes) throw new Error('Missing stylesheet: ' + name);
      return new TextDecoder().decode(bytes);
    };
    const scanner = new Scanner({});
    const candidates = scanner.scanFiles([...release.sources].filter(([name]) => /\.(html|tsx?|js)$/.test(name) && !name.startsWith('vendor/')).map(([name,bytes]) => ({
      content:new TextDecoder().decode(bytes), extension:name.split('.').at(-1)!,
    })));
    const compiler = await compile(text('ui/tailwind.css') + '\n' + text('style.css'), {
      // Resolve only local stylesheet fragments from this immutable snapshot.
      // Imports are inlined here, never fetched by the browser.
      loadStylesheet: async (id) => {
        if (!/^\.\/ui\/styles\/[a-z-]+\.css$/.test(id)) throw new Error('Unsupported stylesheet import: ' + id);
        const path = id.slice(2);
        return { path, base: '', content: text(path) };
      },
    });
    return compiler.build(candidates);
  })();
  compiled.set(release.version,result);
  while (compiled.size > 4) compiled.delete(compiled.keys().next().value!);
  result.catch(() => { if (compiled.get(release.version) === result) compiled.delete(release.version); });
  return result;
}
