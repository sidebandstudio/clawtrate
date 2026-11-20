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

import { asRecord, type RawRecord } from "./mapping.ts";

// Bounds --------------------------------------------------------------------------

/** Accounts listed across every bot's view. */
export const MAX_ACCOUNTS = 64;
/** Sign-in methods the gateway can start. */
export const MAX_SIGNIN_METHODS = 32;
/** Providers that take an API key. */
export const MAX_KEY_PROVIDERS = 64;
/** Models in the gateway's catalogue. */
export const MAX_CATALOG_MODELS = 128;
/** Effort levels per model. */
export const MAX_EFFORT_LEVELS = 12;
/** Accounts a stored order lists, as kept. */
export const MAX_ORDER_IDS = 16;
/** Fallback models a bot's model lists, as kept. */
export const MAX_FALLBACKS = 16;
/** Bots whose lock a sign-in re-checks. */
export const MAX_LOCK_CHECKS = 32;
/** Account changes Clawtrate made and keeps, for the grey line it draws in a task (row 15). */
export const MAX_ACCOUNT_CHANGES = 32;
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
  /**
   * The views don't establish which bots can use it: the same id is saved in
   * more than one bot's own store, a bot's own copy stands beside the shared
   * one, or the gateway lists it from its settings or an outside source
   * (`config`, `external`) and no bot as inherited. One row may then stand for
   * different credentials, and it is shared with no bot.
   */
  unclear: boolean;
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
  /**
   * Where the first of them is visible: to every bot (another bot's view lists
   * it as inherited), to one (only the target's own store has it), or
   * `unclear` (the views list it otherwise, so which bots can use it is not
   * established).
   */
  landed: "shared" | "kept" | "unclear" | null;
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
 * A step of creating a bot that did not land: Clawtrate's record of its
 * account (`preference`), its model with the empty fallback list and effort
 * (`fallbacks`), the gateway's bot list showing it (`listed`), its first task.
 */
export type MissingStep = "preference" | "fallbacks" | "listed" | "task";

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
 * A change of a bot's account that Clawtrate made, kept to draw the grey
 * event line in the task that was open for that bot: the gateway records no
 * such line (row 15). `account` null is "Let the gateway choose".
 */
export type AccountChange = {
  botId: string;
  /** The task that was open for the bot when it changed; the line is drawn there. */
  taskKey: string | null;
  at: number;
  provider: string;
  account: string | null;
  /** The account the bot was on before, when it had one. */
  previous: string | null;
  /** A run was in progress: it finishes on `previous`. */
  running: boolean;
};

export type AccountsState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  readAt: number | null;
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
  bindings: BotBinding[];
  signIn: SignInState | null;
  creation: BotCreationState | null;
  write: AccountWrite | null;
  /** The account changes Clawtrate made, newest last, at most `MAX_ACCOUNT_CHANGES`. */
  changes: AccountChange[];
};

export const initialAccountsState: AccountsState = {
  status: "idle",
  error: null,
  readAt: null,
  labels: false,
  defaultModel: null,
  mainShared: false,
  accounts: [],
  methods: [],
  keyProviders: [],
  models: [],
  bindings: [],
  signIn: null,
  creation: null,
  write: null,
  changes: [],
};

export const unreadEvidence: LockEvidence = {
  status: "unread",
  checkedAt: null,
  lastMatchAt: null,
  lostAt: null,
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

export function readBotView(answer: unknown): BotView {
  const record = asRecord(answer) ?? {};
  const profiles: ViewProfile[] = [];
  const orders: Record<string, StoredOrder> = {};
  const keyed = new Set<string>();
  const providers = Array.isArray(record.providers) ? record.providers : [];
  for (const raw of providers.slice(0, MAX_ACCOUNTS)) {
    const provider = asRecord(raw);
    const id = str(provider?.provider);
    if (!provider || !id) continue;
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
    orders,
    keyed: [...keyed],
    capabilities,
    unavailable: unavailableReason(answer),
  };
}

/**
 * Every account across the bots' refreshed views. An account is shared only
 * when some bot's view lists it as inherited; it is kept by a bot when that
 * bot's view alone lists it as its own (`saved`). Anything else, the same id
 * in several bots' own stores, a bot's own copy beside the shared one, or a
 * `config` or `external` source with no inherited one, is `unclear`. With a
 * single bot there is no second view, so its own accounts are kept by it
 * until a read with another bot present shows otherwise (bots.md section 5).
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
  const seen = new Map<
    string,
    { profile: ViewProfile; shared: boolean; owners: Set<string>; other: boolean }
  >();
  for (const [botId, view] of views) {
    for (const profile of view.profiles) {
      const entry = seen.get(profile.id) ?? {
        profile,
        shared: false,
        owners: new Set<string>(),
        other: false,
      };
      // A label comes only with admin: take any view's.
      if (!entry.profile.label && profile.label)
        entry.profile = { ...entry.profile, label: profile.label };
      if (profile.source === "saved") entry.owners.add(botId);
      else if (profile.source === "inherited") entry.shared = true;
      else entry.other = true;
      seen.set(profile.id, entry);
    }
  }
  const accounts: GatewayAccount[] = [];
  for (const { profile, shared, owners, other } of seen.values()) {
    if (accounts.length >= MAX_ACCOUNTS) break;
    // The shared store is `main`'s own: another bot's own copy beside it is not the shared one.
    const copies = [...owners].filter((owner) => !shared || owner !== "main");
    const unclear = shared ? copies.length > 0 : other || owners.size !== 1;
    const keptBy = !shared && !unclear ? [...owners][0]! : null;
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
      unclear,
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
  const record = asRecord(answer);
  const models = Array.isArray(record?.models) ? record.models : [];
  const out: CatalogModel[] = [];
  for (const raw of models) {
    const model = asRecord(raw);
    const id = str(model?.id);
    const provider = str(model?.provider);
    if (!model || !id || !provider || out.length >= MAX_CATALOG_MODELS) continue;
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
): LockEvidence {
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
    error: null,
  };
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
  // The gateway saved the credential and then could not finish or confirm it (row 6). Its own
  // words: "Your sign-in was saved, but …", "Credentials saved, but provider settings could not
  // be applied: …", "Provider credentials were saved, but sign-in did not finish: …".
  if (/\bsaved\b[^.]*\bbut\b/.test(words)) return "unconfirmed";
  if (/\bexpired?\b|timed out|time limit/.test(words)) return "expired";
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
