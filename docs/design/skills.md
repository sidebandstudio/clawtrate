# Skills

How a person keeps skills on their gateway: the library of their skills, a skill's page, the revision each task holds, which skills a bot is given, what a bot learned, saving a process from chat, and sharing a skill with the other people of the same gateway. It is written in the language of `visual-language.md`, `conversation.md` and `bots.md`, with their tokens.

What must be true is in `docs/parity.md`, rows F-198, F-199 and F-361 to F-363. What the gateway does is in `docs/research/skills.md`, from OpenClaw 2026.10.6's source and from runs on a development gateway with this project's own client; every state below names the fact it rests on, and section 14 lists them. Section 15 lists the rows' rewordings, section 16 is for builders.

One rule sits above the rest: **a screen says what the gateway holds, read back, and no more.** A skill is text the gateway keeps and a bot follows; Clawtrate does not judge it. A save says what is on the gateway afterwards, a task says which revision it holds, a bot's page says what that bot is given, and where the gateway does not say (who saw a shared skill, why a save was refused), the screen says it does not know.

The prototype is `prototype/skills.html`: the bots page with what this document adds. Its styles are `prototype/css/skills.css`, its behaviour `prototype/js/skills.js` and `prototype/js/skills-fixtures.js`, and `prototype/tools/checks/skills.mjs` checks it. Section 16 lists its states.

## Contents

1. How the pieces fit
2. Shared rules: components, words, access, content, input
3. Settings, Skills: the library
4. A skill's page
5. Saving, and when someone else saved first
6. A new skill
7. Removing a skill
8. Sharing on this gateway
9. Skills in a task
10. A bot's skills
11. Learned skills and the library
12. Saving a process from chat
13. Phone, themes, read-only, keyboard
14. What the gateway's facts drive
15. Parity rows to reword
16. For builders
17. Not covered here

## 1. How the pieces fit

```
gateway menu, Settings (⌘,)    Settings gains a section, Skills, after Accounts
  Skills                          your skills and the ones shared on this gateway
    a skill's page                 Name, Use when…, Instructions, its files, Save
    New skill                      the same page, empty
Work pane, Details tab           Skills in this task: the revision each holds; Update, Detach, Attach
Work pane, Settings tab          a bot's settings (bots.md §8) gains a row, Skills, in Tools
  <Bot>'s skills                   which skills the bot is given; what it learned
conversation                     the bot's skill_workshop call is an action card, "Saved a skill"
```

Grok Bot keeps skills in one place with a page per skill and a switch on each bot. The gateway splits that into three controls with different owners, and the screens keep them apart instead of merging them into one switch that would be false for two of them:

| What | Who may change it | Where |
|---|---|---|
| The library: a skill's text, whether new tasks start with it, whether it is shared | The person's own connection at the interactive tier (`operator.write`), for their own skills | Settings, Skills |
| A task's skills: which skills it holds, at which revision | The interactive tier | The task's Details tab |
| A bot's list: which skills the bot is given at all | Admin (`config.patch`) | The bot's Settings tab |

## 2. Shared rules

### Components used

| Component | From | Used for |
|---|---|---|
| Settings frame, dialog, confirmation, note, result, switch, choice rows | `bots.md` §2 | The Skills section, Remove, the bot's list |
| Fact block, group word, empty state, tabs | `visual-language.md` §9 | Every page here |
| The access bar and its states | `conversation.md` §3, `bots.md` §2 | Every write below the tier it needs |
| Action card, its readable view and Raw | `conversation.md` §7 to §9 | The `skill_workshop` call |
| `.input`, a `textarea` with the same look | `visual-language.md` §4 | The skill's fields |

### New components

Each is defined once, in `prototype/css/skills.css`, from existing tokens.

| Component | What it is | Tokens |
|---|---|---|
| Skill row (`.k-row`) | A whole-row button in a fact block: the name (15/500, mono for a learned skill's name), the "Use when…" line under it (13, faint, two lines at most), and tags at its end. | `--bg-bubble`, `--border` |
| Tag (`.k-tag`) | A word on a soft fill, radius 999, 12/500: "Off", "Shared", "Team", "Newer revision", "Removed", "Not given". Never colour alone. | `--bg-inset`, `--warn-soft` |
| Revision (`.k-rev`) | The first 12 characters of a revision, mono, 12, with the full id as its accessible name. | `--font-mono` |
| Editor (`.k-editor`) | A plain `textarea` for the instructions, mono 13/20, at least 12 lines, growing to the pane, no markdown preview. | `--font-mono`, `--bg-inset` |
| Side by side (`.k-compare`) | Two columns, "On the gateway now" and "Your edit", each with its own heading; one column below 688 px, the gateway's first. | `--border` |

### Words

- **Skill**: what the gateway's library holds. The page names it by its slug, which is its name everywhere here ("trail-checklist").
- **Revision**: one saved version. The gateway identifies it by a hash of its content; the screen shows the first 12 characters and never calls it a version number.
- **Your skills**, **Shared on this gateway**: the library's own split (`ownerProfileId` and `shared`). "Team" is the gateway's word for a skill no person owns.
- **Given**: what a bot's model receives for a turn. "Has" or "holds": what a task pinned. They differ (section 9), and the screen never says a bot "uses" or "knows" a skill.
- **Learned**: an entry in the bot's change feed, by its actor. Nothing more.
- No word promises more than this: no "safe", "verified", "trusted" or "installed" about a skill.

### Access

| Tier | What the screens offer |
|---|---|
| Read-only (`operator.read`) | Every list, every page, every revision and file name, every bot's list and every learned skill, as text. No field is editable; no Save, Remove, Share, Update, Detach or Attach. The access bar: "**Read-only.** Changing skills needs write access." with "Request access" (the interactive tier). |
| Interactive (`operator.write`, Clawtrate's default) | Everything in the library for the person's own skills, every task action. A bot's list and archiving a learned skill show their value and the access bar: "**Admin access needed.** Changing which skills <Bot> is given changes the gateway's settings." with "Request admin access". |
| Admin | Everything, including a bot's list and archive and restore. Admin access is asked for only from those two places, and only when the person chooses the button. |

Each refusal is the gateway's: `FORBIDDEN` "missing scope: operator.write" or "missing scope: operator.admin" (research §2). The screen does not offer what its tier would make the gateway refuse.

### The skill is content

A skill's name, its "Use when…" text, its instructions, its files' names and contents, the owner's label and a learned skill's change summary come from the gateway, and some of them from a bot. They are shown as text:

- Instructions are shown and edited as plain text in a `textarea`, never rendered as markdown, so an address in them is text, not a link, and nothing in them is fetched (the project's rule for addresses, being decided in `docs/decisions.md`, "Addresses a gateway hands the client").
- A support file is listed by its path and size; its content is never opened, run or previewed by Clawtrate.
- The owner's label is the gateway's: for the gateway's owner it is the gateway computer's account name (research §1). It is shown as given, truncated, never used as a heading.

Every skill's page carries one sentence in plain words, above its instructions: "**A skill is instructions a bot follows.** A bot given this skill can act on what it says, with the tools it is allowed. Read it before your bots are given it." Nothing on any page calls a skill safe or checked.

### Input

- Every page here is reached by a row and left by a quiet round Back that returns focus to that row, as in `bots.md` §8.
- Fields are labelled; errors sit under their field with `aria-describedby`, and the first error takes focus after a refused save.
- ⌘S saves the open skill's page when Save is enabled. Escape leaves a page only when nothing is unsaved; otherwise it asks (section 5).
- One polite live region announces "Saving", "Saved", "Nothing to save", "Someone else saved this skill", "Couldn't save", "Removed", "Shared on this gateway", "No longer shared", "Updated to the latest revisions", "Detached", "Attached", "Archived", "Restored".

## 3. Settings, Skills: the library

**Skills** is a section of the Settings dialog, after Accounts (`bots.md` §7). It lists what `skills.library.list {scope: "all"}` returns.

The section opens with a sentence: "Skills you keep on this gateway. Your bots are given them in new tasks. Every device of yours connected to this gateway sees the same skills." The last sentence rests on research §1: on a gateway without roles, every operator connection is the gateway's owner profile. On a gateway whose answer has `multipleProfiles: true`, it becomes "Skills are yours on this gateway; other people of this gateway have their own." Then "New skill" (default button) at the right, on the interactive tier.

**Groups**, in this order:

| Group | Rows | From |
|---|---|---|
| Your skills | Entries the profile owns | `ownerProfileId === profileId` |
| Shared on this gateway | Others' shared entries and team-owned ones, each with "From <owner's label>" or the "Team" tag | `shared`, or `ownerProfileId: null` |

A row: the name, the "Use when…" line, and its tags: "Off" when `enabled` is false, "Shared" when the person's own skill is shared. A row opens the skill's page.

**Under the groups**, a hint: "New tasks start with every skill that is on, up to 64, your own first. A task keeps the revision it started with; see a task's Details." (research §5, `seed`). With more than 64 on, the gateway's own `defaultSelectionNotice` is shown in a note instead, as text.

**States.**

| State | It shows |
|---|---|
| Loading | Three grey row shapes, pulsing, `aria-busy` |
| Couldn't load | The empty mark with a warning, "Couldn't load your skills", the gateway's message as text, "Try again" |
| Empty | "No skills yet", "A skill is a process you want a bot to follow, written once. Save one here, or ask a bot to save what it just did." and, on the interactive tier, "New skill" (primary) |
| No profile | When `profileId` is null: "This connection has no profile on the gateway, so it has no library. The gateway gives a library to a signed-in person." No New skill. (research §1: with `gateway.roles` set, a device connection gets no profile; source only) |
| Read-only | The rows; no New skill; the access bar at the foot |

The list is read when the section opens, when the dialog regains focus, and after every write of this device. No event announces another device's change (research §4), so nothing claims to be live: the section's foot says "As read at 5:41 PM" with "Read again".

## 4. A skill's page

Opened from a row: Back ("Back to skills") and the skill's name as the title. Read with `skills.library.read {skillId}`.

**Top to bottom:**

1. The content sentence (section 2).
2. **Name**: the slug, as text. It is not editable once the skill exists: the gateway makes the command name a bot sees from the slug (research §3), and a bot's list names that command name (section 10), so a rename would silently drop the skill from every bot list that names it. A hint says so: "A skill's name is set when it is made."
3. **Use when…**: a one-line input, the frontmatter `description`. Required; at most 1,024 characters, with a count from 900.
4. **Instructions**: the editor, the body after the frontmatter.
5. **Files**, when the revision has any: a fact block, one row per file: its path (mono), its size, and "Can run as a program" when `executable` is true. A hint: "Kept with every save. A bot runs a file only with the tools it is allowed. Editing files isn't in this version." (research §3: a save without `retainFiles` drops them, so Save always sends every path.)
6. **Needs**, when the frontmatter names requirements (`metadata.openclaw.requires`): "Programs: curl. Values: WEATHER_API_KEY." from the skill's own text, and "The gateway gives a skill to a bot only when what it needs is there." The page never asks for a value and never shows one (research §9: keys are refused in a skill; an installed skill's key lives in the gateway's configuration, which the gateway stores unencrypted).
7. **Facts**: Owner ("You" when the entry's `ownerProfileId` is the list's `profileId`; otherwise the owner's label, or "Team"), Revision (`.k-rev`), Saved (`updatedAt`), Shared ("Shared on this gateway" or "Only you"), and "New tasks start with it" as a switch (section 4.1).
8. **Actions**, at the foot: Save (primary, enabled only when a field changed and both required fields have text), then a spacer, "Share on this gateway" or "Stop sharing" (section 8), "Remove skill…" (quiet, danger; section 7).

When `canEdit` is false (another person's shared skill, a team skill below admin) every field is text and the foot says "Only the skill's owner or a gateway admin can change it." in the gateway's words.

### 4.1 "New tasks start with it"

A switch (`bots.md` §2) bound to `enabled`: `mutate {action: "enable" | "disable"}`. Its line under it: on, "New tasks start with it."; off, "New tasks don't start with it. A task can still attach it." The switch moves only after the answer, and its new position is the answer's `enabled` (research §4). A task that holds the skill is not changed, and the line says nothing about one.

## 5. Saving, and when someone else saved first

**Save** sends `skills.library.save {skillId, expectedRevision, slug, content, retainFiles}`: the revision the page read, the slug, the whole `SKILL.md` that Clawtrate writes from the fields (`---`, `name: <slug>`, `description: <Use when…>`, `---`, a blank line, the instructions), and every file's path.

| Outcome | What the page shows | From |
|---|---|---|
| Saving | Save reads "Saving…" and is disabled; the fields stay editable but a second Save waits | — |
| Saved | "Saved. New tasks start with revision 12a27e7c037e. Tasks that have this skill keep theirs until they are updated." for 6 seconds, then the facts show the new revision and time | the receipt's `entry` (`state: "published"`) |
| Nothing to save | "Nothing to save: the gateway already has this text." | `state: "unchanged"` |
| Someone else saved first | Section 5.1 | `SKILL_LIBRARY_CONFLICT` with `currentRevision` |
| Removed meanwhile | A danger note: "This skill was removed on the gateway. Your text is still here." with "Save as a new skill" (opens section 6 with the text) | `NOT_FOUND` "Removed skills cannot be edited…" |
| Refused, with a reason | A danger note with the gateway's message as text, "Nothing was saved." | `INVALID_REQUEST` and its message |
| Refused, no reason | "The gateway didn't save this skill and didn't say why. It refuses a skill that contains something that looks like a key or a password; if this one has one, take it out. Nothing was saved." | `UNAVAILABLE`, which is what a literal key produces (research §3) |
| No answer | "Couldn't tell whether it was saved." Clawtrate reads the skill again when it can; if the gateway's text is the page's, it says "Saved."; otherwise the page keeps its text unsaved and says "It wasn't saved." | `read` |

After a save the page reads the skill again and shows what the read returned, not what it sent.

### 5.1 When someone else saved first

Another device of the person's, or another admin, saved the skill after this page read it. The gateway refused this save and named its revision; neither text is lost (research §3).

A warning note: "**Someone else saved this skill** at 5:44 PM, after you opened it. Your edit isn't saved. Compare them, then choose." Under it, side by side: **On the gateway now** (revision, time, "Use when…" and instructions, read-only, from `read`) and **Your edit** (the page's fields, still editable). Below them:

- "Save my edit" (primary): saves the page's text on the gateway's current revision. The note before it says "Theirs stays as an earlier revision on the gateway." which is true: every revision stays readable by id (research §3).
- "Use theirs": a confirmation, "Discard your edit? Your text is deleted from this page. The gateway's version stays.", Cancel and Discard. Only then is the page's text replaced.

If a third save lands while the person compares, Save my edit is refused again, and the comparison updates to the newest; nothing is saved silently.

**Leaving with unsaved text.** Back, Escape or closing Settings with a changed field asks: "Leave without saving? Your edit to trail-checklist is lost.", Stay (default) and Leave. The text is kept while Settings stays open in the same window.

## 6. A new skill

"New skill" opens the same page with empty fields, the title "New skill", and **Name** as an input with its rule under it: "Lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters." The rule is checked as the person types, from the gateway's own pattern `^[a-z0-9][a-z0-9-]{0,62}$`; the field shows what is wrong and Save stays disabled until it fits. Clawtrate also requires instructions (the gateway accepts a skill without any; research §3), so a saved skill always says what to do.

| Outcome | What the page shows |
|---|---|
| Saved | The page becomes the skill's page, with "Saved. New tasks start with it." and the receipt's revision; focus on the title |
| Name taken | Under Name: "You already have a skill called trail-checklist. Choose another name." (`SKILL_LIBRARY_NAME_CONFLICT`) |
| Too long | Under Instructions: "Too long for the gateway: 1,048,576 characters at most, frontmatter included." Checked before sending, and again from the gateway's refusal |
| Other refusals | As in section 5 |

## 7. Removing a skill

"Remove skill…" opens a confirmation:

> **Remove trail-checklist?** It leaves your library and new tasks won't start with it. Tasks that have it keep their revision until it is detached there. You can't undo this; a new skill can take its name.

Cancel (default), Remove (danger). `mutate {action: "remove"}` with the page's revision. Then the section reads the list again and says "Removed. trail-checklist is no longer in your library." only when it is absent. A refusal shows the gateway's message; a conflict (`SKILL_LIBRARY_CONFLICT`) says "Someone else saved this skill since you opened it. Nothing was removed." and shows the page as read again.

The word is Remove, not Delete: the gateway keeps the removed skill's revisions for the tasks that hold them (research §4, §5).

## 8. Sharing on this gateway

On a person's own skill: "Share on this gateway" (`mutate {action: "share"}`), and once shared, "Stop sharing" (`unshare`). Each moves only after the answer, and the facts row then reads the answer's `shared`.

What the page says, by state:

- Not shared: "Only you" in the facts; under the button, "Other people of this gateway can then see it and their new tasks start with it. Nothing leaves the gateway."
- Shared: the "Shared" tag on the row; "Shared on this gateway" in the facts; under the button, "Their tasks that have it keep it when you stop sharing."
- On a gateway with one profile (`multipleProfiles: false`): a hint, "No one else has a profile on this gateway yet, so no one else sees it."

What sharing needs, and its refusals, shown as the gateway's text: a profile ("Sign in with a durable Gateway profile…"), and being the skill's owner or a gateway admin ("Only the skill's owner or a Gateway administrator can change it."). The page offers the buttons only on the person's own skills.

There is no link to a skill, no "Copy link" and no "Sync". An edit to a shared skill is a new revision of the same skill: others' new tasks start with it, and their existing tasks keep theirs until updated, as with the person's own.

Who has seen a shared skill is not recorded anywhere the client can read, and the screen does not say. What was run is in research §10: share, unshare and the team list, live; another person's view of it, from the source only, because a development gateway has a single profile.

## 9. Skills in a task

The Details tab of the Work pane (`work-pane.md`) gains a section after the task's facts: **Skills in this task**, from `skills.library.list {sessionKey}`: `session.selections` and `session.attachable`. It is read when the tab opens, after every write from here, and when a run ends.

A row per selection: the name, its revision (`.k-rev`), and tags:

| Tag | When | From |
|---|---|---|
| "Newer revision" | The library entry's revision differs from the task's | `selections[].revision` against the list's entry |
| "Removed" | The skill is no longer in the library | the selection's `skillId` is not among the list's entries |
| "Not given" with a line "<Bot>'s skill list doesn't include it." | The bot's list (section 10) does not name it | `config.get` `agents.entries.<id>.skills` |
| "Not given" with a line "The gateway says what it needs isn't there." | `skills.status {agentId, sessionKey}` has it with `eligible: false` | research §6 |

A row opens the held revision, read-only, with `skills.library.read {skillId, revision, sessionKey}` (the only revision the gateway lets a task read; research §5): the content sentence, the fields as text, "Revision 8a3e2999a308, the one this task has".

**Actions** (interactive tier):

- **Update to the latest revisions**, at the section's head when any row has "Newer revision": `activate {sessionKey, action: "refresh"}`. It updates every skill of the task at once, which the button's line says: "Updates every skill in this task." When a row has "Removed", the gateway would refuse it (research §5), so the button is disabled and says "Detach removed skills first."
- **Detach**, on each row: `activate {action: "detach", skillId}`. On a removed skill its confirmation says "It can't be attached again."
- **Attach a skill**: a menu of `attachable`, each with its "Use when…" line; `activate {action: "attach", skillId}`.

After each, the section shows the answer's selections and one line: "From the next turn." When a run is in progress it adds: "The turn running now keeps the skills it started with." (research §5, `running`: a refresh during a run reached only the next turn).

States: loading (two grey rows), couldn't load (the gateway's message, "Try again"), none ("This task has no skills from your library." with Attach a skill), a refused write (the gateway's message as text; the rows as read again).

What the section does not say: whether the bot used a skill in a turn. The gateway records what it gave the model, not what the model did with it.

## 10. A bot's skills

A bot's Settings tab (`bots.md` §8) gains one row in its Tools group: **Skills**, whose value is the list's state ("Every skill", "Only 2", "None"). It opens **<Bot>'s skills**, a page with two parts.

### 10.1 Which skills the bot is given

From `config.get`, `agents.entries.<id>.skills`, which every tier can read (research §6). Three choices, a radio group:

| Choice | Written | Its line |
|---|---|---|
| Every skill | the key removed (`null` with `replacePaths`) | "<Bot> is given every skill the gateway finds usable: yours that are on, the ones shared on this gateway, and the gateway's own." |
| Only these | a list of names | the checkboxes below |
| None | `[]` | "<Bot> is given no skills from your library or the gateway's. Skills <Bot> learned are still given." |

Under "Only these": two groups of checkboxes, **Your library** (the list's entries, each by its name, written as its command name `entry.name`) and **On the gateway** (`skills.status {agentId}` entries that are not library skills, by their names). A name in the bot's list that matches neither is shown in its own group, **Not on this gateway**, as text, with "Remove from the list"; the line says "A name that matches no skill gives <Bot> nothing." (research §6: an unknown name matched nothing).

The page says, always, under the choices: "Skills <Bot> learned are given whatever this says." (research §6: workshop skills bypass the list) and "This decides what <Bot> is given; it doesn't stop <Bot>'s commands from reading files." (the gateway's own warning, research §6).

**Save** (admin): one `config.patch` with the `baseHash` the page read and `replacePaths: ["agents.entries.<id>.skills"]` (the gateway refuses to shorten a list without it; research §6). Then `config.get` again:

| Outcome | What the page shows |
|---|---|
| Saved | "Saved. From each task's next turn, <Bot> is given these. A turn running now keeps the skills it started with." The choices show the read-back |
| Someone else changed the settings | "Someone else changed <Bot>'s settings. This shows what the gateway has now." (the gateway's "config changed since last load"); nothing is written |
| Refused | The gateway's message as text; the choices as read again |
| No answer | "Couldn't tell whether it was saved." and the read-back when it comes |

The write does not restart the gateway and does not stop a run (research §6: `requiresRestart: false`, a run in progress ended `final`); the page does not warn of either. Below admin the choices are shown disabled with the access bar: "**Admin access needed.** Changing which skills <Bot> is given changes the gateway's settings."

What the page never uses for this: `skills.status`'s `blockedByAllowlist`, which did not reflect the list (research §6).

### 10.2 What <Bot> learned

From `skills.workshop.list {agentId}` and `skills.workshop.changes {agentId, limit: 50}`, both readable at every tier.

A sentence: "Skills <Bot> saved for itself on the gateway. They are given to <Bot> in every task." Then the rows: the learned skill's name (mono), its description, and one line from its newest change in the feed:

| Change | The line |
|---|---|
| `actor: "agent"`, with `sessionKey` | "Saved by <Bot> in <task's title>, 2:58 PM" (the task's title from the rail; "in a task" when it isn't loaded) |
| `actor: "agent"`, without one | "Saved by <Bot>, 2:58 PM" |
| `actor: "user"` | "Restored by a person, 3:10 PM" or "Archived by a person" |
| None found in the feed's last 50 | "When it was saved isn't in the gateway's recent changes." |

A row opens the learned skill read-only (`skills.workshop.read {name}`): the content sentence, its text as plain text, its files' names, and its changes. There is no edit: no operator method edits a learned skill (research §7).

**Archive** (admin), on its page: a confirmation, "Archive trail-checklist? <Bot> stops being given it. The gateway keeps it, and you can restore it.", then `skills.workshop.archive {agentId, name, reason}` with an optional reason the person types. **Archived** is a group below the live ones: each name with its versions' times and "Restore" (admin; `skills.workshop.restore`). Each says what the list shows afterwards: "Archived. trail-checklist is in Archived." only when the read-back has it there.

The gateway's own setting is shown as a fact: "Learning on its own: On" from `list.mode` (`auto` or `off`), with the gateway's description as a hint: "The gateway can save and update skills after long work, and archives ones unused for 30 days. Each change shows here." That second sentence is from the gateway's documentation (research §7, source); nothing here starts or stops it.

Below admin, archive and restore are absent and the access bar says "**Admin access needed.** Archiving a skill <Bot> learned needs admin access."

Empty: "Nothing learned yet. When <Bot> saves a skill for itself, it shows here."

## 11. Learned skills and the library

The two kinds live apart on the gateway, and the screens keep them apart: a library skill is the person's, has revisions, and is held by tasks; a learned skill is the bot's, has versions only through archive and restore, and is given in every task. A library skill is never shown in a bot's learned list, and a learned one never in the library.

## 12. Saving a process from chat

A bot saves a skill with its `skill_workshop` tool, when a person asks ("save this as a skill") or on its own. Which of two forms it has depends on the connection that sent the person's message (research §8): from Clawtrate's interactive tier the bot saves to the person's library; from an admin connection the same request saves a learned skill unless the bot names the library. The design does not choose; it shows what the call did.

The call is an action card (`conversation.md` §7), in the family of the others:

| The call | The card says | Opened |
|---|---|---|
| `create` or `update`, with `proposal_content`, result `state: "published"` | "Saved a skill · trail-checklist", state "Saved to your skills" | the readable view: the name, the "Use when…" line, the instructions as plain text; "Open in Skills" |
| `create` with `content`, result "Created …" | "Learned a skill · trail-checklist", state "Learned" | the same, and "Open in <Bot>'s skills" |
| `share`, `unshare`, `remove` | "Shared a skill", "Stopped sharing a skill", "Removed a skill" | the receipt's words |
| Any refused call | "Couldn't save a skill", state "Failed" | the gateway's text, as text |
| `list`, `read`, `view` | "Looked at skills" | — |

Under a "Saved a skill" card, on the interactive tier, one more line: "New tasks start with it. This task doesn't have it yet." with "Use in this task" (`activate {action: "attach"}`), because the gateway publishes to new tasks only (research §8). When the task already holds it, the line is absent.

No approval was asked for any of these calls (research §8). A person who wants one can set a rule for "Save skills" with the rules plugin (`controls.md`); this document adds no rule of its own.

**The composer** (#18 owns it, and nothing here changes it): in the "/" menu, a skill a bot learned is a command by its name (`/trail_checklist`), from `commands.list`; library skills are not listed there, because the gateway does not offer them as commands (research §8). The "+" menu gains nothing from this design; attaching a skill to a task is in the Details tab.

## 13. Phone, themes, read-only, keyboard

- **Phone (390).** Settings is a sheet with its list first (`bots.md` §7); Skills replaces it with Back. A skill's page is one column: the side by side of section 5.1 stacks, the gateway's version first, each with its heading. The editor is at least 10 lines and the foot's buttons wrap, Save first. Rows are 64 px. The Details tab's section and a bot's page are in the pane's sheet.
- **1100 and 800.** The Settings dialog keeps its width rules (`bots.md` §2); the comparison becomes one column below 760 px of section width.
- **Themes.** Only tokens; the tags carry words, so they read in both themes without colour.
- **Read-only.** Every value is there as text; nothing that would be refused is offered; one access bar per page.
- **Keyboard and screen readers.** The rows are buttons in document order; a page's title takes focus when it opens; Back returns focus to the row; radio groups have one tab stop with arrows; the editor's count is announced only when it crosses the limit; every tag is inside its row's accessible name ("trail-checklist, Use when planning a weekend walk, shared").

## 14. What the gateway's facts drive

Every row was run on a development gateway (research, the section named) unless it says source.

| Shown | Driven by | Research |
|---|---|---|
| The library, its groups and tags | `skills.library.list {scope: "all"}` (read): `entries[{skillId, slug, name, description, ownerLabel, ownerProfileId, shared, enabled, revision, updatedAt, canEdit}]`, `profileId`, `multipleProfiles` | §1, §2 |
| "Every device of yours sees the same skills" | The owner profile given to every operator connection on a gateway without roles | §1 |
| No profile | `profileId: null`; writes refused `IDENTITY_REQUIRED` | §1 (source) |
| A skill's page, its files, Needs | `skills.library.read {skillId}` (read): `{entry, revisions, content, files[{path, content, encoding, executable}]}`; frontmatter `metadata.openclaw.requires` | §3, §9 |
| Save and its outcomes | `skills.library.save {skillId, expectedRevision, slug, content, retainFiles}` (write): `state` `published` or `unchanged`; `SKILL_LIBRARY_CONFLICT` with `currentRevision`; `NAME_CONFLICT`; `INVALID_BUNDLE`; schema refusals; `UNAVAILABLE` for a literal key | §3 |
| Their version stays | Every revision stays readable by id | §3 |
| Name fixed after creation | The command name is made from the slug; a bot's list names the command name | §3, §6 |
| Files kept | A save without `retainFiles` drops support files | §3 |
| New tasks start with it | `mutate {action: "enable" \| "disable"}` (write) | §4 |
| Remove | `mutate {action: "remove"}`: `state: "removed"`; tasks keep their pins | §4, §5 |
| Share, Stop sharing, the team group | `mutate {action: "share" \| "unshare"}` (write, own skill); `list {scope: "team"}` | §4, §10 |
| Another person sees it | `seed` includes others' shared skills | §10 (source) |
| Nothing is live | No event for any library change | §4 |
| Skills in this task | `skills.library.list {sessionKey}` (read): `session.selections`, `session.attachable` | §5 |
| Update to the latest; disabled with a removed skill | `activate {action: "refresh"}` (write): every pin at once; refused with a removed one | §5 |
| From the next turn; the running turn keeps its own | `sessionActivation: "next-turn"`; a turn during a refresh was given the old revision | §5 |
| Opening a held revision | `read {skillId, revision, sessionKey}`: only that revision | §5 |
| Not given: the bot's list | `config.get` `agents.entries.<id>.skills` (read at every tier) | §6 |
| Not given: needs | `skills.status {agentId, sessionKey}` `eligible: false`; the bot was not given it | §6, §9 |
| A bot's list, its three choices | `config.patch` (admin) with `baseHash` and `replacePaths`; missing, `[]`, unknown and command-name results each proven with a turn | §6 |
| No restart; runs continue; the next turn | `requiresRestart: false`; a run in progress ended `final`; an existing task's next turn followed the list | §6 |
| Someone else changed the settings | "config changed since last load; re-run config.get and retry" | §6 |
| Learned skills given whatever the list says | `isSkillEntrySelected` passes workshop skills; a turn under `[]` was given one | §6 |
| What a bot learned, and its line | `skills.workshop.list` and `changes` (read): `actor`, `sessionKey`, `runId`, `createdAtMs`, `summary` | §7 |
| Archive and Restore, Archived | `skills.workshop.archive`, `restore` (admin); `archived[{name, live, versions}]` | §7 |
| Learning on its own | `list.mode`; the gateway's documentation | §7 (source) |
| The card | The `agent` `tool` stream, start `{name: "skill_workshop", args}` and result; the history's `toolCall` and `toolResult` | §8 |
| Which form the bot had | The connection that sent the message: interactive saves to the library, admin to the workshop | §8 |
| No approval | None raised | §8 |
| The "/" menu | `commands.list`: a learned skill as a command; no library skill | §8 |

## 15. Parity rows to reword

Statuses unchanged. Each target keeps its opening.

| Row | Cell | New wording |
|---|---|---|
| F-198 | target | same; note: what the bot saves goes to the person's library from Clawtrate's own connection, and is shown as a "Saved a skill" card; new tasks start with it. |
| F-198 | dependency | partial: a bot saves a skill with `skill_workshop` `create`. From a connection at the interactive tier its form is the personal library's, `{name, proposal_content}`, saving to `skills.library.list` (live); from an admin connection, the learned workshop's, `{name, content}`, saving to `skills.workshop.list` and `changes` with `actor: "agent"` (live). The call is an ordinary tool call in the agent stream and the history; no approval is raised (live). The development configuration does not offer the tool; `docs/research/skills.md` §8 lists the two config changes that do. |
| F-199 | target | same; note: three controls kept apart: a skill's "New tasks start with it" switch in the library, the skills a task holds, and which skills a bot is given (admin). |
| F-199 | dependency | partial: the library is read with `skills.library.list` and `read` (`operator.read`) and changed with `save` and `mutate` (`operator.write`, live). A task pins revisions at creation; `skills.library.activate {sessionKey, action}` (`attach`, `detach`, `refresh`; `operator.write`) applies from the next turn, not the running one (live). Per bot, `agents.entries.<id>.skills` through `config.patch` with `replacePaths` (`operator.admin`): missing gives every eligible skill, `[]` none, an unknown name nothing, and a library skill is matched by its command name; learned skills are given regardless; no restart (live, each with a turn). `config.get` reads the list at every tier. |
| F-361 | target | same; note: the name is set when a skill is made; saved edits reach new tasks, and an existing task when it is updated, from its next turn. |
| F-361 | dependency | partial: `skills.library.read {skillId, revision?, sessionKey?}` (`operator.read`) and `save {skillId, expectedRevision, slug, content, retainFiles?}` (`operator.write`, live); name and description are the `SKILL.md` frontmatter. A save on a stale revision is refused with `SKILL_LIBRARY_CONFLICT` and the current revision, and every revision stays readable (live). A save without `retainFiles` drops the support files (live). Learned workshop skills are read with `skills.workshop.read` (`operator.read`); no operator method edits them. |
| F-362 | target | same; note: the action is "Remove skill"; the gateway keeps a removed skill's revisions for the tasks that hold them, and archives learned skills instead (admin). |
| F-362 | dependency | partial: `skills.library.mutate {action: "remove"}` (`operator.write`, live): `state: "removed"`, absent from every list, tasks keep their pins and their next turn is still given it, `refresh` is refused until it is detached (live). Learned workshop skills: `skills.workshop.archive` and `restore` (`operator.admin`, live). |
| F-363 | dependency | partial: `skills.library.mutate {skillId, expectedRevision, action: "share" \| "unshare"}` (`operator.write`, the owner's own skill) sets `shared`, and `list {scope: "team"}` then lists it (live). It needs a durable gateway profile, which every operator connection has on a gateway without `gateway.roles` (the owner profile, live), and the owner's or an admin's entry authority. Another person seeing it is from the source only: a development gateway has one profile. `transfer` (admin) makes a skill team-owned, and it can't be unshared (live). There is no link to a skill; nothing leaves the gateway. |

F-363's target stays "not planned: skill publishing runs through the vendor's team service." This document designs sharing on the gateway instead; whether the row becomes `better:` with that, and its status, is a decision for the maintainers, with the wording proposed in the unit's report.

## 16. For builders

### What each part uses

| Part | Reads | Writes |
|---|---|---|
| Settings, Skills | `skills.library.list {scope: "all"}` | — |
| A skill's page | `skills.library.read` | `save`, `mutate` (`enable`, `disable`, `share`, `unshare`, `remove`) |
| Skills in this task | `skills.library.list {sessionKey}`, `read {…, sessionKey}`, `config.get`, `skills.status {agentId, sessionKey}` | `activate` |
| A bot's skills | `config.get`, `skills.library.list`, `skills.status {agentId}`, `skills.workshop.list`, `changes`, `read` | `config.patch`; `skills.workshop.archive`, `restore` |
| The card | The `agent` `tool` stream and `chat.history` | `activate {action: "attach"}` |

### What the engine supplies

- A `skills` store in `packages/core`: the list, per task selections and attachable entries, read on the triggers above. No polling and no event subscription: there is no event (research §4). `config.changed` (every tier) triggers a read of a bot's list.
- `composeSkillMarkdown({slug, description, instructions})` and its inverse, one module, tested against the gateway's frontmatter parser's output for the cases in research §3.
- `saveSkill` that always sends `retainFiles` for every file of the read revision, and returns the read-back.
- The conflict path as data: `{mine, theirs: {revision, content, savedAt}}`, kept until the person chooses.
- A kind in the action card table for `skill_workshop`, with the result adapter of section 12 (the receipt's `state`, or the workshop's "Created …" text).
- The bot's list writer: `config.patch` with `baseHash` and `replacePaths`, then `config.get`.

### Order

1. The library read and a skill's page, read-only (rows F-199, F-361 at read tier).
2. Save with its outcomes and the conflict path (F-361).
3. Remove and the switch (F-362, F-199).
4. Skills in this task (F-199, F-361's note).
5. The card (F-198).
6. A bot's list, then its learned skills (F-199, F-362's note).
7. Sharing (F-363), once the row's decision is made.

Each step's check runs against a development gateway that offers `skill_workshop` where it needs it (research §8 lists the two config changes); the scripted model's `#learn`, `#learn-workshop` and `#skills` play the bot.

### Prototype states

`prototype/skills.html` takes every parameter `bots.html` takes, and these:

| Parameter | Values |
|---|---|
| `open=settings&section=skills` | The Skills section |
| `skill` | A skill's page by id (`trail`, `kitchen`, `weather`, `river` shared by someone else, `ridge` team), or `new` |
| `lib` | `loading`, `error`, `empty`, `noprofile`, `many` |
| `save` | How the next save ends: `conflict`, `removed`, `refused`, `silent`, `lost`, `unchanged`, `taken` |
| `multi` | `1`: the gateway has more than one profile |
| `panel=open&tab=details` with `bot=juniper&task=j1` | Skills in this task; `pins=outdated`, `removed`, `none`, `error`; `running=1` |
| `tab=settings&bview=skills` | A bot's skills; `list=all`, `only`, `none`, `unknown`; `learned=empty`, `archived`; `cfg=conflict` |
| `task=jlearn` (bot Juniper) | The task with the `skill_workshop` cards |
| `access` | `read`, `write`, `admin`, as in `bots.html` |

The check `prototype/tools/checks/skills.mjs` clicks through every outcome above and asserts each state's words.

## 17. Not covered here

- **Skills from outside this gateway.** A public catalog (`skills.library.import` from ClawHub, `skills.search`, `skills.detail`) makes the gateway contact an outside host. This design has no screen for it and makes no request to any host but the person's gateway.
- **Teach a task**, recording a demonstration (#75).
- **The composer's menus** (#18): only what a skill looks like there is said, in section 12.
- **Editing a skill's files**, uploading a skill as a zip (`skills.library.upload`), and choosing an earlier revision as the current one (`mutate {action: "rollback"}`), which the gateway offers.
- **Transfer to team ownership** (`mutate {action: "transfer"}`, admin): it can't be undone by its owner (research §4), and no row asks for it.
- **Installed and bundled skills' own settings** (`skills.update`, `skills.install`, `skills.entries.<key>` keys and values), which are admin configuration of the gateway, and where a key would be typed. This design never shows or asks for a key.
- **Whether a bot used a skill in a turn**: the gateway does not record it.
- **Who saw a shared skill**, which the gateway does not record.
