// Approving a waiting device (setup-effortless.md §5): the code, and each outcome of a pick.
import { describe, expect, it } from "vitest";
import { sha256Hex, toBase64, utf8Bytes } from "../src/bytes.ts";
import {
  DeviceApprovals,
  MAX_COLLIDED,
  MAX_DEVICE_REQUESTS,
  PAIR_CODE_CHARS,
  PAIR_CODE_CHOICES,
  codeChoices,
  pairCode,
  spokenCode,
  type DeviceRequestsState,
} from "../src/device-approval.ts";
import { FULL_SCOPES } from "../src/scopes.ts";
import { enforceState } from "../src/state-bounds.ts";
import { initialState } from "../src/types.ts";

let keys = 0;
/**
 * A new 32-byte public key as the gateway lists it: base64url, and its hex SHA-256 as the device
 * id. The code reads only the bytes, so any 32 distinct bytes stand in for an Ed25519 key.
 */
function newKey() {
  const raw = Uint8Array.from(sha256Hex(utf8Bytes(`key ${(keys += 1)}`)).match(/../g)!, (pair) =>
    parseInt(pair, 16),
  );
  return {
    publicKey: toBase64(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    deviceId: sha256Hex(raw),
  };
}

type Row = Record<string, unknown>;
const pendingRow = (key = newKey(), extra: Row = {}): Row => ({
  requestId: `req-${key.deviceId.slice(0, 8)}`,
  ...key,
  displayName: "Clawtrate Desktop",
  platform: "darwin",
  clientId: "gateway-client",
  clientMode: "ui",
  role: "operator",
  roles: ["operator"],
  scopes: [...FULL_SCOPES],
  remoteIp: "203.0.113.7",
  isRepair: false,
  ts: 1000,
  ...extra,
});
const pairedOf = (row: Row, extra: Row = {}): Row => ({
  deviceId: row.deviceId,
  publicKey: row.publicKey,
  role: "operator",
  roles: ["operator"],
  scopes: row.scopes,
  tokens: [{ role: "operator", scopes: row.scopes }],
  ...extra,
});

class Refusal extends Error {}

/** A gateway that lists `pending` and `paired`, and records what it was asked. */
type Options = {
  admin?: boolean;
  pairing?: boolean;
  pending?: Row[];
  /** Requests whose ids are listed here count as sharing one code. */
  sameCode?: string[];
};
function setup(options: Options = {}) {
  const gw = { pending: options.pending ?? [], paired: [] as Row[] };
  const calls: string[] = [];
  const answers: Record<string, (params: Row) => unknown> = {};
  let state: DeviceRequestsState | undefined;
  const timers: Array<() => void> = [];
  const delays = new Map<() => void, number>();
  let admin = options.admin ?? true;
  const real = new DeviceApprovals({
    request: async (method, params) => {
      calls.push(method);
      const answer = answers[method];
      if (answer) return answer(params as Row);
      if (method === "device.pair.list") return { pending: gw.pending, paired: gw.paired };
      const id = (params as Row).requestId;
      const row = gw.pending.find((each) => each.requestId === id);
      if (method === "device.pair.approve") {
        if (!row) throw new Refusal("unknown requestId");
        gw.pending = gw.pending.filter((each) => each !== row);
        gw.paired.push(pairedOf(row));
        return { requestId: id };
      }
      if (method === "device.pair.reject") {
        if (!row) throw new Refusal("unknown requestId");
        gw.pending = gw.pending.filter((each) => each !== row);
        return { requestId: id };
      }
      if (method === "device.pair.remove") {
        gw.paired = gw.paired.filter((each) => each.deviceId !== (params as Row).deviceId);
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
    admin: () => admin,
    pairing: () => options.pairing ?? admin,
    answered: (error) => error instanceof Refusal,
    now: () => now,
    later: (run, ms) => {
      timers.push(run);
      delays.set(run, ms);
      return () => void timers.splice(timers.indexOf(run), 1);
    },
    get: () => state,
    set: (next) => (state = next),
    random: (n) => new Uint8Array(n).fill(7),
    ...(options.sameCode
      ? {
          code: (key: string, id: string) =>
            options.sameCode!.includes(id) ? "SAME-CODE" : pairCode(key, id),
        }
      : {}),
  });
  /** The engine, its decisions made on the list as last published unless a test says otherwise. */
  const engine = {
    onHello: () => real.onHello(),
    onClose: () => real.onClose(),
    reset: () => real.reset(),
    onEvent: (event: string, payload: unknown) => real.onEvent(event, payload),
    refresh: () => real.refresh(),
    takePrompt: (id: string) => real.takePrompt(id),
    listDevices: () => real.listDevices(),
    approve: (id: string, code: string, scopes: readonly string[], listedOn?: number) =>
      real.approve(id, code, scopes, listedOn ?? state?.listedOn ?? 0),
    refuse: (id: string, why: "not-mine" | "none-match", listedOn?: number) =>
      real.refuse(id, why, listedOn ?? state?.listedOn ?? 0),
  };
  let now = 10_000;
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(() => r(), 0));
  };
  return {
    gw,
    calls,
    answers,
    engine,
    state: () => state!,
    request: (id: string) => state!.requests.find((each) => each.requestId === id)!,
    /** The delays of the timers still set. */
    delays: () => timers.map((run) => delays.get(run)),
    fire: async () => {
      while (timers.length > 0) timers.shift()!();
      await settle();
    },
    settle,
    setAdmin: (on: boolean) => (admin = on),
    advance: (ms: number) => (now += ms),
  };
}

async function listed(rows: Row[], options: Omit<Options, "pending"> = {}) {
  const t = setup({ ...options, pending: rows });
  t.engine.onHello();
  await t.settle();
  return t;
}

const codeOf = (row: Row) => pairCode(row.publicKey as string, row.requestId as string)!;
const wrongOf = (t: Awaited<ReturnType<typeof listed>>, row: Row) =>
  t.request(row.requestId as string).choices.find((code) => code !== codeOf(row))!;

describe("the pairing code", () => {
  it("is the same on the waiting device and the approving one for the same key and request", () => {
    const key = newKey();
    const code = pairCode(key.publicKey, "req-1");
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(pairCode(String(key.publicKey), "req-1")).toBe(code);
    expect(pairCode(newKey().publicKey, "req-1")).not.toBe(code);
    expect(pairCode("not a key", "req-1")).toBeNull();
    expect(pairCode(key.publicKey, "")).toBeNull();
  });

  it("changes with the gateway's request id, so it can't be known before the request exists", () => {
    const key = newKey();
    const codes = new Set(
      Array.from({ length: 50 }, (_, i) => pairCode(key.publicKey, `req-${i}`)),
    );
    expect(codes.size).toBe(50);
  });

  it("is 40 bits: a stranger's key matches a given code once in 2^40, about 1.1 trillion", () => {
    expect(PAIR_CODE_CHARS * 5).toBe(40);
    expect(2 ** (PAIR_CODE_CHARS * 5)).toBe(1_099_511_627_776);
    // A pick made without looking approves one time in the number of codes.
    expect(PAIR_CODE_CHOICES).toBe(4);
  });

  it("offers its own code among made-up ones that never equal it", () => {
    const secret = new Uint8Array(32).fill(3);
    for (let i = 0; i < 200; i += 1) {
      const key = newKey();
      const choices = codeChoices(key.publicKey, "req-1", secret)!;
      expect(choices).toHaveLength(PAIR_CODE_CHOICES);
      expect(new Set(choices).size).toBe(PAIR_CODE_CHOICES);
      expect(choices.filter((code) => code === pairCode(key.publicKey, "req-1"))).toHaveLength(1);
      expect(choices).toEqual([...choices].sort());
      // The same key gets the same choices; another engine's bytes give others.
      expect(codeChoices(key.publicKey, "req-1", secret)).toEqual(choices);
      expect(codeChoices(key.publicKey, "req-1", new Uint8Array(32))).not.toEqual(choices);
    }
  });

  it("is read one character at a time", () => {
    expect(spokenCode("K7QF-2MXA")).toBe("K 7 Q F, 2 M X A");
  });
});

describe("approving a waiting device", () => {
  it("approves the request's own code, after reading it again, and checks the paired device", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const decision = await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES]);
    expect(decision).toEqual({ kind: "approved", deviceId: row.deviceId });
    expect(t.calls.slice(1, 4)).toEqual([
      "device.pair.list",
      "device.pair.approve",
      "device.pair.list",
    ]);
  });

  it("approves nothing for another code, and takes no second pick for that request", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    expect(await t.engine.approve(id, wrongOf(t, row), [...FULL_SCOPES])).toEqual({
      kind: "wrong-code",
    });
    expect(t.calls).not.toContain("device.pair.approve");
    expect(t.request(id).spent).toBe(true);
    expect(await t.engine.approve(id, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    expect(t.calls).not.toContain("device.pair.approve");
  });

  it("sends nothing for None of these match, and denies for I didn't start this", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    expect(await t.engine.refuse(id, "none-match")).toEqual({ kind: "none-match" });
    expect(t.calls).toEqual(["device.pair.list"]);
    expect(await t.engine.refuse(id, "not-mine")).toEqual({ kind: "denied" });
    expect(t.calls).toContain("device.pair.reject");
    expect(t.gw.pending).toEqual([]);
  });

  it.each([
    ["key", { publicKey: newKey().publicKey }],
    ["role", { roles: ["operator", "node"] }],
    ["access", { scopes: ["operator.read"] }],
    ["origin", { browserOrigin: "https://elsewhere.example" }],
  ])("approves nothing when the request read again has another %s", async (what, change) => {
    const row = pendingRow();
    const t = await listed([row]);
    t.gw.pending = [{ ...row, ...change }];
    const decision = await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES]);
    expect(decision).toEqual({ kind: "changed", what: [what] });
    expect(t.calls).not.toContain("device.pair.approve");
  });

  it("approves nothing when the sheet showed other access than the list holds", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const decision = await t.engine.approve(row.requestId as string, codeOf(row), [
      "operator.read",
    ]);
    expect(decision).toEqual({ kind: "changed", what: ["access"] });
    expect(t.calls).toEqual(["device.pair.list"]);
  });

  it("approves nothing when, on the read before approving, it now shares its code", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    expect(t.request(row.requestId as string).blocked).toBeNull();
    t.gw.pending = [row, { ...row, ts: 0 }];
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    expect(t.calls).not.toContain("device.pair.approve");
    // The list it decided on is the one now published: the request, blocked for its code.
    const shown = t.state().requests.filter((each) => each.requestId === row.requestId);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((each) => each.blocked === "same-code")).toBe(true);
  });

  it("approves nothing when, on the read before approving, more now wait than are shown", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.gw.pending = [
      row,
      ...Array.from({ length: 16 }, (_, i) => pendingRow(newKey(), { ts: 2000 + i })),
    ];
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    expect(t.calls).not.toContain("device.pair.approve");
    // Published: the request hidden past the sixteen, one hidden, every one shown too-many.
    expect(t.state().requests.some((each) => each.requestId === row.requestId)).toBe(false);
    expect(t.state().omitted).toBe(1);
    expect(t.state().requests.every((each) => each.blocked === "too-many")).toBe(true);
  });

  /**
   * The decision's list read goes out first; a background read sent after it is answered and
   * applied first, with `newer`; then the decision's reply, `older`, arrives.
   */
  const outOfOrder = (t: Awaited<ReturnType<typeof listed>>, older: Row[], newer: Row[]) => {
    let lists = 0;
    t.answers["device.pair.list"] = async () => {
      lists += 1;
      if (lists === 1) {
        await t.engine.refresh();
        return { pending: older, paired: [] };
      }
      return { pending: newer, paired: [] };
    };
  };

  it("approves nothing a newer read hid past the sixteen, on an older decision read", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const newer = [
      row,
      ...Array.from({ length: 16 }, (_, i) => pendingRow(newKey(), { ts: 2000 + i })),
    ];
    outOfOrder(t, [row], newer);
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    expect(t.calls).not.toContain("device.pair.approve");
  });

  it("keeps a collision a newer read recorded, though an older decision read lacks it", async () => {
    const [mine, x, y] = [pendingRow(), pendingRow(), pendingRow()];
    const t = await listed([mine], { sameCode: [x.requestId as string, y.requestId as string] });
    // The decision's read goes out first and has only `mine`; a newer read sees x and y share a
    // code; then the older reply arrives; after it, y is gone and only x waits.
    let lists = 0;
    t.answers["device.pair.list"] = async () => {
      lists += 1;
      if (lists === 1) {
        await t.engine.refresh();
        return { pending: [mine], paired: [] };
      }
      return { pending: lists === 2 ? [mine, x, y] : [x], paired: [] };
    };
    await t.engine.approve(mine.requestId as string, codeOf(mine), [...FULL_SCOPES]);
    await t.settle();
    await t.engine.refresh();
    // Its twin gone, the survivor is still blocked: it takes Deny and Ask again.
    expect(t.request(x.requestId as string).blocked).toBe("same-code");
  });

  it("approves nothing on a decision read older than another decision's paired-device read", async () => {
    // W is approved first. While its approval is out, a decision on X sends its list read; then
    // W's check reads the paired device and that reply, the newer one, lists X and a twin Y
    // sharing its code; only then does X's older reply, without Y, arrive. The list read W's
    // decision starts after its check answers last of all.
    const [x, w, y] = [pendingRow(), pendingRow(), pendingRow()];
    const t = await listed([x, w], { sameCode: [x.requestId as string, y.requestId as string] });
    let lists = 0;
    let releaseX: () => void = () => {};
    let xDecision: Promise<unknown> = Promise.resolve();
    let releaseRefresh: () => void = () => {};
    t.answers["device.pair.list"] = async () => {
      lists += 1;
      if (lists === 1) return { pending: [x, w], paired: [] }; // W's read again
      if (lists === 2) {
        // X's read again: answered only after W's check has had its newer reply.
        await new Promise<void>((resolve) => (releaseX = resolve));
        return { pending: [x], paired: [] };
      }
      // W's paired-device read (3); the list read W's decision starts afterwards (4) answers last;
      // any later read answers at once.
      if (lists === 4) await new Promise<void>((resolve) => (releaseRefresh = resolve));
      return { pending: [x, y], paired: [pairedOf(w)] };
    };
    t.answers["device.pair.approve"] = (params) => {
      if ((params as Row).requestId === w.requestId)
        xDecision = t.engine.approve(x.requestId as string, codeOf(x), [...FULL_SCOPES]);
      return { requestId: (params as Row).requestId };
    };
    expect(await t.engine.approve(w.requestId as string, codeOf(w), [...FULL_SCOPES])).toEqual({
      kind: "approved",
      deviceId: w.deviceId,
    });
    releaseX();
    expect(await xDecision).toEqual({ kind: "not-allowed" });
    releaseRefresh();
    await t.settle();
    expect(t.calls.filter((call) => call === "device.pair.approve")).toHaveLength(1);
    expect(t.request(x.requestId as string).blocked).toBe("same-code");
  });

  it("changes nothing with a reply that has no pending list, and approves nothing on one", async () => {
    const [x, y] = [pendingRow(), pendingRow()];
    const t = await listed([x, y], { sameCode: [x.requestId as string, y.requestId as string] });
    const id = x.requestId as string;
    expect(t.request(id).blocked).toBe("same-code");
    t.answers["device.pair.list"] = () => ({ paired: [] });
    await t.engine.refresh();
    expect(
      t
        .state()
        .requests.map((each) => each.requestId)
        .sort(),
    ).toEqual([x.requestId, y.requestId].sort());
    expect(await t.engine.approve(id, codeOf(x), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    expect(t.calls).not.toContain("device.pair.approve");
    // The collision it would have pruned is still remembered once y is gone.
    delete t.answers["device.pair.list"];
    t.gw.pending = [x];
    await t.engine.refresh();
    expect(t.request(id).blocked).toBe("same-code");
  });

  it("approves nothing on a decision read with no pending list, for a request that takes a pick", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    expect(t.request(id)).toMatchObject({ blocked: null, spent: false });
    expect(t.request(id).choices).toContain(codeOf(row));
    const shown = t.state();
    const before = t.calls.length;
    t.answers["device.pair.list"] = () => ({ paired: [] });
    expect(await t.engine.approve(id, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    await t.settle();
    // The decision's read, then the list read again; no approval, and nothing published.
    expect(t.calls.slice(before)).toEqual(["device.pair.list", "device.pair.list"]);
    expect(t.state()).toBe(shown);
  });

  it("gives Settings, Machines the whole reply, applied like any read, and only with admin", async () => {
    const row = pendingRow();
    const t = await listed([]);
    t.gw.pending = [row];
    t.gw.paired = [pairedOf(pendingRow())];
    expect(await t.engine.listDevices()).toEqual({ pending: [row], paired: t.gw.paired });
    expect(t.state().requests.map((each) => each.requestId)).toEqual([row.requestId]);
    // Without admin (a pairing-only connection, or setup) the reply is the caller's alone.
    t.gw.pending = [];
    t.setAdmin(false);
    await t.engine.listDevices();
    expect(t.state().requests.map((each) => each.requestId)).toEqual([row.requestId]);
  });

  it("changes nothing with a reply older than one already applied", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const newer = [row, pendingRow(newKey(), { ts: 3000 })];
    outOfOrder(t, [row], newer);
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    // What is published is the newer list's, untouched by the older reply.
    expect(
      t
        .state()
        .requests.map((each) => each.requestId)
        .sort(),
    ).toEqual(newer.map((each) => each.requestId as string).sort());
    expect(t.calls).not.toContain("device.pair.approve");
  });

  it("honours a newer block this connection published while it read again", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    let lists = 0;
    t.answers["device.pair.list"] = async () => {
      lists += 1;
      if (lists === 1) {
        // Another read on this connection lands first, and says the request now asks for more.
        await t.engine.refresh();
        return { pending: [row], paired: [] };
      }
      return { pending: [{ ...row, isRepair: true }], paired: [] };
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    expect(t.calls).not.toContain("device.pair.approve");
    // The older reply didn't put the unblocked row back over the newer block.
    expect(t.request(row.requestId as string).blocked).toBe("repair");
    expect(t.request(row.requestId as string).choices).toEqual([]);
  });

  it("starts one approval for two quick presses on the same request", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    const [first, second] = await Promise.all([
      t.engine.approve(id, codeOf(row), [...FULL_SCOPES]),
      t.engine.approve(id, codeOf(row), [...FULL_SCOPES]),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["approved", "not-allowed"]);
    expect(t.calls.filter((call) => call === "device.pair.approve")).toHaveLength(1);
  });

  it("takes no refusal while an approval is under way, during its read or its call", async () => {
    for (const during of ["device.pair.list", "device.pair.approve"] as const) {
      const row = pendingRow();
      const t = await listed([row]);
      const id = row.requestId as string;
      const refusals: string[] = [];
      const inner = during === "device.pair.list" ? undefined : t.answers[during];
      t.answers[during] = async (params) => {
        delete t.answers[during];
        if (inner) t.answers[during] = inner;
        for (const why of ["none-match", "not-mine"] as const)
          refusals.push((await t.engine.refuse(id, why)).kind);
        if (during === "device.pair.list") return { pending: t.gw.pending, paired: t.gw.paired };
        t.gw.pending = [];
        t.gw.paired = [pairedOf(row)];
        return { requestId: (params as Row).requestId };
      };
      expect(await t.engine.approve(id, codeOf(row), [...FULL_SCOPES])).toEqual({
        kind: "approved",
        deviceId: row.deviceId,
      });
      expect(refusals).toEqual(["not-allowed", "not-allowed"]);
      expect(t.calls).not.toContain("device.pair.reject");
      expect(t.calls.filter((call) => call === "device.pair.approve")).toHaveLength(1);
    }
  });

  it("keeps a request taken after an approval whose answer was lost", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    t.answers["device.pair.approve"] = () => {
      throw new Error("connection closed");
    };
    expect(await t.engine.approve(id, codeOf(row), [...FULL_SCOPES])).toEqual({ kind: "unknown" });
    delete t.answers["device.pair.approve"];
    // Still listed, as the gateway may not have acted: nothing more is decided on it here.
    expect(await t.engine.approve(id, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    expect(await t.engine.refuse(id, "not-mine")).toEqual({ kind: "not-allowed" });
    expect(t.calls.filter((call) => call === "device.pair.approve")).toHaveLength(1);
  });

  it("frees each request a decision kept taken once it leaves the list", async () => {
    // More approvals than the bound on requests taken, one after another: each approved request
    // leaves the list, and with it its hold, so the last is approved too.
    const t = await listed([]);
    for (let i = 0; i <= MAX_DEVICE_REQUESTS; i += 1) {
      const row = pendingRow();
      t.gw.pending = [row];
      await t.engine.refresh();
      expect(
        await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES]),
      ).toEqual({ kind: "approved", deviceId: row.deviceId });
    }
  });

  it("frees a request only by the decision that took it, across another gateway", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    let lists = 0;
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    t.answers["device.pair.list"] = async () => {
      // The first decision's read again, then the second gateway's hello read, then the second
      // decision's read again; later reads answer at once.
      const read = (lists += 1);
      if (read === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      if (read === 3) await new Promise<void>((resolve) => (releaseSecond = resolve));
      return { pending: t.gw.pending, paired: t.gw.paired };
    };
    const first = t.engine.approve(id, codeOf(row), [...FULL_SCOPES]);
    await t.settle();
    // Another gateway, which lists a request with the same id, and a decision on it.
    t.engine.reset();
    t.engine.onHello();
    await t.settle();
    const second = t.engine.approve(id, codeOf(row), [...FULL_SCOPES]);
    await t.settle();
    releaseFirst();
    expect(await first).toEqual({ kind: "interrupted" });
    // The stale decision ended; the second still holds the request, so nothing else decides it.
    expect(await t.engine.approve(id, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    expect(await t.engine.refuse(id, "not-mine")).toEqual({ kind: "not-allowed" });
    expect(t.calls.filter((call) => call === "device.pair.approve")).toHaveLength(0);
    releaseSecond();
    expect(await second).toEqual({ kind: "approved", deviceId: row.deviceId });
    expect(t.calls.filter((call) => call === "device.pair.approve")).toHaveLength(1);
    expect(t.calls).not.toContain("device.pair.reject");
  });

  it("takes one None of these match per request, and still denies it", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    expect(await t.engine.refuse(id, "none-match")).toEqual({ kind: "none-match" });
    t.advance(4 * 60_000);
    expect(await t.engine.refuse(id, "none-match")).toEqual({ kind: "not-allowed" });
    // "I didn't start this" still denies it, while it is listed and still picked for.
    await t.engine.refresh();
    expect(t.request(id).spent).toBe(true);
    expect(await t.engine.refuse(id, "not-mine")).toEqual({ kind: "denied" });
    expect(t.calls).toContain("device.pair.reject");
    // The quiet minutes run from the first pick: the refused one started none.
    const first = pendingRow();
    const u = await listed([first]);
    const firstId = first.requestId as string;
    expect(await u.engine.refuse(firstId, "none-match")).toEqual({ kind: "none-match" });
    u.advance(4 * 60_000);
    expect(await u.engine.refuse(firstId, "none-match")).toEqual({ kind: "not-allowed" });
    u.advance(60_000);
    const next = pendingRow();
    u.gw.pending = [next];
    await u.engine.refresh();
    expect(u.state().prompt).toBe(next.requestId);
  });

  it("compares and removes the paired device read once after a lost answer", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    let after = 0;
    t.answers["device.pair.approve"] = () => {
      t.gw.pending = [];
      t.gw.paired = [pairedOf(row, { scopes: ["operator.admin"] })];
      t.answers["device.pair.list"] = () => {
        // The one paired-device read; every read after it fails.
        if ((after += 1) === 1) return { pending: [], paired: t.gw.paired };
        throw new Error("timed out");
      };
      throw new Error("connection closed");
    };
    const decision = await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES]);
    // The pairing that differs is removed on that one read; the removal isn't confirmed.
    expect(t.calls).toContain("device.pair.remove");
    expect(decision).toEqual({ kind: "undo-failed", what: ["access"], message: "timed out" });
  });

  it("confirms no removal from a read without a paired list", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.approve"] = () => {
      t.gw.pending = [];
      t.gw.paired = [pairedOf(row, { scopes: ["operator.admin"] })];
      return {};
    };
    t.answers["device.pair.remove"] = () => {
      // The gateway's next list answers without its paired devices.
      t.answers["device.pair.list"] = () => ({ pending: [] });
      return {};
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "undo-failed",
      what: ["access"],
      message: "The gateway's answer didn't list its paired devices.",
    });
    // An empty list is a confirmation.
    const u = await listed([row]);
    u.answers["device.pair.approve"] = () => {
      u.gw.pending = [];
      u.gw.paired = [pairedOf(row, { scopes: ["operator.admin"] })];
      return {};
    };
    u.answers["device.pair.remove"] = () => {
      u.answers["device.pair.list"] = () => ({ pending: [], paired: [] });
      return {};
    };
    expect(await u.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "undone",
      what: ["access"],
    });
  });

  it("decides nothing from a sheet an earlier connection showed", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    const sheet = t.state().listedOn;
    // Closed and connected again: the new connection reads its own list on its hello.
    t.engine.onClose();
    t.engine.onHello();
    await t.settle();
    expect(t.state().listedOn).not.toBe(sheet);
    const before = t.calls.length;
    expect(await t.engine.approve(id, codeOf(row), [...FULL_SCOPES], sheet)).toEqual({
      kind: "not-allowed",
    });
    expect(await t.engine.refuse(id, "not-mine", sheet)).toEqual({ kind: "not-allowed" });
    expect(await t.engine.refuse(id, "none-match", sheet)).toEqual({ kind: "not-allowed" });
    // Nothing was sent, and no read of its own: the spent pick and the quiet minutes untouched.
    expect(t.calls.slice(before)).toEqual([]);
    expect(t.request(id).spent).toBe(false);
    expect(t.state().prompt).toBe(id);
  });

  it("says a request decided elsewhere or expired is no longer pending", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.gw.pending = [];
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "gone",
    });
    expect(t.calls).not.toContain("device.pair.approve");
    await t.settle();
    expect(t.state().requests).toEqual([]);
    expect(await t.engine.refuse(row.requestId as string, "not-mine")).toEqual({ kind: "gone" });
  });

  it("says the gateway's unknown requestId as no longer pending, and another refusal as it is", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.approve"] = () => {
      throw new Refusal("unknown requestId");
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "gone",
    });
    t.answers["device.pair.approve"] = () => {
      throw new Refusal("device pairing approval denied");
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "refused",
      message: "device pairing approval denied",
    });
  });

  it.each([
    ["access", { scopes: [...FULL_SCOPES, "operator.talk.secrets"] }],
    ["role", { roles: ["node", "operator"] }],
    ["key", { publicKey: newKey().publicKey }],
  ])(
    "removes a pairing whose %s differs from what was shown, and says so",
    async (what, change) => {
      const row = pendingRow();
      const t = await listed([row]);
      t.answers["device.pair.approve"] = () => {
        t.gw.pending = [];
        t.gw.paired = [pairedOf(row, change)];
        return {};
      };
      const decision = await t.engine.approve(row.requestId as string, codeOf(row), [
        ...FULL_SCOPES,
      ]);
      expect(decision).toEqual({ kind: "undone", what: [what] });
      expect(t.calls).toContain("device.pair.remove");
      expect(t.gw.paired).toEqual([]);
    },
  );

  it("says when removing a pairing that differs failed", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.approve"] = () => {
      t.gw.paired = [pairedOf(row, { tokens: [{ role: "operator", scopes: ["operator.admin"] }] })];
      return {};
    };
    t.answers["device.pair.remove"] = () => {
      throw new Refusal("not now");
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "undo-failed",
      what: ["access"],
      message: "not now",
    });
  });

  it("checks what the gateway did when the approval's answer is lost", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.approve"] = () => {
      t.gw.paired = [pairedOf(row)];
      throw new Error("connection closed");
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "approved",
      deviceId: row.deviceId,
    });
    const other = pendingRow();
    const u = await listed([other]);
    u.answers["device.pair.approve"] = () => {
      throw new Error("connection closed");
    };
    expect(
      await u.engine.approve(other.requestId as string, codeOf(other), [...FULL_SCOPES]),
    ).toEqual({ kind: "unknown" });
  });

  it.each([
    ["not-operator", { role: "node", roles: ["node"] }],
    ["not-operator", { roles: ["operator", "node"] }],
    ["repair", { isRepair: true }],
    ["unknown-scope", { scopes: ["operator.read", "operator.talk.secrets"] }],
    ["bad-key", { deviceId: "0".repeat(64) }],
  ])("lists a %s request but approves nothing for it", async (blocked, change) => {
    const row = pendingRow(newKey(), change);
    const t = await listed([row]);
    const shown = t.request(row.requestId as string);
    expect(shown.blocked).toBe(blocked);
    expect(shown.choices).toEqual([]);
    expect(await t.engine.approve(row.requestId as string, codeOf(row), shown.scopes)).toEqual({
      kind: "not-allowed",
    });
    expect(t.calls).not.toContain("device.pair.approve");
  });

  it("decides nothing on a connection without admin", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.setAdmin(false);
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    expect(await t.engine.refuse(row.requestId as string, "not-mine")).toEqual({
      kind: "not-allowed",
    });
    expect(t.calls).toEqual(["device.pair.list"]);
  });
});

describe("a connection that changes during a decision", () => {
  it("approves nothing when it changes while the request is read again", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.list"] = () => {
      t.engine.onHello();
      return { pending: [row], paired: [] };
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "interrupted",
    });
    expect(t.calls).not.toContain("device.pair.approve");
  });

  it("removes nothing when it changes while the paired device is read", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    let lists = 0;
    t.answers["device.pair.list"] = () => {
      lists += 1;
      // The second read is the paired device's, after the approval.
      if (lists === 2) t.engine.onHello();
      return {
        pending: lists === 1 ? [row] : [],
        paired: lists === 1 ? [] : [pairedOf(row, { scopes: ["operator.admin"] })],
      };
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "unknown",
    });
    expect(t.calls).not.toContain("device.pair.remove");
  });

  /** A new connection without admin: its hello reads nothing, so every later read is the decision's. */
  const reconnect = (t: Awaited<ReturnType<typeof listed>>) => {
    t.setAdmin(false);
    t.engine.onHello();
  };
  const readsAfter = (t: Awaited<ReturnType<typeof listed>>, method: string) =>
    t.calls.slice(t.calls.lastIndexOf(method) + 1).filter((call) => call === "device.pair.list");

  it("reads nothing on a new connection after the approval's answer", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.approve"] = () => {
      t.gw.paired = [pairedOf(row)];
      reconnect(t);
      return {};
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "unknown",
    });
    expect(readsAfter(t, "device.pair.approve")).toEqual([]);
  });

  it("reads nothing on a new connection after a lost answer", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.approve"] = () => {
      t.gw.paired = [pairedOf(row)];
      reconnect(t);
      throw new Error("connection closed");
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "unknown",
    });
    expect(readsAfter(t, "device.pair.approve")).toEqual([]);
  });

  it("doesn't confirm a removal on a new connection", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.approve"] = () => {
      t.gw.paired = [pairedOf(row, { scopes: ["operator.admin"] })];
      return {};
    };
    t.answers["device.pair.remove"] = () => {
      t.gw.paired = [];
      reconnect(t);
      return {};
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "undo-failed",
      what: ["access"],
      message: "The connection changed before Clawtrate could confirm the removal.",
    });
    expect(readsAfter(t, "device.pair.remove")).toEqual([]);
  });

  it("adds no read of its own to a new admin connection, whose hello reads its list once", async () => {
    for (const step of ["device.pair.approve", "device.pair.reject"] as const) {
      const row = pendingRow();
      const t = await listed([row]);
      t.answers[step] = () => {
        t.gw.pending = [];
        t.gw.paired = step === "device.pair.approve" ? [pairedOf(row)] : [];
        t.engine.onHello();
        return {};
      };
      const id = row.requestId as string;
      if (step === "device.pair.approve") await t.engine.approve(id, codeOf(row), [...FULL_SCOPES]);
      else await t.engine.refuse(id, "not-mine");
      await t.settle();
      // The hello's own read, and nothing the stale decision asked for: none queued either.
      expect(readsAfter(t, step)).toEqual(["device.pair.list"]);
      expect(t.delays()).toEqual([]);
      await t.fire();
      expect(readsAfter(t, step)).toEqual(["device.pair.list"]);
    }
  });

  it("checks and removes nothing on another connection than the approval's", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.approve"] = () => {
      t.gw.paired = [pairedOf(row, { scopes: ["operator.admin"] })];
      t.engine.onHello();
      return {};
    };
    expect(await t.engine.approve(row.requestId as string, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "unknown",
    });
    expect(t.calls).not.toContain("device.pair.remove");
  });
});

describe("the waiting requests", () => {
  it("keeps the newest sixteen of twenty, counts the rest, and opens none by itself", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => pendingRow(newKey(), { ts: i }));
    const t = await listed(rows);
    expect(MAX_DEVICE_REQUESTS).toBe(16);
    expect(t.state().requests.map((each) => each.at)).toEqual(
      Array.from({ length: 16 }, (_, i) => 19 - i),
    );
    expect(t.state().omitted).toBe(4);
    expect(t.state().prompt).toBeNull();
  });

  it("opens the only one by itself, once, in the first window that takes it", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    expect(t.state().prompt).toBe(id);
    expect(t.engine.takePrompt(id)).toBe(true);
    expect(t.engine.takePrompt(id)).toBe(false);
    await t.engine.refresh();
    expect(t.state().prompt).toBeNull();
  });

  it("doesn't open by itself the request a denied device's last retry files", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    expect(await t.engine.refuse(row.requestId as string, "not-mine")).toEqual({ kind: "denied" });
    await t.settle();
    // The device's next connect learns of the denial, and files one more request as it stops.
    t.gw.pending = [{ ...row, requestId: "req-again" }];
    await t.engine.refresh();
    expect(t.state().requests.map((each) => each.requestId)).toEqual(["req-again"]);
    expect(t.state().prompt).toBeNull();
    // Five minutes on, a request from it opens by itself again.
    t.advance(5 * 60_000);
    await t.engine.refresh();
    expect(t.state().prompt).toBe("req-again");
  });

  it("brings the 30-second read forward for an event", async () => {
    const t = await listed([pendingRow()]);
    expect(t.delays()).toEqual([30_000]);
    t.advance(5_000);
    t.engine.onEvent("device.pair.requested", { requestId: "new" });
    expect(t.delays()).toEqual([0]);
  });

  it("takes no pick while more requests wait than are shown, and says so", async () => {
    const rows = Array.from({ length: 17 }, (_, i) => pendingRow(newKey(), { ts: i }));
    const t = await listed(rows);
    expect(t.state().omitted).toBe(1);
    for (const shown of t.state().requests) {
      expect(shown.blocked).toBe("too-many");
      expect(shown.choices).toEqual([]);
    }
    const newest = rows[16]!;
    expect(
      await t.engine.approve(newest.requestId as string, codeOf(newest), [...FULL_SCOPES]),
    ).toEqual({ kind: "not-allowed" });
    expect(await t.engine.refuse(newest.requestId as string, "none-match")).toEqual({
      kind: "not-allowed",
    });
    // Denying is how the hidden ones come into view.
    expect(await t.engine.refuse(newest.requestId as string, "not-mine")).toEqual({
      kind: "denied",
    });
    await t.engine.refresh();
    expect(t.state().omitted).toBe(0);
    expect(t.state().requests.every((each) => each.blocked === null)).toBe(true);
    expect(t.calls).not.toContain("device.pair.approve");
  });

  it("takes no None of these match on a blocked request, whatever its reason", async () => {
    const spent = Array.from({ length: 16 }, (_, i) => pendingRow(newKey(), { ts: i }));
    const t = await listed(spent);
    for (const row of spent) await t.engine.refuse(row.requestId as string, "none-match");
    const machine = pendingRow(newKey(), { ts: 100, role: "node", roles: ["node"] });
    t.gw.pending = [...spent, machine];
    await t.engine.refresh();
    expect(t.request(machine.requestId as string).blocked).toBe("not-operator");
    expect(await t.engine.refuse(machine.requestId as string, "none-match")).toEqual({
      kind: "not-allowed",
    });
    expect(t.request(machine.requestId as string).spent).toBe(false);
  });

  it("keeps a collision blocked for as long as either request waits, whichever survives", async () => {
    for (const survivor of [0, 1]) {
      const pair = [pendingRow(), pendingRow()];
      const ids = pair.map((row) => row.requestId as string);
      const t = await listed(pair, { sameCode: ids });
      expect(t.state().requests.map((each) => each.blocked)).toEqual(["same-code", "same-code"]);
      const kept = pair[survivor]!;
      t.gw.pending = [kept];
      await t.engine.refresh();
      expect(t.request(kept.requestId as string).blocked).toBe("same-code");
      expect(
        await t.engine.approve(kept.requestId as string, codeOf(kept), [...FULL_SCOPES]),
      ).toEqual({ kind: "not-allowed" });
      await t.settle();
      // Deny, then the device asks again: a new id is a new request, with nothing against it.
      expect(await t.engine.refuse(kept.requestId as string, "not-mine")).toEqual({
        kind: "denied",
      });
      await t.settle();
      const again = { ...kept, requestId: `${kept.requestId as string}-again` };
      t.gw.pending = [again];
      await t.engine.refresh();
      expect(t.request(again.requestId).blocked).toBeNull();
    }
  });

  it("blocks every request once more collisions are seen than it keeps, until none waits", async () => {
    const many = Array.from({ length: MAX_COLLIDED + 1 }, (_, i) =>
      pendingRow(newKey(), { ts: i }),
    );
    const t = await listed(many, { sameCode: many.map((row) => row.requestId as string) });
    const fresh = pendingRow(newKey(), { ts: 500 });
    t.gw.pending = [fresh];
    await t.engine.refresh();
    expect(t.request(fresh.requestId as string).blocked).toBe("same-code");
    t.gw.pending = [];
    await t.engine.refresh();
    t.gw.pending = [fresh];
    await t.engine.refresh();
    expect(t.request(fresh.requestId as string).blocked).toBeNull();
  });

  it("blocks two waiting requests that show the same code, one of them past the sixteen", async () => {
    const twin = pendingRow(newKey(), { ts: 100 });
    const rows = [
      twin,
      ...Array.from({ length: 15 }, (_, i) => pendingRow(newKey(), { ts: 50 + i })),
      // The same key and id again, oldest: it shows the same code, and is past the sixteen.
      { ...twin, ts: 0 },
    ];
    const t = await listed(rows);
    expect(t.state().omitted).toBe(1);
    const shown = t.state().requests.find((each) => each.at === 100)!;
    expect(shown.blocked).toBe("same-code");
    expect(shown.choices).toEqual([]);
    expect(
      await t.engine.approve(twin.requestId as string, codeOf(twin), [...FULL_SCOPES]),
    ).toEqual({
      kind: "not-allowed",
    });
    t.gw.pending = [twin, { ...twin, ts: 0 }];
    await t.engine.refresh();
    expect(t.state().requests.map((each) => each.blocked)).toEqual(["same-code", "same-code"]);
  });

  it("keeps a pick spent while its request is past the sixteen shown", async () => {
    const old = pendingRow(newKey(), { ts: 0 });
    const t = await listed([old]);
    expect(await t.engine.refuse(old.requestId as string, "none-match")).toEqual({
      kind: "none-match",
    });
    t.gw.pending = [
      old,
      ...Array.from({ length: 16 }, (_, i) => pendingRow(newKey(), { ts: i + 1 })),
    ];
    await t.engine.refresh();
    expect(t.state().omitted).toBe(1);
    t.gw.pending = [old];
    await t.engine.refresh();
    expect(t.request(old.requestId as string).spent).toBe(true);
  });

  it("keeps what a device reports whole in the state, up to its bound", async () => {
    const origin = `https://${"\u{1F600}".repeat(56)}`;
    const t = await listed([
      pendingRow(newKey(), { browserOrigin: origin, displayName: "a".repeat(64) }),
    ]);
    const kept = enforceState({ ...initialState, deviceRequests: t.state() }).deviceRequests!;
    expect(kept.requests[0]!.origin).toBe(origin);
    expect(kept.requests[0]!.name).toBe("a".repeat(64));
  });

  it("opens no sheet by itself for any device for five minutes after a refusal or a wrong pick", async () => {
    for (const refusal of ["not-mine", "none-match", "wrong"] as const) {
      const first = pendingRow();
      const t = await listed([first]);
      const id = first.requestId as string;
      if (refusal === "wrong") await t.engine.approve(id, wrongOf(t, first), [...FULL_SCOPES]);
      else await t.engine.refuse(id, refusal);
      await t.settle();
      expect(t.state().prompt).toBeNull();
      // Another key's request, the only one waiting: listed, not opened by itself.
      const next = pendingRow();
      t.gw.pending = [next];
      await t.engine.refresh();
      expect(t.state().requests.map((each) => each.requestId)).toEqual([next.requestId]);
      expect(t.state().prompt).toBeNull();
      t.advance(5 * 60_000);
      await t.engine.refresh();
      expect(t.state().prompt).toBe(next.requestId);
    }
  });

  it("publishes no failure older than a list a decision read, and tries it again never", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    const id = row.requestId as string;
    t.answers["device.pair.list"] = async () => {
      // A background read, sent first, fails last.
      await new Promise<void>((resolve) => (failRead = resolve));
      throw new Error("timed out");
    };
    let failRead: () => void = () => {};
    void t.engine.refresh();
    await t.settle();
    // The decision's read, sent later, answers first: a good list in which the request now
    // shares its code, so nothing is approved and nothing more is read.
    t.answers["device.pair.list"] = () => ({ pending: [row, { ...row, ts: 0 }], paired: [] });
    expect(await t.engine.approve(id, codeOf(row), [...FULL_SCOPES])).toEqual({
      kind: "not-allowed",
    });
    const shown = t.state();
    failRead();
    await t.settle();
    expect(t.state()).toBe(shown);
    expect(t.state().error).toBeNull();
    expect(t.delays()).toEqual([]);
  });

  it("stops after four retries, keeping the last list read, though requests were waiting", async () => {
    const row = pendingRow();
    const t = await listed([row]);
    t.answers["device.pair.list"] = () => {
      throw new Error("timed out");
    };
    const waits: Array<number | undefined> = [];
    for (let i = 0; i < 8; i += 1) {
      waits.push(...t.delays());
      await t.fire();
    }
    // The 30-second read, then the four retries, then nothing until an event, hello or refresh.
    expect(waits).toEqual([30_000, 1_000, 4_000, 16_000, 64_000]);
    expect(t.delays()).toEqual([]);
    // What the person sees: the last list read, and the read's failure.
    expect(t.state()).toMatchObject({ error: "timed out" });
    expect(t.state().requests.map((each) => each.requestId)).toEqual([row.requestId]);
  });

  it("tries a failed read again, four times, each four times later, and polls no empty list", async () => {
    const row = pendingRow();
    const t = setup({ pending: [row] });
    let fail = true;
    t.answers["device.pair.list"] = () => {
      if (fail) throw new Error("timed out");
      return { pending: [row], paired: [] };
    };
    // A request already waiting when the admin connects, and the first read fails.
    t.engine.onHello();
    await t.settle();
    expect(t.state()).toMatchObject({ requests: [], error: "timed out" });
    expect(t.delays()).toEqual([1_000]);
    fail = false;
    await t.fire();
    expect(t.state().requests.map((each) => each.requestId)).toEqual([row.requestId]);
    // A read that keeps failing is tried four times, then left to an event or a refresh.
    const u = setup();
    u.answers["device.pair.list"] = () => {
      throw new Error("timed out");
    };
    u.engine.onHello();
    await u.settle();
    const waits: Array<number | undefined> = [];
    for (let i = 0; i < 6; i += 1) {
      waits.push(...u.delays());
      await u.fire();
    }
    expect(waits).toEqual([1_000, 4_000, 16_000, 64_000]);
    expect(u.calls.filter((call) => call === "device.pair.list")).toHaveLength(5);
    // A read that succeeds with nothing waiting sets no timer.
    const v = await listed([]);
    expect(v.delays()).toEqual([]);
  });

  it("reads a burst of events once", async () => {
    const t = await listed([]);
    for (let i = 0; i < 5; i += 1)
      t.engine.onEvent("device.pair.requested", { requestId: `r${i}` });
    t.gw.pending = [pendingRow()];
    await t.fire();
    expect(t.calls.filter((call) => call === "device.pair.list")).toHaveLength(2);
    expect(t.state().requests).toHaveLength(1);
  });

  it("cleans and bounds what a device reports, and marks the gateway's address apart", async () => {
    const row = pendingRow(newKey(), {
      displayName: `Pip\u202e's\u0000 ${"x".repeat(200)}`,
      platform: undefined,
      remoteIp: undefined,
    });
    const t = await listed([row]);
    const shown = t.request(row.requestId as string);
    expect(shown.name).toMatch(/^Pip 's x+$/);
    expect(shown.name!.length).toBe(64);
    expect(shown.platform).toBeNull();
    expect(shown.remoteIp).toBeNull();
  });

  it("notices a request on a connection without admin, until it ends or expires", async () => {
    const t = setup({ admin: false, pairing: true });
    t.engine.onHello();
    t.engine.onEvent("device.pair.requested", { requestId: "a" });
    t.engine.onEvent("device.pair.requested", { requestId: "b" });
    expect(t.state()).toMatchObject({ access: "notice", noticed: 2, requests: [] });
    t.engine.onEvent("device.pair.resolved", { requestId: "a" });
    expect(t.state().noticed).toBe(1);
    // The notice ends when its five minutes are up, with no event needed.
    t.advance(5 * 60_000);
    await t.fire();
    expect(t.state()).toMatchObject({ access: "none", noticed: 0 });
    expect(t.calls).toEqual([]);
  });

  it("forgets the list when the connection closes", async () => {
    const t = await listed([pendingRow()]);
    t.engine.onClose();
    expect(t.state()).toMatchObject({ access: "none", requests: [] });
  });
});
