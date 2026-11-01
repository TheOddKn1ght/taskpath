# Encrypted attachments

Attachments have a separate encrypted payload and transfer lifecycle from task records. Saving a task is not proof that its files have uploaded. The UI must expose pending or failed file transfers so users know when they still need the original file.

Keep file content and descriptive metadata encrypted in the browser. The server validates the encrypted file envelope, access, size, and quota without needing plaintext file content. Keep the shared file format usable by both browser and server.

Local file persistence and synchronization must preserve retryable work across connectivity failures. Changes to task sync must also account for pending attachments; clearing browser storage before synchronization can lose browser-only data.

Key sources: `public/file-format.ts`, `public/file-crypto.ts`, `public/file-persistence.ts`, `public/file-sync.ts`, `public/ui/files.tsx`, and `src/db/files.ts`. See `tests/files.test.ts` and the [file regression record](../../../docs/files-regression.md).

Administrators can persist a per-account quota override in decimal MB, including zero to block new uploads, or reset it to the configured server default. Read overrides on every manifest and upload so changes apply without a restart. Lowering a quota never deletes files or prevents downloads, renames, deletions, or identical upload retries. Keep the per-file limit and file-count limit independent of total quota. Store overrides as account-scoped settings so existing databases and full backups retain them without rewriting encrypted data.

Administrators can separately override the per-file limit in whole decimal MB or reset it to the 10 MB default. Zero blocks new uploads. The effective upload limit is the smaller of this setting and total quota. A 1,000 MB transfer ceiling bounds the current in-memory encryption and transfer path; reject larger administrator settings. Validate retained file manifests and downloads against that ceiling, not a newly lowered limit, so existing files remain accessible. Browser additions use the last synchronized allowance, including offline; server enforcement is authoritative.
