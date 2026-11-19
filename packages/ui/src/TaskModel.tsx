// A task's model and effort (docs/design/conversation.md, section 25): the
// model chip in the conversation's header, the Model group in the task's
// Details, and the line a change leaves in the transcript. What a turn ran
// with is the run line's record (actions/ActionCards.tsx).

import {
  catalogEntry,
  shownChoice,
  taskModelLine,
  type Bot,
  type Task,
  type TaskModelEvent,
  type TaskModelView,
} from "@clawtrate/core";
import { useCallback, useState, type ReactNode } from "react";
import { useBridge, useClawtrateState } from "./bridge.tsx";
import { Select } from "./bots/parts.tsx";
import { levelWord } from "./bots/words.ts";
import { ChevronIcon, ClockIcon, WarnIcon } from "./icons.tsx";
import { Menu, type MenuEntry } from "./Menu.tsx";
import "./task-model.css";

/** The model's id without its provider: "dev-2". */
const idOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);
const clock = (at: number) =>
  new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

type Chosen = { model: string | null; effort: string | null };

/** The view of a task, and a way to choose for it that announces what happened. */
function useTaskModel(task: Task, announce: (text: string) => void) {
  const bridge = useBridge();
  const view = useClawtrateState().taskModels[task.key];
  const choose = useCallback(
    async (choice: Chosen) => {
      try {
        const outcome = await bridge.invoke({
          type: "setTaskModel",
          key: task.key,
          model: choice.model,
          effort: choice.effort,
        });
        if (outcome === "held") announce("Held until this turn ends");
        else if (outcome === "unconfirmed") announce("Couldn't confirm the change");
        else if (outcome === "saved")
          announce(choice.model ? "Model changed for this task" : "Effort changed for this task");
      } catch {
        announce(choice.model ? "Couldn't change the model" : "Couldn't change the effort");
      }
    },
    [bridge, task.key, announce],
  );
  const keep = useCallback(() => {
    void bridge.send({ type: "keepTaskModel", key: task.key }).catch(() => {});
  }, [bridge, task.key]);
  const reread = useCallback(() => {
    void bridge.send({ type: "readTaskModels", key: task.key }).catch(() => {});
  }, [bridge, task.key]);
  return { view, choose, keep, reread };
}

/** The menu's two groups: the models of the task's provider, the levels of the model shown. */
function menuEntries(
  view: TaskModelView | undefined,
  shown: { model: string | null; effort: string | null },
  bot: Bot,
  choose: (choice: Chosen) => void,
  reread: () => void,
): MenuEntry[] {
  if (!view || view.catalog === "idle" || (view.catalog === "loading" && !view.models.length))
    return [{ kind: "label", text: "Loading models…" }];
  if (view.catalog === "error" && !view.models.length)
    return [
      { kind: "label", text: "Couldn't load the models." },
      { kind: "item", label: "Try again", onSelect: reread },
    ];
  const levels = catalogEntry(view.models, shown.model)?.levels ?? [];
  return [
    {
      kind: "group",
      label: "Model",
      entries: view.models.map((model) => {
        const ref = `${model.provider}/${model.id}`;
        return {
          kind: "radio" as const,
          label: model.id,
          checked: ref === shown.model,
          onSelect: () => choose({ model: ref, effort: null }),
          ...(model.available ? {} : { note: "Not available", disabled: true }),
        };
      }),
    },
    { kind: "rule" },
    {
      kind: "group",
      label: "Effort",
      entries: levels.length
        ? levels.map((level) => ({
            kind: "radio" as const,
            label: levelWord(level),
            checked: level === shown.effort,
            onSelect: () => choose({ model: null, effort: level }),
          }))
        : [
            {
              kind: "radio" as const,
              label: "Not offered",
              checked: false,
              disabled: true,
              onSelect: () => {},
            },
          ],
    },
    { kind: "rule" },
    { kind: "label", text: `For this task. ${bot.name}'s own model is in its settings.` },
  ];
}

/** The chip's accessible name and tooltip (25.1). */
function chipName(shown: ReturnType<typeof shownChoice>, interactive: boolean): string {
  if (!shown.model) return `Model for this task: not reported.${interactive ? " Change." : ""}`;
  return (
    `Model for this task: ${shown.model}, ${levelWord(shown.effort)} effort.` +
    (shown.held ? " Held until this turn ends." : "") +
    (shown.pending ? " Saving." : "") +
    (interactive ? " Change." : "")
  );
}

/**
 * The model chip, at the top left of the conversation's header band from 688
 * px up (25.1). On a connection that may only read, the values with no control.
 */
export function ModelChip({
  task,
  bot,
  interactive,
  connected,
  onAnnounce,
}: {
  task: Task;
  bot: Bot;
  interactive: boolean;
  connected: boolean;
  onAnnounce: (text: string) => void;
}) {
  const { view, choose, reread } = useTaskModel(task, onAnnounce);
  const shown = shownChoice(task, view);
  // Where the menu opens: the chip's own box, taken when it opens.
  const [anchor, setAnchor] = useState<{ rect: DOMRect; element: HTMLButtonElement } | null>(null);
  const close = useCallback(
    (refocus: boolean) => {
      const element = anchor?.element;
      setAnchor(null);
      if (refocus) element?.focus();
    },
    [anchor],
  );
  const openFrom = (element: HTMLButtonElement) =>
    setAnchor({ rect: element.getBoundingClientRect(), element });
  const name = chipName(shown, interactive);
  const body = (
    <>
      {shown.held && <ClockIcon className="model-chip-held" />}
      <span className="model-chip-model">
        {shown.model ? idOf(shown.model) : "Model not reported"}
      </span>
      {shown.model && (
        <>
          <span className="model-chip-dot" aria-hidden="true">
            ·
          </span>
          <span className="model-chip-effort">{levelWord(shown.effort)}</span>
        </>
      )}
    </>
  );
  if (!interactive)
    return (
      <p className="model-chip" role="note" aria-label={name} title={name} data-testid="model-chip">
        {body}
      </p>
    );
  return (
    <>
      <button
        type="button"
        className="model-chip"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={name}
        aria-busy={view?.saving || undefined}
        title={name}
        disabled={!connected}
        data-testid="model-chip"
        onClick={(event) => (anchor ? setAnchor(null) : openFrom(event.currentTarget))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !anchor) {
            event.preventDefault();
            openFrom(event.currentTarget);
          }
        }}
      >
        {body}
        <ChevronIcon className="model-chip-chevron" />
      </button>
      {anchor && (
        <Menu
          label="Model and effort for this task"
          className="model-menu"
          entries={menuEntries(
            view,
            shown,
            bot,
            (choice) => {
              close(true);
              void choose(choice);
            },
            reread,
          )}
          onClose={close}
          trigger={anchor.element}
          style={{
            position: "fixed",
            left: Math.max(8, Math.min(anchor.rect.left, innerWidth - 288)),
            top: anchor.rect.bottom + 6,
          }}
        />
      )}
    </>
  );
}

/** The Model group in the task's Details tab (25.1, 25.2). */
export function TaskModelDetails({
  task,
  bot,
  interactive,
  connected,
  onAnnounce,
}: {
  task: Task;
  bot: Bot;
  interactive: boolean;
  connected: boolean;
  onAnnounce: (text: string) => void;
}) {
  const { view, choose, keep } = useTaskModel(task, onAnnounce);
  const shown = shownChoice(task, view);
  if (!interactive)
    return (
      <section className="task-model" data-testid="task-model">
        <h3 className="work-group">Model</h3>
        <dl className="facts">
          <div>
            <dt>Model</dt>
            <dd>{shown.model ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Effort</dt>
            <dd>{levelWord(shown.effort)}</dd>
          </div>
        </dl>
      </section>
    );
  const models = view?.models ?? [];
  const levels = catalogEntry(models, shown.model)?.levels ?? [];
  const held = view?.held ?? null;
  const was = task.model ? idOf(task.model) : "the model it has";
  let line: ReactNode = `For this task. ${bot.name}'s own model is in Settings.`;
  if (held)
    line = (
      <>
        Held until {bot.name}'s turn ends, then saved. It applies from the next turn.{" "}
        <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={keep}>
          Keep {was}
        </button>
      </>
    );
  else if (view?.saving) line = "Saving…";
  else if (view?.refused) {
    const last = view.events.at(-1);
    const what = last?.model ? "the model" : "the effort";
    line = (
      <span className="task-model-refused">
        Couldn't change {what}: {view.refused.error}.
      </span>
    );
  }
  return (
    <section className="task-model" data-testid="task-model">
      <h3 className="work-group">Model</h3>
      <div className="b-pair">
        <Select
          label="Model"
          value={shown.model ?? "Not reported"}
          choices={models.map((model) => ({
            value: `${model.provider}/${model.id}`,
            label: model.id,
            disabled: !model.available,
            ...(model.available ? {} : { note: "Not available" }),
          }))}
          onChoose={(model) => void choose({ model, effort: null })}
          disabled={!connected}
          testId="task-model-select"
        />
        <Select
          label="Effort"
          value={levels.length === 0 ? "Not offered" : (shown.effort ?? "")}
          choices={levels.map((level) => ({ value: level, label: levelWord(level) }))}
          onChoose={(effort) => void choose({ model: null, effort })}
          disabled={!connected || levels.length === 0}
          testId="task-effort-select"
        />
      </div>
      <p
        className="b-hint"
        data-testid="task-model-line"
        role={view?.refused ? "alert" : undefined}
      >
        {line}
      </p>
    </section>
  );
}

/** The words of a line's tooltip and name: what it was, and when (25.4). */
function lineDetail(event: TaskModelEvent): string {
  const was = event.wasModel
    ? `Was ${event.wasModel}${event.wasEffort ? ` · ${levelWord(event.wasEffort)}` : ""}.`
    : "";
  const followed =
    event.followed && event.model && event.wasEffort
      ? `${event.model} doesn't offer ${levelWord(event.wasEffort)}. `
      : "";
  const when =
    event.outcome === "refused"
      ? `Refused at ${clock(event.at)}.`
      : event.outcome === "unconfirmed"
        ? `Sent at ${clock(event.at)} from this device; the gateway's answer did not show it.`
        : `Changed at ${clock(event.at)} on this device.`;
  return `${followed}${was} ${when}`.trim();
}

/** One line a change of the task's model or effort left (25.4). */
export function TaskModelLine({ event }: { event: TaskModelEvent }) {
  const text = taskModelLine(event, levelWord);
  const detail = lineDetail(event);
  return (
    <p
      className="event-line model-line"
      data-side="center"
      data-tone={event.outcome === "changed" ? undefined : "warn"}
      data-testid="model-line"
      title={detail}
      aria-label={`${text}. ${detail}`}
    >
      {event.outcome !== "changed" && <WarnIcon />}
      {text}
    </p>
  );
}
