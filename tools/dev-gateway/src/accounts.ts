// Scripted provider accounts for a named development instance.
//
//   pnpm dev-gateway start --instance <name> --with-accounts
//
// Two scripted providers, both served by the instance's own scripted model,
// and accounts of each saved in the gateway's account stores the way the
// gateway's own command line saves them. Every credential is a made-up
// development string that names its account (`credentialFor`), so the
// scripted model can tell which account a request came from without any
// table: `clawtrate-dev-key.acme.work` is account `acme:work`'s API key.
//
// Nothing here is a real provider, a real account or a real key, and every
// base URL is the instance's scripted model on loopback.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { matching, optional, type Contract } from "./contract.ts";

/** The scripted providers an instance with accounts has, besides `scripted`. */
export const ACCOUNT_PROVIDERS = ["acme", "globex"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

/** Each provider's models; `acme` has two so a run can ask for another model of the same provider. */
export const ACCOUNT_MODELS: Record<AccountProvider, readonly string[]> = {
  acme: ["dev-1", "dev-2"],
  globex: ["dev-1"],
};

/** How a credential is stored: the gateway's storage types. */
export type CredentialKind = "api_key" | "token" | "oauth";

/** Where an account is saved: the shared store every bot inherits, or one bot's own. */
export type AccountStore = { shared: true } | { bot: string };

export type ScriptedAccount = {
  /** The gateway's profile id, `<provider>:<name>`. */
  id: string;
  provider: AccountProvider;
  name: string;
  /** The label, written as `auth.profiles.<id>.displayName`. */
  label: string;
  kind: Exclude<CredentialKind, "oauth">;
  store: AccountStore;
};

const account = (
  provider: AccountProvider,
  name: string,
  label: string,
  kind: ScriptedAccount["kind"],
  store: AccountStore = { shared: true },
): ScriptedAccount => ({ id: `${provider}:${name}`, provider, name, label, kind, store });

/**
 * The accounts every instance started with `--with-accounts` has. Two of
 * `acme` and one of `globex` in the shared store, with labels; one more
 * `acme` account kept in Otto's own store, which only Otto sees.
 */
export const SCRIPTED_ACCOUNTS: readonly ScriptedAccount[] = [
  account("acme", "work", "Work", "api_key"),
  account("acme", "home", "Home", "api_key"),
  account("globex", "team", "Team", "token"),
  account("acme", "studio", "Studio", "api_key", { bot: "otto" }),
];

/** Lowercase letters and digits: a provider or an account name inside a credential. */
export const NAME_PART = /^[a-z][a-z0-9]{0,23}$/;

const CREDENTIAL_PREFIX: Record<CredentialKind, string> = {
  api_key: "clawtrate-dev-key",
  token: "clawtrate-dev-token",
  oauth: "clawtrate-dev-oauth",
};

/**
 * The made-up credential of an account. An OAuth sign-in's access credential
 * carries a serial, so each sign-in or refresh mints a new one.
 */
export function credentialFor(
  kind: CredentialKind,
  provider: string,
  name: string,
  serial?: number,
): string {
  if (!NAME_PART.test(provider) || !NAME_PART.test(name)) {
    throw new Error(`not a scripted account: ${provider}:${name}`);
  }
  return `${CREDENTIAL_PREFIX[kind]}.${provider}.${name}${serial === undefined ? "" : `.${serial}`}`;
}

const CREDENTIAL =
  /^clawtrate-dev-(key|token|oauth)\.([a-z][a-z0-9]{0,23})\.([a-z][a-z0-9]{0,23})(?:\.(\d{1,9}))?$/;
const KINDS = { key: "api_key", token: "token", oauth: "oauth" } as const;

export type CredentialAccount = { account: string; kind: CredentialKind };

/** Which account a bearer credential belongs to, or null for anything else. */
export function accountOfCredential(bearer: string | undefined): CredentialAccount | null {
  const match = CREDENTIAL.exec((bearer ?? "").replace(/^Bearer\s+/i, ""));
  if (!match) return null;
  return { account: `${match[2]}:${match[3]}`, kind: KINDS[match[1] as keyof typeof KINDS] };
}

/**
 * How the gateway's failover log names an account: `sha256:` and the first
 * twelve hex digits of the SHA-256 of its profile id.
 */
export function profileHash(profileId: string): string {
  return `sha256:${createHash("sha256").update(profileId).digest("hex").slice(0, 12)}`;
}

/** The gateway's own log file on an instance with accounts, read by `logs.tail`. */
export const accountsLogFile = (stateDir: string) => join(stateDir, "logs", "gateway.jsonl");

const scriptedModel = (id: string) => ({
  id,
  name: `Scripted ${id}`,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
});

/**
 * The provider entries an instance with accounts adds. No `apiKey`: the
 * credential comes from the account the gateway chooses for a run.
 */
export function accountProviders(providerPort: number) {
  return Object.fromEntries(
    ACCOUNT_PROVIDERS.map((provider) => [
      provider,
      {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: "openai-completions",
        models: ACCOUNT_MODELS[provider].map(scriptedModel),
      },
    ]),
  );
}

/** The labelled profile entries the config starts with, as the CLI writes them. */
export function accountProfiles() {
  return Object.fromEntries(
    SCRIPTED_ACCOUNTS.map((a) => [
      a.id,
      { provider: a.provider, mode: a.kind, displayName: a.label },
    ]),
  );
}

/** What `--with-accounts` adds to the generated config. */
export function accountsConfig(providerPort: number, stateDir: string) {
  return {
    providers: accountProviders(providerPort),
    auth: { profiles: accountProfiles() },
    // The failover decisions the design reads come from the gateway's log,
    // which `logs.tail` serves. Kept inside the instance.
    logging: { file: accountsLogFile(stateDir) },
  };
}

const PROFILE_ID = new RegExp(`^(${ACCOUNT_PROVIDERS.join("|")}):[a-z][a-z0-9-]{0,47}$`);
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * One profile entry the gateway may write on an instance with accounts:
 * the CLI and sign-ins write `{provider, mode}`, a label adds `displayName`
 * (and a sign-in may add `email`). Only the scripted providers, only the
 * gateway's storage types, and short plain strings.
 */
export function profileEntryProblem(id: string, entry: unknown): string | null {
  const match = PROFILE_ID.exec(id);
  if (!match) return `${id} is not a scripted account id`;
  if (!isPlainObject(entry)) return `${id} must be an object`;
  for (const key of Object.keys(entry)) {
    if (!["provider", "mode", "displayName", "email"].includes(key))
      return `${id}.${key} is not allowed`;
  }
  if (typeof entry.provider !== "string" || entry.provider !== match[1]) {
    return `${id}.provider must be ${match[1]}`;
  }
  // The type first, then the value: a closed set is only ever matched by a string.
  if (typeof entry.mode !== "string" || !["api_key", "token", "oauth"].includes(entry.mode)) {
    return `${id}.mode must be api_key, token or oauth`;
  }
  for (const key of ["displayName", "email"] as const) {
    const value = entry[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > 64 || /[\r\n]/.test(value))
    ) {
      return `${id}.${key} must be a short line of text`;
    }
  }
  return null;
}

/** The contract for `auth` on an instance with accounts: scripted profiles and nothing else. */
export function authContract(): Contract {
  return {
    profiles: matching("scripted account profiles", (value) => {
      if (!isPlainObject(value)) return false;
      return Object.entries(value).every(([id, entry]) => profileEntryProblem(id, entry) === null);
    }),
    // A sign-in may write a provider's order; only scripted account ids in it.
    order: optional(
      matching("orders of scripted accounts", (value) => {
        if (!isPlainObject(value)) return false;
        return Object.entries(value).every(
          ([provider, ids]) =>
            (ACCOUNT_PROVIDERS as readonly string[]).includes(provider) &&
            Array.isArray(ids) &&
            ids.every(
              (id) =>
                typeof id === "string" && id.startsWith(`${provider}:`) && PROFILE_ID.test(id),
            ),
        );
      }),
    ),
  };
}

/**
 * What `models.authSetApiKey` writes into a scripted provider's entry: the id
 * of the account it saved the key in (`globex:manual`), never the key, which
 * stays in the account store.
 */
export function providerKeyRefContract(provider: AccountProvider): Contract {
  return optional(
    matching(
      `an account id of ${provider}`,
      (value) =>
        typeof value === "string" && value.startsWith(`${provider}:`) && PROFILE_ID.test(value),
    ),
  );
}

/** The OpenClaw command that saves one account's credential, and what it reads on stdin. */
export function saveAccountCommand(a: ScriptedAccount): { args: string[]; stdin: string } {
  const args = [
    "models",
    "auth",
    a.kind === "token" ? "paste-token" : "paste-api-key",
    "--provider",
    a.provider,
    "--profile-id",
    a.id,
    // The shared store is the `main` bot's folder; any other bot's is its own.
    "--agent",
    "bot" in a.store ? a.store.bot : "main",
  ];
  return { args, stdin: `${credentialFor(a.kind, a.provider, a.name)}\n` };
}
