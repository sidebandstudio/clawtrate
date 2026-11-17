// The parity check: docs/parity.md against the checks that name its rows. A
// check names rows by starting its title, or the title of a group it is in,
// with their ids, for example `test("F-013 F-015: ...")`.
//
// Only checks that will run count. The test runners themselves say which those
// are: Vitest collects each test file by running it, and Playwright loads each
// spec, so a check in a comment or behind code that never runs is never
// registered, and a skipped, fixme or todo check is listed as such and left out.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const STATUSES = ["todo", "done", "desktop done", "gap"] as const;

export type ParityRow = { id: string; platform: string; status: string };

/** A check that will run, as the titles from its outermost group down to the test. */
export type CheckPath = string[];

/** The rows of the table: every line that starts with "| F-". */
export function parseTable(markdown: string): ParityRow[] {
  return markdown
    .split("\n")
    .filter((line) => /^\| F-\d{3} \|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      // A row starts and ends with a pipe, so the first and last cells are empty.
      return { id: cells[1]!, platform: cells[3]!, status: cells.at(-2)! };
    });
}

/** The checks in `vitest list --json --staticParse=false` output. Vitest leaves out skipped and todo tests. */
export function vitestChecks(json: string): CheckPath[] {
  return (JSON.parse(json) as { name: string }[]).map((test) => test.name.split(" > "));
}

type PlaywrightSuite = {
  title: string;
  specs?: { title: string; tests: { expectedStatus: string }[] }[];
  suites?: PlaywrightSuite[];
};

/** The checks in `playwright test --list --reporter=json` output that are expected to pass. */
export function playwrightChecks(json: string): CheckPath[] {
  const checks: CheckPath[] = [];
  const walk = (suite: PlaywrightSuite, path: string[]) => {
    for (const spec of suite.specs ?? []) {
      if (spec.tests.some((test) => test.expectedStatus === "passed")) {
        checks.push([...path, spec.title]);
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
  };
  // The outermost suite is the file; its title is a path, not a check title.
  for (const file of (JSON.parse(json) as { suites: PlaywrightSuite[] }).suites) walk(file, []);
  return checks;
}

/** The ids at the start of each title in each check's path. */
export function checkIds(checks: CheckPath[]): string[] {
  const ids: string[] = [];
  for (const path of checks) {
    for (const title of path) {
      const lead = /^((?:F-\d{3}[ ,]*)+):/.exec(title);
      if (lead) ids.push(...lead[1]!.match(/F-\d{3}/g)!);
    }
  }
  return ids;
}

/** Run a runner's listing from `root`'s packages in `cwd`, outside the Vitest worker this is called from. */
function list(root: string, cwd: string, bin: string, args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
  );
  return execFileSync(join(root, "node_modules/.bin", bin), args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The checks Vitest will run in `dir`, with the config found there. */
export function listVitest(root: string, dir = root): CheckPath[] {
  return vitestChecks(
    list(root, dir, "vitest", ["list", "--json", "--staticParse=false", "--root", dir]),
  );
}

/** The checks Playwright will run for a config. */
export function listPlaywright(root: string, config: string): CheckPath[] {
  return playwrightChecks(
    list(root, root, "playwright", ["test", "--list", "--reporter=json", "-c", config]),
  );
}

/** Everything wrong with the table and the checks that name it. */
export function parityProblems(rows: ParityRow[], named: Set<string>): string[] {
  const problems: string[] = [];
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    if (!(STATUSES as readonly string[]).includes(row.status)) {
      problems.push(`${row.id}: unknown status "${row.status}"`);
    }
    if (row.status === "desktop done" && row.platform !== "both") {
      problems.push(`${row.id}: "desktop done" is only for rows whose platform is both`);
    }
    if ((row.status === "done" || row.status === "desktop done") && !named.has(row.id)) {
      problems.push(`${row.id}: marked ${row.status}, but no check that runs names it`);
    }
  }
  for (const id of named)
    if (!ids.has(id)) problems.push(`${id}: a check names it, but the table has no such row`);
  return problems;
}
