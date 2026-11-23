// What a row of the Computer tab's Commands list says (work-pane.md, "Recent
// actions and commands"): the outcome the gateway established for the call, as
// its action card reads it, never more. With "Show commands" off it says what
// happened in plain words, with no command line and no exit code
// (conversation.md, 7.11).

import { callFromStep, lineOf, type CommandRow, type Run, type Step } from "@clawtrate/core";
import { clockTime } from "../format.ts";

export type CommandRowWords = {
  /** The command line with commands shown; otherwise the action in plain words. */
  label: string;
  /** How it went: "Running", "Waiting for you", "Denied", "exit 1 · 0.4s", "Done · 0.4s". */
  state: string;
  /** The call is running now: the working mark goes with "Running". */
  running: boolean;
  /** "Show in chat"'s name: the command line, or the row's plain words with when it started. */
  showName: string;
};

const seconds = (ms: number | null) => (ms !== null ? ` · ${(ms / 1000).toFixed(1)}s` : "");

/** A command row's words, from the call's step and run when the transcript holds them. */
export function commandRowWords(
  row: CommandRow,
  found: { step: Step; run: Run } | undefined,
  commandsShown: boolean,
): CommandRowWords {
  // Each row's button is named by what it shows, so no two read alike (work-pane.md).
  const named = (words: Omit<CommandRowWords, "showName">): CommandRowWords => {
    const at = clockTime(found?.step.startedAt ?? null);
    return {
      ...words,
      showName: commandsShown
        ? `Show ${row.command} in the chat`
        : `Show ${words.label}, ${words.state}${at ? `, ${at}` : ""}, in the chat`,
    };
  };
  if (!found) {
    // No step to read: say only that a command was asked for, and nothing of how it went.
    return named({
      label: commandsShown ? row.command : "A command",
      state: row.running ? "Not reported yet" : "Outcome not reported",
      running: false,
    });
  }
  const line = lineOf(callFromStep(found.step, found.run), commandsShown ? {} : { quiet: true });
  const running = line.outcome === "running" || line.outcome === "review";
  const label = commandsShown ? row.command : `${line.verb} ${line.object}`.trim();
  if (running) return named({ label, state: "Running", running: true });
  if (line.state.type === "word") return named({ label, state: line.state.word, running: false });
  if (line.state.type === "elapsed") return named({ label, state: "Running", running: true });
  // Done: with commands shown, the exit code the result carries; otherwise only that it ran.
  const done =
    commandsShown && row.end?.kind === "exit"
      ? `exit ${row.end.code}`
      : commandsShown
        ? "Ended"
        : "Done";
  return named({ label, state: `${done}${seconds(row.durationMs)}`, running: false });
}
