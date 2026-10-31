# Offline edits and synchronization

The board must accept edits without a working connection. A rendered board combines the downloaded base with pending local changes. Projection must not mutate pending changes: those records are still needed for upload and reconciliation.

The server accepts encrypted changes scoped to the account's vault. A workspace mismatch must stop synchronization and retain local changes rather than uploading them into a different workspace. Acknowledgements identify changes; do not discard a newer local edit when an older edit is acknowledged.

Downloads are paged. Server cursors are signed and bound to the account and vault. They can expire, including after a server restart; recovery restarts the encrypted download rather than treating an invalid cursor as proof that local edits are disposable.

Calendar behavior uses the workspace timezone and server-time offset. A new day moves unfinished Today tasks back to Week; a new week moves old planned tasks to Later. An active reminder due today brings its task into Today. Keep these rules in the shared pure model so the page and worker agree.

Key sources: `public/offline.ts`, `public/offline-model.ts`, `public/persistence.ts`, `public/sw.ts`, `src/store.ts`, and `src/db/workspace.ts`. Relevant checks include `tests/sync.test.ts`, `tests/incremental-sync.test.ts`, and `tests/reminder-today.test.ts`.
