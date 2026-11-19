// A check-ins dialog's draft. What the person changed is tracked apart from
// what the gateway had when the draft began (its base: the bot's own setting,
// its job's choice and the other bots the dialog said it would also write), so
// a save sends only the fields the person touched, against that base. The base
// moves only explicitly, after the gateway was seen to differ (`rebase`): a
// refresh behind the dialog never changes what a save claims or discloses.

import {
  keptByDefault,
  type CheckInDraft,
  type CheckInKept,
  type CheckInsState,
} from "@clawtrate/core";
import { choiceOf, everyFor, type Choice } from "./words.ts";

type Base = {
  choice: Choice;
  every: string;
  was: CheckInDraft["was"];
  /** The bot's prompt was longer than Clawtrate edits: it is shown cut and never written. */
  promptCut: boolean;
  kept: CheckInKept[];
};

export type Draft = {
  gatewayId: string;
  botId: string;
  base: Base;
  choice: Choice;
  every: string;
  prompt: string;
  touched: { every: boolean; prompt: boolean };
  saveId: string | null;
  refused: string | null;
  /** The save whose outcome this draft was last rebased on. */
  rebased: string | null;
  /** The save whose outcome the person asked to check. */
  checked: string | null;
};

function baseOf(checkIns: CheckInsState, botId: string): Base {
  const setting = checkIns.settings?.find((each) => each.botId === botId);
  return {
    ...choiceOf(checkIns.jobs.find((job) => job.botId === botId)),
    was: { every: setting?.every ?? null, prompt: setting?.prompt ?? null },
    promptCut: setting?.promptCut ?? false,
    kept: keptByDefault(botId, checkIns.settings, checkIns.defaults),
  };
}

/** A new draft for the bot, or null while nothing says which gateway the check-ins are from. */
export function openDraft(checkIns: CheckInsState, botId: string): Draft | null {
  if (checkIns.gatewayId === null) return null;
  const base = baseOf(checkIns, botId);
  return {
    gatewayId: checkIns.gatewayId,
    botId,
    base,
    choice: base.choice,
    every: base.every,
    prompt: base.was.prompt ?? "",
    touched: { every: false, prompt: false },
    saveId: null,
    refused: null,
    rebased: null,
    checked: null,
  };
}

/**
 * The draft over what the gateway has now: fields the person left follow it,
 * and the person's edits stay, except a prompt that is now longer than
 * Clawtrate edits, which cannot be saved over.
 */
export function rebase(draft: Draft, checkIns: CheckInsState): Draft {
  const base = baseOf(checkIns, draft.botId);
  const prompt = draft.touched.prompt && !base.promptCut;
  return {
    ...draft,
    base,
    ...(draft.touched.every ? {} : { choice: base.choice, every: base.every }),
    ...(prompt ? {} : { prompt: base.was.prompt ?? "" }),
    touched: { every: draft.touched.every, prompt },
  };
}

/** What a save of this draft asks: the touched fields that differ from the base, and the base. */
export function draftToSave(draft: Draft): CheckInDraft {
  const { base, touched } = draft;
  const every = everyFor(draft.choice, draft.every);
  return {
    gatewayId: draft.gatewayId,
    every: touched.every && every !== everyFor(base.choice, base.every) ? every : null,
    prompt: touched.prompt && draft.prompt !== (base.was.prompt ?? "") ? draft.prompt : null,
    was: base.was,
    kept: base.kept,
  };
}
