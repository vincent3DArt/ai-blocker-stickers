import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/e2e/serve-fixtures.mjs',
    url: 'http://127.0.0.1:4173/static.html',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
