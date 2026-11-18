// What a task's chat shows, from its transcript: the task's title first, the
// centred stamps, your messages and the bot's, and each of the bot's actions as
// one line in the engine's own words (`lineOf`, `foldLineOf`, grouped by
// `groupFeed` as the desktop groups them). Reasoning stays folded away, as the
// design says; it is not drawn here. A run that is going on says so in the
// status line's words; its streaming text is not shown yet, and the history
// that lands when it ends replaces the note. Pure, so the unit tests cover it.

import {
  activeRun,
  callFromBlock,
  foldLineOf,
  groupFeed,
  lineOf,
  readingContextOf,
  type FeedEntry,
  type Run,
  type Step,
  type Task,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import { stampBefore } from "@clawtrate/ui/conversation-words";
import { stampTime } from "@clawtrate/ui/format";
import { statusLineFor } from "@clawtrate/ui/live";
import { STATE_WORDS } from "@clawtrate/ui/summary";

export type ChatRow =
  | { kind: "stamp"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "bot"; id: string; text: string }
  | {
      kind: "action";
      id: string;
      /** The line's words, as the desktop's card reads them. */
      text: string;
      /** The accessible name. */
      spoken: string;
      tone: "danger" | null;
    }
  | { kind: "event"; id: string; text: string }
  /** A run going on now: what it is doing, in the status line's words. */
  | { kind: "running"; id: string; text: string };

type Ref = { text: string };

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
        entries.push({ type: "bubble", id: `${item.id}:t${i}`, ref: { text: block.text } });
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

/** The phrase for a task that runs now, or null when nothing runs. */
export function runningWords(
  task: Task,
  transcript: Transcript,
  botName: string,
  connected: boolean,
): string | null {
  const run = activeRun(transcript);
  if (run) return statusLineFor(run, transcript, { connected, interactive: false }).phrase;
  // The gateway's row says it runs before this client has seen the run itself.
  return task.status === "running" ? `${botName}, ${STATE_WORDS.working}` : null;
}

export function chatRows(
  task: Task,
  transcript: Transcript,
  botName: string,
  now: number,
  connected: boolean,
): ChatRow[] {
  const rows: ChatRow[] = [];
  const ctx = readingContextOf(transcript);
  const index = stepIndex(transcript.runs);
  let previous: number | null = null;
  for (const item of transcript.items) {
    const at = item.timestamp;
    if (stampBefore(previous, at))
      rows.push({ kind: "stamp", id: `stamp:${item.id}`, text: stampTime(at!, now) });
    if (at !== null) previous = at;
    if (item.role === "system") {
      const text = item.blocks
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join(" ")
        .trim();
      if (text) rows.push({ kind: "event", id: item.id, text });
      continue;
    }
    if (item.role === "user") {
      const text = item.blocks
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join("\n\n")
        .trim();
      if (text) rows.push({ kind: "user", id: item.id, text });
      continue;
    }
    for (const group of groupFeed(entriesOf(item, index), ctx)) {
      if (group.type === "bubble") rows.push({ kind: "bot", id: group.key, text: group.ref.text });
      else if (group.type === "action") {
        const line = lineOf(group.call, ctx);
        rows.push({
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
        rows.push({
          kind: "action",
          id: group.key,
          text: line.title,
          spoken: line.spoken,
          tone: line.tone === "danger" ? "danger" : null,
        });
      }
    }
  }
  const running = runningWords(task, transcript, botName, connected);
  if (running) rows.push({ kind: "running", id: "running", text: running });
  return rows;
}
