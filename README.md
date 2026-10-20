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

For a disposable workspace without manual setup, run `bun run qa`. It uses a local in-memory database seeded with sample tasks and files; exiting discards server data.

## Desktop app (Electron)

The desktop client connects to an existing Taskpath server. Run `bun run dev`
in a separate terminal for local use. It does not bundle or start the Bun server.
Install Node.js 22+ as well as Bun for Electron's tooling, then:

```sh
cd desktop
bun install --frozen-lockfile --ignore-scripts
bun node_modules/electron/install.js
cd ..
bun run desktop
```

By default it opens `http://localhost:3000`. To connect to your hosted server:

```sh
TASKPATH_DESKTOP_URL=https://tasks.example.com bun run desktop
```

Only HTTPS and HTTP loopback server origins are accepted. The app keeps login
and offline data in Electron's own persistent profile, separate from your browser.
To set up an account, copy your invitation link and choose File → Open Copied
Invitation Link; the link must belong to the configured server. Existing users
can sign in normally.

`bun run desktop:package` creates an unpacked app; `bun run desktop:dist` creates
an AppImage on Linux, a DMG on macOS, or an NSIS installer on Windows under
`desktop/out/`. Build on the target OS with Node.js 22+ available. These builds
are unsigned; signing and automatic updates are not configured. Packaged apps
connect to `https://taskpath.oddknight.space` by default; `TASKPATH_DESKTOP_URL`
can override it. Development launches still default to localhost.

The [desktop CI workflow](.github/workflows/desktop.yml) builds Linux x64
AppImages, Windows x64 installers, and macOS DMGs for both Intel and Apple
Silicon on pushes, pull requests, and manual runs. Download installers from
the run's `taskpath-*` artifacts (retained for 14 days). Installers remain unsigned.

To publish a desktop release, set the version in `desktop/package.json`, update
`desktop/bun.lock` with `bun install --cwd desktop --ignore-scripts`, commit the
changes, then push a matching version tag (for example, `v1.0.0`). Once all four
builds succeed, CI creates a GitHub Release with generated notes and attaches
the installers. Tags containing a hyphen (such as `v1.1.0-beta.1`) create
prereleases. Ordinary branch and pull request builds only upload CI artifacts.
You can rerun the workflow on a version tag to retry publication; existing
release assets with the same names are replaced.

The renderer is sandboxed with no Node.js access. External links require
confirmation before opening in your browser. Background reminders while the app
is closed still depend on the existing web push setup and platform support.

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

See [React verification](docs/react-regression.md), the [CI workflow](.github/workflows/tests.yml), and [vendored Markdown tooling](public/vendor/README.md) for further details. Browser checks: install the engines with `bunx --no-install playwright install chromium firefox webkit`, build, then run `bun run test:browser` (or one engine with `bun run test:browser -- --project=firefox`). CI runs each engine as a separate job; only Chromium blocks merges.
