// Setting up on this computer, in the fixture (docs/design/setup.md §3 to
// §7): `?setup=<state>` shows the desktop's first screen and what the host
// reports at each step, and the setup commands move through the walk the way
// the host would. Nothing here looks at a computer or makes a code.

import {
  initialSetupState,
  type BridgeCommand,
  type ClawtrateState,
  type HostInfo,
  type InstallFailure,
  type SetupInstall,
  type SetupLook,
  type SetupState,
} from "@clawtrate/core";

const running: SetupLook = {
  outcome: "running",
  reason: null,
  version: "2026.10.6",
  profile: "default",
  listens: "loopback",
  service: "launchagent",
  port: 18789,
  authMode: null,
  access: "new",
  others: [],
};

/** What local connect's look reports: no program, version or service, only the profile and port. */
const localLook: Partial<SetupLook> = { version: null, listens: null, service: null };

const looked = (look: Partial<SetupLook>): SetupState => ({
  ...initialSetupState,
  phase: "found",
  look: { ...running, ...look },
});

const failed = (kind: NonNullable<SetupState["failure"]>["kind"], extra = {}): SetupState => ({
  ...initialSetupState,
  phase: "failed",
  look: running,
  failure: { kind, exitCode: null, port: null, reason: null, ...extra },
});

const notFound: SetupLook = {
  ...running,
  outcome: "not-found",
  version: null,
  profile: null,
  listens: null,
  service: null,
  port: null,
  access: null,
};

/** Setting OpenClaw up (§10), at a step, after a look found nothing. */
const installing = (install: Partial<SetupInstall>): SetupState => ({
  ...initialSetupState,
  phase: "installing",
  look: notFound,
  install: { step: 0, nodeChecked: false, failure: null, ...install },
});

/** A failed install, at the step that failed. */
const installFailed = (
  kind: InstallFailure["kind"],
  step: number,
  extra: Partial<InstallFailure> = {},
): SetupState => ({
  ...initialSetupState,
  phase: "install-failed",
  look: notFound,
  install: {
    step: Math.max(step, 0),
    nodeChecked: step > 1,
    failure: {
      kind,
      step,
      exitCode: null,
      classification: null,
      retry: extra.cleanup === "removed",
      cleanup: "none",
      ...extra,
    },
  },
});

const localStopped = looked({ ...localLook, outcome: "stopped", access: null, canStart: true });

/** Every setup state the fixture shows, by the name used in `?setup=`. */
export const SETUP_STATES: Record<string, SetupState> = {
  first: initialSetupState,
  looking: { ...initialSetupState, phase: "looking", step: 1 },
  "looking-slow": { ...initialSetupState, phase: "looking", step: 2, slow: true },
  found: looked({}),
  "found-others": looked({ others: ["service com.example.openclaw-gateway", "profile work"] }),
  confirming: { ...looked({}), phase: "confirming" },
  untested: looked({ outcome: "untested", version: "2026.9.37" }),
  "too-old": looked({ outcome: "too-old", version: "2026.6.2" }),
  stopped: looked({ outcome: "stopped", service: "launchagent-stopped" }),
  "stopped-by-hand": looked({ outcome: "stopped", service: "none" }),
  "program-missing": looked({ outcome: "program-missing" }),
  "cant-tell": looked({ outcome: "cant-tell", reason: "timeout" }),
  "cant-tell-shape": looked({ outcome: "cant-tell", reason: "shape" }),
  "not-token": looked({ outcome: "not-token", authMode: "password" }),
  "not-found": looked({ outcome: "not-found" }),
  windows: looked({ outcome: "windows" }),
  connecting: { ...looked({}), phase: "connecting", step: 1 },
  "code-failed": failed("code-failed", { exitCode: 1 }),
  "code-refused": failed("code-refused"),
  grant: failed("grant"),
  unreachable: failed("unreachable", { port: 18789 }),
  changed: failed("changed"),
  refused: {
    ...initialSetupState,
    phase: "failed",
    failure: { kind: "refused", exitCode: null, port: null, reason: "file" },
  },
  "refused-home": {
    ...initialSetupState,
    phase: "failed",
    failure: { kind: "refused", exitCode: null, port: null, reason: "home" },
  },
  "refused-state": {
    ...initialSetupState,
    phase: "failed",
    failure: { kind: "refused", exitCode: null, port: null, reason: "state" },
  },
  "refused-missing": {
    ...initialSetupState,
    phase: "failed",
    failure: { kind: "refused", exitCode: null, port: null, reason: "missing" },
  },
  "found-paired": looked({ access: "paired" }),
  "found-not-reported": looked({ listens: null, service: null }),
  "cant-run": looked({ outcome: "cant-run", version: null, profile: null }),
  endpoint: looked({ outcome: "cant-tell", reason: "endpoint" }),
  bots: failed("bots", { port: 18789 }),
  "found-profile-only": looked({ others: ["profile work"] }),
  /** A found gateway whose Connect ends in the handshake's protocol mismatch. */
  "found-protocol": looked({}),
  "cant-tell-not-set-up": looked({ outcome: "cant-tell", reason: "not-set-up" }),
  "cant-tell-no-answer": looked({ outcome: "cant-tell", reason: "no-answer" }),
  "cant-tell-read-only": looked({
    outcome: "cant-tell",
    reason: "read-only",
    version: "2026.10.6",
  }),
  "code-failed-shape": failed("code-failed", { exitCode: 0 }),
  // A person's Mac app, with local connect (setup-effortless.md §3): `local-` scenes.
  "local-first": { ...looked({ ...localLook }), unasked: true },
  // The host's look at start, under way: it finds a gateway in a second, or after the
  // first screen's wait for it has ended (`SETUP_STEPS`).
  "local-waiting": { ...initialSetupState, phase: "looking", unasked: true },
  "local-start": { ...initialSetupState, phase: "looking", unasked: true },
  "local-start-slow": { ...initialSetupState, phase: "looking", unasked: true },
  "local-empty-wait": { ...initialSetupState, phase: "looking", unasked: true },
  "local-not-found": {
    ...looked({ ...localLook, outcome: "not-found", access: null, port: null, profile: null }),
    unasked: true,
  },
  "local-named-profile": {
    ...looked({
      ...localLook,
      outcome: "named-profile",
      profile: "work",
      port: null,
      access: null,
    }),
    unasked: true,
  },
  "local-running-two-profiles": {
    ...looked({ ...localLook, others: ["profile clawtrate"] }),
    unasked: true,
  },
  "local-stopped-two-profiles": {
    ...localStopped,
    look: { ...localStopped.look!, profile: "clawtrate", others: ["profile default"] },
  },
  "local-stopped": localStopped,
  "local-stopped-without-service": {
    ...localStopped,
    look: { ...localStopped.look!, canStart: false },
  },
  "local-starting": { ...localStopped, phase: "starting", step: 1 },
  "local-start-refused": { ...failed("not-started"), look: localStopped.look },
  "local-start-unanswered": {
    ...failed("not-started", { reason: "no-answer" }),
    look: localStopped.look,
  },
  "local-token-refused": {
    ...failed("token-refused", { port: 18789 }),
    look: looked(localLook).look,
  },
  "local-unanswered": { ...failed("unanswered", { port: 18789 }), look: looked(localLook).look },
  "local-protocol-older": {
    ...failed("protocol", { reason: "gateway-older" }),
    look: looked(localLook).look,
  },
  "local-protocol-newer": {
    ...failed("protocol", { reason: "client-older" }),
    look: looked(localLook).look,
  },
  "local-unreadable": looked({
    ...localLook,
    outcome: "cant-tell",
    reason: "settings",
    access: null,
  }),
  "local-unfinished": looked({
    ...localLook,
    outcome: "cant-tell",
    reason: "settings-unfinished",
    access: null,
  }),
  "local-unverified": looked({
    ...localLook,
    outcome: "unverified",
    reason: "not-gateway",
    access: null,
  }),
  // Settings that turn TLS on: local connect dials `ws://` only, so the way on is Advanced.
  "local-tls": looked({ ...localLook, outcome: "cant-tell", reason: "tls", access: null }),
  "local-failed": {
    ...looked({ ...localLook }),
    phase: "failed",
    failure: { kind: "unverified", exitCode: null, port: 18789, reason: "not-gateway" },
  },
  // Set up through This computer, then its reconnect refused by the check
  // (`REFUSED_RECONNECT`): with no bots kept, and with them (`-bots`, in the app behind it).
  "local-refused": { ...looked({ ...localLook }), phase: "done", step: 2 },
  "local-refused-token": { ...looked({ ...localLook }), phase: "done", step: 2 },
  "local-refused-bots": { ...looked({ ...localLook }), phase: "done", step: 2 },
  "install-ready": looked(notFound),
  installing: installing({}),
  "installing-node": installing({ step: 1, nodeChecked: true }),
  "installing-gateway": installing({ step: 2, nodeChecked: true }),
  "installing-check": installing({ step: 3, nodeChecked: true }),
  "install-recovery": {
    ...installing({ step: 2, nodeChecked: true, recovery: "replace" }),
    phase: "install-failed",
  },
  "install-recovery-inspect": {
    ...installing({ step: 2, nodeChecked: true, recovery: "inspect" }),
    phase: "install-failed",
  },
  "install-download": installFailed("download", 0, { cleanup: "removed" }),
  "install-download-space": installFailed("download-space", 0, { cleanup: "removed" }),
  "install-fingerprint": installFailed("fingerprint", 0, { cleanup: "removed" }),
  "install-installer": installFailed("installer", 1, { exitCode: 1, cleanup: "removed" }),
  "install-node": installFailed("node-not-checked", 1, { cleanup: "removed" }),
  "install-unproven": installFailed("write", 1, { cleanup: "unproven" }),
  "install-onboard": installFailed("onboard", 2, {
    exitCode: 1,
    classification: "startup-blocked",
    cleanup: "kept",
  }),
  "install-service": installFailed("service", 2, { exitCode: 1, cleanup: "kept" }),
  "install-service-removed": installFailed("service", 2, { exitCode: 1, cleanup: "removed" }),
  "install-download-short": installFailed("download-short", 0, { cleanup: "removed" }),
  "install-unpack": installFailed("unpack", 0, { cleanup: "removed" }),
  "install-installer-changed": installFailed("installer-changed", 1, { cleanup: "removed" }),
  "install-no-program": installFailed("no-program", 1, { cleanup: "removed" }),
  "install-service-appeared": installFailed("service-appeared", 2, {
    exitCode: 0,
    cleanup: "kept",
  }),
  "install-not-answering": installFailed("not-answering", 3, { cleanup: "kept" }),
  "install-exists": installFailed("exists", -1),
  "install-user-service": installFailed("user-service", -1),
  "install-changed": installFailed("changed", -1),
  "install-unchecked": installFailed("unchecked", -1),
  "install-expired": installFailed("expired", -1),
  /** An earlier attempt of Clawtrate's that never reached onboarding: setting up removes it first. */
  "not-found-leftover": looked({ ...notFound, leftover: true }),
  /** The gateway Clawtrate set up, found by the look that follows the install. */
  "found-installed": looked({ ...localLook, profile: "clawtrate", port: 52114 }),
};

/** The connection of the `local-refused` scenes: the saved gateway's reconnect, refused. */
export const REFUSED_RECONNECT = {
  status: "error",
  retryAt: null,
  error: {
    code: "LOCAL_UNVERIFIED",
    message:
      "Clawtrate couldn't match what is listening at port 18789 to this account's OpenClaw profile.",
    hint: "Choose This computer to connect to it again, or use Advanced.",
  },
} as const;

/** What a scene's host publishes later, timed from when the interface first listens. */
export const SETUP_STEPS: Record<string, Array<{ after: number; setup: SetupState }>> = {
  "local-start": [{ after: 1_000, setup: { ...looked({ ...localLook }), unasked: true } }],
  "local-start-slow": [{ after: 4_500, setup: { ...looked({ ...localLook }), unasked: true } }],
  "local-empty-wait": [{ after: 1_000, setup: SETUP_STATES["local-not-found"]! }],
};

export function isSetupState(name: string | null): name is string {
  return name !== null && Object.hasOwn(SETUP_STATES, name);
}

/**
 * The desktop host, offering setup; `windows` is the same app on Windows. A `local-` scene is a
 * person's Mac app, with local connect and the Keychain, so a new pairing asks for full control.
 */
export function setupInfo(info: HostInfo, name: string): HostInfo {
  const install =
    name.startsWith("install-") ||
    name.startsWith("installing") ||
    name === "not-found-leftover" ||
    name === "found-installed";
  const local = install || name.startsWith("local-");
  return {
    ...info,
    kind: "desktop",
    devGateway: null,
    ...(local ? { fullControl: true } : {}),
    setup: {
      look: true,
      pair: true,
      platform: name === "windows" ? "win32" : "darwin",
      ...(local ? { local: true } : {}),
      ...(install ? { install: true } : {}),
    },
  };
}

/**
 * Each fixture's setup attempt, by its `set`: every setup command starts a new
 * one, and a delayed step of an earlier attempt does nothing.
 */
const attempts = new WeakMap<object, number>();

/**
 * The setup commands, answered as the host would: the look's steps, then
 * the running card; Connect's steps, then the app. The fixture has no
 * native dialog, so Connect goes straight to its steps.
 */
export function setupCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
  connected: () => ClawtrateState,
  later: (ms: number, run: () => void) => void,
  /** How Connect ends. */
  ending: "connected" | "protocol" | "token-refused" = "connected",
): boolean {
  const setup = (next: SetupState) => set({ ...get(), setup: next });
  const current = () => get().setup ?? initialSetupState;
  if (!command.type.startsWith("setup")) return false;
  const attempt = (attempts.get(set) ?? 0) + 1;
  attempts.set(set, attempt);
  const after = (ms: number, run: () => void) =>
    later(ms, () => {
      if (attempts.get(set) === attempt) run();
    });
  switch (command.type) {
    case "setupLook": {
      setup({ ...initialSetupState, phase: "looking", step: 0 });
      after(300, () => current().phase === "looking" && setup({ ...current(), step: 1 }));
      after(600, () => current().phase === "looking" && setup({ ...current(), step: 2 }));
      after(900, () => current().phase === "looking" && setup(looked({})));
      return true;
    }
    case "setupStart": {
      setup({ ...localStopped, phase: "starting" });
      after(300, () => setup({ ...current(), step: 1 }));
      after(900, () => setup(looked(localLook)));
      return true;
    }
    case "setupConnect": {
      setup({ ...current(), phase: "connecting", step: 0, failure: null, unasked: false });
      after(300, () => current().phase === "connecting" && setup({ ...current(), step: 1 }));
      after(600, () => current().phase === "connecting" && setup({ ...current(), step: 2 }));
      after(900, () => {
        if (current().phase !== "connecting") return;
        if (ending === "token-refused") {
          const look = current().look;
          setup({ ...failed("token-refused", { port: look?.port }), look });
          return;
        }
        if (ending === "protocol") {
          // As the client publishes a handshake refused for its protocol.
          const state = get();
          set({
            ...state,
            connection: {
              ...state.connection,
              status: "error",
              gatewayUrl: "ws://127.0.0.1:18789",
              retryAt: null,
              protocol: 5,
              error: {
                code: "PROTOCOL_MISMATCH",
                message:
                  "This gateway speaks protocol 5. This version of Clawtrate speaks protocol 4.",
                hint: null,
                protocol: { gateway: 5, client: 4 },
              },
            },
            setup: {
              ...current(),
              phase: "failed",
              failure: { kind: "other", exitCode: null, port: null, reason: null },
            },
          });
          return;
        }
        set({ ...connected(), setup: { ...current(), phase: "done" } });
      });
      return true;
    }
    case "setupInstall": {
      // As the host runs it after its dialog: the four steps, then the look finds the gateway.
      setup(installing(command.action === "continue" ? { step: 2, nodeChecked: true } : {}));
      const at = (ms: number, install: Partial<SetupInstall>) =>
        after(ms, () => current().phase === "installing" && setup(installing(install)));
      if (command.action !== "continue") {
        at(300, { step: 1 });
        at(500, { step: 1, nodeChecked: true });
        at(700, { step: 2, nodeChecked: true });
      }
      at(900, { step: 3, nodeChecked: true });
      after(1100, () => {
        if (current().phase !== "installing") return;
        setup({ ...SETUP_STATES["found-installed"]!, phase: "connecting" });
        after(900, () => {
          if (current().phase === "connecting") set(connected());
        });
      });
      return true;
    }
    case "setupCancel": {
      const { phase, look } = current();
      setup(
        phase === "looking" || !look
          ? initialSetupState
          : { ...initialSetupState, phase: "found", look },
      );
      return true;
    }
    case "setupReset":
      setup(initialSetupState);
      return true;
    default:
      return false;
  }
}
