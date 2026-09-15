import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PW_PORT ?? 4178);

/**
 * Browser tests for the dashboard page (web/), against playwright/server.ts.
 * Run with `npm run test:ui`. Specs are *.e2e.ts so vitest's default
 * *.test.ts / *.spec.ts pattern never picks them up.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  outputDir: "./test-results",
  // One server holds the queued ops in memory; tests reset it, so run them one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx playwright/server.ts",
    cwd: "..",
    url: `http://localhost:${PORT}/index.html`,
    env: { PW_PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
