import type { Task } from './types.js';
import { calendarAt } from './offline-model.js';
import { shiftDate } from './picker-model.js';
// Calendar placement for the workspace timezone. Weeks start on Monday, like the board.
export interface CalendarEntry { task: Task; due: boolean; reminder: boolean }
export function weekStart(day: string): string {
  return shiftDate(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}
export function weekDays(day: string): string[] {
  const start = weekStart(day);
  return Array.from({ length: 7 }, (_, i) => shiftDate(start, i));
}
export function tasksByDay(tasks: Task[], timezone: string): Map<string, CalendarEntry[]> {
  const days = new Map<string, CalendarEntry[]>();
  const place = (day: string, task: Task, kind: 'due' | 'reminder') => {
    const list = days.get(day) || [];
    const entry = list.find(e => e.task.id === task.id);
    if (entry) entry[kind] = true;
    else list.push({ task, due: kind === 'due', reminder: kind === 'reminder' });
    days.set(day, list);
  };
  for (const task of tasks) {
    if (task.deletedAt || task.archivedAt) continue;
    if (task.dueDate) place(task.dueDate, task, 'due');
    const at = task.reminderAt ? Date.parse(task.reminderAt) : NaN;
    if (Number.isFinite(at)) place(calendarAt(at, timezone).day, task, 'reminder');
  }
  for (const list of days.values())
    list.sort((a, b) => Number(a.task.status === 'done') - Number(b.task.status === 'done') ||
      a.task.title.localeCompare(b.task.title));
  return days;
}
export function isOverdue(entry: CalendarEntry, today: string): boolean {
  return entry.due && entry.task.status !== 'done' && !!entry.task.dueDate && entry.task.dueDate < today;
}
