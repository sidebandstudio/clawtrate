# Skills

How a person keeps skills on their gateway: the library of their skills, a skill's page, the revision each task has, the filter that narrows which skills a bot can be given, what a bot learned, saving a process from chat, and sharing a skill with the other profiles of the same gateway. It is written in the language of `visual-language.md`, `conversation.md` and `bots.md`, with their tokens.

What must be true is in `docs/parity.md`, rows F-198, F-199 and F-361 to F-363. What the gateway does is in `docs/research/skills.md`, from OpenClaw 2026.10.6's source and from runs on a development gateway with this project's own client; every state below names the fact it rests on, and section 14 lists them. Section 15 lists the rows, section 16 is for builders.

One rule sits above the rest: **a screen says what the gateway holds, read back, and no more.** A skill is text the gateway keeps and a bot follows; Clawtrate does not judge it. A write says what the next read shows, a task says which revisions it has saved, a bot's page says how its filter is set, and where the gateway does not say (who saw a shared skill, why a save was refused, which write produced what a read shows), the screen says it does not know.

The prototype is `prototype/skills.html`: the bots page with what this document adds. Its styles are `prototype/css/skills.css`, its behaviour `prototype/js/skills.js` and `prototype/js/skills-fixtures.js`, and `prototype/tools/checks/skills.mjs` checks it. Section 16 lists its states.

## Contents

1. How the pieces fit
2. Shared rules: components, words, access, writes, content, input
3. Settings, Skills: the library
4. A skill's page
5. Saving, and when the gateway has a different revision
6. A new skill
7. Removing a skill
8. Sharing on this gateway
9. Skills in a task
10. A bot's skill filter, and what it learned
11. Learned skills and the library
12. Saving a process from chat
13. Phone, themes, read-only, keyboard
14. What the gateway's facts drive
15. Parity rows
16. For builders
17. Not covered here

## 1. How the pieces fit

```
gateway menu, Settings (⌘,)    Settings gains a section, Skills, after Accounts
  Skills                          your skills and the others this connection can see
    a skill's page                 Name, Use when…, Instructions, other settings, files, Save
    New skill                      the same page, empty
Work pane, Details tab           Skills in this task: the revision each has; Update, Detach, Attach
Work pane, Settings tab          a bot's settings (bots.md §8) gains a row, Skill filter, in Tools
  <Bot>'s skills                   the bot's skill filter; what it learned
conversation                     the bot's skill_workshop calls are action cards
```

Grok Bot keeps skills in one place with a page per skill and a switch on each bot. The gateway splits that into three controls with different owners, and the screens keep them apart instead of merging them into one switch that would be false for two of them:

| What                                                                                       | Who may change it                                                                            | Where                  |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------- |
| The library: a skill's text, whether it is included in defaults for new tasks, its sharing | The person's own connection at the interactive tier (`operator.write`), for their own skills | Settings, Skills       |
| A task's skills: which library skills it has, at which revision                            | The interactive tier                                                                         | The task's Details tab |
| The bot's configured skill filter                                                          | Admin (`config.patch`)                                                                       | The bot's Settings tab |

None of the three alone says what a bot is given in a turn. A library skill reaches the bot only in a task that has it, only if the bot's filter lets it through, and only if the gateway says what it needs is there (research §6). The screens show each control as it is set and never compute the bot's effective skills from them.

## 2. Shared rules

### Components used

| Component                                                               | From                               | Used for                                   |
| ----------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| Settings frame, dialog, confirmation, note, result, switch, choice rows | `bots.md` §2                       | The Skills section, Remove, the bot's page |
| Fact block, group word, empty state, tabs                               | `visual-language.md` §9            | Every page here                            |
| The access bar and its states                                           | `conversation.md` §3, `bots.md` §2 | Every write below the tier it needs        |
| Action card, its readable view and Raw                                  | `conversation.md` §7 to §9         | The `skill_workshop` calls                 |
| `.input`, a `textarea` with the same look                               | `visual-language.md` §4            | The skill's editable fields                |

### New components

Each is defined once, in `prototype/css/skills.css`, from existing tokens.

| Component                            | What it is                                                                                                                                                                                                                                                                  | Tokens                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Skill row (`.k-row`)                 | A whole-row button in a fact block: the name (15/500, mono for a learned skill's name, wrapping), the "Use when…" line under it (13, faint, two lines at most), and tags at its end.                                                                                        | `--bg-bubble`, `--border`   |
| Tag (`.k-tag`)                       | A word on a soft fill, radius 999, 12/500: "Not in defaults", "Shared", "Team", "Different library revision", "Removed from the library", "Library entry unavailable", "Couldn't read the library entry", "Not eligible in the gateway's skill status". Never colour alone. | `--bg-inset`, `--warn-soft` |
| Revision (`.k-rev`)                  | The first 12 characters of a revision, mono, 12, with the full id as its accessible name.                                                                                                                                                                                   | `--font-mono`               |
| Editor (`.k-editor`)                 | A plain `textarea` for the instructions, mono 13/20, at least 12 lines, growing to the pane, no markdown preview.                                                                                                                                                           | `--font-mono`, `--bg-inset` |
| Read-only text (`.k-ro`, `.k-plain`) | A value that can't be edited here is wrapping text, never a read-only field: one line of text for "Use when…", a preformatted block for instructions and other settings. Nothing is cut off at any width.                                                                   | `--bg-inset`                |
| Side by side (`.k-compare`)          | Two columns, "On the gateway now" and "Your edit", each with its own heading; one column when the comparison is narrower than 760 px, the gateway's first.                                                                                                                  | `--border`                  |
| Pending line (`.k-pending`)          | The connecting dot and the write's word ("Saving…"), while a write waits for its answer and its read.                                                                                                                                                                       | `--text-muted`              |

### Words

- **Skill**: what the gateway's library holds. The page names it by its slug, which is its name everywhere here ("trail-checklist").
- **Revision**: one saved version. The gateway identifies it by a hash of the whole skill; the screen shows the first 12 characters and never calls it a version number, newer or older.
- **Your skills**, **Shared on this gateway**: the library's own split (`ownerProfileId` and `shared`). "Team" is the gateway's word for a skill no person owns.
- **Has**: what a task saved as its skills for its next turns. **Given**: what a bot's model receives in a turn; the screens never claim it, because no read establishes it for a task in advance (research §6). The screen never says a bot "uses" or "knows" a skill.
- **Filter**: a bot's configured skill list in the gateway's settings, its own or the gateway's default. It is a base filter: the gateway also applies a task's own skill overrides, which Clawtrate doesn't read.
- **Learned**: an entry in the bot's change feed, by its actor. Nothing more.
- No word promises more than this: no "safe", "verified", "trusted" or "installed" about a skill.

### Access

| Tier                                                | What the screens offer                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read-only (`operator.read`)                         | The library entries this connection can read, and exact pins for tasks it can read. Bot settings and workshop reads use their own gateway permissions. Nothing editable; no Save, Remove, Share, Update, Detach, Attach or "Use in this task". The access bar: "**Read-only.** Changing skills needs write access." with "Request access". |
| Interactive (`operator.write`, Clawtrate's default) | The library for the person's own skills, every task action. A bot's filter and archiving a learned skill show their value and the access bar: "**Admin access needed.** Changing <Bot>'s skill filter changes the gateway's settings." with "Request admin access".                                                                        |
| Admin                                               | Everything, including a bot's filter and archive and restore. Admin access is asked for only from those two places, and only when the person chooses the button. An admin also sees other people's unshared skills in the library (research §1).                                                                                           |

Each refusal is the gateway's: `FORBIDDEN` "missing scope: operator.write" or "missing scope: operator.admin" (research §2). The screen does not offer what its tier would make the gateway refuse. An action is offered from the tier this connection holds now, not the one it held when the page or the card was drawn.

### Writes

Every write here (save, remove, share, stop sharing, the defaults switch, attach, detach, update, the bot's filter, archive, restore) follows one path:

1. **Captured when chosen.** What is sent is fixed at the click: the action, its subject (skill id, task key, bot), the base revision or config hash it applies to, and for a save the whole skill it sends. Typing after the click does not change what was sent and is kept, marked unsaved.
2. **Pending.** While a skill write is pending, Back, Close, Escape and changing Settings section wait for the result. During a Save the description and instructions stay editable. During Remove those fields are read-only until the result. The pending line says "Saving…", "Removing…", "Sharing…", "Updating…" and so on. The control that sent it is disabled until the write settles; nothing says it happened.
3. **Read back.** After the gateway answers, or does not, the page reads the subject again (`skills.library.read`, `list`, `list {sessionKey}`, `config.get`, `skills.workshop.list`) and says what that read shows. "Saved", "Removed", "Shared", "Updated", "Archived" are said only when the read shows it. The answer is the gateway's word on what it did; a read cannot prove which write produced what it shows, so when there was no answer the page says what the read found and that it doesn't know whose write it is (research §3).
4. **Never replayed.** Nothing is sent again by itself. With no answer, the person sees what the read found and chooses.
5. **Offline.** With the connection down, every write control is disabled with "Not connected to the gateway. What you type stays here; Save waits for the connection." Drafts stay.

A refusal is shown by its `details.code` when it has one (`SKILL_LIBRARY_CONFLICT`, `SKILL_LIBRARY_NOT_FOUND`, `SKILL_LIBRARY_NAME_CONFLICT`, `MISSING_SCOPE`), all of which arrive inside `INVALID_REQUEST` or `FORBIDDEN` (research §3), and otherwise by its message, as text.

### The skill is content

A skill's name, its "Use when…" text, its instructions, its other frontmatter, its files' names and contents, the owner's label, a learned skill's change summary and every card's arguments and result come from the gateway, and some of them from a bot. They are shown as text:

- Instructions are shown and edited as plain text in a `textarea` or a preformatted block, never rendered as markdown or HTML, so an address in them is text, not a link, and nothing in them is fetched (`docs/decisions.md`, "Addresses a gateway hands the client": an address the gateway supplies in a tool result or a reply is never fetched or opened, and may appear as text). Angle brackets stay characters.
- A support file is listed by its path and size; its content never reaches the page.
- The owner's label is the gateway's (research §1). It is shown as given, wrapping, never used as a heading.

Every skill's page carries one sentence in plain words, above its instructions: "**A skill supplies instructions to a bot.** A bot given this skill can act on what it says, with the tools it is allowed. Read it before your bots are given it." Nothing on any page calls a skill safe or checked.

### Input

- Every page here is reached by a row and left by a quiet round Back that returns focus to that row, as in `bots.md` §8; Back from a task's held revision returns to that revision's row.
- Fields are labelled; errors sit under their field with `aria-describedby`, and the first error takes focus after a refused save.
- ⌘S saves the open skill's page when Save is enabled. Back, Close, Escape and choosing another Settings section all ask first when something is unsaved (section 5), and wait while a write is pending.
- A radio group keeps focus on the chosen radio when an arrow moves the choice.
- One polite live region announces each pending word and each outcome as the read shows it.

## 3. Settings, Skills: the library

**Skills** is a section of the Settings dialog, after Accounts (`bots.md` §7). It lists what `skills.library.list {scope: "all"}` returns to this connection.

The section opens with a sentence: "Skills in your library on this gateway, and skills others share here. A library skill reaches a bot only in a task that has it." Then "New skill" (default button) at the right, on the interactive tier.

**Groups**, in this order:

| Group                                                          | Rows                                                                                                                                                                          | From                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Your skills                                                    | Entries whose owner is the list's `profileId`                                                                                                                                 | `profileId !== null && ownerProfileId === profileId`     |
| Shared on this gateway (admin: Others' skills on this gateway) | Others' shared entries and team-owned ones, each with "From <owner's label>" or "Team"; below admin only these; an admin also sees others' unshared ones, marked "not shared" | `shared`, `ownerProfileId: null`, the admin's wider read |

A row: the name, the "Use when…" line, and its tags: "Not in defaults" when `enabled` is false, "Shared" when the person's own skill is shared. A row opens the skill's page.

**Under the groups**, a hint: "When an attributed person with a gateway profile creates a task, the gateway can pin up to 64 enabled library skills, their own first. Spawned tasks and tasks the gateway marks synthetic do not get these defaults. A save does not change an existing task's pins." (research §5: the gateway seeds only a new task started by an attributed, non-synthetic person with a profile, not a spawned one, at most 64, from enabled entries the profile owns, team entries and shared ones). With more than 64 included, the gateway's own `defaultSelectionNotice` is shown in a note instead, as text.

**States.**

| State               | It shows                                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading             | Three grey row shapes, pulsing, `aria-busy`                                                                                                                                                                                                  |
| Couldn't load       | The empty mark with a warning, "Couldn't load your skills", the gateway's message as text, "Try again"                                                                                                                                       |
| Empty               | "No skills yet", "A skill is a process you want a bot to follow, written once. Save one here, or ask a bot to save what it just did." and, on the interactive tier, "New skill" (primary)                                                    |
| No personal library | When the list's `profileId` is null: a note, "This connection has no personal library: the gateway's list says it has no profile. Skills shared on this gateway are still listed." The shared and team rows stay; no New skill (research §1) |
| Offline             | The rows as last read, a warning note "Not connected to the gateway. This is the list as read at 5:41 PM; nothing can be changed until the connection is back.", New skill disabled                                                          |
| Read-only           | The rows; no New skill; the access bar at the foot                                                                                                                                                                                           |

The list is read when the section opens, when the dialog regains focus, and after every write of this device. No event announces another device's change (research §4), so nothing claims to be live: the section's foot says "As read at 5:41 PM" with "Read again".

## 4. A skill's page

Opened from a row: Back ("Back to skills") and the skill's name as the title, wrapping when it is long. Read with `skills.library.read {skillId}`.

**Top to bottom:**

1. The content sentence (section 2).
2. **Name**: the slug, as text, with "A skill's name is set when it is made in Clawtrate." The gateway's save takes a slug and can change it; Clawtrate does not offer renaming in this version, because a bot's filter names a library skill by a command name made from the slug and the skill's id (research §3, §6).
3. **Use when…**: a one-line input, the frontmatter `description`. Required. One line, at most 1,024 UTF-16 code units after parsing the frontmatter. Show the count from 900 ("900 of 1,024 characters."); over it, "Use when… is too long (maximum 1,024 characters)." (`bundle-D_720Viz.mjs` lines 82-101 test the parsed description's `.length`).
4. **Instructions**: the editor, the body after the frontmatter.
5. **Its other settings**, when the frontmatter has lines other than `name` and `description` (`user-invocable`, `metadata` and the like): those lines exactly as read, in a preformatted block, with "Written in the skill by whoever made it. Saving keeps them exactly as they are; this page doesn't change them." They decide how the gateway offers the skill and what it needs (research §3: a save that dropped them changed `userInvocable` from false to true).
6. **Files**, when the revision has any: a fact block, one row per file: its path (mono), its size, and "Can run as a program" when `executable` is true, wrapping. A hint: "Kept with every save. A bot runs a file only with the tools it is allowed. Editing files isn't in this version."
7. **Needs**, when the frontmatter names requirements (`metadata.openclaw.requires`): "Programs: curl. Values: WEATHER_API_KEY." from the skill's own text, and "The gateway gives a skill to a bot only when what it needs is there." The page never asks for a value and never shows one (research §9).
8. **On the gateway**: Owner ("You" when the list has a `profileId` and the entry's owner is it; otherwise the owner's label, or "Team"), Revision (`.k-rev`), Updated (`updatedAt`, which any change to the entry moves, not only a save), Shared ("Shared on this gateway" or "Not shared"), and "Include in defaults for new tasks" as a switch (section 4.1).
9. **Actions**, at the foot: Save (primary, enabled only when a field changed, both required fields have text, nothing is pending and the connection is up), then a spacer, "Share on this gateway" or "Stop sharing" (section 8), "Remove skill…" (quiet, danger; section 7).

Edit actions are shown only with current write scope, a durable profile, and the gateway's `canEdit` for that entry, as read. When `canEdit` is false (another person's shared skill, a team skill below admin) every value is wrapping text and the page says "Only the skill's owner or a Gateway administrator can change it." in the gateway's words. On another person's entry the defaults flag is shown as read, with a switch only if those same guards permit it. Share and Stop sharing stay on the person's own entries (section 8).

**When the text can't be edited without changing anything else.** The save works on the read bytes: it replaces the exact scalar span of `description:` only when Use when… changed, and the exact body span only when Instructions changed; every other byte (comments, quoting, line endings, the other frontmatter lines) is sent as read. Clawtrate edits a skill only when the description is one editable, unambiguous scalar span and the new value parses back through the gateway's frontmatter parser to exactly what was typed; otherwise the skill stays read-only. A skill whose description is written another way (a folded or multi-line value) is shown read-only: a note, "Clawtrate can't change this skill's text without changing how it is written: its Use when… isn't on one line. It is shown as the gateway keeps it.", and its whole `SKILL.md` as text.

### 4.1 "Include in defaults for new tasks"

A switch (`bots.md` §2) bound to `enabled`: `mutate {skillId, expectedRevision, action: "enable" | "disable"}`, with the saved revision the page shows; the gateway refuses it when the content has changed since. Its line: on, "Eligible new tasks can start with this skill, subject to the 64-skill limit."; off, "Excluded from defaults. It can still be attached where the gateway offers it." The switch moves only after the read that follows the answer, to the read's `enabled` (section 2, Writes). The receipt and the read are reported apart, as for sharing (section 8): a refusal for a different revision leaves the switch as read and keeps the draft on its old base; "The gateway accepted the request. The skill is not included in defaults as of the next read." when the read shows the other value; "The gateway did not answer this request." before what the read found when there was no answer; and "Couldn't read the skill again. The setting shown is from the earlier read." when the read fails. A task that has the skill is not changed, and the line says nothing about one (research §4, §5: a disabled skill stayed disabled after a save, a new task did not begin with it, an explicit attach succeeded).

## 5. Saving, and when the gateway has a different revision

**Save** sends `skills.library.save {skillId, expectedRevision, slug, content, retainFiles}` captured at the click: the revision the page read, the slug, the whole `SKILL.md` as read with only its description value and body replaced (section 4), and every file's path in `retainFiles`, from the same revision. Nothing the person did not edit changes.

The receipt and the read that follows are kept apart. The page concludes only what they establish: a revision the read shows can be a later save, a rollback or someone else's, and the page does not say which.

| Outcome                               | What the page shows, after the read                                                                                                                                                                                                               | From                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pending                               | "Saving…"; Save disabled; the fields stay editable, and what is typed now is kept for after                                                                                                                                                       | —                                                                                                      |
| Saved                                 | "Saved revision 12a27e7c037e. Tasks that hold it keep their pins." The switch and the library hint carry the conditional defaults                                                                                                                 | the answer's `entry.revision`, equal to the read's                                                     |
| The read found a different revision   | "The gateway returned revision A for your save. The next read found revision B. The page shows B."                                                                                                                                                | the answer's revision differs from the read's                                                          |
| Typed after Save                      | Added to any outcome, a refusal or a failed read included: "You typed more after you chose Save. That text is still here, unsaved." The text stays, unsaved; no outcome replaces it                                                               | the draft differs from what was sent                                                                   |
| Unchanged                             | "The gateway already had this bundle at revision A." only when the read that follows shows A; otherwise the different-revision line above                                                                                                         | `state: "unchanged"`, and the read                                                                     |
| The gateway has a different revision  | Section 5.1                                                                                                                                                                                                                                       | `details.code: SKILL_LIBRARY_CONFLICT` with `currentRevision`                                          |
| Removed                               | A danger note: "This skill was removed on the gateway. Your text is still here." with "Save text as a new skill" (section 6, with a note that the removed skill's other settings and files aren't copied)                                         | the read's `removed: true`, and only that                                                              |
| Not found, the read refused or failed | A danger note: "Couldn't read this skill again. Your text is still here." with "Save text as a new skill"                                                                                                                                         | `INVALID_REQUEST` with `details.code: SKILL_LIBRARY_NOT_FOUND`, which alone doesn't say it was removed |
| Refused, with a reason                | A danger note: "The gateway answered: <its message> The next read found revision R. Your text is still here." A revision other than the page's base opens the comparison of 5.1                                                                   | `INVALID_REQUEST` and its message                                                                      |
| Refused, no reason                    | "The gateway answered that it couldn't complete the save, without saying why. The next read found revision R. Your text is still here."                                                                                                           | `UNAVAILABLE`, which has more than one cause (research §3)                                             |
| Refused, read failed                  | The refusal, then "Couldn't read the skill again. The page shows the last readable revision. Your text is still here." with "Read again"                                                                                                          | the refusal; the failed read                                                                           |
| No answer                             | "Couldn't tell whether your save reached the gateway. Reading the skill again found revision R, updated 5:43 PM; its text matches (or doesn't match) what you sent. Which save wrote it isn't known. Your text is still here." No automatic retry | `read`                                                                                                 |
| Answered, read failed                 | "The gateway returned revision R for your request. Reading the skill again failed. The page still shows the previous read." with "Read again"; announced "Couldn't read the skill again."                                                         | the answer; the failed read                                                                            |
| No answer, read failed                | "Couldn't tell whether your save reached the gateway, and reading the skill again failed too. Your text is still here." with "Read again"                                                                                                         | —                                                                                                      |
| Offline                               | Save disabled; the note of section 2, Writes                                                                                                                                                                                                      | the connection                                                                                         |

### 5.1 When the gateway has a different revision

The skill's revision on the gateway is no longer the one this page read: a save from another device, an admin's, or a rollback. The gateway refused this save and named its revision; neither text is lost (research §3). The page doesn't say who changed it.

A warning note: "**The gateway has a different revision**: 61e478c150ba, as read at 5:44 PM. Your edit isn't saved. Compare them, then choose." Under it, side by side: **On the gateway now** (revision, time, its "Use when…" and its whole instructions, as text, from `read`) and **Your edit** (the page's fields, still editable). Below them:

- "Save my edit" (primary): saves the page's two fields on the gateway's current revision, keeping that revision's other settings and files. The line before it says "Theirs stays as an earlier revision on the gateway. Saving yours keeps its other settings and files as they are on the gateway now." — a readable library entry exposes its saved revisions (research §3).
- "Use theirs": a confirmation, "Discard your edit? Your text is deleted from this page. The gateway's version stays.", Cancel and Discard. Only then is the page's text replaced.

If a third save lands while the person compares, Save my edit is refused again and the comparison updates to the revision just read; nothing is saved silently.

**Leaving with unsaved text.** Back, Close, Escape, or choosing another section of Settings with a changed field asks: "Leave without saving? Your edit to trail-checklist is lost.", Cancel (default) and Leave. Nothing closes before the answer.

## 6. A new skill

"New skill" opens the same page with empty fields, the title "New skill", and **Name** as an input with its rule under it: "Lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters." The rule is checked as the person types, from the gateway's own pattern `^[a-z0-9][a-z0-9-]{0,62}$`; the field shows what is wrong and Save stays disabled until it fits. Clawtrate also requires instructions (the gateway accepts a skill without any; research §3). The new skill's `SKILL.md` has exactly `name` and `description` in its frontmatter.

| Outcome               | What the page shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved                 | Read the skill using the receipt's skill ID. Use the name only for a missing answer. Say "Saved revision R" only once the read confirms the same entry and revision. Show its defaults switch as read. The page becomes the skill's page, with "Saved revision R. Tasks that hold it keep their pins."; focus on the title. The page holds what was sent; when the description or instructions were changed after Save, those changes stay in the fields and the page adds "You typed more after you chose Save. That text is still here, unsaved." The Name is read-only until the creation settles |
| A different read      | The read of the receipt's ID shows another revision: "The gateway returned revision A for your save. The next read found revision B. The page shows B."                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Answered, read failed | "The gateway returned revision R for your request. Reading the skill again failed. Your text is still here." with "Read again"; the form is kept                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Name taken            | Under Name: "You already have a skill called trail-checklist. Choose another name." (`SKILL_LIBRARY_NAME_CONFLICT`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Too long              | Under Instructions: "SKILL.md can be at most 1,048,576 UTF-8 bytes, including the frontmatter." Checked on the bytes of the actual serialized `SKILL.md` before sending. Where the gateway reports the aggregate limit, its message is shown                                                                                                                                                                                                                                                                                                                                                         |
| Refused               | "The gateway answered: <its message> Your text is still here." Nothing is created and the form is kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| No answer             | After reading the library by name: "Couldn't tell whether your save reached the gateway. Reading your library again found a skill named X, revision R; whether your save made it isn't known." with "Open it"; or "found no skill named X. Your text is still here." A skill found by name may be another device's                                                                                                                                                                                                                                                                                   |

On every outcome but Saved the form stays as it is: nothing is cleared on an unsuccessful or unknown result.

**Save text as a new skill** (from a removed skill, section 5): the same page titled "Save text as a new skill", with the removed skill's "Use when…" and instructions and an empty Name, and a note: "The removed skill's other settings and files aren't copied: the new skill has only this Use when… and these instructions. Give it a name to save it."

## 7. Removing a skill

"Remove skill…" opens a confirmation:

> **Remove trail-checklist?** It leaves your library and new tasks won't begin with it. Tasks that have it keep their revision until it is detached there. You can't undo this; a new skill can take its name.

With unsaved text on the page it adds: "If the skill is removed, your unsaved text stays here. You can save it as a new skill." Cancel (default), Remove (danger). `mutate {action: "remove"}` with the page's revision, then "Removing…"; the two fields are read-only until the result. Then the page reads the skill by id:

| The receipt and the read          | The page                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Removed; `removed: true`          | With nothing unsaved, the list, with "Removed. Reading your library again: trail-checklist isn't in it. Tasks that have it keep their revision." With unsaved text, the removed skill's page keeps the draft, with that line, "Your unsaved text is still here." and "Save text as a new skill" (section 6); Save, Share and Remove are disabled |
| No answer; `removed: true`        | "Reading the skill again shows it was removed. The gateway did not answer your request. Tasks that hold it keep their pins." The list, or with unsaved text the removed skill's page, as above                                                                                                                                                   |
| Refused: `SKILL_LIBRARY_CONFLICT` | "The gateway refused this removal because it read a different revision. Reading it again found revision R. Your unsaved text is still here." With unsaved text the draft stays and the comparison of section 5.1 opens with the read; with none the page shows the read. (A stale Remove is refused, research §4)                                |
| Refused, another reason           | "The gateway answered: <its message> Reading it again found revision R." and, with unsaved text, "Your unsaved text is still here."                                                                                                                                                                                                              |
| No answer; still there            | "Couldn't tell whether it was removed. Reading it again: it is still in your library."                                                                                                                                                                                                                                                           |
| The read fails                    | The page and the draft stay: "The gateway answered that it removed the skill. Reading the skill again failed. The page still shows the previous read." (or, with no answer, "Couldn't tell whether it was removed, and reading the skill again failed too. The page still shows the previous read.") with "Read again"                           |

The word is Remove, not Delete: the gateway keeps the removed skill's revisions for the tasks that have them (research §4, §5).

## 8. Sharing on this gateway

On a person's own skill: "Share on this gateway" (`mutate {skillId, expectedRevision, action: "share"}`), and once shared, "Stop sharing" (`unshare`), each with the saved revision the page shows. Under the buttons, always: "Both change sharing for this skill. The request checks the saved revision shown here." With unsaved text on the page it adds "Your unsaved text stays here."

What the page says, by state:

- Not shared: "Not shared" in the facts; under the button, "Sharing makes it available to eligible profiles on this gateway: it is listed in their libraries, and their new tasks can begin with it while it is included in defaults. Nothing leaves the gateway."
- Shared: the "Shared" tag on the row; "Shared on this gateway" in the facts; "Shared on this gateway: eligible profiles here can see it in their libraries. Tasks that have it keep it when you stop sharing."

The gateway checks the content revision on Share and Stop sharing. Two devices can still change the sharing flag on the same revision (research §10). After the answer, or its absence, the page reads the skill (`read`) and the team list (`list {scope: "team"}`) again. The receipt and the two reads are reported apart:

| The receipt, then the reads               | The page says                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted; both reads show what was sent   | "Shared. Reading the skill again, it is shared at revision R. The gateway's list of shared skills includes it." or "Not shared. Reading the skill again, it is not shared. The gateway's list of shared skills doesn't include it. Tasks that already have it keep their revision."             |
| Accepted; both reads show the other state | "The gateway accepted the request. The skill is shared (or not shared) as of the next read."                                                                                                                                                                                                    |
| The two reads disagree                    | "The two reads reported different sharing states. Read again." with "Read again"                                                                                                                                                                                                                |
| No answer                                 | "The gateway did not answer this request." then the read facts, as in the first row, without "Shared." or "Not shared."                                                                                                                                                                         |
| The read fails                            | "Couldn't read sharing again. The sharing status shown is from the earlier read." with "Read again"                                                                                                                                                                                             |
| Refused: `SKILL_LIBRARY_CONFLICT`         | "The gateway refused this request because it read a different revision. Reading it again found revision R, not shared." The flag is left as read; with unsaved text, "Your unsaved text stays here." and the draft keeps its old base, compared with the read (section 5.1) before another save |

What sharing needs, and its refusals, shown as the gateway's text: a durable profile ("Sign in with a durable Gateway profile…"), and being the skill's owner or a gateway admin ("Only the skill's owner or a Gateway administrator can change it."). The page offers the buttons only on the person's own skills.

There is no link to a skill, no "Copy link" and no "Sync". An edit to a shared skill is a new revision of the same skill; others' existing tasks keep theirs until updated. Who has seen a shared skill is not recorded anywhere the client can read, and the screen never says anyone did. What was run is in research §10: share, unshare and the team list, live, on one profile; another eligible profile's view, and its tasks keeping a pin after withdrawal, from the source only.

## 9. Skills in a task

The Details tab of the Work pane (`work-pane.md`) gains a section after the task's facts, for every bot's task: **Skills in this task**, from `skills.library.list {sessionKey}`: `session.selections` and `session.attachable`. It is read when the tab opens, after every write from here, and when a run ends. Its first line says when: "As read at 5:41 PM. The skills this task has saved for its next turns, each at its revision."

A row per selection: the name, its revision (`.k-rev`, the task's own, never the library's), and tags:

| Tag                                                                              | When                                                                                                                                                                                                                              | From                                                                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Different library revision", with "The library has revision R."                 | The library entry's revision is not the task's. It may be newer or, after a rollback, older                                                                                                                                       | `selections[].revision` against the list's entry                                                                                                    |
| "Removed from the library"                                                       | The entry is missing from the list and `read {skillId}` shows `removed: true`                                                                                                                                                     | the read                                                                                                                                            |
| "Library entry unavailable"                                                      | The entry is missing from the list and the read refuses it (another person stopped sharing it, or it isn't readable to this connection)                                                                                           | `INVALID_REQUEST` with `details.code: SKILL_LIBRARY_NOT_FOUND` from `read`; the catalog excludes others' unshared entries below admin (research §1) |
| "Couldn't read the library entry"                                                | The entry is missing from the list and its read failed. It is not called removed or unavailable                                                                                                                                   | the failed read                                                                                                                                     |
| "Not eligible in the gateway's skill status", with the reason the status reports | `skills.status {agentId, sessionKey}` lists it with `eligible: false`. That is also how the status reports a disabled skill, so the tag says no more; "Needs not met" is shown only beside a missing requirement the status names | research §6, `status-B3-20oM-.mjs` lines 83-105 (source)                                                                                            |

Under the rows, apart from them: "<Bot>'s skill filter is the gateway's default, no filter. A filter can leave out a skill this task has; it is set in <Bot>'s settings, apart from these." The section never marks a row given or not given by the filter: the filter, the gateway's defaults and a task's own overrides together decide that, and the client reads only the first two (research §6).

A row opens the held revision, read-only, with `skills.library.read {skillId, revision, sessionKey}` (the only revision the gateway lets a task read; research §5): the content sentence, its fields as text, "Revision 8a3e2999a308, the one this task has". Back returns focus to that row.

**Actions** (interactive tier, each a write of section 2 holding the task key, the skill id and its revision from the click). Everything the section holds is kept per task key: its last read and its time, a pending write, the outcome, an open held revision and the attach menu. A write's outcome is shown and announced only in the view of the task it was for; choosing another task closes a held revision, and a task this device hasn't written to shows the loading, empty or error state of its own read.

- **Update to the library's current revisions**, at the section's head when any row has "Different library revision": `activate {sessionKey, action: "refresh"}`, for every skill of the task at once; the gateway selects the current revisions when it arrives: "Updates every skill in this task." With a row marked removed or unavailable the gateway would refuse it (research §5), so the button is disabled and says "Detach the skills marked unavailable or removed first: the gateway refuses to update a task that has one."
- **Detach**, on each row: `activate {sessionKey, action: "detach", skillId}`, with the task key and the exact skill id. On a removed skill its confirmation says "It was removed from your library, so it can't be attached again."; on an unavailable one, "Its library entry isn't available to this connection, so it may not be attachable again."
- **Attach a skill**: a menu of `attachable`, each with its revision and its "Use when…" line; `activate {sessionKey, action: "attach", skillId, revision}`, with the revision `session.attachable` showed at the click, so a library save that lands meanwhile doesn't change what is attached. At 64 skills the button is disabled with "This task already has 64 library skills. Detach one to make room."; with nothing attachable the menu says "No skills are available to attach."

After each, the task is read again and compared with the receipt's returned selection and identity. The section says "Reading the task again, it has revision R." or "Reading the task again, it no longer has that skill." only for those exact observations, after "Attached." or "Detached." when the receipt agrees, and "From this task's next turn." For Update: "Updated. Reading the task again shows these saved revisions, from its next turn." When a run is in progress it adds: "The turn running now keeps the skills it started with." (research §5). A refused write: "The gateway answered: <message> The skills shown are from the next read." No answer: "Couldn't tell whether the change reached the gateway." before what the read shows. When the read fails, the last pins stay with their time, and "Couldn't read this task's skills again."

States: loading (two grey rows), couldn't load (the gateway's message, "Try again"), none ("This task has no skills from your library." with Attach a skill), offline (actions disabled), read-only ("Changing a task's skills needs write access.").

What the section does not say: whether the bot was given or used a skill in a turn.

## 10. A bot's skill filter, and what it learned

A bot's Settings tab (`bots.md` §8) gains one row in its Tools group: **Skill filter**, whose value is how the filter is set ("Gateway default", "Only 2", "None"). It opens **<Bot>'s skills**, a page with two parts.

### 10.1 The filter

From `config.get`: `agents.entries.<id>.skills` and `agents.defaults.skills`, which every tier can read (research §6). The page opens with what a filter is: "A filter narrows the skills <Bot> can be given in a task. It doesn't add any: a task is given a library skill only if it has it (see a task's Details), and any skill only if the gateway says what it needs is there." Three choices, a radio group:

| Choice                    | Written                                            | Its line                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use the gateway's default | the bot's key removed (`null` with `replacePaths`) | What the default is now, from `agents.defaults.skills`: "The gateway sets no default skill filter.", "The gateway's default skill filter is an empty list.", or "The gateway's default is only github, tmux." |
| Only these                | a list of names                                    | the checkboxes below                                                                                                                                                                                          |
| None                      | `[]`                                               | "Juniper's configured filter is an empty list."                                                                                                                                                               |

Under "Only these": two groups of checkboxes, **Your library** (the list's entries, each by its slug with its command name `entry.name` under it, wrapping) and **On the gateway** (`skills.status {agentId}` entries that are not library skills). A name in the filter that matches neither is shown in its own group, **Not in the gateway's lists now**, as text, with "Remove from the filter" and "No matching skill is listed in these reads. A task may still hold a pin with this command name." (research §6: the filter matches by name; a task's pin keeps its command name).

The page says, always, under the choices: "The gateway also applies a task's own skill overrides, which this page doesn't read. Learned skills bypass this filter. Gateway eligibility and skill settings still apply. This filter does not restrict which files the bot's commands can read." (research §6, source and the gateway's own warning). The filter is a base filter: a task's own override can enable a skill it excludes or disable one it includes (`agent-filter-CQpUx-We.mjs` lines 22-39, source), so the page never says what the bot is given.

**Save** (admin): a write of section 2: one `config.patch` with the `baseHash` the page read and `replacePaths: ["agents.entries.<id>.skills"]` (the gateway refuses to shorten a list without it; research §6), then `config.get`:

The choices and checkboxes are disabled while the save is pending. The outcome compares the receipt with the read:

| Outcome                                                                     | What the page shows                                                                                                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved, and the read agrees                                                  | "Saved. Reading again, the configured filter is <value>. It applies from each task's next turn; a turn running now keeps the skills it started with."    |
| Answered, the read differs                                                  | "The gateway answered the request. Reading again found <value>." The submitted choice stays selected                                                     |
| Refused (the gateway's "config changed since last load", or another reason) | "The gateway refused this request. Its answer: <message> Reading again, the configured filter is <value>."                                               |
| No answer                                                                   | "Couldn't tell whether it was saved. Reading again, the configured filter is <value>." The submitted choice stays selected when the read doesn't show it |
| The read fails                                                              | "Couldn't read the settings again. The filter shown is from the earlier read; your choice is still selected." after what the receipt said                |

<value> is the configured value in words: "not set, so the gateway's default applies", "an empty list" or "only github, tmux".

The write does not restart the gateway and does not stop a run (research §6); the page does not warn of either. Below admin the choices are shown disabled with the access bar.

What the page never uses: `skills.status`'s `blockedByAllowlist`, which did not reflect the filter (research §6).

### 10.2 What <Bot> learned

From `skills.workshop.list {agentId}` and `skills.workshop.changes {agentId, limit: 50}`, both readable at every tier.

A sentence: "Skills saved for <Bot> on the gateway, by <Bot> or by the gateway's review. They bypass the filter above; the gateway still gives one only when what it needs is there." Then the rows: the learned skill's name (mono), its description, and one line from its newest change in the feed, naming its actor as the gateway records it:

| Change                              | The line                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `actor: "agent"`, with `sessionKey` | "Saved by <Bot> in <task's title>, 2:58 PM" (the task's title from the rail; "in a task" when it isn't loaded) |
| `actor: "agent"`, without one       | "Saved by <Bot>, 2:58 PM"                                                                                      |
| `actor: "review"`                   | "Saved by the gateway's review, 2:10 PM"                                                                       |
| `actor: "user"`                     | "Restored by a person, 3:10 PM" or "Archived by a person"                                                      |
| None found in the feed's last 50    | "When it was saved isn't in the gateway's recent changes."                                                     |

A row opens the learned skill read-only (`skills.workshop.read {name}`): the content sentence, its text as text, its files' names, and its changes, with "Clawtrate can read learned instructions here. Editing them is unavailable." No operator method edits a learned skill (research §7).

**Archive** (admin), on its page: a confirmation, "Archive trail-checklist? The gateway will move this learned skill into its archive. You can restore it later.", then a write of section 2, captured with its bot, skill and action: `skills.workshop.archive {agentId, name, reason}`, "Archiving…", then a read of `skills.workshop.list` for that bot, whose `live` and archived versions for that skill decide the line: "Reading again, trail-checklist is archived." or "Reading again, trail-checklist is live for Juniper." A refusal shows the gateway's reply and what the read found, apart; no answer or a failed read uses section 2's words ("Couldn't tell whether the change reached the gateway.", "Couldn't read Juniper's learned skills again."). The result stays in the original bot's view. Archive and Restore are disabled offline or while one is pending, and the same conditions are checked when the request would be sent.

**Saved versions** (the list's `archived`) is a group below the live ones. The workshop can keep snapshots before it changes or archives a skill, so a live skill can have a row too (`library-ByFEjAOZ.mjs` lines 267-280, 333-351, 376-402). Each row: the name, "Live" or "Archived" from `live`, and each snapshot labelled by its actual action: only an archive snapshot says "Archived <time>"; a patch's says "Kept before a patch, <time>", a file write's "Kept before a file was written, <time>", a restore's "Kept before a restore, <time>". An archived row has "Restore latest saved version" (admin): `skills.workshop.restore {agentId, name}`, without `versionId`, which reads back the same way. With no live rows and saved versions, the list says "No live learned skills."

The gateway's own setting is shown as a fact, "Learning on its own: On" from `list.mode`, with "The gateway's documentation says background review can save or update skills and archive idle ones. This page shows up to 50 recent changes." (research §7, source). Nothing here starts or stops it.

Below admin, archive and restore are absent and the access bar says "**Admin access needed.** Archiving a skill <Bot> learned needs admin access."

Empty: "Nothing learned yet. When a skill is saved for <Bot>, it shows here."

## 11. Learned skills and the library

The two kinds live apart on the gateway, and the screens keep them apart: a library skill is a profile's, has revisions, and reaches a bot only through a task that has it; a learned skill is the bot's and bypasses the bot's filter. The workshop can keep snapshots before it changes or archives a skill. A library skill is never shown in a bot's learned list, and a learned one never in the library.

## 12. Saving a process from chat

A bot saves a skill with its `skill_workshop` tool. The tool's form is chosen for each run, and the connection's tier alone does not decide it (research §8): a run that has personal authoring (an attributed person's message on a connection with a durable profile) gets the library form; a run without it gets the learned-workshop form; an admin on a single-profile gateway gets both, and a call without `target: "personal"` goes to the workshop. The tool's own instructions say a library save is made only when the person asks for it. The design does not guess where a call went: each card says only what its arguments and its result show.

The call is an action card (`conversation.md` §7), in the family of the others, with the conversation's Readable and Raw tabs (§8.6, §9) on every card, and its pending and general states (§7.3, §8.3) for a call that has no result yet or a result this adapter doesn't know. Each card names only the tool's recorded result: its action, its `state`, the entry's flags and revision as the result carries them (`openclaw-tools-DV-z1IAc.mjs` lines 13793-13875).

| The call and its result                                                                                                     | The card says                                                                                                                                                                                                                     | Opened                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`, result `state: "published"`                                                                                       | "Saved a skill · trail-checklist", "Saved to your library" when the receipt's `entry.ownerProfileId` is the library list's `profileId`; "Saved to the team library" for `target: "team"`; otherwise "Saved to a personal library" | the name; "Use when…" and "Submitted instructions" only when the arguments carry `proposal_content`; the recorded result revision; "Open in Skills"; Raw |
| `update`, result `state: "published"`                                                                                       | "Updated a skill", with the same destination words                                                                                                                                                                                | the same; an update that carries only `files` shows no instructions                                                                                      |
| `create` or `update`, result `state: "unchanged"`                                                                           | "Skill unchanged", "Unchanged": not a save in this call                                                                                                                                                                           | the same; no "Open in Skills" line                                                                                                                       |
| `create` with `content`, result "Created …"                                                                                 | "Learned a skill · trail-checklist", "Learned"                                                                                                                                                                                    | the name, "Use when…" and "Submitted instructions" from the call's content; the gateway's answer; "Open in <Bot>'s skills"; Raw                          |
| `share` with `entry.shared: true`, `unshare` with `entry.shared: false`, both `published`; `remove` with `state: "removed"` | "Shared a skill", "Stopped sharing a skill", "Removed a skill"                                                                                                                                                                    | "The tool's recorded result": "Shared on this gateway", "Not shared" or "Removed from the library", and the result revision; Raw                         |
| A successful `list`, `read` or `view`                                                                                       | "Looked at skills"; for `list`, "Listed N skills." and, when `omitted > 0`, "M omitted."                                                                                                                                          | Raw                                                                                                                                                      |
| A result with `isError`                                                                                                     | "Skill action failed" for `share`, `unshare`, `remove`, `archive` or `restore`; "Couldn't look at skills" for `list`, `read` or `view`; otherwise "Couldn't save a skill"; "Failed"                                               | the gateway's text, as text; Raw                                                                                                                         |
| No result yet; a result none of these rows matches                                                                          | The general card: "Using skill workshop", then "Used skill workshop"                                                                                                                                                              | Raw                                                                                                                                                      |

Under a "Saved a skill" or "Updated a skill" card, a line keyed by the recorded `entry.skillId` and the task the card is in, drawn after reading that task's skills (`skills.library.list {sessionKey}`) and from the connection's tier now. Section 9's rules for a task write apply: the request names the revision, the result is said from the next read of that task, and only that task shows it.

| This task, as read                                               | The line                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Has the skill                                                    | "This task has it, revision R."                                                                                                                                                                                                                                                                  |
| Doesn't have it; `session.attachable` offers the card's revision | "This task doesn't have it: a skill saved during a task isn't added to that task." with "Use in this task" (`activate {sessionKey, action: "attach", skillId, revision}` with the card's revision: "Attaching…", then "Attached: reading the task again, it has revision R from its next turn.") |
| Doesn't have it; the library offers another revision now         | The same, then "The library now offers revision R." with "Attach current revision", which sends R                                                                                                                                                                                                |
| Doesn't have it; read-only                                       | "This task doesn't have it. Attaching it needs write access." No button                                                                                                                                                                                                                          |
| Doesn't have it; the task has 64 library skills                  | "This task already has 64 library skills. Detach one to make room."                                                                                                                                                                                                                              |
| Not in the library now, or not attachable                        | "It isn't in your library now, so it can't be attached here."                                                                                                                                                                                                                                    |
| The task's read failed                                           | "Couldn't read this task's skills." No button                                                                                                                                                                                                                                                    |
| After an attach                                                  | The gateway's refusal and "Reading the task again, it doesn't have it."; "The gateway returned revision A. Reading the task again, it has revision R." when they differ; "Couldn't read this task's skills again." when that read fails                                                          |

No approval was asked for any of these calls on the development gateway's tool policy (research §8). A person who wants one can set a rule with the rules plugin (`controls.md`); this document adds no rule of its own.

**The composer** (#18 owns it, and nothing here changes it). `docs/decisions.md` decides its "/" menu: the bot's skills a person may run, from `skills.status` `userInvocable` and `eligible`, tagged Skill. A library skill a task has appears there only when `skills.status {agentId, sessionKey}` marks it both; one whose frontmatter says `user-invocable: false`, or whose needs aren't met, doesn't (research §8). When it does, it is listed by its command name (`/s_lake_loop_…`); typed, the gateway tells the model "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:" and names it. The "+" menu gains nothing from this design.

## 13. Phone, themes, read-only, keyboard

- **Phone (390).** Settings is a sheet with its list first (`bots.md` §7); Skills replaces it with Back. A skill's page is one column: the comparison stacks, the gateway's version first, each with its heading. The editor is at least 10 lines and the foot's buttons wrap, Save first. Rows are 64 px. A 63-character name, a long "Use when…" and a file's facts wrap; nothing is cut off.
- **1100 and 800.** The Settings dialog keeps its width rules (`bots.md` §2); the comparison is one column whenever it is narrower than 760 px, which it is in the Settings dialog at 1100 and below.
- **Themes.** Only tokens; the tags carry words, so they read in both themes without colour.
- **Read-only.** Every value is there as wrapping text; nothing that would be refused is offered; one access bar per page.
- **Keyboard and screen readers.** The rows are buttons in document order; a page's title takes focus when it opens; Back returns focus to the row that opened the page; radio groups have one tab stop and keep focus on the chosen radio as arrows move it; the editor's count is announced only when it crosses the limit; every tag is inside its row's accessible name ("trail-checklist, Use when planning a weekend walk, shared").

## 14. What the gateway's facts drive

Every row was run on a development gateway (research, the section named) unless it says source.

| Shown                                                | Driven by                                                                                                                                                                                                                                                                                                                                                   | Research     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| The library, its groups and tags                     | `skills.library.list {scope: "all"}` (read): `entries[{skillId, slug, name, description, ownerLabel, ownerProfileId, shared, enabled, revision, updatedAt, canEdit}]`, `profileId`; the catalog leaves out removed entries and, below admin, others' unshared ones                                                                                          | §1, §2       |
| No personal library                                  | `profileId: null`; writes refused `IDENTITY_REQUIRED`; whether a connection has a profile depends on its authentication path                                                                                                                                                                                                                                | §1 (source)  |
| A skill's page, its other settings, files, Needs     | `skills.library.read {skillId}` (read): `{entry, revisions, content, files[{path, content, encoding, executable}]}`; the frontmatter's other lines and `metadata.openclaw.requires`                                                                                                                                                                         | §3, §9       |
| Save keeps every unedited part                       | The frontmatter's other lines decide `userInvocable` and needs; a save that dropped them changed `userInvocable` from false to true; one that kept them kept both; `retainFiles` from the same base keeps files                                                                                                                                             | §3           |
| Save and its outcomes                                | `skills.library.save` (write): `state` `published` or `unchanged`; `details.code` `SKILL_LIBRARY_CONFLICT` with `currentRevision`, `SKILL_LIBRARY_NOT_FOUND` (which alone doesn't establish a removal), `SKILL_LIBRARY_NAME_CONFLICT`; schema refusals; `UNAVAILABLE` for a literal key, among other causes; a creation's receipt names its `entry.skillId` | §3           |
| A read doesn't prove which write                     | With a lost answer and another save after it, the read showed the later revision while the first was still in the history                                                                                                                                                                                                                                   | §3 (source)  |
| Their version stays                                  | A readable library entry exposes its saved revisions. A task-authorized read must name the exact held revision.                                                                                                                                                                                                                                             | §3           |
| Name fixed in Clawtrate                              | The command name a filter uses is made from the slug and the id                                                                                                                                                                                                                                                                                             | §3, §6       |
| Include in defaults for new tasks                    | `mutate {action: "enable" \| "disable"}` (write); seeding only for a person's new task with a profile, not a spawned one, at most 64; a disabled skill stayed out of a new task after a save, and attached explicitly                                                                                                                                       | §4, §5       |
| Remove                                               | `mutate {action: "remove"}`: `state: "removed"`; a stale Remove is refused; tasks keep their pins                                                                                                                                                                                                                                                           | §4, §5       |
| Share, Stop sharing, the team group                  | `mutate {skillId, expectedRevision, action: "share" \| "unshare"}` (write, own skill); the content revision is checked, the flag has no compare-and-set of its own; `list {scope: "team"}`; two opposite writes on one content revision both accepted                                                                                                       | §4, §10      |
| Another profile sees it                              | `seed` includes others' shared, enabled skills; exact pin reads after withdrawal                                                                                                                                                                                                                                                                            | §10 (source) |
| Nothing is live                                      | No event for any library change                                                                                                                                                                                                                                                                                                                             | §4           |
| Skills in this task                                  | `skills.library.list {sessionKey}` (read): `session.selections`, `session.attachable`                                                                                                                                                                                                                                                                       | §5           |
| Removed against unavailable                          | `read {skillId}`: `removed: true` for a removed entry; `INVALID_REQUEST` with `details.code: SKILL_LIBRARY_NOT_FOUND` for one this connection can't read; a failed read is neither                                                                                                                                                                          | §1, §5       |
| Different, not newer                                 | `rollback` can move an entry's revision back                                                                                                                                                                                                                                                                                                                | §4 (source)  |
| Update; disabled with a removed or unavailable skill | `activate {sessionKey, action: "refresh"}` (write): every pin at once, at the revisions current when it arrives; refused when a pin's entry can't be selected; `attach` takes an exact `revision`; at most 64 pins                                                                                                                                          | §5           |
| From the next turn; the running turn keeps its own   | `sessionActivation: "next-turn"`; a turn during a refresh was given the old revision                                                                                                                                                                                                                                                                        | §5           |
| Opening a held revision                              | `read {skillId, revision, sessionKey}`: only that revision                                                                                                                                                                                                                                                                                                  | §5           |
| Not eligible in the gateway's skill status           | `skills.status {agentId, sessionKey}` `eligible: false`, which the status also reports for a disabled skill; the bot was not given it                                                                                                                                                                                                                       | §6, §9       |
| The filter, the default, and nothing computed        | `config.get` `agents.entries.<id>.skills` and `agents.defaults.skills` (read at every tier); with no key the default applies; a task's `toolOverrides.skills` can change it                                                                                                                                                                                 | §6           |
| The filter's three choices                           | `config.patch` (admin) with `baseHash` and `replacePaths`; values each proven with a turn, the inherited `[]` included                                                                                                                                                                                                                                      | §6           |
| No restart; runs continue; the next turn             | `requiresRestart: false`; a run in progress ended `final`; an existing task's next turn followed the filter                                                                                                                                                                                                                                                 | §6           |
| Someone else changed the settings                    | "config changed since last load; re-run config.get and retry"                                                                                                                                                                                                                                                                                               | §6           |
| Learned skills bypass the filter                     | `isSkillEntrySelected` passes workshop skills, and other gates still apply; a turn under `[]` was given one                                                                                                                                                                                                                                                 | §6           |
| What a bot learned, and its actor                    | `skills.workshop.list` and `changes` (read): `actor` (`agent`, `review`, `user`), `sessionKey`, `runId`, `createdAtMs`, `summary`                                                                                                                                                                                                                           | §7           |
| Archive and Restore, Saved versions                  | `skills.workshop.archive`, `restore` (admin); `archived[{name, live, versions}]`                                                                                                                                                                                                                                                                            | §7           |
| Learning on its own                                  | `list.mode`; the gateway's documentation                                                                                                                                                                                                                                                                                                                    | §7 (source)  |
| The card                                             | The `agent` `tool` stream, start `{name: "skill_workshop", args}` and result; the history's `toolCall` and `toolResult`; the result's `state` and `target`, or the workshop's "Created …"                                                                                                                                                                   | §8           |
| Which form the bot had                               | Chosen per run by personal authoring and the library's default target, not by the connection's tier alone                                                                                                                                                                                                                                                   | §8           |
| No approval                                          | None raised, on the development gateway's tool policy                                                                                                                                                                                                                                                                                                       | §8           |
| The "/" menu (decided in `docs/decisions.md`)        | `skills.status {agentId, sessionKey}`: a held library skill is offered when `userInvocable` and `eligible`; typed, the gateway names it to the model as an explicitly referenced skill                                                                                                                                                                      | §8           |

## 15. Parity rows

Statuses unchanged, except as the maintainers ruled for F-363 (`todo`, as it was).

The targets are the maintainers' rulings on this design's proposals:

| Row   | Target                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-198 | same; note: a successful personal-library creation appears as a "Saved a skill" card. The existing task needs an explicit attach to hold the new skill.                              |
| F-199 | same; note: the library's default-selection setting, a task's pinned revisions and a bot's configured skill filter are separate. Changing the bot's filter needs admin access.       |
| F-361 | same; note: a task that already holds the skill keeps its pinned revision until updated. An update applies from that task's next turn.                                               |
| F-362 | same; note: "Remove skill" takes the skill out of the library. Tasks that hold it keep their pinned revisions. Learned workshop skills are archived and restored with admin access.  |
| F-363 | better: a person can share a skill they own with eligible profiles on this gateway from its page ("Share on this gateway", "Stop sharing"). Sharing provides no public link or sync. |

The gateway dependency cells state the facts of section 14, each marked live or source as the research found it. F-361's name field stays in its target; this version keeps a skill's name fixed once it is made in Clawtrate, and renaming is deferred (section 17).

## 16. For builders

### What each part uses

| Part                | Reads                                                                                                                                                                                                               | Writes                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Settings, Skills    | `skills.library.list {scope: "all"}`                                                                                                                                                                                | —                                                                                                                          |
| A skill's page      | `skills.library.read`, `list {scope: "team"}`                                                                                                                                                                       | `save`, `mutate` (`enable`, `disable`, `share`, `unshare`, `remove`), each with the required `expectedRevision`            |
| Skills in this task | `skills.library.list {sessionKey}`, `read {skillId}`, `read {…, sessionKey}`, `config.get`, `skills.status {agentId, sessionKey}`                                                                                   | `activate` (`attach` with `skillId` and `revision`, `detach` with `skillId`, `refresh`)                                    |
| A bot's skills      | `config.get`, `skills.library.list`, `skills.status {agentId}`, `skills.workshop.list`, `changes`, `read`                                                                                                           | `config.patch`; `skills.workshop.archive`, `restore`                                                                       |
| The card            | The `agent` `tool` stream and `chat.history`, through the parent card's Readable and Raw tabs and its reconciliation of history from other devices (`conversation.md` §7 to §9); `skills.library.list {sessionKey}` | `activate {sessionKey, action: "attach", skillId, revision}` with the recorded `entry.skillId` and the task the card is in |

### What the engine supplies

- A `skills` store in `packages/core`: the list, per task selections and attachable entries, read on the triggers above. No polling and no event subscription: there is no event (research §4). `config.changed` (every tier) triggers a read of a bot's filter.
- `editSkillMarkdown(read, {description, body})`: the read `SKILL.md` bytes with only the changed spans replaced (the description scalar when it changed, the body when it changed), or `null` when the read has no editable, unambiguous scalar span or doesn't parse back exactly (section 4). Tested against the gateway's frontmatter parser for every case in research §3, a description with `: ` and `#` among them, and for comments, quoting and line endings kept as read. A body-only save's test asserts the original description field bytes as well as the other settings and every file.
- One write helper for every write of section 2: it captures the request, exposes the pending state, waits for the answer or its absence, reads the subject again, and returns `{answer, read}`; it never retries by itself.
- `saveSkill` that sends the edited `SKILL.md` and `retainFiles` for every file of the base revision; after a conflict, the base is the gateway's current revision.
- The conflict path as data: `{mine, theirs: {revision, description, body, otherSettings, files, savedAt}}`, kept until the person chooses.
- A kind in the action card table for `skill_workshop`, with the result adapter of section 12, reading the action, `state`, `target`, `entry` (its `skillId`, `ownerProfileId`, `shared` and `revision`), `entries` and `omitted`, and `isError` from the call and its result; anything else falls to the parent card's general and pending states.
- The filter writer: `config.patch` with `baseHash` and `replacePaths`, then `config.get`.

### Order

1. The library read and a skill's page, read-only (F-199, F-361 at read tier).
2. Save with its outcomes and the conflict path (F-361).
3. Remove and the defaults switch (F-362, F-199).
4. Skills in this task (F-199, F-361's note).
5. The card (F-198). This step's check needs a bot that calls `skill_workshop`: it lands `#learn` and `#learn-workshop` from `docs/research/skills/scripted-model.patch` in `tools/dev-gateway`, with their own unit tests and scenario checks, on an instance that offers the tool (research §8 names the two config changes).
6. A bot's filter, then its learned skills (F-199, F-362's note). The filter's check needs to see what a turn was given: it lands `#skills` from the same patch the same way.
7. Sharing (F-363).

Steps 1 to 4 and 7 need none of the patch's directives.

### Prototype states

`prototype/skills.html` takes every parameter `bots.html` takes, and these:

| Parameter                                           | Values                                                                                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open=settings&section=skills`                      | The Skills section                                                                                                                                                                                                                |
| `skill`                                             | A skill's page by id (`trail`, `kitchen`, `weather` with other settings, `notes` that can't be round-tripped, `ridge` team, `river` someone else's shared, `long` with `longname=1`), or `new`                                    |
| `lib`                                               | `loading`, `error`, `empty`, `noprofile`, `many`                                                                                                                                                                                  |
| `save`                                              | How the next save ends: `conflict`, `removed`, `refused`, `silent`, `lost`, `lostnot`, `superseded`, `readfail`, `unchanged`, `taken`                                                                                             |
| `remove`, `share`                                   | `remove=conflict` or `lost`; `share=raced`                                                                                                                                                                                        |
| `multi`, `longname`, `big`                          | `multi=1`: another person's shared skill; `longname=1`: a 63-character name; `big=1` with `skill=new`: instructions over the byte limit                                                                                           |
| `banner=offline`                                    | The connection is down                                                                                                                                                                                                            |
| `panel=open&tab=details` with `bot=juniper&task=j1` | Skills in this task; `pins=outdated`, `removed`, `unavailable` (with `access=write`), `entryfail`, `full`, `every`, `none`, `error`; `taskw=refused`, `lost` or `readfail`; `running=1`; `bot=pip&task=p1` for another bot's task |
| `tab=settings&bview=skills`                         | A bot's skills; `list=only`, `none`, `unknown`; `defaults=none`, `only`; `learned=empty`, `archived`; `cfg=conflict`, `refused`, `lost`, `differs`, `readfail`                                                                    |
| `task=jlearn` (bot Juniper)                         | The task with the `skill_workshop` cards; `cardw=refused`                                                                                                                                                                         |
| `access`                                            | `read`, `write`, `admin`, as in `bots.html`                                                                                                                                                                                       |
| `answer`                                            | Milliseconds before a write's answer arrives (300 when absent); the read follows 300 ms later                                                                                                                                     |

The check `prototype/tools/checks/skills.mjs` clicks through every outcome above and asserts each state's words, at 1440, 1100, 800 and 390.

## 17. Not covered here

- **Skills from outside this gateway.** A public catalog (`skills.library.import` from ClawHub, `skills.search`, `skills.detail`) makes the gateway contact an outside host. This design has no screen for it and makes no request to any host but the person's gateway.
- **Teach a task**, recording a demonstration (#75).
- **The composer's menus** (#18): only what a skill looks like there is said, in section 12; how a generated command name is displayed is #18's.
- **Renaming a skill**, which the gateway's save allows; deferred in this version (section 4).
- **Editing a skill's files or other settings**, uploading a skill as a zip (`skills.library.upload`), and choosing an earlier revision as the current one (`mutate {action: "rollback"}`), which the gateway offers.
- **Transfer to team ownership** (`mutate {action: "transfer"}`, admin): it can't be undone by its owner (research §4), and no row asks for it.
- **A task's own skill overrides** (`toolOverrides.skills`), which the gateway applies and Clawtrate doesn't read.
- **Installed and bundled skills' own settings** (`skills.update`, `skills.install`, `skills.entries.<key>` keys and values), which are admin configuration of the gateway, and where a key would be typed. This design never shows or asks for a key.
- **What a bot was given or used in a turn**: no read establishes it in advance, and the gateway records no use.
- **Who saw a shared skill**, which the gateway does not record.
