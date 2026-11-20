// A task's model and effort (docs/design/conversation.md, section 25): the
// model chip in the conversation's header, the Model group in the task's
// Details, and the line a change leaves in the transcript. What a turn ran
// with is the run line's record (actions/ActionCards.tsx).

import {
  effortLevels,
  shownChoice,
  taskModelLine,
  type Bot,
  type EffortLevels,
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

/** The effort's word: the level known, else "Not offered" only for a model listed with none (25.2). */
function effortWord(effort: string | null, known: EffortLevels): string {
  if (effort) return levelWord(effort);
  return known.kind === "none" ? "Not offered" : "Not reported";
}

/** Why a model's levels are not known, in the menu and under the selects (25.2). */
function unknownLevels(known: EffortLevels, model: string | null): string | null {
  if (known.kind === "loading") return "Loading the models…";
  if (known.kind === "failed")
    return `Couldn't load the models${known.error ? `: ${known.error}` : ""}.`;
  // The list shown is the task's provider's first models, not every model the gateway has.
  if (known.kind === "unlisted")
    return `${model ?? "This model"} isn't in the list shown here, so its effort levels aren't known.`;
  if (known.kind === "unreported") return "The gateway didn't report this model's effort levels.";
  return null;
}

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
  const known = effortLevels(view, shown.model);
  const why = unknownLevels(known, shown.model);
  // The Effort group: the levels, or "Not offered" for a model listed with none; when the levels
  // are not known, why, in place of the group.
  const efforts: MenuEntry[] =
    known.kind === "levels" || known.kind === "none"
      ? [
          {
            kind: "group",
            label: "Effort",
            entries:
              known.kind === "levels"
                ? known.levels.map((level) => ({
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
        ]
      : [
          { kind: "label", text: `Effort: ${why ?? ""}` },
          ...(known.kind === "failed"
            ? [{ kind: "item" as const, label: "Try again", onSelect: reread }]
            : []),
        ];
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
    ...efforts,
    { kind: "rule" },
    { kind: "label", text: `For this task. ${bot.name}'s own model is in its settings.` },
  ];
}

/** The chip's accessible name and tooltip (25.1). */
function chipName(
  shown: ReturnType<typeof shownChoice>,
  known: EffortLevels,
  interactive: boolean,
): string {
  if (!shown.model) return `Model for this task: not reported.${interactive ? " Change." : ""}`;
  const effort = shown.effort
    ? `${levelWord(shown.effort)} effort`
    : known.kind === "none"
      ? "effort not offered"
      : "effort not reported";
  return (
    `Model for this task: ${shown.model}, ${effort}.` +
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
  const known = effortLevels(view, shown.model);
  const name = chipName(shown, known, interactive);
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
          <span className="model-chip-effort">{effortWord(shown.effort, known)}</span>
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
        disabled={!connected || view?.saving === true}
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
  const { view, choose, keep, reread } = useTaskModel(task, onAnnounce);
  const shown = shownChoice(task, view);
  const known = effortLevels(view, shown.model);
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
            <dd>{effortWord(shown.effort, known)}</dd>
          </div>
        </dl>
      </section>
    );
  const models = view?.models ?? [];
  const levels = known.kind === "levels" ? known.levels : [];
  const why = unknownLevels(known, shown.model);
  const held = view?.held ?? null;
  const was = task.model ? idOf(task.model) : "the model it has";
  let line: ReactNode = `For this task. ${bot.name}'s own model is in Settings.`;
  if (held)
    line = (
      <>
        Held until {bot.name}'s turn ends. Clawtrate will then try to save it.{" "}
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
  } else if (why)
    line = (
      <>
        {why}
        {known.kind === "failed" && (
          <>
            {" "}
            <button
              type="button"
              className="button"
              data-variant="quiet"
              data-size="sm"
              onClick={reread}
            >
              Try again
            </button>
          </>
        )}
      </>
    );
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
          disabled={!connected || view?.saving === true}
          testId="task-model-select"
        />
        <Select
          label="Effort"
          value={levels.length === 0 ? effortWord(shown.effort, known) : (shown.effort ?? "")}
          choices={levels.map((level) => ({ value: level, label: levelWord(level) }))}
          onChoose={(effort) => void choose({ model: null, effort })}
          disabled={!connected || view?.saving === true || levels.length === 0}
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
    ? `Last read ${event.wasModel}${event.wasEffort ? ` · ${levelWord(event.wasEffort)}` : ""}.`
    : "";
  const followed =
    event.followed && event.model && event.wasEffort
      ? `${event.model} doesn't offer ${levelWord(event.wasEffort)}. `
      : "";
  const when =
    event.outcome === "refused"
      ? `Refused at ${clock(event.at)}.`
      : event.outcome === "unconfirmed"
        ? `Change unconfirmed at ${clock(event.at)} on this device.`
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
