import { useState, useRef, useEffect } from "react";
import type { Board, Task, Status, Category } from "../types.d.ts";
import { Dialog } from "./dialog.tsx";
import { Select, TagButton, DatePicker } from "./pickers.tsx";
import { columns, message, mutate } from "./store.ts";
import { normalizeTags } from "../tags.ts";
import { localReminderValue, reminderFromInput } from "../dates.ts";
import { reminderIsToday } from "../offline-model.ts";
export function Editor({
  task,
  status,
  board,
  initialTag,
  initialCategory,
  close,
  remove,
  archive,
  notify,
  notifications,
}: {
  task: Task | null;
  status: Status;
  board: Board;
  initialTag: string;
  initialCategory: Category;
  close: () => void;
  remove: (t: Task) => Promise<void>;
  archive: (t: Task) => Promise<void>;
  notify: (s: string) => void;
  notifications: () => Promise<void>;
}) {
  const [title, setTitle] = useState(task?.title || ""),
    [notes, setNotes] = useState(task?.notes || ""),
    [tags, setTags] = useState(task?.tags || (initialTag ? [initialTag] : [])),
    [tag, setTag] = useState(""),
    [column, setColumn] = useState(task?.status || status),
    [category, setCategory] = useState<Category>(
      task?.category || initialCategory,
    ),
    [due, setDue] = useState(task?.dueDate || ""),
    [reminder, setReminder] = useState(
      localReminderValue(task?.reminderAt || null),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const reminderAt = () =>
    reminder === localReminderValue(task?.reminderAt || null)
      ? task?.reminderAt || null
      : reminderFromInput(reminder);
  const today = (() => {
    try {
      return reminderIsToday(
        {
          status: "today",
          reminderAt: reminderAt(),
          deletedAt: null,
          archivedAt: null,
        },
        board.day,
        board.timezone,
      );
    } catch {
      return false;
    }
  })();
  useEffect(() => {
    if (today && column !== "done") setColumn("today");
  }, [today, column]);
  const add = () => {
    if (!tag.trim()) return;
    try {
      setTags(normalizeTags([...tags, tag]));
      setTag("");
      setError("");
    } catch (e) {
      setError(message(e));
    }
  };
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
      if (alive.current) close();
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      id="task-dialog"
      title={task ? "Edit task" : "New task"}
      className="task-dialog"
      onClose={close}
      busy={busy}
    >
      <form
        id="task-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const all = normalizeTags([...tags, ...(tag.trim() ? [tag] : [])]);
            const result = await mutate(
              task ? `/api/tasks/${task.id}` : "/api/tasks",
              task ? "PATCH" : "POST",
              {
                title,
                notes,
                tags: all,
                status: today && column !== "done" ? "today" : column,
                category,
                dueDate: due || null,
                reminderAt: reminderAt(),
              },
            );
            notify(
              task
                ? "Task saved."
                : `Task added to ${columns[result.task.status]}.`,
            );
          });
        }}
      >
        <label className="field">
          Task
          <input
            id="task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={240}
            placeholder="What needs doing?"
            autoFocus
          />
        </label>
        <label className="field">
          Notes <span className="optional">optional</span>
          <textarea
            id="task-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={10000}
            placeholder="Details or a link"
          />
        </label>
        <div className="field tag-field">
          <label htmlFor="task-tag-input">
            Tags <span className="optional">optional</span>
          </label>
          <div id="task-tags" className="tag-chips">
            {tags.map((t) => (
              <button
                type="button"
                className="tag-chip"
                key={t}
                aria-label={"Remove tag " + t}
                onClick={() => setTags(tags.filter((v) => v !== t))}
              >
                {t}
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
          <div className="tag-entry">
            <input
              id="task-tag-input"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  add();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  e.currentTarget.parentElement
                    ?.querySelector<HTMLButtonElement>("#browse-tags")
                    ?.click();
                }
              }}
              placeholder="Add a tag"
            />
            <button
              type="button"
              id="add-tag"
              className="secondary-button"
              onClick={add}
            >
              Add
            </button>
            <TagButton
              available={[...new Set(board.tasks.flatMap((t) => t.tags))]}
              tags={tags}
              onChange={setTags}
            />
          </div>
          <p className="schedule-hint">Press Enter to add · up to 10 tags</p>
        </div>
        <div className="field-row">
          <label className="field">
            Column
            <Select
              label="Column"
              value={column}
              options={Object.entries(columns).map(([value, label]) => ({
                value,
                label,
                disabled: today && (value === "later" || value === "week"),
              }))}
              onChange={(v) => setColumn(v as Status)}
            />
          </label>
          <label className="field">
            Category
            <Select
              label="Category"
              value={category}
              options={[
                { value: "work", label: "Work" },
                { value: "personal", label: "Personal" },
              ]}
              onChange={(v) => setCategory(v as Category)}
            />
          </label>
        </div>
        {today && (
          <p id="reminder-column-hint" className="schedule-hint" role="status">
            Tasks with a reminder today stay in Today. Change or clear the
            reminder to move to Later or This Week.
          </p>
        )}
        <details
          id="task-schedule"
          className="task-schedule"
          open={undefined}
          ref={(el) => {
            if (el && !el.dataset.initialized) {
              el.open = !!(task?.dueDate || task?.reminderAt);
              el.dataset.initialized = "true";
            }
          }}
        >
          <summary>
            Date &amp; reminder <span>optional</span>
          </summary>
          <div className="field-row">
            <label className="field">
              Due date
              <DatePicker value={due} onChange={setDue} />
            </label>
            <label className="field">
              Remind me
              <DatePicker timed value={reminder} onChange={setReminder} />
            </label>
          </div>
          <p className="schedule-hint">
            Reminder times use your device timezone:{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}.
          </p>
          <p className="schedule-hint">
            Missed reminders appear when you return. Enable Background reminders
            in workspace options for alerts while the app is closed.
          </p>
          <button
            type="button"
            className="subtle-button"
            onClick={() => void notifications()}
          >
            Enable desktop notifications
          </button>
          <button
            type="button"
            className="subtle-button"
            onClick={() => {
              setDue("");
              setReminder("");
            }}
          >
            Clear dates
          </button>
        </details>
        {error && (
          <p id="form-error" className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {task && (
            <>
              <button
                type="button"
                className="subtle-button danger"
                disabled={busy}
                onClick={() => void run(() => remove(task))}
              >
                Delete task
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void run(() => archive(task))}
              >
                Archive task
              </button>
            </>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button id="save-task" className="primary-button" disabled={busy}>
            {task ? "Save changes" : "Add task"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
