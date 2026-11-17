// The parts of a turn that the engine holds before history does: your
// messages until the gateway's history has them, the run's streaming reply,
// and how a run ended (conversation.md, sections 6, 16 and 17). Steps,
// approvals, questions and messages between bots each have a place here held
// by a one-line placeholder; their cards are built separately.

import type { Bot, OutgoingMessage, Run, Transcript } from "@clawtrate/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "./bridge.tsx";
import { CloseIcon, WarnIcon } from "./icons.tsx";
import { endingOf } from "./live.ts";
import { Markdown } from "./Markdown.tsx";

/** A plain one-line stand-in for a card built elsewhere: it names what it is. */
export function Placeholder({
  kind,
  children,
  pending = false,
}: {
  kind: "activity" | "approval" | "question" | "messaged";
  children: ReactNode;
  pending?: boolean;
}) {
  return (
    <p
      className="card-placeholder"
      data-placeholder={kind}
      data-pending={pending || undefined}
      tabIndex={pending ? -1 : undefined}
    >
      {children}
    </p>
  );
}

/** Your message while the engine holds it, with what is known about its delivery. */
export function OutgoingBubble({
  message,
  taskKey,
  connected,
}: {
  message: OutgoingMessage;
  taskKey: string;
  connected: boolean;
}) {
  const bridge = useBridge();
  const retry = () =>
    void bridge.send({ type: "retryMessage", key: taskKey, messageId: message.id });
  const remove = () =>
    void bridge.send({ type: "deleteMessage", key: taskKey, messageId: message.id });
  // Only a message the gateway accepted takes your colour.
  const accepted = message.status === "sent" || message.status === "unconfirmed";
  let caption: ReactNode = null;
  switch (message.status) {
    case "sent":
      if (message.mode === "steer") caption = <span>Steer</span>;
      break;
    case "awaiting-access":
    case "sending":
      if (!connected) caption = <span>Sends when reconnected</span>;
      break;
    case "checking":
      caption = <span>No answer from the gateway yet. Checking whether it was sent…</span>;
      break;
    case "unknown":
      // No answer came and history does not hold it: never claimed as received.
      caption = (
        <>
          <span>Not known whether the gateway received it</span>
          <button type="button" className="link-button" onClick={retry}>
            Resend
          </button>
          <button type="button" className="link-button" onClick={remove}>
            Delete
          </button>
        </>
      );
      break;
    case "unconfirmed":
      caption = (
        <>
          <span>The gateway took it, but its history doesn't show it</span>
          <button type="button" className="link-button" onClick={retry}>
            Resend
          </button>
          <button type="button" className="link-button" onClick={remove}>
            Delete
          </button>
        </>
      );
      break;
    case "failed":
      caption = (
        <>
          <span title={message.error ?? undefined}>Failed to send</span>
          <button type="button" className="link-button" onClick={retry}>
            Resend
          </button>
          <button type="button" className="link-button" onClick={remove}>
            Delete
          </button>
        </>
      );
      break;
  }
  return (
    <div
      className="turn"
      data-role="user"
      data-testid="outgoing"
      data-status={message.status}
      data-mode={message.mode}
    >
      <div className="msg" data-role="user" data-pending={accepted ? undefined : "held"}>
        <div className="bubble">
          <Markdown text={message.text} />
          {message.attachments.length > 0 && (
            <p className="bubble-files">
              {message.attachments.map((file) => file.fileName).join(", ")}
            </p>
          )}
        </div>
      </div>
      {caption && (
        <div className="msg-caption" data-tone={message.status === "failed" ? "danger" : undefined}>
          {caption}
        </div>
      )}
    </div>
  );
}

/** One placeholder line for each card a run holds, in the order the run made them. */
export function RunCards({ run, transcript }: { run: Run; transcript: Transcript }) {
  const lines: ReactNode[] = [];
  const steps = run.steps.length;
  if (steps > 0) {
    lines.push(
      <Placeholder kind="activity" key="activity">
        Activity: {steps} {steps === 1 ? "step" : "steps"}
      </Placeholder>,
    );
  }
  for (const step of run.steps) {
    if (step.toolName === "sessions_send") {
      lines.push(
        <Placeholder kind="messaged" key={step.id}>
          Message to another bot
        </Placeholder>,
      );
    }
  }
  for (const approval of transcript.approvals) {
    if (approval.runId !== run.id) continue;
    lines.push(
      <Placeholder kind="approval" key={approval.id} pending={approval.status === "pending"}>
        Approval: {approval.status}
      </Placeholder>,
    );
  }
  for (const question of transcript.questions) {
    if (question.runId !== run.id) continue;
    lines.push(
      <Placeholder kind="question" key={question.id} pending={question.status === "pending"}>
        Question: {question.questions[0]?.question ?? question.status}
      </Placeholder>,
    );
  }
  return <>{lines}</>;
}

/**
 * A run's reply while the engine holds it: streamed in as it arrives, with a
 * caret until the gateway reports it complete. A reply cut off by a stop or a
 * failure keeps its text and is captioned "Incomplete".
 */
export function RunReply({ run }: { run: Run }) {
  if (!run.text) return null;
  const streaming = !run.textComplete && (run.state === "running" || run.state === "waiting");
  const cut = run.state === "stopped" || run.state === "failed";
  return (
    <div className="turn" data-role="assistant" data-testid="live-turn">
      <div className="msg" data-role="assistant">
        <div className="bubble" data-live="true" aria-busy={streaming}>
          <Markdown text={run.text} />
          {streaming && <span className="stream-caret" aria-hidden="true" />}
        </div>
      </div>
      {cut && <IncompleteCaption />}
    </div>
  );
}

export function IncompleteCaption() {
  return (
    <div className="msg-caption" data-testid="incomplete">
      <span>Incomplete</span>
    </div>
  );
}

/** The text of the message that started a run, for "Try again". */
export function messageTextOf(run: Run, transcript: Transcript): string | null {
  const outgoing = transcript.outbox.find((message) => message.id === run.messageId);
  if (outgoing) return outgoing.text;
  const anchor = transcript.items.find((item) => item.id === run.anchorItemId);
  if (!anchor) return null;
  const text = anchor.blocks
    .map((block) => (block.kind === "text" ? block.text : ""))
    .join("\n")
    .trim();
  return text || null;
}

/**
 * How a run ended, where the transcript says more than its text: the stop
 * note, a finish that beat Stop, a time limit, or a failed turn's card.
 */
export function RunEnding({
  run,
  bot,
  transcript,
  taskKey,
}: {
  run: Run;
  bot: Bot;
  transcript: Transcript;
  taskKey: string;
}) {
  const bridge = useBridge();
  const [dismissed, setDismissed] = useState(false);
  // Dismiss and the line swap places; focus follows to what replaced it.
  const moved = useRef(false);
  const lineRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    (dismissed ? lineRef : closeRef).current?.focus();
  }, [dismissed]);
  const toggle = (next: boolean) => {
    moved.current = true;
    setDismissed(next);
  };
  const ending = endingOf(run, transcript);
  if (!ending) return null;
  if (ending.kind === "stopped") {
    return (
      <div className="turn-note" data-testid="stop-note" data-run={run.id}>
        <span className="glyph" data-state="stopped" aria-hidden="true" />
        <p>
          <b>
            {ending.after ? `Stopped after ${ending.after}` : "Stopped"}
            {ending.elsewhere ? "," : "."}
          </b>{" "}
          {ending.elsewhere ? "from another device or session. " : ""}
          Completed steps are not undone.
        </p>
      </div>
    );
  }
  if (ending.kind === "finished-before-stop") {
    return (
      <div className="turn-note" data-testid="stop-note" data-run={run.id}>
        <span className="glyph" data-state="done" aria-hidden="true" />
        <p>
          <b>Finished before Stop took effect.</b> The turn completed normally.
        </p>
      </div>
    );
  }
  // A send the gateway refused already says so under your message.
  if (run.error?.kind === "not-started") return null;
  const title =
    ending.kind === "turn-limit"
      ? ending.minutes
        ? `${bot.name}'s turn reached its ${ending.minutes} minute limit`
        : `${bot.name}'s turn reached its time limit`
      : `${bot.name} couldn't finish this turn`;
  const reason =
    ending.kind === "turn-limit"
      ? "The gateway ended the turn so it would not hang. Send a message to pick up where it left off."
      : ending.reason;
  if (dismissed) {
    return (
      <button
        ref={lineRef}
        type="button"
        className="event-line turn-error-line"
        data-testid="turn-error-line"
        onClick={() => toggle(false)}
      >
        {title}
      </button>
    );
  }
  const text = messageTextOf(run, transcript);
  return (
    <div className="card turn-error" role="alert" data-testid="turn-error" data-run={run.id}>
      <WarnIcon />
      <p className="turn-error-title">{title}</p>
      <button
        ref={closeRef}
        type="button"
        className="icon-button"
        data-variant="quiet"
        aria-label="Dismiss this error"
        title="Dismiss this error"
        onClick={() => toggle(true)}
      >
        <CloseIcon />
      </button>
      <p className="turn-error-reason">{reason}</p>
      {text && (
        <div className="turn-error-actions">
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() =>
              void bridge
                .invoke({
                  type: "sendMessage",
                  key: taskKey,
                  text,
                  mode: "auto",
                  attachmentIds: [],
                })
                .catch(() => {})
            }
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
