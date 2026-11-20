import type {
  ReadingContext,
  Bot,
  ConnectionState,
  DiscoveryState,
  HostInfo,
  Run,
  Task,
  Transcript,
  TranscriptItem,
} from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { AccessBar } from "./AccessBar.tsx";
import { useClawtrateState, useCommand } from "./bridge.tsx";
import { Avatar, Presence } from "./Avatar.tsx";
import { CardScope, CardSlot, focusPending, oldestPending, TrailingCards } from "./cards/index.ts";
import { Composer, reachable, type NeedsYou, type Notice } from "./Composer.tsx";
import { currentRun, outgoingBubbles, statusLineFor, type StatusLineView } from "./live.ts";
import { IncompleteCaption, OutgoingBubble, RunEnding, RunReply } from "./LiveTurn.tsx";
import { ActionScope, ItemFeed, RunFeed, RunLine, showAction } from "./actions/index.ts";
import { LeavingStatusLine, StatusLine } from "./StatusLine.tsx";
import { FindBar } from "./Find.tsx";
import { contextWords, daysAgo, fullDate, stampTime } from "./format.ts";
import { ArrowDownIcon, BackIcon, PanelIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { TEXT_BLOCKS } from "./reading-line.ts";

/**
 * One transcript item. Your message is a bubble; the bot's item is its
 * bubbles, action cards and "Thought" lines in their order (section 7).
 */
function Turn({ item, incomplete = false }: { item: TranscriptItem; incomplete?: boolean }) {
  const role = item.role === "user" ? "user" : "assistant";
  const time = item.timestamp === null ? undefined : fullDate(item.timestamp);
  return (
    <div className="turn" data-role={role} data-testid="transcript-turn">
      {role === "assistant" ? (
        <ItemFeed itemId={item.id} />
      ) : (
        item.blocks.map((block, i) =>
          block.kind === "text" && block.text.trim() ? (
            <div className="msg" data-role={role} key={i}>
              <div className="bubble" title={time}>
                <Markdown text={block.text} />
              </div>
            </div>
          ) : null,
        )
      )}
      {incomplete && <IncompleteCaption />}
    </div>
  );
}

/** Under the task's name: how much of the model's context the task uses. */
function TaskContext({ task }: { task: Task }) {
  return (
    <p className="task-context" data-testid="task-context">
      {contextWords(task.context)}
    </p>
  );
}

const STAMP_GAP_MS = 10 * 60_000;

/** What the reading of an action needs beyond each call: the bots' names, as the cards name them. */
function useReading(): ReadingContext {
  const bots = useClawtrateState().bots;
  return useMemo(
    () => ({ botName: (id: string) => bots.find((each) => each.id === id)?.name ?? null }),
    [bots],
  );
}

/** How close to the end counts as "reading the latest", in pixels. */
const NEAR_BOTTOM_PX = 96;

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
 * undocking Work, or resizing the window, late reflows such as fonts
 * arriving, and any change of content above or below it. A reader following the end stays at the end. Otherwise the text
 * at the reading line, just under the protected band at the top, stays where
 * it was while the lines reflow around it: the exact character when the
 * engine can say which, or else the start of its paragraph, list item or row.
 */
function useHoldPlace(
  scroller: RefObject<HTMLDivElement | null>,
  following: RefObject<boolean>,
  toEnd: () => void,
  /** Set when the transcript's content or size changes: only then can a scroll be a clamp. */
  layoutChanged: RefObject<boolean>,
) {
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let place: { block: Element; caret: Caret | null; top: number } | null = null;
    // Where the hold last put the scroll, until that scroll is reported.
    let held: number | null = null;

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
      const next = { block, caret, top: 0 };
      next.top = (drawnAt(next) ?? rect.top) - top;
      place = next;
    };

    /** Put the held text back where it was drawn: the layout moved under it, not the reader. */
    const hold = () => {
      if (!place) return;
      const now = drawnAt(place);
      if (now === null) return;
      const was = element.scrollTop;
      element.scrollTop += now - frame().top - place.top;
      if (element.scrollTop !== was) held = element.scrollTop;
    };

    // Watching the content too covers late reflows, such as fonts arriving, and every
    // change of content: a step becoming a card, a card arriving or resolving above.
    const observer = new ResizeObserver(() => {
      layoutChanged.current = true;
      if (following.current) toEnd();
      else hold();
      record();
    });
    // A scroll is reported a frame after it happens. The hold's own is no new place of the
    // reader's: a change committed before it is reported, such as an effect opening a part of
    // a fold or a pane docking, has moved the layout again, and is held too, before the place
    // is recorded. Any other scroll, the reader's or a control brought into view, is where the
    // reader now is.
    const onScroll = () => {
      const own = held !== null && Math.abs(element.scrollTop - held) <= 0.5;
      held = null;
      if (own && !following.current) hold();
      record();
    };
    // A change of content that moves the reading line without changing any size (a box above
    // growing as much as one below shrinks) is held too.
    const contentChange = new MutationObserver(() => {
      layoutChanged.current = true;
      if (following.current) return;
      hold();
      record();
    });
    record();
    observer.observe(element);
    if (element.firstElementChild) {
      observer.observe(element.firstElementChild);
      contentChange.observe(element.firstElementChild, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["open", "class", "style", "hidden"],
      });
    }
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      contentChange.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, [scroller, following, toEnd, layoutChanged]);
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
  const reading = useReading();
  const live = buildLive(bot, task, transcript, { ...liveOptions, reading });
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

  // The reader's own input, or a jump the page makes for them, marks the next scroll as theirs
  // for a moment. A scroll without it is a layout pass, which never stops following.
  const scrollIntentUntil = useRef(0);
  const layoutChanged = useRef(false);
  const markScrollIntent = useCallback(() => {
    scrollIntentUntil.current = performance.now() + 750;
  }, []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.addEventListener("clawtrate:transcript-navigation", markScrollIntent);
    return () => element.removeEventListener("clawtrate:transcript-navigation", markScrollIntent);
  }, [markScrollIntent]);

  // What the reader has just opened stays in view (section 18): following the
  // end never pushes the line of a card, a fold or a row they opened above the
  // top of the view. That line is held at the top instead, and the reader is
  // no longer following.
  const opened = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onToggle = (event: Event) => {
      const details = event.target as HTMLDetailsElement;
      if (details.open && details.contains(document.activeElement)) opened.current = details;
    };
    element.addEventListener("toggle", onToggle, true);
    return () => element.removeEventListener("toggle", onToggle, true);
  }, []);
  const follow = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const held = opened.current;
    const line =
      held?.isConnected && held.open ? (held.querySelector(":scope > summary") ?? held) : null;
    const inner = element.firstElementChild;
    const band = inner ? Number.parseFloat(getComputedStyle(inner).paddingTop) || 0 : 0;
    const lineTop = () => element.getBoundingClientRect().top + band;
    // Only a line in view is held: one the reader has scrolled away from is not theirs to keep.
    const inView = line !== null && line.getBoundingClientRect().top >= lineTop() - 1;
    toEnd();
    if (!line || !inView) return;
    const over = lineTop() - line.getBoundingClientRect().top;
    if (over <= 0) return;
    element.scrollTop -= over;
    followTop.current = null;
    following.current = false;
    setAtEnd(false);
  }, [toEnd]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const element = scroller.current;
      if (!element) return;
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      // A layout pass can clamp the scroll only when the layout changed: a scroll with no change
      // of content or size since the last one moved the view for the reader.
      const layoutPass = layoutChanged.current;
      layoutChanged.current = false;
      const readerMoved =
        !event.nativeEvent.isTrusted ||
        performance.now() <= scrollIntentUntil.current ||
        !layoutPass;
      const kept =
        following.current &&
        followTop.current !== null &&
        (!readerMoved || element.scrollTop >= followTop.current - 1);
      const near = kept || distance < NEAR_BOTTOM_PX;
      if (kept && distance > 1) toEnd();
      else followTop.current = near ? element.scrollTop : null;
      following.current = near;
      setAtEnd(near);
      if (near) setSeenSize(contentSize);
    },
    [contentSize, toEnd],
  );

  const jumpToLatest = useCallback(() => {
    following.current = true;
    toEnd();
    setAtEnd(true);
    setSeenSize(contentSize);
  }, [contentSize, toEnd]);

  // Follow new output while the reader is at the end.
  useLayoutEffect(() => {
    if (atEnd) follow();
  }, [contentSize, atEnd, follow]);

  useHoldPlace(scroller, following, follow, layoutChanged);

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
      <CardSlot key={item.id} item={item}>
        {item.role === "system" ? (
          <p className="event-line" data-side="center">
            {item.blocks.map((block) => (block.kind === "text" ? block.text : "")).join(" ")}
          </p>
        ) : (
          <Turn item={item} incomplete={live.incomplete.has(item.id)} />
        )}
      </CardSlot>,
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
        onWheelCapture={(event) => {
          if (event.deltaY < 0) markScrollIntent();
        }}
        onTouchMoveCapture={markScrollIntent}
        onPointerDownCapture={(event) => {
          if (event.target === event.currentTarget) markScrollIntent();
        }}
        onKeyDownCapture={(event) => {
          if (
            ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
            (event.shiftKey && event.key === " ")
          )
            markScrollIntent();
        }}
        tabIndex={0}
        role="region"
        aria-label="Transcript"
        data-testid="transcript"
      >
        <div className="transcript-inner">
          <CardScope taskKey={task.key} transcript={transcript}>
            <ActionScope
              taskKey={task.key}
              transcript={transcript}
              engineRuns={live.engineRuns}
              lost={!liveOptions.connected}
              readOnly={!liveOptions.interactive}
              effort={task.effort ?? null}
              ctx={reading}
            >
              <h1 className="task-line" tabIndex={-1}>
                {task.title}
              </h1>
              <TaskContext task={task} />
              {note}
              {rows}
              <TrailingCards except={live.drawsCards} />
              {live.foot}
            </ActionScope>
          </CardScope>
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
  /** Runs whose cards the foot draws under their message, so the trailing cards leave them out. */
  drawsCards: Set<string>;
  /** Runs drawn from the engine's state rather than from history. */
  engineRuns: Run[];
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
  /** What the reading needs beyond each call, as the cards read it. */
  reading?: ReadingContext;
  connected: boolean;
  interactive: boolean;
  /** Ask for the interactive tier; null where the host never asks (pinned read-only). */
  onRequestAccess: (() => void) | null;
  /** Bring the running action's card into view; false when there is none. */
  onShowAction: (callId: string) => boolean;
  onReview: () => void;
  leaving: { key: string; run: Run } | null;
};

function buildLive(bot: Bot, task: Task, transcript: Transcript, options: LiveOptions): LiveParts {
  const active = currentRun(transcript);
  const foot: ReactNode[] = [];
  const placed = new Set<string>();
  const endingsBefore = new Map<string | null, ReactNode[]>();
  const incomplete = new Set<string>();
  const drawsCards = new Set<string>();
  const shown = new Set(transcript.items.map((item) => item.id));
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
      <RunLine key={`line-${run.id}`} run={run} />,
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

  const engineRuns: Run[] = [];
  for (const run of footRuns) {
    if (run.messageId) bubble(run.messageId);
    const held = run === active || heldByEngine(run, transcript);
    if (held) {
      // The run's record, from the engine: its action cards, the cards at their calls,
      // its text beside calls, its reply.
      engineRuns.push(run);
      drawsCards.add(run.id);
      foot.push(
        <RunFeed key={`feed-${run.id}`} runId={run.id} reply={(each) => <RunReply run={each} />} />,
      );
    } else if (!run.anchorItemId || !shown.has(run.anchorItemId)) {
      // A run whose message history does not show yet is drawn from the engine's record, its
      // actions with its cards, under that message: what the engine holds is never left out.
      engineRuns.push(run);
      drawsCards.add(run.id);
      foot.push(
        <RunFeed key={`feed-${run.id}`} runId={run.id} reply={(each) => <RunReply run={each} />} />,
      );
    }
    signature.push(
      `${run.id}:${run.state}:${run.text.length}:${run.steps.map((step) => step.status[0]).join("")}:${run.preambles?.length ?? 0}`,
    );
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
        <RunLine key={`line-${run.id}`} run={run} />,
      );
    }
  }
  for (const message of outgoingBubbles(transcript)) bubble(message.id);

  let status: StatusLineView | null = null;
  if (active) {
    status = statusLineFor(active, transcript, options);
    const running = status.callId;
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
        onShow={running ? () => options.onShowAction(running) : null}
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

  const needsYou = options.interactive && oldestPending(transcript) !== null;
  return {
    bot,
    foot,
    endingsBefore,
    incomplete,
    drawsCards,
    engineRuns,
    signature: signature.join("|"),
    status,
    needsYou,
    onReview: options.onReview,
  };
}

/** The oldest card that needs the person, which "Review" and ⌘J go to: the cards' own choice. */
function needsYouOf(bot: Bot, transcript: Transcript | undefined, interactive: boolean): NeedsYou {
  if (!transcript || !interactive) return null;
  const oldest = oldestPending(transcript);
  if (oldest?.kind === "approval")
    return { kind: "approval", text: `${bot.name} needs your approval to run a command` };
  if (oldest?.kind === "question")
    return { kind: "question", text: `${bot.name} asked you a question` };
  return null;
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
  const [finding, setFinding] = useState(false);
  const findOpener = useRef<HTMLElement | null>(null);
  const canFind = task !== null && itemCount + (transcript?.live ? 1 : 0) > 0;

  // Cmd/Ctrl+F finds in the open conversation, while one is on screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "f" || inert || !canFind) return;
      if (!sectionRef.current?.checkVisibility()) return;
      event.preventDefault();
      if (!finding) findOpener.current = document.activeElement as HTMLElement | null;
      setFinding(true);
      sectionRef.current.querySelector<HTMLInputElement>(".find-bar input")?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inert, canFind, finding]);

  const closeFind = useCallback(() => {
    setFinding(false);
    const opener = findOpener.current;
    findOpener.current = null;
    requestAnimationFrame(() => {
      if (opener?.isConnected && opener !== document.body) opener.focus();
      else sectionRef.current?.querySelector<HTMLElement>(".transcript")?.focus();
    });
  }, []);

  const pillName = bot
    ? task
      ? `${bot.name}, ${task.title}. Show details.`
      : `${bot.name}, no task selected. Show details.`
    : "";

  const active = currentRun(transcript);
  const review = useCallback(() => {
    const oldest = transcript ? oldestPending(transcript) : null;
    if (oldest) focusPending(oldest);
  }, [transcript]);
  // The status line brings the running action's card into view and focuses its line (7.8).
  const onShowAction = useCallback(
    (callId: string) => showAction(callId, sectionRef.current ?? document),
    [],
  );

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

  // ⌘J goes to what needs you. The listener is attached once, before the first paint, and
  // reads the latest `review` when the key comes: a card on screen is always the one it finds,
  // never a transcript from before that card arrived.
  const latestReview = useRef(review);
  useLayoutEffect(() => {
    latestReview.current = review;
  }, [review]);
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "j" &&
        reachable(sectionRef.current?.querySelector("[data-testid=transcript]") ?? null)
      ) {
        event.preventDefault();
        latestReview.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
            <TaskContext task={task} />
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
          onShowAction,
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
      ref={sectionRef}
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
        {finding && canFind ? (
          <FindBar scope={sectionRef} onClose={closeFind} />
        ) : bot ? (
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
