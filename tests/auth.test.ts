import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { AuthManager } from '../src/auth';
import { createHandler } from '../src/server';
import { fixture, login, request, origin, testVault, testPassword, testUserId } from './auth-helpers';
import { base64, random, replacePassword } from '../public/crypto.js';

test('invitations expire after 24 hours, are hash-only, replaceable before activation, and consumed atomically', async () => {
  const store = new Store(); let time = Date.now(); const auth = new AuthManager(store.db, 30, () => time);
  try {
    const invite = auth.createInvitation();
    const other = auth.createInvitation();
    await expect(auth.setup(other.userId, invite.token, testVault.config, testVault.credential)).rejects.toThrow();
    auth.revokeInvitation(other.userId);
    expect(JSON.stringify(auth.list())).not.toContain(invite.token);
    expect(JSON.stringify(store.db.query('SELECT * FROM accounts').all())).not.toContain(invite.token);
    time += 86400001;
    await expect(auth.setup(invite.userId, invite.token, testVault.config, testVault.credential)).rejects.toThrow();
    const fresh = auth.renewInvitation(invite.userId);
    const replaced = auth.renewInvitation(invite.userId);
    await expect(auth.setup(invite.userId, fresh.token, testVault.config, testVault.credential)).rejects.toThrow();
    const results = await Promise.allSettled([auth.setup(invite.userId, replaced.token, testVault.config, testVault.credential), auth.setup(invite.userId, replaced.token, testVault.config, testVault.credential)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.db.query('SELECT tokenHash,expiresAt FROM accounts WHERE userId=?').get(invite.userId)).toEqual({ tokenHash: null, expiresAt: null });
    expect(() => auth.renewInvitation(invite.userId)).toThrow();
    await expect(auth.setup(invite.userId, replaced.token, testVault.config, testVault.credential)).rejects.toThrow();
    const restarted = new AuthManager(store.db);
    expect(restarted.configuration(invite.userId)).toEqual(testVault.config);
    expect(restarted.list()).toHaveLength(2);
  } finally { store.close(); }
});
test('user-ID and derived-credential login, public shell, protected APIs, secure cookies, Origin and legacy rejection', async () => {
  const { store, handle } = await fixture();
  try {
    expect((await request(handle, '', '/')).status).toBe(200);
    expect((await request(handle, '', '/api/sync')).status).toBe(401);
    expect((await request(handle, '', '/healthz')).status).toBe(200);
    const { cookie, response } = await login(handle);
    expect(response.status).toBe(200);
    for (const text of ['__Host-taskpath_session=', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) expect(response.headers.get('set-cookie')).toContain(text);
    expect((await request(handle, cookie, '/api/sync')).status).toBe(200);
    expect((await login(handle, base64(random(32)))).response.status).toBe(401);
    expect((await login(handle, testVault.credential, 1, 'https://evil.example')).response.status).toBe(403);
    expect((await request(handle, cookie, '/api/auth/login', { password: testPassword })).status).toBe(400);
    for (const path of ['/api/tasks', '/api/import/preview', '/api/import/markdown', '/api/board', '/api/export']) expect((await request(handle, cookie, path, path.includes('export') || path.includes('board') ? undefined : {})).status).toBe(404);
    const secrets = JSON.stringify(store.db.query('SELECT * FROM accounts').all());
    expect(secrets).not.toContain(testPassword); expect(secrets).not.toContain(testVault.credential); expect(secrets).toContain('$argon2id$');
    const config = await (await request(handle, '', '/api/auth/config?userId=' + testUserId)).json();
    expect(config).toEqual({ config: testVault.config });
  } finally { store.close(); }
});
test('password change verifies current password, uses revision CAS and revokes every existing session', async () => {
  const { store, auth, handle } = await fixture();
  try {
    const a = await login(handle), b = await login(handle);
    const replacement = await replacePassword(testPassword, 'the replacement long password', testVault.config);
    expect((await request(handle, a.cookie, '/api/auth/password', { ...replacement, currentCredential: base64(random(32)), revision: 1 })).status).toBe(401);
    const results = await Promise.all([request(handle, a.cookie, '/api/auth/password', { ...replacement, revision: 1 }), request(handle, b.cookie, '/api/auth/password', { ...replacement, revision: 1 })]);
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status === 409)).toHaveLength(1);
    for (const cookie of [a.cookie, b.cookie]) expect((await request(handle, cookie, '/api/sync')).status).toBe(401);
    expect((await login(handle)).response.status).toBe(401);
    expect((await login(handle, replacement.credential, 2)).response.status).toBe(200);
    expect(auth.configuration(testUserId)).toEqual(replacement.config);
  } finally { store.close(); }
});
test('sessions survive handler restart, expire, and logout revokes only that session', async () => {
  const { store, handle } = await fixture();
  try {
    const a = await login(handle), b = await login(handle);
    const next = createHandler(store, new AuthManager(store.db), origin);
    expect((await request(next, a.cookie, '/api/sync')).status).toBe(200);
    expect((await request(next, a.cookie, '/api/auth/logout', {})).headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await request(next, a.cookie, '/api/sync')).status).toBe(401);
    expect((await request(next, b.cookie, '/api/sync')).status).toBe(200);
    store.db.exec('UPDATE auth_sessions SET expiresAt=0');
    expect((await request(next, b.cookie, '/api/sync')).status).toBe(401);
  } finally { store.close(); }
});
test('login rate limit and bounded JSON bodies remain enforced behind proxy', async () => {
  const { store, handle } = await fixture();
  try {
    for (let i = 0; i < 4; i++) expect((await login(handle, base64(random(32)))).response.status).toBe(401);
    const blocked = await login(handle, base64(random(32)));
    expect(blocked.response.status).toBe(429); expect(blocked.response.headers.get('retry-after')).toBe('900');
    expect((await login(handle)).response.status).toBe(429);
    expect((await request(handle, '', '/api/auth/login', { credential: 'x'.repeat(40000) })).status).toBe(413);
    expect((await handle(new Request(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{}' })))!.status).toBe(415);
    expect((await request(handle, '', '/api/auth/setup', {}, 'https://evil.example')).status).toBe(403);
  } finally { store.close(); }
});
