// Deleting a bot has one path that sends `agents.delete` (docs/parity.md F-050):
// `deleteBot` in packages/core/src/bot-delete.ts, which sends it at most once.
// Nothing else in any package or app, the hosts included, asks the gateway to delete a bot.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
/**
 * How many string literals in a source file are exactly `agents.delete`, read by the TypeScript
 * parser: a comment is no code, and a string is whole, whatever it holds (`//` included).
 */
const parse = (path: string): ts.SourceFile => {
  const kind = /\.(mjs|js)$/.test(path)
    ? ts.ScriptKind.JS
    : path.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, kind);
};
const sends = (path: string): number => {
  // Only a file whose text has both words can hold the literal written out; the rest aren't
  // parsed, so the scan stays quick on a busy machine.
  const text = readFileSync(path, "utf8");
  if (!text.includes("agents") || !text.includes("delete")) return 0;
  const file = parse(path);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && node.text === "agents.delete") count += 1;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
};
const sources = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(tsx?|mjs|js)$/.test(name) && !name.includes("node_modules"))
    .map((name) => join(ROOT, dir, name));

/** The `ctx.request("agents.delete", …)` calls inside the function `deleteBot` of the engine. */
const deleteBotRequests = (path: string): number => {
  let count = 0;
  const inDeleteBot = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ctx" &&
      node.expression.name.text === "request" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === "agents.delete"
    )
      count += 1;
    ts.forEachChild(node, inDeleteBot);
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "deleteBot") inDeleteBot(node);
    else ts.forEachChild(node, visit);
  };
  visit(parse(path));
  return count;
};

describe("F-050: the delete's one send path", () => {
  it("is `deleteBot`'s single request, and no other source has the literal `agents.delete`", () => {
    const engine = join(ROOT, "packages/core/src/bot-delete.ts");
    // `deleteBot` itself makes the request, once, and the engine names the method nowhere else.
    expect(deleteBotRequests(engine)).toBe(1);
    expect(sends(engine)).toBe(1);
    // A scan of string literals: any other source naming the method fails it, however it would
    // be sent.
    // Every package and app, the hosts included: the desktop app's main process and web host,
    // the fixture and the iPhone app.
    const dirs = [
      ...["packages", "apps"].flatMap((top) =>
        readdirSync(join(ROOT, top)).map((name) => `${top}/${name}/src`),
      ),
      "plugins",
    ];
    const others = dirs
      .filter((dir) => existsSync(join(ROOT, dir)))
      .flatMap(sources)
      .filter((path) => path !== engine && sends(path) > 0);
    expect(others).toEqual([]);
  });
});
