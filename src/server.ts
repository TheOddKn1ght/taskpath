import type { Server } from 'bun';
import { Realtime, type RealtimeData } from './realtime';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { AuthManager } from './auth';
import { InputError, Store, object } from './store';
export const ASSET_VERSION = 'accounts-v4';
const assets = new Map<string, [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/login", ["index.html", "text/html; charset=utf-8"]],
  ["/vault-ui.js", ["vault-ui.js", "text/javascript; charset=utf-8"]],
  ["/crypto.js", ["crypto.js", "text/javascript; charset=utf-8"]],
  ["/persistence.js", ["persistence.js", "text/javascript; charset=utf-8"]],
  ["/markdown.js", ["markdown.js", "text/javascript; charset=utf-8"]],
  ["/vendor/marked.js", ["vendor/marked.js", "text/javascript; charset=utf-8"]],
  ["/tags.js", ["tags.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/dates.js", ["dates.js", "text/javascript; charset=utf-8"]],
  ["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/offline-shell", ["index.html", "text/html; charset=utf-8"]],
  ["/login-shell", ["index.html", "text/html; charset=utf-8"]],
  ["/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
  ["/offline.js", ["offline.js", "text/javascript; charset=utf-8"]],
  ["/offline-model.js", ["offline-model.js", "text/javascript; charset=utf-8"]],
  ["/export-markdown.js", ["export-markdown.js", "text/javascript; charset=utf-8"]],
  ["/realtime.js", ["realtime.js", "text/javascript; charset=utf-8"]],
  ["/pwa.js", ["pwa.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/icon-192.png", ["icon-192.png", "image/png"]],
  ["/icon-512.png", ["icon-512.png", "image/png"]],
  ["/apple-touch-icon.png", ["apple-touch-icon.png", "image/png"]],
]);
for (const theme of ['light', 'dark', 'gruvbox-light', 'gruvbox-dark', 'nord', 'catppuccin', 'rose-pine']) {
  for (const [file, type] of [['favicon.svg', 'image/svg+xml'], ['manifest.webmanifest', 'application/manifest+json'],
    ['icon-192.png', 'image/png'], ['icon-512.png', 'image/png'], ['apple-touch-icon.png', 'image/png']]) {
    const path = `themes/${theme}/${file}`;
    assets.set('/' + path, [path, type]);
  }
}

export function createHandler(store: Store, auth = new AuthManager(store.db), publicOrigin?: string, realtime?: Realtime, assetDirectory = resolve(import.meta.dir, process.env.NODE_ENV === 'production' ? '../dist/public' : '../public')) {
  const trustedOrigin = publicOrigin ? new URL(publicOrigin) : null;
  if (trustedOrigin && (!['http:', 'https:'].includes(trustedOrigin.protocol) || trustedOrigin.pathname !== '/' || trustedOrigin.search || trustedOrigin.hash || trustedOrigin.username || trustedOrigin.password)) throw new Error('TASKPATH_ORIGIN must be an HTTP(S) origin.');
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const json = (value: unknown, status = 200, extra = {}) => Response.json(value, { status, headers: { ...headers, ...extra } });
  return async (request: Request, server?: Pick<Server<RealtimeData>, 'upgrade'>) => {
    try {
      const url = new URL(request.url), path = url.pathname;
      const origin = trustedOrigin?.origin || url.origin;
      const secure = origin.startsWith('https:');
      const read = ['GET', 'HEAD'].includes(request.method);
      if (!read && (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site')) throw new InputError('Cross-origin requests are not allowed.', 403);
      if (!read && request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new InputError('Use application/json.', 415);
      const body = async () => {
        const limit = path === '/api/sync' ? 2 * 1024 * 1024 : 32768;
        if (Number(request.headers.get('content-length')) > limit) throw new InputError('Request is too large.', 413);
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = request.body?.getReader();
        if (reader) while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); throw new InputError('Request is too large.', 413); }
          chunks.push(value);
        }
        try { return object(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { if (error instanceof InputError) throw error; throw new InputError('Invalid JSON.'); }
      };
      const client = trustedOrigin ? (request.headers.get('x-real-ip') || 'direct-client').slice(0, 100) : 'direct-client';
      if (path === '/healthz' && read) return json({ ok: true });
      if (path === '/api/auth/config' && read) return json({ config: auth.configuration(url.searchParams.get('userId') || '') });
      if (path === '/api/auth/status' && read) return json({ enabled: true, authenticated: auth.isAuthenticated(request), userId: auth.identity(request) });
      if (path === '/api/auth/setup' && request.method === 'POST') {
        const data = await body();
        if (Object.keys(data).some(k => !['userId', 'token', 'config', 'credential'].includes(k))) throw new InputError('Unsupported setup payload.');
        await auth.setup(data.userId, data.token, data.config, data.credential);
        const session = await auth.login(client, data.userId, data.credential, 1);
        return json({ ok: true }, 201, { 'Set-Cookie': auth.cookie(session.token, session.maxAge, secure) });
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        const data = await body();
        if (Object.keys(data).some(k => !['userId', 'credential', 'revision'].includes(k))) throw new InputError('Use the encrypted login protocol.');
        const session = await auth.login(client, data.userId, data.credential, data.revision);
        return json({ ok: true }, 200, { 'Set-Cookie': auth.cookie(session.token, session.maxAge, secure) });
      }
      // Every shell is public and contains no task data. Unlock happens in the page.
      const assetPath = path.startsWith(`/assets/${ASSET_VERSION}/`) ? path.slice(`/assets/${ASSET_VERSION}`.length) : path;
      const shell = ['/', '/login', '/offline-shell', '/login-shell'].includes(path);
      if (read && assets.has(assetPath) && (shell || path === '/sw.js' || path.startsWith(`/assets/${ASSET_VERSION}/`))) {
        const [file, type] = assets.get(assetPath)!;
        const socketOrigin = origin.replace(/^http/, 'ws');
        return new Response(request.method === 'HEAD' ? null : Bun.file(resolve(assetDirectory, file)), { headers: { ...headers, 'Content-Type': type,
          'Content-Security-Policy': headers['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' ${socketOrigin}`) } });
      }
      const userId = auth.identity(request);
      if (!userId) return json({ error: 'Sign in to sync. Encrypted pending changes remain on this device.' }, 401);
      if (request.headers.get('x-taskpath-user') && request.headers.get('x-taskpath-user') !== userId) return json({ error: 'Another account is signed in. Unlock this account to sync.' }, 401);
      if (path === '/api/auth/logout' && request.method === 'POST') {
        auth.logout(request); realtime?.checkSessions();
        return json({ ok: true }, 200, { 'Set-Cookie': auth.cookie('', 0, secure) });
      }
      if (path === '/api/auth/password' && request.method === 'POST') {
        const data = await body();
        if (Object.keys(data).some(k => !['revision', 'config', 'currentCredential', 'credential'].includes(k))) throw new InputError('Unsupported password-change payload.');
        await auth.changePassword(client, request, data.currentCredential, data.credential, data.config, data.revision);
        realtime?.checkSessions();
        return json({ ok: true }, 200, { 'Set-Cookie': auth.cookie('', 0, secure) });
      }
      if (path === '/api/events' && request.method === 'GET') {
        if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new InputError('Cross-origin requests are not allowed.', 403);
        if (url.searchParams.get('userId') && url.searchParams.get('userId') !== userId) return json({ error: 'Account changed.' }, 401);
        if (!realtime || !server || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required.' }, 426);
        if (server.upgrade(request, { data: { userId, authorized: () => auth.identity(request) === userId } })) return;
        return json({ error: 'WebSocket upgrade failed.' }, 400);
      }
      if (path === '/api/sync' && request.method === 'GET') return json(store.syncBoard(userId));
      if (path === '/api/sync' && request.method === 'POST') {
        const result = store.sync(userId, await body());
        if (result.changed) realtime?.notify(userId);
        const { changed, ...response } = result;
        return json(response);
      }
      if (path === '/api/reminders/claim' && request.method === 'POST') {
        const data = await body();
        if (Object.keys(data).some(k => k !== 'tokens')) throw new InputError('Use opaque reminder tokens.');
        return json(store.claim(userId, data.tokens));
      }
      return json({ error: 'Endpoint unavailable. Task operations and readable exports run in the unlocked browser.' }, 404);
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status, error.status === 429 ? { 'Retry-After': '900' } : {});
      // Never log request bodies, credentials, or encryption material.
      console.error('Taskpath request failed.');
      return json({ error: 'Could not complete the request. Please try again.' }, 500);
    }
  };
}
if (import.meta.main) {
  if (process.env.NODE_ENV === 'production') {
    const shell = resolve(import.meta.dir, '../dist/public/index.html');
    if (!existsSync(shell) || !readFileSync(shell, 'utf8').includes(`/assets/${ASSET_VERSION}/`)) throw new Error('Client build missing or outdated. Run bun run build before starting production.');
  }
  if (process.env.TASKPATH_PASSWORD || process.env.TASKPATH_PASSWORD_HASH || process.env.TASKPATH_USERNAME) throw new Error('Remove legacy authentication environment variables. This version uses browser-based encrypted setup and a fresh database.');
  const store = new Store(process.env.DATABASE_PATH || './data/taskpath-accounts.sqlite', undefined, process.env.TASKPATH_TIMEZONE);
  const auth = new AuthManager(store.db, Number(process.env.TASKPATH_SESSION_DAYS || 30));
  const realtime = new Realtime();
  const server = Bun.serve({ hostname: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000), maxRequestBodySize: 2 * 1024 * 1024,
    fetch: createHandler(store, auth, process.env.TASKPATH_ORIGIN, realtime), websocket: realtime.websocket });
  const launchURL = new URL('/', process.env.TASKPATH_ORIGIN || server.url);
  if (!process.env.TASKPATH_ORIGIN && ['0.0.0.0', '[::]'].includes(launchURL.hostname)) launchURL.hostname = 'localhost';
  console.log(`Taskpath is ready at ${launchURL}`);
  console.log('Create an invitation with: bun run admin invite');
  const shutdown = async () => { realtime.close(); await server.stop(); store.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
