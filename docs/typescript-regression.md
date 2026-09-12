# TypeScript migration verification

Verified locally on 2026-09-12, macOS, Bun 1.4.2, TypeScript 7.0.2. No deployment was performed. The calendar branch was not incorporated.

## Automated checks

| Check | Result |
| --- | --- |
| Strict no-emit Bun, browser and service-worker typechecks | Passed |
| Client build | Passed; 253.4 → 187.0 KiB across compactable assets, 26% smaller |
| Complete Bun suite | 80 passed, 0 failed; 916 assertions across 16 files; built-resource tests included |
| Workflow YAML | Parsed successfully; typecheck step added before build/tests |
| Source browser harness, fresh origin on port 3197 | 50/50 passed |
| Built browser harness, fresh origin on port 3198 | 50/50 passed |

The browser runs used the same TypeScript harness, separate origins and in-memory server databases, with disposable accounts. Earlier runs on ports 3195/3196 also passed 50/50 and supplied accounts for UI checks. The application database was not used.

Bun coverage includes cryptographic derivation/wrapping/tampering, invitation races, password changes and revoked sessions, account isolation, SQLite upgrade preservation and transaction rollback, task behavior, tags, Markdown, archive/Undo, reminder suppression and resumption, encrypted conflicts and immutable retries, and real HTTP/WebSocket connections. Push tests use a fake sender; no external delivery was attempted.

Browser coverage includes actual IndexedDB and non-extractable CryptoKeys, offline edits and unlock after memory clearing, reconnect, immutable encrypted retries, concurrent iframe edits, archive/restore conflicts, remembered-key restoration, cross-context Lock, encrypted worker transfers while locked, service-worker installation/static caching, expired sessions, nickname/account switching, and preservation of a legacy pending queue. Assertions inspect captured request bodies, IndexedDB workspace records, and text cache entries for distinctive test plaintext and persisted authentication credentials. This is regression coverage, not an independent security audit.

Build checks verify the module graph and exports, the shared offline module, CSP, complete PWA/theme assets, and absence of source maps or TypeScript/declaration files in output. Development HTTP checks verify `.js` output and reject direct `.ts`, declaration and server-source URLs. Vendored Marked source was not edited.

## Interactive Chromium checks

Source client: sign-in, remembered-device reload, task creation with notes and tag normalization, combined search/category/tag filters in the fragment, right-click menu, archive, Archive refresh with filters, restore, and native card dragging from Today to This Week. Desktop Gruvbox Dark rendering was inspected.

Built client: sign-in, Markdown preview/import with tags and completed tasks, batch archive and Undo, task editing, deletion and Undo, Markdown export action, Lock and an empty task DOM afterward. The password-change dialog and invitation/setup screen were inspected; the setup fragment was removed from the address bar. WebMCP task tools disappeared on Lock.

At a 390×844 browser viewport, checked the navigation drawer, Escape dismissal/focus return, task editor, and all seven themes: Light, Dark, Gruvbox Light/Dark, Nord, Catppuccin Mocha, and Rosé Pine Dawn. Theme selection and rendered layouts were inspected. Keyboard Enter added a tag; Escape dismissed the drawer. The viewport override was reset afterward.

## Limits and follow-up checks

- Safari/WebKit and physical iOS/Android devices were unavailable. A narrow Chromium viewport does not prove native touch gestures, installed-PWA lifecycle, or OS behavior.
- Password setup and change succeeded in protocol tests; their final UI submission was not automated. The browser tool requires user handoff before entering a new authentication credential. The dialogs themselves were checked.
- Offline network failure is simulated by the browser harness; it clears/reopens the in-memory vault on the same page. Remembered-device page reload was checked online. A real offline browser restart and OS storage eviction remain separate acceptance checks.
- Real WebSocket propagation is covered by Bun integration tests; browser concurrent-context checks use shared IndexedDB/broadcast notifications.
- The UI checks are representative acceptance checks, not an exhaustive scenario-by-theme-by-viewport matrix. Native touch dragging, full keyboard traversal and download-file inspection were not automated.
- No GitHub/Linux workflow run, Docker image build, physical-phone push delivery, or deployment was performed. The CI-equivalent local typecheck/build/test sequence passed.

## Reproduce

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run build
bun test
```

In separate terminals, open each printed `/checks` URL in a fresh test origin/context:

```sh
QA_ASSETS=source QA_PORT=3195 bun run tests/browser-server.ts
QA_ASSETS=built QA_PORT=3196 bun run tests/browser-server.ts
```

Use fresh disposable origins/accounts for reruns because the harness intentionally retains encrypted data to verify persistence. `/invitation` and `/phone-preview` support additional manual UI checks. Stop the temporary servers afterward.

## Rollout

Client assets and the PWA cache use `accounts-v13`; SQLite, IndexedDB names/versions, encryption metadata and pending operation identity remain unchanged. Synchronize every device, download the update online, close all Taskpath tabs/PWA windows, then reopen. Do not clear site data. Existing accounts do not need new invitations or passwords.
