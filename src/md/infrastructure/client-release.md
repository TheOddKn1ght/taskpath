# Client releases

The page, its modules, and the service worker need a consistent client identity. Release fingerprints derive from relevant source content and build inputs. Rebuilding unchanged inputs should produce the same identity; documentation-only edits should not force a new client release.

Development assets and production assets have distinct release identities. Production builds stage compiled assets and publish a manifest that the server can validate. Missing or damaged build output must fail validation rather than serve a partial release.

The production app and service worker each bundle their runtime. Avoid duplicate offline state within the app when changing module loading. Individual module URLs also support the browser harness.

Docker build and runtime stages use the official Debian slim Bun image, pinned to the same Bun version. Prefer its glibc runtime over Alpine's musl despite the larger image. Install dependencies inside each stage from the frozen lockfile so native packages match the target platform. Run the build and server as the existing `bun` user (UID/GID 1000) and keep `/app/data` writable for existing volumes. The image runs the application without an SSH daemon. Backup helper containers use Debian slim as well.

Worker updates must protect active sessions and pending offline work. The worker does not use `skipWaiting`. Cache cleanup completes during activation; a ready worker alone does not prove that old caches are gone.

Key sources: `scripts/build.ts`, `src/client-release.ts`, `src/client-assets.ts`, and `public/sw.ts`. See `tests/client-release.test.ts`, `tests/build.test.ts`, and the [release regression record](../../../docs/client-release-regression.md).

CI runs automatically for changes to application code, assets, tests, scripts, deployment inputs, dependencies, or build and test configuration. Intent notes and other Markdown-only changes do not need the test suite. Keep manual workflow dispatch available for an explicit full run. Update the workflow path filters when introducing a new source or configuration location.
