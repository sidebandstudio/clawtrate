// The fixture's provider accounts (docs/design/bots.md): the accounts, the
// sign-ins a gateway can start, each bot's binding and lock evidence, and
// answers to the account commands that follow the engine's states closely
// enough for interface checks. Every account, label, link and code is made up.
//
// Address parameters:
//   access=read|write|admin   what the connection may do (default: the scene's)
//   accounts=none|loading|error   no account yet, still loading, or a failed read
//   lock=locked|bound|stale|gone|failed|multi|old|gateway|retained|none|watching|differs|lost|unwritten
//        |configured|unavailable|elsewhere
//                             the open bot's binding and evidence
//   signin=<stage>            where a sign-in that starts goes: waiting (default),
//                             failed, expired, cancelled, ended, busy, unconfirmed, saving,
//                             checking (an answer stays checking), unverified (the read after
//                             it failed), cancel-unknown (the cancel's answer says nothing),
//                             several (two new accounts appeared while it ran)
//   keyread=fail              a key saved directly whose read afterwards fails
//   keyfails=1                xAI's key goes through a sign-in that refuses it
//   saved=1                   a sign-in that ended uncleanly left an account behind
//   kept=1                    the gateway has no main bot with a shared store
//   create=failed|slow|checking|partial   how New bot's Create goes
//   finish=release|release-failed   New bot's Finish answers, or is refused, on releaseFinish()
//   admin=grant               a request for admin access is approved after a moment, or on
//                             release if a test holds answers
//   defacct=1                 the gateway's default model names an account (openai:work)
//   catalog=slow|fail|unsupported|big|latepicker|pickercut|partial|trimmed|xaimore
//                             how "View more" and the picker load (bots.md section 9): the full
//                             list held until releaseCatalog() (xAI's then also lists gpt-5.5),
//                             failing once, refused, longer than kept, the picker held until
//                             releasePicker(), the picker cut with more OpenAI models listed,
//                             a first full list the gateway answers while still finding models,
//                             one cut short to rows the picker has, with 70 more left out,
//                             or xAI's full list with grok-4.8, which its picker lacks
//   model=<id>                the open bot's model
//   effort=none               the open bot keeps no effort
//   openclaw=behind|beta      the gateway reports a newer OpenClaw than it runs: 2026.11.6, or
//                             2026.11.10-beta.1 on the beta channel
//   refresh=new|many|gone|asked|config|refused|unreached|pending|failed|cut|error|slow
//                             what the Model menu's Refresh finds (#565): two new OpenAI models,
//                             seven, one gone, nothing new from a provider asked again, nothing
//                             from one the gateway's config lists, a provider that refused the
//                             account, one that didn't answer, one still being looked for, a
//                             refresh the gateway says failed, a list cut at its bound that grew,
//                             a gateway that didn't answer in time, or two new ones held until
//                             releaseRefresh(); without it, nothing new from a provider the
//                             gateway didn't ask again
//   allowlist=1               the gateway's config names the models bots may use

import { isUpdateRunScene, type UpdateRunScene } from "./openclaw-update.ts";
import {
  ADMIN_SCOPES,
  INTERACTIVE_SCOPES,
  gatewayStamp,
  initialAccountsState,
  sameStamp,
  type AccountsState,
  type BotBinding,
  type CatalogModel,
  MAX_PROVIDER_MODELS,
  type ModelList,
  type ModelRefresh,
  type BridgeCommand,
  type ClawtrateState,
  type GatewayAccount,
  type LockEvidence,
  type MissingStep,
  type SignInState,
} from "@clawtrate/core";

export type AccountParams = {
  access: "read" | "write" | "admin" | null;
  accounts: "ready" | "none" | "loading" | "error";
  lock: string | null;
  signin: string | null;
  saved: boolean;
  kept: boolean;
  create: string | null;
  admin: string | null;
  bot: string | null;
  /** The gateway's default model names an account. */
  defacct: boolean;
  /** The two OpenAI accounts' labels: "none" for neither, "same" for one label shared. */
  labels: "none" | "same" | null;
  /** xAI's key goes through a sign-in on the gateway, which refuses it. */
  keyfails: boolean;
  /** A key saved directly whose read afterwards fails; Check again reads it. */
  keyread: boolean;
  /**
   * How Edit picture's save ends: never answered, refused, answered with a list that differs, or
   * answered when the page calls `releasePictureSave()`.
   */
  picturesave: "hold" | "refused" | "unconfirmed" | "release" | null;
  /** New bot's Finish answered, or refused, when the page calls `releaseFinish()`. */
  finish: "release" | "release-failed" | null;
  /** How "View more" and the picker load. */
  catalog: string | null;
  /** The open bot's model. */
  model: string | null;
  /** The open bot keeps no effort. */
  noEffort: boolean;
  /** The gateway reports a newer OpenClaw than it runs: a stable release, or a beta. */
  openclaw: "behind" | "beta" | null;
  /** What the Model menu's Refresh finds. */
  refresh: string | null;
  /** The gateway's config names the models bots may use (`agents.defaults.models`). */
  allowlist: boolean;
  /** An update of OpenClaw under way or ended, or a gateway that can't update itself (F-589). */
  openclawRun: UpdateRunScene | null;
};

export function accountParams(params: URLSearchParams): AccountParams {
  const access = params.get("access");
  const accounts = params.get("accounts");
  return {
    access: access === "read" || access === "write" || access === "admin" ? access : null,
    accounts:
      accounts === "none" || accounts === "loading" || accounts === "error" ? accounts : "ready",
    lock: params.get("lock"),
    signin: params.get("signin"),
    saved: params.get("saved") === "1",
    kept: params.get("kept") === "1",
    create: params.get("create"),
    admin: params.get("admin"),
    bot: params.get("bot"),
    defacct: params.get("defacct") === "1",
    keyfails: params.get("keyfails") === "1",
    keyread: params.get("keyread") === "fail",
    picturesave:
      params.get("picturesave") === "hold" ||
      params.get("picturesave") === "refused" ||
      params.get("picturesave") === "unconfirmed" ||
      params.get("picturesave") === "release"
        ? (params.get("picturesave") as "hold" | "refused" | "unconfirmed" | "release")
        : null,
    finish:
      params.get("finish") === "release" || params.get("finish") === "release-failed"
        ? (params.get("finish") as "release" | "release-failed")
        : null,
    labels:
      params.get("labels") === "none" || params.get("labels") === "same"
        ? (params.get("labels") as "none" | "same")
        : null,
    catalog: params.get("catalog"),
    model: params.get("model"),
    noEffort: params.get("effort") === "none",
    openclaw:
      params.get("openclaw") === "behind" || params.get("openclaw") === "beta"
        ? (params.get("openclaw") as "behind" | "beta")
        : null,
    refresh: params.get("refresh"),
    allowlist: params.get("allowlist") === "1",
    openclawRun: isUpdateRunScene(params.get("openclawRun"))
      ? (params.get("openclawRun") as UpdateRunScene)
      : null,
  };
}

export const NO_ACCOUNT_PARAMS: AccountParams = {
  access: null,
  accounts: "ready",
  lock: null,
  signin: null,
  saved: false,
  kept: false,
  create: null,
  admin: null,
  bot: null,
  defacct: false,
  labels: null,
  keyfails: false,
  keyread: false,
  picturesave: null,
  finish: null,
  catalog: null,
  model: null,
  noEffort: false,
  openclaw: null,
  refresh: null,
  allowlist: false,
  openclawRun: null,
};

const MINUTE = 60_000;
/** When the fixture's accounts were read: after its connection was made (`connectedAt` is 1 s ago). */
const READ_AGO = 500;
const DAY = 86_400_000;

const account = (
  id: string,
  label: string | null,
  type: string,
  kind: GatewayAccount["kind"],
  extra: Partial<GatewayAccount> = {},
): GatewayAccount => ({
  id,
  provider: id.split(":")[0]!,
  label,
  type,
  status: type === "api_key" ? "static" : "ok",
  expiresAt: null,
  kind,
  made: kind === "subscription" ? "sign-in" : kind === "key" ? "typed" : null,
  keptBy: null,
  logoutSupported: true,
  ...extra,
});

const evidence = (patch: Partial<LockEvidence>): LockEvidence => ({
  status: "none",
  checkedAt: null,
  lastMatchAt: null,
  lostAt: null,
  error: null,
  ...patch,
});

const binding = (botId: string, patch: Partial<BotBinding>): BotBinding => ({
  botId,
  primary: null,
  provider: null,
  model: null,
  account: null,
  mode: "default-model",
  fallbacks: null,
  suffixLost: false,
  accountMissing: false,
  effort: null,
  order: null,
  evidence: evidence({}),
  fallbacksUnwritten: false,
  ...patch,
});

const bound = (
  botId: string,
  ref: string,
  effort: string,
  now: number,
  patch: Partial<BotBinding> = {},
) => {
  const [provider, rest] = ref.split("/") as [string, string];
  const [model, acct] = rest.split("@") as [string, string | undefined];
  return binding(botId, {
    primary: ref,
    provider,
    model,
    account: acct ?? null,
    mode: acct ? "account" : "gateway",
    fallbacks: [],
    effort,
    evidence: evidence({ status: "none", checkedAt: now - READ_AGO }),
    ...patch,
  });
};

/** The accounts and bindings every fixture scene has, read at `now`. */
export function fixtureAccounts(now: number, params: AccountParams): AccountsState {
  if (params.accounts === "loading") return { ...initialAccountsState, status: "loading" };
  if (params.accounts === "error")
    return {
      ...initialAccountsState,
      status: "error",
      error: "models.authStatus timed out after 60 seconds.",
    };
  const none = params.accounts === "none";
  const accounts: GatewayAccount[] = none
    ? []
    : [
        account("openai:work", params.labels === "none" ? null : "Work", "oauth", "subscription"),
        account(
          "openai:home",
          params.labels === "none" ? null : params.labels === "same" ? "work" : "Home",
          "oauth",
          "subscription",
        ),
        account("xai:personal", "Personal", "oauth", "subscription"),
        account("github-copilot:github", null, "token", "subscription", {
          status: "expiring",
          expiresAt: now + 3 * DAY,
        }),
        account("anthropic:manual", "Lab key", "api_key", "key"),
        account("anthropic:pip", "Pip's key", "api_key", "key", { keptBy: "pip" }),
      ];
  const locked = evidence({
    status: "matched",
    checkedAt: now - READ_AGO,
    lastMatchAt: now - READ_AGO,
  });
  const bindings: BotBinding[] = none
    ? [
        bound("main", "openai/gpt-5.5", "medium", now),
        bound("marlow", "openai/gpt-5.5", "low", now),
        bound("otto", "openai/gpt-5.5", "medium", now),
        bound("pip", "openai/gpt-5.5-mini", "low", now),
        binding("quartermaster", {}),
      ]
    : [
        bound("main", "openai/gpt-5.5", "medium", now),
        bound("marlow", "openai/gpt-5.5@openai:work", "low", now),
        bound("otto", "openai/gpt-5.5@openai:work", "medium", now, {
          order: { ids: ["openai:work"], stored: true, configured: null },
          evidence: locked,
        }),
        bound("pip", "openai/gpt-5.5-mini@openai:home", "low", now),
        binding("quartermaster", {}),
      ];
  const state: AccountsState = {
    ...initialAccountsState,
    status: "ready",
    readAt: now - READ_AGO,
    labels: params.access === "admin",
    defaultModel: params.defacct ? "openai/gpt-5.5@openai:work" : "openai/gpt-5.5",
    modelAllowlist: params.allowlist ? { whole: [] } : null,
    mainShared: !params.kept,
    accounts,
    methods: [
      {
        id: "xai/xai-oauth",
        provider: "xai",
        label: "xAI",
        hint: "SuperGrok or X Premium",
        kind: "device-code",
        flow: "code",
        group: "subscription",
      },
      {
        id: "openai/openai-device-code",
        provider: "openai",
        label: "ChatGPT",
        hint: "Plus, Pro or Business",
        kind: "device-code",
        flow: "code",
        group: "subscription",
      },
      {
        id: "openai/openai",
        provider: "openai",
        label: "ChatGPT in the browser",
        hint: "Plus, Pro or Business",
        kind: "oauth",
        flow: "paste",
        group: "subscription",
      },
      {
        id: "openai/openai-token-sharing",
        provider: "openai",
        label: "Sign in with ChatGPT",
        hint: "on the gateway's machine",
        kind: "oauth",
        flow: "host",
        group: "subscription",
      },
      {
        id: "github-copilot/github-copilot",
        provider: "github-copilot",
        label: "GitHub Copilot",
        hint: "Copilot subscription",
        kind: "device-code",
        flow: "code",
        group: "subscription",
      },
      {
        id: "github-copilot/github-copilot-enterprise",
        provider: "github-copilot",
        label: "GitHub Copilot Enterprise",
        hint: "Your company's GitHub",
        kind: "device-code",
        flow: "domain",
        group: "subscription",
      },
      {
        id: "minimax/minimax-global-oauth",
        provider: "minimax-portal",
        label: "MiniMax",
        hint: "Coding plan",
        kind: "device-code",
        flow: "code",
        group: "subscription",
      },
      {
        id: "openrouter/openrouter-oauth",
        provider: "openrouter",
        label: "OpenRouter",
        hint: "Credits",
        kind: "oauth",
        flow: "paste",
        group: "token",
      },
      ...(params.keyfails
        ? [
            {
              id: "xai/xai-api-key",
              provider: "xai",
              label: "xAI API key",
              hint: null,
              kind: "api-key",
              flow: "key" as const,
              group: "token" as const,
            },
          ]
        : []),
    ],
    keyProviders: [
      { provider: "openai", hasKey: false, method: null },
      { provider: "anthropic", hasKey: !none, method: null },
      { provider: "xai", hasKey: false, method: params.keyfails ? "xai/xai-api-key" : null },
      { provider: "openrouter", hasKey: false, method: null },
    ],
    models: [
      {
        provider: "openai",
        id: "gpt-5.5",
        name: null,
        available: true,
        levels: ["off", "low", "medium", "high"],
        defaultLevel: "medium",
      },
      {
        provider: "openai",
        id: "gpt-5.5-mini",
        name: null,
        available: true,
        levels: ["low", "medium"],
        defaultLevel: "low",
      },
      {
        provider: "openai",
        id: "gpt-5.5-codex",
        name: null,
        available: false,
        levels: ["low", "medium", "high"],
        defaultLevel: "medium",
      },
      {
        provider: "xai",
        id: "grok-4.7",
        name: null,
        available: true,
        levels: ["low", "high"],
        defaultLevel: "low",
      },
      {
        provider: "xai",
        id: "grok-build-0.1",
        name: null,
        available: true,
        levels: [],
        defaultLevel: null,
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-5.5",
        name: null,
        available: true,
        levels: ["off", "low", "medium", "high"],
        defaultLevel: "medium",
      },
      {
        provider: "github-copilot",
        id: "gpt-5.5",
        name: null,
        available: true,
        levels: ["low", "medium", "high"],
        defaultLevel: "medium",
      },
    ],
    bindings,
  };
  const model = params.model;
  const own = model
    ? {
        ...state,
        bindings: state.bindings.map((b) =>
          b.botId === (params.bot ?? "otto")
            ? { ...b, model, ...(params.noEffort ? { effort: null } : {}) }
            : b,
        ),
      }
    : state;
  // The picker arrives after the accounts, when the page calls releasePicker().
  if (params.catalog === "latepicker") return withLock({ ...own, models: [] }, params, now);
  if (params.catalog === "pickercut")
    return withLock({ ...own, modelsCut: [{ provider: "openai", total: 140 }] }, params, now);
  return withLock(own, params, now);
}

/**
 * A provider's full list, in the gateway's order, which is not the picker's:
 * models only it has sit between the picker's (bots.md section 9).
 */
function fullList(picker: CatalogModel[], provider: string, params: AccountParams) {
  // A late xAI list that also lists the OpenAI model a bot has: it must not replace a choice.
  if (provider === "xai" && params.catalog === "slow")
    return [...picker, { ...picker[0]!, id: "gpt-5.5" }];
  // xAI's full list with a model only it has, with its own levels.
  if (provider === "xai" && params.catalog === "xaimore")
    return [
      ...picker,
      { ...picker[0]!, id: "grok-4.8", levels: ["low", "medium", "high"], defaultLevel: "medium" },
    ];
  if (provider !== "openai") return picker;
  const extra = (id: string, available: boolean, levels: string[]): CatalogModel => ({
    provider,
    id,
    name: null,
    available,
    levels,
    defaultLevel: levels[Math.floor((levels.length - 1) / 2)] ?? null,
  });
  const by = (id: string) => picker.find((m) => m.id === id)!;
  const list = [
    by("gpt-5.5"),
    extra("gpt-5.4", true, ["low", "medium", "high"]),
    by("gpt-5.5-mini"),
    extra("gpt-5.4-mini", true, ["low", "medium"]),
    by("gpt-5.5-codex"),
    // Marked unavailable by the gateway: "View more" shows it like any other.
    extra("gpt-5.5-pro", false, ["medium", "high"]),
  ];
  if (params.catalog !== "big") return list;
  const many = Array.from({ length: MAX_PROVIDER_MODELS - list.length }, (_, i) =>
    extra(`gpt-test-${String(i + 1).padStart(4, "0")}`, true, []),
  );
  return [...list, ...many];
}

/**
 * Answer `loadModelCatalog` as the engine does, in the states the address asks for: the
 * answer is the command's result, kept nowhere.
 */
function loadCatalog(
  command: Extract<BridgeCommand, { type: "loadModelCatalog" }>,
  params: AccountParams,
  later: (ms: number, run: () => void) => void,
): Promise<ModelList> {
  const { provider } = command;
  const answer = (): ModelList => {
    const fixture = globalThis as unknown as { catalogTries?: number };
    fixture.catalogTries = (fixture.catalogTries ?? 0) + 1;
    if (params.catalog === "unsupported")
      return { status: "unsupported", error: "invalid models.list params" };
    if (params.catalog === "fail" && fixture.catalogTries === 1)
      return { status: "error", error: "The gateway did not answer." };
    const picker = fixtureAccounts(Date.now(), NO_ACCOUNT_PARAMS).models.filter(
      (m) => m.provider === provider,
    );
    // A partial first answer: the gateway is still finding the provider's models. A trimmed
    // one: what came is only rows the picker has, and 70 more were left out.
    const partial = params.catalog === "partial" && fixture.catalogTries === 1;
    const trimmed = params.catalog === "trimmed";
    const rows = partial || trimmed ? picker : fullList(picker, provider, params);
    // As the engine sends it: the rows the picker lacks first, only what the menu uses of each.
    const known = new Set(picker.map((m) => m.id));
    const models = [
      ...rows.filter((m) => !known.has(m.id)),
      ...rows.filter((m) => known.has(m.id)),
    ].map(({ id, levels, defaultLevel }) => ({ id, levels, defaultLevel }));
    return {
      status: "ready",
      models,
      total: params.catalog === "big" ? 1500 : trimmed ? models.length + 70 : models.length,
      partial,
    };
  };
  return new Promise((resolve) => {
    if (params.catalog === "slow")
      (globalThis as unknown as { releaseCatalog: () => void }).releaseCatalog = () =>
        resolve(answer());
    else later(100, () => resolve(answer()));
  });
}

/**
 * Answer `refreshModels` as the engine does, in the state the address asks for: the rows it
 * finds go into the accounts' models, and what changed is the command's result.
 */
function refreshCatalog(
  command: Extract<BridgeCommand, { type: "refreshModels" }>,
  params: AccountParams,
  get: () => AccountsState,
  put: (change: (a: AccountsState) => AccountsState) => void,
  later: (ms: number, run: () => void) => void,
): Promise<ModelRefresh> {
  const { provider } = command;
  const row = (id: string): CatalogModel => ({
    provider,
    id,
    name: null,
    available: true,
    levels: ["low", "medium", "high"],
    defaultLevel: "medium",
  });
  const kind = params.refresh ?? "none";
  const nothing: ModelRefresh = {
    status: "done",
    provider,
    added: [],
    addedCount: 0,
    removed: [],
    removedCount: 0,
    outcome: null,
    configured: false,
    hostedList: true,
    counts: null,
    partial: false,
    failed: false,
  };
  const answer = (): ModelRefresh => {
    switch (kind) {
      case "new":
      case "slow":
      case "many": {
        const ids =
          kind === "many"
            ? [
                "gpt-6.2-sol",
                "gpt-6.2-astra",
                "gpt-6.2-luna",
                "gpt-6.2-terra",
                "gpt-6.2-nova",
              ].concat(["gpt-6.2-mini", "gpt-6.2-nano"])
            : ["gpt-6.2-sol", "gpt-6.2-astra"];
        // As the engine does: the provider's rows replaced, and only what it lacked is new.
        const had = new Set(
          get()
            .models.filter((m) => m.provider === provider)
            .map((m) => m.id),
        );
        const added = ids.filter((id) => !had.has(id));
        put((a) => ({
          ...a,
          models: [
            ...a.models.filter((m) => m.provider !== provider || !ids.includes(m.id)),
            ...ids.map(row),
          ],
        }));
        return { ...nothing, added: added.slice(0, 5), addedCount: added.length, outcome: "ready" };
      }
      case "gone":
        put((a) => ({
          ...a,
          models: a.models.filter((m) => !(m.provider === provider && m.id === "gpt-5.5-mini")),
        }));
        return { ...nothing, removed: ["gpt-5.5-mini"], removedCount: 1, outcome: "ready" };
      case "asked":
        return { ...nothing, outcome: "ready" };
      case "config":
        return { ...nothing, configured: true };
      case "refused":
        return { ...nothing, outcome: "auth-rejected" };
      case "unreached":
        return { ...nothing, outcome: "unavailable" };
      case "pending":
        return { ...nothing, partial: true };
      case "failed":
        return { ...nothing, failed: true };
      case "cut":
        return { ...nothing, outcome: "ready", counts: { before: 140, now: 141 } };
      case "error":
        return { status: "error", error: "The gateway didn't answer in time." };
      default:
        return nothing;
    }
  };
  return new Promise((resolve) => {
    if (kind === "slow")
      (globalThis as unknown as { releaseRefresh: () => void }).releaseRefresh = () =>
        resolve(answer());
    else later(300, () => resolve(answer()));
  });
}

/** The open bot's binding in the state the address names. */
function withLock(state: AccountsState, params: AccountParams, now: number): AccountsState {
  const id = params.bot ?? "otto";
  const lock = params.lock;
  if (!lock) return state;
  const patch = (change: Partial<BotBinding>) => ({
    ...state,
    bindings: state.bindings.map((b) => (b.botId === id ? { ...b, ...change } : b)),
  });
  const work = "openai/gpt-5.5@openai:work";
  const at = now - READ_AGO;
  switch (lock) {
    case "locked":
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        order: { ids: ["openai:work"], stored: true, configured: null },
        evidence: evidence({ status: "matched", checkedAt: at, lastMatchAt: at }),
      });
    case "bound":
    case "watching":
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        order: null,
        evidence: evidence({ status: "none", checkedAt: at }),
      });
    case "stale":
      return patch({
        primary: "openai/gpt-5.5@openai:home",
        account: "openai:home",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        order: { ids: ["openai:work"], stored: true, configured: null },
        evidence: evidence({ status: "other", checkedAt: at, lastMatchAt: at - 2 * MINUTE }),
      });
    case "gone":
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        order: null,
        evidence: evidence({
          status: "none",
          checkedAt: at,
          lastMatchAt: at - 11 * MINUTE,
          lostAt: at,
        }),
      });
    case "failed":
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        order: { ids: ["openai:work"], stored: true, configured: null },
        evidence: evidence({
          status: "failed",
          checkedAt: at - 11 * MINUTE,
          lastMatchAt: at - 11 * MINUTE,
          error: "models.authStatus timed out",
        }),
      });
    case "multi":
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        order: { ids: ["openai:work", "openai:home"], stored: true, configured: null },
        evidence: evidence({ status: "multi", checkedAt: at }),
      });
    case "old":
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        order: { ids: ["openai:work"], stored: true, configured: null },
        evidence: evidence({
          status: "matched",
          checkedAt: now - 9 * MINUTE,
          lastMatchAt: now - 9 * MINUTE,
        }),
      });
    case "gateway":
      return patch({
        primary: "openai/gpt-5.5",
        account: null,
        provider: "openai",
        model: "gpt-5.5",
        mode: "gateway",
        order: null,
        fallbacks: [],
        evidence: evidence({ status: "none", checkedAt: at }),
      });
    case "retained":
      return patch({
        primary: "openai/gpt-5.5",
        account: null,
        provider: "openai",
        model: "gpt-5.5",
        mode: "gateway",
        order: { ids: ["openai:work"], stored: true, configured: null },
        fallbacks: [],
        evidence: evidence({ status: "none", checkedAt: at }),
      });
    case "lost":
      return patch({
        primary: "openai/gpt-5.5",
        account: null,
        provider: "openai",
        model: "gpt-5.5",
        mode: "gateway",
        suffixLost: true,
        order: null,
        evidence: evidence({ status: "none", checkedAt: at }),
      });
    case "none":
      return patch({
        primary: "openai/gpt-5.5@openai:gone",
        account: "openai:gone",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        accountMissing: true,
        order: null,
        evidence: evidence({ status: "none", checkedAt: at }),
      });
    case "configured":
      // An order the gateway's settings give OpenAI's accounts: not Otto's own, so never a lock.
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        order: { ids: ["openai:work"], stored: false, configured: "auth-config" },
        evidence: evidence({ status: "configured", checkedAt: at }),
      });
    case "unavailable":
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        order: { ids: ["openai:work"], stored: true, configured: null },
        evidence: evidence({
          status: "unavailable",
          checkedAt: at - 11 * MINUTE,
          lastMatchAt: at - 11 * MINUTE,
          error: "PREPARED_MODEL_AUTH_UNAVAILABLE",
        }),
      });
    case "elsewhere":
      // Bound to an account only Pip's own store keeps: Otto cannot use it.
      return patch({
        primary: "anthropic/claude-sonnet-5.5@anthropic:pip",
        account: "anthropic:pip",
        provider: "anthropic",
        model: "claude-sonnet-5.5",
        mode: "account",
        accountMissing: true,
        order: { ids: ["anthropic:pip"], stored: true, configured: null },
        evidence: evidence({ status: "none", checkedAt: at }),
      });
    case "differs":
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        fallbacks: ["anthropic/claude-sonnet-5.5"],
        order: null,
        evidence: evidence({ status: "none", checkedAt: at }),
      });
    case "unwritten":
      return patch({
        primary: work,
        account: "openai:work",
        provider: "openai",
        model: "gpt-5.5",
        mode: "account",
        fallbacksUnwritten: true,
        order: null,
        evidence: evidence({ status: "none", checkedAt: at }),
      });
    default:
      return state;
  }
}

/** The connection with the access the address names. */
export function withAccess(state: ClawtrateState, params: AccountParams): ClawtrateState {
  if (!params.access) return state;
  const scopes =
    params.access === "admin"
      ? [...ADMIN_SCOPES]
      : params.access === "write"
        ? [...INTERACTIVE_SCOPES]
        : ["operator.read"];
  return {
    ...state,
    connection: {
      ...state.connection,
      scopes,
      requestedScopes: scopes,
      canWrite: params.access !== "read",
      canAnswer: params.access !== "read",
      canApprove: params.access !== "read",
      canAdmin: params.access === "admin",
    },
  };
}

const REQUEST = "3f9a2c71-5b0e-4d6a-9c18-7e2f0a4b6d93";

/** The read a "Check again" makes, when the read after a direct key save failed (`keyread=fail`). */
let pendingRead: (() => void) | null = null;

/**
 * The account commands, answered on the fixture's state. Returns undefined
 * for a command that is not one of them.
 */
export function accountCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
  params: AccountParams,
  deferred: (run: () => void, ms: number) => void,
): Promise<unknown> | undefined {
  const accounts = () => get().accounts;
  const put = (change: (a: AccountsState) => AccountsState) =>
    set({ ...get(), accounts: change(accounts()) });
  const later = (ms: number, run: () => void) => setTimeout(run, ms);
  const signIn = (patch: Partial<SignInState>) =>
    put((a) => (a.signIn ? { ...a, signIn: { ...a.signIn, ...patch } } : a));
  // Where a sign-in landed: with `kept=1` in the store of the bot it was started for.
  const keeper = () => (params.kept ? (accounts().signIn?.forBot ?? "otto") : null);
  const result = (added: string[]) => ({
    added,
    landed: params.kept ? ("kept" as const) : ("shared" as const),
    keptBy: keeper(),
    readFailed: false,
    locks: [],
  });
  switch (command.type) {
    case "requestAccess": {
      if (command.tier !== "admin") return undefined;
      const upgrade = (patch: Partial<ClawtrateState["connection"]["upgrade"]>) =>
        set({
          ...get(),
          connection: { ...get().connection, upgrade: { ...get().connection.upgrade, ...patch } },
        });
      upgrade({
        status: "requesting",
        scopes: [...ADMIN_SCOPES],
        requestId: null,
        approveCommand: null,
        error: null,
      });
      // Only a request still being made goes to pending: an approval released first stands.
      later(400, () => {
        if (get().connection.upgrade.status === "requesting")
          upgrade({
            status: "pending",
            requestId: REQUEST,
            approveCommand: `openclaw devices approve ${REQUEST}`,
          });
      });
      // The owner's approval is an answer a test can hold, to look at the pending state first.
      if (params.admin === "grant")
        deferred(() => {
          upgrade({ status: "approved" });
          set(
            withAccess(
              { ...get(), accounts: { ...accounts(), labels: true } },
              { ...params, access: "admin" },
            ),
          );
        }, 1000);
      return Promise.resolve();
    }
    case "loadModelCatalog":
      if (params.catalog === "latepicker")
        (globalThis as unknown as { releasePicker: () => void }).releasePicker = () =>
          put((a) => ({ ...a, models: fixtureAccounts(Date.now(), NO_ACCOUNT_PARAMS).models }));
      return loadCatalog(command, params, later);
    case "refreshModels":
      return refreshCatalog(command, params, accounts, put, later);
    case "refreshAccounts":
      pendingRead?.();
      pendingRead = null;
      // The picker arrives on its own after the accounts, when the page releases it.
      if (params.catalog === "latepicker")
        (globalThis as unknown as { releasePicker: () => void }).releasePicker = () =>
          put((a) => ({ ...a, models: fixtureAccounts(Date.now(), NO_ACCOUNT_PARAMS).models }));
      return Promise.resolve();
    case "checkLock":
      put((a) => ({
        ...a,
        bindings: a.bindings.map((b) =>
          b.botId === command.botId && !["failed", "unavailable"].includes(b.evidence.status)
            ? {
                ...b,
                evidence: {
                  ...b.evidence,
                  checkedAt: Date.now(),
                  ...(b.evidence.status === "matched" ? { lastMatchAt: Date.now() } : {}),
                },
              }
            : b,
        ),
      }));
      return Promise.resolve();
    case "startSignIn": {
      const method = accounts().methods.find((m) => m.id === command.methodId)!;
      const base: SignInState = {
        id: "fixture-signin",
        method: method.id,
        provider: method.provider,
        label: method.label,
        flow: method.flow,
        forBot: params.kept ? (command.botId ?? "otto") : "main",
        keptOnly: params.kept,
        stage: "starting",
        step: null,
        error: null,
        cancelling: false,
        saving: false,
        startedAt: Date.now(),
        result: null,
        byKey: false,
        known: [],
        cancelUnknown: false,
      };
      put((a) => ({ ...a, signIn: base }));
      const stage = params.signin ?? "waiting";
      later(300, () => {
        if (stage === "busy")
          return signIn({
            stage: "busy",
            error: "OpenClaw setup is already in progress; try again when it finishes.",
          });
        if (stage === "starting") return;
        if (stage === "connected") {
          // The person approves on the provider's page a moment later.
          signIn({
            stage: "waiting",
            step: {
              id: "code",
              type: "progress",
              title: null,
              message: null,
              url: "https://sign-in.example/device",
              code: "QK4F-7PZD",
              expiresInMinutes: 15,
              placeholder: null,
              sensitive: false,
            },
          });
          later(500, () => connected());
          return;
        }
        if (stage === "several") {
          // Two new accounts while it ran, the gateway naming neither: the person chooses.
          const ids = [`${method.provider}:other`, `${method.provider}:second`];
          put((a) => ({
            ...a,
            accounts: [
              ...a.accounts,
              ...ids.map((id) => account(id, null, "oauth", "subscription")),
            ],
          }));
          return signIn({ stage: "several", step: null, result: result(ids) });
        }
        if (stage === "unverified")
          return signIn({
            stage: "unverified",
            result: { ...result([]), readFailed: true },
          });
        if (stage === "cancel-unknown")
          return signIn({
            stage: "waiting",
            cancelUnknown: true,
            error: "The gateway did not answer the cancel within 60 seconds.",
            step: {
              id: "code",
              type: "progress",
              title: null,
              message: null,
              url: "https://sign-in.example/device",
              code: "QK4F-7PZD",
              expiresInMinutes: 15,
              placeholder: null,
              sensitive: false,
            },
          });
        if (["failed", "expired", "cancelled", "ended", "unconfirmed"].includes(stage)) {
          return signIn({
            stage: stage as SignInState["stage"],
            error:
              stage === "failed"
                ? `${method.label} refused the sign-in: the code was not accepted.`
                : stage === "unconfirmed"
                  ? "Your sign-in was saved, but the connection update could not be confirmed. Send /login refresh in chat to try again."
                  : null,
            result: result(
              params.saved || stage === "unconfirmed" ? [`${method.provider}:second`] : [],
            ),
          });
        }
        if (method.flow === "paste")
          return signIn({
            stage: "entering",
            step: {
              id: "paste",
              type: "text",
              title: null,
              message: null,
              url: "https://sign-in.example/authorize?state=fixture",
              code: null,
              expiresInMinutes: null,
              placeholder: "Paste here",
              sensitive: true,
            },
          });
        if (method.flow === "domain")
          return signIn({
            stage: "entering",
            step: {
              id: "domain",
              type: "text",
              title: "GitHub Enterprise address",
              message:
                "Enter your company's GitHub address. The gateway then shows a code to enter there.",
              url: null,
              code: null,
              expiresInMinutes: null,
              placeholder: "github.example.com",
              sensitive: false,
            },
          });
        if (method.flow === "host")
          return signIn({
            stage: "waiting",
            step: {
              id: "host",
              type: "progress",
              title: null,
              message:
                "On a computer that isn't the gateway, forward its port first: ssh -N -L 8080:127.0.0.1:8080 gateway-host. Then open the sign-in page in that computer's browser.",
              url: "https://sign-in.example/authorize?state=host",
              code: null,
              expiresInMinutes: null,
              placeholder: null,
              sensitive: false,
            },
          });
        signIn({
          stage: "waiting",
          saving: stage === "saving",
          step: {
            id: "code",
            type: "progress",
            title: null,
            message: null,
            url: "https://sign-in.example/device",
            code: "QK4F-7PZD",
            expiresInMinutes: 15,
            placeholder: null,
            sensitive: false,
          },
        });
      });
      return Promise.resolve();
    }
    case "answerSignIn": {
      const current = accounts().signIn;
      if (current?.step && !current.step.sensitive && current.flow === "domain") {
        signIn({
          stage: "waiting",
          step: {
            ...current.step,
            type: "progress",
            code: "QK4F-7PZD",
            expiresInMinutes: 15,
            url: "https://github.example.com/login/device",
            sensitive: false,
          },
        });
        return Promise.resolve();
      }
      signIn({ stage: "checking" });
      // signin=checking: the gateway is still finishing, for a picture of that stage.
      if (params.signin !== "checking") later(400, () => connected());
      return Promise.resolve();
    }
    case "cancelSignIn":
      // signin=cancel-unknown: the gateway's answer to the cancel says nothing.
      if (params.signin === "cancel-unknown") {
        signIn({ cancelUnknown: true });
        return Promise.resolve({ cancelled: false });
      }
      signIn({
        stage: "cancelled",
        step: null,
        result: result(params.saved ? ["openai:second"] : []),
      });
      return Promise.resolve({ cancelled: true });
    case "dismissSignIn": {
      const current = accounts().signIn;
      if (params.signin === "cancel-unknown" && current && current.result === null)
        return Promise.resolve({ dismissed: false });
      put((a) => ({ ...a, signIn: null }));
      return Promise.resolve({ dismissed: true });
    }
    case "chooseSignInAccount": {
      const chosen = accounts().accounts.find((x) => x.id === command.profileId);
      signIn({
        stage: "connected",
        result: {
          ...result([command.profileId]),
          landed: chosen?.keptBy ? "kept" : "shared",
          keptBy: chosen?.keptBy ?? null,
        },
      });
      return Promise.resolve();
    }
    case "recheckSignIn":
      signIn({ stage: "checking", result: null });
      later(300, () => connected());
      return Promise.resolve();
    case "saveApiKey": {
      const keyed = accounts().keyProviders.find((k) => k.provider === command.provider);
      if (keyed?.method) {
        // A key's sign-in on the gateway, which refuses the key.
        const method = accounts().methods.find((m) => m.id === keyed.method)!;
        put((a) => ({
          ...a,
          signIn: {
            id: "fixture-key",
            method: method.id,
            provider: method.provider,
            label: method.label,
            flow: "key",
            forBot: "main",
            keptOnly: false,
            stage: "checking",
            step: null,
            error: null,
            cancelling: false,
            saving: false,
            startedAt: Date.now(),
            result: null,
            byKey: true,
            known: [],
            cancelUnknown: false,
          },
        }));
        later(300, () => signIn({ stage: "failed", error: "xAI refused the key." }));
        return Promise.resolve({ profileId: null });
      }
      const id = `${command.provider}:manual`;
      const add = () =>
        put((a) => ({
          ...a,
          accounts: a.accounts.some((x) => x.id === id)
            ? a.accounts
            : [...a.accounts, account(id, null, "api_key", "key")],
        }));
      if (params.keyread) {
        // The gateway took it; the read after it failed. Check again reads it, and finds it.
        pendingRead = add;
        put((a) => ({
          ...a,
          write: {
            what: "key",
            target: command.provider,
            status: "unverified",
            error:
              "The gateway took the key, but reading its accounts afterwards failed: models.authStatus timed out.",
            at: Date.now(),
          },
        }));
        return Promise.resolve({ profileId: null });
      }
      add();
      return Promise.resolve({ profileId: id });
    }
    case "setAccountLabel":
      put((a) => ({
        ...a,
        accounts: a.accounts.map((x) =>
          x.id === command.profileId ? { ...x, label: command.label.trim() } : x,
        ),
      }));
      return Promise.resolve();
    case "disconnectAccount":
      // As the host does (`requireSameGateway`): a confirmation from before the target moved,
      // with no connection open, or for another gateway, removes nothing.
      if (command.stamp.target !== get().connection.target)
        return Promise.reject(
          new Error(
            "The connection changed since this screen was read, so nothing was sent. Look again, then try again.",
          ),
        );
      if (get().connection.status !== "connected")
        return Promise.reject(new Error("Not connected to the gateway."));
      if (!sameStamp(command.stamp, gatewayStamp(get().connection)))
        return Promise.reject(
          new Error("This change was made for another gateway, so nothing was sent."),
        );
      put((a) => ({
        ...a,
        accounts: a.accounts.filter((x) => x.id !== command.profileId),
        bindings: a.bindings.map((b) =>
          b.account === command.profileId ? { ...b, accountMissing: true } : b,
        ),
      }));
      return Promise.resolve();
    case "createBot": {
      // As the host does: nothing is sent for a gateway other than the one connected.
      if (!sameStamp(command.stamp, gatewayStamp(get().connection)))
        return Promise.reject(
          new Error("This change was made for another gateway, so nothing was sent."),
        );
      const name = command.name.trim() || "New bot";
      put((a) => ({
        ...a,
        creation: {
          name,
          status: params.create === "checking" ? "checking" : "creating",
          slow: false,
          botId: null,
          error: null,
          missing: [],
          uncertain: false,
        },
      }));
      if (params.create === "slow") {
        later(300, () =>
          put((a) => (a.creation ? { ...a, creation: { ...a.creation, slow: true } } : a)),
        );
        return new Promise(() => {});
      }
      // create=release: the answer comes when the page calls `releaseCreate()`.
      const answer = (run: () => void) =>
        params.create === "release" || params.create === "release-failed"
          ? ((globalThis as unknown as { releaseCreate: () => void }).releaseCreate = run)
          : later(500, run);
      // As the host does (`forgetGatewayState`): what a gateway answers after another has
      // replaced it changes nothing kept; only the reply goes back.
      const asked = get().connection.gatewayId;
      return new Promise((resolve, reject) =>
        answer(() => {
          if (get().connection.gatewayId !== asked) {
            if (params.create === "release-failed") reject(new Error("Could not create the bot."));
            else resolve({ botId: "made-elsewhere", missing: [] });
            return;
          }
          if (params.create === "failed" || params.create === "release-failed") {
            put((a) =>
              a.creation
                ? { ...a, creation: { ...a.creation, status: "failed", error: "refused" } }
                : a,
            );
            reject(new Error("Could not create the bot."));
            return;
          }
          const id =
            name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "") || "new-bot";
          const ref = `${command.provider}/${command.model}${command.account ? `@${command.account}` : ""}`;
          const missing: MissingStep[] =
            params.create === "partial"
              ? ["task"]
              : params.create === "partial-identity"
                ? ["identity"]
                : [];
          const state = get();
          set({
            ...state,
            bots: [
              ...state.bots,
              {
                id,
                name,
                emoji: null,
                avatarUrl: command.avatar,
                theme: null,
                model: ref,
                isDefault: false,
              },
            ],
            tasksByBot: { ...state.tasksByBot, [id]: [] },
            accounts: {
              ...state.accounts,
              creation: {
                name,
                // create=partial: the bot exists, and its first task was not made.
                // create=partial-identity: the bot exists, and its name was not written into
                // its IDENTITY.md, so OpenClaw's first-run questions are still on.
                status: missing.length > 0 ? "partial" : "created",
                slow: false,
                botId: id,
                error:
                  params.create === "partial"
                    ? `${name} was created, but its first task was not made: the gateway did not answer.`
                    : params.create === "partial-identity"
                      ? `${name} was created, but OpenClaw's first-run questions were not turned off: the gateway did not answer.`
                      : null,
                missing,
                uncertain: false,
              },
              bindings: [
                ...state.accounts.bindings,
                bound(id, ref, command.effort ?? "medium", Date.now()),
              ],
            },
          });
          resolve({ botId: id, missing });
        }),
      );
    }
    case "finishBot": {
      // As the host does: nothing is sent for a gateway other than the one connected.
      if (!sameStamp(command.stamp, gatewayStamp(get().connection)))
        return Promise.reject(
          new Error("This change was made for another gateway, so nothing was sent."),
        );
      const asked = get().connection.gatewayId;
      const done = () => {
        // What a gateway answers after another has replaced it changes nothing kept.
        if (get().connection.gatewayId !== asked) return;
        put((a) =>
          a.creation
            ? { ...a, creation: { ...a.creation, status: "created", missing: [], error: null } }
            : a,
        );
      };
      if (params.finish === null) {
        done();
        return Promise.resolve({ botId: command.botId, missing: [] });
      }
      // A second Finish cannot take the answer already held for the first caller.
      const fixture = globalThis as unknown as { releaseFinish?: () => void };
      if (fixture.releaseFinish)
        return Promise.reject(new Error("That bot is already being finished."));
      return new Promise((resolve, reject) => {
        const release = () => {
          if (fixture.releaseFinish !== release) return;
          delete fixture.releaseFinish;
          if (params.finish === "release-failed") {
            reject(new Error("Could not finish the bot."));
            return;
          }
          done();
          resolve({ botId: command.botId, missing: [] });
        };
        fixture.releaseFinish = release;
      });
    }
    case "dismissBotCreation":
      put((a) => ({ ...a, creation: null }));
      return Promise.resolve();
    case "changeBotAccount":
    case "setBotModel": {
      put((a) => ({
        ...a,
        bindings: a.bindings.map((b) => {
          if (b.botId !== command.botId) return b;
          const accountId = command.type === "changeBotAccount" ? command.account : b.account;
          const provider = command.type === "changeBotAccount" ? command.provider : b.provider!;
          const ref = `${provider}/${command.model}${accountId ? `@${accountId}` : ""}`;
          const next = bound(b.botId, ref, command.effort ?? b.effort ?? "medium", Date.now(), {
            order: b.order,
          });
          // The order the gateway keeps is not changed by a change of account.
          const ids = b.order?.ids ?? [];
          const status: LockEvidence["status"] =
            !accountId || ids.length === 0
              ? "none"
              : ids.length === 1 && ids[0] === accountId
                ? "matched"
                : ids.includes(accountId)
                  ? "multi"
                  : ids.length === 1
                    ? "other"
                    : "none";
          return { ...next, evidence: { ...b.evidence, status, checkedAt: Date.now() } };
        }),
      }));
      return Promise.resolve();
    }
    case "setBotPicture": {
      // As the host does: nothing is sent for a gateway other than the one connected.
      if (!sameStamp(command.stamp, gatewayStamp(get().connection)))
        return Promise.reject(
          new Error("This change was made for another gateway, so nothing was sent."),
        );
      if (params.picturesave === "hold") return new Promise(() => {});
      if (params.picturesave === "refused")
        return Promise.reject(new Error("agents.update: INVALID_REQUEST (a gateway's own words)"));
      if (params.picturesave === "unconfirmed") return Promise.resolve({ confirmed: false });
      const save = () => {
        const state = get();
        set({
          ...state,
          bots: state.bots.map((bot) =>
            bot.id === command.botId ? { ...bot, avatarUrl: command.avatar } : bot,
          ),
        });
        return { confirmed: true };
      };
      if (params.picturesave === "release")
        return new Promise((resolve) => {
          (globalThis as unknown as { releasePictureSave: () => void }).releasePictureSave = () =>
            resolve(save());
        });
      return Promise.resolve(save());
    }
    case "removeBotFallbacks":
      put((a) => ({
        ...a,
        bindings: a.bindings.map((b) =>
          b.botId === command.botId ? { ...b, fallbacks: [], fallbacksUnwritten: false } : b,
        ),
      }));
      return Promise.resolve();
    default:
      return undefined;
  }

  function connected() {
    const current = accounts().signIn;
    if (!current) return;
    const id = `${current.provider}:second`;
    put((a) => ({
      ...a,
      accounts: a.accounts.some((x) => x.id === id)
        ? a.accounts
        : [
            ...a.accounts,
            account(
              id,
              null,
              current.flow === "key" ? "api_key" : "oauth",
              "subscription",
              params.kept ? { keptBy: current.forBot } : {},
            ),
          ],
      signIn: a.signIn
        ? { ...a.signIn, stage: "connected", step: null, result: result([id]) }
        : null,
    }));
  }
}
