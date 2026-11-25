// Whether a bot can start tasks of its own: the gateway's `sessions_spawn` tool, as
// `tools.effective` reports it for one of the bot's tasks (OpenClaw 2026.10.6). The bot's
// settings say so when it can't, and change nothing (#532).

import { asRecord } from "./mapping.ts";
import { MAX_START_TASKS_REASON_CHARS } from "./state-bounds.ts";

/** The gateway's tool a bot starts a task with. */
export const START_TASK_TOOL = "sessions_spawn";

/**
 * Whether the task's bot has the tool, and when it hasn't, the gateway's reason: the labels
 * `toolAccess` gives it (for example "Not included in tools.allow"), or null when it gives none.
 */
export type StartTasks = { can: boolean; reason: string | null };

/**
 * Read from a `tools.effective` answer: `groups[].tools[]` lists the tools the session has, and
 * `toolAccess.tools[]` each tool's `status` with its `reasons[].label`. Null when the answer
 * lists no tools at all, so nothing is said.
 */
export function startTasksFrom(answer: unknown): StartTasks | null {
  const value = asRecord(answer);
  const groups = value?.groups;
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    const tools = asRecord(group)?.tools;
    for (const entry of Array.isArray(tools) ? tools : []) {
      const tool = asRecord(entry);
      if (tool?.id === START_TASK_TOOL && tool.deniedBySession !== true)
        return { can: true, reason: null };
    }
  }
  const access = asRecord(value?.toolAccess)?.tools;
  const row = (Array.isArray(access) ? access : [])
    .map(asRecord)
    .find((each) => each?.id === START_TASK_TOOL);
  const labels = (Array.isArray(row?.reasons) ? row.reasons : [])
    .map((reason) => asRecord(reason)?.label)
    .filter((label): label is string => typeof label === "string" && label.trim() !== "")
    .map((label) => label.trim());
  const reason = [...new Set(labels)].join("; ");
  return {
    can: false,
    reason: reason ? reason.slice(0, MAX_START_TASKS_REASON_CHARS) : null,
  };
}

/**
 * What the bot's tasks say, preferring its main conversation: a task a bot started can lose
 * the tool at the gateway's depth limit, which says nothing about the bot. Null until one of
 * them has been read.
 */
export function botStartTasks(
  botId: string,
  transcripts: Readonly<
    Record<string, { startTasks?: StartTasks | null; loadedAt?: number | null }>
  >,
): StartTasks | null {
  const main = transcripts[`agent:${botId}:main`]?.startTasks;
  if (main) return main;
  let latest: { at: number; value: StartTasks } | null = null;
  for (const [key, transcript] of Object.entries(transcripts)) {
    if (!key.startsWith(`agent:${botId}:`) || !transcript.startTasks) continue;
    const at = transcript.loadedAt ?? 0;
    if (!latest || at > latest.at) latest = { at, value: transcript.startTasks };
  }
  return latest?.value ?? null;
}
