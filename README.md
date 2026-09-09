# Taskpath

An invite-only task board with a private encrypted vault for each person: collect in **Later**, plan **This Week**, and choose **Today**. Built with Bun 1.4.2+, SQLite, and plain HTML/CSS/JavaScript. Client minification uses Bun, with no package installation. The offline Markdown lexer is vendored Marked 18.0.12 (MIT).

## Start locally

```sh
bun run build
bun run start
```

In another terminal, create your own account (the owner uses the same invitation flow as friends):

```sh
bun run admin invite
```

The command prints a permanent user ID and a one-use setup link valid for **24 hours**. Open the link, choose and confirm a password of 15–1,024 characters, and optionally set a nickname. Save the user ID and password in your password manager. Future logins require **user ID + password**; nicknames never work as login IDs. HTTPS is required outside localhost.

Restarting the server never creates or replaces invitations. An administrator must explicitly issue one.

Use `bun run dev` for watch mode with readable client sources. `bun run build` minifies JavaScript (including the service worker and vendored lexer), CSS, HTML, and the web manifest into `dist/public`; compact SVG icons are trimmed and binary icons are copied unchanged. `bun run start` serves only that built client. Rebuild after updating client sources; Docker builds it automatically. No source maps or environment secrets are included. Optional `bun run start:smol` and `bun run dev:smol` enable Bun's `--smol` mode, trading more frequent garbage collection for lower memory use.

**This release requires a fresh multi-user database.** Both plaintext and single-owner encrypted databases are rejected before modification. Existing accounts are not migrated; no old files are deleted. See [deployment and upgrading](DEPLOYMENT.md).

## Appearance

Open the theme icon in the toolbar, or **Switch theme** on the sign-in screen. Choose Light, Dark, Gruvbox Light, Gruvbox Dark, Nord, Catppuccin Mocha, or Rosé Pine Dawn. **Follow system** switches between Light and Dark automatically. Preferences are saved for this browser, work offline, and apply across its Taskpath tabs and accounts.

Each theme has matching tab, notification, and install icons; dark palettes have a crescent detail. Choose your theme before installing the PWA. Already installed home-screen icons may stay unchanged until you reinstall, depending on the browser and OS. Close all Taskpath windows and reopen online to activate this update.

Views, menus, dialogs, the sidebar, and theme colors use brief, subtle transitions. Your system's reduced-motion preference disables them. Locking hides workspace content immediately.

Startup and task loading show a gentle indicator only if loading lasts long enough to need it. Unlocking and vault creation show progress in the button. Background sync keeps the existing board visible; loading never adds an artificial wait.

Palette references: [Gruvbox](https://github.com/morhetz/gruvbox), [Nord](https://www.nordtheme.com/docs/colors-and-palettes/), [Catppuccin](https://github.com/catppuccin/catppuccin), and [Rosé Pine](https://rosepinetheme.com/palette/). Taskpath icons are original artwork.

## Archive and navigation

Use **Board** and **Archive** in the sidebar. Collapse it to icons with its toggle; this preference stays in your browser. On phones, the navigation button opens a drawer. Archive uses `#archive` in the URL, so refreshing or opening a saved link returns there after unlocking. Board uses the normal URL; browser Back and Forward switch between views. Search, category, and tag filters also live in the fragment, for example `#archive?q=trip&category=personal&tag=travel`. They survive refresh/unlock and stay selected when switching views. Typing or changing filters updates the current history entry; switching views adds an entry for Back/Forward. Search remains entirely local: these values never become HTTP query parameters or API payloads. They are readable in the address bar, browser history, and links you copy.

Archive any task from its menu, right-click menu, or editor. **Workspace options → Archive all completed (N)** archives every completed task, regardless of filters. Archiving is manual: nothing is automatically archived or deleted. The Archive list is newest first and supports search, read-only details, Restore, and Delete. Restore a task before editing it.

Archived tasks retain their contents and previous column, disappear from the board, and pause reminders and calendar rollover. Restoring appends them to their previous column after normal rollover: an old Today task can return to This Week or Later; Done stays Done. Reminder dates and dismissal state are preserved, so an overdue, undismissed reminder may become due again after restoration. Deleting an archived task and undoing deletion keeps it archived.

The archive Undo toast restores only tasks that still match the archiving operation; subsequent changes from another tab or device are kept and reported as skipped. Archive and restore work offline using the existing encrypted sync queue. Server storage contains no readable archive state.

Full-workspace JSON and Markdown exports include archived tasks even when filters are active. Markdown records archive dates with nested `Archived: <ISO timestamp>` metadata beneath the original column heading. Imports preview and preserve that state; files without the field remain compatible. Duplicate detection distinguishes active and archived versions of a task.

Update all your devices before using Archive. Open online, close all Taskpath tabs and installed-app windows, then reopen to activate the new PWA shell. Existing vaults and encrypted pending operations are retained; no database migration is needed.

## Accounts and invitations

One private vault per account, with no shared boards, roles, public registration, or email service. User IDs are random permanent identifiers, not secrets. Each account has independent encryption keys, sessions, task storage, reminder claims, and WebSocket notifications.

```sh
bun run admin invite
bun run admin list
bun run admin reinvite USER_ID
bun run admin revoke USER_ID
bun run admin disable USER_ID
```

`reinvite` replaces a pending invitation and invalidates its previous link. `revoke` cancels a pending invitation. Neither can reopen an activated vault. `disable` stops server access and revokes that user's sessions while retaining encrypted data; existing WebSockets close at the next authorization check (within the heartbeat interval). Other users stay signed in. Disabling cannot erase downloaded data or revoke copied decryption keys. There is no password reset, recovery key, or account deletion command.

Send invitations privately: whoever claims a link first gets that pending account. Tokens are stored only as hashes, bound to one account, carried in URL fragments, and consumed atomically. The admin command uses the same `DATABASE_PATH` and `TASKPATH_ORIGIN` as the server; it can run while the server is online.

An optional nickname of up to 40 characters is encrypted inside the vault and appears in one of 120 randomized greetings after unlocking, such as “Good morning, Alex” or “Welcome to the night shift, Alex”. Greetings use the device’s local time and stay steady through sync and task edits, changing on a new unlock or time-of-day period. Change or clear it through **Workspace options → Nickname**; this works offline. Nicknames need not be unique and are never used for login.

One account is active per browser profile. **Switch account** locks all Taskpath tabs, clears remembered keys, and preserves each account's encrypted cache and pending edits separately. Returning to a previously downloaded account works offline with its user ID and password. Background sync transfers only the active account's ciphertext and refuses a mismatched server session.

## One password per vault, encrypted tasks

The same password signs in and unlocks the workspace. It is never sent to the server. There is no separate vault password, recovery key, password-reset endpoint, or administrator bypass. **The server cannot recover a forgotten password.** An already unlocked or remembered browser may still export readable tasks; otherwise the encrypted data is inaccessible.

By default, keys stay in memory and closing, reloading, or navigating away locks the page, including back/forward-cache restoration. There is no inactivity timer. **Remember this device** is off by default. Enabling it stores a non-extractable decryption key in IndexedDB: anyone using that browser profile may access your tasks. Non-extractable means the browser won't export the raw key; scripts with access to the key can still use it.

**Workspace options → Lock** clears remembered keys across this browser's tabs, removes decrypted content, and retains encrypted pending changes. Other devices remain unlocked. Lock does not end the server session: a background worker may continue transferring ciphertext, without loading a decryption key.

**Change password** requires the current password and an online connection. It rewraps the existing data key, leaving task ciphertext intact, and revokes all existing server sessions. The changing page receives a fresh session; other devices sign in again to resume syncing. Previously copied decryption keys cannot be revoked. A device kept offline may still unlock its cached copy with the old password until it signs in with the new one.

## Encryption design and limits

- PBKDF2-HMAC-SHA-256, 600,000 iterations, a random 16-byte salt, and a 256-bit master secret. Password contents are exact: no trimming or Unicode normalization.
- HKDF-SHA-256 separates authentication and vault-wrapping purposes with versioned labels. Only the derived authentication credential is sent over HTTPS; the server stores its Argon2id verifier. This credential is a replayable login secret, and this design depends on TLS. It is not a PAKE.
- A random 256-bit vault key is wrapped with the password-derived key. Complete tasks, including titles, notes, tags, dates, planning fields, and tombstones, use AES-256-GCM with a fresh random 96-bit nonce and 128-bit authentication tag. Additional authenticated data binds the format version, vault identity, task identity, edit timestamp, and operation identity.
- SQLite and the new `taskpath-accounts-v1` browser database store ciphertext and public wrapping/sync metadata. Decrypted tasks remain in page memory. The worker never reads the separate remembered-key store.

The server can still see task identifiers, edit times, ciphertext sizes, traffic patterns, timezone, and opaque reminder-claim activity. It cannot validate encrypted task contents or schedule reminders. Existing plaintext backups and legacy browser data remain plaintext. Exported Markdown/JSON is deliberately readable and should be protected accordingly.

This is a custom, unaudited implementation using standard Web Crypto primitives. A compromised host could serve malicious JavaScript that captures an entered password or unlocked data. HTTPS and E2EE do not protect against that active host attack or a compromised browser/device. Use a strong generated password, keep the host updated, and retain secure backups.

Reference: [Web Crypto derivation APIs](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey).

## Offline use and phone installation

Unlock online once and allow the board and offline shell to download. Edits, moves, completion, deletion/undo, tags, dates, snoozing, Markdown previews/imports, and readable exports work offline. Each change is encrypted before IndexedDB commits; retries reuse the same operation ID, timestamp, nonce, and ciphertext. Concurrent tabs serialize writes and use revision checks to avoid losing edits.

Reconnection transfers encrypted batches. The most recent edit wins for the **whole task**, including deletion; equal edit times use operation IDs as a stable tie-break. Field changes aren't merged. Keep device clocks accurate. WebSockets announce changes; authenticated HTTP handles ciphertext transfer, with polling as fallback. Background activity is limited by the browser, especially on iOS: reopen the app online to finish syncing.

Expired sessions show **Sign in to sync** and retain pending changes. Enter the same password again. Clearing site data or browser eviction can remove unsynced work; sync regularly. Browser storage and SQLite are separate copies, so server backups only contain changes already synced.

- iPhone/iPad: open the HTTPS site in Safari, then **Share → Add to Home Screen**. Open the installed app online once; its storage may be separate.
- Android: use the browser's **Install app** action or Taskpath's install menu item.
- Updates: open online, close **all** Taskpath tabs and installed-app windows, then reopen. Both asset URLs and the PWA cache are versioned to avoid mixing application generations.

## Planning, tags, and reminders

Drag tasks between columns or use each card's move control. Native context menus provide task actions. At local midnight, unfinished Today tasks return to This Week; on Monday, weekly tasks return to Later. The browser calculates rollover in the workspace timezone. Done stays Done.

Tasks support up to 10 tags of up to 32 Unicode characters each. Tag names are trimmed, normalized, lowercase, deduplicated, and sorted. Type a tag and press Enter or choose a suggestion. Cards show two muted labels and a `+N` editor button. Combine one tag filter with category and text search; quick-add inherits the selected tag. Tags survive offline operations and Markdown/JSON exports.

Dates and reminder times are encrypted. Keep the workspace **open and unlocked** for reminders. In-app reminders remain until dismissed; desktop notifications need browser permission and a connection to claim a reminder. An authenticated, atomic claim of an opaque random token prevents repeated desktop alerts across devices. Snoozing or rescheduling generates a new token. Closed or locked apps cannot schedule plaintext notifications.

## Markdown and JSON

Import Markdown from the workspace menu. Parsing and preview run offline through the locally vendored [Marked lexer](public/vendor/README.md); imported HTML is never rendered. Headings Later, This Week, Today, and Done select columns. Checked items go to Done; nested checklists become separate tasks. Code examples and quoted checklists outside tasks are ignored. Notes and link destinations are preserved as text.

```markdown
## This Week
- [ ] Buy groceries
  - Category: Personal
  - Tags: ["errands", "home"]
  - Due: 2026-09-10
  - Reminder: 2026-09-10T09:00:00.000Z
```

Imports accept up to 500 tasks / 256 KB, validate before committing, and skip duplicates including normalized tags. Markdown without tags remains compatible. Exports include current unlocked tasks and unsynced edits. JSON is a readable snapshot; Markdown is the supported import format. Deleted tasks remain encrypted tombstones for synchronization, and aren't in readable exports.

## Docker and VPS

```sh
cp .env.example .env
# Set TASKPATH_ORIGIN and TASKPATH_TIMEZONE for your deployment.
docker compose up -d --build
docker compose logs taskpath
```

Compose binds to `127.0.0.1:3000` and uses a new `taskpath-accounts-data` volume. Set `TASKPATH_START_SCRIPT=start:smol` for optional reduced-memory mode. Authentication is mandatory; remove old `TASKPATH_USERNAME`, `TASKPATH_PASSWORD`, and `TASKPATH_PASSWORD_HASH` settings. Create invitations with `docker compose exec taskpath bun run admin invite`; recipients choose passwords in their browsers.

For public access, use the included [Nginx template](deploy/nginx/taskpath.conf.example), valid HTTPS, `TASKPATH_ORIGIN=https://your-domain`, and cookie/Origin forwarding. Keep the application port private. Existing WebSocket and 2 MB sync proxy configuration works with encryption; no new Nginx directives are required. See the [step-by-step VPS guide](DEPLOYMENT.md).

## Verification and GitHub CI

```sh
bun test
```

Tests use isolated databases and cover derivation separation, wrapping, tampering, record substitution, invitation expiry/races, account isolation, nicknames, sessions, password changes, legacy database refusal, encrypted persistence, conflicts, tags, Markdown, rollover, reminder tokens, and real WebSocket connections. Source tests need no build. Run `bun run build` before `bun test` to also verify the minified module graph and served assets. That check is skipped if the build is absent or belongs to an older asset version.

For real browser IndexedDB, account-switching, and concurrent-context checks, run `bun run tests/browser-server.ts` and open the printed `/checks` URL in a fresh browser context. It uses a temporary in-memory server workspace on a separate port, never the application's database. Its checks create disposable browser data on that origin. UI acceptance checks are separate from Bun tests.

The [Tests workflow](.github/workflows/tests.yml) runs on pushes, pull requests, and manual GitHub dispatches. It builds the minified client before testing and uses Ubuntu 24.04 and Bun 1.4.2, a five-minute timeout, read-only permissions, and cancellation of superseded runs. Run `bun run build` followed by `bun test` with Bun 1.4.2 to reproduce the CI command locally. Linux/GitHub execution is confirmed by a GitHub run, not by local macOS tests.
