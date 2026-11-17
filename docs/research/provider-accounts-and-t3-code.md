# Provider accounts and T3 Code

Research for parity rows F-472 to F-488 and F-138. It answers what OpenClaw
2026.10.6 offers for choosing a provider account per bot, and what T3 Code
offers an agent that it did not start.

## How to read this

Every finding is marked:

- **[source]**: read in the installed package, with the file and line, the
  schema path or the doc page;
- **[probe]**: observed on a named development instance with scripted model
  servers only (`docs/research/dev-gateway/provider-accounts/`, A.11 and
  A.13), on the gateway's embedded runtime;
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
   `wizard.cancel` follow and cancel it. What the person does differs by
   provider: a device code for xAI, GitHub Copilot, MiniMax and one OpenAI
   method; a pasted code or redirect URL for OpenAI's browser method and, from
   a connection without a qualifying browser origin, OpenRouter; a
   `localhost:8080` callback on the gateway host for Sign in with ChatGPT
   (A.1, A.2). `models.authStatus` (`operator.read`) lists accounts, their
   storage type and state, and the sign-in methods each provider offers,
   without secrets; a profile id can still contain an email. The storage type
   (`oauth`, `token`, `api_key`) does not say whether an account is a
   subscription. **[source, partly probe]**
2. **A bot can select an account: `<provider>/<model>@<profileId>` on its
   model, and a conversation can select one through `sessions.patch
   {model}`.** Neither is exclusive. A selection is put first in the list of
   candidate accounts, and the gateway moves on to the provider's other
   accounts when it fails or is cooling down. A stored one-profile order for
   the bot removes the others from that list, but only the gateway's command
   line can write it; the gateway method insists on listing every profile
   (A.4). **[source, probe]**
3. **In the probe, a pinned bot with empty fallbacks moved to the other
   account of its provider on a 401, a 402 and a 429, in the same run, and
   stayed there while the first account cooled down. With the stored
   one-profile order it failed with a visible error instead and never used
   the other account** (A.13). Model fallback across providers follows
   `model.fallbacks`; a bot with its own model and `fallbacks: []` never used
   the inherited default fallback. Codex's cyber escalation and Anthropic's
   in-request refusal fallback are separate routes with their own controls
   (A.7). **[probe, source]**
4. **No client-visible record names the account that served a turn.** When
   a run moved accounts, the client saw a failed attempt (`lifecycle`
   `finishing` with an error) and a second start on the same provider and
   model, and nothing naming either account. `chat.metadata`'s
   `accountSelection` is a preference, documented as not a receipt, and lagged
   one run behind. The gateway knows the account internally (A.9). **[probe,
   source]**
5. **Removing an account follows where its credential is stored.** A shared
   profile is removed for every bot that inherits it, its `@profile`
   selections are stripped from bot models, and a bot's own copy survives;
   the run abort reaches only the bot named in the call. A billing failure on
   an inline key paused only the bot whose run failed, not the other bot on
   the same key. **[source, probe]**

What needs a plugin (Part C): a gateway method for the one-profile order, a
guard around it so the binding holds against later changes, a receipt of
the serving account, user-set labels, and sign-in below `operator.admin`.
**Part C, "What Clawtrate should configure", gives the strictest stock
configuration, every remaining route off it with what a client can see, and
the plugin entry points.**

For T3 Code: **its interface for outside agents is established** from the
application bundle and its public documentation. It is a Streamable HTTP MCP
server at `<T3 Code server>/mcp`, signed in with OAuth 2.1 and PKCE, with five
access levels, and 30-day sessions without refresh. The operations an outside
client uses are `t3_project_list`, `orchestrator_capabilities`,
`t3_thread_launch`, `t3_thread_send`, `t3_thread_read`, `t3_thread_wait`,
`t3_thread_list` and `t3_thread_interrupt`; reads are paged from the oldest
item, and a thread's result is selected by run, not taken from the last
message (B.2). The gateway can hold such a server (`mcp.servers.<name>` with
`auth:"oauth"`) and keeps its token; there is no static credential, which
F-482 assumes. The gateway's sign-in for it, `mcp.authLogin`, needs an admin
connection with a browser origin. Clawtrate's present connection has none, but
a desktop connection in `webchat` mode with a qualifying `https` origin could
start it without a plugin (B.5, C.4; not exercised).

---

## Part A. Provider accounts

### A.1 How the gateway represents a provider account

- **Provider**: a model provider id such as `openai`, `xai`, `anthropic`,
  or a custom entry under `models.providers.<id>` (`{baseUrl, api, apiKey?,
  auth?, models[]}`). Bundled providers come from provider plugins, each with
  an `openclaw.plugin.json` manifest under `<openclaw>/dist/extensions/<id>/`.
  **[source]**
- **Account = auth profile.** A profile has an id, a provider and a credential
  of one of three storage types (`<openclaw>/docs/concepts/model-failover.md`,
  "Auth storage" and "Profile IDs"):
  - `api_key`: `{provider, key}`;
  - `oauth`: `{provider, access, refresh, expires, email?}`;
  - `token`: a static bearer token, optionally expiring, never refreshed (for
    example Anthropic's pasted `setup-token`).

  The type says how the credential is stored and sent, not how the account is
  billed. A browser sign-in can save an `api_key` (OpenRouter's, below), a
  device sign-in can save a `token` (GitHub Copilot's), and an `oauth` profile
  says nothing about which plan the account is on. **[source]**

  Profile ids: `provider:<email>` for an OAuth sign-in that reports an email,
  `provider:default` without one, `provider:manual` for a pasted API key or
  token (`<openclaw>/dist/auth-api-key-B25pB09w.mjs` line 22), and any id the
  gateway's command line is given with `--profile-id` (A.3). Some providers fix
  the id: OpenRouter's browser sign-in always writes `openrouter:default`
  (`<openclaw>/dist/oauth-DxQ3VOHT.mjs` line 26). An id can contain an email
  address, so it is identity data even where `email` is withheld. **[source]**
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
- **Subscription versus API key**: not reported by the gateway as such. The
  profile `type` from `models.authStatus` (A.5) is the storage type above, and
  a client cannot read billing from it. What a client can know is which
  sign-in method created the account, if Clawtrate started it, and the
  provider-reported `usage` block where a provider fills it (A.5). So
  "subscription" in Clawtrate's interface has to come from the sign-in choice,
  per provider, as in the table below; an `oauth` or `token` type alone does
  not prove it, and `api_key` does not disprove it (OpenRouter). **[source; inferred for the client rule]**
- **Which providers offer a sign-in that the gateway can start.** A
  provider's manifest declares `providerAuthChoices`; the gateway can start a
  choice only when it is eligible, has `credentialOnly: true` and declares
  `appGuidedAuth` (`isProviderLoginChoiceStartable`,
  `<openclaw>/dist/provider-login-options-7Qv-pZM6.mjs` lines 4-13; normalizer
  `<openclaw>/dist/provider-auth-choices-H3xp2DOU.mjs` lines 87-158). The
  `authChoice` to pass is `<pluginId>/<choiceId>` (same first file, lines
  38-39). Searching every bundled `dist/extensions/*/openclaw.plugin.json`
  gives exactly these startable choices; the flow column is what each
  provider's own code does when the gateway runs it with `isRemote: true`
  **[source]**:

  | `authChoice` | What the person does | What is saved | Source |
  | --- | --- | --- | --- |
  | `openai/openai` | Opens a link; then pastes the code or the full redirect URL back as a `sensitive` text step. The provider uses its own VPS-aware helper, not the gateway callback. | `oauth` (ChatGPT/Codex) | `openai-chatgpt-provider-I6SwdpfN.mjs` 299-313; `openai-chatgpt-oauth.runtime-CG-ODLf5.mjs` 111-139; `provider-oauth-flow-DL7WaUgl.mjs` 8-35 |
  | `openai/openai-device-code` | Opens a link and enters the shown code; the gateway polls. No paste. | `oauth` | `openai-chatgpt-provider-I6SwdpfN.mjs` 315-340; `extensions/openai/openai-chatgpt-device-code.js` 221-232 |
  | `openai/openai-token-sharing` (method `siwc`) | Opens a link whose callback is `localhost:8080` **on the gateway host**; the gateway binds that port and waits. A remote person must forward the port (the step says `ssh -N -L 8080:127.0.0.1:8080 …`). No paste fallback, no gateway-origin callback. | `oauth` | `extensions/openai/token-sharing-oauth.runtime.js` 764-826; `openai-provider-DfpBTN6H.mjs` 434-442 |
  | `xai/xai-oauth` | Opens a link and enters the shown code; the gateway polls. xAI decides eligibility (SuperGrok or X Premium, `docs/providers/xai.md` 8-16). | `oauth`, canonical provider `xai` | `extensions/xai/xai-oauth.js` 322-383 |
  | `github-copilot/github-copilot` | Opens a link and enters the shown code. | `token` | `login-CsOrnwoy.mjs` 142-175; `extensions/github-copilot/index.js` 28-43 |
  | `github-copilot/github-copilot-enterprise` | First a text step for the GitHub Enterprise domain (unless `COPILOT_GITHUB_DOMAIN` is set), then the device code. | `token` | `extensions/github-copilot/index.js` 208-235 |
  | `minimax/minimax-global-oauth`, `minimax/minimax-cn-oauth` | Opens a region-specific link and enters the shown code; the gateway polls. | `oauth`, provider `minimax-portal` | `oauth-CcEmKbWJ.mjs` 235-264 |
  | `openrouter/openrouter-oauth` | Opens a link. If the connection qualifies for the gateway's own callback (A.2 step 4), the redirect lands on the gateway; otherwise the person pastes the full redirect URL. | `api_key` at the fixed id `openrouter:default`; not a refreshable credential and not a sign of a plan | `oauth-DxQ3VOHT.mjs` 128-165, 228-243 |

  (`<openclaw>/dist/` prefixes omitted.) Not startable through the gateway,
  CLI or setup only: Anthropic's Claude CLI reuse (`anthropic-cli`),
  `setup-token` and API key (their declarations lack `credentialOnly: true`;
  `appGuidedSecret: true` alone does not make one startable,
  `extensions/anthropic/openclaw.plugin.json` lines 858-902), Microsoft
  Foundry Entra ID, local servers (Ollama, LM Studio, vLLM, SGLang), and the
  manual-only `xai/xai-device-code` alias (`xai-oauth-entry-Cf0zvn9x.mjs`
  lines 27-43). API keys go through `models.authSetApiKey` (A.8).
- **xAI's sign-in is a device code, never a localhost callback**
  (`<openclaw>/docs/providers/xai.md`, "OAuth troubleshooting"). **[source]**

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
   value}}`. The steps each provider sends were read in its source (A.1
   table) but **not observed**: that needs a real provider. The step schema
   alone does not tell a client what a provider will ask.
4. What a browser sign-in asks of the client depends on the provider, not on
   a generic rule (A.1 table). The gateway runs every flow with `isRemote:
   true` (`models-auth-login-DleMUtMB.mjs` line 86). It can offer a callback on
   its own `/oauth/provider/callback`, passed to the provider as
   `ctx.oauth.authorize`, only when the connection has a browser origin that
   is the gateway host over `https` (or loopback `http` from a local client)
   or its published Tailscale origin
   (`<openclaw>/dist/provider-browser-auth-BOjjbaDz.mjs` lines 10, 21-31,
   50-81). Of the startable providers, only OpenRouter's flow uses that
   callback (`oauth-DxQ3VOHT.mjs` lines 143-148). Without it, OpenRouter and
   `openai/openai` ask for the code or redirect URL to be pasted as a
   `sensitive` text step (`provider-oauth-flow-DL7WaUgl.mjs` lines 8-35), and
   that one-time authorization code would pass through Clawtrate's client on
   its way to the gateway (in transit only: the access and refresh
   credentials are exchanged and stored on the gateway). Sign in with ChatGPT
   asks for neither: it needs the person's browser to reach `localhost:8080`
   on the gateway host. The device-code flows show a code and a link and the
   gateway polls; GitHub Copilot Enterprise asks a text question first.
   **[source]**

   Whether a connection has a browser origin is decided from the transport
   and the client's declared identity, not by proving that a browser is on the
   other end. `resolveGatewayWsBrowserOrigin`
   (`<openclaw>/dist/ws-origin-policy-sYiBryoo.mjs` lines 147-155) records the
   request's `Origin`, host and locality when the client is the Control UI,
   the browser copilot, or a client in `webchat` mode (or `webchat-ui` id)
   (`<openclaw>/dist/message-channel-nDZNINlh.mjs` lines 24-35), or when
   origin checks are enforced for every client; the handshake passes it
   through at `<openclaw>/dist/message-handler-CRCo2VX0.mjs` lines 3583-3588.
   Clawtrate's Node host today connects as client `gateway-client` in `ui`
   mode with `new WebSocket(url)` and no `Origin`
   (`packages/core/src/node/index.ts` line 124), so it has no browser origin
   and would get the paste path. A desktop connection in `webchat` mode that
   sends an `https` `Origin` equal to the gateway host it connects to (or the
   gateway's published origin), on a paired device with `operator.admin`, has
   a source-supported route to the gateway callback. Adding an `Origin` header
   to the present `ui` client alone is not enough: origin policy only governs
   the client kinds above. This route was **not exercised** end to end, and
   the gateway's origin admission may also require approval for that
   connection. **[source; inferred for Clawtrate]**
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
  `<openclaw>/docs/cli/models.md`). Observed **[probe, A.13]**:
  `openclaw models auth paste-api-key --provider acct --profile-id acct:one`
  (key on stdin), then the same with `acct:two`, saved two `api_key` profiles
  of one configured provider, wrote `auth.profiles.acct:one` and
  `auth.profiles.acct:two` `{provider:"acct", mode:"api_key"}`, and left
  `models.providers.acct.apiKey` unset, so neither profile was bound to the
  provider entry. No gateway method takes a profile id:
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
  both bots then sent the second key. **[source, probe]** This is about that
  one writer. The gateway's command line can add a second named key (above),
  and two OAuth sign-ins of one provider coexist when the provider's identity
  rules give them different ids.
- **One provider entry per account is not a general answer for
  subscriptions.** Separate `models.providers` entries with their own literal
  keys route two bots to two credentials, and that is a good API-key fixture.
  It does not carry over to subscription sign-ins: `models.authLogin` takes a
  manifest choice and a bot id, not a target provider entry, and runs the
  choice's own provider (`models-auth-login-DleMUtMB.mjs` lines 28-38,
  73-88); xAI's sign-in writes provider `xai` (`extensions/xai/xai-oauth.js`
  lines 365-374) and OpenAI's writes its canonical provider
  (`openai-chatgpt-provider-I6SwdpfN.mjs` lines 282-296), never an alias. An
  OAuth profile cannot be named in an entry's `apiKey`: the resolver classes
  it `profile-incompatible` with reason `credential-class`; only `api_key` and
  `token` profiles qualify (`model-auth-provider-config-CTs-1d_X.mjs` lines
  211-268), and the run then fails with "Per-entry apiKey … is not a
  compatible bearer profile" (`prepare-auth-DF3PBMSe.mjs` line 165). An alias
  also loses what belongs to the canonical provider: its account-discovered
  model list, usage reporting, refresh and transport, and provider tools such
  as xAI's, which test the active provider id (`extensions/xai/index.js` lines
  55-85). **[source]**

### A.4 Binding a bot to an account

- **Per-bot settings that exist** (`config.schema.lookup "agents.entries.*"`,
  **[probe]**): `model`, `models`, `modelPolicy.allow`, `agentDir`, `tools`,
  `skills` and others. There is no `auth` key under `agents.entries.*` ("config
  schema path not found", **[probe]**); `auth` exists only at the root, with
  `profiles` and `order`.
- **A bot can select an account: `<provider>/<model>@<profileId>`.** There is
  no separate account key, but a bot's model reference can carry an account
  suffix, for example `agents.entries.<bot>.model: {primary:
  "acct/dev-1@acct:one", fallbacks: []}`. Configuration keeps the suffix
  (**[probe]**: `agents.create {model:"acct/dev-1@acct:one"}` and a
  `config.patch` of the object form both read back unchanged). At run time
  `splitTrailingAuthProfile(resolveNativeModelPrimary(cfg, agentId))` takes
  the profile and uses it whenever the requested model is the bot's default
  model, returning it with source `user`
  (`<openclaw>/dist/session-override-5SZAWDJR.mjs` lines 379-412); the
  command path does the same (`agent-command-DFdm3k6d.mjs` lines 2067, 3343).
  The profile must exist and belong to that provider, otherwise the run fails
  with "Selected auth profile … is unavailable" (`selection-error-CL78cZRd.mjs`
  lines 4-10; `session-override-5SZAWDJR.mjs` lines 397-406). It is written
  with `agents.create {model}` or `agents.update {agentId, model}` (string
  form) or `config.patch` (object form with `fallbacks`), all
  `operator.admin`. Observed **[probe]**: bots pinned to `acct:one` and
  `acct:two` of one provider each sent their run only with their own key.
  **[source, probe]**
- **A session can select one too.** `sessions.patch {key, model:
  "<provider>/<model>@<profileId>"}` resolves `selection.profile` and stores
  it as the session's `authProfileOverride` with source `user`
  (`<openclaw>/dist/sessions-patch-DIr6Po0r.mjs` lines 548-623). A model-only
  patch needs `operator.write` (or the narrower session write scope), not
  admin (`session-method-scopes-base-CuhU2F_D.mjs` lines 43-84). There is no
  separate `authProfileId` property in `SessionsPatchParams`; the earlier
  search for one was right about the schema and wrong about the conclusion.
  A session's user selection is consulted before the bot's configured one
  (`session-override-5SZAWDJR.mjs` line 391), so a session can move a bot's
  conversation to another account of the same provider. Observed
  **[probe]**: on a bot with a stored one-profile order for `ord401:one`,
  `sessions.patch {model:"ord401/dev-1@ord401:two"}` sent the next run with
  `ord401:two`'s key. **[source, probe]**
- **Neither selection is exclusive.** `prepareAgentRuntimeAuth` validates a
  user selection and then prepends it to the automatic candidate order
  instead of replacing it (`prependAuthProfilePin`,
  `<openclaw>/dist/order-hOATlAZf.mjs` lines 156-162;
  `prepare-auth-DF3PBMSe.mjs` lines 131-188). Only the internal option
  `allowAuthProfileFallback: false` reduces the candidates to the selected
  profile (line 174). Searched every `dist/*.mjs` for that option: it is set
  only by side paths (setup and repair inference, isolated completions,
  simple completions, one tool), not by ordinary chat runs, and no config key
  or method parameter sets it. The embedded runner then advances through
  the candidates on failure (`embedded-agent-CPls2oXD.mjs` lines 5503-5521).
  Observed **[probe]**: a bot pinned to `pin401:one` with empty fallbacks,
  whose account began answering 401, finished the same run on `pin401:two`.
  **[source, probe]**
- **How the automatic candidates are ordered**
  (`resolveAuthProfileOrderWithMetadata`, `order-hOATlAZf.mjs` lines
  164-217): an explicit order (the bot's stored order, which takes precedence
  over `auth.order.<provider>` in config, lines 12-16), else the profiles
  listed in `auth.profiles` for that provider, else the stored profiles;
  ineligible ones are dropped; profiles in cooldown stay in the list but move
  to the end. Without an explicit order the rest is round-robin by type and
  least recent use (`model-failover.md`, "Rotation order"). If every profile
  of an explicit order is missing from the store, the order is repaired back
  to the stored profiles (lines 198-201). **[source]**
- **A provider-entry binding outranks automatic order.** When
  `models.providers.<p>.apiKey` names a profile (what `models.authSetApiKey`
  writes, A.8), that profile is the required source for runs without a user
  selection; literal keys with `auth:"api-key"` suppress profile candidates
  altogether (`prepare-auth-DF3PBMSe.mjs` lines 157-176). A user selection
  skips the binding. **[source]**
- **A stored one-profile order, from the command line only.**
  `models.authOrderSet {provider, profileIds, agentId}` (`operator.admin`,
  line 2682) writes the bot's stored order, but refuses an order that does not
  list every available profile, an order when `auth.order` config controls
  it, and any order when the provider config binds a profile
  (`<openclaw>/dist/models-auth-order-ReW5cT_z.mjs` lines 39-70). Observed
  **[probe]**: a one-profile order over the method was refused with
  "profileIds must include every available profile for provider ord401". The
  gateway's own command line has no such rule: `openclaw models auth order
  set --provider <p> --agent <bot> <profileId>` checks only that each id is
  saved and belongs to the provider, then writes the bot's local store
  (`<openclaw>/dist/auth-order-DNR83ml4.mjs` lines 66-95;
  `profiles-ouASNfE0.mjs` lines 857-869) and asks the running gateway to
  refresh its auth state. Observed **[probe]**: it accepted `ord401:one` for
  bot `ord-401`, `order get` read it back, and when that account then failed,
  the bot's runs failed instead of moving to `ord401:two`. It is still not an
  unconditional fence: a user selection is prepended to it (above), a
  provider-entry binding outranks it, and an all-missing order is repaired.
  **[source, probe]**
- **Global order**: `auth.order.<provider>` in config filters the automatic
  candidates the same way; a stored profile left out of it "is not silently
  tried later" (`<openclaw>/docs/auth-credential-semantics.md`, "Explicit auth
  order filtering"). It applies to every bot without a stored order of its
  own, because a stored order takes precedence (`order-hOATlAZf.mjs` lines
  12-16). Changing only the global order does not govern a bot that has one.
  **[source]**
- **A bot-local credential store.** A bot's runtime store is the shared store
  with its own entries layered on top by profile id
  (`runtime-snapshots-DiWi6TS1.mjs` lines 666-718). A credential that exists
  only in one bot's store is invisible to other bots, but the bot still sees
  every inherited shared profile of the provider, so a local store separates
  credentials without excluding the shared ones. **[source]**
- **Provider plugins** can prefer a profile with `resolveAuthProfileId(ctx)`;
  the context has the agent and workspace folders, the preferred and locked
  profile and the order, and the gateway moves the returned profile to the
  front only if it is already in the order (`prepare-auth-DF3PBMSe.mjs` lines
  189-201; `config-contracts-C65kIjn4.d.ts` lines 35746-35751, 35951-35955,
  36495-36501). It is a preference, not a fence. The `before_model_resolve`
  hook returns only `modelOverride` and `providerOverride`, with no profile or
  block result (`config-contracts-C65kIjn4.d.ts` lines 8838-8849). **[source]**
- **When a change takes effect.** `agents.update {model}` during a run: the
  run finished on the old provider and the next run used the new one, with no
  line in the conversation's history marking the change (**[probe]**: history
  was user, assistant on `acct-a`, user, assistant on `acct-b`). For
  `sessions.patch {model}` the docs describe a "pending live switch" that the
  active run may adopt in the same turn (`model-failover.md`, "Session overrides
  and live model switching"). **[source]**
- **A bot whose account is removed.** `models.authLogout {provider, agentId}`
  (`operator.admin`, line 557) without `profileIds` aborts runs on the provider
  with `stopReason:"auth-revoked"` for the requested `agentId` only; a logout
  that names `profileIds` or a credential type does not take that abort path
  (`models-auth-status-DDLxf-39.mjs` lines 386-418). Logout follows the
  credential's physical owner: a profile in the shared store is removed for
  every bot that inherits it, references to it are cleared, and a bot's own
  independently stored copy survives (`auth-logout-OeafO1t3.mjs` lines
  151-201, 324-422). **[source]** Observed **[probe]** for a configured
  provider whose key `models.authSetApiKey` had put in the shared store:
  logging out "for" one bot removed it for both bots on that provider, the
  provider's `apiKey` binding was cleared, and both bots' next runs were sent
  with no `Authorization` header. That last part is specific to the fixture:
  the scripted server accepts unauthenticated calls, a real provider would
  refuse them. The docs add that removing a saved credential clears model and
  conversation account selections that named it (`model-failover.md`,
  "Session stickiness"). **[source]**

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
source:"config", logoutSupported:true}`; no secret appears. In that fixture
every bot saw the same list; that is not a general rule, since a bot's own
store adds and overrides profiles (A.4), and in A.13 the same shared profiles
read `source:"saved"` for some bots and `source:"inherited"` for others. A billing disable did **not**
appear: after a 402 the provider still read `static` while its runs were
refused. Profiles in an auth, billing or rate-limit cooldown also read
`status:"static"` with no `reasonCode` (A.13). So `authStatus` does not
report "out of quota" or "cooling down" for an API key. Whether it does for
OAuth profiles was not observed. An account's identity can still leak through
its profile id, which may contain an email, even where `email` is withheld
from non-admin connections; `displayName` for an inactive setup is set
independently of admin (line 532). **[probe, source]**

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
  **[probe]**. That read carries no session, so it says nothing about a
  selected account.
- `models.list {sessionKey}` does carry one. The session's
  `authProfileOverride` becomes the catalog's `preferredProfileId`, and
  `pinnedProfileId` when its source is `user`
  (`resolveSessionCatalogProfiles`,
  `<openclaw>/dist/chat-metadata-session-projection-DuoPBWYl.mjs` lines
  173-187), and the result is projected through the selected account's
  catalog (`prepareSelectedAccountCatalog`,
  `<openclaw>/dist/models-list-result-Dx7spcW4.mjs` lines 264-275, 446-474).
  So for a provider whose catalog depends on the account (below), a session
  with a selected shared account gets that account's availability. This was
  not probed: the scripted providers have no account-dependent catalog. It is
  no guarantee of what a provider will actually let an account use. The
  bot-level `model@profile` suffix reaches this projection only through the
  session: after a pinned bot's first run, `chat.metadata` read the session's
  account as the pinned profile with `source:"auto"` (A.13), so it is a
  preferred, not a pinned, account there, and after a rotation it named the
  other account. **[source, probe]**
- Account-dependent catalogs exist for some providers: xAI's OAuth catalog
  differs from its API catalog ("OAuth-only models stay unavailable" without
  it, `<openclaw>/docs/providers/xai.md` line 127), and OpenAI ships
  `extensions/openai/account-models.js`. The gateway folds them into the
  provider's list. **[source, not probed]**
- `agents.entries.<id>.modelPolicy.allow` limits which models a bot may be
  switched to ("Per-agent model override policy", **[probe]** schema hint).

### A.7 Out of quota, signed out, expired; automatic fallback

Observed on a bot whose model is a plain string (no fallbacks of its own) and
whose provider has its key inline in `models.providers` **[probe, rerun with
checks, A.11]**:

| Scripted response | `chat` `state:"error"` | `errorKind` | `errorDetail` |
| --- | --- | --- | --- |
| 401 `authentication_error` | `errorMessage` "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`." | absent | `{provider, model, failoverReason:"auth", providerRuntimeFailureKind:"auth_invalid_token"}` |
| 402 `insufficient_quota` | "⚠️ acct-a (dev-1) returned a billing error — check your account's balance and usage limits before trying again." | `"rate_limit"` | `{provider, model, failoverReason:"billing", providerRuntimeFailureKind:"unclassified"}` |
| the same bot's next run after that 402 | "Inline API key for provider \"acct-a\" is temporarily disabled after a provider auth/billing failure. Retry after about 10 minutes, or switch to a different auth profile/API key." | absent | absent |

- The `agent` `lifecycle` stream carried the same `errorObservation`, then
  `phase:"fallback_step"` with `fallbackStepFromModel`,
  `fallbackStepFromFailureReason`, `fallbackStepFromFailureDetail` (the
  provider's status and message), `fallbackStepChainPosition` and
  `fallbackStepFinalOutcome:"chain_exhausted"` (no `fallbackStepToModel` when
  the chain is exhausted), then `phase:"error"`. The source is
  `<openclaw>/dist/agent-harness-attempt-runtime-C3Sh4Ev7.mjs` lines 155-180.
- `errorKind` has no `auth` or `billing` value (`<protocol>` `ChatErrorEvent`:
  refusal, timeout, rate_limit, context_length, state_contention, unknown). Use
  `errorDetail.failoverReason`. The documented reasons include `auth`,
  `auth_permanent`, `billing`, `rate_limit`, `overloaded`, `timeout`,
  `model_not_found`, `format`, `session_expired` and `server_error`
  (`model-failover.md`, "Observability"). `errorDetail` has no account field
  (`<protocol>` `ChatErrorEvent`); a refusal for a profile already in
  cooldown came without `errorDetail` at all (A.13).
- **Scope of a billing disable.** An inline key's failure is written to the
  selected bot's own auth database (`persistInlineAuthFailure`, "The retry
  controller's inline failure belongs to its explicit agent database",
  `<openclaw>/dist/usage--orhr9MG.mjs` lines 40-68, 557-575). Observed
  **[probe]**: after `probe-a`'s 402, `probe-a`'s next run was refused, while
  `probe-a2`, on the same provider and inline key, still ran. For a saved
  profile the bookkeeping goes to the profile's physical owner: the shared
  store for a shared profile, the bot's store for its own
  (`usage-write-Y7pVNisr.mjs` lines 188-209); in A.13 a profile in the shared
  store went into cooldown and the bot moved on. The first billing disable
  lasts ten minutes and grows on repeated failures up to 24 hours; rate limits
  start at 30 seconds, auth failures at 30 seconds, then 60 seconds, then five
  minutes (`usage-reduction-DjwsLrCa.mjs` lines 10-65). So "paused for about
  ten minutes, for every bot" is wrong on both counts. **[source, probe]**
- `models.authStatus` does not show any of this: after a 402 the provider
  still read `static` (A.5), and in A.13 profiles in cooldown read `status:
  "static"` with no reason code. **[probe]**

**Every automatic move the gateway can make by itself**, with what controls it
and what a client can see. Read in source and docs; the rows marked
**[probe]** were also run, on the embedded runtime with an OpenAI-compatible
scripted provider. Other runtimes and providers were not run.

| Automatic move | What controls it | What a client can observe |
| --- | --- | --- |
| Retry the same provider, model and account (rate limits up to 10 attempts in all, other transient failures eight retries in a 90-second window) | The embedded runtime's session setting `retry.provider.maxRetries` (`0` disables retries; rate limits stay capped at 10); not an `openclaw.json` key and not per bot (`model-failover.md` lines 343-354) | `chat` `state:"status"` with `retry {attempt, maxAttempts, reason}` for rate limits (`<protocol>` `ChatStatusEvent`); each failed attempt also ends with a `lifecycle` `phase:"finishing"` event carrying `error` and `errorObservation` **[probe]** |
| **Move to another account of the same provider** on auth, billing, rate-limit (after the retries), overload and timeout failures; a bot or session pin is prepended, not exclusive (A.4) | The candidate list: the bot's stored order, else `auth.order.<provider>`, else configured, else stored profiles; a provider-entry binding; profiles in cooldown are skipped. Not by the pin and not by empty `fallbacks` | **No event names either account.** **[probe, A.13]**: a `lifecycle` `phase:"finishing"` with `error` and `errorObservation {provider, model, failoverReason}`, then a second `start` and `model` for the same provider and model in the same run, then `final`. The `terminalReceipt` reads `requested` = `effective`; no `fallback_step`; no notice; the history row names provider and model only. `chat.metadata {sessionKey}` `accountSelection` named the pinned account after that run and the other account only after the next one. |
| Move to the next model (possibly another provider) along the fallback chain | The bot's `model.fallbacks`; a bot with its own `model` and no `fallbacks` is strict, and `fallbacks: []` makes it explicit; bots without a model of their own inherit `agents.defaults.model.fallbacks`; an explicit session or user selection is strict; cron jobs have their own `payload.fallbacks` (`model-failover.md` "Selection source policy" lines 134-149). **[probe]**: with `agents.defaults.model.fallbacks: ["other/dev-1"]`, no pinned bot with `fallbacks: []` ever reached `other`. | `lifecycle` `phase:"fallback_step"` with `fallbackStepFromModel`, `fallbackStepToModel`, failure reason and detail, `fallbackStepFinalOutcome` (`next_fallback`, `chain_exhausted`); `lifecycle` `phase:"model"` for the new model; the `terminalReceipt` `requested`/`effective`/`rerouted`; the assistant row's provider and model; a "↪️ Model Fallback" notice in one-to-one conversations when it succeeds (`model-failover.md` lines 475-510) **[source, probe]** |
| Embedded OpenAI cyber-policy escalation to `openai/gpt-daybreak-blue-latest` | `agents.defaults.embeddedAgent.cyberFailover.mode` (`auto` or `off`), global; a strict or locked selection suppresses it (`model-failover.md` lines 79-132) | Effective model and receipt; refusal and reroute outcomes |
| Codex harness cyber escalation and upstream reroutes | `plugins.entries.codex.config.appServer.cyberFailover`, on by default, separate from the embedded switch; no per-bot setting found (`docs/plugins/codex-harness/runtime-behavior.md` lines 193-254) | `agent` `notice` stream, `phase:"provider_policy"`, `provider:"openai"`, `category:"cyber"`, `state` `buffering`/`blocked`/`fallback`/`escalated`/`unavailable`/`cleared`, with model fields when upstream sends them |
| Anthropic server-side refusal fallback inside one request (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5.1, Fable 5; direct API key to `api.anthropic.com` only) | The provider wrapper always sends `fallbacks: "default"` for those models; independent of the configured fallback list; no per-bot switch found (`docs/providers/anthropic.md` lines 733-794). Empty `fallbacks` does not turn it off. | A `provider_fallback` diagnostic on the assistant message with `fromModel` and `toModel`, and its `responseModel` |

Two more automatic routes do not move the main conversation: utility-model
calls (titles and the like) route and fall back separately
(`<openclaw>/docs/concepts/models.md` line 61), and provider-owned harnesses
may retry inside their own transport. **[source]**

So empty fallbacks plus `cyberFailover.mode:"off"` do not cover every route:
they leave same-provider account rotation, the Codex plugin's own escalation
and Anthropic's in-request fallback. Part C lists what does.

### A.8 API keys: entry and read-back

- Entry: `models.authSetApiKey {provider, apiKey, agentId?}` (`operator.admin`,
  line 2816) returns `{provider, profileId, warning?}`. Where it lands
  (`auth-api-key-B25pB09w.mjs` lines 64-129): if `models.providers.<provider>`
  exists, the key goes to the **shared** store (`agentDir` undefined) and the
  provider's `apiKey` becomes the profile id; otherwise it goes to the store
  that owns the profile it replaces, which is the shared store when the
  replaced profile is an inherited shared one (lines 81-86), and to the named
  bot's own store only when nothing is replaced. It also writes `auth.profiles.<id> {provider,
  mode:"api_key"}`. **[source; shared case probe]**
- Read-back: `config.get` (`operator.read`) shows `apiKey` as
  `__OPENCLAW_REDACTED__` **[probe]**. `models.authStatus` shows the source, not
  the key **[probe]**. No method returning an auth-profile key was found
  (searched `<protocol>` result definitions under `models.*` and `users.*`).
- Secret store: `secrets.store.set {name, value, kind: secret|env,
  allowedHosts?}` and `secrets.store.list` are `operator.admin` (lines 2415,
  2409). `SecretsStoreListResult` returns `value` for `kind:"env"` entries and
  omits it for `kind:"secret"` (`<protocol>`). So an `env` entry can be read
  back by an admin connection. This store is separate from auth profiles:
  `secrets.store.list` does not return a key entered through
  `models.authSetApiKey`. Other provider sign-ins may still ask for protected
  secret storage (`provider-auth-persistence-gQTd65a9.mjs` lines 84-127), so
  "provider auth never uses the secret store" would be too broad. None of
  this is a promise that an administrator with host access or a malicious
  plugin cannot reach a key. **[source]**

### A.9 Does a turn record its account

Not in anything a client receives. The gateway does know the account inside
a run; it does not publish which account served a turn.

- **What a client receives** **[probe]**:
  - `chat.history` assistant row: `role, content, api, provider, model, usage,
    stopReason, timestamp, responseId, __openclaw {runId, id,
    recordTimestampMs, transcriptPosition, seq}`;
  - `lifecycle phase:"model"`: `{provider, model}`;
  - `terminalReceipt`: `requested {provider, model}`, `effective {provider,
    model, responseModel}`, `rerouted`. In A.13 a run that moved from
    `pin401:one` to `pin401:two` had `requested` equal to `effective`;
  - `sessions.list` row: `modelProvider`, `model`, `modelOverrideSource`, and
    no auth-profile field (`authProfileOverride` is a stored session field,
    `<openclaw>/docs/reference/session-management-compaction/schema.md`, not
    projected into the row);
  - `chat` `errorDetail`: provider, model and failure classification, no
    profile id (`<protocol>` `ChatErrorEvent`). A missing selected profile
    reaches the person as generic copy, "This saved login isn't available"
    (`<openclaw>/dist/user-facing-text-CI_FtfJb.mjs` lines 357-360).
- **`chat.metadata {sessionKey}`** returns `accountSelection {kind:"shared",
  authProfileId, label, source}` for a session with a shared account. Its
  source says outright: "The session owns this preference; it is not a
  receipt for the account that served a turn"
  (`<openclaw>/dist/chat-metadata-session-projection-DuoPBWYl.mjs` lines
  56-70). Observed **[probe, A.13]**: after the run served by `pin401:two` it
  still named `pin401:one`, and named `pin401:two` only after the next run; on
  a bot whose only account was in cooldown it read `{kind:"automatic"}`.
  **[source, probe]**
- **What the gateway knows internally.** A `FailoverError` carries
  `profileId`, and `describeFailoverError` keeps it in its structured fields
  (`<openclaw>/dist/failover-error-DG1eDtaH.mjs` lines 294-307, 355-360); a
  missing explicit selection names the profile in its message and error
  (`selection-error-CL78cZRd.mjs` lines 4-10); a successful run reports its
  auth binding with `authProfileId` to an `onSuccessfulAuthBinding` callback
  (`embedded-agent-CPls2oXD.mjs` lines 6897-6900), which in this build is
  passed only by internal callers (setup inference, the CLI runner), not
  exposed as a plugin hook (searched `dist/*.mjs` for its callers). None of
  these reaches a client event, history row or session row. **[source]**

So F-479's "each turn's record includes the account the run used" needs a
receipt the gateway does not publish; Part C says where a plugin could add
one.

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
- **What a client sees**: the effective inventory keeps each tool's owning
  plugin (`<openclaw>/dist/tools-effective-inventory-build-rQ822-cI.mjs` lines
  70-81, 105-124) and `tools.catalog` projects it
  (`tools-catalog-BOjEy88w.mjs` lines 79-95), so `x_search` would appear under
  the xAI plugin in `tools.effective {sessionKey}` and `tools.catalog`
  **[source]**; not observed, because the development gateway has no xAI
  provider. Exposure needs all of: the plugin loaded, an xAI active model (or
  explicit `enabled: true`), usable xAI auth, and tool policy that permits it
  (`extensions/xai/index.js` lines 55-98, 218). An xAI account does not grant
  a client-side X connector or X account actions; `x_search` is a
  provider-side search request with handle, date and media filters
  (`x-search-shared-bC0D1De5.mjs` lines 63-97). A custom provider alias for
  xAI does not pass the active-provider gate. **[source]**
- **xAI summary**: sign-in kinds `xai-oauth` (device code, subscription) and
  `xai-api-key`; models in the manifest catalog `grok-4.7`, `grok-4.6`,
  `grok-4.5`, `grok-build-0.1`, `grok-4.3`, `grok-4.20-0309-reasoning`,
  `grok-4.20-0309-non-reasoning` (multi-agent models suppressed); OAuth routes
  through `https://cli-chat-proxy.grok.com/v1` and API keys through
  `https://api.x.ai/v1` (`providerEndpoints`). SuperGrok quota shows in
  provider usage for OAuth (`xai.md` lines 86-94). **[source]**

### A.11 Probe and the fixture the tests will use

Scripts in `docs/research/dev-gateway/provider-accounts/`: `probe.mjs` (this
section), `pin-probe.mjs` (A.13), the shared `instance-guard.mjs` and
`probe-client.mjs`, and `recording-model.mjs`. Both probes refuse anything
but a named instance this checkout started whose recorded gateway is still
the running process (instance name, run id and checkout must agree across
the instance marker and this checkout's run files; the endpoint must be
loopback on the recorded port in 19200-19999; the recorded gateway PID must
be alive with its recorded start time). They start their recording servers
on the instance's scripted-model port + 1, + 2 and + 3, refuse a port that is
already taken, wait until each listens, and stop them by PID. They change the
instance's config, bots, sessions and pairing, so the instance is stopped and
reset afterwards. Each prints what it saw, checks the facts this document
takes from it, and exits 1 if any check fails.

```bash
pnpm dev-gateway start --instance <name> --no-seed
CLAWTRATE_DEV_INSTANCE=<name> node docs/research/dev-gateway/provider-accounts/probe.mjs
pnpm dev-gateway stop --instance <name> && pnpm dev-gateway reset --instance <name>
```

**Is the recording server's stream valid?** It was suspected of writing
literal backslash-n characters instead of the blank lines that end
server-sent events. It does not: the template literals contain `\n\n`
escapes, which are newlines at run time, and a request to the server returned
the bytes `0a 0a` after every `data:` line and after `data: [DONE]`; the log
file is one JSON object per line. **[probe]** The earlier probe results were
nevertheless rerun on a fresh instance with checks on the terminal `chat`
state, the streamed answer text and the history row, and all held
(2026-11-17, gateway 2026.10.6, embedded runtime).

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
recording server logs `{t, label, port, auth, model, marker, serverTools}` per
request; a prompt containing `FAIL401`, `FAIL402`, `FAIL429` or `SLOW` gets a
401, a 402, a 429 or a four-second delay, and `POST /control {failKeys}` makes
chosen keys fail whatever the prompt says.

Results, each a passing check **[probe]**:

| Bot | Model | Reached | Key sent | Outcome |
| --- | --- | --- | --- | --- |
| `main` | `scripted/dev-1` | the tool's scripted model | (not recorded) | `final` |
| `probe-a` | `acct-a/dev-1` | `acct-a` | `scripted-key-a` | `final`, text "Answered by acct-a." in the event and in `chat.history` |
| `probe-b` | `acct-b/dev-1` | `acct-b` | `scripted-key-b` | `final`, history row `provider:"acct-b"` |
| `probe-x1` | `acct-x/dev-1`, key x1 set with `agentId: probe-x1` | `acct-x` | `scripted-key-x2` | `final` |
| `probe-x2` | `acct-x/dev-1`, key x2 set with `agentId: probe-x2` | `acct-x` | `scripted-key-x2` | `final` |
| `probe-a2` after `probe-a`'s 402 | `acct-a/dev-1` | `acct-a` | `scripted-key-a` | `final`, while `probe-a`'s own next run was refused without a request |
| `probe-x1`, `probe-x2` after `models.authLogout {provider:"acct-x", agentId:"probe-x2"}` | | `acct-x` | none | (fixture accepts unauthenticated calls) |

Also checked: both `models.authSetApiKey` calls returned `acct-x:manual`;
`models.authOrderSet` on the bound provider was refused as "controlled by
provider configuration"; a run in progress when `probe-a` moved to `acct-b`
finished on `acct-a` and the next went to `acct-b`, with history user,
assistant on `acct-a`, user, assistant on `acct-b` and no line marking the
change; `probe-fb` (`fallbacks: ["acct-x/dev-1"]`) went from `acct-b` to
`acct-x` in one run with a `fallback_step` naming both models; the tool
server stand-in reached `probe-a` and a later `probe-new` but not `probe-b`
with its deny.

**What this means for the fixture.** One provider entry per account, each
with its own literal key, is a dependable API-key fixture: a bot created on
`acct-b` sends its run to `acct-b`'s port, never `acct-a`'s. It is not a model
of subscription accounts (A.3). Two accounts of the *same* provider can be
emulated without a plugin: one `models.providers` entry without `apiKey`, and
two API-key profiles saved with `openclaw models auth paste-api-key
--profile-id` against the instance's profile; the recording server tells them
apart by key (A.13). Two OAuth accounts of one provider cannot be emulated
with scripted servers, and were not.

### A.12 What needs a plugin

Part C has the full answer. In short, after the corrections above:

| Need | Stock gateway | Plugin would need |
| --- | --- | --- |
| Select one account for a bot | Available: `<provider>/<model>@<profileId>` on the bot's model (A.4) | Nothing |
| Never run that bot on another account | Not available as a guarantee: a pin is a preference; a stored one-profile order (command line only) held in the probe but yields to session selections, provider bindings and repair (A.4, A.13) | Enforcement at run time (Part C) |
| A user-set label per account | No label field | Plugin-owned metadata keyed by profile id |
| Which bots use an account | Derivable from `agents.list` model suffixes and stored orders, not reported | Or the plugin's own binding record |
| Turn names its account | Not published (A.9) | A receipt written by the plugin (Part C) |
| Sign-in below admin | Only personal accounts (`users.authConnect.*`, `operator.write`) | A plugin method that runs the flow itself (A.2, Part C) |

### A.13 Probe: a bot pinned to one account when that account fails

Script `docs/research/dev-gateway/provider-accounts/pin-probe.mjs`, run twice
on a fresh named instance with the same results, the second time with all
39 checks passing (gateway 2026.10.6, embedded runtime,
OpenAI-compatible scripted provider). Everything below is **[probe]**; each
statement in the result table is one of the script's checks or is read from
its recorded events.

```bash
pnpm dev-gateway start --instance <name> --no-seed
CLAWTRATE_DEV_INSTANCE=<name> node docs/research/dev-gateway/provider-accounts/pin-probe.mjs --out <file.json>
pnpm dev-gateway stop --instance <name> && pnpm dev-gateway reset --instance <name>
```

**Exact configuration.** One scripted provider per scenario (`pin401`,
`ord401`, `pin402`, `ord402`, `pin429`, `ord429`, plus `acct` for the
baseline), all pointing at one recording server, with no `apiKey` in the
entry; a second recording server as provider `other` with its own literal
key; and an inherited fallback that no pinned bot should ever use:

```json5
{
  models: { providers: {
    pin401: { baseUrl: "http://127.0.0.1:<P+1>/v1", api: "openai-completions", models: [/* dev-1 */] },
    // ord401, pin402, ord402, pin429, ord429, acct: the same
    other:  { baseUrl: "http://127.0.0.1:<P+2>/v1", api: "openai-completions", apiKey: "scripted-other-key", models: [/* dev-1 */] },
  } },
  agents: {
    defaults: { model: { primary: "scripted/dev-1", fallbacks: ["other/dev-1"] } },
    entries: {
      "pin-401": { model: { primary: "pin401/dev-1@pin401:one", fallbacks: [] } },
      "ord-401": { model: { primary: "ord401/dev-1@ord401:one", fallbacks: [] } },
      // pin-402, ord-402, pin-429, ord-429, on-one (acct:one), on-two (acct:two): the same pattern
    },
  },
}
```

Two API-key profiles per provider, saved through the instance's command line
(the key on stdin, never on the command line):

```bash
openclaw --profile clawtrate-dev-<name> models auth paste-api-key --provider pin401 --profile-id pin401:one   # key scripted-pin401-one
openclaw --profile clawtrate-dev-<name> models auth paste-api-key --provider pin401 --profile-id pin401:two   # key scripted-pin401-two
```

This wrote `auth.profiles.pin401:one` and `:two` `{provider, mode:"api_key"}`
and no `apiKey` binding. For each `ord-*` bot, a stored one-profile order:

```bash
openclaw --profile clawtrate-dev-<name> models auth order set --provider ord401 --agent ord-401 ord401:one
```

It printed "Auth profile order override: ord401:one", `order get --json`
read back `["ord401:one"]`, and `models.authStatus {agentId:"ord-401"}` then
reported `profileOrder: ["ord401:one"]`. The same one-profile order over
`models.authOrderSet` was refused: "profileIds must include every available
profile for provider ord401".

**Baseline.** `on-one` sent its run only with `acct:one`'s key and `on-two`
only with `acct:two`'s; every pinned bot reached only its own account; all
ended `final`.

**Failure.** For each scenario the recording server began answering the
`:one` key with the status, the bot ran twice, the failure was cleared, and
the bot ran again.

| Bot | Status on `:one` | First run (requests in order) | Second run | After the failure was cleared |
| --- | --- | --- | --- | --- |
| `pin-401` (pin only) | 401 | `one` → `two`, `final` | `two`, `final` | `two`, `final` |
| `ord-401` (pin + order) | 401 | `one`, `error` | no request, `error` | no request, `error` |
| `pin-402` | 402 | `one` → `two`, `final` | `two`, `final` | `two`, `final` |
| `ord-402` | 402 | `one`, `error` | no request, `error` | no request, `error` |
| `pin-429` | 429 | `one` ×10 → `two`, `final` | `two`, `final` | `two`, `final` |
| `ord-429` | 429 | `one` ×10, `error` | no request, `error` | no request, `error` |

No request from any pinned bot reached `other`, the inherited fallback.
With the stored order, no request used `:two`.

**What the client received when the run moved (`pin-*`, first run).** In
order: `chat` `state:"status"` and `run_status` phases; `lifecycle` `start`;
`lifecycle` `model {provider:"pin401", model:"dev-1"}`; for 429 only, nine
`chat` `state:"status"` events with `retry {attempt: 2…10, maxAttempts: 10,
reason:"rate_limit"}`; `lifecycle` `phase:"finishing"` with `error`
("Couldn't sign in to the AI service. …" for 401) and `errorObservation
{provider, model, failoverReason:"auth"|"billing"|"rate_limit",
providerRuntimeFailureKind}`; then a second `lifecycle` `start` and `model`
for the **same** provider and model; the streamed answer; `lifecycle` `end`
with `terminalReceipt` whose `requested` and `effective` were both
`{provider:"pin401", model:"dev-1"}`; `chat` `state:"final"`. There was no
`fallback_step`, no `notice`, no event or field naming either profile, and
the history row named provider and model only. `chat.metadata {sessionKey}`
read `accountSelection {kind:"shared", authProfileId:"pin401:one",
source:"auto"}` after that run, and `pin401:two` only after the next one.
`models.authStatus` showed both profiles `status:"static"` throughout. So a
client can see that an attempt failed and the run went on, but not that it
went on with another account.

**What the client received when it did not move (`ord-*`).** First run: the
same `finishing` event, then `lifecycle` `fallback_step
{fallbackStepFromModel:"ord401/dev-1", fallbackStepFromFailureReason,
fallbackStepFromFailureDetail:"401 Invalid API key (scripted)",
fallbackStepChainPosition:1, fallbackStepFinalOutcome:"chain_exhausted"}`,
`lifecycle` `error`, and `chat` `state:"error"` with `errorMessage` and
`errorDetail {provider, model, failoverReason, providerRuntimeFailureKind}`
(for 402 also `errorKind:"rate_limit"`, as in A.7; for 429
`errorKind:"rate_limit"` and the message "⚠️ Rate limit reached (scripted);
Retry-After: 1 seconds"). Later runs while the profile was in cooldown made
no request and ended in `chat` `state:"error"` with only an `errorMessage`
and no `errorDetail`: "All models failed (1): ord401/dev-1: Provider ord401
has auth issue (skipping all models) (auth)", "ord402 rejected the request —
looks like a billing issue on the account. `openclaw --profile
clawtrate-dev-<name> configure`." then "… Provider ord402 is in cooldown
(billing)", and "ord429 is asking us to slow down. Please wait a moment
before trying again." then "… Provider ord429 is in cooldown (rate_limit)"
with `errorKind:"rate_limit"`. None of these names the account.

**After the cooldown.** Forty seconds after the 401 was cleared (a first auth
failure cools a profile down for 30 seconds), `pin-401` and `ord-401` each
sent their next run with their own `:one` key and ended `final`. So a
pin-only bot drifts to the other account for as long as its own account
cools down and then comes back by itself, with no event either way;
`chat.metadata` still named `pin401:two` after the run that came back. The
402 and 429 cooldowns (ten minutes and up, 30 seconds and up) were not
waited out.

**An explicit session selection overrides the stored order.** On `ord-401`,
`sessions.patch {key, model:"ord401/dev-1@ord401:two"}` stored
`authProfileOverride:"ord401:two"`, `authProfileOverrideSource:"user"`,
`modelOverrideSource:"user"`, and the next run went to `ord401:two` and ended
`final`; `chat.metadata` then read `source:"user"`. That move is visible to a
client, because the client made it or sees the session change.

**Not covered**: OAuth profiles, a real provider, other runtimes (Codex,
ACP, CLI harnesses), bots created after the order was set, and
`allowAuthProfileFallback`. Timeouts and overloads were not scripted.

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
  401 `{"error":"invalid_mcp_credential", "message":"A valid T3 Code MCP
  credential is required."}` with `cache-control: no-store` and a
  `WWW-Authenticate: Bearer resource_metadata="…"` that points to
  `/.well-known/oauth-protected-resource/mcp`, plus `error="invalid_token"`
  when a token was presented (`<t3>/server` lines 49248-49259, 49306-49339).
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
  level" (`<t3>/runtime` lines 9984-9998; `outside-agents.md`). A pairing code
  approves the OAuth request; the client still receives an authorization code
  and exchanges it with PKCE (`<t3>/server` lines 51779-51809). The current
  public setup page also describes a hosted approval page; the installed
  build has its own page and a configurable hosted link base, so a client
  must not hardcode one approval address.
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

### B.2 The operations an outside client uses

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
"Choice of checkout" is `workspaceStrategy`. Settled in the bundle **[source]**:
an outside caller (no calling thread) gets the project's default model,
resolved through the server settings, and the project's default runtime mode,
still capped by the client's access level and the provider's supported modes;
a project with no default model fails with `invalid_request` "Pass
modelSelection: the project has no default model" (`<t3>/server` lines
46599-46618). Without `projectId` (and without `scratch`) an outside launch
fails with `target_required` (line 43689). An `existing_worktree` launch
into a missing project fails with `invalid_request` "The project was not
found." (lines 46583-46587). A launch without `message` creates an idle
thread whose `runId` and `status` are `null` (lines 46629-46634 and the
result schema). Launch keeps a `modelSelection` as given ("t3_thread_launch
keeps a selection as given", line 44796), so an unknown model is not proven
to be refused at launch; it may fail later when the run starts.
`ModelSelection.options` is canonically an array of `{id, value}` with a
non-empty string or boolean value (`<t3>/runtime` lines 5359-5368);
`orchestrator_capabilities` names a provider `providerInstanceId`, and launch
takes it as `modelSelection.instanceId` (the alias `provider` is accepted on
input; the result is canonical, `<t3>/runtime` lines 17111-17137). The
internal `delegatedFrom` launch option is for linked delegation and not
needed by an outside client.

**Follow up: `t3_thread_send`** (`<t3>/server` lines 47515-47522; `<t3>/runtime`
lines 36529-36555):

> "Send a message to any thread. The target cannot run with broader modes than
> yours. `mode:'auto'` starts an idle thread, steers a running turn, or queues.
> `queue`: new turn. `steer`: mid-turn update. `restart`: interrupt and
> restart. A send to a finished child thread starts a fresh task and returns
> its `taskId`. …"

The default `auto` can **steer** a running turn (delivery `steered`), so a
follow-up sent while a thread runs may change the current run rather than
start a new one. `freshContext: true` starts a new provider session without
earlier context and never steers (`<t3>/runtime` lines 36529-36555).

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

`t3_thread_read` is paged history, not a result field. Without
`afterPosition` an outside read starts at the **oldest** page (`afterPosition`
defaults to `-1`), 50 items by default, with item text cut at 20,000
characters by default (`<t3>/server` lines 44682-44684, 46174-46185); follow
`nextPosition` while `hasMore`, and fetch the rest of a cut item with
`itemId` and `textOffset` from `nextTextOffset` while `textTruncated`. The
result of a run is the assistant message items whose `runId` is that run's
id, read to the end. "The last assistant message on the first page" is
wrong for any thread longer than one page, and an intermediate assistant
reply is not the result of a later run. Items also carry `visibility`
(`local`, `inherited`, `synthetic`), `sourceThreadId`, `subagentId?`,
`createdBy`, `creationSource` and `senderThreadId?` (`<t3>/runtime` lines
36499-36521). **[source]**

Failures. Every tool declares `failure: OrchestratorMcpFailure,
failureMode: "return"`: a failure is a tool result, not a protocol error. The
failure is the tagged error `OrchestratorMcpFailure {code, message}` with
`code` one of `capability_denied`, `parent_not_active`, `provider_unavailable`,
`model_unavailable`, `runtime_mode_escalation_denied`,
`interaction_mode_escalation_denied`, `task_not_found`,
`task_not_cancellable`, `thread_not_found`, `run_not_found`,
`thread_not_sendable`, `thread_not_interruptible`, `invalid_request`,
`orchestration_error`, `thread_credential_required`, `target_required`
(`<t3>/runtime` lines 36788-36809). The MCP layer returns the encoded
result with `isError` (`<t3>/server` lines 41156-41169), and T3 Code's own
reader treats a value as failed when `isError`, `is_error`, `_tag:
"OrchestratorMcpFailure"` or `error` is present (`<t3>/runtime` line 76239).
The exact JSON of an encoded failure was not captured; a client should accept
`isError: true` with `code` and `message` in the structured content.
**[source; envelope inferred]**

Public source has moved on from the installed build: the current contract
adds `beforePosition`, allows `afterPosition: -1`, caps `maxCharsPerItem` at
20,000 instead of 50,000, and adds `earlierPosition` to read results; and
the public prose that says launch has no retry key is stale, since both the
installed and the current tool accept `clientRequestId` and replay
(`<t3>/server` lines 44234, 46563-46582). Everything in B.2 is the installed
`0.1.8-nightly.20261109.4433`; a fixture should name that version.

**Wait: `t3_thread_wait`** (`<t3>/runtime` lines 36556-36574):

```js
input:  { environmentId?, threadId, runId?, timeoutMs?, untilDelegatedWorkSettled? }
result: { threadId, runId: RunId|null, status: "idle"|RunStatus, timedOut: boolean, next?,
          resultRun?: { runId, status } }
```

A finished run can leave delegated or background work whose final answer
lands in a later run. With `untilDelegatedWorkSettled: true` the wait also
waits for that work, and `resultRun` names the run whose reply is the
thread's result (`<t3>/runtime` lines 36556-36574). `next` is a wake
instruction for a calling T3 thread; an outside client gets no push, so it
calls again with a bounded `timeoutMs` when `next` is absent.

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
  terminal" (`<openclaw>/dist/mcp-auth-login-DAnddU_m.mjs` lines 16-43). The
  browser origin is the transport fact described in A.2 step 4, not proof of
  a browser, so the condition is on the connection, not on the client being a
  web page. Clawtrate's present Node connection (`gateway-client`, `ui` mode,
  no `Origin`) is refused. A Clawtrate desktop connection could start it
  without a plugin when all of these hold **[source; not exercised]**:
  1. it connects in `webchat` mode (origin policy governs only the Control
     UI, browser copilot and webchat clients, or every client when origin
     checks are enforced for all, `ws-origin-policy-sYiBryoo.mjs` lines
     147-155);
  2. it sends an `Origin` that the gateway's origin check accepts and that
     qualifies for the gateway callback: the gateway host over `https`
     matching the request host, or the gateway's published origin, or
     loopback `http` from a local client (`provider-browser-auth-BOjjbaDz.mjs`
     lines 21-31);
  3. its paired device holds `operator.admin`, and any pairing or origin
     approval for that connection identity has been granted;
  4. the server resolves as an operator MCP OAuth connection
     (`resolveOperatorMcpOAuthConnection`, `mcp-auth-login-DAnddU_m.mjs`
     lines 29-41); an `mcp.servers.<name>` entry with `auth:"oauth"` written
     by `config.patch` is expected to qualify **[inferred]**.
  The gateway then receives the authorization redirect on its own callback
  and keeps the tokens; the desktop only shows the link and the steps. A T3
  Code pairing code approves T3 Code's page after the gateway has started the
  OAuth; it does not replace the PKCE exchange or the gateway's precondition
  (`<t3>/server` lines 51779-51809). The other routes stay: `openclaw mcp
  login <name>` on the gateway host, or the gateway's own Settings page.
  OpenClaw's MCP OAuth does dynamic client registration and keeps tokens in
  `mcp_oauth_stores` (`<openclaw>/docs/cli/mcp/transports.md` line 93), so the
  gateway, not Clawtrate, holds the T3 Code credential. Whether OpenClaw
  completes T3 Code's OAuth end to end was **not tested**: both are on paper
  compatible (DCR, PKCE, loopback or https redirect), and the rules forbid
  connecting to the running T3 Code.
- **One bot and not the others** **[probe]**: with `mcp.servers.t3stand` set
  (the committed stdio stand-in `fake-coding-mcp.mjs`) and
  `agents.entries.probe-b.tools.deny: ["t3stand__*"]`, the scripted model's
  request for `probe-a` offered `t3stand__list_threads` and
  `t3stand__send_message`, the one for `probe-b` offered neither, and a bot
  created afterwards (`probe-new`) offered both (rerun with checks, A.11).
  **So, under the fixture's tool policy, the server reaches every bot that
  does not deny it, including bots created later.** A bot can still lose it to
  a restrictive allowlist, a tool profile, a sandbox, a session overlay or a
  failed server connection (final filter `tools-effective-VKbyCQ9I.mjs` lines
  295-305; config and session exclusions
  `agent-bundle-mcp-runtime-config-Wi7aJMuJ.mjs` lines 24-52), and none of
  that is a per-bot server setting. Each policy level
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
  lines 20-85; `<openclaw>/docs/plugins/plugin-permission-requests.md`, "Request
  approval before a tool call"). A veto reaches the model and the tool events
  as a result with `content:[{type:"text", text:<reason>}]` and `details:
  {status:"blocked", deniedReason, reason}`, `deniedReason` defaulting to
  `"plugin-before-tool-call"` (`buildBlockedToolResult`,
  `<openclaw>/dist/agent-tools.before-tool-call-B71Yo63P.mjs` lines
  3687-3701). It is not built as an error result, so a client detects "Not
  sent" from `details.status === "blocked"`, not from `isError`. Resolving an
  approval is `plugin.approval.*` (`operator.approvals`). **[source]**
- **Where a shared setting can live (F-487)**: `users.prefs.get` (`operator.read`)
  and `users.prefs.set` (`operator.write`) store per-person preferences, with a
  `users.prefs.changed {profileId, keys}` event (lines 2429, 2435; `<protocol>`
  `UsersPrefsChangedEvent`). The paired probe device read `{status:"ok",
  entries:{}}` as the `gateway-owner` profile **[probe]**. Entries are keyed
  by strings with JSON values of at most 4,096 bytes each; `null` deletes a
  key; updates are bounded in count and key length, and a compare-and-set
  update can return a conflict (`<openclaw>/dist/user-preferences-9JKSYgKc.mjs`
  lines 12-63; `users-XXBiT3kC.mjs` lines 338-406). Preferences belong to the
  authenticated profile, so two devices share them when both map to the same
  profile. An operator connection without a verified login is attributed to
  the `gateway-owner` profile when roles are not configured or it
  authenticates by gateway token or password
  (`gateway-owner-profile-6q0DpnDA.mjs` lines 45-47); a device that signs in
  as another person does not share them. So this is a per-person store, not a
  gateway-wide one. **[source]**

### B.6 Development stand-in for T3 Code (specification, not built)

A local MCP server that mirrors the operations an outside client uses, so the
skill and the cards can be tested without T3 Code. It mirrors the installed
build `0.1.8-nightly.20261109.4433` (B.2) and says so in its tool
descriptions. A check that passes against it shows the skill and cards handle
this contract; it does not show that a real T3 Code accepts them.

- **Transport**: stdio for the development gateway, listed as
  `mcp.servers.t3code {command: <node>, args: [<stand-in>]}`, so it needs no
  OAuth and no port. A simple server name reaches the model as
  `t3code__<tool>`; the gateway may sanitize or de-duplicate names, so tests
  take the name from the tool inventory or the event's `details.mcpServer`,
  not by building it. Stdio cannot test sign-in, renewal, revoked credentials
  or mode ceilings: F-482 and F-486 keep separate checks. A Streamable HTTP
  mode on a port in the instance's block may be added later; it must answer a
  missing bearer with the 401 body and headers of B.1.
- **Tools and shapes**: names, argument names and result fields as B.2,
  including the nullable and optional ones (`runId: null` and `status: null`
  for an idle launch, `link` optional, `taskId` optional, `nextTextOffset`,
  `visibility`, `sourceThreadId`, `createdBy`, `creationSource` on items).
  - `t3_project_list {cursor?, limit?}` → two projects with full `Project`
    records (`id`, `title`, `workspaceRoot`, `defaultModelSelection`,
    `scripts`, `createdAt`, `updatedAt`, `deletedAt: null`), and one with
    `defaultModelSelection: null`.
  - `orchestrator_capabilities {search?}` → two providers with
    `providerInstanceId` (`codex`, `claude`), models with `options`
    descriptors, and `runtimeModes`.
  - `t3_thread_launch` → as B.2. `modelSelection` is `{instanceId, model,
    options?: [{id, value}]}`; the legacy `provider` alias and object-form
    options are accepted and the result is canonical. Without
    `modelSelection` the project's default is used; with neither, the
    `invalid_request` failure of B.2. Without `projectId` and `scratch`,
    `target_required`. A repeated `clientRequestId` returns the same thread.
    An unknown model is **accepted** at launch, as in T3 Code, and the run
    then ends `failed`; no test may expect a launch-time refusal for it.
    Without `message` the thread is idle with `runId: null`, `status: null`.
- **Failures**: a tool failure is a successful MCP response with `isError:
  true`, `structuredContent: {_tag: "OrchestratorMcpFailure", code, message}`
  and the same JSON as one text item. `code` is from the list in B.2:
  `thread_not_found` for an unknown `threadId`, `target_required`,
  `invalid_request`, `capability_denied` when the stand-in is started
  read-only, `thread_not_interruptible`. A message is always present.
- **Sending**: `t3_thread_send {threadId, message, mode?, freshContext?,
  clientRequestId?}` implements all four modes. `auto`: idle → `started`;
  running → `steered`, appending the message to the current run, which then
  completes with a reply that reflects it (so a test can tell steering from a
  new turn). `queue` → `queued`, a new run after the current one. `steer` on
  an idle thread → `thread_not_sendable`. `restart` → `restarted`: the
  current run ends `interrupted` and a new run starts. `freshContext: true`
  never steers: on a running thread it queues.
- **Reading**: `t3_thread_read` starts at the oldest item when
  `afterPosition` is absent, returns at most `limit` (default 50) items, and
  sets `nextPosition` and `hasMore`. One scripted thread has more than one
  page, and its final assistant reply is longer than `maxCharsPerItem`
  (default 20,000) so it comes back with `textTruncated: true` and
  `nextTextOffset`; `itemId` plus `textOffset` returns the rest. The thread
  also holds an intermediate assistant reply in an earlier run, so a skill
  that takes "the last assistant message on the first page" fails the check.
- **Waiting and lifecycle**: a run moves `running` → `waiting` (for one
  scripted thread) → `completed` after a fixed number of wait or read calls.
  `t3_thread_wait` with `timeoutMs` below the completion point returns
  `timedOut: true`; on an idle thread it returns at once with `status:
  "idle"` and `runId: null`. A message containing `FAIL` ends the run
  `failed`. A message containing `DELEGATE` completes its run while leaving
  delegated work, whose answer arrives in a later run: plain waits return
  `completed` for the first run, and only `untilDelegatedWorkSettled: true`
  waits for the later run and returns `resultRun` naming it. The stand-in
  never returns `next` (that is for calling T3 threads).
- **Stopping**: `t3_thread_interrupt {threadId, runId?, stop?}` →
  `interrupt_requested` for a running run, `no_active_run` when idle; `stop:
  true` ignores `runId`, interrupts whatever runs and drops queued messages.
- **Unsupported inputs are refused, not ignored.** `attachments`,
  `interactionMode: "plan"` and `environmentId` return `invalid_request` with
  a message saying the stand-in does not support them, so a parity check
  cannot pass while claiming behavior the stand-in does not have.
- **State**: deterministic, in memory, lost when the server exits.
- **Results as MCP**: `structuredContent` with the result object, plus one
  text content item holding the same JSON, as the existing stand-in does, so
  `result.details.structuredContent` carries it in tool events (capability map
  section 5).
- **Record**: optionally append each call `{tool, arguments}` to a file named
  by an environment variable, for checks such as F-486's "refused before it
  reaches T3 Code".

The existing `docs/research/dev-gateway/fake-coding-mcp.mjs` has only
`send_message` and `list_threads` and does not mirror T3 Code's names; it is
not this stand-in.

---

## Part C. What Clawtrate should configure

For the designer and the builders. Each statement is marked **[source]**
(read in the installed gateway, T3 Code bundle or docs), **[probe]**
(observed in A.11 or A.13 on a named development instance with scripted
providers, embedded runtime) or **[inferred]**. Nothing here was run against a
real provider, an OAuth account or a running T3 Code.

### C.1 The strictest stock configuration for one bot on one account

Four layers, from the one every bot needs to the ones that close gaps.

| Layer | Exact setting | How it is set, and at which scope | Can a paired client set it? |
| --- | --- | --- | --- |
| 1. The pin | `agents.entries.<bot>.model.primary: "<provider>/<model>@<profileId>"` | `agents.create {model}` or `agents.update {agentId, model}` (string form) or `config.patch` (object form); per bot | Yes, `operator.admin` **[source, probe]** |
| 2. No model fallback | `agents.entries.<bot>.model.fallbacks: []` in the same object; for bots someone else creates without a model, `agents.defaults.model.fallbacks: []` | `config.patch`; per bot, and gateway-wide for the default | Yes, `operator.admin`. A bot with its own model ignores the default's fallbacks **[source, probe]** |
| 3a. A stored one-profile order | the bot's local auth store holds `order.<provider>: ["<profileId>"]` | **Only** the gateway's command line: `openclaw [--profile <p>] models auth order set --provider <provider> --agent <bot> <profileId>`; per bot and provider. `models.authOrderSet` refuses a one-profile order whenever the provider has other profiles | No: no gateway method writes it **[source, probe]** |
| 3b. Or a global one-profile order | `auth.order.<provider>: ["<profileId>"]` | `config.patch`; gateway-wide for that provider | Yes, `operator.admin`, but it forces every bot without a stored order onto that one account, so it cannot serve two bots on two accounts of one provider **[source]** |
| 4. Or a bot-local credential | the account's credential only in that bot's store, and no other profile of that provider in the shared store | sign-in or key entry with that bot's `agentId` (`models.authLogin {agentId}`; `models.authSetApiKey {agentId}` lands locally only when the provider has no `models.providers` entry and no existing profile is replaced, A.8); or `openclaw models auth paste-api-key --agent <bot> --profile-id <id>` | Partly. Only a real separation when the shared store has no other eligible profile of that provider **[source]** |

Also set, because they are separate routes (A.7): the Codex plugin's
`plugins.entries.codex.config.appServer.cyberFailover` if the bot runs on the
Codex harness, global, `config.patch`; and do not offer Anthropic Opus 5.5,
Opus 5, Sonnet 5.5, Fable 5.1 or Fable 5 on a direct API key to a bot that
must stay on its model, since that fallback cannot be switched off per bot.
`agents.defaults.embeddedAgent.cyberFailover` needs no change: a strict
selection already suppresses it. **[source]**

What the probe showed for layers 1+2 and 1+2+3a is in A.13: with the pin
and empty fallbacks only, a 401, 402 or 429 on the pinned account moved the
run to the other account of the same provider; with the stored order added,
the run failed with a visible error instead and never used the other
account. **[probe]**

A bot whose session runtime owns its auth natively (`nativeSessionRuntime.auth:
"native"`, which prepares auth with `allowHarnessAuthProfileForwarding:
false`, `embedded-agent-CPls2oXD.mjs` lines 5604-5609) cannot take the pin at
all: the
run fails with "Auth profile … cannot be forwarded to the selected agent
harness. Configure that harness's native account instead."
(`prepare-auth-DF3PBMSe.mjs` line 137). The account for such a bot is
whatever that harness is signed in with. **[source]**

### C.2 How a run can still end up on another account, model or provider

With layers 1 to 3a in place:

| Route | Account, model or provider? | What a client can observe | What it cannot |
| --- | --- | --- | --- |
| Someone selects another account or model for a conversation: `sessions.patch {model:"…@<other>"}` (`operator.write`), `/model …@<other> -s` in the chat, or the model picker | account or model | The `sessions.patch` result's entry (`authProfileOverride`, `authProfileOverrideSource:"user"`), `sessions.list` `modelOverrideSource:"user"`, `chat.metadata` `accountSelection {authProfileId, source:"user"}`. **[probe]**: it overrode the stored order. | Which client made the change, unless Clawtrate made it |
| The pinned account is removed (`models.authLogout`, or the CLI) | account | The logout strips `@<profileId>` from every bot model that named it and keeps the model (`auth-logout-OeafO1t3.mjs` lines 207-224; `model-failover.md` "Session stickiness"), so `agents.list` / `config.get` show the bot's model without its suffix. The bot is then on automatic selection, and an order whose profiles are all missing is repaired to the remaining stored profiles (`order-hOATlAZf.mjs` lines 198-201) **[source; not probed]** | The next run's account (A.9) |
| Someone changes the bot's model or the order: `agents.update`, `config.patch`, `models auth order set/clear`, or `auth.order` in config | any | `agents.list` model and `config.get` change; `models.authStatus {agentId}` `profileOrder` and `profileOrderLocked` **[source, probe]** | A change to the stored order shows only in `models.authStatus` `profileOrder`, with no event; poll it |
| A provider-entry binding appears (`models.authSetApiKey` on that provider writes `models.providers.<p>.apiKey`) | account | `config.get` shows the binding (redacted value, A.8); `models.authStatus` `profileOrderLocked:"provider-config"` | The binding outranks automatic order for runs without a user selection; whether the bot's configured pin counts as one at that point is read from source (`session-override-5SZAWDJR.mjs` returns it with source `user`, and a user selection skips the binding, `prepare-auth-DF3PBMSe.mjs` lines 158-166) **[source, inferred; not probed]** |
| Pin only, without layer 3: the pinned account fails (auth, billing, rate limit after ten attempts, overload, timeout) | account | A `lifecycle` `finishing` event with `error` and `errorObservation`, then a second `start` and `model` for the same provider and model in the same run; for rate limits `chat` `status` `retry` events. `chat.metadata` `accountSelection` changes one run later. **[probe]** | That another account served the turn, and which. No `fallback_step`, notice, receipt field or history field **[probe]** |
| Pin only: the pinned account is in cooldown at the start of a run (30 s, 60 s, 5 min for auth; 10 min doubling to 24 h for billing; 30 s and up for rate limits) | account | Nothing: the run simply succeeds on another account with no failure event, and once the cooldown ends the next run returns to the pinned account, again with no event **[probe]** | Everything |
| A bot created later, by Clawtrate or elsewhere, without its own model | model or provider | `agents.list` shows no model; it inherits `agents.defaults.model` and its fallbacks **[source]** | — |
| Codex harness cyber escalation, Codex upstream reroute | model | `agent` `notice` `phase:"provider_policy"` with `state` and model fields **[source]** | The account (same harness account) |
| Anthropic server-side refusal fallback | model | `provider_fallback` diagnostic and `responseModel` on the assistant message **[source]** | — |
| Cron jobs with their own `payload.model` and `payload.fallbacks` | model or provider | The cron job's configuration **[source]** | — |
| Utility-model calls (titles and the like) | model, separately routed | Not part of the conversation's turns **[source]** | — |

Under layers 1 to 3a the probe saw none of the rows except the first; the
rest are read in source and docs. On the runtimes and providers not run
(Codex harness, ACP, CLI backends, OAuth providers), the probe does not
apply.

The error a client sees when the strict configuration refuses to move
carries no account name (A.13). Clawtrate can still say which account
failed, because under layer 3a the bot has exactly one: the one in its model
suffix and stored order. That is Clawtrate naming its own binding, not a
gateway report. **[inferred]**

### C.3 What only a plugin could add

Entry points read in the plugin SDK types and docs; none was built or run.
A plugin runs inside the gateway with the gateway's authority over its own
stores; the caller's authority is what its registered method demands.

| Need | Entry points | Caller's authority | Notes |
| --- | --- | --- | --- |
| A gateway method for the stored one-profile order, so Clawtrate can set layer 3a | `api.registerGatewayMethod(name, handler, {scope})` (`config-contracts-C65kIjn4.d.ts` lines 43128-43138); the SDK exports `updateAuthProfileStoreWithLock`, `ensureAuthProfileStore`, `resolveAgentDir` (`plugin-sdk/provider-auth.d.ts`, `plugin-sdk/agent-runtime.d.ts`) | Declared by the plugin; `operator.admin` would match the stock order method. Gateway methods require a verified profile unless declared `profileAccess:"independent"` (`docs/plugins/sdk-overview/infrastructure.md` line 41) | Same effect as the CLI command; must do its own checks that the profile exists and belongs to the provider **[source; inferred design]** |
| A hard fence | `before_agent_run` (receives the run, may return a block decision, `config-contracts-C65kIjn4.d.ts` lines 10060-10077) to refuse a run whose session selection or bot model no longer names the bound account, combined with the one-profile order | Hook code runs with gateway authority; no caller | No plugin hook found that filters auth-profile candidates: `before_model_resolve` returns only model and provider overrides, a provider plugin's `resolveAuthProfileId` only reorders, and no hook event carries an auth profile (searched the `PluginHook*Event` types: `model_call_started`/`ended` have `provider`, `model`, `api`, `transport`, no profile). Within one run, the one-profile order is what stops rotation; the hook guards the conditions around it **[source; inferred design]** |
| A public receipt of the serving account per turn | No hook delivers the serving profile (above); the internal `onSuccessfulAuthBinding` callback is not a plugin hook (A.9) | — | A plugin can only record the *bound* account at `agent_end` and state that, under the fence, a `final` turn can have been served by no other. That is a derived receipt, not the gateway's observation; a true receipt needs the gateway to publish the profile **[inferred]** |
| User-set labels | Plugin-owned records keyed by profile id, behind a plugin method | `operator.read` to list, `operator.admin` to edit would match account management | No stock label field exists (A.3) **[inferred design]** |
| Sign-in below admin | A plugin method at `operator.write` running the provider flow itself; the SDK exports the login runners (`plugin-sdk/provider-auth-login-flow-runtime.js`) | `dispatchGatewayMethod` keeps the caller's authority, so wrapping `models.authLogin` still needs admin (`plugin-sdk/gateway-method-runtime.d.ts`) | Whether a plugin method at `operator.write` may write shared credentials is a policy question the source does not settle; the method must check its own caller and owner. The person's credentials stay on the gateway either way **[source; inferred design]** |

### C.4 T3 Code

**When the desktop app could start the gateway's T3 Code sign-in itself**
(B.5 has the source): a connection in `webchat` mode, sending an `Origin`
that is the gateway host over `https` (matching the request host) or the
gateway's published origin, from a paired device with `operator.admin`,
with any pairing or origin approval granted, for an `mcp.servers` entry with
`auth:"oauth"`. Then `mcp.authLogin {sessionId, serverName}` starts it, the
desktop shows the link and steps from `wizard.*`, the redirect lands on the
gateway's callback, and the gateway keeps the token. The present Node
connection (`ui` mode, no `Origin`) does not qualify. Not exercised end to
end. Otherwise: `openclaw mcp login <name>` on the gateway host, or the
gateway's own Settings page. **[source; not exercised]**

**Giving the T3 Code tools to some bots and not others.**

- Stock gateway: one global `mcp.servers.t3code` entry, and
  `agents.entries.<bot>.tools.deny: ["t3code__*"]` (using the server's actual
  safe name) on every bot that should not have it, written with
  `config.patch` (`operator.admin`). A default-level deny cannot be granted
  back per bot (`docs/tools/multi-agent-sandbox-tools.md`), so the deny goes
  on each bot, and Clawtrate must add it to every bot it creates and check
  for bots created elsewhere, which otherwise get the tools. **[source,
  probe]** An allowlist-based profile per bot is another stock route, not
  tested here.
- With a plugin: a tool factory (`api.registerTool(factory, {optional:
  true})`) receives the trusted `ctx.agentId` and returns no tool for bots
  that are not enabled (`config-contracts-C65kIjn4.d.ts` lines 40570-40595;
  `plugin-sdk/tool-plugin.d.ts` lines 45-56). The plugin then owns its T3
  Code client and token store, and should check the bot again when a tool
  executes, not only when it is offered. `api.registerMcpServerConnectionResolver`
  is keyed by the requesting person, not the bot, so it is not a per-bot
  switch by itself (`docs/plugins/sdk-overview/infrastructure.md` lines
  519-565). A `before_tool_call` hook can enforce per-bot project, provider
  and model limits on the stock server's tools, block with a reason, or ask
  for approval (`operator.approvals` to answer); a block shows as `details.status:
  "blocked"` (B.5). **[source; not built]**

---

## Rows whose target cannot be true as written (summary)

- **F-476** "a Bot bound to one never runs on the other": a bot can select an
  account (A.4), but on a stock gateway with only that selection it moved to
  the other account when its own failed (A.13). It held with a stored
  one-profile order, which only the gateway's command line can write, and
  that order still yields to a conversation's explicit selection and to the
  account's removal (C.2). True as a guarantee only with a plugin that writes
  and guards the order (C.3), or with the owner running the command line.
- **F-479** "each turn's record includes the account the run used": no
  client-visible record names the serving account (A.9). Clawtrate can show
  the account the bot is bound to; under the strict configuration of C.1 that
  is the only account a successful turn can have used, which is an inference
  and not a gateway receipt.
- **F-480** "says which account": errors name the provider and model only
  (A.7, A.13). Under the strict configuration Clawtrate can name the bot's
  one bound account itself. "Never moves a Bot by itself" holds on the probed
  runtime only with the stored order (C.1), and not for Codex's and
  Anthropic's own model routes.
- **F-482** "its access credential, which goes to the gateway's secret store":
  T3 Code has no static credential for outside agents. It uses OAuth with
  30-day sessions; the gateway holds the token. Clawtrate's present
  connection cannot start the gateway's MCP sign-in, but a desktop connection
  that meets the conditions in C.4 could (B.1, B.5).
- **F-483** "turning it on gives the Bot the T3 Code tools", with "off by
  default": a tool server reaches every bot whose tool policy permits it,
  including new ones, so "off" needs a deny on every other bot or a plugin
  (B.5, C.4).
- **F-475** "the key is sent once to the gateway's secret store": keys go to
  the auth-profile store through `models.authSetApiKey`, not to `secrets.*`
  (A.8).
- **F-474** "the client never receives the provider's credential": true for
  the persistent credential. A one-time authorization code passes through the
  client for OpenAI's browser method, and for OpenRouter's from a connection
  without the gateway callback (A.1, A.2).
