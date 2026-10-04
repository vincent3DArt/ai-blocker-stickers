import { defineConfig } from '@playwright/test';

// FIXTURES_PORT lets a second checkout run its suite next to the first (build with the same value).
const PORT = process.env.FIXTURES_PORT ?? '4173';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/e2e/serve-fixtures.mjs',
    url: `http://127.0.0.1:${PORT}/static.html`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
