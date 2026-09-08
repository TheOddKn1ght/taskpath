import { afterEach, beforeEach, expect, test } from "bun:test";
import { ClientStore as Store, calendar } from "./client-helpers";

let now: Date;
let store: Store;
beforeEach(() => {
  now = new Date("2026-09-03T10:00:00Z");
  store = new Store(":memory:", () => now, "Europe/Moscow");
});
afterEach(() => store.close());
const column = (status: string) => store.board().tasks.filter(t => t.status === status).map(t => t.title);

test("reordering supports before, after, and moving between columns", () => {
  const a = store.create({ title: "A", status: "today" });
  const b = store.create({ title: "B", status: "today" });
  const c = store.create({ title: "C", status: "today" });
  store.update(c.id, { status: "today", beforeId: a.id });
  expect(column("today")).toEqual(["C", "A", "B"]);
  store.update(c.id, { status: "today", beforeId: null });
  expect(column("today")).toEqual(["A", "B", "C"]);
  store.update(b.id, { status: "week", beforeId: null });
  expect(column("today")).toEqual(["A", "C"]);
  expect(column("week")).toEqual(["B"]);
});

test("invalid or stale drop targets roll back the entire edit", () => {
  const a = store.create({ title: "Original" });
  expect(() => store.update(a.id, { title: "Changed", status: "today", beforeId: "missing" })).toThrow();
  expect(store.board().tasks[0]).toMatchObject({ title: "Original", status: "later" });
});

test("today returns to the week at local midnight, once", () => {
  store.create({ title: "Already planned", status: "week" });
  store.create({ title: "Unfinished", status: "today" });
  now = new Date("2026-09-03T20:59:59Z");
  expect(column("today")).toEqual(["Unfinished"]);
  now = new Date("2026-09-03T21:00:00Z");
  expect(column("today")).toEqual([]);
  expect(column("week")).toEqual(["Already planned", "Unfinished"]);
  expect(column("week")).toEqual(["Already planned", "Unfinished"]);
});

test("Monday resets both planning columns while preserving Done", () => {
  store.create({ title: "Weekly", status: "week" });
  store.create({ title: "Daily", status: "today" });
  store.create({ title: "Finished", status: "done" });
  now = new Date("2026-09-06T21:00:00Z");
  expect(column("week")).toEqual([]);
  expect(column("today")).toEqual([]);
  expect(column("later").sort()).toEqual(["Daily", "Weekly"]);
  expect(column("done")).toEqual(["Finished"]);
});

test("calendar boundaries are based on timezone, including DST and year change", () => {
  expect(calendar(new Date("2027-01-01T02:00:00Z"), "America/New_York")).toEqual({ day: "2026-12-31", week: "2026-12-28" });
  expect(calendar(new Date("2026-03-08T07:00:00Z"), "America/New_York")).toEqual({ day: "2026-03-08", week: "2026-03-02" });
  expect(calendar(new Date("2026-03-09T04:00:00Z"), "America/New_York")).toEqual({ day: "2026-03-09", week: "2026-03-09" });
});

test("delete and restore retain task content and respect rollover", () => {
  const task = store.create({ title: "Keep me", notes: "Context", category: "work", status: "today" });
  store.remove(task.id);
  expect(store.board().tasks).toHaveLength(0);
  now = new Date("2026-09-07T10:00:00Z");
  expect(store.restore(task.id)).toMatchObject({ title: "Keep me", notes: "Context", category: "work", status: "later" });
});

test("reopening a completed task resets its completion timestamp", () => {
  const task = store.create({ title: "Done", status: "done" });
  expect(task.completedAt).not.toBeNull();
  expect(store.update(task.id, { status: "today" })).toMatchObject({ completedAt: null, plannedDay: "2026-09-03" });
});

test("malformed data is rejected without writing rows", () => {
  for (const input of [null, [], { title: " " }, { title: "a".repeat(241) }, { title: "x", status: "invalid" }, { title: "x", notes: 12 }]) {
    expect(() => store.create(input)).toThrow();
  }
  expect(store.board().tasks).toEqual([]);
});

