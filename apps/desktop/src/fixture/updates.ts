import {
  noDesktopUpdates,
  type DesktopUpdates,
  type DesktopUpdateSnapshot,
  type DesktopUpdateState,
  type UpdateTrack,
} from "@clawtrate/core";

/** A fixed host reading for the screenshot fixture. No transfer or clock runs here. */
export function fixtureUpdates(params: URLSearchParams): DesktopUpdates {
  const version = "0.2.0";
  const offer = { version, releaseDate: "2026-11-01T00:00:00Z", offerId: "fixture-offer" };
  const states = {
    "not-checked": { kind: "not-checked" },
    checking: { kind: "checking" },
    "nothing-newer": { kind: "nothing-newer" },
    offered: { kind: "offered", ...offer },
    downloading: { kind: "downloading", version, received: 41000, expected: 120000 },
    verified: { kind: "verified", version, size: 120000 },
    preferences: { kind: "failed", stage: "preferences", reason: "write-failed" },
    failcheck: { kind: "failed", stage: "check", reason: "unreachable" },
    faildl: { kind: "failed", stage: "download", reason: "size-mismatch" },
    nofile: { kind: "failed", stage: "check", reason: "no-file-for-this-system" },
    dev: { kind: "failed", stage: "check", reason: "development-build" },
    "no-source": { kind: "not-checked" },
  } as const satisfies Record<string, DesktopUpdateState>;
  const kind = params.get("updates") as keyof typeof states | null;
  if (!kind || !Object.hasOwn(states, kind)) return noDesktopUpdates;
  const tracks: UpdateTrack[] =
    kind === "no-source" ? [] : params.get("tracks") === "one" ? ["stable"] : ["stable", "nightly"];
  let snapshot: DesktopUpdateSnapshot = {
    state: states[kind],
    runningVersion: "0.1.0",
    runningTrack: "stable",
    selectedTrack:
      tracks.includes("nightly") && params.get("track") === "nightly" ? "nightly" : "stable",
    tracks: tracks.map((track) => ({ track, source: track + ".updates.example" })),
    lastCheckedAt: kind === "nothing-newer" ? "2026-11-16T22:41:00Z" : null,
    install: { kind: "unavailable-in-this-build" },
  };
  const listeners = new Set<(s: DesktopUpdateSnapshot) => void>();
  function publish(state: DesktopUpdateState, selectedTrack = snapshot.selectedTrack) {
    snapshot = { ...snapshot, state, selectedTrack };
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }
  return {
    get: async () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check: async () => publish(states.offered),
    chooseTrack: async (track) =>
      params.get("save") === "failed"
        ? publish({ kind: "failed", stage: "preferences", reason: "write-failed" })
        : publish(states["not-checked"], track),
    download: async (id) =>
      snapshot.state.kind === "offered" && snapshot.state.offerId === id
        ? publish(states.verified)
        : snapshot,
  };
}
