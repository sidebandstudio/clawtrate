import {
  noDesktopUpdates,
  type DesktopUpdates,
  type DesktopUpdateOutcome,
  type DesktopUpdateSnapshot,
  type DesktopUpdateState,
  type UpdateTrack,
} from "@clawtrate/core";

/**
 * The betas' lists the fixture's Beta source serves beside its feed (F-554), in
 * the shape of whats-new.json, newest first: the offered beta, one skipped, and
 * the running beta. Read only after a check, as the app does. The renderer may
 * not import the update module, so the fixture places them by these versions.
 */
export const FIXTURE_BETA_NOTES: Array<{ version: string; items: string[] }> = [
  {
    version: "0.2.0-beta.20261116.1",
    items: [
      "Settings shows what an update adds (#457)",
      "The download page lists what each beta added (#456)",
      "Conversations hide a bot's thinking unless you turn it on (#447)",
    ],
  },
  {
    version: "0.1.1-beta.20261115.4",
    items: [
      "iPhone Settings can show chats from Discord, Telegram and others (#441)",
      "Holding a message on a touch screen opens its actions (#380)",
    ],
  },
  {
    version: "0.1.0-beta.20261115.1",
    items: [
      "Pictures a bot makes appear in the conversation (#364)",
      "Provider limits show the share used and reset in larger type (#373)",
    ],
  },
];

/**
 * The same lists for Beta builds numbered with three numbers (F-561, `short=1`):
 * the offered build, one skipped, and the running build.
 */
export const FIXTURE_SHORT_NOTES: Array<{ version: string; items: string[] }> = [
  { version: "0.2.4", items: ["Settings shows the build's date and commit (#438)"] },
  { version: "0.2.3", items: ["The download page lists what each beta added (#456)"] },
  { version: "0.2.2", items: ["Pictures a bot makes appear in the conversation (#364)"] },
];

/** A build's date and commit, for `build=1` (F-561); an invented commit. */
export const FIXTURE_BUILD = {
  releaseDate: "2026-12-01T10:00:00.000Z",
  commit: "0123456789abcdef0123456789abcdef01234567",
} as const;

/** A fixed host reading for the screenshot fixture. No transfer or clock runs here. */
export function fixtureUpdates(params: URLSearchParams): DesktopUpdates {
  const runningTrack = params.get("buildTrack") === "nightly" ? "nightly" : "stable";
  // Beta builds numbered with three numbers (F-561).
  const short = params.get("short") === "1";
  const notes = short ? FIXTURE_SHORT_NOTES : FIXTURE_BETA_NOTES;
  const runningVersion =
    runningTrack === "nightly" ? (short ? "0.2.2" : "0.1.0-beta.20261115.1") : "0.1.0";
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
    track === "nightly" ? (short ? "0.2.4" : "0.2.0-beta.20261116.1") : "0.2.0";
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
    "inspection-failed": { kind: "verified", version, size: 120000, offerId: offer.offerId },
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
  const supportsRestart = kind === "ready" || kind === "offered" || kind === "inspecting";
  function installFor(state: DesktopUpdateState): DesktopUpdateSnapshot["install"] {
    if (kind === "inspection-failed" && state.kind === "verified")
      return {
        kind: "unavailable-in-this-build",
        reason: "inspection-failed",
        failure: {
          stage: "running-signature",
          exitCode: 0,
          signal: null,
          output: "reported",
          helperStep: "parent-code -67065",
          errorCode: null,
          durationMs: 84,
          system: "macOS 27.2.1",
        },
      };
    if (supportsRestart && state.kind === "verified")
      return { kind: "restart-available", offerId: state.offerId, completesOnQuit: true };
    return {
      kind: "unavailable-in-this-build",
      reason: supportsRestart
        ? "no-verified-download"
        : kind === "unsupported"
          ? "no-installer-path"
          : "build-not-signed",
    };
  }
  const initialState = after === "unreadable" ? states.invalid : states[kind];
  let snapshot: DesktopUpdateSnapshot = {
    state: initialState,
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
        : (track === "nightly" ? "beta" : track) + ".updates.example",
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
    install: installFor(initialState),
    ...(params.get("build") === "1" && { build: FIXTURE_BUILD }),
  };
  /**
   * What the lists show for `next` (F-554): only once a check has run, only from
   * the Beta source, and none with `whatsNew=none`.
   */
  function withNotes(next: DesktopUpdateSnapshot): DesktopUpdateSnapshot {
    const rest = { ...next };
    delete rest.whatsNew;
    const state = next.state;
    if (
      params.get("whatsNew") === "none" ||
      next.selectedTrack !== "nightly" ||
      state.kind === "not-checked" ||
      state.kind === "checking" ||
      // As the app: a check that failed read no lists.
      (state.kind === "failed" && state.stage === "check")
    )
      return rest;
    const [offered, skipped] = notes;
    const coming =
      "version" in state && state.version === offered!.version ? [offered!, skipped!] : [];
    // The running build's own list, whichever build that is: after an update, the one installed.
    const own = notes.find((build) => build.version === next.runningVersion)?.items ?? null;
    return coming.length || own ? { ...rest, whatsNew: { coming, running: own } } : rest;
  }
  snapshot = withNotes(snapshot);
  const listeners = new Set<(s: DesktopUpdateSnapshot) => void>();
  function publish(patch: Partial<Omit<DesktopUpdateSnapshot, "install">>) {
    const state = patch.state ?? snapshot.state;
    snapshot = withNotes({
      ...snapshot,
      ...patch,
      install: installFor(state),
      revision: snapshot.revision + 1,
    });
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
      publish({ state: { kind: "preparing", version: snapshot.state.version, offerId: id } });
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
