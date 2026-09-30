import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { WEBMCP_CHROME_ARGS } from "./webmcpAgent.js";

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
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: "**/*.chrome.e2e.ts" },
    // Stable Chromium has no WebMCP, so the specs that need the browser's real
    // implementation (*.chrome.e2e.ts) run on an installed Google Chrome, 152 or
    // later, with it switched on. Left out where there is no Chrome to launch,
    // rather than failing; PW_CHROME=0 leaves it out on purpose.
    ...(hasChrome()
      ? [
          {
            name: "chrome-webmcp",
            testMatch: "**/*.chrome.e2e.ts",
            use: { ...devices["Desktop Chrome"], channel: "chrome", launchOptions: { args: WEBMCP_CHROME_ARGS } },
          },
        ]
      : []),
  ],
  webServer: {
    command: "npx tsx playwright/server.ts",
    cwd: "..",
    url: `http://localhost:${PORT}/index.html`,
    env: { PW_PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});

function hasChrome(): boolean {
  if (process.env.PW_CHROME === "0") return false;
  const candidates = [
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  return candidates.some((path) => existsSync(path));
}
