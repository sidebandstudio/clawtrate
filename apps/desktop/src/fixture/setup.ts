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
  "code-failed-shape": failed("code-failed", { exitCode: 0 }),
  installing: installing({}),
  "installing-node": installing({ step: 1, nodeChecked: true }),
  "installing-gateway": installing({ step: 2, nodeChecked: true }),
  "installing-check": installing({ step: 3, nodeChecked: true }),
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
  "found-installed": looked({ profile: "clawtrate", port: 52114 }),
};

export function isSetupState(name: string | null): name is string {
  return name !== null && Object.hasOwn(SETUP_STATES, name);
}

/** The desktop host, offering setup; `windows` is the same app on Windows. */
export function setupInfo(info: HostInfo, name: string): HostInfo {
  return {
    ...info,
    kind: "desktop",
    devGateway: null,
    setup: {
      look: true,
      pair: true,
      platform: name === "windows" ? "win32" : "darwin",
      install: name !== "windows",
    },
  };
}

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
  /** How Connect ends: the app opens, or the gateway refuses its protocol. */
  ending: "connected" | "protocol" = "connected",
): boolean {
  const setup = (next: SetupState) => set({ ...get(), setup: next });
  const current = () => get().setup ?? initialSetupState;
  switch (command.type) {
    case "setupLook": {
      setup({ ...initialSetupState, phase: "looking", step: 0 });
      later(300, () => current().phase === "looking" && setup({ ...current(), step: 1 }));
      later(600, () => current().phase === "looking" && setup({ ...current(), step: 2 }));
      later(900, () => current().phase === "looking" && setup(looked({})));
      return true;
    }
    case "setupConnect": {
      setup({ ...current(), phase: "connecting", step: 0, failure: null });
      later(300, () => current().phase === "connecting" && setup({ ...current(), step: 1 }));
      later(600, () => current().phase === "connecting" && setup({ ...current(), step: 2 }));
      later(900, () => {
        if (current().phase !== "connecting") return;
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
      setup(installing({}));
      const at = (ms: number, install: Partial<SetupInstall>) =>
        later(ms, () => current().phase === "installing" && setup(installing(install)));
      at(300, { step: 1 });
      at(500, { step: 1, nodeChecked: true });
      at(700, { step: 2, nodeChecked: true });
      at(900, { step: 3, nodeChecked: true });
      later(1100, () => {
        if (current().phase === "installing") setup(SETUP_STATES["found-installed"]!);
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
