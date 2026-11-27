// "Bots know how Clawtrate works" (#532, #544, #628, #795): always on, with no switch. Clawtrate
// keeps its section at the top of each bot's AGENTS.md current by itself (core guides.ts).
// Settings, Conversation says nothing about it while that holds, and one quiet line for the bots
// whose file Clawtrate can't keep, as the gateway's files read now.

import type { Bot, BotGuidesAnswer, GatewayStamp, GuideFolder } from "@clawtrate/core";
import { useEffect, useState } from "react";
import { useBridge, useClawtrateState } from "./bridge.tsx";

const names = (bots: readonly Bot[], ids: string[]) =>
  ids.map((id) => bots.find((bot) => bot.id === id)?.name ?? id);
const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * The lines for the folders whose file Clawtrate can't keep as it writes it, one per reason, in
 * the order a person can act on; none while every file is current, or will be once the gateway
 * makes a missing one. `label` names a folder's bots; `canWrite`, whether this device writes the
 * bots' files at all (admin access, not a read-only viewer).
 */
export function guidesLines(
  folders: readonly GuideFolder[],
  label: (ids: string[]) => string,
  canWrite: boolean,
): string[] {
  const named = (each: readonly GuideFolder[]) => list(each.map((f) => label(f.bots)));
  const lines: string[] = [];
  for (const folder of folders)
    if (folder.state === null)
      lines.push(
        `Couldn't read ${label(folder.bots)}'s instructions. ${folder.error ?? ""}`.trim(),
      );
  const notKept = folders.filter(
    (f) => f.state === "unclear" || (f.state === "behind" && !f.missing),
  );
  if (notKept.length === 0) return lines;
  if (!canWrite) {
    lines.push(
      `Clawtrate can't keep its section in ${named(notKept)}'s instructions current: this device doesn't have admin access to the gateway.`,
    );
    return lines;
  }
  const unclear = notKept.filter((f) => f.state === "unclear");
  const behind = notKept.filter((f) => f.state === "behind");
  const notText = behind.filter((f) => !f.utf8);
  const long = behind.filter((f) => f.utf8 && f.long);
  const later = behind.filter((f) => f.utf8 && !f.long);
  if (unclear.length > 0)
    lines.push(
      `Clawtrate can't tell where its section is in ${named(unclear)}'s instructions, so it leaves them as they are.`,
    );
  if (notText.length > 0)
    lines.push(
      `${named(notText)}'s instructions aren't plain UTF-8 text, so Clawtrate leaves them as they are.`,
    );
  if (long.length > 0)
    lines.push(
      `${named(long)}'s instructions are too long for Clawtrate's section: the gateway would leave part of them out.`,
    );
  if (later.length > 0)
    lines.push(
      `Clawtrate couldn't update ${named(later)}'s instructions yet. It tries again the next time it connects.`,
    );
  return lines;
}

/** Whether an answer is the connected gateway's own (`GatewayStamp`): only that one is shown. */
export const forConnection = (
  stamp: GatewayStamp | undefined,
  connection: { gatewayId: string | null; target: number },
) => stamp?.gatewayId === connection.gatewayId && stamp.target === connection.target;

/** Settings, Conversation: nothing while Clawtrate keeps every bot's section, else its lines. */
export function BotGuidesPane({ canWrite }: { canWrite: boolean }) {
  const bridge = useBridge();
  const { connection, bots } = useClawtrateState();
  const connected = connection.status === "connected";
  const [answer, setAnswer] = useState<BotGuidesAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    bridge.invoke({ type: "readBotGuides" }).then(
      (read) => {
        if (!live) return;
        setAnswer(read);
        setError(null);
      },
      (failure: unknown) =>
        live && setError(failure instanceof Error ? failure.message : String(failure)),
    );
    return () => {
      live = false;
    };
  }, [bridge, connected, connection.connectedAt, connection.gatewayId, connection.target]);
  // Only the connected gateway's own answer is shown (`GatewayStamp`).
  const shown = answer && forConnection(answer.stamp, connection) ? answer : null;
  const lines =
    connected && error !== null
      ? [`Couldn't read the bots' instructions. ${error}`]
      : shown
        ? guidesLines(shown.folders, (ids) => list(names(bots, ids)), canWrite)
        : [];
  if (lines.length === 0) return null;
  return (
    <div className="bot-guides" data-testid="bot-guides">
      {lines.map((line) => (
        <p key={line} className="b-hint" data-testid="bot-guides-line">
          {line}
        </p>
      ))}
    </div>
  );
}
