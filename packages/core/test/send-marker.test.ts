// A person's message from Clawtrate says so to the bot (#666): `chat.send` carries the fixed
// `workContext {page: "Clawtrate"}` on every route a message leaves by. When the gateway refuses
// the field, the same message goes once more without it, under the same key, and never again
// with it; any other refusal is the message's own, as before.
import { describe, expect, it } from "vitest";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { mapSessionRow, plainPreview } from "../src/mapping.ts";
import { isActive } from "../src/runs.ts";
import {
  CLAWTRATE_WORK_CONTEXT,
  MARKER_AS_SEARCHED,
  markerRefusal,
  snippetWithoutMarker,
  titleWithoutMarker,
} from "../src/send-marker.ts";
import { gatewayPreviewOf } from "../src/update-notice.ts";
import { agentEvent, KEY, openTask, questionRecord } from "./client-harness.ts";
import { deferred, GatewayError, sleep, until } from "./fake-gateway.ts";

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
  it("a stop word: the same message once more, without it, under the same key", async () => {
    const { client, gateway, transcript } = await openTask();
    answering(gateway, [ORDINARY_ONLY]);
    const id = client.sendMessage(KEY, "exit");
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "sent");
    expect(sends(gateway)).toEqual([
      expect.objectContaining({
        message: "exit",
        idempotencyKey: id,
        workContext: { page: "Clawtrate" },
      }),
      { sessionKey: KEY, message: "exit", idempotencyKey: id, queueMode: "followup" },
    ]);
    expect(transcript().outbox.find((m) => m.id === id)).toMatchObject({
      text: "exit",
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

/** The model's copy of a message from Clawtrate, as OpenClaw 2026.10.6 and 2026.11.10 store it. */
const MODEL_COPY_MARKER = MARKER_AS_SEARCHED.replace(": {", ":\n{");
const modelCopy = (words: string) => `${words}\n\n${MODEL_COPY_MARKER}`;
/** A person's words of exactly `length` characters, none of them Markdown. */
const wordsOf = (length: number) => {
  const words = "please check the backup of the photos folder tonight and tell me how it went, ";
  const text = words.repeat(Math.ceil(length / words.length) + 1).slice(0, length - 1);
  return `${text}x`;
};

describe("a task's preview shows a person's words alone", () => {
  it("the row's preview, from the gateway's start of the last message, loses the marker after the words", () => {
    expect(mapSessionRow({ key: KEY, lastMessagePreview: modelCopy("#slow 30") })?.preview).toBe(
      "#slow 30",
    );
    // A preview with no marker is as before.
    expect(plainPreview("**Done.** The backup finished")).toBe("Done. The backup finished");
  });

  // The gateway lists the model's copy flattened to one line and cut to 240 characters with "..."
  // (`gatewayPreviewOf`), so after a message of about 75 to 235 characters the cut falls inside
  // the marker, and what is left of it, down to a letter, is the marker's.
  it.each([75, 100, 150, 200, 225, 230, 234, 235])(
    "a message of %i characters, cut by the gateway inside the marker",
    (length) => {
      const words = wordsOf(length);
      const listed = gatewayPreviewOf(modelCopy(words))!;
      expect(listed.length).toBe(240);
      expect(listed).toMatch(/\.\.\.$/);
      expect(plainPreview(listed)).toBe(words);
      expect(mapSessionRow({ key: KEY, lastMessagePreview: listed })?.preview).toBe(words);
    },
  );

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
    for (const text of ["Rename it to Working...", `${wordsOf(100)} Working context...`])
      expect(plainPreview(text)).toBe(text);
  });
});

describe("a task's title the gateway derived shows a person's words alone", () => {
  it("loses the marker it was named with, and a label someone set is kept as it is", () => {
    const named = `Short one\n\nWorking context c`;
    expect(mapSessionRow({ key: KEY, derivedTitle: named, displayName: named })?.title).toBe(
      "Short one",
    );
    expect(mapSessionRow({ key: KEY, displayName: named })?.title).toBe("Short one");
    expect(
      mapSessionRow({ key: KEY, label: "Working context captured", derivedTitle: named })?.title,
    ).toBe("Working context captured");
    expect(mapSessionRow({ key: KEY, derivedTitle: "Plan the walk" })?.title).toBe("Plan the walk");
  });

  it("a title the gateway made from the start of the model's copy, as it makes it", () => {
    // OpenClaw's `deriveGoalSessionTitle` (2026.10.6 and 2026.11.10): the first sentence that
    // starts with a task's verb, or else the whole, cut to 60 characters with "…".
    expect(titleWithoutMarker("Check the disk Working context captured at send time.")).toBe(
      "Check the disk",
    );
    expect(titleWithoutMarker("Short one Working context captured at send time. Treat the…")).toBe(
      "Short one",
    );
    expect(titleWithoutMarker("Check the photos folder and the backup Working context…")).toBe(
      "Check the photos folder and the backup",
    );
    // A model that quotes the JSON it was given (2026.11.10) writes the line break as `\n`.
    expect(
      titleWithoutMarker('> {"conversationLabelSource":Short one\\n\\nWorking context c'),
    ).toBe('> {"conversationLabelSource":Short one');
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

  it("a Stop pressed while a marked stop word waited: sent once more without it, and handled as before the marker", async () => {
    const { client, gateway, transcript } = await openTask();
    const answer = deferred<unknown>();
    let asked = 0;
    gateway.handlers["chat.send"] = () => {
      asked += 1;
      // The gateway's answer to a stop word with nothing to stop.
      return asked === 1 ? answer.promise : { ok: true, aborted: false, runIds: [] };
    };
    const id = client.sendMessage(KEY, "stop");
    await until(() => sends(gateway).length === 1);
    await client.stopRun(KEY, id);
    answer.reject(refusal(ORDINARY_ONLY));
    await until(() => transcript().outbox.find((m) => m.id === id)?.status === "handled");
    expect(sends(gateway).map((p) => [p.message, p.idempotencyKey, "workContext" in p])).toEqual([
      ["stop", id, true],
      ["stop", id, false],
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
    const id = client.sendMessage(KEY, "stop");
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
        expect(snippetWithoutMarker(text)).toEqual({ text, cut: false });
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
      expect(snippetWithoutMarker(text)).toEqual({ text, cut: false });
      expect(plainPreview(text)).toBe(text);
      expect(mapSessionRow({ key: KEY, derivedTitle: text })?.title).toBe(text);
    }
    // A snippet that starts inside the marker and runs to its end is the marker's.
    expect(snippetWithoutMarker(`…other sessions: {"page":"Clawtrate"}`)).toEqual({
      text: "",
      cut: true,
    });
  });
});
