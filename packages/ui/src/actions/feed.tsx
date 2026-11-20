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
import {
  ActionEnvContext,
  ActionGroup,
  RunLineView,
  ThoughtLine,
  actionDomId,
  type ActionEnv,
} from "./ActionCards.tsx";

/** What a non-action entry of a record is. */
export type FeedRef =
  | { t: "text"; text: string; title?: string | undefined; messageId?: string | undefined }
  | { t: "preamble"; preamble: Preamble }
  | { t: "reply"; run: Run }
  | { t: "card"; ref: CardRef }
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
  const handover = useStepHandover();
  const { selected, rawState } = scope.cards;
  const { placement } = scope;

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
    const items = new Map<string, { groups: Groups; revision: number }>();
    for (const each of built)
      items.set(each.id, { groups: groupFeed(each.entries, ctx), revision: each.revision });
    const runs = new Map<string, { groups: Groups; revision: number }>();
    for (const each of builtRuns)
      runs.set(each.id, { groups: groupFeed(each.entries, ctx), revision: each.revision });
    return { items, runs, accounts } satisfies Feeds;
  }, [transcript, engineRuns, selected, handover, placement, ctx]);

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
        <FeedsContext.Provider value={feeds}>{children}</FeedsContext.Provider>
      </PlacedCardsContext.Provider>
    </ActionEnvContext.Provider>
  );
}

/**
 * When the control that held focus is replaced (a card becoming a fold, a
 * fold splitting), focus moves to the same control in what replaced it, or
 * to the replacement's line (section 2, Input). Controls are found by their
 * call and their own name, never by position.
 */
function useKeepFocus() {
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
    if (!holder) return;
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
  return (
    <RunLineView
      runId={run.id}
      line={line}
      model={run.model}
      lifecycle={run.lifecycle ?? null}
      failure={run.error?.raw ?? null}
    />
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
