// The atomic write writes every byte or fails before the rename, leaving the
// old file and the old rules in place. `writeSync` is replaced for the whole
// file: it writes at most a few bytes per call, or none at all.

import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ mode: "real" as "real" | "short" | "none" }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    writeSync: (fd: number, data: string | Uint8Array, ...rest: unknown[]) => {
      if (io.mode === "real")
        return (real.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
      if (io.mode === "none") return 0;
      // At most 7 bytes of what was asked, from the offset asked for.
      const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      const offset = typeof rest[0] === "number" ? rest[0] : 0;
      const length = typeof rest[1] === "number" ? rest[1] : buffer.length - offset;
      return real.writeSync(fd, buffer, offset, Math.min(7, length));
    },
  };
});

const { nextScope } = await import("../lib/rules.js");
const { RulesStore } = await import("../lib/store.js");
const { tempState } = await import("./harness.ts");

const cleanups: (() => void)[] = [];
afterEach(() => {
  io.mode = "real";
  cleanups.splice(0).forEach((done) => done());
});
const scope = (tool: string) =>
  nextScope(
    "otto",
    undefined,
    { rules: [{ action: "never", tools: [tool] }], fallback: false },
    {
      now: 1,
      setBy: null,
      newId: () => "0123456789ab",
    },
  );

describe("the atomic write", () => {
  it("keeps writing until every byte is written", () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "clawtrate-tool-rules");
    const store = new RulesStore(dir);
    const scopes = new Map([["otto", scope("write")]]);
    io.mode = "short";
    store.write(scopes);
    io.mode = "real";
    expect(new RulesStore(dir).scopes()).toEqual(scopes);
  });

  it("fails before the rename when a write makes no progress, keeping the old file and rules", () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "clawtrate-tool-rules");
    const store = new RulesStore(dir);
    const old = new Map([["otto", scope("write")]]);
    store.write(old);
    const before = readFileSync(join(dir, "rules.json"), "utf8");
    io.mode = "none";
    expect(() => store.write(new Map([["otto", scope("edit")]]))).toThrow(/no progress/);
    io.mode = "real";
    expect(readFileSync(join(dir, "rules.json"), "utf8")).toBe(before);
    expect(store.scopes()).toEqual(old);
    expect(fs.readdirSync(dir)).toEqual(["rules.json"]);
  });
});
