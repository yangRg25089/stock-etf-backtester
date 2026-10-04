import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-live",
  workers: 1,
  reporter: "list",
  outputDir: "../.playwright-live-results",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "http://127.0.0.1:5175", browserName: "chromium", trace: "retain-on-failure" },
  webServer: [
    {
      command: "../backend/.venv/bin/python -m uvicorn app.main:app --app-dir ../backend --host 127.0.0.1 --port 8124",
      url: "http://127.0.0.1:8124/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5175 --strictPort",
      url: "http://127.0.0.1:5175",
      reuseExistingServer: false,
      timeout: 30_000,
      env: { BACKEND_API_URL: "http://127.0.0.1:8124" },
    },
  ],
});
