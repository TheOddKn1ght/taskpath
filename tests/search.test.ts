import { test, expect } from 'bun:test';
import { emptySearch, searchTasks, noteSnippet, type SearchState } from '../public/search';
import type { Task } from '../public/types';
const calendar = { day: '2026-09-27', week: '2026-09-21' };
const task = (id: string, values: Partial<Task> = {}): Task => ({ id, title: id, notes: '', tags: [], category: 'personal', status: 'later', position: 0, plannedDay: null, plannedWeek: null, completedAt: null, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', deletedAt: null, archivedAt: null, dueDate: null, reminderAt: null, reminderDismissedAt: null, reminderNotifiedAt: null, ...values });
const search = (tasks: Task[], query = '', filters: Partial<SearchState> = {}) => searchTasks(tasks, { ...emptySearch(), query, ...filters }, calendar);
const ids = (tasks: Task[], query = '', filters: Partial<SearchState> = {}) => search(tasks, query, filters).map(r => r.task.id);
test('words match across title, notes and tags in any order; all are required', () => {
 const t = task('a', { title: 'Buy milk', notes: 'Call Anna', tags: ['groceries'] });
 expect(ids([t], 'ANNA groceries buy')).toEqual(['a']);
 expect(ids([t], 'anna missing')).toEqual([]);
 expect(ids([t], '"buy milk" anna')).toEqual(['a']);
 expect(ids([t], '"milk call"')).toEqual([]);
 expect(ids([t], '"buy mlki"')).toEqual([]);
 expect(ids([t], '"buy milk')).toEqual(['a']);
});
test('one edit for 4-7 letters, two for 8+, transpositions included; short words exact', () => {
 const tasks = [task('a', { title: 'calendar planning cat' })];
 for (const q of ['calnedar', 'calendxr', 'plannnig']) expect(ids(tasks, q)).toEqual(['a']);
 for (const q of ['calxxxxx', 'cut', '"calnedar"']) expect(ids(tasks, q)).toEqual([]);
 expect(ids([task('b', {title:'milk'})], 'mlik')).toEqual(['b']);
 expect(ids([task('b', {title:'milk'})], 'mlxx')).toEqual([]);
});
test('canonical Unicode and case normalization preserve original highlight offsets', () => {
 const title = '👩‍💻 Cafe\u0301 日本語';
 const r = search([task('a', {title})], 'CAFÉ 日本')[0];
 expect(r.title.map(([a,b]) => title.slice(a,b))).toEqual(['Cafe\u0301','日本']);
 expect(search([task('b',{ title:'İstanbul' })], 'i')[0].title).toEqual([[0,1]]);
});
test('ranking prefers full titles, exact matches, fields, recency, then ID', () => {
 const tasks = [task('note',{notes:'calendar',updatedAt:'2026-09-26T00:00:00Z'}),task('tag',{tags:['calendar']}),task('title',{title:'check calendar'}),task('whole',{title:'CALENDAR'}),task('fuzzy',{title:'calnedar'})];
 expect(ids(tasks,'calendar')).toEqual(['whole','title','tag','note','fuzzy']);
 expect(ids([task('z'),task('a'),task('new',{updatedAt:'2026-09-26T00:00:00Z'})])).toEqual(['new','a','z']);
});
test('overlapping highlights merge and note snippets include the matching text', () => {
 const notes = 'x'.repeat(180) + ' important calendar meeting ' + 'x'.repeat(180);
 const r = search([task('a',{title:'calendar',notes})],'cal calendar')[0];
 expect(r.title).toEqual([[0,8]]);
 const snippet = noteSnippet(notes,r.notes);
 expect(snippet.before && snippet.after).toBe(true);
 expect(snippet.ranges.map(([a,b])=>snippet.text.slice(a,b))).toEqual(['calendar']);
});
test('scope excludes deleted tasks and combined filters require every selected tag', () => {
 const tasks = [task('active',{category:'work',status:'today',tags:['a','b'],dueDate:calendar.day,reminderAt:'2026-01-01T12:00:00Z',reminderDismissedAt:'2026-01-01T12:00:00Z'}),task('archive',{archivedAt:'yes'}),task('deleted',{deletedAt:'yes'})];
 expect(ids(tasks)).toEqual(['active','archive']);
 expect(ids(tasks,'',{scope:'archived'})).toEqual(['archive']);
 expect(ids(tasks,'',{scope:'active',category:'work',status:'today',tags:['a','b'],due:'today',reminder:'yes'})).toEqual(['active']);
 expect(ids(tasks,'',{tags:['a','missing']})).toEqual([]);
 expect(ids(tasks,'',{reminder:'no'})).toEqual(['archive']);
});
test('due filters use supplied workspace calendar, inclusive week edges, and exclude Done from overdue', () => {
 const tasks = [task('old',{dueDate:'2026-09-20'}),task('monday',{dueDate:'2026-09-21'}),task('today',{dueDate:'2026-09-27'}),task('future',{dueDate:'2026-09-28'}),task('done',{status:'done',dueDate:'2026-09-20'}),task('none')];
 expect(ids(tasks,'',{due:'week'})).toEqual(['monday','today']);
 expect(ids(tasks,'',{due:'overdue'})).toEqual(['monday','old']);
 expect(ids(tasks,'',{due:'none'})).toEqual(['none']);
 const boundary = searchTasks(tasks,{...emptySearch(),due:'today'},{day:'2026-09-28',week:'2026-09-28'});
 expect(boundary.map(r=>r.task.id)).toEqual(['future']);
});

test('cached index preserves results across cloned tasks, edits, removal and new accounts', async () => {
 const { createSearchIndex } = await import('../public/search');
 const index = createSearchIndex();
 let tasks = [task('a',{title:'Café calendar',notes:'meeting notes',tags:['work']}),task('b',{title:'calnedar'})];
 const verify = (query:string) => expect(searchTasks(tasks,{...emptySearch(),query},calendar,index)).toEqual(search(tasks,query));
 for (const q of ['calendar','calnedar','"meeting notes"','café','work','']) verify(q);
 tasks = structuredClone(tasks); verify('calendar');
 tasks[0].title='Changed';tasks[0].notes='replacement';tasks[0].tags=['home']; // Same timestamp deliberately.
 for (const q of ['café','replacement','home','work']) verify(q);
 tasks=[tasks[1]];verify('calendar');
 tasks=[task('a',{title:'Different account'})];verify('café');verify('different');
});
