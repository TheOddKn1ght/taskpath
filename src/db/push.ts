import { Database, transaction } from './connection.ts';
import type { ReminderRow } from './workspace.ts';

export interface Delivery {
  userId: string;
  taskId: string;
  token: string;
  subscriptionId: string;
  nextAt: number;
  attempts: number;
}

export type DeliveryJob = Delivery & { subscription: string };
type DeliveryId = Pick<Delivery, 'userId' | 'token' | 'subscriptionId'>;

export class PushRepository {
  constructor(private db: Database) {}

  transaction<T>(work: () => T): T { return transaction(this.db, work); }

  subscriptionIds(userId: string): string[] {
    return (this.db.prepare('SELECT id FROM push_subscriptions WHERE userId=?').all(userId) as { id: string }[]).map(row => row.id);
  }

  subscriptionOwner(id: string): string | undefined {
    return (this.db.prepare('SELECT userId FROM push_subscriptions WHERE id=?').get(id) as { userId: string } | undefined)?.userId;
  }

  subscriptionCount(userId: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE userId=?').get(userId) as { n: number }).n;
  }

  saveSubscription(id: string, userId: string, subscription: string): void {
    this.db.prepare(`INSERT INTO push_subscriptions(id, userId, subscription) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET userId=excluded.userId, subscription=excluded.subscription`).run(id, userId, subscription);
  }

  removeSubscription(userId: string, id: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE userId=? AND id=?').run(userId, id);
  }

  cancelSubscriptionDeliveries(id: string, userId?: string): void {
    if (userId === undefined) this.db.prepare('DELETE FROM push_deliveries WHERE subscriptionId=?').run(id);
    else this.db.prepare('DELETE FROM push_deliveries WHERE subscriptionId=? AND userId=?').run(id, userId);
  }

  clearReminders(userId: string): void {
    this.db.prepare('DELETE FROM push_reminders WHERE userId=?').run(userId);
  }

  // Keep these correlated queue queries explicit: each predicate controls which
  // account/revision is allowed to send.
  dueReminders(now: number): ReminderRow[] {
    return this.db.prepare(`SELECT r.* FROM push_reminders r JOIN accounts a ON a.userId=r.userId AND a.status='active'
      WHERE r.dueAt<=? AND r.dueAt>=?
      AND NOT EXISTS(SELECT 1 FROM reminder_claims c WHERE c.userId=r.userId AND c.token=r.token)
      AND EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.userId=r.userId) ORDER BY r.dueAt LIMIT 100`).all(now, now - 86400000) as ReminderRow[];
  }

  enqueueDeliveries(reminder: ReminderRow, now: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO push_deliveries(userId,taskId,token,subscriptionId,nextAt)
      SELECT ?,?,?,id,? FROM push_subscriptions WHERE userId=?`).run(reminder.userId, reminder.taskId, reminder.token, now, reminder.userId);
  }

  cancelStaleDeliveries(now: number): void {
    this.db.prepare(`DELETE FROM push_deliveries WHERE NOT EXISTS(
      SELECT 1 FROM push_reminders r JOIN accounts a ON a.userId=r.userId AND a.status='active'
      JOIN push_subscriptions s ON s.id=push_deliveries.subscriptionId AND s.userId=r.userId
      WHERE r.userId=push_deliveries.userId AND r.taskId=push_deliveries.taskId
      AND r.token=push_deliveries.token AND r.dueAt>=?)`).run(now - 86400000);
  }

  leaseNextDelivery(now: number): DeliveryJob | undefined {
    return transaction(this.db, () => {
      const job = (this.db.prepare(`SELECT d.*,s.subscription FROM push_deliveries d
        JOIN push_subscriptions s ON s.id=d.subscriptionId
        WHERE d.nextAt<=? ORDER BY d.nextAt LIMIT 1`).all(now) as DeliveryJob[])[0];
      if (job) this.db.prepare('UPDATE push_deliveries SET nextAt=?, attempts=attempts + 1 WHERE userId=? AND token=? AND subscriptionId=?')
        .run(now + 60000, job.userId, job.token, job.subscriptionId);
      return job;
    });
  }

  deliveryIsCurrent(job: DeliveryJob, now: number): boolean {
    return Boolean((this.db.prepare(`SELECT 1 AS ok FROM push_reminders r
      JOIN accounts a ON a.userId=r.userId AND a.status='active'
      WHERE r.userId=? AND r.taskId=? AND r.token=? AND r.dueAt<=?`).get(job.userId, job.taskId, job.token, now) as { ok: number } | undefined));
  }

  dropDelivery(job: DeliveryId): void {
    this.db.prepare('DELETE FROM push_deliveries WHERE userId=? AND token=? AND subscriptionId=?').run(job.userId, job.token, job.subscriptionId);
  }

  retryDelivery(job: DeliveryId, nextAt: number): void {
    this.db.prepare('UPDATE push_deliveries SET nextAt=? WHERE userId=? AND token=? AND subscriptionId=?').run(nextAt, job.userId, job.token, job.subscriptionId);
  }
}
