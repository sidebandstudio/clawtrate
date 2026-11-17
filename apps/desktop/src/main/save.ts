// Saving a file the Work pane holds (work-pane.md, section 6, F-319): exactly
// the bytes the reader supplied, written beside the target and moved over it,
// then read back. When a write fails, the target is read again before anything
// is said about it: "unchanged" only when it still holds exactly its earlier
// bytes.

import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type { SaveResult } from "@clawtrate/core";

export type { SaveResult };

/** The file operations a save uses, so a test can make any of them fail. */
export type SaveFs = {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options: { flag: "wx"; mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  stat(path: string): Promise<{ size: number; isFile(): boolean }>;
};

/** A file larger than this that was already at the target is not read to remember it. */
export const MAX_REMEMBERED_BYTES = 64 * 1024 * 1024;
/** The longest file name offered. */
const MAX_NAME_CHARS = 255;

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** A name safe to offer in the save dialog: no folders, no control characters. */
export function safeFileName(raw: unknown): string {
  const name = typeof raw === "string" ? raw : "";
  const cleaned = basename(name.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+$/, "")
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return cleaned || "file";
}

/** What is at `path` now: absent, a digest of its bytes, or present but not read. */
async function look(fs: SaveFs, path: string): Promise<"absent" | "unreadable" | string> {
  try {
    const info = await fs.stat(path);
    if (!info.isFile() || info.size > MAX_REMEMBERED_BYTES) return "unreadable";
    return digest(await fs.readFile(path));
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? "absent" : "unreadable";
  }
}

/** Write `data` to `target` exactly, and say what is there afterwards when it fails. */
export async function writeExactly(
  fs: SaveFs,
  target: string,
  data: Uint8Array,
): Promise<SaveResult> {
  const wanted = digest(data);
  const before = await look(fs, target);
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.part`);
  let failure: unknown = null;
  try {
    await fs.writeFile(temp, data, { flag: "wx", mode: 0o644 });
    await fs.rename(temp, target);
  } catch (error) {
    failure = error;
    await fs.rm(temp, { force: true }).catch(() => {});
  }
  const after = await look(fs, target);
  if (failure === null && after === wanted) return { status: "saved", name: basename(target) };
  const message =
    failure instanceof Error
      ? failure.message
      : failure === null
        ? "The saved file does not hold the same bytes."
        : String(failure);
  return {
    status: "failed",
    message,
    target:
      after === wanted
        ? "saved-anyway"
        : after === "absent" && before === "absent"
          ? "absent"
          : after !== "unreadable" && after !== "absent" && after === before
            ? "unchanged"
            : "unknown",
  };
}
