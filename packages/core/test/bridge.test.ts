import { describe, expect, it } from "vitest";
import { createBridgeSession, MAX_OPAQUE_ID_CHARS, parseBridgeCommand } from "../src/bridge.ts";
import type { ClawtrateClient } from "../src/client.ts";

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
