import type {
  DesktopUpdateSnapshot,
  DesktopUpdateState,
  DesktopUpdateFailure,
  KeyValueStore,
  UpdateTrack,
} from "@clawtrate/core";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { checkFeedAddress, type LoopbackHttpForTests } from "./address.ts";
import { UpdateEngine } from "./engine.ts";
import { parseReleaseDate } from "./feed.ts";
import { parseVersion, versionTrack } from "./version.ts";

interface Options {
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
  private readonly options: Options;
  private snapshot: DesktopUpdateSnapshot;
  private constructor(options: Options, snapshot: DesktopUpdateSnapshot) {
    this.options = options;
    this.snapshot = snapshot;
  }

  static async start(options: Options): Promise<DesktopUpdateService> {
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
      await rm(options.downloadDir, { recursive: true, force: true });
      const saved = await options.store.get("selectedTrack");
      selectedTrack = tracks.find((t) => t.track === saved)?.track ?? selectedTrack;
      lastCheckedAt = parseReleaseDate(await options.store.get("lastCheckedAt"));
    } catch {
      state = failed("write-failed", "preferences");
    }
    return new DesktopUpdateService(options, {
      runningVersion: version ? options.version : null,
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
    this.options.changed(this.snapshot);
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
    return rm(this.options.downloadDir, { recursive: true, force: true });
  }

  async check(): Promise<DesktopUpdateSnapshot> {
    if (this.switching || this.work) return this.snapshot;
    const { runningVersion, selectedTrack } = this.snapshot;
    if (!this.options.packaged) this.publish(failed("development-build"));
    else if (!runningVersion || !selectedTrack) this.publish(failed("invalid-version"));
    else {
      const engine: UpdateEngine = new UpdateEngine({
        currentVersion: runningVersion,
        track: selectedTrack,
        feedAddress: this.options.feeds[selectedTrack],
        buildReleaseDate: this.options.releaseDate,
        downloadDir: this.options.downloadDir,
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
          if (state.kind === "downloading")
            this.publish({
              kind: "downloading",
              version: state.version,
              received: state.received,
              expected: state.total,
            });
        },
      });
      let checkedAt: string | null = null;
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
              offerId: selectedTrack + "-" + randomUUID(),
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
    if (!engine || this.work || this.switching || state.kind !== "offered" || state.offerId !== id)
      return this.snapshot;
    this.work = Promise.resolve()
      .then(async () => {
        if (this.engine !== engine) return;
        const result = await engine.download();
        if (this.engine !== engine) return;
        const progress = this.snapshot.state;
        if (result.kind === "ready" && progress.kind === "downloading") {
          this.publish({ kind: "verified", version: result.version, size: progress.expected });
        } else if (result.kind === "failed")
          this.publish({ kind: "failed", stage: "download", reason: result.cause });
      })
      .finally(() => {
        this.work = null;
      });
    await this.work;
    return this.snapshot;
  }
}
