// Paths, ports and the guarded way to run the OpenClaw CLI against the
// development profile. Every `openclaw` invocation in this repo goes through
// `openclaw()` below, which always passes `--dev` and a scrubbed environment.

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GATEWAY_PORT = 19001;
export const GATEWAY_URL = `ws://127.0.0.1:${GATEWAY_PORT}`;
export const PROVIDER_PORT = 19091;
export const PROVIDER_ID = "scripted";
export const MODEL_ID = "dev-1";
export const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;

/** OpenClaw's own location for the `--dev` profile. Nothing else is touched. */
export const DEV_STATE_DIR = join(homedir(), ".openclaw-dev");
export const DEV_CONFIG_PATH = join(DEV_STATE_DIR, "openclaw.json");

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Run state for processes this tool started (PIDs, logs). Git-ignored. */
export const RUN_DIR = join(TOOL_DIR, ".run");
export const STATE_FILE = join(RUN_DIR, "state.json");
/** Read by the preview host's `--dev-gateway` mode. */
export const CONNECTION_FILE = join(RUN_DIR, "connection.json");

export function assertDevStateDir(path: string): void {
  if (basename(path) !== ".openclaw-dev" || dirname(path) !== homedir()) {
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
export function openclawEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...passthrough(source),
    HOME: homedir(),
    OPENCLAW_PROFILE: "dev",
    OPENCLAW_STATE_DIR: DEV_STATE_DIR,
    OPENCLAW_CONFIG_PATH: DEV_CONFIG_PATH,
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

/** Run an OpenClaw CLI command against the development profile and wait for it. */
export function openclawSync(args: string[], options: { input?: string } = {}): RunResult {
  const result = spawnSync(OPENCLAW_BIN, guardArgs(args), {
    env: openclawEnv(),
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Async variant, so several bots can be seeded at once. */
export function openclaw(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_BIN, guardArgs(args), {
      env: openclawEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Start a long-running OpenClaw process detached from this one. */
export function spawnOpenclawDetached(args: string[], options: SpawnOptions) {
  return spawn(OPENCLAW_BIN, guardArgs(args), { ...options, env: openclawEnv(), detached: true });
}

/** Parse the first JSON document in CLI output, tolerating leading log lines. */
export function parseJsonOutput<T>(text: string): T {
  const start = text.search(/^[[{]/m);
  if (start < 0) throw new Error(`expected JSON output, got: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}
