import { and, count, eq, sql } from 'drizzle-orm';
import type { AppDatabase } from './connection';
import { pushDeliveries, pushReminders, pushSubscriptions, type Delivery, type ReminderRow } from './schema';

type DeliveryJob = Delivery & { subscription: string };
type DeliveryId = Pick<Delivery, 'userId' | 'token' | 'subscriptionId'>;
const deliveryMatches = (job: DeliveryId) => and(
  eq(pushDeliveries.userId, job.userId), eq(pushDeliveries.token, job.token), eq(pushDeliveries.subscriptionId, job.subscriptionId),
);

export class PushRepository {
  constructor(private db: AppDatabase) {}

  transaction<T>(work: () => T): T { return this.db.transaction(work); }

  subscriptionIds(userId: string) {
    return this.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all().map(row => row.id);
  }

  subscriptionOwner(id: string) {
    return this.db.select({ userId: pushSubscriptions.userId }).from(pushSubscriptions).where(eq(pushSubscriptions.id, id)).get()?.userId;
  }

  subscriptionCount(userId: string) {
    return this.db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).get()!.n;
  }

  saveSubscription(id: string, userId: string, subscription: string) {
    this.db.insert(pushSubscriptions).values({ id, userId, subscription })
      .onConflictDoUpdate({ target: pushSubscriptions.id, set: { userId, subscription } }).run();
  }

  removeSubscription(userId: string, id: string) {
    this.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.id, id))).run();
  }

  cancelSubscriptionDeliveries(id: string, userId?: string) {
    this.db.delete(pushDeliveries).where(and(eq(pushDeliveries.subscriptionId, id),
      userId === undefined ? undefined : eq(pushDeliveries.userId, userId))).run();
  }

  clearReminders(userId: string) {
    this.db.delete(pushReminders).where(eq(pushReminders.userId, userId)).run();
  }

  // Keep these correlated queue queries explicit: each predicate controls which
  // account/revision is allowed to send. Drizzle binds all dynamic values.
  dueReminders(now: number): ReminderRow[] {
    return this.db.all<ReminderRow>(sql`SELECT r.* FROM push_reminders r JOIN accounts a ON a.userId=r.userId AND a.status='active'
      WHERE r.dueAt<=${now} AND r.dueAt>=${now - 86400000}
      AND NOT EXISTS(SELECT 1 FROM reminder_claims c WHERE c.userId=r.userId AND c.token=r.token)
      AND EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.userId=r.userId) ORDER BY r.dueAt LIMIT 100`);
  }

  enqueueDeliveries(reminder: ReminderRow, now: number) {
    this.db.run(sql`INSERT OR IGNORE INTO push_deliveries(userId,taskId,token,subscriptionId,nextAt)
      SELECT ${reminder.userId},${reminder.taskId},${reminder.token},id,${now}
      FROM push_subscriptions WHERE userId=${reminder.userId}`);
  }

  cancelStaleDeliveries(now: number) {
    this.db.run(sql`DELETE FROM push_deliveries WHERE NOT EXISTS(
      SELECT 1 FROM push_reminders r JOIN accounts a ON a.userId=r.userId AND a.status='active'
      JOIN push_subscriptions s ON s.id=push_deliveries.subscriptionId AND s.userId=r.userId
      WHERE r.userId=push_deliveries.userId AND r.taskId=push_deliveries.taskId
      AND r.token=push_deliveries.token AND r.dueAt>=${now - 86400000})`);
  }

  leaseNextDelivery(now: number): DeliveryJob | undefined {
    return this.transaction(() => {
      const job = this.db.all<DeliveryJob>(sql`SELECT d.*,s.subscription FROM push_deliveries d
        JOIN push_subscriptions s ON s.id=d.subscriptionId
        WHERE d.nextAt<=${now} ORDER BY d.nextAt LIMIT 1`)[0];
      if (job) this.db.update(pushDeliveries).set({ nextAt: now + 60000, attempts: sql`${pushDeliveries.attempts} + 1` })
        .where(deliveryMatches(job)).run();
      return job;
    });
  }

  deliveryIsCurrent(job: DeliveryJob, now: number) {
    return Boolean(this.db.all(sql`SELECT 1 FROM push_reminders r
      JOIN accounts a ON a.userId=r.userId AND a.status='active'
      WHERE r.userId=${job.userId} AND r.taskId=${job.taskId} AND r.token=${job.token} AND r.dueAt<=${now}`)[0]);
  }

  dropDelivery(job: DeliveryId) {
    this.db.delete(pushDeliveries).where(deliveryMatches(job)).run();
  }

  retryDelivery(job: DeliveryId, nextAt: number) {
    this.db.update(pushDeliveries).set({ nextAt }).where(deliveryMatches(job)).run();
  }
}
