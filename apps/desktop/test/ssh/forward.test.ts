// The forward's state machine, with a process, a LOOK and a clock of the
// test's own: every state reported, the stated back-off, a lost port race, a
// changed key, another gateway on the port, a long outage, and closing.

import { describe, expect, it } from "vitest";

import {
  backoffMs,
  type ForwardDeps,
  type ForwardProcess,
  type ForwardState,
  ForwardSupervisor,
  LONG_OUTAGE_MS,
  type VerifyResult,
} from "../../src/main/ssh/forward.ts";
import type { SshFailure } from "../../src/main/ssh/ssh-output.ts";

type FakeProcess = ForwardProcess & {
  listen(): void;
  exit(failure: SshFailure): void;
  ended: boolean;
  port: number;
};

function harness(verifyResults: VerifyResult[] = []) {
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 1;
  const processes: FakeProcess[] = [];
  let nextPort = 50000;
  const verifies: Array<(result: VerifyResult) => void> = [];
  const deps: ForwardDeps = {
    pickPort: async () => nextPort++,
    start: (port) => {
      const listening: Array<() => void> = [];
      const exits: Array<(failure: SshFailure) => void> = [];
      const process: FakeProcess = {
        pid: 1000 + processes.length,
        port,
        ended: false,
        onListening: (listener) => listening.push(listener),
        onExit: (listener) => exits.push(listener),
        end: async () => {
          if (process.ended) return;
          process.ended = true;
          for (const listener of exits) listener({ kind: "ssh-stopped", exit: null });
        },
        listen: () => listening.forEach((listener) => listener()),
        exit: (failure) => {
          process.ended = true;
          exits.forEach((listener) => listener(failure));
        },
      };
      processes.push(process);
      return process;
    },
    verify: () =>
      verifyResults.length
        ? Promise.resolve(verifyResults.shift()!)
        : new Promise((resolve) => verifies.push(resolve)),
    now: () => now,
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, callback, id });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index !== -1) timers.splice(index, 1);
    },
  };
  const forward = new ForwardSupervisor(deps);
  const states: ForwardState[] = [];
  forward.onState((state) => states.push(state));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    forward,
    states,
    processes,
    verifies,
    flush,
    pending: () => timers.map((timer) => timer.at - now),
    async advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
      await flush();
    },
    last: () => processes.at(-1)!,
    /** The newest process listens, and the LOOK names the same service. */
    async up() {
      await flush();
      this.last().listen();
      await flush();
    },
  };
}

describe("the forward's back-off", () => {
  it("is 1, 2, 4, 8 and 16 seconds, then every 30", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});

describe("the forward's states", () => {
  it("starts, verifies with the LOOK, and only then is up", async () => {
    const h = harness([{ kind: "same" }]);
    h.forward.open();
    await h.flush();
    expect(h.forward.state).toEqual({ phase: "starting", attempt: 1 });
    await h.up();
    expect(h.states.map((s) => s.phase)).toEqual(["starting", "verifying", "up"]);
    expect(h.forward.state).toEqual({ phase: "up", localPort: 50000, restored: false });
  });

  it("is not up while the LOOK is still running", async () => {
    const h = harness();
    h.forward.open();
    await h.up();
    expect(h.forward.state.phase).toBe("verifying");
    h.verifies.shift()!({ kind: "same" });
    await h.flush();
    expect(h.forward.state.phase).toBe("up");
  });

  it("after a drop, waits as stated, comes back by itself, and says it was restored", async () => {
    const h = harness([{ kind: "same" }, { kind: "same" }]);
    h.forward.open();
    await h.up();
    h.last().exit({ kind: "dropped", exit: 255 });
    await h.flush();
    expect(h.forward.state).toEqual({
      phase: "waiting",
      cause: { kind: "dropped" },
      failures: 1,
      retryInMs: 1000,
      longOutage: false,
    });
    expect(h.pending()).toEqual([1000]);
    await h.advance(999);
    expect(h.processes).toHaveLength(1);
    await h.advance(1);
    expect(h.processes).toHaveLength(2);
    await h.up();
    expect(h.forward.state).toEqual({ phase: "up", localPort: 50001, restored: true });
  });

  it("backs off further with each failure in a row, and starts over once up", async () => {
    const h = harness();
    h.forward.open();
    await h.flush();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      h.last().exit({ kind: "unreachable", cause: "timed out", exit: 255 });
      await h.flush();
      const state = h.forward.state;
      if (state.phase !== "waiting") throw new Error(state.phase);
      waits.push(state.retryInMs);
      await h.advance(state.retryInMs);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    await h.up();
    h.verifies.shift()!({ kind: "same" });
    await h.flush();
    h.last().exit({ kind: "dropped", exit: 255 });
    await h.flush();
    expect(h.forward.state).toMatchObject({ phase: "waiting", retryInMs: 1000 });
  });

  it("says so after two minutes without the forward up", async () => {
    const h = harness([{ kind: "same" }]);
    h.forward.open();
    await h.up();
    h.last().exit({ kind: "dropped", exit: 255 });
    await h.flush();
    let elapsed = 0;
    while (elapsed < LONG_OUTAGE_MS) {
      const state = h.forward.state;
      if (state.phase !== "waiting") throw new Error(state.phase);
      expect(state.longOutage).toBe(elapsed >= LONG_OUTAGE_MS);
      elapsed += state.retryInMs;
      await h.advance(state.retryInMs);
      h.last().exit({ kind: "unreachable", cause: "network unreachable", exit: 255 });
      await h.flush();
    }
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      longOutage: true,
      cause: { kind: "unreachable" },
    });
  });

  it("tries again at once on retryNow, as on wake or a network change", async () => {
    const h = harness();
    h.forward.open();
    await h.flush();
    h.last().exit({ kind: "unreachable", cause: "network unreachable", exit: 255 });
    await h.flush();
    expect(h.pending()).toEqual([1000]);
    h.forward.retryNow();
    await h.flush();
    expect(h.processes).toHaveLength(2);
    expect(h.pending()).toEqual([]);
  });

  it("picks another local port at once when its port was taken, a bounded number of times", async () => {
    const h = harness();
    h.forward.open();
    await h.flush();
    for (let i = 0; i < 5; i++) {
      h.last().exit({ kind: "local-port-taken", exit: 255 });
      await h.flush();
      expect(h.forward.state.phase).toBe("starting");
    }
    expect(h.processes.map((p) => p.port)).toEqual([50000, 50001, 50002, 50003, 50004, 50005]);
    h.last().exit({ kind: "local-port-taken", exit: 255 });
    await h.flush();
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "local-port-taken" },
    });
  });

  it("stops for good when the key changed, from the forward or from the LOOK", async () => {
    const h = harness([{ kind: "same" }]);
    h.forward.open();
    await h.up();
    h.last().exit({ kind: "host-key-changed", exit: 255 });
    await h.flush();
    expect(h.forward.state).toEqual({ phase: "closed", reason: "key-changed" });
    expect(h.pending()).toEqual([]);

    const k = harness([{ kind: "failed", failure: { kind: "host-key-changed", exit: 255 } }]);
    k.forward.open();
    await k.up();
    expect(k.forward.state).toEqual({ phase: "closed", reason: "key-changed" });
    expect(k.last().ended).toBe(true);
  });

  it("closes when the LOOK names another gateway service on that port", async () => {
    const h = harness([{ kind: "same" }, { kind: "different" }]);
    h.forward.open();
    await h.up();
    h.last().exit({ kind: "dropped", exit: 255 });
    await h.advance(1000);
    await h.up();
    expect(h.forward.state).toEqual({ phase: "closed", reason: "different-gateway" });
    expect(h.last().ended).toBe(true);
    expect(h.states.filter((s) => s.phase === "up")).toHaveLength(1);
  });

  it("is not usable while the gateway there is stopped, and waits for it", async () => {
    const h = harness([{ kind: "not-running" }, { kind: "cant-tell" }, { kind: "same" }]);
    h.forward.open();
    await h.up();
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "gateway-not-running" },
    });
    expect(h.processes[0]!.ended).toBe(true);
    await h.advance(1000);
    await h.up();
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "cant-tell" },
      retryInMs: 2000,
    });
    await h.advance(2000);
    await h.up();
    expect(h.forward.state.phase).toBe("up");
  });

  it("closes explicitly, ends its process, and nothing restarts it", async () => {
    const h = harness([{ kind: "same" }]);
    h.forward.open();
    await h.up();
    await h.forward.close();
    expect(h.forward.state).toEqual({ phase: "closed", reason: "closed" });
    expect(h.last().ended).toBe(true);
    await h.advance(60000);
    expect(h.processes).toHaveLength(1);
    h.forward.retryNow();
    await h.flush();
    expect(h.processes).toHaveLength(1);
  });

  it("closes while waiting or while the LOOK runs, and ignores what arrives late", async () => {
    const h = harness();
    h.forward.open();
    await h.up();
    const late = h.verifies.shift()!;
    await h.forward.close();
    late({ kind: "same" });
    await h.flush();
    expect(h.forward.state).toEqual({ phase: "closed", reason: "closed" });

    const w = harness();
    w.forward.open();
    await w.flush();
    w.last().exit({ kind: "dropped", exit: 255 });
    await w.flush();
    await w.forward.close();
    expect(w.pending()).toEqual([]);
    expect(w.forward.state).toEqual({ phase: "closed", reason: "closed" });
  });
});
