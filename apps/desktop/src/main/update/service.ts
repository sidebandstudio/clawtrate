import type {
  DesktopUpdateSnapshot,
  DesktopUpdateOutcome,
  DesktopUpdateReply,
  DesktopUpdateState,
  DesktopUpdateFailure,
  KeyValueStore,
  UpdateTrack,
  UpdateInspectionFailure,
  UpdateInstallRefusal,
} from "@clawtrate/core";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { clearUpdateDirectory, prepareUpdateDirectory } from "../private-update-directory.ts";
import { checkFeedAddress, type LoopbackHttpForTests } from "./address.ts";
import { watchUpdateFile } from "../update-file-watch.ts";
import { UpdateEngine } from "./engine.ts";
import type { UpdateInstaller } from "./install.ts";
import { readAttempt, attemptOutcome, type UpdateQuit } from "./attempt.ts";
import { readCheck, type StoredUpdatePreferences } from "./preferences.ts";
import { whatsNewView, type BuildNotes } from "./whats-new.ts";
import { readWhatsNew } from "./whats-new-read.ts";
import { fileKeyFor, parseReleaseDate } from "./feed.ts";
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
  /** The commit the build was made from, for the details under Settings → Updates. */
  commit?: string | null;
  store: Pick<KeyValueStore, "get" | "set"> & {
    readPreferences?: () => Promise<StoredUpdatePreferences>;
    /** Records, synchronously, that the app quit after a handoff. */
    markQuit?: (quit: UpdateQuit) => void;
    readQuit?: () => Promise<UpdateQuit | null>;
    /** Drops the attempt and its quit record once the attempted version is running. */
    forgetAttempt?: () => Promise<void>;
  };
  changed: (snapshot: DesktopUpdateSnapshot) => void;
  installer?: UpdateInstaller;
  quitAfterLaunch?: () => void;
  loopbackHttpForTests?: LoopbackHttpForTests;
}

function idleCapability(installer?: UpdateInstaller): DesktopUpdateSnapshot["install"] {
  const reason = installer ? (installer.unavailable ?? "no-verified-download") : "build-not-signed";
  return { kind: "unavailable-in-this-build", reason };
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

/** The build's date and commit, for support (F-561); absent when the build carries neither. */
function buildFacts(options: UpdateServiceOptions): Pick<DesktopUpdateSnapshot, "build"> {
  const releaseDate = options.releaseDate ? parseReleaseDate(options.releaseDate) : null;
  const commit = options.commit && /^[0-9a-f]{40}$/.test(options.commit) ? options.commit : null;
  return releaseDate || commit ? { build: { releaseDate, commit } } : {};
}

export class DesktopUpdateService {
  private engine: UpdateEngine | null = null;
  private work: Promise<void> | null = null;
  private pendingInstall: DesktopUpdateSnapshot["install"] | null = null;
  private fileWatch: ReturnType<typeof watchUpdateFile> | null = null;
  private switching = false;
  private closed = false;
  private nativeSubmitted = false;
  /** The attempt handed off in this run, and when the app was asked to quit for it. */
  private handoff: { time: string; quitAskedAt: number | null } | null = null;
  private readonly shutdownSignal = new AbortController();
  private readonly options: UpdateServiceOptions;
  private snapshot: DesktopUpdateSnapshot;
  private constructor(options: UpdateServiceOptions, snapshot: DesktopUpdateSnapshot) {
    this.options = options;
    this.snapshot = snapshot;
  }

  static async start(options: UpdateServiceOptions): Promise<DesktopUpdateService> {
    const version = parseVersion(options.version);
    const tracks = (["stable", "nightly"] as const).flatMap((track) => {
      const address = checkFeedAddress(options.feeds[track], options.loopbackHttpForTests);
      return address.ok ? [{ track, source: address.url.hostname }] : [];
    });
    // Three numbers don't name a track (issue #438): a build with only a Beta feed is a
    // Beta build. Otherwise the version's shape decides, as it always has.
    const runningTrack =
      version &&
      (version.length === 3 && tracks.length === 1 && tracks[0]!.track === "nightly"
        ? "nightly"
        : versionTrack(version));
    let selectedTrack =
      tracks.find((t) => t.track === runningTrack)?.track ?? tracks[0]?.track ?? null;
    let lastCheck: DesktopUpdateSnapshot["lastCheck"] = null;
    let preferenceIssue: DesktopUpdateSnapshot["preferenceIssue"] = null;
    let lastAttempt: DesktopUpdateSnapshot["lastAttempt"] = null;
    try {
      const stored = await options.store.readPreferences?.();
      if (stored?.invalid.size)
        preferenceIssue = stored.invalid.has("attempt")
          ? "attempt-not-read"
          : "preferences-not-read";
      const saved = stored ? stored.prefs.selectedTrack : await options.store.get("selectedTrack");
      selectedTrack = tracks.find((t) => t.track === saved)?.track ?? selectedTrack;
      if (stored) lastCheck = stored.prefs.lastCheck ?? null;
      else {
        // A bad last check must not hide the attempt read below.
        try {
          const raw = await options.store.get("lastCheck");
          if (raw !== null) lastCheck = readCheck(JSON.parse(raw));
        } catch {
          preferenceIssue = "preferences-not-read";
        }
      }
      try {
        const raw = stored ? null : await options.store.get("attempt");
        const attempt = stored?.prefs.attempt ?? (raw ? readAttempt(JSON.parse(raw)) : null);
        if (attempt)
          lastAttempt = attemptOutcome(
            attempt,
            version ? formatVersion(version) : null,
            (await options.store.readQuit?.().catch(() => null)) ?? null,
          );
        // Reported this once; a later start on another version, a downgrade by hand
        // included, is not this attempt's result.
        if (lastAttempt?.kind === "target-running")
          await options.store.forgetAttempt?.().catch(() => {});
      } catch {
        preferenceIssue = "attempt-not-read";
      }
    } catch {
      preferenceIssue = "preferences-not-read";
    }
    try {
      await clearUpdateDirectory(options.downloadDir);
    } catch {
      preferenceIssue ??= "update-folder-unavailable";
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
      install: idleCapability(options.installer),
      lastAttempt,
      ...buildFacts(options),
    });
  }

  get(): DesktopUpdateSnapshot {
    if (this.snapshot.install.kind === "restart-available" && !this.fileWatch?.current())
      this.changedFile();
    return this.snapshot;
  }

  private changedFile() {
    if (this.snapshot.install.kind === "restart-available") {
      this.retireFile();
      this.publish({
        kind: "failed",
        stage: "download",
        reason: "artifact-changed",
        retry: "check",
      });
    }
  }

  private retireFile() {
    this.fileWatch?.close();
    this.fileWatch = null;
    this.options.installer?.retire?.();
  }

  /** The builds' lists the current check read (F-554); null before a check and when it read none. */
  private notes: { engine: UpdateEngine; track: UpdateTrack; builds: BuildNotes[] } | null = null;

  /** The snapshot with what the current check's lists say for its state (F-554). */
  private withNotes(snapshot: DesktopUpdateSnapshot): DesktopUpdateSnapshot {
    const rest = { ...snapshot };
    delete rest.whatsNew;
    // Kept until the check has its answer: while it still says Checking, nothing shows.
    const notes =
      this.notes && this.notes.engine === this.engine && snapshot.state.kind !== "checking"
        ? this.notes
        : null;
    const view =
      notes &&
      whatsNewView(
        notes.builds,
        snapshot.runningVersion,
        "version" in snapshot.state ? snapshot.state.version : null,
        notes.track,
      );
    return view ? { ...rest, whatsNew: view } : rest;
  }

  /**
   * Reads the builds' lists beside the feed, after `engine`'s check has its
   * answer. Its result, or its failure, changes only what the pane lists: no
   * state the updater reads, and never the check.
   */
  private async readNotes(
    engine: UpdateEngine,
    track: UpdateTrack,
    feed: URL,
    runningVersion: string,
  ) {
    const builds = await readWhatsNew(feed, `Clawtrate/${runningVersion}`);
    if (this.closed || this.engine !== engine || !builds) return;
    this.notes = { engine, track, builds };
    // Its own counter: `revision`, which commands are checked against, stays as it is.
    this.snapshot = this.withNotes({
      ...this.snapshot,
      listsRevision: (this.snapshot.listsRevision ?? 0) + 1,
    });
    try {
      this.options.changed(this.snapshot);
    } catch {
      // A closing renderer cannot change what a check found.
    }
  }

  private publish(state: DesktopUpdateState) {
    let install = idleCapability(this.options.installer);
    if (state.kind === "verified") install = this.pendingInstall ?? install;
    else if (state.kind === "failed" && state.reason === "artifact-changed")
      install = { kind: "unavailable-in-this-build", reason: state.reason };
    else if (
      state.kind === "handoff-failed" &&
      state.reason !== "attempt-not-saved" &&
      state.reason !== "installer-failed" &&
      state.reason !== "mac-updater-refused"
    )
      install = {
        kind: "unavailable-in-this-build",
        reason: state.reason,
        ...(state.failure && { failure: state.failure }),
      };
    this.pendingInstall = null;
    if (install.kind === "restart-available" && !this.fileWatch?.current()) {
      this.retireFile();
      install = { kind: "unavailable-in-this-build", reason: "artifact-changed" };
      state = { kind: "failed", stage: "download", reason: "artifact-changed", retry: "check" };
    }
    this.snapshot = this.withNotes({
      ...this.snapshot,
      state,
      install,
      revision: this.snapshot.revision + 1,
    });
    try {
      this.options.changed(this.snapshot);
    } catch {
      // A closing renderer cannot interrupt hashing or change a transfer result.
    }
  }

  /** The installer's record of why an inspection failed, for that refusal only. */
  private failureFor(reason: string): { failure?: UpdateInspectionFailure } {
    const failure = reason === "inspection-failed" && this.options.installer?.inspectionFailure;
    return failure ? { failure } : {};
  }

  private get restarting() {
    return (
      this.snapshot.state.kind === "preparing" ||
      this.snapshot.state.kind === "handing-off" ||
      this.snapshot.state.kind === "handed-to-system" ||
      this.snapshot.state.kind === "handoff-unconfirmed"
    );
  }

  private reply(outcome: DesktopUpdateOutcome): DesktopUpdateReply {
    return { outcome, snapshot: this.snapshot };
  }

  async chooseTrack(track: unknown): Promise<DesktopUpdateReply> {
    if (this.closed) return this.reply("invalid");
    if (this.restarting || this.switching) return this.reply("busy");
    if (
      (track !== "stable" && track !== "nightly") ||
      !this.snapshot.tracks.some((t) => t.track === track)
    )
      return this.reply("invalid");
    if (track === this.snapshot.selectedTrack) return this.reply("accepted");
    this.switching = true;
    this.retireFile();
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

  /**
   * Main only, from `will-quit`: the app is about to exit. After a handoff, record that it got
   * this far, so the next start can tell a quit that finished from one that was stopped.
   */
  quitting(now = Date.now()): void {
    if (!this.handoff) return;
    const { time, quitAskedAt } = this.handoff;
    // No quit time when nothing asked the app to quit for the update (an unconfirmed handoff).
    this.options.store.markQuit?.({
      attempt: time,
      // The wall clock can move back between the two: a quit is still a quit, of no time.
      ...(quitAskedAt !== null && { ms: Math.max(0, now - quitAskedAt) }),
    });
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingInstall = null;
    this.shutdownSignal.abort();
    this.retireFile();
    this.engine?.cancel();
    this.engine = null;
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      install: idleCapability(this.options.installer),
      pendingTrack: null,
      state:
        this.snapshot.state.kind === "handing-off" && this.nativeSubmitted
          ? { ...this.snapshot.state, kind: "handoff-unconfirmed" }
          : this.restarting
            ? this.snapshot.state
            : { kind: "not-checked" },
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
      this.retireFile();
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

  private runWork(
    engine: UpdateEngine,
    initial: DesktopUpdateState,
    run: () => Promise<DesktopUpdateState | undefined>,
    failure: DesktopUpdateState,
  ): Promise<void> {
    const work = Promise.resolve()
      .then(run)
      .catch(() => failure)
      .then((state) => {
        // Observers can act on the terminal state as soon as they receive it.
        this.work = null;
        if (this.engine === engine && state) this.publish(state);
      });
    this.work = work;
    this.publish(initial);
    return work;
  }

  async check(expectedTrack: unknown, expectedRevision: unknown): Promise<DesktopUpdateReply> {
    if (this.closed) return this.reply("invalid");
    if (this.restarting || this.switching || this.work) return this.reply("busy");
    if (expectedTrack !== "stable" && expectedTrack !== "nightly") return this.reply("invalid");
    if (
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    )
      return this.reply("invalid");
    const { runningVersion, selectedTrack } = this.snapshot;
    if (!selectedTrack) return this.reply("invalid");
    if (expectedTrack !== selectedTrack || expectedRevision !== this.snapshot.revision)
      return this.reply("stale");
    if (!runningVersion || unavailable(this.options, runningVersion, selectedTrack))
      return this.reply("invalid");
    this.retireFile();
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
            ...(state.step && { step: state.step }),
          });
      },
    });
    this.engine = engine;
    this.notes = null;
    await this.runWork(
      engine,
      { kind: "checking" },
      async () => {
        try {
          await this.clearDownloads();
        } catch {
          if (this.engine === engine) {
            this.snapshot = { ...this.snapshot, preferenceIssue: "update-folder-unavailable" };
            return failed("write-failed");
          }
          return;
        }
        if (this.engine !== engine) return;
        const result = await engine.check();
        if (this.engine !== engine) return;
        // What the builds add (F-554): read once, only after the check has its answer from
        // the feed, and never awaited, so it neither decides nor delays anything.
        const feed = checkFeedAddress(
          this.options.feeds[selectedTrack],
          this.options.loopbackHttpForTests,
        );
        if (feed.ok && (result.kind === "available" || result.kind === "up-to-date"))
          void this.readNotes(engine, selectedTrack, feed.url, runningVersion);
        this.clearIssue("update-folder-unavailable");
        const lastCheck = checkedAt ? { track: selectedTrack, readAt: checkedAt } : null;
        if (lastCheck) {
          this.snapshot = { ...this.snapshot, lastCheck };
          this.publish(this.snapshot.state);
          try {
            await this.options.store.set("lastCheck", JSON.stringify(lastCheck));
            if (!this.closed) this.clearIssue("last-check-not-saved");
          } catch {
            if (!this.closed && this.snapshot.lastCheck === lastCheck)
              this.snapshot = { ...this.snapshot, preferenceIssue: "last-check-not-saved" };
          }
        }
        switch (result.kind) {
          case "available":
            return {
              kind: "offered",
              version: result.version,
              releaseDate: result.releaseDate,
              offerId,
            };
          case "up-to-date":
            return { kind: "nothing-newer" };
          case "not-configured":
            return failed("not-configured");
          case "failed":
            return failed(result.cause);
        }
      },
      failed("unreachable"),
    );
    if (this.engine !== engine) return this.reply("superseded");
    return this.reply("accepted");
  }

  async download(id: unknown): Promise<DesktopUpdateReply> {
    const { state } = this.snapshot;
    const engine = this.engine;
    if (this.closed) return this.reply("invalid");
    if (this.restarting || this.switching || this.work) return this.reply("busy");
    if (typeof id !== "string" || !id) return this.reply("invalid");
    if (!engine || state.kind !== "offered" || state.offerId !== id) return this.reply("stale");
    const expected = engine.offeredBytes;
    if (expected === null) return this.reply("stale");
    const downloadFailure = (reason: DesktopUpdateFailure): DesktopUpdateState => ({
      kind: "failed",
      stage: "download",
      reason,
      retry: "check",
      lastOffer: { version: state.version, releaseDate: state.releaseDate },
    });
    await this.runWork(
      engine,
      { kind: "downloading", version: state.version, received: 0, expected },
      async () => {
        if (this.engine !== engine) return;
        try {
          await prepareUpdateDirectory(this.options.downloadDir, state.offerId);
        } catch {
          if (this.engine === engine)
            this.snapshot = { ...this.snapshot, preferenceIssue: "update-folder-unavailable" };
          return downloadFailure("write-failed");
        }
        if (this.engine !== engine) return;
        const result = await engine.download();
        if (this.engine !== engine) return;
        if (result.kind === "ready") {
          const installer = this.options.installer;
          let install = idleCapability(this.options.installer);
          if (installer && !installer.unavailable) {
            const file = await engine.verifiedArtifact(
              id,
              this.snapshot.selectedTrack,
              result.version,
            );
            if (this.engine !== engine) return;
            if (!file) return downloadFailure("artifact-changed");
            try {
              this.fileWatch = watchUpdateFile(file.path, () => this.changedFile());
            } catch {
              return downloadFailure("artifact-changed");
            }
            const reason = await installer.inspect(file).catch(() => "inspection-failed" as const);
            if (this.engine !== engine) return;
            if (!this.fileWatch?.current() || reason === "artifact-changed") {
              this.retireFile();
              return downloadFailure("artifact-changed");
            }
            if (reason) this.retireFile();
            const cleanup = installer.cleanupFailure;
            install = reason
              ? {
                  kind: "unavailable-in-this-build",
                  reason,
                  ...this.failureFor(reason),
                  ...(cleanup && { cleanup }),
                }
              : {
                  kind: "restart-available",
                  offerId: id,
                  ...(installer.completesOnQuit && { completesOnQuit: true }),
                  ...(cleanup && { cleanup }),
                };
          }
          this.pendingInstall = install;
          return {
            kind: "verified",
            offerId: state.offerId,
            version: result.version,
            size: expected,
          };
        }
        if (result.kind === "failed") return downloadFailure(result.cause);
      },
      downloadFailure("write-failed"),
    );
    return this.reply(this.engine === engine ? "accepted" : "superseded");
  }

  async restart(id: unknown): Promise<DesktopUpdateReply> {
    const { state, selectedTrack, install, runningVersion } = this.get();
    const engine = this.engine;
    const installer = this.options.installer;
    if (this.closed || typeof id !== "string" || !id) return this.reply("invalid");
    if (this.restarting || this.switching || this.work) return this.reply("busy");
    if (state.kind !== "verified" || state.offerId !== id) return this.reply("stale");
    if (
      !installer ||
      !engine ||
      !selectedTrack ||
      !runningVersion ||
      install.kind !== "restart-available" ||
      install.offerId !== id
    )
      return this.reply("invalid");
    const version = state.version;
    const fail = (
      reason:
        UpdateInstallRefusal | "attempt-not-saved" | "installer-failed" | "mac-updater-refused",
    ) => {
      this.retireFile();
      this.publish({ kind: "handoff-failed", version, reason, ...this.failureFor(reason) });
      return this.reply("accepted");
    };
    this.publish({ kind: "preparing", version, offerId: id });
    const file = await engine.verifiedArtifact(id, selectedTrack, version);
    if (this.closed) return this.reply("superseded");
    if (!file) return fail("artifact-changed");
    const refused = await installer.inspect(file).catch(() => "inspection-failed" as const);
    if (this.closed) return this.reply("superseded");
    if (refused) return fail(refused);
    if (!this.fileWatch?.current()) return fail("artifact-changed");
    const time = new Date().toISOString();
    const attempt = { target: version, track: selectedTrack, from: runningVersion, time };
    try {
      await this.options.store.set(
        "attempt",
        JSON.stringify({
          ...attempt,
          phase: "handoff",
          ...(this.options.store.markQuit && { marksQuit: true }),
        }),
      );
    } catch {
      return this.closed ? this.reply("superseded") : fail("attempt-not-saved");
    }
    // A failure before anything reached the system owes no quit: the attempt is kept without
    // that mark, so the next start doesn't report a quit that never had to happen.
    const failBeforeHandoff = async (reason: Parameters<typeof fail>[0]) => {
      await this.options.store
        .set("attempt", JSON.stringify({ ...attempt, phase: "handoff" }))
        .catch(() => {});
      return fail(reason);
    };
    if (this.closed) return this.reply("superseded");
    this.publish({ kind: "handing-off", version, offerId: id });
    if (this.closed) return this.reply("superseded");
    if (!this.fileWatch?.current()) return failBeforeHandoff("artifact-changed");
    let handed = false;
    const reason = await installer
      .launch(
        file,
        this.shutdownSignal.signal,
        () => {
          if (!this.closed && !handed && installer.completesOnQuit) {
            handed = true;
            this.handoff = { time, quitAskedAt: Date.now() };
            this.publish({ kind: "handed-to-system", version, offerId: id });
          }
        },
        () => {
          this.nativeSubmitted = true;
          // macOS may install it on any later quit.
          this.handoff ??= { time, quitAskedAt: null };
        },
      )
      .catch(() => "installer-failed" as const);
    if (this.closed) return this.reply("superseded");
    this.retireFile();
    if (handed) return this.reply("accepted");
    if (this.nativeSubmitted) {
      this.publish({ kind: "handoff-unconfirmed", version, offerId: id });
      return this.reply("accepted");
    }
    if (reason) return failBeforeHandoff(reason);
    this.options.quitAfterLaunch?.();
    return this.reply("accepted");
  }
}
