import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_BYTES = 256 * 1024;
export const MAX_PATH = 512;
export const MAX_DEPTH = 16;
export const HASH = /^[a-f0-9]{64}$/;
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const missing = (error) => ["not-found", "ENOENT"].includes(error?.code);
export const revision = (stat) => `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}`;

export class Refusal extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

export function notePath(path, shared) {
  if (
    typeof path !== "string" ||
    path.length > MAX_PATH ||
    /[\\:<>|"?*]/u.test(path) ||
    Array.from(path).some((char) => char < " " || char === "\x7f")
  )
    return false;
  const parts = path.split("/");
  if (
    !path.endsWith(".md") ||
    parts.length > MAX_DEPTH ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    return false;
  return shared ? !/^(?:memory|user)\.md$/i.test(path) : parts.length > 1 && parts[0] === "memory";
}

export function inside(root, target) {
  const path = relative(root, target);
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

export async function sharedDirectory(state, configured) {
  const base = await realpath(state);
  if (!inside(state, configured) && !inside(base, configured)) {
    throw new Refusal("Shared folders must be inside gateway state");
  }
  const path = resolve(base, relative(inside(state, configured) ? state : base, configured));
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path) {
    throw new Refusal("Shared folders must be real directories without links");
  }
  return path;
}

export async function read(root, path) {
  try {
    const { buffer, realPath, stat } = await root.read(path);
    const content = buffer.toString("utf8");
    if (!Buffer.from(content).equals(buffer)) throw new Refusal("File is not UTF-8");
    return { content, hash: sha256(buffer), realPath, stat };
  } catch (error) {
    if (missing(error)) return { hash: null };
    throw error;
  }
}

export function requireHash(file, expectedHash) {
  if (file.hash !== expectedHash) {
    throw new Refusal("The file changed since it was read", { currentHash: file.hash });
  }
}

export function requireNativeMutations() {
  // The pinned SDK selects native-only removal and publication at process scope.
  const mode = [process.env.FS_SAFE_NATIVE_MODE, process.env.OPENCLAW_FS_SAFE_NATIVE_MODE]
    .map((value) => value?.trim().toLowerCase())
    .find((value) => /^(0|false|off|never|1|true|on|auto|required|require)$/.test(value));
  if (mode !== "require" && mode !== "required") {
    throw new Refusal("Memory changes require FS_SAFE_NATIVE_MODE=require on the gateway");
  }
}

export function writeCas(root, path, file, assertCurrent, content, mkdir) {
  return applyCas(root, path, file, assertCurrent, (guard) => {
    const options = { assertBeforeMutation: guard, mkdir };
    return file.hash === null
      ? root.create(path, content, { ...options, atomic: true })
      : root.write(path, content, options);
  });
}

export async function applyCas(root, path, file, assertCurrent, mutate) {
  const target = resolve(root.rootReal, path);
  let guardPassed = false;
  const guard = () => {
    assertCurrent();
    const stat = lstatSync(target, { throwIfNoEntry: false });
    const before = file.stat;
    if (
      (stat || before) &&
      (!stat?.isFile() ||
        stat.nlink !== 1 ||
        !before ||
        stat.size !== before.size ||
        revision(stat) !== revision(before))
    ) {
      throw new Refusal("The file changed during the operation", { retryRead: true });
    }
    guardPassed = true;
  };
  try {
    await mutate(guard);
  } catch (error) {
    const status = error.details?.publication?.status;
    if (error.code === "helper-unavailable" && (!status || status === "not-published")) {
      throw new Refusal("This filesystem does not support the required native memory mutation");
    }
    if (error.details?.retryRead || error.code === "already-exists") {
      assertCurrent();
      const current = await read(root, path).catch(() => null);
      if (current) requireHash(current, file.hash);
    }
    // Some SDK verification failures carry no receipt even after publication.
    if (
      status === "published" ||
      status === "indeterminate" ||
      (!status && guardPassed && !(error instanceof Refusal) && error.code !== "already-exists")
    ) {
      throw new Refusal("Memory may have changed. Read it again before retrying", {
        unknown: true,
      });
    }
    throw error;
  }
}

export const rootOptions = {
  hardlinks: "reject",
  symlinks: "reject",
  mutationSymlinks: "reject",
  maxBytes: MAX_BYTES,
  mode: 0o600,
};
