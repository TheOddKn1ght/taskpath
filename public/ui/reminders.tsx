import { useState } from 'react';
import { snoozeOptions } from '../snooze.js';
import type { Task } from '../types.js';
import { Icon } from './icons';
import { dateLabel } from './board';
export function ReminderPanel({
  tasks,
  busy,
  edit,
  act,
}: {
  tasks: Task[];
  busy: boolean;
  edit: (task: Task) => void;
  act: (task: Task, action: 'snooze' | 'dismiss', snoozeMinutes?: number) => void;
}) {
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  return (
    <section id="reminder-panel" className="reminder-panel" aria-label="Due reminders">
      {tasks.map((t) => (
        <div className="reminder-row flex items-center flex-wrap gap-3 py-[10px]" key={t.id}>
          <Icon name="bell" />
          <button className="reminder-open min-w-0 flex-1 text-left p-0" onClick={() => edit(t)}>
            <strong>{t.title}</strong>
            <span>{dateLabel(t.reminderAt)}</span>
          </button>
          <select
            aria-label={`Snooze duration for ${t.title}`}
            className="subtle-button"
            disabled={busy}
            value={minutes[t.id] ?? 10}
            onChange={(event) =>
              setMinutes((current) => ({ ...current, [t.id]: Number(event.target.value) }))
            }
          >
            {snoozeOptions.map((option) => (
              <option key={option.minutes} value={option.minutes}>
                {option.label}
              </option>
            ))}
          </select>
          {(['snooze', 'dismiss'] as const).map((action) => (
            <button
              key={action}
              className="subtle-button"
              disabled={busy}
              onClick={() =>
                act(t, action, action === 'snooze' ? (minutes[t.id] ?? 10) : undefined)
              }
            >
              {action === 'snooze' ? 'Snooze' : 'Dismiss'}
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}
