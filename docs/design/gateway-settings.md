# OpenClaw's settings inside Clawtrate

How a person changes their OpenClaw gateway's settings from Clawtrate's Settings without knowing a config file exists, and how a bot makes such a change when the person asks it to (issue #794). This is a design for sign-off: it builds nothing. It ends with the order of the pull requests that would build it.

It follows the product's rule (`docs/decisions.md`, "Doing, not asking", and `doing-not-asking.md`): Clawtrate does the thing, shows what it did, and offers Undo; it asks only before something destructive. Changing who can reach or control OpenClaw is "changing OpenClaw itself" in that rule's sense, so that is where this design asks.

**Established** marks what OpenClaw's published packages, the repository, or a run on a development gateway of each version showed. **Proposed** marks this design's choice. **Not established** marks what could not be shown here, with what would show it (section 13). `<1006>/…` and `<1110>/…` are paths inside `openclaw@2026.10.6` and `openclaw@2026.11.10`; 2026.11.10's `dist/` is minified, so for it the file and the schema are named instead of a line. The runs were on one development gateway at a time, an instance of this repository's `pnpm dev-gateway` on each version, with no seed and no real account.

It builds on, and doesn't redesign:

- **Bots in Clawtrate** (`bots-in-clawtrate.md`): the silent check that sorts a bot's call as the person's ask (A), in their conversation but not their ask (B) or not from the person (C); the journal and Undo of its section 5; the `clawtrate-bots` plugin. Section 8 here adds one tool to it and changes one row of its section 3.3.
- **Bots and accounts** (`bots.md`) and **Connect an account as provider tiles** (#797): accounts stay in Accounts. Models here shows the account behind each model and links there.
- **Clawtrate installs its own plugins** (#796) and **explanations behind an "i"** (#798): Plugins here lists what #796 installs; every explanation in these forms sits behind an "i".

## The page to decide from

### What a person sees

Settings gains four sections, between Accounts and Conversation, and one at the end:

| Section                   | What it is for                                                                                                  | Picture                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Models**                | The default model every bot uses, the account it runs on, what to try if it can't answer, how long bots think   | [Models after a change](gateway-settings/models-done-desktop.png), [light](gateway-settings/models-done-light-desktop.png)                        |
| **Chat apps**             | Connecting Telegram, WhatsApp and the other chat apps, who answers there and who may write                      | [Chat apps](gateway-settings/chat-desktop.png), [Telegram](gateway-settings/telegram-desktop.png), [Say hello](gateway-settings/pair-desktop.png) |
| **Plugins**               | What is installed on OpenClaw, Clawtrate's own first, each with a switch and its settings                       | [Plugins](gateway-settings/plugins-desktop.png)                                                                                                   |
| **All OpenClaw settings** | Every other setting, found by search, each with its own control; a secret is "Set" or "Not set" and never shown | [Two changes that restart once](gateway-settings/all-pending-desktop.png), [a refused value](gateway-settings/all-error-phone.png)                |

No config key is shown unless the person opens a setting's "i", where it sits under the explanation.

A change in a form applies at once and leaves one quiet line, "Default model is now Swift 2, on Work. · Undo". A change that restarts OpenClaw says so beside the setting before it is made ("Restarts OpenClaw"), several such changes wait together under one **Save and restart**, and while OpenClaw restarts a line above Settings says so ([picture](gateway-settings/restart-desktop.png)).

![Models, after the default model changed, with Undo](gateway-settings/models-done-desktop.png)

### What a bot does when asked

"Make Swift 2 the default for everyone" is done at once in the conversation, with the same line and Undo. "Let my laptop reach you over Tailscale" asks first, in the conversation, with the change written out and what it means ([picture](gateway-settings/bot-desktop.png), [phone](gateway-settings/bot-phone.png)). A bot never sets a secret, never widens what bots may do, and never touches Clawtrate's own plugins (section 8.4).

![A bot changing the default model at once, and asking before it changes who can reach OpenClaw](gateway-settings/bot-desktop.png)

### The decisions, one line each

1. **Forms:** Models, Chat apps and Plugins get forms of their own; Accounts stays as #797 makes it. Each form writes through the one engine that already owns its settings (section 2).
2. **Chat apps:** Clawtrate drives OpenClaw's own channel set-up over the connection (`wizard.start {flow: "channels"}`) and draws each step in its own form; the only thing opened outside Clawtrate is the chat app itself, where the chat app makes its bot or shows its pairing code.
3. **All OpenClaw settings:** a searchable, structured view drawn from the gateway's own schema and labels, not a file. Secrets are write-only. A value is checked against the schema before it is sent, and the gateway's own refusal is shown under the field.
4. **Undo:** each change is a journal entry on the gateway (the bots plugin's, section 6), Undo for 7 days or until the same setting changes again; a secret's old value is never kept, and its field says so before the change.
5. **Restart:** the gateway restarts by itself when a change needs it; Clawtrate gathers restart-needing edits into one save, says what running tasks will do, and confirms the change applied after it reconnects.
6. **A bot's change:** one new tool, `clawtrate_settings`, in the bots plugin, applying through Clawtrate with the person's access; done at once for A, not done for B and C, and asks first for anything that changes who can reach or control OpenClaw.
7. **Without full control, on another device, on an unknown version:** read-only forms with one line, the same journal on every device, and forms drawn from the gateway's schema so an unknown version gets the editor and the forms whose settings it has.
8. **Ships first:** Models (default model with its account, fallbacks, thinking), with the core that every later form uses.

### Least sure of

Section 13 opens with the three decisions this design is least sure of, each with its alternative: drawing OpenClaw's own chat-app set-up, the words of a bot's change line, and holding restart changes for one save.

---

## Contents

1. What the gateway offers, on each version
2. What Clawtrate already writes, and one writer for each setting
3. Where it lives in Settings
4. The forms
5. All OpenClaw settings
6. Undo
7. Restart
8. A bot changing a setting when asked
9. Two devices, another computer, no full control, an unknown version, the iPhone
10. The order of pull requests
11. Proposed checklist rows
12. Not doing, and why
13. Not established, and what would establish it
14. The prototype's states

## 1. What the gateway offers, on each version

### 1.1 Reading and writing settings (Established, both versions, read and run)

| Method                       | Scope            | What it does                                                                                                                                                                                                                          | Source                                                                                                                      |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `config.get`                 | `operator.read`  | The saved config with every secret replaced by `__OPENCLAW_REDACTED__`, its authored `hash`, `configRevisionHash` (saved) and `appliedConfigHash` (what the running gateway accepted), `valid`, `issues`, `warnings`; `raw` is `null` | `<1006>/dist/config-Bo7RGaun.mjs:613`; `<1006>/dist/core-method-policy-DkntKRY_.mjs:186-190`; run on both                   |
| `config.schema`              | `operator.read`  | The whole schema with `uiHints`: for each path a label, a group, a help text, `advanced` and `sensitive`. Plugin and channel schemas are in it when loadable                                                                          | `:635`; `<1006>/docs/gateway/protocol/rpc-talk-config-and-agents.md:65`; run on both (about 4 MB, 8,226 hints on 2026.10.6) |
| `config.schema.lookup`       | `operator.read`  | One path: its schema node, hint, immediate children and `reloadKind` (`restart`, `hot` or `none`)                                                                                                                                     | `:639`; `rpc-talk-config-and-agents.md:66`; run on both                                                                     |
| `config.patch`               | `operator.admin` | A JSON merge patch of the config, with `baseHash`, `replacePaths` (to shrink an array), and optional `sessionKey`, `note`, `restartDelayMs`. Answers `changedPaths`, the new `hash` and a restart sentinel with `requiresRestart`     | `:689-786`; `<1006>/dist/sessions-B6HQw2nf.mjs:1249-1263`; run on both                                                      |
| `config.set`, `config.apply` | `operator.admin` | Replace the whole config. Clawtrate never uses them: a whole replacement can drop what another device wrote                                                                                                                           | `:656`, `:787`                                                                                                              |
| `config.openFile`            | `operator.admin` | Opens the file in an editor on the gateway's computer. Not advertised; not used                                                                                                                                                       | `:810`; `core-method-policy-DkntKRY_.mjs:1920`                                                                              |

The same scopes on 2026.11.10 (`<1110>/dist/core-method-policy-DeU1xgVA.mjs`), which also says it in words: "`config.get` requires `operator.read`; config mutations … require `operator.admin`" (`<1110>/docs/gateway/protocol/rpc-talk-config-and-agents.md:83`).

**How a concurrent write is guarded.** Once a config file exists, every write but one needs `baseHash` from a fresh `config.get`. Run on both versions:

- no `baseHash`: "config base hash required for session.idleMinutes; re-run config.get and retry with baseHash" (`config-Bo7RGaun.mjs:746`). The one exception is `ui.prefs`, last writer wins (`:593`).
- a stale one: "config changed since last load; re-run config.get and retry" (`:245`).

**How a bad value is refused.** The gateway validates the whole merged config before it writes anything, and answers `INVALID_REQUEST` with `details.issues[]`, each with `path`, `message` and, for a choice, `allowedValues`. Run on both: `gateway.bind: "everywhere"` gave "invalid config: gateway.bind: Invalid input (allowed: "auto", "lan", "loopback", "custom", "tailnet")"; an unknown key gave "invalid config: session: Unrecognized key: "nonsenseKey"". Nothing was written either time. The gateway also refuses a patch that would empty an array without `replacePaths` (`:736`) and checks that every secret reference still resolves (`:466-480`).

**Secrets.** `config.get` redacts every path the schema marks `sensitive` (218 such paths on 2026.10.6, 223 on 2026.11.10: `gateway.auth.token`, `models.providers.*.apiKey`, `hooks.token`, channel tokens, TLS keys, header values and more). A patch that sends the sentinel back keeps the stored secret: `restoreRedactedValues` (`:731`). Run on both: patching `models.providers.scripted.apiKey` with the sentinel answered `noop: true, changedPaths: []`. So a form can send a whole object it read and never lose a secret, and a secret can only be replaced, never read.

**Restart or reload.** Every changed path is planned as `restart`, `hot` or `none` (`<1006>/docs/gateway/configuration/hot-reload.md`, "What hot-applies vs what needs a restart"; the same table in `<1110>`). Models, agents, auth profiles, tools, plugins' entries and most of `channels.*` apply hot; `gateway.port`, `gateway.bind`, the auth mode, Tailscale, TLS, the Control UI's path and wide-area discovery restart. A path no rule matches restarts. The write's answer carries `sentinel.payload.stats.requiresRestart`. Run on both: `messages.ackReaction` answered `requiresRestart: false` and applied before the answer; `gateway.controlUi.basePath` answered `requiresRestart: true`, then the gateway restarted in-process by itself.

| Run (`gateway.controlUi.basePath`) | 2026.10.6                                                        | 2026.11.10                                                              |
| ---------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Answer                             | `ok`, `requiresRestart: true`, no `restart` field                | The same                                                                |
| Next 2 seconds                     | Gateway closes admission: "SIGUSR2: config reload"               | `config.get` reads `configRevisionHash ≠ appliedConfigHash` (unapplied) |
| Unreachable                        | About 8 seconds (connection refused)                             | About 8 seconds                                                         |
| Back                               | Same process, in-process restart; saved and applied hashes equal | The same                                                                |

In the default `hybrid` reload mode the gateway's reload owner restarts it; with `gateway.reload.mode: "off"` the write itself schedules the restart (`scheduleDirectRestart`, `config-Bo7RGaun.mjs:143-153, 214`). Either way **nobody has to restart it by hand**. Restart requests coalesce and then wait out a 30-second cooldown, and writes are limited to 30 a minute per method and device (`<1006>/docs/gateway/configuration/config-rpc.md:36-39`; the same in `<1110>`).

**A lost answer.** A write whose answer never came may still have been saved. OpenClaw's own guidance on 2026.11.10 is never to replay it: read again, compare the saved settings, classify `applied`, `unapplied`, `indeterminate` or `unsupported` from the two revision hashes (`<1110>/docs/gateway/protocol/rpc-talk-config-and-agents.md:76-150`). 2026.10.6 has the same fields and no such section.

**Changing the gateway's own sign-in.** A write that changes the shared token or password disconnects every client that signed in with it (`disconnectSharedAuthClients`, `config-Bo7RGaun.mjs:494`; `hot-reload.md`, "Gateway credentials … old shared-auth clients reconnect"). Clawtrate connects with a paired device token, which this does not end; a device that connected with the shared token is cut off.

### 1.2 The shape of the settings, and what differs

**Established (run).** `config.schema` has 45 top-level sections on 2026.10.6 and 47 on 2026.11.10, which adds `database` and `repositoryBranchPrefix` and retires none at the top. Below the top, 59 paths in the first four levels are gone on 2026.11.10 and 166 are new. The ones that matter here:

- **Retired:** `agents.defaults.heartbeat` and every channel's `heartbeatVisibility` (check-ins became ordinary routines: `<1110>/docs/gateway/heartbeat.md`, "Heartbeat migration"; `packages/core/src/check-ins.ts:16-24` already reads which kind of gateway it is from the schema); `skills.workshop`; `tools.github.kind`, `profileId`, `gitAuthor`.
- **New:** `tools.openclaw.autoApproveChanges` (a standing grant for bots' delegated changes, section 1.5), `tools.gatewayPolicy`, `gateway.openclawId` (a sign-in service), `database.postgres.connection` (a secret), `session.communication`, `cron.agents`, `cron.creators`, `cron.defaultTools`, `channels.msteams.accounts`.
- **Secrets added:** `database.postgres.connection`, `env.vars.*`, `tools.github.app.privateKey` (and per bot), `channels.msteams.accounts.*.appPassword`.
- **A write can change paths nobody sent.** On 2026.11.10 a patch of `messages.ackReaction` answered `changedPaths: ["plugins.entries.skill-workshop", "messages.ackReaction"]`: the gateway applied a migration of its own in the same write. Undo must put back only what Clawtrate wrote (section 6).

The schema's own hints give every path a human label and a help text ("Gateway Bind Mode", "Network bind profile: …"), and a group for each section. Those labels are OpenClaw's words; the forms use Clawtrate's, the editor falls back to OpenClaw's (section 5).

### 1.3 Chat apps (Established, both versions, read)

- `channels.status` (`operator.read`) lists each chat app and account with its state. `channels.start`, `channels.stop`, `channels.logout` (`operator.admin`) (`<1006>/docs/gateway/protocol/rpc-system-and-channels.md:52-55`; `<1110>/…:55-58`).
- **The gateway's own channel set-up runs over the connection:** `wizard.start {flow: "channels", channel}` (`operator.admin`), then `wizard.next`, with steps of kind `note`, `select`, `text`, `confirm`, `multiselect`, `progress` and `action`, a step's `sensitive` flag for a secret, an optional `externalUrl` and `deviceCode`, and at the end the `channels` and `accounts` it configured (`<1006>/dist/users-BUx10Lx0.mjs:62-68`; `<1110>/dist/users-DQ-MuWzs.mjs`, `WizardStartParamsSchema` and `WizardStepSchema`; `core-method-policy-DkntKRY_.mjs:413`). It is the same step format Clawtrate already draws for a model sign-in (`packages/core/src/accounts-engine.ts:1220`, `models.authLogin` followed with `wizard.next`).
- **QR sign-in** (WhatsApp and other QR chat apps): `web.login.start {channel}` returns a QR picture, `web.login.wait` finishes and starts the channel (`rpc-system-and-channels.md:56-57`; on 2026.11.10 an `accountId` is required when the channel has more than one account, `:59`).
- **Who may write to the bot:** by default a chat app's direct messages are on `dmPolicy: "pairing"`: a new sender gets a code and no answer until approved (`<1006>/docs/channels/telegram.md:14`). `channels.pairing.list` and `channels.pairing.approve {channel, code, expectedOwnerId}` approve one (`rpc-system-and-channels.md:62-86`).
- **Telegram** needs a bot token that only Telegram makes, in a chat with @BotFather (`<1006>/docs/channels/telegram/setup.md:16-47`). There is no way round that step; it happens inside Telegram.

### 1.4 What a connection without full control can do (Established)

Read everything above that is `operator.read`: the redacted config, the schema, every lookup, `channels.status`, `plugins.list`. Write nothing: every config write, the channel wizard, QR sign-in and every plugin change is `operator.admin`.

### 1.5 What a bot can already do to settings without Clawtrate (Established, both versions, read)

- **The `gateway` tool reads only.** "`gateway` reads config with `config.schema.lookup` / `config.get` … It has no config-write … action" (`<1006>/docs/gateway/security/tool-permissions.md:15`). On 2026.11.10 it also has `restart` and `update.cleanup` (`<1110>/…:15`). It is owner-only: "non-owner senders cannot use the `cron` or `gateway` tools" (`<1006>/docs/gateway/security/hardened-baseline.md:38`).
- **The `openclaw` tool writes, through typed operations** ("write config, `config set`, `config unset`, … change the default model, start/stop/restart the Gateway, create agents, and install plugins"). For a bot's delegated request: **Full Access applies the change with no prompt**, "including when Full Access comes from the configured default"; a restricted run asks in the chat it came from, where only the owner can approve (`<1006>/docs/cli/openclaw.md:118-135`). 2026.11.10 is the same, and adds `tools.openclaw.autoApproveChanges` to force approval even in Full Access, or to grant it standing (`<1110>/docs/cli/openclaw.md:118-150`).
- **So today, with nothing set, a bot whose runs are Full Access can change OpenClaw's settings when asked, with no prompt, no journal and no Undo.** `bots-in-clawtrate.md` §3.3 already holds the `openclaw` tool behind OpenClaw's own approval once the bots plugin is installed; section 8.5 changes what that hold does in a Clawtrate conversation.
- Neither version has a precondition that binds a bot's change to what the person saw, and a plugin's gateway call acts as its run's connection (`bots-in-clawtrate.md` §5.1).

## 2. What Clawtrate already writes, and one writer for each setting

**Established (on `main`).** Every place Clawtrate writes to the gateway's config or what it owns today:

| What                                                   | Settings it writes                                                      | Through                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A bot's model, effort and empty fallbacks (#573, #697) | `agents.entries.<bot>.model`, `thinkingDefault`                         | `AccountsEngine.patch` (`packages/core/src/accounts-engine.ts:1831-1856`), then `writeModel` |
| An account's label                                     | `auth.profiles.<id>.displayName`                                        | the same, `setLabel` (`:1860-1885`)                                                          |
| Which accounts a bot may use, the lock (#697)          | the gateway's auth order                                                | `models.authOrderSet` (`:951`, `:1111`)                                                      |
| Signing accounts in and out                            | the gateway's credential stores                                         | `models.authLogin`, `authSetApiKey`, `authLogout` (`:1264`, `:1772`, `:1919`)                |
| A bot's name and picture                               | the agent record, `IDENTITY.md`                                         | `agents.update`, `agents.files.set` (`bot-names.ts:263, 334`; `accounts-engine.ts:2200`)     |
| Check-ins (2026.10.6)                                  | `agents.entries.<bot>.heartbeat`                                        | `check-ins.ts:737`                                                                           |
| Where a bot runs its commands                          | `agents.entries.<bot>.tools.exec`                                       | `machines.ts:950`                                                                            |
| Guides                                                 | the guide section of each bot's `AGENTS.md`; history in `users.prefs`   | `guides.ts:516, 195`                                                                         |
| Bot voice                                              | the voice plugin's own setting                                          | `clawtrate-voice.set` (`voice.ts:120`)                                                       |
| Who may manage bots, in the bots plugin                | `plugins.entries.clawtrate-bots.config.managers`                        | the plugin itself (`plugins/clawtrate-bots/lib/bots.js:348`)                                 |
| Routines' delivery                                     | reads `hooks` only                                                      | `routines.ts:1473`                                                                           |
| One-click Connect (#689)                               | nothing on the gateway: reads `openclaw.json` on this computer, bounded | `apps/desktop/src/setup/settings-reader.ts`                                                  |
| Device approval                                        | the gateway's device list                                               | `device.pair.approve` (`setup-effortless.md` §5)                                             |

**Proposed: one writer for each setting.** A new core module, `gateway-settings.ts`, owns reading the config and schema, the draft, the write with `baseHash`, the read-back and the restart watch. It owns no setting that another engine already writes. It holds one table, **owners**, from a path prefix to the engine that writes it and the Settings section that shows it:

| Path                                                       | Owner                                 | Shown in                     |
| ---------------------------------------------------------- | ------------------------------------- | ---------------------------- |
| `agents.entries.<bot>.model`, `thinkingDefault`, `auth.*`  | `accounts-engine.ts`                  | the bot's settings, Accounts |
| `agents.defaults.model`, `agents.defaults.thinkingDefault` | `accounts-engine.ts`, extended (§4.1) | Models                       |
| `agents.entries.<bot>.heartbeat`                           | `check-ins.ts`                        | Check-ins                    |
| `agents.entries.<bot>.tools.exec`                          | `machines.ts`                         | Machines                     |
| `plugins.entries.clawtrate-*`                              | that plugin's own method              | Plugins                      |
| `channels.*`, `bindings`, `commands.ownerAllowFrom`        | `gateway-settings.ts`, Chat apps      | Chat apps                    |
| everything else                                            | `gateway-settings.ts`                 | All OpenClaw settings        |

All OpenClaw settings shows an owned path read-only, with its value and a link to the section that owns it ("Change in Models"). A change from a bot (section 8) is routed by the same table. A test fails if two engines' write paths overlap.

## 3. Where it lives in Settings

**Proposed.** Settings' list (`packages/ui/src/Settings.tsx:146-158`) becomes: Gateway, Accounts, **Models**, **Chat apps**, **Plugins**, Conversation, Usage, Machines, Check-ins, Updates, **All OpenClaw settings**, Advanced. Each new row has its search line in `SETTINGS_SECTIONS` ("The default model, and what to try if it can't answer"; "Telegram, WhatsApp and other chat apps"; "What's installed on OpenClaw"; "Every other OpenClaw setting"). **Why four and not one "OpenClaw" section with pages:** each is a thing a person looks for by name, and search already finds sections; a section of sections is one more panel.

Search in All OpenClaw settings is its own field. The app's search palette (`search.md`) finds the sections, not individual settings; finding a setting by its label from the palette is left for later (section 12).

## 4. The forms

Every form follows four rules. **Validated before the write:** the value against its schema node (type, choices, bounds, pattern), and against what the gateway lists (a model the gateway offers, a bot that exists). **One write:** `config.patch` with a fresh `baseHash`, only the paths changed. **Read back:** the form shows the new value only after `config.get` reads it with `appliedConfigHash` equal to `configRevisionHash`, as `AccountsEngine.patch` already does (`accounts-engine.ts:1844-1855`), at most 20 seconds. **A quiet line:** one line under the form with Undo, announced once for a screen reader; no toast, no card.

### 4.1 Models

What a person sees ([picture](gateway-settings/models-done-desktop.png), [phone](gateway-settings/models-phone.png)):

- **For every bot:** **Default model**, a picker of the models the gateway offers on signed-in accounts, each with its account ("Swift 2 · Work"), and under it "Acme · runs on your Work account"; **If it can't answer**, the ordered backup models ("Then Globex One, on Team"), up to three, with Change; **Thinking**, Low, Medium or High.
- **Each bot:** its model and account, "The default: Swift 2 on Work" or its own; **Change** opens that bot's settings, where its model already lives (`bots.md`).
- The "i" beside each: one plain sentence, and the key under it (`agents.defaults.model.primary`).

What it writes: `agents.defaults.model.primary`, `agents.defaults.model.fallbacks` (with `replacePaths`), `agents.defaults.thinkingDefault`. All hot on both versions (`hot-reload.md`, "Agent & models"). **Why through `accounts-engine.ts`:** the model list, the account behind each model and the per-bot write are there; a second module listing models would disagree with it. A model on an account that is signed out is listed under "Needs you to sign in again" and isn't offered.

How it joins #797: an account that isn't connected yet appears at the end of the picker as "Connect another account…", which opens Accounts' provider tiles and comes back here when the sign-in ends.

### 4.2 Accounts

Unchanged here: #797 designs its tiles. This design adds nothing to Accounts but the link from Models.

### 4.3 Chat apps

What a person sees ([picture](gateway-settings/chat-desktop.png)): the chat apps connected, each with who answers there and who may write ("Juniper answers · only you can message it"), and below them a tile for each chat app this gateway can connect, read from `channels.status` and the schema's channel sections. Each tile carries the chat app's own logo, by #797's decision for providers; the prototype draws a stand-in letter.

Connecting one, step by step, with no outside page for instructions:

1. **Connect** ([picture](gateway-settings/telegram-desktop.png), [phone](gateway-settings/telegram-phone.png)). Clawtrate starts the gateway's own set-up for that chat app (`wizard.start {flow: "channels", channel}`) and draws each step in its own form: a `text` step as a field, a `sensitive` one as a password field, a `select` as a picker, a `progress` step as a waiting line, a `note` as one line. Where a step needs the chat app itself (Telegram's @BotFather), Clawtrate says the three things to do there in its own words and offers one button that opens the chat app at that place ("Open BotFather in Telegram"); a step's `externalUrl` to a documentation page is never shown. For a QR chat app, the QR picture from `web.login.start` is shown in the form, with "Open WhatsApp › Linked devices › Link a device", and the step ends on `web.login.wait`. **Who answers there** is a picker of the person's bots, the Main Bot first; it writes the chat app's binding.
2. **Say hello** ([picture](gateway-settings/pair-desktop.png)). "Now send your bot any message from Telegram, so it knows it's you." Clawtrate waits on `channels.pairing.list` and shows the sender's handle and first words, with **That's me** and **Not me**. **That's me** approves that sender (`channels.pairing.approve`) and adds them to the owner list (`commands.ownerAllowFrom`), so OpenClaw treats them as its owner there (`bots-in-clawtrate.md` §3.3). **Not me** dismisses the request. The line under it: "Only you can message the bot. Anyone else gets no answer until you let them in, here."
3. Done: "Telegram is connected. Only you can message Juniper there · Undo". Undo disconnects it (`channels.logout`, then the patch that removes what step 1 wrote).

**Why the gateway's own set-up and not Clawtrate's own form per chat app:** OpenClaw knows each chat app's fields, checks and accounts on each version, and every plugin chat app brings its own; a Clawtrate form per app would be wrong the day OpenClaw changes one. Clawtrate's part is drawing it in its own look and doing the owner step. A chat app whose set-up can't be done without a desktop page of the chat app's own (a developer portal) shows that one button with its steps in Clawtrate, and is marked "Needs a few steps in <app>" on its tile.

**Opening a connected one:** who answers there, who may write (only you; people you let in, listed with Remove; anyone, which asks first, section 8.3, and for a person's own press, below), Stop and Start (`channels.stop`, `channels.start`), and **Disconnect**, which asks ("Disconnect Telegram? Its token is removed from OpenClaw; connecting again needs a new one from BotFather.") because the token isn't kept.

### 4.4 Plugins

What a person sees ([picture](gateway-settings/plugins-desktop.png)): **Clawtrate's** first, each "Installed by Clawtrate · <version>" with its switch (#796 installs them; `bots-in-clawtrate.md` §6.6 says what Turn off and Remove do); then **On your OpenClaw**, from `plugins.list`, each with where it came from ("Comes with OpenClaw", "Added on the gateway"), its switch (`plugins.entries.<id>.enabled`, hot) and **Settings**, a form drawn from that plugin's own schema section exactly as section 5 draws any other. A plugin the gateway's `plugins.deny` names shows "Turned off in OpenClaw's settings".

**Not here:** installing a plugin that isn't Clawtrate's own. It is "installing into OpenClaw a program that isn't Clawtrate's own pinned code", which asks (`doing-not-asking.md`), and it needs its own design: what is shown before the code runs, and the catalog (`plugins.catalog.*`). Section 12.

## 5. All OpenClaw settings

**What it is** ([picture](gateway-settings/all-pending-desktop.png), [read-only](gateway-settings/all-readonly-desktop.png), [phone, refused](gateway-settings/all-error-phone.png)): a search field over every setting's label, help text and key, and the matching settings grouped under the schema's groups ("Gateway · 4 of 212 settings"). Each setting is one row: its label, an "i" with OpenClaw's help text and the key, "Restarts OpenClaw" when its `reloadKind` is `restart`, and a control chosen by its schema node:

| Schema node                                                  | Control                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| boolean                                                      | a switch                                                                                                               |
| a closed choice (`enum`, `const` alternatives)               | a picker with the choices in OpenClaw's words, Clawtrate's own where it has them ("This computer only" for `loopback`) |
| number, integer                                              | a number field with its bounds                                                                                         |
| string                                                       | a text field, with its pattern                                                                                         |
| a list of strings                                            | a list with Add and Remove                                                                                             |
| a map or a list of objects                                   | rows, each opening the same view one level down                                                                        |
| `sensitive`                                                  | **"Set"** or **"Not set"**, and Replace or Set; never the value                                                        |
| anything the view can't draw (`anyOf` of objects, free-form) | a small JSON field for that one value, checked against its node                                                        |

**Why not the raw file:** the file holds comments, includes and environment references that a merge patch never touches, and a person shown it has to know JSON5; the honest minimum is the schema, which both versions serve with labels. The JSON field for one value is the only text box, and only where no control fits.

**Settings with no label in the schema** are shown by their key, last in their group, under "More". **An owned path** (section 2) is read-only here with "Change in Models".

**Secrets are write-only.** The row never shows a value; `config.get` doesn't send one. **Replace** opens a password field; its save sends only that path. Under the field, before the save: "The old one isn't kept, so this can't be undone." For `gateway.auth.token` and `gateway.auth.password`, also: "Apps signed in with the old one are signed out. Clawtrate stays connected." (section 1.1). Removing a secret is a delete and asks.

**A bad value is refused before it reaches the gateway**: checked against its node as the person types, the error under the field in plain words ("Use a number from 1 to 65535. Nothing was changed."), the save not offered. What the gateway still refuses (a rule its schema node doesn't carry, a secret reference that no longer resolves) is shown the same way, from `details.issues[].message`, under the field its `path` names, and nothing changes.

**Applying.** A change to a `hot` or `none` setting applies when its control commits (a switch at once, a field on Enter or leaving it), with the quiet line and Undo. A change to a `restart` setting waits in the section's foot: "2 changes · saving restarts OpenClaw once. Running tasks pause and pick up again. **Discard** · **Save and restart**". The press is the request: no confirmation follows, unless the change is one that asks (section 8.3 lists them; for the person's own change they ask only where the change could lock this device out, below).

**Getting back from a mistake:** Undo on the line, and **Recent changes** at the top of the section, each with Undo for 7 days (section 6).

**Locking yourself out.** Before saving a change to the address, port, bind, auth mode, TLS or Tailscale settings, Clawtrate works out whether this device could still connect afterwards from how it connects now (loopback, the address it dialled, its auth). If not, it asks: "After this, this device can't reach OpenClaw: it connects over your local network, and OpenClaw would listen on this computer only. **Change anyway** · **Keep**". This is the one ask the person's own change meets, because what follows can't be undone from Clawtrate.

## 6. Undo

**Proposed.** What `doing-not-asking.md` §1 says Undo is, holds here.

- **What is kept:** one journal entry per change, in the `clawtrate-bots` plugin's journal on the gateway (`bots-in-clawtrate.md` §5.4), written through its admin method: the paths Clawtrate sent, each one's value before and after (non-secret paths only), the `hash` the write left, who made it (this device, or a bot with its run and origin), the time. **Only the paths Clawtrate sent**, never the extra paths a gateway migration added to `changedPaths` (section 1.2). Up to 64 KiB per entry; a larger change (a long list replaced) keeps the paths and says "Can't be undone: too large to keep" in its line before it is made.
- **Until the plugin is on the gateway:** the entry is kept on the device that made the change, in the host's storage, for the same 7 days, and Undo is offered there only. Bounded: 200 entries per gateway, registered in `owners.ts` and the documented totals.
- **Where Undo is offered:** in the change's own line, and in **Recent changes** in All OpenClaw settings and in the section the change belongs to, on every device connected to that gateway.
- **For how long:** 7 days, or until the same path changes again. The journal keeps the entry for 90 days without Undo.
- **What Undo does:** reads `config.get`; if every path still holds the value the change wrote, writes the values before with that read's `baseHash`; otherwise writes nothing and says "Changed since: Default model is now Deep 1 · Open". Undo of a restart change restarts again, and says so in its button ("Undo and restart").
- **What can't be undone, said before the change:** a secret replaced or set (its old value was never readable); a chat app disconnected (its token goes); a plugin removed (`bots-in-clawtrate.md` §6.6). Each says so where it is made, in the line under the field or in its one confirmation.

## 7. Restart

**Proposed, on the facts of section 1.1.**

- **When:** the gateway decides, from the paths saved. Clawtrate knows beforehand from `config.schema.lookup`'s `reloadKind` for each path, to put "Restarts OpenClaw" beside it; the write's `requiresRestart` is what it trusts afterwards.
- **Who triggers it:** the gateway, by itself, in both reload modes. Clawtrate never sends a restart and never calls `update.run`.
- **Several changes share one restart:** restart settings wait together in the foot and go in one `config.patch`; the gateway also coalesces restarts and keeps a 30-second cooldown. A form's hot change made while restart changes wait is applied on its own and doesn't flush them.
- **What running bots and tasks experience, by version** (the gateway sends nothing that says which, so this is the one place this design tells by version, with `openClawAtLeast` from `packages/core/src/gateway-version.ts`):
  - **2026.10.6:** the gateway stops taking new work and waits for running turns to finish, up to 5 minutes, then restarts (`<1006>/docs/gateway/restart-recovery.md:152-166`). The foot says "Saving restarts OpenClaw once its bots finish what they're doing."
  - **2026.11.10:** running work stops promptly; at the next start each interrupted conversation gets one input to pick up where it left off, and a task a bot started stops and its requester is told (`<1110>/docs/gateway/restart-recovery.md:11-21, 162-169`). The foot says "Running tasks pause and pick up again."
  - **An unknown version** gets the 2026.11.10 sentence, the cautious one.
- **What the person sees:** the line above Settings and above the shell, "OpenClaw is restarting to apply Who can reach OpenClaw. Running tasks pick up where they left off." in place of the connection banner's "Reconnecting". Conversations show their own state as they do for any reconnect.
- **How Clawtrate comes back:** the client's usual reconnect; then `config.get` until saved and applied revisions are equal, at most 2 minutes on 2026.10.6 (the drain) and 60 seconds otherwise. Then the line "Who can reach OpenClaw is now Your private network · Undo and restart". If the gateway doesn't come back in that time, the line says "OpenClaw hasn't come back after the restart" with what Clawtrate last read, and nothing is retried. If it comes back with the revisions unequal, "Saved, but OpenClaw hasn't applied it yet", as `machines.ts:987` already handles that answer.

## 8. A bot changing a setting when asked

### 8.1 The tool

**Proposed:** one tool in `clawtrate-bots`, beside those of `bots-in-clawtrate.md` §2:

```
clawtrate_settings {
  find?: string,                      // words to look for, up to 80 characters
  set?: [{ setting: string, value: JSON | null }]   // 1 to 5 settings, by key
}
```

- **`find`** returns up to 10 settings whose label, help or key match: key, Clawtrate's label, kind of value, its choices, whether it restarts, whether it asks first, and **the current value only when it is a boolean, a number or one of a closed set of choices**. Free text, secrets, lists and maps are returned as "has a value" or "not set". **Why:** a value someone else wrote (a bot's earlier text, a channel's name) would be outside content, and returning it would make the rest of the run B (`bots-in-clawtrate.md` §4.3); these kinds can't carry instructions.
- **`set`** asks for the change; Clawtrate applies it (`bots-in-clawtrate.md` §5.2) with the person's own access, routed by section 2's owners. All the settings in one call are one change, one journal entry and one Undo, and share one restart.
- Description (240 characters at most): "Find and change OpenClaw's settings when your person asks, like the default model or a chat app's options. It applies at once with Undo; changing who can reach OpenClaw asks your person first."
- What it returns uses `bots-in-clawtrate.md` §7.3's words, and for a refusal by a bound: "That setting isn't one Clawtrate knows.", "A bot can't set a secret. Ask your person to type it in Settings › Chat apps."

### 8.2 When a request counts as the person's

The rule of `bots-in-clawtrate.md` §4.3, unchanged. A call is **A** when the plugin says its run was typed here, the device that applies it sent that run in that conversation, and the run read nothing from outside before the call. Then:

| Origin | What happens                                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | Done at once with Undo; the ones in 8.3 ask first                                                                                                                                                         |
| B      | Not done, said plainly: "Juniper tried to change the default model after reading a web page. Nothing was changed." The person's settings are what §3 of the bots design keeps from anything but their ask |
| C      | Not done (another bot, a routine's or check-in's run, a chat-app message, the gateway's own page, a started task)                                                                                         |

A request in a chat app from OpenClaw's owner (O) through Clawtrate's tool is not done either: Clawtrate can show it was the owner's ask only in Clawtrate. The owner keeps OpenClaw's own route there (8.5).

### 8.3 What always asks first

Even for A, a change to any of these asks in the conversation ([picture](gateway-settings/bot-desktop.png)), in one card: the setting in Clawtrate's words, the old and the new value, one sentence of what it means and whether it restarts, **Change** and **Keep**. The card waits 24 hours, then ends.

- **Who can reach OpenClaw:** `gateway.bind`, `gateway.port`, `gateway.mode`, `gateway.customBindHost`, `gateway.tailscale.*`, `gateway.tls.*`, `gateway.remote.*`, `gateway.publicOrigin`, `gateway.trustedProxies`, `gateway.allowRealIpFallback`, `gateway.http.endpoints`, `gateway.controlUi.*`, `discovery.*`, `hooks.enabled`, `hooks.path`, `gateway.openclawId.*`.
- **Who can control it:** `gateway.auth.*` (other than a secret, below), `gateway.roles`, `gateway.nodes.pairing.*`, `commands.ownerAllowFrom`, `accessGroups`.
- **Who can write to the bots:** each chat app's `dmPolicy`, `allowFrom`, `groupPolicy`, `groups`, and approving a pairing request.
- **Anything that turns approvals off or widens them:** `approvals.*`, `security.*`.
- **A setting the classifier doesn't know** (not in this build's lists and not under a prefix it knows): asks. An unknown version's new paths therefore ask until a build classifies them.

### 8.4 What a bot can never change

Refused with the reason, whatever the origin; the person can make each in Settings:

- **A secret's value** (every `sensitive` path, and `env.*`, `secrets.*`). A secret should be typed into a write-only field, not pass through a model and its transcript.
- **Anything that lets bots do more:** `tools.*` and `agents.*.tools.*` where the change widens (an allow added, a deny removed, a profile, exec `security` or `ask` loosened, elevated mode), `tools.openclaw.autoApproveChanges: true`, `tools.gatewayPolicy`, `agents.*.sandbox`. Tightening is done for A, as `clawtrate_change`'s rules are (`bots-in-clawtrate.md` §3.1).
- **Clawtrate's own plugins** (`plugins.entries.clawtrate-*`, their `hooks`, `plugins.allow`, `plugins.deny`, `plugins.load`, `plugins.installs`), and installing, enabling or removing any plugin.
- **`gateway.auth.mode: "none"`.**
- **`update.*`** and OpenClaw's version: updates keep OpenClaw's own approval (`bots-in-clawtrate.md` §3.3).
- **Settings another engine owns** that the bots design gives a tool of its own (a bot's account, its check-ins) are routed to that tool's rule.

### 8.5 OpenClaw's own route, held

**Proposed change to `bots-in-clawtrate.md` §3.3's `openclaw` row:** in a run that is A, the plugin's `before_tool_call` refuses the `openclaw` tool's config-writing operations with the reason "Use clawtrate_settings: it applies the change with Undo", so the bot makes the change through Clawtrate and it is journaled. **Why not OpenClaw's approval, as that row says now:** for a change the person just asked for, an approval card is a prompt the rule forbids. In every other origin the row stands: O keeps OpenClaw's own approval in the chat it came from; B and C are not done.

### 8.6 How it is attributed

- **In the conversation:** "Default model is now Swift 2, on Work · Undo", from the journal entry. **Not** "changed by Juniper at your request": an A line states what happened and never says the person asked, because A shows only that the change could be their ask (`doing-not-asking.md` §1).
- **In Recent changes:** "Default model · Swift 1 → Swift 2 · Juniper, in your conversation · 9:14 · Undo", where "your conversation" opens it. A change the person made in Settings reads "You, on this Mac".

### 8.7 What the security review has to look at

1. **The classifier of 8.3 and 8.4**: that every path that changes who can reach or control OpenClaw, or widens a bot, is in it on both versions, with a test over both versions' schemas that fails for a path under `gateway.*`, `channels.*.dmPolicy`, `approvals.*` or any `sensitive` path that neither asks nor is refused; and that unknown paths ask.
2. **The hold of 8.5**: that the `openclaw` tool's write operations are recognised from its typed operation names on both versions, including in Code Mode and through tool search (`bots-in-clawtrate.md` §12, first item).
3. **`find`'s answers**: that nothing it returns can carry text a bot or a chat app wrote.
4. **Lock-out**: the reachability check of section 5 and the card of 8.3 for this device and for the person's other devices.
5. **Undo of a tightening**: a bot tightens a setting with A, the person's Undo re-opens it; Undo is the person's press, but a bot has no Undo tool, and the review confirms none is added.
6. **Rate:** at most 10 `set` calls an hour per bot and 3 asks waiting at a time, inside the gateway's 30 writes a minute.
7. **Lost answers**: a write whose answer is lost is never replayed (section 1.1); its line says "Couldn't confirm" with what Clawtrate now reads.

## 9. Two devices, another computer, no full control, an unknown version, the iPhone

- **Two devices.** Each reads the config when a section opens and after any write; a write refused for a stale `baseHash` keeps the person's edit, reads again and says "Changed on another device just now. Your change is still here to save." The journal is on the gateway, so Recent changes and Undo are the same on both. A restart from one device shows its line on the other from the disconnect and the unequal revisions.
- **A gateway on another computer.** The same forms and editor. A restart there takes longer to come back over a tunnel; the 60- and 120-second waits hold. The lock-out check reads the address this device dialled, so changing the bind of a gateway reached over the network asks.
- **A connection without full control** ([picture](gateway-settings/all-readonly-desktop.png)). Every section reads; controls are read-only; one line at the top, "This device can see OpenClaw's settings but not change them." with **Ask for full control**, setup's existing request. A bot's `set` on such a device's request waits for a device with full control, as `bots-in-clawtrate.md` §5.3 says.
- **A version the forms don't know.** Each form checks its paths with `config.schema.lookup` when it opens, never the version: a field whose path isn't in the schema isn't drawn, and a form with none of its paths says "This OpenClaw keeps these elsewhere" and links to All OpenClaw settings, which draws whatever the schema has. 2026.11.10's retired `agents.defaults.heartbeat` is the case this rule already handles in `check-ins.ts`.
- **The iPhone app** (`apps/mobile`, another thread's; nothing there changes here): it would need the same core module to show these sections, and a phone-width layout, which the prototype draws ([phone](gateway-settings/models-phone.png)). Until then the phone shows none of them; a bot's change asked for on the phone is applied by a desktop as B (not done), per `bots-in-clawtrate.md` §9.

## 10. The order of pull requests

Each is releasable alone and checked on development gateways of both versions.

1. **Models, and the core every form uses.** `gateway-settings.ts` (read, schema lookups, owners table, write with `baseHash`, read-back, restart watch), `accounts-engine.ts` extended with the defaults, the Models section with its quiet lines, and Undo kept on the device. **The smallest thing that gives the owner the main thing:** pick the model every bot uses and see the account it runs on. Tested: a scenario on each version that changes the default model and reads it back applied; a stale-hash refusal kept as an edit; Undo when unchanged and when changed since; the owners table's overlap test; unit tests for each sentence; pictures at desktop and phone, dark and light.
2. **Restart.** The foot's gathered save, the line above the shell, the version sentences, the wait and the "hasn't come back" line. Tested: a scenario per version saving `gateway.controlUi.basePath` and coming back applied; two restart changes in one write; the drain wording by version.
3. **All OpenClaw settings, without secrets.** Search, groups, controls by node, the JSON field, client checks and the gateway's issues under the field, owned paths read-only, the lock-out check. Tested: the controls against both versions' schemas (every node kind drawn or given the JSON field), a refused value per kind, the lock-out ask.
4. **Secrets, write-only,** and the words before a change that can't be undone. Tested: a secret never in any answer Clawtrate keeps or logs; Replace sends one path; the sentinel kept on an unrelated write.
5. **Plugins.** The list, switches and each plugin's settings form; Clawtrate's own from #796. Tested on each version with a development plugin.
6. **Chat apps.** The channel set-up drawn from the gateway's wizard, QR sign-in, Say hello with That's me, a connected app's page, Disconnect. Tested with a stand-in channel plugin on the development gateway (no real chat app), both versions.
7. **The journal on the gateway.** Entries written through the bots plugin, Undo and Recent changes on every device. Needs `bots-in-clawtrate.md` step 3.
8. **`clawtrate_settings`,** its classifier, the cards of 8.3 and the hold of 8.5, with the security review of 8.7. Needs 7 and `bots-in-clawtrate.md` step 2. Tested: one scenario per origin (A done, A asks, B not done, C not done), one per hold, each failing with its rule undone.

## 11. Proposed checklist rows

No ids are held for this design; they are proposed here and numbered by the pull request that makes each true.

| area     | platform | behavior                                                                                                                                               | target                                                 | gateway dependency                                      |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------- |
| Settings | both     | Settings › Models changes the default model, its backups and thinking for every bot, shows the account behind each, with Undo.                         | same                                                   | `config.patch`, `models.list`                           |
| Settings | both     | A change that restarts OpenClaw says so first, several share one restart, and Clawtrate comes back and confirms it applied.                            | better: running tasks' fate said by version            | `config.patch`, `config.get` revisions                  |
| Settings | both     | Settings › All OpenClaw settings finds and changes any setting with its own control; secrets are write-only; a bad value is refused before it is sent. | better: no file, no key unless asked                   | `config.schema`, `config.schema.lookup`                 |
| Settings | desktop  | Settings › Chat apps connects a chat app inside Clawtrate and makes the person its only sender.                                                        | better: no outside instructions                        | `wizard.start {flow: "channels"}`, `channels.pairing.*` |
| Settings | both     | Settings › Plugins lists what is installed, Clawtrate's first, with a switch and settings for each.                                                    | same                                                   | `plugins.list`, `config.patch`                          |
| Bots     | both     | Asked to, a bot changes an OpenClaw setting at once with Undo, and asks first before changing who can reach or control OpenClaw.                       | better: never sets a secret or widens what bots may do | `clawtrate-bots`, `config.patch`                        |

## 12. Not doing, and why

- **A raw config file editor.** Comments, includes and environment references make it unsafe to round-trip, and the schema serves everything a person needs (section 5).
- **Installing plugins that aren't Clawtrate's own.** It asks by the rule and needs its own design of what is shown before code runs.
- **A bot setting a secret, updating OpenClaw or touching Clawtrate's plugins** (8.4).
- **Reading a secret back.** OpenClaw never sends one, and nothing here adds a way.
- **Checking a credential by calling the provider.** The gateway's own checks, and the account's sign-in in Accounts, decide.
- **Per-bot overrides in All OpenClaw settings.** A bot's own settings live in its settings tab (`bots.md`, `controls.md`); the editor shows `agents.entries.<bot>` read-only beside a link there.
- **Finding a single setting from the app's search palette.** Settings' sections are found there today; individual settings can join later.
- **Editing an included file separately.** Writes go through `config.patch`, which decides where a value lands (section 13).

## 13. Not established, and what would establish it

The three this design is least sure of first, each with the alternative:

1. **Drawing the gateway's own channel set-up (`wizard.start {flow: "channels"}`) in Clawtrate's look.** Read in both versions' schemas, not run: the development gateway has no channel. Its steps may lean on `externalUrl` and a documentation-shaped `note` so much that Clawtrate's rewording of each chat app becomes the real work. **Alternative:** Clawtrate's own short form for the two most used chat apps (a token field for Telegram, the QR for WhatsApp), writing `channels.<app>` with `config.patch`, and the wizard for the rest. A run with a stand-in channel plugin, step 6, settles it.
2. **The line for a bot's change says what happened, not "at your request".** The brief for this design asked for "changed by Juniper at your request"; this design follows `doing-not-asking.md` §1, which keeps A from being presented as proof of the person's ask, and shows "Juniper, in your conversation" in Recent changes. **Alternative:** the brief's wording in Recent changes only, where the conversation is one press away.
3. **Restart settings wait in the foot for one Save, while every other change applies at once.** Two behaviours in one section. **Alternative:** every change applies at once, and a second restart change within the 30-second cooldown simply joins the gateway's coalesced restart; simpler, but a person changing port then bind would see two restarts if they are slower than the cooldown.

Also:

- **A whole set-up through `wizard.start {flow: "channels"}` and `web.login.*`** on either version: not run.
- **`channels.pairing.approve`'s `expectedOwnerId`**, and whether approving a sender and adding them to `commands.ownerAllowFrom` is one step or two on each version: read, not run.
- **Where `config.patch` writes a value whose section lives in an `$include`d file:** not read.
- **Whether `before_tool_call` sees the `openclaw` tool's operation name** in a form the hold of 8.5 can match on both versions: not run.
- **The 2-minute wait on 2026.10.6:** the drain budget is 5 minutes by default; whether most restarts finish within 2 was not measured with a running turn.
- **Whether a config write is rate-limited per device and IP** for Clawtrate's connector exactly as the docs say: read, not run.
- **Which chat apps each version can connect without installing a plugin**: `channels.status` on a development gateway lists none configured; the bundled list was not established.

## 14. The prototype's states

`docs/design/prototype/gateway-settings.html`, on local fixtures; every name, model, account and handle is made up, and no token appears. `?screen=` picks a section: `models` (the default), `chat`, `telegram`, `pair`, `plugins`, `all`, `bot`. With it: `done=1` the quiet line with Undo (models, plugins); `pending=1` two restart changes waiting (all); `error=1` a refused value (all); `restart=1` the line while OpenClaw restarts; `access=read` a connection without full control; `q=` the search. The prototype bar's theme, width and motion apply.

| Picture                                                                                                 | State                        |
| ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| [models-done-desktop](gateway-settings/models-done-desktop.png)                                         | `screen=models&done=1`, dark |
| [models-done-light-desktop](gateway-settings/models-done-light-desktop.png)                             | the same, light              |
| [models-phone](gateway-settings/models-phone.png)                                                       | `screen=models`, phone       |
| [chat-desktop](gateway-settings/chat-desktop.png)                                                       | `screen=chat`                |
| [telegram-desktop](gateway-settings/telegram-desktop.png), [phone](gateway-settings/telegram-phone.png) | `screen=telegram`            |
| [pair-desktop](gateway-settings/pair-desktop.png)                                                       | `screen=pair`                |
| [plugins-desktop](gateway-settings/plugins-desktop.png)                                                 | `screen=plugins`             |
| [all-pending-desktop](gateway-settings/all-pending-desktop.png)                                         | `screen=all&pending=1`       |
| [all-error-phone](gateway-settings/all-error-phone.png)                                                 | `screen=all&error=1`, phone  |
| [all-readonly-desktop](gateway-settings/all-readonly-desktop.png)                                       | `screen=all&access=read`     |
| [restart-desktop](gateway-settings/restart-desktop.png)                                                 | `screen=all&restart=1`       |
| [bot-desktop](gateway-settings/bot-desktop.png), [phone](gateway-settings/bot-phone.png)                | `screen=bot`                 |

Pictures are taken at 1100 × 720 and 390 × 844 with `chrome=0&motion=reduce`, with the design's fonts loaded.
