# Group chats

How a person talks to two to six bots in one place: making a group, how it shows in the list, who answers a message, what happens while several bots work, approvals, and where the group is kept. This part follows `visual-language.md`, `conversation.md`, `bots.md`, `work-pane.md`, `controls.md` and `setup.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-029, F-077 to F-080, F-179 and F-288 to F-290. What the gateway does is in `docs/research/group-chats.md`; every state below names the fact it rests on, and section 14 lists them. Section 16 is for builders.

The gateway has no conversation shared by several bots (research §1). So one rule sits above the rest: **a group is one task per bot, shown together, and the screen never says the bots are in one conversation.** Each bot sees only what the person sends it. It does not see what the other bots said, and the group says so where a person starts writing. Everything a group shows is something one of its tasks reported; everything it sends is an ordinary message to one bot's task.

The prototype shows all of it: `prototype/groups.html` is the app with groups added, and its address picks any state (section 16). The styles are in `prototype/css/groups.css` and the behaviour in `prototype/js/groups.js`. `prototype/tools/checks/groups.mjs` checks it.

## Contents

1. How the pieces fit
2. Shared rules
3. What a group is, said on the screen
4. New group
5. The group in the list
6. The group's conversation
7. Who answers
8. While several bots work
9. Approvals and questions
10. Group details: name, members, removing
11. A member that is gone or archived
12. Other devices, read-only, offline
13. Phone, themes, keyboard and screen readers
14. What the gateway's facts drive
15. Parity rows
16. For builders
17. Not covered here

## 1. How the pieces fit

```
rail                     bots and groups in one list, by recent activity (F-029)
  group row                combined avatar, name, time; "Otto: Done. The old cache…" (section 5)
  bot row                  as conversation.md §20; a member task sits in its bot's task list too
"+" menu                 New task, New bot, New group (section 4)
group conversation       one column, every member's task merged by the gateway's time (section 6)
  header                   the title pill: combined avatar and the group's name; opens Group details
  first line               "Each bot sees only what you send it…" (section 3)
  your message             once, with one line saying where it went (section 6)
  each reply               the bot's name over it, its avatar at the foot (F-078)
  status lines             one per member that is working, in member order (section 8)
  composer                 the To line, @ mentions, Reply and Quote (section 7); Stop stops every member's run
Group details            name, members and their tasks, add, remove, remove the group (section 10)
```

A group is a record kept with the person's preferences on the gateway (section 10), naming two to six tasks, one per bot. The tasks are ordinary tasks: each is also in its own bot's task list, and opening it there shows that bot's side alone, which is exactly what that bot has seen.

## 2. Shared rules

### Components used

| Component                                      | From                                                                        | Used for                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| The rail, bot rows, task rows, the title pill  | `visual-language.md` §7, `conversation.md` §20                              | The group row, its member tasks under each bot |
| Bubbles, captions, the stamp                   | `visual-language.md` §8, `conversation.md` §6                               | The merged transcript                          |
| The status line, state marks, the state avatar | `conversation.md` §2, §4, §5                                                | One line per working member                    |
| The composer, its shelf, Stop                  | `conversation.md` §15, §16                                                  | The group's composer, with the To line added   |
| Approval and question cards, the Messaged card | `conversation.md` §10, §12, §13                                             | Unchanged, placed in the merged transcript     |
| The access bar                                 | `conversation.md` §3                                                        | The read tier                                  |
| `.menu`                                        | `visual-language.md` §7                                                     | The mention list, a bubble's menu              |
| Dialog, dialog head, choice list, note, result | `bots.md` §2 (`.b-dialog`, `.b-head`, `.b-choices`, `.b-note`, `.b-result`) | New group, Group details, confirmations        |

### New components

Each is defined once, in `prototype/css/groups.css`, from existing tokens. No colour token is added.

| Component                      | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined avatar (`.g-stack`)   | The members' characters in one 40 px square (44 on touch): two side by side at 26 px, overlapping 6 px; three in a triangle at 22 px; four or more as a 2 × 2 grid at 19 px, the fourth cell "+2" (12/600, `--text-muted` on `--bg-selected`) when there are more than four. Each character has a 1.5 px ring in the surface colour so they read apart. It carries the group's state badge like a bot avatar (`conversation.md` §4): the most urgent state among its members. |
| Speaker line (`.g-speaker`)    | 12/500 `--text-muted` over a bot's first bubble of a run of bubbles: the bot's name. The bot's avatar at 22 px sits at the foot of its last bubble of that run, left of it.                                                                                                                                                                                                                                                                                                   |
| Where-it-went line (`.g-went`) | A 12 px caption under your bubble, right-aligned, listing each target and its state in words (section 6).                                                                                                                                                                                                                                                                                                                                                                     |
| To line (`.g-to`)              | A 32 px band at the top of the composer pill: "To" in `--text-faint`, then one chip per target (the bot's avatar at 18 px and its name, or "Everyone"). Chips are text, not buttons: what decides the targets is the text and the reply, and a chip only shows it.                                                                                                                                                                                                            |
| Mention list (`.g-mentions`)   | A `.menu` that opens upward from the caret when the person types `@` in a group: "Everyone" first, then each member with its avatar, in member order.                                                                                                                                                                                                                                                                                                                         |
| Reply strip (`.g-replying`)    | A 40 px shelf row: "Replying to Juniper", the first line of the message in `--text-muted`, and a round Cancel.                                                                                                                                                                                                                                                                                                                                                                |

### Tokens

None added. The group uses `--bubble-user` in its neutral form for your bubbles (section 6) and the bot characters' own colours only inside their pictures.

### Access

Reading a group needs only read: the record is read with `users.prefs.get` and every member's task with `chat.history` and `sessions.messages.subscribe` (`operator.read`, section 14). Making, renaming, changing or removing a group, and sending in one, need the interactive tier (`operator.write`), requested as `conversation.md` §3 requests it, never silently. Restoring an archived member task is `sessions.patch` at write. Nothing in this design needs admin.

### Announcements

One polite live region: "Making the group", "Made the group", "Couldn't make Marlow's task", "Saved the name", "Removed Marlow from the group", "Removed the group", "Sent to Juniper, Otto and Marlow", "Couldn't stop Otto", "Stopping 2 bots", "Stopped", and the conversation's own lifecycle phrases with the bot's name ("Otto is working", "Otto finished").

### Input

Dialogs follow `bots.md` §2: modal, Escape closes, focus returns to what opened them. ⌘⇧N opens New group where "+" offers it. In a group's composer `@` opens the mention list; Up and Down move, Enter inserts, Escape closes it and leaves the `@` typed.

## 3. What a group is, said on the screen

The gateway keeps no shared conversation, and no bot is told what the others said (research §1, §4). The product does not pass replies from one bot to another: doing so would send messages in the person's name that the person did not write, make every reply a turn for every other bot, and need a bound that only this one device would know (research §4). So the claim is the small one, said where the person writes:

- **The first line of every group**, above its first message, 13 px `--text-muted`: "Each bot sees only what you send it. Juniper, Otto and Marlow don't see each other's replies."
- **The empty group** says the same under its name, then "Write to everyone, or start with @ to choose who answers."
- **Group details** repeats it under Members: "Each member has its own task with you. Opening it shows what that bot has seen."

A person who wants one bot to read another's answer quotes it (section 7). What the bot then receives is the person's own message, as written.

## 4. New group

"+" offers "New group" (⌘⇧N) after "New bot". It opens a dialog, 440 px, titled "New group". (F-077)

**Choosing.** A "To:" field with a choice list of the gateway's bots under it, each with its avatar and name; choosing one adds a chip to the field and checks its row. Typing narrows the list. Below the list: the name the group will have, "Name: Robin, Juniper and Otto", built from the person's own name from `users.self` (`operator.read`) and the chosen bots in the order chosen, and "You can rename it later." With no display name on the profile it starts with "You". Then the note, `.b-note` neutral: "Clawtrate makes a new task with each bot and keeps the group with your preferences on the gateway, so your other devices show it."

| State                 | It shows                                                                                                                               | Create                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Fewer than two chosen | "Choose 2 to 6 bots." under the field                                                                                                  | Disabled                                            |
| Two to six            | The name line                                                                                                                          | "Create" (primary)                                  |
| Six chosen            | Every other row disabled, with "A group has at most 6 bots."                                                                           | Enabled                                             |
| Making                | One row per member, in order: the avatar, "Making Juniper's task…", then "Juniper's task made" with a check; last, "Saving the group…" | Hidden; "Cancel" is not offered while a call is out |
| Made                  | The dialog closes; the group opens, empty (section 6); the rail shows its row; "Made the group" is announced                           |                                                     |

**What "made" means.** Each member's task is one `sessions.create {agentId}` (`operator.write`), made without a label, because a label must be unique per bot and a second group with the same name and bot would be refused (research §3). Then the record is written with `users.prefs.set`, as "must be absent" (`expectedEntries: {key: null}`), and read back with `users.prefs.get`. The group is shown only when the read-back holds it. A task made is announced only when its `sessions.create` returned a key.

**When a step fails**, the dialog stays and says exactly what exists:

| Failure                           | It shows                                                                                                                                                                                                                 | Actions                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| One or more tasks not made        | `.b-note` `--danger-soft`: "Made tasks for Juniper and Otto. Couldn't make one for Marlow." then the gateway's words: "The gateway answered: Unknown agent id "marlow"."                                                 | "Try Marlow again"; "Make it without Marlow" when at least two were made; "Cancel" |
| Cancel after a partial make       | The dialog closes. A note on the stage: "No group was made. Juniper's and Otto's new tasks stay in their lists, empty."                                                                                                  |                                                                                    |
| The record not saved              | `--danger-soft`: "Made tasks for Juniper, Otto and Marlow, but couldn't save the group." and the reason                                                                                                                  | "Try again" (writes the record again), "Cancel" (the same note as above)           |
| The read-back doesn't hold it     | "Couldn't confirm the group was saved."                                                                                                                                                                                  | "Check again"                                                                      |
| The person's preferences are full | "The gateway keeps at most 128 preferences for you, and it has no room for another group. Remove a group to make one." from `USER_PREFS_LIMIT_EXCEEDED`                                                                  | "Cancel"                                                                           |
| No preferences on this connection | Before anything is chosen: "This connection can't keep preferences on the gateway, so it can't keep a group." from `users.prefs.get` answering `no_durable_identity`; "New group" stays in "+" so the reason can be read | "Close"                                                                            |

Clawtrate never deletes the empty tasks by itself; they are ordinary tasks the person can archive like any other.

## 5. The group in the list

Groups sit in the rail's list with the bots, in the same order (recent activity, then the person's own order), and never in a section of their own. (F-029)

**The group row**, the bot row's frame (`conversation.md` §20), with the combined avatar in the avatar's place:

| Part            | Rule                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avatar          | The combined avatar (section 2), its badge the most urgent member state in `conversation.md` §4's order                                                                                                                                                                                                                                         |
| Line one        | The group's name, and the time of the latest activity in any member task                                                                                                                                                                                                                                                                        |
| Line two        | If a member waits for you: "Waiting for you: Otto, approve a command" or "Waiting for you: Otto, a question" in `--warn`. Otherwise, while members work: "Juniper and Otto are working". Otherwise the latest message in any member task, prefixed with its speaker: "Otto: Done. The old cache folder is gone." or "You: Plan Saturday for us" |
| Unread dot      | When any member task other than what is on screen is unread                                                                                                                                                                                                                                                                                     |
| Accessible name | "Weekend plans, group of 3: Juniper, Otto and Marlow, <state>", with ", unread" when the dot shows                                                                                                                                                                                                                                              |

The speaker is the member whose task holds that latest message: known from which task it came from, never from the text.

**A member task under its bot.** The task stays in its bot's task list. Its title is the gateway's (the task has no label), and at its right, before the mark, a 12 px group glyph; its accessible name ends ", in the group Weekend plans". Opening it shows that bot's task alone: your messages to that bot and its replies, with a line at the top, "This task is part of Weekend plans. Only your messages to Otto are here." and "Open the group".

**Its menu** (right-click on the desktop, touch and hold on the phone): "Rename…", "Group details", "Remove group…". (F-288)

## 6. The group's conversation

**The header.** The title pill holds the combined avatar at 22 px and the group's name; it opens Group details (section 10). There is no Work pane for a group: the pane belongs to one bot's task, and each member's is reached from its task.

**What is shown.** Each member's history (`chat.history`) and live events (`sessions.messages.subscribe`, one subscription per member task), merged. (F-078)

**Order.** By the gateway's own `timestamp` on each history row: all member tasks are on one gateway, so this is one clock, the gateway's, and the same order on every device and after a reload (research §2). Rows with the same time keep member order. A reply takes its place when it is complete, at the time the gateway put on it. While it streams, it sits at the foot of the column, under the status lines, in the order its first text arrived, and it moves into its place when it ends. Nothing above the reader moves: the hold of `conversation.md` §18 keeps the reading line.

**Your message, once.** One message to several bots is one `chat.send` per target. Each copy's `idempotencyKey` is `cg:<group>:<send>:<bot>`; the gateway returns it as the run's id and keeps it on the history row as `<key>:user` (research §2). Copies with the same `<send>` are drawn as one bubble, at the earliest copy's time. A copy whose key does not have this form (a message sent from the bot's own task, or from another client) is drawn as its own bubble, its line naming the one task it went to: "Sent to Otto".

**Your bubbles** are right-aligned in the neutral form of `--bubble-user` (`--bg-inverse` with `--text-inverse`), the same as the "Your messages: neutral" choice: a group has no one bot's colour (F-078). A message not yet sent still uses the raised fill (`conversation.md` §6).

**Where it went** (`.g-went`), under your bubble, says each target's state in words. Every word rests on that copy's own answer or events:

| A copy's state | Words                                   | Established by                                                                                                                                                                                                                                                                           |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sending        | "Sending to Otto…"                      | The `chat.send` call is out                                                                                                                                                                                                                                                              |
| Sent           | "Sent to Otto"                          | `chat.send` returned a run id                                                                                                                                                                                                                                                            |
| Steer          | "Steer for Otto"                        | Sent, and the row carries `steerTargetRunId`: the message joined Otto's running turn (research §3; `conversation.md` §6)                                                                                                                                                                 |
| Held           | "Held until you answer Otto"            | Otto's task has a pending question; the client holds the copy (`conversation.md` §15). Nothing went to the gateway                                                                                                                                                                       |
| Queued         | "Queued for Otto"                       | Otto's run was stopping; the client queues the copy (`conversation.md` §15)                                                                                                                                                                                                              |
| Couldn't send  | "Couldn't send to Marlow" in `--danger` | `chat.send` refused; opening the line shows the gateway's words: "Session … is archived. Restore it before starting new work." The group then knows the task's state and shows section 11's line; "Resend to Marlow" is offered in the opened line once Marlow's task can take a message |
| Not sent       | "Not sent to Otto"                      | A held or queued copy after a confirmed Stop (`conversation.md` §16)                                                                                                                                                                                                                     |

Copies in the same state are joined: "Sent to Juniper, Otto and Marlow"; "Sent to Juniper and Otto · Couldn't send to Marlow". The line is a button that opens a short list, one row per target with its state and, for a refusal, the gateway's words. A message is called "Sent" without qualification only when every copy is Sent or Steer.

**Each reply.** Bot bubbles are left-aligned as in a task, with the speaker line over the first bubble of each run of one bot's bubbles and the bot's avatar at the foot of the last (F-078). The speaker's name is in `--text-muted`, not in the bot's colour: several characters' colours fall under 3:1 on the stage (section 15). Action cards, Messaged cards, "Thought" lines and run lines belong to that bot's run and sit under its speaker line exactly as `conversation.md` §7 to §11 draw them. A Messaged card shows where the message went, which is wherever the bot sent it, usually that bot's main task, not the group (research §4).

**The first line and the stamp.** Above the first message: section 3's sentence. Stamps follow the transcript's rule.

**Empty**, right after it is made: the combined avatar at 56 px, the name (20/500), section 3's two sentences, and the composer focused.

## 7. Who answers

The gateway has no "who answers": every member it is sent to answers, in its own task (research §1). So the person chooses, and the composer shows the choice before anything is sent. (F-079)

| The person writes                              | Sent to            | What each receives                                                        |
| ---------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| No mention                                     | Every member       | The text as typed                                                         |
| `@everyone` anywhere                           | Every member       | The text as typed, `@everyone` included                                   |
| `@Otto` (one or more members' names after `@`) | Those members only | The text as typed, the mentions included                                  |
| A reply (below)                                | That bot only      | The text as typed, with the replied-to message given to it by the gateway |

- **A mention is the app's routing.** `chat.send`'s `mentions` name people, not bots, and the gateway refuses them from this client ("Human mentions require a signed-in Control UI chat."). So the app never sends `mentions`; it reads `@<member name>` and `@everyone` from the text itself, matched to the group's members by name at the start of a word, and sends the text unchanged (research §5). Each bot receives exactly what the person typed, which the gateway wraps with the time and the sender as it does any message (research §4). A name that is not a member's is plain text.
- **The To line** shows the targets as soon as the text decides them: "To Everyone" with no mention; "To Otto" with `@Otto`; "To Juniper and Otto" with both. Send's name says the same: "Send to Otto".
- **The mention list** opens on `@`, filtered by what follows; choosing inserts "@Otto " into the text.
- **Reply.** A bot's bubble has "Reply" in its menu (hover shows the menu button; touch and hold on the phone). It shows the reply strip, "Replying to Juniper", and the To line reads "To Juniper": a reply goes only to the bot that wrote the message, with `replyToId` set to that message's id. The gateway finds that message in the bot's own task and gives it to the bot as the message being answered (research §4). Mentions in a reply's text do not add targets; the To line says so: "To Juniper (replying)". Cancel on the strip, or Escape in an empty field, ends the reply.
- **Quote.** A bubble's menu also has "Quote". It puts "> Juniper: " and the first 500 characters of the message, quoted line by line, at the start of the draft, and leaves the targets to the text. The quoted words are then part of the person's message, visible before it is sent, and each bot it goes to receives them as written. This is the only way one bot's words reach another, and it is the person's.
- **No turn-taking.** Every target answers at once in its own task; nothing in the gateway orders them, and the app does not hold one back for another. Replies arrive in any order and take their places by time (section 6).

## 8. While several bots work

Each member's run is the run `conversation.md` describes, in its own task. The group adds only how several are shown together and what one Send or one Stop does to all of them.

**Status lines.** One status line per member with an active run, stacked at the foot in member order, each the component of `conversation.md` §5 with its avatar, its phrase and its time: "Otto · Reading backup-2026-11-15.log 0:12". Each leaves when its run ends. Each still opens its own running card.

**The composer during runs.**

| Members                                  | Placeholder                                                                                          | Controls                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| None running                             | "Message the group"                                                                                  | Send                                            |
| Some running                             | "Message the group"                                                                                  | "Stop 2 bots" (Stop, named for the count), Send |
| A targeted member has a pending question | As above; the shelf row "Otto asked you a question. A message to Otto now is held until you answer." | As above                                        |
| Stopping                                 | "Message the group"                                                                                  | "Stopping…", Send                               |

There is no mode word in a group: each copy goes as a message sent at that moment into that member's task would (`conversation.md` §15). To an idle member it starts a run; into a running one it is a steer; with a pending question in that task it is held; while that member's run is stopping it is queued. The where-it-went line says which, per member (section 6). "Queue after this turn" and "Start as new task" are not offered in a group (section 17).

**Stop** stops every member's active run: one `chat.abort {sessionKey}` per member task with a run (research §6). The status lines read "Stopping…". Then, per `conversation.md` §16, from what each abort answered:

| What the gateway answered | What shows                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every abort confirmed     | The note: "**Stopped.** Juniper and Otto stopped. Completed actions are not undone." with each member's list of helpers and messages as §16 gives it, and each member's run line                                                                                                           |
| One abort failed          | The note for the others, "**Stopped.** Juniper stopped. Completed actions are not undone.", and a shelf notice on `--danger-soft`: "**Couldn't stop Otto.** The gateway didn't answer in time." with "Try again"; Otto's status line returns to its real state and Stop reads "Stop 1 bot" |

§16's other endings (a run that finished before Stop took effect, a run stopped from somewhere else) are worded there and apply to each member's run as they do to one. Held and queued copies of a stopped member become "Not sent to Otto", and its pending cards close as "Cancelled", as §15 and §16 say.

Stopping one member alone is done in that member's own task.

## 9. Approvals and questions

A member's approval or question is the card of `conversation.md` §12 or §13, unchanged in every word and control, placed in the merged transcript under that member's speaker line, at the gateway's time. (F-080)

- **It names the asking bot and its task.** The title names the bot ("Otto wants to run a command"); under the summary, one line: "In Otto's task in this group." The request's `agentId` and `sessionKey` give both (research §9). (F-179)
- **The shelf** reads "Otto needs your approval to run a command", "Review" goes to the oldest pending card in any member task, and the group row's line two reads "Waiting for you: Otto, approve a command" (section 5).
- **What it may grant** is exactly what `conversation.md` §12 and `controls.md` §6 allow, and nothing more: "Allow once", "Always allow…" only when the request offers it, "Deny". For a command, Always allow adds to the asking bot's own allowlist on that machine, and the gateway saved it under that bot alone (research §9), so the form's sentence is §12's: "…so Otto is not asked again for commands it matches." A rules-plugin card offers Allow once and Deny and never Always allow (`controls.md` §6). The card offers no choice of "all bots" and no lifetime of the person's choosing: both were cut from a card by `controls.md` and are listed in section 15. (F-290)
- **Who answers it.** The request is bound to the device whose message started the run; another device of the same person, with the same access, does not receive it and cannot answer it by its id, and an admin connection can (research §9). In a group, the cards of the runs a message started go to the device that sent it. Another device shows section 12's note. (F-289)
- **Questions** are §13's card; a message to that member is held until it is answered, and a message to the others is not (section 8).

## 10. Group details: name, members, removing

The title pill or the row's menu opens **Group details**, a dialog of 440 px (a sheet on the phone).

**Name.** The name (17/500) with "Rename" (desktop) or, on the phone, "Edit" then a name field and "Done" (F-288). Saving writes the whole record with `users.prefs.set` and `expectedEntries` holding the record as last read, then reads it back:

| Outcome                                         | It shows                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saving                                          | The field disabled, "Saving…"                                                                                                                                                  |
| Saved and read back                             | The new name in the pill, the row and the dialog; "Saved the name"                                                                                                             |
| Conflict (the record changed since it was read) | "This group changed on another device. It's now called Saturday." with the record as now read; nothing of this edit is saved; the field keeps the typed name with "Save again" |
| Refused                                         | `--danger-soft`, "Couldn't save the name." and the reason; the old name stays                                                                                                  |
| Empty name                                      | "A group needs a name." and Save disabled                                                                                                                                      |

**Members**, in order, each a row: avatar, name, "Open Otto's task" and, for the interactive tier with more than two members, "Remove". Then section 3's sentence. Then "Add a bot" while there are fewer than six: a choice list of the other bots; adding makes the bot's task (`sessions.create`) and then writes the record, with the same steps and failure words as New group. Member order is the record's order; the earliest added is first.

**Kept where.** One line at the foot: "Kept with your preferences on the gateway. Your other devices show this group." (section 14, rows 9 and 10).

**Removing a member** asks first, `.b-dialog` 380:

> **Remove Marlow from Weekend plans?**
> Marlow's task stays in Marlow's list, with everything in it. Marlow won't get messages sent to this group. Anything Marlow is doing now keeps going.

"Remove" (danger) and "Cancel". Removing rewrites the record without Marlow (compare-and-set, read back). Marlow's earlier messages leave the group's column, since the group no longer shows Marlow's task; they are in Marlow's task. A group of two offers no Remove: "Remove group" is the way.

**Removing the group** asks first:

> **Remove Weekend plans?**
> Juniper's, Otto's and Marlow's tasks stay in their lists, with everything in them. Only the group goes, on all your devices. Nothing running is stopped.

"Remove group" (danger) and "Cancel". It writes `null` for the record and reads back that it is absent. Then the group leaves the rail and the stage shows "Removed Weekend plans. Its three tasks are in Juniper's, Otto's and Marlow's lists." A failure keeps everything and says "Couldn't remove the group." with the reason and "Try again".

## 11. A member that is gone or archived

Before each send the app checks the targets' tasks (`sessions.describe`, read), because a send to a task that no longer exists silently starts a new, empty one under that key (research §3). A member in any of these states is skipped by "Everyone", its chip in the To line is struck through with its reason in the chip's name, and a row in the members list and a line in the column say what is true:

| Found                         | The line                                                                     | Actions                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The member's task is archived | "Marlow's task in this group is archived. Messages to everyone skip Marlow." | "Restore Marlow's task" (`sessions.patch {archived: false}`, write, read back), "Remove Marlow" |
| The member's task was deleted | "Marlow's task in this group was deleted. Messages to everyone skip Marlow." | "Start a new task for Marlow" (`sessions.create`, then the record), "Remove Marlow"             |
| The member bot was deleted    | "Marlow was deleted, with its tasks. Messages to everyone skip Marlow."      | "Remove Marlow"                                                                                 |

A deleted task's or bot's earlier messages are gone from the gateway (research §8); the group's column no longer has them and does not pretend to. A group left with fewer than two members that can be sent to still shows, with these lines, and Send names who it reaches.

## 12. Other devices, read-only, offline

**Another device of the person** shows the same groups: the record is the person's preference, and a change arrives as `users.prefs.changed` (research §7). It shows the same column, in the same order, with each message once (section 6). An approval or question started from another device is not shown there as a card (research §9): the member's status line reads "Waiting for an answer" with the blocked badge, and a note sits above it: "Otto is waiting for an approval. It went to the device that sent this message; answer it there." An admin connection may see and answer it (research §9, from source); this design asks for no admin access for it.

**The read tier** shows every group, its column and its live work; the access bar of `conversation.md` §3 takes the composer's place: "**Read-only.** You can follow this group here. Approvals and questions aren't shown on this connection." with "Request access". "+" has no New group, Group details has no Rename, Add or Remove, and the row's menu has only "Group details". A group made on another device arrives on this one too.

**Offline.** A message written while the connection is down is held by the host, as `conversation.md` §6 holds one: one bubble in the raised fill, "Sends when reconnected", sent once per target when the connection returns, with its where-it-went line then.

**Another person** on the same gateway does not see this person's groups: preferences are per profile (research §7).

## 13. Phone, themes, keyboard and screen readers

- **Phone (390 px)**: the one-pane layout of `visual-language.md` §12. Groups are rows of the list; a group opens full screen with Back. The title pill opens Group details as a sheet, with "Edit" next to the name and "Done" to save (F-288). A bubble's menu is touch and hold. The To line wraps. The combined avatar is 44 px in the list.
- **Widths 1440, 1100 and 800**: the column of `visual-language.md`; at 800 the rail is the narrow one and the group row keeps its combined avatar.
- **Themes**: everything is tokens; the combined avatar's rings are the surface colour of each theme.
- **Keyboard**: the group row is one button with its menu on Shift+F10; the column's bubbles are reached as in a task; a bot bubble's menu button is in the tab order after the bubble; Group details is a modal dialog.
- **Screen readers**: a bot bubble is read with its speaker: "Otto said: …". Your bubble's where-it-went line is part of its name: "You said: Plan Saturday. Sent to Juniper, Otto and Marlow." Status lines are read as in `conversation.md` §5, each with its bot's name.

## 14. What the gateway's facts drive

"Research" is `docs/research/group-chats.md`, by section. Every row there was run on a development instance unless it says source.

| #   | Fact                                                                                                                                                                                                | Drives                                                                             | Evidence                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | No session has two bots; a send naming another bot is refused; `session.members` are people; `sessions.groups` are sidebar folders; broadcast groups are a channel feature with admin configuration | Section 3's sentence; a group is one task per bot                                  | Research §1, live; broadcast groups source |
| 2   | `sessions.create {agentId}` (write) returns one task's key; a label is unique per bot                                                                                                               | New group, Add a bot; tasks made without a label                                   | Research §3, live                          |
| 3   | One `chat.send` per task; each answers with its own run id; runs end in any order                                                                                                                   | One message is one send per target; the where-it-went line                         | Research §2, live                          |
| 4   | History rows carry the gateway's `timestamp`; one gateway, one clock                                                                                                                                | The column's order                                                                 | Research §2, live                          |
| 5   | The run id is the sent `idempotencyKey`; the user row keeps `<key>:user`                                                                                                                            | Your message drawn once, on every device                                           | Research §2, live                          |
| 6   | An archived task refuses a send with the gateway's sentence; a deleted bot refuses with "Unknown agent id"; a send to a key that no longer exists makes a new task                                  | Couldn't send; the check before sending (section 11)                               | Research §3, §8, live                      |
| 7   | A send into a running task joins that run (`steerTargetRunId`)                                                                                                                                      | "Steer for Otto"                                                                   | Research §3, live                          |
| 8   | `mentions` are people and are refused from this client; the text is stored as typed                                                                                                                 | `@` is the app's routing; each bot receives the text as typed                      | Research §5, live                          |
| 9   | `replyToId` resolves in the same task and gives the bot that message                                                                                                                                | Reply goes to the bot that wrote the message only                                  | Research §4, live                          |
| 10  | A bot sees only its own task; `sessions_send` goes where the bot points it                                                                                                                          | Section 3; no relay; Quote                                                         | Research §4, live                          |
| 11  | `chat.abort` per task, each confirmed with its run ids                                                                                                                                              | Stop in a group                                                                    | Research §6, live                          |
| 12  | `users.prefs` (read; write to change): 4,096 bytes a key, 128 keys a person, compare-and-set, `null` deletes, `users.prefs.changed` to the person's other devices, refused at read for a write      | Where the group lives; rename conflicts; removal; read-only sees and cannot change | Research §7, live                          |
| 13  | `users.self` (read) gives the person's display name                                                                                                                                                 | The generated name                                                                 | Research §7, live                          |
| 14  | An archived task keeps its history and is restored with `sessions.patch` at write; a deleted bot's tasks are gone                                                                                   | Section 11                                                                         | Research §8, live                          |
| 15  | An approval names `agentId` and `sessionKey`; it is bound to the device that started the run; admin can see it; Always allow on a command saves under the asking bot                                | Section 9; section 12's note                                                       | Research §9, live; admin source            |

## 15. Parity rows

### Reworded

Only the gateway dependency cells change, each to what the research established. Every target and every status stays as it is.

| Row   | New gateway dependency cell                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-029 | partial: no session holds several bots (research §1). Each member's task is read with `sessions.list`, `chat.history` and `sessions.messages.subscribe` (`operator.read`); the group's name, members and order are a record in `users.prefs` (read; `operator.write` to change), which every device of the person reads, so the combined avatar and the speaker-prefixed preview are drawn by the client from those tasks (`docs/research/group-chats.md` §2, §7). |
| F-077 | partial: no group-create method exists. `sessions.create` (`operator.write`) makes one task per chosen bot, without a label since labels are unique per bot; the client keeps the group as a record in `users.prefs` (`operator.write`), written as must-be-absent and read back, enforces 2 to 6 bots, and takes the person's name from `users.self` (`operator.read`) (`docs/research/group-chats.md` §3, §7).                                                   |
| F-080 | partial: a group is one task per bot (F-077), and shows each member task's approval cards (F-163); the request names the asking bot and its task (`agentId`, `sessionKey`) and is bound to the device whose message started the run (`docs/research/group-chats.md` §9).                                                                                                                                                                                           |
| F-288 | partial: as F-077; the name is in the group's `users.prefs` record, renamed with a compare-and-set write (`operator.write`) and read back; a stale write answers `conflict` (`docs/research/group-chats.md` §7).                                                                                                                                                                                                                                                   |

### Rows for a decision

The design differs from these rows. They are left as written; each needs a decision.

| Row   | The row says                                                                                                                                         | The design does                                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-078 | The bot's name above its reply "in the Bot's color"                                                                                                  | The name in `--text-muted`, the avatar at the foot; your bubbles neutral, as the row says                                                                                 | Several characters' colours (`#f6bd3b`, `#58c26f`, `#45bdf5`) are under 3:1 as 12 px text on the light stage; `visual-language.md` allows text in tokens only                                                                                                                                                                                                                                                               |
| F-079 | "Bots choose who answers"                                                                                                                            | The person chooses: everyone, `@<bot>`, or a reply; no bot chooses                                                                                                        | The gateway has no session in which bots could see each other or decide; its own bounded rounds exist only for channel broadcast groups, set by admin (research §1, §4)                                                                                                                                                                                                                                                     |
| F-179 | The card names "the approver, who is the person whose message started the run"                                                                       | The card names the asking bot and its task; it is answered on the device that sent the message, and another device says where it waits                                    | The gateway binds the request to a device, not a person, and every device here is one person (research §9). Proposed: "better: the group card names the asking Bot and its task; it is answered on the device whose message started the run, and the person's other devices say that it waits there (FC-09)."                                                                                                               |
| F-289 | "Anyone else viewing the group sees the card read-only with 'Waiting for <name>'"                                                                    | Another device sees no card: the status line's "Waiting for an answer" and a note naming the device it went to                                                            | The other device receives no request at all (research §9). Proposed: "better: the person's other devices show that the member waits for an approval and that it went to the device that sent the message; no card and no buttons (FC-09)." Its dependency cell's "no described rule stops another connection holding `operator.approvals` from resolving the card" is now known to be wrong: the reviewer binding stops it. |
| F-290 | "The same Always allow scope and duration choices as in a 1:1 task, and the grant applies only to the asking Bot unless the approver picks all Bots" | The card of `conversation.md` §12 unchanged: Always allow when the request offers it, saved for the asking bot alone; no "all bots", no lifetime of the person's choosing | `controls.md` §6 removed standing permissions with a chosen scope from cards; they are rules made with admin. The asking-bot-only part is met and was verified (research §9).                                                                                                                                                                                                                                               |

## 16. For builders

### What each part uses

| Part                 | Gateway                                                                                                       | Engine                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The group record     | `users.prefs.get` (read), `users.prefs.set` (write) with `expectedEntries`, event `users.prefs.changed`       | A store of groups per gateway, under keys `clawtrate.group.<id>`, value `{v: 1, name, members: [{agentId, sessionKey}]}`; read with the bots; written only by compare-and-set and shown only after a read-back |
| New group, Add a bot | `users.self`, `sessions.create`, then the record                                                              | One sequence with a state per step, so a partial result is reported as it is                                                                                                                                   |
| The column           | `chat.history` and `sessions.messages.subscribe` per member task                                              | A merge by row `timestamp`, member order on a tie; the join of copies by `cg:<group>:<send>:<bot>`; live replies at the foot until final                                                                       |
| Sending              | `sessions.describe` per target, then `chat.send {sessionKey, message, idempotencyKey, replyToId?}` per target | The targets from the text (`@everyone`, `@<member>`), or the reply; each copy through the task's own send operation (`conversation.md` §15), so holds and queues are that task's                               |
| Stop                 | `chat.abort {sessionKey}` per member task with a run                                                          | One result per member                                                                                                                                                                                          |
| Approvals, questions | As `conversation.md` §12, §13, per member task                                                                | Cards tagged with their member, placed by time                                                                                                                                                                 |
| Members gone         | `sessions.describe`, `sessions.patch {archived:false, expectedSessionId}`                                     | The three states of section 11                                                                                                                                                                                 |

### Order

1. The record: read, write by compare-and-set, read back, the change event; a group listed in the rail with its combined avatar, from fixtures.
2. The column, read-only: merge, order, the join of copies, speaker lines, the first line.
3. New group, with every failure of section 4.
4. Sending: targets from text, the To line, the check before sending, the where-it-went line; then Reply and Quote.
5. Several runs: status lines, Stop, held and queued copies.
6. Group details: rename, members, add, remove, remove the group.
7. Approvals and questions in the column; the note on another device.
8. Section 11's member states.

### Prototype states

`prototype/groups.html` takes `theme`, `width`, `motion` and `chrome` like every page, and these:

| Parameter  | Values                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`    | `open` (the default: a group with history), `empty`, `running`, `partial` (Marlow's copy refused, its task archived), `approval`, `question` (Otto asked a question), `other` (another device, Otto waiting), `readonly`, `offline` (with "Reconnect" in the prototype bar), `archived`, `taskgone`, `botgone`, `removed` |
| `bot`      | `otto`: Otto's own task that is part of the group, from Otto's task list                                                                                                                                                                                                                                                  |
| `open`     | `new`, `details`                                                                                                                                                                                                                                                                                                          |
| `pick`     | Bots chosen in New group, for example `pick=juniper,otto`                                                                                                                                                                                                                                                                 |
| `fail`     | `marlow`: Marlow's task is refused once; `record`: the record write fails once; `readback`: the read-back misses the record once; `full`: the preferences are full; `noprefs`: the connection keeps no preferences; `remove`: removing the group fails once                                                               |
| `compose`  | `mention` (the list open), `otto` (a draft to Otto), `reply` (replying to Juniper), `quote`                                                                                                                                                                                                                               |
| `stopfail` | `otto`: the first abort of Otto's run fails                                                                                                                                                                                                                                                                               |
| `conflict` | `1`: the next rename meets a change from another device; `refused`: the gateway refuses it                                                                                                                                                                                                                                |
| `confirm`  | `member` (removing Marlow), `group` (removing the group)                                                                                                                                                                                                                                                                  |
| `view`     | `list`: the phone's list                                                                                                                                                                                                                                                                                                  |

Every walk in the check starts from one of these and is clicked to its outcome: making a group, with a refused task (made without it, tried again, cancelled), a refused record, a missing read-back and full preferences; sending to everyone, to one bot by mention, as a reply and with a quote; a refused copy restored and resent; a copy held by a question and released by the answer; Stop, with and without a failed abort, with a held copy and with a message queued while stopping; each approval decision; renaming, with a conflict, a refusal and on the phone; adding a member, removing one, and removing a deleted bot; restoring an archived task and starting a new one; removing the group, and a removal that fails.

## 17. Not covered here

- Passing replies between bots, automatically or by a bot's own choice. Section 3 says why; a bounded relay would need a decision and a design of its own.
- A group as a channel broadcast group on the gateway, set by admin.
- "Queue after this turn" and "Start as new task" in a group's composer; both stay in each member's own task.
- Stopping one member from the group; it is done in that member's task.
- Attachments to a group message: each copy would carry them, and the 25 MiB limit would be per copy; their chips and limits follow `conversation.md` §15 when designed.
- Search across groups, a group's notifications, and pinning a group.
- Reordering members.
- Groups shared with another person on the same gateway.
- The rules for who may approve when the device that sent the message is gone (research §10).
