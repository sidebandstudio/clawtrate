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
    const { buffer, stat } = await root.read(path);
    const content = buffer.toString("utf8");
    if (!Buffer.from(content).equals(buffer)) throw new Refusal("File is not UTF-8");
    return { content, hash: sha256(buffer), stat };
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

export async function applyCas(root, path, file, assertCurrent, mutate) {
  const target = resolve(root.rootReal, path);
  const guard = () => {
    assertCurrent();
    const stat = lstatSync(target, { throwIfNoEntry: false });
    const before = file.stat;
    if (!stat && !before) return;
    if (
      !stat?.isFile() ||
      stat.nlink !== 1 ||
      !before ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size !== before.size ||
      stat.ctimeMs !== before.ctimeMs ||
      stat.mtimeMs !== before.mtimeMs
    ) {
      throw new Refusal("The file changed during the operation", { retryRead: true });
    }
  };
  try {
    await mutate(guard);
  } catch (error) {
    if (error.details?.retryRead || error.code === "already-exists") {
      assertCurrent();
      const current = await read(root, path).catch(() => null);
      if (current) requireHash(current, file.hash);
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
