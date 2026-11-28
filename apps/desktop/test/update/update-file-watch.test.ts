import {
  appendFileSync,
  chmodSync,
  renameSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchUpdateFile } from "../../src/main/update-file-watch.ts";
import { tempDir } from "./harness.ts";

let dir: ReturnType<typeof tempDir>;
let path: string;
beforeEach(() => {
  dir = tempDir();
  path = join(dir.path, "update.zip");
  writeFileSync(path, "verified");
  chmodSync(path, 0o600);
});
afterEach(() => dir.remove());

// A real watch on the file: on macOS it is kqueue, on Linux inotify, and on Windows the
// folder's change list filtered to this name. Each change reaches it as an event. libuv
// registers the watch with the system at the event loop's next poll, which has passed once
// a second turn's setImmediate runs; a change made earlier is missed.
it.each<[string, () => void]>([
  [
    "replaced",
    () => {
      writeFileSync(path + ".new", "another");
      renameSync(path + ".new", path);
    },
  ],
  ["renamed", () => renameSync(path, path + ".moved")],
  ["deleted", () => rmSync(path)],
  ["written", () => appendFileSync(path, "more")],
  ["truncated", () => truncateSync(path, 1)],
  ["made read-only", () => chmodSync(path, 0o400)],
  ["given other times", () => utimesSync(path, new Date(1000), new Date(1000))],
])("the download's watch withdraws it as soon as the file is %s", async (_, change) => {
  const changed = vi.fn();
  const watch = watchUpdateFile(path, changed);
  try {
    for (let turn = 0; turn < 2; turn++) await new Promise(setImmediate);
    change();
    // Linux's inotify can report one delete or replace as several events; the service withdraws
    // once, since a withdrawn offer isn't offered any more.
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3000 });
    expect(watch.current()).toBe(false);
  } finally {
    watch.close();
  }
});
