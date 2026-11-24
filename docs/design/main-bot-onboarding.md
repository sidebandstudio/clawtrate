# The Main Bot, the autonomy choice, and bots that set themselves up

Issue #292, revised for #434. The first run makes a new bot, the Main Bot, and you set it up by chatting with it: it greets you, and a card under its greeting asks what to call it, which of Clawtrate's avatars it wears and how it should help. When you save, its tile at the top of the sidebar and the chat's header change as soon as the gateway confirms. Before that, one question sets how bots run commands. Later, a bot can ask to change its own settings, a bot you allow can ask to create or change other bots, and an external agent you allow can see bots and suggest changes through MCP. **A bot never changes a setting by itself: you confirm each change, on a card that shows exactly what will be written.** Every change goes through the gateway's own methods, and Clawtrate shows only what the gateway confirmed.

It builds on:

- **Effortless setup** (the setup work's effortless-setup design, not yet on `main`). That design covers everything up to step 3 of its §7. This one is the autonomy step and the Main Bot's chat. Its PR 6 owns the measurement from pairing to the composer and to the first reply; section 3 adds one more.
- **The avatar studio** (#302's design, not yet on `main`). The first run's card offers the name's Claw of its §2 first among Clawtrate's avatars, and "Make your own" opens the studio. Its Describe route (§7) and its proposal records and commit (§9) are part of this plugin's contract (section 9).
- **What stays out of view** (#314, #433, #490, #491): channel chats, other tools' sessions and the gateway's own bot. The first run relies on these; section 4 says how.
- **Bringing in what an existing OpenClaw has** (#487, its own design): a bot's memory, the person's profile and its skills, scheduled jobs, and context from another assistant. The first run offers it at one step (section 3) and that design covers the rest.
- **#257 and #246** (the Approvals step and the Create sequence), and **#147** (the primary bot and a bot's identity). Section 16 says what is taken from each.

The evidence is [`docs/research/bot-self-management.md`](../research/bot-self-management.md), from checks on a development gateway and from the OpenClaw 2026.10.6 package CI installs. Its findings are cited as R1 to R44.

The prototype is [`prototype/main-bot.html`](prototype/main-bot.html): the autonomy step, the first run with its guided card, a bot asking to rename itself, creating a bot by chat, proposals, and external agents in Settings, in dark (the default) and light, at desktop and phone width. `prototype/tools/checks/main-bot.mjs` checks it. The prototype is a fixture: it shows what each state looks like and cannot show that a gateway effect happened. Section 17 lists the contract tests that do.

## What the #434 revision changes

Until now the Main Bot was whichever bot the gateway called its default, set up in place if it had never been. It is now always a bot Clawtrate makes.

- **The first run makes the Main Bot.** On every gateway, including one that already has bots, Clawtrate makes a new bot and the person sets it up by chatting with it: its name, its picture from Clawtrate's avatars, and how it helps. No bot the gateway already has is adopted. The gateway a person already has is the usual path; a new gateway is only for someone who has none.
- **One per gateway, made once.** If two devices set up at the same moment, the gateway lets only one make it, and every person on the gateway sees that same bot. Changing which bot is the Main Bot comes with Clawtrate's bot tools on the gateway, and then it changes for everyone; the old one becomes an ordinary bot with its chats.
- **It knows it is the Main Bot.** Clawtrate writes into its identity: "You are the Main Bot in Clawtrate, the bot people here start with. Being the Main Bot gives you no extra access: don't make or change other bots yourself; tell the person what you'd suggest, and they decide in Clawtrate. Your picture is one of Clawtrate's avatars, chosen in Clawtrate. Don't make or set a picture yourself."
- **It looks like the Main Bot:** a gold star on its avatar and a tile of its own at the top of the sidebar, above the other bots.
- **The gateway's own bot is not shown** once another bot exists (#490). It keeps running, and it keeps the channel messages and other traffic that reach the gateway without naming a bot. A switch under Settings → Advanced brings it back.
- **Channels stay where they were.** Channel messages keep going to the bot they reach today, never to the Main Bot. On a gateway with only its own bot, OpenClaw itself records that bot as the one channels reach when the Main Bot is made; Clawtrate never writes channel settings.
- **A bot changing itself asks first.** A new name or picture is a card the person confirms; a setting under Settings → Advanced can apply one at once when the person typed it in Clawtrate.
- **It can start from what an existing bot knows** (#487): one step of the first run offers it.
- **Being the Main Bot grants nothing by itself.** Once Clawtrate's bot tools are on the gateway, the first run lets the Main Bot suggest new bots and changes to other bots, with a switch on its setup card that is on unless the person turns it off; the person confirms each suggestion (#437).

Two choices are still with the product owner; section 4 gives what each costs:

- **Open: while Clawtrate can't make a bot yet.** Default: the top of the sidebar says "Set up your Main Bot" and asks once for full control; no bot is starred. Alternative: an existing bot wears the star until then.
- **Open: the bot already starred.** On today's builds that is always the gateway's own bot. Default: after the update the first run makes the Main Bot, and the old bot leaves the sidebar with its chats kept, one switch away. Alternative: keep it as the Main Bot when Clawtrate made it, which almost never applies.

### Before and after

| Question                | Before                                                                                                              | After                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who the Main Bot is     | The gateway's default bot, or a bot chosen in `clawtrate.primary` (#147, not on `main`).                            | A bot Clawtrate made in its first run, with id `clawtrate-main-bot`; with Clawtrate's bot tools on the gateway, another bot chosen later, for everyone.                                    |
| The gateway's own bot   | A row like any other, starred as the Main Bot.                                                                      | Not in the sidebar, Hidden bots, search or bot pickers once another bot exists; back with "Show the gateway's own bot" under Settings → Advanced. It keeps running and keeps its channels. |
| Channels                | Their direct messages can lead the Main Bot's row, when the Main Bot is the bot channels reach.                     | Never brought in by the first run. They reach the gateway's own bot as before, and reach Clawtrate's view only through "Show external channel chats", off by default (#433).               |
| The star and the tile   | A small neutral star badge on the default bot, in the rail's ordinary order.                                        | A gold star on the Main Bot's avatar and a tile of its own at the top of the sidebar, above pinned bots and the rest.                                                                      |
| What the first run asks | The default bot's name and role, on a card, only if it had never been set up; otherwise "Juniper is your Main Bot." | Always: the new bot's name, its picture from Clawtrate's avatars and how it should help, by chatting, then an offer to start from what an existing bot knows.                              |

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
20. Build order

## 1. What changes

| Today                                                                                                 | After                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After setup the app opens on the bot list, or on "Make your first bot" for an unused implicit `main`. | Clawtrate makes the Main Bot and opens its chat. It greets you, and a card asks its name, its picture and its role.                                                                                                                     |
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

| Where                                         | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Setup                                         | Always writes the gateway's new-bot default, `plugins.entries.clawtrate-bots.config.newBots.autonomy`, even when it matches what a bot already has. The Main Bot the first run makes (section 4) is a new bot, so it gets the choice and the managed tool policy too. A Main Bot already made from another device keeps its own policy: the step says "Juniper has its own command settings: Ask before acting." and offers a separate, unchecked "Also use this for Juniper". |
| Setup, before the plugin is installed         | The choice is kept on this device, bound to this gateway's identity, as a pending choice. When the plugin is installed on that gateway, Clawtrate writes it and reads it back. It is never applied to another gateway, and an existing bot's mode is never taken as the answer.                                                                                                                                                                                                |
| New bot (`bots.md` §3, #257's Approvals step) | The step stays, with the gateway's default chosen and "Your usual choice. It applies to this bot only."                                                                                                                                                                                                                                                                                                                                                                        |
| A proposal to create a bot in chat            | Shows the autonomy it would write, from the proposal or the default. Hands-off when the default is Ask before acting is marked "More freedom than your usual choice".                                                                                                                                                                                                                                                                                                          |
| A bot's Settings tab, About group             | The **Autonomy** row of the previous section. Choosing writes and reads back that bot's mode. Below admin it is text, with `bots.md` §2's admin bar.                                                                                                                                                                                                                                                                                                                           |
| Settings, Bots                                | **New bots start as**: Hands-off or Ask before acting.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Asking a bot in chat                          | A proposal. Toward Hands-off it is marked as more freedom (section 8).                                                                                                                                                                                                                                                                                                                                                                                                         |

Writes use a hash-guarded `config.patch` read back, as #257's step 3.

## 3. The first run

### What a person sees, step by step

The usual case: someone who already runs OpenClaw, with a few bots, opens Clawtrate for the first time. A new gateway is set up only for someone who has none (effortless setup).

1. **Connect.** Clawtrate finds the OpenClaw on this Mac, or the person picks another computer, and pairs with full control (#393, #421). The bots load.
2. **How bots run commands.** One question (section 2).
3. **The Main Bot appears.** Clawtrate makes a new bot. A tile with the gold star appears at the top of the sidebar, reading "Clawtrate Main Bot", above the bots the person already has. The person's other bots stay as they were, below the tile; the gateway's own bot is already out of view, since other bots exist (#490). No bot is renamed, moved or starred, and nothing about channels is shown or changed.
4. **Its chat opens.** Clawtrate's fixed first message is shown as the person's, with "Sent for you when setup finished.", and the Main Bot answers in its own words.
5. **The person sets it up by chatting.** Under the greeting, Clawtrate's card asks for a name, a picture from Clawtrate's avatars (the name's own Claw first, "Make your own" for the studio) and how it should help. The person can answer on the card or in the composer; an answer in the composer fills the card (below). **Save** writes them. The tile, the header and the name follow the gateway's read-back.
6. **Starting from what it knows.** When the gateway has a bot with memory, a profile of the person or skills, one card offers "Start Maple from what Juniper knows", and the rest is #487's design. Nothing is copied unless the person chooses it, and conversations and channel links are never copied.
7. **The first real request.** The Main Bot replies under its new name and the composer is the person's.

On a gateway whose only bot is its own one, step 3 is the moment the sidebar changes from that bot to the Main Bot's tile; the gateway's own bot is never removed before the Main Bot exists, so the sidebar is never empty. On a fresh gateway, made for someone who had none, the same steps run with no bots below the tile and no step 6.

On a second device, or for a second person on the same gateway, the Main Bot is already there: its tile and its chat open, and nothing is made or sent.

### Four things, kept apart

- **Setup is ready** when the gateway is paired, the bots are listed and the autonomy choice is written (or pending). That is effortless setup's composer point.
- **The Main Bot is made** when `agents.create` answered with its id and the bot list shows it (section 4).
- **The greeting** is the Main Bot's first visible reply.
- **Identity is complete** when the guided card's name, picture and role read back from the gateway.

The first run's state is one gateway-owned record of the plugin, keyed by gateway and the Main Bot's incarnation (section 4), written once `agents.create` has made the bot. It holds the task and the opening's delivery as two separate facts:

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
- The record resumes only on the gateway that holds it. Without the plugin there is no gateway record, so the opening is sent only by the device whose `agents.create` made the Main Bot, once. Any other device shows "Maple is being set up on another device." and sends nothing until the bot's identity reads back; then it opens the Main Bot's chat as it is. Sharing the first run's task across devices needs the plugin's record.

### The steps, timed

On a Mac with OpenClaw at its defaults and a model account. Estimates; the instrumented builds report each separately.

| Step | What happens                                                                                                                                                                                                   | The person does            | Time                  | Total |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------- | ----- |
| 1-3  | Effortless setup: settings read, Connect, paired with six scopes, bots loaded, channel chats hidden (#314). `clawtrate-bots.status` read.                                                                      | Clicks Connect             | 5-10 s                | 10 s  |
| 4    | "How should bots run commands?"                                                                                                                                                                                | Chooses                    | 3-8 s                 | 18 s  |
| 5    | Clawtrate makes the Main Bot (`agents.create`, its identity file, its model's fallbacks; section 4). Its tile appears with the gold star, its chat opens with an empty composer, and "Getting started" starts. | Nothing                    | 1-2 s                 | 20 s  |
| 6    | The greeting, and under it the guided card: "Name", "Picture" and "How should it help?"                                                                                                                        | Reads                      | 3-8 s on a real model | 28 s  |
| 7    | The person fills the card and presses Save.                                                                                                                                                                    | Types, picks, presses Save | 10-20 s               | 48 s  |
| 8    | The name, the picture and the role are written; the tile, the title pill and the hero change when `agents.list` returns them.                                                                                  | Nothing                    | 1-3 s                 | 51 s  |
| 9    | The card's answer is posted as the person's message, and the bot replies under its new name.                                                                                                                   | Reads                      | 3-8 s                 | 59 s  |

Measured separately, with real provider latency, a cold plugin install and an owner's approval of a remote device each reported apart:

1. opening the app to an interactive composer (effortless PR 6, target 20 s);
2. the composer to the first visible reply (effortless PR 6's shared measurement);
3. pressing Save to the confirmed name in the rail (this design).

The 60 seconds are a target for the ready case: OpenClaw running, a model account, the plugin installed, one Save. Every waiting step has Stop and a retry state (section 13). No end-to-end time has been measured yet.

### Getting started

- **The opening message** is fixed and shown as the person's: "Hi! I just set up Clawtrate. What should I call you, and how can you help me?" with the caption "Sent for you when setup finished." (F-006). It asks for the name and role itself, so the first run doesn't depend on a model choosing a tool.
- **The greeting is the bot's own**, written by its model in answer to the opening. OpenClaw's own first run (`BOOTSTRAP.md`, R13) would have the bot pick a vibe, make itself a picture and save an identity over Clawtrate's; Clawtrate's identity file, written when the bot is made, ends it before the first turn, as New bot does (#376, R37).
- **The guided card is Clawtrate's**, drawn under the greeting from the record, not from anything the model wrote: "Name" (1-64 characters), "Picture" (a row of Clawtrate's avatars, the name's own Claw first and chosen, and "Make your own", which opens the avatar studio with Clawtrate's parts; never a generated image, #435), "How should it help?" (up to 500 characters, a short role section in `AGENTS.md`), and **Save**. Under Save: "Saves this name, picture and role. Clawtrate shows them once the gateway confirms." Before Save, the name is shown as the gateway will store it (whitespace collapsed and trimmed, R26).
- **If the person answers in the composer instead**, the bot may propose the values with `clawtrate_bot_update`, or, without the plugin, write the name on its `- Name:` line as #431's rename card expects (F-552). Either way they fill the same card for the person to change. Nothing is written until Save.
- **What Save writes on OpenClaw 2026.10.6.** The role goes through `agents.files.set AGENTS.md` with `expectedHash`, or `expectedMissing` for a new file (R23): a conditional write. The name has no conditional write on this gateway (`agents.update` takes no precondition, R24). So it is saved as **the person's own fresh edit**, exactly as a rename in Settings is (#147 §5): typed on this card a moment ago, never a stored value, sent with `agents.update` on the person's admin connection, read back, and carrying #302 §9's race caveat in its exact form. Just before sending, Clawtrate reads the bot again and checks it is the same incarnation with the name the card was drawn against; if not, nothing is sent. What it can't rule out on 2026.10.6 is a change another admin makes between that read and `agents.update`: the write can overwrite it without anyone being told, and the read-back confirms the value now stored but can't show that an edit was overwritten. The plugin-authorized conditional Save for the name is gated (section 17, "Gated on missing gateway primitives").
- **The picture is saved with the name.** It goes in the same `agents.update {name, avatar}`, the person's own edit on a bot this device made moments before, with the same caveat. The chosen avatar is Clawtrate's own form, read back from `agents.list`. Without #302's shared name and PNG contract in core, the Picture row isn't shown and the bot keeps its id's Clawling until the person picks one in its settings.
- **Each result** is shown as read back: "Name: Maple, read back", "Picture: read back", "Role: saved, read back", or partly saved with the field that didn't land.
- **Its own task.** "Getting started" is a new task of the Main Bot. Channels don't reach the Main Bot (section 4), and even where a person later binds one to it, its direct messages land in the main conversation, never in this task (#314).
- **Starting from what an existing bot knows.** After the first reply under the new name, when the gateway lists another bot, one card offers "Start Maple from what Juniper knows" with **Choose what to bring** and **Not now**. What can be brought, how it is shown and how it is undone are #487's design; this design only places the offer. It is never shown before identity is complete, and it is offered once per gateway.

### When the plugin is missing

The composer opens as usual and the greeting comes. The guided card's Save is the same person's own edit, with no record and no proposals: "Save in Clawtrate". A line says: "Clawtrate's bot tools aren't on your gateway yet, so bots can't ask to change their settings." Clawtrate doesn't rely on the bot saving its name another way. If the bot changes its identity by running a command, Clawtrate shows "Changed outside Clawtrate's tools" (section 11).

## 4. The Main Bot

The Main Bot is the bot a person meets first and comes back to. It starts as a bot Clawtrate made in the first run, never one the gateway already had; later the person can make another of their bots the Main Bot.

### What a person sees

- **Its tile.** The Main Bot has a tile of its own at the top of the sidebar, above pinned bots and every other bot: its avatar at 56 px, centred, its name under it on one line (truncated, the full name on hover and focus), on a rounded tile that takes the selected fill when its chat is open. The rest of the sidebar keeps its order below (pinned bots, then the person's sort). The tile can't be unpinned, hidden or dragged; the Main Bot leaves it only when another bot becomes the Main Bot.
- **Its star.** A gold star on the avatar's lower right, wherever the Main Bot is drawn, from the 22 px title pill to the 56 px tile: a disc in `--star` with a star in `--star-ink`, ringed by the surface behind it at 1.5 px, inside #300's Presence ring. `--star` is the one colour the visual language adds for this: the creatures' yellow in the dark theme and a deeper gold in the light one, outside the palette guard's hues. The badge is the only gold in the app. Its accessible name joins the bot's: "Maple, Main Bot".
- **On the phone**, the tile is the first item of the bot list, full width, avatar at 56 px beside the name, with the star.
- **Its words.** Wherever the app names it as such: "Main Bot". "Primary bot" is gone from the words.

### Clean by default

Clawtrate's sidebar holds the bots the person works with and the tasks they started in Clawtrate. Other things that reach the gateway stay out of view unless a switch under Settings → Advanced brings them in. The first run relies on three of these, which are designed and built on their own:

- **The gateway's own bot** (#490). Once another bot exists, it isn't in the sidebar, under Hidden bots, in search or in a list for choosing a bot. "Show the gateway's own bot" brings it back.
- **Other tools' sessions** (#491). A bot's task list holds its main conversation and the tasks started in Clawtrate. API clients' sessions and scheduled runs aren't listed and don't set its preview, its unread mark or its place; a paired switch brings them back.
- **Channel chats** (#314, #433). They stay out of the list, and with "Show external channel chats" off, a channel message doesn't lead the sidebar at all: not a bot's preview, its unread mark or its place.

Each shows while it waits on an approval or a question from the person, until that is answered, so nothing that needs the person is out of sight.

### Which bot it is

**The record is the bot's id.** The first run makes the Main Bot with `agents.create {name: "Clawtrate Main Bot", model}`, so its id is `clawtrate-main-bot`; the name changes in the first run, the id never does. `agents.list` (read) shows every device of every person on that gateway which bot it is, and with it its `createdAt`, which with the id is its incarnation (below). Nothing about it is kept only on a device.

**One Main Bot, made once.** The gateway refuses `agents.create` for an id it already has, inside its own config write (R28). So when two devices, two windows, or two people run the first run at the same moment, one `agents.create` makes the bot and the other is refused `already-exists` (R44). The refused one reads the bot list, finds `clawtrate-main-bot` and opens it: nothing is made twice and the opening is sent once (section 3). A reinstall or a new device finds it the same way.

**With the `clawtrate-bots` plugin** the gateway also holds the choice as a record of the plugin, `mainBot: {id, createdAt}`, in the same retained store as the first run's record (R22), set with `compareAndApply` on an admin connection. A later change of Main Bot (below) needs it. Without the plugin, the id is the record.

Which id Clawtrate reads as the Main Bot, in order: the plugin's `mainBot` when the plugin is there and names a listed bot with that `createdAt`; otherwise `clawtrate-main-bot` when it is listed; otherwise none.

A bot someone made by hand with the name "Clawtrate Main Bot" before the first run has that id, and Clawtrate can't tell it from its own without the plugin; it is taken as the Main Bot. That is the one case where a bot the gateway already had becomes the Main Bot. Its identity file has no Main Bot lines, so a card in its chat offers to add them, held to the hash Clawtrate read.

### What it is told

Clawtrate writes the Main Bot's `IDENTITY.md` when it makes it, as New bot does for a name (#376, R37): the `- Name:` line, then these lines, which are what makes it aware it is the Main Bot:

> You are the Main Bot in Clawtrate, the bot people here start with. Being the Main Bot gives you no extra access: don't make or change other bots yourself; tell the person what you'd suggest, and they decide in Clawtrate.
>
> Your picture is one of Clawtrate's avatars, chosen in Clawtrate. Don't make or set a picture yourself.

and New bot's line about a new name ("When the person gives you a new name, write it on the `- Name:` line above and tell them it shows once they confirm it in Clawtrate."). The file is the bot's to read, and the bot can edit it; the record above, not the file, decides which bot is the Main Bot. When the plugin's proposal tools arrive (section 20, step 5), that step rewrites the first line to name them.

### Making another bot the Main Bot

"Make Maple the Main Bot" in a bot's menu, or **Replace with different bot** on the Main Bot's menu, which opens "Choose your Main Bot" with the person's bots and **Confirm** (F-259). One bot at a time:

- **The new Main Bot** takes the tile and the star. Clawtrate adds the Main Bot lines to its `IDENTITY.md`, after the `- Name:` line, held to the hash it read (R23).
- **The old Main Bot** becomes an ordinary bot. It keeps its name, picture, tasks, routines and settings, and goes to its place in the list below. Clawtrate replaces its Main Bot lines with New bot's ordinary ones, held to the hash it read; for a bot New bot never made, it removes them and adds nothing. If either file changed since it was read, nothing is overwritten: the bot's settings say "Clawtrate couldn't update what Juniper is told about being the Main Bot." with **Try again**.
- **Where it is kept.** In the `clawtrate-bots` plugin's `mainBot` record, for every person and device on the gateway. Without the plugin, "Make … the Main Bot" and **Replace with different bot** aren't offered: the Main Bot is `clawtrate-main-bot`, and its menu says "Changing the Main Bot needs Clawtrate's bot tools on your gateway."
- **The gateway's own bot is never offered**, and choosing changes nothing on the gateway beyond the two identity files: no binding, owner or order.

Deleting the Main Bot (#82, #147) leaves the gateway without one. Every device then shows "Set up your Main Bot" at the top of the sidebar with **Set up**, and nothing is made until a person presses it on their own device: the first run starts by itself only on a device's first connection to a gateway, never after a Main Bot has been seen there. If the deleted bot's files were kept, a new Main Bot made under the same id starts from them; the delete dialog says so ("If you make a new Main Bot, it starts from these files.") when the files are kept. A create refused with `deletion-pending` shows "Clawtrate is still removing the old Main Bot. Try again in a moment." with **Try again**.

### The gateway's own bot

Every OpenClaw gateway has a bot that takes what reaches the gateway without naming a bot: a channel message that matches no binding, another tool's call with no agent, and ambient work such as heartbeats (R40). It is not the Main Bot, and this design never writes it.

- **How Clawtrate recognises it**: `agents.list` `defaultId`, the test #431's rename card uses to skip the default bot and #490 uses, with one exception: when `selectionRequired` is true, `defaultId` is only the first configured bot, not an owner (R41), so no bot is the gateway's own and none is left out. Without the exception, a roster with no owner would lose an ordinary bot of the person's from view. It holds for the implicit `main` (ownership `sole`), for a default someone renamed (the id is what counts, not the name), and for a default its owner changed with `agents.defaults.systemAgent` (`defaultId` follows on the next read, after `config.changed`). The Main Bot is never left out, even if the owner makes it the gateway's default.
- **When it leaves the sidebar**: once another bot exists (#490). On a gateway whose only bot is its own one, it stays in the sidebar until the first run has made the Main Bot, so the sidebar is never empty. If it was open when it left, the Main Bot opens.
- **Unread work** from it isn't counted anywhere: not the dock badge, not a total.
- **A pending approval or question** from it brings it into the sidebar, as an ordinary row below the others, until that is answered (#490), and its card says which bot asks.
- **The switch**: Settings → Advanced, **Show the gateway's own bot**, off by default. Under it: "OpenClaw's own bot. Channel messages and other apps' requests that name no bot go to it. It keeps running while it's hidden." On, it is an ordinary bot: a row below the others, never under Hidden bots unless the person hides it.
- **Nothing on the gateway changes**: it keeps running, keeps its channels, its routines and its sessions.

**Where this differs from #490 as filed.** Recognition takes the `selectionRequired` exception above, which #490's builder has. And from build step 1 on, the gateway's own bot is never starred when the switch shows it; until then, #490's "starred or not as today" holds.

### Channels stay where they were

The first run never mentions channels, never offers to move them and writes no binding. The requirement, for every gateway write the first run and a Main Bot change make:

- **Clawtrate's own requests never write** `bindings`, `agents.defaults.systemAgent`, `agents.defaults.heartbeat`, `agents.ownership`, the order of `agents.entries`, the gateway's own bot's entry, or anything under `channels`. Its writes are the ones New bot makes, for the new bot only: `agents.create`, `agents.files.set` of its `IDENTITY.md` and `AGENTS.md`, `config.patch` of its own `agents.entries.<id>` paths, `agents.update` of its name and picture, and `sessions.create` of its own tasks.
- **The owner of each channel is the same after as before.** On OpenClaw 2026.10.6 a channel message with no binding goes to the gateway's recorded owner, and with several bots and no owner it is not delivered at all (R40). Making a bot never makes it that owner:
  - on a gateway that already has several bots, the owner's entry, the bindings, `agents.ownership` and `agents.defaults.systemAgent` read back byte for byte the same, and an unbound direct message reaches the same bot before and after (R42);
  - on a gateway with one bot, implicit or not, OpenClaw's own config writer, not Clawtrate, turns the roster explicit as the Main Bot is made, records that bot as owner and adds a channel-wide binding to it for each active channel; an unbound direct message reaches it before and after (R43). Clawtrate never undoes or repeats those writes.
- **The test.** On a development gateway with a channel and an unbound sender, for both shapes of gateway: the first run's requests, recorded at the gateway, contain none of the paths above; the owner each channel account resolves to, read before and after, is the same bot; on the several-bots gateway, the owner's entry and the bindings are byte-identical; and an unbound direct message sent after the first run is routed to the gateway's own bot (the session key's agent is that bot's id), never to the Main Bot. It is a contract test, so a gateway version that moved channels by itself would fail it, and the first run wouldn't ship for that version until this section says how Clawtrate keeps channels where they were.

### What the Main Bot may do with other bots

Being the Main Bot grants nothing by itself, and moving the star moves nothing else. What the Main Bot can do beyond any bot is propose making a bot or changing one, because, once the `clawtrate-bots` plugin is on the gateway, the first run gives it section 7's manager grant, shown on the guided card as "Maple can suggest new bots and changes to your other bots. You confirm each one." with a switch the person can turn off there or later in Maple's settings. Each proposal waits for the person's confirmation on its own card (section 8). Specialist bots with a stated job, made by the Main Bot on request, are #437's design.

### A bot changing itself

A change to a bot's own name or picture asks first, by default, in the first run and after: the bot proposes it and a card shows exactly what will be written (#436). The rename card from #431 (F-552) is the first of these. The guided card's Save in the first run is the same kind of confirmation: the person filled it in Clawtrate.

- **The setting.** Settings → Advanced, **Apply a bot's changes to itself at once**, off by default, kept on this device for this gateway. On, a new name or picture is applied straight away only when this device's composer sent the last message of the run that made the change, that run was started by that message and no scheduled run or other client's message landed in the task before it ended, and the new name appears word for word in that message (a picture: the person named one of Clawtrate's avatars in it). Anything else shows the card. An applied change is shown with **Undo**.
- **What never confirms.** A message that arrived through a channel, a scheduled run, another bot's message, text a tool returned, or another device's or another person's composer.
- **What always asks**: a later change to a bot's instructions, anything about another bot, more freedom, another account (section 8).

### Its incarnation

A bot is the same bot while its id and `createdAt` are the same. Every record here binds to both. A bot the gateway lists with no `createdAt` has no reliable incarnation, and Clawtrate offers only the person's own edit in Settings for it (section 17).

**No write on OpenClaw 2026.10.6 checks the incarnation when it commits.** The gateway keeps `createdAt` in its state database, not in the config (R34). So a bot deleted and re-created with the same id passes a file hash or a missing-file condition when its file is the same, passes a routine revision on a routine it inherited, and can pass the config hash when its entry is rebuilt the same way. A check made just before the write narrows the window but doesn't close it, and a lock that only Clawtrate takes can't stop another client. That is why the plugin doesn't apply a stored request to an existing bot on 2026.10.6 (sections 6 and 17).

### On the first run

| What the gateway has                                                                             | The first run                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Main Bot on this device's first connection to the gateway, and a connection that can make one | Section 3: the bot is made, then the record, "Getting started", the greeting and the guided card. Bots already there stay as they were, below the tile.                                                                                 |
| A Main Bot made on another device or by another person                                           | Its latest task opens, or an empty chat with "Message Maple". Nothing is made or sent, and nothing is renamed.                                                                                                                          |
| A Main Bot whose first run another device is running now                                         | With the plugin, the same task opens, with that device's progress; no second opening. Without it, "Maple is being set up on another device.", and nothing is sent until the bot's identity reads back.                                  |
| No Main Bot, and a connection that can't make one                                                | Open with the owner (below). The default: "Set up your Main Bot" at the top of the sidebar, with the one request for full control.                                                                                                      |
| A failed `agents.list`                                                                           | `bots.md`'s roster failure. Nothing is made or sent.                                                                                                                                                                                    |
| An `agents.create` refused other than as `already-exists`, or not answered                       | Nothing more is sent. The bot list is read; a `clawtrate-main-bot` there is the Main Bot. Otherwise the tile says "Clawtrate couldn't make your Main Bot." with **Try again**, which creates again only after a read shows none (#257). |

### Open with the owner: when Clawtrate can't make a bot yet

Making the Main Bot needs admin access (`agents.create`, `agents.files.set`, `config.patch`, `agents.update`, R17) and write (`sessions.create`). A device paired read-only can't, and neither can a connection to OpenClaw on this Mac before the one-click local connection asks for full control (#421).

- **Default: no stand-in.** The top of the sidebar is a tile reading "Set up your Main Bot", an empty avatar with the gold star in outline, and one line: "Clawtrate needs full control of your gateway to make your Main Bot." with **Give full control**, the one request #418 offers a device paired with less. The person's bots are listed below as ordinary rows, none starred (#490); on a gateway whose only bot is its own one, that bot is the row. The gateway's own bot is out of view too (#490 hides it once any other bot exists), so until full control is given the person sees neither it nor a Main Bot. Keeping it in view until the Main Bot exists would cost one condition in #490. Once full control is granted, the first run runs. _What it costs:_ the tile's empty state and wiring it to #418's offer; nothing that has to be undone later.
- **Alternative: a stand-in star.** Until the Main Bot can be made, an existing bot (the gateway's default, or the person's choice) gets the gold star and the tile. When full control is granted, the first run makes the real Main Bot and the star moves to it; the stand-in goes back to an ordinary row, or leaves the sidebar if it is the gateway's own bot. _What it costs:_ a second source for the Main Bot, a move the person sees once, an exception to #490's rule, and a stand-in that can't be told it is the Main Bot, since its identity file can't be written read-only.

### Open with the owner: a bot already starred

On `main` today the star is always on the gateway's default bot (F-015). Nobody has chosen one yet: the choice dialogs (F-007, F-259) are not built, and #147's `clawtrate.primary` is not on `main`.

- **Default: the first run makes the new Main Bot.** On the update, the first connection to each gateway runs the first run once. The previously starred bot loses the star and stays as an ordinary bot with its chats intact; when it is the gateway's own bot, it leaves the sidebar once the Main Bot exists (#490), its chats intact on the gateway and one switch away. _What the person sees:_ after updating, the Main Bot's chat and its tile; the bot that was starred, which on today's builds is always the gateway's own bot, is no longer in the sidebar. Its chats stay on the gateway, behind "Show the gateway's own bot". _What it costs:_ nothing beyond the first run: it runs on each device's first connection after the update to a gateway with no Main Bot listed.
- **Alternative: keep the starred bot if Clawtrate made it.** A starred bot that Clawtrate made in New bot (New bot's record of its account, `users.prefs` key `clawtrate.bot-account.<id>`, is the sign) stays the Main Bot: it gets the tile and the gold star, and a card asks to add the Main Bot lines to its identity file. Any other starred bot, the gateway's own included, is handled as in the default. _What the person sees:_ no first run when their bot qualifies. _What it costs:_ the New bot record is per person, so another person on the gateway would get a first run anyway and, without the plugin, a different Main Bot; plus a migration card and its tests. On `main` the starred bot is the gateway's default, which Clawtrate made only on a gateway that had no bots, so this path rarely applies.

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
          managers: [{ id: "clawtrate-main-bot", createdAt: 1795300000000 }], // explicit admin grants
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
| Durable, atomic records                     | Keyed stores with `registerIfAbsent` and `compareAndApply`: bounded ones, which take `overflowPolicy: "reject-new"`, or retained ones, with no eviction and no TTL (R9, R22)       | live (store), source (compare) |
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
| `account`      | Model patch for the chosen model and new profile, with `fallbacks: []` (below) | `baseHash`                                 | `config.get`            | **Gated**: opens the account choice; always marked     |
| `effort`       | `config.patch agents.entries.<id>.thinkingDefault`                             | `baseHash`                                 | `config.get`            | **Gated**: opens the Effort select                     |
| `autonomy`     | `config.patch agents.entries.<id>.tools.exec.mode`                             | `baseHash`                                 | `config.get`            | **Gated**: opens the Autonomy row; more freedom marked |
| `name`         | needs `agents.update {name}`, which also writes `IDENTITY.md`                  | none (R24)                                 | `agents.list`           | **Gated**: "Rename Pip to Scout" (below)               |

**When a proposal changes both account and model.** The card shows the destination account and the exact model together and marks the account change for confirmation. The model must be available for that account. If it isn't, the card asks for another selection. On 2026.10.6, **Review and save** opens the account editor with both selections filled in.

Once Apply is available, resolve the account first and validate the proposed model against it. Bind the resulting model reference and empty fallback list to the card's digest. At the model step in the table above, write `agents.entries.<id>.model` once, using `formatModelRef` for the selected provider, proposed model ID and destination account. Replace the fallback list with `[]` in that same conditional patch, as the account editor does. Skip the separate account step. Read back the full reference and fallback list before continuing. The two selections share one reserved journal slot, one confirmed result and one Undo for the model entry. If the pair is no longer available, stop before writing it and ask for a fresh selection.

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

- **Managers are an explicit admin grant** tied to a bot's incarnation (`id` and `createdAt`), set with `clawtrate-bots.managers.set` from Settings, a bot's Manage group, **"Can ask to change other bots"**. The star doesn't grant it. The first run sets it for the Main Bot it makes, with the switch on the guided card (section 4), and making another bot the Main Bot doesn't move it. When a bot without it tries, the tool refuses and Clawtrate shows "Juniper can't ask to change other bots." with **Allow** (admin) and **Not now**, once per bot.
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
3. for each field in order (account and model together count as one field at the model step), sends the write with its precondition through `dispatchGatewayMethod`, using section 6's snapshot check for each config patch. Pending paths must match their values on the card, and previously written paths must match this claim's journaled results. The gateway rechecks the caller's live authority at the mutation's commit boundary (R7), and checks the precondition inside the write (section 6). The plugin doesn't rely on its own earlier read;
4. reads each field back and journals each confirmed effect before the next write.

If a precondition fails, that field and the ones after it aren't written, and the card says which changed. A field with no conditional write isn't applied (section 6). The person's own edits in Clawtrate's settings are not proposals: they are a fresh decision already.

### Always confirmed, whoever asks

These are always proposals and are marked on the card, in any mode and from any source: another bot's instructions (the card shows the exact diff); more freedom for any bot (toward Hands-off); another provider account; a picture a bot chose. An **Undo that would restore more freedom** (undoing a move to Ask before acting, for example) is the same: "Undo lets Otto run hands-off again." with **Undo and allow** and **Keep**.

### The guided first-run card

The guided card of section 3 saves exactly what it shows. Its role is a conditional write; its name and its picture, one of Clawtrate's avatars, are the person's own fresh edit on 2026.10.6, in one `agents.update` (section 3).

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

Two kinds of storage, in keyed stores (R22). On OpenClaw 2026.10.6 a retained store has no eviction and rejects `maxEntries`, `overflowPolicy` and TTLs (`docs/plugins/sdk-runtime/state-and-system.md`, lines 162 and 174). So the ledger is retained, enforces the limits below and is swept by the plugin for expiry and retention, and the versions are in a bounded namespace with `overflowPolicy: "reject-new"`, which refuses new versions when full and leaves room for every ledger decision:

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
- **Interrupted before publication**: the version exists and nothing refers to it, so nothing was admitted. The tool's caller gets an error. The service can reclaim an unpublished proposal, Undo or grant version after an hour of continuous non-reference: the hour starts when the sweep first sees the version unreferenced, on the process's monotonic clock, and a restart starts a fresh observation unless the deletion was already marked. Cleanup marks an unreferenced version in the ledger before deleting it. A publisher checks that the version exists and matches its digest, and the ledger update refuses a version marked for deletion. Both operations condition their ledger update on the row they observed.
- **Interrupted after publication**: the ledger refers to a version that is already complete, so recovery has the payload, the Undo values and the grant details it needs.
- **What the ledger decides**, each in one `compareAndApply` (R22): admitting a proposal (with the open count of 200, each source's 20, and the latest open proposal per target and field); superseding one; expiring one; claiming one for accept, decline or Undo, with the grant-generation check inside the claim (section 8); publishing a grant's version; and revoking a grant, which moves its generation on and withdraws that grant's `open` suggestions in the same transition.
- **Journal entries** are versions too, keyed by proposal, claim attempt and field, and written right after the gateway confirms each effect. The ledger then adds them to the proposal's `effects`. If the process stops between the two, recovery finds the entries by that key and adds them. A journal entry is evidence of a confirmed effect, even while it has no ledger reference. The one-hour cleanup skips journal entries. Recovery attaches them before normal journal retention runs. An effect with no journal entry is `unknown` (below).
- **Races, decided by the ledger.** A revocation and an acceptance on two devices: whichever transition lands first decides. If the claim landed first, the commit goes on and the audit says "accepted before access was removed"; if the revocation landed first, the claim fails its generation check and the accept is refused as `withdrawn`. A helper still connected when access is removed from another device learns it from the plugin's event and from the ledger check before its next call. Two submissions racing for the last slot, and a supersession racing a claim, are ordered the same way: a proposal already `committing` can't be superseded.
- **Supersession**: a new proposal for the same bot and field supersedes the open one from any source; for a picture, #302 §9's rule (a newer one from the same proposing bot) applies, and a picture proposal from another source stays alongside it.
- **Expiry** is a field on the gateway's clock; terminal records, and revoked grants, are kept 30 days, then removed.
- **Storage full.** The ledger is one stored value, at most 1 MiB. A new proposal or grant is refused with `records-full` if the ledger, with room kept for every open proposal to settle and every grant to be revoked, wouldn't fit; deciding, expiring and revoking always can.
- **The versions store fills only for a while.** A settled request keeps its body for the 30 days of history, so the 512 version rows hold the open requests (up to 200), the requests settled in the last 30 days, each grant's current version, revoked grants still in retention, and orphans awaiting cleanup. With few grants and few orphans, about 300 settled in 30 days with 200 open, or about 500 with few open, fill it. A full store refuses new records with `records-full` and accepts them again as cleanup reclaims rows; a store full of live grants with long deadlines can stay full for longer than 30 days. Dropping a settled request's body sooner, or a larger bound, can follow if real use needs them.
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

- **Core** keeps one store of each bot's identity (name, label, picture) from `agents.list` and `config.get`, and which bot is the Main Bot and which is the gateway's own, from section 4's record and `agents.list`. It reads again on `plugin.clawtrate-bots.changed`, on a run's tool event for a `clawtrate_*` tool, on `config.changed`, and on reconnect.
- **Only reads publish.** A proposal's values, a card's text and a tool's arguments never change the store. The rail, the title pill and the hero change when a read returns the new value, together, in one frame.
- **A change from outside**: when a read finds a bot changed with no matching journal record, the bot's Settings and its chat show "Changed outside Clawtrate's tools" with the field and time.
- **Motion**: the name cross-fades over `--dur-base`; the Claw follows #302's transitions; none under reduced motion. The live region says "Renamed to Maple" once.
- **New in `@clawtrate/core`**: the identity store's triggers; the plugin's status, proposals and onboarding record (bounded in `state-bounds.ts`); bridge commands for apply, decline, Undo, the onboarding record, managers and grant records. **In `@clawtrate/ui`**: the Main Bot's tile and gold star, "Set up your Main Bot", the autonomy step and Autonomy row, the guided card, the proposal cards and their states, the Proposals list, the managers switch and offer, Agents with access.

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

| Condition                                                                                                                                                                                           | Where              | Words                                                                                                                                                                        | Actions                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| A write didn't confirm (autonomy, Save, Apply)                                                                                                                                                      | Where it was made  | "Clawtrate couldn't confirm whether this changed." Clawtrate reads it again and shows what it now reads.                                                                     | Check again (reads only) |
| Below admin at setup                                                                                                                                                                                | Setup              | `bots.md` §2's admin bar: "Choosing how bots run commands needs admin access."                                                                                               | Request access; Skip     |
| The greeting doesn't come in 45 s                                                                                                                                                                   | First run          | "Maple hasn't answered yet." The guided card is shown anyway.                                                                                                                | Stop; Try again          |
| The opening's delivery is ambiguous                                                                                                                                                                 | First run          | "Clawtrate couldn't confirm the first message reached Maple."                                                                                                                | Send it again; Leave it  |
| The first run is held by another device                                                                                                                                                             | First run          | Opens the same task; no second opening                                                                                                                                       | —                        |
| The gateway refuses a second bot because its bindings live in an included file (`CONFIG_WRITE_REJECTED`, "Automatic agent ownership materialization cannot append to $include-owned bindings", R43) | The tile           | "OpenClaw won't add your Main Bot by itself, because your channel settings are kept in a separate file. Add a channel-wide binding for your channels there, then try again." | Try again                |
| The Main Bot couldn't be made                                                                                                                                                                       | The tile           | "Clawtrate couldn't make your Main Bot." Section 4's table says when a create is tried again.                                                                                | Try again                |
| The connection can't make a bot                                                                                                                                                                     | The tile           | Section 4's open choice; by default "Clawtrate needs full control of your gateway to make your Main Bot."                                                                    | Give full control        |
| The Main Bot lines couldn't be moved to or from a bot                                                                                                                                               | Bot settings       | "Clawtrate couldn't update what Juniper is told about being the Main Bot."                                                                                                   | Try again                |
| The bot changed since the card was drawn                                                                                                                                                            | Guided card, cards | "The name changed somewhere else since this card was shown, so nothing was saved."                                                                                           | Show the current name    |
| A bot with no creation record                                                                                                                                                                       | Cards              | "Clawtrate can't confirm this is the same bot, so it can't apply a saved request. Make the change yourself."                                                                 | Open settings            |
| Any stored request on 2026.10.6                                                                                                                                                                     | Card               | Section 6's button: "Review and save", "Rename Pip to Scout", "Open in studio", "Remove it yourself", or New bot filled                                                      | As there                 |
| The plugin is missing                                                                                                                                                                               | First run          | Section 3's line, and "Save in Clawtrate" on the card                                                                                                                        | —                        |
| Apply below admin                                                                                                                                                                                   | Card               | "**Admin access needed.** Applying this needs admin access."                                                                                                                 | Request access           |
| The journal is full (plugin apply path)                                                                                                                                                             | Card               | Section 9's words                                                                                                                                                            | Review and save          |
| A manager grant removed before the write (plugin apply path)                                                                                                                                        | Card               | "Juniper can no longer ask to change other bots."                                                                                                                            | —                        |
| Not applied, partly applied, unknown, expired, superseded, withdrawn                                                                                                                                | Card               | Sections 8 and 10, and #302 §9                                                                                                                                               | As there                 |
| Undo would give more freedom                                                                                                                                                                        | Card               | Section 8's words                                                                                                                                                            | Undo and allow; Keep     |
| Too many open proposals                                                                                                                                                                             | The bot's result   | Section 6's words                                                                                                                                                            | —                        |
| Describe                                                                                                                                                                                            | Studio             | "Describe a Claw isn't available on this gateway." (section 9)                                                                                                               | —                        |
| An external agent while Clawtrate is closed, or after removal                                                                                                                                       | The agent          | Section 10's words                                                                                                                                                           | —                        |

## 14. The iPhone app

`apps/mobile` isn't on `main` and belongs to its own coordinator. Impact: core's stores and the copy are shared; the Main Bot's tile (the first item of the bot list, full width, with the gold star), the autonomy step, the guided card, the proposal cards and the Proposals list need the app's own screens at 44 pt; Agents with access is desktop only.

## 15. Parity rows

**Reworded in `docs/parity.md` by this revision**, because the old text is no longer true. Each keeps its status:

- **F-005**: the first run makes a new Bot, the Main Bot, and opens its chat, also on a gateway that already has Bots.
- **F-006**: the Main Bot's chat starts with Clawtrate's fixed first message and its caption, then the Main Bot's greeting and Clawtrate's card for its name, picture and role.
- **F-007**: no existing Bot is offered as the Main Bot; with none on the gateway, the sidebar's top tile offers to set one up. Its gateway cell no longer suggests reordering `agents.entries`.
- **F-008**, **F-200**, **F-242**: "primary Bot" reads "Main Bot".
- **F-025**: "Replace with different Bot" is on the Main Bot's menu.
- **F-245**: the share sheet pre-fills the Main Bot, which is no longer the gateway's `defaultId`.
- **F-259**: choosing another Main Bot moves the star and the tile, and the old one stays as an ordinary Bot; it needs the plugin's gateway-wide record, and without the plugin the item isn't offered.

Still to reword when its work lands: **F-015**: step 1 rewords it to "The Main Bot's avatar carries a gold star badge at its lower right." (`client only: the Main Bot from F-007`) and moves its three checks in the same pull request; until then it stays as it is, `done`. **F-041**'s gateway cell adds "a change applied through Clawtrate's bots plugin is journaled with its before and after, which gives the diff and Undo". Left as they are, because they stay true: F-013 and F-031 (pinned Bots; the Main Bot's tile is above them, F-574), F-027 (Hidden Bots; the gateway's own Bot is never there, #490), F-519 (channel chats; #433 adds to it), F-552 (the rename card; the gateway's own Bot gets none).

**The design's own rows.** F-540 to F-548 are held for this design and are not in `docs/parity.md` yet. Revised:

| Row   | Behaviour                                                                                                                                                                                                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-540 | Setup asks how bots run commands; the new-bot default and the new Main Bot's mode are written and read back; requested and effective access are shown.                                                                                                                                               |
| F-541 | The first run sends its opening once per gateway and Main Bot, including across two devices, a restart and a lost reply, and stops for an explicit retry when delivery is ambiguous; the guided card saves exactly its name, picture and role; the tile changes on the read-back.                    |
| F-542 | A bot's request to change its own settings is a proposal; on 2026.10.6 Review and save opens the person's own editor filled with it and the plugin writes nothing; once the plugin may apply, each field is written with its precondition inside the gateway's write and a changed field is refused. |
| F-543 | Another bot's instructions, more freedom, another account and a bot-chosen picture are always confirmed, and an Undo to more freedom asks.                                                                                                                                                           |
| F-544 | A manager's proposal shows exactly the bot it would create; on 2026.10.6 Create opens New bot filled with those values and the plugin writes nothing; the new bot appears when listed.                                                                                                               |
| F-545 | A bot that isn't a manager can't propose for other bots; the star grants nothing, and moving it moves no grant.                                                                                                                                                                                      |
| F-546 | On 2026.10.6, concurrent submissions respect the open proposal limits, and published proposals survive restart. Once Apply is available, two devices deciding one proposal get one outcome, the claim reserves journal room before writing, and unjournaled effects stay unknown.                    |
| F-547 | An external agent with a grant sees bots and suggests changes within its scope; removing access refuses its next call, and another device can't apply its old suggestion.                                                                                                                            |
| F-548 | A managed bot's denied tools are absent in interactive and scheduled turns, and a bot whose runtime can't enforce them isn't called managed.                                                                                                                                                         |

**New rows: seven, F-570 to F-576**, one for each behaviour this revision adds that no row covers. In `docs/parity.md`'s form, all `both` and `todo`:

| Row   | Area      | Behaviour                                                                                                                                                                                                                                |
| ----- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-570 | Main Bot  | The first run makes a new Bot and makes it the Main Bot, also on a gateway that already has Bots, and none of those Bots becomes the Main Bot.                                                                                           |
| F-571 | Main Bot  | Two devices running the first run on one gateway at once end with one Main Bot, and every device and person on that gateway finds it.                                                                                                    |
| F-572 | Main Bot  | Clawtrate's requests while making the Main Bot write no channel binding and no gateway owner, and a channel message that matches no binding reaches the same Bot before and after.                                                       |
| F-573 | Main Bot  | The Main Bot's identity file tells it that it is the Main Bot and that this gives it no extra access.                                                                                                                                    |
| F-574 | Main Bot  | The Main Bot has a tile of its own at the top of the sidebar, above pinned Bots, that can't be unpinned, hidden or moved.                                                                                                                |
| F-575 | Main Bot  | On a gateway with Clawtrate's bot tools, making another Bot the Main Bot moves the tile, the star and the Main Bot's identity lines, and the old one stays as an ordinary Bot with its tasks.                                            |
| F-576 | Bot setup | A Bot's change to its own name or picture waits for the person's confirmation, unless a setting under Settings → Advanced applies at once a name or picture that this device's message, which started that run, asked for word for word. |

The gateway's own Bot leaving the sidebar, and other tools' sessions leaving a task list, are #490's and #491's rows.

## 16. What is taken from #257, #246 and #147

- **#257** (an open pull request): the two modes and their writes; the Create sequence and held bots, now also run on accept of a create proposal; the deny list, extended (section 12); the approvals-file line; the implicit-`main` reading. Carried into the autonomy PR and the create PR.
- **#246** (an open pull request): the mode wording, and the page and the host both refusing a Create without a choice. Not taken: its exact-path approval probe.
- **#147** (an open pull request): the dialog for choosing another bot (renamed Main Bot, section 4). Not taken: its storage in `clawtrate.primary` and its fallback to the gateway's default, which section 4 replaces. Also taken: the read-back table; the instructions event line, extended with the journal's diff and Undo. Copy, export, import and delete stay with #82.

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
6. **The first run's plugin parts**: the onboarding record and `mainBot` record, the opening's delivery state on the plugin, the Save-to-rail timing (after 1, 4 and 5, and effortless PR 6). The Main Bot itself, made without the plugin, is section 20's build order, which comes first.
7. **Create by chat** in the interface (after 3 and 5).
8. **The MCP relay** (after 1 and 2).
9. **Agents with access** in Settings (after 8).
10. **Installing the plugin**, behind its release gate (section 5).

Describe's route (formerly its own PR) waits for its primitive. Effortless setup's PR 6 owns the pairing-to-composer timing and the first-reply measurement; step 6 adds the Save-to-rail timing to the same harness. #292 closes only when routines and accounts (step 2), create (steps 3 and 7) and the first run (step 6) are in.

### Contract tests that must fail without each behaviour

On a development gateway, against the plugin and the real app, each named for its parity row:

- **F-542**: on 2026.10.6, Review and save opening each editor filled with the proposal, including both selections in the account editor, and the plugin sending no write; a bot deleted and re-created with the same id and identical files between the card and saving, saved only through the editor's fresh read. Once the plugin may apply: a proposal accepted; a combined account and model change selecting a non-default model on the destination account (one model patch, final read-back of that exact model with that account and empty fallbacks, one Undo); an unavailable model refused without writing the model entry; a label and an effort change applied in order, including after an unrelated config edit; an external edit to the confirmed label or the still-pending effort stopping the second write and preserving the first journal entry; a file or routine refused when its precondition changed; a decider who lost admin before the commit; a name field shown with its own button and not applied.
- **F-543**: each always-confirmed mark; an Undo to more freedom asking.
- **F-544**: on 2026.10.6, Create opening New bot filled with exactly the proposal's values. Once the plugin may apply: an existing id refused by `agents.create`; a create answered with another id stopping; a lost answer on `cron.add` converging on one routine.
- **F-545**: a non-manager refused; a star without a manager grant refused; once the plugin may apply, a grant removed before the rebase's snapshot refused, and one removed after it refused inside `config.patch`.
- **F-546 on 2026.10.6, with Apply disabled.** Race two distinct proposals for the last open slot. Run the race once against the gateway limit of 200 and once against the per-source limit of 20. Each time, one proposal is admitted, the other is refused, and the open count stays at the limit. Restart after storing the version but before the ledger publishes it. The proposal list stays unchanged, cleanup can reclaim the version, and a delayed publisher cannot publish it after cleanup. Restart just after publication and verify that the list contains the proposal once, with its original payload and digest. Check that the gateway received no writes to bot settings.
- **F-546 once the plugin may apply**: a full journal refusing the claim before any write, after the service frees what it can; two claims competing for the last journal space; a crash with a reservation held, settled by recovery before the space is released; a journal write failing on the first or a later field, followed by a restart with no entry for that field (unknown, further fields unwritten, Undo offered only for earlier journaled effects); a restart after more than an hour with a confirmed journal entry still awaiting its ledger reference (the effect is recovered and shown as applied); a revocation and a claim racing, decided by the claim's generation check; two devices deciding at once; a supersession racing a commit; a crash between the claim and the write; a lost answer after an independent admin writes the same value, and after one restores the base, both reported unknown with observed values; Undo retried after a lost answer finding its first record.
- **F-541**: two devices opening the first run at once; a restart between the claim and the opening; a lost `sessions.create` answer; `runStarted: false`; an existing key never sent the opening through `sessions.create`; two devices pressing Send it again for an existing, empty task (one `chat.send`, one "Another device is sending it again"); a late answer from the first attempt changing nothing; real composer submission and the card's fill at phone width.
- **F-547**: a grant used; revoked mid-call (the admitted call's outcome recorded, its answer withheld); refused after; another device trying to apply the revoked grant's suggestion; a reconnect with a new generation refused; instructions withheld without the permission.
- **F-548**: each denied tool absent in an interactive and a scheduled turn; ACP refused; a `full` session task shown as not under the limits; a worker-turn bot shown as not fully managed.
- The plugin missing; a gateway switch mid-proposal.

Where these run, as the records PR (step 1) found them:

- **Restarts.** The development gateway never reuses state (`tools/dev-gateway/src/cli.ts`, "State is never reused"), so F-546's restart cases are unit tests over the store until a gateway restart that keeps state exists.
- **F-547's withheld answer** belongs to the relay (step 8). The records PR checks that an admitted call's outcome is recorded and that the next call is refused.
- **F-545's refusals** need a bot's tool, so they are contract tests in step 2; step 1's second part unit-tests the rule and checks `managers.set` on a gateway.
- **F-546 once the plugin may apply** runs as unit tests in step 1's second part; its gateway checks wait for the primitives in "Gated on missing gateway primitives".
- **Step 1's second part, part one** adds the cleanup sweep with its deletion marker (reclaiming unpublished, replaced and retired versions) and grant updates that carry their generation, each with its test. The apply-path records (the claim, the journal, crash settling, Undo, `changes.*`, `managers.set`) follow in part two.
- **Step 1's second part, part two** adds the claim with its journal reservation, the journal in a retained namespace of its own (so the orphan sweep, which scans only the versions, never sees an entry awaiting its reference), crash settling, Undo records, `changes.*` and `managers.set`. Apply and Undo need the conditional writes in "Gated on missing gateway primitives", so they run only in unit tests, through a stand-in for those writes: the shipped plugin is given none, and accept and Undo refuse with `apply-unavailable` and `undo-unavailable`. Every publication's deletion-marker check is in `Records.publish`.

### Not yet established

Whether `messageChannel` is trusted per-turn provenance; whether a plugin's prompt guidance reaches the model before the first turn (step 2 probes it, and the first run doesn't depend on it); whether a subagent spawned by a managed bot carries its denies; proposal persistence across a real restart; the relay's socket and revoke behaviour; any measured first-run time; section 4's channel test on a gateway with several channel accounts and per-account bindings (only one Telegram account was tried, R42 and R43).

## 18. The prototype's states

`main-bot.html` takes `theme`, `width` and `chrome`, as the other pages, and:

| Parameter  | Values                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`     | `setup` (default), `first` (the first run), `rename` (a bot asks to rename itself), `create` (creating a bot by chat), `proposal` (proposals of other origins), `agents` (Settings) |
| `at`       | `start`, `greeted`, `saving`, `done`: a point in the first run; `done` also saves a proposal through its editor                                                                     |
| `card`     | `unconfirmed`, `stale` (the editor on a changed bot), `declined`: other outcomes                                                                                                    |
| `opening`  | `ambiguous`: the first message's delivery couldn't be confirmed                                                                                                                     |
| `existing` | `1`: a Main Bot already made, on another device                                                                                                                                     |
| `plugin`   | `missing`                                                                                                                                                                           |
| `grant`    | `0`: Juniper isn't a manager yet (create)                                                                                                                                           |
| `step`     | `add`, `added` (agents)                                                                                                                                                             |

A stand-in gateway answers after a delay, and the rail changes only on its answer. The rail draws the Main Bot, `clawtrate-main-bot` ("Clawtrate Main Bot" until named, Juniper when it exists already), as its tile with the gold star above the other bots, and keeps the gateway's own bot, `main`, out of it, since other bots exist (check MB-20). Not drawn yet: the guided card's Picture row and manager switch, which still show as a separate picture offer after Save, and the offer to start from what an existing bot knows (#487). The Claws are a stand-in drawn from the name, not #300's creatures, which aren't on `main`. The page is a fixture: it shows each state and proves no gateway effect.

## 19. Not covered

- Deleting, duplicating, exporting and importing bots (#82).
- Raster pictures (#302 §8's gate).
- Direct changes by external agents, and agents on another computer from the Clawtrate app.
- Keeping bots apart on one host under Hands-off.
- Group chats (#83).

## 20. Build order

The Main Bot needs no plugin on OpenClaw 2026.10.6: every write in sections 3 and 4 is one New bot already makes. So it is built first, in pieces a person notices, and the plugin's parts (section 17) join it later.

**The fixture and the development gateway, settled first.** In the fixture, Juniper keeps its place and its tasks but becomes a bot Clawtrate made: its id and every `agent:main:` key of it become `clawtrate-main-bot` and `agent:clawtrate-main-bot:`, and a new gateway bot, id `main`, named "main", the default, with no picture and one channel-fed main conversation, is added; #490 keeps it out of view. The development gateway's seed does the same: it seeds Juniper as `clawtrate-main-bot` beside a default `main`. Whichever of #490 and step 1 lands first makes both changes, moves the three F-015 checks to "no star" (#490) or "the gold star on `clawtrate-main-bot`" (step 1), and regenerates the visual baselines on macOS in a commit of its own that changes only baselines, listing in the pull request the shots that changed for any reason other than the sidebar's top.

1. **The Main Bot is a bot Clawtrate makes** (F-570 to F-574, F-015; the smallest change a person notices). Clawtrate reads section 4's record; with no Main Bot it shows "Set up your Main Bot", and with full control it makes `clawtrate-main-bot` with New bot's sequence (`agents.create`, the identity file with section 4's lines, the fallbacks, the first task) and opens its chat. The Main Bot gets its tile and the gold star; the old neutral star on the gateway's default goes. In this step the person names the bot in the chat, and #431's rename card (F-552, on `main`) confirms it; no guided card yet. Includes section 4's channel contract test, and rewords F-015 to the gold star with its checks in the same pull request: today `e2e/preview.spec.ts` (the rail check) and `apps/mobile/simulator/ios.test.ts` expect the star on the gateway's default bot, and `visual/bots.visual.spec.ts` expects the neutral badge. In the same step the rename card's test of the gateway's own bot (#431, `isDefault` in `packages/core/src/mapping.ts`) takes section 4's `selectionRequired` exception, so the card and the sidebar agree on which bot that is (#471). _Needs_: full control from the pairing (#393, still behind its flag, and #418's offer for a device paired with less), and, for OpenClaw on this Mac, the local connection's proof and its full-control pairing (#404, #417, #421). Without full control, the tile and its request are what a person sees. Works with #490 and #491 when they land; doesn't wait for them.
2. **The first run's chat** (F-006, F-541 without the plugin's record). Clawtrate's opening and its caption, the greeting, the guided card with name, picture and role, one `agents.update` for name and picture, the role in `AGENTS.md`, the second-device and lost-reply cases. _Needs_: step 1; #302's shared name and PNG contract and #435 for the Picture row (until then the row isn't shown); effortless setup's first-run measurement.
3. **Apply a bot's changes to itself at once** (F-576). The setting under Settings → Advanced, Undo, and section 4's rule for which message confirms. _Needs_: #431 (on `main`), full control for the write.
4. **Starting from what an existing bot knows.** The first run's offer card (section 3), wired to #487's first piece. _Needs_: step 2 and #487.
5. **The plugin's parts**: the gateway-wide `mainBot` record, the onboarding record, the Main Bot's manager grant and its switch on the guided card, the Main Bot lines rewritten to name the proposal tools, then section 17's order. _Needs_: the plugin's install gate (section 5).
6. **Making another bot the Main Bot** (F-259, F-575, F-025's item). "Choose your Main Bot", the plugin's `mainBot` record changed for everyone, the identity lines moved. _Needs_: step 5 (the plugin's `mainBot` record).

The two choices still with the product owner change only step 1's tile: the default needs nothing more; the stand-in star would add a migration to step 1 and an exception to #490.
