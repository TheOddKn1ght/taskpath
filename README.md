# Taskpath

An invite-only task board with a separate encrypted vault for each account. Plan tasks in **Today**, **This Week**, and **Later**; completed tasks stay in **Done**.

Built with Bun 1.4.2+, TypeScript, React, and SQLite. Supports offline edits, search, tags, reminders, archiving, Markdown import, Markdown/JSON export, and encrypted files.

## Run locally

```sh
bun install --frozen-lockfile --ignore-scripts
bun run dev
```

In another terminal, create an account:

```sh
bun run admin invite
```

Open the one-use setup link within 24 hours, choose a password, and save your permanent user ID. Sign-in requires the ID and password.

For a disposable workspace without manual setup, run `bun run qa`. It uses a local in-memory database; exiting discards server data.

## Using the board

- Drag tasks between columns or use their menus. Unfinished Today tasks return to This Week at midnight; weekly tasks return to Later on Monday, using the workspace timezone.
- A reminder dated today moves an unfinished task into Today. Notifications wait until its scheduled time.
- Press `N` for a new task or `/` to search active and archived tasks. Use workspace options for import, export, password changes, automatic locking, and background reminders.
- Sync before closing or updating. Clearing browser data can lose unsynced work. Files are excluded from task exports; keep originals until uploads sync.

## Accounts and privacy

Passwords and task/file contents are encrypted or client-only. The server stores ciphertext and sees sync metadata; background reminders also expose scheduling metadata. This is a custom, unaudited implementation, and a compromised host or browser can capture unlocked data.

**There is no password reset or recovery key. A forgotten password cannot be recovered.** Remembering a device allows access through that browser profile. Use HTTPS outside localhost.

```sh
bun run admin list
bun run admin reinvite USER_ID
bun run admin revoke USER_ID
bun run admin disable USER_ID
```

Admin commands must use the server's `DATABASE_PATH` and `TASKPATH_ORIGIN`. Send invitation links privately.

## Deployment and development

See the [deployment guide](DEPLOYMENT.md) for Docker, HTTPS, backups, updates, migration requirements, and [background reminders](DEPLOYMENT.md#enable-background-reminders). After updating, open online, close all Taskpath tabs/app windows, and reopen without clearing site data.

```sh
bun run typecheck
bun test
bun run build
bun run start
```

The build is required for production. Dependencies use a frozen lockfile and a 14-day minimum release age.

See [React verification](docs/react-regression.md), the [CI workflow](.github/workflows/tests.yml), and [vendored Markdown tooling](public/vendor/README.md) for further details. Browser checks: install Chromium with `bunx --no-install playwright install chromium`, then run `bun run test:browser` after building.
