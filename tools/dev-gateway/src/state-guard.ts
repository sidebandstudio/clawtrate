// The development gateway never runs on reused state. Every start deletes the
// tool's own state folder and creates it again empty, so there is nothing old
// to inspect for credentials. OpenClaw keeps secrets in SQLite stores that a
// clean profile also has, so checking contents could never prove a folder clean.
//
// "The tool's own" is decided without following links: the state path is a real
// directory, not a symlink, and holds the marker as a regular file. Anything
// else is foreign and is never deleted or changed.
//
// The marker records every process a start spawned on the folder, each by PID
// and by its start time, so a PID the system has since reused never counts as
// the tool's process. A process the marker cannot identify is unknown, and
// unknown is treated as running: nothing is deleted or signalled on its account.

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNamedInstancePort, validateInstanceName } from "./instance.ts";

export const MARKER_FILE = ".clawtrate-dev-gateway";
const CREATED_BY = "clawtrate tools/dev-gateway";

export type ProcessRole = "start" | "provider" | "gateway";
export const PROCESS_ROLES: readonly ProcessRole[] = ["start", "provider", "gateway"];

/** What a start records about itself when it creates the folder. */
export type MarkerOrigin = {
  /** The instance name, or null for the default instance. */
  instance?: string | null;
  gatewayPort?: number;
  providerPort?: number;
  /** The checkout whose tool created the folder. Local only, never committed. */
  checkout?: string;
  /** The `start` process, alive while the folder is being prepared. */
  startPid?: number;
  startIdentity?: string;
};

export type Marker = MarkerOrigin & {
  createdBy: typeof CREATED_BY;
  createdAt: string;
  /** Unguessable id of the start that created this folder. */
  runId: string;
  providerPid?: number;
  providerIdentity?: string;
  gatewayPid?: number;
  gatewayIdentity?: string;
};

/**
 * This checkout's claim on an instance, written by `start` once the folder is
 * created and never changed. Processes are proven through the marker.
 */
export type RunRecord = {
  runId: string;
  instance: string | null;
  checkout: string;
  gatewayPort: number;
  providerPort: number;
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

/** Thrown instead of deleting, restarting or signalling when that cannot be proven safe. */
export class StateInUseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StateInUseError";
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

/** A regular file's JSON object, never through a link; null otherwise. */
export function readJsonFile(path: string): Record<string, unknown> | null {
  if (!lstatOrNull(path)?.isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readMarker(stateDir: string): Marker | null {
  const marker = readJsonFile(join(stateDir, MARKER_FILE));
  if (marker?.createdBy !== CREATED_BY) return null;
  return marker as Marker;
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

/** A PID that may be checked or signalled: an integer above 1. Never 0, 1 or a group. */
export function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

/** What identifies a process beyond its PID: its start time, or null if it is not running. */
export type Identify = (pid: number) => string | null;

export const processIdentity: Identify = (pid) => {
  if (!validPid(pid)) return null;
  const result = spawnSync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const match = result.status === 0 ? /^\s*(\S+)\s+(.+?)\s*$/.exec(result.stdout) : null;
  // A zombie has exited; only its parent has not collected it yet.
  if (!match || match[1]!.startsWith("Z")) return null;
  return match[2]!;
};

/** "none": not recorded. "unknown": recorded but not identifiable, so treated as running. */
export type ProcessState = "none" | "dead" | "alive" | "unknown";

export function processState(pid: unknown, identity: unknown, identify: Identify): ProcessState {
  if (pid === undefined && identity === undefined) return "none";
  if (!validPid(pid) || typeof identity !== "string" || identity === "") return "unknown";
  const now = identify(pid);
  if (now === null) return "dead";
  // A different start time is a reused PID: the recorded process is gone.
  return now === identity ? "alive" : "dead";
}

/** Markers written before process identities were recorded: the default instance only. */
export function isLegacyMarker(marker: Marker): boolean {
  return marker.startIdentity === undefined && marker.instance === undefined;
}

/**
 * Everything wrong with a marker for the instance whose folder it sits in.
 * Legacy markers are checked by `activityRefusal` instead, conservatively.
 */
export function markerProblems(marker: Marker, instance: string | null): string[] {
  const problems: string[] = [];
  if (typeof marker.runId !== "string" || !/^[0-9a-f]{48}$/.test(marker.runId)) {
    problems.push("its run id is missing or malformed");
  }
  if (marker.instance !== instance) {
    problems.push(
      `it names instance ${JSON.stringify(marker.instance ?? null)}, not ${JSON.stringify(instance)}`,
    );
  } else if (instance !== null) {
    try {
      validateInstanceName(instance);
    } catch {
      problems.push("its instance name is invalid");
    }
  }
  if (typeof marker.checkout !== "string" || marker.checkout === "") {
    problems.push("it records no checkout");
  }
  if (instance !== null) {
    if (!isNamedInstancePort(marker.gatewayPort) || !isNamedInstancePort(marker.providerPort)) {
      problems.push("it records no valid ports");
    }
  }
  for (const role of PROCESS_ROLES) {
    const pid = marker[`${role}Pid`];
    const identity = marker[`${role}Identity`];
    const recorded = pid !== undefined || identity !== undefined;
    if (role === "start" && !recorded) problems.push("it records no start process");
    if (recorded && (!validPid(pid) || typeof identity !== "string" || identity === "")) {
      problems.push(`its ${role} process record is incomplete or invalid`);
    }
  }
  return problems;
}

function instanceLabel(instance: string | null, stateDir: string): string {
  const name = instance === null ? "the default instance" : `instance "${instance}"`;
  return `${name} (${stateDir})`;
}

type Activity =
  | { kind: "idle" }
  | { kind: "untrusted"; reason: string }
  | { kind: "running"; role: ProcessRole; pid: number; marker: Marker };

/**
 * Whether anything recorded on an owned folder could still be running. Every
 * recorded process must be proven gone for "idle". An invalid marker, or one
 * that names another instance, is "untrusted". Legacy markers count a recorded
 * PID as running whenever any process has it.
 */
function activity(stateDir: string, instance: string | null, identify: Identify): Activity {
  if (ownership(stateDir) !== "owned") return { kind: "idle" };
  const marker = readMarker(stateDir)!;
  if (instance === null && isLegacyMarker(marker)) {
    for (const role of ["gateway", "provider"] as const) {
      const pid = marker[`${role}Pid`];
      if (pid === undefined) continue;
      if (!validPid(pid)) {
        return { kind: "untrusted", reason: `its old marker records an invalid ${role} pid` };
      }
      if (identify(pid) !== null) return { kind: "running", role, pid, marker };
    }
    return { kind: "idle" };
  }
  const problems = markerProblems(marker, instance);
  if (problems.length > 0) return { kind: "untrusted", reason: problems.join("; ") };
  for (const role of PROCESS_ROLES) {
    const pid = marker[`${role}Pid`];
    const state = processState(pid, marker[`${role}Identity`], identify);
    if (state === "alive" || state === "unknown") {
      return { kind: "running", role, pid: pid as number, marker };
    }
  }
  return { kind: "idle" };
}

/** Why the folder must not be deleted because something on it may run, or null. */
export function activityRefusal(
  stateDir: string,
  instance: string | null,
  identify: Identify = processIdentity,
): string | null {
  const found = activity(stateDir, instance, identify);
  const label = instanceLabel(instance, stateDir);
  if (found.kind === "untrusted") {
    return `${label} has a marker this tool cannot trust: ${found.reason}. Nothing was changed.`;
  }
  if (found.kind === "running") {
    const where = found.marker.checkout ? `, started from ${found.marker.checkout}` : "";
    return `${label} is in use: its ${found.role} process (pid ${found.pid}${where}) may still be running. Nothing was changed.`;
  }
  return null;
}

/** True when this checkout's run file proves the folder's current run is this checkout's. */
export function runMatches(
  run: RunRecord | null,
  marker: Marker | null,
  instance: string | null,
  checkout: string,
): boolean {
  return (
    run !== null &&
    marker !== null &&
    typeof marker.runId === "string" &&
    marker.runId !== "" &&
    run.runId === marker.runId &&
    run.instance === instance &&
    marker.instance === instance &&
    run.checkout === checkout &&
    marker.checkout === checkout
  );
}

/**
 * Why this checkout must not touch the folder because processes it cannot
 * prove its own may run on it, or null. Processes of this checkout's own run
 * are for `stop` to prove and stop.
 */
export function inUseRefusal(
  stateDir: string,
  instance: string | null,
  run: RunRecord | null,
  checkout: string,
  identify: Identify = processIdentity,
): string | null {
  const found = activity(stateDir, instance, identify);
  if (found.kind === "idle") return null;
  if (found.kind === "running" && runMatches(run, found.marker, instance, checkout)) return null;
  if (found.kind === "untrusted") return activityRefusal(stateDir, instance, identify);
  const where = found.marker.checkout ? ` (${found.marker.checkout})` : "";
  return (
    `${instanceLabel(instance, stateDir)} is in use: its ${found.role} process (pid ${found.pid}) ` +
    `may still be running and was started by another checkout${where}, not by this one. ` +
    "Nothing was changed. Use another instance name, or stop it from the checkout that started it."
  );
}

function writeMarker(stateDir: string, marker: Marker): void {
  // Written whole and renamed into place, so a reader never sees half a marker.
  const temp = join(stateDir, `${MARKER_FILE}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, join(stateDir, MARKER_FILE));
}

/**
 * Leave the state folder empty apart from a new marker for `runId`. An owned
 * folder is deleted first only when nothing recorded on it can still be
 * running (links inside it are removed, never followed); a foreign one is
 * refused untouched. Callers hold the instance's lifecycle lock and check for
 * listeners first.
 */
export function prepareFreshState(
  stateDir: string,
  runId: string,
  origin: MarkerOrigin,
  identify: Identify = processIdentity,
  now = new Date(),
): void {
  const owner = ownership(stateDir);
  if (owner === "foreign") throw new ForeignStateError(stateDir);
  if (owner === "owned") {
    const busy = activityRefusal(stateDir, origin.instance ?? null, identify);
    if (busy) throw new StateInUseError(busy);
    rmSync(stateDir, { recursive: true });
  }
  // Fails if anything appeared in the meantime, rather than reusing it.
  mkdirSync(stateDir, { mode: 0o700 });
  writeMarker(stateDir, { ...origin, createdBy: CREATED_BY, createdAt: now.toISOString(), runId });
}

/** Record a process the start that created this folder has just spawned. */
export function recordProcess(
  stateDir: string,
  runId: string,
  role: "provider" | "gateway",
  pid: number | undefined,
  identify: Identify = processIdentity,
): void {
  const marker = readMarker(stateDir);
  if (ownership(stateDir) !== "owned" || marker?.runId !== runId) {
    throw new Error(`${stateDir} is no longer the state this start created`);
  }
  const identity = validPid(pid) ? identify(pid) : null;
  if (!validPid(pid) || identity === null) {
    throw new Error(`the ${role} process (pid ${String(pid)}) exited before it was recorded`);
  }
  writeMarker(stateDir, { ...marker, [`${role}Pid`]: pid, [`${role}Identity`]: identity });
}

/** A run file, if it is a regular file with every field of the current format. */
export function readRunRecord(path: string): RunRecord | null {
  const run = readJsonFile(path);
  if (
    !run ||
    typeof run.runId !== "string" ||
    !(run.instance === null || typeof run.instance === "string") ||
    typeof run.checkout !== "string" ||
    typeof run.gatewayPort !== "number" ||
    typeof run.providerPort !== "number" ||
    typeof run.startedAt !== "string"
  ) {
    return null;
  }
  return run as RunRecord;
}

/**
 * Why OpenClaw must not run now, or null when it may. It may run only against
 * the tool's own state, and only during the start that just created it
 * (`freshRunId`) or while the gateway this checkout's run recorded is running.
 */
export function spawnRefusal(params: {
  stateDir: string;
  run: RunRecord | null;
  freshRunId: string | null;
  /** The instance this folder must belong to; null is the default instance. */
  instance: string | null;
  checkout: string;
  identify?: Identify;
}): string | null {
  const owner = ownership(params.stateDir);
  if (owner === "absent") {
    return "There is no development gateway state. Run `pnpm dev-gateway start`.";
  }
  if (owner === "foreign") return new ForeignStateError(params.stateDir).message;
  const marker = readMarker(params.stateDir)!;
  const { instance } = params;
  if (isLegacyMarker(marker)) {
    return "The development gateway state predates this tool version. Run `pnpm dev-gateway start`.";
  }
  const problems = markerProblems(marker, instance);
  if (problems.length > 0) {
    return `${params.stateDir} has a marker this tool cannot trust: ${problems.join("; ")}.`;
  }
  if (params.freshRunId !== null && marker.runId === params.freshRunId) return null;
  const { run } = params;
  if (
    !runMatches(run, marker, instance, params.checkout) ||
    run!.gatewayPort !== (instance === null ? run!.gatewayPort : marker.gatewayPort) ||
    run!.providerPort !== (instance === null ? run!.providerPort : marker.providerPort)
  ) {
    return "The development gateway state does not belong to the gateway this checkout last started. Run `pnpm dev-gateway start`.";
  }
  const state = processState(
    marker.gatewayPid,
    marker.gatewayIdentity,
    params.identify ?? processIdentity,
  );
  if (state !== "alive") {
    return `The development gateway started on this state (pid ${marker.gatewayPid ?? "?"}) is not running. Run \`pnpm dev-gateway start\`.`;
  }
  return null;
}
