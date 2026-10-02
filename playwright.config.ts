import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.pw.ts',
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:3195', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'QA_ASSETS=built QA_PORT=3195 bun run tests/browser-server.ts',
    url: 'http://127.0.0.1:3195/test-account',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
