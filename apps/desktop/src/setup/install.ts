// Setting OpenClaw up on this computer (docs/design/setup.md §10, §19;
// docs/research/setup-flow.md §6.8), as the host runs it after its own
// dialog. In order:
//
// - on Linux, the session's systemd user manager is asked first, and an
//   install it can't serve stops before anything is made;
// - the place is checked again: the program folder, Clawtrate's record, the
//   profile's state folder, its service file and the service manager's own
//   job or unit, with only "no such file" taken as absence;
// - the attempt is reserved by creating its program folder exclusively, and
//   its two records, which name one id, version, profile and stage, are
//   written before anything is downloaded;
// - both downloads go to a private staging folder, from the pinned URLs with
//   no redirect, and are moved into the program folder only once both
//   hashes match;
// - the installer is taken from the checked tarball, changed in one place so
//   that it can never fetch a Node.js of its own, and checked against the
//   checked Node.js before it runs; an installer whose Node.js step doesn't
//   report `skip` is a failure, and the installed program must be the
//   checked one;
// - just before onboarding the profile and its service are checked again and
//   the profile's state folder is reserved; onboarding writes the profile's
//   config only, and the profile's service is installed by a separate
//   command that never replaces one (OpenClaw's onboarding would also try to
//   change the account's systemd lingering through sudo, which this never
//   reaches);
// - then the gateway's status until it answers.
//
// Every program is one of the exact commands `commands` builds for this
// place, started without a shell for any value. The one thing it removes is
// an attempt of its own that never reached onboarding, after proving that
// again.

import type {
  InstallCleanup,
  InstallFailure,
  InstallFailureKind,
  OnboardClassification,
  SetupInstall,
} from "@clawtrate/core";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, realpathSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
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
/** The status wait after the service is installed (§10). */
export const STATUS_WAIT_MS = 60_000;
const STATUS_EVERY_MS = 2_000;
const STATUS_RUN_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_STALL_MS = 60_000;
/** `launchctl print` for a service its domain doesn't have. */
const LAUNCHD_NO_SUCH_SERVICE = 113;

/**
 * Sourced, the installer runs nothing (`OPENCLAW_INSTALL_CLI_SH_NO_RUN`); this
 * asks its own Node.js check about the checked runtime in the program folder.
 * A constant: the only values are the script's path, the folder and the
 * version, passed as arguments.
 */
export const NODE_CHECK =
  'OPENCLAW_INSTALL_CLI_SH_NO_RUN=1; . "$1"; PREFIX="$2"; NODE_VERSION="$3"; linked_node_is_usable';

/**
 * The checked installer's Node.js step (OpenClaw 2026.10.6, `install-cli.sh`
 * lines 909 to 913): with a usable runtime it links it and reports `skip`;
 * otherwise it goes on to download one. The install's copy ends there
 * instead (§10): the checked Node.js is the only runtime it may use.
 */
export const NODE_STEP = [
  "  if linked_node_is_usable; then",
  '    ln -sfn "$dir" "${PREFIX}/tools/node"',
  '    emit_json step name node status skip path "$dir"',
  "    return",
  "  fi",
  "",
].join("\n");
const NODE_STEP_END = [
  "  # Clawtrate: the checked Node.js is the only runtime this install uses; it never fetches one.",
  '  emit_json error message "the checked Node.js is not usable"',
  "  exit 70",
  "",
].join("\n");

/** The installer's text with its Node.js download unreachable, or null unless its Node.js step appears exactly once. */
export function patchInstaller(text: string): string | null {
  const at = text.indexOf(NODE_STEP);
  if (at === -1 || text.indexOf(NODE_STEP, at + 1) !== -1) return null;
  const end = at + NODE_STEP.length;
  return text.slice(0, end) + NODE_STEP_END + text.slice(end);
}

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
  /** `launchctl` on macOS, `systemctl` on Linux: asked about the profile's job or unit, and on Linux about the user manager. */
  serviceManager: string;
  uid: number;
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
export const SESSION_KEYS = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;

/** The session's bus, on Linux, from an environment: the only variables of the session any setup program gets. */
export function sessionEnv(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const kept: Record<string, string> = {};
  if (platform !== "linux") return kept;
  for (const key of SESSION_KEYS) {
    const value = env[key];
    if (value && /^[A-Za-z0-9._:/=,-]+$/.test(value)) kept[key] = value;
  }
  return kept;
}

/** The real computer's place, for a person's app or a hosted runner. */
export function computerPlace(options: {
  home: string;
  appData: string;
  platform: "darwin" | "linux";
  target: InstallTarget;
  env: NodeJS.ProcessEnv;
  uid?: number;
  tar?: string;
  serviceManager?: string;
}): InstallPlace {
  const { home, appData, platform } = options;
  const env: Record<string, string> = {
    HOME: home,
    LANG: options.env.LANG && /^[A-Za-z0-9._@-]+$/.test(options.env.LANG) ? options.env.LANG : "C",
    NO_COLOR: "1",
    ...sessionEnv(platform, options.env),
  };
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
    serviceManager:
      options.serviceManager ?? (platform === "darwin" ? "/bin/launchctl" : "/usr/bin/systemctl"),
    uid: options.uid ?? process.getuid?.() ?? -1,
    env,
  };
}

/** A stand-in's place: the same shape under a temporary home, for the host's own tests. */
export function standInPlace(options: {
  home: string;
  appData: string;
  platform: "darwin" | "linux";
  target: InstallTarget;
  serviceManager: string;
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

/** The paths of one install, all inside its program folder but the owner file. */
export function layout(place: InstallPlace, pins: InstallPins) {
  const dir = place.programDir;
  const nodeDir = join(dir, "tools", `node-v${pins.nodeVersion}`);
  const tarballName = `openclaw-${pins.version}.tgz`;
  const nodeName = `node-v${pins.nodeVersion}-${place.target}.tar.gz`;
  return {
    /** The program folder's own record of the attempt. */
    record: join(dir, ".clawtrate-install.json"),
    /** Where the downloads arrive, unchecked; nothing in it is ever extracted or run. */
    staging: join(dir, ".staging"),
    stagedTarball: join(dir, ".staging", tarballName),
    stagedNode: join(dir, ".staging", nodeName),
    downloads: join(dir, "downloads"),
    tarball: join(dir, "downloads", tarballName),
    nodeTarball: join(dir, "downloads", nodeName),
    nodeDir,
    nodeBin: join(nodeDir, "bin", "node"),
    scripts: join(dir, "install"),
    installer: join(dir, "install", "install-cli.sh"),
    /** The checked tarball's `dist/entry.js` and `dist/index.js`, to compare the installed ones with. */
    checkedEntry: join(dir, "install", "entry.js"),
    checkedIndex: join(dir, "install", "index.js"),
    installedEntry: join(nodeDir, "lib", "node_modules", "openclaw", "dist", "entry.js"),
    /** What OpenClaw's service starts: the installed package's gateway entrypoint. */
    installedIndex: join(nodeDir, "lib", "node_modules", "openclaw", "dist", "index.js"),
    npmUser: join(dir, "npm", "user.npmrc"),
    npmGlobal: join(dir, "npm", "global.npmrc"),
    npmCache: join(dir, "npm", "cache"),
    openclaw: join(dir, "bin", "openclaw"),
    owner: join(place.stateDir, ".clawtrate-owner.json"),
  };
}

/** The wrapper the checked installer writes for its prefix (`install-cli.sh`, `publish_executable_wrapper`). */
export function expectedWrapper(place: InstallPlace, pins: InstallPins): string {
  const at = layout(place, pins);
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `exec "${place.programDir}/tools/node/bin/node" "${at.installedEntry}" "$@"`,
    "",
  ].join("\n");
}

const PROFILE_ARGS = ["--profile", INSTALL_PROFILE] as const;

/**
 * Onboarding writes the profile's config only: no service (`--no-install-daemon`,
 * which is also what keeps OpenClaw's lingering helper from running) and no
 * health check, since nothing runs yet.
 */
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
    "--no-install-daemon",
    "--skip-health",
    "--skip-skills",
    "--json",
  ];
}

/** The profile's service, installed on its own, never replacing one (no `--force`). */
export function serviceInstallArgs(port: number): string[] {
  return [...PROFILE_ARGS, "gateway", "install", "--port", String(port), "--json"];
}

/** The service manager's command that says whether the profile's job or unit is there. */
function supervisorArgs(place: InstallPlace): string[] {
  return place.platform === "darwin"
    ? ["print", `gui/${place.uid}/${place.service}`]
    : ["--user", "show", place.service, "--property=LoadState", "--value"];
}

/** Linux: the user manager's own version, which only a reachable manager answers. */
const USER_MANAGER_ARGS = ["--user", "show", "--property=Version", "--value"];

/** Every command an install of this place runs, given its port: the only ones the runner starts. */
export function commands(
  place: InstallPlace,
  pins: InstallPins,
  port: number | null,
): Array<{ program: string; args: string[] }> {
  const at = layout(place, pins);
  const list = [
    { program: place.serviceManager, args: supervisorArgs(place) },
    ...(place.platform === "linux"
      ? [{ program: place.serviceManager, args: USER_MANAGER_ARGS }]
      : []),
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
        "package/dist/entry.js",
        "package/dist/index.js",
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
  if (port !== null) {
    list.push({ program: at.openclaw, args: onboardArgs(port) });
    list.push({ program: at.openclaw, args: serviceInstallArgs(port) });
  }
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

/**
 * The last JSON object a program printed, or null: one object on its own
 * line, or one printed over several lines from a line that starts with `{`
 * to the end of the output, after any lines of text.
 */
function lastJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  const starts = [0];
  for (let at = text.indexOf("\n{"); at !== -1; at = text.indexOf("\n{", at + 1))
    starts.push(at + 1);
  for (const start of starts.reverse()) {
    const rest = text.slice(start);
    const end = rest.indexOf("\n");
    // From this line to the end, then this line alone.
    for (const candidate of end === -1 ? [rest] : [rest, rest.slice(0, end)]) {
      if (!candidate.startsWith("{")) continue;
      try {
        const value = JSON.parse(candidate) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {
        // the next candidate
      }
    }
  }
  return null;
}

const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Onboarding's JSON (research §6.3): the profile's config for a gateway on
 * exactly this port, on loopback, with token sign-in and no service of
 * onboarding's own; otherwise its failure class, when it names one this
 * build knows.
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
    json.installDaemon === false &&
    field(gateway, "port") === port &&
    field(gateway, "bind") === "loopback" &&
    field(gateway, "authMode") === "token"
  )
    return { ok: true };
  const named = json.classification;
  if (typeof named === "string" && CLASSIFICATIONS.has(named as OnboardClassification))
    return { ok: false, classification: named as OnboardClassification };
  return { ok: false, classification: null };
}

/** `gateway install --json` (OpenClaw's daemon CLI): a service newly installed and loaded, never one that was there. */
export function readServiceInstall(stdout: string): boolean {
  const json = lastJson(stdout);
  return (
    json !== null &&
    json.ok === true &&
    json.action === "install" &&
    json.result === "installed" &&
    field(json.service, "loaded") === true
  );
}

/** A value of a program's JSON, for the host's log: one of `words`, or only whether it is there. */
function named(value: unknown, words: readonly string[]): string {
  if (value === undefined) return "absent";
  return typeof value === "string" && words.includes(value) ? value : "other";
}
const flag = (value: unknown) =>
  value === true ? "true" : value === false ? "false" : value === undefined ? "absent" : "other";

/**
 * The facts of onboarding's JSON that the install reads, for the host's log
 * when it isn't accepted: named words, booleans and whether a value is the
 * one expected; never a message, a path, a key or a number of the program's.
 */
export function onboardingFacts(stdout: string, port: number): string {
  const json = lastJson(stdout);
  if (!json) return "json=absent";
  const gateway = field(json, "gateway");
  return [
    `ok=${flag(json.ok)}`,
    `port=${field(gateway, "port") === port ? "expected" : field(gateway, "port") === undefined ? "absent" : "other"}`,
    `bind=${named(field(gateway, "bind"), ["loopback", "lan", "auto", "custom", "tailnet"])}`,
    `auth=${named(field(gateway, "authMode"), ["token", "password", "none", "trusted-proxy"])}`,
    `daemon=${flag(json.installDaemon)}`,
    `class=${named(json.classification, [...CLASSIFICATIONS])}`,
  ].join(" ");
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

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * The command a service file starts, as its manager reads it: a LaunchAgent's
 * `ProgramArguments`, or a systemd unit's `ExecStart` with OpenClaw's quoting
 * (`systemd-unit.ts`). Null when the file has no single command of that shape.
 */
export function serviceArgv(platform: "darwin" | "linux", text: string): string[] | null {
  if (platform === "darwin") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
    if (!array) return null;
    const args: string[] = [];
    for (const match of array[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g))
      args.push(
        match[1]!.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!),
      );
    return args.length ? args : null;
  }
  const lines = text.split("\n").filter((line) => line.startsWith("ExecStart="));
  if (lines.length !== 1) return null;
  const value = lines[0]!.slice("ExecStart=".length);
  const args: string[] = [];
  let at = 0;
  while (at < value.length) {
    if (value[at] === " " || value[at] === "\t") {
      at += 1;
      continue;
    }
    let arg = "";
    if (value[at] === '"') {
      at += 1;
      for (;;) {
        if (at >= value.length) return null;
        const char = value[at]!;
        if (char === "\\" && at + 1 < value.length) {
          arg += value[at + 1]!;
          at += 2;
        } else if (char === '"') {
          at += 1;
          break;
        } else {
          arg += char;
          at += 1;
        }
      }
    } else {
      while (at < value.length && value[at] !== " " && value[at] !== "\t") {
        arg += value[at]!;
        at += 1;
      }
    }
    args.push(arg.replaceAll("%%", "%"));
  }
  return args.length ? args : null;
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Whether a service command runs this install: the checked Node.js, the
 * installed package's `dist/index.js` (OpenClaw's gateway entrypoint) or
 * `dist/entry.js`, both proven the checked tarball's, then `gateway --port <port>`.
 */
export function runsCheckedInstall(
  argv: string[],
  place: InstallPlace,
  pins: InstallPins,
  port: number,
): boolean {
  const at = layout(place, pins);
  // Compared through links: OpenClaw may write either path resolved.
  const entries = [at.installedIndex, at.installedEntry]
    .map(real)
    .filter((path): path is string => path !== null);
  const entry = argv.findIndex((arg) => {
    const path = real(arg);
    return path !== null && entries.includes(path);
  });
  if (entry < 1) return false;
  const rest = argv.slice(entry + 1);
  if (
    rest.length !== 3 ||
    rest[0] !== "gateway" ||
    rest[1] !== "--port" ||
    rest[2] !== String(port)
  )
    return false;
  const node = real(at.nodeBin);
  return node !== null && argv.slice(0, entry).some((arg) => real(arg) === node);
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

/** How a download ended: its digest, or why it has none. */
export type Downloaded =
  { ok: true; digest: string } | { ok: false; why: "network" | "short" | "space" | "write" };

const SPACE_CODES = new Set(["ENOSPC", "EDQUOT"]);

/**
 * Downloads `url` into a new private file, hashing as it goes: exactly the
 * pinned URL (a redirect is an error), status 200 only, within a size limit
 * and a stall limit, and exactly the length the response declared.
 */
export async function download(
  url: string,
  file: string,
  algorithm: "sha512" | "sha256",
  encoding: "base64" | "hex",
  signal?: AbortSignal,
): Promise<Downloaded> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal?.addEventListener("abort", stop);
  let stall: ReturnType<typeof setTimeout> | null = null;
  const touch = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(stop, DOWNLOAD_STALL_MS);
  };
  touch();
  let response: Response;
  try {
    response = await fetch(url, { signal: abort.signal, redirect: "error" });
  } catch {
    if (stall) clearTimeout(stall);
    signal?.removeEventListener("abort", stop);
    return { ok: false, why: "network" };
  }
  try {
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, why: "network" };
    }
    // The declared length counts the body as sent: checked only when nothing decoded it. A body
    // that ends before it errors in the stream, and is named short here.
    const declared = response.headers.get("content-encoding")
      ? null
      : response.headers.get("content-length");
    const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
    const hash = createHash(algorithm);
    let size = 0;
    let tooLarge = false;
    const source = Readable.fromWeb(response.body as WebReadableStream);
    source.on("data", (chunk: Buffer) => {
      size += chunk.length;
      touch();
      if (size > MAX_DOWNLOAD_BYTES) {
        tooLarge = true;
        source.destroy(new Error("too large"));
      } else hash.update(chunk);
    });
    try {
      await pipeline(source, createWriteStream(file, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      // The file system's own errors name their call; the network's don't.
      const failed = error as NodeJS.ErrnoException;
      if (failed.syscall) {
        return { ok: false, why: failed.code && SPACE_CODES.has(failed.code) ? "space" : "write" };
      }
      if (tooLarge || abort.signal.aborted) return { ok: false, why: "network" };
      return { ok: false, why: length !== null && size < length ? "short" : "network" };
    }
    return { ok: true, digest: hash.digest(encoding) };
  } finally {
    if (stall) clearTimeout(stall);
    signal?.removeEventListener("abort", stop);
  }
}

/** What a path is: absent (only ENOENT), there, or unreadable. */
type Presence = "absent" | "there" | "unreadable";

const presence = (path: string): Promise<Presence> =>
  lstat(path).then(
    () => "there",
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "absent" : "unreadable"),
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

type Stage = "installing" | "onboarding" | "installed";

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
  stage: Stage;
};

/** The program folder's record: the same id, version, profile and stage as Clawtrate's. */
type FolderRecord = { id: string; version: string; profile: string; stage: Stage };

/**
 * What is there before an install: nothing; an attempt of Clawtrate's that
 * never reached onboarding; something of the profile's or the program
 * folder's; something that couldn't be read; or, on Linux, no user manager.
 */
export type InstallSite = "clear" | "leftover" | "exists" | "unreadable";

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
  /** Aborted when the app quits: no download goes on. */
  signal?: AbortSignal;
  /** The install's own writes of its records and configuration; the file system's by default. */
  writeFile?: typeof writeFile;
  log?: (line: string) => void;
};

export type InstallOutcome =
  | {
      ok: true;
      port: number;
      /** The installed program, for the look that follows, which runs it for this profile only. */
      program: string;
      /** The session's bus on Linux, for that look's programs. */
      env: Record<string, string>;
    }
  | { ok: false; failure: InstallFailure };

const failure = (
  kind: InstallFailureKind,
  step: number,
  extra: Partial<InstallFailure> = {},
): InstallFailure => ({
  kind,
  step,
  exitCode: null,
  classification: null,
  retry: false,
  cleanup: "none",
  ...extra,
});

const ok = (result: InstallResult) =>
  result.exitCode === 0 && !result.timedOut && !result.tooLarge && !result.failed;

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

  private get write(): typeof writeFile {
    return this.options.writeFile ?? writeFile;
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

  private quick(): Pick<InstallRequest, "cwd" | "timeoutMs" | "maxBytes"> {
    return { cwd: this.options.place.home, timeoutMs: 20_000, maxBytes: 64 * 1024 };
  }

  /** Linux: whether this session's systemd user manager answers. */
  private async userManager(): Promise<boolean> {
    const { place } = this.options;
    if (place.platform !== "linux") return true;
    const result = await this.exec(
      { program: place.serviceManager, args: USER_MANAGER_ARGS, env: this.env(), ...this.quick() },
      null,
    );
    return ok(result) && result.stdout.trim() !== "";
  }

  /** Whether the service manager has the profile's job or unit, wherever its definition is. */
  private async supervisor(): Promise<Presence> {
    const { place } = this.options;
    const result = await this.exec(
      {
        program: place.serviceManager,
        args: supervisorArgs(place),
        env: this.env(),
        ...this.quick(),
      },
      null,
    );
    if (result.failed || result.timedOut || result.tooLarge) return "unreadable";
    if (place.platform === "darwin") {
      if (result.exitCode === 0) return "there";
      if (result.exitCode === LAUNCHD_NO_SUCH_SERVICE) return "absent";
      this.log(`launchctl print exited ${result.exitCode}`);
      return "unreadable";
    }
    if (result.exitCode !== 0) return "unreadable";
    return result.stdout.trim() === "not-found" ? "absent" : "there";
  }

  /**
   * What is there now (§10, "Nothing there before"): the program folder,
   * Clawtrate's record, the profile's state folder and service file, and the
   * service manager's job or unit. Only "no such file" is absence.
   */
  async site(): Promise<InstallSite> {
    const { place } = this.options;
    const [program, record, state, service] = await Promise.all(
      [place.programDir, place.recordFile, place.stateDir, place.serviceFile].map(presence),
    );
    const all = [program, record, state, service];
    if (all.includes("unreadable")) return "unreadable";
    const loaded = await this.supervisor();
    if (loaded === "unreadable") return "unreadable";
    if (state === "there" || service === "there" || loaded === "there") return "exists";
    if (program === "absent" && record === "absent") return "clear";
    return (await this.leftover()) !== null ? "leftover" : "exists";
  }

  /**
   * The id of an attempt of Clawtrate's that never reached onboarding,
   * proven from both records and the folder itself, or null: the same id,
   * version, profile and stage `installing` in both, for this folder.
   */
  private async leftover(): Promise<string | null> {
    const { place, pins } = this.options;
    const info = await lstat(place.programDir).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const own = await readJson(place.recordFile);
    const there = await readJson(this.at.record);
    if (
      !own ||
      !there ||
      typeof own.id !== "string" ||
      own.id !== there.id ||
      own.stage !== "installing" ||
      there.stage !== "installing" ||
      own.version !== pins.version ||
      there.version !== pins.version ||
      own.profile !== INSTALL_PROFILE ||
      there.profile !== INSTALL_PROFILE ||
      own.programDir !== place.programDir ||
      own.stateDir !== place.stateDir
    )
      return null;
    return own.id;
  }

  /**
   * For the look: the program of a proven early leftover, which the look
   * doesn't take for an OpenClaw, or null. Only files are read.
   */
  async leftoverProgram(): Promise<string | null> {
    const { place } = this.options;
    const [state, service] = await Promise.all([
      presence(place.stateDir),
      presence(place.serviceFile),
    ]);
    if (state !== "absent" || service !== "absent") return null;
    return (await this.leftover()) !== null ? this.at.openclaw : null;
  }

  /**
   * Removes an attempt that never reached onboarding, after proving again
   * that it is that attempt (`id`, or any proven one): its program folder and
   * Clawtrate's record. Resolves whether nothing of it is left.
   */
  async discard(id: string | null = null): Promise<boolean> {
    const { place } = this.options;
    const found = await this.leftover();
    if (found === null || (id !== null && found !== id)) return false;
    // An earlier run's attempt is removed only where nothing of the profile is: a profile or
    // service there may be what it began. This run's own attempt, before onboarding, never
    // reached them, and is removed whoever else has made them since.
    if (id === null) {
      const [state, service] = await Promise.all([
        presence(place.stateDir),
        presence(place.serviceFile),
      ]);
      if (state !== "absent" || service !== "absent") return false;
      if ((await this.supervisor()) !== "absent") return false;
    }
    await rm(place.programDir, { recursive: true, force: true }).catch(() => {});
    if ((await presence(place.programDir)) !== "absent") return false;
    await rm(place.recordFile, { force: true }).catch(() => {});
    this.log("removed an attempt that never reached onboarding");
    return (await presence(place.recordFile)) === "absent";
  }

  /**
   * Whether the gateway on `port` is the one Clawtrate set up (§10): the
   * three records name one id, the install is complete on that port, and its
   * service runs the checked install.
   */
  async owned(port: number): Promise<boolean> {
    const { place, pins } = this.options;
    const [own, there, owner] = await Promise.all([
      readJson(place.recordFile),
      readJson(this.at.record),
      readJson(this.at.owner),
    ]);
    if (
      !own ||
      !there ||
      !owner ||
      typeof own.id !== "string" ||
      own.id !== there.id ||
      own.id !== owner.id ||
      own.stage !== "installed" ||
      there.stage !== "installed" ||
      own.port !== port ||
      own.profile !== INSTALL_PROFILE ||
      own.programDir !== place.programDir
    )
      return false;
    const text = await readFile(place.serviceFile, "utf8").catch(() => null);
    const argv = text === null ? null : serviceArgv(place.platform, text);
    return argv !== null && runsCheckedInstall(argv, place, pins, port);
  }

  private record(id: string, stage: Stage, port: number | null): InstallRecord {
    const { place, pins } = this.options;
    return {
      id,
      version: pins.version,
      profile: INSTALL_PROFILE,
      programDir: place.programDir,
      stateDir: place.stateDir,
      service: place.service,
      port,
      stage,
    };
  }

  /** Both records, at one stage: each written whole to a new file, then moved over the last. */
  private async writeStage(id: string, stage: Stage, port: number | null): Promise<void> {
    const { place, pins } = this.options;
    const folder: FolderRecord = { id, version: pins.version, profile: INSTALL_PROFILE, stage };
    const write = async (file: string, value: object) => {
      const next = `${file}.${id}.next`;
      await this.write(next, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(next, file);
    };
    await write(this.at.record, folder);
    await write(place.recordFile, this.record(id, stage, port));
  }

  /**
   * Reserves the attempt: its program folder created exclusively, its
   * folder record, then Clawtrate's record, made exclusively too. Resolves
   * null once reserved, or why it couldn't be, having removed what it made.
   */
  private async reserve(id: string): Promise<InstallFailure | null> {
    const { place, pins } = this.options;
    try {
      await mkdir(dirname(place.programDir), { recursive: true, mode: 0o700 });
      await mkdir(place.programDir, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return failure(code === "EEXIST" ? "exists" : "write", -1);
    }
    const folder: FolderRecord = {
      id,
      version: pins.version,
      profile: INSTALL_PROFILE,
      stage: "installing",
    };
    try {
      await this.write(this.at.record, JSON.stringify(folder), { mode: 0o600, flag: "wx" });
    } catch {
      // Only the folder this attempt created, and its own record if it began one.
      await unlink(this.at.record).catch(() => {});
      const removed = await rmdir(place.programDir).then(
        () => true,
        () => false,
      );
      return failure(
        "write",
        -1,
        removed ? { cleanup: "removed", retry: true } : { cleanup: "unproven" },
      );
    }
    const next = `${place.recordFile}.${id}.next`;
    try {
      await this.write(next, JSON.stringify(this.record(id, "installing", null)), {
        mode: 0o600,
        flag: "wx",
      });
      // A record that appeared since the check is never replaced.
      await link(next, place.recordFile);
      await unlink(next);
      return null;
    } catch (error) {
      await unlink(next).catch(() => {});
      const there = (error as NodeJS.ErrnoException).code === "EEXIST";
      // The program folder is this attempt's: it made it, and its record names this id.
      const mine = (await readJson(this.at.record))?.id === id;
      if (mine) await rm(place.programDir, { recursive: true, force: true }).catch(() => {});
      const gone = mine && (await presence(place.programDir)) === "absent";
      return failure(
        there ? "exists" : "write",
        -1,
        gone ? { cleanup: "removed", retry: !there } : { cleanup: "unproven" },
      );
    }
  }

  /**
   * Runs every step, publishing where it stands. Resolves how it ended; a
   * failure before onboarding has already removed what the attempt made, and
   * says so with `cleanup`.
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
    const stopped = (
      kind: InstallFailureKind,
      step: number,
      extra: Partial<InstallFailure> = {},
    ) => ({
      ok: false as const,
      failure: failure(kind, step, extra),
    });

    // Before anything is made: the user manager, then the place again.
    if (!(await this.userManager())) return stopped("user-service", -1);
    const site = await this.site();
    if (site === "unreadable") return stopped("write", -1);
    if (site === "exists") return stopped("exists", -1);
    if (site === "leftover" && !(await this.discard())) return stopped("exists", -1);

    const id = (this.options.newId ?? randomUUID)();
    const refused = await this.reserve(id);
    if (refused) return { ok: false, failure: refused };

    /** Before onboarding the attempt is the program folder and Clawtrate's record alone, removed on failure. */
    const early = async (
      kind: InstallFailureKind,
      step: number,
      extra: Partial<InstallFailure> = {},
    ) => {
      const removed = await this.discard(id);
      const cleanup: InstallCleanup = removed ? "removed" : "unproven";
      return stopped(kind, step, {
        ...extra,
        cleanup,
        retry: removed && kind !== "changed",
      });
    };
    try {
      const before = await this.beforeOnboarding(publish);
      if (before.ok === false) return early(before.kind, before.step, before.extra);
    } catch {
      return early("write", install.step);
    }

    // 3. Set up the gateway. From here the attempt reaches outside its program folder.
    let port: number;
    try {
      port = await (this.options.freePort ?? freeLoopbackPort)();
      await this.writeStage(id, "onboarding", port);
    } catch {
      return early("write", 2);
    }
    const kept = (kind: InstallFailureKind, extra: Partial<InstallFailure> = {}, step = 2) =>
      stopped(kind, step, { cleanup: "kept", ...extra });
    // The profile and its service once more, then the state folder reserved.
    const [state, service] = await Promise.all([
      presence(place.stateDir),
      presence(place.serviceFile),
    ]);
    const loaded = await this.supervisor();
    if (state !== "absent" || service !== "absent" || loaded !== "absent") {
      this.log("the profile or its service appeared before onboarding");
      try {
        await this.writeStage(id, "installing", null);
      } catch {
        return kept("changed");
      }
      return early("changed", 2);
    }
    try {
      await mkdir(place.stateDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return kept("write");
      try {
        await this.writeStage(id, "installing", null);
      } catch {
        return kept("changed");
      }
      return early("changed", 2);
    }
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
    if (onboard.timedOut || !onboarded.ok || onboard.exitCode !== 0) {
      this.log(
        `onboarding not accepted: exit=${onboard.exitCode} timedOut=${onboard.timedOut} tooLarge=${onboard.tooLarge} ${onboardingFacts(onboard.stdout, port)}`,
      );
      return kept("onboard", {
        exitCode: onboard.exitCode,
        classification: onboarded.ok ? null : onboarded.classification,
      });
    }
    try {
      await this.write(this.at.owner, JSON.stringify({ id }), { mode: 0o600, flag: "wx" });
    } catch {
      return kept("write");
    }
    // The service is installed only where none is, by a command that never replaces one.
    const [serviceNow, loadedNow] = [await presence(place.serviceFile), await this.supervisor()];
    if (serviceNow !== "absent" || loadedNow !== "absent") {
      this.log("a service of the profile appeared before it was installed");
      return kept("changed");
    }
    const installed = await this.exec(
      {
        program: this.at.openclaw,
        args: serviceInstallArgs(port),
        env: this.env(),
        cwd: place.home,
        timeoutMs: 3 * 60_000,
        maxBytes: 1024 * 1024,
      },
      port,
    );
    if (!ok(installed) || !readServiceInstall(installed.stdout)) {
      this.log(
        `the service wasn't installed: exit=${installed.exitCode} timedOut=${installed.timedOut}`,
      );
      return kept("service", { exitCode: installed.exitCode });
    }
    try {
      await this.writeStage(id, "installed", port);
    } catch {
      return kept("write");
    }
    publish({ step: 3 });

    // 4. Start and check.
    const sleep = this.options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    const now = this.options.now ?? Date.now;
    const until = now() + (this.options.statusWaitMs ?? STATUS_WAIT_MS);
    for (;;) {
      const left = until - now();
      const status = await this.exec(
        {
          program: this.at.openclaw,
          args: [...PROFILE_ARGS, "gateway", "status", "--json"],
          env: this.env(),
          cwd: place.home,
          timeoutMs: Math.max(1_000, Math.min(STATUS_RUN_MS, left)),
          maxBytes: 1024 * 1024,
        },
        port,
      );
      if (ok(status) && readAnswering(status.stdout, port, pins.version)) break;
      if (now() >= until) return kept("not-answering", {}, 3);
      await sleep(Math.min(STATUS_EVERY_MS, Math.max(0, until - now())));
    }
    publish({ step: 4 });
    this.log("set up and answering");
    return {
      ok: true,
      port,
      program: this.at.openclaw,
      env: sessionEnv(place.platform, place.env),
    };
  }

  /**
   * Steps 1 and 2, inside the program folder: the downloads, checked, then
   * the installer, with the checked Node.js only, and the installed program
   * checked. Throws for a write of its own that failed.
   */
  private async beforeOnboarding(
    publish: (next: Partial<SetupInstall>) => void,
  ): Promise<
    | { ok: true }
    | { ok: false; kind: InstallFailureKind; step: number; extra?: Partial<InstallFailure> }
  > {
    const { place, pins } = this.options;
    const no = (kind: InstallFailureKind, step: number, extra: Partial<InstallFailure> = {}) => ({
      ok: false as const,
      kind,
      step,
      extra,
    });

    // 1. Download into staging, and check both before anything leaves it.
    this.log("downloading");
    await mkdir(this.at.staging, { mode: 0o700 });
    const get = this.options.download ?? download;
    const node = pins.node[place.target];
    const [tarball, runtime] = await Promise.all([
      get(pins.openclaw.url, this.at.stagedTarball, "sha512", "base64", this.options.signal),
      get(node.url, this.at.stagedNode, "sha256", "hex", this.options.signal),
    ]);
    for (const result of [tarball, runtime]) {
      if (result.ok) continue;
      if (result.why === "space") return no("download-space", 0);
      if (result.why === "short") return no("download-short", 0);
      if (result.why === "write") return no("write", 0);
    }
    if (!tarball.ok || !runtime.ok) return no("download", 0);
    if (`sha512-${tarball.digest}` !== pins.openclaw.integrity || runtime.digest !== node.sha256) {
      this.log("a download didn't match its fingerprint");
      return no("fingerprint", 0);
    }
    // Checked: only now in the program folder.
    await mkdir(this.at.downloads, { mode: 0o700 });
    await rename(this.at.stagedTarball, this.at.tarball);
    await rename(this.at.stagedNode, this.at.nodeTarball);
    await rmdir(this.at.staging);
    publish({ step: 1 });

    // 2. Install Node.js and OpenClaw.
    await mkdir(this.at.nodeDir, { recursive: true, mode: 0o700 });
    await mkdir(this.at.scripts, { mode: 0o700 });
    const unpack = { cwd: place.programDir, timeoutMs: 120_000, maxBytes: 64 * 1024 };
    const list = commands(place, pins, null);
    const tar = list.filter((command) => command.program === place.tar);
    const [check, installer] = list.filter((command) => command.program === place.bash);
    for (const command of tar) {
      const unpacked = await this.exec({ ...command, env: this.env(), ...unpack }, null);
      if (!ok(unpacked)) return no("unpack", 1, { exitCode: unpacked.exitCode });
    }
    // The checked installer, changed so that it can't fetch a Node.js of its own.
    const original = await readFile(this.at.installer, "utf8").catch(() => null);
    const patched = original === null ? null : patchInstaller(original);
    if (patched === null) {
      this.log("the checked installer's Node.js step isn't the one this build changes");
      return no("installer-changed", 1);
    }
    await writeFile(this.at.installer, patched, { mode: 0o700 });
    const usable = await this.exec({ ...check!, env: this.env(), ...unpack }, null);
    if (!ok(usable)) {
      this.log("the installer's Node.js check refused the checked Node.js");
      return no("node-not-checked", 1);
    }
    await mkdir(dirname(this.at.npmUser), { mode: 0o700 });
    await this.write(this.at.npmUser, "", { mode: 0o600, flag: "wx" });
    await this.write(this.at.npmGlobal, "", { mode: 0o600, flag: "wx" });
    let seen: InstallerEvents = { node: null, done: false, version: null };
    const ran = await this.exec(
      {
        ...installer!,
        env: this.env({
          NPM_CONFIG_USERCONFIG: this.at.npmUser,
          NPM_CONFIG_GLOBALCONFIG: this.at.npmGlobal,
          NPM_CONFIG_CACHE: this.at.npmCache,
          npm_config_registry: "https://registry.npmjs.org/",
        }),
        cwd: place.programDir,
        timeoutMs: 15 * 60_000,
        maxBytes: 8 * 1024 * 1024,
        onLine: (line) => {
          const before = seen.node;
          seen = readInstallerLine(seen, line);
          if (seen.node === "skip" && before !== "skip") publish({ nodeChecked: true });
          // The change above ends it first; this is the second guard (research §6.8).
          if (seen.node === "start" || seen.node === "ok") return "stop";
        },
      },
      null,
    );
    if (seen.node !== "skip") {
      this.log("the installer didn't use the checked Node.js");
      return no("node-not-checked", 1);
    }
    if (!ok(ran) || !seen.done) return no("installer", 1, { exitCode: ran.exitCode });
    if (!(await this.checkedProgram(seen.version))) {
      this.log("the installed program isn't the checked one");
      return no("no-program", 1, { exitCode: ran.exitCode });
    }
    publish({ step: 2 });
    return { ok: true };
  }

  /**
   * The installed program is the checked one: the installer's reported
   * version is the pinned one, its wrapper is exactly the one it writes for
   * this prefix, and the installed `entry.js` and `index.js` are the checked tarball's.
   */
  private async checkedProgram(version: string | null): Promise<boolean> {
    const { place, pins } = this.options;
    if (!version?.split(/\s+/).includes(pins.version)) return false;
    const wrapper = await lstat(this.at.openclaw).catch(() => null);
    if (!wrapper?.isFile()) return false;
    const text = await readFile(this.at.openclaw, "utf8").catch(() => null);
    if (text !== expectedWrapper(place, pins)) return false;
    const sha = async (file: string) =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    try {
      return (
        (await sha(this.at.installedEntry)) === (await sha(this.at.checkedEntry)) &&
        (await sha(this.at.installedIndex)) === (await sha(this.at.checkedIndex))
      );
    } catch {
      return false;
    }
  }
}
