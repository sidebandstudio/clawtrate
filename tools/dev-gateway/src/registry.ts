// The instances this tool created on this machine, found from their state
// folders: `~/.openclaw-dev` and `~/.openclaw-clawtrate-dev-<name>`, each with
// the tool's marker. Also the port allocation for named instances and the
// removal of instances nothing is running on.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import {
  instanceFromStateDirName,
  isNamedInstancePort,
  NAMED_PORT_BLOCK,
  NAMED_PORT_RANGE,
  PROVIDER_PORT_OFFSET,
  RESERVED_PORTS,
  stateDirFor,
} from "./instance.ts";
import { isAlive, ownership, readMarker, type Marker } from "./state-guard.ts";

export type InstanceEntry = {
  /** null is the default instance. */
  name: string | null;
  stateDir: string;
  marker: Marker;
  gatewayPort: number | undefined;
  providerPort: number | undefined;
  gatewayRunning: boolean;
  /** Its gateway, scripted model or start process is still alive. */
  busy: boolean;
};

/** Every state folder under `home` that this tool created, default instance first. */
export function listInstances(
  home: string,
  alive: (pid: number | undefined) => boolean = isAlive,
): InstanceEntry[] {
  const entries: InstanceEntry[] = [];
  for (const entry of readdirSync(home).sort()) {
    const name = instanceFromStateDirName(entry);
    if (name === undefined) continue;
    const stateDir = stateDirFor(name, home);
    if (ownership(stateDir) !== "owned") continue;
    const marker = readMarker(stateDir)!;
    // A folder whose marker names another instance is not listed as this one.
    if ((marker.instance ?? null) !== name) continue;
    const gatewayRunning = alive(marker.gatewayPid);
    entries.push({
      name,
      stateDir,
      marker,
      gatewayPort: name === null ? 19001 : marker.gatewayPort,
      providerPort: name === null ? 19091 : marker.providerPort,
      gatewayRunning,
      busy: gatewayRunning || alive(marker.providerPid) || alive(marker.startPid),
    });
  }
  return entries.sort((a, b) => (a.name === null ? -1 : b.name === null ? 1 : 0));
}

/**
 * Remove named instances that nothing is running on: no live gateway, scripted
 * model or start. The default instance is never removed here. `runDirFor`
 * gives this checkout's run folder for an instance, which is removed with it.
 */
export function pruneInstances(
  home: string,
  options: {
    alive?: (pid: number | undefined) => boolean;
    runDirFor?: (name: string) => string;
    log?: (line: string) => void;
  } = {},
): string[] {
  const alive = options.alive ?? isAlive;
  const removed: string[] = [];
  for (const entry of listInstances(home, alive)) {
    if (entry.name === null || entry.busy) continue;
    // Checked again just before deleting: it must still be ours and idle.
    if (ownership(entry.stateDir) !== "owned") continue;
    const marker = readMarker(entry.stateDir);
    if (!marker || marker.runId !== entry.marker.runId) continue;
    if (alive(marker.gatewayPid) || alive(marker.providerPid) || alive(marker.startPid)) continue;
    rmSync(entry.stateDir, { recursive: true });
    if (options.runDirFor) rmSync(options.runDirFor(entry.name), { recursive: true, force: true });
    options.log?.(`Removed instance "${entry.name}" (${entry.stateDir})`);
    removed.push(entry.name);
  }
  return removed;
}

/** True when something accepts connections on the port, on IPv4 or IPv6 loopback. */
export function portOpen(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then(([v4, v6]) => v4 || v6);
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}

export async function portFree(port: number): Promise<boolean> {
  return !(await portOpen(port)) && (await canBind(port));
}

export type InstancePorts = { gatewayPort: number; providerPort: number };

/** Every port block start in the named range, beginning at one derived from the name. */
export function candidateBlocks(name: string): number[] {
  const count = Math.floor((NAMED_PORT_RANGE.last - NAMED_PORT_RANGE.first + 1) / NAMED_PORT_BLOCK);
  const offset = createHash("sha256").update(name).digest().readUInt32BE(0) % count;
  return Array.from(
    { length: count },
    (_, i) => NAMED_PORT_RANGE.first + ((offset + i) % count) * NAMED_PORT_BLOCK,
  );
}

/**
 * Choose free ports for a named instance: a block whose gateway port, the two
 * OpenClaw derives from it and the scripted model's port are all free and not
 * recorded by any instance folder. Run under `withPortLock`, before the new
 * folder's marker records them, so two starts never pick the same block.
 */
export async function choosePorts(
  name: string,
  home: string,
  free: (port: number) => Promise<boolean> = portFree,
): Promise<InstancePorts> {
  const recorded = new Set<number>();
  for (const entry of listInstances(home, () => false)) {
    for (const port of [entry.gatewayPort, entry.providerPort]) {
      if (port === undefined) continue;
      for (let p = port; p < port + 3; p += 1) recorded.add(p);
    }
  }
  for (const base of candidateBlocks(name)) {
    const providerPort = base + PROVIDER_PORT_OFFSET;
    const ports = [base, base + 1, base + 2, providerPort];
    if (!isNamedInstancePort(base) || !isNamedInstancePort(providerPort)) continue;
    if (ports.some((port) => RESERVED_PORTS.has(port) || recorded.has(port))) continue;
    let allFree = true;
    for (const port of ports) {
      if (!(await free(port))) {
        allFree = false;
        break;
      }
    }
    if (allFree) return { gatewayPort: base, providerPort };
  }
  throw new Error(
    `no free port block in ${NAMED_PORT_RANGE.first}-${NAMED_PORT_RANGE.last}. ` +
      "Run `pnpm dev-gateway list` and `pnpm dev-gateway prune`.",
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The lock folder serialising port choice between starts on this machine. */
export function portLockPath(home: string): string {
  return join(home, ".clawtrate-dev-gateway.lock");
}

/**
 * Run `fn` while holding the machine-wide port lock: an exclusive `mkdir` with
 * the holder's PID inside. A lock whose holder is gone is taken over.
 */
export async function withPortLock<T>(
  home: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; alive?: (pid: number | undefined) => boolean } = {},
): Promise<T> {
  const lock = portLockPath(home);
  const alive = options.alive ?? isAlive;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: number | undefined;
      try {
        holder = Number(readFileSync(join(lock, "pid"), "utf8"));
      } catch {
        holder = undefined;
      }
      const stat = lstatOrNull(lock);
      const stale =
        stat?.isDirectory() && (holder ? !alive(holder) : Date.now() - stat.mtimeMs > 10_000);
      if (stale) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${lock}`, { cause: error });
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
