import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { InputError, Store } from "./store";
import { exportMarkdown, parseMarkdown } from './markdown';

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/dates.js", ["dates.js", "text/javascript; charset=utf-8"]],
  ["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

export function createHandler(store: Store, credentials?: { username: string; password: string }, publicOrigin?: string) {
  const trustedOrigin = publicOrigin ? new URL(publicOrigin) : null;
  if (trustedOrigin && !["http:", "https:"].includes(trustedOrigin.protocol)) throw new Error("TASKPATH_ORIGIN must be an HTTP or HTTPS URL.");
  const auth = credentials ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` : null;
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  return async (request: Request) => {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true });
      if (auth) {
        const actual = Buffer.from(request.headers.get("authorization") || "");
        const expected = Buffer.from(auth);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          return new Response("Sign in to your Taskpath workspace.", { status: 401, headers: { ...headers, "WWW-Authenticate": 'Basic realm="Taskpath", charset="UTF-8"' } });
        }
      }
      // JSON-only mutations plus Origin validation prevent cross-site writes to local data.
      if (!["GET", "HEAD"].includes(request.method)) {
        const origin = request.headers.get("origin");
        if ((origin && origin !== (trustedOrigin?.origin || url.origin)) || request.headers.get("sec-fetch-site") === "cross-site") throw new InputError("Cross-origin requests are not allowed.", 403);
        if (request.method !== "DELETE" && request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new InputError("Use application/json.", 415);
      }
      const body = async () => {
        const limit = ['/api/import/markdown', '/api/import/preview'].includes(url.pathname) ? 2 * 1024 * 1024 : 32768;
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
      if (url.pathname === "/api/board" && request.method === "GET") return json(store.board());
      if (url.pathname === "/api/export" && request.method === "GET") {
        if (url.searchParams.get('format') === 'markdown') return new Response(exportMarkdown(store.board().tasks), {
          headers: { ...headers, 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="taskpath-export.md"' },
        });
        return new Response(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...store.board() }, null, 2), {
          headers: { ...headers, "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="taskpath-export.json"' },
        });
      }
      if (['/api/import/preview', '/api/import/markdown'].includes(url.pathname) && request.method === 'POST') {
        const input = await body();
        const parsed = parseMarkdown(input?.markdown);
        if (url.pathname === '/api/import/preview') return json({ ...store.previewImport(parsed.tasks), ignoredBlocks: parsed.ignoredBlocks });
        return json(store.importTasks(parsed.tasks), 201);
      }
      if (url.pathname === "/api/tasks" && request.method === "POST") return json({ task: store.create(await body()) }, 201);
      if (url.pathname === "/api/reminders/claim" && request.method === "POST") return json({ tasks: store.claimReminders() });
      const reminderMatch = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/reminder$/);
      if (reminderMatch && request.method === "POST") return json({ task: store.actOnReminder(reminderMatch[1]!, await body()) });
      const match = url.pathname.match(/^\/api\/tasks\/([\w-]+)(\/restore)?$/);
      if (match) {
        const id = match[1]!;
        if (match[2] && request.method === "POST") return json({ task: store.restore(id) });
        if (!match[2] && request.method === "PATCH") return json({ task: store.update(id, await body()) });
        if (!match[2] && request.method === "DELETE") { store.remove(id); return json({ ok: true }); }
      }
      if (["GET", "HEAD"].includes(request.method) && assets.has(url.pathname)) {
        const [filename, contentType] = assets.get(url.pathname)!;
        return new Response(request.method === "HEAD" ? null : Bun.file(resolve(import.meta.dir, "../public", filename!)), { headers: { ...headers, "Content-Type": contentType! } });
      }
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "Something went wrong while saving. Please try again." }, 500);
    }
  };
}

if (import.meta.main) {
  const username = process.env.TASKPATH_USERNAME;
  const password = process.env.TASKPATH_PASSWORD;
  if (Boolean(username) !== Boolean(password)) throw new Error("Set both TASKPATH_USERNAME and TASKPATH_PASSWORD, or neither.");
  if (username?.includes(":")) throw new Error("TASKPATH_USERNAME cannot contain a colon.");
  const store = new Store(process.env.DATABASE_PATH || "./data/taskpath.sqlite", undefined, process.env.TASKPATH_TIMEZONE);
  const server = Bun.serve({
    hostname: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 3000),
    maxRequestBodySize: 2 * 1024 * 1024,
    fetch: createHandler(store, username && password ? { username, password } : undefined, process.env.TASKPATH_ORIGIN),
  });
  console.log(`Taskpath is ready at ${server.url} (planning timezone: ${store.timezone})`);
  const shutdown = async () => { await server.stop(); store.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
