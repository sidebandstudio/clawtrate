// The update code removes, copies and lists folders only through update-tree-fs.ts, never
// through node:fs, which Electron patches to read an .asar file as a folder (#383).

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const MAIN = resolve(import.meta.dirname, "../../src/main");
const TREE_OPERATIONS = new Set([
  ...["rm", "rmdir", "cp", "readdir", "opendir", "glob"].flatMap((name) => [name, name + "Sync"]),
  // node:fs's promises object carries every one of them.
  "promises",
]);

/** The main process's update modules. */
function updateModules(): string[] {
  return [
    ...readdirSync(join(MAIN, "update")).map((name) => join("update", name)),
    ...readdirSync(MAIN).filter((name) =>
      /^(mac-.*|private-update-directory|update-.*|inspect-update-file)\.ts$/.test(name),
    ),
  ].filter((name) => name.endsWith(".ts") && name !== "update-tree-fs.ts");
}

it("finds the update modules it guards", () => {
  expect(updateModules()).toEqual(
    expect.arrayContaining([
      "mac-install.ts",
      "mac-archive.ts",
      "private-update-directory.ts",
      join("update", "engine.ts"),
    ]),
  );
});

/** The tree operations a source takes from node:fs by name. */
function treeOperationsIn(source: string): string[] {
  return [
    ...source.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s+from\s+"(?:node:)?fs(?:\/promises)?"/g),
  ].flatMap((match) =>
    match[1]!
      .split(",")
      .map((part) =>
        part
          .trim()
          .split(/\s+as\s+/)[0]!
          .replace(/^type\s+/, ""),
      )
      .filter((name) => TREE_OPERATIONS.has(name)),
  );
}

it.each(updateModules())("%s takes no tree operation from node:fs", (file) => {
  const source = readFileSync(join(MAIN, file), "utf8");
  expect(treeOperationsIn(source)).toEqual([]);
  // No namespace or default import of node:fs either, which would reach the same functions.
  expect(source).not.toMatch(
    /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+"(?:node:)?fs(?:\/promises)?"/,
  );
});

it("update-tree-fs.ts takes its functions from Electron's original-fs", () => {
  expect(readFileSync(join(MAIN, "update-tree-fs.ts"), "utf8")).toMatch(
    /process\.versions\.electron \? require\("original-fs"\)/,
  );
});

it("the guard sees each way of taking a tree operation from node:fs", () => {
  expect(treeOperationsIn('import { promises } from "node:fs";')).toEqual(["promises"]);
  expect(treeOperationsIn('import { rm as remove } from "node:fs/promises";')).toEqual(["rm"]);
  expect(treeOperationsIn('import { readdirSync, lstat } from "fs";')).toEqual(["readdirSync"]);
});
