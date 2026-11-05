import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.pw.ts',
  timeout: 180_000,
  // Keep concurrency bounded for these stateful persistence harnesses. Each
  // harness requests fresh in-memory accounts, including across browser projects.
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
