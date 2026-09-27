import type { Task, Status, Category } from './types.js';

export interface SearchState {
  query: string;
  scope: 'all' | 'active' | 'archived';
  status: 'all' | Status;
  category: 'all' | Category;
  tags: string[];
  due: 'any' | 'overdue' | 'today' | 'week' | 'none';
  reminder: 'any' | 'yes' | 'no';
}
export const emptySearch = (): SearchState => ({ query: '', scope: 'all', status: 'all', category: 'all', tags: [], due: 'any', reminder: 'any' });
export type MatchRange = [number, number];
export interface SearchResult {
  task: Task;
  title: MatchRange[];
  notes: MatchRange[];
  tags: MatchRange[][];
  approximate: boolean;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const normalize = (s: string) => s.normalize('NFC').toLowerCase();
function field(text: string) {
  let normalized = '';
  const starts: number[] = [], ends: number[] = [];
  for (const item of graphemes.segment(text)) {
    const value = normalize(item.segment);
    normalized += value;
    for (let i = 0; i < value.length; i++) {
      starts.push(item.index); ends.push(item.index + item.segment.length);
    }
  }
  return { normalized, words: [...normalized.matchAll(/[\p{L}\p{N}\p{M}]+/gu)], range: (start: number, end: number): MatchRange => [starts[start], ends[end - 1]] };
}
export function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const result: MatchRange[] = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else result.push([start, end]);
  }
  return result;
}
// Bounded optimal-string-alignment distance, including adjacent transpositions.
function near(a: string, b: string, limit: number) {
  const x = Array.from(a), y = Array.from(b);
  if (Math.abs(x.length - y.length) > limit) return false;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i), older = previous;
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) row[j] = Math.min(row[j], older[j - 2] + 1);
    }
    older = previous; previous = row;
  }
  return previous[y.length] <= limit;
}
function terms(query: string) {
  return [...query.matchAll(/"([^"]*)"|"([^"]*)$|(\S+)/gu)]
    .map(m => ({ value: normalize(m[1] ?? m[2] ?? m[3]), phrase: m[3] === undefined }))
    .filter(t => t.value.length);
}
function matches(f: ReturnType<typeof field>, term: ReturnType<typeof terms>[number], approximate = false) {
  const ranges: MatchRange[] = [];
  let start = f.normalized.indexOf(term.value);
  while (start >= 0) {
    ranges.push(f.range(start, start + term.value.length));
    start = f.normalized.indexOf(term.value, start + term.value.length);
  }
  if (ranges.length) return { ranges, exact: true };
  const length = Array.from(term.value).length;
  const limit = term.phrase || length < 4 ? 0 : length < 8 ? 1 : 2;
  if (approximate && limit) for (const word of f.words) {
    if (near(term.value, word[0], limit)) ranges.push(f.range(word.index, word.index + word[0].length));
  }
  return { ranges, exact: false };
}
function accepts(t: Task, s: SearchState, day: string, weekEnd: string, week: string) {
  if (t.deletedAt || (s.scope === 'active' && t.archivedAt) || (s.scope === 'archived' && !t.archivedAt)) return false;
  if (s.status !== 'all' && t.status !== s.status || s.category !== 'all' && t.category !== s.category) return false;
  if (!s.tags.every(tag => t.tags.includes(tag))) return false;
  if (s.reminder === 'yes' && !t.reminderAt || s.reminder === 'no' && t.reminderAt) return false;
  switch (s.due) {
    case 'none': return !t.dueDate;
    case 'overdue': return !!t.dueDate && t.dueDate < day && t.status !== 'done';
    case 'today': return t.dueDate === day;
    case 'week': return !!t.dueDate && t.dueDate >= week && t.dueDate <= weekEnd;
    default: return true;
  }
}
// Owned by one unlocked dialog, never persisted or shared between accounts.
export function createSearchIndex() {
  const entries = new Map<string, { title: string; notes: string; tags: string[]; fields: ReturnType<typeof field>[] }>();
  return {
    retain(tasks: Task[]) { const ids = new Set(tasks.filter(t => !t.deletedAt).map(t => t.id)); for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id); },
    fields(task: Task) {
      let entry = entries.get(task.id);
      if (!entry || entry.title !== task.title || entry.notes !== task.notes || entry.tags.length !== task.tags.length || entry.tags.some((tag, i) => tag !== task.tags[i])) {
        entry = { title: task.title, notes: task.notes, tags: [...task.tags], fields: [field(task.title), ...task.tags.map(field), field(task.notes)] };
        entries.set(task.id, entry);
      }
      return entry.fields;
    },
  };
}
export function searchTasks(tasks: Task[], state: SearchState, calendar: { day: string; week: string }, index = createSearchIndex()): SearchResult[] {
  const query = terms(state.query.trim());
  index.retain(tasks);
  const whole = normalize(state.query.trim().replace(/^"(.*)"$/s, '$1'));
  const weekEnd = new Date(Date.parse(calendar.week + 'T12:00:00Z') + 6 * 86400000).toISOString().slice(0, 10);
  const found: (SearchResult & { tier: number; score: number })[] = [];
  for (const task of tasks) {
    if (!accepts(task, state, calendar.day, weekEnd, calendar.week)) continue;
    if (!query.length) {
      found.push({ task, title: [], notes: [], tags: task.tags.map(() => []), approximate: false, tier: 1, score: 0 });
      continue;
    }
    const fields = index.fields(task);
    const highlights: MatchRange[][] = fields.map(() => []);
    let score = 0, approximate = false, valid = true;
    for (const term of query) {
      let hits = fields.map(f => matches(f, term));
      const exact = hits.some(h => h.exact);
      if (!exact) hits = fields.map(f => matches(f, term, true));
      let weight = Infinity;
      hits.forEach((hit, i) => {
        if (!hit.ranges.length || exact && !hit.exact) return;
        weight = Math.min(weight, i === 0 ? 0 : i === fields.length - 1 ? 2 : 1);
        highlights[i].push(...hit.ranges);
      });
      if (!Number.isFinite(weight)) { valid = false; break; }
      score += weight;
      approximate ||= !exact;
    }
    if (!valid) continue;
    found.push({ task, title: mergeRanges(highlights[0]), notes: mergeRanges(highlights.at(-1)!), tags: highlights.slice(1, -1).map(mergeRanges), approximate,
      tier: query.length && normalize(task.title) === whole ? 0 : approximate ? 2 : 1, score });
  }
  return found.sort((a, b) => a.tier - b.tier || a.score - b.score || b.task.updatedAt.localeCompare(a.task.updatedAt) || a.task.id.localeCompare(b.task.id));
}
export function noteSnippet(text: string, ranges: MatchRange[], length = 160) {
  let start = Math.max(0, (ranges[0]?.[0] ?? 0) - 45);
  // Do not split a grapheme at either edge of a snippet.
  const parts = [...graphemes.segment(text)];
  start = parts.find(p => p.index >= start)?.index ?? 0;
  const end = parts.find(p => p.index >= start + length)?.index ?? text.length;
  return { text: text.slice(start, end), before: start > 0, after: end < text.length,
    ranges: ranges.filter(([a, b]) => a < end && b > start).map(([a, b]): MatchRange => [Math.max(a, start) - start, Math.min(b, end) - start]) };
}
