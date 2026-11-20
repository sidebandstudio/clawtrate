// Setting up on this computer, as the host runs it (docs/design/setup.md
// §2, §4, §7): the look, the host's own confirmation before a pairing, the
// one-time code it makes and redeems itself, and what the interface sees.
// The interface can ask for a look, for Back and for Connect; it can't name
// a program, a port or a profile, and Connect does nothing until the host's
// dialog says yes.

import {
  initialSetupState,
  SETUP_ENDPOINT_CHANGED,
  type ClawtrateClient,
  type ClawtrateState,
  type SetupFailure,
  type SetupHost,
  type SetupState,
} from "@clawtrate/core";
import { fileIdentity, LIMITS, lookHere, type FoundGateway } from "./look.ts";
import { parseAuthMode, parseSetupCode, parseStatus } from "./parse.ts";
import type { ProgramResult } from "./programs.ts";
import type { Opened } from "./sandbox.ts";
import { guardPort, programPath, SetupRefusedError } from "./world.ts";

/** A prepared operation expires after this long and can't be repeated (§2). */
export const OPERATION_LIFETIME_MS = 2 * 60_000;
/** After this long, the look says it is still looking (§4). */
export const SLOW_LOOK_MS = 8_000;
const QR_LIMIT = { timeoutMs: 20_000, maxBytes: 16 * 1024 };

/** A program that ran to its end, in time and within its limit, and exited 0. */
const succeeded = (result: ProgramResult) =>
  result.exitCode === 0 && !result.timedOut && !result.tooLarge && !result.failed;

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
};

/**
 * The dialog's words (§2, "The host's confirmation"). Read-only is said only
 * when it is true: a device already paired with that gateway is told what it
 * can already do there.
 */
export function pairConfirmation(
  found: FoundGateway,
  access: "new" | "read" | "more" = "new",
): Confirmation {
  const where = `the ${found.profile.name} gateway on this computer`;
  if (access === "more")
    return {
      message: `Connect this device to ${where}?`,
      detail: "This device is already paired with this gateway and can also send.",
      confirm: "Connect",
    };
  if (access === "read")
    return {
      message: `Connect this device read-only to ${where}?`,
      detail: "This device is already paired with this gateway and can only read.",
      confirm: "Connect",
    };
  return {
    message: `Pair this device read-only with ${where}?`,
    detail: "The gateway saves this device.",
    confirm: "Pair",
  };
}

export class SetupController implements SetupHost {
  private readonly options: SetupControllerOptions;
  private state: SetupState = initialSetupState;
  /** Counts looks and connects; anything finishing for an older one is dropped. */
  private attempt = 0;
  private found: FoundGateway | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private watching: (() => void) | null = null;
  private readonly now: () => number;

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
    this.stopWatching();
    const attempt = (this.attempt += 1);
    this.found = null;
    this.clearSlow();
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
    const report = await lookHere(opened.world, opened.run, {
      identify: opened.identify,
      onStep: (step) => {
        if (attempt === this.attempt && this.state.phase === "looking")
          this.publish({ ...this.state, step });
      },
      cancelled: () => attempt !== this.attempt,
    }).catch(() => null);
    if (attempt !== this.attempt) return;
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
    this.publish({
      ...initialSetupState,
      phase: "found",
      look: access ? { ...report.look, access } : report.look,
    });
  }

  cancel(): void {
    const phase = this.state.phase;
    this.attempt += 1;
    this.clearSlow();
    this.options.stopPrograms();
    if (phase === "looking") {
      this.publish(initialSetupState);
      return;
    }
    if (phase === "connecting" || phase === "failed") {
      this.stopWatching();
      // A connection whose bots couldn't be read is let go too.
      if (this.state.failure?.kind === "bots") void this.options.client.disconnect();
      else void this.letGo();
      this.publish(
        this.state.look
          ? { ...initialSetupState, phase: "found", look: this.state.look }
          : initialSetupState,
      );
    }
  }

  reset(): void {
    this.attempt += 1;
    this.clearSlow();
    this.stopWatching();
    this.options.stopPrograms();
    this.found = null;
    void this.letGo();
    this.publish(initialSetupState);
  }

  /** Ends a setup connection that didn't finish; a gateway saved before is never touched. */
  private async letGo(): Promise<void> {
    const status = this.options.client.state.connection.status;
    if (status !== "idle" && status !== "connected") await this.options.client.disconnect();
  }

  async connect(): Promise<void> {
    const found = this.found;
    const phase = this.state.phase;
    if (
      (phase !== "found" && phase !== "failed") ||
      !found ||
      this.state.look?.outcome !== "running"
    ) {
      throw new Error("There is nothing to connect to. Look again.");
    }
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
    const client = this.options.client;
    await this.letGo();
    // A setup cancelled while the earlier connection was let go starts nothing more.
    if (attempt !== this.attempt) return;
    const paired = await client.hasDeviceToken(found.url);
    if (attempt !== this.attempt) return;
    // The facts are read again after every wait that can be long, and the consent's two
    // minutes hold on every branch: anything other than what the dialog named, and nothing runs.
    const changed = async () => !(await this.unchanged(opened, found)) || expired();
    if (await changed()) {
      if (attempt === this.attempt) this.fail({ kind: "changed" });
      return;
    }
    if (attempt !== this.attempt) return;
    // Every socket the client opens for this, retries included, finds the same listener first.
    const listening = () => this.sameListener(opened, found);
    if (paired) {
      // Already paired with this gateway: the next Connect reuses the device (§7).
      this.publish({ ...this.state, step: 1 });
      this.watch(attempt, found.port);
      await client.connect({ url: found.url, token: null });
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
    this.watch(attempt, found.port);
    // Handed to the client and dropped here: the code lives in the client's memory until its hello.
    await client.connectWithSetupCode(code, { check: listening });
  }

  /** The same process, by PID and start time, still listens where the look found the gateway. */
  private sameListener(opened: Opened, found: FoundGateway): boolean {
    const now = opened.identify(found.listener.pid);
    return now.state === "alive" && now.identity === found.listener.started;
  }

  /**
   * Whether the profile's gateway still is what the dialog named: the same
   * program file, the same endpoint, config files, service and version, the
   * same listener by PID and start time, and token sign-in, each command
   * having finished in time and within its limit.
   */
  private async unchanged(opened: Opened, found: FoundGateway): Promise<boolean> {
    const { world, run } = opened;
    const identity = world.installed ? "stand-in" : await fileIdentity(found.program);
    if (identity !== found.programIdentity) return false;
    const env = { ...world.env, PATH: programPath(found.program), ...found.profile.env };
    const [statusRun, authRun] = await Promise.all([
      run({
        program: found.program,
        args: [...found.profile.args, "gateway", "status", "--json"],
        env,
        cwd: world.cwd,
        ...LIMITS.status,
      }),
      run({
        program: found.program,
        args: [...found.profile.args, "config", "get", "gateway.auth.mode", "--json"],
        env,
        cwd: world.cwd,
        ...LIMITS.auth,
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
  private watch(attempt: number, port: number): void {
    this.stopWatching();
    const check = (state: ClawtrateState) => {
      if (attempt !== this.attempt) return;
      const { connection, discovery } = state;
      if (connection.status === "connected") {
        if (discovery.status === "ready") {
          this.stopWatching();
          this.publish({ ...this.state, phase: "done", step: 2 });
        } else if (discovery.status === "error") {
          // Connected, but the bots weren't read: that is what the screen says. A retry
          // that reads them still opens the app, so the watch goes on.
          if (this.state.failure?.kind !== "bots") this.fail({ kind: "bots", port });
        } else if (this.state.step !== 2) this.publish({ ...this.state, step: 2 });
        return;
      }
      if (connection.status === "error") {
        this.stopWatching();
        const code = connection.error?.code;
        this.fail({
          kind:
            code === "SETUP_GRANT_REFUSED"
              ? "grant"
              : code === "AUTH_BOOTSTRAP_TOKEN_INVALID"
                ? "code-refused"
                : code === "UNREACHABLE"
                  ? "unreachable"
                  : code === SETUP_ENDPOINT_CHANGED
                    ? "changed"
                    : "other",
          port,
        });
      }
    };
    this.watching = this.options.client.store.subscribe(check);
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
