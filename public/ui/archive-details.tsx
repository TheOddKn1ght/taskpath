import type {Task} from '../types.d.ts';
import {Dialog} from './dialog.tsx';
import {columns} from './store.ts';
import {dateLabel} from './board.tsx';
export function ArchiveDetails({task,close,remove,restore}:{task:Task;close:()=>void;remove:()=>void;restore:()=>void}) { return (
    <Dialog
      id="archive-details-dialog"
      title="Archived task"
      onClose={close}
    >
      <div id="archive-details-content">
        <h3>{task.title}</h3>
        <p className="text-muted text-[12px] leading-[1.6]">
          {columns[task.status]} · {task.category} · Archived{" "}
          {dateLabel(task.archivedAt)}
        </p>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{task.notes}</p>
        <p>Tags: {task.tags.join(", ")}</p>
        {task.dueDate && <p>Due: {task.dueDate}</p>}
        {task.reminderAt && (
          <p>
            Reminder: {dateLabel(task.reminderAt)} (
            {task.reminderDismissedAt
              ? "dismissed"
              : "paused while archived"}
            )
          </p>
        )}
      </div>
      <div className="dialog-actions">
        <button
          className="subtle-button danger"
          onClick={remove}
        >
          Delete task
        </button>
        <button
          className="primary-button"
          onClick={restore}
        >
          Restore task
        </button>
      </div>
    </Dialog>

  );
}
