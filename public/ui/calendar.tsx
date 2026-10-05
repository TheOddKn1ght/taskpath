import { useMemo, useState } from "react";
import type { Board, Route, Task } from "../types.js";
import { monthDays, shiftDate, shiftMonth } from "../picker-model.js";
import { isOverdue, tasksByDay, weekDays, type CalendarEntry } from "../calendar-model.js";
import { Icon } from "./icons";
import { columns } from "./store";
type Mode = "month" | "week";
const MODE_KEY = "taskpath-calendar-mode";
// Calendar dates are plain YYYY-MM-DD values; formatting at noon UTC avoids DST shifts.
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const format = (day: string, options: Intl.DateTimeFormatOptions) =>
  at(day).toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
const fullDate = (day: string) => format(day, { weekday: "long", month: "long", day: "numeric" });
const WEEKDAYS = weekDays("2024-01-01").map((day) => ({
  short: format(day, { weekday: "short" }),
  narrow: format(day, { weekday: "narrow" }),
}));
function periodLabel(mode: Mode, anchor: string) {
  if (mode === "month") return format(anchor, { month: "long", year: "numeric" });
  const days = weekDays(anchor);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .formatRange(at(days[0]), at(days[6]));
}
function reminderTime(task: Task, timezone: string) {
  return new Date(task.reminderAt!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: timezone });
}
function CalendarTask({ entry, today, timezone, edit, chip = false }: {
  entry: CalendarEntry; today: string; timezone: string; edit: (t: Task) => void; chip?: boolean;
}) {
  const { task } = entry, done = task.status === "done", overdue = isOverdue(entry, today);
  const meta = [
    entry.reminder ? `Reminder ${reminderTime(task, timezone)}` : "",
    entry.due ? (overdue ? "Overdue" : "Due") : "",
  ].filter(Boolean);
  return (
    <button
      type="button"
      className={`calendar-task${chip ? " is-chip" : ""}${done ? " is-done" : ""}${overdue ? " is-overdue" : ""}`}
      aria-label={`${task.title}. ${meta.join(", ")}. ${columns[task.status]}.`}
      onClick={() => edit(task)}
    >
      <span className="calendar-task-title">{task.title}</span>
      {!chip && (
        <span className="calendar-task-meta">
          {overdue && <Icon name="info" />}
          {meta.join(" · ")}
          <span className="calendar-task-status">{columns[task.status]}</span>
          {task.tags.slice(0, 2).map((tag) => <span key={tag} className="calendar-task-tag">#{tag}</span>)}
        </span>
      )}
    </button>
  );
}
export function CalendarView({ board, route, edit, create }: {
  board: Board; route: Route; edit: (t: Task) => void; create: (due: string) => void;
}) {
  const today = board.day;
  const [mode, setMode] = useState<Mode>(() => {
    try { return localStorage.getItem(MODE_KEY) === "week" ? "week" : "month"; } catch { return "month"; }
  });
  const [anchor, setAnchor] = useState(today), [selected, setSelected] = useState(today);
  const byDay = useMemo(() => tasksByDay(board.tasks.filter((t) =>
    (route.category === "all" || t.category === route.category) && (!route.tag || t.tags.includes(route.tag)),
  ), board.timezone), [board.tasks, board.timezone, route.category, route.tag]);
  const entries = (day: string) => byDay.get(day) || [];
  const choose = (next: Mode) => {
    setMode(next);
    setAnchor(selected);
    try { localStorage.setItem(MODE_KEY, next); } catch {}
  };
  const step = (amount: number) => {
    const next = mode === "month" ? shiftMonth(anchor, amount) : shiftDate(anchor, 7 * amount);
    setAnchor(next);
    setSelected(mode === "month" ? (next.slice(0, 7) === today.slice(0, 7) ? today : next.slice(0, 8) + "01") : next);
  };
  const unit = mode === "month" ? "month" : "week";
  const addButton = (day: string, compact = false) => (
    <button
      type="button"
      className={compact ? "icon-button calendar-add" : "secondary-button calendar-add"}
      aria-label={`Add task on ${fullDate(day)}`}
      onClick={() => create(day)}
    >
      <Icon name="plus" />{!compact && "Add task"}
    </button>
  );
  const selectedEntries = entries(selected);
  return (
    <section id="calendar-view" className={`calendar-view is-${mode}`} tabIndex={-1} aria-labelledby="calendar-title">
      <header className="view-heading calendar-heading">
        <h2 id="calendar-title" aria-live="polite">{periodLabel(mode, anchor)}</h2>
        <div className="calendar-controls">
          <div className="segmented" role="group" aria-label="Calendar layout">
            {(["month", "week"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => choose(m)}>
                {m === "month" ? "Month" : "Week"}
              </button>
            ))}
          </div>
          <div className="calendar-step">
            <button type="button" className="icon-button" aria-label={`Previous ${unit}`} onClick={() => step(-1)}>‹</button>
            <button type="button" className="secondary-button" onClick={() => { setAnchor(today); setSelected(today); }}>Today</button>
            <button type="button" className="icon-button" aria-label={`Next ${unit}`} onClick={() => step(1)}>›</button>
          </div>
        </div>
      </header>
      {mode === "month" ? (
        <>
          <div className="month-grid">
            {WEEKDAYS.map((w) => (
              <span key={w.short} className="month-weekday" aria-hidden="true">
                <span className="weekday-short">{w.short}</span><span className="weekday-narrow">{w.narrow}</span>
              </span>
            ))}
            {monthDays(anchor).map((day, i) => {
              if (!day) return <span key={`pad-${i}`} className="month-cell is-empty" aria-hidden="true" />;
              const list = entries(day), open = list.filter((e) => e.task.status !== "done");
              const overdue = list.some((e) => isOverdue(e, today));
              return (
                <div key={day} className={`month-cell${day === today ? " is-today" : ""}${day === selected ? " is-selected" : ""}${day < today ? " is-past" : ""}`}>
                  <button
                    type="button"
                    className="month-day"
                    aria-label={`${fullDate(day)}: ${list.length ? `${list.length} task${list.length === 1 ? "" : "s"}${overdue ? ", some overdue" : ""}` : "no tasks"}`}
                    aria-current={day === today ? "date" : undefined}
                    aria-pressed={day === selected}
                    onClick={() => setSelected(day)}
                  >
                    <span className="month-day-number">{Number(day.slice(8))}</span>
                    {list.length > 0 && (
                      <span className="month-dots" aria-hidden="true">
                        {open.slice(0, 3).map((e) => <span key={e.task.id} className={isOverdue(e, today) ? "is-overdue" : ""} />)}
                        {!open.length && <span className="is-done" />}
                      </span>
                    )}
                  </button>
                  <div className="month-chips">
                    {list.slice(0, 3).map((e) => (
                      <CalendarTask key={e.task.id} entry={e} today={today} timezone={board.timezone} edit={edit} chip />
                    ))}
                    {list.length > 3 && <span className="month-more" aria-hidden="true">+{list.length - 3} more</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <section className="calendar-agenda" aria-labelledby="calendar-agenda-title">
            <header className="calendar-day-header">
              <h3 id="calendar-agenda-title">{selected === today ? `Today, ${format(selected, { month: "long", day: "numeric" })}` : fullDate(selected)}</h3>
              {addButton(selected)}
            </header>
            {selectedEntries.length ? (
              <div className="calendar-list">
                {selectedEntries.map((e) => <CalendarTask key={e.task.id} entry={e} today={today} timezone={board.timezone} edit={edit} />)}
              </div>
            ) : (
              <p className="calendar-empty">Nothing due or reminded on this day.</p>
            )}
          </section>
        </>
      ) : (
        <div className="week-grid">
          {weekDays(anchor).map((day) => {
            const list = entries(day);
            return (
              <section key={day} className={`week-day${day === today ? " is-today" : ""}${day < today ? " is-past" : ""}`} aria-label={fullDate(day)}>
                <header className="calendar-day-header">
                  <h3 aria-current={day === today ? "date" : undefined}>
                    <span className="week-day-name">{format(day, { weekday: "short" })}</span>
                    <span className="week-day-date">{format(day, { month: "short", day: "numeric" })}</span>
                  </h3>
                  {addButton(day, true)}
                </header>
                {list.length ? (
                  <div className="calendar-list">
                    {list.map((e) => <CalendarTask key={e.task.id} entry={e} today={today} timezone={board.timezone} edit={edit} />)}
                  </div>
                ) : (
                  <p className="calendar-empty">No tasks</p>
                )}
              </section>
            );
          })}
        </div>
      )}
      <p className="calendar-note">Tasks appear on their due date and on the day of their reminder, in {board.timezone}. Archived tasks are hidden.</p>
    </section>
  );
}
