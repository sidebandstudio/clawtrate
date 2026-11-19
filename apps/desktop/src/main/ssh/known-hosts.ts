// Host keys as bytes: a known-hosts line read and checked, its fingerprint
// computed from the key bytes themselves, and the app's own known-hosts file,
// where a route's alias is pinned to exactly one key. The person's own
// known-hosts file is only ever read, never written.

import { createHash } from "node:crypto";
import { readOwn, UnsafeAppFile, writeOwn } from "./app-files.ts";
import { ENDPOINT, ROUTE_ALIAS } from "./destination.ts";

import { MAX_HOST_KEY_CHARS } from "@clawtrate/core";

const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024;

export type HostKey = {
  /** The algorithm, such as "ssh-ed25519". */
  type: string;
  /** The key blob, base64 as in a known-hosts line. */
  key: string;
  /** `SHA256:` and 43 base64 characters, computed from the blob. */
  fingerprint: string;
};

/** The label shown over a fingerprint: "ED25519", "RSA", "ECDSA". */
export function keyLabel(type: string): string {
  if (type.includes("ed25519")) return "ED25519";
  if (type.includes("ecdsa")) return "ECDSA";
  if (type === "ssh-rsa") return "RSA";
  return "KEY";
}

/** The fingerprint `ssh-keygen -l` prints for a key blob. */
export function fingerprintOf(base64Key: string): string {
  const blob = Buffer.from(base64Key, "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** A literal key in a known-hosts line, or null for a marker line, a comment or anything malformed. */
export function parseKnownHostsLine(raw: string): (HostKey & { hosts: string }) | null {
  const line = raw.replace(/\r$/, "").trim();
  if (line === "" || line.startsWith("#") || line.startsWith("@")) return null;
  const fields = line.split(/\s+/);
  if (fields.length < 3) return null;
  const [hosts, type, key] = fields as [string, string, string];
  if (!KEY_TYPES.has(type)) return null;
  if (key.length > MAX_HOST_KEY_CHARS || !/^[A-Za-z0-9+/]{16,}={0,2}$/.test(key)) return null;
  // The blob names its own type first; a line whose blob says otherwise is not a key of that type.
  const blob = Buffer.from(key, "base64");
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length > blob.length - 4 || blob.subarray(4, 4 + length).toString("latin1") !== type) {
    return null;
  }
  return { hosts, type, key, fingerprint: fingerprintOf(key) };
}

/** Line `number` (from 1) of a known-hosts text, as a pinnable literal key, or null. */
export function literalKeyAt(text: string, number: number): HostKey | null {
  const line = text.split("\n")[number - 1];
  if (line === undefined) return null;
  const parsed = parseKnownHostsLine(line);
  if (!parsed) return null;
  return { type: parsed.type, key: parsed.key, fingerprint: parsed.fingerprint };
}

export type Pin = HostKey & { alias: string; endpoint: string; pinnedAt: string };

const PIN_COMMENT = /^endpoint=(\S{1,330}) pinned=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,12}Z)$/;

/** The app's own known-hosts file: one line per route alias, with the endpoint and date as its comment. */
export class AppKnownHosts {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private readLines(): string[] {
    const text = readOwn(this.path, MAX_KNOWN_HOSTS_BYTES);
    return text === null ? [] : text.split("\n").filter((line) => line.trim() !== "");
  }

  /**
   * The pin of `alias`, only when it was made for `endpoint`. A line under the
   * alias for another endpoint, or with no endpoint, is not trusted: it is
   * reported as an unsafe file.
   */
  get(alias: string, endpoint: string): Pin | null {
    for (const line of this.readLines()) {
      const parsed = parseKnownHostsLine(line);
      if (!parsed || parsed.hosts !== alias) continue;
      const comment = PIN_COMMENT.exec(line.trim().split(/\s+/).slice(3).join(" "));
      if (!comment || comment[1] !== endpoint) {
        throw new UnsafeAppFile("A pin in the app's known-hosts file names another endpoint.");
      }
      return {
        alias,
        type: parsed.type,
        key: parsed.key,
        fingerprint: parsed.fingerprint,
        endpoint,
        pinnedAt: comment[2]!,
      };
    }
    return null;
  }

  /** Pins `key` under `alias`; with `replace` false, a pin already there is an error. */
  pin(alias: string, key: HostKey, endpoint: string, now: Date, replace: boolean): Pin {
    if (!ROUTE_ALIAS.test(alias)) throw new Error("Not a route alias.");
    if (!ENDPOINT.test(endpoint)) throw new Error("Not an endpoint.");
    const lines = this.readLines();
    const others = lines.filter((line) => parseKnownHostsLine(line)?.hosts !== alias);
    if (others.length !== lines.length && !replace)
      throw new Error("This route already has a pin.");
    if (others.length === lines.length && replace)
      throw new Error("This route has no pin to replace.");
    const pinnedAt = now.toISOString();
    const line = `${alias} ${key.type} ${key.key} endpoint=${endpoint} pinned=${pinnedAt}`;
    const parsed = parseKnownHostsLine(line);
    if (!parsed || parsed.fingerprint !== key.fingerprint)
      throw new Error("The key does not match.");
    writeOwn(this.path, [...others, line].join("\n") + "\n");
    return { alias, ...key, endpoint, pinnedAt };
  }

  /** Removes every pin whose alias `matches`. */
  removeWhere(matches: (alias: string) => boolean): void {
    const lines = this.readLines();
    const others = lines.filter((line) => {
      const hosts = parseKnownHostsLine(line)?.hosts;
      return hosts === undefined || !matches(hosts);
    });
    if (others.length === lines.length) return;
    writeOwn(this.path, others.length ? others.join("\n") + "\n" : "");
  }
}
