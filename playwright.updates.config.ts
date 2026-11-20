import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e-updates",
  outputDir: "test-results/desktop-updates",
  workers: 1,
  timeout: 120000,
  forbidOnly: !!process.env.CI,
  reporter: "list",
});
