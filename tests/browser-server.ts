import { clientAsset } from '../src/client-assets';
import { Realtime } from '../src/realtime';
// Manual real-browser integration harness; never served by the application.
// Run with: bun run tests/browser-server.ts, then open the printed /checks link.
import { Store } from '../src/store';
import { AuthManager } from '../src/auth';
import { createHandler } from '../src/server';
import { createVault } from '../public/crypto.js';
import { resolve } from 'node:path';
const store = new Store(), auth = new AuthManager(store.db);
const vault = await createVault('browser harness password 2026');
const invite = auth.createInvitation();
await auth.setup(invite.userId, invite.token, vault.config, vault.credential);
const secondInvite = auth.createInvitation(), secondVault = await createVault('browser second password 2026');
await auth.setup(secondInvite.userId, secondInvite.token, secondVault.config, secondVault.credential);
const pendingInvite = auth.createInvitation();
const mode = process.env.QA_ASSETS || 'source';
if (!['source', 'built'].includes(mode)) throw new Error('QA_ASSETS must be source or built');
const hub = new Realtime();
const app = createHandler(store, auth, undefined, hub, resolve(import.meta.dir, mode === 'built' ? '../dist/public' : '../public'));
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.QA_PORT || 3195), websocket: hub.websocket, async fetch(request, server) {
  const path = new URL(request.url).pathname;
  // A test-only same-origin frame supplies a real 390px layout viewport when
  // browser automation cannot resize hidden tabs. Production CSP stays unchanged.
  if (path === '/phone-preview') return new Response('<!doctype html><meta charset="utf-8"><title>Taskpath phone preview</title><iframe title="Phone viewport" src="/preview-shell" width="390" height="844" style="border:0"></iframe>', { headers: { 'content-type': 'text/html' } });
  if (path === '/preview-shell') {
    const response = (await app(new Request(new URL('/', request.url), request)))!;
    response.headers.set('Content-Security-Policy', response.headers.get('Content-Security-Policy')!.replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return response;
  }
  if (path === '/test-account') return Response.json({ userId: invite.userId, secondUserId: secondInvite.userId });
  // A fake subscription exercises persisted scheduling without contacting any push provider.
  if (path === '/test-push') {
    const userId = auth.identity(request);
    if (!userId) return new Response('Unauthorized', { status: 401 });
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
      store.db.query('INSERT OR IGNORE INTO push_subscriptions VALUES (?, ?, ?)').run('fixture-' + userId, userId, '{}');
    }
    return Response.json({ reminders: store.db.query('SELECT taskId,changeId,token,dueAt FROM push_reminders WHERE userId=?').all(userId) });
  }
  if (path === '/invitation') return new Response('<!doctype html><a href="/#user=' + pendingInvite.userId + '&amp;setup=' + pendingInvite.token + '">Open test invitation</a>', { headers: { 'content-type': 'text/html' } });
  if (path === '/checks') return new Response('<!doctype html><meta charset="utf-8"><title>Taskpath browser checks</title><h1>Browser persistence checks</h1><pre id="result">Running…</pre><script type="module" src="/checks.js"></script>', { headers: { 'content-type': 'text/html' } });
  if (path === '/checks.js') return new Response(await clientAsset(import.meta.dir, 'browser-checks.js'), { headers: { 'content-type': 'text/javascript' } });
  if (path === '/frame') return new Response('<!doctype html><script type="module" src="/frame.js"></script>', { headers: { 'content-type': 'text/html' } });
  if (path === '/worker.js') return new Response(await clientAsset(import.meta.dir, 'browser-worker.js'), { headers: { 'content-type': 'text/javascript' } });
  if (path === '/frame.js') return new Response(await clientAsset(import.meta.dir, 'browser-frame.js'), { headers: { 'content-type': 'text/javascript' } });
  return app(request, server);
} });
console.log(`Isolated ${mode} browser checks: ${server.url}checks`);
