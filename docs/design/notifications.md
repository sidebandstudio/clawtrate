# Notifications

When Clawtrate shows a desktop notification, what it says, what clicking it opens, and the settings that decide it: a switch on this computer, a switch for each bot, a setting for each task that wins over the bot's, and quiet hours. This is the seventh part of the design, after `visual-language.md`, `conversation.md`, `bots.md`, `work-pane.md`, `setup.md` and `controls.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-202 to F-204, F-207 and F-367 to F-369. What the gateway, Electron and the app's own code do is in `docs/research/notifications.md`; every state below names the fact it rests on, and section 13 lists them. Section 15 is for builders.

One rule sits above the rest: **a notification says what this device received, and no more.** A device that was sent an approval can say which bot wants to do what, and open the card. A device that only saw the run wait can say that, and offers nothing to answer with. A setting says what was read back after it was saved.

Six facts from the research shape the design:

- **An approval goes only to the device whose message started the run** (research §1, tried). Another device of the same person, at the same access, gets no request and is refused if it tries to answer; it sees only the run's `waiting-approval` phase. That stays true while the sending device is away.
- **A question goes to every device that may answer questions** (research §2, tried), including one raised in another bot's task. A read-only device gets nothing that says a question waits.
- **Every device learns when a run ends**, read-only included and whoever started it, with the reply's text (research §3, tried).
- **The person's preferences on the gateway (`users.prefs`) hold the switches and quiet hours** for every device of theirs, readable at read access and written at the interactive tier, with a compare-and-set and a 4,096-byte value (research §4, tried).
- **Electron cannot tell the app whether notifications are allowed or whether a Focus or Do Not Disturb is on**, offers no lock-screen control, and shows nothing while the app is not running (research §6, documentation). The only answer the system gives is `failed`.
- **Opening reads the task list, never the history**: a deleted task's history answers like an empty new task (research §8, tried).

The prototype walks every path to its outcome: `prototype/notifications.html`, with the state in the address (`prototype/README.md`). Its styles are in `prototype/css/notifications.css`, its behaviour in `prototype/js/notifications.js`, and `prototype/tools/checks/notifications.mjs` clicks through every walk and asserts each state's words and structure. A notification is drawn as Clawtrate's own picture of one, labelled as a picture, never in a system's art.

## Contents

1. How the pieces fit
2. Shared rules: components, where settings are kept, saving, access, input, announcements
3. When a notification is shown
4. What a notification says
5. Opening a notification
6. Quiet hours
7. Settings, Notifications
8. A bot's Notifications page
9. A task's setting
10. What the system decides, and what Clawtrate cannot see
11. Budget warnings
12. Widths, themes, keyboard, screen readers, motion
13. What each fact drives
14. Parity rows
15. For builders
16. Not covered here

## 1. How the pieces fit

```
the gateway's events          a run ends; an approval arrives; a question arrives; a run waits
  the host (main process)       decides, in the order of section 3, and shows or holds
    a system notification         a bot's name and what happened (section 4)
      click                         the window, the bot, the task, the card (section 5)
Settings (⌘,), Notifications  this computer: show, previews, budget warnings
                              yours: quiet hours, a switch for each bot
Work pane, Settings tab       Notifications: one row (bots.md §8), opening the bot's page
  the bot's page                its switch; the tasks with their own setting
Work pane, Details tab        This task: Same as Otto, On or Off
```

The host decides because it holds the gateway connection in Electron's main process (research §7): it sees every event with or without a window, and only it can show a system notification (the session refuses web notifications). The interface tells the host which bot is on screen, as it tells it the badge count today.

## 2. Shared rules

### Components used

| Component                                                                                                     | From                                         | Used for                                                            |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Settings frame, section list, section head and Back                                                           | `bots.md` §2, §7; `settings.md` §3 in review | Settings, Notifications                                             |
| Switch (`.b-switch`), choice list (`.b-choices`), note (`.b-note`), Select (`.b-select`) and its `.menu`      | `bots.md` §2                                 | Every switch, the bot list, notes, a task's setting                 |
| Fact block (`.facts`), group word, the whole-row button with a chevron, a page in the tab with Back and title | `visual-language.md` §9, `bots.md` §8        | The Notifications row, the bot's page, the Details row              |
| The access bar and its request                                                                                | `conversation.md` §3                         | Changing your settings on a read-only connection                    |
| The status strip                                                                                              | `visual-language.md` §11                     | What happened when a notification could not open its task           |
| The approval and question cards, the status line, the turn error, the run's reply                             | `conversation.md` §5, §12, §13, §17          | What a click opens; nothing about them changes                      |
| The note for a wait this device cannot see                                                                    | `conversation.md` §3                         | What the opened task shows on a device that has no card (section 5) |
| The budget line in the task                                                                                   | `controls.md` §17                            | What a budget warning opens                                         |

### New components

One, defined in `prototype/css/notifications.css` from existing tokens:

| Component              | What it is                                                                                                                                                                                                                        | Tokens                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Time pair (`.n-times`) | Two native time fields side by side, "From" and "To", each a 52 px `.b-select`-shaped block with its label (12, faint) over the time (14/500), and under them one line naming the time zone. Below 688 px they stay side by side. | `--bg-bubble`, `--radius-md`, `--text-faint` |

The prototype also draws **a picture of a system notification** (`.n-pic`): a card on `--bg-raised` with a dashed `--border-strong` outline and the label "Picture of a system notification". It is prototype chrome that stands for what the system draws, in no system's style, and it is not product code.

No new tokens.

### Where each setting is kept

| Setting                                            | Kept                                                                                      | Same on the person's other devices |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| Show notifications, Show previews, Budget warnings | This computer: the host's own settings file, as `settings.md` §2 keeps the app's settings | No                                 |
| Quiet hours                                        | `users.prefs`, key `clawtrate.notifications`, field `quiet`                               | Yes                                |
| A bot's switch                                     | `users.prefs`, key `clawtrate.notifications`, field `bots`, by bot id; absent means on    | Yes                                |
| A task's setting                                   | `users.prefs`, key `clawtrate.notifications.tasks`, by task key; absent means Same as bot | Yes                                |

`quiet` has the shape the gateway's own browser push uses (research §5): `{enabled, startMinute, endMinute, timeZone}`, minutes from 0 to 1439 and an IANA zone, so a later phone design can read one value. Clawtrate never writes the gateway's `notifications.web.v1`.

**When the gateway keeps no profile** (`users.prefs` answers `no_durable_identity`, research §4, read from source), the shared settings are kept on this computer instead, and Settings says so (section 7). They are never mixed: a value from the gateway is never copied to the device, or the reverse, without the person changing it.

**Where it is kept, on screen.** Every saved state says where it is kept, in the words `bots-lifecycle.md` (in review) uses for the same store. Under this computer's switches: "Kept on this computer." Under quiet hours, the bots' switches, the bot's page and a task's setting: "Kept for you on this gateway, so your other devices show the same." When the gateway keeps no profile, those read instead: "Kept on this computer: this connection has no profile on the gateway to keep it in, so your other devices won't show it."

**When the person's preferences cannot be read** (the call fails or the connection never reached hello), no notification about a bot is shown until they are read: a notification that ignored someone's quiet hours or a switch they turned off would be worse than none. Settings says so.

### Saving and reading back

- **This computer's switches** are written by the host to its settings file, and the switch moves when the host answers with what the file holds after the write. A failed write leaves the switch as it was, with "Couldn't save. Try again."
- **Your settings** are written with `users.prefs.set` and an `expectedEntries` holding the value last read, then read back with `users.prefs.get`; only what was read back is shown and announced. While the write is out, the control is disabled and its line reads "Saving…".
  - `conflict`: the value is read again and shown, under a note: "Changed on another of your devices a moment ago. This is what's set now." Nothing is written again by itself.
  - Refused or no answer: the value read back, or the last one read when nothing can be read, with "Couldn't save. Otto's notifications are still on." in the control's line and "Try again". A missing answer is checked with a read before anything else is said.
  - `users.prefs.changed` naming either key, from another device, is read and shown without a word; the announcer says nothing for a change the person did not make here.

### Access

- This computer's switches change at any access.
- Your settings are readable on every connection and written only on the interactive tier (`operator.write`, research §4). On a read-only connection their values are shown and their controls are disabled, and the access bar of `conversation.md` §3 sits at the foot of the group with "**Read-only.** Changing quiet hours and your bots' notifications needs more access." and "Request access", in all of that bar's states. Nothing here asks for admin.
- Notifications themselves work at every access: what each tier receives is section 3's.

### Input

- Settings is the modal dialog of `bots.md` §7. A switch is a `button` with role `switch` and `aria-checked`; Space and Enter flip it. A disabled switch keeps its name and is announced "unavailable".
- The time fields are native `input type="time"` with visible labels, so their keyboard is the system's; a change is saved when the field loses focus or Enter is pressed.
- A task's setting is a `.b-select` that opens a `.menu` of three `menuitemradio`; Up and Down move, Enter chooses, Escape closes and returns focus to the select.

### Announcements

The Settings dialog's polite live region (`bots.md` §2), and the Work pane's in the tab, announce only what was read back: "Notifications on this computer are on" or "off", "Previews are shown" or "hidden", "Budget warnings are on" or "off", "Quiet hours are on, 22:00 to 07:00" or "Quiet hours are off", "Otto's notifications are on" or "off", "This task: Off" (and the other two), "Couldn't save", "Changed on another of your devices". The status strip announces its own words (section 5).

## 3. When a notification is shown

### What the events say

| Something happened                      | The device whose message started the run                                                    | Another device at the interactive tier | A read-only device                | Source             |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------- | ------------------ |
| A run ended with a reply                | `chat` `final` with its text                                                                | The same                               | The same                          | Research §3, tried |
| A run failed                            | lifecycle `error` (definitive) and `chat` `error`                                           | The same                               | The same                          | Research §3, tried |
| A run was stopped                       | `chat` `aborted`, lifecycle `end`, `status: "cancelled"`                                    | The same                               | The same                          | Research §3, tried |
| A run waits for an approval             | `exec.approval.requested` (or the plugin or generic kind), and the phase `waiting-approval` | Only the phase `waiting-approval`      | Only the phase `waiting-approval` | Research §1, tried |
| A run waits for an answer to a question | `question.requested`                                                                        | `question.requested`                   | Nothing that says it waits        | Research §2, tried |

The device that started the run is not always this one: a message sent from a phone, another computer or the web preview starts runs too. Clawtrate cannot tell which device it was; it knows only what it received.

### The order

Every event that could notify is put through these steps, in this order; the first that applies decides.

| #   | Step                                                                                             | Outcome                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | This build cannot show notifications (section 10), or Show notifications is off on this computer | Nothing                                                                                                                                                                                                                                         |
| 2   | Your settings have not been read                                                                 | Nothing (section 2)                                                                                                                                                                                                                             |
| 3   | The event is not one that notifies                                                               | Nothing. Not notified: a stop, which someone chose; a reply-less end (the gateway's "nothing to say"); runs the gateway starts itself, heartbeats and routines, which are `automation.md`'s; a helper's own task, which is not in the task list |
| 4   | The task's setting                                                                               | On: go on. Off: nothing. Same as the bot: the bot's switch decides, on to go on, off for nothing. A budget warning skips this step for its own switch (section 11)                                                                              |
| 5   | The window is focused                                                                            | On macOS and Windows: nothing when the event's bot is the one on screen; other bots go on. On Linux: nothing at all while the window is focused                                                                                                 |
| 6   | Quiet hours are on now                                                                           | A wait is held until they end (section 6). Anything else is not shown, ever                                                                                                                                                                     |
| 7   | Otherwise                                                                                        | Shown                                                                                                                                                                                                                                           |

"The bot on screen" is the bot whose task the window shows. "Focused" is Electron's window focus (`BrowserWindow.isFocused`, its `focus` and `blur`, on every system); a window that is open but behind another app is not focused.

### What each device shows for a wait

| The wait    | This device has                                   | Shown                                                                                 |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| An approval | The request (it sent the message, or holds admin) | "Wants to run a command", and the card opens (sections 4 and 5)                       |
| An approval | Only the run's waiting phase, interactive tier    | "Is waiting for an approval. It can be answered on the device that sent the message." |
| An approval | Only the run's waiting phase, read-only           | "Is waiting for an approval. This device can only read."                              |
| A question  | The question (interactive tier)                   | "Asked you a question", and the card opens                                            |
| A question  | Nothing (read-only)                               | Nothing: there is nothing to say it from                                              |

**One per task.** A task has at most one notification at a time: a newer event for the task replaces the one shown. A notification is withdrawn when its task is opened in Clawtrate, when the wait it announced ends (answered, resolved, expired, or the run's end), and when Clawtrate quits or switches gateways. Withdrawing is Electron's `close()` and, on macOS, `Notification.remove` (research §6); a system may keep a copy the app cannot reach, which section 5 covers.

**Several bots at once** each get their own. Clawtrate does not summarise.

## 4. What a notification says

A notification can be read by anyone who can see the screen, including, depending on the system's settings, a locked one. Electron gives the app no control over that and no reading of it (research §6), so what the notification says is the only control there is. **By default it carries the bot's name and the kind of event, and never a message's, a command's or a question's text, and never a task's title.** More is the person's explicit choice: Show previews (section 7), off by default, on this computer only.

The title is the bot's name. The body is one sentence for the kind; with previews on, a second line follows.

| Event                                                      | Body                                                                                  | Second line with Show previews                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A run ended with a reply                                   | "Finished."                                                                           | The task's title, a colon, the reply's first words |
| A run failed                                               | "Its run failed."                                                                     | The task's title                                   |
| An approval this device received: a command                | "Wants to run a command."                                                             | The task's title, a colon, the command             |
| An approval this device received: another kind             | "Needs your approval."                                                                | The task's title, a colon, the request's title     |
| A helper's approval                                        | "A helper of Otto wants to run a command." (or "needs your approval")                 | As above                                           |
| An approval raised by a bot another bot messaged           | The asking bot as title: "Wants to run a command, for a message from Otto."           | As above                                           |
| A question                                                 | "Asked you a question." or "Asked you 3 questions."                                   | The task's title, a colon, the first question      |
| A question this app can't answer (`conversation.md` §13)   | "Asked something this app can't answer yet."                                          | The task's title                                   |
| An approval this device only saw waiting, interactive tier | "Is waiting for an approval. It can be answered on the device that sent the message." | The task's title                                   |
| The same, read-only                                        | "Is waiting for an approval. This device can only read."                              | The task's title                                   |
| A budget at 80 percent                                     | "Used 82% of its weekly budget. Shown only: nothing was stopped."                     | None                                               |

- The words of a failure are never shown: nothing in the events is fit to read on a lock screen, and the turn error in the task says what the gateway reported (`conversation.md` §17).
- A preview is cut at a word, with an ellipsis, so the whole notification stays within macOS's 256 bytes (research §6).
- The notification is grouped by bot (`groupId`, on macOS and Windows) and has no buttons and no reply field: answering belongs to the card, where Deny is always visible and the full request can be read (`conversation.md` §12). Buttons would also need a signed app with a changed alert style on macOS (research §6).
- The system's own sound plays; the app sets no sound of its own.

## 5. Opening a notification

The host keeps, for each notification it shows, what it was for: the gateway's identity (`gateway.identity.get`), the bot, the task key, and the approval or question id when there is one. None of it is in the notification's text. A click (Electron's `click`, research §6) brings the window forward (restored if minimised, made again on macOS if it was closed), then:

| The notification was for              | It opens                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A reply                               | The task, scrolled to the end of that run, with focus on the transcript                                                                                                                                                                                                  |
| A failure                             | The task, scrolled to the turn error                                                                                                                                                                                                                                     |
| An approval or a question it received | The task, with focus on the card, as "Review" does (`conversation.md` §14). If the card was answered meanwhile, it opens on the card as it now is                                                                                                                        |
| A wait it only saw                    | The task. The status line shows the wait, and the note of `conversation.md` §3 says it can't be answered here: "Otto is waiting for an approval. This device can't answer it: the device that sent the message can." On a read-only device the note keeps §3's own words |
| A budget warning                      | The bot's open task, at the budget line (`controls.md` §17)                                                                                                                                                                                                              |

**The task is in another bot's list.** The notification names the bot whose task holds the card, and opening selects that bot in the rail, unfolds it, and opens that task: Marlow's task "Notes for Pip" for a question Marlow asked while working on Pip's message (research §2), the parent's task for a helper's approval (`conversation.md` §12, "Where the card is").

**Before it opens anything, the host checks** what it would open, in this order:

| Check                                                             | When it fails                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The notification is of the gateway in use (its recorded identity) | Nothing opens. The status strip: "That notification came from Studio gateway. Clawtrate is using Home gateway now." with "Your gateways" (`settings.md` §4, in review)                                                                                                                                                                      |
| The host still has the notification's record                      | Clawtrate comes forward as it was, and nothing opens. This is a notification left from before Clawtrate quit or crashed: on Windows its click starts Clawtrate with only the system's raw arguments, which hold nothing Clawtrate can trust (research §6)                                                                                   |
| The task is in the task list                                      | The bot opens with its list, and the strip says "That task is no longer on the gateway." Nothing is sent, and no composer opens on that task: a send would start a new task silently (research §8)                                                                                                                                          |
| The connection is up                                              | The task opens from what was loaded, under the status strip's reconnecting state, "Reconnecting in 4s · showing saved messages" (`visual-language.md` §11). The card shows as it was last known; once the connection is back it shows what the gateway says (`conversation.md` §19). A task never loaded shows its loading state until then |

The task list is the one the rail holds. While the connection is down it is the list last loaded, so a task deleted meanwhile still opens from what was loaded, and the reconnect's reload removes it, as for any task.

## 6. Quiet hours

**Set** in Settings, Notifications (section 7): a switch, then From and To. A time is a whole minute; From may be later than To, which spans midnight ("22:00 to 07:00"). From and To the same is refused: "Start and end can't be the same time." and nothing is saved.

**Whose clock.** Quiet hours are kept with the time zone of the device they were saved on, as an IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`), and every device keeps them by that zone: 22:00 to 07:00 Lisbon time is the same hours everywhere. A device in another zone shows both: "22:00 to 07:00, Lisbon time, where they were set. That's 23:00 to 08:00 here." Saving the times again on that device sets its own zone, and the line says so before Save: "Saving here sets them in Berlin time."

**During quiet hours** nothing is shown. The rail's marks, the task rows and the dock or taskbar badge go on updating as they do now: they never depended on notifications.

**When they end**, each wait that was held and is still waiting at that moment is shown, one notification each, by section 3's order at that moment (a wait answered on another device, a bot switched off meanwhile, or the bot now on screen is not shown). A reply, a failure or a budget warning during quiet hours is never shown later: the rail and the task hold it. "When they end" is the minute the stored zone reaches To, checked every minute and again when the computer wakes (`powerMonitor` `resume`).

**Clawtrate must be running for that.** It shows its notifications itself, so if it is not running when quiet hours end, nothing is shown then or later; what still waits is in the rail when it next opens. On macOS it keeps running with its window closed; on Windows closing its window quits it (research §7). Settings says this in its words for each system.

**On a second device**, the same quiet hours apply, by the same zone. Each running device holds and shows its own waits: an approval on the device that sent the message, the waiting phase elsewhere.

**While they are on**, Settings shows one line under the times: "Quiet until 07:00." and, when something is held, "1 bot is waiting for you. It will be shown then."

## 7. Settings, Notifications

The Notifications section takes the place `settings.md` keeps for it in the section list (after Appearance, before System; in review on its own branch), and fills it as follows, top to bottom.

**This computer**, a group word, then three switch rows of the choice-list kind:

| Row                | Line under it                                                                                                                                                                          | Default |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Show notifications | "When a bot finishes or waits for you."                                                                                                                                                | On      |
| Show previews      | "Adds a task's title and the first words of a reply, a command or a question. Anyone who can see your screen can read them, also when it's locked, unless your system hides previews." | Off     |
| Budget warnings    | "When a bot has used 80% of a budget."                                                                                                                                                 | On      |

Under them a note, neutral, in the words for the system:

- macOS: "Clawtrate shows notifications while it's open, also with its window closed. It can't see whether macOS allows them or whether a Focus is on."
- Windows: "Clawtrate shows notifications while it's open. Closing its window quits it. It can't see whether Windows allows them or whether Do Not Disturb is on."
- Linux: "Clawtrate shows notifications while it's open, and none while its window is focused."

**When the system refused one** (Electron's `failed`, research §6), a `--warn-soft` note above the group: "Your system didn't show Clawtrate's notification at 5:41 PM. Check Clawtrate in your system's notification settings." It stays until a later notification is shown without `failed`. Nothing here ever says notifications are working: the app cannot know.

**Quiet hours**, a group word, then a switch row "Quiet hours" with the line "Nothing is shown during them. A bot still waiting for you when they end is shown then." With the switch on, the time pair (From, To), and under it the zone line of section 6. While they are on now, the "Quiet until" line of section 6.

**Your bots**, a group word, then one switch row per bot in the gateway's order, each with its picture and name, and a line: "On", "Off", or "On · 1 task off" / "Off · 2 tasks on" when tasks have their own setting. The row's switch is the bot's switch; the line's count is not a control (the bot's page lists them, section 8).

**Where each group is kept**, one line in `--text-faint` under the group, by section 2: under This computer, "Kept on this computer."; under Quiet hours and under Your bots, "Kept for you on this gateway, so your other devices show the same.", or, when the gateway keeps no profile, "Kept on this computer: this connection has no profile on the gateway to keep it in, so your other devices won't show it."

**When this build cannot show notifications** (section 10), This computer's three switches and the system's note are not shown. In their place, a neutral note: "This copy of Clawtrate can't show notifications on macOS. What your bots finish or wait on shows in the rail and on the dock's badge." (on Windows, "…on Windows. … in the rail and on the taskbar button."), and "Quiet hours and your bots' switches below apply on your other devices." Quiet hours and Your bots stay as above.

**States.**

| State                               | It shows                                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading                             | This computer's group as usual; for Quiet hours and Your bots, two grey blocks pulsing, `aria-busy`, and "Reading your settings from the gateway…"                                                    |
| Couldn't read                       | This computer's group as usual; a `--danger-soft` note: "Couldn't read your notification settings from the gateway. Until Clawtrate can, it shows no notifications about your bots." with "Try again" |
| Read-only connection                | Every value; the shared switches and fields disabled; the access bar at the foot of the shared groups (section 2)                                                                                     |
| Saving                              | The control disabled, its line "Saving…"                                                                                                                                                              |
| Saved                               | The value read back, announced                                                                                                                                                                        |
| Couldn't save                       | The value read back (or last read), the line "Couldn't save. Otto's notifications are still on." (or "Quiet hours are still off.") and "Try again"                                                    |
| Changed elsewhere                   | The note of section 2 above the group, with the value read again                                                                                                                                      |
| Same start and end                  | "Start and end can't be the same time." under the time pair; nothing saved                                                                                                                            |
| Show notifications off              | The rest stays readable and changeable; a line under the switch: "No notifications on this computer. Your other devices keep theirs."                                                                 |
| This build can't show notifications | The note above in place of This computer's group; nothing on this screen says a notification will be shown here                                                                                       |

## 8. A bot's Notifications page

**The row.** `bots.md` §8's frame gains one row, in a group of its own, "Notifications", after Tools: "Notifications", with the bot's switch as its value ("On", "Off") and a chevron. When Show notifications is off on this computer the value reads "Off on this computer"; when this build cannot show notifications (section 10), "Not shown on this computer". The row opens the page; it is the only change to that frame.

**The page**, inside the tab with a quiet round Back and the title "Notifications":

- A switch row: "Notify me about Otto", line "When Otto finishes or waits for you." It is the same switch as Otto's row in Settings. Under it, where it is kept: "Kept for you on this gateway, so your other devices show the same." (or "Kept on this computer: this connection has no profile on the gateway to keep it in, so your other devices won't show it.").
- A group word "Tasks with their own setting", then one row per such task, its title and its setting ("On" or "Off") as a fact row; the setting is changed in that task's Details (section 9). With none: "No task has its own setting. Choose one in the task's Details."
- Notes, when they apply: "Notifications are off on this computer." with "Settings" (opens Settings, Notifications); "Quiet until 07:00." while quiet hours are on; "This copy of Clawtrate can't show notifications. This switch applies on your other devices." when this build cannot show them.

The page's states are section 7's for its controls: reading, couldn't read, read-only with the access bar, saving, couldn't save, changed elsewhere. A task in the list that is no longer on the gateway is not shown, and its setting is removed with the next write.

## 9. A task's setting

**In the Work pane's Details tab**, which is about the open task, one row in a group "Notifications": "This task", with a `.b-select` whose value is "Same as Otto (on)", "Same as Otto (off)", "On" or "Off". It opens a `.menu` of three radio items: "Same as Otto (on)" (with the bot's current value in the brackets), "On", "Off". Choosing saves, by section 2's rules, and the row shows what was read back. Under the row, where it is kept: "Kept for you on this gateway, so your other devices show the same." (or "Kept on this computer: this connection has no profile on the gateway to keep it in, so your other devices won't show it."); when this build cannot show notifications, "This copy of Clawtrate can't show notifications. This setting applies on your other devices."

- **On** shows this task's notifications even while the bot is off; **Off** shows none while the bot is on; **Same as Otto** follows the bot. It wins over the bot's switch and nothing else: this computer's switch, focus and quiet hours still apply (section 3).
- **How many.** At most 40 tasks have their own setting, which keeps the value well inside the gateway's 4,096 bytes (research §4). Choosing On or Off for a 41st shows, under the row: "Up to 40 tasks can have their own setting. Set one back to "Same as" its bot first." with a link to the bot's page, and nothing is saved. Same as is always accepted: it removes the entry.
- On a read-only connection the row shows its value, the select is disabled, and the access bar is at the foot of the tab, as in section 7.

## 10. What the system decides, and what Clawtrate cannot see

- **Whether notifications are allowed**, and whether a Focus, Do Not Disturb or Focus Assist is on: the system's alone, and Electron reports neither (research §6). No rule here depends on them; Settings says Clawtrate can't see them.
- **What the app can observe**: that a notification was shown (`show`), clicked (`click`), closed (`close`, not always), or refused (`failed`). Only `failed` is shown to the person (section 7).
- **Signing.** macOS shows notifications only for a code-signed app (research §6). Clawtrate is signed ad hoc by default, and whether that is enough is not established. An unsigned or refused notification raises `failed`, which Settings reports.
- **Windows** needs the app's AppUserModelID on a Start-menu shortcut, which the installer makes (research §7). Electron also names a ToastActivatorCLSID, which the installer does not set; whether a toast is shown and clicks reach the app without it is the first thing a builder checks (section 15).
- **When a build cannot show notifications.** If the first step of section 15 finds that a build cannot show them (an app signed ad hoc on macOS, or the Windows installer's identity, may turn out to be such a case), or `Notification.isSupported()` answers false, that build shows none and promises none: the host never tries, the in-app marks and the dock or taskbar badge are all there is, and every screen here says so (sections 7 to 9). Which builds that covers is recorded in `docs/decisions.md` by that step; it is decided per build, never inferred from one `failed`.
- **While Clawtrate is not running** nothing is shown, and a notification from before can only bring Clawtrate forward (section 5).
- **Linux**: while Clawtrate's window is focused, no notification is shown. Nothing more is specified for Linux here.

## 11. Budget warnings

A budget's 80 percent warning (`controls.md` §17, F-396) is a notification under these rules, with three differences from a bot's notifications:

- It has its own switch on this computer, Budget warnings, in place of step 4: a bot switched off still warns about its budget, and a budget warning is not a task's.
- It is shown once per budget and period on this computer, as the line in the task is.
- During quiet hours it is not shown, then or later: it is not a wait, and the line in the task keeps the warning.

Its words are section 4's ("Used 82% of its weekly budget. Shown only: nothing was stopped."), and it opens the bot's open task at the budget line. At 100 percent there is no notification: the note above the composer is the warning (`controls.md` §17). Like every other notification, the host shows it, not the interface.

## 12. Widths, themes, keyboard, screen readers, motion

| Concern       | Rule                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1440 and 1100 | Settings is the 800 × 640 dialog; the Notifications section scrolls inside it                                                                                                                                                                                 |
| 800           | The same dialog at the window's width less 32 px                                                                                                                                                                                                              |
| 390           | Settings is the sheet of `bots.md` §19: the list of sections first, the section replacing it with Back. Switch rows are 64 px; the time pair stays side by side. The Work pane is its full-width sheet, with the bot's page and the Details row as on desktop |
| Themes        | Only the product's tokens, light and dark. The picture of a notification uses `--bg-raised`, `--border-strong` and `--text-*` in both                                                                                                                         |
| Keyboard      | Every control in section 2's Input; the notification itself is the system's, and its keyboard path is the system's                                                                                                                                            |
| Screen reader | A switch is named by its row ("Show previews", "Otto's notifications", "Quiet hours") and its line is its description; the time fields by "Quiet hours from" and "Quiet hours to"; the status strip is a `status` region. Announcements are section 2's       |
| Motion        | A switch's thumb slides in `--dur-quick`; with reduced motion it moves without sliding. Nothing else here moves                                                                                                                                               |

## 13. What each fact drives

| #   | Fact                                                                                                                                                         | Drives                                                                                              | Evidence                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | An approval request reaches only the device whose message started the run; another device's answer is refused; it waits for that device                      | The "can be answered on the device that sent the message" wording; no card elsewhere                | Research §1, tried            |
| 2   | Every connection sees the lifecycle's `waiting-approval` and `approval-resolved`                                                                             | The waiting notification on other devices, and its withdrawal                                       | Research §1, tried            |
| 3   | A question reaches every connection with `operator.questions`, also from another bot's task; a read-only device gets nothing that says it waits              | Questions notify on every interactive device; none on read-only                                     | Research §2, tried            |
| 4   | Every connection sees `chat` `final` with the reply, `error`, `aborted`, and lifecycle `end` with its reason                                                 | Finished and failed; a stop not notified; previews of a reply                                       | Research §3, tried            |
| 5   | `users.prefs`: per profile, read at read access, written at the interactive tier, compare-and-set, 4,096 bytes, `users.prefs.changed`, `no_durable_identity` | Where switches and quiet hours are kept; read-back; conflict; the 40-task bound; "on this computer" | Research §4, tried and source |
| 6   | The gateway's own push: quiet hours in minutes with an IANA zone; dropped, not held                                                                          | The quiet-hours shape; Clawtrate holds waits itself                                                 | Research §5, source           |
| 7   | Electron: no permission or Focus reading; `failed`; `click`; buttons need signing on macOS; no lock-screen option; nothing while not running                 | Section 10; the default text; no buttons; the failed note                                           | Research §6, documentation    |
| 8   | The main process holds the connection; macOS runs with no window, Windows quits; the session refuses web notifications                                       | The host decides and shows; the per-system notes                                                    | Research §7, source           |
| 9   | A deleted task's history answers like a new task; the list and `sessions.changed` say it is gone                                                             | Opening checks the task list; never sends                                                           | Research §8, tried            |
| 10  | `waiting.ts` already tracks waits and stops for every task                                                                                                   | What the engine supplies                                                                            | Research §7, source           |

## 14. Parity rows

The rows' statuses stay `todo`. Targets were changed only where the decisions on this design said so (round 1); the gateway-dependency cells are reworded to the evidence.

| Row   | Change                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-202 | Dependency: the desktop switch is kept in `users.prefs` (live), or on the device on `no_durable_identity`; the iOS part as written                                                                                                                                                                                                                                                            |
| F-203 | Dependency: desktop quiet hours `{enabled, startMinute, endMinute, timeZone}` in `users.prefs` (live), kept by each running desktop in the stored zone; the iOS part as written                                                                                                                                                                                                               |
| F-204 | Target: `same` with a note that narrows it: a wait is notified on the device that receives it (section 3). Dependency: the end of a run on every connection (live); an approval only on the device whose message started the run, the waiting phase elsewhere (live); questions on every connection with `operator.questions` (live); Electron's main-process `Notification` and window focus |
| F-207 | Target: the exact task and card when this device has them; otherwise it opens what it can and says why (section 5). Dependency: the host's record of each notification, Electron's `click`, and the task list, never `chat.history` (live); the iOS part as written                                                                                                                           |
| F-367 | As written                                                                                                                                                                                                                                                                                                                                                                                    |
| F-368 | Target: an item that still needs the user is delivered when quiet hours end if Clawtrate is running; in-app badges update while a window is open (section 6)                                                                                                                                                                                                                                  |
| F-369 | Target: `same` with a note that the phone's part belongs to the phone notifications design. Dependency: the window's focus from Electron                                                                                                                                                                                                                                                      |
| F-396 | Dependency: the desktop notification under section 11: the main process, 80 percent only, held back by quiet hours, the bot's name and the kind of event. The target as written                                                                                                                                                                                                               |

## 15. For builders

### First: whether a notification appears at all

Nothing establishes yet that a notification appears, on either system, in the app as it is packaged:

- **macOS**: notifications need a code-signed app, and Clawtrate is signed ad hoc by default. Whether that is enough is not known (section 10, research §6, §7).
- **Windows**: the installer gives the Start-menu shortcut the app's AppUserModelID, but no ToastActivatorCLSID, which Electron also names. Whether a toast appears, and whether its click reaches the app, is not known.

So the first thing a builder does is check each: a toast from the NSIS install, with and without a ToastActivatorCLSID; a notification from the ad hoc build and from a signed one; in each, that it appears and that `click` arrives. The outcome goes in `docs/decisions.md`. **Where one cannot show notifications, the design falls back to the in-app marks and the badge only**, and that build takes section 10's "cannot show notifications" state, so no screen promises a notification there. Nothing else in this design is built for a platform before this step has answered for it.

### What each part uses

| Part                   | Uses                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The decision           | The host: the gateway's events, the core's waiting state, your settings as last read, this computer's switches, the window's focus and the bot on screen (from the interface)                |
| Showing                | Electron's `Notification` in the main process: `title`, `body`, `id` per task, `groupId` per bot, no `actions`; `close()` and on macOS `Notification.remove` to withdraw                     |
| Opening                | `click` on the live object, the host's record, `gateway.identity.get`, the task list, then a bridge command to the interface: select the bot, open the task, focus the card or the run's end |
| Settings and the pages | `users.prefs.get` and `users.prefs.set` with `expectedEntries`; `users.prefs.changed`; the host's settings file for this computer's switches                                                 |
| Quiet hours            | The stored zone with `Intl.DateTimeFormat`; a minute timer; `powerMonitor` `resume`                                                                                                          |

### What the host does

- Keeps a record per shown notification (gateway identity, bot, task key, card id, kind), at most one per task, dropped when withdrawn; nothing of it on disk.
- On quit (`before-quit`) withdraws every notification it shows; on switching gateways withdraws the old gateway's.
- Holds waits during quiet hours in memory, by task and card id, and drops a held wait when it ends.
- Listens for `failed` and keeps its time for Settings.
- Registers `Notification.handleActivation` on Windows only to bring the window forward for a notification it has no record of.

### What the engine supplies

- The end of each run in a listed task, with its outcome and the reply's first words: from `chat` and `agent` events, as `runs.ts` already classifies them.
- Waits per task (`waiting.ts`), with the card's id and kind where this device has the card.
- Whether a task is in the list, and the task's bot.
- Your notification settings as read, with `users.prefs.changed` applied, and a write with compare-and-set and read-back; `no_durable_identity` as its own state.

### Order

1. The first step above, for macOS and for Windows, recorded in `docs/decisions.md`; a build that cannot show notifications gets the fallback state.
2. The host's decision and showing, for replies, failures, and the waits this device has cards for, with this computer's switch.
3. Opening, with every check of section 5.
4. Your settings in `users.prefs` and Settings, Notifications; the bot's row and page; the task's setting.
5. Waits seen only as a phase; quiet hours; previews.
6. Budget warnings moved to the host under section 11.

### The prototype's states and walks

`prototype/notifications.html` takes `theme`, `width` and `motion`, and:

| Parameter                        | Values                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`                           | `settings` (Settings, Notifications), `bot` (the bot's Notifications page), `details` (the task's setting), or none (the app with the notifications bar) |
| `event`                          | `finished`, `failed`, `stopped`, `approval`, `question`, `marlow` (a question in Marlow's task for Pip's message), `budget`                              |
| `device`                         | `sender` (the default), `other` (another device at the interactive tier), `read` (read-only)                                                             |
| `focus`                          | `otto` or `pip`: the window is focused on that bot                                                                                                       |
| `quiet`                          | `1`: quiet hours are on now                                                                                                                              |
| `platform`                       | `none`: this build cannot show notifications (with `os=mac` or `os=windows`)                                                                             |
| `quietset`                       | `1`: quiet hours are set, 22:00 to 07:00, and not on now                                                                                                 |
| `os`                             | `mac` (the default), `windows`, `linux`                                                                                                                  |
| `master`, `previews`, `budgetsw` | `0` or `1`: this computer's switches                                                                                                                     |
| `bot`                            | `otto=off`: Otto's switch off. `task`: `on` or `off`, the setting of Otto's task "Weekly backup check"                                                   |
| `click`                          | `gone`, `offline`, `othergw`, `stale`: what the host finds when the notification is clicked                                                              |
| `prefs`                          | `reading`, `readfail`, `device` (`no_durable_identity`), `conflict`, `savefail`, `elsewhere` (a second device in Berlin)                                 |
| `access`                         | `read`: a read-only connection for the settings                                                                                                          |
| `failed`                         | `1`: the system refused the last notification                                                                                                            |
| `tasks`                          | `full`: 40 tasks already have their own setting                                                                                                          |

The walks the check clicks: each event for each device to its notification or to the reason it is not shown; each notification's click to what it opens, and each failed check of section 5; quiet hours holding a wait and showing it when they end, and not showing a reply; focus on Otto silencing Otto and not Pip; Linux silencing everything while focused; each switch in Settings saved and read back, failing, and changed elsewhere; the time pair refusing equal times; the bot's page and the task's setting, including the 40-task bound; the read-only connection with its access bar.

## 16. Not covered here

- Phone push and Live Activities (issue #77). The phone will share quiet hours, the bots' switches and the tasks' settings, which are kept with the person's profile; this computer's switches are this computer's.
- Routines, check-ins and what their runs notify (`automation.md`), and links into the app (`links.md`).
- The cards themselves, and what the conversation shows for a wait this device cannot answer at the interactive tier (`conversation.md`); this design uses §3's note and asks its owner for the words.
- Notifications in the web preview: system notifications come from Electron's main process, and the preview host shows none.
- Sounds, badges and the badge count, which stay as built.
- A summary notification for many events, notification history inside Clawtrate, and snoozing.
- Mentions of the person by other people (the gateway's `humanMentioned`), and failed routines.
- Settings' other sections and its frame (`settings.md`, in review); a bot's other settings (`bots.md` §8).
