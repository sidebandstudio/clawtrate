import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";

// One id per `pnpm e2e` run. Workers inherit it through the environment, and
// global setup names the run's dev gateway instance after it. Each run has its
// own output folder, so runs in the same checkout never delete each other's.
process.env.CLAWTRATE_E2E_RUN ??= randomBytes(4).toString("hex");

export default defineConfig({
  testDir: "e2e",
  outputDir: `test-results/${process.env.CLAWTRATE_E2E_RUN}`,
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
    // The app's own default, so a check that names no scheme sees what a new user sees.
    colorScheme: "dark",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
