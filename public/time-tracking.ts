import type { Task } from './types.js';

export function trackedTime(task: Task, now = Date.now()): number {
  const tracking = task.timeTracking;
  if (!tracking) return 0;
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    tracking.elapsedMs +
      (tracking.startedAt ? Math.max(0, now - Date.parse(tracking.startedAt)) : 0),
  );
}

export function pauseTracking(task: Task, now: number) {
  if (task.timeTracking?.startedAt) {
    task.timeTracking = { elapsedMs: trackedTime(task, now), startedAt: null };
  }
}

export function formatTrackedTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours}h ${minutes.toString().padStart(2, '0')}m ${(seconds % 60).toString().padStart(2, '0')}s`;
}
