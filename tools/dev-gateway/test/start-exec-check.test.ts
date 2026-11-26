// The start's exec policy check, the first read after the gateway's health call, is tried again
// when the gateway doesn't answer, and its failure names it with the gateway's log (#647).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  execPolicyProblems,
  isTransportFailure,
  openInstance,
  SEED_RETRY_DELAYS_MS,
  seedProblem,
} from "../src/cli.ts";
import type { OpenclawRunner, RunResult } from "../src/env.ts";

/** `approvals get` under load, as the command printed it, with a neutral state folder path. */
const UNREACHABLE = `openclaw --profile clawtrate-dev-turnseed approvals get --json failed:
{
  "ok": false,
  "error": {
    "type": "cli_error",
    "message": "Gateway owning /state/exec-check on local port 19660 could not complete exec.approvals.get for default exec approvals: Gateway not reachable at ws://127.0.0.1:19660 (ETIMEDOUT).\\nStart it with \`openclaw gateway run\` or check \`openclaw gateway status\`."
  }
}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("the start's exec policy check", () => {
  it("counts the command's own report of a gateway it couldn't reach as not answering", () => {
    expect(isTransportFailure(new Error(UNREACHABLE))).toBe(true);
    // A gateway that answers and refuses is still thrown at once.
    expect(
      isTransportFailure(
        new Error(
          'openclaw approvals get failed:\n{"ok":false,"error":{"type":"cli_error","message":"unknown command"}}',
        ),
      ),
    ).toBe(false);
  });

  it("reads the policy again after a wait when the gateway didn't answer", async () => {
    vi.useFakeTimers();
    const answers: RunResult[] = [
      { status: 1, stdout: UNREACHABLE, stderr: "" },
      { status: 0, stdout: JSON.stringify({ effectivePolicy: { scopes: [] } }), stderr: "" },
    ];
    const calls: string[][] = [];
    const runner = {
      refusal: () => null,
      gatewayPort: () => 19_999,
      run: async (args: string[]) => {
        calls.push(args);
        return answers.shift()!;
      },
    } as unknown as OpenclawRunner;
    const read = execPolicyProblems(openInstance("exec-check", { runner }));
    await vi.advanceTimersByTimeAsync(SEED_RETRY_DELAYS_MS[0]!);
    // The second read's answer is the one checked: no scopes at all is reported as a problem.
    expect(await read).toEqual(["the gateway reported no exec policy scopes"]);
    expect(calls).toEqual([
      ["approvals", "get", "--json"],
      ["approvals", "get", "--json"],
    ]);
  });

  it("names the check that stopped, with the logs", () => {
    expect(
      seedProblem({
        what: "the start's exec policy check",
        error: "openclaw approvals get --json failed",
        logs: [
          { owner: "the development gateway's", log: "/run/gateway.log", tail: "[gateway] ready" },
        ],
      }),
    ).toBe(
      [
        "the start's exec policy check stopped: openclaw approvals get --json failed",
        "  the end of the development gateway's log, /run/gateway.log:",
        "    [gateway] ready",
      ].join("\n"),
    );
  });
});
