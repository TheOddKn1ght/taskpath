# Taskpath intent

Taskpath is an invite-only personal task board. It should keep daily planning usable while offline and keep task content encrypted outside the unlocked page. Local edits must survive a lost connection and remain available for synchronization.

This directory captures technical intent and constraints shared by the Bun server in `src/` and the browser in `public/`. It is a curated starting point, not a complete specification or an API reference. The initial notes describe the current implementation; extend them when a change introduces an important decision.

The main boundaries are the React UI and browser vault, the service worker and local persistence, and the server's authenticated storage of encrypted records. Shared browser modules also provide wire-format validation and pure projections to other runtimes. Avoid introducing page-only dependencies into those modules.

See the root [README](../../README.md) for setup, [AGENTS.md](../../AGENTS.md) for the contribution workflow, and [DEPLOYMENT.md](../../DEPLOYMENT.md) for operations. Regression records and operating guides remain in [docs/](../../docs/).

## File Index

- [data/encrypted-accounts.md](data/encrypted-accounts.md): account access, encryption boundaries, and recovery constraints.
- [features/offline-sync.md](features/offline-sync.md): local edits, encrypted synchronization, and time-based board projections.
- [features/files.md](features/files.md): encrypted attachments and separate upload state.
- [features/telegram-admin.md](features/telegram-admin.md): button navigation and account action screens in the admin chat.
- [features/time-tracking.md](features/time-tracking.md): optional timers, pause rules, encrypted persistence, and time statistics.
- [infrastructure/client-release.md](infrastructure/client-release.md): client build identity and service-worker update constraints.
- [infrastructure/routing.md](infrastructure/routing.md): shared route matching and server, offline, and navigation boundaries.
- [infrastructure/managed-updates.md](infrastructure/managed-updates.md): scoped Nginx reconciliation, validation, and host recovery.
