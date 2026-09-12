# Picker update regression — accounts-v14

Validated locally on September 12, 2026, using Bun 1.4.2. No deployment was performed.

| Check | Result |
| --- | --- |
| Strict TypeScript checks for Bun, browser and worker | Passed |
| Minified client build | Passed; 277.5 KiB → 203.0 KiB |
| Bun suite, including built-asset checks | 84 passed, 0 failed |
| Source client browser harness | 83 passed, 0 failed |
| Built client browser harness | 83 passed, 0 failed |

The browser harness ran in Chromium with disposable accounts and an in-memory server database. Its 50 persistence checks cover offline editing, immutable retries, encrypted storage, account isolation, concurrent contexts, locking, archive/Undo, reminder schedules, session expiry and service-worker transfers. Another 33 checks cover the new pickers: hidden native controls, accessible field labels, keyboard navigation, disabled options, refreshed choices, Escape above an editor, leap-date validation, Apply/Clear/Cancel, required reminder time, normalized tag creation, and cleanup after trigger removal, editor closure or Lock.

Picker geometry, 44px button heights and distinct palettes passed in all seven themes at 390×844 on the source client and 1280×720 on the built client. Geometry is measured after opening animations finish. Manual interface checks covered category filtering, creating tags, date validation, saving a reminder and reopening it in the 390px phone preview. The phone preview displayed the custom reminder bottom sheet in Gruvbox Dark.

To reproduce, run `bun run typecheck`, `bun run build`, then `bun test`. Start the browser harness separately for each asset mode:

```sh
QA_ASSETS=source QA_PORT=3195 bun run tests/browser-server.ts
QA_ASSETS=built QA_PORT=3196 bun run tests/browser-server.ts
```

Open each server's `/checks` URL in a fresh browser context. `/picker-checks` runs the component checks alone and can be repeated without changing the test accounts. Use disposable test origins, not the production site's storage.

Safari/WebKit, physical phones, OS keyboard resizing, real touch interaction, screen-reader announcements and a visual reduced-motion run were unavailable or not exercised. The viewport checks do not substitute for those device checks. Existing reminder conversion and unchanged-timestamp handling remain in use; this update does not change storage, encryption or sync formats.

## Mobile refinement

The follow-up layout was checked at 360×740 in Chromium against built assets: all 33 picker checks passed. The disposable `/picker-preview` page covers the empty tag filter and a populated list. Manual checks confirmed compact headings, 16px list padding, hidden search when only All tags exists, initial heading focus instead of the phone search input, and filtering/selecting a tag. Typecheck, minification and the seven targeted picker/build/asset tests passed. Actual OS keyboard behavior still needs a physical-device check.

## Time selection

The custom Hour/Minute lists expand the component harness to 40 checks. Added coverage verifies exact existing-minute selection, keyboard navigation, draft-only edits, Escape back to the calendar, Cancel, requiring both parts and midnight. The built client passed the desktop Chromium run; a 360px manual preview also checked the time view. Typecheck, build and the seven targeted Bun tests passed. The physical-device limitations above still apply.

## Combined reminder picker

Reminders now keep the calendar and time lists in one panel; due dates retain the calendar alone. The revised component harness has 42 checks, including changing the calendar day without losing the selected time and Escape cancelling the combined draft while keeping the task editor open. Desktop and 360px Chromium previews verified the side-by-side/stacked layouts and sticky action row. Typecheck, minification and the seven targeted Bun tests passed. Physical phones and Safari remain untested.

## Viewport centering — accounts-v15

Desktop centering now uses CSS instead of anchor-based positioning or measured offsets. A new geometry assertion brings the picker harness to 43 checks and verifies centering on desktop and bottom alignment on phones. The built Chromium desktop run passed; a separate rendered measurement confirmed center (640, 360) in a 1280×720 viewport. Asset URLs and the PWA shell cache move together to accounts-v15 to separate the fix from previously cached modules. Typecheck, build and the seven targeted Bun tests passed.
