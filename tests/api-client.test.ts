import { after, afterEach, test } from 'node:test';
import { expect } from '@std/expect';
import { apiRequest, fileRequest } from '../public/api-client.ts';
import { RequestError, errorStatus } from '../public/errors.ts';
import { accountApi, authApi } from '../public/api.ts';
import { createVault } from '../public/crypto.ts';
import { encryptFile } from '../public/file-crypto.ts';
import { decodeFile } from '../public/file-format.ts';

const realFetch = globalThis.fetch;
const calls: [string, RequestInit | undefined][] = [];
const queue: (Response | Error)[] = [];
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push([String(url), init]);
  const next = queue.shift();
  if (next instanceof Error) throw next;
  return next ?? Response.json({});
}) as typeof fetch;
afterEach(() => { calls.length = 0; queue.length = 0; });
// Restore the real transport for other test files in the same process.
after(() => { globalThis.fetch = realFetch; });

test('JSON requests retain account binding, cookies, cache policy and immutable payloads', async () => {
  const payload = { changes: [{ changeId: 'immutable-operation', ciphertext: 'opaque' }] };
  const before = structuredClone(payload);
  queue.push(Response.json({ accepted: true }));
  expect(await apiRequest<{ accepted: boolean }>('/api/sync', 'POST', payload, 'account-a')).toEqual({ accepted: true });
  const [path, init] = calls[0]!;
  expect(path).toBe('/api/sync');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(payload) });
  expect(new Headers(init?.headers).get('X-Taskpath-User')).toBe('account-a');
  expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(payload).toEqual(before);
});

test('public JSON reads omit account, body and content type', async () => {
  queue.push(Response.json({ config: null }));
  await apiRequest('/api/auth/config?userId=account-b', 'GET', undefined, null);
  const [, init] = calls[0]!;
  expect(init?.body).toBeUndefined();
  expect(new Headers(init?.headers).has('X-Taskpath-User')).toBe(false);
  expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
});

test('JSON errors preserve status and server messages with safe proxy fallbacks', async () => {
  for (const [response, message] of [
    [Response.json({ error: 'Credential revision changed.' }, { status: 409 }), 'Credential revision changed.'],
    [new Response('<html>Proxy error</html>', { status: 401 }), 'Sign in to sync. Encrypted changes are saved on this device.'],
    [Response.json({ error: { unexpected: true } }, { status: 502 }), 'Could not complete the request. Your encrypted changes are safe on this device.'],
  ] as const) {
    queue.push(response);
    const error = await apiRequest('/api/auth/login', 'POST', {}, null).catch(error => error as unknown);
    expect(error).toBeInstanceOf(RequestError);
    expect(errorStatus(error)).toBe(response.status);
    expect((error as Error).message).toBe(message);
  }
});

test('file requests preserve binary uploads, JSON metadata and unread download streams', async () => {
  const bytes = new Uint8Array([0, 255, 128, 1]);
  queue.push(Response.json({}));
  await fileRequest('', 'PUT', bytes, 'account-b');
  const [path, init] = calls[0]!;
  expect(path).toBe('/api/files');
  expect(init?.body).toBe(bytes);
  expect(new Headers(init?.headers).get('Content-Type')).toBe('application/octet-stream');
  expect(new Headers(init?.headers).get('X-Taskpath-User')).toBe('account-b');
  expect(init?.credentials).toBe('same-origin');
  const metadata = JSON.stringify({ ciphertext: 'opaque-metadata' });
  queue.push(Response.json({}));
  await fileRequest('/file-id', 'PATCH', metadata, 'account-b');
  expect(calls[1]![1]?.body).toBe(metadata);
  expect(new Headers(calls[1]![1]?.headers).get('Content-Type')).toBe('application/json');
  const download = new Response(bytes);
  queue.push(download);
  expect(await fileRequest('/file-id', 'GET', undefined, 'account-b')).toBe(download);
  expect(download.bodyUsed).toBe(false);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
});

test('file failures cancel responses and preserve quota, deletion and session statuses', async () => {
  for (const [status, message] of [[401, 'Sign in to sync files.'], [507, 'Waiting for space'], [410, 'File transfer failed (410). Retry when online.']] as const) {
    let cancelled = false;
    queue.push(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }));
    const error = await fileRequest('/file-id', 'GET', undefined, 'account-b').catch(error => error as unknown);
    expect(errorStatus(error)).toBe(status);
    expect((error as Error).message).toBe(message);
    expect(cancelled).toBe(true);
  }
});

test('offline failures propagate without retrying requests', async () => {
  const error = new TypeError('Offline');
  queue.push(error, error);
  await expect(apiRequest('/api/sync', 'POST', {}, 'account-a')).rejects.toBe(error);
  await expect(fileRequest('', 'PUT', new Uint8Array(), 'account-a')).rejects.toBe(error);
  expect(calls).toHaveLength(2);
});

test('auth adapter accepts domain inputs and validates vault configuration', async () => {
  const { config, credential } = await createVault('adapter test password 2026');
  const userId = 'u_' + 'a'.repeat(32);
  for (let i = 0; i < 5; i++) queue.push(Response.json({ config }));
  expect(await authApi.configuration(userId)).toEqual(config);
  await authApi.setup({ userId, token: 'invitation', config, credential });
  await authApi.login({ userId, credential, revision: 1 });
  await authApi.changePassword(userId, { currentCredential: credential, credential, config, revision: 1 });
  await authApi.logout(userId);
  expect(calls.map(([path]) => path)).toEqual([
    '/api/auth/config?userId=' + userId, '/api/auth/setup', '/api/auth/login', '/api/auth/password', '/api/auth/logout',
  ]);
  expect(calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'POST']);
  for (const [, init] of calls) expect(new Headers(init?.headers).get('X-Taskpath-User')).toBe(userId);
  expect(JSON.parse(String(calls[2]![1]?.body))).toEqual({ userId, credential, revision: 1 });
  queue.push(Response.json({ config: { invalid: true } }));
  await expect(authApi.configuration(userId)).rejects.toThrow();
});

test('account adapter chooses sync transport and binds each instance to its account', async () => {
  const a = accountApi('account-a'), b = accountApi('account-b');
  for (let i = 0; i < 4; i++) queue.push(Response.json({protocol:2}));
  const empty = { workspaceKey: 'vault', changes: [] };
  await a.sync(empty);
  await b.sync({ ...empty, reminders: [{ taskId: 'task', changeId: 'op', token: 'opaque', dueAt: null }] });
  await a.sync(empty);
  expect(calls.map(([, init]) => new Headers(init?.headers).get('X-Taskpath-User'))).toEqual(['account-a', 'account-b', 'account-a']);
  expect(calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'GET']);
  expect(calls[0]![1]?.body).toBeUndefined();
  expect(JSON.parse(String(calls[1]![1]?.body)).reminders[0].token).toBe('opaque');
  expect(() => accountApi(null)).toThrow('Select an account first.');
});

test('reminder and push adapters expose decoded results and domain arguments', async () => {
  const api = accountApi('account-a');
  queue.push(Response.json({ tokens: ['claimed'] }));
  expect(await api.claimReminders(['claimed', 'other'])).toEqual(['claimed']);
  queue.push(Response.json({ available: true, publicKey: 'key', subscriptionIds: ['subscription'] }));
  expect((await api.push.status()).available).toBe(true);
  queue.push(Response.json({}));
  const subscription = { endpoint: 'https://push.example/subscription', keys: { auth: 'opaque' } };
  await api.push.subscribe(subscription);
  expect(JSON.parse(String(calls[2]![1]?.body))).toEqual({ subscription });
  queue.push(Response.json({}));
  await api.push.unsubscribe('subscription');
  expect(calls[3]![1]?.method).toBe('DELETE');
  expect(JSON.parse(String(calls[3]![1]?.body))).toEqual({ id: 'subscription' });
  queue.push(Response.json({ tokens: [123] }));
  await expect(api.claimReminders([])).rejects.toThrow('Invalid reminder response.');
  queue.push(Response.json({ available: true }));
  await expect(api.push.status()).rejects.toThrow('Invalid notification response.');
});

test('file adapter frames ciphertext, preserves retries and validates manifests', async () => {
  const { key, config } = await createVault('file adapter test password 2026');
  const userId = 'u_' + 'b'.repeat(32), files = accountApi(userId).files;
  const encrypted = await encryptFile(key, userId, config.vaultId, new Uint8Array([1, 2]), { name: 'PRIVATE_NAME.txt', type: 'text/plain', lastModified: 0 });
  for (let i = 0; i < 4; i++) queue.push(Response.json({protocol:2}));
  await files.upload(encrypted.envelope, encrypted.ciphertext);
  await files.upload(encrypted.envelope, encrypted.ciphertext);
  const body = calls[0]![1]?.body as Uint8Array<ArrayBuffer>;
  expect(body).toEqual(calls[1]![1]?.body as Uint8Array<ArrayBuffer>);
  expect(decodeFile(body, userId, config.vaultId)).toEqual(encrypted);
  expect(new TextDecoder().decode(body)).not.toContain('PRIVATE_NAME');
  await files.rename(encrypted.envelope);
  expect(JSON.parse(String(calls[2]![1]?.body))).toEqual(encrypted.envelope);
  await files.delete('id/with space');
  expect(calls[3]![0]).toBe('/api/files/id%2Fwith%20space');
  expect(calls[3]![1]?.method).toBe('DELETE');
  const manifest = { vaultId: config.vaultId, quotaBytes: 10_000_000, usedBytes: 2, maxFileBytes: 10_000_000, files: [{ envelope: encrypted.envelope, bytes: 2 }], deleted: [] };
  queue.push(Response.json(manifest));
  expect(await files.manifest(config.vaultId)).toEqual(manifest);
  queue.push(Response.json(manifest));
  await expect(accountApi('u_' + 'c'.repeat(32)).files.manifest(config.vaultId)).rejects.toThrow();
});

test('file adapter returns bounded ciphertext and rejects oversized or incomplete downloads', async () => {
  const files = accountApi('account-a').files, bytes = new Uint8Array(18);
  queue.push(new Response(bytes));
  expect(await files.download('file', 2)).toEqual(bytes);
  queue.push(new Response(bytes));
  await expect(files.download('file', 3)).rejects.toThrow('Incomplete file download.');
  let cancelled = false;
  queue.push(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } })));
  await expect(files.download('file', 1)).rejects.toThrow('Invalid encrypted file length.');
  expect(cancelled).toBe(true);
  await expect(files.download('file', 10_000_001)).rejects.toThrow('Invalid encrypted file length.');
  expect(calls).toHaveLength(3);
});

test('sync adapter selects upload or cursor download and rejects an old server before acknowledgement', async () => {
  const api = accountApi('account-a');
  queue.push(Response.json({protocol:2,rows:[]}));
  await api.sync({workspaceKey:'vault',changes:[],cursor:'opaque/cursor'});
  expect(calls[0]![0]).toBe('/api/sync?cursor=opaque%2Fcursor');
  expect(new Headers(calls[0]![1]?.headers).get('x-taskpath-sync')).toBe('2');
  queue.push(Response.json({protocol:2,rows:[]}));
  await api.sync({workspaceKey:'vault',changes:[],reminders:[{taskId:'task',changeId:'change',token:null,dueAt:null}]});
  expect(calls[1]![1]?.method).toBe('POST');
  queue.push(Response.json({format:1,rows:[],acknowledged:['change']}));
  await expect(api.sync({workspaceKey:'vault',changes:[]})).rejects.toMatchObject({status:426});
});
