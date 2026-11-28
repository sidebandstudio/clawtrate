// What a task's chat shows, from its transcript: the task's title first, the
// centred stamps, your messages with the files they carried, the bot's with the
// files it handed over under the row that carried them, and each
// of the bot's actions as one line in the engine's own words (`lineOf`, `foldLineOf`, grouped by
// `groupFeed` as the desktop groups them). Reasoning stays folded away, as the
// design says; it is not drawn here. A run that is going on shows its streaming
// text and says what it does in the status line's words, in the past tense
// while the connection is lost or closed, and the history that lands when it
// ends replaces both. A message the engine cut or the gateway truncated, and
// earlier messages not loaded, are said. Pure, so the unit tests cover it.

import {
  activeRun,
  callFromBlock,
  foldLineOf,
  groupFeed,
  lineOf,
  readingContextOf,
  type FeedEntry,
  type ChatFile,
  type Run,
  type SentAttachment,
  type Step,
  type Task,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import { actionWords } from "@clawtrate/core";
import { CONVERSATION_WORDS, stampBefore } from "./presentation/conversation-words.ts";
import { stampTime } from "../../../packages/ui/src/format.ts";
import { statusLineFor } from "../../../packages/ui/src/live.ts";
import { STATE_WORDS } from "./presentation/summary.ts";

export type ChatRow =
  | { kind: "stamp"; id: string; text: string }
  | {
      kind: "user";
      id: string;
      text: string;
      /** What names the message for its pictures (`readSentPicture`); null when nothing does. */
      messageKey: string | null;
      /** The files the person sent with it, in the order sent. */
      files: readonly SentAttachment[];
    }
  | { kind: "bot"; id: string; text: string }
  /** The files a bot handed over that aren't pictures, under the message that carried them (F-115). */
  | { kind: "files"; id: string; files: readonly ChatFile[] }
  | {
      kind: "action";
      id: string;
      /** The line's words, as the desktop's card reads them. */
      text: string;
      /** The accessible name. */
      spoken: string;
      tone: "danger" | null;
    }
  | {
      kind: "event";
      id: string;
      text: string;
      /**
       * The text a turn the gateway started itself came with (`TranscriptItem.gatewayEvent`,
       * OpenClaw 2026.11.10 and later), apart from the gateway's line. Absent otherwise.
       */
      eventText?: string;
    }
  /** A message the engine cut or the gateway truncated, or earlier messages not loaded. */
  | { kind: "note"; id: string; text: string }
  /**
   * A run going on now: what it is doing, in the status line's words. `tone` is
   * the connection's: live while connected, lost while it reconnects, off when
   * the person closed it.
   */
  | { kind: "running"; id: string; text: string; tone: "live" | "lost" | "off" };

/** How the connection stands, for what a run is said to be doing. */
export type Link = { connected: boolean; closed: boolean };

/** A bubble's text, and the gateway's id of the row it came from: its files go under it. */
type Ref = { text: string; messageId?: string | undefined };

/** Every tool step of the task's runs, by tool call id: history's block reads better with it. */
function stepIndex(runs: Run[]): Map<string, { step: Step; run: Run }> {
  const index = new Map<string, { step: Step; run: Run }>();
  for (const run of runs)
    for (const step of run.steps)
      if (step.kind === "tool" && step.toolCallId) index.set(step.toolCallId, { step, run });
  return index;
}

/** One assistant item's record, in order, for the engine's grouping. */
function entriesOf(
  item: TranscriptItem,
  index: Map<string, { step: Step; run: Run }>,
): FeedEntry<Ref>[] {
  const entries: FeedEntry<Ref>[] = [];
  item.blocks.forEach((block, i) => {
    if (block.kind === "text") {
      if (block.text.trim())
        entries.push({
          type: "bubble",
          id: `${item.id}:t${i}`,
          ref: { text: block.text, messageId: block.messageId },
        });
    } else if (block.kind === "reasoning") {
      entries.push({
        type: "reasoning",
        segment: { id: `${item.id}:r${i}`, text: block.text, startedAt: null, endedAt: null },
      });
    } else {
      const found = index.get(block.callId);
      entries.push({ type: "action", call: callFromBlock(block, found?.step, found?.run) });
    }
  });
  return entries;
}

/**
 * The phrase for a task that runs now, and its tone; null when nothing runs.
 * With no transcript loaded (a task opened while offline), the gateway's row
 * alone says what was last seen.
 */
export function runningWords(
  task: Task,
  transcript: Transcript | undefined,
  botName: string,
  link: Link,
): { text: string; tone: "live" | "lost" | "off" } | null {
  const tone = link.connected ? "live" : link.closed ? "off" : "lost";
  const run = transcript ? activeRun(transcript) : null;
  if (run && transcript) {
    const view = statusLineFor(run, transcript, {
      connected: link.connected,
      interactive: false,
    });
    // Text that streams with no tool running is the bot writing, not thinking.
    const writing =
      link.connected &&
      view.callId === null &&
      run.text.trim() !== "" &&
      view.phrase === actionWords.PHRASES.thinking;
    const phrase = link.closed
      ? view.phrase.replace(/^Reconnecting\./, "Disconnected.")
      : view.phrase;
    return { text: writing ? actionWords.PHRASES.writing : phrase, tone };
  }
  if (task.status !== "running") return null;
  // The gateway's row says it runs before this client has seen the run. That is
  // news only while connected; a row kept from before is what was last seen.
  if (link.connected) return { text: `The gateway reports a run for ${botName}.`, tone };
  const phrase = link.closed ? actionWords.PHRASES.disconnected : actionWords.PHRASES.reconnecting;
  return { text: phrase(STATE_WORDS.working), tone };
}

/** What to say under an item the gateway truncated when it stored it, or the engine cut a block of to its bound. */
export function shortenedWords(item: TranscriptItem): string | null {
  if (item.truncated === true) return CONVERSATION_WORDS.truncated;
  return (item.cut ?? []).some((path) => path.startsWith("blocks"))
    ? CONVERSATION_WORDS.shortened
    : null;
}

function noteRow(item: TranscriptItem): ChatRow[] {
  const text = shortenedWords(item);
  return text ? [{ kind: "note", id: `shortened:${item.id}`, text }] : [];
}

/** A bot's turn with each of its files under the bubble of the row that carried it, the rest at its end. */
function placeFiles(
  item: TranscriptItem,
  turn: readonly ChatRow[],
  rowOf: ReadonlyMap<string, number>,
): ChatRow[] {
  // By the place in the turn each goes after; `turn.length` is its end.
  const under = new Map<number, ChatFile[]>();
  for (const file of item.files ?? []) {
    const at =
      (file.messageId === undefined ? undefined : rowOf.get(file.messageId)) ?? turn.length;
    under.set(at, [...(under.get(at) ?? []), file]);
  }
  const placed: ChatRow[] = [];
  for (let at = 0; at <= turn.length; at += 1) {
    if (at < turn.length) placed.push(turn[at]!);
    const files = under.get(at);
    if (files) placed.push({ kind: "files", id: `files:${item.id}:${at}`, files });
  }
  return placed;
}

export function chatRows(
  task: Task,
  transcript: Transcript,
  botName: string,
  now: number,
  link: Link,
): ChatRow[] {
  const rows: ChatRow[] = [];
  if (transcript.hasMore)
    rows.push({ kind: "note", id: "earlier", text: CONVERSATION_WORDS.earlier });
  const ctx = readingContextOf(transcript);
  const index = stepIndex(transcript.runs);
  let previous: number | null = null;
  for (const item of transcript.items) {
    const at = item.timestamp;
    if (stampBefore(previous, at))
      rows.push({ kind: "stamp", id: `stamp:${item.id}`, text: stampTime(at!, now) });
    if (at !== null) previous = at;
    if (item.role === "system") {
      const texts = item.blocks.map((block) => (block.kind === "text" ? block.text : ""));
      // The gateway's line, and the text its event came with kept apart from it (#699).
      if (item.gatewayEvent) {
        const [line = "", eventText = ""] = texts;
        rows.push({ kind: "event", id: item.id, text: line, eventText });
      } else {
        const text = texts.join(" ").trim();
        if (text) rows.push({ kind: "event", id: item.id, text });
      }
      rows.push(...noteRow(item));
      continue;
    }
    if (item.role === "user") {
      const text = item.blocks
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join("\n\n")
        .trim();
      const files = item.attachments ?? [];
      if (text || files.length > 0)
        rows.push({
          kind: "user",
          id: item.id,
          text,
          messageKey: item.idempotencyKey ?? item.messageId ?? null,
          files,
        });
      rows.push(...noteRow(item));
      continue;
    }
    // Each file goes under the last bubble of the row that carried it, as on the desktop
    // (`placeFiles`); the rest go under the turn.
    const turn: ChatRow[] = [];
    const rowOf = new Map<string, number>();
    for (const group of groupFeed(entriesOf(item, index), ctx)) {
      if (group.type === "bubble") {
        if (group.ref.messageId) rowOf.set(group.ref.messageId, turn.length);
        turn.push({ kind: "bot", id: group.key, text: group.ref.text });
      } else if (group.type === "action") {
        const line = lineOf(group.call, ctx);
        turn.push({
          kind: "action",
          id: group.key,
          text: line.title,
          spoken: line.spoken,
          tone: line.problem ? "danger" : null,
        });
      } else if (group.type === "fold") {
        const line = foldLineOf(
          group.members.map((member) => member.call),
          ctx,
        );
        turn.push({
          kind: "action",
          id: group.key,
          text: line.title,
          spoken: line.spoken,
          tone: line.tone === "danger" ? "danger" : null,
        });
      }
    }
    rows.push(...placeFiles(item, turn, rowOf));
    rows.push(...noteRow(item));
  }
  const active = activeRun(transcript);
  // What the run has written so far, before it lands in history.
  if (active && active.text.trim() !== "") {
    rows.push({ kind: "bot", id: `live:${active.id}`, text: active.text });
    if (active.cut?.includes("text"))
      rows.push({
        kind: "note",
        id: `shortened:live:${active.id}`,
        text: CONVERSATION_WORDS.shortened,
      });
  }
  const running = runningWords(task, transcript, botName, link);
  if (running) rows.push({ kind: "running", id: "running", ...running });
  return rows;
}
