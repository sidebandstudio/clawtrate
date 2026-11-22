import { describe, expect, it } from "vitest";
import * as L from "../lib/ledger.js";

const T = 1_800_000_000_000;
const bot = (n: number) => `b${n}`;
const proposal = (id: string, source: object, b = "pip", fields = ["label"], at = T) => ({
  id,
  digest: `d-${id}`,
  source,
  bot: b,
  fields,
  createdAt: at,
  expiresAt: at + L.EXPIRES_MS,
});
const fromBot = (b: string) => ({ kind: "bot", bot: b });
const agent = (grant: string, generation: number) => ({ kind: "agent", grant, generation });
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as L.Refusal).reason;
  }
  return "admitted";
};
const open = (l: ReturnType<typeof L.emptyLedger>) =>
  Object.values(l.proposals).filter((e) => (e as { state: string }).state === "open").length;

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

  it("supersedes the open proposal for the same bot and field, from any source, only when admitted", () => {
    const l = L.emptyLedger();
    L.admit(l, proposal("a", fromBot("pip")), T);
    expect(
      L.admit(l, proposal("b", fromBot("main"), "pip", ["label", "model"]), T).superseded,
    ).toEqual(["a"]);
    expect(l.proposals.a.state).toBe("superseded");
    expect(open(l)).toBe(1);
  });

  it("checks the grant's generation inside admission", () => {
    const l = L.emptyLedger();
    L.publishGrant(l, "g", { version: "gv1", digest: "x", expiresAt: T + 1e9 }, T);
    expect(reason(() => L.admit(l, proposal("p0", agent("g", 0)), T))).toBe("grant-generation");
    expect(reason(() => L.admit(l, proposal("p1", agent("g", 1)), T))).toBe("admitted");
    expect(reason(() => L.admit(l, proposal("p2", agent("nope", 1), "main"), T))).toBe(
      "grant-missing",
    );
  });
});

describe("grants", () => {
  it("revoking moves the generation on and withdraws open suggestions in the same change", () => {
    const l = L.emptyLedger();
    L.publishGrant(l, "g", { version: "gv1", digest: "x", expiresAt: T + 1e9 }, T);
    L.admit(l, proposal("p", agent("g", 1)), T);
    L.admit(l, proposal("q", fromBot("main"), "main"), T);
    expect(L.revoke(l, "g", T).generation).toBe(2);
    expect(l.proposals.p.state).toBe("withdrawn");
    expect(l.proposals.q.state).toBe("open");
    expect(reason(() => L.claim(l, "p", "d-p", T))).toBe("settled");
    expect(reason(() => L.admit(l, proposal("r", agent("g", 2), "main", ["model"]), T))).toBe(
      "grant-revoked",
    );
  });

  it("a new version of a grant withdraws the old generation's suggestions; an expired grant is revoked", () => {
    const l = L.emptyLedger();
    L.publishGrant(l, "g", { version: "gv1", digest: "x", expiresAt: T + 1000 }, T);
    L.admit(l, proposal("p", agent("g", 1)), T);
    expect(
      L.publishGrant(l, "g", { version: "gv2", digest: "y", expiresAt: T + 1000 }, T).generation,
    ).toBe(2);
    expect(l.proposals.p.state).toBe("withdrawn");
    L.admit(l, proposal("q", agent("g", 2), "main"), T);
    L.sweep(l, T + 1000);
    expect(l.grants.g.revoked).toBe("expired");
    expect(l.proposals.q.state).toBe("withdrawn");
  });
});

describe("decisions, expiry and retention", () => {
  it("a decline needs the digest shown, and settles once", () => {
    const l = L.emptyLedger();
    L.admit(l, proposal("p", fromBot("pip")), T);
    expect(reason(() => L.decline(l, "p", "other", "dev", T))).toBe("digest");
    L.decline(l, "p", "d-p", "dev", T);
    expect(l.proposals.p).toMatchObject({ state: "declined", by: "dev" });
    expect(reason(() => L.decline(l, "p", "d-p", "dev", T))).toBe("settled");
  });

  it("expires at 24 hours and removes settled entries after 30 days", () => {
    const l = L.emptyLedger();
    L.admit(l, proposal("p", fromBot("pip")), T);
    L.sweep(l, T + L.EXPIRES_MS - 1);
    expect(l.proposals.p.state).toBe("open");
    L.sweep(l, T + L.EXPIRES_MS);
    expect(l.proposals.p.state).toBe("expired");
    expect(L.sweep(l, T + L.EXPIRES_MS + L.RETAIN_MS)).toEqual(["p"]);
    expect(l.proposals.p).toBeUndefined();
  });

  it("a swept version can't be published, and a referenced one can't be swept", () => {
    const l = L.emptyLedger();
    L.admit(l, proposal("p", fromBot("pip")), T);
    expect(L.tombstone(l, "p", T + 1)).toBe(false);
    expect(L.tombstone(l, "orphan", T + 1)).toBe(true);
    expect(reason(() => L.admit(l, proposal("orphan", fromBot("main"), "main"), T))).toBe(
      "unpublishable",
    );
  });
});
