import { useEffect, useState } from 'react';
import type { Task } from '../types.js';
import { readTaskHistory, isUnlocked } from '../offline.js';
import { lockChoices, lockMinutes, setLockMinutes } from '../auto-lock.js';
import { Dialog } from './dialog';
import { mutate, message } from './store';
export function HistoryDialog({ close, notify }: { close: () => void; notify: (text: string) => void }) {
  const [versions, setVersions] = useState<{changeId: string; task: Task}[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void readTaskHistory().then(value => { if (active && isUnlocked()) setVersions(value); }).catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, []);
  return <Dialog id="history-dialog" title="Previous task versions" onClose={close} busy={busy}>
    <p>Versions are encrypted and kept on this device: up to five per task, 200 total, within 2 MB. Restore creates a new task in Later with no reminder, so the current task stays safe.</p>
    {versions === null && !error && <p role="status">Opening versions…</p>}
    {versions?.length === 0 && <p>No previous versions on this device yet.</p>}
    {versions?.map(({changeId, task}) => <details key={changeId}>
      <summary>{task.title} · {new Date(task.updatedAt).toLocaleString()}</summary>
      <p style={{whiteSpace: 'pre-wrap'}}>{task.notes || 'No notes'}</p>
      <p>{task.category} · {task.tags.join(', ') || 'No tags'} · Due: {task.dueDate || 'None'}{task.deletedAt ? ' · Deleted version' : ''}</p>
      <button type="button" className="secondary-button" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try {
          await mutate('/api/tasks', 'POST', {title: task.title, notes: task.notes, tags: task.tags, category: task.category, dueDate: task.dueDate, status: 'later', reminderAt: null});
          if (isUnlocked()) { notify('Previous version restored as a new task in Later.'); close(); }
        } catch (e) { if (isUnlocked()) { setError(message(e)); setBusy(false); } }
      }}>Restore as new task</button>
    </details>)}
    {error && <p role="alert" className="form-error">{error}</p>}
  </Dialog>;
}
export function AutoLockDialog({close}: {close: () => void}) {
  const [minutes, setMinutes] = useState(lockMinutes);
  const [error, setError] = useState('');
  return <Dialog id="auto-lock-dialog" title="Automatic locking" onClose={close}>
    <p>Lock this browser after inactivity, including time spent in the background. Activity in another unlocked Taskpath tab keeps it open. Locking clears remembered keys across tabs and keeps encrypted saved changes. Unsaved editor drafts are discarded when the workspace locks.</p>
    <label className="field">Lock after
      <select id="auto-lock-interval" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
        {lockChoices.map(n => <option key={n} value={n}>{n === 0 ? 'Never' : `${n} minute${n === 1 ? '' : 's'}`}</option>)}
      </select>
    </label>
    <p>This setting applies to all accounts in this browser.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="primary-button" onClick={() => {
      try { setLockMinutes(minutes); close(); } catch (e) { setError(message(e)); }
    }}>Save locking preference</button>
  </Dialog>;
}
