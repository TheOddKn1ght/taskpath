import { expect, test } from 'bun:test';
import { ClientStore } from './client-helpers';
import { queueChange, validate } from '../public/offline-model';
import { trackedTime, formatTrackedTime } from '../public/time-tracking';
import { computeStats } from '../public/stats';
import { encryptChange, decryptEnvelope } from '../public/crypto';
import { testVault } from './auth-helpers';

function setup() {
  let now = Date.parse('2026-10-07T10:00:00Z');
  const client = new ClientStore(':memory:', () => new Date(now));
  const task = client.create({ title: 'Optional work' });
  const act = (action: string, method = 'POST') =>
    queueChange(client.record, `/api/tasks/${task.id}/timer`, method, { action }, now).task;
  return {
    client,
    task,
    act,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

test('optional timer accumulates work across pauses and reloads without counting breaks', () => {
  const f = setup();
  expect(f.task.timeTracking).toBeUndefined();
  const start = f.act('start');
  f.advance(60_000);
  expect(trackedTime(start, f.now())).toBe(59_999); // edit timestamps are monotonic
  const repeated = f.act('start');
  expect(repeated.timeTracking?.startedAt).toBe(start.timeTracking?.startedAt);
  const pending = JSON.stringify(f.client.record.pending);
  const reloaded = structuredClone(f.client.record);
  f.advance(30_000);
  expect(trackedTime(reloaded.pending.at(-1)!.task, f.now())).toBe(89_999);
  expect(JSON.stringify(f.client.record.pending)).toBe(pending);
  const paused = f.act('pause');
  const elapsed = paused.timeTracking!.elapsedMs;
  f.advance(600_000);
  expect(trackedTime(f.act('pause'), f.now())).toBe(elapsed);
  const resumed = f.act('start');
  f.advance(20_000);
  expect(trackedTime(resumed, f.now())).toBe(elapsed + 19_999);
  expect(trackedTime(resumed, 0)).toBe(elapsed);
});

for (const operation of ['complete', 'archive', 'delete']) {
  test(`${operation} pauses tracking and restoring never resumes it`, () => {
    const f = setup();
    f.act('start');
    f.advance(5000);
    const path = `/api/tasks/${f.task.id}`;
    const stopped =
      operation === 'complete'
        ? f.client.update(f.task.id, { status: 'done' })
        : operation === 'delete'
          ? f.client.remove(f.task.id)
          : queueChange(f.client.record, `${path}/archive`, 'POST', {}, f.now()).task;
    expect(stopped.timeTracking?.startedAt).toBeNull();
    expect(stopped.timeTracking!.elapsedMs).toBeGreaterThan(0);
    f.advance(10_000);
    const restored =
      operation === 'complete'
        ? f.client.update(f.task.id, { status: 'later' })
        : operation === 'delete'
          ? f.client.restore(f.task.id)
          : queueChange(f.client.record, `${path}/unarchive`, 'POST', {}, f.now()).task;
    expect(restored.timeTracking).toEqual(stopped.timeTracking);
  });
}

test('timer operations enforce task state and validate persisted data', () => {
  const f = setup();
  expect(() => f.act('start', 'PATCH')).toThrow('POST');
  expect(() => f.act('start', 'DELETE')).toThrow('POST');
  expect(() => f.act('reset')).toThrow('Start or Pause');
  for (const timeTracking of [
    null,
    [],
    { elapsedMs: -1, startedAt: null },
    { elapsedMs: 1.5, startedAt: null },
    { elapsedMs: Infinity, startedAt: null },
    { elapsedMs: 0, startedAt: 'invalid' },
    { elapsedMs: 0 },
    { elapsedMs: 0, startedAt: null, extra: true },
  ]) {
    expect(() => validate({ ...f.task, timeTracking })).toThrow();
  }
  f.client.update(f.task.id, { status: 'done' });
  expect(() => f.act('start')).toThrow('Reopen');
});

test('tracking stays inside encrypted task data and survives decrypt validation', async () => {
  const f = setup();
  f.act('start');
  f.advance(12_345);
  const paused = f.act('pause');
  const envelope = await encryptChange(
    testVault.key,
    testVault.config.vaultId,
    f.client.record.pending.at(-1)!,
  );
  expect(JSON.stringify(envelope)).not.toContain('timeTracking');
  const decoded = await decryptEnvelope(testVault.key, testVault.config.vaultId, envelope);
  validate(decoded);
  expect(decoded.timeTracking).toEqual(paused.timeTracking);
});

test('older-client completion pauses unknown timer fields at the edit timestamp', () => {
  const f = setup();
  const running = f.act('start');
  f.advance(15_000);
  const completed = {
    ...running,
    status: 'done',
    updatedAt: new Date(f.now()).toISOString(),
  };
  const original = JSON.stringify(running.timeTracking);
  validate(completed);
  expect(completed.timeTracking).toEqual({ elapsedMs: 14_999, startedAt: null });
  expect(JSON.stringify(running.timeTracking)).toBe(original);
});

test('time stats include running and archived work, exclude deleted and untracked tasks', () => {
  const f = setup();
  const paused = { ...f.task, timeTracking: { elapsedMs: 60_000, startedAt: null } };
  const active = {
    ...paused,
    id: 'active',
    timeTracking: { elapsedMs: 30_000, startedAt: new Date(f.now() - 10_000).toISOString() },
  };
  const stats = computeStats(
    [
      f.task,
      paused,
      active,
      { ...paused, id: 'archive', archivedAt: new Date(f.now()).toISOString() },
      { ...paused, id: 'deleted', deletedAt: new Date(f.now()).toISOString() },
    ],
    { day: '2026-10-07', week: '2026-10-05', timezone: 'UTC', now: f.now() },
  );
  expect(stats.tracking).toMatchObject({
    totalMs: 160_000,
    count: 3,
    running: 1,
    averageMs: 160_000 / 3,
  });
  expect(stats.tracking.tasks.map((task) => task.id)).not.toContain('deleted');
  expect(formatTrackedTime(3_661_999)).toBe('1h 01m 01s');
});

test('adding a task opts into tracking without starting and preserves existing timers on retries', () => {
  const f = setup();
  const added = f.act('add');
  expect(added.timeTracking).toEqual({ elapsedMs: 0, startedAt: null });
  f.advance(60_000);
  expect(trackedTime(added, f.now())).toBe(0);
  const running = f.act('start');
  expect(f.act('add').timeTracking).toEqual(running.timeTracking);
  f.advance(10_000);
  const paused = f.act('pause');
  expect(f.act('add').timeTracking).toEqual(paused.timeTracking);
});
