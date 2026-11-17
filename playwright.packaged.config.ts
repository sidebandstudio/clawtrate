// The launch check for the packaged desktop app (`pnpm check:packaged`), after
// `pnpm package:mac`. Global setup starts this run's own development gateway
// instance and the packaged app with a temporary data folder; the tests drive
// the app's window over the Chrome DevTools protocol.
import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

process.env.CLAWTRATE_E2E_RUN ??= randomBytes(4).toString("hex");

export default defineConfig({
  testDir: "e2e-packaged",
  outputDir: `test-results/packaged-${process.env.CLAWTRATE_E2E_RUN}`,
  globalSetup: "./e2e-packaged/global-setup.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
