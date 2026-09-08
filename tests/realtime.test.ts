import { test, expect } from 'bun:test';
import { Store } from '../src/store';
import { createHandler } from '../src/server';
import { Realtime } from '../src/realtime';
import { createRealtime } from '../public/realtime.js';
import { login, testAuth } from './auth-helpers';

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for realtime event');
    await Bun.sleep(5);
  }
}

test('WebSocket upgrades require a valid session and exact Origin, including local mode', async () => {
  const store = new Store(':memory:');
  const hub = new Realtime();
  try {
    const handle = createHandler(store, testAuth, 'https://tasks.example.com', hub);
    const { cookie } = await login(handle);
    let upgraded = 0;
    const server = { upgrade: () => { upgraded++; return true; } } as any;
    const request = (headers: Record<string, string>) => new Request('http://127.0.0.1:3000/api/events', { headers: { Upgrade: 'websocket', ...headers } });
    expect((await handle(request({ Origin: 'https://tasks.example.com' }), server))!.status).toBe(401);
    for (const origin of ['', 'https://attacker.example', 'null']) {
      expect((await handle(request({ Cookie: cookie, Origin: origin }), server))!.status).toBe(403);
    }
    expect((await handle(request({ Cookie: cookie, Origin: 'https://tasks.example.com', 'Sec-Fetch-Site': 'cross-site' }), server))!.status).toBe(403);
    expect(upgraded).toBe(0);
    expect(await handle(request({ Cookie: cookie, Origin: 'https://tasks.example.com' }), server)).toBeUndefined();
    expect(upgraded).toBe(1);
    const local = createHandler(store, undefined, undefined, hub);
    expect((await local(request({ Origin: 'https://attacker.example' }), server))!.status).toBe(403);
    expect(await local(request({ Origin: 'http://127.0.0.1:3000' }), server)).toBeUndefined();
    const shell = await handle(new Request('http://127.0.0.1:3000/offline-shell'));
    expect(shell!.headers.get('Content-Security-Policy')).toContain("connect-src 'self' wss://tasks.example.com;");
  } finally { hub.close(); store.close(); }
});

test('real sockets notify both devices after commits; reads/retries do not loop; logout and expiry close sockets', async () => {
  const store = new Store(':memory:');
  const hub = new Realtime(25);
  const handle = createHandler(store, testAuth, undefined, hub);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle, websocket: hub.websocket });
  const origin = server.url.origin;
  const sockets: WebSocket[] = [];
  try {
    const signIn = async () => {
      const response = await fetch(new URL('/api/auth/login', origin), {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: testAuth.username, password: 'secret' }),
      });
      expect(response.status).toBe(200);
      return response.headers.get('set-cookie')!.split(';', 1)[0];
    };
    const cookieA = await signIn();
    const cookieB = await signIn();
    const connect = (cookie: string) => {
      const messages: string[] = [];
      const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/events`, { headers: { Origin: origin, Cookie: cookie } });
      socket.onmessage = event => messages.push(JSON.parse(String(event.data)).type);
      sockets.push(socket);
      return { socket, messages };
    };
    const a = connect(cookieA), b = connect(cookieB);
    await until(() => a.messages.includes('ready') && b.messages.includes('ready'));
    const api = async (path: string, method = 'GET', body?: unknown, cookie = cookieA) => {
      const response = await fetch(new URL(path, origin), { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBeLessThan(300);
      return response.json() as Promise<any>;
    };
    const { task } = await api('/api/tasks', 'POST', { title: 'From laptop', tags: ['laptop'] });
    await until(() => a.messages.includes('changed') && b.messages.includes('changed'));
    expect((await api('/api/sync', 'GET', undefined, cookieB)).tasks[0].title).toBe('From laptop');
    const board = await api('/api/sync');
    const editedAt = new Date(Date.now() + 1000).toISOString();
    const change = { changeId: 'phone-edit', editedAt, task: { ...task, title: 'From phone', tags: ['phone', 'shared'], updatedAt: editedAt } };
    const payload = { workspaceKey: board.workspaceKey, changes: [change] };
    await api('/api/sync', 'POST', payload, cookieB);
    await until(() => a.messages.filter(x => x === 'changed').length === 2);
    expect((await api('/api/sync')).tasks[0]).toMatchObject({ title: 'From phone', tags: ['phone', 'shared'] });
    await api('/api/sync', 'POST', payload, cookieB);
    await api('/api/sync', 'POST', { workspaceKey: board.workspaceKey, changes: [] });
    await Bun.sleep(40);
    expect(a.messages.filter(x => x === 'changed')).toHaveLength(2);
    expect(b.messages.filter(x => x === 'changed')).toHaveLength(2);
    expect(a.messages.includes('heartbeat')).toBe(true);
    await api('/api/auth/logout', 'POST', {});
    await until(() => a.socket.readyState === WebSocket.CLOSED);
    expect(b.socket.readyState).toBe(WebSocket.OPEN);
    store.db.query('UPDATE auth_sessions SET expiresAt = 0').run();
    await until(() => b.socket.readyState === WebSocket.CLOSED);
    const unauthorized = await fetch(new URL('/api/sync', origin), { headers: { Cookie: cookieB } });
    expect(unauthorized.status).toBe(401);
  } finally {
    for (const socket of sockets) socket.close();
    hub.close();
    await server.stop(true);
    store.close();
  }
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
