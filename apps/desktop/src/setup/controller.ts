// Setting up on this computer, as the host runs it (docs/design/setup.md
// §2, §4, §7): the look, the host's own confirmation before a pairing, the
// one-time code it makes and redeems itself, and what the interface sees.
// The interface can ask for a look, for Back and for Connect; it can't name
// a program, a port or a profile, and Connect does nothing until the host's
// dialog says yes.

import {
  initialSetupState,
  type ClawtrateClient,
  type ClawtrateState,
  type SetupFailure,
  type SetupHost,
  type SetupState,
} from "@clawtrate/core";
import { LIMITS, lookHere, type FoundGateway } from "./look.ts";
import { parseAuthMode, parseSetupCode, parseStatus } from "./parse.ts";
import type { RunProgram } from "./programs.ts";
import { guardPort, guardWorld, programPath, SetupRefusedError, type LookWorld } from "./world.ts";

/** A prepared operation expires after this long and can't be repeated (§2). */
export const OPERATION_LIFETIME_MS = 2 * 60_000;
/** After this long, the look says it is still looking (§4). */
export const SLOW_LOOK_MS = 8_000;
const QR_LIMIT = { timeoutMs: 20_000, maxBytes: 16 * 1024 };

/** What the host's own dialog shows: its words, nothing the page wrote. */
export type Confirmation = { message: string; detail: string; confirm: string };

export type SetupControllerOptions = {
  client: ClawtrateClient;
  /** The look's world, or why there is none (a sandbox that could not be read). */
  world: LookWorld | SetupRefusedError;
  /** The look must be sandboxed: an automated run or a development build. */
  sandboxed: boolean;
  realHome: string;
  run: RunProgram;
  /** Ends every program the look started, by PID. */
  stopPrograms: () => void;
  /** The host's native dialog, or null where the host has none (the web preview). */
  confirm: ((confirmation: Confirmation) => Promise<boolean>) | null;
  /** The host's log: fixed lines only, never a program's output or a credential. */
  log?: (line: string) => void;
  now?: () => number;
};

/** The dialog's words for a pairing (§2, "The host's confirmation"). */
export function pairConfirmation(found: FoundGateway): Confirmation {
  return {
    message: `Pair this device read-only with the ${found.profile.name} gateway on this computer?`,
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
      failure: { exitCode: null, port: null, ...failure },
    });
  }

  /** The world, checked by the guard; throws `SetupRefusedError`. */
  private world(): LookWorld {
    const { world, sandboxed, realHome } = this.options;
    if (world instanceof SetupRefusedError) throw world;
    guardWorld(world, { sandboxed, realHome });
    return world;
  }

  async look(): Promise<void> {
    this.stopWatching();
    const attempt = (this.attempt += 1);
    this.found = null;
    this.clearSlow();
    let world: LookWorld;
    try {
      world = this.world();
    } catch (error) {
      // Loud: in the log, and in the interface as its own failure.
      this.log(error instanceof Error ? error.message : String(error));
      this.publish({
        ...initialSetupState,
        phase: "failed",
        failure: { kind: "refused", exitCode: null, port: null },
      });
      return;
    }
    this.publish({ ...initialSetupState, phase: "looking" });
    this.slowTimer = setTimeout(() => {
      if (attempt === this.attempt && this.state.phase === "looking")
        this.publish({ ...this.state, slow: true });
    }, SLOW_LOOK_MS);
    const report = await lookHere(world, this.options.run, {
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
          others: [],
        },
      });
      return;
    }
    this.found = report.found;
    this.publish({ ...initialSetupState, phase: "found", look: report.look });
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
      void this.letGo();
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
    this.publish({ ...this.state, phase: "confirming", failure: null });
    let yes: boolean;
    try {
      yes = await confirm(pairConfirmation(found));
    } catch {
      yes = false;
    }
    if (attempt !== this.attempt) return;
    if (!yes) {
      // Nothing was minted or registered.
      this.publish({ ...this.state, phase: "found" });
      return;
    }
    if (prepared.used || this.now() - prepared.at > OPERATION_LIFETIME_MS) {
      this.fail({ kind: "changed" });
      return;
    }
    prepared.used = true;
    let world: LookWorld;
    try {
      world = this.world();
      guardPort(found.port, world, this.options.sandboxed);
    } catch (error) {
      this.log(error instanceof Error ? error.message : String(error));
      this.fail({ kind: "refused" });
      return;
    }
    this.publish({ ...this.state, phase: "connecting", step: 0, failure: null });
    // The facts are read again: anything other than what the dialog showed, and nothing runs.
    if (!(await this.unchanged(world, found))) {
      if (attempt === this.attempt) this.fail({ kind: "changed" });
      return;
    }
    if (attempt !== this.attempt) return;
    const url = `ws://127.0.0.1:${found.port}`;
    const client = this.options.client;
    await this.letGo();
    // Already paired with this gateway: the next Connect reuses the device (§7).
    if (await client.hasDeviceToken(url)) {
      if (attempt !== this.attempt) return;
      this.publish({ ...this.state, step: 1 });
      this.watch(attempt, found.port);
      await client.connect({ url, token: null });
      return;
    }
    const made = await this.options.run({
      program: found.program,
      args: [...found.profile.args, "qr", "--json", "--voice-node", "--url", url],
      env: { ...world.env, PATH: programPath(found.program), ...found.profile.env },
      ...QR_LIMIT,
    });
    if (attempt !== this.attempt) return;
    const code = made.exitCode === 0 ? parseSetupCode(made.stdout, url, this.now()) : null;
    if (!code) {
      this.fail({ kind: "code-failed", exitCode: made.exitCode });
      return;
    }
    this.publish({ ...this.state, step: 1 });
    this.watch(attempt, found.port);
    // Handed to the client and dropped here: the code lives in the client's memory until its hello.
    await client.connectWithSetupCode(code);
  }

  /** Whether the profile's gateway still is what the dialog named. */
  private async unchanged(world: LookWorld, found: FoundGateway): Promise<boolean> {
    const env = { ...world.env, PATH: programPath(found.program), ...found.profile.env };
    const [statusRun, authRun] = await Promise.all([
      this.options.run({
        program: found.program,
        args: [...found.profile.args, "gateway", "status", "--json"],
        env,
        ...LIMITS.status,
      }),
      this.options.run({
        program: found.program,
        args: [...found.profile.args, "config", "get", "gateway.auth.mode", "--json"],
        env,
        ...LIMITS.auth,
      }),
    ]);
    const status = statusRun.exitCode === 0 ? parseStatus(statusRun.stdout) : null;
    return (
      status !== null &&
      status.configExists &&
      status.configPath === found.configPath &&
      status.port === found.port &&
      status.answered?.text === found.version &&
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
        if (discovery.status === "ready" || discovery.status === "error") {
          this.stopWatching();
          this.publish({ ...this.state, phase: "done", step: 2 });
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
