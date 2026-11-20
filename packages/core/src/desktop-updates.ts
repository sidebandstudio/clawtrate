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

export type DesktopUpdateState =
  | { kind: "not-checked" }
  | { kind: "checking" }
  | { kind: "nothing-newer" }
  | { kind: "offered"; version: string; releaseDate: string; offerId: string }
  | { kind: "downloading"; version: string; received: number; expected: number }
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
    | "preferences-not-read"
    | "track-not-saved"
    | "last-check-not-saved"
    | "update-folder-unavailable"
    | null;
  state: DesktopUpdateState;
  install: { kind: "unavailable-in-this-build" };
}

export type DesktopUpdateOutcome = "accepted" | "busy" | "stale" | "invalid" | "superseded";
export interface DesktopUpdateReply {
  outcome: DesktopUpdateOutcome;
  snapshot: DesktopUpdateSnapshot;
}

/** Exposed as bridge.desktopUpdates. Only check and download may start a request. */
export interface DesktopUpdates {
  get(): Promise<DesktopUpdateSnapshot>;
  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
  check(expectedTrack: UpdateTrack): Promise<DesktopUpdateReply>;
  chooseTrack(track: UpdateTrack): Promise<DesktopUpdateReply>;
  /** A stale or unknown identity leaves the current snapshot alone. */
  download(offerId: string): Promise<DesktopUpdateReply>;
}
