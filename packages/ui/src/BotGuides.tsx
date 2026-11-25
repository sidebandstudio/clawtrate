// "How bots work in Clawtrate" (#532, #544): Clawtrate's guides as a marked section at the top
// of each bot's AGENTS.md (core guides.ts). Settings, Conversation shows each bot's state as the
// gateway's files read now, asks the person's yes before anything is written, and removes it
// again; the rail offers it once per gateway after a connect with admin access. Nothing here is
// announced that wasn't read back.

import {
  GUIDES_SECTION,
  GUIDES_SIZE,
  type Bot,
  type BotGuidesAnswer,
  type GatewayStamp,
  type GuideFolder,
  type GuidesChange,
} from "@clawtrate/core";
import { useEffect, useRef, useState } from "react";
import { useBridge, useClawtrateState } from "./bridge.tsx";
import { ChevronIcon, CloseIcon } from "./icons.tsx";

/** About how many characters the section adds to each prompt, rounded to hundreds. */
const SIZE = `about ${(Math.round(GUIDES_SIZE / 100) * 100).toLocaleString("en-US")}`;

const names = (bots: readonly Bot[], ids: string[]) =>
  ids.map((id) => bots.find((bot) => bot.id === id)?.name ?? id);
const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * What a folder's state says, in a few words. `mine`: this device added it, so this device
 * brings an older version up to date by itself, when that fits and the file can be written.
 */
function stateWords(folder: GuideFolder, mine: boolean): string {
  switch (folder.state) {
    case "current":
      return "Added";
    case "older":
      return !folder.utf8
        ? "An older version."
        : !mine
          ? "An older version. Add brings it up to date."
          : folder.long
            ? "An older version. Its instructions are long, so Clawtrate doesn't update it by itself."
            : "An older version. Clawtrate updates it when it connects with admin access.";
    case "changed":
      return folder.replaceable
        ? "Changed outside Clawtrate, so Clawtrate leaves it as it is."
        : "Its markers aren't as Clawtrate wrote them, so Clawtrate can't tell where its section ends. Edit the file, or remove the section's text yourself.";
    case "removed":
      return "Removed outside Clawtrate. Clawtrate won't add it again unless you ask.";
    case "none":
      return "Not added";
    default:
      return `Couldn't read its instructions file. ${folder.error ?? ""}`.trim();
  }
}

/** The guides as the connected gateway reads them now, and a way to change them. */
function useGuides(active: boolean) {
  const bridge = useBridge();
  const { connection } = useClawtrateState();
  const connected = connection.status === "connected";
  const [answer, setAnswer] = useState<BotGuidesAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reads, setReads] = useState(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!connected || !active) return;
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
  }, [
    bridge,
    connected,
    active,
    reads,
    connection.connectedAt,
    connection.gatewayId,
    connection.target,
  ]);
  // Only the connected gateway's own answer is shown (`GatewayStamp`).
  const here = (stamp: GatewayStamp | undefined) =>
    stamp?.gatewayId === connection.gatewayId && stamp.target === connection.target;
  const shown = answer && here(answer.stamp) ? answer : null;
  const change = (next: GuidesChange) => {
    if (!shown) return Promise.resolve(null);
    setBusy(true);
    setError(null);
    return bridge.invoke({ type: "changeBotGuides", change: next, stamp: shown.stamp }).then(
      (read) => {
        if (!mounted.current) return null;
        setBusy(false);
        setAnswer(read);
        return read;
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

/** Settings, Conversation: each bot's state, the yes, and removal. */
export function BotGuidesPane({ announce }: { announce: (text: string) => void }) {
  const { connection, bots } = useClawtrateState();
  const guides = useGuides(true);
  const admin = connection.canAdmin;
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [newBots, setNewBots] = useState(true);
  const [showing, setShowing] = useState<string | null>(null);
  const { shown } = guides;
  if (!shown)
    return (
      <div className="bot-guides" data-testid="bot-guides">
        <h4 className="b-group">How bots work in Clawtrate</h4>
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
  // A file that isn't plain UTF-8 is never written: it offers nothing that writes.
  const addable = folders.filter(
    (f) => f.utf8 && (f.state === "none" || f.state === "removed" || f.state === "older"),
  );
  /** A file the section would make longer than the gateway keeps whole in a prompt. */
  const long = (f: GuideFolder) => f.long;
  const anyOurs = folders.some((f) => f.utf8 && (f.state === "current" || f.state === "older"));
  /** Whether each of these bots' folders reads this version now, as read back. */
  const allCurrent = (read: BotGuidesAnswer, ids: string[]) =>
    ids.length > 0 &&
    ids.every((id) => read.folders.find((f) => f.bots.includes(id))?.state === "current");
  // Bots with no section at all: an older or a changed one may still say what a task is.
  const untaught = folders
    .filter((f) => f.state === "none" || f.state === "removed" || f.state === null)
    .flatMap((f) => f.bots);
  // Every bot not yet added, or with an older version, is ticked, unless its section was taken
  // out outside Clawtrate or its file is long.
  const ticked =
    chosen ??
    new Set(addable.filter((f) => f.state !== "removed" && !long(f)).flatMap((f) => f.bots));
  const tickedFolders = addable.filter((f) => f.bots.some((bot) => ticked.has(bot)));
  const count = tickedFolders.reduce((n, f) => n + f.bots.length, 0);
  const add = () => {
    const asked = tickedFolders.flatMap((f) => f.bots);
    void guides.change({ action: "add", bots: asked, newBots }).then((read) => {
      setChosen(null);
      // Announced only when the files, read back, hold what was asked.
      if (read && read.errors.length === 0 && allCurrent(read, asked)) announce("Guides added");
    });
  };
  return (
    <div className="bot-guides" data-testid="bot-guides">
      <h4 className="b-group" id="bot-guides-title">
        How bots work in Clawtrate
      </h4>
      <p className="b-hint" data-testid="bot-guides-summary">
        {untaught.length === 0
          ? "Each bot has Clawtrate's guide in its instructions."
          : `${untaught.length === bots.length || bots.length === 0 ? "Your bots aren't" : `${list(names(bots, untaught))} ${untaught.length === 1 ? "isn't" : "aren't"}`} told what a task is in Clawtrate, so a bot asked to put something in a task may not start one.`}
      </p>
      {addable.length > 0 && (
        <p className="b-hint" data-testid="bot-guides-offer">
          Clawtrate can add a short section, marked as Clawtrate's, to the top of each bot's
          instructions file (<code>AGENTS.md</code>): how to talk to you, and what a task is in
          Clawtrate. Your bots get it in every conversation, task and routine, including outside
          Clawtrate. It adds {SIZE} characters to each prompt. Clawtrate keeps it up to date and
          changes nothing else in the file. Remove it here any time, and Clawtrate takes it out.
        </p>
      )}
      <details className="b-disclosure" data-testid="bot-guides-text">
        <summary>
          <ChevronIcon />
          Read it
        </summary>
        <div className="b-disclosure-body">
          <pre className="bot-guides-text">{GUIDES_SECTION}</pre>
        </div>
      </details>
      <ul className="bot-guides-list" aria-labelledby="bot-guides-title">
        {folders.map((folder) => {
          const label = list(names(bots, folder.bots));
          const key = folder.bots.join(",");
          const canAdd = admin && addable.includes(folder);
          const mine = folder.bots.some((bot) => shown.record?.bots.includes(bot) === true);
          const words = stateWords(folder, mine);
          const utf8Words = folder.utf8
            ? null
            : `${label}'s AGENTS.md isn't plain UTF-8 text, so Clawtrate can't change it. Save it as UTF-8 and Clawtrate can add, update or remove its section again.`;
          const longWords =
            canAdd || folder.state === "none" || folder.state === "older"
              ? long(folder)
                ? `Its instructions are long: with this section, the gateway may leave part of them out of ${label}'s prompt.`
                : null
              : null;
          return (
            <li key={key} data-testid={`bot-guide-${folder.bots[0]}`} data-state={folder.state}>
              {canAdd ? (
                <label className="b-delete-check bot-guides-check">
                  <input
                    type="checkbox"
                    checked={folder.bots.some((bot) => ticked.has(bot))}
                    disabled={guides.busy}
                    onChange={(event) => {
                      const next = new Set(ticked);
                      for (const bot of folder.bots)
                        if (event.target.checked) next.add(bot);
                        else next.delete(bot);
                      setChosen(next);
                    }}
                  />
                  <span>
                    {label}
                    {folder.bots.length > 1 && " (one shared folder)"}
                    <small>{words}</small>
                    {longWords && <small data-testid="bot-guide-long">{longWords}</small>}
                    {utf8Words && <small data-testid="bot-guide-utf8">{utf8Words}</small>}
                  </span>
                </label>
              ) : (
                <span className="bot-guides-row">
                  {label}
                  {folder.bots.length > 1 && " (one shared folder)"}
                  <small>{words}</small>
                  {longWords && <small data-testid="bot-guide-long">{longWords}</small>}
                  {utf8Words && <small data-testid="bot-guide-utf8">{utf8Words}</small>}
                </span>
              )}
              {folder.state === "changed" && (
                <div className="b-actions">
                  <button
                    type="button"
                    className="button"
                    data-size="sm"
                    aria-expanded={showing === key}
                    onClick={() => setShowing(showing === key ? null : key)}
                  >
                    {showing === key ? "Hide" : "Show"}
                  </button>
                  {admin && folder.replaceable && folder.utf8 && (
                    <button
                      type="button"
                      className="button"
                      data-size="sm"
                      disabled={guides.busy}
                      onClick={() =>
                        void guides
                          .change({ action: "replace", bot: folder.bots[0]! })
                          .then(
                            (read) =>
                              read &&
                              read.errors.length === 0 &&
                              allCurrent(read, folder.bots) &&
                              announce(`Guides replaced for ${label}`),
                          )
                      }
                    >
                      Replace
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
      {shown.voicePlugin &&
        // Only where a bot has a section, or one is about to be added.
        (folders.some(
          (f) => f.state === "current" || f.state === "older" || f.state === "changed",
        ) ||
          count > 0) && (
          <p className="b-hint" data-testid="bot-guides-voice">
            The voice plugin also adds the voice guide to every bot, so a bot with this section gets
            it twice. You can turn the plugin's guide off with the Bot voice switch above. Bots
            without this section then get no voice guide.
          </p>
        )}
      {admin ? (
        <>
          {addable.length > 0 && (
            <>
              <label className="b-delete-check bot-guides-check">
                <input
                  type="checkbox"
                  checked={newBots}
                  disabled={guides.busy}
                  onChange={(event) => setNewBots(event.target.checked)}
                />
                <span>New bots too, when they're made in Clawtrate</span>
              </label>
              <div className="b-actions">
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  disabled={guides.busy || count === 0}
                  onClick={add}
                >
                  {`Add to ${count} ${count === 1 ? "bot" : "bots"}`}
                </button>
              </div>
            </>
          )}
          {anyOurs && (
            <div className="b-actions">
              <button
                type="button"
                className="button"
                disabled={guides.busy}
                onClick={() =>
                  void guides
                    .change({ action: "remove" })
                    .then((read) => read && read.errors.length === 0 && announce("Guides removed"))
                }
              >
                Remove from all bots
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="b-hint">Adding or removing it needs admin access.</p>
      )}
      {(guides.error ?? (shown.errors.length > 0 ? shown.errors.join(" ") : null)) && (
        <div className="form-error" role="alert" data-testid="bot-guides-error">
          {guides.error ?? shown.errors.join(" ")}
        </div>
      )}
    </div>
  );
}

/**
 * The one-time offer after a connect with admin access, in the rail above the gateway: shown
 * while no bot has the section and this device has no answer for this gateway. Review opens
 * Settings, Conversation; Not now records the answer and writes nothing to the gateway.
 */
export function BotGuidesOffer({ onReview }: { onReview: () => void }) {
  const { connection } = useClawtrateState();
  const active = connection.canAdmin;
  const guides = useGuides(active);
  const [closed, setClosed] = useState(false);
  const { shown } = guides;
  if (
    !active ||
    closed ||
    !shown ||
    shown.record !== null ||
    !shown.folders.every((f) => f.state === "none")
  )
    return null;
  return (
    <div className="rail-notice" data-tone="info" role="status" data-testid="bot-guides-offer-card">
      <span>Teach your bots how Clawtrate works, so "put this in a task" starts a task.</span>
      <button
        type="button"
        className="button"
        data-size="sm"
        onClick={() => {
          setClosed(true);
          onReview();
        }}
      >
        Review
      </button>
      <button
        type="button"
        className="icon-button"
        data-variant="quiet"
        aria-label="Not now"
        disabled={guides.busy}
        onClick={() => {
          setClosed(true);
          void guides.change({ action: "decline" });
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
