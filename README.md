# Taskpath

Taskpath is an invite-only task board with a separate encrypted vault for each account. Collect tasks in Later, plan This Week, and choose Today. The board displays Today, This Week, Later, then Done.

It uses Bun 1.4.2+, SQLite and TypeScript. The server uses Drizzle and Web Push. The React client uses TypeScript and a vendored Marked lexer for offline Markdown imports.

## Start locally

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run start
```

In another terminal, create an invitation for yourself or a friend:

```sh
bun run admin invite
```

The command prints a permanent user ID and a one-use setup link valid for 24 hours. Open it, choose a password of 15 to 1,024 characters, and save both the ID and password. You can also set a nickname. Sign-in requires the user ID and password, never the nickname. Restarting the server does not issue invitations.

Use HTTPS outside localhost. See the [VPS deployment guide](DEPLOYMENT.md) for Docker, Nginx, certificates and backups.

## Plan tasks

Drag tasks between columns or use a card's move control or right-click menu. At midnight, unfinished Today tasks return to This Week. On Monday, weekly tasks return to Later. Rollover uses the workspace timezone. Completed tasks stay in Done.

An unfinished task with a reminder today appears in Today immediately, even if its reminder time is hours away. Change or clear the reminder before moving it to Later or This Week. Clearing it leaves the task in Today. Dismissing the notification also leaves it there. Completion, archiving and deletion remain available. Notifications still wait until the reminder time. Other reminder dates and due dates do not choose a column.

Tasks support up to 10 tags, each up to 32 Unicode characters. Type a name and press Enter, or choose an existing tag. Names are trimmed, normalized, lowercased and deduplicated. Combine text search, category and one tag filter. New tasks inherit the selected tag.

Date and time pickers keep changes as a draft until you save the task. Reminders use device-local time. Choose both an hour and a minute, or type `HH:mm`. Escape closes the top picker. Due dates use `YYYY-MM-DD`.

Board, Archive and Files appear in the desktop sidebar and phone bottom tabs. Views and filters survive refresh through the URL fragment, such as `#archive?q=trip&category=personal&tag=travel`. Search stays local and never reaches the server, but remains visible in browser history and copied links.

The theme menu offers Light, Dark, Gruvbox Light, Gruvbox Dark, Nord, Catppuccin Mocha Rosé Pine Dawn, Midnight, Plum, Ocean, Sand, Lavender and Ice. Follow system chooses Light or Dark. Themes have matching icons, work offline and apply across this browser's accounts. Installed home-screen icons may require reinstallation to change. The interface respects reduced motion.

## Archive and export

Archive a task through its menu or editor. In workspace options, Archive all completed includes every completed task regardless of filters. Nothing is archived automatically.

Archived tasks retain their contents and column but pause reminders and rollover. Restore them before editing. Restoration applies current rollover and today's reminder rule, then appends the task to its column. An overdue reminder can become eligible again. Archive Undo preserves subsequent edits and reports skipped tasks. Deleting an archived task and undoing deletion keeps it archived.

Markdown and JSON exports include active and archived tasks, unsynced edits and tasks hidden by filters. They exclude deleted tasks and files. Exports are readable, so protect them. JSON is a snapshot. Markdown is the supported import format.

```markdown
## This Week
- [ ] Buy groceries
  - Category: Personal
  - Tags: ["errands", "home"]
  - Due: 2026-09-10
  - Reminder: 2026-09-10T09:00:00.000Z
```

Import through workspace options. Parsing and preview work offline with the [vendored Marked lexer](public/vendor/README.md). Imported HTML is never rendered. Column headings set status, checked items go to Done, and nested checklists become separate tasks. Notes and link destinations remain text. Imports accept up to 500 tasks and 256 KB, validate before saving and skip duplicates. Optional `Archived: <ISO timestamp>` metadata preserves archive state. Files without tags or archive metadata still work.

## Accounts and passwords

Each account has its own vault, sessions and encrypted data. There are no shared boards, roles, public registration or email service. User IDs are permanent identifiers, not secrets.

```sh
bun run admin invite
bun run admin list
bun run admin reinvite USER_ID
bun run admin revoke USER_ID
bun run admin disable USER_ID
```

Reinvite replaces a pending link. Revoke cancels it. Neither reopens an activated vault. Disable blocks server access and revokes sessions while retaining encrypted data. Existing WebSockets close at the next authorization check. It cannot erase downloaded data or revoke copied keys. There is no account deletion command.

Send setup links privately. Whoever claims one first gets the pending account. The server stores only token hashes and accepts each token once. Admin commands must use the server's `DATABASE_PATH` and `TASKPATH_ORIGIN`.

Change the optional nickname through workspace options. It is encrypted, works offline and appears in greetings after unlocking. It can contain up to 40 characters and need not be unique.

The password both signs in and decrypts the vault. It never reaches the server. There is no recovery key, password reset or administrator bypass. A forgotten password cannot be recovered. An unlocked or remembered browser may still export readable data.

Remember this device is off by default. Otherwise, keys stay in memory and the page locks on close, reload or navigation away. There is no inactivity timer. Remembering stores a non-extractable key in IndexedDB. Anyone using that browser profile may access the vault. Scripts with access to that key can use it even though the browser will not export its raw bytes.

Lock clears remembered keys and decrypted content across this browser's tabs while preserving encrypted pending changes. It leaves other devices unlocked and does not end the server session. Workers can still transfer ciphertext.

Change password requires the current password and an online connection. It rewraps the vault key without re-encrypting tasks or files and revokes existing server sessions. Other devices must sign in again. An offline device may still unlock its cached copy with the old password until it reconnects. Password changes cannot revoke copied decryption keys.

Switch account locks all tabs and clears remembered keys. Each account keeps its encrypted cache and pending edits. Only the active account syncs. Previously downloaded accounts can unlock offline.

## Encryption and privacy

- PBKDF2-HMAC-SHA-256 uses 600,000 iterations and a random 16-byte salt to derive a 256-bit master secret. Passwords are not trimmed or normalized.
- HKDF-SHA-256 derives separate authentication and wrapping keys. Only the authentication credential travels over HTTPS. The server stores its Argon2id verifier. The credential is replayable, so TLS is required. This is not a PAKE protocol.
- A random 256-bit vault key encrypts complete tasks with AES-256-GCM, fresh 96-bit nonces and 128-bit authentication tags. Authenticated metadata binds the format, vault, task, edit time and operation ID.
- SQLite and IndexedDB store ciphertext and public sync metadata. Decrypted content stays in page memory. Workers never load decryption keys.

The server can see identifiers, sizes, edit times, timezone and traffic patterns. Background reminders also expose scheduling times, random tokens and device push subscriptions. Filenames, task contents and passwords remain encrypted or client-only.

This is a custom, unaudited implementation. A compromised host can serve JavaScript that captures a password or unlocked data. Encryption does not protect against that attack or a compromised browser or device. Existing plaintext backups and legacy browser data remain plaintext.

The app's Privacy notice explains local storage, cookies, push delivery and encryption limits. Operators must provide their contact details and their hosting, log and backup retention policies.

## Offline use and installation

Unlock online once and let the workspace and offline resources download. Task edits, archive actions, imports and exports work offline. Each write is encrypted before storage. Retries preserve operation IDs, timestamps and ciphertext.

Sync uses the most recent edit of the whole task, including deletion. Equal timestamps use operation IDs to break ties. Fields are not merged. Keep device clocks accurate. WebSockets announce changes, HTTP transfers ciphertext, and polling provides a fallback.

Session expiry preserves pending changes. Sign in again to sync. Browser eviction or clearing site data can lose unsynced work. Server backups contain only changes that reached the server. Reopen online to finish transfers when the browser suspends background work.

On iPhone or iPad, open the HTTPS site in Safari and choose Share, then Add to Home Screen. Open the installed app online once because it may have separate storage. On Android, use Install app in the browser or Taskpath menu.

## Background reminders

1. Set `TASKPATH_ORIGIN` to the public HTTPS origin. Keep the server running and allow outbound HTTPS to push services.
2. Unlock and choose Background reminders in workspace options, then Enable on this device. Grant notification permission on each device. iPhone and iPad require a Home Screen installation on iOS or iPadOS 16.4 or later.
3. Wait for reminder changes to sync before closing the app.

System notifications say "You have a reminder in Taskpath." They contain no task text or keys. Enabling a device shares scheduling metadata for that account. Offline changes cannot cancel a remotely queued notification until they sync.

The server keeps VAPID keys, subscriptions and schedules in SQLite. Back them up with the database. `TASKPATH_PUSH_SUBJECT` can supply a contact URL or `mailto:` address. VAPID keys cannot decrypt vaults.

Delivery depends on the browser, operating system and push provider. The scheduler checks every 15 seconds and supports up to 10 devices per account. Retries may repeat a delivery. After downtime, reminders more than 24 hours overdue remain in-app only. Turn off on this device removes its subscription. Turning off the last device removes server schedules. Locking retains subscriptions.

See the [notification setup and troubleshooting guide](DEPLOYMENT.md#enable-background-reminders).

## Files

Files supports multiple uploads, renaming, downloads and local previews of PNG, JPEG, WebP and GIF images. Other formats, including HTML and SVG, are download-only. There are no folders, sharing or task attachments. Deletion is permanent and wins over stale uploads or renames.

Each file has a random key wrapped by the vault key. Contents and metadata are encrypted before upload. Downloads cache ciphertext for offline use. Available offline means a download finished. Uploads, renames and deletions queue offline. Waiting for space retains the local upload so you can download or discard it. Keep originals until uploads sync.

`TASKPATH_FILE_QUOTA_MB` defaults to `10` per user. It accepts nonnegative whole numbers. One MB is 1,000,000 bytes of original contents. `0` blocks new uploads. Restart the server or recreate the container after changing it. Lower quotas never delete files or prevent reading, renaming or deleting existing files.

Each file is limited to 10 MB or the configured quota if lower. Accounts can hold up to 1,000 files. Offline deletion releases server quota after sync. Lock clears decrypted names and previews, but cannot remove copies downloaded outside Taskpath.

## Deploy and update

```sh
cp .env.example .env
# Set TASKPATH_ORIGIN and TASKPATH_TIMEZONE in .env.
docker compose up -d --build
docker compose exec taskpath bun run admin invite
```

Compose uses a persistent database volume and binds to `127.0.0.1:3000`. Keep that port private and use the [Nginx template](deploy/nginx/taskpath.conf.example) with valid HTTPS. It includes WebSocket forwarding and the file-upload limit. Follow the [deployment guide](DEPLOYMENT.md) for setup and backups. Never use the old username or password environment settings.

Existing multi-user installations keep their accounts and data. Plaintext and single-owner databases require the [fresh-start procedure](DEPLOYMENT.md#start-fresh-from-a-plaintext-or-single-owner-release). The app rejects them before modification.

To update, sync devices, rebuild and restart the server, then load the app online. Close all Taskpath tabs and installed-app windows before reopening. Do not clear site data. Automatic content fingerprints version client URLs and PWA caches. No manual `accounts-vN` bump is needed. README edits do not change the fingerprint.

## Development and checks

`bun run dev` watches TypeScript/TSX sources and bundles the React entry on demand, caching it by content fingerprint. It needs no preliminary build. Production serves `dist/public`. The build minifies client assets and bundles the app and worker separately to avoid import waterfalls. Rebuild after client changes. Production validates the build and snapshots it at startup.

Use `bun run dev:smol` or `bun run start:smol` for lower memory use with more frequent garbage collection. Docker accepts `TASKPATH_START_SCRIPT=start:smol`.

Client HTTP operations go through the typed adapters in `public/api.ts`; `public/api-client.ts` handles transport. UI and sync code pass domain data, while encryption and offline queues stay in their existing modules.

Drizzle uses `bun:sqlite`. Typed tables and repositories live in `src/db/`. Schema changes require explicit initialization code. Deployment does not run Drizzle Kit or automatic schema push.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run build
bun test
```

These commands reproduce the [GitHub Tests workflow](.github/workflows/tests.yml). CI runs on pushes, pull requests and manual dispatches with Bun 1.4.2 on Ubuntu 24.04. Bun executes TypeScript, but typecheck checks its types. Tests cover encryption, accounts, storage, sync, task behavior and WebSockets. Push tests use a fake sender. Source tests can run without a build. Build first to include production asset checks.

Run browser checks against separate disposable origins:

```sh
QA_ASSETS=source QA_PORT=3195 bun run tests/browser-server.ts
QA_ASSETS=built QA_PORT=3196 bun run tests/browser-server.ts
```

Open each printed `/checks` URL in a fresh browser context. These servers use isolated in-memory databases and create test data in browser storage. `/invitation` provides a setup fixture, `/phone-preview` provides a 390px view, `/picker-checks` runs React selector checks, and `/react-checks` exercises setup, login, task/file actions, drafts, lock and account switching through the React interface. Run `/checks` and `/react-checks` sequentially, with no other app tabs at that test origin. Browser UI, physical phones and real push delivery need separate verification.

See [React verification](docs/react-regression.md) for local results and environment limits.

Task sync uses protocol 2: initial downloads are paginated, then only changed encrypted records are fetched. Older clients must update before syncing; pending edits remain saved. Server restarts trigger a paginated rescan without clearing cached tasks. Exports wait until the download completes. Load the update online, close all tabs/PWA windows, then reopen; never clear site data. SQLite adds sync sequence metadata automatically, without rewriting existing encrypted records.

The frontend uses React/TypeScript feature components and Tailwind CSS 4 utilities. Tailwind maps semantic colors to the thirteen themes; the existing reset and complex responsive/picker CSS remain. Keep utility names as complete strings so the scanner can detect them. Development compiles CSS on demand from the same immutable source snapshot as JavaScript; production emits one minified stylesheet. `public/style.css` is the ordered stylesheet entry point; readable feature rules live in `public/ui/styles/` (themes, board, dialogs, pickers, files, mobile and more). Keep import order intact to preserve overrides. Imports resolve from the release snapshot into the same single CSS response, with automatic fingerprint updates. Tailwind's compiler and scanner are build-only dependencies. Docker uses a build stage and installs only production dependencies in its final image.
