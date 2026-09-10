import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
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
  constructor(path = ':memory:', private now = () => new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    // Inspect read-only BEFORE WAL, schema writes, or directory creation. Never migrate plaintext.
    if (path !== ':memory:' && existsSync(path) && statSync(path).size) {
      const old = new Database(path, { readonly: true });
      try {
        const tables = old.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
        if (tables.length && (!tables.includes('encrypted_format') || old.query<{ version: number }, []>('SELECT version FROM encrypted_format').get()?.version !== 2 || tables.includes('tasks'))) {
          throw new Error('Legacy or unsupported database. Nothing was changed. Use a fresh multi-user database or Docker volume. Existing data was left untouched.');
        }
      } finally { old.close(); }
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS encrypted_format (version INTEGER NOT NULL);
      INSERT INTO encrypted_format SELECT 2 WHERE NOT EXISTS (SELECT 1 FROM encrypted_format);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (userId TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')), createdAt INTEGER NOT NULL, tokenHash TEXT, expiresAt INTEGER, revision INTEGER, config TEXT, verifier TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS invitation_hash ON accounts(tokenHash) WHERE tokenHash IS NOT NULL;
      CREATE TABLE IF NOT EXISTS encrypted_tasks (userId TEXT NOT NULL, taskId TEXT NOT NULL, editedAt TEXT NOT NULL, changeId TEXT NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(userId, taskId));
      CREATE TABLE IF NOT EXISTS reminder_claims (userId TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(userId, token));
      CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, subscription TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_reminders (userId TEXT NOT NULL, taskId TEXT NOT NULL, changeId TEXT NOT NULL, token TEXT NOT NULL, dueAt INTEGER NOT NULL, PRIMARY KEY(userId, taskId));
      CREATE TABLE IF NOT EXISTS push_deliveries (userId TEXT NOT NULL, taskId TEXT NOT NULL, token TEXT NOT NULL, subscriptionId TEXT NOT NULL, nextAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(userId, token, subscriptionId));
      CREATE INDEX IF NOT EXISTS push_due ON push_reminders(dueAt);
    `);
    this.db.query("INSERT OR IGNORE INTO settings VALUES ('timezone', ?)").run(timezone);
    this.timezone = this.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='timezone'").get()!.value;
  }
  close() { this.db.close(); }
  config(userId: string): any { const row = this.db.query<{ config: string }, [string]>("SELECT config FROM accounts WHERE userId=? AND status='active'").get(userId); return row ? JSON.parse(row.config) : null; }
  syncBoard(userId: string) {
    return { format: 1, workspaceKey: this.config(userId)?.vaultId, pushEnabled: this.pushEnabled(userId), timezone: this.timezone, serverTime: this.now().toISOString(), rows: this.db.query<{ envelope: string }, [string]>('SELECT envelope FROM encrypted_tasks WHERE userId=? ORDER BY taskId').all(userId).map(row => JSON.parse(row.envelope)) };
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
    return this.db.transaction(() => {
      const acknowledged: string[] = [];
      let conflicts = 0, changed = false;
      for (const e of input.changes) {
        const current = this.db.query<{ editedAt: string; changeId: string }, [string, string]>('SELECT editedAt, changeId FROM encrypted_tasks WHERE userId=? AND taskId=?').get(userId, e.taskId);
        acknowledged.push(e.changeId);
        if (current && (current.editedAt > e.editedAt || (current.editedAt === e.editedAt && current.changeId >= e.changeId))) {
          if (current.changeId !== e.changeId) conflicts++;
          continue;
        }
        this.db.query('INSERT INTO encrypted_tasks VALUES (?, ?, ?, ?, ?) ON CONFLICT(userId, taskId) DO UPDATE SET editedAt=excluded.editedAt, changeId=excluded.changeId, envelope=excluded.envelope').run(userId, e.taskId, e.editedAt, e.changeId, JSON.stringify(e));
        // Until matching metadata arrives, never send the previous revision's reminder.
        this.db.query('DELETE FROM push_reminders WHERE userId=? AND taskId=?').run(userId, e.taskId);
        changed = true;
      }
      if (this.pushEnabled(userId)) for (const r of reminders) {
        const current = this.db.query<{ changeId: string }, [string, string]>('SELECT changeId FROM encrypted_tasks WHERE userId=? AND taskId=?').get(userId, r.taskId);
        if (current?.changeId !== r.changeId) continue;
        if (r.token === null) this.db.query('DELETE FROM push_reminders WHERE userId=? AND taskId=?').run(userId, r.taskId);
        else this.db.query('INSERT INTO push_reminders VALUES (?, ?, ?, ?, ?) ON CONFLICT(userId,taskId) DO UPDATE SET changeId=excluded.changeId,token=excluded.token,dueAt=excluded.dueAt').run(userId, r.taskId, r.changeId, r.token, Date.parse(r.dueAt));
      }
      return { ...this.syncBoard(userId), acknowledged, reminderAcknowledged: reminders.map(r => ({ taskId: r.taskId, changeId: r.changeId })), conflicts, changed };
    })();
  }
  pushEnabled(userId: string) { return Boolean(this.db.query('SELECT 1 FROM push_subscriptions WHERE userId=? LIMIT 1').get(userId)); }
  claim(userId: string, tokens: unknown) {
    if (!Array.isArray(tokens) || tokens.length > 100 || tokens.some(t => !validId(t) || t.length < 32)) throw new InputError('Invalid reminder tokens.');
    return this.db.transaction(() => ({ tokens: tokens.filter(token => this.db.query('INSERT OR IGNORE INTO reminder_claims VALUES (?, ?)').run(userId, token).changes === 1) }))();
  }
}
