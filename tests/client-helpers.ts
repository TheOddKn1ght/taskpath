// Adapter around production browser domain functions. No plaintext SQL implementation.
import { project, queueChange, calendarAt } from '../public/offline-model.js';
import { previewImport } from '../public/offline.js';
export const statuses = ['later', 'week', 'today', 'done'];
export type Task = any;
export const calendar = (date: Date, timezone: string) => calendarAt(date.getTime(), timezone);
export class ClientStore {
  record: any;
  constructor(_path = ':memory:', public now = () => new Date(), public timezone = 'UTC') {
    this.record = { board: { workspaceKey: 'test', rows: [], timezone, serverTime: now().toISOString() }, pending: [], offset: 0, lastEdit: 0 };
  }
  close() {}
  board() { return project(this.record, this.now().getTime()); }
  syncBoard() { return { ...this.board(), rows: this.board().rows }; }
  private change(path: string, method: string, input = {}) {
    const copy = structuredClone(this.record);
    const result = queueChange(copy, path, method, input, this.now().getTime());
    this.record = copy;
    return result.task;
  }
  create(input: any) { return this.change('/api/tasks', 'POST', input); }
  update(id: string, input: any) { return this.change(`/api/tasks/${id}`, 'PATCH', input); }
  remove(id: string) { return this.change(`/api/tasks/${id}`, 'DELETE'); }
  restore(id: string) { return this.change(`/api/tasks/${id}/restore`, 'POST'); }
  actOnReminder(id: string, input: any) { return this.change(`/api/tasks/${id}/reminder`, 'POST', input); }
  previewImport(tasks: any[]) { return previewImport(tasks, this.record, this.now().getTime()); }
  importTasks(tasks: any[]) {
    const preview = this.previewImport(tasks), copy = structuredClone(this.record);
    for (const task of preview.tasks) queueChange(copy, '/api/tasks', 'POST', task, this.now().getTime());
    this.record = copy;
    return { imported: preview.tasks.length, skipped: preview.skipped };
  }
}
