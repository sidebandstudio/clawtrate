// Locks between dev-gateway processes on this machine.
//
// A lock is an exclusive SQLite transaction (`BEGIN EXCLUSIVE`) on a lock file.
// SQLite takes it with an operating-system file lock, so ownership is atomic,
// it is released when the holder closes it or dies however it dies, and no
// process ever decides that someone else's lock is stale. Release closes only
// the connection that holds it. Lock files are never deleted: removing one
// while a waiter has it open would let two processes hold "the same" lock.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Where the lock files live, under the home the instances live in. */
export function lockDir(home: string): string {
  return join(home, ".clawtrate-dev-gateway", "locks");
}

/** Serialises port choice between starts. */
export function portLockPath(home: string): string {
  return join(lockDir(home), "ports.lock");
}

const INSTANCE_LOCK_BUCKETS = 64;

/**
 * The lifecycle lock of one instance, held by start, stop, reset and prune.
 * Named instances share 64 lock files by a hash of the name, so the number of
 * files stays bounded; two names in one bucket are only serialised, never mixed.
 */
export function instanceLockPath(home: string, instance: string | null): string {
  if (instance === null) return join(lockDir(home), "default.lock");
  const bucket = createHash("sha256").update(instance).digest().readUInt32BE(0);
  return join(lockDir(home), `instance-${bucket % INSTANCE_LOCK_BUCKETS}.lock`);
}

const SQLITE_BUSY = 5;

/** A real directory, created if absent; a link or anything else at the path is refused. */
function ensureRealDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing to use ${path} for locks: it is not a plain directory`);
  }
}

/** The lock folder and its parent must be plain directories, and the lock file a plain file. */
function checkLockPath(path: string): void {
  const dir = dirname(path);
  ensureRealDir(dirname(dir));
  ensureRealDir(dir);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (!stat.isFile()) throw new Error(`refusing to use ${path} as a lock: it is not a plain file`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connections that hold a lock. Kept reachable here so a held lock never
 * depends on what the caller's code references: a collected connection would
 * be closed by its finalizer, releasing the lock early.
 */
const held = new Set<DatabaseSync>();

/** Run `fn` while holding the lock at `path`. Waits up to `timeoutMs` for it. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; what?: string } = {},
): Promise<T> {
  checkLockPath(path);
  const db = new DatabaseSync(path, { timeout: 0 });
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  try {
    for (;;) {
      try {
        db.exec("BEGIN EXCLUSIVE");
        break;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== SQLITE_BUSY) throw error;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${options.what ?? path}`, { cause: error });
        }
        await sleep(50);
      }
    }
    held.add(db);
    try {
      return await fn();
    } finally {
      db.exec("ROLLBACK");
      held.delete(db);
    }
  } finally {
    db.close();
  }
}
