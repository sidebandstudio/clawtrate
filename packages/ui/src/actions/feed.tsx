// Where the action cards go (docs/design/conversation.md, sections 1 and 7):
// each run's ordered record, from the history item that holds it or from the
// engine's live run, goes through the engine's one grouping (`groupFeed`), so
// a live run and a reload draw the same cards. The Messaged and T3 Code cards
// take their call's place in the column, an approval follows the call it
// names, and a question card takes its `ask_user` call's place.

import {
  actionWords,
  askUserQuestionId,
  callFromBlock,
  callFromStep,
  groupFeed,
  isTerminal,
  readingContextOf,
  retentionAccount,
  type ActionCall,
  type RetentionAccount,
  runLineOf,
  segmentFromStep,
  placeT3,
  t3CallOf,
  type T3Call,
  type T3Sequence,
  type FeedEntry,
  type FeedGroup,
  type Preamble,
  type ReadingContext,
  type Run,
  type Step,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CardFor,
  CardThoughtContext,
  PlacedCardsContext,
  refKey,
  useScopeCards,
  type CardRef,
} from "../cards/index.ts";
import { fullDate } from "../format.ts";
import { Markdown } from "../Markdown.tsx";
import {
  ActionEnvContext,
  ActionGroup,
  RunLineView,
  ThoughtLine,
  actionDomId,
  type ActionEnv,
} from "./ActionCards.tsx";
import { T3FeedContext, T3ThreadCard, type T3Feed, type T3ThreadInfo } from "./T3Thread.tsx";
import { markTranscriptNavigation } from "../reading-line.ts";

/** What a non-action entry of a record is. */
export type FeedRef =
  | { t: "text"; text: string; title?: string | undefined }
  | { t: "preamble"; preamble: Preamble }
  | { t: "reply"; run: Run }
  | { t: "card"; ref: CardRef }
  /** A T3 Code thread's card, at its first call in the record (section 11). */
  | { t: "t3"; head: string; call: ActionCall }
  /** A call that joined its thread's card directly: drawn there, not here (11.4). */
  | { t: "t3-joined"; head: string; call: ActionCall }
  /** Actions the run reported that are not kept here, at their place. */
  | { t: "gap"; count: number };

type Groups = FeedGroup<FeedRef>[];

type Feeds = {
  /** The groups of each assistant history item, by item id. */
  items: Map<string, { groups: Groups; revision: number }>;
  /** The groups of each run drawn from the engine, by run id. */
  runs: Map<string, { groups: Groups; revision: number }>;
  /** Each run's account of what is drawn (`retentionAccount`), and its drawn calls the engine holds. */
  accounts: Map<string, { account: RetentionAccount; calls: ActionCall[] }>;
  /** The task's T3 Code threads and where each of their calls went. */
  t3: T3Feed;
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

/** Whether the engine's run already draws this text, as text beside a call or as its reply. */
function shownByEngine(run: Run, text: string): boolean {
  const t = text.trim();
  return (
    (run.text.trim() !== "" && run.text.trim().startsWith(t)) ||
    (run.preambles ?? []).some((p) => p.text.trim() === t)
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
  /** The entry that draws a call, replaced by another: a T3 Code call drawn as its thread's card. */
  retarget(from: FeedEntry<FeedRef>, to: FeedEntry<FeedRef>) {
    for (const run of this.runs.values())
      for (const at of run.at.values()) if (at.entry === from) at.entry = to;
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
      // The engine already shows this text for its run: a preamble, or the streaming reply.
      if (fromEngine && run && shownByEngine(run, block.text)) return;
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
  // While a message with a tool call streams, the gateway's chat stream carries the same text
  // the preamble item does: it is that bubble, not a reply, and is not drawn twice.
  const text = run.text.trim();
  const repeats = (run.preambles ?? []).some((p) => p.text.trim().startsWith(text));
  if (text && !repeats)
    entries.push({ type: "bubble", id: `reply:${run.id}`, ref: { t: "reply", run } });
  return entries;
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
  const ctx = useMemo(
    () => ({ ...given, ...readingContextOf({ mcpTools, builtinTools, workspaceRoot }) }),
    [given, mcpTools, builtinTools, workspaceRoot],
  );
  const scope = useScopeCards();
  const { selected, rawState } = scope.cards;
  // Which T3 Code calls that were seen running keep their line when their result comes (11.4).
  const [joins] = useState(() => new LiveJoins());
  const { placement } = scope;

  const feeds = useMemo(() => {
    const index = stepIndex(transcript.runs);
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
    const drawnOf = new Map<string, Set<string>>();
    const tally = new Tally();
    const built: Array<{ id: string; entries: FeedEntry<FeedRef>[]; revision: number }> = [];
    for (const item of transcript.items) {
      if (item.role !== "assistant") continue;
      const run = runOf.get(item.id);
      // A run drawn from the engine draws its calls and reasoning there: the rows history already
      // holds of it keep only their text, so nothing is drawn twice and nothing only history has is lost.
      const fromEngine = run !== undefined && engineRunIds.has(run.id);
      const drawn = run ? (drawnOf.get(run.id) ?? new Set<string>()) : null;
      if (run && drawn) drawnOf.set(run.id, drawn);
      const record =
        run && drawn && !fromEngine
          ? engineRecord(run, inRows, drawn, lastItem.get(run.id) === item.id, tally)
          : null;
      const entries = itemEntries(item, run, index, skip, cards, tally, fromEngine, record);
      built.push({ id: item.id, entries, revision: run?.reasoningRevision ?? 0 });
    }
    const builtRuns: Array<{ id: string; entries: FeedEntry<FeedRef>[]; revision: number }> = [];
    for (const run of engineRuns) {
      const rest = placement.byRun.get(run.id) ?? [];
      builtRuns.push({
        id: run.id,
        entries: runEntries(run, cards, rest, tally),
        revision: run.reasoningRevision,
      });
    }
    // T3 Code's calls, across the task's whole record: each thread's card at its first call, the
    // calls that join it directly, and lines of their own (section 11).
    const t3 = t3Pass(
      [...built.map((each) => each.entries), ...builtRuns.map((each) => each.entries)],
      ctx,
      joins,
      tally,
    );
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
        if (entry?.type === "card" && (entry.ref.t === "t3" || entry.ref.t === "t3-joined"))
          return [entry.ref.call];
        const found = index.get(id);
        return found ? [callFromStep(found.step, found.run)] : [];
      });
      accounts.set(run.id, { account, calls: drawnCalls });
    }
    const items = new Map<string, { groups: Groups; revision: number }>();
    for (const each of built)
      items.set(each.id, { groups: groupFeed(each.entries, ctx), revision: each.revision });
    const runs = new Map<string, { groups: Groups; revision: number }>();
    for (const each of builtRuns)
      runs.set(each.id, { groups: groupFeed(each.entries, ctx), revision: each.revision });
    // The reasoning that led to a call that joined a card is drawn in its item there (7.5).
    for (const { groups } of [...items.values(), ...runs.values()])
      for (const group of groups)
        if (group.type === "card" && group.ref.t === "t3-joined" && group.thought)
          t3.thoughts.set(group.ref.call.id, group.thought);
    return { items, runs, accounts, t3 } satisfies Feeds;
  }, [transcript, engineRuns, selected, placement, ctx, joins]);

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

  useKeepFocus();
  // Cards drawn with the feed's first drawing are not arrivals; later ones are.
  const drawn = useRef(false);
  useEffect(() => {
    drawn.current = true;
  }, []);

  return (
    <ActionEnvContext.Provider value={env}>
      <PlacedCardsContext.Provider value={placed}>
        <FeedsContext.Provider value={feeds}>
          <T3FeedContext.Provider value={feeds.t3}>
            <ClosedContext.Provider value={joins.closed}>{children}</ClosedContext.Provider>
          </T3FeedContext.Provider>
        </FeedsContext.Provider>
      </PlacedCardsContext.Provider>
    </ActionEnvContext.Provider>
  );
}

/**
 * When the control that held focus is replaced (a card becoming a fold, a
 * fold splitting, a call becoming its T3 Code thread's card or the other way),
 * focus moves to the same control in what replaced it, or to the
 * replacement's line (section 2, Input; 11.4). Controls are found by their
 * call and their own name, never by position: a thread card's item is its
 * call's holder, as that call's own card is.
 */
function useKeepFocus() {
  const last = useRef<{ element: HTMLElement; call: string; control: string } | null>(null);
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const element = event.target as HTMLElement;
      const holder = element.closest<HTMLElement>("[data-item-call], [data-call]");
      if (!holder) return;
      const call = holder.dataset.itemCall ?? holder.dataset.call!;
      const control =
        element.dataset.viewButton !== undefined
          ? `[data-view-button="${element.dataset.viewButton}"]`
          : element.tagName === "SUMMARY"
            ? ":scope > summary"
            : element.getAttribute("aria-label")
              ? `[aria-label="${CSS.escape(element.getAttribute("aria-label")!)}"]`
              : ":scope > summary";
      last.current = { element, call, control };
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  useLayoutEffect(() => {
    const held = last.current;
    if (!held || held.element.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const id = CSS.escape(held.call);
    // The line's heading is the card's; a control inside is its item's when the call is an item.
    // Of the places that draw the call (its own line or card, its item on a thread's card), focus
    // goes to the one where the control can be seen: a call with a line of its own is also an
    // item, perhaps inside a folded thread card, and its line is where the reader was.
    const summary = held.control === ":scope > summary";
    const card = document.querySelector<HTMLElement>(`[data-call="${id}"]`);
    const item = document.querySelector<HTMLElement>(`[data-item-call="${id}"]`);
    const first = document.querySelector<HTMLElement>(`[data-first="${id}"]`);
    const holders = (summary ? [card, item, first] : [item, card, first]).filter(
      (each): each is HTMLElement => each !== null,
    );
    const controlIn = (holder: HTMLElement) =>
      holder.querySelector<HTMLElement>(held.control) ??
      holder.querySelector<HTMLElement>(":scope > summary");
    const shown = holders.map(controlIn).find((each) => each?.checkVisibility());
    if (shown) {
      shown.focus({ preventScroll: true });
      return;
    }
    // Only an item inside a folded thread card holds it now: open what encloses it, then focus.
    const target = holders.map(controlIn).find(Boolean) ?? null;
    if (!target) return;
    for (let at = target.parentElement; at; at = at.parentElement)
      if (at instanceof HTMLDetailsElement && !at.open) at.open = true;
    requestAnimationFrame(() => target.focus({ preventScroll: true }));
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
        case "t3":
          return <T3ThreadCard headId={ref.head} thought={thought} />;
        case "t3-joined":
          return <ClosingLine callId={ref.call.id} />;
        case "text":
          return (
            <Bubble title={ref.title}>
              <Markdown text={ref.text} />
            </Bubble>
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

/** The run line of a finished run (7.7), counting every call of the run, card or not. */
export function RunLine({ run }: { run: Run }) {
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
  if (!line) return null;
  return <RunLineView runId={run.id} line={line} model={run.model} />;
}

/** The calls of a run, for the status line's phrase. */
export function runCalls(run: Run) {
  return run.steps.filter((s) => s.kind === "tool").map((s) => callFromStep(s, run));
}

// T3 Code's calls across the record -----------------------------------------------------

/** The most held-line decisions a task's view keeps; the oldest give way. */
const MAX_JOIN_DECISIONS = 128;

/**
 * How the reader held each T3 Code call's line when its result came (11.4): a
 * call seen running whose line was open, held focus, or was not at the end the
 * reader follows keeps its line; one that was not closes up into its thread's
 * card. A call never seen running (read from history) follows the record alone.
 */
class LiveJoins {
  private readonly decided = new Map<string, "join" | "line">();
  private readonly running = new Set<string>();
  /** When each call closed up, and the height its line had, for the 200 ms close. */
  readonly closed = new Map<string, { at: number; height: number }>();
  kept = (callId: string) => this.decided.get(callId) === "line";
  /** A call is running now: when its result comes, how its line is held decides. */
  saw(callId: string) {
    if (this.running.size >= MAX_JOIN_DECISIONS)
      this.running.delete(this.running.values().next().value!);
    this.running.add(callId);
  }
  /** Decide, once, for a call about to join; true when it keeps its line. */
  decide(callId: string): boolean {
    if (this.decided.has(callId) || !this.running.has(callId)) return false;
    const line = document.getElementById(actionDomId(callId));
    const scroller = line?.closest<HTMLElement>('[data-testid="transcript"]');
    const following =
      !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
    const held =
      line instanceof HTMLDetailsElement &&
      (line.open || line.contains(document.activeElement) || !following);
    this.decided.set(callId, held ? "line" : "join");
    while (this.decided.size > MAX_JOIN_DECISIONS)
      this.decided.delete(this.decided.keys().next().value!);
    if (!held && line) {
      this.closed.set(callId, { at: Date.now(), height: line.offsetHeight });
      while (this.closed.size > MAX_JOIN_DECISIONS)
        this.closed.delete(this.closed.keys().next().value!);
    }
    return held;
  }
}

/**
 * Place every T3 Code call of the task's records (section 11): the record's
 * lists in order, each one a boundary. A thread's card replaces its first
 * call's entry, and a call that joins it directly is drawn there, not here.
 */
function t3Pass(
  lists: FeedEntry<FeedRef>[][],
  ctx: ReadingContext,
  joins: LiveJoins,
  tally: Tally,
): T3Feed {
  const sequence: T3Sequence = [];
  const found: Array<{ list: FeedEntry<FeedRef>[]; entry: FeedEntry<FeedRef>; call: T3Call }> = [];
  for (const list of lists) {
    for (const entry of list) {
      if (entry.type === "reasoning") continue;
      if (entry.type === "action") {
        const open = entry.call.status === "running" || entry.call.status === "waiting";
        if (open && entry.call.name.includes("__")) joins.saw(entry.call.id);
        const call = t3CallOf(entry.call, ctx);
        if (call) {
          sequence.push({ type: "t3", call });
          found.push({ list, entry, call });
          continue;
        }
      }
      sequence.push({ type: "other" });
    }
    sequence.push({ type: "boundary" });
  }
  let placements = placeT3(sequence, joins.kept);
  let changed = false;
  for (const { call } of found)
    if (placements.get(call.id)?.type === "joined" && joins.decide(call.id)) changed = true;
  if (changed) placements = placeT3(sequence, joins.kept);
  const threads = new Map<string, T3ThreadInfo>();
  const byKey = new Map<string, T3ThreadInfo>();
  for (const { call } of found) {
    const at = placements.get(call.id)!;
    if (at.type === "card") {
      const info: T3ThreadInfo = { key: at.thread?.key ?? null, head: call, calls: [call] };
      threads.set(call.id, info);
      if (at.thread) byKey.set(at.thread.key, info);
    } else if (at.type === "joined" || at.type === "line")
      byKey.get(at.thread.key)?.calls.push(call);
  }
  for (const { list, entry, call } of found) {
    const at = placements.get(call.id)!;
    if (at.type !== "card" && at.type !== "joined") continue;
    const next: FeedEntry<FeedRef> = {
      type: "card",
      id: call.id,
      ref: { t: at.type === "card" ? "t3" : "t3-joined", head: at.head, call: call.call },
    };
    list[list.indexOf(entry)] = next;
    tally.retarget(entry, next);
  }
  return { threads, placements, thoughts: new Map() };
}

/** When each line that joined its thread's card while the reader watched closed up. */
const ClosedContext = createContext<ReadonlyMap<string, { at: number; height: number }> | null>(
  null,
);

/** A line that joined its thread's card while the reader watched: it closes up over 200 ms. */
function ClosingLine({ callId }: { callId: string }) {
  const joins = useContext(ClosedContext);
  const closed = joins?.get(callId);
  const [done, setDone] = useState(() => !closed || Date.now() - closed.at > 200);
  useEffect(() => {
    if (done) return;
    const timer = setTimeout(() => setDone(true), 200);
    return () => clearTimeout(timer);
  }, [done]);
  if (done || !closed) return null;
  return (
    <div
      className="t3-closing"
      aria-hidden="true"
      style={{ "--closing-height": `${closed.height}px` } as CSSProperties}
    />
  );
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
  markTranscriptNavigation(line);
  line.scrollIntoView({ block: "nearest" });
  line.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
  return true;
}
