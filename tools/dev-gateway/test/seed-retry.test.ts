// The seed's calls that are safe to repeat are tried again when the gateway doesn't answer, and
// a failed seed prints the end of the gateway's and the scripted model's logs (#610).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isTransportFailure,
  openInstance,
  retryOnTransport,
  seed,
  SEED_RETRY_DELAYS_MS,
  seedProblem,
} from "../src/cli.ts";
import type { OpenclawRunner, RunResult } from "../src/env.ts";

/** A failed `openclaw gateway call`, as `must` throws it, around the CLI's JSON answer. */
const failed = (error: Record<string, unknown>) =>
  new Error(
    `openclaw --profile clawtrate-dev-ios-1 gateway call sessions.create --json --timeout 60000 failed:\n${JSON.stringify(
      { ok: false, error, gateway: { url: "ws://127.0.0.1:19260" } },
      null,
      2,
    )}`,
  );

// The two failures of the iOS workflow's run 45689645952, as the CLI printed them.
const TIMEOUT = failed({
  type: "gateway_transport_error",
  kind: "timeout",
  message: "gateway timeout after 60000ms",
  timeoutMs: 60000,
});
const CONNECT = failed({
  type: "gateway_transport_error",
  kind: "closed",
  message: "gateway closed (4000): connect timeout",
  code: 4000,
  reason: "connect timeout",
});
// And run 45705727512's: the gateway's port didn't finish the WebSocket handshake in time.
const UNREACHABLE = failed({
  type: "gateway_transport_error",
  kind: "closed",
  message: "Gateway not reachable at ws://127.0.0.1:19780 (ETIMEDOUT).",
  reason: "Opening handshake has timed out",
});
// A start on a loaded Mac (#883): the gateway stalled after the bots' identity reloads, and
// `approvals get` reported the connect it never finished as its own error, not a transport one.
const APPROVALS_CONNECT = new Error(
  `openclaw --profile clawtrate-dev-ios-1 approvals get --json failed:
${JSON.stringify(
  {
    ok: false,
    error: {
      type: "cli_error",
      message:
        "Gateway owning /state/.openclaw-clawtrate-dev-ios-1 on local port 19780 could not complete exec.approvals.get for default exec approvals: gateway closed (4000): connect timeout\nGateway target: ws://127.0.0.1:19780\nSource: local loopback",
    },
  },
  null,
  2,
)}
gateway connect failed: Error: gateway closed (4000): connect timeout`,
);
const REFUSED = failed({
  type: "gateway_error",
  code: "INVALID_REQUEST",
  message: "session exists",
});

describe("which seed failures are the gateway not answering", () => {
  it("a timeout, a connection the gateway closed or never finished and one it never took are; a refusal is not", () => {
    expect(isTransportFailure(TIMEOUT)).toBe(true);
    expect(isTransportFailure(CONNECT)).toBe(true);
    expect(isTransportFailure(UNREACHABLE)).toBe(true);
    expect(isTransportFailure(APPROVALS_CONNECT)).toBe(true);
    expect(isTransportFailure(REFUSED)).toBe(false);
    expect(
      isTransportFailure(new Error("Marlow / Notes: the replies differ from the script")),
    ).toBe(false);
  });
});

describe("a seed call tried again when the gateway doesn't answer", () => {
  const quiet = { log: () => {}, sleep: async () => {} };

  it("waits after each failure to answer, then has the answer", async () => {
    const waits: number[] = [];
    const answers = [TIMEOUT, CONNECT, UNREACHABLE, "made"];
    const made = await retryOnTransport(
      async () => {
        const next = answers.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
      { ...quiet, sleep: async (ms) => waits.push(ms) },
    );
    expect(made).toBe("made");
    expect(waits).toEqual(SEED_RETRY_DELAYS_MS.slice(0, 3));
  });

  it("throws a refusal at once, without trying again", async () => {
    let tries = 0;
    await expect(
      retryOnTransport(async () => {
        tries += 1;
        throw REFUSED;
      }, quiet),
    ).rejects.toBe(REFUSED);
    expect(tries).toBe(1);
  });

  it("gives up with the last failure once every wait is used", async () => {
    let tries = 0;
    await expect(
      retryOnTransport(
        async () => {
          tries += 1;
          throw TIMEOUT;
        },
        { ...quiet, delays: [1, 2, 3] },
      ),
    ).rejects.toBe(TIMEOUT);
    expect(tries).toBe(4);
  });

  it("waits about three minutes in all", () => {
    const total = SEED_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(180_000);
    expect(total).toBeLessThanOrEqual(240_000);
  });
});

describe("a failed seed's message", () => {
  it("says what failed, then the end of each log, or that it is empty", () => {
    expect(
      seedProblem({
        error: "openclaw gateway call sessions.create failed:\ngateway timeout after 60000ms",
        logs: [
          {
            owner: "the development gateway's",
            log: "/run/gateway.log",
            tail: "[gateway] ready\n[gateway] startup phase: post-ready.startup-maintenance starting",
          },
          { owner: "the scripted model's", log: "/run/provider.log", tail: "" },
        ],
      }),
    ).toBe(
      [
        "the seed stopped: openclaw gateway call sessions.create failed:",
        "gateway timeout after 60000ms",
        "  the end of the development gateway's log, /run/gateway.log:",
        "    [gateway] ready",
        "    [gateway] startup phase: post-ready.startup-maintenance starting",
        "  the scripted model's log, /run/provider.log, is empty",
      ].join("\n"),
    );
  });
});

describe("a seed whose gateway stops answering its health call", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const quiet = { log: () => {}, sleep: async () => {} };

  /**
   * An instance that answers health calls from `health`. `gateway` says, from the calls so far,
   * whether its port is open and what the tool's guard refuses (null when it accepts).
   */
  function instance(
    health: () => RunResult,
    gateway: (calls: string[][]) => { open: boolean; refusal?: string } = () => ({ open: true }),
  ) {
    const root = mkdtempSync(join(tmpdir(), "clawtrate-seed-"));
    dirs.push(root);
    const calls: string[][] = [];
    const runner = {
      refusal: () => gateway(calls).refusal ?? null,
      gatewayPort: () => 19_999,
      run: async (args: string[]): Promise<RunResult> => {
        calls.push(args);
        if (args[2] === "health") return health();
        return { status: 1, stdout: "", stderr: "not scripted" };
      },
    } as unknown as OpenclawRunner;
    const inst = openInstance("seed-health", {
      home: join(root, "home"),
      runRoot: join(root, "run"),
      runner,
      listening: async () => gateway(calls).open,
    });
    mkdirSync(inst.runDir, { recursive: true });
    writeFileSync(join(inst.runDir, "gateway.log"), "[gateway] ready\n[gateway] closing\n");
    writeFileSync(join(inst.runDir, "provider.log"), "scripted model on 127.0.0.1\n");
    return { inst, calls };
  }
  const failureOf = (promise: Promise<void>) =>
    promise.then(
      () => new Error("the seed succeeded"),
      (error: unknown) => error as Error,
    );
  const HEALTH = ["gateway", "call", "health", "--json", "--timeout", "3000"];
  const TIMED_OUT = { status: 1, stdout: "", stderr: "gateway timeout after 3000ms" };
  const NOT_RUNNING =
    "the seed stopped: the development gateway is not running. Run `pnpm dev-gateway start --instance seed-health` first.";
  /** The guard's refusal once the gateway's process has exited. */
  const EXITED =
    "The development gateway started on this state (pid 4242) is not running. Run `pnpm dev-gateway start`.";
  /** Waits that are recorded and take no time. */
  const recorded = () => {
    const waits: number[] = [];
    return { waits, options: { ...quiet, sleep: async (ms: number) => waits.push(ms) } };
  };

  it("open but never healthy: asks again after each wait, then says how long it took with the end of the gateway's and the scripted model's logs", async () => {
    // A clock the waits move on, and each probe by its whole 3 s: 195 s of waits and 7 probes.
    let clock = 0;
    const { inst, calls } = instance(() => {
      clock += 3_000;
      return TIMED_OUT;
    });
    const waits: number[] = [];
    const failure = await failureOf(
      seed(inst, {
        ...quiet,
        now: () => clock,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
      }),
    );
    expect(failure.message).toBe(
      [
        "the seed stopped: the development gateway's port was open on the last look, but it didn't answer its health check in 216 s (7 tries); last: health exited 1: gateway timeout after 3000ms",
        `  the end of the development gateway's log, ${join(inst.runDir, "gateway.log")}:`,
        "    [gateway] ready",
        "    [gateway] closing",
        `  the end of the scripted model's log, ${join(inst.runDir, "provider.log")}:`,
        "    scripted model on 127.0.0.1",
      ].join("\n"),
    );
    expect(waits).toEqual([...SEED_RETRY_DELAYS_MS]);
    expect(calls).toEqual(Array.from({ length: SEED_RETRY_DELAYS_MS.length + 1 }, () => HEALTH));
  });

  it("carries on when a slow gateway answers a later try", async () => {
    const answers = [TIMED_OUT, { status: 0, stdout: "{}", stderr: "" }];
    const { inst, calls } = instance(() => answers.shift()!);
    const failure = await failureOf(seed(inst, quiet));
    // Past the health check: the next call is the seed's first step, which this runner refuses.
    expect(calls.slice(0, 3)).toEqual([HEALTH, HEALTH, ["agents", "list", "--json"]]);
    expect(failure.message).toMatch(/agents list --json failed/);
  });

  it("gone on the first probe: stops at once with no waits, its port closed or its process exited", async () => {
    const closed = instance(
      () => TIMED_OUT,
      () => ({ open: false }),
    );
    const first = recorded();
    const failure = await failureOf(seed(closed.inst, first.options));
    expect(failure.message.split("\n")[0]).toBe(NOT_RUNNING);
    expect(first.waits).toEqual([]);
    expect(closed.calls).toEqual([]);

    // The first probe fails as the process exits: the guard refuses from then on.
    const exited = instance(
      () => TIMED_OUT,
      (calls) => (calls.length === 0 ? { open: true } : { open: true, refusal: EXITED }),
    );
    const second = recorded();
    const refused = await failureOf(seed(exited.inst, second.options));
    expect(refused.message.split("\n")[0]).toBe(
      `the seed stopped: the development gateway is gone, so waiting won't help: ${EXITED}`,
    );
    expect(second.waits).toEqual([]);
    expect(exited.calls).toEqual([HEALTH]);
  });

  it("gone after two slow probes: stops then, with the waits so far and no more", async () => {
    const { inst, calls } = instance(
      () => TIMED_OUT,
      (made) => ({ open: made.length < 2 }),
    );
    const { waits, options } = recorded();
    const failure = await failureOf(seed(inst, options));
    expect(failure.message.split("\n")[0]).toBe(NOT_RUNNING);
    expect(waits).toEqual([SEED_RETRY_DELAYS_MS[0]]);
    expect(calls).toEqual([HEALTH, HEALTH]);
  });
});
