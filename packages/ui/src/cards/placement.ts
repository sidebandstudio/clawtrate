// Which card goes where in a task's transcript. This is the one module that
// maps the engine's state to card positions; the transcript asks it, by item,
// what to draw, and draws nothing else for cards.
//
// The rule (conversation.md section 1): a run's cards follow the message that
// started it, before its reply, in the order things arrived: each message to
// another bot where its call began (T3 Code's threads are placed by the action feed), then approvals and
// questions in the order they were asked. A run whose start the transcript
// does not show yet, and a card whose run is not known, go at the end, before
// the streaming reply. An inter-session message that started a run here is
// drawn as a "Message from <bot>" card in its own place.

import type {
  BotMessageCard,
  InterSessionMessage,
  SelectedCards,
  TaskActivity,
  TranscriptItem,
} from "@clawtrate/core";

export type CardRef =
  | { kind: "approval"; id: string }
  | { kind: "question"; id: string }
  | { kind: "bot-message"; id: string };

export type CardPlacement = {
  /** Every card of a run, in order, by run id: for a transcript that draws runs itself. */
  byRun: Map<string, CardRef[]>;
  /** Cards drawn right after a transcript item, by item id. */
  afterItem: Map<string, CardRef[]>;
  /** Cards drawn after every item, before the streaming reply. */
  trailing: CardRef[];
  /** Transcript items drawn as a "Message from <bot>" card instead of a bubble, by item id. */
  incoming: Map<string, InterSessionMessage>;
};

export type PlacementInput = Pick<TaskActivity, "runs" | "approvals" | "questions"> & {
  items: TranscriptItem[];
  interSession: InterSessionMessage[];
};

export function placeCards(input: PlacementInput, selected: SelectedCards): CardPlacement {
  const items = new Set(input.items.map((item) => item.id));
  const afterItem = new Map<string, CardRef[]>();
  const trailing: CardRef[] = [];
  const byRun = new Map<string, CardRef[]>();
  const add = (runId: string | null, ref: CardRef) => {
    if (runId && input.runs.some((run) => run.id === runId)) {
      const list = byRun.get(runId) ?? [];
      list.push(ref);
      byRun.set(runId, list);
    } else trailing.push(ref);
  };

  // Calls and requests in one order: when the gateway reports each began (a call's
  // start, a request's creation). At the same time a call comes before a request,
  // which is how an approval for a call arrives; otherwise the engine's own order
  // holds. A card the gateway gave no time sorts after those it did.
  type Arrival = { at: number; kind: 0 | 1; order: number; runId: string | null; ref: CardRef };
  const arrivals: Arrival[] = [];
  const stepOrder = new Map<string, number>();
  input.runs.forEach((run, r) =>
    run.steps.forEach((step, s) => stepOrder.set(step.id, r * 10_000 + s)),
  );
  const timeOf = (at: number | null) => at ?? Number.POSITIVE_INFINITY;
  const pushCall = (card: BotMessageCard, kind: "bot-message") =>
    arrivals.push({
      at: timeOf(card.requestedAt),
      kind: 0,
      order: stepOrder.get(card.stepId) ?? 0,
      runId: card.runId,
      ref: { kind, id: card.id },
    });
  for (const card of selected.botMessages) pushCall(card, "bot-message");
  input.approvals.forEach((card, order) =>
    arrivals.push({
      at: timeOf(card.createdAt),
      kind: 1,
      order,
      runId: card.runId,
      ref: { kind: "approval", id: card.id },
    }),
  );
  input.questions.forEach((card, order) =>
    arrivals.push({
      at: timeOf(card.createdAt),
      kind: 1,
      order: 1_000 + order,
      runId: card.runId,
      ref: { kind: "question", id: card.id },
    }),
  );
  const byTime = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
  arrivals.sort((a, b) => byTime(a.at, b.at) || a.kind - b.kind || a.order - b.order);
  for (const arrival of arrivals) add(arrival.runId, arrival.ref);

  for (const run of input.runs) {
    const refs = byRun.get(run.id);
    if (!refs) continue;
    if (run.anchorItemId && items.has(run.anchorItemId)) {
      afterItem.set(run.anchorItemId, [...(afterItem.get(run.anchorItemId) ?? []), ...refs]);
    } else trailing.push(...refs);
  }

  const incoming = new Map<string, InterSessionMessage>();
  for (const message of input.interSession) {
    const itemId = itemOf(message, input.items);
    if (itemId) incoming.set(itemId, message);
  }
  return { byRun, afterItem, trailing, incoming };
}

/** The transcript item an inter-session message is: the engine gives both the history row's id. */
function itemOf(message: InterSessionMessage, items: TranscriptItem[]): string | null {
  return items.some((item) => item.id === message.itemId) ? message.itemId : null;
}

/** The oldest pending card, which "Review", ⌘J and "Needs you" go to. */
export function oldestPending(
  input: Pick<TaskActivity, "approvals" | "questions">,
): CardRef | null {
  const pending = [
    ...input.approvals
      .filter((card) => card.status === "pending")
      .map((card) => ({
        at: card.createdAt ?? 0,
        ref: { kind: "approval", id: card.id } as CardRef,
      })),
    ...input.questions
      .filter((card) => card.status === "pending")
      .map((card) => ({
        at: card.createdAt ?? 0,
        ref: { kind: "question", id: card.id } as CardRef,
      })),
  ].sort((a, b) => a.at - b.at);
  return pending[0]?.ref ?? null;
}

/** The DOM id a card is drawn under, so a control elsewhere can bring it into view. */
export function cardDomId(ref: CardRef): string {
  return `card-${ref.kind}-${ref.id.replace(/[^\w-]/g, "_")}`;
}
