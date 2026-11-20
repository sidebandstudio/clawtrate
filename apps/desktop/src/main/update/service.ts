import type {
  DesktopUpdateSnapshot,
  DesktopUpdateState,
  DesktopUpdateFailure,
  KeyValueStore,
  UpdateTrack,
} from "@clawtrate/core";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { clearUpdateDirectory, prepareUpdateDirectory } from "../private-update-directory.ts";
import { checkFeedAddress, type LoopbackHttpForTests } from "./address.ts";
import { UpdateEngine } from "./engine.ts";
import { parseReleaseDate } from "./feed.ts";
import { formatVersion, parseVersion, versionTrack } from "./version.ts";

export interface UpdateServiceOptions {
  version: string;
  packaged: boolean;
  platform: string;
  arch: string;
  /** Dedicated exclusively to the update service. */
  downloadDir: string;
  feeds: Record<UpdateTrack, string | null>;
  releaseDate: string | null;
  store: KeyValueStore;
  changed: (snapshot: DesktopUpdateSnapshot) => void;
  loopbackHttpForTests?: LoopbackHttpForTests;
}

function failed(
  reason: DesktopUpdateFailure,
  stage: "check" | "preferences" = "check",
): DesktopUpdateState {
  return { kind: "failed", stage, reason };
}

export class DesktopUpdateService {
  private engine: UpdateEngine | null = null;
  private work: Promise<void> | null = null;
  private switching = false;
  private readonly options: UpdateServiceOptions;
  private snapshot: DesktopUpdateSnapshot;
  private constructor(options: UpdateServiceOptions, snapshot: DesktopUpdateSnapshot) {
    this.options = options;
    this.snapshot = snapshot;
  }

  static async start(options: UpdateServiceOptions): Promise<DesktopUpdateService> {
    const version = parseVersion(options.version);
    const runningTrack = version && versionTrack(version);
    const tracks = (["stable", "nightly"] as const).flatMap((track) => {
      const address = checkFeedAddress(options.feeds[track], options.loopbackHttpForTests);
      return address.ok ? [{ track, source: address.url.hostname }] : [];
    });
    let selectedTrack =
      tracks.find((t) => t.track === runningTrack)?.track ?? tracks[0]?.track ?? runningTrack;
    let lastCheckedAt: string | null = null;
    let state: DesktopUpdateState = { kind: "not-checked" };
    try {
      await clearUpdateDirectory(options.downloadDir);
      const saved = await options.store.get("selectedTrack");
      selectedTrack = tracks.find((t) => t.track === saved)?.track ?? selectedTrack;
      lastCheckedAt = parseReleaseDate(await options.store.get("lastCheckedAt"));
    } catch {
      state = failed("write-failed", "preferences");
    }
    return new DesktopUpdateService(options, {
      runningVersion: version ? formatVersion(version) : null,
      runningTrack,
      tracks,
      selectedTrack,
      lastCheckedAt,
      state: options.packaged ? state : failed("development-build"),
      install: { kind: "unavailable-in-this-build" },
    });
  }

  get(): DesktopUpdateSnapshot {
    return this.snapshot;
  }

  private publish(state: DesktopUpdateState) {
    this.snapshot = { ...this.snapshot, state };
    try {
      this.options.changed(this.snapshot);
    } catch {
      // A closing renderer cannot interrupt hashing or change a transfer result.
    }
  }

  async chooseTrack(track: unknown): Promise<DesktopUpdateSnapshot> {
    if (
      this.switching ||
      track === this.snapshot.selectedTrack ||
      (track !== "stable" && track !== "nightly") ||
      !this.snapshot.tracks.some((t) => t.track === track)
    )
      return this.snapshot;
    this.switching = true;
    try {
      await this.options.store.set("selectedTrack", track);
      // Detach first. Even bytes already in the rename or a reply awaiting a store write
      // cannot publish after this point. Drain before cleaning the shared folder.
      const previous = this.engine;
      this.engine = null;
      previous?.cancel();
      this.snapshot = { ...this.snapshot, selectedTrack: track };
      this.publish(this.options.packaged ? { kind: "not-checked" } : failed("development-build"));
      await this.work;
      await this.clearDownloads();
    } catch {
      this.publish(failed("write-failed", "preferences"));
    } finally {
      this.switching = false;
    }
    return this.snapshot;
  }

  private clearDownloads() {
    return clearUpdateDirectory(this.options.downloadDir);
  }

  async check(): Promise<DesktopUpdateSnapshot> {
    if (this.switching || this.work) return { ...this.snapshot, commandRefusal: "busy" };
    const { runningVersion, selectedTrack } = this.snapshot;
    if (!this.options.packaged) this.publish(failed("development-build"));
    else if (!runningVersion || !selectedTrack) this.publish(failed("invalid-version"));
    else {
      const offerId = selectedTrack + "-" + randomUUID();
      let checkedAt: string | null = null;
      const engine: UpdateEngine = new UpdateEngine({
        currentVersion: runningVersion,
        track: selectedTrack,
        feedAddress: this.options.feeds[selectedTrack],
        buildReleaseDate: this.options.releaseDate,
        downloadDir: join(this.options.downloadDir, offerId),
        platform: this.options.platform,
        arch: this.options.arch,
        ...(this.options.loopbackHttpForTests && {
          loopbackHttpForTests: this.options.loopbackHttpForTests,
        }),
        onFeedRead: () => {
          if (this.engine === engine) checkedAt = new Date().toISOString();
        },
        onState: (state) => {
          if (this.engine !== engine) return;
          if (state.kind === "downloading" && state.received !== 0)
            this.publish({
              kind: "downloading",
              version: state.version,
              received: state.received,
              expected: state.total,
            });
        },
      });
      this.engine = engine;
      this.work = (async () => {
        await this.clearDownloads();
        if (this.engine !== engine) return;
        const result = await engine.check();
        if (this.engine !== engine) return;
        if (checkedAt) {
          await this.options.store.set("lastCheckedAt", checkedAt);
          if (this.engine !== engine) return;
          this.snapshot = { ...this.snapshot, lastCheckedAt: checkedAt };
        }
        switch (result.kind) {
          case "available":
            this.publish({
              kind: "offered",
              version: result.version,
              releaseDate: result.releaseDate,
              offerId,
            });
            break;
          case "up-to-date":
            this.publish({ kind: "nothing-newer" });
            break;
          case "not-configured":
            this.publish(failed("not-configured"));
            break;
          case "failed":
            this.publish(failed(result.cause));
            break;
        }
      })()
        .catch(() => {
          if (this.engine === engine) this.publish(failed("write-failed", "preferences"));
        })
        .finally(() => {
          this.work = null;
        });
      this.publish({ kind: "checking" });
      await this.work;
    }
    return this.snapshot;
  }

  async download(id: unknown): Promise<DesktopUpdateSnapshot> {
    const { state } = this.snapshot;
    const engine = this.engine;
    if (this.switching || this.work) return { ...this.snapshot, commandRefusal: "busy" };
    if (!engine || state.kind !== "offered" || state.offerId !== id) return this.snapshot;
    const expected = engine.offeredBytes;
    if (expected === null) return this.snapshot;
    const reportFailure = (reason: DesktopUpdateFailure) => {
      this.publish({
        kind: "failed",
        stage: "download",
        reason,
        retry: "check",
        lastOffer: { version: state.version, releaseDate: state.releaseDate },
      });
    };
    this.work = Promise.resolve()
      .then(async () => {
        if (this.engine !== engine) return;
        await prepareUpdateDirectory(this.options.downloadDir, state.offerId);
        if (this.engine !== engine) return;
        const result = await engine.download();
        if (this.engine !== engine) return;
        if (result.kind === "ready") {
          this.publish({ kind: "verified", version: result.version, size: expected });
        } else if (result.kind === "failed") reportFailure(result.cause);
      })
      .catch(() => {
        if (this.engine === engine) reportFailure("write-failed");
      })
      .finally(() => {
        this.work = null;
      });
    this.publish({ kind: "downloading", version: state.version, received: 0, expected });
    await this.work;
    return this.snapshot;
  }
}
