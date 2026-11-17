// The development gateway never runs on reused state. Every start deletes the
// tool's own state folder and creates it again empty, so there is nothing old
// to inspect for credentials. OpenClaw keeps secrets in SQLite stores that a
// clean profile also has, so checking contents could never prove a folder clean.
//
// "The tool's own" is decided without following links: the state path is a real
// directory, not a symlink, and holds the marker as a regular file. Anything
// else is foreign and is never deleted or changed.

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MARKER_FILE = ".clawtrate-dev-gateway";
const CREATED_BY = "clawtrate tools/dev-gateway";

export type Marker = {
  createdBy: typeof CREATED_BY;
  createdAt: string;
  /** Unguessable id of the start that created this folder. */
  runId: string;
  /** The gateway started on this folder, once it is running. */
  gatewayPid?: number;
  providerPid?: number;
};

/** What `start` records in the tool's run file for the processes it spawned. */
export type RunRecord = {
  runId?: string | undefined;
  gatewayPid?: number | undefined;
  providerPid?: number | undefined;
  startedAt: string;
};

export type Ownership = "absent" | "owned" | "foreign";

export class ForeignStateError extends Error {
  constructor(stateDir: string) {
    super(
      `${stateDir} exists but was not created by the dev-gateway tool. ` +
        "Nothing was deleted or changed. Move it away yourself if it is not needed.",
    );
    this.name = "ForeignStateError";
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readMarker(stateDir: string): Marker | null {
  const path = join(stateDir, MARKER_FILE);
  if (!lstatOrNull(path)?.isFile()) return null;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as Partial<Marker>;
    if (marker.createdBy !== CREATED_BY) return null;
    // Markers from before run ids existed are still the tool's own; they just
    // never match a running gateway, so they can only be started over.
    return { ...marker, runId: typeof marker.runId === "string" ? marker.runId : "" } as Marker;
  } catch {
    return null;
  }
}

/** Decided with `lstat` only: no link is followed. */
export function ownership(stateDir: string): Ownership {
  const stat = lstatOrNull(stateDir);
  if (!stat) return "absent";
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "foreign";
  return readMarker(stateDir) ? "owned" : "foreign";
}

export function newRunId(): string {
  return randomBytes(24).toString("hex");
}

function writeMarker(stateDir: string, marker: Marker): void {
  writeFileSync(join(stateDir, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Leave the state folder empty apart from a new marker for `runId`. An owned
 * folder is deleted first (links inside it are removed, never followed); a
 * foreign one is refused untouched.
 */
export function prepareFreshState(stateDir: string, runId: string, now = new Date()): void {
  const owner = ownership(stateDir);
  if (owner === "foreign") throw new ForeignStateError(stateDir);
  if (owner === "owned") rmSync(stateDir, { recursive: true });
  // Fails if anything appeared in the meantime, rather than reusing it.
  mkdirSync(stateDir, { mode: 0o700 });
  writeMarker(stateDir, { createdBy: CREATED_BY, createdAt: now.toISOString(), runId });
}

/** Record the processes started on this folder, by the start that created it. */
export function recordGateway(
  stateDir: string,
  runId: string,
  pids: { gatewayPid: number; providerPid: number },
): void {
  const marker = readMarker(stateDir);
  if (ownership(stateDir) !== "owned" || marker?.runId !== runId) {
    throw new Error(`${stateDir} is no longer the state this start created`);
  }
  writeMarker(stateDir, { ...marker, ...pids });
}

export function readRunRecord(path: string): RunRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

export function isAlive(pid: number | undefined): pid is number {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why OpenClaw must not run now, or null when it may. It may run only against
 * the tool's own state, and only during the start that just created it
 * (`freshRunId`) or while the gateway recorded for that state is still running.
 */
export function spawnRefusal(params: {
  stateDir: string;
  run: RunRecord | null;
  freshRunId: string | null;
  isAlive: (pid: number | undefined) => boolean;
}): string | null {
  const owner = ownership(params.stateDir);
  if (owner === "absent") {
    return "There is no development gateway state. Run `pnpm dev-gateway start`.";
  }
  if (owner === "foreign") return new ForeignStateError(params.stateDir).message;
  const marker = readMarker(params.stateDir)!;
  if (params.freshRunId !== null && marker.runId !== "" && marker.runId === params.freshRunId) {
    return null;
  }
  const { run } = params;
  if (!run && marker.gatewayPid && !params.isAlive(marker.gatewayPid)) {
    return `The development gateway started on this state (pid ${marker.gatewayPid}) is not running. Run \`pnpm dev-gateway start\`.`;
  }
  if (!run || !marker.runId || run.runId !== marker.runId || marker.gatewayPid !== run.gatewayPid) {
    return "The development gateway state does not belong to the gateway this tool last started. Run `pnpm dev-gateway start`.";
  }
  if (!params.isAlive(marker.gatewayPid)) {
    return `The development gateway started on this state (pid ${marker.gatewayPid ?? "?"}) is not running. Run \`pnpm dev-gateway start\`.`;
  }
  return null;
}
