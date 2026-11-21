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
  | "mac-architecture";

export type UpdateInstallCapability =
  | { kind: "unavailable-in-this-build"; reason: UpdateInstallRefusal }
  | {
      kind: "restart-available";
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
}

export type DesktopUpdateState =
  | { kind: "preparing"; offerId: string; version: string }
  /** macOS may complete this authorized handoff on any later quit. */
  | { kind: "handed-to-system"; offerId: string; version: string }
  /** Native staging was requested, but Electron did not confirm it. */
  | { kind: "handoff-unconfirmed"; offerId: string; version: string }
  | { kind: "handing-off"; offerId: string; version: string }
  | {
      kind: "handoff-failed";
      version: string;
      reason: UpdateInstallRefusal | "attempt-not-saved" | "installer-failed";
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
