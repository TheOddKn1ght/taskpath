// Manual real-browser integration harness; never served by the application.
// Run with: bun run tests/browser-server.ts, then open the printed /checks link.
import { Store } from '../src/store';
import { AuthManager } from '../src/auth';
import { createHandler } from '../src/server';
import { createVault } from '../public/crypto.js';
import { resolve } from 'node:path';
const store = new Store(), auth = new AuthManager(store.db);
const vault = await createVault('browser harness password 2026');
await auth.setup(auth.issueSetupToken(), vault.config, vault.credential);
const app = createHandler(store, auth);
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.QA_PORT || 3195), async fetch(request) {
  const path = new URL(request.url).pathname;
  // A test-only same-origin frame supplies a real 390px layout viewport when
  // browser automation cannot resize hidden tabs. Production CSP stays unchanged.
  if (path === '/phone-preview') return new Response('<!doctype html><meta charset="utf-8"><title>Taskpath phone preview</title><iframe title="Phone viewport" src="/preview-shell" width="390" height="844" style="border:0"></iframe>', { headers: { 'content-type': 'text/html' } });
  if (path === '/preview-shell') {
    const response = await app(new Request(new URL('/', request.url), request));
    response.headers.set('Content-Security-Policy', response.headers.get('Content-Security-Policy')!.replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return response;
  }
  if (path === '/checks') return new Response('<!doctype html><meta charset="utf-8"><title>Taskpath browser checks</title><h1>Browser persistence checks</h1><pre id="result">Running…</pre><script type="module" src="/checks.js"></script>', { headers: { 'content-type': 'text/html' } });
  if (path === '/checks.js') return new Response(Bun.file(resolve(import.meta.dir, 'browser-checks.js')), { headers: { 'content-type': 'text/javascript' } });
  if (path === '/frame') return new Response('<!doctype html><script type="module" src="/frame.js"></script>', { headers: { 'content-type': 'text/html' } });
  if (path === '/worker.js') return new Response(Bun.file(resolve(import.meta.dir, 'browser-worker.js')), { headers: { 'content-type': 'text/javascript' } });
  if (path === '/frame.js') return new Response(Bun.file(resolve(import.meta.dir, 'browser-frame.js')), { headers: { 'content-type': 'text/javascript' } });
  return app(request);
} });
console.log(`Isolated browser checks: ${server.url}checks`);
