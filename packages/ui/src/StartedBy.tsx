// A task a bot started (F-565): a line under the task's name saying which bot started it and
// from which task, with a way to open that task, and the bot's brief in place of the first
// message. Who started it comes from the gateway's own fields (`Task.startedBy`); the label and
// the brief are the bot's words, drawn as text.

import type { Bot, Task } from "@clawtrate/core";
import { Avatar } from "./Avatar.tsx";
import { Markdown } from "./Markdown.tsx";

/** Who started a task, as the line and the brief name them. */
export type Starter = {
  /** The bot's name, or its id when this client does not list it. */
  name: string;
  bot: Bot | null;
  /** The task it was started from, when this client lists it. */
  from: Task | null;
};

/** The starter of a task a bot started, from the bots and tasks this client lists; null otherwise. */
export function starterOf(
  task: Task,
  bots: readonly Bot[],
  tasksByBot: Record<string, Task[]>,
): Starter | null {
  const started = task.startedBy;
  if (!started) return null;
  const bot = bots.find((each) => each.id === started.botId) ?? null;
  const from =
    Object.values(tasksByBot)
      .flat()
      .find((each) => each.key === started.fromKey) ?? null;
  return { name: bot?.name ?? started.botId, bot, from };
}

/**
 * "Pip started this task from Main · Open Main". Without the task it came from, or a way to
 * open it, the line says only what it can: who started it, and from where when that is listed.
 */
export function StartedLine({
  starter,
  onOpen,
}: {
  starter: Starter;
  onOpen: ((botId: string, key: string) => void) | null;
}) {
  const { name, from } = starter;
  return (
    <p className="started-by" data-testid="started-by">
      {from ? (
        <>
          {name} started this task from <span className="started-from">{from.title}</span>
          {onOpen ? (
            <>
              <span aria-hidden="true"> · </span>
              <button
                type="button"
                className="link-button"
                data-testid="open-started-from"
                onClick={() => onOpen(from.botId, from.key)}
              >
                Open {from.title}
              </button>
            </>
          ) : (
            "."
          )}
        </>
      ) : (
        `${name} started this task.`
      )}
    </p>
  );
}

/** The first message of a task a bot started: the bot's brief, not the person's message. */
export function BriefTurn({ text, starter }: { text: string; starter: Starter }) {
  return (
    <div className="turn" data-role="brief" data-testid="transcript-turn">
      <figure className="brief" data-testid="task-brief">
        <figcaption className="brief-head">
          {starter.bot && <Avatar bot={starter.bot} />}
          {starter.name}'s brief
        </figcaption>
        <div className="brief-text">
          <Markdown text={text} />
        </div>
      </figure>
    </div>
  );
}
