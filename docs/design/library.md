# The Library and Pages

What a bot made, gathered in one place, and the Pages among it: the Library tab in the Work pane, a Page's card in the conversation, a Page opened full window with a chat beside it, exporting a Page as a file, and the iPhone's forms of each. It builds on `visual-language.md` (tokens, the pane's frame), `conversation.md` (the transcript, sending, the access bar) and `work-pane.md` Part 2 (artifact cards, the pane's view of an item, the media viewer), which it reuses as they are designed.

The behaviour comes from the teardown's Library section (`docs/research/grok-bot-flows.md`, §9.5) and is checked by `docs/parity.md` rows F-208 to F-210 and F-371 to F-374. Every fact about the gateway here was verified on a development instance with this project's own client, and is recorded in `docs/research/library.md` (cited as "research §n"). Section 10 maps each fact to what is shown; section 11 lists the rows reworded and the four decided; section 12 is for builders.

The rule from `conversation.md` holds: **no state claims more than the gateway has reported.** The Library is assembled by the client from per-task reads, so it always says which tasks it looked in. A Page is content a bot wrote: it is shown as data, never with the app's own rights.

The prototype is `prototype/library.html` (styles in `prototype/css/library.css`, behaviour in `prototype/js/library.js`, check in `prototype/tools/checks/library.mjs`). Its address selects every state (section 12).

## Contents

1. How the pieces fit
2. Shared rules
3. The Library tab
4. Pins
5. A Page in the conversation
6. A Page, full window
7. Exporting a Page
8. On iPhone
9. Widths, themes, keyboard and screen readers
10. What the gateway's facts drive
11. Parity rows reworded and decided
12. For builders
13. Not covered here

## 1. How the pieces fit

- **The Library is the bot's, not the task's.** It is a tab of the Work pane, after Files: Details, Files, Library, Computer, Settings. Like Settings, it is about the bot whichever task is open, and it keeps its place when the person switches tasks. The tab bar's rule when its tabs do not fit (`bots.md`, section 19) applies unchanged: with five tabs the 360 px drawer scrolls the row sideways, the chosen tab in view.
- **On iPhone the Library is the conversation's**, in the task's info sheet (section 8), because that is where the phone keeps it (F-371).
- **What it lists**: the pictures, recordings, videos and files a bot handed over in its messages, the Pages it showed, and the links it wrote. The gateway lists the first four per task, with no time (research §1); Pages and links are read from the task's history by the client. Nothing on the gateway lists them across tasks or counts them.
- **Opening an item** goes to the screen `work-pane.md` already designs for it: a picture or a video to the media viewer (§14); a file or a recording to its task's Files tab, in the item's view (§13), with that task opened; a link through the link confirmation of the remote-content rule. A Page opens full window (section 6), from the Library and from its card alike. This replaces `work-pane.md` §12's "It opens in the media viewer's frame" for pages; nothing else of Part 2 changes.

## 2. Shared rules

### Components reused

| Thing                                                                                                                                      | From                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| The pane's frame, tabs, the empty state (44 px mark, 15/500 title, one sentence)                                                           | `visual-language.md` §9                                                               |
| The freshness line: what was read, when, and an action (`.files-fresh`)                                                                    | `work-pane.md` §9                                                                     |
| A file row: 48 px (56 on touch), the kind's 32 px tile or a thumbnail, the name cut in the middle, a second line in 13 faint (`.file-row`) | `work-pane.md` §4                                                                     |
| Skeleton rows, still under reduced motion                                                                                                  | `work-pane.md` §2                                                                     |
| The page card (`.artifact`, the page icon, "Page")                                                                                         | `work-pane.md` §12                                                                    |
| The item's view in Files, and the media viewer                                                                                             | `work-pane.md` §13 and §14                                                            |
| The access bar and its states                                                                                                              | `conversation.md` §3                                                                  |
| Bubbles, the composer and sending (the outbox, `followup`)                                                                                 | `conversation.md`                                                                     |
| The link confirmation: the full address, host first, "Opens in your browser", Cancel and Open                                              | The remote-content rule (`docs/decisions.md`, "Addresses a gateway hands the client") |
| `.menu`, the round quiet icon button, a line that says something failed with "Try again"                                                   | `visual-language.md` §4 and §8                                                        |

### New components

| Component                                               | Class                                                   | Section |
| ------------------------------------------------------- | ------------------------------------------------------- | ------- |
| The filter row: All, Pages, Media, Links, Files, Pinned | `.lib-filters`                                          | 3       |
| A group: its word and its rows, with Show more          | `.lib-group`                                            | 3       |
| A Library row, with its Pin button                      | `.lib-row`                                              | 3, 4    |
| The Page view: its bar, its frame, its note, its chat   | `.page-view`, `.page-frame`, `.page-note`, `.page-chat` | 6       |
| The export dialog                                       | `.export-dialog`                                        | 7       |

No token is added. A pinned row's mark is the pin icon in `--text-muted`; the chosen filter is a `--bg-selected` pill, as the tabs are.

### What the connection may do

| Tier        | The Library and Pages show                                                                   | They offer                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read        | Everything: the Library, pins as the gateway keeps them, Pages, the side chat's conversation | Opening, Show more, looking in more tasks, export. Pin and the side chat's composer give way to the access bar ("Pinning and messaging need permission to change things on the gateway.") with "Request access" |
| Interactive | The same                                                                                     | Pin and Unpin; sending from the side chat                                                                                                                                                                       |
| Admin       | The same                                                                                     | Nothing more. Nothing here asks for admin                                                                                                                                                                       |

Every read is `operator.read` (research §1, §2, §8). Pin is `users.prefs.set` and sending is `chat.send`, both `operator.write`, which the interactive tier holds. The request for access is the one `conversation.md` §3 makes, never silent.

### Time

Every time is the `timestamp` of the message that carried the item, from `chat.history`. **Today**, **This week** and **Older** are computed on the device, in the device's time zone: Today from local midnight; This week from the start of the current week in the device's region (Monday where the platform does not say) to local midnight; Older before that. The gateway gives no time on an artifact (research §1), so an item whose message has not been read has no group; see "Time not read" below. A row shows the time as the conversation does: "5:37 PM" today, the weekday this week, "Nov 12" older.

### Words

No "secure", "safe" or "private" anywhere in this design. A Page is "shown without its scripts", never "safe"; an export is "a file on this device", never "private". The gateway's own refusal is quoted as the gateway's ("The gateway said: …").

### Announcements

The conversation's polite live region speaks for the Library and Pages, and only for: "Pinned Trail guide" and "Unpinned Trail guide" once the gateway's preferences were read back; "Couldn't pin Trail guide" with the reason; "Pins changed on another device" when the Pinned filter is showing; "Looked in 20 of Marlow's 23 tasks" after "Look in more tasks"; "Exported Trail guide.html"; "Couldn't show Trail guide". Loading and a refresh that changed nothing are not spoken.

## 3. The Library tab

```
filters        [All] Pages  Media  Links  Files  Pinned
fresh          In Marlow's 10 most recent tasks of 23 · checked 5:41 PM   [Refresh]
Today          [page]  Trail guide                                  [pin]
                       Page · 5:37 PM · Saturday's trail plan
               [img]   ridge-profile.png
                       PNG image · 1.2 KB · 5:31 PM · Saturday's trail plan
               …five rows…
               [Show more]
This week      …
Older          …
foot           [Look in 10 more tasks]
```

### What it reads

1. The bot's tasks, as the rail lists them (`sessions.list {agentId}` with the rail's filters, newest activity first). The Library looks in the **10 most recent**.
2. For each, `artifacts.list {sessionKey, messageRole: "assistant"}`: every item the bot handed over in that task, in one call (it is not paged; research §1).
3. For each, `chat.history {sessionKey, limit: 200}`: the last 200 rows. From the bot's rows it takes each item's time (by `messageSeq`), each Page (a `canvas` block without `mcpApp`) and each link (an `http` or `https` address in the bot's text, as markdown or bare). When a listed item's message is older than the rows read, it reads the page before (`offset`), and so on, at most 1,000 rows a task.
4. It reads again when the tab is opened, on Refresh, and when a message from the bot arrives in a task it looked in.

**The freshness line** says what was searched, always: "In Marlow's 10 most recent tasks of 23 · checked 5:41 PM", or "In all 6 of Marlow's tasks · checked 5:41 PM". "Look in 10 more tasks" at the foot reads the next ten and the line follows ("In Marlow's 20 most recent tasks of 23"). With every task read, the foot is gone. A row count is never shown as a total of the bot's items.

### Filters

A row of pill buttons, a `radiogroup` named "Show": **All**, **Pages**, **Media** (pictures, recordings, videos), **Links**, **Files**, **Pinned**. The chosen one is a `--bg-selected` pill; the others are muted text, as the tabs are. Arrows move and choose; one tab stop. The choice belongs to the pane and is kept across tasks and bots, like the chosen tab.

**There is no Apps filter.** The gateway marks an MCP App view only as a `canvas` block carrying `mcpApp`, such a view runs only with its scripts, and Clawtrate runs no page's scripts (research §9). It would list items that cannot be opened here, so the filter is cut (section 11).

### Groups and Show more

Today, This week and Older, each headed by its word (13, faint), newest first, ties by message order then position. Each group shows five rows, then "Show 5 more" (or "Show 2 more", the rest of what was read for that group); focus stays on the button, which moves down. A group with no rows is not drawn.

**Time not read.** An item listed by `artifacts.list` whose message lies beyond the 1,000 rows read has no time. It goes last, under "Time not read", with the sentence "These are in long tasks, beyond the messages read." It is never put in Older by guess.

### A row

`.file-row`, with:

- **The tile**: the kind's icon on `--bg-pane`; a picture's 32 px thumbnail once its preview was fetched under `work-pane.md` §11's rules; a link's tile is the link icon.
- **The title**: an item's title as the gateway gives it (`work-pane.md` §11), a Page's `title` from its block, or a link's text (its address when it has none). Cut in the middle so an extension stays.
- **The second line** (13, faint): the type in words, the size when known, the time, then the task's title, which is what shortens when the line is too long: "PNG image · 1.2 KB · 5:31 PM · Saturday's trail plan"; "Page · 5:37 PM · Saturday's trail plan"; a link "trails.example · 5:34 PM · Saturday's trail plan" (its host).
- **A pin mark** after the title when pinned.
- **Pin** (section 4): a quiet round 28 px button at the right, shown on hover and focus and always on touch, named "Pin Trail guide" or "Unpin Trail guide" (`aria-pressed`).
- The row is one button: "Trail guide, Page, in Saturday's trail plan, 5:37 PM. Open." Up and Down, Home and End move between rows; Enter opens.

Two cards of one Page are two rows, one per occurrence, as `work-pane.md` §11 keeps one card per occurrence. The earlier one's second line reads "Page · 5:33 PM · Shown again below · Saturday's trail plan" (section 5).

### Opening an item

| Item                  | Opens                                                                                                                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Page                | The Page view (section 6), for that occurrence's task                                                                                                                                                                                                                                                                             |
| A picture or a video  | The media viewer at that item (`work-pane.md` §14); its sequence is the items of that message                                                                                                                                                                                                                                     |
| A file or a recording | Its task opens in the conversation, and the pane shows Files with the item's view (`work-pane.md` §13); Back in Files returns to "Sent in chat"                                                                                                                                                                                   |
| A link                | Nothing is fetched. A row whose name is the link's full address opens it in the browser. Any other row opens the link confirmation first: the full address, host first, "Opens in your browser", Cancel and Open. An address on this device or the person's own network always gets the confirmation, with the decision's warning |

The Library itself fetches no item. What an item's view fetches is `work-pane.md`'s, under the decision on addresses (`docs/decisions.md`, "Addresses a gateway hands the client"): only what the gateway issued as a download grant is fetched by the app by itself, and a grant's address is never shown, copied, exported or handed to a browser. An address `artifacts.download` passes through from the transcript is not a grant. A row's second line names a type, a size, a task and a time, never an address, except a link's host.

### States of the tab

| State                          | It shows                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                        | The filters, the freshness line "Looking in Marlow's tasks…", five skeleton rows, `aria-busy`                                                                                                                 |
| Loaded                         | As above                                                                                                                                                                                                      |
| Some tasks couldn't be read    | The rows from the others, and above the groups a line on `--danger-soft`: "Couldn't read 2 of the 10 tasks." with "Try again", which reads those two again                                                    |
| Nothing could be read          | The empty mark with a warning, "Couldn't load Marlow's library", the gateway's reason in one sentence, "Try again"                                                                                            |
| Empty, All                     | The empty mark, "Nothing found yet", "Pages, pictures, files and links Marlow sends appear here." with the freshness line under it                                                                            |
| Empty, a filter                | "No pages in these tasks." (or pictures and recordings, links, files), and, while tasks remain, "Look in 10 more tasks"                                                                                       |
| Pinned, empty                  | "Nothing pinned", "Pin an item to keep it here. Pins are kept on the gateway for every device you use." (or "on this device", section 4)                                                                      |
| Not shown on this platform yet | "Clawtrate can't show pages here yet." and "You can ask Marlow about this page, or export it as a file." Shown until this platform's zero-request check passes; the HTML is read only for Export              | The note is hidden; the chat and Export work |
| The connection is lost         | Rows keep their last look; the freshness line reads "Can't reach the gateway · checked 5:41 PM", without Refresh. Opening an item not on the device says "Can't reach the gateway. Try again when it's back." |
| Read-only                      | Everything, with the Pin buttons replaced by the access bar at the foot of the tab when the person chooses one (section 4)                                                                                    |

## 4. Pins

### Where they are kept

In the person's preferences on the gateway, `users.prefs`, under one key per bot, `clawtrate.library.pins.<botId>`: a list of the pinned occurrences, newest pin first, each `{task, seq, pos, id?}` (the task's key, the message's sequence number, the item's position in it, and the gateway's id for an artifact). Research §8 established that these preferences belong to the person's profile, not to this device: every device and client of the gateway's owner reads the same pins, and is told when another changes them.

- **Read**: `users.prefs.get {keys}` (`operator.read`), when the tab opens and on `users.prefs.changed` naming the key.
- **Write**: `users.prefs.set {entries, expectedEntries}` (`operator.write`), with the value read last as the expectation, so a change from another device is never overwritten.
- **Limits**: one setting holds 4,096 bytes of JSON, about 50 pins of a bot; a person's profile holds 128 settings, shared with every other client.

### Pinning, step by step

| Step                                                             | The row shows                                                                                                                                               | What is on the gateway                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The person chooses Pin                                           | The button pressed and busy (`aria-busy`), the mark not yet shown                                                                                           | Unchanged                                            |
| The gateway answers `ok`; the key is read back and holds the pin | The pin mark; "Pinned Trail guide" is announced                                                                                                             | The pin                                              |
| `conflict`: another device changed Marlow's pins                 | The key is read again and the person's one change applied to it, once. If that is refused again: "Couldn't pin: pins changed on another device. Try again." | The other device's pins, without this one            |
| The value would pass 4,096 bytes                                 | Nothing is sent: "Marlow's pins are full. Unpin one to pin this."                                                                                           | Unchanged                                            |
| The profile's 128 settings are used                              | "Couldn't pin: the gateway keeps at most 128 of your settings, and they are used."                                                                          | Unchanged                                            |
| No answer, or the connection drops                               | "Couldn't pin: no answer from the gateway." The key is read on reconnect, and the row follows what it holds                                                 | Unknown until read: the row says what the read finds |
| Read-only                                                        | The access bar at the foot of the tab: "Pinning needs permission to change things on the gateway." with "Request access"                                    | Unchanged                                            |

Unpin is the same with the pin removed. Nothing is shown as pinned or unpinned until the read-back holds it.

**Another device's change.** On `users.prefs.changed` with this bot's key, the key is read and the marks follow it. With the Pinned filter showing, "Pins changed on another device" is announced.

**A pinned item not found.** The Pinned filter reads each pinned item's task, read or not. An occurrence its task no longer holds (the task deleted, or its history no longer has that message) is a quiet row: "Not found in Saturday's trail plan any more" with Unpin.

### When the gateway keeps no preferences for this connection

A connection the gateway gives no profile is answered `{status: "no_durable_identity"}` (research §8, read from source). Then pins are kept on this device, under the same key in the app's own storage, and the Pinned filter says so under its group word: "Kept on this device only: the gateway keeps no preferences for this connection." They are never copied to the gateway later without the person asking.

## 5. A Page in the conversation

The card is `work-pane.md` §12's page card: the page icon, the title from the block, "Page" as its type, one button, "Open", which opens section 6. It sits under the bubble of the message that showed it.

**Shown again below.** When a later message of the same task shows the same Page (the same `viewId`), the earlier card's second line reads "Page · Shown again below", and its name adds ", shown again below". Opening either shows the Page as the gateway has it now: `canvas.document.view` has no version, so no card claims to show an older one (research §5). Nothing says a Page was updated: the gateway does not say whether it changed, and a bot that makes its page again makes a new Page, with no link to the first.

## 6. A Page, full window

```
bar      [Close]  Trail guide                      [Export…] [Pin] [Chat]
                  Page · Marlow · Saturday's trail plan · 5:37 PM
note     Shown without its 3 scripts. Parts that need them don't work here, and links aren't followed. [Links (2)]
frame    ┌──────────────────────────────┐   chat   Saturday's trail plan
         │  the Page                    │           …the task's last messages…
         │                              │           [About the page “Trail guide”: |      ] [Send]
         └──────────────────────────────┘
```

A modal `dialog` over the whole window, labelled by the Page's title, in the app's own theme (the Page draws its own colours; it is a document, not media). Focus moves to Close when it opens and returns to the card or row that opened it when it closes. Tab stays inside. Escape closes, unless focus is in the chat's field with text, where it first leaves the field.

### The bar

56 px. Close (round, "Close the page (Esc)") at the left; the title (15/500) and the line under it (13, faint): "Page · <Bot> · <task> · <time>". At the right: **Export…** (section 7), **Pin** (section 4, the same states), and **Chat**, a toggle that shows and hides the side chat ("Hide the chat" and "Show the chat", `aria-pressed`).

### The frame

The Page's HTML, read over the socket with `canvas.document.view {docId}` (`operator.read`) for the `viewId` the opened occurrence names, and only then. **A Page makes no request at all, on load or on any interaction.** A sandboxed frame alone does not hold that: a plain link navigates the frame itself (research §4). So the HTML is shown like this:

- parsed aside, where parsing loads nothing;
- its `script`, `base`, `meta[http-equiv]`, `link`, `iframe`, `frame`, `object`, `embed` and `portal` elements removed;
- every `a` element replaced by plain text holding the same words, so no link and no link style is left;
- on every element, `href`, `xlink:href`, `action`, `formaction`, `target` and `ping` taken out, and `src`, `srcset`, `poster`, `data` and `background` taken out unless they are `data:` addresses;
- `default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:` first in its head, as a second layer for what an attribute cannot name (a style's `url()`);
- in an `iframe` with `sandbox=""` (no scripts, no forms, no popups, an opaque origin), as `srcdoc`.

**What the person sees in a link's place**: the link's own words, as plain text in the style of the sentence around them: not coloured or underlined as a link, not focusable, and a click on them does nothing. The note above the frame says links aren't followed and lists their addresses (below). A picture whose address was taken out shows its alternative text, as a broken picture does.

So the Page has no access to the app, to the gateway connection or to other Pages, runs nothing, sends nothing and loads nothing. Research §4 showed no request reaching the probe's server in Chromium for one page; that is evidence, not the guarantee. **The builder writes a check, for each platform's rendering path, that loads Pages built to reach out in every way (scripts, forms, links, refreshes, pictures, styles, frames, objects, prefetch hints) and drives every interaction (clicking every element, submitting every form, pressing Enter in every field), and asserts that zero requests leave the frame**, counted by a loopback server of the check's own and by the platform's request hook (the desktop's request filter). On the desktop the frame is created inert with `srcdoc` and the window then denies the frame any navigation, since the request filter admits the app's own files. A platform shows Pages only once that check passes on it; until then a Page there is unavailable (the state below), and on iPhone it is the sheet of section 8. This is the decision on addresses (`docs/decisions.md`, "Addresses a gateway hands the client"), "A page" row.

**Addresses the app ignores.** `canvas.document.view` also answers `sandboxUrl`, `sandboxPort` and, when configured, `sandboxOrigin`, and the transcript's block carries a `url`: the app reads none of them. The hosted canvas address (`pluginSurfaceUrls.canvas`) is never read, shown, logged, copied, opened or exported, and `plugin.surface.refresh` is never called: it is a bearer address that opens the gateway's own interface (research §3). The same holds for the handshake's `controlUiUrl`, plugin tab paths and `controlUiLinkReaders`: nothing here fetches or opens them, or calls a reader's methods. This is the decision on addresses (`docs/decisions.md`, "Addresses a gateway hands the client"), which the whole of this section follows.

The frame fills the space left of the chat on a white ground (`#fff` in both themes, as a page expects), radius 14, with the pane's hairline. It is a focusable region named "Trail guide, page". The Page scrolls inside it.

### The note

One line on `--bg-pane` above the frame, only with what applies:

- scripts were removed: "Shown without its 3 scripts. Parts that need them don't work here." (the count from the parse);
- links were taken out: "Links aren't followed here." with **Links (2)**, a menu whose items are the full addresses, unabridged; choosing one opens it in the system browser, since its full address is the control's text, unless it is on this device or the person's own network, which gets the confirmation (the decision's link row);
- always, as its last sentence: "Checkboxes, menus and folded sections change only this view."

**Filters and switches change only the view.** In this frame a Page's own controls can do nothing but change what is on the screen, and only those that work without scripts (research §4): a checkbox, a menu, a folded section. Nothing is sent and nothing is kept: closing and opening the Page shows it as the bot left it (F-374). Controls that need the Page's scripts do nothing at all, and the note says so.

### The side chat

360 px at the right, the window's hairline on its left. It is the conversation of the task the opened occurrence belongs to, which the head names: the bot's 22 px avatar and the task's title (15/500).

- The task's messages, as the conversation shows them, scrolled to the end, live.
- **The composer**, the conversation's own, with its field filled with `About the page “Trail guide”: ` and the caret after it. That text is the whole addition: what the field holds is what `chat.send` sends to that task, with the person's next words. They can read it, change it or delete it before sending. Sending follows `conversation.md` (the outbox, Stop, queueing); the message appears in the side chat and in the task.
- **Read-only**: the messages, and the access bar in the composer's place, `conversation.md` §3, with its states.

### States

| State                       | The frame shows                                                                                                                                                                                                                                                                                          | The rest                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Loading                     | "Loading Trail guide…" centred, `aria-busy`                                                                                                                                                                                                                                                              | The bar and the chat at once                                   |
| Shown                       | The Page                                                                                                                                                                                                                                                                                                 | The note, when it has something to say                         |
| The gateway refused         | "The gateway couldn't show this page.", then "The gateway said: Canvas widget unavailable; reload the chat or ask the agent to recreate it.", then "Try again". The gateway answers this one message for every failure, a Page removed among them (it keeps 32 Pages a task), so nothing more is claimed | Export is disabled ("Nothing to export: the page didn't load") |
| Larger than Clawtrate shows | "Trail guide is larger than Clawtrate shows (5 MB)."                                                                                                                                                                                                                                                     | Export is disabled                                             |
| The connection is lost      | The Page stays if it was shown; otherwise "Can't reach the gateway. Try again when it's back."                                                                                                                                                                                                           | The composer follows `conversation.md`                         |

## 7. Exporting a Page

**Export…** in the Page's bar opens a dialog, "Export Trail guide". Nothing is hosted: the file is written on this device, and nothing is uploaded anywhere.

```
( ) As shown here
    The page as Clawtrate shows it: its 3 scripts, its link addresses and anything it would load are taken out. 1.4 KB.
( ) As Marlow made it
    The HTML exactly as the gateway sent it, with its 3 scripts. Opened in a browser, those scripts run with that browser's access, and they can load files from other sites.
Only the page's HTML: files kept beside it on the gateway aren't included.
                                                   [Cancel] [Save…]
```

- "As shown here" is chosen first. "As Marlow made it" is drawn only when the HTML has scripts; without them the two files are the same and the dialog has one sentence in place of the choice.
- **Save…** opens the system's save dialog in Downloads, named after the title, `Trail guide.html`. The file is the HTML read for the Page view; nothing is fetched again.
- After saving: "Exported Trail guide.html" announced, and the dialog closes, focus back on Export…. If the system refuses the file: "Couldn't save Trail guide.html." with the system's reason, and the dialog stays.
- The dialog never calls either file safe, or the export private or shared.

The person shares that file however they like; Clawtrate offers no link to a Page, since the only address the gateway has for one is the bearer address it never uses (research §3).

## 8. On iPhone

The iPhone app follows `visual-language.md` §12 (touch sizes, the three screens) and the decision on addresses (`docs/decisions.md`, "Addresses a gateway hands the client"). There a link's confirmation says "Opens outside Clawtrate" in place of "Opens in your browser".

### The Library in the conversation's info

The task's info sheet (the Work pane's sheet on the phone) has a **Library** section for this conversation (F-371): the filters (All, Pages, Media, Links, Files, Pinned) scrolling sideways as one row, then Today, This week and Older, five rows each with "Show more". It lists what the bot handed over **and what the person sent**: `artifacts.list {sessionKey}` without `messageRole`, keeping the items whose message (by `messageSeq`, from `chat.history`) is the person's or the bot's, and leaving out what a tool returned (research §1). Rows are 56 pt with 17 pt titles. Its freshness line reads "In this conversation · checked 5:41 PM", and it has no "Look in more tasks". Its states are section 3's, with one task: "Couldn't load this conversation's library" and **Try Again**.

### Touch and hold

On a Page row, touch and hold opens a menu: **Open**, **Share as file…** (section 7's choice, then the system's share sheet with the file), **Pin** or **Unpin**. There is no "Copy Link" and no "Open in Web": the gateway's only address for a Page is its bearer surface address, which Clawtrate never shows or hands to another app (research §3; section 11). Other rows open on tap; touch and hold on them gives **Pin** or **Unpin** and the item's own actions from `work-pane.md` §12's menu.

### A Page, full screen

The iPhone app has no web view, and no rendering path there passes the zero-request check, so a Page is unavailable there and its HTML is not shown (the decision's "A page" row). Tapping a Page opens the unavailable state full screen, and says so:

```
[Close]                          Trail guide
           Page · Marlow · 5:37 PM
           Clawtrate for iPhone can't show pages yet.
           You can ask Marlow about this page, or share it as a file.
           [Message about Trail guide]
           [Share as file…]
```

- **Message about Trail guide** closes the sheet and puts `About the page “Trail guide”: ` in the conversation's composer, caret after it; read-only, it is not offered, and the access bar stays where it is.
- **Share as file…** as above.
- **Close** returns to the chat at the same position it left.

This sheet is what the iPhone shows in a Page's place: the title, the bot and the time, the sentence that Clawtrate for iPhone can't show pages yet, and the two actions. No part of the Page's HTML is drawn, not even as text. F-373's target stays a Page full screen: that needs a rendering path on the iPhone that passes the zero-request check (section 6), and the row stays `todo` until it has one; then this sheet shows the Page itself, under the desktop frame's treatment.

## 9. Widths, themes, keyboard and screen readers

| Width          | The Library tab                                                                                                                               | The Page view                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1440           | In the docked pane, 360 px                                                                                                                    | Frame and the 360 px chat side by side                                                                                                |
| 1100           | In the drawer, 360 px                                                                                                                         | Side by side                                                                                                                          |
| 800            | In the drawer, the window less 56 px                                                                                                          | The frame takes the width; Chat opens the chat as a 360 px drawer over the frame's right, with its own Close; it starts hidden        |
| 390 (one pane) | The iPhone: the conversation's Library in the info sheet (section 8). A desktop window this narrow: the bot's Library in the full-width sheet | The iPhone: the sheet of section 8. A desktop window this narrow: the frame full width, and Chat opens the chat as a full-width sheet |

- **Themes**: everything uses the token set; the frame's ground stays white, as a Page's own styles expect, with a hairline in dark.
- **Keyboard**: the filters are one radio group; rows move with arrows; Pin is reached with Tab from its row. In the Page view, Tab goes through the bar, the note's Links, the frame and the chat. ⌘E opens Export; ⌘↵ sends from the chat's field as the composer does.
- **Screen readers**: the Library tab panel is labelled "Library"; each group is a list labelled by its word; the freshness line is a status. The Page view is a `dialog` labelled by the title and described by the note. Pin is a toggle button with its state.
- **Motion**: only skeleton rows pulse, still under reduced motion. The Page view appears at once.

## 10. What the gateway's facts drive

All verified on the development instance unless marked; research sections in brackets.

| Shown                                     | Driven by                                                                                                                                                                                                                  | Tier        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| The bot's tasks, newest first; "of 23"    | `sessions.list {agentId}` with the rail's filters (§1)                                                                                                                                                                     | read        |
| Pictures, recordings, videos, files       | `artifacts.list {sessionKey, messageRole: "assistant"}` per task: whole transcript in one call, `type` `image`, `audio`, `video`, `file`; `{agentId}` alone refused (§1)                                                   | read        |
| Each item's time; Today, This week, Older | The `timestamp` of the `chat.history` row with the entry's `messageSeq`; groups on the device, in its time zone (§1)                                                                                                       | read        |
| Earlier history pages                     | `chat.history {limit, offset}`, `hasMore`, `nextOffset` from the end (§1)                                                                                                                                                  | read        |
| Pages; "Shown again below"                | `canvas` blocks in the bot's rows, `preview.viewId` and `title`; the same `viewId` in a later row (§2, §5)                                                                                                                 | read        |
| No Apps filter                            | MCP App views are `canvas` blocks with `mcpApp`, shown only with scripts (§9, source)                                                                                                                                      |             |
| Links                                     | `http` and `https` addresses in the bot's text (§1)                                                                                                                                                                        | read        |
| The iPhone's items the person sent        | `artifacts.list` without `messageRole`, kept by the row's `role` (§1)                                                                                                                                                      | read        |
| The Page                                  | `canvas.document.view {docId}`: `{html, sandboxUrl, sandboxPort}`, the HTML as written; `UNAVAILABLE` with one message on any failure (§2)                                                                                 | read        |
| Never used                                | `pluginSurfaceUrls.canvas`, `plugin.surface.refresh`, `sandboxUrl`, `sandboxPort`, `sandboxOrigin`, the block's `url`, `canvas.document.preview`, the handshake's `controlUiUrl` and plugin tab paths (§2, §3)             |             |
| The frame and the note                    | Research §4: no script, form, popup, message or request; checkbox, menu and folded section change and reset; links replace the frame unless taken out. The zero-request guarantee is the builder's check (section 6)       |             |
| The side chat                             | `chat.send` to the occurrence's task; refused on the read tier with `missing scope: operator.write` (§6)                                                                                                                   | interactive |
| Export                                    | The HTML from `canvas.document.view`, entrypoint only (§7)                                                                                                                                                                 | read        |
| Pins                                      | `users.prefs.get` (read), `users.prefs.set` with `expectedEntries` (write), `conflict`, `value-too-large` at 4,096 bytes, 128 keys, `users.prefs.changed` to every connection of the profile, read-only ones included (§8) | read, write |
| Pins on this device                       | `{status: "no_durable_identity"}` (§8, source)                                                                                                                                                                             |             |

## 11. Parity rows reworded and decided

Reworded (statuses unchanged):

| Row   | Cell               | New wording                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-210 | Clawtrate target   | better: share by exporting the Page as an HTML file, either as shown (scripts, link addresses and outside references taken out) or as the Bot made it, and the export screen says what each file is and that scripts run with whatever opens it; nothing is hosted publicly.                                                   |
| F-371 | gateway dependency | partial: `artifacts.list {sessionKey}` without `messageRole` lists the task's images, audio, video and files, the person's uploads among them, with what tools returned, told apart by the `chat.history` row's role by `messageSeq`; Pages and links come from `chat.history` (`operator.read`) (`docs/research/library.md`). |
| F-374 | Clawtrate target   | same; note: Clawtrate never runs a Page's scripts, so controls that need them do nothing; checkboxes, menus and folded sections change only this view, and reopening the Page shows the Bot's saved content unchanged.                                                                                                         |

F-210's dependency ("available: `canvas.document.view` (`operator.read`); the client writes the export file") and F-374's ("client only") are right as written.

Rows decided by the coordinator, as they now read in `docs/parity.md` (a note under `same` may only narrow the target):

| Row   | Clawtrate target                                                                                                                                                                                           | Gateway dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-208 | same; note: without the Apps filter: the gateway does not tell an app view apart from a page that runs scripts, which Clawtrate does not run.                                                              | partial: `sessions.list {agentId}` gives the Bot's tasks; `artifacts.list {sessionKey, messageRole: "assistant"}` for each, not paged and with no time on its entries, and the time, Pages (`canvas` blocks) and links from `chat.history`, aggregated in the client (`operator.read`); pins in `users.prefs` on the person's profile (`users.prefs.get` `operator.read`, `users.prefs.set` `operator.write`, 4,096 bytes a key), kept on the device when the gateway answers `no_durable_identity`. No index across tasks and no count. |
| F-209 | same; note: an earlier card of the same Page reads "Shown again below": the gateway keeps no revision of a Page, so nothing says it was updated.                                                           | partial: `canvas.document.view {docId}` (`operator.read`) gives the Page's HTML; the side chat uses `chat.send` (`operator.write`). The hosted `pluginSurfaceUrls.canvas` is never used. Missing: a rendering path with a check that sees zero requests, until which a Page is unavailable.                                                                                                                                                                                                                                              |
| F-372 | same; note: without "Copy Link" and "Open in Web": the gateway's only address for a Page is a capability address that also opens its Control UI, so no link is offered; "Share" shares the Page as a file. | partial: no link to a Page exists for a client to share; `session.publicShare.set` shares a session, not a Page. Share uses the exported file (`canvas.document.view`, `operator.read`).                                                                                                                                                                                                                                                                                                                                                 |
| F-373 | Unchanged: a Page opens full screen with the latest saved version, and its close control returns to the chat at the same position. The row stays `todo`.                                                   | partial: `canvas.document.view {docId}` (`operator.read`) gives the Page's HTML. Missing: a rendering path on the iPhone that passes the zero-request check; the iPhone app has no web view, so a Page is unavailable there. The design draws that unavailable state (section 8).                                                                                                                                                                                                                                                        |

The design's touch-and-hold menu also offers Pin on a Page row (section 4); F-372 does not ask for it.

## 12. For builders

### What each part uses

| Part            | Uses                                                                                            | New                                                     |
| --------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| The Library tab | `.files-fresh`, `.file-row`, the empty state, skeleton rows                                     | `.lib-filters`, `.lib-group`, `.lib-row`                |
| Pins            | The access bar                                                                                  |                                                         |
| The page card   | `.artifact` (`work-pane.md` §12)                                                                | The "Shown again below" line                            |
| The Page view   | The media viewer's dialog behaviour; the conversation's bubbles and composer; `.menu` for Links | `.page-view`, `.page-frame`, `.page-note`, `.page-chat` |
| Export          | The confirmation card's frame (`bots.md` §19)                                                   | `.export-dialog`                                        |

### What the engine supplies

- For a bot: its tasks (the rail's list), and per task read so far, its items: each occurrence keyed by task, `messageSeq` and position, with its kind, title, size, the gateway's id, its time from history, and for a Page its `viewId` and whether a later row shows it again. The tasks read and the total, the time of the read, the tasks that failed.
- History pages read per task, at most 1,000 rows, only as far as the listed items need.
- Per bot, the pins as last read, with the value used as the next `expectedEntries`; the read-back after every write; the re-read on `users.prefs.changed`; the fallback to device storage on `no_durable_identity`.
- For a Page: the HTML read once per opening, its framed form (section 6), the count of scripts and the list of link addresses taken out. None of the addresses the gateway puts beside the HTML.
- The side chat is the task's ordinary transcript subscription and outbox.

### What the gateway must supply

Nothing new. A Page revision, a cross-task index or a count would let the Library say more; none is needed for what it says.

### Order to build

1. The Library tab over the bot's tasks: tasks, items, times, groups, Show more, the freshness line and "Look in more tasks". Check F-208's listing.
2. Pages and links from history; the filters. Check F-208's filters as decided.
3. Pins with read-back, conflict, limits and the change event; device pins on `no_durable_identity`. Check F-208's Pin.
4. The zero-request check for the desktop's rendering path (section 6), then the Page view: the frame, the note, Links. Pages stay unavailable on a platform until its check passes. Check F-209 and F-374.
5. The side chat. Check F-209's side chat.
6. Export. Check F-210.
7. The iPhone's Library, menu and Page sheet. Check F-371 and F-372; F-373 waits for an iPhone rendering path that passes the zero-request check, and until then the sheet of section 8 is drawn.

### Prototype states

`prototype/library.html` takes every parameter `work.html` takes, and these. The fixtures are Marlow's tasks, today being Thursday, November 19 (`bot=marlow&task=m2`: Saturday's trail plan, with the Page shown twice). The prototype bar's "Another device pins" and "Owner approves access" stand for what another device and the gateway's owner do.

| Parameter                | Values                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel=open&tab=library` | Marlow's Library in the Work pane                                                                                                                                                                 |
| `filter`                 | `all`, `pages`, `media`, `links`, `files`, `pinned`                                                                                                                                               |
| `lib`                    | `loading`, `partial` (two tasks couldn't be read), `error`, `empty`, `offline`, `all` (every task read)                                                                                           |
| `pins`                   | `device` (the gateway keeps no preferences), `full`, `none`                                                                                                                                       |
| `pinfail`                | `conflict` (refused twice), `noanswer`, `limit` (the profile's 128 settings used)                                                                                                                 |
| `page`                   | `trail-guide`, `trail-guide-1` (the earlier occurrence), `packing-list` (no scripts, no links): the Page view                                                                                     |
| `pageload`               | `failed`, `large`, `offline`, `unavailable` (no zero-request check on this platform yet)                                                                                                          |
| `chat`                   | `hidden`                                                                                                                                                                                          |
| `export`                 | `open` (with `page`); `exportfail=1`: the system refuses the file                                                                                                                                 |
| `width=phone`            | The iPhone's forms: with `panel=open&tab=library`, the conversation's Library in its info sheet; a Page opens the sheet of section 8. `device=desktop` shows a desktop window that narrow instead |
| `hold`                   | An item id: its touch-and-hold menu (phone)                                                                                                                                                       |
| `state=readonly`         | The read-only connection                                                                                                                                                                          |

## 13. Not covered here

- The Details tab, Files, Computer and Settings, and the artifact cards and media viewer themselves (`work-pane.md`, `bots.md`).
- Search across the Library: the gateway has none, and the design does not add one.
- MCP Apps, and any way to run a Page's scripts.
- Sharing a Page by a link or hosting it anywhere.
- An iPhone rendering path for Pages: F-373 stays `todo` until one passes the zero-request check (section 8).
- Pins of tasks or bots (the rail's pins, `visual-language.md` §7), which are a different thing.
