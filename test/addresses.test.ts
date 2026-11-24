// The repository is public: no tracked file may carry a private-range
// address literal, or a home-directory path. Documentation ranges and the unspecified address are
// fine as synthetic fixtures; a test that needs a private address builds it
// from its parts at run time.

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

const IPV4 = /(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9])/g;
// Link-local IPv6 (the fe80 /10 prefix) and unique-local IPv6 (the fc00 /7 prefix), written with at least two more groups.
const IPV6 =
  /(?<![0-9a-z:])(?:fe[89ab][0-9a-f]|f[cd][0-9a-f]{2})(?::[0-9a-f]{0,4}){2,7}(?![0-9a-z:])/gi;

/** Whether a dotted quad is in 10/8, 172.16/12, 192.168/16, 100.64/10 or 169.254/16. */
export function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts as [number, number];
  if (parts.some((n) => n > 255)) return false;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

/** The private-range address literals in `text`. */
export function privateAddresses(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IPV4)) {
    if (isPrivateIpv4(match.slice(1, 5).map(Number))) found.push(match[0]);
  }
  for (const match of text.matchAll(IPV6)) found.push(match[0]);
  return found;
}

/** A home-directory path (under /home or /Users) in `text`. */
const HOME_PATH = /(?<![A-Za-z0-9_.~-])\/(?:home|Users)\/[A-Za-z0-9_.-]+/g;

/**
 * Home-directory paths already in the repository from other work, each a
 * made-up fixture; nothing new may join them.
 */
const home = (name: string) => ["", "home", name].join("/");
const KNOWN_HOME_PATHS = new Set([
  `docs/design/prototype/js/kinds.js: ${home("bot")}`,
  `tools/dev-gateway/test/instances.test.ts: ${home("x")}`,
]);

describe("tracked files", () => {
  it("recognizes each private range, and leaves documentation, loopback and unspecified addresses", () => {
    const join4 = (...parts: number[]) => parts.join(".");
    for (const address of [
      join4(10, 1, 2, 3),
      join4(172, 16, 0, 1),
      join4(172, 31, 255, 1),
      join4(192, 168, 1, 1),
      join4(100, 64, 0, 1),
      join4(169, 254, 1, 1),
      ["fe80", "", "1"].join(":"),
      ["fd12", "3456", "", "1"].join(":"),
    ]) {
      expect(privateAddresses(`at ${address} here`), address).toEqual([address]);
    }
    for (const address of [
      "127.0.0.1",
      "0.0.0.0",
      "192.0.2.1",
      "198.51.100.7",
      "203.0.113.9",
      "172.32.0.1",
      "100.128.0.1",
      "2001:db8::1",
      "::1",
      "1.10.0.0.1",
    ]) {
      expect(privateAddresses(`at ${address} here`), address).toEqual([]);
    }
  });

  // Reads every tracked text file, about 19 MB in 1,000 files: a fraction of a second idle, and
  // several seconds when a full run shares a busy machine.
  it("carry no private-range address literal and no new home-directory path", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    // Git's own test: a NUL in the first 8,000 bytes makes a file binary. It spares reading the
    // 250 MB of screenshots and visual baselines whole.
    const head = Buffer.alloc(8000);
    for (const file of files) {
      let fd: number;
      try {
        fd = openSync(join(ROOT, file), "r");
      } catch {
        continue; // deleted in the working tree
      }
      let text: string;
      try {
        if (head.subarray(0, readSync(fd, head, 0, head.length, 0)).includes(0)) continue;
        text = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
      for (const address of privateAddresses(text)) {
        found.push(`${file}: ${address}`);
      }
      for (const match of text.matchAll(HOME_PATH)) {
        if (!KNOWN_HOME_PATHS.has(`${file}: ${match[0]}`)) found.push(`${file}: ${match[0]}`);
      }
    }
    expect(found).toEqual([]);
  }, 30_000);
});
