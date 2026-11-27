// A name a bot took for itself (F-552): one line in its conversation saying what happened, with
// Undo, and its recent name changes in its settings. Applied at once, never asked about ("Doing,
// not asking"). The line has three forms, by whose the rename was (`NameWhose`): the person's own
// ask, the bot renaming itself, or a name picked up from its identity file. Undo names the name it
// puts back, and is offered only where the connection may change bots. A name is text a bot wrote,
// so it is only ever shown as text.

import {
  canUndoName,
  type Bot,
  type NameLine as Line,
  type NameRecordChange,
  shownChanges,
} from "@clawtrate/core";
import { useEffect, useRef, useState } from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { useNow } from "../StatusLine.tsx";
import { CloseIcon } from "../icons.tsx";

const SOURCE: Record<string, string> = {
  web: " after reading a web page",
  file: " after reading a file",
  conversation: " after reading another conversation",
  tool: " after a tool's output",
  attachment: " after reading a file you sent",
};

/**
 * What an undone line says: "Back to …" only when the name the gateway lists now is the one Undo
 * put back; otherwise what it lists. Then the engine's warning, when Undo's record couldn't be
 * kept on the gateway.
 */
export function undoneText(line: Pick<Line, "from" | "after" | "error">): string {
  const said =
    line.after === line.from
      ? `Back to ${line.from}.`
      : line.after === null
        ? `Undo sent ${line.from}; the gateway's bot list doesn't show it yet.`
        : `Undo sent ${line.from}, but the gateway lists the bot as ${line.after}.`;
  return line.error ? `${said} ${line.error}` : said;
}

/** Whether this connection may change bots: Undo is offered only where it can work. */
function useCanRename(): boolean {
  const { connection } = useClawtrateState();
  const { info } = useBridge();
  return connection.status === "connected" && connection.canAdmin && !info.readOnly;
}

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
      return line.whose === "person" ? (
        <>Renamed to {to}</>
      ) : line.whose === "bot" ? (
        <>
          {from} renamed itself to {to}
          {SOURCE[line.source ?? ""] ?? ""}
        </>
      ) : (
        <>
          {from} is now {to}, the name in its identity file
        </>
      );
    case "undoing":
      return <>Putting back {from}…</>;
    case "undone":
      return <>{undoneText(line)}</>;
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
      ) : line.reason === "full" ? (
        <>
          {from} wrote a new name for itself, {to}, but too many bots were renamed on this gateway
          today for Clawtrate to keep count, so its name stays {from}.
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
  const canRename = useCanRename();
  const [busy, setBusy] = useState(false);
  // Why the last Undo pressed here didn't go through, for the change it was pressed on.
  const [problem, setProblem] = useState<{ run: string; text: string } | null>(null);
  // The change this view pressed Undo for: its outcome is announced once the line says it.
  const pressed = useRef<string | null>(null);
  // Ticks while a line is up, so Undo goes at the end of its window.
  const now = useNow(!!state.botNames?.some((each) => each.botId === bot.id));
  const line = state.botNames?.find((each) => each.botId === bot.id);
  useEffect(() => {
    if (!line || pressed.current !== line.run || line.status !== "undone") return;
    pressed.current = null;
    onAnnounce(undoneText(line));
  }, [line, onAnnounce]);
  if (!line) return null;
  const changes = state.botNameRecord?.changes ?? [];
  const change = changes.find((each) => each.run === line.run);
  const undoable =
    canRename &&
    line.status === "renamed" &&
    !!change &&
    change.from === line.from &&
    canUndoName(change, changes, state.bots, now);
  const undo = async () => {
    setBusy(true);
    setProblem(null);
    // Marked before it is sent: the line may say "undone" before the answer comes.
    pressed.current = line.run;
    try {
      await bridge.invoke({
        type: "undoBotName",
        botId: bot.id,
        run: line.run,
        from: line.from,
        stamp: line.stamp,
      });
    } catch (error) {
      pressed.current = null;
      const text = error instanceof Error ? error.message : String(error);
      setProblem({ run: line.run, text });
      onAnnounce(text);
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
          {/* Shown, and already announced: a screen reader hears it once. */}
          {problem?.run === line.run && line.status === "renamed" && (
            <span aria-hidden="true">. Undo didn't go through: {problem.text}</span>
          )}
        </p>
        <div className="name-line-actions">
          {undoable && (
            <button
              type="button"
              className="button"
              data-size="sm"
              disabled={busy}
              onClick={() => void undo()}
            >
              {/* One run of text: the button lays out its children apart. */}
              <span>
                Undo: back to <bdi>{line.from}</bdi>
              </span>
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label="Close"
            onClick={() =>
              void bridge.invoke({
                type: "dismissBotName",
                botId: bot.id,
                run: line.run,
                stamp: line.stamp,
              })
            }
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
  const canRename = useCanRename();
  const [problem, setProblem] = useState<string | null>(null);
  const now = useNow(!!state.botNameRecord?.changes.some((each) => each.bot === bot.id));
  const record = state.botNameRecord;
  const changes = record?.changes ?? [];
  // Only renames the bot list confirmed, and Undos: a claim that never landed isn't a rename.
  const mine = shownChanges(changes, state.bots).filter((each) => each.bot === bot.id);
  if (!record || mine.length === 0) return null;
  const undo = async (change: NameRecordChange) => {
    setProblem(null);
    try {
      await bridge.invoke({
        type: "undoBotName",
        botId: bot.id,
        run: change.run,
        from: change.from,
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
              {change.whose === "person"
                ? ""
                : change.whose === "bot"
                  ? ", by the bot itself"
                  : ", from its identity file"}{" "}
              · {time(change.undone ?? change.at)}
            </span>
            {canRename && canUndoName(change, changes, state.bots, now) && (
              <button
                type="button"
                className="button"
                data-size="sm"
                onClick={() => void undo(change)}
              >
                {/* One run of text: the button lays out its children apart. */}
                <span>
                  Undo: back to <bdi>{change.from}</bdi>
                </span>
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
