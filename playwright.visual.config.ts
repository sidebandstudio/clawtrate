// The visual tests: the interface in its fixture mode, with no gateway. They
// build the fixture (apps/desktop/vite.fixture.config.ts), serve it on a
// loopback port, and compare screenshots with baselines committed under
// visual/baselines/<platform>/. Font rendering differs between operating
// systems, so the baselines are only valid on the platform in their path.
import { defineConfig, devices } from "@playwright/test";

const PORT = 5341;

export default defineConfig({
  testDir: "visual",
  snapshotPathTemplate: "{testDir}/baselines/{platform}/{arg}{ext}",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  expect: {
    toHaveScreenshot: {
      // Tolerance: a pixel counts as different when its colour moves more than
      // 0.2 (Playwright's YIQ threshold), and at most 0.2% of pixels may differ.
      threshold: 0.2,
      maxDiffPixelRatio: 0.002,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "en-US",
    timezoneId: "America/New_York",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @clawtrate/desktop fixture",
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
