// The fixture's provider accounts (docs/design/bots.md): the accounts, the
// sign-ins a gateway can start, each bot's binding and lock evidence, and
// answers to the account commands that follow the engine's states closely
// enough for interface checks. Every account, label, link and code is made up.
//
// Address parameters:
//   access=read|write|admin   what the connection may do (default: the scene's)
//   accounts=none|loading|error|stale   no account yet, still loading, a failed read, or a
//                             failed read after one that listed the accounts
//   lock=locked|bound|stale|gone|failed|multi|old|gateway|retained|none|watching|differs|lost|unwritten
//        |configured|unavailable|elsewhere
//                             the open bot's binding and evidence
//   signin=<stage>            where a sign-in that starts goes: waiting (default),
//                             failed, expired, cancelled, ended, busy, unconfirmed, saving,
//                             checking (an answer stays checking), decline-checking (and a
//                             cancel there is declined), unverified (the read after
//                             it failed), cancel-unknown (the cancel's answer says nothing),
//                             several (two new accounts appeared while it ran), callback (a
//                             browser sign-in whose callback the gateway takes itself)
//   keyread=fail              a key saved directly whose read afterwards fails
//   keywarn=1                 a key saved directly with the gateway's warning (with keyread=fail
//                             too, the warning and a failed read after it)
//   keyfails=1                xAI's key goes through a sign-in that refuses it
//   saved=1                   a sign-in that ended uncleanly left an account behind
//   kept=1                    the gateway has no main bot with a shared store
//   create=failed|slow|checking|partial   how New bot's Create goes
//   admin=grant               a request for admin access is approved after a moment
//   defacct=1                 the gateway's default model names an account (openai:work)

import {
  ADMIN_SCOPES,
  INTERACTIVE_SCOPES,
  initialAccountsState,
  type AccountsState,
  type BotBinding,
  type BridgeCommand,
  type ClawtrateState,
  type GatewayAccount,
  type LockEvidence,
  type SignInState,
  signInAddress,
} from "@clawtrate/core";

export type AccountParams = {
  access: "read" | "write" | "admin" | null;
  accounts: "ready" | "none" | "loading" | "error" | "stale";
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
  keywarn: boolean;
};

export function accountParams(params: URLSearchParams): AccountParams {
  const access = params.get("access");
  const accounts = params.get("accounts");
  return {
    access: access === "read" || access === "write" || access === "admin" ? access : null,
    accounts:
      accounts === "none" || accounts === "loading" || accounts === "error" || accounts === "stale"
        ? accounts
        : "ready",
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
    keywarn: params.get("keywarn") === "1",
    labels:
      params.get("labels") === "none" || params.get("labels") === "same"
        ? (params.get("labels") as "none" | "same")
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
  keywarn: false,
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
  unclear: false,
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
  const stale = params.accounts === "stale";
  const state: AccountsState = {
    ...initialAccountsState,
    // A read that failed after one that listed them: its rows stay, as the engine keeps them.
    status: stale ? "error" : "ready",
    error: stale ? "models.authStatus timed out after 60 seconds." : null,
    readAt: now - READ_AGO,
    labels: params.access === "admin",
    defaultModel: params.defacct ? "openai/gpt-5.5@openai:work" : "openai/gpt-5.5",
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
      { provider: "openai", replaces: null, method: null },
      { provider: "anthropic", replaces: none ? null : "anthropic:manual", method: null },
      { provider: "xai", replaces: null, method: params.keyfails ? "xai/xai-api-key" : null },
      { provider: "openrouter", replaces: null, method: null },
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
  return withLock(state, params, now);
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
  /** The task of a bot that is open here, as a host knows it. */
  openTaskOf: (botId: string) => string | null = () => null,
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
      later(400, () =>
        upgrade({
          status: "pending",
          requestId: REQUEST,
          approveCommand: `openclaw devices approve ${REQUEST}`,
        }),
      );
      if (params.admin === "grant")
        later(1000, () => {
          upgrade({ status: "approved" });
          set(
            withAccess(
              { ...get(), accounts: { ...accounts(), labels: true } },
              { ...params, access: "admin" },
            ),
          );
        });
      return Promise.resolve();
    }
    case "refreshAccounts":
      pendingRead?.();
      pendingRead = null;
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
              url: signInAddress("https://sign-in.example/device"),
              urlRefused: false,
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
            accounts: [...a.accounts, ...ids.map((id) => account(id, null, "oauth", "gateway"))],
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
              url: signInAddress("https://sign-in.example/device"),
              urlRefused: false,
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
        // signin=callback: a browser sign-in whose callback the gateway takes itself, as the
        // gateway's steps show it: a page to open, and no code and no field.
        if (method.flow === "paste" && stage === "callback")
          return signIn({
            stage: "waiting",
            step: {
              id: "callback",
              type: "progress",
              title: null,
              message: "Complete sign-in in your browser.",
              url: signInAddress("https://sign-in.example/authorize?state=callback"),
              urlRefused: false,
              code: null,
              expiresInMinutes: null,
              placeholder: null,
              sensitive: false,
            },
          });
        if (method.flow === "paste")
          return signIn({
            stage: "entering",
            step: {
              id: "paste",
              type: "text",
              title: null,
              message: null,
              url: signInAddress("https://sign-in.example/authorize?state=fixture"),
              urlRefused: false,
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
              urlRefused: false,
              code: null,
              expiresInMinutes: null,
              placeholder: "github.example.com",
              sensitive: false,
            },
          });
        // A sign-in that finishes on the gateway's machine, in the gateway's own words: a note
        // with the page, then the wait for the callback.
        if (method.flow === "host")
          return signIn({
            stage: "waiting",
            saving: stage === "saving",
            step: {
              id: "host",
              type: "note",
              title: "Sign in with ChatGPT (Beta)",
              message:
                "Authorize eligible Responses API calls using your Codex allowance. Token sharing does not grant access to conversations, Codex history, or connected apps.\n\nOpen the sign-in link in your browser. Its localhost:8080 callback must reach this OpenClaw process. For an SSH host, forward the port with: ssh -N -L 8080:127.0.0.1:8080 user@gateway-host",
              url: signInAddress("https://sign-in.example/authorize?state=host"),
              urlRefused: false,
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
            url: signInAddress("https://sign-in.example/device"),
            urlRefused: false,
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
            url: signInAddress("https://github.example.com/login/device"),
            urlRefused: false,
            sensitive: false,
          },
        });
        return Promise.resolve();
      }
      signIn({ stage: "checking" });
      // signin=checking: the gateway is still finishing, for a picture of that stage;
      // signin=decline-checking: and it declines a cancel there, as it does once it is saving.
      if (params.signin !== "checking" && params.signin !== "decline-checking")
        later(400, () => connected());
      return Promise.resolve();
    }
    case "cancelSignIn":
      // signin=saving: the gateway declines the cancel; it is saving.
      if (accounts().signIn?.saving) return Promise.resolve({ cancelled: false });
      if (params.signin === "decline-checking") {
        signIn({ saving: true });
        return Promise.resolve({ cancelled: false });
      }
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
      // The account to label; the sign-in's outcome stays what it was.
      signIn({
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
        return Promise.resolve({ profileId: null, warning: null });
      }
      const id = `${command.provider}:manual`;
      const add = () =>
        put((a) => ({
          ...a,
          accounts: a.accounts.some((x) => x.id === id)
            ? a.accounts
            : [...a.accounts, account(id, null, "api_key", "key")],
        }));
      // The gateway's own words when it saved the key and didn't confirm applying it.
      const warning = params.keywarn
        ? "API key saved, but the Gateway has not confirmed applying the provider settings. Run `openclaw gateway restart` to apply them."
        : null;
      if (params.keyread) {
        // The gateway took it; the read after it failed. Check again reads it, and finds it.
        pendingRead = add;
        const failed = "Reading its accounts again failed, so Clawtrate can't say what it has now.";
        put((a) => ({
          ...a,
          write: {
            what: "key",
            target: command.provider,
            status: "unverified",
            error: warning ? `${warning} ${failed}` : `The gateway took the key. ${failed}`,
            at: Date.now(),
          },
        }));
        return Promise.resolve({ profileId: null, warning });
      }
      add();
      return Promise.resolve({ profileId: id, warning });
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
      put((a) => ({
        ...a,
        accounts: a.accounts.filter((x) => x.id !== command.profileId),
        bindings: a.bindings.map((b) =>
          b.account === command.profileId ? { ...b, accountMissing: true } : b,
        ),
      }));
      return Promise.resolve({ removed: true });
    case "createBot": {
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
      return new Promise((resolve, reject) =>
        later(500, () => {
          if (params.create === "failed") {
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
                status: params.create === "partial" ? "partial" : "created",
                slow: false,
                botId: id,
                error:
                  params.create === "partial"
                    ? `${name} was created, but its first task was not made: the gateway did not answer.`
                    : null,
                missing: params.create === "partial" ? ["task"] : [],
                uncertain: false,
              },
              bindings: [
                ...state.accounts.bindings,
                bound(id, ref, command.effort ?? "medium", Date.now()),
              ],
            },
          });
          resolve({ botId: id, missing: params.create === "partial" ? ["task"] : [] });
        }),
      );
    }
    case "finishBot":
      put((a) =>
        a.creation
          ? { ...a, creation: { ...a.creation, status: "created", missing: [], error: null } }
          : a,
      );
      return Promise.resolve({ botId: command.botId, missing: [] });
    case "dismissBotCreation":
      put((a) => ({ ...a, creation: null }));
      return Promise.resolve();
    case "changeBotAccount":
    case "setBotModel": {
      const before = accounts().bindings.find((b) => b.botId === command.botId);
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
      // The line Clawtrate draws in the open task for its own change of account.
      const taskKey = openTaskOf(command.botId);
      const changed =
        command.type === "changeBotAccount" &&
        (before?.account !== command.account || before?.provider !== command.provider);
      if (command.type === "changeBotAccount" && changed && taskKey) {
        put((a) => ({
          ...a,
          changes: [
            ...a.changes,
            {
              botId: command.botId,
              taskKey,
              at: Date.now(),
              provider: command.provider,
              account: command.account,
            },
          ],
        }));
      }
      return Promise.resolve(command.type === "changeBotAccount" ? { changed } : undefined);
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
              "gateway",
              params.kept ? { keptBy: current.forBot } : {},
            ),
          ],
      signIn: a.signIn
        ? // The gateway's answer names no account: the new one is a candidate to label.
          { ...a.signIn, stage: "several", step: null, result: result([id]) }
        : null,
    }));
  }
}
