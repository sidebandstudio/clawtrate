// The world the SSH transport acts in: the home folder, the person's SSH
// configuration and known-hosts file, the `ssh` program, the folder for the
// app's own files, and whether the person's key agent is used. Production
// resolves these from the real environment (`productionWorld`); every test
// passes a world it made in a temporary folder.
//
// The guard: under an automated run (a test runner or CI), a world whose paths
// resolve inside the real home's `.ssh` folder, or that would use the real key
// agent, is refused before anything is read or started.

import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { physicalPath, within } from "./paths.ts";
import { CONFIG_PATH } from "./route-config.ts";

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
  /**
   * The key agent `ssh` uses, chosen by the app: "none" (`IdentityAgent none`),
   * the socket of the agent the person runs, or, on Windows, the bundled
   * client's own agent pipe. A person's `IdentityAgent` setting overrides it.
   */
  agent: SshAgent;
  platform: NodeJS.Platform;
  /** The environment the app runs in; `ssh` gets only a few of its values (`childEnv`). */
  env: NodeJS.ProcessEnv;
};

export type SshAgent = "none" | { socket: string } | "windows-pipe";

/** An agent socket path the configuration can name: absolute and plain. */
export const isAgentSocket = (path: string) =>
  isAbsolute(path) && path.length <= 1024 && CONFIG_PATH.test(path) && !path.endsWith(" ");

/** The agent the app chooses for the person: the socket `SSH_AUTH_SOCK` names, or none. */
export function chooseAgent(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SshAgent {
  if (platform === "win32") return "windows-pipe";
  const socket = env.SSH_AUTH_SOCK;
  return socket && isAgentSocket(socket) ? { socket } : "none";
}

/** The world of the person running the app, with the app's own files under `appDir`. */
export function productionWorld(appDir: string, env: NodeJS.ProcessEnv = process.env): SshWorld {
  const home = homedir();
  const platform = process.platform;
  const ssh =
    platform === "win32"
      ? join(env.WINDIR ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe")
      : "/usr/bin/ssh";
  return {
    home,
    personConfig: join(home, ".ssh", "config"),
    personKnownHosts: join(home, ".ssh", "known_hosts"),
    ssh,
    appDir,
    localUser: userInfo().username,
    agent: chooseAgent(platform, env),
    platform,
    env,
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

/**
 * Throws `SshWorldRefused` when any of `paths` is not absolute or lands inside
 * `protectedDir`: first by its spelling, so such a path is never touched, then
 * as the file system walks it, links and a `..` after a link included.
 */
export function guardPaths(
  paths: readonly string[],
  protectedDir: string,
  platform: NodeJS.Platform,
): void {
  for (const path of paths) {
    if (!isAbsolute(path)) throw new SshWorldRefused("A path the SSH world uses is not absolute.");
    if (within(resolve(path), protectedDir, platform)) {
      throw new SshWorldRefused("An automated run must not use the real home's .ssh folder.");
    }
  }
  // Resolve the directory entry and its target. This reads no SSH file contents.
  const protectedPhysical = physicalPath(protectedDir);
  for (const path of paths) {
    if (within(physicalPath(path), protectedPhysical, platform)) {
      throw new SshWorldRefused("An automated run must not use the real home's .ssh folder.");
    }
  }
}

/**
 * Throws `SshWorldRefused` under an automated run when any path the world
 * names, or any of `extraPaths`, lands inside the real home's `.ssh` folder, or
 * when the world would use a key agent. Called before each path is opened.
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
  guardPaths(
    [world.home, world.personConfig, world.personKnownHosts, world.appDir, ...extraPaths],
    resolve(realHome(), ".ssh"),
    world.platform,
  );
}

/** What `ssh` is started with on Windows, from the app's environment: what the system needs, no more. */
const WINDOWS_ENV = [
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "ComSpec",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
];

/**
 * The environment `ssh` is started with: a fixed `PATH` on macOS and Linux,
 * and the system's own variables on Windows. Nothing else of the app's
 * environment reaches it, and no agent variable: the configuration names the
 * agent.
 */
export function childEnv(world: SshWorld): NodeJS.ProcessEnv {
  if (world.platform !== "win32") return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const env: NodeJS.ProcessEnv = {};
  for (const name of WINDOWS_ENV) {
    const value = world.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH = join(world.env.SystemRoot ?? world.env.WINDIR ?? "C:\\Windows", "System32");
  return env;
}
