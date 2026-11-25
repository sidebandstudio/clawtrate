// #592: a read made right after a hello that the gateway may answer if asked again is asked
// again by the client, a few times further apart and then once more on the gateway's next event;
// a refusal is not, and a try never outlives its connection.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCOVERY_NOT_READY, LIVE_UPDATES_NOT_STARTED } from "../src/client.ts";
import {
  answerKind,
  READ_AGAIN_MAX_MS,
  READ_AGAIN_MS,
  READ_AGAIN_TRIES,
  readAgain,
} from "../src/read-again.ts";
import { grantingGateway, KEY, openTask, URL_B } from "./client-harness.ts";
import { deferred, GatewayError, sleep, until } from "./fake-gateway.ts";

/**
 * The gateway's exact answer to `sessions.subscribe` while it starts: an error its handler
 * threw, sent as `UNAVAILABLE` with no flag and no reason (OpenClaw 2026.10.6 and 2026.11.10).
 */
const REGISTRY_CHANGING = {
  code: "UNAVAILABLE",
  message:
    "AgentDatabaseRegistryChangedError: Agent database registry ownership is changing during discovery",
};
/** A read the gateway marks as passing: a request that came while it was still starting. */
const STARTING = {
  code: "UNAVAILABLE",
  message: "sessions.subscribe unavailable during gateway startup",
  retryable: true,
  retryAfterMs: 1,
  details: { reason: "startup-sidecars", method: "sessions.subscribe" },
};
/** 2026.11.10's full disk: marked retryable, but it lasts until someone frees space. */
const DISK_FULL = {
  code: "UNAVAILABLE",
  message:
    "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.",
  retryable: true,
  details: { code: "SQLITE_FULL" },
};
const TASKS = { sessions: [{ key: KEY, agentId: "otto", label: "Disk space" }], hasMore: false };

type Shape = { code: string; message: string; retryable?: boolean; details?: unknown };

/** A connected client with the task open; after `restart`, `sessions.subscribe` answers by `fails(call)`. */
async function restarting(
  fails: (call: number) => Shape | null,
  readAgainMs = 5,
  extra: { held?: Promise<void> | undefined } = {},
) {
  const gateway = grantingGateway();
  let calls = 0;
  let restarted = false;
  gateway.handlers["sessions.subscribe"] = async () => {
    if (!restarted) return { subscribed: true, list: TASKS };
    calls += 1;
    await extra.held;
    const shape = fails(calls);
    if (shape) throw new GatewayError(shape);
    return { subscribed: true, list: TASKS };
  };
  gateway.handlers["agents.list"] = () => ({
    defaultId: "otto",
    agents: [{ id: "otto", identity: { name: "Otto" } }],
  });
  const { client } = await openTask({ gateway, client: { readAgainMs } });
  const seen: string[] = [];
  client.store.subscribe(({ discovery }) => {
    if (seen.at(-1) !== discovery.status) seen.push(discovery.status);
  });
  const restart = async () => {
    restarted = true;
    const connects = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > connects);
    await until(() => client.state.connection.status === "connected");
  };
  return { gateway, client, seen, restart, calls: () => calls };
}

const always = (shape: Shape) => () => shape;

describe("#592: bots and tasks the gateway may answer if asked again are read again", () => {
  it("the owner's exact answer once, then fine: bots and tasks load with no error and nothing pressed", async () => {
    const { client, seen, restart, calls } = await restarting((call) =>
      call === 1 ? REGISTRY_CHANGING : null,
    );
    await restart();
    await until(() => client.state.discovery.status === "ready");
    expect(calls()).toBe(2);
    expect(seen).not.toContain("error");
    expect(client.state.discovery).toMatchObject({ error: null, detail: null });
    expect(client.state.tasksByBot.otto?.map((task) => task.title)).toEqual(["Disk space"]);
    client.stop();
  });

  it("the owner's answer every time: five reads in all, then it fails without claiming the gateway wasn't ready", async () => {
    const { client, restart, calls } = await restarting(always(REGISTRY_CHANGING));
    await restart();
    await until(() => client.state.discovery.status === "error");
    expect(calls()).toBe(5);
    // The gateway gave no reason: the strip says only that they couldn't be loaded.
    expect(client.state.discovery.error).toBeNull();
    expect(client.state.discovery.detail).toContain("AgentDatabaseRegistryChangedError");
    // Nothing more is asked on its own: 5 + 10 + 20 + 40 ms of waits are long gone.
    await sleep(200);
    expect(calls()).toBe(5);
    expect(client.state.discovery.status).toBe("error");
    client.stop();
  });

  it("an answer the gateway marks as passing, every time: the strip adds that the gateway wasn't ready", async () => {
    const { client, restart, calls } = await restarting(always(STARTING));
    await restart();
    await until(() => client.state.discovery.status === "error");
    expect(calls()).toBe(5);
    expect(client.state.discovery.error).toBe(DISCOVERY_NOT_READY);
    expect(client.state.discovery.detail).toContain("unavailable during gateway startup");
    client.stop();
  });

  it("a full disk is not read again, though marked retryable, and isn't called not ready", async () => {
    const { client, restart, calls } = await restarting(always(DISK_FULL));
    await restart();
    await until(() => client.state.discovery.status === "error");
    await sleep(60);
    expect(calls()).toBe(1);
    expect(client.state.discovery.error).toBeNull();
    expect(client.state.discovery.detail).toContain("the disk is full");
    client.stop();
  });

  it("a message sends while the failed load stands on the live connection", async () => {
    const { client, gateway, restart } = await restarting(always(REGISTRY_CHANGING));
    await restart();
    await until(() => client.state.discovery.status === "error");
    const sends = gateway.calls("chat.send").length;
    client.sendMessage(KEY, "hello");
    await until(() => gateway.calls("chat.send").length === sends + 1);
    client.stop();
  });

  it("a refusal is not read again", async () => {
    for (const shape of [
      { code: "FORBIDDEN", message: "missing scope: operator.read" },
      { code: "INVALID_REQUEST", message: "invalid sessions.subscribe params" },
      { code: "NOT_FOUND", message: "unknown agent" },
      // UNAVAILABLE that names a lasting reason.
      { code: "UNAVAILABLE", message: "ended", details: { code: "INCOGNITO_SESSION_ENDED" } },
    ]) {
      const { client, restart, calls } = await restarting(always(shape));
      await restart();
      await until(() => client.state.discovery.status === "error");
      await sleep(60);
      expect(calls(), shape.code).toBe(1);
      expect(client.state.discovery.error).toBeNull();
      expect(client.state.discovery.detail).toContain(shape.message);
      client.stop();
    }
  });

  it("a try after a reconnect does nothing", async () => {
    // The first answer fails, and its try again waits 150 ms; the connection drops meanwhile.
    const { client, gateway, restart, calls } = await restarting(
      (call) => (call === 1 ? REGISTRY_CHANGING : null),
      150,
    );
    await restart();
    await until(() => calls() === 1);
    await restart();
    await until(() => client.state.discovery.status === "ready");
    expect(calls()).toBe(2);
    // The first connection's try, due now, is not made on the second.
    await sleep(250);
    expect(calls()).toBe(2);
    expect(gateway.calls("sessions.subscribe").length).toBe(3);
    client.stop();
  });

  it("a try after a switch to another gateway does nothing", async () => {
    const { client, restart, calls } = await restarting(
      (call) => (call === 1 ? REGISTRY_CHANGING : null),
      150,
    );
    await restart();
    await until(() => calls() === 1);
    await client.connect({ url: URL_B, token: "t" });
    await until(() => client.state.discovery.status === "ready");
    expect(calls()).toBe(2);
    await sleep(250);
    expect(calls()).toBe(2);
    client.stop();
  });

  it("the next event from the gateway reads them once more, and only once, without changing the strip", async () => {
    const { client, gateway, restart, calls, seen } = await restarting(always(REGISTRY_CHANGING));
    await restart();
    await until(() => client.state.discovery.status === "error");
    expect(calls()).toBe(5);
    const before = seen.length;
    gateway.emit("health", {});
    await until(() => calls() === 6);
    await sleep(30);
    // The failure stays on screen while that read is out: nothing new to announce.
    expect(seen.slice(before)).toEqual([]);
    expect(client.state.discovery.status).toBe("error");
    // That read failed too: another event asks nothing; Retry is the person's.
    gateway.emit("health", {});
    await sleep(60);
    expect(calls()).toBe(6);
    client.stop();
  });

  it("the next event's read can succeed, and clears the error", async () => {
    let ready = false;
    const { client, gateway, restart } = await restarting(() => (ready ? null : REGISTRY_CHANGING));
    await restart();
    await until(() => client.state.discovery.status === "error");
    ready = true;
    gateway.emit("health", {});
    await until(() => client.state.discovery.status === "ready");
    expect(client.state.discovery).toMatchObject({ error: null, detail: null });
    client.stop();
  });

  it("a lasting failure doesn't arm the next event's read", async () => {
    const { client, gateway, restart, calls } = await restarting(always(DISK_FULL));
    await restart();
    await until(() => client.state.discovery.status === "error");
    gateway.emit("health", {});
    await sleep(60);
    expect(calls()).toBe(1);
    client.stop();
  });

  it("an event while the person's Retry is still reading starts no read of its own", async () => {
    let ready = false;
    // What holds the gateway's answers back; nothing until the Retry below.
    const extra: { held?: Promise<void> | undefined } = {};
    const { client, gateway, restart, calls } = await restarting(
      () => (ready ? null : REGISTRY_CHANGING),
      5,
      extra,
    );
    await restart();
    await until(() => client.state.discovery.status === "error");
    const hold = deferred<void>();
    extra.held = hold.promise;
    ready = true;
    const retry = client.retryNow();
    await until(() => calls() === 6);
    gateway.emit("health", {});
    await sleep(40);
    expect(calls()).toBe(6);
    hold.resolve();
    await retry;
    await until(() => client.state.discovery.status === "ready");
    client.stop();
  });

  it("a load that succeeded leaves nothing for the next event to read", async () => {
    let ready = false;
    const { client, gateway, restart, calls } = await restarting(() =>
      ready ? null : REGISTRY_CHANGING,
    );
    await restart();
    await until(() => client.state.discovery.status === "error");
    ready = true;
    await client.retryNow();
    await until(() => client.state.discovery.status === "ready");
    const after = calls();
    gateway.emit("health", {});
    await sleep(60);
    expect(calls()).toBe(after);
    client.stop();
  });

  it("bots, the open task's history and its live updates are read again too", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    const fail = (method: string) => {
      const answer = gateway.handlers[method]!;
      let failed = false;
      gateway.handlers[method] = (params) => {
        if (!failed) {
          failed = true;
          throw new GatewayError(REGISTRY_CHANGING);
        }
        return answer(params);
      };
    };
    fail("agents.list");
    fail("chat.history");
    fail("sessions.messages.subscribe");
    const histories = gateway.calls("chat.history").length;
    const subscribes = gateway.calls("sessions.messages.subscribe").length;
    const connects = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > connects);
    await until(() => client.state.discovery.status === "ready");
    await until(() => gateway.calls("chat.history").length === histories + 2);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    expect(gateway.calls("sessions.messages.subscribe").length).toBe(subscribes + 2);
    client.stop();
  });
});

describe("#592: the open task's reads belong to their connection", () => {
  it("a history try that outlives its connection marks nothing failed, and doesn't hold up the next connection's read", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway, client: { readAgainMs: 400 } });
    const answer = gateway.handlers["chat.history"]!;
    let failing = true;
    gateway.handlers["chat.history"] = (params) => {
      if (failing) {
        failing = false;
        throw new GatewayError(REGISTRY_CHANGING);
      }
      return answer(params);
    };
    const statuses: string[] = [];
    client.store.subscribe(({ transcripts }) => {
      const status = transcripts[KEY]?.status;
      if (status && statuses.at(-1) !== status) statuses.push(status);
    });
    const histories = gateway.calls("chat.history").length;
    let connects = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > connects);
    // The first connection's read failed once and waits 400 ms to ask again; the connection
    // drops again meanwhile.
    await until(() => gateway.calls("chat.history").length === histories + 1);
    connects = gateway.connects.length;
    const dropped = Date.now();
    gateway.dropAll();
    await until(() => gateway.connects.length > connects);
    // The new connection's own read starts at once, not after the old try's wait.
    await until(() => gateway.calls("chat.history").length === histories + 2, 300);
    expect(Date.now() - dropped).toBeLessThan(300);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    await sleep(500);
    expect(statuses).not.toContain("error");
    expect(gateway.calls("chat.history").length).toBe(histories + 2);
    client.stop();
  });

  it("live updates that can't be started say so on the task, and Try again subscribes again", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    const answer = gateway.handlers["sessions.messages.subscribe"]!;
    let failing = true;
    gateway.handlers["sessions.messages.subscribe"] = (params) => {
      if (failing) throw new GatewayError(REGISTRY_CHANGING);
      return answer(params);
    };
    const before = gateway.calls("sessions.messages.subscribe").length;
    const connects = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > connects);
    await until(() => client.state.transcripts[KEY]?.status === "error");
    expect(gateway.calls("sessions.messages.subscribe").length - before).toBe(5);
    expect(client.state.transcripts[KEY]?.error).toBe(LIVE_UPDATES_NOT_STARTED);
    // The history still shows.
    expect(client.state.transcripts[KEY]?.items.length ?? 0).toBeGreaterThanOrEqual(0);
    failing = false;
    client.reloadSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    expect(gateway.calls("sessions.messages.subscribe").length - before).toBe(6);
    client.stop();
  });

  it("the waiting questions read stops with its connection", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway, client: { readAgainMs: 200 } });
    let failing = true;
    gateway.handlers["question.list"] = () => {
      if (failing) throw new GatewayError(REGISTRY_CHANGING);
      return { questions: [] };
    };
    const asked = gateway.calls("question.list").length;
    const connects = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > connects);
    // The waiting questions and the open task's own read, both answered with the owner's error.
    await until(() => gateway.calls("question.list").length === asked + 2);
    failing = false;
    // Another gateway while the waiting questions wait to be asked again. It pairs for reading
    // only, so it reads no questions: none are asked after the switch.
    await client.connect({ url: URL_B, token: "t" });
    await until(() => client.state.discovery.status === "ready");
    await sleep(500);
    expect(gateway.calls("question.list").length).toBe(asked + 2);
    client.stop();
  });
});

describe("answerKind: what the gateway says of its answer (2026.10.6 and 2026.11.10)", () => {
  const answer = (shape: {
    code: string;
    message?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    details?: unknown;
  }) => new GatewayProtocolRequestError({ message: "x", ...shape });

  it("passing: marked retryable, or a named reason that passes", () => {
    for (const shape of [
      STARTING,
      // A request that took too long to start (both versions' dispatch).
      { code: "UNAVAILABLE", retryable: true, details: { reason: "request-start-timeout" } },
      { code: "UNAVAILABLE", message: "gateway closing before request dispatch", retryable: true },
      { code: "UNAVAILABLE", message: "The server is busy.", retryable: true },
      // 2026.10.6: an agent database still being inspected.
      {
        code: "UNAVAILABLE",
        retryable: true,
        retryAfterMs: 250,
        details: { code: "agent-database-inspection-pending", agentId: "main" },
      },
      // 2026.11.10: operator access refreshing, and the database connection lost.
      {
        code: "UNAVAILABLE",
        retryable: true,
        details: { code: "OPERATOR_ACCESS_UNAVAILABLE" },
      },
      { code: "UNAVAILABLE", details: { code: "unavailable" } },
      // Busy or locked storage, when it comes named.
      { code: "UNAVAILABLE", details: { code: "SQLITE_BUSY" } },
      { code: "UNAVAILABLE", details: { code: "SQLITE_LOCKED" } },
    ])
      expect(answerKind(answer(shape)), JSON.stringify(shape)).toBe("passing");
  });

  it("unclassified: an error a handler threw, with no flag and no reason", () => {
    expect(answerKind(answer(REGISTRY_CHANGING))).toBe("unclassified");
    // 2026.11.10 sends busy storage this way too.
    expect(answerKind(answer({ code: "UNAVAILABLE", message: "database is locked" }))).toBe(
      "unclassified",
    );
  });

  it("lasting: refusals, named lasting reasons, a full disk, and no answer at all", () => {
    for (const shape of [
      DISK_FULL,
      { code: "FORBIDDEN", details: { code: "MISSING_SCOPE" } },
      { code: "INVALID_REQUEST" },
      { code: "NOT_FOUND" },
      { code: "UNAVAILABLE", details: { code: "INCOGNITO_SESSION_ENDED" } },
      { code: "UNAVAILABLE", details: { code: "STALE_INSTALL" } },
      {
        code: "UNAVAILABLE",
        details: { code: "agent-database-inspection-failed", agentId: "main" },
      },
      { code: "UNAVAILABLE", details: { code: "SQLITE_IOERR" } },
      { code: "UNAVAILABLE", details: { code: "SQLITE_READONLY" } },
      { code: "UNAVAILABLE", details: { code: "storage-worker-memory" } },
      { code: "UNAVAILABLE", details: { code: "session_actor_reconciliation" } },
      { code: "UNAVAILABLE", details: { reason: "STATE_OWNER_CHANGED" } },
    ])
      expect(answerKind(answer(shape)), JSON.stringify(shape)).toBe("lasting");
    expect(answerKind(new Error("socket closed"))).toBe("lasting");
  });
});

describe("readAgain's bound", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const unclassified = new GatewayProtocolRequestError({ code: "UNAVAILABLE", message: "busy" });

  /** When each read was made, in fake milliseconds, until `readAgain` gives up. */
  async function times(error: unknown, options: { firstMs?: number } = {}): Promise<number[]> {
    vi.useFakeTimers();
    const start = Date.now();
    const at: number[] = [];
    const read = readAgain(
      () => {
        at.push(Date.now() - start);
        return Promise.reject(error);
      },
      () => true,
      options,
    );
    const settled = read.catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    expect(await settled).toBe(error);
    return at;
  }

  it("is four more tries, waiting 1, 2, 4 and 8 seconds", async () => {
    expect([READ_AGAIN_TRIES, READ_AGAIN_MS, READ_AGAIN_MAX_MS]).toEqual([4, 1_000, 8_000]);
    expect(await times(unclassified)).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
  });

  it("waits as long as the gateway asks, but never past 8 seconds", async () => {
    const later = new GatewayProtocolRequestError({
      code: "UNAVAILABLE",
      message: "busy",
      retryable: true,
      retryAfterMs: 5_000,
    });
    expect(await times(later)).toEqual([0, 5_000, 10_000, 15_000, 23_000]);
    const much = new GatewayProtocolRequestError({
      code: "UNAVAILABLE",
      message: "busy",
      retryable: true,
      retryAfterMs: 60_000,
    });
    expect(await times(much)).toEqual([0, 8_000, 16_000, 24_000, 32_000]);
  });

  it("makes no try, and doesn't wait, once its connection is gone", async () => {
    vi.useFakeTimers();
    let tries = 0;
    const read = readAgain(
      () => {
        tries += 1;
        return Promise.reject(unclassified);
      },
      () => false,
    ).catch((caught: unknown) => caught);
    // No timer runs: it gives up at once.
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([read, Promise.resolve("still waiting")])).toBe(unclassified);
    expect(tries).toBe(1);
  });

  it("stops waiting when its connection ends", async () => {
    vi.useFakeTimers();
    let current = true;
    const ended = deferred<void>();
    let tries = 0;
    const read = readAgain(
      () => {
        tries += 1;
        return Promise.reject(unclassified);
      },
      () => current,
      { ended: ended.promise },
    ).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(10);
    current = false;
    ended.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([read, Promise.resolve("still waiting")])).toBe(unclassified);
    expect(tries).toBe(1);
  });
});
