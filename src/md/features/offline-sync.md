# Offline edits and synchronization

The board must accept edits without a working connection. A rendered board combines the downloaded base with pending local changes. Projection must not mutate pending changes: those records are still needed for upload and reconciliation.

The server accepts encrypted changes scoped to the account's vault. A workspace mismatch must stop synchronization and retain local changes rather than uploading them into a different workspace. Acknowledgements identify changes; do not discard a newer local edit when an older edit is acknowledged.

Downloads are paged. Server cursors are signed and bound to the account and vault. They can expire, including after a server restart; recovery restarts the encrypted download rather than treating an invalid cursor as proof that local edits are disposable.

Calendar behavior uses the workspace timezone and server-time offset. A new day moves unfinished Today tasks back to Week; a new week moves old planned tasks to Later. An active reminder due today brings its task into Today. Keep these rules in the shared pure model so the page and worker agree.

Due dates and reminders are independent. The editor must allow a reminder without a due date, and clearing a due date must preserve the reminder. The explicit Clear dates action clears both.

Due reminders offer snoozes of 5, 10, or 30 minutes, 1 or 3 hours, and 24 hours, with 10 minutes selected initially. Durations start at the action time (using the server-time offset), not the old reminder time; 24 hours is an elapsed duration rather than a calendar-day shortcut. Snoozing works offline, preserves task details, and rearms delivery with a new reminder token. Unsupported durations are rejected; callers that omit the duration retain the 10-minute default.

The snooze duration chooser uses the app's styled action menu instead of a native select. Its trigger shows the current duration, and the menu marks the selected choice. Choosing a duration only updates that reminder's selection; the separate Snooze action applies it. Preserve keyboard navigation, focus restoration, outside dismissal, and disabled controls while busy.

Overlapping UI refreshes share a pending result and repeat the board read when another refresh arrives. A save must wait for those reads to finish before reporting completion, so immediately reopening a task cannot capture an older board snapshot.

Key sources: `public/offline.ts`, `public/offline-model.ts`, `public/persistence.ts`, `public/sw.ts`, `src/store.ts`, and `src/db/workspace.ts`. Relevant checks include `tests/sync.test.ts`, `tests/incremental-sync.test.ts`, and `tests/reminder-today.test.ts`.
