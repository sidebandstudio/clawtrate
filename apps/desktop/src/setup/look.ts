// The look on this computer (docs/design/setup.md §4, §6): find the
// program in its fixed places, ask its version, ask each profile's gateway,
// and say what was found. Every step is read-only and has its own time
// limit; every program runs through `RunProgram`, never a shell, in the
// world's own working folder. A sandboxed world never runs the deep status.

import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_LOOK_OTHERS,
  OLDEST_OPENCLAW_VERSION,
  TESTED_OPENCLAW_VERSION,
  type CantTellReason,
  type LookOutcome,
  type SetupLook,
} from "@clawtrate/core";
import {
  compareVersions,
  parseAuthMode,
  parseBareVersion,
  parseExtraServices,
  parseStatus,
  parseVersionLine,
  serviceFact,
  type AuthMode,
  type GatewayStatus,
  type Version,
} from "./parse.ts";
import type { ProgramResult, RunProgram } from "./programs.ts";
import { programPath, type LookProfile, type LookWorld } from "./world.ts";

export const OLDEST_VERSION = OLDEST_OPENCLAW_VERSION;

export const LIMITS = {
  version: { timeoutMs: 10_000, maxBytes: 4 * 1024 },
  status: { timeoutMs: 20_000, maxBytes: 256 * 1024 },
  deep: { timeoutMs: 20_000, maxBytes: 512 * 1024 },
  auth: { timeoutMs: 10_000, maxBytes: 4 * 1024 },
} as const;

/** The design's limit on the look's own checks of files (§4). */
export const FILE_CHECK_MS = 2_000;

/** The steps the person sees: "Finding OpenClaw", "Checking its version", "Asking the gateway". */
export const LOOK_STEPS = 3;

/** A gateway the look found and Connect may pair with: the facts the host's dialog shows and checks again. */
export type FoundGateway = {
  program: string;
  profile: LookProfile;
  port: number;
  version: string;
  /** The config file `gateway status` named for this profile. */
  configPath: string;
  /** The service as the status reported it. */
  serviceKey: string;
};

export type LookReport = { look: SetupLook; found: FoundGateway | null };

const empty: Omit<SetupLook, "outcome"> = {
  reason: null,
  version: null,
  profile: null,
  listens: null,
  service: null,
  port: null,
  authMode: null,
  access: null,
  others: [],
};

const cantTell = (reason: CantTellReason, version: string | null = null): SetupLook => ({
  ...empty,
  outcome: "cant-tell",
  reason,
  version,
});

class FileCheckTimeout extends Error {}

/** Every file check of one look, together, within `FILE_CHECK_MS`. */
function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const left = Math.max(0, deadline - Date.now());
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new FileCheckTimeout()), left);
      timer.unref?.();
    }),
  ]);
}

/** Whether a path exists, followed through links. */
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The first candidate that is a regular executable file. */
async function findProgram(world: LookWorld): Promise<string | null> {
  for (const candidate of world.candidates) {
    try {
      const found = await stat(candidate);
      if (found.isFile() && (found.mode & 0o111) !== 0) return candidate;
    } catch {
      // not there
    }
  }
  return null;
}

/** Other profiles' state folders in the home folder, by name only: folders, never opened. */
async function otherProfiles(world: LookWorld): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(world.home);
  } catch {
    return [];
  }
  const known = new Set(world.profiles.flatMap((profile) => [profile.name, "clawtrate"]));
  const names: string[] = [];
  for (const entry of entries) {
    const match = /^\.openclaw-([a-z0-9][a-z0-9._-]{0,63})$/.exec(entry);
    if (!match || known.has(match[1]!)) continue;
    // A file or a link of that name is not a profile.
    const folder = await lstat(join(world.home, entry)).then(
      (found) => found.isDirectory(),
      () => false,
    );
    if (folder) names.push(`profile ${match[1]}`);
  }
  return names.sort();
}

type ProfileLook =
  | { kind: "status"; status: GatewayStatus; auth: AuthMode | null }
  | { kind: "fail"; reason: CantTellReason };

export type LookOptions = {
  /** Called as each step starts. */
  onStep?: (step: number) => void;
  /** Set when the person went Back: nothing more is started. */
  cancelled?: () => boolean;
};

/** Whether a program couldn't be started at all: spawn failed, or the system said it can't run it. */
const couldNotRun = (result: ProgramResult) =>
  result.failed || result.exitCode === 126 || result.exitCode === 127;

export async function lookHere(
  world: LookWorld,
  run: RunProgram,
  options: LookOptions = {},
): Promise<LookReport | null> {
  const cancelled = options.cancelled ?? (() => false);
  options.onStep?.(0);
  if (world.platform === "win32") return { look: { ...empty, outcome: "windows" }, found: null };

  const files = Date.now() + FILE_CHECK_MS;
  let program: string | null;
  try {
    program = await withDeadline(findProgram(world), files);
    if (!program) {
      const signs = [join(world.home, ".openclaw"), ...world.serviceFiles];
      const setUp = (await withDeadline(Promise.all(signs.map(exists)), files)).some(Boolean);
      return {
        look: { ...empty, outcome: setUp ? "program-missing" : "not-found" },
        found: null,
      };
    }
  } catch (error) {
    if (error instanceof FileCheckTimeout) return { look: cantTell("timeout"), found: null };
    throw error;
  }
  const env = (profile: LookProfile) => ({
    ...world.env,
    PATH: programPath(program),
    ...profile.env,
  });
  const runFor = (
    profile: LookProfile,
    args: string[],
    limit: (typeof LIMITS)[keyof typeof LIMITS],
  ) =>
    run({ program, args: [...profile.args, ...args], env: env(profile), cwd: world.cwd, ...limit });

  if (cancelled()) return null;
  options.onStep?.(1);
  const first = world.profiles[0];
  if (!first) return { look: { ...empty, outcome: "not-found" }, found: null };
  const versionRun = await runFor(first, ["--version"], LIMITS.version);
  if (cancelled()) return null;
  if (couldNotRun(versionRun)) return { look: { ...empty, outcome: "cant-run" }, found: null };
  if (versionRun.timedOut) return { look: cantTell("timeout"), found: null };
  const programVersion = versionRun.exitCode === 0 ? parseVersionLine(versionRun.stdout) : null;
  if (!programVersion) return { look: cantTell("shape"), found: null };

  options.onStep?.(2);
  let considered: LookProfile[];
  try {
    const present = await withDeadline(
      Promise.all(world.profiles.map((profile) => profile.required || exists(profile.stateDir))),
      Date.now() + FILE_CHECK_MS,
    );
    considered = world.profiles.filter((_, index) => present[index]);
  } catch (error) {
    if (error instanceof FileCheckTimeout) return { look: cantTell("timeout"), found: null };
    throw error;
  }
  // The deep status scans the system's service folders: never in a sandbox.
  const deep = world.deep
    ? runFor(first, ["gateway", "status", "--json", "--deep"], LIMITS.deep)
    : Promise.resolve(null);
  const looks: ProfileLook[] = await Promise.all(
    considered.map(async (profile): Promise<ProfileLook> => {
      const [statusRun, authRun] = await Promise.all([
        runFor(profile, ["gateway", "status", "--json"], LIMITS.status),
        runFor(profile, ["config", "get", "gateway.auth.mode", "--json"], LIMITS.auth),
      ]);
      if (statusRun.timedOut || authRun.timedOut) return { kind: "fail", reason: "timeout" };
      const status = statusRun.exitCode === 0 ? parseStatus(statusRun.stdout) : null;
      if (!status) return { kind: "fail", reason: "shape" };
      return {
        kind: "status",
        status,
        auth: authRun.exitCode === 0 ? parseAuthMode(authRun.stdout) : null,
      };
    }),
  );
  const deepRun = await deep;
  if (cancelled()) return null;
  const services =
    deepRun && deepRun.exitCode === 0 ? (parseExtraServices(deepRun.stdout) ?? []) : [];
  let folders: string[];
  try {
    folders = await withDeadline(otherProfiles(world), Date.now() + FILE_CHECK_MS);
  } catch {
    folders = [];
  }
  const others = [...services.map((label) => `service ${label}`), ...folders].slice(
    0,
    MAX_LOOK_OTHERS,
  );

  const results = considered.map((profile, index) =>
    classify(profile, looks[index]!, programVersion, program),
  );
  // A gateway that answers comes first, then a stopped one, then what the default profile gave.
  const rank = (outcome: LookOutcome) =>
    ["running", "untested", "too-old", "not-token"].includes(outcome)
      ? 0
      : outcome === "stopped"
        ? 1
        : 2;
  const chosen = [...results].sort((a, b) => rank(a.look.outcome) - rank(b.look.outcome))[0];
  if (!chosen) return { look: { ...empty, outcome: "not-found" }, found: null };
  return { look: { ...chosen.look, others }, found: chosen.found };
}

const TESTED = parseBareVersion(TESTED_OPENCLAW_VERSION)!;
const OLDEST = parseBareVersion(OLDEST_VERSION)!;

function classify(
  profile: LookProfile,
  result: ProfileLook,
  programVersion: Version,
  program: string,
): LookReport {
  if (result.kind === "fail")
    return { look: cantTell(result.reason, programVersion.text), found: null };
  const { status, auth } = result;
  if (!status.configExists)
    return { look: cantTell("not-set-up", programVersion.text), found: null };
  const facts = {
    ...empty,
    profile: profile.name,
    listens: status.bind,
    service: serviceFact(status),
    port: status.port,
  };
  if (status.answered) {
    const version = status.answered;
    // The gateway that answered is the one Connect would go to, or it is not offered.
    if (!status.endpointConfirmed) return { look: cantTell("endpoint", version.text), found: null };
    const look = (outcome: LookOutcome, extra: Partial<SetupLook> = {}): SetupLook => ({
      ...facts,
      outcome,
      version: version.text,
      ...extra,
    });
    if (compareVersions(version, OLDEST) < 0) return { look: look("too-old"), found: null };
    if (auth === null) return { look: cantTell("shape", version.text), found: null };
    if (auth !== "token") return { look: look("not-token", { authMode: auth }), found: null };
    if (compareVersions(version, TESTED) !== 0) return { look: look("untested"), found: null };
    return {
      look: look("running", { access: "new" }),
      found: {
        program,
        profile,
        port: status.port,
        version: version.text,
        configPath: status.configPath,
        serviceKey: status.serviceKey,
      },
    };
  }
  // Nothing answered. Stopped only when nothing listens and no service claims to run.
  const service = status.service;
  const running = service !== null && service !== "none" && service.state !== "stopped";
  if (!status.listening && !running) {
    return { look: { ...facts, outcome: "stopped", version: programVersion.text }, found: null };
  }
  return { look: cantTell("no-answer", programVersion.text), found: null };
}
