import { expect, test } from 'bun:test';
import { retainVersions } from '../public/task-history';
import { acceptEncrypted } from '../public/offline';
import { encryptChange, decryptEnvelope } from '../public/crypto';
import { autoLockExpired } from '../public/auto-lock-settings';
import { ClientStore } from './client-helpers';
import { testVault } from './auth-helpers';
import type { EncryptedRecord, Envelope } from '../public/types';

const envelope = (taskId: string, index: number): Envelope => ({version: 1, vaultId: 'vault', taskId, editedAt: new Date(index * 1000).toISOString(), changeId: taskId + '-' + index, nonce: '', ciphertext: 'x'.repeat(200)});
test('version history bounds per task, total size, and excludes profile records', () => {
  const versions = Array.from({length: 210}, (_, i) => envelope('task-' + i, i));
  expect(retainVersions([], versions)).toHaveLength(200);
  const repeated = Array.from({length: 8}, (_, i) => envelope('one', i));
  expect(retainVersions(repeated, [repeated[7], envelope('_profile', 99)])).toEqual(repeated.slice(3).reverse());
  expect(retainVersions([], versions.map(e => ({...e, ciphertext: 'x'.repeat(60000)}))).length).toBe(33);
});
test('rejected offline edits and replaced server versions remain decryptable without plaintext persistence', async () => {
  const device = new ClientStore(':memory:', () => new Date('2026-09-08T12:00:00Z'));
  const task = device.create({title: 'PRIVATE_BASE', notes: 'PRIVATE_NOTE'});
  const base = await encryptChange(testVault.key, testVault.config.vaultId, device.record.pending[0]);
  const at = '2026-09-08T12:02:00.000Z';
  const winner = await encryptChange(testVault.key, testVault.config.vaultId, {task: {...task, title: 'REMOTE_WINNER', updatedAt: at}, editedAt: at, changeId: 'remote'});
  const record: EncryptedRecord = {revision: 0, lockEpoch: 0, config: testVault.config, board: {format: 1, workspaceKey: testVault.config.vaultId, timezone: 'UTC', serverTime: at, rows: [base]}, pending: [base], offset: 0, lastEdit: 0};
  const response = {format: 1, workspaceKey: testVault.config.vaultId, timezone: 'UTC', serverTime: at, rows: [winner], acknowledged: [base.changeId], conflicts: 1};
  acceptEncrypted(record, response);
  expect(record.pending).toHaveLength(0);
  expect(record.history).toHaveLength(1);
  expect(await decryptEnvelope(testVault.key, testVault.config.vaultId, record.history![0])).toMatchObject({title: 'PRIVATE_BASE', notes: 'PRIVATE_NOTE'});
  expect(JSON.stringify(record)).not.toContain('PRIVATE_BASE');
  expect(JSON.stringify(record)).not.toContain('PRIVATE_NOTE');
  acceptEncrypted(record, response);
  expect(record.history).toHaveLength(1);
});
test('calendar rollover identifies only unfinished moved tasks and excludes deleted/archive/reminder-today tasks', () => {
  let now = new Date('2026-09-08T12:00:00Z');
  const device = new ClientStore(':memory:', () => now);
  const today = device.create({title: 'yesterday', status: 'today'});
  const removed = device.create({title: 'deleted', status: 'today'}); device.remove(removed.id);
  const done = device.create({title: 'done', status: 'done'});
  const archived = device.create({title: 'archive', status: 'today', archivedAt: now.toISOString()});
  const reminder = device.create({title: 'reminder', status: 'today', reminderAt: '2026-09-09T19:00:00.000Z'});
  now = new Date('2026-09-09T12:00:00Z');
  expect(device.board().rollover).toEqual([{id: today.id, from: 'today', to: 'week'}]);
  expect(device.board().tasks.find(t => t.id === reminder.id)?.status).toBe('today');
  expect(device.board().tasks.find(t => t.id === done.id)?.status).toBe('done');
  expect(device.board().tasks.find(t => t.id === archived.id)?.archivedAt).toBeTruthy();
  device.update(today.id, {status: 'week'});
  expect(device.board().rollover).toEqual([]);
  now = new Date('2026-09-14T12:00:00Z');
  expect(device.board().rollover).toContainEqual({id: today.id, from: 'week', to: 'later'});
});
test('automatic locking includes elapsed background time and never locks when disabled', () => {
  expect(autoLockExpired(60_999, 1000, 1)).toBe(false);
  expect(autoLockExpired(61_000, 1000, 1)).toBe(true);
  expect(autoLockExpired(3_600_000, 1000, 5)).toBe(true);
  expect(autoLockExpired(3_600_000, 1000, 0)).toBe(false);
});
