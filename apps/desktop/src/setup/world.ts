// What the look on this computer may see (docs/design/setup.md §4): the
// home folder, the fixed places of the `openclaw` program, the profiles it
// considers, the environment its programs get and the ports it may use.
// Production resolves them from the real computer; every automated run and
// every development build supplies a sandbox instead, and the guard refuses
// a look whose world would reach the real one.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  INSTANCE_PROFILE_PREFIX,
  isNamedInstancePort,
  validateInstanceName,
} from "../../../../tools/dev-gateway/src/instance.ts";

/** OpenClaw's default gateway port. A guarded run never uses it. */
export const OPENCLAW_DEFAULT_PORT = 18789;

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
  /** Where the program may be, in order; the first regular executable file is used. */
  candidates: string[];
  profiles: LookProfile[];
  /** The whole environment of every program the look starts, before the profile's own. */
  env: Record<string, string>;
  /** Service files whose presence says OpenClaw is set up here. */
  serviceFiles: string[];
  /** A gateway port the host may run commands for and connect to. */
  portAllowed: (port: number) => boolean;
};

/** Where an automated run or a development build keeps the look (`docs/development/setup.md`). */
export type SetupSandbox = {
  /** A temporary home folder of the run's own. */
  home: string;
  /** The `openclaw` program to use; it need not exist. */
  openclaw: string;
  /** The development instance standing in for the default profile. */
  instance: string;
  /** That instance's state folder, as `pnpm dev-gateway` made it. */
  stateDir: string;
};

export class SetupRefusedError extends Error {
  constructor(why: string) {
    super(`The look on this computer refused to start: ${why}`);
    this.name = "SetupRefusedError";
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
    portAllowed: validPort,
  };
}

/**
 * The computer a run that must be sandboxed sees when it was given no
 * sandbox: no program, no profile, no home that exists. The look runs no
 * program in it and finds nothing, on any machine.
 */
export function emptyWorld(platform: NodeJS.Platform): LookWorld {
  return {
    kind: "sandbox",
    platform,
    home: join(tmpdir(), `clawtrate-no-sandbox-${randomBytes(8).toString("hex")}`),
    candidates: [],
    profiles: [],
    env: {},
    serviceFiles: [],
    portAllowed: () => false,
  };
}

/** A sandbox read from its file: every value checked before any path is built from it. */
export function readSandbox(path: string): SetupSandbox {
  if (!isAbsolute(path)) throw new SetupRefusedError("the sandbox file must be an absolute path");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SetupRefusedError("the sandbox file could not be read");
  }
  const value = raw as Record<string, unknown> | null;
  const text = (key: string) => {
    const field = value?.[key];
    if (typeof field !== "string" || !isAbsolute(field) || field.length > 1024)
      throw new SetupRefusedError(`the sandbox's ${key} must be an absolute path`);
    return field;
  };
  let instance: string;
  try {
    instance = validateInstanceName(value?.instance);
  } catch {
    throw new SetupRefusedError("the sandbox names no valid development instance");
  }
  return { home: text("home"), openclaw: text("openclaw"), instance, stateDir: text("stateDir") };
}

/** A sandbox's world: its own home, one program, one development instance and its ports. */
export function sandboxWorld(sandbox: SetupSandbox, platform: NodeJS.Platform): LookWorld {
  const profile = `${INSTANCE_PROFILE_PREFIX}${validateInstanceName(sandbox.instance)}`;
  return {
    kind: "sandbox",
    platform,
    home: sandbox.home,
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
    portAllowed: isNamedInstancePort,
  };
}

/**
 * Whether something automates this run: the checks mark theirs with
 * `CLAWTRATE_E2E_RUN` (Playwright's configs) or run under Vitest or CI; a
 * screenshot run sets `CLAWTRATE_SCREENSHOT`; a driven Electron app has a
 * debugging port or a sandbox switch.
 */
export function automatedRun(env: NodeJS.ProcessEnv, switches: (name: string) => boolean): boolean {
  return (
    ["CLAWTRATE_E2E_RUN", "CLAWTRATE_AUTOMATED", "CLAWTRATE_SCREENSHOT", "VITEST", "CI"].some(
      (key) => Boolean(env[key]),
    ) ||
    ["remote-debugging-port", "remote-debugging-pipe", "inspect", "clawtrate-setup-sandbox"].some(
      switches,
    )
  );
}

/** A path with every link in its existing part resolved, so `/var` and `/private/var` compare equal. */
function real(path: string): string {
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
function within(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/** The real home folder: from the account, not from an environment a test may have changed. */
export function realHome(): string {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
}

/**
 * Refuses, loudly, a look that must be sandboxed and whose world reaches
 * the real computer: the real home folder, the real default profile or its
 * state, or any profile but a development instance's.
 */
export function guardWorld(
  world: LookWorld,
  options: { sandboxed: boolean; realHome: string },
): void {
  if (!options.sandboxed) return;
  if (world.kind !== "sandbox") {
    throw new SetupRefusedError(
      "this run is automated or a development build, and it was given no sandbox",
    );
  }
  const home = real(options.realHome);
  const sandboxHome = real(world.home);
  if (within(home, sandboxHome)) throw new SetupRefusedError("its home is the real home folder");
  if (world.env.HOME !== undefined && within(home, real(world.env.HOME)))
    throw new SetupRefusedError("its programs would see the real home folder");
  const realDefault = join(home, ".openclaw");
  for (const profile of world.profiles) {
    if (profile.args.length === 0)
      throw new SetupRefusedError("it would look at the default profile");
    const [flag, name] = profile.args;
    if (
      profile.args.length !== 2 ||
      flag !== "--profile" ||
      !name?.startsWith(INSTANCE_PROFILE_PREFIX) ||
      name !== profile.name
    ) {
      throw new SetupRefusedError("it would look at a profile that is not a development instance");
    }
    for (const dir of [profile.stateDir, profile.env.OPENCLAW_STATE_DIR ?? profile.stateDir]) {
      if (within(real(dir), realDefault) || real(dir) === home)
        throw new SetupRefusedError("it would read the real default profile's state");
    }
  }
  for (const candidate of world.candidates) {
    if (within(real(candidate), realDefault))
      throw new SetupRefusedError("its program is inside the real default profile's state");
  }
}

/** Refuses a port a sandboxed run may not use: OpenClaw's default, or any outside the instances' range. */
export function guardPort(port: number, world: LookWorld, sandboxed: boolean): void {
  if (!world.portAllowed(port)) throw new SetupRefusedError(`port ${port} is not one it may use`);
  if (sandboxed && (port === OPENCLAW_DEFAULT_PORT || !isNamedInstancePort(port))) {
    throw new SetupRefusedError(`port ${port} is not a development instance's`);
  }
}

/** The PATH a program gets: its own folder, then the system's. */
export function programPath(program: string): string {
  return [dirname(program), ...SYSTEM_PATH].join(":");
}

/** Whether a path exists, for the signs of a set-up OpenClaw. Never reads it. */
export const exists = (path: string): boolean => existsSync(path);
