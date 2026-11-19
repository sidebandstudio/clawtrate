// The world the SSH transport acts in: the home folder, the person's SSH
// configuration and known-hosts file, the `ssh` program, the folder for the
// app's own files, and whether the person's key agent is used. Production
// resolves these from the real environment (`productionWorld`); every test
// passes a world it made in a temporary folder.
//
// The guard: under an automated run (a test runner or CI), a world whose paths
// resolve inside the real home's `.ssh` folder, or that would use the real key
// agent, is refused before anything is read or started.

import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type SshWorld = {
  /** The person's home folder: where `~` in their SSH configuration points. */
  home: string;
  /** The person's SSH configuration file, read as text only. */
  personConfig: string;
  /** The person's known-hosts file, used only to find a key they already trust. */
  personKnownHosts: string;
  /** The `ssh` program, started with an argument array and never through a shell. */
  ssh: string;
  /** The folder for the app's own SSH files: route configurations, its known-hosts file, captures. */
  appDir: string;
  /** The local account name, used when neither the destination nor the configuration names a user. */
  localUser: string;
  /** "inherit": the person's running key agent signs in. "none": no agent, `IdentityAgent none`. */
  agent: "inherit" | "none";
  platform: NodeJS.Platform;
  /** The environment `ssh` is started with; `SSH_AUTH_SOCK` is removed when `agent` is "none". */
  env: NodeJS.ProcessEnv;
};

/** The world of the person running the app, with the app's own files under `appDir`. */
export function productionWorld(appDir: string): SshWorld {
  const home = homedir();
  const platform = process.platform;
  const ssh =
    platform === "win32"
      ? join(process.env.WINDIR ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe")
      : "/usr/bin/ssh";
  return {
    home,
    personConfig: join(home, ".ssh", "config"),
    personKnownHosts: join(home, ".ssh", "known_hosts"),
    ssh,
    appDir,
    localUser: userInfo().username,
    agent: "inherit",
    platform,
    env: process.env,
  };
}

export class SshWorldRefused extends Error {
  override name = "SshWorldRefused";
}

/** Whether this process is a test run or CI, where the real `.ssh` and agent are off limits. */
export function isAutomatedRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST || env.CI || env.NODE_ENV === "test" || env.PLAYWRIGHT_TEST_BASE_URL);
}

/** The real home, from the account database, not from `HOME`. */
function realHome(): string {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
}

const fold = (path: string, platform: NodeJS.Platform) =>
  platform === "darwin" || platform === "win32" ? path.toLowerCase() : path;

function inside(path: string, dir: string, platform: NodeJS.Platform): boolean {
  const p = fold(path, platform);
  const d = fold(dir, platform);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/**
 * The path as the file system resolves it: the nearest existing ancestor's real
 * path joined with the rest. Called only for paths already outside `.ssh` by
 * name, so it never looks inside the real `.ssh` folder.
 */
function resolvedThroughLinks(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

/**
 * Throws `SshWorldRefused` under an automated run when any path resolves inside
 * the real `.ssh` folder, or when the world would use the real key agent. The
 * check by name comes first, so a refused path is never touched.
 */
export function guardWorld(
  world: SshWorld,
  extraPaths: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isAutomatedRun(env)) return;
  if (world.agent !== "none") {
    throw new SshWorldRefused(
      'An automated run must not use the real SSH agent: give the world agent "none".',
    );
  }
  const real = resolve(realHome(), ".ssh");
  // The home resolved through links, then `.ssh` by name: nothing inside it is looked at.
  const realLinked = join(resolvedThroughLinks(realHome()), ".ssh");
  const paths = [
    world.home,
    world.personConfig,
    world.personKnownHosts,
    world.appDir,
    ...extraPaths,
  ];
  for (const path of paths) {
    if (!isAbsolute(path)) throw new SshWorldRefused(`A path the SSH world uses is not absolute.`);
    if (inside(resolve(path), real, world.platform)) {
      throw new SshWorldRefused("An automated run must not use the real home's .ssh folder.");
    }
  }
  for (const path of paths) {
    if (inside(resolvedThroughLinks(path), realLinked, world.platform)) {
      throw new SshWorldRefused("An automated run must not use the real home's .ssh folder.");
    }
  }
}

/** The environment `ssh` is started with: the world's, without the agent when it is "none". */
export function childEnv(world: SshWorld): NodeJS.ProcessEnv {
  const env = { ...world.env };
  if (world.agent === "none") {
    delete env.SSH_AUTH_SOCK;
    delete env.SSH_AGENT_PID;
  }
  return env;
}
