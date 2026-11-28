// An approve call that OpenClaw's CLI gave up on doesn't stop the tool (#907). On an iPhone CI job
// the seed's one `devices approve` printed "OpenClaw took too long to respond", which doesn't say
// whether the gateway approved, and the seed stopped. The tool now looks: the seed's next connect,
// or the device list or the gateway's node pairing list, and approves again only a request still
// pending. A refusal still fails at once. Time here is a clock the tests hand in and move: no test
// waits on, or races, the real one.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  APPROVE_COMMAND,
  NODE_APPROVAL,
  approve,
  approveById,
  cliGaveUp,
  mustApprove,
  openInstance,
  openOperator,
  type ApproveLimits,
} from "../src/cli.ts";
import { SpawnRefusedError, type OpenclawRunner, type RunResult } from "../src/env.ts";
import { GIVE_UP_PAUSE_MS, type Clock } from "../src/operator.ts";
import { tempDir } from "./fixtures.ts";

type Req = { type: "req"; id: string; method: string; params?: unknown };

/** What happened, in order: connects, CLI calls and pauses. */
type Log = string[];

/**
 * A clock the test moves: a sleep moves it by its length at once, a CLI call by what the stand-in
 * says it took, and a timer fires when the clock passes it.
 */
function testClock(log: Log) {
  let now = 1_000_000_000;
  const timers: { due: number; fire: () => void; done: boolean }[] = [];
  const take = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (timer.done || timer.due > now) continue;
      timer.done = true;
      timer.fire();
    }
  };
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      log.push(`sleep ${ms}`);
      take(ms);
    },
    after: (ms, fire) => {
      const timer = { due: now + ms, fire, done: false };
      timers.push(timer);
      return () => {
        timer.done = true;
      };
    },
  };
  const waiting = () => timers.filter((timer) => !timer.done).map((timer) => timer.due);
  return { clock, take, at: () => now, waiting };
}

/** Waits for something the test's stand-ins do, not for any length of time. */
async function until(happened: () => boolean): Promise<void> {
  while (!happened()) await new Promise((resolve) => setImmediate(resolve));
}

/** A gateway that refuses every connect with PAIRING_REQUIRED until its one device is paired. */
class PairingGateway {
  readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  paired = false;
  /** The request id it reports while the device waits; the gateway keeps one per device. */
  requestId = "req-1";
  connects = 0;
  /** Takes connects and never answers them. */
  hold = false;
  private readonly log: Log;

  constructor(log: Log) {
    this.log = log;
    this.server.on("connection", (socket: WebSocket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-1", ts: Date.now() },
        }),
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data)) as Req;
        if (frame.type !== "req" || frame.method !== "connect") return;
        this.connects += 1;
        this.log.push("connect");
        if (this.hold) return;
        socket.send(
          JSON.stringify(
            this.paired
              ? { type: "res", id: frame.id, ok: true, payload: helloOk() }
              : {
                  type: "res",
                  id: frame.id,
                  ok: false,
                  error: {
                    code: "NOT_PAIRED",
                    message: "pairing required",
                    details: { code: "PAIRING_REQUIRED", requestId: this.requestId },
                  },
                },
          ),
        );
      });
    });
  }

  get url(): string {
    const address = this.server.address();
    if (typeof address !== "object" || !address) throw new Error("not listening");
    return `ws://127.0.0.1:${address.port}`;
  }

  close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function helloOk() {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.10.6", connId: "conn-1", bootId: "boot-1" },
    features: { methods: [], events: [] },
    snapshot: { uptimeMs: 1 },
    auth: { role: "operator", scopes: ["operator.admin"] },
    policy: { maxPayload: 26_214_400, maxBufferedBytes: 52_428_800, tickIntervalMs: 30_000 },
  };
}

// What OpenClaw 2026.10.6 prints, from runs against a stand-in gateway that stalls, hangs after
// the request, drops the connection or refuses the token (2026.11.10 prints the same lines).
const fail = (output: string): RunResult => ({ status: 1, stdout: "", stderr: output });
const CHECK =
  "Check the Control UI or run `openclaw --profile clawtrate-dev-approve-retry gateway status` in your terminal.\n";
const HELP = "[openclaw] For help, run `openclaw --profile clawtrate-dev-approve-retry doctor`.\n";
const MAY_HAVE = "Your request may have completed. Check its result before trying again.\n";
/** `devices approve` whose gateway didn't answer. */
const TOO_LONG = fail(`OpenClaw took too long to respond.\n${CHECK}`);
/** `devices approve` whose gateway took the approve and didn't answer it. */
const TOO_LONG_SENT = fail(`OpenClaw took too long to respond.\n${MAY_HAVE}${CHECK}`);
const LOST = fail(`Lost the connection to OpenClaw.\n${MAY_HAVE}${CHECK}`);
const NO_CONNECTION = fail(`Couldn't connect to OpenClaw.\n${CHECK}`);
/** `devices list --json` or `gateway call --json` whose gateway didn't answer. */
const LIST_TIMEOUT = fail(
  JSON.stringify(
    {
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "timeout",
        message: "gateway timeout after 4000ms",
        timeoutMs: 4000,
      },
      gateway: { url: "ws://127.0.0.1:19460", urlSource: "local loopback" },
    },
    null,
    2,
  ),
);
const LIST_DROPPED = fail(
  JSON.stringify(
    {
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
        code: 1006,
        reason: "no close reason",
      },
      gateway: { url: "ws://127.0.0.1:19460", urlSource: "local loopback" },
    },
    null,
    2,
  ),
);
/** `nodes approve` whose gateway didn't answer. */
const NODES_TIMEOUT = fail(
  `${JSON.stringify(
    {
      ok: false,
      error: {
        type: "cli_error",
        message:
          "gateway timeout after 30000ms\nGateway target: ws://127.0.0.1:19460\nSource: local loopback\nConfig: /state/openclaw.json",
      },
    },
    null,
    2,
  )}\nOpenClaw took too long to respond.\n${CHECK}`,
);
/** A connection the gateway refused: a refusal, not a give-up. */
const TOKEN_MISMATCH = fail(
  `gateway connect failed: GatewayClientRequestError: unauthorized: gateway token mismatch\n[openclaw] The CLI command failed.\n${HELP}`,
);
/**
 * `devices approve` whose own pairing list timed out: the CLI swallows that, sends the approve
 * without the scopes the request asks for, and the gateway refuses it. 2026.10.6 says only this;
 * 2026.11.10 adds the reason.
 */
const SCOPE_REFUSED = fail(`[openclaw] The CLI command failed.\n${HELP}`);
const SCOPE_REFUSED_REASON = fail(
  `[openclaw] The CLI command failed.\n[openclaw] Reason: missing scope: operator.admin\n${HELP}`,
);
const NO_SUCH_REQUEST = fail(
  "No pending device request matches req-1. Run openclaw devices list and retry with the current request ID.\n",
);
/** The nodes command's answer for an id it doesn't know (`buildUnknownNodePairRequestIdMessage`). */
const NO_SUCH_NODE_REQUEST = fail(
  `${JSON.stringify({ ok: false, error: { type: "cli_error", message: "Unknown node pairing requestId: node-req\nRun openclaw nodes pending to inspect current requests." } }, null, 2)}\n`,
);
const APPROVED: RunResult = { status: 0, stdout: "Approved dev-1 (req-1)\n", stderr: "" };

type Rows = { pending?: Record<string, unknown>[]; paired?: Record<string, unknown>[] };
const listed = (rows: Rows): RunResult => ({ status: 0, stdout: JSON.stringify(rows), stderr: "" });

/**
 * An instance whose OpenClaw is `answer`: each call is logged, and the answer may move the clock
 * (the time the call took) or change the stand-in gateway's state, as the gateway carrying a
 * request out would.
 */
function instance(
  log: Log,
  answer: (args: string[], calls: string[][]) => RunResult | Promise<RunResult>,
) {
  const root = tempDir("clawtrate-approve-");
  const calls: string[][] = [];
  const runner = {
    refusal: () => null,
    gatewayPort: () => 19_999,
    run: async (args: string[]): Promise<RunResult> => {
      calls.push(args);
      log.push(args.join(" "));
      return answer(args, calls);
    },
  } as unknown as OpenclawRunner;
  const inst = openInstance("approve-retry", {
    home: join(root, "home"),
    runRoot: join(root, "run"),
    runner,
  });
  return { inst, calls };
}

const approveCalls = (calls: string[][]) => calls.filter((args) => args[1] === "approve");
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => new Error("it succeeded"),
    (error: unknown) => error as Error,
  );
const PREFIX = "openclaw --profile clawtrate-dev-approve-retry";

describe("the seed client's pairing approval (#907)", () => {
  let log: Log;
  let gateway: PairingGateway;
  beforeEach(async () => {
    log = [];
    gateway = new PairingGateway(log);
    await new Promise((resolve) => gateway.server.once("listening", resolve));
  });
  afterEach(() => gateway.close());

  /** Open the seed's client on `inst`, with the stand-in gateway in its connection file. */
  const open = (inst: ReturnType<typeof instance>["inst"], clock: Clock, timeoutMs = 180_000) => {
    mkdirSync(dirname(inst.connectionFile), { recursive: true });
    writeFileSync(inst.connectionFile, JSON.stringify({ url: gateway.url, token: "test-token" }));
    return openOperator(inst, "Clawtrate seed", ["operator.admin"], [], timeoutMs, clock);
  };

  it("connects without a second approve when the call that gave up had approved", async () => {
    const { clock } = testClock(log);
    const { inst } = instance(log, () => {
      gateway.paired = true;
      return TOO_LONG_SENT;
    });
    await (await open(inst, clock)).close();
    expect(log).toEqual([
      "connect",
      "devices approve req-1 --timeout 60000",
      `sleep ${GIVE_UP_PAUSE_MS}`,
      "connect",
    ]);
  });

  it("approves the same request again, after a pause, when the call that gave up had not", async () => {
    const { clock } = testClock(log);
    const { inst } = instance(log, (_args, made) => {
      if (made.length === 1) return NO_CONNECTION;
      gateway.paired = true;
      return APPROVED;
    });
    await (await open(inst, clock)).close();
    expect(log).toEqual([
      "connect",
      "devices approve req-1 --timeout 60000",
      `sleep ${GIVE_UP_PAUSE_MS}`,
      "connect",
      "devices approve req-1 --timeout 60000",
      "connect",
    ]);
  });

  it("connects when a second call finds the request gone because the first approved it late", async () => {
    const { clock } = testClock(log);
    const { inst, calls } = instance(log, (_args, made) => {
      if (made.length === 1) return TOO_LONG_SENT;
      gateway.paired = true;
      return NO_SUCH_REQUEST;
    });
    await (await open(inst, clock)).close();
    expect(approveCalls(calls)).toHaveLength(2);
    expect(gateway.connects).toBe(3);
  });

  it("gives each call half of what the connect has left, at least the CLI's 10 s the first time, at most a minute", async () => {
    const { clock, take } = testClock(log);
    const { inst } = instance(log, (_args, made) => {
      if (made.length === 1) {
        take(100_000);
        return TOO_LONG;
      }
      gateway.paired = true;
      return APPROVED;
    });
    await (await open(inst, clock)).close();
    // 180 s: a minute. Then 79 s left after the call and the pause, less 3 s for start-up: 38 s.
    expect(log.filter((line) => line.includes("approve"))).toEqual([
      "devices approve req-1 --timeout 60000",
      "devices approve req-1 --timeout 38000",
    ]);

    gateway.paired = false;
    const short = instance([], () => {
      gateway.paired = true;
      return APPROVED;
    });
    await (await open(short.inst, testClock([]).clock, 4_000)).close();
    expect(short.calls[0]).toEqual(["devices", "approve", "req-1", "--timeout", "10000"]);
  });

  it("stops when a call would get under 3 s, naming the wait, the calls and the last output", async () => {
    const { clock, take } = testClock(log);
    const { inst, calls } = instance(log, () => {
      take(50_000);
      return TOO_LONG;
    });
    const error = await failureOf(open(inst, clock));
    // Each call takes 50 s and a 1 s pause, and gets half of what is left less 3 s: 60, 60, 37.5
    // and 12 s. Then 24 s past the limit.
    expect(approveCalls(calls).map((args) => args[4])).toEqual([
      "60000",
      "60000",
      "37500",
      "12000",
    ]);
    expect(error.message).toBe(
      `Clawtrate seed's pairing request req-1: not settled after 204 s and 4 approve calls; the last printed:\n${PREFIX} devices approve req-1 --timeout 12000 failed:\nOpenClaw took too long to respond.\n${CHECK.trim()}`,
    );
  });

  it("fails at once on a refusal, with the CLI's words, after one call", async () => {
    const { inst, calls } = instance(log, () => NO_SUCH_REQUEST);
    const error = await failureOf(open(inst, testClock(log).clock));
    expect(error.message).toBe(
      `${PREFIX} devices approve req-1 --timeout 60000 failed:\n${NO_SUCH_REQUEST.stderr}`,
    );
    expect(calls).toHaveLength(1);
    expect(gateway.connects).toBe(1);
  });

  it("fails at once on a connection the gateway refused", async () => {
    const { inst, calls } = instance(log, () => TOKEN_MISMATCH);
    const error = await failureOf(open(inst, testClock(log).clock));
    expect(error.message).toContain("unauthorized: gateway token mismatch");
    expect(calls).toHaveLength(1);
  });

  it("fails at once when the guard refuses the command or the program is missing", async () => {
    const refused = instance(log, () => {
      throw new SpawnRefusedError("The development gateway started on this state is not running.");
    });
    expect((await failureOf(open(refused.inst, testClock(log).clock))).message).toBe(
      "The development gateway started on this state is not running.",
    );
    expect(refused.calls).toHaveLength(1);

    const missing = instance(log, () => {
      throw Object.assign(new Error("spawn openclaw ENOENT"), { code: "ENOENT" });
    });
    expect((await failureOf(open(missing.inst, testClock(log).clock))).message).toBe(
      "spawn openclaw ENOENT",
    );
    expect(missing.calls).toHaveLength(1);
  });

  it("approves a new request its own connect raised once the one that gave up is gone", async () => {
    // After the cut-off call the gateway answers this client's key with a new id, as it does once
    // the old request is gone. That one is approved as a request of its own, not as a retry, so an
    // answer that it isn't pending would be a refusal.
    const { inst } = instance(log, (_args, made) => {
      if (made.length === 1) {
        gateway.requestId = "req-2";
        return TOO_LONG;
      }
      gateway.paired = true;
      return APPROVED;
    });
    await (await open(inst, testClock(log).clock)).close();
    expect(log).toEqual([
      "connect",
      "devices approve req-1 --timeout 60000",
      `sleep ${GIVE_UP_PAUSE_MS}`,
      "connect",
      "devices approve req-2 --timeout 60000",
      "connect",
    ]);
  });

  it("stops after three approvals that didn't pair it", async () => {
    const { inst, calls } = instance(log, () => APPROVED);
    const error = await failureOf(open(inst, testClock(log).clock));
    expect(error.message).toBe("Clawtrate seed: still not paired after approving its request");
    expect(approveCalls(calls)).toHaveLength(3);
  });

  it("treats a request as new again after an approval, so its next refusal fails at once", async () => {
    // Gave up, then approved, but the gateway still asks: the call after that is not a retry of
    // the one that gave up, and "no pending request" from it is a refusal.
    const { inst, calls } = instance(log, (_args, made) => {
      if (made.length === 1) return TOO_LONG;
      if (made.length === 2) return APPROVED;
      return NO_SUCH_REQUEST;
    });
    const error = await failureOf(open(inst, testClock(log).clock));
    expect(error.message).toContain("No pending device request matches req-1.");
    expect(approveCalls(calls)).toHaveLength(3);
  });

  it("approves again after a retry the gateway refused because the CLI's own list timed out", async () => {
    for (const refused of [SCOPE_REFUSED, SCOPE_REFUSED_REASON]) {
      const runLog: Log = [];
      gateway.paired = false;
      const { inst } = instance(runLog, (_args, made) => {
        if (made.length === 1) return TOO_LONG;
        if (made.length === 2) return refused;
        gateway.paired = true;
        return APPROVED;
      });
      await (await open(inst, testClock(runLog).clock)).close();
      expect(runLog.filter((line) => line.includes("approve"))).toHaveLength(3);
    }
  });

  it("fails at once when the first call is refused for its scopes, as a single try did", async () => {
    const { inst, calls } = instance(log, () => SCOPE_REFUSED_REASON);
    const error = await failureOf(open(inst, testClock(log).clock));
    expect(error.message).toBe(
      `${PREFIX} devices approve req-1 --timeout 60000 failed:\n${SCOPE_REFUSED_REASON.stderr}`,
    );
    expect(calls).toHaveLength(1);
  });

  it("waits for the hello until the connect's limit on the handed-in clock", async () => {
    gateway.hold = true;
    const { clock, take, at, waiting } = testClock(log);
    const started = at();
    const { inst } = instance(log, () => APPROVED);
    const opening = failureOf(open(inst, clock));
    await until(() => log.includes("connect"));
    expect(waiting()).toEqual([started + 180_000]);
    take(179_999);
    expect(waiting()).toHaveLength(1);
    take(1);
    expect((await opening).message).toBe("Clawtrate seed: no hello before the time limit");
  });
});

const DEVICE_LOOK = (ms = 4000) => `devices list --json --timeout ${ms}`;
const NODE_LOOK = (ms = 10000) => `gateway call node.pair.list --params {} --json --timeout ${ms}`;

describe("approving a request by id, with a look between calls (#907)", () => {
  it("approves a node's request again, after a pause, while it is still pending", async () => {
    const log: Log = [];
    const { clock } = testClock(log);
    const { inst } = instance(log, (args, made) => {
      if (args[0] === "gateway") return listed({ pending: [{ requestId: "node-req" }] });
      return approveCalls(made).length === 1 ? NODES_TIMEOUT : APPROVED;
    });
    expect(await approveById(inst, "nodes", "node-req", "dev-1", { clock })).toEqual({
      approved: true,
    });
    expect(log).toEqual([
      "nodes approve node-req --timeout 30000",
      NODE_LOOK(),
      `sleep ${GIVE_UP_PAUSE_MS}`,
      "nodes approve node-req --timeout 30000",
    ]);
  });

  it("counts a node gone from the pending list as approved only when its approval is this attempt's", async () => {
    const log: Log = [];
    const { clock, take, at } = testClock(log);
    // The cut-off call carries the approve out 2 s in, and ends 3 s later; the look comes after.
    const node = (approvedEarlier: boolean) => {
      const started = at();
      let approvedAtMs = 0;
      const { inst } = instance(log, (args) => {
        if (args[0] === "gateway") {
          return listed({ pending: [], paired: [{ nodeId: "dev-1", approvedAtMs }] });
        }
        take(2_000);
        approvedAtMs = approvedEarlier ? started - 1 : at();
        take(3_000);
        return NODES_TIMEOUT;
      });
      return approveById(inst, "nodes", "node-req", "dev-1", { clock });
    };
    expect(await node(false)).toEqual({ approved: true });
    expect((await node(true)).approved).toBe(false);
  });

  it("does not count a device paired before this attempt as approved", async () => {
    // A paired device whose newer request (a scope upgrade) vanished is not this approval.
    const log: Log = [];
    const { clock, at } = testClock(log);
    const { inst } = instance(log, (args) =>
      args[1] === "approve"
        ? TOO_LONG_SENT
        : listed({ pending: [], paired: [{ deviceId: "dev-1", approvedAtMs: at() - 60_000 }] }),
    );
    const settled = await approveById(inst, "devices", "req-1", "dev-1", { clock });
    expect(settled.approved ? "" : settled.why).toContain(
      "The request is no longer pending and was not approved.",
    );
  });

  it("looks again, after a pause, when the look itself gives up", async () => {
    const log: Log = [];
    const { clock, take, at } = testClock(log);
    let approvedAtMs = 0;
    const { inst } = instance(log, (args, made) => {
      if (args[1] === "approve") {
        take(1_000);
        approvedAtMs = at();
        take(1_000);
        return TOO_LONG_SENT;
      }
      return made.length === 2
        ? LIST_TIMEOUT
        : listed({ paired: [{ deviceId: "dev-1", approvedAtMs }] });
    });
    expect(await approveById(inst, "devices", "req-1", "dev-1", { clock })).toEqual({
      approved: true,
    });
    expect(log).toEqual([
      "devices approve req-1 --timeout 30000",
      DEVICE_LOOK(10000),
      `sleep ${GIVE_UP_PAUSE_MS}`,
      DEVICE_LOOK(10000),
    ]);
  });

  /** Limits small enough to count by hand: an approve takes 25 s at most, a look 5 s. */
  const LIMITS: ApproveLimits = {
    limitMs: 60_000,
    firstApproveMs: 10_000,
    approveMs: 10_000,
    lookMs: 3_000,
    startMs: 2_000,
  };

  it("looks after the first call even when it ended past the deadline", async () => {
    const log: Log = [];
    const { clock, take, at } = testClock(log);
    let approvedAtMs = 0;
    const { inst } = instance(log, (args) => {
      if (args[1] === "list") return listed({ paired: [{ deviceId: "dev-1", approvedAtMs }] });
      take(1_000);
      approvedAtMs = at();
      take(69_000);
      return TOO_LONG_SENT;
    });
    expect(await approveById(inst, "devices", "req-1", "dev-1", { clock, limits: LIMITS })).toEqual(
      { approved: true },
    );
    expect(log).toEqual(["devices approve req-1 --timeout 10000", DEVICE_LOOK(3000)]);
  });

  it("starts another approve only when it and the look after it fit", async () => {
    // 60 s: after a 25 s call and a 5 s look, 30 s are left; another call (1 s pause, 22 s at most)
    // and its look (5 s) need 28 s. After a 28 s call, 27 s are left: no second call.
    for (const [first, second] of [
      [25_000, true],
      [28_000, false],
    ] as const) {
      const log: Log = [];
      const { clock, take } = testClock(log);
      const { inst, calls } = instance(log, (args) => {
        if (args[1] === "list") {
          take(5_000);
          return listed({ pending: [{ requestId: "req-1" }] });
        }
        take(approveCalls(calls).length === 1 ? first : 22_000);
        return TOO_LONG;
      });
      const settled = await approveById(inst, "devices", "req-1", "dev-1", {
        clock,
        limits: LIMITS,
      });
      expect(settled.approved).toBe(false);
      expect(approveCalls(calls)).toHaveLength(second ? 2 : 1);
    }
  });

  it("stops looking when looks keep giving up and no other fits", async () => {
    const log: Log = [];
    const { clock, take } = testClock(log);
    const { inst, calls } = instance(log, (args, made) => {
      // A loop that never stops ends here instead of filling the test's memory.
      if (made.length > 20) throw new Error("looked without end");
      take(args[1] === "list" ? 5_000 : 25_000);
      return args[1] === "list" ? LIST_DROPPED : LOST;
    });
    const settled = await approveById(inst, "devices", "req-1", "dev-1", { clock, limits: LIMITS });
    expect(settled.approved).toBe(false);
    // 25 s, then looks of 5 s with a 1 s pause before each after the first: 30, 36, ..., 60.
    expect(calls.filter((args) => args[1] === "list")).toHaveLength(6);
    expect(settled.approved ? "" : settled.why).toMatch(
      /^devices request req-1: not settled after 60 s and 1 approve call; the last printed:\n.*devices approve req-1 --timeout 10000 failed:\nLost the connection to OpenClaw\./,
    );
  });

  it("is not approved when the request is gone and its node not paired", async () => {
    const log: Log = [];
    const { inst, calls } = instance(log, (args) =>
      args[0] === "gateway" ? listed({ pending: [], paired: [] }) : NODES_TIMEOUT,
    );
    const settled = await approveById(inst, "nodes", "node-req", "dev-1", {
      clock: testClock(log).clock,
    });
    expect(settled.approved ? "" : settled.why).toBe(
      `nodes request node-req: not settled after 0 s and 1 approve call; the last printed:\n${PREFIX} nodes approve node-req --timeout 30000 failed:\n${NODES_TIMEOUT.stderr.trim()}\nThe request is no longer pending and was not approved.`,
    );
    expect(approveCalls(calls)).toHaveLength(1);
  });

  it("looks after a call says the listed request isn't pending, which may mean approved", async () => {
    const log: Log = [];
    const { clock, take, at } = testClock(log);
    // The request was approved (by an earlier try) before this call, which then says so.
    const approvedAtMs = at() + 500;
    const { inst } = instance(log, (args) => {
      if (args[0] === "gateway") {
        return listed({ pending: [], paired: [{ nodeId: "dev-1", approvedAtMs }] });
      }
      take(1_000);
      return NO_SUCH_NODE_REQUEST;
    });
    expect(await approveById(inst, "nodes", "node-req", "dev-1", { clock })).toEqual({
      approved: true,
    });
    expect(log).toEqual(["nodes approve node-req --timeout 30000", NODE_LOOK()]);
  });

  it("fails at once on a refusal, after one call and no look", async () => {
    const log: Log = [];
    const { inst, calls } = instance(log, () => TOKEN_MISMATCH);
    const error = await failureOf(
      approveById(inst, "nodes", "node-req", "dev-1", { clock: testClock(log).clock }),
    );
    expect(error.message).toBe(
      `${PREFIX} nodes approve node-req --timeout 30000 failed:\n${TOKEN_MISMATCH.stderr}`,
    );
    expect(calls).toHaveLength(1);
  });

  it("fits the paired machine's approvals in start's 180 s", () => {
    const { limitMs, firstApproveMs, approveMs, lookMs, startMs } = NODE_APPROVAL;
    const look = lookMs + startMs;
    const worst =
      2 * firstApproveMs + startMs + look + GIVE_UP_PAUSE_MS + 2 * approveMs + startMs + look;
    expect(worst).toBeLessThanOrEqual(limitMs);
  });

  it("stops start when the paired machine's request is not approved", async () => {
    const log: Log = [];
    const { clock } = testClock(log);
    const gone = instance(log, (args) =>
      args[0] === "gateway" ? listed({ pending: [], paired: [] }) : NODES_TIMEOUT,
    );
    const error = await failureOf(mustApprove(gone.inst, "nodes", "node-req", "dev-1", clock));
    expect(error.message).toMatch(
      /^nodes request node-req: not settled after 0 s and 1 approve call;[^]*\nThe request is no longer pending and was not approved\.$/,
    );
    const approved = instance(log, () => APPROVED);
    await expect(mustApprove(approved.inst, "nodes", "node-req", "dev-1", clock)).resolves.toBe(
      undefined,
    );
  });
});

describe("the `approve` command (#907)", () => {
  const web = { requestId: "req-1", deviceId: "dev-1", displayName: "Clawtrate web" };
  const phone = { requestId: "req-2", deviceId: "dev-2", displayName: "Clawtrate iPhone" };
  const LIST = "devices list --json";
  const run = (inst: ReturnType<typeof instance>["inst"], clock: Clock) => {
    const lines: string[] = [];
    const done = approve(inst, undefined, { log: (line) => lines.push(line), clock });
    return { lines, done };
  };

  it("approves, as a single try did, a gateway that answers each call within the CLI's 10 s", async () => {
    const log: Log = [];
    const { clock, take } = testClock(log);
    const { inst } = instance(log, (args) => {
      if (args[1] === "list") {
        take(9_000);
        return listed({ pending: [web] });
      }
      take(19_000);
      return APPROVED;
    });
    const { lines, done } = run(inst, clock);
    expect(await done).toEqual(["req-1"]);
    expect(lines).toEqual(["Approved Clawtrate web (req-1)"]);
    expect(log).toEqual([LIST, "devices approve req-1 --timeout 10000"]);
  });

  it("prints Approved for a request a cut-off call approved after its whole time, with no second approve", async () => {
    const log: Log = [];
    const { clock, take, at } = testClock(log);
    let approvedAtMs: number | null = null;
    const { inst } = instance(log, (args) => {
      if (args[1] === "approve") {
        // The gateway carries the approve out 10 s into the call, which the CLI gives up on later.
        take(10_000);
        approvedAtMs = at();
        take(13_000);
        return TOO_LONG_SENT;
      }
      return listed(
        approvedAtMs === null
          ? { pending: [web] }
          : { paired: [{ deviceId: "dev-1", approvedAtMs }] },
      );
    });
    const { lines, done } = run(inst, clock);
    expect(await done).toEqual(["req-1"]);
    expect(lines).toEqual(["Approved Clawtrate web (req-1)"]);
    expect(log).toEqual([LIST, "devices approve req-1 --timeout 10000", DEVICE_LOOK()]);
  });

  it("approves a request still pending after a cut-off call again, after a pause", async () => {
    const log: Log = [];
    const { clock } = testClock(log);
    const { inst } = instance(log, (args, made) => {
      if (args[1] === "list") return listed({ pending: [web] });
      return approveCalls(made).length === 1 ? NO_CONNECTION : APPROVED;
    });
    const { lines, done } = run(inst, clock);
    expect(await done).toEqual(["req-1"]);
    expect(lines).toEqual(["Approved Clawtrate web (req-1)"]);
    expect(log).toEqual([
      LIST,
      "devices approve req-1 --timeout 10000",
      DEVICE_LOOK(),
      `sleep ${GIVE_UP_PAUSE_MS}`,
      "devices approve req-1 --timeout 4000",
    ]);
  });

  it("approves again after a retry the gateway refused because the CLI's own list timed out", async () => {
    for (const refused of [SCOPE_REFUSED, SCOPE_REFUSED_REASON]) {
      const log: Log = [];
      const { inst } = instance(log, (args, made) => {
        if (args[1] === "list") return listed({ pending: [web] });
        const tries = approveCalls(made).length;
        return tries === 1 ? NO_CONNECTION : tries === 2 ? refused : APPROVED;
      });
      const { lines, done } = run(inst, testClock(log).clock);
      expect(await done).toEqual(["req-1"]);
      expect(lines).toEqual(["Approved Clawtrate web (req-1)"]);
      expect(log).toEqual([
        LIST,
        "devices approve req-1 --timeout 10000",
        DEVICE_LOOK(),
        `sleep ${GIVE_UP_PAUSE_MS}`,
        "devices approve req-1 --timeout 4000",
        DEVICE_LOOK(),
        `sleep ${GIVE_UP_PAUSE_MS}`,
        "devices approve req-1 --timeout 4000",
      ]);
    }
  });

  it("fails at once when the first approve call is refused, as a single try did", async () => {
    const log: Log = [];
    const { inst } = instance(log, (args) =>
      args[1] === "list" ? listed({ pending: [web] }) : SCOPE_REFUSED,
    );
    const error = await failureOf(run(inst, testClock(log).clock).done);
    expect(error.message).toBe(
      `${PREFIX} devices approve req-1 --timeout 10000 failed:\n${SCOPE_REFUSED.stderr}`,
    );
    expect(log).toEqual([LIST, "devices approve req-1 --timeout 10000"]);
  });

  it("lists again, after a pause, when the first list gives up", async () => {
    const log: Log = [];
    const { clock } = testClock(log);
    const { inst } = instance(log, (args, made) => {
      if (args[1] === "approve") return APPROVED;
      return made.length === 1 ? LIST_TIMEOUT : listed({ pending: [web] });
    });
    const { lines, done } = run(inst, clock);
    expect(await done).toEqual(["req-1"]);
    expect(lines).toEqual(["Approved Clawtrate web (req-1)"]);
    expect(log).toEqual([
      LIST,
      `sleep ${GIVE_UP_PAUSE_MS}`,
      DEVICE_LOOK(),
      "devices approve req-1 --timeout 10000",
    ]);
  });

  it("fails when the list keeps giving up, after the tries that fit", async () => {
    const log: Log = [];
    const { clock, take } = testClock(log);
    const { inst, calls } = instance(log, () => {
      take(7_000);
      return LIST_TIMEOUT;
    });
    const error = await failureOf(run(inst, clock).done);
    // Another list needs 1 + 7 s, and the first approve and its look 23 + 7 s, inside the 50 s.
    expect(calls).toHaveLength(3);
    expect(error.message).toMatch(/^Could not list the pending requests in 3 tries\.\n/);
    expect(error.message).toContain('"type": "gateway_transport_error"');
  });

  it("fails, naming what it tried, how long and the last output, when every call takes its worst and gives up", async () => {
    const log: Log = [];
    const { clock, take, at } = testClock(log);
    let listedAt = 0;
    const { inst } = instance(log, (args) => {
      const { firstApproveMs, approveMs, lookMs, startMs } = APPROVE_COMMAND;
      if (args[1] === "list") {
        take(args.length === 3 ? 10_000 + startMs : lookMs + startMs);
        if (args.length === 3) listedAt = at();
        return listed({ pending: [web] });
      }
      take(2 * (args[4] === String(firstApproveMs) ? firstApproveMs : approveMs) + startMs);
      return TOO_LONG_SENT;
    });
    const { lines, done } = run(inst, clock);
    const error = await failureOf(done);
    expect(lines).toEqual([]);
    expect(log).toEqual([
      LIST,
      "devices approve req-1 --timeout 10000",
      DEVICE_LOOK(),
      `sleep ${GIVE_UP_PAUSE_MS}`,
      "devices approve req-1 --timeout 4000",
      DEVICE_LOOK(),
    ]);
    // 23 + 7 + 1 + 11 + 7 s after the first list: inside the command's 50 s.
    expect(at() - listedAt).toBe(49_000);
    expect(error.message).toBe(
      `Not approved: Clawtrate web (req-1)\ndevices request req-1: not settled after 49 s and 2 approve calls; the last printed:\n${PREFIX} devices approve req-1 --timeout 4000 failed:\n${TOO_LONG_SENT.stderr.trim()}`,
    );
  });

  it("fails without approving a newer request from the same device", async () => {
    // The first call was cut off and the device asked again: its request has a new id.
    const log: Log = [];
    let renewed = false;
    const { inst, calls } = instance(log, (args) => {
      if (args[1] === "approve") {
        renewed = true;
        return TOO_LONG;
      }
      return listed({ pending: [renewed ? { ...web, requestId: "req-9" } : web] });
    });
    const error = await failureOf(run(inst, testClock(log).clock).done);
    expect(error.message).toContain("Not approved: Clawtrate web (req-1)");
    expect(error.message).toContain("The request is no longer pending and was not approved.");
    expect(approveCalls(calls).map((args) => args[2])).toEqual(["req-1"]);
  });

  it("prints Approved for each request approved and fails on one not approved or refused", async () => {
    const log: Log = [];
    const { inst } = instance(log, (args) => {
      if (args[1] === "list") return listed({ pending: [web, phone] });
      return args[2] === "req-1" ? APPROVED : TOKEN_MISMATCH;
    });
    const { lines, done } = run(inst, testClock(log).clock);
    const error = await failureOf(done);
    expect(lines).toEqual(["Approved Clawtrate web (req-1)"]);
    expect(error.message).toBe(
      `${PREFIX} devices approve req-2 --timeout 10000 failed:\n${TOKEN_MISMATCH.stderr}`,
    );

    const refusedFirst = instance([], (args) => {
      if (args[1] === "list") return listed({ pending: [web, phone] });
      return args[2] === "req-1" ? TOKEN_MISMATCH : APPROVED;
    });
    const second = run(refusedFirst.inst, testClock([]).clock);
    expect((await failureOf(second.done)).message).toContain("devices approve req-1");
    expect(second.lines).toEqual(["Approved Clawtrate iPhone (req-2)"]);
  });

  it("fails at once when the list is refused", async () => {
    const log: Log = [];
    const { inst, calls } = instance(log, () => TOKEN_MISMATCH);
    const error = await failureOf(run(inst, testClock(log).clock).done);
    expect(error.message).toBe(`${PREFIX} devices list --json failed:\n${TOKEN_MISMATCH.stderr}`);
    expect(calls).toHaveLength(1);
  });

  it("says there is nothing to approve, without failing, when nothing is pending", async () => {
    const log: Log = [];
    const { inst } = instance(log, () =>
      listed({ pending: [{ ...web, displayName: "Someone's laptop" }] }),
    );
    const { lines, done } = run(inst, testClock(log).clock);
    expect(await done).toEqual([]);
    expect(lines).toEqual(["No pending Clawtrate requests"]);
  });
});

describe("which CLI failures are a give-up", () => {
  it("a timeout, a lost or unfinished connection are; the gateway's answers are not", () => {
    for (const result of [
      TOO_LONG,
      TOO_LONG_SENT,
      LOST,
      NO_CONNECTION,
      LIST_TIMEOUT,
      LIST_DROPPED,
      NODES_TIMEOUT,
    ]) {
      expect(cliGaveUp(result.stderr), result.stderr).toBe(true);
    }
    for (const result of [
      TOKEN_MISMATCH,
      NO_SUCH_REQUEST,
      NO_SUCH_NODE_REQUEST,
      SCOPE_REFUSED,
      SCOPE_REFUSED_REASON,
    ]) {
      expect(cliGaveUp(result.stderr), result.stderr).toBe(false);
    }
  });
});
