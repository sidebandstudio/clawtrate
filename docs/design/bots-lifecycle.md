# A bot's life: the primary bot, editing, copies and deleting

What happens to a bot after it is created: which bot is the primary one, how its picture, name, label and instructions change, what a change to its instructions made in a conversation looks like, and how it is duplicated, exported, imported and deleted. This part of the design comes after `visual-language.md`, `conversation.md`, `bots.md`, `work-pane.md`, `controls.md` and `setup.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-005, F-007, F-026, F-034 to F-041, F-048 to F-050, F-052, F-259, F-265, F-269 to F-271, F-276 and F-464. What the gateway does is in `docs/research/bots-lifecycle.md`, run on a development instance and read in the installed OpenClaw 2026.10.6. Section 12 ties every control to the fact behind it. Section 13 lists the rows reworded and the rows this design differs from.

Two rules sit above the rest. **Nothing is announced that was not read back**: a save, a copy and a delete each say what the gateway has afterwards, step by step, and after a failure in the middle they say what is there and what is not. **What the gateway cannot do is drawn as what is true**: where it has no way to export a bot, or to make a picture from here, the screen says so plainly and offers what does work.

The prototype is `prototype/lifecycle.html`: `bots.html` with these screens added, its states picked from the address (section 14). The styles are in `prototype/css/lifecycle.css` and the behaviour in `prototype/js/lifecycle.js`. `prototype/tools/checks/lifecycle.mjs` checks them.

## Contents

1. How the pieces fit
2. Shared rules
3. The primary bot
4. The picture
5. The name and the label
6. Instructions
7. A change to the instructions, in the conversation
8. Duplicate
9. Export and import
10. Delete
11. Phone, themes, read-only, keyboard
12. What the gateway's facts drive
13. Parity rows
14. For builders
15. Not covered here

## 1. How the pieces fit

```
rail                          the primary bot's star; a bot's menu: Rename, Duplicate…, Export…,
                                Make primary bot or Replace with different bot, Delete…
  double-click a name           rename in place (F-026)
"+" menu                      New task, New bot (bots.md §3), Import a bot…
Work pane, its hero           the picture opens the picture editor; the name and the label edit in place
Work pane, Settings tab       bots.md §8's frame, in this order:
  About                         Instructions: AGENTS.md and SOUL.md (section 6)
  Model                         bots.md §9-13, not redesigned here
  Tools, Memory, Usage          controls.md and the work on its pages, not redesigned here
  Runs on                       controls.md §14 and the work on where a bot runs
  Manage                        primary bot, Duplicate…, Export…, Delete… (sections 3, 8-10)
transcript                    the event line for a change to the instructions (section 7)
dialogs                       first-run introduction, choose a primary bot, picture, duplicate,
                                export, import, delete
```

Nothing here touches the account row, the Model and Effort selects, the Usage page or the page for where a bot runs, which are being built from `bots.md` and `controls.md` now. The About group replaces `bots.md` §8's two outline rows with one (section 6); the Manage group is new and sits last, after Runs on.

## 2. Shared rules

### Components used

| Component                                                             | From                                  | Used for                                                   |
| --------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| Dialog, dialog head, choice list, picture picker, note, result, check | `bots.md` §2                          | Every dialog here                                          |
| The access bar and its states                                         | `conversation.md` §3, `bots.md` §2    | Admin access, and the interactive tier for the primary bot |
| Fact block, group word, sub-page head, `.b-open` rows                 | `visual-language.md` §9, `bots.md` §8 | The Settings tab's About and Manage groups, Instructions   |
| The command line with its copy button                                 | `conversation.md` §9, `bots.md` §10   | Every command a person runs on the gateway's machine       |
| Event line that opens (`.event-details`)                              | `bots.md` §12                         | A change to the instructions                               |
| Tabs                                                                  | `visual-language.md` §9               | The picture editor                                         |
| The confirmation's danger button                                      | `bots.md` §7                          | Delete                                                     |

### New components

Each is defined once, in `prototype/css/lifecycle.css`, from existing tokens.

| Component                         | What it is                                                                                                                                                                                                               | Tokens                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Star (`.lc-star`)                 | The primary bot's mark: a 16 px disc in the accent with a white star, on the avatar's lower right, ringed by the surface it sits on. 30 px in the introduction. It is the accent's one use here.                         | `--accent`, `--accent-on`, `--bg-rail`        |
| Field in place (`.lc-inline`)     | The name or the label as a field of its own size, on `--bg-inset`, with a 1.5 px `--border-strong` ring, centred in the hero, left-aligned in the rail.                                                                  | `--bg-inset`, `--border-strong`               |
| Drop area (`.lc-drop`)            | Upload's target: a 1.5 px dashed `--border-strong` outline, radius 18. The one outline here, because it marks where a file can go.                                                                                       | `--border-strong`, `--radius-lg`              |
| Crop (`.lc-crop`)                 | The chosen image in a square, radius 14, with the circle that becomes the picture cut out of a dark veil, and a Zoom slider under it.                                                                                    | `--bg-inset`, `--radius-md`                   |
| Diff (`.lc-diff`)                 | Lines as the file has them, in mono at 12: a removed line on `--danger-soft` after "−", an added one on `--accent-soft` after "+", context muted. Each changed line also says "Removed:" or "Added:" to a screen reader. | `--bg-code`, `--danger-soft`, `--accent-soft` |
| Steps (`.lc-steps`, `.lc-result`) | A list of what a copy or a delete did, each line with its state mark (done, working, waiting, failed, unknown) and a word at its end.                                                                                    | the state marks of `conversation.md` §2       |

### Access

Reading is the read tier: every screen here shows its values to a read-only connection. Choosing a primary bot saves a preference for the person and needs the interactive tier (`users.prefs.set`, `operator.write`); the dialog's bar says "**Read-only.** Choosing a primary bot needs the interactive tier: it saves a preference for you on the gateway." with "Request access", the interactive tier's request of `conversation.md` §3. Everything that changes a bot needs admin (`agents.update`, `agents.files.set`, `config.patch`, `agents.create`, `agents.delete`): below admin the controls are absent or text, and the screen's foot has `bots.md` §2's admin bar with this screen's words: "Changing <Bot>'s picture needs admin access.", "Changing <Bot>'s instructions needs admin access.", "Duplicating <Bot> needs admin access." Admin access is asked for only by that bar's button, never by opening a screen. The commands of Export and Import are text for the gateway's owner, shown at every tier.

### Read back

Every write is followed by the read that shows its result, and the screen changes only on that read:

| Write                                    | Read                                                            | Says it worked when                                                                          |
| ---------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `users.prefs.set` (primary bot)          | `users.prefs.get`                                               | the key holds the bot                                                                        |
| `agents.update {name}`                   | `agents.list`                                                   | the bot's name is what the list returns (it may be trimmed)                                  |
| `config.patch` identity.theme (label)    | `agents.list`                                                   | `identity.theme` is the label                                                                |
| `agents.update {avatar}`                 | `agents.list`                                                   | `avatarUrl` is the picture sent; an `ok` alone is not enough                                 |
| `agents.files.set`                       | `agents.files.get`                                              | the hash is the hash of the text sent                                                        |
| `agents.create` and the writes of a copy | `agents.list`, `agents.files.get`, `config.get`                 | each step's value is there                                                                   |
| `agents.delete`                          | `agents.list`, `sessions.list {agentId}`, `cron.list {agentId}` | the bot, its tasks and its routines are gone; files from the answer's `removed` and `failed` |

### Input

- Every dialog is modal, as in `bots.md` §2: Tab stays inside, Escape closes it unless something is being written, focus returns to what opened it. A dialog opened from a bot's menu returns focus to that bot's row.
- Radio groups (bots, shapes, colours, accounts) and the picture editor's tabs have one tab stop; arrows move and choose; Home and End go to the ends.
- A field in place: Enter saves, Escape puts the text back, leaving the field saves.
- One polite live region announces: "<Bot> is your primary bot", "<Bot> is your primary bot on this device", "Couldn't save your choice", "<Bot> keeps the star, as the gateway's default bot", "Picture saved", "The gateway didn't save the picture", "The gateway doesn't show the picture", "Renamed to <name>", "Couldn't rename", "Label saved", "Label removed", "Instructions saved", "Saved over the gateway's copy", "Accepted", "Undone", "Nothing was undone", "<Copy> is ready", "<Copy> was made, without its instructions", "<Bot> was deleted", "Deleted, with one folder left", "No longer listed", "The gateway didn't delete it", and the copy results of `conversation.md` §9.

## 3. The primary bot

**What it is.** The primary bot comes first in the person's list with a star, and it is the bot Clawtrate offers when something is shared into the app. That is all it does: no gateway method or setting makes a bot "primary" in this sense, and the one setting that names a default bot, `agents.defaults.systemAgent`, also decides where channel messages that no route claims are delivered (research §1). Clawtrate never writes it.

**Where it is kept.** In the person's own preferences on the gateway, key `clawtrate.primary`, value `{bot: <id>}` or `{bot: null}` for "keep the gateway's default". The same person's other devices read it and follow `users.prefs.changed`; other people who use the gateway have their own. When the gateway answers `no_durable_identity`, the value is kept on the device, as F-266 keeps a manual order.

**Before a choice.** The star is on the gateway's default bot, `agents.list` `defaultId`, which the built rail already marks; the Manage group says "Yes, as the gateway's default".

**Introducing the primary bot** (F-007). Shown once, after setup, when the gateway lists more than one bot and the key is absent. Title "Introducing the primary bot"; the default bot's picture at 104 px with the star; "Your primary bot comes first in your list, with a star, and it's the bot Clawtrate offers when you share something into the app." and "Choosing one changes nothing on the gateway. <Default> has the star until you choose: it's the gateway's default bot." Then where it is kept (below). Buttons: "Use an existing bot" (primary, focused), "Create primary bot" (admin only; it opens New bot, `bots.md` §3, and the bot it makes is saved as primary once the gateway lists it), "Not now" (saves `{bot: null}`, so the dialog does not return, and announces "<Default> keeps the star, as the gateway's default bot").

**Choose a primary bot** (F-259), from "Use an existing bot", from the primary bot's menu item "Replace with different bot", and from Manage. A search field (focused), the bots as a radio group with picture, name, label and, under each, "Your primary bot" and "The gateway's default bot" where they apply; the current one checked. Under the list, where it is kept:

| The gateway keeps preferences for this connection | The line                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Yes                                               | "Kept for you on this gateway, so your other devices show the same star. Other people who use this gateway choose their own." |
| No (`no_durable_identity`)                        | "This device only: this connection has no profile on the gateway to keep it in, so your other devices won't show it."         |

and "The gateway's own default bot stays <Default>. Clawtrate doesn't change it: the gateway uses it for messages no route claims." "Confirm" is disabled until another bot is checked.

| State                  | It shows                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saving                 | "Saving…" on the button, busy                                                                                                                                                 |
| Saved (read back)      | The dialog closes, the star moves, "<Bot> is your primary bot" (with "on this device" when kept there)                                                                        |
| Failed                 | On `--danger-soft`: "**Couldn't save your choice.** The gateway didn't answer. Your primary bot is still <Bot>." The button reads "Try again".                                |
| Crossed another device | On `--warn-soft`: "**Another of your devices chose <Other> a moment ago.** That's what the gateway has now. Confirm to choose <Bot> instead." The star is already on <Other>. |
| Read tier              | The list, not choosable; the bar of section 2                                                                                                                                 |

"Make primary bot", on any other bot's menu and in its Manage group, saves at once with the same states. The primary bot's menu has "Replace with different bot" where others have "Delete…", and its Manage group's Delete is disabled with "<Bot> is your primary bot. Choose another primary bot before deleting it." When the stored bot is no longer listed (deleted elsewhere), the star falls back to the default bot and the key is left as it is until the person chooses again.

## 4. The picture

The hero's picture, on an admin connection, is a button, "Change <Bot>'s picture", with a small picture badge on hover and focus. It opens **<Bot>'s picture**, three tabs: Bot, Generate, Upload (F-037, F-269, F-270). Below admin the picture is only a picture.

**Bot.** The live picture at 104 px, then: "The gateway keeps <Bot>'s picture, not the shape and colour it was drawn from. Pick both to draw a new one." Then `bots.md` §3's eight bodies and eight colours, none chosen at first, because the gateway does not keep which were. "Set picture" is enabled once both are chosen; Clawtrate draws the character and sends it as a PNG `data:` URL of at most 32,768 characters, as New bot does.

**Generate.** Whether the gateway offers the bot its image tool is read from `tools.effective` for the bot's latest task:

| What `tools.effective` says              | The tab shows                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image_generate` excluded, or not listed | "Image generation isn't available on this gateway" and "The gateway doesn't offer <Bot> its image tool: “<the gateway's reason>”, in the gateway's own words." "Generate" disabled. |
| The bot has no task to ask about         | "Not known yet" and "The gateway says which tools <Bot> is offered for one of its tasks, and <Bot> has none yet. Start a task, then look here again."                               |
| `image_generate` offered                 | "Not in this version" and "<Bot> is offered the gateway's image tool, but Clawtrate can't make a picture with it yet. Ask <Bot> for one in a task." "Generate" disabled.            |

The third row is smaller than F-269 asks: what the tool returns when called from outside a conversation was not established (research §4).

**Upload.** A drop area: "Drop an image here", "Browse files", "PNG, JPEG, WebP or GIF, under 25 MB." Then:

| State        | It shows                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Chosen       | The crop, Zoom, and "<file> · <size>. Drag to move it in the circle. Clawtrate saves the circle's square at 128 by 128 pixels." "Set picture" |
| Too large    | On `--warn-soft`: "**That image is 31.4 MB.** Choose one under 25 MB. <Bot>'s picture is unchanged."                                          |
| Not an image | On `--warn-soft`: "**<file> isn't an image.** Choose a PNG, JPEG, WebP or GIF file."                                                          |

The 25 MB check is the file's, before cropping. What is sent is the crop, 128 × 128, so it fits Clawtrate's 32,768 characters and the gateway's 2 MiB (research §3).

**Saving**, from either tab: "Saving…" on the button; then `agents.list`.

| The read back                         | It shows                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `avatarUrl` is the picture sent       | The dialog closes; the hero, the rail and the title pill show it; "Picture saved"                                                                               |
| The write was refused                 | On `--danger-soft`: "**The gateway didn't save the picture:** it refused the change. <Bot>'s picture is unchanged."                                             |
| `ok`, but the list returns no picture | On `--danger-soft`: "**The gateway took the picture but doesn't show it.** Its list of bots returns no picture for <Bot> now, so no device will show this one." |

The last row is what the gateway did with a picture over its limit and with a value that is not an image (research §3); Clawtrate's own pictures should never reach it, and if one does, it is said.

## 5. The name and the label

**The name** (F-038, F-026). In the hero, on an admin connection, the name is a button, "<Bot>. Rename". Clicking it turns it into a field in place with the text selected. Enter, or leaving the field, saves with `agents.update {name}`; Escape puts it back. While saving, the field is read-only and "Saving…" is under it. Then the name is what `agents.list` returns, which can differ from what was typed, and "Renamed to <name>" is announced. An empty name is not sent: "A bot needs a name." A refusal keeps the field with the typed text: "Couldn't rename: the gateway refused it. The name is still <Bot>." In the rail, a double-click on a bot's name, or "Rename" in its menu, makes the same field in the row, with the same rules. Any admin connection can rename: the gateway has no owner check. Renaming keeps the id.

**The label** (F-039, F-271). Under the name: the label, or "Add a label" in `--text-faint`, as a button. It edits in place the same way and saves `agents.entries.<id>.identity.theme` with `config.patch`; an empty label removes it ("Label removed"). A rename keeps the label (research §2). On the phone the label is called "Title": the empty one reads "Add a title", and its field is named "Title" (F-271).

Below admin, the name and the label are text.

## 6. Instructions

**Instructions** is the About group's one row: "AGENTS.md, 5 lines · SOUL.md, 1 line". It opens the **Instructions** page inside the Settings tab (F-040), with a quiet round Back.

The page: "<Bot> reads these two files at the start of each new task. A task already open keeps the copy it started with. Changed <date and time>." Then two fields in mono, each with its file:

- **Instructions** · AGENTS.md: "How it works: rules, priorities, what to do and not do."
- **Personality** · SOUL.md: "Its tone and manner."

Then: "Past 20,000 characters the gateway loads the start and the end of a file and leaves out the middle. Memory is separate: what <Bot> remembers is under Memory, and these files don't change it." Memory (MEMORY.md, USER.md and notes) is `controls.md` §12's page; nothing here reads or writes it.

"Save" is enabled once either file differs from what was read. It writes each changed file with the hash it was read with, then reads it again.

| State                  | It shows                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved (hash read back) | "Saved 5:44 PM. The gateway has this text now." "Instructions saved"                                                                                                                                                                           |
| Failed                 | "Couldn't save: the gateway didn't answer. Your text is kept here."                                                                                                                                                                            |
| Changed on the gateway | On `--warn-soft`: "**<Bot>'s instructions changed on the gateway while you were editing.** Your text is kept here. The gateway now has:" and its text, with "Save mine over it" and "Use the gateway's". Save is disabled until one is chosen. |
| Below admin            | The two files as text, and the admin bar: "Changing <Bot>'s instructions needs admin access."                                                                                                                                                  |

The gateway sends nothing when these files change (research §5), so the page finds out about another change when it saves, from the gateway's refusal, and not before.

## 7. A change to the instructions, in the conversation

**What it is on this gateway** (F-041). A bot changes how it behaves when one of its runs writes its AGENTS.md or SOUL.md with a file tool. Clawtrate sees the tool's name and path in the run's tool events. Nothing else announces it: a change made by a shell command, on the gateway's machine or by another app leaves no line.

**The line.** When a `write`, `edit` or `apply_patch` call in a run ends without an error on one of those two paths, the task gets an event line that opens: "<Bot> changed its instructions". Opened:

- "AGENTS.md, since Clawtrate read it at 5:38 PM", and the diff: the lines removed and added, between the last copy Clawtrate read of the file and the file as `agents.files.get` returns it now. The heading names that copy's time because nothing says what the file held just before the run; another change in between is in the diff too.
- "Accept", "Undo", and "The change is already saved on the gateway."

| State              | It shows                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted           | "Accepted. The change was already on the gateway, so nothing was written." The line ends "· accepted".                                                         |
| Undoing            | "Undoing…"                                                                                                                                                     |
| Undone (read back) | "Undone. AGENTS.md on the gateway is back to Clawtrate's copy from 5:38 PM." The line ends "· undone".                                                         |
| Undo refused       | "Nothing was undone: AGENTS.md changed again after this run. Open the instructions to see what it has now." with "Open instructions"                           |
| No earlier copy    | "<Bot> wrote to AGENTS.md in this run. Clawtrate has no earlier copy of the file to compare, so it can't show the change or undo it." with "Open instructions" |
| Below admin        | "Accept" only, and "The change is already saved on the gateway. Undoing it needs admin access."                                                                |

Undo writes Clawtrate's copy with the file's current hash, so it never overwrites a change made after the diff was drawn. Clawtrate keeps a copy of a bot's two files from its last read: when the bot's settings or its Instructions page open, and after each line like this one. The no-copy state is why F-041 is listed for a decision (section 13).

## 8. Duplicate

"Duplicate…", in a bot's menu and its Manage group (admin), opens **Duplicate <Bot>** (F-048):

- "Name of the copy", filled with "<Bot> copy", focused. The gateway makes the copy's id from its name and refuses a taken one; the refusal is shown under the field in the gateway's words.
- **Copied to it**, a checklist, all ticked:
  - "Picture and label": "The picture the gateway has for it, and its label."
  - "Model, account and effort": "<account>, <model>, effort <level>." When the bot's account is kept by the bot alone (`bots.md` §7, "Kept by one bot"), the item reads "Model and effort, on an account you choose", "<label> is kept by <Bot> alone, so the copy can't use it.", and a radio list of the shared accounts follows; Duplicate waits for a choice.
  - "Instructions and personality": "AGENTS.md and SOUL.md, as they are now."
  - "Tool permissions and skills": "What it may do with its tools, and which skills it has."
- **Not copied**, always listed, from what was read when the dialog opened: "Its memory: MEMORY.md and 3 notes, and About you (USER.md)"; "Its 4 tasks and their history"; "Its 2 routines: Weekly plan, Sunday reminder. A copy would run them twice."; "The other files in its workspace folder"; "Its channel route: messages keep going to <Bot>" when it has one; "Its own sign-ins (<label>), which only <Bot> can use" when it has them; "Approvals saved for its commands, and rules kept by Clawtrate's rules plugin".
- "The copy is a new bot with its own workspace folder. Nothing links it to <Bot> afterwards: changing one doesn't change the other."

"Duplicate" runs the steps in order and shows them as they go, each with its state: "Made <Copy>", then the ticked items, then "Read back <Copy> from the gateway". There is no way to make a bot and its settings in one step, so each is written and read back on its own (research §7).

| How it ends                          | It shows                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every step read back                 | Title "<Copy> is ready"; the steps, all Done; "Read back from the gateway: <Copy> is listed with what's ticked above. It's a new bot with its own workspace folder; nothing links it to <Bot>." "Open <Copy>"                                                                              |
| A step after the bot was made failed | Title "<Copy> was made, without <Bot>'s instructions"; that step "Not copied"; on `--danger-soft`: "**Its instructions weren't copied:** the gateway didn't answer. <Copy> has the gateway's starting AGENTS.md and SOUL.md." "Try again" (the missing steps only) and "Leave it as it is" |
| The bot was not made                 | The form again, and under the name, on `--danger-soft`: "**The gateway didn't make the copy:** “agent "pip-copy" already exists”. Nothing was made." Duplicate is enabled again.                                                                                                           |

A create that got no answer follows `bots.md` §3: the list is read for the bot it may have made before anything is sent again.

## 9. Export and import

The gateway has one portable format, its experimental Claw package, made and read only by its own command line; it has no method a client can call for either, and it exports only a bot that was installed from a package (research §8). Clawtrate does not make a file of its own: no other gateway could read it. So:

**Export…**, in a bot's menu and Manage group, at every tier, opens **Export <Bot>**, worded by `agents.list` `createdVia`:

| `createdVia` | It shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claw`       | "<Bot> was installed from a package, so the gateway can export it again with its own command line. Clawtrate can't make a package itself. On the gateway's machine:" `OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws export <id> --out ./<id>-claw` with its copy button. "The package holds": "<Bot>'s name, and the settings and files its package manages". "It doesn't hold": "Its memory, its tasks and their transcripts", "Sign-ins and keys", "Its channel routes". |
| `operator`   | "The gateway can't export <Bot>" and "The gateway exports only bots installed from a package. <Bot> was made with the gateway's create method, which gives it settings a package can't hold, and Clawtrate has no other way to export a bot." "To keep a copy on this gateway, duplicate it instead." with "Duplicate…" (admin)                                                                                                                                           |
| none         | "<Bot> isn't in a package" and "The gateway exports only bots installed from a package, and Clawtrate has no other way to export a bot. The gateway's owner can check whether the gateway would put <Bot> in one, without changing anything:" `OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws migrate <id> --dry-run` "If it can, the same command without `--dry-run` asks before it does; then the export command works."                                                 |

Each ends "Packages are an experimental part of the gateway, switched on by the first word of each command; their format may change." Bots Clawtrate creates are made with `agents.create`, so on this gateway none of them can be exported: F-049 is listed for a decision.

**Import a bot…**, in the "+" menu, opens **Import a bot**: "The gateway adds a bot from a package with its own command line. Clawtrate can't read a package or add one itself. On the gateway's machine:" and two numbered steps:

1. "See what the package would create, without changing anything. The gateway lists the bot, its folder, every action and what it would need:" `OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws add ./pip-claw --dry-run`
2. "Add it, with the digest the first command printed. The gateway refuses if anything changed since:" `OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws add ./pip-claw --yes --plan-integrity <digest>`

"The new bot appears in your list when the gateway lists it." Clawtrate reads `agents.list` on `config.changed`, which an add sends (research §8). The gateway's printed plan is the review F-265 asks for; Clawtrate does not draw one, because it cannot read the package. F-265 is listed for a decision.

## 10. Delete

"Delete…" is in every bot's menu except the primary bot's, and in Manage (admin). It is disabled in Manage, with its reason, for the primary bot (section 3) and when the gateway has only one bot: "<Bot> is the gateway's only bot, and the gateway doesn't delete its only bot."

**Reading first.** The dialog opens on "Reading what <Bot> has on the gateway…" while it reads, for that bot, `agents.list` (every bot's workspace folder), `sessions.list`, `cron.list` with disabled routines, `agents.files.list` and `agents.workspace.list` (its memory files and file count), and `config.get` (its channel routes). If a read fails: "**Couldn't read what <Bot> has.** The gateway didn't answer. Clawtrate doesn't delete a bot without saying what goes." with "Try again" and "Cancel". Nothing in the dialog comes from an earlier read.

**Delete <Bot>?** (F-050, F-276, F-464), role `alertdialog`, focus on Cancel:

- **Removed from the gateway**: "<Bot>'s settings" (with ", and its channel route: messages on it go to the gateway's default bot" when it has one); "Its 4 tasks, from every task list"; "Its 2 routines: Weekly plan, Sunday reminder"; "Approvals saved for its commands". These go whatever the box below says.
- A check, unticked: "Also move <Bot>'s folders to the Trash on the gateway's machine", and under it, muted until ticked:
  - "Its workspace folder, workspace-pip: 23 files, its memory among them (MEMORY.md and 3 notes)", or, when another bot's workspace is the same folder, "Its workspace folder, workspace-juniper, stays: also used by Juniper."
  - "Its own folder, with the sign-ins only <Bot> uses (<label>)", or "Its own folder"
  - "Its tasks' transcripts"
- **Stays**: "All three folders above, where they are now" (unticked only); "Accounts other bots use, and shared memory"; "What <Bot> said in other bots' tasks"; "Anything in the Trash, until it's emptied there".
- "This can't be undone from Clawtrate." "Cancel" and "Delete <Bot>" (danger).

Clawtrate always sends `deleteFiles` as the box says; the gateway's own default is to delete the files (research §9). It never removes a folder another bot uses: the gateway skips it, and the screen says it stays before and after.

**After.** "Deleting <Bot>…", then the reads again, and a list of what the gateway has now, under "Read back from the gateway just now:":

| How it ends          | Title                                              | Lines                                                                                                                                                                                                                                                                                                                                                             | Actions             |
| -------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| All of it            | "<Bot> was deleted"                                | "No longer in the gateway's list of bots"; "No tasks of <Bot>'s listed"; "No routines of <Bot>'s"; and either "Its folders stay on the gateway's machine, as asked", "Its workspace folder, its own folder and its tasks' transcripts moved to the Trash", or "Its own folder and its tasks' transcripts moved to the Trash; workspace-juniper stays for Juniper" | Close               |
| A folder in `failed` | "<Bot> was deleted, but one folder is still there" | The first three, "Its own folder and its tasks' transcripts moved to the Trash", and, failed: "workspace-pip wasn't moved: permission denied. It's still on the gateway's machine." "Trying again moves what's left. The gateway keeps a record of the delete until it's complete."                                                                               | Try again, Leave it |
| The answer was lost  | "<Bot> is no longer listed"                        | The first three, read back, and, unknown: "What happened to its folders: the gateway's answer was lost". "Trying again finishes the same delete: the gateway keeps a record of it until it's complete."                                                                                                                                                           | Try again, Close    |
| Refused              | "The gateway didn't delete <Bot>"                  | On `--danger-soft`, the gateway's message in quotes, then "Nothing was removed." For the bot that holds the gateway's shared or inherited sign-ins, "Other bots use sign-ins kept in <Bot>'s folder. The gateway's owner moves them first, on the gateway's machine."                                                                                             | Close               |

Each line comes from the reads after the delete, not from the answer alone. When the deleted bot was the person's primary bot, the star returns to the default bot.

## 11. Phone, themes, read-only, keyboard

| Concern       | Rule                                                                                                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Widths        | At 1440, 1100 and 800 the dialogs are centred cards (Delete 480 px, the others 440). At 390 every dialog is a sheet the height of the screen less 8 px, as `bots.md` §2 says; the Settings tab is the one-pane layout's Work pane, and the hero's fields fit its width. Nothing in a list or a step line is cut: they wrap. |
| Phone words   | The label is "Title" (F-271). A bot's menu is its long-press menu; renaming in place is the profile's Edit mode, since there is no double-click.                                                                                                                                                                            |
| Themes        | Every colour is a token; the star is the accent in both; the diff uses the soft fills; the screenshots show both.                                                                                                                                                                                                           |
| Read-only     | Every value and list shows; nothing that writes is offered; the primary bot asks for the interactive tier, everything else for admin, by its bar.                                                                                                                                                                           |
| Keyboard      | Section 2. The rail's rename starts from the menu's "Rename" as well as a double-click, so it needs no pointer.                                                                                                                                                                                                             |
| Screen reader | The star is an image named "Primary bot". The hero's buttons say what they do ("Change Juniper's picture", "Juniper. Rename", "Add a label"). The diff says "Removed:" and "Added:". Step and result lines are a list with their state words.                                                                               |
| Motion        | The picture badge fades in over `--dur-quick`; nothing else moves; reduced motion drops the fade.                                                                                                                                                                                                                           |

## 12. What the gateway's facts drive

"Research" is `docs/research/bots-lifecycle.md`, by section. "Live" was run on the development instance; "source" was read only.

| #   | Fact                                                                                                                                                                                                                                                                                                | Drives                                                                                                 | Source               | Verified                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------- |
| 1   | `users.prefs` is per user profile; a second device of the same person reads it and gets `users.prefs.changed`; `no_durable_identity` without a profile. Read `operator.read`, write `operator.write`.                                                                                               | Where the primary bot is kept; "This device only"; the interactive tier (section 3)                    | research §1          | live; `no_durable_identity` source    |
| 2   | `agents.list` `defaultId` follows `agents.defaults.systemAgent`, which also takes channel messages no route claims.                                                                                                                                                                                 | The star before a choice; Clawtrate never writes it (section 3)                                        | research §1          | live                                  |
| 3   | A gateway always lists at least one bot, and refuses to delete its only one.                                                                                                                                                                                                                        | No first-bot creation (F-005); Delete disabled for the only bot                                        | research §1, §9      | source                                |
| 4   | `agents.update {name}` (admin) renames, possibly trimmed; `agents.list` reads it back; other clients get `config.changed`; no owner check.                                                                                                                                                          | The name in place (section 5)                                                                          | research §2          | live                                  |
| 5   | The label is `identity.theme`, written with `config.patch` (admin), kept through a rename.                                                                                                                                                                                                          | The label in place (section 5)                                                                         | research §2          | live                                  |
| 6   | `agents.update {avatar}` answers `ok` for a picture over 2 MiB and for a non-image, and `agents.list` then returns no `avatarUrl`; pictures within the limit come back whole. Clawtrate keeps at most 32,768 characters.                                                                            | Saving a picture only on the read-back; the third result row; the 128 px crop (section 4)              | research §3          | live                                  |
| 7   | The gateway keeps a picture, not the shape and colour it was drawn from.                                                                                                                                                                                                                            | Nothing chosen in the Bot tab (section 4)                                                              | research §3          | source                                |
| 8   | `tools.effective {sessionKey}` lists `image_generate` as offered or excluded with the gateway's reason; it needs an existing task. What `tools.invoke` returns for it was not established.                                                                                                          | The Generate tab's three states (section 4)                                                            | research §4          | live for excluded; offered unverified |
| 9   | `agents.files.get`/`set` cover the six bootstrap files only; `set` with a stale hash is refused with the current hash; a read-only connection can read and not write.                                                                                                                               | Instructions, its conflict state, below admin (section 6)                                              | research §5          | live                                  |
| 10  | AGENTS.md is the operating instructions, SOUL.md the persona; memory is MEMORY.md, USER.md and `memory/`; a file past 20,000 characters is cut when loaded; a task keeps the copy it started with.                                                                                                  | The page's words, and "Memory is separate" (section 6)                                                 | research §5          | source                                |
| 11  | No event announces a change to these files; a run's file tool events carry the tool's name and path (with `tool-events`).                                                                                                                                                                           | The event line's trigger, its "since" heading, and the absence of a line for other changes (section 7) | research §5, §6      | live (a write to another file)        |
| 12  | No duplicate method; `agents.create` makes an id from the name, refuses a taken one, and gives the bot its own folders and starting files; the steps are separate writes.                                                                                                                           | Duplicate's steps, its partial result (section 8)                                                      | research §7          | live                                  |
| 13  | An account kept in one bot's own store is not usable by another.                                                                                                                                                                                                                                    | "Model and effort, on an account you choose" (section 8)                                               | `bots.md` §20 row 33 | source                                |
| 14  | Packages are made and added only by the gateway's command line, experimental; export needs `createdVia: "claw"`; a bot made with `agents.create` cannot be enrolled; an add sends `config.changed` and the bot is then listed.                                                                      | Export's three forms and Import (section 9)                                                            | research §8          | live                                  |
| 15  | `agents.delete` removes settings, routes, routines and saved approvals, and drops the tasks from every list, with or without files; with files it moves the workspace, the bot's own folder and the transcripts to the Trash, skipping a folder another bot uses; `deleteFiles` defaults to `true`. | What the confirmation lists and the box (section 10)                                                   | research §9          | live                                  |
| 16  | A folder it cannot move comes back in `failed[]` inside `ok`; calling again resumes and finishes; it refuses, changing nothing, for the shared sign-ins' bot, the only bot and the owner of inherited sign-ins.                                                                                     | The result rows, Try again, the refused state (section 10)                                             | research §9          | live; only-bot and inherited source   |

## 13. Parity rows

Statuses stay as they are. Only the cells named below change, and only as written here.

| Row   | Cell               | New wording                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Why                                                                                                          |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| F-007 | gateway dependency | partial: the gateway's default Bot is `agents.list` `defaultId` (`operator.read`): a sole agent, else `agents.defaults.systemAgent.agentId` in an explicit roster, else the first configured entry. `systemAgent` also receives channel messages no binding claims, so Clawtrate never writes it. Keep Clawtrate's primary Bot in `users.prefs` key `clawtrate.primary` (`users.prefs.set`, `operator.write`; read with `users.prefs.get`, `operator.read`), per user profile; on `no_durable_identity` keep it on the device.                                                                                                                                                                                                                                                                                                                                                                   | The old cell said no field sets the default; `systemAgent` does (research §1).                               |
| F-040 | Clawtrate target   | better: an editable "Instructions" page in the Bot's settings with its AGENTS.md (instructions) and SOUL.md (personality), each saved with the hash it was read with and read back, and a change on the gateway during editing shown beside the person's kept text; separate from memory, which is MEMORY.md, USER.md and notes (FC-04).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Names the two files and the conflict, so the check knows what to assert.                                     |
| F-050 | gateway dependency | partial: `agents.delete {agentId, deleteFiles}` (`operator.admin`) removes the config entry, bindings, cron jobs and exec-approval entries, and drops the Bot's tasks from every list even with `deleteFiles:false`; with `deleteFiles` it moves the workspace (memory included), agent directory and transcripts to the gateway user's Trash, keeping paths a surviving Bot owns. `deleteFiles` defaults to `true`, so send it always. An `ok` reply can carry `failed[]`; calling again resumes the journaled delete. It refuses, changing nothing, for the Bot holding the shared or inherited sign-ins and for the only Bot. A preview reads `agents.list`, `sessions.list {agentId}`, `cron.list {agentId, includeDisabled:true}`, `agents.files.list`, `agents.workspace.list` and `config.get` (`operator.read`); no atomic preview exists. Live in `docs/research/bots-lifecycle.md` §9. | The default, the resume and the refusals were verified live.                                                 |
| F-270 | gateway dependency | available: `agents.update` `avatar` as a `data:` URL (`operator.admin`). The gateway answers `ok` even for a value over 2 MiB or not an image, and `agents.list` then returns no `avatarUrl`, so the picture counts as saved only when the list returns it; Clawtrate's own state keeps at most 32,768 characters, so the crop is sent small.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The old cell said the map gives no limit for `data:` URLs; the limit and the silent drop were verified live. |
| F-276 | Clawtrate target   | better: fixture where no other Bot uses the workspace folder: with "Also move &lt;Bot&gt;'s folders to the Trash on the gateway's machine" ticked the workspace folder is gone from its place afterwards (in the Trash); unticked it remains (FC-14).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The option's words are this design's; the folder still has to be gone or remain.                             |

Met as written by this design: F-005 (a gateway always lists a bot, so none is created; fact 3), F-007, F-026, F-037 (with nothing preselected in the Bot tab), F-038, F-039, F-048, F-050, F-052 (`bots.md` §3), F-259, F-270, F-271, F-276. F-034 to F-036 are `bots.md`'s and unchanged.

**Rows this design differs from, left as they are, for a decision:**

| Row   | The row asks                                                         | This design                                                                                                                                                                      | Why                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-041 | An event line with a diff and Accept / Undo                          | The same, but only when Clawtrate holds an earlier copy of the file; otherwise the line says it can't compare, with no Undo; and a change not made by a file tool has no line    | The gateway sends no event and keeps no earlier version (facts 9 and 11). A plugin that records bootstrap-file writes would close it.                                        |
| F-049 | Export and import a Bot definition file                              | The gateway's own package commands, shown for the owner; no export for a Bot made with `agents.create`, which is every Bot Clawtrate makes                                       | The only format the gateway knows is its package, on its command line, and it cannot hold such Bots (fact 14). A file of Clawtrate's own would be one no gateway reads.      |
| F-265 | Importing shows the review dialog in the app, with "Add Bot"         | The review is the gateway's dry-run plan, on its command line; the Bot appears in the app when listed                                                                            | Clawtrate cannot read or add a package (fact 14).                                                                                                                            |
| F-269 | With an image tool, Generate takes a description and sets the avatar | With no tool, as the row says; with the tool offered, the tab says Clawtrate can't make a picture with it yet                                                                    | What `tools.invoke` returns for `image_generate` was not established; no image provider can run on a development gateway (fact 8).                                           |
| F-464 | The workspace option is disabled with "Also used by &lt;Bot&gt;"     | One option covers the three folders, because the gateway has one switch; under it the workspace line says "stays: also used by &lt;Bot&gt;", and the folder is intact afterwards | `deleteFiles` cannot remove the agent folder without the workspace, or the reverse (fact 15). The row's check, the folder intact and readable by the other Bot, still holds. |

## 14. For builders

### What each part uses

| Part                      | Existing                                                             | New here               |
| ------------------------- | -------------------------------------------------------------------- | ---------------------- |
| The star                  | The rail row and the pinned tile (`visual-language.md` §6), `Avatar` | `.lc-star`             |
| The primary bot's dialogs | Dialog, choice list, access bar (interactive tier), note             | Nothing                |
| The picture editor        | Dialog, tabs, picture picker, result, note                           | `.lc-drop`, `.lc-crop` |
| Name and label in place   | `WorkPanel`'s hero, the rail row                                     | `.lc-inline`           |
| Instructions              | The Settings tab's frame, sub-page head, `.input`, note              | Nothing                |
| The event line            | `.event-details`, card                                               | `.lc-diff`             |
| Duplicate                 | Dialog, `.b-check`, choice list, note                                | `.lc-steps`            |
| Export, import            | Dialog, the command line and copy, `.b-steps`, result                | Nothing                |
| Delete                    | Dialog (alertdialog), `.b-check`, note, the danger button            | `.lc-result`           |

### What the engine supplies

| Need                                    | From                                                                                                                                         | Notes                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The primary bot                         | `users.prefs` key `clawtrate.primary`, beside `clawtrate.sidebar`                                                                            | Absent, `{bot: null}` or `{bot: <id>}`; compare-and-set with `expectedEntries`; device storage on `no_durable_identity` |
| Each bot's picture, name, label, origin | `agents.list`: `identity.avatarUrl`, `name`, `identity.theme`, `createdVia`, `workspace`                                                     | Re-read on `config.changed`                                                                                             |
| The image tool                          | `tools.effective {agentId, sessionKey}` for the bot's latest task                                                                            | `groups` for offered tools, `toolAccess.tools` for the reason                                                           |
| Instructions and the copies for diffs   | `agents.files.get` for AGENTS.md and SOUL.md, kept with hash and time per bot                                                                | Read when settings or Instructions open and after each change line                                                      |
| The change line                         | The run's `agent` tool events with `tool-events`                                                                                             | `write`, `edit` or `apply_patch`, result without `isError`, path the bot's AGENTS.md or SOUL.md in its workspace        |
| What a delete or a copy lists           | `sessions.list {agentId}`, `cron.list {agentId, includeDisabled}`, `agents.files.list`, `agents.workspace.list`, `config.get`, `agents.list` | Read when the dialog opens; never cached                                                                                |
| The delete's outcome                    | `agents.delete` `removed`, `failed`, `purgeFailed`, then the same reads                                                                      | `deleteFiles` always explicit                                                                                           |

### Order

1. The primary bot as a preference: the star from the key or `defaultId`, the choose dialog, "This device only".
2. Name and label in place, with the read-back; the rail's rename.
3. Instructions: read, save with the hash, the conflict.
4. The picture editor's Bot and Upload tabs with the read-back; Generate's states from `tools.effective`.
5. Delete: the reads, the confirmation, the result rows, Try again.
6. Duplicate: the steps and the partial result.
7. Export and import: the commands, by `createdVia`.
8. The change line, once the copies of the two files are kept.
9. The introduction, last: it needs the first five.

### Prototype states

`lifecycle.html` takes every parameter `bots.html` takes, and these. `tab=settings&panel=open` opens the Settings tab; `bot=<id>` picks the bot (Juniper is `juniper` in the prototype).

| Parameter                                           | Values and what they show                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lc`                                                | `intro`, `choose`, `picture`, `duplicate`, `export`, `import`, `delete`: a dialog to open                                                                                                        |
| `primary`, `prefs`, `primfail`, `primconflict`      | `primary=<id>`: the stored primary bot (`primary=gone`: one no longer listed); `prefs=device`: kept on the device; `primfail=1`: saving fails once; `primconflict=1`: another device chose first |
| `ptab`, `imagetool`, `upload`, `picfail`            | The picture editor's tab; `imagetool=1` or `unknown`; `upload=crop`, `toolarge`, `notimage`; `picfail=1` or `dropped`                                                                            |
| `edit`, `namefail`                                  | `edit=name` or `label`: the hero's field open; `namefail=1`: the rename refused once                                                                                                             |
| `bview=instructions`, `instr`, `instrfail`          | The Instructions page; `instr=conflict`; `instrfail=1`: the save fails once                                                                                                                      |
| `rolechange`, `rolediff`, `undo`                    | `rolechange=1&bot=juniper&task=j1`: the change line; `rolediff=nocopy`; `undo=conflict`                                                                                                          |
| `delbot`, `shared`, `files`, `delread`, `delresult` | The bot for Delete, Duplicate or Export; `shared=1`: Pip's folder is Juniper's; `files=1`: the box ticked; `delread=loading` or `failed`; `delresult=partial`, `refused`, `uncertain`            |
| `dupacct`, `dup`                                    | `dupacct=own`: the bot's account is its own; `dup=partial` or `refused`                                                                                                                          |
| `onlybot`                                           | `1`: the gateway has one bot                                                                                                                                                                     |

`delbot=marlow` shows Export for a package bot, `pip` for a bot made by the create method, `otto` for one with no record. The gallery's "Bot lifecycle" section links to each state. The check, `prototype/tools/checks/lifecycle.mjs`, walks each dialog to each of its outcomes and asserts their words.

## 15. Not covered here

- Generating a picture with the gateway's image tool, until a probe with a real image provider shows what `tools.invoke` returns for it (F-269).
- Exporting a bot Clawtrate made, and reviewing a package in the app (F-049, F-265): the gateway has no way to do either. A Clawtrate plugin could add methods for them; this design does not invent one.
- A record of changes to a bot's bootstrap files made outside a run's file tools, which F-041 would need to be complete; that would be a gateway plugin.
- Copying a bot's routines, memory or tasks into a duplicate.
- The description row that `bots.md` §8 placed in About: the gateway's bot has no description field (`AgentSummary`), so this design drops the row rather than invent one.
- Moving a bot's sign-ins out of its folder so that it can be deleted; that is the gateway owner's work on its machine.
- The account row, Model and Effort, Usage, and where a bot runs, which `bots.md` and `controls.md` design and others are building now.
- Group chats (#83).
