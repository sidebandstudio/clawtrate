// Setting up on this computer (docs/design/setup.md §3 to §7): what the
// host's look found and where the setup stands, as plain data for the
// interface. The host fills it (apps/desktop/src/setup); nothing in it is a
// credential, a raw program output or a path the host runs.

/** The OpenClaw version this build is tested against (`docs/decisions.md`). */
export const TESTED_OPENCLAW_VERSION = "2026.10.6";

/** The gateway protocol the pinned client speaks, for a host's synthetic gateway. */
export { PROTOCOL_VERSION as GATEWAY_PROTOCOL } from "@openclaw/gateway-client/browser";

/** Below this version Clawtrate doesn't offer automatic setup: Clawtrate's choice. */
export const OLDEST_OPENCLAW_VERSION = "2026.7.0";

/**
 * What the look found (§4, §6). `running` is a found gateway of the tested
 * version; `untested` and `too-old` are found gateways of another version;
 * `stopped` is a program and its gateway's config with nothing listening.
 */
export type LookOutcome =
  | "running"
  | "untested"
  | "too-old"
  | "not-token"
  | "stopped"
  | "program-missing"
  | "cant-tell"
  /** The program was found but couldn't be started. */
  | "cant-run"
  /**
   * Local connect: OpenClaw's settings name a port where something answers, but
   * Clawtrate couldn't match it to this account's OpenClaw profile (`reason`: which check
   * failed, `ProofRefusalKind`).
   */
  | "unverified"
  | "not-found"
  | "windows";

/** Why the look couldn't tell, each shown in fixed copy. */
export type CantTellReason =
  | "timeout"
  | "shape"
  | "no-answer"
  | "not-set-up"
  /** The status probed, or its RPC answered, somewhere other than this computer's loopback on the gateway's port. */
  | "endpoint"
  /**
   * The installed OpenClaw has no command Clawtrate has verified as read-only:
   * its launcher may repair its own installation before any command runs, so
   * the look runs nothing (docs/decisions.md, "What the look runs").
   */
  | "read-only"
  /** Local connect: OpenClaw's settings file can't be used here (its form, its sign-in, its rights). */
  | "settings"
  /** Local connect: OpenClaw's settings turn TLS on, or don't certainly leave it off; it dials `ws://` only. */
  | "tls"
  | ProofRefusalKind;

/**
 * Why local connect's proof refused a socket, by the check that failed: who holds the
 * connection (another account's process, or none yet); matching what is listening to this
 * account's OpenClaw profile (its lock, its state database, the process the lock names); this
 * version's native module, where the app has a pin for it; OpenClaw's profile folder; that
 * folder replaced since its settings were read (another device or inode at its path); a
 * gateway whose lock names another settings file than the one read (`other-settings`); or the
 * check itself. A refusal says which check failed and no more: it never claims what program
 * holds the port.
 */
export type ProofRefusalKind =
  | "holder"
  | "not-gateway"
  | "not-published"
  | "folder"
  | "replaced"
  | "other-settings"
  | "unchecked";

/** Each refusal's words for the person, the same on a card and for a refused reconnect. */
export const PROOF_REFUSAL_LINES: Record<ProofRefusalKind, (port: number | null) => string> = {
  holder: (port) => `Clawtrate couldn't confirm who holds the connection at port ${port}.`,
  "not-gateway": (port) =>
    `Clawtrate couldn't match what is listening at port ${port} to this account's OpenClaw profile.`,
  "not-published": (port) =>
    `Clawtrate couldn't check this version's module for what is listening at port ${port}.`,
  folder: (port) =>
    `OpenClaw's profile folder on this Mac can be changed by others, or isn't where Clawtrate expects it, so Clawtrate doesn't check what is listening at port ${port}.`,
  replaced: (port) =>
    `OpenClaw's profile folder on this Mac was replaced since Clawtrate read its settings, so Clawtrate doesn't check what is listening at port ${port}.`,
  "other-settings": (port) =>
    `What is listening at port ${port} was started with another OpenClaw settings file than the one Clawtrate read, so Clawtrate can't tell how to connect to it.`,
  unchecked: (port) => `Clawtrate couldn't check what is listening at port ${port} on this Mac.`,
};

/** The gateway's service, as the status reports it for this gateway. `none`: it reports no matching unit. */
export type LookService =
  "launchagent" | "launchagent-stopped" | "systemd" | "systemd-stopped" | "none";

export type SetupLook = {
  outcome: LookOutcome;
  reason: CantTellReason | null;
  /** The running gateway's version, or the program's when nothing runs. */
  version: string | null;
  /** The profile's name: `default`, `clawtrate`, or a development instance's. */
  profile: string | null;
  /** The configured bind the status reported: `loopback` or `lan`; anything else is not reported. */
  listens: "loopback" | "lan" | null;
  service: LookService | null;
  port: number | null;
  /** For `not-token`: the gateway's other sign-in. */
  authMode: "password" | "none" | "trusted-proxy" | null;
  /** Whether this device has a saved pairing for that address: `new` when it hasn't. */
  access: "new" | "paired" | null;
  /** Other OpenClaw services and profiles the look saw, named and never used. */
  others: string[];
  /** An earlier setup attempt of Clawtrate's that never reached onboarding is there, and setting up removes it first. */
  leftover?: boolean;
};

/** Where Connect, or the look, failed (§7), each in fixed copy. */
export type SetupFailureKind =
  /** `openclaw qr` didn't make a code; `exitCode` says how it ended. */
  | "code-failed"
  /** The gateway refused the one-time code (`AUTH_BOOTSTRAP_TOKEN_INVALID`). */
  | "code-refused"
  /** The gateway granted another role or other scopes than exactly read. */
  | "grant"
  /** Nothing answered on the gateway's port. */
  | "unreachable"
  /** The facts changed between the host's dialog and its answer, or the dialog expired. */
  | "changed"
  /** This host can't confirm a pairing (the web preview). */
  | "no-dialog"
  /** The look refused to run here (`docs/development/setup.md`); `reason` says why. */
  | "refused"
  /** Connected, but the bots couldn't be read. */
  | "bots"
  /** Back couldn't close the connection setup opened; Back tries again. */
  | "cleanup"
  /** Local connect couldn't match a socket to this account's OpenClaw profile: no credential went. */
  | "unverified"
  /**
   * Local connect matched the port to the profile, but the gateway there never answered as its
   * settings file says it would (on `ws://`): it may have stopped, or run on settings changed since
   * it started (TLS on, for one). Advanced, or a look again.
   */
  | "unanswered"
  /** The connection failed in another way; the connection state says how. */
  | "other";

/**
 * Why a run that must look in a sandbox couldn't (`docs/development/setup.md`):
 * it was given none; its description's place or shape; its home and working
 * folder; its development instance's state, ownership or config; or a pairing
 * its scenario doesn't offer.
 */
export type SetupRefusal = "missing" | "file" | "home" | "state" | "pairing";

export type SetupFailure = {
  kind: SetupFailureKind;
  exitCode: number | null;
  port: number | null;
  /** For `refused`: what was refused; for `unverified`, which fact the proof refused. */
  reason: SetupRefusal | ProofRefusalKind | null;
};

export type SetupPhase =
  /** Nothing under way: the first screen. */
  | "idle"
  | "looking"
  /** The look's result is shown. */
  | "found"
  /** The host's dialog is open. */
  | "confirming"
  | "connecting"
  /** Connected through setup: the app takes over. */
  | "done"
  | "failed"
  /** Setting OpenClaw up on this computer (§10): the steps run. */
  | "installing"
  /** A step of setting OpenClaw up failed, or the install couldn't start. */
  | "install-failed";

/** The pinned OpenClaw release used by the desktop installer. */
export const INSTALL_OPENCLAW_VERSION = "2026.11.10";

/** The pinned Node.js that setup installs beside OpenClaw. */
export const INSTALL_NODE_VERSION = "24.22.1";

/**
 * Why setting OpenClaw up failed (§10), each in fixed copy.
 */
export type InstallFailureKind =
  /** A `clawtrate` folder, service or install record was there already. */
  | "exists"
  /** Clawtrate couldn't write a file of the install's (permission or space). */
  | "write"
  /** Linux: this session's systemd user manager can't be reached. */
  | "user-service"
  /** A download failed in transport, or answered other than 200. */
  | "download"
  /** A download ended before all its bytes arrived. */
  | "download-short"
  /** The disk ran out of space while a download was saved. */
  | "download-space"
  | "fingerprint"
  /** A checked download couldn't be unpacked. */
  | "unpack"
  /** The checked installer isn't the one this build was made for. */
  | "installer-changed"
  /** The installer stopped before it reported completion. */
  | "installer"
  /** The installed program couldn't be found, or isn't the checked one. */
  | "no-program"
  | "node-not-checked"
  | "onboard"
  /** Clawtrate couldn't confirm OpenClaw installed the profile's user service. */
  | "service"
  /**
   * A `clawtrate` service definition that doesn't run this install appeared
   * between the last check and OpenClaw's service install; it is left as it is.
   */
  | "service-appeared"
  | "not-answering"
  /** The facts changed between the look and the host's dialog, or before onboarding. */
  | "changed"
  /** After the host's dialog, the look's file checks couldn't be made or didn't finish in time. */
  | "unchecked"
  /** The host's dialog was answered after the prepared operation's two minutes. */
  | "expired";

/**
 * What a failed attempt left: nothing made (`none`); removed and proven
 * removed (`removed`); a cleanup that couldn't be proven (`unproven`); or files
 * intentionally kept after onboarding (`kept`).
 */
export type InstallCleanup = "none" | "removed" | "unproven" | "kept";

/** Onboarding's failure class, as its JSON names it, or the service it couldn't install. */
export type OnboardClassification =
  | "auth-mismatch"
  | "module-missing"
  | "service-missing"
  | "service-stopped"
  | "startup-blocked"
  | "not-listening"
  | "systemd-user-unavailable";

export type InstallFailure = {
  kind: InstallFailureKind;
  /** The step that failed, from 0; -1 when the install stopped before its first step. */
  step: number;
  exitCode: number | null;
  classification: OnboardClassification | null;
  /**
   * Whether Try again can start a new installation immediately. The host
   * confirmed the previous attempt’s files were removed.
   */
  retry: boolean;
  cleanup: InstallCleanup;
};

/** Where setting OpenClaw up stands (§10). */
export type InstallAction = "continue" | "replace";
export type InstallRecovery = InstallAction | "inspect";

export type SetupInstall = {
  /** Inspect marks an incomplete attempt without enough evidence to continue or remove it. */
  recovery?: InstallRecovery;
  /** The step under way, from 0; 4 once every step is done. */
  step: number;
  /** The installer reported that it used the checked Node.js. */
  nodeChecked: boolean;
  failure: InstallFailure | null;
};

export type SetupState = {
  phase: SetupPhase;
  /** The step under way while looking or connecting, from 0. */
  step: number;
  /** Set after 8 s of looking (§4). */
  slow: boolean;
  /**
   * A look the host started by itself, before the person chose anything: with local connect,
   * at start (setup-effortless.md §3). The interface shows it on the first screen.
   */
  unasked: boolean;
  look: SetupLook | null;
  failure: SetupFailure | null;
  /** Setting OpenClaw up, while it runs or after it failed; absent otherwise. */
  install?: SetupInstall | null;
};

export const initialSetupState: SetupState = {
  phase: "idle",
  step: 0,
  slow: false,
  unasked: false,
  look: null,
  failure: null,
};

/** Names of other services or profiles the look keeps, and their length. */
export const MAX_LOOK_OTHERS = 5;
export const MAX_LOOK_OTHER_CHARS = 96;

/** What a host that sets up on its own computer offers its viewers (`BridgePolicy.setup`). */
export type SetupHost = {
  /** Start the look on this computer, ending one under way. */
  look(): Promise<void>;
  /** End the look or the connect under way; the host ends its programs by PID. */
  cancel(): void;
  /**
   * Ask the host to pair with what the last look found. The host shows its own
   * dialog and runs nothing unless that dialog's answer is yes; with local
   * connect, this request is the consent (`SetupOffer.local`).
   */
  connect(): Promise<void>;
  /**
   * Ask the host to set OpenClaw up on this computer, after a look found
   * nothing, or to try again after a failed attempt. The host shows its own
   * dialog and downloads and runs nothing unless that dialog's answer is yes;
   * once the gateway answers, the host connects to it by itself.
   */
  install(action?: InstallAction): Promise<void>;
  /** Back to the first screen. */
  reset(): void;
};

/**
 * Whether the screens of setup are offered, and which: `look` runs on the
 * host's computer, `pair` needs a native dialog of the host's. `local`: the
 * host proves this computer's gateway itself (local connect), so Connect is
 * the consent and no dialog follows it. `install`: the host may set OpenClaw up here.
 */
export type SetupOffer = {
  look: boolean;
  pair: boolean;
  platform: string;
  local?: boolean;
  /** A person's packaged app that may set OpenClaw up on this computer (§10). */
  install?: boolean;
};
