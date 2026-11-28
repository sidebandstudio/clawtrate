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
      // Undo wrote nothing, and says exactly why.
      switch (allowed.error) {
        case "last":
          return `Kept ${model} on ${list}: it's the only one left there, and taking it out would allow every model.`;
        case "moved":
          // Whether it is still on that list isn't read: only that the list no longer decides.
          return `The list that received ${model} no longer decides ${botName}'s models, so nothing was changed.`;
        case "changed":
          return `Kept ${model} on ${list}: the list has changed since it was added, so nothing was changed.`;
        default:
          return `${model} is no longer on ${list}, so nothing was changed.`;
      }
    case "failed":
      return `Couldn't take ${model} out of ${list}: ${allowed.error ?? "the gateway refused."}`;
    default:
      return `Added ${model} to ${list}.`;
  }
}

/** The states in which the line offers Undo: not once the gateway has taken the entry out. */
const UNDOABLE = new Set(["added", "undoing", "failed"]);

/** Why a bot's tasks can't start on its own model, in one sentence. */
export const refusedWords = (refused: RefusedBotModel, botName: string) =>
  `${botName} can't start tasks on ${modelWords(refused)}: this gateway's model list doesn't include it.`;

/** Why Clawtrate offers no Allow there: the list is past what it writes back whole. */
export const FULL_LIST_WORDS = "The list is too long for Clawtrate to change.";

/**
 * The line for one bot. `reason: false` leaves out the refused sentence where the place it stands
 * already says it (a refused start's card), and `only` shows it only for that model. A refusal
 * true now always shows, before any line about an earlier addition.
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
  const [failed, setFailed] = useState<{ press: "allow" | "undo"; text: string } | null>(null);
  if (!state) return null;
  const { accounts, connection } = state;
  const admin = connection.canAdmin;
  const same = (ref: { provider: string; model: string }) =>
    !only || (ref.provider === only.provider && ref.model === only.model);
  // An addition is shown only on the gateway it was made on.
  const allowed =
    accounts.allowed?.botId === botId &&
    same(accounts.allowed) &&
    accounts.allowed.gatewayId !== null &&
    accounts.allowed.gatewayId === connection.gatewayId
      ? accounts.allowed
      : null;
  const refused = accounts.modelsRefused.find((each) => each.botId === botId && same(each)) ?? null;
  const press = async (which: "allow" | "undo") => {
    setBusy(true);
    setFailed(null);
    try {
      const stamp = await screenStamp(bridge, shownStamp(connection));
      // Allow names the model it shows; Undo, the addition it shows. The engine checks each.
      await bridge.invoke(
        which === "allow"
          ? {
              type: "allowBotModel",
              botId,
              provider: refused!.provider,
              model: refused!.model,
              stamp,
            }
          : { type: "undoModelAllowed", botId, id: allowed!.id, stamp },
      );
    } catch (error) {
      setFailed({ press: which, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  // A bot whose own model its list refuses now: why, and with admin the one press.
  const refusedLine =
    refused && (reason || admin) ? (
      <p className="b-hint" data-testid="model-refused">
        {reason && refusedWords(refused, botName)}
        {admin && refused.full && (
          <>
            {reason && " "}
            {FULL_LIST_WORDS}
          </>
        )}
        {admin && !refused.full && (
          <>
            {reason && " "}
            <button
              type="button"
              className="link-button"
              aria-label={`Allow ${modelWords(refused)} for ${botName}'s tasks`}
              disabled={busy}
              onClick={() => void press("allow")}
            >
              Allow {refused.model}
            </button>
          </>
        )}
        {failed?.press === "allow" && (
          <span className="b-error"> Couldn't allow it: {failed.text}</span>
        )}
      </p>
    ) : null;
  // What an addition did, and Undo while it can be undone; once undone, only while nothing is refused.
  const allowedLine =
    allowed && (allowed.status !== "undone" || !refused) ? (
      <p className="b-hint" role="status" data-testid="model-allowed">
        {allowedWords(allowed, botName)}
        {/* Offered until the gateway shows the entry gone: after a failed Undo too. */}
        {admin && UNDOABLE.has(allowed.status) && (
          <>
            {" · "}
            <button
              type="button"
              className="link-button"
              aria-label={`Undo: take ${modelWords(allowed)} out of the list again`}
              disabled={busy || allowed.status === "undoing"}
              onClick={() => void press("undo")}
            >
              Undo
            </button>
          </>
        )}
        {/* A press the host refused before any write; a failed write says so in the line itself. */}
        {failed?.press === "undo" && allowed.status !== "failed" && (
          <span className="b-error"> Couldn't undo it: {failed.text}</span>
        )}
      </p>
    ) : null;
  if (!refusedLine && !allowedLine) return null;
  return (
    <>
      {refusedLine}
      {allowedLine}
    </>
  );
}
