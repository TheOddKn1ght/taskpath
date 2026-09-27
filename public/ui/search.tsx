import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Board, Task } from '../types.js';
import { createSearchIndex, emptySearch, noteSnippet, searchTasks, type MatchRange, type SearchState } from '../search.js';
import { Dialog } from './dialog';
import { Select } from './pickers';
import { Icon } from './icons';
import { columns } from './store';

function Highlight({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  let end = 0;
  const chunks = ranges.map(([a, b], i) => {
    const prefix = text.slice(end, a); end = b;
    return <Fragment key={i}>{prefix}<mark>{text.slice(a, b)}</mark></Fragment>;
  });
  return <>{chunks}{text.slice(end)}</>;
}
export function TaskSearch({ board, initialState, close, openTask, suspended, syncComplete }: {
  board: Board; initialState: SearchState; close: () => void;
  openTask: (t: Task) => void; suspended: boolean; syncComplete: boolean;
}) {
  const [state, change] = useState(initialState);
  useEffect(() => { change(initialState); setLimit(50); setSelected(null); scroll.current = 0; }, [initialState]);
  const [indexCache] = useState(createSearchIndex);
  const [limit, setLimit] = useState(50), [selected, setSelected] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), scroll = useRef(0);
  const rememberScroll = () => { if (list.current) scroll.current = list.current.scrollTop; };
  const open = (task: Task) => { rememberScroll(); openTask(task); };
  const dismiss = () => { rememberScroll(); close(); };
  const results = useMemo(() => suspended ? [] : searchTasks(board.tasks, state, board, indexCache), [board, state, suspended, indexCache]);
  const visible = results.slice(0, limit);
  const active = visible.findIndex(r => r.task.id === selected);
  const index = active >= 0 ? active : 0;
  const tags = [...new Set([...state.tags, ...board.tasks.filter(t => !t.deletedAt).flatMap(t => t.tags)])].sort();
  const patch = (s: Partial<SearchState>) => { scroll.current = 0; if (list.current) list.current.scrollTop = 0; setLimit(50); setSelected(null); change({ ...state, ...s }); };
  useLayoutEffect(() => { if (!suspended && list.current) list.current.scrollTop = scroll.current; }, [suspended]);
  const chips: { key: string; text: string; clear: () => void }[] = [];
  const optionLabels = {
    scope: { all: 'All tasks', active: 'Active', archived: 'Archived' },
    status: { all: 'All columns', ...columns },
    category: { all: 'All categories', work: 'Work', personal: 'Personal' },
    due: { any: 'Any due date', overdue: 'Overdue', today: 'Due today', week: 'Due this week', none: 'No due date' },
    reminder: { any: 'Any reminder', yes: 'Has reminder', no: 'No reminder' },
  };
  for (const key of ['scope', 'status', 'category', 'due', 'reminder'] as const) {
    if (state[key] !== emptySearch()[key]) chips.push({ key, text: (optionLabels[key] as Record<string, string>)[state[key]], clear: () => patch({ [key]: emptySearch()[key] }) });
  }
  for (const tag of state.tags) chips.push({ key: 'tag:' + tag, text: '#' + tag, clear: () => patch({ tags: state.tags.filter(t => t !== tag) }) });
  if (suspended) return null;
  return <Dialog id="task-search-dialog" title="Search tasks" className="task-search-dialog" onClose={dismiss}>
    <div className="task-search-controls">
      <div className="task-search-field">
        <Icon name="search" />
        <input ref={input} id="search" type="search" placeholder="Search titles, notes, and tags"
          aria-label="Search all tasks" autoFocus autoComplete="off" spellCheck={false}
          role="combobox" aria-autocomplete="list" aria-expanded={true} aria-controls="task-search-results"
          aria-activedescendant={visible[index] ? 'search-result-' + visible[index].task.id : undefined}
          value={state.query} onChange={e => patch({ query: e.target.value })}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            if (['ArrowDown', 'ArrowUp'].includes(e.key) && visible.length) {
              e.preventDefault();
              const next = selected === null && e.key === 'ArrowDown' ? 0 : (index + (e.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
              setSelected(visible[next].task.id);
              document.getElementById('search-result-' + visible[next].task.id)?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && visible[index]) { e.preventDefault(); open(visible[index].task); }
          }} />
        {state.query && <button className="icon-button" aria-label="Clear search" onClick={() => { patch({ query: '' }); input.current?.focus(); }}><Icon name="x" /></button>}
      </div>
      <div className="task-search-tools">
        <span role="status" aria-live="polite">{results.length} {results.length === 1 ? 'result' : 'results'}</span>
        <button className="secondary-button" aria-expanded={filtersOpen} aria-controls="task-search-filters" onClick={() => setFiltersOpen(!filtersOpen)}>Filters{chips.length ? ` (${chips.length})` : ''}</button>
        {(chips.length > 0 || state.query) && <button className="subtle-button" onClick={() => patch(emptySearch())}>Clear all</button>}
      </div>
      {filtersOpen && <div id="task-search-filters" className="task-search-filters">
        {(['scope', 'status', 'category', 'due', 'reminder'] as const).map(key => <label key={key}>
          {{ scope: 'Include', status: 'Column', category: 'Category', due: 'Due date', reminder: 'Reminder' }[key]}
          <Select id={'search-filter-' + key} label={'Search ' + key} value={state[key]}
            options={Object.entries(optionLabels[key]).map(([value, label]) => ({ value, label }))}
            onChange={value => patch({ [key]: value })} />
        </label>)}
        <fieldset className="task-search-tags"><legend>Tags · match all selected</legend>
          {tags.length ? tags.map(tag => <label key={tag}><input type="checkbox" checked={state.tags.includes(tag)} onChange={e => patch({ tags: e.target.checked ? [...state.tags, tag] : state.tags.filter(t => t !== tag) })} />{tag}</label>) : <span>No tags yet.</span>}
        </fieldset>
      </div>}
      {!!chips.length && <div className="task-search-chips">{chips.map(chip => <button key={chip.key} className="tag-chip" aria-label={'Remove filter ' + chip.text} onClick={chip.clear}>{chip.text}<Icon name="x" /></button>)}</div>}
      {!syncComplete && <p className="task-search-hint" role="status">Results cover downloaded tasks. More may appear as sync completes.</p>}
      <p className="task-search-hint">Search any words, or use &quot;quotes&quot; for a phrase. Minor typos are matched too.</p>
    </div>
    <div className="task-search-scroll" ref={list}>
      <div id="task-search-results" role="listbox" aria-label="Matching tasks">
        {visible.map((result, i) => {
          const t = result.task, snippet = noteSnippet(t.notes, result.notes);
          return <button key={t.id} id={'search-result-' + t.id} className="task-search-result" role="option" aria-selected={i === index}
            onFocus={() => setSelected(t.id)} onClick={() => open(t)}>
            <strong><Highlight text={t.title} ranges={result.title} /></strong>
            {snippet.text && <span className="task-search-snippet">{snippet.before ? '…' : ''}<Highlight text={snippet.text} ranges={snippet.ranges} />{snippet.after ? '…' : ''}</span>}
            <span className="task-search-meta">{columns[t.status]} · {t.category === 'work' ? 'Work' : 'Personal'}{t.archivedAt && <span className="search-archive-badge">Archived</span>}{result.approximate && ' · Similar match'}{t.dueDate && ` · Due ${t.dueDate}`}</span>
            {!!t.tags.length && <span className="task-search-result-tags">{t.tags.map((tag, j) => <span key={tag}>#<Highlight text={tag} ranges={result.tags[j]} /></span>)}</span>}
          </button>;
        })}
      </div>
      {!results.length && <p className="task-search-empty">{board.tasks.some(t => !t.deletedAt) ? 'No matching tasks. Try fewer words or clear some filters.' : 'No tasks yet. Create a task to find it here.'}</p>}
      {results.length > limit && <button className="secondary-button search-more" onClick={() => setLimit(limit + 50)}>Show more</button>}
    </div>
  </Dialog>;
}
