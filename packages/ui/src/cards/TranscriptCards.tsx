// How the transcript mounts the cards. The transcript wraps its content in
// <CardScope>, draws each item through <CardSlot>, and puts <TrailingCards />
// before the streaming reply. Everything else about the cards is decided in
// this folder: what goes where (placement.ts), what each says (model.ts) and
// how each looks (cards.css).

import type { Run, Transcript, TranscriptItem } from "@clawtrate/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { ApprovalCardView } from "./ApprovalCard.tsx";
import {
  CardEnvContext,
  OpenTaskContext,
  useCardEnv,
  useCardSettings,
  type CardEnv,
} from "./context.tsx";
import {
  BotMessageCardView,
  IncomingLine,
  ReceivedCardView,
  T3CodeCardView,
  takeReturnPoint,
} from "./MessagedCard.tsx";
import { nameOf } from "./model.ts";
import { Announcer } from "./parts.tsx";
import { cardDomId, codingCalls, oldestPending, placeCards, type CardRef } from "./placement.ts";
import { QuestionCardView } from "./QuestionCard.tsx";
import { useCards } from "./useCards.ts";
import "./cards.css";

type Scope = {
  placement: ReturnType<typeof placeCards>;
  cards: ReturnType<typeof useCards>;
};

const ScopeContext = createContext<Scope | null>(null);

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
  const settings = useCardSettings();
  const openTask = useContext(OpenTaskContext);
  const task = Object.values(state.tasksByBot)
    .flat()
    .find((each) => each.key === taskKey);
  const bot = state.bots.find((each) => each.id === task?.botId);
  const invoke = bridge.invoke;
  const cards = useCards(taskKey, transcript, settings.codingServers, invoke);
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
      invoke: (command) => bridge.invoke(command),
      send: (command) => bridge.send(command),
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

  // ⌘J goes to what needs you: the oldest pending card, focused.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        const ref = oldestPending(transcript);
        if (!ref) return;
        event.preventDefault();
        focusPending(ref);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [transcript]);

  // Coming back from "Open in <bot>": the card open again, in view, focus on that control.
  useLayoutEffect(() => {
    const domId = takeReturnPoint(taskKey);
    if (!domId) return;
    const restore = () => {
      const element = document.getElementById(domId);
      if (!(element instanceof HTMLDetailsElement)) return false;
      element.open = true;
      element.scrollIntoView({ block: "center" });
      const button = [...element.querySelectorAll<HTMLButtonElement>(".card-actions button")].find(
        (each) => each.textContent?.startsWith("Open in"),
      );
      (button ?? element.querySelector<HTMLElement>("summary"))?.focus({ preventScroll: true });
      return true;
    };
    if (!restore()) requestAnimationFrame(() => void restore());
  }, [taskKey]);

  return (
    <ScopeContext.Provider value={{ placement, cards }}>
      <CardEnvContext.Provider value={env}>
        <Announcer>{children}</Announcer>
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

function CardFor({ cardRef }: { cardRef: CardRef }) {
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

/** Every message between this task's bot and one recipient in this task, oldest first. */
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
      verb: "sent",
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
  const env = useCardEnv();
  const incoming = placement.incoming.get(item.id);
  const refs = placement.afterItem.get(item.id) ?? [];
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

/** Cards whose run the transcript does not show yet, before the streaming reply. */
export function TrailingCards() {
  const { placement } = useScope();
  return (
    <>
      {placement.trailing.map((ref) => (
        <CardFor key={`${ref.kind}:${ref.id}`} cardRef={ref} />
      ))}
    </>
  );
}
