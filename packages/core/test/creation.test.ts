// A task creation whose answer does not come in time has an unknown outcome,
// never a failed one: it is asked again with its own key, which the gateway
// answers with the original outcome, and nothing is sent again on the
// client's assumption. Fixtures follow the late-acceptance reproduction.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import {
  ClawtrateClient,
  CREATION_KEY_WINDOW_MS,
  CREATION_UNKNOWN_WARNING,
  MAX_TRACKED_TASKS,
} from "../src/client.ts";
import { MAX_CREATIONS } from "../src/state-bounds.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, openTask, URL_A } from "./client-harness.ts";
import {
  deferred,
  GatewayError,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
  type FakeGateway,
} from "./fake-gateway.ts";

type CreateParams = { agentId: string; message: string; idempotencyKey: string; label?: string };

/**
 * `sessions.create` as the gateway answers it: per key, one piece of work,
 * which a repeat of the key waits on and then answers from.
 */
function idempotentCreate(gateway: FakeGateway) {
  const work = new Map<string, Promise<unknown>>();
  const first = deferred<unknown>();
  let created = 0;
  gateway.handlers["sessions.create"] = (params) => {
    const { idempotencyKey } = params as CreateParams;
    let pending = work.get(idempotencyKey);
    if (!pending) {
      created += 1;
      pending =
        created === 1 ? first.promise : Promise.resolve({ key: `agent:otto:task-${created}` });
      work.set(idempotencyKey, pending);
    }
    return pending;
  };
  return {
    accept: () => first.resolve({ key: "agent:otto:original", runId: "original-run" }),
    created: () => created,
  };
}

const keysAsked = (gateway: FakeGateway) =>
  gateway.calls("sessions.create").map((params) => (params as CreateParams).idempotencyKey);

const FASTER = { requestTimeoutMs: 120, creationCheckMs: 40 };

describe("a creation without an answer", () => {
  it("is checked with its own key, created once, and keeps the user's message", async () => {
    const gateway = grantingGateway();
    const create = idempotentCreate(gateway);
    const { client } = await openTask({ gateway, client: FASTER });
    const viewer = createBridgeSession(client);
    const command = {
      type: "createTask",
      botId: "otto",
      text: "do this once",
      label: null,
    } as const;
    try {
      const first = await viewer.apply(command).then(
        () => null,
        (error: Error) => error,
      );
      expect(first?.name).toBe("OutcomeUnknownError");
      // Not failed: the request and its key are kept, and visible, while it is checked.
      expect(client.state.creations).toMatchObject([{ text: "do this once", status: "checking" }]);
      // Asking again joins the check; nothing new goes to the gateway.
      const again = viewer.apply(command);
      await until(() => gateway.calls("sessions.create").length >= 2);
      create.accept();
      expect(await again).toEqual({ key: "agent:otto:original" });
      await until(() => client.state.creations[0]?.status === "created");
      expect(new Set(keysAsked(gateway)).size).toBe(1);
      expect(create.created()).toBe(1);
      // The new task holds the message, as the gateway's own run.
      const outbox = client.state.transcripts["agent:otto:original"]!.outbox;
      expect(outbox).toMatchObject([
        { text: "do this once", status: "sent", runId: "original-run" },
      ]);
      // Asking once more opens the same task rather than making a second.
      expect(await viewer.apply(command)).toEqual({ key: "agent:otto:original" });
      expect(new Set(keysAsked(gateway)).size).toBe(1);
    } finally {
      viewer.dispose();
      client.stop();
    }
  });

  it("is not asked again once the gateway may have forgotten its key", async () => {
    const gateway = grantingGateway();
    idempotentCreate(gateway);
    let clock = 1_000_000;
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: INTERACTIVE_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
      }),
    });
    const client = new ClawtrateClient(
      { ...testHost(gateway, storage), now: () => clock },
      { ...FAST, ...FASTER },
    );
    try {
      await client.start();
      await until(() => client.state.discovery.status === "ready");
      await expect(client.createTask("otto", "do this once")).rejects.toThrow();
      clock += CREATION_KEY_WINDOW_MS + 1;
      await sleep(300);
      // Asked again, it is not sent: it may exist, and asking again could make a second.
      await expect(client.createTask("otto", "do this once")).rejects.toThrow(
        "retrying may create a second task",
      );
      expect(gateway.calls("sessions.create")).toHaveLength(1);
      expect(client.state.creations[0]).toMatchObject({
        status: "unknown",
        error: CREATION_UNKNOWN_WARNING,
      });
      // Dismissed, it can be asked as a new request.
      client.dismissCreation(client.state.creations[0]!.id);
      expect(client.state.creations).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("is not asked again after a fast restart, however close the start times (D2)", async () => {
    const gateway = grantingGateway();
    // A restart within a second: the old process's uptime and the new one's say almost nothing.
    let boot = { bootId: "boot-a", uptimeMs: 1_000 };
    let created = 0;
    gateway.connectReply = (params) => {
      const { scopes } = params as { scopes: string[] };
      const hello = helloOk(scopes, "device-token");
      return {
        ok: true,
        payload: {
          ...hello,
          server: { ...hello.server, bootId: boot.bootId },
          snapshot: { uptimeMs: boot.uptimeMs },
        },
      };
    };
    gateway.handlers["sessions.create"] = () => {
      created += 1;
      // The first is accepted and its answer withheld; the restarted gateway forgot its key.
      return created === 1 ? new Promise(() => {}) : { key: "agent:otto:duplicate" };
    };
    const { client } = await openTask({
      gateway,
      client: { requestTimeoutMs: 80, creationCheckMs: 500 },
    });
    try {
      await expect(client.createTask("otto", "exactly once")).rejects.toThrow("being checked");
      boot = { bootId: "boot-b", uptimeMs: 10 };
      gateway.dropAll();
      await until(() => client.state.creations[0]?.status === "unknown", 2_000);
      await sleep(300);
      expect(created).toBe(1);
      expect(client.state.creations[0]?.error).toBe(CREATION_UNKNOWN_WARNING);
      // Only the user's own retry, warned, asks again, with the same key.
      const first = keysAsked(gateway)[0];
      expect(await client.retryCreation(client.state.creations[0]!.id)).toBe(
        "agent:otto:duplicate",
      );
      expect(keysAsked(gateway)).toEqual([first, first]);
    } finally {
      client.stop();
    }
  });

  it("is never asked again of a gateway whose hello names no start", async () => {
    const gateway = grantingGateway();
    const create = idempotentCreate(gateway);
    gateway.connectReply = (params) => {
      const { scopes } = params as { scopes: string[] };
      const hello = helloOk(scopes, "device-token");
      return { ok: true, payload: { ...hello, server: { version: "test", connId: "c" } } };
    };
    const { client } = await openTask({ gateway, client: { ...FASTER, creationCheckMs: 50 } });
    try {
      await expect(client.createTask("otto", "do this once")).rejects.toThrow();
      create.accept();
      gateway.dropAll();
      await until(() => client.state.creations[0]?.status === "unknown", 2_000);
      await sleep(200);
      expect(gateway.calls("sessions.create")).toHaveLength(1);
    } finally {
      client.stop();
    }
  });

  it("is asked again with its key after a reconnect to the same gateway", async () => {
    const gateway = grantingGateway();
    const create = idempotentCreate(gateway);
    const { client } = await openTask({ gateway, client: { ...FASTER, creationCheckMs: 5_000 } });
    try {
      await expect(client.createTask("otto", "do this once")).rejects.toThrow();
      create.accept();
      // A reconnect to the same process checks at once, and the task is kept with its message.
      gateway.dropAll();
      await until(() => client.state.transcripts["agent:otto:original"] !== undefined, 2_000);
      expect(client.state.transcripts["agent:otto:original"]!.outbox).toMatchObject([
        { text: "do this once" },
      ]);
      expect(client.state.creations[0]).toMatchObject({
        status: "created",
        key: "agent:otto:original",
      });
      expect(new Set(keysAsked(gateway)).size).toBe(1);
    } finally {
      client.stop();
    }
  });
});

describe("a creation being checked", () => {
  it("keeps its task's slot until it settles, so the task it brings has room", async () => {
    const gateway = grantingGateway();
    const create = idempotentCreate(gateway);
    const { client } = await openTask({ gateway, client: { ...FASTER, creationCheckMs: 100 } });
    try {
      for (let i = 1; i < MAX_TRACKED_TASKS - 1; i += 1) client.openSession(`agent:otto:open-${i}`);
      await expect(client.createTask("otto", "do this once")).rejects.toThrow();
      // The last slot is the creation's, while it is checked.
      expect(() => client.openSession("agent:otto:one-more")).toThrow(
        `At most ${MAX_TRACKED_TASKS}`,
      );
      create.accept();
      await until(() => client.state.creations[0]?.status === "created");
      expect(Object.keys(client.state.transcripts)).toHaveLength(MAX_TRACKED_TASKS);
      expect(client.state.transcripts["agent:otto:original"]!.outbox).toMatchObject([
        { text: "do this once" },
      ]);
    } finally {
      client.stop();
    }
  });

  it("is unknown, not failed, when the gateway answers without the new task", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.create"] = () => ({});
    const { client } = await openTask({ gateway });
    try {
      await expect(client.createTask("otto", "do this once")).rejects.toThrow("task list");
      await expect(client.createTask("otto", "do this once")).rejects.toThrow(
        "retrying may create a second task",
      );
      expect(gateway.calls("sessions.create")).toHaveLength(1);
      expect(client.state.creations[0]?.status).toBe("unknown");
    } finally {
      client.stop();
    }
  });
});

describe("a creation the gateway refused", () => {
  it("is offered again, with the same key", async () => {
    const gateway = grantingGateway();
    let calls = 0;
    gateway.handlers["sessions.create"] = () => {
      calls += 1;
      if (calls <= 2) throw new GatewayError({ code: "UNAVAILABLE", message: "capacity is full" });
      return { key: "agent:otto:after-refusal" };
    };
    const { client } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    const command = { type: "createTask", botId: "otto", text: "do this", label: null } as const;
    try {
      await expect(viewer.apply(command)).rejects.toThrow("capacity is full");
      // The same request again goes with the same key.
      await expect(viewer.apply(command)).rejects.toThrow("capacity is full");
      const keys = keysAsked(gateway);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      const [creation] = client.state.creations;
      expect(creation).toMatchObject({ status: "failed", text: "do this" });
      expect(await viewer.apply({ type: "retryCreation", creationId: creation!.id })).toEqual({
        key: "agent:otto:after-refusal",
      });
      expect(new Set(keysAsked(gateway))).toEqual(new Set([keys[0]]));
      expect(client.state.creations).toEqual([]);
    } finally {
      viewer.dispose();
      client.stop();
    }
  });
});

describe("a creation is owned before anything is awaited (D3)", () => {
  it("joins two identical requests made together, with one key", async () => {
    const gateway = grantingGateway();
    const hold = deferred<unknown>();
    gateway.handlers["sessions.create"] = () => hold.promise;
    const { client } = await openTask({ gateway, client: { requestTimeoutMs: 1_000 } });
    try {
      const a = client.createTask("otto", "one instruction");
      const b = client.createTask("otto", "one instruction");
      await until(() => gateway.calls("sessions.create").length >= 1);
      await sleep(30);
      hold.resolve({ key: "agent:otto:created", runId: "created" });
      expect(await Promise.all([a, b])).toEqual(["agent:otto:created", "agent:otto:created"]);
      expect(gateway.calls("sessions.create")).toHaveLength(1);
      expect(client.sessionInterest("agent:otto:created")).toBe(2);
    } finally {
      client.stop();
    }
  });

  it("takes its place in the count before access is checked", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.create"] = () => new Promise(() => {});
    const { client } = await openTask({ gateway, client: { requestTimeoutMs: 1_000 } });
    try {
      const asked = Array.from({ length: MAX_CREATIONS + 1 }, (_, i) =>
        client.createTask("otto", `instruction ${i}`).catch((error: Error) => error),
      );
      // Counted at once: never more creations kept than the count, whatever is awaited after.
      expect(client.state.creations.length).toBeLessThanOrEqual(MAX_CREATIONS);
      await sleep(30);
      expect(client.state.creations.length).toBeLessThanOrEqual(MAX_CREATIONS);
      expect(gateway.calls("sessions.create").length).toBe(client.state.creations.length);
      const refused = (await Promise.race([Promise.all(asked.slice(-1)), sleep(30)])) as
        Error[] | undefined;
      expect(refused?.[0]?.message).toMatch(/Too many|At most/);
    } finally {
      client.stop();
    }
  });

  it("a request withdrawn before it was sent takes those who joined it with it", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    const owner = {};
    try {
      const first = client.createTask("otto", "one instruction", { owner });
      const joined = client.createTask("otto", "one instruction");
      client.withdraw(owner);
      await expect(first).rejects.toThrow("withdrawn");
      await expect(joined).rejects.toThrow("withdrawn");
      expect(gateway.calls("sessions.create")).toHaveLength(0);
      expect(client.state.creations).toEqual([]);
    } finally {
      client.stop();
    }
  });
});

it("releases the reserved task slot when the creation observer throws", async () => {
  const gateway = grantingGateway();
  gateway.handlers["sessions.create"] = () => ({ key: "agent:otto:created" });
  const { client } = await openTask({ gateway, client: { limits: { trackedTasks: 2 } } });
  try {
    await expect(
      client.createTask("otto", "first", {
        onStart() {
          throw new Error("viewer closed");
        },
      }),
    ).rejects.toThrow("viewer closed");
    expect(client.state.creations).toEqual([]);
    expect(gateway.calls("sessions.create")).toEqual([]);
    await expect(client.createTask("otto", "second")).resolves.toBe("agent:otto:created");
  } finally {
    client.stop();
  }
});
