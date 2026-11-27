// The paired machine of `start --with-node` (scripted-node.ts): what it may
// declare, where its state lives, which pairing requests it approves, and that
// its process is a recorded process of the instance like the gateway. No real
// node host or gateway is started.
import type { spawn, SpawnOptions } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OpenclawRunner, SpawnRefusedError } from "../src/env.ts";
import { stateDirFor } from "../src/instance.ts";
import {
  nodeCommandRequest,
  nodeDeviceRequest,
  SCRIPTED_NODE_COMMANDS,
  SCRIPTED_NODE_NAME,
  scriptedNodeArgs,
  scriptedNodeDir,
  scriptedNodeEnv,
} from "../src/scripted-node.ts";
import { activityRefusal, markerProblems, readMarker, type Identify } from "../src/state-guard.ts";
import {
  CHECKOUT,
  deadProcess,
  liveProcess,
  seedInstance,
  stopChildren,
  tempDir,
  writeRun,
} from "./fixtures.ts";

afterAll(stopChildren);

describe("the scripted node", () => {
  it("declares only the two approvals commands, nothing that runs a command", () => {
    const args = scriptedNodeArgs(19240);
    expect(args.slice(0, 2)).toEqual(["node", "run"]);
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(args[args.indexOf("--display-name") + 1]).toBe(SCRIPTED_NODE_NAME);
    const commands = args[args.indexOf("--commands") + 1]!.split(",");
    expect(commands).toEqual(["system.execApprovals.get", "system.execApprovals.set"]);
    expect(commands).not.toContain("system.run");
    expect(commands).not.toContain("system.which");
    expect(args).not.toContain("--all-commands");
    expect(args.some((arg) => arg === "--profile" || arg === "--dev")).toBe(false);
  });

  it("keeps its state, its approvals file included, in its own folder inside the instance's", () => {
    const stateDir = stateDirFor("alpha", "/test/home");
    const env = scriptedNodeEnv(stateDir, "token-1");
    expect(env.OPENCLAW_STATE_DIR).toBe(join(stateDir, "clawtrate-nodes", SCRIPTED_NODE_NAME));
    expect(env.OPENCLAW_STATE_DIR).not.toBe(stateDir);
    expect(env.OPENCLAW_CONFIG_PATH).toBe(join(scriptedNodeDir(stateDir), "openclaw.json"));
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("token-1");
    expect(env.OPENCLAW_NO_AUTO_UPDATE).toBe("1");
  });

  it("approves only its own device request, and only one", () => {
    const own = {
      requestId: "r-1",
      deviceId: "d-1",
      role: "node",
      clientId: "node-host",
      displayName: SCRIPTED_NODE_NAME,
    };
    expect(nodeDeviceRequest({ pending: [own] })).toEqual({ requestId: "r-1", deviceId: "d-1" });
    expect(nodeDeviceRequest({ pending: [{ ...own, role: "operator" }] })).toBeNull();
    expect(nodeDeviceRequest({ pending: [{ ...own, displayName: "other" }] })).toBeNull();
    expect(nodeDeviceRequest({ pending: [{ ...own, clientId: "gateway-client" }] })).toBeNull();
    expect(nodeDeviceRequest({ pending: [own, { ...own, requestId: "r-2" }] })).toBeNull();
    expect(nodeDeviceRequest({ pending: [] })).toBeNull();
  });

  it("approves only a command request for exactly the two commands of the device it paired", () => {
    const own = { requestId: "c-1", nodeId: "d-1", commands: [...SCRIPTED_NODE_COMMANDS] };
    expect(nodeCommandRequest([own], "d-1")).toBe("c-1");
    expect(nodeCommandRequest({ pending: [own] }, "d-1")).toBe("c-1");
    expect(nodeCommandRequest([own], "d-2")).toBeNull();
    expect(
      nodeCommandRequest([{ ...own, commands: [...SCRIPTED_NODE_COMMANDS, "system.run"] }], "d-1"),
    ).toBeNull();
    expect(nodeCommandRequest([{ ...own, commands: ["system.run", "system.which"] }], "d-1")).toBe(
      null,
    );
  });

  it("is spawned only with a state folder inside the instance's", () => {
    const home = tempDir("clawtrate-home-");
    const { stateDir } = seedInstance(home, "alpha", { gateway: liveProcess() });
    const fakeSpawn = (() => {
      throw new Error("a test must never reach a real spawn");
    }) as unknown as typeof spawn;
    const runner = new OpenclawRunner({
      instance: "alpha",
      // A stand-in path: the fake spawn below runs it, never an OpenClaw.
      bin: "/test/openclaw",
      stateDir,
      runFile: join(home, "run.json"),
      spawnImpl: fakeSpawn,
    });
    runner.freshRunId = readMarker(stateDir)!.runId;
    expect(() =>
      runner.spawnNodeGated(["node", "run"], { OPENCLAW_STATE_DIR: "/elsewhere/node" }, {}),
    ).toThrow(/inside the instance's/);
    expect(() =>
      runner.spawnNodeGated(["node", "run"], { OPENCLAW_STATE_DIR: stateDir }, {}),
    ).toThrow(/inside the instance's/);
  });

  it("is spawned in exactly the folder scriptedNodeEnv names, with this platform's separators", () => {
    const home = tempDir("clawtrate-home-");
    try {
      // Synthetic processes: the injected lookup answers for them, so no real process is involved.
      const gateway = { pid: 424242, identity: "synthetic-gateway" };
      const { stateDir, runId } = seedInstance(home, "alpha", {
        start: { pid: 424241, identity: "synthetic-start" },
        gateway,
      });
      const runFile = join(home, "run.json");
      writeRun(runFile, {
        runId,
        instance: "alpha",
        checkout: CHECKOUT,
        gatewayPort: 19240,
        providerPort: 19250,
        startedAt: "",
      });
      let gatewayAlive = true;
      const lookups: number[] = [];
      const identify: Identify = (pid) => {
        lookups.push(pid);
        return pid === gateway.pid && gatewayAlive
          ? { state: "alive", identity: gateway.identity }
          : { state: "exited", how: "absent" };
      };
      const calls: { args: readonly string[]; options: SpawnOptions }[] = [];
      const fakeSpawn = ((_command: string, args: readonly string[], options: SpawnOptions) => {
        calls.push({ args, options });
        return { stdio: [] };
      }) as unknown as typeof spawn;
      const runner = new OpenclawRunner({
        instance: "alpha",
        // A stand-in path: the fake spawn above records it, never runs it.
        bin: "/test/openclaw",
        stateDir,
        runFile,
        spawnImpl: fakeSpawn,
        identify,
        checkout: CHECKOUT,
      });
      const env = scriptedNodeEnv(stateDir, "token-1");

      runner.spawnNodeGated(scriptedNodeArgs(19240), env, {}).abort();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[2]).toBe("/test/openclaw");
      expect(calls[0]!.options.cwd).toBe(scriptedNodeDir(stateDir));
      expect(calls[0]!.options.env?.OPENCLAW_STATE_DIR).toBe(scriptedNodeDir(stateDir));
      expect(calls[0]!.options.env?.OPENCLAW_GATEWAY_TOKEN).toBe("token-1");

      for (const dir of [stateDir, join(stateDir, "agents"), join(home, "elsewhere"), undefined]) {
        expect(() =>
          runner.spawnNodeGated(["node", "run"], { ...env, OPENCLAW_STATE_DIR: dir }, {}),
        ).toThrow(SpawnRefusedError);
      }
      // The ownership and process checks still come first, for the node's own folder too.
      gatewayAlive = false;
      expect(() => runner.spawnNodeGated(["node", "run"], env, {})).toThrow(/is not running/);
      expect(calls).toHaveLength(1);
      expect(new Set(lookups)).toEqual(new Set([gateway.pid]));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is a recorded process: a live node keeps the folder in use, a valid record passes", () => {
    const home = tempDir("clawtrate-home-");
    const node = liveProcess();
    const { stateDir, marker } = seedInstance(home, "alpha", {
      gateway: deadProcess(),
      provider: deadProcess(),
      marker: { nodePid: node.pid, nodeIdentity: node.identity },
    });
    expect(markerProblems(marker, "alpha")).toEqual([]);
    expect(activityRefusal(stateDir, "alpha")).toMatch(/node process/);
    const half = seedInstance(tempDir("clawtrate-home-"), "beta", {
      marker: { nodePid: node.pid },
    });
    expect(markerProblems(half.marker, "beta").join()).toMatch(/node process record/);
    const both = seedInstance(tempDir("clawtrate-home-"), "gamma", {
      marker: { nodePending: true, nodePid: node.pid, nodeIdentity: node.identity },
    });
    expect(markerProblems(both.marker, "gamma").join()).toMatch(
      /node process record is inconsistent/,
    );
  });
});
