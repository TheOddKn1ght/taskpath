# Encrypted accounts

Account access is invite-only. The user ID and password are both needed for sign-in. There is no password reset or recovery key, so account administration must not imply that an operator can recover vault content.

Password derivation happens in the page. The password derives separate authentication and encryption material; the server validates access and stores encrypted task envelopes rather than task plaintext. Wire-format validation is shared with the server through `public/crypto.ts`. Keep format validation strict so malformed or plaintext records cannot silently enter encrypted storage.

Encryption does not hide all metadata. The server needs account and record identifiers, revision information, and limited reminder scheduling data. Treat new server-visible fields as an explicit design decision. Do not send task text or file names merely to simplify a server feature.

Failed sign-ins are limited in memory per client and account (5 failures) and per client across all accounts (20 failures), each with a 15-minute lockout. The attempt table is bounded, so pruning must evict unlocked counters before active lockouts; otherwise cheap failures against random user IDs would reset a lockout. Distributed guessing across many addresses is not covered and relies on the slow client-side key derivation and random user IDs.

The encryption is custom and unaudited. Preserve that qualification in user-facing documentation. HTTPS is still required outside localhost.

Key sources: `public/crypto.ts`, `public/ui/auth.tsx`, `src/auth.ts`, `src/store.ts`, and `src/db/accounts.ts`. Whole-database backups preserve authentication state as well as encrypted data; see the [backup guide](../../../docs/database-backups.md).

HTTPS requests must use the host-prefixed session cookie even when TLS terminates at a proxy. Recheck the session after reading a private request body so revocation during transfer takes effect before the write. Direct connections use the socket peer for throttling. Only deployments explicitly configured behind a proxy that overwrites X-Real-IP may use that header. Invitation activation and issuance of the first session commit together so a temporary capacity limit cannot consume an invitation without completing sign-in. Pending password checks count toward admission limits, and the server bounds concurrent Argon2 work across accounts.

The live SQLite database and its sidecars contain credential verifiers, push secrets, and account data. Restrict these files to their owner when creating or reopening a supported database.
