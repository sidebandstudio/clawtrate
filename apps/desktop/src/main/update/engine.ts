// The update engine: reads the feed, compares versions, downloads the file for
// this system and keeps it only when its size and SHA-512 are the feed's. It
// reports typed states for the update screens and installs nothing.
// docs/decisions.md, "Updates and release signing", has its rules.

import type { UpdateTrack } from "@clawtrate/core";
import { createHash } from "node:crypto";
import {
  close as closeFile,
  createWriteStream,
  open as openFile,
  write as writeFileChunk,
  writev as writeFileChunks,
} from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inspectUpdateFile } from "../inspect-update-file.ts";
import { checkFeedAddress, type LoopbackHttpForTests } from "./address.ts";
import { FILE_EXTENSION, fileKeyFor, parseFeed, type FeedFile, type FileKey } from "./feed.ts";
import { FetchRefused, open, readAll, Transfer, type FetchCause } from "./fetch.ts";
import { formatVersion, isNewer, parseVersion, type Version } from "./version.ts";

export const MAX_FEED_BYTES = 64 * 1024;
export const FEED_TIMEOUT_MS = 15_000;
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
export const IDLE_TIMEOUT_MS = 60_000;
/** A downloading state is reported at most once per this many bytes, and at the end. */
const PROGRESS_STEP_BYTES = 1024 * 1024;

export type UpdateFailureCause =
  | "address-refused"
  | FetchCause
  | "wrong-track"
  | "malformed-feed"
  | "no-file-for-this-system"
  | "size-mismatch"
  | "hash-mismatch"
  | "write-failed";

/** What the update screens are told. Every string in it was checked or made here. */
export type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "checking" }
  | { readonly kind: "up-to-date"; readonly latest: string }
  | { readonly kind: "available"; readonly version: string; readonly releaseDate: string }
  | {
      readonly kind: "downloading";
      readonly version: string;
      readonly releaseDate: string;
      readonly received: number;
      readonly total: number;
    }
  | {
      /** The downloaded bytes matched the feed's size and digest. */
      readonly kind: "ready";
      readonly version: string;
      readonly releaseDate: string;
      readonly path: string;
    }
  | {
      readonly kind: "failed";
      readonly stage: "check" | "download";
      readonly cause: UpdateFailureCause;
      readonly status?: number;
    };

export const UPDATE_REQUIRED_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * F-010: "Update required" when a newer version exists and this build is more
 * than 14 days old by its own release date. The feed's dates play no part.
 */
export function isUpdateRequired(
  newer: NewerVersion | null,
  buildReleaseDate: string | null,
  now: Date,
): boolean {
  if (!newer || !buildReleaseDate) return false;
  const built = Date.parse(buildReleaseDate);
  return Number.isFinite(built) && now.getTime() - built > UPDATE_REQUIRED_AFTER_MS;
}

/** A newer version the last check found, for F-010 and the screens. */
export interface NewerVersion {
  readonly version: string;
  readonly releaseDate: string;
}

export interface Limits {
  readonly maxFeedBytes: number;
  readonly feedTimeoutMs: number;
  readonly maxDownloadBytes: number;
  readonly downloadTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFeedBytes: MAX_FEED_BYTES,
  feedTimeoutMs: FEED_TIMEOUT_MS,
  maxDownloadBytes: MAX_DOWNLOAD_BYTES,
  downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS,
  idleTimeoutMs: IDLE_TIMEOUT_MS,
};

export interface UpdateEngineOptions {
  /** The feed's address. The production constructor passes the one fixed at build time. */
  readonly track?: UpdateTrack;
  readonly onFeedRead?: () => void;
  readonly feedAddress: string | null;
  /** The build's own release date, for F-010. The production constructor passes the build's. */
  readonly buildReleaseDate?: string | null;
  /** The running app's version, `app.getVersion()`. */
  readonly currentVersion: string;
  /** A folder of the app's own for downloads; created 0700 if missing. */
  readonly downloadDir: string;
  readonly platform: string;
  readonly arch: string;
  readonly onState?: (state: UpdateState) => void;
  /** Tests only: allow `http://127.0.0.1:<port>`. */
  readonly loopbackHttpForTests?: LoopbackHttpForTests;
  /** Tests only: smaller bounds. Each is capped at its default. */
  readonly limits?: Partial<Limits>;
}

interface Found {
  readonly version: Version;
  readonly releaseDate: string;
  readonly file: FeedFile;
}

/** Thrown inside a download to end it with a typed cause. */
class DownloadFailed extends Error {
  readonly reason: UpdateFailureCause;
  constructor(reason: UpdateFailureCause) {
    super(reason);
    this.reason = reason;
  }
}

export class UpdateEngine {
  private transfer: Transfer | null = null;
  private current: UpdateState = { kind: "idle" };
  private kept: { path: string; identity: string; sha512: string; size: number } | null = null;
  private found: Found | null = null;
  private busy: Promise<UpdateState> | null = null;
  private readonly options: UpdateEngineOptions;
  private readonly running: Version;
  private readonly key: FileKey | null;
  private readonly limits: Limits;

  constructor(options: UpdateEngineOptions) {
    const running = parseVersion(options.currentVersion);
    if (!running) throw new Error("invalid running release version");
    this.options = options;
    this.running = running;
    this.key = fileKeyFor(options.platform, options.arch);
    const limits = { ...DEFAULT_LIMITS };
    for (const name of Object.keys(DEFAULT_LIMITS) as Array<keyof Limits>) {
      const given = options.limits?.[name];
      if (given !== undefined && given > 0) limits[name] = Math.min(given, DEFAULT_LIMITS[name]);
    }
    this.limits = limits;
  }

  get state(): UpdateState {
    return this.current;
  }

  /** The newer version the last check found, or null, also while a check runs and after one failed. */
  get newer(): NewerVersion | null {
    return this.found
      ? { version: formatVersion(this.found.version), releaseDate: this.found.releaseDate }
      : null;
  }

  get offeredBytes(): number | null {
    return this.found?.file.size ?? null;
  }

  /** F-010 now: the last check found a newer version and this build is more than 14 days old. */
  updateRequired(now: Date): boolean {
    return isUpdateRequired(this.newer, this.options.buildReleaseDate ?? null, now);
  }

  /** Reads the feed once. While a check or a download runs, returns that one's result. */
  check(): Promise<UpdateState> {
    return this.exclusive(() => this.runCheck());
  }

  /** Downloads the version the last check found. Does nothing unless it is `available`. */
  download(): Promise<UpdateState> {
    return this.exclusive(() => this.runDownload());
  }

  /** Stop the request and let its normal cleanup finish before reusing the folder. */
  cancel(): void {
    this.kept = null;
    this.transfer?.stop("unreachable");
  }

  /** Main only. The owning service also checks the generation and offer identity. */
  async recheckFile(): Promise<boolean> {
    const kept = this.kept;
    if (!kept) return false;
    const proof = await inspectUpdateFile(kept.path, kept.size).catch(() => null);
    if (this.kept === kept && proof?.identity === kept.identity && proof.sha512 === kept.sha512)
      return true;
    if (this.kept === kept) this.kept = null;
    return false;
  }

  private exclusive(work: () => Promise<UpdateState>): Promise<UpdateState> {
    if (this.busy) return this.busy;
    // Publish the shared promise before work synchronously reports its first state.
    const { promise, resolve } = Promise.withResolvers<UpdateState>();
    const run = promise.finally(() => {
      this.transfer = null;
      this.busy = null;
    });
    this.busy = run;
    resolve(work());
    return run;
  }

  private report(state: UpdateState): UpdateState {
    this.current = state;
    this.options.onState?.(state);
    return state;
  }

  private get userAgent(): string {
    return `Clawtrate/${formatVersion(this.running)}`;
  }

  private async runCheck(): Promise<UpdateState> {
    // A new check forgets the last one's offer first, so a check that fails
    // leaves no newer version behind to report, require or download.
    this.kept = null;
    this.found = null;
    const loopback = this.options.loopbackHttpForTests;
    const address = checkFeedAddress(this.options.feedAddress, loopback);
    if (!address.ok) {
      return this.report(
        address.cause === "not-configured"
          ? { kind: "not-configured" }
          : { kind: "failed", stage: "check", cause: address.cause },
      );
    }
    this.report({ kind: "checking" });
    const { maxFeedBytes, feedTimeoutMs, idleTimeoutMs } = this.limits;
    const transfer = (this.transfer = new Transfer(
      feedTimeoutMs,
      Math.min(idleTimeoutMs, feedTimeoutMs),
    ));
    let text: string;
    try {
      const response = await open(address.url, transfer, maxFeedBytes, this.userAgent);
      text = (await readAll(response, transfer, maxFeedBytes)).toString("utf8");
    } catch (error) {
      return this.report(failure("check", error));
    } finally {
      transfer.done();
    }
    this.options.onFeedRead?.();
    const read = parseFeed(text, address.url, this.key, loopback, this.options.track);
    if (!read.ok) return this.report({ kind: "failed", stage: "check", cause: read.cause });
    const { version, releaseDate, file } = read.feed;
    if (!isNewer(version, this.running)) {
      return this.report({ kind: "up-to-date", latest: formatVersion(version) });
    }
    if (!file) {
      return this.report({ kind: "failed", stage: "check", cause: "no-file-for-this-system" });
    }
    if (file.size > this.limits.maxDownloadBytes) {
      return this.report({ kind: "failed", stage: "check", cause: "too-large" });
    }
    this.found = { version, releaseDate, file };
    return this.report({ kind: "available", version: formatVersion(version), releaseDate });
  }

  private async runDownload(): Promise<UpdateState> {
    const found = this.found;
    if (this.current.kind !== "available" || !found || !this.key) return this.current;
    // Checked again here, so no path reaches `ready` with a version not newer.
    if (!isNewer(found.version, this.running)) return this.current;
    const version = formatVersion(found.version);
    const { releaseDate, file } = found;
    const dir = this.options.downloadDir;
    const name = `Clawtrate-${version}-${this.key}.${FILE_EXTENSION[this.key]}`;
    const partial = join(dir, `${name}.partial`);
    const target = join(dir, name);
    const progress = (received: number) =>
      this.report({ kind: "downloading", version, releaseDate, received, total: file.size });

    progress(0);
    const transfer = (this.transfer = new Transfer(
      this.limits.downloadTimeoutMs,
      this.limits.idleTimeoutMs,
    ));
    const hash = createHash("sha512");
    let renamed = false;
    let received = 0;
    let reported = 0;
    try {
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await rm(partial, { force: true });
      } catch {
        throw new DownloadFailed("write-failed");
      }
      // A declared length other than the feed's is refused before a byte is written.
      const response = await open(file.url, transfer, this.limits.maxDownloadBytes, this.userAgent);
      const declared = response.headers["content-length"];
      if (declared !== undefined && Number(declared) !== file.size) {
        response.destroy();
        throw new DownloadFailed("size-mismatch");
      }
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          transfer.touch();
          received += chunk.length;
          if (received > file.size) return done(new DownloadFailed("size-mismatch"));
          hash.update(chunk);
          if (received - reported >= PROGRESS_STEP_BYTES) {
            reported = received;
            progress(received);
          }
          done(null, chunk);
        },
      });
      // Pipeline forwards one error between streams. Watch the filesystem
      // callbacks so a forwarded socket error cannot stand in for a disk error.
      let diskFailed = false;
      type DiskCallback<Args extends unknown[]> = (
        error: NodeJS.ErrnoException | null,
        ...args: Args
      ) => void;
      const record =
        <Args extends unknown[]>(callback: DiskCallback<Args>): DiskCallback<Args> =>
        (error, ...args) => {
          if (error) diskFailed = true;
          callback(error, ...args);
        };
      const out = createWriteStream(partial, {
        flags: "wx",
        mode: 0o600,
        fs: {
          open(path: string, flags: string, mode: number, callback: DiskCallback<[number]>) {
            openFile(path, flags, mode, record(callback));
          },
          write(
            fd: number,
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | undefined,
            callback: DiskCallback<[number, Buffer]>,
          ) {
            writeFileChunk(fd, buffer, offset, length, position, record(callback));
          },
          writev(
            fd: number,
            buffers: Buffer[],
            position: number | undefined,
            callback: DiskCallback<[number, Buffer[]]>,
          ) {
            writeFileChunks(fd, buffers, position ?? null, record(callback));
          },
          close(fd: number, callback: DiskCallback<[]>) {
            closeFile(fd, record(callback));
          },
        },
      });
      try {
        await pipeline(response, counter, out, { signal: transfer.signal });
      } catch (error) {
        if (diskFailed) throw new DownloadFailed("write-failed");
        if (error instanceof DownloadFailed) throw error;
        throw new FetchRefused(transfer.cause());
      }
      if (received !== file.size) throw new DownloadFailed("size-mismatch");
      if (hash.digest("base64") !== file.sha512) throw new DownloadFailed("hash-mismatch");
      if (received !== reported) progress(received);
      try {
        await rename(partial, target);
        renamed = true;
      } catch {
        throw new DownloadFailed("write-failed");
      }
      const proof = await inspectUpdateFile(target, file.size);
      if (!proof) throw new DownloadFailed("size-mismatch");
      if (proof.sha512 !== file.sha512) throw new DownloadFailed("hash-mismatch");
      if (transfer.signal.aborted) throw new FetchRefused(transfer.cause());
      this.kept = { path: target, ...proof };
    } catch (error) {
      transfer.done();
      if (renamed) await rm(target, { force: true }).catch(() => undefined);
      await rm(partial, { force: true }).catch(() => undefined);
      return this.report(failure("download", error));
    }
    transfer.done();
    return this.report({ kind: "ready", version, releaseDate, path: target });
  }
}

function failure(stage: "check" | "download", error: unknown): UpdateState {
  if (error instanceof DownloadFailed) return { kind: "failed", stage, cause: error.reason };
  if (error instanceof FetchRefused) {
    return error.status === undefined
      ? { kind: "failed", stage, cause: error.reason }
      : { kind: "failed", stage, cause: error.reason, status: error.status };
  }
  return { kind: "failed", stage, cause: stage === "check" ? "unreachable" : "write-failed" };
}
