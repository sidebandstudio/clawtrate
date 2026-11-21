import { defineConfig } from "@playwright/test";

// The desktop app built from this checkout, started as Electron and driven over the
// DevTools protocol, for what only the desktop host does (e2e-desktop/).
export default defineConfig({
  testDir: "e2e-desktop",
  outputDir: "test-results/desktop-app",
  workers: 1,
  timeout: 120_000,
  forbidOnly: !!process.env.CI,
  reporter: "list",
});
