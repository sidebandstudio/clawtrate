// The card a bot's new name brings to its conversation (F-552): the name it
// wrote on its IDENTITY.md, exactly as Rename saves it, and the person's one
// confirmation. The name is text a bot wrote, so it is only ever shown as text.

import type { Bot, ConnectionState } from "@clawtrate/core";
import { useState } from "react";
import { useBridge, useClawtrateState, useCommand } from "../bridge.tsx";

export function NameCard({
  bot,
  connection,
  onAnnounce,
}: {
  bot: Bot;
  connection: ConnectionState;
  onAnnounce: (text: string) => void;
}) {
  const state = useClawtrateState();
  const send = useCommand();
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const proposal = state.botNames?.find((each) => each.botId === bot.id);
  if (!proposal || proposal.name === bot.name) return null;
  const { name } = proposal;
  const renaming = busy || proposal.status === "renaming";
  const canRename = connection.status === "connected" && connection.canAdmin;
  // Announced only once the host says what happened: a Rename that sent nothing, or that the
  // bot list doesn't confirm, is announced as that.
  const act = async (type: "acceptBotName" | "declineBotName") => {
    setBusy(true);
    try {
      // Both carry the stamp of the read the card came from, so neither acts on another gateway's card.
      const stamp = proposal.stamp;
      if (type === "acceptBotName") {
        await send({ type, botId: bot.id, name, stamp });
        onAnnounce(`Renamed to ${name}`);
      } else {
        const { declined } = await bridge.invoke({ type, botId: bot.id, name, stamp });
        // A Not now for a card that's gone, as after a switch of gateway, did nothing to say.
        if (declined) onAnnounce(`${bot.name} keeps its name`);
      }
    } catch (error) {
      onAnnounce(`Not renamed. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="c-composer-notes">
      <section
        className="c-composer-note name-card"
        data-tone="neutral"
        aria-label={`A new name for ${bot.name}`}
        data-testid="name-card"
      >
        <div className="name-card-words">
          <p className="name-card-title">
            <bdi>{bot.name}</bdi> would like to be called “
            <bdi className="name-card-name">{name}</bdi>”
          </p>
          <p className="name-card-line">
            {canRename
              ? "It wrote this name for itself. Rename changes its name everywhere it shows."
              : `Renaming ${bot.name} needs admin access, which this connection doesn't have.`}
          </p>
          {proposal.status === "failed" && proposal.error && (
            <p className="name-card-error" role="alert">
              {proposal.error}
            </p>
          )}
        </div>
        <div className="name-card-actions">
          {canRename && (
            <button
              type="button"
              className="button"
              data-variant="primary"
              data-size="sm"
              disabled={renaming}
              onClick={() => void act("acceptBotName")}
            >
              {renaming ? "Renaming…" : "Rename"}
            </button>
          )}
          <button
            type="button"
            className="button"
            data-variant="quiet"
            data-size="sm"
            disabled={renaming}
            onClick={() => void act("declineBotName")}
          >
            Not now
          </button>
        </div>
      </section>
    </div>
  );
}
