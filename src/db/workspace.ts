import { and, eq, gt, sql } from 'drizzle-orm';
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

  page(userId: string, after: number) {
    return this.db.select().from(encryptedTasks).where(and(eq(encryptedTasks.userId, userId), gt(encryptedTasks.sequence, after))).orderBy(encryptedTasks.sequence).limit(51).all();
  }
  envelope(userId:string, taskId:string) {
    return this.db.select({envelope:encryptedTasks.envelope}).from(encryptedTasks).where(and(eq(encryptedTasks.userId,userId),eq(encryptedTasks.taskId,taskId))).get()!;
  }
  revision(userId: string, taskId: string) {
    return this.db.select({ editedAt: encryptedTasks.editedAt, changeId: encryptedTasks.changeId }).from(encryptedTasks)
      .where(and(eq(encryptedTasks.userId, userId), eq(encryptedTasks.taskId, taskId))).get();
  }

  saveEnvelope(row: EncryptedTaskRow) {
    // Encrypted tombstones are retained, so the indexed maximum is the durable
    // account counter. Allocate inside the surrounding winning-write transaction.
    const sequence = this.db.select({value:sql<number>`coalesce(max(${encryptedTasks.sequence}), 0) + 1`}).from(encryptedTasks).where(eq(encryptedTasks.userId,row.userId)).get()!.value;
    this.db.insert(encryptedTasks).values({...row, sequence}).onConflictDoUpdate({
      target: [encryptedTasks.userId, encryptedTasks.taskId],
      set: { sequence, editedAt: row.editedAt, changeId: row.changeId, envelope: row.envelope },
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
