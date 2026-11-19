// The words of "Where a bot runs" and Settings, Machines (controls.md sections
// 14 and 15), from the engine's facts. Nothing here decides a verdict: each
// sentence says what the gateway's settings store or what the gateway reported.

import {
  choiceOf,
  type ApprovalLevels,
  type BotPlacement,
  type CommandPlace,
  type CredentialField,
  type DefaultsChoice,
} from "@clawtrate/core";
import { stampTime } from "../format.ts";

/** A list of names in a sentence: "Pip", "Pip and Marlow", "Pip, Marlow and Otto". */
export function names(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** "Last seen 5:12 PM (connect)", with the gateway's reason as given. */
export function lastSeen(
  seen: { lastSeenAt: number | null; lastSeenReason: string | null },
  now: number,
): string {
  if (seen.lastSeenAt === null) return "Last seen: not reported";
  const reason = seen.lastSeenReason ? ` (${seen.lastSeenReason})` : "";
  return `Last seen ${stampTime(seen.lastSeenAt, now)}${reason}`;
}

/** A machine's state: "Connected" or "Not connected · Last seen …". */
export function nodeState(
  node: { connected: boolean; lastSeenAt: number | null; lastSeenReason: string | null },
  now: number,
): string {
  return node.connected ? "Connected" : `Not connected · ${lastSeen(node, now)}`;
}

/**
 * The stored command host by itself, mid-sentence: "the gateway's machine",
 * a listed machine's name, the stored node as it is, "auto", "not set", or a
 * value this app doesn't know, quoted and marked.
 */
export function hostWords(commands: CommandPlace): string {
  const { host } = commands;
  if (host === null) return "not set";
  if (commands.hostSupported === false) return `“${host}” (not supported here)`;
  if (host === "gateway") return "the gateway's machine";
  if (host === "node")
    return commands.node?.name ?? commands.nodeSelector ?? "node, with no machine";
  return host;
}

/** The value of the "Where Otto runs" row: "Commands: media-box · Same setting as Pip". */
export function runsOnValue(placement: BotPlacement, nameOf: (id: string) => string): string {
  const where = `Commands: ${hostWords(placement.commands)}`;
  const same = [
    ...new Set([...placement.sameSetting.machine, ...placement.sameSetting.workspace]),
  ].map(nameOf);
  return same.length > 0 ? `${where} · Same setting as ${names(same)}` : where;
}

export const CHOICE_WORDS: Record<DefaultsChoice, string> = {
  always: "Ask every time",
  miss: "Ask for commands not on the allowlist",
  allow: "Allow every command",
  never: "Never allow",
};

/** A file's levels as stored: one of the four choices by name, or the pair as it is. */
export function levelsWords(levels: ApprovalLevels): string {
  const choice = choiceOf(levels);
  if (choice) return CHOICE_WORDS[choice];
  if (levels.security === null && levels.ask === null) return "No levels set";
  return `security ${levels.security ?? "not set"}, ask ${levels.ask ?? "not set"}`;
}

/** A plugin credential's kind as the gateway described it; never its value. */
export function credentialWords(field: CredentialField): string {
  switch (field.kind) {
    case "missing":
      return "not set";
    case "literal":
      return "set in the settings";
    case "environment":
      return "from an environment variable";
    case "reference":
      return field.unresolved ? "a reference the gateway couldn't resolve" : "a reference";
    case "invalid":
      return "invalid";
    default:
      return field.kind;
  }
}

/** A stored tool list: "not set", "empty", or its entries. */
export function listWords(entries: readonly string[] | null): string {
  if (entries === null) return "not set";
  return entries.length === 0 ? "empty" : entries.join(", ");
}
