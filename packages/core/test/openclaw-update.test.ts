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
  UPDATE_ASK_WAITS_MS,
  UPDATE_HELD,
  UPDATE_LOOK_FAILED,
  UPDATE_NOT_STARTED,
  UPDATE_KEPT_CHECKING,
  UPDATE_KEPT_LOOK_FAILED,
  UPDATE_LATE_MS,
  UPDATE_RECORD_POLL_LIMIT_MS,
  UPDATE_RECORD_POLL_MS,
  UPDATE_UNTIED,
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
import { deferred, helloOk, memoryStorage, until } from "./fake-gateway.ts";

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
    tags: 0,
    now: T0 + 3_600_000,
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
    newTag: () => `tag-${String((world.tags += 1)).padStart(4, "0")}`,
    now: () => world.now,
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

/** The tag the rig's `n`th press carries, as the gateway records it in the run's origin. */
const tagOf = (n = 1) => `clawtrate-update:tag-${String(n).padStart(4, "0")}`;
const tagged = (n = 1) => ({
  origin: { requester: { channel: "webchat", senderId: tagOf(n) } },
});
/** What `update.run` carries: the press's tag on the gateway's internal channel, nothing else. */
const pressParams = (n = 1) => ({ requester: { channel: "webchat", senderId: tagOf(n) } });
/** The timers of one kind the engine set. */
const timersOf = (
  t: { timers: Array<{ ms: number; cancelled: boolean; run: () => void }> },
  ms: number,
) => t.timers.filter((each) => each.ms === ms);

/** What the engine keeps, as stored: one entry per gateway. */
const keptValue = (...entries: object[]) => JSON.stringify({ gateways: entries });
const keptOf = (t: { storage: { data: Map<string, string> } }) =>
  (JSON.parse(t.storage.data.get(UPDATE_RUN_KEY) ?? '{"gateways":[]}') as { gateways: object[] })
    .gateways;

/** Every update request the engine sent: what reaches the gateway. */
const writes = (world: { sent: Array<{ method: string }> }) =>
  world.sent.filter((each) => each.method === "update.run");

describe("F-589: updating OpenClaw, as a state machine from the gateway's frames", () => {
  it("F-589: a press sends one update.run carrying only its tag, to the gateway the screen showed, and follows each phase in the gateway's words", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    expect(t.world.sent).toEqual([{ method: "update.run", params: pressParams() }]);
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
    expect(keptOf(t)).toMatchObject([{ gatewayId: "gw-a", runId: RUN }]);
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
    // A repeat of the terminal event reads nothing more; the next connect checks again, and
    // with the new version reported then, it is confirmed.
    const reads = t.sentMethods().length;
    t.engine.onRunChanged({ runId: RUN, phase: "finished", status: "succeeded", updatedAtMs: 2 });
    expect(t.sentMethods()).toHaveLength(reads);
    await t.restart(NEW);
    expect(t.run()?.outcome).toBe("updated");
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
    expect(timersOf(t, UPDATE_AWAY_MS)).toHaveLength(1);
    expect(timersOf(t, UPDATE_AWAY_MS)[0]!.cancelled).toBe(true);
  });

  it("F-589: a gateway that never comes back is said to have not come back, never updated", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    await t.restart(NEW, false);
    const away = timersOf(t, UPDATE_AWAY_MS);
    expect(away).toHaveLength(1);
    away[0]!.run();
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
    // A connect asks nothing; opening Settings › Gateway or the confirmation does.
    await t.engine.onHello();
    expect(t.run()).toBeNull();
    await t.engine.look();
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
    await before.engine.look();
    expect(before.state().blocked).toBeNull();
    const since = rig({ startedAt: T0 - 1 });
    since.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      lastRun: refused,
    });
    await since.engine.look();
    expect(since.state().blocked).toEqual({ reason: "container-image-install", note: null });
    const immutable = rig();
    immutable.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      schedule: { channel: "stable", autoEnabled: false, install: { kind: "immutable" } },
    });
    await immutable.engine.look();
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

  it("F-589: a press whose answer is lost on a live connection is settled by asking at once: its run, by its tag, is this press's, and nothing is sent again", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => {
      throw new Error("request timed out");
    };
    const status = deferred<unknown>();
    t.world.handlers["update.status"] = () => status.promise;
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_SENT_UNKNOWN);
    expect(t.state()).toMatchObject({ looking: true, error: UPDATE_SENT_UNKNOWN });
    // Asked on the connection that is there, without waiting for a hello.
    await until(() => t.sentMethods().includes("update.status"));
    // Its own run's event arrives while the answer is out: never shown as started elsewhere.
    t.engine.onRunChanged({ runId: RUN, phase: "staging", status: "running", updatedAtMs: 1 });
    expect(t.run()).toBeNull();
    // A second press is refused while it is held.
    t.world.handlers["update.run"] = () => started();
    await expect(t.engine.start(t.stamp())).rejects.toThrow("already under way");
    status.resolve({
      sentinel: null,
      updateAvailable: null,
      activeRun: record({ phase: "staging", ...tagged() }),
    });
    await until(() => t.run()?.runId === RUN);
    expect(t.run()).toMatchObject({ mine: true, outcome: "running", phase: "staging" });
    expect(t.state()).toMatchObject({ looking: false, error: null });
    expect(keptOf(t)).toMatchObject([{ gatewayId: "gw-a", runId: RUN }]);
    expect(writes(t.world)).toHaveLength(1);
  });

  it("F-589: a lost press is matched by its tag, never by time: another run just before it is not this press's", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => {
      throw new Error("request timed out");
    };
    // The gateway's last run is another device's refusal, created a moment before the press.
    const earlier = record({
      runId: OTHER_RUN,
      createdAtMs: t.world.now - 50_000,
      phase: "finished",
      status: "failed",
      reason: "update-ledger-busy",
    });
    t.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      lastRun: earlier,
    });
    t.world.handlers["update.runs.list"] = () => ({ runs: [earlier] });
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_SENT_UNKNOWN);
    await until(() => !t.state().looking);
    expect(t.run()).toBeNull();
    expect(t.state().error).toBe(UPDATE_NOT_STARTED);
    // With its own run further back in the history, that one is found.
    const u = rig();
    u.world.handlers["update.run"] = () => {
      throw new Error("request timed out");
    };
    u.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      lastRun: earlier,
    });
    u.world.handlers["update.runs.list"] = () => ({
      runs: [earlier, record({ phase: "finished", status: "skipped", reason: "x", ...tagged() })],
    });
    await expect(u.engine.start(u.stamp())).rejects.toThrow(UPDATE_SENT_UNKNOWN);
    await until(() => u.run()?.outcome === "skipped");
    expect(u.run()).toMatchObject({ runId: RUN, mine: true });
  });

  it("F-589: when the gateway can't be asked, it says so, asks again on a bound, then offers Check again and Stop waiting; the hold always ends", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => {
      throw new Error("request timed out");
    };
    t.world.handlers["update.status"] = () => {
      throw new Refusal("UNAVAILABLE", "update status is temporarily unavailable");
    };
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_SENT_UNKNOWN);
    for (const wait of UPDATE_ASK_WAITS_MS) {
      await until(() => timersOf(t, wait).some((each) => !each.cancelled));
      timersOf(t, wait)
        .find((each) => !each.cancelled)!
        .run();
    }
    await until(() => t.state().lookFailed);
    expect(t.state()).toMatchObject({ looking: true, error: UPDATE_LOOK_FAILED });
    await expect(t.engine.start(t.stamp())).rejects.toThrow("already under way");
    // Stop waiting: Update is offered again, and the kept press is forgotten.
    await t.engine.release();
    expect(t.state()).toMatchObject({ looking: false, lookFailed: false, error: null });
    expect(t.storage.data.has(UPDATE_RUN_KEY)).toBe(false);
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    expect(writes(t.world)).toHaveLength(2);
  });

  it("F-589: reopening the app restores the hold before anything is asked: with the gateway's answer pending or failing, no second update.run goes", async () => {
    for (const answer of ["pending", "failing"] as const) {
      const t = rig();
      await t.storage.set(
        UPDATE_RUN_KEY,
        keptValue({ gatewayId: "gw-a", runId: null, tag: tagOf(9), from: OLD, to: NEW }),
      );
      t.world.handlers["update.status"] =
        answer === "pending"
          ? () => new Promise(() => {})
          : () => {
              throw new Refusal("UNAVAILABLE", "update status is temporarily unavailable");
            };
      t.world.handlers["update.run"] = () => started();
      // Pressed before the first connect's read lands.
      await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_HELD);
      void t.engine.onHello();
      await until(() => t.state().looking);
      await expect(t.engine.start(t.stamp())).rejects.toThrow("already under way");
      expect(writes(t.world)).toEqual([]);
    }
  });

  it("F-589: a press kept from before the app closed is settled by the gateway's record: its run, or none, and then Update again", async () => {
    const keptPress = keptValue({
      gatewayId: "gw-a",
      runId: null,
      tag: tagOf(9),
      from: OLD,
      to: NEW,
    });
    const t = rig();
    await t.storage.set(UPDATE_RUN_KEY, keptPress);
    t.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      lastRun: record({
        phase: "finished",
        status: "failed",
        reason: "x",
        origin: { requester: { channel: "webchat", senderId: tagOf(9) } },
      }),
    });
    await t.engine.onHello();
    expect(t.run()).toMatchObject({ runId: RUN, mine: true, outcome: "failed" });
    expect(t.state().looking).toBe(false);
    const none = rig();
    await none.storage.set(UPDATE_RUN_KEY, keptPress);
    none.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    none.world.handlers["update.runs.list"] = () => ({ runs: [] });
    await none.engine.onHello();
    expect(none.state()).toMatchObject({ looking: false, error: UPDATE_NOT_STARTED });
    expect(none.storage.data.has(UPDATE_RUN_KEY)).toBe(false);
    none.world.handlers["update.run"] = () => started();
    await none.engine.start(none.stamp());
    expect(writes(none.world)).toHaveLength(1);
  });

  it("F-589: a held press doesn't follow Clawtrate to another gateway at the same address, and comes back with the gateway it went to", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => {
      throw new Error("request timed out");
    };
    t.world.handlers["update.status"] = () => new Promise(() => {});
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_SENT_UNKNOWN);
    expect(t.state().looking).toBe(true);
    t.world.identity = "gw-b";
    t.set({ gatewayId: "gw-b" });
    await t.restart(OLD);
    expect(t.state()).toMatchObject({ looking: false, error: null });
    t.world.identity = "gw-a";
    t.set({ gatewayId: "gw-a" });
    // Back on the gateway it went to: held again, and asked about (that answer never comes here).
    void t.restart(OLD);
    await until(() => t.state().looking);
    await expect(t.engine.start(t.stamp())).rejects.toThrow("already under way");
  });

  it("F-589: repeated terminal events after Updated read nothing and the model list is read once; a late running event changes nothing", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    t.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    t.world.handlers["update.runs.get"] = () => ({
      run: record({ phase: "finished", status: "succeeded", after: { version: NEW } }),
    });
    await t.restart(NEW);
    expect(t.run()?.outcome).toBe("updated");
    const sent = t.sentMethods().length;
    for (let i = 0; i < 5; i++)
      t.engine.onRunChanged({
        runId: RUN,
        phase: "finished",
        status: "succeeded",
        updatedAtMs: 9 + i,
      });
    t.engine.onRunChanged({ runId: RUN, phase: "verifying", status: "running", updatedAtMs: 20 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(t.sentMethods()).toHaveLength(sent);
    expect(t.world.refreshes).toBe(1);
    expect(t.run()?.outcome).toBe("updated");
  });

  it("F-589: a record read before the end that lands after it doesn't take the outcome back", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    const slow = deferred<unknown>();
    const reads: Array<() => unknown> = [
      () => slow.promise,
      () => ({ run: record({ phase: "finished", status: "failed", reason: "x" }) }),
    ];
    t.world.handlers["update.runs.get"] = () => reads.shift()!();
    t.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    // A reconnect reads the run (slowly); meanwhile its end arrives and is read.
    void t.restart(OLD);
    await until(() => t.sentMethods().filter((m) => m === "update.runs.get").length === 1);
    t.engine.onRunChanged({ runId: RUN, phase: "finished", status: "failed", updatedAtMs: 5 });
    await until(() => t.run()?.outcome === "failed");
    slow.resolve({ run: record({ phase: "verifying" }) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(t.run()?.outcome).toBe("failed");
  });

  it("F-589: an install whose update manager answers with no events is followed from its record, read at once and again while nothing moves", async () => {
    const t = rig();
    const ocm = "ocm:job-1";
    t.world.handlers["update.run"] = () => ({
      runId: ocm,
      ok: true,
      result: { status: "skipped", reason: null },
      handoff: { status: "started" },
      message:
        "OCM owns this update. Use the Update status view to follow its progress and result.",
    });
    let state = record({ runId: ocm, phase: "requested", origin: {} });
    t.world.handlers["update.runs.get"] = () => ({ run: state });
    // The OCM answer names a started handoff only while running; here, one that already ran.
    t.world.handlers["update.run"] = () => ({
      runId: ocm,
      ok: true,
      result: { status: "skipped", reason: null },
      message:
        "OCM owns this update. Use the Update status view to follow its progress and result.",
    });
    await t.engine.start(t.stamp());
    expect(t.sentMethods()).toEqual(["update.run", "update.runs.get"]);
    expect(t.run()).toMatchObject({
      runId: ocm,
      outcome: "running",
      note: "OCM owns this update. Use the Update status view to follow its progress and result.",
    });
    // Nothing moves for a while: the record is read again.
    state = record({
      runId: ocm,
      phase: "finished",
      status: "failed",
      reason: "ocm-update-failed",
      origin: {},
    });
    t.world.now += UPDATE_RECORD_POLL_MS;
    const poll = timersOf(t, UPDATE_RECORD_POLL_MS).find((each) => !each.cancelled)!;
    poll.run();
    await until(() => t.run()?.outcome === "failed");
    expect(t.run()?.reason).toBe("ocm-update-failed");
  });

  it("F-589: reopening the app while its own run may be running holds Update from the first moment, whether the gateway's answer is slow, fails or never comes", async () => {
    for (const answer of ["slow", "failing", "never"] as const) {
      const t = rig();
      await t.storage.set(
        UPDATE_RUN_KEY,
        keptValue({ gatewayId: "gw-a", runId: RUN, tag: null, from: OLD, to: NEW }),
      );
      const slow = deferred<unknown>();
      t.world.handlers["update.status"] =
        answer === "slow"
          ? () => slow.promise
          : answer === "never"
            ? () => new Promise(() => {})
            : () => {
                throw new Refusal("UNAVAILABLE", "update status is temporarily unavailable");
              };
      t.world.handlers["update.runs.get"] = () => {
        throw new Refusal("UNAVAILABLE", "busy");
      };
      t.world.handlers["update.run"] = () => started(OTHER_RUN);
      // Held before the identity is even read.
      const identity = deferred<string>();
      t.ctx.identity = () => identity.promise;
      void t.engine.onHello();
      await until(() => t.state().looking);
      expect(t.state().error).toBe(UPDATE_KEPT_CHECKING);
      identity.resolve("gw-a");
      t.ctx.identity = async () => t.world.identity;
      await expect(t.engine.start(t.stamp())).rejects.toThrow(/already under way|may be under way/);
      expect(writes(t.world)).toEqual([]);
      // The kept run is never overwritten by a press.
      expect(keptOf(t)).toMatchObject([{ gatewayId: "gw-a", runId: RUN }]);
      if (answer === "slow") {
        slow.resolve({
          sentinel: null,
          updateAvailable: null,
          activeRun: record({ phase: "activating" }),
        });
        await until(() => t.run()?.runId === RUN);
        // Its own run, never "started elsewhere".
        expect(t.run()).toMatchObject({ mine: true, outcome: "running" });
        t.engine.onRunChanged({
          runId: RUN,
          phase: "restarting",
          status: "running",
          updatedAtMs: 3,
        });
        expect(t.run()).toMatchObject({ mine: true, phase: "restarting" });
      }
      if (answer === "failing") {
        for (const wait of UPDATE_ASK_WAITS_MS) {
          await until(() => timersOf(t, wait).some((each) => !each.cancelled));
          timersOf(t, wait)
            .find((each) => !each.cancelled)!
            .run();
        }
        await until(() => t.state().lookFailed);
        expect(t.state().error).toBe(UPDATE_KEPT_LOOK_FAILED);
        await expect(t.engine.start(t.stamp())).rejects.toThrow("already under way");
        expect(writes(t.world)).toEqual([]);
      }
    }
  });

  it("F-589: a press before the first connect's read lands, with a run of an earlier press kept, sends nothing", async () => {
    const t = rig();
    await t.storage.set(
      UPDATE_RUN_KEY,
      keptValue({ gatewayId: "gw-a", runId: RUN, tag: null, from: OLD, to: NEW }),
    );
    t.world.handlers["update.status"] = () => new Promise(() => {});
    t.world.handlers["update.run"] = () => started(OTHER_RUN);
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_HELD);
    expect(writes(t.world)).toEqual([]);
    expect(t.state()).toMatchObject({ looking: true, error: UPDATE_KEPT_CHECKING });
    expect(keptOf(t)).toMatchObject([{ runId: RUN }]);
  });

  it("F-589: what is held is kept per gateway: a press on another gateway leaves it, and it comes back with its own", async () => {
    const t = rig();
    await t.storage.set(
      UPDATE_RUN_KEY,
      keptValue({ gatewayId: "gw-a", runId: null, tag: tagOf(9), from: OLD, to: NEW }),
    );
    // Connected to gw-b instead: nothing holds Update there, and a press goes.
    t.world.identity = "gw-b";
    t.set({ gatewayId: "gw-b", target: 2 });
    t.world.handlers["update.run"] = () => started();
    t.world.handlers["update.status"] = () => new Promise(() => {});
    await t.engine.onHello();
    expect(t.state().looking).toBe(false);
    await t.engine.start(t.stamp());
    expect(keptOf(t)).toMatchObject([
      { gatewayId: "gw-a", runId: null, tag: tagOf(9) },
      { gatewayId: "gw-b", runId: RUN },
    ]);
    // Back on gw-a: held again, and no update.run goes there.
    t.engine.reset();
    t.world.identity = "gw-a";
    t.set({ gatewayId: "gw-a", target: 3 });
    void t.engine.onHello();
    await until(() => t.state().looking);
    await expect(t.engine.start(t.stamp())).rejects.toThrow(/already under way|may be under way/);
    expect(writes(t.world)).toHaveLength(1);
  });

  it("F-589: where the gateway records no tag, a run that may be the press's is not called someone else's, nor the press called not started", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => {
      throw new Error("request timed out");
    };
    // An install whose update manager keeps no requester: its run carries no origin.
    t.world.handlers["update.status"] = () => ({
      sentinel: null,
      updateAvailable: null,
      activeRun: record({ runId: "ocm:job-7", origin: {}, phase: "requested" }),
    });
    t.world.handlers["update.runs.list"] = () => ({ runs: [] });
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_SENT_UNKNOWN);
    await until(() => !t.state().looking);
    expect(t.run()).toMatchObject({ runId: "ocm:job-7", mine: null, outcome: "running" });
    expect(t.state().error).toBe(UPDATE_UNTIED);
  });

  it("F-589: after Stop waiting, a run that carries the press's tag is still the person's", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => {
      throw new Error("request timed out");
    };
    let status: () => unknown = () => {
      throw new Refusal("UNAVAILABLE", "update status is temporarily unavailable");
    };
    t.world.handlers["update.status"] = () => status();
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_SENT_UNKNOWN);
    for (const wait of UPDATE_ASK_WAITS_MS) {
      await until(() => timersOf(t, wait).some((each) => !each.cancelled));
      timersOf(t, wait)
        .find((each) => !each.cancelled)!
        .run();
    }
    await until(() => t.state().lookFailed);
    await t.engine.release();
    status = () => ({
      sentinel: null,
      updateAvailable: null,
      activeRun: record({ phase: "staging", ...tagged() }),
    });
    t.engine.onRunChanged({ runId: RUN, phase: "staging", status: "running", updatedAtMs: 4 });
    await until(() => t.run()?.runId === RUN);
    expect(t.run()).toMatchObject({ mine: true, outcome: "running" });
  });

  it("F-589: a gateway away longer than an update usually takes is said to be, and the run's end is shown when it's back", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    await t.restart(OLD, false);
    const late = timersOf(t, UPDATE_LATE_MS);
    expect(late).toHaveLength(1);
    expect(UPDATE_LATE_MS).toBeGreaterThan(150_000);
    late[0]!.run();
    expect(t.run()?.outcome).toBe("late");
    await expect(t.engine.start(t.stamp())).rejects.toThrow("already under way");
    // Back, with the record's failure in the gateway's words.
    t.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    t.world.handlers["update.runs.get"] = () => ({
      run: record({
        phase: "finished",
        status: "failed",
        reason: "managed-service-handoff-helper-failed",
      }),
    });
    t.set({ status: "connected", canAdmin: true });
    await t.engine.onHello();
    expect(t.run()).toMatchObject({
      outcome: "failed",
      reason: "managed-service-handoff-helper-failed",
    });
  });

  it("F-589: repeated ends while the record is being read read it once", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    const slow = deferred<unknown>();
    t.world.handlers["update.runs.get"] = () => slow.promise;
    for (let i = 0; i < 3; i++)
      t.engine.onRunChanged({ runId: RUN, phase: "finished", status: "failed", updatedAtMs: i });
    expect(t.sentMethods().filter((m) => m === "update.runs.get")).toHaveLength(1);
    slow.resolve({ run: record({ phase: "finished", status: "failed", reason: "x" }) });
    await until(() => t.run()?.outcome === "failed");
  });

  it("F-589: a quiet run's record is read again only up to its limit", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    t.world.handlers["update.runs.get"] = () => ({ run: record({ phase: "staging" }) });
    await t.engine.start(t.stamp());
    t.world.now += UPDATE_RECORD_POLL_LIMIT_MS + 1;
    const poll = timersOf(t, UPDATE_RECORD_POLL_MS).find((each) => !each.cancelled)!;
    const before = t.timers.length;
    poll.run();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(t.sentMethods().filter((m) => m === "update.runs.get")).toEqual([]);
    expect(t.timers.length).toBe(before);
  });

  it("F-589: a press while the gateway reports no newer OpenClaw sends nothing", async () => {
    const t = rig();
    t.set({ openclawUpdate: null });
    t.world.handlers["update.run"] = () => started();
    await expect(t.engine.start(t.stamp())).rejects.toThrow("doesn't report a newer OpenClaw");
    expect(t.world.sent).toEqual([]);
  });

  it("F-589: a connect with nothing to settle asks the gateway nothing", async () => {
    const t = rig();
    t.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    await t.engine.onHello();
    await t.restart(OLD);
    expect(t.world.sent).toEqual([]);
  });

  it("F-589: a press still out when Clawtrate moves to another gateway writes nothing there", async () => {
    const t = rig();
    let answer: (value: unknown) => void = () => {};
    t.world.handlers["update.run"] = () => new Promise((resolve) => (answer = resolve));
    const press = t.engine.start(t.stamp());
    await until(() => writes(t.world).length === 1);
    t.engine.reset();
    t.set({ gatewayId: "gw-b", target: 2 });
    t.world.identity = "gw-b";
    answer(started());
    await press;
    expect(t.state()).toEqual(initialOpenClawUpdate);
    expect(t.storage.data.has(UPDATE_RUN_KEY)).toBe(false);
  });

  it("F-589: reopening the app follows the run this device started", async () => {
    const t = rig();
    await t.storage.set(
      UPDATE_RUN_KEY,
      keptValue({ gatewayId: "gw-a", runId: RUN, from: OLD, to: NEW }),
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
      keptValue({ gatewayId: "gw-b", runId: RUN, from: OLD, to: NEW }),
    );
    other.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    await other.engine.onHello();
    expect(other.run()).toBeNull();
    expect(other.sentMethods()).toEqual([]);
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
    // One press, carrying only its tag on the gateway's internal channel.
    expect(gateway.calls("update.run")).toEqual([
      { requester: { channel: "webchat", senderId: expect.stringMatching(/^clawtrate-update:/) } },
    ]);
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

describe("F-591: what the engine tells the strip, the footer and the card while OpenClaw updates", () => {
  it("F-591: away longer than usual comes after 10 minutes away, past the longest absence measured on Linux and macOS", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    await t.restart(OLD, false);
    expect(UPDATE_LATE_MS).toBe(10 * 60_000);
    // The first macOS gateway under launchd was gone about 6 minutes (357,888 ms).
    expect(UPDATE_LATE_MS).toBeGreaterThan(357_888);
    expect(timersOf(t, UPDATE_LATE_MS)).toHaveLength(1);
    expect(t.run()?.outcome).toBe("running");
  });

  it("F-591: a held press names its gateway and the version it went to, so nothing is said of it on another", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => {
      throw new Error("request timed out");
    };
    t.world.handlers["update.status"] = () => deferred<unknown>().promise;
    await expect(t.engine.start(t.stamp())).rejects.toThrow(UPDATE_SENT_UNKNOWN);
    expect(t.state()).toMatchObject({ looking: true, held: { gatewayId: "gw-a", to: NEW } });
  });

  it("F-591: a succeeded run's next-action note (command-line advice) is not kept as its outcome", async () => {
    const t = rig();
    t.world.handlers["update.run"] = () => started();
    await t.engine.start(t.stamp());
    t.world.handlers["update.status"] = () => ({ sentinel: null, updateAvailable: null });
    t.world.handlers["update.runs.get"] = () => ({
      run: record({
        phase: "finished",
        status: "succeeded",
        after: { version: NEW },
        origin: {
          nextAction:
            "Stop the gateway, then run openclaw doctor --cleanup --dry-run and openclaw doctor --cleanup.",
        },
      }),
    });
    await t.restart(NEW);
    expect(t.run()).toMatchObject({ outcome: "updated", to: NEW, note: null, reason: null });
  });
});
