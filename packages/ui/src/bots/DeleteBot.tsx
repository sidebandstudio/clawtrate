// Delete bot… (docs/parity.md F-050, F-276, F-464): the dialog reads the
// gateway's bot list, names the bot and lists what goes and what stays before
// anything is removed. Removing the workspace folder is a box, off unless the
// person ticks it, and disabled when another bot uses the same folder. After
// the delete it says what the gateway's answer and the bot list read after it
// established. It never sends anything again: what the gateway reports left is
// handled on the gateway, and a lost answer is followed only by reading the list.
// The Main Bot is never offered here; a connection without admin sees the
// list and why it can't delete. The dialog belongs to the gateway and the
// connection it opened on: once either changes, it offers nothing more.

import {
  confirmMatches,
  gatewayStamp,
  reviewOf,
  sameStamp,
  type BotDeleteOutcome,
  type BotDeleteRead,
  type ConnectionState,
  type GatewayStamp,
  type HostInfo,
} from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { CloseIcon } from "../icons.tsx";
import {
  changedLine,
  confirmLabel,
  deleteLines,
  deletedOnClose,
  deleteOffer,
  finalLine,
  FOLDER_OPTION,
  folderOption,
  KEEPS_HEADING,
  mainBotLine,
  newestOnly,
  resultView,
} from "./delete-words.ts";
import { Dialog } from "./Dialog.tsx";
import { AdminBar, Note, Wait } from "./parts.tsx";

type Phase =
  | { at: "reading" }
  | { at: "read-failed"; message: string }
  | { at: "confirm"; read: BotDeleteRead; note: string | null; tone: "warn" | "danger" }
  | { at: "deleting"; read: BotDeleteRead }
  /** `checking`: the bot list is being read again, the outcome kept; `checkError`: that read failed. */
  | {
      at: "result";
      read: BotDeleteRead;
      outcome: BotDeleteOutcome;
      checking?: boolean;
      checkError?: string;
    };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function DeleteBot({
  bot,
  connection,
  info,
  onClose,
}: {
  /** The bot as it was when Delete bot… was chosen; the dialog stays about it after it is gone. */
  bot: { id: string; name: string; isDefault: boolean };
  connection: ConnectionState;
  info: HostInfo;
  /** `deleted`: the gateway answered that it deleted the bot, and its list no longer has it. */
  onClose: (deleted: boolean) => void;
}) {
  const bridge = useBridge();
  // The bot as the latest read names it: what is shown is what a confirmation sends.
  const nameOf = useCallback(
    (read: BotDeleteRead | null) => (read?.listed && read.name ? read.name : bot.name),
    [bot.name],
  );
  const [phase, setPhase] = useState<Phase>({ at: "reading" });
  const [removeFolder, setRemoveFolder] = useState(false);
  // What the person typed to confirm. Every confirmation the dialog asks for starts empty, even
  // when it asks for the same text: what was typed for one bot never confirms another.
  const [typed, setTyped] = useState("");
  const [said, setSaid] = useState("");
  const ask = useCallback((read: BotDeleteRead, note: string | null, tone: "warn" | "danger") => {
    setTyped("");
    setPhase({ at: "confirm", read, note, tone });
  }, []);
  // Where the dialog is: the gateway and target connected when it opened, or, when that gateway
  // hadn't said which it is yet, the stamp its first read came with. Another gateway, or the host
  // pointed at a gateway anew, ends the dialog.
  const origin = useRef<GatewayStamp>(gatewayStamp(connection));
  const [elsewhere, setElsewhere] = useState<"gateway" | "connection" | null>(null);
  const fromElsewhere = useCallback((facts: BotDeleteRead) => {
    const opened = origin.current;
    if (opened.gatewayId === null && facts.stamp.target === opened.target)
      origin.current = facts.stamp;
    if (sameStamp(facts.stamp, origin.current)) return false;
    setElsewhere(facts.stamp.gatewayId !== origin.current.gatewayId ? "gateway" : "connection");
    return true;
  }, []);
  useEffect(() => {
    const opened = origin.current;
    if (
      opened.gatewayId !== null &&
      connection.gatewayId !== null &&
      connection.gatewayId !== opened.gatewayId
    )
      setElsewhere("gateway");
    else if (connection.target !== opened.target) setElsewhere((was) => was ?? "connection");
  }, [connection.gatewayId, connection.target]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Only the newest read decides: one a later read superseded (as when a development build runs
  // the opening effect twice) is dropped, its failure too.
  const [beginRead] = useState(newestOnly);
  // The dialog opens reading; a failed read is read again.
  const load = useCallback(() => {
    const newest = beginRead();
    bridge.invoke({ type: "readBotDelete", botId: bot.id }).then(
      (facts) => {
        if (!live.current || !newest() || fromElsewhere(facts)) return;
        const name = nameOf(facts);
        if (!folderOption(name, facts).enabled) setRemoveFolder(false);
        const why = facts.main
          ? mainBotLine(name)
          : !facts.listed
            ? `${name} is no longer listed on the gateway.`
            : null;
        ask(facts, why, "warn");
      },
      (error: unknown) =>
        live.current && newest() && setPhase({ at: "read-failed", message: message(error) }),
    );
  }, [bridge, bot.id, nameOf, fromElsewhere, ask, beginRead]);
  useEffect(load, [load]);
  const read = () => {
    setPhase({ at: "reading" });
    load();
  };

  // Check again after a result only reads the bot list. An answer that never came is followed
  // by a fresh confirmation while the bot is listed; otherwise the outcome stays, with the list.
  const recheck = (facts: BotDeleteRead, outcome: BotDeleteOutcome) => {
    if (outcome.kind === "changed" || outcome.kind === "not-sent" || outcome.kind === "unread")
      return;
    setPhase({ at: "result", read: facts, outcome, checking: true });
    const newest = beginRead();
    bridge.invoke({ type: "readBotDelete", botId: bot.id }).then(
      (fresh) => {
        if (!live.current || !newest() || fromElsewhere(fresh)) return;
        if (outcome.kind === "unconfirmed" && fresh.listed) {
          // A bot that is now the Main Bot isn't offered again: the line says why, not "again".
          const line = fresh.main
            ? `The gateway didn't confirm the last delete, and it still lists ${nameOf(fresh)}. ${mainBotLine(nameOf(fresh))}`
            : `The gateway didn't confirm the last delete, and it still lists ${nameOf(fresh)}. Check what goes, then delete again.`;
          setRemoveFolder(false);
          ask(fresh, line, "warn");
          setSaid(line);
          return;
        }
        const { listedAs: _before, ...rest } = outcome;
        const next = {
          ...rest,
          listed: fresh.listed,
          ...(fresh.listed && fresh.name !== null ? { listedAs: fresh.name } : {}),
        };
        setPhase({ at: "result", read: facts, outcome: next });
        const view = resultView(nameOf(facts), next);
        if (view) setSaid(view.title);
      },
      (error: unknown) => {
        if (!live.current || !newest()) return;
        setPhase({ at: "result", read: facts, outcome, checkError: message(error) });
        setSaid(`Couldn't read the gateway's bot list: ${message(error)}`);
      },
    );
  };

  // The dialog's one send: what was reviewed, once, and only with the confirmation typed; the
  // host checks that text again. Nothing here sends it again.
  const send = (facts: BotDeleteRead, deleteFiles: boolean) => {
    if (!confirmMatches(typed, facts.confirm)) return;
    const name = nameOf(facts);
    setPhase({ at: "deleting", read: facts });
    bridge
      .invoke({
        type: "deleteBot",
        botId: bot.id,
        stamp: facts.stamp,
        deleteFiles,
        reviewed: reviewOf(facts),
        typed: typed.trim(),
      })
      .then(
        (outcome) => {
          if (!live.current) return;
          if (outcome.kind === "not-sent") {
            // The host's word that nothing went out: back to the confirmation, with why.
            const line = `Couldn't delete ${name}: ${outcome.message}`;
            ask(facts, line, "danger");
            setSaid(line);
            return;
          }
          if (outcome.kind === "unread") {
            // The list read before the delete decided nothing: a newer one came in meanwhile, or
            // it wasn't whole. Its facts are never shown; the dialog reads again.
            // The folder is asked for again: Read again may name another one.
            setRemoveFolder(false);
            setPhase({ at: "read-failed", message: outcome.message });
            setSaid(outcome.message);
            return;
          }
          if (outcome.kind === "changed") {
            // Anything changed: the person reviews again, and the folder is asked for again.
            setRemoveFolder(false);
            const line = changedLine(nameOf(outcome.read), outcome);
            ask(outcome.read, line, "warn");
            if (line) setSaid(line);
            return;
          }
          setPhase({ at: "result", read: facts, outcome });
          const view = resultView(name, outcome);
          if (view) setSaid(view.title);
        },
        (error: unknown) => {
          if (!live.current) return;
          // No outcome came back, so nothing says the delete didn't go out (the link to the host
          // can be lost after it was sent): unconfirmed, and only Check again, which reads.
          const lost: BotDeleteOutcome = {
            kind: "unconfirmed",
            message: message(error),
            deleteFiles,
            listed: null,
          };
          setPhase({ at: "result", read: facts, outcome: lost });
          const view = resultView(name, lost);
          if (view) setSaid(view.title);
        },
      );
  };

  // A new stage puts focus where it starts: the field (or Cancel, or Close) on the confirmation,
  // the title on a result, and Close once the dialog no longer applies, as its controls go.
  const rootRef = useRef<HTMLDivElement>(null);
  const invalid = elsewhere !== null && phase.at !== "deleting";
  // What this connection allows: when it changes (a dropped connection, say), the confirmation's
  // controls change with it, and focus goes where the new ones start.
  const offer = deleteOffer(bot, connection, info);
  useEffect(() => {
    const target =
      invalid || phase.at === "confirm"
        ? rootRef.current?.querySelector<HTMLElement>("[data-b-focus]")
        : phase.at === "result" || phase.at === "read-failed"
          ? rootRef.current?.querySelector<HTMLElement>("h2")
          : null;
    target?.focus();
  }, [phase.at, invalid, offer]);

  const busy = phase.at === "deleting";
  const name = nameOf("read" in phase ? phase.read : null);
  // Only the gateway's own `ok` counts as a delete here; a list that lacks the bot doesn't.
  const deleted = !elsewhere && phase.at === "result" && deletedOnClose(phase.outcome);
  const close = () => {
    if (!busy) onClose(deleted);
  };

  let title: string;
  let body: ReactNode;
  let foot: ReactNode;
  if (elsewhere && !busy) {
    // A delete under way is the host's to finish; its answer isn't shown over another gateway.
    title = `Delete ${name}?`;
    body = (
      <Note tone="warn" testId="delete-elsewhere">
        <p>
          {elsewhere === "gateway"
            ? "Clawtrate is now connected to another gateway, so this dialog no longer applies. Nothing more was sent."
            : "The connection to the gateway changed since this dialog opened, so it no longer applies. Nothing more was sent."}
        </p>
      </Note>
    );
    foot = (
      <div className="b-actions b-delete-actions">
        <button type="button" className="button" onClick={close} data-b-focus="">
          Close
        </button>
      </div>
    );
  } else if (phase.at === "reading") {
    title = `Delete ${name}?`;
    body = <Wait>Reading what {name} has on the gateway…</Wait>;
    foot = (
      <div className="b-actions b-delete-actions">
        <button type="button" className="button" data-variant="quiet" onClick={close}>
          Cancel
        </button>
      </div>
    );
  } else if (phase.at === "read-failed") {
    title = `Delete ${name}?`;
    body = (
      <Note tone="danger">
        <p>
          <b>Couldn't read what {name} has.</b> {phase.message}
        </p>
        <p>Clawtrate doesn't delete a bot without saying what goes.</p>
      </Note>
    );
    foot = (
      <div className="b-actions b-delete-actions">
        <button type="button" className="button" data-variant="quiet" onClick={close}>
          Cancel
        </button>
        <button type="button" className="button" onClick={() => read()}>
          Read again
        </button>
      </div>
    );
  } else if (phase.at === "result") {
    const view = resultView(name, phase.outcome)!;
    title = view.title;
    body = (
      <ul className="b-delete-result" data-testid="delete-result">
        {view.lines.map((line, n) => (
          <li key={n} data-tone={line.tone}>
            {line.text}
          </li>
        ))}
        {phase.checking && <li>Reading the gateway&apos;s bot list again…</li>}
        {phase.checkError && (
          <li data-tone="warn">
            Couldn&apos;t read the gateway&apos;s bot list: {phase.checkError}
          </li>
        )}
      </ul>
    );
    foot = (
      <div className="b-actions b-delete-actions">
        <button
          type="button"
          className="button"
          data-variant={view.check ? "quiet" : undefined}
          onClick={close}
        >
          Close
        </button>
        {view.check && (
          <button
            type="button"
            className="button"
            disabled={phase.checking}
            onClick={() => recheck(phase.read, phase.outcome)}
          >
            Check again
          </button>
        )}
      </div>
    );
  } else {
    const facts = phase.read;
    const option = folderOption(name, facts);
    const ticked = removeFolder && option.enabled;
    const lines = deleteLines(name, facts, ticked);
    const blocked = facts.main || !facts.listed;
    // Typed exactly, case and all.
    const target = facts.confirm;
    // A delete under way stays shown as under way, whatever the connection offers meanwhile.
    const offered = !blocked && (busy || offer === "ready");
    const canDelete =
      offered &&
      !busy &&
      sameStamp(gatewayStamp(connection), facts.stamp) &&
      confirmMatches(typed, target);
    title = `Delete ${name}?`;
    body = (
      <>
        <p className="b-delete-lead" id="b-delete-lead">
          Deleting {name} can't be undone.
        </p>
        {phase.at === "confirm" && phase.note && (
          <Note tone={phase.tone} testId="delete-note">
            <p>{phase.note}</p>
          </Note>
        )}
        {!blocked && (
          <>
            <h3 className="b-group">The gateway removes</h3>
            <ul className="b-list" data-testid="delete-goes">
              {lines.goes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {option.shown && (
              <label className="b-delete-check" data-disabled={option.enabled ? undefined : true}>
                <input
                  type="checkbox"
                  checked={ticked}
                  disabled={!option.enabled || busy}
                  aria-describedby="b-delete-folder"
                  onChange={(event) => setRemoveFolder(event.target.checked)}
                />
                <span>{FOLDER_OPTION}</span>
              </label>
            )}
            <p
              className="b-hint b-delete-folder"
              id="b-delete-folder"
              data-alone={option.shown ? undefined : true}
            >
              {option.line}
            </p>
            <h3 className="b-group">{KEEPS_HEADING}</h3>
            <ul className="b-list" data-testid="delete-stays">
              {lines.stays.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </>
    );
    foot = (
      <>
        {/* Not while a delete is under way: the offer then reads another connection. */}
        {!blocked && !busy && offer === "needs-admin" && (
          <AdminBar
            connection={connection}
            info={info}
            need={`Deleting ${name} needs admin access.`}
          />
        )}
        {!blocked && offer === "offline" && (
          <Note tone="warn">
            <p>Not connected to the gateway. Deleting {name} needs the connection.</p>
          </Note>
        )}
        {offered && (
          <div className="b-delete-confirm">
            <p className="b-delete-final" data-testid="delete-final">
              {finalLine(name, ticked)}
            </p>
            <label className="b-field">
              {/* Spaces as they are in the name, so what is shown is what matches. */}
              <span className="b-delete-label">{confirmLabel(target)}</span>
              <input
                className="input"
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={typed}
                disabled={busy}
                data-b-focus=""
                data-testid="delete-type"
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  // Enter that only commits text an input method composed is the method's.
                  if (
                    event.key !== "Enter" ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229
                  )
                    return;
                  // Enter deletes only once the name matches; otherwise it does nothing.
                  event.preventDefault();
                  if (canDelete) send(facts, ticked);
                }}
              />
            </label>
          </div>
        )}
        <div className="b-actions b-delete-actions">
          <button
            type="button"
            className="button"
            data-variant="quiet"
            onClick={close}
            disabled={busy}
            data-b-focus={offered ? undefined : ""}
          >
            {offered ? "Cancel" : "Close"}
          </button>
          {offered && (
            <button
              type="button"
              className="button"
              data-tone="danger"
              disabled={!canDelete}
              onClick={() => send(facts, ticked)}
            >
              {busy ? `Deleting ${name}…` : `Delete ${name}`}
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <Dialog
      kind="delete"
      labelledBy="b-delete-title"
      describedBy={phase.at === "confirm" ? "b-delete-lead" : undefined}
      role={phase.at === "confirm" || phase.at === "deleting" ? "alertdialog" : undefined}
      onClose={close}
      testId="delete-bot"
    >
      <div className="b-sheet" ref={rootRef} aria-busy={phase.at === "reading" || busy}>
        <header className="b-head">
          <h2 id="b-delete-title" tabIndex={-1}>
            {title}
          </h2>
          <button
            type="button"
            className="icon-button b-close"
            aria-label="Close"
            title="Close (Esc)"
            disabled={busy}
            onClick={close}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="b-body">{body}</div>
        <footer className="b-foot">{foot}</footer>
        <p className="visually-hidden" role="status" aria-live="polite">
          {said}
        </p>
      </div>
    </Dialog>
  );
}

/** The bot settings' Manage group: Delete bot…, or why the Main Bot has none. */
export function ManageGroup({
  bot,
  onDelete,
}: {
  bot: { name: string; isDefault: boolean };
  onDelete: (() => void) | null;
}) {
  if (!onDelete && !bot.isDefault) return null;
  return (
    <>
      <h3 className="b-tabgroup">Manage</h3>
      {bot.isDefault ? (
        <p className="b-hint b-manage-note" data-testid="delete-main-note">
          {mainBotLine(bot.name)}
        </p>
      ) : (
        <button
          type="button"
          className="button b-delete-open"
          data-tone="danger"
          data-size="sm"
          data-bs="delete-bot"
          onClick={onDelete!}
        >
          Delete bot…
        </button>
      )}
    </>
  );
}
