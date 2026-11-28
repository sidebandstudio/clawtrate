// Paths, ports and the one guarded way to run the OpenClaw CLI against the
// development profile. Every `openclaw` subprocess in this repo goes through an
// `OpenclawRunner`, which checks the state folder first (state-guard.ts) and
// always passes `--dev` and a scrubbed environment.

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import type { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENCLAW_VERSION, openclawProgram, type Program } from "./pinned.ts";
import type { OpenclawVersion } from "./versions.ts";
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_PROVIDER_PORT,
  profileArgs,
  profileFor,
  runDirFor,
  stateDirFor,
  validateInstanceName,
} from "./instance.ts";
import {
  processIdentity,
  readMarker,
  readRunRecord,
  spawnRefusal,
  type Identify,
} from "./state-guard.ts";

/** The default instance's ports. Named instances record their own. */
export const GATEWAY_PORT = DEFAULT_GATEWAY_PORT;
export const GATEWAY_URL = `ws://127.0.0.1:${GATEWAY_PORT}`;
export const PROVIDER_PORT = DEFAULT_PROVIDER_PORT;
export const PROVIDER_ID = "scripted";
export const IOS_STREAM_HOLD_FILE = "ios-stream-hold";
export const MODEL_ID = "dev-1";
export const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;

/** OpenClaw's own location for the `--dev` profile under a given home. */
export function devStateDir(home: string = homedir()): string {
  return stateDirFor(null, home);
}

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The checkout this tool belongs to. Recorded in markers, never committed. */
export const CHECKOUT_DIR = realpathSync(join(TOOL_DIR, "../.."));
/** Run state for processes this tool started (PIDs, logs). Git-ignored. */
export const RUN_DIR = join(TOOL_DIR, ".run");

/**
 * The state folder must be the instance's own folder directly under the home:
 * `~/.openclaw-dev` or `~/.openclaw-clawtrate-dev-<name>`. Nothing else.
 */
export function assertInstanceStateDir(
  path: string,
  instance: string | null,
  home: string = homedir(),
): void {
  if (instance !== null) validateInstanceName(instance);
  if (path !== stateDirFor(instance, home) || dirname(path) !== home) {
    const expected = instance === null ? "~/.openclaw-dev" : `~/.openclaw-${profileFor(instance)}`;
    throw new Error(`refusing to use ${path}: this instance lives only in ${expected}`);
  }
}

/** The default instance's check, kept for its callers. */
export function assertDevStateDir(path: string, home: string = homedir()): void {
  assertInstanceStateDir(path, null, home);
}

/** Variables passed through from the caller's shell. Everything else is dropped. */
export const PASSTHROUGH_ENV = ["TMPDIR", "LANG", "LC_ALL", "TZ", "USER"] as const;

/**
 * The computer's own program folders: the only part of its `PATH` a gateway gets (#933). OpenClaw
 * asks an agent tool it finds on `PATH` for its sign-in, so a folder a person installs tools into
 * (`~/.local/bin`, Homebrew's) never reaches a gateway, nor anything the gateway starts.
 */
export const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

/**
 * The one way a folder of the caller's reaches a gateway's `PATH`: a test's stand-in programs. It
 * must be a folder inside the computer's temporary folder.
 */
export const STAND_INS_ENV = "DEV_GATEWAY_STAND_INS";

/** The stand-ins folder a test asked for, checked; or null. */
export function standInsDir(source: NodeJS.ProcessEnv): string | null {
  const asked = source[STAND_INS_ENV];
  if (!asked) return null;
  const dir = realpathSync(resolve(asked));
  const temp = realpathSync(tmpdir());
  if (!dir.startsWith(temp + sep) || !statSync(dir).isDirectory())
    throw new Error(`${STAND_INS_ENV} must name a folder inside ${temp}`);
  return dir;
}

/**
 * A folder holding one link, `node`, to the Node a gateway runs on: for a program that finds Node
 * by name, without the rest of the folder Node is installed in.
 */
export function nodeLinkDir(node: string, root: string = RUN_DIR): string {
  const target = realpathSync(node);
  const dir = join(root, "path", createHash("sha256").update(target).digest("hex").slice(0, 12));
  const link = join(dir, "node");
  mkdirSync(dir, { recursive: true });
  let current: string | null = null;
  try {
    current = readlinkSync(link);
  } catch {
    // No link yet.
  }
  if (current !== target) {
    if (current !== null) rmSync(link, { force: true });
    symlinkSync(target, link);
  }
  return dir;
}

/** A gateway's `PATH`: a test's stand-ins, the folder with its Node, the system's folders. */
export function gatewayPath(source: NodeJS.ProcessEnv, nodeDir: string | null = null): string {
  return [standInsDir(source), nodeDir, ...SYSTEM_PATH].filter(Boolean).join(":");
}

function passthrough(source: NodeJS.ProcessEnv, nodeDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (value) env[key] = value;
  }
  env.PATH = gatewayPath(source, nodeDir);
  return env;
}

/**
 * The whole environment OpenClaw runs with: an allowlist from the caller plus
 * the dev profile paths. Provider keys, tokens, base URLs and profile overrides
 * in the caller's shell never reach the gateway or the CLI.
 */
export function openclawEnv(
  source: NodeJS.ProcessEnv = process.env,
  instance: { name: string | null; stateDir: string; gatewayPort: number } = {
    name: null,
    stateDir: devStateDir(),
    gatewayPort: GATEWAY_PORT,
  },
  nodeDir: string | null = null,
): NodeJS.ProcessEnv {
  return {
    ...passthrough(source, nodeDir),
    ...(instance.name !== null && source.FS_SAFE_NATIVE_MODE === "require"
      ? { FS_SAFE_NATIVE_MODE: "require" }
      : {}),
    HOME: homedir(),
    OPENCLAW_PROFILE: profileFor(instance.name),
    OPENCLAW_STATE_DIR: instance.stateDir,
    OPENCLAW_CONFIG_PATH: join(instance.stateDir, "openclaw.json"),
    OPENCLAW_GATEWAY_PORT: String(instance.gatewayPort),
    NO_COLOR: "1",
  };
}

/** The scripted provider gets the allowlist and the port it listens on. */
export function providerEnv(
  source: NodeJS.ProcessEnv = process.env,
  port?: number,
): NodeJS.ProcessEnv {
  return port === undefined
    ? passthrough(source, null)
    : { ...passthrough(source, null), SCRIPTED_PROVIDER_PORT: String(port) };
}

/** The instance's profile options first; callers may never choose a profile themselves. */
export function guardArgs(args: string[], instance: string | null = null): string[] {
  if (
    args.some(
      (arg) =>
        arg === "--profile" ||
        arg.startsWith("--profile=") ||
        arg === "--dev" ||
        arg.startsWith("--dev="),
    )
  ) {
    throw new Error("the dev-gateway tool never selects another OpenClaw profile");
  }
  return [...profileArgs(instance), ...args];
}

export type RunResult = { status: number | null; stdout: string; stderr: string };

/** Thrown instead of spawning OpenClaw against absent, foreign or stale state. */
export class SpawnRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SpawnRefusedError";
  }
}

export type RunnerOptions = {
  /** The instance name; null or absent is the default instance. */
  instance?: string | null;
  stateDir: string;
  /** The tool's run file, with the run id and PIDs `start` recorded. */
  runFile: string;
  /** A stand-in OpenClaw program, for tests, taken as the pin; otherwise pinned.ts finds one. */
  bin?: string;
  spawnImpl?: typeof spawn;
  spawnSyncImpl?: typeof spawnSync;
  identify?: Identify;
  /** The checkout whose run file proves ownership. */
  checkout?: string;
};

/**
 * The single boundary for OpenClaw subprocesses. Before anything is spawned it
 * asks `spawnRefusal()` whether the state folder is the tool's own and belongs
 * to the running gateway (or to the start that is creating it).
 */
export class OpenclawRunner {
  /** Set by `start` while it prepares fresh state, before the gateway is running. */
  freshRunId: string | null = null;
  readonly instance: string | null;
  readonly stateDir: string;
  readonly runFile: string;
  private program: Program | null;
  private readonly spawnImpl: typeof spawn;
  private readonly spawnSyncImpl: typeof spawnSync;
  private readonly identify: Identify;
  private readonly checkout: string;

  constructor(options: RunnerOptions) {
    this.instance = options.instance ?? null;
    this.stateDir = options.stateDir;
    this.runFile = options.runFile;
    this.program = options.bin
      ? { command: options.bin, args: [], version: OPENCLAW_VERSION }
      : null;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
    this.identify = options.identify ?? processIdentity;
    this.checkout = options.checkout ?? CHECKOUT_DIR;
  }

  /** The OpenClaw program and its leading arguments: the pinned copy unless one was given. */
  private openclaw(): Program {
    this.program ??= openclawProgram();
    return this.program;
  }

  /**
   * The folder with the Node the gateway runs on: the pinned program's own Node, or, for an
   * `OPENCLAW_BIN` program that may find Node by name, `OPENCLAW_NODE` or this tool's Node.
   */
  private nodeDir(): string {
    const program = this.openclaw();
    const node =
      program.args.length > 0 ? program.command : (process.env.OPENCLAW_NODE ?? process.execPath);
    return nodeLinkDir(node);
  }

  /** The OpenClaw version this runner's program is, which the gateway it starts runs. */
  openclawVersion(): OpenclawVersion {
    return this.openclaw().version;
  }

  /** Why OpenClaw must not run now, or null. */
  refusal(): string | null {
    return spawnRefusal({
      stateDir: this.stateDir,
      run: readRunRecord(this.runFile),
      freshRunId: this.freshRunId,
      instance: this.instance,
      checkout: this.checkout,
      identify: this.identify,
    });
  }

  /** The gateway port: fixed for the default instance, from the accepted marker otherwise. */
  gatewayPort(): number {
    if (this.instance === null) return GATEWAY_PORT;
    const port = readMarker(this.stateDir)?.gatewayPort;
    if (port === undefined) throw new SpawnRefusedError(`${this.stateDir} records no gateway port`);
    return port;
  }

  private assertAllowed(): void {
    const reason = this.refusal();
    if (reason) throw new SpawnRefusedError(reason);
  }

  /**
   * OpenClaw also loads a `.env` from its working directory, so it always runs
   * inside the state folder the guard has just accepted.
   */
  private baseOptions() {
    const instance = {
      name: this.instance,
      stateDir: this.stateDir,
      gatewayPort: this.gatewayPort(),
    };
    return { cwd: this.stateDir, env: openclawEnv(process.env, instance, this.nodeDir()) };
  }

  /** Run an OpenClaw CLI command and wait for it. `input` is written to its stdin. */
  runSync(args: string[], options: { input?: string } = {}): RunResult {
    this.assertAllowed();
    const { command, args: lead } = this.openclaw();
    const result = this.spawnSyncImpl(command, [...lead, ...guardArgs(args, this.instance)], {
      ...this.baseOptions(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
  }

  /** Async variant, so several bots can be seeded at once. */
  run(args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.assertAllowed();
      const { command, args: lead } = this.openclaw();
      const child = this.spawnImpl(command, [...lead, ...guardArgs(args, this.instance)], {
        ...this.baseOptions(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  /** Start a long-running OpenClaw process detached from this one, behind a gate (`gatedSpawn`). */
  spawnGated(args: string[], options: SpawnOptions): Gated {
    this.assertAllowed();
    const { command, args: lead } = this.openclaw();
    return gatedSpawn(this.spawnImpl, command, [...lead, ...guardArgs(args, this.instance)], {
      ...options,
      ...this.baseOptions(),
      detached: true,
    });
  }

  /**
   * The scripted node host (`scripted-node.ts`): the same guard and profile,
   * with its own state folder inside the instance's, where it also runs.
   */
  spawnNodeGated(args: string[], env: NodeJS.ProcessEnv, options: SpawnOptions): Gated {
    this.assertAllowed();
    const base = this.baseOptions();
    const dir = env.OPENCLAW_STATE_DIR;
    if (typeof dir !== "string" || !dir.startsWith(`${this.stateDir}/`)) {
      throw new SpawnRefusedError("the node's state folder must be inside the instance's");
    }
    const { command, args: lead } = this.openclaw();
    return gatedSpawn(this.spawnImpl, command, [...lead, ...guardArgs(args, this.instance)], {
      ...options,
      cwd: dir,
      env: { ...base.env, ...env },
      detached: true,
    });
  }
}

/**
 * The shell a gated process starts as. It waits for one line on file
 * descriptor 3, then replaces itself with the real command, keeping its PID
 * and start time. If the pipe closes first, because the process that spawned
 * it died before recording it, it exits without running anything.
 */
export const GATE_SCRIPT = 'read -r _ <&3 || exit 70; exec "$0" "$@" 3<&-';

export type Gated = {
  child: ChildProcess;
  /** Let the command run. Called only once its PID and start time are recorded. */
  release(): void;
  /** Make it exit without running the command. */
  abort(): void;
};

/**
 * Spawn a command so that it cannot run before the caller has recorded it.
 * A spawn followed by a file write is not atomic against the caller being
 * killed; with the gate, a process the caller never recorded never runs.
 */
export function gatedSpawn(
  spawnFn: typeof spawn,
  command: string,
  args: string[],
  options: SpawnOptions,
): Gated {
  const base: unknown[] = Array.isArray(options.stdio)
    ? options.stdio
    : ["ignore", "ignore", "ignore"];
  const stdio = [base[0], base[1], base[2], "pipe"] as StdioOptions;
  const child: ChildProcess = spawnFn("/bin/sh", ["-c", GATE_SCRIPT, command, ...args], {
    ...options,
    stdio,
  });
  const gate = child.stdio[3] as Writable | null | undefined;
  // A gate that closes early only means the command does not run.
  gate?.on("error", () => {});
  return {
    child,
    // Closed once the line is written, so the gate never keeps this process alive.
    release: () => gate?.end("go\n", () => gate.destroy()),
    abort: () => gate?.destroy(),
  };
}

/** Where an instance lives: its OpenClaw state and this checkout's run files for it. */
export type InstancePaths = {
  name: string | null;
  stateDir: string;
  configPath: string;
  runDir: string;
  runFile: string;
  connectionFile: string;
};

export function instancePaths(
  name: string | null,
  options: { home?: string; runRoot?: string } = {},
): InstancePaths {
  const home = options.home ?? homedir();
  const stateDir = stateDirFor(name, home);
  assertInstanceStateDir(stateDir, name, home);
  const runDir = runDirFor(name, options.runRoot ?? RUN_DIR);
  return {
    name,
    stateDir,
    configPath: join(stateDir, "openclaw.json"),
    runDir,
    runFile: join(runDir, "state.json"),
    // Read by the preview host's `--dev-gateway` mode.
    connectionFile: join(runDir, "connection.json"),
  };
}

/** Parse the first JSON document in CLI output, tolerating leading log lines. */
export function parseJsonOutput<T>(text: string): T {
  const start = text.search(/^[[{]/m);
  if (start < 0) throw new Error(`expected JSON output, got: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}
