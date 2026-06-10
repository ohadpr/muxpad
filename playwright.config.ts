import { defineConfig } from '@playwright/test';

const webPort = Number(process.env.MUXPAD_E2E_WEB_PORT ?? 5188);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  retries: 0,
  repeatEach: 3,
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'node e2e/run-stack.mjs',
    port: webPort,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
