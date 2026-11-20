// The app-data privacy check that comes before any SSH transport is made
// (docs/design/setup.md §2 rule 3; docs/decisions.md, "SSH to another
// computer"): the folder the host keeps its SSH files in, and every folder
// above it, must be ones no other account can redirect. OpenSSH reopens the
// configuration and known-hosts paths by name, so a folder another account can
// replace or rename under the host would let it change what `ssh` reads.
//
// On macOS and Linux each folder from the app's SSH folder up to the root must
// be a real folder (no link), owned by this account or by root, and not
// writable by group or others, except a sticky folder (such as /tmp), whose
// entries only their owners can rename or remove, when the folder below it is
// this account's own. The leaf, and every folder this account owns on the way,
// must also be closed to group and others. A path that resolves elsewhere than
// it is spelt, or anything else, is not established, and SSH setup goes to
// Advanced. Windows relies on the app-data folder's inherited access controls,
// which this check does not verify, and says so.

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type PrivateDirVerdict =
  | { ok: true; verified: "posix" | "windows-unverified" }
  | {
      ok: false;
      reason:
        | "not-absolute"
        | "resolves-elsewhere"
        | "missing"
        | "link"
        | "not-a-folder"
        | "another-account"
        | "writable-by-others"
        | "outside-root";
      /** The folder that failed, for the host's log only; never shown. */
      at: string;
    };

const STICKY = 0o1000;

/**
 * Whether `dir` and its ancestors are private to this account (see above).
 * `root`, for tests, is a synthetic top: the walk stops there instead of at
 * `/`, and a `dir` that resolves outside it is `outside-root`.
 */
export function establishPrivateDir(
  dir: string,
  options: { uid?: number | null; platform?: NodeJS.Platform; root?: string } = {},
): PrivateDirVerdict {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { ok: true, verified: "windows-unverified" };
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (uid === null) return { ok: false, reason: "another-account", at: dir };
  if (!isAbsolute(dir)) return { ok: false, reason: "not-absolute", at: dir };
  const spelt = resolve(dir);
  let real: string;
  try {
    real = realpathSync(spelt);
  } catch {
    return { ok: false, reason: "missing", at: spelt };
  }
  // No link anywhere in the path: it resolves exactly as it is spelt.
  if (real !== spelt) return { ok: false, reason: "resolves-elsewhere", at: spelt };
  let top = "/";
  if (options.root !== undefined) {
    let root: string;
    try {
      root = realpathSync(options.root);
    } catch {
      return { ok: false, reason: "missing", at: options.root };
    }
    if (real !== root && !real.startsWith(root.endsWith("/") ? root : `${root}/`))
      return { ok: false, reason: "outside-root", at: real };
    top = root;
  }
  let current = real;
  let below: { uid: number } | null = null;
  for (;;) {
    let info;
    try {
      info = lstatSync(current);
    } catch {
      return { ok: false, reason: "missing", at: current };
    }
    if (info.isSymbolicLink()) return { ok: false, reason: "link", at: current };
    if (!info.isDirectory()) return { ok: false, reason: "not-a-folder", at: current };
    const leaf = below === null;
    if (info.uid !== uid && info.uid !== 0)
      return { ok: false, reason: "another-account", at: current };
    // The leaf is this account's own and closed to everyone else.
    if (leaf && (info.uid !== uid || (info.mode & 0o077) !== 0))
      return {
        ok: false,
        reason: info.uid !== uid ? "another-account" : "writable-by-others",
        at: current,
      };
    const othersWrite = (info.mode & 0o022) !== 0;
    if (othersWrite) {
      // A sticky folder lets others make entries, never rename or remove this account's own.
      const stickyOverOwn = (info.mode & STICKY) !== 0 && below !== null && below.uid === uid;
      if (!stickyOverOwn) return { ok: false, reason: "writable-by-others", at: current };
    }
    if (current === top) return { ok: true, verified: "posix" };
    const parent = dirname(current);
    if (parent === current) return { ok: true, verified: "posix" };
    below = info;
    current = parent;
  }
}

/**
 * The host's boundary: `make` builds the SSH transport only after `dir` and
 * its ancestors are established as private; otherwise nothing is made and SSH
 * setup goes to Advanced.
 */
export function afterPrivacyCheck<T>(
  dir: string,
  make: () => T,
  options: { uid?: number | null; platform?: NodeJS.Platform; root?: string; log?: (line: string) => void } = {},
): T | { refused: "app-files-unsafe" } {
  const verdict = establishPrivateDir(dir, options);
  if (!verdict.ok) {
    options.log?.(`[setup] The app's SSH folder isn't proven private (${verdict.reason}).`);
    return { refused: "app-files-unsafe" };
  }
  return make();
}
