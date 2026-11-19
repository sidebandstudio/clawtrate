// The plugin's files when the filesystem fails, with the failures injected
// here so each case holds whatever the process may read or write: a rules
// file whose contents could not be read is read again at the next look (bad
// contents are remembered until the file changes); a torn last line of the
// decision record that cannot be cut gets nothing appended after it; and a
// record that could not be written is written with the rest once the disk
// recovers, the problem said until then.

import type * as fs from "node:fs";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  failures: 0,
  code: "EIO",
  path: "",
  reads: 0,
  truncateFails: false,
  appendFails: 0,
  utimesFails: false,
  renameFails: false,
  /** Run once right after the next rename: another writer replacing the file. */
  afterRename: null as null | (() => void),
  /** Closing a temporary file fails this many more times, after it is closed. */
  tempCloseFails: 0,
  /** Run once just before `io.path` is next opened to be appended to or cut. */
  beforeWriteOpen: null as null | (() => void),
  /** The path each open descriptor was opened on. */
  fds: new Map<number, string>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (String(args[0]) === io.path && typeof args[1] === "number") {
        const before = io.beforeWriteOpen;
        io.beforeWriteOpen = null;
        before?.();
      }
      const fd = real.openSync(...args);
      io.fds.set(fd, String(args[0]));
      return fd;
    },
    closeSync: (fd: number) => {
      const path = io.fds.get(fd) ?? "";
      io.fds.delete(fd);
      real.closeSync(fd);
      if (io.tempCloseFails > 0 && path.endsWith(".tmp")) {
        io.tempCloseFails -= 1;
        throw Object.assign(new Error("injected"), { code: "ENOSPC" });
      }
    },
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      // By path, or by a descriptor opened on it.
      const path = typeof args[0] === "number" ? io.fds.get(args[0]) : String(args[0]);
      if (path === io.path) io.reads += 1;
      if (io.failures > 0 && path === io.path) {
        io.failures -= 1;
        throw Object.assign(new Error("injected"), { code: io.code });
      }
      return real.readFileSync(...args);
    },
    appendFileSync: (...args: Parameters<typeof real.appendFileSync>) => {
      if (io.appendFails > 0) {
        io.appendFails -= 1;
        throw Object.assign(new Error("injected"), { code: "ENOSPC" });
      }
      return real.appendFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      if (io.renameFails) throw Object.assign(new Error("injected"), { code: "ENOSPC" });
      real.renameSync(...args);
      const after = io.afterRename;
      io.afterRename = null;
      after?.();
    },
    utimesSync: (...args: Parameters<typeof real.utimesSync>) => {
      if (io.utimesFails) throw Object.assign(new Error("injected"), { code: "ENOSPC" });
      return real.utimesSync(...args);
    },
    ftruncateSync: (...args: Parameters<typeof real.ftruncateSync>) => {
      if (io.truncateFails) throw Object.assign(new Error("injected"), { code: "EIO" });
      return real.ftruncateSync(...args);
    },
  };
});

const actual = await vi.importActual<typeof fs>("node:fs");
const { nextScope } = await import("../lib/rules.js");
const { DecisionLog, RulesStore, serializeRules } = await import("../lib/store.js");
const { tempState } = await import("./harness.ts");

const cleanups: (() => void)[] = [];
afterEach(() => {
  io.failures = 0;
  io.truncateFails = false;
  io.appendFails = 0;
  io.renameFails = false;
  io.utimesFails = false;
  io.afterRename = null;
  io.beforeWriteOpen = null;
  io.tempCloseFails = 0;
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

describe("a torn last line that cannot be cut", () => {
  it("gets nothing appended after it, and the record says so", () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
    const log = new DecisionLog(dir, { now: () => 1 });
    // Enough records that one torn line does not make the file due for a rewrite.
    for (let i = 0; i < 10; i += 1) log.add(fields);
    const file = join(dir, "decisions.jsonl");
    const torn = `${readFileSync(file, "utf8")}{"id":"torn`;
    writeFileSync(file, torn);
    io.truncateFails = true;
    io.renameFails = true;
    const again = new DecisionLog(dir, { now: () => 2 });
    // The cut failed, and so did the whole rewrite tried after it.
    expect(again.problem).toMatch(/cannot be written \(ENOSPC\)/);
    expect(readFileSync(file, "utf8")).toBe(torn);
    const id = again.add({ ...fields, tool: "write" });
    expect(readFileSync(file, "utf8")).toBe(torn);
    expect(again.problem).not.toBeNull();
    // Once the disk takes a write, the whole record is written, torn line gone.
    io.truncateFails = false;
    io.renameFails = false;
    again.add({ ...fields, tool: "edit" });
    expect(again.problem).toBeNull();
    expect(readFileSync(file, "utf8")).not.toContain('"torn');
    const reread = new DecisionLog(dir, { now: () => 3 }).list({ limit: 50 }).records;
    expect(reread).toHaveLength(12);
    expect(reread.map((r) => r.id)).toContain(id);
  });
});

describe("a decision that could not be written", () => {
  it("keeps the problem said, and is written with the rest once the disk recovers", () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
    const ids = (log: InstanceType<typeof DecisionLog>) =>
      log.list({ limit: 100 }).records.map((r) => r.id);
    const log = new DecisionLog(dir, { now: () => 1 });
    for (let i = 0; i < 10; i += 1) log.add(fields);
    io.appendFails = 1;
    const a = log.add({ ...fields, tool: "write" });
    expect(log.problem).toMatch(/cannot be written/);
    // The disk is still failing for a rewrite: the problem stays, though an append would work.
    io.renameFails = true;
    const b = log.add({ ...fields, tool: "edit" });
    expect(log.problem).toMatch(/cannot be written/);
    expect(ids(new DecisionLog(dir, { now: () => 1 }))).not.toContain(a);
    // Recovered: the next write puts every retained record on disk, and only then is it clear.
    io.renameFails = false;
    const c = log.add({ ...fields, tool: "ls" });
    expect(log.problem).toBeNull();
    const reread = ids(new DecisionLog(dir, { now: () => 1 }));
    for (const id of [a, b, c]) expect(reread).toContain(id);
    expect(reread).toHaveLength(13);
  });
});

describe("a save replaced by another writer before it is looked at", () => {
  it("is not taken as read: the next look reads the file there", () => {
    const rules = store();
    const replacement = new Map([["otto", scope("edit")]]);
    io.afterRename = () =>
      writeFileSync(io.path, `${JSON.stringify(serializeRules(replacement), null, 2)}\n`);
    rules.write(new Map([["otto", scope("write")]]));
    expect(rules.view().enforced).toEqual(replacement);
  });
});

describe("a decision that could not be written, on an idle gateway", () => {
  it("is written by the next hourly maintenance, which alone clears it", () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
    const log = new DecisionLog(dir, { now: () => 1 });
    io.appendFails = 1;
    const id = log.add(fields);
    expect(log.problem).toMatch(/cannot be written/);
    // No more calls. Maintenance while the disk still fails keeps it unsaved.
    io.renameFails = true;
    log.prune();
    expect(log.problem).toMatch(/cannot be written/);
    io.renameFails = false;
    log.prune();
    expect(log.problem).toBeNull();
    const reread = new DecisionLog(dir, { now: () => 1 }).list({ limit: 10 }).records;
    expect(reread.map((r) => r.id)).toEqual([id]);
  });
});

describe("a decision record that could not be read at start", () => {
  it("is read again before anything is written, so no record joins a torn line", () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const file = join(dir, "decisions.jsonl");
    // Read past the injected failures, which are for the plugin's reads.
    const disk = (path: string) => actual.readFileSync(path, "utf8");
    const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
    const first = new DecisionLog(dir, { now: () => 1 });
    for (let i = 0; i < 10; i += 1) first.add(fields);
    const torn = `${disk(file)}{"id":"torn`;
    writeFileSync(file, torn);
    io.path = file;
    // Unreadable at start, at the first write and at the next maintenance.
    io.failures = 3;
    const log = new DecisionLog(dir, { now: () => 2 });
    expect(log.problem).toMatch(/cannot be read \(EIO\)/);
    const a = log.add({ ...fields, tool: "write" });
    expect(disk(file)).toBe(torn);
    expect(log.problem).toMatch(/cannot be read/);
    log.prune();
    expect(disk(file)).toBe(torn);
    // Readable again: the next write reads it, cuts the torn line, and writes it all.
    const b = log.add({ ...fields, tool: "edit" });
    expect(log.problem).toBeNull();
    const reread = new DecisionLog(dir, { now: () => 3 }).list({ limit: 50 }).records;
    expect(reread).toHaveLength(12);
    expect(reread.slice(0, 2).map((r) => r.id)).toEqual([b, a]);
    expect(disk(file)).not.toContain('"torn');
  });
});

describe("a rewrite whose temporary file cannot be closed", () => {
  it("leaves no temporary file behind, however often the idle retry fails", () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const file = join(dir, "decisions.jsonl");
    const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
    const log = new DecisionLog(dir, { now: () => 1 });
    const ids = Array.from({ length: 10 }, () => log.add(fields));
    const original = readFileSync(file, "utf8");
    io.appendFails = 1;
    ids.push(log.add(fields));
    io.tempCloseFails = 2;
    log.prune();
    log.prune();
    expect(log.problem).toMatch(/cannot be written \(ENOSPC\)/);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(original);
    log.prune();
    expect(log.problem).toBeNull();
    const reread = new DecisionLog(dir, { now: () => 1 }).list({ limit: 50 }).records;
    expect(reread.map((r) => r.id).sort()).toEqual([...ids].sort());
  });
});

describe("a decision record that cannot be read at all", () => {
  it("keeps memory within its cap and the file untouched", () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const file = join(dir, "decisions.jsonl");
    const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
    const first = new DecisionLog(dir, { now: () => 1 });
    for (let i = 0; i < 10; i += 1) first.add(fields);
    const original = actual.readFileSync(file, "utf8");
    io.path = file;
    io.failures = Number.POSITIVE_INFINITY;
    let now = 1;
    const log = new DecisionLog(dir, { now: () => ++now, max: 10 });
    const ids = Array.from({ length: 12 }, () => log.add(fields));
    expect(log.list({ limit: 50 }).records.map((r) => r.id)).toEqual(ids.slice(2).reverse());
    expect(log.byId.size).toBe(10);
    expect(log.problem).toMatch(/cannot be read \(EIO\)/);
    expect(actual.readFileSync(file, "utf8")).toBe(original);
  });
});

describe("a record the cap evicted, when its expiry cannot be rewritten", () => {
  it("stays said through a later append, until a rewrite removes it", () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const file = join(dir, "decisions.jsonl");
    const day = 86_400_000;
    let now = 0;
    const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
    // Twenty kept: an evicted line or two stays below a fifth, so no compaction rewrites it.
    const log = new DecisionLog(dir, { now: () => now, max: 20 });
    const first = log.add(fields);
    now = 10 * day;
    for (let i = 0; i < 20; i += 1) log.add(fields);
    now = 31 * day;
    io.renameFails = true;
    log.prune();
    expect(log.problem).toMatch(/cannot be written \(ENOSPC\)/);
    // An append succeeds while rewrites still fail: the expired line is still there, and said.
    log.add(fields);
    expect(readFileSync(file, "utf8")).toContain(first);
    expect(log.problem).toMatch(/cannot be written \(ENOSPC\)/);
    io.renameFails = false;
    log.prune();
    expect(readFileSync(file, "utf8")).not.toContain(first);
    expect(log.problem).toBeNull();
  });
});

describe("decisions held while the record could not be read, and another writer's", () => {
  const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
  const setUp = () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const file = join(dir, "decisions.jsonl");
    const first = new DecisionLog(dir, { now: () => 100 });
    const seeded = Array.from({ length: 10 }, () => first.add(fields));
    io.path = file;
    // Unreadable at start and at the first decision, which is held in memory.
    io.failures = 2;
    const log = new DecisionLog(dir, { now: () => 110, max: 11 });
    const held = log.add(fields);
    expect(log.problem).toMatch(/cannot be read/);
    return { dir, file, log, seeded, held };
  };
  const lines = (file: string) =>
    actual
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string });

  it("are merged in time order once it can be read, the oldest evicted first", () => {
    const { file, log, seeded, held } = setUp();
    const outside = { ...fields, id: "outside0000000000", at: 120 };
    actual.appendFileSync(file, `${JSON.stringify(outside)}\n`);
    log.prune();
    expect(log.problem).toBeNull();
    const listed = log.list({ limit: 50 }).records.map((r) => r.id);
    expect(listed.slice(0, 2)).toEqual([outside.id, held]);
    expect(listed).toHaveLength(11);
    expect(listed).not.toContain(seeded[0]);
    expect(lines(file).map((r) => r.id)).toEqual([...seeded.slice(1), held, outside.id]);
  });

  it("are written once when the other writer already copied the held one", () => {
    const { file, log, seeded, held } = setUp();
    const copy = log.list({ limit: 1 }).records[0];
    actual.appendFileSync(file, `${JSON.stringify(copy)}\n`);
    log.prune();
    expect(log.problem).toBeNull();
    expect(lines(file).map((r) => r.id)).toEqual([...seeded, held]);
  });
});

describe("recovery of a decision record", () => {
  const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
  const seed = () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const file = join(dir, "decisions.jsonl");
    const first = new DecisionLog(dir, { now: () => 100 });
    const seeded = Array.from({ length: 10 }, () => first.add(fields));
    io.path = file;
    return { dir, file, seeded };
  };
  const ids = (file: string) =>
    actual
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { id: string }).id);
  /** Unreadable at start and at the first decision, which is held in memory. */
  const holding = (dir: string) => {
    io.failures = 2;
    const log = new DecisionLog(dir, { now: () => 110 });
    const held = log.add(fields);
    expect(log.problem).toMatch(/cannot be read \(EIO\)/);
    return { log, held };
  };

  it("clears a read error at the first idle maintenance that reads it, with nothing held", () => {
    const { dir, file, seeded } = seed();
    const before = actual.readFileSync(file, "utf8");
    io.failures = 1;
    const log = new DecisionLog(dir, { now: () => 110 });
    expect(log.problem).toMatch(/cannot be read \(EIO\)/);
    log.prune();
    expect(log.problem).toBeNull();
    expect(log.list({ limit: 50 }).records.map((r) => r.id)).toEqual([...seeded].reverse());
    expect(actual.readFileSync(file, "utf8")).toBe(before);
  });

  for (const ending of ["whole", "torn"] as const) {
    it(`repairs a ${ending} last line that could not be repaired at start, at the first idle maintenance`, () => {
      const { dir, file, seeded } = seed();
      const text = actual.readFileSync(file, "utf8");
      writeFileSync(file, ending === "whole" ? text.trimEnd() : `${text}{"id":"torn`);
      if (ending === "whole") io.appendFails = 1;
      else io.truncateFails = true;
      io.renameFails = true;
      const log = new DecisionLog(dir, { now: () => 110 });
      expect(log.problem).not.toBeNull();
      io.truncateFails = false;
      io.renameFails = false;
      log.prune();
      expect(log.problem).toBeNull();
      expect(actual.readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
      expect(ids(file)).toEqual(seeded);
    });
  }

  it("writes what it held at the first maintenance after the record was removed", () => {
    const { dir, file } = seed();
    const { log, held } = holding(dir);
    actual.rmSync(file);
    log.prune();
    expect(log.problem).toBeNull();
    expect(ids(file)).toEqual([held]);
  });

  it("writes what it held at the first maintenance that sets an oversized record aside", () => {
    const { dir, file } = seed();
    const { log, held } = holding(dir);
    actual.truncateSync(file, 64 * 1024 * 1024 + 1);
    log.prune();
    expect(log.problem).toBeNull();
    expect(ids(file)).toEqual([held]);
    expect(actual.statSync(`${file}.oversize`).size).toBe(64 * 1024 * 1024 + 1);
  });

  it("says when the oversized record cannot be set aside, and sets it aside at the next maintenance", () => {
    const { dir, file } = seed();
    const { log, held } = holding(dir);
    actual.truncateSync(file, 64 * 1024 * 1024 + 1);
    io.renameFails = true;
    log.prune();
    expect(log.problem).toMatch(/could not be set aside \(ENOSPC\)/);
    expect(actual.statSync(file).size).toBe(64 * 1024 * 1024 + 1);
    io.renameFails = false;
    log.prune();
    expect(log.problem).toBeNull();
    expect(ids(file)).toEqual([held]);
  });

  it("writes what it held though the set-aside record's time cannot be recorded, and records it later", () => {
    const { dir, file } = seed();
    const { log, held } = holding(dir);
    actual.truncateSync(file, 64 * 1024 * 1024 + 1);
    io.utimesFails = true;
    log.prune();
    expect(log.problem).toBeNull();
    expect(ids(file)).toEqual([held]);
    io.utimesFails = false;
    log.prune();
    expect(actual.statSync(`${file}.oversize`).mtimeMs).toBe(110);
  });

  it("says a failed time on the set-aside record apart from a read error", () => {
    const { dir, file } = seed();
    actual.truncateSync(file, 64 * 1024 * 1024 + 1);
    io.utimesFails = true;
    const log = new DecisionLog(dir, { now: () => 110 });
    expect(log.problem).toMatch(
      /set aside as decisions\.jsonl\.oversize, but when could not be recorded/,
    );
    expect(log.problem).not.toMatch(/cannot be read/);
  });
});

describe("a decision record changed from outside", () => {
  const fields = { agentId: "otto", tool: "read", decision: "none", source: null };
  const seed = () => {
    const { dir: state, done } = tempState();
    cleanups.push(done);
    const dir = join(state, "decisions");
    const file = join(dir, "decisions.jsonl");
    const log = new DecisionLog(dir, { now: () => 100 });
    const seeded = Array.from({ length: 10 }, () => log.add(fields));
    io.path = file;
    return { dir, file, log, seeded };
  };
  const ids = (file: string) =>
    actual
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { id: string }).id);
  const outsider = `${JSON.stringify({ ...fields, id: "outside0000000000", at: 105 })}\n`;

  it("keeps a line added from outside before an idle retry, and says the retry waits", () => {
    const { dir, file, log, seeded } = seed();
    io.appendFails = 1;
    const pending = log.add(fields);
    actual.appendFileSync(file, outsider);
    const before = actual.readFileSync(file, "utf8");
    log.prune();
    expect(log.problem).toBe("the decision record changed on disk; waiting to read it again");
    expect(actual.readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    log.prune();
    expect(log.problem).toBeNull();
    expect(ids(file).sort()).toEqual([...seeded, pending, "outside0000000000"].sort());
  });

  for (const change of ["removed", "emptied", "replaced"] as const) {
    it(`writes every record it holds after the file was ${change}`, () => {
      const { file, log, seeded } = seed();
      if (change === "removed") actual.rmSync(file);
      if (change === "emptied") actual.truncateSync(file, 0);
      if (change === "replaced") {
        actual.writeFileSync(`${file}.new`, outsider);
        actual.renameSync(`${file}.new`, file);
      }
      const next = log.add(fields);
      expect(log.problem).toBeNull();
      const expected = [...seeded, next, ...(change === "replaced" ? ["outside0000000000"] : [])];
      expect(ids(file).sort()).toEqual(expected.sort());
    });
  }

  it("never cuts a file put in place of one with a torn last line", () => {
    const { dir, file, seeded } = seed();
    actual.appendFileSync(file, '{"id":"torn');
    io.beforeWriteOpen = () => {
      actual.writeFileSync(`${file}.new`, outsider);
      actual.renameSync(`${file}.new`, file);
    };
    const log = new DecisionLog(dir, { now: () => 110 });
    expect(actual.readFileSync(file, "utf8")).toBe(outsider);
    expect(log.problem).toBe("the decision record changed on disk; waiting to read it again");
    const next = log.add(fields);
    expect(log.problem).toBeNull();
    expect(actual.readFileSync(file, "utf8")).not.toContain('"torn');
    expect(ids(file).sort()).toEqual([...seeded, next, "outside0000000000"].sort());
  });
});
