import webpush from 'web-push';
import { createHash, ECDH } from 'node:crypto';
import { InputError, object, Store } from './store';
import { PushRepository } from './db/push';

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
  private repository: PushRepository;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(private store: Store, private subject?: string, private send = webpush.sendNotification.bind(webpush), private now = () => Date.now()) {
    this.repository = new PushRepository(store.orm);
    if (!subject) return;
    const url = new URL(subject);
    if (!['https:', 'mailto:'].includes(url.protocol)) throw new Error('Push contact must be an HTTPS URL or mailto address.');
    this.keys = JSON.parse(store.workspace.setting('push-vapid', () => JSON.stringify(webpush.generateVAPIDKeys())));
  }
  status(userId: string) {
    return { available: Boolean(this.keys), publicKey: this.keys?.publicKey || null, subscriptionIds: this.repository.subscriptionIds(userId) };
  }
  subscribe(userId: string, input: unknown) {
    if (!this.keys) throw new InputError('Background notifications need TASKPATH_ORIGIN set to your public HTTPS address.', 503);
    const value = subscription(input), id = subscriptionId(value.endpoint);
    this.repository.transaction(() => {
      const previousOwner = this.repository.subscriptionOwner(id);
      if (previousOwner !== userId && this.repository.subscriptionCount(userId) >= 10) throw new InputError('Up to 10 notification devices per account.', 409);
      if (previousOwner !== userId) this.repository.cancelSubscriptionDeliveries(id);
      this.repository.saveSubscription(id, userId, JSON.stringify(value));
      if (previousOwner && previousOwner !== userId) this.cleanup(previousOwner);
    });
    return { id };
  }
  remove(userId: string, id: unknown) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new InputError('Invalid subscription ID.');
    this.repository.transaction(() => {
      this.repository.removeSubscription(userId, id);
      this.repository.cancelSubscriptionDeliveries(id, userId);
      this.cleanup(userId);
    });
    return { ok: true };
  }
  private cleanup(userId: string) {
    if (!this.store.pushEnabled(userId)) this.repository.clearReminders(userId);
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
    const now = this.now();
    this.repository.transaction(() => {
      // A token is claimed once; fan-out is durable and independent for each device.
      for (const reminder of this.repository.dueReminders(now)) {
        if (!this.store.claim(reminder.userId, [reminder.token]).tokens.length) continue;
        this.repository.enqueueDeliveries(reminder, now);
      }
      this.repository.cancelStaleDeliveries(now);
    });
    for (let count = 0; count < 20; count++) {
      const job = this.repository.leaseNextDelivery(this.now());
      if (!job) break;
      // Recheck after each network await: another device may have cancelled or disabled it.
      if (!this.repository.deliveryIsCurrent(job, this.now())) {
        this.repository.dropDelivery(job);
        continue;
      }

      try {
        await this.send(JSON.parse(job.subscription), JSON.stringify({ token: job.token }), {
          vapidDetails: { subject: this.subject!, ...this.keys! }, TTL: 3600, urgency: 'normal', timeout: 10000,
          topic: subscriptionId(job.token).slice(0, 32),
        });
        this.repository.dropDelivery(job);
      } catch (error: any) {
        if ([404, 410].includes(error.statusCode)) this.remove(job.userId, job.subscriptionId);
        else if ([400, 413].includes(error.statusCode) || job.attempts >= 9) this.repository.dropDelivery(job);
        else this.repository.retryDelivery(job, this.now() + Math.min(3600000, 30000 * 2 ** job.attempts));
      }
    }
  }
}
