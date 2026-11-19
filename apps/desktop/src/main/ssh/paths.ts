// Paths as the file system walks them. A path is compared only after its links
// are resolved the way the system resolves them when the file is opened: each
// existing part through its links, and a `..` after a link taken from where the
// link led, not from its spelling.

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/**
 * The path the system opens for `raw`: the real path of its longest existing
 * prefix, as spelled (so `link/..` is the link target's parent), joined with
 * the parts that don't exist yet.
 */
export function physicalPath(raw: string): string {
  if (!isAbsolute(raw)) throw new Error("Not an absolute path.");
  let current = raw;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

const fold = (path: string, platform: NodeJS.Platform) =>
  platform === "darwin" || platform === "win32" ? path.toLowerCase() : path;

/** Whether `path` is `dir` or inside it, compared as the platform's file system compares names. */
export function within(path: string, dir: string, platform: NodeJS.Platform): boolean {
  const p = fold(path, platform);
  const d = fold(dir, platform);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}
