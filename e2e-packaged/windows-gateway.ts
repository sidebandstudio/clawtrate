import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openInstance, start } from "../tools/dev-gateway/src/cli.ts";
import {
  CHECKOUT_DIR,
  instancePaths,
  OpenclawRunner,
  type gatedSpawn,
} from "../tools/dev-gateway/src/env.ts";
import { portFree } from "../tools/dev-gateway/src/registry.ts";
import {
  markerProblems,
  newRunId,
  ownership,
  readMarker,
  readRunRecord,
  runMatches,
  validPid,
  type Identify,
} from "../tools/dev-gateway/src/state-guard.ts";

export const hostedWindows =
  process.platform === "win32" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted";

export const windowsIdentity: Identify = (pid) => {
  if (validPid(pid)) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        return { state: "exited", how: "absent" };
    }
    const lookup = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    const ticks = lookup.stdout?.trim();
    if (lookup.status === 0 && ticks && /^\d+$/.test(ticks))
      return { state: "alive", identity: ticks };
  }
  return { state: "unknown", reason: "could not read the Windows process creation time" };
};

type OwnedChild = { pid: number; identity: string; stop(): void };

export function stopOwnedChildren(children: OwnedChild[], identify: Identify): void {
  const live = (child: OwnedChild) => {
    const found = identify(child.pid);
    if (found.state === "unknown") throw new Error(`unknown ownership for pid ${child.pid}`);
    return found.state === "alive" && found.identity === child.identity;
  };
  for (const child of children.filter(live)) if (live(child)) child.stop();
}

export function windowsInstance(name: string, children: ChildProcess[] = []) {
  const root = dirname(homedir());
  if (
    !hostedWindows ||
    !/^e2e-[0-9a-f]{8}$/.test(name) ||
    homedir() !== process.env.CLAWTRATE_PACKAGED_HOME ||
    dirname(root) !== tmpdir() ||
    !/^clawtrate-pairing-[A-Za-z0-9]{6}$/.test(basename(root)) ||
    homedir() !== join(root, "home")
  )
    throw new Error("requires a private hosted Windows test profile");
  const pkg = join(root, "runtime", "node_modules", "openclaw");
  if (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version !== "2026.10.6")
    throw new Error("unexpected OpenClaw version");
  const paths = instancePaths(name);
  const gate: typeof gatedSpawn = (spawnFn, command, args, options) => {
    if (command !== process.execPath || !Array.isArray(options.stdio))
      throw new Error("expected a gated Node child");
    const child = spawnFn(
      command,
      ["--import", new URL("./windows-gate.mjs", import.meta.url).href, ...args],
      { ...options, detached: false, windowsHide: true, stdio: [...options.stdio, "ipc"] },
    );
    children.push(child);
    return { child, release: () => child.send("go"), abort: () => child.disconnect() };
  };
  const runner = new OpenclawRunner({
    ...paths,
    instance: name,
    identify: windowsIdentity,
    windowsCli: join(pkg, "openclaw.mjs"),
    gate,
  });
  return openInstance(name, { runner, identify: windowsIdentity });
}

export async function withWindowsGateway<T>(name: string, launch: () => Promise<() => Promise<T>>) {
  const children: ChildProcess[] = [];
  const inst = windowsInstance(name, children);
  if (existsSync(inst.stateDir) || existsSync(inst.runDir))
    throw new Error("Windows instance already exists");
  const runId = newRunId();
  const cleanup = async () => {
    const marker = readMarker(inst.stateDir);
    if (
      ownership(inst.stateDir) !== "owned" ||
      !marker ||
      marker.runId !== runId ||
      markerProblems(marker, name).length ||
      !runMatches(readRunRecord(inst.runFile), marker, name, CHECKOUT_DIR)
    )
      throw new Error("Windows instance ownership is unknown; keeping its records");
    const recorded = (["provider", "gateway"] as const).flatMap((role, index) => {
      const pid = marker[`${role}Pid`];
      const identity = marker[`${role}Identity`];
      if (pid === undefined && identity === undefined && !marker[`${role}Pending`]) return [];
      const child = children[index];
      if (!child || child.pid !== pid || !validPid(pid) || !identity)
        throw new Error(`unknown ownership for ${role}`);
      return [{ pid, identity, stop: () => child.kill() }];
    });
    if (recorded.length !== children.length) throw new Error("unrecorded Windows child");
    stopOwnedChildren(recorded, windowsIdentity);
    for (const child of children) {
      const deadline = Date.now() + 10000;
      while (child.exitCode === null && child.signalCode === null) {
        if (Date.now() >= deadline) throw new Error(`no exit for recorded child ${child.pid}`);
        await sleep(50);
      }
    }
    for (const port of [marker.gatewayPort, marker.providerPort])
      if (!port || !(await portFree(port)))
        throw new Error("Windows instance port was not released");
    rmSync(inst.stateDir, { recursive: true });
    rmSync(inst.runDir, { recursive: true });
    if (existsSync(inst.stateDir) || existsSync(inst.runDir))
      throw new Error("Windows instance state remains");
    console.log(
      `Verified ${recorded.length} Windows gateway children exited, both ports free, instance state removed`,
    );
  };
  try {
    await start(inst, { runId });
    const close = await launch();
    return async () => {
      try {
        return await close();
      } finally {
        await cleanup();
      }
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (problem) {
      throw new AggregateError([error, problem], `${error}; cleanup: ${problem}`, {
        cause: problem,
      });
    }
    throw error;
  }
}
