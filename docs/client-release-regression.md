# Automatic client fingerprints

Verified locally on September 15, 2026. No deployment was performed.

- Typecheck: passed for server, browser and worker.
- Two consecutive production builds: identical release IDs and byte-identical manifests.
- Bun suite: 94 passed, 0 failed; 1,123 assertions across 19 files, including built-asset checks.
- Chromium source harness: 126 checks passed.
- Chromium built harness: 126 checks passed.

Targeted checks cover deterministic path/content hashing, distinct source/built IDs, toolchain and configuration changes, README/declaration exclusion, unchanged-content rewrites, complete placeholder substitution, inaccessible internal manifests, stale URL rejection, immutable asset snapshots, and damaged/incomplete build rejection.

Browser checks confirm that the generated service-worker cache installs, numbered caches are removed after activation completes, and account storage, encrypted pending edits, files and offline synchronization continue working. The test waits for the worker's `activated` state because `navigator.serviceWorker.ready` can resolve before activation cleanup finishes. The worker still does not use `skipWaiting`.

Docker's build context now includes the TypeScript configuration files used by fingerprinting. A Docker image build, Safari/WebKit, physical devices and real suspended-background execution were not tested in this run. The existing browser harness used isolated disposable accounts and databases.
