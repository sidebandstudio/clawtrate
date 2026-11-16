import type { Bot, Task, Transcript, TranscriptBlock, TranscriptItem } from "@clawtrate/core";
import { Fragment, useEffect, useRef } from "react";
import { Avatar } from "./Avatar.tsx";
import { clockTime, fullDate, summarizeArguments } from "./format.ts";
import { ChevronIcon, EyeIcon, PanelIcon } from "./icons.tsx";
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
        {isUser || !bot ? <span className="user-mark">You</span> : <Avatar bot={bot} size={28} />}
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

export function Conversation({
  task,
  bot,
  transcript,
  panelOpen,
  onTogglePanel,
}: {
  task: Task | null;
  bot: Bot | undefined;
  transcript: Transcript | undefined;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const itemCount = transcript?.items.length ?? 0;
  const liveLength = transcript?.live?.text.length ?? 0;

  // Start at the latest message when a task opens or grows.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [task?.key, itemCount, liveLength]);

  return (
    <section className="conversation" aria-label="Conversation">
      <header className="pane-header conversation-header">
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
      <div className="transcript" ref={scroller} data-testid="transcript">
        {!task ? (
          <div className="empty">
            <div>
              <h3>Pick a task</h3>
              <p>Choose one of this bot&apos;s tasks to read the conversation.</p>
            </div>
          </div>
        ) : !transcript || (transcript.status === "loading" && itemCount === 0) ? (
          <div className="transcript-inner" aria-busy="true">
            <div className="skeleton" style={{ width: "40%" }} />
            <div className="skeleton" style={{ width: "85%" }} />
            <div className="skeleton" style={{ width: "70%" }} />
          </div>
        ) : transcript.status === "error" && itemCount === 0 ? (
          <div className="empty">
            <div>
              <h3>Could not load this conversation</h3>
              <p>{transcript.error}</p>
            </div>
          </div>
        ) : itemCount === 0 && !transcript.live ? (
          <div className="empty">
            <div>
              <h3>Nothing here yet</h3>
              <p>This task has no messages.</p>
            </div>
          </div>
        ) : (
          <div className="transcript-inner">
            {transcript.items.map((item) => (
              <Turn key={item.id} item={item} bot={bot} />
            ))}
            {transcript.live && (
              <article className="turn" data-role="assistant">
                <div className="turn-gutter">{bot && <Avatar bot={bot} size={28} />}</div>
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
        )}
      </div>
      <footer className="read-only-bar">
        <EyeIcon />
        Read-only connection. Sending messages arrives in a later version.
      </footer>
    </section>
  );
}
