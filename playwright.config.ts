import { defineConfig, devices } from "@playwright/test";

/**
 * E2E configuration.
 *
 * Credentials come from environment variables only — never committed, never
 * in browser code, and never a service-role key. Tests skip when absent so
 * CI without secrets stays green.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // Harness self-tests. No credentials, no live site — they verify the
    // test code itself and run first so a broken harness fails fast.
    {
      name: "harness",
      testDir: "./tests/harness",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testDir: "./tests/e2e",
      use: { ...devices["iPhone 13"] },
    },
    {
      name: "desktop",
      testDir: "./tests/e2e",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run dev", url: "http://localhost:5173", reuseExistingServer: true },
});
