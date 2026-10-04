import { defineConfig } from "@playwright/test";

const apiPort = process.env.BACKTESTER_E2E_API_PORT ?? "8123";
const frontendPort = process.env.BACKTESTER_E2E_FRONTEND_PORT ?? "5174";

export default defineConfig({
  testDir: "./e2e",
  // Browser tests share the same in-memory fixture API and active jobs.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "../.playwright-results",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "../backend/.venv/bin/python ../backend/tests/e2e/serve_api.py",
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { BACKTESTER_E2E_API_PORT: apiPort },
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${frontendPort}`,
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { BACKEND_API_URL: `http://127.0.0.1:${apiPort}` },
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
