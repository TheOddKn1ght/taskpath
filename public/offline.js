import { project, queueChange, acceptSync } from './offline-model.js';
import { exportMarkdown } from './export-markdown.js';
const DB_NAME = 'taskpath-offline-v1';
let database;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('taskpath-offline') : null;
const empty = () => ({ board: null, pending: [], offset: 0, lastEdit: 0, locked: false });
function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Device storage is unavailable. Enable browser storage to save tasks.'));
  });
  return database;
}
export async function localState(update) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('state', update ? 'readwrite' : 'readonly');
    const store = tx.objectStore('state');
    let value, problem;
    const request = store.get('workspace');
    request.onsuccess = () => {
      value = request.result || empty();
      try { if (update) { update(value); store.put(value, 'workspace'); } }
      catch (error) { problem = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = tx.onerror = () => reject(problem || tx.error || new Error('Could not save to this device. Storage may be full.'));
  });
}
function changed() {
  channel?.postMessage('changed');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('taskpath-storage'));
}
if (typeof window !== 'undefined' && channel) channel.onmessage = () => window.dispatchEvent(new Event('taskpath-storage'));
export async function network(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    let message = response.status === 401 ? 'Sign in to sync. Your changes are saved on this device.' : 'Sync is paused. Your changes are saved on this device.';
    try { message = (await response.json()).error || message; } catch { /* Proxy errors may be HTML. */ }
    const error = new Error(message); error.status = response.status; throw error;
  }
  return response.json();
}
let syncing;
export function sync() {
  if (syncing) return syncing;
  const run = async () => {
    let before = await localState();
    if (before.locked) return;
    try {
      // Each batch is acknowledged by immutable operation ID. New edits made during
      // the request survive the response, including edits from another tab.
      for (let batch = 0; batch < 20; batch++) {
        before = await localState();
        if (before.locked) return;
        const changes = [];
        let bytes = 0;
        for (const change of before.pending.slice(0, 50)) {
          const size = new TextEncoder().encode(JSON.stringify(change)).length;
          if (changes.length && bytes + size > 1024 * 1024) break;
          changes.push(change); bytes += size;
        }
        const response = await network('/api/sync', changes.length ? 'POST' : 'GET', changes.length ? { workspaceKey: before.board.workspaceKey, changes } : undefined);
        await localState(record => {
          if (record.locked) return;
          acceptSync(record, response);
          record.online = true; record.error = null; record.conflicts = response.conflicts || 0;
        });
        changed();
        if (!changes.length || !(await localState()).pending.length) return;
      }
    } catch (error) {
      await localState(record => {
        if (record.locked) return;
        record.online = Boolean(error.status);
        record.authRequired = error.status === 401;
        record.error = error.status && error.status !== 401 ? error.message : null;
      });
      changed();
      throw error;
    }
  };
  syncing = (navigator.locks ? navigator.locks.request('taskpath-network-sync', run) : run()).finally(() => { syncing = null; });
  return syncing;
}
export async function readBoard() {
  let record = await localState();
  if (record.locked) {
    const error = new Error('Sign in to open this workspace.');
    error.status = 401;
    throw error;
  }
  if (!record.board) { await sync(); record = await localState(); }
  return project(record);
}
async function scheduleSync() {
  if (typeof window === 'undefined') return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration?.sync) await registration.sync.register('taskpath-sync');
  } catch { /* Foreground retries work when Background Sync is unavailable. */ }
  void sync().catch(() => {});
}
export async function offlineRequest(path, method = 'GET', body) {
  if (path === '/api/board' && method === 'GET') return readBoard();
  if (path.startsWith('/api/export')) {
    const board = await readBoard();
    return path.includes('format=markdown') ? exportMarkdown(board.tasks) : { version: 1, exportedAt: new Date().toISOString(), ...board, rows: undefined, workspaceKey: undefined, pendingChanges: (await localState()).pending };
  }
  if (path === '/api/import/preview') {
    try { return await network(path, method, body); }
    catch (error) { if (!error.status) throw new Error('Connect to preview Markdown. Task edits and exports work offline.'); throw error; }
  }
  if (path === '/api/reminders/claim') {
    if ((await localState()).pending.length) return { tasks: [] };
    try { return await network(path, method, body); } catch { return { tasks: [] }; }
  }
  if (method === 'GET') return network(path, method, body);
  let result;
  await localState(record => {
    if (path === '/api/import/markdown') {
      if (!Array.isArray(body.tasks)) throw new Error('Preview this import first.');
      const key = t => JSON.stringify([t.title, t.notes || '', t.category || 'personal', t.status || 'later', t.dueDate || null, t.reminderAt || null, Boolean(t.reminderDismissedAt)]);
      const seen = new Set(project(record).tasks.map(key));
      let imported = 0, skipped = 0;
      for (const task of body.tasks) {
        if (seen.has(key(task))) { skipped++; continue; }
        seen.add(key(task)); queueChange(record, '/api/tasks', 'POST', task); imported++;
      }
      result = { imported, skipped };
    } else result = queueChange(record, path, method, body);
  });
  changed();
  void scheduleSync();
  return result;
}
export async function signOut() {
  // Mark locked in the same transaction as the pending check. Other tabs cannot
  // enqueue work or repopulate the local data while logout is in flight.
  await localState(record => {
    if (record.pending.length) throw new Error('Sync your pending changes before signing out.');
    record.locked = true;
  });
  try { await network('/api/auth/logout', 'POST', {}); }
  catch (error) { await localState(record => { record.locked = false; }); throw error; }
  await localState(record => Object.assign(record, empty(), { locked: true }));
  changed();
}
export async function unlockAfterLogin() {
  await localState(record => { record.locked = false; });
}
