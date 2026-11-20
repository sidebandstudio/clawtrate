// Setting OpenClaw up on this computer (docs/design/setup.md §10, §19;
// docs/research/setup-flow.md §6.8), as the host runs it after its own
// dialog: two downloads checked against hashes built into this build before
// anything is extracted; the installer taken from the checked tarball, its
// own Node.js check passed against the checked Node.js before it runs, and an
// installer whose Node.js step doesn't report `skip` treated as a failure;
// onboarding as the `clawtrate` profile on a free loopback port with token
// sign-in and the profile's own service; then the gateway's status until it
// answers. Every program is one of the exact commands `commands` builds for
// this place, started without a shell for any value.
//
// What it owns is what docs/design/setup.md §10 lists: its program folder
// with a record, the profile's state folder with an owner file, and
// Clawtrate's own record, all carrying one id. It refuses to start when any
// of them, or the profile's service, is already there. The one thing it
// removes is an attempt of its own that never reached onboarding, whose only
// footprint is the program folder (§6.7), after proving that again.

import type {
  InstallFailure,
  InstallFailureKind,
  OnboardClassification,
  SetupInstall,
} from "@clawtrate/core";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { InstallPins, InstallTarget } from "./install-pins.ts";
import type { InstallRequest, InstallResult } from "./install-runner.ts";

export const INSTALL_PROFILE = "clawtrate";
/** OpenClaw's default port and the development gateway's: never chosen for an install. */
const RESERVED_PORTS = new Set([18789, 19001]);
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** The status wait after onboarding (§10). */
export const STATUS_WAIT_MS = 60_000;
const STATUS_EVERY_MS = 2_000;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_STALL_MS = 60_000;

/**
 * Sourced, the installer runs nothing (`OPENCLAW_INSTALL_CLI_SH_NO_RUN`); this
 * asks its own Node.js check about the checked runtime in the program folder.
 * A constant: the only values are the script's path, the folder and the
 * version, passed as arguments.
 */
export const NODE_CHECK =
  'OPENCLAW_INSTALL_CLI_SH_NO_RUN=1; . "$1"; PREFIX="$2"; NODE_VERSION="$3"; linked_node_is_usable';

/** Where an install goes on one computer, and with what it runs. */
export type InstallPlace = {
  /** The person's computer, or a stand-in in a temporary home for the host's tests. */
  kind: "computer" | "stand-in";
  platform: "darwin" | "linux";
  target: InstallTarget;
  home: string;
  /** `<app data>/openclaw`: created empty by the install. */
  programDir: string;
  /** Clawtrate's own record of the install. */
  recordFile: string;
  /** The profile's state: `~/.openclaw-clawtrate`. */
  stateDir: string;
  /** The profile's service file, which the install refuses to replace. */
  serviceFile: string;
  /** The profile's service, as the screen names it. */
  service: string;
  bash: string;
  tar: string;
  /** Every program's environment, before the step's own variables. */
  env: Record<string, string>;
};

function serviceOf(platform: "darwin" | "linux", home: string) {
  return platform === "darwin"
    ? {
        service: "ai.openclaw.clawtrate",
        serviceFile: join(home, "Library/LaunchAgents/ai.openclaw.clawtrate.plist"),
      }
    : {
        service: "openclaw-gateway-clawtrate.service",
        serviceFile: join(home, ".config/systemd/user/openclaw-gateway-clawtrate.service"),
      };
}

/** A user service on Linux is reached through the session's bus; nothing else of the session is passed. */
const SESSION_KEYS = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;

/** The real computer's place, for a person's app or a hosted runner. */
export function computerPlace(options: {
  home: string;
  appData: string;
  platform: "darwin" | "linux";
  target: InstallTarget;
  env: NodeJS.ProcessEnv;
  tar?: string;
}): InstallPlace {
  const { home, appData, platform } = options;
  const env: Record<string, string> = {
    HOME: home,
    LANG: options.env.LANG && /^[A-Za-z0-9._@-]+$/.test(options.env.LANG) ? options.env.LANG : "C",
    NO_COLOR: "1",
  };
  if (platform === "linux") {
    for (const key of SESSION_KEYS) {
      const value = options.env[key];
      if (value && /^[A-Za-z0-9._:/=,-]+$/.test(value)) env[key] = value;
    }
  }
  return {
    kind: "computer",
    platform,
    target: options.target,
    home,
    programDir: join(appData, "openclaw"),
    recordFile: join(appData, "openclaw-install.json"),
    stateDir: join(home, `.openclaw-${INSTALL_PROFILE}`),
    ...serviceOf(platform, home),
    bash: "/bin/bash",
    tar: options.tar ?? "/usr/bin/tar",
    env,
  };
}

/** A stand-in's place: the same shape under a temporary home, for the host's own tests. */
export function standInPlace(options: {
  home: string;
  appData: string;
  platform: "darwin" | "linux";
  target: InstallTarget;
  tar?: string;
}): InstallPlace {
  return {
    ...computerPlace({ ...options, env: {} }),
    kind: "stand-in",
    env: { HOME: options.home, LANG: "C", NO_COLOR: "1" },
  };
}

/** The hosted runner a real install may run on outside a person's app (§19). */
export function onHostedRunner(env: NodeJS.ProcessEnv): boolean {
  return (
    env.CI === "true" &&
    env.GITHUB_ACTIONS === "true" &&
    env.RUNNER_ENVIRONMENT === "github-hosted" &&
    !Object.hasOwn(env, "VITEST")
  );
}

export class InstallRefusedError extends Error {
  constructor(why: string) {
    super(`Setting OpenClaw up refused to start: ${why}.`);
    this.name = "InstallRefusedError";
  }
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
};

/**
 * A real install runs only in a person's packaged app that nothing automates,
 * or on a hosted runner. A stand-in runs only in a temporary home outside the
 * account's home, with downloads from this computer's loopback.
 */
async function assertMayInstall(
  place: InstallPlace,
  pins: InstallPins,
  allow: { personsApp: boolean; accountHome: string | null; env: NodeJS.ProcessEnv },
): Promise<void> {
  if (place.kind === "computer") {
    if (!allow.personsApp && !onHostedRunner(allow.env))
      throw new InstallRefusedError(
        "a real install runs only in a person's app or a hosted runner",
      );
    return;
  }
  const temp = await realpath(tmpdir());
  const home = await realpath(place.home).catch(() => null);
  const app = await realpath(dirname(place.programDir)).catch(() => null);
  const account = allow.accountHome ? await realpath(allow.accountHome).catch(() => null) : null;
  if (!home || !app || !inside(temp, home) || !inside(temp, app))
    throw new InstallRefusedError("a stand-in's folders must be under the system's temporary root");
  if (account && (home === account || inside(account, home) || inside(account, app)))
    throw new InstallRefusedError("a stand-in's folders must be outside the account's home");
  const urls = [pins.openclaw.url, ...Object.values(pins.node).map((node) => node.url)];
  if (urls.some((url) => !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)))
    throw new InstallRefusedError("a stand-in downloads from this computer's loopback only");
}

/** The paths of one install, all inside its program folder. */
export function layout(place: InstallPlace, pins: InstallPins) {
  const dir = place.programDir;
  return {
    record: join(dir, ".clawtrate-install.json"),
    downloads: join(dir, "downloads"),
    tarball: join(dir, "downloads", `openclaw-${pins.version}.tgz`),
    nodeTarball: join(dir, "downloads", `node-v${pins.nodeVersion}-${place.target}.tar.gz`),
    nodeDir: join(dir, "tools", `node-v${pins.nodeVersion}`),
    scripts: join(dir, "install"),
    installer: join(dir, "install", "install-cli.sh"),
    npmUser: join(dir, "npm", "user.npmrc"),
    npmGlobal: join(dir, "npm", "global.npmrc"),
    openclaw: join(dir, "bin", "openclaw"),
    owner: join(place.stateDir, ".clawtrate-owner.json"),
  };
}

const PROFILE_ARGS = ["--profile", INSTALL_PROFILE] as const;

export function onboardArgs(port: number): string[] {
  return [
    ...PROFILE_ARGS,
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--auth-choice",
    "skip",
    "--gateway-bind",
    "loopback",
    "--gateway-auth",
    "token",
    "--gateway-port",
    String(port),
    "--install-daemon",
    "--skip-skills",
    "--json",
  ];
}

/** Every command an install of this place runs, given its port: the only ones the runner starts. */
export function commands(
  place: InstallPlace,
  pins: InstallPins,
  port: number | null,
): Array<{ program: string; args: string[] }> {
  const at = layout(place, pins);
  const list = [
    {
      program: place.tar,
      args: ["-xzf", at.nodeTarball, "-C", at.nodeDir, "--strip-components=1"],
    },
    {
      program: place.tar,
      args: [
        "-xzf",
        at.tarball,
        "-C",
        at.scripts,
        "--strip-components=2",
        "package/scripts/install-cli.sh",
        "package/scripts/install-policy.sh",
      ],
    },
    {
      program: place.bash,
      args: [
        "-c",
        NODE_CHECK,
        "clawtrate-node-check",
        at.installer,
        place.programDir,
        pins.nodeVersion,
      ],
    },
    {
      program: place.bash,
      args: [
        at.installer,
        "--json",
        "--runtime-only",
        "--npm",
        "--version",
        at.tarball,
        "--prefix",
        place.programDir,
      ],
    },
    { program: at.openclaw, args: [...PROFILE_ARGS, "gateway", "status", "--json"] },
  ];
  if (port !== null) list.push({ program: at.openclaw, args: onboardArgs(port) });
  return list;
}

/** What a step's program found, parsed in memory; nothing of it is kept but these facts. */
export type InstallerEvents = {
  node: "skip" | "start" | "ok" | null;
  done: boolean;
  version: string | null;
};

/** One NDJSON line of `install-cli.sh --json` (research §6.1), folded into what was seen. */
export function readInstallerLine(seen: InstallerEvents, line: string): InstallerEvents {
  if (!line.startsWith("{") || line.length > 4096) return seen;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return seen;
  }
  if (!event || typeof event !== "object") return seen;
  const record = event as Record<string, unknown>;
  if (record.event === "step" && record.name === "node") {
    const status = record.status;
    if (status === "skip" || status === "start" || status === "ok")
      return { ...seen, node: status };
  }
  if (record.event === "done" && record.ok === true)
    return {
      ...seen,
      done: true,
      version: typeof record.version === "string" ? record.version : null,
    };
  return seen;
}

const CLASSIFICATIONS = new Set<OnboardClassification>([
  "auth-mismatch",
  "module-missing",
  "service-missing",
  "service-stopped",
  "startup-blocked",
  "not-listening",
]);

/** The last JSON object a program printed, or null. */
function lastJson(stdout: string): Record<string, unknown> | null {
  const whole = stdout.trim();
  const tries = [whole, ...whole.split("\n").reverse()];
  for (const text of tries) {
    if (!text.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      // the next candidate
    }
  }
  return null;
}

const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Onboarding's JSON (research §6.3): a gateway on exactly this port, on
 * loopback, with token sign-in and the service installed; otherwise its
 * failure class, when it names one this build knows.
 */
export function readOnboarding(
  stdout: string,
  port: number,
): { ok: true } | { ok: false; classification: OnboardClassification | null } {
  const json = lastJson(stdout);
  if (!json) return { ok: false, classification: null };
  const gateway = field(json, "gateway");
  if (
    json.ok === true &&
    field(field(json, "daemonInstall"), "installed") === true &&
    field(gateway, "port") === port &&
    field(gateway, "bind") === "loopback" &&
    field(gateway, "authMode") === "token"
  )
    return { ok: true };
  const named = json.classification;
  if (typeof named === "string" && CLASSIFICATIONS.has(named as OnboardClassification))
    return { ok: false, classification: named as OnboardClassification };
  if (field(field(json, "daemonInstall"), "skippedReason") === "systemd-user-unavailable")
    return { ok: false, classification: "systemd-user-unavailable" };
  return { ok: false, classification: null };
}

/** The status (research §6.4) of a gateway that answers on this port with this version. */
export function readAnswering(stdout: string, port: number, version: string): boolean {
  const json = lastJson(stdout);
  const gateway = field(json, "gateway");
  return (
    field(field(json, "rpc"), "ok") === true &&
    field(gateway, "version") === version &&
    field(gateway, "port") === port
  );
}

/** A port this computer's loopback has free now, never OpenClaw's default. */
export async function freeLoopbackPort(): Promise<number> {
  for (let tries = 0; tries < 8; tries += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
    if (port >= 1024 && port <= 65535 && !RESERVED_PORTS.has(port)) return port;
  }
  throw new Error("no free port");
}

/**
 * Downloads `url` into a new file, hashing as it goes, within a size limit
 * and a stall limit. Resolves the digest, or null when it didn't finish.
 */
export async function download(
  url: string,
  file: string,
  algorithm: "sha512" | "sha256",
  encoding: "base64" | "hex",
): Promise<string | null> {
  const abort = new AbortController();
  let stall: ReturnType<typeof setTimeout> | null = null;
  const touch = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => abort.abort(), DOWNLOAD_STALL_MS);
  };
  touch();
  try {
    const response = await fetch(url, { signal: abort.signal, redirect: "follow" });
    if (!response.ok || !response.body) return null;
    const hash = createHash(algorithm);
    let size = 0;
    const source = Readable.fromWeb(response.body as WebReadableStream);
    source.on("data", (chunk: Buffer) => {
      size += chunk.length;
      touch();
      if (size > MAX_DOWNLOAD_BYTES) source.destroy(new Error("too large"));
      else hash.update(chunk);
    });
    await pipeline(source, createWriteStream(file, { flags: "wx", mode: 0o600 }));
    return hash.digest(encoding);
  } catch {
    return null;
  } finally {
    if (stall) clearTimeout(stall);
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Clawtrate's own record of an install (§10): one id, its folders, its service and port, and how far it got. */
export type InstallRecord = {
  id: string;
  version: string;
  profile: string;
  programDir: string;
  stateDir: string;
  service: string;
  port: number | null;
  /** `installing` until onboarding starts; only an attempt still `installing` is ever removed. */
  stage: "installing" | "onboarding" | "installed";
};

/** What is there before an install: nothing, an attempt of Clawtrate's that never reached onboarding, or something else. */
export type InstallSite = "clear" | "leftover" | "exists";

export type InstallOptions = {
  place: InstallPlace;
  pins: InstallPins;
  run: (
    request: InstallRequest,
    check: (request: InstallRequest) => void,
  ) => Promise<InstallResult>;
  /** Whether this is a person's packaged app that nothing automates (`SETUP.kind === "production"`). */
  personsApp: boolean;
  accountHome: string | null;
  env?: NodeJS.ProcessEnv;
  download?: typeof download;
  freePort?: () => Promise<number>;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  statusWaitMs?: number;
  log?: (line: string) => void;
};

export type InstallOutcome = { ok: true; port: number } | { ok: false; failure: InstallFailure };

const failure = (
  kind: InstallFailureKind,
  step: number,
  extra: Partial<InstallFailure> = {},
): InstallFailure => ({ kind, step, exitCode: null, classification: null, retry: false, ...extra });

export class Installer {
  private readonly options: InstallOptions;
  private readonly at: ReturnType<typeof layout>;

  constructor(options: InstallOptions) {
    this.options = options;
    this.at = layout(options.place, options.pins);
  }

  private log(line: string): void {
    this.options.log?.(`[install] ${line}`);
  }

  /** Runs one of this install's own commands; anything else is refused before it starts. */
  private exec(request: InstallRequest, port: number | null): Promise<InstallResult> {
    const allowed = commands(this.options.place, this.options.pins, port);
    return this.options.run(request, (asked) => {
      const known = allowed.some(
        (command) =>
          command.program === asked.program &&
          command.args.length === asked.args.length &&
          command.args.every((arg, index) => arg === asked.args[index]),
      );
      if (!known) throw new Error("refusing a command the install doesn't run");
    });
  }

  private env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.options.place.env,
      PATH: [join(this.options.place.programDir, "bin"), ...SYSTEM_PATH].join(":"),
      ...extra,
    };
  }

  /** What is there now (§10, "Nothing there before"). */
  async site(): Promise<InstallSite> {
    const { place } = this.options;
    const [program, state, service] = await Promise.all([
      exists(place.programDir),
      exists(place.stateDir),
      exists(place.serviceFile),
    ]);
    if (!program && !state && !service) return "clear";
    if (program && !state && !service && (await this.leftover()) !== null) return "leftover";
    return "exists";
  }

  /**
   * The id of an attempt of Clawtrate's that never reached onboarding, proven
   * from both records and the folder itself, or null.
   */
  private async leftover(): Promise<string | null> {
    const { place } = this.options;
    const info = await lstat(place.programDir).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const own = await readJson(place.recordFile);
    const there = await readJson(this.at.record);
    if (
      !own ||
      !there ||
      own.stage !== "installing" ||
      typeof own.id !== "string" ||
      own.id !== there.id ||
      own.programDir !== place.programDir ||
      own.profile !== INSTALL_PROFILE ||
      there.profile !== INSTALL_PROFILE
    )
      return null;
    return own.id;
  }

  /**
   * Removes an attempt that never reached onboarding, after proving again
   * that it is that attempt: its program folder and Clawtrate's record.
   * Resolves whether nothing of it is left.
   */
  async discard(id: string | null = null): Promise<boolean> {
    const { place } = this.options;
    const found = await this.leftover();
    if (found === null || (id !== null && found !== id)) return false;
    if ((await exists(place.stateDir)) || (await exists(place.serviceFile))) return false;
    await rm(place.programDir, { recursive: true, force: true }).catch(() => {});
    if (await exists(place.programDir)) return false;
    await rm(place.recordFile, { force: true }).catch(() => {});
    this.log("removed an attempt that never reached onboarding");
    return !(await exists(place.recordFile));
  }

  private async writeRecord(record: InstallRecord): Promise<void> {
    await writeFile(this.options.place.recordFile, JSON.stringify(record), { mode: 0o600 });
  }

  /**
   * Runs every step, publishing where it stands. Resolves how it ended; a
   * failure before onboarding has already removed what the attempt made, and
   * says so with `retry`.
   */
  async run(progress: (install: SetupInstall) => void): Promise<InstallOutcome> {
    const { place, pins } = this.options;
    await assertMayInstall(place, pins, {
      personsApp: this.options.personsApp,
      accountHome: this.options.accountHome,
      env: this.options.env ?? process.env,
    });
    let install: SetupInstall = { step: 0, nodeChecked: false, failure: null };
    const publish = (next: Partial<SetupInstall>) => {
      install = { ...install, ...next };
      progress(install);
    };
    publish({});

    const site = await this.site();
    if (site === "exists") return { ok: false, failure: failure("exists", -1) };
    if (site === "leftover" && !(await this.discard()))
      return { ok: false, failure: failure("exists", -1) };

    const id = (this.options.newId ?? randomUUID)();
    const record: InstallRecord = {
      id,
      version: pins.version,
      profile: INSTALL_PROFILE,
      programDir: place.programDir,
      stateDir: place.stateDir,
      service: place.service,
      port: null,
      stage: "installing",
    };
    await mkdir(dirname(place.programDir), { recursive: true, mode: 0o700 });
    await this.writeRecord(record);
    try {
      // Created empty by this install: an existing folder fails here.
      await mkdir(place.programDir, { mode: 0o700 });
    } catch {
      return { ok: false, failure: failure("exists", -1) };
    }
    await writeFile(
      this.at.record,
      JSON.stringify({ id, version: pins.version, profile: INSTALL_PROFILE }),
      { mode: 0o600, flag: "wx" },
    );
    /** Before onboarding the attempt is the program folder alone, and is removed on failure. */
    const early = async (kind: InstallFailureKind, step: number, extra = {}) => ({
      ok: false as const,
      failure: failure(kind, step, { ...extra, retry: await this.discard(id) }),
    });

    // 1. Download and check.
    this.log("downloading");
    await mkdir(this.at.downloads, { mode: 0o700 });
    const get = this.options.download ?? download;
    const node = pins.node[place.target];
    const [tarball, runtime] = await Promise.all([
      get(pins.openclaw.url, this.at.tarball, "sha512", "base64"),
      get(node.url, this.at.nodeTarball, "sha256", "hex"),
    ]);
    if (tarball === null || runtime === null) return early("download", 0);
    if (`sha512-${tarball}` !== pins.openclaw.integrity || runtime !== node.sha256) {
      this.log("a download didn't match its fingerprint");
      return early("fingerprint", 0);
    }
    publish({ step: 1 });

    // 2. Install Node.js and OpenClaw.
    await mkdir(this.at.nodeDir, { recursive: true, mode: 0o700 });
    await mkdir(this.at.scripts, { mode: 0o700 });
    const quick = { cwd: place.programDir, timeoutMs: 120_000, maxBytes: 64 * 1024 };
    for (const command of commands(place, pins, null).slice(0, 2)) {
      const unpacked = await this.exec({ ...command, env: this.env(), ...quick }, null);
      if (unpacked.exitCode !== 0 || unpacked.timedOut)
        return early("installer", 1, { exitCode: unpacked.exitCode });
    }
    const [, , check, installer] = commands(place, pins, null);
    const usable = await this.exec({ ...check!, env: this.env(), ...quick }, null);
    if (usable.exitCode !== 0 || usable.timedOut) {
      this.log("the installer's Node.js check refused the checked Node.js");
      return early("node-not-checked", 1);
    }
    await mkdir(dirname(this.at.npmUser), { mode: 0o700 });
    await writeFile(this.at.npmUser, "", { mode: 0o600 });
    await writeFile(this.at.npmGlobal, "", { mode: 0o600 });
    let seen: InstallerEvents = { node: null, done: false, version: null };
    const installed = await this.exec(
      {
        ...installer!,
        env: this.env({
          NPM_CONFIG_USERCONFIG: this.at.npmUser,
          NPM_CONFIG_GLOBALCONFIG: this.at.npmGlobal,
          npm_config_registry: "https://registry.npmjs.org/",
        }),
        cwd: place.programDir,
        timeoutMs: 15 * 60_000,
        maxBytes: 8 * 1024 * 1024,
        onLine: (line) => {
          const before = seen.node;
          seen = readInstallerLine(seen, line);
          if (seen.node === "skip" && before !== "skip") publish({ nodeChecked: true });
          // It would delete the checked Node.js and download one itself (research §6.8).
          if (seen.node === "start" || seen.node === "ok") return "stop";
        },
      },
      null,
    );
    if (seen.node !== "skip") {
      this.log("the installer didn't use the checked Node.js");
      return early("node-not-checked", 1);
    }
    if (installed.exitCode !== 0 || installed.timedOut || !seen.done)
      return early("installer", 1, { exitCode: installed.exitCode });
    const program = await lstat(this.at.openclaw).catch(() => null);
    if (!program?.isFile()) return early("installer", 1, { exitCode: installed.exitCode });
    publish({ step: 2 });

    // 3. Set up the gateway. From here the attempt reaches outside its program folder.
    const port = await (this.options.freePort ?? freeLoopbackPort)();
    await this.writeRecord({ ...record, port, stage: "onboarding" });
    this.log("onboarding");
    const onboard = await this.exec(
      {
        program: this.at.openclaw,
        args: onboardArgs(port),
        env: this.env(),
        cwd: place.home,
        timeoutMs: 5 * 60_000,
        maxBytes: 1024 * 1024,
      },
      port,
    );
    const onboarded = readOnboarding(onboard.stdout, port);
    if (onboard.timedOut || !onboarded.ok || onboard.exitCode !== 0)
      return {
        ok: false,
        failure: failure("onboard", 2, {
          exitCode: onboard.exitCode,
          classification: onboarded.ok ? null : onboarded.classification,
        }),
      };
    const state = await lstat(place.stateDir).catch(() => null);
    if (!state?.isDirectory() || state.isSymbolicLink())
      return { ok: false, failure: failure("onboard", 2, { exitCode: onboard.exitCode }) };
    await writeFile(this.at.owner, JSON.stringify({ id }), { mode: 0o600, flag: "wx" });
    await this.writeRecord({ ...record, port, stage: "installed" });
    publish({ step: 3 });

    // 4. Start and check.
    const sleep = this.options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    const now = this.options.now ?? Date.now;
    const until = now() + (this.options.statusWaitMs ?? STATUS_WAIT_MS);
    for (;;) {
      const status = await this.exec(
        {
          program: this.at.openclaw,
          args: [...PROFILE_ARGS, "gateway", "status", "--json"],
          env: this.env(),
          cwd: place.home,
          timeoutMs: 15_000,
          maxBytes: 1024 * 1024,
        },
        port,
      );
      if (status.exitCode === 0 && readAnswering(status.stdout, port, pins.version)) break;
      if (now() >= until) return { ok: false, failure: failure("not-answering", 3) };
      await sleep(STATUS_EVERY_MS);
    }
    publish({ step: 4 });
    this.log("set up and answering");
    return { ok: true, port };
  }
}
