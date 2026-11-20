# Search

What Cmd/Ctrl+K opens: one palette over the bots, task names, messages, files, links, routines and settings, and on the iPhone the same search with scopes. It says, for each source, what it looked in, and it opens each result in the place where it already lives. It builds on `visual-language.md` and `conversation.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-033, F-240 and F-268. What the gateway does is in `docs/research/search.md`, from OpenClaw's source and a development instance. This document decides appearance, wording and input, and for every state it names the gateway fact behind it. Section 13 lists those facts. Section 14 lists the parity rows whose wording changes, and the one that needs a decision. Section 15 is for builders.

One rule sits above the rest: **a group says what it searched, and "no match" is said only of that.** The gateway's message search returns at most 25 matches and has no way to go further back; files are searched one bot at a time; links exist only in conversations this device has loaded. So every group carries its coverage in plain words, and a part that was skipped, failed, timed out, was cut off or was searched only in part is named as such, never shown as empty. "No results" is said only when every source in view finished over all it covers, and the live region says only what the screen says.

The prototype shows all of it: `prototype/search.html` is the app with the palette added, and its address picks any state (section 15). The styles are in `prototype/css/search.css` and the behaviour in `prototype/js/search.js`. `prototype/tools/checks/search.mjs` checks them.

## Contents

1. How search works
2. Shared rules: components, tokens, the query, content, access
3. Opening the palette
4. Before anything is typed
5. The sources, and what each covers
6. When the gateway is asked
7. Results: groups, rows, Show all
8. Messages: best matches, and searching each bot
9. Opening a result in its place
10. Nothing found, partial, failed, offline
11. The phone: scopes
12. Keyboard and screen reader
13. What the gateway's facts drive
14. Parity rows to reword
15. For builders
16. Not covered here

## 1. How search works

The palette is a dialog over the whole window. Its field is a combobox; under it, one list holds the results in groups, one group per source. Typing filters what the device already holds at once (bots, task names, links, settings) and asks the gateway for the rest (messages, routines, files) when typing pauses (section 6). Each group fills in when its source answers, so a slow or failed source never holds the others back.

Enter opens the active result where it lives: a bot in the rail, a task or a message in its conversation, a file in the Work pane's reader, a setting in Settings. Opening reuses those views and changes none of them. The palette closes, and the query goes with it: it is never written to a log, kept, or offered again (section 2).

On the iPhone, and in a desktop window narrower than 688 px, search is a full screen with scopes: All, Messages, Bots, Group Chats, Files and Routines (section 11).

## 2. Shared rules

### Components reused

| Component                          | From                                                              | Used for                                     |
| ---------------------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| Round icon button, the search icon | `visual-language.md` §4, §7                                       | The rail's search button, unchanged in place |
| Avatars at 24 px (32 px on touch)  | `visual-language.md` §5                                           | Bot, task and message rows                   |
| The scrim, `--bg-scrim`            | The Work pane's drawer                                            | Behind the palette                           |
| The status line's words and tones  | `visual-language.md` §11                                          | A group's failed and offline lines           |
| The link confirmation              | `docs/decisions.md`, "Addresses a gateway hands the client" (#71) | Opening a link in the browser                |
| The Work pane's reader, Settings   | `work-pane.md` §5-6, `bots.md` §7, `controls.md`                  | Where a file or a setting opens              |

### New components

| Component        | What it is                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette          | A modal dialog: the field, the result list, a one-line key hint at its foot                                                                               |
| Result group     | A labelled group in the list: its name, its count, and a coverage line                                                                                    |
| Result row       | An option: an icon or avatar, a first line, a second line, and on the active row a hint of what Enter does                                                |
| Group action row | An option at the end of a group that acts on the group: "Show all 25 messages", "Search each bot for more", "Search the other 4 bots' files", "Try again" |
| Scope bar        | On the phone only: six segments that choose which groups show                                                                                             |

### Tokens

No new token. The palette is `--bg-raised` with `--shadow-pop` and an 18 px radius; rows use the 10 px radius and `--bg-selected` when active; group names are 13 px medium `--text-muted`, coverage lines 13 px `--text-faint`, row first lines 14 px `--text`, second lines 13 px `--text-muted`, the key hint 12 px `--text-faint`. Matched words in a snippet are drawn in medium weight and `--text` against the rest in `--text-muted`: weight, not colour, since colour belongs to the bots and to the person (`visual-language.md` §1, principle 5).

### The query

- It lives in the palette's state while the palette is open, and on the iPhone while the search screen is in the navigation stack. Closing the palette, Cancel on the phone, or switching gateways clears it.
- It is never written to the host's log, to the device's storage, to the address, to `users.prefs`, or anywhere else. There is no list of recent searches. Requests carry it to the person's own gateway and nowhere else; on the development gateway, the log records a search's method, time and size, not its words (research §8).
- It is trimmed. It is at most 4,096 characters, the gateway's limit; the field stops there.

### Content, not interface

Everything a row shows that came from the gateway is text: bot names and labels, task titles, snippets, file names and paths, routine names, link addresses. Nothing in a snippet is a link, a picture or formatting: the snippet is drawn as the gateway sent it, with runs of white space shown as one space. A bot's picture follows `docs/decisions.md`, "Addresses a gateway hands the client": a `data:` picture is drawn, an `https` one only after the person allowed it, anything else is the bot's character. A link's address is shown as text, host first, and leaves the app only through the confirmation (section 9).

### Access

Every source is read tier: `agents.list`, `cron.list`, `sessions.search`, `sessions.files.list`, `agents.workspace.list` and `chat.history` all answered a connection holding only `operator.read` (research §12). The palette never asks for more access and writes nothing, so on a read-only connection it is the same in every state and needs no access bar.

### Announcements

The palette has its own polite live region. It is drawn from the same state as the list, so it never says more than the screen: it speaks once nothing in view is pending (section 12). Moving through results is announced by the screen reader from the active option, not by the live region.

## 3. Opening the palette

| Way                             | Where                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ⌘K on the Mac, Ctrl+K elsewhere | Anywhere in the window, including the composer and inside a pending card, since no card binds those keys (`conversation.md`, "Shortcuts"). Not while another modal dialog is open (New bot, Settings, a confirmation). With the palette open, the same keys select the field's text. |
| The rail's round search button  | The top right of the rail, where it is today (F-012). Its name becomes "Search", its tooltip "Search (⌘K)", and it carries `aria-haspopup="dialog"`. It is shown on a read-only connection too.                                                                                      |
| ⌘⇧F                             | Unchanged: it still opens the rail's own bot filter (F-267).                                                                                                                                                                                                                         |

In the desktop app ⌘K reaches the app. In a browser (the web preview) the page asks for the keys first; whether every browser lets a page have them is not established (research §13), and the rail's button is always there.

**The frame.** Centred on the window, its top 72 px below the window's, 640 px wide or the window less 48 px when narrower, and at most the window's height less 144 px; the list scrolls inside. The scrim covers the rail and the main pane; a click on it closes the palette. At 1440, 1100 and 800 the palette is the same size; below 688 px it is the phone's full screen (section 11).

**The field.** At the top of the palette: the search icon, then the field, 15 px, placeholder "Search bots, tasks, messages, files, links, routines and settings", 52 px tall, with no border of its own: the palette is its surface. It has focus on opening.

**The foot.** One line, 12 px `--text-faint`: "↑↓ Move · ↵ Open · Esc Close", and "· ⇧↵ Open in browser" while a link row is active.

**Motion.** The palette and scrim fade in over `--dur-quick`, the palette rising 4 px. With reduced motion they appear at once.

## 4. Before anything is typed

The list holds one group, "What search looks in", whose rows are not options: they say what each source covers, in the words the groups use later.

| Line     | Words                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bots     | "Every bot, by name."                                                                                                        |
| Tasks    | "Task names in this device's task list." When the list was cut short, "…, which holds the most recent tasks only."           |
| Messages | "Your messages and the bots' replies, in every bot's tasks. Not steps, tool results, reasoning or archived tasks."           |
| Files    | "File names in each bot's workspace."                                                                                        |
| Links    | "Links in the conversations loaded on this device: 2 now." With none: "Links in conversations you open. None is loaded now." |
| Routines | "Routines, by name and description."                                                                                         |
| Settings | "Clawtrate's settings."                                                                                                      |

A place for group chats is kept between Bots and Tasks; nothing is drawn there until group chats exist (section 16).

## 5. The sources, and what each covers

Groups always come in this order: Bots, (Group chats, later), Tasks, Messages, Files, Links, Routines, Settings.

| Group    | Where it comes from                                                                      | What a query matches                                                                                               | What it covers                                                                                                                                                                                           | Asked                                         |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Bots     | `agents.list`, already loaded                                                            | The bot's name, anywhere in it, ignoring case and accents                                                          | Every bot on the gateway                                                                                                                                                                                 | On the device, at once                        |
| Tasks    | The task list the app keeps (`sessions.subscribe`), already loaded                       | The task's title, anywhere in it, ignoring case and accents                                                        | Tasks in this device's list: not archived, the newest 500 (`MAX_LISTED_TASKS`), less when the list was cut short                                                                                         | On the device, at once                        |
| Messages | `sessions.search {query, scope: {excludeCron: true, excludeSubagents: true}, limit: 25}` | Every word, as a whole word; the last word may also be the start of a word; case and accents ignored (research §2) | The text of the person's messages and of the bots' replies in every bot's tasks that are not archived, with the task list's own filters. Not reasoning, tool calls, tool results or titles (research §1) | The gateway, after a pause                    |
| Files    | `sessions.files.list {sessionKey, search}`, one call per bot                             | The file's path, anywhere in it, ignoring case                                                                     | Each bot's workspace, through one of its tasks whose root is that workspace; at most 500 names or 5,000 entries walked per bot; at most 8 bots per query (section 7)                                     | The gateway, after a pause, from 2 characters |
| Links    | The transcripts this device holds now                                                    | The address, anywhere in it, ignoring case                                                                         | `http` and `https` links in the messages and replies of the conversations loaded on this device, and nothing else                                                                                        | On the device, at once                        |
| Routines | `cron.list {query, enabled: "all", limit: 50}`                                           | A substring of the routine's id, name, description, bot id and display name, ignoring case                         | Every routine, on or off; not a routine's message (research §11)                                                                                                                                         | The gateway, after a pause                    |
| Settings | Clawtrate's own list                                                                     | The section's name and its line                                                                                    | Gateway, Accounts, Integrations, Permissions, Memory, Usage, Machines: the sections Settings has                                                                                                         | On the device, at once                        |

**Why the scope matches the task list.** `excludeCron` and `excludeSubagents` are the task list's own filters (`packages/core`, `SESSION_LIST_PARAMS`), and `scope` leaves archived tasks out by default. So a message result belongs to a task the list can hold, and section 9 can open it. Searching archived tasks (`archived: "all"` finds them, research §9) is not offered: the app lists no archived task, so their results would lead nowhere.

**Why task names are their own group.** The gateway's search does not match a task's title (research §1). The titles are already on the device, so matching them there costs nothing and finds "Heat pump vs. gas furnace" for "furnace", which the message search would not.

## 6. When the gateway is asked

A search costs the gateway little: on about 400 tasks it took 10 to 20 ms, the first after a start 2 s, and it reads an index, not files (research §8). A files search walks up to 5,000 entries per bot. So:

- Bots, Tasks, Links and Settings are filtered on every change to the field.
- Messages and Routines are asked 250 ms after the last change. Files are asked at the same moment, once the query has 2 characters or more: a single character is in nearly every path, and the walk would stop at its 500-name cap; with one character the Files group says "Type 2 or more characters to search file names."
- One request per source is in flight. A change while one is out waits for it, then only the latest query is sent. An answer to an older query is dropped unseen.
- Nothing is asked for an empty field.
- When the connection comes back while the palette is open, the gateway's sources are asked again for the current query.

## 7. Results: groups, rows, Show all

**A group** has a heading row (not an option): its name and, after a dot, its count of results shown ("Messages · 25"), and under it the coverage line for what was searched (section 8 for messages; the table below for the rest). A group is drawn when it has results or was not searched in full. A group searched in full with no results is not drawn; it is named in "No matches in" (section 10). A group shows its first 5 rows, then the action row "Show all 25 messages", which shows the rest in place and leaves the other groups as they are.

| Group    | Coverage line, complete                                | When it is partial                                                                                                                                                                               |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bots     | none                                                   | "Couldn't load the gateway's bots. Showing the bots loaded before." (from the status strip's state); with no list loaded yet, "The gateway's bots haven't loaded yet." Either way the group is drawn, even with no name matching |
| Tasks    | "By name, in this device's task list"                  | "By name, in this device's task list, which holds the most recent tasks only"                                                                                                                    |
| Files    | "Names in the workspaces of Juniper, Otto and Pip"     | "Not searched: Marlow, none of whose tasks works in its workspace." "Otto: stopped after 500 names or 5,000 entries." "Searched 8 of 12 bots' workspaces", with "Search the other 4 bots' files" |
| Links    | "Only from the 2 conversations this device has loaded" | With none loaded: "No conversation is loaded on this device yet", and the group is drawn, never counted as no match                                                                              |
| Routines | "By name and description"                              | "First 50 of 63", with "Show all 63 routines" (the next page, `offset`)                                                                                                                          |
| Settings | none                                                   | none                                                                                                                                                                                             |

**A row.** 44 px for one line, 60 px for two, 8 px from the palette's edge, the 10 px radius. When active it takes `--bg-selected`, and its right end says what Enter does.

| Kind    | Leading              | First line                                                                  | Second line                                                    | Enter says                                |
| ------- | -------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| Bot     | Its avatar           | The name                                                                    | Its label                                                      | "Open"                                    |
| Task    | Its bot's avatar     | The title                                                                   | "<Bot> · <time of its last activity>"                          | "Open"                                    |
| Message | Its bot's avatar     | The task's title · "You" or "<Bot>" · its time                              | The snippet, at most two lines, matched words in medium weight | "Go to message"                           |
| File    | The file's kind icon | The name, cut in the middle so the extension stays                          | "<folder> · <Bot>"                                             | "Open in Work"                            |
| Link    | The link icon        | The host, then the rest of the address in `--text-muted`, cut in the middle | "<task title> · <Bot>"                                         | "Go to message", and "⇧↵ Open in browser" |
| Routine | The clock icon       | The name                                                                    | "<Bot> · On" or "<Bot> · Off"                                  | "Open <Bot>"                              |
| Setting | The settings icon    | The section's name                                                          | Its line ("The gateway, its address and this device")          | "Open"                                    |

The task title on a message row comes from the task list; for a task the list does not hold, from the `sessions` rows the search returns (research §4). The marking of matched words is the device's: a word is marked when it begins with one of the query's words, compared ignoring case and accents, which is the gateway's rule for the last word and a superset for the others. It marks; it does not decide what matched.

**Which row is active.** The first option when results for a new query arrive. When a later group fills in, the active row stays the same row, by identity, even when it moves down.

## 8. Messages: best matches, and searching each bot

`sessions.search` has no cursor, no offset, no time range and no time order: it returns the best `limit` matches by its relevance score, at most 25, and says `truncated` when more match (research §3, §5). So the palette can never page back, and never says "recent messages". What does find more is a narrower search: across all bots, the 25 came from two bots of four, and a search per bot found 25 more for each of the other two (research §7). That, and only that, is what the group offers.

**The first search** asks across all bots. The palette shows what came back newest first, since the gateway's scores of two bots are not on one scale (research §3) and time is what a reader can follow.

| What came back                   | Coverage line                                                                       | Action row                 |
| -------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| Not truncated                    | "All 6 matching messages, newest first"                                             | none                       |
| `truncated`                      | "The gateway's 25 best matches across all bots, newest first. More messages match." | "Search each bot for more" |
| `indexing`                       | adds "The gateway is still indexing some messages, so recent ones may be missing."  | as above                   |
| `archivedTranscriptsExcluded: 4` | adds "4 tasks' older messages are in the gateway's archive and weren't searched."   | as above                   |

**Search each bot for more** asks again once for each bot, with `scope.agentId`, 25 each, 4 requests at a time, in the rail's order. The group's rows are then shown under one sub-heading per bot, each with its own coverage line:

| A bot's answer | Its line                                                                        |
| -------------- | ------------------------------------------------------------------------------- |
| Not truncated  | "Juniper · all 3 matches"                                                       |
| Truncated      | "Otto · 25 best matches. More match; add words to narrow them."                 |
| No match       | "Marlow · no matches"                                                           |
| Failed         | "Pip · couldn't search: <the gateway's message>", with "Try again" for that bot |

With more than 24 bots, the first 24 are asked, and the last line is "Searched 24 of 30 bots", with "Search the other 6". A new query starts again from the first search.

**What it cannot find.** Inside one bot, matches beyond that bot's best 25. The gateway would return some of them for a narrower set of that bot's tasks (research §7), but nothing reaches all of them, and the palette does not walk a bot's tasks in batches to collect a list it still could not call complete. The bot's line says more match and asks for more words instead. It also cannot find text the gateway does not index (section 5) or messages in archived tasks.

## 9. Opening a result in its place

Before anything opens, the palette checks that the place still exists, from what the app keeps up to date: the task list (followed through `sessions.changed`) and `agents.list`. A deleted task's history reads as zero rows without an error (research §9), so the history is never taken as evidence that a task exists.

| Result                                       | Enter                                                                                                                                                                                     | The palette                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Bot                                          | Opens the bot as a click on its row does: its last opened task, or its newest                                                                                                             | Closes                                                                   |
| Task                                         | Opens the task                                                                                                                                                                            | Closes                                                                   |
| Message                                      | Opens the task, behind the palette, and waits for its history                                                                                                                             | See below                                                                |
| File                                         | Opens the task the bot's files were searched through, with the Work pane on Files, the file's folder in its workspace and the file in the reader, as `work-pane.md` §6 opens a file       | Closes                                                                   |
| Link                                         | Goes to the message that holds it, as a message result does                                                                                                                               | As for a message                                                         |
| Link, ⇧↵ (or its "Open in browser" on hover) | The link confirmation: the full address, host first, "Opens in your browser", Cancel and Open, with "This address is on this computer" or "on your own network" when it is written as one | Stays open behind the confirmation; Escape closes the confirmation first |
| Routine                                      | Opens the routine's bot. Routines have no page of their own yet (section 16), so the active row says "Open <Bot>", not "Open routine"                                                     | Closes                                                                   |
| Setting                                      | Opens Settings at that section                                                                                                                                                            | Closes                                                                   |

**A message.** The task opens behind the palette, which shows "Opening…" on the row. When the conversation's history has loaded:

- **The message is among the loaded rows** (a row whose `__openclaw.id` is the result's `messageId`, research §4): the palette closes, the transcript scrolls the message into view by the smallest scroll, focus moves to its turn, and the message's bubble has a 2 px `--accent-line` ring that fades after 2 seconds (with reduced motion it stays until the next scroll or key). The app's announcer says "Opened <task>, at your message of <date>" or "…, at <Bot>'s reply of <date>".
- **It is not** (the conversation shows the latest 200 messages, and an older match is not among them): the palette stays, and under the row a line says "This message is earlier than the 200 messages a conversation shows, so it can't be shown in place." with the action row "Open the task at its latest". The task is already open behind the palette.
- **The history fails to load**: under the row, "Couldn't load this conversation: <the reason>.", with "Try again".

**When it cannot open.** The row stays, with a line under it in place of opening:

| Case                                    | How it is known                                               | Line                                                                              |
| --------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The task left the list after the search | It was in the task list when the results came, and is not now | "This task is no longer on the gateway's list: it was archived or deleted."       |
| The task was never in the list          | Not in the task list when the results came                    | "This task isn't in this device's task list, which holds the newest 500 tasks."   |
| The bot was deleted                     | Its id is not in `agents.list`                                | "<Bot> is no longer on this gateway."                                             |
| The file's bot has no task to open      | The bot's search task left the list                           | "Clawtrate can't open Pip's files now: the task they were found through is gone." |

A deleted bot's messages and a deleted task's messages are gone from the next search (research §9); the lines above cover results already on screen.

## 10. Nothing found, partial, failed, offline

**No matches in.** Once nothing in view is pending, the sources that finished over all they cover and found nothing are listed at the end under "No matches in Bots, Tasks, Links, Routines and Settings", each with what it covered ("Links: Links in the 2 conversations this device has loaded."). A source that was skipped, failed, timed out, was cut off or was searched only in part is never in that list: it is drawn as a group, with its own lines.

**No results.** Only when every source in view finished over all it covers and none matched does the list hold a title, "No results for "ephyr"", with each source and what it covered. Messages adds the gateway's rule: "Messages match the words you type; the end of your query can match the start of a word." That is why "ephyr" finds nothing in "Zephyrine" (research §2). None of these is ever an all-clear, and each keeps its group in view: a bot list that is empty or failed to load; a task list that was cut short or failed to load; no conversation loaded (Links); a workspace not verified, not asked, refused, timed out or capped; Files not asked below 2 characters; a request still pending or given up; a disconnected gateway; a message reply with `indexing` or `archivedTranscriptsExcluded`; a routine list with more pages.

**Partial.** Section 7 and section 8 give each source's partial coverage line. A group can be partial and still have results; the line is always under its heading.

**Failed and timed out.** A source that fails shows its heading and one line on `--danger-soft`: "Couldn't search messages: <the gateway's message>." with the action row "Try again", which asks that source again. A request that has not answered in 8 seconds is given up the same way: "Couldn't search messages: the gateway didn't answer in 8 seconds." The other groups are not touched. For Files, a failure is per bot, in the coverage line.

**Searching.** A gateway group that has been asked shows its heading with "Searching…" in its coverage line and two skeleton rows, from the moment it is asked until it answers. The rows of an earlier answer are not left under a new query (section 6).

**Offline or reconnecting.** The gateway's groups are not asked. Each shows its heading and "Not searched: Home gateway isn't connected. Search runs again when it reconnects." The device's groups still filter what was loaded before.

## 11. The phone: scopes

On the iPhone, and in a desktop window narrower than 688 px, the search button at the top right opens search as a full screen.

- **The top.** The field as a pill, 44 px, with "Search" as its placeholder and focus on opening, and "Cancel" (a quiet button) to its right, 12 px from the edges.
- **The scope bar** under it: six segments, All, Messages, Bots, Group Chats, Files, Routines, in a row that scrolls sideways when it does not fit. All is chosen first. The bar is a tab list; the results under it are its panel.
- **All** shows every group in section 5's order, 3 rows each, then "See all 25 messages", which chooses that group's scope. **Messages** shows Tasks, Messages and Links. **Bots**, **Files** and **Routines** show their group. Settings shows only in All.
- **Group Chats** shows one line: "Group chats aren't part of Clawtrate yet." It is true, and it keeps the scope's place for when they are.
- Rows are at touch sizes: 56 px or more, 32 px avatars, 17 px first lines. Coverage lines, partial and failed states, "Search each bot for more" and every line of section 9 are the same.
- **Opening.** On the iPhone a result pushes its place onto the stack (Home, Search, then the chat or the file); Back returns to Search with the query, the scope, the results and the scroll position as they were. Cancel clears the query and returns to Home. In the narrow desktop window, opening closes the search screen and shows the one-pane detail; Back to bots returns to the list, and search opens empty again.
- The keyboard's return key reads "Search" and hides the keyboard; the gateway was already asked on the pause.

## 12. Keyboard and screen reader

| Key                    | In the palette                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Up, Down               | Move the active row through every option, across groups; they stop at the first and last                            |
| Page Up, Page Down     | The first option of the previous or next group                                                                      |
| Enter                  | Opens the active row (section 9), or does what an action row says                                                   |
| ⇧Enter                 | On a link row, the link confirmation; elsewhere nothing                                                             |
| Escape                 | Closes the palette and returns focus to what had it before; with the link confirmation open, closes that first      |
| ⌘K, Ctrl+K             | Selects the field's text                                                                                            |
| Home, End, Left, Right | Stay with the field's text                                                                                          |
| Tab                    | Stays in the palette: on the desktop the field is its one stop; on the phone, the field, Cancel, then the scope bar |

On the phone's scope bar, Left and Right move between scopes and choose them, Home and End go to the ends.

**Roles.** The palette is a `dialog` with `aria-modal` and the name "Search". The field is a `combobox` with `aria-expanded`, `aria-controls` naming the list, `aria-autocomplete="list"` and `aria-activedescendant` naming the active row; focus never leaves the field on the desktop. The list is a `listbox`; each group is a `group` named by its heading, whose coverage line is its description (`aria-describedby`). Rows and action rows are `option`s. "What search looks in" is not a listbox: it is a list of text.

**Names.** A row's name says what it is and where it leads: "Bot Otto, Operations"; "Task Weekly backup check, Otto, 2:14 PM"; "Message in Disk almost full on the media box, from you, Nov 16: Yes, clear the transcode cache."; "File notes/disk-2026-11-16.md, Otto"; "Link energy.example/heat-pumps/sizing, in Heat pump vs. gas furnace. Shift+Enter opens it in your browser."; "Routine Weekday tide digest, Pip, off. Opens Pip."; "Setting Accounts". A row that cannot open adds its line from section 9.

**What the live region says.** It is drawn from the same state as the list, 400 ms after the last source in view answers, and never while one is pending: the count by group, then "No matches in" and the sources it names, then each source that was not searched in full: "3 results: 3 messages. No matches in Bots, Tasks, Links, Routines and Settings. 1 bot's workspace was not searched." Others: "Messages couldn't be searched.", "More messages match.", "Some messages are still being indexed.", "No conversation is loaded, so no links were searched.", "Files weren't searched: type 2 or more characters." It says "No results for ephyr." only when the list does. On the phone it speaks for the chosen scope only. An announcement waiting for a query is dropped when the text changes. When "Search each bot for more" finishes: "4 of 4 bots answered. 30 messages returned.", naming any bot that couldn't be searched.

**Contrast and targets** follow `visual-language.md` §13. The ring on an opened message is `--accent-line`, a mark, never text.

## 13. What the gateway's facts drive

| On screen                                                                                                              | Gateway fact                                                                                                          | Evidence                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Messages: your messages and the bots' replies, not steps, tool results, reasoning or titles                            | Only `user` and `assistant` text blocks are indexed                                                                   | Research §1, live and source                                   |
| Whole words, the last also as a start, case and accents ignored; "Messages match whole words…"                         | FTS5 `unicode61 remove_diacritics 2`; `toFtsQuery` joins quoted words with AND and stars the last in the `scope` form | Research §2, live and source                                   |
| Newest first, and "best matches", never "recent messages"                                                              | Ordered by `bm25` per bot, then time; scores of two bots are not on one scale                                         | Research §3                                                    |
| "25 best matches … More messages match."                                                                               | `limit` 1-25; `truncated`                                                                                             | Research §5, §7, live                                          |
| "Search each bot for more", and what it cannot find                                                                    | A search per bot found 25 more for each of two bots the merged 25 left out; nothing pages within one set              | Research §7, live                                              |
| No "Search older"                                                                                                      | No cursor, offset, time range or time order                                                                           | Research §3, §6, source and live                               |
| The task list's filters in `scope`                                                                                     | `scope` takes `excludeCron`, `excludeSubagents`; archived left out by default                                         | Research §6, live                                              |
| "Still indexing…", "…in the gateway's archive…"                                                                        | `indexing`, `archivedTranscriptsExcluded`                                                                             | Research §4, §7 (indexing live; the archive count source only) |
| Going to the message, or "earlier than the 200 messages a conversation shows"                                          | `messageId` is the history row's `__openclaw.id`; the app loads the latest 200 rows                                   | Research §4, live                                              |
| Task titles on message rows the list does not hold                                                                     | The `scope` form returns the matched tasks' `sessions` rows                                                           | Research §4, live                                              |
| "No longer on the gateway's list", "no longer on this gateway"                                                         | A deleted task and a deleted bot's tasks leave every search; their history reads as zero rows without an error        | Research §9, live                                              |
| Asked after a 250 ms pause                                                                                             | 10-20 ms a search on about 400 tasks; 2 s the first after a start                                                     | Research §8, live                                              |
| Files: one call per bot, "Names in the workspaces of …", "Not searched: …", "stopped after 500 names or 5,000 entries" | `sessions.files.list {search}` walks the task's root; caps 500 and 5,000; no `root` for a task that is not there      | Research §10, live and source                                  |
| Files from 2 characters                                                                                                | A substring of the path; the walk's cap                                                                               | Research §10                                                   |
| Routines by name and description, on or off, "First 50 of 63"                                                          | `cron.list` `query` substring over id, name, description, bot id, display name; `enabled: "all"`; `total`, `hasMore`  | Research §11, live and source                                  |
| The same palette on a read-only connection                                                                             | Every source answered `operator.read`                                                                                 | Research §12, live                                             |
| Links only from loaded conversations                                                                                   | No gateway method searches links; the app holds the transcripts it loaded                                             | `docs/decisions.md`, "Transcripts"; F-033's cell               |
| The query not in the gateway's log                                                                                     | The development gateway's log has the method, time and size of a search, not its words                                | Research §8, live on that instance's configuration             |

## 14. Parity rows to reword

Only these cells change, statuses unchanged.

| Row   | Cell               | New wording                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-033 | Clawtrate target   | same; note: group chats keep a place until their own design; messages are searched in their text (the person's messages and the bots' replies, not steps or tool results) and links only in conversations the device has loaded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| F-033 | gateway dependency | partial: Bots from `agents.list`, all; routines from `cron.list {query, enabled: "all"}`, a lowercase substring of id, name, description, bot id and display name, in pages of up to 200; files from `sessions.files.list {sessionKey, search}`, one call per bot through a task whose root is the bot's workspace, a substring of the path, at most 500 matches or 5,000 entries; messages from `sessions.search {query, scope, limit}`, which matches only the text of user and assistant messages (not reasoning, tool calls, tool results or titles), every word as a whole word and the last also as a word's start, ignoring case and accents, ordered by relevance per bot; `limit` is 1-25 (10 when absent); results are `{sessionKey, sessionId, messageId, role, timestamp, snippet, score}` with the matched `sessions` rows and optional `indexing`, `truncated` and `archivedTranscriptsExcluded`; the `sessionKeys` form takes the keys of one bot only, and `query` alone returns an empty list. All `operator.read`. Group search is not described; links come from the transcripts the app loaded; settings search is the client's (`docs/research/search.md`). |
| F-240 | gateway dependency | partial: as F-033. The Group Chats scope has nothing to search until group chats exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F-268 | gateway dependency | partial: `sessions.search` (`operator.read`) has no cursor, offset, time range or time order; it returns the best `limit` (at most 25) matches by relevance and `truncated` when more match. A narrower set finds matches a wider one left out (one bot with `scope.agentId`, or `sessionKeys` of one bot; `docs/research/search.md` §7), but nothing reaches further back in time, and `archived` adds only archived tasks, which the app does not list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**F-268 needs a decision.** Its target is "same": "Search older" extends the search further back. The gateway's search has no time order and nothing that goes back in time, so a control with that name would promise what no request does. This design offers "Search each bot for more" (section 8), and leaves the row's target as it is. The wording proposed for a decision: "better: when more messages match than the gateway returns at once, "Search each bot for more" asks again bot by bot, up to 25 matches from each, and each bot's line says what was searched and whether more match; there is no "Search older", because the gateway's search has no time order or range."

## 15. For builders

### What each part uses

| Part              | Existing                                                                                     | New                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The rail's button | The round search button (its name and tooltip change, section 3)                             | `aria-haspopup="dialog"`                                               |
| The palette       | Avatars, the scrim, skeletons, the danger line's tone, `.menu`'s row look                    | Dialog, combobox, listbox with groups, action rows, the key hint       |
| Opening           | `selectBot`, opening a task, the Work pane's file opening, Settings' `openSettings(section)` | Scrolling the transcript to a message by `__openclaw.id`, and its ring |
| Links             | The link confirmation of #71                                                                 | The index of links in loaded transcripts                               |
| The phone         | The one-pane layout's full-screen sheet                                                      | The scope bar                                                          |

### What the engine, the bridge or the host must supply

| Need                                                                                                                                                                                                                      | Supplied by                                                                                                                                      | Notes                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| A search state per source and per query: asked, answered, failed, not asked (offline), with its coverage facts (`truncated`, `indexing`, `archivedTranscriptsExcluded`, per-bot root and `truncated`, `total`, `hasMore`) | The core                                                                                                                                         | Answers carry the query they were for; an older one is dropped            |
| `searchMessages(query, botId?)`, `searchRoutines(query, offset?)`, `searchFiles(query, bots)`                                                                                                                             | Bridge commands, each one request shape from section 5                                                                                           | Never `query` alone, never `sessionKeys` across bots                      |
| The task each bot's files are searched through                                                                                                                                                                            | The core, from the task list: the newest task whose row carries none of `spawnedWorkspaceDir`, `spawnedCwd`, `repositoryWorkspaceId`, `worktree` | A bot with none is "not searched"                                         |
| Whether a task, a bot and a message can be opened                                                                                                                                                                         | The task list, `agents.list`, and the open task's loaded rows                                                                                    | Never an empty history                                                    |
| Links in loaded transcripts                                                                                                                                                                                               | The core, from the transcripts it holds, after the scheme check of #71                                                                           | Only `http` and `https`                                                   |
| Keeping the query out of the log                                                                                                                                                                                          | The host                                                                                                                                         | A search request's params are not logged; only the method and its outcome |

### Order

1. The palette's frame, the keys and roles, and the device's sources (Bots, Tasks, Settings), with "What search looks in". The rail's button changes name, so the F-012 F-054 and F-267 visual checks address it as "Search", and the fixture's bot-filter helper presses ⌘⇧F instead of clicking it; their assertions stay.
2. Messages: the first search, its coverage lines, searching, failed and offline.
3. Opening a message in place, with the not-loaded, gone and failed cases.
4. Search each bot for more.
5. Routines.
6. Files, with the per-bot task choice and its bounds.
7. Links, once #71's confirmation exists.
8. The phone and its scopes; then the iPhone app's own screen from the same states.

### The prototype's states

`search.html` takes every parameter of `app.html`, and:

| Parameter         | Values                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `palette`         | `open`: the palette open on load                                                                                                                                                                                                     |
| `q`               | A query to type on load, for example `q=transcode`                                                                                                                                                                                   |
| `scope`           | On the phone: `all`, `messages`, `bots`, `groups`, `files`, `routines`                                                                                                                                                               |
| `each`            | `1`: "Search each bot for more" already run                                                                                                                                                                                          |
| `src`             | One source's condition: `msgfail`, `filesfail` (Pip's), `routinesfail`, `eachfail` (Pip's search in "Search each bot"), `indexing`, `archive`, `slow` (the gateway's groups stay searching); each fails once, and Try again succeeds |
| `historyfail`     | `1`: the opened message's conversation fails to load once                                                                                                                                                                            |
| `gone`            | A result that cannot open: `task`, `unlisted`, `bot`                                                                                                                                                                                 |
| `older`           | `1`: the message results are earlier than the loaded 200                                                                                                                                                                             |
| `links`           | `none`: no conversation is loaded yet                                                                                                                                                                                                |
| `state`, `banner` | As in `app.html`: `readonly`; `partial` (the task list was cut short); `offline`, `reconnecting`                                                                                                                                     |

The phone width shows the narrow desktop window's behaviour when a result opens (search closes, the one-pane detail shows); the iPhone app's own navigation stack, with Back to Search, is its own (`visual-language.md` §12) and is not drawn. Queries that show each path in the prototype's fixtures: `transcode` (messages, a file, all opening in place), `backup` (more messages match than 25; search each bot), `heat` (a task name and a link), `tide` (a routine that is off), `md` (files, with Marlow not searched), `acc` (a setting), `ephyr` (nothing anywhere), `t` (files asks for 2 characters).

## 16. Not covered here

- **Group chats.** Their own design is not merged. A place is kept in the palette's order (between Bots and Tasks) and the phone's Group Chats scope says they are not part of Clawtrate yet.
- **Several gateways.** Their own design is not merged. The palette searches the connected gateway; how results from several would be grouped and named is left to that design.
- **Loading earlier messages in a conversation.** `chat.history {messageId}` returns a page that starts at a message, with a cursor forward (research §4). With it, the conversation could show an older match in place; until the conversation design adds earlier pages, the palette says the message can't be shown in place.
- **A routine's own page.** Routines have no page yet; a routine result opens its bot.
- **Searching inside one bot's tasks in batches** to go past its best 25 (research §7).
- **Searching reasoning, tool calls or tool results.** The gateway does not index them; a plugin would have to.
- **A task's own folder or repository.** Files search covers bots' workspaces; the Work pane's filter (`work-pane.md` §3) searches one task's files.
- **Archived tasks.** The gateway can search them; the app lists none, so nothing would open.
