// A name a bot took for itself (F-552): one line in its conversation saying what happened, with
// Undo, and its recent name changes in its settings. Applied at once, never asked about ("Doing,
// not asking"); the line says what happened and never that the person asked. A name is text a
// bot wrote, so it is only ever shown as text.

import {
  canUndoName,
  type Bot,
  type NameLine as Line,
  type NameRecordChange,
} from "@clawtrate/core";
import { useState } from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { useNow } from "../StatusLine.tsx";
import { CloseIcon } from "../icons.tsx";

const SOURCE: Record<string, string> = {
  web: " after reading a web page",
  file: " after reading a file",
  tool: " after a tool's output",
};

/** What the line says, by what happened; `from` and `to` are plain text, shown isolated. */
function words(line: Line) {
  const from = <bdi>{line.from}</bdi>;
  const to = <bdi className="name-line-name">{line.to}</bdi>;
  switch (line.status) {
    case "renaming":
      return (
        <>
          Renaming {from} to {to}…
        </>
      );
    case "renamed":
      return line.asked ? (
        <>Renamed to {to}</>
      ) : (
        <>
          {from} renamed itself to {to}
          {SOURCE[line.source ?? ""] ?? ""}
        </>
      );
    case "undoing":
      return <>Putting back {from}…</>;
    case "undone":
      return (
        <>
          Back to {from}. {to} isn't used again unless you rename it yourself.
        </>
      );
    case "failed":
      return (
        <>
          Couldn't rename {from} to {to}: {line.error}
        </>
      );
    case "not-done":
      return line.reason === "taken" ? (
        <>
          {from} wrote “{to}” as its new name, which another bot has, so its name stays {from}.
        </>
      ) : line.reason === "limit" ? (
        <>
          {from} wrote a new name for itself, {to}, but it was already renamed 3 times today, so its
          name stays {from}.
        </>
      ) : line.reason === "no-admin" ? (
        <>
          {from} wrote a new name for itself, {to}. Renaming needs admin access, which this
          connection doesn't have.
        </>
      ) : (
        <>
          {from} wrote a new name for itself, {to}. This connection can't keep the way back to{" "}
          {from} on the gateway, so its name stays as it is.
        </>
      );
  }
}

export function NameLine({ bot, onAnnounce }: { bot: Bot; onAnnounce: (text: string) => void }) {
  const state = useClawtrateState();
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  // Ticks while a line is up, so Undo goes at the end of its window.
  const now = useNow(!!state.botNames?.some((each) => each.botId === bot.id));
  const line = state.botNames?.find((each) => each.botId === bot.id);
  if (!line) return null;
  const changes = state.botNameRecord?.changes ?? [];
  const change = changes.find((each) => each.run === line.run);
  const undoable =
    line.status === "renamed" && !!change && canUndoName(change, changes, state.bots, now);
  const undo = async () => {
    setBusy(true);
    try {
      await bridge.invoke({ type: "undoBotName", botId: bot.id, run: line.run, stamp: line.stamp });
      onAnnounce(`Back to ${line.from}`);
    } catch (error) {
      onAnnounce(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="c-composer-notes">
      <section
        className="c-composer-note name-line"
        data-tone={line.status === "failed" ? "danger" : "neutral"}
        aria-label={`${bot.name}'s name`}
        data-testid="name-line"
      >
        <p className="name-line-words" role="status">
          {words(line)}
        </p>
        <div className="name-line-actions">
          {undoable && (
            <button
              type="button"
              className="button"
              data-size="sm"
              disabled={busy}
              aria-label={`Undo: back to ${line.from}`}
              onClick={() => void undo()}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label="Close"
            onClick={() => void bridge.invoke({ type: "dismissBotName", botId: bot.id })}
          >
            <CloseIcon />
          </button>
        </div>
      </section>
    </div>
  );
}

/** A bot's recent name changes in its settings, with Undo where it can still be undone. */
export function NameChanges({ bot }: { bot: Bot }) {
  const state = useClawtrateState();
  const bridge = useBridge();
  const [problem, setProblem] = useState<string | null>(null);
  const now = useNow(!!state.botNameRecord?.changes.some((each) => each.bot === bot.id));
  const record = state.botNameRecord;
  const changes = record?.changes ?? [];
  const mine = changes.filter((each) => each.bot === bot.id);
  if (!record || mine.length === 0) return null;
  const undo = async (change: NameRecordChange) => {
    setProblem(null);
    try {
      await bridge.invoke({
        type: "undoBotName",
        botId: bot.id,
        run: change.run,
        stamp: record.stamp,
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const time = (at: number) =>
    new Date(at).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  return (
    <>
      <h4 className="b-group">Recent changes</h4>
      <ul className="name-changes" data-testid="name-changes">
        {[...mine].reverse().map((change) => (
          <li key={change.run}>
            <span>
              {change.undone === undefined ? "Renamed" : "Put back to"}{" "}
              {change.undone === undefined ? (
                <>
                  from <bdi>{change.from}</bdi> to <bdi>{change.to}</bdi>
                </>
              ) : (
                <bdi>{change.from}</bdi>
              )}
              {change.asked ? "" : ", by the bot itself"} · {time(change.undone ?? change.at)}
            </span>
            {canUndoName(change, changes, state.bots, now) && (
              <button
                type="button"
                className="button"
                data-size="sm"
                aria-label={`Undo: back to ${change.from}`}
                onClick={() => void undo(change)}
              >
                Undo
              </button>
            )}
          </li>
        ))}
      </ul>
      {problem && (
        <p className="b-hint" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}
