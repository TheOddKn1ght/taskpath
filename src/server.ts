import type { Server } from "bun";
import { Realtime, type RealtimeData } from "./realtime";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { AuthManager, type AuthConfig } from "./auth";
import { InputError, Store, object } from "./store";
import { exportMarkdown, parseMarkdown } from "./markdown";

const assets = new Map<string, [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/login", ["login.html", "text/html; charset=utf-8"]],
  ["/login.js", ["login.js", "text/javascript; charset=utf-8"]],
  ["/tags.js", ["tags.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/dates.js", ["dates.js", "text/javascript; charset=utf-8"]],
  ["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/offline-shell", ["index.html", "text/html; charset=utf-8"]],
  ["/login-shell", ["login.html", "text/html; charset=utf-8"]],
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
// Static shells contain no task data. API data always requires authentication.
const publicAssets = new Set([...assets.keys()].filter(path => path !== '/'));

export function createHandler(store: Store, authConfig?: AuthConfig, publicOrigin?: string, realtime?: Realtime) {
  const trustedOrigin = publicOrigin ? new URL(publicOrigin) : null;
  if (trustedOrigin && !["http:", "https:"].includes(trustedOrigin.protocol)) throw new Error("TASKPATH_ORIGIN must be an HTTP or HTTPS URL.");
  if (authConfig && !/^\$argon2id\$v=19\$/.test(authConfig.passwordHash)) throw new Error("TASKPATH_PASSWORD_HASH must be a Bun Argon2id password hash.");
  if (authConfig?.sessionDays !== undefined && (!Number.isInteger(authConfig.sessionDays) || authConfig.sessionDays < 1 || authConfig.sessionDays > 365)) {
    throw new Error("TASKPATH_SESSION_DAYS must be a whole number from 1 to 365.");
  }
  const auth = authConfig ? new AuthManager(store.db, authConfig) : null;
  const workspaceId = store.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'workspaceId'").get()!.value;
  const workspaceKey = createHash('sha256').update(JSON.stringify([workspaceId, authConfig?.username || 'local'])).digest('hex');
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
  const mutation = <T>(write: () => T) => {
    const changes = () => store.db.query<{ count: number }, []>('SELECT total_changes() AS count').get()!.count;
    const before = changes();
    const result = write();
    if (changes() !== before) realtime?.notify();
    return result;
  };
  const asset = (pathname: string, method: string, requestUrl: string) => {
    const [filename, contentType] = assets.get(pathname)!;
    const socketOrigin = new URL(trustedOrigin?.origin || requestUrl);
    socketOrigin.protocol = socketOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
    const csp = headers['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' ${socketOrigin.origin}`);
    return new Response(method === "HEAD" ? null : Bun.file(resolve(import.meta.dir, "../public", filename)), { headers: { ...headers, "Content-Security-Policy": csp, "Content-Type": contentType } });
  };

  return async (request: Request, server?: Pick<Server<RealtimeData>, "upgrade">) => {
    try {
      const url = new URL(request.url);
      const secureCookie = (trustedOrigin?.protocol || url.protocol) === "https:";
      const isRead = ["GET", "HEAD"].includes(request.method);
      const validateMutation = () => {
        if (isRead) return;
        const origin = request.headers.get("origin");
        const expected = trustedOrigin?.origin || url.origin;
        if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== expected) || ((auth || trustedOrigin) && !origin)) {
          throw new InputError("Cross-origin requests are not allowed.", 403);
        }
        if (request.method !== "DELETE" && request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new InputError("Use application/json.", 415);
      };
      const body = async () => {
        const limit = ["/api/import/markdown", "/api/import/preview", "/api/sync"].includes(url.pathname) ? 2 * 1024 * 1024 : 32768;
        if (Number(request.headers.get("content-length")) > limit) throw new InputError("Request is too large.", 413);
        let size = 0;
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel(); throw new InputError("Request is too large.", 413); }
            chunks.push(value);
          }
        }
        try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new InputError("Invalid JSON."); }
      };

      if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true });
      if (url.pathname === "/api/auth/status" && request.method === "GET") {
        return json({ enabled: Boolean(auth), authenticated: !auth || auth.isAuthenticated(request) });
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        if (!auth) return json({ error: "Authentication is not enabled." }, 404);
        validateMutation();
        const data = object(await body());
        if (Object.keys(data).some(key => !["username", "password"].includes(key)) || typeof data.username !== "string" || !data.username || data.username.length > 254 || typeof data.password !== "string" || !data.password || data.password.length > 1024) {
          throw new InputError("Enter your username and password.");
        }
        const forwardedClient = trustedOrigin ? request.headers.get("x-real-ip") : null;
        const client = forwardedClient && forwardedClient.length <= 100 ? forwardedClient : "direct-client";
        const result = await auth.login(client, data.username, data.password);
        if (!result.ok) return json(
          { error: result.status === 429 ? "Too many attempts. Wait 15 minutes and try again." : "Username or password is incorrect." },
          result.status,
          result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {},
        );
        return json({ ok: true }, 200, { "Set-Cookie": auth.cookie(result.token, result.maxAge, secureCookie) });
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        if (!auth) return json({ ok: true });
        validateMutation();
        auth.logout(request);
        realtime?.checkSessions();
        return json({ ok: true }, 200, { "Set-Cookie": auth.clearCookie(secureCookie) });
      }

      const authenticated = !auth || auth.isAuthenticated(request);
      if (url.pathname === "/login" && isRead) {
        if (authenticated) return new Response(null, { status: 303, headers: { ...headers, Location: "/" } });
        return asset(url.pathname, request.method, request.url);
      }
      if (isRead && publicAssets.has(url.pathname)) return asset(url.pathname, request.method, request.url);
      if (!authenticated) {
        if (url.pathname.startsWith("/api/")) return json({ error: "Your session has expired. Sign in again." }, 401);
        return new Response(null, { status: 303, headers: { ...headers, Location: "/login" } });
      }

      if (url.pathname === '/api/events') {
        if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
        if (request.headers.get('origin') !== (trustedOrigin?.origin || url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
          throw new InputError('Cross-origin requests are not allowed.', 403);
        }
        if (!realtime || !server || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return json({ error: 'WebSocket upgrade required.' }, 426);
        }
        if (server.upgrade(request, { data: { authorized: () => !auth || auth.isAuthenticated(request) } })) return;
        return json({ error: 'WebSocket upgrade failed.' }, 400);
      }

      validateMutation();
      if (url.pathname === '/api/sync' && request.method === 'GET') return json({ ...store.syncBoard(), workspaceKey });
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        const input = object(await body());
        if (input.workspaceKey !== workspaceKey) throw new InputError('This server has a different workspace. Export pending changes before switching.', 409);
        return json({ ...mutation(() => store.sync(input)), workspaceKey });
      }
      if (url.pathname === "/api/board" && request.method === "GET") return json(store.board());
      if (url.pathname === "/api/export" && request.method === "GET") {
        if (url.searchParams.get("format") === "markdown") return new Response(exportMarkdown(store.board().tasks), {
          headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="taskpath-export.md"' },
        });
        return new Response(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...store.board() }, null, 2), {
          headers: { ...headers, "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="taskpath-export.json"' },
        });
      }
      if (["/api/import/preview", "/api/import/markdown"].includes(url.pathname) && request.method === "POST") {
        const input = await body();
        const parsed = parseMarkdown(input?.markdown);
        if (url.pathname === "/api/import/preview") return json({ ...store.previewImport(parsed.tasks), ignoredBlocks: parsed.ignoredBlocks });
        return json(mutation(() => store.importTasks(parsed.tasks)), 201);
      }
      if (url.pathname === "/api/tasks" && request.method === "POST") { const input = await body(); return json({ task: mutation(() => store.create(input)) }, 201); }
      if (url.pathname === "/api/reminders/claim" && request.method === "POST") return json({ tasks: mutation(() => store.claimReminders()) });
      const reminderMatch = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/reminder$/);
      if (reminderMatch && request.method === "POST") { const input = await body(); return json({ task: mutation(() => store.actOnReminder(reminderMatch[1]!, input)) }); }
      const match = url.pathname.match(/^\/api\/tasks\/([\w-]+)(\/restore)?$/);
      if (match) {
        const id = match[1]!;
        if (match[2] && request.method === "POST") return json({ task: mutation(() => store.restore(id)) });
        if (!match[2] && request.method === "PATCH") { const input = await body(); return json({ task: mutation(() => store.update(id, input)) }); }
        if (!match[2] && request.method === "DELETE") { mutation(() => store.remove(id)); return json({ ok: true }); }
      }
      if (isRead && assets.has(url.pathname)) return asset(url.pathname, request.method, request.url);
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "Something went wrong while saving. Please try again." }, 500);
    }
  };
}

if (import.meta.main) {
  if (process.env.TASKPATH_PASSWORD) throw new Error("TASKPATH_PASSWORD is no longer supported. Set TASKPATH_PASSWORD_HASH to an Argon2id hash instead.");
  const username = process.env.TASKPATH_USERNAME;
  const passwordHash = process.env.TASKPATH_PASSWORD_HASH;
  if (Boolean(username) !== Boolean(passwordHash)) throw new Error("Set both TASKPATH_USERNAME and TASKPATH_PASSWORD_HASH, or neither.");
  const sessionDays = Number(process.env.TASKPATH_SESSION_DAYS || "30");
  const authConfig = username && passwordHash ? { username, passwordHash, sessionDays } : undefined;
  const store = new Store(process.env.DATABASE_PATH || "./data/taskpath.sqlite", undefined, process.env.TASKPATH_TIMEZONE);
  const realtime = new Realtime();
  const server = Bun.serve({
    hostname: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 3000),
    maxRequestBodySize: 2 * 1024 * 1024,
    fetch: createHandler(store, authConfig, process.env.TASKPATH_ORIGIN, realtime),
    websocket: realtime.websocket,
  });
  console.log(`Taskpath is ready at ${server.url} (planning timezone: ${store.timezone}; authentication: ${authConfig ? "enabled" : "disabled"})`);
  const shutdown = async () => { realtime.close(); await server.stop(); store.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
