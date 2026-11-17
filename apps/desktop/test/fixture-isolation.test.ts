// The fixture mode must never reach a packaged app: no shipped entry point or
// build configuration may refer to it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("fixture mode isolation", () => {
  const shipped = [
    ...["renderer", "main", "preload", "host", "web-host"].flatMap((dir) =>
      files(join(APP, "src", dir)),
    ),
    join(APP, "electron.vite.config.ts"),
    join(APP, "vite.web.config.ts"),
  ].filter((path) => /\.(ts|tsx|html)$/.test(path));

  it("is not referenced by the Electron app, the web preview or their builds", () => {
    expect(shipped.length).toBeGreaterThan(5);
    for (const path of shipped) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/fixture/i);
    }
  });

  it("is built only by its own configuration, into its own folder", () => {
    const config = readFileSync(join(APP, "vite.fixture.config.ts"), "utf8");
    expect(config).toContain('root: "src/fixture"');
    expect(config).toContain('outDir: "../../out/fixture"');
  });
});
