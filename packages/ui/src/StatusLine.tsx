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
 * avatar at 28 px and one short phrase, with the elapsed time. One button:
 * it brings the running action's card into view and moves focus to its line,
 * without opening it (7.8), and says so in its name; with no action running
 * it does nothing and says that. A new phrase rises in; under reduced motion
 * it is replaced at once.
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
  return (
    <button
      type="button"
      className="status-line"
      data-state={view.state}
      data-tone={view.tone}
      data-testid="status-line"
      title={view.phrase}
      aria-label={
        onShow
          ? `${bot.name}, ${words}: ${view.phrase}. Show the action.`
          : `${bot.name}, ${words}${view.phrase.toLowerCase() === words ? "" : `: ${view.phrase}`}. Nothing running to show.`
      }
      onClick={onShow ?? undefined}
    >
      <Presence bot={bot} state={view.state} badge={view.badge} hidden />
      <span className="status-phrase" key={view.phrase} data-testid="status-phrase">
        {view.phrase}
      </span>
      {shown && (
        <span className="status-elapsed" aria-hidden="true">
          {shown}
        </span>
      )}
    </button>
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
