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
//   its two records, which name one id, version and profile, are made before
//   anything is downloaded; only Clawtrate's records the stage;
// - both downloads go to the attempt's own staging folder beside the program
//   folder, from the pinned URLs with no redirect, and are moved into the
//   program folder only once both hashes match;
// - the installer is taken from the checked tarball, its Node.js step and
//   temporary folder replaced whole, so that it can never fetch a Node.js of
//   its own, reach a package manager or use the shared `/tmp`, and checked
//   against the checked Node.js before it runs; an installer whose Node.js
//   step doesn't report `skip` is a failure, and the installed program must
//   be the checked one;
// - just before onboarding the profile and its service are checked again,
//   the profile's state folder is reserved, and only then is the stage
//   `onboarding` written; onboarding writes the profile's config only, and
//   the profile's service is installed by a separate command (OpenClaw's
//   onboarding would also try to change the account's systemd lingering
//   through sudo, which this never reaches), checked again just before it
//   and read back after it;
// - then the gateway's status until it answers.
//
// Every program is one of the exact commands `commands` builds for this
// place, started without a shell for any value. The one thing it removes is
// an attempt whose files it can prove it made, with no service left to use them.

import type {
  InstallAction,
  InstallCleanup,
  InstallFailure,
  InstallFailureKind,
  InstallLocation,
  InstallRecovery,
  OnboardClassification,
  SetupInstall,
} from "@clawtrate/core";
import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream, realpathSync, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
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
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { InstallPins, InstallTarget } from "./install-pins.ts";
import { safeValue, type InstallRequest, type InstallResult } from "./install-runner.ts";

/**
 * On Linux, a user service is reached through the session's bus: only these two, each of the
 * one shape a session gives it.
 */
const SESSION_ENV: Record<string, RegExp> = {
  XDG_RUNTIME_DIR: /^\/[A-Za-z0-9._/-]+$/,
  DBUS_SESSION_BUS_ADDRESS: /^unix:path=\/[A-Za-z0-9._/-]+(,guid=[0-9a-f]{32})?$/,
};

/**
 * The session's bus, on Linux, from the main process's own environment: the only variables of
 * the session the install's programs get, each in its one shape, and nothing on any other
 * system. Read once, at the trusted source.
 */
export function sessionEnv(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const kept: Record<string, string> = {};
  if (platform !== "linux") return kept;
  for (const [key, shape] of Object.entries(SESSION_ENV)) {
    const value = env[key];
    if (typeof value === "string" && value.length <= 4096 && shape.test(value)) kept[key] = value;
  }
  return kept;
}

export const INSTALL_PROFILE = "clawtrate";
/** OpenClaw's default port and the development gateway's: never chosen for an install. */
const RESERVED_PORTS = new Set([18789, 19001]);
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
// OpenClaw probes git while creating a workspace, both during onboarding and after launch.
// Its LaunchAgent puts the checked Node runtime's bin directory first in PATH.
// Look directly for a real install so Apple's /usr/bin/git stub cannot open a tools prompt.
export const DARWIN_GIT = `#!/bin/sh
try_git() {
  [ -x "$1" ] && ! [ "$1" -ef /usr/bin/git ] || return 0
  exec "$@"
}
try_git /opt/homebrew/bin/git "$@"
try_git /usr/local/bin/git "$@"
developer="$(/usr/bin/xcode-select --print-path 2>/dev/null)" || exit 127
case "$developer" in
  /*) ;;
  *) exit 127 ;;
esac
try_git "$developer/usr/bin/git" "$@"
try_git "$developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/git" "$@"
exit 127
`;

/** The status wait after the service is installed (§10). */
export const STATUS_WAIT_MS = 150_000;
const STATUS_EVERY_MS = 2_000;
const STATUS_RUN_MS = 30_000;
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
 * The checked installer's functions the install's copy replaces whole
 * (OpenClaw 2026.11.10, `install-cli.sh`), each from its `name() {` line to
 * its closing `}` line, by the SHA-256 of that text: a function of another
 * text is never changed, and the installer doesn't run.
 */
export const REPLACED_FUNCTIONS = {
  /**
   * Its Node.js step: FreeBSD's system runtime, Alpine's `apk` (through
   * `sudo`), the runtime already in the prefix, or a download of its own.
   */
  install_node: "e5e7aa30e6b5176f7531fc1abb79a72002762e3b410c15d99a57120f99775edd",
  /** Its temporary folder: under `TMPDIR`, or else under the shared `/tmp`. */
  prepare_tmpdir: "11bbc7287cf1a0847fcca678944f118f96f66e985c5cfd1efab5c4db554cabae",
} as const;

/**
 * What the install's copy runs instead (§10): the checked Node.js in the
 * prefix, linked and reported as `skip`, or a failure. No package manager,
 * system runtime or download of its own is reachable.
 */
export const CHECKED_INSTALL_NODE = [
  "install_node() {",
  "  # Clawtrate: the checked Node.js is the only runtime this install uses.",
  "  local dir",
  '  dir="$(node_dir)"',
  "  if linked_node_is_usable; then",
  '    ln -sfn "$dir" "${PREFIX}/tools/node"',
  '    emit_json step name node status skip path "$dir"',
  "    return",
  "  fi",
  '  emit_json error message "the checked Node.js is not usable"',
  "  exit 70",
  "}",
  "",
].join("\n");

/** Its temporary folder only under the `TMPDIR` the install gives it, inside the program folder; never the shared one. */
export const PRIVATE_TMPDIR = [
  "prepare_tmpdir() {",
  "  # Clawtrate: the install's own temporary folder, or a failure.",
  "  local base tmp",
  '  [[ -n "${TMPDIR:-}" ]] || fail "Cannot create a temporary directory."',
  '  base="$(resolve_installer_path "$TMPDIR")"',
  '  if ! tmp="$(mktemp -d "${base%/}/openclaw-install.XXXXXX" 2>/dev/null)"; then',
  '    fail "Cannot create a temporary directory."',
  "  fi",
  '  TMPFILES+=("$tmp")',
  '  export TMPDIR="$tmp"',
  "}",
  "",
].join("\n");

const REPLACEMENTS: Record<keyof typeof REPLACED_FUNCTIONS, string> = {
  install_node: CHECKED_INSTALL_NODE,
  prepare_tmpdir: PRIVATE_TMPDIR,
};

/**
 * The installer's text with `install_node` and `prepare_tmpdir` replaced
 * whole, or null unless each is defined exactly once and its text is the
 * checked one.
 */
export function patchInstaller(text: string): string | null {
  let out = text;
  for (const name of Object.keys(REPLACED_FUNCTIONS) as Array<keyof typeof REPLACED_FUNCTIONS>) {
    const head = `\n${name}() {\n`;
    const at = out.indexOf(head);
    if (at === -1 || out.indexOf(head, at + 1) !== -1) return null;
    const start = at + 1;
    const close = out.indexOf("\n}\n", start);
    if (close === -1) return null;
    const end = close + 3;
    const body = out.slice(start, end);
    if (createHash("sha256").update(body).digest("hex") !== REPLACED_FUNCTIONS[name]) return null;
    out = out.slice(0, start) + REPLACEMENTS[name] + out.slice(end);
  }
  return out;
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

/**
 * Whether the install can run for this home and app-data folder: each is an
 * absolute path the install's runner passes as it is (no quote or shell
 * syntax, such as an apostrophe in an account's name). The host offers setting up only then, so
 * such an account sees the install isn't offered rather than a failure after
 * its dialog.
 */
export function installSupported(home: string, appData: string): boolean {
  return [home, appData].every((path) => isAbsolute(path) && safeValue(path));
}

/** The real computer's place, for a person's app or a hosted runner. */
export function computerPlace(options: {
  home: string;
  appData: string;
  platform: "darwin" | "linux";
  target: InstallTarget;
  env: NodeJS.ProcessEnv;
  /** The session's bus as the main process read it (`sessionEnv`); read from `env` when not given. */
  session?: Record<string, string>;
  uid?: number;
  tar?: string;
  serviceManager?: string;
}): InstallPlace {
  const { home, appData, platform } = options;
  const env: Record<string, string> = {
    HOME: home,
    LANG: options.env.LANG && /^[A-Za-z0-9._@-]+$/.test(options.env.LANG) ? options.env.LANG : "C",
    NO_COLOR: "1",
    ...(platform === "linux" ? (options.session ?? sessionEnv(platform, options.env)) : {}),
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

/**
 * Where one attempt's downloads arrive, unchecked: a private folder beside
 * the program folder, named by the attempt's id and made exclusively by it.
 * Nothing in it is ever extracted or run.
 */
export function stagingDir(place: InstallPlace, id: string): string {
  return join(dirname(place.programDir), `.openclaw-staging-${id}`);
}

/** An attempt's id, as its records name it and its staging folder's name carries it. */
const ATTEMPT_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The paths of one install, all inside its program folder but the owner file. */
export function layout(place: InstallPlace, pins: InstallPins) {
  const dir = place.programDir;
  const nodeDir = join(dir, "tools", `node-v${pins.nodeVersion}`);
  const tarballName = `openclaw-${pins.version}.tgz`;
  const nodeName = `node-v${pins.nodeVersion}-${place.target}.tar.gz`;
  return {
    tarballName,
    nodeName,
    /** The program folder's own record of the attempt: written once, never changed. */
    record: join(dir, ".clawtrate-install.json"),
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
    /** The installer's temporary files: inside the program folder, never a shared one. */
    tmp: join(dir, "tmp"),
    openclaw: join(dir, "bin", "openclaw"),
    owner: join(place.stateDir, ".clawtrate-owner.json"),
  };
}

/**
 * The two paths the checked installer's wrapper runs (`install-cli.sh`, `publish_executable_wrapper`):
 * the prefix's Node.js link and the installed package's `entry.js`.
 */
export function expectedWrapper(place: InstallPlace, pins: InstallPins): [string, string] {
  return [
    join(place.programDir, "tools", "node", "bin", "node"),
    layout(place, pins).installedEntry,
  ];
}

/**
 * One word as bash's `printf %q` writes a path: characters that need no quoting as they are,
 * any other printable one after a backslash. Null for anything else (`$'…'` quoting, a quote,
 * a control character), which a path of this install never needs.
 */
function unquoteWord(word: string): string | null {
  let out = "";
  for (let at = 0; at < word.length; at += 1) {
    const char = word[at]!;
    if (char === "\\") {
      const next = word[at + 1];
      if (next === undefined || next < " " || next === "\x7f") return null;
      out += next;
      at += 1;
    } else if (/^[A-Za-z0-9._/@%+=:,-]$/.test(char)) out += char;
    else return null;
  }
  return out || null;
}

/**
 * The program and script a wrapper of the checked installer's runs: exactly its three lines,
 * `exec <node> <entry> "$@"`, each path as `printf %q` writes it. Null for any other text.
 */
export function wrapperCommand(text: string): [string, string] | null {
  const match =
    /^#!\/usr\/bin\/env bash\nset -euo pipefail\nexec ((?:\\.|[^\s\\])+) ((?:\\.|[^\s\\])+) "\$@"\n$/.exec(
      text,
    );
  if (!match) return null;
  const node = unquoteWord(match[1]!);
  const entry = unquoteWord(match[2]!);
  return node && entry ? [node, entry] : null;
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

/** A local-only gateway has no LAN or wide-area discovery and no tailnet exposure. */
export const QUIET_DISCOVERY_ARGS = [
  ...PROFILE_ARGS,
  "config",
  "set",
  "--batch-json",
  JSON.stringify([
    { path: "discovery.mdns.mode", value: "off" },
    { path: "gateway.tailscale.mode", value: "off" },
  ]),
];

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

/** Load an already verified definition without asking the installer to rewrite it. */
function resumeServiceArgs(place: InstallPlace): string[] {
  return place.platform === "darwin"
    ? ["bootstrap", `gui/${place.uid}`, place.serviceFile]
    : ["--user", "start", place.service];
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
    list.push({ program: at.openclaw, args: QUIET_DISCOVERY_ARGS });
    list.push({ program: at.openclaw, args: serviceInstallArgs(port) });
    list.push({ program: place.serviceManager, args: resumeServiceArgs(place) });
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

/** OpenClaw's heap limit for its gateway's Node.js (`daemon/node-args.ts`): the one option it adds. */
const HEAP_OPTION = /^--max-old-space-size=[1-9][0-9]{0,6}$/;

/**
 * Whether a service command runs exactly this install, in the shape the
 * pinned service writer gives it: on Linux the checked Node.js, OpenClaw's
 * heap option at most, the installed package's `dist/index.js` (or
 * `dist/entry.js`), both proven the checked tarball's, and `gateway --port
 * <port>`; on macOS that command after `/bin/sh` and the profile's own
 * environment wrapper and file in its state folder. Nothing else may come
 * before, between or after.
 */
export function runsCheckedInstall(
  argv: string[],
  place: InstallPlace,
  pins: InstallPins,
  port: number,
): boolean {
  const at = layout(place, pins);
  let rest = argv;
  if (place.platform === "darwin") {
    const envDir = join(place.stateDir, "service-env");
    if (
      rest[0] !== "/bin/sh" ||
      rest[1] !== join(envDir, `${place.service}-env-wrapper.sh`) ||
      rest[2] !== join(envDir, `${place.service}.env`)
    )
      return false;
    rest = rest.slice(3);
  }
  const node = real(at.nodeBin);
  if (node === null || rest[0] === undefined || real(rest[0]) !== node) return false;
  rest = rest.slice(1);
  if (rest[0] !== undefined && HEAP_OPTION.test(rest[0])) rest = rest.slice(1);
  // Compared through links: OpenClaw may write either path resolved.
  const entries = [at.installedIndex, at.installedEntry]
    .map(real)
    .filter((path): path is string => path !== null);
  const entry = rest[0] === undefined ? null : real(rest[0]);
  return (
    entry !== null &&
    entries.includes(entry) &&
    rest.length === 4 &&
    rest[1] === "gateway" &&
    rest[2] === "--port" &&
    rest[3] === String(port)
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
  // A quit that came first: nothing is asked or written.
  if (signal?.aborted) return { ok: false, why: "network" };
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

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** What a path is: absent (only ENOENT), there, or unreadable. */
type Presence = "absent" | "there" | "unreadable";

const presence = (path: string): Promise<Presence> =>
  lstat(path).then(
    () => "there",
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "absent" : "unreadable"),
  );

/** A file read without following a link, with its identity: what the install proves and removes by. */
type Owned = { text: string; stat: Stats };

async function readOwn(path: string): Promise<Owned | null> {
  let handle;
  try {
    // Never through a link, and never waiting on a named pipe that has no writer.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    return { text: await handle.readFile("utf8"), stat };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

const parsed = (text: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The same file or folder: one device and inode. */
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** Removes the file at `path` only when it still is `made`. Resolves whether it is gone. */
export async function unlinkIfSame(path: string, made: Stats): Promise<boolean> {
  let now: Stats;
  try {
    now = await lstat(path);
  } catch (error) {
    // Only "no such file" is gone; a path that can't be read may still be there.
    return errorCode(error) === "ENOENT";
  }
  if (!same(now, made)) return false;
  return unlink(path).then(
    () => true,
    () => false,
  );
}

/** Removes the folder at `path` only when it still is `made` and is empty. Resolves whether it is gone. */
export async function rmdirIfSame(path: string, made: Stats): Promise<boolean> {
  let now: Stats;
  try {
    now = await lstat(path);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  if (!now.isDirectory() || !same(now, made)) return false;
  return rmdir(path).then(
    () => true,
    () => false,
  );
}

type Stage = "installing" | "onboarding" | "onboarded" | "installed";

/**
 * Clawtrate's own record of an install (§10): one id, its folders, its
 * service and port, and how far it got. The only record of the stage, and
 * replaced whole at each.
 */
export type InstallRecord = {
  id: string;
  version: string;
  profile: string;
  programDir: string;
  stateDir: string;
  service: string;
  port: number | null;
  profileIdentity?: string;
  ownerIdentity?: string;
  /** A later attempt can clear only an early leftover. The active attempt can prove its own profile. */
  stage: Stage;
};

/** The program folder's record: the same id, version and profile as Clawtrate's, written once. */
type FolderRecord = { id: string; version: string; profile: string };

/** What an earlier attempt was proven to be, by identity, before any of it is removed. */
type ProfileProof = { dir: Stats; owner: Stats };

const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`;

type PendingInstall = {
  id: string;
  port: number;
  profile: ProfileProof;
  canRemove: boolean;
};

type RemovalMove = { from: string; to: string; staged: boolean };
type Removal = { id: string; receipt: Owned } & (
  | { record: Owned; moves: RemovalMove[]; bundleGone: false }
  | { record: Owned | null; moves: []; bundleGone: true }
);

type Proof = {
  id: string;
  dir: Stats;
  marker: Owned;
  record: Owned;
  staging: Stats | null;
};

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
  /** Aborted when the app quits: no download goes on, and no step after it starts. */
  signal?: AbortSignal;
  /** Moves the staged setup folders as one item to the system Trash. */
  trashSetup?: (path: string) => Promise<void>;
  /** For the host's tests: asked before each file the install makes is opened, then before it is written; may throw. */
  beforeWrite?: (path: string, at: "open" | "write") => void | Promise<void>;
  log?: (line: string) => void;
};

export type InstallOutcome =
  | {
      ok: true;
      port: number;
      /** The installed program, for the look that follows, which runs it for this profile only. */
      program: string;
      /** The session's bus on Linux, for that look's programs and Connect's. */
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
  /** Set when a program's group couldn't be confirmed ended: its attempt's files are then left. */
  private lingering = false;
  /** The id whose staging folder this run created itself: the only staging folder it may remove as its own. */
  private stagingMade: string | null = null;

  constructor(options: InstallOptions) {
    this.options = options;
    this.at = layout(options.place, options.pins);
  }

  private log(line: string): void {
    this.options.log?.(`[install] ${line}`);
  }

  /** Whether the app is quitting: nothing more starts. */
  private get closing(): boolean {
    return this.options.signal?.aborted === true;
  }

  /**
   * Makes a new file of the install's own (never one that is there) and
   * writes it whole. On a failed write it removes only the file it made, by
   * the identity its exclusive open gave it. Resolves that identity.
   */
  private async writeNew(path: string, data: string, mode = 0o600): Promise<Stats> {
    await this.options.beforeWrite?.(path, "open");
    const handle = await open(path, "wx", mode);
    let made: Stats | null = null;
    try {
      made = await handle.stat();
      await this.options.beforeWrite?.(path, "write");
      await handle.writeFile(data);
      await handle.close();
      return made;
    } catch (error) {
      await handle.close().catch(() => {});
      if (made) await unlinkIfSame(path, made);
      throw error;
    }
  }

  /** Runs one of this install's own commands; anything else is refused before it starts. */
  private exec(request: InstallRequest, port: number | null): Promise<InstallResult> {
    const allowed = commands(this.options.place, this.options.pins, port);
    return this.options
      .run(request, (asked) => {
        const known = allowed.some(
          (command) =>
            command.program === asked.program &&
            command.args.length === asked.args.length &&
            command.args.every((arg, index) => arg === asked.args[index]),
        );
        if (!known) throw new Error("refusing a command the install doesn't run");
      })
      .then((result) => {
        if (result.lingering) {
          this.lingering = true;
          this.log("a program's process group couldn't be confirmed ended");
        }
        return result;
      });
  }

  private env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.options.place.env,
      PATH: [
        ...(this.options.place.platform === "darwin" ? [dirname(this.at.nodeBin)] : []),
        join(this.options.place.programDir, "bin"),
        ...SYSTEM_PATH,
      ].join(":"),
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

  /** The profile's service: its file and the service manager's job or unit, the one predicate of every check. */
  private async serviceAbsent(): Promise<boolean> {
    if ((await presence(this.options.place.serviceFile)) !== "absent") return false;
    return (await this.supervisor()) === "absent";
  }

  /**
   * What is there now (§10, "Nothing there before"): the program folder,
   * Clawtrate's record, the profile's state folder and service file, and the
   * service manager's job or unit. Only "no such file" is absence.
   */
  async site(): Promise<InstallSite> {
    const { place } = this.options;
    const [program, record, state, service, removal] = await Promise.all(
      [
        place.programDir,
        place.recordFile,
        place.stateDir,
        place.serviceFile,
        this.removalPaths.root,
      ].map(presence),
    );
    const all = [program, record, state, service, removal];
    if (all.includes("unreadable")) return "unreadable";
    const loaded = await this.supervisor();
    if (loaded === "unreadable") return "unreadable";
    if (state === "there" || service === "there" || removal === "there" || loaded === "there")
      return "exists";
    if (program === "absent" && record === "absent") return "clear";
    return (await this.prove()) !== null ? "leftover" : "exists";
  }

  /**
   * Proves the attempt from both records and the program folder. The records must agree
   * on id, version and profile, and the app record must say the expected stage.
   */
  private async prove(stage: Stage = "installing"): Promise<Proof | null> {
    const { place, pins } = this.options;
    const dir = await lstat(place.programDir).catch(() => null);
    if (!dir?.isDirectory()) return null;
    const [marker, record] = await Promise.all([
      readOwn(this.at.record),
      readOwn(place.recordFile),
    ]);
    if (!marker || !record) return null;
    const own = parsed(record.text);
    const there = parsed(marker.text);
    if (
      !own ||
      !there ||
      typeof own.id !== "string" ||
      !ATTEMPT_ID.test(own.id) ||
      own.id !== there.id ||
      Object.keys(there).sort().join(",") !== "id,profile,version" ||
      own.stage !== stage ||
      own.version !== pins.version ||
      there.version !== pins.version ||
      own.profile !== INSTALL_PROFILE ||
      there.profile !== INSTALL_PROFILE ||
      own.programDir !== place.programDir ||
      own.stateDir !== place.stateDir
    )
      return null;
    const staging = await lstat(stagingDir(place, own.id)).catch((error: unknown) =>
      errorCode(error) === "ENOENT" ? null : false,
    );
    // A staging place of that name that isn't a folder, or can't be read, isn't the attempt's.
    if (staging === false || (staging !== null && !staging.isDirectory())) return null;
    return { id: own.id, dir, marker, record, staging };
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
    return (await this.prove()) !== null ? this.at.openclaw : null;
  }

  /** Checks the profile's original directory and the ownership record this attempt wrote. */
  private async sameProfile(path: string, id: string, profile: ProfileProof): Promise<boolean> {
    const dir = await lstat(path).catch(() => null);
    if (!dir?.isDirectory() || !same(dir, profile.dir)) return false;
    const owner = await readOwn(join(path, ".clawtrate-owner.json"));
    return (
      owner !== null && same(owner.stat, profile.owner) && owner.text === JSON.stringify({ id })
    );
  }

  /** Removes an early attempt, before any profile was created. */
  async discard(id: string | null = null): Promise<boolean> {
    const { place } = this.options;
    if (
      id === null &&
      ((await presence(place.stateDir)) !== "absent" || !(await this.serviceAbsent()))
    )
      return false;
    const proof = await this.prove();
    if (!proof || (id !== null && proof.id !== id)) return false;
    const quarantine = join(dirname(place.programDir), `.openclaw-removing-${randomUUID()}`);
    try {
      await mkdir(quarantine, { mode: 0o700 });
    } catch {
      return false;
    }
    const staging = stagingDir(place, proof.id);
    const ownStaging = proof.staging !== null && (id === null || this.stagingMade === id);
    const moves = [
      { from: place.programDir, to: join(quarantine, "program") },
      { from: place.recordFile, to: join(quarantine, "record") },
      ...(ownStaging ? [{ from: staging, to: join(quarantine, "staging") }] : []),
    ];
    const moved = [];
    for (const move of moves) {
      try {
        await rename(move.from, move.to);
        moved.push(move);
      } catch {
        break;
      }
    }
    if (moved.length !== moves.length || !(await this.stillProven(quarantine, proof))) {
      await this.putBack(moved);
      await rmdir(quarantine).catch(() => {});
      this.log("an early attempt changed while it was being removed");
      return false;
    }
    await rm(quarantine, { recursive: true, force: true }).catch(() => {});
    await unlinkIfSame(this.scratch(proof.id, "installing"), proof.record.stat);
    const left = await Promise.all(
      [
        place.programDir,
        place.recordFile,
        staging,
        quarantine,
        this.scratch(proof.id, "installing"),
      ].map(presence),
    );
    return left.every((state) => state === "absent");
  }

  private get removalPaths() {
    const root = join(dirname(this.options.place.programDir), ".openclaw-removing");
    return {
      root,
      receipt: join(root, "receipt.json"),
      bundle: join(root, "Unfinished OpenClaw setup"),
    };
  }

  private async putBack(moves: Array<{ from: string; to: string }>): Promise<boolean> {
    let restored = true;
    for (const { from, to } of moves.slice().reverse()) {
      if ((await presence(from)) !== "absent") {
        restored = false;
        continue;
      }
      try {
        await rename(to, from);
      } catch {
        restored = false;
      }
    }
    return restored;
  }

  /** A receipt stays outside the one bundle moved into the Trash, so reopening can finish it. */
  private async removal(): Promise<Removal | null> {
    const { place, pins } = this.options;
    const paths = this.removalPaths;
    const root = await lstat(paths.root).catch(() => null);
    if (!root?.isDirectory()) return null;
    const receipt = await readOwn(paths.receipt);
    const saved = receipt ? parsed(receipt.text) : null;
    if (
      !receipt ||
      !saved ||
      typeof saved.id !== "string" ||
      !ATTEMPT_ID.test(saved.id) ||
      typeof saved.record !== "string" ||
      typeof saved.program !== "string" ||
      typeof saved.marker !== "string" ||
      typeof saved.bundle !== "string"
    )
      return null;
    const record = await readOwn(place.recordFile);
    const installed = record ? parsed(record.text) : null;
    const state = await presence(paths.bundle);
    const matching =
      record &&
      installed &&
      saved.id === installed.id &&
      saved.record === identity(record.stat) &&
      installed.stage === "onboarded" &&
      installed.version === pins.version &&
      installed.profile === INSTALL_PROFILE &&
      installed.programDir === place.programDir &&
      installed.stateDir === place.stateDir;
    if (state === "absent") {
      // After the Trash move, only the app's receipt and perhaps its old record are left.
      // Do not infer a Trash outcome after an interruption or touch a replacement record.
      if (
        (!matching && (await presence(place.recordFile)) !== "absent") ||
        (await presence(place.programDir)) !== "absent" ||
        (await presence(place.stateDir)) !== "absent"
      )
        return null;
      return {
        id: saved.id,
        receipt,
        record: matching ? record : null,
        moves: [],
        bundleGone: true,
      };
    }
    if (!matching || !record || !installed) return null;
    const bundle = await lstat(paths.bundle).catch(() => null);
    if (!bundle?.isDirectory() || identity(bundle) !== saved.bundle) return null;
    const moves: RemovalMove[] = [];
    for (const { from, name, marker, dirId, markerId, text } of [
      {
        from: place.programDir,
        name: "Program",
        marker: ".clawtrate-install.json",
        dirId: saved.program,
        markerId: saved.marker,
        text: (body: Record<string, unknown> | null) =>
          body !== null &&
          body.id === saved.id &&
          body.version === pins.version &&
          body.profile === INSTALL_PROFILE,
      },
      {
        from: place.stateDir,
        name: "Gateway profile",
        marker: ".clawtrate-owner.json",
        dirId: installed.profileIdentity,
        markerId: installed.ownerIdentity,
        text: (body: Record<string, unknown> | null) =>
          body !== null && body.id === saved.id && Object.keys(body).length === 1,
      },
    ]) {
      const to = join(paths.bundle, name);
      const where = await presence(to);
      if (where === "unreadable") return null;
      const staged = where === "there";
      const source = staged ? to : from;
      const dir = await lstat(source).catch(() => null);
      if (!dir?.isDirectory() || identity(dir) !== dirId) return null;
      const own = await readOwn(join(source, marker));
      if (!own || identity(own.stat) !== markerId || !text(parsed(own.text))) return null;
      moves.push({ from, to, staged });
    }
    return { id: saved.id, receipt, record, moves, bundleGone: false };
  }

  private async clearRemoval(receipt: Owned | null): Promise<boolean> {
    const { root, receipt: file, bundle } = this.removalPaths;
    if ((await presence(bundle)) !== "absent") {
      try {
        await rmdir(bundle);
      } catch {
        return false;
      }
    }
    if (receipt && !(await unlinkIfSame(file, receipt.stat))) return false;
    await rmdir(root).catch(() => {});
    return (await presence(root)) === "absent";
  }

  /** No folders were moved, or both were already restored. Empty bookkeeping can go. */
  private async clearUnusedRemoval(id: string): Promise<boolean> {
    const paths = this.removalPaths;
    if (!(await lstat(paths.root).catch(() => null))?.isDirectory()) return false;
    const receipt = await readOwn(paths.receipt);
    const saved = receipt ? parsed(receipt.text) : null;
    // An empty or unparseable receipt was opened but never written: nothing was moved yet.
    // clearRemoval takes the bundle with rmdir, so one holding anything stays where it is.
    if (receipt && saved) {
      if ((await presence(paths.bundle)) !== "absent") return false;
      const proof = await this.prove("onboarded");
      if (
        !proof ||
        proof.id !== id ||
        saved.id !== id ||
        saved.record !== identity(proof.record.stat) ||
        saved.program !== identity(proof.dir) ||
        saved.marker !== identity(proof.marker.stat)
      )
        return false;
    } else if (!receipt && (await presence(paths.receipt)) !== "absent") {
      // A receipt that can't be read as the app's own file (a link, a folder) is left alone.
      return false;
    }
    return this.clearRemoval(receipt);
  }

  private async restoreRemoval(removal: Removal): Promise<boolean> {
    if (removal.bundleGone || !(await this.serviceAbsent())) return false;
    const staged = removal.moves.filter((move) => move.staged);
    if (
      (await Promise.all(staged.map(({ from }) => presence(from)))).some(
        (state) => state !== "absent",
      )
    )
      return false;
    if (!(await this.putBack(staged))) return false;
    return this.clearRemoval(removal.receipt);
  }

  private async prepareRemoval(id: string, profile: ProfileProof): Promise<boolean> {
    const { place, trashSetup } = this.options;
    const { root, receipt, bundle } = this.removalPaths;
    const proof = await this.prove("onboarded");
    if (
      !proof ||
      proof.id !== id ||
      proof.staging ||
      this.lingering ||
      !trashSetup ||
      !(await this.serviceAbsent()) ||
      !(await this.sameProfile(place.stateDir, id, profile))
    )
      return false;
    // Moving both folders as one Trash item is atomic on this volume. Leave both where they are
    // when a rename would cross volumes. Two separate Trash calls could strand one on refusal.
    if (proof.dir.dev !== profile.dir.dev) return false;
    try {
      await mkdir(root, { mode: 0o700 });
    } catch {
      return false;
    }
    try {
      await mkdir(bundle, { mode: 0o700 });
      await this.writeNew(
        receipt,
        JSON.stringify({
          id,
          record: identity(proof.record.stat),
          program: identity(proof.dir),
          marker: identity(proof.marker.stat),
          bundle: identity(await lstat(bundle)),
        }),
      );
      return true;
    } catch {
      await rmdir(bundle).catch(() => {});
      await rmdir(root).catch(() => {});
      return false;
    }
  }

  /** Stages the proven folders and sends the bundle to the Trash in one operation. */
  private async finishRemoval(
    id: string,
  ): Promise<"trashed" | "finished" | "kept" | "trash-failed"> {
    const { place, trashSetup } = this.options;
    const { bundle } = this.removalPaths;
    let removal = await this.removal();
    if (!removal || removal.id !== id || !(await this.serviceAbsent()) || this.lingering)
      return "kept";
    if (removal.bundleGone) {
      if (
        (removal.record && !(await unlinkIfSame(place.recordFile, removal.record.stat))) ||
        !(await this.clearRemoval(removal.receipt))
      )
        return "kept";
      return "finished";
    }
    if (!trashSetup) return "trash-failed";
    try {
      for (const move of removal.moves) {
        if (!move.staged) {
          if ((await presence(move.to)) !== "absent") throw new Error("destination exists");
          await rename(move.from, move.to);
        }
      }
      removal = await this.removal();
      if (
        !removal ||
        removal.id !== id ||
        removal.bundleGone ||
        removal.moves.some((move) => !move.staged) ||
        !(await this.serviceAbsent()) ||
        this.lingering
      )
        throw new Error("setup changed");
      await trashSetup(bundle);
      if ((await presence(bundle)) !== "absent") throw new Error("bundle still there");
    } catch {
      const current = await this.removal();
      if (current?.id === id) await this.restoreRemoval(current);
      return "trash-failed";
    }
    if (
      !(await unlinkIfSame(place.recordFile, removal.record.stat)) ||
      !(await this.clearRemoval(removal.receipt))
    )
      return "kept";
    return "trashed";
  }

  /** In quarantine: the same folder, staging folder, marker and record, by identity and text. */
  private async stillProven(quarantine: string, proof: Proof): Promise<boolean> {
    const dir = await lstat(join(quarantine, "program")).catch(() => null);
    if (!dir?.isDirectory() || !same(dir, proof.dir)) return false;
    const marker = await readOwn(join(quarantine, "program", ".clawtrate-install.json"));
    if (!marker || !same(marker.stat, proof.marker.stat) || marker.text !== proof.marker.text)
      return false;
    const record = await readOwn(join(quarantine, "record"));
    if (!record || !same(record.stat, proof.record.stat) || record.text !== proof.record.text)
      return false;
    if (proof.staging && (await presence(join(quarantine, "staging"))) !== "absent") {
      const staging = await lstat(join(quarantine, "staging")).catch(() => null);
      if (!staging?.isDirectory() || !same(staging, proof.staging)) return false;
    }
    return true;
  }

  /** Where Clawtrate's record at a stage is made whole before it is put in place: one path per stage. */
  private scratch(id: string, stage: Stage): string {
    return `${this.options.place.recordFile}.${id}.${stage}.next`;
  }

  private record(
    id: string,
    stage: Stage,
    port: number | null,
    profile?: ProfileProof,
  ): InstallRecord {
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
      ...(profile
        ? { profileIdentity: identity(profile.dir), ownerIdentity: identity(profile.owner) }
        : {}),
    };
  }

  /** Clawtrate's record at a new stage: written whole to a new file, then moved over the last in one step. */
  private async writeStage(
    id: string,
    stage: Stage,
    port: number | null,
    profile?: ProfileProof,
  ): Promise<void> {
    const next = this.scratch(id, stage);
    const made = await this.writeNew(next, JSON.stringify(this.record(id, stage, port, profile)));
    try {
      await rename(next, this.options.place.recordFile);
    } catch (error) {
      await unlinkIfSame(next, made);
      throw error;
    }
  }

  /**
   * Reserves the attempt: its program folder created exclusively, the
   * folder's record made in it, then Clawtrate's record, made beside it and
   * linked into place, which never replaces one. Resolves null once reserved,
   * or why it couldn't be, having removed only what it made, by identity.
   */
  private async reserve(id: string): Promise<InstallFailure | null> {
    const { place, pins } = this.options;
    try {
      await mkdir(dirname(place.programDir), { recursive: true, mode: 0o700 });
      await mkdir(place.programDir, { mode: 0o700 });
    } catch (error) {
      return failure(errorCode(error) === "EEXIST" ? "exists" : "write", -1);
    }
    const folder = await lstat(place.programDir).catch(() => null);
    /** Undoes the reservation: the files it made and its empty folder, each only if it still is what was made. */
    const undo = async (kind: InstallFailureKind, made: Array<[string, Stats]>) => {
      let removed = folder !== null;
      for (const [path, stat] of made) removed = (await unlinkIfSame(path, stat)) && removed;
      removed = removed && folder !== null && (await rmdirIfSame(place.programDir, folder));
      return failure(
        kind,
        -1,
        removed ? { cleanup: "removed", retry: kind !== "exists" } : { cleanup: "unproven" },
      );
    };
    const record: FolderRecord = { id, version: pins.version, profile: INSTALL_PROFILE };
    let marker: Stats;
    try {
      marker = await this.writeNew(this.at.record, JSON.stringify(record));
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        // Something else put a file into the folder this attempt made: neither is touched.
        this.log("a file appeared in the program folder as it was made");
        return failure("changed", -1, { cleanup: "unproven" });
      }
      return undo("write", []);
    }
    const next = this.scratch(id, "installing");
    let scratch: Stats;
    try {
      scratch = await this.writeNew(next, JSON.stringify(this.record(id, "installing", null)));
    } catch (error) {
      return undo(errorCode(error) === "EEXIST" ? "exists" : "write", [[this.at.record, marker]]);
    }
    try {
      // A record that appeared since the check is never replaced.
      await link(next, place.recordFile);
    } catch (error) {
      return undo(errorCode(error) === "EEXIST" ? "exists" : "write", [
        [next, scratch],
        [this.at.record, marker],
      ]);
    }
    // Reserved. A scratch link that stays is the same file as the record, removed with the attempt.
    if (!(await unlinkIfSame(next, scratch))) this.log("the record's scratch link stayed");
    return null;
  }

  /** The recorded checkpoint after onboarding, with the same profile and owner files on disk. */
  private async pending(): Promise<PendingInstall | null> {
    const { place, pins } = this.options;
    const proof = await this.prove("onboarded");
    if (!proof || proof.staging) return null;
    const record = parsed(proof.record.text);
    const port = record?.port;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      RESERVED_PORTS.has(port)
    )
      return null;
    const dir = await lstat(place.stateDir).catch(() => null);
    const owner = await readOwn(this.at.owner);
    if (
      !dir?.isDirectory() ||
      !owner ||
      owner.text !== JSON.stringify({ id: proof.id }) ||
      record?.profileIdentity !== identity(dir) ||
      record.ownerIdentity !== identity(owner.stat)
    )
      return null;
    if (!(await this.checkedProgram(pins.version))) return null;
    const written = await this.writtenService(port);
    if (written !== "absent" && written !== "ours") return null;
    if (written === "absent" && !(await this.serviceAbsent())) return null;
    return {
      id: proof.id,
      port,
      profile: { dir, owner: owner.stat },
      canRemove: written === "absent",
    };
  }

  async recovery(): Promise<{
    id?: string;
    action: InstallRecovery;
    location?: InstallLocation;
  } | null> {
    const { place } = this.options;
    const staged = await this.removal();
    if (
      staged &&
      (await this.serviceAbsent()) &&
      // Neither folder was moved yet, or both were put back: they are in their usual places, and
      // only empty bookkeeping is left. rmdir keeps a bundle that holds anything.
      (staged.bundleGone ||
        staged.moves.some((move) => move.staged) ||
        !(await this.clearRemoval(staged.receipt)))
    )
      return {
        id: staged.id,
        action: staged.bundleGone ? "finish" : "staged",
        location: "staging",
      };
    const pending = await this.pending();
    if (
      (await presence(this.removalPaths.root)) !== "absent" &&
      (!pending || !(await this.clearUnusedRemoval(pending.id)))
    )
      return { action: "inspect", location: "staging" };
    if (pending) return { id: pending.id, action: pending.canRemove ? "replace" : "continue" };
    if ((await this.prove("installed")) || (await this.leftoverProgram())) return null;
    const locations = [
      ["profile", place.stateDir],
      ["program", place.programDir],
      ["service", place.serviceFile],
      ["record", place.recordFile],
    ] as const;
    for (const [location, path] of locations) {
      if ((await presence(path)) !== "absent") return { action: "inspect", location };
    }
    return null;
  }

  /**
   * Runs every step, publishing where it stands. Resolves how it ended; a
   * failure before onboarding has already removed what the attempt made, and
   * says so with `cleanup`.
   */
  async run(
    progress: (install: SetupInstall) => void,
    action?: InstallAction,
    expectedId?: string,
  ): Promise<InstallOutcome> {
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
    if (action) {
      if (!expectedId || this.closing) return stopped("changed", -1);
      const saved = await this.removal();
      if (saved ? saved.id !== expectedId : (await presence(this.removalPaths.root)) !== "absent")
        return stopped("changed", -1);
      if (action === "continue") {
        if (saved && !(await this.restoreRemoval(saved))) return stopped("restore", -1);
        const pending = await this.pending();
        if (!pending || pending.id !== expectedId) return stopped("changed", -1);
        publish({ step: 2, nodeChecked: true });
        return this.finishProfile(
          publish,
          pending.id,
          pending.port,
          pending.profile,
          !pending.canRemove,
        );
      }
      if (!saved) {
        const pending = await this.pending();
        if (!pending || pending.id !== expectedId || !pending.canRemove)
          return stopped("changed", -1);
        if (!(await this.prepareRemoval(pending.id, pending.profile))) {
          publish({ step: 2, nodeChecked: true });
          return stopped("trash", -1);
        }
      }
      const discarded = await this.finishRemoval(expectedId);
      if (discarded === "trash-failed") {
        publish({ step: 2, nodeChecked: true });
        return stopped("trash", -1);
      }
      if (discarded === "kept") return stopped("changed", -1, { cleanup: "unproven" });
      if (discarded === "trashed") publish({ foldersTrashed: true });
    }
    const site = await this.site();
    if (site === "unreadable") return stopped("write", -1);
    if (site === "exists") return stopped("exists", -1);
    if (site === "leftover" && !(await this.discard())) return stopped("exists", -1);
    if (this.closing) return stopped("download", -1);

    const id = (this.options.newId ?? randomUUID)();
    const refused = await this.reserve(id);
    if (refused) return { ok: false, failure: refused };

    /** Before onboarding the attempt is the program folder, its staging folder and Clawtrate's record alone, removed on failure. */
    const early = async (
      kind: InstallFailureKind,
      step: number,
      extra: Partial<InstallFailure> = {},
    ) => {
      // A program that may still write there: nothing of the attempt is removed under it.
      const removed = !this.lingering && (await this.discard(id));
      const cleanup: InstallCleanup = removed ? "removed" : "unproven";
      return stopped(kind, step, {
        ...extra,
        cleanup,
        retry: removed && kind !== "changed",
      });
    };
    try {
      const before = await this.beforeOnboarding(publish, id);
      if (before.ok === false) return early(before.kind, before.step, before.extra);
    } catch {
      return early("write", install.step);
    }

    // 3. Set up the gateway. From here the attempt reaches outside its program folder.
    let port: number;
    try {
      port = await (this.options.freePort ?? freeLoopbackPort)();
    } catch {
      return early("write", 2);
    }
    if (this.closing) return early("installer", 2);
    // The profile and its service once more, then the state folder reserved, and only then the
    // stage that says onboarding began.
    if ((await presence(place.stateDir)) !== "absent" || !(await this.serviceAbsent())) {
      this.log("the profile or its service appeared before onboarding");
      return early("changed", 2);
    }
    try {
      await mkdir(place.stateDir, { mode: 0o700 });
    } catch (error) {
      return early(errorCode(error) === "EEXIST" ? "changed" : "write", 2);
    }
    const state = await lstat(place.stateDir).catch(() => null);
    /** Still before onboarding: the empty state folder this attempt made, then the attempt. */
    const unmake = async (kind: InstallFailureKind) => {
      const empty = state !== null && (await rmdirIfSame(place.stateDir, state));
      const result = await early(kind, 2);
      return empty ? result : stopped(kind, 2, { cleanup: "unproven", retry: false });
    };
    if (state === null || this.closing) return unmake(state === null ? "write" : "installer");
    try {
      await this.writeStage(id, "onboarding", port);
    } catch {
      return unmake("write");
    }
    const kept = (kind: InstallFailureKind, extra: Partial<InstallFailure> = {}, step = 2) =>
      stopped(kind, step, { cleanup: "kept", ...extra });
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
    if (onboard.failed) {
      // Onboarding never started (the app quits, or it couldn't be run): back to `installing`,
      // and the attempt is removed as before onboarding. If that can't be written, it is kept.
      this.log("onboarding didn't start");
      try {
        await this.writeStage(id, "installing", null);
      } catch {
        return kept("onboard");
      }
      return unmake("onboard");
    }
    const onboarded = readOnboarding(onboard.stdout, port);
    if (this.lingering || onboard.timedOut || !onboarded.ok || onboard.exitCode !== 0) {
      this.log(
        `onboarding not accepted: exit=${onboard.exitCode} timedOut=${onboard.timedOut} tooLarge=${onboard.tooLarge} ${onboardingFacts(onboard.stdout, port)}`,
      );
      return kept("onboard", {
        exitCode: onboard.exitCode,
        classification: onboarded.ok ? null : onboarded.classification,
      });
    }
    let owner: Stats;
    try {
      owner = await this.writeNew(this.at.owner, JSON.stringify({ id }));
    } catch {
      return kept("write");
    }
    const profile = { dir: state, owner };
    // The installer completed onboarding and its process group exited. A new app process can
    // continue from here after proving the checkpoint, even if this one quits before launchd.
    try {
      await this.writeStage(id, "onboarded", port, profile);
    } catch {
      return kept("write");
    }
    return this.finishProfile(publish, id, port, profile);
  }

  /** Reads back only the discovery flags from OpenClaw's own profile config. */
  private async discoveryOff(): Promise<boolean> {
    const config = await readOwn(join(this.options.place.stateDir, "openclaw.json"));
    const settings = config ? parsed(config.text) : null;
    const discovery = field(settings, "discovery");
    const gateway = field(settings, "gateway");
    return (
      field(field(discovery, "mdns"), "mode") === "off" &&
      field(field(discovery, "wideArea"), "domain") === undefined &&
      field(field(gateway, "tailscale"), "mode") === "off"
    );
  }

  private async finishProfile(
    publish: (next: Partial<SetupInstall>) => void,
    id: string,
    port: number,
    profile: ProfileProof,
    checkExisting = false,
  ): Promise<InstallOutcome> {
    const { place, pins } = this.options;
    const stopped = (
      kind: InstallFailureKind,
      step: number,
      extra: Partial<InstallFailure> = {},
    ): InstallOutcome => ({ ok: false, failure: failure(kind, step, extra) });
    const kept = (kind: InstallFailureKind, extra: Partial<InstallFailure> = {}, step = 2) =>
      stopped(kind, step, { cleanup: "kept", ...extra });
    if (this.closing) return kept("service");
    if (!(await this.sameProfile(place.stateDir, id, profile))) return kept("changed");
    if (checkExisting) {
      if ((await this.writtenService(port)) !== "ours" || !(await this.discoveryOff()))
        return kept("changed");
      const loaded = await this.supervisor();
      if (loaded === "unreadable") return kept("service");
      if (loaded === "absent") {
        if (this.closing || (await this.writtenService(port)) !== "ours") return kept("changed");
        const started = await this.exec(
          {
            program: place.serviceManager,
            args: resumeServiceArgs(place),
            env: this.env(),
            ...this.quick(),
          },
          port,
        );
        if (!ok(started)) return kept("service", { exitCode: started.exitCode });
      }
    } else {
      if (!(await this.serviceAbsent())) return kept("changed");
      if (!(await this.discoveryOff())) {
        const configured = await this.exec(
          {
            program: this.at.openclaw,
            args: QUIET_DISCOVERY_ARGS,
            env: this.env(),
            ...this.quick(),
          },
          port,
        );
        if (!ok(configured) || !(await this.discoveryOff()))
          return kept("onboard", { exitCode: configured.exitCode });
      }
      // Recheck after the config write. A service which appears beforehand is left in place.
      if (this.closing || !(await this.serviceAbsent())) return kept("changed");
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
      // What is defined now, read back: a definition that doesn't run this install on its port is
      // someone else's, which appeared after the check above. It is left as it is.
      const written = await this.writtenService(port);
      if (written === "other") {
        this.log(
          "a service of the profile appeared while it was being installed; it was left as it is",
        );
        return kept("service-appeared", { exitCode: installed.exitCode });
      }
      if (written !== "ours" || !ok(installed) || !readServiceInstall(installed.stdout)) {
        this.log(
          `the service wasn't confirmed installed: exit=${installed.exitCode} timedOut=${installed.timedOut} definition=${written}`,
        );
        if (written === "absent" && !this.lingering) {
          const discarded = (await this.prepareRemoval(id, profile))
            ? await this.finishRemoval(id)
            : "kept";
          if (discarded === "trash-failed")
            return kept("service", { exitCode: installed.exitCode });
          const removed = discarded === "trashed";
          if (removed) publish({ foldersTrashed: true });
          return stopped("service", 2, {
            exitCode: installed.exitCode,
            cleanup: removed ? "removed" : "unproven",
            retry: removed,
          });
        }
        return kept("service", { exitCode: installed.exitCode });
      }
    }
    publish({ step: 3 });

    // 4. Start and check.
    const sleep = this.options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    const now = this.options.now ?? Date.now;
    const until = now() + (this.options.statusWaitMs ?? STATUS_WAIT_MS);
    for (;;) {
      const left = until - now();
      if (left <= 0 || this.closing) return kept("not-answering", {}, 3);
      const status = await this.exec(
        {
          program: this.at.openclaw,
          args: [...PROFILE_ARGS, "gateway", "status", "--json"],
          env: this.env(),
          cwd: place.home,
          timeoutMs: Math.min(STATUS_RUN_MS, left),
          maxBytes: 1024 * 1024,
        },
        port,
      );
      if (ok(status) && now() <= until && readAnswering(status.stdout, port, pins.version)) break;
      if (now() >= until || this.closing) return kept("not-answering", {}, 3);
      await sleep(Math.min(STATUS_EVERY_MS, Math.max(0, until - now())));
    }
    try {
      await this.writeStage(id, "installed", port);
    } catch {
      return kept("write");
    }
    publish({ step: 4 });
    this.log("set up and answering");
    return {
      ok: true,
      port,
      program: this.at.openclaw,
      env: place.platform === "linux" ? sessionEnv("linux", place.env) : {},
    };
  }

  /**
   * The profile's service definition after `gateway install`: absent, the
   * one that runs this install on `port`, another, or one that can't be read.
   */
  private async writtenService(port: number): Promise<"absent" | "ours" | "other" | "unreadable"> {
    const { place, pins } = this.options;
    const there = await presence(place.serviceFile);
    if (there !== "there") return there;
    const file = await readOwn(place.serviceFile);
    if (!file) return "other";
    const argv = serviceArgv(place.platform, file.text);
    return argv !== null && runsCheckedInstall(argv, place, pins, port) ? "ours" : "other";
  }

  /**
   * Steps 1 and 2: the downloads, into the attempt's staging folder beside
   * the program folder and checked there, then the installer, with the
   * checked Node.js only, and the installed program checked. Throws for a
   * write of its own that failed.
   */
  private async beforeOnboarding(
    publish: (next: Partial<SetupInstall>) => void,
    id: string,
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

    // 1. Download into staging, and check both before either is extracted or run.
    this.log("downloading");
    const staging = stagingDir(place, id);
    await mkdir(staging, { mode: 0o700 });
    this.stagingMade = id;
    const stagedTarball = join(staging, this.at.tarballName);
    const stagedNode = join(staging, this.at.nodeName);
    const get = this.options.download ?? download;
    const node = pins.node[place.target];
    const [tarball, runtime] = await Promise.all([
      get(pins.openclaw.url, stagedTarball, "sha512", "base64", this.options.signal),
      get(node.url, stagedNode, "sha256", "hex", this.options.signal),
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
    if (this.closing) return no("download", 0);
    // Checked: only now in the program folder.
    await mkdir(this.at.downloads, { mode: 0o700 });
    await rename(stagedTarball, this.at.tarball);
    await rename(stagedNode, this.at.nodeTarball);
    await rmdir(staging);
    publish({ step: 1 });

    // 2. Install Node.js and OpenClaw.
    await mkdir(this.at.nodeDir, { recursive: true, mode: 0o700 });
    await mkdir(this.at.scripts, { mode: 0o700 });
    const unpack = { cwd: place.programDir, timeoutMs: 120_000, maxBytes: 64 * 1024 };
    const list = commands(place, pins, null);
    const tar = list.filter((command) => command.program === place.tar);
    const [check, installer] = list.filter((command) => command.program === place.bash);
    for (const command of tar) {
      if (this.closing) return no("unpack", 1);
      const unpacked = await this.exec({ ...command, env: this.env(), ...unpack }, null);
      if (!ok(unpacked)) return no("unpack", 1, { exitCode: unpacked.exitCode });
    }
    // The checked installer, its Node.js step and temporary folder replaced whole.
    const original = await readFile(this.at.installer, "utf8").catch(() => null);
    const patched = original === null ? null : patchInstaller(original);
    if (patched === null) {
      this.log(
        "the checked installer's Node.js step or temporary folder isn't the one this build replaces",
      );
      return no("installer-changed", 1);
    }
    await writeFile(this.at.installer, patched, { mode: 0o700 });
    if (place.platform === "darwin")
      await this.writeNew(join(dirname(this.at.nodeBin), "git"), DARWIN_GIT, 0o700);
    const usable = await this.exec({ ...check!, env: this.env(), ...unpack }, null);
    if (!ok(usable)) {
      this.log("the installer's Node.js check refused the checked Node.js");
      return no("node-not-checked", 1);
    }
    await mkdir(dirname(this.at.npmUser), { mode: 0o700 });
    await this.writeNew(this.at.npmUser, "");
    await this.writeNew(this.at.npmGlobal, "");
    await mkdir(this.at.tmp, { mode: 0o700 });
    if (this.closing) return no("installer", 1);
    let seen: InstallerEvents = { node: null, done: false, version: null };
    const ran = await this.exec(
      {
        ...installer!,
        env: this.env({
          NPM_CONFIG_USERCONFIG: this.at.npmUser,
          NPM_CONFIG_GLOBALCONFIG: this.at.npmGlobal,
          NPM_CONFIG_CACHE: this.at.npmCache,
          npm_config_registry: "https://registry.npmjs.org/",
          TMPDIR: this.at.tmp,
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
    // Stopped before its Node.js step (its temporary folder, say): the installer's failure. Exit 70
    // is the replaced step's own: the checked Node.js wasn't usable.
    if (seen.node === null && !ok(ran) && ran.exitCode !== 70)
      return no("installer", 1, { exitCode: ran.exitCode });
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
    const runs = text === null ? null : wrapperCommand(text);
    const expected = expectedWrapper(place, pins);
    if (!runs || runs[0] !== expected[0] || runs[1] !== expected[1]) return false;
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
