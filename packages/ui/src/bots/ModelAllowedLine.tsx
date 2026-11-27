// A bot's model and the model list that limits it (#799), as one quiet line: "Added <model> to
// the models this gateway allows. · Undo" after Clawtrate put it on the list, and, for a bot whose
// own model the list refuses, why its tasks can't start, with "Allow <model>" for a connection
// that can write the setting. The same line in the bot's settings and on a refused start's card.

import {
  providerName,
  type AccountsState,
  type ClawtrateState,
  type RefusedBotModel,
} from "@clawtrate/core";
import { useState } from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { screenStamp, shownStamp } from "../stamp.ts";

/** "OpenAI's gpt-5.5": a model as the app names it with its provider. */
export const modelWords = (ref: { provider: string; model: string }) =>
  `${providerName(ref.provider)}'s ${ref.model}`;

/** What the line says after Clawtrate added a bot's model to its list, or after its Undo. */
export function allowedWords(allowed: NonNullable<AccountsState["allowed"]>, botName: string) {
  const model = modelWords(allowed);
  const list =
    allowed.scope === "bot" ? `the models ${botName} may use` : "the models this gateway allows";
  switch (allowed.status) {
    case "undone":
      return `Took ${model} out of ${list} again.`;
    case "kept":
      return `${model} wasn't taken out: ${list} changed since.`;
    case "failed":
      return `Couldn't take ${model} out of ${list}: ${allowed.error ?? "the gateway refused."}`;
    default:
      return `Added ${model} to ${list}.`;
  }
}

/** Why a bot's tasks can't start on its own model, in one sentence. */
export const refusedWords = (refused: RefusedBotModel, botName: string) =>
  `${botName} can't start tasks on ${modelWords(refused)}: this gateway's model list doesn't include it.`;

/**
 * The line for one bot. `reason: false` leaves out the refused sentence where the place it stands
 * already says it (a refused start's card), and `only` shows it only for that model.
 */
export function ModelAllowedLine({
  botId,
  botName,
  reason = true,
  only,
}: {
  botId: string;
  botName: string;
  reason?: boolean;
  only?: { provider: string; model: string };
}) {
  const bridge = useBridge();
  // A card drawn with no state from the host (the cards' own tests) has no line.
  const state = useClawtrateState() as ClawtrateState | null;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!state) return null;
  const { accounts, connection } = state;
  const admin = connection.canAdmin;
  const same = (ref: { provider: string; model: string }) =>
    !only || (ref.provider === only.provider && ref.model === only.model);
  const allowed =
    accounts.allowed?.botId === botId && same(accounts.allowed) ? accounts.allowed : null;
  const refused = accounts.modelsRefused.find((each) => each.botId === botId && same(each)) ?? null;
  const press = async (command: "allowBotModel" | "undoModelAllowed") => {
    setBusy(true);
    setFailed(null);
    try {
      const stamp = await screenStamp(bridge, shownStamp(connection));
      await bridge.invoke(
        command === "allowBotModel"
          ? { type: "allowBotModel", botId, stamp }
          : { type: "undoModelAllowed", stamp },
      );
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  // After a write: what it did, and Undo while it can be undone.
  if (allowed && allowed.status !== "undone") {
    return (
      <p className="b-hint" role="status" data-testid="model-allowed">
        {allowedWords(allowed, botName)}
        {admin && (allowed.status === "added" || allowed.status === "undoing") && (
          <>
            {" · "}
            <button
              type="button"
              className="link-button"
              aria-label={`Undo: take ${modelWords(allowed)} out of the list again`}
              disabled={busy || allowed.status === "undoing"}
              onClick={() => void press("undoModelAllowed")}
            >
              Undo
            </button>
          </>
        )}
      </p>
    );
  }
  if (!refused) {
    return allowed ? (
      <p className="b-hint" role="status" data-testid="model-allowed">
        {allowedWords(allowed, botName)}
      </p>
    ) : null;
  }
  // A bot whose own model the list refuses: why, and with admin the one press.
  if (!reason && !admin) return null;
  return (
    <p className="b-hint" data-testid="model-refused">
      {reason && refusedWords(refused, botName)}
      {admin && (
        <>
          {reason && " "}
          <button
            type="button"
            className="link-button"
            aria-label={`Allow ${modelWords(refused)} for ${botName}'s tasks`}
            disabled={busy}
            onClick={() => void press("allowBotModel")}
          >
            Allow {refused.model}
          </button>
        </>
      )}
      {failed && <span className="b-error"> Couldn't allow it: {failed}</span>}
    </p>
  );
}
