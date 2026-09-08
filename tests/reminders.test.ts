import { afterEach, beforeEach, expect, test } from "bun:test";
import { ClientStore as Store } from "./client-helpers";
import { dueLabel, localReminderValue, reminderFromInput } from "../public/dates.js";

let now: Date;
let store: Store;
beforeEach(() => {
  now = new Date("2026-09-03T10:00:00Z");
  store = new Store(":memory:", () => now, "Europe/Moscow");
});
afterEach(() => store.close());

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

test("missed reminders remain due after downtime; completed/deleted tasks never alert", () => {
  const late = store.create({ title: "Missed", reminderAt: "2026-09-02T10:00:00Z" });
  store.create({ title: "Finished", status: "done", reminderAt: late.reminderAt });
  const deleted = store.create({ title: "Deleted", reminderAt: late.reminderAt });
  store.remove(deleted.id);
  now = new Date("2026-10-01T12:00:00Z");
  expect(store.board().reminders.map(t => t.id)).toEqual([late.id]);
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
