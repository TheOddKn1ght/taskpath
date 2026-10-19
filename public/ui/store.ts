import { startAutoLock } from '../auto-lock.js';
import { fileState } from "../file-persistence.js";
import type {
  Board,
  Route,
  Task,
  MutationResult,
  ArchiveResult,
} from "../types.js";
import {
  lock,
  offlineRequest,
  isUnlocked,
  selectedAccount,
  localState,
  syncAfterCurrent,
  withVaultKey,
} from "../offline.js";
import { createRealtime } from "../realtime.js";
import { emptyRoute, readRoute, routeHash } from "./routes";
import { decryptRoute, encryptRoute } from '../url-state.js';
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
  syncComplete: boolean;
  urlSaved: boolean;
  urlError: string;
  routeEpoch: number;
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
  syncComplete: false,
  urlSaved: false,
  urlError: '',
  routeEpoch: 0,
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
let routeRevision = 0;
let untrackedDraft = false;
let sealRoute: ((route: Route) => Promise<string>) | null = null;
let activeHash = typeof location === 'undefined' ? '' : location.hash;
let activeEntry = '';
const ENTRY_KEY = 'taskpathEntry', URL_CACHE = 'taskpath-url-history-v1';
const entryPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cipherPattern = /^#state=v1\.[\w-]{16}\.[\w-]+$/;
interface EncryptedEntry {
  account: string | null;
  promise: Promise<string>;
  hash?: string;
  originalHash: string;
  revision: number;
  draft: boolean;
  inHistory: boolean;
  inSession: boolean;
  failures?: number;
}
// Entries contain only ciphertext (or an encryption promise), never drafts or keys.
// The sidecar lets a Forward entry retain its latest ciphertext across a reload
// while the browser is showing a different history entry.
const encryptedEntries = new Map<string, EncryptedEntry>();
const cachedCiphers = new Map<string, { previous: string; hash: string }>();
let cacheLoaded = false;
function loadCipherCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(URL_CACHE) || '[]');
    if (!Array.isArray(saved) || saved.length > 16) return;
    let size = 0;
    for (const item of saved) {
      if (!Array.isArray(item) || item.length !== 3 || typeof item[0] !== 'string' || !entryPattern.test(item[0]) ||
          typeof item[1] !== 'string' || item[1].length > 131072 || (item[1] !== '' && !cipherPattern.test(item[1])) ||
          typeof item[2] !== 'string' || item[2].length > 131072 || !cipherPattern.test(item[2]) || (size += item[1].length + item[2].length) > 1048576) {
        cachedCiphers.clear();
        return;
      }
      cachedCiphers.set(item[0], { previous: item[1], hash: item[2] });
    }
  } catch { /* The encrypted URL remains usable when session storage is unavailable. */ }
}
function saveCipherCache() {
  let size = [...cachedCiphers.values()].reduce((sum, value) => sum + value.hash.length + value.previous.length, 0);
  while (cachedCiphers.size > 16 || size > 1048576) {
    const oldest = cachedCiphers.keys().next().value!;
    const old = cachedCiphers.get(oldest)!;
    size -= old.hash.length + old.previous.length;
    cachedCiphers.delete(oldest);
  }
  let saved = false;
  try { sessionStorage.setItem(URL_CACHE, JSON.stringify([...cachedCiphers].map(([key, value]) => [key, value.previous, value.hash]))); saved = true; } catch {}
  for (const [entryId, entry] of encryptedEntries)
    entry.inSession = saved && !!entry.hash && cachedCiphers.get(entryId)?.hash === entry.hash;
}
function cacheCipher(id: string, entry: EncryptedEntry) {
  loadCipherCache();
  cachedCiphers.delete(id);
  cachedCiphers.set(id, { previous: cipherPattern.test(entry.originalHash) ? entry.originalHash : '', hash: entry.hash! });
  saveCipherCache();
}
function forgetCommittedCipher(id: string, entry: EncryptedEntry) {
  // A committed URL is the durable copy; keep extra ciphertext only for
  // pending or offscreen entries that cannot yet update their own address.
  entry.inHistory = true;
  if (encryptedEntries.get(id) === entry) encryptedEntries.delete(id);
  if (cachedCiphers.get(id)?.hash === entry.hash) {
    cachedCiphers.delete(id);
    saveCipherCache();
  }
}
function currentEntryId() {
  const id: unknown = history.state?.[ENTRY_KEY];
  return typeof id === 'string' && entryPattern.test(id) ? id : '';
}
let lastHistoryWrite = -Infinity;
let retryHistoryAfter = -Infinity;
function reserveEntry(push = false) {
  const existing = currentEntryId();
  if (!push && existing) return existing;
  const id = crypto.randomUUID();
  history[push ? 'pushState' : 'replaceState']({ [ENTRY_KEY]: id }, '', location.href);
  lastHistoryWrite = Date.now();
  return id;
}
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let queuedWrite: { id: string; entry: EncryptedEntry; resolve: (saved: boolean) => void } | undefined;
function writeCipher(id: string, entry: EncryptedEntry): Promise<boolean> {
  if (!entry.hash || encryptedEntries.get(id) !== entry || currentEntryId() !== id || selectedAccount() !== entry.account) return Promise.resolve(false);
  if (location.hash === entry.hash) { forgetCommittedCipher(id, entry); return Promise.resolve(true); }
  queuedWrite?.resolve(false);
  clearTimeout(writeTimer);
  return new Promise(resolve => {
    queuedWrite = { id, entry, resolve };
    // WebKit limits History API calls in a rolling window. Text input remains
    // immediate; only the already encrypted address updates are coalesced.
    writeTimer = setTimeout(() => {
      const pending = queuedWrite;
      queuedWrite = undefined;
      writeTimer = undefined;
      if (!pending) return;
      const { id, entry } = pending;
      if (!entry.hash || encryptedEntries.get(id) !== entry || currentEntryId() !== id || selectedAccount() !== entry.account ||
          (location.hash !== entry.originalHash && location.hash !== entry.hash)) { pending.resolve(false); return; }
      try {
        history.replaceState({ [ENTRY_KEY]: id }, '', location.pathname + location.search + entry.hash);
        lastHistoryWrite = Date.now();
        entry.failures = 0;
        forgetCommittedCipher(id, entry);
        activeHash = entry.hash;
        activeEntry = id;
        if (entry.revision === routeRevision && snapshot.phase === 'unlocked' && isUnlocked()) publish({ urlSaved: true, urlError: '' });
        pending.resolve(true);
      } catch {
        if (snapshot.phase === 'unlocked' && isUnlocked()) publish({ urlSaved: false, urlError: 'Could not save this view in the URL. Keep this page open to retain unfinished edits.' });
        pending.resolve(false);
        if ((entry.failures = (entry.failures || 0) + 1) <= 3) {
          retryHistoryAfter = Date.now() + 1000 * entry.failures;
          void writeCipher(id, entry);
        }
      }
    }, Math.max(0, 250 - (Date.now() - lastHistoryWrite), retryHistoryAfter - Date.now()));
  });
}
export function navigate(patch: Partial<Route>, replace = false) {
  if (!isUnlocked() || snapshot.phase !== 'unlocked' || !sealRoute) return;
  const route = { ...snapshot.route, ...patch };
  if (route.view !== "board") delete route.focus;
  const revision = ++routeRevision, epoch = snapshot.epoch, account = selectedAccount();
  // Start encryption while the key is present. A lock can discard the UI
  // immediately while this latest ciphertext finishes saving to the URL.
  const encrypted = sealRoute(route);
  let id: string;
  try { id = reserveEntry(!replace); }
  catch {
    void encrypted.catch(() => {});
    untrackedDraft = !!route.editor || Object.keys(route.quickAdd || {}).length > 0;
    publish({ route, urlSaved: false, urlError: 'Could not save this view in the URL. Keep this page open to retain unfinished edits.' });
    return;
  }
  activeEntry = id;
  activeHash = location.hash;
  const entry: EncryptedEntry = {
    account, promise: encrypted, originalHash: location.hash, revision,
    draft: !!route.editor || Object.keys(route.quickAdd || {}).length > 0,
    inHistory: false, inSession: false,
  };
  encryptedEntries.set(id, entry);
  untrackedDraft = false;
  publish({ route, urlSaved: false });
  void encrypted.then(hash => {
    if (encryptedEntries.get(id) !== entry) return;
    entry.hash = hash;
    cacheCipher(id, entry);
    void writeCipher(id, entry);
  }).catch(() => {
    if (revision === routeRevision && epoch === snapshot.epoch && isUnlocked())
      publish({ urlError: 'Could not save this view in the URL. Keep this page open to retain unfinished edits.', urlSaved: false });
  });
}

async function restoreRoute(opening = false) {
  if (!isUnlocked()) return;
  const revision = ++routeRevision, epoch = snapshot.epoch, account = selectedAccount();
  let id: string;
  try { id = reserveEntry(); } catch { id = ''; }
  const sourceHash = location.hash;
  activeEntry = id;
  activeHash = sourceHash;
  // A pending target must not leave controls from the outgoing entry editable.
  publish({ phase: 'loading', urlSaved: false });
  const current = () => revision === routeRevision && epoch === snapshot.epoch && isUnlocked() && account === selectedAccount() && (!id || currentEntryId() === id);
  let hash = sourceHash;
  loadCipherCache();
  let entry = encryptedEntries.get(id);
  if (!entry || entry.account !== account || (sourceHash !== entry.originalHash && sourceHash !== entry.hash)) entry = undefined;
  const cached = cachedCiphers.get(id);
  const cachedHash = cached && (sourceHash === cached.hash || sourceHash === cached.previous || (!cached.previous && !sourceHash.startsWith('#state='))) ? cached.hash : undefined;
  const pendingHash = entry ? await entry.promise.catch(() => '') : cachedHash;
  if (!current() || (location.hash !== sourceHash && location.hash !== pendingHash)) return;
  if (pendingHash) {
    hash = pendingHash;
    if (!entry) {
      entry = { account, promise: Promise.resolve(hash), hash, originalHash: sourceHash, revision, draft: false, inHistory: location.hash === hash, inSession: true };
      encryptedEntries.set(id, entry);
    }
    entry.revision = revision;
    // The encryption completion may also have queued this same write. Await
    // the coalesced write before rendering the restored target.
    await writeCipher(id, entry);
    if (!current() || (location.hash !== sourceHash && location.hash !== hash)) return;
  }
  const restored = await withVaultKey(async (key, userId, vaultId) => ({
    route: hash.startsWith('#state=') ? await decryptRoute(hash, key, userId, vaultId) : readRoute(hash),
    seal: (route: Route) => encryptRoute(route, key, userId, vaultId),
  })).catch(() => null);
  if (!restored) return;
  const { route } = restored;
  if (!current() || (location.hash !== sourceHash && location.hash !== hash)) return;
  activeHash = location.hash;
  sealRoute = restored.seal;
  // Remove readable legacy filters before the asynchronous encrypted replacement.
  if (!hash.startsWith('#state=')) {
    activeHash = routeHash(route);
    history.replaceState(id ? { [ENTRY_KEY]: id } : null, '', location.pathname + location.search + activeHash);
    lastHistoryWrite = Date.now();
  }
  const saved = hash.startsWith('#state=') && location.hash === hash;
  untrackedDraft = false;
  publish({ phase: 'unlocked', route, routeEpoch: snapshot.routeEpoch + 1, urlSaved: saved, urlError: !saved && hash.startsWith('#state=') ? 'Could not save this view in the URL. Keep this page open to retain unfinished edits.' : '' });
  if (!hash.startsWith('#state=')) navigate({}, true);
  if (opening) void refresh();
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
      syncComplete: !!local.syncComplete,
      connection: local.authRequired
        ? `Sign in to sync · ${local.pending.length} pending`
        : local.error
          ? `Sync paused · ${local.pending.length} pending`
          : local.pending.length
            ? `${local.pending.length} changes saved on this device`
            : local.online && !local.syncComplete
              ? "Syncing tasks…"
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
  const stopAutoLock = startAutoLock(isUnlocked, lock);
  const abort = new AbortController(),
    options = { signal: abort.signal };
  const realtime = createRealtime({
    sync: syncAfterCurrent,
    needsRetry: async () => {
      const files = await fileState();
      return !!files.error || !!files.deletions.length || Object.values(files.files).some(file => !!file.pending || !!file.error);
    },
    localState,
    url: location.href,
  });
  const locked = () => {
    sealRoute = null;
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
        syncComplete: false,
        urlSaved: false,
        urlError: '',
      }),
    );
  };
  const opened = () => {
    publish({ phase: 'loading' });
    void restoreRoute(true);
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
  const locationChanged = () => {
    if (isUnlocked() && (location.hash !== activeHash || currentEntryId() !== activeEntry)) void restoreRoute(snapshot.phase === 'loading');
  };
  window.addEventListener('hashchange', locationChanged, options);
  window.addEventListener('popstate', locationChanged, options);
  window.addEventListener('beforeunload', event => {
    if (untrackedDraft || [...encryptedEntries.values()].some(entry => entry.draft && !entry.inHistory && !entry.inSession)) {
      event.preventDefault();
      event.returnValue = '';
    }
  }, options);
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
