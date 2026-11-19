// A rules file whose metadata was read but whose contents could not be (an
// I/O error, injected here, so the case holds whatever the process may
// read): the next refresh reads it again. Bad contents are remembered until
// the file changes.

import type * as fs from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ failures: 0, code: "EIO", path: "", reads: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      if (String(args[0]) === io.path) io.reads += 1;
      if (io.failures > 0 && String(args[0]) === io.path) {
        io.failures -= 1;
        throw Object.assign(new Error("injected"), { code: io.code });
      }
      return real.readFileSync(...args);
    },
  };
});

const { nextScope } = await import("../lib/rules.js");
const { RulesStore, serializeRules } = await import("../lib/store.js");
const { tempState } = await import("./harness.ts");

const cleanups: (() => void)[] = [];
afterEach(() => {
  io.failures = 0;
  cleanups.splice(0).forEach((done) => done());
});
const scope = (tool: string) =>
  nextScope(
    "otto",
    undefined,
    { rules: [{ action: "never", tools: [tool] }], fallback: false },
    { now: 1, setBy: null, newId: () => "0123456789ab" },
  );
const store = () => {
  const { dir, done } = tempState();
  cleanups.push(done);
  const folder = join(dir, "clawtrate-tool-rules");
  const rules = new RulesStore(folder);
  io.path = join(folder, "rules.json");
  return rules;
};

describe("a read that fails with an I/O error", () => {
  it("is tried again at the next refresh, without the file changing", () => {
    const rules = store();
    rules.write(new Map([["otto", scope("write")]]));
    const replacement = new Map([["otto", scope("edit")]]);
    writeFileSync(io.path, `${JSON.stringify(serializeRules(replacement), null, 2)}\n`);
    io.failures = 1;
    const failed = rules.view();
    expect(failed.kind).toBe("lost");
    expect(failed.problem).toBe("the rules file cannot be read (EIO)");
    // The copy read before is still enforced while the read fails.
    expect(failed.enforced?.get("otto")?.rules[0]?.tools).toEqual(["write"]);
    const again = rules.view();
    expect(again.kind).toBe("read");
    expect(again.enforced).toEqual(replacement);
  });

  it("keeps bad contents remembered until the file changes", () => {
    const rules = store();
    rules.write(new Map([["otto", scope("write")]]));
    writeFileSync(io.path, "{ not rules, and longer than before }");
    expect(rules.view().problem).toBe("the rules file is not JSON");
    const reads = io.reads;
    // Looked at again, the same bad file is not read again.
    expect(rules.view().problem).toBe("the rules file is not JSON");
    expect(io.reads).toBe(reads);
  });
});
