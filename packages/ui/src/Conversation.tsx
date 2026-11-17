import type {
  Bot,
  DiscoveryState,
  Task,
  Transcript,
  TranscriptBlock,
  TranscriptItem,
} from "@clawtrate/core";
import { Fragment, useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Avatar } from "./Avatar.tsx";
import { clockTime, fullDate, summarizeArguments } from "./format.ts";
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

/** Render blocks in order, grouping consecutive reasoning and tool steps into one stack. */
function Blocks({ blocks }: { blocks: TranscriptBlock[] }) {
  const groups: Array<{ kind: "steps" | "text"; blocks: TranscriptBlock[] }> = [];
  for (const block of blocks) {
    const kind = block.kind === "text" ? "text" : "steps";
    const last = groups.at(-1);
    if (last && last.kind === kind && kind === "steps") last.blocks.push(block);
    else groups.push({ kind, blocks: [block] });
  }
  return (
    <>
      {groups.map((group, index) =>
        group.kind === "steps" ? (
          <div className="steps" key={index}>
            {group.blocks.map((block, i) =>
              block.kind === "reasoning" ? (
                <ReasoningStep key={i} text={block.text} />
              ) : block.kind === "tool-call" ? (
                <ToolStep key={i} call={block} />
              ) : null,
            )}
          </div>
        ) : (
          <Fragment key={index}>
            {group.blocks.map((block, i) =>
              block.kind === "text" ? <Markdown key={i} text={block.text} /> : null,
            )}
          </Fragment>
        ),
      )}
    </>
  );
}

function Turn({ item, bot }: { item: TranscriptItem; bot: Bot | undefined }) {
  if (item.role === "system") {
    return (
      <div className="system-row">
        {item.blocks.map((b) => (b.kind === "text" ? b.text : "")).join(" ")}
      </div>
    );
  }
  const isUser = item.role === "user";
  return (
    <article className="turn" data-role={item.role} data-testid="transcript-turn">
      <div className="turn-gutter">
        {isUser || !bot ? <span className="user-mark">You</span> : <Avatar bot={bot} />}
      </div>
      <div className="turn-main">
        <header className="turn-meta">
          <span className="turn-author">{isUser ? "You" : (bot?.name ?? "Bot")}</span>
          <time className="turn-time" title={fullDate(item.timestamp)}>
            {clockTime(item.timestamp)}
          </time>
        </header>
        <div className="turn-body">
          <Blocks blocks={item.blocks} />
        </div>
      </div>
    </article>
  );
}

/** How close to the end counts as "reading the latest", in pixels. */
const NEAR_BOTTOM_PX = 96;

/**
 * The scrolling transcript of one task. Mounted per task, so opening a task
 * starts at its latest message. New output follows only a reader who is already
 * at the end; anyone reading older messages keeps their place and gets a
 * "Jump to latest" control instead.
 */
function TranscriptView({ transcript, bot }: { transcript: Transcript; bot: Bot | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const itemCount = transcript.items.length;
  const liveLength = transcript.live?.text.length ?? 0;
  const contentSize = `${itemCount}:${liveLength}`;
  const [atEnd, setAtEnd] = useState(true);
  const [seenSize, setSeenSize] = useState(contentSize);
  const newActivity = !atEnd && contentSize !== seenSize;

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    setAtEnd(near);
    if (near) setSeenSize(contentSize);
  }, [contentSize]);

  const jumpToLatest = useCallback(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    setAtEnd(true);
    setSeenSize(contentSize);
  }, [contentSize]);

  // Follow new output while the reader is at the end.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (atEnd && element) element.scrollTop = element.scrollHeight;
  }, [contentSize, atEnd]);

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={scroller} onScroll={onScroll} data-testid="transcript">
        <div className="transcript-inner">
          {transcript.items.map((item) => (
            <Turn key={item.id} item={item} bot={bot} />
          ))}
          {transcript.live && (
            <article className="turn" data-role="assistant" data-testid="live-turn">
              <div className="turn-gutter">{bot && <Avatar bot={bot} />}</div>
              <div className="turn-main">
                <header className="turn-meta">
                  <span className="turn-author">{bot?.name ?? "Bot"}</span>
                  <span className="turn-time">working</span>
                </header>
                <div className="live-text">
                  {transcript.live.text ? <Markdown text={transcript.live.text} /> : "Thinking"}
                </div>
              </div>
            </article>
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
          <ArrowDownIcon />
          Jump to latest
        </button>
      )}
    </div>
  );
}

function Placeholder({ title, body }: { title: string; body: string | null }) {
  return (
    <div className="transcript-wrap">
      <div className="transcript" data-testid="transcript">
        <div className="empty">
          <div>
            <h3>{title}</h3>
            {body && <p>{body}</p>}
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
  onBack,
  toggleRef,
  inert = false,
}: {
  task: Task | null;
  bot: Bot | undefined;
  taskCount: number;
  discovery: DiscoveryState;
  transcript: Transcript | undefined;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onBack: () => void;
  toggleRef?: RefObject<HTMLButtonElement | null>;
  /** Set while the Work drawer covers the conversation, so focus cannot land behind it. */
  inert?: boolean;
}) {
  const itemCount = transcript?.items.length ?? 0;
  return (
    <section className="conversation" aria-label="Conversation" inert={inert}>
      <header className="pane-header conversation-header">
        <button
          type="button"
          className="icon-button back-button"
          onClick={onBack}
          aria-label="Back to bots"
          title="Back to bots"
        >
          <BackIcon />
        </button>
        <div className="conversation-title">
          <h1>{task?.title ?? "No task selected"}</h1>
          {task && (
            <p>
              {bot?.name ?? task.botId}
              {task.updatedAt ? ` · updated ${fullDate(task.updatedAt)}` : ""}
              {bot?.model ? ` · ${bot.model}` : ""}
            </p>
          )}
        </div>
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
      </header>
      {!bot ? (
        discovery.status === "loading" ? (
          <Placeholder title="Loading" body="Loading this gateway's bots." />
        ) : (
          <Placeholder title="No bots to show" body="This gateway has no bots yet." />
        )
      ) : taskCount === 0 ? (
        <Placeholder
          title="No tasks yet"
          body={`Conversations with ${bot.name} will be listed here.`}
        />
      ) : !task ? (
        <Placeholder
          title="Pick a task"
          body={`Choose one of ${bot.name}'s tasks to read the conversation.`}
        />
      ) : !transcript || (transcript.status === "loading" && itemCount === 0) ? (
        <div className="transcript-wrap">
          <div className="transcript" data-testid="transcript">
            <div className="transcript-inner" aria-busy="true">
              <div className="skeleton" style={{ width: "40%" }} />
              <div className="skeleton" style={{ width: "85%" }} />
              <div className="skeleton" style={{ width: "70%" }} />
            </div>
          </div>
        </div>
      ) : transcript.status === "error" && itemCount === 0 ? (
        <Placeholder title="Could not load this conversation" body={transcript.error} />
      ) : itemCount === 0 && !transcript.live ? (
        <Placeholder title="Nothing here yet" body="This task has no messages." />
      ) : (
        <TranscriptView key={task.key} transcript={transcript} bot={bot} />
      )}
      <footer className="read-only-bar">
        <EyeIcon />
        <span>Read-only connection. Sending messages arrives in a later version.</span>
      </footer>
    </section>
  );
}
