// A gateway restart, while it plausibly lasts (#913). OpenClaw 2026.10.6 and 2026.11.10 both
// broadcast `shutdown` to every connection, whatever its scopes, as they begin to close:
// `{reason, restartExpectedMs: 1500}` when the process restarts, `{reason}` alone when it stops
// (`resolveGatewayShutdownNotice`, `server-shutdown`; the close's caller, `run` in each build).
// Then every socket closes with 1012 "service restart", on a stop as on a restart, so the code
// says nothing. `restartExpectedMs` is the gateway's guess for a bare process, far below what a
// restart takes, so it is not the wait. A config write whose answer says it restarts the
// gateway (`sentinel.payload.stats.requiresRestart`) is a restart this app asked for; the
// gateway may first wait up to five minutes for running work, still connected.
//
// The fact lives beside the connection's status, never in it: `ConnectionState.restart` is set
// from the announcement, or from the drop that follows a restart this app asked for, and goes
// at the next hello, when the wait runs out, when the connection stops or is pointed elsewhere.
// A client that doesn't read it sees the connection exactly as before.

import { asRecord } from "./mapping.ts";

export type ConnectionRestart = {
  /** `asked`: a write of this app's said it restarts the gateway; `announced`: the gateway said. */
  cause: "asked" | "announced";
  /** Epoch ms of the first sign: the gateway's announcement, or the drop after an ask. */
  since: number;
  /** Epoch ms when the wait ends: past it the connection reads as lost, as any other. */
  until: number;
};

/**
 * How long a restart plausibly takes, from its first sign to the connection being back:
 * `docs/decisions.md`, "A restarting gateway", has the measurements behind it. One bound.
 */
export const RESTART_WAIT_MS = 90_000;

/**
 * How long after a write that restarts the gateway its drop is still that restart: OpenClaw
 * waits for running work up to `DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS`, 300 s, on both versions
 * (`restart-budget`), with a minute's margin. A drop later than this is shown as any other.
 */
export const RESTART_ASK_MS = 360_000;

/** Whether a `shutdown` event announces a restart: its `restartExpectedMs` is a number. */
export function announcesRestart(payload: unknown): boolean {
  const expected = asRecord(payload)?.restartExpectedMs;
  return typeof expected === "number" && Number.isFinite(expected);
}

/** Whether a gateway's answer to `method` says it restarts the gateway. */
export function answerRestarts(method: string, answer: unknown): boolean {
  if (method !== "config.patch" && method !== "config.apply") return false;
  const sentinel = asRecord(asRecord(answer)?.sentinel);
  return asRecord(asRecord(sentinel?.payload)?.stats)?.requiresRestart === true;
}

type RestartContext = {
  now: () => number;
  /** The host's target now (`ConnectionState.target`). */
  target: () => number;
  /** The fact as it is published now. */
  current: () => ConnectionRestart | null;
  publish: (restart: ConnectionRestart | null) => void;
  /** `RESTART_WAIT_MS` unless a test shortens it. */
  waitMs: () => number;
};

/** The restart fact of one client's connection, and the ask that may lead to it. */
export class RestartWatch {
  private ask: { at: number; target: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly ctx: RestartContext;

  constructor(ctx: RestartContext) {
    this.ctx = ctx;
  }

  /** A write of this app's was answered: the gateway restarts to apply it. */
  asked(): void {
    this.ask = { at: this.ctx.now(), target: this.ctx.target() };
  }

  /** The gateway announced a restart on the open connection. */
  announced(): void {
    this.begin(this.askHolds() ? "asked" : "announced");
  }

  /** The connection dropped: a restart only when this app asked for one. */
  dropped(): void {
    if (this.askHolds()) this.begin("asked");
  }

  /** A hello, a stop, or the host pointed elsewhere: no restart, and no ask, carries over. */
  end(): void {
    this.ask = null;
    this.clear();
  }

  private askHolds(): boolean {
    const ask = this.ask;
    return (
      ask !== null && ask.target === this.ctx.target() && this.ctx.now() - ask.at <= RESTART_ASK_MS
    );
  }

  /** The first sign starts the wait; a later one, before the next hello, doesn't extend it. */
  private begin(cause: ConnectionRestart["cause"]): void {
    this.ask = null;
    if (this.ctx.current()) return;
    const since = this.ctx.now();
    const waitMs = this.ctx.waitMs();
    this.ctx.publish({ cause, since, until: since + waitMs });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.ctx.publish(null);
    }, waitMs);
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.ctx.current()) this.ctx.publish(null);
  }
}
