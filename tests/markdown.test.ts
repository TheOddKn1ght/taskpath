import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Store, statuses, type Task } from '../src/store';
import { exportMarkdown, parseMarkdown } from '../src/markdown';
import { createHandler } from '../src/server';
import { login, testAuth } from './auth-helpers';

let store: Store;
beforeEach(() => { store = new Store(':memory:', () => new Date('2026-09-03T10:00:00Z'), 'Europe/Moscow'); });
afterEach(() => store.close());

test('Markdown round trip preserves content, order, dates, categories, and dismissed reminders', () => {
  store.create({ title: 'Literal **markup** ~~strike~~ & <html> \\ newline\nand &#10; 12,', notes: 'Keep spacing\n\n\n- [ ] part of notes\n  indent\n```js\ncode\n```', status: 'week', category: 'work', dueDate: '2026-09-10' });
  store.create({ title: 'Second weekly task', status: 'week', reminderAt: '2026-09-10T12:00:00+03:00' });
  const task = store.create({ title: 'Dismissed reminder', status: 'today', reminderAt: '2026-09-03T09:00:00Z' });
  store.actOnReminder(task.id, { action: 'dismiss', reminderAt: task.reminderAt });
  store.create({ title: 'Finished', status: 'done', notes: 'こんにちは · Привет' });
  const original = store.board().tasks;
  const markdown = exportMarkdown(original);
  const parsed = parseMarkdown(markdown);
  expect(parsed.ignoredBlocks).toBe(0);
  expect(markdown).toContain('- [x] Finished');
  const copy = new Store(':memory:', () => new Date('2026-09-03T10:00:00Z'), 'Europe/Moscow');
  try {
    expect(copy.importTasks(parsed.tasks)).toEqual({ imported: 4, skipped: 0 });
    const content = (task: Task) => [task.title, task.notes, task.status, task.category, task.dueDate, task.reminderAt, task.reminderDismissedAt];
    for (const status of statuses) expect(copy.board().tasks.filter(t => t.status === status).map(content)).toEqual(original.filter(t => t.status === status).map(content));
    expect(copy.board().reminders).toHaveLength(0);
    expect(copy.previewImport(parsed.tasks)).toEqual({ tasks: [], skipped: 4 });
  } finally { copy.close(); }
});

test('Bun parses headings, nested task lists, entities, links, and completed tasks', () => {
  const { tasks } = parseMarkdown('\uFEFF## This Week\r\n\r\n* [ ] **Draft** &amp; review\r\n  - Category: Work\r\n  - Due: 2026-09-10\r\n  > Keep these notes\r\n\r\n- [X] Finished\n  - [ ] Nested task\n\nToday\n=====\n\n1. [ ] [Read](https://example.com)\n\n## Other heading\n- [ ] Inbox item');
  expect(tasks).toHaveLength(5);
  expect(tasks[0]).toMatchObject({ title: 'Draft & review', category: 'work', status: 'week', dueDate: '2026-09-10', notes: 'Keep these notes' });
  expect(tasks[1]).toMatchObject({ title: 'Finished', status: 'done' });
  expect(tasks[2]).toMatchObject({ title: 'Nested task', status: 'week' });
  expect(tasks[3]).toMatchObject({ title: 'Read (https://example.com)', status: 'today' });
  expect(tasks[4]).toMatchObject({ title: 'Inbox item', status: 'later' });
});

test('code blocks, HTML blocks, and quoted checklists are not imported as tasks', () => {
  const parsed = parseMarkdown('A document\n\n```md\n- [ ] Code example\n```\n\n<!--\n- [ ] Hidden\n-->\n\n> - [ ] Quoted example\n\n- [ ] Real task');
  expect(parsed.tasks.map(task => task.title)).toEqual(['Real task']);
  expect(parsed.ignoredBlocks).toBeGreaterThan(0);
});

test('preview writes nothing and import appends once, skipping duplicates in the file and board', () => {
  const existing = store.create({ title: 'Existing', status: 'week' });
  const tasks = parseMarkdown('## This Week\n- [ ] Existing\n- [ ] New task\n- [ ] New task').tasks;
  expect(store.previewImport(tasks)).toMatchObject({ skipped: 2, tasks: [{ title: 'New task' }] });
  expect(store.board().tasks.map(task => task.id)).toEqual([existing.id]);
  expect(store.importTasks(tasks)).toEqual({ imported: 1, skipped: 2 });
  expect(store.board().tasks.map(task => task.title)).toEqual(['Existing', 'New task']);
  expect(store.importTasks(tasks)).toEqual({ imported: 0, skipped: 3 });
});

test('invalid metadata and oversized imports fail without partial writes', () => {
  const existing = store.create({ title: 'Keep me' });
  for (const text of [
    '- [ ] Good\n- [ ] Bad\n  - Due: 2026-02-30',
    '- [ ] Good\n- [ ] Bad\n  - Category: unknown',
    '- [ ] Good\n- [ ] Bad\n  - Reminder: 2026-09-03T10:00:00',
    '- [ ] Bad\n  - Reminder dismissed: 2026-09-03T10:00:00Z',
    '- [ ] Bad\n  - Due: 2026-09-10\n  - Due: 2026-09-11',
    'No checklist here',
    '- [ ] ' + 'x'.repeat(241),
    '- [ ] ' + 'x'.repeat(256 * 1024),
    Array.from({ length: 501 }, (_, i) => `- [ ] Task ${i}`).join('\n'),
  ]) expect(() => store.importTasks(parseMarkdown(text).tasks)).toThrow();
  expect(store.board().tasks.map(task => task.id)).toEqual([existing.id]);
});

test('a storage failure rolls back every inserted task', () => {
  store.db.exec("CREATE TRIGGER reject_bad_task BEFORE INSERT ON tasks WHEN NEW.title = 'Fail here' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  expect(() => store.importTasks(parseMarkdown('- [ ] First\n- [ ] Fail here').tasks)).toThrow();
  expect(store.board().tasks).toEqual([]);
});

test('Markdown endpoints require authentication and same-origin JSON requests', async () => {
  const handle = createHandler(store, testAuth, 'https://tasks.example.com');
  const { cookie } = await login(handle);
  const post = (path: string, origin = 'https://tasks.example.com', session = cookie, markdown = '- [ ] Imported', type = 'application/json') => handle(new Request(`http://localhost:3000${path}`, {
    method: 'POST', headers: { 'Content-Type': type, origin, cookie: session }, body: JSON.stringify({ markdown }),
  }));
  expect((await handle(new Request('http://localhost:3000/api/export?format=markdown'))).status).toBe(401);
  for (const path of ['/api/import/preview', '/api/import/markdown']) {
    expect((await post(path, 'https://tasks.example.com', '')).status).toBe(401);
    expect((await post(path, 'https://evil.example')).status).toBe(403);
    expect((await post(path, undefined, undefined, undefined, 'text/plain')).status).toBe(415);
  }
  expect((await post('/api/import/preview')).status).toBe(200);
  expect(store.board().tasks).toEqual([]);
  expect((await post('/api/import/markdown')).status).toBe(201);
  const exported = await handle(new Request('http://localhost:3000/api/export?format=markdown', { headers: { cookie } }));
  expect(exported.headers.get('content-type')).toContain('text/markdown');
  expect(exported.headers.get('content-disposition')).toContain('.md');
  expect(await exported.text()).toContain('- [ ] Imported');
});

test('imports accept files above the normal API limit while ordinary writes stay bounded', async () => {
  const handle = createHandler(store);
  const post = (path: string, body: object) => handle(new Request(`http://localhost:3000${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const markdown = Array.from({ length: 100 }, (_, i) => `- [ ] Task ${i}\n  > ${'Notes '.repeat(100)}\n`).join('\n');
  expect(Buffer.byteLength(markdown)).toBeGreaterThan(32768);
  expect((await post('/api/import/markdown', { markdown })).status).toBe(201);
  expect(store.board().tasks).toHaveLength(100);
  expect((await post('/api/tasks', { title: 'Too large', notes: 'x'.repeat(40000) })).status).toBe(413);
});
