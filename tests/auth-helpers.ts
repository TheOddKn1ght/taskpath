import { AuthManager } from '../src/auth';
import { Store } from '../src/store';
import { createHandler } from '../src/server';
import { createVault } from '../public/crypto.js';
export const testUserId = 'u_' + '1'.repeat(32);
export const testPassword = 'correct horse battery staple';
export const origin = 'https://tasks.example.com';
export const testVault = await createVault(testPassword);
export async function fixture(path = ':memory:', now = () => new Date()) {
  const store = new Store(path, now, 'UTC'), auth = new AuthManager(store.db);
  const config = { ...testVault.config, vaultId: testVault.config.vaultId };
  store.db.query("INSERT INTO accounts(userId,status,createdAt) VALUES (?,'pending',?)").run(testUserId, Date.now());
  await auth.setup(testUserId, auth.renewInvitation(testUserId).token, config, testVault.credential);
  const handle = createHandler(store, auth, origin);
  return { store, auth, handle, vault: testVault };
}
export async function login(handle: any, credential = testVault.credential, revision = 1, site = origin) {
  const response = await handle(new Request(`${origin}/api/auth/login`, { method: 'POST', headers: { origin: site, 'content-type': 'application/json' }, body: JSON.stringify({ userId: testUserId, credential, revision }) }));
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
export function request(handle: any, cookie: string, path: string, body?: any, site = origin) {
  return handle(new Request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: site, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
}
