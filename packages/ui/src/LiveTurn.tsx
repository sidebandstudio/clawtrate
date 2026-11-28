// The parts of a turn that the engine holds before history does: your
// messages until the gateway's history has them, the run's streaming reply,
// and how a run ended (conversation.md, sections 6, 16 and 17). A run's
// actions are the action cards' (./actions); its approvals, questions and
// messages between bots are the cards' own (./cards).

import {
  gatewayStamp,
  type ComputerUseChange,
  notRunRetryKey,
  notRunRetryRecorded,
  retryPlan,
  isTerminal,
  repeatedNotRun,
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
  for (const key of also.followUps)
    lines.push(
      `Then stopped: the turn the gateway started here on its own once ${nameOf(key)}'s run was stopped.`,
    );
  if (also.omitted > 0)
    lines.push(
      `${also.omitted} more ${also.omitted === 1 ? "run was" : "runs were"} asked to stop, not listed here.`,
    );
  return lines;
}

export { messageReplyOf, messageTextOf, retryPlan, type RetryPlan } from "@clawtrate/core";

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
  const { bots, connection, computerUseUndo } = useClawtrateState();
  const [dismissed, setDismissed] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [computerUseResult, setComputerUseResult] = useState<ComputerUseChange | null>(null);
  const [changingComputerUse, setChangingComputerUse] = useState(false);
  const [undoClock, setUndoClock] = useState(Date.now);
  const undoExpiresAt =
    computerUseUndo?.taskKey === taskKey && computerUseUndo.runId === run.id
      ? computerUseUndo.expiresAt
      : null;
  useEffect(() => {
    if (undoExpiresAt === null) return;
    const timer = setTimeout(() => setUndoClock(Date.now()), undoExpiresAt - Date.now());
    return () => clearTimeout(timer);
  }, [undoExpiresAt]);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawRead, setRawRead] = useState<RunRawRead | null>(null);
  const requestRef = useRef<HTMLPreElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const recoveryRef = useRef<HTMLButtonElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const repairHadFocus = useRef(false);
  useEffect(() => {
    if (!repairHadFocus.current || !computerUseResult || changingComputerUse) return;
    repairHadFocus.current = false;
    if (computerUseResult === "off" || computerUseResult === "already-off")
      (retryRef.current ?? undoRef.current)?.focus();
    else (recoveryRef.current ?? undoRef.current ?? retryRef.current)?.focus();
  }, [computerUseResult, changingComputerUse]);
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
          ) : ending.followUp ? (
            <p>
              <b>{ending.after ? `Stopped after ${ending.after}.` : "Stopped."}</b> The gateway
              started this turn on its own after your Stop of the one before, so Clawtrate stopped
              it too. Completed actions are not undone.
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
  const repeated =
    ending.kind === "not-run" && repeatedNotRun(run, transcript.runs, transcript.items);
  const cause = ending.kind === "not-run" ? ending.cause : null;
  const details = cause?.words;
  const computerUse = cause?.kind === "computer-use-timeout";
  const canAdmin =
    connection?.status === "connected" && connection.canAdmin && !bridge.info?.readOnly;
  const canAsk =
    connection?.status === "connected" && !connection.fullPairing && !bridge.info?.readOnly;
  const undo = undoExpiresAt !== null && undoExpiresAt > undoClock;
  const readback =
    !computerUseResult || computerUseResult === "unconfirmed"
      ? (run.computerUseReadback ?? computerUseResult)
      : computerUseResult;
  const computerUseOff =
    !run.retryGatewayChanged && (undoExpiresAt !== null || readback === "already-off");
  const repair = computerUse && repeated && !computerUseOff && !run.retryGatewayChanged;
  const changeComputerUse = (restore: boolean) => {
    repairHadFocus.current =
      document.activeElement === (restore ? undoRef.current : recoveryRef.current);
    setChangingComputerUse(true);
    setComputerUseResult(null);
    void bridge
      .invoke({
        type: "changeNotRunComputerUse",
        key: taskKey,
        runId: run.id,
        restore,
        stamp: gatewayStamp(connection),
      })
      .then(setComputerUseResult, () => setComputerUseResult("not-sent"))
      .finally(() => setChangingComputerUse(false));
  };
  // The app's own limit and the gateway's are worded apart: each says who ended the turn.
  const title = notRun
    ? notRun.title
    : ending.kind === "turn-limit"
      ? `${bot.name}'s turn reached its ${ending.minutes} minute limit`
      : ending.kind === "gateway-timeout"
        ? `${bot.name}'s turn reached the gateway's time limit`
        : failedTurnTitle(bot.name, earlier);
  const retry = retryPlan(run, transcript);
  const retryId = notRun ? notRunRetryKey(taskKey, run.id) : null;
  const retried = retryId ? transcript.outbox.find((message) => message.id === retryId) : undefined;
  const retryRecorded = !retried && retryId !== null && notRunRetryRecorded(transcript, retryId);
  // What Try again sends, when there is one.
  const resend =
    !retryRecorded &&
    (retry?.kind === "again" || retry?.kind === "retained" || retry?.kind === "text")
      ? retry
      : null;
  const retryInFlight =
    retrying ||
    (retried !== undefined &&
      !["failed", "unknown", "not-sent", "cancelled"].includes(retried.status));
  const reason = notRun
    ? cause?.kind === "other" && (repeated || !resend) && !run.retryGatewayChanged
      ? "Choose another model for this bot."
      : notRun.reason
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
  const ways = run.retryGatewayChanged ? [] : (notRun?.ways ?? []);
  const tryFirst = !repeated && (cause?.kind === "other" || cause?.kind === "computer-use-timeout");
  const wayButton = (way: (typeof ways)[number]) => (
    <button
      key={way}
      type="button"
      className="button"
      data-size="sm"
      onClick={() => requestBotSettings(bot.id, way)}
    >
      {way === "model" ? "Change model" : "Change account"}
    </button>
  );
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
        onClick={() => {
          toggle(true);
          if (notRun && (retry?.kind === "retained" || retry?.kind === "again"))
            void bridge.send({ type: "dismissNotRun", key: taskKey, runId: run.id });
        }}
      >
        <CloseIcon />
      </button>
      <p className="turn-error-reason">{reason}</p>
      {repeated && !computerUseOff && (
        <p className="turn-error-reason">
          This happened on the previous attempt too. Sending again is unlikely to help.
        </p>
      )}
      {computerUse && !repeated && (
        <p className="turn-error-reason">This sometimes clears by itself.</p>
      )}
      {repair && (
        <p className="turn-error-reason">
          {canAdmin
            ? "This skips the Computer Use check at startup and automatic installation. Native tools set up separately can still work."
            : "Turning off Computer Use needs full control of the gateway."}
        </p>
      )}
      {computerUse && computerUseOff && (
        <p className="turn-error-reason" role="status">
          The Computer Use startup check is off on this gateway.
        </p>
      )}
      {computerUse &&
        !run.retryGatewayChanged &&
        !computerUseOff &&
        readback &&
        COMPUTER_USE_RESULT[readback] && (
          <p className="turn-error-reason" role="status">
            {COMPUTER_USE_RESULT[readback]}
          </p>
        )}
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
      {notRun && run.retryGatewayChanged && (
        <p className="turn-error-reason">
          {run.retryFiles === "gone"
            ? "This message went to a different gateway. Its files are no longer available to retry."
            : "This message went to a different gateway, so it can't be retried here."}
        </p>
      )}
      {run.computerUseGatewayChanged && (
        <p className="turn-error-reason">
          The Computer Use setting belongs to the previous gateway.
        </p>
      )}
      {retry?.kind === "files-gone" && (
        <p className="turn-error-reason" data-testid="retry-files-gone">
          This device can no longer resend the files. To try again, attach them to a new message.
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
          The full text of this message isn't available here. To try again, send it again in full.
        </p>
      )}
      {(resend || requestId || raw || details || ways.length > 0 || repair || undo) && (
        <div className="turn-error-actions">
          {repair && canAdmin && (
            <button
              ref={recoveryRef}
              type="button"
              className="button turn-error-recovery"
              data-size="sm"
              disabled={changingComputerUse}
              onClick={() => changeComputerUse(false)}
            >
              Turn off Computer Use on this gateway
            </button>
          )}
          {repair && !canAdmin && canAsk && (
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() =>
                void bridge.send({ type: "requestAccess", tier: "admin" }).catch(() => {})
              }
            >
              Request admin access
            </button>
          )}
          {!tryFirst && (repeated ? ways.slice(0, 1) : ways).map(wayButton)}
          {resend && (
            <button
              ref={retryRef}
              type="button"
              className="button"
              data-size="sm"
              disabled={
                changingComputerUse ||
                retryInFlight ||
                (Boolean(notRun) && (connection?.status !== "connected" || !connection.gatewayId))
              }
              onClick={() => {
                setRetryError(null);
                setRetrying(true);
                const again = notRun
                  ? bridge.invoke({
                      type: "retryNotRun",
                      key: taskKey,
                      runId: run.id,
                      stamp: gatewayStamp(connection),
                    })
                  : resend.kind === "again"
                    ? bridge.invoke({
                        type: "sendAgain",
                        key: taskKey,
                        messageId: resend.messageId,
                      })
                    : resend.kind === "retained"
                      ? bridge.invoke({ type: "retryNotRun", key: taskKey, runId: resend.runId })
                      : bridge.invoke({
                          type: "sendMessage",
                          key: taskKey,
                          text: resend.text,
                          mode: "auto",
                          attachmentIds: [],
                          ...(resend.replyToId ? { replyToId: resend.replyToId } : {}),
                        });
                void again
                  .catch((error: unknown) =>
                    setRetryError(error instanceof Error ? error.message : String(error)),
                  )
                  .finally(() => setRetrying(false));
              }}
            >
              Try again
            </button>
          )}
          {(tryFirst ? ways : repeated ? ways.slice(1) : []).map(wayButton)}
          {undo && canAdmin && (
            <button
              ref={undoRef}
              type="button"
              className="button"
              data-size="sm"
              disabled={changingComputerUse}
              onClick={() => changeComputerUse(true)}
            >
              Put back
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
          {(requestId || raw || details) && (
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="quiet"
              aria-expanded={rawOpen}
              onClick={() => showRaw(!rawOpen)}
            >
              {details ? "Details" : "Raw"}
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
          {details && <p className="code-block">{details}</p>}
          {(raw || !details) && (
            <RunRawView read={raw ? rawRead : { status: "not-kept", holds: null }} />
          )}
        </div>
      )}
    </div>
  );
}

const COMPUTER_USE_RESULT: Partial<Record<ComputerUseChange, string>> = {
  restored: "The previous Computer Use setting is back.",
  changed: "The gateway settings changed since this card last read them.",
  refused: "The gateway refused the Computer Use change.",
  unconfirmed: "Clawtrate couldn't confirm whether the Computer Use setting changed.",
  "not-sent": "Clawtrate couldn't send the Computer Use change.",
};

/** What a failed run's Raw holds, after credential scrubbing. */
const RAW_HOLDS: Record<RunErrorRaw["holds"], string> = {
  "chat-event": "The chat event that ended the turn",
  "lifecycle-data": "The data of the agent lifecycle event that ended the turn",
  "send-answer": "The gateway's answer to the send that started the turn",
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
