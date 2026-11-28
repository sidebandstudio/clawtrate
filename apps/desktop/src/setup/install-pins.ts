// What setting OpenClaw up downloads, and the fingerprints it checks them
// against (docs/design/setup.md §10, docs/research/setup-flow.md §6.8). They
// are constants of this build: an install takes nothing else from the network
// before its hashes match, and a download that doesn't match stops it.

import { INSTALL_NODE_VERSION, INSTALL_OPENCLAW_VERSION } from "@clawtrate/core";

/** A system the install supports: macOS and glibc Linux, on Apple silicon, arm64 and x64. */
export type InstallTarget = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

export type InstallPins = {
  version: string;
  /** OpenClaw's npm tarball and its published `sha512` integrity. */
  openclaw: { url: string; integrity: string };
  nodeVersion: string;
  /** Node.js for each system and its published SHA-256 (nodejs.org's `SHASUMS256.txt`). */
  node: Record<InstallTarget, { url: string; sha256: string }>;
};

const nodeUrl = (target: InstallTarget) =>
  `https://nodejs.org/dist/v${INSTALL_NODE_VERSION}/node-v${INSTALL_NODE_VERSION}-${target}.tar.gz`;

/**
 * OpenClaw 2026.11.10 and Node.js 24.22.1, the Node.js its installer defaults to
 * (`DEFAULT_NODE_VERSION` in `install-cli.sh`). The tarball's integrity is the registry's
 * `dist.integrity`, checked against the tarball itself; Node.js's are nodejs.org's
 * `SHASUMS256.txt`.
 */
export const PINS: InstallPins = {
  version: INSTALL_OPENCLAW_VERSION,
  openclaw: {
    url: `https://registry.npmjs.org/openclaw/-/openclaw-${INSTALL_OPENCLAW_VERSION}.tgz`,
    integrity:
      "sha512-/FKDjxY1ZdUSXHx1a9b4EUpPRZywM3uv4181g22XImJfp/5+h+fFUZ7B7HthNrdYzq//05zH0Yf7mefzIlWFaQ==",
  },
  nodeVersion: INSTALL_NODE_VERSION,
  node: {
    "darwin-arm64": {
      url: nodeUrl("darwin-arm64"),
      sha256: "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
    },
    "darwin-x64": {
      url: nodeUrl("darwin-x64"),
      sha256: "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
    },
    "linux-arm64": {
      url: nodeUrl("linux-arm64"),
      sha256: "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
    },
    "linux-x64": {
      url: nodeUrl("linux-x64"),
      sha256: "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
    },
  },
};

/**
 * The system this computer is, when the install supports it: macOS, or Linux
 * with glibc (the installer uses the system's `apk` on musl, §6.8), on arm64
 * or x64. Null anywhere else, and then setting up isn't offered.
 */
export function installTarget(
  platform: NodeJS.Platform,
  arch: string,
  glibc: boolean,
): InstallTarget | null {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `darwin-${cpu}`;
  if (platform === "linux" && glibc) return `linux-${cpu}`;
  return null;
}

/** Whether this Node.js runs on glibc: its report names the runtime's glibc version only there. */
export function runsOnGlibc(): boolean {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  return typeof report?.header?.glibcVersionRuntime === "string";
}
