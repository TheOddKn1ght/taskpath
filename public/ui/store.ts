import { parseWorkspaceHash } from '../router.js';
import { startAutoLock } from '../auto-lock.js';
import { fileState } from '../file-persistence.js';
import type { Board, Route, Task, MutationResult, ArchiveResult } from '../types.js';
import {
  lock,
  offlineRequest,
  isUnlocked,
  selectedAccount,
  localState,
  syncAfterCurrent,
} from '../offline.js';
import { createRealtime } from '../realtime.js';
import { emptyRoute, readRoute, routeHash } from './routes';
export const columns = {
  later: 'Later',
  week: 'This Week',
  today: 'Today',
  done: 'Done',
};
export const boardOrder = ['today', 'week', 'later', 'done'] as const;
interface Snapshot {
  phase: 'loading' | 'locked' | 'unlocked';
  board: Board | null;
  route: Route;
  epoch: number;
  busy: boolean;
  error: string;
  connection: string;
  authRequired: boolean;
  syncComplete: boolean;
}
let snapshot: Snapshot = {
  phase: 'loading',
  board: null,
  route: { ...emptyRoute },
  epoch: 0,
  busy: false,
  error: '',
  connection: 'Connecting…',
  authRequired: false,
  syncComplete: false,
};
const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const getSnapshot = () => snapshot;
export function publish(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const fn of listeners) fn();
}
export function navigate(patch: Partial<Route>, replace = false) {
  const route = { ...snapshot.route, ...patch };
  if (route.view !== 'board') delete route.focus;
  const hash = routeHash(route);
  if (location.hash !== hash)
    history[replace ? 'replaceState' : 'pushState'](
      null,
      '',
      location.pathname + location.search + hash,
    );
  publish({ route });
}
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
export function refresh(): Promise<void> {
  if (!isUnlocked()) return Promise.resolve();
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  const run = async () => {
    do {
      refreshAgain = false;
      const epoch = snapshot.epoch,
        account = selectedAccount();
      try {
        const board = await offlineRequest('/api/board');
        const local = await localState();
        if (!isUnlocked() || epoch !== snapshot.epoch || account !== selectedAccount()) continue;
        publish({
          board,
          error: local.error || '',
          authRequired: !!local.authRequired,
          syncComplete: !!local.syncComplete,
          connection: local.authRequired
            ? `Sign in to sync · ${local.pending.length} pending`
            : local.error
              ? `Sync paused · ${local.pending.length} pending`
              : local.pending.length
                ? `${local.pending.length} changes saved on this device`
                : local.online && !local.syncComplete
                  ? 'Syncing tasks…'
                  : local.online
                    ? 'All changes synced'
                    : 'Offline · Saved on this device',
        });
      } catch (e) {
        if (epoch === snapshot.epoch && isUnlocked()) publish({ error: message(e) });
      }
    } while (refreshAgain && isUnlocked());
  };
  refreshing = run().finally(() => {
    refreshing = null;
    if (refreshAgain && isUnlocked()) return refresh();
  });
  return refreshing;
}
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function mutate(
  path: '/api/tags',
  method: string,
  body: unknown,
): Promise<{ affected: number }>;
export function mutate(
  path: '/api/import/markdown',
  method: string,
  body?: unknown,
): Promise<{ imported: number; skipped: number }>;
export function mutate(
  path: '/api/tasks/archive-undo' | '/api/tasks/archive-completed',
  method: string,
  body?: unknown,
): Promise<ArchiveResult>;
export function mutate(path: string, method: string, body?: unknown): Promise<MutationResult>;
export async function mutate(path: string, method: string, body?: unknown): Promise<unknown> {
  if (snapshot.busy) throw new Error('A change is being saved. Try again in a moment.');
  const epoch = snapshot.epoch;
  publish({ busy: true });
  try {
    const result = await offlineRequest(path, method, body);
    await refresh();
    if (epoch !== snapshot.epoch || !isUnlocked())
      throw new Error('Workspace locked. Encrypted changes remain saved.');
    return result;
  } finally {
    if (epoch === snapshot.epoch) publish({ busy: false });
  }
}
export async function move(task: Task, status: Task['status'], beforeId?: string | null) {
  return mutate(`/api/tasks/${task.id}`, 'PATCH', {
    status,
    ...(beforeId !== undefined ? { beforeId } : {}),
  });
}
export function startRuntime(immediate: (fn: () => void) => void) {
  const stopAutoLock = startAutoLock(isUnlocked, lock);
  const abort = new AbortController(),
    options = { signal: abort.signal };
  const realtime = createRealtime({
    sync: syncAfterCurrent,
    needsRetry: async () => {
      const files = await fileState();
      return (
        !!files.error ||
        !!files.deletions.length ||
        Object.values(files.files).some((file) => !!file.pending || !!file.error)
      );
    },
    localState,
    url: location.href,
  });
  const locked = () => {
    realtime.pause();
    immediate(() =>
      publish({
        phase: 'locked',
        board: null,
        route: { ...emptyRoute },
        epoch: snapshot.epoch + 1,
        busy: false,
        error: '',
        connection: '',
        authRequired: false,
        syncComplete: false,
      }),
    );
  };
  const opened = () => {
    publish({ phase: 'unlocked', route: readRoute(location.hash) });
    void refresh();
    void realtime.resume();
  };
  const foreground = () => {
    if (isUnlocked()) {
      void refresh();
      void realtime.resume();
    }
  };
  window.addEventListener('taskpath-locked', locked, options);
  window.addEventListener('taskpath-unlocked', opened, options);
  window.addEventListener(
    'taskpath-storage',
    () => {
      void refresh();
      void realtime.reconcile();
    },
    options,
  );
  window.addEventListener('focus', foreground, options);
  window.addEventListener('online', foreground, options);
  window.addEventListener('pagehide', () => realtime.pause(), options);
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!document.hidden) foreground();
    },
    options,
  );
  window.addEventListener(
    'hashchange',
    () => {
      if (!location.hash || parseWorkspaceHash(location.hash))
        publish({ route: readRoute(location.hash) });
    },
    options,
  );
  const timer = setInterval(() => {
    if (isUnlocked() && !document.hidden) {
      void refresh(); // Keep the workspace calendar and local reminders current.
      void realtime.poll().catch(() => {});
    }
  }, 15000);
  return () => {
    abort.abort();
    stopAutoLock();
    clearInterval(timer);
    realtime.pause();
  };
}
