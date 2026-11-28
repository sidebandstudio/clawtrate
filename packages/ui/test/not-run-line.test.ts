// The line under a message the gateway couldn't run (#663, F-480): the gateway's reason in plain
// words, and the ways forward, each kind as the gateway says it; nothing it didn't say.

import {
  attachmentsCut,
  emptyActivity,
  enforceState,
  historyQueuePairs,
  mapHistory,
  mergeHistoryRuns,
  newRun,
  RawTable,
  registerRunAlias,
  runsFromHistory,
  throughRunAliases,
  type Bot,
  type ClawtrateBridge,
  type Run,
  type TaskActivity,
  type Transcript,
  wordsCut,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  requestBotSettings,
  setBotSettingsOpener,
  settlement,
  type BotSettingsRequest,
  type ControlState,
} from "../src/bots/settings-request.ts";
import {
  endingOf,
  failedTurnTitle,
  forEarlierMessage,
  notRunWords,
  type RunEnding,
  userMessageAfter,
} from "../src/live.ts";
import { BridgeProvider } from "../src/bridge.tsx";
import {
  messageReplyOf,
  messageTextOf,
  retryPlan,
  RunEnding as RunEndingCard,
} from "../src/LiveTurn.tsx";

const KEY = "agent:otto:disk-space";

const NOW = 1_795_000_000_000;

/** A run this client followed, failed with the gateway's words and nothing reported started. */
const failed = (message: string, change: Partial<Run> = {}): Run => ({
  ...newRun("run-1", { state: "running", origin: "local", bound: true }, NOW),
  state: "failed",
  outcomeKnown: true,
  endedAt: NOW + 300,
  error: { message, kind: null },
  ...change,
});

/** What the line says, and the ways forward before Try again: as the card draws them. */
function words(run: Run): string {
  const ending = endingOf(run);
  if (ending?.kind !== "not-run" && ending?.kind !== "not-started")
    return `not a not-run line: ${ending?.kind ?? "none"}`;
  const said = notRunWords(ending, "Otto");
  const ways = said.ways.map((way) => (way === "model" ? "Change model" : "Change account"));
  return [said.title, said.reason, ...ways].join(" | ");
}

describe("#663: a message the gateway couldn't run says so, and why", () => {
  it("F-480: a model that needs an API key on a sign-in account: why, and the model and account", () => {
    const run = failed(
      'Auth profile "acme:default" uses oauth auth, but acme/acme-responses requires an Acme API key profile.',
    );
    expect(words(run)).toBe(
      "The gateway couldn't run this message | Otto is set to a model that needs a provider API key, but the account it uses is a sign-in. Choose a model that works with that sign-in, or add an API key. | Change model | Change account",
    );
  });

  it("F-480: each kind the gateway names has its own sentence and ways forward", () => {
    const of = (message: string) => {
      const ending = endingOf(failed(message));
      expect(ending?.kind).toBe("not-run");
      return notRunWords(ending as Extract<typeof ending, { kind: "not-run" }>, "Otto");
    };
    expect(
      of(
        "This saved login isn't available. Choose another login under Models in the OpenClaw app or run `openclaw configure`.",
      ),
    ).toEqual({
      title: "The gateway couldn't run this message",
      reason: "The account Otto is set to isn't available on the gateway. Choose another account.",
      ways: ["account"],
    });
    expect(of('Error: Auth profile "acme:work" is not configured for globex.').ways).toEqual([
      "account",
      "model",
    ]);
    // The gateway's own words belong in Details.
    expect(of("Unknown model: nope/dev-1. Run `openclaw models list`.")).toMatchObject({
      reason: "The gateway doesn't know Otto's model. Choose another model.",
      ways: ["model"],
    });
    expect(
      of('No API key found for provider "globex". Auth store: /somewhere/auth.json.').reason,
    ).toBe(
      "The gateway found no account it can use for the provider of Otto's model. Add an account, or choose another model.",
    );
  });

  it("an unclassified account reason gives the same recovery choices as another unknown reason", () => {
    expect(
      words(
        failed(
          'Auth profile "acme:me" uses oauth auth, but acme/acme-responses requires token-sharing consent. Sign in again and enable sharing, or explicitly choose another inference credential.',
        ),
      ),
    ).toBe(
      "The gateway couldn't run this message | Try again, or choose another model for this bot. | Change model",
    );
  });

  it("an unknown reason gives a recovery action, and a reason the gateway did not keep stays absent", () => {
    expect(words(failed("Error: The session is locked by another device."))).toBe(
      "The gateway couldn't run this message | Try again, or choose another model for this bot. | Change model",
    );
    // 2026.11.10's history, after a reload, for a message it failed at dispatch.
    expect(
      words(
        failed("Your request couldn't be completed.", {
          origin: "history",
          error: { message: "Your request couldn't be completed.", kind: null, beforeReply: true },
        }),
      ),
    ).toBe("The gateway couldn't run this message | The gateway didn't say why.");
    // Words that are only control and format characters are none once made one plain line (#783).
    expect(words(failed("Error: \u0007​"))).toBe(
      "The gateway couldn't run this message | The gateway didn't say why.",
    );
  });

  it("a message the gateway accepted and then ended with no run and no word", () => {
    const silent: Run = {
      ...newRun("run-1", { state: "running", origin: "local", bound: true }, NOW),
      state: "completed",
      outcomeKnown: false,
      endedAt: NOW + 9_000,
    };
    expect(words(silent)).toBe(
      "The gateway didn't start a run for this message | It didn't say why.",
    );
  });

  it("a run that started and then failed keeps its own card", () => {
    const started = failed("401 Invalid API key", { reportedStartAt: NOW + 10 });
    expect(endingOf(started)).toEqual({ kind: "failed", reason: "401 Invalid API key" });
    expect(words(started)).toBe("not a not-run line: failed");
    // History's run of a failed turn has no start of its own: only the gateway's row says it never ran.
    expect(endingOf(failed("401 Invalid API key", { origin: "history" }))?.kind).toBe("failed");
  });

  it("a request settles on its own bot's page only, once drawn, focusing what can take focus", () => {
    const model: BotSettingsRequest = { botId: "otto", part: "model", seq: 1 };
    const account: BotSettingsRequest = { botId: "otto", part: "account", seq: 2 };
    const page =
      (controls: Record<string, ControlState>) =>
      (selector: string): ControlState =>
        controls[selector] ?? null;
    const first = page({
      "[data-bs='account']": "usable",
      '[data-testid="model-select"]': "usable",
    });
    expect(settlement(model, "otto", first)).toEqual({ focus: '[data-testid="model-select"]' });
    // Another bot's page, drawn with an enabled model menu: Otto's request is not settled there.
    expect(settlement(model, "pip", first)).toBeNull();
    expect(settlement(account, "pip", page({ "[data-bs='change']": "usable" }))).toBeNull();
    // Not drawn yet (the accounts still read).
    expect(settlement(model, "otto", page({}))).toBeNull();
    // Below admin the model menu is disabled: settled, focus left where it is.
    expect(
      settlement(
        model,
        "otto",
        page({ "[data-bs='account']": "usable", '[data-testid="model-select"]': "disabled" }),
      ),
    ).toEqual({ focus: null });
    // The Account page: its Change button, else its heading.
    expect(settlement(account, "otto", page({ "[data-bs='change']": "usable" }))).toEqual({
      focus: "[data-bs='change']",
    });
    expect(settlement(account, "otto", page({ "[data-bs-focus]": "usable" }))).toEqual({
      focus: "[data-bs-focus]",
    });
  });

  it("Change model and Change account open the bot's settings on that part", () => {
    const opened: string[] = [];
    const forget = setBotSettingsOpener(() => opened.push("settings"));
    requestBotSettings("otto", "account");
    expect(opened).toEqual(["settings"]);
    forget();
    requestBotSettings("otto", "model");
    expect(opened).toEqual(["settings"]);
  });
});

describe("#686: a not-run line sits only under the message its run is known to have started from", () => {
  const T0 = 1_795_000_000_000;
  /** A person's message as the gateway keeps it: keyed `<runId>:user`, or with no key at all. */
  const userRow = (runId: string | null, text: string, seq: number) => ({
    role: "user",
    content: text,
    timestamp: T0 + seq,
    __openclaw: { id: `u-${seq}`, seq, ...(runId ? { idempotencyKey: `${runId}:user` } : {}) },
  });
  const failedRow = (runId: string, seq: number) => ({
    role: "custom",
    customType: "run-failed-before-reply",
    display: true,
    timestamp: T0 + seq,
    content:
      "Your request couldn't be completed: This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.",
    __openclaw: { id: `c-${seq}`, seq, runId },
  });
  const replyRow = (runId: string, seq: number) => ({
    role: "assistant",
    content: [{ type: "text", text: "Here it is." }],
    stopReason: "stop",
    timestamp: T0 + seq,
    __openclaw: { id: `a-${seq}`, seq, runId },
  });

  /** After a reload: the task as history alone rebuilds it. */
  function reloaded(rows: unknown[]): { transcript: Transcript; run: Run } {
    const ctx = { raw: new RawTable(), sessionKey: KEY, now: T0 + 10_000 };
    const transcript = {
      ...emptyActivity,
      sessionKey: KEY,
      status: "ready",
      items: mapHistory(rows),
      runs: runsFromHistory(rows, null, ctx),
      error: null,
      hasMore: false,
    } as Transcript;
    return { transcript, run: transcript.runs.find((each) => each.id === "run-a")! };
  }
  const itemOf = (transcript: Transcript, text: string) =>
    transcript.items.find((item) =>
      item.blocks.some((block) => block.kind === "text" && block.text === text),
    )!.id;

  /** Another bot's message that started a run, as both versions keep it: an assistant row keyed `<run>:user`. */
  const fromBotRow = (runId: string, text: string, seq: number) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: T0 + seq,
    provenance: {
      kind: "inter_session",
      sourceSessionKey: "agent:marlow:main",
      sourceTool: "sessions_send",
    },
    __openclaw: { id: `i-${seq}`, seq, idempotencyKey: `${runId}:user`, senderIsOwner: false },
  });

  it("#645: a run another bot's message started has its ending under that message, not above the conversation's first message", () => {
    const rows = [
      userRow("run-0", "Plan the week.", 1),
      replyRow("run-0", 2),
      fromBotRow("run-f", "sessions_send delivery to agent:marlow:main failed.", 3),
    ];
    const ctx = { raw: new RawTable(), sessionKey: KEY, now: T0 + 10_000 };
    const items = mapHistory(rows);
    const run = runsFromHistory(rows, { runId: "run-f" }, ctx).find((each) => each.id === "run-f")!;
    expect(run.anchorItemId).toBe(
      itemOf({ items } as Transcript, "sessions_send delivery to agent:marlow:main failed."),
    );
    // Nothing after it: its ending goes last, under its turn.
    expect(userMessageAfter(items, run.anchorItemId!)).toBeNull();
    // A message the person sends later: the ending sits before it.
    const later = mapHistory([...rows, userRow("run-g", "Thanks.", 4)]);
    expect(userMessageAfter(later, run.anchorItemId!)).toBe(
      itemOf({ items: later } as Transcript, "Thanks."),
    );
  });

  it("#645: Try again never sends another bot's message as the person's", () => {
    const { transcript, run } = reloaded([
      userRow("run-0", "Plan the week.", 1),
      fromBotRow("run-a", "Here is the plan.", 2),
      failedRow("run-a", 3),
    ]);
    expect(run.state).toBe("failed");
    expect(run.anchorKeyed).toBe(true);
    expect(retryPlan(run, transcript)).toBeNull();
  });

  it("A, B, A's failure, B's reply: the line is not under B, and Try again never sends B", () => {
    const { transcript, run } = reloaded([
      userRow("run-a", "Back up the photos.", 1),
      userRow("run-b", "And the notes.", 2),
      failedRow("run-a", 3),
      replyRow("run-b", 4),
    ]);
    expect(endingOf(run)?.kind).toBe("not-run");
    expect(run.anchorItemId).not.toBe(itemOf(transcript, "And the notes."));
    expect(messageTextOf(run, transcript)).not.toBe("And the notes.");
  });

  it("the run known by its key: the line is under A, and Try again sends A again", () => {
    const { transcript, run } = reloaded([
      userRow("run-a", "Back up the photos.", 1),
      userRow("run-b", "And the notes.", 2),
      failedRow("run-a", 3),
      replyRow("run-b", 4),
    ]);
    expect(run.anchorItemId).toBe(itemOf(transcript, "Back up the photos."));
    expect(messageTextOf(run, transcript)).toBe("Back up the photos.");
    expect(forEarlierMessage(run, transcript)).toBe(false);
    const ending = endingOf(run) as Extract<RunEnding, { kind: "not-run" }>;
    expect(notRunWords(ending, "Otto", false).title).toBe("The gateway couldn't run this message");
  });

  it("a position drawn for a run in flight never survives a merge, so Try again never sends B", () => {
    const ctx = { raw: new RawTable(), sessionKey: KEY, now: T0 + 10_000 };
    // First read: A (unkeyed, a channel's message say) is in flight after B's prompt, so it is
    // drawn under B, by position.
    const first = [userRow(null, "Back up the photos.", 1), userRow("run-b", "And the notes.", 2)];
    const inFlight = runsFromHistory(first, { runId: "run-a" }, ctx);
    const before = inFlight.find((each) => each.id === "run-a")!;
    expect(before.anchorKeyed).toBeUndefined();
    // Later read: A failed, B answered.
    const second = [...first, failedRow("run-a", 3), replyRow("run-b", 4)];
    const { runs } = mergeHistoryRuns(inFlight, runsFromHistory(second, null, ctx), ctx);
    const transcript = {
      ...emptyActivity,
      sessionKey: KEY,
      status: "ready",
      items: mapHistory(second),
      runs,
      error: null,
      hasMore: false,
    } as Transcript;
    const run = runs.find((each) => each.id === "run-a")!;
    expect(run.state).toBe("failed");
    expect(run.anchorItemId).not.toBe(itemOf(transcript, "And the notes."));
    expect(messageTextOf(run, transcript)).toBeNull();
    expect(forEarlierMessage(run, transcript)).toBe(true);
  });

  it("Try again never sends a message without its files", () => {
    const { transcript } = reloaded([
      userRow("run-a", "Back up the photos.", 1),
      failedRow("run-a", 2),
    ]);
    const failed = transcript.runs.find((each) => each.id === "run-a")!;
    // Words alone, from history: they go again.
    expect(retryPlan(failed, transcript)).toMatchObject({
      kind: "text",
      text: "Back up the photos.",
    });
    // The same message with a file, known only from history: no Try again.
    const withFile = {
      ...transcript,
      items: transcript.items.map((item) =>
        item.id === failed.anchorItemId
          ? { ...item, attachments: [{ name: "photo.jpg", mimeType: "image/jpeg" }] }
          : item,
      ),
    } as Transcript;
    expect(retryPlan(failed, withFile)).toEqual({ kind: "files-gone" });
    // Still held by this device: its words and files go again together.
    const held = {
      ...withFile,
      outbox: [{ id: "msg-1", text: "Back up the photos.", attachments: [{ id: "f1" }] }],
    } as unknown as Transcript;
    expect(retryPlan({ ...failed, messageId: "msg-1" }, held)).toEqual({
      kind: "again",
      messageId: "msg-1",
    });
  });

  it("F-480 #988: a dropped retry copy keeps its files from being resent as text alone", () => {
    const { run, transcript } = reloaded([
      userRow("run-a", "Back up the photos.", 1),
      failedRow("run-a", 2),
    ]);
    expect(retryPlan({ ...run, retryFiles: "held" }, transcript)).toEqual({
      kind: "retained",
      runId: run.id,
    });
    const dropped: Run = {
      ...run,
      retryFiles: "gone",
      error: {
        message: "The session is being moved to another machine.",
        kind: null,
        beforeReply: true,
      },
    };
    expect(retryPlan(dropped, transcript)).toEqual({ kind: "files-gone" });
    const html = renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge: { getState: () => ({ bots: [] }) } as unknown as ClawtrateBridge,
        children: createElement(RunEndingCard, {
          run: dropped,
          bot: { id: "otto", name: "Otto" } as Bot,
          transcript,
          taskKey: KEY,
        }),
      }),
    );
    expect(html).toContain(
      "This device can no longer resend the files. To try again, attach them to a new message.",
    );
    expect(html).not.toContain(">Try again</button>");
    expect(html).not.toContain("Try again, or choose another model");
    expect(html).toContain("Choose another model for this bot.");
  });

  it("words alone go again only when the message is known to have had no files", () => {
    const { transcript } = reloaded([
      userRow("run-a", "Back up the photos.", 1),
      failedRow("run-a", 2),
    ]);
    const failed = transcript.runs.find((each) => each.id === "run-a")!;
    const file = (name: string) => ({ fileName: name, mimeType: "image/jpeg", sizeBytes: 1 });
    // Two later messages with twenty files each fill the page's list of files.
    const later = [3, 4].map((n) => ({
      id: `later-${n}`,
      role: "user" as const,
      timestamp: T0 + n,
      blocks: [{ kind: "text" as const, text: `Batch ${n}` }],
      model: null,
      attachments: Array.from({ length: 20 }, (_, i) => file(`p${n}-${i}.jpg`)),
    }));
    const kept = (anchorFiles: number, lastBatch = 20) => {
      const items = [
        ...transcript.items.map((item) =>
          item.id === failed.anchorItemId && anchorFiles > 0
            ? { ...item, attachments: Array.from({ length: anchorFiles }, (_, i) => file(`a${i}`)) }
            : item,
        ),
        ...later.map((item, i) =>
          i === later.length - 1
            ? { ...item, attachments: item.attachments.slice(0, lastBatch) }
            : item,
        ),
      ];
      const state = enforceState({ transcripts: { [KEY]: { ...transcript, items } } } as never);
      return (state as unknown as { transcripts: Record<string, Transcript> }).transcripts[KEY]!;
    };
    // Known to have had none, though the list is full: its words go again.
    expect(retryPlan(failed, kept(0))).toMatchObject({ kind: "text", text: "Back up the photos." });
    // Its files cut from the list: whether it had any isn't known, so no Try again.
    const trimmed = kept(1);
    expect(trimmed.items.find((item) => item.id === failed.anchorItemId)?.attachments).toEqual([]);
    expect(retryPlan(failed, trimmed)).toEqual({ kind: "files-unknown" });
    // Some of its files left in the list: it had files, whatever else was cut.
    const partly = kept(2, 19);
    const anchor = partly.items.find((item) => item.id === failed.anchorItemId)!;
    expect(anchor.attachments).toHaveLength(1);
    expect(attachmentsCut(anchor)).toBe(true);
    expect(retryPlan(failed, partly)).toEqual({ kind: "files-gone" });
    // A full list of cut paths (eight, `MAX_CUT_PATHS`) may have let the one for its files go.
    const full = Array.from({ length: 8 }, (_, i) => `blocks[${i}].text`);
    expect(attachmentsCut({ cut: full })).toBe(true);
    expect(attachmentsCut({ cut: full.slice(1) })).toBe(false);
  });

  it("words go again only when they are known whole (#726)", () => {
    const long = "Back up the photos. ".repeat(150);
    const { transcript } = reloaded([userRow("run-a", long, 1), failedRow("run-a", 2)]);
    const failed = transcript.runs.find((each) => each.id === "run-a")!;
    const anchorOf = (t: Transcript) => t.items.find((item) => item.id === failed.anchorItemId)!;
    // Its text cut to the block's bound as the client keeps it: no Try again.
    const state = enforceState({ transcripts: { [KEY]: transcript } } as never);
    const kept = (state as unknown as { transcripts: Record<string, Transcript> }).transcripts[
      KEY
    ]!;
    expect(wordsCut(anchorOf(kept))).toBe(true);
    expect(retryPlan(failed, kept)).toEqual({ kind: "words-cut" });
    // The gateway cut its row: no Try again either.
    const short = reloaded([userRow("run-a", "Back up the photos.", 1), failedRow("run-a", 2)]);
    const marked = {
      ...short.transcript,
      items: short.transcript.items.map((item) =>
        item.id === failed.anchorItemId ? { ...item, truncated: true } : item,
      ),
    } as Transcript;
    expect(retryPlan(failed, marked)).toEqual({ kind: "words-cut" });
    // Whole: its words go again.
    expect(retryPlan(failed, short.transcript)).toMatchObject({
      kind: "text",
      text: "Back up the photos.",
    });
    // A full list of cut paths (eight, `MAX_CUT_PATHS`) may have let the one for its text go.
    const full = Array.from({ length: 8 }, (_, i) => `attachments[${i}]`);
    expect(wordsCut({ cut: full })).toBe(true);
    expect(wordsCut({ cut: full.slice(1) })).toBe(false);
    // With a files plan, the person is told both: its files, and to send its words in full.
    const withCut = (change: object) =>
      ({
        ...short.transcript,
        items: short.transcript.items.map((item) =>
          item.id === failed.anchorItemId ? { ...item, ...change } : item,
        ),
      }) as Transcript;
    const textCuts = Array.from({ length: 8 }, (_, i) => `blocks[${i}].text`);
    expect(retryPlan(failed, withCut({ cut: textCuts }))).toEqual({
      kind: "files-unknown",
      wordsCut: true,
    });
    expect(
      retryPlan(
        failed,
        withCut({ truncated: true, attachments: [{ name: "a.jpg", mimeType: "image/jpeg" }] }),
      ),
    ).toEqual({ kind: "files-gone", wordsCut: true });
  });

  it("a short message whose text the transcript's shared blocks let go is not called too long (#726)", () => {
    const { transcript, run } = reloaded([userRow("run-a", "Hi", 1), failedRow("run-a", 2)]);
    // Newer messages filled the transcript's blocks: this one kept no text, and says so.
    const dropped = {
      ...transcript,
      items: transcript.items.map((item) =>
        item.id === run.anchorItemId ? { ...item, blocks: [], cut: ["blocks"] } : item,
      ),
    } as Transcript;
    expect(retryPlan(run, dropped)).toEqual({ kind: "words-cut" });
    const html = renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge: { getState: () => ({ bots: [] }) } as unknown as ClawtrateBridge,
        children: createElement(RunEndingCard, {
          run,
          bot: { id: "otto", name: "Otto" } as Bot,
          transcript: dropped,
          taskKey: KEY,
        }),
      }),
    );
    expect(html).toContain(
      "The full text of this message isn&#x27;t available here. To try again, send it again in full.",
    );
    expect(html).not.toContain("too long");
  });

  it("a run that started, then failed before replying: the gateway's row says nothing more", () => {
    const ctx = { raw: new RawTable(), sessionKey: KEY, now: T0 + 10_000 };
    // History after the failure: the message, then the row the gateway writes for a run with no
    // reply, which it writes too for a provider error after the request went out.
    const rows = [userRow("run-a", "Back up the photos.", 1), failedRow("run-a", 2)];
    const evidences: Array<[string, Partial<Run>]> = [
      ["a lifecycle start", { reportedStartAt: T0 + 1 }],
      [
        "providerStarted",
        {
          ending: { stopReason: null, timeoutPhase: null, providerStarted: true, status: "error" },
        },
      ],
      ["a start said after the end", { startSaid: true }],
    ];
    for (const [kind, evidence] of evidences) {
      const live = [failed("provider down", { id: "run-a", messageId: "run-a", ...evidence })];
      const { runs } = mergeHistoryRuns(live, runsFromHistory(rows, null, ctx), ctx);
      const transcript = {
        ...emptyActivity,
        sessionKey: KEY,
        status: "ready",
        items: mapHistory(rows),
        runs,
        error: null,
        hasMore: false,
      } as Transcript;
      const run = runs.find((each) => each.id === "run-a")!;
      expect(run.error?.beforeReply, kind).toBe(true);
      // The ordinary failed-turn card, with its Try again.
      expect(endingOf(run)?.kind, kind).toBe("failed");
      expect(retryPlan(run, transcript), kind).toMatchObject({
        kind: "text",
        text: "Back up the photos.",
      });
    }
  });

  it("a reply goes again as a reply only for a run known by its key", () => {
    const { transcript } = reloaded([userRow("run-a", "Back up the photos.", 1)]);
    const withParent = {
      ...transcript,
      items: transcript.items.map((item) => ({
        ...item,
        replyTo: { id: "parent", text: null, sender: null },
      })),
    } as Transcript;
    const run: Run = {
      ...newRun("run-a", { state: "failed", origin: "history", bound: true }, T0),
      anchorItemId: transcript.items[0]!.id,
    };
    expect(messageReplyOf(run, withParent)).toBe("parent");
    // Drawn under it by place only: no Try again, so no parent goes anywhere.
    expect(retryPlan(run, withParent)).toBeNull();
    expect(retryPlan({ ...run, anchorKeyed: true }, withParent)).toEqual({
      kind: "text",
      text: "Back up the photos.",
      replyToId: "parent",
    });
  });

  /** History read as the client reads it: the gateway's own pairings, then the page's. */
  function readAsClient(rows: unknown[], named: Record<string, string>) {
    const ctx = { raw: new RawTable(), sessionKey: KEY, now: T0 + 10_000 };
    let activity: TaskActivity = { ...emptyActivity, queueAliases: named };
    for (const [gateway, client] of historyQueuePairs(rows))
      activity = registerRunAlias(activity, gateway, client);
    const { messages } = throughRunAliases(rows, null, activity.queueAliases);
    return {
      ...emptyActivity,
      sessionKey: KEY,
      status: "ready",
      items: mapHistory(messages),
      runs: runsFromHistory(messages, null, ctx),
      error: null,
      hasMore: false,
    } as Transcript;
  }

  it("A, B, A's reply, B's failure: B's failure under B with its Try again, A's reply under A", () => {
    // A ran from the gateway's queue under an id of its own, which the gateway paired with A.
    const transcript = readAsClient(
      [
        userRow("run-a", "Back up the photos.", 1),
        userRow("run-b", "And the notes.", 2),
        replyRow("gateway-a", 3),
        failedRow("run-b", 4),
      ],
      { "gateway-a": "run-a" },
    );
    const b = transcript.runs.find((each) => each.id === "run-b")!;
    expect(endingOf(b)?.kind).toBe("not-run");
    expect(b.anchorItemId).toBe(itemOf(transcript, "And the notes."));
    expect(retryPlan(b, transcript)).toMatchObject({ kind: "text", text: "And the notes." });
    const a = transcript.runs.find((each) => each.id === "run-a")!;
    expect(a.state).toBe("completed");
    expect(a.anchorItemId).toBe(itemOf(transcript, "Back up the photos."));
  });

  it("the same with keys missing: nothing pairs by place, and what no key ties has no Try again", () => {
    // A from a channel, no key, and no pairing named: B's failure is still B's own.
    const aUnkeyed = readAsClient(
      [
        userRow(null, "Back up the photos.", 1),
        userRow("run-b", "And the notes.", 2),
        replyRow("gateway-a", 3),
        failedRow("run-b", 4),
      ],
      {},
    );
    const b = aUnkeyed.runs.find((each) => each.id === "run-b")!;
    expect(endingOf(b)?.kind).toBe("not-run");
    expect(retryPlan(b, aUnkeyed)).toMatchObject({ kind: "text", text: "And the notes." });
    expect(aUnkeyed.runs.find((each) => each.id === "gateway-a")?.anchorKeyed).toBeUndefined();
    // Neither keyed: B's failure is tied to no message, so it is an earlier one's, with no Try again.
    const neither = readAsClient(
      [
        userRow(null, "Back up the photos.", 1),
        userRow(null, "And the notes.", 2),
        replyRow("gateway-a", 3),
        failedRow("run-b", 4),
      ],
      {},
    );
    const unmatched = neither.runs.find((each) => each.id === "run-b")!;
    expect(endingOf(unmatched)?.kind).toBe("not-run");
    expect(unmatched.anchorItemId).toBeNull();
    expect(retryPlan(unmatched, neither)).toBeNull();
    expect(forEarlierMessage(unmatched, neither)).toBe(true);
  });

  it("only a keyed anchor decides what Try again sends, wherever the card is drawn", () => {
    const { transcript } = reloaded([
      userRow("run-a", "Back up the photos.", 1),
      userRow("run-b", "And the notes.", 2),
      replyRow("run-b", 3),
    ]);
    const drawnUnderB: Run = {
      ...newRun("run-x", { state: "failed", origin: "history", bound: true }, T0),
      anchorItemId: itemOf(transcript, "And the notes."),
    };
    expect(messageTextOf(drawnUnderB, transcript)).toBeNull();
    expect(forEarlierMessage(drawnUnderB, transcript)).toBe(true);
    expect(messageTextOf({ ...drawnUnderB, anchorKeyed: true }, transcript)).toBe("And the notes.");
  });

  it("each run that history keys to its own row sits there, answered ones too", () => {
    const { transcript } = reloaded([
      userRow("run-a", "Back up the photos.", 1),
      userRow("run-b", "And the notes.", 2),
      replyRow("run-a", 3),
      replyRow("run-b", 4),
    ]);
    const anchorOf = (id: string) => transcript.runs.find((each) => each.id === id)!.anchorItemId;
    expect(anchorOf("run-a")).toBe(itemOf(transcript, "Back up the photos."));
    expect(anchorOf("run-b")).toBe(itemOf(transcript, "And the notes."));
  });

  it("a message this device sent and still holds is its run's own, wherever history has it", () => {
    const run = {
      ...newRun("run-a", { state: "failed", origin: "local", bound: true }, T0),
      messageId: "run-a",
    };
    const outbox = [
      { id: "run-a", text: "Back up the photos." },
    ] as unknown as Transcript["outbox"];
    expect(forEarlierMessage(run, { outbox })).toBe(false);
    expect(forEarlierMessage(run, { outbox: [] })).toBe(true);
  });

  it("no message known to have started it: the reason, said to be for an earlier message, and no Try again", () => {
    // A's row carries no key (a message from a channel, say), and B's names B's own run.
    const { transcript, run } = reloaded([
      userRow(null, "Back up the photos.", 1),
      userRow("run-b", "And the notes.", 2),
      failedRow("run-a", 3),
      replyRow("run-b", 4),
    ]);
    expect(run.anchorItemId).toBeNull();
    expect(forEarlierMessage(run, transcript)).toBe(true);
    expect(messageTextOf(run, transcript)).toBeNull();
    const ending = endingOf(run) as Extract<RunEnding, { kind: "not-run" }>;
    expect(notRunWords(ending, "Otto", forEarlierMessage(run, transcript))).toEqual({
      title: "The gateway couldn't run an earlier message",
      reason: "The account Otto is set to isn't available on the gateway. Choose another account.",
      ways: ["account"],
    });
  });

  it("a turn that started and failed, with no message known to have started it: an earlier turn, no Try again", () => {
    const { transcript, run } = reloaded([
      userRow(null, "Back up the photos.", 1),
      userRow("run-b", "And the notes.", 2),
      {
        role: "assistant",
        content: "provider down",
        stopReason: "error",
        errorMessage: "provider down",
        timestamp: T0 + 3,
        __openclaw: { id: "a-3", seq: 3, runId: "run-a" },
      },
      replyRow("run-b", 4),
    ]);
    expect(endingOf(run)?.kind).toBe("failed");
    expect(run.anchorItemId).toBeNull();
    expect(messageTextOf(run, transcript)).toBeNull();
    expect(failedTurnTitle("Otto", forEarlierMessage(run, transcript))).toBe(
      "Otto couldn't finish an earlier turn",
    );
    expect(failedTurnTitle("Otto", false)).toBe("Otto couldn't finish this turn");
  });
});
