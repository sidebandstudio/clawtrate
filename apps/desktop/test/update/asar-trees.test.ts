// The update code's work on a folder that holds an .asar file, under Electron's own fs (#383).
// Electron's fs reads app.asar as a folder, so a recursive remove of the inspection's checked
// copy failed there, and every signed Mac build refused every update, while these modules
// passed under plain Node. asar-trees.electron.ts runs them in the development Electron binary
// with ELECTRON_RUN_AS_NODE=1. The binary is skipped where it isn't installed, as on the Linux
// check job, unless CLAWTRATE_ELECTRON_FS_TESTS=1 requires it, as the macOS job does.

import { createPackage } from "@electron/asar";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./harness.ts";

const DESKTOP = resolve(import.meta.dirname, "../..");

/** The development Electron binary, read from its package without downloading anything. */
function electronBinary(): string | null {
  try {
    const dir = dirname(
      createRequire(join(DESKTOP, "package.json")).resolve("electron/package.json"),
    );
    const path = join(dir, "dist", readFileSync(join(dir, "path.txt"), "utf8").trim());
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const electron = electronBinary();
const required = process.env.CLAWTRATE_ELECTRON_FS_TESTS === "1";

it.runIf(required)("finds the development Electron binary", () => {
  expect(electron).not.toBeNull();
});

describe.skipIf(!electron || process.platform === "win32")(
  "update folders under Electron's fs",
  () => {
    let dir: ReturnType<typeof tempDir>;
    let app: string;
    beforeAll(async () => {
      dir = tempDir();
      // A Clawtrate.app whose Resources hold an app.asar, as the release zip's does.
      const source = join(dir.path, "app-source");
      mkdirSync(join(source, "out", "main"), { recursive: true });
      writeFileSync(join(source, "package.json"), "{}");
      writeFileSync(join(source, "out", "main", "index.js"), "");
      app = join(dir.path, "fixture", "Clawtrate.app");
      mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
      await createPackage(source, join(app, "Contents", "Resources", "app.asar"));
    });
    afterAll(() => dir.remove());

    function run(kind: string): Record<string, unknown> {
      const work = join(dir.path, kind);
      mkdirSync(work);
      const out = execFileSync(
        electron!,
        [join(import.meta.dirname, "asar-trees.electron.ts"), kind, app, work],
        {
          cwd: DESKTOP,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: process.env.HOME, ELECTRON_RUN_AS_NODE: "1" },
          timeout: 60000,
        },
      );
      return JSON.parse(out.trim().split("\n").at(-1)!);
    }

    it("clears an update folder that holds a checked copy of the app", () => {
      expect(run("clear")).toEqual({ before: true, removed: true });
    });

    it("inspects with the helper stubbed to ok, removes the checked copy and serves the archive", () => {
      expect(run("install")).toEqual({
        inspected: null,
        leftAfterInspect: [],
        launched: { result: null, handed: true, sameBytes: true },
      });
    });
  },
);
