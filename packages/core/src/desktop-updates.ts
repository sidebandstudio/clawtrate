/** Desktop release updates belong to this device, independently of the gateway. */
export type UpdateTrack = "stable" | "nightly";

export type DesktopUpdateFailure =
  | "not-configured"
  | "development-build"
  | "no-updater"
  | "invalid-version"
  | "unsupported-system"
  | "no-file-for-this-system"
  | "unreachable"
  | "timed-out"
  | "http-status"
  | "address-refused"
  | "redirect-refused"
  | "too-large"
  | "malformed-feed"
  | "wrong-track"
  | "size-mismatch"
  | "artifact-changed"
  | "hash-mismatch"
  | "write-failed";

export type UpdateInstallRefusal =
  | "no-verified-download"
  | "build-not-signed"
  | "windows-install-pending-trial"
  | "no-installer-path"
  | "artifact-changed"
  | "mac-designated-requirement"
  | "inspection-failed"
  | "running-signature-untrusted"
  | "installer-version"
  | "mac-archive"
  | "mac-bundle-identifier"
  | "mac-architecture"
  | "windows-signature"
  | "windows-publisher";

/**
 * Why the Mac installer's inspection of a download ended in `inspection-failed`. Only codes,
 * counts and the system version: never file contents, paths or anything secret.
 */
export interface UpdateInspectionFailure {
  /**
   * `hold-archive`: keeping a private copy of the download; `start-helper`: starting the
   * inspection helper; `running-signature`: the helper's signature-only call; `archive`: its
   * full call on the download.
   */
  stage: "hold-archive" | "start-helper" | "running-signature" | "archive";
  /** The helper's exit code; null when it did not exit by itself. */
  exitCode: number | null;
  /** The signal that ended the helper, such as SIGKILL. */
  signal: string | null;
  /**
   * What the helper printed. `reported`: it printed inspection-failed itself; `complete`: a
   * result line, refused for its exit; `unrecognized`: a line no result names. Null when it
   * never ran.
   */
  output: "empty" | "no-line-ending" | "too-long" | "unrecognized" | "reported" | "complete" | null;
  /** The helper's own words for the step that failed, such as `parent-code -67065`. */
  helperStep: string | null;
  /** A system error code, such as ENOENT, never its message. */
  errorCode: string | null;
  durationMs: number;
  /** The operating system and its version, such as `macOS 15.7.9`. */
  system: string;
}

/**
 * A copy the Mac installer made to check a download that it then couldn't remove. It never
 * changes the inspection's answer; the update folder is cleared again at the next start and
 * the next check.
 */
export interface UpdateCleanupFailure {
  /** `checked-copy`: the unpacked app the helper checked; `held-copy`: the private copy of the download. */
  copy: "checked-copy" | "held-copy";
  /** A system error code, such as ENOTEMPTY, never its message. */
  errorCode: string;
}

export type UpdateInstallCapability =
  | {
      kind: "unavailable-in-this-build";
      reason: UpdateInstallRefusal;
      /** Set with `inspection-failed` when the installer recorded why. */
      failure?: UpdateInspectionFailure;
      cleanup?: UpdateCleanupFailure;
    }
  | {
      kind: "restart-available";
      cleanup?: UpdateCleanupFailure;
      offerId: string;
      /** Confirm that macOS installs on the next quit even if restart cannot finish. */ completesOnQuit?: true;
    };

/** Set only from a prior handoff record and the running version on this launch. */
export interface UpdateAttemptOutcome {
  kind: "target-running" | "old-version-running" | "unconfirmed";
  target: string;
  track: UpdateTrack;
  from: string;
  running: string | null;
  /**
   * When the update did not take, and the build that handed it off records its quit: whether
   * that app finished quitting (`quitMs` after it asked to) or was stopped first. macOS installs
   * a staged update only once the app has quit.
   */
  quit?: "finished" | "not-finished";
  quitMs?: number;
}

export type DesktopUpdateState =
  | { kind: "preparing"; offerId: string; version: string }
  /** macOS may complete this authorized handoff on any later quit. */
  | { kind: "handed-to-system"; offerId: string; version: string }
  /** The native updater requested the archive, but Electron did not confirm staging. */
  | { kind: "handoff-unconfirmed"; offerId: string; version: string }
  | { kind: "handing-off"; offerId: string; version: string }
  | {
      kind: "handoff-failed";
      version: string;
      /** `mac-updater-refused`: the macOS updater stopped before it requested the archive. */
      reason:
        UpdateInstallRefusal | "attempt-not-saved" | "installer-failed" | "mac-updater-refused";
      /** Set with `inspection-failed` when the installer recorded why. */
      failure?: UpdateInspectionFailure;
    }
  | { kind: "not-checked" }
  | { kind: "checking" }
  | { kind: "nothing-newer" }
  | { kind: "offered"; version: string; releaseDate: string; offerId: string }
  | {
      kind: "downloading";
      version: string;
      received: number;
      expected: number;
      /** After the last byte: moving the file into place, then reading it back to check it. */
      step?: "moving" | "verifying";
    }
  /** After writing, this file matched the feed’s size and SHA-512. Installing must check the exact bytes again. */
  | { kind: "verified"; offerId: string; version: string; size: number }
  | {
      kind: "failed";
      reason: DesktopUpdateFailure;
      stage: "check" | "download" | "preferences";
      /** A download failed for this checked release. Retry requires a fresh check. */
      lastOffer?: { version: string; releaseDate: string };
      retry?: "check";
    };

export interface DesktopUpdateSnapshot {
  /** Monotonically increasing within this host process. */
  revision: number;
  /** Null when the host has no desktop release version or its version failed validation. */
  runningVersion: string | null;
  runningTrack: UpdateTrack | null;
  /** Configured tracks only. Each source is a hostname. */
  tracks: ReadonlyArray<{ track: UpdateTrack; source: string }>;
  selectedTrack: UpdateTrack | null;
  pendingTrack: UpdateTrack | null;
  /** Most recent complete feed read accepted by this host. */
  lastCheck: { track: UpdateTrack; readAt: string } | null;
  /** Most recent local settings or storage problem, separate from the release result. */
  preferenceIssue:
    | "attempt-not-read"
    | "preferences-not-read"
    | "track-not-saved"
    | "last-check-not-saved"
    | "update-folder-unavailable"
    | null;
  state: DesktopUpdateState;
  install: UpdateInstallCapability;
  lastAttempt: UpdateAttemptOutcome | null;
}

export type DesktopUpdateOutcome = "accepted" | "busy" | "stale" | "invalid" | "superseded";
export interface DesktopUpdateReply {
  outcome: DesktopUpdateOutcome;
  snapshot: DesktopUpdateSnapshot;
}

/** Exposed as bridge.desktopUpdates. Check and Download contact the release source. Confirmed Restart may serve a local handoff. */
export interface DesktopUpdates {
  get(): Promise<DesktopUpdateSnapshot>;
  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
  check(expectedTrack: UpdateTrack, expectedRevision: number): Promise<DesktopUpdateReply>;
  chooseTrack(track: UpdateTrack): Promise<DesktopUpdateReply>;
  /** A stale or unknown identity leaves the current snapshot alone. */
  download(offerId: string): Promise<DesktopUpdateReply>;
  /** Accepted means preparation began. Only lastAttempt observes the running version after relaunch. */
  restart(offerId: string): Promise<DesktopUpdateReply>;
}
