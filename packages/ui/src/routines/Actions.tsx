// The admin actions around a routine (automation.md sections 10, 12 and 13):
// its switch, Run now, delete, the row's menu, a bot's routines' time zone,
// and the gateway's hook address. Each is offered only with admin access, and
// each request is refused again by the engine below admin, whatever sent it.

import {
  fieldsOf,
  type ConnectionState,
  type HostInfo,
  type Routine,
  type RoutineRunNow,
} from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyValue } from "../AccessBar.tsx";
import { useBridge } from "../bridge.tsx";
import { Dialog } from "../bots/Dialog.tsx";
import { Note } from "../bots/parts.tsx";
import { ChevronIcon } from "../icons.tsx";
import { type MenuEntry } from "../Menu.tsx";
import { draftOf } from "./draft.ts";
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
export function useRoutineActions(announce: (text: string) => void) {
  const bridge = useBridge();
  /** A switch turned and not yet confirmed: the value it shows meanwhile. */
  const [pending, setPending] = useState<Record<string, boolean>>({});
  /** A pause or resume that failed, said under its row. */
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<Record<string, RunNote>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
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
        const result = await bridge.invoke({ type: "setRoutineEnabled", id: routine.id, enabled });
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
                    ? "nothing was sent."
                    : "it changed meanwhile."
            }`,
          );
      } catch (error) {
        putNote(routine.id, `Couldn't ${word}: ${errorText(error)}`);
      } finally {
        putPending(routine.id, null);
      }
    },
    [bridge, announce],
  );

  const runNow = useCallback(
    async (routine: Routine) => {
      putRun(routine.id, { status: "starting" });
      let result: RoutineRunNow;
      try {
        result = await bridge.invoke({ type: "runRoutineNow", id: routine.id });
      } catch (error) {
        result = { status: "unknown", error: errorText(error) };
      }
      if (result.status === "started") {
        putRun(routine.id, null);
        announce(`Running ${routine.name}`);
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
                  ? "nothing was sent."
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
    [bridge, announce],
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
  onCancel,
  onDeleted,
}: {
  routine: Routine;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const bridge = useBridge();
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
      const result = await bridge.invoke({ type: "removeRoutine", id: routine.id });
      if (result.status === "removed") return onDeleted();
      if (result.status === "unknown") return setStatus("unknown");
      setError(
        result.status === "not-sent"
          ? "Nothing was sent: this connection can't change routines."
          : result.error,
      );
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
      onClose={() => {
        if (!needsCheck && status !== "deleting") onCancel();
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
            <button
              type="button"
              className="button"
              ref={checkButton}
              disabled={status === "checking"}
              onClick={() => void check()}
            >
              {status === "checking" ? "Checking…" : error ? "Check again" : "Check now"}
            </button>
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
}: {
  routines: Routine[];
  botId: string;
  botName: string;
  admin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const zones = [
    ...new Set(routines.filter((each) => each.schedule.tz).map((each) => each.schedule.tz!)),
  ];
  if (zones.length === 0) return null;
  return (
    <div className="r-tz-line" data-testid="routines-zone">
      <span>
        Routines&apos; time zone:{" "}
        {zones.length === 1 ? zoneCity(zones[0]!) : `Mixed: ${zones.map(zoneCity).join(", ")}`}
      </span>
      {admin && (
        <button type="button" className="button" data-size="sm" onClick={() => setOpen(true)}>
          Change…
        </button>
      )}
      {open && admin && (
        <ZoneDialog
          routines={routines}
          botId={botId}
          botName={botName}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ZoneDialog({
  routines,
  botId,
  botName,
  onClose,
}: {
  routines: Routine[];
  botId: string;
  botName: string;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const [zone, setZone] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[] | null>(null);
  const [shown, setShown] = useState(routines);
  const [reconfirm, setReconfirm] = useState(false);
  const tz = zone === "auto" ? viewerZone() : zone;
  const willChange = (routine: Routine) => zoned(routine) && routine.schedule.tz !== tz;
  const changes = shown.filter(willChange);
  const left = shown.filter((each) => !zoned(each));
  const save = async () => {
    setBusy(true);
    setFailed(null);
    let fresh: Routine[];
    try {
      fresh = (await bridge.invoke({ type: "readBotRoutines", botId })).routines;
    } catch (error) {
      setFailed([errorText(error)]);
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
      setBusy(false);
      return;
    }
    setReconfirm(false);
    const failures: string[] = [];
    for (const routine of next) {
      const original = fieldsOf(routine);
      try {
        const result = await bridge.invoke({
          type: "updateRoutine",
          id: routine.id,
          original,
          edit: { ...original, schedule: { ...original.schedule, tz } },
          expected: { ...original, updatedAt: routine.updatedAt },
        });
        if (result.status !== "saved")
          failures.push(
            `${routine.name} (${
              result.status === "refused" || result.status === "unknown"
                ? result.error
                : result.status === "conflict"
                  ? "changed elsewhere"
                  : result.status
            })`,
          );
      } catch (error) {
        failures.push(`${routine.name} (${errorText(error)})`);
      }
    }
    setBusy(false);
    if (failures.length === 0) onClose();
    else setFailed(failures);
  };
  return (
    <Dialog
      kind="settings"
      labelledBy="r-zone-title"
      onClose={onClose}
      testId="routines-zone-dialog"
    >
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
          {failed && (
            <Note tone="danger" testId="zone-failed">
              <p role="alert">
                <strong>Some weren&apos;t changed:</strong> {failed.join("; ")}.
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
              disabled={busy}
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
            <button type="button" className="button" data-variant="quiet" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              data-variant="primary"
              disabled={busy || changes.length === 0}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
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
