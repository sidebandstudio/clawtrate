// The words of a new bot's command choice and of what was read back
// (docs/design/bots.md section 3, docs/design/controls.md section 10). The
// saved setting and the gateway's reported default policy are two facts, each
// said only as read; nothing here combines them into what a command will do.

import type { CommandChoice, NewBotPolicy, ReportedLabel, ReportedPolicy } from "@clawtrate/core";

/** The Approvals step's two rows: each title and its line. */
export const CHOICE_ROWS: ReadonlyArray<{
  value: CommandChoice;
  title: string;
  line: (bot: string) => string;
}> = [
  {
    value: "ask",
    title: "Ask before acting",
    line: (bot) =>
      `Sets ${bot}'s command policy to ask for approval when a command misses the machine's allowlist.`,
  },
  {
    value: "full",
    title: "Run without routine approvals",
    line: (bot) =>
      `Sets ${bot}'s command policy to run without routine approval. The machine, the task or a rule can still require approval or block a command.`,
  },
];

export const choiceTitle = (choice: CommandChoice) =>
  CHOICE_ROWS.find((row) => row.value === choice)!.title;

/**
 * Under the group. No promise of a later change in the bot's settings: they
 * have no page that changes the command setting yet.
 */
export const machineLine = (bot: string) =>
  `Commands use the machine and permissions set by the gateway. ${bot}'s command setting replaces the gateway-wide command mode for this bot.`;

/** The line about the gateway's approvals file: general, or that it blocks commands. */
export const fileLine = (blocks: boolean) =>
  blocks
    ? "The gateway's approvals file blocks commands."
    : "The gateway's approvals file can require approval or block commands.";

/** Above Create, once a row is chosen. */
export const inheritsLine = (bot: string) =>
  `Before Clawtrate sets ${bot}'s policy, the new bot inherits the gateway's settings.`;

/** In Create's place while nothing is chosen. */
export const chooseLine = (bot: string) => `Choose how ${bot} runs commands.`;

/** The saved setting, from an exact read of `tools.exec.mode`. */
export function savedSentence(bot: string, mode: string): string {
  if (mode === "ask" || mode === "full")
    return `${bot}'s saved command setting is ${choiceTitle(mode)}.`;
  return `${bot}'s saved command setting is ${modeWord(mode)}.`;
}

/** A mode as read, in words where Clawtrate has them, else as the gateway wrote it. */
export function modeWord(mode: string): string {
  if (mode === "ask" || mode === "full") return choiceTitle(mode);
  if (mode === "deny") return "Never";
  return `"${mode}"`;
}

/**
 * The gateway's reported default command policy for a new bot, as read; null
 * says nothing: no read yet, or a label Clawtrate has no sentence for, which
 * is not the same as no label.
 */
export function reportedSentence(bot: string, reported: ReportedLabel | null): string | null {
  if (reported === null) return null;
  if (reported === "guarded")
    return "The gateway reports that the default command policy asks on an allowlist miss.";
  if (reported === "full")
    return "The gateway reports no routine approval in the default command policy.";
  if (reported === "read-only")
    return "The gateway reports that the default command policy disables commands.";
  if (reported === "none") return `The gateway didn't report a default command policy for ${bot}.`;
  return null;
}

/** What the first-bot prompt says below admin of the gateway's `main`, named Main; null: nothing. */
export function mainPolicySentence(reported: ReportedPolicy | null): string | null {
  if (reported === "guarded")
    return "The gateway reports that Main's default command policy asks on an allowlist miss.";
  if (reported === "full")
    return "The gateway reports no routine approval in Main's default command policy.";
  if (reported === "read-only")
    return "The gateway reports that Main's default command policy disables commands.";
  return null;
}

/** Where the saved command setting is: the bot's entry in the gateway's settings. */
export const whereLine = (bot: string) =>
  `The command setting is tools.exec.mode in ${bot}'s entry of the gateway's settings.`;

/** The tools Clawtrate blocks for a new bot that a read doesn't show blocked. */
export const missingDenyLine = (tools: readonly string[]) =>
  `Its settings don't block ${tools.length === 1 ? "this tool" : "these tools"} Clawtrate blocks for a new bot: ${tools.join(", ")}.`;

/** The note in a new bot's first task: its tone, its sentences, and whether it is settled. */
export function policyNote(policy: NewBotPolicy): {
  tone: "warn" | undefined;
  title: string | null;
  lines: string[];
} {
  const bot = policy.name;
  if (policy.status === "checking")
    return { tone: undefined, title: null, lines: ["Checking what was written…"] };
  if (policy.status === "confirmed" && policy.saved === policy.chosen) {
    const reported = reportedSentence(bot, policy.reported);
    return {
      tone: undefined,
      title: null,
      lines: [savedSentence(bot, policy.chosen), ...(reported ? [reported] : [])],
    };
  }
  // What holds the task back, each fact as read: the saved mode, the tools Clawtrate blocks that
  // aren't blocked, and the gateway's own label beside them.
  const reported = reportedSentence(bot, policy.reported);
  return {
    tone: "warn",
    title: `Clawtrate couldn't confirm ${bot}'s command setting.`,
    lines: [
      "Review the gateway's settings before sending a task.",
      ...(policy.saved ? [`Its saved command setting is ${modeWord(policy.saved)}.`] : []),
      ...(policy.missingDeny.length > 0 ? [missingDenyLine(policy.missingDeny)] : []),
      ...(reported ? [reported] : []),
      whereLine(bot),
    ],
  };
}
