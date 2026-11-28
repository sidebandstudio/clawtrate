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
    case "unconfirmed":
      // The write's answer didn't come: whether it was made is read again, never assumed.
      return `It isn't confirmed yet whether ${model} was added to ${list}.`;
    case "not-added":
      // Its answer didn't come, and a read since shows it isn't there.
      return `${model} wasn't added to ${list}: the gateway didn't answer, and it isn't there.`;
    case "changed":
      // Only that the configuration changed is known, not how: Undo is no longer offered.
      return `Added ${model} to ${list}. The gateway's settings have changed since, so it can't be undone here.`;
    case "failed":
      return `Couldn't take ${model} out of ${list}: ${allowed.error ?? "the gateway refused."}`;
    default:
      return `Added ${model} to ${list}.`;
  }
}

/**
 * The states in which the line offers Undo: not once the gateway has taken the entry out, and only
 * with the revision the addition left, which Undo is held to.
 */
const UNDOABLE = new Set(["added", "undoing", "failed"]);
const undoable = (allowed: NonNullable<AccountsState["allowed"]>) =>
  UNDOABLE.has(allowed.status) && allowed.revision !== null;

/** Why a bot's tasks can't start on its own model, in one sentence. */
export const refusedWords = (refused: RefusedBotModel, botName: string) =>
  `${botName} can't start tasks on ${modelWords(refused)}: this gateway's model list doesn't include it.`;

/** Why Clawtrate offers no Allow for a refusal (`RefusedBotModel.why`), in one plain line. */
export const NO_ALLOW_WORDS = {
  full: "The list is too long for Clawtrate to change.",
  long: "The model's id is longer than Clawtrate carries.",
  layout: "This gateway's model list is set up in a way Clawtrate doesn't change.",
} as const;

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
        {admin && refused.why !== null && (
          <>
            {reason && " "}
            {NO_ALLOW_WORDS[refused.why]}
          </>
        )}
        {admin && refused.why === null && (
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
        {admin && undoable(allowed) && (
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
