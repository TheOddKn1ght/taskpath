import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store';
import { AuthManager } from '../src/auth';
import { createHandler } from '../src/server';
import { invitationURL } from '../src/admin';
import { createVault, encryptChange, decryptEnvelope, replacePassword, PROFILE_ID, normalizeNickname } from '../public/crypto.js';
import { origin, request, testPassword } from './auth-helpers';

async function twoUsers() {
  const store = new Store(), auth = new AuthManager(store.db), handle = createHandler(store, auth, origin);
  const users = [];
  for (let i = 0; i < 2; i++) {
    const invite = auth.createInvitation(), vault = await createVault(testPassword + i);
    await auth.setup(invite.userId, invite.token, vault.config, vault.credential);
    const response = await request(handle, '', '/api/auth/login', { userId: invite.userId, credential: vault.credential, revision: 1 });
    users.push({ ...invite, ...vault, cookie: response.headers.get('set-cookie')!.split(';')[0] });
  }
  return { store, auth, handle, users };
}
test('accounts isolate ciphertext, duplicate task IDs, reminder tokens, and malicious account selectors', async () => {
  const { store, handle, users: [a, b] } = await twoUsers();
  try {
    const editedAt = new Date().toISOString();
    const envelopes = await Promise.all([a, b].map((u, i) => encryptChange(u.key, u.config.vaultId, { task: { id: 'same-id', updatedAt: editedAt, title: 'private ' + i }, editedAt, changeId: 'same-operation' })));
    for (const [i, u] of [a, b].entries()) expect((await request(handle, u.cookie, '/api/sync', { workspaceKey: u.config.vaultId, changes: [envelopes[i]] })).status).toBe(200);
    for (const [i, u] of [a, b].entries()) {
      const board = await (await request(handle, u.cookie, '/api/sync')).json();
      expect(board.rows).toEqual([envelopes[i]]);
      expect((await request(handle, u.cookie, '/api/sync', { workspaceKey: u.config.vaultId, changes: [envelopes[1-i]] })).status).toBe(400);
      expect((await request(handle, u.cookie, '/api/sync', { workspaceKey: [a,b][1-i].config.vaultId, changes: [] })).status).toBe(409);
    }
    const response = await handle(new Request(origin + '/api/sync', { headers: { cookie: b.cookie, 'x-taskpath-user': a.userId } }));
    expect(response!.status).toBe(401);
    const token = crypto.randomUUID();
    for (const u of [a, b]) expect(await (await request(handle, u.cookie, '/api/reminders/claim', { tokens: [token] })).json()).toEqual({ tokens: [token] });
    expect((await request(handle, a.cookie, '/api/sync', { workspaceKey: a.config.vaultId, changes: [], userId: b.userId })).status).toBe(400);
  } finally { store.close(); }
});
test('changing password or disabling one user does not revoke another user', async () => {
  const { store, auth, handle, users: [a, b] } = await twoUsers();
  try {
    const replacement = await replacePassword(testPassword + '0', 'a new long secret password', a.config);
    expect((await request(handle, a.cookie, '/api/auth/password', { ...replacement, revision: 1 })).status).toBe(200);
    expect((await request(handle, a.cookie, '/api/sync')).status).toBe(401);
    expect((await request(handle, b.cookie, '/api/sync')).status).toBe(200);
    const login = await request(handle, '', '/api/auth/login', { userId: a.userId, credential: replacement.credential, revision: 2 });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    auth.disable(a.userId);
    expect((await request(handle, cookie, '/api/sync')).status).toBe(401);
    expect((await request(handle, b.cookie, '/api/sync')).status).toBe(200);
    expect((await request(handle, '', '/api/auth/login', { userId: a.userId, credential: replacement.credential, revision: 2 })).status).toBe(401);
    expect(auth.configuration(a.userId)).toBeNull();
    expect(() => auth.renewInvitation(a.userId)).toThrow();
    expect(store.db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 2 });
  } finally { store.close(); }
});
test('nickname is encrypted, independent of login, bounded, and bound to the vault', async () => {
  const { store, handle, users: [a, b] } = await twoUsers();
  try {
    const editedAt = new Date().toISOString(), nickname = 'DISTINCTIVE_NICKNAME';
    const e = await encryptChange(a.key, a.config.vaultId, { task: { id: PROFILE_ID, updatedAt: editedAt, nickname }, editedAt, changeId: crypto.randomUUID() });
    await request(handle, a.cookie, '/api/sync', { workspaceKey: a.config.vaultId, changes: [e] });
    expect(JSON.stringify(store.db.query('SELECT * FROM encrypted_tasks').all())).not.toContain(nickname);
    expect((await decryptEnvelope(a.key, a.config.vaultId, e)).nickname).toBe(nickname);
    await expect(decryptEnvelope(b.key, b.config.vaultId, e)).rejects.toThrow();
    expect((await request(handle, '', '/api/auth/login', { userId: nickname, credential: a.credential, revision: 1 })).status).toBe(401);
    expect(normalizeNickname('  Alex  ')).toBe('Alex');
    expect(normalizeNickname('')).toBe('');
    expect(() => normalizeNickname('a'.repeat(41))).toThrow();
    expect(() => normalizeNickname('a\nb')).toThrow();
  } finally { store.close(); }
});
test('single-owner encrypted databases are refused without modifications', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-single-owner-'));
  try {
    const path = join(directory, 'old.sqlite'), db = new Database(path);
    db.exec('CREATE TABLE encrypted_format(version INTEGER); INSERT INTO encrypted_format VALUES(1); CREATE TABLE vault(id INTEGER, config TEXT);'); db.close();
    const before = readFileSync(path);
    expect(() => new Store(path)).toThrow('Legacy');
    expect(readFileSync(path)).toEqual(before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('admin CLI creates, lists, replaces and revokes invitations using the configured database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-admin-'));
  try {
    const env = { ...process.env, DATABASE_PATH: join(directory, 'accounts.sqlite'), TASKPATH_ORIGIN: origin };
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/admin.ts'), ...args], { env, stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0); expect(error).toBe(''); return output;
    };
    const first = await run('invite'), userId = first.match(/User ID: (u_[a-f0-9]{32})/)![1];
    const link = new URL(first.match(/Setup link: (.+)/)![1]);
    expect(link.origin).toBe(origin); expect(link.search).toBe('');
    expect(new URLSearchParams(link.hash.slice(1)).get('user')).toBe(userId);
    expect(await run('list')).toContain(userId);
    const replacement = await run('reinvite', userId); expect(replacement).not.toBe(first);
    await run('revoke', userId);
    const store = new Store(env.DATABASE_PATH), auth = new AuthManager(store.db);
    try { expect(auth.list()[0]).toMatchObject({ status: 'pending', expiresAt: null }); } finally { store.close(); }
    expect(() => invitationURL('http://example.com', userId, 'token')).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
