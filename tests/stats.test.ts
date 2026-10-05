import { test, expect } from 'bun:test';
import { computeStats } from '../public/stats';
import type { Task } from '../public/types';
const calendar = { day: '2026-10-07', week: '2026-10-05', timezone: 'UTC' };
const task = (id: string, values: Partial<Task> = {}): Task => ({ id, title: id, notes: '', tags: [], category: 'personal', status: 'later', position: 0, plannedDay: null, plannedWeek: null, completedAt: null, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', deletedAt: null, archivedAt: null, dueDate: null, reminderAt: null, reminderDismissedAt: null, reminderNotifiedAt: null, ...values });
const done = (id: string, completedAt: string, values: Partial<Task> = {}) => task(id, { status: 'done', completedAt, ...values });
test('snapshot counts open columns, overdue, due this week and reminders', () => {
  const s = computeStats([
    task('today', { status: 'today', dueDate: '2026-10-06' }),
    task('week', { status: 'week', dueDate: '2026-10-11' }),
    task('later', { dueDate: '2026-10-12', reminderAt: '2026-10-08T09:00:00Z' }),
    task('dismissed', { reminderAt: '2026-10-01T09:00:00Z', reminderDismissedAt: '2026-10-01T09:05:00Z' }),
    done('done', '2026-10-07T10:00:00Z', { dueDate: '2026-10-01' }),
    task('archived', { archivedAt: '2026-10-01T00:00:00Z', dueDate: '2026-10-01' }),
    task('deleted', { status: 'today', deletedAt: '2026-10-01T00:00:00Z' }),
  ], calendar);
  expect(s.open).toEqual({ today: 1, week: 1, later: 2 });
  expect([s.done, s.overdue, s.dueThisWeek, s.reminders]).toEqual([1, 1, 2, 1]);
});
test('completions bucket by workspace day and Monday week, including archived tasks', () => {
  const tasks = [
    done('a', '2026-10-04T23:30:00Z'),
    done('b', '2026-10-05T08:00:00Z', { archivedAt: '2026-10-06T00:00:00Z' }),
    done('c', '2026-07-01T08:00:00Z'),
    task('reopened', { completedAt: null }),
  ];
  const utc = computeStats(tasks, calendar);
  expect(utc.completed).toBe(3);
  expect(utc.weeks).toHaveLength(12);
  expect(utc.weeks.at(-1)).toEqual({ week: '2026-10-05', count: 1 });
  expect(utc.weeks.at(-2)).toEqual({ week: '2026-09-28', count: 1 });
  expect(utc.weeks[0].week).toBe('2026-07-20');
  expect(utc.days).toHaveLength(14);
  expect(utc.days.at(-1)!.day).toBe('2026-10-07');
  const berlin = computeStats(tasks, { ...calendar, timezone: 'Europe/Berlin' });
  expect(berlin.weeks.at(-1)).toEqual({ week: '2026-10-05', count: 2 });
});
test('streak survives until today ends; best streak spans gaps', () => {
  const days = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-05', '2026-10-06'];
  const tasks = days.map((d, i) => done(String(i), `${d}T12:00:00Z`));
  expect(computeStats(tasks, calendar)).toMatchObject({ streak: 2, bestStreak: 4 });
  expect(computeStats([...tasks, done('today', '2026-10-07T08:00:00Z')], calendar).streak).toBe(3);
  expect(computeStats(tasks, { ...calendar, day: '2026-10-08' }).streak).toBe(0);
  expect(computeStats([], calendar)).toMatchObject({ streak: 0, bestStreak: 0, lead: null });
});
test('categories and top tags split open from completed', () => {
  const s = computeStats([
    task('w', { category: 'work', tags: ['home', 'call'] }),
    done('w2', '2026-10-06T10:00:00Z', { category: 'work', tags: ['call'] }),
    done('p', '2026-10-06T10:00:00Z', { tags: ['errand'] }),
    ...Array.from({ length: 9 }, (_, i) => task(`t${i}`, { tags: [`tag${i}`] })),
  ], calendar);
  expect(s.categories).toEqual([{ category: 'work', open: 1, done: 1 }, { category: 'personal', open: 9, done: 1 }]);
  expect(s.tags).toHaveLength(8);
  expect(s.tags[0]).toEqual({ tag: 'call', open: 1, done: 1 });
});
test('lead time uses the last 90 days with interpolated median and p75', () => {
  const created = '2026-10-01T00:00:00Z';
  const s = computeStats([
    done('1', '2026-10-02T00:00:00Z', { createdAt: created }),
    done('2', '2026-10-03T00:00:00Z', { createdAt: created }),
    done('3', '2026-10-04T00:00:00Z', { createdAt: created }),
    done('4', '2026-10-06T00:00:00Z', { createdAt: created }),
    done('old', '2026-07-01T00:00:00Z', { createdAt: '2026-01-01T00:00:00Z' }),
  ], calendar);
  expect(s.lead).toEqual({ median: 2.5, average: 2.75, p75: 3.5, count: 4 });
});
