import { activate, localState, offlineRequest, isUnlocked } from '/assets/accounts-v17/offline.js';
import { addFile } from '/assets/accounts-v17/file-client.js';
import { loadAccount } from '/assets/accounts-v17/persistence.js';
import { unlockVault } from '/assets/accounts-v17/crypto.js';
window.addEventListener('message', async event => {
  if (event.origin !== location.origin) return;
  try {
  await loadAccount();
    if (event.data === 'file-edit') {
      const record=await localState(), unlocked=await unlockVault('browser second password 2026',record.config!);
      await activate(record.config!,unlocked.key,false,record.lockEpoch);
      const original=window.fetch;window.fetch=async()=>{throw new TypeError('Offline frame');};
      try { await addFile(new File(['frame'],'frame-concurrent.txt')); }
      finally { window.fetch=original; }
      parent.postMessage('file-edited',location.origin);
    }
    if (event.data === 'edit') {
      const record = await localState(), unlocked = await unlockVault('browser harness password 2026', record.config!);
      await activate(record.config!, unlocked.key, false, record.lockEpoch);
      await Promise.all(Array.from({ length: 4 }, (_, i) => offlineRequest('/api/tasks', 'POST', { title: `FRAME_PRIVATE_${i}` })));
      parent.postMessage('edited', location.origin);
    }
    if (event.data?.type === 'unarchive') {
      await offlineRequest(`/api/tasks/${event.data.id}/unarchive`, 'POST');
      parent.postMessage('unarchived', location.origin);
    }
    if (event.data === 'check-lock') parent.postMessage(isUnlocked() ? 'unlocked' : 'locked', location.origin);
  } catch (error) { parent.postMessage({ error: error instanceof Error ? error.message : String(error) }, location.origin); }
});
window.addEventListener('taskpath-locked', () => parent.postMessage('locked', location.origin));
parent.postMessage('ready', location.origin);
