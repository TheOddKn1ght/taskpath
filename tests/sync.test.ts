import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { fixture, testVault, login, request } from './auth-helpers';
import { encryptChange, decryptEnvelope } from '../public/crypto.js';
import { acceptEncrypted } from '../public/offline.js';
import { ClientStore } from './client-helpers';
const time = new Date('2026-09-08T12:00:00Z');
const client = () => new ClientStore(':memory:', () => time);
const encrypt = (change: any) => encryptChange(testVault.key, testVault.config.vaultId, change);
const decode = (row: any) => decryptEnvelope(testVault.key, testVault.config.vaultId, row);
const input = (changes: any[]) => ({ workspaceKey: testVault.config.vaultId, changes });

test('encrypted edits, tags, moves, completion, deletion/undo, and immutable retries persist across reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-e2ee-')); const path = join(directory, 'vault.sqlite');
  let store: Store | undefined;
  try {
    ({ store } = await fixture(path, () => time));
    const device = client();
    const a = device.create({ title: 'DISTINCTIVE_PRIVATE_TASK', notes: 'DISTINCTIVE_SECRET_NOTE', tags: ['HOME'], status: 'week' });
    const b = device.create({ title: 'Second', status: 'week' });
    device.update(b.id, { beforeId: a.id }); device.update(a.id, { status: 'done', tags: ['Home', 'errands'] }); device.remove(a.id); device.restore(a.id);
    const encrypted = await Promise.all(device.record.pending.map(encrypt));
    const snapshot = JSON.stringify(encrypted);
    const response = store.sync(input(encrypted));
    expect(response.acknowledged).toHaveLength(encrypted.length);
    expect(store.sync(input(encrypted)).changed).toBe(false);
    expect(JSON.stringify(encrypted)).toBe(snapshot);
    expect(JSON.stringify(response)).not.toContain(a.title);
    expect(await decode(response.rows.find((e: any) => e.taskId === a.id))).toMatchObject({ title: a.title, tags: ['errands', 'home'], deletedAt: null, status: 'done' });
    store.close(); store = new Store(path, () => time);
    expect(store.syncBoard().rows).toHaveLength(2);
    const bytes = readFileSync(path).toString();
    for (const secret of [a.title, a.notes, testVault.credential, 'correct horse battery staple']) expect(bytes).not.toContain(secret);
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name='tasks'").get()).toBeNull();
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('whole-task latest edit wins; equal timestamps use operation IDs; encrypted tombstones reject stale edits', async () => {
  const { store } = await fixture(':memory:', () => time);
  try {
    const device = client(), task = device.create({ title: 'Original', tags: ['old'] });
    const base = device.record.pending[0];
    const change = async (title: string, editedAt: string, changeId: string, extra = {}) => encrypt({ ...base, changeId, editedAt, task: { ...task, title, tags: [title.toLowerCase()], ...extra, updatedAt: editedAt } });
    const newer = await change('New', '2026-09-08T12:01:00.000Z', 'z');
    const older = await change('Old', '2026-09-08T12:00:30.000Z', 'x');
    store.sync(input([newer])); expect(store.sync(input([older])).conflicts).toBe(1);
    const tie = await change('Tie', newer.editedAt, 'a'); store.sync(input([tie]));
    expect(await decode(store.syncBoard().rows[0])).toMatchObject({ title: 'New', tags: ['new'] });
    const tombstone = await change('Deleted', '2026-09-08T12:02:00.000Z', 'delete', { deletedAt: '2026-09-08T12:02:00.000Z' });
    store.sync(input([tombstone])); store.sync(input([newer]));
    expect((await decode(store.syncBoard().rows[0])).deletedAt).not.toBeNull();
  } finally { store.close(); }
});
test('acknowledgements preserve concurrent new edits and late snapshots cannot roll back accepted ciphertext', async () => {
  const { store } = await fixture(':memory:', () => time);
  try {
    const device = client(), task = device.create({ title: 'First' });
    const first = await encrypt(device.record.pending[0]);
    const local: any = { config: testVault.config, pending: [first], board: null, lastEdit: 0 };
    const response = store.sync(input([first]));
    device.update(task.id, { title: 'Second' });
    const second = await encrypt(device.record.pending[1]); local.pending.push(second);
    acceptEncrypted(local, response, time.getTime());
    expect(local.pending).toEqual([second]);
    acceptEncrypted(local, store.sync(input([second])), time.getTime());
    acceptEncrypted(local, response, time.getTime());
    expect(local.pending).toEqual([]);
    expect((await decode(local.board.rows[0])).title).toBe('Second');
    const before = JSON.stringify(local);
    expect(() => acceptEncrypted(local, { ...response, workspaceKey: 'another' })).toThrow();
    expect(JSON.stringify(local)).toBe(before);
  } finally { store.close(); }
});
test('invalid envelopes, legacy plaintext, oversized batches, future clocks and workspace mismatch fail atomically', async () => {
  const { store, handle } = await fixture(':memory:', () => time);
  try {
    const device = client(); device.create({ title: 'Keep' }); const encrypted = await encrypt(device.record.pending[0]);
    for (const changes of [[encrypted, device.record.pending[0]], Array(51).fill(encrypted), [{ ...encrypted, nonce: 'bad' }], [{ ...encrypted, editedAt: '2099-01-01T00:00:00.000Z' }]]) expect(() => store.sync(input(changes))).toThrow();
    expect(store.syncBoard().rows).toEqual([]);
    const { cookie } = await login(handle);
    expect((await request(handle, cookie, '/api/sync', { ...input([]), workspaceKey: 'other' })).status).toBe(409);
    expect((await request(handle, cookie, '/api/sync', input([encrypted]), 'https://evil.example')).status).toBe(403);
    expect((await request(handle, cookie, '/api/sync', input([encrypted]))).status).toBe(200);
  } finally { store.close(); }
});
test('legacy databases of every plaintext schema version are rejected without changing any bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-legacy-'));
  try {
    for (const version of [1, 2, 3]) {
      const path = join(directory, `legacy-${version}.sqlite`), legacy = new Database(path);
      legacy.exec(`CREATE TABLE tasks (id TEXT, title TEXT); INSERT INTO tasks VALUES ('id', 'keep my plaintext'); PRAGMA user_version=${version};`);
      legacy.close(); const before = readFileSync(path);
      expect(() => new Store(path)).toThrow('Legacy');
      expect(readFileSync(path)).toEqual(before);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('opaque reminder claims are atomic across devices and reveal no schedule or content', async () => {
  const { store, handle } = await fixture();
  try {
    const { cookie } = await login(handle); const token = crypto.randomUUID();
    const results = await Promise.all([request(handle, cookie, '/api/reminders/claim', { tokens: [token] }), request(handle, cookie, '/api/reminders/claim', { tokens: [token] })]);
    const claims = await Promise.all(results.map(r => r.json()));
    expect(claims.flatMap(r => r.tokens)).toEqual([token]);
    expect((await request(handle, '', '/api/reminders/claim', { tokens: [token] })).status).toBe(401);
    expect((await request(handle, cookie, '/api/reminders/claim', { tokens: [token] }, 'https://evil.example')).status).toBe(403);
    expect((await request(handle, cookie, '/api/reminders/claim', { taskId: 'plaintext' })).status).toBe(400);
    expect(store.db.query('SELECT * FROM reminder_claims').all()).toEqual([{ token }]);
  } finally { store.close(); }
});
test('client reminder tokens persist for unrelated edits; snooze and rescheduling rearm while stale actions fail', () => {
  const device = client(), task = device.create({ title: 'Reminder', reminderAt: '2026-09-08T11:59:00Z', tags: ['home'] });
  const edited = device.update(task.id, { notes: 'Same schedule', reminderAt: task.reminderAt });
  expect(edited.reminderToken).toBe(task.reminderToken);
  const snoozed = device.actOnReminder(task.id, { action: 'snooze', reminderAt: task.reminderAt });
  expect(snoozed.reminderToken).not.toBe(task.reminderToken); expect(snoozed.tags).toEqual(['home']);
  expect(() => device.actOnReminder(task.id, { action: 'dismiss', reminderAt: task.reminderAt })).toThrow();
  device.actOnReminder(task.id, { action: 'dismiss', reminderAt: snoozed.reminderAt });
  expect(device.board().reminders).toEqual([]);
  expect(device.update(task.id, { reminderAt: '2026-09-08T12:15:00Z' }).reminderDismissedAt).toBeNull();
});
test('omitted tags preserve existing values and explicit empty arrays clear them in offline edits', () => {
  const device = client(), task = device.create({ title: 'Tagged', tags: ['HOME'] });
  expect(device.update(task.id, { status: 'today' }).tags).toEqual(['home']);
  expect(() => device.update(task.id, { tags: null })).toThrow();
  expect(device.update(task.id, { tags: [] }).tags).toEqual([]);
});
