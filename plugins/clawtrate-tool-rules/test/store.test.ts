// The plugin's own files: the rules, written atomically and read again when
// they change on disk; the decision record, metadata only, for 30 days.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextScope } from "../lib/rules.js";
import { DecisionLog, RulesStore, hashCallId, serializeRules } from "../lib/store.js";
import { tempState } from "./harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((done) => done()));
const folder = () => {
  const { dir, done } = tempState();
  cleanups.push(done);
  return join(dir, "clawtrate-tool-rules");
};
const scope = () =>
  nextScope(
    "otto",
    undefined,
    { rules: [{ action: "ask", tools: ["write"] }], fallback: false },
    {
      now: 1,
      setBy: null,
      newId: () => "0123456789ab",
    },
  );

describe("the rules store", () => {
  it("starts empty, and reads back what it wrote", () => {
    const dir = folder();
    const store = new RulesStore(dir);
    expect(store.scopes()).toEqual(new Map());
    expect(store.problem()).toBeNull();
    const scopes = new Map([["otto", scope()]]);
    store.write(scopes);
    expect(new RulesStore(dir).scopes()).toEqual(scopes);
    expect(statSync(join(dir, "rules.json")).mode & 0o777).toBe(0o600);
    // Nothing is left beside it: the temporary file was renamed over it.
    expect(readdirSync(dir)).toEqual(["rules.json"]);
  });

  it("is unavailable, and says why, when the file cannot be read as rules", () => {
    for (const [content, why] of [
      ["{not json", /not JSON/],
      [JSON.stringify({ format: "other", schema: 1, scopes: {} }), /not a rules store/],
      [JSON.stringify({ format: "clawtrate-tool-rules", schema: 2, scopes: {} }), /schema 2/],
      [
        JSON.stringify({
          format: "clawtrate-tool-rules",
          schema: 1,
          scopes: { otto: { version: 1, fallback: false, rules: [{ action: "maybe" }] } },
        }),
        /rule 1/,
      ],
    ] as const) {
      const dir = folder();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "rules.json"), content);
      const store = new RulesStore(dir);
      expect(store.scopes()).toBeNull();
      expect(store.problem()).toMatch(why);
    }
  });

  it("reads the file again when it changes on disk, and says so", () => {
    const dir = folder();
    const store = new RulesStore(dir);
    let changes = 0;
    store.onExternalChange = () => (changes += 1);
    store.write(new Map([["otto", scope()]]));
    expect(store.scopes()?.size).toBe(1);
    expect(changes).toBe(0);
    writeFileSync(join(dir, "rules.json"), "garbage that is longer than before");
    expect(store.scopes()).toBeNull();
    expect(changes).toBe(1);
    writeFileSync(join(dir, "rules.json"), JSON.stringify(serializeRules(new Map())));
    expect(store.scopes()).toEqual(new Map());
    expect(changes).toBe(2);
  });
});

describe("the decision record", () => {
  const fields = {
    agentId: "otto",
    sessionKey: "agent:otto:main",
    runId: "run-1",
    callId: hashCallId("call_1"),
    tool: "write",
    decision: "ask",
    source: { kind: "rule", scope: "otto", ruleId: "0123456789ab", version: 1, action: "ask" },
  };

  it("hashes a call id exactly as the gateway's audit log does", () => {
    expect(hashCallId("call_1")).toBe(
      `sha256:${createHash("sha256").update("call_1").digest("hex")}`,
    );
    expect(hashCallId("")).toBeNull();
    expect(hashCallId(undefined)).toBeNull();
  });

  it("keeps metadata only, and the answer to an ask as its decision word", () => {
    const dir = folder();
    const log = new DecisionLog(dir, { now: () => 5000 });
    const id = log.add({ ...fields, params: { path: "secrets/key" }, result: "text" });
    log.answer(id, "deny");
    const [record] = log.list({ limit: 10 }).records;
    expect(Object.keys(record!).sort()).toEqual(
      [
        "agentId",
        "answer",
        "answeredAt",
        "at",
        "callId",
        "decision",
        "id",
        "rules",
        "runId",
        "sessionKey",
        "source",
        "tool",
      ].sort(),
    );
    expect(record).toMatchObject({ ...fields, answer: "deny", at: 5000, answeredAt: 5000 });
    const file = readFileSync(join(dir, "decisions.jsonl"), "utf8");
    expect(file).not.toMatch(/secrets\/key|call_1|params|result/);
    // Read again from the file, answer joined.
    expect(new DecisionLog(dir, { now: () => 5000 }).list({ limit: 10 }).records).toEqual([record]);
  });

  it("keeps 30 days, newest first, filtered", () => {
    let now = 0;
    const dir = folder();
    const day = 86_400_000;
    const log = new DecisionLog(dir, { now: () => now });
    log.add({ ...fields, runId: "old" });
    now = 10 * day;
    log.add({ ...fields, runId: "mid", agentId: "pip" });
    now = 20 * day;
    log.add({ ...fields, runId: "new" });
    expect(log.list({ limit: 10 }).records.map((r) => r.runId)).toEqual(["new", "mid", "old"]);
    expect(log.list({ agentId: "pip", limit: 10 }).records.map((r) => r.runId)).toEqual(["mid"]);
    expect(log.list({ limit: 1 })).toMatchObject({ hasMore: true });
    expect(log.list({ before: 20 * day, limit: 10 }).records.map((r) => r.runId)).toEqual([
      "mid",
      "old",
    ]);
    now = 31 * day;
    expect(log.list({ limit: 10 }).records.map((r) => r.runId)).toEqual(["new", "mid"]);
    log.add({ ...fields, runId: "latest" });
    // Expired records leave the file too.
    const reread = new DecisionLog(dir, { now: () => now });
    expect(reread.list({ limit: 10 }).records.map((r) => r.runId)).toEqual([
      "latest",
      "new",
      "mid",
    ]);
    expect(readFileSync(join(dir, "decisions.jsonl"), "utf8")).not.toMatch(/"old"/);
  });

  it("is bounded: past its cap the oldest go first", () => {
    const dir = folder();
    let now = 0;
    const log = new DecisionLog(dir, { now: () => ++now, max: 5 });
    for (let i = 0; i < 12; i += 1) log.add({ ...fields, runId: `r${i}` });
    expect(log.list({ limit: 50 }).records.map((r) => r.runId)).toEqual([
      "r11",
      "r10",
      "r9",
      "r8",
      "r7",
    ]);
    expect(
      readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n").length,
    ).toBeLessThanOrEqual(6);
  });

  it("skips a torn line", () => {
    const dir = folder();
    const log = new DecisionLog(dir, { now: () => 1 });
    log.add(fields);
    writeFileSync(
      join(dir, "decisions.jsonl"),
      `${readFileSync(join(dir, "decisions.jsonl"), "utf8")}{"id":`,
    );
    expect(new DecisionLog(dir, { now: () => 1 }).list({ limit: 5 }).records).toHaveLength(1);
  });
});

describe("the decision record's own bounds", () => {
  const fields = { agentId: "otto", tool: "read", decision: "none", source: null };

  it("sets aside a file past its byte cap instead of reading it", () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "decisions.jsonl"), Buffer.alloc(64 * 1024 * 1024 + 1, 10));
    const log = new DecisionLog(dir, { now: () => 1 });
    expect(log.problem).toMatch(/set aside as decisions\.jsonl\.oversize/);
    expect(log.list({ limit: 5 }).records).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["decisions.jsonl.oversize"]);
  });

  it("past its cap, does not rewrite the whole file for each new record", () => {
    const dir = folder();
    let now = 0;
    const log = new DecisionLog(dir, { now: () => ++now, max: 100 });
    for (let i = 0; i < 100; i += 1) log.add(fields);
    const inode = statSync(join(dir, "decisions.jsonl")).ino;
    let rewrites = 0;
    let last = inode;
    for (let i = 0; i < 100; i += 1) {
      log.add(fields);
      const current = statSync(join(dir, "decisions.jsonl")).ino;
      if (current !== last) rewrites += 1;
      last = current;
    }
    expect(rewrites).toBeLessThanOrEqual(5);
    expect(log.list({ limit: 500 }).records).toHaveLength(100);
    expect(
      readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n").length,
    ).toBeLessThanOrEqual(121);
  });
});

describe("a known lost policy", () => {
  it("stays lost when its file goes, until a valid store is read", () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rules.json");
    writeFileSync(file, "{ not rules");
    const store = new RulesStore(dir);
    const lost = (view: ReturnType<RulesStore["view"]>) => [view.kind, view.enforced, view.kept];
    expect(lost(store.view())).toEqual(["lost", null, null]);
    rmSync(file);
    expect(lost(store.view())).toEqual(["lost", null, null]);
    expect(store.view().problem).toBe("the rules file is gone");
    writeFileSync(file, JSON.stringify({ format: "clawtrate-tool-rules", schema: 1 }));
    expect(lost(store.view())).toEqual(["lost", null, null]);
    writeFileSync(file, JSON.stringify(serializeRules(new Map())));
    expect(store.view()).toMatchObject({ kind: "read", enforced: new Map(), kept: null });
  });
});
