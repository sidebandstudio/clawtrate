import type {
  Bot,
  ConnectionState,
  DiscoveryState,
  HostInfo,
  Run,
  Task,
  Transcript,
  TranscriptBlock,
  TranscriptItem,
} from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AccessBar } from "./AccessBar.tsx";
import { useCommand } from "./bridge.tsx";
import { Avatar, Presence } from "./Avatar.tsx";
import { Composer, reachable, type NeedsYou, type Notice } from "./Composer.tsx";
import { currentRun, outgoingBubbles, statusLineFor, type StatusLineView } from "./live.ts";
import { IncompleteCaption, OutgoingBubble, RunCards, RunEnding, RunReply } from "./LiveTurn.tsx";
import { LeavingStatusLine, StatusLine } from "./StatusLine.tsx";
import { daysAgo, fullDate, stampTime, summarizeArguments } from "./format.ts";
import { ArrowDownIcon, BackIcon, ChevronIcon, PanelIcon } from "./icons.tsx";
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
function Turn({ item, incomplete = false }: { item: TranscriptItem; incomplete?: boolean }) {
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
      {incomplete && <IncompleteCaption />}
    </div>
  );
}

const STAMP_GAP_MS = 10 * 60_000;

/** How close to the end counts as "reading the latest", in pixels. */
const NEAR_BOTTOM_PX = 96;

/** Blocks of readable text in a transcript; the place is held in the finest one. */
const TEXT_BLOCKS =
  ".task-line, .stamp, .event-line, .steps > summary, .step > summary, .status-phrase, " +
  ".bubble :is(p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote)";

type Caret = { node: Node; offset: number };

/** The text position under a point, from whichever caret API the engine has. */
function caretAt(x: number, y: number): Caret | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** Where a text position is drawn now, or null when it no longer is. */
function caretTop(caret: Caret): number | null {
  if (!caret.node.isConnected || caret.node.nodeType !== Node.TEXT_NODE) return null;
  const length = caret.node.textContent?.length ?? 0;
  const range = document.createRange();
  range.setStart(caret.node, Math.min(caret.offset, length));
  range.setEnd(caret.node, Math.min(caret.offset + 1, length));
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return rect.height > 0 ? rect.top : null;
}

/**
 * The reader's place survives a change of width: opening, closing, docking or
 * undocking Work, or resizing the window, and late reflows such as fonts
 * arriving. A reader following the end stays at the end. Otherwise the text
 * at the reading line, just under the protected band at the top, stays where
 * it was while the lines reflow around it: the exact character when the
 * engine can say which, or else the start of its paragraph, list item or row.
 */
function useHoldPlace(
  scroller: RefObject<HTMLDivElement | null>,
  following: RefObject<boolean>,
  toEnd: () => void,
) {
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let place: { block: Element; caret: Caret | null; top: number } | null = null;
    let width = element.clientWidth;

    /** Where the reading line is, and where a held place is drawn, relative to the scroller. */
    const frame = () => {
      const box = element.getBoundingClientRect();
      const inner = element.firstElementChild;
      const band = inner ? Number.parseFloat(getComputedStyle(inner).paddingTop) || 0 : 0;
      return { top: box.top, line: box.top + band };
    };
    const drawnAt = (held: NonNullable<typeof place>) =>
      (held.caret ? caretTop(held.caret) : null) ??
      (held.block.isConnected ? held.block.getBoundingClientRect().top : null);

    const record = () => {
      const { top, line } = frame();
      // The finest block at or below the line that is drawn: the rows of a folded
      // group are laid out but hidden, so they cannot hold a place.
      const block = [...element.querySelectorAll(TEXT_BLOCKS)].find(
        (node) =>
          !node.querySelector(TEXT_BLOCKS) &&
          node.checkVisibility() &&
          node.getBoundingClientRect().bottom > line + 1,
      );
      if (!block) {
        place = null;
        return;
      }
      const rect = block.getBoundingClientRect();
      const found = caretAt(rect.left + 2, Math.max(line + 2, rect.top + 2));
      const caret = found && block.contains(found.node) ? found : null;
      const held = { block, caret, top: 0 };
      held.top = (drawnAt(held) ?? rect.top) - top;
      place = held;
    };

    // Watching the content too covers late reflows, such as fonts arriving.
    const observer = new ResizeObserver(() => {
      if (following.current) toEnd();
      else if (element.clientWidth !== width && place) {
        const now = drawnAt(place);
        if (now !== null) element.scrollTop += now - frame().top - place.top;
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
  bot,
  transcript,
  note,
  liveOptions,
}: {
  task: Task;
  bot: Bot;
  transcript: Transcript;
  note: ReactNode;
  liveOptions: LiveOptions;
}) {
  const live = buildLive(bot, task, transcript, liveOptions);
  const scroller = useRef<HTMLDivElement>(null);
  const itemCount = transcript.items.length;
  const contentSize = `${itemCount}:${live.signature}`;
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
  const endingsBefore = live.endingsBefore;
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
    if (item.role === "user") {
      // What ended the turn before this message sits under that turn.
      const before = endingsBefore.get(item.id);
      if (before) rows.push(...before);
    }
    rows.push(
      item.role === "system" ? (
        <p className="event-line" data-side="center" key={item.id}>
          {item.blocks.map((block) => (block.kind === "text" ? block.text : "")).join(" ")}
        </p>
      ) : (
        <Turn key={item.id} item={item} incomplete={live.incomplete.has(item.id)} />
      ),
    );
  }
  const trailing = endingsBefore.get(null);
  if (trailing) rows.push(...trailing);

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
          <h1 className="task-line" tabIndex={-1}>
            {task.title}
          </h1>
          {note}
          {rows}
          {live.foot}
        </div>
      </div>
      {live.needsYou && !atEnd ? (
        <button
          type="button"
          className="jump-latest"
          data-state="needs-you"
          onClick={() => live.onReview()}
          data-testid="jump-latest"
        >
          <span className="glyph" data-state="waiting" aria-hidden="true" />
          <span>Needs you</span>
          <ArrowDownIcon />
        </button>
      ) : live.status && !atEnd ? (
        <button
          type="button"
          className="jump-latest"
          data-state="live"
          onClick={jumpToLatest}
          data-testid="jump-latest"
          aria-label={`Jump to latest: ${live.status.phrase}`}
        >
          <Presence bot={live.bot} state={live.status.state} badge={live.status.badge} hidden />
          <span>{live.status.phrase}</span>
          <ArrowDownIcon />
        </button>
      ) : (
        newActivity && (
          <button
            type="button"
            className="jump-latest"
            onClick={jumpToLatest}
            data-testid="jump-latest"
          >
            Jump to latest
            <ArrowDownIcon />
          </button>
        )
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
            <h1 tabIndex={-1}>{title}</h1>
            {body && <p>{body}</p>}
            {children && <div className="empty-actions">{children}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** What the engine holds beyond history, laid out for the transcript. */
type LiveParts = {
  bot: Bot;
  /** Everything after the last history item: your messages, the live run, the status line. */
  foot: ReactNode;
  /** Run endings, placed before the next message of yours, or at the end (`null`). */
  endingsBefore: Map<string | null, ReactNode[]>;
  /** History items that end a reply cut off by a stop or a failure. */
  incomplete: Set<string>;
  /** Changes whenever the foot's content does, for following the end. */
  signature: string;
  status: StatusLineView | null;
  needsYou: boolean;
  onReview: () => void;
};

/** A terminal run's reply is shown from the engine only until history holds its message. */
function heldByEngine(run: Run, transcript: Transcript): boolean {
  return (
    run.messageId !== null && transcript.outbox.some((message) => message.id === run.messageId)
  );
}

type LiveOptions = {
  connected: boolean;
  interactive: boolean;
  /** Ask for the interactive tier; null where the host never asks (pinned read-only). */
  onRequestAccess: (() => void) | null;
  onOpenSteps: () => void;
  onReview: () => void;
  leaving: { key: string; run: Run } | null;
};

function buildLive(bot: Bot, task: Task, transcript: Transcript, options: LiveOptions): LiveParts {
  const active = currentRun(transcript);
  const foot: ReactNode[] = [];
  const placed = new Set<string>();
  const endingsBefore = new Map<string | null, ReactNode[]>();
  const incomplete = new Set<string>();
  const signature: string[] = [];

  // Which user message comes after each one, to place an ending under its turn.
  const users = transcript.items.filter((item) => item.role === "user").map((item) => item.id);
  const nextUser = (anchor: string): string | null => users[users.indexOf(anchor) + 1] ?? null;

  const footRuns = transcript.runs.filter(
    (run) =>
      run.state !== "queued" &&
      run.state !== "cancelled" &&
      (run === active || heldByEngine(run, transcript) || run.anchorItemId === null),
  );
  for (const run of transcript.runs) {
    if (footRuns.includes(run) || run.anchorItemId === null) continue;
    // A finished run that history holds: its ending sits under its turn.
    const at = nextUser(run.anchorItemId);
    const list = endingsBefore.get(at) ?? [];
    list.push(
      <RunEnding
        key={`end-${run.id}`}
        run={run}
        bot={bot}
        transcript={transcript}
        taskKey={task.key}
      />,
    );
    endingsBefore.set(at, list);
    if (run.state === "stopped" || run.state === "failed") {
      const group = transcript.items.slice(
        transcript.items.findIndex((item) => item.id === run.anchorItemId) + 1,
        at === null ? undefined : transcript.items.findIndex((item) => item.id === at),
      );
      const last = [...group]
        .reverse()
        .find(
          (item) =>
            item.role === "assistant" &&
            item.blocks.some((block) => block.kind === "text" && block.text.trim()),
        );
      // Only a reply the gateway had not reported complete was cut off.
      if (last && !run.textComplete) incomplete.add(last.id);
    }
  }

  const bubble = (id: string) => {
    const message = transcript.outbox.find((each) => each.id === id);
    if (!message || placed.has(id)) return;
    if (!outgoingBubbles(transcript).includes(message)) return;
    placed.add(id);
    signature.push(`${id}:${message.status}`);
    foot.push(
      <OutgoingBubble
        key={`out-${id}`}
        message={message}
        taskKey={task.key}
        connected={options.connected}
      />,
    );
  };

  for (const run of footRuns) {
    if (run.messageId) bubble(run.messageId);
    if (run === active || heldByEngine(run, transcript)) {
      foot.push(<RunCards key={`cards-${run.id}`} run={run} transcript={transcript} />);
      foot.push(<RunReply key={`reply-${run.id}`} run={run} />);
    }
    signature.push(`${run.id}:${run.state}:${run.text.length}:${run.steps.length}`);
    for (const message of transcript.outbox) {
      if (message.mode === "steer" && message.runId === run.id) bubble(message.id);
    }
    if (run !== active) {
      foot.push(
        <RunEnding
          key={`end-${run.id}`}
          run={run}
          bot={bot}
          transcript={transcript}
          taskKey={task.key}
        />,
      );
    }
  }
  for (const message of outgoingBubbles(transcript)) bubble(message.id);

  let status: StatusLineView | null = null;
  if (active) {
    status = statusLineFor(active, transcript, options);
    // The gateway reports a wait this tier is not sent: say so, and how to see it.
    if (active.state === "waiting" && !options.interactive) {
      foot.push(
        <div className="turn-note" data-testid="read-only-wait" key={`wait-${active.id}`}>
          <span className="glyph" data-state="blocked" aria-hidden="true" />
          <p>
            {bot.name} is waiting for an approval or an answer. This device can't see it on a
            read-only connection.{" "}
            {options.onRequestAccess && (
              <button type="button" className="link-button" onClick={options.onRequestAccess}>
                Request access
              </button>
            )}
          </p>
        </div>,
      );
    }
    signature.push(status.phrase);
    foot.push(
      <StatusLine
        key={`status-${active.id}`}
        bot={bot}
        view={status}
        hasSteps={active.steps.length > 0}
        onOpenSteps={options.onOpenSteps}
      />,
    );
  } else if (options.leaving) {
    foot.push(
      <LeavingStatusLine
        key={options.leaving.key}
        bot={bot}
        run={options.leaving.run}
        view={statusLineFor(options.leaving.run, transcript, options)}
      />,
    );
  }

  const needsYou =
    options.interactive &&
    (transcript.approvals.some((card) => card.status === "pending") ||
      transcript.questions.some((card) => card.status === "pending"));
  return {
    bot,
    foot,
    endingsBefore,
    incomplete,
    signature: signature.join("|"),
    status,
    needsYou,
    onReview: options.onReview,
  };
}

/** The oldest card that needs the person, for "Review" and ⌘J. */
function needsYouOf(bot: Bot, transcript: Transcript | undefined, interactive: boolean): NeedsYou {
  if (!transcript || !interactive) return null;
  const question = transcript.questions.find((card) => card.status === "pending");
  const approval = transcript.approvals.find((card) => card.status === "pending");
  const questionAt = question?.createdAt ?? Number.POSITIVE_INFINITY;
  const approvalAt = approval?.createdAt ?? Number.POSITIVE_INFINITY;
  if (approval && (!question || approvalAt <= questionAt))
    return { kind: "approval", text: `${bot.name} needs your approval to run a command` };
  if (question) return { kind: "question", text: `${bot.name} asked you a question` };
  return null;
}

/** Move to the oldest card that needs the person, and focus it. */
function reviewOldest(root: HTMLElement | null) {
  // The oldest by arrival, questions and approvals mixed; one with no time comes last.
  const pending = [...(root?.querySelectorAll<HTMLElement>('[data-pending="true"]') ?? [])];
  const at = (element: HTMLElement) =>
    element.dataset.since ? Number(element.dataset.since) : Number.POSITIVE_INFINITY;
  const card = pending.reduce<HTMLElement | undefined>(
    (oldest, each) => (!oldest || at(each) < at(oldest) ? each : oldest),
    undefined,
  );
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  card.focus();
}

/** The lifecycle words the announcer speaks for a run (section 2). */
function lifecycleWords(bot: Bot, run: Run | undefined, last: Run | undefined): string | null {
  if (run) {
    if (run.state === "stopping") return "Stopping";
    if (run.state === "waiting" || run.pendingCards.length > 0)
      return `${bot.name} is waiting for you`;
    return `${bot.name} is working`;
  }
  // An ending nothing established is not announced as one.
  if (!last || !last.outcomeKnown) return null;
  if (last.state === "stopped") return "Stopped";
  if (last.state === "completed") return `${bot.name} finished`;
  if (last.state === "failed") return `${bot.name} couldn't finish`;
  return null;
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
  interactive,
  connection,
  info,
  online,
  caughtUp,
  inert = false,
  granted,
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
  /** This connection may send, stop and answer (`canWrite`). */
  interactive: boolean;
  connection: ConnectionState;
  info: HostInfo;
  /** The gateway is connected, so a task without a transcript can load. */
  online: boolean;
  /** Connected and caught up since the latest connect: until then live work is last seen. */
  caughtUp: boolean;
  /** Set while the Work drawer covers the conversation, so focus cannot land behind it. */
  inert?: boolean;
  /** Access arrived a moment ago. */
  granted: boolean;
}) {
  const itemCount = transcript?.items.length ?? 0;
  const send = useCommand();
  const sectionRef = useRef<HTMLElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // Each notice belongs to the task it was raised in, and shows only there.
  const [notices, setNotices] = useState<Array<Notice & { task: string }>>([]);
  const [dismissedStops, setDismissedStops] = useState<Set<string>>(() => new Set());
  const pillName = bot
    ? task
      ? `${bot.name}, ${task.title}. Show details.`
      : `${bot.name}, no task selected. Show details.`
    : "";

  const active = currentRun(transcript);
  const review = useCallback(() => reviewOldest(sectionRef.current), []);
  const openSteps = useCallback(() => {
    const activity = sectionRef.current?.querySelectorAll<HTMLElement>(
      '[data-placeholder="activity"]',
    );
    activity?.[activity.length - 1]?.scrollIntoView({ block: "nearest" });
  }, []);

  // The status line leaves with a short fade when its run ends.
  const ended = !active
    ? transcript?.runs.filter((run) => run.state !== "queued").at(-1)
    : undefined;
  const leaving =
    ended &&
    bot &&
    transcript &&
    (ended.state === "completed" || ended.state === "stopped" || ended.state === "failed")
      ? { key: `leaving-${ended.id}`, run: ended }
      : null;

  // The conversation's one polite live region. It speaks a run's lifecycle,
  // the connection and access, and the result of what the person did; not
  // each phrase. A repeated message is spoken again.
  const [announcement, setAnnouncement] = useState("");
  const onAnnounce = (text: string) =>
    setAnnouncement((current) => (current === text ? `${text}\u00a0` : text));
  const lastRun = transcript?.runs.filter((run) => run.state !== "queued").at(-1);
  const heard = [
    bot ? lifecycleWords(bot, active, lastRun) : null,
    connection.status === "reconnecting"
      ? "Reconnecting"
      : connection.status === "connected"
        ? "Connected"
        : null,
    granted
      ? "You can now send, stop and answer"
      : connection.upgrade.status === "pending"
        ? "Access requested"
        : null,
  ];
  const [spoken, setSpoken] = useState(heard);
  if (heard.some((words, index) => words !== spoken[index])) {
    setSpoken(heard);
    const changed = heard.filter((words, index) => words && words !== spoken[index]);
    // A first hello is not news; a return after a drop is.
    const news = changed.filter((words) => words !== "Connected" || spoken[1] === "Reconnecting");
    if (news.length > 0) setAnnouncement(news.at(-1)!);
  }

  // A control that held focus and has gone (a failed message's Resend or
  // Delete, the status line when its run ends) leaves focus on nothing: it
  // moves to the message field, or else to the transcript.
  const lastFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const onFocus = (event: FocusEvent) => {
      lastFocus.current = event.target as HTMLElement;
    };
    section.addEventListener("focusin", onFocus);
    return () => section.removeEventListener("focusin", onFocus);
  }, []);
  useLayoutEffect(() => {
    const gone = lastFocus.current;
    if (!gone || gone.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    lastFocus.current = null;
    const section = sectionRef.current;
    (
      section?.querySelector<HTMLElement>(".composer-input") ??
      section?.querySelector<HTMLElement>("[data-testid=transcript]")
    )?.focus();
  });

  // ⌘J goes to what needs you.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "j" &&
        reachable(sectionRef.current?.querySelector("[data-testid=transcript]") ?? null)
      ) {
        event.preventDefault();
        review();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [review]);

  const taskKey = task?.key ?? null;
  const addNotice = useCallback(
    (notice: Omit<Notice, "id">) => {
      if (!taskKey) return;
      setNotices((current) => [
        ...current,
        { ...notice, task: taskKey, id: `${Date.now()}:${Math.random()}` },
      ]);
    },
    [taskKey],
  );
  const stopNotices: Notice[] =
    transcript && bot
      ? transcript.runs.flatMap((run) =>
          run.stopError && !dismissedStops.has(`${run.id}:${run.stopError}`)
            ? [
                {
                  id: `${run.id}:${run.stopError}`,
                  title: `Couldn't stop ${bot.name}.`,
                  reason: run.stopError,
                },
              ]
            : [],
        )
      : [];

  const hasLive =
    !!transcript &&
    (transcript.outbox.length > 0 ||
      transcript.runs.some((run) => run.state !== "queued" && run.state !== "cancelled"));

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
  } else if (!online && (!transcript || itemCount === 0) && !hasLive) {
    // Nothing was saved for this task, and nothing can load until the gateway is back.
    body = (
      <EmptyState
        bot={bot}
        title="Waiting for the gateway"
        body="This conversation loads when the connection returns."
      />
    );
  } else if (!transcript || (transcript.status === "loading" && itemCount === 0 && !hasLive)) {
    body = (
      <div className="transcript-wrap">
        <div className="transcript" data-testid="transcript">
          <div className="transcript-inner" aria-busy="true" aria-label="Loading conversation">
            <h1 className="task-line" tabIndex={-1}>
              {task.title}
            </h1>
            <div className="skeleton" data-side="end" style={{ width: "46%", marginTop: 22 }} />
            <div className="skeleton" style={{ width: "62%", height: 88, marginTop: 16 }} />
            <div className="skeleton" style={{ width: "38%" }} />
          </div>
        </div>
      </div>
    );
  } else if (transcript.status === "error" && itemCount === 0 && !hasLive) {
    body = (
      <EmptyState bot={bot} title="Could not load this conversation" body={transcript.error}>
        <button type="button" className="button" onClick={onReload}>
          Try again
        </button>
      </EmptyState>
    );
  } else if (itemCount === 0 && !hasLive) {
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
        bot={bot}
        transcript={transcript}
        liveOptions={{
          connected: caughtUp,
          interactive,
          onRequestAccess: info.readOnly
            ? null
            : () => void send({ type: "requestAccess" }).catch(() => {}),
          onOpenSteps: openSteps,
          onReview: review,
          leaving,
        }}
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
      ref={sectionRef}
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
      {task && bot && interactive && (
        <Composer
          key={`composer:${connection.gatewayUrl ?? ""}:${task.key}`}
          bot={bot}
          gateway={connection.gatewayUrl}
          taskKey={task.key}
          transcript={transcript}
          connected={caughtUp}
          notices={[
            ...stopNotices.map((notice) => ({
              ...notice,
              retry: () => {
                const run = transcript?.runs.find((each) => notice.id.startsWith(`${each.id}:`));
                if (run && task) void send({ type: "stopRun", key: task.key, runId: run.id });
              },
            })),
            ...notices.filter((notice) => notice.task === task.key),
          ]}
          needsYou={needsYouOf(bot, transcript, interactive)}
          onReview={review}
          onNotice={addNotice}
          onDismissNotice={(id) => {
            setNotices((current) => current.filter((notice) => notice.id !== id));
            setDismissedStops((current) => new Set(current).add(id));
          }}
          onClearNotices={() => {
            setNotices((current) => current.filter((notice) => notice.task !== task.key));
            setDismissedStops((current) => {
              const next = new Set(current);
              for (const notice of stopNotices) next.add(notice.id);
              return next;
            });
          }}
          onAnnounce={onAnnounce}
          focusRef={fieldRef}
        />
      )}
      {task && bot && !interactive && (
        <AccessBar bot={bot.name} connection={connection} info={info} />
      )}
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="announcer">
        {announcement}
      </p>
    </section>
  );
}
