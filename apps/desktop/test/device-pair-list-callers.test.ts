// Who sends `device.pair.list` (docs/design/setup-effortless.md §5, "The reads are ordered").
// The device approval engine numbers every send of it and applies every reply, so an older
// decision can't act after a newer reply from any path, Settings, Machines included (it asks
// through `listDevices`). That holds only while its one function, `list()`, is the only place
// the app sends the method: this reads the source of every package and app and fails for any
// other sender.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** The one sender: `list()`, whose send is numbered and whose reply is applied. */
const SENDERS: Record<string, number> = { "packages/core/src/device-approval.ts": 1 };

/** Folders that hold no source: dependencies, build output (a desktop build's `out`), tests. */
const NOT_SOURCE = new Set(["node_modules", "out", "dist", "build", "coverage", "test"]);
const sourceFolder = (name: string) => !NOT_SOURCE.has(name) && !name.startsWith(".");

/** Every source file under `dir`, by path: folders that hold no source are never entered. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (sourceFolder(name)) out.push(...sources(path));
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

/** The senders in the source under `dir`, each file with its count. */
function senders(dir: string, tops: string[]): Record<string, number> {
  const found: Record<string, number> = {};
  for (const top of tops) {
    for (const file of sources(join(dir, top))) {
      const count = named(file, readFileSync(file, "utf8"));
      if (count > 0) found[relative(dir, file).split(sep).join("/")] = count;
    }
  }
  return found;
}

/**
 * The method's name as a string in `text`, wherever it is: a send passes it straight or through a
 * variable or a constant, and either needs the string. A comment's mention isn't one.
 */
function named(file: string, text: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text === "device.pair.list") count += 1;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest));
  return count;
}

/**
 * The one send in `list()`: a `request(` call naming it, the way every engine sends a gateway
 * method (`ctx.request`, `client.request`), however the call is wrapped across lines. A
 * comment's mention isn't one.
 */
const SEND = /\brequest\s*(?:<[^>]*>)?\(\s*["'`]device\.pair\.list["'`]/g;

describe("device.pair.list's sender", () => {
  it("is the approval engine's one numbered function alone", () => {
    expect(senders(root, ["packages", "apps"])).toEqual(SENDERS);
    // And that one send is in `DeviceApprovals.list()`, not in a helper beside it.
    const engine = readFileSync(join(root, "packages/core/src/device-approval.ts"), "utf8");
    const start = engine.indexOf("\n  private async list(");
    expect(start).toBeGreaterThan(0);
    expect(engine.slice(start, engine.indexOf("\n  }\n", start)).match(SEND)).toHaveLength(1);
  });

  it("is looked for in source only, never in build output or dependencies", () => {
    const dir = mkdtempSync(join(tmpdir(), "pair-list-senders-"));
    try {
      const send = 'export const read = (ctx) => ctx.request("device.pair.list", {});\n';
      for (const path of [
        "apps/app/src/reads.ts",
        "apps/app/out/main/index.js",
        "packages/lib/dist/index.js",
        "packages/lib/node_modules/dep/index.js",
        "packages/lib/test/reads.ts",
      ]) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), send);
      }
      expect(senders(dir, ["packages", "apps"])).toEqual({ "apps/app/src/reads.ts": 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is found when the method's name is passed through a constant", () => {
    const dir = mkdtempSync(join(tmpdir(), "pair-list-senders-"));
    try {
      mkdirSync(join(dir, "packages/lib/src"), { recursive: true });
      writeFileSync(
        join(dir, "packages/lib/src/reads.ts"),
        [
          "// Mentions `device.pair.list` in a comment, which sends nothing.",
          'const METHOD = "device.pair.list";',
          "export const read = (ctx) => ctx.request(METHOD, {});",
          "",
        ].join("\n"),
      );
      expect(senders(dir, ["packages"])).toEqual({ "packages/lib/src/reads.ts": 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
