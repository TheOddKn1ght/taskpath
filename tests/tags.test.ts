import { test, expect } from 'bun:test';
import { ClientStore as Store } from './client-helpers';
import { normalizeTags, importTaskKey } from '../public/tags.js';
import { exportMarkdown, parseMarkdown } from '../public/markdown.js';

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

test('tags survive task lifecycle, reminders and calendar rollover', () => {
  const store = makeStore();
  try {
    const task = store.create({ title: 'Tagged', tags: ['home'], status: 'today', reminderAt: time });
    expect(store.board().reminders[0].tags).toEqual(['home']);
    expect(store.actOnReminder(task.id, { action: 'snooze', reminderAt: time }).tags).toEqual(['home']);
    store.update(task.id, { status: 'done' });
    store.remove(task.id);
    expect(store.restore(task.id).tags).toEqual(['home']);
    store.update(task.id, { status: 'today' });
    store.record.pending.at(-1)!.task.plannedWeek = '2026-08-31';
    expect(store.board().tasks[0]).toMatchObject({ status: 'later', tags: ['home'] });
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
