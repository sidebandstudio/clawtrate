// A temporary folder for a unit test (#866). Made while a test runs, its `beforeEach`
// included, it is removed when that test finishes, pass or fail. Made anywhere else, such
// as a `beforeAll`, a `describe` or the top of a file, it is removed when the file's tests
// are done, by the `afterAll` below. A file whose tests a name filter (`-t`) all skipped
// never runs that `afterAll`; its folder goes with the run's own, and the run's check lets
// such a run be.
// That `afterAll` is registered once for each copy of this module, and Vitest gives each
// test file a copy of its own only while files are isolated (the default here). With
// `--isolate=false` the files share one copy, so only the first file's folders made outside
// a test are removed: a later file's stays until the run's own temporary folder
// (test/run-temp.ts) goes, and that run's check fails.
// Loaded outside Vitest, as by a node:test file that imports a fixture, it removes such
// folders when the process exits.
// It follows the one test Vitest says is running, so in tests run with `concurrent` a folder
// can go when another test finishes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, onTestFinished, TestRunner } from "vitest";
import { removeFolder } from "./run-temp.ts";

const forFile: string[] = [];
const removeForFile = () => {
  // Every folder gets its try: one that can't go (a file a child still holds, on Windows)
  // doesn't keep the rest. The first failure is reported once all were tried.
  const failures: unknown[] = [];
  for (const dir of forFile.splice(0)) {
    try {
      removeFolder(dir);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
};
try {
  afterAll(removeForFile);
} catch {
  // Not in a Vitest run: `afterAll` has no file to belong to.
  process.once("exit", removeForFile);
}

/** A new folder in `parent`, the system's temporary folder by default, named `prefix` and six random characters. */
export function tempDir(prefix: string, parent: string = tmpdir()): string {
  const dir = mkdtempSync(join(parent, prefix));
  if (TestRunner.getCurrentTest()) onTestFinished(() => removeFolder(dir));
  else forFile.push(dir);
  return dir;
}
