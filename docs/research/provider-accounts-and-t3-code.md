# Provider accounts and T3 Code

Research for parity rows F-472 to F-488 and F-138. It answers what OpenClaw
2026.10.6 offers for choosing a provider account per bot, and what T3 Code
offers an agent that it did not start.

## How to read this

Every finding is marked:

- **[source]**: read in the installed package, with the file and line, the
  schema path or the doc page;
- **[probe]**: observed on a named development instance with scripted model
  servers only (`docs/research/dev-gateway/provider-accounts/`);
- **[inferred]**: a conclusion drawn from the two above that nothing here
  tested directly.

A claim that something does not exist names the search behind it, or says
"not found in" those places. A claim that something needs `operator.admin`
names the lower-scope paths that were checked.

Paths:

- `<openclaw>` is the installed `openclaw` 2026.10.6 package (the folder the
  `openclaw` wrapper script runs `dist/entry.js` from). `dist/` file names
  carry the build's content hashes.
- `<protocol>` is `@openclaw/gateway-protocol` 2026.10.6, `protocol.schema.json`.
  Its `methods` map gives each method's scope; `definitions` gives parameter
  and result shapes.
- `<t3>` is `Contents/Resources/app.asar` inside the installed T3 Code
  (Nightly) application, version `0.1.8-nightly.20261109.4433`. Files were
  read out of the archive without running anything; line numbers are lines of
  each extracted file. `<t3>/server` is `apps/server/dist/server-BKP_9JiU.mjs`,
  `<t3>/runtime` is `apps/server/dist/ManagedEndpointRuntime-dymI0Epp.mjs`.
- `t3code` docs are the public repository `github.com/pingdotgg/t3code`,
  read over the web.

The capability map (`docs/research/gateway-capabilities.md`, and its reviewed
revision at `e83af08`) said nothing on provider accounts. Its section 5 called
T3 Code's interface unverified. This file does not edit the map.

## The facts a designer needs most

1. **The gateway has its own provider sign-in, but only at `operator.admin`.**
   `models.authLogin` starts it, `wizard.next` steps it, `wizard.status` and
   `wizard.cancel` follow and cancel it. A device-code sign-in shows a code and
   a link; a browser sign-in shows a link and, for a client that is not a
   browser on the gateway's own origin, then asks for the redirect URL to be
   pasted back. `models.authStatus` (`operator.read`) lists accounts, their
   kind and state, and which sign-in methods each provider offers, without
   secrets. **[source, partly probe]**
2. **There is no per-bot account setting.** A bot chooses a provider through
   its model (`agents.update {model}`), and within a provider the gateway
   picks an auth profile. Each bot has its own credential store, but it is
   merged with the shared one. A bot is therefore bound to a provider, not to
   an account, unless the account lives only in that bot's store. The two
   gateway methods that look like binding tools are not: `models.authOrderSet`
   only reorders, it refuses an order that leaves a profile out; and
   `models.authSetApiKey {agentId}` writes to the shared store whenever the
   provider has a `models.providers` entry. In the probe, two bots given
   different keys both ran on the second key. **[source, probe]**
3. **The gateway moves runs to other accounts and providers by itself.**
   Within a provider it rotates auth profiles on auth, rate-limit, billing and
   timeout failures. Across providers it follows `model.fallbacks`, which
   `agents.defaults.model` may carry for every bot that has no model of its
   own. The only client-visible trace is a `lifecycle` event
   `phase:"fallback_step"` with `fallbackStepFromModel` and
   `fallbackStepToModel`. A billing failure also disables that credential for
   about ten minutes for every bot that uses it. **[source, probe]**
4. **No run record names the account.** `chat` errors, `lifecycle` events, the
   `terminalReceipt`, `chat.history` rows and `sessions.list` rows name the
   provider and model, never an auth profile. **[probe, source]**
5. **Removing an account is gateway-wide for a configured provider.**
   `models.authLogout {provider, agentId}` removed the shared profile, the
   provider's key binding and the key for every bot on that provider; the next
   runs went out with no `Authorization` header at all. **[probe]**

What needs a plugin: binding one bot to one account so that it never runs on
another, a user-set account label, a per-bot "no fallback" guarantee that also
covers bots created later, naming the account in a turn's record, and offering
sign-in below `operator.admin`. Details in A.12.

For T3 Code: **its interface for outside agents is established** from the
application bundle and its public documentation. It is a Streamable HTTP MCP
server at `<T3 Code server>/mcp`, signed in with OAuth 2.1 and PKCE, with five
access levels, and 30-day sessions. The six operations are `t3_project_list`,
`t3_thread_launch`, `t3_thread_send`, `t3_thread_read` (with `t3_thread_wait`),
`t3_thread_list` and `t3_thread_interrupt`. The gateway can hold such a server
(`mcp.servers.<name>` with `auth:"oauth"`), but Clawtrate cannot start that
sign-in: `mcp.authLogin` requires a browser-origin connection. There is no
static credential to store, which F-482 assumes.

---

## Part A. Provider accounts

### A.1 How the gateway represents a provider account

- **Provider**: a model provider id such as `openai`, `xai`, `anthropic`,
  or a custom entry under `models.providers.<id>` (`{baseUrl, api, apiKey?,
  auth?, models[]}`). Bundled providers come from provider plugins, each with
  an `openclaw.plugin.json` manifest under `<openclaw>/dist/extensions/<id>/`.
  **[source]**
- **Account = auth profile.** A profile has an id, a provider and a credential
  of one of three types (`<openclaw>/docs/concepts/model-failover.md`, "Auth
  storage" and "Profile IDs"):
  - `api_key`: `{provider, key}`;
  - `oauth`: `{provider, access, refresh, expires, email?}`, which is what a
    subscription sign-in produces;
  - `token`: a static bearer token, optionally expiring, never refreshed (for
    example Anthropic's pasted `setup-token`).

  Profile ids: `provider:<email>` for an OAuth sign-in that reports an email,
  `provider:default` without one, `provider:manual` for a pasted API key or
  token (`<openclaw>/dist/auth-api-key-B25pB09w.mjs` line 22). **[source]**
- **Where they are stored** (`<openclaw>/docs/concepts/oauth.md`, "Storage"):
  - shared credentials in `state/openclaw.sqlite` under the state folder;
  - each bot's own credentials and its order, last-good, cooldown and usage
    state in `agents/<agentId>/agent/openclaw-agent.sqlite`
    (`auth_profile_store`, `auth_profile_state`);
  - config `auth.profiles.<id>` `{provider, mode}` and `auth.order.<provider>`
    are routing metadata only, with no secrets.

  A bot's runtime store is the shared store merged with its own, its own
  entries winning by profile id (`mergeLocalAuthProfileStoreWithInheritedStore`,
  `<openclaw>/dist/runtime-snapshots-DiWi6TS1.mjs` lines 666-668; line 1119).
  **[source]**
- **Personal accounts** are a separate, multi-user feature: accounts owned by
  a verified person, kept in identity-scoped records, chosen per chat or as
  that person's default for new chats (`<openclaw>/docs/concepts/oauth.md`,
  "Multi-user: personal accounts"; `<openclaw>/docs/auth-credential-semantics.md`,
  "Personal model accounts"). They are not attached to a bot. **[source]**
- **Subscription versus API key**: the profile `type` (`oauth` or `token`
  versus `api_key`), reported by `models.authStatus` (A.5). **[source, probe for api_key]**
- **Which providers offer a subscription sign-in through the gateway.** A
  provider's manifest declares `providerAuthChoices`; the gateway can start a
  choice only when it is eligible, has `credentialOnly: true` and declares
  `appGuidedAuth` (`isProviderLoginChoiceStartable`,
  `<openclaw>/dist/provider-login-options-7Qv-pZM6.mjs` lines 4-13). Searching
  every bundled `dist/extensions/*/openclaw.plugin.json` gives exactly these
  startable choices **[source]**:

  | Provider (plugin) | Choice id | Flow |
  | --- | --- | --- |
  | `openai` | `openai` | browser link with callback (`oauth`) |
  | `openai` | `openai-device-code` | device code |
  | `openai` | `openai-token-sharing` ("Sign in with ChatGPT", `siwc`) | browser link (`oauth`) |
  | `xai` | `xai-oauth` | device code ("Remote-friendly browser sign-in without a localhost callback") |
  | `github-copilot` | `github-copilot`, `github-copilot-enterprise` | device code |
  | `minimax` (provider `minimax-portal`) | `minimax-global-oauth`, `minimax-cn-oauth` | device code |
  | `openrouter` | `openrouter-oauth` | browser link (`oauth`) |

  Not startable through the gateway, CLI or setup only: Anthropic's Claude CLI
  reuse (`anthropic-cli`) and `setup-token` (pasted token), Microsoft Foundry
  Entra ID, local servers (Ollama, LM Studio, vLLM, SGLang), and the manual-only
  `xai-device-code` alias. API-key choices are not started this way; keys go
  through `models.authSetApiKey` (A.8).
- **xAI's sign-in is a device code, never a localhost callback**
  (`<openclaw>/docs/providers/xai.md`, "OAuth troubleshooting"). It needs an
  eligible SuperGrok or X Premium subscription (same page, lines 8-16). **[source]**

### A.2 Starting, following and cancelling a sign-in from a client

All of this is in the gateway's method table and needs **`operator.admin`**.

| Method | Scope | Source |
| --- | --- | --- |
| `models.authStatus {agentId?, refresh?}` | `operator.read` | `core-method-policy-DkntKRY_.mjs` line 551 |
| `models.authLogin {sessionId, authChoice, agentId?, workspace?, modelTarget?, nativeSessionCatalogsEnabled?}` | `operator.admin`, checked again in the handler | line 2809; `models-auth-login-DleMUtMB.mjs` lines 17-22 |
| `wizard.next {sessionId, answer?:{stepId, value}}` | `operator.admin` | line 419 |
| `wizard.status {sessionId}`, `wizard.cancel {sessionId, closeInput?}` | `operator.admin` | lines 431, 425 |

(All `core-method-policy` lines are in `<openclaw>/dist/core-method-policy-DkntKRY_.mjs`;
parameter shapes are `<protocol>` `SystemAgentSetupAuthStartParams`,
`WizardNextParams`, `WizardNextResult`, `WizardStatusResult`,
`WizardCancelParams`.)

The flow, **[source]** unless marked:

1. List what can be started: `models.authStatus` returns `providerCapabilities:
   [{provider, apiKeySupported, quickApiKeySetup, loginOptions?:[{id, brandId,
   label, hint, groupLabel, icon, website, docsUrl, kind, featured}]}]`
   (`<openclaw>/dist/model-provider-capabilities-BdU0CAne.mjs` lines 16-33).
   `kind` is `oauth` or `device-code`. `id` is `<pluginId>/<choiceId>`
   (`provider-login-options-7Qv-pZM6.mjs` lines 38-40), and it is the
   `authChoice` to pass.
2. Start: `models.authLogin {sessionId: <client-chosen>, authChoice, agentId}`
   answers `{sessionId, done:false, status:"running"}`
   (`<openclaw>/dist/wizard-login-aEAlt0K2.mjs` lines 33-37). One setup or
   login runs at a time; otherwise the call fails as busy (same file, lines
   8-15). The session times out after 25 minutes (`timeoutMs: 15e5`,
   `models-auth-login-DleMUtMB.mjs` line 121).
3. Follow: `wizard.next {sessionId}` returns `{done, step?, status, error?}`.
   A step is `{id, type: note|select|text|confirm|multiselect|progress|action,
   title?, message?, options?, placeholder?, sensitive?, executor?:
   gateway|client, externalUrl?, deviceCode?:{code, expiresInMinutes?,
   message?}}`. The client answers with `wizard.next {sessionId, answer:{stepId,
   value}}`. The exact step sequence of each provider was **not observed**: it
   needs a real provider.
4. What a browser sign-in asks of a client that is not a browser on the
   gateway's own origin: the gateway runs the flow with `isRemote: true`
   (`models-auth-login-DleMUtMB.mjs` line 86). It offers a callback on its own
   `/oauth/provider/callback` only when the connection has a browser origin that
   is the gateway host or its published Tailscale origin
   (`<openclaw>/dist/provider-browser-auth-BOjjbaDz.mjs` lines 10, 21-31).
   Otherwise the generic handler shows the link as a note and then asks for
   "Paste the redirect URL" as a `sensitive` text step
   (`<openclaw>/dist/provider-oauth-flow-DL7WaUgl.mjs` lines 8-21). That pasted
   URL carries a one-time authorization code, which would pass through
   Clawtrate's client on its way to the gateway. Clawtrate's Node host opens
   its socket with `new WebSocket(url)` and no `Origin`
   (`packages/core/src/node/index.ts` line 124), so it would get the paste path
   **[inferred]**. Device-code flows ask nothing of the client but to show the
   code and link **[inferred from the step schema]**.
5. Cancel: `wizard.cancel {sessionId}` returns `{status, error?}`. The login
   session belongs to the connection that started it: another connection gets
   "wizard not found" (`<openclaw>/dist/server-wizard-sessions-CH5iw7Uu.mjs`
   lines 4-10), and closing the connection cancels it (`wizard-login-aEAlt0K2.mjs`
   lines 26-27). So a login cannot survive a reconnect.
6. Finished: the credential is saved into the agent's store and the gateway
   refreshes its auth state. A result that saved credentials but could not
   confirm activation ends as an error with a recovery message
   (`models-auth-login-DleMUtMB.mjs` lines 119-120).

**Lower-scope paths checked.** Method names containing `auth`, `login`,
`account`, `oauth`, `credential` or `secret` in `CORE_GATEWAY_METHOD_SPECS`
were listed:

- `users.authConnect.start|answer|status|cancel|catalog` are `operator.write`
  (lines 739-763). They sign in **personal** accounts for the verified person
  on the connection, who must have a user profile
  (`<openclaw>/dist/users-model-account-access-a2ev1nH-.mjs` lines 18-22).
  Status is `pending` with a step, `connected {authProfileId, links}`,
  `cancelled`, `expired` or `failed {reason}` (`<protocol>`
  `UsersAuthConnectStatusResult`). Clawtrate's paired device was given the
  `gateway-owner` profile (`users.self`, **[probe]**), so this path may be open
  to it. `users.authConnect.*` itself was **not called**: it needs a real
  provider. These accounts are chosen per chat or as the person's
  new-session default (`users.selectModelAccount`, `operator.write`), not per
  bot. Anthropic personal setup takes an API key, not a subscription
  (`<openclaw>/docs/cli/models.md`, "Personal model accounts").
- `openclaw.setup.auth.start` is `operator.admin` (line 401), the system
  agent's own setup.
- `mcp.authLogin`, `tools.github.authorize.*`, `users.github.authorize.*`
  and `web.login.*` sign in other things.

No non-admin method that starts a shared or per-bot provider sign-in was
found.

**What a plugin would need to offer start and status at `operator.write`**
**[source for the entry points, inferred for the design]**:

- the plugin SDK exports the gateway's login runner,
  `runModelsAuthLoginFlow`, and `runProviderChannelLoginFlow`
  (`<openclaw>/dist/plugin-sdk/provider-auth-login-flow-runtime.js`);
- `dispatchGatewayMethod` (`plugin-sdk/gateway-method-runtime.d.ts`) dispatches
  "from an authenticated plugin request scope", that is with the caller's own
  authority, so wrapping `models.authLogin` would still need admin;
- so the plugin would have to run the flow itself under its own authority and
  return only steps, codes and links. Whether a plugin method registered at
  `operator.write` may write credentials is **not established**. The
  credential never has to leave the gateway on the device-code path; the
  browser path still needs either the paste step or a gateway-hosted callback.

### A.3 Two accounts of the same provider

- **Supported by the store**: several profile ids per provider can coexist
  (`<openclaw>/docs/concepts/oauth.md`, "Advanced: multiple profiles in one
  agent"). Two OAuth sign-ins get two ids when the provider reports different
  emails; a re-login keeps an id only when the provider's identity matcher
  proves the same account (`<openclaw>/docs/auth-credential-semantics.md`,
  "Config-only auth routes", last paragraph). **[source]**
- **Naming**: the id is the only name. The CLI can choose one
  (`models auth login --profile-id openai:work`, `paste-api-key --profile-id`;
  `<openclaw>/docs/cli/models.md`). No gateway method takes a profile id:
  `SystemAgentSetupAuthStartParams` and `ModelsAuthSetApiKeyParams` have none,
  and `saveModelProviderApiKey` is called without one
  (`<openclaw>/dist/models-auth-status-DDLxf-39.mjs`, the `models.authSetApiKey`
  handler, lines 338-362). `displayName` and `email` come from the provider and
  are returned only to admin connections (same file, lines 431, 530-534).
  No user-set label exists: searched `<protocol>` definitions for `label` on
  auth profiles, found only `UserModelAccount.label` (personal accounts).
  **[source]**
- **Through gateway methods, a second API key for the same provider is not
  possible**: `models.authSetApiKey` replaces the configured or active key, or
  creates `<provider>:manual` (`auth-api-key-B25pB09w.mjs` lines 64-81). In the
  probe, two calls with different `agentId`s both returned `acct-x:manual`, and
  both bots then sent the second key. **[source, probe]**

### A.4 Binding a bot to an account

- **Per-bot settings that exist** (`config.schema.lookup "agents.entries.*"`,
  **[probe]**): `model`, `models`, `modelPolicy.allow`, `agentDir`, `tools`,
  `skills` and others. There is no `auth` key under `agents.entries.*` ("config
  schema path not found", **[probe]**); `auth` exists only at the root, with
  `profiles` and `order`.
- **What a bot is actually bound to**: its provider, through
  `agents.update {agentId, model}` (`operator.admin`, line 863). Within the
  provider the gateway picks a profile in this order: the bot's stored order,
  then `auth.order.<provider>` (global), then configured profiles, then stored
  profiles, round-robin by type (OAuth, then token, then API key) and by least
  recent use, with failed profiles moved last (`<openclaw>/docs/concepts/model-failover.md`,
  "Rotation order"). The pick is pinned per session until reset or failure.
  **[source]**
- **`models.authOrderSet {provider, profileIds, agentId}`** (`operator.admin`,
  line 2682) writes the bot's stored order. It refuses an order that does not
  list every available profile ("profileIds must include every available
  profile"), an order when `auth.order` config controls it, and any order when
  the provider config binds a profile ("controlled by provider configuration")
  (`<openclaw>/dist/models-auth-order-ReW5cT_z.mjs` lines 45-66; the last one
  **[probe]**). So it reorders accounts; it cannot exclude one.
- **Exclusion that does exist**: `auth.order.<provider>` in config. A stored
  profile left out of it "is not silently tried later"
  (`<openclaw>/docs/auth-credential-semantics.md`, "Explicit auth order
  filtering"). It is global, not per bot. **[source]**
- **Per conversation**: `/model <model>@<profileId> -s` sets a user pin
  (`<openclaw>/docs/concepts/model-failover.md`, "Session stickiness"). A pin is
  a preference, not a fence: while it is in cooldown "OpenClaw tries the next
  eligible same-provider profile". No session field for an auth profile was
  found in `<protocol>` (searched every definition for property names matching
  `authProfile|accountSelection|modelAccount|authOrder`; hits were only
  `models.list`, `chat.metadata`, plugin grants and `users.*`).
  `sessions.patch` has none. **[source]**
- **When a change takes effect.** `agents.update {model}` during a run: the
  run finished on the old provider and the next run used the new one, with no
  line in the conversation's history marking the change (**[probe]**: history
  was user, assistant on `acct-a`, user, assistant on `acct-b`). For
  `sessions.patch {model}` the docs describe a "pending live switch" that the
  active run may adopt in the same turn (`model-failover.md`, "Session overrides
  and live model switching"). **[source]**
- **A bot whose account is removed.** `models.authLogout {provider, agentId}`
  (`operator.admin`, line 557) without `profileIds` aborts that bot's runs on
  the provider with `stopReason:"auth-revoked"` (`models-auth-status-DDLxf-39.mjs`
  lines 406-418). For a configured provider, the profile lived in the shared
  store, so logging out "for" one bot removed it for both bots on that
  provider. The provider's `apiKey` binding was cleared, and both bots' next
  runs were sent with no `Authorization` header. The scripted server accepted
  them; a real provider would refuse them as unauthenticated. **[probe]**
  The docs add that removing a saved credential clears model and conversation
  account selections that named it (`model-failover.md`, "Session
  stickiness"). **[source]**

### A.5 Listing accounts and their state

`models.authStatus {agentId?, refresh?}` (`operator.read`) returns `{ts,
providers:[…], providerCapabilities:[…]}`
(`<openclaw>/dist/models-auth-status-DDLxf-39.mjs` lines 428-557):

- per provider: `provider`, `authProvider`, `displayName`, `status`, `expiry
  {at, remainingMs, label}`, `profiles[]`, `profileOrder?`,
  `profileOrderLocked?: "provider-config"|"auth-config"`, `apiKey?: {source:
  "env"|"config", envVar?}`, `usage?` (quota windows, plan, billing);
- per profile: `profileId`, `type`, `status`, `reasonCode`, `source:
  config|external|saved|inherited`, `expiry`, `externallyManaged?`,
  `logoutSupported?`, and only for admin connections `displayName`, `email`,
  `lastUsedAt`;
- `status` values are `expired`, `missing`, `expiring`, `ok` and `static`
  (lines 287-295). Reason codes include `expired`, `missing_credential`,
  `invalid_expires`, `unresolved_ref`, `ineligible_profile` and
  `excluded_by_auth_order` (`<openclaw>/docs/auth-credential-semantics.md`,
  table at the top).

Seen **[probe]**: config keys show as `{status:"static", apiKey:{source:
"config"}, profiles:[]}`; a key saved through `models.authSetApiKey` shows as a
profile `{profileId:"acct-x:manual", type:"api_key", status:"static",
source:"config", logoutSupported:true}`; no secret appears. Every bot saw the
same list. A billing disable did **not** appear: after a 402 the provider
still read `static` while its runs were refused. So `authStatus` does not
report "out of quota" for an API key. Whether it reports cooldowns for OAuth
profiles was not observed.

Which bots use which account: **not reported**. Searched `<protocol>` and the
`models.authStatus` handler for any agent list; there is none. A client can
derive "bots on provider P" from `agents.list` `model` **[inferred]**, not
"bots on profile X".

### A.6 Models per account

- `models.list {agentId?, sessionKey?, authProfileId?, provider?, view?,
  includeDetails?, …}` (`operator.read`, line 539; `<protocol>`
  `ModelsListParams`). `authProfileId` selects a **personal** account
  (`preparePersonalModelAccountSelection`, `<openclaw>/dist/models-qLzDNS0G.mjs`
  lines 30-31), not a shared or bot profile. **[source]**
- `models.list {agentId}` listed every configured provider's models for every
  bot, all `available:true`, with `accountSelection: {kind:"automatic"}`
  **[probe]**. So there is no per-account filter for shared accounts; a
  `provider` filter exists.
- Account-dependent catalogs exist for some providers: xAI's OAuth catalog
  differs from its API catalog ("OAuth-only models stay unavailable" without
  it, `<openclaw>/docs/providers/xai.md` line 127), and OpenAI ships
  `extensions/openai/account-models.js`. The gateway folds them into the
  provider's list. **[source, not probed]**
- `agents.entries.<id>.modelPolicy.allow` limits which models a bot may be
  switched to ("Per-agent model override policy", **[probe]** schema hint).

### A.7 Out of quota, signed out, expired; automatic fallback

Observed on a bot whose model is a plain string (no fallbacks of its own)
**[probe]**:

| Scripted response | `chat` `state:"error"` | `errorKind` | `errorDetail` |
| --- | --- | --- | --- |
| 401 `authentication_error` | `errorMessage` "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`." | absent | `{provider, model, failoverReason:"auth", providerRuntimeFailureKind:"auth_invalid_token"}` |
| 402 `insufficient_quota` | "⚠️ acct-a (dev-1) returned a billing error — check your account's balance and usage limits before trying again." | `"rate_limit"` | `{provider, model, failoverReason:"billing", providerRuntimeFailureKind:"unclassified"}` |
| any, within 10 min of that 402 | "Inline API key for provider \"acct-a\" is temporarily disabled after a provider auth/billing failure. Retry after about 10 minutes, or switch to a different auth profile/API key." | absent | absent |

- The `agent` `lifecycle` stream carried the same `errorObservation`, then
  `phase:"fallback_step"` with `fallbackStepFromModel`,
  `fallbackStepFromFailureReason`, `fallbackStepFromFailureDetail` (the
  provider's status and message), `fallbackStepChainPosition` and
  `fallbackStepFinalOutcome:"chain_exhausted"`, then `phase:"error"`. The source
  is `<openclaw>/dist/agent-harness-attempt-runtime-C3Sh4Ev7.mjs` lines 155-180.
- `errorKind` has no `auth` or `billing` value (`<protocol>` `ChatErrorEvent`:
  refusal, timeout, rate_limit, context_length, state_contention, unknown). Use
  `errorDetail.failoverReason`. The documented reasons include `auth`,
  `auth_permanent`, `billing`, `rate_limit`, `overloaded`, `timeout`,
  `model_not_found`, `format`, `session_expired` and `server_error`
  (`model-failover.md`, "Observability"). No account id appears.
- The 402 disabled the config key for every bot using that provider, for about
  ten minutes (`model-failover.md`, "Billing disables"; **[probe]**).

**Every automatic move the gateway makes by itself** (all **[source]**, from
`<openclaw>/docs/concepts/model-failover.md` unless noted):

1. Same-model retries for rate limits (up to 10 attempts) and transient errors,
   shown as `chat` `state:"status"` with `retry {attempt, maxAttempts,
   reason:"rate_limit"}` (`<protocol>` `ChatEvent`).
2. **Auth-profile rotation within the provider** on auth, rate-limit, billing
   and timeout failures, also past a user pin. A profile is excluded only by
   `auth.order` config (A.4).
3. **Model fallback across providers** along the chain: the bot's own
   `model.fallbacks`, or `agents.defaults.model.fallbacks` for a bot without a
   model of its own. A bot whose `agents.entries.<id>.model` is set without
   `fallbacks` is strict ("Selection source policy"). Observed **[probe]**: a
   bot with `{primary:"acct-b/dev-1", fallbacks:["acct-x/dev-1"]}` sent the
   failed turn to `acct-x` in the same run; the event was `fallback_step`
   `{fallbackStepFromModel:"acct-b/dev-1", fallbackStepToModel:"acct-x/dev-1",
   fallbackStepFinalOutcome:"next_fallback"}`. A fallback that succeeds also
   posts "↪️ Model Fallback: …" into one-to-one conversations ("User-visible
   fallback notices").
4. Automatic cyber-policy escalation to `openai/gpt-daybreak-blue-latest` for
   OpenAI refusals, configured by
   `agents.defaults.embeddedAgent.cyberFailover.mode` (`auto` or `off`)
   ("Automatic cyber-policy escalation").
5. Anthropic direct API-key refusal fallback inside the request (referenced
   from "Which errors advance fallback").

Configuration that switches these off: `fallbacks: []` per bot, a strict
`model` per bot, `auth.order.<provider>` listing one profile (global),
`cyberFailover.mode: "off"`. Whether a session user pin plus a one-profile
`auth.order` prevents rotation entirely was not probed.

### A.8 API keys: entry and read-back

- Entry: `models.authSetApiKey {provider, apiKey, agentId?}` (`operator.admin`,
  line 2816) returns `{provider, profileId, warning?}`. Where it lands
  (`auth-api-key-B25pB09w.mjs` lines 64-129): if `models.providers.<provider>`
  exists, the key goes to the **shared** store (`agentDir` undefined) and the
  provider's `apiKey` becomes the profile id; otherwise it goes to the named
  bot's own store. It also writes `auth.profiles.<id> {provider,
  mode:"api_key"}`. **[source; shared case probe]**
- Read-back: `config.get` (`operator.read`) shows `apiKey` as
  `__OPENCLAW_REDACTED__` **[probe]**. `models.authStatus` shows the source, not
  the key **[probe]**. No method returning an auth-profile key was found
  (searched `<protocol>` result definitions under `models.*` and `users.*`).
- Secret store: `secrets.store.set {name, value, kind: secret|env,
  allowedHosts?}` and `secrets.store.list` are `operator.admin` (lines 2415,
  2409). `SecretsStoreListResult` returns `value` for `kind:"env"` entries and
  omits it for `kind:"secret"` (`<protocol>`). So an `env` entry can be read
  back by an admin connection. This store is separate from auth profiles.
  **[source]**

### A.9 Does a turn record its account

No. Observed fields **[probe]**:

- `chat.history` assistant row: `role, content, api, provider, model, usage,
  stopReason, timestamp, responseId, __openclaw {runId, id, recordTimestampMs,
  transcriptPosition, seq}`;
- `lifecycle phase:"model"`: `{provider, model}`;
- `terminalReceipt`: `requested {provider, model}`, `effective {provider,
  model, responseModel}`, `rerouted`;
- `sessions.list` row: `modelProvider`, `model`, `modelOverrideSource`.

`authProfileOverride` is a stored session field
(`<openclaw>/docs/reference/session-management-compaction/schema.md`) but it was
not among the `sessions.list` fields. **[source, probe]**

### A.10 Tools that come with a provider; xAI

- **Yes, providers bring tools.** A provider plugin's manifest declares
  `contracts.tools`. The xAI plugin (`<openclaw>/dist/extensions/xai/openclaw.plugin.json`)
  declares `x_search` and `code_execution`, plus a web-search provider `grok`,
  speech, transcription, realtime voice, image and video. **[source]**
- **When `x_search` reaches a bot**: "With each tool's `enabled` setting
  omitted, OpenClaw exposes it only for an active xAI model. A known non-xAI
  model provider requires an explicit per-tool `enabled: true`"; xAI auth is
  required, and xAI bills $5 per 1,000 calls plus tokens
  (`<openclaw>/docs/providers/xai.md`, Warning under "Features"; manifest
  `uiHints."xSearch.enabled"`). Settings live under
  `plugins.entries.xai.config.xSearch.*` (`enabled`, `model`, `baseUrl`,
  `inlineCitations`, `maxTurns`, `timeoutSeconds`, `cacheTtlMinutes`). The same
  xAI credential (OAuth or API key) powers them. **[source]**
- **What a client sees**: the tools would appear in `tools.effective
  {sessionKey}` and `tools.catalog` with their plugin source **[inferred]**; not
  observed, because the development gateway has no xAI provider.
- **xAI summary**: sign-in kinds `xai-oauth` (device code, subscription) and
  `xai-api-key`; models in the manifest catalog `grok-4.7`, `grok-4.6`,
  `grok-4.5`, `grok-build-0.1`, `grok-4.3`, `grok-4.20-0309-reasoning`,
  `grok-4.20-0309-non-reasoning` (multi-agent models suppressed); OAuth routes
  through `https://cli-chat-proxy.grok.com/v1` and API keys through
  `https://api.x.ai/v1` (`providerEndpoints`). SuperGrok quota shows in
  provider usage for OAuth (`xai.md` lines 86-94). **[source]**

### A.11 Probe and the fixture the tests will use

Scripts: `docs/research/dev-gateway/provider-accounts/probe.mjs` and
`recording-model.mjs`. The probe refuses anything but a named instance this
checkout started (see its header), starts three recording model servers on the
instance's scripted-model port + 1, + 2 and + 3, and stops them by PID.

```bash
pnpm dev-gateway start --instance <name> --no-seed
CLAWTRATE_DEV_INSTANCE=<name> node docs/research/dev-gateway/provider-accounts/probe.mjs
pnpm dev-gateway reset --instance <name>
```

**Fixture config** (applied with `config.patch` on top of the tool's own
config; `P` is the instance's scripted-model port):

```json
{
  "models": {
    "providers": {
      "acct-a": { "baseUrl": "http://127.0.0.1:<P+1>/v1", "api": "openai-completions", "apiKey": "scripted-key-a",
                  "models": [{ "id": "dev-1", "name": "Scripted dev model", "reasoning": false, "input": ["text"],
                               "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                               "contextWindow": 128000, "maxTokens": 8192 }] },
      "acct-b": { "baseUrl": "http://127.0.0.1:<P+2>/v1", "api": "openai-completions", "apiKey": "scripted-key-b", "models": ["…as acct-a"] },
      "acct-x": { "baseUrl": "http://127.0.0.1:<P+3>/v1", "api": "openai-completions", "models": ["…as acct-a"] }
    }
  }
}
```

Bots: `agents.create {name, workspace, model:"acct-a/dev-1"}` and so on. Each
recording server logs `{label, port, auth, model, marker, serverTools}` per
request; a prompt containing `FAIL401`, `FAIL402` or `SLOW` gets a 401, a 402
or a four-second delay.

Results **[probe]**:

| Bot | Model | Reached | Key sent |
| --- | --- | --- | --- |
| `main` | `scripted/dev-1` | the tool's scripted model | (not recorded) |
| `probe-a` | `acct-a/dev-1` | `acct-a` | `scripted-key-a` |
| `probe-b` | `acct-b/dev-1` | `acct-b` | `scripted-key-b` |
| `probe-x1` | `acct-x/dev-1`, key x1 set with `agentId: probe-x1` | `acct-x` | `scripted-key-x2` |
| `probe-x2` | `acct-x/dev-1`, key x2 set with `agentId: probe-x2` | `acct-x` | `scripted-key-x2` |
| `probe-x1`, `probe-x2` after `models.authLogout {provider:"acct-x", agentId:"probe-x2"}` | | `acct-x` | none |

**What this means for the fixture.** "One provider entry per account" is the
binding the stock gateway honours, and it is what tests can rely on: a bot
created on `acct-b` sends its run to `acct-b`'s port, never `acct-a`'s. That
is F-472's check. Two accounts of the *same* provider cannot be emulated with
config-defined scripted providers: the provider entry binds one profile, the
order is then locked, and per-bot keys collapse into one shared key. Emulating
that case needs a provider without a `models.providers` entry, that is a
provider plugin. The development gateway's `models.mode: "replace"` has none.
**[source, probe]**

### A.12 What needs a plugin

| Need | Stock gateway | Plugin would need |
| --- | --- | --- |
| Bind a bot to one account and never another | Not available: binding is per provider; `authOrderSet` cannot exclude; rotation and fallback move runs | A per-bot account record, plus enforcement: either a provider per account (generated `models.providers` entries, as in the fixture) or a `before_model_resolve`-style guard. Which hook exists for this was not established |
| A user-set label per account | No label field | Plugin-owned metadata keyed by profile id or provider id |
| Which bots use an account | Not reported | Derive from the plugin's own binding record |
| Turn names its account | Not recorded | A plugin event or session metadata written at run start (hook not established) |
| Sign-in below admin | Only personal accounts (`users.authConnect.*`, `operator.write`) | A plugin method running `runModelsAuthLoginFlow` itself (A.2) |
| No automatic fallback, including bots created later | `fallbacks: []` and strict models per bot; `agents.defaults` for new bots; `cyberFailover.mode:"off"` | Nothing, if Clawtrate writes these at `operator.admin` and checks them |

---

## Part B. T3 Code

### B.1 What T3 Code offers an outside agent

**Established.** T3 Code's server exposes its tools as an MCP server over
Streamable HTTP at the path `/mcp` on the same address as the app
(`layerMcpTransport`: `name:"T3 Code"`, `path:"/mcp"`, protocol `2025-06-18`,
`<t3>/server` lines 49846-49854). The public docs say the same and add the
setup steps: "Copy MCP URL" in Settings, then for example `claude mcp add
--transport http t3 <url>` and `claude mcp login t3`
(`t3code` `docs/user/outside-agents.md`). PR #15220 in that repository added
this "narrow MCP OAuth authorization server … in front of the existing /mcp".
**[source]**

**Authentication** **[source]**:

- Every request needs `Authorization: Bearer <token>`. Otherwise the answer is
  401 `{"error":"invalid_mcp_credential"}` with a `WWW-Authenticate` that
  points to `/.well-known/oauth-protected-resource/mcp` (`<t3>/server` lines
  49246-49261, 49306-49339).
- An outside agent gets its token by OAuth 2.1: authorization code with PKCE
  `S256`, public clients (`token_endpoint_auth_methods_supported: ["none"]`),
  dynamic client registration at `/oauth/mcp/register`, authorize at
  `/oauth/mcp/authorize`, token at `/oauth/mcp/token` (`<t3>/server` lines
  51560-51578; `<t3>/runtime` line 24079). Only the `authorization_code` grant
  exists, with no refresh token (`exchangeCode`, `<t3>/server` lines
  51779-51811). Redirect URIs must be `https` or loopback `http`
  (`parseRedirect`, lines 51579-51586).
- The person approves on the environment's `/connect-agent` page, either in a
  signed-in browser session or by typing a pairing code such as
  `AUTO-Q8RZ3NWD5KTC`. A code "works once, for 5 minutes, and approves only that
  level" (`<t3>/runtime` lines 9984-9998; `outside-agents.md`).
- The session lasts **30 days** (`MCP_CLIENT_SESSION_TTL = days(30)`,
  `apps/server/dist/relayTracing-UAIExpj4.mjs` line 7163; the docs say "A
  sign-in lasts 30 days"). It can be revoked in Settings → Sharing & access.
- Credentials are sent only "over `https` or to `localhost`"; a plain-http LAN
  address "lets an agent find the environment but not finish signing in"
  (`outside-agents.md`).
- "Agents without OAuth support cannot connect." No static token for outside
  agents was found: the other credential the middleware accepts is the
  in-memory token T3 Code gives agents it launched itself
  (`McpSessionRegistry`, `<t3>/server` line 49313).

**What a caller can be limited to** **[source]**:

- Access levels, chosen at approval: `read-only`, `approval-required`,
  `auto-accept-edits`, `auto`, `full-access` (`AuthMcpClientAccess`,
  `<t3>/runtime` lines 9976-9982). `read-only` can read projects, threads,
  providers and models; the others may also start, message and stop threads,
  and threads they start cannot run above that level
  (`resolveRuntimeMode`, `<t3>/server` lines 43591-43605). Write tools refuse a
  read-only client with `capability_denied` (lines 44006-44009). Changing
  projects or settings needs full access (line 44072).
- A request may narrow itself further with the header
  `t3-mode-limit: <runtimeMode>/<interactionMode>`, for example `auto/default`
  (`MODE_LIMIT_HEADER`, `<t3>` `apps/server/dist/runtimeLayer-D81jNfD9.mjs` line
  133276; `<t3>/server` lines 49276-49297).
- An outside client has the capabilities `orchestration`, `worktree` and
  `pull-requests`, and no calling thread (`layerMcpClientAuthenticator`,
  `<t3>/server` lines 51828-51853). Tools that need a calling thread
  (`create_threads`, `delegate_task`, previews, devices, secrets, HTML render)
  return an error to it (`outside-agents.md`).
- No per-client project allowlist or provider allowlist was found. Searched
  `<t3>/server` for limits on the client session: the session carries `label`,
  `access` and `peerLink` only (`issueMcpClientSession`, lines 51799-51804).
  Project and provider limits have to be enforced on the gateway side.

**Also present, not an outside-agent interface for a gateway on another
machine**: a host command-line tool, `t3 thread list|start|send|show`
("Start, message, and read threads on the running server."), which works on
the host with no sign-in (`<t3>` `apps/server/dist/binCli-BPs4eA-l.mjs` lines
10070-10187; `outside-agents.md`, "Host scripts"). It has no stop command.

### B.2 The six operations

All are MCP tools; failures come back as a result, not a protocol error
(`failureMode: "return"`), with `{code, message}` (`OrchestratorMcpFailure`).
Every tool also takes `environmentId?` for a linked environment; omit it.
Definitions are quoted from `<t3>/server` (tools) and `<t3>/runtime` (schemas).

**List projects: `t3_project_list`** (`<t3>/server` lines 44153-44168;
read-only, not destructive):

```js
parameters: Struct({ environmentId, cursor: optional(NonNegativeInt), limit: optional(Int 1..100) }),
success: Struct({ projects: ArraySchema(Project), nextCursor: NullOr(NonNegativeInt) })
// Project (<t3>/runtime): { id, title, workspaceRoot, repositoryIdentity?, faviconPath?, projectIcon?,
//   defaultModelSelection: ModelSelection|null, defaultThreadEnvMode?, autoPull?, scripts[],
//   pinnedAt?, archivedAt?, createdAt, updatedAt, deletedAt }
```

**Providers and models to choose from: `orchestrator_capabilities`**
(`<t3>/server` line 47408). Input `{environmentId?, search?}`. Result `{…,
runtimeMode, interactionMode, providers:[{providerInstanceId, driverKind,
displayName, models:[{id, label?, options?:[{id, values, default?}]}],
omittedModels?, runtimeModes?, …}], features}` (`<t3>/runtime`,
`OrchestratorMcpCapabilitiesResult`). It is a read tool, so an outside client
can call it **[inferred from `reads(...)`, `<t3>/server` line 47558]**.

**Start a thread: `t3_thread_launch`** (`<t3>/server` lines 44220-44266):

> "Create one new top-level thread, bound to its workspace before the agent
> starts. Task in `message`. Omit `projectId`, model and modes to inherit yours
> (outside a thread, pass `projectId` or `scratch`); modes cannot exceed yours.
> After an error or lost reply, retry with the same `clientRequestId`. Follow it
> with `t3_thread_read` or `t3_thread_wait`. Mention it with its `link`."

```js
parameters: Struct({
  environmentId, projectId: optional(ProjectId), scratch: optional(Boolean),
  title: TrimmedNonEmptyString,
  modelSelection: optional(ModelSelection),        // { instanceId (or provider), model, options? }
  runtimeMode: optional("approval-required"|"auto-accept-edits"|"auto"|"full-access"),
  interactionMode: optional("default"|"plan"),
  workspaceStrategy: optional(
    { type: "root", branch? } |
    { type: "existing_worktree", worktreePath, branch? } |
    { type: "worktree", baseRef, branch?, startFromOrigin? }),
  message: optional(String, max 120000),           // first prompt; omit for an idle thread
  attachments: optional(Array(max 8)),
  clientRequestId: optional(String, max 256),
}),
success: Struct({ threadId, link: optional(String), projectId, modelSelection,
                  runId: NullOr(RunId), status: NullOr(RunStatus) })
```

`RunStatus` is `preparing, queued, starting, running, waiting, completed,
interrupted, failed, cancelled, rolled_back` (`<t3>/runtime` lines 18886-18897).
"Choice of checkout" is `workspaceStrategy`. Without a model or mode, a thread
started from outside gets the project's default model and permission mode
(`t3code` PR notes quoted in search results; not checked in the bundle).

**Follow up: `t3_thread_send`** (`<t3>/server` lines 47515-47522; `<t3>/runtime`
lines 36529-36555):

> "Send a message to any thread. The target cannot run with broader modes than
> yours. `mode:'auto'` starts an idle thread, steers a running turn, or queues.
> `queue`: new turn. `steer`: mid-turn update. `restart`: interrupt and
> restart. …"

```js
input:  { environmentId?, threadId, message (≤120000), mode?: "auto"|"queue"|"steer"|"restart",
          freshContext?: boolean, clientRequestId? }
result: { threadId, link?, messageId, runId, taskId?, status: RunStatus,
          delivery: "started"|"queued"|"steered"|"restarted" }
```

**Read state and result: `t3_thread_read`** (`<t3>/server` line 47501;
`<t3>/runtime` lines 36445-36528):

```js
input:  { environmentId?, threadId, itemId?, textOffset?, view?: "messages"|"activity",
          afterPosition?, limit? (1-100), runLimit? (1-50), maxCharsPerItem? (1-50000) }
result: { thread: { threadId, projectId, title, link?, status: "idle"|RunStatus, latestRunId, activeRunId,
                    providerInstanceId, model, runtimeMode, interactionMode, branch, worktreePath,
                    runCount, itemCount, pendingRequestCount, archived, settled, … },
          recentRuns: [{ runId, ordinal, status, providerInstanceId, model, executedModel?,
                         requestedAt, startedAt, completedAt }],
          items: [{ position, itemId, runId, messageId, type, status, title, text,
                    textTruncated, nextTextOffset?, updatedAt, … }],
          nextPosition: NullOr(int), hasMore: boolean }
```

The result is the last assistant message among `items` with `view:"messages"`
**[inferred from the description "user and assistant messages and plans"]**.

**Wait: `t3_thread_wait`** (`<t3>/runtime` lines 36556-36574):

```js
input:  { environmentId?, threadId, runId?, timeoutMs?, untilDelegatedWorkSettled? }
result: { threadId, runId, status, timedOut: boolean, next?, resultRun?: { runId, status } }
```

**List threads: `t3_thread_list`** (`<t3>/runtime` lines 36389-36444):

```js
input:  { environmentId?, projectId?, allProjects?, statuses?, titleContains?, settled?, snoozed?,
          includeSubagents?, cursor?, limit? (≤100) }
result: { projectId, currentThreadId, threads: [{ threadId, projectId, title, link?, status,
          latestRunId, providerInstanceId, model, runtimeMode, interactionMode, settled,
          parentThreadId, itemCount, createdAt, updatedAt, … }], nextCursor, total }
```

An outside client must pass `projectId` or `allProjects: true`
(`outside-agents.md`; issue #26515).

**Stop: `t3_thread_interrupt`** (`<t3>/runtime` lines 36575-36600):

```js
input:  { environmentId?, threadId, runId?, reason? (≤2000), stop?: boolean, clientRequestId? }
// stop: true acts as the Stop button: interrupts whichever run, holds queued messages,
//   ends pull request watches and stops every task the thread delegated
result: { threadId, runId, status: "interrupt_requested"|"no_active_run"|"completed"|"failed"
          |"cancelled"|"interrupted"|"rolled_back" }
```

### B.3 Identifiers and links

- Ids are opaque strings (`makeEntityId("ThreadId")`, `"ProjectId"`, `"RunId"`,
  `<t3>/runtime` lines 4617-4624). Threads started over MCP get ids of the form
  `mcp:<uuid>` (`<t3>/server` lines 43619-43633).
- Links: inside T3 Code, `t3-thread://v2/<environmentId>/<threadId>`; an outside
  client gets the hosted link instead, `https://app.t3.codes/threads/<environmentId>/<threadId>`,
  which "opens the thread from anywhere: the hosted app offers the desktop app,
  the mobile app, or itself" (`threadLinkFor`, `runtimeLayer` lines 133323-133335;
  `hostedThreadLink`, `<t3>/runtime` lines 90071, 90104-90107; PR #26642). The
  app also registers the URL schemes `t3code` and `t3code-dev` (bundle
  `Info.plist`); no thread path for those schemes was looked up.

### B.4 Learning that a thread has finished

- `t3_thread_wait`: blocks until the run finishes or `timeoutMs` passes, then
  returns `timedOut` and the status. Its description: "Wait for a thread's run
  to finish. No `runId`: latest. Idle: at once. On timeout, with `next` end your
  turn; without, call again."
- Polling with `t3_thread_read` or `t3_thread_list {statuses}`.
- No push to an outside MCP client was found. Searched `<t3>/server` for MCP
  notifications sent to client sessions; none was found. **[source, absence]**
- On the gateway side, an MCP call has a request timeout of 60 s by default
  (`mcp.servers.<name>.requestTimeoutMs`, `<openclaw>/docs/gateway/config-extensions.md`),
  so a bot should wait in bounded calls (`timeoutMs` below that) and call
  again. **[source, inferred]**

### B.5 The gateway side

- **A tool server**: `mcp.servers.<name>` is global (`config.schema.lookup
  "mcp"`, hint "Global MCP server definitions"). For T3 Code: `{url:
  "<T3 Code address>/mcp", transport: "streamable-http", auth: "oauth",
  requestTimeoutMs?, headers?: {"t3-mode-limit": "auto/default"}}`. Children of
  `mcp.servers.*`: `enabled, command, args, env, cwd, url, transport, headers,
  connectionTimeoutMs, requestTimeoutMs, supportsParallelToolCalls, auth, oauth,
  sslVerify, clientCert, clientKey, toolFilter, codex` (**[probe]**,
  `config.schema.lookup`). Writing it is `config.patch` (`operator.admin`, line
  205). No per-bot key for tool servers exists: `agents.entries.*.mcp` is
  "config schema path not found" **[probe]**. The `codex.agents` list only
  affects the Codex app server.
- **Signing the gateway in to T3 Code**: `mcp.authLogin {sessionId, serverName}`
  is `operator.admin` and refuses a connection without a browser origin: "Open
  Settings on this Gateway to sign in, or use openclaw mcp login in its
  terminal" (`<openclaw>/dist/mcp-auth-login-DAnddU_m.mjs` lines 19, 41-42).
  OpenClaw's MCP OAuth does dynamic client registration and keeps tokens in
  `mcp_oauth_stores` (`<openclaw>/docs/cli/mcp/transports.md` line 93). Whether
  OpenClaw completes T3 Code's OAuth was **not tested**: both are on paper
  compatible (DCR, PKCE, loopback or https redirect), and the rules forbid
  connecting to the running T3 Code.
- **One bot and not the others** **[probe]**: with `mcp.servers.t3stand` set
  (the committed stdio stand-in `fake-coding-mcp.mjs`) and
  `agents.entries.probe-b.tools.deny: ["t3stand__*"]`, the scripted model's
  request for `probe-a` offered `t3stand__list_threads` and
  `t3stand__send_message`, the one for `probe-b` offered neither, and a bot
  created afterwards (`probe-new`) offered both. **So the server reaches every
  bot that does not deny it, including bots created later.** Each policy level
  "can only further restrict, not grant back"
  (`<openclaw>/docs/tools/multi-agent-sandbox-tools.md`, Troubleshooting). Turning
  it on for one bot therefore means a deny on all the others and on every new
  bot, or a global `tools.allow`-style list. `tools.alsoAllow` per bot was
  not tested.
- **A skill for one bot**: `agents.entries.<id>.skills` is an allowlist ("An
  explicit list fully replaces inherited defaults … Set [] for no skills",
  **[probe]** schema hint). Installing a skill is `skills.install {agentId?,
  …}` or `skills.update` (`operator.admin`, lines 1031, 1037); the user's
  library `skills.library.save` and `skills.library.activate {sessionKey}` are
  `operator.write`, the latter per task only. The unreviewed capability-map
  branch lists more; not re-verified here.
- **Rules on arguments and approval for one tool**: the stock gateway has
  allow and deny per tool name per bot (`agents.entries.<id>.tools.{allow,
  alsoAllow, deny}`) and asks only for exec (reviewed map, row 20, "Tool
  permissions and approvals"). Limiting `t3code__t3_thread_launch` to some
  projects or providers, or asking before it, needs a plugin `before_tool_call`
  hook. It receives `event.toolName`, `event.params` and `ctx.agentId`, and can
  return `{block: true, blockReason}` or `{requireApproval: {title, description,
  severity, allowedDecisions, timeoutMs}}` (`<openclaw>/docs/plugins/hooks/tool-policy.md`
  lines 32-82; `<openclaw>/docs/plugins/plugin-permission-requests.md`, "Request
  approval before a tool call"). **[source]**
- **Where a shared setting can live (F-487)**: `users.prefs.get` (`operator.read`)
  and `users.prefs.set` (`operator.write`) store per-person preferences, with a
  `users.prefs.changed {profileId, keys}` event (lines 2429, 2435; `<protocol>`
  `UsersPrefsChangedEvent`). The paired probe device read `{status:"ok",
  entries:{}}` as the `gateway-owner` profile **[probe]**. Whether two devices
  of one person share a profile was not checked.

### B.6 Development stand-in for T3 Code (specification, not built)

A local MCP server that mirrors the six operations so the skill and the cards
can be tested without T3 Code.

- **Transport**: stdio for the development gateway, listed as
  `mcp.servers.t3code {command: <node>, args: [<stand-in>]}`, so it needs no
  OAuth and no port. Tool names reach the model as `t3code__<tool>`, the same
  prefix a real `mcp.servers.t3code` URL server would give. A Streamable HTTP
  mode on a port in the instance's block may be added later to exercise
  `auth`, but it must answer a missing bearer with T3 Code's 401 body.
- **Tools** (names, argument names and result fields exactly as B.2, so
  recorded tool events have T3 Code's shape; `environmentId`, `attachments`,
  `interactionMode` and `freshContext` are accepted and ignored):
  - `t3_project_list {cursor?, limit?}` → `{projects:[{id:"proj-roster",
    title:"Roster", workspaceRoot:"/fixture/roster", defaultModelSelection:
    {instanceId:"codex", model:"gpt-fixture"}, scripts:[], createdAt,
    updatedAt, deletedAt:null}, {id:"proj-site", …}], nextCursor:null}`.
  - `orchestrator_capabilities {search?}` → two providers, `codex` with
    `gpt-fixture` and `claude` with `claude-fixture`, each with `runtimeModes`.
  - `t3_thread_launch {projectId, title, modelSelection?, runtimeMode?,
    workspaceStrategy?, message?, clientRequestId?}` → `{threadId:"mcp:<uuid>",
    link:"https://app.t3.codes/threads/env-fixture/mcp%3A<uuid>", projectId,
    modelSelection, runId, status:"running"}`. An unknown model returns `{code:"invalid_request"}` and a repeated
    `clientRequestId` the same thread. The code T3 Code returns for an unknown
    `projectId` was not looked up, so the stand-in uses `invalid_request` and
    tests must not depend on it. An unknown `threadId` in the other tools
    returns `{code:"thread_not_found"}`, as T3 Code's do.
  - `t3_thread_send {threadId, message, mode?, clientRequestId?}` →
    `{threadId, link, messageId, runId, status:"running", delivery}`, with
    `delivery` `started` for an idle thread and `queued` for a running one.
  - `t3_thread_read {threadId, view?, afterPosition?, limit?, maxCharsPerItem?}`
    → `{thread:{threadId, projectId, title, link, status, latestRunId,
    activeRunId, providerInstanceId, model, runtimeMode, …}, recentRuns, items,
    nextPosition, hasMore}`.
  - `t3_thread_wait {threadId, runId?, timeoutMs?}` → `{threadId, runId,
    status, timedOut}`.
  - `t3_thread_list {projectId?, allProjects?, statuses?, limit?}` → `{projectId,
    currentThreadId:null, threads, nextCursor:null, total}`; without `projectId`
    or `allProjects` it returns `{code:"target_required"}`.
  - `t3_thread_interrupt {threadId, runId?, stop?}` → `{threadId, runId,
    status:"interrupt_requested"}`, or `no_active_run` when idle.
- **Behaviour**: deterministic. A run moves `running` → `completed` after a
  fixed number of `t3_thread_wait` or `t3_thread_read` calls (default 2), and
  its assistant item text is `Done: <first line of the message>`. A message
  containing `FAIL` ends the run `failed`. `t3_thread_wait` with `timeoutMs`
  below the completion point returns `timedOut:true`. State is in memory and
  lost when the server exits.
- **Results as MCP**: `structuredContent` with the result object, plus one text
  content item holding the same JSON, as the existing stand-in does, so
  `result.details.structuredContent` carries it in tool events (capability map
  section 5).
- **Record**: optionally append each call `{tool, arguments}` to a file named
  by an environment variable, for checks such as F-486's "refused before it
  reaches T3 Code".

---

## Rows whose target cannot be true as written (summary)

These are argued in the review file handed to the coordinator; in short:

- **F-476** "a Bot bound to one never runs on the other": the stock gateway
  rotates profiles within a provider and cannot exclude one per bot (A.4, A.7).
- **F-479** "each turn's record includes the account the run used": no record
  names an account (A.9).
- **F-480** "says which account": errors name the provider and model only
  (A.7).
- **F-482** "its access credential, which goes to the gateway's secret store":
  T3 Code has no static credential for outside agents. It uses OAuth with
  30-day sessions, and Clawtrate cannot start the gateway's MCP sign-in (B.1,
  B.5).
- **F-483** "turning it on gives the Bot the T3 Code tools": the tools reach
  every bot that does not deny them, including new ones (B.5).
- **F-475** "the key is sent once to the gateway's secret store": keys go to
  the auth-profile store through `models.authSetApiKey`, not to `secrets.*`
  (A.8).
