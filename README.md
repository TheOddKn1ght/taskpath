# Taskpath

A local task board inspired by [Flodo](https://flodo.fehey.com/): collect tasks in **Later**, plan **This Week**, pick **Today**, and check off **Done**.

Bun + SQLite, with plain HTML, CSS, and JavaScript. No package dependencies, external fonts, analytics, or build step.

## Run locally

Requires Bun 1.4.0 or newer.

```sh
bun run start
```

Open http://127.0.0.1:3000. No `bun install` is needed. `bun run dev` restarts the server when source changes; refresh the browser after frontend edits.

For Bun's optional `--smol` mode, run `bun run start:smol` (or `bun run dev:smol` while developing). This reduces JavaScript heap memory usage by collecting garbage more often, which can trade performance for memory. Normal startup keeps Bun's default behavior.

Tasks persist in `data/taskpath.sqlite`. The app starts empty. Drag anywhere on a card to move or reorder it; on touch screens, use its drag handle. Task move controls and the menu also support moving without dragging. Click a task title to edit its title, notes, category, or column. Delete offers Undo for 15 seconds.

Right-click a task for editing, dates and reminders, moving, completing, or deleting. On a focused task, **Shift+F10** opens the same menu; arrow keys navigate it and **Esc** closes it.

Keyboard shortcuts: **N** opens a task, **/** focuses search, and **Esc** closes dialogs. Enter in a column's Add task field saves directly.

The sun/moon button switches between light and dark themes. Taskpath follows your system appearance until you choose a theme, then remembers that choice in this browser and syncs it across open tabs.

## Offline use and phone installation

Sign in and open the board online once. Taskpath keeps a device copy in IndexedDB and caches the app shell with a service worker. Create, edit, move, complete, delete, undo, set dates, and dismiss or snooze reminders offline. Every edit commits to device storage before it appears as saved; the footer distinguishes pending device changes from changes synced to the server. JSON and Markdown exports use the current device copy, including pending edits. Markdown preview requires a connection to Bun's parser; once previewed, importing tasks uses the offline queue too.

WebSocket notifications make changes appear immediately on other connected, visible devices. Task data and writes still use the durable HTTP sync queue. Sockets authenticate with the existing session cookie and check the exact Origin; logout and expiry close them. A heartbeat checks the connection, and reconnects fetch a fresh snapshot. No additional dependency is required.

Sync retries after edits, when connectivity returns, and on focus/reopen. Every 15 seconds, the page retries pending writes and polls if the socket is unavailable. Hidden pages close their socket and reconnect when shown again. Background Sync is also used where supported. iPhone/iPad do not guarantee syncing while the app is closed: reopen Taskpath with a connection to finish syncing. Desktop notifications still require an open app and a connection for the existing cross-device reminder claim; in-app due reminders work offline.

Conflicts use **the most recent edit of the whole task**, including its column, order, dates, and deleted state. Edit time is captured when the edit is saved, adjusted by the last known server clock offset; it is not the time the queue arrives. Equal timestamps use the operation ID as a stable tie-break. A newer deletion beats an older edit; a newer edit can restore a previously deleted task. Repeated delivery is safe. Automatic day/week rollover does not count as a new user edit. Keep device clocks on automatic time.

Expired login sessions pause syncing and show **Sign in to sync**. Pending changes remain on the device. Explicit **Sign out** requires all pending changes to sync and then removes the local task copy. Offline storage is available to anyone with access to this browser profile until sign-out; clearing browser/site data removes unsynced edits. SQLite remains the server backup source. Device storage is subject to browser quotas and eviction, so sync regularly; exports also work offline.

- **iPhone/iPad:** open the HTTPS site in Safari, sign in, then **Share → Add to Home Screen**. Open the new home-screen app online once before taking it offline (it may have a separate login/storage context).
- **Android:** use **Install Taskpath** in the workspace menu when offered, or the browser's **Install app / Add to Home screen** menu.
- The installed app uses a standalone window, phone icons, safe-area spacing, and inputs sized to prevent automatic zoom.

For upgrades, close all Taskpath tabs/windows and reopen to activate a downloaded service-worker update. Developers: bump the shell cache version in `public/sw.js` when releasing changed cached assets. Update the deployed Nginx template too: `/api/sync` permits a bounded 2 MB request body, and the burst allowance covers initial PWA asset downloads, and `/api/events` forwards WebSocket upgrades. Existing deployments without the new proxy location continue syncing through polling until Nginx is updated. All sync endpoints remain authenticated; only static shells/assets are public. No task data or credentials are stored in the service-worker cache.

Implementation references: [Bun WebSockets](https://bun.com/docs/runtime/http/websockets), [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html).

Browser references: [offline/background operation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation), [iOS home-screen web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Tags

Tags sit alongside Work/Personal. Add them in the task editor by typing a name and pressing Enter or tapping **Add**. Existing workspace tags appear as suggestions. Remove a tag with its × button. Names are lowercase, support spaces and Unicode, and are limited to 32 characters and 10 tags per task.

Cards show two subtle labels; **+N** opens the editor to see the rest. Click a label or use **All tags** to filter by one tag. Tags combine with category and text search, and quick-add/new tasks inherit the selected tag. Choose **All tags** to clear the filter. Suggestions come from non-deleted local tasks and work offline.

Tags sync with the whole task using the existing latest-edit-wins rule. They survive moves, reminders, deletion/undo, and offline edits. Markdown exports include a nested `Tags: ["errands", "home"]` metadata line; imports and JSON exports preserve tags too. Existing tasks and older Markdown files start with no tags. Older clients that omit the field preserve tags already on the server; an explicit empty array clears them.

The database migrates automatically. After updating, open Taskpath online, close all Taskpath tabs and installed-app windows, then reopen to activate the new offline shell. No Nginx changes are needed for tags.

## Dates and reminders

Open a task and expand **Date & reminder**. Both fields are optional and independent. Due dates appear on cards, with Today, Tomorrow, and overdue labels. Dates stay attached when tasks move or roll over; they do not automatically move tasks into Today.

Reminder times use the device timezone shown in the editor and are stored as UTC instants. Due dates are calendar dates evaluated in the workspace's planning timezone. Clear either input to remove it, or use **Clear dates** to remove both.

Due reminders appear above the board until you **Dismiss** or **Snooze 10m**. Dismissal and snoozing are saved in SQLite. Completing or deleting a task hides its reminder. Missed reminders appear when the app is reopened.

Use **Enable desktop notifications** in the editor or workspace menu to opt in. Desktop delivery requires a supported browser, permission, and a secure context (localhost or HTTPS). Taskpath must remain open in a tab; it cannot send notifications with all tabs closed, while the device sleeps, or when the browser suspends timers. It checks again when you return. See [MDN's Notifications API documentation](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API).

Desktop reminders are claimed once per scheduled time across open tabs/devices; the persistent in-app reminder is the fallback if the browser cannot display a notification. Rescheduling or snoozing rearms it. No external notification service is used. Existing databases migrate automatically on startup.

## Weekly rhythm

At local midnight, unfinished Today tasks return to This Week. On Monday, unfinished Today and This Week tasks return to Later. Completed tasks remain in Done. Rollover happens when the board is read or a task is changed, including after the app has been offline; open boards refresh every 15 seconds and on focus, with additional checks near scheduled reminder times.

Copy `.env.example` to `.env` to customize the port, database location, timezone, or optional login. Bun loads `.env` automatically. Local runs use the system timezone on first start and remember it in SQLite. `TASKPATH_TIMEZONE` overrides it; set this explicitly when moving between hosts. Weeks start on Monday.

## Docker

For a complete fresh-VPS walkthrough covering DNS, Docker installation, credentials, HTTPS certificates, Nginx, verification, backups, and upgrades, see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

Set your timezone in `.env`, for example:

```dotenv
TASKPATH_TIMEZONE=Europe/Moscow
```

Then run:

```sh
docker compose up -d --build
```

Open http://127.0.0.1:3000. Compose stores SQLite in the `taskpath-data` named volume, mounts it at `/app/data`, and binds the published port to loopback. The container runs as the non-root `bun` user. Container restarts and image replacements preserve the volume. Compose defaults to UTC when no planning timezone is provided.

To enable `--smol` in Docker Compose, set `TASKPATH_START_SCRIPT=start:smol` in `.env`, then run `docker compose up -d`. Remove the setting or set it to `start` to switch back. This setting selects the Compose startup command; for local runs use the scripts above. With plain Docker, override the image command with `bun run start:smol`.

For another host, copy the project and use the same Compose command there. For remote access, put it behind an HTTPS reverse proxy and enable session authentication. Generate a password hash with `bun run hash-password`, then put the result in `.env` inside single quotes:

```dotenv
TASKPATH_USERNAME=me
TASKPATH_PASSWORD_HASH='$argon2id$v=19$m=65536,t=2,p=1$...'
TASKPATH_SESSION_DAYS=30
TASKPATH_ORIGIN=https://tasks.example.com
```

The app is a single shared workspace, not a multi-user account system. Both authentication settings must be set together. Taskpath verifies the password with Argon2id and stores only hashed, revocable session tokens in SQLite. Browser cookies are `HttpOnly` and `SameSite=Strict`, and are marked `Secure` when the public origin uses HTTPS. Changing the password hash invalidates existing sessions. Set `TASKPATH_ORIGIN` to your actual public origin when TLS terminates at a reverse proxy; preserve the browser's Origin header. The API accepts mutations from that exact origin. The `/healthz` endpoint is public and returns only a health flag.

### Nginx reverse proxy

Use [`deploy/nginx/taskpath.conf.example`](deploy/nginx/taskpath.conf.example) when Nginx runs directly on the VPS host. It proxies to Taskpath's existing loopback port, redirects HTTP to HTTPS, preserves session cookies and origin checks, and limits each client IP to 2 requests/second with a burst of 60. Excess requests receive HTTP 429. Taskpath also blocks a client for 15 minutes after five failed sign-in attempts.

1. Point your domain's DNS to the VPS. Set `TASKPATH_USERNAME`, `TASKPATH_PASSWORD_HASH`, and `TASKPATH_ORIGIN=https://your-domain` in `.env`, then restart Taskpath to load them. Keep port 3000 bound to `127.0.0.1`; allow public traffic only to Nginx's ports 80/443, plus your administration access.
2. Replace **every** `tasks.example.com` in the template with your domain. If you changed `PORT`, also change `proxy_pass` to that port. The certificate paths assume Let's Encrypt; adjust them for your certificate provider.
3. Obtain a certificate before enabling the HTTPS block. For a first certificate using ACME webroot validation, initially enable only the port-80 server block and create `/var/www/letsencrypt`. Have your ACME client use that directory as its webroot. Once the certificate files exist, enable the full template. Keep the ACME location for renewals and arrange an Nginx reload after certificate renewal.
4. Save the edited file as `/etc/nginx/conf.d/taskpath.conf`. It must be included **inside the `http {}` block** of `/etc/nginx/nginx.conf`; do not wrap this template in another `http {}` block. Alternatively, use your distribution's `sites-available`/`sites-enabled` convention, but include the file only once.
5. Validate and reload Nginx on the VPS:

   ```sh
   sudo nginx -t
   sudo systemctl reload nginx
   ```

Visit the HTTPS URL: Taskpath should show its sign-in page before showing any tasks. An unauthenticated request to `/api/board` returns 401. The public `/healthz` endpoint is intentionally exempt. The template adds HSTS for this hostname only, so browsers will require HTTPS for it afterward.

This template assumes Nginx is the public edge. If another proxy or CDN sits in front of it, configure trusted real-client-IP handling before relying on per-IP limits. If Nginx runs in a separate container, its `127.0.0.1` is not the Taskpath container; use a shared private Docker network and the Taskpath service address instead.

Directive references: [Nginx proxy headers](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header) and [request rate limiting](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html).

## Data and backups

The workspace menu offers **Export Markdown**, **Import Markdown…**, and **Export JSON**. Exports include all active and completed tasks, regardless of the current search/category filter. Deleted tasks are excluded. JSON export remains available; JSON import is not supported.

### Markdown

Choose **Import Markdown…**, select a `.md` file or paste text, then **Preview** and **Import**. Preview shows the tasks to add, duplicates to skip, and any ignored document blocks. Import appends tasks and keeps existing tasks. All tasks are validated before anything is inserted, and the import commits in one transaction.

The importer uses Bun's built-in `Bun.markdown.render()` parser. Checklists under headings **Later**, **This Week**, **Today**, and **Done** go to the matching columns. Checked items go to Done; items without a recognized heading go to Later. Nested checklist items become separate tasks. Code examples and quoted checklists outside tasks are ignored. Inline formatting becomes plain text, and link destinations are retained.

```markdown
## This Week

- [ ] Write the first draft
  - Category: Work
  - Due: 2026-09-10
  - Reminder: 2026-09-10T09:00:00+03:00
  > Include the outline and references.

## Done

- [x] Gather ideas
```

Category defaults to Personal. Dates use `YYYY-MM-DD`; reminder timestamps require a timezone (`Z` or an offset). Notes can be indented paragraphs, blockquotes, or code blocks beneath a task. Taskpath exports notes in fenced blocks so literal Markdown and spacing survive a round trip. Export also retains dismissed reminder times with an optional `Reminder dismissed:` field.

Exact duplicates are skipped within the file and against the board, comparing title, notes, category, column, due date, reminder time, and whether the reminder is dismissed. Import does not update or merge edited tasks with existing ones. Imported tasks receive new IDs; Today and This Week apply to the current planning day/week. Original creation/completion timestamps and desktop notification delivery history are not restored. Past active reminders appear immediately after import.

Imports are limited to **500 tasks and 256 KB of Markdown** per file/paste; split larger exports by task if needed. The Nginx template allows larger JSON request bodies for `/api/import/` and `/api/sync`, while other writes retain the 32 KB limit. Update an existing deployed Nginx configuration when adding this feature.

For a full backup, stop the local process and copy the entire `data/` directory, including any SQLite WAL sidecar files. Restore by placing that directory back before starting. For Docker, stop the service before backing up or restoring its named volume. Do not use `docker compose down -v` when you want to keep tasks: it removes the volume.

Deleted tasks are soft-deleted for recovery and remain in SQLite; they are excluded from the board and JSON export. The restore endpoint is `POST /api/tasks/{id}/restore` with `Content-Type: application/json` and an empty JSON object.

## Verification

```sh
bun test
```

Tests use isolated databases to verify durable ordering, rollover, DST/year boundaries, deletion recovery, validation, and API authentication. They do not read your workspace database.

### GitHub CI

The [Tests workflow](.github/workflows/tests.yml) runs `bun test` on pushes and pull requests, and can be started manually from GitHub's Actions tab. It uses Ubuntu 24.04 and Bun 1.4.0, matching the Docker image and minimum supported version. New runs cancel older runs for the same branch or pull request, and each job has a five-minute timeout.

The full suite includes SQLite migrations, authentication, tags, Markdown, offline sync, and real localhost WebSocket connections. To reproduce CI locally, use Bun 1.4.0 and run `bun test`. No dependency installation, secrets, build, or deployment steps are required.

The frontend optionally exposes `list_tasks`, `create_task`, and `move_task` to browsers that support WebMCP. Ordinary browsers use the same interface without it.
