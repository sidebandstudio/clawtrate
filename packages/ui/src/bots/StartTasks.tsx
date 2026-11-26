// #532: a bot the gateway doesn't give its tool for starting a task (`sessions_spawn`) can't
// move work into a task when asked, so its settings say so, in one line with the gateway's
// reason when it gives one. Nothing here changes the bot's tools.

import { botStartTasks, type Transcript } from "@clawtrate/core";

/** The line, or null while the bot can start tasks or none of its tasks' tools has been read. */
export function startTasksLine(
  name: string,
  botId: string,
  transcripts: Readonly<Record<string, Transcript>>,
): string | null {
  const start = botStartTasks(botId, transcripts);
  if (!start || start.can) return null;
  if (!start.reason)
    return `${name} can't start tasks: the gateway doesn't give it the tool for that.`;
  return `${name} can't start tasks. The gateway says: ${start.reason.replace(/[.\s]+$/, "")}.`;
}

export function StartTasksRow({
  name,
  botId,
  transcripts,
}: {
  name: string;
  botId: string;
  transcripts: Readonly<Record<string, Transcript>>;
}) {
  const line = startTasksLine(name, botId, transcripts);
  if (line === null) return null;
  return (
    <>
      <h3 className="b-tabgroup">Tasks</h3>
      <p className="b-hint" data-testid="start-tasks">
        {line}
      </p>
    </>
  );
}
