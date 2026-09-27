import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { AuthManager, sessionCookieName } from '../src/auth';
import { Store } from '../src/store';
import { createHandler } from '../src/server';
import { Realtime } from '../src/realtime';
import { sourceRelease } from '../src/client-release';
import { createVault } from '../public/crypto';

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Disposable local QA only. Never imported by the production server. */
export async function startQaSession(now = () => Date.now()) {
  if (process.env.NODE_ENV === 'production') throw new Error('QA launcher cannot run in production mode.');
  // Deliberately ignore DATABASE_PATH, HOST, PORT and TASKPATH_ORIGIN.
  const store = new Store(':memory:');
  const auth = new AuthManager(store.db);
  const realtime = new Realtime();
  let password: string | null = randomBytes(32).toString('base64url');
  const vault = await createVault(password);
  const invitation = auth.createInvitation();
  await auth.setup(invitation.userId, invitation.token, vault.config, vault.credential);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = digest(token);
  const expiresAt = now() + 5 * 60_000;
  // Cookies are not port-scoped: isolate this launch from other localhost apps.
  const cookieName = 'taskpath_qa_' + randomBytes(16).toString('hex');
  let origin = '';
  let app: ReturnType<typeof createHandler>;
  const deny = () => new Response('QA access denied. Restart bun run qa for a fresh link.', { status: 403, headers });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, maxRequestBodySize: 11_000_000,
    websocket: realtime.websocket,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.origin !== origin || request.headers.get('host') !== new URL(origin).host ||
          request.headers.get('sec-fetch-site') === 'cross-site' ||
          (request.headers.has('origin') && request.headers.get('origin') !== origin)) return deny();
      if (url.pathname === '/__qa/claim') {
        if (request.method !== 'POST' || request.headers.get('origin') !== origin ||
            !password || now() >= expiresAt) return deny();
        const supplied = request.headers.get('authorization') || '';
        if (supplied.length !== 50 || !supplied.startsWith('Bearer ') ||
            !timingSafeEqual(digest(supplied.slice(7)), tokenHash)) return deny();
        const secret = password;
        password = null; // Consume before any asynchronous work: no replay or racing claims.
        return Response.json({ userId: invitation.userId, password: secret, config: vault.config }, { headers });
      }
      if (url.pathname === '/__qa/start' && request.method === 'GET') {
        return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Taskpath disposable QA</title><p id="status" role="status">Opening your disposable QA workspace…</p><script type="module" src="/__qa/start.js"></script></html>', { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname === '/__qa/start.js' && request.method === 'GET') {
        const assets = '/assets/' + sourceRelease().version;
        return new Response(`
let token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', '/__qa/start');
try {
  if (!token) throw new Error('Missing link. Restart bun run qa for a fresh session.');
  const response = await fetch('/__qa/claim', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
  token = null;
  if (!response.ok) throw new Error('Link expired or already used. Restart bun run qa.');
  const data = await response.json();
  const [{ unlockVault }, { authApi }, offline] = await Promise.all([
    import('${assets}/crypto.js'), import('${assets}/api.js'), import('${assets}/offline.js')
  ]);
  await offline.switchAccount(data.userId);
  const unlocked = await unlockVault(data.password, data.config);
  data.password = null;
  await authApi.login({ userId: data.userId, credential: unlocked.credential, revision: data.config.revision });
  await offline.activate(data.config, unlocked.key, true, (await offline.localState()).lockEpoch);
  await offline.syncAfterCurrent();
  location.replace('/');
} catch {
  document.getElementById('status').textContent = 'Could not open QA. Restart bun run qa for a fresh link; browser storage must be enabled.';
}
`, { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } });
      }
      if (url.pathname.startsWith('/__qa/')) return new Response('Not found', { status: 404, headers });
      // Translate only this launch's cookie into the normal authentication flow.
      const incoming = new Headers(request.headers);
      const value = (incoming.get('cookie') || '').split(';').map(v => v.trim())
        .find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      incoming.delete('cookie');
      if (value) incoming.set('cookie', sessionCookieName + '=' + value);
      const response = await app(new Request(request, { headers: incoming }), server);
      if (response) {
        const cookie = response.headers.get('set-cookie');
        if (cookie) response.headers.set('set-cookie', cookie.replace(sessionCookieName + '=', cookieName + '='));
      }
      return response;
    },
  });
  origin = server.url.origin;
  app = createHandler(store, auth, origin, realtime, resolve(import.meta.dir, '../public'));
  let stopped = false;
  return {
    url: `${origin}/__qa/start#token=${token}`,
    origin,
    async stop() {
      if (stopped) return;
      stopped = true;
      password = null;
      realtime.close();
      await server.stop(true);
      store.close();
    },
  };
}

if (import.meta.main) {
  if (process.argv.slice(2).some(arg => arg !== '--no-open')) throw new Error('Usage: bun run qa [--no-open]');
  const session = await startQaSession();
  console.log('Disposable QA account. Local only; server data disappears on Ctrl+C.');
  console.log('Private one-use link (expires in 5 minutes):\n' + session.url);
  console.log('The QA browser remembers its vault key for reloads. Use Lock to clear it.');
  const stop = async () => { await session.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (!process.argv.includes('--no-open')) {
    const command = process.platform === 'darwin' ? ['open', session.url]
      : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', session.url]
      : ['xdg-open', session.url];
    try {
      const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' });
      if (await child.exited) console.log('Open the printed link in your browser.');
    } catch { console.log('Open the printed link in your browser.'); }
  }
}
