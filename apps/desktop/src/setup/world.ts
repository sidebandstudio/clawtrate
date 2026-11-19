// What the look on this computer may see (docs/design/setup.md §4): the
// home folder, the fixed places of the `openclaw` program, the profiles it
// considers, the environment and working folder its programs get and the
// ports it may use. Production resolves them from the real computer; every
// run that must be sandboxed (`mustSandbox`) supplies a sandbox instead, and
// the guard refuses a sandbox that could reach the real one.
//
// OpenClaw's own `gateway status` inspects the user's whole launchd job list
// and chooses its probe itself, whatever home and state folder it is given
// (docs/decisions.md, "Setting up on this computer"). So a sandbox's program
// is never the real OpenClaw: it is the repository's stand-in
// (`e2e/openclaw-stand-in.ts`), which answers status from the instance's
// recorded facts and runs the real program only for the version, the auth
// mode and the one-time code.

import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  INSTANCE_PROFILE_PREFIX,
  isNamedInstancePort,
  validateInstanceName,
} from "../../../../tools/dev-gateway/src/instance.ts";
import { readMarker } from "../../../../tools/dev-gateway/src/state-guard.ts";

/** OpenClaw's default gateway port. A sandboxed run never uses it. */
export const OPENCLAW_DEFAULT_PORT = 18789;

/** The first lines of the repository's stand-in carry this; a sandbox runs nothing else. */
export const STAND_IN_MARK = "clawtrate-openclaw-stand-in";

/** Development instances a sandbox may never name: other work's own. */
const FORBIDDEN_INSTANCES = new Set(["preview-accounts"]);

/** The system's own program folders, the start of every program's PATH. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export type LookProfile = {
  /** What the person sees: `default`, `clawtrate`, or a development instance's profile. */
  name: string;
  /** The root options that select it: none for the default profile (rule 11). */
  args: string[];
  /** Its state folder. A profile that isn't `required` is looked at only when this exists. */
  stateDir: string;
  required: boolean;
  /** Set for every program run for this profile, beside the world's environment. */
  env: Record<string, string>;
};

export type LookWorld = {
  kind: "production" | "sandbox";
  platform: NodeJS.Platform;
  home: string;
  /** The working folder of every program the look starts: never the app's own. */
  cwd: string;
  /** Where the program may be, in order; the first regular executable file is used. */
  candidates: string[];
  profiles: LookProfile[];
  /** The whole environment of every program the look starts, before the profile's own. */
  env: Record<string, string>;
  /** Service files whose presence says OpenClaw is set up here. */
  serviceFiles: string[];
  /** Whether the look may run `gateway status --deep`, which scans the system's service folders. */
  deep: boolean;
  /** A gateway port the host may run commands for and connect to. */
  portAllowed: (port: number) => boolean;
};

/** Where a run that must be sandboxed keeps the look (`docs/development/setup.md`). */
export type SetupSandbox = {
  /** A temporary home folder of the run's own, outside the real home. */
  home: string;
  /** The repository's stand-in for `openclaw`; it need not exist. */
  openclaw: string;
  /** The development instance standing in for the default profile. */
  instance: string;
  /** That instance's state folder, as `pnpm dev-gateway` made it. */
  stateDir: string;
};

/** Why a sandbox was refused, for the card's words. */
export type RefusalReason = "file" | "home" | "profile" | "state" | "program" | "port";

export class SetupRefusedError extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, why: string) {
    super(`The look on this computer refused to start: ${why}`);
    this.name = "SetupRefusedError";
    this.reason = reason;
  }
}

function serviceFilesUnder(home: string, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return ["ai.openclaw.gateway", "ai.openclaw.clawtrate"].map((label) =>
      join(home, "Library/LaunchAgents", `${label}.plist`),
    );
  }
  if (platform === "linux") {
    return ["openclaw-gateway", "openclaw-gateway-clawtrate"].map((unit) =>
      join(home, ".config/systemd/user", `${unit}.service`),
    );
  }
  return [];
}

const validPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535;

/** The real computer's world, for a packaged app that nothing automates. */
export function productionWorld(options: {
  home: string;
  appData: string;
  platform: NodeJS.Platform;
  lang?: string | undefined;
}): LookWorld {
  const { home, platform } = options;
  return {
    kind: "production",
    platform,
    home,
    cwd: home,
    candidates: [
      join(options.appData, "openclaw/bin/openclaw"),
      join(home, ".openclaw/bin/openclaw"),
      "/opt/homebrew/bin/openclaw",
      "/usr/local/bin/openclaw",
      join(home, ".local/bin/openclaw"),
      join(home, ".npm-global/bin/openclaw"),
    ],
    profiles: [
      { name: "default", args: [], stateDir: join(home, ".openclaw"), required: true, env: {} },
      {
        name: "clawtrate",
        args: ["--profile", "clawtrate"],
        stateDir: join(home, ".openclaw-clawtrate"),
        required: false,
        env: {},
      },
    ],
    env: { HOME: home, LANG: options.lang ?? "en_US.UTF-8", NO_COLOR: "1" },
    serviceFiles: serviceFilesUnder(home, platform),
    deep: true,
    portAllowed: validPort,
  };
}

/**
 * The computer a run that must be sandboxed sees when it was given no
 * sandbox: no program, no profile, a home that doesn't exist. The look runs
 * no program in it and finds nothing.
 */
export function emptyWorld(platform: NodeJS.Platform): LookWorld {
  const home = join(tmpdir(), `clawtrate-no-sandbox-${randomBytes(8).toString("hex")}`);
  return {
    kind: "sandbox",
    platform,
    home,
    cwd: tmpdir(),
    candidates: [],
    profiles: [],
    env: {},
    serviceFiles: [],
    deep: false,
    portAllowed: () => false,
  };
}

/** A path with every link in its existing part resolved, so `/var` and `/private/var` compare equal. */
export function real(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Whether `inner` is `outer` or inside it. */
export function within(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/** The folders a sandbox file may be read from: the system's temporary folder. */
export function sandboxFolders(): string[] {
  return [...new Set([resolve(tmpdir()), real(tmpdir())])];
}

/**
 * A sandbox read from its file. The file must be a regular file under the
 * system's temporary folder, and nothing in it is used before every value
 * has been checked (`guardWorld` checks the rest).
 */
export function readSandbox(path: string, folders: string[] = sandboxFolders()): SetupSandbox {
  if (!isAbsolute(path))
    throw new SetupRefusedError("file", "the sandbox file must be an absolute path");
  const where = real(path);
  const allowed = folders.flatMap((folder) => [resolve(folder), real(folder)]);
  if (!allowed.some((folder) => within(where, folder) && where !== folder)) {
    throw new SetupRefusedError(
      "file",
      "the sandbox file must be in the system's temporary folder",
    );
  }
  let raw: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) throw new Error("not a small regular file");
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SetupRefusedError("file", "the sandbox file could not be read");
  }
  const value = raw as Record<string, unknown> | null;
  const text = (key: string) => {
    const field = value?.[key];
    if (typeof field !== "string" || !isAbsolute(field) || field.length > 1024)
      throw new SetupRefusedError("file", `the sandbox's ${key} must be an absolute path`);
    return field;
  };
  let instance: string;
  try {
    instance = validateInstanceName(value?.instance);
  } catch {
    throw new SetupRefusedError("file", "the sandbox names no valid development instance");
  }
  if (FORBIDDEN_INSTANCES.has(instance)) {
    throw new SetupRefusedError(
      "profile",
      `the sandbox names the instance ${instance}, which isn't this run's`,
    );
  }
  return { home: text("home"), openclaw: text("openclaw"), instance, stateDir: text("stateDir") };
}

/**
 * A sandbox's world: its own home and working folder, the stand-in, one
 * development instance, and that instance's own recorded gateway port only.
 * The deep status never runs in it.
 */
export function sandboxWorld(sandbox: SetupSandbox, platform: NodeJS.Platform): LookWorld {
  const instance = validateInstanceName(sandbox.instance);
  const profile = `${INSTANCE_PROFILE_PREFIX}${instance}`;
  const recorded = readMarker(sandbox.stateDir);
  const port =
    recorded && recorded.instance === instance && isNamedInstancePort(recorded.gatewayPort)
      ? recorded.gatewayPort
      : null;
  return {
    kind: "sandbox",
    platform,
    home: sandbox.home,
    cwd: sandbox.home,
    candidates: [sandbox.openclaw],
    profiles: [
      {
        name: profile,
        args: ["--profile", profile],
        stateDir: sandbox.stateDir,
        required: true,
        // As `pnpm dev-gateway` runs this instance's commands (tools/dev-gateway/src/env.ts).
        env: {
          OPENCLAW_PROFILE: profile,
          OPENCLAW_STATE_DIR: sandbox.stateDir,
          OPENCLAW_CONFIG_PATH: join(sandbox.stateDir, "openclaw.json"),
        },
      },
    ],
    env: { HOME: sandbox.home, LANG: "en_US.UTF-8", NO_COLOR: "1" },
    serviceFiles: serviceFilesUnder(sandbox.home, platform),
    deep: false,
    portAllowed: (candidate) => port !== null && candidate === port,
  };
}

/** The variables that mark a run that must be sandboxed: present at all, an empty value too. */
export const SANDBOX_MARKERS = [
  "CLAWTRATE_E2E_RUN",
  "CLAWTRATE_AUTOMATED",
  "CLAWTRATE_SCREENSHOT",
  "CLAWTRATE_SETUP_SANDBOX",
  "VITEST",
  "CI",
] as const;

/** The switches that mark a driven app. */
export const SANDBOX_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "inspect",
  "inspect-brk",
  "clawtrate-setup-sandbox",
] as const;

/**
 * Whether this run must be sandboxed: a development build, any marker
 * variable present at all, any of the switches, or a sandbox file named by
 * the environment. A packaged app started with none of these is a person's
 * and looks at the real computer.
 */
export function mustSandbox(options: {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  switches: (name: string) => boolean;
}): boolean {
  return (
    !options.packaged ||
    SANDBOX_MARKERS.some((key) => Object.hasOwn(options.env, key)) ||
    SANDBOX_SWITCHES.some((name) => options.switches(name))
  );
}

/** The real home folder: from the account, not from an environment a test may have changed. */
export function realHome(): string {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
}

/** Whether a file starts with the stand-in's mark, read without following a link. */
export function isStandIn(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return false;
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(512);
      const read = readSync(fd, head, 0, head.length, 0);
      return head
        .subarray(0, read)
        .toString("utf8")
        .split("\n")
        .slice(0, 4)
        .some((line) => line.includes(STAND_IN_MARK));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses, loudly, a sandbox that could reach the real computer: a home
 * that is the real home, above it or inside it; a working folder or
 * programs' HOME there too; the real default profile, its state, or a
 * folder reached through a link into it, compared with links resolved on
 * both sides; a config file that is a link; a profile but this run's
 * development instance; and a program that isn't the repository's stand-in
 * or lies in the real default state. A production world is not checked here:
 * the caller decides whether it may be used at all.
 */
export function guardWorld(world: LookWorld, options: { realHome: string }): void {
  if (world.kind !== "sandbox") return;
  const home = real(options.realHome);
  const outside = (path: string) => {
    const resolved = real(path);
    return !within(resolved, home) && !within(home, resolved);
  };
  if (!outside(world.home))
    throw new SetupRefusedError("home", "its home is not outside the real home folder");
  if (world.env.HOME !== undefined && !outside(world.env.HOME))
    throw new SetupRefusedError("home", "its programs' HOME is not outside the real home folder");
  if (!outside(world.cwd))
    throw new SetupRefusedError(
      "home",
      "its programs' working folder is not outside the real home folder",
    );
  if (world.deep) throw new SetupRefusedError("program", "a sandbox never runs the deep status");
  // The real default state, as written and with its links resolved.
  const defaults = [
    ...new Set([
      join(home, ".openclaw"),
      real(join(options.realHome, ".openclaw")),
      join(options.realHome, ".openclaw"),
    ]),
  ];
  const inDefault = (path: string) => {
    const resolved = real(path);
    return defaults.some((folder) => within(resolved, folder) || within(resolve(path), folder));
  };
  for (const profile of world.profiles) {
    if (profile.args.length === 0)
      throw new SetupRefusedError("profile", "it would look at the default profile");
    const [flag, name] = profile.args;
    const instance = name?.slice(INSTANCE_PROFILE_PREFIX.length);
    if (
      profile.args.length !== 2 ||
      flag !== "--profile" ||
      !name?.startsWith(INSTANCE_PROFILE_PREFIX) ||
      name !== profile.name ||
      instance === undefined ||
      FORBIDDEN_INSTANCES.has(instance)
    ) {
      throw new SetupRefusedError(
        "profile",
        "it would look at a profile that is not this run's development instance",
      );
    }
    for (const dir of [profile.stateDir, profile.env.OPENCLAW_STATE_DIR ?? profile.stateDir]) {
      if (inDefault(dir) || real(dir) === home)
        throw new SetupRefusedError("state", "it would read the real default profile's state");
    }
    const config = join(profile.stateDir, "openclaw.json");
    if (
      profile.env.OPENCLAW_CONFIG_PATH !== undefined &&
      profile.env.OPENCLAW_CONFIG_PATH !== config
    )
      throw new SetupRefusedError("state", "its config is not its state folder's own");
    try {
      if (lstatSync(config).isSymbolicLink())
        throw new SetupRefusedError("state", "its config file is a link");
    } catch (error) {
      if (error instanceof SetupRefusedError) throw error;
    }
  }
  for (const candidate of world.candidates) {
    if (inDefault(candidate))
      throw new SetupRefusedError(
        "program",
        "its program is inside the real default profile's state",
      );
    if (exists(candidate) && !isStandIn(candidate))
      throw new SetupRefusedError(
        "program",
        "its program is not the repository's stand-in for OpenClaw",
      );
  }
}

/** Refuses a port a sandboxed run may not use: anything but its instance's own, and never OpenClaw's default. */
export function guardPort(port: number, world: LookWorld, sandboxed: boolean): void {
  if (!world.portAllowed(port))
    throw new SetupRefusedError("port", `port ${port} is not one it may use`);
  if (sandboxed && (port === OPENCLAW_DEFAULT_PORT || !isNamedInstancePort(port))) {
    throw new SetupRefusedError("port", `port ${port} is not a development instance's`);
  }
}

/** The PATH a program gets: its own folder, then the system's. */
export function programPath(program: string): string {
  return [dirname(program), ...SYSTEM_PATH].join(":");
}

/** Whether a path is a folder, read without following a link. */
export function isFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path exists and is a regular file or folder, following links. */
export function present(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
