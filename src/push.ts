import webpush from 'web-push';
import { createHash, ECDH } from 'node:crypto';
import { InputError, object, Store } from './store';

export const subscriptionId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');
export function subscription(input: any) {
  const value = object(input), keys = object(value.keys);
  if (Object.keys(value).some(k => !['endpoint', 'expirationTime', 'keys'].includes(k)) || Object.keys(keys).some(k => !['p256dh', 'auth'].includes(k))) throw new InputError('Invalid push subscription.');
  try {
    if (typeof value.endpoint !== 'string' || value.endpoint.length > 2048) throw new Error();
    const url = new URL(value.endpoint);
    const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(url.hostname) || url.hostname.endsWith('.notify.windows.com');
    if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error();
    for (const [name, size] of [['p256dh', 65], ['auth', 16]] as const) {
      if (typeof keys[name] !== 'string' || !/^[\w-]+$/.test(keys[name]) || Buffer.from(keys[name], 'base64url').length !== size) throw new Error();
    }
    ECDH.convertKey(Buffer.from(keys.p256dh, 'base64url'), 'prime256v1');
  } catch { throw new InputError('Unsupported or invalid browser push subscription.'); }
  return { endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// These signing keys authorize generic push messages; they cannot decrypt a vault.
export class PushService {
  private keys: { publicKey: string; privateKey: string } | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(private store: Store, private subject?: string, private send = webpush.sendNotification.bind(webpush), private now = () => Date.now()) {
    if (!subject) return;
    const url = new URL(subject);
    if (!['https:', 'mailto:'].includes(url.protocol)) throw new Error('Push contact must be an HTTPS URL or mailto address.');
    const db = store.db;
    this.keys = db.transaction(() => {
      const row = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='push-vapid'").get();
      if (row) return JSON.parse(row.value);
      const keys = webpush.generateVAPIDKeys();
      db.query("INSERT INTO settings VALUES ('push-vapid', ?)").run(JSON.stringify(keys));
      return keys;
    })();
  }
  status(userId: string) {
    return { available: Boolean(this.keys), publicKey: this.keys?.publicKey || null, subscriptionIds: this.store.db.query<{ id: string }, [string]>('SELECT id FROM push_subscriptions WHERE userId=?').all(userId).map(r => r.id) };
  }
  subscribe(userId: string, input: unknown) {
    if (!this.keys) throw new InputError('Background notifications need TASKPATH_ORIGIN set to your public HTTPS address.', 503);
    const value = subscription(input), id = subscriptionId(value.endpoint), db = this.store.db;
    db.transaction(() => {
      const previous = db.query<{ userId: string }, [string]>('SELECT userId FROM push_subscriptions WHERE id=?').get(id);
      if (previous?.userId !== userId && db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM push_subscriptions WHERE userId=?').get(userId)!.n >= 10) throw new InputError('Up to 10 notification devices per account.', 409);
      if (previous?.userId !== userId) db.query('DELETE FROM push_deliveries WHERE subscriptionId=?').run(id);
      db.query('INSERT INTO push_subscriptions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET userId=excluded.userId,subscription=excluded.subscription').run(id, userId, JSON.stringify(value));
      if (previous && previous.userId !== userId) this.cleanup(previous.userId);
    })();
    return { id };
  }
  remove(userId: string, id: unknown) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new InputError('Invalid subscription ID.');
    this.store.db.transaction(() => {
      this.store.db.query('DELETE FROM push_subscriptions WHERE userId=? AND id=?').run(userId, id);
      this.store.db.query('DELETE FROM push_deliveries WHERE userId=? AND subscriptionId=?').run(userId, id);
      this.cleanup(userId);
    })();
    return { ok: true };
  }
  private cleanup(userId: string) {
    if (!this.store.pushEnabled(userId)) this.store.db.query('DELETE FROM push_reminders WHERE userId=?').run(userId);
  }
  start() { if (this.keys && !this.timer) { this.timer = setInterval(() => { void this.tick(); }, 15000); this.timer.unref(); void this.tick(); } }
  async stop() { clearInterval(this.timer); await this.running; }
  tick() {
    if (!this.keys) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.dispatch().catch(() => { console.error('Taskpath push delivery will retry.'); }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async dispatch() {
    const db = this.store.db, now = this.now();
    db.transaction(() => {
      // A token is claimed once; fan-out is durable and independent for each device.
      const due = db.query<any, [number, number]>(`SELECT r.* FROM push_reminders r JOIN accounts a ON a.userId=r.userId AND a.status='active'
        WHERE r.dueAt<=? AND r.dueAt>=? AND NOT EXISTS(SELECT 1 FROM reminder_claims c WHERE c.userId=r.userId AND c.token=r.token)
        AND EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.userId=r.userId) ORDER BY r.dueAt LIMIT 100`).all(now, now - 86400000);
      for (const r of due) {
        if (!this.store.claim(r.userId, [r.token]).tokens.length) continue;
        db.query(`INSERT OR IGNORE INTO push_deliveries(userId,taskId,token,subscriptionId,nextAt)
          SELECT ?,?,?,id,? FROM push_subscriptions WHERE userId=?`).run(r.userId, r.taskId, r.token, now, r.userId);
      }
      db.query(`DELETE FROM push_deliveries WHERE NOT EXISTS(SELECT 1 FROM push_reminders r JOIN accounts a ON a.userId=r.userId AND a.status='active'
        JOIN push_subscriptions s ON s.id=push_deliveries.subscriptionId AND s.userId=r.userId
        WHERE r.userId=push_deliveries.userId AND r.taskId=push_deliveries.taskId AND r.token=push_deliveries.token AND r.dueAt>=?)`).run(now - 86400000);
    })();
    for (let count = 0; count < 20; count++) {
      const job = db.transaction(() => {
        const row = db.query<any, [number]>('SELECT d.*,s.subscription FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscriptionId WHERE d.nextAt<=? ORDER BY d.nextAt LIMIT 1').get(this.now());
        if (row) db.query('UPDATE push_deliveries SET nextAt=?,attempts=attempts+1 WHERE userId=? AND token=? AND subscriptionId=?').run(this.now() + 60000, row.userId, row.token, row.subscriptionId);
        return row;
      })();
      if (!job) break;
      const drop = () => db.query('DELETE FROM push_deliveries WHERE userId=? AND token=? AND subscriptionId=?').run(job.userId, job.token, job.subscriptionId);
      // Recheck after each network await: another device may have cancelled or disabled it.
      if (!db.query(`SELECT 1 FROM push_reminders r JOIN accounts a ON a.userId=r.userId AND a.status='active'
        WHERE r.userId=? AND r.taskId=? AND r.token=? AND r.dueAt<=?`).get(job.userId, job.taskId, job.token, this.now())) { drop(); continue; }
      try {
        await this.send(JSON.parse(job.subscription), JSON.stringify({ token: job.token }), {
          vapidDetails: { subject: this.subject!, ...this.keys! }, TTL: 3600, urgency: 'normal', timeout: 10000,
          topic: subscriptionId(job.token).slice(0, 32),
        });
        drop();
      } catch (error: any) {
        if ([404, 410].includes(error.statusCode)) this.remove(job.userId, job.subscriptionId);
        else if ([400, 413].includes(error.statusCode) || job.attempts >= 9) drop();
        else db.query('UPDATE push_deliveries SET nextAt=? WHERE userId=? AND token=? AND subscriptionId=?').run(this.now() + Math.min(3600000, 30000 * 2 ** job.attempts), job.userId, job.token, job.subscriptionId);
      }
    }
  }
}
