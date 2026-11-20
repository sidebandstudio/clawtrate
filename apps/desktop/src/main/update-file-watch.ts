import { lstatSync, watch } from "node:fs";
import { dirname } from "node:path";

function stamp(path: string) {
  const file = lstatSync(path, { bigint: true });
  if (!file.isFile() || file.nlink !== 1n) return null;
  return [file.dev, file.ino, file.size, file.birthtimeNs, file.ctimeNs, file.mtimeNs].join(".");
}

/** Withdraw the displayed capability when the named download changes. The Mac
 * handoff itself reads a private unlinked copy held since inspection. */
export function watchUpdateFile(path: string, changed: () => void) {
  const original = stamp(path);
  if (!original) throw Error("Changed file");
  const current = () => {
    try {
      return original === stamp(path);
    } catch {
      return false;
    }
  };
  const watcher = watch(dirname(path), { persistent: false }, () => {
    if (!current()) changed();
  });
  watcher.on("error", changed);
  return { current, close: () => watcher.close() };
}
