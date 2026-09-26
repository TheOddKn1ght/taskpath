import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Shared test helpers. Trusted dependencies only: Node built-ins.
// esbuild-backed transforms live with their callers.
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const readText = (path: string): string => readFileSync(path, 'utf8');
export const readBytes = (path: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(path));
export const readJSON = (path: string): unknown => JSON.parse(readText(path));
export const fileExists = (path: string): boolean => existsSync(path);
export const fileSize = (path: string): number => statSync(path).size;

export function walkFiles(directory: string, dot = false): string[] {
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

// Runtime export names (value exports only, no type-only exports). Both sides
// of build comparisons use this, so minified `export{A as B}` and multiline
// declarations compare identically.
export function scanExports(code: string): string[] {
  const names = new Set<string>();
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\w$])\/\/[^\n]*/g, '$1');
  for (const match of stripped.matchAll(/export\s+(?:const|let|var)\s+([^;]+);|export\s+(?:async\s+function\*?|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    if (match[2]) { names.add(match[2]); continue; }
    // Multi-declarator statements: export const A = 1, B = 2;
    for (const declarator of splitTopLevel(match[1]!, ',')) {
      const name = /^\s*([A-Za-z_$][\w$]*)/.exec(declarator);
      if (name) names.add(name[1]!);
    }
  }
  for (const match of stripped.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '');
      if (!name || name.startsWith('type ')) continue;
      const as = /as\s+([A-Za-z_$][\w$]*)\s*$/.exec(name);
      names.add(as ? as[1]! : name.split(/\s+/)[0]!);
    }
  }
  for (const match of stripped.matchAll(/export\s+default\s+(?:function\*?|class)?\s*([A-Za-z_$][\w$]*)?/g)) {
    if (match[1]) names.add(match[1]);
    else names.add('default');
  }
  return [...names];
}

// Static and dynamic import specifiers.
// Type-position `import('./types.js')` annotations are excluded: they vanish
// from compiled output.
export function scanImports(code: string): { path: string }[] {
  const paths: string[] = [];
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\w$:'"`])\/\/[^\n]*/g, '$1');
  for (const match of stripped.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) paths.push(match[1]!);
  for (const match of stripped.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = match[1]!;
    if (/(^|\/)types\.d\.ts$/.test(spec) || /(^|\/)types\.js$/.test(spec)) continue;
    if (!paths.includes(spec)) paths.push(spec);
  }
  return paths.map(path => ({ path }));
}

export const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && (() => { let d = 0; for (let i = 0; i < a.byteLength; i++) d |= a[i]! ^ b[i]!; return d === 0; })();

// Split on a separator ignoring nesting and string literals.
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, escaped = false, current = '';
  for (const char of text) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; current += char; continue; }
    if ('([{'.includes(char)) depth++;
    if (')]}'.includes(char)) depth--;
    if (char === separator && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}
