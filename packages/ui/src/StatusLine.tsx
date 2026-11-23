import type { Bot, Run } from "@clawtrate/core";
import { useEffect, useState } from "react";
import { Presence } from "./Avatar.tsx";
import { elapsed, type StatusLineView } from "./live.ts";

/** The wall-clock time, every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * The last thing in a running turn (conversation.md, section 5): the bot's
 * avatar at 28 px and one short phrase, with the elapsed time. While an
 * action's card can be brought into view it is one button that does so,
 * moving focus to the card's line without opening it (7.8), and says so in its
 * name. With nothing to bring into view (no action running, or no card while
 * commands are hidden, 7.11) it is a plain line, not a tab stop, named by the
 * state and the phrase. Under it, without commands shown, is what the bot is
 * thinking. A new phrase rises in; under reduced motion it is replaced at once.
 */
export function StatusLine({
  bot,
  view,
  onShow,
}: {
  bot: Bot;
  view: StatusLineView;
  onShow: (() => void) | null;
}) {
  const now = useNow(view.startedAt !== null);
  const shown = view.startedAt !== null ? elapsed(now - view.startedAt) : null;
  const words = view.state === "waiting" ? "waiting for you" : view.state;
  const said = `${bot.name}, ${words}${view.phrase.toLowerCase() === words ? "" : `: ${view.phrase}`}`;
  const parts = (
    <>
      <Presence bot={bot} state={view.state} badge={view.badge} hidden />
      <span className="status-phrase" key={view.phrase} data-testid="status-phrase">
        {view.phrase}
      </span>
      {shown && (
        <span className="status-elapsed" aria-hidden="true">
          {shown}
        </span>
      )}
    </>
  );
  const common = {
    className: "status-line",
    "data-state": view.state,
    "data-tone": view.tone,
    "data-testid": "status-line",
    title: view.phrase,
  };
  const line = onShow ? (
    <button
      type="button"
      {...common}
      aria-label={`${bot.name}, ${words}: ${view.phrase}. Show the action.`}
      onClick={onShow}
    >
      {parts}
    </button>
  ) : (
    // Nothing to bring into view: a plain line, not a control (7.11).
    <div {...common} role="group" aria-label={`${said}.`}>
      {parts}
    </div>
  );
  // Without commands shown, what the bot is thinking, as it thinks (7.11). Its latest words
  // are at the bottom, so the line keeps its last three lines.
  if (!view.thought) return line;
  return (
    <>
      {line}
      <p className="status-thought" data-testid="status-thought">
        <span>{view.thought}</span>
      </p>
    </>
  );
}

/**
 * The status line of a run that has just ended: drawn once more for its
 * 200 ms fade, then gone. A run that ended before this was first drawn (a
 * task opened later) has nothing to fade, nor has anything under reduced
 * motion; nothing waits on it.
 */
export function LeavingStatusLine({
  bot,
  run,
  view,
}: {
  bot: Bot;
  run: Run;
  view: StatusLineView;
}) {
  const [gone, setGone] = useState(
    () => reducedMotion() || run.endedAt === null || Date.now() - run.endedAt > 1500,
  );
  useEffect(() => {
    const timer = setTimeout(() => setGone(true), 200);
    return () => clearTimeout(timer);
  }, []);
  if (gone) return null;
  return (
    <div className="status-line" data-state={view.state} data-leaving="true" aria-hidden="true">
      <Presence bot={bot} state={view.state} badge={view.badge} hidden />
      <span className="status-phrase">{view.phrase}</span>
    </div>
  );
}

/** Reduced motion, from the system or from the app's own setting. */
function reducedMotion(): boolean {
  return (
    document.documentElement.dataset.motion === "reduce" ||
    (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}
