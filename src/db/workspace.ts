import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from './connection';
import { encryptedTasks, pushReminders, pushSubscriptions, reminderClaims, settings, type EncryptedTaskRow, type ReminderRow } from './schema';

export class WorkspaceRepository {
  constructor(private db: AppDatabase) {}

  transaction<T>(work: () => T): T { return this.db.transaction(work); }

  setting(key: string, initialValue: () => string): string {
    return this.transaction(() => {
      const current = this.db.select().from(settings).where(eq(settings.key, key)).get();
      if (current) return current.value;
      const value = initialValue();
      this.db.insert(settings).values({ key, value }).run();
      return value;
    });
  }

  envelopes(userId: string) {
    return this.db.select({ envelope: encryptedTasks.envelope }).from(encryptedTasks)
      .where(eq(encryptedTasks.userId, userId)).orderBy(encryptedTasks.taskId).all();
  }

  revision(userId: string, taskId: string) {
    return this.db.select({ editedAt: encryptedTasks.editedAt, changeId: encryptedTasks.changeId }).from(encryptedTasks)
      .where(and(eq(encryptedTasks.userId, userId), eq(encryptedTasks.taskId, taskId))).get();
  }

  saveEnvelope(row: EncryptedTaskRow) {
    this.db.insert(encryptedTasks).values(row).onConflictDoUpdate({
      target: [encryptedTasks.userId, encryptedTasks.taskId],
      set: { editedAt: row.editedAt, changeId: row.changeId, envelope: row.envelope },
    }).run();
  }

  cancelReminder(userId: string, taskId: string) {
    this.db.delete(pushReminders).where(and(eq(pushReminders.userId, userId), eq(pushReminders.taskId, taskId))).run();
  }

  saveReminder(row: ReminderRow) {
    this.db.insert(pushReminders).values(row).onConflictDoUpdate({
      target: [pushReminders.userId, pushReminders.taskId],
      set: { changeId: row.changeId, token: row.token, dueAt: row.dueAt },
    }).run();
  }

  pushEnabled(userId: string) {
    return Boolean(this.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).limit(1).get());
  }

  claim(userId: string, token: string) {
    return Boolean(this.db.insert(reminderClaims).values({ userId, token }).onConflictDoNothing()
      .returning({ token: reminderClaims.token }).get());
  }
}
