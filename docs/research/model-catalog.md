# The model list: where it comes from and how it gets newer

Why a bot's Model menu can miss models a provider already offers, checked against OpenClaw 2026.10.6, the version `docs/decisions.md` names, and against OpenClaw 2026.11.6, the newest release on npm when this was written. It is the evidence behind parity row F-478 and the Model menu of `docs/design/bots.md` section 9.

How to read the citations, as in `steer-stop.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, and `<openclaw-11.6>/…` one inside the 2026.11.6 package, unpacked with `npm pack openclaw@2026.11.6` and never installed. Bundled chunk names change with every release; search by the `//#region <source path>` marker given with each citation. Line numbers are of the 2026.10.6 chunks.
- `<protocol>` is `@openclaw/gateway-protocol` 2026.10.6, `dist/catalog-WA519PXd.mjs`.
- **Live** means it was run on a development instance, and the output is quoted. **Source** means it was read in shipped code or documentation only.

Where it was run: a named instance, `pnpm dev-gateway start --instance models --with-accounts --no-seed`, with the scripted providers `acme` and `globex`. The probe is [`dev-gateway/models/probe.mjs`](dev-gateway/models/probe.mjs). The instance was reset when the work ended. No real provider was used, so nothing here was checked against a real ChatGPT account.

## Summary

| #   | Question                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                          | Section |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Where does the Model menu's list come from?                 | One `models.list {agentId}` with no `view`, which is the gateway's picker, not its catalogue. Clawtrate kept the first 128 rows across every provider, then showed the rows of the bot's provider. **Source.**                                                                                                                                                                                                  | 1       |
| 2   | What does the picker leave out?                             | `view: "default"` keeps models a provider entry in `models.providers` declares, models an allowlist names, and route-managed models (OpenAI's) only when the account backs them. `view: "all"` returns the whole catalogue; `provider` narrows it to one provider. Each answer is whole, with no pages, and no model carries a release date: the order is the gateway's own. **Source; live for the parameters.**                                                                                                          | 2       |
| 2a  | Whose availability does a read give?                        | A read for a bot (`agentId`) is that bot's automatic account selection; a read for a task (`sessionKey`) projects the task's selected account. Neither is a verdict for an account a bot isn't on yet. **Source.**                                                                                                                                                                                                                                             | 2a      |
| 3   | What does OpenClaw 2026.10.6 know about OpenAI's models?    | Its manifest lists no `gpt-6.2-*` model. A ChatGPT sign-in's list comes from the bundled Codex app-server (`@openai/codex` 0.160.0), and ChatGPT gates new models on the Codex version that runs the turn. **Source.**                                                                                                                                                                                           | 3       |
| 4   | Does a newer OpenClaw fix it?                               | 2026.11.6 has the same manifest, but bundles `@openai/codex` 0.162.1, uses a newer `codex` found on the gateway's `PATH` when it is safe, and reports that binary's version to ChatGPT, so the list matches it. Its changelog: "refresh bundled Codex support for newer ChatGPT models". **Source, not run.**                                                                                                     | 4       |
| 5   | Does the gateway take a model id its catalogue doesn't list? | Yes. `agents.create`, `config.patch` and `sessions.patch` accepted `acme/dev-9`, which no catalogue lists, and a run on it asked the provider for `dev-9` on the bound account. The provider decides. `models.list` still doesn't list it, even for the bot that uses it. **Live.**                                                                                                                            | 5       |
| 6   | How can a person use a model newer than the list?          | The list follows the Codex build the gateway runs, the gateway takes ids it doesn't list (section 5), and no gateway method says which Codex version a model needs. So Clawtrate keeps no model list of its own: it shows the gateway's, lets a person type an id it lacks, and says when the gateway reports a newer OpenClaw. **Source.** | 6       |
| 7   | Can the gateway say that it is out of date?                 | For OpenClaw itself, yes: `hello-ok` `snapshot.updateAvailable` and the `update.available` event carry `{currentVersion, latestVersion, channel}` to every connection, and `update.status` (admin) the same. For a provider's model list, only that a refresh failed (`refreshFailed`) or is still pending (`pendingProviders`); nothing says which Codex version a model needs. **Source; live for the shapes.** | 7       |

## 1. Where Clawtrate's list came from

As found on `main` at `ba6f10fe`:

- The accounts engine read the catalogue once per refresh: `ctx.request("models.list", { agentId: defaultBot })`, with no `view` (`packages/core/src/accounts-engine.ts` lines 226-228).
- `readCatalog` kept at most `MAX_CATALOG_MODELS` rows, 128, across every provider (`packages/core/src/accounts.ts` lines 22-23 and 659). The gateway orders providers by id, so a provider late in the alphabet could lose rows on a gateway with many providers.
- The menu showed `modelsOf(accounts, provider)`, the rows of the bot's provider, in the gateway's order (`packages/ui/src/bots/words.ts` lines 268-270; `packages/ui/src/bots/ModelPair.tsx`).

Nothing else sorted or filtered the rows.

## 2. The gateway's views

### Source

`ModelsListParams` takes `agentId`, `sessionKey`, `authProfileId`, `provider`, `includeDetails`, `preparedOnly`, `refresh` and `view: "default" | "configured" | "provider-config" | "all"` (`<protocol>` lines 1355-1383). All of them are one method at `operator.read` (`docs/decisions.md`, "Read-only flows").

`prepareLogicalVisibleModelCatalog` (`<openclaw>/dist/model-catalog-visibility-Cpi0Jvw4.mjs`, region `src/agents/model-catalog-visibility.ts`):

- `view: "all"` takes every catalogue entry (line 67) and publishes it after ordering (line 133). The selection policies are skipped for it (`<openclaw>/dist/models-list-result-Dx7spcW4.mjs` line 686, region `src/gateway/server-methods/models-list-result.ts`). The operator role's own model policy still applies afterwards, in the handler (`<openclaw>/dist/models-qLzDNS0G.mjs` lines 104-108, region `src/gateway/server-methods/models.ts`).
- Any other view keeps the configured and allowed rows (lines 134-139), then drops a route-managed row unless it is configured or the account backs it (lines 156-160), and drops `deprecated` and `disabled` rows unless configured (lines 166-169). OpenAI's rows are route-managed (`routePolicy: openAIModelCatalogRoutePolicy`, `models-list-result` line 705).
- A configured row is one a provider entry in `models.providers` declares, or one named by the default model, the fallbacks or an allowlist (`agents.defaults.models`, `agents.<id>.models`) (`<openclaw>/dist/model-visibility-policy-HwJqwXi4.mjs` lines 14-29; `<openclaw>/dist/model-selection-shared-PnWvZr7n.mjs` line 626).

The order: "Provider catalogs declare models strongest-first. Preserve that owner order" (`<openclaw>/dist/model-catalog-order-CjmCH0dm.mjs` lines 6-9), with a provider's hosted `recommendedModels` first and the session's selected model before everything (lines 71-90). A row the hosted catalogue recommends carries `recommended: true` (`<protocol>` `ModelChoiceSchema`, lines 1435-1457). No field of a row gives a release date, so nothing a client receives says which model is newest; the picker and `view: "all"` share this one ordering (`model-catalog-visibility` line 131).

One answer holds the whole list: `ModelsListResultSchema` has `models`, the markers `refreshFailed`, `pendingProviders` and `providerOutcomes`, and no cursor (`<protocol>` lines 1458-1514), and `ModelsListParams` takes no page (lines 1355-1383). A client that keeps fewer rows than the gateway sends can only say so. An answer that carries `pendingProviders` naming the provider, or `refreshFailed`, is the rows the gateway had so far: Clawtrate shows them, says the list may not be complete, offers to ask again, and says the gateway lists no more models only after a complete answer. The full list is read each time "View more" is opened and held by that dialog alone, so nothing of it can outlive a gateway upgrade, a reconnect or another gateway.

The gateway's own documentation names `view: "all"` as the full list: "Use the Models page **Refresh** action (`models.list` with `view: "all"` and `refresh: true`) to publish the full catalog for the selected agent" (`<openclaw>/docs/plugins/codex-harness-reference/model-discovery.md`).

### Live

The scripted providers are declared in `models.providers`, so every one of their rows is configured, and the default view and `view: "all"` agree on a development instance, with an allowlist naming `acme/dev-1` alone as well. `provider` narrows `view: "all"` to that provider:

```
## models.list {agentId} (no allowlist)
[ "scripted/dev-1", "acme/dev-1", "acme/dev-2", "globex/dev-1" ]
## models.list {agentId, view:all, provider:acme}
[ "acme/dev-1", "acme/dev-2" ]
ok   with configured providers, the default view equals view:all
```

What the default view drops (an OpenAI row the account does not back, or one outside an allowlist) cannot be shown with the scripted providers.

### Live: the picker asked alongside other reads

On the end-to-end checks' development instance, `models.list {agentId}` sent while the same client's `config.get`, `users.prefs.get` and `models.authStatus` reads were still in flight was refused, twice, with `Chat metadata access changed while preparing its metadata. Retry the request.` Asked once those had answered, it was answered. So the account read asks for the picker last.

## 2a. Whose availability a read gives

### Source

- `models.list {agentId}` with no session resolves that agent's catalogue with automatic account selection: "`models.list {agentId}` listed every configured provider's models for every bot, all `available:true`, with `accountSelection: {kind:"automatic"}`" (`provider-accounts-and-t3-code.md` A.6, probe). A bot bound to one account (`<provider>/<model>@<account>`) reaches the projection only through a session (same section).
- `models.list {sessionKey}` projects the session's selected account into the catalogue (`resolveSessionCatalogProfiles`, `<openclaw>/dist/chat-metadata-session-projection-DuoPBWYl.mjs` lines 173-187; `prepareSelectedAccountCatalog`, `models-list-result` lines 446-474), also for `view: "all"`: the handler projects every view but `provider-config` (`<openclaw>/dist/models-qLzDNS0G.mjs` lines 98-103).
- `models.list {authProfileId}` selects a personal account only (A.6), so there is no read for a shared account a bot isn't on yet, such as the one chosen in New bot.

- Each answer names the account it was read for: `accountSelection` is `{kind: "automatic"}`, or `{kind: "personal" | "shared", authProfileId}` (`<protocol>` `ChatAccountSelectionSchema`, lines 1334-1353, "Configured preference only; provider failover can use a different account"), filled from the session's selection or the requester's (`models-list-result` lines 522-526). On a development instance a read for a bot answered `accountSelection` alongside `models` (probe, "result keys").

So a row's `available` is the gateway's verdict for the account its read was for, and nothing more. The Model menu keeps the picker's verdicts as they were before this work, the default bot's shown for every account (#407), and puts none on the full list's rows behind "View more": those say the provider decides. The OpenClaw documentation for Codex says the same of listings in general: "Listing does not prove account entitlement" (`<openclaw>/docs/plugins/codex-harness-reference/model-discovery.md`).

## 3. OpenAI's models in 2026.10.6

### Source

- The OpenAI plugin's manifest lists, in order, `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` and `gpt-5.5-pro` (both `deprecated`), and the `gpt-5.4` family (`<openclaw>/dist/extensions/openai/openclaw.plugin.json` lines 74-616). No `gpt-6.2-*` and no `gpt-6.1-terra`.
- A ChatGPT sign-in's models come from Codex: "By default, the Codex plugin asks the app-server for available models. Model availability is owned by Codex app-server, so the list can change when OpenClaw upgrades the bundled `@openai/codex` version" (`<openclaw>/docs/plugins/codex-harness-reference/model-discovery.md`). The bundled harness is `@openai/codex` 0.160.0, whose unauthenticated `model/list` the same page quotes: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`. "Authenticated catalogs can differ."
- So a `gpt-6.1-terra` in a menu came from the account's Codex discovery, not the manifest.

## 4. OpenClaw 2026.11.6

`npm view openclaw dist-tags` on the day: `latest` 2026.11.6, `extended-stable` 2026.10.33, `beta` 2026.11.10-beta.1.

### Source

- The OpenAI manifest is the same list (`<openclaw-11.6>/dist/extensions/openai/openclaw.plugin.json`), with `gpt-4.1` added.
- The bundled harness is `@openai/codex` 0.162.1 (`<openclaw-11.6>/docs/plugins/codex-harness-reference/model-discovery.md`).
- "ChatGPT gates new models on the Codex version that runs the turn, so OpenClaw uses a newer Codex from `PATH` (for example `npm i -g @openai/codex`, a Bun global install, Homebrew, or the standalone installer) when it is safe, and the shipped binary otherwise." It must be a native executable or the official npm launcher, newer and stable, of the same major version, and pass an `initialize` handshake (`<openclaw-11.6>/docs/plugins/codex-harness-reference/app-server-transport.md`, "Newer installed Codex"). The 2026.10.6 page has no such section.
- "ChatGPT-login model discovery reports the selected binary's version as its `client_version`, so the list matches the binary that runs turns" (`<openclaw-11.6>/docs/plugins/codex-harness-reference/model-discovery.md`).
- Changelog, 2026.11.6: "refresh bundled Codex support for newer ChatGPT models" (`<openclaw-11.6>/CHANGELOG.md` line 15).

Not established: which Codex version first lists `gpt-6.2-sol` and `gpt-6.2-astra`, and whether 0.162.1 alone does.

## 5. A model id the catalogue doesn't list

### Live

`acme/dev-9` is in no catalogue. With an allowlist naming `acme/dev-1` only:

```
## agents.create {model: acme/dev-9@acme:work}
{ "ok": true, "agentId": "unlisted", ..., "model": "acme/dev-9@acme:work" }
ok   agents.create accepts an unlisted model id
ok   the bot's own unlisted model is not in its catalogue
## run on the unlisted model: terminal
{ "state": "final" }
## scripted model's record for that session
[ { "account": "acme:work", "credential": "api_key", "model": "dev-9", "session": "agent:unlisted:probe", "status": 200 } ]
ok   the provider was asked for dev-9 on the bound account
## sessions.patch {model: acme/dev-9}
{ "ok": true, ... }
```

The gateway passed the id to the provider, which decides. The scripted model answers any id; what a real provider, or Codex in front of OpenAI, does with an id it doesn't serve was not observed.

### Source

For Codex: "Catalog membership does not reject arbitrary model overrides" (`<openclaw>/docs/plugins/codex-harness-reference/model-discovery.md`). Whether ChatGPT serves a model to an older Codex is ChatGPT's decision (section 4).

## 6. A model newer than the gateway's list

### Source

- A ChatGPT sign-in's list is the one Codex's app-server gives the gateway, and it follows the Codex build that runs turns: "ChatGPT-login model discovery reports the selected binary's version as its `client_version`, so the list matches the binary that runs turns" (`<openclaw-11.6>/docs/plugins/codex-harness-reference/model-discovery.md`; section 4).
- The gateway takes an id its catalogue doesn't list and passes it to the provider (section 5): "Catalog membership does not reject arbitrary model overrides" (`<openclaw>/docs/plugins/codex-harness-reference/model-discovery.md`).
- No gateway method reports the Codex version the gateway runs, or the version a model needs (section 7).

So Clawtrate shows the gateway's own lists and keeps no model list of its own: that would be Clawtrate saying what the gateway hasn't established.

## 7. Update signals

### Source

- `hello-ok` `snapshot.updateAvailable` is `{currentVersion, latestVersion, channel}` when the gateway's last update check found a newer OpenClaw, for any connection (`<openclaw>/dist/health-state-DDhO15ZI.mjs` lines 57-82, region `src/gateway/server/health-state.ts`; `<openclaw>/dist/events-ds0bML-H.mjs` lines 17-24). It is set from the check's saved state only when the latest version is newer than the running one (`<openclaw>/dist/update-startup-CW6kDiwm.mjs` lines 235-246, region `src/infra/update-startup.ts`).
- The `update.available` event carries `{updateAvailable}` when that changes, with no scope required (`<openclaw>/dist/server-start-D6vaUNGz.mjs` line 4299; `<openclaw>/dist/server-startup-post-attach-CAUsg7sV.mjs` lines 576-583, region `src/gateway/server-startup-update-check.ts`).
- `update.status` (`operator.admin`, `<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 1132-1136) answers `{sentinel, updateAvailable, effectiveChannel, schedule, activeRun?, lastRun?}` (`<openclaw>/dist/update-DdfLxzzM.mjs` lines 792-799, region `src/gateway/server-methods/update-status.ts`).
- The command the gateway's documentation gives is `openclaw update` on the gateway's machine (`<openclaw>/docs/cli/update.md`).
- For models, `models.list` answers `refreshFailed: true` when the catalogue's last refresh failed and `pendingProviders` while a provider's discovery is still running (`models-list-result` lines 530-535). No field names the Codex version or which models a newer one would add.

### Live

A development instance never checks for updates (`update: { checkOnStart: false }`), so both are empty there:

```
## hello-ok snapshot.updateAvailable
null
## update.status
{ "updateAvailable": null, "keys": [ "sentinel", "updateAvailable", "effectiveChannel", "schedule" ] }
```

## What follows for Clawtrate

- Show the gateway's picker as the menu did before, its unavailable models disabled. Behind "View more", read the provider's full list (`view: "all"`) when it is opened, and show the models the picker lacks in the gateway's order, never called newest first, with no availability verdict. Say when it is loading, failed or longer than kept, and offer no "View more" on a gateway that refuses `view: "all"` (F-478).
- Ask for the picker after the account reads, never alongside them: the gateway refuses it while they prepare the bots' metadata.
- Let a person type a model id the catalogue doesn't list, and leave the decision to the provider.
- When the gateway reports `updateAvailable`, say near the Model menu that a newer OpenClaw is out and give `openclaw update`.
- For OpenAI's newest models on a ChatGPT sign-in: update OpenClaw to 2026.11.6 or newer and keep a current `codex` on the gateway's `PATH`. That is what the documentation establishes; it was not run against a real account.
