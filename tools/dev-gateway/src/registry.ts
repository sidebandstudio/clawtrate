// The instances this tool created on this machine, found from their state
// folders: `~/.openclaw-dev` and `~/.openclaw-clawtrate-dev-<name>`, each with
// the tool's marker. Also the port allocation for named instances.

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import {
  instanceFromStateDirName,
  isNamedInstancePort,
  NAMED_PORT_BLOCK,
  NAMED_PORT_RANGE,
  PROVIDER_PORT_OFFSET,
  RESERVED_PORTS,
  stateDirFor,
} from "./instance.ts";
import {
  ownership,
  processIdentity,
  processState,
  readMarker,
  type Identify,
  type Marker,
  type ProcessState,
} from "./state-guard.ts";

/** A process lookup for callers that only need recorded data, never a verdict. */
export const NOT_CHECKED: Identify = () => ({ state: "unknown", reason: "not checked" });

export type InstanceEntry = {
  /** null is the default instance. */
  name: string | null;
  stateDir: string;
  marker: Marker;
  gatewayPort: number | undefined;
  providerPort: number | undefined;
  /** Its recorded gateway is running, proven by PID and start time. */
  gatewayRunning: boolean;
  gatewayState: ProcessState;
};

/** Every state folder under `home` that this tool created, default instance first. */
export function listInstances(home: string, identify: Identify = processIdentity): InstanceEntry[] {
  const entries: InstanceEntry[] = [];
  for (const entry of readdirSync(home).sort()) {
    const name = instanceFromStateDirName(entry);
    if (name === undefined) continue;
    const stateDir = stateDirFor(name, home);
    if (ownership(stateDir) !== "owned") continue;
    const marker = readMarker(stateDir)!;
    // A folder whose marker names another instance is not listed as this one.
    if ((marker.instance ?? null) !== name) continue;
    const gatewayState = processState(marker.gatewayPid, marker.gatewayIdentity, identify);
    entries.push({
      name,
      stateDir,
      marker,
      gatewayPort: name === null ? 19001 : marker.gatewayPort,
      providerPort: name === null ? 19091 : marker.providerPort,
      gatewayRunning: gatewayState === "alive",
      gatewayState,
    });
  }
  return entries.sort((a, b) => (a.name === null ? -1 : b.name === null ? 1 : 0));
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
 * recorded by any instance folder. Run under the port lock, before the new
 * folder's marker records them, so two starts never pick the same block.
 */
export async function choosePorts(
  name: string,
  home: string,
  free: (port: number) => Promise<boolean> = portFree,
  /** More ports of the block that must be free, as offsets from its first port. */
  extraOffsets: readonly number[] = [],
): Promise<InstancePorts> {
  const recorded = new Set<number>();
  for (const entry of listInstances(home, NOT_CHECKED)) {
    for (const port of [entry.gatewayPort, entry.providerPort]) {
      if (port === undefined) continue;
      for (let p = port; p < port + 3; p += 1) recorded.add(p);
    }
  }
  for (const base of candidateBlocks(name)) {
    const providerPort = base + PROVIDER_PORT_OFFSET;
    const ports = [base, base + 1, base + 2, providerPort, ...extraOffsets.map((o) => base + o)];
    if (!ports.every(isNamedInstancePort)) continue;
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
