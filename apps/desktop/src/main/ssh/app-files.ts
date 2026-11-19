// The host must place SSH data inside its private, stable app-data directory.
// These helpers make new leaves exclusively, check regular-file ownership on
// reads on POSIX, and use a private sibling file to replace a leaf. The checks
// do not establish ancestor ownership or bind later OpenSSH opens to an inode.
// Windows relies on the app-data directory's inherited access controls.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export class UnsafeAppFile extends Error {
  override name = "UnsafeAppFile";
}

/** Not following a link where the system has the flag; Windows has none, and is checked by `lstat`. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const uid = () => (typeof process.getuid === "function" ? process.getuid() : null);

function ownedOrRefuse(info: { uid: number }, what: string): void {
  const me = uid();
  if (me !== null && info.uid !== me)
    throw new UnsafeAppFile(`The app's ${what} belongs to another account.`);
}

/** Makes the folder if it isn't there, refuses a link or another account's, and sets it to 0700. */
export function secureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new UnsafeAppFile("The app's SSH folder is not a plain folder.");
  }
  ownedOrRefuse(info, "SSH folder");
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    const fd = openSync(dir, constants.O_RDONLY | NOFOLLOW);
    try {
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  }
}

function writeAll(fd: number, text: string): void {
  const data = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
  fsyncSync(fd);
}

/** Creates `path` with `text`, 0600, failing if anything (a link included) is already there. */
export function createOwn(path: string, text: string): void {
  secureDir(dirname(path));
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeAll(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces `path` with `text`: a new file of a random name, made exclusively
 * and 0600, then moved over it. A link at `path` is replaced, not followed.
 */
export function writeOwn(path: string, text: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.part`);
  createOwn(temp, text);
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * The text of the app's file at `path`, or null when it isn't there. A link,
 * anything but a regular file, another account's file or one over `maxBytes`
 * is refused; a file readable by others is tightened to 0600.
 */
export function readOwn(path: string, maxBytes: number): string | null {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile())
    throw new UnsafeAppFile("An app SSH file is not a plain file.");
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== info.ino)
      throw new UnsafeAppFile("An app SSH file changed while opened.");
    ownedOrRefuse(opened, "SSH file");
    if (opened.size > maxBytes) throw new UnsafeAppFile("An app SSH file is too large.");
    if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const read = readSync(fd, data, offset, data.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return data.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Removes the app's file at `path`: a link is removed itself, never what it points at. */
export function removeOwn(path: string): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  unlinkSync(path);
}
