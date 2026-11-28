// The "Started a task" card (F-587), in the Messaged cards' frame: a task a bot started from this
// conversation, with the bot doing the work, the task's title, the first line of the bot's brief
// and the task's state, and Open to go to it. The title and the brief are the bot's words, drawn
// as text. The task it opens and its state come only from the engine's card
// (`selectStartedTasks`): the gateway's own result and this connection's task list.

import { refusedModelLine, type StartedTaskCard } from "@clawtrate/core";
import { useContext, useEffect, useRef } from "react";
import { Avatar } from "../Avatar.tsx";
import { CardThoughtContext, useCardEnv } from "./context.tsx";
import { botFor, callRaw } from "./MessagedCard.tsx";
import { STARTED_STATES } from "./model.ts";
import { CardFoot, Glyph, useAnnounce, useRawDisclosure } from "./parts.tsx";
import { cardDomId } from "./placement.ts";
import type { StepRawState } from "./useCards.ts";

/** States the task is still in: while the connection is lost they read "Last seen …". */
const LIVE = new Set(["starting", "working", "queued"]);

/** Bring the bot's report into view, with focus on it. */
function showReply(itemId: string, from: Element): void {
  const scope = from.closest('[data-testid="transcript"]') ?? document;
  const turn = scope.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
  if (!turn) return;
  turn.scrollIntoView({ block: "center" });
  if (!turn.hasAttribute("tabindex")) turn.setAttribute("tabindex", "-1");
  turn.focus({ preventScroll: true });
}

export function StartedTaskCardView({ card, read }: { card: StartedTaskCard; read: StepRawState }) {
  const thought = useContext(CardThoughtContext);
  const env = useCardEnv();
  const announce = useAnnounce();
  const raw = useRawDisclosure(read.load);
  const run = env.runOf(card.runId);
  const step = run?.steps.find((each) => each.id === card.stepId);
  const starter = env.bot ?? botFor(env.bots, null, "The bot");
  // A listed bot by the id; the starter when the start was its own; else "another bot". The id
  // itself is never shown: before an accepted result it is only what the bot asked for.
  const worker =
    env.bots.find((each) => each.id === card.agentId) ??
    (card.agentId === null || card.agentId === starter.id
      ? starter
      : botFor(env.bots, null, "another bot"));
  const lost = env.connection.status !== "connected";
  const [mark, word, tone] = STARTED_STATES[card.state];
  const shown = lost && LIVE.has(card.state) ? `Last seen ${word.toLowerCase()}` : word;
  const title = card.title ?? "A task";
  const refused = card.state === "couldnt-start";
  const verb = refused ? "Couldn't start a task" : "Started a task";
  const domId = cardDomId({ kind: "started-task", id: card.id });
  const task = card.task;
  const open = task !== null && env.openTask !== null ? env.openTask : null;

  // A change of state is said once, politely, in words: the first drawing is not a change, and
  // neither is a state that reads the same ("Started" not listed, then "Started" listed).
  const said = useRef(word);
  useEffect(() => {
    if (said.current === word) return;
    said.current = word;
    announce(`${title}: ${word}`);
  }, [title, word, announce]);

  // Nothing at all when there is nothing to do: an empty row would still take its height.
  const actions =
    (open && task) || card.reportedBack ? (
      <>
        {open && task && (
          <button
            type="button"
            className="link-button"
            aria-label={`Open ${title}`}
            data-testid="open-started-task"
            onClick={() => open(task.botId, task.key)}
          >
            Open task
          </button>
        )}
        {card.reportedBack && (
          <button
            type="button"
            className="link-button"
            aria-label={`Show ${starter.name}'s report on ${title}`}
            onClick={(event) => showReply(card.reportedBack!, event.currentTarget)}
          >
            Show the report
          </button>
        )}
      </>
    ) : undefined;

  let note: string | null = null;
  // Made, and its brief never ran (2026.11.10's `sessions_create`): the task opens, and says so.
  if (card.firstRunFailed) note = "The task was made, but its first message didn't run.";
  else if (card.state === "starting") note = `${starter.name} is starting this task.`;
  else if (card.state === "started")
    note = "This task is not in the task list here, so it can't be opened from this card.";
  else if (card.state === "unknown")
    note = "The gateway's record of this call doesn't say whether the task started.";
  // A start the gateway's model allowlist refused, in plain words; its own words stay in Details.
  else if (refused && card.refusedModel) note = refusedModelLine(card.refusedModel);

  return (
    <section
      className="card messaged started-task"
      role="group"
      aria-label={`${verb}: ${title}`}
      data-call={card.toolCallId ?? undefined}
      data-state={card.state}
      data-connection={lost ? "lost" : undefined}
      id={domId}
      data-testid="started-task-card"
    >
      <div className="messaged-line">
        <span className="messaged-verb">{verb}</span>
        <span className="messaged-who">
          <Avatar bot={worker} />
          {worker.name}
        </span>
        <span className="started-title" title={title}>
          {title}
        </span>
        <span className="state" data-state={card.state} data-tone={tone ?? undefined}>
          <Glyph state={mark} />
          {shown}
        </span>
      </div>
      <div className="messaged-body">
        {thought && <div className="action-thought">{thought}</div>}
        {card.brief && (
          <p className="started-brief" data-testid="started-task-brief">
            {card.brief}
          </p>
        )}
        {note && <p className="exchange-note">{note}</p>}
        {(refused || card.firstRunFailed) && card.reason && !card.refusedModel && (
          <>
            <p className="exchange-note">The gateway says:</p>
            <div className="exchange-text" data-testid="started-task-reason">
              {card.reason}
            </div>
          </>
        )}
        {card.reportedBack && (
          <p className="exchange-note" data-testid="started-task-reported">
            {starter.name} reported back.
          </p>
        )}
        <CardFoot
          disclosure={raw}
          raw={callRaw(
            read,
            {
              toolName: step?.toolName ?? "sessions_spawn",
              startedAt: card.requestedAt,
              endedAt: card.endedAt,
            },
            [
              { label: "Tool call", value: card.toolCallId },
              { label: "Run", value: card.runId },
              { label: "Task", value: card.taskKey },
            ],
            refused ? card.reason : null,
            card.state === "starting",
            step?.truncated ?? false,
          )}
        >
          {actions}
        </CardFoot>
      </div>
    </section>
  );
}
