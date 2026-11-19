// The T3 Code thread card (docs/design/conversation.md, section 11): one card
// for each thread, at its first call in the task's record, listing every call
// that belongs to it, each with its own Raw; and what a call with a line of
// its own adds to that line. What each call is and where it goes is the
// engine's reading (`t3-code.ts`); this file only draws it and keeps what the
// reader opened, under the gateway's tool call ids, in the same view state as
// every action card (`view-state.ts`), so a call that changes from one to the
// other in place keeps its open state, its Raw and its focus.

import {
  actionWords,
  readDimensions,
  threadLink,
  threadTitle,
  readLines,
  statusWords,
  threadStateOf,
  workMayContinue,
  type T3Call,
  type T3Placement,
  type T3ThreadState,
  type Thought,
} from "@clawtrate/core";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Avatar } from "../Avatar.tsx";
import { AgentMark, CodeBlock, ExternalIcon, Glyph, RawView } from "../cards/parts.tsx";
import { useCardEnv } from "../cards/context.tsx";
import { ChevronIcon } from "../icons.tsx";
import { actionDomId, rawContentOf, ThoughtLine, useActionEnv } from "./ActionCards.tsx";
import { onSummaryClick, readView, useView, viewKeys, writeView } from "./view-state.ts";
import { markTranscriptNavigation } from "../reading-line.ts";

const W = actionWords.T3_WORDS;

/** A thread's calls as the task's record holds them: its card's call first. */
export type T3ThreadInfo = {
  key: string | null;
  head: T3Call;
  /** Every call on the thread, in order, open ones too: they count for its state. */
  calls: T3Call[];
};

/** What the task's feed decided about its T3 Code calls, for the cards and lines that draw them. */
export type T3Feed = {
  /** Threads by their card's call id. */
  threads: Map<string, T3ThreadInfo>;
  placements: Map<string, T3Placement>;
  /** The reasoning that led to a call that joined a card directly, by its call id. */
  thoughts: Map<string, Thought>;
};

export const T3FeedContext = createContext<T3Feed>({
  threads: new Map(),
  placements: new Map(),
  thoughts: new Map(),
});

const clock = (at: number | null) =>
  at === null
    ? null
    : new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// State words ------------------------------------------------------------------------

type Word = { glyph: string; word: string; tone?: "warn" | "danger" | "accent" };

const CALL_WORDS: Record<T3Call["state"], Word> = {
  started: { glyph: "sending", word: actionWords.STATE_WORDS.callStarted },
  waiting: { glyph: "waiting", word: actionWords.STATE_WORDS.waitingForApproval, tone: "warn" },
  made: { glyph: "check", word: actionWords.STATE_WORDS.callMade },
  unknown: { glyph: "queued", word: W.deliveryUnknown },
  failed: { glyph: "failed", word: actionWords.STATE_WORDS.failed, tone: "danger" },
  "not-sent": { glyph: "stopped", word: W.notSent },
};

const STATUS_GLYPHS: Record<string, Word["glyph"]> = {
  preparing: "working",
  queued: "working",
  starting: "working",
  running: "working",
  waiting: "waiting",
  completed: "check",
  interrupted: "stopped",
  failed: "failed",
  cancelled: "stopped",
  rolled_back: "stopped",
  idle: "check",
  interrupt_requested: "queued",
  no_active_run: "check",
};

/** The thread's word at the right of its card (11.2). */
export function threadWord(state: T3ThreadState | null, lost: boolean): Word {
  if (!state) return CALL_WORDS.started;
  if (state.type === "open") {
    if (state.word === "waiting") return CALL_WORDS.waiting;
    if (lost) return { glyph: "sending", word: actionWords.STATE_WORDS.lastSeenCallStarted };
    return state.word === "checking" ? { glyph: "sending", word: W.checking } : CALL_WORDS.started;
  }
  if (state.type === "call") return CALL_WORDS[state.state];
  const glyph = STATUS_GLYPHS[state.status] ?? "check";
  return {
    glyph,
    word: statusWords(state.status),
    ...(state.status === "failed"
      ? { tone: "danger" as const }
      : state.status === "waiting"
        ? { tone: "warn" as const }
        : state.status === "running"
          ? { tone: "accent" as const }
          : {}),
  };
}

function StateWord({ word }: { word: Word }) {
  return (
    <span className="state" data-tone={word.tone}>
      <Glyph state={word.glyph} />
      {word.word}
    </span>
  );
}

// One call's item ---------------------------------------------------------------------

/** Target fields a launch's arguments carry, as chips: only those present (11.3). */
function chips(call: T3Call): Array<{ label: string; value: string }> {
  if (call.role !== "launch") return [];
  const a = call.call.args;
  const out: Array<{ label: string; value: string }> = [];
  const put = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push({ label, value });
  };
  put("Project", a.projectId);
  put("Title", a.title);
  const selection = a.modelSelection as Record<string, unknown> | undefined;
  put("Model", selection?.model);
  const strategy = a.workspaceStrategy as Record<string, unknown> | undefined;
  put("Branch", strategy?.branch);
  return out;
}

/** What came back for one call, as its result established it (11.3). */
function CameBack({ call }: { call: T3Call }) {
  const f = call.facts;
  const lines: ReactNode[] = [];
  const say = (text: string, tone?: string) =>
    lines.push(
      <p className="exchange-note" data-tone={tone} key={lines.length}>
        {text}
      </p>,
    );
  if (call.state === "made" && call.unread) {
    // Nothing that named its thread is left: say what is not known, not what it might have said.
    say(
      readLines(readDimensions(null, call.call.cut === true))[0] ??
        "This result could not be read here.",
    );
    return <>{lines}</>;
  }
  if (call.state !== "made") {
    if (call.state === "failed") {
      say("The call failed.");
      const text = [call.error?.code, call.error?.message].filter(Boolean).join(": ");
      return (
        <>
          {lines}
          <CodeBlock
            label="Error"
            text={text || call.call.text || "No error text was received."}
            copy="error"
            tone="danger"
          />
        </>
      );
    }
    if (call.state === "unknown") say("No result establishes whether T3 Code received this call.");
    if (call.state === "not-sent") say("This call was not made. Nothing was sent.");
    if (call.state === "started")
      say(
        "Nothing yet shows that the call was made, and nothing more is reported until it returns.",
      );
    if (call.state === "waiting") say("This call waits for your approval. Nothing has been sent.");
    return <>{lines}</>;
  }
  const status = f?.status ? statusWords(f.status) : null;
  switch (call.role) {
    case "launch":
      say(f?.threadId ? `T3 Code made the thread ${f.threadId}.` : "T3 Code made the thread.");
      if (status) say(`Its first run: ${status}.`);
      else say("No first run: the thread waits for a message.");
      break;
    case "send":
      if (f?.delivery) say(W.delivery[f.delivery] ?? f.delivery);
      if (status) say(`The run: ${status}.`);
      break;
    case "read": {
      if (status) say(`The thread: ${status}.`);
      for (const line of readLines(readDimensions(f, call.call.cut === true))) say(line, "strong");
      if (f?.reply)
        lines.push(
          <div className="exchange-text" key="reply">
            {f.reply}
            {f.replyShort ? "…" : ""}
          </div>,
        );
      else if (f?.read) say(W.noReplyOnPage);
      if (f?.replyShort) say("Only the start is shown here; Raw has what the gateway sent.");
      break;
    }
    case "wait":
      if (status) say(`The run: ${status}.`);
      if (f?.timedOut) say(W.waitEndedFirst, "strong");
      if (f?.resultRun?.runId) say(W.resultRun(f.resultRun.runId));
      break;
    case "interrupt":
      if (status)
        say(
          status === "Stop requested"
            ? "A stop was asked for. That is not proof that T3 Code stopped."
            : `The run: ${status}.`,
        );
      break;
    case "listing":
      break;
  }
  // A result that reports no final status shows the call was made, not that the work is done.
  const final =
    f?.status &&
    ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(f.status);
  if (!final) say(W.notFinished);
  return <>{lines}</>;
}

/** What one call sent and what came back: an item of a thread card, or an own line's readable view. */
export function T3CallBody({ call }: { call: T3Call }) {
  const env = useCardEnv();
  const sender = env.bot?.name ?? "The bot";
  // What was sent as the engine kept it; marked where it was shortened here.
  const sent =
    call.role === "launch" || call.role === "send" ? (call.sent ?? undefined) : undefined;
  const c = chips(call);
  return (
    <ol className="exchange">
      {(sent || c.length > 0) && (
        <li className="exchange-item">
          {env.bot ? <Avatar bot={env.bot} /> : <span aria-hidden="true" />}
          <div>
            <div className="exchange-meta">
              <b>{sender}</b>
              <span>{call.state === "made" ? "sent" : "asked to send"}</span>
              {call.call.startedAt !== null && <time>{clock(call.call.startedAt)}</time>}
            </div>
            {sent && (
              <div className="exchange-text">
                {sent}
                {call.sentShort ? "…" : ""}
              </div>
            )}
            {sent && call.sentShort && <p className="exchange-note">{W.shortened}</p>}
            {c.length > 0 && (
              <div className="chips" aria-label="Where it was sent">
                {c.map((chip) => (
                  <span className="chip" key={chip.label}>
                    {chip.label} <span>{chip.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </li>
      )}
      <li className="exchange-item">
        <span className="exchange-agent">
          <AgentMark />
        </span>
        <div>
          <div className="exchange-meta">
            <b>T3 Code</b>
            {call.state === "made" && call.call.endedAt !== null && (
              <time>{clock(call.call.endedAt)}</time>
            )}
          </div>
          <CameBack call={call} />
        </div>
      </li>
    </ol>
  );
}

/** The Raw of one call, behind "Raw for this call" (11.3): section 9's one panel. */
function ItemRaw({ call }: { call: T3Call }) {
  const env = useActionEnv();
  const [view, setView] = useView<string>(env.taskKey, viewKeys.view(call.id), "readable");
  const open = view === "raw";
  const raw = rawContentOf(call.call, env);
  useEffect(() => {
    if (open) raw.load();
    // Read once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const id = `${actionDomId(call.id)}-item-raw`;
  return (
    <>
      <button
        type="button"
        className="link-button"
        data-tone="muted"
        data-view-button="raw"
        aria-expanded={open}
        aria-controls={id}
        aria-label="Raw for this call"
        onClick={() => setView(open ? "readable" : "raw")}
      >
        Raw
      </button>
      {open && (
        <div
          className="raw-panel"
          id={id}
          role="region"
          aria-label="What the gateway sent"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setView("readable");
            document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id)}"]`)?.focus();
          }}
        >
          <RawView raw={raw.content} />
        </div>
      )}
    </>
  );
}

function Item({ call, line, thought }: { call: T3Call; line: boolean; thought: Thought | null }) {
  const env = useActionEnv();
  const card = useCardEnv();
  const [open, setOpen] = useView<boolean>(env.taskKey, viewKeys.item(call.id), true);
  const sender = card.bot?.name ?? "The bot";
  // A call that was made says what was done; any other, what was tried.
  const heads = call.state === "made" ? W.itemHead : W.itemTried;
  const head = (heads[call.tool] ?? ((bot: string) => `${bot} called T3 Code`))(sender);
  const word = CALL_WORDS[call.state];
  const at = clock(call.call.startedAt);
  return (
    <li className="t3-item-row">
      <details
        className="t3-item"
        data-item-call={call.id}
        data-state={call.state}
        open={open}
        onClick={onSummaryClick(env.taskKey, viewKeys.item(call.id))}
        onToggle={(event) => {
          if (event.currentTarget.open !== open) setOpen(event.currentTarget.open);
        }}
      >
        <summary aria-label={`${head}${at ? `, ${at}` : ""}, ${word.word.toLowerCase()}`}>
          <span className="t3-item-head">{head}</span>
          {at && <time>{at}</time>}
          <StateWord word={word} />
          <ChevronIcon className="chevron" />
        </summary>
        <div className="t3-item-body">
          {thought && (
            <div className="action-thought">
              <ThoughtLine thought={thought} place="card" revision={0} />
            </div>
          )}
          <T3CallBody call={call} />
          <div className="card-actions">
            {line && (
              <button
                type="button"
                className="link-button"
                aria-label="Show this call where it happened"
                onClick={() => showWhereItHappened(call.id)}
              >
                Show where it happened
              </button>
            )}
            <span className="spacer" />
            <ItemRaw call={call} />
          </div>
        </div>
      </details>
    </li>
  );
}

// The card ---------------------------------------------------------------------------

/**
 * One card for one thread (11.2, 11.3), keyed by its first call's tool call
 * id, so a call that becomes this card in place keeps its open state there.
 * A call with no known thread is a card of its own, in the same form.
 */
export function T3ThreadCard({ headId, thought }: { headId: string; thought: ReactNode }) {
  const env = useActionEnv();
  const card = useCardEnv();
  const feed = useContext(T3FeedContext);
  const info = feed.threads.get(headId);
  const [open, setOpen] = useView<boolean>(env.taskKey, viewKeys.call(headId), false);
  if (!info) return null;
  const lost = card.connection.status !== "connected";
  // Every call that joined: the card's own, those that joined directly, and lines once returned.
  const items = info.calls.filter(
    (c) => c.id === headId || (c.state !== "started" && c.state !== "waiting"),
  );
  const state = threadStateOf(info.calls);
  const word = threadWord(state, lost);
  // What the thread is for: its title, else its launch's message, else the latest sent (11.2).
  const first = threadTitle(items.length ? items : [info.head]);
  const count = items.length > 1 ? `· ${W.calls(items.length)}` : "";
  const link = threadLink(items);
  const reported =
    state?.type === "reported" ? W.reportedAt(statusWords(state.status), clock(state.at)) : null;
  // Only a head whose own result named the thread: a call T3 Code refused proves no thread.
  const beforeRecord =
    info.key !== null && info.head.role !== "launch" && info.head.state === "made";
  const mayContinue = workMayContinue(info.calls);
  return (
    <details
      className="card messaged t3-thread"
      data-target="t3code"
      data-testid="t3-card"
      data-call={headId}
      data-thread={info.key ?? undefined}
      data-state={
        state?.type === "reported"
          ? state.status
          : state?.type === "call"
            ? state.state
            : state?.word
      }
      data-connection={lost ? "lost" : undefined}
      id={actionDomId(headId)}
      open={open}
      onClick={onSummaryClick(env.taskKey, viewKeys.call(headId))}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) setOpen(event.currentTarget.open);
      }}
    >
      <summary
        aria-label={`Messaged T3 Code: ${first}${count ? ` ${count}` : ""}. ${word.word}.`}
        title={first}
      >
        <span className="messaged-verb">Messaged</span>
        <span className="messaged-who">
          <AgentMark />
          T3 Code
        </span>
        {/* The count stands apart from the title, so the title gives way and the count never does. */}
        <span className="messaged-first t3-first">
          <span className="t3-title">{first}</span>
          {count && <span className="t3-count">{count}</span>}
        </span>
        <StateWord word={word} />
        <ChevronIcon className="chevron" />
      </summary>
      <div className="messaged-body">
        {thought && <div className="action-thought">{thought}</div>}
        {beforeRecord && <p className="exchange-note">{W.beforeRecord}</p>}
        {reported && <p className="exchange-note t3-reported">{reported}</p>}
        {mayContinue && <p className="exchange-continue">{W.workMayContinue}</p>}
        <ol className="t3-items" aria-label="The calls on this thread">
          {items.map((c) => (
            <Item
              key={c.id}
              call={c}
              line={feed.placements.get(c.id)?.type === "line"}
              thought={feed.thoughts.get(c.id) ?? null}
            />
          ))}
        </ol>
        {link && (
          <div className="card-actions">
            {/* Opened in the system browser when chosen, like every link; its host says where. */}
            <a
              className="link-button"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open the T3 Code thread in your browser, at ${link.host}`}
            >
              Open thread
              <ExternalIcon />
            </a>
            <span className="t3-link-host">{link.host}</span>
          </div>
        )}
      </div>
    </details>
  );
}

/** "Show the thread" on a call's own line (11.4): to its thread's card, found by identity. */
export function ShowTheThread({ callId }: { callId: string }) {
  const env = useActionEnv();
  const feed = useContext(T3FeedContext);
  const placement = feed.placements.get(callId);
  // A line of a thread, or a call of its own whose arguments asked for a thread that is shown.
  const head =
    placement?.type === "line" ? placement.head : placement?.type === "own" ? placement.head : null;
  if (!head) return null;
  return (
    <button
      type="button"
      className="link-button"
      aria-label="Show this thread's card"
      onClick={() => showThread(env.taskKey, head, callId)}
    >
      Show the thread
    </button>
  );
}

/**
 * Bring a thread's card into view by the smallest scroll, open it and this
 * call's item, and move focus to the item's head. Found by the card's call id,
 * which the thread's identity chose; never by nearness.
 */
export function showThread(taskKey: string, headId: string, callId: string): boolean {
  writeView(taskKey, viewKeys.call(headId), true);
  writeView(taskKey, viewKeys.item(callId), true);
  const focus = (tries: number) => {
    const card = document.querySelector<HTMLDetailsElement>(
      `.t3-thread[data-call="${CSS.escape(headId)}"]`,
    );
    const item = card?.querySelector<HTMLDetailsElement>(
      `[data-item-call="${CSS.escape(callId)}"]`,
    );
    if (!card) {
      if (tries > 0) requestAnimationFrame(() => focus(tries - 1));
      return;
    }
    card.open = true;
    // A call of its own is no item of the thread it asked for: the card's line takes focus.
    if (!item) {
      markTranscriptNavigation(card);
      card.scrollIntoView({ block: "nearest" });
      card.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
      return;
    }
    item.open = true;
    markTranscriptNavigation(item);
    item.scrollIntoView({ block: "nearest" });
    item.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
  };
  requestAnimationFrame(() => focus(10));
  return readView(taskKey, viewKeys.call(headId)) === true;
}

/** "Show where it happened" on an item: to the call's own line, by its tool call id. */
export function showWhereItHappened(callId: string): void {
  const line = document.querySelector<HTMLDetailsElement>(
    `.card.action[data-call="${CSS.escape(callId)}"]`,
  );
  if (!line) return;
  markTranscriptNavigation(line);
  line.scrollIntoView({ block: "nearest" });
  line.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
}
