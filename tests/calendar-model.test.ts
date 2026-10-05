import { test, expect } from 'bun:test';
import { isOverdue, tasksByDay, weekDays, weekStart } from '../public/calendar-model';
import type { Task } from '../public/types';
const task = (id: string, values: Partial<Task> = {}): Task => ({ id, title: id, notes: '', tags: [], category: 'personal', status: 'later', position: 0, plannedDay: null, plannedWeek: null, completedAt: null, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', deletedAt: null, archivedAt: null, dueDate: null, reminderAt: null, reminderDismissedAt: null, reminderNotifiedAt: null, ...values });
test('weeks start on Monday, across month and year boundaries', () => {
  expect(weekStart('2026-10-05')).toBe('2026-10-05');
  expect(weekStart('2026-10-11')).toBe('2026-10-05');
  expect(weekDays('2027-01-01')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
});
test('tasks land on due and reminder days; one entry when both fall on the same day', () => {
  const days = tasksByDay([
    task('both', { dueDate: '2026-10-05', reminderAt: '2026-10-05T09:00:00Z' }),
    task('split', { dueDate: '2026-10-07', reminderAt: '2026-10-05T12:00:00Z' }),
    task('none'),
  ], 'UTC');
  expect(days.get('2026-10-05')!.map(e => [e.task.id, e.due, e.reminder])).toEqual([['both', true, true], ['split', false, true]]);
  expect(days.get('2026-10-07')!.map(e => [e.task.id, e.due, e.reminder])).toEqual([['split', true, false]]);
  expect([...days.keys()].sort()).toEqual(['2026-10-05', '2026-10-07']);
});
test('reminder days follow the workspace timezone', () => {
  const t = task('late', { reminderAt: '2026-10-05T23:30:00Z' });
  expect([...tasksByDay([t], 'UTC').keys()]).toEqual(['2026-10-05']);
  expect([...tasksByDay([t], 'Europe/Berlin').keys()]).toEqual(['2026-10-06']);
  expect([...tasksByDay([t], 'America/Los_Angeles').keys()]).toEqual(['2026-10-05']);
});
test('archived and deleted tasks are hidden; open tasks sort before done', () => {
  const days = tasksByDay([
    task('b done', { dueDate: '2026-10-05', status: 'done', completedAt: '2026-10-05T10:00:00Z' }),
    task('c open', { dueDate: '2026-10-05' }),
    task('a open', { dueDate: '2026-10-05' }),
    task('archived', { dueDate: '2026-10-05', archivedAt: '2026-10-05T10:00:00Z' }),
    task('deleted', { dueDate: '2026-10-05', deletedAt: '2026-10-05T10:00:00Z' }),
  ], 'UTC');
  expect(days.get('2026-10-05')!.map(e => e.task.id)).toEqual(['a open', 'c open', 'b done']);
});
test('only open tasks past their due date are overdue', () => {
  const [open, done, reminderOnly] = [
    task('open', { dueDate: '2026-10-01' }),
    task('done', { dueDate: '2026-10-01', status: 'done' }),
    task('reminder', { dueDate: '2026-10-09', reminderAt: '2026-10-01T09:00:00Z' }),
  ];
  const days = tasksByDay([open, done, reminderOnly], 'UTC');
  expect(days.get('2026-10-01')!.map(e => [e.task.id, isOverdue(e, '2026-10-05')])).toEqual([['open', true], ['reminder', false], ['done', false]]);
  expect(isOverdue(days.get('2026-10-01')![0], '2026-10-01')).toBe(false);
});
