// Approving a waiting device (setup-effortless.md §5): the code, and each outcome of a pick.
import { describe, expect, it } from "vitest";
import { sha256Hex, toBase64, utf8Bytes } from "../src/bytes.ts";
import {
  DeviceApprovals,
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
function setup(options: { admin?: boolean; pairing?: boolean; pending?: Row[] } = {}) {
  const gw = { pending: options.pending ?? [], paired: [] as Row[] };
  const calls: string[] = [];
  const answers: Record<string, (params: Row) => unknown> = {};
  let state: DeviceRequestsState | undefined;
  const timers: Array<() => void> = [];
  const delays = new Map<() => void, number>();
  let admin = options.admin ?? true;
  const engine = new DeviceApprovals({
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
  });
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

async function listed(rows: Row[], options: { admin?: boolean } = {}) {
  const t = setup({ ...options, pending: rows });
  t.engine.onHello();
  await t.settle();
  return t;
}

const codeOf = (row: Row) => pairCode(row.publicKey as string)!;
const wrongOf = (t: Awaited<ReturnType<typeof listed>>, row: Row) =>
  t.request(row.requestId as string).choices.find((code) => code !== codeOf(row))!;

describe("the pairing code", () => {
  it("is the same on the waiting device and the approving one for the same key", () => {
    const key = newKey();
    expect(pairCode(key.publicKey)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(pairCode(key.publicKey)).toBe(pairCode(String(key.publicKey)));
    expect(pairCode(newKey().publicKey)).not.toBe(pairCode(key.publicKey));
    expect(pairCode("not a key")).toBeNull();
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
      const choices = codeChoices(key.publicKey, secret)!;
      expect(choices).toHaveLength(PAIR_CODE_CHOICES);
      expect(new Set(choices).size).toBe(PAIR_CODE_CHOICES);
      expect(choices.filter((code) => code === pairCode(key.publicKey))).toHaveLength(1);
      expect(choices).toEqual([...choices].sort());
      // The same key gets the same choices; another engine's bytes give others.
      expect(codeChoices(key.publicKey, secret)).toEqual(choices);
      expect(codeChoices(key.publicKey, new Uint8Array(32))).not.toEqual(choices);
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
