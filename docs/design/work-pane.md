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

**Tabs.** The pane has one tab bar, shared with the design of a bot's settings (`bots.md`, section 8): Details, Files, Computer, Settings, in that order, as `visual-language.md` section 9 draws them: plain words, centred, the chosen one on a `--bg-selected` pill. Details, Files and Computer are about the open task; Settings is about the bot, whichever task is open, and is specified there. This document adds nothing to the row except one mark on Computer while the bot's browser is in use (section 15); that mark's meaning is this document's. The arrows, Home and End move across all four; the bar behaves the same docked, as a drawer and as the phone's sheet. What the bar does when its tabs do not fit is the settings design's rule (`bots.md`, section 19), and this document follows it without adding to it.

**What opens it, and on which tab.**

| From                                                          | Opens on                                   | Focus, docked                         | Focus, drawer or sheet |
| ------------------------------------------------------------- | ------------------------------------------ | ------------------------------------- | ---------------------- |
| The title pill, the Work pane button, ⌘\                      | The tab last shown; Details the first time | Stays where it was                    | Close                  |
| "Open file" on a step (section 10)                            | Files, with that file open                 | The file's name, the reader's heading | The file's name        |
| A file or media card in the conversation (section 12)         | Files, with that item open                 | The item's name                       | The item's name        |
| The computer button in the conversation's header (section 15) | Computer                                   | The Computer tab                      | The Computer tab       |

When the person asked for a particular file or the computer, focus goes to it, docked or not: they chose to go there. Opening the pane by itself does not take focus while docked, as `visual-language.md` says.

**The pane follows the open task, and says where something belongs to the whole bot.** Details and Files are the open task's: its files, its artifacts, its steps. Computer is about the bot's computer as this task uses it: its recent actions and commands are this task's, but the browser it shows is the bot's own, and every task of that bot shares it, with its tabs and its sign-ins (section 17). The pane never presents a tab of that browser as belonging to this task.

- **One rule for the chosen tab.** The chosen tab belongs to the pane, not to a task or a bot: it stays as it is when the person switches tasks, and when they switch bots, so Settings, which is about the bot, does not jump away. The pane opens on the tab last shown, and on Details the first time.
- What the pane remembers for each task is where Files was (the folder or the file open, and the view) and how far each level was scrolled; coming back to a task restores it. Nothing else is kept per task.
- Switching to a task the pane has not shown yet starts Files at its top.
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
- **A recording or a video** from the task's folder plays in the audio player or the video tile of section 13.
- **Long files** show in full; the pane scrolls. The gateway never sends more than 256 KB of text, so nothing longer reaches the reader (section 8).

**Actions**, round quiet buttons at the right of the head:

| Action   | Present                                                           | Does                                                                                                                                                 | Name                      |
| -------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Download | One of the three read methods sent the file's content (section 8) | Saves the file under its own name with the bytes the gateway sent, which are the file's bytes (section 20). Announces "Downloaded notes.md". (F-319) | Download notes.md         |
| Copy     | Text files                                                        | Copies the whole text, as section 9 of `conversation.md` copies                                                                                      | Copy the text of notes.md |

On the desktop the save goes through the system's save dialog, starting in Downloads. On the phone the reader's actions are "Share" and "Save to Files" (section 22).

**Keyboard.** From the head: Back, Download, Copy, then the views switch (one tab stop, Left and Right), then the body, which takes focus so that it can be scrolled with the arrow keys. While the pane is docked, Escape anywhere in Files below its top goes Back. As a drawer or a sheet, Escape closes the pane as it always does, so that one key never means two things there; ⌘[ is Back anywhere in Files, docked or not.

## 7. Comparing with the earlier version

"Changes" shows what changed in the file, from two sources, and each says exactly what it is compared with. Only one of them is this task's own work.

| The gateway can give                                              | Changes shows                                                                                                                                                                                                                                 | Head line                                                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The task works in a git checkout                                  | The file's patch from `sessions.diff`: the checkout compared with where its branch left the default branch (the merge base), or, on the default branch itself, with the last commit. It can include changes made before this task, by anyone. | "Compared with main · +12 −3", or "Compared with the last commit · +12 −3", from the result's `baseRef`; under it, 12 faint: "In this checkout. This can include changes made before this task." |
| A file tool reported its change                                   | Each change the bot's file tools made in this task, newest first, each with its patch from the tool's result                                                                                                                                  | "2 changes in this task"                                                                                                                                                                         |
| Both                                                              | The list of changes under "This task's changes" first, then the checkout's patch under "In the checkout"                                                                                                                                      | as above                                                                                                                                                                                         |
| Neither: the file changed without a file tool, outside a checkout | No switch part; the source line says "Changed by a command. There's no earlier version to compare."                                                                                                                                           |                                                                                                                                                                                                  |

**A change** is a block: a head line (13, muted) with the step's title in the step card's words ("Wrote notes.md"), its time, "+4 −1", and "Show in chat"; then the patch. A change the gateway marked too large to send reads "This change is too large for the gateway to send. +1,204 −880." with no patch.

**The patch** (`.diff`): unified, in the code view's face and size. Each hunk starts with a quiet line of its position ("Lines 12–18", 12 faint). Added lines are on `--diff-add` with "+" in the gutter; removed lines on `--diff-del` with "−"; unchanged lines plain. Line numbers, old and new, sit in two narrow gutters. Long lines scroll sideways with the block. A removed file reads "Deleted in this task" over its last patch; a created file reads "Created in this task", with every line added.

There are no versions apart from these. The gateway keeps no history of a file. The step patches are the only comparison that belongs to this task; the checkout's patch belongs to the branch, and the pane never labels it "since this task began". The gateway's record of which files were already changed when the task started only hides files that have not changed since; it does not remove earlier edits from a file that has. (F-152)

**Keyboard and names.** Each change block is a `region` named by its head line. "Show in chat" on a block is a link button. A screen reader hears each patch line with its sign: "added: …", "removed: …".

## 8. How a file's content reaches the pane, and what it cannot show

### Three ways in

A file's bytes reach the client through one of three read methods, each with its own limits. All three are `operator.read` (section 20).

| Method                  | For                                                                | Sends                                                                                                                                                | Limit                                                                                       |
| ----------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `sessions.files.get`    | A file in the task's own folder                                    | UTF-8 text; a picture in a browser image format                                                                                                      | 256 KB                                                                                      |
| `agents.workspace.get`  | A file anywhere in the bot's workspace                             | UTF-8 text, up to 256 KB; a picture whose extension and detected type are both on its list (AVIF, BMP, GIF, HEIC, HEIF, JPEG, PNG, WebP), up to 5 MB | 256 KB for text, 5 MB for a picture                                                         |
| `sessions.files.assets` | Files in the task's own folder, named relative to a document there | Pictures, recordings and videos (by their detected type), and CSS and JavaScript                                                                     | 1 MB each, 4 MB and 64 files in one call; 256 KB when the task works in a stored repository |

The third method is meant for the pictures and stylesheets a document refers to. Naming a file relative to its own folder is within that contract, and it is the only read method that sends a recording or a video.

### What the pane does with each file

| The file                                                | Opened from     | Fetched with                                                                                                                              | The pane                                                             |
| ------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Text up to 256 KB                                       | Either list     | `.get` for its list                                                                                                                       | Shows it; Download and Copy                                          |
| A picture up to 256 KB, in the task's folder            | The task's list | `sessions.files.get`                                                                                                                      | Shows it; Download                                                   |
| A picture over 256 KB in the task's folder              | The task's list | `agents.workspace.get` by the file's `workspacePath` when the list gives one (up to 5 MB); otherwise `sessions.files.assets` (up to 1 MB) | Shows it; Download                                                   |
| A picture up to 5 MB elsewhere in the workspace         | The workspace   | `agents.workspace.get`                                                                                                                    | Shows it; Download                                                   |
| A recording or a video up to 1 MB, in the task's folder | The task's list | `sessions.files.assets`                                                                                                                   | Plays it in the pane's player (section 13); Download                 |
| Anything else                                           |                 | Nothing                                                                                                                                   | The facts block and one sentence that names the limit it met (below) |

Download saves the bytes the method returned, which are the file's bytes (section 20). The pane never tries a method it knows will refuse, and when one refuses anyway it shows the refusal's reason.

### What it cannot show

Anything outside the table above is described, never offered as if it could be fetched (F-449, F-319). The sentence says which limit applies, in this order:

| The file                                                                                                 | The sentence                                                                                                                                             | Actions                              |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| A PDF, an archive, a document, or any other kind that isn't text or a picture, recording or video        | "report.pdf isn't text or media. None of the gateway's file methods sends files like this, so it can't be shown or downloaded here."                     | Show in chat, when there is a source |
| Text larger than 256 KB                                                                                  | "transcode.log is 3.4 MB. The gateway sends text up to 256 KB, so it can't be shown or downloaded here."                                                 | Show in chat                         |
| A recording or video over 1 MB in the task's folder, or a picture over 1 MB there with no workspace path | "walkthrough.mp4 is 14 MB. The gateway sends recordings and videos from a task's folder up to 1 MB, so it can't be played or downloaded here."           | Show in chat                         |
| A recording or video outside the task's folder                                                           | "This recording is in Otto's workspace, outside this task's folder. The gateway sends recordings only from a task's folder, so it can't be played here." | Show in chat                         |
| A picture over 5 MB in the workspace                                                                     | "photo.heic is 7.2 MB. The gateway sends pictures from the workspace up to 5 MB."                                                                        | Show in chat                         |
| Missing                                                                                                  | "This file no longer exists." With content loaded before, that content stays under the line "Showing what was loaded at 5:36 PM."                        | Download stays for that content      |
| Couldn't load                                                                                            | "Couldn't open notes.md.", the reason, "Try again". Content loaded before stays under it. A successful retry replaces both. (F-320)                      |                                      |

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

## 15. The Computer tab

The Computer tab is where a person sees what the bot is doing on a machine: its browser, live, when the gateway can show it; which machine it works on and how that machine is; and what it did there, in order, with every action one step from its raw call.

**Whose browser it is.** The computer plugin gives each bot one browser, and every task of that bot uses it: all its sessions see the same tabs and the same sign-ins, and one person's control blocks the bot in all of them (section 20). Nothing the gateway sends says which task opened a tab. So the screen section always names the browser as the bot's, never as this task's, and says it is shared by the bot's tasks; recent actions and commands are this task's own.

```
needs-you banner     only while the bot waits on the person and its browser can be taken
screen               the tile, its tabs, Watch / Open / Stop watching
machine              where the bot's commands and browser run, and their state
recent actions       the bot's browser and command actions in this task
commands             what it ran, how each ended, what is still running
```

Each section is headed by a small grey word, as Details' groups are. Sections without anything to say are left out, except the screen section, which always says why there is nothing to watch.

**The computer button and the tab's mark** (F-139). The conversation's header gains a round icon button with the screen icon, left of the Work pane button, once the open task has used the browser tool. It opens the pane on Computer. While a browser tool call is running in the task, the button carries an 8 px `--accent-line` dot at its top right, with a 2 px ring of the button's fill, and the Computer tab carries a 6 px dot after its word. The accent here is the bot working, its one allowed use. Names: "Juniper's computer. Show the computer" and, while the browser is in use, "Juniper's computer, in use. Show the computer". The dot is drawn from tool events, at `operator.read`, so it shows on every connection and with or without the plugin.

## 16. The machine

The pane says where this task's work runs only as far as the gateway has established it, and labels each fact with where it came from (F-147). A setting is never shown as where a task's commands ran.

| Row             | Shows                                                                                                                                                              | Established by                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Commands ran on | The machine named by the latest command approval in this task: "media-box, named by the approval at 5:31 PM". With none in this task: "Not reported in this task." | An exec approval request's `host` and `nodeId`, which the interactive tier receives                                    |
| Set for <Bot>   | The bot's setting, in `--text-faint`: "Commands: media-box", or "Commands: the gateway's machine"; under it, "A setting for Otto. A task can run somewhere else."  | The bot's `tools.exec.host` and `tools.exec.node`, or the gateway's defaults when the bot sets none, from `config.get` |
| Browser         | "The gateway's machine, in Juniper's own browser" when the computer plugin is installed and Juniper is configured for it. Otherwise "Not reported."                | The plugin pins a configured bot's browser calls to the gateway's machine                                              |

The gateway does not report a task's effective routing to a client. A task's commands can be routed to a node by an admin, a whole task can be placed on a device, and neither shows on the task's row. So "Commands ran on" waits for evidence, and "Set for" says it is a setting.

Under each node named above, one facts block (`.facts`):

| Row       | Shows                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State     | "Connected" or "Not connected", from the node's `connected`, with the done mark or the failed mark. Colour is never the only cue (F-148). Nothing reports a node that is reconnecting, so there is no such state. When the node's record couldn't be read: "Unknown", with the hollow ring, and the last value read, with its time: "Connected when last read, 5:38 PM". A failed read is never shown as "Not connected". |
| Last seen | "40 s ago", "5:12 PM"; with the reason the node gave when it has one: "5:12 PM, while going to sleep". From the node's `lastSeenAtMs` and `lastSeenReason`: when the gateway last heard from the node, for any reason. It is not a heartbeat, and is never called one.                                                                                                                                                    |
| Load      | "4 cores, 0.6 average"                                                                                                                                                                                                                                                                                                                                                                                                    |
| Memory    | "3.1 of 8 GB free"                                                                                                                                                                                                                                                                                                                                                                                                        |
| Disk      | "780 GB of 2 TB free", only when the node reports its disk                                                                                                                                                                                                                                                                                                                                                                |

- Load, memory and disk come from the node's latest host stats: the `node.hostStats` event, or the copy on the node's record, which is how the pane starts. A line under them gives their time, "As of 5:40 PM", from the stats' `updatedAtMs`; when that is more than three minutes old the line reads "As of 5:31 PM. The node hasn't sent newer figures." A node started with a restricted command list sends none: then the rows are left out and one line says "media-box doesn't report its load." Nothing reads zero.
- The block's foot is a link button, "Node settings", which opens Settings at that node (the Settings screen is not part of this design).
- **When the bot is set to run commands on the gateway's own machine**, there is no node block; the gateway's connection is the rail's footer's.
- **Machines and bots.** When other bots are set to use the same node, a line under the block says so, as a setting: "Pip is also set to run commands here." (F-275)

## 17. Watching

### The screen section, before anything is shown

The bot's browser is not drawn until the person asks for it. A signed-in browser can show mail, banking or messages, and the pane is beside a conversation that may be on a shared screen or in a meeting.

- **The tile**: 16:9, the pane's width, radius 14, filled with the dark theme's `--bg-inset` in either theme, with the screen icon and a centred pill button, "Watch" (`--bg-raised`, `--shadow-button`, 36 px, the eye icon). Under it a caption (13, muted): "<Bot>'s browser, used by all of its tasks", then, on a second line, the shown tab's title and domain when the gateway lists them: "Your account · library.example".
- **Tabs**: when the bot's browser has more than one tab, a list under the caption: each tab a row with its title and domain, the one shown marked with `aria-current`. Choosing a row shows that tab. Titles and addresses come from the gateway's tab list, not from the picture. A tab may have been opened by another of the bot's tasks; the list never marks one as this task's.
- **"Show live when I open Computer"**, a checkbox under the tile, off by default and kept for each bot on this device. With it on, opening the tab starts watching at once.
- **The first time** a person watches a given bot on this device, one line sits above the tile, on `--bg-bubble`: "This is Juniper's browser, used by all of Juniper's tasks. It may be signed in to sites, and what you see here is live: anyone who can see your screen sees it too." with "Got it". It does not come back for that bot.

### Watching in the pane

Choosing Watch opens the view (F-140, F-143):

- The tile shows the live picture, scaled to fit, with a small "Live" label at its top left on a dark disc, and the bot's pointer as the picture shows it.
- Over the tile's bottom right, two round buttons on dark discs: "Open" (expand) and "Stop watching" (the eye with a bar). The caption updates as the page navigates.
- While the picture is loading: the dark tile with the working mark and "Connecting to Juniper's browser…". The gateway answers within a few seconds or the view ends (below).

### The full view ("Open")

"Open" fills the window with the same live picture, as Grok Bot's takeover screen does; the conversation and the pane are one Close away. It is a `dialog`, modal, on the dark theme's tokens in either theme, like the media viewer (section 14).

- **Top bar**, 56 px: at the left the bot's avatar (22 px), "<Bot>'s browser" (15/500), and the page's title and address (13, faint), updated on every navigation. At the right: "Take control" (default button, the hand icon) and a round "Close" (the collapse icon, named "Close the full view (Esc)").
- **The picture**, centred and letterboxed, at most its own size. In Watching mode the pointer over it is the ordinary arrow, and clicks and keys are not sent.
- **Tabs**: when there are several, a row of pills under the bar, the shown one selected.
- **The mode** is always in words in the bar: "Watching" or "You have control".
- Escape closes the full view and returns focus to "Open". Watching continues in the tile.

### How a view ends

| Cause                                                                                             | What the person sees                                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Stop watching, or Close and then Stop watching                                                    | The tile returns to "Watch". Nothing of the picture remains                                                         |
| Leaving the Computer tab, closing the pane, switching task or bot                                 | The same, at once                                                                                                   |
| The window is hidden or minimised, or the device locks                                            | The view stops; on return the tile shows "Watch", or watches again when "Show live" is on                           |
| The bot closed the tab                                                                            | "Juniper closed this tab." over the dark tile, and the tab list. The gateway closes the stream with "target closed" |
| The gateway ended the view (it stopped being renewed, or this device lost its access to the task) | "The view ended. The gateway stopped sending it." with "Watch again"                                                |
| The connection to the gateway dropped                                                             | "The view ended when the connection dropped." The tile does not reconnect by itself                                 |

### A view from start to end

Every Watch starts a new view, with its own number on this device. Every answer the gateway sends for a view (its ticket, its stream, its frames, its renewals) is matched to that number, and an answer for a view that has ended is disposed of at once. Nothing appears after the person has left.

| The view is | Entered when                                                | If the person stops watching or leaves (any cause in "How a view ends")                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connecting  | Watch was chosen; `view.open` was asked                     | The view ends at once and the tile shows "Watch". When the ticket arrives later, it is not used: the stream is never opened, and the ticket expires unused after its 60 seconds. If the stream had opened, it is closed at once. Nothing is drawn |
| Live        | The first frame arrived on the stream that this view opened | Renewals stop, the stream is closed, the decoded picture and any frame not yet drawn are dropped, and the tile shows "Watch"                                                                                                                      |
| Ending      | A cause in "How a view ends"                                | Frames still in flight are dropped before they are decoded                                                                                                                                                                                        |

The gateway keeps an unrenewed stream for up to 20 seconds before it closes it; the person never sees that: the device closes its side at once.

### What is never captured

- Frames are drawn and dropped. The app never writes one to disk, to a cache, to a log, to Raw, to a notification, or to a crash report, and offers no screenshot or recording of the view.
- When the app goes to the background on the phone, the view is covered before the system takes its snapshot for the app switcher.
- Text typed while in control (section 18) is never shown back: the control's Raw records each `input` call with its kind and position, and "12 characters typed" in place of the text.
- A read-only connection never receives a frame (section 19).

## 18. Taking over and handing back

**When a bot needs the person** (F-144). The gateway has no "computer card": a bot that needs a sign-in, a code or a check asks with its question tool, offering answers such as "I'm done" and "Skip". The conversation shows that question as its question card (`conversation.md` section 13), unchanged. The Computer tab adds, while that question is pending and the bot's browser can be taken:

- a banner at the top of the tab, on `--warn-soft`, with the waiting mark: "Juniper is waiting for you", the question's own title on the next line, and two buttons, "Take control" (primary) and "Show the question", which scrolls to the card;
- nothing else. The banner never answers the question; only the person does.

The banner links a pending question of this task's bot to that bot's browser. It never guesses from the question's words that the browser is involved.

**Taking control** (F-142, F-145). "Take control" in the banner or the full view's bar asks the gateway for control. The full view opens if it was not open. "You have control" is shown only after the gateway's answer grants it, with the lease's number (its generation), and only while each renewal confirms the lease. Never on a local click, and never because frames still arrive.

| Moment                                                                                           | The bar says                                                                      | Controls                                                                                         |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Asked                                                                                            | The working mark, "Waiting for Juniper to finish what it's doing in the browser…" | "Cancel"                                                                                         |
| Granted                                                                                          | The hand icon, "You have control". The picture gets a 2 px `--accent-line` ring   | The question's answers, when the question can be answered here (below); then "Give back control" |
| Refused: the bot is still acting (after 15 s)                                                    | "Juniper is still acting in this browser. Try again in a moment."                 | "Try again"                                                                                      |
| Refused: someone else has or is taking control                                                   | "Someone on another device has control of Juniper's browser."                     | none; Watching continues                                                                         |
| Ended by the gateway: the lease expired, was revoked, or a renewal came back without renewing it | "Your control ended. The gateway stopped hearing from this device."               | "Take control" again                                                                             |

**Cancelling, and an answer that comes late**. The gateway has no way to withdraw a request for control: it answers once, granted or busy, up to 15 seconds later. So:

- "Cancel" while waiting, or leaving (closing the pane, another tab, another task or bot, the window hidden, the device locked), ends the request on this device at once. The bar goes; nothing says "You have control".
- When the answer to an abandoned request arrives granted, the device gives control back at once with that answer's generation, sends no input, and shows nothing. The gateway's control events still record both moments, so the conversation gains the two event lines below; they are true, and they are the only trace.
- A busy answer to an abandoned request is dropped.

**Leaving while in control.** Closing the full view keeps control: the tile shows "You have control" and "Give back control", so the lease is never held out of sight of a control that ends it. Everything else that ends a view (another tab, closing the pane, another task or bot, the window hidden, the device locked) gives control back first, by the steps below, then ends the view. Input not yet sent is dropped, never sent after control was given back; input is sent one call at a time, in order. If the connection drops, the device cannot give control back: input stops at once, the bar says "Connection lost. Your control ends when the gateway stops hearing from this device, within about 20 seconds.", and the lease ends at the gateway.

**Which questions the bar can answer**. The bar shows a question's answers only when the conversation's question card would answer it by one choice: one question, one answer allowed, two to four options, each a label. Then each option is a button, in the question's order, the first primary; "Give back control" follows, quiet. For any other shape the question card is the only place to answer: several questions, several answers allowed, an answer the person types, or a record this app shows readable only (`conversation.md` section 13). The bar then shows "Give back control and answer" (primary): it gives control back by the steps below, closes the full view, and moves focus to the question card.

**Handing back, in order**. Answering and giving control back are two separate calls, and the gateway confirms each. The device gives control back first and answers only once the gateway has confirmed it. So the bot never resumes while its browser is still held, and a failure never leaves an answered bot facing a blocked browser.

| Step                                                           | The bar says                                              | When the gateway answers                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Giving control back (`control.release` with the generation) | "Giving control back…" with the working mark; input stops | Confirmed (the call succeeds, or a `released` control event for this lease arrives): go to step 2, or end there for "Give back control"                                                                                                       |
|                                                                |                                                           | Refused: "Couldn't give control back. You still have control." with "Try again". The answer is not sent                                                                                                                                       |
|                                                                |                                                           | No answer: "No answer from the gateway. You may still have control." with "Check again", which renews with the generation: a renewed lease means control is still held; an unrenewed one means it has ended. Until then nothing claims either |
| 2. Answering (`question.resolve` with the chosen option)       | "Sending your answer…"                                    | Applied: the bar goes, the full view returns to Watching, and the question card shows its answered state. The bot then carries on by itself, as the gateway's events show                                                                     |
|                                                                |                                                           | Already resolved (answered elsewhere, dismissed or expired): "Juniper's question was already answered on another device." or "…had expired." Nothing is sent again                                                                            |
|                                                                |                                                           | Refused or no answer: "Couldn't send your answer. Control is back with Juniper; answer in the chat." with "Show the question"                                                                                                                 |

**While in control, the question can change.** When the question is answered or dismissed on another device, or expires, while the person holds control, its buttons leave the bar and one line takes their place: "Juniper's question was answered on another device." (or "…was dismissed." or "…expired."). Control stays with the person, and "Give back control" becomes primary.

**Give back control alone** gives control back by step 1 and stops there. The bot is still waiting for its answer, and the banner and the question card say so: "Juniper is still waiting for you." Releasing control alone does not resume the bot.

**In the conversation.** Control changes are event lines (`visual-language.md` section 8), from the gateway's control events: "You took control of Juniper's browser · 3:12 PM" and "You gave control back · 3:14 PM"; for another device, "Someone on another device took control of Juniper's browser". A call the bot's browser tool makes while the person has control, from any of its tasks, is refused by the gateway, and arrives as a blocked step, shown as `conversation.md` shows a call that was blocked; the family of plain-words cards decides its final wording.

**Keyboard and names.** In the full view, Tab moves through the bar's controls only; the picture is one focusable region named "Juniper's browser, live" (and "…, you have control"). While in control and focused, typing goes to the page; Escape does not leave control, it moves focus to "Give back control", so that a reflex never hands back by accident and never sends Escape to the page either. ⌘↵ chooses the bar's primary button.

**Motion.** The ring appears without animation. The working mark in "Waiting for Juniper…" turns; under reduced motion it holds still.

## 19. When watching is not available, and recovery

### Without the computer plugin

Watching and taking control need Clawtrate's computer plugin on the gateway. The gateway's own browser view needs full admin access, which Clawtrate does not ask for (section 20). Without the plugin the screen section is a calm empty state, never a broken tile:

- the round mark with the screen icon, "Watching isn't set up on this gateway" (15/500);
- "To watch Juniper's browser here, the gateway's owner installs Clawtrate's computer plugin and gives Juniper a browser of its own." (14, muted);
- a quiet link, "What the plugin adds", which opens the plugin's page in the project's documentation;
- one line under it (13, faint): "Without it, nothing here gives Juniper a browser of its own. By default, bots that use the browser share one profile, with its sign-ins." (F-275) It says "by default" because a gateway can be set up with other browser profiles, which this device cannot see.

The rest of the tab works without the plugin: the computer button and its dot, the machine, recent actions and commands.

### The plugin is installed, but not for this bot

"Juniper has no browser of its own yet." and "The gateway's owner adds Juniper to the computer plugin's list of bots. Until then Juniper's browser can't be watched here." The same faint line about the default profile follows. The tab tells this state from "not installed" only by the plugin's own answer for this bot (section 22); an answer refused for access is not either of them, and shows "Couldn't ask the computer plugin about Juniper." with the reason and "Try again".

### A read-only connection

A read-only connection receives no part of the live view, ever. The plugin's methods (`clawtrate-computer.tabs`, `view.open`, the stream, `view.renew`, `control.take`, `input`, `control.release`) all need a connection that may send, so on the read tier the device asks for none of them:

| A read-only connection |                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never receives         | A frame of the view; the list of the bot's tabs; control; the bot's pending questions (they need the questions scope), so there is no waiting banner                                                                                                                                                                                                                                            |
| Still sees             | The conversation's history, with its steps and cards; the task's files and the workspace (Part 1); artifacts and the media viewer (Part 2); the machine section; recent actions and commands; the computer button and its dot; and the control state, because the gateway's control events reach every reader: "Someone on another device has control of Juniper's browser" and the event lines |
| Is offered             | In the screen section: "Watching needs a connection that can send. This device is read-only." with "Request access", which starts the conversation's access request (`conversation.md` section 3)                                                                                                                                                                                               |

The full view and control are guarded on the device as well: whatever the device is asked to show, a read-only connection never opens the full view, never shows "You have control" and never draws a picture of the browser. A picture of a web page that the bot itself attached to the conversation, or that a step's result holds, is part of the conversation's history like any other, and a read-only connection sees it there; it is not the live view.

### Nothing to show

| State                                          | The screen section                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The task has not used a browser                | The empty state from `visual-language.md`: "No screen to show", "When Juniper uses its browser, you can watch it here."                                                                                                                                                                                                            |
| The gateway lists no tabs in the bot's browser | "Juniper's browser has no tabs open." and "If Juniper opens one, it appears here." It does not say the browser is stopped or will start: an empty list establishes only that there are no tabs. There is no "Wake" button: no way to start the browser is offered to this device, and no sleep state exists at the gateway (F-141) |

### Recent actions and commands

**Recent actions** (F-154) lists the task's browser and command actions, newest first, eight at a time with "Show all 23". Each row: the time (12, faint, tabular), the step's kind icon, the step's title in the step card's words ("Opened library.example", "Ran du"), and, when the gateway establishes it, what started the run: "Routine: Weekly cleanup" or "Message from Marlow". A run that the person's own message started has no label. Choosing a row is "Show in chat" for that step (section 10).

**Commands** (F-153) lists the commands the bot ran in this task: the command in mono, one line, then "exit 0", "exit 1" or "Timed out" and the duration, and "Show in chat". A command still running has the working mark and "Running"; its output so far is in its step. "Running on media-box" heads the processes the gateway reports for the task (`sessions.processes.list`).

### When something is stuck

| Trouble                                                          | The tab shows                                                                                                                                                                                                                                 | What the person can do                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The node is not connected                                        | The machine block's state, "Not connected", and when it was last seen, with its reason. Above it, on `--danger-soft`: "media-box isn't connected to the gateway. Nodes reconnect by themselves when they can; check that it's on and online." | "Check again", which reads the node's record again and says "Checked 5:42 PM" (F-150)                                       |
| The gateway's own desktop isn't ready (when the gateway has one) | "The gateway's desktop isn't available." and the gateway's error                                                                                                                                                                              | "Prepare it again", which asks the gateway to prepare it, and says it is doing so                                           |
| Control stays refused because a call never finished              | After a refusal for the same reason three times in a row: "Juniper's browser has been busy for a while. A call that never finished can keep control from being handed over."                                                                  | "Stop Juniper in this task" (below). The line adds: "If that doesn't free it, the gateway's owner can restart the gateway." |
| The bot itself is stuck in this task                             | Nothing new: Stop is in the composer (`conversation.md` section 16)                                                                                                                                                                           |                                                                                                                             |

**"Stop Juniper in this task"** (F-149) asks to confirm in a small `.menu`-styled dialog: "Stop Juniper's runs in this task? Steps already done stay done. Juniper's other tasks and other bots keep going." with "Stop" (`--danger` text on a default button) and "Cancel". It is the conversation's Stop, offered here because this is where the trouble shows; it needs a connection that may send.

There is no "Recover", "Reset" or "Update" of a computer: the gateway offers no such action for a machine (section 20).

## 20. What the gateway's facts drive

Names are from `docs/research/gateway-capabilities.md` (the map). "Source" means the installed OpenClaw 2026.10.6 package, by file and line. All of Part 1 is `operator.read`.

| Shown                                                         | Driven by                                                                                                                                                                                                                                                                                                                                                                                                                          | Source                                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed and Read groups; size, modified time; Missing         | `sessions.files.list {sessionKey, search?}`: entries `{path, workspacePath, name, kind, missing, size, updatedAtMs}`; `kind` is `modified` or `read`                                                                                                                                                                                                                                                                               | Map §20 "Files and the library"; `dist/workspace-files-CaH9GWMT.mjs` lines 297-329 (`kind: "modified" : "read"`)                                                                         |
| The filter                                                    | `sessions.files.list` `search`                                                                                                                                                                                                                                                                                                                                                                                                     | Map §11                                                                                                                                                                                  |
| Workspace folders, sizes, times, total, pages                 | `agents.workspace.list {agentId, path?, offset?, limit?}`: `{entries[{path, name, kind, size?, updatedAtMs?}], totalEntries, offset}`; limit 250 by default, 500 at most; folders have no size                                                                                                                                                                                                                                     | Map §20; `dist/agents-workspace-Gm2ASifr.mjs` lines 14-15                                                                                                                                |
| A text file's content                                         | `sessions.files.get {sessionKey, path}` (adds `previewKind`, `contentEncoding`, `hash`) or `agents.workspace.get {agentId, path}`                                                                                                                                                                                                                                                                                                  | Map §20                                                                                                                                                                                  |
| The 256 KB limit; "too large"                                 | Both refuse a larger file: `session_file_too_large`, `workspace_file_too_large`, with the size and the limit                                                                                                                                                                                                                                                                                                                       | `dist/workspace-file-limits-loc-yzkf.mjs` (`WORKSPACE_PREVIEW_MAX_BYTES = 262144`); `dist/sessions-files-CeQfMksk.mjs` lines 356-362; `dist/agents-workspace-Gm2ASifr.mjs` lines 105-114 |
| Pictures from the workspace                                   | `agents.workspace.get` admits a picture when its extension is on its list and its detected type is supported, up to 5 242 880 bytes; a task's `sessions.files.get` sends pictures in browser image types up to 256 KB                                                                                                                                                                                                              | `dist/agents-workspace-Gm2ASifr.mjs` lines 13-35 and 105-131; `dist/workspace-files-CaH9GWMT.mjs` lines 108-127                                                                          |
| "Isn't text or media"                                         | `agents.workspace.get` refuses with `workspace_file_unsupported`; `sessions.files.get` returns `previewKind: "unsupported"` with no content; `sessions.files.assets` answers `unsupported` for anything not detected as image, audio or video, or CSS or JavaScript                                                                                                                                                                | `dist/agents-workspace-Gm2ASifr.mjs` lines 127-131; `dist/workspace-files-CaH9GWMT.mjs` line 126; `dist/sessions-files-CeQfMksk.mjs` lines 84-92                                         |
| Recordings, videos and larger pictures from the task's folder | `sessions.files.assets {sessionKey, path, refs}` (`operator.read`) resolves each ref relative to the document at `path`, inside the task's read boundary, and returns base64 for image, audio and video (by detected type) and UTF-8 CSS and JavaScript; 1 048 576 bytes per asset, 4 194 304 in all, 64 refs; errors `not_found`, `too_large`, `outside_session_boundary`, `unsupported`; a stored repository caps each at 256 KB | `dist/sessions-files-CeQfMksk.mjs` lines 72-172 and 412-424; `dist/sessions-B6HQw2nf.mjs` lines 2774-2797; `dist/session-method-scopes-base-CuhU2F_D.mjs` line 30                        |
| A larger task picture through the workspace                   | `sessions.files.list` entries carry `workspacePath`                                                                                                                                                                                                                                                                                                                                                                                | Map §20 "Files and the library"                                                                                                                                                          |
| Download with the file's bytes                                | Text is decoded strictly as UTF-8 (`decodeUtf8Strict`), so encoding it again gives the same bytes; images come as base64 of the bytes read                                                                                                                                                                                                                                                                                         | `dist/agents-workspace-Gm2ASifr.mjs` lines 124-126; map §20. No HTTP route serves workspace files (map §20, "Downloads")                                                                 |
| The checkout's comparison and its label                       | `sessions.diff {sessionKey, scope?}`: per file `status`, `additions`, `deletions`, and `patch`, or `truncated: true`; the base is the merge base with the default branch, or `HEAD` on the default branch, named by `baseRef` and `mergeBase` in the result; the session's baseline only drops files whose fingerprint is unchanged and does not rebase a changed file's patch; `unavailableReason: "not_git"` outside a checkout  | Map §20; `dist/session-diff.runtime-CLIrA0e-.mjs` lines 122-170, 320-325, 418-430, 466-480 and 684-710; `dist/sessions-B6HQw2nf.mjs` lines 2852-2866                                     |
| Changes by step; the source line; "Show in chat"; "Open file" | File tools' `tool` start `{toolCallId, args.path}` and result `details {diff, patch, created, changed}`, joined on `toolCallId` and `runId`; the history's `toolCall` block keeps it after a reload                                                                                                                                                                                                                                | Map §20 "Which step produced a file"; map §19 "Tool events in depth"                                                                                                                     |
| An attachment as a source                                     | `chat.history` message attachments by `fileName`                                                                                                                                                                                                                                                                                                                                                                                   | Parity F-447 cell; map §19 "Attachments"                                                                                                                                                 |
| "Writing…"; "Changed this run"                                | The file tool's start (path) and result, in the run's `agent` `tool` stream (cap `tool-events`)                                                                                                                                                                                                                                                                                                                                    | Map §20; parity F-321 cell                                                                                                                                                               |
| No event when a file changes; commands not seen               | No workspace or file-change event exists; a write produced only `agent`, `chat`, `sessions.changed`, `session.message` and `presence`                                                                                                                                                                                                                                                                                              | Map §20 "Live changes"                                                                                                                                                                   |
| "Otto ran commands since then"                                | `exec` tool events in the open task                                                                                                                                                                                                                                                                                                                                                                                                | Map §19 "Tool events in depth"                                                                                                                                                           |

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

### Part 3

The computer plugin is P4, `clawtrate-computer`, in the map's section 3. The map's P4 is a research prototype that has not passed a security review; the shipped plugin is written from the map's "Requirements for the shipped plugin". Everything below marked P4 is what that contract provides, as shown live on a development gateway unless the map says otherwise.

| Shown                                                                                                | Driven by                                                                                                                                                                                                                                                                                                                                                                                                                 | Source                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The computer button and its dot; the tab's dot                                                       | `agent` `tool` events for the `browser` tool (`operator.read`)                                                                                                                                                                                                                                                                                                                                                            | Parity F-139 cell; map §7 and §19 "Tool events in depth"                                                                                                       |
| Whether the plugin is installed                                                                      | `hello-ok.features.methods`, which includes methods registered by loaded plugins; the client also treats an unknown-method answer from `clawtrate-computer.tabs` as "not installed"                                                                                                                                                                                                                                       | Map §1 ("Use `hello-ok.features.methods`… for feature detection"); `dist/server-start-D6vaUNGz.mjs` lines 577, 2147 and 5536-5543; not exercised live with P4  |
| The tab list: titles and addresses                                                                   | P4 `clawtrate-computer.tabs`, the bot's live CDP target list (`operator.write`, session access, `requiredTool: "browser"`)                                                                                                                                                                                                                                                                                                | Map §3 P4; map §18                                                                                                                                             |
| The live picture                                                                                     | P4 `view.open` gives a one-use 60 s ticket for `/clawtrate-computer/stream`; binary frames with a header `{url, cssWidth, cssHeight, scrollX, scrollY, ts}` and JPEG bytes; `meta` on navigation                                                                                                                                                                                                                          | Map §3 P4 "Frames"; map §18 items 4 and 8                                                                                                                      |
| The view stays open only while watched                                                               | `view.renew` about every 5 s; the stream closes when renewals stop for 20 s                                                                                                                                                                                                                                                                                                                                               | Map §3 P4 "Not bound to the connection", "Stream"                                                                                                              |
| "Juniper closed this tab"; "The gateway stopped sending it"                                          | Close codes `4004 target_closed`, `4006 authority_revoked`, `1000`                                                                                                                                                                                                                                                                                                                                                        | Map §3 P4 "Frames"; map §18 item 11                                                                                                                            |
| Taking control: waiting, granted, refused                                                            | `control.take {sessionKey, targetId}` emits `draining` at once and answers once: `{state:"granted", generation, renewWithinMs}` or, after `drainTimeoutMs` (15 s by default), `{state:"busy", reason, runningCalls}`; `CONFLICT` when someone holds or is taking the tab                                                                                                                                                  | Map §3 P4 "Contract"; map §18 items 5 and 10                                                                                                                   |
| Only clicks, scrolling and text                                                                      | `input {kind: "click"\|"scroll"\|"text", x?, y?, deltaY?, text?}` with the lease's `generation`                                                                                                                                                                                                                                                                                                                           | Map §3 P4 "Contract"                                                                                                                                           |
| "Juniper's browser tool can't act here, in any of Juniper's tasks"; "Other ways in aren't blocked"   | While a lease exists, the hook blocks every `browser` tool call from every session of that bot, with "The user has control of this bot's browser". Operator methods (`browser.request`, `browser.dashboard.request`) are not reached by the hook, and other tools such as `exec` or the `computer` tool may reach the browser outside it                                                                                  | Map §3 P4 "Limits" ("The block is per bot", "Operators are not blocked"); map §3 "Requirements for the shipped plugin", "Stated limits"; map §18 item 6        |
| One browser for all of a bot's tasks                                                                 | Isolation is per bot, not per session: sessions of the same bot share its browser and its view; view and control rights come from the session's bot and that bot's live tab list; nothing names the task that opened a tab                                                                                                                                                                                                | Map §3 P4 "Limits" ("Isolation is per bot, not per session"); map §18 "Isolation model"                                                                        |
| "Pages you open aren't checked by the gateway's browser rules"                                       | Frames and input go straight over CDP and skip the browser plugin's navigation checks                                                                                                                                                                                                                                                                                                                                     | Map §3 P4 "Policy bypass"                                                                                                                                      |
| Giving back; confirmation; the lease ends; an uncertain release                                      | `control.release` with the holder's `generation`; the `released` control event; renewal answers `{ok, renewWithinMs, leaseRenewed}`, where `leaseRenewed: false` means the lease was not renewed; a holder that stops renewing loses the lease (live: 22.6 s after a disconnect); a take request has no cancel and answers once                                                                                           | Map §3 P4 "Contract" and "Events"; map §18 items 7, 9 and 11                                                                                                   |
| Event lines; "Someone on another device has control" on every connection                             | `plugin.clawtrate-computer.control {profile, targetId, holder, state}`, states `draining`, `granted`, `busy`, `released`, `expired`, `revoked`, `tab-closed`, at `operator.read`                                                                                                                                                                                                                                          | Map §3 P4 "Events"                                                                                                                                             |
| The question's answers in the control bar; its shapes; answering after the release; already resolved | The bot's `ask_user` question (`question.requested`, answered with `question.resolve`, closed by `question.resolved`, `operator.questions`); a record can hold one to three questions, single or multiple answers and an own-answer field; answered, dismissed and expired all end the wait; releasing control alone does not resume it; `question.resolve` and `control.release` are separate calls with separate scopes | Parity F-144 and F-145 cells; map §19 "Question cards"; `conversation.md` §13                                                                                  |
| No dedicated "needs a human" signal                                                                  | None was found; the bot asks with `ask_user`                                                                                                                                                                                                                                                                                                                                                                              | Map §20 "Computer signals"                                                                                                                                     |
| Not watchable without the plugin                                                                     | The gateway's `browser.request` screencast needs `operator.admin`, and has no takeover arbitration                                                                                                                                                                                                                                                                                                                        | Map §18 "Caveats of the built-in route"                                                                                                                        |
| "By default, bots that use the browser share one profile"; a browser per bot with the plugin         | By default the managed `openclaw` profile is shared by every session and every bot that uses the browser tool; a gateway can declare other profiles, node and sandbox routes, which this device does not see; P4 pins each configured bot to its own profile; unconfigured bots get no view                                                                                                                               | Map §18 "Caveats of the built-in route" and "Isolation model"; map §20 "Machine choice" ("Browser profiles are global"); map §3 P4 "Limits"; parity F-275 cell |
| Read-only: no frames                                                                                 | P4's methods are `operator.write`; its event is `operator.read`                                                                                                                                                                                                                                                                                                                                                           | Map §3 P4                                                                                                                                                      |
| "Commands ran on"                                                                                    | An exec approval request carries the command's `host` and `nodeId`; the interactive tier receives it. Nothing else the client receives names where a task's command ran: routing set with `sessions.patch {execHost, execNode}` (admin) and a task placed with `sessions.dispatch` do not appear on the task's row                                                                                                        | `dist/exec-approval-DAaiZN5X.mjs` lines 150 and 190-211; `conversation.md` §12 ("Runs on": `host`, `nodeId`); map §13 and §20 "Machine choice"                 |
| "Set for <Bot>"                                                                                      | The bot's `agents.entries.<id>.tools.exec.{host, node}`, or the defaults it inherits, from `config.get` (`operator.read`): a setting, not where a task ran                                                                                                                                                                                                                                                                | Map §13; map §2 row 3 (`config.get` is `operator.read`)                                                                                                        |
| "The gateway's machine, in Juniper's own browser"                                                    | P4 rewrites every configured bot's browser call to `target: "host"` and its own profile                                                                                                                                                                                                                                                                                                                                   | Map §3 P4, first row                                                                                                                                           |
| State, last seen and reason; "Unknown"                                                               | `node.list`, `node.describe` (`operator.read`): `connected`, `lastConnectedAtMs`, `lastSeenAtMs`, `lastSeenReason`; `lastSeenAtMs` is updated by background alive messages and token authentication too, so it is labelled "Last seen"; no field reports a reconnecting node                                                                                                                                              | Map §20 "Computer signals" and its note on `lastSeenAtMs`; parity F-148 cell                                                                                   |
| Load, memory, disk, and their time                                                                   | The `node.hostStats {nodeId, hostStats:{cpuCount, loadAverage, memoryTotalBytes, memoryFreeBytes, diskTotalBytes?, diskAvailableBytes?, updatedAtMs}}` event, every 60 s, and the same figures on the node's record in `node.list`; none from a node started with `--commands`                                                                                                                                            | Map §20 "Computer signals"                                                                                                                                     |
| No "asleep", no "Wake", no "stopped"                                                                 | No sleep state exists; a disconnected node is not evidence of sleep; an empty tab list establishes only that no tab is open; starting a browser needs `operator.admin` or P4's bot-side `start`                                                                                                                                                                                                                           | Map §20 "Computer signals"; map §3 P4; parity F-141 cell                                                                                                       |
| The gateway's desktop, "Prepare it again"                                                            | `computer.status {probe?}` (`operator.read`) gives `{configured, available, computerUse?, error?}`; `probe:false` only reads; `probe` (the default) prepares                                                                                                                                                                                                                                                              | Map §20 "Computer signals"                                                                                                                                     |
| No Recover, Reset or Update                                                                          | No method recovers a machine; the only "recover" methods act on sessions and worktrees                                                                                                                                                                                                                                                                                                                                    | Map §20 "Computer signals"; parity F-150 cell                                                                                                                  |
| A call that never finished keeps control refused                                                     | A bot call without `after_tool_call` keeps takeover busy until the gateway restarts; whether `after_tool_call` fires for an aborted run is unverified                                                                                                                                                                                                                                                                     | Map §3 P4 "Limits"                                                                                                                                             |
| "Stop Juniper in this task"                                                                          | `sessions.abort` (`operator.write`) stops one task's runs; other bots keep running. `sessions.recover` is named but not described                                                                                                                                                                                                                                                                                         | Parity F-149 cell; map §2 row 5                                                                                                                                |
| Recent actions and their trigger                                                                     | Tool events and history; a routine's run by its session key `agent:<agentId>:cron:<jobId>:run:<sessionId>`; another bot's by inter-session provenance; no field names the trigger                                                                                                                                                                                                                                         | Parity F-154 cell; map §19 "Bot-to-bot"                                                                                                                        |
| Commands, exit codes, running processes                                                              | `exec` tool events with `command_output`; `toolCall` and `toolResult` history rows; `sessions.processes.list` (`operator.read`)                                                                                                                                                                                                                                                                                           | Parity F-153 cell; map §19 "Tool events in depth"                                                                                                              |

What Part 3 assumes and the map does not establish:

- Text input through P4 was not shown live (map §3 P4, "Not demonstrated live"). The control bar promises typed text because the contract has it; a builder checks it first.
- Two viewers taking control at the same moment was shown only offline.
- The plugin's page in the documentation does not exist yet; the link in section 19 is written for it.

## 21. Parity rows to reword

Only the Clawtrate column changes.

| Row   | New wording for the Clawtrate column                                                                                                                                                                                                                                                                                                                                                                                             | Why                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| F-152 | better: on desktop and iPad, a Files tab in the work pane beside the conversation lists the files the task changed and read, and the Bot's workspace by folder; selecting a file previews text, markdown and pictures, and plays recordings and videos up to 1 MB from the task's folder, in the pane while the conversation stays visible (§7 proposal).                                                                        | The gateway sends text and media only, within limits; PDFs and archives have no read path. |
| F-319 | better: "Download" from the Files tab (desktop, iPad) saves, under its own name and with identical bytes, a file the gateway's read methods send: UTF-8 text up to 256 KB; pictures up to 256 KB from the task's folder, up to 1 MB there through its media method, and up to 5 MB from the workspace; recordings and videos up to 1 MB from the task's folder. For any other file the tab names the limit it met (§7 proposal). | Three read methods with different limits; none sends other kinds of file.                  |
| F-449 | better: a file the pane cannot show shows its name, size, modified time and type, and one sentence naming the limit it met (its kind, its size, or that it is outside the task's folder); "Download" is offered only when one of the read methods sends the file (§7 proposal).                                                                                                                                                  | Same.                                                                                      |
| F-448 | better: while a run creates, changes or deletes files with the file tools, the listing updates without a reload, and an open preview reloads when such a change lands; a change made by a command shows after a refresh, and the tab says when commands have run since it was checked (§7 proposal).                                                                                                                             | No file-change event exists; refetching after file-tool results misses commands.           |
| F-321 | better: in the Files tab or section, files created or changed by the active run's file tools carry a "Changed this run" marker, and files changed in the previous run "Changed last run" (§7 proposal).                                                                                                                                                                                                                          | Attribution comes only from file-tool events.                                              |

| F-304 | same; note: "Download all" saves every item in the message that the gateway can send; when one cannot be sent, the item reads "Download 2 of 3" and the result names what was left out. The check compares every downloadable item's name and bytes with the originals. | An artifact whose download mode is `unsupported` cannot be fetched. |
| F-307 | better: from a file card, a format the device cannot preview shows its details and "Download"; an item the gateway holds no content for says so and offers no "Download"; a failed load shows the error and "Try again"; a successful retry shows the preview (F-115 covers the successful card preview; the Files pane has its own rows). | The `unsupported` download mode. |

F-320, F-446 and F-447 are met as written, and so are F-115, F-116, F-117, F-118, F-305 and F-306. F-115's dependency cell says that only image blocks are named; the gateway's source collects file, audio and video blocks as artifacts too (section 20), and a builder correcting that cell can cite it.

**Part 3.**

| Row   | New wording for the Clawtrate column                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-140 | better: the Computer tab shows a 16:9 tile with a "Watch" pill and the caption "&lt;Bot&gt;'s browser" and the tab's title; the live picture starts only when the person chooses Watch, or at once when they have turned on "Show live" for that Bot.                                                                                                                                                                                                                                                                           | A signed-in browser is not shown unasked.                                                                                                         |
| F-141 | better: when the gateway lists no tabs in the Bot's browser, the tile reads "&lt;Bot&gt;'s browser has no tabs open."; a node that is not connected shows "Not connected" and when it was last seen, with the reason it gave. No asleep, stopped or starting state and no wake action are shown.                                                                                                                                                                                                                                | The gateway has no sleep state; no tabs is not a stopped browser; a disconnected node is not evidence of sleep; starting the browser needs admin. |
| F-147 | better: the panel names the machine where the task's commands ran when the gateway has named it (a command's approval), says "Not reported in this task" otherwise, shows the Bot's own setting labelled as a setting, and links to the node's settings (FC-02).                                                                                                                                                                                                                                                                | A task's effective routing is not reported to the client.                                                                                         |
| F-148 | better: the panel shows the node's state as "Connected" or "Not connected", or "Unknown" with the last value read when its record couldn't be read, and when the gateway last saw the node, with its reason (FC-08).                                                                                                                                                                                                                                                                                                            | No reconnecting state is reported, and the last-seen time is not a heartbeat.                                                                     |
| F-142 | better: "Open" shows the Bot's browser full window in "Watching" mode; "Take control" asks the gateway for control and says while it waits, and the bar says which input reaches the page; Escape and the collapse control return.                                                                                                                                                                                                                                                                                              | Takeover waits for the Bot's current call (up to 15 s) and input is clicks, scrolling and text.                                                   |
| F-144 | better: when the Bot asks a question while its browser can be taken, the conversation shows its question card, and the Computer tab shows "&lt;Bot&gt; is waiting for you" with the question's title, "Take control" and "Show the question"; the row shows "Waiting for you".                                                                                                                                                                                                                                                  | The gateway has no computer card; the human step is the Bot's own question.                                                                       |
| F-145 | better: after "Take control", the bar shows the pending question's own answers (for example "I'm done" and "Skip") when it can be answered by one choice, and "Give back control"; choosing an answer first gives control back and, once the gateway confirms it, sends the answer, after which the Bot carries on; a failed or unconfirmed step is shown as such and nothing further is sent; a question of another shape is answered in the chat after giving control back; "Give back control" alone leaves the Bot waiting. | Release and answer are separate calls, each confirmed by the gateway; releasing does not resume the Bot.                                          |
| F-149 | better: "Stop &lt;Bot&gt; in this task" stops that task's runs after a confirmation that says other tasks and other Bots keep going; offered in the Computer tab when the Bot's browser stays busy, and as Stop in the composer (FC-08).                                                                                                                                                                                                                                                                                        | `sessions.abort` stops one task's runs; no restart or recover method is described.                                                                |
| F-150 | same; note: for an unreachable node, the tab says it reconnects by itself and offers "Check again"; for the gateway's own desktop, "Prepare it again". No recover action.                                                                                                                                                                                                                                                                                                                                                       | No machine recovery method exists.                                                                                                                |

F-139, F-143, F-153 and F-275 are met as written. F-275's isolation is the plugin's; without it the tab says only what is established: that nothing gives the Bot a browser of its own, and that by default Bots that use the browser share one profile. F-154 is met as written; its check should allow a run started by the person's own message to carry no label, and a trigger the gateway does not establish to stay unlabelled. F-446's "folder tree" is met by the workspace browsed one folder at a time (section 5).

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
- File content from the right read method (section 8): `sessions.files.get` or `agents.workspace.get` for text and small pictures, `agents.workspace.get` by `workspacePath` or `sessions.files.assets` for larger pictures, `sessions.files.assets` for recordings and videos. Text from `sessions.files.get` carries a hash; for the others the engine computes one from the bytes, so a reload can tell "changed" from "the same".
- Per pane: the chosen tab, kept across tasks and bots (section 1). Per task: the Files stack and each level's scroll. Per bot: the sort.

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

### Part 3: what each part uses

| Part                                  | Uses                                                      | New                                          |
| ------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| The computer button and the tab's dot | The round icon button; `--accent-line`                    | `.computer-button[data-active]`, `.tab-mark` |
| The screen section                    | The empty state; `.work-section h3`                       | `.screen` (the tile), `.screen-tabs`         |
| The full view                         | The media viewer's frame and dark tokens (section 14)     | `.screen-view`                               |
| The control bar                       | Buttons; state marks                                      | `.control-bar`                               |
| The banner                            | The conversation's shelf row on `--warn-soft`             |                                              |
| The machine                           | `.facts`, state marks                                     |                                              |
| Recent actions and commands           | File rows' metrics; the step card's titles and kind icons | `.action-row`                                |
| The stop confirmation                 | `.menu`'s surface                                         |                                              |

### What the engine supplies for Part 3

- Whether the plugin is installed (from `hello-ok.features.methods`), and for each bot whether it is configured for it (from `clawtrate-computer.tabs` answering for the bot's session).
- The task's browser activity from tool events: whether a browser call is running now.
- A view session for the open task: `view.open`, the stream, `view.renew` every 5 s, and its end, with the cause. It ends on the triggers in section 17 without being asked twice.
- A view session per Watch, numbered on this device: `view.open`, the ticket, the stream, `view.renew` every 5 s; every answer matched to its view, and an answer for a view that has ended disposed of (ticket unused, stream closed, frames dropped before decoding).
- A control session: `control.take`, the local "waiting" state from the `draining` event, abandonment on Cancel or leaving, and an immediate `control.release` for a grant that arrives after it was abandoned; the lease's `generation` kept in memory only; `view.renew` with it and `leaseRenewed` read on every renewal; input sent one call at a time and dropped, not sent, once control is being given back; `control.release` confirmed by its answer or the `released` event before an answer is sent; and the control events for every tab of the bot.
- The pending question of the open task, matched to the bot whose browser the tab shows, with its shape (how many questions, single or multiple answers, options, own answer) and its lifecycle (`question.resolved`: answered, dismissed, expired), so the bar knows whether it can offer the answers and when to withdraw them.
- The machine evidence for the open task: the latest exec approval's `host` and `nodeId`; the bot's setting from `config.get`, kept apart as a setting; each named node's record from `node.list` or `node.describe`, and its stats from the `node.hostStats` event, each with the time it was read; a failed read kept as "unknown" beside the last good value. Which other bots are set to use the same node.
- Recent actions and commands of the task, with each run's trigger where the session key or provenance establishes it.

### What the plugin must supply

The shipped plugin is written from the map's "Requirements for the shipped plugin". For this design it must keep P4's contract above, and:

- answer `clawtrate-computer.tabs` with a distinct error for "this bot is not configured", so the tab can tell that state from "not installed";
- keep the `draining` event, the single answer to `control.take`, and the control event at `operator.read`;
- keep frames out of any log on the gateway, as the client keeps them out of its own.
- either close the routes its stated limits leave open (operator browser controls, other tools reaching the browser) or keep them documented; the control bar names them for as long as they are open, and changes only when the plugin's tests show them closed.

Without the plugin, nothing in this part asks for more access: the client never requests `operator.admin` to watch a browser.

### Order to build Part 3

1. The computer button and the tab's dot from tool events. Check F-139.
2. The machine section from approvals, `config.get` and the node methods, with "Not reported" and "Unknown". Check F-147 and F-148 as reworded.
3. Recent actions and commands. Check F-153, F-154.
4. The screen section's states without the plugin, for an unconfigured bot, on a read-only connection, and with nothing to show. Check F-275 as stated, F-141 as reworded.
5. Against a development gateway with the plugin: the tile, Watch, the view's end, the full view. Check F-140 as reworded, F-143.
6. Control: take, waiting, refused, granted, the bar, input, handing back, the event lines, the banner. Check F-142, F-144, F-145 as reworded.
7. Recovery: Check again, Prepare it again, Stop in this task. Check F-149, F-150 as reworded.

### Building the whole pane

Part 1 first, because it needs nothing but `operator.read` and gives the pane its navigation; then Part 2, whose cards and viewer the computer's full view reuses; then Part 3, whose screen and control wait for the shipped plugin while its other sections do not.

### Prototype states for Part 3

| Parameter                                     | Values                                                                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot=juniper&task=j2&panel=open&tab=computer` | Juniper's browser, waiting for the person to sign in                                                                                                                                                                 |
| `computer`                                    | `noplugin`, `unconfigured`, `unused` (no browser use in the task), `closed` (no tabs open), `watching`, `full` (the full view), `draining`, `control`, `busy`, `conflict`, `ended`, `offline` (Otto's node), `stuck` |
| `firstwatch`                                  | `1`: the one-time note before the first watch                                                                                                                                                                        |
| `state=readonly`                              | The read-only connection                                                                                                                                                                                             |
