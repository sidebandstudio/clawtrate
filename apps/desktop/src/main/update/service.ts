import type {
  DesktopUpdateSnapshot,
  DesktopUpdateOutcome,
  DesktopUpdateReply,
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
import { readCheck } from "./preferences.ts";
import { fileKeyFor } from "./feed.ts";
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
  store: Pick<KeyValueStore, "get" | "set">;
  changed: (snapshot: DesktopUpdateSnapshot) => void;
  loopbackHttpForTests?: LoopbackHttpForTests;
}

function failed(reason: DesktopUpdateFailure): DesktopUpdateState {
  return { kind: "failed", stage: "check", reason };
}

function unavailable(
  options: UpdateServiceOptions,
  version: string | null,
  track: UpdateTrack | null,
): DesktopUpdateState | null {
  if (!options.packaged) return failed("development-build");
  if (!version) return failed("invalid-version");
  if (!fileKeyFor(options.platform, options.arch)) return failed("unsupported-system");
  if (!track) return failed("not-configured");
  return null;
}

export class DesktopUpdateService {
  private engine: UpdateEngine | null = null;
  private work: Promise<void> | null = null;
  private switching = false;
  private closed = false;
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
      tracks.find((t) => t.track === runningTrack)?.track ?? tracks[0]?.track ?? null;
    let lastCheck: DesktopUpdateSnapshot["lastCheck"] = null;
    let preferenceIssue: DesktopUpdateSnapshot["preferenceIssue"] = null;
    try {
      await clearUpdateDirectory(options.downloadDir);
    } catch {
      preferenceIssue = "update-folder-unavailable";
    }
    try {
      const saved = await options.store.get("selectedTrack");
      selectedTrack = tracks.find((t) => t.track === saved)?.track ?? selectedTrack;
      const raw = await options.store.get("lastCheck");
      if (raw !== null) lastCheck = readCheck(JSON.parse(raw));
    } catch {
      preferenceIssue = "preferences-not-read";
    }
    return new DesktopUpdateService(options, {
      revision: 0,
      runningVersion: version ? formatVersion(version) : null,
      runningTrack,
      tracks,
      selectedTrack,
      pendingTrack: null,
      lastCheck,
      preferenceIssue,
      state: unavailable(options, version ? options.version : null, selectedTrack) ?? {
        kind: "not-checked",
      },
      install: { kind: "unavailable-in-this-build", reason: "no-verified-download" },
      lastAttempt: null,
    });
  }

  get(): DesktopUpdateSnapshot {
    return this.snapshot;
  }

  private publish(state: DesktopUpdateState) {
    this.snapshot = { ...this.snapshot, state, revision: this.snapshot.revision + 1 };
    try {
      this.options.changed(this.snapshot);
    } catch {
      // A closing renderer cannot interrupt hashing or change a transfer result.
    }
  }

  private reply(outcome: DesktopUpdateOutcome): DesktopUpdateReply {
    return { outcome, snapshot: this.snapshot };
  }

  async chooseTrack(track: unknown): Promise<DesktopUpdateReply> {
    if (this.closed) return this.reply("invalid");
    if (this.switching) return this.reply("busy");
    if (
      (track !== "stable" && track !== "nightly") ||
      !this.snapshot.tracks.some((t) => t.track === track)
    )
      return this.reply("invalid");
    if (track === this.snapshot.selectedTrack) return this.reply("accepted");
    this.switching = true;
    const previous = this.engine;
    this.engine = null;
    previous?.cancel();
    this.snapshot = { ...this.snapshot, pendingTrack: track };
    this.publish({ kind: "not-checked" });
    const state: DesktopUpdateState = unavailable(
      this.options,
      this.snapshot.runningVersion,
      track,
    ) ?? { kind: "not-checked" };
    let issue: DesktopUpdateSnapshot["preferenceIssue"] = "update-folder-unavailable";
    try {
      await this.work;
      if (this.closed) return this.reply("superseded");
      await this.clearDownloads();
      if (this.closed) return this.reply("superseded");
      issue = "track-not-saved";
      await this.options.store.set("selectedTrack", track);
      issue = null;
    } catch {
      // The phase identifies the failed local operation.
    }
    if (this.closed) return this.reply("superseded");
    if (issue) {
      this.snapshot = { ...this.snapshot, preferenceIssue: issue };
    } else {
      this.snapshot = { ...this.snapshot, selectedTrack: track };
      this.clearIssue("track-not-saved");
      this.clearIssue("update-folder-unavailable");
    }
    this.switching = false;
    this.snapshot = { ...this.snapshot, pendingTrack: null };
    this.publish(state);
    return this.reply("accepted");
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.engine?.cancel();
    this.engine = null;
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      pendingTrack: null,
      state: { kind: "not-checked" },
    };
  }

  /** Main only. Validate the current offer and its kept file again before use. */
  async recheckVerified(offerId: string): Promise<boolean> {
    const { state } = this.snapshot;
    const engine = this.engine;
    if (state.kind !== "verified" || state.offerId !== offerId || !engine) return false;
    const valid = await engine.recheckFile(offerId, this.snapshot.selectedTrack, state.version);
    if (this.engine !== engine || this.snapshot.state !== state) return false;
    if (!valid) {
      this.publish({
        kind: "failed",
        stage: "download",
        reason: "artifact-changed",
        retry: "check",
      });
    }
    return valid;
  }

  private clearIssue(issue: NonNullable<DesktopUpdateSnapshot["preferenceIssue"]>) {
    if (this.snapshot.preferenceIssue === issue)
      this.snapshot = { ...this.snapshot, preferenceIssue: null };
  }

  private clearDownloads() {
    return clearUpdateDirectory(this.options.downloadDir);
  }

  async check(expectedTrack: unknown): Promise<DesktopUpdateReply> {
    if (this.closed) return this.reply("invalid");
    if (this.switching || this.work) return this.reply("busy");
    if (expectedTrack !== "stable" && expectedTrack !== "nightly") return this.reply("invalid");
    const { runningVersion, selectedTrack } = this.snapshot;
    if (!selectedTrack) return this.reply("invalid");
    if (expectedTrack !== selectedTrack) return this.reply("stale");
    if (!runningVersion || unavailable(this.options, runningVersion, selectedTrack))
      return this.reply("invalid");
    this.engine?.cancel();
    const offerId = selectedTrack + "-" + randomUUID();
    let checkedAt: string | null = null;
    const engine: UpdateEngine = new UpdateEngine({
      offerId,
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
      try {
        await this.clearDownloads();
      } catch {
        if (this.engine === engine) {
          this.snapshot = { ...this.snapshot, preferenceIssue: "update-folder-unavailable" };
          this.publish({ kind: "not-checked" });
        }
        return;
      }
      if (this.engine !== engine) return;
      const result = await engine.check();
      if (this.engine !== engine) return;
      this.clearIssue("update-folder-unavailable");
      const lastCheck = checkedAt ? { track: selectedTrack, readAt: checkedAt } : null;
      if (lastCheck) this.snapshot = { ...this.snapshot, lastCheck };
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
      if (lastCheck) {
        try {
          await this.options.store.set("lastCheck", JSON.stringify(lastCheck));
          if (this.snapshot.preferenceIssue === "last-check-not-saved" && !this.closed) {
            this.clearIssue("last-check-not-saved");
            this.publish(this.snapshot.state);
          }
        } catch {
          if (this.closed || this.snapshot.lastCheck !== lastCheck) return;
          this.snapshot = { ...this.snapshot, preferenceIssue: "last-check-not-saved" };
          this.publish(this.snapshot.state);
        }
      }
    })()
      .catch(() => {
        if (this.engine === engine) this.publish(failed("unreachable"));
      })
      .finally(() => {
        this.work = null;
      });
    this.publish({ kind: "checking" });
    await this.work;
    if (this.engine !== engine) return this.reply("superseded");
    return this.reply("accepted");
  }

  async download(id: unknown): Promise<DesktopUpdateReply> {
    const { state } = this.snapshot;
    const engine = this.engine;
    if (this.closed) return this.reply("invalid");
    if (this.switching || this.work) return this.reply("busy");
    if (typeof id !== "string" || !id) return this.reply("invalid");
    if (!engine || state.kind !== "offered" || state.offerId !== id) return this.reply("stale");
    const expected = engine.offeredBytes;
    if (expected === null) return this.reply("stale");
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
        try {
          await prepareUpdateDirectory(this.options.downloadDir, state.offerId);
        } catch {
          if (this.engine === engine) {
            this.snapshot = { ...this.snapshot, preferenceIssue: "update-folder-unavailable" };
            reportFailure("write-failed");
          }
          return;
        }
        if (this.engine !== engine) return;
        const result = await engine.download();
        if (this.engine !== engine) return;
        if (result.kind === "ready") {
          this.publish({
            kind: "verified",
            offerId: state.offerId,
            version: result.version,
            size: expected,
          });
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
    return this.reply(this.engine === engine ? "accepted" : "superseded");
  }
}
