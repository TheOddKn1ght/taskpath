# Encrypted files regression — accounts-v17

Verified on September 15, 2026, using disposable local accounts and databases. No deployment was performed.

- `deno task typecheck`: passed (Bun, browser, worker).
- `deno task build`: passed; minified client 230.7 KiB.
- `deno task test`: 91 passed, 0 failed, 1,067 assertions across 18 files, including built-asset checks.
- Chromium source browser harness: 124 checks passed.
- Chromium built browser harness: 124 checks passed using the same scenarios.

The added automated checks cover file cryptography and tampering, account binding, quota configuration and boundaries, reductions and disabled uploads, retry accounting, immutable contents, deletion tombstones, metadata conflicts, interrupted uploads, additive SQLite/IndexedDB upgrades, unchanged task queues, offline operations, storage transaction rollback, concurrent browser contexts, expired sessions, real WebSocket notifications and locked worker ciphertext downloads.

Manual Chromium UI checks covered multiple-file upload through the file chooser, synced/offline availability labels, local filename search, renaming, PNG signature-checked Blob preview, preview dimensions, seven theme palettes, desktop overflow, a 390×844 phone viewport, and clearing file names/rows/previews on Lock. These checks used synthetic PNG/text files. Task exports remain task-only.

Not verified: Safari/WebKit, physical phones and their virtual keyboards, OS-level drag-and-drop, actual browser eviction, suspended/background service-worker scheduling, and real push delivery. Worker execution was exercised directly in the harness; it does not prove that an OS will wake a suspended PWA. Browser storage failure was simulated by an aborted quota-error transaction, not by exhausting the machine's disk. Exact pixel review of every theme at every viewport was not performed.

To repeat, run the browser server on separate fresh origins for source and built modes as documented in README. Never use production accounts or clear production site data for these checks.
