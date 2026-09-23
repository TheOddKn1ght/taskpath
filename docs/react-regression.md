# React frontend verification

Branch: `react-rewrite`. Verified locally on macOS with Bun 1.4.2 and Chromium.

The frontend uses React 19.3.0 and strict TypeScript/TSX, with one application root. The encrypted task/file models, storage and sync modules are unchanged. React subscribes through a stable `useSyncExternalStore` adapter; form drafts remain component-local. Lock unmounts private views and clears the adapter immediately. Development bundles the application on request from a fingerprinted source snapshot. Production emits a minified app bundle and a separate worker without React.

## Results

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed: server, browser/TSX and worker |
| `bun run build` | Passed; automatic content fingerprint |
| `bun test` | 99 passed, 0 failed; 1,061 assertions across 20 files |
| Source browser `/checks` | 131 passed |
| Built browser `/checks` | 131 passed |
| Source React UI fixture, 800px | 50 passed |
| Production React UI fixture, 1280px | 50 passed |
| Production React UI fixture, 390px | 52 passed |

The existing harness covers encrypted persistence and immutable retries, offline editing and reconnect, account isolation, concurrent contexts, conflicts, expiry, remembered keys, lock propagation, service-worker caching and ciphertext-only worker transfers. Bun tests include real WebSocket connections and push delivery through a test sender.

The new React fixture covers invitation setup, failed and successful login, password changes, account switching, all seven theme selections, board order, editor draft/focus/selection/scroll preservation during refresh, task CRUD, tags and filters, fragment history, quick-add inheritance, drag events, archive/delete Undo, Markdown preview/import, both exports, file upload/rename/download/delete, decoded image previews and Blob URL revocation. It also checks offline edits, reconnect and immediate removal of private views on lock. Requests and stored workspace records are checked for distinctive plaintext and passwords.

Picker checks now mount the actual React components instead of the removed imperative implementation. They retain calendar/time/tag validation, draft Apply/Clear/Cancel, keyboard navigation, theme geometry, focus restoration and lock cleanup coverage.

The UI fixture bundles the same public TSX components with development or production flags. The separate `/checks` harness loads source or built service modules. The actual `dist/public/app.js` was also checked through sign-in, the phone board, task editing and the disabled Later/This Week choices for today's reminders. Its mobile filters, bottom tabs and floating add button were inspected visually.

## Reproduce

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run build
bun test
```

Run one harness at a time, using disposable origins with no other Taskpath tabs open:

```sh
QA_ASSETS=source QA_PORT=3195 bun run tests/browser-server.ts
QA_ASSETS=built QA_PORT=3196 bun run tests/browser-server.ts
```

Open `/checks`, wait for its final result, then use `/react-layout?width=1280`, `/react-layout?width=800` or `/react-layout?width=390`. Each React run gets a new disposable invitation. `/picker-checks` runs selector checks alone. Test servers use in-memory databases; they never open the deployment database.

## Limits and update

Safari/WebKit, physical phones, real touch dragging, OS keyboard resizing, screen-reader output, a real offline browser restart and suspended-background execution were not verified. Offline failures are simulated in the harness. Reduced-motion CSS and guards are retained; the OS preference was not changed for a visual run. Real push delivery, Docker, GitHub/Linux execution and deployment were not performed.

No SQLite or IndexedDB migration, account reset, encryption-format change or pending-operation rewrite is required. Sync devices, load the update online, close all Taskpath tabs/PWA windows, then reopen. Do not clear site data.
