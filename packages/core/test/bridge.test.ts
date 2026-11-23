import { describe, expect, it } from "vitest";
import { createBridgeSession, MAX_OPAQUE_ID_CHARS, parseBridgeCommand } from "../src/bridge.ts";
import type { ClawtrateClient } from "../src/client.ts";
import { KEY, openTask } from "./client-harness.ts";
import { deferred, GatewayError, until } from "./fake-gateway.ts";

describe("parseBridgeCommand", () => {
  it("accepts the known commands", () => {
    expect(parseBridgeCommand({ type: "connect", url: "ws://127.0.0.1:19001" })).toEqual({
      type: "connect",
      url: "ws://127.0.0.1:19001",
      token: null,
    });
    expect(parseBridgeCommand({ type: "openSession", key: "agent:otto:disk-space" })).toEqual({
      type: "openSession",
      key: "agent:otto:disk-space",
    });
    expect(parseBridgeCommand({ type: "retry", extra: 1 })).toEqual({ type: "retry" });
  });

  it("rejects malformed input from a renderer", () => {
    expect(() => parseBridgeCommand(null)).toThrow();
    expect(() => parseBridgeCommand({ type: "eval", code: "1" })).toThrow("unknown command");
    expect(() => parseBridgeCommand({ type: "connect", url: 4 })).toThrow("invalid url");
    expect(() => parseBridgeCommand({ type: "openSession", key: "../../etc" })).toThrow();
    expect(() => parseBridgeCommand({ type: "connect", url: "ws://x", token: {} })).toThrow();
  });
});

describe("parseBridgeCommand for routines", () => {
  it("takes a run by its start when it has no run id, and the calendar's dates", () => {
    const session = "agent:marlow:cron:job-1:run:abc";
    expect(
      parseBridgeCommand({
        type: "readRunConversation",
        id: "job-1",
        runId: null,
        runAt: 1_795_045_912_353,
        sessionKey: session,
      }),
    ).toEqual({
      type: "readRunConversation",
      id: "job-1",
      runId: null,
      runAt: 1_795_045_912_353,
      sessionKey: session,
    });
    expect(() =>
      parseBridgeCommand({ type: "readRunConversation", id: "job-1", runId: "", runAt: 1 }),
    ).toThrow("invalid run id");
    expect(parseBridgeCommand({ type: "readCalendarRuns", from: 1, to: 2, extra: 3 })).toEqual({
      type: "readCalendarRuns",
      from: 1,
      to: 2,
    });
    expect(() => parseBridgeCommand({ type: "readCalendarRuns", from: -1, to: 2 })).toThrow();
  });
});

describe("parseBridgeCommand for a reaction", () => {
  it("F-283: a reaction's direction is a boolean or absent; any other value is refused, never taken as add", () => {
    const base = {
      type: "setReaction",
      key: "agent:otto:disk-space",
      messageId: "m1",
      emoji: "👍",
    };
    expect(parseBridgeCommand(base)).toMatchObject({ remove: false });
    expect(parseBridgeCommand({ ...base, remove: true })).toMatchObject({ remove: true });
    expect(parseBridgeCommand({ ...base, remove: false })).toMatchObject({ remove: false });
    expect(() => parseBridgeCommand({ ...base, remove: "true" })).toThrow("invalid flag");
    expect(() => parseBridgeCommand({ ...base, remove: 1 })).toThrow("invalid flag");
  });
});

describe("parseBridgeCommand for the live conversation", () => {
  const key = "agent:otto:disk-space";

  it("accepts the conversation commands and normalizes their fields", () => {
    expect(parseBridgeCommand({ type: "requestAccess", scopes: ["operator.admin"] })).toEqual({
      type: "requestAccess",
    });
    expect(parseBridgeCommand({ type: "sendMessage", key, text: "hi", mode: "steer" })).toEqual({
      type: "sendMessage",
      key,
      text: "hi",
      mode: "auto",
      attachmentIds: [],
    });
    expect(
      parseBridgeCommand({
        type: "sendMessage",
        key,
        text: "",
        mode: "auto",
        attachmentIds: ["a-1"],
      }),
    ).toMatchObject({ attachmentIds: ["a-1"] });
    expect(
      parseBridgeCommand({ type: "sendMessage", key, text: "hi", mode: "queue" }),
    ).toMatchObject({
      mode: "queue",
    });
    expect(parseBridgeCommand({ type: "retryMessage", key, messageId: "m-1" })).toEqual({
      type: "retryMessage",
      key,
      messageId: "m-1",
    });
    expect(parseBridgeCommand({ type: "createTask", botId: "otto", text: "go" })).toEqual({
      type: "createTask",
      botId: "otto",
      text: "go",
      label: null,
    });
    expect(parseBridgeCommand({ type: "stopRun", key, runId: "run-1" })).toEqual({
      type: "stopRun",
      key,
      runId: "run-1",
    });
    expect(
      parseBridgeCommand({
        type: "answerQuestion",
        key,
        questionId: "ask_1",
        answers: { color: ["Blue"] },
      }),
    ).toEqual({ type: "answerQuestion", key, questionId: "ask_1", answers: { color: ["Blue"] } });
    expect(parseBridgeCommand({ type: "dismissQuestion", key, questionId: "ask_1" })).toEqual({
      type: "dismissQuestion",
      key,
      questionId: "ask_1",
    });
    expect(parseBridgeCommand({ type: "readStepRaw", key, stepId: "tool:call_1" })).toEqual({
      type: "readStepRaw",
      key,
      stepId: "tool:call_1",
    });
  });

  it("rejects malformed conversation commands", () => {
    expect(() => parseBridgeCommand({ type: "sendMessage", key, text: 5 })).toThrow("invalid text");
    expect(() =>
      parseBridgeCommand({ type: "sendMessage", key, text: "x".repeat(32_001) }),
    ).toThrow("invalid text");
    expect(() => parseBridgeCommand({ type: "sendMessage", key: "../x", text: "hi" })).toThrow();
    expect(() =>
      parseBridgeCommand({ type: "retryMessage", key, messageId: "a\u0000b" }),
    ).toThrow();
    expect(() =>
      parseBridgeCommand({
        type: "retryMessage",
        key,
        messageId: "x".repeat(MAX_OPAQUE_ID_CHARS + 1),
      }),
    ).toThrow();
    expect(
      parseBridgeCommand({ type: "retryMessage", key, messageId: "x".repeat(MAX_OPAQUE_ID_CHARS) }),
    ).toMatchObject({ messageId: "x".repeat(MAX_OPAQUE_ID_CHARS) });
    // Gateway ids are opaque: the Responses adapter pairs them with a vertical bar.
    expect(
      parseBridgeCommand({ type: "readStepRaw", key, stepId: "tool:call_123|fc_456" }),
    ).toMatchObject({ stepId: "tool:call_123|fc_456" });
    expect(() =>
      parseBridgeCommand({ type: "sendMessage", key, text: "hi", attachmentIds: ["a\nb"] }),
    ).toThrow("invalid attachments");
    expect(() =>
      parseBridgeCommand({
        type: "sendMessage",
        key,
        text: "hi",
        attachmentIds: Array.from({ length: 21 }, (_, i) => `a-${i}`),
      }),
    ).toThrow("invalid attachments");
    expect(() =>
      parseBridgeCommand({ type: "resolveApproval", key, approvalId: "ap-1", decision: "allow" }),
    ).toThrow("invalid decision");
    expect(() =>
      parseBridgeCommand({
        type: "resolveApproval",
        key,
        approvalId: "ap-1",
        decision: "allow-always",
        expiresInDays: 0,
      }),
    ).toThrow("invalid duration");
    expect(() => parseBridgeCommand({ type: "createTask", botId: "a/b", text: "go" })).toThrow();
    expect(() =>
      parseBridgeCommand({ type: "createTask", botId: "otto", text: "go", label: "x".repeat(513) }),
    ).toThrow("invalid label");
    for (const answers of [
      {},
      [],
      { Color: ["Blue"] },
      { color: [] },
      { color: [1] },
      { a: ["1"], b: ["1"], c: ["1"], d: ["1"] },
    ]) {
      expect(() =>
        parseBridgeCommand({ type: "answerQuestion", key, questionId: "ask_1", answers }),
      ).toThrow("invalid answers");
    }
  });
});

describe("bridge session policy", () => {
  const calls: unknown[] = [];
  const client = {
    connect: async (options: unknown) => void calls.push(options),
    withdraw: () => {},
  } as unknown as ClawtrateClient;

  it("connects to the development gateway with the host's token, never the renderer's", async () => {
    const session = createBridgeSession(client, {
      devGateway: { url: "ws://127.0.0.1:19001", token: "host-only" },
    });
    await session.apply({ type: "connectDevGateway" });
    expect(calls).toEqual([{ url: "ws://127.0.0.1:19001", token: "host-only" }]);
    await expect(
      createBridgeSession(client, {}).apply({ type: "connectDevGateway" }),
    ).rejects.toThrow();
  });

  it("refuses commands after the viewer is gone", async () => {
    const session = createBridgeSession(client);
    session.dispose();
    await expect(session.apply({ type: "retry" })).rejects.toThrow(/disconnected/);
  });
});

describe("openSession", () => {
  it("F-105: a view opening a task whose history failed for another view reads it again, once", async () => {
    const { client, gateway } = await openTask();
    const first = createBridgeSession(client);
    const second = createBridgeSession(client);
    try {
      await first.apply({ type: "openSession", key: KEY });
      // Only the first viewer holds the task now.
      client.closeSession(KEY);
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      await first.apply({ type: "reloadSession", key: KEY });
      await until(() => client.state.transcripts[KEY]?.status === "error");

      gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false });
      const before = gateway.calls("chat.history").length;
      await second.apply({ type: "openSession", key: KEY });
      await until(() => client.state.transcripts[KEY]?.status === "ready");
      expect(gateway.calls("chat.history")).toHaveLength(before + 1);
      // An open of a task whose history is fine reads nothing.
      const third = createBridgeSession(client);
      await third.apply({ type: "openSession", key: KEY });
      expect(gateway.calls("chat.history")).toHaveLength(before + 1);
      third.dispose();
    } finally {
      first.dispose();
      second.dispose();
      client.stop();
    }
  });

  it("F-105: a view opening a task whose failed history is already being read again starts no read of its own", async () => {
    const { client, gateway } = await openTask();
    const first = createBridgeSession(client);
    const second = createBridgeSession(client);
    try {
      await first.apply({ type: "openSession", key: KEY });
      client.closeSession(KEY);
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      await first.apply({ type: "reloadSession", key: KEY });
      await until(() => client.state.transcripts[KEY]?.status === "error");

      // A run ending refreshes the history; that read is held while the second view opens.
      const refresh = deferred<unknown>();
      gateway.handlers["chat.history"] = () => refresh.promise;
      const before = gateway.calls("chat.history").length;
      gateway.emit("chat", { runId: "run-1", sessionKey: KEY, seq: 1, state: "final" });
      await until(() => gateway.calls("chat.history").length === before + 1);

      await second.apply({ type: "openSession", key: KEY });
      expect(client.state.transcripts[KEY]?.status).toBe("loading");
      // Any further read fails: it would put the conversation back in its error state.
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      refresh.resolve({ messages: [], hasMore: false });
      await until(() => client.state.transcripts[KEY]?.status !== "loading");
      // A duplicate read would be queued from a listener that runs after the refresh drains, so
      // wait on the read queue until it stays idle across a turn; a late one can't slip through.
      await client.historyReadsSettled(KEY);
      await client.historyReadsSettled(KEY);
      expect(gateway.calls("chat.history")).toHaveLength(before + 1);
      expect(client.state.transcripts[KEY]?.status).toBe("ready");
    } finally {
      first.dispose();
      second.dispose();
      client.stop();
    }
  });

  it("F-105: a view opening a task while a failed read of it is still telling its listeners gets the task read", async () => {
    const { client, gateway } = await openTask();
    const first = createBridgeSession(client);
    let opened = false;
    const stop = client.store.subscribe(() => {
      if (opened || client.state.transcripts[KEY]?.status !== "error") return;
      // The failed read's own notification: the read has published but not yet ended.
      opened = true;
      gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false });
      client.openSession(KEY);
    });
    try {
      await first.apply({ type: "openSession", key: KEY });
      client.closeSession(KEY);
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      await first.apply({ type: "reloadSession", key: KEY });
      await until(() => opened);
      await until(() => client.state.transcripts[KEY]?.status === "ready");
    } finally {
      stop();
      first.dispose();
      client.stop();
    }
  });

  it("F-105: a read held from before a close-and-reopen queues no read for the reopened task", async () => {
    const { client, gateway } = await openTask();
    // Two views hold the task; the harness opened it once, a second open makes two.
    client.openSession(KEY);
    try {
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      client.reloadSession(KEY);
      await until(() => client.state.transcripts[KEY]?.status === "error");

      // A run ends and refreshes history; that read is held.
      const refresh = deferred<unknown>();
      gateway.handlers["chat.history"] = () => refresh.promise;
      const before = gateway.calls("chat.history").length;
      gateway.emit("chat", { runId: "run-1", sessionKey: KEY, seq: 1, state: "final" });
      await until(() => gateway.calls("chat.history").length === before + 1);

      // A view arrives while the refresh is held: it schedules a reread for when the read ends.
      client.openSession(KEY);
      expect(client.state.transcripts[KEY]?.status).toBe("loading");

      // Both views, and this one, close: the task is released and its incarnation forgotten.
      client.closeSession(KEY);
      client.closeSession(KEY);
      client.closeSession(KEY);
      expect(client.state.transcripts[KEY]).toBeUndefined();

      // The task is opened again. Its first read is held, so a new incarnation is loading.
      const reopen = deferred<unknown>();
      gateway.handlers["chat.history"] = () => reopen.promise;
      client.openSession(KEY);
      await until(() => gateway.calls("chat.history").length >= before + 2);
      const afterReopen = gateway.calls("chat.history").length;

      // Any further read now fails and would put the reopened task back in error.
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      // The old refresh, from the closed task, finishes while the reopen's read is still held.
      // A buggy reread rides on the reopen's read as its `again`.
      refresh.resolve({ messages: [], hasMore: false });
      // Let the old read's listeners run so any stale reread is queued before the reopen settles.
      await Promise.resolve();
      await Promise.resolve();
      reopen.resolve({ messages: [], hasMore: false });
      await until(() => client.state.transcripts[KEY]?.status !== "loading");
      await client.historyReadsSettled(KEY);
      await client.historyReadsSettled(KEY);
      // The reopen's read succeeded and no stale read followed it.
      expect(client.state.transcripts[KEY]?.status).toBe("ready");
      expect(gateway.calls("chat.history")).toHaveLength(afterReopen);
    } finally {
      client.stop();
    }
  });

  it("F-105: closing and reopening a failing task inside its loading notification attaches no old refresh to the new task", async () => {
    const { client, gateway } = await openTask({ held: ["operator.read"] });
    const reopen = deferred<unknown>();
    let reopened = false;
    let stop: (() => void) | null = null;
    try {
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      client.reloadSession(KEY);
      await until(() => client.state.transcripts[KEY]?.status === "error");

      // A background refresh is pending on the failing task.
      const refresh = deferred<unknown>();
      gateway.handlers["chat.history"] = () => refresh.promise;
      const before = gateway.calls("chat.history").length;
      gateway.emit("chat", { runId: "run-1", sessionKey: KEY, seq: 1, state: "final" });
      await until(() => gateway.calls("chat.history").length === before + 1);

      // When a second open publishes loading, a synchronous store listener closes both holds
      // and reopens the same key, giving it a new incarnation before the second open returns.
      stop = client.store.subscribe(() => {
        if (reopened || client.state.transcripts[KEY]?.status !== "loading") return;
        reopened = true;
        client.closeSession(KEY);
        client.closeSession(KEY);
        gateway.handlers["chat.history"] = () => reopen.promise;
        client.openSession(KEY);
      });
      client.openSession(KEY);
      expect(reopened).toBe(true);
      await until(() => gateway.calls("chat.history").length === before + 2);

      // Any extra read fails and would replace the reopened task's successful history with error.
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      refresh.resolve({ messages: [], hasMore: false });
      await Promise.resolve();
      await Promise.resolve();
      reopen.resolve({ messages: [], hasMore: false });
      await until(() => client.state.transcripts[KEY]?.status !== "loading");
      await client.historyReadsSettled(KEY);
      await client.historyReadsSettled(KEY);
      expect(gateway.calls("chat.history")).toHaveLength(before + 2);
      expect(client.state.transcripts[KEY]?.status).toBe("ready");
    } finally {
      stop?.();
      client.stop();
    }
  });
});

describe("reloadSession", () => {
  it("F-033: a viewer retries a failed history read with one fresh request, and both viewers still hold the task", async () => {
    const { client, gateway } = await openTask();
    const first = createBridgeSession(client);
    const second = createBridgeSession(client);
    try {
      await first.apply({ type: "openSession", key: KEY });
      await second.apply({ type: "openSession", key: KEY });
      // Only the two viewers hold the task now.
      client.closeSession(KEY);
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      await first.apply({ type: "reloadSession", key: KEY });
      await until(() => client.state.transcripts[KEY]?.status === "error");

      gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false });
      const before = gateway.calls("chat.history").length;
      await first.apply({ type: "reloadSession", key: KEY });
      await until(() => client.state.transcripts[KEY]?.status === "ready");
      expect(gateway.calls("chat.history")).toHaveLength(before + 1);

      // A viewer that doesn't hold the task can't make it read.
      const third = createBridgeSession(client);
      await expect(third.apply({ type: "reloadSession", key: KEY })).rejects.toThrow(/isn't open/);
      third.dispose();

      await first.apply({ type: "closeSession", key: KEY });
      expect(client.state.transcripts[KEY]).toBeDefined();
      await second.apply({ type: "closeSession", key: KEY });
      expect(client.state.transcripts[KEY]).toBeUndefined();
    } finally {
      first.dispose();
      second.dispose();
      client.stop();
    }
  });

  it("F-105: a duplicate reload while a read is pending is coalesced so the first read settles the transcript", async () => {
    const { client, gateway } = await openTask();
    const first = createBridgeSession(client);
    try {
      await first.apply({ type: "openSession", key: KEY });
      client.closeSession(KEY);
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      await first.apply({ type: "reloadSession", key: KEY });
      await until(() => client.state.transcripts[KEY]?.status === "error");

      // The first retry starts a read; a second retry arrives in a later turn before it settles.
      const read = deferred<unknown>();
      gateway.handlers["chat.history"] = () => read.promise;
      const before = gateway.calls("chat.history").length;
      await first.apply({ type: "reloadSession", key: KEY });
      await until(() => gateway.calls("chat.history").length === before + 1);
      await first.apply({ type: "reloadSession", key: KEY });

      // A queued second read would fail and replace the first read's success with error.
      gateway.handlers["chat.history"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "history unavailable" });
      };
      read.resolve({ messages: [], hasMore: false });
      await until(() => client.state.transcripts[KEY]?.status !== "loading");
      await client.historyReadsSettled(KEY);
      await client.historyReadsSettled(KEY);
      expect(gateway.calls("chat.history")).toHaveLength(before + 1);
      expect(client.state.transcripts[KEY]?.status).toBe("ready");
    } finally {
      first.dispose();
      client.stop();
    }
  });
});
