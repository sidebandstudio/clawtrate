// The unit run's own temporary folder (#866): what counts as left behind, what the failure
// says, and which earlier runs' folders a new run removes.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import setup, { leftBehind, leftMessage, passed, pruneRuns } from "./run-temp.ts";
import { tempDir } from "./temp-dir.ts";

const ROOT = join(import.meta.dirname, "..");
const NOW = Date.UTC(2026, 10, 27, 12, 0);

type Project = Parameters<typeof setup>[0];
/** A run as the check reads it: each file's state, how many of its tests passed, and `-t`. */
const project = (files: Array<[state: string, passed: number]>, filter?: RegExp, failed = 0) =>
  ({
    config: { testNamePattern: filter },
    vitest: {
      state: {
        getUnhandledErrors: () => [],
        getCountOfFailedTests: () => failed,
        getTestModules: () =>
          files.map(([state, count]) => ({
            state: () => state,
            children: { allTests: () => Array.from({ length: count }) },
          })),
      },
    },
  }) as unknown as Project;

describe("the unit run's temporary folder", () => {
  it("judges a run whose tests all passed, but not one a name filter kept a file out of", () => {
    expect(passed(project([["passed", 3]]))).toBe(true);
    // A file skipped on this platform still counts: its author can move what it makes.
    expect(
      passed(
        project([
          ["passed", 3],
          ["skipped", 0],
        ]),
      ),
    ).toBe(true);
    // `-t` matched no test of the second file, so none of its hooks ran.
    expect(
      passed(
        project(
          [
            ["passed", 1],
            ["skipped", 0],
          ],
          /one/,
        ),
      ),
    ).toBe(false);
    // `-t` within one file: its hooks ran.
    expect(passed(project([["passed", 1]], /one/))).toBe(true);
    expect(passed(project([["failed", 2]], undefined, 1))).toBe(false);
    expect(passed(project([["skipped", 0]]))).toBe(false);
  });

  it("gives the run a folder of its own, then puts the variables back and removes it", () => {
    const names = ["TMPDIR", "TMP", "TEMP"];
    const saved = names.map((name) => [name, process.env[name]] as const);
    const parent = tempDir("clawtrate-run-temp-");
    try {
      process.env.TMPDIR = parent;
      process.env.TEMP = parent;
      delete process.env.TMP;
      const teardown = setup(project([["failed", 0]], undefined, 1));
      const root = process.env.TMPDIR;
      expect(readdirSync(parent)).toEqual([basename(root)]);
      expect(basename(root)).toMatch(new RegExp(`^ctu-${process.pid}-[A-Za-z0-9]{6}$`));
      expect([process.env.TMP, process.env.TEMP]).toEqual([root, root]);
      teardown();
      expect([process.env.TMPDIR, process.env.TEMP]).toEqual([parent, parent]);
      expect("TMP" in process.env).toBe(false);
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("counts what tests left, not the caches tools keep there", () => {
    const root = tempDir("clawtrate-run-temp-");
    for (const name of ["jiti", "node-compile-cache", "clawtrate-home-Ab12Cd", "notes.txt"])
      mkdirSync(join(root, name));
    expect(leftBehind(root)).toEqual(["clawtrate-home-Ab12Cd", "notes.txt"]);
  });

  it("names each entry and the files that name its prefix", () => {
    const text = leftMessage("/state/ctu-1-abcdef", ["clawtrate-runtime-Ab12Cd"], ROOT);
    expect(text).toContain("left 1 entry in the run's temporary folder (/state/ctu-1-abcdef)");
    expect(text).toMatch(
      /1 × clawtrate-runtime- \(clawtrate-runtime-Ab12Cd\): "clawtrate-runtime-" is named in apps\/desktop\/test\/runtime\.test\.ts$/m,
    );
    // Made here, so that this file does not name it.
    const unnamed = ["no", "such", "prefix", "here"].join("-");
    expect(leftMessage("/state/r", [unnamed], ROOT)).toContain(
      `"${unnamed}" is no tracked file names it`,
    );
  });

  it("removes an earlier run's folder once it is a day old and its process is gone", () => {
    const parent = tempDir("clawtrate-run-temp-");
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
    const folder = (name: string, hours: number) => {
      mkdirSync(join(parent, name));
      const at = new Date(NOW - hours * 60 * 60 * 1000);
      utimesSync(join(parent, name), at, at);
    };
    folder(`ctu-${gone}-old000`, 30);
    folder(`ctu-${gone}-new000`, 2);
    folder(`ctu-${process.pid}-live00`, 30);
    folder("clawtrate-home-old000", 30);
    // Another tool's: the name is not one `mkdtemp` gives, or it is not a folder.
    folder(`ctu-${gone}-x`, 30);
    writeFileSync(join(parent, `ctu-${gone}-file00`), "");
    const old = new Date(NOW - 30 * 60 * 60 * 1000);
    utimesSync(join(parent, `ctu-${gone}-file00`), old, old);
    pruneRuns(parent, NOW);
    expect(readdirSync(parent).sort()).toEqual(
      [
        "clawtrate-home-old000",
        `ctu-${gone}-file00`,
        `ctu-${gone}-new000`,
        `ctu-${gone}-x`,
        `ctu-${process.pid}-live00`,
      ].sort(),
    );
  });
});
