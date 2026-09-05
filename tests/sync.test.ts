import { beforeEach, afterEach, test, expect } from 'bun:test';
import { Store } from '../src/store';
import { createHandler } from '../src/server';
import { login, testAuth } from './auth-helpers';
import { project, queueChange, acceptSync } from '../public/offline-model.js';
let now: Date, store: Store;
beforeEach(() => { now = new Date('2026-09-05T12:00:00Z'); store = new Store(':memory:', () => now, 'Europe/Moscow'); });
afterEach(() => store.close());
const snapshot = () => ({ ...store.syncBoard(), workspaceKey: 'test-workspace' });
const device = () => ({ board: snapshot(), pending: [] as any[], offset: 0, lastEdit: 0 });
const edit = (task: any, title: string, time: string, changeId = crypto.randomUUID()) => ({ task: { ...task, title, updatedAt: time }, editedAt: time, changeId });

test('newer offline edit wins regardless of arrival order, equal times have a stable tie-break', () => {
  const task = store.create({ title: 'Initial' });
  now = new Date('2026-09-05T12:05:00Z');
  const newer = edit(task, 'Newest', '2026-09-05T12:04:00Z');
  store.sync({ changes: [newer] });
  expect(store.sync({ changes: [edit(task, 'Old', '2026-09-05T12:02:00Z')] }).conflicts).toBe(1);
  expect(store.board().tasks[0].title).toBe('Newest');
  store.sync({ changes: [edit(task, 'Tie Z', '2026-09-05T12:04:30Z', 'z')] });
  store.sync({ changes: [edit(task, 'Tie A', '2026-09-05T12:04:30Z', 'a')] });
  expect(store.board().tasks[0].title).toBe('Tie Z');
});
test('tombstones suppress stale edits and newer edits can restore a task', () => {
  const task = store.create({ title: 'Initial' });
  now = new Date('2026-09-05T12:05:00Z');
  store.sync({ changes: [{ ...edit(task, 'Initial', '2026-09-05T12:03:00Z'), task: { ...task, deletedAt: '2026-09-05T12:03:00Z' } }] });
  store.sync({ changes: [edit(task, 'Old', '2026-09-05T12:02:00Z')] });
  expect(store.board().tasks).toHaveLength(0);
  expect(store.syncBoard().rows).toHaveLength(1);
  store.sync({ changes: [edit(task, 'New', '2026-09-05T12:04:00Z')] });
  expect(store.board().tasks[0].title).toBe('New');
});
test('create retry after a lost response is idempotent; invalid batches roll back', () => {
  const local = device(); queueChange(local, '/api/tasks', 'POST', { title: 'Offline' }, now.getTime());
  const operation = local.pending[0];
  store.sync({ changes: [operation] }); store.sync({ changes: [operation] });
  expect(store.board().tasks).toHaveLength(1);
  expect(() => store.sync({ changes: [edit(operation.task, 'Changed', '2026-09-05T12:01:00Z'), { ...operation, task: { ...operation.task, title: '' } }] })).toThrow();
  expect(store.board().tasks[0].title).toBe('Offline');
});
test('acknowledgements never discard an edit queued while a request is in flight', () => {
  const task = store.create({ title: 'Initial' }); const local = device();
  queueChange(local, `/api/tasks/${task.id}`, 'PATCH', { title: 'First' }, now.getTime() + 1000);
  const response = { ...store.sync({ changes: [...local.pending] }), workspaceKey: 'test-workspace' };
  queueChange(local, `/api/tasks/${task.id}`, 'PATCH', { title: 'Second' }, now.getTime() + 2000);
  acceptSync(local, response, now.getTime());
  expect(local.pending).toHaveLength(1);
  expect(project(local, now.getTime()).tasks[0].title).toBe('Second');
});
test('rollover does not override offline edit timestamps or replan old Today tasks', () => {
  const task = store.create({ title: 'Daily', status: 'today' }); const local = device();
  queueChange(local, `/api/tasks/${task.id}`, 'PATCH', { title: 'Edited Saturday' }, now.getTime() + 1000);
  now = new Date('2026-09-07T12:00:00Z');
  const response = store.sync({ changes: local.pending });
  expect(response.tasks[0]).toMatchObject({ title: 'Edited Saturday', status: 'later', updatedAt: '2026-09-05T12:00:01.000Z' });
});
test('offline creation, move, date changes, deletion and undo round-trip to SQLite', () => {
  const local = device(); const time = now.getTime();
  const a = queueChange(local, '/api/tasks', 'POST', { title: 'A', status: 'week' }, time).task;
  const b = queueChange(local, '/api/tasks', 'POST', { title: 'B', status: 'week' }, time).task;
  queueChange(local, `/api/tasks/${b.id}`, 'PATCH', { beforeId: a.id, dueDate: '2026-09-10', reminderAt: '2026-09-06T09:00:00Z' }, time);
  queueChange(local, `/api/tasks/${a.id}`, 'DELETE', {}, time);
  expect(project(local, time).tasks).toHaveLength(1);
  queueChange(local, `/api/tasks/${a.id}/restore`, 'POST', {}, time);
  expect(store.sync({ changes: local.pending }).tasks.map(t => t.title)).toEqual(['B', 'A']);
  expect(store.board().tasks[0].dueDate).toBe('2026-09-10');
});
test('sync routes require a session, same-origin writes, and matching workspace identity', async () => {
  const handle = createHandler(store, testAuth, 'https://tasks.example.com');
  expect((await handle(new Request('http://localhost/api/sync'))).status).toBe(401);
  const { cookie } = await login(handle);
  const response = await handle(new Request('http://localhost/api/sync', { headers: { cookie } }));
  const board = await response.json();
  const post = (origin: string, workspaceKey: string) => handle(new Request('http://localhost/api/sync', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ changes: [], workspaceKey }) }));
  expect((await post('https://evil.example', board.workspaceKey)).status).toBe(403);
  expect((await post('https://tasks.example.com', 'wrong')).status).toBe(409);
  expect((await post('https://tasks.example.com', board.workspaceKey)).status).toBe(200);
});
test('workspace mismatch preserves the queue and future clocks are rejected', () => {
  const local = device(); queueChange(local, '/api/tasks', 'POST', { title: 'Safe' }, now.getTime());
  expect(() => acceptSync(local, { ...snapshot(), workspaceKey: 'other' })).toThrow();
  expect(local.pending).toHaveLength(1);
  expect(() => store.sync({ changes: [{ ...local.pending[0], editedAt: '2099-01-01T00:00:00Z' }] })).toThrow();
  expect(store.board().tasks).toHaveLength(0);
});

test('reordering still works between equal ranks from concurrent offline inserts', () => {
  const a = store.create({ title: 'A', status: 'week' });
  const b = store.create({ title: 'B', status: 'week' });
  const c = store.create({ title: 'C', status: 'week' });
  // Equal ranks are ordered by creation date, then ID; keep the intended anchor stable.
  store.db.query('UPDATE tasks SET position = 0, createdAt = ? WHERE id = ?').run('2026-09-05T12:00:00.001Z', b.id);
  const local = device();
  queueChange(local, `/api/tasks/${c.id}`, 'PATCH', { beforeId: b.id }, now.getTime() + 1000);
  expect(project(local, now.getTime()).tasks.map(t => t.title)).toEqual(['A', 'C', 'B']);
  expect(store.sync({ changes: local.pending }).tasks.map(t => t.title)).toEqual(['A', 'C', 'B']);
});
