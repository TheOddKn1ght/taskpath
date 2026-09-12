import { test, expect } from 'bun:test';
import { createECDH, randomBytes } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/store';
import { PushService, subscription } from '../src/push';
import { createHandler } from '../src/server';
import { testVault, testUserId, fixture, login, request, origin } from './auth-helpers';
import { encryptChange } from '../public/crypto.js';
import { reminderMetadata, acceptEncrypted } from '../public/offline.js';
import { ClientStore } from './client-helpers';
const time = Date.parse('2026-09-10T12:00:00Z');
const sub = (suffix = 'one') => {
  const ec = createECDH('prime256v1'); ec.generateKeys();
  return { endpoint: 'https://web.push.apple.com/' + suffix, keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};
function setup(send: any = async () => {}, now = () => time) {
  const store = new Store(':memory:', () => new Date(now()), 'UTC');
  store.db.query("INSERT INTO accounts(userId,status,createdAt,config) VALUES (?,'active',?,?)").run(testUserId, time, JSON.stringify(testVault.config));
  const push = new PushService(store, origin, send, now);
  const device = new ClientStore(':memory:', () => new Date(now()));
  const sync = async () => {
    const changes = await Promise.all(device.record.pending.map((c: any) => encryptChange(testVault.key, testVault.config.vaultId, c)));
    const reminders = device.record.pending.map((c: any) => reminderMetadata(c.task, c.changeId));
    return store.sync(testUserId, { workspaceKey: testVault.config.vaultId, changes, reminders });
  };
  return { store, push, device, sync };
}

test('push subscriptions reject SSRF destinations, malformed keys, and plaintext extras', () => {
  const valid = sub(); expect(subscription(valid)).toEqual(valid);
  for (const endpoint of ['http://web.push.apple.com/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.evil.test/a', 'https://web.push.apple.com:444/a', 'https://user:pass@web.push.apple.com/a', 'https://web.push.apple.com/a#x']) expect(() => subscription({ ...valid, endpoint })).toThrow();
  expect(() => subscription({ ...valid, title: 'private' })).toThrow();
  expect(() => subscription({ ...valid, keys: { ...valid.keys, auth: 'short' } })).toThrow();
});

test('opt-in metadata is atomic, revision checked, and cannot override a newer encrypted edit', async () => {
  const { store, push, device, sync } = setup();
  try {
    const task = device.create({ title: 'PUSH_PRIVATE_TITLE', notes: 'PUSH_PRIVATE_NOTES', reminderAt: new Date(time + 1000).toISOString() });
    await sync(); expect(store.db.query('SELECT * FROM push_reminders').all()).toEqual([]);
    push.subscribe(testUserId, sub()); await sync();
    const original = store.db.query<any, []>('SELECT * FROM push_reminders').get();
    device.update(task.id, { reminderAt: new Date(time + 2000).toISOString() }); await sync();
    const latest = store.db.query<any, []>('SELECT * FROM push_reminders').get();
    expect(latest.token).not.toBe(original.token);
    store.sync(testUserId, { workspaceKey: testVault.config.vaultId, changes: [], reminders: [{ ...original, dueAt: new Date(original.dueAt).toISOString(), userId: undefined }].map(({ userId, ...r }) => r) });
    expect(store.db.query('SELECT * FROM push_reminders').get()).toEqual(latest);
    const last = device.record.pending.at(-1)!;
    const envelope = await encryptChange(testVault.key, testVault.config.vaultId, last);
    expect(() => store.sync(testUserId, { workspaceKey: testVault.config.vaultId, changes: [envelope], reminders: [{ ...reminderMetadata(last.task, last.changeId), title: 'forbidden' }] })).toThrow();
    expect(JSON.stringify(store.syncBoard(testUserId))).not.toContain(task.title);
    expect(JSON.stringify(store.db.query('SELECT * FROM push_reminders').all())).not.toContain(task.notes);
    device.update(task.id, { status: 'done' as const }); await sync();
    expect(store.db.query('SELECT * FROM push_reminders').all()).toEqual([]);
  } finally { store.close(); }
});

test('new ciphertext without scheduling metadata cancels stale reminders; archive/delete/dismiss stay private', async () => {
  const sent: any[] = [], { store, push, device, sync } = setup(async (...args: any[]) => { sent.push(args); });
  try {
    push.subscribe(testUserId, sub()); const task = device.create({ title: 'Secret', reminderAt: new Date(time).toISOString() }); await sync();
    device.update(task.id, { title: 'A newer offline edit' });
    const last = device.record.pending.at(-1)!;
    store.sync(testUserId, { workspaceKey: testVault.config.vaultId, changes: [await encryptChange(testVault.key, testVault.config.vaultId, last)] });
    await push.tick(); expect(sent).toHaveLength(0);
    for (const extra of [{ archivedAt: new Date(time).toISOString() }, { deletedAt: new Date(time).toISOString() }, { status: 'done' as const }, { reminderDismissedAt: new Date(time).toISOString() }]) expect(reminderMetadata({ ...task, ...extra }, 'change')).toMatchObject({ token: null, dueAt: null });
  } finally { store.close(); }
});

test('durable fan-out retries independently after restart, keeps VAPID keys, and deduplicates tokens', async () => {
  let clock = time, fail = true; const sent: any[] = [];
  const sender = async (subscription: any, payload: string) => {
    sent.push({ endpoint: subscription.endpoint, payload });
    if (subscription.endpoint.endsWith('/two') && fail) throw { statusCode: 503 };
  };
  const { store, push, device, sync } = setup(sender, () => clock);
  try {
    push.subscribe(testUserId, sub('one')); push.subscribe(testUserId, sub('two'));
    const task = device.create({ title: 'TITLE_NOT_IN_PUSH', reminderAt: new Date(time).toISOString() }); await sync();
    await Promise.all([push.tick(), push.tick()]); expect(sent).toHaveLength(2);
    for (const message of sent) expect(JSON.parse(message.payload)).toEqual({ token: task.reminderToken });
    expect(store.db.query('SELECT * FROM push_deliveries').all()).toHaveLength(1);
    fail = false; clock += 61000;
    const restarted = new PushService(store, origin, sender as any, () => clock);
    expect(restarted.status(testUserId).publicKey).toBe(push.status(testUserId).publicKey);
    await restarted.tick(); expect(sent).toHaveLength(3);
    expect(store.db.query('SELECT * FROM push_deliveries').all()).toHaveLength(0);
    await restarted.tick(); expect(sent).toHaveLength(3);
    expect(store.claim(testUserId, [task.reminderToken]).tokens).toEqual([]);
  } finally { store.close(); }
});

test('expired endpoints and disabled accounts stop delivery; subscription removal is account scoped', async () => {
  const sent: any[] = [], { store, push, device, sync } = setup(async (...args: any[]) => { sent.push(args); throw { statusCode: 410 }; });
  try {
    const { id } = push.subscribe(testUserId, sub());
    push.remove('another-user', id); expect(store.pushEnabled(testUserId)).toBe(true);
    device.create({ title: 'Private', reminderAt: new Date(time).toISOString() }); await sync();
    store.db.query("UPDATE accounts SET status='disabled'").run(); await push.tick(); expect(sent).toHaveLength(0);
    store.db.query("UPDATE accounts SET status='active'").run(); await push.tick();
    expect(store.pushEnabled(testUserId)).toBe(false); expect(store.db.query('SELECT * FROM push_reminders').all()).toHaveLength(0);
  } finally { store.close(); }
});

test('sidecar acknowledgements retain concurrent offline edits and leave ciphertext unchanged', () => {
  const newer = { taskId: 'task', changeId: 'new', token: 'b'.repeat(32), dueAt: new Date(time).toISOString() };
  const record: any = { config: testVault.config, pending: [], reminderOutbox: { task: newer }, board: { rows: [] } };
  const response = { format: 1, workspaceKey: testVault.config.vaultId, timezone: 'UTC', serverTime: new Date(time).toISOString(), rows: [], pushEnabled: true, reminderAcknowledged: [{ taskId: 'task', changeId: 'old' }] };
  acceptEncrypted(record, response); expect(record.reminderOutbox.task).toEqual(newer);
  acceptEncrypted(record, { ...response, reminderAcknowledged: [{ taskId: 'task', changeId: 'new' }] }); expect(record.reminderOutbox).toEqual({});
  acceptEncrypted(record, { ...response, pushEnabled: false }); expect(record.reminderPublished).toEqual({});
});

test('push endpoints require a session, enforce Origin and account binding, and do not expose private signing keys', async () => {
  const { store, auth } = await fixture();
  try {
    const push = new PushService(store, origin), handle = createHandler(store, auth, origin, undefined, undefined, push);
    expect((await request(handle, '', '/api/push')).status).toBe(401);
    const { cookie } = await login(handle);
    expect((await request(handle, cookie, '/api/push', { subscription: sub() }, 'https://evil.test')).status).toBe(403);
    expect((await request(handle, cookie, '/api/push', { subscription: sub() })).status).toBe(200);
    const status = await (await request(handle, cookie, '/api/push')).json();
    expect(status.subscriptionIds).toHaveLength(1); expect(status.privateKey).toBeUndefined();
    const mismatch = await handle(new Request(origin + '/api/push', { headers: { cookie, 'x-taskpath-user': 'another-account' } }));
    expect(mismatch!.status).toBe(401);
  } finally { store.close(); }
});

test('service worker displays only generic text while locked and ignores injected titles and click URLs', async () => {
  const listeners = new Map(), shown: any[] = [], opened: string[] = [];
  const code = new Bun.Transpiler({loader: 'ts'}).transformSync((await Bun.file('public/sw.ts').text()).replace(/^import .*\n/gm, ''));
  runInNewContext(code, { URL, self: { location: { origin }, addEventListener: (name: string, handler: any) => listeners.set(name, handler),
    registration: { showNotification: async (title: string, options: any) => { shown.push({ title, ...options }); } },
    clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } },
  } });
  let pending: Promise<any>;
  listeners.get('push')({ data: { json: () => ({ token: 'x'.repeat(32), title: 'SECRET_TASK', body: 'SECRET_NOTE', url: 'https://evil.test' }) }, waitUntil: (p: Promise<any>) => { pending = p; } }); await pending!;
  expect(shown[0].body).toBe('You have a reminder in Taskpath.'); expect(JSON.stringify(shown)).not.toContain('SECRET');
  listeners.get('notificationclick')({ notification: { close() {} }, waitUntil: (p: Promise<any>) => { pending = p; } }); await pending!;
  expect(opened).toEqual(['/']);
});
