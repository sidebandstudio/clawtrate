// A person's message from Clawtrate says so to the bot (#666): `chat.send` carries the fixed
// `workContext {page: "Clawtrate"}` on every route a message leaves by. When the gateway refuses
// the field, the same message goes once more without it, under the same key, and never again
// with it; any other refusal is the message's own, as before.
import { describe, expect, it } from "vitest";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { mapSessionRow, plainPreview } from "../src/mapping.ts";
import { readMessageSearch } from "../src/search.ts";
import { isActive } from "../src/runs.ts";
import {
  CLAWTRATE_WORK_CONTEXT,
  goesUnmarked,
  isAbortWord,
  MARKER_AS_SEARCHED,
  markerRefusal,
  snippetWithoutMarker,
  titleWithoutMarker,
} from "../src/send-marker.ts";
import { chatSendParams } from "../src/send-size.ts";
import { mapArchivedRow } from "../src/task-actions.ts";
import { gatewayPreviewOf } from "../src/update-notice.ts";
import { agentEvent, KEY, openTask, questionRecord } from "./client-harness.ts";
import { deferred, GatewayError, sleep, until } from "./fake-gateway.ts";

type Send = { message: string; idempotencyKey: string; queueMode: string; workContext?: unknown };
type ClawtrateClientOf = Awaited<ReturnType<typeof openTask>>["client"];
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
  // A word a later gateway may take as a stop, which the two supported versions don't: it goes
  // marked, and their refusal of the marker is what is left to fall back on.
  it("a message the gateway won't take it on: the same message once more, without it, under the same key", async () => {
    const { client, gateway, transcript } = await openTask();
    answering(gateway, [ORDINARY_ONLY]);
    const id = client.sendMessage(KEY, "cancel");
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "sent");
    expect(sends(gateway)).toEqual([
      expect.objectContaining({
        message: "cancel",
        idempotencyKey: id,
        workContext: { page: "Clawtrate" },
      }),
      { sessionKey: KEY, message: "cancel", idempotencyKey: id, queueMode: "followup" },
    ]);
    expect(transcript().outbox.find((m) => m.id === id)).toMatchObject({
      text: "cancel",
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
    const id = client.sendMessage(KEY, "cancel");
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

  it("a question that opened while the refused frame waited holds the resend until it settles", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    gateway.emit("agent", agentEvent("run-y", 1, "lifecycle", { phase: "start" }, KEY));
    await until(() => transcript().runs.some((run) => run.id === "run-y"));
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () =>
      sends(gateway).length === 1 ? answer.promise : { runId: "run-y", status: "started" };
    const id = client.sendMessage(KEY, "cancel");
    await until(() => sends(gateway).length === 1);
    gateway.emit("question.requested", questionRecord("ask_1", "run-y"));
    await until(() => transcript().runs.some((run) => run.state === "waiting"));
    answer.reject(refusal(ORDINARY_ONLY));
    // The gateway would take it as the question's answer: it waits, as any send does.
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "held");
    await sleep(100);
    expect(sends(gateway)).toHaveLength(1);
    await client.dismissQuestion(KEY, "ask_1");
    await until(() => sends(gateway).length === 2);
    expect(sends(gateway).map((p) => [p.message, p.idempotencyKey, "workContext" in p])).toEqual([
      ["cancel", id, true],
      ["cancel", id, false],
    ]);
    client.stop();
  });

  it("a held resend of a message that starts its own run waits queued in its place, ahead of what was queued after it", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () =>
      sends(gateway).length === 1
        ? answer.promise
        : { runId: `run-${sends(gateway).length}`, status: "started" };
    const id = client.sendMessage(KEY, "cancel");
    await until(() => sends(gateway).length === 1);
    expect(transcript().runs.some((run) => run.id === id)).toBe(true);
    // A message queued behind it.
    const later = client.sendMessage(KEY, "and then this", { mode: "queue" });
    await until(() => transcript().runs.some((run) => run.id === later));
    // Another run asks a question while the marked frame waits.
    gateway.emit("agent", agentEvent("run-z", 1, "lifecycle", { phase: "start" }, KEY));
    gateway.emit("question.requested", questionRecord("ask_1", "run-z"));
    await until(() => transcript().runs.some((run) => run.state === "waiting"));
    answer.reject(refusal(ORDINARY_ONLY));
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "held");
    // The refused frame started nothing: its run waits, queued, ahead of the later message's.
    expect(
      transcript()
        .runs.filter((run) => run.state === "queued")
        .map((run) => run.id),
    ).toEqual([id, later]);
    // The asking run ends, and its question with it: nothing is running now.
    gateway.emit("agent", agentEvent("run-z", 2, "lifecycle", { phase: "end" }, KEY));
    await until(() => sends(gateway).length === 2);
    // It goes first, as a run of its own, never a steer into a run the gateway never started.
    expect(
      sends(gateway).map((p) => [p.message, p.idempotencyKey, p.queueMode, "workContext" in p]),
    ).toEqual([
      ["cancel", id, "followup", true],
      ["cancel", id, "followup", false],
    ]);
    // The later message waits for that run, then goes.
    gateway.emit("agent", agentEvent("run-2", 1, "lifecycle", { phase: "start" }, KEY));
    gateway.emit("agent", agentEvent("run-2", 2, "lifecycle", { phase: "end" }, KEY));
    await until(() => sends(gateway).length === 3);
    expect(sends(gateway)[2]).toMatchObject({ message: "and then this", idempotencyKey: later });
    client.stop();
  });

  it("a held resend released while the gateway runs another run steers into it, and its queued run goes", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () =>
      sends(gateway).length === 1 ? answer.promise : { runId: "run-z", status: "started" };
    const id = client.sendMessage(KEY, "cancel");
    await until(() => sends(gateway).length === 1);
    gateway.emit("agent", agentEvent("run-z", 1, "lifecycle", { phase: "start" }, KEY));
    gateway.emit("question.requested", questionRecord("ask_1", "run-z"));
    await until(() => transcript().runs.some((run) => run.state === "waiting"));
    answer.reject(refusal(ORDINARY_ONLY));
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "held");
    await client.dismissQuestion(KEY, "ask_1");
    await until(() => sends(gateway).length === 2);
    expect(sends(gateway)[1]).toMatchObject({
      message: "cancel",
      idempotencyKey: id,
      queueMode: "steer",
    });
    expect("workContext" in sends(gateway)[1]!).toBe(false);
    expect(transcript().runs.some((run) => run.id === id)).toBe(false);
    client.stop();
  });

  describe("a held steer keeps its place ahead of a message queued after it", () => {
    /**
     * run-y runs. A steer leaves marked; a message is queued after it; run-y asks a question while
     * the steer's frame waits, and the refusal holds the steer. The steer has no run of its own.
     */
    async function heldSteerThenQueued(resolve = "cancelled", laterWhileAsked = false) {
      const { client, gateway, transcript } = await openTask();
      gateway.handlers["question.resolve"] = () => ({ status: resolve });
      gateway.emit("agent", agentEvent("run-y", 1, "lifecycle", { phase: "start" }, KEY));
      await until(() => transcript().runs.some((run) => run.id === "run-y"));
      const answer = deferred<unknown>();
      gateway.handlers["chat.send"] = () =>
        sends(gateway).length === 1
          ? answer.promise
          : { runId: `run-${sends(gateway).length}`, status: "started" };
      const steer = client.sendMessage(KEY, "cancel");
      await until(() => sends(gateway).length === 1);
      expect(sends(gateway)[0]).toMatchObject({ queueMode: "steer" });
      let later = laterWhileAsked
        ? ""
        : client.sendMessage(KEY, "and then this", { mode: "queue" });
      if (later) await until(() => transcript().runs.some((run) => run.id === later));
      gateway.emit("question.requested", questionRecord("ask_1", "run-y"));
      await until(() => transcript().runs.some((run) => run.state === "waiting"));
      answer.reject(refusal(ORDINARY_ONLY));
      await until(() => transcript().outbox.find((m) => m.id === steer)?.status === "held");
      // Or typed while the question is open: held as it is sent.
      if (laterWhileAsked) later = client.sendMessage(KEY, "and then this", { mode: "queue" });
      await sleep(50);
      expect(sends(gateway)).toHaveLength(1);
      const order = () =>
        sends(gateway)
          .slice(1)
          .map((p) => [p.message, p.queueMode, "workContext" in p]);
      return { client, gateway, transcript, steer, later, order };
    }

    it("the asking run ends: the steer goes first, as a run of its own, and the queued message after it", async () => {
      const { client, gateway, steer, later, order } = await heldSteerThenQueued();
      gateway.emit("agent", agentEvent("run-y", 2, "lifecycle", { phase: "end" }, KEY));
      await until(() => sends(gateway).length === 2);
      await sleep(50);
      expect(order()).toEqual([["cancel", "followup", false]]);
      expect(sends(gateway)[1]).toMatchObject({ idempotencyKey: steer });
      // The later message waits for the steer's own run, then goes.
      gateway.emit("agent", agentEvent(steer, 1, "lifecycle", { phase: "start" }, KEY));
      gateway.emit("agent", agentEvent(steer, 2, "lifecycle", { phase: "end" }, KEY));
      await until(() => sends(gateway).length === 3);
      expect(sends(gateway)[2]).toMatchObject({ message: "and then this", idempotencyKey: later });
      client.stop();
    });

    it("the asking run ends with the later message typed while it asked: the steer still goes first", async () => {
      const { client, gateway, transcript, steer, later, order } = await heldSteerThenQueued(
        "cancelled",
        true,
      );
      expect(transcript().outbox.find((m) => m.id === later)?.status).toBe("held");
      gateway.emit("agent", agentEvent("run-y", 2, "lifecycle", { phase: "end" }, KEY));
      await until(() => sends(gateway).length === 2);
      await sleep(50);
      expect(order()).toEqual([["cancel", "followup", false]]);
      gateway.emit("agent", agentEvent(steer, 1, "lifecycle", { phase: "start" }, KEY));
      gateway.emit("agent", agentEvent(steer, 2, "lifecycle", { phase: "end" }, KEY));
      await until(() => sends(gateway).length === 3);
      expect(sends(gateway)[2]).toMatchObject({ message: "and then this", idempotencyKey: later });
      client.stop();
    });

    for (const [how, settle] of [
      [
        "answered",
        (client: ClawtrateClientOf) => client.answerQuestion(KEY, "ask_1", { color: ["Blue"] }),
      ],
      ["dismissed", (client: ClawtrateClientOf) => client.dismissQuestion(KEY, "ask_1")],
    ] as const) {
      it(`the question ${how}: the steer goes into the asking run, and the queued message after that run`, async () => {
        const { client, gateway, later, order } = await heldSteerThenQueued(
          how === "answered" ? "answered" : "cancelled",
        );
        await settle(client);
        await until(() => sends(gateway).length === 2);
        await sleep(50);
        expect(order()).toEqual([["cancel", "steer", false]]);
        gateway.emit("agent", agentEvent("run-y", 3, "lifecycle", { phase: "end" }, KEY));
        await until(() => sends(gateway).length === 3);
        expect(sends(gateway)[2]).toMatchObject({
          message: "and then this",
          idempotencyKey: later,
        });
        client.stop();
      });
    }

    it("the asking run stopped: nothing starts by itself, and both stay Not sent", async () => {
      const { client, gateway, transcript, steer, later } = await heldSteerThenQueued();
      gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: ["run-y"] });
      await client.stopRun(KEY, "run-y");
      gateway.emit(
        "agent",
        agentEvent("run-y", 3, "lifecycle", { phase: "end", aborted: true }, KEY),
      );
      await until(() => transcript().outbox.every((m) => m.status === "not-sent"));
      await sleep(50);
      expect(sends(gateway)).toHaveLength(1);
      expect(transcript().outbox.map((m) => m.id)).toEqual([steer, later]);
      expect(transcript().runs.some((run) => run.state === "queued")).toBe(false);
      client.stop();
    });

    it("a reconnect while it is held, with the run and its question gone: the steer goes first", async () => {
      const { client, gateway, steer, order } = await heldSteerThenQueued();
      gateway.dropAll();
      await until(() => client.state.connection.status !== "connected");
      await until(() => client.state.connection.status === "connected");
      await until(() => sends(gateway).length >= 2);
      await sleep(50);
      expect(order()).toEqual([["cancel", "followup", false]]);
      expect(sends(gateway)[1]).toMatchObject({ idempotencyKey: steer });
      gateway.emit("agent", agentEvent(steer, 1, "lifecycle", { phase: "start" }, KEY));
      gateway.emit("agent", agentEvent(steer, 2, "lifecycle", { phase: "end" }, KEY));
      await until(() => sends(gateway).length === 3);
      expect(sends(gateway)[2]).toMatchObject({ message: "and then this" });
      client.stop();
    });
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

/** The model's copy of a message from Clawtrate, as OpenClaw 2026.10.6 and 2026.11.10 store it. */
const MODEL_COPY_MARKER = MARKER_AS_SEARCHED.replace(": {", ":\n{");
const modelCopy = (words: string) => `${words}\n\n${MODEL_COPY_MARKER}`;
/** A person's words of exactly `length` characters, none of them Markdown. */
const wordsOf = (length: number) => {
  const words = "please check the backup of the photos folder tonight and tell me how it went, ";
  const text = words.repeat(Math.ceil(length / words.length) + 1).slice(0, length - 1);
  return `${text}x`;
};

/** What `plainPreview` shows of the row the gateway lists after a message from Clawtrate. */
const shownAfter = (words: string) => plainPreview(gatewayPreviewOf(modelCopy(words)));
/** A start of the marker that comes off with the gateway's "...": its first three words and more. */
const LONG_START = "Working context captured ";

describe("a task's preview shows a person's words alone", () => {
  it("the row's preview, from the gateway's start of the last message, loses the marker after the words", () => {
    expect(mapSessionRow({ key: KEY, lastMessagePreview: modelCopy("#slow 30") })?.preview).toBe(
      "#slow 30",
    );
    // A preview with no marker is as before.
    expect(plainPreview("**Done.** The backup finished")).toBe("Done. The backup finished");
  });

  // The gateway lists the model's copy flattened to one line and cut to 240 characters with "..."
  // (`gatewayPreviewOf`), so after a message of about 73 to 235 characters the cut falls inside
  // the marker. A long start of it is the marker's, and the words show whole.
  it.each([75, 100, 150, 200, 211])(
    "a message of %i characters, cut by the gateway inside the marker's opening words and more",
    (length) => {
      const words = wordsOf(length);
      const listed = gatewayPreviewOf(modelCopy(words))!;
      expect(listed.length).toBe(240);
      expect(listed).toMatch(/\.\.\.$/);
      expect(listed.slice(words.length + 1, -3).startsWith(LONG_START)).toBe(true);
      expect(plainPreview(listed)).toBe(words);
      expect(mapSessionRow({ key: KEY, lastMessagePreview: listed })?.preview).toBe(words);
    },
  );

  // A short start, down to one letter, is the marker's or the person's own next word: the
  // gateway's preview is the same for both. It comes off and the gateway's "..." stays.
  it.each([212, 225, 230, 234, 235])(
    "a message of %i characters, cut by the gateway inside the marker's first words",
    (length) => {
      const words = wordsOf(length);
      const listed = gatewayPreviewOf(modelCopy(words))!;
      expect(listed.length).toBe(240);
      const piece = listed.slice(words.length + 1, -3);
      expect(LONG_START.startsWith(piece) && piece.length < LONG_START.length).toBe(true);
      expect(plainPreview(listed)).toBe(`${words}...`);
      expect(mapSessionRow({ key: KEY, lastMessagePreview: listed })?.preview).toBe(`${words}...`);
    },
  );

  it("two messages the gateway lists alike both show the person's words, cut, and none of the marker", () => {
    // One person's 235 characters, sent from Clawtrate; another's 235 and " Work", also sent from
    // Clawtrate, which is 240 and would be listed whole without the marker. Both lists end " W...".
    const first = gatewayPreviewOf(modelCopy("a".repeat(235)))!;
    const second = gatewayPreviewOf(modelCopy(`${"a".repeat(235)} Work`))!;
    expect(first).toBe(second);
    expect(first.endsWith(" W...")).toBe(true);
    for (const listed of [first, second]) {
      expect(plainPreview(listed)).toBe(`${"a".repeat(235)}...`);
      expect(mapSessionRow({ key: KEY, lastMessagePreview: listed })?.preview).toBe(
        `${"a".repeat(235)}...`,
      );
    }
    // The same for a next word that starts as the marker does without being it, marked or not.
    const welcome = gatewayPreviewOf(modelCopy(`${"a".repeat(235)} Welcome back`))!;
    expect(welcome).toBe(first);
    expect(gatewayPreviewOf(`${"a".repeat(235)} Write the notes`)).toBe(first);
    // An archived task's row is read the same way.
    expect(
      mapArchivedRow({ key: KEY, archived: true, lastMessagePreview: first }, "otto")?.preview,
    ).toBe(`${"a".repeat(235)}...`);
  });

  // Every length to 260, in four kinds of text, through the gateway's cut (`gatewayPreviewOf`,
  // which gives what OpenClaw 2026.10.6 and 2026.11.10 give for each of these): no piece of the
  // marker is shown, and nothing of the words is lost but what the gateway cut.
  const kinds: Record<string, string> = {
    ASCII: "please check the photos ",
    Han: "我们明天去看看照片",
    emoji: "📷🎉",
    "decomposed accents": "cafe\u0301 re\u0301sume\u0301 ",
  };
  it.each(Object.entries(kinds))("%s, every length from 1 to 260", (_kind, unit) => {
    for (let length = 1; length <= 260; length += 1) {
      let words =
        unit
          .repeat(Math.ceil(length / unit.length))
          .slice(0, length)
          .trim() || "x";
      if (/[\uD800-\uDBFF]$/.test(words)) words = `${words.slice(0, -1)}x`;
      const shown = shownAfter(words)!;
      // As the gateway would list the words alone, cut and all.
      const own = gatewayPreviewOf(words)!;
      const kept = shown.replace(/ ?\.\.\.$/, "");
      expect(own.startsWith(kept) || own === shown, `${length}: ${shown}`).toBe(true);
      // Shown whole, or as the gateway cut them, or cut where the marker may have begun.
      if (shown !== own) expect(shown.endsWith("..."), `${length}: ${shown}`).toBe(true);
      if (shown !== own) expect(own.slice(0, -3).length, `${length}`).toBeGreaterThanOrEqual(0);
      expect(kept === words || kept === own.replace(/\.\.\.$/, "") || words.startsWith(kept)).toBe(
        true,
      );
      // Nothing before the cut is lost: what was cut is the gateway's or a start of the marker.
      if (shown.endsWith("...") && words.length < 237) expect(kept).toBe(words);
      expect(shown).not.toMatch(/(?:^| )W(?:o|or|ork|orki|orkin|orking)?(?: context)?(?:\.\.\.)?$/);
      expect(shown).not.toContain("Working context");
    }
  });

  it("a message whose marker fits, and one the gateway cut before the marker, are as listed", () => {
    for (const length of [1, 12, 40, 70]) {
      const words = wordsOf(length);
      expect(plainPreview(gatewayPreviewOf(modelCopy(words)))).toBe(words);
    }
    // Cut at the line break before the marker: the gateway's "..." stays, and none of the marker.
    for (const length of [236, 237]) {
      const words = wordsOf(length);
      expect(plainPreview(gatewayPreviewOf(modelCopy(words)))).toMatch(
        new RegExp(`^${words} ?\\.\\.\\.$`),
      );
    }
    // Cut inside the person's own words: the preview is the gateway's, cut and all.
    const long = wordsOf(400);
    expect(plainPreview(gatewayPreviewOf(modelCopy(long)))).toBe(gatewayPreviewOf(long));
  });

  it("a preview that ends in dots the gateway didn't add keeps every word", () => {
    // Shorter than the gateway's cut, so not cut: whatever ends it is the person's.
    for (const text of ["Rename it to Working...", `${wordsOf(100)} Working context...`])
      expect(plainPreview(text)).toBe(text);
  });
});

describe("a task's title the gateway derived shows a person's words alone", () => {
  it("loses the marker it was named with, and a label someone set is kept as it is", () => {
    const named = "Short one Working context captured at send time. Treat the…";
    expect(mapSessionRow({ key: KEY, derivedTitle: named, displayName: named })?.title).toBe(
      "Short one",
    );
    expect(mapSessionRow({ key: KEY, displayName: named })?.title).toBe("Short one");
    expect(
      mapSessionRow({ key: KEY, label: "Working context captured", derivedTitle: named })?.title,
    ).toBe("Working context captured");
    expect(mapSessionRow({ key: KEY, derivedTitle: "Plan the walk" })?.title).toBe("Plan the walk");
  });

  /** OpenClaw's `deriveGoalSessionTitle` on a message with no sentence of a task's verb. */
  const derived = (text: string) => {
    const folded = text.replace(/\s+/g, " ").trim();
    if (folded.length <= 60) return folded;
    const cut = folded.slice(0, 59);
    const space = cut.lastIndexOf(" ");
    return space > 36 ? `${cut.slice(0, space)}…` : `${cut}…`;
  };

  it("a title the gateway made from the start of the model's copy, as it makes it", () => {
    // The first sentence that starts with a task's verb: it ends where the marker's first does.
    expect(titleWithoutMarker("Check the disk Working context captured at send time.")).toBe(
      "Check the disk",
    );
    // Else the whole, cut to 60 with "…", backing up to a space.
    expect(titleWithoutMarker("Short one Working context captured at send time. Treat the…")).toBe(
      "Short one",
    );
    // Cut where the gateway backed up to a space: the marker's first three words are whole there.
    expect(derived(modelCopy("Short one, and some more of them"))).toBe(
      "Short one, and some more of them Working context captured…",
    );
    expect(titleWithoutMarker("Short one, and some more of them Working context captured…")).toBe(
      "Short one, and some more of them",
    );
    // A short start of the marker at the cut: it, or the person's next word; the "…" stays.
    expect(titleWithoutMarker("Check the photos folder and the backup Working context…")).toBe(
      "Check the photos folder and the backup…",
    );
    for (let length = 1; length <= 80; length += 1) {
      const words = wordsOf(length);
      const title = titleWithoutMarker(derived(modelCopy(words)));
      expect(title, `${length}`).not.toMatch(/ W\w*(?: context)?…?$/);
      expect(words.startsWith(title.replace(/…$/, "")) || title === derived(words)).toBe(true);
    }
  });

  it("a model's label on 2026.11.10, which quotes the copy as JSON and is cut at 60", () => {
    // The scripted model's echo of the label prompt, as the gateway keeps it.
    const echo = '> {"conversationLabelSource":Short one\\n\\nWorking context c';
    expect(echo.length).toBeGreaterThanOrEqual(50);
    expect(titleWithoutMarker(echo)).toBe('> {"conversationLabelSource":Short one…');
    expect(
      titleWithoutMarker('> {"conversationLabelSource":A\\n\\nWorking context captured a'),
    ).toBe('> {"conversationLabelSource":A');
  });

  it("a channel chat's title the gateway derived loses it too", () => {
    const named = "Short one Working context captured at send time. Treat the…";
    const row = { key: "agent:pip:telegram:direct:123" };
    expect(mapSessionRow({ ...row, derivedTitle: named })?.title).toBe("Short one");
    expect(mapSessionRow({ ...row, displayName: named })?.title).toBe("Short one");
    expect(mapSessionRow({ ...row, subject: "Working context captured" })?.title).toBe(
      "Working context captured",
    );
  });

  it("a title with an ellipsis of the person's own, shorter than the gateway's cut, is theirs", () => {
    for (const title of [
      "Write to W…",
      "Check Working…",
      "Write to Working…",
      "Ask about Working context…",
    ]) {
      expect(titleWithoutMarker(title)).toBe(title);
      expect(mapSessionRow({ key: KEY, derivedTitle: title })?.title).toBe(title);
    }
  });
});

describe("a stop word goes without the marker from its first frame", () => {
  // OpenClaw 2026.10.6 and 2026.11.10 take the same 43 words as a stop on `chat.send`
  // (`ABORT_TRIGGERS`), read the same way (`normalizeAbortTriggerText`).
  const WORDS = [
    "stop",
    "esc",
    "abort",
    "exit",
    "interrupt",
    "detente",
    "deten",
    "detén",
    "arrete",
    "arrête",
    "停止",
    "停下来",
    "暂停",
    "やめて",
    "止めて",
    "रुको",
    "توقف",
    "стоп",
    "остановись",
    "останови",
    "остановить",
    "прекрати",
    "halt",
    "anhalten",
    "aufhören",
    "hoer auf",
    "stopp",
    "pare",
    "stop openclaw",
    "openclaw stop",
    "stop action",
    "stop current action",
    "stop run",
    "stop current run",
    "stop agent",
    "stop the agent",
    "stop don't do anything",
    "stop dont do anything",
    "stop do not do anything",
    "stop doing anything",
    "do not do that",
    "please stop",
    "stop please",
  ];

  it("the words both versions take as a stop, as they read them, and words that only look like one", () => {
    for (const word of WORDS) expect(isAbortWord(word), word).toBe(true);
    // Case, spaces, punctuation at the end, ’ and `, NFD, control characters: as the gateway reads.
    for (const text of [
      "Stop",
      "STOP!",
      " stop. ",
      "stop!!?",
      "stop\n",
      "Please  Stop",
      "hoer\tauf",
      "stop don’t do anything",
      "stop don`t do anything",
      "dete\u0301n",
      "停止。",
      "Стоп!",
      "stop\u0007",
      "stop’",
      "do not do that.",
    ])
      expect(isAbortWord(text), text).toBe(true);
    for (const text of [
      "stop it",
      "stopping",
      "don't stop",
      "please, stop",
      "'stop'",
      "(stop",
      "stop stop",
      "esc key",
      "abort mission",
      "quit",
      "cancel",
      "wait",
      "Stop the music, please",
      "stop… and think",
    ])
      expect(isAbortWord(text), text).toBe(false);
  });

  it("a stop word and a command go without it, an ordinary message with it, and the frame is sized as sent", () => {
    for (const text of ["stop", "Exit!", "/stop", "/status", "!ls", "  /btw what"])
      expect(goesUnmarked(text), text).toBe(true);
    for (const text of [
      "stop it",
      "Please stop the backup when it ends",
      "hello",
      "Working context",
    ])
      expect(goesUnmarked(text), text).toBe(false);
    const shape = { sessionKey: KEY, idempotencyKey: "k", queueMode: "followup" as const };
    expect(chatSendParams({ ...shape, text: "stop", replyToId: null }, [])).not.toHaveProperty(
      "workContext",
    );
    expect(chatSendParams({ ...shape, text: "stop it", replyToId: null }, [])).toMatchObject({
      workContext: CLAWTRATE_WORK_CONTEXT,
    });
  });

  it("a typed stop reaches the gateway's stop handler on its first frame, though the answer is lost", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.id === "run-x"));
    // Both versions refuse a marked stop word before their stop handler, so it stops nothing;
    // an unmarked one is handled. Then the connection drops before any answer arrives.
    const reached: string[] = [];
    gateway.handlers["chat.send"] = (params) => {
      const { message, workContext } = params as Send;
      reached.push(workContext ? "refused" : isAbortWord(message) ? "stopped" : "sent");
      gateway.dropAll();
      return new Promise(() => {});
    };
    const id = client.sendMessage(KEY, "stop");
    await until(() => reached.length === 1);
    expect(reached).toEqual(["stopped"]);
    expect(sends(gateway)).toEqual([
      { sessionKey: KEY, message: "stop", idempotencyKey: id, queueMode: "steer" },
    ]);
    // Its delivery is unknown: it is never sent again by itself, since another run may be going.
    await until(() => client.state.connection.status === "connected");
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    await until(() => transcript().outbox.find((m) => m.id === id)?.status !== "sending");
    await sleep(100);
    expect(sends(gateway)).toHaveLength(1);
    client.stop();
  });
});

describe("a command, and a Stop before the gateway answered", () => {
  it("a command goes without the marker at once, in one send, whatever the gateway says of it", async () => {
    const { client, gateway, transcript } = await openTask();
    // Were it sent with the marker, this gateway would refuse it in words Clawtrate doesn't know.
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).workContext) throw refusal("work context is not allowed here");
      return { runId: `run-${sends(gateway).length}`, status: "started" };
    };
    for (const text of ["/status", "!ls"]) {
      const id = client.sendMessage(KEY, text);
      await until(() => transcript().outbox.find((m) => m.id === id)?.status === "sent");
    }
    expect(sends(gateway).map((p) => [p.message, "workContext" in p])).toEqual([
      ["/status", false],
      ["!ls", false],
    ]);
    client.stop();
  });

  it("a Stop pressed while a marked word the gateway took as a stop waited: sent once more without it, and handled", async () => {
    const { client, gateway, transcript } = await openTask();
    const answer = deferred<unknown>();
    let asked = 0;
    gateway.handlers["chat.send"] = () => {
      asked += 1;
      // The gateway's answer to a stop word with nothing to stop.
      return asked === 1 ? answer.promise : { ok: true, aborted: false, runIds: [] };
    };
    const id = client.sendMessage(KEY, "cancel");
    await until(() => sends(gateway).length === 1);
    await client.stopRun(KEY, id);
    answer.reject(refusal(ORDINARY_ONLY));
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "handled");
    expect(sends(gateway).map((p) => [p.message, p.idempotencyKey, "workContext" in p])).toEqual([
      ["cancel", id, true],
      ["cancel", id, false],
    ]);
    const message = transcript().outbox.find((m) => m.id === id)!;
    expect(message).toMatchObject({ status: "handled", error: null, unmarked: true });
    // Nothing the person sees names the gateway's field.
    expect(JSON.stringify(transcript())).not.toContain("Working context");
    expect(transcript().runs.some((run) => run.messageId === id || run.id === id)).toBe(false);
    expect(gateway.calls("chat.abort")).toEqual([]);
    client.stop();
  });

  it("a Stop pressed while a marked message waited: sent once more without it, and the run it starts is aborted once", async () => {
    const { client, gateway, transcript } = await openTask();
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () =>
      sends(gateway).length === 1 ? answer.promise : { runId: "run-1", status: "started" };
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: ["run-1"] });
    const id = client.sendMessage(KEY, "Take your time");
    await until(() => sends(gateway).length === 1);
    await client.stopRun(KEY, id);
    // Not named yet: no abort goes before the gateway takes the send.
    expect(gateway.calls("chat.abort")).toEqual([]);
    answer.reject(refusal(UNKNOWN_FIELD));
    await until(() => gateway.calls("chat.abort").length === 1);
    expect(sends(gateway).map((p) => [p.idempotencyKey, "workContext" in p])).toEqual([
      [id, true],
      [id, false],
    ]);
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: "run-1" }]);
    const message = transcript().outbox.find((m) => m.id === id)!;
    expect(message.status).toBe("sent");
    expect(message.error ?? "").not.toContain("Working context");
    expect(transcript().runs.find((run) => run.id === "run-1")?.state).toBe("stopping");
    client.stop();
  });

  it("a steer a Stop withdrew while its marked frame waited is never sent again", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.id === "run-x"));
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () => answer.promise;
    // The gateway holds the steer under its own key, and withdraws it when asked by it.
    gateway.handlers["chat.abort"] = (params) => {
      const { runId } = params as { runId: string };
      return { ok: true, aborted: true, runIds: [runId] };
    };
    const id = client.sendMessage(KEY, "cancel");
    await until(() => sends(gateway).length === 1);
    expect(sends(gateway)[0]).toMatchObject({
      queueMode: "steer",
      workContext: CLAWTRATE_WORK_CONTEXT,
    });
    await client.stopRun(KEY, "run-x");
    await until(() => transcript().outbox.find((m) => m.id === id)?.steer === "withdrawn");
    answer.reject(refusal(ORDINARY_ONLY));
    // The refusal is handled where nothing more is seen of it: a moment for a resend to show.
    await sleep(100);
    expect(sends(gateway)).toHaveLength(1);
    expect(transcript().outbox.find((m) => m.id === id)).toMatchObject({
      status: "not-sent",
      steer: "withdrawn",
    });
    expect(JSON.stringify(transcript().outbox)).not.toContain("Working context");
    client.stop();
  });
});

describe("words the marker also has are a person's own", () => {
  // Where the gateway didn't cut a text, nothing but the whole marker follows a person's words:
  // a text that ends in a start of it is theirs (a command, Start as new task's first message, a
  // message that went without the marker, a bot's reply, a title).
  it("a text that ends in any start of the marker, where nothing was cut, keeps every word", () => {
    for (let length = 1; length < MARKER_AS_SEARCHED.length; length += 1) {
      const start = MARKER_AS_SEARCHED.slice(0, length).trimEnd();
      for (const text of [`Please rename the section to ${start}`, start]) {
        expect(snippetWithoutMarker(text)).toEqual({ text, whole: false });
        expect(plainPreview(text)).toBe(text);
        // A title made of a message's first sentence ends where the marker's first sentence
        // does: that whole sentence after the words is the marker's.
        if (text.endsWith(" Working context captured at send time.")) continue;
        expect(titleWithoutMarker(text)).toBe(text);
        expect(mapSessionRow({ key: KEY, derivedTitle: text })?.title).toBe(text);
      }
    }
  });

  it("a preview, a title or a snippet that is only such a word keeps it", () => {
    for (const text of ["Clawtrate", "JSON", "send", "Working context", "sessions:"]) {
      expect(snippetWithoutMarker(text)).toEqual({ text, whole: false });
      expect(plainPreview(text)).toBe(text);
      expect(mapSessionRow({ key: KEY, derivedTitle: text })?.title).toBe(text);
    }
    // A search excerpt that starts inside the marker and runs to its end: the end comes off, and
    // the excerpt's "…" stays.
    expect(snippetWithoutMarker(` … other sessions: {"page":"Clawtrate"}`)).toEqual({
      text: "…",
      whole: false,
    });
  });
});

describe("a preview, a title or a snippet that is the marker alone is a message with no text", () => {
  // Both versions join the person's words and the marker with `filter(Boolean)`, so a message of
  // files alone is the marker alone; and both versions' Markdown flatteners drop a code block, so
  // the preview of a message that is only one is the marker alone too.
  const MARKER_ALONE = MARKER_AS_SEARCHED;
  /** `projectSessionDisplayMessage(…, {flattenMarkdown: true})`, run on each version's package. */
  const FLATTENED = {
    "2026.10.6": {
      "```\nconst x = 1;\n```": MARKER_ALONE,
      '```ts\nconsole.log("hi")\nreturn 2\n```': MARKER_ALONE,
      "~~~\nls -la\n~~~": `~ ls -la ~ ${MARKER_ALONE}`,
      "    npm run build\n    npm test": `npm run build npm test ${MARKER_ALONE}`,
      "": MARKER_ALONE,
    },
    "2026.11.10": {
      "```\nconst x = 1;\n```": MARKER_ALONE,
      '```ts\nconsole.log("hi")\nreturn 2\n```': MARKER_ALONE,
      "~~~\nls -la\n~~~": MARKER_ALONE,
      "    npm run build\n    npm test": `npm run build npm test ${MARKER_ALONE}`,
      "": MARKER_ALONE,
    },
  };
  /** `deriveGoalSessionTitle` of the first message's projection, the same on both versions. */
  const TITLES = {
    "": "Working context captured at send time. Treat the following…",
    "```\nconst x = 1;\n```": "``` const x = 1; ``` Working context captured at send…",
  };

  it("the task's preview and the archived row's show none, so the title shows, on either version", () => {
    for (const [version, previews] of Object.entries(FLATTENED)) {
      for (const [words, listed] of Object.entries(previews)) {
        // The person's text before the marker is shown as any preview is.
        const expected =
          listed === MARKER_ALONE ? null : plainPreview(listed.slice(0, -MARKER_ALONE.length - 1));
        const row = { key: KEY, lastMessagePreview: listed, derivedTitle: "Check the logs" };
        expect([version, words, mapSessionRow(row)?.preview]).toEqual([version, words, expected]);
        expect(mapArchivedRow({ ...row, archived: true }, "otto")?.preview).toBe(expected);
      }
    }
    // As for a message whose last row has no text: nothing listed, so the title shows.
    expect(mapSessionRow({ key: KEY, lastMessagePreview: null })?.preview).toBeNull();
  });

  it("a title the gateway derived from the marker alone is none, so the task's own name shows", () => {
    const untitled = mapSessionRow({ key: KEY })!.title;
    expect(mapSessionRow({ key: KEY, derivedTitle: TITLES[""] })?.title).toBe(untitled);
    expect(mapSessionRow({ key: KEY, displayName: TITLES[""] })?.title).toBe(untitled);
    expect(titleWithoutMarker(TITLES[""])).toBe("");
    // A code block's title keeps the code: the person's own text is before the marker.
    expect(titleWithoutMarker(TITLES["```\nconst x = 1;\n```"])).toBe("``` const x = 1; ```");
  });

  it("a snippet of the marker alone shows no text, and a search for its words leaves it out", () => {
    const copy = MARKER_AS_SEARCHED.replace(": {", ":\n{");
    expect(snippetWithoutMarker(copy)).toEqual({ text: "", whole: true });
    const reply = {
      results: [
        {
          sessionKey: KEY,
          messageId: "m1",
          role: "user",
          snippet: copy,
        },
      ],
      sessions: [{ key: KEY, displayName: TITLES[""] }],
    };
    // A search for one of its words: the marker is all it shows matching.
    expect(readMessageSearch(reply, "Clawtrate").hits).toEqual([]);
    // Kept only where the query has no word: then it shows no text, and no title of the marker.
    const kept = readMessageSearch(reply, "");
    expect(kept.hits.map((hit) => hit.snippet)).toEqual([""]);
    expect(kept.titles[KEY]).toBeUndefined();
  });
});
