import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openInstance, start } from "../tools/dev-gateway/src/cli.ts";
import { instancePaths, OpenclawRunner, type gatedSpawn } from "../tools/dev-gateway/src/env.ts";
import { portFree } from "../tools/dev-gateway/src/registry.ts";
import {
  markerProblems,
  ownership,
  readMarker,
  readRunRecord,
  runMatches,
  validPid,
  type Identify,
  type Marker,
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

export function privatePaths(root: string, name: string) {
  const home = join(root, "home");
  const runRoot = join(root, "tools/dev-gateway/.run");
  return { ...instancePaths(name, { home, runRoot }), home, runRoot, checkout: root };
}

function checkedRoot(name: string) {
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
  return root;
}

type GateChild = { child: ChildProcess; aborted: boolean };

export function windowsInstance(name: string, children: GateChild[] = []) {
  const root = checkedRoot(name);
  const pkg = join(root, "runtime", "node_modules", "openclaw");
  if (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version !== "2026.10.6")
    throw new Error("unexpected OpenClaw version");
  const paths = privatePaths(root, name);
  const gate: typeof gatedSpawn = (spawnFn, command, args, options) => {
    if (command !== process.execPath || !Array.isArray(options.stdio))
      throw new Error("expected a gated Node child");
    const child = spawnFn(
      command,
      ["--import", new URL("./windows-gate.mjs", import.meta.url).href, ...args],
      { ...options, detached: false, windowsHide: true, stdio: [...options.stdio, "ipc"] },
    );
    const gateChild = { child, aborted: false };
    children.push(gateChild);
    return {
      child,
      release: () => child.send("go"),
      abort: () => {
        gateChild.aborted = true;
        child.disconnect();
      },
    };
  };
  const runner = new OpenclawRunner({
    ...paths,
    instance: name,
    identify: windowsIdentity,
    windowsCli: join(pkg, "openclaw.mjs"),
    gate,
  });
  return openInstance(name, { ...paths, runner, identify: windowsIdentity });
}

async function waitForGateExit(child: ChildProcess) {
  const deadline = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= deadline) throw new Error(`no exit for gate PID ${child.pid}`);
    await sleep(50);
  }
}

export async function stopGatewayGates(marker: Marker, children: GateChild[], identify: Identify) {
  for (const entry of children) if (entry.aborted) await waitForGateExit(entry.child);
  const recorded = (["provider", "gateway"] as const).flatMap((role, index) => {
    const pid = marker[`${role}Pid`];
    const identity = marker[`${role}Identity`];
    if (pid === undefined && identity === undefined && !marker[`${role}Pending`]) return [];
    const entry = children[index];
    if (entry?.aborted && marker[`${role}Pending`] && pid === undefined && identity === undefined)
      return [];
    const child = entry?.child;
    if (!child || child.pid !== pid || !validPid(pid) || !identity)
      throw new Error(`unknown ownership for ${role}`);
    return [{ pid, identity, stop: () => child.kill() }];
  });
  if (recorded.length !== children.filter((entry) => !entry.aborted).length)
    throw new Error("unrecorded Windows child");
  stopOwnedChildren(recorded, identify);
  for (const { child } of children) await waitForGateExit(child);
  console.log(`Verified ${recorded.length} recorded Windows gateway children exited`);
}

export async function withWindowsGateway<T>(name: string, launch: () => Promise<() => Promise<T>>) {
  const children: GateChild[] = [];
  const inst = windowsInstance(name, children);
  if (existsSync(inst.stateDir) || existsSync(inst.runDir))
    throw new Error("Windows instance already exists");
  const runId = process.env.CLAWTRATE_PACKAGED_RUN!;
  const cleanup = async () => {
    const marker = readMarker(inst.stateDir);
    if (
      ownership(inst.stateDir) !== "owned" ||
      !marker ||
      marker.runId !== runId ||
      markerProblems(marker, name).length ||
      !runMatches(readRunRecord(inst.runFile), marker, name, inst.checkout)
    )
      throw new Error(
        `Windows instance ownership is unknown at ${inst.stateDir} and ${inst.runDir}`,
      );
    await stopGatewayGates(marker, children, windowsIdentity);
  };
  try {
    await start(inst, { runId, seed: "pairing" });
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

export async function removeDrainedRoot(root: string, name: string, runId: string) {
  const paths = privatePaths(root, name);
  if (
    dirname(root) !== tmpdir() ||
    !/^clawtrate-pairing-[A-Za-z0-9]{6}$/.test(basename(root)) ||
    !/^e2e-[0-9a-f]{8}$/.test(name) ||
    lstatSync(root).isSymbolicLink() ||
    dirname(realpathSync(root)) !== realpathSync(tmpdir())
  )
    throw new Error(`not a pairing root: ${root}`);
  if (existsSync(paths.stateDir) || existsSync(paths.runDir)) {
    const marker = readMarker(paths.stateDir);
    if (
      ownership(paths.stateDir) !== "owned" ||
      !marker ||
      marker.runId !== runId ||
      marker.checkout !== root ||
      markerProblems(marker, name).length ||
      (existsSync(paths.runFile) && !runMatches(readRunRecord(paths.runFile), marker, name, root))
    )
      throw new Error(`unverified instance records at ${paths.stateDir} and ${paths.runDir}`);
    for (const port of [marker.gatewayPort, marker.providerPort]) {
      if (!port || !(await portFree(port)))
        throw new Error(`port ${port} not released; keeping ${paths.stateDir} and ${paths.runDir}`);
    }
    console.log("Verified both Windows gateway ports are free");
  }
  rmSync(root, { recursive: true, maxRetries: 5, retryDelay: 200 });
  if (existsSync(root)) throw new Error(`Windows pairing root remains: ${root}`);
  console.log("Removed the Windows pairing home, records and private runtime");
}

if (import.meta.main) {
  const name = process.env.CLAWTRATE_DEV_INSTANCE!;
  await removeDrainedRoot(checkedRoot(name), name, process.env.CLAWTRATE_PACKAGED_RUN!);
}
