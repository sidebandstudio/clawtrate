// What the rail does to tasks and to its arrangement (visual-language.md,
// section 7; parity F-054 to F-060, F-277, F-278, F-424, F-014, F-016, F-022):
// new, rename in place, pin, mark unread or read, archive into the bot's
// Archived group, restore, delete, and the dialogs that confirm or name.
// Every action is the engine's (`task-actions.ts`), asked only when the person
// chooses it; on a read-only connection the rail offers none of them.

import type { ArchivedList, ArchivedTask, Bot, Task } from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useBridge } from "./bridge.tsx";
import type { ShownStamp } from "./stamp.ts";
import { rowTime } from "./format.ts";
import { ChevronIcon } from "./icons.tsx";

// The dialog -----------------------------------------------------------------------

export type DialogSpec = {
  title: string;
  body: ReactNode;
  /** The confirming action. */
  confirm: { label: string; tone?: "danger" };
  /** A name to type (a new section). */
  field?: { label: string; placeholder?: string; maxLength: number };
  /** Runs the action; a refusal stays in the dialog as its error. */
  onConfirm: (value: string) => Promise<void>;
  /** Where focus goes when the dialog closes without acting. */
  returnTo: HTMLElement | null;
};

/**
 * A modal dialog over the shell: role `dialog`, focus kept inside, Escape and
 * Cancel close it and give focus back. A confirmation opens with focus on
 * Cancel, so Enter alone never deletes; one with a field opens on the field.
 * While its action runs, the buttons wait and say so.
 */
export function RailDialog({
  spec,
  onClose,
}: {
  spec: DialogSpec;
  onClose: (acted: boolean) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    (
      dialog?.querySelector<HTMLElement>(".rail-dialog-field input") ??
      dialog?.querySelector<HTMLElement>('[data-role="cancel"]')
    )?.focus();
  }, []);

  const cancel = () => {
    if (busy) return;
    onClose(false);
    if (spec.returnTo?.isConnected) spec.returnTo.focus();
  };

  const confirm = async () => {
    if (busy) return;
    if (spec.field && !value.trim()) {
      setError(`${spec.field.label} is empty.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await spec.onConfirm(value);
      onClose(true);
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
      event.preventDefault();
      void confirm();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>("button, input")].filter(
      (item) => !item.hasAttribute("disabled"),
    );
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  // Over the whole app, as Settings is, not only over the rail it was opened from.
  return createPortal(
    <div className="settings-layer rail-dialog-layer">
      <button
        type="button"
        className="settings-scrim"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={cancel}
      />
      <section
        ref={ref}
        className="settings rail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rail-dialog-title"
        aria-describedby="rail-dialog-body"
        aria-busy={busy || undefined}
        data-testid="rail-dialog"
        onKeyDown={onKey}
      >
        <h2 id="rail-dialog-title">{spec.title}</h2>
        <div id="rail-dialog-body" className="rail-dialog-body">
          {spec.body}
        </div>
        {spec.field && (
          <label className="rail-dialog-field">
            <span>{spec.field.label}</span>
            <input
              type="text"
              value={value}
              maxLength={spec.field.maxLength}
              placeholder={spec.field.placeholder}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="form-error rail-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="settings-actions rail-dialog-actions">
          <button
            type="button"
            className="button"
            data-role="cancel"
            disabled={busy}
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button"
            data-variant={spec.confirm.tone === "danger" ? "danger" : "primary"}
            data-role="confirm"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "Working…" : spec.confirm.label}
          </button>
        </div>
      </section>
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}

// Rename in place ------------------------------------------------------------------

/**
 * A task row's title as a field (F-056): Enter or leaving the field renames,
 * Escape keeps the old name. A name the gateway refuses stays in the field
 * with the reason under it.
 */
export function RenameField({
  task,
  onCommit,
  onDone,
}: {
  task: Task;
  onCommit: (label: string) => Promise<void>;
  /** `renamed` is false when the old name was kept. */
  onDone: (renamed: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(task.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = async () => {
    if (busy || settled.current) return;
    const label = value.trim();
    if (!label || label === task.title) {
      settled.current = true;
      onDone(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCommit(label);
      settled.current = true;
      onDone(true);
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : String(failure));
      ref.current?.focus();
    }
  };

  return (
    <div className="task-rename" data-testid="task-rename">
      <input
        ref={ref}
        type="text"
        value={value}
        maxLength={512}
        aria-label={`Rename ${task.title}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `rename-error-${task.key}` : undefined}
        aria-busy={busy || undefined}
        readOnly={busy}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            settled.current = true;
            onDone(false);
          }
          // The rail's arrow keys belong to the rows, not the field.
          event.stopPropagation();
        }}
        onBlur={() => {
          if (!error) void commit();
        }}
      />
      {error && (
        <p className="task-rename-error" id={`rename-error-${task.key}`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// The Archived group ---------------------------------------------------------------

/**
 * A bot's archived tasks (F-277), read from the gateway when the group opens
 * and again when the bot's task list changes; nothing of them is kept. Each
 * row opens its menu: Restore and Delete, when the connection writes.
 */
export function ArchivedGroup({
  bot,
  tasks,
  gone,
  open,
  onToggle,
  onMenu,
  shown: drawnOn,
  now,
}: {
  bot: Bot;
  /** The bot's listed tasks, so an archive or a restore reads the group again. */
  tasks: Task[];
  /** Tasks this viewer deleted or restored from the group: gone at once, before it reads again. */
  gone: ReadonlyMap<string, number | null>;
  open: boolean;
  onToggle: () => void;
  /** A row's menu gets the stamp of the read the row came from (`ShownStamp`). */
  onMenu: (
    task: ArchivedTask,
    trigger: HTMLElement,
    x: number,
    y: number,
    shown: ShownStamp,
  ) => void;
  /** Where the rail is drawn now: each read keeps it, and a new target reads again. */
  shown: ShownStamp;
  now: number;
}) {
  const bridge = useBridge();
  // Where the rows shown were read: a row read on one connection acts there and nowhere else.
  const [list, setList] = useState<(ArchivedList & { shown: ShownStamp }) | null>(null);
  const asked = useRef(drawnOn);
  useLayoutEffect(() => {
    asked.current = drawnOn;
  });
  const target = drawnOn.target;
  const [error, setError] = useState<string | null>(null);
  const keys = tasks.map((task) => task.key).join("\n");
  const goneKeys = [...gone].map(([key, at]) => `${key} ${at}`).join("\n");

  useEffect(() => {
    if (!open) return;
    let live = true;
    const shown = asked.current;
    bridge.invoke({ type: "listArchived", botId: bot.id }).then(
      (next) => {
        if (!live) return;
        setList({ ...next, shown });
        setError(null);
      },
      (failure: unknown) =>
        live && setError(failure instanceof Error ? failure.message : String(failure)),
    );
    return () => {
      live = false;
    };
  }, [open, bridge, bot.id, keys, goneKeys, target]);
  // Hidden only while the gateway still lists that same archive of the task.
  const shown = list && {
    ...list,
    tasks: list.tasks.filter(
      (task) => !gone.has(task.key) || gone.get(task.key) !== task.archivedAt,
    ),
  };

  const menuAt = (task: ArchivedTask) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.detail === 0;
    onMenu(
      task,
      event.currentTarget,
      fromKeyboard ? rect.left + 40 : event.clientX,
      fromKeyboard ? rect.bottom - 6 : event.clientY,
      list?.shown ?? drawnOn,
    );
  };

  return (
    <li className="archived-group" data-testid="archived-group">
      <button
        type="button"
        className="task task-more archived-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronIcon />
        <span className="task-title">Archived</span>
      </button>
      {open && (
        <ul className="task-list archived-list" aria-label={`${bot.name}'s archived tasks`}>
          {error ? (
            <li className="archived-note" role="alert">
              Couldn't read the archived tasks. {error}
            </li>
          ) : shown === null ? (
            <li className="archived-note" aria-busy="true">
              Loading archived tasks…
            </li>
          ) : shown.tasks.length === 0 ? (
            <li className="archived-note">No archived tasks.</li>
          ) : (
            shown.tasks.map((task) => (
              <li key={task.key}>
                <button
                  type="button"
                  className="task archived-task"
                  data-testid="archived-task"
                  data-key={task.key}
                  aria-haspopup="menu"
                  aria-label={`${task.title}, archived`}
                  aria-description={
                    task.archivedAt === null
                      ? undefined
                      : `Archived ${rowTime(task.archivedAt, now)}`
                  }
                  onClick={menuAt(task)}
                  onContextMenu={menuAt(task)}
                >
                  <span className="task-title">{task.title}</span>
                  {task.archivedAt !== null && (
                    <time className="task-time" aria-hidden="true">
                      {rowTime(task.archivedAt, now)}
                    </time>
                  )}
                  <span className="task-mark" aria-hidden="true" />
                </button>
              </li>
            ))
          )}
          {shown?.more && <li className="archived-note">Showing the 50 most recent.</li>}
        </ul>
      )}
    </li>
  );
}

// The actions ----------------------------------------------------------------------

/** A task's run is active: archiving or deleting it stops the run first. */
export function isActive(task: Pick<Task, "status">): boolean {
  return task.status === "running" || task.status === "waiting" || task.status === "queued";
}

/** The row to focus once a task leaves its list: the next, else the previous, else none. */
export function neighbour(tasks: Task[], key: string): string | null {
  const index = tasks.findIndex((task) => task.key === key);
  if (index === -1) return null;
  return tasks[index + 1]?.key ?? tasks[index - 1]?.key ?? null;
}

/**
 * Run one action and report how it went: a refusal is announced and shown in
 * the rail's notice; while the engine waits for the gateway's owner to grant
 * access, the access bar says so.
 */
/** The rail's notice for one action: a refusal, or what an action did beyond its name, with a way back. */
export type RailNotice = {
  text: string;
  tone: "danger" | "info";
  action?: { label: string; onSelect: () => void };
};

export function useActionRunner(announce: (text: string) => void) {
  const [notice, setNotice] = useState<RailNotice | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  const run = useCallback(
    async <T,>(what: string, action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action();
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        const text = `Couldn't ${what}. ${message}`;
        setNotice({ text, tone: "danger" });
        announce(text);
        return undefined;
      }
    },
    [announce],
  );
  /** Say what an action did beyond its name, in the action's notice. */
  const tell = useCallback(
    (next: RailNotice) => {
      setNotice(next);
      announce(next.text);
    },
    [announce],
  );
  return { notice, dismiss: () => setNotice(null), run, tell };
}
