import { test, expect } from 'bun:test';
import { ClientStore, statuses } from './client-helpers';
import { queueChange, queueArchiveBatch, project, validate } from '../public/offline-model.js';
import { exportMarkdown, parseMarkdown } from '../public/markdown.js';
import { fixture, testVault, testUserId } from './auth-helpers';
import type { Envelope } from '../public/types.js';
async function decryptedTask(row: Envelope) { const task = await decryptEnvelope(testVault.key, testVault.config.vaultId, row); validate(task); return task; }
import { encryptChange, decryptEnvelope } from '../public/crypto.js';
const start = new Date('2026-09-08T12:00:00Z');
const change = (s: ClientStore, id: string, action: string) => queueChange(s.record, `/api/tasks/${id}/${action}`, 'POST', {}, s.now().getTime());

test('all columns archive without changing contents and restore to the end of their column', () => {
  for (const status of statuses) {
    const s = new ClientStore(':memory:', () => start);
    const task = s.create({ title: 'Keep', status, notes: 'Details', tags: ['home'], dueDate: '2026-09-10' });
    const archived = change(s, task.id, 'archive').task;
    expect(archived).toMatchObject({ ...task, archivedAt: archived.updatedAt, updatedAt: archived.updatedAt });
    const peer = s.create({ title: 'Peer', status });
    expect(() => s.update(task.id, { title: 'Not allowed' })).toThrow('Restore');
    expect(() => s.update(peer.id, { beforeId: task.id })).toThrow('drop target');
    const restored = change(s, task.id, 'unarchive').task;
    expect(restored).toMatchObject({ status, archivedAt: null, completedAt: task.completedAt, notes: task.notes, tags: task.tags });
    expect(restored.position).toBeGreaterThan(peer.position);
  }
});

test('archived planning is frozen; restoring applies day and week rollover', () => {
  let now = start;
  const s = new ClientStore(':memory:', () => now);
  const today = s.create({ title: 'Today', status: 'today' }), week = s.create({ title: 'Week', status: 'week' });
  change(s, today.id, 'archive'); change(s, week.id, 'archive');
  now = new Date('2026-09-09T12:00:00Z');
  expect(s.board().tasks.find(t => t.id === today.id)!.status).toBe('today');
  expect(change(s, today.id, 'unarchive').task.status).toBe('week');
  change(s, today.id, 'archive'); now = new Date('2026-09-14T12:00:00Z');
  expect(change(s, today.id, 'unarchive').task.status).toBe('later');
  expect(change(s, week.id, 'unarchive').task.status).toBe('later');
});

test('archive pauses reminders and deletion undo preserves archive state', () => {
  const s = new ClientStore(':memory:', () => start);
  const task = s.create({ title: 'Reminder', reminderAt: '2026-09-08T11:00:00Z' });
  expect(s.board().reminders).toHaveLength(1);
  const archived = change(s, task.id, 'archive').task;
  expect(s.board().reminders).toHaveLength(0);
  expect(() => s.actOnReminder(task.id, { action: 'snooze', reminderAt: task.reminderAt })).toThrow('Restore');
  s.remove(task.id); expect(s.board().tasks).toHaveLength(0);
  expect(s.restore(task.id).archivedAt).toBe(archived.archivedAt);
  const restored = change(s, task.id, 'unarchive').task;
  expect(restored.reminderToken).toBe(task.reminderToken);
  expect(s.board().reminders).toHaveLength(1);
  s.actOnReminder(task.id, { action: 'dismiss', reminderAt: task.reminderAt });
  change(s, task.id, 'archive'); change(s, task.id, 'unarchive');
  expect(s.board().reminders).toHaveLength(0);
});

test('batch archiving and Undo skip intervening edits, deletions, and replacement operation IDs', () => {
  const s = new ClientStore(':memory:', () => start);
  const tasks = Array.from({ length: 4 }, (_, n) => s.create({ title: `Done ${n}`, status: 'done' }));
  const active = s.create({ title: 'Active' });
  const batch = queueArchiveBatch(s.record, 'completed', {}, start.getTime());
  expect(batch.archived).toBe(4);
  expect(s.board().tasks.find(t => t.id === active.id)!.archivedAt).toBeNull();
  change(s, tasks[0].id, 'unarchive'); s.update(tasks[0].id, { title: 'New edit' });
  s.remove(tasks[1].id);
  // A same-timestamp remote operation supersedes a locally archived snapshot.
  s.record.pending.findLast(c => c.task.id === tasks[2].id)!.changeId = 'remote-operation';
  const undone = queueArchiveBatch(s.record, 'undo', { undo: batch.undo }, start.getTime());
  expect(undone).toMatchObject({ restored: 1, skipped: 3 });
  expect(s.board().tasks.find(t => t.id === tasks[0].id)!.title).toBe('New edit');
  expect(queueArchiveBatch(s.record, 'undo', { undo: batch.undo }, start.getTime()).restored).toBe(0);
});

test('legacy ciphertext projections stay immutable; Markdown preserves and validates archive state', () => {
  const s = new ClientStore(':memory:', () => start);
  const task = s.create({ title: 'Legacy', status: 'done', notes: 'Keep', tags: ['archive'] });
  Reflect.deleteProperty(s.record.pending[0].task, 'archivedAt');
  const before = JSON.stringify(s.record.pending);
  expect(project(s.record, start.getTime()).tasks[0].archivedAt).toBeNull();
  expect(JSON.stringify(s.record.pending)).toBe(before);
  const archived = change(s, task.id, 'archive').task;
  const md = exportMarkdown(s.board().tasks);
  expect(md).toContain(`Archived: ${archived.archivedAt}`);
  const imported = new ClientStore(':memory:', () => start);
  imported.importTasks(parseMarkdown(md).tasks);
  expect(imported.board().tasks[0]).toMatchObject({ title: task.title, status: 'done', archivedAt: archived.archivedAt });
  expect(imported.previewImport(parseMarkdown(md).tasks).skipped).toBe(1);
  expect(imported.previewImport([{ ...task, archivedAt: null }]).skipped).toBe(0);
  expect(() => imported.previewImport(parseMarkdown(md.replace(archived.archivedAt!, 'invalid')).tasks)).toThrow();
  expect(() => parseMarkdown(md.replace(`  - Archived: ${archived.archivedAt}`, '  - Archived: x\n  - Archived: y'))).toThrow('duplicate');
  expect(() => validate({ ...task, archivedAt: false })).toThrow();
});

test('encrypted archive retries and conflicts survive sync, with Undo after acknowledgement', async () => {
  const { store } = await fixture(':memory:', () => start);
  try {
    const s = new ClientStore(':memory:', () => start), task = s.create({ title: 'PRIVATE_ARCHIVE_MARKER' });
    const old = await encryptChange(testVault.key, testVault.config.vaultId, s.record.pending[0]);
    const receipt = change(s, task.id, 'archive').undo;
    const encrypted = await encryptChange(testVault.key, testVault.config.vaultId, s.record.pending.at(-1)!);
    const bytes = JSON.stringify(encrypted), input = { workspaceKey: testVault.config.vaultId, changes: [encrypted] };
    store.sync(testUserId, input); expect(store.sync(testUserId, input).changed).toBe(false);
    expect(store.sync(testUserId, { ...input, changes: [old] }).conflicts).toBe(1);
    expect(JSON.stringify(encrypted)).toBe(bytes); expect(bytes).not.toContain(task.title); expect(bytes).not.toContain('archivedAt');
    const response = store.syncBoard(testUserId), row = response.rows[0];
    s.record.pending = []; s.record.board = { ...response, rows: [await decryptedTask(row)], changeIds: { [task.id]: row.changeId } };
    expect(queueArchiveBatch(s.record, 'undo', { undo: receipt }, start.getTime()).restored).toBe(1);
    const restored = await encryptChange(testVault.key, testVault.config.vaultId, s.record.pending.at(-1)!);
    store.sync(testUserId, { ...input, changes: [restored] });
    expect(await decryptEnvelope(testVault.key, testVault.config.vaultId, store.syncBoard(testUserId).rows[0])).toMatchObject({ archivedAt: null, title: task.title });
  } finally { store.close(); }
});
