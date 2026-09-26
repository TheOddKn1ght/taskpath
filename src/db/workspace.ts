import { Database, transaction } from './connection.ts';

export interface EncryptedTaskRow {
  userId: string;
  taskId: string;
  editedAt: string;
  changeId: string;
  envelope: string;
}

export interface ReminderRow {
  userId: string;
  taskId: string;
  changeId: string;
  token: string;
  dueAt: number;
}

export class WorkspaceRepository {
  constructor(private db: Database) {}

  transaction<T>(work: () => T): T { return transaction(this.db, work); }

  setting(key: string, initialValue: () => string): string {
    return transaction(this.db, () => {
      const current = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
      if (current) return current.value;
      const value = initialValue();
      this.db.prepare('INSERT INTO settings(key, value) VALUES (?,?)').run(key, value);
      return value;
    });
  }

  page(userId: string, after: number): (EncryptedTaskRow & { sequence: number })[] {
    return this.db.prepare('SELECT userId, taskId, editedAt, changeId, envelope, sequence FROM encrypted_tasks WHERE userId=? AND sequence>? ORDER BY sequence LIMIT 51').all(userId, after) as (EncryptedTaskRow & { sequence: number })[];
  }
  envelope(userId: string, taskId: string): { envelope: string } {
    return this.db.prepare('SELECT envelope FROM encrypted_tasks WHERE userId=? AND taskId=?').get(userId, taskId) as { envelope: string };
  }
  revision(userId: string, taskId: string): { editedAt: string; changeId: string } | undefined {
    return this.db.prepare('SELECT editedAt, changeId FROM encrypted_tasks WHERE userId=? AND taskId=?').get(userId, taskId) as { editedAt: string; changeId: string } | undefined;
  }

  saveEnvelope(row: EncryptedTaskRow): void {
    // Encrypted tombstones are retained, so the indexed maximum is the durable
    // account counter. Allocate inside the surrounding winning-write transaction.
    const sequence = (this.db.prepare('SELECT coalesce(max(sequence), 0) + 1 AS value FROM encrypted_tasks WHERE userId=?').get(row.userId) as { value: number }).value;
    this.db.prepare(`INSERT INTO encrypted_tasks(userId, taskId, editedAt, changeId, envelope, sequence) VALUES (?,?,?,?,?,?)
      ON CONFLICT(userId, taskId) DO UPDATE SET sequence=excluded.sequence, editedAt=excluded.editedAt, changeId=excluded.changeId, envelope=excluded.envelope`).run(row.userId, row.taskId, row.editedAt, row.changeId, row.envelope, sequence);
  }

  cancelReminder(userId: string, taskId: string): void {
    this.db.prepare('DELETE FROM push_reminders WHERE userId=? AND taskId=?').run(userId, taskId);
  }

  saveReminder(row: ReminderRow): void {
    this.db.prepare(`INSERT INTO push_reminders(userId, taskId, changeId, token, dueAt) VALUES (?,?,?,?,?)
      ON CONFLICT(userId, taskId) DO UPDATE SET changeId=excluded.changeId, token=excluded.token, dueAt=excluded.dueAt`).run(row.userId, row.taskId, row.changeId, row.token, row.dueAt);
  }

  pushEnabled(userId: string): boolean {
    return Boolean((this.db.prepare('SELECT id FROM push_subscriptions WHERE userId=? LIMIT 1').get(userId) as { id: string } | undefined));
  }

  claim(userId: string, token: string): boolean {
    return Boolean((this.db.prepare('INSERT INTO reminder_claims(userId, token) VALUES (?,?) ON CONFLICT(userId, token) DO NOTHING RETURNING token').get(userId, token) as { token: string } | undefined));
  }
}
