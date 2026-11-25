// The visual tests: the interface in its fixture mode, with no gateway. They
// build the fixture (apps/desktop/vite.fixture.config.ts), serve it on a
// loopback port, and compare screenshots with baselines committed under
// visual/baselines/<platform>/. Font rendering differs between operating
// systems, so the baselines are only valid on the platform in their path.
// The Linux ones, drawn in the pinned image (visual/linux/), are the gate.
import { defineConfig, devices } from "@playwright/test";

// 5341 unless CLAWTRATE_FIXTURE_PORT names another; the fixture's own config reads the same variable.
const PORT = Number(process.env.CLAWTRATE_FIXTURE_PORT ?? 5341);

/**
 * The macOS set: the specs where macOS draws what the Linux image cannot (#392), the
 * shortcuts sheet's ⌘ ⇧ ⌥ ⌃, search's ↵, the reactions' emoji, and the whole window as macOS
 * rasterises its text. Only these keep baselines under visual/baselines/darwin/, so a Mac runs
 * only these. Every spec runs in the Linux image (`pnpm visual:linux`), against
 * visual/baselines/linux/. CLAWTRATE_VISUAL_ALL_SPECS lists every spec on a Mac too, for the
 * parity check's listing.
 */
export const MACOS_SPECS = [
  "visual/shortcuts.visual.spec.ts",
  "visual/search.visual.spec.ts",
  "visual/messages.visual.spec.ts",
  "visual/shell.visual.spec.ts",
];
const macosSetOnly = process.platform === "darwin" && !process.env.CLAWTRATE_VISUAL_ALL_SPECS;

export default defineConfig({
  testDir: "visual",
  ...(macosSetOnly ? { testMatch: MACOS_SPECS } : {}),
  // A folder of its own: Playwright empties its output folder when a run starts, and the
  // end-to-end runs keep theirs under test-results/ while they run.
  outputDir: "test-results/visual",
  snapshotPathTemplate: "{testDir}/baselines/{platform}/{arg}{ext}",
  timeout: 60_000,
  fullyParallel: true,
  // Playwright's default is half the cores, which is one worker on CI's three-core macOS runner.
  ...(process.env.CI ? { workers: "100%" } : {}),
  // In CI a failed test runs once more. One that then passes is reported as flaky by name in
  // the list reporter's summary, so it stays visible and still needs fixing.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
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
    // The app's own default, for a test that names no theme.
    colorScheme: "dark",
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
