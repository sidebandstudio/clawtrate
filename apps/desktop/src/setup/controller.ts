// Setting up on this computer, as the host runs it (docs/design/setup.md
// §2, §4, §7): the look, the host's own confirmation before a pairing, the
// one-time code it makes and redeems itself, and what the interface sees.
// The interface can ask for a look, for Back and for Connect; it can't name
// a program, a port or a profile, and Connect does nothing until the host's
// dialog says yes.
//
// With local connect (docs/design/setup-effortless.md §3) the look reads
// OpenClaw's settings and checks that what listens at their port is held by
// this account and matches this account's OpenClaw profile instead
// (local-look.ts), and runs none of OpenClaw's programs. Pressing Connect is
// the consent: Connect reads the gateway's token afresh, dials each socket
// itself and checks it the same way, and pairs asking for full control where
// this device may hold it.
//
// Setting OpenClaw up (docs/design/setup.md §10) is offered with local connect only, after a
// look found nothing: one press, the host's own dialog, the install's steps (install.ts), and
// then the local look again. When that look proves the `clawtrate` gateway the install just
// set up, on its port, Connect follows by itself: the person's press and the dialog were the
// consent, and nothing else is asked.

import {
  GatewayChangedError,
  initialSetupState,
  SETUP_ENDPOINT_CHANGED,
  SETUP_PAIRING_APPEARED,
  SETUP_PAIRING_GONE,
  PROOF_REFUSAL_LINES,
  type ClawtrateClient,
  type ClawtrateState,
  type InstallAction,
  type SetupFailure,
  type SetupHost,
  type SetupState,
} from "@clawtrate/core";
import { proveFor, provedSockets, routeOf, type LocalConnect } from "./local-connect.ts";
import { lookLocally, readToken, type LocalFound } from "./local-look.ts";
import { refusalKind, type ProveRefusal } from "./local-prove.ts";
import { anythingHere, boundedFileIdentity, LIMITS, lookHere, type FoundGateway } from "./look.ts";
import { parseAuthMode, parseSetupCode, parseStatus } from "./parse.ts";
import type { ProgramResult } from "./programs.ts";
import type { Opened } from "./sandbox.ts";
import type { InstallOutcome, Installer } from "./install.ts";
import type { HeldToken } from "./settings-reader.ts";
import { guardPort, programPath, SetupRefusedError } from "./world.ts";

/** A prepared operation expires after this long and can't be repeated (§2). */
export const OPERATION_LIFETIME_MS = 2 * 60_000;
/** After this long, the look says it is still looking (§4). */
export const SLOW_LOOK_MS = 8_000;
const QR_LIMIT = { timeoutMs: 20_000, maxBytes: 16 * 1024 };

/** A program that ran to its end, in time and within its limit, and exited 0. */
const succeeded = (result: ProgramResult) =>
  result.exitCode === 0 && !result.timedOut && !result.tooLarge && !result.failed;

/** The connection a setup attempt opened, by its address. */
/** Setup's connection: its attempt, its address and the client's selection that made it. */
type Owned = { attempt: number; url: string; selection: number };

/** What the host's own dialog shows: its words, nothing the page wrote. */
export type Confirmation = { message: string; detail: string; confirm: string };

export type SetupControllerOptions = {
  client: ClawtrateClient;
  /**
   * The world the look and Connect run against and what answers their
   * commands, opened again for every look and every Connect: the real
   * computer and its programs, a sandbox and its stand-in (`sandbox.ts`), or
   * why there is none.
   */
  open: () => Promise<Opened | SetupRefusedError>;
  /** Ends every program the look started, by PID. */
  stopPrograms: () => void;
  /** The host's native dialog, or null where the host has none (the web preview). */
  confirm: ((confirmation: Confirmation) => Promise<boolean>) | null;
  /** The host's log: fixed lines only, never a program's output or a credential. */
  log?: (line: string) => void;
  now?: () => number;
  /**
   * Local connect (docs/design/setup-effortless.md §3), with the settings
   * reader's parse worker: the look reads OpenClaw's settings, and every socket
   * of a setup connection is dialled by the host and its far end matched to this
   * account's OpenClaw profile, before its first byte and again before its credential. Only a
   * person's packaged Mac app turns it on (`localConnectFor`).
   */
  localConnect?: LocalConnect & { worker: URL };
  /**
   * A new installer for each attempt to set OpenClaw up (`install.ts`), or null where this
   * host doesn't set OpenClaw up: every development or automated run, a host without local
   * connect, and the web preview. Ignored without `localConnect`: the gateway an install
   * sets up is connected to through local connect alone.
   */
  installer?: (() => Installer) | null;
};

/** The host's dialog before setting OpenClaw up (§2, §10): the one question it asks. */
export const INSTALL_CONFIRMATION: Confirmation = {
  message: "Set up OpenClaw on this computer?",
  detail:
    "Clawtrate downloads and sets up OpenClaw for your account only. It connects this Mac with full control.",
  confirm: "Set Up OpenClaw",
};

const RECOVERY_CONFIRMATION: Record<InstallAction, Confirmation> = {
  continue: {
    message: "Continue setting up OpenClaw?",
    detail:
      "Clawtrate uses the gateway profile it already set up, finishes setting up its service, and connects this Mac with full control.",
    confirm: "Continue",
  },
  replace: {
    message: "Remove this setup attempt and start again?",
    detail:
      "Clawtrate removes the program and gateway profile created by this attempt. It will check new OpenClaw and Node.js downloads. npm also downloads packages Clawtrate hasn't verified. They can run with your account's permissions. Clawtrate connects this Mac with full control.",
    confirm: "Remove and Start Again",
  },
};

/** Said when a look, a Connect or a second install is asked for while one is under way. */
const BUSY = "OpenClaw is being set up. Wait until it finishes.";

/**
 * The dialog's words (§2, "The host's confirmation"). Connect asks for read
 * access, always: a device with a saved pairing for this address reconnects
 * asking for read alone.
 */
export function pairConfirmation(
  found: FoundGateway,
  access: "new" | "paired" = "new",
): Confirmation {
  const where = `the ${found.profile.name} gateway on this computer`;
  if (access === "paired")
    return {
      message: `Connect this device read-only to ${where}?`,
      detail: "This device has a saved pairing for this address.",
      confirm: "Connect read-only",
    };
  return {
    message: `Pair this device read-only with ${where}?`,
    detail: "Clawtrate asks for read access. The gateway may ask its owner to approve this device.",
    confirm: "Pair",
  };
}

/**
 * The connector's last proof of a socket, for an attempt that is still the current one after
 * the proof as well as before it: a Back while it ran (up to the proof's 2 s) sends nothing.
 */
export function provedWhile(
  current: () => boolean,
  verify: (signal: AbortSignal) => Promise<boolean>,
): (signal: AbortSignal) => Promise<boolean> {
  return async (signal) => current() && (await verify(signal)) && !signal.aborted && current();
}

export class SetupController implements SetupHost {
  private readonly options: SetupControllerOptions;
  private state: SetupState = initialSetupState;
  /** Counts looks and connects; anything finishing for an older one is dropped. */
  private attempt = 0;
  private found: FoundGateway | null = null;
  /** With local connect: what its look found. */
  private localFound: LocalFound | null = null;
  /** The next look is the host's own, at start (`lookAtStart`). */
  private unasked = false;
  /** The connection this setup attempt opened, by attempt and address: the only one Back closes. */
  private owned: Owned | null = null;
  /** Closing `owned`, while that is under way: one at a time, for that owner only. */
  private cleaning: { owned: Owned; done: Promise<boolean> } | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private watching: (() => void) | null = null;
  private readonly now: () => number;
  /**
   * Held by setting OpenClaw up from its dialog to the look that follows: no other look,
   * Connect or second install starts meanwhile (§10).
   */
  private busy = false;
  /** Set when the app quits: nothing new starts, a dialog's answer included. */
  private closed = false;
  /** Setting OpenClaw up, from its dialog to the look that follows, while it runs. */
  private operation: Promise<void> | null = null;

  constructor(options: SetupControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    options.client.setSetup(this.state);
    // Back to the first screen once a gateway set up here is let go.
    options.client.store.subscribe((state) => {
      if (this.state.phase === "done" && state.connection.status === "idle")
        this.publish(initialSetupState);
    });
  }

  get current(): SetupState {
    return this.state;
  }

  private publish(next: SetupState): void {
    this.state = next;
    this.options.client.setSetup(next);
  }

  private log(line: string): void {
    this.options.log?.(`[setup] ${line}`);
  }

  private fail(failure: Partial<SetupFailure> & Pick<SetupFailure, "kind">): void {
    this.publish({
      ...this.state,
      phase: "failed",
      failure: { exitCode: null, port: null, reason: null, ...failure },
    });
  }

  /** The world and its runner; throws `SetupRefusedError`. */
  private async open(): Promise<Opened> {
    let opened: Opened | SetupRefusedError;
    try {
      opened = await this.options.open();
    } catch {
      opened = new SetupRefusedError("file");
    }
    if (opened instanceof SetupRefusedError) throw opened;
    return opened;
  }

  /** Loud, in fixed words: the log names the refusal, never an error's own text. */
  private refused(error: unknown): void {
    const refusal = error instanceof SetupRefusedError ? error : new SetupRefusedError("file");
    this.log(refusal.message);
    this.publish({
      ...initialSetupState,
      look: this.state.look,
      phase: "failed",
      failure: { kind: "refused", exitCode: null, port: null, reason: refusal.reason },
    });
  }

  async look(): Promise<void> {
    if (this.closed) return;
    if (this.busy) throw new Error(BUSY);
    return this.lookNow();
  }

  private async lookNow(): Promise<void> {
    this.stopWatching();
    // Another look: the earlier one's programs end before this one asks anything.
    this.options.stopPrograms();
    const attempt = (this.attempt += 1);
    this.found = null;
    this.localFound = null;
    this.clearSlow();
    const local = this.options.localConnect;
    if (local) return this.lookLocally(local, attempt);
    let opened: Opened;
    try {
      opened = await this.open();
    } catch (error) {
      // Loud: in the log, and in the interface as its own failure.
      if (attempt === this.attempt) this.refused(error);
      return;
    }
    if (attempt !== this.attempt) return;
    this.publish({ ...initialSetupState, phase: "looking" });
    this.slowTimer = setTimeout(() => {
      if (attempt === this.attempt && this.state.phase === "looking")
        this.publish({ ...this.state, slow: true });
    }, SLOW_LOOK_MS);
    let refusal: SetupRefusedError | null = null;
    const report = await lookHere(opened.world, opened.run, {
      identify: opened.identify,
      ...(opened.assertActive ? { checkActive: opened.assertActive } : {}),
      onStep: (step) => {
        if (attempt === this.attempt && this.state.phase === "looking")
          this.publish({ ...this.state, step });
      },
      cancelled: () => attempt !== this.attempt,
    }).catch((error: unknown) => {
      // A sandbox that stopped passing mid-look is a refusal, not an answer of the wrong shape.
      if (error instanceof SetupRefusedError) refusal = error;
      return null;
    });
    if (attempt !== this.attempt) return;
    if (refusal) {
      this.clearSlow();
      this.refused(refusal);
      return;
    }
    this.clearSlow();
    if (!report) {
      this.publish({
        ...initialSetupState,
        phase: "found",
        look: {
          outcome: "cant-tell",
          reason: "shape",
          version: null,
          profile: null,
          listens: null,
          service: null,
          port: null,
          authMode: null,
          access: null,
          others: [],
        },
      });
      return;
    }
    this.found = report.found;
    // What this device can already do on the gateway found, said on its card and in the dialog.
    const access = report.found
      ? await this.options.client.deviceAccess(report.found.url).catch(() => "new" as const)
      : null;
    if (attempt !== this.attempt) return;
    try {
      opened.assertActive?.();
    } catch (error) {
      this.found = null;
      this.refused(error);
      return;
    }
    this.publish({
      ...initialSetupState,
      phase: "found",
      look: access ? { ...report.look, access } : report.look,
    });
  }

  /**
   * The look the host starts by itself, before the person chooses anything: with local connect
   * only, whose look reads files, checks one socket against the profile and sends nothing. Its result is shown on
   * the first screen (`SetupState.unasked`).
   */
  async lookAtStart(): Promise<void> {
    if (!this.options.localConnect || this.state.phase !== "idle" || this.busy) return;
    this.unasked = true;
    await this.look();
  }

  /**
   * For the app's quit: nothing more starts, whatever answer or step comes next, and this
   * resolves once setting OpenClaw up and the look that follows it have ended. The caller
   * aborts the install's downloads and ends its programs.
   */
  close(): Promise<void> {
    this.closed = true;
    this.attempt += 1;
    this.clearSlow();
    this.stopWatching();
    return this.operation ?? Promise.resolve();
  }

  /** The installer this host offers, or null: with local connect only. */
  private get installer(): (() => Installer) | null {
    return this.options.installer ?? null;
  }

  /** Whether an install is under way: from its dialog's answer to the look that follows. */
  private get installing(): boolean {
    return this.state.phase === "installing" || (this.busy && this.state.phase !== "confirming");
  }

  /**
   * The look with local connect: OpenClaw's settings, and one socket whose far end is checked
   * against this account's OpenClaw profile, with nothing sent.
   */
  private async lookLocally(local: LocalConnect & { worker: URL }, attempt: number): Promise<void> {
    const unasked = this.unasked;
    this.unasked = false;
    this.publish({ ...initialSetupState, phase: "looking", unasked });
    let report;
    try {
      report = await lookLocally(
        local,
        local.worker,
        (step) => {
          if (attempt === this.attempt && this.state.phase === "looking")
            this.publish({ ...this.state, step });
        },
        () => attempt !== this.attempt,
      );
    } catch (error) {
      if (attempt === this.attempt) this.refused(error);
      return;
    }
    if (attempt !== this.attempt || !report) return;
    this.localFound = report.found;
    const access = report.found
      ? await this.options.client.deviceAccess(report.found.url).catch(() => "new" as const)
      : null;
    let look = access ? { ...report.look, access } : report.look;
    if (look.outcome === "not-found" && this.installer) {
      const leftover = await this.leftoverProgram();
      const signs = await this.installSite(leftover);
      if (signs === "something") look = { ...look, outcome: "program-missing" };
      else if (signs !== "nothing") look = { ...look, outcome: "cant-tell", reason: "shape" };
      else if (leftover) look = { ...look, leftover: true };
    }
    const recovery =
      look.outcome !== "running" || look.profile === "clawtrate"
        ? await this.installRecovery()
        : null;
    if (attempt !== this.attempt) return;
    if (recovery) {
      this.publish({
        ...initialSetupState,
        phase: "install-failed",
        look,
        install: { step: 2, nodeChecked: true, failure: null, recovery: recovery.action },
      });
      return;
    }
    this.publish({ ...initialSetupState, phase: "found", unasked, look });
  }

  /** The install preflight reads paths only. A newly found program is never run. */
  private async installSite(leftover: string | null): ReturnType<typeof anythingHere> {
    try {
      const opened = await this.open();
      return await anythingHere(opened.world, leftover);
    } catch {
      return "unreadable";
    }
  }

  private installRecovery(make = this.installer) {
    return (
      make?.()
        .recovery?.()
        .catch(() => null) ?? Promise.resolve(null)
    );
  }

  /** The program of a proven early leftover of Clawtrate's own, or null. */
  private async leftoverProgram(): Promise<string | null> {
    const make = this.installer;
    if (!make) return null;
    return make()
      .leftoverProgram()
      .catch(() => null);
  }

  cancel(): void {
    const phase = this.state.phase;
    // Cancelling an install isn't offered in this version (§10): it runs to its end, and the
    // look after it too. Only its dialog can be left.
    if (this.installing) return;
    if (phase === "install-failed") {
      // What a failed attempt left is looked at again before anything else is offered.
      void this.lookNow();
      return;
    }
    this.attempt += 1;
    this.clearSlow();
    this.options.stopPrograms();
    if (phase === "looking") {
      this.publish(initialSetupState);
      return;
    }
    if (phase === "confirming") {
      // The dialog's answer, when it comes, is for an attempt that is over.
      this.publish({ ...this.state, phase: "found" });
      return;
    }
    if (phase === "connecting" || phase === "failed") {
      this.stopWatching();
      // The screen stays until the cleanup settles: the found card only once setup's connection
      // is closed, for this Back; a cleanup that failed says so (closeOwned), and Back tries again.
      const attempt = this.attempt;
      void this.closeOwned().then((closed) => {
        if (!closed || attempt !== this.attempt) return;
        this.publish(
          this.state.look
            ? { ...initialSetupState, phase: "found", look: this.state.look }
            : initialSetupState,
        );
      });
    }
  }

  reset(): void {
    if (this.installing) return;
    this.attempt += 1;
    this.clearSlow();
    this.stopWatching();
    this.options.stopPrograms();
    this.found = null;
    this.localFound = null;
    void this.closeOwned();
    this.publish(initialSetupState);
  }

  /**
   * Closes the connection this setup opened, connected or not, while its bots
   * load too, and one still waiting to open: the disconnect waits behind it in
   * the client's queue. Another gateway selected since is never touched. The
   * connection stays setup's own until the client has forgotten it, or says
   * another gateway is selected: a cleanup that failed (its settings couldn't
   * be deleted, so it stays connected) says so, and Back or Connect tries it
   * again. A cleanup under way is shared, and its answer changes the screen
   * only for the owner and the attempt it was asked for. True once closed.
   */
  private async closeOwned(): Promise<boolean> {
    const owned = this.owned;
    if (!owned) return true;
    const attempt = this.attempt;
    let cleaning = this.cleaning;
    if (cleaning?.owned !== owned) {
      const done = this.options.client.disconnect(owned.url, owned.selection).then(
        () => true,
        // Refused because another gateway is selected by then: that one stays as it is.
        (error: unknown) => error instanceof GatewayChangedError,
      );
      const entry = { owned, done };
      cleaning = this.cleaning = entry;
      void done.then(() => {
        if (this.cleaning === entry) this.cleaning = null;
      });
    }
    if (await cleaning.done) {
      if (this.owned === owned) this.owned = null;
      return true;
    }
    if (this.owned === owned && attempt === this.attempt) this.fail({ kind: "cleanup" });
    return false;
  }

  /**
   * Before setup asks anything, ends an earlier connection that didn't finish:
   * Connect replaces the selected gateway, as Advanced's Connect does, and the
   * later choice is the one kept. A connected one is replaced when setup's own
   * connection opens.
   */
  private async letGo(): Promise<void> {
    const status = this.options.client.state.connection.status;
    if (status !== "idle" && status !== "connected") await this.options.client.disconnect();
  }

  /**
   * Sets OpenClaw up on this computer (§10), offered after a look found nothing, or after an
   * attempt that failed before onboarding and was removed. Nothing is downloaded or run until
   * the host's dialog says yes; the prepared operation expires as Connect's does. When every
   * step is done the look runs again, and when it proves the gateway just set up, Connect
   * follows by itself.
   */
  async install(action?: InstallAction): Promise<void> {
    if (this.busy) throw new Error(BUSY);
    const { phase, look, install } = this.state;
    const retry = phase === "install-failed" && install?.failure?.retry === true;
    const recovery = phase === "install-failed" ? install?.recovery : undefined;
    if (
      action
        ? !recovery || recovery === "inspect" || (action === "replace" && recovery !== "replace")
        : !retry && !(phase === "found" && look?.outcome === "not-found")
    )
      throw new Error("There is nothing to set up here. Look again.");
    const make = this.options.installer;
    const confirm = this.options.confirm;
    const local = this.options.localConnect;
    if (!make || !confirm || !local) throw new Error("This host doesn't set OpenClaw up.");
    if (this.closed) return;
    this.busy = true;
    const operation = this.installHeld(make, confirm, action);
    this.operation = operation.then(
      () => {},
      () => {},
    );
    let connectNow: boolean;
    try {
      connectNow = await operation;
    } finally {
      this.busy = false;
      this.operation = null;
    }
    // The gateway just set up, proved: the press and the dialog were the consent (§10).
    if (connectNow && !this.closed) await this.connectLocally(local);
  }

  /** The install from its dialog to the look that follows; true when Connect may follow. */
  private async installHeld(
    make: () => Installer,
    confirm: (confirmation: Confirmation) => Promise<boolean>,
    action?: InstallAction,
  ): Promise<boolean> {
    const { look } = this.state;
    const attempt = (this.attempt += 1);
    const at = this.now();
    const before = this.state;
    this.publish({ ...this.state, phase: "confirming", failure: null, unasked: false });
    const pending = action ? await this.installRecovery(make) : null;
    if (attempt !== this.attempt) return false;
    if (
      action &&
      (!pending ||
        pending.action === "inspect" ||
        (action === "replace" && pending.action !== "replace"))
    ) {
      await this.lookNow();
      return false;
    }
    let yes: boolean;
    try {
      yes = await confirm(action ? RECOVERY_CONFIRMATION[action] : INSTALL_CONFIRMATION);
    } catch {
      yes = false;
    }
    if (attempt !== this.attempt) return false;
    if (!yes) {
      // Nothing was downloaded or run.
      this.publish(before);
      return false;
    }
    const start = { step: 0, nodeChecked: false, failure: null };
    const stoppedBefore = (kind: "expired" | "changed" | "unchecked") =>
      this.publish({
        ...initialSetupState,
        look,
        phase: "install-failed",
        install: {
          ...start,
          failure: {
            kind,
            step: -1,
            exitCode: null,
            classification: null,
            retry: false,
            cleanup: "none",
          },
        },
      });
    if (this.now() - at > OPERATION_LIFETIME_MS) {
      stoppedBefore("expired");
      return false;
    }
    const again = action ? "nothing" : await this.installSite(await this.leftoverProgram());
    if (attempt !== this.attempt) return false;
    if (again === "unreadable" || again === "timeout") {
      this.log("the file checks couldn't be made again after the dialog");
      stoppedBefore("unchecked");
      return false;
    }
    if (again === "something") {
      this.log("a sign of OpenClaw appeared after the look");
      stoppedBefore("changed");
      return false;
    }
    // The look can take its time: the consent's two minutes hold after it too.
    if (this.now() - at > OPERATION_LIFETIME_MS) {
      stoppedBefore("expired");
      return false;
    }
    this.publish({ ...initialSetupState, look, phase: "installing", install: start });
    let outcome: InstallOutcome;
    try {
      outcome = await make().run(
        (progress) => {
          if (attempt === this.attempt) this.publish({ ...this.state, install: progress });
        },
        action,
        pending?.id,
      );
    } catch (error) {
      this.log(
        error instanceof Error && error.name === "InstallRefusedError"
          ? error.message
          : "setting OpenClaw up stopped",
      );
      outcome = {
        ok: false,
        failure: {
          kind: "installer",
          step: this.state.install?.step ?? 0,
          exitCode: null,
          classification: null,
          retry: false,
          cleanup: "unproven",
        },
      };
    }
    if (attempt !== this.attempt) return false;
    if (!outcome.ok) {
      this.log(`setting OpenClaw up failed: ${outcome.failure.kind}`);
      const recovery = outcome.failure.retry ? null : await this.installRecovery(make);
      if (attempt !== this.attempt) return false;
      this.publish({
        ...this.state,
        phase: "install-failed",
        install: {
          ...(this.state.install ?? start),
          failure: outcome.failure,
          ...(recovery ? { recovery: recovery.action } : {}),
        },
      });
      return false;
    }
    // The look finds what was set up; Connect follows only for that gateway, on its port.
    await this.lookNow();
    const found = this.localFound;
    return (
      !this.closed &&
      this.state.phase === "found" &&
      this.state.look?.outcome === "running" &&
      found?.profile === "clawtrate" &&
      found.port === outcome.port
    );
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    if (this.busy) throw new Error(BUSY);
    const local = this.options.localConnect;
    if (local) return this.connectLocally(local);
    const found = this.found;
    const phase = this.state.phase;
    if (
      (phase !== "found" && phase !== "failed") ||
      !found ||
      this.state.look?.outcome !== "running"
    ) {
      throw new Error("There is nothing to connect to. Look again.");
    }
    // Setup's own earlier connection, one Back couldn't close included, is closed first. A
    // cleanup is shared, so after it only the request whose attempt still stands goes on: two
    // Connects that waited for the same cleanup never both reach the dialog.
    const before = this.attempt;
    if (this.owned && !(await this.closeOwned())) return;
    if (this.found !== found || this.attempt !== before) return;
    const attempt = (this.attempt += 1);
    const confirm = this.options.confirm;
    if (!confirm) {
      this.fail({ kind: "no-dialog" });
      return;
    }
    // Prepared from the host's own state; the page gave nothing but the request.
    const prepared = { found, at: this.now(), used: false };
    const expired = () => this.now() - prepared.at > OPERATION_LIFETIME_MS;
    this.publish({ ...this.state, phase: "confirming", failure: null });
    const access = this.state.look?.access ?? "new";
    let yes: boolean;
    try {
      yes = await confirm(pairConfirmation(found, access));
    } catch {
      yes = false;
    }
    if (attempt !== this.attempt) return;
    if (!yes) {
      // Nothing was minted or registered.
      this.publish({ ...this.state, phase: "found" });
      return;
    }
    if (prepared.used || expired()) {
      this.fail({ kind: "changed" });
      return;
    }
    prepared.used = true;
    let opened: Opened;
    try {
      opened = await this.open();
      if (attempt !== this.attempt) return;
      // A sandbox pairs only in its pairing scenario, with the host's own synthetic gateway.
      if (!opened.world.pairs) throw new SetupRefusedError("pairing");
      guardPort(found.port, opened.world);
    } catch (error) {
      if (attempt === this.attempt) this.refused(error);
      return;
    }
    this.publish({ ...this.state, phase: "connecting", step: 0, failure: null });
    try {
      await this.connectOpened(attempt, opened, found, expired, access);
    } catch (error) {
      if (attempt !== this.attempt) return;
      this.stopWatching();
      void this.closeOwned();
      // A sandbox that stopped passing: refused in fixed words, and setup's own connection closed.
      if (error instanceof SetupRefusedError) this.refused(error);
      // Anything else that failed here (a saved record that can't be read): a failure to try again from.
      else this.fail({ kind: "other" });
    }
  }

  /** Connect after the dialog, on an opened world: throws `SetupRefusedError`. */
  private async connectOpened(
    attempt: number,
    opened: Opened,
    found: FoundGateway,
    expired: () => boolean,
    /** What the card and the dialog offered: reuse this device's saved pairing, or a new one. */
    access: "new" | "paired",
  ): Promise<void> {
    const client = this.options.client;
    const changedNow = () => {
      if (attempt === this.attempt) this.fail({ kind: "changed" });
    };
    // After the dialog: the same listener, before anything else.
    if (!this.sameListener(opened, found)) return changedNow();
    await this.letGo();
    // A setup cancelled while the earlier connection was let go starts nothing more.
    if (attempt !== this.attempt) return;
    if (!this.sameListener(opened, found)) return changedNow();
    const paired = await client.hasDeviceToken(found.url);
    if (attempt !== this.attempt) return;
    if (!this.sameListener(opened, found)) return changedNow();
    // The person agreed to what the dialog named: reusing this device's saved pairing, or a new
    // pairing. A pairing gone or appeared since, and the card asks again.
    if (paired !== (access === "paired"))
      return paired ? this.pairingAppeared() : this.pairingGone();
    // The facts are read again after every wait that can be long, and the consent's two
    // minutes hold on every branch: anything other than what the dialog named, and nothing runs.
    const changed = async () => !(await this.unchanged(opened, found)) || expired();
    if (await changed()) {
      if (attempt === this.attempt) this.fail({ kind: "changed" });
      return;
    }
    if (attempt !== this.attempt) return;
    // Every socket the client opens for this, retries included, finds the same listener first;
    // a sandbox that stopped passing then is refused, and the client opens nothing.
    const listening = () => {
      // An attempt that is over opens nothing, even a connection still waiting in the client's queue.
      if (attempt !== this.attempt) return false;
      try {
        return this.sameListener(opened, found);
      } catch (error) {
        if (attempt === this.attempt) {
          this.stopWatching();
          this.refused(error);
        }
        return false;
      }
    };
    // Once each socket is up and again just before its credential goes, the endpoint's
    // listener is read again: the port's listener by PID and start time, the endpoint, the
    // program file, as the look found them. Any difference sends nothing (docs/decisions.md).
    // The client's signal ends with the socket or the reads' shared time: the commands stop then.
    const verify = async (signal: AbortSignal) => {
      if (attempt !== this.attempt) return false;
      try {
        return (
          (await this.unchanged(opened, found, signal)) &&
          !signal.aborted &&
          attempt === this.attempt
        );
      } catch (error) {
        if (attempt === this.attempt) {
          this.stopWatching();
          this.refused(error);
        }
        return false;
      }
    };
    if (paired) {
      // A saved pairing for this address: reused, asking for read alone (§7).
      this.publish({ ...this.state, step: 1 });
      // The selection this connect makes: its cleanup and its readiness are that one's only.
      const selection = client.nextSelection();
      this.owned = { attempt, url: found.url, selection };
      this.watch(attempt, found.url, found.port, selection);
      await client.connectForSetup(found.url, {
        check: listening,
        verify,
        consent: () => !expired(),
      });
      return;
    }
    const made = await opened.run({
      program: found.program,
      args: [...found.profile.args, "qr", "--json", "--voice-node", "--url", found.url],
      env: { ...opened.world.env, PATH: programPath(found.program), ...found.profile.env },
      cwd: opened.world.cwd,
      ...QR_LIMIT,
    });
    if (attempt !== this.attempt) return;
    const code = succeeded(made) ? parseSetupCode(made.stdout, found.url, this.now()) : null;
    if (!code) {
      this.fail({ kind: "code-failed", exitCode: made.exitCode });
      return;
    }
    // The listener is checked again after the code is made and before it is sent.
    if (await changed()) {
      if (attempt === this.attempt) this.fail({ kind: "changed" });
      return;
    }
    if (attempt !== this.attempt) return;
    this.publish({ ...this.state, step: 1 });
    const selection = client.nextSelection();
    this.owned = { attempt, url: found.url, selection };
    this.watch(attempt, found.url, found.port, selection);
    // Handed to the client and dropped here: the code lives in the client's memory until its hello.
    await client.connectWithSetupCode(code, {
      check: listening,
      verify,
      consent: () => !expired(),
    });
  }

  /**
   * Connect with local connect. Pressing Connect is the consent (§3): no dialog
   * follows, and it holds for this attempt's two minutes. The token is read
   * afresh from the settings of the profile the look found, at the port it
   * found, and handed to the client for this one pairing; this host drops its
   * copy once the client has it. Every socket is dialled here and checked against
   * the profile before its first byte and again just before its credential; the
   * first that fails ends the attempt, with nothing sent. The gateway is saved with its profile's
   * folder and that folder's identity as its route (`routeOf`), never as a typed
   * address.
   */
  private async connectLocally(local: LocalConnect & { worker: URL }): Promise<void> {
    const found = this.localFound;
    const phase = this.state.phase;
    if (
      (phase !== "found" && phase !== "failed") ||
      !found ||
      this.state.look?.outcome !== "running"
    ) {
      throw new Error("There is nothing to connect to. Look again.");
    }
    const before = this.attempt;
    if (this.owned && !(await this.closeOwned())) return;
    if (this.localFound !== found || this.attempt !== before) return;
    const attempt = (this.attempt += 1);
    const at = this.now();
    const current = () => attempt === this.attempt;
    const consent = () => current() && this.now() - at <= OPERATION_LIFETIME_MS;
    this.publish({ ...this.state, phase: "connecting", step: 0, failure: null, unasked: false });
    let token: HeldToken | null = null;
    try {
      token = await readToken(local, local.worker, found);
      if (!current()) return;
      if (!token) return this.fail({ kind: "changed" });
      // The earlier gateway isn't let go: the client replaces it only once this device is
      // paired here, and selects it again if this attempt fails or is let go.
      // The first socket the check refuses, at its dial or before its credential, ends this
      // attempt: nothing went on it, and setup's connection is closed. Once setup is done, a
      // refused socket is the client's to say (`refusal`): the connection stays the person's.
      let latest: ProveRefusal | null = null;
      const unverified = (why: ProveRefusal) => {
        latest = why;
        this.log(`couldn't verify what is listening at port ${found.port} (${why})`);
        if (!current() || this.state.phase === "failed" || this.state.phase === "done") return;
        this.stopWatching();
        void this.closeOwned();
        this.fail({ kind: "unverified", port: found.port, reason: refusalKind(why) });
      };
      const proveOne = proveFor(local, found, found.port, unverified);
      const prove = async (localPort: number, live: () => boolean = () => true) => {
        const proved = await proveOne(localPort, live);
        if (proved && live()) latest = null;
        if (proved && current() && this.state.step === 0) this.publish({ ...this.state, step: 1 });
        return proved;
      };
      const sockets = provedSockets(found.port, prove);
      const client = this.options.client;
      const selection = client.nextSelection();
      this.owned = { attempt, url: found.url, selection };
      // From the first paired hello the connection is the person's (`watch`): its later sockets'
      // last check is their own, no longer this attempt's, which Back or a new look ends.
      let kept = false;
      this.watch(attempt, found.url, found.port, selection, true, () => (kept = true));
      // Until then, a socket only while this attempt is still Connecting. Once it has failed, the
      // client's own retry may come due before setup's disconnect is through the client's queue:
      // that retry dials nothing.
      const createSocket = (url: string) => {
        if (!kept && !(current() && this.state.phase === "connecting"))
          throw new Error("This Connect has ended.");
        return sockets.createWebSocket(url);
      };
      await client.connect(
        { url: found.url, token: token.reveal() },
        {
          createSocket,
          prove: provedWhile(() => current() || kept, sockets.verify),
          route: routeOf(found),
          consent,
          refusal: () =>
            latest === null ? null : PROOF_REFUSAL_LINES[refusalKind(latest)](found.port),
        },
      );
    } catch (error) {
      if (!current()) return;
      this.stopWatching();
      void this.closeOwned();
      if (error instanceof SetupRefusedError) this.refused(error);
      else this.fail({ kind: "other" });
    } finally {
      // The client holds the token for its pairing now; this host keeps no copy.
      token?.drop();
    }
  }

  /**
   * The same process, by PID and start time, still listens where the look
   * found the gateway; in a sandbox, the description still passes (it throws
   * the refusal otherwise) and the host's own synthetic gateway still owns
   * the listener at exactly that endpoint.
   */
  private sameListener(opened: Opened, found: FoundGateway): boolean {
    opened.assertActive?.();
    if (
      opened.world.kind === "sandbox" &&
      (found.listener.pid !== process.pid ||
        found.url !== `ws://127.0.0.1:${found.port}` ||
        !opened.world.portAllowed(found.port) ||
        !opened.ownsListener?.(found.port))
    )
      return false;
    const now = opened.identify(found.listener.pid);
    return now.state === "alive" && now.identity === found.listener.started;
  }

  /**
   * Whether the profile's gateway still is what the dialog named: the same
   * program file, the same endpoint, config files, service and version, the
   * same listener by PID and start time, and token sign-in, each command
   * having finished in time and within its limit.
   */
  private async unchanged(
    opened: Opened,
    found: FoundGateway,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { world, run } = opened;
    const identity = world.installed ? "stand-in" : await boundedFileIdentity(found.program);
    if (identity !== found.programIdentity || signal?.aborted) return false;
    const env = { ...world.env, PATH: programPath(found.program), ...found.profile.env };
    const [statusRun, authRun] = await Promise.all([
      run({
        program: found.program,
        args: [...found.profile.args, "gateway", "status", "--json"],
        env,
        cwd: world.cwd,
        ...LIMITS.status,
        ...(signal ? { signal } : {}),
      }),
      run({
        program: found.program,
        args: [...found.profile.args, "config", "get", "gateway.auth.mode", "--json"],
        env,
        cwd: world.cwd,
        ...LIMITS.auth,
        ...(signal ? { signal } : {}),
      }),
    ]);
    if (!succeeded(statusRun) || !succeeded(authRun)) return false;
    const status = parseStatus(statusRun.stdout);
    return (
      status !== null &&
      status.configExists &&
      status.url === found.url &&
      status.endpointConfirmed &&
      status.configPath === found.configPath &&
      status.daemonConfigPath === found.daemonConfigPath &&
      status.serviceKey === found.serviceKey &&
      status.answered?.text === found.version &&
      status.listenerPid === found.listener.pid &&
      this.sameListener(opened, found) &&
      parseAuthMode(authRun.stdout) === "token"
    );
  }

  /** Follows the connection Connect started, until it is in or has failed. */
  /** Follows this attempt's connection to `url` only: another route's state says nothing about it. */
  private watch(
    attempt: number,
    url: string,
    port: number,
    selection: number,
    local = false,
    kept: () => void = () => {},
  ): void {
    this.stopWatching();
    let seen = false;
    // The connection as it stood when this attempt began. With local connect, Connect may go to
    // the address the connection already shows, ended in an error (a reconnect the check refused,
    // then This computer): the client publishes the new target before the new connection's own
    // state, still with that error. Only once the new connection has opened (`connecting` or
    // `reconnecting`, its target, no error) does what the connection says speak for this attempt.
    const before = this.options.client.state.connection;
    let opened = !local;
    const check = (state: ClawtrateState) => {
      if (attempt !== this.attempt) return;
      const { connection, discovery } = state;
      // Let go from elsewhere ("Use another gateway" on the pairing screen): this attempt is over.
      // With local connect, the client selects the earlier gateway again when an attempt not yet
      // paired is let go: that selection isn't this attempt's, and ends it too.
      const restored = local && !this.options.client.isSelected(selection);
      if (seen && ((connection.status === "idle" && connection.gatewayUrl === null) || restored)) {
        this.stopWatching();
        this.attempt += 1;
        this.owned = null;
        this.publish(
          this.state.look
            ? { ...initialSetupState, phase: "found", look: this.state.look }
            : initialSetupState,
        );
        return;
      }
      // Only this selection's own connection speaks for this attempt: another choice of the
      // same address, or one refused meanwhile, says nothing about it.
      if (connection.gatewayUrl !== url || !this.options.client.isSelected(selection)) return;
      if (!opened) {
        if (
          connection.target === before.target ||
          connection.error !== null ||
          (connection.status !== "connecting" && connection.status !== "reconnecting")
        )
          return;
        opened = true;
      }
      seen = true;
      if (connection.status === "connected") {
        // With local connect, the first paired hello saved this gateway in place of the earlier
        // one (core's `replacing`): from here the connection is the person's choice, kept. Back or
        // a new look while its bots load leaves it as it is; it is no longer setup's to close.
        if (local) {
          this.owned = null;
          kept();
        }
        // Ready only for this selection's own read: one left from an earlier selection of the
        // same address isn't this connection's.
        if (discovery.status === "ready" && this.options.client.readyFor(selection)) {
          this.stopWatching();
          // Setup is over: the connection is the person's, and no later look, Back or Connect
          // of setup's closes it or forgets its gateway.
          this.owned = null;
          this.publish({ ...this.state, phase: "done", step: 2 });
        } else if (discovery.status === "error") {
          // Connected, but the bots weren't read: that is what the screen says. A retry
          // that reads them still opens the app, so the watch goes on.
          if (this.state.failure?.kind !== "bots") this.fail({ kind: "bots", port });
        } else if (this.state.step !== 2) this.publish({ ...this.state, step: 2 });
        return;
      }
      // Local connect's first socket ended before the gateway answered (`UNREACHABLE`): what the
      // settings file says isn't how the gateway there listens now (it stopped, or runs on
      // settings changed since it started, TLS for one). Not retried for ever behind
      // Connecting: the attempt ends with Advanced and a look again. A connection at the address
      // whose bots are still shown says `reconnecting` for the same. Only while the connection
      // is still setup's own: once its first paired hello made it the person's, a drop while the
      // bots load is a reconnect like any other, and setup goes on watching for them.
      if (
        local &&
        this.owned?.attempt === attempt &&
        (connection.status === "connecting" || connection.status === "reconnecting") &&
        connection.error?.code === "UNREACHABLE" &&
        this.state.phase === "connecting"
      ) {
        this.stopWatching();
        void this.closeOwned();
        this.fail({ kind: "unanswered", port });
        return;
      }
      if (connection.status === "error") {
        this.stopWatching();
        const code = connection.error?.code;
        // The saved pairing went before the socket asked: back to the card, for a new consent.
        if (code === SETUP_PAIRING_GONE) return this.pairingGone();
        // One appeared before the code went: back to the card, for consent to reuse it.
        if (code === SETUP_PAIRING_APPEARED) return this.pairingAppeared();
        this.fail({
          kind:
            code === "SETUP_GRANT_REFUSED"
              ? "grant"
              : code === "AUTH_BOOTSTRAP_TOKEN_INVALID"
                ? "code-refused"
                : code === "UNREACHABLE"
                  ? local
                    ? "unanswered"
                    : "unreachable"
                  : code === SETUP_ENDPOINT_CHANGED
                    ? "changed"
                    : code === "LOCAL_UNVERIFIED"
                      ? "unverified"
                      : "other",
          port,
        });
      }
    };
    this.watching = this.options.client.store.subscribe(check);
  }

  /** Back to the card for a new consent: this device's saved pairing is gone. */
  private pairingGone(): void {
    this.publish({
      ...this.state,
      phase: "found",
      failure: null,
      look: this.state.look && { ...this.state.look, access: "new" },
    });
  }

  /** Back to the card for consent to reuse it: this device has a saved pairing for the address now. */
  private pairingAppeared(): void {
    this.publish({
      ...this.state,
      phase: "found",
      failure: null,
      look: this.state.look && { ...this.state.look, access: "paired" },
    });
  }

  private stopWatching(): void {
    this.watching?.();
    this.watching = null;
  }

  private clearSlow(): void {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }
}
