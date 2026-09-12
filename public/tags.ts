import type { TaskInput } from './types.js';
export function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Tags must be a list of names.');
  const tags = value.map(name => {
    if (typeof name !== 'string' || /[\p{Cc}]/u.test(name)) throw new Error('Tag names cannot contain control characters.');
    const tag = name.trim().normalize('NFC').toLowerCase().normalize('NFC');
    if (!tag || [...tag].length > 32) throw new Error('Tag names must be between 1 and 32 characters.');
    return tag;
  });
  const result = [...new Set(tags)].sort();
  if (result.length > 10) throw new Error('Use at most 10 tags per task.');
  return result;
}

export function importTaskKey(task: TaskInput) {
  return JSON.stringify([task.title, task.notes || '', task.category || 'personal', task.status || 'later',
    task.dueDate || null, task.reminderAt || null, Boolean(task.reminderDismissedAt), Boolean(task.archivedAt), normalizeTags(task.tags ?? [])]);
}
