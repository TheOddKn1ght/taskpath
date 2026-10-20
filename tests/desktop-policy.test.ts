import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
const { serverURL, sameOrigin, externalURL } = createRequire(import.meta.url)('../desktop/policy.cjs');

describe('desktop navigation policy', () => {
  test('accepts secure servers and loopback development origins', () => {
    expect(serverURL()).toBe('https://taskpath.oddknight.space');
    for (const url of ['https://tasks.example.com', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(serverURL(url)).toBe(url);
    }
  });
  test('rejects insecure remote servers, credentials and non-origin URLs', () => {
    for (const url of ['http://tasks.example.com', 'file:///tmp/app', 'https://user:secret@example.com',
      'https://example.com/login', 'https://example.com/?token=secret', 'https://example.com/#secret',
      'http://localhost.evil.com', 'invalid']) {
      expect(() => serverURL(url)).toThrow();
    }
  });
  test('restricts navigation to the configured origin', () => {
    expect(sameOrigin('https://tasks.example.com/login?invite=123', 'https://tasks.example.com')).toBe(true);
    for (const url of ['https://tasks.example.com.evil.com', 'http://tasks.example.com',
      'https://tasks.example.com:444', 'javascript:alert(1)', 'invalid']) {
      expect(sameOrigin(url, 'https://tasks.example.com')).toBe(false);
    }
  });
  test('only allows browser and email links to leave the app', () => {
    for (const url of ['https://example.com', 'http://localhost:3000', 'mailto:hello@example.com']) {
      expect(externalURL(url)).toBe(true);
    }
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'custom:command', 'invalid']) {
      expect(externalURL(url)).toBe(false);
    }
  });
});
