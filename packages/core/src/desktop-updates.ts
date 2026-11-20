/** Desktop release updates belong to this device, independently of the gateway. */
export type UpdateTrack = "stable" | "nightly";

export type DesktopUpdateFailure =
  | "not-configured"
  | "development-build"
  | "no-updater"
  | "invalid-version"
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
  | "hash-mismatch"
  | "write-failed";

export type DesktopUpdateState =
  | { kind: "not-checked" }
  | { kind: "checking" }
  | { kind: "nothing-newer" }
  | { kind: "offered"; version: string; releaseDate: string; offerId: string }
  | { kind: "downloading"; version: string; received: number; expected: number }
  /** The byte count and SHA-512 matched the feed. */
  | { kind: "verified"; version: string; size: number }
  | { kind: "failed"; reason: DesktopUpdateFailure; stage: "check" | "download" | "preferences" };

export interface DesktopUpdateSnapshot {
  /** Null when the host has no desktop release version or its version failed validation. */
  runningVersion: string | null;
  runningTrack: UpdateTrack | null;
  /** Configured tracks only. Each source is a hostname. */
  tracks: ReadonlyArray<{ track: UpdateTrack; source: string }>;
  selectedTrack: UpdateTrack | null;
  /** UTC ISO timestamp of the last completed feed read. */
  lastCheckedAt: string | null;
  state: DesktopUpdateState;
  install: { kind: "unavailable-in-this-build" };
}

/** Exposed as bridge.desktopUpdates. Only check and download may start a request. */
export interface DesktopUpdates {
  get(): Promise<DesktopUpdateSnapshot>;
  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
  check(): Promise<DesktopUpdateSnapshot>;
  chooseTrack(track: UpdateTrack): Promise<DesktopUpdateSnapshot>;
  /** A stale or unknown identity leaves the current snapshot alone. */
  download(offerId: string): Promise<DesktopUpdateSnapshot>;
}
