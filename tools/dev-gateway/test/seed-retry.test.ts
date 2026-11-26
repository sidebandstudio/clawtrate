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
const REFUSED = failed({
  type: "gateway_error",
  code: "INVALID_REQUEST",
  message: "session exists",
});

describe("which seed failures are the gateway not answering", () => {
  it("a timeout, a connection the gateway closed and one it never took are; a refusal is not", () => {
    expect(isTransportFailure(TIMEOUT)).toBe(true);
    expect(isTransportFailure(CONNECT)).toBe(true);
    expect(isTransportFailure(UNREACHABLE)).toBe(true);
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

  it("says so with the end of the gateway's and the scripted model's logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "clawtrate-seed-"));
    dirs.push(root);
    const calls: string[][] = [];
    // A runner the guard accepts, whose health call times out; nothing else is ever run.
    const runner = {
      refusal: () => null,
      gatewayPort: () => 19_999,
      run: async (args: string[]): Promise<RunResult> => {
        calls.push(args);
        return { status: 1, stdout: "", stderr: "gateway timeout after 3000ms" };
      },
    } as unknown as OpenclawRunner;
    const inst = openInstance("seed-health", {
      home: join(root, "home"),
      runRoot: join(root, "run"),
      runner,
      listening: async () => true,
    });
    mkdirSync(inst.runDir, { recursive: true });
    writeFileSync(join(inst.runDir, "gateway.log"), "[gateway] ready\n[gateway] closing\n");
    writeFileSync(join(inst.runDir, "provider.log"), "scripted model on 127.0.0.1\n");
    const failure = await seed(inst).then(
      () => new Error("the seed succeeded"),
      (error: unknown) => error as Error,
    );
    expect(failure.message).toBe(
      [
        "the seed stopped: the development gateway is not running. Run `pnpm dev-gateway start --instance seed-health` first.",
        `  the end of the development gateway's log, ${join(inst.runDir, "gateway.log")}:`,
        "    [gateway] ready",
        "    [gateway] closing",
        `  the end of the scripted model's log, ${join(inst.runDir, "provider.log")}:`,
        "    scripted model on 127.0.0.1",
      ].join("\n"),
    );
    expect(calls).toEqual([["gateway", "call", "health", "--json", "--timeout", "3000"]]);
  });
});
