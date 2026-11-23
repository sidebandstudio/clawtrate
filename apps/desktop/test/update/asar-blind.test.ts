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

const FS = String.raw`["'](?:node:)?fs(?:/promises)?["']`;

/** Each way a source reaches a tree operation through node:fs: a name, or the whole module. */
function fsProblems(source: string): string[] {
  const named = (list: string) =>
    list
      .split(",")
      .map((part) =>
        part
          .trim()
          .split(/\s+as\s+/)[0]!
          .replace(/^type\s+/, ""),
      )
      // `default` in braces is the whole module, as a default import is.
      .filter((name) => TREE_OPERATIONS.has(name) || name === "default");
  const problems: string[] = [];
  // import { rm } from "node:fs"; import fs, { rm } from "node:fs"; export { rm } from "node:fs"
  for (const match of source.matchAll(
    new RegExp(
      String.raw`\b(import|export)\s+(?!type\b)(?:(\w+)\s*,\s*)?\{([^}]*)\}\s*from\s*${FS}`,
      "g",
    ),
  )) {
    if (match[2]) problems.push(`default import ${match[2]}`);
    problems.push(...named(match[3]!));
  }
  // import fs from "node:fs"; import * as fs from "node:fs"; export * from "node:fs"
  for (const match of source.matchAll(
    new RegExp(
      String.raw`\b(?:import\s+(?!type\b)(\*\s+as\s+\w+|\w+)|export\s+(\*(?:\s+as\s+\w+)?))\s+from\s*${FS}`,
      "g",
    ),
  ))
    problems.push(match[1] ? `whole module as ${match[1]}` : `re-export ${match[2]}`);
  // require("node:fs") and import("node:fs")
  for (const match of source.matchAll(
    new RegExp(String.raw`\b(require|import)\s*\(\s*${FS}\s*\)`, "g"),
  ))
    problems.push(`${match[1]}()`);
  return problems;
}

it.each(updateModules())("%s takes no tree operation from node:fs", (file) => {
  expect(fsProblems(readFileSync(join(MAIN, file), "utf8"))).toEqual([]);
});

it("update-tree-fs.ts takes its functions from Electron's original-fs", () => {
  expect(readFileSync(join(MAIN, "update-tree-fs.ts"), "utf8")).toMatch(
    /process\.versions\.electron \? require\("original-fs"\)/,
  );
});

it.each([
  ['import { promises } from "node:fs";', ["promises"]],
  ['import { rm as remove } from "node:fs/promises";', ["rm"]],
  ['import { readdirSync, lstat } from "fs";', ["readdirSync"]],
  ['import fs, { rm } from "node:fs";', ["default import fs", "rm"]],
  ['import fs, { lstat } from "node:fs/promises";', ["default import fs"]],
  ['import fs from "node:fs";', ["whole module as fs"]],
  ['import * as fs from "node:fs/promises";', ["whole module as * as fs"]],
  ['export { rm } from "node:fs/promises";', ["rm"]],
  ['export { rm as remove, lstat } from "node:fs";', ["rm"]],
  ['export * from "node:fs";', ["re-export *"]],
  ['export * as fs from "node:fs";', ["re-export * as fs"]],
  ['const fs = require("node:fs");', ["require()"]],
  ['const fs = await import("node:fs/promises");', ["import()"]],
  ['import { lstat, open } from "node:fs/promises";', []],
  ['import type { Stats } from "node:fs";', []],
  ['import { default as fs } from "node:fs";', ["default"]],
  ['export { default } from "node:fs/promises";', ["default"]],
] as const)("the guard reads %s", (source, problems) => {
  expect(fsProblems(source)).toEqual(problems);
});
