// Who sends `models.authStatus` (#697, #729). An Unlock or Clear press sends its clear only while
// no read of the bot's status began after its own, or the newest was applied and still shows the
// confirmed order. That holds only while every read takes its number as it is sent, which
// `AccountsEngine.statusRead` does: this reads the source of every package and app and fails for
// a request of the method made anywhere but in the send `statusRead` is given, directly or
// through `readStatus`, which hands its send to it.
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
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const METHOD = "models.authStatus";
const NUMBERED = new Set(["statusRead", "readStatus"]);

/** Folders that hold no source: dependencies, build output (a desktop build's `out`), tests. */
const NOT_SOURCE = new Set(["node_modules", "out", "dist", "build", "coverage", "test"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!NOT_SOURCE.has(name) && !name.startsWith(".")) out.push(...sources(path));
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

const calleeName = (call: ts.CallExpression) => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

/** Inside a function given to `statusRead` or `readStatus`. */
function numbered(node: ts.Node): boolean {
  for (let at: ts.Node = node; at.parent; at = at.parent) {
    const parent = at.parent;
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.includes(at as ts.Expression) &&
      NUMBERED.has(calleeName(parent) ?? "")
    )
      return true;
  }
  return false;
}

/**
 * Each place under `dir` that names the method outside a numbered send, as `file:line`. A
 * comparison with it (a wrapper telling reads from writes) sends nothing; any other use, a
 * constant included, could reach a request.
 */
function unnumbered(dir: string, tops: string[]): string[] {
  const found: string[] = [];
  for (const top of tops) {
    for (const file of sources(join(dir, top))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes(METHOD)) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && node.text === METHOD) {
          const parent = node.parent;
          const compared =
            ts.isBinaryExpression(parent) &&
            [
              ts.SyntaxKind.EqualsEqualsEqualsToken,
              ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ].includes(parent.operatorToken.kind);
          const sent =
            ts.isCallExpression(parent) &&
            calleeName(parent) === "request" &&
            parent.arguments[0] === node;
          if (!compared && !(sent && numbered(node))) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            found.push(`${relative(dir, file).split(sep).join("/")}:${line}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

describe("models.authStatus's senders", () => {
  it("send it only through AccountsEngine.statusRead, which numbers each read as it goes out", () => {
    expect(unnumbered(root, ["packages", "apps"])).toEqual([]);
  });

  it("a direct request, or one through a constant, is found; a numbered one and a comment aren't", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-status-senders-"));
    try {
      mkdirSync(join(dir, "packages/lib/src"), { recursive: true });
      writeFileSync(
        join(dir, "packages/lib/src/reads.ts"),
        [
          "// Mentions `models.authStatus` in a comment, which sends nothing.",
          'export const direct = (ctx) => ctx.request("models.authStatus", { agentId: "a" });',
          'const M = "models.authStatus";',
          "export const constant = (ctx) => ctx.request(M, {});",
          "export const ok = (engine, ctx) =>",
          '  engine.statusRead(ctx, ["a"], () => ctx.request("models.authStatus", { agentId: "a" }));',
          "",
        ].join("\n"),
      );
      expect(unnumbered(dir, ["packages"])).toEqual([
        "packages/lib/src/reads.ts:2",
        "packages/lib/src/reads.ts:3",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
