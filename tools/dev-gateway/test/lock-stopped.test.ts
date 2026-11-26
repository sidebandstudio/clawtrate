// `lockOrder` on an instance whose OpenClaw changes a bot's order only while the gateway is
// stopped (2026.10.10 on): the recorded gateway is stopped, the order command runs while it is
// stopped, and the gateway is started again on the same port and recorded; when starting it again
// isn't safe, the error names the commands that recover the instance. The runner is a stub that
// records every command; the gateways are `sleep` processes this test starts. No OpenClaw runs.
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { lockOrder, openInstance } from "../src/cli.ts";
import { gatedSpawn, type Gated } from "../src/env.ts";
import {
  markerProblems,
  newRunId,
  prepareFreshState,
  processIdentity,
  readMarker,
  recordProcess,
} from "../src/state-guard.ts";
import { CHECKOUT, liveProcess, stopChildren, tempDir } from "./fixtures.ts";

const spawned: Gated[] = [];
afterAll(() => {
  stopChildren();
  for (const gated of spawned) gated.child.kill("SIGTERM");
});

const PORT = 19240;
const alive = (pid: number | undefined) =>
  pid !== undefined && processIdentity(pid).state === "alive";

/** A named instance with a recorded, running gateway, on OpenClaw 2026.11.10. */
function stoppedInstance(options: { portHeld?: boolean } = {}) {
  const home = realpathSync(tempDir("clawtrate-lock-stopped-"));
  const stateDir = join(home, ".openclaw-clawtrate-dev-locks");
  const runId = newRunId();
  const start = liveProcess();
  prepareFreshState(stateDir, runId, {
    instance: "locks",
    gatewayPort: PORT,
    providerPort: PORT + 1,
    checkout: CHECKOUT,
    startPid: start.pid,
    startIdentity: start.identity,
  });
  const first = liveProcess();
  recordProcess(stateDir, runId, "gateway", first.pid);
  mkdirSync(join(stateDir, "agents", "main", "agent"), { recursive: true });
  writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify({ agents: { entries: {} } }));
  /** Each command, with whether the first gateway was still running when it ran. */
  const ran: Array<{ command: string; firstAlive: boolean }> = [];
  const runner = {
    freshRunId: null as string | null,
    refusal: () => null,
    gatewayPort: () => PORT,
    run: vi.fn(async (args: string[]) => {
      const command = args.slice(0, 4).join(" ");
      ran.push({ command, firstAlive: alive(first.pid) });
      if (args[0] === "--version")
        return { status: 0, stdout: "OpenClaw 2026.11.10 (test)\n", stderr: "" };
      if (command === "models auth order get")
        return { status: 0, stdout: '{"order":["acme:work"]}', stderr: "" };
      if (command === "approvals get --json")
        return {
          status: 0,
          stdout: JSON.stringify({
            effectivePolicy: {
              scopes: [
                { security: { effective: "deny" } },
                {
                  agentId: "otto",
                  mode: { effective: "ask" },
                  security: { effective: "allowlist" },
                  ask: { effective: "on-miss" },
                  askFallback: { effective: "deny" },
                },
              ],
            },
          }),
          stderr: "",
        };
      return { status: 0, stdout: "{}", stderr: "" };
    }),
    spawnGated: vi.fn((_args: string[], spawnOptions: { stdio: unknown }) => {
      // As the real runner does before it spawns: never on a marker it cannot trust.
      const problems = markerProblems(readMarker(stateDir)!, "locks");
      if (problems.length > 0)
        throw new Error(`a marker this tool cannot trust: ${problems.join("; ")}`);
      const gated = gatedSpawn(spawn, "sleep", ["120"], {
        stdio: spawnOptions.stdio as never,
      });
      spawned.push(gated);
      return gated;
    }),
  };
  const inst = openInstance("locks", {
    home,
    runRoot: join(home, "run"),
    runner: runner as never,
    portReleaseMs: 300,
    // The instance's port is open while the gateway its marker records runs.
    listening: async () => options.portHeld === true || alive(readMarker(stateDir)?.gatewayPid),
  });
  mkdirSync(inst.runDir, { recursive: true });
  return { inst, runner, ran, first, stateDir };
}

describe("a bot's order on OpenClaw 2026.10.10 and later, with the gateway stopped", () => {
  it("stops the recorded gateway, runs the order command while it is stopped, and starts it again on the same port", async () => {
    const { inst, runner, ran, first, stateDir } = stoppedInstance();
    expect(
      await lockOrder(inst, { bot: "main", provider: "acme", profileId: "acme:work" }),
    ).toEqual(["acme:work"]);
    expect(ran.map((each) => each.command)).toEqual([
      "gateway call health --json",
      "--version",
      "models auth order set",
      "models auth order get",
      "gateway call health --json",
      "gateway call tools.effective --params",
      "approvals get --json",
    ]);
    // The order command ran with the first gateway stopped, under the run's own id.
    expect(
      ran.filter((each) => each.command.startsWith("models")).map((e) => e.firstAlive),
    ).toEqual([false, false]);
    expect(alive(first.pid)).toBe(false);
    expect(runner.spawnGated).toHaveBeenCalledTimes(1);
    expect(runner.spawnGated.mock.calls[0]![0]).toEqual([
      "gateway",
      "run",
      "--port",
      String(PORT),
      "--bind",
      "loopback",
    ]);
    // The new gateway is the one recorded, and the runner is back to running only beside it.
    const marker = readMarker(stateDir)!;
    expect(marker.gatewayPid).toBe(spawned.at(-1)!.child.pid);
    expect(marker.gatewayPending).toBeUndefined();
    expect(runner.freshRunId).toBeNull();
  });

  it("says the gateway is stopped and how to recover the instance when its port stays held", async () => {
    const { inst, runner, ran, first } = stoppedInstance({ portHeld: true });
    await expect(
      lockOrder(inst, { bot: "main", provider: "acme", profileId: null }),
    ).rejects.toThrow(
      /port 19240 is still open.*Its gateway was stopped and is not running again\. `pnpm dev-gateway reset --instance locks` removes the instance; `pnpm dev-gateway start --instance locks` then starts it afresh\./s,
    );
    expect(alive(first.pid)).toBe(false);
    // Nothing ran offline, and no gateway was started beside a held port.
    expect(ran.map((each) => each.command)).toEqual(["gateway call health --json", "--version"]);
    expect(runner.spawnGated).not.toHaveBeenCalled();
  });
});
