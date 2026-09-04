import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const statuses = ["later", "week", "today", "done"] as const;
export type Status = (typeof statuses)[number];
export type Task = {
  id: string; title: string; notes: string; category: string; status: Status;
  position: number; plannedDay: string | null; plannedWeek: string | null;
  completedAt: string | null; createdAt: string; updatedAt: string; deletedAt: string | null;
  dueDate: string | null; reminderAt: string | null;
  reminderDismissedAt: string | null; reminderNotifiedAt: string | null;
};

export class InputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function calendar(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  const monday = new Date(`${day}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return { day, week: monday.toISOString().slice(0, 10) };
}

function string(value: unknown, label: string, max: number, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) {
    throw new InputError(`${label} must be ${empty ? "at most" : "between 1 and"} ${max} characters.`);
  }
  return value.trim();
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function dateOnly(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InputError("Choose a valid due date.");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value.startsWith("0000")) throw new InputError("Choose a valid due date.");
  return value;
}

function reminderTime(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) throw new InputError("Choose a valid reminder time with a timezone.");
  dateOnly(value.slice(0, 10));
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new InputError("Choose a valid reminder time.");
  return date.toISOString();
}

export class Store {
  db: Database;
  timezone: string;
  constructor(path: string, private now = () => new Date(), timezone?: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'personal' CHECK(category IN ('personal', 'work')),
        status TEXT NOT NULL CHECK(status IN ('later', 'week', 'today', 'done')),
        position INTEGER NOT NULL, plannedDay TEXT, plannedWeek TEXT, completedAt TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(status, position) WHERE deletedAt IS NULL;
    `);
    // Versioned, transactional migration preserves existing tasks and ordering.
    this.db.transaction(() => {
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version < 2) {
        this.db.exec(`
          ALTER TABLE tasks ADD COLUMN dueDate TEXT;
          ALTER TABLE tasks ADD COLUMN reminderAt TEXT;
          ALTER TABLE tasks ADD COLUMN reminderDismissedAt TEXT;
          ALTER TABLE tasks ADD COLUMN reminderNotifiedAt TEXT;
          CREATE INDEX idx_tasks_reminders ON tasks(reminderAt)
            WHERE deletedAt IS NULL AND status != 'done' AND reminderDismissedAt IS NULL;
          PRAGMA user_version = 2;
        `);
      }
    })();
    const saved = this.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'timezone'").get();
    this.timezone = timezone || saved?.value || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { calendar(this.now(), this.timezone); } catch { throw new Error(`Invalid TASKPATH_TIMEZONE: ${this.timezone}`); }
    this.db.query("INSERT INTO settings VALUES ('timezone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.timezone);
  }

  private rows() {
    return this.db.query<Task, []>("SELECT * FROM tasks WHERE deletedAt IS NULL ORDER BY position, createdAt, id").all();
  }

  private get(id: string, deleted = false) {
    const task = this.db.query<Task, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!task || (!deleted && task.deletedAt)) throw new InputError("That task no longer exists.", 404);
    return task;
  }

  private next(status: Status) {
    return this.db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tasks WHERE status = ? AND deletedAt IS NULL").get(status)!.n;
  }

  // Compare local calendar dates, not 24-hour durations, so DST and Monday rollover work.
  rollover() {
    const now = this.now();
    const { day, week } = calendar(now, this.timezone);
    this.db.transaction(() => {
      for (const task of this.rows()) {
        if (task.status !== "today" && task.status !== "week") continue;
        const status = task.plannedWeek !== week ? "later" : task.status === "today" && task.plannedDay !== day ? "week" : null;
        if (!status) continue;
        this.db.query("UPDATE tasks SET status = ?, position = ?, plannedDay = NULL, plannedWeek = ?, updatedAt = ? WHERE id = ?")
          .run(status, this.next(status), status === "week" ? week : null, now.toISOString(), task.id);
      }
    })();
  }

  board() {
    this.rollover();
    const now = this.now();
    return { tasks: this.rows(), reminders: this.pendingReminders(), serverTime: now.toISOString(), timezone: this.timezone, ...calendar(now, this.timezone) };
  }

  private pendingReminders() {
    return this.db.query<Task, [string]>(`SELECT * FROM tasks WHERE deletedAt IS NULL AND status != 'done'
      AND reminderDismissedAt IS NULL AND reminderAt <= ? ORDER BY reminderAt, id`).all(this.now().toISOString());
  }

  // Claim once across tabs/devices; the in-app reminder stays until dismissed.
  claimReminders() {
    return this.db.transaction(() => {
      const tasks = this.pendingReminders().filter(task => !task.reminderNotifiedAt);
      const now = this.now().toISOString();
      for (const task of tasks) this.db.query("UPDATE tasks SET reminderNotifiedAt = ? WHERE id = ?").run(now, task.id);
      return tasks;
    })();
  }

  actOnReminder(id: string, input: unknown) {
    const data = object(input);
    if (!["dismiss", "snooze"].includes(data.action as string)) throw new InputError("Choose Dismiss or Snooze.");
    return this.db.transaction(() => {
      const task = this.get(id);
      if (!task.reminderAt || task.reminderAt !== data.reminderAt || task.reminderDismissedAt || task.status === "done") throw new InputError("This reminder has changed. Refresh and try again.", 409);
      const now = this.now();
      if (data.action === "snooze") {
        this.db.query("UPDATE tasks SET reminderAt = ?, reminderDismissedAt = NULL, reminderNotifiedAt = NULL, updatedAt = ? WHERE id = ?")
          .run(new Date(now.getTime() + 10 * 60 * 1000).toISOString(), now.toISOString(), id);
      } else {
        this.db.query("UPDATE tasks SET reminderDismissedAt = ?, updatedAt = ? WHERE id = ?").run(now.toISOString(), now.toISOString(), id);
      }
      return this.get(id);
    })();
  }

  private validate(input: unknown, partial = false) {
    const data = object(input);
    const result: Record<string, string | null> = {};
    if (!partial || "title" in data) result.title = string(data.title, "Title", 240);
    if ("notes" in data) result.notes = string(data.notes, "Notes", 10000, true);
    if ("category" in data) {
      if (data.category !== "personal" && data.category !== "work") throw new InputError("Choose Personal or Work.");
      result.category = data.category;
    }
    if ("status" in data) {
      if (!statuses.includes(data.status as Status)) throw new InputError("Choose a valid column.");
      result.status = data.status as string;
    }
    if ("dueDate" in data) result.dueDate = dateOnly(data.dueDate);
    if ("reminderAt" in data) result.reminderAt = reminderTime(data.reminderAt);
    const allowed = ["title", "notes", "category", "status", "dueDate", "reminderAt", ...(partial ? ["beforeId"] : [])];
    if (Object.keys(data).some(k => !allowed.includes(k))) throw new InputError("Unknown task field.");
    return result;
  }

  create(input: unknown) {
    const data = this.validate(input);
    this.rollover();
    return this.insert(data);
  }

  private insert(data: Record<string, string | null>) {
    const now = this.now().toISOString();
    const { day, week } = calendar(this.now(), this.timezone);
    const status = (data.status || "later") as Status;
    const id = crypto.randomUUID();
    this.db.query(`INSERT INTO tasks (id, title, notes, category, status, position, plannedDay, plannedWeek, completedAt, createdAt, updatedAt, dueDate, reminderAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, data.title!, data.notes || "", data.category || "personal", status,
        this.next(status), status === "today" ? day : null, ["today", "week"].includes(status) ? week : null, status === "done" ? now : null, now, now, data.dueDate ?? null, data.reminderAt ?? null);
    return this.get(id);
  }

  previewImport(inputs: unknown[]) {
    if (!Array.isArray(inputs) || inputs.length > 500) throw new InputError('Import up to 500 tasks at a time.');
    const key = (task: Record<string, unknown>) => JSON.stringify([
      task.title, task.notes || '', task.category || 'personal', task.status || 'later',
      task.dueDate || null, task.reminderAt || null, Boolean(task.reminderDismissedAt),
    ]);
    const seen = new Set(this.rows().map(key));
    const tasks: Record<string, string | null>[] = [];
    let skipped = 0;
    for (const [index, input] of inputs.entries()) {
      try {
        const { reminderDismissedAt, ...fields } = object(input);
        const data = { notes: '', category: 'personal', status: 'later', dueDate: null, reminderAt: null, ...this.validate(fields) };
        const dismissed = reminderDismissedAt == null ? null : reminderTime(reminderDismissedAt);
        if (dismissed && !data.reminderAt) throw new InputError('A dismissed reminder needs a reminder time.');
        const task = { ...data, reminderDismissedAt: dismissed };
        const fingerprint = key(task);
        if (seen.has(fingerprint)) skipped++;
        else { seen.add(fingerprint); tasks.push(task); }
      } catch (error) {
        if (error instanceof InputError) throw new InputError(`Task ${index + 1}: ${error.message}`);
        throw error;
      }
    }
    return { tasks, skipped };
  }

  importTasks(inputs: unknown[]) {
    return this.db.transaction(() => {
      this.rollover();
      const preview = this.previewImport(inputs);
      for (const data of preview.tasks) {
        const task = this.insert(data);
        if (data.reminderDismissedAt) this.db.query('UPDATE tasks SET reminderDismissedAt = ? WHERE id = ?').run(data.reminderDismissedAt, task.id);
      }
      return { imported: preview.tasks.length, skipped: preview.skipped };
    })();
  }

  update(id: string, input: unknown) {
    const data = this.validate(input, true);
    const raw = object(input);
    if ("beforeId" in raw && raw.beforeId !== null && typeof raw.beforeId !== "string") throw new InputError("Invalid drop position.");
    this.rollover();
    return this.db.transaction(() => {
      const task = this.get(id);
      const status = (data.status || task.status) as Status;
      const now = this.now().toISOString();
      const { day, week } = calendar(this.now(), this.timezone);
      const reminderAt = "reminderAt" in data ? data.reminderAt : task.reminderAt;
      const changedReminder = reminderAt !== task.reminderAt;
      this.db.query(`UPDATE tasks SET title = ?, notes = ?, category = ?, status = ?, plannedDay = ?, plannedWeek = ?, completedAt = ?, updatedAt = ?,
        dueDate = ?, reminderAt = ?, reminderDismissedAt = ?, reminderNotifiedAt = ? WHERE id = ?`)
        .run(data.title ?? task.title, data.notes ?? task.notes, data.category ?? task.category, status,
          status === "today" ? day : null, ["week", "today"].includes(status) ? week : null,
          status === "done" ? task.completedAt || now : null, now,
          "dueDate" in data ? data.dueDate : task.dueDate, reminderAt,
          changedReminder ? null : task.reminderDismissedAt, changedReminder ? null : task.reminderNotifiedAt, id);
      if (status !== task.status || "beforeId" in raw) {
        const others = this.rows().filter(t => t.status === status && t.id !== id);
        let index = others.length;
        if (raw.beforeId != null) {
          index = others.findIndex(t => t.id === raw.beforeId);
          if (index < 0) throw new InputError("The drop target changed. Please try again.", 409);
        }
        const ordered = others.map(t => t.id);
        ordered.splice(index, 0, id);
        ordered.forEach((taskId, position) => this.db.query("UPDATE tasks SET position = ? WHERE id = ?").run(position, taskId));
      }
      return this.get(id);
    })();
  }

  remove(id: string) {
    this.get(id);
    this.db.query("UPDATE tasks SET deletedAt = ?, updatedAt = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), id);
  }

  restore(id: string) {
    const task = this.get(id, true);
    if (task.deletedAt) {
      this.db.query("UPDATE tasks SET deletedAt = NULL, position = ?, updatedAt = ? WHERE id = ?").run(this.next(task.status), this.now().toISOString(), id);
      this.rollover();
    }
    return this.get(id);
  }

  close() { this.db.close(); }
}
