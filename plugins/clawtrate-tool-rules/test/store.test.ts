// The plugin's own files: the rules, written atomically and read again when
// they change on disk; the decision record, metadata only, for 30 days.

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextScope } from "../lib/rules.js";
import { DecisionLog, RETENTION_MS, RulesStore, hashCallId, serializeRules } from "../lib/store.js";
import { tempState } from "./harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((done) => done()));
const folder = () => {
  const { dir, done } = tempState();
  cleanups.push(done);
  return join(dir, "clawtrate-tool-rules");
};
/** A decision record set aside as oversized: when, then a random part. */
const SET_ASIDE = /^decisions\.jsonl\.oversize-\d+-[0-9a-f]{12}$/;
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
    expect(log.problem).toBeNull();
    expect(log.list({ limit: 5 }).records).toEqual([]);
    expect(readdirSync(dir)).toEqual([expect.stringMatching(SET_ASIDE)]);
    expect(log.listSetAside()).toEqual([{ file: readdirSync(dir)[0], setAsideAt: 1 }]);
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

describe("expired records on disk", () => {
  const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
  const onDisk = (dir: string, id: string) =>
    readFileSync(join(dir, "decisions.jsonl"), "utf8").includes(id);
  const listed = (log: DecisionLog, id: string) =>
    log.list({ limit: 100 }).records.some((record) => record.id === id);

  it("leave the file at the next prune, also when an ordinary append already dropped them", () => {
    const dir = folder();
    let now = 10_000;
    const log = new DecisionLog(dir, { now: () => now });
    const expired = log.add(fields);
    now += 86_400_000;
    for (let i = 0; i < 10; i += 1) log.add(fields);
    now = 10_000 + RETENTION_MS + 1;
    log.add(fields);
    log.prune();
    expect(listed(log, expired)).toBe(false);
    expect(onDisk(dir, expired)).toBe(false);
  });

  it("leave the file once it can be written again after a failed rewrite", () => {
    const base = folder();
    mkdirSync(base, { recursive: true });
    const dir = join(base, "record");
    const aside = join(base, "record-aside");
    mkdirSync(dir);
    let now = 10_000;
    const log = new DecisionLog(dir, { now: () => now });
    const id = log.add(fields);
    now += RETENTION_MS + 1;
    // The folder is briefly something that cannot be written.
    renameSync(dir, aside);
    writeFileSync(dir, "not a folder");
    log.prune();
    expect(log.problem).toMatch(/cannot be written/);
    rmSync(dir);
    renameSync(aside, dir);
    log.prune();
    expect(listed(log, id)).toBe(false);
    expect(onDisk(dir, id)).toBe(false);
    expect(log.problem).toBeNull();
  });
});

describe("a decision record whose last line is torn", () => {
  const fields = { agentId: "otto", tool: "read", decision: "none", source: null };

  it("is cut back at load, so the next record is not appended to the torn line", () => {
    const dir = folder();
    const log = new DecisionLog(dir, { now: () => 1 });
    for (let i = 0; i < 10; i += 1) log.add(fields);
    writeFileSync(
      join(dir, "decisions.jsonl"),
      `${readFileSync(join(dir, "decisions.jsonl"), "utf8")}{"id":"torn`,
    );
    const again = new DecisionLog(dir, { now: () => 2 });
    const id = again.add({ ...fields, tool: "write" });
    const reread = new DecisionLog(dir, { now: () => 3 });
    expect(reread.list({ limit: 50 }).records).toHaveLength(11);
    expect(reread.list({ limit: 1 }).records[0]?.id).toBe(id);
    expect(readFileSync(join(dir, "decisions.jsonl"), "utf8")).not.toContain('"torn');
  });
});

describe("a decision record set aside as oversized", () => {
  const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
  const day = 86_400_000;
  /** The record in `dir` grown past the byte cap. */
  const oversize = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "decisions.jsonl"), "", { flag: "a" });
    truncateSync(join(dir, "decisions.jsonl"), 64 * 1024 * 1024 + 1);
  };
  const setAside = (dir: string) => readdirSync(dir).filter((name) => name.includes("oversize"));

  it("is removed thirty days after it was set aside, and not before", () => {
    const dir = folder();
    oversize(dir);
    let now = 1_000 * day;
    const log = new DecisionLog(dir, { now: () => now });
    const [aside] = setAside(dir);
    expect(aside).toMatch(SET_ASIDE);
    now += 29 * day;
    log.prune();
    expect(setAside(dir)).toEqual([aside]);
    now += 2 * day;
    log.prune();
    expect(setAside(dir)).toEqual([]);
    expect(() => statSync(join(dir, aside!))).toThrow();
  });

  it("is said apart from the writes, through later writes and a restart, until it is removed", () => {
    const dir = folder();
    oversize(dir);
    let now = 1_000 * day;
    const log = new DecisionLog(dir, { now: () => now });
    const said = [{ file: expect.stringMatching(SET_ASIDE), setAsideAt: 1_000 * day }];
    expect(log.listSetAside()).toEqual(said);
    log.add(fields);
    expect(log.problem).toBeNull();
    expect(log.listSetAside()).toEqual(said);
    now += day;
    const restarted = new DecisionLog(dir, { now: () => now });
    restarted.add(fields);
    expect(restarted.problem).toBeNull();
    expect(restarted.listSetAside()).toEqual(said);
    // Deleted by hand: no longer said.
    rmSync(join(dir, restarted.listSetAside()![0]!.file));
    expect(restarted.listSetAside()).toEqual([]);
  });

  it("counts its thirty days from the time in its name across a restart, whatever its file's times", () => {
    const dir = folder();
    oversize(dir);
    let now = 1_000 * day;
    new DecisionLog(dir, { now: () => now }).add(fields);
    const [aside] = setAside(dir);
    // As a time that could not be recorded on it, or a copy, would leave it.
    const old = (now - 60 * day) / 1000;
    utimesSync(join(dir, aside!), old, old);
    now += day;
    const restarted = new DecisionLog(dir, { now: () => now });
    restarted.prune();
    expect(setAside(dir)).toEqual([aside]);
    now = 1_031 * day;
    restarted.prune();
    expect(setAside(dir)).toEqual([]);
  });

  it("keeps each record set aside under a name of its own, each removed at its own time", () => {
    const dir = folder();
    oversize(dir);
    let now = 1_000 * day;
    new DecisionLog(dir, { now: () => now }).add(fields);
    now += 10 * day;
    // The new record grows past the cap too, and is set aside at the next start.
    oversize(dir);
    const log = new DecisionLog(dir, { now: () => now });
    expect(setAside(dir)).toHaveLength(2);
    expect(log.listSetAside()?.map((aside) => aside.setAsideAt)).toEqual([
      1_000 * day,
      1_010 * day,
    ]);
    for (const aside of setAside(dir)) {
      expect(statSync(join(dir, aside)).size).toBe(64 * 1024 * 1024 + 1);
    }
    now = 1_031 * day;
    log.prune();
    expect(log.listSetAside()?.map((aside) => aside.setAsideAt)).toEqual([1_010 * day]);
    now = 1_041 * day;
    log.prune();
    expect(setAside(dir)).toEqual([]);
    expect(log.listSetAside()).toEqual([]);
  });

  // Windows makes links only with a privilege the test cannot count on.
  it.skipIf(process.platform === "win32")(
    "is not made of a link to an oversized record, which stays in place and is said",
    () => {
      const dir = folder();
      const elsewhere = folder();
      oversize(elsewhere);
      mkdirSync(dir, { recursive: true });
      symlinkSync(join(elsewhere, "decisions.jsonl"), join(dir, "decisions.jsonl"));
      const log = new DecisionLog(dir, { now: () => 1_000 * day });
      expect(log.problem).toMatch(/could not be set aside \(not a plain file\)/);
      expect(lstatSync(join(dir, "decisions.jsonl")).isSymbolicLink()).toBe(true);
      expect(setAside(dir)).toEqual([]);
      expect(log.listSetAside()).toEqual([]);
    },
  );

  it("is not said for a folder with a set-aside record's name", () => {
    const dir = folder();
    mkdirSync(join(dir, "decisions.jsonl.oversize-1-0123456789ab"), { recursive: true });
    mkdirSync(join(dir, "decisions.jsonl.oversize"));
    const log = new DecisionLog(dir, { now: () => 1_000 * day });
    expect(log.listSetAside()).toEqual([]);
  });

  it("reads one an earlier version set aside, by its last modification", () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    const legacy = join(dir, "decisions.jsonl.oversize");
    writeFileSync(legacy, "");
    let now = 1_000 * day;
    const at = now - 29 * day;
    utimesSync(legacy, at / 1000, at / 1000);
    const log = new DecisionLog(dir, { now: () => now });
    expect(log.listSetAside()).toEqual([{ file: "decisions.jsonl.oversize", setAsideAt: at }]);
    now += 2 * day;
    log.prune();
    expect(setAside(dir)).toEqual([]);
  });
});

describe("a record the cap evicted", () => {
  it("leaves the file once it is thirty days old, though newer records are kept", () => {
    const dir = folder();
    const day = 86_400_000;
    let now = 0;
    const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
    const log = new DecisionLog(dir, { now: () => now, max: 10 });
    const first = log.add(fields);
    now = 10 * day;
    // Ten more: the first is evicted, and one extra line is not enough for a compaction.
    for (let i = 0; i < 10; i += 1) log.add(fields);
    expect(log.list({ limit: 50 }).records.map((r) => r.id)).not.toContain(first);
    expect(readFileSync(join(dir, "decisions.jsonl"), "utf8")).toContain(first);
    now = 31 * day;
    log.prune();
    expect(readFileSync(join(dir, "decisions.jsonl"), "utf8")).not.toContain(first);
    expect(log.list({ limit: 50 }).records).toHaveLength(10);
  });
});
