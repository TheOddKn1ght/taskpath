import type { Database } from 'bun:sqlite';
import { connect, openDatabase, type AppDatabase } from './db/connection';
import { AccountRepository } from './db/accounts';
import { WorkspaceRepository } from './db/workspace';
import { validateEnvelope, validId } from '../public/crypto.js';

export class InputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected an object.');
  return value;
}
export class Store {
  readonly db: Database;
  readonly timezone: string;
  readonly orm: AppDatabase;
  readonly workspace: WorkspaceRepository;
  private accounts: AccountRepository;
  constructor(path = ':memory:', private now = () => new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    this.db = openDatabase(path, timezone);
    this.orm = connect(this.db);
    this.workspace = new WorkspaceRepository(this.orm);
    this.accounts = new AccountRepository(this.orm);
    this.timezone = this.workspace.setting('timezone', () => timezone);
  }

  close() { this.db.close(); }
  config(userId: string): any { const row = this.accounts.get(userId); return row?.status === 'active' ? JSON.parse(row.config!) : null; }
  syncBoard(userId: string) {
    return { format: 1, workspaceKey: this.config(userId)?.vaultId, pushEnabled: this.pushEnabled(userId), timezone: this.timezone, serverTime: this.now().toISOString(), rows: this.workspace.envelopes(userId).map(row => JSON.parse(row.envelope)) };
  }
  sync(userId: string, input: any) {
    const vaultId = this.config(userId)?.vaultId;
    if (!vaultId) throw new InputError('Account unavailable.', 403);
    if (input.workspaceKey !== vaultId) throw new InputError('This server has a different workspace. Your encrypted changes remain on this device.', 409);
    if (Object.keys(input).some(k => !['workspaceKey', 'changes', 'reminders'].includes(k)) || !Array.isArray(input.changes) || input.changes.length > 50) throw new InputError('Send at most 50 encrypted changes.');
    const reminders = input.reminders ?? [];
    if (!Array.isArray(reminders) || reminders.length > 50) throw new InputError('Send at most 50 reminder schedules.');
    for (const r of reminders) {
      object(r);
      if (Object.keys(r).some(k => !['taskId', 'changeId', 'token', 'dueAt'].includes(k)) || !validId(r.taskId) || !validId(r.changeId)
        || (r.token === null ? r.dueAt !== null : !validId(r.token) || r.token.length < 32 || typeof r.dueAt !== 'string' || !Number.isFinite(Date.parse(r.dueAt)) || new Date(r.dueAt).toISOString() !== r.dueAt)) throw new InputError('Use only opaque reminder IDs and an ISO reminder time.');
    }
    for (const envelope of input.changes) {
      try { validateEnvelope(envelope, vaultId); } catch { throw new InputError('Invalid encrypted change. Plaintext sync is unsupported.'); }
      if (Date.parse(envelope.editedAt) > this.now().getTime() + 300000) throw new InputError('Edit time is too far in the future. Check this device’s clock.');
    }
    return this.workspace.transaction(() => {
      const acknowledged: string[] = [];
      let conflicts = 0, changed = false;
      for (const e of input.changes) {
        const current = this.workspace.revision(userId, e.taskId);
        acknowledged.push(e.changeId);
        if (current && (current.editedAt > e.editedAt || (current.editedAt === e.editedAt && current.changeId >= e.changeId))) {
          if (current.changeId !== e.changeId) conflicts++;
          continue;
        }
        this.workspace.saveEnvelope({ userId, taskId: e.taskId, editedAt: e.editedAt, changeId: e.changeId, envelope: JSON.stringify(e) });
        // Until matching metadata arrives, never send the previous revision's reminder.
        this.workspace.cancelReminder(userId, e.taskId);
        changed = true;
      }
      if (this.pushEnabled(userId)) for (const r of reminders) {
        const current = this.workspace.revision(userId, r.taskId);
        if (current?.changeId !== r.changeId) continue;
        if (r.token === null) this.workspace.cancelReminder(userId, r.taskId);
        else this.workspace.saveReminder({ userId, taskId: r.taskId, changeId: r.changeId, token: r.token, dueAt: Date.parse(r.dueAt) });
      }
      return { ...this.syncBoard(userId), acknowledged, reminderAcknowledged: reminders.map(r => ({ taskId: r.taskId, changeId: r.changeId })), conflicts, changed };
    });
  }
  pushEnabled(userId: string) { return this.workspace.pushEnabled(userId); }
  claim(userId: string, tokens: unknown) {
    if (!Array.isArray(tokens) || tokens.length > 100 || tokens.some(t => !validId(t) || t.length < 32)) throw new InputError('Invalid reminder tokens.');
    return this.workspace.transaction(() => ({ tokens: tokens.filter(token => this.workspace.claim(userId, token)) }));
  }
}
