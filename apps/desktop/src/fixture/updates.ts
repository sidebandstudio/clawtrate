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
    unsigned: { kind: "offered", ...offer },
    ready: { kind: "verified", version, size: 120000, offerId: offer.offerId },
    preparing: { kind: "preparing", ...offer },
    "handing-off": { kind: "handing-off", ...offer },
    "handed-to-system": { kind: "handed-to-system", ...offer },
    "handoff-unconfirmed": { kind: "handoff-unconfirmed", version, offerId: offer.offerId },
    "installer-failed": { kind: "handoff-failed", version, reason: "installer-failed" },
    "not-checked": { kind: "not-checked" },
    checking: { kind: "checking" },
    "nothing-newer": { kind: "nothing-newer" },
    offered: { kind: "offered", ...offer },
    inspecting: { kind: "downloading", version, received: 120000, expected: 120000 },
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
  const after = params.get("after");
  const observed =
    after === "unreadable"
      ? null
      : after === "target-running"
        ? version
        : after === "unconfirmed"
          ? "0.3.0"
          : runningVersion;
  let snapshot: DesktopUpdateSnapshot = {
    state: after === "unreadable" ? states.invalid : states[kind],
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
    runningVersion: kind === "invalid" ? null : observed,
    runningTrack: kind === "invalid" || after === "unreadable" ? null : runningTrack,
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
    lastAttempt:
      after === "target-running" ||
      after === "old-version-running" ||
      after === "unconfirmed" ||
      after === "unreadable"
        ? {
            kind: after === "unreadable" ? "unconfirmed" : after,
            from: runningVersion,
            target: version,
            track: selectedTrack,
            running: observed,
          }
        : null,
    install:
      kind === "ready"
        ? { kind: "restart-available", offerId: offer.offerId, completesOnQuit: true }
        : {
            kind: "unavailable-in-this-build",
            reason:
              kind === "unsupported"
                ? "no-installer-path"
                : ["offered", "inspecting"].includes(kind)
                  ? "no-verified-download"
                  : "build-not-signed",
          },
  };
  const listeners = new Set<(s: DesktopUpdateSnapshot) => void>();
  function publish(patch: Partial<DesktopUpdateSnapshot>) {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    for (const listener of listeners) listener(snapshot);
  }
  const reply = (outcome: DesktopUpdateOutcome) => ({ outcome, snapshot });
  return {
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
    restart: async (id) => {
      if (snapshot.state.kind !== "verified" || snapshot.state.offerId !== id)
        return reply("stale");
      if (snapshot.install.kind !== "restart-available" || snapshot.install.offerId !== id)
        return reply("invalid");
      publish({
        state: { kind: "preparing", version: snapshot.state.version, offerId: id },
        install: { kind: "unavailable-in-this-build", reason: "no-verified-download" },
      });
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
