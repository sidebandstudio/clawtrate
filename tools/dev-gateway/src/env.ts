// Paths, ports and the one guarded way to run the OpenClaw CLI against the
// development profile. Every `openclaw` subprocess in this repo goes through an
// `OpenclawRunner`, which checks the state folder first (state-guard.ts) and
// always passes `--dev` and a scrubbed environment.

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive, readRunRecord, spawnRefusal } from "./state-guard.ts";

export const GATEWAY_PORT = 19001;
export const GATEWAY_URL = `ws://127.0.0.1:${GATEWAY_PORT}`;
export const PROVIDER_PORT = 19091;
export const PROVIDER_ID = "scripted";
export const MODEL_ID = "dev-1";
export const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;

/** OpenClaw's own location for the `--dev` profile under a given home. */
export function devStateDir(home: string = homedir()): string {
  return join(home, ".openclaw-dev");
}

/** OpenClaw's own location for the `--dev` profile. Nothing else is touched. */
export const DEV_STATE_DIR = devStateDir();
export const DEV_CONFIG_PATH = join(DEV_STATE_DIR, "openclaw.json");

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Run state for processes this tool started (PIDs, logs). Git-ignored. */
export const RUN_DIR = join(TOOL_DIR, ".run");
export const STATE_FILE = join(RUN_DIR, "state.json");
/** Read by the preview host's `--dev-gateway` mode. */
export const CONNECTION_FILE = join(RUN_DIR, "connection.json");

export function assertDevStateDir(path: string, home: string = homedir()): void {
  if (basename(path) !== ".openclaw-dev" || dirname(path) !== home) {
    throw new Error(
      `refusing to use ${path}: the development gateway lives only in ~/.openclaw-dev`,
    );
  }
}
assertDevStateDir(DEV_STATE_DIR);

/** Variables passed through from the caller's shell. Everything else is dropped. */
export const PASSTHROUGH_ENV = ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "USER"] as const;

function passthrough(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (value) env[key] = value;
  }
  env.PATH ??= "/usr/bin:/bin";
  return env;
}

/**
 * The whole environment OpenClaw runs with: an allowlist from the caller plus
 * the dev profile paths. Provider keys, tokens, base URLs and profile overrides
 * in the caller's shell never reach the gateway or the CLI.
 */
export function openclawEnv(
  source: NodeJS.ProcessEnv = process.env,
  stateDir: string = DEV_STATE_DIR,
): NodeJS.ProcessEnv {
  return {
    ...passthrough(source),
    HOME: homedir(),
    OPENCLAW_PROFILE: "dev",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
    OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
    NO_COLOR: "1",
  };
}

/** The scripted provider needs nothing from the caller beyond the allowlist. */
export function providerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return passthrough(source);
}

const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";

function guardArgs(args: string[]): string[] {
  if (args.some((arg) => arg === "--profile" || arg.startsWith("--profile="))) {
    throw new Error("the dev-gateway tool never selects another OpenClaw profile");
  }
  return ["--dev", ...args];
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
  stateDir: string;
  /** The tool's run file, with the run id and PIDs `start` recorded. */
  runFile: string;
  bin?: string;
  spawnImpl?: typeof spawn;
  spawnSyncImpl?: typeof spawnSync;
  isAlive?: (pid: number | undefined) => boolean;
};

/**
 * The single boundary for OpenClaw subprocesses. Before anything is spawned it
 * asks `spawnRefusal()` whether the state folder is the tool's own and belongs
 * to the running gateway (or to the start that is creating it).
 */
export class OpenclawRunner {
  /** Set by `start` while it prepares fresh state, before the gateway is running. */
  freshRunId: string | null = null;
  readonly stateDir: string;
  readonly runFile: string;
  private readonly bin: string;
  private readonly spawnImpl: typeof spawn;
  private readonly spawnSyncImpl: typeof spawnSync;
  private readonly alive: (pid: number | undefined) => boolean;

  constructor(options: RunnerOptions) {
    this.stateDir = options.stateDir;
    this.runFile = options.runFile;
    this.bin = options.bin ?? OPENCLAW_BIN;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
    this.alive = options.isAlive ?? isAlive;
  }

  /** Why OpenClaw must not run now, or null. */
  refusal(): string | null {
    return spawnRefusal({
      stateDir: this.stateDir,
      run: readRunRecord(this.runFile),
      freshRunId: this.freshRunId,
      isAlive: this.alive,
    });
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
    return { cwd: this.stateDir, env: openclawEnv(process.env, this.stateDir) };
  }

  /** Run an OpenClaw CLI command and wait for it. */
  runSync(args: string[]): RunResult {
    this.assertAllowed();
    const result = this.spawnSyncImpl(this.bin, guardArgs(args), {
      ...this.baseOptions(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
  }

  /** Async variant, so several bots can be seeded at once. */
  run(args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.assertAllowed();
      const child = this.spawnImpl(this.bin, guardArgs(args), {
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

  /** Start a long-running OpenClaw process detached from this one. */
  spawnDetached(args: string[], options: SpawnOptions) {
    this.assertAllowed();
    return this.spawnImpl(this.bin, guardArgs(args), {
      ...options,
      ...this.baseOptions(),
      detached: true,
    });
  }
}

/** The runner for the real development profile. */
export const defaultRunner = new OpenclawRunner({ stateDir: DEV_STATE_DIR, runFile: STATE_FILE });

/** Parse the first JSON document in CLI output, tolerating leading log lines. */
export function parseJsonOutput<T>(text: string): T {
  const start = text.search(/^[[{]/m);
  if (start < 0) throw new Error(`expected JSON output, got: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}
