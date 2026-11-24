// The admin actions around a routine (automation.md sections 10, 12 and 13):
// its switch, Run now, delete, the row's menu, a bot's routines' time zone,
// and the gateway's hook address. Each is offered only with admin access, and
// each request is refused again by the engine below admin, whatever sent it.

import {
  fieldsOf,
  gatewayStamp,
  sameStamp,
  sameSchedule,
  type ConnectionState,
  type HostInfo,
  type Routine,
  type RoutineRunNow,
  type RoutineSchedule,
} from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyValue } from "../AccessBar.tsx";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { Dialog } from "../bots/Dialog.tsx";
import { Note } from "../bots/parts.tsx";
import { ChevronIcon } from "../icons.tsx";
import { type MenuEntry } from "../Menu.tsx";
import { screenStamp, type ShownStamp } from "../stamp.ts";
import { draftOf } from "./draft.ts";
import { notSentDelete, notSentNote } from "./refusals.ts";
import { viewerZone, when, zoneCity } from "./schedule.ts";

export function canAdmin(connection: ConnectionState, info: HostInfo): boolean {
  return connection.status === "connected" && connection.canAdmin && !info.readOnly;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type RunNote =
  { status: "starting" } | { status: "already" } | { status: "failed"; error: string };

function assign<T>(all: Record<string, T>, id: string, value: T | null): Record<string, T> {
  const next = { ...all };
  if (value === null) delete next[id];
  else next[id] = value;
  return next;
}

/** What the admin actions are doing now, by routine. */
/**
 * `listedOn` is the list the rows on screen came from, and `shown` where it was drawn: each
 * action sends both (`GatewayStamp`), so one from a row of an earlier connection's list, or of
 * another gateway's, is refused, not sent.
 */
export function useRoutineActions(
  announce: (text: string) => void,
  routines: Routine[],
  listedOn: number,
  shown: ShownStamp,
) {
  const { gatewayId, target, connectedAt } = shown;
  const bridge = useBridge();
  /** A switch turned and not yet confirmed: the value it shows meanwhile. */
  const [pending, setPending] = useState<Record<string, boolean>>({});
  /** A pause or resume that failed, said under its row. */
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<Record<string, RunNote>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /**
   * Run-now replies that only mean the gateway took the request: "Running" is
   * said when the run is seen on the routine, not on the reply alone.
   */
  const queued = useRef(new Set<string>());
  useEffect(() => {
    for (const id of queued.current) {
      const routine = routines.find((each) => each.id === id);
      if (!routine) continue;
      queued.current.delete(id);
      if (routine.runningAt !== null) announce(`Running ${routine.name}`);
    }
  }, [routines, announce]);
  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((timer) => clearTimeout(timer));
  }, []);
  const putPending = (id: string, value: boolean | null) =>
    setPending((all) => assign(all, id, value));
  const putNote = (id: string, value: string | null) => setNotes((all) => assign(all, id, value));
  const putRun = (id: string, value: RunNote | null) => setRuns((all) => assign(all, id, value));

  const setEnabled = useCallback(
    async (routine: Routine, enabled: boolean) => {
      putPending(routine.id, enabled);
      putNote(routine.id, null);
      const word = enabled ? "resume" : "pause";
      try {
        const result = await bridge.invoke({
          type: "setRoutineEnabled",
          id: routine.id,
          enabled,
          listedOn,
          stamp: await screenStamp(bridge, { gatewayId, target, connectedAt }),
        });
        if (result.status === "saved")
          announce(`${enabled ? "Resumed" : "Paused"} ${routine.name}`);
        else
          putNote(
            routine.id,
            `Couldn't ${word}: ${
              result.status === "refused" || result.status === "unknown"
                ? result.error
                : result.status === "deleted"
                  ? "it was deleted."
                  : result.status === "not-sent"
                    ? notSentNote(result.reason)
                    : "it changed meanwhile."
            }`,
          );
      } catch (error) {
        putNote(routine.id, `Couldn't ${word}: ${errorText(error)}`);
      } finally {
        putPending(routine.id, null);
      }
    },
    [bridge, announce, listedOn, gatewayId, target, connectedAt],
  );

  const runNow = useCallback(
    async (routine: Routine) => {
      putRun(routine.id, { status: "starting" });
      let result: RoutineRunNow;
      try {
        result = await bridge.invoke({
          type: "runRoutineNow",
          id: routine.id,
          listedOn,
          stamp: await screenStamp(bridge, { gatewayId, target, connectedAt }),
        });
      } catch (error) {
        result = { status: "unknown", error: errorText(error) };
      }
      if (result.status === "started") {
        putRun(routine.id, null);
        queued.current.add(routine.id);
        announce(`Queued ${routine.name}`);
        return;
      }
      putRun(
        routine.id,
        result.status === "already-running"
          ? { status: "already" }
          : {
              status: "failed",
              error:
                result.status === "not-sent"
                  ? notSentNote(result.reason)
                  : result.status === "unknown"
                    ? `the gateway didn't answer (${result.error}).`
                    : result.error,
            },
      );
      if (result.status === "already-running") {
        clearTimeout(timers.current.get(routine.id));
        timers.current.set(
          routine.id,
          setTimeout(() => putRun(routine.id, null), 4000),
        );
      }
    },
    [bridge, announce, listedOn, gatewayId, target, connectedAt],
  );

  return { pending, notes, runs, setEnabled, runNow };
}

export type RoutineActions = ReturnType<typeof useRoutineActions>;

/** The row's switch: on runs on schedule, off pauses (section 5). */
export function RoutineSwitch({ routine, actions }: { routine: Routine; actions: RoutineActions }) {
  const shown = actions.pending[routine.id] ?? routine.enabled;
  return (
    <button
      type="button"
      className="b-switch r-switch"
      role="switch"
      aria-checked={shown}
      aria-busy={routine.id in actions.pending || undefined}
      aria-label={`${routine.name} runs on schedule`}
      data-testid="routine-switch"
      onClick={() => {
        if (!(routine.id in actions.pending)) void actions.setEnabled(routine, !shown);
      }}
    />
  );
}

/** The actions on a routine, for its row's menu and the page's More (F-192). */
export function routineEntries(
  routine: Routine,
  actions: RoutineActions,
  open: {
    page?: () => void;
    edit: () => void;
    remove: () => void;
  },
  close: () => void,
  only?: Array<"pause" | "run" | "edit" | "delete">,
): MenuEntry[] {
  const want = (what: "pause" | "run" | "edit" | "delete") => !only || only.includes(what);
  const entries: MenuEntry[] = [];
  if (open.page)
    entries.push({
      kind: "item",
      label: "Open",
      onSelect: () => {
        close();
        open.page!();
      },
    });
  if (want("pause"))
    entries.push({
      kind: "item",
      label: routine.enabled ? "Pause" : "Resume",
      onSelect: () => {
        close();
        void actions.setEnabled(routine, !routine.enabled);
      },
    });
  if (want("run"))
    entries.push({
      kind: "item",
      label: routine.enabled ? "Run now" : "Run once now",
      onSelect: () => {
        close();
        void actions.runNow(routine);
      },
    });
  if (want("edit"))
    entries.push({
      kind: "item",
      label: "Edit…",
      onSelect: () => {
        close();
        open.edit();
      },
    });
  if (want("delete"))
    entries.push({
      kind: "item",
      label: "Delete…",
      tone: "danger",
      onSelect: () => {
        close();
        open.remove();
      },
    });
  return entries;
}

/** Under the page's header: how the last Run now went (section 10). */
export function RunNoteLine({ note, paused }: { note: RunNote | undefined; paused: boolean }) {
  if (!note) return null;
  return (
    <p
      className="r-hint r-run-note"
      role="status"
      data-testid="run-note"
      data-tone={note.status === "failed" ? "danger" : undefined}
    >
      {note.status === "starting"
        ? paused
          ? "Starting a run. It stays paused."
          : "Starting…"
        : note.status === "already"
          ? "It's already running."
          : `Couldn't start a run: ${note.error}`}
    </p>
  );
}

/** The delete confirmation (F-352): it says what deleting loses, and keeps the reason if it fails. */
export function DeleteRoutine({
  routine,
  listedOn,
  shown,
  onCancel,
  onDeleted,
}: {
  routine: Routine;
  /** The list the routine was shown from (`RoutinesState.listedOn`). */
  listedOn: number;
  /** Where that list was drawn: the confirmation keeps the one it opened with. */
  shown: ShownStamp;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const bridge = useBridge();
  const [opened] = useState(shown);
  const [status, setStatus] = useState<"idle" | "deleting" | "unknown" | "checking" | "present">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const checkButton = useRef<HTMLButtonElement>(null);
  const needsCheck = status === "unknown" || status === "checking";
  useEffect(() => {
    if (status === "unknown") checkButton.current?.focus();
  }, [status]);
  const last =
    routine.lastRunAt === null
      ? "It hasn't run yet."
      : `Its last run was ${when(routine.lastRunAt, now, routine.schedule.tz ?? viewerZone()).replace(/ (\d{1,2}:\d{2}\s[AP]M)$/u, " at $1")}.`;
  const remove = async () => {
    setStatus("deleting");
    setError(null);
    try {
      const result = await bridge.invoke({
        type: "removeRoutine",
        id: routine.id,
        listedOn,
        stamp: await screenStamp(bridge, opened),
      });
      if (result.status === "removed") return onDeleted();
      if (result.status === "unknown") return setStatus("unknown");
      setError(result.status === "not-sent" ? notSentDelete(result.reason) : result.error);
      setStatus("idle");
    } catch {
      setStatus("unknown");
    }
  };
  const check = async () => {
    setStatus("checking");
    setError(null);
    try {
      const fresh = await bridge.invoke({ type: "readRoutine", id: routine.id });
      if (fresh === null) return onDeleted();
      setStatus("present");
    } catch (failure) {
      setError(errorText(failure));
      setStatus("unknown");
    }
  };
  return (
    <Dialog
      kind="confirm"
      labelledBy="r-delete-title"
      describedBy="r-delete-text"
      // An uncertain delete can be left: closing claims nothing, and the list says what the gateway has.
      onClose={() => {
        if (status !== "checking" && status !== "deleting") onCancel();
      }}
      role="alertdialog"
      testId="routine-delete"
    >
      <div className="b-confirm">
        <h2 id="r-delete-title">Delete {routine.name}?</h2>
        <p id="r-delete-text">
          It won&apos;t run again, and Clawtrate can&apos;t show its runs afterwards. {last}
        </p>
        {needsCheck || status === "present" ? (
          <Note tone="warn" testId="delete-check">
            <p role="status">
              {needsCheck
                ? "The gateway didn't answer. This routine may have been deleted."
                : "The gateway still lists this routine. The delete may still arrive."}
              {error && ` Couldn't check: ${error}`}
            </p>
          </Note>
        ) : (
          error && (
            <Note tone="danger" testId="delete-error">
              <p role="alert">
                <strong>Couldn&apos;t delete it.</strong> {error}
              </p>
            </Note>
          )
        )}
        <div className="b-actions">
          {needsCheck ? (
            <>
              <button
                type="button"
                className="button"
                data-variant="quiet"
                onClick={onCancel}
                disabled={status === "checking"}
              >
                Close
              </button>
              <button
                type="button"
                className="button"
                ref={checkButton}
                disabled={status === "checking"}
                onClick={() => void check()}
              >
                {status === "checking" ? "Checking…" : error ? "Check again" : "Check now"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button"
                data-variant="quiet"
                onClick={onCancel}
                disabled={status === "deleting"}
                data-b-focus=""
              >
                Cancel
              </button>
              <button
                type="button"
                className="button"
                data-tone="danger"
                disabled={status === "deleting"}
                onClick={() => void remove()}
              >
                {status === "deleting"
                  ? "Deleting…"
                  : status === "present"
                    ? "Delete again"
                    : "Delete"}
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** The routines a zone change rewrites: a zone of their own, in a schedule the form writes. */
function zoned(routine: Routine): boolean {
  return (
    routine.schedule.kind === "cron" && routine.schedule.tz !== null && !draftOf(routine, 0).locked
  );
}

/**
 * A bot's routines' time zone (F-196, section 13): one line over its routines,
 * and with admin "Change…", which rewrites each routine's own zone, one by one.
 */
export function TimeZoneLine({
  routines,
  botId,
  botName,
  admin,
  announce,
}: {
  routines: Routine[];
  botId: string;
  botName: string;
  admin: boolean;
  announce: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const zones = [
    ...new Set(routines.filter((each) => each.schedule.tz).map((each) => each.schedule.tz!)),
  ];
  if (zones.length === 0 && !open) return null;
  const zone = zones.map(zoneCity).join(", ");
  return (
    <div className="r-tz-line" data-testid="routines-zone">
      <span>
        Routines&apos; time zone:{" "}
        {checking ? "checking needed" : zones.length > 1 ? `Mixed: ${zone}` : zone || "none"}
      </span>
      {admin && (
        <button type="button" className="button" data-size="sm" onClick={() => setOpen(true)}>
          Change…
        </button>
      )}
      {open && (admin || checking) && (
        <ZoneDialog
          routines={routines}
          botId={botId}
          botName={botName}
          onChecking={setChecking}
          announce={announce}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

type ZoneResult = {
  changed: string[];
  notes: string[];
  pending: Array<{ routine: Routine; schedule: RoutineSchedule }>;
};

function ZoneDialog({
  routines,
  botId,
  botName,
  onChecking,
  announce,
  onClose,
}: {
  routines: Routine[];
  botId: string;
  botName: string;
  onChecking: (checking: boolean) => void;
  announce: (text: string) => void;
  onClose: () => void;
}) {
  const bridge = useBridge();
  // A rewrite names the gateway the routines were read from; the engine refuses
  // a write for another (routines.ts `blocked`).
  const connection = useClawtrateState().connection;
  // The stamp as the dialog opened, identity and target together: a change of either since then
  // refuses a rewrite. Opened before the identity was known, Save stays off until it is reopened.
  const [stamp] = useState(() => gatewayStamp(connection));
  const [zone, setZone] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ZoneResult | null>(null);
  const actionButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (result && !busy) actionButton.current?.focus();
  }, [result, busy]);
  const [shown, setShown] = useState(routines);
  const [reconfirm, setReconfirm] = useState(false);
  const tz = zone === "auto" ? viewerZone() : zone;
  const willChange = (routine: Routine) => zoned(routine) && routine.schedule.tz !== tz;
  const changes = shown.filter(willChange);
  const left = shown.filter((each) => !zoned(each));
  const settle = async (previous: ZoneResult) => {
    const { pending, changed: alreadyChanged, notes: existingNotes } = previous;
    const changed = [...alreadyChanged];
    const notes = [...existingNotes];
    const unresolved: ZoneResult["pending"] = [];
    for (const entry of pending) {
      const { routine, schedule } = entry;
      try {
        const current = await bridge.invoke({
          type: "readRoutine",
          id: routine.id,
          // Where the writes went: the host refuses a read-back anywhere else.
          stamp,
        });
        if (current && sameSchedule(current.schedule, schedule)) changed.push(routine.name);
        else if (current?.schedule.tz && current.schedule.tz !== schedule.tz)
          notes.push(
            `${routine.name} still has ${zoneCity(current.schedule.tz)}. The change may still arrive.`,
          );
        else if (current)
          notes.push(
            `The gateway lists a different schedule for ${routine.name}. The change may still arrive.`,
          );
        else notes.push(`The gateway no longer lists ${routine.name}.`);
      } catch {
        unresolved.push(entry);
      }
    }
    if (pending.length > unresolved.length)
      await bridge.invoke({ type: "refreshRoutines" }).catch(() => {});
    onChecking(unresolved.length > 0);
    setBusy(false);
    if (notes.length || unresolved.length) setResult({ changed, notes, pending: unresolved });
    else {
      announce(
        `Changed the time zone of ${changed.length} routine${changed.length === 1 ? "" : "s"}`,
      );
      onClose();
    }
  };
  const save = async () => {
    setBusy(true);
    onChecking(true);
    let fresh: Routine[];
    let omitted: number;
    try {
      ({ routines: fresh, omitted } = await bridge.invoke({ type: "readBotRoutines", botId }));
    } catch (error) {
      setResult({ changed: [], notes: [errorText(error)], pending: [] });
      onChecking(false);
      setBusy(false);
      return;
    }
    // Changing only the listed ones would leave the bot's routines in two zones.
    if (omitted > 0) {
      setResult({
        changed: [],
        notes: [
          `The gateway has ${omitted} more of ${botName}'s routines than Clawtrate can list, so nothing was changed.`,
        ],
        pending: [],
      });
      onChecking(false);
      setBusy(false);
      return;
    }
    const next = fresh.filter(willChange);
    if (
      next.length !== changes.length ||
      next.some((job) => !changes.some((each) => each.id === job.id))
    ) {
      setShown(fresh);
      setReconfirm(true);
      onChecking(false);
      setBusy(false);
      return;
    }
    setReconfirm(false);
    const outcome: ZoneResult = { changed: [], notes: [], pending: [] };
    for (const routine of next) {
      const original = fieldsOf(routine);
      const schedule = { ...original.schedule, tz };
      try {
        const answer = await bridge.invoke({
          type: "updateRoutine",
          id: routine.id,
          original,
          edit: { ...original, schedule },
          expected: { ...original, updatedAt: routine.updatedAt },
          stamp,
        });
        if (answer.status === "saved") outcome.changed.push(routine.name);
        else if (answer.status === "unknown") outcome.pending.push({ routine, schedule });
        else {
          const reason =
            answer.status === "refused"
              ? answer.error
              : answer.status === "conflict"
                ? "changed elsewhere"
                : answer.status === "deleted"
                  ? "the routine was deleted"
                  : answer.status === "not-sent" && answer.reason === "changed"
                    ? "the connection changed since this was opened, so nothing was sent"
                    : "nothing was sent";
          outcome.notes.push(`Couldn't change ${routine.name} (${reason}).`);
        }
      } catch {
        outcome.pending.push({ routine, schedule });
      }
    }
    await settle(outcome);
  };
  const needsCheck = result && result.pending.length > 0;
  // Writes whose result never came are read back only where they went. Once the connection has
  // moved on, that read can't be made: their outcome stays unknown, and the person may leave.
  const here = sameStamp(stamp, gatewayStamp(connection));
  const unreachable = !!needsCheck && !here;
  const close = () => {
    if (busy || (needsCheck && !unreachable)) return;
    if (unreachable) onChecking(false);
    onClose();
  };
  return (
    <Dialog kind="settings" labelledBy="r-zone-title" onClose={close} testId="routines-zone-dialog">
      <div className="b-sheet r-dialog">
        <header className="b-head">
          <h2 id="r-zone-title" tabIndex={-1}>
            {botName}&apos;s routines&apos; time zone
          </h2>
        </header>
        <div className="b-body">
          {reconfirm && (
            <Note tone="warn" testId="zone-reconfirm">
              <p role="status">
                The list of routines to change has changed. Check the list and confirm again.
              </p>
            </Note>
          )}
          {result && (
            <Note tone="warn" testId="zone-failed">
              <p role="alert">
                {result.changed.length > 0 && `Changed ${result.changed.join(", ")}. `}
                {result.notes.join(" ")}
                {needsCheck &&
                  ` Couldn't confirm the time zone of ${result.pending.map(({ routine }) => routine.name).join(", ")}.`}
                {unreachable &&
                  " The connection changed since the change was sent, so Clawtrate can't check it here: whether it took effect is unknown."}
              </p>
            </Note>
          )}
          <div className="r-field">
            <label htmlFor="r-zone">Time zone</label>
            <select
              className="b-select"
              id="r-zone"
              data-b-focus=""
              value={zone}
              disabled={busy || !!result}
              onChange={(event) => setZone(event.target.value)}
            >
              <option value="auto">Auto-detect ({zoneCity(viewerZone())})</option>
              {Intl.supportedValuesOf("timeZone").map((each) => (
                <option key={each} value={each}>
                  {zoneCity(each)} ({each})
                </option>
              ))}
            </select>
          </div>
          <p className="r-hint">
            {changes.length > 0
              ? `Changes ${changes.map((each) => each.name).join(", ")}.`
              : "No routines would change to this time zone."}
            {left.length > 0 &&
              ` Leaves ${left.map((each) => each.name).join(", ")} as they are: their schedule has no zone or was set on the gateway.`}
          </p>
        </div>
        <footer className="b-foot">
          <div className="b-actions">
            {unreachable && (
              <button
                type="button"
                className="button"
                data-variant="quiet"
                disabled={busy}
                onClick={close}
              >
                Close
              </button>
            )}
            {needsCheck ? (
              <button
                type="button"
                className="button"
                ref={actionButton}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void settle(result);
                }}
              >
                {busy ? "Checking…" : "Check now"}
              </button>
            ) : (
              <button
                type="button"
                className="button"
                data-variant="quiet"
                ref={actionButton}
                disabled={busy}
                onClick={close}
              >
                {result ? "Close" : "Cancel"}
              </button>
            )}
            {!result && (
              <button
                type="button"
                className="button"
                data-variant="primary"
                // Only on the gateway the dialog opened on, confirmed: its routines are named in the write.
                disabled={busy || changes.length === 0 || !here}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </Dialog>
  );
}

/** The gateway's hook address, from its address and `hooks.path`: global, not the routine's. */
export function hookAddress(gatewayUrl: string | null, path: string): string | null {
  if (!gatewayUrl) return null;
  try {
    const url = new URL(gatewayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = `${path.replace(/\/+$/u, "")}/agent`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * F-349: with admin and the gateway's hooks on, the address they take, with a
 * copy button. The key is never shown: the gateway redacts it.
 */
export function GatewayHooks({ gatewayUrl }: { gatewayUrl: string | null }) {
  const bridge = useBridge();
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    bridge.invoke({ type: "readGatewayHooks" }).then(
      (hooks) => live && setPath(hooks?.enabled ? hooks.path : null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  const address = path === null ? null : hookAddress(gatewayUrl, path);
  if (!address) return null;
  return (
    <details className="b-disclosure r-hooks" data-testid="gateway-hooks">
      <summary>
        <ChevronIcon />
        Gateway webhooks
      </summary>
      <div className="b-disclosure-body">
        <p className="r-hook-line">
          POST to <code className="r-mono">{address}</code>
          <CopyValue value={address} label="Copy the webhook address" />
        </p>
        <p className="r-hint">
          Key: kept on the gateway. A POST starts a bot directly, not this routine.
        </p>
      </div>
    </details>
  );
}
