import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkIds, parityProblems, parseTable } from "./parity.ts";

const ROOT = join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "dist", "out", ".run", "test-results", "baselines"]);
const CHECK_DIRS = ["e2e", "visual", "test", "packages", "apps", "tools"];

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP.has(entry)) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return testFiles(path);
    return /\.(test|spec)\.ts$/.test(entry) ? [path] : [];
  });
}

describe("the parity table", () => {
  it("has a check for every row marked done, and every check names a real row", () => {
    const rows = parseTable(readFileSync(join(ROOT, "docs/parity.md"), "utf8"));
    expect(rows.length).toBeGreaterThan(400);
    const files = CHECK_DIRS.flatMap((dir) => testFiles(join(ROOT, dir))).filter(
      (path) => !relative(ROOT, path).startsWith("test/parity"),
    );
    const named = new Set(files.flatMap((path) => checkIds(readFileSync(path, "utf8"))));
    expect(parityProblems(rows, named)).toEqual([]);
  });

  it("reads ids, platforms and statuses from table rows", () => {
    const rows = parseTable(
      [
        "| id | area | platform | behavior | target | dependency | status |",
        "|---|---|---|---|---|---|---|",
        "| F-001 | Onboarding (§1) | both | a | b | c | desktop done |",
        "| F-012 | Sidebar (§2) | desktop | a | b | c | todo |",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { id: "F-001", platform: "both", status: "desktop done" },
      { id: "F-012", platform: "desktop", status: "todo" },
    ]);
  });

  it("reads the ids at the start of check titles only", () => {
    const source = [
      'test("F-013 F-015: pinned tiles", () => {});',
      "test(`F-471: ${view.name}`, () => {});",
      'it("F-002, F-003: pairing", () => {});',
      'test.describe("F-020: working", () => {});',
      'test("shows F-099 in the middle", () => {});',
    ].join("\n");
    expect(checkIds(source)).toEqual(["F-013", "F-015", "F-471", "F-002", "F-003", "F-020"]);
  });

  it("fails a done row without a check, a check for no row, and an unknown status", () => {
    const rows = [
      { id: "F-001", platform: "both", status: "desktop done" },
      { id: "F-002", platform: "desktop", status: "done" },
      { id: "F-003", platform: "desktop", status: "desktop done" },
      { id: "F-004", platform: "both", status: "finished" },
      { id: "F-005", platform: "both", status: "todo" },
    ];
    expect(parityProblems(rows, new Set(["F-001", "F-003", "F-999"]))).toEqual([
      "F-002: marked done, but no check names it",
      'F-003: "desktop done" is only for rows whose platform is both',
      'F-004: unknown status "finished"',
      "F-999: a check names it, but the table has no such row",
    ]);
  });
});
