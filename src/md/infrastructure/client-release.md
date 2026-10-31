# Client releases

The page, its modules, and the service worker need a consistent client identity. Release fingerprints derive from relevant source content and build inputs. Rebuilding unchanged inputs should produce the same identity; documentation-only edits should not force a new client release.

Development assets and production assets have distinct release identities. Production builds stage compiled assets and publish a manifest that the server can validate. Missing or damaged build output must fail validation rather than serve a partial release.

The production app and service worker each bundle their runtime. Avoid duplicate offline state within the app when changing module loading. Individual module URLs also support the browser harness.

Worker updates must protect active sessions and pending offline work. The worker does not use `skipWaiting`. Cache cleanup completes during activation; a ready worker alone does not prove that old caches are gone.

Key sources: `scripts/build.ts`, `src/client-release.ts`, `src/client-assets.ts`, and `public/sw.ts`. See `tests/client-release.test.ts`, `tests/build.test.ts`, and the [release regression record](../../../docs/client-release-regression.md).
