// The Messaged cards (conversation.md sections 10 and 11): one card for each
// message a bot sends to another bot or to T3 Code, drawn only from the bot's
// own tool events as the engine reads them. No state claims more than an
// event established, and the app makes no connection to T3 Code.

import type {
  Bot,
  BotMessageCard,
  InterSessionMessage,
  McpCallCard,
  Run,
  StepRaw,
} from "@clawtrate/core";
import { useState, type ReactNode } from "react";
import { Avatar } from "../Avatar.tsx";
import { useCardEnv } from "./context.tsx";
import {
  botMessageKey,
  botMessageNote,
  firstLineOf,
  LIVE_STATES,
  mcpKey,
  mcpNote,
  MESSAGED_STATES,
  nameOf,
  recipientName,
  resultLink,
  sentText,
  sentVerb,
  targetChips,
  type MessagedKey,
} from "./model.ts";
import { cardDomId } from "./placement.ts";
import {
  AgentMark,
  CardFoot,
  ChevronIcon,
  CodeBlock,
  ExternalIcon,
  FileIcon,
  Glyph,
  timeOf,
  tookOf,
  useRawDisclosure,
  type RawContent,
} from "./parts.tsx";
import type { StepRawState } from "./useCards.ts";

/** A bot for an avatar: the listed one, or one drawn from its id. */
function botFor(bots: Bot[], id: string | null, name: string): Bot {
  return (
    bots.find((bot) => bot.id === id) ?? {
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

function clock(at: number | null): string {
  return at === null
    ? ""
    : new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** The state word with its mark; "Last seen …" for live work while the connection is lost. */
function StateWord({ state, lost }: { state: MessagedKey; lost: boolean }) {
  const [mark, word, tone] = MESSAGED_STATES[state];
  const text = lost && LIVE_STATES.has(state) ? `Last seen ${word.toLowerCase()}` : word;
  return (
    <span className="state" data-state={state} data-tone={tone ?? undefined}>
      <Glyph state={mark} />
      {text}
    </span>
  );
}

function callArgs(raw: StepRaw | null): unknown {
  const call = raw?.call as Record<string, unknown> | null | undefined;
  const value = call?.args ?? call?.arguments ?? call?.input;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function resultOf(raw: StepRaw | null): unknown {
  const result = raw?.result as Record<string, unknown> | null | undefined;
  if (!result) return undefined;
  return result.result ?? result;
}

/** Raw for a call card: the call's tool, arguments and result as the gateway sent them. */
function callRaw(
  read: StepRawState,
  step: { toolName: string | null; startedAt: number | null; endedAt: number | null },
  ids: Array<{ label: string; value: string | null }>,
  error: string | null,
  running: boolean,
  truncated: boolean,
): RawContent {
  if (read.state !== "available") return read.content;
  const raw = read.raw;
  return {
    state: "loaded",
    ...(read.cut ? { notes: [read.cut] } : {}),
    tool: step.toolName,
    args: callArgs(raw) ?? null,
    result: resultOf(raw),
    error,
    running,
    truncated: truncated || read.cut !== undefined,
    timing: [
      { label: "Started", value: timeOf(step.startedAt) },
      { label: "Ended", value: timeOf(running ? null : step.endedAt) },
      { label: "Took", value: running ? "not reported" : tookOf(step.startedAt, step.endedAt) },
    ],
    ids: ids.flatMap((id) => (id.value ? [{ label: id.label, value: id.value }] : [])),
  };
}

function SentItem({
  sender,
  verb,
  at,
  text,
  chips,
}: {
  sender: Bot;
  /** "sent" only where an event established the message went; otherwise what the bot did. */
  verb: string;
  at: number | null;
  text: string | null;
  chips?: ReactNode;
}) {
  return (
    <li className="exchange-item">
      <Avatar bot={sender} />
      <div>
        <div className="exchange-meta">
          <b>{sender.name}</b>
          <span>{verb}</span>
          {at !== null && <time>{clock(at)}</time>}
        </div>
        {text !== null ? (
          <div className="exchange-text">{text}</div>
        ) : (
          <p className="exchange-note">The gateway's record of this call has no message text.</p>
        )}
        {chips}
      </div>
    </li>
  );
}

function NoteItem({ lead, who, children }: { lead: ReactNode; who: string; children: ReactNode }) {
  return (
    <li className="exchange-item">
      {lead}
      <div>
        <div className="exchange-meta">
          <b>{who}</b>
        </div>
        {children}
      </div>
    </li>
  );
}

/** The recipient's live phrase, where this viewer holds its task: its running step's title. */
function recipientPhrase(
  transcripts: Record<string, { runs: Run[] }>,
  sessionKey: string | null,
  runId: string | null,
): string | null {
  if (!sessionKey || !runId) return null;
  const run = transcripts[sessionKey]?.runs.find((each) => each.id === runId);
  if (!run) return null;
  const step = [...run.steps].reverse().find((each) => each.status === "running");
  return step?.title ?? "Thinking";
}

// "Messaged <bot>" -----------------------------------------------------------------

export function BotMessageCardView({
  card,
  read,
  related,
}: {
  card: BotMessageCard;
  read: StepRawState;
  /** Every message between the two bots in this task, oldest first, for "Show full exchange". */
  related: Array<{ id: string; who: Bot; verb: string; text: string; at: number | null }>;
}) {
  const env = useCardEnv();
  const raw = useRawDisclosure(read.load);
  const [full, setFull] = useState(false);
  const run = env.runOf(card.runId);
  const step = run?.steps.find((each) => each.id === card.stepId);
  const key = botMessageKey(card);
  const recipient = recipientName(card, env.bots);
  const recipientBot = botFor(env.bots, recipient.id, recipient.name);
  const sender = env.bot ?? botFor(env.bots, null, "The bot");
  const lost = env.connection.status !== "connected";
  const [, word] = MESSAGED_STATES[key];
  const first = firstLineOf(card.text);
  const domId = cardDomId({ kind: "bot-message", id: card.id });
  const names = { sender: sender.name, recipient: recipient.name };

  let cameBack: ReactNode;
  if (key === "working") {
    const phrase = recipientPhrase(env.transcripts, card.recipient.sessionKey, card.recipientRunId);
    cameBack = (
      <li className="exchange-item" data-testid="recipient-live">
        <span className="exchange-presence">
          <Avatar bot={recipientBot} />
          <Glyph state="working" />
        </span>
        <div>
          <div className="exchange-meta exchange-live">
            <b>{recipient.name}</b>
            <span>
              · {lost ? `Last seen ${(phrase ?? "working").toLowerCase()}` : (phrase ?? "Working")}
            </span>
          </div>
        </div>
      </li>
    );
  } else if (key === "replied" && card.reply) {
    cameBack = (
      <li className="exchange-item">
        <Avatar bot={recipientBot} />
        <div>
          <div className="exchange-meta">
            <b>{recipient.name}</b>
            <span>replied</span>
            {card.resultAt !== null && <time>{clock(card.resultAt)}</time>}
          </div>
          <div className="exchange-text">{card.reply.text}</div>
        </div>
      </li>
    );
  } else {
    cameBack = (
      <NoteItem lead={<Avatar bot={recipientBot} />} who={recipient.name}>
        <p className="exchange-note">
          {botMessageNote(key, card, names, env.transcript.approvals, run)}
        </p>
        {(key === "failed" || key === "recipient-failed") && card.error && (
          <CodeBlock label="Error" text={card.error} copy="error" tone="danger" />
        )}
      </NoteItem>
    );
  }

  const canOpen =
    card.recipient.source === "result" &&
    card.recipient.sessionKey !== null &&
    recipient.id !== null &&
    env.openTask !== null;

  return (
    <details
      className="card messaged"
      data-target="bot"
      data-state={key}
      data-connection={lost ? "lost" : undefined}
      id={domId}
      data-testid="messaged-card"
    >
      <summary aria-label={`Messaged ${recipient.name}: ${first} ${word}.`} title={first}>
        <span className="messaged-verb">Messaged</span>
        <span className="messaged-who">
          <Avatar bot={recipientBot} />
          {recipient.name}
        </span>
        <span className="messaged-first">{first}</span>
        <StateWord state={key} lost={lost} />
        <ChevronIcon className="chevron" />
      </summary>
      <div className="messaged-body">
        {full ? (
          <ol
            className="exchange"
            aria-label={`Every message between ${sender.name} and ${recipient.name} in this task`}
          >
            {related.map((each) => (
              <li className="exchange-item" key={each.id}>
                <Avatar bot={each.who} />
                <div>
                  <div className="exchange-meta">
                    <b>{each.who.name}</b>
                    <span>{each.verb}</span>
                    {each.at !== null && <time>{clock(each.at)}</time>}
                  </div>
                  <div className="exchange-text">{each.text}</div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <ol className="exchange">
            <SentItem sender={sender} verb={sentVerb(key)} at={card.requestedAt} text={card.text} />
            {cameBack}
          </ol>
        )}
        <CardFoot
          disclosure={raw}
          raw={callRaw(
            read,
            {
              toolName: step?.toolName ?? "sessions_send",
              startedAt: card.requestedAt,
              endedAt: card.endedAt,
            },
            [
              { label: "Tool call", value: card.toolCallId },
              { label: "Run", value: card.runId },
              { label: "Recipient session", value: card.recipient.sessionKey },
              { label: "Recipient run", value: card.recipientRunId },
              { label: "Approval", value: card.approvalId },
            ],
            step?.status === "failed" ? card.error : null,
            step ? step.status === "running" || step.status === "waiting" : false,
            step?.truncated ?? false,
          )}
        >
          {key === "approval" && card.approvalId && (
            <button
              type="button"
              className="link-button"
              aria-label="Show the approval for this message"
              onClick={() => focusCard(cardDomId({ kind: "approval", id: card.approvalId! }))}
            >
              Show the approval
            </button>
          )}
          {canOpen && (
            <button
              type="button"
              className="link-button"
              aria-label={`Open this message in ${recipient.name}'s task`}
              onClick={(event) => {
                rememberReturn(env.taskKey, env.bot?.id ?? null, domId, event.currentTarget);
                arriveAt(card.recipient.sessionKey!, card.recipientRunId);
                env.openTask!(recipient.id!, card.recipient.sessionKey!);
              }}
            >
              Open in {recipient.name}
            </button>
          )}
          {related.some((each) => each.id !== card.id && each.id !== `${card.id}:reply`) && (
            <button
              type="button"
              className="link-button"
              aria-expanded={full}
              aria-label={
                full
                  ? "Show only this message"
                  : `Show every message between ${sender.name} and ${recipient.name} in this task`
              }
              onClick={() => setFull((open) => !open)}
            >
              {full ? "Show only this message" : "Show full exchange"}
            </button>
          )}
        </CardFoot>
      </div>
    </details>
  );
}

// "Messaged T3 Code" ---------------------------------------------------------------

export function T3CodeCardView({ card, read }: { card: McpCallCard; read: StepRawState }) {
  const env = useCardEnv();
  const raw = useRawDisclosure(read.load);
  const run = env.runOf(card.runId);
  const step = run?.steps.find((each) => each.id === card.stepId);
  const key = mcpKey(card, env.transcript.approvals, step?.status === "waiting");
  const sender = env.bot ?? botFor(env.bots, null, "The bot");
  const lost = env.connection.status !== "connected";
  const [, word] = MESSAGED_STATES[key];
  const text = sentText(card);
  const first = firstLineOf(text);
  const chips = targetChips(card.args);
  const link = resultLink(card);
  const domId = cardDomId({ kind: "t3-code", id: card.id });

  const agent = (
    <span className="exchange-agent">
      <AgentMark />
    </span>
  );
  let cameBack: ReactNode;
  if (key === "call-made") {
    cameBack = (
      <li className="exchange-item">
        {agent}
        <div>
          <div className="exchange-meta">
            <b>T3 Code</b>
            <span>· the call returned</span>
            {card.resultAt !== null && <time>{clock(card.resultAt)}</time>}
          </div>
          {card.result && card.result.text.trim() !== "" ? (
            <div className="exchange-text">{card.result.text}</div>
          ) : (
            <p className="exchange-note">The call returned no text.</p>
          )}
          <p className="exchange-note">
            This shows the call was made. It does not show that the work is finished.
          </p>
          {card.workMayContinue && (
            <p className="exchange-continue">
              The call was made. Work handed to T3 Code may continue there.
            </p>
          )}
        </div>
      </li>
    );
  } else {
    cameBack = (
      <NoteItem lead={agent} who="T3 Code">
        <p className="exchange-note">
          {mcpNote(key, card, sender.name, env.transcript.approvals, run)}
        </p>
        {key === "failed" && card.error && (
          <CodeBlock label="Error" text={card.error} copy="error" tone="danger" />
        )}
      </NoteItem>
    );
  }

  return (
    <details
      className="card messaged"
      data-target="t3code"
      data-state={key}
      data-connection={lost ? "lost" : undefined}
      id={domId}
      data-testid="t3-card"
    >
      <summary aria-label={`Messaged T3 Code: ${first} ${word}.`} title={first}>
        <span className="messaged-verb">Messaged</span>
        <span className="messaged-who">
          <AgentMark />
          T3 Code
        </span>
        <span className="messaged-first">{first}</span>
        <StateWord state={key} lost={lost} />
        <ChevronIcon className="chevron" />
      </summary>
      <div className="messaged-body">
        <ol className="exchange">
          <SentItem
            sender={sender}
            verb={sentVerb(key)}
            at={card.requestedAt}
            text={text}
            chips={
              chips.length > 0 && (
                <div className="chips" aria-label="Where it was sent">
                  {chips.map((chip) => (
                    <span className="chip" key={chip.label}>
                      {chip.label} <span>{chip.value}</span>
                    </span>
                  ))}
                </div>
              )
            }
          />
          {cameBack}
        </ol>
        {card.files.length > 0 && (
          <div className="chips" aria-label="Files">
            {card.files.map((file, index) => (
              <span className="chip" key={index}>
                <FileIcon />
                {file.name ?? file.uri ?? file.mimeType ?? "A file"}
              </span>
            ))}
          </div>
        )}
        <CardFoot
          disclosure={raw}
          raw={callRaw(
            read,
            {
              toolName: step?.toolName ?? null,
              startedAt: card.requestedAt,
              endedAt: card.endedAt,
            },
            [
              { label: "Tool call", value: card.toolCallId },
              { label: "Run", value: card.runId },
              { label: "Approval", value: card.approvalId },
            ],
            step?.status === "failed" ? card.error : null,
            key === "call-started" || key === "approval",
            step?.truncated ?? false,
          )}
        >
          {link && (
            // Opened only when chosen: a plain link, nothing is fetched before that.
            <a
              className="link-button"
              href={link.uri}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open the T3 Code thread in your browser"
            >
              Open thread
              <ExternalIcon />
            </a>
          )}
        </CardFoot>
      </div>
    </details>
  );
}

// "Message from <bot>" --------------------------------------------------------------

/** The receiving side: the message that started a run here, with that run's state. */
export function ReceivedCardView({
  message,
  run,
}: {
  message: InterSessionMessage;
  run: Run | undefined;
}) {
  const env = useCardEnv();
  const raw = useRawDisclosure();
  const senderId = message.senderAgentId ?? agentOf(message.sourceSessionKey);
  const senderName = nameOf(env.bots, senderId, message.senderLabel ?? "another bot");
  const sender = botFor(env.bots, senderId, senderName);
  const me = env.bot?.name ?? "This bot";
  const state = receivedState(run);
  const [mark, word, tone] = RECEIVED_STATES[state];
  const first = firstLineOf(message.text);
  const lost = env.connection.status !== "connected";
  const pending =
    state === "waiting"
      ? [...env.transcript.approvals, ...env.transcript.questions].find(
          (card) => card.runId === run?.id && card.status === "pending",
        )
      : undefined;
  const pendingKind = pending && "kind" in pending ? "approval" : "question";

  return (
    <details
      className="card messaged"
      data-run-id={run?.id}
      data-target="from"
      data-state={state}
      data-connection={lost ? "lost" : undefined}
      data-testid="received-card"
      id={`received-${message.itemId.replace(/[^\w-]/g, "_")}`}
    >
      <summary aria-label={`Message from ${senderName}: ${first} ${word}.`} title={first}>
        <span className="messaged-verb">Message from</span>
        <span className="messaged-who">
          <Avatar bot={sender} />
          {senderName}
        </span>
        <span className="messaged-first">{first}</span>
        <span className="state" data-tone={tone ?? undefined}>
          <Glyph state={mark} />
          {lost && state === "working" ? "Last seen working" : word}
        </span>
        <ChevronIcon className="chevron" />
      </summary>
      <div className="messaged-body">
        <ol className="exchange">
          <SentItem sender={sender} verb="sent" at={message.timestamp} text={message.text} />
          {state !== "working" && (
            <NoteItem lead={env.bot ? <Avatar bot={env.bot} /> : <span />} who={me}>
              <p className="exchange-note">
                {state === "waiting"
                  ? pendingKind === "approval"
                    ? `${me} needs your approval below.`
                    : `${me} asked you a question below.`
                  : state === "completed"
                    ? "This run has finished."
                    : state === "failed"
                      ? `This run failed${run?.error?.message ? `: ${run.error.message}` : "."}`
                      : state === "stopped"
                        ? "This run was stopped before it replied."
                        : "How this run ended is not known."}
              </p>
            </NoteItem>
          )}
        </ol>
        <CardFoot disclosure={raw} raw={incomingRaw(message, run)}>
          {pending && (
            <button
              type="button"
              className="link-button"
              onClick={() =>
                focusCard(
                  cardDomId({
                    kind: pendingKind === "approval" ? "approval" : "question",
                    id: pending.id,
                  }),
                )
              }
            >
              {pendingKind === "approval" ? "Show the approval" : "Show the question"}
            </button>
          )}
          {message.sourceSessionKey && senderId && env.openTask && (
            <button
              type="button"
              className="link-button"
              aria-label={`Open this message in ${senderName}'s task`}
              onClick={() => {
                if (returnPoint?.taskKey !== message.sourceSessionKey) {
                  // Not arrived from there: open the sender's task at its end.
                  returnPoint = null;
                }
                if (!goBack(env.taskKey, env.openTask!)) {
                  env.openTask!(senderId, message.sourceSessionKey!);
                }
              }}
            >
              Open in {senderName}
            </button>
          )}
        </CardFoot>
      </div>
    </details>
  );
}

type ReceivedState = "working" | "waiting" | "completed" | "failed" | "stopped" | "unknown";

const RECEIVED_STATES: Record<
  ReceivedState,
  [string, string, "accent" | "warn" | "danger" | null]
> = {
  working: ["working", "Working", "accent"],
  waiting: ["waiting", "Waiting for you", "warn"],
  completed: ["check", "Completed", null],
  failed: ["failed", "Failed", "danger"],
  stopped: ["stopped", "Stopped", null],
  unknown: ["queued", "Unknown", null],
};

function receivedState(run: Run | undefined): ReceivedState {
  if (!run) return "unknown";
  if (
    !run.outcomeKnown &&
    (run.state === "completed" ||
      run.state === "failed" ||
      run.state === "stopped" ||
      run.state === "cancelled")
  ) {
    return "unknown";
  }
  switch (run.state) {
    case "queued":
    case "running":
    case "stopping":
      return "working";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
    case "cancelled":
      return "stopped";
  }
}

function agentOf(key: string | null): string | null {
  return key ? (/^agent:([^:]+):/.exec(key)?.[1] ?? null) : null;
}

/**
 * Raw for a message from another session. The engine keeps the message's text
 * and where it came from, not the history row itself, so Raw says so and shows
 * the identifiers it does keep; it invents no record.
 */
function incomingRaw(message: InterSessionMessage, run: Run | undefined): RawContent {
  return {
    state: "loaded",
    notes: [
      "This app does not keep the history row this message came from: only its text, shown above, and the identifiers below.",
    ],
    ids: [
      { label: "Message", value: message.itemId },
      ...(message.sourceSessionKey
        ? [{ label: "Sender session", value: message.sourceSessionKey }]
        : []),
      ...(message.sourceTool ? [{ label: "Sent with", value: message.sourceTool }] : []),
      ...(run ? [{ label: "Run", value: run.id }] : []),
    ],
  };
}

/** A message no card accounts for: a line that opens to the text and its Raw. */
export function IncomingLine({ message }: { message: InterSessionMessage }) {
  const env = useCardEnv();
  const raw = useRawDisclosure();
  const senderId = message.senderAgentId ?? agentOf(message.sourceSessionKey);
  const senderName = nameOf(env.bots, senderId, message.senderLabel ?? "another bot");
  return (
    <details className="event-details" data-testid="incoming-line">
      <summary className="event-line">
        Message from <Avatar bot={botFor(env.bots, senderId, senderName)} />
        <b>{senderName}</b>
        <ChevronIcon className="chevron" />
      </summary>
      <div className="card event-body">
        <div className="exchange-text">{message.text}</div>
        <CardFoot disclosure={raw} raw={incomingRaw(message, undefined)} />
      </div>
    </details>
  );
}

// Moving between cards and tasks ---------------------------------------------------

/** Bring a card into view, open, with focus on it. */
export function focusCard(domId: string): void {
  const element = document.getElementById(domId);
  if (!element) return;
  if (element instanceof HTMLDetailsElement) element.open = true;
  element.scrollIntoView({ block: "nearest" });
  const target =
    element instanceof HTMLDetailsElement
      ? element.querySelector<HTMLElement>(":scope > summary")
      : element;
  target?.focus({ preventScroll: true });
}

/** Where the reader was when "Open in <bot>" took them away, for coming back. */
let returnPoint: {
  taskKey: string;
  botId: string | null;
  domId: string;
  /** The transcript's scroll position when the reader left. */
  scrollTop: number | null;
} | null = null;

/** Where "Open in <bot>" goes: the receiving card of the run the send's result named. */
let arrival: { taskKey: string; runId: string | null } | null = null;

function arriveAt(taskKey: string, runId: string | null): void {
  arrival = { taskKey, runId };
}

/** The receiving card to open and focus when a task opens from "Open in <bot>", once. */
export function takeArrival(taskKey: string): string | null {
  if (arrival?.taskKey !== taskKey) return null;
  const { runId } = arrival;
  arrival = null;
  return runId;
}

function rememberReturn(taskKey: string, botId: string | null, domId: string, from: Element): void {
  const scroller = from.closest<HTMLElement>('[data-testid="transcript"]');
  returnPoint = { taskKey, botId, domId, scrollTop: scroller?.scrollTop ?? null };
}

/** ⌘[ and "Open in <sender>": back to where "Open in <bot>" was chosen, when that was elsewhere. */
export function goBack(fromTask: string, openTask: (botId: string, key: string) => void): boolean {
  if (!returnPoint?.botId || returnPoint.taskKey === fromTask) return false;
  openTask(returnPoint.botId, returnPoint.taskKey);
  return true;
}

/** The card to restore when a task opens again, once. */
export function takeReturnPoint(
  taskKey: string,
): { domId: string; scrollTop: number | null } | null {
  if (returnPoint?.taskKey !== taskKey) return null;
  const { domId, scrollTop } = returnPoint;
  returnPoint = null;
  return { domId, scrollTop };
}
