import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export function assetEncoding(header: string | null): 'br' | 'gzip' | null {
  const accepted = new Map<string, number>();
  for (const item of (header || '').toLowerCase().split(',')) {
    const [name, ...parameters] = item.trim().split(';');
    const q = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
    const quality = q ? Number(q.slice(2)) : 1;
    accepted.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const quality = (name: string) => accepted.get(name) ?? accepted.get('*') ?? 0;
  const br = quality('br'), gzip = quality('gzip');
  return br > 0 && br >= gzip ? 'br' : gzip > 0 ? 'gzip' : null;
}

export function compressAsset(bytes: Uint8Array, encoding: 'br' | 'gzip') {
  return encoding === 'br'
    ? brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
    : gzipSync(bytes, { level: 6 });
}
