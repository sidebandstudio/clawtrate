// The mark that says a message comes from Clawtrate (#666, #743) reaches a frame only where a
// person's message is sent. A check-in's prompt is a `config.patch`, a routine's instruction a
// `cron.add` or `cron.update`, and a bot's message to another bot the gateway's own tool: none of
// them is built with `chatSendParams` or names the field, so none can carry it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../packages/core/src");

describe("what isn't a person's message never carries the mark", () => {
  it("the mark enters a frame only in chat.send's parameters, which only deliver sends", () => {
    const uses: string[] = [];
    for (const file of readdirSync(SRC).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(SRC, file), "utf8");
      const code = text.replace(/\/\/.*$|^\s*\*.*$/gm, "");
      if (/\bCLAWTRATE_WORK_CONTEXT\b/.test(code)) uses.push(`${file}: marker`);
      if (/\bchatSendParams\(/.test(code)) uses.push(`${file}: chatSendParams`);
      if (/workContext\s*:/.test(code)) uses.push(`${file}: workContext`);
    }
    expect(uses.sort()).toEqual([
      "client.ts: chatSendParams",
      // Only to take it off, for a resend the gateway refused it on.
      "client.ts: workContext",
      "send-marker.ts: marker",
      "send-size.ts: chatSendParams",
      "send-size.ts: marker",
      "send-size.ts: workContext",
    ]);
    // The one `chat.send` the client makes is `deliver`'s.
    const client = readFileSync(join(SRC, "client.ts"), "utf8");
    expect(client.match(/request\(\s*"chat\.send"/g)).toHaveLength(1);
  });
});
