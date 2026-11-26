// A message the gateway couldn't run (#663, F-480): it failed the message before any run of it
// started, so no reply and no action came. Why, from the gateway's own words only: its `chat`
// error, its lifecycle error, or the "run-failed-before-reply" row it keeps in history. Each kind
// below is a text the gateway writes for it (OpenClaw 2026.10.6 and 2026.11.10 alike); any other
// text is shown as the gateway's words, one plain line, cut to `MAX_NOT_RUN_WORDS`. Nothing is
// read from the gateway's log, and nothing is guessed from silence.

import { cleanLine } from "./gateway-names.ts";
import type { Run } from "./runs.ts";

/** The longest the gateway's own words are shown, in characters. */
export const MAX_NOT_RUN_WORDS = 300;

export type NotRunKind =
  /** The model's API takes an API key, and the bot's account is a sign-in or a token. */
  | "needs-api-key"
  /** The model's API takes a subscription sign-in, and the bot's account is an API key. */
  | "needs-sign-in"
  /** The model can't be used with the kind of account the bot is set to, for another reason. */
  | "account-kind"
  /** The account the bot is set to isn't on the gateway. */
  | "account-missing"
  /** The account the bot is set to is another provider's. */
  | "account-other-provider"
  /** The gateway doesn't know the bot's model. */
  | "model-unknown"
  /** The model's provider has no account on the gateway. */
  | "no-account"
  /** Anything else: the gateway's own words. */
  | "other"
  /** The gateway said the message failed and kept no reason. */
  | "unsaid";

export type NotRunCause = { kind: NotRunKind; words: string | null };

/** What the gateway puts in front of a reason, and its whole text when it kept none. */
const PREFIXES = [
  /^Your request couldn['’]t be completed[.:]?\s*/i,
  /^(?:Failover)?Error:\s*/,
  /^⚠️\s*/u,
];

/** The gateway's words without what it put in front of them; empty when nothing is left. */
function reasonOf(raw: string): string {
  let text = raw.trim();
  for (let again = true; again;) {
    again = false;
    for (const prefix of PREFIXES) {
      const next = text.replace(prefix, "");
      if (next !== text) {
        text = next.trim();
        again = true;
      }
    }
  }
  return text;
}

/** Why the gateway couldn't run a message, from what it said; null when it said nothing. */
export function notRunCause(said: string | null | undefined): NotRunCause | null {
  if (typeof said !== "string" || !said.trim()) return null;
  const text = reasonOf(said);
  if (!text) return { kind: "unsaid", words: null };
  const kind = kindOf(text);
  return { kind, words: kind === "other" ? cleanLine(text, MAX_NOT_RUN_WORDS) || null : null };
}

function kindOf(text: string): NotRunKind {
  // `Auth profile "<id>" uses <mode> auth, but <provider>/<api> <reason>.`
  const mode = /\bAuth profile "[^"]*" uses (\S+) auth, but \S+ (.*)$/is.exec(text);
  if (mode) {
    const signIn = /^(?:oauth|token)$/i.test(mode[1]!);
    const key = /^api[-_]?key$/i.test(mode[1]!);
    if (signIn && /\brequires an? (?:\S+ )*API key profile\b/i.test(mode[2]!))
      return "needs-api-key";
    if (key && /\brequires an? (?:\S+ )*(?:subscription|OAuth)\b/i.test(mode[2]!))
      return "needs-sign-in";
    return "account-kind";
  }
  if (
    /\bSelected auth profile "[^"]*" is unavailable\b/i.test(text) ||
    /\bThis saved login isn['’]t available\b/i.test(text) ||
    /\bNo credentials found for profile "/i.test(text)
  )
    return "account-missing";
  if (/\bAuth profile "[^"]*" is not configured for \S/i.test(text))
    return "account-other-provider";
  if (/^Unknown model: \S/i.test(text) || /\bThis model was not found\b/i.test(text))
    return "model-unknown";
  if (/\bNo API key found for provider "/i.test(text)) return "no-account";
  return "other";
}

/**
 * The gateway failed this run's message before any run of it started: history says so (its
 * "run-failed-before-reply" row), or the run, followed live here, failed with nothing reported
 * started, no action and no reply text. A run history rebuilt has no start of its own to go by,
 * so only the gateway's row counts for it.
 */
export function neverRan(
  run: Pick<Run, "state" | "error" | "origin" | "reportedStartAt" | "steps" | "text">,
): boolean {
  if (run.state !== "failed" || run.error?.quiet === true) return false;
  if (run.error?.beforeReply === true) return true;
  return (
    run.origin !== "history" &&
    run.reportedStartAt === null &&
    run.steps.length === 0 &&
    run.text === ""
  );
}

/**
 * A message this client sent that the gateway accepted, and then ended without a word: no event of
 * a run came, and history, read once the gateway had nothing in flight, holds no row of one. The
 * gateway didn't start a run for it, and said nothing about why.
 */
export function neverStarted(run: Run): boolean {
  return (
    run.state === "completed" &&
    !run.outcomeKnown &&
    run.origin === "local" &&
    run.bound &&
    run.reportedStartAt === null &&
    run.steps.length === 0 &&
    run.text === ""
  );
}
