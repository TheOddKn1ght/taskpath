import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { normalizeTags, importTaskKey } from '../public/tags.js';
import { project, queueChange, acceptSync } from '../public/offline-model.js';
import { exportMarkdown, parseMarkdown } from '../src/markdown';
import { createHandler } from '../src/server';

const time = '2026-09-08T12:00:00.000Z';
const makeStore = () => new Store(':memory:', () => new Date(time), 'UTC');

test('shared tag normalization handles Unicode, duplicates, limits and invalid inputs', () => {
  expect(normalizeTags([' HOME ', 'cafe\u0301', 'CAFÉ', 'Home', 'two words'])).toEqual(['café', 'home', 'two words']);
  expect(normalizeTags(['😀'.repeat(32)])).toHaveLength(1);
  for (const tags of [null, 'home', [null], [''], [' \t '], ['a\nb'], ['x\u007fy'], ['a'.repeat(33)], Array.from({ length: 11 }, (_, i) => `tag${i}`)]) {
    expect(() => normalizeTags(tags)).toThrow();
  }
  expect(normalizeTags(Array(20).fill('home'))).toEqual(['home']);
});

test('v2 migration preserves data and tags survive reopening SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-tags-'));
  const path = join(directory, 'tasks.sqlite');
  let store = new Store(path);
  try {
    const task = store.create({ title: 'Existing', category: 'work', status: 'later', notes: 'Keep', dueDate: '2026-10-01' });
    const original = { ...task }; delete (original as any).tags;
    store.close();
    const old = new Database(path);
    old.exec('ALTER TABLE tasks DROP COLUMN tags; PRAGMA user_version = 2;');
    old.close();
    store = new Store(path);
    expect(store.board().tasks[0]).toEqual({ ...original, tags: [] });
    expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    store.update(task.id, { tags: ['Home', ' Errands '] });
    store.close();
    store = new Store(path);
    expect(store.board().tasks[0].tags).toEqual(['errands', 'home']);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP task writes expose arrays, preserve omitted tags, clear explicit empty tags and reject invalid ones', async () => {
  const store = makeStore();
  try {
    const handle = createHandler(store);
    const request = async (path: string, method: string, input: unknown) => handle(new Request(`http://localhost${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }));
    const created = await request('/api/tasks', 'POST', { title: 'Tagged', tags: ['HOME'] });
    expect(created!.status).toBe(201);
    const { task } = await created!.json() as any;
    expect(task.tags).toEqual(['home']);
    expect((await (await request(`/api/tasks/${task.id}`, 'PATCH', { status: 'today' }))!.json() as any).task.tags).toEqual(['home']);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { tags: null }))!.status).toBe(400);
    expect((await (await request(`/api/tasks/${task.id}`, 'PATCH', { tags: [] }))!.json() as any).task.tags).toEqual([]);
  } finally { store.close(); }
});

test('tags survive task lifecycle, reminders and calendar rollover', () => {
  const store = makeStore();
  try {
    const task = store.create({ title: 'Tagged', tags: ['home'], status: 'today', reminderAt: time });
    expect(store.claimReminders()[0].tags).toEqual(['home']);
    expect(store.actOnReminder(task.id, { action: 'snooze', reminderAt: time }).tags).toEqual(['home']);
    store.update(task.id, { status: 'done' });
    store.remove(task.id);
    expect(store.restore(task.id).tags).toEqual(['home']);
    store.update(task.id, { status: 'today' });
    store.db.query("UPDATE tasks SET plannedWeek = '2026-08-31'").run();
    expect(store.board().tasks[0]).toMatchObject({ status: 'later', tags: ['home'] });
  } finally { store.close(); }
});

test('legacy pending changes preserve server tags without rewriting operation IDs or timestamps', () => {
  const store = makeStore();
  try {
    const task = store.create({ title: 'Existing', tags: ['home'] });
    const oldTask: any = { ...task, title: 'Offline legacy edit' }; delete oldTask.tags;
    const editedAt = '2026-09-08T12:01:00.000Z';
    const change = { task: oldTask, changeId: 'legacy', editedAt };
    const record = { board: store.syncBoard(), pending: [change], offset: 0 };
    const before = JSON.stringify(record.pending);
    expect(project(record).tasks[0].tags).toEqual(['home']);
    expect(JSON.stringify(record.pending)).toBe(before);
    expect(store.sync({ changes: [change] }).tasks[0]).toMatchObject({ title: 'Offline legacy edit', tags: ['home'] });
    expect(store.sync({ changes: [{ ...change, changeId: 'clear', editedAt: '2026-09-08T12:02:00.000Z', task: { ...oldTask, tags: [] } }] }).tasks[0].tags).toEqual([]);
    expect(store.sync({ changes: [change] }).tasks[0].tags).toEqual([]);
  } finally { store.close(); }
});

test('offline tag edits survive queued moves and deletion/undo, round-trip, and resolve whole-task conflicts', () => {
  const store = makeStore();
  try {
    const record: any = { board: { ...store.syncBoard(), workspaceKey: 'test' }, pending: [], offset: 0, lastEdit: 0 };
    const { task } = queueChange(record, '/api/tasks', 'POST', { title: 'Offline', tags: ['HOME'] }, Date.parse(time));
    queueChange(record, `/api/tasks/${task.id}`, 'PATCH', { tags: ['Errands', 'home'], status: 'week' }, Date.parse(time) + 1);
    queueChange(record, `/api/tasks/${task.id}`, 'DELETE', {}, Date.parse(time) + 2);
    queueChange(record, `/api/tasks/${task.id}/restore`, 'POST', {}, Date.parse(time) + 3);
    expect(project(record).tasks[0].tags).toEqual(['errands', 'home']);
    const response = store.sync({ changes: record.pending });
    acceptSync(record, { ...response, workspaceKey: 'test' });
    expect(record.pending).toEqual([]);
    expect(project(record).tasks[0].tags).toEqual(['errands', 'home']);
    const latest = { task: { ...response.tasks[0], title: 'Newer', tags: ['new'] }, changeId: 'newer', editedAt: '2026-09-08T12:02:00.000Z' };
    store.sync({ changes: [latest] });
    const older = { ...latest, task: { ...latest.task, tags: ['old'] }, changeId: 'older', editedAt: '2026-09-08T12:01:00.000Z' };
    expect(store.sync({ changes: [older] }).tasks[0]).toMatchObject({ title: 'Newer', tags: ['new'] });
  } finally { store.close(); }
});

test('Markdown tags round-trip punctuation and Unicode; deduplication includes normalized tags', () => {
  const store = makeStore();
  try {
    const task = store.create({ title: 'Tagged', tags: ['home', 'a,b', '"quoted"', '[x]', '<html>', 'café', '12,', '\\path'] });
    const markdown = exportMarkdown([task]);
    const parsed = parseMarkdown(markdown).tasks;
    expect(parsed[0].tags).toEqual(task.tags);
    expect(store.previewImport(parsed).skipped).toBe(1);
    expect(importTaskKey({ ...task, tags: ['HOME'] })).toBe(importTaskKey({ ...task, tags: ['home', 'home'] }));
    expect(importTaskKey({ ...task, tags: [] })).not.toBe(importTaskKey(task));
    expect(store.previewImport([{ title: 'Tagged', tags: ['different'] }]).tasks).toHaveLength(1);
    expect(store.previewImport(parseMarkdown('- [ ] Legacy').tasks).tasks[0].tags).toEqual([]);
    expect(parseMarkdown('- [ ] Test\n  - Tags: ["errands", "home"]').tasks[0].tags).toEqual(['errands', 'home']);
    for (const value of ['not json', '[null]', '[""]', '["too\\nfar"]']) expect(() => parseMarkdown(`- [ ] Test\n  - Tags: ${value}`)).toThrow();
    expect(() => parseMarkdown('- [ ] Test\n  - Tags: []\n  - Tags: []')).toThrow();
  } finally { store.close(); }
});
