# Taskpath

Invite-only task board with encrypted accounts, offline edits, reminders, and file attachments. Built with React, Bun, and SQLite.

Requires Bun 1.4.4+.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run dev
```

In another terminal, run `bun run admin invite`. Open the setup link within 24 hours and save your user ID; sign-in needs it and your password.

**There is no password reset or recovery key.** Encryption is custom and unaudited. Use HTTPS outside localhost, sync before clearing browser data, and keep file originals until uploads finish.

[Deployment, backups, and updates](DEPLOYMENT.md) · [Telegram admin bot](DEPLOYMENT.md#telegram-admin-bot)
