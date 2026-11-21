// The routine editor (automation.md section 9): a dialog that creates a
// routine or changes one. It is opened only with admin access; if access goes
// while it is open, the access bar takes Save's place and what was typed
// stays. Every way a save can end is said: saved (only from the gateway's
// answer), refused with the gateway's reason, changed or deleted elsewhere,
// and not known, which offers a check that only reads and a separate retry.

import {
  changedFields,
  fieldsOf,
  type ClawtrateState,
  type HostInfo,
  type Routine,
  type RoutineFields,
  type RoutineWrite,
} from "@clawtrate/core";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useBridge } from "../bridge.tsx";
import { CheckIcon, ChevronIcon, CloseIcon } from "../icons.tsx";
import { Dialog } from "../bots/Dialog.tsx";
import { AdminBar, Note } from "../bots/parts.tsx";
import {
  draftOf,
  fieldsOfDraft,
  MAX_NAME_CHARS,
  newDraft,
  nextRuns,
  problems,
  scheduleOf,
  usualZone,
  zoneOf,
  type Draft,
  type Problems,
  type WhenKind,
} from "./draft.ts";
import { useKeyedRead } from "./read.ts";
import { scheduleWords, viewerZone, zoneCity } from "./schedule.ts";

export type EditorTarget =
  { mode: "new"; botId: string | null } | { mode: "edit"; routine: Routine };

/** How long Save waits before saying the answer hasn't come; a later answer still counts. */
const ANSWER_MS = 30_000;
export const ADMIN_NEED = "Creating and changing routines needs admin access.";

const KINDS: Array<[WhenKind, string]> = [
  ["daily", "Every day"],
  ["weekdays", "Weekdays"],
  ["days", "Some days of the week"],
  ["every", "Every few hours or minutes"],
  ["once", "Once"],
];
const WEEK: Array<[number, string]> = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
];

type Check =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "missing" }
  /** The gateway still has the routine as it was: the save may not have been applied yet. */
  | { status: "unchanged" }
  /** The gateway's routine reads as this save sent it: maybe this save, maybe the same change made elsewhere. */
  | { status: "matches"; routine: Routine }
  | { status: "failed"; error: string };

type Save =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "refused"; error: string }
  | { status: "not-sent"; reason: "admin" | "offline" | "gateway" }
  /** `sent` is what this save asked for, compared with what a check finds. */
  | { status: "unknown"; error: string; sent: RoutineFields; check: Check }
  | { status: "conflict"; current: Routine };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function newKey(): string {
  return crypto.randomUUID();
}

function whenWords(fields: RoutineFields): string {
  const words = scheduleWords(fields.schedule).text;
  return fields.schedule.tz ? `${words}, ${zoneCity(fields.schedule.tz)}` : words;
}

/** The schedule's preview: what the gateway will do and the next three times (section 9). */
function Preview({ draft, now }: { draft: Draft; now: number }) {
  const tz = zoneOf(draft);
  const viewer = viewerZone();
  const schedule = scheduleOf(draft);
  const next = nextRuns(draft, now);
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.kind === "every" ? viewer : tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    })
      .format(ms)
      .replace(",", "");
  const clock = (ms: number, zone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(
      ms,
    );
  const words = scheduleWords(schedule);
  const lead = words.written
    ? `Runs as the gateway reads "${schedule.expr}"`
    : `Runs ${/^(Every|Weekdays|Weekends|Once)\b/u.test(words.text) ? words.text[0]!.toLowerCase() + words.text.slice(1) : `on ${words.text}`}${schedule.kind === "every" ? "" : `, ${zoneCity(tz)} time`}`;
  if (next.length === 0)
    return (
      <p className="r-preview" data-testid="preview">
        {lead}.
      </p>
    );
  const zone = schedule.kind === "every" ? viewer : tz;
  const first = `${day(next[0]!)}, ${clock(next[0]!, zone)}${zone !== viewer ? ` (${clock(next[0]!, viewer)} your time)` : ""}`;
  const rest = next.slice(1).map(day).join(", ");
  return (
    <p className="r-preview" aria-live="polite" data-testid="preview">
      {lead}. Next: {first}
      {rest && `, then ${rest}`}.
    </p>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="r-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error && (
        <p className="r-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The other version, with only the fields the person changed from their base put back. */
function mineOver(
  theirs: Draft,
  mine: { draft: Draft; base: RoutineFields },
  textLocked: boolean,
): Draft {
  const changed = changedFields(mine.base, fieldsOfDraft(mine.draft));
  const { when, time, days, count, unit, date, tz, cron, locked } = mine.draft;
  return {
    ...theirs,
    ...(changed.includes("name") ? { name: mine.draft.name } : {}),
    ...(changed.includes("text") && !textLocked ? { text: mine.draft.text } : {}),
    ...(changed.includes("schedule")
      ? { when, time, days, count, unit, date, tz, cron, locked }
      : {}),
    ...(changed.includes("delivery") ? { delivery: mine.draft.delivery } : {}),
  };
}

export function Editor({
  state,
  info,
  target,
  onClose,
  onSaved,
}: {
  state: ClawtrateState;
  info: HostInfo;
  target: EditorTarget;
  onClose: () => void;
  onSaved: (routine: Routine, created: boolean) => void;
}) {
  const bridge = useBridge();
  const { connection, bots, routines: store } = state;
  const admin = connection.status === "connected" && connection.canAdmin && !info.readOnly;
  const [now] = useState(() => Date.now());
  const [mode, setMode] = useState(target);
  const id = mode.mode === "edit" ? mode.routine.id : null;
  const cached = store.routines.find((each) => each.id === id);
  const removed = id !== null && store.removed?.id === id;
  // The global list is capped; only a gateway read or removal event can confirm deletion.
  const [read] = useKeyedRead(
    id && !cached && !removed && connection.status === "connected"
      ? `${connection.gatewayId}:${id}`
      : null,
    () => bridge.invoke({ type: "readRoutine", id: id! }),
  );
  const live = cached ?? (read.status === "ready" ? (read.value ?? undefined) : undefined);
  const initial = mode.mode === "edit" ? mode.routine : undefined;
  // What the editor opened with: a save writes only what differs from it.
  const [original, setOriginal] = useState<RoutineFields | null>(() =>
    initial ? fieldsOf(initial) : null,
  );
  const [accepted, setAccepted] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() =>
    initial
      ? draftOf(initial, now)
      : newDraft(
          (target.mode === "new" && target.botId) ||
            (bots.find((each) => each.isDefault) ?? bots[0])?.id ||
            "main",
          store.routines,
          now,
        ),
  );
  // The gateway treats a second add with the same key as an edit of the first, so a
  // retry after a check that found nothing gets a new key: that save may still land,
  // and its key must not overwrite what it became since.
  const key = useRef(newKey());
  const [save, setSave] = useState<Save>({ status: "idle" });
  /** The gateway said it has no such routine. */
  const [gone, setGone] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // The draft as the person had it when they chose to see the other version.
  // With the fields it was edited from, so only what the person changed is restored.
  const [mine, setMine] = useState<{ draft: Draft; base: RoutineFields } | null>(null);
  const [gateway, setGateway] = useState(connection.gatewayId);
  // The hello that was current when the editor opened: a later one is another
  // connection, whose identity cannot be told from this draft's gateway's.
  const [openedAt] = useState(connection.connectedAt);
  const attempt = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const payload = accepted?.payload ?? "agentTurn";
  const textLocked = payload !== "agentTurn" || accepted?.textCut === true;

  // A save still out when the editor closes is no longer this editor's to report.
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  // A draft belongs to the gateway it was opened on. One that opened before the
  // identity was read binds when this connection confirms it; if another
  // connection arrives first, the editor closes rather than guess.
  if (gateway === null && connection.gatewayId !== null && connection.connectedAt === openedAt)
    setGateway(connection.gatewayId);
  useEffect(() => {
    if (gateway === null && connection.connectedAt !== openedAt) onClose();
  }, [gateway, connection.connectedAt, openedAt, onClose]);
  useEffect(() => {
    if (gateway !== null && connection.gatewayId !== null && connection.gatewayId !== gateway)
      onClose();
  }, [gateway, connection.gatewayId, onClose]);

  const errors: Problems = checkedAt === null ? {} : problems(draft, checkedAt, textLocked);
  const bot = bots.find((each) => each.id === draft.botId);
  const botName = bot?.name ?? draft.botId;
  const deleted = id !== null && (gone || removed || (read.status === "ready" && !read.value));
  const saving = !deleted && save.status === "saving";
  const busy = saving || (!deleted && save.status === "unknown");
  useLayoutEffect(() => {
    if (deleted) attempt.current += 1;
  }, [deleted]);
  // Changed elsewhere: by the gateway's event while open, or found just before saving.
  const changed =
    save.status === "conflict"
      ? live && (live.updatedAt ?? 0) > (save.current.updatedAt ?? 0)
        ? live
        : save.current
      : live &&
          accepted &&
          !busy &&
          (accepted.textCut !== live.textCut ||
            accepted.payload !== live.payload ||
            changedFields(fieldsOf(accepted), fieldsOf(live)).length > 0)
        ? live
        : null;
  const set = (change: Partial<Draft>) => setDraft((each) => ({ ...each, ...change }));

  const focusError = (found: Problems) => {
    const first = (["name", "text", "when", "cron"] as const).find((each) => found[each]);
    if (!first) return;
    if (first === "cron")
      bodyRef.current
        ?.querySelector<HTMLDetailsElement>("details.r-more")
        ?.setAttribute("open", "");
    requestAnimationFrame(() =>
      bodyRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus(),
    );
  };

  const submit = (against = accepted, asNew = mode.mode === "new") => {
    if (asNew && mode.mode === "edit" && !accepted?.canRecreate) return;
    const submittedAt = Date.now();
    setCheckedAt(submittedAt);
    const found = problems(draft, submittedAt, textLocked);
    if (Object.keys(found).length > 0) {
      focusError(found);
      return;
    }
    const fields = fieldsOfDraft(draft);
    if (original && against && (against.payload !== "agentTurn" || against.textCut))
      fields.text = original.text;
    setAccepted(against);
    if (asNew && mode.mode === "edit") {
      setMode({ mode: "new", botId: draft.botId });
      setGone(false);
      setOriginal(null);
    }
    const id = (attempt.current += 1);
    const sentOn = connection.gatewayId;
    setSave({ status: "saving" });
    const settle = (result: RoutineWrite) => {
      if (id !== attempt.current || sentOn !== state.connection.gatewayId) return;
      if (result.status === "saved") onSaved(result.routine, asNew);
      else if (result.status === "deleted") {
        setSave({ status: "idle" });
        setGone(true);
      } else if (result.status === "unknown")
        setSave((each) =>
          each.status === "unknown"
            ? each
            : {
                status: "unknown",
                error: result.error,
                sent: fields,
                check: { status: "idle" },
              },
        );
      else setSave(result);
    };
    const timer = setTimeout(() => {
      if (id === attempt.current)
        setSave((each) =>
          each.status === "saving"
            ? {
                status: "unknown",
                error: "No answer in 30 seconds.",
                sent: fields,
                check: { status: "idle" },
              }
            : each,
        );
    }, ANSWER_MS);
    const request =
      !asNew && mode.mode === "edit" && original && against
        ? bridge.invoke({
            type: "updateRoutine",
            id: mode.routine.id,
            original,
            edit: fields,
            expected: { ...fieldsOf(against), updatedAt: against.updatedAt },
            gateway,
          })
        : bridge.invoke({
            type: "createRoutine",
            input: { ...fields, botId: draft.botId },
            key: key.current,
            gateway,
          });
    void request
      .then(settle, (error: unknown) => settle({ status: "unknown", error: errorText(error) }))
      .finally(() => clearTimeout(timer));
  };

  /** Reads only: does the gateway show what this save asked for? */
  const check = async () => {
    if (save.status !== "unknown") return;
    const { sent } = save;
    const id = attempt.current;
    const at = (next: Check) =>
      setSave((each) =>
        id === attempt.current && each.status === "unknown" ? { ...each, check: next } : each,
      );
    at({ status: "checking" });
    try {
      if (mode.mode === "new") {
        const found = await bridge.invoke({
          type: "findCreatedRoutine",
          key: key.current,
          gateway,
        });
        if (id !== attempt.current) return;
        if (!found) return at({ status: "missing" });
        if (changedFields(sent, fieldsOf(found)).length === 0) return onSaved(found, true);
        // It landed, then changed: the editor now edits it, from what this save
        // sent, so the other change is kept unless the person changes it too.
        setMode({ mode: "edit", routine: found });
        setOriginal(sent);
        attempt.current += 1;
        setSave({ status: "conflict", current: found });
        return;
      }
      // `gateway` is the one the save was written to: it never changes once bound.
      const fresh = await bridge.invoke({ type: "readRoutine", id: mode.routine.id, gateway });
      if (id !== attempt.current) return;
      if (!fresh) {
        setSave({ status: "idle" });
        setGone(true);
        return;
      }
      // Each field this save sent, as it was sent, against the job read back.
      const base = original ?? sent;
      const wanted = changedFields(base, sent);
      const differ = changedFields(sent, fieldsOf(fresh));
      if (!differ.some((each) => wanted.includes(each))) at({ status: "matches", routine: fresh });
      // A field that is neither what the editor opened with nor what this save
      // sent was changed by someone else. Otherwise the gateway may only not have
      // applied this save yet, and its answer can still come and settle it.
      else if (changedFields(base, fieldsOf(fresh)).some((each) => differ.includes(each))) {
        attempt.current += 1;
        setSave({ status: "conflict", current: fresh });
      } else at({ status: "unchanged" });
    } catch (error) {
      at({ status: "failed", error: errorText(error) });
    }
  };

  const showTheirs = (current: Routine) => {
    setMine({ draft, base: original ?? fieldsOfDraft(draft) });
    setDraft(draftOf(current, now));
    setOriginal(fieldsOf(current));
    setAccepted(current);
    setSave({ status: "idle" });
  };

  const notes: ReactNode[] = [];
  if (save.status === "refused")
    notes.push(
      <Note tone="danger" key="refused" testId="editor-refused">
        <p role="alert">
          <strong>The gateway didn&apos;t save this.</strong> {save.error}
        </p>
      </Note>,
    );
  if (save.status === "not-sent" && (save.reason === "offline" || save.reason === "gateway"))
    notes.push(
      <Note tone="warn" key="offline" testId="editor-offline">
        <p role="alert">
          {save.reason === "offline" ? (
            <>
              <strong>Not saved.</strong> Clawtrate isn&apos;t connected to the gateway, so nothing
              was sent.
            </>
          ) : (
            <>
              <strong>Not saved.</strong> The gateway hasn&apos;t confirmed its identity yet, so
              nothing was sent.
            </>
          )}
        </p>
      </Note>,
    );
  if (save.status === "unknown" && !deleted) {
    const c = save.check;
    notes.push(
      <Note tone="warn" key="unknown" testId="editor-unknown">
        <p role="alert">
          {c.status === "matches" ? (
            <>
              <strong>{c.routine.name} now reads as you typed it.</strong> That may be your save, or
              the same change made elsewhere.
            </>
          ) : c.status === "unchanged" ? (
            <>
              <strong>The gateway still has this routine as it was.</strong> The save may not have
              arrived yet. Check again in a moment.
            </>
          ) : c.status === "missing" ? (
            <>
              <strong>The gateway has no routine from this form yet.</strong> The save may still
              arrive. Saving again makes a new routine, so if the first save arrives too, there will
              be two.
            </>
          ) : (
            <>
              <strong>The gateway didn&apos;t answer.</strong> This may or may not have saved (
              {save.error}).{" "}
              {c.status === "failed"
                ? `Couldn't check: ${c.error}`
                : "Check what the gateway has before saving again."}
            </>
          )}
        </p>
        <div className="b-actions">
          {c.status !== "matches" && (
            <button
              type="button"
              className="button"
              data-size="sm"
              disabled={c.status === "checking"}
              onClick={() => void check()}
            >
              {c.status === "checking"
                ? "Checking what the gateway has…"
                : c.status === "idle"
                  ? "Check now"
                  : "Check again"}
            </button>
          )}
          {c.status === "matches" && (
            <button type="button" className="button" data-size="sm" onClick={onClose}>
              Close
            </button>
          )}
          {c.status === "missing" && admin && (
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="quiet"
              onClick={() => {
                key.current = newKey();
                submit();
              }}
            >
              Save again
            </button>
          )}
        </div>
      </Note>,
    );
  }
  if (changed && !deleted)
    notes.push(
      <Note tone="warn" key="changed" testId="editor-changed">
        <p role="alert">
          <strong>This routine was changed elsewhere</strong> while you were editing.
        </p>
        <div className="b-actions">
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => showTheirs(changed)}
          >
            Show the new version
          </button>
          {admin && (
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="quiet"
              onClick={() => submit(changed)}
            >
              Save mine anyway
            </button>
          )}
        </div>
      </Note>,
    );
  if (deleted)
    notes.push(
      <Note tone="warn" key="deleted" testId="editor-deleted">
        <p role="alert">
          <strong>This routine was deleted</strong> while you were editing.
        </p>
        <div className="b-actions">
          {admin && accepted?.canRecreate && (
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() => submit(undefined, true)}
            >
              Save as a new routine
            </button>
          )}
          <button
            type="button"
            className="button"
            data-size="sm"
            data-variant="quiet"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </Note>,
    );

  const described = (field: keyof Problems) =>
    errors[field] ? { "aria-invalid": true as const, "aria-describedby": `e-${field}-error` } : {};

  const onKindKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const at = KINDS.findIndex(([each]) => each === draft.when);
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = KINDS[(at + step + KINDS.length) % KINDS.length]![0];
    set({ when: next, cron: "" });
    requestAnimationFrame(() =>
      event.currentTarget?.querySelector<HTMLElement>(`[data-kind="${next}"]`)?.focus(),
    );
  };

  const zones = [
    ...new Set(
      store.routines
        .filter((each) => each.botId === draft.botId && each.schedule.tz)
        .map((each) => each.schedule.tz!),
    ),
  ];
  const allZones = Intl.supportedValuesOf("timeZone");
  const tzField = draft.when !== "every" && !draft.cron.trim() && (
    <Field id="e-tz" label="Time zone" error={undefined}>
      <select
        className="b-select"
        id="e-tz"
        value={draft.tz}
        onChange={(event) => set({ tz: event.target.value })}
      >
        <option value="auto">Auto-detect ({zoneCity(viewerZone())})</option>
        {zones.length > 0 && (
          <optgroup label={`${botName}'s routines`}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zoneCity(zone)} ({zone})
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Every zone">
          {allZones
            .filter((zone) => !zones.includes(zone))
            .map((zone) => (
              <option key={zone} value={zone}>
                {zoneCity(zone)} ({zone})
              </option>
            ))}
          {draft.tz !== "auto" && !allZones.includes(draft.tz) && !zones.includes(draft.tz) && (
            <option value={draft.tz}>{draft.tz}</option>
          )}
        </optgroup>
      </select>
      {draft.tz === "auto" && (
        <p className="r-hint">
          Writes this device&apos;s zone, {viewerZone()}. It does not follow the device later.
        </p>
      )}
    </Field>
  );

  let when: ReactNode;
  if (draft.locked) {
    const words = scheduleWords(draft.locked);
    when = (
      <div className="r-field">
        <span className="r-label">When</span>
        <div className="r-locked" data-testid="locked">
          {words.written ? <code>{words.text}</code> : words.text}
          {draft.locked.tz && `, ${zoneCity(draft.locked.tz)}`}
          <br />
          This schedule was set on the gateway. You can rename the routine and change its
          instruction here; change its schedule on the gateway.
        </div>
      </div>
    );
  } else {
    const time = (
      <input
        className="input"
        type="time"
        aria-label="At"
        id="e-time"
        value={draft.time}
        onChange={(event) => set({ time: event.target.value })}
      />
    );
    when = (
      <>
        <div className="r-field">
          <span className="r-label" id="e-when-label">
            When
          </span>
          {draft.cron.trim() ? (
            <p className="r-hint">Set by the cron expression under More.</p>
          ) : (
            <>
              <ul
                className="b-choices"
                role="radiogroup"
                aria-labelledby="e-when-label"
                onKeyDown={onKindKey}
                data-field="when"
                tabIndex={-1}
                {...described("when")}
              >
                {KINDS.map(([kind, label]) => (
                  <li key={kind}>
                    <button
                      type="button"
                      className="b-choice"
                      role="radio"
                      aria-checked={draft.when === kind}
                      tabIndex={draft.when === kind ? 0 : -1}
                      data-kind={kind}
                      onClick={() => set({ when: kind })}
                    >
                      <span className="b-choice-text">
                        <span className="b-choice-title">{label}</span>
                      </span>
                      <CheckIcon className="b-tick" />
                    </button>
                  </li>
                ))}
              </ul>
              {draft.when === "days" && (
                <div className="r-days" role="group" aria-label="Days">
                  {WEEK.map(([day, label]) => (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={draft.days.includes(day)}
                      onClick={() =>
                        set({
                          days: draft.days.includes(day)
                            ? draft.days.filter((each) => each !== day)
                            : [...draft.days, day],
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {(draft.when === "daily" || draft.when === "weekdays" || draft.when === "days") && (
                <div className="r-inline">
                  <label htmlFor="e-time">At</label>
                  {time}
                </div>
              )}
              {draft.when === "every" && (
                <div className="r-inline">
                  <label htmlFor="e-count">Every</label>
                  <input
                    className="input r-count"
                    type="number"
                    min={1}
                    id="e-count"
                    value={draft.count}
                    onChange={(event) => set({ count: event.target.value })}
                  />
                  <select
                    className="b-select r-unit"
                    aria-label="Unit"
                    value={draft.unit}
                    onChange={(event) => set({ unit: event.target.value as Draft["unit"] })}
                  >
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                  </select>
                </div>
              )}
              {draft.when === "once" && (
                <div className="r-inline">
                  <label htmlFor="e-date">On</label>
                  <input
                    className="input"
                    type="date"
                    id="e-date"
                    value={draft.date}
                    onChange={(event) => set({ date: event.target.value })}
                  />
                  {time}
                </div>
              )}
            </>
          )}
          {errors.when && (
            <p className="r-error" id="e-when-error">
              {errors.when}
            </p>
          )}
        </div>
        {tzField}
        {!errors.when && !errors.cron && <Preview draft={draft} now={checkedAt ?? now} />}
      </>
    );
  }

  const more = (
    <details className="b-disclosure r-more" open={draft.cron.trim() !== "" || undefined}>
      <summary>
        <ChevronIcon />
        More
      </summary>
      <div className="b-disclosure-body r-dialog-more">
        {!draft.locked && (
          <Field id="e-cron" label="Cron expression" error={errors.cron}>
            <input
              className="input r-mono"
              id="e-cron"
              data-field="cron"
              placeholder="0 8 * * 1-5"
              autoComplete="off"
              spellCheck={false}
              value={draft.cron}
              onChange={(event) => set({ cron: event.target.value })}
              {...described("cron")}
            />
          </Field>
        )}
        <div className="r-field">
          <span className="r-label">Runs in</span>
          <p className="r-locked">
            {draft.target === "isolated"
              ? "A new conversation each time"
              : draft.target === "main"
                ? `${botName}'s main conversation`
                : "The conversation it was made in"}
          </p>
        </div>
        {(draft.delivery === "none" || draft.delivery === "announce") && (
          <Field id="e-results" label="Results" error={undefined}>
            <select
              className="b-select"
              id="e-results"
              value={draft.delivery}
              onChange={(event) => set({ delivery: event.target.value as Draft["delivery"] })}
            >
              <option value="none">Keep them with the run</option>
              <option value="announce">Also announce to the gateway&apos;s channels</option>
            </select>
          </Field>
        )}
      </div>
    </details>
  );

  // A note about how a save ended is at the top of the form: bring it into view.
  const noteKeys = notes.map((note) => (note as { key: string }).key).join(" ");
  useEffect(() => {
    if (noteKeys) bodyRef.current?.scrollTo({ top: 0 });
  }, [noteKeys]);

  const textLabel =
    payload === "systemEvent" ? "Reminder" : payload === "other" ? "Command" : "Instruction";
  // While a save is in flight its dialog stays: Cancel, Close and Escape wait for the answer.
  const close = () => {
    if (!saving) onClose();
  };
  return (
    <Dialog kind="create" labelledBy="r-edit-title" onClose={close} testId="routine-editor">
      <div className="b-sheet r-dialog">
        <header className="b-head">
          <h2 id="r-edit-title" tabIndex={-1}>
            {mode.mode === "new" ? "New routine" : "Edit routine"}
          </h2>
          <button type="button" className="icon-button b-close" aria-label="Close" onClick={close}>
            <CloseIcon />
          </button>
        </header>
        <div className="b-body" ref={bodyRef}>
          {notes}
          <fieldset className="r-fields" disabled={busy} aria-busy={saving || undefined}>
            {mode.mode === "new" ? (
              <Field id="e-bot" label="Bot" error={undefined}>
                <select
                  className="b-select"
                  id="e-bot"
                  value={draft.botId}
                  onChange={(event) =>
                    set({
                      botId: event.target.value,
                      tz: usualZone(store.routines, event.target.value) ?? draft.tz,
                    })
                  }
                >
                  {bots.map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <div className="r-field">
                <span className="r-label">Bot</span>
                <p className="r-hint">{botName}. To run it on another bot, make a new routine.</p>
              </div>
            )}
            <Field id="e-name" label="Name" error={errors.name}>
              <input
                className="input"
                id="e-name"
                data-field="name"
                data-b-focus=""
                maxLength={MAX_NAME_CHARS}
                autoComplete="off"
                value={draft.name}
                onChange={(event) => set({ name: event.target.value })}
                {...described("name")}
              />
            </Field>
            {textLocked ? (
              <div className="r-field">
                <span className="r-label">{textLabel}</span>
                <div className="r-locked">
                  {payload === "agentTurn" ? null : <p className="r-instruction">{draft.text}</p>}
                  {payload === "systemEvent"
                    ? "This reminder's text was set on the gateway. You can rename the routine and change when it runs here; change its text on the gateway."
                    : payload === "other"
                      ? "This routine runs a command on the gateway, not a bot. You can rename the routine and change when it runs here; change what it runs on the gateway."
                      : "This instruction is too long to change here. Change it on the gateway."}
                </div>
              </div>
            ) : (
              <Field id="e-text" label={textLabel} error={errors.text}>
                <textarea
                  className="input"
                  id="e-text"
                  data-field="text"
                  rows={6}
                  placeholder={`What should ${botName} do each time? For example: Summarise yesterday's notes and list anything I need to answer.`}
                  value={draft.text}
                  onChange={(event) => set({ text: event.target.value })}
                  {...described("text")}
                />
              </Field>
            )}
            {when}
            {more}
          </fieldset>
          {mine && (
            <details className="b-disclosure" data-testid="your-version">
              <summary>
                <ChevronIcon />
                Your version
              </summary>
              <div className="b-disclosure-body r-yours">
                <p>
                  <strong>{mine.draft.name}</strong> · {whenWords(fieldsOfDraft(mine.draft))}
                </p>
                <p className="r-instruction">{mine.draft.text}</p>
                <button
                  type="button"
                  className="button"
                  data-size="sm"
                  // Outside the fieldset: while a save is out, the draft it sent stays as it is.
                  disabled={busy}
                  onClick={() => setDraft(mineOver(draft, mine, textLocked))}
                >
                  Use my version
                </button>
              </div>
            </details>
          )}
          {mode.mode === "new" && (
            <p className="r-hint">
              It runs first at its next time; creating it doesn&apos;t run it.
            </p>
          )}
        </div>
        <footer className="b-foot">
          {admin ? (
            <div className="b-actions">
              <button
                type="button"
                className="button"
                data-variant="quiet"
                aria-disabled={saving || undefined}
                onClick={close}
              >
                Cancel
              </button>
              {save.status !== "unknown" && !deleted && !changed && (
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  disabled={saving}
                  onClick={() => submit()}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              )}
            </div>
          ) : (
            <AdminBar
              connection={connection}
              info={info}
              need="Admin access was lost: saving needs it again. What you typed is kept."
            />
          )}
        </footer>
      </div>
    </Dialog>
  );
}
