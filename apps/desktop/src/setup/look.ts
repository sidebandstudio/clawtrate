// The look on this computer (docs/design/setup.md §4, §6): find the
// program in its fixed places, ask its version, ask each profile's gateway,
// and say what was found. Every step is read-only and has its own time
// limit; every program runs through `RunProgram`, never a shell.

import { readdirSync, statSync } from "node:fs";
import {
  MAX_LOOK_OTHERS,
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
import type { RunProgram } from "./programs.ts";
import { exists, programPath, type LookProfile, type LookWorld } from "./world.ts";

/**
 * The oldest version Clawtrate connects to: the pinned protocol schema
 * describes nothing older than 2026.7 (`since: "<=2026.7"`), so an older
 * gateway's protocol is unknown to this client. Clawtrate's choice.
 */
export const OLDEST_VERSION = "2026.7.0";

export const LIMITS = {
  version: { timeoutMs: 10_000, maxBytes: 4 * 1024 },
  status: { timeoutMs: 20_000, maxBytes: 256 * 1024 },
  deep: { timeoutMs: 20_000, maxBytes: 512 * 1024 },
  auth: { timeoutMs: 10_000, maxBytes: 4 * 1024 },
} as const;

/** The steps the person sees: "Finding OpenClaw", "Checking its version", "Asking the gateway". */
export const LOOK_STEPS = 3;

/** A gateway the look found and Connect may pair with: the facts the host's dialog shows. */
export type FoundGateway = {
  program: string;
  profile: LookProfile;
  port: number;
  version: string;
  /** The config file `gateway status` named for this profile. */
  configPath: string;
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
  others: [],
};

const cantTell = (reason: CantTellReason, version: string | null = null): SetupLook => ({
  ...empty,
  outcome: "cant-tell",
  reason,
  version,
});

/** The first candidate that is a regular executable file. */
function findProgram(world: LookWorld): string | null {
  for (const candidate of world.candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // not there
    }
  }
  return null;
}

/** Other profiles' state folders in the home folder, by name only: never opened. */
function otherProfiles(world: LookWorld): string[] {
  let entries: string[];
  try {
    entries = readdirSync(world.home);
  } catch {
    return [];
  }
  const known = new Set(world.profiles.flatMap((profile) => [profile.name, "clawtrate"]));
  return entries
    .flatMap((entry) => {
      const match = /^\.openclaw-([a-z0-9][a-z0-9._-]{0,63})$/.exec(entry);
      return match && !known.has(match[1]!) ? [`profile ${match[1]}`] : [];
    })
    .sort();
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

export async function lookHere(
  world: LookWorld,
  run: RunProgram,
  options: LookOptions = {},
): Promise<LookReport | null> {
  const cancelled = options.cancelled ?? (() => false);
  options.onStep?.(0);
  if (world.platform === "win32") return { look: { ...empty, outcome: "windows" }, found: null };

  const program = findProgram(world);
  if (!program) {
    const setUp =
      exists(`${world.home}/.openclaw`) || world.serviceFiles.some((file) => exists(file));
    return {
      look: { ...empty, outcome: setUp ? "program-missing" : "not-found" },
      found: null,
    };
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
  ) => run({ program, args: [...profile.args, ...args], env: env(profile), ...limit });

  if (cancelled()) return null;
  options.onStep?.(1);
  const first = world.profiles[0]!;
  const versionRun = await runFor(first, ["--version"], LIMITS.version);
  if (cancelled()) return null;
  if (versionRun.timedOut) return { look: cantTell("timeout"), found: null };
  const programVersion = versionRun.exitCode === 0 ? parseVersionLine(versionRun.stdout) : null;
  if (!programVersion) return { look: cantTell("shape"), found: null };

  options.onStep?.(2);
  const considered = world.profiles.filter(
    (profile) => profile.required || exists(profile.stateDir),
  );
  const deep = runFor(first, ["gateway", "status", "--json", "--deep"], LIMITS.deep);
  const looks: ProfileLook[] = await Promise.all(
    considered.map(async (profile): Promise<ProfileLook> => {
      const [statusRun, authRun] = await Promise.all([
        runFor(profile, ["gateway", "status", "--json"], LIMITS.status),
        runFor(profile, ["config", "get", "gateway.auth.mode", "--json"], LIMITS.auth),
      ]);
      if (statusRun.timedOut || authRun.timedOut) return { kind: "fail", reason: "timeout" };
      const status = parseStatus(statusRun.stdout);
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
  const services = deepRun.exitCode === 0 ? (parseExtraServices(deepRun.stdout) ?? []) : [];
  const others = [...services.map((label) => `service ${label}`), ...otherProfiles(world)].slice(
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
  const chosen = [...results].sort((a, b) => rank(a.look.outcome) - rank(b.look.outcome))[0]!;
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
      look: look("running"),
      found: {
        program,
        profile,
        port: status.port,
        version: version.text,
        configPath: status.configPath,
      },
    };
  }
  // Nothing answered. Stopped only when nothing listens and no service claims to run.
  if (
    !status.listening &&
    status.service?.state !== "running" &&
    status.service?.state !== "other"
  ) {
    return { look: { ...facts, outcome: "stopped", version: programVersion.text }, found: null };
  }
  return { look: cantTell("no-answer", programVersion.text), found: null };
}
