# Database import and export

Run the admin command on the server, with the same `DATABASE_PATH` as the app.

```sh
DATABASE_PATH=./data/taskpath-accounts.sqlite bun run admin export ./backups/taskpath.sqlite
```

Export can run while the server is online. It produces a consistent SQLite
snapshot, including committed writes in the WAL. The backup contains all accounts,
encrypted tasks and attachments, settings, invitations, sessions, and push state.
It does not decrypt vault contents or export browser-only unsynced changes.

To restore, stop the server and choose a new database path:

```sh
DATABASE_PATH=./data/restored.sqlite bun run admin import ./backups/taskpath.sqlite
DATABASE_PATH=./data/restored.sqlite bun run start
```

Update the deployment's `DATABASE_PATH` to the restored path before restarting
its managed service. Keep the original database until the restore is verified.
Import restores the whole database; it does not merge accounts or tasks.

Both commands refuse existing destination files (even empty ones), symlinks,
and SQLite sidecars (`-wal`, `-shm`, `-journal`). They check database integrity and
the current encrypted Taskpath schema before publishing the result. Legacy,
plaintext, or incomplete schemas are rejected without migration. Interrupted
commands may leave a hidden `.taskpath-backup-*` staging directory; no incomplete
snapshot is published under the requested filename.

Output files have owner-only permissions (`0600`). Backups contain sensitive
authentication data and must be stored privately. Account vault passwords are
still needed to decrypt restored data. Restored sessions, invitations, and push
state are preserved as they were at export time; their normal expiry still applies.

Use a new backup filename for each export. `bun run admin --help` lists the commands.
