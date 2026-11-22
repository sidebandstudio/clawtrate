import { describe, expect, it } from "vitest";
import * as L from "../lib/ledger.js";

const T = 1_800_000_000_000;
const bot = (n: number | string, createdAt = 1) => ({ id: `b${n}`, createdAt });
const proposal = (id: string, source: object, b = bot("pip"), fields = ["label"], at = T) => ({
  id,
  digest: `d-${id}`,
  source,
  bot: b,
  fields,
  createdAt: at,
  expiresAt: at + L.EXPIRES_MS,
});
const fromBot = (b: string) => ({ kind: "bot", bot: b });
const agent = (grant: string, generation: number, version = "gv1") => ({
  kind: "agent",
  grant,
  generation,
  version,
});
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as L.Refusal).reason;
  }
  return "admitted";
};
const open = (l: ReturnType<typeof L.emptyLedger>) =>
  Object.values(l.proposals).filter((e) => e.state === "open").length;
const withGrant = (expiresAt = T + 1e9) => {
  const l = L.emptyLedger();
  L.publishGrant(l, "g", { version: "gv1", digest: "x", expiresAt }, null, T);
  return l;
};

describe("admission", () => {
  it("refuses a source's 21st open proposal, and the gateway's 201st", () => {
    const l = L.emptyLedger();
    for (let i = 0; i < 20; i += 1) L.admit(l, proposal(`s${i}`, fromBot("pip"), bot(i)), T);
    expect(reason(() => L.admit(l, proposal("s20", fromBot("pip"), bot(99)), T))).toBe(
      "source-limit",
    );
    for (let i = 20; i < 200; i += 1)
      L.admit(l, proposal(`g${i}`, fromBot(`src${i % 9}`), bot(i)), T);
    expect(open(l)).toBe(200);
    expect(reason(() => L.admit(l, proposal("x", fromBot("other"), bot(500)), T))).toBe(
      "open-limit",
    );
    expect(open(l)).toBe(200);
  });

  it("supersedes the open proposal for the same bot incarnation and field, only when admitted", () => {
    const l = L.emptyLedger();
    L.admit(l, proposal("a", fromBot("pip")), T);
    L.admit(l, proposal("other-life", fromBot("pip"), bot("pip", 2)), T);
    expect(
      L.admit(l, proposal("b", fromBot("main"), bot("pip"), ["label", "model"]), T).superseded,
    ).toEqual(["a"]);
    expect(l.proposals.a.state).toBe("superseded");
    expect(l.proposals["other-life"].state).toBe("open");
  });

  it("checks the grant's generation and version inside admission, and refuses an expired request", () => {
    const l = withGrant();
    expect(reason(() => L.admit(l, proposal("p0", agent("g", 0)), T))).toBe("grant-generation");
    expect(reason(() => L.admit(l, proposal("p1", agent("g", 1, "gv-old")), T))).toBe(
      "grant-generation",
    );
    expect(reason(() => L.admit(l, proposal("p2", agent("g", 1)), T))).toBe("admitted");
    expect(reason(() => L.admit(l, proposal("p3", agent("nope", 1), bot("main")), T))).toBe(
      "grant-missing",
    );
    expect(
      reason(() =>
        L.admit(l, proposal("p4", fromBot("pip"), bot(7), ["label"], T - L.EXPIRES_MS), T),
      ),
    ).toBe("expired");
  });

  it("looks up only its own keys", () => {
    const l = L.emptyLedger();
    expect(reason(() => L.revoke(l, "constructor", T))).toBe("grant-missing");
    expect(reason(() => L.claim(l, "__proto__", "x", T))).toBe("unknown");
    expect(reason(() => L.requireId("g", "toString", "id"))).toBe("invalid");
    expect(reason(() => L.requireId("p", `p_${"a".repeat(32)}`, "id"))).toBe("admitted");
  });
});

describe("grants", () => {
  it("revoking moves the generation on and withdraws open suggestions in the same change", () => {
    const l = withGrant();
    L.admit(l, proposal("p", agent("g", 1)), T);
    L.admit(l, proposal("q", fromBot("main"), bot("main")), T);
    expect(L.revoke(l, "g", T).generation).toBe(2);
    expect([l.proposals.p.state, l.proposals.q.state]).toEqual(["withdrawn", "open"]);
    expect(reason(() => L.claim(l, "p", "d-p", T))).toBe("settled");
    expect(reason(() => L.admit(l, proposal("r", agent("g", 2), bot("main"), ["model"]), T))).toBe(
      "grant-revoked",
    );
  });

  it("an update needs the generation it read, so it can't undo a revocation", () => {
    const l = withGrant(T + 1000);
    L.admit(l, proposal("p", agent("g", 1)), T);
    const next = { version: "gv2", digest: "y", expiresAt: T + 1000 };
    expect(reason(() => L.publishGrant(l, "g", next, null, T))).toBe("invalid");
    expect(L.publishGrant(l, "g", next, 1, T).generation).toBe(2);
    expect(l.proposals.p.state).toBe("withdrawn");
    L.revoke(l, "g", T);
    expect(reason(() => L.publishGrant(l, "g", { ...next, version: "gv3" }, 2, T))).toBe(
      "grant-generation",
    );
    expect(L.publishGrant(l, "g", { ...next, version: "gv3" }, 3, T)).toEqual({ generation: 4 });
    expect(l.grants.g).toMatchObject({ revoked: false, version: "gv3" });
    expect(reason(() => L.publishGrant(l, "new", next, 1, T))).toBe("grant-missing");
    expect(reason(() => L.publishGrant(l, "late", { ...next, expiresAt: T }, null, T))).toBe(
      "expired",
    );
  });

  it("only a version unreferenced for an hour in this epoch can be marked, one at a time", () => {
    const l = withGrant();
    L.admit(l, proposal("p", fromBot("pip")), T);
    const at = (now: number, epoch = "e") => ({ epoch, now });
    L.recordAges(l, ["p", "gv1", "orphan", "other"], at(0));
    expect(Object.keys(l.orphanAges!.since).sort()).toEqual(["orphan", "other"]);
    expect([
      L.markSweeping(l, "p", at(L.ORPHAN_MS)),
      L.markSweeping(l, "gv1", at(L.ORPHAN_MS)),
    ]).toEqual([false, false]);
    expect(L.markSweeping(l, "orphan", at(L.ORPHAN_MS - 1))).toBe(false);
    expect(L.markSweeping(l, "orphan", at(L.ORPHAN_MS, "another-process"))).toBe(false);
    expect(L.markSweeping(l, "orphan", at(L.ORPHAN_MS))).toBe(true);
    expect(L.markSweeping(l, "other", at(L.ORPHAN_MS))).toBe(false);
    expect(reason(() => L.admit(l, proposal("orphan", fromBot("main"), bot("main")), T))).toBe(
      "unpublishable",
    );
    L.clearSweeping(l, "orphan");
    expect(Object.keys(l.orphanAges!.since)).toEqual(["other"]);
    L.recordAges(l, [], at(5, "another-process"));
    expect(l.orphanAges).toBeUndefined();
  });

  it("an expired grant is revoked, and a revoked grant leaves after 30 days", () => {
    const l = withGrant(T + 1000);
    L.admit(l, proposal("q", agent("g", 1), bot("main")), T);
    L.sweep(l, T + 1000);
    expect([l.grants.g.revoked, l.proposals.q.state]).toEqual(["expired", "withdrawn"]);
    L.sweep(l, T + 1000 + L.RETAIN_MS - 1);
    expect(l.grants.g).toBeDefined();
    L.sweep(l, T + 1000 + L.RETAIN_MS);
    expect(l.grants.g).toBeUndefined();
  });
});

describe("decisions, expiry and size", () => {
  it("a decline needs the digest shown, an unexpired request, and settles once", () => {
    const l = L.emptyLedger();
    L.admit(l, proposal("p", fromBot("pip")), T);
    L.admit(l, proposal("e", fromBot("pip"), bot(2)), T);
    expect(reason(() => L.decline(l, "p", "other", "dev", T))).toBe("digest");
    L.decline(l, "p", "d-p", "dev", T);
    expect(l.proposals.p).toMatchObject({ state: "declined", by: "dev" });
    expect(reason(() => L.decline(l, "p", "d-p", "dev", T))).toBe("settled");
    expect(() => L.claim(l, "e", "d-e", T + L.EXPIRES_MS)).toThrow("already expired");
  });

  it("expires at 24 hours and removes settled entries after 30 days, however many", () => {
    const l = L.emptyLedger();
    for (let i = 0; i < 150; i += 1)
      L.admit(l, proposal(`p${i}`, fromBot(`s${i % 10}`), bot(i)), T);
    L.sweep(l, T + L.EXPIRES_MS - 1);
    expect(open(l)).toBe(150);
    L.sweep(l, T + L.EXPIRES_MS);
    expect(l.proposals.p0.state).toBe("expired");
    L.sweep(l, T + L.EXPIRES_MS + L.RETAIN_MS - 1);
    expect(Object.keys(l.proposals)).toHaveLength(150);
    L.sweep(l, T + L.EXPIRES_MS + L.RETAIN_MS);
    expect(Object.keys(l.proposals)).toHaveLength(0);
  });

  it("refuses a new request when the records would be full, and every open one can still settle", () => {
    // Each admission runs on a copy, kept only when admitted, as a transaction keeps it.
    let l = L.emptyLedger();
    const budget = 60_000;
    let admitted = 0;
    for (let i = 0; i < 200; i += 1) {
      const next = structuredClone(l);
      if (
        reason(() => L.admit(next, proposal(`p${i}`, fromBot(`s${i % 10}`), bot(i)), T, budget)) !==
        "admitted"
      )
        break;
      l = next;
      admitted += 1;
    }
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThan(200);
    expect(Object.keys(l.proposals)).toHaveLength(admitted);
    expect(
      reason(() => L.admit(structuredClone(l), proposal("x", fromBot("x"), bot("x")), T, budget)),
    ).toBe("records-full");
    for (let i = 0; i < admitted; i += 1) L.decline(l, `p${i}`, `d-p${i}`, "0123456789abcdef", T);
    // Settled, with the largest age map the sweep can hold (one entry per version row), it still fits.
    const since = Object.fromEntries(
      Array.from({ length: 512 }, (_, n) => [`p_${n.toString(16).padStart(32, "0")}`, 1e15 + n]),
    );
    const orphanAges = { epoch: "f".repeat(16), since };
    expect(
      Buffer.byteLength(
        JSON.stringify({ ...l, rev: 1e12, sweeping: `p_${"0".repeat(32)}`, orphanAges }),
      ),
    ).toBeLessThanOrEqual(budget);
  });
});
