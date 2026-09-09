import { importTaskKey } from './tags.js';
import { project, queueChange, queueArchiveBatch, validate } from './offline-model.js';
import { exportMarkdown } from './export-markdown.js';
import { parseMarkdown } from './markdown.js';
import { decryptEnvelope, encryptChange, validateConfig, validateEnvelope, PROFILE_ID, normalizeNickname } from './crypto.js';
import { localState, commit, rememberedKey, saveUnlock, forgetKeys, selectedAccount, selectAccount, loadAccount } from './persistence.js';
export { localState, selectedAccount } from './persistence.js';
let vaultKey = null, epoch = -1, generation = 0;
const page = typeof window !== 'undefined';
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('taskpath-accounts-v1') : null;
const emit = name => { if (page) window.dispatchEvent(new Event(name)); };
function changed() { channel?.postMessage('changed'); emit('taskpath-storage'); }
export const isUnlocked = () => Boolean(vaultKey);
export function clearMemory() { vaultKey = null; generation++; emit('taskpath-locked'); }
if (page && channel) channel.onmessage = async event => {
  if (event.data === 'account') { clearMemory(); await loadAccount(); emit('taskpath-locked'); return; }
  if (event.data === 'lock') clearMemory();
  const record = await localState();
  if (vaultKey && epoch !== record.lockEpoch) clearMemory();
  emit('taskpath-storage');
};
export async function lock() {
  clearMemory();
  try { await forgetKeys(); }
  catch (error) { if (page) window.dispatchEvent(new CustomEvent('taskpath-lock-error', { detail: 'The page is locked, but this browser could not remove its remembered key. Do not rely on reload locking until browser storage is available.' })); throw error; }
  finally { channel?.postMessage('lock'); }
}
if (page) {
  window.addEventListener('pagehide', clearMemory);
  window.addEventListener('pageshow', event => { if (event.persisted) clearMemory(); });
}
export async function activate(config, key, remember, expectedEpoch) {
  const started = generation;
  validateConfig(config);
  await saveUnlock(config, key, remember, expectedEpoch);
  // A lock in another tab between the commit and here must win.
  const record = await localState();
  if (started !== generation || record.lockEpoch !== expectedEpoch || record.inactive) throw new Error('Workspace was locked. Try again.');
  vaultKey = key; epoch = expectedEpoch; generation++;
  emit('taskpath-unlocked');
}
export async function restoreRemembered() {
  const before = generation, record = await localState(), remembered = await rememberedKey();
  const current = await localState();
  if (current.inactive || current.userId !== remembered?.userId || current.lockEpoch !== record.lockEpoch || before !== generation || !remembered || remembered.lockEpoch !== record.lockEpoch || remembered.vaultId !== record.config?.vaultId || remembered.key.extractable) return false;
  vaultKey = remembered.key; epoch = record.lockEpoch; generation++;
  return true;
}
function assertUnlocked(record, token = generation) {
  if (record.inactive || !vaultKey || token !== generation || epoch !== record.lockEpoch) {
    if (vaultKey && token === generation && (record.inactive || epoch !== record.lockEpoch)) clearMemory();
    const error = new Error('Unlock your workspace to continue.'); error.status = 423; throw error;
  }
}
export async function switchAccount(userId) {
  clearMemory();
  await selectAccount(userId);
  channel?.postMessage('account');
  emit('taskpath-locked');
}
export async function network(path, method = 'GET', body, userId = selectedAccount()) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(userId ? { 'X-Taskpath-User': userId } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    let message = response.status === 401 ? 'Sign in to sync. Encrypted changes are saved on this device.' : 'Could not complete the request. Your encrypted changes are safe on this device.';
    try { message = (await response.json()).error || message; } catch { /* Proxy error. */ }
    const error = new Error(message); error.status = response.status; throw error;
  }
  return response.json();
}
const newer = (a, b) => !b || a.editedAt > b.editedAt || (a.editedAt === b.editedAt && a.changeId > b.changeId);
export function acceptEncrypted(record, response, now = Date.now()) {
  if (response.format !== 1 || !Array.isArray(response.rows) || response.workspaceKey !== record.config?.vaultId) {
    const error = new Error('This server has a different or unsupported workspace. Local encrypted changes were kept.'); error.status = 409; throw error;
  }
  new Intl.DateTimeFormat('en', { timeZone: response.timezone });
  if (!Number.isFinite(Date.parse(response.serverTime))) throw new Error('Invalid server time.');
  for (const e of response.rows) validateEnvelope(e, record.config.vaultId);
  const rows = new Map((record.board?.rows || []).map(e => [e.taskId, e]));
  for (const e of response.rows) if (newer(e, rows.get(e.taskId))) rows.set(e.taskId, e);
  const ack = new Set(response.acknowledged || []);
  record.pending = record.pending.filter(e => !ack.has(e.changeId));
  record.board = { format: 1, workspaceKey: response.workspaceKey, timezone: response.timezone, serverTime: response.serverTime, rows: [...rows.values()] };
  record.offset = Date.parse(response.serverTime) - now;
  record.lastEdit = Math.max(record.lastEdit || 0, ...response.rows.map(e => Date.parse(e.editedAt)));
  record.online = true; record.authRequired = false; record.error = null; record.conflicts = response.conflicts || 0;
}
let syncing;
export async function syncAfterCurrent() { if (syncing) try { await syncing; } catch {} return sync(); }
export function sync() {
  if (syncing) return syncing;
  const run = async () => {
    if (!page) await loadAccount();
    const userId = selectedAccount();
    if (!userId || !(await localState(undefined, userId)).config) return;
    try {
      for (let batch = 0; batch < 20; batch++) {
        const record = await localState(undefined, userId), changes = []; let bytes = 0;
        if (record.inactive) return;
        for (const change of record.pending.slice(0, 50)) {
          const size = new TextEncoder().encode(JSON.stringify(change)).length;
          if (changes.length && bytes + size > 1024 * 1024) break;
          changes.push(change); bytes += size;
        }
        const response = await network('/api/sync', changes.length ? 'POST' : 'GET', changes.length ? { workspaceKey: record.config.vaultId, changes } : undefined, userId);
        await localState(current => acceptEncrypted(current, response), userId);
        changed();
        if (!changes.length || !(await localState()).pending.length) return;
      }
    } catch (error) {
      await localState(record => { record.online = Boolean(error.status); record.authRequired = error.status === 401; record.error = error.status && error.status !== 401 ? error.message : null; }, userId).catch(() => {});
      changed(); throw error;
    }
  };
  syncing = (globalThis.navigator?.locks ? navigator.locks.request('taskpath-accounts-sync', run) : run()).finally(() => { syncing = null; });
  return syncing;
}
async function plaintext(record, token) {
  assertUnlocked(record, token);
  const key = vaultKey, vaultId = record.config.vaultId;
  const rows = await Promise.all((record.board?.rows || []).map(e => decryptEnvelope(key, vaultId, e)));
  const pending = await Promise.all(record.pending.map(async e => ({ task: await decryptEnvelope(key, vaultId, e), changeId: e.changeId, editedAt: e.editedAt })));
  const all = [...rows, ...pending.map(c => c.task)];
  for (const task of all) { if (task.id === PROFILE_ID) normalizeNickname(task.nickname); else validate(task); }
  const profiles = [...record.board.rows.map((e, i) => ({ envelope: e, task: rows[i] })), ...record.pending.map((e, i) => ({ envelope: e, task: pending[i].task }))].filter(p => p.task.id === PROFILE_ID);
  const profile = profiles.reduce((best, next) => newer(next.envelope, best?.envelope) ? next : best, null)?.task;
  assertUnlocked(await localState(), token);
  return { ...record, nickname: profile?.nickname || '', board: { ...record.board, changeIds: Object.fromEntries(record.board.rows.map(e => [e.taskId, e.changeId])), rows: rows.filter(t => t.id !== PROFILE_ID) }, pending: pending.filter(c => c.task.id !== PROFILE_ID), locked: false };
}
export async function readBoard() {
  const token = generation; let record = await localState(); assertUnlocked(record, token);
  if (!record.board) { await syncAfterCurrent(); record = await localState(); }
  if (!record.board) throw new Error('Connect once to download this workspace.');
  const decoded = await plaintext(record, token);
  return { ...project(decoded), nickname: decoded.nickname, userId: record.userId };
}
let writing = Promise.resolve();
async function write(operation) {
  const token = generation;
  const run = async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await localState(); assertUnlocked(current, token);
      if (!current.board) throw new Error('Connect once to download your workspace.');
      const decoded = await plaintext(current, token), count = decoded.pending.length;
      const result = operation(decoded);
      const pending = [...current.pending];
      for (const change of decoded.pending.slice(count)) pending.push(await encryptChange(vaultKey, current.config.vaultId, change));
      assertUnlocked(await localState(), token);
      if (await commit(current.revision, { ...current, pending, lastEdit: decoded.lastEdit })) { changed(); return result; }
    }
    throw new Error('Another tab is updating. Please try again.');
  };
  const next = writing.catch(() => {}).then(() => globalThis.navigator?.locks ? navigator.locks.request('taskpath-accounts-edit', run) : run());
  writing = next.then(() => {}, () => {});
  const result = await next;
  if (page) {
    try { const registration = await navigator.serviceWorker?.getRegistration(); await registration?.sync?.register('taskpath-accounts-sync'); } catch {}
    void sync().catch(() => {});
  }
  return result;
}
export function previewImport(tasks, record, now = Date.now()) {
  if (!Array.isArray(tasks) || tasks.length > 500) throw new Error('Import up to 500 tasks at a time.');
  const copy = structuredClone(record), seen = new Set(project(copy, now).tasks.map(importTaskKey));
  const result = []; let skipped = 0;
  for (const input of tasks) {
    const task = queueChange(copy, '/api/tasks', 'POST', input, now).task;
    const key = importTaskKey(task);
    if (seen.has(key)) skipped++; else { seen.add(key); result.push(task); }
  }
  return { tasks: result, skipped };
}
export async function offlineRequest(path, method = 'GET', body) {
  const token = generation; assertUnlocked(await localState(), token);
  if (path === '/api/board' && method === 'GET') return readBoard();
  if (path.startsWith('/api/export')) {
    const board = await readBoard();
    return path.includes('format=markdown') ? exportMarkdown(board.tasks) : { version: 2, exportedAt: new Date().toISOString(), timezone: board.timezone, tasks: board.tasks };
  }
  if (path === '/api/import/preview') {
    const parsed = parseMarkdown(body.markdown), record = await plaintext(await localState(), token);
    return { ...previewImport(parsed.tasks, record), ignoredBlocks: parsed.ignoredBlocks };
  }
  if (path === '/api/reminders/claim') {
    if ((await localState()).pending.length) return { tasks: [] };
    const board = await readBoard();
    const due = board.reminders.filter(t => t.reminderToken).slice(0, 100);
    try {
      const claimed = await network(path, 'POST', { tokens: due.map(t => t.reminderToken) });
      assertUnlocked(await localState(), token);
      const current = await readBoard();
      return { tasks: current.reminders.filter(t => claimed.tokens.includes(t.reminderToken)) };
    } catch { return { tasks: [] }; }
  }
  if (method === 'GET') throw new Error('Unsupported task operation.');
  return write(record => {
    if (path === '/api/profile') {
      const nickname = normalizeNickname(body.nickname);
      const editedAt = new Date(Math.max(Date.now() + (record.offset || 0), (record.lastEdit || 0) + 1)).toISOString();
      record.lastEdit = Date.parse(editedAt);
      record.pending.push({ task: { id: PROFILE_ID, updatedAt: editedAt, nickname }, changeId: crypto.randomUUID(), editedAt });
      return { nickname };
    }
    if (path === '/api/import/markdown') {
      const preview = previewImport(body.tasks, record);
      for (const task of preview.tasks) queueChange(record, '/api/tasks', 'POST', task);
      return { imported: preview.tasks.length, skipped: preview.skipped };
    }
    if (path === '/api/tasks/archive-completed' && method === 'POST') return queueArchiveBatch(record, 'completed');
    if (path === '/api/tasks/archive-undo' && method === 'POST') return queueArchiveBatch(record, 'undo', body);
    return queueChange(record, path, method, body);
  });
}
