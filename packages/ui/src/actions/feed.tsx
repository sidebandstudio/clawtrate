// Where the action cards go (docs/design/conversation.md, sections 1 and 7):
// each run's ordered record, from the history item that holds it or from the
// engine's live run, goes through the engine's one grouping (`groupFeed`), so
// a live run and a reload draw the same cards. The Messaged and T3 Code cards
// take their call's place in the column, an approval follows the call it
// names, and a question card takes its `ask_user` call's place.

import {
  callFromBlock,
  callFromStep,
  groupFeed,
  isTerminal,
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
  PlacedCardsContext,
  codingCalls,
  refKey,
  useScopeCards,
  useStepHandover,
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

/** What a non-action entry of a record is. */
export type FeedRef =
  | { t: "text"; text: string; title?: string | undefined }
  | { t: "preamble"; preamble: Preamble }
  | { t: "reply"; run: Run }
  | { t: "card"; ref: CardRef };

type Groups = FeedGroup<FeedRef>[];

type Feeds = {
  /** The groups of each assistant history item, by item id. */
  items: Map<string, { groups: Groups; revision: number }>;
  /** The groups of each run drawn from the engine, by run id. */
  runs: Map<string, { groups: Groups; revision: number }>;
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
  /** The question cards of a run not placed yet, oldest first, matched in order to its `ask_user` calls. */
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
  questions: CardRef[],
): FeedEntry<FeedRef>[] {
  const card = cards.card(callId);
  const out: FeedEntry<FeedRef>[] = [];
  if (card && cards.taken.has(refKey(card))) return out;
  if (card) cards.taken.add(refKey(card));
  if (card) out.push({ type: "card", id: callId, ref: { t: "card", ref: card } });
  else if (name === "ask_user" && questions.length > 0) {
    const question = questions.shift()!;
    cards.taken.add(refKey(question));
    out.push({ type: "break", id: refKey(question), ref: { t: "card", ref: question } });
  } else out.push(action());
  for (const approval of cards.approvals(callId)) {
    if (cards.taken.has(refKey(approval))) continue;
    cards.taken.add(refKey(approval));
    out.push({ type: "break", id: refKey(approval), ref: { t: "card", ref: approval } });
  }
  return out;
}

/** An assistant history item's record. */
function itemEntries(
  item: TranscriptItem,
  run: Run | undefined,
  index: Map<string, { step: Step; run: Run }>,
  skip: ReadonlySet<string>,
  cards: CardsFor,
): FeedEntry<FeedRef>[] {
  const reasoningSteps = run ? run.steps.filter((s) => s.kind === "reasoning") : [];
  const reasoningBlocks = item.blocks.filter((b) => b.kind === "reasoning").length;
  // The engine's derived reasoning ids, when its run holds the same blocks.
  const engineIds = reasoningSteps.length === reasoningBlocks;
  const questions = run ? [...cards.questions(run.id)] : [];
  const entries: FeedEntry<FeedRef>[] = [];
  let r = 0;
  // A bubble is keyed by its text, not its place, so a block history adds before it keeps it.
  const seen = new Map<string, number>();
  item.blocks.forEach((block, i) => {
    if (block.kind === "text") {
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
      entries.push(
        ...callEntries(
          block.callId,
          block.name,
          () => ({ type: "action", call: callFromBlock(block, found?.step, found?.run) }),
          cards,
          questions,
        ),
      );
    }
  });
  return entries;
}

/** A run the engine holds: its steps, its text beside calls, its unplaced cards, its reply. */
function runEntries(run: Run, cards: CardsFor, rest: CardRef[]): FeedEntry<FeedRef>[] {
  const entries: FeedEntry<FeedRef>[] = [];
  const preambles = [...(run.preambles ?? [])];
  const questions = [...cards.questions(run.id)];
  const preamble = (p: Preamble) =>
    entries.push({ type: "bubble", id: `preamble:${p.id}`, ref: { t: "preamble", preamble: p } });
  let tools = 0;
  for (const step of run.steps) {
    if (step.kind === "reasoning") {
      entries.push({ type: "reasoning", segment: segmentFromStep(step) });
      continue;
    }
    while (preambles.length && preambles[0]!.beforeTools <= tools) preamble(preambles.shift()!);
    tools += 1;
    if (!step.toolCallId) continue;
    entries.push(
      ...callEntries(
        step.toolCallId,
        step.toolName ?? "",
        () => ({ type: "action", call: callFromStep(step, run) }),
        cards,
        questions,
      ),
    );
  }
  preambles.forEach(preamble);
  // A card that names no call of the run takes its place by when it arrived, among the calls.
  for (const ref of [...rest, ...questions]) {
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
  if (run.text) entries.push({ type: "bubble", id: `reply:${run.id}`, ref: { t: "reply", run } });
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
  ctx,
  children,
}: {
  taskKey: string;
  transcript: Transcript;
  engineRuns: Run[];
  lost: boolean;
  readOnly: boolean;
  ctx: ReadingContext;
  children: ReactNode;
}) {
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
      questions: (runId) =>
        transcript.questions
          .filter((card) => card.runId === runId && !taken.has(`question:${card.id}`))
          .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
          .map((card) => ({ kind: "question" as const, id: card.id })),
    };
    const skip = new Set(
      engineRuns.flatMap((run) => run.steps.flatMap((s) => (s.toolCallId ? [s.toolCallId] : []))),
    );
    // Tools already called earlier in the task, in its order: a plan after the first is saved again.
    const called = new Set<string>();
    const markRepeats = (entries: FeedEntry<FeedRef>[]) =>
      entries.map((entry) => {
        if (entry.type !== "action") return entry;
        const repeat = called.has(entry.call.name);
        called.add(entry.call.name);
        return repeat ? { ...entry, call: { ...entry.call, repeat: true } } : entry;
      });
    const items = new Map<string, { groups: Groups; revision: number }>();
    let previousUser: string | null = null;
    for (const item of transcript.items) {
      if (item.role === "user") previousUser = item.id;
      if (item.role !== "assistant") continue;
      const run = runOfItem(item, previousUser, index, transcript.runs);
      const entries = markRepeats(itemEntries(item, run, index, skip, cards));
      items.set(item.id, {
        groups: groupFeed(entries, ctx),
        revision: run?.reasoningRevision ?? 0,
      });
    }
    const runs = new Map<string, { groups: Groups; revision: number }>();
    for (const run of engineRuns) {
      const rest = placement.byRun.get(run.id) ?? [];
      runs.set(run.id, {
        groups: groupFeed(markRepeats(runEntries(run, cards, rest)), ctx),
        revision: run.reasoningRevision,
      });
    }
    return { items, runs } satisfies Feeds;
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
    };
  }, [taskKey, transcript.runs, transcript.sessionKey, ctx, rawState, lost, readOnly]);

  useKeepFocus();

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
      const before =
        group.type === "card" && group.thought ? (
          <ThoughtLine thought={group.thought} place="end" revision={revision} />
        ) : null;
      switch (ref.t) {
        case "card":
          return (
            <>
              {before}
              <CardFor cardRef={ref.ref} />
            </>
          );
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
  const calls = useMemo(
    () => run.steps.filter((s) => s.kind === "tool").map((s) => callFromStep(s, run)),
    [run],
  );
  const line = isTerminal(run.state) ? runLineOf(run, calls) : null;
  if (!line) return null;
  return <RunLineView runId={run.id} line={line} model={run.model} />;
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
  const element = root.querySelector<HTMLElement>(`#${CSS.escape(actionDomId(callId))}`);
  if (!element) return false;
  const fold = element.closest<HTMLDetailsElement>(".action[data-fold]");
  const line = fold && !fold.open ? fold : element;
  line.scrollIntoView({ block: "nearest" });
  line.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
  return true;
}
