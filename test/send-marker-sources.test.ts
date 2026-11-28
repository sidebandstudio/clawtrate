// The mark that says a message comes from Clawtrate (#666, #743) reaches a frame only where a
// person's message is sent. A check-in's prompt is a `config.patch`, a routine's instruction a
// `cron.add` or `cron.update`, and a bot's message to another bot the gateway's own tool: none of
// them is built with `chatSendParams` or names the field, so none can carry it.
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

const root = fileURLToPath(new URL("../", import.meta.url));

const NOT_SOURCE = new Set(["node_modules", "out", "dist", "build", "coverage", "test"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return NOT_SOURCE.has(name) || name.startsWith(".") ? [] : sources(path);
    return /\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/**
 * The site `node` is, if any. The syntax decides, so neither a comment nor the words inside a
 * string count.
 */
function site(node: ts.Node): string | undefined {
  // The method's name wherever it is: sent straight or through a constant, as `voice.ts` sends one.
  if (ts.isStringLiteralLike(node)) return node.text === "chat.send" ? "chat.send" : undefined;
  if (!ts.isIdentifier(node)) return undefined;
  if (node.text === "CLAWTRATE_WORK_CONTEXT") return "marker";
  // The field however it is named: set, taken off, or declared.
  if (node.text === "workContext") return "workContext";
  const call = node.parent;
  if (node.text === "chatSendParams" && ts.isCallExpression(call) && call.expression === node)
    return "chatSendParams";
  return undefined;
}

/** Every site, as `file: kind` with how many times it occurs there, in the source under `dir`. */
function sites(dir: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of ["packages", "apps"].flatMap((top) => sources(join(dir, top)))) {
    const name = relative(dir, file).split(sep).join("/");
    const visit = (node: ts.Node): void => {
      const kind = site(node);
      if (kind) found[`${name}: ${kind}`] = (found[`${name}: ${kind}`] ?? 0) + 1;
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
  }
  return found;
}

describe("what isn't a person's message never carries the mark", () => {
  it("the mark enters a frame only in chat.send's parameters, which only deliver sends", () => {
    expect(sites(root)).toEqual({
      // `sendParams`, and the one `chat.send`: `deliver`'s.
      "packages/core/src/client.ts: chatSendParams": 1,
      "packages/core/src/client.ts: chat.send": 1,
      // Only to take it off, for a resend the gateway refused it on.
      "packages/core/src/client.ts: workContext": 1,
      // The mark itself, and its words as a search finds them.
      "packages/core/src/send-marker.ts: marker": 2,
      "packages/core/src/send-size.ts: chatSendParams": 1,
      // The frame's size, measured with the method's name: it sends nothing.
      "packages/core/src/send-size.ts: chat.send": 1,
      "packages/core/src/send-size.ts: marker": 2,
      "packages/core/src/send-size.ts: workContext": 1,
    });
    // It parses every source file under packages/ and apps/: seconds on a busy machine (#916).
  }, 30_000);

  it("counts each site, in nested folders too", () => {
    const dir = mkdtempSync(join(tmpdir(), "send-marker-sources-"));
    try {
      const send = 'this.request("chat.send", { workContext: CLAWTRATE_WORK_CONTEXT });\n';
      for (const [path, text] of [
        ["packages/core/src/client.ts", send + send],
        ["packages/core/src/node/relay.ts", send],
        ["packages/core/test/client.ts", send],
        ["apps/desktop/src/main/send.ts", send],
        // A `//` in a string on the same line as the send.
        [
          "packages/core/src/url.ts",
          'const url = "https://example.invalid"; this.request("chat.send", {});\n',
        ],
      ] as const) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      expect(sites(dir)).toEqual({
        "apps/desktop/src/main/send.ts: chat.send": 1,
        "apps/desktop/src/main/send.ts: marker": 1,
        "apps/desktop/src/main/send.ts: workContext": 1,
        "packages/core/src/client.ts: chat.send": 2,
        "packages/core/src/client.ts: marker": 2,
        "packages/core/src/client.ts: workContext": 2,
        "packages/core/src/node/relay.ts: chat.send": 1,
        "packages/core/src/node/relay.ts: marker": 1,
        "packages/core/src/node/relay.ts: workContext": 1,
        "packages/core/src/url.ts: chat.send": 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a send whose method's name is passed through a constant", () => {
    const dir = mkdtempSync(join(tmpdir(), "send-marker-sources-"));
    try {
      mkdirSync(join(dir, "packages/core/src"), { recursive: true });
      mkdirSync(join(dir, "apps"));
      writeFileSync(
        join(dir, "packages/core/src/client.ts"),
        [
          'const CHAT_SEND = "chat.send";',
          "this.request(CHAT_SEND, { workContext: CLAWTRATE_WORK_CONTEXT });",
          "",
        ].join("\n"),
      );
      expect(sites(dir)).toEqual({
        "packages/core/src/client.ts: chat.send": 1,
        "packages/core/src/client.ts: marker": 1,
        "packages/core/src/client.ts: workContext": 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doesn't count a site's words inside a string", () => {
    const dir = mkdtempSync(join(tmpdir(), "send-marker-sources-"));
    try {
      mkdirSync(join(dir, "packages/core/src"), { recursive: true });
      mkdirSync(join(dir, "apps"));
      writeFileSync(
        join(dir, "packages/core/src/client.ts"),
        'throw new Error("Invalid workContext: expected an object");\n',
      );
      expect(sites(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
