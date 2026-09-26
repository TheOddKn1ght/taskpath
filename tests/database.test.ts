import { test } from 'node:test';
import { expect } from '@std/expect';
import { Database } from '../src/db/connection.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { Store } from '../src/store.ts';
import { AuthManager } from '../src/auth.ts';
import { PushService } from '../src/push.ts';
import { PushRepository } from '../src/db/push.ts';
import { AccountRepository } from '../src/db/accounts.ts';
import { hashCredential } from '../src/password.ts';
import { encryptChange, decryptEnvelope } from '../public/crypto.ts';
import { ClientStore } from './client-helpers.ts';
import { fixture, testVault, testUserId, origin } from './auth-helpers.ts';

const time = new Date('2026-09-11T12:00:00Z');
const tables = ['encrypted_format', 'settings', 'accounts', 'auth_sessions', 'encrypted_tasks', 'reminder_claims', 'push_subscriptions', 'push_reminders', 'push_deliveries'];
const snapshot = (db: Database) => ({
  schema: db.prepare("SELECT name, replace(sql, ', sequence INTEGER NOT NULL DEFAULT 0', '') AS sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'encrypted_files' AND name != 'task_sequence' ORDER BY name").all(),
  // Table identifiers are a fixed test fixture, never request input.
  rows: tables.map(table => db.prepare(`SELECT ${table === 'encrypted_tasks' ? 'userId,taskId,editedAt,changeId,envelope' : '*'} FROM ${table} ORDER BY rowid`).all()),
});

test('pre-Drizzle database retains schema, sessions, ciphertext, invitations, and push state on upgrade and retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-drizzle-'));
  const path = join(directory, 'existing.sqlite');
  let db: Database | undefined, store: Store | undefined;
  try {
    db = new Database(path);
    db.exec(readFileSync(new URL('./fixtures/pre-drizzle.sql', import.meta.url), 'utf8'));
    const verifier = await hashCredential(testVault.credential);
    const session = 'existing-session';
    db.prepare("INSERT INTO accounts VALUES (?,'active',?,NULL,NULL,1,?,?)").run(testUserId, time.getTime(), JSON.stringify(testVault.config), verifier);
    db.prepare("INSERT INTO accounts VALUES (?,'pending',?,?,?,NULL,NULL,NULL)").run('pending-user', time.getTime(), 'old-token-hash', time.getTime() + 86400000);
    db.prepare('INSERT INTO auth_sessions VALUES (?,?,1,?)').run(createHash('sha256').update(session).digest('hex'), testUserId, time.getTime() + 86400000);
    const device = new ClientStore(':memory:', () => time);
    const task = device.create({ title: 'PRIVATE_UPGRADE_TASK', tags: ['home'], reminderAt: time.toISOString() });
    const envelope = await encryptChange(testVault.key, testVault.config.vaultId, device.record.pending[0]);
    const serialized = JSON.stringify(envelope, null, 2);
    db.prepare('INSERT INTO encrypted_tasks VALUES (?,?,?,?,?)').run(testUserId, task.id, envelope.editedAt, envelope.changeId, serialized);
    const keys = webpush.generateVAPIDKeys();
    db.prepare('INSERT INTO settings VALUES (?,?)').run('push-vapid', JSON.stringify(keys));
    db.prepare('INSERT INTO settings VALUES (?,?)').run('timezone', 'Europe/Moscow');
    db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?)').run('device', testUserId, '{"endpoint":"https://web.push.apple.com/fixture"}');
    db.prepare('INSERT INTO push_reminders VALUES (?,?,?,?,?)').run(testUserId, task.id, envelope.changeId, task.reminderToken!, time.getTime());
    db.prepare('INSERT INTO reminder_claims VALUES (?,?)').run(testUserId, task.reminderToken!);
    db.prepare('INSERT INTO push_deliveries VALUES (?,?,?,?,?,?)').run(testUserId, task.id, task.reminderToken!, 'device', time.getTime() + 60000, 3);
    const before = snapshot(db);
    db.close(); db = undefined;

    store = new Store(path, () => time, 'UTC');
    const auth = new AuthManager(store.db, 30, () => time.getTime());
    const push = new PushService(store, origin);
    expect(snapshot(store.db)).toEqual(before);
    expect(store.timezone).toBe('Europe/Moscow');
    expect(push.status(testUserId).publicKey).toBe(keys.publicKey);
    expect(auth.identity(new Request(origin, { headers: { cookie: 'taskpath_session=' + session } }))).toBe(testUserId);
    expect(await decryptEnvelope(testVault.key, testVault.config.vaultId, store.syncBoard(testUserId).rows[0])).toMatchObject({ title: task.title, tags: ['home'] });
    expect(store.sync(testUserId, { workspaceKey: testVault.config.vaultId, changes: [envelope] }).changed).toBe(false);
    expect(snapshot(store.db)).toEqual(before);
    const cursor = store.syncBoard(testUserId).cursor;
    expect(store.db.prepare('SELECT sequence FROM encrypted_tasks').get()).toEqual({sequence:1});
    store.close(); store = new Store(path, () => time);
    expect(() => store!.syncBoard(testUserId,cursor)).toThrow('cursor expired');
    expect(snapshot(store.db)).toEqual(before);
  } finally {
    db?.close(); store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('sync SQL failure rolls back earlier encrypted writes and reminder cancellation in the batch', async () => {
  const { store } = await fixture(':memory:', () => time);
  try {
    const device = new ClientStore(':memory:', () => time);
    const first = device.create({ title: 'Keep original', reminderAt: time.toISOString() });
    const original = await encryptChange(testVault.key, testVault.config.vaultId, device.record.pending[0]);
    store.sync(testUserId, { workspaceKey: testVault.config.vaultId, changes: [original] });
    store.db.prepare('INSERT INTO push_reminders VALUES (?,?,?,?,?)').run(testUserId, first.id, original.changeId, first.reminderToken!, time.getTime());
    const before = snapshot(store.db);
    device.update(first.id, { title: 'Must roll back' });
    device.create({ title: 'Fail insertion' });
    const changes = await Promise.all(device.record.pending.slice(1).map(change => encryptChange(testVault.key, testVault.config.vaultId, change)));
    store.db.exec(`CREATE TEMP TRIGGER fail_second BEFORE INSERT ON encrypted_tasks
      WHEN NOT EXISTS(SELECT 1 FROM encrypted_tasks WHERE taskId=NEW.taskId AND userId=NEW.userId)
      BEGIN SELECT RAISE(ABORT, 'simulated disk write failure'); END`);
    expect(() => store.sync(testUserId, { workspaceKey: testVault.config.vaultId, changes })).toThrow();
    expect(snapshot(store.db)).toEqual(before);
  } finally { store.close(); }
});

test('nested reminder claims roll back with a failed fan-out transaction', () => {
  const store = new Store();
  try {
    const queue = new PushRepository(store.db), token = 'a'.repeat(32);
    expect(() => queue.transaction(() => {
      expect(store.claim(testUserId, [token]).tokens).toEqual([token]);
      throw new Error('fan-out failed');
    })).toThrow('fan-out failed');
    expect(store.claim(testUserId, [token]).tokens).toEqual([token]);
    expect(store.claim(testUserId, [token]).tokens).toEqual([]);
  } finally { store.close(); }
});

test('disabling an account rolls back if session revocation fails', async () => {
  const { store, auth } = await fixture();
  try {
    const session = await auth.login('client', testUserId, testVault.credential, 1);
    store.db.exec("CREATE TEMP TRIGGER fail_revoke BEFORE DELETE ON auth_sessions BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    expect(() => auth.disable(testUserId)).toThrow();
    expect(new AccountRepository(store.db).get(testUserId)?.status).toBe('active');
    expect(auth.identity(new Request(origin, { headers: { cookie: 'taskpath_session=' + session.token } }))).toBe(testUserId);
  } finally { store.close(); }
});
