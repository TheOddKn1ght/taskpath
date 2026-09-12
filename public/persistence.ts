import type { EncryptedRecord, VaultConfig, RememberedKey } from './types.js';
interface ActiveAccount { userId: string | null; epoch: number }
// One database, account-scoped ciphertext records, and a shared active-account
// epoch. Workers never read the separate key store.
import { validUserId } from './crypto.js';
export const DB_NAME = 'taskpath-accounts-v1';
let database: Promise<IDBDatabase> | undefined, selected: string | null = null;
export const selectedAccount = () => selected;
export const empty = (): EncryptedRecord => ({ revision: 0, lockEpoch: 0, config: null, board: null, pending: [], offset: 0, lastEdit: 0 });
export function openDatabase() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('state'); request.result.createObjectStore('keys'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Device storage is unavailable. Enable browser storage to save encrypted changes.'));
  });
  return database;
}
const activeDefault = (): ActiveAccount => ({ userId: null, epoch: 0 });
export async function loadAccount(): Promise<string | null> {
  const db = await openDatabase();
  return new Promise<string | null>((resolve, reject) => {
    const request: IDBRequest<ActiveAccount | undefined> = db.transaction('state').objectStore('state').get('active');
    request.onsuccess = () => { selected = request.result?.userId || null; resolve(selected); };
    request.onerror = () => reject(request.error);
  });
}
export async function selectAccount(userId: string | null) {
  if (userId !== null && !validUserId(userId)) throw new Error('Enter your user ID, not your nickname.');
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['state', 'keys'], 'readwrite'), state = tx.objectStore('state');
    const request = state.get('active');
    request.onsuccess = () => {
      const active = request.result || activeDefault();
      state.put({ userId, epoch: active.epoch + 1 }, 'active');
      tx.objectStore('keys').clear();
    };
    tx.oncomplete = () => { selected = userId; resolve(); };
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export async function localState(update?: (record: EncryptedRecord) => void, userId = selected) {
  const db = await openDatabase();
  return new Promise<EncryptedRecord>((resolve, reject) => {
    const tx = db.transaction('state', update ? 'readwrite' : 'readonly');
    const store = tx.objectStore('state'); let value: EncryptedRecord, problem: unknown;
    const activeRequest: IDBRequest<ActiveAccount | undefined> = store.get('active');
    activeRequest.onsuccess = () => {
      const active = activeRequest.result || activeDefault();
      const request: IDBRequest<EncryptedRecord | undefined> = store.get('workspace:' + userId);
      request.onsuccess = () => {
        value = request.result || empty();
        value.userId = userId; value.lockEpoch = active.epoch;
        value.inactive = userId !== active.userId;
        try {
          if (update) {
            if (!userId || value.inactive) throw new Error('Account changed. Encrypted pending changes were kept.');
            update(value); value.revision++; store.put(value, 'workspace:' + userId);
          }
        } catch (error) { problem = error; tx.abort(); }
      };
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = tx.onerror = () => reject(problem || tx.error || new Error('Could not save encrypted changes.'));
  });
}
export async function commit(expectedRevision: number, next: EncryptedRecord) {
  let saved = false;
  await localState(current => {
    if (current.revision !== expectedRevision || current.lockEpoch !== next.lockEpoch) return;
    Object.assign(current, next); saved = true;
  }, next.userId);
  return saved;
}
export async function rememberedKey() {
  if (typeof window === 'undefined' || !selected) return null;
  const db = await openDatabase(), userId = selected;
  return new Promise<RememberedKey | null>((resolve, reject) => {
    const request: IDBRequest<RememberedKey | undefined> = db.transaction('keys').objectStore('keys').get(userId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
export async function saveUnlock(config: VaultConfig, key: CryptoKey, remember: boolean, expectedEpoch: number) {
  if (typeof window === 'undefined' || !selected) throw new Error('Select an account first.');
  const db = await openDatabase(), userId = selected;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['state', 'keys'], 'readwrite'); let problem: unknown;
    const state = tx.objectStore('state'), keys = tx.objectStore('keys'), activeRequest = state.get('active');
    activeRequest.onsuccess = () => {
      const active = activeRequest.result || activeDefault();
      const request = state.get('workspace:' + userId);
      request.onsuccess = () => {
        const record: EncryptedRecord = request.result || empty();
        if (active.userId !== userId || active.epoch !== expectedEpoch || (record.config && (record.config.vaultId !== config.vaultId || record.config.revision > config.revision))) {
          problem = new Error('Workspace was locked or changed. Try unlocking again.'); tx.abort(); return;
        }
        record.config = config; record.revision++;
        state.put(record, 'workspace:' + userId);
        if (remember) keys.put({ key, userId, vaultId: config.vaultId, lockEpoch: active.epoch }, userId);
        else keys.delete(userId);
      };
    };
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(problem || tx.error);
  });
}
export async function forgetKeys() {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['state', 'keys'], 'readwrite');
    tx.objectStore('keys').clear();
    const state = tx.objectStore('state'), request = state.get('active');
    request.onsuccess = () => { const active = request.result || activeDefault(); active.epoch++; state.put(active, 'active'); };
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
