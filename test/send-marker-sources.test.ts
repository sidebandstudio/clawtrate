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

const SITES = {
  marker: /\bCLAWTRATE_WORK_CONTEXT\b/g,
  chatSendParams: /\bchatSendParams\(/g,
  workContext: /\bworkContext\s*:/g,
  "chat.send": /\brequest\s*(?:<[^>]*>)?\(\s*["'`]chat\.send["'`]/g,
};

// Comments go by the parser's tokens, so a `//` inside a string (a URL) keeps the code after it.
const uncommented = ts.createPrinter({ removeComments: true });

const NOT_SOURCE = new Set(["node_modules", "out", "dist", "build", "coverage", "test"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return NOT_SOURCE.has(name) || name.startsWith(".") ? [] : sources(path);
    return /\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/** Every site, as `file: kind` with how many times it occurs there, in the source under `dir`. */
function sites(dir: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of ["packages", "apps"].flatMap((top) => sources(join(dir, top)))) {
    const code = uncommented.printFile(
      ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest),
    );
    const name = relative(dir, file).split(sep).join("/");
    for (const [kind, pattern] of Object.entries(SITES)) {
      const count = code.match(pattern)?.length ?? 0;
      if (count > 0) found[`${name}: ${kind}`] = count;
    }
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
});
