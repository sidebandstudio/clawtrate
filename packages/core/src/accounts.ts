// Provider accounts per bot (docs/design/bots.md, sections 4 to 11 and 20):
// the gateway's accounts as each bot sees them, the sign-ins the gateway can
// start, each bot's binding and the evidence for a lock, and the writes that
// create a bot on an account or change it.
//
// Nothing here receives, keeps or logs a provider's credential. Two things the
// person types pass through on their way to the gateway and are kept nowhere:
// a one-time code pasted into a sign-in, and an API key. They are arguments of
// one request each; no field of the state, no collection and no error message
// holds them (`withoutSecret`).

import { cleanLine } from "./gateway-names.ts";
import { openClawAtLeast } from "./gateway-version.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import type { ReadStamp } from "./types.ts";

// Bounds --------------------------------------------------------------------------

/** Accounts listed across every bot's view. */
export const MAX_ACCOUNTS = 64;
/** Sign-in methods the gateway can start. */
export const MAX_SIGNIN_METHODS = 32;
/** Providers that take an API key. */
export const MAX_KEY_PROVIDERS = 64;
/** Models in the gateway's catalogue. */
export const MAX_CATALOG_MODELS = 128;
/**
 * Models of one provider in its full list (`view: "all"`), as kept. The gateway
 * sends the whole list in one answer, with no pages; a longer list is kept to
 * this many and says how many it had (`ModelList.total`).
 */
export const MAX_PROVIDER_MODELS = 1024;
/** Effort levels per model. */
export const MAX_EFFORT_LEVELS = 12;
/** Accounts a stored order lists, as kept. */
export const MAX_ORDER_IDS = 16;
/** Fallback models a bot's model lists, as kept. */
export const MAX_FALLBACKS = 16;
/** Bots whose lock a sign-in re-checks. */
export const MAX_LOCK_CHECKS = 32;
/** Bots whose `models.authStatus` is read at once. */
export const ACCOUNT_READ_CONCURRENCY = 4;
/** A label: trimmed, 1 to 32 characters (bots.md section 22). */
export const MAX_LABEL_CHARS = 32;
/**
 * The longest account id or bot id read back from the person's preferences,
 * measured as JSON, the way it is kept and counted. Longer ones are not
 * Clawtrate's and are not kept, so each record stays within what `owners.ts`
 * registers for it.
 */
export const MAX_PREF_ID_CHARS = 256;

/** How long a string is once serialized: what a bound on a kept entry counts. */
export function serializedLength(value: string): number {
  return JSON.stringify(value).length;
}
const PREF_PROFILE_ID = /^[\w.-]{1,128}:[^\s]{1,127}$/;
const PREF_BOT_ID = /^[\w.-]{1,128}$/;

/** An account id as a preference may name it, or null when it is not one Clawtrate wrote. */
export function prefProfileId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= MAX_PREF_ID_CHARS &&
    serializedLength(value) <= MAX_PREF_ID_CHARS &&
    PREF_PROFILE_ID.test(value)
    ? value
    : null;
}

/** A bot id as a preference key may name it. */
export function prefBotId(value: unknown): string | null {
  return typeof value === "string" &&
    PREF_BOT_ID.test(value) &&
    serializedLength(value) <= MAX_PREF_ID_CHARS
    ? value
    : null;
}
/** The longest a sign-in may wait on the gateway, a little over its own 25 minutes. */
export const SIGNIN_WAIT_MS = 26 * 60_000;
/** The longest typed code, address or key passed to the gateway. */
export const MAX_SECRET_CHARS = 8_192;
/**
 * The longest a held typed value can be once serialized: each UTF-16 unit of
 * one at most `MAX_SECRET_CHARS` long becomes at most six characters
 * (`\u0001`), and the quotes.
 */
export const MAX_SECRET_JSON_CHARS = 6 * MAX_SECRET_CHARS + 2;
/** How long "Still creating" waits before it shows (bots.md section 3). */
export const SLOW_CREATE_MS = 4_000;
/** Preference keys Clawtrate keeps on the gateway, per person. */
export const KIND_PREF_PREFIX = "clawtrate.account-kind.";
export const INTENT_PREF_PREFIX = "clawtrate.bot-account.";

// Types ---------------------------------------------------------------------------

/** How an account was made, as far as Clawtrate knows: only from a sign-in it started. */
export type AccountKind = "subscription" | "key" | "gateway";

/**
 * What Clawtrate records on the gateway for an account it made: a
 * subscription's sign-in, a key typed into Clawtrate (`typed-key`), or a
 * sign-in in a browser that saves a key (`sign-in-key`, OpenRouter's). A
 * record that says only `key` says nothing of where the key was entered: it
 * is read as a key made somewhere unknown, and nothing is claimed of it.
 */
export type KindRecord = "subscription" | "key" | "typed-key" | "sign-in-key";
export const KIND_RECORDS: readonly KindRecord[] = [
  "subscription",
  "key",
  "typed-key",
  "sign-in-key",
];

export type GatewayAccount = {
  /** The profile id on the gateway, `<provider>:<name>`. */
  id: string;
  provider: string;
  /** The gateway's display name for it; sent to admin connections only. */
  label: string | null;
  /** The storage type: `oauth`, `token` or `api_key`. Not how it is billed. */
  type: string | null;
  /** `ok`, `expiring`, `expired`, `missing` or `static`. */
  status: string | null;
  expiresAt: number | null;
  kind: AccountKind;
  /**
   * How Clawtrate made it: a key typed into Clawtrate ("typed"), a sign-in it
   * started ("sign-in"), or not known (null: an account added on the
   * gateway, or a key whose record doesn't say where it was entered).
   */
  made: "typed" | "sign-in" | null;
  /**
   * The bot whose own store keeps it, when no bot's refreshed view lists it
   * as inherited; null when it is in the shared store, which every bot sees.
   */
  keptBy: string | null;
  logoutSupported: boolean;
};

/** What the person does in a sign-in, predicted from the method; the steps decide. */
export type SignInFlow = "code" | "paste" | "host" | "domain" | "key";

export type SignInMethod = {
  /** The `authChoice` to pass: `<pluginId>/<choiceId>`. */
  id: string;
  provider: string;
  label: string;
  hint: string | null;
  /** The gateway's kind: `device-code`, `oauth` or `secret`. */
  kind: string;
  flow: SignInFlow;
  /** Subscriptions first; a sign-in that saves a key billed per token second. */
  group: "subscription" | "token";
};

export type KeyProvider = {
  provider: string;
  /** The gateway already has a key for it: a new one replaces it. */
  hasKey: boolean;
  /** A sign-in method of kind `secret` that takes the key, when the gateway offers one. */
  method: string | null;
};

export type CatalogModel = {
  provider: string;
  id: string;
  name: string | null;
  available: boolean;
  levels: string[];
  defaultLevel: string | null;
};

/**
 * One provider's full list (`models.list {view: "all", provider}`), the answer to one
 * "View more" (bots.md section 9). It is given to the screen that asked and kept nowhere.
 */
export type ModelList =
  | {
      status: "ready";
      /**
       * Up to `MAX_PROVIDER_MODELS`, in the gateway's order but with the ones the picker
       * doesn't have first, so a list cut short keeps the rows the menu adds; only what the
       * menu uses of each.
       */
      models: ListedModel[];
      /** How many the gateway listed, which can be more than are given. */
      total: number;
      /**
       * The gateway answered while still finding this provider's models
       * (`pendingProviders`) or after a refresh that failed (`refreshFailed`).
       */
      partial: boolean;
    }
  /** `unsupported`: the gateway refused `view: "all"`. */
  | { status: "unsupported" | "error"; error: string };

/** The most new, or gone, models a refresh names; the rest are counted. */
export const MAX_REFRESH_NAMES = 5;
/** The longest model id a refresh names, cleaned to one line. */
export const MAX_REFRESH_NAME_CHARS = 64;
/** The longest reason a refresh gives when the gateway refused it or failed. */
export const MAX_REFRESH_ERROR_CHARS = 200;
/** How long Clawtrate waits for the gateway to look again before it says it didn't answer. */
export const REFRESH_MODELS_MS = 45_000;
/** The most entries of the config's model list for bots read for `modelAllowlist`. */
export const MAX_ALLOWLIST_ENTRIES = 1024;

export type RefreshOutcome = "ready" | "auth-rejected" | "unavailable" | null;

/**
 * What one Refresh of a provider's models found (`models.list {agentId, provider, refresh:
 * true}`): the picker's rows for the provider before and after, compared, and what the gateway
 * said of the provider. Given to the screen that asked and kept nowhere; the rows themselves go
 * into the state's `models`.
 */
export type ModelRefresh =
  | {
      status: "done";
      provider: string;
      /** The first `MAX_REFRESH_NAMES` models the menu lists now and didn't before, cleaned. */
      added: string[];
      addedCount: number;
      /** The first `MAX_REFRESH_NAMES` it listed before and doesn't now, cleaned. */
      removed: string[];
      removedCount: number;
      /**
       * Every model the menu showed at the press that the gateway no longer lists, as its ids: at
       * most the menu's bound. Not a model a cut pushed out of the menu while the gateway still
       * lists it.
       */
      removedIds: string[];
      /**
       * What the gateway reported for the provider (`providerOutcomes`): asked again and answered
       * (`ready`), asked and refused the account (`auth-rejected`), asked and failed or timed out
       * (`unavailable`), or not asked again (null): its list is the one the gateway already had.
       */
      outcome: RefreshOutcome;
      /**
       * Every model the gateway lists for the provider is one its config declares
       * (`models.providers`): the config's list is the whole list.
       */
      configured: boolean;
      /**
       * The gateway checks OpenClaw's model list online every 6 hours (`models.catalogRefresh`);
       * null when its config couldn't be read.
       */
      hostedList: boolean | null;
      /**
       * The menu showed the provider cut at its bound before: how many models the gateway listed
       * then and lists now. Nothing is named new then, since the cut hid some.
       */
      counts: { before: number; now: number } | null;
      /**
       * The menu showed the provider whole before, and this refresh left some of its models out at
       * the bound: how many the menu shows of the ones the gateway lists now.
       */
      cut: { shown: number; now: number } | null;
      /** The gateway answered while still finding the provider's models (`pendingProviders`). */
      partial: boolean;
      /** The gateway's refresh of its catalogue failed (`refreshFailed`): try again. */
      failed: boolean;
    }
  | { status: "error"; error: string };

/**
 * The models the gateway's config lets a bot use, as the Model menu needs it: null when nothing
 * limits them. The bot's own `modelPolicy.allow`, else `agents.defaults.modelPolicy.allow`, else
 * the old `agents.defaults.models` while the config is unmigrated. The gateway lists, and lets a
 * task switch to, only what it names; with no wildcard in it, a bot's own model and the default
 * can still be others, and with one they run on the first model it allows
 * (docs/research/model-catalog.md, section 8). `whole` is the providers a `<provider>/*` entry
 * leaves whole, which both versions read alike. Whether any entry is a wildcard depends on the
 * version: `wildcards` as 2026.10.6 reads them (`<provider>/…/*`), `prefixWildcards` as
 * 2026.11.10 does, which also reads a prefix (`openai/gpt-*`) and so finds every one 2026.10.6
 * finds.
 */
export type ModelAllowlist = { whole: string[]; wildcards: boolean; prefixWildcards: boolean };

/** The longest model id Clawtrate sends. */
export const MAX_MODEL_ID_CHARS = 512;

/**
 * Why a model id can't be sent, or null when it can: one rule for the field that takes a typed
 * id and for the bridge that carries every model id to the gateway.
 */
export function modelIdProblem(id: string): "empty" | "long" | "space" | "control" | null {
  if (id.length === 0) return "empty";
  if (id.length > MAX_MODEL_ID_CHARS) return "long";
  if ([...id].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f))
    return "control";
  // A space would split it, and an `@` would name an account.
  if (/[\s@]/.test(id)) return "space";
  return null;
}

/** A row of a full list: only what the Model menu uses of it. */
export type ListedModel = Pick<CatalogModel, "id" | "levels" | "defaultLevel">;

/** A provider whose rows the picker kept fewer of than the gateway listed. */
export type PickerCut = { provider: string; total: number };

/** The order the gateway keeps for a bot and the provider of its model. */
export type StoredOrder = {
  ids: string[];
  /** The bot's own store holds it. */
  stored: boolean;
  /** The gateway's configuration controls the provider's order (`profileOrderLocked`). */
  configured: string | null;
};

export type LockEvidence = {
  /**
   * The last read: `matched` (a one-account order naming the bound account),
   * `multi` (it lists the bound account and others), `other` (it names only
   * another account of the provider), `configured` (an order the gateway's
   * settings give, not one the bot's own store holds: never a lock), `none`
   * (no order), `failed` (the read failed), `unavailable` (the gateway answered
   * that its account status is unavailable), `unread`. Only a stored order
   * counts as the bot's own (`profileOrderStored`).
   */
  status:
    | "unread"
    | "reading"
    | "matched"
    | "multi"
    | "other"
    | "configured"
    | "none"
    | "failed"
    | "unavailable";
  /** The last read that answered. */
  checkedAt: number | null;
  /** The last read that matched. */
  lastMatchAt: number | null;
  /** A read found the order no longer matching after one that did. */
  lostAt: number | null;
  /**
   * Where the read that gave this evidence stands among the engine's reads and sends, in the order
   * they began (`AccountsEngine.nextSeq`); null until a read. Reads are ordered by it, never by the
   * clock, which can give two of them the same millisecond.
   */
  readSeq: number | null;
  /**
   * The newest read begun that has been applied here, one that failed included (`readSeq` of a
   * read shown, or of a failure said): a read begun before it publishes nothing.
   */
  attemptSeq: number | null;
  /**
   * The newest read of the bot sent, stamped as it is sent, whatever becomes of it (still out,
   * failed, discarded, or applied): a press sends only when no read began after its own, or the
   * newest one began is the one applied here as a reading (`readSeq`).
   */
  startedSeq: number | null;
  /**
   * The gateway the read that gave this evidence was answered by, as its connection named it;
   * null when that wasn't known. Only a read of the gateway a press was sent to settles it.
   */
  readGateway: string | null;
  /**
   * The read that gave this evidence listed the binding's provider: only then does its missing
   * order mean there is none. False until a read, and for a read that didn't list it.
   */
  providerRead: boolean;
  error: string | null;
};

export type BotBinding = {
  botId: string;
  /** The bot's own model as configured, with its account suffix; null when it has none. */
  primary: string | null;
  provider: string | null;
  model: string | null;
  account: string | null;
  /**
   * `account`: its model names an account; `gateway`: its own model with no
   * account ("Gateway chooses"); `default-model`: no model of its own.
   */
  mode: "account" | "gateway" | "default-model";
  /** The fallback list on the gateway; null when the bot's model sets none. */
  fallbacks: string[] | null;
  /** Clawtrate set an account and the gateway's model no longer names it. */
  suffixLost: boolean;
  /** The account the model names is not among the gateway's accounts. */
  accountMissing: boolean;
  /** Its effort, `thinkingDefault`, when the bot sets one. */
  effort: string | null;
  order: StoredOrder | null;
  evidence: LockEvidence;
  /** Clawtrate created the bot and the empty fallback list did not land. */
  fallbacksUnwritten: boolean;
};

export type SignInStage =
  | "starting"
  | "waiting"
  | "entering"
  | "checking"
  | "connected"
  | "failed"
  | "expired"
  | "cancelled"
  | "ended"
  | "unconfirmed"
  /** It finished, and the read after it failed: where the account landed is not known. */
  | "unverified"
  /** It finished, and no new account appeared: the gateway may have refreshed one it has. */
  | "refreshed"
  /**
   * It finished, and more than one new account of the provider appeared while
   * it ran, without the gateway saying which is its: the person chooses.
   */
  | "several"
  | "busy";

/** What a step of the gateway's sign-in shows. Never the person's answer. */
export type SignInStep = {
  id: string;
  type: string;
  title: string | null;
  message: string | null;
  url: string | null;
  code: string | null;
  expiresInMinutes: number | null;
  placeholder: string | null;
  sensitive: boolean;
};

export type LockCheck = {
  botId: string;
  account: string;
  /**
   * What the read after the sign-in showed of a bot that was locked: `kept`,
   * still exactly the bound account; `widened`, an order that names it and
   * more; `changed`, an order that no longer names it alone; `unchecked`, the
   * read failed or the gateway said its status is unavailable, so nothing is
   * known of the order now.
   */
  outcome: "kept" | "widened" | "changed" | "unchecked";
};

export type SignInResult = {
  /** Accounts of the provider that were not there before the sign-in. */
  added: string[];
  /** Where the first of them is visible: to every bot, or to one. */
  landed: "shared" | "kept" | null;
  keptBy: string | null;
  /** The read after the sign-in failed. */
  readFailed: boolean;
  locks: LockCheck[];
};

export type SignInState = {
  /** The gateway's session id, chosen here; not a secret. */
  id: string;
  method: string;
  provider: string;
  label: string;
  flow: SignInFlow;
  /** The bot the sign-in was started for. */
  forBot: string;
  /** Known before it starts: the account will be kept by `forBot` only. */
  keptOnly: boolean;
  stage: SignInStage;
  step: SignInStep | null;
  /** The gateway's words when it ended without saving, or saved without confirming. */
  error: string | null;
  cancelling: boolean;
  /** The gateway refused to cancel: it is saving. */
  saving: boolean;
  startedAt: number;
  /** The read after it ended; null until it is done. */
  result: SignInResult | null;
  /** The person's own key went in through this sign-in: it is named "Key saved". */
  byKey: boolean;
  /** The provider's accounts before it started: what the read after it compares against. */
  known: string[];
  /** A cancel was asked for and the gateway's answer did not say whether it took. */
  cancelUnknown: boolean;
};

/**
 * A step of creating a bot that did not land: its name written into its
 * `IDENTITY.md`, which ends OpenClaw's first-run questions (`identity`),
 * Clawtrate's record of its account (`preference`), its model with the empty
 * fallback list and effort (`fallbacks`), the gateway's bot list showing it
 * (`listed`), its first task.
 */
export type MissingStep = "identity" | "preference" | "fallbacks" | "listed" | "task";

export type BotCreationState = {
  name: string;
  /**
   * `partial`: the bot exists, and a later step did not land (`missing`); it is
   * finished by its id (`finishBot`), never by creating again.
   */
  status: "creating" | "checking" | "failed" | "created" | "partial";
  slow: boolean;
  botId: string | null;
  error: string | null;
  /** What a partial creation lacks, each finished by the bot's id. */
  missing: MissingStep[];
  /**
   * The gateway's answer did not settle whether the bot was made, and no new
   * bot of that name was found: the next Create looks for it again first.
   */
  uncertain: boolean;
};

/** The last write to a bot's settings or an account, for the line that says how it went. */
export type AccountWrite = {
  what: "account" | "model" | "fallbacks" | "label" | "disconnect" | "key";
  target: string;
  /** `unverified`: the gateway took it, and the read after it did not show it. */
  status: "saving" | "saved" | "failed" | "unverified";
  error: string | null;
  at: number;
};

/**
 * A press of Unlock or Clear on a bot's Account page (#660): `models.authOrderSet {provider,
 * agentId}` with no account ids, which clears the bot's stored order for the provider over the
 * connection. What it ended as is said only from the gateway's own read after it.
 */
export type OrderClear = {
  /** The press's own id, chosen by the screen that pressed it: what that screen shows as its own. */
  id: string;
  /** The gateway the press was confirmed for, by its identity: another gateway shows nothing of it. */
  gatewayId: string | null;
  botId: string;
  provider: string;
  /** `unlock`: the order of a bot bound to an account; `clear`: one kept for a bot the gateway chooses for. */
  kind: "unlock" | "clear";
  /** The one account the order named when the confirmation opened: the order the press acts on. */
  account: string;
  /**
   * `sending`: under way. `cleared`: the read after it finds no stored order. `refused`: the
   * gateway answered no. `unanswered`: no answer came, and the read after it doesn't show the
   * order cleared. `kept`: the gateway answered yes, and its read still shows the order. `unread`:
   * the gateway answered yes, and the read after it failed. `moved`: the order read before
   * sending wasn't the one the confirmation showed, so nothing was sent. `unsent`: that read
   * failed, or the connection changed first, so nothing was sent.
   */
  status: "sending" | "cleared" | "refused" | "unanswered" | "kept" | "unread" | "moved" | "unsent";
  /** The gateway's words for a refusal, or why an answer or a read didn't come. */
  error: string | null;
  at: number;
  /** Where the send stands among the engine's reads and sends: a read begun after it can settle an unsure ending. */
  sentSeq: number | null;
  /** The read that found no stored order: where it stands, and when it began (the time the line names). */
  checkedSeq: number | null;
  checkedAt: number | null;
};

/** How long a press waits for the gateway's answer before it reads the order to find out. */
export const ORDER_CLEAR_WAIT_MS = 20_000;

export type AccountsState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  readAt: number | null;
  /** Where the accounts shown were read (`ReadStamp`): a change made from them carries it. */
  readOn: ReadStamp | null;
  /** The read was made with admin access, so labels were sent. */
  labels: boolean;
  /** `agents.defaults.model.primary`. */
  defaultModel: string | null;
  /** A sign-in for `main` lands in the shared store: there is a `main` with no folder of its own. */
  mainShared: boolean;
  accounts: GatewayAccount[];
  methods: SignInMethod[];
  keyProviders: KeyProvider[];
  models: CatalogModel[];
  /** Providers whose picker rows were cut at `MAX_CATALOG_MODELS`, with how many it listed. */
  modelsCut: PickerCut[];
  /** The config's model list as every bot's menu can say it (`readModelAllowlist`), or null. */
  modelAllowlist: ModelAllowlist | null;
  bindings: BotBinding[];
  signIn: SignInState | null;
  creation: BotCreationState | null;
  write: AccountWrite | null;
  /** The last Unlock or Clear, for the line that says how it went. */
  clear: OrderClear | null;
};

export const initialAccountsState: AccountsState = {
  status: "idle",
  error: null,
  readAt: null,
  readOn: null,
  labels: false,
  defaultModel: null,
  mainShared: false,
  accounts: [],
  methods: [],
  keyProviders: [],
  models: [],
  modelsCut: [],
  modelAllowlist: null,
  bindings: [],
  signIn: null,
  creation: null,
  write: null,
  clear: null,
};

export const unreadEvidence: LockEvidence = {
  status: "unread",
  checkedAt: null,
  lastMatchAt: null,
  lostAt: null,
  readSeq: null,
  attemptSeq: null,
  startedSeq: null,
  readGateway: null,
  providerRead: false,
  error: null,
};

// Model references -----------------------------------------------------------------

export type ModelRef = { provider: string; model: string; account: string | null };

/** `<provider>/<model>@<account>` or `<provider>/<model>`. */
export function parseModelRef(value: string | null | undefined): ModelRef | null {
  if (!value) return null;
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const provider = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  const at = rest.lastIndexOf("@");
  // An account id always names its provider: `<provider>:<name>`.
  if (at > 0 && rest.slice(at + 1).startsWith(`${provider}:`)) {
    return { provider, model: rest.slice(0, at), account: rest.slice(at + 1) };
  }
  return rest ? { provider, model: rest, account: null } : null;
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}${ref.account ? `@${ref.account}` : ""}`;
}

/** The provider an account id names. */
export function accountProvider(id: string): string {
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(0, colon) : id;
}

// Words for providers ----------------------------------------------------------------

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  xai: "xAI",
  anthropic: "Anthropic",
  "github-copilot": "GitHub Copilot",
  minimax: "MiniMax",
  "minimax-portal": "MiniMax",
  openrouter: "OpenRouter",
  google: "Google",
  mistral: "Mistral",
};

/** A provider's name in text. No provider is ever drawn with a logo. */
export function providerName(provider: string): string {
  return (
    PROVIDER_NAMES[provider] ??
    (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider)
  );
}

// Reading the gateway's answers --------------------------------------------------------

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value.filter((each): each is string => typeof each === "string").slice(0, max)
    : [];

/** One account as one bot's view lists it. */
export type ViewProfile = {
  id: string;
  provider: string;
  type: string | null;
  status: string | null;
  source: string | null;
  label: string | null;
  expiresAt: number | null;
  logoutSupported: boolean;
};

/** One bot's `models.authStatus` answer, as read. */
export type BotView = {
  profiles: ViewProfile[];
  /**
   * The providers the answer lists, within `MAX_ACCOUNTS`, the bot's own provider always among
   * them. A provider not here was not read: its missing order says nothing, so it is never taken
   * as "no order".
   */
  providers: string[];
  orders: Record<string, StoredOrder>;
  /** Providers with a key configured or saved: `apiKey` set, or an `api_key` profile. */
  keyed: string[];
  capabilities: RawRecord[];
  /** The gateway answered that its account status is unavailable: nothing here is a reading. */
  unavailable: string | null;
};

/** The gateway's reason when it says account status is unavailable, or null. */
export function unavailableReason(answer: unknown): string | null {
  const value = asRecord(answer)?.unavailable;
  if (value === undefined || value === null || value === false) return null;
  const record = asRecord(value);
  const code = str(record?.code) ?? str(record?.message) ?? str(value);
  return (code ?? "unavailable").slice(0, 128);
}

/**
 * Said when a `models.authStatus` answer is no record, or a record without its `providers` list:
 * the gateway always sends that list, an empty one included, so such an answer is no reading.
 */
export const NO_ACCOUNT_STATUS = "The gateway's answer carried no account status for the bot.";

/**
 * One bot's `models.authStatus` answer. An answer that says it is unavailable is read as such;
 * one with no record or no `providers` list throws `NO_ACCOUNT_STATUS`, so it is never read as a
 * bot with no accounts and no order. `current` is the provider the read is for, always kept: the
 * bot's own model's, or the one a sign-in just added to.
 */
export function readBotView(answer: unknown, current: string | null = null): BotView {
  const unavailable = unavailableReason(answer);
  const record = asRecord(answer) ?? {};
  if (unavailable === null && !Array.isArray(record.providers)) throw new Error(NO_ACCOUNT_STATUS);
  const profiles: ViewProfile[] = [];
  const orders: Record<string, StoredOrder> = {};
  const keyed = new Set<string>();
  const listed = new Set<string>();
  const all = Array.isArray(record.providers) ? record.providers : [];
  // Read first, so the caps never cut it off and its account never reads as missing (#716).
  const mine = (raw: unknown) => current !== null && str(asRecord(raw)?.provider) === current;
  const providers = [...all.filter(mine), ...all.filter((raw) => !mine(raw))];
  for (const raw of providers.slice(0, MAX_ACCOUNTS)) {
    const provider = asRecord(raw);
    const id = str(provider?.provider);
    if (!provider || !id) continue;
    listed.add(id);
    if (asRecord(provider.apiKey)) keyed.add(id);
    const order = strings(provider.profileOrder, MAX_ORDER_IDS);
    if (Array.isArray(provider.profileOrder)) {
      orders[id] = {
        ids: order,
        stored: provider.profileOrderStored === true,
        configured: str(provider.profileOrderLocked),
      };
    }
    for (const each of Array.isArray(provider.profiles) ? provider.profiles : []) {
      const profile = asRecord(each);
      const profileId = str(profile?.profileId);
      if (!profile || !profileId || profiles.length >= MAX_ACCOUNTS) continue;
      const type = str(profile.type);
      if (type === "api_key") keyed.add(id);
      const expiry = asRecord(profile.expiry);
      profiles.push({
        id: profileId,
        provider: id,
        type,
        status: str(profile.status),
        source: str(profile.source),
        label: str(profile.displayName),
        expiresAt: num(expiry?.at) ?? num(profile.expiry),
        logoutSupported: profile.logoutSupported === true,
      });
    }
  }
  const capabilities = (
    Array.isArray(record.providerCapabilities) ? record.providerCapabilities : []
  )
    .map(asRecord)
    .filter((each): each is RawRecord => each !== null)
    .slice(0, MAX_KEY_PROVIDERS);
  return {
    profiles,
    providers: [...listed],
    orders,
    keyed: [...keyed],
    capabilities,
    unavailable,
  };
}

/**
 * Every account across the bots' refreshed views. An account is shared when
 * any bot's view lists it as inherited (or from configuration); otherwise it
 * is kept by the one bot whose view lists it as its own. With a single bot
 * there is no second view, so its own accounts are kept by it until a read
 * with another bot present shows otherwise (bots.md section 5).
 */
const kindOf = (record: KindRecord | undefined): AccountKind =>
  record === "subscription" ? "subscription" : record ? "key" : "gateway";
const madeOf = (record: KindRecord | undefined): GatewayAccount["made"] =>
  record === "typed-key"
    ? "typed"
    : record === "subscription" || record === "sign-in-key"
      ? "sign-in"
      : null;

export function mergeAccounts(
  views: Map<string, BotView>,
  kinds: ReadonlyMap<string, KindRecord>,
): GatewayAccount[] {
  const seen = new Map<string, { profile: ViewProfile; shared: boolean; owners: Set<string> }>();
  for (const [botId, view] of views) {
    for (const profile of view.profiles) {
      const entry = seen.get(profile.id) ?? { profile, shared: false, owners: new Set<string>() };
      // A label comes only with admin: take any view's.
      if (!entry.profile.label && profile.label)
        entry.profile = { ...entry.profile, label: profile.label };
      if (profile.source === "saved") entry.owners.add(botId);
      else entry.shared = true;
      seen.set(profile.id, entry);
    }
  }
  const accounts: GatewayAccount[] = [];
  for (const { profile, shared, owners } of seen.values()) {
    if (accounts.length >= MAX_ACCOUNTS) break;
    // Saved in several bots' own stores, and inherited by none: each keeps its own copy.
    const keptBy = shared ? null : ([...owners].sort()[0] ?? null);
    accounts.push({
      id: profile.id,
      provider: profile.provider,
      label: profile.label,
      type: profile.type,
      status: profile.status,
      expiresAt: profile.expiresAt,
      kind: kindOf(kinds.get(profile.id)),
      made: madeOf(kinds.get(profile.id)),
      keptBy,
      logoutSupported: profile.logoutSupported,
    });
  }
  return accounts.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

const KNOWN_FLOWS: Record<string, SignInFlow> = {
  "openai/openai-token-sharing": "host",
  "github-copilot/github-copilot-enterprise": "domain",
};

/** The sign-ins the gateway can start, from `providerCapabilities[].loginOptions[]`. */
export function readMethods(capabilities: RawRecord[]): SignInMethod[] {
  const methods: SignInMethod[] = [];
  for (const capability of capabilities) {
    const provider = str(capability.provider);
    if (!provider) continue;
    for (const raw of Array.isArray(capability.loginOptions) ? capability.loginOptions : []) {
      const option = asRecord(raw);
      const id = str(option?.id);
      if (!option || !id || methods.length >= MAX_SIGNIN_METHODS) continue;
      const kind = str(option.kind) ?? "oauth";
      const flow: SignInFlow =
        KNOWN_FLOWS[id] ?? (kind === "device-code" ? "code" : kind === "secret" ? "key" : "paste");
      methods.push({
        id,
        provider,
        label: str(option.label) ?? id,
        hint: str(option.hint),
        kind,
        flow,
        // OpenRouter's sign-in saves a key billed per token.
        group: provider === "openrouter" ? "token" : "subscription",
      });
    }
  }
  return methods;
}

/** Providers that take a key, and the sign-in that takes it when the gateway offers one. */
export function readKeyProviders(view: BotView | undefined): KeyProvider[] {
  if (!view) return [];
  const out: KeyProvider[] = [];
  for (const capability of view.capabilities) {
    const provider = str(capability.provider);
    if (!provider || capability.apiKeySupported !== true || out.length >= MAX_KEY_PROVIDERS)
      continue;
    const secret = (Array.isArray(capability.loginOptions) ? capability.loginOptions : [])
      .map(asRecord)
      .find((option) => option?.kind === "secret");
    out.push({
      provider,
      hasKey: view.keyed.includes(provider),
      method: str(secret?.id),
    });
  }
  return out;
}

export function readCatalog(answer: unknown): CatalogModel[] {
  return modelRows(answer).slice(0, MAX_CATALOG_MODELS);
}

/** The providers whose picker rows `readCatalog` cut, with how many the gateway listed. */
export function readPickerCuts(answer: unknown): PickerCut[] {
  const rows = modelRows(answer);
  const out: PickerCut[] = [];
  for (const { provider } of rows.slice(MAX_CATALOG_MODELS)) {
    if (out.length >= MAX_KEY_PROVIDERS || out.some((cut) => cut.provider === provider)) continue;
    out.push({ provider, total: rows.filter((row) => row.provider === provider).length });
  }
  return out;
}

/** One provider's full list: its rows in the gateway's order, as kept, and how many it had. */
export function readProviderCatalog(
  answer: unknown,
  provider: string,
  /** The ids the picker already has: their rows go after the others. */
  known: ReadonlySet<string> = new Set(),
): { models: ListedModel[]; total: number; partial: boolean } {
  const record = asRecord(answer);
  const all = modelRows(answer).filter((row) => row.provider === provider);
  const rows = [
    ...all.filter((row) => !known.has(row.id)),
    ...all.filter((row) => known.has(row.id)),
  ].map(({ id, levels, defaultLevel }) => ({ id, levels, defaultLevel }));
  const pending = Array.isArray(record?.pendingProviders)
    ? record.pendingProviders.includes(provider)
    : false;
  return {
    models: rows.slice(0, MAX_PROVIDER_MODELS),
    total: rows.length,
    partial: pending || record?.refreshFailed === true,
  };
}

/** What a `models.list` answer's `providerOutcomes` says of one provider (`ModelRefresh`). */
function outcomeOf(answer: unknown, provider: string): RefreshOutcome {
  const outcomes = asRecord(answer)?.providerOutcomes;
  const statuses = (Array.isArray(outcomes) ? outcomes : [])
    .map(asRecord)
    .filter((each) => each?.provider === provider)
    .map((each) => each?.status);
  // The list was asked again if any account's discovery answered.
  if (statuses.includes("ready")) return "ready";
  if (statuses.includes("auth-rejected")) return "auth-rejected";
  return statuses.length > 0 ? "unavailable" : null;
}

/** Up to `MAX_REFRESH_NAMES` ids, each cleaned to one short line. */
const named = (ids: string[]) =>
  ids.slice(0, MAX_REFRESH_NAMES).map((id) => cleanLine(id, MAX_REFRESH_NAME_CHARS));

/**
 * One refresh's answer for a provider, against the ids the menu listed before: the rows it lists
 * now (in the gateway's order) and what changed. `configured` is from the gateway's config.
 */
export function readModelRefresh(
  answer: unknown,
  provider: string,
  before: readonly string[],
  /** The provider's model ids its entry in the gateway's config declares. */
  declared: ReadonlySet<string>,
  /** The gateway checks OpenClaw's model list online (`models.catalogRefresh`), or unknown. */
  hostedList: boolean | null,
  /** The config's model list for the bot asked for limits the provider, so filters its rows. */
  limited: boolean,
): {
  rows: CatalogModel[];
  compare: (shown: readonly string[], cutBefore: number | null) => ModelRefresh;
} {
  const record = asRecord(answer);
  const rows = modelRows(answer).filter((row) => row.provider === provider);
  const pending = Array.isArray(record?.pendingProviders)
    ? record.pendingProviders.includes(provider)
    : false;
  const outcome = outcomeOf(answer, provider);
  // The config's list is the whole list only when every model the gateway lists is one it
  // declares: otherwise OpenClaw's own or a plugin's are listed beside them. Rows a model list
  // for bots filtered say nothing of that.
  const configured = !limited && rows.length > 0 && rows.every((row) => declared.has(row.id));
  return {
    rows,
    compare: (shown, cutBefore) => {
      const was = new Set(before);
      const listed = new Set(rows.map((row) => row.id));
      // Gone only when the gateway no longer lists it, not when a cut no longer shows it; new only
      // when the menu showed the provider whole before, so a cut can't make a model look new.
      const added = cutBefore === null ? shown.filter((id) => !was.has(id)) : [];
      const removed = [...was].filter((id) => !listed.has(id));
      return {
        status: "done",
        provider,
        added: named(added),
        addedCount: added.length,
        removed: named(removed),
        removedCount: removed.length,
        removedIds: removed,
        counts: cutBefore === null ? null : { before: cutBefore, now: rows.length },
        cut:
          cutBefore === null && shown.length < rows.length
            ? { shown: shown.length, now: rows.length }
            : null,
        outcome,
        configured,
        hostedList,
        partial: pending,
        failed: record?.refreshFailed === true,
      };
    },
  };
}

/** Whether the gateway's config declares models for a provider (`models.providers.<id>.models`). */
export function declaredModels(config: RawRecord | null, provider: string): Set<string> {
  const root = asRecord(config?.config);
  const entry = asRecord(asRecord(asRecord(root?.models)?.providers)?.[provider]);
  const models = Array.isArray(entry?.models) ? entry.models.slice(0, MAX_PROVIDER_MODELS) : [];
  return new Set(models.map((model) => str(asRecord(model)?.id)).filter((id) => id !== null));
}

/**
 * The gateway checks OpenClaw's model list online, unless its config turns that off; null when the
 * config couldn't be read, so nothing is said of it.
 */
export function checksHostedList(config: RawRecord | null): boolean | null {
  if (config === null) return null;
  const root = asRecord(config.config);
  return asRecord(asRecord(root?.models)?.catalogRefresh)?.enabled !== false;
}

/** A wildcard entry: its provider, and whether it allows the provider whole. */
type Wildcard = { provider: string; whole: boolean };

/** At least one segment, each non-empty, without `*`, white space or a control character. */
const validSegments = (segments: string[]) =>
  segments.length >= 1 &&
  // eslint-disable-next-line no-control-regex
  segments.every((segment) => segment.length > 0 && !/[*\s\u0000-\u001f\u007f]/.test(segment));

/**
 * A wildcard as OpenClaw 2026.10.6 reads one (`parseModelPolicyWildcardRef`): segments split on
 * `/` and trimmed, the last exactly `*`. It matches at a segment's end only.
 */
function segmentWildcard(key: string): Wildcard | null {
  const segments = key
    .trim()
    .split("/")
    .map((segment) => segment.trim());
  if (segments.at(-1) !== "*" || !validSegments(segments.slice(0, -1))) return null;
  return { provider: segments[0]!.toLowerCase(), whole: segments.length === 2 };
}

/**
 * A wildcard as OpenClaw 2026.11.10 reads one (`parseModelPolicyWildcardRef`): it ends in `*`,
 * the segments before the last are trimmed and valid, and the last may be a prefix
 * (`openai/gpt-*`), which matches any model whose reference starts with it.
 */
function prefixWildcard(key: string): Wildcard | null {
  const trimmed = key.trim();
  if (!trimmed.endsWith("*")) return null;
  const pieces = trimmed.slice(0, -1).split("/");
  const last = (pieces.pop() ?? "").trimStart();
  const before = pieces.map((piece) => piece.trim());
  if (!validSegments(before) || (last !== "" && !validSegments([last]))) return null;
  return { provider: before[0]!.toLowerCase(), whole: before.length === 1 && last === "" };
}

/**
 * The config's model list for one bot (`ModelAllowlist`), as the gateway resolves it
 * (`resolveConfiguredModelPolicyAllow`), with `botId` null for a bot with no entry of its own.
 */
export function effectiveAllowlist(
  config: RawRecord | null,
  botId: string | null,
): ModelAllowlist | null {
  const root = asRecord(config?.config);
  const agents = asRecord(root?.agents);
  const defaults = asRecord(agents?.defaults);
  const own =
    botId === null ? null : asRecord(asRecord(asRecord(agents?.entries)?.[botId])?.modelPolicy);
  const policy = asRecord(defaults?.modelPolicy);
  const migrated = asRecord(asRecord(root?.meta)?.migrations)?.modelPolicyAllowlist === true;
  // The bot's own policy when it has an `allow`, then the default policy's; the old
  // `agents.defaults.models` only while there is no default policy and the config hasn't been
  // migrated, which any config write does.
  let refs: unknown[] = [];
  if (own && Object.hasOwn(own, "allow")) refs = Array.isArray(own.allow) ? own.allow : [];
  else if (policy && Object.hasOwn(policy, "allow"))
    refs = Array.isArray(policy.allow) ? policy.allow : [];
  else if (!policy && !migrated) refs = Object.keys(asRecord(defaults?.models) ?? {});
  const keys = refs
    .slice(0, MAX_ALLOWLIST_ENTRIES)
    .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
    .map((ref) => ref.trim());
  // An empty list limits nothing.
  if (keys.length === 0) return null;
  // Only `<provider>/*` leaves a provider whole (both versions read it alike, spaces trimmed); a
  // longer or prefix wildcard limits within it.
  const whole = new Set<string>();
  for (const key of keys) {
    const wildcard = segmentWildcard(key);
    if (wildcard?.whole) whole.add(wildcard.provider);
  }
  // A whole-provider entry the bounds below would drop would read as a limit the gateway never
  // set: then nothing is said of the list.
  const kept = [...whole].filter((provider) => provider.length <= MAX_PREF_ID_CHARS);
  if (kept.length !== whole.size || kept.length > MAX_KEY_PROVIDERS) return null;
  return {
    whole: kept,
    wildcards: keys.some((key) => segmentWildcard(key) !== null),
    prefixWildcards: keys.some((key) => prefixWildcard(key) !== null),
  };
}

/** Whether a bot's model list (`effectiveAllowlist`) limits a provider's models, so filters its rows. */
export function limitsProvider(list: ModelAllowlist | null, provider: string): boolean {
  return list !== null && !list.whole.includes(provider.toLowerCase());
}

/**
 * The config's model list as every bot's Model menu can say it: only when no bot has a list of
 * its own, so the default list is the one for each bot and for a new one; null otherwise, as
 * which list applies to the menu shown isn't known there.
 */
export function readModelAllowlist(config: RawRecord | null): ModelAllowlist | null {
  const entries = asRecord(asRecord(asRecord(config?.config)?.agents)?.entries);
  const ownLists = Object.values(entries ?? {}).some((entry) => {
    const policy = asRecord(asRecord(entry)?.modelPolicy);
    return policy !== null && Object.hasOwn(policy, "allow");
  });
  return ownLists ? null : effectiveAllowlist(config, null);
}

/** Every model row of a `models.list` answer, in its order. */
function modelRows(answer: unknown): CatalogModel[] {
  const record = asRecord(answer);
  const models = Array.isArray(record?.models) ? record.models : [];
  const out: CatalogModel[] = [];
  for (const raw of models) {
    const model = asRecord(raw);
    const id = str(model?.id);
    const provider = str(model?.provider);
    if (!model || !id || !provider) continue;
    const levels = (Array.isArray(model.thinkingLevels) ? model.thinkingLevels : [])
      .map((level) => str(asRecord(level)?.id) ?? str(level))
      .filter((level): level is string => level !== null)
      .slice(0, MAX_EFFORT_LEVELS);
    out.push({
      provider,
      id,
      name: str(model.name),
      available: model.available !== false,
      levels,
      defaultLevel: str(model.thinkingDefault),
    });
  }
  return out;
}

/** A bot's model as configured: a string, or `{primary, fallbacks}`. */
export function readModelConfig(value: unknown): {
  primary: string | null;
  fallbacks: string[] | null;
} {
  if (typeof value === "string") return { primary: value || null, fallbacks: null };
  const record = asRecord(value);
  if (!record) return { primary: null, fallbacks: null };
  return {
    primary: str(record.primary),
    fallbacks: Array.isArray(record.fallbacks) ? strings(record.fallbacks, MAX_FALLBACKS) : null,
  };
}

/** What Clawtrate set for a bot, kept with the person's preferences. */
export type BindingIntent = { mode: "account"; account: string } | { mode: "gateway" };

export function readIntent(value: unknown): BindingIntent | null {
  const record = asRecord(value);
  if (record?.mode === "gateway") return { mode: "gateway" };
  const account = prefProfileId(record?.account);
  if (record?.mode === "account" && account) return { mode: "account", account };
  return null;
}

/**
 * The evidence of one read of a bot's order. Locked only when all hold: the
 * order is exactly `[bound account]`, the bot's model still names it, and the
 * account is still among the gateway's (bots.md section 10).
 */
export function evaluateOrder(
  previous: LockEvidence,
  binding: Pick<BotBinding, "account" | "provider" | "mode">,
  order: StoredOrder | null,
  accountListed: boolean,
  at: number,
  seq: number | null = null,
  gateway: string | null = null,
  providerRead = true,
): LockEvidence {
  // A bot bound to an account whose provider the answer doesn't list: no reading of its order.
  // As a failed read, the last confirmation stands with its time, and nothing is said lost.
  if (binding.mode === "account" && binding.account && !providerRead)
    return {
      ...previous,
      status: "failed",
      attemptSeq: seq,
      readGateway: gateway,
      providerRead: false,
      error: providerNotListed(binding.provider ?? ""),
    };
  let status: LockEvidence["status"];
  const ids = order?.ids ?? [];
  if (binding.mode !== "account" || !binding.account || ids.length === 0) status = "none";
  // An order the bot's own store does not hold is the gateway's, from its settings or inherited.
  else if (!order?.stored) status = "configured";
  // The bound account is not in this bot's own view: its order is about an account it cannot use.
  else if (!accountListed) status = "none";
  else if (ids.length === 1 && ids[0] === binding.account) status = "matched";
  else if (ids.includes(binding.account)) status = "multi";
  else if (ids.length === 1) status = "other";
  else status = "none";
  const matched = status === "matched";
  // Matched before: the last answer matched, or a failed read since kept that confirmation.
  const wasMatched =
    previous.status === "matched" ||
    ((previous.status === "failed" || previous.status === "unavailable") &&
      previous.lastMatchAt !== null &&
      previous.lostAt === null);
  return {
    status,
    checkedAt: at,
    lastMatchAt: matched ? at : previous.lastMatchAt,
    lostAt: matched ? null : wasMatched ? at : previous.lostAt,
    readSeq: seq,
    attemptSeq: seq,
    startedSeq: previous.startedSeq,
    readGateway: gateway,
    providerRead,
    error: null,
  };
}

/**
 * Said when a read of the bot begun after the press's read before the send failed, and none has
 * succeeded since: nothing confirms the order the person confirmed, so nothing is sent.
 */
export function unconfirmedOrder(kind: "unlock" | "clear"): string {
  return `Clawtrate couldn't read the order again just now. Check now, then ${kind === "unlock" ? "Unlock" : "Clear order"} again.`;
}

/** Said when the gateway's answer for a bot doesn't list the provider of its account or order. */
export function providerNotListed(provider: string): string {
  return `The gateway's answer didn't list ${provider}, so it says nothing of that provider's order.`;
}

/** The word a bot's account row carries, from what was read. */
export type AccountWord = "bound" | "locked" | "stale" | "no-account" | "gateway" | "default-model";

export function accountWord(binding: BotBinding): AccountWord {
  if (binding.mode === "default-model") return "default-model";
  if (binding.mode === "gateway") return "gateway";
  if (binding.accountMissing) return "no-account";
  const evidence = binding.evidence;
  if (evidence.status === "matched") return "locked";
  // A read that failed keeps the last confirmation, with its time.
  if (
    (evidence.status === "failed" || evidence.status === "unavailable") &&
    evidence.lastMatchAt !== null &&
    evidence.lostAt === null
  )
    return "locked";
  if (evidence.status === "other" && binding.order?.stored) return "stale";
  return "bound";
}

/** A one-account order the gateway still keeps for a bot with no fixed account (row 36). */
export function retainedOrder(binding: BotBinding): string | null {
  if (binding.mode !== "gateway" || !binding.order?.stored) return null;
  return binding.order.ids.length === 1 ? binding.order.ids[0]! : null;
}

/**
 * What an Unlock or Clear is shown as now, from the gateway's reads of the bot, ordered by when
 * each began (`readSeq`, never the clock): as it ended, with the time of the read that settled it.
 * An unsure ending (`unanswered`, `unread`, `kept`) becomes `cleared` when a read begun after the
 * send, answered by the gateway the press was sent to, lists its provider and finds no stored order
 * for it, while no newer attempt has failed. A `cleared` one is shown no more (null) once a read
 * begun after its own finds a stored order there again: the line never says the order is gone
 * above a page that shows it.
 */
export function clearShown(
  clear: OrderClear,
  binding: BotBinding,
): { status: OrderClear["status"]; checkedAt: number | null } | null {
  const seq = binding.evidence.readSeq;
  const same = binding.provider === clear.provider;
  const stored = same && binding.order?.stored === true;
  if (clear.status === "cleared")
    return stored && seq !== null && clear.checkedSeq !== null && seq > clear.checkedSeq
      ? null
      : { status: "cleared", checkedAt: clear.checkedAt };
  const unsure =
    clear.status === "unanswered" || clear.status === "unread" || clear.status === "kept";
  const gateway =
    clear.gatewayId !== null &&
    binding.evidence.readGateway === clear.gatewayId &&
    binding.evidence.providerRead;
  if (
    unsure &&
    gateway &&
    same &&
    !stored &&
    seq !== null &&
    binding.evidence.attemptSeq === seq &&
    clear.sentSeq !== null &&
    seq > clear.sentSeq
  )
    return { status: "cleared", checkedAt: binding.evidence.checkedAt };
  return { status: clear.status, checkedAt: null };
}

/** The gateway's command line for the lock, in its own form (rows 12 and 14). */
export function lockCommand(
  prefix: string,
  binding: Pick<BotBinding, "botId" | "provider">,
  account: string,
): string {
  return `${prefix} models auth order set --provider ${binding.provider} --agent ${binding.botId} ${account}`;
}

export function unlockCommand(prefix: string, botId: string, provider: string): string {
  return `${prefix} models auth order clear --provider ${provider} --agent ${botId}`;
}

/**
 * Whether the gateway's command line changes a bot's account order only while the gateway is
 * stopped. From OpenClaw 2026.10.10, `models auth order set`, `clear` and `get` refuse while a
 * gateway owns the state and change nothing ("This command is offline-only … stop the Gateway
 * through its service owner, wait for ownership to release, then rerun this exact command");
 * 2026.10.9 and earlier run them beside the running gateway. The gateway offers no call that
 * sets a one-account order on either (`models.authOrderSet` takes every account or none), and
 * sends nothing that says which kind its command line is, so its reported version tells.
 */
export function orderNeedsStoppedGateway(serverVersion: string | null): boolean {
  return openClawAtLeast(serverVersion, 2026, 10, 10);
}

/** An order command as a gateway that changes orders only while stopped needs it: stop, run, start. */
export function stoppedGatewaySteps(prefix: string, command: string): [string, string, string] {
  return [`${prefix} gateway stop`, command, `${prefix} gateway start`];
}

// Sign-in steps ------------------------------------------------------------------------

export function readStep(value: unknown): SignInStep | null {
  const step = asRecord(value);
  const id = str(step?.id);
  if (!step || !id) return null;
  const device = asRecord(step.deviceCode);
  return {
    id,
    type: str(step.type) ?? "note",
    title: str(step.title),
    message: str(step.message),
    url: str(step.externalUrl),
    code: str(device?.code),
    expiresInMinutes: num(device?.expiresInMinutes),
    placeholder: str(step.placeholder),
    sensitive: step.sensitive === true,
  };
}

/** How a sign-in that ended without saving ended, from the gateway's words. */
export function endingOf(status: string | null, error: string | null): SignInStage {
  if (status === "cancelled") return "cancelled";
  if (status === "done") return "connected";
  const words = (error ?? "").toLowerCase();
  if (/\bexpired?\b|timed out|time limit/.test(words)) return "expired";
  // The gateway saved the credential and could not confirm it is active (row 6).
  if (/saved/.test(words) && /(confirm|activat|verify)/.test(words)) return "unconfirmed";
  return "failed";
}

/** Whether the gateway refused to start because it runs another sign-in or setup. */
export function isBusy(message: string): boolean {
  return /already in progress|already running|one at a time|busy/i.test(message);
}

/**
 * An error's text with every occurrence of what the person typed taken out,
 * so a gateway that echoes a key or a code never puts it in the state.
 */
export function withoutSecret(message: string, secret: string | null): string {
  if (!secret) return message;
  let out = message.split(secret).join("…");
  // A gateway may echo a trimmed form of it.
  const trimmed = secret.trim();
  if (trimmed && trimmed !== secret) out = out.split(trimmed).join("…");
  return out;
}

/** The most forms of submitted values a sign-in scrubs at once. */
export const MAX_SIGNIN_SECRETS = 8;

/**
 * The forms in which a gateway may give back something the person typed: as
 * typed, trimmed, decoded, and for an address pasted whole, each of its query
 * values (the code), raw and decoded. Pieces shorter than 4 characters are not
 * kept: they would cut into ordinary words.
 */
export function secretForms(value: string): string[] {
  const whole = wholeForms(value);
  const trimmed = value.trim();
  const pieces = [value, trimmed];
  const query = trimmed.indexOf("?");
  if (query >= 0) {
    for (const part of trimmed.slice(query + 1).split(/[&#]/)) {
      const equals = part.indexOf("=");
      pieces.push(equals >= 0 ? part.slice(equals + 1) : part);
    }
  }
  const forms: string[] = [...whole];
  for (const piece of pieces) {
    for (const form of [piece, decoded(piece)]) {
      if (form !== null && form.length >= 4 && !forms.includes(form)) forms.push(form);
    }
  }
  return forms;
}

/**
 * The value itself, as typed, trimmed and decoded: what is held first and
 * never pushed out by the pieces derived from it. A value shorter than 4
 * characters is not a credential and is not held (docs/decisions.md).
 */
export function wholeForms(value: string): string[] {
  const forms: string[] = [];
  for (const form of [value, value.trim(), decoded(value), decoded(value.trim())])
    if (form !== null && form.length >= 4 && !forms.includes(form)) forms.push(form);
  return forms;
}

/** A piece of an address, decoded, or null when it does not decode. */
function decoded(piece: string): string | null {
  try {
    return decodeURIComponent(piece.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/** A label as kept: trimmed, at most 32 characters. */
export function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * A label as a person reads it, to compare two: trimmed, runs of white space
 * as one, without case. Two labels with the same key read the same.
 */
export function labelKey(label: string): string {
  return normalizeLabel(label).toLowerCase();
}

/** Why a label cannot be saved for an account, or null. Labels are compared without case. */
export function labelProblem(
  accounts: readonly GatewayAccount[],
  profileId: string,
  label: string,
): string | null {
  const value = normalizeLabel(label);
  const account = accounts.find((each) => each.id === profileId);
  const provider = account?.provider ?? accountProvider(profileId);
  const others = accounts.filter((each) => each.provider === provider && each.id !== profileId);
  if (value.length === 0) {
    return others.length > 0
      ? `You have another ${providerName(provider)} account. A label tells them apart.`
      : null;
  }
  if (value.length > MAX_LABEL_CHARS) return `A label has at most ${MAX_LABEL_CHARS} characters.`;
  const taken = others.find(
    (each) => each.label !== null && labelKey(each.label) === labelKey(value),
  );
  if (taken)
    return `Another ${providerName(provider)} account is called ${taken.label}. Choose a different label.`;
  return null;
}
