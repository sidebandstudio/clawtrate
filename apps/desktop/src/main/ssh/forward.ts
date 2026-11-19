// The forward's life (docs/design/setup.md, section 8): one `ssh -N -L` per
// route, reported to the caller in every state, restarted by itself after a
// drop with a stated back-off, and usable again only after a repeated LOOK
// names the same gateway service on the same port. Closing it is explicit and
// waits until its process is gone. The process, the LOOK, the port picker and
// the clock are passed in, so the state machine is tested without `ssh`.

import { MAX_FORWARD_LISTENERS } from "@clawtrate/core";

import type { ChannelFacts, ProbeResult } from "./http-probe.ts";
import type { SshFailure, UnreachableCause } from "./ssh-output.ts";

/** Seconds before each try after a failure: 1, 2, 4, 8 and 16, then every 30. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
export const BACKOFF_STEADY_MS = 30000;
/** After this long without the forward up, the state says so (`longOutage`). */
export const LONG_OUTAGE_MS = 120000;
/** A lost race for the local port is retried at once, this many times in a row. */
export const PORT_RETRIES = 5;

export const backoffMs = (failures: number) =>
  failures < 1 ? 0 : (BACKOFF_MS[failures - 1] ?? BACKOFF_STEADY_MS);

export type ForwardCause =
  | { kind: "unreachable"; cause: UnreachableCause }
  | { kind: "sign-in-refused" }
  | { kind: "host-key-unknown" }
  | { kind: "dropped" }
  | { kind: "timed-out" }
  | { kind: "ssh-stopped"; exit: number | null }
  | { kind: "local-port-taken" }
  /** The LOOK found the gateway's service on that port, but stopped or not answering. */
  | { kind: "gateway-not-running" }
  /** The LOOK found no gateway service on that port, or answered in a way that couldn't be read. */
  | { kind: "cant-tell" }
  /** The other computer's SSH server refused to forward a connection to the gateway's port. */
  | { kind: "forwarding-refused" }
  /** `ssh` could not be started. */
  | { kind: "spawn-failed" };

export type ForwardState =
  | { phase: "starting"; attempt: number }
  | { phase: "verifying"; localPort: number; attempt: number }
  | { phase: "up"; localPort: number; restored: boolean }
  | {
      phase: "waiting";
      cause: ForwardCause;
      /** Failures since the forward was last up. */
      failures: number;
      retryInMs: number;
      /** True once the forward has not been up for `LONG_OUTAGE_MS`. */
      longOutage: boolean;
    }
  | { phase: "closed"; reason: "closed" | "key-changed" | "different-gateway" };

/** One running `ssh -N -L`. */
export type ForwardProcess = {
  pid: number | null;
  onListening(listener: () => void): void;
  /** Called once, when the process has ended, with what its error output showed. */
  onExit(listener: (failure: SshFailure) => void): void;
  /** What its output said about its forwarded connections so far. */
  channel(): ChannelFacts;
  /** Ends it by PID and resolves once it is gone. */
  end(): Promise<void>;
};

export type VerifyResult =
  | { kind: "same" }
  | { kind: "different" }
  | { kind: "not-running" }
  | { kind: "cant-tell" }
  | { kind: "failed"; failure: SshFailure };

export type ForwardDeps = {
  pickPort(): Promise<number>;
  start(localPort: number): ForwardProcess;
  /** Makes one connection through the forward: did the far end answer as an HTTP service? */
  probe(localPort: number, process: ForwardProcess, signal: AbortSignal): Promise<ProbeResult>;
  /** Runs the LOOK again and compares the gateway service on the gateway's port; `signal` ends it. */
  verify(signal: AbortSignal): Promise<VerifyResult>;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
};

function causeOf(failure: SshFailure): ForwardCause {
  switch (failure.kind) {
    case "unreachable":
      return { kind: "unreachable", cause: failure.cause };
    case "ssh-stopped":
      return { kind: "ssh-stopped", exit: failure.exit };
    case "host-key-changed":
      // Handled before this is called; never retried.
      return { kind: "ssh-stopped", exit: failure.exit };
    default:
      return { kind: failure.kind };
  }
}

export class ForwardSupervisor {
  private current: ForwardState = { phase: "starting", attempt: 1 };
  private readonly listeners = new Set<(state: ForwardState) => void>();
  private process: ForwardProcess | null = null;
  private timer: unknown = null;
  /** Each start gets a new generation; a late event of an older one is ignored. */
  private generation = 0;
  private failures = 0;
  private portRetries = 0;
  private downSince: number;
  private everUp = false;
  private closing: Promise<void> | null = null;
  /** Ends the probe and the LOOK in flight when the forward closes. */
  private readonly stop = new AbortController();
  /** Everything this forward started that may still be running: retiring processes, probes, LOOKs. */
  private work: Promise<unknown> = Promise.resolve();

  private readonly deps: ForwardDeps;

  constructor(deps: ForwardDeps) {
    this.deps = deps;
    this.downSince = deps.now();
  }

  get state(): ForwardState {
    return this.current;
  }

  /** At most `MAX_FORWARD_LISTENERS` at once. */
  onState(listener: (state: ForwardState) => void): () => void {
    if (this.listeners.size >= MAX_FORWARD_LISTENERS) throw new Error("Too many listeners.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts the first attempt. */
  open(): void {
    if (this.generation !== 0) return;
    this.track(this.attempt());
  }

  /** Tries again now: "Retry now", waking from sleep, or a network change. */
  retryNow(): void {
    if (this.current.phase !== "waiting") return;
    this.clearTimer();
    this.track(this.attempt());
  }

  /** Ends the forward; resolves once its process is gone. Nothing restarts it. */
  close(): Promise<void> {
    return this.finish("closed");
  }

  private set(state: ForwardState): void {
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private closed(): boolean {
    return this.current.phase === "closed" || this.closing !== null;
  }

  private track(work: Promise<unknown>): void {
    this.work = Promise.allSettled([this.work, work]);
  }

  /** Ends everything; resolves only once its process, any retiring one, and its probe and LOOK have ended. */
  private finish(reason: "closed" | "key-changed" | "different-gateway"): Promise<void> {
    if (this.closing) return this.closing;
    this.generation++;
    this.clearTimer();
    this.stop.abort();
    const process = this.process;
    this.process = null;
    if (process) this.track(process.end());
    this.closing = (async () => {
      // Work tracked while waiting is waited for too.
      let seen: Promise<unknown>;
      do {
        seen = this.work;
        await seen;
      } while (seen !== this.work);
      this.set({ phase: "closed", reason });
    })();
    return this.closing;
  }

  private async attempt(): Promise<void> {
    if (this.closed()) return;
    const generation = ++this.generation;
    this.set({ phase: "starting", attempt: this.failures + 1 });
    let port: number;
    try {
      port = await this.deps.pickPort();
    } catch {
      if (generation === this.generation) this.fail({ kind: "local-port-taken" });
      return;
    }
    if (generation !== this.generation || this.closed()) return;
    let process: ForwardProcess;
    try {
      process = this.deps.start(port);
    } catch {
      // A spawn that throws, or a full process table, is a state like any other failure.
      this.fail({ kind: "spawn-failed" });
      return;
    }
    this.process = process;
    process.onExit((failure) => {
      if (generation !== this.generation || this.closed()) return;
      this.process = null;
      if (failure.kind === "host-key-changed") {
        void this.finish("key-changed");
      } else if (failure.kind === "local-port-taken" && this.portRetries < PORT_RETRIES) {
        this.portRetries++;
        this.track(this.attempt());
      } else {
        this.fail(causeOf(failure));
      }
    });
    process.onListening(() => {
      if (generation !== this.generation || this.closed()) return;
      this.portRetries = 0;
      this.set({ phase: "verifying", localPort: port, attempt: this.failures + 1 });
      // The listener is only the cue: up needs one answered connection through it, then the LOOK.
      const checked = this.deps
        .probe(port, process, this.stop.signal)
        .catch((): ProbeResult => "no-answer")
        .then((answer) => {
          if (generation !== this.generation || this.closed()) return;
          if (answer === "forwarding-refused") return this.restart({ kind: "forwarding-refused" });
          if (answer === "gateway-closed") return this.restart({ kind: "gateway-not-running" });
          if (answer !== "http") return this.restart({ kind: "cant-tell" });
          return this.deps.verify(this.stop.signal).then(
            (result) => this.verified(generation, port, result),
            () => this.verified(generation, port, { kind: "cant-tell" }),
          );
        });
      this.track(checked);
    });
  }

  private verified(generation: number, port: number, result: VerifyResult): void {
    if (generation !== this.generation || this.closed()) return;
    switch (result.kind) {
      case "same": {
        const restored = this.everUp;
        this.everUp = true;
        this.failures = 0;
        this.set({ phase: "up", localPort: port, restored });
        return;
      }
      case "different":
        void this.finish("different-gateway");
        return;
      case "failed":
        if (result.failure.kind === "host-key-changed") {
          void this.finish("key-changed");
          return;
        }
        this.restart(causeOf(result.failure));
        return;
      case "not-running":
        this.restart({ kind: "gateway-not-running" });
        return;
      case "cant-tell":
        this.restart({ kind: "cant-tell" });
        return;
    }
  }

  /** The forward is not usable: end its process, then wait and try again. */
  private restart(cause: ForwardCause): void {
    const process = this.process;
    this.process = null;
    this.generation++;
    if (process) this.track(process.end());
    this.fail(cause);
  }

  private fail(cause: ForwardCause): void {
    if (this.closed()) return;
    if (this.current.phase === "up") this.downSince = this.deps.now();
    this.failures++;
    const retryInMs = backoffMs(this.failures);
    this.set({
      phase: "waiting",
      cause,
      failures: this.failures,
      retryInMs,
      longOutage: this.deps.now() - this.downSince >= LONG_OUTAGE_MS,
    });
    this.clearTimer();
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.track(this.attempt());
    }, retryInMs);
  }
}
