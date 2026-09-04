import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, calendar } from "../src/store";
import { createHandler } from "../src/server";
import { login, testAuth } from "./auth-helpers";

let now: Date;
let store: Store;
beforeEach(() => {
  now = new Date("2026-09-03T10:00:00Z");
  store = new Store(":memory:", () => now, "Europe/Moscow");
});
afterEach(() => store.close());
const column = (status: string) => store.board().tasks.filter(t => t.status === status).map(t => t.title);

test("planning and ordering survive closing and reopening SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskpath-test-"));
  const path = join(dir, "tasks.sqlite");
  let disk = new Store(path, () => now, "Europe/Moscow");
  try {
    const first = disk.create({ title: "First" });
    const second = disk.create({ title: "Second" });
    disk.update(first.id, { status: "week" });
    disk.update(second.id, { status: "week", beforeId: first.id });
    disk.close();
    disk = new Store(path, () => now);
    expect(disk.board().tasks.map(t => t.title)).toEqual(["Second", "First"]);
    expect(disk.board().tasks.every(t => t.status === "week")).toBe(true);
    expect(disk.timezone).toBe("Europe/Moscow");
  } finally { disk.close(); rmSync(dir, { recursive: true, force: true }); }
});

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
  for (const input of [null, [], { title: " " }, { title: "a".repeat(241) }, { title: "x", status: "invalid" }, { title: "x", position: -1 }, { title: "x", notes: 12 }]) {
    expect(() => store.create(input)).toThrow();
  }
  expect(store.board().tasks).toEqual([]);
});

test("HTTP API persists valid writes and rejects cross-site or malformed writes", async () => {
  const handle = createHandler(store);
  const post = (body: string, headers = {}) => handle(new Request("http://localhost:3000/api/tasks", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
  expect((await post('{"title":"Created"}')).status).toBe(201);
  expect((await post('{"title":"Blocked"}', { origin: "https://another-site.example" })).status).toBe(403);
  expect((await post('{"title":"Blocked"}', { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await post('not-json')).status).toBe(400);
  expect((await post('{"title":"Blocked"}', { "content-type": "text/plain" })).status).toBe(415);
  expect((await post(JSON.stringify({ title: "x", notes: "x".repeat(40000) }))).status).toBe(413);
  expect(store.board().tasks.map(t => t.title)).toEqual(["Created"]);
});

test("session authentication gates the workspace and API", async () => {
  const handle = createHandler(store, testAuth, "https://tasks.example.com");
  expect((await handle(new Request("http://localhost:3000/"))).status).toBe(303);
  expect((await handle(new Request("http://localhost:3000/"))).headers.get("location")).toBe("/login");
  for (const path of ["/api/board", "/api/export"]) expect((await handle(new Request(`http://localhost:3000${path}`))).status).toBe(401);
  expect((await handle(new Request("http://localhost:3000/login"))).status).toBe(200);
  const signedIn = await login(handle);
  expect(signedIn.response.status).toBe(200);
  expect(signedIn.response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(signedIn.response.headers.get("set-cookie")).toContain("SameSite=Strict");
  expect(signedIn.response.headers.get("set-cookie")).toContain("Secure");
  expect((await handle(new Request("http://localhost:3000/api/board", { headers: { Cookie: signedIn.cookie } }))).status).toBe(200);
  expect((await handle(new Request("http://localhost:3000/login", { headers: { Cookie: signedIn.cookie } }))).status).toBe(303);
  expect((await handle(new Request("http://localhost:3000/healthz"))).status).toBe(200);
});

test("login rejects bad credentials and cross-origin requests", async () => {
  const handle = createHandler(store, testAuth, "https://tasks.example.com");
  expect((await login(handle, "https://tasks.example.com", "test", "wrong")).response.status).toBe(401);
  expect((await login(handle, "https://tasks.example.com", "wrong", "secret")).response.status).toBe(401);
  expect((await login(handle, "https://evil.example")).response.status).toBe(403);
  const missingOrigin = await handle(new Request("http://localhost:3000/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"username":"test","password":"secret"}',
  }));
  expect(missingOrigin.status).toBe(403);
});

test("logout revokes the current session", async () => {
  const handle = createHandler(store, testAuth, "https://tasks.example.com");
  const { cookie } = await login(handle);
  const logout = await handle(new Request("http://localhost:3000/api/auth/logout", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://tasks.example.com", Cookie: cookie }, body: "{}",
  }));
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await handle(new Request("http://localhost:3000/api/board", { headers: { Cookie: cookie } }))).status).toBe(401);
});

test("sessions survive a handler restart and a password change invalidates them", async () => {
  let handle = createHandler(store, testAuth, "https://tasks.example.com");
  const { cookie } = await login(handle);
  handle = createHandler(store, testAuth, "https://tasks.example.com");
  expect((await handle(new Request("http://localhost:3000/api/board", { headers: { Cookie: cookie } }))).status).toBe(200);
  const newHash = await Bun.password.hash("a-new-test-password", { algorithm: "argon2id", memoryCost: 8192, timeCost: 1 });
  handle = createHandler(store, { ...testAuth, passwordHash: newHash }, "https://tasks.example.com");
  expect((await handle(new Request("http://localhost:3000/api/board", { headers: { Cookie: cookie } }))).status).toBe(401);
});

test("repeated failed logins are temporarily blocked", async () => {
  const handle = createHandler(store, testAuth, "https://tasks.example.com");
  for (let attempt = 1; attempt <= 4; attempt++) expect((await login(handle, "https://tasks.example.com", "test", "wrong")).response.status).toBe(401);
  const blocked = (await login(handle, "https://tasks.example.com", "test", "wrong")).response;
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBe("900");
  expect((await login(handle)).response.status).toBe(429);
});

test("HTTPS reverse proxy accepts only the configured public origin", async () => {
  const handle = createHandler(store, undefined, "https://tasks.example.com");
  const post = (origin: string) => handle(new Request("http://127.0.0.1:3000/api/tasks", {
    method: "POST", headers: { "content-type": "application/json", origin }, body: '{"title":"Proxy task"}',
  }));
  expect((await post("https://tasks.example.com")).status).toBe(201);
  expect((await post("https://other.example.com")).status).toBe(403);
  expect(store.board().tasks).toHaveLength(1);
});
