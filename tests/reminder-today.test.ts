import { expect, test } from 'bun:test';
import { ClientStore } from './client-helpers';
import { project, queueChange, reminderIsToday, REMINDER_TODAY_MOVE_ERROR } from '../public/offline-model.js';
import { parseMarkdown, exportMarkdown } from '../public/markdown.js';

const noon = new Date('2026-09-03T10:00:00Z');
const laterToday = '2026-09-03T19:30:15.123Z';
const client = () => new ClientStore(':memory:', () => noon, 'Europe/Moscow');

test('today reminders immediately select Today without firing early; other dates and due dates stay independent', () => {
  const s = client();
  for (const status of ['later', 'week']) {
    expect(s.create({ title: status, status, reminderAt: laterToday })).toMatchObject({ status: 'today', plannedDay: '2026-09-03', plannedWeek: '2026-08-31', reminderAt: laterToday });
  }
  expect(s.board().reminders).toHaveLength(0);
  const past = s.create({ title: 'Earlier today', reminderAt: '2026-09-03T06:00:00Z' });
  expect(past.status).toBe('today'); expect(s.board().reminders.map(t => t.id)).toEqual([past.id]);
  for (const reminderAt of ['2026-09-02T19:00:00Z', '2026-09-04T19:00:00Z']) expect(s.create({ title: reminderAt, reminderAt }).status).toBe('later');
  expect(s.create({ title: 'Due only', dueDate: '2026-09-03' }).status).toBe('later');
  expect(s.create({ title: 'Done', status: 'done', reminderAt: laterToday }).status).toBe('done');
  expect(s.create({ title: 'Archived', archivedAt: noon.toISOString(), reminderAt: laterToday }).status).toBe('later');
});

test('new-day projection appends legacy reminders stably without changing stored tasks or pending operations', () => {
  let now = new Date('2026-09-02T12:00:00Z');
  const s = new ClientStore(':memory:', () => now, 'Europe/Moscow');
  const a = s.create({ title: 'Later', reminderAt: laterToday });
  const b = s.create({ title: 'Week', status: 'week', reminderAt: laterToday });
  // Simulate downloaded legacy records plus an immutable pending operation.
  s.record.board.rows.push(s.record.pending.shift()!.task);
  now = noon;
  const planned = s.create({ title: 'Already Today', status: 'today' });
  const before = JSON.stringify(s.record);
  const board = s.board();
  expect(board.tasks.filter(t => t.status === 'today').map(t => t.id)).toEqual([planned.id, a.id, b.id]);
  expect(s.board()).toEqual(board);
  expect(JSON.stringify(s.record)).toBe(before);
  expect(s.update(a.id, { notes: 'Save projected task' })).toMatchObject({ status: 'today', plannedDay: '2026-09-03' });
});

test('manual moves fail atomically while Today ordering, completion and rescheduling remain available', () => {
  const s = client();
  const a = s.create({ title: 'A', reminderAt: laterToday }), b = s.create({ title: 'B', status: 'today' });
  for (const status of ['later', 'week']) {
    const before = JSON.stringify(s.record);
    expect(() => s.update(a.id, { status, beforeId: b.id })).toThrow(REMINDER_TODAY_MOVE_ERROR);
    expect(JSON.stringify(s.record)).toBe(before);
  }
  s.update(b.id, { status: 'today', beforeId: a.id });
  expect(s.board().tasks.filter(t => t.status === 'today').map(t => t.id)).toEqual([b.id, a.id]);
  expect(s.update(a.id, { status: 'done' }).status).toBe('done');
  expect(s.update(a.id, { status: 'today' }).completedAt).toBeNull();
  expect(s.update(a.id, { reminderAt: null }).status).toBe('today');
  expect(s.update(a.id, { status: 'later' }).status).toBe('later');
  expect(s.update(a.id, { status: 'later', reminderAt: laterToday }).status).toBe('today');
  expect(s.update(a.id, { reminderAt: '2026-09-04T19:00:00Z' }).status).toBe('today');
  expect(s.update(a.id, { status: 'week' }).status).toBe('week');
});

test('dismissal, archive, delete Undo and snooze preserve Today eligibility', () => {
  const s = client(), task = s.create({ title: 'Reminder', reminderAt: laterToday });
  expect(s.actOnReminder(task.id, { action: 'dismiss', reminderAt: laterToday }).status).toBe('today');
  expect(() => s.update(task.id, { status: 'later' })).toThrow(REMINDER_TODAY_MOVE_ERROR);
  s.remove(task.id); expect(s.restore(task.id).status).toBe('today');
  const archived = s.create({ title: 'Paused', archivedAt: noon.toISOString(), reminderAt: laterToday });
  expect(queueChange(s.record, `/api/tasks/${archived.id}/unarchive`, 'POST', {}, noon.getTime()).task.status).toBe('today');
  const yesterday = s.create({ title: 'Snooze', reminderAt: '2026-09-02T19:00:00Z' });
  expect(s.actOnReminder(yesterday.id, { action: 'snooze', reminderAt: yesterday.reminderAt }).status).toBe('today');
  expect(s.board().reminders).toHaveLength(0);
});

test('planning timezone handles local midnight, DST and year/week rollover', () => {
  for (const [timezone, now, reminderAt, status] of [
    ['Europe/Moscow', '2026-12-31T22:00:00Z', '2027-01-01T15:00:00Z', 'today'],
    ['America/New_York', '2026-03-08T06:00:00Z', '2026-03-09T03:30:00Z', 'today'],
    ['America/New_York', '2026-11-01T04:30:00Z', '2026-11-01T06:30:00Z', 'today'],
    ['America/New_York', '2026-11-01T04:30:00Z', '2026-11-01T03:30:00Z', 'later'],
  ] as const) {
    const s = new ClientStore(':memory:', () => new Date(now), timezone);
    expect(s.create({ title: 'Boundary', reminderAt }).status).toBe(status);
  }
  const s = client(), t = s.create({ title: 'Reminder', reminderAt: laterToday });
  expect(project(s.record, Date.parse('2026-09-03T21:00:00Z'))!.tasks[0].status).toBe('week');
  expect(project(s.record, Date.parse('2026-09-06T21:00:00Z'))!.tasks[0].status).toBe('later');
  expect(reminderIsToday(t, '2026-09-04', 'Europe/Moscow')).toBe(false);
});

test('Markdown import previews, imports and exports agree on today reminder placement', () => {
  const s = client(), tasks = parseMarkdown(`## Later\n- [ ] Imported\n  - Reminder: ${laterToday}`).tasks;
  expect(s.previewImport(tasks).tasks[0].status).toBe('today');
  s.importTasks(tasks);
  expect(s.previewImport(tasks).skipped).toBe(1);
  const exported = exportMarkdown(s.board().tasks);
  expect(exported).toContain('## Today');
  expect(parseMarkdown(exported).tasks[0].reminderAt).toBe(laterToday);
});
