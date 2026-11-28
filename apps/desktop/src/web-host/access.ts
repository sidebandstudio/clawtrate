// Private mode's access: one secret kept in the host's data folder, and the
// browser session it signs. The secret never goes to a browser; a signed-in
// browser holds only a session that names its expiry and the secret's MAC of it.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isIPv4 } from "node:net";
import { join } from "node:path";

export const ACCESS_SECRET_FILE = "access-secret";
/** How long a browser stays signed in, in seconds; the session itself carries its expiry. */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
/** Largest sign-in form body read, in bytes. The form has one field of 43 characters. */
export const MAX_AUTH_BODY_BYTES = 1024;
/** Sign-in attempts accepted per window, from everyone together, right or wrong. */
export const MAX_AUTH_ATTEMPTS = 10;
export const AUTH_WINDOW_MS = 60_000;

export type PrivateAccess = { secret: string; publicOrigin: string | null };

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function privateFolder(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const folder = lstatSync(dataDir);
  if (!folder.isDirectory()) throw new Error(`${dataDir} is not a folder.`);
  if ((folder.mode & 0o077) !== 0)
    throw new Error(`${dataDir} must be readable by its owner only (chmod 700).`);
}

function writeSecret(path: string, secret: string): void {
  // A fresh exclusive file, then a rename: a reader sees the old secret or the new one, never part of one.
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${secret}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readSecret(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP")
      throw new Error(`${path} is a link; private mode does not follow it.`, { cause: error });
    throw error;
  }
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) throw new Error(`${path} is not a regular file.`);
    if ((file.mode & 0o077) !== 0)
      throw new Error(`${path} must be readable by its owner only (chmod 600).`);
    const secret = readFileSync(fd, "utf8").trim();
    if (!SECRET_SHAPE.test(secret)) throw new Error(`${path} does not hold an access secret.`);
    return secret;
  } finally {
    closeSync(fd);
  }
}

/**
 * The private host's secret from `<dataDir>/access-secret`, created when there
 * is none and replaced when `rotate` is set. `created` says it is new, so it is
 * shown once.
 */
export function loadAccessSecret(
  dataDir: string,
  rotate = false,
): { secret: string; created: boolean } {
  privateFolder(dataDir);
  const path = join(dataDir, ACCESS_SECRET_FILE);
  const existing = readSecret(path);
  if (existing !== null && !rotate) return { secret: existing, created: false };
  const secret = randomBytes(32).toString("base64url");
  writeSecret(path, secret);
  return { secret, created: true };
}

function mac(secret: string, expires: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(`clawtrate-web-session:${expires}`)
    .digest("base64url");
}

export function signSession(secret: string, now = Date.now()): string {
  const expires = String(Math.floor(now / 1000) + SESSION_MAX_AGE_S);
  return `${expires}.${mac(secret, expires)}`;
}

/** When a valid session expires, in milliseconds, or null when it is not valid now. */
export function verifySession(secret: string, session: string, now = Date.now()): number | null {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(session);
  if (!match) return null;
  const [, expires, given] = match;
  const end = Number(expires) * 1000;
  return end > now && safeEqual(given!, mac(secret, expires!)) ? end : null;
}

/** Counts sign-in attempts in fixed windows; `allow` is false once a window's are used up. */
export function createAttemptLimit(max = MAX_AUTH_ATTEMPTS, windowMs = AUTH_WINDOW_MS) {
  let windowStart = 0;
  let attempts = 0;
  return {
    allow(now = Date.now()): boolean {
      if (now - windowStart >= windowMs) {
        windowStart = now;
        attempts = 0;
      }
      if (attempts >= max) return false;
      attempts += 1;
      return true;
    },
  };
}

function loopback(host: string): boolean {
  return (isIPv4(host) && host.startsWith("127.")) || host === "::1";
}

export type ListenFlags = {
  private: boolean;
  host?: string;
  "public-origin"?: string;
  "rotate-access-secret": boolean;
  "no-access-token": boolean;
  "dev-gateway": boolean;
  "setup-look": boolean;
};

/**
 * Where the host listens, and private mode's public origin. Private mode
 * listens on loopback only, because the host speaks plain HTTP: a browser on
 * another machine reaches it through an SSH tunnel or an HTTPS proxy on this one.
 */
export function listenChoice(
  flags: ListenFlags,
  platform: NodeJS.Platform = process.platform,
): { host: string; publicOrigin: string | null } {
  if (!flags.private) {
    for (const flag of ["public-origin", "rotate-access-secret"] as const) {
      if (flags[flag]) throw new Error(`--${flag} is only allowed with --private.`);
    }
    return { host: flags.host ?? "0.0.0.0", publicOrigin: null };
  }
  for (const flag of ["no-access-token", "dev-gateway", "setup-look"] as const) {
    if (flags[flag]) throw new Error(`--private cannot be used with --${flag}.`);
  }
  // Node makes up a Windows file's group and other bits, so the owner-only checks on the
  // secret prove nothing there, and this host has no access-list check to take their place.
  if (platform === "win32") {
    throw new Error(
      "--private is not available on Windows yet: it cannot check that only you can read the access secret.",
    );
  }
  const host = flags.host ?? "127.0.0.1";
  if (!loopback(host)) {
    throw new Error(
      `--private listens on plain HTTP, so it binds only to loopback (127.0.0.1 or ::1), not ${host}. ` +
        "Reach it through an SSH tunnel, or an HTTPS proxy on this machine named with --public-origin.",
    );
  }
  const given = flags["public-origin"];
  if (given === undefined) return { host, publicOrigin: null };
  const url = URL.canParse(given) ? new URL(given) : null;
  if (!url || url.protocol !== "https:" || url.origin !== given) {
    throw new Error(`--public-origin must be https://host or https://host:port, not ${given}.`);
  }
  return { host, publicOrigin: url.origin };
}
