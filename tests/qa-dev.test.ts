import { expect, test } from 'bun:test';
import { startQaSession } from '../scripts/qa-dev';
import { unlockVault } from '../public/crypto';
import { Store } from '../src/store';
import { createHandler } from '../src/server';

const claim = (session: { url: string; origin: string }, extra: Record<string, string> = {}) => fetch(session.origin + '/__qa/claim', {
  method: 'POST', headers: { Origin: session.origin, Authorization: 'Bearer ' + new URL(session.url).hash.slice(7), ...extra },
});

test('QA bootstrap is private, one-use, and retains normal auth with isolated cookies', async () => {
  const session = await startQaSession();
  try {
    expect(new URL(session.origin).hostname).toBe('127.0.0.1');
    expect((await fetch(session.origin + '/__qa/claim', { method: 'POST' })).status).toBe(403);
    expect((await claim(session, { Authorization: 'Bearer wrong' })).status).toBe(403);
    expect((await claim(session, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await claim(session, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await fetch(session.origin + '/', { headers: { Host: 'evil.example' } })).status).toBe(403);
    const script = await fetch(session.origin + '/__qa/start.js');
    expect(script.headers.get('cache-control')).toBe('no-store');
    expect(await script.text()).not.toContain(new URL(session.url).hash.slice(7));
    const shell = await fetch(session.origin + '/__qa/start');
    expect(shell.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(shell.headers.get('referrer-policy')).toBe('no-referrer');
    const response = await claim(session);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.password.length).toBe(43);
    expect((await claim(session)).status).toBe(403);
    const unlocked = await unlockVault(data.password, data.config);
    const login = await fetch(session.origin + '/api/auth/login', {
      method: 'POST', headers: { Origin: session.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: data.userId, credential: unlocked.credential, revision: data.config.revision }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^taskpath_qa_[a-f0-9]{32}=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const status = (value: string) => fetch(session.origin + '/api/auth/status', { headers: { Cookie: value } }).then(r => r.json());
    expect((await status(cookie.split(';')[0])).userId).toBe(data.userId);
    expect((await status(cookie.split(';')[0].replace(/^taskpath_qa_[^=]+/, 'taskpath_session'))).authenticated).toBe(false);
    const logout = await fetch(session.origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie.split(';')[0], Origin: session.origin, 'Content-Type': 'application/json' }, body: '{}' });
    expect(logout.status).toBe(200);
    expect((await status(cookie.split(';')[0])).authenticated).toBe(false);
  } finally { await session.stop(); }
});

test('QA links expire and concurrent claims yield only one secret', async () => {
  let now = Date.now();
  const expired = await startQaSession(() => now);
  try {
    now += 300_000;
    expect((await claim(expired)).status).toBe(403);
  } finally { await expired.stop(); }
  const session = await startQaSession();
  try {
    const results = await Promise.all([claim(session), claim(session)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 403]);
  } finally { await session.stop(); }
});

test('QA rejects production mode and normal server has no bootstrap endpoint', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { await expect(startQaSession()).rejects.toThrow('production'); }
  finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  const store = new Store();
  try {
    const handler = createHandler(store);
    const response = await handler(new Request('http://localhost/__qa/claim', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: '{}' }));
    expect(response?.status).toBe(401);
  } finally { store.close(); }
});
