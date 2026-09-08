import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { createHandler } from "../src/server";
import { dueLabel, localReminderValue, reminderFromInput } from "../public/dates.js";

let now: Date;
let store: Store;
beforeEach(() => {
  now = new Date("2026-09-03T10:00:00Z");
  store = new Store(":memory:", () => now, "Europe/Moscow");
});
afterEach(() => store.close());

test("v1 migration preserves task content and can be reopened safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskpath-migration-"));
  const path = join(dir, "tasks.sqlite");
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'personal', status TEXT NOT NULL,
    position INTEGER NOT NULL, plannedDay TEXT, plannedWeek TEXT, completedAt TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT);
    INSERT INTO tasks VALUES ('existing', 'Keep this task', 'Keep these notes', 'work', 'later', 7,
      NULL, NULL, NULL, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', NULL);
    PRAGMA user_version = 1;`);
  legacy.close();
  let migrated = new Store(path, () => now);
  try {
    expect(migrated.board().tasks[0]).toMatchObject({ id: "existing", title: "Keep this task", notes: "Keep these notes", position: 7, category: "work", dueDate: null, reminderAt: null });
    migrated.update("existing", { dueDate: "2026-09-05", reminderAt: "2026-09-04T09:00:00+03:00" });
    migrated.close();
    migrated = new Store(path, () => now);
    expect(migrated.board().tasks[0]).toMatchObject({ dueDate: "2026-09-05", reminderAt: "2026-09-04T06:00:00.000Z" });
    expect(migrated.db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  } finally { migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("dates persist through edits, dragging, and weekly rollover; they can be cleared", () => {
  const task = store.create({ title: "Scheduled", status: "today", dueDate: "2026-09-08", reminderAt: "2026-09-08T10:00:00Z" });
  store.update(task.id, { title: "Edited" });
  store.update(task.id, { status: "week" });
  now = new Date("2026-09-07T10:00:00Z");
  expect(store.board().tasks[0]).toMatchObject({ title: "Edited", status: "later", dueDate: "2026-09-08", reminderAt: "2026-09-08T10:00:00.000Z" });
  expect(store.update(task.id, { dueDate: null, reminderAt: null })).toMatchObject({ dueDate: null, reminderAt: null });
});

test("invalid dates and timestamps are rejected, including leap days and missing offsets", () => {
  for (const dueDate of ["2026-02-29", "2026-04-31", "2026-13-01", "0000-01-01", "tomorrow", 4]) {
    expect(() => store.create({ title: "Invalid", dueDate })).toThrow();
  }
  for (const reminderAt of ["2026-02-30T10:00:00Z", "2026-09-03T25:00:00Z", "2026-09-03T10:00:00", "tomorrow", true]) {
    expect(() => store.create({ title: "Invalid", reminderAt })).toThrow();
  }
  expect(store.create({ title: "Leap day", dueDate: "2028-02-29" }).dueDate).toBe("2028-02-29");
});

test("reminders become due at their timestamp and claim once without dismissing in-app alerts", () => {
  const task = store.create({ title: "Upcoming", reminderAt: "2026-09-03T10:05:00Z" });
  expect(store.board().reminders).toEqual([]);
  expect(store.claimReminders()).toEqual([]);
  now = new Date("2026-09-03T10:05:00Z");
  expect(store.board().reminders.map(t => t.id)).toEqual([task.id]);
  expect(store.claimReminders().map(t => t.id)).toEqual([task.id]);
  expect(store.claimReminders()).toEqual([]);
  expect(store.board().reminders).toHaveLength(1);
  store.update(task.id, { title: "Unrelated edit", reminderAt: task.reminderAt });
  expect(store.claimReminders()).toEqual([]);
});

test("missed reminders remain due after downtime; completed/deleted tasks never alert", () => {
  const late = store.create({ title: "Missed", reminderAt: "2026-09-02T10:00:00Z" });
  store.create({ title: "Finished", status: "done", reminderAt: late.reminderAt });
  const deleted = store.create({ title: "Deleted", reminderAt: late.reminderAt });
  store.remove(deleted.id);
  now = new Date("2026-10-01T12:00:00Z");
  expect(store.board().reminders.map(t => t.id)).toEqual([late.id]);
});

test("dismissal is persistent, snooze rearms, and stale actions cannot dismiss a rescheduled reminder", () => {
  const task = store.create({ title: "Reminder", reminderAt: "2026-09-03T09:59:00Z" });
  store.claimReminders();
  const snoozed = store.actOnReminder(task.id, { action: "snooze", reminderAt: task.reminderAt });
  expect(snoozed).toMatchObject({ reminderAt: "2026-09-03T10:10:00.000Z", reminderNotifiedAt: null });
  expect(store.board().reminders).toEqual([]);
  expect(() => store.actOnReminder(task.id, { action: "dismiss", reminderAt: task.reminderAt })).toThrow();
  now = new Date("2026-09-03T10:10:00Z");
  expect(store.claimReminders()).toHaveLength(1);
  store.actOnReminder(task.id, { action: "dismiss", reminderAt: snoozed.reminderAt });
  store.update(task.id, { notes: "Edited later", reminderAt: snoozed.reminderAt });
  expect(store.board().reminders).toEqual([]);
  expect(store.claimReminders()).toEqual([]);
  store.update(task.id, { reminderAt: "2026-09-03T10:11:00Z" });
  now = new Date("2026-09-03T10:11:00Z");
  expect(store.claimReminders()).toHaveLength(1);
});

test("reminder endpoints validate stale state and preserve cross-origin protection", async () => {
  const task = store.create({ title: "API reminder", reminderAt: "2026-09-03T10:00:00Z" });
  const handle = createHandler(store);
  const post = (path: string, body: object, origin = "http://localhost:3000") => handle(new Request(`http://localhost:3000${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body),
  }));
  expect((await post("/api/reminders/claim", {}, "https://evil.example")).status).toBe(403);
  expect((await (await post("/api/reminders/claim", {})).json()).tasks).toHaveLength(1);
  expect((await post(`/api/tasks/${task.id}/reminder`, { action: "dismiss", reminderAt: "stale" })).status).toBe(409);
  expect((await post(`/api/tasks/${task.id}/reminder`, { action: "dismiss", reminderAt: task.reminderAt })).status).toBe(200);
  expect(store.board().reminders).toEqual([]);
});

test("card date labels use calendar days across month/year boundaries", () => {
  expect(dueLabel("2026-09-03", "2026-09-03")).toBe("Today");
  expect(dueLabel("2027-01-01", "2026-12-31")).toBe("Tomorrow");
  expect(dueLabel("2026-09-02", "2026-09-03")).toBe("Overdue · Sep 2");
});

test("datetime inputs round-trip in the device timezone and reject normalized invalid input", () => {
  const input = "2026-09-03T15:45";
  expect(localReminderValue(reminderFromInput(input))).toBe(input);
  expect(reminderFromInput("")).toBeNull();
  expect(() => reminderFromInput("2026-02-30T10:00")).toThrow();
  expect(() => reminderFromInput("2026-09-03T25:00")).toThrow();
});
