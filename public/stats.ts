import type { Category, Task } from './types.js';
import { calendarAt } from './offline-model.js';
import { shiftDate } from './picker-model.js';
// Derived only from current tasks: completedAt holds the latest completion, so reopened tasks drop out.
export interface Stats {
  open: { today: number; week: number; later: number };
  done: number; overdue: number; dueThisWeek: number; reminders: number;
  completed: number;
  weeks: { week: string; count: number }[];
  days: { day: string; count: number }[];
  streak: number; bestStreak: number;
  categories: { category: Category; open: number; done: number }[];
  tags: { tag: string; open: number; done: number }[];
  lead: { median: number; average: number; p75: number; count: number } | null;
}
const DAY = 86_400_000;
export const LEAD_WINDOW_DAYS = 90;
function quantile(sorted: number[], q: number) {
  const at = (sorted.length - 1) * q, low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
}
export function computeStats(tasks: Task[], { day, week, timezone }: { day: string; week: string; timezone: string }): Stats {
  const live = tasks.filter(t => !t.deletedAt);
  const current = live.filter(t => !t.archivedAt), open = current.filter(t => t.status !== 'done');
  const weekEnd = shiftDate(week, 6);
  const completions = live.flatMap(task => {
    const at = task.status === 'done' && task.completedAt ? Date.parse(task.completedAt) : NaN;
    return Number.isFinite(at) ? [{ task, at, ...calendarAt(at, timezone) }] : [];
  });
  const perDay = new Map<string, number>(), perWeek = new Map<string, number>();
  for (const c of completions) {
    perDay.set(c.day, (perDay.get(c.day) || 0) + 1);
    perWeek.set(c.week, (perWeek.get(c.week) || 0) + 1);
  }
  let streak = 0;
  // A streak stays alive until today ends without a completion.
  for (let d = perDay.has(day) ? day : shiftDate(day, -1); perDay.has(d); d = shiftDate(d, -1)) streak++;
  let bestStreak = 0, run = 0, previous = '';
  for (const d of [...perDay.keys()].sort()) {
    run = previous && shiftDate(previous, 1) === d ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    previous = d;
  }
  const categories = (['work', 'personal'] as const).map(category => ({
    category,
    open: open.filter(t => t.category === category).length,
    done: completions.filter(c => c.task.category === category).length,
  }));
  const tagCounts = new Map<string, { tag: string; open: number; done: number }>();
  const countTags = (task: Task, key: 'open' | 'done') => {
    for (const tag of task.tags) {
      const entry = tagCounts.get(tag) || { tag, open: 0, done: 0 };
      entry[key]++;
      tagCounts.set(tag, entry);
    }
  };
  for (const t of open) countTags(t, 'open');
  for (const c of completions) countTags(c.task, 'done');
  const tags = [...tagCounts.values()]
    .sort((a, b) => b.open + b.done - a.open - a.done || a.tag.localeCompare(b.tag))
    .slice(0, 8);
  const since = shiftDate(day, -(LEAD_WINDOW_DAYS - 1));
  const durations = completions
    .filter(c => c.day >= since && Number.isFinite(Date.parse(c.task.createdAt)))
    .map(c => Math.max(0, c.at - Date.parse(c.task.createdAt)) / DAY)
    .sort((a, b) => a - b);
  return {
    open: {
      today: open.filter(t => t.status === 'today').length,
      week: open.filter(t => t.status === 'week').length,
      later: open.filter(t => t.status === 'later').length,
    },
    done: current.length - open.length,
    overdue: open.filter(t => t.dueDate && t.dueDate < day).length,
    dueThisWeek: open.filter(t => t.dueDate && t.dueDate >= week && t.dueDate <= weekEnd).length,
    reminders: open.filter(t => t.reminderAt && !t.reminderDismissedAt).length,
    completed: completions.length,
    weeks: Array.from({ length: 12 }, (_, i) => shiftDate(week, -7 * (11 - i))).map(w => ({ week: w, count: perWeek.get(w) || 0 })),
    days: Array.from({ length: 14 }, (_, i) => shiftDate(day, i - 13)).map(d => ({ day: d, count: perDay.get(d) || 0 })),
    streak, bestStreak, categories, tags,
    lead: durations.length ? {
      median: quantile(durations, 0.5),
      average: durations.reduce((sum, d) => sum + d, 0) / durations.length,
      p75: quantile(durations, 0.75),
      count: durations.length,
    } : null,
  };
}
