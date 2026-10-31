# Working on Taskpath

Read [src/md/README.md](src/md/README.md) first, then the intent files relevant to the change. This applies to both server code in `src/` and browser code in `public/`.

## Intent before implementation

- For a behavior or design change, capture the intended result and important tradeoffs in `src/md/` before changing code. Keep the intent, code, and relevant tests consistent in the same change.
- For a bug fix, use the existing intent where it is clear. Update it when the fix reveals a missing rule or subtle constraint. Do not create a document for every small edit.
- Record reasons and constraints, not a transcript of prompts or a description of every function. Use short, direct technical English. Distinguish proposed behavior from behavior already implemented; do not invent historical reasons.
- Keep `src/md/README.md` as the entry point. Its `## File Index` must link every other Markdown file under `src/md/`, using paths relative to that directory and one link plus a brief description per line.
- Keep setup, deployment instructions, regression reports, and work plans outside `src/md/`. Link to them when useful. Use the ignored root `tmp/` directory for temporary plans.

## Repository map

- `src/`: Bun HTTP server, authentication, administration, notifications, and SQLite repositories.
- `public/`: browser TypeScript, React UI, service worker, shared models, and assets. Some modules are imported by the server; preserve their runtime boundaries.
- `scripts/build.ts`: production client build. `dist/` is generated output.
- `tests/`: Bun tests and Playwright browser harnesses.
- `docs/` and `DEPLOYMENT.md`: reference material and operating instructions.

## Implementation and validation

Use Bun (see `package.json` for the required version and commands). Preserve the existing encrypted protocol, account isolation, and unsynced local data when changing persistence or synchronization. Read the relevant intent before changing these boundaries.

Choose checks that cover the change. For code changes, run `bun run format:check`, `bun run typecheck`, and relevant Bun tests (`bun test tests/<name>.test.ts`). Run `bun run build` for client or build changes. Use `bun run test:browser` for browser interactions, service-worker behavior, or offline flows; see `playwright.config.ts` for harness configuration. Report checks run and any limits. For documentation-only changes, check links and the file index; code tests are not required.
