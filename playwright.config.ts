import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.pw.ts',
  timeout: 180_000,
  // Deliberate: the harnesses sign in to one shared in-memory account and
  // mutate it, so parallel workers would race. CI parallelizes this suite by
  // running it alongside the unit suite instead, not by raising `workers`.
  workers: 1,
  fullyParallel: false,
  // Same suite against every engine; CI runs one job per project.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  use: { baseURL: 'http://127.0.0.1:3195', trace: 'retain-on-failure' },
  webServer: {
    command: 'QA_ASSETS=built QA_PORT=3195 bun run tests/browser-server.ts',
    url: 'http://127.0.0.1:3195/test-account',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
