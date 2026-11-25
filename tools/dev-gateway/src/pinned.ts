// The OpenClaw the development gateway runs (#597): the version this project tests against
// (docs/decisions.md), installed into this tool's own git-ignored folder, on a Node it supports.
// Never the `openclaw` on PATH: on a computer that runs its own gateway, that one is the person's
// own, at whatever version they last installed. OPENCLAW_BIN may name another copy of the same
// version, as CI's throwaway runners do; any other version is refused, not run.
//
//   pnpm dev-gateway setup   installs it; `pnpm dev-gateway start` does so too when it is missing

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { withLock } from "./lock.ts";

export const OPENCLAW_VERSION = "2026.10.6";
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

/** A program and the arguments that come before OpenClaw's own. */
export type Program = { command: string; args: string[] };

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
  return env.OPENCLAW_NODE || (supportsNode(version) ? execPath : nodeIn(dir));
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
    const found = programVersion(env.OPENCLAW_BIN);
    if (found !== OPENCLAW_VERSION)
      throw new Error(
        `OPENCLAW_BIN is OpenClaw ${found ?? "of a version this tool cannot read"}; the development gateway runs only ${OPENCLAW_VERSION}. Unset it to use the copy \`pnpm dev-gateway setup\` installs.`,
      );
    return { command: env.OPENCLAW_BIN, args: [] };
  }
  const node = nodeFor(env, dir, version, execPath);
  if (!existsSync(entryIn(dir)) || !existsSync(node))
    throw new Error(
      `OpenClaw ${OPENCLAW_VERSION} is not set up for the development gateway. Run \`pnpm dev-gateway setup\`.`,
    );
  return { command: node, args: [entryIn(dir)] };
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
      const node = nodeFor(env, dir, process.versions.node, process.execPath);
      if (!existsSync(node)) {
        const { name, sha256 } = nodeArchive();
        log(`Downloading Node ${NODE_VERSION} for OpenClaw ${OPENCLAW_VERSION}…`);
        const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`);
        if (!response.ok) throw new Error(`Node's download answered ${response.status}`);
        const archive = Buffer.from(await response.arrayBuffer());
        const got = createHash("sha256").update(archive).digest("hex");
        if (got !== sha256) throw new Error(`Node's download has SHA-256 ${got}, not ${sha256}`);
        const staging = join(dir, `node-${NODE_VERSION}.partial`);
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging);
        const file = join(staging, "node.tar.gz");
        writeFileSync(file, archive);
        run("tar", ["-xzf", file, "-C", staging, "--strip-components", "1"], env);
        rmSync(file);
        rmSync(join(dir, `node-${NODE_VERSION}`), { recursive: true, force: true });
        renameSync(staging, join(dir, `node-${NODE_VERSION}`));
      }
      if (!existsSync(entryIn(dir))) {
        log(`Installing OpenClaw ${OPENCLAW_VERSION} for the development gateway, in ${dir}…`);
        const staging = join(dir, `openclaw-${OPENCLAW_VERSION}.partial`);
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging);
        // npm and OpenClaw's own install scripts run on the Node the gateway will run on.
        const path = `${dirname(node)}:${env.PATH ?? ""}`;
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
          { ...env, PATH: path },
        );
        rmSync(join(dir, `openclaw-${OPENCLAW_VERSION}`), { recursive: true, force: true });
        renameSync(staging, join(dir, `openclaw-${OPENCLAW_VERSION}`));
      }
      log(`OpenClaw ${OPENCLAW_VERSION} is set up, on Node at ${node}.`);
    },
    { timeoutMs: 15 * 60_000, what: "the OpenClaw setup lock" },
  );
}
