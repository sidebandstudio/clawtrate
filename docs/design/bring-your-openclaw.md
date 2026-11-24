# Bringing your OpenClaw into Clawtrate

Issue #487. Someone who arrives with a working OpenClaw keeps what makes it theirs: what their bot knows about them, its skills and its scheduled jobs. They don't re-teach it, and they don't get its clutter: no conversations, no chat-app traffic, no other tools' sessions. The gateway they already have is the default path; a new gateway is only for someone who has none. Every import is offered, shown in plain words before anything is saved, and can be undone.

The evidence is [`docs/research/bring-your-openclaw.md`](../research/bring-your-openclaw.md), cited as B1 to B24, from OpenClaw 2026.10.6's source and a development gateway.

## 1. What a person sees

On a gateway that already has bots, Clawtrate's first run goes like this. Juniper is the bot they have used for months; Maple is the Main Bot the first run makes.

1. **Connect, choose how bots run commands, and meet the Main Bot.** This is the Main Bot design's first run (`main-bot-onboarding.md` §3, revised for #434): Clawtrate makes Maple, its chat opens, and the person gives it a name, a picture and a role. The gateway's own bot and other tools' sessions are already out of view (#490, #491).
2. **The offer.** After Maple's first reply under its new name, one card in its chat: "Start Maple from what Juniper knows", with **Choose what to bring** and **Not now**. It is offered once per gateway.
3. **Bring what you have.** **Choose what to bring** opens one sheet. At the top, Juniper chosen and three ticked lines, each with a plain summary and its size:
   - "**Memory**: 23 things Juniper keeps in mind, like 'Backups go to the blue drive.' 3.1 KB"
   - "**About you**: how you like to be helped, like 'Call me Sam.' 1.2 KB"
   - "**Skills**: Disk check, Weekly plan"

   Under them, in one line: "Not brought: Juniper's conversations, its chat apps, its instructions and personality. Juniper keeps running, out of view." A line Clawtrate left out because it looks like a password says so: "1 line left out: it looks like a password or key."

   Below, **Scheduled jobs**: each of Juniper's jobs in plain words, with a switch "Run with Maple", off.

   ```
   Morning digest                                                  [ off ]
   Summarises yesterday's notes and lists what needs an answer today.
   Weekdays at 8:00 AM, Lisbon · next tomorrow 8:00 AM · last ran today, worked
   Runs as Juniper · results go to your chat app
   ```

   "Run all with Maple" turns every switch on. **Bring in** and **Cancel**, which brings nothing.

4. **It comes in.** Clawtrate writes what was ticked into Maple, moves each job switched on, and reads each back. The card in the chat becomes the result: "Maple now has Juniper's memory, what Juniper knew about you and 2 skills. 2 jobs run with Maple." Maple uses them from its next reply.
5. **What another assistant knows.** Under that result (or on its own, after Maple's first reply, on a gateway with no other bot): "Bring what another assistant knows about you". It opens a sheet with a prompt to copy into that assistant and a box to paste its answer. Maple's chat then shows a card, "What Maple would remember", one line per fact, each removable, and **Save**.

Everything brought in is listed afterwards in **Settings → Bring in**, each with its switch or **Remove**. A brought-in job lives in Routines under Maple, marked "Brought from Juniper", with its switch on its page.

## 2. Every import at a glance

| Import                                 | Brings                                                                                                        | Leaves                                                                                                   | Shown before saving                                                                                        | Reversed by                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A bot's memory                         | Its `MEMORY.md`, as one marked section in the Main Bot's `MEMORY.md`                                          | Lines that look like secrets; its dated notes unless the helper plugin is there (section 3)              | Count, size, the first lines, the full text on request, every left-out line masked                         | **Remove** deletes that marked section, after showing it if it changed (section 3)                                               |
| The person's profile                   | Its `USER.md`, as one marked section in the Main Bot's `USER.md`                                              | The same                                                                                                 | The same, with how much of the 4,000 characters a bot reads at the start of a task it uses                 | The same                                                                                                                         |
| Skills                                 | Each ticked skill folder, into the Main Bot's own skills (with the plugin) or the person's skill library      | Skills built into OpenClaw or shared by every bot already                                                | Name and the skill's own one-line description; its files on request                                        | **Remove**: the copied folder (plugin) or the library entry, when unchanged                                                      |
| A scheduled job                        | The job itself: it runs as the Main Bot from then on                                                          | Jobs tied to one of the old bot's conversations, and check-ins (section 5)                               | What it does, when it runs next and how often, which bot runs it, whether it last worked, where results go | **Switch off**: the job is back on the bot it came from, with its definition exactly as it was and its whole history (section 5) |
| What another assistant knows about you | The facts in its answer that the person keeps, as marked sections in the Main Bot's `USER.md` and `MEMORY.md` | Anything that isn't a plain fact line, anything that reads like an instruction to a bot, anything secret | Every fact, grouped, each removable, with where it will be saved                                           | **Remove** deletes that marked section, as for a bot's memory                                                                    |

Nothing is ever taken from the bot it came from. Juniper's files and settings are only read.

## 3. Starting from what a bot knows

### Which bot, and what is asked

The Main Bot design places the offer (`main-bot-onboarding.md` §3, "Starting from what an existing bot knows"): one card, after identity is complete, once per gateway. This design decides when it has something to offer and what the sheet holds. The card appears when the gateway has a bot other than the Main Bot whose `MEMORY.md` or `USER.md` holds more than its template, or that has a workspace skill or a scheduled job. Afterwards the same sheet is in the Main Bot's Memory tab and in Settings → Bring in, for any bot. The select lists those bots by name, newest activity first; the gateway's own bot is listed even while it is out of the sidebar (#490), as "the gateway's own bot". It starts on the gateway's own bot when that bot has anything to bring, since that is where a gateway's history usually is, and otherwise on the bot with the largest memory.

Each line reads only what the gateway returns at `operator.read` (B4-B7):

| Line        | Read with                                                                                   | Summary                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory      | `agents.files.get MEMORY.md`                                                                | The number of list items or paragraphs, the first one quoted, the size. "Show all" opens the text, read-only, with left-out lines masked                                                    |
| About you   | `agents.files.get USER.md`                                                                  | The same. Over 4,000 characters: "Bots read the first 4,000 characters of this at the start of a task." (B2)                                                                                |
| Skills      | `skills.status {agentId}`, only `openclaw-workspace` skills; `agents.workspace.*` for files | One line per skill, its name and description, each with its own tick. A skill with a file the gateway won't return as text or image (B5) says "Can't be copied: it has a program file."     |
| Daily notes | `agents.workspace.list {path: "memory"}`                                                    | Only with the helper plugin (below): "38 daily notes, Mar to Nov". Unticked: they aren't loaded at the start of a task, only found by search, and a search index catches up later (B2, B11) |

A template the gateway wrote and nobody changed counts as empty and isn't offered.

### What is copied, and what is left

Copied, each only when ticked: `MEMORY.md`, `USER.md`, the ticked workspace skills, and the daily notes. Deliberately left: the bot's tasks and their history, its chat-app links, its `AGENTS.md`, `SOUL.md` and `IDENTITY.md` (the Main Bot gets its own name and role in the Main Bot design's first run), its scheduled jobs (offered on their own, section 5), its approvals, its accounts and sign-ins, its learned skills (B3), and every other file in its folder.

### Secrets

Before anything is shown, core marks each line of each text it would copy. A line is **left out** when it holds a private key block, a known credential prefix from a list kept in core, a URL with a user name and password, a value after a word such as password, passcode, token, secret, API key or PIN, or a run of 24 or more letters and digits mixing both. A left-out line is shown masked ("Home network token: tok\_••••") with "Left out: it looks like a password or key." It can't be ticked back in: "If Maple needs it, tell Maple yourself." The rule errs toward leaving out; a false catch costs one line the person can type.

### What the Main Bot is told

Each copy is written as one marked section at the end of the Main Bot's file, never replacing what is there:

```markdown
<!-- clawtrate:brought-in id="bi_7f2c" from="juniper" at="2026-11-24" -->

## Brought from Juniper on 24 November 2026

Juniper is another bot on this gateway. It keeps running on its own, and what you learn from now on isn't shared with it.

- Backups go to the blue drive.
- …

<!-- /clawtrate:brought-in id="bi_7f2c" -->
```

The markers let Clawtrate find the section again to remove it or to add what Juniper learned later. The heading tells Maple, in words, where it came from.

### The writes

**Bring in** runs these, in order:

1. Each source file is read again. If it changed since the sheet was drawn, the sheet shows the new summary and waits for **Bring in** again.
2. `agents.files.set` (admin) writes the Main Bot's `MEMORY.md` with `expectedMissing` when it has none, and `USER.md` with `expectedHash` of the file just read, the section appended (B8). The Main Bot's own first run is already over by then (the Main Bot design writes its identity file when it makes it), so this changes only what it knows. OpenClaw loads both files in every new task and picks up their changes on later turns of an open one (B2).
3. Skills and notes go through the helper (below), or skills to the library.
4. Jobs switched on move (section 5).
5. Each write is read back. The step's rows say "Written", "Couldn't check" (with **Check again**, which only reads) or "Changed on the gateway" (nothing overwritten), as `bots-lifecycle` Duplicate's rows do (#147 §8).

### Skills: the Main Bot's own folder, or the person's library

The gateway has no method that writes a bot's skills folder (B9, B13). Two routes:

- **With Clawtrate's helper plugin** (the `clawtrate-bots` plugin gains one admin method, `.skills.copy {from, to, skill}`, by bot and skill name only): it copies that one folder from one bot's `skills/` to the other's through OpenClaw's guarded file access, refuses links and anything outside the folder, creates each file exclusively, and returns each file's hash. The skill then belongs to the Main Bot alone. **Remove** deletes the folder when every hash still matches, and otherwise shows what changed.
- **Without it**, `skills.library.save` (`operator.write`) puts the skill in the person's skill library (B12). The line under Skills then says: "These go to your skill library, so every bot's new tasks can use them." **Remove** is `skills.library.mutate {action: "remove"}` with the revision saved. A slug already in the library isn't replaced (B12): that skill says "Already in your library".

Daily notes need the memory plugin's `clawtrate-memory.write` (B10), into `memory/brought-in/<bot>/`. Without it the line reads "Daily notes stay with Juniper. They come with Clawtrate's memory helper." and nothing else waits on it.

### Removing it

The Main Bot's Memory tab, and Settings → Bring in, list each brought-in section: "From Juniper, 24 Nov: memory and about you". **Remove** reads the file, finds the section by its markers and compares it with what was written (its hash is in the records, section 8):

- **Unchanged**: the section is removed with `agents.files.set {expectedHash}` of that read, and read back.
- **Changed** since (by the person, or by Maple editing its memory): the section is shown as it is now beside what was written, with **Remove it as it is now** and **Keep**. Nothing else in the file is touched.

## 4. Drift, and why jobs close it

The copy is made once. From then on Maple learns what the person teaches it in Clawtrate, and Juniper doesn't. Juniper keeps answering the chat apps and other tools that reach it, and learns from those, and Maple doesn't. Clawtrate doesn't sync the two: syncing would carry chat-app and other tools' traffic back into Maple, which is exactly the clutter the person left behind.

What the design does instead:

- **It says so**, once on the step ("Juniper keeps running, out of view") and once to Maple, in the section's heading.
- **It moves the work, not only the knowledge.** What the person relies on Juniper for, apart from chatting, is its scheduled jobs. Brought in, each job runs as Maple: under Maple's instructions and profile, with Maple's memory to search, and its results and anything the person corrects about them land where they now teach. A scheduled run starts without `MEMORY.md`, as every scheduled run does on OpenClaw (B2), and finds memory by searching. Once the jobs have moved, Juniper is left with only what reaches it from outside Clawtrate, which is the part the person didn't come to Clawtrate for.
- **It offers what Juniper learned later, never by itself.** When Juniper's `MEMORY.md` or `USER.md` hash differs from the one copied, Maple's Memory tab shows one line: "Juniper has learned things since 24 Nov." It opens the same review with only the lines that weren't there at the copy, and saves them as a new marked section. Never the other way round.

## 5. Scheduled jobs

### The list

The sheet lists the jobs that run as the chosen bot (`cron.list {includeDisabled: true}`, `effectiveAgentId`, B18). Each row, from what `cron.list` returns:

| Part                   | Words                                                                                                                                                                                                                                                     | From                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Name                   | The job's name                                                                                                                                                                                                                                            | `name`                                       |
| What it does           | Its description, or the first sentence of its instruction, up to 120 characters, as plain text. A command or script says "Runs a command" with the command in mono                                                                                        | `description`, `payload`                     |
| When                   | `automation.md` §5's schedule in words with its time zone, "next tomorrow 8:00 AM", or "Paused"                                                                                                                                                           | `schedule`, `state.nextRunAtMs`, `enabled`   |
| Whether it last worked | "last ran today, worked", "last ran Tue, didn't work: <the gateway's reason, shortened>", "hasn't run yet"                                                                                                                                                | `state.lastRunAtMs`, `lastRunStatus`         |
| Which bot, and results | "Runs as Juniper", and where its results go in plain words from the gateway's own preview: "results go to your chat app", "results go to a web address", "results stay with the job"; "results don't arrive: <reason>" when the preview says it will fail | `effectiveAgentId`, `deliveryPreviews` (B23) |
| Switch                 | "Run with Maple", off                                                                                                                                                                                                                                     | (below)                                      |

**Shown but not offered**, each with its reason and no switch: a job tied to one of Juniper's conversations ("Stays with Juniper: it writes into one of Juniper's conversations."), a job that posts into the gateway's own bot's main conversation ("Stays with the gateway's own bot: it posts into its main conversation."), both because the gateway refuses to move them without changing what they do (B22). The gateway's check-ins aren't jobs here (`automation.md` §3) and aren't listed.

Every job on the gateway can be brought in later from its own page in Routines ("Run with Maple"), whichever bot runs it.

### What "bring in" does

In the sheet, the switches are choices that **Bring in** carries out; on a routine's page and in Settings → Bring in, a switch acts at once. Turning one on reads the job and sends one `cron.update {id, patch: {agentId: <Main Bot>}, expectedConfigRevision}` (admin), and reads it back (B19). The job keeps its id, name, schedule, instruction, paused state, next run and history.

One case changes a second field. When the job's results go to "the chat app its bot was last used from" (`delivery.channel: "last"`, or an announce with no chat named), they would stop arriving once Maple runs it, because Maple has no chat app (B23). For such a job the row says, before the switch is touched: "Its results will stay in Clawtrate. Today they go to the chat app Juniper was last used from." and the same write sets `delivery: {mode: "none"}`. A job that names its chat app keeps sending there.

Clawtrate records, per job, where it came from (its `agentId`, or none), its delivery if it was changed, the revision just before and the revision the write returned (section 8).

### What "reverse" means, exactly

Turning the switch off sends one `cron.update {id, patch: {agentId: <where it came from>}, expectedConfigRevision}` with the revision read just then, plus the original `delivery` when bringing it in changed it. A job that had no `agentId` gets `agentId: null`. Then:

- **The job is back on the bot it came from, with its schedule and its settings as they were.** On the development gateway, writing the original back returned the job's original `configRevision`, the hash of its whole definition (B20). Clawtrate checks that: when the read-back revision equals the one recorded before bringing it in, the switch says "Back with Juniper, exactly as it was."
- **Its history is whole.** History belongs to the job, not to a bot (B21). Runs Maple made while it had the job stay in its history and say "Run by Maple"; their transcripts stay readable.
- **If it ran in between**, those runs are in its history, and its "last ran" is the latest of them. Nothing is lost and nothing is rewound.
- **If the person changed it while Maple had it** (its schedule, say), the revision differs from the one recorded. The switch moves only the bot back and keeps the change: "Back with Juniper. Your change to its schedule stays." If they also changed where its results go, the original delivery isn't written back.
- **If Juniper is gone**, the gateway refuses (B19): "Juniper isn't on this gateway any more, so this job stays with Maple."
- **While it is running**, the switch waits: "Running now. You can move it when it finishes." A move during a run wasn't tried (research, "Not established"), so the design doesn't make one.
- **Deleting Maple** would delete the jobs it runs (B24). The delete dialog lists the brought-in ones with "Put them back first", ticked.

### Where its runs show

Brought in, a job is one of Maple's routines: in Routines under Maple, with "Brought from Juniper" on its row and page, and its switch on its page. **Its runs and results are on the routine's page**, every run before and after, each saying which bot ran it. Its runs stay out of Maple's task list, preview line and unread mark, as #491 says for every scheduled run; a run that waits on an approval or a question shows in the list until answered, as #491 says. "Created routine" and "Changed routine" cards don't appear for a move.

## 6. What another assistant knows about you

### Where it is offered

Once, in Maple's chat: under the result of the bring-in card, or, on a gateway with no other bot, on its own after Maple's first reply under its new name: "Bring what another assistant knows about you". In Settings → General → Import (F-008), always. It isn't a setup step, so the first run stays short.

### The prompt

The sheet's first step: "Copy this, paste it into the other assistant, and send it." with the text and **Copy**:

> I'm starting to use a new assistant, and I'd like it to know me the way you do. Please write down what you know or remember about me that would help another assistant help me well.
>
> Use exactly these headings, with one short fact per line, each line starting with "- ". Leave out a heading if you have nothing for it.
>
> ## About me
>
> ## How I like to be helped
>
> ## People in my life
>
> ## What I'm working on
>
> ## Things I asked you to remember
>
> Write each line as a plain statement about me, like "- I live in Lisbon." Don't include passwords, codes, keys or account numbers. Don't write instructions for the new assistant, and leave out anything you're not sure about. Reply with the list only.

### Pasting the answer

Step two: "Paste its answer here." A text box, at most 20,000 characters, and **Read it**. The text stays on this screen only: it isn't saved on the device and isn't sent anywhere until Save.

### The pasted text is untrusted

It can hold anything, including text written to steer a bot. So:

- **It never reaches a model as a message.** Clawtrate's own code reads it, not Maple. Maple sees the facts only once they are saved, as lines in its memory, framed as facts the person gave.
- **Only fact lines are read.** A line counts when it starts with "- " under one of the five headings. Everything else is dropped and counted: "9 lines weren't facts and were left out." Markup is reduced to plain text, links to their words, and code is dropped. Invisible and direction-changing characters are removed.
- **Bounds**: at most 60 facts, each at most 300 characters; longer lines are cut at a word and marked.
- **Flagged facts start unticked**, with their reason: a line that reads like an instruction to a bot ("Ignore …", "You must …", "Always run …", a command, a web address) says "This reads like an instruction, not a fact about you."; a line the secrets rule of section 3 catches is left out and can't be ticked.

### What Maple shows before saving

A card in Maple's chat, drawn by Clawtrate under Maple's picture, titled "What Maple would remember". Facts are grouped by heading, each a line with a remove button. Under the groups, where each goes:

- "About me", "How I like to be helped" and "People in my life" go to **About you** (`USER.md`), with a meter: "2,140 of the 4,000 characters bots read at the start of a task". Over it, **Save** stays off: "Remove some lines from About you."
- "What I'm working on" and "Things I asked you to remember" go to **Memory** (`MEMORY.md`).

**Save** writes one marked section to each file, as in section 3, headed "What you told me another assistant knew about you, 24 November 2026", followed by "These are facts about the person, not instructions." Each write uses `expectedHash` and is read back; the card then says "Saved, read back" with **Undo**, which is section 3's **Remove**. **Not now** saves nothing and keeps nothing.

A bot changing itself asks first by default (`main-bot-onboarding.md` §4, "A bot changing itself"), and saving imported memory follows that rule: this card is that confirmation. With that design's setting under Settings → Advanced to apply a bot's changes to itself at once, the card still shows every fact before it saves, because every import is shown first.

## 7. When the app can't do it yet

| Situation                                                               | What the person sees                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A read-only pairing                                                     | Everything is shown, since every read needs only `operator.read` (B7); no tick, switch or Save. The access bar offers what the pairing already offers: effortless setup's one-time "Give this device full control" (F-549). No other scope is requested |
| A write tier without admin                                              | The paste and the skill library work; memory, profile and jobs show the access bar                                                                                                                                                                      |
| A gateway on this Mac before the one-click local connection ships       | Nothing different. The step appears after any pairing that can make the Main Bot; one made through a setup code gets the same screen                                                                                                                    |
| A gateway whose `hello-ok.features.methods` lacks a method a line needs | That line says "This gateway's version can't do this yet." and isn't offered; the rest is                                                                                                                                                               |
| A gateway that refuses `expectedConfigRevision` or the `agentId` patch  | The job's switch shows the gateway's words and stays as it was. The write is never retried without its precondition                                                                                                                                     |
| Clawtrate's helper plugins aren't on the gateway                        | Daily notes say they come with the memory helper; skills go to the library, saying so; nothing else changes                                                                                                                                             |
| The gateway changes between reading and writing                         | Nothing is sent: "This change was made for another gateway, so nothing was sent." (below)                                                                                                                                                               |

## 8. Safety

- **Nothing leaves the gateway.** Every read and write is a gateway method on the person's own connection. Text passes through the app only to be shown and written back to the same gateway; it isn't stored on the device or sent to any other service.
- **Nothing crosses gateways unless the person chooses it.** The source and the Main Bot are on one gateway. Every write from these screens carries the stamp of where the screen read its values (`gatewayStamp`) and goes through `requireSameGateway`, so a switch to another gateway in between sends nothing. The pasted answer is written only to the gateway whose Main Bot showed the card.
- **Every write is conditional and read back**: files with `expectedHash` or `expectedMissing` (B8), jobs with `expectedConfigRevision` (B19). A refusal changes nothing and shows what changed.
- **The source is only read.** Nothing writes to Juniper.
- **Secrets aren't copied** (section 3), and pasted text never reaches a model as a message (section 6).
- **Records.** What was brought in is kept in one `users.prefs` key, `clawtrate.broughtIn.v1` (write tier; the gateway holds it, so every device of that person sees it), bound to the gateway's identity and the Main Bot's incarnation: each section's id, file, source bot, the source file's hash at the copy and the hash written; each skill's route and its revision or file hashes; each job's record (section 5). Settings → Bring in reads it. A record whose Main Bot isn't the one listed now is shown as history only, with nothing to switch.

## 9. What this relies on: #434, #490 and #491

The Main Bot design, revised for #434, makes the Main Bot and places this design's offer in its first run, once identity is complete; this design writes only into that bot, and only what the person chose. Moving a job of the gateway's own bot is a change to that job, chosen job by job, never to the bot itself, so it keeps that design's rule that the first run never writes the gateway's own bot. It relies on two neighbours being built on another thread. **#490** keeps the gateway's own bot out of the sidebar behind "Show the gateway's own bot"; that is why this screen names it "the gateway's own bot", lists it as a source even while hidden, and why moving its jobs to Maple leaves nothing the person needs to open it for. **#491** keeps other tools' sessions and scheduled runs out of a bot's task list behind a paired switch; that is why a brought-in job's runs live on its routine's page and not in Maple's tasks, and why a job's runs that need the person still surface. If either isn't built, this design still works; the person just sees the clutter those two remove.

## 10. The iPhone app

`apps/mobile` isn't on `main` and has its own coordinator. What it shows: the first-run step in one column, its rows at 44 pt, the full texts on their own screen; brought-in jobs in Routines with their switch; the paste flow, which suits the phone, where the other assistant often is: Copy, switch apps, paste, and the same card. Settings → Bring in is the same list. Core's parsing, secrets rule, records and writes are shared, so both apps say and do the same.

## 11. Checklist rows

Reworded in `docs/parity.md` by this design's pull request, its status unchanged, because its old target (review in the memory viewer, written through the memory plugin) is no longer what happens:

| id    | area       | platform | behavior                                                                                                                               | target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | gateway dependency                                                                                                                                                                                            | status |
| ----- | ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-008 | Onboarding | both     | Settings, General, Import: copy a prompt, paste another assistant's answer, and the items found are added to the primary Bot's memory. | better: as `docs/design/bring-your-openclaw.md` §6: the prompt names no product; Clawtrate's own code reads the pasted answer, which is never sent to a model as a message; only fact lines under the prompt's headings count, a line that reads like an instruction starts unticked, and a line that looks like a password or key is left out; the Main Bot's card shows every fact, each removable, and Save writes one marked section each to its `USER.md` and `MEMORY.md`, read back, with Undo. | available: `agents.files.get` (`operator.read`) and `agents.files.set` with `expectedHash` or `expectedMissing` (`operator.admin`) on `USER.md` and `MEMORY.md` (`docs/research/bring-your-openclaw.md`, B8). | todo   |

New rows. Ten, F-577 to F-586:

| id    | area       | platform | behavior                                                                                                                          | target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | gateway dependency                                                                                                                                                                                                  | status |
| ----- | ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-577 | Onboarding | both     | On a gateway that already has bots, the first run offers to start the Main Bot from what one of them knows.                       | better: as `bring-your-openclaw.md` §3: the step names the bot, and memory, the person's profile and skills each with a plain summary and size; offered once per gateway, after the Main Bot's identity is saved, and later from its Memory tab and Settings → Bring in; what is ticked is written into the Main Bot as marked sections, each read back; conversations, chat apps, instructions and personality are listed as not brought; Cancel and Not now write nothing.                                                                                                                                        | available: `agents.files.get`, `agents.workspace.*`, `skills.status` (`operator.read`); `agents.files.set` with `expectedMissing` or `expectedHash` (`operator.admin`) (B4-B8).                                     | todo   |
| F-578 | Onboarding | both     | Nothing that looks like a password or key is brought in.                                                                          | same; note: core's rule of §3 marks the lines; each left-out line is shown masked with its reason and can't be ticked back in; checked on memory, profile and a pasted answer.                                                                                                                                                                                                                                                                                                                                                                                                                                      | client only.                                                                                                                                                                                                        | todo   |
| F-579 | Memory     | both     | What was brought into the Main Bot's memory or profile can be removed.                                                            | better: Remove deletes only that marked section, with `expectedHash` of the read, and reads back; a section changed since it was written is shown beside what was written, and removed only on "Remove it as it is now".                                                                                                                                                                                                                                                                                                                                                                                            | available: `agents.files.get` and `agents.files.set` (`operator.admin`) (B8).                                                                                                                                       | todo   |
| F-580 | Skills     | both     | A skill another bot has can be brought to the Main Bot, and removed again.                                                        | better: with the helper plugin the skill's folder is copied into the Main Bot's own skills and removed when unchanged; without it the skill goes to the person's library, the screen says every bot's new tasks can use it, and Remove takes it out by its revision; a name already in the library isn't replaced.                                                                                                                                                                                                                                                                                                  | plugin: proposed `clawtrate-bots.skills.copy` (`operator.admin`, not built; no gateway method writes a bot's skills folder, B9, B13); without it `skills.library.save` and `.mutate` (`operator.write`, live, B12). | todo   |
| F-581 | Routines   | both     | The scheduled jobs of the bot the Main Bot starts from are listed in plain words, each with a switch to run it with the Main Bot. | better: each row says what the job does, when it runs next and how often, which bot runs it, whether it last worked and where its results go, from the gateway's own preview; a job tied to one of its bot's conversations or to the main conversation is shown with its reason and no switch.                                                                                                                                                                                                                                                                                                                      | available: `cron.list {includeDisabled}` with `effectiveAgentId` and `deliveryPreviews` (`operator.read`) (B18, B22, B23).                                                                                          | todo   |
| F-582 | Routines   | both     | A brought-in job can be put back exactly as it was, and its runs show on its routine's page.                                      | better: on is one `cron.update {agentId}` under the revision read; off writes the original bot (or none) and, when bringing it in changed it, the original delivery, under the revision read then; when nothing else changed the read-back revision equals the original and the switch says so; the job's runs from both bots stay in its history and their transcripts open. Its runs show on the routine's page, each saying which bot ran it, and stay out of the Main Bot's task list, its preview and its unread mark, except a run waiting on the person (#491); the row and page say "Brought from Juniper". | available: `cron.update` with `expectedConfigRevision` (`operator.admin`); `cron.runs`, `cron.history` (`operator.read`) (B19-B21, live); each `cron.runs` entry's `sessionKey` names the bot that ran it.          | todo   |
| F-583 | Routines   | both     | Putting a job back says what happened when it changed, ran or lost its bot in between.                                            | same; note: a job changed while brought in goes back with the change kept and says so; a job whose bot is gone stays and says why; a running job's switch waits for the run to end; deleting the Main Bot offers to put its brought-in jobs back first.                                                                                                                                                                                                                                                                                                                                                             | available: `cron.update` refuses a missing bot (`operator.admin`) (B19); `agents.delete` removes a bot's jobs (B24).                                                                                                | todo   |
| F-584 | Memory     | both     | When the bot the Main Bot started from has learned more, the Main Bot offers only what is new.                                    | same; note: offered when that bot's `MEMORY.md` or `USER.md` hash differs from the one copied; the review shows only lines that weren't there at the copy and saves them as a new marked section; never automatic, never toward the other bot.                                                                                                                                                                                                                                                                                                                                                                      | available: `agents.files.get` (`operator.read`), `agents.files.set` (`operator.admin`) (B4, B8).                                                                                                                    | todo   |
| F-585 | Settings   | both     | Settings lists everything brought in, on every device of the gateway, with its switch or Remove.                                  | same; note: the records are kept by the gateway per person, bound to the gateway and the Main Bot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | available: `users.prefs` (`operator.write` to set, `operator.read` to read).                                                                                                                                        | todo   |
| F-586 | Setup      | both     | Bringing things in never writes more than the connection can, or to another gateway.                                              | same; note: a read-only pairing sees everything and writes nothing, and is offered only the pairing's own full-control offer (F-549); a line whose method the gateway doesn't list says so; a write prepared on one gateway sends nothing after a switch to another (`requireSameGateway`).                                                                                                                                                                                                                                                                                                                         | available: `hello-ok.features.methods`; every read at `operator.read` (B7).                                                                                                                                         | todo   |

## 12. Build order

Each needs only what is named, and merges before the next that needs it.

1. **Jobs, from Routines** (smallest a person notices): every routine's page and every bot's group in Routines that isn't the Main Bot's gets "Run with <Main Bot>", with the records in `users.prefs`, the exact put-back and the delivery case (F-581 to F-583, and F-585 for jobs). Gateway: `cron.*` as is. Plugin: none. Pairing: admin, as today. #434: none; it targets whatever core calls the Main Bot today.
2. **Memory and profile, from the Main Bot's Memory tab**: "Start from what <bot> knows", the secrets rule, marked sections and Remove (F-577's write half, F-578, F-579). Gateway: `agents.files.*`. Plugin: none.
3. **The prompt** in Settings → General → Import, and in the Main Bot's chat where section 6 places it (F-008). Gateway: `agents.files.*`. Plugin: none.
4. **The first run's offer**: the Main Bot design's build step 5 wires its card to this sheet, with jobs from 1, memory and profile from 2 and the paste from 3 under its result; skills join it with 5. Needs the Main Bot design's steps 1 and 2 built, and #490 for naming the gateway's own bot.
5. **Skills**: the library route first, then `clawtrate-bots.skills.copy` with its tests and the plugin's release gate (F-580); daily notes through `clawtrate-memory` once it passes its security review.
6. **What it learned since** (F-584).
7. **The iPhone screens**, with the app's own coordinator.

## 13. Considered and not used

- **Sharing the old bot's workspace** (`agents.create` with its folder, B16): it shares identity, instructions and every later change, so the new bot wouldn't be a new bot.
- **OpenClaw's own memory import** (B17): it reads files other programs keep on the gateway's computer, not another bot.
- **Copying the whole folder**: no method does it (B15), and it would carry instructions, identity and old files the person didn't ask for.
- **Syncing the two bots**: section 4.

## 14. Not covered

- Bringing a bot in from another gateway: that is export and import (#147 §9).
- Moving chat-app links to the Main Bot (#434, #314).
- Bringing in conversations, in any form.
