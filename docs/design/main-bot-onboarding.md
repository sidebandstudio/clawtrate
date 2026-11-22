# The Main Bot, the autonomy choice, and bots that set themselves up

Issue #292. A fresh start opens on a chat with the Main Bot. It greets you, and a small card under its greeting asks what to call it and how it should help. When you save, the sidebar and the chat's header change as soon as the gateway confirms the new name. Before that, one question sets how bots run commands. Later, a bot can ask to change its own settings, a bot you allow can ask to create or change other bots, and an external agent you allow can see bots and suggest changes through MCP. **A bot never changes a setting by itself: you confirm each change, on a card that shows exactly what will be written.** Every change goes through the gateway's own methods, and Clawtrate shows only what the gateway confirmed.

It builds on:

- **Effortless setup** (the setup work's effortless-setup design, not yet on `main`). That design covers everything up to step 3 of its §7. This one is the autonomy step and the Main Bot's chat. Its PR 6 owns the measurement from pairing to the composer and to the first reply; section 3 adds one more.
- **The avatar studio** (#302's design, not yet on `main`). The Main Bot can take the name's Claw of its §2 as its first picture, as an explicit edit. Its Describe route (§7) and its proposal records and commit (§9) are part of this plugin's contract (section 9).
- **External channel chats** (#314). A Main Bot whose main conversation also carries direct messages from other apps is handled in section 4.
- **#257 and #246** (the Approvals step and the Create sequence), and **#147** (the primary bot and a bot's identity). Section 16 says what is taken from each.

The evidence is [`docs/research/bot-self-management.md`](../research/bot-self-management.md), from checks on a development gateway and from the OpenClaw 2026.10.6 package CI installs. Its findings are cited as R1 to R34.

The prototype is to follow, as `prototype/main-bot.html`: the autonomy step, the first run with its guided card, a bot asking to rename itself, creating a bot by chat, proposals, and external agents in Settings, in dark (the default) and light, at desktop and phone width, with a check, `prototype/tools/checks/main-bot.mjs`. The prototype is a fixture: it shows what each state looks like and cannot show that a gateway effect happened. Section 17 lists the contract tests that do.

## Contents

1. What changes
2. The autonomy choice
3. The first run
4. The Main Bot
5. The `clawtrate-bots` plugin
6. The tool contract
7. Who may change what
8. Proposals: how every change is authorized
9. For the avatar studio: Describe and proposal records
10. External agents over MCP
11. Live updates in core and the interface
12. Safety
13. Failure states
14. The iPhone app
15. Parity rows
16. What is taken from #257, #246 and #147
17. For builders
18. The prototype's states
19. Not covered

## 1. What changes

| Today                                                                                                 | After                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After setup the app opens on the bot list, or on "Make your first bot" for an unused implicit `main`. | The app opens on the Main Bot's chat. A Main Bot that has never been set up greets you, and a card asks its name and role.                                                                                                              |
| New bot asks "Ask before acting" or "Run without routine approvals" each time, with nothing chosen.   | Setup asks once how bots run commands. New bot starts on that answer. Each bot can be changed later.                                                                                                                                    |
| A bot can't change its own settings, except through shell commands.                                   | A bot asks, through Clawtrate's plugin, and you review the exact change and save it. On OpenClaw 2026.10.6 saving opens your own editor, filled with the proposed values (section 8). Clawtrate shows the result the gateway read back. |
| Bots are created only in New bot.                                                                     | A bot you allowed can propose a new bot, its routines and changes to other bots. You confirm each.                                                                                                                                      |
| External agents can't see bots.                                                                       | An agent you allow can see bots and suggest changes through MCP, on this Mac, while Clawtrate is open. You can see what it did and remove its access at once.                                                                           |

## 2. The autonomy choice

### The question

One step, titled **"How should bots run commands?"**, with two cards. Each card is a button. Nothing is chosen at first and neither is marked as recommended (#257). Hands-off is first.

| Card                  | Line under it                                                            |
| --------------------- | ------------------------------------------------------------------------ |
| **Hands-off**         | "Run commands without routine approvals, where this computer allows it." |
| **Ask before acting** | "Ask when a host command doesn't match an existing rule."                |

Under the cards, two lines and a link:

- "Either way, a bot asks you before it changes its own or another bot's settings, and you confirm each change with one click."
- "Clawtrate's limits cover changes made through Clawtrate. A command a bot runs can still change things on the computer running OpenClaw."
- **What this means** opens a sheet:
  - "**Hands-off** runs a bot's commands without stopping for approval, as the computer's own user, where that computer's rules allow it. A command can change files and OpenClaw's own settings."
  - "**Ask before acting** runs commands that match a rule already allowed on that computer, including rules you didn't add yourself, such as its safe commands. Anything else waits for you, unless this computer's or the task's own rules decide first. If nobody answers in 30 minutes, the computer's own fallback decides; by default it refuses."
  - "Stopping a run stops what comes next. It doesn't undo a command that already ran."
  - "Each computer can be stricter than this choice. Clawtrate shows what each bot can actually do, or says when it can't tell."

Keyboard: the cards are a radio group with one tab stop; Enter or Space chooses the focused card.

### What it means in OpenClaw 2026.10.6

The choice is about host commands. It is written per bot, never as the gateway's global default.

| What it governs                                                     | Hands-off                                                    | Ask before acting                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| The requested command policy, `agents.entries.<id>.tools.exec.mode` | `full`: security `full`, ask `off` (R14)                     | `ask`: security `allowlist`, ask `on-miss`; a miss raises `exec.approval.requested`, 30 minutes by default, then the host's `askFallback` (R14, R19) |
| A change to any bot's settings from chat                            | A proposal you apply (section 8)                             | The same                                                                                                                                             |
| Session permission mode (`sessions.patch {permissionMode}`)         | Not set (R14)                                                | Not set                                                                                                                                              |
| Other tools                                                         | The bot's tool policy and the managed deny list (section 12) | The same                                                                                                                                             |

**Requested is not effective.** The effective policy also depends on the host's approvals file and its allowlist and safe bins, the node a command runs on, the sandbox and host placement, `strictInlineEval`, an existing session's permission mode (an explicit `full` session can override host approval floors), a native harness's own permissions, and elevated access with its own gates (R14, R20). So a bot's **Autonomy** row shows two facts, each as read:

- the requested mode: "Hands-off" or "Ask before acting", or "Custom (Allowlist)" for anything else;
- the effective access, per host Clawtrate can read: "On this computer: runs without approvals" or "On this computer: asks when no rule matches", or a stricter result ("this computer's approvals file asks before every command"), or "Clawtrate can't read this computer's command rules, so it can't say what will ask." Hosts are read with `exec.approvals.get` (admin) and the node policy where one applies.

Clawtrate never says a bot "will ask" or "will be blocked" on a host whose policy it couldn't read.

### Where it is chosen, and changed

| Where                                         | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup                                         | Always writes the gateway's new-bot default, `plugins.entries.clawtrate-bots.config.newBots.autonomy`, even when it matches what a bot already has. A Main Bot that has never been set up (section 4) is newly managed: it gets the choice and the managed tool policy too. An existing Main Bot keeps its own policy: the step says "Juniper has its own command settings: Ask before acting." and offers a separate, unchecked "Also use this for Juniper". |
| Setup, before the plugin is installed         | The choice is kept on this device, bound to this gateway's identity, as a pending choice. When the plugin is installed on that gateway, Clawtrate writes it and reads it back. It is never applied to another gateway, and an existing bot's mode is never taken as the answer.                                                                                                                                                                               |
| New bot (`bots.md` §3, #257's Approvals step) | The step stays, with the gateway's default chosen and "Your usual choice. It applies to this bot only."                                                                                                                                                                                                                                                                                                                                                       |
| A proposal to create a bot in chat            | Shows the autonomy it would write, from the proposal or the default. Hands-off when the default is Ask before acting is marked "More freedom than your usual choice".                                                                                                                                                                                                                                                                                         |
| A bot's Settings tab, About group             | The **Autonomy** row of the previous section. Choosing writes and reads back that bot's mode. Below admin it is text, with `bots.md` §2's admin bar.                                                                                                                                                                                                                                                                                                          |
| Settings, Bots                                | **New bots start as**: Hands-off or Ask before acting.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Asking a bot in chat                          | A proposal. Toward Hands-off it is marked as more freedom (section 8).                                                                                                                                                                                                                                                                                                                                                                                        |

Writes use a hash-guarded `config.patch` read back, as #257's step 3.

## 3. The first run

### Three things, kept apart

- **Setup is ready** when the gateway is paired, the bots are listed and the autonomy choice is written (or pending). That is effortless setup's composer point.
- **The greeting** is the Main Bot's first visible reply.
- **Identity is complete** when the guided card's name and role read back from the gateway.

The first run's state is one gateway-owned record of the plugin, keyed by gateway and bot incarnation (section 4). It holds the task and the opening's delivery as two separate facts:

```ts
{
  bot: { id: string; createdAt: number };
  task: { key: string; state: "unclaimed" | "created" | "unknown" };
  opening: {
    state: "unsent" | "sending" | "delivered" | "unknown";
    attempt: number;                         // 1 for the first send, +1 per explicit resend
    resend?: { device: string; at: number }; // who claimed the current explicit resend
    via?: "create" | "send";                 // how the current attempt delivers
  };
  identity: "unsaved" | "saved";
  claim: { device: string; at: number };   // the gateway's clock; the device hashed
}
```

- **The task key is chosen before anything is sent**: `agent:<id>:clawtrate-getting-started-<record id>`, and `sessions.create` is called with that `key`. The record is claimed atomically (`registerIfAbsent`, R22) before the call, so a second device, or the same one after a restart, finds the record and the key.
- **An existing key is adopted, not reset**, and a message sent with it would be sent again (R29). So Clawtrate calls `sessions.create {key, message}` only for a key it has just confirmed doesn't exist; otherwise it reads the task and decides from its history.
- **`sending` is written before the call.** The record moves from `unsent` to `sending` (attempt 1) with `compareAndApply` (R22), and only then is `sessions.create` sent. A record that was ever `sending` never goes back to `unsent` by itself.
- **After a lost reply, a restart or a device change**, Clawtrate reads the task by its key (`sessions.list`) and its history (`chat.history`). The fixed opening in the history makes the record `delivered`. Anything else after a `sending` (no task, an empty or incomplete history, an answer with `runStarted: false`) makes it `unknown`, and it stays `unknown` across recoveries until a person resends. `sessions.create`'s `idempotencyKey` deduplicates only in the gateway's memory, per caller, for five minutes after success (R21, R29), so it is a convenience, never a reason to resend or not.
- **An unknown opening waits for a person**: "Clawtrate couldn't confirm the first message reached Maple." with **Send it again** and **Leave it**. Send it again claims the resend with `compareAndApply` from `unknown` to `sending`, with the attempt number plus one and `resend` set to that device. When two devices press it, one claim wins; the other shows "Another device is sending it again" and sends nothing. Nothing is resent by itself.
- **How the winner delivers.** It reads the task by its key first. If the task doesn't exist, it calls `sessions.create {key, message}` (`via: "create"`). If it exists, empty or not, it never calls `sessions.create` on that key (R29): it sends the fixed opening with `chat.send {sessionKey: key, message, idempotencyKey: "<record id>:<attempt>"}` (`operator.write`, R33; `via: "send"`). The idempotency key names the attempt, so a retry of the same attempt can't become a second message where the gateway still remembers it.
- **Every later update names its attempt.** Completion, a lost answer, a recovery read and `delivered` are each a `compareAndApply` that requires the record's `attempt` to equal the update's. A late answer from attempt 1 after attempt 2 was claimed changes nothing; it is kept only in the record's attempt log. If the history then shows the opening twice (the first attempt landed after all), the record is `delivered` and the task says "The first message was sent twice."
- The record resumes only on the gateway that holds it. Without the plugin there is no gateway record, so Clawtrate sends the opening only from the device that ran setup, once, and says on any other device that the first run wasn't finished there.

### The steps, timed

On a Mac with OpenClaw at its defaults and a model account. Estimates; the instrumented builds report each separately.

| Step | What happens                                                                                                                                    | The person does     | Time                  | Total |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------- | ----- |
| 1-3  | Effortless setup: settings read, Connect, paired with six scopes, bots loaded, channel chats hidden (#314). `clawtrate-bots.status` read.       | Clicks Connect      | 5-10 s                | 10 s  |
| 4    | "How should bots run commands?"                                                                                                                 | Chooses             | 3-8 s                 | 18 s  |
| 5    | The Main Bot's chat opens with an empty composer. For a Main Bot never set up, the record is claimed and "Getting started" starts.              | Nothing             | under 1 s             | 19 s  |
| 6    | The greeting, and under it the guided card: "Name" and "How should it help?"                                                                    | Reads               | 3-8 s on a real model | 27 s  |
| 7    | The person fills the card and presses Save.                                                                                                     | Types, presses Save | 10-20 s               | 47 s  |
| 8    | The name and the role are written; the rail, the title pill and the hero change when `agents.list` returns them. "Use Maple's Claw" is offered. | Nothing             | 1-3 s                 | 50 s  |
| 9    | The card's answer is posted as the person's message, and the bot replies under its new name.                                                    | Reads               | 3-8 s                 | 58 s  |

Measured separately, with real provider latency, a cold plugin install and an owner's approval of a remote device each reported apart:

1. opening the app to an interactive composer (effortless PR 6, target 20 s);
2. the composer to the first visible reply (effortless PR 6's shared measurement);
3. pressing Save to the confirmed name in the rail (this design).

The 60 seconds are a target for the ready case: OpenClaw running, a model account, the plugin installed, one Save. Every waiting step has Stop and a retry state (section 13). No end-to-end time has been measured yet.

### Getting started

- **The opening message** is fixed and shown as the person's: "Hi! I just set up Clawtrate. What should I call you, and how can you help me?" with the caption "Sent for you when setup finished." (F-006). It asks for the name and role itself, so the first run doesn't depend on a model choosing a tool.
- **The greeting is the bot's own**, written by its model. OpenClaw's `BOOTSTRAP.md` in a new workspace asks the same questions (R13). Clawtrate doesn't edit that file.
- **The guided card is Clawtrate's**, drawn under the greeting from the record, not from anything the model wrote: "Name" (1-64 characters) and "How should it help?" (up to 500 characters, a short role section in `AGENTS.md`), and **Save**. Under Save: "Saves this name and role. Clawtrate shows them once the gateway confirms." Before Save, the name is shown as the gateway will store it (whitespace collapsed and trimmed, R26).
- **If the person answers in the composer instead**, the bot may propose the values with `clawtrate_bot_update`; they fill the same card for the person to change. Nothing is written until Save.
- **What Save writes on OpenClaw 2026.10.6.** The role goes through `agents.files.set AGENTS.md` with `expectedHash`, or `expectedMissing` for a new file (R23): a conditional write. The name has no conditional write on this gateway (`agents.update` takes no precondition, R24). So it is saved as **the person's own fresh edit**, exactly as a rename in Settings is (#147 §5): typed on this card a moment ago, never a stored value, sent with `agents.update` on the person's admin connection, read back, and carrying #302 §9's race caveat in its exact form. Just before sending, Clawtrate reads the bot again and checks it is the same incarnation with the name the card was drawn against; if not, nothing is sent. What it can't rule out on 2026.10.6 is a change another admin makes between that read and `agents.update`: the write can overwrite it without anyone being told, and the read-back confirms the value now stored but can't show that an edit was overwritten. The plugin-authorized conditional Save for the name is gated (section 17, "Gated on missing gateway primitives").
- **The picture is a separate, explicit edit.** Save doesn't change the picture: with no conditional write, Clawtrate can't promise to keep a picture chosen elsewhere at the same moment. When the read-back shows the bot still has no picture, a line under the card offers **"Use Maple's Claw"**, drawn with #302's shared name function and PNG writer for the confirmed name, with the words "Sets Maple's picture to this Claw. If someone sets a picture elsewhere at the same moment, this replaces it." Pressing it is the person's own edit (`agents.update {avatar}`), read back. Without #302's shared contract in core, the line isn't shown.
- **Each result** is shown as read back: "Name: Maple, read back", "Role: saved, read back", or partly saved with the field that didn't land.
- **Its own task.** "Getting started" is a new task, so direct messages that share the bot's main conversation (#314) never land in it.

### When the plugin is missing

The composer opens as usual and the greeting comes. The guided card's Save is the same person's own edit, with no record and no proposals: "Save in Clawtrate". A line says: "Clawtrate's bot tools aren't on your gateway yet, so bots can't ask to change their settings." Clawtrate doesn't rely on the bot saving its name another way. If the bot changes its identity by running a command, Clawtrate shows "Changed outside Clawtrate's tools" (section 11).

## 4. The Main Bot

### Which bot it is, and what the star means

The Main Bot is #147's primary bot under the issue's name: the bot in `users.prefs` key `clawtrate.primary` when that key names a listed bot with the same `createdAt`, otherwise the gateway's `defaultId`. Its storage, dialogs and place first in its rail group are #147's §3. "Primary bot" reads "Main Bot" in the words.

The **star** is a per-profile preference (`users.prefs`, write tier, R17). It means only what #147 says: first in its group, offered for sharing, and the bot the first run opens on. **It grants nothing.** Letting a bot propose changes to other bots or new bots is a separate admin grant (section 7).

The star is drawn on the avatar's lower right at every size from the 22 px title pill to the 56 px pin, in `--accent-line` with a 1.5 px ring of the surface behind it, inside #300's Presence ring. Its accessible name joins the bot's: "Maple, Main Bot".

### Its incarnation

A bot is the same bot while its id and `createdAt` are the same. Every record here binds to both. A bot the gateway lists with no `createdAt` has no reliable incarnation, and Clawtrate offers only the person's own edit in Settings for it (section 17).

**No write on OpenClaw 2026.10.6 checks the incarnation when it commits.** The gateway keeps `createdAt` in its state database, not in the config (R34). So a bot deleted and re-created with the same id passes a file hash or a missing-file condition when its file is the same, passes a routine revision on a routine it inherited, and can pass the config hash when its entry is rebuilt the same way. A check made just before the write narrows the window but doesn't close it, and a lock that only Clawtrate takes can't stop another client. That is why the plugin doesn't apply a stored request to an existing bot on 2026.10.6 (sections 6 and 17).

### On the first run

`BOOTSTRAP.md` is one hint among several. It can be missing in a fresh workspace (`skipBootstrap`) and still present in an old one.

| What the gateway has                                                                                                                   | The first run                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A Main Bot never set up: no name of its own (the gateway shows its id), no picture, no task with activity; `BOOTSTRAP.md` may be there | Section 3: the record, "Getting started", the greeting, the guided card.                                                                                                                                                                                                 |
| A Main Bot with a name or a picture, or with past activity                                                                             | Its latest task opens, or an empty chat with "Message Juniper". Nothing is sent for the person and nothing is renamed. One centred line, once: "Juniper is your Main Bot." with chips "Ask Juniper to change itself" and "Make a new bot", which only fill the composer. |
| Only the gateway's implicit `main` (no `agents.entries`)                                                                               | It is a Main Bot never set up, but `agents.update` can't name it (R16). Until naming an implicit `main` is proven on a development gateway, the guided card saves the role only and says "Name Main later in Settings" (section 17).                                     |
| A failed `agents.list`                                                                                                                 | `bots.md`'s roster failure. Nothing is sent.                                                                                                                                                                                                                             |
| Several bots and no `clawtrate.primary`                                                                                                | The star is on `defaultId`, as #147 says before a choice. #147's "Introducing the Main Bot" comes after the first run.                                                                                                                                                   |
| `users.prefs` answers `no_durable_identity`                                                                                            | The Main Bot is kept on this device, as #147 §3 says.                                                                                                                                                                                                                    |

### When its main conversation carries direct messages from other apps (#314)

With the gateway's default `dmScope: "main"`, direct messages from every connected chat app share the bot's main conversation, and the rows don't say which turns came from where.

- The main conversation stays visible with the bot's own Claw. Its header says, from confirmed routing: "This conversation also receives direct messages from your connected chat apps." A row's sticky `channel` says which route it last recorded, not where a turn came from, so no app is named there.
- A proposal names its origin only when the gateway supplies trusted per-turn provenance. Otherwise it says "Clawtrate couldn't confirm where this request came from." Whether the tool context's `messageChannel` is per-turn provenance is not established (section 17).
- "Getting started" is its own task.

### Several gateways

Clawtrate connects to one gateway at a time; #79 and #101 design switching. The Main Bot, the new-bot default, the onboarding record, managers and an external agent's access each belong to one gateway, and switching gateways switches them all.

### What stays with #82

Copy, export, import and delete stay with #82 and #147 §8 to §10. No tool here deletes or duplicates a bot.

## 5. The `clawtrate-bots` plugin

A plugin under `plugins/clawtrate-bots`, in the form of `clawtrate-tool-rules`: plain JavaScript, `register(api)`, a `README.md`, tests with a harness, and a `clawtrate-dev-contract.json`.

### What it adds

| Kind              | What                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools (section 6) | `clawtrate_bots_list`, `clawtrate_bot_get`, `clawtrate_bot_update`, `clawtrate_bot_create`, `clawtrate_routine_propose`, `clawtrate_avatar_propose`. Every tool reads or proposes; none writes a bot's settings                                                                                                                                                     |
| Gateway methods   | Read: `.status`, `.proposals.list`, `.proposals.get`, `.changes.list`, `.onboarding.get`, `.relay.grants.get`. Write: `.proposals.decline`. Admin: `.proposals.accept`, `.changes.undo`, `.onboarding.claim`, `.onboarding.update`, `.managers.set`, `.relay.grants.set`, `.relay.propose`. Describe's two methods are off until their primitive exists (section 9) |
| An event          | `plugin.clawtrate-bots.changed`, empty, at `operator.read`                                                                                                                                                                                                                                                                                                          |
| Records           | Proposals, the journal and the onboarding record, in the gateway's database (R9, R22)                                                                                                                                                                                                                                                                               |
| Manifest          | `contracts.gatewayMethodDispatch: ["authenticated-request"]` (R7)                                                                                                                                                                                                                                                                                                   |

### Its config

Written only by Clawtrate on an admin connection, with `config.patch`, and read back. No tool writes it.

```json5
{
  plugins: {
    entries: {
      "clawtrate-bots": {
        enabled: true,
        config: {
          managers: [{ id: "main", createdAt: 1795300000000 }], // explicit admin grants
          newBots: { autonomy: "ask" }, // or "hands-off"
          describe: { enabled: false }, // off on 2026.10.6 (section 9)
        },
        // Written only once Describe can run (section 9), with its disclosure.
        // Model and auth-profile overrides stay off.
        // llm: { allowAgentIdOverride: true },
      },
    },
  },
}
```

### Installing it

Installation comes last (section 17) and has its own release gate: every consumer check passing on development gateways, a signed or pinned distribution, and an explicit production security review of this plugin. It depends on a shared plugin-installation issue to be filed (#29 covers only `clawtrate-computer`). Until then the plugin runs on development gateways only, like the others, and section 3's missing-plugin path is what a real gateway gets.

When installed, `clawtrate-bots.status` (read) says it runs and which version, and lists its capabilities (proposals, onboarding, relay, and Describe, which is off on 2026.10.6). The install sheet names each config line it writes. It writes no `llm` line while Describe is off (section 9).

### What OpenClaw 2026.10.6 gives it

| Need                                        | What the gateway offers                                                                                                                                                            | Proven                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Tools that know which bot called them       | v2 factories; `agentId`, `sessionKey`, `assertInvocationCurrent` (R1)                                                                                                              | live                           |
| A tool per bot                              | A factory returns `null`; `tools.deny` removes it from the model and refuses it (R2)                                                                                               | live                           |
| A write made by an owner's decision         | A plugin method with `dispatchGatewayMethod`, acting with the authenticated caller's own scopes, rechecked at the mutation's commit (R7)                                           | live                           |
| Durable, atomic records                     | Keyed stores, retained or bounded, with `registerIfAbsent`, `compareAndApply` and `overflowPolicy: "reject-new"` (R9, R22)                                                         | live (store), source (compare) |
| Preconditions inside the write              | `config.patch {baseHash}`; `agents.files.set {expectedHash \| expectedMissing}` (R23); `cron.update {expectedConfigRevision}` (R27); `agents.create` refusing an existing id (R28) | live (files), source           |
| No precondition                             | `agents.update` (name, picture, R24); `cron.remove` (R27)                                                                                                                          | source                         |
| A model call with no tools on a bound route | Not available: `api.runtime.llm.complete` can't require an expected route (R31)                                                                                                    | source                         |

Not used, and why: writing from a tool with `callGatewayTool`. It carries the turn's operator authority (R4), but that authority is a connection's, not consent to the change the model chose, and routines carry their creator's authority (R18) while turns with no operator reach admin methods anyway (R6). The gateway's plugin approval card is not used either: it is resolved at `operator.approvals` and isn't bound to an admin principal and the values (R20). What 2026.10.6 lacks is listed in section 17, "Gated on missing gateway primitives".

## 6. The tool contract

Six tools. Each takes the calling bot from the tool's context, never from its arguments. `bot` names another bot only for a manager (section 7). Every write tool returns a proposal; its result says so, and says nothing changed yet.

### Reading

- **`clawtrate_bots_list {}`**: the bots the caller may see: itself, and every bot for a manager. For each: `id`, `name`, `label`, `isMain`, `picture` in words, `model`, `effort`, the requested `autonomy`, and `managesOthers`. For a manager, also the gateway's provider accounts by id and label, never a credential.
- **`clawtrate_bot_get { bot? }`**: one bot's settings, its `AGENTS.md` and `SOUL.md` with each file's hash, and its routines (`cron.list` for that bot) with each routine's `configRevision`.

### Proposing

**`clawtrate_bot_update`**

```ts
{
  bot?: string;                       // a manager only; default: the caller
  name?: string;                      // 1-64 characters after trimming
  label?: string | null;              // identity.theme; null removes it
  instructions?: {
    agents?: { text: string; baseHash: string | null };   // null: the file is missing
    soul?: { text: string; baseHash: string | null };
  };
  model?: string;                     // one the gateway lists for the account
  account?: string;                   // a provider account id
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  autonomy?: "hands-off" | "ask";
  reason?: string;                    // up to 200 characters, shown on the card
}
```

Each field below has a write and a precondition the gateway checks inside the write. None of them checks the bot's incarnation (section 4), so **on 2026.10.6 the plugin applies no stored request to an existing bot**. The card's **Review and save** opens the person's own editor for that setting, filled with the proposed values; the editor reads the bot afresh when it opens and saves with its own precondition and read-back, as any edit in Settings does. The plugin's apply path (section 8) is kept for when the gateway can bind a write to a bot's incarnation.

| Field          | Write, once the plugin may apply (admin)                                       | Precondition inside the write              | Read back               | On 2026.10.6                                           |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------- | ------------------------------------------------------ |
| `label`        | `config.patch agents.entries.<id>.identity.theme`                              | `baseHash` (the whole config)              | `config.get`            | **Gated**: Review and save opens the label field       |
| `instructions` | `agents.files.set` per file                                                    | `expectedHash`, or `expectedMissing` (R23) | `agents.files.get` hash | **Gated**: opens the Instructions page (#147 §6)       |
| `model`        | `config.patch agents.entries.<id>.model`, same account, as #257 writes it      | `baseHash`                                 | `config.get`            | **Gated**: opens the Model select                      |
| `account`      | `config.patch` model with the new account's profile and `fallbacks: []` (#257) | `baseHash`                                 | `config.get`            | **Gated**: opens the account choice; always marked     |
| `effort`       | `config.patch agents.entries.<id>.thinkingDefault`                             | `baseHash`                                 | `config.get`            | **Gated**: opens the Effort select                     |
| `autonomy`     | `config.patch agents.entries.<id>.tools.exec.mode`                             | `baseHash`                                 | `config.get`            | **Gated**: opens the Autonomy row; more freedom marked |
| `name`         | needs `agents.update {name}`, which also writes `IDENTITY.md`                  | none (R24)                                 | `agents.list`           | **Gated**: "Rename Pip to Scout" (below)               |

**What each write binds**, so the gate can lift method by method:

| Method                                 | Binds, inside the write                                                        | Doesn't bind                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `config.patch {baseHash}`              | the whole config as read: the bot's entry, the manager grant, the bound fields | the incarnation, when a replacement rebuilds an identical entry |
| `agents.files.set {expectedHash}`      | that file's content                                                            | the incarnation; the manager grant                              |
| `agents.files.set {expectedMissing}`   | that the file is absent                                                        | the incarnation; the manager grant                              |
| `cron.update {expectedConfigRevision}` | that routine's definition                                                      | the bot's incarnation; the manager grant                        |
| `cron.add {declarationKey}`            | one routine per key                                                            | the bot's incarnation; the manager grant                        |
| `agents.create`                        | that the id is absent (R28)                                                    | anything about the later writes to that id                      |
| `agents.update`                        | nothing (R24)                                                                  | everything                                                      |

**A config rebase, once the plugin may apply.** A `baseHash` covers the whole config. Even the proposal's own first write changes it. Before each config patch, the plugin reads `config.get` once. From that snapshot it checks the target's entry and, for a request about another bot, the proposer's manager grant. If the grant was removed, it refuses with "Juniper can no longer ask to change other bots."

For each config path bound to the proposal, the expected value is the one the card was drawn against, including whether the path existed. Once this claim has written a path and journaled the read-back, its expected value becomes that recorded result. For example, after saving a label, the effort patch checks the new label and the original effort. A difference at either path stops the remaining writes and preserves the confirmed journal entries. Changes outside the bound paths can proceed so long as the target and grant checks still pass. The plugin sends only the next patch, with that snapshot's hash. Any intervening config change makes the gateway refuse it. Files, routines and create are not config writes and bind only what the table says, so for a request about another bot the grant is checked just before the write and a removal during that write isn't serialized with it.

**The name.** The name's semantics include `IDENTITY.md`, which only `agents.update` writes, and that write takes no precondition. Writing the config identity alone with `config.patch` would leave the bot's own identity file saying the old name. So a proposed name is shown on the card with **"Rename Pip to Scout"**, which opens the person's own rename (#147 §5) filled with the proposed value: a fresh edit the person makes, read back, carrying #302 §9's race caveat in its exact form. Just before sending, Clawtrate reads the bot again and checks it is the same incarnation with the name the card was drawn against; if not, nothing is sent. What it can't rule out on 2026.10.6 is a change another admin makes between that read and `agents.update`: the write can overwrite it without anyone being told, and the read-back confirms the value now stored but can't show that an edit was overwritten.

**`clawtrate_bot_create`** (managers only; the factory returns no tool to anyone else)

```ts
{ name: string; role: string; account?: string; model?: string; effort?: string;
  autonomy?: "hands-off" | "ask"; routines?: RoutineDraft[]; reason?: string }
```

The proposal is drawn with **every resolved value**: the exact new id (derived from the name as the gateway derives it), the workspace path, the account and model, the effort, the autonomy, the managed tool policy, the role text, the name's Claw, and each routine. Accept binds all of them. For the role, the card says: "If the gateway gives Stride starting instructions, you'll confirm the role against them next."

**On 2026.10.6, Create from a proposal opens New bot** (`bots.md` §3), filled with the proposal's name, role, account, model, effort, autonomy and routines, and the person creates the bot there with #257's sequence and the window #257 records. The plugin writes nothing: `agents.create` binds only the id's absence, and every follow-on below writes to that id with no incarnation check (section 4). Once the gateway can bind a write to the new bot's incarnation, the plugin runs #257's Create sequence on accept, with the accepting person's authority:

1. `agents.create {name, workspace, model, avatar}` once. The gateway refuses an id that already exists, inside its own config transform (R28): that is the expected-absence check. The name's Claw goes in the same call, so the first picture needs no later write. If the answer names another id than the one shown, nothing more is written and the card shows what was created.
2. The first `config.patch {baseHash}` with Never, the managed deny list (section 12) and the model with `fallbacks: []`; the second with the chosen mode.
3. The role. `agents.create` seeds the workspace's starting files, `AGENTS.md` among them, unless `skipBootstrap` is set (R32). So the plugin reads `AGENTS.md` after the create:
   - **missing** (an empty workspace): the role is written as the file with `expectedMissing`, the base the card showed for this case;
   - **present** (seeded): the plugin writes nothing. A second card asks "Add Stride's role to its starting instructions?", showing the seeded file kept as it is and the role section added after it, bound to that file's hash. **Add** writes with `expectedHash`; a hash that changed asks again. The seeded instructions are never replaced.
4. Each routine with `cron.add`, carrying a `declarationKey` derived from the proposal and the routine, so a resend converges on one routine (R27).

Each step is read back. A step that doesn't read back leaves a held bot, as #257 says, and the card shows how far it got. The picture needs #302's shared name and PNG contract; until it lands, the create sends no `avatar` and the bot shows its id's Clawling.

**`clawtrate_routine_propose`**

```ts
{ bot?: string; action: "add" | "update" | "pause" | "resume" | "remove";
  id?: string; expectedConfigRevision?: string;
  routine?: { name: string; schedule: string; prompt: string } }
```

| Action                | Applied on accept with                        | Precondition                                    | On 2026.10.6                                          |
| --------------------- | --------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| add                   | `cron.add` with a `declarationKey`            | the key converges a resend on one routine (R27) | **Gated**: opens Routines, filled                     |
| update, pause, resume | `cron.update {patch, expectedConfigRevision}` | the routine's revision when proposed (R27)      | **Gated**: opens the routine's editor, filled         |
| remove                | `cron.remove`                                 | none: it takes only an id (R27)                 | **Gated**: "Remove it yourself", which opens Routines |

Bots Clawtrate manages don't get the core `automations` tool (section 12), so this is their way to set routines, under the same target and approval rules.

**`clawtrate_avatar_propose`**: #302 §9's tool. A bot proposes its own picture; a manager may propose another's. Proposals from channel turns and from MCP are held until their authority and delivery are established, as #302 §9 says. On 2026.10.6 a picture can't be applied from a proposal, for the same reason as the name: the card offers **Open in studio**, and the studio's Save is the person's own edit of the draft they see.

### Results

```json
{
  "status": "proposed",
  "proposalId": "p_7f2c",
  "fields": ["name", "instructions.agents"],
  "said": "I've asked to rename myself Scout and update my instructions. Nothing changes until you apply it in Clawtrate."
}
```

Or `refused`, with a reason the bot can act on: "Only bots you've allowed can ask to change other bots.", "AGENTS.md changed since you read it. Read it again.", "That model isn't available on this bot's account.", "Too many open requests from this bot. Wait for an answer." No result says a change happened.

## 7. Who may change what

| Caller                            | Itself  | Other bots                 | Create bots | See other bots    |
| --------------------------------- | ------- | -------------------------- | ----------- | ----------------- |
| A bot listed in `managers`        | propose | propose                    | propose     | yes               |
| Any other bot                     | propose | no                         | no          | no                |
| An external agent (section 10)    | —       | suggest, as its grant says | no in v1    | as its grant says |
| A person with admin, in Clawtrate | change  | change                     | change      | yes               |

- **Managers are an explicit admin grant** tied to a bot's incarnation (`id` and `createdAt`), set with `clawtrate-bots.managers.set` from Settings, a bot's Manage group, **"Can ask to change other bots"**. The star doesn't grant it. When a bot without it tries, the tool refuses and Clawtrate shows "Juniper can't ask to change other bots." with **Allow** (admin) and **Not now**, once per bot.
- **The plugin draws the line**, because the gateway doesn't (R5). It checks the caller and `managers` when the tool is built, again in `execute`, and again right before each write on accept. Managers live in the gateway's config, so removing a grant changes the config hash and a config-backed field written with the old hash is refused inside the gateway's write. A file or routine write has no config precondition: a removal that lands during that write isn't serialized with it, only checked just before it.
- **No tool changes `managers`, `newBots`, any tool policy, or this plugin's config.**

## 8. Proposals: how every change is authorized

A change from chat is a **proposal**. It changes nothing until a person with admin decides, on a card that shows exactly what will be written, in the canonical form the gateway will store (a name's whitespace collapsed, R26; a file as its full text; a routine's schedule as normalized). The decision is bound to:

- the gateway (its identity) and the bot's incarnation (section 4);
- the fields and the proposed values, as a canonical digest computed by the plugin;
- each field's precondition token when the card was drawn: the config hash, the file hash, the routine's `configRevision`.

**On 2026.10.6 the card's button is Review and save** (section 6): it opens the person's own editor, filled with the proposed values, and the plugin writes nothing. Saving there is a fresh decision on the bot as the editor reads it. The proposal then shows "Saved by you", with what the editor read back.

**Apply**, once the gateway can bind a write to a bot's incarnation, calls `clawtrate-bots.proposals.accept {id, digest}` on the person's own connection. The plugin then:

1. claims the proposal in one ledger transition (section 9): it must still be `open`, its published version's digest must be the one the card showed, for an agent's suggestion the grant generation the ledger holds must equal the one the suggestion recorded, and the journal must have room for one entry per field, which the same transition reserves. All of it is compared and recorded in the one `compareAndApply` that moves it to `committing` (R22), so a revocation and an acceptance can't both win, and two claims can't both count on the last journal space;
2. checks the proposer may still propose this (section 7);
3. for each field in order, sends the write with its precondition through `dispatchGatewayMethod`, using section 6's snapshot check for each config patch. Pending paths must match their values on the card, and previously written paths must match this claim's journaled results. The gateway rechecks the caller's live authority at the mutation's commit boundary (R7), and checks the precondition inside the write (section 6). The plugin doesn't rely on its own earlier read;
4. reads each field back and journals each confirmed effect before the next write.

If a precondition fails, that field and the ones after it aren't written, and the card says which changed. A field with no conditional write isn't applied (section 6). The person's own edits in Clawtrate's settings are not proposals: they are a fresh decision already.

### Always confirmed, whoever asks

These are always proposals and are marked on the card, in any mode and from any source: another bot's instructions (the card shows the exact diff); more freedom for any bot (toward Hands-off); another provider account; a picture a bot chose. An **Undo that would restore more freedom** (undoing a move to Ask before acting, for example) is the same: "Undo lets Otto run hands-off again." with **Undo and allow** and **Keep**.

### The guided first-run card

The guided card of section 3 saves exactly what it shows. Its role is a conditional write; its name is the person's own fresh edit on 2026.10.6, and the first picture is a separate explicit edit (section 3).

### The cards

Action cards (`conversation.md`), with the bot's Claw at 18 px:

| Card                                | Title                                                              | Body                                                                                                                                                  | Actions                                                    |
| ----------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Proposal                            | "Pip asks to rename itself Scout"; "Juniper asks to create Stride" | Old and new, per field, canonical; marks ("More freedom", "Uses another account", the diff); the reason, quoted; "Nothing changes until you save it." | Review and save, Not now; "Rename Pip to Scout" for a name |
| Applying                            | the same                                                           | "Applying…"                                                                                                                                           | —                                                          |
| Saved by you                        | "Pip's instructions changed"                                       | One line per field, as the editor read it back                                                                                                        | See change (instructions)                                  |
| Applied (once the plugin may apply) | "Pip's instructions changed"                                       | One line per field, each "read back"; "Undo isn't available" for a field without a journal entry                                                      | Undo where available; See change                           |
| Partly applied                      | "Some of this applied"                                             | Each confirmed field, each that wasn't, each unknown                                                                                                  | Check again (reads only)                                   |
| Not applied                         | "Not applied: Pip's instructions changed since this was asked"     | What changed                                                                                                                                          | Ask again (tells the bot)                                  |
| Unknown                             | "Couldn't confirm whether this applied"                            | What Clawtrate now reads, as observed values, not as an outcome                                                                                       | Check again (reads only)                                   |
| Declined                            | "Kept Pip's instructions"                                          | —                                                                                                                                                     | —                                                          |

Proposals also collect in a **Proposals** list in the gateway menu, with a count. Each proposal's other states are #302 §9's: below admin, expired, superseded, changed elsewhere, and decided on another device.

### Undo

Undo is its own record (section 9), a person's action, and a new bound change. It references the journal entry it undoes, which holds the field's value or hash **as the write left it**. On Undo, the plugin reads the field once and compares it with that journaled result:

- **The same**: it restores the earlier value with the precondition token from **that same read** (the config hash, the file hash, the routine revision), so an edit landing after the read is refused inside the gateway's write.
- **Different** (edited before Undo was opened, or between opening and pressing): nothing is written, and the card shows the comparison: "Pip's instructions changed again since then, so Undo would overwrite that." with the journaled result and the current value side by side, and "Open instructions".

Undo exists only on the plugin's apply path, so on 2026.10.6 there is no Undo from a proposal: the person edits the setting again. Once it exists, a field with no conditional write or no journal entry has no Undo, and the card says "Undo isn't available for this change."

## 9. For the avatar studio: Describe and proposal records

### Describe: gated on 2026.10.6

#302's Describe a Claw needs a completion that runs on exactly the route shown to the person: the prepared owner, transport, credential route and runtime generation, the same on both attempts. `api.runtime.llm.complete` accepts `execution.mode`, `authProfileId` and `timeoutMs` and nothing that names an expected route (R31). The isolated path resolves the harness or CLI owner and prepares credentials again after the plugin calls it, and a harness-owned branch can try other credential candidates. So the plugin can show a route but can't make the call refuse a different one before inference.

**Describe stays unavailable on every route** until the gateway lets a caller require the exact prepared route before inference. The studio shows #302 §7's "Describe a Claw isn't available on this gateway." `clawtrate-bots.status` reports `describe: { available: false, reason: "route-binding" }`. What the design keeps for when it is available: eligibility (OpenClaw's own host-prepared isolated completion: one fresh user message and an empty tool list, R8 and R25; never the Agents API route; native and third-party runtimes only once verified); no fallback after a refusal, a timeout or a call that may have reached a model; #302's bounded reply, single retry and 45-second budget; cancel bound to the caller and attempt; `llm.allowAgentIdOverride` written only by the admin installer with its disclosure, model and auth-profile overrides off; no bot or MCP tool that forwards a completion. Its PR adds a check that changes the route during preparation and sees zero provider requests.

### Proposal records

Two kinds of storage, in one retained store with `overflowPolicy: "reject-new"` (R22):

- **Immutable versions**, written once and never changed: a proposal's details, an Undo's details, a grant's details, and each journal entry.
- **One ledger row per gateway**, the only mutable record that decides anything. It references versions by id and digest.

A proposal version:

```ts
{
  id: string;                                    // also the version's key
  gateway: string;                               // the gateway's identity
  bot: { id: string; createdAt: number };
  kind: "update" | "create" | "routine" | "avatar";
  payload: object; digest: string;               // canonical, validated; the digest covers every field here
  tokens: Record<string, string>;                // each field's precondition token
  configBefore?: Record<string, { value: unknown } | { missing: true }>; // bound paths when the card was drawn
  source: { kind: "bot"; bot; sessionKey; runId } | { kind: "agent"; grant: string; generation: number };
  reason?: string;
  createdAt: number; expiresAt: number;          // the gateway's clock, 24 hours
}
```

Its entry in the ledger: `{ version: digest, state, claim?: { by, at, attempt }, effects: [journal ids], observed? }`, with `state` one of `open`, `committing`, `accepted`, `partial`, `unknown`, `declined`, `expired`, `superseded`, `stale` or `withdrawn`.

- **Persist first, then publish.** Every proposal, Undo and grant version is written in full before the ledger refers to it. The ledger's conditional update then publishes its id and digest: admitting a proposal, starting an Undo, or setting a grant's generation. Readers use only versions the ledger references, and check the digest; a referenced version whose digest doesn't match is treated as unreadable, and the proposal shows "Clawtrate couldn't read this request." with nothing applied.
- **Interrupted before publication**: the version exists and nothing refers to it, so nothing was admitted. The tool's caller gets an error. The service can reclaim an unpublished proposal, Undo or grant version after an hour. Cleanup and publication take the same gateway-side lock. Under that lock, cleanup checks that the ledger still has no reference, and a publisher checks that the version still exists and matches its digest before publishing it.
- **Interrupted after publication**: the ledger refers to a version that is already complete, so recovery has the payload, the Undo values and the grant details it needs.
- **What the ledger decides**, each in one `compareAndApply` (R22): admitting a proposal (with the open count of 200, each source's 20, and the latest open proposal per target and field); superseding one; expiring one; claiming one for accept, decline or Undo, with the grant-generation check inside the claim (section 8); publishing a grant's version; and revoking a grant, which moves its generation on and withdraws that grant's `open` suggestions in the same transition.
- **Journal entries** are versions too, keyed by proposal, claim attempt and field, and written right after the gateway confirms each effect. The ledger then adds them to the proposal's `effects`. If the process stops between the two, recovery finds the entries by that key and adds them. A journal entry is evidence of a confirmed effect, even while it has no ledger reference. The one-hour cleanup skips journal entries. Recovery attaches them before normal journal retention runs. An effect with no journal entry is `unknown` (below).
- **Races, decided by the ledger.** A revocation and an acceptance on two devices: whichever transition lands first decides. If the claim landed first, the commit goes on and the audit says "accepted before access was removed"; if the revocation landed first, the claim fails its generation check and the accept is refused as `withdrawn`. A helper still connected when access is removed from another device learns it from the plugin's event and from the ledger check before its next call. Two submissions racing for the last slot, and a supersession racing a claim, are ordered the same way: a proposal already `committing` can't be superseded.
- **Supersession**: a new proposal for the same bot and field supersedes the open one from any source; for a picture, #302 §9's rule (a newer one from the same proposing bot) applies, and a picture proposal from another source stays alongside it.
- **Expiry** is a field on the gateway's clock; terminal records are kept 30 days, then removed.
- **Undo has its own version**: `{ id, undoes: <journal id>, field, restore: <the journaled before-value>, expect: <the journaled after-value or hash> }`, written before the ledger claim that starts it, and idempotent by id, so a second Undo or a retry after a lost answer finds the first. The values come from the journal, never from the caller.
- **Crash and lost answers.** A proposal left in `committing` is settled from the journal: each effect journaled before the crash is `applied`. An effect not journaled is `unknown`, even when a read shows the proposed value, because an independent admin could have written the same value or restored the base; there is no durable receipt for a particular commit on this gateway. What a read shows is kept as `observed` and shown as "Now reads: …", never as an outcome. Clawtrate never resends an uncertain write; the person can apply again only as a new decision on a card drawn from a fresh read.
- **Several fields** are applied one by one, and each confirmed effect is journaled before the next, so a partly applied proposal says exactly what landed.
- **Studio Save** for a picture proposal is the person's own edit on 2026.10.6 (section 6). When a conditional picture write exists, the studio's commit will carry a new server-computed digest of the exact edited draft, bound to the same current-picture token.

### The journal

A retained store of immutable entries, at most 1,000 and 90 days: `id`, `at`, `gateway`, `bot`, `field`, before and after (short values; hashes, and text up to 64 KiB for Undo, for files), the precondition token used, the proposal, the deciding device (hashed), the source, and the outcome. `clawtrate-bots.changes.list` (read) pages through it, filtered by the caller's permissions (section 10). It gives F-041 its diff and Undo for changes the plugin applies, once it may apply them (section 8).

**Room is reserved before any gateway write.** The ledger keeps the journal's count of entries and of reserved spaces. A claim reserves one space per field in the same transition that claims the proposal, and fails if that would pass 1,000. Each entry written uses one reserved space; settling a claim (applied, partial, not applied or unknown) releases the rest.

- **A full journal.** First, the service removes the oldest entries whose Undo is no longer offered (Undo is offered for 7 days, until the next change to the same field). If that frees no room, the claim is refused before anything is written: "Clawtrate's change history is full, so it can't apply this now. Review and save it yourself instead."
- **An interrupted reservation.** A reservation belongs to its claim. A claim left in `committing` keeps its reservation until recovery settles it from the journal (section 9), and then the unused spaces are released. A reservation is never released while its claim might still write.
- **Partial effects.** Each field's space is used only when its entry is written; the card lists what applied, what didn't, and what is unknown, and Undo is offered only for fields with an entry.
- **A journal write that fails after the gateway write.** Stop before the next field. The live worker can retry storing the confirmed entry once under the same journal key while it still holds the original gateway confirmation and read-back. After a restart, recovery looks up that key. If the entry is missing, the field stays `unknown` and has no Undo. A later read of the setting cannot establish who wrote it. In both cases settlement releases unused reservations. Only fields with journal entries count as applied. With none, the card says "Couldn't confirm whether this applied." With earlier confirmed entries, it says "Some of this applied" and names the fields. For each unknown field it says "Undo isn't available for this change."

## 10. External agents over MCP

### The transport: stdio, relayed by Clawtrate, macOS only in v1

An external agent (Claude Code, Codex, Cursor) starts `clawtrate-mcp`, shipped inside Clawtrate, as a **stdio** MCP server. It relays each call to the running Clawtrate app over a Unix socket, and the app calls the plugin's methods on its gateway connection.

- **Why**: stdio is what coding agents support, with no port. The gateway's own MCP (`attach.grant`) serves one task on the gateway's computer and runs as the bot with no operator (R10, R6). A plugin HTTP route can't carry admin from the shared token (R11).
- **The socket**: a private, app-owned runtime folder (0700) and socket (0600), created safely (no link followed; a stale socket removed only when it is the app's own), cleaned up on quit. Both ends check the other's kernel peer credentials (`LOCAL_PEERCRED`) before the helper sends its secret.
- **Clawtrate must be open and connected**; otherwise every tool answers "Clawtrate isn't connected to your gateway. Open Clawtrate and try again."
- **macOS only** until another desktop OS has an equivalent local transport.

### The principal, on both sides

- **In the app**: a grant holds a high-entropy bearer secret, shown once; the app stores only its digest and compares in constant time. Its label is display text. Grants can be rotated and expire (30 days by default).
- **On the gateway**: each grant's generation and revocation live in the plugin's ledger (section 9), which is what decides; its details (`scope`, `bots`, `includeInstructions`, `includeFuture`, `expiresAt`) are an immutable grant version, written by `clawtrate-bots.relay.grants.set` (admin) before the ledger publishes it. The gateway never holds the bearer. Every suggestion records the grant id and generation, and a claim on **any** device is refused when the ledger shows the grant revoked, expired or at another generation.
- **The limit, said plainly** on the Add screen: "Anything that can read this secret can do what this grant allows. Programs running as you on this Mac can read your agent's settings, so give agents the least they need."
- **A new connection.** When the helper connects, and whenever the app reconnects to the gateway, the app checks the gateway's identity is the one the grant was made for and reads the grant's record from the plugin. A missing record, another generation, revocation or expiry refuses every call until the owner acts. A grant never moves to another gateway.
- Every request is typed and checked before each dispatch. The actor is assigned by the app from the grant, never taken from the caller.

### What it may do

| Scope (v1)          | Tools                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **See bots**        | `bots_list`, `bot_get`, `routines_list`, `proposals_list`                                                                              |
| **Suggest changes** | Also `propose_update` and `propose_routine`, through `clawtrate-bots.relay.propose`, which only records proposals for the grant's bots |

See is the default. External agents can't ask to create bots in v1 (section 7) and can't change anything directly.

**Instructions are a separate permission**, "Include bots' instructions", off by default. Without it the agent gets no `AGENTS.md` or `SOUL.md` text, no instruction diffs in `proposals_list` or the journal, no routine prompts in `routines_list`, and can't propose instructions or a routine's prompt. Lists, proposals, errors and audit answers are filtered by the same grant.

An agent never gets credentials, devices, pairing, gateway config, tool policy, managers, deleting bots, completions or messages to bots.

### Revoking, and the audit

- **Remove access**, or expiry, is one ledger transition: the grant's generation moves on, it is marked revoked, and its open suggestions become `withdrawn`, so no device can apply them. A suggestion already claimed before that transition finishes and is audited as such. In the app, new and queued calls are refused ("This agent's access to Clawtrate was removed."), and the helper's sessions are closed.
- **A call already sent to the gateway** finishes; the audit records what it did ("completed after access was removed", with its outcome), and its answer is not sent to the closed helper session. Nothing is rolled back.
- **The audit** is the app's own, owner-only and bounded (5,000 records, 90 days), keyed by grant and gateway: each read, suggestion, refusal and removal, with no secret and no instruction text. It is kept after a grant is removed. "See its activity" shows it with the plugin's outcomes for its suggestions.

## 11. Live updates in core and the interface

- **Core** keeps one store of each bot's identity (name, label, picture, the star) from `agents.list` and `config.get`. It reads again on `plugin.clawtrate-bots.changed`, on a run's tool event for a `clawtrate_*` tool, on `config.changed`, and on reconnect.
- **Only reads publish.** A proposal's values, a card's text and a tool's arguments never change the store. The rail, the title pill and the hero change when a read returns the new value, together, in one frame.
- **A change from outside**: when a read finds a bot changed with no matching journal record, the bot's Settings and its chat show "Changed outside Clawtrate's tools" with the field and time.
- **Motion**: the name cross-fades over `--dur-base`; the Claw follows #302's transitions; none under reduced motion. The live region says "Renamed to Maple" once.
- **New in `@clawtrate/core`**: the identity store's triggers; the plugin's status, proposals and onboarding record (bounded in `state-bounds.ts`); bridge commands for apply, decline, Undo, the onboarding record, managers and grant records. **In `@clawtrate/ui`**: the autonomy step and Autonomy row, the guided card, the proposal cards and their states, the Proposals list, the managers switch and offer, Agents with access.

## 12. Safety

- **No bot writes anything by itself.** Every change from chat waits for a person's decision bound to the exact values, with the precondition checked inside the gateway's write (sections 6 and 8). A turn's scopes, its owner bit or its source never authorize a write: an admin's chat can carry untrusted text from history, a tool result or another bot, and routines carry their creator's authority (R18).
- **Text from a model is data.** Names, labels and reasons are trimmed, limited and shown as text; instructions as a diff in mono; a picture is only a parsed #302 choice.
- **Credentials never pass through a tool.** Accounts are named by id and label.

### The managed tool policy

Every bot Clawtrate makes or migrates, in both modes, gets this policy. Clawtrate calls a bot **managed** only when its effective tool policy (`tools.effective`) shows every line below, in an interactive turn and in a scheduled turn, on the session and runtime it runs on.

| Surface                                                                     | Policy                                                                                                                                                                                                 | Why, in the pinned package                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `gateway`, `plugins`, `openclaw`                                            | Denied                                                                                                                                                                                                 | Config, plugin and delegated-setup changes; `openclaw` applies any config change under a `full` posture (R12) |
| `automations` and its alias `cron`                                          | Denied. A scheduled turn may still get the gateway's restricted tool that can only remove its own routine; that is allowed, and shows in the journal as observed                                       | Both names are the scheduler tool (R30)                                                                       |
| `sessions_spawn`                                                            | Allowed with `runtime: "subagent"` only once the managed check shows the child carries the bot's denies; otherwise denied. ACP is refused by the gateway when an inherited deny can't be carried (R30) | Delegation must not shed the policy                                                                           |
| `skill_workshop`                                                            | Denied                                                                                                                                                                                                 | Writes skills under the agent folder, outside the workspace (R30)                                             |
| `terminal`                                                                  | Denied                                                                                                                                                                                                 | Types into an operator's shared terminal (R30)                                                                |
| `personal_instructions`                                                     | Denied                                                                                                                                                                                                 | Writes a person's `USER.md` and takes another agent's id (R30)                                                |
| `t3code__*`                                                                 | Denied, as #257 does                                                                                                                                                                                   | The optional T3 Code integration acts outside the gateway                                                     |
| File tools                                                                  | `tools.fs.workspaceOnly: true`. Clawtrate never sets a `full` session permission mode on a managed bot; a task that has one shows "This task isn't under Clawtrate's limits"                           | An explicit `full` session takes precedence over `workspaceOnly` (R30)                                        |
| Session offloading (`worker-turn`), native harnesses, provider-native tools | Not enforceable from OpenClaw's tool inventory: a bot whose model or runtime uses them is shown as "Not fully managed", with what isn't covered                                                        | The policy is checked on what OpenClaw constructs, not on a provider's own tools                              |

- **Existing bots** keep their tools until the owner chooses **"Bring Juniper under Clawtrate's limits"**, a sheet that names each tool it turns off and each setting it changes. Until then the bot says "Clawtrate's limits don't apply to Juniper yet", and Clawtrate claims nothing about it.
- **What the limits can't do.** With Hands-off, a bot's commands run as the computer's user and can change OpenClaw's settings or another bot's files. Clawtrate promises its limits for its own plugin actions only, and says so on the setup step (section 2). Keeping bots apart needs a separate host or workspace per bot and a reviewed tool policy; that is not part of this design.

## 13. Failure states

| Condition                                                            | Where              | Words                                                                                                                   | Actions                  |
| -------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| A write didn't confirm (autonomy, Save, Apply)                       | Where it was made  | "Clawtrate couldn't confirm whether this changed." Clawtrate reads it again and shows what it now reads.                | Check again (reads only) |
| Below admin at setup                                                 | Setup              | `bots.md` §2's admin bar: "Choosing how bots run commands needs admin access."                                          | Request access; Skip     |
| The greeting doesn't come in 45 s                                    | First run          | "Maple hasn't answered yet." The guided card is shown anyway.                                                           | Stop; Try again          |
| The opening's delivery is ambiguous                                  | First run          | "Clawtrate couldn't confirm the first message reached Maple."                                                           | Send it again; Leave it  |
| The first run is held by another device                              | First run          | Opens the same task; no second opening                                                                                  | —                        |
| The bot changed since the card was drawn                             | Guided card, cards | "The name changed somewhere else since this card was shown, so nothing was saved."                                      | Show the current name    |
| A bot with no creation record                                        | Cards              | "Clawtrate can't confirm this is the same bot, so it can't apply a saved request. Make the change yourself."            | Open settings            |
| Any stored request on 2026.10.6                                      | Card               | Section 6's button: "Review and save", "Rename Pip to Scout", "Open in studio", "Remove it yourself", or New bot filled | As there                 |
| The plugin is missing                                                | First run          | Section 3's line, and "Save in Clawtrate" on the card                                                                   | —                        |
| Apply below admin                                                    | Card               | "**Admin access needed.** Applying this needs admin access."                                                            | Request access           |
| The journal is full (plugin apply path)                              | Card               | Section 9's words                                                                                                       | Review and save          |
| A manager grant removed before the write (plugin apply path)         | Card               | "Juniper can no longer ask to change other bots."                                                                       | —                        |
| Not applied, partly applied, unknown, expired, superseded, withdrawn | Card               | Sections 8 and 10, and #302 §9                                                                                          | As there                 |
| Undo would give more freedom                                         | Card               | Section 8's words                                                                                                       | Undo and allow; Keep     |
| Too many open proposals                                              | The bot's result   | Section 6's words                                                                                                       | —                        |
| Describe                                                             | Studio             | "Describe a Claw isn't available on this gateway." (section 9)                                                          | —                        |
| An external agent while Clawtrate is closed, or after removal        | The agent          | Section 10's words                                                                                                      | —                        |

## 14. The iPhone app

`apps/mobile` isn't on `main` and belongs to its own coordinator. Impact: core's stores and the copy are shared; the autonomy step, the guided card, the proposal cards and the Proposals list need the app's own screens at 44 pt; Agents with access is desktop only.

## 15. Parity rows

To reword, statuses unchanged:

- **F-005**: "The app opens on the gateway's Main Bot; a Main Bot never set up starts 'Getting started'."
- **F-006**: the first message is Clawtrate's fixed opening with its caption; the greeting is the bot's.
- **F-007**, **F-259**: "primary Bot" reads "Main Bot".
- **F-041**: its gateway cell adds "a change applied through Clawtrate's bots plugin is journaled with its before and after, which gives the diff and Undo".

New rows, from F-530 (#302 uses F-518 to F-521):

| Row   | Behaviour                                                                                                                                                                                                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-530 | Setup asks how bots run commands; the new-bot default and a never-set-up Main Bot's mode are written and read back; requested and effective access are shown.                                                                                                                                        |
| F-531 | The first run sends its opening once per gateway and bot, including across two devices, a restart and a lost reply, and stops for an explicit retry when delivery is ambiguous; the guided card saves exactly its name and role; the rail changes on the read-back.                                  |
| F-532 | A bot's request to change its own settings is a proposal; on 2026.10.6 Review and save opens the person's own editor filled with it and the plugin writes nothing; once the plugin may apply, each field is written with its precondition inside the gateway's write and a changed field is refused. |
| F-533 | Another bot's instructions, more freedom, another account and a bot-chosen picture are always confirmed, and an Undo to more freedom asks.                                                                                                                                                           |
| F-534 | A manager's proposal shows exactly the bot it would create; on 2026.10.6 Create opens New bot filled with those values and the plugin writes nothing; the new bot appears when listed.                                                                                                               |
| F-535 | A bot that isn't a manager can't propose for other bots; the star grants nothing.                                                                                                                                                                                                                    |
| F-536 | On 2026.10.6, concurrent submissions respect the open proposal limits, and published proposals survive restart. Once Apply is available, two devices deciding one proposal get one outcome, the claim reserves journal room before writing, and unjournaled effects stay unknown.                    |
| F-537 | An external agent with a grant sees bots and suggests changes within its scope; removing access refuses its next call, and another device can't apply its old suggestion.                                                                                                                            |
| F-538 | A managed bot's denied tools are absent in interactive and scheduled turns, and a bot whose runtime can't enforce them isn't called managed.                                                                                                                                                         |

## 16. What is taken from #257, #246 and #147

- **#257** (an open pull request): the two modes and their writes; the Create sequence and held bots, now also run on accept of a create proposal; the deny list, extended (section 12); the approvals-file line; the implicit-`main` reading. Carried into the autonomy PR and the create PR.
- **#246** (an open pull request): the mode wording, and the page and the host both refusing a Create without a choice. Not taken: its exact-path approval probe.
- **#147** (an open pull request): the primary bot's storage, dialogs and rail order (renamed Main Bot); the read-back table; the instructions event line, extended with the journal's diff and Undo. Copy, export, import and delete stay with #82.

## 17. For builders

### Gated on missing gateway primitives

OpenClaw 2026.10.6 lacks these. Each feature stays off until the gateway has the primitive; nothing here invents one.

| Feature, off on 2026.10.6                                                                                                                                                                                      | Missing primitive                                                                                                                                                                                                                                                             | What the person gets instead                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Applying, or undoing, **any stored request to an existing bot** (label, instructions, model, account, effort, autonomy, routine add, edit, pause or resume), and the **follow-on writes of a proposed create** | A write that refuses unless the target bot's incarnation is the one the caller read: an incarnation precondition on `agents.files.set`, `config.patch` for an agent's entry, `cron.*` and `agents.update`, or a config hash covering incarnation for config writes only (R34) | "Review and save": the person's own editor, or New bot, filled with the proposed values |
| Applying, or undoing, a proposed **name**; the guided card's plugin-authorized name Save                                                                                                                       | A conditional identity write: `agents.update` (or an equivalent) refusing unless the bot's identity, including `IDENTITY.md`, is what the caller read (R24)                                                                                                                   | The person's own fresh rename, read back, with #302 §9's race caveat                    |
| Applying, or undoing, a proposed **picture** (#302 §9's "Use it")                                                                                                                                              | The same, for `avatar`                                                                                                                                                                                                                                                        | "Open in studio"; the studio's Save is the person's own edit                            |
| **Removing a routine** from a proposal                                                                                                                                                                         | A revision precondition on `cron.remove` (R27)                                                                                                                                                                                                                                | "Remove it yourself", in Routines                                                       |
| **Describe a Claw** (#302 §7)                                                                                                                                                                                  | A way for `api.runtime.llm.complete` to require the exact prepared owner, transport, credential route and runtime generation before inference (R31)                                                                                                                           | "Describe a Claw isn't available on this gateway."                                      |
| Applying a saved request to a bot with **no creation record**                                                                                                                                                  | A gateway-issued incarnation for each bot                                                                                                                                                                                                                                     | The person's own edit in Settings                                                       |
| Recognizing an unjournaled effect as **this** commit's                                                                                                                                                         | A durable receipt for a write                                                                                                                                                                                                                                                 | "Unknown", with what Clawtrate now reads                                                |
| Calling a bot "managed" on **worker-turn, native-harness or provider-native-tool** routes                                                                                                                      | Tool-policy enforcement on those routes                                                                                                                                                                                                                                       | "Not fully managed", with what isn't covered                                            |

### Order

Each PR merges before the next one that needs it starts. The report has sizes.

1. **Plugin: proposal records and the journal**: the admission ledger, records, claims, expiry and quotas, accept, decline, Undo records, crash settling, managers, status, the event, the gateway grant records for agents.
2. **Plugin: reading and proposing tools**: list, get, update (with the gated name), routine (with the gated removal), avatar; the managed checks; the prompt-hook probe.
3. **Plugin: create proposals** with #257's sequence and routines (needs #257 or its merged replacement, and #302's shared name and PNG contract for the first picture).
4. **The autonomy step and the managed policy**: requested and effective access, the pending choice, the migration sheet, the managed check in interactive and scheduled turns (needs #257).
5. **Live updates and proposal cards** in core and the interface, the Proposals list, the gated-field buttons (before #302's proposal card).
6. **The first run**: the onboarding record, the opening's delivery state, Getting started, the guided card, the Save-to-rail timing (after 1, 4 and 5, effortless PR 6, and #302's shared contract for the picture).
7. **Create by chat** in the interface (after 3 and 5).
8. **The MCP relay** (after 1 and 2).
9. **Agents with access** in Settings (after 8).
10. **Installing the plugin**, behind its release gate (section 5).

Describe's route (formerly its own PR) waits for its primitive. Effortless setup's PR 6 owns the pairing-to-composer timing and the first-reply measurement; step 6 adds the Save-to-rail timing to the same harness. #292 closes only when routines and accounts (step 2), create (steps 3 and 7) and the first run (step 6) are in.

### Contract tests that must fail without each behaviour

On a development gateway, against the plugin and the real app, each named for its parity row:

- **F-532**: on 2026.10.6, Review and save opening each editor filled with the proposal and the plugin sending no write; a bot deleted and re-created with the same id and identical files between the card and saving, saved only through the editor's fresh read. Once the plugin may apply: a proposal accepted; a label and an effort change applied in order, including after an unrelated config edit; an external edit to the confirmed label or the still-pending effort stopping the second write and preserving the first journal entry; a file or routine refused when its precondition changed; a decider who lost admin before the commit; a name field shown with its own button and not applied.
- **F-533**: each always-confirmed mark; an Undo to more freedom asking.
- **F-534**: on 2026.10.6, Create opening New bot filled with exactly the proposal's values. Once the plugin may apply: an existing id refused by `agents.create`; a create answered with another id stopping; a lost answer on `cron.add` converging on one routine.
- **F-535**: a non-manager refused; a star without a manager grant refused; once the plugin may apply, a grant removed before the rebase's snapshot refused, and one removed after it refused inside `config.patch`.
- **F-536 on 2026.10.6, with Apply disabled.** Race two distinct proposals for the last open slot. Run the race once against the gateway limit of 200 and once against the per-source limit of 20. Each time, one proposal is admitted, the other is refused, and the open count stays at the limit. Restart after storing the version but before the ledger publishes it. The proposal list stays unchanged, cleanup can reclaim the version, and a delayed publisher cannot publish it after cleanup. Restart just after publication and verify that the list contains the proposal once, with its original payload and digest. Check that the gateway received no writes to bot settings.
- **F-536 once the plugin may apply**: a full journal refusing the claim before any write, after the service frees what it can; two claims competing for the last journal space; a crash with a reservation held, settled by recovery before the space is released; a journal write failing on the first or a later field, followed by a restart with no entry for that field (unknown, further fields unwritten, Undo offered only for earlier journaled effects); a restart after more than an hour with a confirmed journal entry still awaiting its ledger reference (the effect is recovered and shown as applied); a revocation and a claim racing, decided by the claim's generation check; two devices deciding at once; a supersession racing a commit; a crash between the claim and the write; a lost answer after an independent admin writes the same value, and after one restores the base, both reported unknown with observed values; Undo retried after a lost answer finding its first record.
- **F-531**: two devices opening the first run at once; a restart between the claim and the opening; a lost `sessions.create` answer; `runStarted: false`; an existing key never sent the opening through `sessions.create`; two devices pressing Send it again for an existing, empty task (one `chat.send`, one "Another device is sending it again"); a late answer from the first attempt changing nothing; real composer submission and the card's fill at phone width.
- **F-537**: a grant used; revoked mid-call (the admitted call's outcome recorded, its answer withheld); refused after; another device trying to apply the revoked grant's suggestion; a reconnect with a new generation refused; instructions withheld without the permission.
- **F-538**: each denied tool absent in an interactive and a scheduled turn; ACP refused; a `full` session task shown as not under the limits; a worker-turn bot shown as not fully managed.
- The plugin missing; a gateway switch mid-proposal.

### Not yet established

The implicit-`main` rename; whether `messageChannel` is trusted per-turn provenance; whether a plugin's prompt guidance reaches the model before the first turn (step 2 probes it, and the first run doesn't depend on it); whether a subagent spawned by a managed bot carries its denies; proposal persistence across a real restart; the relay's socket and revoke behaviour; any measured first-run time.

## 18. The prototype's states

The prototype is to follow. `main-bot.html` takes `theme`, `width` and `chrome`, as the other pages, and:

| Parameter  | Values                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`     | `setup` (default), `first` (the first run), `rename` (a bot asks to rename itself), `create` (creating a bot by chat), `proposal` (proposals of other origins), `agents` (Settings) |
| `at`       | `start`, `greeted`, `saving`, `done`: a point in the first run; `done` also applies a proposal                                                                                      |
| `card`     | `unconfirmed`, `stale`, `undone`, `declined`: other outcomes                                                                                                                        |
| `opening`  | `ambiguous`: the first message's delivery couldn't be confirmed                                                                                                                     |
| `existing` | `1`: an existing Main Bot                                                                                                                                                           |
| `plugin`   | `missing`                                                                                                                                                                           |
| `grant`    | `0`: Juniper isn't a manager yet (create)                                                                                                                                           |
| `step`     | `add`, `added` (agents)                                                                                                                                                             |

A stand-in gateway answers after a delay, and the rail changes only on its answer. The Claws are a stand-in drawn from the name, not #300's creatures, which aren't on `main`. The page is a fixture: it shows each state and proves no gateway effect.

## 19. Not covered

- Deleting, duplicating, exporting and importing bots (#82).
- Raster pictures (#302 §8's gate).
- Direct changes by external agents, and agents on another computer from the Clawtrate app.
- Keeping bots apart on one host under Hands-off.
- Group chats (#83).
