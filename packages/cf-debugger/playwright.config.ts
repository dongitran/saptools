import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 15 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] === undefined ? 0 : 1,
  outputDir: "test-results",
  reporter: process.env["CI"] === undefined
    ? [["list"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
});
