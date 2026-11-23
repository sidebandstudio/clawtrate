// The card a bot's new name brings to its conversation (F-552): the name it
// wrote on its IDENTITY.md, exactly as Rename saves it, and the person's one
// confirmation. The name is text a bot wrote, so it is only ever shown as text.

import type { Bot, ConnectionState } from "@clawtrate/core";
import { useState } from "react";
import { useClawtrateState, useCommand } from "../bridge.tsx";

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
  const [busy, setBusy] = useState(false);
  const proposal = state.botNames?.find((each) => each.botId === bot.id);
  if (!proposal || proposal.name === bot.name) return null;
  const { name } = proposal;
  const renaming = busy || proposal.status === "renaming";
  const canRename = connection.status === "connected" && connection.canAdmin;
  const act = async (type: "acceptBotName" | "declineBotName") => {
    setBusy(true);
    try {
      await send({ type, botId: bot.id, name });
      onAnnounce(type === "acceptBotName" ? `Renamed to ${name}` : `${bot.name} keeps its name`);
    } catch {
      // The card says why, from the state.
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
            {bot.name} would like to be called “<span className="name-card-name">{name}</span>”
          </p>
          <p className="name-card-line">
            {canRename
              ? "It wrote this name for itself. Rename saves it on the gateway, where Clawtrate reads it."
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
