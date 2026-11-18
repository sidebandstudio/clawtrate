// The words the account screens use (docs/design/bots.md, sections 4 to 11),
// from the engine's state. Pure functions; nothing here reads the gateway.

import {
  accountWord,
  providerName,
  retainedOrder,
  type AccountsState,
  type Bot,
  type BotBinding,
  type ConnectionState,
  type GatewayAccount,
  type HostInfo,
  type SignInFlow,
} from "@clawtrate/core";

export { providerName };

/**
 * An account's name. Labels reach admin connections only; below admin an
 * account is its provider and its id on the gateway, which is what tells two
 * accounts of one provider apart there (section 6). On admin an account
 * without a label, or with one it shares, is named by its id as well.
 */
export function accountName(
  account: GatewayAccount,
  accounts: Pick<AccountsState, "labels" | "accounts">,
): string {
  const provider = providerName(account.provider);
  const { label, id } = accountParts(account, accounts);
  return `${provider}${label ? ` · ${label}` : ""}${id ? ` ${id}` : ""}`;
}

/**
 * What names an account after its provider: its label, and its id on the
 * gateway whenever the label alone does not tell it apart. No two accounts of
 * a provider ever read the same: below admin there are no labels; an account
 * with none shows its id; and one whose label another account of the provider
 * shares (compared without case) shows its id too.
 */
export function accountParts(
  account: GatewayAccount,
  accounts: Pick<AccountsState, "labels" | "accounts">,
): { label: string | null; id: string | null } {
  const label = accounts.labels ? account.label : null;
  if (!label) return { label: null, id: account.id };
  const shared = accounts.accounts.some(
    (other) =>
      other.id !== account.id &&
      other.provider === account.provider &&
      other.label?.toLowerCase() === label.toLowerCase(),
  );
  return { label, id: shared ? account.id : null };
}

export function kindWord(account: GatewayAccount): string {
  return account.kind === "subscription"
    ? "Subscription"
    : account.kind === "key"
      ? "API key"
      : "Added on the gateway";
}

/** How an account was made, for its page (section 7). */
export function howMade(account: GatewayAccount): string {
  return account.kind === "subscription"
    ? "A sign-in Clawtrate started"
    : account.kind === "key"
      ? account.type === "api_key"
        ? "An API key, entered in Clawtrate"
        : "A sign-in that saves a key"
      : "Added on the gateway";
}

const DAY = 86_400_000;

/**
 * The state word for an account, as the gateway's status gives it (section
 * 4): nothing for `ok` and `static`; "Needs sign-in" for `missing`; an expiry
 * only for a kind the gateway cannot renew by itself (a `token`).
 */
export function stateWord(
  account: GatewayAccount,
  now: number,
): { tone: "warn" | "danger" | null; word: string } {
  if (account.status === "missing") return { tone: "warn", word: "Needs sign-in" };
  if (account.type === "token" && account.status === "expired")
    return { tone: "danger", word: "Expired" };
  if (account.type === "token" && account.status === "expiring") {
    const days = account.expiresAt
      ? Math.max(1, Math.round((account.expiresAt - now) / DAY))
      : null;
    return {
      tone: "warn",
      word: days ? `Expires in ${days} day${days === 1 ? "" : "s"}` : "Expires soon",
    };
  }
  return { tone: null, word: "Connected" };
}

/** The bots bound to an account in their settings: "Used by" (section 7). */
export function usedBy(
  accountId: string,
  bindings: readonly BotBinding[],
  bots: readonly Bot[],
): Array<{ bot: Bot; locked: boolean }> {
  return bindings
    .filter((binding) => binding.mode === "account" && binding.account === accountId)
    .map((binding) => ({
      bot: bots.find((bot) => bot.id === binding.botId),
      locked: accountWord(binding) === "locked",
    }))
    .filter((each): each is { bot: Bot; locked: boolean } => each.bot !== undefined);
}

/** The line under an account's title: its kind, a state that needs attention, who uses it. */
export function accountLine(
  account: GatewayAccount,
  accounts: AccountsState,
  bots: readonly Bot[],
  now: number,
): { kind: string; state: { tone: "warn" | "danger"; word: string } | null; users: string } {
  const { tone, word } = stateWord(account, now);
  const keeper = account.keptBy ? bots.find((bot) => bot.id === account.keptBy) : null;
  const users = usedBy(account.id, accounts.bindings, bots).map((each) => each.bot.name);
  return {
    kind: kindWord(account),
    state: tone ? { tone, word } : null,
    users: account.keptBy
      ? `Only ${keeper?.name ?? account.keptBy} can use it`
      : users.length > 0
        ? users.join(", ")
        : "Not used yet",
  };
}

export type Group = { title: string; accounts: GatewayAccount[] };

/** The account blocks: subscriptions, API keys, added on the gateway, kept by one bot. */
export function accountGroups(list: readonly GatewayAccount[], keptToo: boolean): Group[] {
  const shared = list.filter((account) => account.keptBy === null);
  const groups: Group[] = [
    { title: "Subscriptions", accounts: shared.filter((a) => a.kind === "subscription") },
    { title: "API keys", accounts: shared.filter((a) => a.kind === "key") },
    { title: "Added on the gateway", accounts: shared.filter((a) => a.kind === "gateway") },
  ];
  if (keptToo)
    groups.push({ title: "Kept by one bot", accounts: list.filter((a) => a.keptBy !== null) });
  return groups.filter((group) => group.accounts.length > 0);
}

/** What the person does in a sign-in, from the method's kind (section 5). */
export function flowWords(flow: SignInFlow): string {
  switch (flow) {
    case "code":
      return "Open a page and enter a code";
    case "paste":
      return "Open a page, then paste a code back here";
    case "host":
      return "Finishes in a browser on the gateway's machine";
    case "domain":
      return "Your company's GitHub address, then a code";
    case "key":
      return "Type a key, which goes to your gateway";
  }
}

/** The word on a bot's account row (section 10). It never shortens. */
export function bindingWord(binding: BotBinding): string {
  switch (accountWord(binding)) {
    case "locked":
      return (binding.evidence.status === "failed" || binding.evidence.status === "unavailable") &&
        binding.evidence.lastMatchAt !== null
        ? `Locked, as of ${clock(binding.evidence.lastMatchAt)}`
        : "Locked";
    case "stale":
      return "Lock out of date";
    case "no-account":
      return "No account";
    case "gateway":
      return "Gateway chooses";
    case "default-model":
      return "Gateway's default model";
    case "bound":
      return "Bound";
  }
}

/** A time as the evidence line gives it: "5:41 PM". */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * How a command reaches the gateway's machine: the development gateway's
 * instance has a profile of its own, which the host knows; otherwise the
 * gateway's ordinary command line.
 */
export function gatewayCli(info: HostInfo, connection: ConnectionState): string {
  if (info.devGateway?.cli && connection.gatewayUrl === info.devGateway.url)
    return info.devGateway.cli;
  return "openclaw";
}

/** The provider and model a bot set to "Let the gateway choose" or on the default model uses. */
export function defaultRef(accounts: AccountsState): { provider: string; model: string } | null {
  const primary = accounts.defaultModel;
  if (!primary) return null;
  const slash = primary.indexOf("/");
  if (slash <= 0) return null;
  const rest = primary.slice(slash + 1);
  const at = rest.lastIndexOf("@");
  return { provider: primary.slice(0, slash), model: at > 0 ? rest.slice(0, at) : rest };
}

/** The account the gateway's default model names, if it names one (section 4). */
export function defaultAccount(accounts: AccountsState): string | null {
  const primary = accounts.defaultModel;
  if (!primary) return null;
  const at = primary.lastIndexOf("@");
  return at > 0 ? primary.slice(at + 1) : null;
}

/** The models the gateway lists for a provider. */
export function modelsOf(accounts: AccountsState, provider: string) {
  return accounts.models.filter((model) => model.provider === provider);
}

/**
 * The model chosen at first for a provider: the gateway's default model when
 * it belongs to that provider, else the provider's first model (section 4).
 */
export function firstModel(accounts: AccountsState, provider: string): string | null {
  const own = defaultRef(accounts);
  if (
    own &&
    own.provider === provider &&
    modelsOf(accounts, provider).some((m) => m.id === own.model)
  )
    return own.model;
  return (
    modelsOf(accounts, provider).find((m) => m.available)?.id ??
    modelsOf(accounts, provider)[0]?.id ??
    null
  );
}

/**
 * The effort for a model: the model's own default level when the gateway
 * reports one, else the middle of its levels; null when it reports none.
 */
export function firstEffort(
  accounts: AccountsState,
  provider: string,
  model: string | null,
  keep?: string | null,
): string | null {
  const levels = modelsOf(accounts, provider).find((m) => m.id === model)?.levels ?? [];
  if (levels.length === 0) return null;
  if (keep && levels.includes(keep)) return keep;
  const own = modelsOf(accounts, provider).find((m) => m.id === model)?.defaultLevel;
  if (own && levels.includes(own)) return own;
  return levels[Math.floor((levels.length - 1) / 2)]!;
}

/** A level as shown: "Low". */
export function levelWord(level: string | null): string {
  if (!level) return "Not offered";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export { retainedOrder };
