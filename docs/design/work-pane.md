# The Work pane

What sits beside the conversation: a task's files, what a bot made for the person, and the bot's computer. This is the third part of the design. `visual-language.md` defines the pane's frame (section 9: the Close button, the bot at the top, the tabs, docked and drawer); `conversation.md` defines the transcript it sits beside. This document decides what is inside the frame, how it moves and reads, and what each state rests on at the gateway.

The behaviour comes from the teardown's design proposal "files and the computer beside the conversation" (`docs/research/grok-bot-flows.md`, section 7) and is checked by `docs/parity.md`. Parity ids are given beside each requirement. Section 20 lists the gateway facts behind every state, with their sources. Section 21 lists the rows whose wording has to change. Section 22 is for builders.

The rule from `conversation.md` holds here too: **no state claims more than the gateway has reported.** A list that the gateway cannot keep current says when it was checked. A file the gateway will not send is not offered for download. A screen nobody is watching is not drawn.

The prototype shows all of it: `prototype/work.html` is the app with this pane working on local fixtures, and its address selects every state (section 22 lists them). The styles are in `prototype/css/work.css` and the behaviour in `prototype/js/work.js`.

## Contents

Part 1. The pane and its files

1. How the pane works
2. Shared rules
3. The Files tab
4. A file row
5. The workspace
6. Reading a file
7. Comparing with the earlier version
8. Files the pane cannot show
9. While a bot writes, and keeping the list current
10. From a step to its file, and back

Part 2. Artifacts and media

11. What a bot hands over
12. Cards in the conversation
13. An artifact in the pane
14. The media viewer

Part 3. The computer

15. The Computer tab
16. The machine
17. Watching
18. Taking over and handing back
19. When watching is not available, and recovery

Reference

20. What the gateway's facts drive
21. Parity rows to reword
22. For builders

# Part 1. The pane and its files

## 1. How the pane works

**Tabs.** Details, Files, Computer, as `visual-language.md` section 9 has them: plain words, centred, the chosen one on a `--bg-selected` pill. Nothing else is added to the row. The Computer tab adds one mark when the bot's browser is in use (section 15).

**What opens it, and on which tab.**

| From                                                          | Opens on                                                 | Focus, docked                         | Focus, drawer or sheet |
| ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------- | ---------------------- |
| The title pill, the Work pane button, ⌘\                      | The tab last shown for this task; Details the first time | Stays where it was                    | Close                  |
| "Open file" on a step (section 10)                            | Files, with that file open                               | The file's name, the reader's heading | The file's name        |
| A file or media card in the conversation (section 12)         | Files, with that item open                               | The item's name                       | The item's name        |
| The computer button in the conversation's header (section 15) | Computer                                                 | The Computer tab                      | The Computer tab       |

When the person asked for a particular file or the computer, focus goes to it, docked or not: they chose to go there. Opening the pane by itself does not take focus while docked, as `visual-language.md` says.

**The pane follows the open task.** It always shows the open task's bot and that task's files and computer. It never shows another task's.

- The pane remembers, for each task, its tab, where Files was (the folder or the file open, and the view), and how far each was scrolled. Switching tasks and coming back restores all of it.
- Switching to a task the pane has not shown yet keeps the pane open on the same tab and starts Files at its top.
- With no task open, Files and Computer show one line: "Pick one of <Bot>'s tasks to see its files." and "Pick one of <Bot>'s tasks to see its computer." Details keeps its own line.

**One navigation inside Files.** Files is a short stack: the task's list, then a folder of the workspace, then a file. Each level below the top has a Back button at its top left; Back returns to the level above with its scroll position and the row that was opened focused. There are no breadcrumbs and no second row of tabs.

**Reading place.** Opening, closing, docking and undocking the pane never move the reader in the conversation (`visual-language.md`, section 6). Nothing in the pane scrolls the conversation except "Show in chat" (section 10).

## 2. Shared rules

### Components reused

| Thing                                                                     | From                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The pane's frame, Close, the bot at the top, the tabs, docked and drawer  | `visual-language.md` section 9                                            |
| Empty states: a 44 px round mark, a title (15/500), one sentence          | `visual-language.md` section 9                                            |
| Fact rows: label and value, 42 px, one `--bg-bubble` block with hairlines | `.facts`, `visual-language.md` section 9                                  |
| Small grey words that head a group (13, faint)                            | `.work-section h3`                                                        |
| Round icon buttons, quiet variant                                         | `visual-language.md` section 4                                            |
| The two-way switch (26 px, 36 px on touch)                                | The Readable and Raw tabs of a step, `conversation.md` section 8 (`.seg`) |
| Code blocks, "Show all N lines", the gateway's truncation line            | `conversation.md` section 8                                               |
| Copy and what it says when it fails                                       | `conversation.md` section 9                                               |
| The step card and its activity block                                      | `conversation.md` sections 7 and 8, as they are today                     |
| State marks: working, failed, the hollow ring                             | `conversation.md` section 2                                               |
| The access bar and "Request access"                                       | `conversation.md` section 3                                               |
| A line that says something failed, on `--danger-soft`, with "Try again"   | `visual-language.md` section 8, "Could not refresh"                       |

### New components

Each is defined once, in the section named.

| Component                                                  | Class                     | Section |
| ---------------------------------------------------------- | ------------------------- | ------- |
| A file row                                                 | `.file-row`               | 4       |
| The level head: Back, a title, actions                     | `.files-head`             | 5       |
| The freshness line: when the list was checked, and Refresh | `.files-fresh`            | 9       |
| The reader: a file's name, its facts, its views            | `.reader`                 | 6       |
| The code view with line numbers                            | `.code-view`              | 6       |
| The change view                                            | `.diff`                   | 7       |
| A file or media card                                       | `.artifact`               | 12      |
| The media viewer                                           | `.viewer`                 | 14      |
| The computer tile and the full view                        | `.screen`, `.screen-view` | 17      |
| The control bar                                            | `.control-bar`            | 18      |

### Tokens

Two new colour tokens, both for the change view only:

| Token        | Light                                                | Dark                    | Use                        |
| ------------ | ---------------------------------------------------- | ----------------------- | -------------------------- |
| `--diff-add` | `rgba(10,110,92,.10)` (the value of `--accent-soft`) | `rgba(62,230,193,.12)`  | The fill of an added line  |
| `--diff-del` | `rgba(179,38,30,.09)` (the value of `--danger-soft`) | `rgba(255,138,128,.12)` | The fill of a removed line |

They are named for their use so that a later Appearance setting can change them without touching the accent. An added line is also marked "+" and a removed line "−" in the gutter, so colour is never the only cue. Text on both fills is `--text` (13.1:1 light, 11.0:1 dark at the lowest).

No other token is added. Sizes use the existing scale: rows 48 px (56 on touch), radius 14 for rows and 18 for blocks, 20 px from the pane's edges.

### Motion

The pane adds three motions, each with a still form, under both reduced-motion switches (`conversation.md`, section 2):

| Motion                                                                                                                        | Where                                                              | Still form                                |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| The working mark's arc                                                                                                        | A file being written (section 9), the computer in use (section 15) | The arc held still                        |
| A row or a step that "Show in chat" or "Show in Files" reached is filled with `--bg-selected` and fades to nothing over 1.6 s | Section 10                                                         | The fill stays until focus leaves the row |
| Skeleton rows pulse while a list loads                                                                                        | Section 3                                                          | Still grey rows                           |

Moving between levels of Files is instant. Nothing slides.

### What the connection may do

Everything in Part 1 works on a read-only connection. Listing a task's files, browsing the workspace, reading a file and comparing versions need `operator.read` only (section 20). The pane shows no access bar and no request for Files.

### Announcements

The conversation's polite live region (`conversation.md`, section 2) also speaks for the pane, and only for these:

- "notes.md updated" when an open file reloads with new content;
- "Couldn't load this task's files" and "Couldn't open notes.md";
- the result of an action the person took: "Downloaded notes.md", "Copied notes.md", "Couldn't copy. The text is selected.";
- "Showing the step in the chat", when "Show in chat" moves the conversation.

It does not speak list refreshes that changed nothing.

## 3. The Files tab

The top level of Files is the open task. It answers "what did this task touch?" first, and gives the way into the bot's whole workspace under it.

```
files-fresh          "Checked 5:36 PM"                 refresh
filter               (only when there are more than 12 files)
Changed              small grey word
  file-row ...
Read
  file-row ...
Sent in chat         (Part 2)
  artifact row ...
Otto's workspace     a row that opens the workspace (section 5)
```

**Groups.** Each group is headed by a small grey word and lists its rows newest first by modified time. A group with no rows is not shown.

| Group        | What is in it                                                 | From                                              |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------- |
| Changed      | Files the task created or changed                             | `sessions.files.list`, entries of kind `modified` |
| Read         | Files the task read and did not change                        | the same, kind `read`                             |
| Sent in chat | Files and media the bot attached to its messages in this task | `artifacts.list` for the task (section 13)        |

A file the task both read and changed is in Changed only.

**The workspace row** is the last row of the tab, always: a folder icon, "<Bot>'s workspace", a second line "All files, by folder", and a chevron. It opens section 5.

**Filter.** When the task has more than 12 files, a pill field (36 px, `--bg-inset`, placeholder "Filter by name") sits under the freshness line. It asks the gateway, which searches the task's files itself (`sessions.files.list` with `search`). While it is filtering, the groups show only matches, and a line under the field says "3 of 41 files". Clearing the field, or Escape in it, shows everything again. It filters this task's files only; "Sent in chat" is filtered by name on the device.

**States.**

| State                                | The tab shows                                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading, nothing loaded before       | Three skeleton rows (`--bg-bubble`, radius 14, 48 px), `aria-busy="true"` on the list                                                                                                                    |
| Loaded                               | The groups, then the workspace row                                                                                                                                                                       |
| Nothing touched yet                  | The empty state from `visual-language.md`: the file mark, "No files yet", "Files Otto reads or writes in this task appear here." Then the workspace row, so the workspace is one step away               |
| Couldn't load, nothing loaded before | The empty state's mark with the failed state's colour: "Couldn't load this task's files", the gateway's reason in one sentence, and "Try again" (default button). The workspace row stays below. (F-320) |
| Couldn't refresh, with a list loaded | The list stays. One line on `--danger-soft` above it: "Couldn't refresh. Showing the list from 5:36 PM." with "Try again". A successful retry removes the line and replaces the list. (F-320)            |
| The connection is lost               | The list stays, with "Last checked 5:36 PM" in the freshness line and no Refresh. Nothing is marked as writing.                                                                                          |

**Keyboard.** The tab panel holds, in order: Refresh, the filter, the rows, the workspace row. Each row is a button; Up and Down move between rows (Home and End go to the ends); Enter opens. Tab leaves the list after the last row. A group's grey word is a heading (`h3`), so a screen reader can move by group.

## 4. A file row

```
[icon]  notes.md                                   5:36 PM
        notes · 2.4 KB · Changed this run
```

- 48 px tall (56 on touch), padded 8 × 10, radius 14. Hover: `--bg-hover`. Pressed or open: `--bg-selected`.
- **Icon**: a 32 px tile, radius 10, `--bg-bubble`, with a 16 px icon in `--text-muted` for the kind: a page for text, the picture for an image, a page with lines for a document, a folder for a folder. A file being written shows the working mark in its place.
- **Name**: 14, `--text`, one line; a long name is cut in the middle so that its extension stays ("disk-report-…-final.md"). The full name is the row's tooltip.
- **Time**: 12, `--text-faint`, tabular, in the rail's short form ("5:36 PM", "Mon", "Nov 9"), at the right.
- **Second line**: 12, `--text-faint`: the folder it is in, relative to the task's root (absent at the root), the size, and, when it applies, one of:
  - "Writing…" in `--text-muted`, while a file tool call for this path is running (section 9);
  - "Changed this run" in `--text-muted`, medium weight, while the task's run is active and a file tool result in that run named this path (F-321);
  - "Changed last run", the same, after that run ended, until the next run starts;
  - "Missing", when the gateway reports the file no longer exists.
- Sizes read "820 B", "2.4 KB", "1.3 MB", in binary units with one decimal below 10. A size the gateway did not report is left out.

The run markers name only what a file tool's events established. A file a shell command changed carries no marker, because nothing reports which file a command touched; section 9 says how the tab says so. (F-321)

**Accessible name**: "notes.md, in notes, 2.4 KB, changed 5:36 PM, changed this run". Writing: "notes.md, Otto is writing it".

## 5. The workspace

"<Bot>'s workspace" is the bot's whole folder on the gateway, browsed one folder at a time. (F-152, F-446)

**The level head** (`.files-head`), the first row of every level below the top:

- A round quiet Back button, 32 px, named "Back to <the level above>": "Back to this task's files", "Back to notes".
- The level's title, 15/500, one line: "Otto's workspace" at the workspace's root, the folder's name below it. It is the level's heading (`h3`, `tabindex="-1"`, given focus when the level opens from a row).
- At the right, the level's actions: for a folder, the sort menu; for a file, section 6's.

Under the head, a folder shows its path from the workspace's root in 12 faint mono ("notes/2026"), the number of entries ("41 items"), and the freshness line.

**Rows.** Folders first, then files, each a file row (section 4). A folder's second line is its modified time and "Folder"; its size is not shown because the gateway does not report one. The task's run markers appear here too, on the same files.

**Sort.** A quiet text button at the right of the head: "Name" or "Modified", with a chevron. It is a menu button with two `menuitemradio`s, "Name" and "Modified, newest first". Folders stay first either way. The choice is kept for the bot. (F-446)

**Many entries.** The gateway sends a folder in pages of up to 250 entries, with the total. When there are more, the last row reads "Show 250 more · 250 of 1,240" and loads the next page in place; focus stays on the row, which moves down. The sort applies to what is loaded, and the head says so while there are entries not loaded: "Sorted by name among the 250 loaded."

**States.**

| State         | Shows                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Loading       | Three skeleton rows                                                                                                          |
| Empty folder  | One line, 14 muted: "This folder is empty."                                                                                  |
| Couldn't load | "Couldn't open this folder.", the reason, "Try again"; with a folder loaded before, the line above it instead (as section 3) |
| Gone          | "This folder no longer exists." and "Back"                                                                                   |

## 6. Reading a file

Choosing a file opens the reader in the pane, below the level head. The conversation stays where it is. (F-152)

```
files-head     [Back]  notes.md                      [Download] [Copy]
meta           notes · 2.4 KB · Today 5:36 PM
source         Written by Otto at 5:36 PM · Show in chat
views          [ Preview | Source | Changes ]
body           …
```

- **Meta** (12, faint): the folder, the size, the modified time in full.
- **Source line** (13, muted): which step last touched the file in this task and a link to it, "Show in chat" (section 10). With no such step, "No source in this task" in `--text-faint`, and no link. (F-447)
- **Views**, the step's two-way switch with up to three parts, shown only when there is more than one:

| File                     | Views                                               | Opens on                                |
| ------------------------ | --------------------------------------------------- | --------------------------------------- |
| Markdown                 | Preview, Source, and Changes when there are changes | Preview                                 |
| Other text and code      | Source, and Changes when there are changes          | Source                                  |
| Image                    | none: the picture                                   | the picture                             |
| Opened from a write step | the same set                                        | Changes, scrolled to that step's change |

- **Source** is the code view (`.code-view`): JetBrains Mono 13/1.55 on `--bg-bubble`, radius 14, 12 px inside. A gutter of line numbers (12, faint, tabular, right-aligned, not selected with the text) is on the left. Long lines scroll sideways inside the block; they do not wrap, because wrapped code misleads. "Wrap lines" is an item in the reader's menu for prose files.
- **Preview** renders markdown with the conversation's markdown rules (`visual-language.md` section 8), at 14 px, without a bubble.
- **An image** is drawn at the pane's width, never larger than its own size, on `--bg-bubble` with radius 14. Choosing it opens the media viewer (section 14).
- **Long files** show in full; the pane scrolls. The gateway never sends more than 256 KB of text, so nothing longer reaches the reader (section 8).

**Actions**, round quiet buttons at the right of the head:

| Action   | Present                             | Does                                                                                                                                                 | Name                      |
| -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Download | The gateway sent the file's content | Saves the file under its own name with the bytes the gateway sent, which are the file's bytes (section 20). Announces "Downloaded notes.md". (F-319) | Download notes.md         |
| Copy     | Text files                          | Copies the whole text, as section 9 of `conversation.md` copies                                                                                      | Copy the text of notes.md |

On the desktop the save goes through the system's save dialog, starting in Downloads. On the phone the reader's actions are "Share" and "Save to Files" (section 22).

**Keyboard.** From the head: Back, Download, Copy, then the views switch (one tab stop, Left and Right), then the body, which takes focus so that it can be scrolled with the arrow keys. While the pane is docked, Escape anywhere in Files below its top goes Back. As a drawer or a sheet, Escape closes the pane as it always does, so that one key never means two things there; ⌘[ is Back anywhere in Files, docked or not.

## 7. Comparing with the earlier version

"Changes" shows what this task did to the file. It has two sources, and says which it is using.

| The gateway can give                                              | Changes shows                                                                                                | Head line                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| The task works in a git checkout                                  | The file's patch since the task began (`sessions.diff`)                                                      | "Since this task began · +12 −3" |
| A file tool reported its change                                   | Each change the bot's file tools made in this task, newest first, each with its patch from the tool's result | "2 changes in this task"         |
| Both                                                              | The checkout's patch first, then the list of changes under "Changes by step"                                 | as above                         |
| Neither: the file changed without a file tool, outside a checkout | No switch part; the source line says "Changed by a command. There's no earlier version to compare."          |                                  |

**A change** is a block: a head line (13, muted) with the step's title in the step card's words ("Wrote notes.md"), its time, "+4 −1", and "Show in chat"; then the patch. A change the gateway marked too large to send reads "This change is too large for the gateway to send. +1,204 −880." with no patch.

**The patch** (`.diff`): unified, in the code view's face and size. Each hunk starts with a quiet line of its position ("Lines 12–18", 12 faint). Added lines are on `--diff-add` with "+" in the gutter; removed lines on `--diff-del` with "−"; unchanged lines plain. Line numbers, old and new, sit in two narrow gutters. Long lines scroll sideways with the block. A removed file reads "Deleted in this task" over its last patch; a created file reads "Created in this task", with every line added.

There are no versions apart from these. The gateway keeps no history of a file; what can be compared is what this task's checkout and tools report. (F-152)

**Keyboard and names.** Each change block is a `region` named by its head line. "Show in chat" on a block is a link button. A screen reader hears each patch line with its sign: "added: …", "removed: …".

## 8. Files the pane cannot show

The gateway sends a file's content only when it is UTF-8 text of at most 256 KB, or a recognised image of at most 5 MB from the workspace (256 KB from a task's files). Anything else is described, never offered as if it could be fetched. (F-449, F-319)

| The file                                      | The reader shows                                                                                                                                     | Actions                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Larger than the gateway sends                 | The facts block (below) and one sentence: "disk-usage.log is 3.4 MB. The gateway sends files up to 256 KB, so it can't be shown or downloaded here." | Show in chat, when there is a source |
| Not text and not an image (a PDF, an archive) | The facts block and: "report.pdf isn't text or an image. The gateway doesn't send files like this, so it can't be shown or downloaded here."         | Show in chat                         |
| Missing                                       | "This file no longer exists." With content loaded before, that content stays under the line "Showing what was loaded at 5:36 PM."                    | Download stays for that content      |
| Couldn't load                                 | "Couldn't open notes.md.", the reason, "Try again". Content loaded before stays under it. A successful retry replaces both. (F-320)                  |                                      |

**The facts block** is the `.facts` block from Details: Name, Size, Modified, Type (the media type, when the gateway names it), Folder. Each value can be selected; Name and Folder have copy buttons.

When the bot attached the same file to a message, the attachment is in "Sent in chat", and opening it there may succeed (section 13): attachments are fetched another way. The reader never guesses that two items are the same file.

## 9. While a bot writes, and keeping the list current

The gateway sends no event when a file changes (section 20). The pane learns of changes in three ways, and says when it last checked.

**When it fetches the list again.**

- When Files is shown, and when the person returns to it.
- When a file tool's result arrives in the open task: a write, an edit or a patch. One fetch for a burst of results, 600 ms after the last.
- When the person chooses Refresh.
- When the connection returns after a drop.

It never fetches on a timer. A list nobody is looking at is not fetched.

**The freshness line** (`.files-fresh`), at the top of every list: "Checked 5:36 PM" (12, faint), and at its right a round quiet Refresh button named "Refresh the file list". While fetching, the line reads "Checking…" and the button shows the working mark.

**Commands are not seen.** A shell command can change files without any file tool. When the task's run has run a command since the list was last fetched, the freshness line adds a second line: "Otto ran commands since then. Files they changed show after a refresh." It goes when the list is fetched. (F-448)

**A file being written.** From a file tool's start, which names the path, until its result, the file's row shows the working mark and "Writing…". A file that does not exist yet appears at the top of Changed in this state. If that file is open in the reader:

- a line with the working mark sits above the body: "Otto is writing this file. It updates when the write finishes.";
- the body keeps what was loaded, unchanged; nothing is shown half-written;
- when the result arrives, the file is fetched again. If it changed, the body is replaced in place, the scroll position is kept by line number, the line reads "Updated just now" for 4 seconds, and "notes.md updated" is announced. The Changes view gains the new change at its top. (F-448)

If the tool fails, the line becomes "Otto's write didn't finish. The file is as it was." for 4 seconds, in `--text-muted`, and the failed step is in the conversation as `conversation.md` shows it.

**An open file changed by a command.** It is reloaded only when the list is fetched and reports a newer modified time for it. Then the same replacement happens, with "Updated just now".

## 10. From a step to its file, and back

**From a step.** A step that read or wrote a file (`conversation.md` section 8, the kinds "Read a file" and "Write or edit a file") gains one link button in its readable view, after the path: "Open file". It is the step card as it is today, with one more control; the card itself is not changed.

- It opens the pane on Files with that file in the reader. For a write, the reader opens on Changes, at that step's change. For a read, on Source.
- Docked, the conversation does not move. As a drawer or a sheet, the pane covers it as usual.
- Its name is "Open notes.md in the Work pane".
- When the path no longer exists, the reader opens on "This file no longer exists." with the step's own content still in the step.

**From a file: "Show in chat".** (F-447)

| The file's source in this task                                        | "Show in chat" does                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A step last produced or changed it                                    | Scrolls the conversation to that step, opens its activity block and the step, and fills the step with `--bg-selected` for 1.6 s. Focus moves to the step's summary. |
| It arrived as an attachment to a message and no later step changed it | Scrolls to that message and fills its bubble the same way. Focus moves to the bubble.                                                                               |
| No source in this task (it was already in the workspace)              | Not a link: "No source in this task", in `--text-faint`                                                                                                             |

The scroll is the smallest that brings the step's first line to the reading line under the protected band (`conversation.md` section 18). A reader who was following the end stops following.

Where the pane goes:

| Pane          | After "Show in chat"                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Docked        | Stays open on the file. The file and its step are both in view.                                                                         |
| Drawer        | Closes, so the step is visible. The pane keeps its place: reopening it (⌘\, or the Work pane button) returns to the same file and view. |
| Sheet (phone) | The same as the drawer.                                                                                                                 |

**Coming back.** After "Show in chat", the step has a second link beside "Open file" for as long as the pane is not open on that file: "Back to notes.md". It reopens the reader where it was. ⌘[ in the conversation does the same while that link is present.

# Part 2. Artifacts and media

## 11. What a bot hands over

An **artifact** is something a bot attached to a message for the person: a document, a picture, a chart, a recording, a video. The gateway finds them in the task's transcript, as blocks of four types, and gives each an id, a title, and what it knows of its type, its size and how it can be fetched (section 20).

| What the person sees                  | What it is at the gateway                                                   | Card           |
| ------------------------------------- | --------------------------------------------------------------------------- | -------------- |
| A document, a spreadsheet, an archive | A `file` artifact                                                           | The file card  |
| A picture or a chart                  | An `image` artifact. A chart is a picture of a chart; nothing else marks it | The picture    |
| A recording                           | An `audio` artifact                                                         | The audio card |
| A video                               | A `video` artifact                                                          | The video tile |
| A page the bot made                   | A canvas document (not an artifact; section 12, "A page")                   | The page card  |
| A link in the bot's text              | Text. The client reads the address                                          | The link card  |

A file the bot wrote to its workspace but did not attach is not an artifact. It is in Files under Changed (Part 1), and its step is in the conversation. The two are never shown as one item: the gateway does not link a workspace file to an attachment, and the design does not guess from names.

**What can be fetched.** Each artifact says how its content can be downloaded, and the card and the pane follow it exactly:

| The gateway says                          | Open and Download                                                                                 | Preview                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Its bytes are in the transcript           | Available. Large items come through the gateway's five-minute download link instead of the socket | Made on the device from the bytes           |
| It is at an address the gateway serves    | Available, through that address                                                                   | Made on the device                          |
| It has no content to send ("unsupported") | Not available                                                                                     | Only what the transcript holds, if anything |

A picture larger than 256 KB is not sent inline when the task's pictures are listed. Its card shows the gateway's thumbnail, a PNG of at most 1200 px fetched over the gateway's download link, and fetches the full picture only when it is opened. The thumbnail route has not been exercised against a gateway (section 20); when it fails, the card falls back to its quiet tile (section 12).

**Versions.** The gateway keeps no link between two attachments, even with the same name. Each card is the item as it was sent, with the time it was sent; a later card with the same name is another item. A file's own history is in Files, in Changes (section 7). A page is the one exception: two cards for the same canvas document are the same page, so the earlier card reads "A newer version is below" and opens the newest.

## 12. Cards in the conversation

Cards sit in the transcript where the message put them, left-aligned with the bot's bubbles, under the bubble of the message they belong to. They follow `visual-language.md`: the raised fill (`--bg-bubble`), radius 18, no outline, no shadow. Nothing on them is coloured but the media itself.

### The file card (F-115)

```
[icon]  disk-report.md
        Markdown · 37 KB
```

- 64 px tall, padded 12 × 14, at least 240 px and at most 360 px wide (the column's width less 24 px on a phone).
- A 40 px tile, radius 10, on `--bg-pane`, holding the kind's icon in `--text-muted`: lines for a document, a page with lines for a PDF, a box for an archive.
- The name (15/500, cut in the middle so the extension stays) and, under it, the type in words and the size (13, faint): "Markdown · 37 KB", "PDF · 412 KB", "ZIP archive · 8.4 MB". The type comes from the media type the gateway reports, or from the extension; unknown is "File". A size the gateway did not report is left out.
- The whole card is one button. Choosing it opens the item in the pane (section 13). Its name: "disk-report.md, Markdown, 37 KB. Open in the Work pane."
- On hover or keyboard focus a quiet round "More" button (28 px) appears at its right; right-click and touch-and-hold open the same menu (below).

### Pictures (F-117)

- A picture is shown by itself, without a card: radius 18, at its own aspect ratio, at most 320 px wide and 320 px tall on the desktop, and the column's 78% on a phone. Its fill while loading is `--bg-bubble`.
- **Several in one message** form a grid: two columns, 4 px apart, each cell square, the whole grid 320 px wide with the outer corners at radius 18 and inner corners at 6. Five or more show four cells, the last reading "+3" on a dark scrim over the picture.
- Choosing one opens the media viewer at that picture (section 14). Its name is its title and "Open full size".
- On hover or keyboard focus, a 28 px "More" button appears at the top right of a picture or grid, on a dark disc, and opens the card's menu (below); on touch it is always shown.

### Video and audio (F-117)

- **Video**: a tile like a picture, the poster or the gateway's thumbnail behind a round 44 px play button on a dark disc, with the duration at the bottom right when it is known. It opens in the media viewer.
- **Audio**: a file card whose tile is a round play button. While it plays, the second line becomes a thin progress track with the time, "0:12 / 1:04". Only one recording plays at a time.

### Links (F-116)

- A link the bot wrote stays in its bubble as a link. When a message is only a link, or ends with one, a link card follows the bubble: a 40 px tile with the link icon, the link's text or the page's title (15/500), and the domain (13, faint).
- **The preview** is fetched by the device itself, on hover after 500 ms on the desktop and on touch-and-hold on the phone, never when the card is drawn. It sends no cookies and no credentials. It shows the page's title, its description and its preview image in a 320 px popover (`--bg-raised`, `--shadow-pop`, radius 14). A page that gives none shows its address alone. A failed preview shows the address and "No preview".
- Choosing the card opens the address in the system browser. Its name: "Library e-books, library.example. Opens in your browser."

### A page

A bot can make a page, an interactive document, on the gateway's canvas. The card is a file card with the page icon, the page's title, and "Page" as its type; its button is "Open".

- It opens in the media viewer's frame (section 14), which shows the canvas document in a web view, full window, with the conversation one Close away.
- **Not established.** The gateway serves canvas documents (`canvas.document.view`, and a hosted address for the canvas), but neither has been exercised (section 20). Until it is, a builder ships the card and checks the view against a development gateway first. When the page cannot be loaded, the viewer says "This page can't be shown here." with the gateway's reason and "Try again".

### The card's menu (F-118, F-304, F-305, F-306)

One menu for every artifact, opened by the More button, right-click, Shift+F10 or the Menu key on a focused card, and touch-and-hold on the phone. It is `.menu` (232 px). Items appear only when they can do something:

| Item                     | Present                                                            | Does                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open                     | Always                                                             | As choosing the card                                                                                                                                                   |
| Download                 | The gateway can send it                                            | Saves it under its own name, with its bytes. Announces "Downloaded disk-report.md" (F-118)                                                                             |
| Copy image               | A picture that can be fetched                                      | Puts the picture on the clipboard. Announces "Copied the image" (F-305)                                                                                                |
| Save image…, Save video… | A picture or a video that can be fetched                           | The system's save dialog, starting in Downloads (F-306)                                                                                                                |
| Copy text                | A text file that can be fetched                                    | Copies its text                                                                                                                                                        |
| Show in Files            | Always                                                             | Opens the pane on Files, at the item in "Sent in chat"                                                                                                                 |
| Download all 3           | The message has more than one item and at least two can be fetched | Saves each with its own name, into the folder the person chooses. When some cannot be fetched: "Download 2 of 3", and the announcement says which was left out (F-304) |

An item that cannot be downloaded has no Download in its menu, and its pane view says why (section 13).

### States of a card

| State                            | The card                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading a picture                | The tile in `--bg-bubble` at the picture's size, `aria-busy="true"`. Still under reduced motion                                                                              |
| The picture's preview isn't sent | The quiet tile: `--bg-bubble`, the picture icon, the title and size ("cache-growth.png · 3.1 MB"). It loads the gateway's thumbnail; until then it opens the viewer as usual |
| The thumbnail failed             | The quiet tile stays, with "No preview" in place of the size. Choosing it still opens the viewer, which fetches the picture itself                                           |
| The gateway has no content       | The card is drawn as usual and opens the pane's view, which says why it can't be opened (section 13)                                                                         |
| While the connection is lost     | Cards keep their last look. Opening one that is not on the device says "Can't reach the gateway. Try again when it's back."                                                  |

## 13. An artifact in the pane

Choosing a card opens it in Files, in the reader's frame (section 6), with the item's own head and facts. Back returns to "Sent in chat" in this task's files, whichever way the person came.

```
files-head     [Back]  disk-report.md                [Download] [Copy]
meta           Markdown · 37 KB
source         Sent by Otto at 5:37 PM · Show in chat
body           …
foot           Raw
```

- **Source line**: "Sent by <Bot> at <time>" and "Show in chat", which scrolls to the message and fills its card for 1.6 s, as section 10 does for a step. In a drawer, the drawer closes first.
- **Body**, by what the device can make of the bytes:

| The item                                                   | Body                                                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Text and code                                              | The code view (section 6)                                                                                                                      |
| Markdown                                                   | Preview, with Source beside it                                                                                                                 |
| A picture                                                  | The picture at the pane's width; choosing it opens the viewer                                                                                  |
| A PDF                                                      | Its pages, rendered on the device, one under another at the pane's width, with "Page 1 of 4" over each. Choosing a page opens the viewer at it |
| Audio                                                      | The audio player, full width                                                                                                                   |
| Video                                                      | The poster with the play button; it plays in the viewer                                                                                        |
| Anything else (an archive, a format the device can't draw) | The facts block (Name, Type, Size, Sent) and "There's no preview for this kind of file." with Download as a default button under it (F-307)    |

- **Actions**: Download when the gateway can send it, Copy for text and pictures.
- **Raw**, a text button at the foot, is the conversation's Raw (`conversation.md` section 9): the artifact's record as the gateway sends it (`artifacts.get`), with its id, type, media type, size, download mode, run and message. It never holds the bytes.

**States** (F-307):

| State                            | The pane shows                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                          | The head and facts at once, then "Loading disk-report.md…" with `aria-busy` where the body goes                                               |
| Couldn't load                    | "Couldn't open disk-report.md.", the gateway's reason in one sentence, and "Try again". A successful retry replaces the line with the preview |
| No content at the gateway        | The facts and "The gateway has this item's name and type, but not its content, so it can't be opened or downloaded." No Download              |
| A picture kept as a preview only | The picture, and under it: "The gateway kept a preview of this picture only. It can't be downloaded." No Download, no Copy image              |
| The device can't draw it         | As "Anything else" above, with Download                                                                                                       |

**"Sent in chat"** in the Files tab (section 3) lists the task's artifacts newest first, as file rows: the kind's icon (or a 32 px thumbnail for a picture), the title, and "Sent 5:37 PM · 37 KB". A page is listed with its type, "Page". They are fetched with the task's files and paged by the gateway; pictures come four at a time, so the group ends with "Show more" while there are more.

## 14. The media viewer

Pictures, video, PDF pages and pages open in one viewer that fills the window (F-117).

- **Frame.** A `dialog`, modal, over the whole window. Its ground is the dark theme's stage (`--bg` of `[data-theme="dark"]`), in either theme: a picture is judged on a dark, quiet ground, and a light frame would glare around a dark video. All of its controls use the dark theme's tokens, so it adds no colour.
- **Top bar**, 56 px, floating like the conversation's: at the left the item's title (15/500) and, when there are several, "2 of 3" (13, faint); at the right round buttons for Download, Copy image (pictures), and Close. Each has its name and tooltip: "Download usage.png", "Copy the image", "Close the viewer (Esc)".
- **The item**, centred and fitted to the space under the bar, never enlarged beyond its own size. Clicking a picture switches between fitted and actual size; at actual size it can be dragged.
- **Several items**: round 40 px buttons at the left and right edges, "Previous" and "Next", and Left and Right on the keyboard. A strip of 48 px thumbnails at the foot shows up to 12, the current one with a 2 px `--accent-line` ring.
- **Video**: the system's player inside the frame, with play and pause (Space), a scrubber, the time, and a speed menu, "0.5×", "1×", "1.5×", "2×" (a `menu` with `menuitemradio`s). The speed is kept for the session.
- **Right-click** on a picture: "Copy image", "Save image…"; on a video: "Save video…" (F-305, F-306).
- **Keys**: Escape closes. Left and Right move. ⌘C copies the picture. ⌘S saves.
- **Focus** moves to Close when the viewer opens and returns to the card, row or picture that opened it when it closes. Tab stays inside the viewer.
- **Motion**: it fades in over 120 ms; under reduced motion it appears at once. Moving between items is instant.
- **Phone**: full screen. Swiping left and right moves between items; swiping down closes. The top bar's actions are "Share" and "Save to Photos" (or "Save to Files" for a PDF).

**States.** Loading: the item's thumbnail, if there is one, under a working mark at the centre; otherwise the mark alone. Couldn't load: "Couldn't load usage.png." and "Try again", centred. An item with no content at the gateway is not offered in the viewer's sequence.

# Part 3. The computer

Part 3 follows in this document when it is finished. Sections 20 to 22 cover Parts 1 and 2 now.

## 20. What the gateway's facts drive

Names are from `docs/research/gateway-capabilities.md` (the map). "Source" means the installed OpenClaw 2026.10.6 package, by file and line. All of Part 1 is `operator.read`.

| Shown                                                         | Driven by                                                                                                                                                                                           | Source                                                                                                                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed and Read groups; size, modified time; Missing         | `sessions.files.list {sessionKey, search?}`: entries `{path, workspacePath, name, kind, missing, size, updatedAtMs}`; `kind` is `modified` or `read`                                                | Map §20 "Files and the library"; `dist/workspace-files-CaH9GWMT.mjs` lines 297-329 (`kind: "modified" : "read"`)                                                                         |
| The filter                                                    | `sessions.files.list` `search`                                                                                                                                                                      | Map §11                                                                                                                                                                                  |
| Workspace folders, sizes, times, total, pages                 | `agents.workspace.list {agentId, path?, offset?, limit?}`: `{entries[{path, name, kind, size?, updatedAtMs?}], totalEntries, offset}`; limit 250 by default, 500 at most; folders have no size      | Map §20; `dist/agents-workspace-Gm2ASifr.mjs` lines 14-15                                                                                                                                |
| A text file's content                                         | `sessions.files.get {sessionKey, path}` (adds `previewKind`, `contentEncoding`, `hash`) or `agents.workspace.get {agentId, path}`                                                                   | Map §20                                                                                                                                                                                  |
| The 256 KB limit; "too large"                                 | Both refuse a larger file: `session_file_too_large`, `workspace_file_too_large`, with the size and the limit                                                                                        | `dist/workspace-file-limits-loc-yzkf.mjs` (`WORKSPACE_PREVIEW_MAX_BYTES = 262144`); `dist/sessions-files-CeQfMksk.mjs` lines 356-362; `dist/agents-workspace-Gm2ASifr.mjs` lines 105-114 |
| Images up to 5 MB from the workspace                          | `agents.workspace.get` reads images by extension up to 5 242 880 bytes; a task's files cap images at 256 KB                                                                                         | `dist/agents-workspace-Gm2ASifr.mjs` lines 13 and 105-107; `dist/workspace-files-CaH9GWMT.mjs` lines 108-127                                                                             |
| "Isn't text or an image"                                      | `agents.workspace.get` refuses with `workspace_file_unsupported`; `sessions.files.get` returns `previewKind: "unsupported"` with no content                                                         | `dist/agents-workspace-Gm2ASifr.mjs` lines 127-131; `dist/workspace-files-CaH9GWMT.mjs` line 126                                                                                         |
| Download with the file's bytes                                | Text is decoded strictly as UTF-8 (`decodeUtf8Strict`), so encoding it again gives the same bytes; images come as base64 of the bytes read                                                          | `dist/agents-workspace-Gm2ASifr.mjs` lines 124-126; map §20. No HTTP route serves workspace files (map §20, "Downloads")                                                                 |
| Changes since the task began                                  | `sessions.diff {sessionKey, scope?}`: per file `status`, `additions`, `deletions`, and `patch`, or `truncated: true` when the patch is too large; `unavailableReason: "not_git"` outside a checkout | Map §20; `dist/session-diff.runtime-CLIrA0e-.mjs` lines 320-325 and 418-430                                                                                                              |
| Changes by step; the source line; "Show in chat"; "Open file" | File tools' `tool` start `{toolCallId, args.path}` and result `details {diff, patch, created, changed}`, joined on `toolCallId` and `runId`; the history's `toolCall` block keeps it after a reload | Map §20 "Which step produced a file"; map §19 "Tool events in depth"                                                                                                                     |
| An attachment as a source                                     | `chat.history` message attachments by `fileName`                                                                                                                                                    | Parity F-447 cell; map §19 "Attachments"                                                                                                                                                 |
| "Writing…"; "Changed this run"                                | The file tool's start (path) and result, in the run's `agent` `tool` stream (cap `tool-events`)                                                                                                     | Map §20; parity F-321 cell                                                                                                                                                               |
| No event when a file changes; commands not seen               | No workspace or file-change event exists; a write produced only `agent`, `chat`, `sessions.changed`, `session.message` and `presence`                                                               | Map §20 "Live changes"                                                                                                                                                                   |
| "Otto ran commands since then"                                | `exec` tool events in the open task                                                                                                                                                                 | Map §19 "Tool events in depth"                                                                                                                                                           |

What Part 1 assumes and the map does not establish: that `sessions.files.list` lists a file the moment its write result arrives. The map shows the list after a write (live), not its timing. Section 9's fetch after a result is the design's answer either way.

### Part 2

| Shown                                                 | Driven by                                                                                                                                                                                                                                                                         | Source                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The four kinds of artifact; a chart is only a picture | The transcript's blocks are collected by type: `image`, `input_image`, `image_url` as image; `audio`, `input_audio` as audio; `video`, `input_video` as video; `file`, `attachment`, `input_file`, and anything else with content, as file                                        | `dist/session-artifact-read-CN5ihAvI.mjs` lines 67-79 and 87-90                                                              |
| A card's title                                        | The block's `title`, else `fileName`, `filename`, `alt`, the attachment's label, else "<type> <n>"                                                                                                                                                                                | `dist/session-artifact-read-CN5ihAvI.mjs` line 123                                                                           |
| Type and size; the stable id; the run and message     | The summary's `mimeType`, `sizeBytes`, `id`, `runId`, `messageSeq`                                                                                                                                                                                                                | `dist/session-artifact-read-CN5ihAvI.mjs` lines 152-167                                                                      |
| What can be fetched: bytes, an address, or nothing    | `download.mode` `bytes`, `url` or `unsupported`, from the block's data or a safe address                                                                                                                                                                                          | `dist/artifacts-content-C0x4QGox.mjs` lines 23-73                                                                            |
| Download; large items through the link                | `artifacts.download {artifactId, sessionKey, transport?:"http"}` (`operator.read`): base64 inline, or a five-minute connection-bound address; inline transfer of a large item is refused with "request transport: http"; `unsupported` fails with `artifact_download_unsupported` | Map §11 and §20 "Downloads"; `dist/artifacts-CVcZMNpQ.mjs` lines 568-647. The HTTP form was not fetched live                 |
| A preview-only picture: no Download                   | A picture listed with `type: "image"` and without a downloadable source of its own gets an id starting `preview_`, source `session-transcript-preview`, and download mode `unsupported`                                                                                           | `dist/session-artifact-read-CN5ihAvI.mjs` lines 142 and 152-162                                                              |
| Pictures over 256 KB not sent inline; the thumbnail   | `IMAGE_INLINE_PREVIEW_MAX_BYTES = 262144`; `?variant=thumbnail` on the download address gives a PNG of at most 1200 px                                                                                                                                                            | `dist/session-artifact-read-CN5ihAvI.mjs` lines 66 and 135-151; map §11 (from `docs/gateway/clients.md`, not exercised live) |
| "Sent in chat", four pictures at a time               | `artifacts.list {sessionKey, type?, limit?, cursor?}`: limit and cursor only with `type: "image"`, limit 1-4; without a type, the whole list                                                                                                                                      | Map §20 "Artifacts across a bot's tasks"; `dist/artifacts-CVcZMNpQ.mjs` lines 495-496                                        |
| Raw on an artifact                                    | `artifacts.get {artifactId, …}`, the summary without data or address                                                                                                                                                                                                              | Map §11; `dist/artifacts-content-C0x4QGox.mjs` lines 6-9                                                                     |
| A page                                                | `canvas.document.view {docId}`, `canvas.document.preview`, the hosted canvas address in `hello-ok.pluginSurfaceUrls.canvas`, renewed with `plugin.surface.refresh` (`operator.read`)                                                                                              | Map §18 "Canvas". Not exercised: an unknown id returned `UNAVAILABLE`                                                        |
| Link previews                                         | Nothing: the device fetches them                                                                                                                                                                                                                                                  | Parity F-116 cell                                                                                                            |
| An attachment's place in the conversation             | `chat.history` attachments by `fileName`                                                                                                                                                                                                                                          | Map §19 "Attachments"; parity F-447 cell                                                                                     |

What Part 2 assumes and the map does not establish: that a bot's outgoing documents, recordings and videos reach the transcript as blocks of those types. The source collects them when they are there (above); the map names only image blocks with an `artifactId` (parity F-115's cell). The cards follow whatever blocks arrive; a task with only pictures shows only pictures.

## 21. Parity rows to reword

Only the Clawtrate column changes.

| Row   | New wording for the Clawtrate column                                                                                                                                                                                                                                                                 | Why                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| F-152 | better: on desktop and iPad, a Files tab in the work pane beside the conversation lists the files the task changed and read, and the Bot's workspace by folder; selecting a file previews text, markdown and images in the pane while the conversation stays visible (§7 proposal).                  | The gateway previews text and images only; PDF and media files have no preview path from the workspace.      |
| F-319 | better: "Download" from the Files tab (desktop, iPad) saves a file the gateway sends (UTF-8 text up to 256 KB, images up to 5 MB from the workspace) under its own name with identical bytes; for any other file the tab says why it cannot be downloaded (§7 proposal).                             | The gateway's read methods refuse larger and non-text, non-image files, and no route serves workspace files. |
| F-449 | better: a file with no supported preview shows its name, size, modified time and type, and says why it cannot be shown or downloaded; "Download" is offered only when the gateway sends the file (§7 proposal).                                                                                      | Same.                                                                                                        |
| F-448 | better: while a run creates, changes or deletes files with the file tools, the listing updates without a reload, and an open preview reloads when such a change lands; a change made by a command shows after a refresh, and the tab says when commands have run since it was checked (§7 proposal). | No file-change event exists; refetching after file-tool results misses commands.                             |
| F-321 | better: in the Files tab or section, files created or changed by the active run's file tools carry a "Changed this run" marker, and files changed in the previous run "Changed last run" (§7 proposal).                                                                                              | Attribution comes only from file-tool events.                                                                |

| F-304 | same; note: "Download all" saves every item in the message that the gateway can send; when one cannot be sent, the item reads "Download 2 of 3" and the result names what was left out. The check compares every downloadable item's name and bytes with the originals. | An artifact whose download mode is `unsupported` cannot be fetched. |
| F-307 | better: from a file card, a format the device cannot preview shows its details and "Download"; an item the gateway holds no content for says so and offers no "Download"; a failed load shows the error and "Try again"; a successful retry shows the preview (F-115 covers the successful card preview; the Files pane has its own rows). | The `unsupported` download mode. |

F-320, F-446 and F-447 are met as written, and so are F-115, F-116, F-117, F-118, F-305 and F-306. F-115's dependency cell says that only image blocks are named; the gateway's source collects file, audio and video blocks as artifacts too (section 20), and a builder correcting that cell can cite it.

## 22. For builders

### Part 1: what each part uses

| Part                   | Uses                                                             | New                                                           |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| The tab and its groups | `.work-sections`, `.work-section h3`, `.work-empty`              | `.files-fresh`, the filter field (the `.input` pill at 36 px) |
| A file row             | The rail's row metrics; state marks                              | `.file-row`                                                   |
| The workspace          | `.menu` for the sort                                             | `.files-head`                                                 |
| The reader             | `.facts`, `.seg`, `.code-block`'s copy behaviour, markdown rules | `.reader`, `.code-view`                                       |
| Changes                |                                                                  | `.diff`, `--diff-add`, `--diff-del`                           |
| Step links             | The step card's readable view, `.link-button`                    | "Open file", "Back to <file>"                                 |

### What the engine supplies

- For the open task: its files (from `sessions.files.list`), with each file's latest producing step, joined from the task's tool events and history (`toolCallId`, `runId`, `args.path`). The engine keeps this join; the gateway does not.
- The run marker for each path: "writing" between a file tool's start and result; "this run" and "last run" from results.
- A signal that the open task ran a command since a given time.
- Workspace pages by folder, kept per bot.
- File content with its hash, so a reload can tell "changed" from "the same".
- Per task: the pane's tab, the Files stack, each level's scroll. Per bot: the sort.

### What the gateway must supply

Nothing new for Part 1. Every call is `operator.read`.

### Order to build Part 1

1. The Files tab's top level from `sessions.files.list`, with its loading, empty, error and stale states, the freshness line and Refresh. Check F-152's listing and F-320.
2. The reader for text and markdown with the code view, Download and Copy; the facts block and the two "cannot show" states. Check F-319 and F-449 as reworded.
3. The workspace by folder, with paging and sort. Check F-446.
4. Refetch after file-tool results, the writing state and the command line. Check F-448 as reworded and F-321.
5. Changes: the step patches first (they need no git), then `sessions.diff`.
6. "Open file" on steps and "Show in chat" with its three cases. Check F-447.

### Prototype states for Part 1

`prototype/work.html` takes these in the address, with the prototype's own `theme`, `width` and `chrome`:

| Parameter              | Values                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel=open&tab=files` | The Files tab of the open task (Otto, "Disk almost full on the media box")                                                                                                |
| `files`                | `loading`, `empty`, `error`, `stale` (couldn't refresh), `writing` (a write in progress), `commands` (commands ran since the check), `many` (a long list with the filter) |
| `folder`               | A workspace folder to open: `/` for the root, `notes`, `logs` (more entries than one page)                                                                                |
| `file`                 | A file to open: `notes/disk-2026-11-16.md`, `inventory.md`, `logs/transcode.log` (too large), `notes/receipts.pdf` (not text), `charts/usage.png` (an image)              |
| `fileview`             | `preview`, `source`, `changes`                                                                                                                                            |

### Part 2: what each part uses

| Part                           | Uses                                                                   | New                        |
| ------------------------------ | ---------------------------------------------------------------------- | -------------------------- |
| The file, audio and page cards | The card frame of `conversation.md` (`--bg-bubble`, radius 18)         | `.artifact`                |
| Pictures and the grid          |                                                                        | `.media-grid`              |
| The card's menu                | `.menu`                                                                |                            |
| The link card's preview        | `.menu`'s surface (`--bg-raised`, `--shadow-pop`)                      | `.link-preview`            |
| An artifact in the pane        | The reader (section 6), `.facts`, Raw from `conversation.md` section 9 | the PDF pages, `.pdf-page` |
| The viewer                     | The dark theme's tokens; round icon buttons                            | `.viewer`                  |

### What the engine supplies for Part 2

- For each message, its artifacts in order (`artifacts.list` for the task, matched to messages by `messageSeq`), with their summaries.
- A fetch for one artifact that tries the bytes inline and moves to `transport: "http"` when the gateway asks; the five-minute address is used at once and never stored.
- For pictures over 256 KB, the thumbnail address, fetched when the card comes into view.
- Canvas documents named in the transcript, with their ids, so two cards of one page can be told apart from two pages.

### Order to build Part 2

1. The file card and the pane's view for text and markdown, with Download and Raw. Check F-115, F-118.
2. Pictures, the grid and the viewer with its keys. Check F-117, F-305, F-306.
3. The card's menu and "Download all". Check F-304 as reworded.
4. The states that come from the download mode and from failures. Check F-307 as reworded.
5. Audio and video, then PDF pages.
6. The link card and its preview. Check F-116.
7. The page card, once a development gateway shows a canvas document.

### Prototype states for Part 2

| Parameter                     | Values                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot=juniper&task=j2`         | Juniper's research task, with every kind of card                                                                                                                     |
| `artifact`                    | An item to open in the pane: `a-report`, `a-usage`, `a-terms` (a PDF), `a-screens` (no preview), `a-cover` (a preview only), `a-card` (no content), `a-note` (audio) |
| `artifactload`                | `failed`: the first opening of an item fails, and Try again succeeds                                                                                                 |
| `viewer`                      | An item to open in the viewer: `a-usage`, `a-growth`, `a-chart`, `a-walk` (video), `page`                                                                            |
| `menu=artifact&menuitem=<id>` | The card's menu for an item                                                                                                                                          |
