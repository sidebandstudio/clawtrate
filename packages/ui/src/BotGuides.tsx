// "Bots know how Clawtrate works" (#532, #544, #628): Clawtrate's guides as a marked section at
// the top of each bot's AGENTS.md (core guides.ts). On by default: the client adds it by itself,
// with nothing asked. Settings, Conversation has one switch that turns it off (taking it out of
// every bot) and on again, Read it, and a row for each bot whose file isn't simply as Clawtrate
// keeps it, as the gateway's files read now, with its single action. Nothing here is announced
// that wasn't read back.

import {
  GUIDES_SECTION,
  guidesOn,
  type Bot,
  type BotGuidesAnswer,
  type GatewayStamp,
  type GuideFolder,
  type GuidesChange,
} from "@clawtrate/core";
import { useEffect, useRef, useState } from "react";
import { useBridge, useClawtrateState } from "./bridge.tsx";
import { ChevronIcon } from "./icons.tsx";

const names = (bots: readonly Bot[], ids: string[]) =>
  ids.map((id) => bots.find((bot) => bot.id === id)?.name ?? id);
const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * A folder's row: what its state says, and its one action, if any, or null when the folder is
 * simply as Clawtrate keeps it and gets no row. `on` is the switch; `admin`, whether this
 * connection can write.
 */
export function guideRow(
  folder: GuideFolder,
  label: string,
  on: boolean,
  admin: boolean,
): { words: string; action: "add" | "update" | "replace" | "remove" | "show" | null } | null {
  const can = (action: "add" | "update" | "replace" | "remove") => (admin ? action : null);
  // A file that isn't plain UTF-8 is never written: it says so, and offers nothing that writes.
  const notUtf8 = `${label}'s AGENTS.md isn't plain UTF-8 text, so Clawtrate can't change it. Save it as UTF-8 and Clawtrate can add, update or remove its section again.`;
  const long = `Its instructions are long: with this section, the gateway may leave part of them out of ${label}'s prompt, so Clawtrate doesn't add it by itself.`;
  switch (folder.state) {
    case null:
      return {
        words: `Couldn't read its instructions file. ${folder.error ?? ""}`.trim(),
        action: null,
      };
    case "current":
      if (on) return null;
      return folder.utf8
        ? { words: "Still has Clawtrate's section.", action: can("remove") }
        : { words: notUtf8, action: null };
    case "older":
      if (!folder.utf8) return { words: notUtf8, action: null };
      if (!on)
        return {
          words: "Still has an older version of Clawtrate's section.",
          action: can("remove"),
        };
      return {
        words: folder.long
          ? "An older version. Its instructions are long, so Clawtrate doesn't update it by itself."
          : "An older version.",
        action: can("update"),
      };
    case "changed":
      return {
        words: folder.moved
          ? "Its section isn't at the top, where Clawtrate put it, so Clawtrate leaves it as it is. Move it back to the top, or remove it yourself."
          : folder.replaceable
            ? "Changed outside Clawtrate, so Clawtrate leaves it as it is."
            : "Its markers aren't as Clawtrate wrote them, so Clawtrate can't tell where its section ends. Edit the file, or remove the section's text yourself.",
        action: on && folder.replaceable && folder.utf8 && admin ? "replace" : "show",
      };
    case "removed":
      if (!on) return null;
      return {
        words: "Removed outside Clawtrate, so Clawtrate doesn't add it again by itself.",
        action: folder.utf8 ? can("add") : null,
      };
    case "none":
      if (!on) return null;
      if (!folder.utf8) return { words: notUtf8, action: null };
      return { words: folder.long ? long : "Not added yet.", action: can("add") };
  }
}

/** Whether an answer is the connected gateway's own (`GatewayStamp`): only that one is shown. */
export const forConnection = (
  stamp: GatewayStamp | undefined,
  connection: { gatewayId: string | null; target: number },
) => stamp?.gatewayId === connection.gatewayId && stamp.target === connection.target;

/**
 * What a change's answer does to the pane: shown when it is the connected gateway's; when the
 * connection moved while the change ran, it is the earlier gateway's, so the pane reads the
 * gateway now on screen again instead, and the change says nothing here.
 */
export const afterChange = (
  read: BotGuidesAnswer,
  connection: { gatewayId: string | null; target: number },
): { show: BotGuidesAnswer } | { readAgain: true } =>
  forConnection(read.stamp, connection) ? { show: read } : { readAgain: true };

/** The guides as the connected gateway reads them now, and a way to change them. */
function useGuides() {
  const bridge = useBridge();
  const { connection } = useClawtrateState();
  const connected = connection.status === "connected";
  const [answer, setAnswer] = useState<BotGuidesAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reads, setReads] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    // Set again on each setup: development builds run an effect's cleanup and setup twice.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The connection as it is when a change finishes, not as it was when it was sent.
  const now = useRef(connection);
  useEffect(() => {
    now.current = connection;
  });
  useEffect(() => {
    if (!connected) return;
    let live = true;
    bridge.invoke({ type: "readBotGuides" }).then(
      (read) => {
        if (!live) return;
        setAnswer(read);
        setError(null);
      },
      (failure: unknown) =>
        live && setError(failure instanceof Error ? failure.message : String(failure)),
    );
    return () => {
      live = false;
    };
  }, [bridge, connected, reads, connection.connectedAt, connection.gatewayId, connection.target]);
  // Only the connected gateway's own answer is shown (`GatewayStamp`).
  const shown = answer && forConnection(answer.stamp, connection) ? answer : null;
  const change = (next: GuidesChange) => {
    if (!shown) return Promise.resolve(null);
    setBusy(true);
    setError(null);
    return bridge.invoke({ type: "changeBotGuides", change: next, stamp: shown.stamp }).then(
      (read) => {
        if (!mounted.current) return null;
        setBusy(false);
        const next = afterChange(read, now.current);
        if ("readAgain" in next) {
          setReads((n) => n + 1);
          return null;
        }
        setAnswer(next.show);
        return next.show;
      },
      (failure: unknown) => {
        if (!mounted.current) return null;
        setBusy(false);
        setError(failure instanceof Error ? failure.message : String(failure));
        setReads((n) => n + 1);
        return null;
      },
    );
  };
  return { shown, error, busy, change, retry: () => setReads((n) => n + 1), connected };
}

/** Settings, Conversation: the switch, Read it, and the bots that need a look. */
export function BotGuidesPane({ announce }: { announce: (text: string) => void }) {
  const { connection, bots } = useClawtrateState();
  const guides = useGuides();
  const admin = connection.canAdmin;
  const [showing, setShowing] = useState<string | null>(null);
  const { shown } = guides;
  if (!shown)
    return (
      <div className="bot-guides" data-testid="bot-guides">
        {guides.error ? (
          <div className="b-note" data-tone="danger" role="alert">
            <div>
              <p>Couldn't read the bots' instructions. {guides.error}</p>
              <div className="b-actions">
                <button type="button" className="button" onClick={guides.retry}>
                  Try again
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="b-hint">
            {guides.connected
              ? "Reading the bots' instructions from the gateway…"
              : "The bots' instructions are read once Clawtrate is connected."}
          </p>
        )}
      </div>
    );
  const folders = shown.folders;
  const on = guidesOn(shown.record);
  /** Whether each of these bots' folders reads this version now, as read back. */
  const allCurrent = (read: BotGuidesAnswer, ids: string[]) =>
    ids.length > 0 &&
    ids.every((id) => read.folders.find((f) => f.bots.includes(id))?.state === "current");
  const turn = (next: boolean) =>
    void guides.change({ action: "switch", on: next }).then((read) => {
      // Announced only when the files, read back, hold what was asked.
      if (!read || read.errors.length > 0 || guidesOn(read.record) !== next) return;
      announce(next ? "Bots now know how Clawtrate works" : "Taken out of every bot");
    });
  const rows = folders.flatMap((folder) => {
    const label = list(names(bots, folder.bots));
    const row = guideRow(folder, label, on, admin);
    return row ? [{ folder, label, ...row }] : [];
  });
  return (
    <div className="bot-guides" data-testid="bot-guides">
      <div className="facts">
        <div className="b-row">
          <span className="b-row-main">
            <span id="bot-guides-label">Bots know how Clawtrate works</span>
            <small data-testid="bot-guides-state">{on ? "On" : "Off"}</small>
          </span>
          <button
            type="button"
            className="b-switch"
            role="switch"
            aria-checked={on}
            aria-labelledby="bot-guides-label"
            aria-describedby="bot-guides-note"
            aria-busy={guides.busy || undefined}
            aria-disabled={guides.busy || undefined}
            disabled={!admin}
            data-testid="bot-guides-switch"
            onClick={() => {
              if (!guides.busy) turn(!on);
            }}
          />
        </div>
      </div>
      <p className="b-hint" id="bot-guides-note">
        Clawtrate keeps a short section at the top of each bot's <code>AGENTS.md</code> that tells
        it how to talk to you and what a task is in Clawtrate.
        {!admin &&
          " This connection doesn't have admin access, so Clawtrate can't add or remove it from here."}
      </p>
      <details className="b-disclosure" data-testid="bot-guides-text">
        <summary>
          <ChevronIcon />
          Read it
        </summary>
        <div className="b-disclosure-body">
          <pre className="bot-guides-text">{GUIDES_SECTION}</pre>
        </div>
      </details>
      {rows.length > 0 && (
        <ul className="bot-guides-list" aria-labelledby="bot-guides-label">
          {rows.map(({ folder, label, words, action }) => {
            const key = folder.bots.join(",");
            return (
              <li key={key} data-testid={`bot-guide-${folder.bots[0]}`} data-state={folder.state}>
                <span className="bot-guides-row">
                  {label}
                  {folder.bots.length > 1 && " (one shared folder)"}
                  <small>{words}</small>
                </span>
                {action && (
                  <div className="b-actions">
                    {action === "show" || action === "replace" ? (
                      <button
                        type="button"
                        className="button"
                        data-size="sm"
                        aria-expanded={showing === key}
                        onClick={() => setShowing(showing === key ? null : key)}
                      >
                        {showing === key ? "Hide" : "Show"}
                      </button>
                    ) : null}
                    {action !== "show" && (
                      <button
                        type="button"
                        className="button"
                        data-size="sm"
                        disabled={guides.busy}
                        onClick={() => {
                          if (action === "remove") return turn(false);
                          void guides
                            .change(
                              action === "replace"
                                ? {
                                    action: "replace",
                                    bot: folder.bots[0]!,
                                    shown: folder.changedText ?? "",
                                  }
                                : { action: "add", bots: folder.bots },
                            )
                            .then(
                              (read) =>
                                read &&
                                read.errors.length === 0 &&
                                allCurrent(read, folder.bots) &&
                                announce(`Added to ${label}`),
                            );
                        }}
                      >
                        {action === "add"
                          ? "Add"
                          : action === "update"
                            ? "Update"
                            : action === "replace"
                              ? "Replace"
                              : "Remove"}
                      </button>
                    )}
                  </div>
                )}
                {showing === key && folder.changedText !== null && (
                  <pre className="bot-guides-text" data-testid="bot-guide-changed">
                    {folder.changedText}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {on &&
        shown.voicePlugin &&
        folders.some(
          (f) => f.state === "current" || f.state === "older" || f.state === "changed",
        ) && (
          <p className="b-hint" data-testid="bot-guides-voice">
            The voice plugin also adds the voice guide to every bot, so a bot with this section gets
            it twice. You can turn the plugin's guide off with the Bot voice switch above. Bots
            without this section then get no voice guide.
          </p>
        )}
      {(guides.error ?? (shown.errors.length > 0 ? shown.errors.join(" ") : null)) && (
        <div className="form-error" role="alert" data-testid="bot-guides-error">
          {guides.error ?? shown.errors.join(" ")}
        </div>
      )}
    </div>
  );
}
