import { test, expect } from 'bun:test';
import { assetEncoding, compressAsset } from '../src/asset-encoding';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
test('static encoding negotiation respects quality, exclusions and unsupported clients', () => {
 for (const [header, expected] of [[null,null],['identity',null],['br, gzip','br'],['gzip','gzip'],['gzip;q=1, br;q=0.5','gzip'],['br;q=0, gzip;q=0',null],['br;q=0, *;q=1','gzip'],['br;q=invalid',null]] as const) expect(assetEncoding(header)).toBe(expected);
 const source = new TextEncoder().encode('public asset'.repeat(1000));
 expect(brotliDecompressSync(compressAsset(source,'br'))).toEqual(Buffer.from(source));
 expect(gunzipSync(compressAsset(source,'gzip'))).toEqual(Buffer.from(source));
});
