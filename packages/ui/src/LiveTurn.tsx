// The parts of a turn that the engine holds before history does: your
// messages until the gateway's history has them, the run's streaming reply,
// and how a run ended (conversation.md, sections 6, 16 and 17). A run's
// actions are the action cards' (./actions); its approvals, questions and
// messages between bots are the cards' own (./cards).

import {
  attachmentsCut,
  wordsCut,
  isTerminal,
  type Bot,
  type OutgoingMessage,
  type Run,
  type RunErrorRaw,
  type RunRawRead,
  type Transcript,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge, useClawtrateState } from "./bridge.tsx";
import { useAnnounce } from "./cards/parts.tsx";
import { copyText, selectContents } from "./clipboard.ts";
import { CloseIcon, WarnIcon } from "./icons.tsx";
import { endingOf, failedTurnTitle, forEarlierMessage, notRunWords } from "./live.ts";
import { requestBotSettings } from "./bots/settings-request.ts";
import { Markdown } from "./Markdown.tsx";
import { SentFiles } from "./SentFiles.tsx";

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
      // "Steer" only once the gateway's record shows it joined the run (docs/research/steer-stop.md).
      if (message.mode === "steer")
        caption = <span>{message.steer === "joined" ? "Steer" : "Steer requested"}</span>;
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
        {message.text && (
          <div className="bubble">
            <Markdown text={message.text} />
          </div>
        )}
      </div>
      <SentFiles taskKey={taskKey} messageKey={message.id} files={message.attachments} />
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

/** A bot's name from one of its session keys (`agent:<bot>:…`), or the key's bot id. */
function botOfSession(bots: readonly Bot[], key: string): string {
  const id = /^agent:([^:]+):/.exec(key)?.[1] ?? key;
  return bots.find((each) => each.id === id)?.name ?? id;
}

/** "a, b and c". */
function listed(words: string[]): string {
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * The lines under a stop's note: every helper run and bot run the gateway reported stopped with
 * the run, each recipient whose stop it refused or did not answer, and each message whose delivery
 * is not known (F-298). No process is named: the gateway does not say which run started one.
 */
export function stoppedWithLines(run: Run, nameOf: (sessionKey: string) => string): string[] {
  const also = run.stoppedWith;
  if (!also) return [];
  const lines: string[] = [];
  const stopped: string[] = [];
  if (also.helpers > 0)
    stopped.push(also.helpers === 1 ? "1 helper run" : `${also.helpers} helper runs`);
  for (const key of also.bots) stopped.push(`${nameOf(key)}'s run for this message`);
  if (stopped.length > 0) lines.push(`Stopped with it: ${listed(stopped)}.`);
  for (const key of also.refused)
    lines.push(`The gateway refused to stop ${nameOf(key)}'s run for this message.`);
  for (const key of also.unanswered)
    lines.push(`${nameOf(key)}'s run for this message may still be going: its stop got no answer.`);
  for (const key of also.uncertain)
    lines.push(`The message to ${nameOf(key)} may or may not have been delivered.`);
  if (also.omitted > 0)
    lines.push(
      `${also.omitted} more ${also.omitted === 1 ? "run was" : "runs were"} asked to stop, not listed here.`,
    );
  return lines;
}

/**
 * The person's message a run is known to have started from: its keyed anchor only (#686). A
 * position decides where a run is drawn, never what Try again sends.
 */
function keyedAnchor(run: Run, transcript: Transcript) {
  return run.anchorKeyed
    ? transcript.items.find((item) => item.id === run.anchorItemId)
    : undefined;
}

/**
 * What "Try again" sends for a failed run, if anything (#686). Nothing goes out without its files:
 * - `again`: this device still holds the message, and its words and files go again together;
 * - `text`: only history has it, and it was words alone;
 * - `files-gone`: only history has it, and it had files this device no longer holds: no Try
 *   again, and the line says to send it again with them;
 * - `files-unknown`: only history has it, and history's list of its files was cut to its bound, so
 *   whether it had any isn't known: no Try again, and the line says to send it again with any;
 * - `words-cut`: only history has it, and its words may be only their start (`wordsCut`): no Try
 *   again, and the line says to send it again in full. A files plan says so too (`wordsCut`);
 * - null: no message is known to have started the run.
 */
export type RetryPlan =
  | { kind: "again"; messageId: string }
  | { kind: "text"; text: string; replyToId: string | null }
  | { kind: "files-gone"; wordsCut?: true }
  | { kind: "files-unknown"; wordsCut?: true }
  | { kind: "words-cut" }
  | null;

export function retryPlan(run: Run, transcript: Transcript): RetryPlan {
  if (run.messageId && transcript.outbox.some((message) => message.id === run.messageId))
    return { kind: "again", messageId: run.messageId };
  const anchor = keyedAnchor(run, transcript);
  if (!anchor) return null;
  // Nor do words that may be only their start, which a files plan says as well.
  const cut = wordsCut(anchor) ? ({ wordsCut: true } as const) : {};
  if ((anchor.attachments?.length ?? 0) > 0) return { kind: "files-gone", ...cut };
  // Words alone go again only when the message is known to have had no files.
  if (attachmentsCut(anchor)) return { kind: "files-unknown", ...cut };
  if ("wordsCut" in cut) return { kind: "words-cut" };
  const text = messageTextOf(run, transcript);
  return text ? { kind: "text", text, replyToId: messageReplyOf(run, transcript) } : null;
}

/**
 * The message a run's own message replied to, from the outbox or from history's reference on the
 * run's message. Try again sends it only through `retryPlan`, which first requires that message
 * known by its key: a parent is never taken from a message the run is only drawn under (#686).
 */
export function messageReplyOf(run: Run, transcript: Transcript): string | null {
  const outgoing = transcript.outbox.find((message) => message.id === run.messageId);
  if (outgoing) return outgoing.replyToId ?? null;
  return transcript.items.find((item) => item.id === run.anchorItemId)?.replyTo?.id ?? null;
}

/**
 * The text of the message that started a run, for "Try again": null (no Try again) when no
 * message is known to have started it, as for a failure history keyed to none (#686).
 */
export function messageTextOf(run: Run, transcript: Transcript): string | null {
  const outgoing = transcript.outbox.find((message) => message.id === run.messageId);
  if (outgoing) return outgoing.text;
  const anchor = keyedAnchor(run, transcript);
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
  const announce = useAnnounce();
  const bots = useClawtrateState().bots;
  const [dismissed, setDismissed] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawRead, setRawRead] = useState<RunRawRead | null>(null);
  const requestRef = useRef<HTMLPreElement>(null);
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
    const also = stoppedWithLines(run, (key) => botOfSession(bots, key));
    return (
      <div className="turn-note" data-testid="stop-note" data-run={run.id}>
        <span className="glyph" data-state="stopped" aria-hidden="true" />
        <div>
          {ending.timeouts !== null ? (
            <p>
              <b>Stopped after {ending.timeouts} tool calls in a row timed out.</b> The machine{" "}
              {bot.name} works on may not be responding. Completed actions are not undone.
            </p>
          ) : (
            <p>
              <b>
                {ending.after ? `Stopped after ${ending.after}` : "Stopped"}
                {ending.elsewhere ? "," : "."}
              </b>{" "}
              {ending.elsewhere ? "with no local Stop confirmed. " : ""}
              Completed actions are not undone.
            </p>
          )}
          {ending.timeouts === null &&
            transcript.outbox.some(
              (message) =>
                // Its parent as Stop found it: a send that got no answer names it only by alias.
                (message.runId === run.id || transcript.steerAliases[message.id] === run.id) &&
                message.mode === "steer" &&
                message.leftAt !== null &&
                message.steer === undefined,
            ) && <p>The gateway may still run messages it already accepted.</p>}
          {(run.omittedTools ?? 0) > 0 && (
            <p>Some actions are no longer shown. Other bots' work may continue.</p>
          )}
          {also.length > 0 && (
            <ul className="turn-note-list" data-testid="stopped-with">
              {also.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }
  if (ending.kind === "stop-unknown") {
    return (
      <div className="turn-note" data-testid="stop-note" data-run={run.id}>
        <span className="glyph" data-state="stopped" aria-hidden="true" />
        <p>
          <b>Stop requested.</b> The gateway has not confirmed that the turn stopped.
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
  // A message the gateway couldn't run: why, and the ways forward (#663).
  // No message is known to have started it: said to be for an earlier one, with no Try again.
  const earlier = forEarlierMessage(run, transcript);
  const notRun =
    ending.kind === "not-run" || ending.kind === "not-started"
      ? notRunWords(ending, bot.name, earlier)
      : null;
  // The app's own limit and the gateway's are worded apart: each says who ended the turn.
  const title = notRun
    ? notRun.title
    : ending.kind === "turn-limit"
      ? `${bot.name}'s turn reached its ${ending.minutes} minute limit`
      : ending.kind === "gateway-timeout"
        ? `${bot.name}'s turn reached the gateway's time limit`
        : failedTurnTitle(bot.name, earlier);
  const reason = notRun
    ? notRun.reason
    : ending.kind === "turn-limit"
      ? "Clawtrate stopped it at the Turn time limit in Settings, and the gateway confirmed. Send a message to pick up where it left off."
      : ending.kind === "gateway-timeout"
        ? "The gateway ended the turn so it would not hang. Send a message to pick up where it left off."
        : ending.kind === "failed"
          ? ending.reason
          : null;
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
  // A stop at the turn limit stops the other bots' runs it started too, as Stop does (F-296).
  const also =
    ending.kind === "turn-limit" ? stoppedWithLines(run, (key) => botOfSession(bots, key)) : [];
  const retry = retryPlan(run, transcript);
  // What Try again sends, when there is one.
  const resend = retry?.kind === "again" || retry?.kind === "text" ? retry : null;
  const requestId = run.requestId ?? null;
  const raw = run.error?.raw;
  const showRaw = (open: boolean) => {
    setRawOpen(open);
    // Read when it is opened, as a step's raw is; it is not in the state.
    if (open && raw && !rawRead)
      void bridge.invoke({ type: "readRunRaw", key: taskKey, runId: run.id }).then(
        (read) => setRawRead(read ?? { status: "not-kept", holds: null }),
        () => setRawRead({ status: "not-kept", holds: raw.holds }),
      );
  };
  const copyRequest = async () => {
    if (!requestId) return;
    if ((await copyText(requestId)) === "copied") announce("Copied request ID");
    else {
      // The clipboard refused: the id is shown in Raw and selected for a manual copy.
      showRaw(true);
      requestAnimationFrame(() => {
        if (requestRef.current) selectContents(requestRef.current);
      });
      announce("Couldn't copy. The text is selected.");
    }
  };
  return (
    <div
      className="card turn-error"
      role="alert"
      data-testid="turn-error"
      data-run={run.id}
      {...(notRun
        ? {
            "data-not-run": ending.kind === "not-run" ? (ending.cause?.kind ?? "unsaid") : "silent",
          }
        : {})}
    >
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
      {ending.kind === "turn-limit" && (run.omittedTools ?? 0) > 0 && (
        <p className="turn-error-reason">
          Some actions are no longer shown. Other bots' work may continue.
        </p>
      )}
      {also.length > 0 && (
        <ul className="turn-note-list turn-error-reason" data-testid="stopped-with">
          {also.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {retryError && (
        <p className="turn-error-reason" data-testid="retry-error">
          Couldn't send it again: {retryError}
        </p>
      )}
      {retry?.kind === "files-gone" && (
        <p className="turn-error-reason" data-testid="retry-files-gone">
          This message had files, and this device no longer holds them. To try again, send it again
          with its files.
        </p>
      )}
      {retry?.kind === "files-unknown" && (
        <p className="turn-error-reason" data-testid="retry-files-unknown">
          This device can't tell whether this message had files. To try again, send it again with
          any files it had.
        </p>
      )}
      {(retry?.kind === "words-cut" ||
        ((retry?.kind === "files-gone" || retry?.kind === "files-unknown") && retry.wordsCut)) && (
        <p className="turn-error-reason" data-testid="retry-words-cut">
          This message is too long to send again from here. To try again, send it again in full.
        </p>
      )}
      {(resend || requestId || raw || (notRun?.ways.length ?? 0) > 0) && (
        <div className="turn-error-actions">
          {notRun?.ways.map((way) => (
            <button
              key={way}
              type="button"
              className="button"
              data-size="sm"
              onClick={() => requestBotSettings(bot.id, way)}
            >
              {way === "model" ? "Change model" : "Change account"}
            </button>
          ))}
          {resend && (
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() => {
                setRetryError(null);
                // The engine still holds the message: its words and files go again together.
                // Otherwise only history has it, and it was words alone (`retryPlan`). A reply
                // goes again as a reply to the same message.
                const again =
                  resend.kind === "again"
                    ? bridge.invoke({
                        type: "sendAgain",
                        key: taskKey,
                        messageId: resend.messageId,
                      })
                    : bridge.invoke({
                        type: "sendMessage",
                        key: taskKey,
                        text: resend.text,
                        mode: "auto",
                        attachmentIds: [],
                        ...(resend.replyToId ? { replyToId: resend.replyToId } : {}),
                      });
                void again.catch((error: unknown) =>
                  setRetryError(error instanceof Error ? error.message : String(error)),
                );
              }}
            >
              Try again
            </button>
          )}
          {requestId && (
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="quiet"
              onClick={() => void copyRequest()}
            >
              Copy request ID
            </button>
          )}
          {(requestId || raw) && (
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="quiet"
              aria-expanded={rawOpen}
              onClick={() => showRaw(!rawOpen)}
            >
              Raw
            </button>
          )}
        </div>
      )}
      {rawOpen && (
        <div className="raw-panel turn-error-raw" data-testid="turn-error-raw">
          {requestId && (
            <>
              <p className="code-label">Request ID</p>
              <pre className="code-block" ref={requestRef} data-testid="request-id" tabIndex={0}>
                {requestId}
              </pre>
            </>
          )}
          <RunRawView read={raw ? rawRead : { status: "not-kept", holds: null }} />
        </div>
      )}
    </div>
  );
}

/** What a failed run's Raw holds, in words: exactly that, and as received. */
const RAW_HOLDS: Record<RunErrorRaw["holds"], string> = {
  "chat-event": "The chat event that ended the turn, as received",
  "lifecycle-data": "The data of the agent lifecycle event that ended the turn, as received",
  "send-answer": "The gateway's answer to the send that started the turn, as received",
};

/** A failed run's Raw, once read (F-301): what it holds, or why it is not here. */
function RunRawView({ read }: { read: RunRawRead | null }) {
  if (!read) return <p className="raw-state">Reading…</p>;
  if (read.status === "available")
    return (
      <>
        <p className="code-label">{RAW_HOLDS[read.holds]}</p>
        <pre className="code-block" tabIndex={0} data-testid="run-raw">
          {JSON.stringify(read.payload, null, 2)}
        </pre>
      </>
    );
  if (read.status === "too-large")
    return (
      <p className="raw-state" data-testid="run-raw-state">
        {RAW_HOLDS[read.holds]} was too large to keep here: {read.chars.toLocaleString("en-US")}{" "}
        characters, past the {read.limit.toLocaleString("en-US")} Clawtrate keeps.
      </p>
    );
  return (
    <p className="raw-state" data-testid="run-raw-state">
      {read.holds
        ? `${RAW_HOLDS[read.holds]} is no longer kept here.`
        : "Clawtrate kept nothing the gateway sent for this failure."}
    </p>
  );
}
