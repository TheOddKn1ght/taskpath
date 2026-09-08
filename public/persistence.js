// Only ciphertext and public metadata belong in this store. Keys live separately;
// service workers never open or read the keys store.
export const DB_NAME = 'taskpath-encrypted-v1';
let database;
export const empty = () => ({ revision: 0, lockEpoch: 0, config: null, board: null, pending: [], offset: 0, lastEdit: 0 });
export function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('state'); request.result.createObjectStore('keys'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Device storage is unavailable. Enable browser storage to save encrypted changes.'));
  });
  return database;
}
export async function localState(update) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', update ? 'readwrite' : 'readonly');
    const store = tx.objectStore('state'); let value, problem;
    const request = store.get('workspace');
    request.onsuccess = () => {
      value = request.result || empty();
      try { if (update) { update(value); value.revision++; store.put(value, 'workspace'); } }
      catch (error) { problem = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = tx.onerror = () => reject(problem || tx.error || new Error('Could not save encrypted changes. Device storage may be full.'));
  });
}
export async function commit(expectedRevision, next) {
  let saved = false;
  await localState(current => {
    if (current.revision !== expectedRevision) return;
    Object.assign(current, next); saved = true;
  });
  return saved;
}
export async function rememberedKey() {
  if (typeof window === 'undefined') return null;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys');
    const request = tx.objectStore('keys').get('vault');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
export async function saveUnlock(config, key, remember, expectedEpoch) {
  if (typeof window === 'undefined') throw new Error('Only a page can unlock.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['state', 'keys'], 'readwrite'); let problem;
    const state = tx.objectStore('state'), keys = tx.objectStore('keys');
    const request = state.get('workspace');
    request.onsuccess = () => {
      const record = request.result || empty();
      if (record.lockEpoch !== expectedEpoch || (record.config && (record.config.vaultId !== config.vaultId || record.config.revision > config.revision))) {
        problem = new Error('Workspace was locked or changed. Try unlocking again.'); tx.abort(); return;
      }
      record.config = config; record.revision++;
      state.put(record, 'workspace');
      if (remember) keys.put({ key, vaultId: config.vaultId, lockEpoch: record.lockEpoch }, 'vault');
      else keys.delete('vault');
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(problem || tx.error);
  });
}
export async function forgetKeys() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['state', 'keys'], 'readwrite');
    tx.objectStore('keys').clear();
    const state = tx.objectStore('state'), request = state.get('workspace');
    request.onsuccess = () => { const value = request.result || empty(); value.lockEpoch++; value.revision++; state.put(value, 'workspace'); };
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
