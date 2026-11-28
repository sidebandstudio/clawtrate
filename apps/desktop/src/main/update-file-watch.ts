import { lstatSync, watch } from "node:fs";

function stamp(path: string) {
  const file = lstatSync(path, { bigint: true });
  if (!file.isFile() || file.nlink !== 1n) return null;
  return [file.dev, file.ino, file.size, file.birthtimeNs, file.ctimeNs, file.mtimeNs].join(".");
}

/** Withdraw the displayed capability when the named download changes. The Mac
 * handoff itself reads a private unlinked copy held since inspection. The file, not its
 * folder, is watched: on macOS a folder's watch is an FSEvents stream, and closing one
 * blocks this thread until fseventsd answers, seconds when it is busy (#940). A file's is
 * a kqueue descriptor. A new hard link to the file fires nothing on macOS, so the next
 * read finds it instead. */
export function watchUpdateFile(path: string, changed: () => void) {
  const original = stamp(path);
  if (!original) throw Error("Changed file");
  let usable = true;
  const current = () => {
    if (!usable) return false;
    try {
      return original === stamp(path);
    } catch {
      return false;
    }
  };
  const watcher = watch(path, { persistent: false }, () => {
    if (!current()) changed();
  });
  const invalidate = () => {
    if (!usable) return;
    usable = false;
    changed();
  };
  watcher.on("error", invalidate);
  watcher.on("close", invalidate);
  return {
    current,
    close: () => {
      usable = false;
      watcher.close();
    },
  };
}
