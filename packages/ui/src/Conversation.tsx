import type {
  Bot,
  DiscoveryState,
  Task,
  Transcript,
  TranscriptBlock,
  TranscriptItem,
} from "@clawtrate/core";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Avatar } from "./Avatar.tsx";
import { daysAgo, fullDate, stampTime, summarizeArguments } from "./format.ts";
import { ArrowDownIcon, BackIcon, ChevronIcon, EyeIcon, PanelIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";

type ToolCall = Extract<TranscriptBlock, { kind: "tool-call" }>;

function ReasoningStep({ text }: { text: string }) {
  const firstLine = text.split("\n")[0] ?? "";
  return (
    <details className="step">
      <summary>
        <ChevronIcon className="step-chevron" />
        <span className="step-kind">Thought</span>
        <span className="step-reasoning-preview">{firstLine}</span>
      </summary>
      <div className="step-body">
        <p className="reasoning">{text}</p>
      </div>
    </details>
  );
}

function ToolStep({ call }: { call: ToolCall }) {
  const state = call.result ? (call.result.isError ? "failed" : "done") : "no result";
  return (
    <details className="step" data-testid="tool-call">
      <summary>
        <ChevronIcon className="step-chevron" />
        <span className="step-tool-name">{call.name}</span>
        <span className="step-summary">{summarizeArguments(call.argumentsText)}</span>
        <span className="step-state" data-error={call.result?.isError === true}>
          {state}
        </span>
      </summary>
      <div className="step-body">
        <p className="code-label">Arguments</p>
        <pre className="code-block">{call.argumentsText}</pre>
        {call.result && (
          <>
            <p className="code-label">{call.result.isError ? "Error" : "Result"}</p>
            <pre className="code-block">{call.result.text || "(empty)"}</pre>
          </>
        )}
      </div>
    </details>
  );
}

/** "Thought, used 2 tools", "Used 1 tool", "Thought". */
export function stepsLabel(blocks: TranscriptBlock[]): string {
  const thought = blocks.some((block) => block.kind === "reasoning");
  const tools = blocks.filter((block) => block.kind === "tool-call").length;
  const used = tools
    ? `${thought ? "used" : "Used"} ${tools} ${tools === 1 ? "tool" : "tools"}`
    : "";
  return [thought ? "Thought" : "", used].filter(Boolean).join(", ");
}

/** A run of thoughts and tool calls, folded into one line until asked for. */
function Steps({ blocks }: { blocks: TranscriptBlock[] }) {
  return (
    <details className="steps">
      <summary className="event-line">
        {stepsLabel(blocks)}
        <ChevronIcon />
      </summary>
      <div className="steps-list">
        {blocks.map((block, i) =>
          block.kind === "reasoning" ? (
            <ReasoningStep key={i} text={block.text} />
          ) : block.kind === "tool-call" ? (
            <ToolStep key={i} call={block} />
          ) : null,
        )}
      </div>
    </details>
  );
}

/** One transcript item: its bubbles and its folded work, in their order. */
function Turn({ item }: { item: TranscriptItem }) {
  const role = item.role === "user" ? "user" : "assistant";
  const groups: Array<{ kind: "steps" | "text"; blocks: TranscriptBlock[] }> = [];
  for (const block of item.blocks) {
    const kind = block.kind === "text" ? "text" : "steps";
    const last = groups.at(-1);
    if (last && kind === "steps" && last.kind === "steps") last.blocks.push(block);
    else groups.push({ kind, blocks: [block] });
  }
  const time = item.timestamp === null ? undefined : fullDate(item.timestamp);
  return (
    <div className="turn" data-role={role} data-testid="transcript-turn">
      {groups.map((group, index) =>
        group.kind === "steps" ? (
          <Steps key={index} blocks={group.blocks} />
        ) : (
          group.blocks.map((block, i) =>
            block.kind === "text" && block.text.trim() ? (
              <div className="msg" data-role={role} key={`${index}-${i}`}>
                <div className="bubble" title={time}>
                  <Markdown text={block.text} />
                </div>
              </div>
            ) : null,
          )
        ),
      )}
    </div>
  );
}

const STAMP_GAP_MS = 10 * 60_000;

/** How close to the end counts as "reading the latest", in pixels. */
const NEAR_BOTTOM_PX = 96;

/**
 * The reader's place survives a change of width: opening, closing, docking or
 * undocking Work, or resizing the window, and late reflows such as fonts
 * arriving. A reader following the end stays at the end; otherwise the first
 * item in view stays where it was while the text reflows around it.
 */
function useHoldPlace(
  scroller: RefObject<HTMLDivElement | null>,
  following: RefObject<boolean>,
  toEnd: () => void,
) {
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let place: { anchor: Element | null; offset: number } = { anchor: null, offset: 0 };
    let width = element.clientWidth;
    const record = () => {
      const top = element.getBoundingClientRect().top;
      const anchor =
        [...element.querySelectorAll(".transcript-inner > *")].find(
          (node) => node.getBoundingClientRect().bottom > top + 1,
        ) ?? null;
      place = { anchor, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
    };
    const observer = new ResizeObserver(() => {
      if (following.current) toEnd();
      else if (element.clientWidth !== width && place.anchor?.isConnected) {
        const top = element.getBoundingClientRect().top;
        element.scrollTop += place.anchor.getBoundingClientRect().top - top - place.offset;
      }
      width = element.clientWidth;
      record();
    });
    record();
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", record, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", record);
    };
  }, [scroller, following, toEnd]);
}

/**
 * The scrolling transcript of one task. Mounted per task, so opening a task
 * starts at its latest message. New output follows only a reader who is already
 * at the end; anyone reading older messages keeps their place and gets a
 * "Jump to latest" control instead.
 */
function TranscriptView({
  task,
  transcript,
  note,
}: {
  task: Task;
  transcript: Transcript;
  note: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const itemCount = transcript.items.length;
  const liveLength = transcript.live?.text.length ?? 0;
  const contentSize = `${itemCount}:${liveLength}`;
  const [atEnd, setAtEnd] = useState(true);
  const [seenSize, setSeenSize] = useState(contentSize);
  const [now] = useState(() => Date.now());
  const newActivity = !atEnd && contentSize !== seenSize;

  // Whether the view follows the end, and where it last put the end. A scroll
  // the reader did not make (the content grew under a followed end) keeps
  // following; only the reader moving up stops it.
  const following = useRef(true);
  const followTop = useRef<number | null>(null);
  const toEnd = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    followTop.current = element.scrollTop;
  }, []);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const kept =
      following.current && followTop.current !== null && element.scrollTop >= followTop.current - 1;
    const near = kept || distance < NEAR_BOTTOM_PX;
    if (kept && distance > 1) toEnd();
    else followTop.current = near ? element.scrollTop : null;
    following.current = near;
    setAtEnd(near);
    if (near) setSeenSize(contentSize);
  }, [contentSize, toEnd]);

  const jumpToLatest = useCallback(() => {
    following.current = true;
    toEnd();
    setAtEnd(true);
    setSeenSize(contentSize);
  }, [contentSize, toEnd]);

  // Follow new output while the reader is at the end.
  useLayoutEffect(() => {
    if (atEnd) toEnd();
  }, [contentSize, atEnd, toEnd]);

  useHoldPlace(scroller, following, toEnd);

  // A centred stamp before the first message, and wherever more than ten
  // minutes pass or the day changes.
  const rows: ReactNode[] = [];
  let previous: number | null = null;
  for (const item of transcript.items) {
    const at = item.timestamp;
    if (
      at !== null &&
      (previous === null || at - previous > STAMP_GAP_MS || daysAgo(previous, at) !== 0)
    ) {
      rows.push(
        <div className="stamp" key={`stamp-${item.id}`}>
          {stampTime(at, now)}
        </div>,
      );
    }
    if (at !== null) previous = at;
    rows.push(
      item.role === "system" ? (
        <p className="event-line" data-side="center" key={item.id}>
          {item.blocks.map((block) => (block.kind === "text" ? block.text : "")).join(" ")}
        </p>
      ) : (
        <Turn key={item.id} item={item} />
      ),
    );
  }

  return (
    <div className="transcript-wrap">
      <div
        className="transcript"
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label="Transcript"
        data-testid="transcript"
      >
        <div className="transcript-inner">
          <h1 className="task-line">{task.title}</h1>
          {note}
          {rows}
          {transcript.live && (
            <div className="turn" data-role="assistant" data-testid="live-turn">
              <div className="msg" data-role="assistant">
                <div className="bubble" data-live="true">
                  {transcript.live.text ? (
                    <Markdown text={transcript.live.text} />
                  ) : (
                    <span className="thinking">Thinking</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {newActivity && (
        <button
          type="button"
          className="jump-latest"
          onClick={jumpToLatest}
          data-testid="jump-latest"
        >
          Jump to latest
          <ArrowDownIcon />
        </button>
      )}
    </div>
  );
}

/** A state with nothing to read: its title is the screen's heading. */
function EmptyState({
  bot,
  title,
  body,
  busy = false,
  children,
}: {
  bot?: Bot | undefined;
  title: string;
  body: string | null;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="transcript-wrap">
      <div className="transcript" data-testid="transcript">
        <div className="empty" aria-busy={busy || undefined}>
          <div>
            {bot && <Avatar bot={bot} />}
            <h1>{title}</h1>
            {body && <p>{body}</p>}
            {children && <div className="empty-actions">{children}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Conversation({
  task,
  bot,
  taskCount,
  discovery,
  transcript,
  panelOpen,
  onTogglePanel,
  onOpenPanel,
  onBack,
  onReload,
  toggleRef,
  strip,
  refreshNote,
  readOnly,
  inert = false,
}: {
  task: Task | null;
  bot: Bot | undefined;
  taskCount: number;
  discovery: DiscoveryState;
  transcript: Transcript | undefined;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenPanel: () => void;
  onBack: () => void;
  /** Reload the open task's transcript. */
  onReload: () => void;
  toggleRef?: RefObject<HTMLButtonElement | null>;
  /** The status strip, rendered first so it is centred on the conversation. */
  strip: ReactNode;
  /** The open task failed to refresh, and that is the conversation's news, not the strip's. */
  refreshNote: boolean;
  readOnly: boolean;
  /** Set while the Work drawer covers the conversation, so focus cannot land behind it. */
  inert?: boolean;
}) {
  const itemCount = transcript?.items.length ?? 0;
  const pillName = bot
    ? task
      ? `${bot.name}, ${task.title}. Show details.`
      : `${bot.name}, no task selected. Show details.`
    : "";

  let body: ReactNode;
  if (!bot) {
    body =
      discovery.status === "loading" ? (
        <EmptyState title="Loading" body="Loading this gateway's bots." busy />
      ) : (
        <EmptyState title="No bots to show" body="This gateway has no bots yet." />
      );
  } else if (taskCount === 0) {
    body = (
      <EmptyState
        bot={bot}
        title="No tasks yet"
        body={`Conversations with ${bot.name} will be listed here.`}
      />
    );
  } else if (!task) {
    body = (
      <EmptyState
        bot={bot}
        title="Pick a task"
        body={`Choose one of ${bot.name}'s tasks to read the conversation.`}
      >
        <button type="button" className="button choose-task" onClick={onBack}>
          Choose a task
        </button>
      </EmptyState>
    );
  } else if (!transcript || (transcript.status === "loading" && itemCount === 0)) {
    body = (
      <div className="transcript-wrap">
        <div className="transcript" data-testid="transcript">
          <div className="transcript-inner" aria-busy="true" aria-label="Loading conversation">
            <h1 className="task-line">{task.title}</h1>
            <div className="skeleton" data-side="end" style={{ width: "46%", marginTop: 22 }} />
            <div className="skeleton" style={{ width: "62%", height: 88, marginTop: 16 }} />
            <div className="skeleton" style={{ width: "38%" }} />
          </div>
        </div>
      </div>
    );
  } else if (transcript.status === "error" && itemCount === 0) {
    body = (
      <EmptyState bot={bot} title="Could not load this conversation" body={transcript.error}>
        <button type="button" className="button" onClick={onReload}>
          Try again
        </button>
      </EmptyState>
    );
  } else if (itemCount === 0 && !transcript.live) {
    body = (
      <EmptyState
        bot={bot}
        title="Nothing here yet"
        body={`Messages between you and ${bot.name} in this task will appear here.`}
      />
    );
  } else {
    body = (
      <TranscriptView
        key={task.key}
        task={task}
        transcript={transcript}
        note={
          refreshNote && (
            <p className="load-note" role="alert">
              Couldn't refresh this conversation. Showing what was loaded before.
              <button type="button" className="button" data-size="sm" onClick={onReload}>
                Try again
              </button>
            </p>
          )
        }
      />
    );
  }

  return (
    <section
      className="conversation"
      aria-label="Conversation"
      inert={inert}
      data-strip={strip ? "true" : undefined}
    >
      {strip}
      <header className="conversation-header">
        <div className="header-side">
          <button
            type="button"
            className="icon-button back-button"
            onClick={onBack}
            aria-label="Back to bots"
            title="Back to bots"
          >
            <BackIcon />
          </button>
        </div>
        {bot ? (
          <button
            type="button"
            className="title-pill"
            aria-label={pillName}
            title={task?.title}
            onClick={onOpenPanel}
          >
            <Avatar bot={bot} />
            <span className="title-pill-name">{bot.name}</span>
            {task && <span className="title-pill-task">{task.title}</span>}
          </button>
        ) : (
          <span />
        )}
        <div className="header-side" data-side="end">
          {bot && (
            <button
              ref={toggleRef}
              type="button"
              className="icon-button"
              aria-pressed={panelOpen}
              aria-label={panelOpen ? "Hide work panel" : "Show work panel"}
              title={`${panelOpen ? "Hide" : "Show"} work panel (⌘\\)`}
              onClick={onTogglePanel}
            >
              <PanelIcon />
            </button>
          )}
        </div>
      </header>
      {body}
      {task && readOnly && (
        <footer className="composer" data-readonly="true">
          <div className="composer-inner">
            <div className="composer-box">
              <EyeIcon />
              <span>Read-only connection. Sending messages arrives in a later version.</span>
            </div>
          </div>
        </footer>
      )}
    </section>
  );
}
