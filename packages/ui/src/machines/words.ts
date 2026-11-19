// The words of "Where a bot runs" and Settings, Machines (controls.md sections
// 14 and 15), from the engine's facts. Nothing here decides a verdict: each
// sentence says what the gateway's settings or its last report say.

import {
  choiceOf,
  combinePosture,
  fileLevelsFor,
  type ApprovalLevels,
  type ApprovalsFile,
  type Ask,
  type BotPlacement,
  type DefaultsChoice,
  type ExecPolicy,
  type NodeFacts,
  type Security,
} from "@clawtrate/core";
import { stampTime } from "../format.ts";

/** A list of names in a sentence: "Pip", "Pip and Marlow", "Pip, Marlow and Otto". */
export function names(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** "Last seen 5:12 PM (connect)", with the gateway's reason as given. */
export function lastSeen(node: NodeFacts, now: number): string {
  if (node.lastSeenAt === null) return "Last seen: not reported";
  const reason = node.lastSeenReason ? ` (${node.lastSeenReason})` : "";
  return `Last seen ${stampTime(node.lastSeenAt, now)}${reason}`;
}

/** A machine's state: "Connected" or "Not connected · Last seen …". */
export function nodeState(node: NodeFacts, now: number): string {
  return node.connected ? "Connected" : `Not connected · ${lastSeen(node, now)}`;
}

/** The value of the "Where Otto runs" row: "Commands on media-box · Shared with Pip". */
export function runsOnValue(placement: BotPlacement, nameOf: (id: string) => string): string {
  const { commands } = placement;
  const where =
    commands.host === "node"
      ? `Commands on ${commands.node?.name ?? commands.nodeSelector ?? "a paired machine"}`
      : commands.host === "sandbox" || (commands.host === "auto" && commands.sandbox)
        ? "Commands in a sandbox"
        : "Commands on the gateway's machine";
  const shared = [
    ...new Set([...placement.sharedWith.machine, ...placement.sharedWith.workspace]),
  ].map(nameOf);
  return shared.length > 0 ? `${where} · Shared with ${names(shared)}` : where;
}

export const CHOICE_WORDS: Record<DefaultsChoice, string> = {
  always: "Ask every time",
  miss: "Ask for commands not on the allowlist",
  allow: "Allow every command",
  never: "Never allow",
};

/** A file's levels for a bot in words: "Ask on every command", "the defaults". */
export function levelsWords(levels: ApprovalLevels): string {
  const choice = choiceOf(levels);
  if (choice === "always") return "Ask on every command";
  if (choice) return CHOICE_WORDS[choice];
  const parts = [
    levels.security ? `security ${levels.security}` : null,
    levels.ask ? `ask ${levels.ask}` : null,
  ].filter(Boolean);
  return parts.length > 0
    ? `Its own entry: ${parts.join(", ")}`
    : "Its own entry, with no levels set";
}

/** A bot's command policy, as its Run commands line names it (section 5). */
export function policyWords(policy: ExecPolicy): string {
  if (policy.none) return "No command policy: the gateway runs commands without asking";
  if (policy.legacy) return `Legacy setting: security ${policy.security}, ask ${policy.ask}`;
  switch (policy.mode) {
    case "auto":
      return "Review first";
    case "ask":
      return "Ask";
    case "full":
      return "Allow all";
    case "deny":
      return "Never";
    case "allowlist":
      return "Only listed commands";
    default:
      return `security ${policy.security}, ask ${policy.ask}`;
  }
}

function postureWords(security: Security, ask: Ask, autoReview: boolean): string {
  if (security === "deny") return "Never: every command is refused";
  if (ask === "always") return "Every command asks";
  if (security === "full" && ask === "off") return "Every command runs without asking";
  if (security === "full") return `Runs commands; asks as the gateway's ask "${ask}" says`;
  if (ask === "off") return "Only commands on the allowlist run; the rest are refused";
  return autoReview
    ? "Review first: commands on the allowlist run, and the reviewer decides the rest"
    : "Commands on the allowlist run; the rest ask you";
}

/**
 * The effective result for a bot set to a machine, as the gateway combines
 * them: the bot's policy, the gateway machine's file and, for a node, the
 * node's own file. Null when a file it needs is not read.
 */
export function effectiveWords(
  botName: string,
  botId: string,
  policy: ExecPolicy,
  files: ReadonlyArray<{ name: string; file: ApprovalsFile }>,
): string {
  const levels = files.map(({ file }) => fileLevelsFor(file, botId));
  const result = combinePosture(policy, levels);
  const head = postureWords(result.security, result.ask, result.autoReview);
  const policyName = policyWords(policy);
  if (result.raisedBy !== null) {
    const by = files[result.raisedBy]!;
    const entry = by.file.entries.some((each) => each.botId === botId);
    const reviewer = policy.autoReview ? `, so the gateway skips ${botName}'s reviewer` : "";
    return `${head}: ${entry ? `its entry in ${by.name}'s file` : `${by.name}'s file`} asks more than ${botName}'s policy (${policyName})${reviewer}.`;
  }
  return `${head}, from ${botName}'s policy (${policyName}); ${files.length > 1 ? "these files ask" : "this file asks"} no more.`;
}

/** The line under a machine's effective results (section 15). */
export const COMBINE_LINE =
  "The gateway takes the stricter of a bot's policy and this file, and the more asking of the two; it uses a bot's reviewer only when this file doesn't ask more. “Allow every command” still meets each bot's own policy.";
