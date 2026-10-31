# Encrypted accounts

Account access is invite-only. The user ID and password are both needed for sign-in. There is no password reset or recovery key, so account administration must not imply that an operator can recover vault content.

Password derivation happens in the page. The password derives separate authentication and encryption material; the server validates access and stores encrypted task envelopes rather than task plaintext. Wire-format validation is shared with the server through `public/crypto.ts`. Keep format validation strict so malformed or plaintext records cannot silently enter encrypted storage.

Encryption does not hide all metadata. The server needs account and record identifiers, revision information, and limited reminder scheduling data. Treat new server-visible fields as an explicit design decision. Do not send task text or file names merely to simplify a server feature.

The encryption is custom and unaudited. Preserve that qualification in user-facing documentation. HTTPS is still required outside localhost.

Key sources: `public/crypto.ts`, `public/ui/auth.tsx`, `src/auth.ts`, `src/store.ts`, and `src/db/accounts.ts`. Whole-database backups preserve authentication state as well as encrypted data; see the [backup guide](../../../docs/database-backups.md).
