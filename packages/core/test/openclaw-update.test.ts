// F-589: updating OpenClaw from Clawtrate (#565). The flow as a state machine
// driven by frames in the gateway's own shapes: the run record of
// `update.runs.get` and `update.status` (`UpdateRunRecordSchema`), the
// `update.run` answer (`UpdateRunResultSchema`) and the `update.run.changed`
// event (`{runId, phase, status, updatedAtMs}`), as OpenClaw 2026.10.6 defines
// them. No real update was run: the frames are built from those types.

import { describe, expect, it } from "vitest";
import {
  initialOpenClawUpdate,
  OpenClawUpdates,
  readUpdateRun,
  UPDATE_AWAY_MS,
  UPDATE_NOT_SENT,
  UPDATE_PHASES,
  UPDATE_RUN_KEY,
  UPDATE_SENT_UNKNOWN,
  updateText,
  type OpenClawUpdatesContext,
  type OpenClawUpdateState,
} from "../src/openclaw-update.ts";
import {
  gatewayStamp,
  initialConnectionState,
  sameStamp,
  type ConnectionState,
  type GatewayStamp,
} from "../src/types.ts";
import { ADMIN_SCOPES } from "../src/scopes.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { openTask, URL_A, grantingGateway } from "./client-harness.ts";
import { helloOk, memoryStorage, until } from "./fake-gateway.ts";

const RUN = "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e";
const OTHER_RUN = "7a1c9e2b-5d4f-4a3b-9c8d-1e2f3a4b5c6d";
const OLD = "2026.10.6";
const NEW = "2026.11.6";
const T0 = 1_780_000_000_000;

/** A run record as `update.runs.get` gives it (`UpdateRunRecordSchema`). */
function record(patch: Record<string, unknown> = {}) {
  return {
    runId: RUN,
    createdAtMs: T0,
    updatedAtMs: T0,
    trigger: "api",
    phase: "requested",
    status: "running",
    reason: null,
    origin: { doctorHint: "openclaw doctor --non-interactive" },
    target: { channel: "stable", kind: "package", version: NEW, installationMethod: "npm-global" },
    before: { version: OLD },
    after: {},
    steps: [{ step: "installation-inspection", status: "completed" }],
    verification: { runningVersion: OLD, serviceRunning: true, pid: 4242 },
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
    ...patch,
  };
}

/** `update.run`'s answer when the handoff started (`managed-service-handoff-started`). */
const started = (runId = RUN) => ({
  runId,
  ok: true,
  ackDelivered: false,
  ackQueued: false,
  result: { status: "skipped", mode: "npm", reason: "managed-service-handoff-started", steps: [] },
  handoff: { status: "started", pid: 5151, command: "openclaw update --yes --json" },
  restart: null,
  sentinel: { persisted: true, payload: {} },
});

class Refusal extends Error {
  readonly code: string;
  readonly reason: string | null;
  constructor(code: string, message: string, reason: string | null = null) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

function rig(options: { admin?: boolean; startedAt?: number | null } = {}) {
  const connection: { value: ConnectionState } = {
    value: {
      ...initialConnectionState,
      status: "connected",
      gatewayUrl: "ws://gateway.test",
      gatewayId: "gw-a",
      target: 1,
      serverVersion: OLD,
      openclawUpdate: { current: OLD, latest: NEW, channel: "latest" },
      canAdmin: options.admin ?? true,
    },
  };
  const world = {
    identity: "gw-a" as string | null,
    startedAt: options.startedAt === undefined ? T0 - 60_000 : options.startedAt,
    refreshes: 0,
    sent: [] as Array<{ method: string; params: unknown }>,
    handlers: {} as Record<string, (params: unknown) => unknown>,
    /** A request that goes out and then loses its connection. */
    dropAfterSend: false,
  };
  let value: OpenClawUpdateState | undefined;
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const storage = memoryStorage();
  const ctx: OpenClawUpdatesContext = {
    request: async (method, params, onSent) => {
      world.sent.push({ method, params });
      onSent?.();
      if (world.dropAfterSend) throw new Error("connection closed");
      const handler = world.handlers[method];
      if (!handler) throw new Refusal("UNKNOWN_METHOD", `unknown method ${method}`);
      return handler(params);
    },
    connection: () => connection.value,
    admin: () => connection.value.status === "connected" && connection.value.canAdmin,
    identity: async () => world.identity,
    sameGateway: async (stamp: GatewayStamp) => {
      if (!sameStamp(stamp, gatewayStamp(connection.value)) || world.identity !== stamp.gatewayId)
        throw new Error("This change was made for another gateway, so nothing was sent.");
    },
    startedAt: () => world.startedAt,
    answered: (error) => error instanceof Refusal,
    refusalReason: (error) => (error instanceof Refusal ? error.reason : null),
    missingScope: (error) => error instanceof Refusal && error.code === "MISSING_SCOPE",
    refreshModels: async () => {
      world.refreshes += 1;
    },
    storage,
    get: () => value,
    set: (next) => {
      value = next;
    },
    later: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    log: () => {},
  };
  const engine = new OpenClawUpdates(ctx);
  const set = (patch: Partial<ConnectionState>) => {
    connection.value = { ...connection.value, ...patch };
  };
  return {
    engine,
    world,
    storage,
    timers,
    ctx,
    set,
    state: () => value ?? initialOpenClawUpdate,
    run: () => (value ?? initialOpenClawUpdate).run,
    stamp: () => gatewayStamp(connection.value),
    sentMethods: () => world.sent.map((each) => each.method),
    /** The gateway restarts: the connection drops, then answers again with `version`. */
    async restart(version: string, hello = true) {
      set({ status: "reconnecting", canAdmin: false });
      engine.onDisconnect();
      if (!hello) return;
      set({
        status: "connected",
        canAdmin: options.admin ?? true,
        serverVersion: version,
        openclawUpdate: version === NEW ? null : connection.value.openclawUpdate,
      });
      await engine.onHello();
    },
  };
}

/** Every update request the engine sent: what reaches the gateway. */
const writes = (world: { sent: Array<{ method: string }> }) =>
  world.sent.filter((each) => each.method === "update.run");

describe("F-589: updating OpenClaw, as a state machine from the gateway's frames", () => {
  it("F-589: a press sends one update.run with nothing in it, to the gateway the screen showed, and follows each phase in the gateway's words", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    expect(t.world.sent).toEqual([{ method: "update.run", params: {} }]);
    expect(t.run()).toMatchObject({
      runId: RUN,
      gatewayId: "gw-a",
      mine: true,
      from: OLD,
      to: NEW,
      phase: "requested",
      outcome: "running",
    });
    // Kept for reopening the app.
    expect(JSON.parse(t.storage.data.get(UPDATE_RUN_KEY)!)).toMatchObject({ runId: RUN });
    for (const phase of UPDATE_PHASES.slice(1, -1)) {
      t.engine.onRunChanged({ runId: RUN, phase, status: "running", updatedAtMs: T0 + 1 });
      expect(t.run()).toMatchObject({ phase, outcome: "running" });
    }
    // A frame that isn't the gateway's shape changes nothing.
    t.engine.onRunChanged({ runId: RUN, phase: "dancing", status: "running" });
    t.engine.onRunChanged({ runId: "not a run id", phase: "staging", status: "running" });
    expect(t.run()?.phase).toBe("verifying");
  });

  it("F-589: says updated only when the record says succeeded and the same gateway, reconnected, reports that version; then reads the model list again", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    t.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    t.world.handlers["update.runs.get"] = () => ({
      run: record({ phase: "finished", status: "succeeded", after: { version: NEW } }),
    });
    await t.restart(NEW);
    expect(t.run()).toMatchObject({ outcome: "updated", from: OLD, to: NEW, phase: "finished" });
    expect(t.world.refreshes).toBe(1);
    expect(t.storage.data.has(UPDATE_RUN_KEY)).toBe(false);
  });

  it("F-589: a succeeded record with the old version still reported is not called updated", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    t.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    t.world.handlers["update.runs.get"] = () => ({
      run: record({ phase: "finished", status: "succeeded", after: { version: NEW } }),
    });
    await t.restart(OLD);
    expect(t.run()).toMatchObject({ outcome: "unconfirmed", to: NEW, reported: OLD });
    expect(t.world.refreshes).toBe(0);
    // The terminal event on a later look, with the new version reported then, confirms it.
    t.set({ serverVersion: NEW });
    t.engine.onRunChanged({ runId: RUN, phase: "finished", status: "succeeded", updatedAtMs: 2 });
    await until(() => t.run()?.outcome === "updated");
  });

  it("F-589: failed, rolled back and skipped say so, with the gateway's reason and its own words", async () => {
    for (const [status, extra] of [
      [
        "failed",
        {
          reason: "managed-service-handoff-failed",
          origin: { nextAction: "Run openclaw doctor." },
        },
      ],
      [
        "rolled-back",
        {
          reason: "runtime-verification-failed",
          verification: { rollbackOutcome: { status: "succeeded", reason: "Restored 2026.10.6." } },
        },
      ],
      [
        "skipped",
        {
          reason: "managed-service-handoff-already-running",
          origin: {
            nextAction: "Another managed update is already running; retry after it completes.",
          },
        },
      ],
    ] as const) {
      const t = rig();
      t.world.handlers["update.run"] = () => started();
      await t.engine.start(t.stamp());
      t.world.handlers["update.runs.get"] = () => ({
        run: record({ phase: "finished", status, ...extra }),
      });
      t.engine.onRunChanged({ runId: RUN, phase: "finished", status, updatedAtMs: 5 });
      await until(() => t.run()?.outcome === status);
      expect(t.run()!.reason).toBe(extra.reason);
      expect(t.run()!.note).toBe(
        "origin" in extra ? extra.origin.nextAction : extra.verification.rollbackOutcome.reason,
      );
      expect(t.world.refreshes).toBe(0);
    }
  });

  it("F-589: a reconnect mid-run reads the run again and keeps following it; the bound for coming back is cancelled", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    t.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: { currentVersion: OLD, latestVersion: NEW, channel: "latest" },
      activeRun: record({ phase: "verifying" }),
    });
    await t.restart(OLD);
    expect(t.run()).toMatchObject({
      runId: RUN,
      mine: true,
      phase: "verifying",
      outcome: "running",
    });
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.cancelled).toBe(true);
  });

  it("F-589: a gateway that never comes back is said to have not come back, never updated", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    await t.restart(NEW, false);
    expect(t.timers[0]!.ms).toBe(UPDATE_AWAY_MS);
    t.timers[0]!.run();
    expect(t.run()?.outcome).toBe("away");
    // No second update while it is away.
    await expect(t.engine.start(t.stamp())).rejects.toThrow("already under way");
    expect(writes(t.world)).toHaveLength(1);
  });

  it("F-589: a run already under way when Clawtrate connects is shown, and no second one is offered or sent", async () => {
    const t = rig();
    t.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: { currentVersion: OLD, latestVersion: NEW, channel: "latest" },
      activeRun: record({ runId: OTHER_RUN, trigger: "cli", phase: "staging" }),
    });
    await t.engine.onHello();
    expect(t.run()).toMatchObject({
      runId: OTHER_RUN,
      mine: false,
      phase: "staging",
      outcome: "running",
    });
    t.world.handlers["update.run"] = () => started();
    await expect(t.engine.start(t.stamp())).rejects.toThrow("already under way");
    expect(writes(t.world)).toEqual([]);
  });

  it("F-589: a run started elsewhere is shown from its event, with no second offered", async () => {
    const t = rig();
    t.world.handlers["update.runs.get"] = () => ({
      run: record({ runId: OTHER_RUN, trigger: "campaign", phase: "staging" }),
    });
    t.engine.onRunChanged({
      runId: OTHER_RUN,
      phase: "staging",
      status: "running",
      updatedAtMs: 1,
    });
    expect(t.run()).toMatchObject({ runId: OTHER_RUN, mine: false, outcome: "running" });
    t.world.handlers["update.run"] = () => started();
    await expect(t.engine.start(t.stamp())).rejects.toThrow("already under way");
    expect(writes(t.world)).toEqual([]);
  });

  it("F-589: a gateway that can't update itself says why in its words, and no further press is sent", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => ({
      runId: RUN,
      ok: false,
      result: {
        status: "skipped",
        mode: "unknown",
        reason: "unmanaged-package-install",
        steps: [],
      },
      restart: null,
    });
    t.world.handlers["update.runs.get"] = () => ({
      run: record({ phase: "finished", status: "skipped", reason: "unmanaged-package-install" }),
    });
    await t.engine.start(t.stamp());
    expect(t.run()).toMatchObject({ outcome: "skipped", reason: "unmanaged-package-install" });
    expect(t.state().blocked).toEqual({ reason: "unmanaged-package-install", note: null });
    await expect(t.engine.start(t.stamp())).rejects.toThrow("can't update itself");
    expect(writes(t.world)).toHaveLength(1);
  });

  it("F-589: a refusal with no run (a host-owned install) is shown in the gateway's words, and kept across a reconnect; any other refusal blocks nothing", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => {
      throw new Refusal(
        "UNAVAILABLE",
        "This OpenClaw is managed by\u0007 Example Host. Update it there.",
        "host-owned-install",
      );
    };
    await expect(t.engine.start(t.stamp())).rejects.toThrow("managed by Example Host");
    const blocked = {
      reason: "host-owned-install",
      note: "This OpenClaw is managed by Example Host. Update it there.",
    };
    expect(t.state().blocked).toEqual(blocked);
    expect(t.run()).toBeNull();
    t.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    await t.restart(OLD);
    expect(t.state().blocked).toEqual(blocked);
    // A refusal for any other reason says so, and the button stays.
    const other = rig();
    other.world.handlers["update.run"] = () => {
      throw new Refusal("INVALID_REQUEST", "invalid update.run params");
    };
    await expect(other.engine.start(other.stamp())).rejects.toThrow("invalid update.run params");
    expect(other.state()).toMatchObject({ blocked: null, error: "invalid update.run params" });
  });

  it("F-589: the gateway's last refusal blocks the button only when this gateway process gave it", async () => {
    const refused = record({
      phase: "finished",
      status: "skipped",
      reason: "container-image-install",
    });
    const before = rig({ startedAt: T0 + 1 });
    before.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      lastRun: refused,
    });
    await before.engine.onHello();
    expect(before.state().blocked).toBeNull();
    const since = rig({ startedAt: T0 - 1 });
    since.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      lastRun: refused,
    });
    await since.engine.onHello();
    expect(since.state().blocked).toEqual({ reason: "container-image-install", note: null });
    const immutable = rig();
    immutable.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      schedule: { channel: "stable", autoEnabled: false, install: { kind: "immutable" } },
    });
    await immutable.engine.onHello();
    expect(immutable.state().blocked?.reason).toBe("immutable-native-updater-required");
  });

  it("F-589: without admin access nothing is sent, and nothing is read", async () => {
    const t = rig({ admin: false });
    t.world.handlers["update.run"] = () => started();
    await expect(t.engine.start(t.stamp())).rejects.toThrow("needs admin access");
    await t.engine.onHello();
    expect(t.world.sent).toEqual([]);
  });

  it("F-589: a press stamped on another gateway, or before a switch, sends nothing", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    const stamp = t.stamp();
    t.set({ target: 2 });
    await expect(t.engine.start(stamp)).rejects.toThrow("another gateway");
    t.set({ target: 1 });
    t.world.identity = "gw-b";
    await expect(t.engine.start(stamp)).rejects.toThrow("another gateway");
    expect(writes(t.world)).toEqual([]);
    expect(t.state().starting).toBe(false);
  });

  it("F-589: a press whose check is overtaken by a reconnect sends nothing", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    t.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    const original = t.ctx.sameGateway;
    t.ctx.sameGateway = async (stamp) => {
      await original(stamp);
      // A hello lands while the identity is read.
      await t.engine.onHello();
    };
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_NOT_SENT);
    expect(writes(t.world)).toEqual([]);
  });

  it("F-589: a switch to another gateway mid-run says nothing of that gateway's version, and sends it nothing", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    t.world.identity = "gw-b";
    t.world.handlers["update.status"] = () => {
      throw new Error("asked the other gateway");
    };
    await t.restart(NEW);
    expect(t.run()).toMatchObject({ outcome: "elsewhere", from: null, to: null, reported: null });
    expect(t.sentMethods()).toEqual(["update.run"]);
    // And a terminal event there claims nothing either.
    t.world.handlers["update.runs.get"] = () => ({
      run: record({ phase: "finished", status: "succeeded", after: { version: NEW } }),
    });
    t.engine.onRunChanged({ runId: RUN, phase: "finished", status: "succeeded", updatedAtMs: 9 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(t.run()?.outcome).toBe("elsewhere");
    expect(t.world.refreshes).toBe(0);
  });

  it("F-589: a press whose answer is lost is looked for on the next hello, never sent again", async () => {
    const t = rig();
    t.world.dropAfterSend = true;
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_SENT_UNKNOWN);
    expect(t.state().error).toBe(UPDATE_SENT_UNKNOWN);
    t.world.dropAfterSend = false;
    t.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      activeRun: record({ createdAtMs: Date.now(), phase: "staging" }),
    });
    await t.restart(OLD);
    expect(t.run()).toMatchObject({ runId: RUN, mine: true, outcome: "running" });
    expect(t.state().error).toBeNull();
    expect(writes(t.world)).toHaveLength(1);
  });

  it("F-589: reopening the app follows the run this device started", async () => {
    const t = rig();
    await t.storage.set(
      UPDATE_RUN_KEY,
      JSON.stringify({ gatewayId: "gw-a", runId: RUN, from: OLD, to: NEW }),
    );
    t.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      lastRun: record({ phase: "finished", status: "succeeded", after: { version: NEW } }),
    });
    t.set({ serverVersion: NEW, openclawUpdate: null });
    await t.engine.onHello();
    expect(t.run()).toMatchObject({
      runId: RUN,
      mine: true,
      outcome: "updated",
      from: OLD,
      to: NEW,
    });
    // Another gateway's kept run is not read there.
    const other = rig();
    await other.storage.set(
      UPDATE_RUN_KEY,
      JSON.stringify({ gatewayId: "gw-b", runId: RUN, from: OLD, to: NEW }),
    );
    other.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    await other.engine.onHello();
    expect(other.run()).toBeNull();
    expect(other.sentMethods()).toEqual(["update.status"]);
  });

  it("F-589: what the gateway writes is cleaned and bounded, and a version is shown only in the accepted form", () => {
    expect(updateText("a\u0000b‮c\n  d", 50)).toBe("a bc d");
    expect(updateText("x".repeat(500), 10)).toBe(`${"x".repeat(9)}…`);
    const run = readUpdateRun(
      record({
        before: { version: "unknown" },
        after: { version: "<b>9</b>" },
        reason: "r".repeat(300),
      }),
    );
    expect(run).toMatchObject({ before: null, after: null });
    expect(run!.reason!.length).toBeLessThanOrEqual(128);
    expect(readUpdateRun(record({ status: "exploded" }))).toBeNull();
  });
});

describe("F-589: the client follows an update across the gateway's restart", () => {
  it("F-589: Update sends one update.run to the gateway shown, the event and the reconnect are followed, and the provider accounts and models are read again", async () => {
    const gateway = grantingGateway();
    let version = OLD;
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
      const hello = helloOk(scopes, auth?.deviceToken ?? "device-token");
      return {
        ok: true,
        payload: {
          ...hello,
          server: { ...hello.server, version },
          snapshot: {
            ...hello.snapshot,
            updateAvailable:
              version === OLD
                ? { currentVersion: OLD, latestVersion: NEW, channel: "latest" }
                : null,
          },
        },
      };
    };
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-a" });
    let run = record();
    gateway.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      ...(run.status === "running" && gateway.calls("update.run").length ? { activeRun: run } : {}),
    });
    gateway.handlers["update.run"] = () => started();
    gateway.handlers["update.runs.get"] = () => ({ run });
    const { client } = await openTask({
      gateway,
      held: ADMIN_SCOPES,
      storage: memoryStorage({
        connection: JSON.stringify({ url: URL_A, token: null }),
        [`deviceToken:${encodeURIComponent(URL_A)}:device-1:operator`]: JSON.stringify({
          token: "device-token",
          grantedScopes: ADMIN_SCOPES,
          heldScopes: ADMIN_SCOPES,
          adminHeld: true,
        }),
      }),
    });
    await until(() => client.state.connection.gatewayId === "gw-a");
    expect(client.state.connection.openclawUpdate).toMatchObject({ latest: NEW });
    const session = createBridgeSession(client);
    await session.apply({
      type: "startOpenClawUpdate",
      stamp: gatewayStamp(client.state.connection),
    });
    expect(gateway.calls("update.run")).toEqual([{}]);
    gateway.emit("update.run.changed", {
      runId: RUN,
      phase: "staging",
      status: "running",
      updatedAtMs: 2,
    });
    await until(() => client.state.openclawUpdating?.run?.phase === "staging");
    // The gateway restarts on the new version, and its record says succeeded.
    // The model list is read the way the app reads it (`accounts.load`): the config, then auth.
    const accountReads = gateway.calls("models.authStatus").length;
    run = record({ phase: "finished", status: "succeeded", after: { version: NEW } });
    version = NEW;
    gateway.dropAll();
    await until(() => client.state.openclawUpdating?.run?.outcome === "updated");
    expect(client.state.openclawUpdating?.run).toMatchObject({ from: OLD, to: NEW });
    await until(() => gateway.calls("models.authStatus").length > accountReads);
    expect(gateway.calls("update.run")).toHaveLength(1);
    client.stop();
  });
});
