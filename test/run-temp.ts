// Each unit run's own temporary folder (#866). Vitest runs this once per run, before any test
// file: it makes one folder in the system's temporary folder and points the workers' (and
// every program they start) at it through TMPDIR, TMP and TEMP. When the run ends it removes
// the folder, whatever the tests did, so nothing piles up across runs; a run that is killed
// leaves this one folder, which a run a day later removes.
//
// It is also the check that tests clean up after themselves. When every test passed, what is
// left in the folder, but for the caches tools keep there under fixed names, fails the run
// with each entry's name and the files that name its prefix. When a test failed, or the run
// ran no test (`vitest list` collects files without running their hooks), it says nothing.
// Nor does it when a name filter (`-t`) left a whole file unrun: that file's hooks never ran,
// so what it made while it was collected is still there, and the run did nothing wrong.
// A program a test starts with an environment of its own, without TMPDIR, writes outside it.
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

/** Kept by tools under the same name in every run: jiti's and Node's compile caches. */
export const TOOL_CACHES = new Set(["jiti", "node-compile-cache"]);
/** Short, because it lengthens every temporary path and some, a Unix socket's for one, have a length limit. */
const PREFIX = "ctu-";
const ENV_NAMES = ["TMPDIR", "TMP", "TEMP"];
const DAY_MS = 24 * 60 * 60 * 1000;

export default function setup(project: TestProject): () => void {
  const parent = tmpdir();
  pruneRuns(parent);
  const root = mkdtempSync(join(parent, `${PREFIX}${process.pid}-`));
  const before = ENV_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of ENV_NAMES) process.env[name] = root;
  return () => {
    try {
      if (passed(project)) {
        const left = leftBehind(root);
        if (left.length) throw new Error(leftMessage(root, left, project.config.root));
      }
    } finally {
      // Put back first: a watch session that restarts runs set-up again in this process.
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      try {
        removeFolder(root);
      } catch (error) {
        // A file a process still holds (on Windows) keeps it; a run a day later removes it.
        console.warn(`The run's temporary folder ${root} stays: ${String(error)}`);
      }
    }
  };
}

/** True when the run ran tests, every one of them passed, and no name filter left a file unrun. */
export function passed(project: TestProject): boolean {
  const { state } = project.vitest;
  if (state.getUnhandledErrors().length > 0 || state.getCountOfFailedTests() > 0) return false;
  const modules = state.getTestModules();
  const unrun = modules.some((each) => each.state() === "skipped");
  if (project.config.testNamePattern && unrun) return false;
  return (
    modules.every((each) => each.state() === "passed" || each.state() === "skipped") &&
    modules.some((each) => [...each.children.allTests("passed")].length > 0)
  );
}

/** What tests left in a run's folder. */
export function leftBehind(root: string): string[] {
  return readdirSync(root)
    .filter((name) => !TOOL_CACHES.has(name))
    .sort();
}

/** The failure for entries left in `root`, by prefix, with the tracked files that name each prefix. */
export function leftMessage(root: string, left: string[], checkout: string): string {
  const byPrefix = new Map<string, string[]>();
  for (const name of left) {
    const prefix = /^(.+[-_.])[A-Za-z0-9]{6}$/.exec(name)?.[1] ?? name;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }
  const lines = [...byPrefix].map(([prefix, names]) => {
    const files = namedIn(checkout, prefix);
    const where = files.length ? `named in ${files.join(", ")}` : "no tracked file names it";
    return `  ${names.length} × ${prefix} (${names[0]}): "${prefix}" is ${where}`;
  });
  return [
    `Tests passed but left ${left.length} ${left.length === 1 ? "entry" : "entries"} in the run's temporary folder (${root}):`,
    ...lines,
    "Remove what a test makes when the test ends, pass or fail: `tempDir` (test/temp-dir.ts) does that for a folder.",
  ].join("\n");
}

function namedIn(checkout: string, prefix: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-l", "-F", "-e", `"${prefix}`, "-e", `'${prefix}`, "-e", `\`${prefix}`],
      {
        cwd: checkout,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    // Not this check's own test, which names prefixes as examples.
    const files = out.split("\n").filter((file) => file && !file.startsWith("test/run-temp"));
    return files.length > 5 ? [...files.slice(0, 5), `${files.length - 5} more`] : files;
  } catch {
    return []; // git grep exits 1 when nothing matches, and there may be no git at all
  }
}

/** Removes the folders of earlier runs that are more than a day old and whose process is gone. */
export function pruneRuns(parent: string, now = Date.now()): void {
  for (const name of readdirSync(parent)) {
    // Only what `setup` makes: a folder named by `mkdtemp`, never a file or a link of that name.
    const pid = Number(new RegExp(`^${PREFIX}(\\d+)-[A-Za-z0-9]{6}$`).exec(name)?.[1]);
    if (!pid || alive(pid)) continue;
    const dir = join(parent, name);
    try {
      const stat = lstatSync(dir);
      if (stat.isDirectory() && now - stat.mtimeMs > DAY_MS) removeFolder(dir);
    } catch {
      // Removed by another run at the same moment.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes a folder and everything in it, also folders a test made unreadable or unwritable. */
export function removeFolder(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // A folder a test locked (`chmod 000`) stops the removal; unlock everything and try again.
    giveBack(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Makes every folder under `path` the owner's to read, enter and change again. */
function giveBack(path: string): void {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) giveBack(join(path, name));
}
