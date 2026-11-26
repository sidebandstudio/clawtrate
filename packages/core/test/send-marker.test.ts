// A person's message from Clawtrate says so to the bot (#666): `chat.send` carries the fixed
// `workContext {page: "Clawtrate"}` on every route a message leaves by. When the gateway refuses
// the field, the same message goes once more without it, under the same key, and never again
// with it; any other refusal is the message's own, as before.
import { describe, expect, it } from "vitest";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { mapSessionRow, plainPreview } from "../src/mapping.ts";
import { isActive } from "../src/runs.ts";
import { CLAWTRATE_WORK_CONTEXT, MARKER_AS_SEARCHED, markerRefusal } from "../src/send-marker.ts";
import { agentEvent, KEY, openTask, questionRecord } from "./client-harness.ts";
import { GatewayError, until } from "./fake-gateway.ts";

type Send = { message: string; idempotencyKey: string; queueMode: string; workContext?: unknown };
const sends = (gateway: { calls(method: string): unknown[] }) =>
  gateway.calls("chat.send") as Send[];

/** The answers OpenClaw 2026.10.6 and 2026.11.10 give, word for word. */
const ORDINARY_ONLY = "Working context is only supported for ordinary chat messages.";
const UNVERIFIABLE =
  "The previous mention selections cannot be verified. Check the conversation history and use a new message ID to send again.";
const UNKNOWN_FIELD = "invalid chat.send params: at root: unexpected property 'workContext'";
const refusal = (message: string) => new GatewayError({ code: "INVALID_REQUEST", message });

/** A gateway that answers each `chat.send` with the next of `answers`, then accepts. */
function answering(
  gateway: { handlers: Record<string, (params: unknown) => unknown> },
  answers: Array<string | null>,
) {
  let run = 0;
  gateway.handlers["chat.send"] = () => {
    const answer = answers.shift();
    if (answer) throw refusal(answer);
    run += 1;
    return { runId: `run-${run}`, status: "started" };
  };
}

describe("which answers blame the marker", () => {
  const shaped = (message: string, code = "INVALID_REQUEST") =>
    new GatewayProtocolRequestError({ code, message });
  it("names a message's own refusal, a gateway that doesn't take the field, and nothing else", () => {
    expect(markerRefusal(shaped(ORDINARY_ONLY))).toBe("message");
    expect(markerRefusal(shaped(UNVERIFIABLE))).toBe("message");
    expect(markerRefusal(shaped(UNKNOWN_FIELD))).toBe("gateway");
    expect(
      markerRefusal(
        shaped(
          "invalid chat.send params: at /workContext/page: must not have more than 64 characters",
        ),
      ),
    ).toBe("gateway");
    // Another field's problem, the message's own failures, another code, or no answer at all.
    expect(
      markerRefusal(shaped("invalid chat.send params: at root: unexpected property 'replyToId'")),
    ).toBeNull();
    expect(
      markerRefusal(
        shaped(
          "This message ID was already used for different input. Check the conversation history and use a new message ID to send again.",
        ),
      ),
    ).toBeNull();
    expect(markerRefusal(shaped("budget exhausted"))).toBeNull();
    expect(markerRefusal(shaped(ORDINARY_ONLY, "UNAVAILABLE"))).toBeNull();
    expect(markerRefusal(new Error(ORDINARY_ONLY))).toBeNull();
  });

  it("the marker is fixed and within the gateway's bound for a page (64 characters)", () => {
    expect(CLAWTRATE_WORK_CONTEXT).toEqual({ page: "Clawtrate" });
    expect(CLAWTRATE_WORK_CONTEXT.page.length).toBeLessThanOrEqual(64);
  });
});

describe("every route a message leaves by carries the marker", () => {
  it("a new message, a steer, a queued message, a held one and a retry", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    const first = client.sendMessage(KEY, "first");
    await until(() => transcript().outbox.find((m) => m.id === first)?.status === "sent");
    // A run is going: the next message steers into it, and one asked to wait is queued.
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.id === "run-x"));
    client.sendMessage(KEY, "steer in");
    client.sendMessage(KEY, "after it", { mode: "queue" });
    await until(() => sends(gateway).some((p) => p.message === "steer in"));
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }));
    await until(() => sends(gateway).some((p) => p.message === "after it"));
    // A question holds what is sent next until it settles.
    gateway.emit("agent", agentEvent("run-y", 1, "lifecycle", { phase: "start" }, KEY));
    gateway.emit("question.requested", questionRecord("ask_1", "run-y"));
    await until(() => transcript().runs.some((run) => run.state === "waiting"));
    client.sendMessage(KEY, "held");
    await until(() => transcript().outbox.some((m) => m.text === "held" && m.status === "held"));
    await client.dismissQuestion(KEY, "ask_1");
    await until(() => sends(gateway).some((p) => p.message === "held"));
    gateway.emit("agent", agentEvent("run-y", 2, "lifecycle", { phase: "end" }, KEY));
    await until(() => !transcript().runs.some((run) => isActive(run.state)));
    // A message the gateway refused for its own reason is retried with its own key, marked.
    answering(gateway, ["budget exhausted"]);
    const failed = client.sendMessage(KEY, "retried");
    await until(() => transcript().outbox.find((m) => m.id === failed)?.status === "failed");
    client.retryMessage(KEY, failed);
    await until(() => sends(gateway).filter((p) => p.idempotencyKey === failed).length === 2);

    expect(sends(gateway).map((p) => [p.message, p.queueMode])).toEqual([
      ["first", "followup"],
      ["steer in", "steer"],
      ["after it", "followup"],
      ["held", "steer"],
      ["retried", "followup"],
      ["retried", "followup"],
    ]);
    for (const params of sends(gateway)) expect(params.workContext).toEqual({ page: "Clawtrate" });
    // The person's words are what they wrote, nothing added to them.
    expect(transcript().outbox.map((m) => m.text)).toEqual(
      expect.arrayContaining(["first", "steer in", "after it", "held", "retried"]),
    );
    client.stop();
  });
});

describe("a refusal of the marker", () => {
  it("a command or stop word: the same message once more, without it, under the same key", async () => {
    const { client, gateway, transcript } = await openTask();
    answering(gateway, [ORDINARY_ONLY]);
    const id = client.sendMessage(KEY, "/status");
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "sent");
    expect(sends(gateway)).toEqual([
      expect.objectContaining({
        message: "/status",
        idempotencyKey: id,
        workContext: { page: "Clawtrate" },
      }),
      { sessionKey: KEY, message: "/status", idempotencyKey: id, queueMode: "followup" },
    ]);
    expect(transcript().outbox.find((m) => m.id === id)).toMatchObject({
      text: "/status",
      unmarked: true,
      error: null,
    });
    // The next message on the same connection is marked again: the refusal was this message's.
    const next = client.sendMessage(KEY, "and this");
    await until(() => transcript().outbox.find((m) => m.id === next)?.status === "sent");
    expect(sends(gateway).at(-1)).toMatchObject({
      message: "and this",
      workContext: { page: "Clawtrate" },
    });
    expect(sends(gateway)).toHaveLength(3);
    client.stop();
  });

  it("a replay the gateway can't compare: once more without it, under the same key", async () => {
    const { client, gateway, transcript } = await openTask();
    answering(gateway, [UNVERIFIABLE]);
    const id = client.sendMessage(KEY, "again");
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "sent");
    expect(sends(gateway).map((p) => [p.idempotencyKey, "workContext" in p])).toEqual([
      [id, true],
      [id, false],
    ]);
    client.stop();
  });

  it("a gateway that never takes the field: learnt for the connection, asked again on the next", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).workContext) throw refusal(UNKNOWN_FIELD);
      return { runId: `run-${sends(gateway).length}`, status: "started" };
    };
    const one = client.sendMessage(KEY, "one");
    await until(() => transcript().outbox.find((m) => m.id === one)?.status === "sent");
    const two = client.sendMessage(KEY, "two");
    await until(() => transcript().outbox.find((m) => m.id === two)?.status === "sent");
    // The first meets the refusal and goes again without it; the second goes without it at once.
    expect(sends(gateway).map((p) => [p.message, p.idempotencyKey, "workContext" in p])).toEqual([
      ["one", one, true],
      ["one", one, false],
      ["two", two, false],
    ]);
    // A new connection may be to an updated gateway: it is asked again.
    gateway.dropAll();
    await until(() => client.state.connection.status !== "connected");
    await until(() => client.state.connection.status === "connected");
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    const three = client.sendMessage(KEY, "three");
    await until(() => transcript().outbox.find((m) => m.id === three)?.status === "sent");
    expect(
      sends(gateway)
        .slice(3)
        .map((p) => [p.message, "workContext" in p]),
    ).toEqual([
      ["three", true],
      ["three", false],
    ]);
    client.stop();
  });

  it("a resend that fails is the message's own failure, sent once, and a retry goes as the gateway last took it", async () => {
    const { client, gateway, transcript } = await openTask();
    answering(gateway, [ORDINARY_ONLY, "budget exhausted"]);
    const id = client.sendMessage(KEY, "stop");
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "failed");
    expect(transcript().outbox.find((m) => m.id === id)).toMatchObject({
      error: "budget exhausted",
      unmarked: true,
    });
    expect(sends(gateway)).toHaveLength(2);
    // The person's retry: the same key, without the marker the gateway refused for it.
    client.retryMessage(KEY, id);
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "sent");
    expect(sends(gateway).map((p) => [p.idempotencyKey, "workContext" in p])).toEqual([
      [id, true],
      [id, false],
      [id, false],
    ]);
    client.stop();
  });

  it("any other refusal is sent once and shown as before", async () => {
    const { client, gateway, transcript } = await openTask();
    answering(gateway, ["budget exhausted"]);
    const id = client.sendMessage(KEY, "hello");
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "failed");
    expect(sends(gateway)).toHaveLength(1);
    expect(transcript().outbox.find((m) => m.id === id)).toMatchObject({
      error: "budget exhausted",
    });
    expect(transcript().outbox.find((m) => m.id === id)?.unmarked).toBeUndefined();
    client.stop();
  });
});

describe("a task's preview shows a person's words alone", () => {
  it("the row's preview, from the gateway's start of the last message, loses the marker after the words", () => {
    const marked = `#slow 30\n\n${MARKER_AS_SEARCHED.replace(": {", ":\n{")}`;
    expect(mapSessionRow({ key: KEY, lastMessagePreview: marked })?.preview).toBe("#slow 30");
    // Cut partway through the marker, as a preview of the start of a long message is.
    expect(plainPreview("Is the backup done?\n\nWorking context captured at send")).toBe(
      "Is the backup done?",
    );
    // A preview with no marker is as before.
    expect(plainPreview("**Done.** The backup finished")).toBe("Done. The backup finished");
  });
});
