// A message the gateway couldn't run (#663, F-480): it failed the message before any run of it
// started, so no reply and no action came. Why, from the gateway's own words only: its `chat`
// error, its lifecycle error, or the "run-failed-before-reply" row it keeps in history. Each kind
// below is a text the gateway writes for it (OpenClaw 2026.10.6 and 2026.11.10 alike); any other
// text is kept for Details, one plain line, cut to `MAX_NOT_RUN_WORDS`. Nothing is
// read from the gateway's log, and nothing is guessed from silence.

import { cleanLine } from "./gateway-names.ts";
import { asRecord } from "./mapping.ts";
import type { OutgoingAttachment } from "./client.ts";
import type { OutgoingMessage, Run } from "./runs.ts";
import type { TranscriptItem } from "./types.ts";

/** The longest the gateway's own words are shown, in characters. */
export const MAX_NOT_RUN_WORDS = 300;

export type NotRunKind =
  /** The model's API takes an API key, and the bot's account is a sign-in (OAuth). */
  | "needs-api-key"
  /** The model's API takes a subscription sign-in, and the bot's account is an API key. */
  | "needs-sign-in"
  /** The account the bot is set to isn't available on the gateway. */
  | "account-missing"
  /** The account the bot is set to isn't set up for its model's provider. */
  | "account-other-provider"
  /** The gateway doesn't know the bot's model. */
  | "model-unknown"
  /** The gateway found no account it can use for the model's provider. */
  | "no-account"
  /** The Codex harness timed out listing its Computer Use plugins before the turn. */
  | "computer-use-timeout"
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
  const words = cleanLine(text, MAX_NOT_RUN_WORDS);
  if (!words) return { kind: "unsaid", words: null };
  const kind = kindOf(text);
  // An unknown model keeps the gateway's words too: they name the model, and what it suggests.
  const detail = kind === "other" || kind === "model-unknown" || kind === "computer-use-timeout";
  return { kind, words: detail ? words : null };
}

function kindOf(text: string): NotRunKind {
  // The Codex harness's named preflight and the exact RPC deadline on both versions.
  // The cancellation code alone also covers other methods and deliberate aborts.
  if (
    /^Codex Computer Use readiness failed: plugin\/list timed out(?: \| CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED)?$/.test(
      text,
    )
  )
    return "computer-use-timeout";
  // `Auth profile "<id>" uses <mode> auth, but <provider>/<api> <reason>.` Only the two
  // requirements read whole are ours to say; any other reason (a consent to give, an operation a
  // sign-in can't do) is the gateway's own, with its own remedy, so its words are shown.
  const mode = /\bAuth profile "[^"]*" uses (\S+) auth, but \S+ (.*)$/is.exec(text);
  if (mode) {
    if (/^oauth$/i.test(mode[1]!) && /^requires an? (?:\S+ )*API key profile\.?$/i.test(mode[2]!))
      return "needs-api-key";
    if (
      /^api[-_]?key$/i.test(mode[1]!) &&
      /^requires an? (?:\S+ )*subscription \(OAuth or token\) profile\.?$/i.test(mode[2]!)
    )
      return "needs-sign-in";
    return "other";
  }
  // A provider's own word for a sign-in where the model needs a key (OpenAI's ChatGPT/Codex OAuth).
  if (
    /\bNo API key found for provider "[^"]*"\.\s*You are authenticated with\b[^.]*\bOAuth\b/i.test(
      text,
    )
  )
    return "needs-api-key";
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
 * What this client saw of the run that only a run that started can send: a lifecycle start, an
 * action or a reasoning block (`steps`, from `tool`, `item` tool and `thinking` events), reply
 * text (an `assistant` or `chat` delta, or a `chat` final), text beside a call (an `item`
 * preamble), or an approval or question it waited on. A lifecycle `model` or `fallback_step`, a
 * `run_status` or a `chat` status is not: the gateway sends those for a message it then fails
 * before any run of it starts (an unknown model, OpenClaw 2026.10.6).
 */
export function startSeen(
  run: Pick<
    Run,
    | "startSaid"
    | "reportedStartAt"
    | "steps"
    | "text"
    | "preambles"
    | "pendingCards"
    | "suspendedCards"
    | "closedCards"
    | "omittedSteps"
    | "ending"
  >,
): boolean {
  return (
    // An event said so where nothing else of the run keeps it: one after the run's end, say.
    run.startSaid === true ||
    run.reportedStartAt !== null ||
    run.steps.length > 0 ||
    // Steps it had that were dropped at their bound.
    run.omittedSteps > 0 ||
    // Its terminal lifecycle event says the provider started (both versions set it only once a
    // model request was under way: a provider's assistant message, or a timeout during the prompt).
    run.ending?.providerStarted === true ||
    run.text !== "" ||
    (run.preambles?.length ?? 0) > 0 ||
    run.pendingCards.length > 0 ||
    run.suspendedCards.length > 0 ||
    run.closedCards.length > 0
  );
}

/**
 * The gateway failed this run's message before any run of it started: history says so (its
 * "run-failed-before-reply" row), or the run, followed live here, failed with nothing reported
 * started, no action and no reply text. A run history rebuilt has no start of its own to go by,
 * so only the gateway's row counts for it.
 */
export function neverRan(
  run: Pick<
    Run,
    | "state"
    | "error"
    | "origin"
    | "reportedStartAt"
    | "steps"
    | "text"
    | "ranInHistory"
    | "preambles"
    | "pendingCards"
    | "suspendedCards"
    | "closedCards"
    | "omittedSteps"
    | "ending"
    | "startSaid"
  >,
): boolean {
  if (run.state !== "failed" || run.error?.quiet === true) return false;
  // A reply row of it in history: it ran, whatever an earlier read said. The gateway writes its
  // "failed before reply" row only for a run with no reply row.
  if (run.ranInHistory === true) return false;
  // The gateway writes that row too for a run that started and failed before replying (a provider
  // error after the request went out): any evidence that it started wins over the row (#686).
  if (run.error?.beforeReply === true) return !startSeen(run);
  return run.origin !== "history" && !startSeen(run);
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
    // History holds a row of it (a reply whose events this client missed): it ran.
    run.ranInHistory !== true &&
    !startSeen(run)
  );
}

/** The previous outcome with the same reported reason, in message order. */
export function repeatedNotRun(
  run: Run,
  runs: readonly Run[],
  items: readonly TranscriptItem[] = [],
): boolean {
  if (!neverRan(run)) return false;
  const reason = notRunCause(run.error?.message);
  if (!reason || reason.kind === "unsaid") return false;
  const order = (each: Run, index: number) => {
    const anchor = each.anchorKeyed ? items.findIndex((item) => item.id === each.anchorItemId) : -1;
    const at = items[anchor]?.timestamp ?? each.startedAt ?? each.endedAt;
    return { anchor, at, index };
  };
  type Order = ReturnType<typeof order>;
  const compare = (a: Order, b: Order): number | null => {
    // Use the order of keyed messages even if a failure was written well after its send.
    if (a.anchor >= 0 && b.anchor >= 0 && a.anchor !== b.anchor) return a.anchor - b.anchor;
    if (a.at === null || b.at === null) return null;
    return a.at - b.at || a.index - b.index;
  };
  const current = order(
    run,
    runs.findIndex((each) => each.id === run.id),
  );
  let previous: Run | undefined;
  let previousOrder: Order | undefined;
  for (const [index, each] of runs.entries()) {
    if (each.id === run.id || each.state === "queued") continue;
    const candidate = order(each, index);
    const before = compare(candidate, current);
    if (before === null || before >= 0) continue;
    if (!previousOrder || (compare(candidate, previousOrder) ?? -1) >= 0) {
      previous = each;
      previousOrder = candidate;
    }
  }
  if (!previous || !neverRan(previous)) return false;
  const prior = notRunCause(previous.error?.message);
  if (prior?.kind !== reason.kind) return false;
  // A model or account change can give a different failure of the same kind.
  return (
    reason.kind === "computer-use-timeout" ||
    reasonOf(previous.error!.message) === reasonOf(run.error!.message)
  );
}

export const MAX_NOT_RUN_FILE_MESSAGES = 8;
/** Decoded bytes, across tasks on the same gateway. */
export const MAX_NOT_RUN_FILE_BYTES = 32 * 1024 * 1024;

type RetryFiles = {
  task: string;
  bot: string | null;
  runId: string;
  message: OutgoingMessage;
  files: OutgoingAttachment[];
  bytes: number;
  retriedAs?: string;
};

/** Files and original text for a send preparing to run or known to have failed before running. */
export class NotRunFiles {
  private readonly entries = new Map<string, RetryFiles>();
  private bytes = 0;

  private key(task: string, runId: string): string {
    return JSON.stringify([task, runId]);
  }

  get(task: string, runId: string): RetryFiles | undefined {
    return this.entries.get(this.key(task, runId));
  }

  hold(entry: RetryFiles): RetryFiles[] {
    this.drop(entry.task, entry.runId);
    this.entries.set(this.key(entry.task, entry.runId), entry);
    this.bytes += entry.bytes;
    const evicted: RetryFiles[] = [];
    for (const oldest of this.entries.values()) {
      if (this.entries.size <= MAX_NOT_RUN_FILE_MESSAGES && this.bytes <= MAX_NOT_RUN_FILE_BYTES)
        break;
      this.drop(oldest.task, oldest.runId);
      evicted.push(oldest);
    }
    return evicted;
  }

  drop(task: string, runId: string): void {
    const key = this.key(task, runId);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  dropWhere(matches: (entry: RetryFiles) => boolean): void {
    for (const entry of this.entries.values())
      if (matches(entry)) this.drop(entry.task, entry.runId);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

export type ComputerUseChange =
  "off" | "already-off" | "restored" | "changed" | "refused" | "unconfirmed" | "not-sent";

export type ComputerUseUndo = {
  taskKey: string;
  runId: string;
  previous: true | null;
  expiresAt: number;
};

export const COMPUTER_USE_UNDO_MS = 7 * 24 * 60 * 60 * 1000;

/** Read only the setting this card can write. Null means its config key was absent. */
export function readComputerUse(response: unknown) {
  const answer = asRecord(response);
  const config = asRecord(answer?.config);
  const codex = asRecord(asRecord(asRecord(config?.plugins)?.entries)?.codex);
  const options = asRecord(asRecord(codex?.config)?.computerUse);
  const value = options?.enabled;
  if (
    !answer ||
    !config ||
    answer.valid === false ||
    typeof answer.hash !== "string" ||
    !answer.hash ||
    (value !== undefined && typeof value !== "boolean")
  )
    return null;
  const saved = answer.configRevisionHash;
  return {
    hash: answer.hash,
    value: value ?? null,
    applied: typeof saved === "string" && answer.appliedConfigHash === saved,
  };
}
