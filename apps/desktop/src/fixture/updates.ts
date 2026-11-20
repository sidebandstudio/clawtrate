import {
  noDesktopUpdates,
  type DesktopUpdates,
  type DesktopUpdateOutcome,
  type DesktopUpdateSnapshot,
  type DesktopUpdateState,
  type UpdateTrack,
} from "@clawtrate/core";

/** A fixed host reading for the screenshot fixture. No transfer or clock runs here. */
export function fixtureUpdates(params: URLSearchParams): DesktopUpdates {
  const runningTrack = params.get("buildTrack") === "nightly" ? "nightly" : "stable";
  const runningVersion = runningTrack === "nightly" ? "0.1.0-nightly.20261115.1" : "0.1.0";
  const selection = params.get("track") ?? runningTrack;
  const selectedTrack =
    params.get("tracks") === "nightly"
      ? "nightly"
      : params.get("tracks") === "one"
        ? runningTrack
        : selection === "nightly"
          ? "nightly"
          : "stable";
  const versionFor = (track: UpdateTrack | null) =>
    track === "nightly" ? "0.2.0-nightly.20261116.1" : "0.2.0";
  const version = versionFor(selectedTrack);
  const offer = { version, releaseDate: "2026-11-01T00:00:00Z", offerId: "fixture-offer" };
  const states = {
    "not-checked": { kind: "not-checked" },
    checking: { kind: "checking" },
    "nothing-newer": { kind: "nothing-newer" },
    offered: { kind: "offered", ...offer },
    downloading: { kind: "downloading", version, received: 41000, expected: 120000 },
    verified: { kind: "verified", version, size: 120000, offerId: offer.offerId },
    preferences: { kind: "not-checked" },
    pending: { kind: "not-checked" },
    storage: { kind: "not-checked" },
    history: { kind: "nothing-newer" },
    invalid: { kind: "failed", stage: "check", reason: "invalid-version" },
    unsupported: { kind: "failed", stage: "check", reason: "unsupported-system" },
    failcheck: { kind: "failed", stage: "check", reason: "unreachable" },
    faildl: { kind: "failed", stage: "download", reason: "size-mismatch" },
    nofile: { kind: "failed", stage: "check", reason: "no-file-for-this-system" },
    dev: { kind: "failed", stage: "check", reason: "development-build" },
    "no-source": { kind: "failed", stage: "check", reason: "not-configured" },
  } as const satisfies Record<string, DesktopUpdateState>;
  const kind = params.get("updates") as keyof typeof states | null;
  if (!kind || !Object.hasOwn(states, kind)) return noDesktopUpdates;
  const tracks: UpdateTrack[] =
    kind === "no-source"
      ? []
      : params.get("tracks") === "nightly"
        ? ["nightly"]
        : params.get("tracks") === "one"
          ? [runningTrack]
          : ["stable", "nightly"];
  let snapshot: DesktopUpdateSnapshot = {
    state: states[kind],
    revision: 0,
    preferenceIssue:
      kind === "preferences"
        ? "preferences-not-read"
        : kind === "storage"
          ? "update-folder-unavailable"
          : kind === "history"
            ? "last-check-not-saved"
            : null,
    pendingTrack: kind === "pending" ? "nightly" : null,
    runningVersion: kind === "invalid" ? null : runningVersion,
    runningTrack: kind === "invalid" ? null : runningTrack,
    selectedTrack: tracks.length ? selectedTrack : null,
    tracks: tracks.map((track) => ({
      track,
      source: params.has("longhost")
        ? "a".repeat(63) + ".example.test"
        : track + ".updates.example",
    })),
    lastCheck: ["nothing-newer", "history"].includes(kind)
      ? {
          track: params.get("lastTrack") === "nightly" ? "nightly" : selectedTrack,
          readAt: "2026-11-16T22:41:00Z",
        }
      : null,
    lastAttempt: null,
    install: { kind: "unavailable-in-this-build", reason: "no-verified-download" },
  };
  const listeners = new Set<(s: DesktopUpdateSnapshot) => void>();
  function publish(patch: Partial<DesktopUpdateSnapshot>) {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    for (const listener of listeners) listener(snapshot);
  }
  const reply = (outcome: DesktopUpdateOutcome) => ({ outcome, snapshot });
  return {
    restart: async () => reply("invalid"),
    get: async () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check: async (track, revision) => {
      if (snapshot.pendingTrack) return reply("busy");
      if (!snapshot.selectedTrack || !Number.isSafeInteger(revision) || revision < 0)
        return reply("invalid");
      if (snapshot.selectedTrack !== track || revision !== snapshot.revision) return reply("stale");
      publish({
        state: {
          ...states.offered,
          version: versionFor(track),
          offerId: "offer-" + (snapshot.revision + 1),
        },
      });
      return reply("accepted");
    },
    chooseTrack: async (track) => {
      if (snapshot.pendingTrack) return reply("busy");
      if (!tracks.includes(track)) return reply("invalid");
      publish({ pendingTrack: track, state: states["not-checked"], preferenceIssue: null });
      await Promise.resolve();
      if (params.get("save") === "failed")
        publish({ pendingTrack: null, preferenceIssue: "track-not-saved" });
      else publish({ pendingTrack: null, selectedTrack: track });
      return reply("accepted");
    },
    download: async (id) => {
      if (snapshot.pendingTrack) return reply("busy");
      if (snapshot.state.kind !== "offered" || snapshot.state.offerId !== id) return reply("stale");
      publish({ state: { ...states.verified, version: snapshot.state.version, offerId: id } });
      return reply("accepted");
    },
  };
}
