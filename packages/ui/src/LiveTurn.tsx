// The parts of a turn that the engine holds before history does: your
// messages until the gateway's history has them, the run's streaming reply,
// and how a run ended (conversation.md, sections 6, 16 and 17). A run's
// actions are the action cards' (./actions); its approvals, questions and
// messages between bots are the cards' own (./cards).

import {
  isTerminal,
  type Bot,
  type OutgoingMessage,
  type Run,
  type Transcript,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "./bridge.tsx";
import { CloseIcon, WarnIcon } from "./icons.tsx";
import { endingOf } from "./live.ts";
import { Markdown } from "./Markdown.tsx";

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

/**
 * A run's reply while the engine holds it: streamed in as it arrives, with a
 * caret until the gateway reports it complete. A reply cut off by a stop or a
 * failure keeps its text and is captioned "Incomplete".
 */
export function RunReply({ run }: { run: Run }) {
  if (!run.text) return null;
  // Streaming until the gateway reports the reply complete or the run is over:
  // pressing Stop does not end the reply; the confirmation does.
  const streaming = !run.textComplete && !isTerminal(run.state);
  // Cut off only if the reply was not complete when the run stopped or failed.
  const cut = !run.textComplete && (run.state === "stopped" || run.state === "failed");
  return (
    <div className="turn" data-role="assistant" data-testid="live-turn">
      <div className="msg" data-role="assistant">
        <div
          className="bubble"
          data-live="true"
          data-streaming={streaming || undefined}
          aria-busy={streaming}
        >
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
  const [retryError, setRetryError] = useState<string | null>(null);
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
          Completed actions are not undone.
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
      {retryError && (
        <p className="turn-error-reason" data-testid="retry-error">
          Couldn't send it again: {retryError}
        </p>
      )}
      {text && (
        <div className="turn-error-actions">
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => {
              setRetryError(null);
              // The engine still holds the message: its words and files go again together.
              // Otherwise only history has it, and history gives the words alone.
              const held = transcript.outbox.some((message) => message.id === run.messageId);
              const again = held
                ? bridge.invoke({ type: "sendAgain", key: taskKey, messageId: run.messageId! })
                : bridge.invoke({
                    type: "sendMessage",
                    key: taskKey,
                    text,
                    mode: "auto",
                    attachmentIds: [],
                  });
              void again.catch((error: unknown) =>
                setRetryError(error instanceof Error ? error.message : String(error)),
              );
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
