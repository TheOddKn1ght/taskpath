import type {Task} from '../types.d.ts';
import {Icon} from './icons.tsx';
import {dateLabel} from './board.tsx';
export function ReminderPanel({tasks,busy,edit,act}:{tasks:Task[];busy:boolean;edit:(task:Task)=>void;act:(task:Task,action:'snooze'|'dismiss')=>void}) {
  return (
    <section
      id="reminder-panel"
      className="reminder-panel"
      aria-label="Due reminders"
    >
      {tasks.map((t) => (
        <div className="reminder-row flex items-center gap-3 py-[10px]" key={t.id}>
          <Icon name="bell" />
          <button className="reminder-open min-w-0 flex-1 text-left p-0" onClick={() => edit(t)}>
            <strong>{t.title}</strong>
            <span>{dateLabel(t.reminderAt)}</span>
          </button>
          {(["snooze", "dismiss"] as const).map((action) => (
            <button
              key={action}
              className="subtle-button"
              disabled={busy}
              onClick={() => act(t,action)}
            >
              {action === "snooze" ? "Snooze 10m" : "Dismiss"}
            </button>
          ))}
        </div>
      ))}
    </section>

  );
}
