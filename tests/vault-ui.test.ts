import { test } from "node:test";
import { expect } from "@std/expect";
import { startAuthentication } from "../public/ui/auth-startup.ts";
import { readText } from "./test-utils.ts";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(invitation = false) {
  const load = deferred<void>(),
    restore = deferred<boolean>(),
    phases: string[] = [],
    errors: string[] = [];
  let current = true,
    calls = 0;
  const ready = startAuthentication({
    invitation,
    load: () => load.promise,
    restore: () => {
      calls++;
      return restore.promise;
    },
    current: () => current,
    ready: (p) => phases.push(p),
    failure: (e) => errors.push(e),
  });
  return {
    load,
    restore,
    ready,
    phases,
    errors,
    calls: () => calls,
    invalidate: () => {
      current = false;
    },
  };
}
test("remembered startup does not expose sign-in while storage or keys are pending", async () => {
  expect(readText("public/index.html")).not.toContain(
    'id="unlock-screen"',
  );
  const f = fixture();
  expect(f.phases).toEqual([]);
  f.load.resolve();
  await tick();
  expect(f.phases).toEqual([]);
  f.restore.resolve(true);
  await f.ready;
  expect(f.phases).toEqual(["unlocked"]);
});
test("unremembered startup shows sign-in only after checking storage", async () => {
  const f = fixture();
  f.load.resolve();
  await tick();
  expect(f.phases).toEqual([]);
  f.restore.resolve(false);
  await f.ready;
  expect(f.phases).toEqual(["locked"]);
});
test("invitations bypass the previously remembered account", async () => {
  const f = fixture(true);
  f.load.resolve();
  await f.ready;
  expect(f.calls()).toBe(0);
  expect(f.phases).toEqual(["locked"]);
});
test("storage failures surface a locked error", async () => {
  for (const phase of ["load", "restore"] as const) {
    const f = fixture();
    if (phase === "restore") {
      f.load.resolve();
      await tick();
    }
    f[phase].reject(new Error("Storage unavailable"));
    await f.ready;
    expect(f.errors[0]).toContain("device storage");
    expect(f.phases).toEqual([]);
  }
});
test("late startup cannot reopen a locked or switched workspace", async () => {
  const f = fixture();
  f.load.resolve();
  await tick();
  f.invalidate();
  f.restore.resolve(true);
  await f.ready;
  expect(f.phases).toEqual([]);
  expect(f.errors).toEqual([]);
});
