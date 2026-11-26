// The OpenClaw the development gateway runs (#597): the version this project tests against
// (docs/decisions.md), installed into this tool's own git-ignored folder, on a Node it supports.
// Never the `openclaw` on PATH: on a computer that runs its own gateway, that one is the person's
// own, at whatever version they last installed. OPENCLAW_BIN may name another copy of a version
// the tool runs (versions.ts), as CI's throwaway runners do; any other version is refused, not run.
//
//   pnpm dev-gateway setup   installs it; `pnpm dev-gateway start` does so too when it is missing

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withLock } from "./lock.ts";
import {
  isOpenclawVersion,
  OPENCLAW_VERSIONS,
  PINNED_OPENCLAW,
  type OpenclawVersion,
} from "./versions.ts";

/** The version `setup` installs, and the one every pull request tests. */
export const OPENCLAW_VERSION = PINNED_OPENCLAW;
/** The Node the pinned OpenClaw runs on when the one running this tool is outside its range. */
export const NODE_VERSION = "24.22.1";
/** Node's own published SHA-256 of each archive (nodejs.org/dist/v24.22.1/SHASUMS256.txt). */
const NODE_SHA256: Readonly<Record<string, string>> = {
  "darwin-arm64": "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
  "darwin-x64": "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
  "linux-arm64": "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
  "linux-x64": "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
};
/** This tool's own folder for them, next to its run state. */
export const PINNED_DIR = join(import.meta.dirname, "../.openclaw");

/** A program, the arguments that come before OpenClaw's own, and the OpenClaw version it is. */
export type Program = { command: string; args: string[]; version: OpenclawVersion };

/** Whether OpenClaw 2026.10.6 runs on a Node version: `>=24.22.1 <25 || >=26.12.1`. */
export function supportsNode(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, "").split(".").map(Number);
  const atLeast = (m: number, n: number, p: number) =>
    major !== m ? major > m : minor !== n ? minor > n : patch >= p;
  return (major === 24 && atLeast(24, 22, 1)) || atLeast(26, 12, 1);
}

const entryIn = (dir: string) =>
  join(dir, `openclaw-${OPENCLAW_VERSION}`, "node_modules", "openclaw", "openclaw.mjs");
const nodeIn = (dir: string) => join(dir, `node-${NODE_VERSION}`, "bin", "node");

/** The Node the pinned copy runs on: OPENCLAW_NODE, this one when it is in range, or the tool's. */
function nodeFor(env: NodeJS.ProcessEnv, dir: string, version: string, execPath: string): string {
  // An override is resolved here, once: OpenClaw runs from the instance's state folder, where a
  // relative path would name something else.
  if (env.OPENCLAW_NODE) return resolve(env.OPENCLAW_NODE);
  return supportsNode(version) ? execPath : nodeIn(dir);
}

/** The OpenClaw version of the package a program belongs to, from its package.json; or null. */
export function programVersion(bin: string): string | null {
  try {
    let dir = dirname(realpathSync(bin));
    for (let up = 0; up < 4; up += 1) {
      const file = join(dir, "package.json");
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "openclaw") return pkg.version ?? null;
      }
      dir = dirname(dir);
    }
  } catch {
    // No such program, or nothing readable beside it.
  }
  return null;
}

/** The OpenClaw program this tool runs. Throws, running nothing, when there is none it may run. */
export function openclawProgram(
  env: NodeJS.ProcessEnv = process.env,
  dir = PINNED_DIR,
  version = process.versions.node,
  execPath = process.execPath,
): Program {
  if (env.OPENCLAW_BIN) {
    // Resolved once, as OPENCLAW_NODE is: checked and run as the same absolute path.
    const bin = resolve(env.OPENCLAW_BIN);
    const found = programVersion(bin);
    if (!isOpenclawVersion(found))
      throw new Error(
        `OPENCLAW_BIN is OpenClaw ${found ?? "of a version this tool cannot read"}; the development gateway runs only ${OPENCLAW_VERSIONS.join(" or ")}. Unset it to use the copy \`pnpm dev-gateway setup\` installs.`,
      );
    return { command: bin, args: [], version: found };
  }
  const node = nodeFor(env, dir, version, execPath);
  if (!existsSync(entryIn(dir)) || !existsSync(node))
    throw new Error(
      `OpenClaw ${OPENCLAW_VERSION} is not set up for the development gateway. Run \`pnpm dev-gateway setup\`.`,
    );
  return { command: node, args: [entryIn(dir)], version: OPENCLAW_VERSION };
}

/** Whether `openclawProgram` has a program to give, without setting anything up. */
export function openclawReady(env: NodeJS.ProcessEnv = process.env, dir = PINNED_DIR): boolean {
  try {
    openclawProgram(env, dir);
    return true;
  } catch {
    return false;
  }
}

/** The archive name and its expected SHA-256 for this computer, or why there is none. */
export function nodeArchive(
  platform: string = process.platform,
  arch: string = process.arch,
): { name: string; sha256: string } {
  const sha256 = NODE_SHA256[`${platform}-${arch}`];
  if (!sha256)
    throw new Error(
      `No Node ${NODE_VERSION} for ${platform}-${arch} is known to this tool; set OPENCLAW_NODE to a Node it supports (>=24.22.1 <25 or >=26.12.1).`,
    );
  return { name: `node-v${NODE_VERSION}-${platform}-${arch}`, sha256 };
}

/**
 * What setup passes to npm, and so to the install scripts of OpenClaw's dependencies: the Node to
 * run first on PATH, the home folder, npm's own cache, registry and proxy settings, the proxy
 * variables, and the locale. No token or key from the caller's shell.
 */
export const SETUP_ENV = [
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "USER",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const;
const NPM_SETTING = /^npm_config_(?:cache|registry|proxy|https_proxy|noproxy|cafile|strict_ssl)$/i;

/** The environment setup runs npm and tar with, from the caller's: an allowlist, nothing else. */
export function setupEnv(source: NodeJS.ProcessEnv, nodeBin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: `${nodeBin}:${source.PATH ?? "/usr/bin:/bin"}` };
  for (const [key, value] of Object.entries(source))
    if (value && ((SETUP_ENV as readonly string[]).includes(key) || NPM_SETTING.test(key)))
      env[key] = value;
  return env;
}

/** A staging folder of this run's own: a run killed part-way never leaves one another reuses. */
export function stagingFor(dir: string, name: string): string {
  return join(dir, `${name}.partial-${process.pid}-${randomBytes(4).toString("hex")}`);
}

/** Remove the staging folders earlier runs left, finished or not. */
export function removeLeftovers(dir: string): void {
  for (const name of readdirSync(dir))
    if (/\.partial(?:-|$)/.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): void {
  const result = spawnSync(command, args, { env, cwd, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

/** Install Node, when this one is out of range, and then OpenClaw, each into a folder of its own. */
export async function setupOpenclaw(
  dir = PINNED_DIR,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await withLock(
    join(dir, "setup.lock"),
    async () => {
      removeLeftovers(dir);
      const node = nodeFor(env, dir, process.versions.node, process.execPath);
      // A Node named by OPENCLAW_NODE is the user's to provide; setup never stands in for it.
      if (env.OPENCLAW_NODE && !existsSync(node))
        throw new Error(`OPENCLAW_NODE names ${node}, which does not exist.`);
      if (!existsSync(node)) {
        const { name, sha256 } = nodeArchive();
        log(`Downloading Node ${NODE_VERSION} for OpenClaw ${OPENCLAW_VERSION}…`);
        const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`);
        if (!response.ok) throw new Error(`Node's download answered ${response.status}`);
        const archive = Buffer.from(await response.arrayBuffer());
        const got = createHash("sha256").update(archive).digest("hex");
        if (got !== sha256) throw new Error(`Node's download has SHA-256 ${got}, not ${sha256}`);
        const staging = stagingFor(dir, `node-${NODE_VERSION}`);
        mkdirSync(staging);
        const file = join(staging, "node.tar.gz");
        writeFileSync(file, archive);
        run(
          "tar",
          ["-xzf", file, "-C", staging, "--strip-components", "1"],
          setupEnv(env, "/usr/bin"),
        );
        rmSync(file);
        rmSync(join(dir, `node-${NODE_VERSION}`), { recursive: true, force: true });
        renameSync(staging, join(dir, `node-${NODE_VERSION}`));
      }
      if (!existsSync(entryIn(dir))) {
        log(`Installing OpenClaw ${OPENCLAW_VERSION} for the development gateway, in ${dir}…`);
        const staging = stagingFor(dir, `openclaw-${OPENCLAW_VERSION}`);
        mkdirSync(staging);
        run(
          "npm",
          [
            "install",
            "--prefix",
            staging,
            "--no-save",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            `openclaw@${OPENCLAW_VERSION}`,
          ],
          // npm and the install scripts run on the gateway's Node, with nothing secret.
          setupEnv(env, dirname(node)),
        );
        rmSync(join(dir, `openclaw-${OPENCLAW_VERSION}`), { recursive: true, force: true });
        renameSync(staging, join(dir, `openclaw-${OPENCLAW_VERSION}`));
      }
      log(`OpenClaw ${OPENCLAW_VERSION} is set up, on Node at ${node}.`);
    },
    { timeoutMs: 15 * 60_000, what: "the OpenClaw setup lock" },
  );
}
