// Where the action cards go (docs/design/conversation.md, sections 1 and 7):
// each run's ordered record, from the history item that holds it or from the
// engine's live run, goes through the engine's one grouping (`groupFeed`), so
// a live run and a reload draw the same cards. The Messaged and T3 Code cards
// take their call's place in the column, an approval follows the call it
// names, and a question card takes its `ask_user` call's place. With "Show
// commands" off (7.11) the action cards leave the conversation for the run
// line's list, and the reasoning that led to them stays at their place. With
// "Show thinking" off, no reasoning is drawn.

import {
  actionWords,
  askUserQuestionId,
  callFromBlock,
  callsOf,
  callFromStep,
  groupFeed,
  isTerminal,
  kindOf,
  lineOf,
  mergeThoughts,
  readingContextOf,
  retentionAccount,
  type ActionCall,
  type RetentionAccount,
  runLineOf,
  staysInView,
  type Thought,
  segmentFromStep,
  textPlaced,
  type FeedEntry,
  type FeedGroup,
  type Preamble,
  type ReadingContext,
  type Run,
  type Step,
  type Transcript,
  type TranscriptItem,
  type ChatFile,
  type ChatPicture,
} from "@clawtrate/core";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  CardFor,
  CardThoughtContext,
  PlacedCardsContext,
  codingCalls,
  refKey,
  useScopeCards,
  useStepHandover,
  type CardRef,
} from "../cards/index.ts";
import { fullDate } from "../format.ts";
import { Markdown } from "../Markdown.tsx";
import { MessageUnit } from "../Messages.tsx";
import { BotFiles } from "../BotFiles.tsx";
import { Pictures } from "../Pictures.tsx";
import {
  SkillNoteBody,
  SkillNoteLine,
  skillNotesWords,
  type SkillNoteItem,
} from "../SkillNotes.tsx";
import { useShowCommands, useShowThinking } from "../preferences.ts";
import {
  ActionEnvContext,
  ActionGroup,
  ActionsLine,
  RunLineView,
  ThoughtLine,
  actionDomId,
  type ActionEnv,
} from "./ActionCards.tsx";

/** What a non-action entry of a record is. */
export type FeedRef =
  | {
      t: "text";
      text: string;
      title?: string | undefined;
      messageId?: string | undefined;
      /** The pictures the message of this bubble carried, drawn under it (F-535). */
      pictures?: ChatPicture[];
      /** The other files it carried, drawn under them (F-115). */
      files?: ChatFile[];
    }
  | { t: "preamble"; preamble: Preamble }
  | { t: "reply"; run: Run }
  | { t: "card"; ref: CardRef }
  /** Actions the run reported that are not kept here, at their place. */
  | { t: "gap"; count: number }
  /** The action cards of history with no run, behind one line, while commands are not shown. */
  | { t: "actions"; groups: FeedGroup<FeedRef>[] };

type Groups = FeedGroup<FeedRef>[];

/** The pictures (by id) and files of an item drawn with a bubble; the rest go under the turn. */
type Placed = { pictures: ReadonlySet<string>; files: ReadonlySet<ChatFile> };

type Feeds = {
  /** The groups of each assistant history item, by item id, and the pictures drawn with a bubble. */
  items: Map<string, { groups: Groups; revision: number; placed: Placed }>;
  /** The groups of each run drawn from the engine, by run id. */
  runs: Map<string, { groups: Groups; revision: number }>;
  /** Each run's account of what is drawn (`retentionAccount`), and its drawn calls the engine holds. */
  accounts: Map<string, { account: RetentionAccount; calls: ActionCall[] }>;
  /** Each run's action cards, in order, kept for its run line while commands are not shown (7.11). */
  hidden: Map<string, { groups: Groups; revision: number }>;
};

const FeedsContext = createContext<Feeds | null>(null);

function useFeeds(): Feeds {
  const feeds = useContext(FeedsContext);
  if (!feeds) throw new Error("the transcript's feeds need an ActionScope");
  return feeds;
}

/** Every call of the task's runs, by tool call id, with its run. */
function stepIndex(runs: Run[]): Map<string, { step: Step; run: Run }> {
  const index = new Map<string, { step: Step; run: Run }>();
  for (const run of runs)
    for (const step of run.steps)
      if (step.kind === "tool" && step.toolCallId) index.set(step.toolCallId, { step, run });
  return index;
}

/** The run an assistant history item belongs to: by its calls, else by the user message before it. */
function runOfItem(
  item: TranscriptItem,
  previousUser: string | null,
  index: Map<string, { step: Step; run: Run }>,
  runs: Run[],
): Run | undefined {
  for (const block of item.blocks) {
    if (block.kind === "tool-call") {
      const found = index.get(block.callId);
      if (found) return found.run;
    }
  }
  return previousUser ? runs.find((run) => run.anchorItemId === previousUser) : undefined;
}

type CardsFor = {
  card: (callId: string) => CardRef | null;
  approvals: (callId: string) => CardRef[];
  /**
   * The question card an `ask_user` call asked, by the gateway's question id
   * for that call (`askUserQuestionId`), never by order; null when none was
   * registered (a call that failed first is an ordinary failed action).
   */
  question: (callId: string, runId: string | null) => CardRef | null;
  /** The question cards of a run not placed yet, oldest first: placed by when they arrived. */
  questions: (runId: string) => CardRef[];
  /** Cards already placed in some run's column: each card is placed once. */
  taken: Set<string>;
  /** When a card arrived, as the gateway reported it. */
  arrivedAt: (ref: CardRef) => number | null;
};

/** A tool call as an entry: its card when it has one, else its action; then any approval it waits on. */
function callEntries(
  callId: string,
  name: string,
  action: () => FeedEntry<FeedRef>,
  cards: CardsFor,
  runId: string | null,
): FeedEntry<FeedRef>[] {
  const card = cards.card(callId);
  const out: FeedEntry<FeedRef>[] = [];
  if (card && cards.taken.has(refKey(card))) return out;
  if (card) cards.taken.add(refKey(card));
  const question = !card && name === "ask_user" ? cards.question(callId, runId) : null;
  if (card) out.push({ type: "card", id: callId, ref: { t: "card", ref: card } });
  else if (question && !cards.taken.has(refKey(question))) {
    cards.taken.add(refKey(question));
    out.push({ type: "break", id: refKey(question), ref: { t: "card", ref: question } });
  } else if (!question) out.push(action());
  for (const approval of cards.approvals(callId)) {
    if (cards.taken.has(refKey(approval))) continue;
    cards.taken.add(refKey(approval));
    out.push({ type: "break", id: refKey(approval), ref: { t: "card", ref: approval } });
  }
  return out;
}

/**
 * Whether the engine's run already draws text block `i` of its history item: the text right before
 * a call the engine places text beside, known by that call's id, never by its words. No history
 * row names an item of the `assistant` stream, so every other text of the run is drawn from
 * history, even while the engine still streams it as the reply: drawn twice until the run ends,
 * rather than text the person already read disappearing.
 */
function shownByEngine(run: Run, blocks: TranscriptItem["blocks"], i: number): boolean {
  const next = blocks.slice(i + 1).find((block) => block.kind !== "reasoning");
  return (
    next?.kind === "tool-call" && (run.preambles ?? []).some((p) => p.beforeCall === next.callId)
  );
}

const gap = (id: string, count: number): FeedEntry<FeedRef> => ({
  type: "break",
  id,
  ref: { t: "gap", count },
});

/**
 * Every call a run's transcript draws, in order, from the engine's record and
 * history's rows alike, with the entry that draws it and the list it is in:
 * what the run line and the gap lines are counted from (`retentionAccount`).
 */
type Drawn = {
  ids: string[];
  at: Map<string, { entry: FeedEntry<FeedRef>; list: FeedEntry<FeedRef>[] }>;
};

class Tally {
  private readonly runs = new Map<string, Drawn>();
  add(
    runId: string | null | undefined,
    callId: string,
    list: FeedEntry<FeedRef>[],
    entry: FeedEntry<FeedRef>,
  ) {
    if (!runId) return;
    const run: Drawn = this.runs.get(runId) ?? { ids: [], at: new Map() };
    this.runs.set(runId, run);
    if (run.at.has(callId)) return;
    run.ids.push(callId);
    run.at.set(callId, { entry, list });
  }
  /** The entry that draws a call of a run. */
  entryOf(runId: string, callId: string): FeedEntry<FeedRef> | undefined {
    return this.runs.get(runId)?.at.get(callId)?.entry;
  }
  ids(runId: string): string[] {
    return this.runs.get(runId)?.ids ?? [];
  }
  /** Lines where actions are missing: before the call they preceded, and after the last drawn. */
  placeGaps(run: Run, account: RetentionAccount) {
    const drawn = this.runs.get(run.id);
    if (!drawn) return;
    for (const [callId, count] of account.before) {
      const at = drawn.at.get(callId);
      if (!at) continue;
      at.list.splice(at.list.indexOf(at.entry), 0, gap(`gap:${callId}`, count));
    }
    if (account.atEnd > 0) {
      const last = drawn.at.get(drawn.ids.at(-1)!);
      if (last)
        last.list.splice(
          last.list.indexOf(last.entry) + 1,
          0,
          gap(`gap:${run.id}:end`, account.atEnd),
        );
    }
  }
}

/** The last bubble of the message with this id, or -1. */
const bubbleOf = (entries: FeedEntry<FeedRef>[], messageId: string | undefined) =>
  messageId
    ? entries.findLastIndex(
        (entry) =>
          entry.type === "bubble" && entry.ref.t === "text" && entry.ref.messageId === messageId,
      )
    : -1;

/**
 * Each picture of an item goes under the last bubble of the message that carried
 * it, so a picture a bot sent with its message tool shows with that message, not
 * after what the bot did next (F-535). Returns the pictures placed; the rest stay
 * under the turn.
 */
export function placePictures(
  item: TranscriptItem,
  entries: FeedEntry<FeedRef>[],
): ReadonlySet<string> {
  const placed = new Set<string>();
  for (const picture of item.pictures ?? []) {
    const at = bubbleOf(entries, picture.messageId);
    const entry = entries[at];
    if (entry?.type !== "bubble" || entry.ref.t !== "text") continue;
    entries[at] = {
      ...entry,
      ref: { ...entry.ref, pictures: [...(entry.ref.pictures ?? []), picture] },
    };
    placed.add(picture.artifactId);
  }
  return placed;
}

/** The same for the item's other files (F-115), after its pictures. Returns the files placed. */
export function placeFiles(
  item: TranscriptItem,
  entries: FeedEntry<FeedRef>[],
): ReadonlySet<ChatFile> {
  const placed = new Set<ChatFile>();
  for (const file of item.files ?? []) {
    const at = bubbleOf(entries, file.messageId);
    const entry = entries[at];
    if (entry?.type !== "bubble" || entry.ref.t !== "text") continue;
    entries[at] = { ...entry, ref: { ...entry.ref, files: [...(entry.ref.files ?? []), file] } };
    placed.add(file);
  }
  return placed;
}

/** An assistant history item's record. */
function itemEntries(
  item: TranscriptItem,
  run: Run | undefined,
  index: Map<string, { step: Step; run: Run }>,
  skip: ReadonlySet<string>,
  cards: CardsFor,
  tally: Tally,
  fromEngine = false,
  record: EngineRecord | null = null,
): FeedEntry<FeedRef>[] {
  const reasoningSteps = run ? run.steps.filter((s) => s.kind === "reasoning") : [];
  const reasoningBlocks = item.blocks.filter((b) => b.kind === "reasoning").length;
  // The engine's derived reasoning ids, when its run holds the same blocks.
  const engineIds = reasoningSteps.length === reasoningBlocks;
  const entries: FeedEntry<FeedRef>[] = [];
  let r = 0;
  // A bubble is keyed by its text, not its place, so a block history adds before it keeps it.
  const seen = new Map<string, number>();
  item.blocks.forEach((block, i) => {
    if (block.kind === "text") {
      // The engine already shows this text for its run, before the call it came with.
      if (fromEngine && run && shownByEngine(run, item.blocks, i)) return;
      const head = block.text.slice(0, 64);
      const n = (seen.get(head) ?? 0) + 1;
      seen.set(head, n);
      if (block.text.trim())
        entries.push({
          type: "bubble",
          id: `${item.id}:t:${n}:${head}`,
          ref: {
            t: "text",
            text: block.text,
            title: item.timestamp === null ? undefined : fullDate(item.timestamp),
            messageId: block.messageId,
          },
        });
    } else if (block.kind === "reasoning") {
      if (fromEngine) return;
      const step = engineIds ? reasoningSteps[r] : undefined;
      r += 1;
      entries.push({
        type: "reasoning",
        segment: step
          ? { ...segmentFromStep(step), text: block.text }
          : { id: `${item.id}:r${i}`, text: block.text, startedAt: null, endedAt: null },
      });
    } else if (!skip.has(block.callId)) {
      const found = index.get(block.callId);
      // Calls the engine holds that history's rows here no longer do come first, in the run's order.
      if (record && found) record.before(found.step, entries);
      record?.drawn.add(block.callId);
      const drawn = callEntries(
        block.callId,
        block.name,
        () => ({ type: "action", call: callFromBlock(block, found?.step, found?.run) }),
        cards,
        run?.id ?? found?.run.id ?? null,
      );
      if (drawn[0]) tally.add(run?.id ?? found?.run.id, block.callId, entries, drawn[0]);
      entries.push(...drawn);
    }
  });
  if (record?.last) record.rest(entries);
  return entries;
}

/**
 * A run's record in the engine, for the history items that draw it: the
 * calls their rows no longer hold (an item keeps at most
 * `MAX_BLOCKS_PER_ITEM` blocks) are drawn from the engine's steps in the
 * run's order, so nothing it kept is dropped silently, and where it kept
 * nothing a line says how many actions are not kept.
 */
type EngineRecord = {
  drawn: Set<string>;
  /** Draw the run's calls not in any row, before this step, not drawn yet. */
  before: (step: Step, entries: FeedEntry<FeedRef>[]) => void;
  /** Draw every call not drawn yet: after the run's last item. */
  rest: (entries: FeedEntry<FeedRef>[]) => void;
  /** This item is the run's last. */
  last: boolean;
};

function engineRecord(
  run: Run,
  inRows: ReadonlySet<string>,
  drawn: Set<string>,
  last: boolean,
  tally: Tally,
): EngineRecord {
  const tools = run.steps.filter((step) => step.kind === "tool" && step.toolCallId);
  const draw = (steps: Step[], entries: FeedEntry<FeedRef>[]) => {
    for (const step of steps) {
      drawn.add(step.toolCallId!);
      const entry: FeedEntry<FeedRef> = { type: "action", call: callFromStep(step, run) };
      tally.add(run.id, step.toolCallId!, entries, entry);
      entries.push(entry);
    }
  };
  const missing = (step: Step) => !inRows.has(step.toolCallId!) && !drawn.has(step.toolCallId!);
  return {
    drawn,
    last,
    before: (step, entries) => draw(tools.slice(0, tools.indexOf(step)).filter(missing), entries),
    rest: (entries) => draw(tools.filter(missing), entries),
  };
}

/** A run the engine holds: its steps, its text beside calls, its unplaced cards, its reply. */
function runEntries(
  run: Run,
  cards: CardsFor,
  rest: CardRef[],
  tally: Tally,
  afterText: ReadonlySet<string>,
): FeedEntry<FeedRef>[] {
  const entries: FeedEntry<FeedRef>[] = [];
  const preambles = [...(run.preambles ?? [])];
  const preamble = (p: Preamble) =>
    entries.push({ type: "bubble", id: `preamble:${p.id}`, ref: { t: "preamble", preamble: p } });
  for (const step of run.steps) {
    if (step.kind === "reasoning") {
      entries.push({ type: "reasoning", segment: segmentFromStep(step) });
      continue;
    }
    // Text written before this call, by its call id: dropping older steps never moves it.
    for (const p of preambles.filter((each) => each.beforeCall === step.toolCallId)) preamble(p);
    if (!step.toolCallId) continue;
    const drawn = callEntries(
      step.toolCallId,
      step.toolName ?? "",
      () => ({ type: "action", call: callFromStep(step, run) }),
      cards,
      run.id,
    );
    if (drawn[0]) tally.add(run.id, step.toolCallId, entries, drawn[0]);
    entries.push(...drawn);
  }
  const calls = new Set(run.steps.map((step) => step.toolCallId));
  preambles.filter((p) => p.beforeCall === null || !calls.has(p.beforeCall)).forEach(preamble);
  // A card that names no call of the run takes its place by when it arrived, among the calls.
  for (const ref of [...rest, ...cards.questions(run.id)]) {
    if (cards.taken.has(refKey(ref))) continue;
    cards.taken.add(refKey(ref));
    const at = cards.arrivedAt(ref);
    const entry: FeedEntry<FeedRef> = { type: "break", id: refKey(ref), ref: { t: "card", ref } };
    const before =
      at === null
        ? -1
        : entries.findIndex(
            (e) => e.type === "action" && e.call.startedAt !== null && e.call.startedAt > at,
          );
    if (before === -1) entries.push(entry);
    else entries.splice(before, 0, entry);
  }
  // The run's text is an item a call placed as the text beside it: that bubble, not a reply, and
  // not drawn twice. Known by the item's id, never its words. An earlier message's text is drawn
  // from its own row once history holds that row and, after it, the row of a call a later message
  // made: a page that holds only the call's row leaves it the reply.
  const inHistory = run.textBeforeCall !== undefined && afterText.has(run.textBeforeCall);
  if (run.text.trim() && !textPlaced(run) && !inHistory)
    entries.push({ type: "bubble", id: `reply:${run.id}`, ref: { t: "reply", run } });
  return entries;
}

/** A message's text, as compared with a reply's: trimmed at its ends, its line breaks and indents kept. */
const sameText = (text: string) => text.trim();

/**
 * A message on a channel whose text is a reply the run draws beside it is
 * marked, so its line leaves the text out (7.11): the reply says it once.
 */
export function markRepeats(lists: FeedEntry<FeedRef>[][], ctx: ReadingContext) {
  const said = new Set<string>();
  for (const entries of lists)
    for (const entry of entries) {
      if (entry.type !== "bubble") continue;
      const ref = entry.ref;
      const text =
        ref.t === "text"
          ? ref.text
          : ref.t === "preamble"
            ? ref.preamble.text
            : ref.t === "reply"
              ? ref.run.text
              : "";
      if (text.trim()) said.add(sameText(text));
    }
  if (!said.size) return;
  for (const entries of lists)
    entries.forEach((entry, i) => {
      if (entry.type !== "action" || kindOf(entry.call, ctx).kind !== "channel") return;
      const message = entry.call.args.message;
      if (typeof message === "string" && message.trim() && said.has(sameText(message)))
        entries[i] = { ...entry, call: { ...entry.call, repeatsReply: true } };
    });
}

/**
 * Without commands shown (7.11): a record's action cards, and the lines of
 * actions not kept, leave the conversation for its run line's list. The
 * reasoning that led to them stays where it was, one "Thought" line for each
 * stretch between the bot's words, and leaves the cards so it is not drawn
 * twice. In a run still going, reasoning with nothing after it yet is the
 * status line's (section 5), not a line. An action that waits for the person
 * (`staysInView`) keeps its card in the conversation, a fold with such a
 * member keeps the whole fold, and neither is in the run line's list. An
 * action that went wrong takes the same path as any other.
 */
export function quietFeed(
  groups: Groups,
  live: boolean,
  ctx: ReadingContext = {},
): { shown: Groups; hidden: Groups } {
  const shown: Groups = [];
  const hidden: Groups = [];
  let pending: Thought[] = [];
  const flush = (place: "reply" | "end") => {
    if (!pending.length) return;
    const thought = mergeThoughts(pending);
    shown.push({ type: "thought", key: thought.id, thought, place });
    pending = [];
  };
  // An action that waits for the person stays in view as its card (7.11).
  const inView = (call: ActionCall) => staysInView(lineOf(call, ctx).outcome);
  for (const group of groups) {
    if (
      (group.type === "action" && inView(group.call)) ||
      (group.type === "fold" && group.members.some((m) => inView(m.call)))
    ) {
      flush("reply");
      shown.push(group);
    } else if (group.type === "action") {
      if (group.thought) pending.push(group.thought);
      hidden.push({ ...group, thought: null });
    } else if (group.type === "fold") {
      for (const member of group.members) if (member.thought) pending.push(member.thought);
      hidden.push({ ...group, members: group.members.map((m) => ({ ...m, thought: null })) });
    } else if (group.type === "break" && group.ref.t === "gap") hidden.push(group);
    else if (group.type === "thought") {
      if (!(live && group.place === "end")) pending.push(group.thought);
    } else {
      flush("reply");
      shown.push(group);
    }
  }
  flush("end");
  return { shown, hidden };
}

/**
 * What one record draws in the conversation (`shown`) and what goes to its run
 * line's list (`hidden`), by the two switches of 7.11. With both on, the
 * record's groups are drawn as they are, except that in a run still going the
 * reasoning with nothing after it yet is the status line's (section 5), not a
 * line, as without commands shown.
 */
export function viewGroups(
  groups: Groups,
  view: { commands: boolean; thinking: boolean; live: boolean },
  ctx: ReadingContext = {},
): { shown: Groups; hidden: Groups } {
  const thought = view.thinking ? groups : withoutThinking(groups);
  if (view.commands)
    return {
      shown: view.live
        ? thought.filter((g) => !(g.type === "thought" && g.place === "end"))
        : thought,
      hidden: [],
    };
  return quietFeed(thought, view.live, ctx);
}

/**
 * Without "Show thinking" (7.11): no "Thought" line, and no reasoning inside a
 * card, a fold or a line of actions.
 */
function withoutThinking(groups: Groups): Groups {
  return groups.flatMap((group): Groups => {
    switch (group.type) {
      case "thought":
        return [];
      case "action":
      case "card":
        return [{ ...group, thought: null }];
      case "fold":
        return [{ ...group, members: group.members.map((m) => ({ ...m, thought: null })) }];
      case "break":
        return group.ref.t === "actions"
          ? [{ ...group, ref: { t: "actions", groups: withoutThinking(group.ref.groups) } }]
          : [group];
      default:
        return [group];
    }
  });
}

/**
 * Builds the feed of every run the transcript draws, once per change, and
 * gives the cards what they share. `engineRuns` are the runs drawn from the
 * engine (the active run, and a finished one history does not hold yet);
 * everything else is drawn from history.
 */
export function ActionScope({
  taskKey,
  transcript,
  engineRuns,
  lost,
  readOnly,
  effort = null,
  ctx: given,
  children,
}: {
  taskKey: string;
  transcript: Transcript;
  engineRuns: Run[];
  lost: boolean;
  readOnly: boolean;
  /** The reasoning effort the task asks for, for the run line's record. */
  effort?: string | null;
  ctx: ReadingContext;
  children: ReactNode;
}) {
  // The gateway's name map, tool inventory and workspace root: what the reading may know at a start.
  const { mcpTools, builtinTools, workspaceRoot } = transcript;
  // Commands and raw calls only when the person chose to see them (7.11).
  const [commandsShown] = useShowCommands();
  const quiet = !commandsShown;
  // Reasoning only when the person chose to see it (7.11).
  const [thinkingShown] = useShowThinking();
  const ctx = useMemo(
    () => ({
      ...given,
      ...readingContextOf({ mcpTools, builtinTools, workspaceRoot }),
      ...(quiet ? { quiet: true } : {}),
    }),
    [given, mcpTools, builtinTools, workspaceRoot, quiet],
  );
  const scope = useScopeCards();
  const handover = useStepHandover();
  const { selected, rawState } = scope.cards;
  const { placement, startedTasks } = scope;

  const feeds = useMemo(() => {
    const index = stepIndex(transcript.runs);
    const t3 = codingCalls(selected);
    const taken = new Set<string>();
    const cards: CardsFor = {
      taken,
      arrivedAt: (ref) =>
        ref.kind === "approval"
          ? (transcript.approvals.find((card) => card.id === ref.id)?.createdAt ?? null)
          : ref.kind === "question"
            ? (transcript.questions.find((card) => card.id === ref.id)?.createdAt ?? null)
            : null,
      card: (callId) => {
        const message = selected.botMessages.find((card) => card.toolCallId === callId);
        if (message) return { kind: "bot-message", id: message.id };
        const started = startedTasks.find((card) => card.toolCallId === callId);
        if (started) return { kind: "started-task", id: started.id };
        // A T3 Code call is its card once the card is drawn, and nothing else.
        const coding = t3.find((card) => card.toolCallId === callId);
        if (coding && handover?.isCard(callId)) return { kind: "t3-code", id: coding.id };
        return null;
      },
      approvals: (callId) =>
        transcript.approvals
          .filter((card) => card.toolCallId === callId)
          .map((card) => ({ kind: "approval" as const, id: card.id })),
      question: (callId, runId) => {
        const card = transcript.questions.find((q) =>
          [q.runId, runId, transcript.sessionKey].some(
            (identity) => identity && q.id === askUserQuestionId(identity, callId),
          ),
        );
        return card ? { kind: "question", id: card.id } : null;
      },
      questions: (runId) =>
        transcript.questions
          .filter((card) => card.runId === runId && !taken.has(`question:${card.id}`))
          .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
          .map((card) => ({ kind: "question" as const, id: card.id })),
    };
    const skip = new Set(
      engineRuns.flatMap((run) => run.steps.flatMap((s) => (s.toolCallId ? [s.toolCallId] : []))),
    );
    const engineRunIds = new Set(engineRuns.map((run) => run.id));
    // Each assistant item's run, and each run's last item, in one pass.
    const runOf = new Map<string, Run | undefined>();
    const lastItem = new Map<string, string>();
    let previousUser: string | null = null;
    for (const item of transcript.items) {
      if (item.role === "user") previousUser = item.id;
      if (item.role !== "assistant") continue;
      const run = runOfItem(item, previousUser, index, transcript.runs);
      runOf.set(item.id, run);
      if (run) lastItem.set(run.id, item.id);
    }
    const inRows = new Set(
      transcript.items.flatMap((item) =>
        item.blocks.flatMap((block) => (block.kind === "tool-call" ? [block.callId] : [])),
      ),
    );
    // The calls whose rows come after a row of the bot's text since their run's message, both in
    // the page held: history writes an earlier message's text before a later message's call.
    const afterText = new Set<string>();
    for (const run of transcript.runs) {
      const call = run.textBeforeCall;
      if (call === undefined) continue;
      const at = transcript.items.findIndex((item) =>
        item.blocks.some((block) => block.kind === "tool-call" && block.callId === call),
      );
      const from = transcript.items.findIndex((item) => item.id === run.anchorItemId);
      const text = transcript.items
        .slice(from + 1, at)
        .some(
          (item) =>
            item.role === "assistant" &&
            item.blocks.some((block) => block.kind === "text" && block.text.trim()),
        );
      if (at >= 0 && text) afterText.add(call);
    }
    const drawnOf = new Map<string, Set<string>>();
    const tally = new Tally();
    const built: Array<{
      id: string;
      entries: FeedEntry<FeedRef>[];
      revision: number;
      placed: Placed;
    }> = [];
    for (const item of transcript.items) {
      if (item.role !== "assistant") continue;
      const run = runOf.get(item.id);
      // A run drawn from the engine draws its calls and reasoning there: the rows history already
      // holds of it keep only their text, so no call is drawn twice and nothing only history has is
      // lost. A text the engine still streams as its reply is drawn here too (`shownByEngine`).
      const fromEngine = run !== undefined && engineRunIds.has(run.id);
      const drawn = run ? (drawnOf.get(run.id) ?? new Set<string>()) : null;
      if (run && drawn) drawnOf.set(run.id, drawn);
      const record =
        run && drawn && !fromEngine
          ? engineRecord(run, inRows, drawn, lastItem.get(run.id) === item.id, tally)
          : null;
      const entries = itemEntries(item, run, index, skip, cards, tally, fromEngine, record);
      const placed = { pictures: placePictures(item, entries), files: placeFiles(item, entries) };
      built.push({ id: item.id, entries, revision: run?.reasoningRevision ?? 0, placed });
    }
    const builtRuns: Array<{ id: string; entries: FeedEntry<FeedRef>[]; revision: number }> = [];
    for (const run of engineRuns) {
      const rest = placement.byRun.get(run.id) ?? [];
      builtRuns.push({
        id: run.id,
        entries: runEntries(run, cards, rest, tally, afterText),
        revision: run.reasoningRevision,
      });
    }
    // One account per run, of what is drawn against what the gateway reported: its gap lines
    // and its run line's counts, after the live record and history are combined.
    const accounts = new Map<string, { account: RetentionAccount; calls: ActionCall[] }>();
    for (const run of transcript.runs) {
      const ids = tally.ids(run.id);
      const account = retentionAccount(run, ids);
      tally.placeGaps(run, account);
      // Every drawn call as its card reads it: an action from history or from the engine, and a
      // call drawn as a card from the engine's step.
      const drawnCalls = ids.flatMap((id) => {
        const entry = tally.entryOf(run.id, id);
        if (entry?.type === "action") return [entry.call];
        const found = index.get(id);
        return found ? [callFromStep(found.step, found.run)] : [];
      });
      accounts.set(run.id, { account, calls: drawnCalls });
    }
    // A message that repeats a reply of its run beside it leaves its text out (7.11).
    const listsOf = new Map<string, FeedEntry<FeedRef>[][]>();
    const listOf = (runId: string | undefined, entries: FeedEntry<FeedRef>[]) => {
      if (runId) listsOf.set(runId, [...(listsOf.get(runId) ?? []), entries]);
      else markRepeats([entries], ctx);
    };
    for (const each of built) listOf(runOf.get(each.id)?.id, each.entries);
    for (const each of builtRuns) listOf(each.id, each.entries);
    for (const lists of listsOf.values()) markRepeats(lists, ctx);
    const items = new Map<string, { groups: Groups; revision: number; placed: Placed }>();
    const runs = new Map<string, { groups: Groups; revision: number }>();
    const hidden = new Map<string, { groups: Groups; revision: number }>();
    // Without commands shown, each run's cards go to its run line, in order (7.11).
    const keep = (runId: string | undefined, groups: Groups, revision: number): Groups => {
      const live =
        runId !== undefined && engineRuns.some((r) => r.id === runId && !isTerminal(r.state));
      const { shown, hidden: cards } = viewGroups(
        groups,
        { commands: !quiet, thinking: thinkingShown, live },
        ctx,
      );
      if (!cards.length) return shown;
      if (!runId) {
        // History with no run has no run line: its cards stay behind a line of their own.
        const first = cards[0]!;
        shown.push({
          type: "break",
          key: `actions:${first.key}`,
          ref: { t: "actions", groups: cards },
        });
        return shown;
      }
      const held = hidden.get(runId);
      hidden.set(runId, { groups: [...(held?.groups ?? []), ...cards], revision });
      return shown;
    };
    for (const each of built)
      items.set(each.id, {
        groups: keep(runOf.get(each.id)?.id, groupFeed(each.entries, ctx), each.revision),
        revision: each.revision,
        placed: each.placed,
      });
    for (const each of builtRuns)
      runs.set(each.id, {
        groups: keep(each.id, groupFeed(each.entries, ctx), each.revision),
        revision: each.revision,
      });
    return { items, runs, accounts, hidden } satisfies Feeds;
  }, [
    transcript,
    engineRuns,
    selected,
    startedTasks,
    handover,
    placement,
    ctx,
    quiet,
    thinkingShown,
  ]);

  const placed = useMemo(() => {
    const keys = new Set<string>();
    for (const { groups } of [...feeds.items.values(), ...feeds.runs.values()])
      for (const group of groups)
        if ((group.type === "card" || group.type === "break") && group.ref.t === "card")
          keys.add(refKey(group.ref.ref));
    return keys;
  }, [feeds]);

  const env: ActionEnv = useMemo(() => {
    const index = stepIndex(transcript.runs);
    return {
      taskKey,
      sessionKey: transcript.sessionKey,
      ctx,
      stepOf: (callId) => {
        const found = index.get(callId);
        return found ? { step: found.step, runId: found.run.id } : undefined;
      },
      rawState,
      lost,
      readOnly,
      effort,
      arriving: () => drawn.current,
    };
  }, [taskKey, transcript.runs, transcript.sessionKey, ctx, rawState, lost, readOnly, effort]);

  useKeepFocus(env.stepOf);
  // Cards drawn with the feed's first drawing are not arrivals; later ones are.
  const drawn = useRef(false);
  useEffect(() => {
    drawn.current = true;
  }, []);

  return (
    <ActionEnvContext.Provider value={env}>
      <PlacedCardsContext.Provider value={placed}>
        <FeedsContext.Provider value={feeds}>{children}</FeedsContext.Provider>
      </PlacedCardsContext.Provider>
    </ActionEnvContext.Provider>
  );
}

/**
 * When the control that held focus is replaced (a card becoming a fold, a
 * fold splitting), focus moves to the same control in what replaced it, or
 * to the replacement's line (section 2, Input). Controls are found by their
 * call and their own name, never by position. A card that left the
 * conversation for its run's list (7.11) gives focus to its run line, or,
 * while the run works and has none, to the transcript.
 */
function useKeepFocus(stepOf: ActionEnv["stepOf"]) {
  const last = useRef<{ element: HTMLElement; call: string; control: string } | null>(null);
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const element = event.target as HTMLElement;
      const holder = element.closest<HTMLElement>("[data-call]");
      if (!holder) return;
      const control =
        element.dataset.viewButton !== undefined
          ? `[data-view-button="${element.dataset.viewButton}"]`
          : element.tagName === "SUMMARY"
            ? ":scope > summary"
            : element.getAttribute("aria-label")
              ? `[aria-label="${CSS.escape(element.getAttribute("aria-label")!)}"]`
              : ":scope > summary";
      last.current = { element, call: holder.dataset.call!, control };
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  useLayoutEffect(() => {
    const held = last.current;
    if (!held || held.element.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const holder =
      document.querySelector<HTMLElement>(`[data-call="${CSS.escape(held.call)}"]`) ??
      document.querySelector<HTMLElement>(`[data-first="${CSS.escape(held.call)}"]`);
    const closedLine = holder?.closest<HTMLElement>("details.run-line:not([open])");
    if (!holder || closedLine) {
      const runId = stepOf(held.call)?.runId;
      const line =
        closedLine ??
        (runId
          ? document.querySelector<HTMLElement>(`details.run-line[data-run="${CSS.escape(runId)}"]`)
          : null);
      const fallback =
        line?.querySelector<HTMLElement>(":scope > summary") ??
        document.querySelector<HTMLElement>('[data-testid="transcript"]');
      fallback?.focus({ preventScroll: true });
      return;
    }
    const target =
      holder.querySelector<HTMLElement>(
        held.control === ":scope > summary" ? ":scope > summary" : held.control,
      ) ?? holder.querySelector<HTMLElement>(":scope > summary");
    target?.focus({ preventScroll: true });
  });
}

// Drawing ------------------------------------------------------------------------------

function Bubble({
  children,
  live = false,
  title,
}: {
  children: ReactNode;
  live?: boolean;
  title?: string | undefined;
}) {
  return (
    <div className="msg" data-role="assistant">
      <div
        className="bubble"
        title={title}
        data-streaming={live || undefined}
        aria-busy={live || undefined}
      >
        {children}
        {live && <span className="stream-caret" aria-hidden="true" />}
      </div>
    </div>
  );
}

function GroupView({
  group,
  revision,
  reply,
}: {
  group: FeedGroup<FeedRef>;
  revision: number;
  reply: (run: Run) => ReactNode;
}) {
  switch (group.type) {
    case "action":
      return (
        <ActionGroup members={[{ call: group.call, thought: group.thought }]} revision={revision} />
      );
    case "fold":
      return <ActionGroup members={group.members} revision={revision} />;
    case "thought":
      return <ThoughtLine thought={group.thought} place={group.place} revision={revision} />;
    case "card":
    case "break":
    case "bubble": {
      const ref = group.ref;
      // The reasoning that led to a Messaged card's call is drawn inside that card (7.5).
      const thought =
        group.type === "card" && group.thought ? (
          <ThoughtLine thought={group.thought} place="card" revision={revision} />
        ) : null;
      switch (ref.t) {
        case "card":
          return (
            <CardThoughtContext.Provider value={thought}>
              <CardFor cardRef={ref.ref} />
            </CardThoughtContext.Provider>
          );
        case "text":
          return (
            <MessageUnit
              message={
                ref.messageId
                  ? { messageId: ref.messageId, role: "assistant", text: ref.text }
                  : null
              }
            >
              <Bubble title={ref.title}>
                <Markdown text={ref.text} />
              </Bubble>
              {ref.pictures && <BubblePictures pictures={ref.pictures} />}
              {ref.files && <BubbleFiles files={ref.files} />}
            </MessageUnit>
          );
        case "preamble":
          return (
            <Bubble live={!ref.preamble.ended}>
              <Markdown text={ref.preamble.text} />
            </Bubble>
          );
        case "reply":
          return <>{reply(ref.run)}</>;
        case "gap":
          return (
            <p className="event-line action-gap" data-testid="actions-not-kept">
              {actionWords.RUN_LINE.notKept(ref.count)}
            </p>
          );
        case "actions":
          return (
            <ActionsLine id={group.key} calls={callsOf(ref.groups)}>
              <Groups groups={ref.groups} revision={revision} reply={reply} />
            </ActionsLine>
          );
      }
    }
  }
}

/** The groups of one record, in order. Keys are the gateway's ids: a fold keeps its first member's. */
function Groups({
  groups,
  revision,
  reply,
}: {
  groups: Groups;
  revision: number;
  reply: (run: Run) => ReactNode;
}) {
  return (
    <>
      {groups.map((group) => (
        <GroupView
          key={
            group.type === "action" || group.type === "fold"
              ? `a:${group.key}`
              : `${group.type}:${group.key}`
          }
          group={group}
          revision={revision}
          reply={reply}
        />
      ))}
    </>
  );
}

function BubblePictures({ pictures }: { pictures: ChatPicture[] }) {
  const env = useContext(ActionEnvContext);
  return env ? <Pictures taskKey={env.taskKey} pictures={pictures} /> : null;
}

function BubbleFiles({ files }: { files: ChatFile[] }) {
  const env = useContext(ActionEnvContext);
  return env ? <BotFiles taskKey={env.taskKey} files={files} /> : null;
}

/** The pictures and files of an item that no bubble of it draws: under the turn, in their order. */
export function TurnPictures({ taskKey, item }: { taskKey: string; item: TranscriptItem }) {
  const placed = useFeeds().items.get(item.id)?.placed;
  const rest = (item.pictures ?? []).filter((picture) => !placed?.pictures.has(picture.artifactId));
  const files = (item.files ?? []).filter((file) => !placed?.files.has(file));
  return (
    <>
      <Pictures taskKey={taskKey} pictures={rest} />
      <BotFiles taskKey={taskKey} files={files} />
    </>
  );
}

/** An assistant history item's bubbles, cards and Thought lines. */
export function ItemFeed({ itemId }: { itemId: string }) {
  const feeds = useFeeds();
  const feed = feeds.items.get(itemId);
  if (!feed) return null;
  return <Groups groups={feed.groups} revision={feed.revision} reply={() => null} />;
}

/** A run the engine holds, drawn in order: its cards, its text beside calls, its reply. */
export function RunFeed({ runId, reply }: { runId: string; reply: (run: Run) => ReactNode }) {
  const feeds = useFeeds();
  const feed = feeds.runs.get(runId);
  if (!feed) return null;
  return <Groups groups={feed.groups} revision={feed.revision} reply={reply} />;
}

/**
 * The run line of a finished run (7.7), counting every call of the run, card or not. The gateway's
 * skill notes that follow the run fold into it (F-560); with no line to fold into, they are a line
 * of their own.
 */
export function RunLine({
  run,
  notes = [],
  botName = "",
}: {
  run: Run;
  notes?: readonly SkillNoteItem[];
  botName?: string;
}) {
  const taskKey = useContext(ActionEnvContext)?.taskKey ?? "";
  // Counted from what the transcript draws of the run, against what the gateway reported.
  const drawn = useContext(FeedsContext)?.accounts.get(run.id);
  const calls = useMemo(
    () =>
      drawn?.calls ?? run.steps.filter((s) => s.kind === "tool").map((s) => callFromStep(s, run)),
    [run, drawn],
  );
  // Read as the cards read it, with what the gateway said of the task's tools.
  const ctx = useContext(ActionEnvContext)?.ctx;
  const line = isTerminal(run.state) ? runLineOf(run, calls, ctx, drawn?.account) : null;
  // Without commands shown, the run's cards are its line's list (7.11).
  const hidden = useContext(FeedsContext)?.hidden.get(run.id);
  const list = hidden?.groups.length ? (
    <Groups groups={hidden.groups} revision={hidden.revision} reply={() => null} />
  ) : null;
  const alone =
    notes.length > 0 ? <SkillNoteLine notes={notes} taskKey={taskKey} botName={botName} /> : null;
  if (!line)
    return list && isTerminal(run.state) ? (
      <>
        <ActionsLine id={`run:${run.id}`} calls={callsOf(hidden!.groups)}>
          {list}
        </ActionsLine>
        {alone}
      </>
    ) : (
      alone
    );
  return (
    <RunLineView
      runId={run.id}
      line={line}
      model={run.model}
      notes={
        notes.length > 0
          ? {
              words: skillNotesWords(notes),
              body: <SkillNoteBody notes={notes} taskKey={taskKey} botName={botName} />,
            }
          : null
      }
    >
      {list}
    </RunLineView>
  );
}

/** The calls of a run, for the status line's phrase. */
export function runCalls(run: Run) {
  return run.steps.filter((s) => s.kind === "tool").map((s) => callFromStep(s, run));
}

/**
 * Bring a call's card into view and move focus to its line without opening
 * it (7.8). A call in a closed fold brings the fold's line. Returns whether
 * a card was found.
 */
export function showAction(callId: string, root: ParentNode = document): boolean {
  // An action card or row, else the Messaged or T3 Code card the call is drawn as.
  const element =
    root.querySelector<HTMLElement>(`#${CSS.escape(actionDomId(callId))}`) ??
    root.querySelector<HTMLElement>(`.card.messaged[data-call="${CSS.escape(callId)}"]`);
  if (!element) return false;
  const fold = element.closest<HTMLDetailsElement>(".action[data-fold]");
  const line = fold && !fold.open ? fold : element;
  line.scrollIntoView({ block: "nearest" });
  line.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
  return true;
}
