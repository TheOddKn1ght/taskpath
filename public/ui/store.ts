import type {
  Board,
  Route,
  Task,
  MutationResult,
  ArchiveResult,
} from "../types.js";
import {
  offlineRequest,
  isUnlocked,
  selectedAccount,
  localState,
  syncAfterCurrent,
} from "../offline.js";
import { createRealtime } from "../realtime.js";
import { emptyRoute, readRoute, routeHash } from "./routes";
export const columns = {
  later: "Later",
  week: "This Week",
  today: "Today",
  done: "Done",
};
export const boardOrder = ["today", "week", "later", "done"] as const;
interface Snapshot {
  phase: "loading" | "locked" | "unlocked";
  board: Board | null;
  route: Route;
  epoch: number;
  busy: boolean;
  error: string;
  connection: string;
  authRequired: boolean;
}
let snapshot: Snapshot = {
  phase: "loading",
  board: null,
  route: { ...emptyRoute },
  epoch: 0,
  busy: false,
  error: "",
  connection: "Connecting…",
  authRequired: false,
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
  const hash = routeHash(route);
  if (location.hash !== hash)
    history[replace ? "replaceState" : "pushState"](
      null,
      "",
      location.pathname + location.search + hash,
    );
  publish({ route });
}
let refreshing = false,
  refreshAgain = false;
export async function refresh() {
  if (!isUnlocked()) return;
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  const epoch = snapshot.epoch,
    account = selectedAccount();
  try {
    const board = await offlineRequest("/api/board");
    const local = await localState();
    if (
      !isUnlocked() ||
      epoch !== snapshot.epoch ||
      account !== selectedAccount()
    )
      return;
    publish({
      board,
      error: local.error || "",
      authRequired: !!local.authRequired,
      connection: local.authRequired
        ? `Sign in to sync · ${local.pending.length} pending`
        : local.error
          ? `Sync paused · ${local.pending.length} pending`
          : local.pending.length
            ? `${local.pending.length} changes saved on this device`
            : local.online
              ? "All changes synced"
              : "Offline · Saved on this device",
    });
  } catch (e) {
    if (epoch === snapshot.epoch && isUnlocked())
      publish({ error: message(e) });
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}
export const message = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
export function mutate(
  path: "/api/import/markdown",
  method: string,
  body?: unknown,
): Promise<{ imported: number; skipped: number }>;
export function mutate(
  path: "/api/tasks/archive-undo" | "/api/tasks/archive-completed",
  method: string,
  body?: unknown,
): Promise<ArchiveResult>;
export function mutate(
  path: string,
  method: string,
  body?: unknown,
): Promise<MutationResult>;
export async function mutate(
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  if (snapshot.busy)
    throw new Error("A change is being saved. Try again in a moment.");
  const epoch = snapshot.epoch;
  publish({ busy: true });
  try {
    const result = await offlineRequest(path, method, body);
    await refresh();
    if (epoch !== snapshot.epoch || !isUnlocked())
      throw new Error("Workspace locked. Encrypted changes remain saved.");
    return result;
  } finally {
    if (epoch === snapshot.epoch) publish({ busy: false });
  }
}
export async function move(
  task: Task,
  status: Task["status"],
  beforeId?: string | null,
) {
  return mutate(`/api/tasks/${task.id}`, "PATCH", {
    status,
    ...(beforeId !== undefined ? { beforeId } : {}),
  });
}
export function startRuntime(immediate: (fn: () => void) => void) {
  const abort = new AbortController(),
    options = { signal: abort.signal };
  const realtime = createRealtime({
    sync: syncAfterCurrent,
    localState,
    url: location.href,
  });
  const locked = () => {
    realtime.pause();
    immediate(() =>
      publish({
        phase: "locked",
        board: null,
        route: { ...emptyRoute },
        epoch: snapshot.epoch + 1,
        busy: false,
        error: "",
        connection: "",
        authRequired: false,
      }),
    );
  };
  const opened = () => {
    publish({ phase: "unlocked", route: readRoute(location.hash) });
    void refresh();
    void realtime.resume();
  };
  const foreground = () => {
    if (isUnlocked()) {
      void refresh();
      void realtime.resume();
    }
  };
  window.addEventListener("taskpath-locked", locked, options);
  window.addEventListener("taskpath-unlocked", opened, options);
  window.addEventListener(
    "taskpath-storage",
    () => {
      void refresh();
      void realtime.reconcile();
    },
    options,
  );
  window.addEventListener("focus", foreground, options);
  window.addEventListener("online", foreground, options);
  window.addEventListener("pagehide", () => realtime.pause(), options);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) foreground();
    },
    options,
  );
  window.addEventListener(
    "hashchange",
    () => {
      if (!location.hash || /^#(board|archive|files)(\?|$)/.test(location.hash))
        publish({ route: readRoute(location.hash) });
    },
    options,
  );
  const timer = setInterval(foreground, 15000);
  return () => {
    abort.abort();
    clearInterval(timer);
    realtime.pause();
  };
}
