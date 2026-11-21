// The Playwright suites can run at the same time in one checkout: Playwright empties a
// run's output folder when it starts, so no suite's folder may hold another's.
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

describe("the Playwright configurations", () => {
  it("give each suite an output folder of its own, none holding another's", async () => {
    process.env.CLAWTRATE_E2E_RUN ??= "aabbccdd";
    const folders: string[] = [];
    for (const file of [
      "playwright.config.ts",
      "playwright.visual.config.ts",
      "playwright.packaged.config.ts",
      "playwright.desktop.config.ts",
    ]) {
      const config = (await import(join(ROOT, file))).default as { outputDir?: string };
      // Playwright's default is test-results/ itself, which holds every run's folder.
      expect(config.outputDir, file).toBeDefined();
      folders.push(relative(ROOT, join(ROOT, config.outputDir!)));
    }
    for (const a of folders)
      for (const b of folders)
        if (a !== b) expect(`${b}/`.startsWith(`${a}/`), `${a} holds ${b}`).toBe(false);
    expect(new Set(folders).size).toBe(folders.length);
  });
});
