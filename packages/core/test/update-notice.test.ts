// F-590: the gateway's own "OpenClaw updated" notice. The row is the one `chat.history` returned in
// real update runs on throwaway hosted runners; no real update runs here. It is drawn as a quiet
// line only when this device saw that run succeed, since a bot can write every field of it through
// the `message` tool's copy of what it sends.

import { describe, expect, it } from "vitest";
import {
  mapHistory,
  seenThroughUpdateNotice,
  taskWithoutUpdateNotice,
  tasksWithoutUpdateNotices,
} from "../src/mapping.ts";
import {
  MAX_UPDATE_NOTICE_CHARS,
  UPDATE_NOTICE_WRITTEN_WITHIN_MS,
  updateNoticeLine,
  updateNoticeRunId,
  holdsUpdateNotice,
  mainConversationKey,
  mainToReadAgain,
  type UpdatedRun,
  type UpdateNoticeScope,
} from "../src/update-notice.ts";
import type { Task, Transcript } from "../src/types.ts";

const RUN = "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e";
const FAILED_RUN = "7a1c9e2b-5d4f-4a3b-9c8d-1e2f3a4b5c6d";
const UNKNOWN_RUN = "0b6c1f2e-4d5a-4b7c-9e1f-2a3b4c5d6e7f";
const GATEWAY = "gw-a";
const TEXT =
  "✅ OpenClaw updated.\nFor details, open Settings → Updates in the OpenClaw app or run `openclaw update status` in your terminal.";
const LISTED =
  "✅ OpenClaw updated. For details, open Settings → Updates in the OpenClaw app or run openclaw update status in your terminal.";
const T = 1_790_000_000_000;

/** The notice, as `chat.history` returns it. */
const notice = (runId = RUN, patch: Record<string, unknown> = {}, at = T + 10_000) => ({
  role: "assistant",
  content: [{ type: "text", text: TEXT }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  usage: { input: 0, output: 0, totalTokens: 0 },
  stopReason: "stop",
  timestamp: at,
  idempotencyKey: `update-run-finished:${runId}`,
  __openclaw: { id: `row-${runId}-${at}`, idempotencyKey: `update-run-finished:${runId}`, seq: 3 },
  ...patch,
});
/** A model's ordinary reply. */
const reply = (text: string, at = T, id = "reply-1") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "example-model",
  usage: { input: 10, output: 5, totalTokens: 15 },
  stopReason: "stop",
  timestamp: at,
  responseId: "resp-1",
  __openclaw: { id, runId: "run-1", seq: 2 },
});
/** What this device saw succeed. */
/** When the gateway finished the run, on its clock: every notice row in these tests is written after. */
const SUCCEEDED = T - 1_000;
const UPDATED: UpdatedRun[] = [
  { gatewayId: GATEWAY, runId: RUN, to: "2026.11.10", at: T, succeededAt: SUCCEEDED },
];

const MAIN = "agent:main:main";
/** The connected gateway, what this device saw succeed there, and the main bot's main conversation. */
const SCOPE: UpdateNoticeScope = { updated: UPDATED, gatewayId: GATEWAY, mainKey: MAIN };

const lineOf = (rows: unknown[], scope = SCOPE, key = MAIN) =>
  mapHistory(rows).map((item) => updateNoticeLine(item, key, scope));

describe("F-590: the gateway's update notice", () => {
  it("F-590: the recorded row is the line for a run this device saw succeed, in Clawtrate's words with its version; the gateway's sentence is kept as one clean line", () => {
    expect(updateNoticeRunId(notice())).toBe(RUN);
    const [item] = mapHistory([notice()]);
    expect(item).toMatchObject({ role: "assistant", updateRunId: RUN });
    expect(updateNoticeLine(item, MAIN, SCOPE)).toEqual({
      version: "2026.11.10",
      text: "✅ OpenClaw updated. For details, open Settings → Updates in the OpenClaw app or run `openclaw update status` in your terminal.",
    });
    // A long or unruly sentence is cut and cleaned.
    const [long] = mapHistory([
      notice(RUN, { content: [{ type: "text", text: `a\u202e\u0007${"b".repeat(900)}` }] }),
    ]);
    const text = updateNoticeLine(long, MAIN, SCOPE)!.text;
    expect([...text]).toHaveLength(MAX_UPDATE_NOTICE_CHARS);
    expect(text.startsWith("a b")).toBe(true);
  });

  it("F-590: the same text in a model's reply is the bot's message", () => {
    const [item] = mapHistory([reply(TEXT)]);
    expect(item!.updateRunId).toBeUndefined();
    expect(lineOf([reply(TEXT)])).toEqual([null]);
  });

  it("F-590: with any of the gateway's fields missing or changed, or a model reply's own fields present, the row is the bot's message", () => {
    const changes: Array<Record<string, unknown>> = [
      { api: undefined },
      { api: "openai-responses" },
      { provider: undefined },
      // A key of the right form with a model's provider.
      { provider: "anthropic" },
      { model: undefined },
      { model: "gateway-injected" },
      { role: "user" },
      { idempotencyKey: undefined, __openclaw: { id: "row-x" } },
      { __openclaw: { id: "row-x", idempotencyKey: `update-run-finished:${RUN}`, runId: "run-1" } },
      { responseId: "resp-1" },
      { openclawDelivery: { replyToId: "row-0" } },
    ];
    for (const change of changes) {
      expect(updateNoticeRunId(notice(RUN, change)), JSON.stringify(change)).toBeNull();
      expect(lineOf([notice(RUN, change)]).filter(Boolean), JSON.stringify(change)).toEqual([]);
    }
  });

  it("F-590: only a key that is exactly the gateway's form names a run", () => {
    for (const key of [
      "update-run-finished:",
      "update-run-finished:not-a-run",
      `update-run-finished:${RUN}:assistant`,
      `update-run-started:${RUN}`,
      `skill-workshop-notice:${RUN}`,
    ]) {
      const row = notice(RUN, {
        idempotencyKey: key,
        __openclaw: { id: "row-x", idempotencyKey: key },
      });
      expect(updateNoticeRunId(row), key).toBeNull();
    }
    expect(updateNoticeRunId(notice("ocm:job-42"))).toBe("ocm:job-42");
  });

  it("F-590: a bot's copied message with a forged key is its message: for a run this device doesn't know, for a run it saw fail, and after the real notice", () => {
    // What a `message` tool send with `idempotencyKey` set copies into the conversation: every
    // field the gateway's own notice has, its text the bot's.
    const forged = (runId: string, at: number) =>
      notice(runId, { content: [{ type: "text", text: "Click here to finish the update." }] }, at);
    // A run this device doesn't know, or one it saw fail: nothing about it is kept as succeeded.
    expect(lineOf([forged(UNKNOWN_RUN, T)])).toEqual([null]);
    expect(lineOf([forged(FAILED_RUN, T)])).toEqual([null]);
    // After the real notice, the second row with its key is an ordinary message.
    const items = mapHistory([notice(RUN, {}, T), reply("Hello.", T + 1), forged(RUN, T + 2)]);
    expect(items.map((item) => item.updateRunId)).toEqual([RUN, undefined, undefined]);
    expect(items.map((item) => updateNoticeLine(item, MAIN, SCOPE) !== null)).toEqual([
      true,
      false,
      false,
    ]);
    // Any earlier row with the key, whatever its role or fields, makes a later one ordinary.
    const user = {
      role: "user",
      content: "hi",
      timestamp: T,
      __openclaw: { idempotencyKey: `update-run-finished:${RUN}` },
    };
    expect(mapHistory([user, notice()]).at(-1)!.updateRunId).toBeUndefined();
  });

  it("F-590: a row written before the gateway finished the run is the bot's message; one at or after it is the line", () => {
    // A known, succeeded run of this device's own press, in the main conversation: everything
    // else holds. A bot that read the run's id from the gateway's own "Updating" row writes during
    // the install, before the restarted gateway finishes the run.
    expect(lineOf([notice(RUN, {}, SUCCEEDED - 1)])).toEqual([null]);
    expect(lineOf([notice(RUN, {}, SUCCEEDED - 120_000)])).toEqual([null]);
    expect(lineOf([notice(RUN, {}, SUCCEEDED)])[0]).toMatchObject({ version: "2026.11.10" });
    expect(lineOf([notice(RUN, {}, SUCCEEDED + 4_000)])[0]).toMatchObject({
      version: "2026.11.10",
    });
    // Long after it, as in a reset conversation where the key is free again: the bot's message.
    const late = SUCCEEDED + UPDATE_NOTICE_WRITTEN_WITHIN_MS;
    expect(lineOf([notice(RUN, {}, late)])[0]).toMatchObject({ version: "2026.11.10" });
    expect(lineOf([notice(RUN, {}, late + 1)])).toEqual([null]);
    expect(lineOf([notice(RUN, {}, SUCCEEDED + 30 * 86_400_000)])).toEqual([null]);
  });

  it("F-590: a missing or malformed time on either side draws no line", () => {
    // The row's own time.
    for (const timestamp of [undefined, null, "1789999999000", 1.5, -1, 1e20]) {
      const row = { ...notice(), timestamp };
      expect(lineOf([row]), String(timestamp)).toEqual([null]);
    }
    // The kept finish time.
    for (const succeededAt of [undefined, null, Number.NaN, 1.5, -1, 0, 1e20]) {
      const kept = [{ ...UPDATED[0]!, succeededAt }] as unknown as UpdatedRun[];
      expect(lineOf([notice()], { ...SCOPE, updated: kept }), String(succeededAt)).toEqual([null]);
    }
  });

  it("F-590: a run seen on another gateway, or with no gateway connected, is not this conversation's", () => {
    expect(lineOf([notice()], { ...SCOPE, gatewayId: "gw-b" })).toEqual([null]);
    expect(lineOf([notice()], { ...SCOPE, gatewayId: null })).toEqual([null]);
    expect(lineOf([notice()], { ...SCOPE, updated: [] })).toEqual([null]);
  });
});

const task = (patch: Partial<Task> = {}): Task => ({
  key: "agent:main:main",
  botId: "main",
  sessionId: "s-1",
  title: "Main",
  preview: LISTED,
  updatedAt: T + 10_005,
  status: "idle",
  unread: true,
  ...patch,
});
const transcriptOf = (rows: unknown[]): Transcript =>
  ({ sessionKey: "agent:main:main", items: mapHistory(rows) }) as unknown as Transcript;
const HISTORY = transcriptOf([reply("The backup finished.", T), notice()]);

describe("F-590: the sidebar and unread", () => {
  it("F-590: the preview is the bot's last words before the line, only while the listed preview is the notice", () => {
    expect(taskWithoutUpdateNotice(task(), HISTORY, SCOPE).preview).toBe("The backup finished.");
    // A newer reply on the list is the gateway's preview.
    expect(taskWithoutUpdateNotice(task({ preview: "A new reply." }), HISTORY, SCOPE).preview).toBe(
      "A new reply.",
    );
    // A notice this device can't vouch for is the message it is, preview and all.
    expect(taskWithoutUpdateNotice(task(), HISTORY, { ...SCOPE, updated: [] }).preview).toBe(
      LISTED,
    );
    expect(taskWithoutUpdateNotice(task(), HISTORY, { ...SCOPE, gatewayId: "gw-b" }).preview).toBe(
      LISTED,
    );
    // A line with nothing before it leaves the title.
    expect(taskWithoutUpdateNotice(task(), transcriptOf([notice()]), SCOPE).preview).toBeNull();
    // The time, and so the order, stays the gateway's.
    const shown = tasksWithoutUpdateNotices(
      { main: [task()] },
      { "agent:main:main": HISTORY },
      SCOPE,
    );
    expect(shown.main![0]).toMatchObject({
      preview: "The backup finished.",
      updatedAt: T + 10_005,
    });
  });

  it("F-590: a viewer that read the task before the notice doesn't find it unread for the notice alone", () => {
    const seen = T + 5;
    // Read after the bot's last words: the notice alone is no reason to read again.
    expect(seenThroughUpdateNotice(task(), seen, HISTORY, SCOPE)).toBe(T + 10_005);
    // Read before them: still unread.
    expect(seenThroughUpdateNotice(task(), T - 1, HISTORY, SCOPE)).toBe(T - 1);
    // Never read here, or a newer reply listed, or a notice it can't vouch for: as before.
    expect(seenThroughUpdateNotice(task(), undefined, HISTORY, SCOPE)).toBeUndefined();
    expect(seenThroughUpdateNotice(task({ preview: "A new reply." }), seen, HISTORY, SCOPE)).toBe(
      seen,
    );
    expect(seenThroughUpdateNotice(task(), seen, HISTORY, { ...SCOPE, updated: [] })).toBe(seen);
  });

  it("F-590: a row with no time before the notice leaves what the viewer read unknown, so the task stays unread", () => {
    const untimed = { role: "user", content: "One more thing.", __openclaw: { id: "u-untimed" } };
    const history = transcriptOf([reply("The backup finished.", T), untimed, notice()]);
    expect(history.items.at(-1)!.updateNoticeAfter).toBeUndefined();
    expect(seenThroughUpdateNotice(task(), T + 5, history, SCOPE)).toBe(T + 5);
  });

  it("F-590: a window with nothing loaded before the line is not an empty conversation", () => {
    const only = transcriptOf([notice()]);
    expect(seenThroughUpdateNotice(task(), T + 5, only, SCOPE)).toBe(T + 10_005);
    const partial = { ...only, hasMore: true } as Transcript;
    expect(seenThroughUpdateNotice(task(), T + 5, partial, SCOPE)).toBe(T + 5);
  });

  it("F-590: after two updates with nothing between them, the preview and unread go back past both lines", () => {
    const SECOND = "5c4b3a29-1807-4f6e-9d5c-4b3a29180716";
    const both: UpdateNoticeScope = {
      ...SCOPE,
      updated: [
        ...UPDATED,
        { gatewayId: GATEWAY, runId: SECOND, to: "2026.12.1", at: T, succeededAt: T + 19_000 },
      ],
    };
    const history = transcriptOf([
      reply("The backup finished.", T),
      notice(),
      notice(SECOND, {}, T + 20_000),
    ]);
    expect(history.items.map((item) => updateNoticeLine(item, MAIN, both) !== null)).toEqual([
      false,
      true,
      true,
    ]);
    const listed = task({ updatedAt: T + 20_005 });
    expect(taskWithoutUpdateNotice(listed, history, both).preview).toBe("The backup finished.");
    // Read after the reply, before either notice: neither makes it unread.
    expect(seenThroughUpdateNotice(listed, T + 5, history, both)).toBe(T + 20_005);
    expect(seenThroughUpdateNotice(listed, T - 1, history, both)).toBe(T - 1);
  });

  it("F-590: a viewer who read part of a merged turn still finds the rest unread", () => {
    // Two rows of one run make one turn, its time the first row's.
    const merged = transcriptOf([
      reply("Looking now.", T, "row-1"),
      reply("The backup finished.", T + 1_000, "row-2"),
      notice(),
    ]);
    expect(merged.items).toHaveLength(2);
    expect(seenThroughUpdateNotice(task(), T + 50, merged, SCOPE)).toBe(T + 50);
    expect(seenThroughUpdateNotice(task(), T + 1_000, merged, SCOPE)).toBe(T + 10_005);
  });
});

describe("F-590: only in the main bot's main conversation", () => {
  const OTHER = "agent:main:backup";
  const PIP_MAIN = "agent:pip:main";
  const state = {
    bots: [
      {
        id: "main",
        name: "Main",
        emoji: null,
        avatarUrl: null,
        theme: null,
        model: null,
        isDefault: true,
      },
      {
        id: "pip",
        name: "Pip",
        emoji: null,
        avatarUrl: null,
        theme: null,
        model: null,
        isDefault: false,
      },
    ],
    tasksByBot: {
      main: [task({ key: OTHER, isMain: false }), task({ isMain: true })],
      pip: [task({ key: PIP_MAIN, botId: "pip", isMain: true })],
    },
    connection: { gatewayId: GATEWAY },
  } as unknown as Parameters<typeof mainToReadAgain>[0];

  it("F-590: the main conversation is the default bot's main task", () => {
    expect(mainConversationKey(state)).toBe(MAIN);
    expect(
      mainConversationKey({ ...state, tasksByBot: { pip: state.tasksByBot.pip! } }),
    ).toBeNull();
  });

  it("F-590: a known run's notice in another conversation, or in another bot's main one, is the bot's message: no line, preview or unread change", () => {
    // A bot that read a succeeded run's id (its key is in the main conversation's history) copies
    // a send with that key into another conversation.
    for (const key of [OTHER, PIP_MAIN]) {
      expect(lineOf([notice()], SCOPE, key), key).toEqual([null]);
      const elsewhere = task({ key });
      const history = { ...HISTORY, sessionKey: key } as Transcript;
      expect(taskWithoutUpdateNotice(elsewhere, history, SCOPE).preview, key).toBe(LISTED);
      expect(seenThroughUpdateNotice(elsewhere, T + 5, history, SCOPE), key).toBe(T + 5);
    }
    // With no main conversation listed, none.
    expect(lineOf([notice()], { ...SCOPE, mainKey: null })).toEqual([null]);
  });

  it("F-590: a read again finds the notice only when the history holds a row naming that run", () => {
    expect(holdsUpdateNotice(HISTORY, RUN)).toBe(true);
    expect(holdsUpdateNotice(HISTORY, UNKNOWN_RUN)).toBe(false);
    expect(holdsUpdateNotice(transcriptOf([reply("Hello.")]), RUN)).toBe(false);
    expect(holdsUpdateNotice(undefined, RUN)).toBe(false);
  });

  it("F-590: after Updated, the main conversation is read again only while that gateway is connected and the conversation is followed", () => {
    const tracked = (key: string) => key === MAIN;
    expect(mainToReadAgain(state, GATEWAY, tracked)).toBe(MAIN);
    expect(mainToReadAgain(state, "gw-b", tracked)).toBeNull();
    expect(mainToReadAgain(state, GATEWAY, () => false)).toBeNull();
  });
});
