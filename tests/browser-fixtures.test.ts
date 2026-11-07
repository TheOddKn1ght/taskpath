import { expect, test } from 'bun:test';
import { fingerprint, sourceRelease, type ClientRelease } from '../src/client-release';
import { browserFixtures } from './browser-fixtures';

const snapshot = (content: string): ClientRelease => {
  const sources = new Map([['offline.ts', new TextEncoder().encode(content)]]);
  return { version: fingerprint(sources, 'built'), sources };
};

test('browser fixtures preserve the matching source snapshot for a built release', () => {
  const source = snapshot('export const value = 1;');
  const built = { version: source.version, assets: new Map<string, Uint8Array>() };
  expect(browserFixtures(built, source)).toBe(source);
});

test('browser fixtures reject changed source instead of stamping it with a stale build version', () => {
  const original = snapshot('export const value = 1;');
  const built = { version: original.version, assets: new Map<string, Uint8Array>() };
  const edited = snapshot('export const value = 2;');
  expect(() => browserFixtures(built, edited)).toThrow('Run bun run build again');
  expect(edited.version).not.toBe(built.version);
});

test('browser fixtures fingerprint local inputs using the tested release mode', () => {
  const built = sourceRelease('built');
  expect(browserFixtures({ version: built.version, assets: new Map() }).version).toBe(
    built.version,
  );
  const source = sourceRelease();
  expect(browserFixtures(source).version).toBe(source.version);
});
