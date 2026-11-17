// Locks between dev-gateway processes on this machine.
//
// A lock is an exclusive SQLite transaction (`BEGIN EXCLUSIVE`) on a lock file.
// SQLite takes it with an operating-system file lock, so ownership is atomic,
// it is released when the holder closes it or dies however it dies, and no
// process ever decides that someone else's lock is stale. Release closes only
// the connection that holds it. Lock files are never deleted: removing one
// while a waiter has it open would let two processes hold "the same" lock.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn` while holding the lock at `path`. Waits up to `timeoutMs` for it. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; what?: string } = {},
): Promise<T> {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
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
    try {
      return await fn();
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}
