// How the transcript mounts the cards. The transcript wraps its content in
// <CardScope>, draws each item through <CardSlot>, and puts <TrailingCards />
// before the streaming reply. Everything else about the cards is decided in
// this folder: what goes where (placement.ts), what each says (model.ts) and
// how each looks (cards.css).

import { MAX_INTER_SESSION, type Run, type Transcript, type TranscriptItem } from "@clawtrate/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { movedOn, pressMark } from "../focus.ts";
import { ApprovalCardView } from "./ApprovalCard.tsx";
import {
  CardEnvContext,
  OpenTaskContext,
  StepHandoverContext,
  useCardEnv,
  type CardEnv,
  type StepHandover,
  type StepState,
} from "./context.tsx";
import {
  BotMessageCardView,
  IncomingLine,
  ReceivedCardView,
  T3CodeCardView,
  goBack,
  takeArrival,
  takeReturnPoint,
} from "./MessagedCard.tsx";
import { botMessageKey, mayDispatch, nameOf, sentVerb } from "./model.ts";
import { Announcer } from "./parts.tsx";
import { cardDomId, codingCalls, placeCards, type CardRef } from "./placement.ts";
import { QuestionCardView } from "./QuestionCard.tsx";
import { useCards } from "./useCards.ts";
import "./cards.css";

type Scope = {
  placement: ReturnType<typeof placeCards>;
  cards: ReturnType<typeof useCards>;
};

const ScopeContext = createContext<Scope | null>(null);

/** Ordinary steps whose state a task's view remembers, for the cards they may become. */
const MAX_STEP_STATES = 64;

/** The cards of one open task. Mounted once per task, around its transcript. */
export function CardScope({
  taskKey,
  transcript,
  children,
}: {
  taskKey: string;
  transcript: Transcript;
  children: ReactNode;
}) {
  const state = useClawtrateState();
  const bridge = useBridge();
  const openTask = useContext(OpenTaskContext);
  const task = Object.values(state.tasksByBot)
    .flat()
    .find((each) => each.key === taskKey);
  const bot = state.bots.find((each) => each.id === task?.botId);
  const invoke = bridge.invoke;
  const cards = useCards(taskKey, transcript, invoke);
  const placement = useMemo(
    () =>
      placeCards(
        {
          runs: transcript.runs,
          approvals: transcript.approvals,
          questions: transcript.questions,
          items: transcript.items,
          interSession: transcript.interSession,
        },
        cards.selected,
      ),
    [transcript, cards.selected],
  );
  // Ordinary steps' states, for the card a step becomes; the newest `MAX_STEP_STATES` kept.
  const stepStates = useRef(new Map<string, StepState>());
  const { selected, settledRaw } = cards;
  const handover: StepHandover = useMemo(() => {
    const drawn = new Set(
      codingCalls(selected)
        .filter((card) => card.toolCallId !== null && settledRaw(card.stepId))
        .map((card) => card.toolCallId!),
    );
    return {
      isCard: (callId) => drawn.has(callId),
      note: (callId, value) => {
        const states = stepStates.current;
        states.delete(callId);
        states.set(callId, value);
        while (states.size > MAX_STEP_STATES) states.delete(states.keys().next().value as string);
      },
      stateOf: (callId) => stepStates.current.get(callId),
    };
  }, [selected, settledRaw]);
  const runOf = useCallback(
    (runId: string | null): Run | undefined =>
      runId ? transcript.runs.find((run) => run.id === runId) : undefined,
    [transcript.runs],
  );
  const env: CardEnv = useMemo(
    () => ({
      taskKey,
      bot,
      bots: state.bots,
      transcript,
      connection: state.connection,
      connected: state.connection.status === "connected",
      // The one place cards send commands: a decision or an answer this connection may not give never leaves.
      invoke: (command) =>
        mayDispatch(command, state.connection)
          ? bridge.invoke(command)
          : Promise.reject(new Error("This connection may not do that.")),
      send: (command) =>
        mayDispatch(command, state.connection)
          ? bridge.send(command)
          : Promise.reject(new Error("This connection may not do that.")),
      runOf,
      transcripts: state.transcripts,
      openTask,
    }),
    [
      taskKey,
      bot,
      state.bots,
      transcript,
      state.connection,
      state.transcripts,
      bridge,
      runOf,
      openTask,
    ],
  );

  // ⌘J, Review and "Needs you" are the conversation's: it sends them to focusPending(oldestPending(…)),
  // and only while the conversation is on screen.

  // Arriving from "Open in <bot>": the receiving card of that run, open, in view and focused.
  // The task can show its runs before its history has loaded, so the card may come later:
  // the arrival waits for it until the history has loaded without it.
  // It takes focus only if the person has pressed nothing since choosing "Open in <bot>".
  const arriving = useRef<{ taskKey: string; runId: string; mark: number } | null>(null);
  useLayoutEffect(() => {
    const arrival = takeArrival(taskKey);
    arriving.current = arrival && { taskKey, ...arrival };
  }, [taskKey]);
  useLayoutEffect(() => {
    const pending = arriving.current;
    if (!pending || pending.taskKey !== taskKey) return;
    const open = () => {
      const element = document.querySelector<HTMLDetailsElement>(
        `details[data-target="from"][data-run-id="${CSS.escape(pending.runId)}"]`,
      );
      if (!element) return false;
      element.open = true;
      element.scrollIntoView({ block: "center" });
      if (!movedOn(pending.mark))
        element.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      return true;
    };
    if (open()) arriving.current = null;
    else if (transcript.status !== "loading") {
      // Loaded without it as this frame is drawn: one more frame, then the arrival is over.
      arriving.current = null;
      requestAnimationFrame(() => void open());
    }
  });

  // Coming back from "Open in <bot>": the transcript where the reader left it, the card
  // open, focus on that control. It runs after the transcript has settled at its end, and
  // tells it the reader is not following, so the end does not take the place back.
  useLayoutEffect(() => {
    const back = takeReturnPoint(taskKey);
    if (!back) return;
    // It takes focus only if the person has pressed nothing since choosing the way back (or,
    // when they came back some other way, since the task opened).
    const mark = back.mark ?? pressMark();
    let frame = 0;
    const restore = (tries: number) => {
      const element = document.getElementById(back.domId);
      if (!(element instanceof HTMLDetailsElement)) {
        if (tries > 0) frame = requestAnimationFrame(() => restore(tries - 1));
        return;
      }
      element.open = true;
      const scroller = element.closest<HTMLElement>('[data-testid="transcript"]');
      if (scroller && back.scrollTop !== null) {
        scroller.scrollTop = back.scrollTop;
        scroller.dispatchEvent(new Event("scroll"));
      } else element.scrollIntoView({ block: "center" });
      const button = [...element.querySelectorAll<HTMLButtonElement>(".card-actions button")].find(
        (each) => each.textContent?.startsWith("Open in"),
      );
      if (!movedOn(mark))
        (button ?? element.querySelector<HTMLElement>("summary"))?.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => restore(10))));
    return () => cancelAnimationFrame(frame);
  }, [taskKey]);

  // ⌘[ goes back to where "Open in <bot>" was chosen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "[" && openTask) {
        if (goBack(taskKey, openTask)) event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskKey, openTask]);

  return (
    <ScopeContext.Provider value={{ placement, cards }}>
      <CardEnvContext.Provider value={env}>
        <StepHandoverContext.Provider value={handover}>
          <Announcer>{children}</Announcer>
        </StepHandoverContext.Provider>
      </CardEnvContext.Provider>
    </ScopeContext.Provider>
  );
}

/** Focus the card itself: a question at its first option, an approval as a region. */
export function focusPending(ref: CardRef): void {
  const element = document.getElementById(cardDomId(ref));
  if (!element) return;
  element.scrollIntoView({ block: "nearest" });
  const first =
    ref.kind === "question" ? element.querySelector<HTMLElement>('.option[tabindex="0"]') : null;
  (first ?? element).focus({ preventScroll: true });
}

function useScope(): Scope {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error("cards need a CardScope");
  return scope;
}

/** The task's cards and its calls' raw reads, for the action cards that sit beside them. */
export function useScopeCards(): Scope {
  return useScope();
}

/**
 * Cards the transcript has placed itself, inside a run's column of action
 * cards, at their call (`kind:id`): CardSlot, RunCardList and TrailingCards
 * leave them out.
 */
export const PlacedCardsContext = createContext<ReadonlySet<string>>(new Set());

export const refKey = (ref: CardRef) => `${ref.kind}:${ref.id}`;

export function CardFor({ cardRef }: { cardRef: CardRef }) {
  const { cards } = useScope();
  const env = useCardEnv();
  const domId = cardDomId(cardRef);
  switch (cardRef.kind) {
    case "approval": {
      const card = env.transcript.approvals.find((each) => each.id === cardRef.id);
      return card ? <ApprovalCardView card={card} domId={domId} /> : null;
    }
    case "question": {
      const card = env.transcript.questions.find((each) => each.id === cardRef.id);
      return card ? <QuestionCardView card={card} domId={domId} /> : null;
    }
    case "bot-message": {
      const card = cards.selected.botMessages.find((each) => each.id === cardRef.id);
      if (!card || !cards.settledRaw(card.stepId)) return null;
      return (
        <BotMessageCardView
          card={card}
          read={cards.rawState(card.stepId)}
          related={related(env, cards.selected, card.recipient.sessionKey, card.recipient.agentId)}
          partial={partialHistory(env.transcript)}
        />
      );
    }
    case "t3-code": {
      const card = codingCalls(cards.selected).find((each) => each.id === cardRef.id);
      if (!card || !cards.settledRaw(card.stepId)) return null;
      return <T3CodeCardView card={card} read={cards.rawState(card.stepId)} />;
    }
  }
}

/**
 * Whether what this viewer holds of the task may leave out some of its
 * messages: history has earlier pages, which the engine does not load
 * (`hasMore`); runs or a run's steps were let go under the engine's bounds
 * (`runsOmitted`, `omittedSteps`); or the incoming messages fill their bound.
 */
function partialHistory(transcript: Transcript): boolean {
  return (
    transcript.hasMore ||
    transcript.runsOmitted > 0 ||
    transcript.runs.some((run) => run.omittedSteps > 0) ||
    transcript.interSession.length >= MAX_INTER_SESSION
  );
}

/** Every message between this task's bot and one recipient that this task holds, oldest first. */
function related(
  env: CardEnv,
  selected: ReturnType<typeof useCards>["selected"],
  sessionKey: string | null,
  agentId: string | null,
) {
  const sender = env.bot;
  const same = (key: string | null, agent: string | null) =>
    (sessionKey !== null && key === sessionKey) || (agentId !== null && agent === agentId);
  const sent = selected.botMessages
    .filter((card) => same(card.recipient.sessionKey, card.recipient.agentId) && card.text)
    .map((card) => ({
      id: card.id,
      who: sender ?? {
        id: "bot",
        name: "The bot",
        emoji: null,
        avatarUrl: null,
        theme: null,
        model: null,
        isDefault: false,
      },
      verb: sentVerb(botMessageKey(card)),
      text: card.text!,
      at: card.requestedAt,
    }));
  const replies = selected.botMessages
    .filter((card) => same(card.recipient.sessionKey, card.recipient.agentId) && card.reply)
    .map((card) => ({
      id: `${card.id}:reply`,
      who: recipientBot(env, card.recipient.agentId),
      verb: "replied",
      text: card.reply!.text,
      at: card.resultAt,
    }));
  const incoming = env.transcript.interSession
    .filter((message) => same(message.sourceSessionKey, message.senderAgentId))
    .map((message) => ({
      id: message.itemId,
      who: recipientBot(env, message.senderAgentId),
      verb: "sent",
      text: message.text,
      at: message.timestamp,
    }));
  return [...sent, ...replies, ...incoming].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

function recipientBot(env: CardEnv, id: string | null) {
  const name = nameOf(env.bots, id, "another bot");
  return (
    env.bots.find((bot) => bot.id === id) ?? {
      id: id ?? name,
      name,
      emoji: null,
      avatarUrl: null,
      theme: null,
      model: null,
      isDefault: false,
    }
  );
}

/**
 * One transcript item and the cards that follow it. An inter-session message
 * that started a run here becomes a "Message from <bot>" card; one that did
 * not becomes a "Message from" line.
 */
export function CardSlot({ item, children }: { item: TranscriptItem; children: ReactNode }) {
  const { placement } = useScope();
  const placed = useContext(PlacedCardsContext);
  const env = useCardEnv();
  const incoming = placement.incoming.get(item.id);
  const refs = (placement.afterItem.get(item.id) ?? []).filter((ref) => !placed.has(refKey(ref)));
  let own: ReactNode = children;
  if (incoming) {
    const run = env.transcript.runs.find((each) => each.anchorItemId === item.id);
    own = run ? (
      <ReceivedCardView message={incoming} run={run} />
    ) : (
      <IncomingLine message={incoming} />
    );
  }
  return (
    <>
      {own}
      {refs.map((ref) => (
        <CardFor key={`${ref.kind}:${ref.id}`} cardRef={ref} />
      ))}
    </>
  );
}

/**
 * One run's cards, in order, for a transcript that draws each run itself.
 * Use it or CardSlot's cards for a run, not both.
 */
export function RunCardList({ runId }: { runId: string }) {
  const { placement } = useScope();
  const placed = useContext(PlacedCardsContext);
  return (
    <>
      {(placement.byRun.get(runId) ?? [])
        .filter((ref) => !placed.has(refKey(ref)))
        .map((ref) => (
          <CardFor key={`${ref.kind}:${ref.id}`} cardRef={ref} />
        ))}
    </>
  );
}

/**
 * Cards whose run the transcript does not show yet, before the streaming reply.
 * `except` names runs the transcript draws itself with RunCardList.
 */
export function TrailingCards({ except }: { except?: ReadonlySet<string> }) {
  const { placement } = useScope();
  const placed = useContext(PlacedCardsContext);
  const drawn = new Set(
    [...(except ?? [])].flatMap((runId) =>
      (placement.byRun.get(runId) ?? []).map((ref) => `${ref.kind}:${ref.id}`),
    ),
  );
  return (
    <>
      {placement.trailing
        .filter((ref) => !drawn.has(`${ref.kind}:${ref.id}`) && !placed.has(refKey(ref)))
        .map((ref) => (
          <CardFor key={`${ref.kind}:${ref.id}`} cardRef={ref} />
        ))}
    </>
  );
}
