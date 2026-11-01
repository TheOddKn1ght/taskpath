import { useEffect, useMemo, useState } from 'react';
import type { Board, Route, Task } from '../types.js';
import { formatTrackedTime, trackedTime } from '../time-tracking.js';
import { mutate, message } from './store';

// Refresh displays, not persisted task data. The server timestamp already includes the local offset.
export function useTrackingClock(serverTime: string, running: boolean) {
  const offset = useMemo(() => Date.parse(serverTime) - Date.now(), [serverTime]);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => refresh((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return Date.now() + offset;
}

export function TimeTrackingView({ board, route }: { board: Board; route: Route }) {
  const now = useTrackingClock(
    board.serverTime,
    board.tasks.some((task) => !!task.timeTracking?.startedAt),
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const inScope = (task: Task) =>
    !task.deletedAt &&
    (route.category === 'all' || task.category === route.category) &&
    (!route.tag || task.tags.includes(route.tag));
  const available = board.tasks
    .filter(
      (task) => inScope(task) && !task.timeTracking && !task.archivedAt && task.status !== 'done',
    )
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const selectedTask = available.find((task) => task.id === selected);
  const tasks = board.tasks
    .filter(
      (task) =>
        inScope(task) &&
        task.timeTracking &&
        task.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(!!b.timeTracking?.startedAt) - Number(!!a.timeTracking?.startedAt) ||
        Number(!!b.timeTracking) - Number(!!a.timeTracking) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
  async function save(task: Task, action: 'add' | 'start' | 'pause' | 'complete') {
    setBusy(task.id);
    setError('');
    try {
      if (action === 'complete') {
        await mutate(`/api/tasks/${task.id}`, 'PATCH', { status: 'done' });
      } else {
        await mutate(`/api/tasks/${task.id}/timer`, 'POST', { action });
      }
      if (action === 'add') setSelected('');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section id="time-view" className="time-view" tabIndex={-1} aria-labelledby="time-title">
      <header className="view-heading">
        <h2 id="time-title">Time tracking</h2>
        <p>
          Track only the tasks you want to time. Pause for breaks and resume when you are ready.
        </p>
      </header>
      <p className="stats-caption">
        Timers keep running when you close the app. Completing or archiving a task pauses its timer.
      </p>
      <form
        className="time-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (selectedTask && busy === null) void save(selectedTask, 'add');
        }}
      >
        <label className="field">
          Add task to track
          <select
            value={selectedTask ? selected : ''}
            onChange={(event) => setSelected(event.target.value)}
            disabled={busy !== null || !available.length}
          >
            <option value="">
              {available.length ? 'Choose a task…' : 'No tasks available to add'}
            </option>
            {available.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary-button" disabled={!selectedTask || busy !== null}>
          Add to tracking
        </button>
      </form>
      <label className="field time-search">
        Find a task
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks to track"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {tasks.length ? (
        <ul className="time-task-list">
          {tasks.map((task) => {
            const running = !!task.timeTracking?.startedAt;
            const inactive = task.status === 'done' || !!task.archivedAt;
            return (
              <li key={task.id} className={`time-task${running ? ' is-running' : ''}`}>
                <div className="time-task-copy">
                  <h3>{task.title}</h3>
                  <p>
                    {task.archivedAt
                      ? 'Archived'
                      : task.status === 'done'
                        ? 'Completed'
                        : running
                          ? 'Running'
                          : task.timeTracking
                            ? task.timeTracking.elapsedMs > 0
                              ? 'Paused'
                              : 'Ready to start'
                            : 'Not started'}{' '}
                    · {task.category === 'work' ? 'Work' : 'Personal'}
                  </p>
                  {inactive && <p>Reopen or restore this task to resume tracking.</p>}
                </div>
                <span className="time-task-total" aria-label="Tracked time">
                  {formatTrackedTime(trackedTime(task, now))}
                </span>
                {!inactive && (
                  <div className="time-task-actions">
                    <button
                      type="button"
                      className={running ? 'secondary-button' : 'primary-button'}
                      disabled={busy !== null}
                      onClick={() => void save(task, running ? 'pause' : 'start')}
                      aria-label={`${running ? 'Pause' : task.timeTracking?.elapsedMs ? 'Resume' : 'Start'} timer for ${task.title}`}
                    >
                      {busy === task.id
                        ? 'Saving…'
                        : running
                          ? 'Pause'
                          : task.timeTracking?.elapsedMs
                            ? 'Resume'
                            : 'Start'}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy !== null}
                      onClick={() => void save(task, 'complete')}
                      aria-label={`Complete task ${task.title}`}
                    >
                      Complete
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="stats-empty">
          {query || route.category !== 'all' || route.tag
            ? 'No matching tasks.'
            : 'No tasks added to tracking yet. Choose a task above and add it when you want to track its time.'}
        </p>
      )}
    </section>
  );
}
