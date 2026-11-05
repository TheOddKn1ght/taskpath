import { apiRequest } from '/assets/__TASKPATH_RELEASE__/api-client.js';
import type { VaultConfig } from '../public/types.js';
import {
  activate,
  localState,
  lock,
  switchAccount,
  isUnlocked,
} from '/assets/__TASKPATH_RELEASE__/offline.js';
import { unlockVault } from '/assets/__TASKPATH_RELEASE__/crypto.js';
import {
  addFile,
  listFiles,
  readStoredFile,
  renameStoredFile,
  deleteStoredFile,
} from '/assets/__TASKPATH_RELEASE__/file-client.js';
import { fileState, fileBlob, writeFiles } from '/assets/__TASKPATH_RELEASE__/file-persistence.js';
import { syncFiles } from '/assets/__TASKPATH_RELEASE__/file-sync.js';
export async function fileChecks(assert: (value: unknown, message: string) => void) {
  const nativeFetch = window.fetch.bind(window);
  let offline = false,
    full = false,
    loseReply = false,
    failBefore = false;
  let manifestReads = 0;
  let rejectLargeUpload = false;
  const uploads: Uint8Array[] = [];
  window.fetch = async (input, init) => {
    if (String(input).split('?')[0] === '/api/files' && (!init?.method || init.method === 'GET'))
      manifestReads++;
    if (String(input).startsWith('/api/files')) {
      if (offline) throw new TypeError('Simulated offline files');
      if (init?.method === 'PUT') {
        uploads.push(new Uint8Array(init.body as Uint8Array));
        if (failBefore) {
          failBefore = false;
          throw new TypeError('Interrupted before server commit');
        }
        if (full) return new Response('{}', { status: 507 });
        if (rejectLargeUpload && (init.body as Uint8Array).length > 4096)
          return new Response(JSON.stringify({ error: 'File exceeds the new file limit.' }), {
            status: 413,
          });
        if (loseReply) {
          loseReply = false;
          await nativeFetch(input, init);
          throw new TypeError('Lost upload acknowledgement');
        }
      }
    }
    return nativeFetch(input, init);
  };
  try {
    const { userId, secondUserId } = await apiRequest<{ userId: string; secondUserId: string }>(
      '/test-account?fresh=1',
    );
    await switchAccount(secondUserId);
    const config = (
      await apiRequest<{ config: VaultConfig }>('/api/auth/config?userId=' + secondUserId)
    ).config;
    const unlocked = await unlockVault('browser second password 2026', config);
    const login = () =>
      apiRequest('/api/auth/login', 'POST', {
        userId: secondUserId,
        credential: unlocked.credential,
        revision: config.revision,
      });
    const activateAgain = () => activate(config, unlocked.key, false, epoch);
    let epoch = (await localState()).lockEpoch;
    await login();
    await activateAgain();
    await syncFiles();
    manifestReads = 0;
    await syncFiles();
    assert(manifestReads === 1, 'unchanged file sync reads its manifest only once');
    // The last synchronized allowance also controls offline file additions.
    const previousQuota = (await fileState(secondUserId)).quota;
    offline = true;
    await writeFiles(secondUserId, epoch, (s) => {
      s.quota = { quotaBytes: 50_000_000, usedBytes: 0, maxFileBytes: 20_000_000 };
    });
    await addFile(new File([new Uint8Array(10_000_001)], 'large.bin'));
    const large = Object.values((await fileState(secondUserId)).files).find(
      (f) => f.bytes === 10_000_001,
    )!;
    assert(
      large && (await readStoredFile(large.envelope.fileId)).bytes.length === 10_000_001,
      'custom per-file allowance accepts and decrypts files larger than 10 MB offline',
    );
    await deleteStoredFile(large.envelope.fileId);
    await writeFiles(secondUserId, epoch, (s) => {
      s.quota = { quotaBytes: 50_000_000, usedBytes: 0, maxFileBytes: 1_000_000 };
    });
    let limitError = '';
    try {
      await addFile(new File([new Uint8Array(1_000_001)], 'too-large.bin'));
    } catch (error) {
      limitError = (error as Error).message;
    }
    assert(limitError.includes('1 MB'), 'file-size error reports the synchronized per-file limit');
    await writeFiles(secondUserId, epoch, (s) => {
      s.quota = previousQuota;
    });
    offline = false;
    const marker = 'FILE_VAULT_PRIVATE_CONTENT_2026',
      name = 'FILE_PRIVATE_NAME_2026.txt';
    offline = true;
    await addFile(new File([marker], name, { type: 'text/plain', lastModified: 123 }));
    await syncFiles();
    let state = await fileState(secondUserId),
      id = Object.keys(state.files)[0];
    assert(
      state.files[id].pending === 'upload' && state.files[id].cached,
      'offline file upload is committed locally before sync',
    );
    assert(
      !JSON.stringify(state).includes(name) && !JSON.stringify(state).includes(marker),
      'file records contain encrypted names and contents only',
    );
    const ciphertext = await fileBlob(secondUserId, id),
      envelope = JSON.stringify(state.files[id].envelope);
    assert(
      ciphertext && !new TextDecoder().decode(ciphertext).includes(marker),
      'IndexedDB file BLOB contains ciphertext',
    );
    assert(
      new TextDecoder().decode((await readStoredFile(id)).bytes) === marker,
      'unsynced file downloads work offline',
    );
    await lock();
    assert(!isUnlocked(), 'file vault locks with the task vault');
    let denied = false;
    try {
      await readStoredFile(id);
    } catch {
      denied = true;
    }
    assert(denied, 'locked file reads cannot decrypt');
    epoch = (await localState()).lockEpoch;
    await activateAgain();
    assert(
      new TextDecoder().decode((await readStoredFile(id)).bytes) === marker,
      'offline unlock recovers file contents',
    );
    await syncFiles();
    assert(
      JSON.stringify((await fileState()).files[id].envelope) === envelope,
      'failed file retries preserve encrypted envelope and operation identity',
    );
    offline = false;
    failBefore = true;
    loseReply = true;
    await syncFiles();
    await syncFiles();
    await syncFiles();
    state = await fileState();
    assert(
      state.files[id].uploaded && !state.files[id].pending,
      'reconnect acknowledges file uploads after a lost response',
    );
    assert(
      uploads.length >= 2 &&
        uploads[0].length === uploads[1].length &&
        uploads[0].every((b, i) => b === uploads[1][i]),
      'upload retries reuse byte-identical ciphertext',
    );
    const manifest = await (
      await nativeFetch('/api/files', { headers: { 'x-taskpath-user': secondUserId } })
    ).json();
    assert(manifest.usedBytes === marker.length, 'retried upload consumes quota exactly once');
    offline = true;
    await renameStoredFile(id, 'RENAMED_PRIVATE_FILE.txt');
    await syncFiles();
    assert(
      (await listFiles()).files[0].details.name === 'RENAMED_PRIVATE_FILE.txt',
      'offline rename updates decrypted file list',
    );
    const afterRename = await fileBlob(secondUserId, id);
    assert(
      afterRename?.every((b, i) => b === ciphertext![i]),
      'renaming does not rewrite the file ciphertext',
    );
    const socket = new WebSocket(
      location.origin.replace(/^http/, 'ws') + '/api/events?userId=' + secondUserId,
    );
    const socketMessage = (type: string) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.removeEventListener('message', handler);
          reject(new Error('File WebSocket notification timeout'));
        }, 10000);
        function handler(event: MessageEvent) {
          if (JSON.parse(event.data).type === type) {
            clearTimeout(timeout);
            socket.removeEventListener('message', handler);
            resolve();
          }
        }
        socket.addEventListener('message', handler);
      });
    await socketMessage('ready');
    const changed = socketMessage('changed');
    try {
      offline = false;
      await syncFiles();
      await changed;
      assert(true, 'encrypted file rename emits a real account-scoped WebSocket notification');
    } finally {
      socket.close();
    }
    await writeFiles(secondUserId, (await localState()).lockEpoch, (s, b) => {
      s.files[id].cached = false;
      b.delete([secondUserId, id]);
    });
    await lock();
    const worker = new Worker('/worker.js', { type: 'module' });
    const result = await new Promise<{ unlocked: boolean; remembered: unknown }>(
      (resolve, reject) => {
        worker.onmessage = (e) =>
          e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
        worker.onerror = reject;
      },
    );
    worker.terminate();
    assert(
      !result.unlocked && result.remembered === null && (await fileState()).files[id].cached,
      'locked worker downloads ciphertext without loading keys',
    );
    epoch = (await localState()).lockEpoch;
    await activateAgain();
    assert(
      (await readStoredFile(id)).details.name === 'RENAMED_PRIVATE_FILE.txt',
      'worker-cached file decrypts after unlocking',
    );
    offline = true;
    await Promise.all([
      addFile(new File(['a'], 'concurrent-a.txt')),
      addFile(new File(['b'], 'concurrent-b.txt')),
    ]);
    await syncFiles();
    assert(
      Object.keys((await fileState()).files).length === 3,
      'overlapping local uploads preserve both files',
    );
    const beforeFailure = JSON.stringify(await fileState()),
      failureId = crypto.randomUUID();
    let storageFailed = false;
    try {
      await writeFiles(secondUserId, (await localState()).lockEpoch, (s, b) => {
        s.deletions.push(failureId);
        b.put(new Uint8Array([1]), [secondUserId, failureId]);
        throw new DOMException('Storage quota exhausted', 'QuotaExceededError');
      });
    } catch {
      storageFailed = true;
    }
    assert(
      storageFailed &&
        JSON.stringify(await fileState()) === beforeFailure &&
        !(await fileBlob(secondUserId, failureId)),
      'storage failure aborts file metadata and BLOB writes together',
    );
    const frame = document.createElement('iframe');
    frame.src = '/frame';
    const message = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          window.removeEventListener('message', handler);
          reject(new Error('File frame timeout'));
        }, 10000);
        function handler(event: MessageEvent) {
          if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
          if (event.data === name || event.data?.error) {
            clearTimeout(timeout);
            window.removeEventListener('message', handler);
            event.data?.error ? reject(new Error(event.data.error)) : resolve();
          }
        }
        window.addEventListener('message', handler);
      });
    const ready = message('ready');
    document.body.append(frame);
    await ready;
    const edited = message('file-edited');
    frame.contentWindow!.postMessage('file-edit', location.origin);
    await addFile(new File(['parent'], 'parent-concurrent.txt'));
    await edited;
    frame.remove();
    assert(
      Object.keys((await fileState()).files).length === 5,
      'concurrent browser contexts preserve independent file uploads',
    );
    offline = false;
    full = true;
    await syncFiles();
    state = await fileState();
    const waiting = Object.values(state.files).find((f) => f.pending === 'upload')!;
    assert(
      waiting.cached && Object.values(state.files).some((f) => f.error === 'Waiting for space'),
      'quota rejection keeps pending encrypted files on the device',
    );
    assert(
      (await readStoredFile(waiting.envelope.fileId)).bytes.length === 1,
      'quota-blocked files remain downloadable',
    );
    full = false;
    await syncFiles();
    assert(
      Object.values((await fileState()).files).every((f) => !f.pending),
      'pending files resume when space becomes available',
    );
    offline = true;
    await addFile(new File([new Uint8Array(8192)], 'queued-before-limit-change.bin'));
    await addFile(new File(['small'], 'within-new-limit.txt'));
    await syncFiles();
    const queued = (await listFiles()).files;
    const blocked = queued.find((f) => f.details.name === 'queued-before-limit-change.bin')!;
    const allowed = queued.find((f) => f.details.name === 'within-new-limit.txt')!;
    // Also prove that a rejected upload cannot starve downloads of retained files.
    await writeFiles(secondUserId, epoch, (s, b) => {
      s.files[id].cached = false;
      b.delete([secondUserId, id]);
    });
    rejectLargeUpload = true;
    offline = false;
    await syncFiles();
    state = await fileState();
    assert(
      state.files[blocked.envelope.fileId].pending === 'upload' &&
        state.files[blocked.envelope.fileId].error?.includes('413') &&
        (await readStoredFile(blocked.envelope.fileId)).bytes.length === 8192,
      'size rejection preserves the queued file, its error, and downloadable local bytes',
    );
    assert(
      state.files[allowed.envelope.fileId].uploaded &&
        !state.files[allowed.envelope.fileId].pending &&
        state.files[id].cached,
      'size rejection does not block other uploads or retained file downloads',
    );
    rejectLargeUpload = false;
    await syncFiles();
    assert(
      !(await fileState()).files[blocked.envelope.fileId].pending &&
        !(await fileState()).files[blocked.envelope.fileId].error,
      'size-blocked uploads resume and clear their error when the limit permits them',
    );
    await deleteStoredFile(blocked.envelope.fileId);
    await deleteStoredFile(allowed.envelope.fileId);
    await syncFiles();
    await apiRequest('/api/auth/logout', 'POST', {});
    offline = true;
    await renameStoredFile(id, 'AFTER_EXPIRY.txt');
    await syncFiles();
    offline = false;
    await syncFiles();
    assert(
      (await fileState()).files[id].pending === 'rename' &&
        (await fileState()).error?.includes('Sign in'),
      'session expiry retains pending file metadata',
    );
    await login();
    await syncFiles();
    offline = true;
    await renameStoredFile(id, 'STALE_RENAME.txt');
    await syncFiles();
    await nativeFetch('/api/files/' + id, {
      method: 'DELETE',
      headers: { 'x-taskpath-user': secondUserId, 'content-type': 'application/json' },
      body: '{}',
    });
    offline = false;
    await syncFiles();
    assert(
      !(await fileState()).files[id] && !(await fileBlob(secondUserId, id)),
      'remote deletion wins over an offline rename and removes cached bytes',
    );
    const remaining = Object.keys((await fileState()).files);
    offline = true;
    await deleteStoredFile(remaining[0]);
    await syncFiles();
    assert(
      (await fileState()).deletions.includes(remaining[0]),
      'offline deletion retains an idempotent server tombstone request',
    );
    offline = false;
    await syncFiles();
    assert(!(await fileState()).deletions.length, 'reconnect acknowledges queued deletions');
    const pending = JSON.stringify(await fileState());
    await switchAccount(userId);
    assert(
      !isUnlocked() && !Object.keys((await fileState()).files).length,
      'account switching hides the previous file vault',
    );
    await syncFiles();
    assert(
      JSON.stringify(await fileState(secondUserId)) === pending,
      'another account cannot consume or acknowledge the prior file queue',
    );
    await switchAccount(secondUserId);
    epoch = (await localState()).lockEpoch;
    await activateAgain();
    assert(
      (await listFiles()).files.length === 3,
      'returning to an account preserves its cached files',
    );
    for (const fileId of remaining.slice(1)) await deleteStoredFile(fileId);
    await syncFiles();
  } finally {
    window.fetch = nativeFetch;
  }
}
