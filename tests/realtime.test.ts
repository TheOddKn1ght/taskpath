import { test, expect } from 'bun:test';
import { Realtime } from '../src/realtime';
import { createHandler } from '../src/server';
import { createRealtime } from '../public/realtime.js';
import { fixture, testVault } from './auth-helpers';
import { ClientStore } from './client-helpers';
import { encryptChange, decryptEnvelope } from '../public/crypto.js';
const until = async (condition: () => boolean, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (!condition()) { if (Date.now() > end) throw new Error('Timed out'); await Bun.sleep(10); }
};
test('real WebSockets propagate encrypted edits between devices, enforce Origin, and close revoked sessions', async () => {
  const { store, auth } = await fixture(); const hub = new Realtime(50);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, websocket: hub.websocket, fetch: createHandler(store, auth, undefined, hub) });
  const origin = server.url.origin, sockets: WebSocket[] = [];
  const post = (path: string, body: any, cookie = '') => fetch(origin + path, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    expect((await fetch(origin + '/api/events', { headers: { origin } })).status).toBe(401);
    const session = async () => (await post('/api/auth/login', { credential: testVault.credential, revision: 1 })).headers.get('set-cookie')!.split(';')[0];
    const a = await session(), b = await session();
    expect((await fetch(origin + '/api/events', { headers: { cookie: a, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(origin + '/api/events', { headers: { cookie: a, origin } })).status).toBe(426);
    const messages: string[][] = [[], []]; const closed: number[] = [];
    for (const [i, cookie] of [a, b].entries()) {
      const socket = new WebSocket(origin.replace('http', 'ws') + '/api/events', { headers: { cookie, origin } });
      socket.onmessage = event => messages[i].push(String(event.data));
      socket.onclose = event => { closed[i] = event.code; }; sockets.push(socket);
    }
    await until(() => messages.every(list => list.some(m => JSON.parse(m).type === 'ready')));
    const device = new ClientStore(), task = device.create({ title: 'PRIVATE_WEBSOCKET_CONTENT', tags: ['laptop'] });
    const encrypted = await encryptChange(testVault.key, testVault.config.vaultId, device.record.pending[0]);
    const send = (row: any, cookie: string) => post('/api/sync', { workspaceKey: testVault.config.vaultId, changes: [row] }, cookie);
    expect((await send(encrypted, a)).status).toBe(200);
    await until(() => messages.every(list => list.some(m => JSON.parse(m).type === 'changed')));
    const response = await (await fetch(origin + '/api/sync', { headers: { cookie: b } })).json();
    expect(JSON.stringify(response)).not.toContain(task.title);
    expect(await decryptEnvelope(testVault.key, testVault.config.vaultId, response.rows[0])).toMatchObject({ title: task.title, tags: ['laptop'] });
    device.update(task.id, { tags: ['phone', 'shared'] });
    const second = await encryptChange(testVault.key, testVault.config.vaultId, device.record.pending[1]);
    await send(second, b);
    await until(() => messages.every(list => list.filter(m => JSON.parse(m).type === 'changed').length === 2));
    await send(second, b); await Bun.sleep(100);
    expect(messages.every(list => list.filter(m => JSON.parse(m).type === 'changed').length === 2)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(task.title);
    await post('/api/auth/logout', {}, a); await until(() => closed[0] === 4401);
    expect(closed[1]).toBeUndefined();
    store.db.exec('UPDATE auth_sessions SET expiresAt=0'); await until(() => closed[1] === 4401);
  } finally { sockets.forEach(s => s.close()); hub.close(); await server.stop(true); store.close(); }
});
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onmessage?: (event: any) => void;
  onclose?: (event: any) => void;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  receive(type: string) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type }) }); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}

test('client coalesces bursts but fetches again when a notice arrives during sync', async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = createRealtime({ url: 'https://tasks.example.com', Socket: FakeSocket, active: () => true,
    localState: async () => ({ board: {}, locked: false }),
    sync: async () => { calls++; if (calls === 1) await gate; },
  });
  try {
    await client.reconcile();
    const socket = FakeSocket.instances.at(-1)!;
    expect(socket.url).toBe('wss://tasks.example.com/api/events');
    socket.receive('ready');
    await until(() => calls === 1);
    socket.receive('changed'); socket.receive('changed'); socket.receive('heartbeat');
    release();
    await until(() => calls === 2);
    expect(client.connected).toBe(true);
  } finally { release(); client.pause(); }
});

test('client reconnects and catches up on wake, stops for locked/expired sessions', async () => {
  let calls = 0;
  const record = { board: {}, locked: false, authRequired: false };
  const client = createRealtime({ url: 'http://localhost:3000', Socket: FakeSocket, active: () => true,
    localState: async () => record, sync: async () => { calls++; },
  });
  try {
    await client.reconcile();
    const old = FakeSocket.instances.at(-1)!;
    old.receive('ready');
    expect(client.connected).toBe(true);
    old.close(1006);
    expect(client.connected).toBe(false);
    // Let automatic backoff reconnect without a focus/online event.
    await until(() => FakeSocket.instances.at(-1) !== old);
    const replacement = FakeSocket.instances.at(-1)!;
    replacement.receive('ready');
    await until(() => calls >= 2);
    client.pause();
    expect(replacement.readyState).toBe(3);
    client.resume();
    await until(() => FakeSocket.instances.at(-1) !== replacement);
    const resumed = FakeSocket.instances.at(-1)!;
    resumed.receive('ready');
    record.authRequired = true;
    await client.reconcile();
    expect(resumed.readyState).toBe(3);
    const count = FakeSocket.instances.length;
    record.authRequired = false; record.locked = true;
    await client.reconcile();
    expect(FakeSocket.instances).toHaveLength(count);
  } finally { client.pause(); }
});
