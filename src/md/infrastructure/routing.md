# Routing boundaries

Keep URL shapes in named route tables. The shared router matches literal path segments, named parameters, and a final wildcard without decoding or normalizing paths. Callers validate captured IDs; matching a route is not authorization. Exact paths take precedence over parameter and wildcard routes.

The HTTP server keeps its existing security order: origin and content-type checks, public endpoints and assets, account identity, then authenticated operations. Route lookup must not move private handlers before these guards or silently change GET/HEAD behavior. Assets still require the current release and explicit asset allowlist.

Offline task operations use their own named table because they run in the unlocked browser, not on the server. Match exact paths rather than loose prefixes. Parse export query parameters with URLSearchParams. Keep task ID validation separate from the path matcher.

Workspace hash navigation has one registry shared by parsing, hash-change handling, and sidebar labels. Preserve category, tag, and Today focus behavior. Unknown hashes fall back when opening the app but are ignored by the live workspace handler, so authentication fragments are not mistaken for navigation.

Key sources: `public/router.ts`, `public/ui/routes.ts`, `src/router.ts`, `src/server.ts`, and `public/offline-model.ts`.
