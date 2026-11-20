# The Library and Pages

What a bot made, gathered in one place, and the Pages among it: the Library tab in the Work pane, a Page's card in the conversation, a Page opened full window with a chat beside it, exporting a Page as a file, and the iPhone's forms of each. It builds on `visual-language.md` (tokens, the pane's frame), `conversation.md` (the transcript, sending, the access bar) and `work-pane.md` Part 2 (artifact cards, the pane's view of an item, the media viewer), which it reuses as they are designed.

The behaviour comes from the teardown's Library section (`docs/research/grok-bot-flows.md`, §9.5) and is checked by `docs/parity.md` rows F-208 to F-210 and F-371 to F-374. The research note, `docs/research/library.md` (cited as "research §n"), distinguishes live gateway results, shipped source and open questions. Section 10 maps each fact to what is shown; section 11 lists the rows reworded and the four decided; section 12 is for builders.

The rule from `conversation.md` holds: **no state claims more than the gateway has reported.** The Library is assembled by the client from per-task reads, so it always says which tasks it read in full, and what it could not read. Where something cannot be established, the screen does not claim it. A Page is content a bot wrote: it is shown as data, never with the app's own rights.

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
- **What it lists**: the pictures, recordings, videos and files a bot handed over in its messages, the Pages it showed, and the links it wrote. The gateway lists the first four per task, with no time (research §1); Pages and links are read from the task's history by the client, only as far as it reads. Nothing on the gateway lists them across tasks or counts them, and older or shortened history can hide Pages and links, so the Library says where it stopped.
- **Opening an item** goes to the screen `work-pane.md` already designs for it: a picture or a video to the media viewer (§14); a file or a recording to its task's Files tab, in the item's view (§13), with that task opened; a link through the opening policy of the decision on addresses (`docs/decisions.md`, "Addresses a gateway hands the client"). A Page opens full window (section 6) from every way to it: its card in the conversation, a Library row, and any other route a client adds, such as the media viewer's former page frame. All of them pass section 6's gate. This replaces `work-pane.md` §12's "It opens in the media viewer's frame" for pages; nothing else of Part 2 changes.

## 2. Shared rules

### Components reused

| Thing                                                                                                                                                                                                                                                                            | From                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| The pane's frame, tabs, the empty state (44 px mark, 15/500 title, one sentence)                                                                                                                                                                                                 | `visual-language.md` §9                                                                 |
| The freshness line: what was read, when, and an action (`.files-fresh`)                                                                                                                                                                                                          | `work-pane.md` §9                                                                       |
| A file row: 48 px (56 on touch), the kind's 32 px tile or a thumbnail, the name cut in the middle, a second line in 13 faint (`.file-row`)                                                                                                                                       | `work-pane.md` §4                                                                       |
| Skeleton rows, still under reduced motion                                                                                                                                                                                                                                        | `work-pane.md` §2                                                                       |
| The page card (`.artifact`, the page icon, "Page")                                                                                                                                                                                                                               | `work-pane.md` §12                                                                      |
| The item's view in Files, and the media viewer                                                                                                                                                                                                                                   | `work-pane.md` §13 and §14                                                              |
| The access request and its states (read-only, asking, waiting for the owner, denied, expired), drawn inside the surface where it was asked for                                                                                                                                   | `conversation.md` §3                                                                    |
| Bubbles, the composer, the task's draft and sending (the outbox, `followup`); "Replace your draft?" with Keep draft and Replace draft                                                                                                                                            | `conversation.md`; `links.md` §2                                                        |
| One canonical address, the decision's one written-host rule for every surface, and one opening policy; the link confirmation: host first, the full address, the network warning where it applies, "Opens in your browser" ("Opens outside Clawtrate" on iPhone), Cancel and Open | The decision on addresses (`docs/decisions.md`, "Addresses a gateway hands the client") |
| `.menu`, the round quiet icon button, a line that says something failed with "Try again"                                                                                                                                                                                         | `visual-language.md` §4 and §8                                                          |

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

| Tier        | The Library and Pages show                                                                   | They offer                                                                                                                                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read        | Everything: the Library, pins as the gateway keeps them, Pages, the side chat's conversation | Opening, Show more, looking in more tasks, export. Pin and sending give way to the conversation's access request, drawn inside the surface where it was asked for: the Library tab, the Page view, the iPhone's sheet. Nothing is changed on the gateway before it is approved |
| Interactive | The same                                                                                     | Pin and Unpin; sending from the side chat                                                                                                                                                                                                                                      |
| Admin       | The same                                                                                     | Nothing more. Nothing here asks for admin                                                                                                                                                                                                                                      |

Every read is `operator.read` (research §1, §2, §8). Pin is `users.prefs.set` and sending is `chat.send`, both `operator.write`, which the interactive tier holds. The request for access is the one `conversation.md` §3 makes, never silent.

### Time

Every time is the `timestamp` of the message that carried the item, from `chat.history`. **Today**, **This week** and **Older** are computed on the device, in the device's time zone: Today from local midnight; This week from the start of the current week in the device's region (Monday where the platform does not say) to local midnight; Older before that. The gateway gives no time on an artifact (research §1), so an item whose message has not been read has no group; see "Time not read" below. A row shows the time as the conversation does: "5:37 PM" today, the weekday this week, "Nov 12" older.

### Text

Every name the gateway supplies (bots, tasks, items, Pages), every type, title, address, alt text and error is drawn through text nodes or the framework's text bindings, never as markup. Only the Page's inert frame (section 6) draws document markup. A bot named `<em>Marlow</em>` shows those characters.

### Words

No "secure", "safe" or "private" anywhere in this design. A Page is "shown without its scripts", never "safe"; an export is "a file on this device", never "private". The gateway's own refusal is quoted as the gateway's ("The gateway said: …").

### Announcements

The conversation's polite live region speaks for the Library and Pages, and only for: "Pinned Trail guide" and "Unpinned Trail guide" once the gateway's preferences were read back; "Couldn't pin Trail guide" with the reason; "Pins changed" when a read after the gateway's change event finds a value different from the last one confirmed, with the Pinned filter showing; "Read 18 of Marlow's 23 tasks in full" after "Look in more tasks", counting only the tasks whose reads both completed; "Exported Trail guide.html" once the file is written; on iPhone "Share sheet opened with Trail guide.html", never that it was shared; "Couldn't show Trail guide". Loading and a refresh that changed nothing are not spoken.

## 3. The Library tab

```
filters        [All] Pages  Media  Links  Files  Pinned
fresh          Read 8 of Marlow's 23 tasks in full · checked 5:41 PM   [Refresh]
notes          Couldn't fully read 2 tasks. [Try again]   Older messages or some message content weren't read in 2 tasks.
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

1. **Tasks**: the rail's task list for the bot, with the rail's filters and order (`sessions.list {agentId}`). The number of matching tasks is the reply's `totalCount` when present. The Library takes ten at a time, following `hasMore` and `nextOffset` for the next batch.
2. **Items**, per task: `artifacts.list {sessionKey, messageRole: "assistant"}`, the bot's handed-over items in one reply, untyped and with no time (research §1).
3. **Pages, links and times**, per task: `chat.history`, from the newest page back, following `nextOffset` until `hasMore` is false or 1,000 rows have been inspected, **whether or not the task has artifacts**, since a Page or a link needs no artifact. Each request asks only for what the remaining budget allows, and reading stops on an offset that does not advance. From the bot's rows it takes each Page (a `canvas` block with a nonempty `preview.viewId`, without `mcpApp`), each link (an `http` or `https` address in the bot's text that the decision on addresses accepts as one canonical address) and each listed item's time (by `messageSeq`). A row marked `__openclaw.truncated`, or replaced by the gateway's omission placeholder, counts as incomplete for Pages and links.
4. **Source states**: per task, the item read and the history read each end completed, partial (the 1,000-row limit, a truncated or omitted row) or failed. Count a task as completed only after both source reads completed for the same confirmed session. A cap with more rows, a nonadvancing or missing required offset, a truncated or omitted row, or a failed source leaves it out of the completed count. Keep rows from sources that answered.
5. **Responses** are applied only when the task key and session they answer are still the task being read; an answer for a task that changed meanwhile is dropped and read again.
6. It reads again when the tab is opened, on Refresh, and when a message from the bot arrives in a task it read. On a refresh it keeps the last confirmed rows; while reconnecting they stay, labelled as what was read.

**The freshness line** says what was read in full, always, out of the tasks matching the rail's current filters: the completed count is the tasks whose returned sources were both read to completion. "Read 8 of Marlow's 23 tasks in full · checked 5:41 PM", or "Read all 6 of Marlow's tasks in full · checked 5:41 PM"; "Checked 8 tasks" if `totalCount` is absent. Tasks tried and not read in full are named separately under it: "Couldn't fully read 2 tasks." with "Try again". When a history read stopped at the limit or met an incomplete row: "Older messages or some message content weren't read in 2 tasks." "Look in 10 more tasks" at the foot reads the next ten. With every task tried, the foot is gone. A row count is never shown as a total of the bot's items. Whenever the relevant source is incomplete, an empty filter keeps "No pages in the messages read".

### Filters

A row of pill buttons, a `radiogroup` named "Show": **All**, **Pages**, **Media** (pictures, recordings, videos), **Links**, **Files**, **Pinned**. The chosen one is a `--bg-selected` pill; the others are muted text, as the tabs are. Arrows move and choose; one tab stop. The choice belongs to the pane and is kept across tasks and bots, like the chosen tab.

**There is no Apps filter.** The gateway marks an MCP App view only as a `canvas` block carrying `mcpApp`, such a view runs only with its scripts, and Clawtrate runs no page's scripts (research §9). It would list items that cannot be opened here, so the filter is cut (section 11).

### Groups and Show more

Today, This week and Older, each headed by its word (13, faint), newest first, ties by message order then position. Each group shows five rows, then "Show 5 more" (or "Show 2 more", the rest of what was read for that group); focus stays on the button, which moves down. After the last batch the button is gone, and focus goes to the first row it revealed. A group with no rows is not drawn.

**Time not read.** An item listed by `artifacts.list` whose message was not in the history read has no time. It goes last, under "Time not read", with the sentence "The message time wasn't available in the history read." It is never put in Older by guess.

### A row

`.file-row`, with:

- **The tile**: the kind's icon on `--bg-pane`. A picture's 32 px thumbnail is used only when the existing hand-over path already holds its confirmed preview bytes; otherwise the kind's icon. Opening or refreshing the Library makes no request for any item or preview.
- **The title**: an item's title as the gateway gives it (`work-pane.md` §11), a Page's `title` from its block, or a link's text (its address when it has none). Cut in the middle so an extension stays.
- **The second line** (13, faint): the type in words, the size when known, the time, then the task's title, which is what shortens when the line is too long: "PNG image · 1.2 KB · 5:31 PM · Saturday's trail plan"; "Page · 5:37 PM · Saturday's trail plan"; a link "trails.example · 5:34 PM · Saturday's trail plan" (its host).
- **A pin mark** after the title when pinned.
- **Pin** (section 4): a quiet round 28 px button at the right, shown on hover and focus and always on touch, named "Pin Trail guide" or "Unpin Trail guide" (`aria-pressed`).
- The row is one button: "Trail guide, Page, in Saturday's trail plan, 5:37 PM. Open." Up and Down, Home and End move between rows; Enter opens.

Two cards of one Page are two rows, one per occurrence, as `work-pane.md` §11 keeps one card per occurrence. The earlier one's second line reads "Page · 5:33 PM · Shown again below · Saturday's trail plan" (section 5).

### Opening an item

| Item                  | Opens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Page                | The Page view (section 6), for that occurrence's task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A picture or a video  | The media viewer at that item (`work-pane.md` §14); its sequence is the items of that message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A file or a recording | Its task opens in the conversation, and the pane shows Files with the item's view (`work-pane.md` §13); Back in Files returns to "Sent in chat"                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A link                | Nothing is fetched. A Library row's title is cut to fit, so it never shows a whole address for certain: every link row opens the link confirmation first, host first, the full canonical address, "Opens in your browser", Cancel and Open, and the decision's warning for an address on this device ("This address points to this device.") or the person's own network ("This address may be on your own network."). Open hands the system the address the confirmation showed. Cancel and Escape return focus to the row. No preview is fetched on choosing or hovering a row |

An address that is invalid, relative, of another scheme or carries a user name or password is not a link: it stays text in its message and is not listed. The Library itself fetches no item. What an item's view fetches is `work-pane.md`'s, under the decision on addresses (`docs/decisions.md`, "Addresses a gateway hands the client"): only what the gateway issued as a download grant is fetched by the app by itself, and a grant's address is never shown, copied, exported or handed to a browser. An address `artifacts.download` passes through from the transcript is not a grant. A row's second line names a type, a size, a task and a time, never an address, except a link's host.

### States of the tab

| State                                      | It shows                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                                    | The filters, the freshness line "Looking in Marlow's tasks…", five skeleton rows, `aria-busy`                                                                                                                                                                                                                                                                               |
| Loaded                                     | As above                                                                                                                                                                                                                                                                                                                                                                    |
| Some tasks not read in full                | The rows their answering sources gave, the others' rows, the freshness line counting the tasks read in full, and above the groups, under every filter, Pinned included: "Couldn't fully read 2 tasks." on `--danger-soft` with "Try again", which reads those again. Nothing announces them as read                                                                         |
| History stopped at the limit or incomplete | "Older messages or some message content weren't read in 2 tasks." under the freshness line, under every filter                                                                                                                                                                                                                                                              |
| Nothing could be read                      | With no item or history response, the existing failed state: the empty mark with a warning, "Couldn't load Marlow's library", the gateway's reason in one sentence, "Try again"                                                                                                                                                                                             |
| Empty, All                                 | "Nothing found", "Pages, pictures, files and links Marlow sends appear here." with the freshness line and its notes above                                                                                                                                                                                                                                                   |
| Empty, a filter                            | After a complete read: "No pages in the tasks searched." (or pictures and recordings, links, files). After a partial read: "No pages in the messages read." While tasks remain: "Look in 10 more tasks"                                                                                                                                                                     |
| Pinned, empty                              | "Nothing pinned", "Pin an item to keep it here. Pins are kept on the gateway, for every connection on your profile." (or "on this device", section 4)                                                                                                                                                                                                                       |
| The connection is lost                     | Keep the last confirmed rows. Refresh, Try again and Look in more tasks return when the gateway reconnects. The freshness line reads "Can't reach the gateway · showing what was read at 5:41 PM". Opening an item whose content isn't on the device says "Couldn't reach the gateway. Try again when it's back." A Page read earlier in this session opens from the device |
| Read-only                                  | Everything, with Pin giving the access request at the foot of the tab when the person chooses one (section 4)                                                                                                                                                                                                                                                               |

## 4. Pins

### Where they are kept

In the person's preferences on the gateway, `users.prefs`, under one key per bot, `clawtrate.library.pins.<botId>`, scoped to the person's profile: a list of the pinned occurrences, newest pin first. Each names the task's key, the session ID the history read reported for it, and the message's sequence number; the gateway's artifact ID where the artifact listing reports one; and an occurrence index only where the message's ordered blocks, read from history, confirm it. Research §8 established that these preferences belong to the person's profile, not to this device: connections on the same gateway profile read the same saved pins. A read-only connection cannot change them.

- **Read**: `users.prefs.get {keys}` (`operator.read`), when the tab opens, on reconnect, and on `users.prefs.changed` naming the key. That event carries only the profile and the keys, and reaches the device that made the change too.
- **Write**: `users.prefs.set {entries, expectedEntries}` (`operator.write`), a compare-and-set against the value last observed, `null` for an absent key. Removing the last pin deletes the key, compared the same way.
- **Limits**: one setting holds 4,096 bytes of JSON; a person's profile holds 128 settings, shared with every other client. No count of pins is shown.

**Resolving a pin.** Pins are restricted to the connected gateway, its profile and the bot, and on iPhone to the active session. Each pin is matched by its task key, session ID, the message ID the gateway reports where it does, its sequence number, and the reported artifact ID or confirmed block position. If a sequence alone cannot distinguish the original message after a history change, the pin is left unresolved. A normal row is drawn only when the matching same-session source confirms the occurrence, or the previously confirmed row is kept with explicit cached freshness. "Not found in Saturday's trail plan" needs a complete read of the relevant source covering that occurrence in the same session. Otherwise the row is "Couldn't verify this pinned item", with what the read found (the task couldn't be read; the task now holds a different session from the one pinned; the message at this place is a different one now; the history wasn't read in full) and Unpin.

**On iPhone** the Pinned filter of a conversation's Library lists that conversation's pins only.

### Pinning, step by step

| Step                                | The row shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | What is on the gateway                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The person chooses Pin              | The button pressed and busy (`aria-busy`), the mark not yet shown                                                                                                                                                                                                                                                                                                                                                                                                             | Not yet written                                                        |
| The gateway answers `ok`            | The key is read and compared; the mark appears only if the read holds the pin, and "Pinned Trail guide" is announced                                                                                                                                                                                                                                                                                                                                                          | The value read back, or unknown until the read succeeds                |
| `conflict`                          | The key is read; if the change is still needed, it is applied once to what was read, then read back                                                                                                                                                                                                                                                                                                                                                                           | The value read from the gateway, with the pin if the second write held |
| `conflict` again                    | The marks follow the read: "Couldn't pin: Marlow's pins kept changing on the gateway. Try again."                                                                                                                                                                                                                                                                                                                                                                             | The value read from the gateway                                        |
| The value would pass 4,096 bytes    | Nothing is sent: "Marlow's pins are full. Unpin one to pin this."                                                                                                                                                                                                                                                                                                                                                                                                             | This action sent no write                                              |
| The profile's 128 settings are used | "Couldn't pin: the gateway keeps at most 128 of your settings, and they are used."                                                                                                                                                                                                                                                                                                                                                                                            | The gateway refused this write                                         |
| No answer, or the connection drops  | The last confirmed mark stays, with "Couldn't confirm this pin change. Checking when the gateway is back." On reconnect the key is read, never written again: the mark follows the read; "Pinned Trail guide" if it holds the pin, otherwise "This item isn't pinned on the gateway. Try again." (for Unpin, "This item is still pinned on the gateway. Try again."). If that read doesn't answer either, "Couldn't confirm this pin change" and the last confirmed mark stay | Unknown until read: the change may have been written                   |
| Read-only                           | The access request, inside the active surface (the tab, the Page view, the iPhone's sheet), focused: "Pinning needs permission to change things on the gateway." with "Request access"                                                                                                                                                                                                                                                                                        | This action sent no write                                              |

Unpin is the same with the pin removed. Nothing is shown as pinned or unpinned until a read holds it.

**A change event.** On `users.prefs.changed` with this bot's key, the key is read. "Pins changed" is announced, with the Pinned filter showing, only when the read differs from the value last confirmed: the event this device's own write causes, or one that changes nothing, says nothing.

### When the gateway keeps no preferences for this connection

Only when the gateway answers `{status: "no_durable_identity"}` (research §8, read from source) are pins kept on this device, in the app's own storage under a key that includes the gateway's identity, so two gateways' pins never mix. The Pinned filter then says so under its group word: "Kept on this device only: the gateway keeps no preferences for this connection." They are never copied to the gateway later without the person asking.

## 5. A Page in the conversation

The card is `work-pane.md` §12's page card: the page icon, the title from the block, "Page" as its type, one button, "Open", which opens section 6. It sits under the bubble of the message that showed it.

**Shown again below.** When a later message of the same task's transcript shows the same Page (the same nonempty, valid `viewId`), the earlier card's second line reads "Page · Shown again below", and its name adds ", shown again below". Opening either shows the Page as the gateway has it now: `canvas.document.view` has no version, so no card claims to show an older one (research §5). Nothing says a Page was updated: the gateway does not say whether it changed, and a bot that makes its page again makes a new Page, with no link to the first. Every client route uses these words: the artifacts work's card (#144, `cards.tsx`), which reads "A newer version is below", is to read "Shown again below" before either ships.

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

A modal `dialog` over the whole window, labelled by the Page's title, in the app's own theme (the Page draws its own colours; it is a document, not media). Focus moves to Close when it opens. Closing returns to what opened it: a card in the transcript, with the transcript at the position it had; a Library row, with the Library at that row. Tab and Shift+Tab stay inside the topmost dialog (Export or a confirmation over the Page view, otherwise the Page view), and covered controls are skipped. Escape closes the topmost dialog, unless focus is in the chat's field with text, where it first leaves the field. Inside the frame the Page is a separate document whose keys Clawtrate does not see in the web preview: Shift+Tab from the Page's first control leaves the frame, and Escape then closes. The desktop's window input hook also sees Escape inside the frame and closes.

### The bar

56 px. Close (round, "Close the page (Esc)") at the left; the title (15/500) and the line under it (13, faint): "Page · <Bot> · <task> · <time>". At the right: **Export…** (section 7), **Pin** (section 4, the same states), and **Chat**, a toggle that shows and hides the side chat ("Hide the chat" and "Show the chat", `aria-pressed`).

### The frame

<a id="the-occurrence"></a>**The occurrence.** For both rendering and export, activate and confirm the occurrence's task and current session before reading. Match the selected occurrence in that transcript and require a valid nonempty `preview.viewId` on a canvas block without `mcpApp`. Give an unavailable state if the occurrence cannot be confirmed. This applies to cached drawing, Files, pins, reload and any later search route. The transcript authority lives in the Page read path, not in a UI route or URL.

**One gate, at every entry point.** A conversation card, a Library row and any other route to a Page (the Files hand-over, the media viewer's former page frame on #144) all open this view and pass the same gate. On each platform, desktop and web preview alike, a Page is drawn only once that platform's rendering path passes the zero-request check below. Until then the view shows the unavailable state (States, below): nothing is read, parsed or drawn, and Export reads the entrypoint only when the person chooses it. The iPhone keeps its sheet (section 8) until its own path passes.

**What the builder does, in order, once the gate is open:**

1. Make the selected occurrence's task active before requesting the Page.
2. Accept a nonempty `preview.viewId` only on a `canvas` block in that task's current transcript.
3. Read the entrypoint over the existing socket with `canvas.document.view {docId}` (`operator.read`), only then. A reply larger than 5 MiB of UTF-8 is not drawn.
4. Parse it without a browser resource loader (a parser that runs no script and fetches nothing).
5. Remove scripts, `base`, refresh, prefetch and other hints, and every navigable or embedded element (`link`, `iframe`, `frame`, `object`, `embed`, `portal`, `template`), and every external reference: `href`, `action`, `formaction`, `ping`, `srcdoc`, `src`, `srcset`, `poster`, `data`, `background`, event attributes, and `url()` and `@import` in styles.
6. Unwrap forms, keeping their controls inert: a submit button becomes a plain button.
7. Turn every link into plain text in the style of the sentence around it, and collect its address, as one canonical address under the decision on addresses, for the note's Links.
8. Keep only bounded inline data the address decision allows: a `data:` picture whose decoded bytes are PNG, JPEG, WebP or GIF, match its label, and are 2 MiB at most. Anything else is removed, and its alt text shows.
9. Put `default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'` first in its head.
10. Create the frame with `sandbox=""` (no scripts, no forms, no popups, an opaque origin), no referrer, and the result as `srcdoc`, before it joins the window. Deny any navigation after that first document; on the desktop the window denies it, since the request filter admits the app's own files.

**What the person sees in a link's place**: the link's own words, as plain text in the style of the sentence around them: not coloured or underlined as a link, not focusable, and a click on them does nothing. The note above the frame says links aren't followed and lists their addresses (below). A picture whose address was taken out shows its alternative text.

So the Page has no access to the app, to the gateway connection or to other Pages, runs nothing, sends nothing and loads nothing. **The builder writes the zero-request check, per platform, on that platform's actual rendering path** (the desktop's frame in Electron, the web preview's page with its own origin and cookie, later the iPhone's). It runs from before parsing to after teardown, with the platform's request observer and loopback counters of its own. Its Pages reach out every way: same-origin, other-origin and local or app addresses, popups, redirect sentinels, scripts, forms, pictures, fonts, styles, frames and hints. It drives them with pointer and keyboard. It asserts zero requests from the Page, zero frame navigations beyond the first inert document, no popup, and no action on the parent or any bridge. A platform shows Pages only once that check passes there. The prototype's check is evidence for its fixture only ("the Trail guide fixture made no network requests").

**Addresses the app ignores.** `canvas.document.view` also answers `sandboxUrl`, `sandboxPort` and, when configured, `sandboxOrigin`, and the transcript's block carries a `url`: the app reads none of them. The hosted canvas address (`pluginSurfaceUrls.canvas`) is never read, shown, logged, copied, opened or exported, and `plugin.surface.refresh` is never called: the hosted Page route needs a capability that also serves the gateway's Control UI (research §3). The same holds for the handshake's `controlUiUrl`, plugin tab paths and `controlUiLinkReaders`: nothing here fetches or opens them, or calls a reader's methods. This is the decision on addresses (`docs/decisions.md`, "Addresses a gateway hands the client"), which the whole of this section follows.

The frame fills the space left of the chat on a white ground (`#fff` in both themes, as a page expects), radius 14, with the pane's hairline. It is a focusable region named "Trail guide, page. Shift+Tab leaves it." The Page scrolls inside it.

### The note

One line on `--bg-pane` above the frame, only with what applies:

- scripts were removed: "Shown without its 3 scripts. Parts that need them don't work here." (the count from the parse);
- links were taken out: "Links aren't followed here." with **Links (3)**, a menu whose items are the full canonical addresses, wrapped and never cut. Choosing one opens it in the system browser, since its whole address is the control's text, unless it is on this device or the person's own network, which gets the confirmation with the warning. Up, Down, Home and End move in the menu; Escape closes it, focus back on Links. An address the decision does not accept is not in the menu. Use the shared written-host classifier for warnings, including special-purpose literals and mapped IPv4. Opening performs no lookup. The Library's link rows and this menu use the decision's one written-host rule; in the app it lives in the shared core with the link preview's numeric checks, which the artifacts work (#144) moves there;
- always, as its last sentence: "Checkboxes, menus and folded sections change only this view."

**Filters and switches change only the view.** In this frame a Page's own controls can do nothing but change what is on the screen, and only those that work without scripts (research §4): a checkbox, a menu, a folded section. Nothing is sent and nothing is kept: reopening reads the Page as it is then, and changes made to controls in the previous view are discarded (F-374). Controls that need the Page's scripts do nothing at all, and the note says so.

### The side chat

360 px at the right, the window's hairline on its left. It is the conversation of the task the opened occurrence belongs to, which the head names: the bot's 22 px avatar and the task's title (15/500).

- The task's messages and its outbox, drawn from the occurrence task's existing transcript rendering, scrolled to the end, live: only message and queue state is copied, never a focusable card or an id. It follows that transcript on every render and connection change, and the draft field stays mounted.
- **The composer** is the conversation's own, on the occurrence task's existing draft and outbox. With an empty draft, the field gets `About the page “Trail guide”: ` and, when the person goes to the chat, the caret after it. With text already in the draft, it is kept, and "Replace your draft?" offers Keep draft and Replace draft (the existing draft confirmation, `links.md` §2); Escape keeps. That text is the whole addition: Apply the conversation composer's normal text handling, then send that text to this task. Clawtrate adds no hidden Page prompt or attachment. Enter and Shift+Enter follow the conversation's composer (`conversation.md` §15). Sending is the conversation's send (the outbox, Stop, queueing): both the side chat and the conversation show the same pending message, then the same confirmed one.
- **Read-only**: the messages, and in the composer's place "Read-only: messages can't be sent from this device." with Request access. The request is drawn inside the Page view, under the note, with its states: asking, waiting for the owner, approved (the composer appears), denied and expired. When a request made from Chat is approved, put focus in the composer. When approval came from a pin request, return focus to Pin and wait for the person to choose it again. The iPhone's sheet follows the same rule.
- At 800 and narrower the chat is a drawer with its own Close, which hides it and returns focus to Chat.

### States

| State                          | The frame shows                                                                                                                                                                                                                                                                                          | The rest                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Loading                        | "Loading Trail guide…" centred, `aria-busy`                                                                                                                                                                                                                                                              | The bar and the chat at once                                                                                            |
| Shown                          | The Page                                                                                                                                                                                                                                                                                                 | The note, when it has something to say                                                                                  |
| Not shown on this platform yet | "Clawtrate can't show pages here yet." and "You can export this page as a file." (with ", or ask Marlow about it in the chat" where the chat can send). Nothing is read, parsed or drawn                                                                                                                 | The note is hidden; the chat works; Export reads the entrypoint when chosen, with its loading and failure in the dialog |
| The gateway refused            | "The gateway couldn't show this page.", then "The gateway said: Canvas widget unavailable; reload the chat or ask the agent to recreate it.", then "Try again". The gateway answers this one message for every failure, a Page removed among them (it keeps 32 Pages a task), so nothing more is claimed | Export is disabled, and ⌘E does nothing ("Nothing to export: the page didn't load")                                     |
| Larger than Clawtrate shows    | "Trail guide is larger than Clawtrate shows (5 MiB)."                                                                                                                                                                                                                                                    | Export is disabled                                                                                                      |
| The connection is lost         | A Page read earlier in this session is drawn from the device; otherwise "Couldn't reach the gateway. Try again when it's back."                                                                                                                                                                          | The composer follows `conversation.md`                                                                                  |

## 7. Exporting a Page

**Export…** in the Page's bar, or ⌘E, opens a dialog, "Export Trail guide"; both share one guard, so neither does anything while the Page has nothing to export. Nothing is hosted: the file is written on this device, or handed to the iPhone's share sheet.

```
( ) As shown here
    Saves the Clawtrate version, with scripts, navigable controls and outside references removed. 1.4 KB.
( ) As Marlow made it
    Saves the original HTML. When opened, it can run scripts or contact other sites. 1.6 KB.
Both files contain the page's HTML only: files kept beside it on the gateway aren't included.
The file is saved on this device; Clawtrate uploads nothing.
                                                   [Cancel] [Save…]
```

- **The bytes**: "As shown here" is the framed form of section 6, exactly; "As Marlow made it" is the entrypoint exactly as the gateway sent it. Compare the UTF-8 bytes. Offer both versions when they differ. If they match, show one HTML file choice. The Clawtrate version uses the document before any changes to its on-screen controls. A style block or style attribute is kept in it only if it names no outside reference, as in the frame. Save or Share writes these bytes and makes no HTTP fetch. The export never adds a gateway address or credential.
- **One dialog, one read**: each dialog is bound to its own occurrence and its own read. Save stays disabled while the read runs, and a reply that arrives after its dialog closed, or for another Page, is dropped. On iPhone, Share as file… from a Page row's menu opens the same dialog over the Library, which waits until it closes, and focus returns to that row; from the Page's sheet, to its Share button.
- **The occurrence**: Export and Share read only for a confirmed occurrence, exactly as drawing does (section 6, "The occurrence"); an unconfirmed one offers no file.
- **Not drawn here**: on a platform where drawing is unavailable, the entrypoint is read over the gateway socket only after the person chooses Export or Share, with "Reading Trail guide from the gateway…" in the dialog, and a failure there with the gateway's words and "Try again". The first option is then named "Clawtrate version".
- **Size**: the same 5 MiB of UTF-8 as drawing; a larger Page says "Trail guide is larger than Clawtrate exports (5 MiB)."
- **The name**: one base name from the title's last part, with characters a file system reads as a path or reserves replaced, then `.html`: "Trips/Saturday: guide" gives `Saturday- guide.html`. The bot's title stays as the dialog's text.
- **Save…**: Desktop Save opens the system's save dialog, starting in Downloads. After the native write succeeds, announce the saved basename ("Exported Trail guide.html"). In the web preview, start a browser download with that basename. The browser chooses where to save it; Clawtrate announces only "Download started: Trail guide.html". Focus returns to what opened the dialog. If the system refuses the file: "Couldn't save Trail guide.html." with the system's reason, and the dialog stays.
- **On iPhone**, **Share…** writes a temporary HTML file of the chosen bytes and hands it to the system's share sheet. Clawtrate says only that the sheet opened ("Share sheet opened with Trail guide.html"), never that anything was shared; cancelling the sheet says nothing more. If the sheet can't be shown: "Couldn't open the share sheet." with the system's reason, and the dialog stays. The dialog's last sentence there reads "Clawtrate hands the file to the system's share sheet; where it goes from there is your choice."
- The dialog never calls either file safe, or the export private or shared.

The person shares that file however they like. Clawtrate offers no link to a Page: there is no shareable Page link, and the hosted Page route needs a capability that also serves the gateway's Control UI (research §3).

## 8. On iPhone

The iPhone app follows `visual-language.md` §12 (touch sizes, the three screens) and the decision on addresses (`docs/decisions.md`, "Addresses a gateway hands the client"). There a link's confirmation says "Opens outside Clawtrate" in place of "Opens in your browser".

### The Library in the conversation's info

The task's info sheet (the Work pane's sheet on the phone) has a **Library** section for this conversation (F-371): the filters (All, Pages, Media, Links, Files, Pinned) scrolling sideways as one row, then Today, This week and Older, five rows each with "Show more". Rows are 56 pt with 17 pt titles. Its freshness line reads "In this conversation · checked 5:41 PM", and it has no "Look in more tasks". Its states are section 3's, with one task, its failed and partial notes included ("Couldn't fully read this conversation." with **Try Again**; "Older messages or some message content weren't read."); on Media, while uploads may be missing, an empty list says "No media in the items read." Otherwise, with one task: "Couldn't load this conversation's library" and **Try Again**; and "No links in this conversation." when a complete read found none.

It lists confirmed artifacts, and the Pages and links read from the conversation's history:

- **The bot's items**: `artifacts.list {sessionKey, messageRole: "assistant"}`, as on the desktop.
- **The person's links**: text links in the person's own messages, where their history row was read; "sent by you" only where that row establishes it.
- **The person's uploads**: the untyped artifact list can omit them (research §1: it returned none of five). The image listing returned five metadata entries with `source: "session-transcript-preview"` and `download.mode: "unsupported"`. The tested entries held an `image.url` but did not return inline PNG previews. List these as ‘Preview unavailable’ and leave the address unused. If a reply supplies inline image bytes accepted by the address decision, those bytes may be shown as ‘Preview only’ with Close and no Download, Copy or Share. Some uploads may be missing. A ‘Preview unavailable’ row opens nothing: choosing it says "Can't open map-1.png here: the gateway didn't return its picture.", it has no touch-and-hold menu, and focus stays on it. No download route is invented for them.
- Above the groups: "Some uploads may be missing." until a read path establishes the person's attachment list and how to open each.

### Touch and hold

On a Page row, touch and hold opens a menu: **Open**, **Share as file…** (section 7's choice, then the system's share sheet with the file), **Pin** or **Unpin**. There is no "Copy Link" and no "Open in Web": the hosted Page route needs a capability that also serves the gateway's Control UI, and there is no shareable Page link (research §3; section 11). Pin is section 4's action, scoped to this conversation's Library, read-only access included: read-only, it gives the access request in the sheet and changes nothing on the gateway before approval.

Other rows open on tap; touch and hold on them gives **Open** and **Pin** or **Unpin**. The item's own actions (Save, Share) are those of its view, reached through Open; they are not repeated in this menu for now. An upload's row has no Pin.

- **The press**: half a second without moving. A fulfilled press consumes its release and the click that follows, so the menu stays and nothing opens. Moving more than a few points, scrolling or a cancelled pointer abandons it.
- **Keyboard and assistive technology**: the same menu with Shift+F10 or the context-menu key on a focused row, and in VoiceOver's actions for the row. Up, Down, Home and End move in it; Escape closes it, focus back on the row.

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

- **Message about Trail guide** closes the sheet and uses the conversation's draft as the side chat does (section 6): an empty draft gets `About the page “Trail guide”: `, caret after it; a draft with text is kept, with "Replace your draft?" offering Keep draft and Replace draft. Read-only, the sheet offers "Request access to message" in its place, and the request is drawn inside the sheet.
- **Share as file…** reads the entrypoint only now, then section 7's choice and the share sheet. Closing the dialog returns focus to Share as file….
- **Close** returns to the chat at the same position it left, or to the Library at the same row.

This sheet is what the iPhone shows in a Page's place: the title, the bot and the time, the sentence that Clawtrate for iPhone can't show pages yet, and the two actions. Nothing of the Page is read, parsed or drawn for it, not even as text. F-373's target stays a Page full screen: that needs a rendering path on the iPhone that passes the zero-request check (section 6), and the row stays `todo` until it has one; then this sheet shows the Page itself, under the desktop frame's treatment.

## 9. Widths, themes, keyboard and screen readers

| Width          | The Library tab                                                                                                                               | The Page view                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1440           | In the docked pane, 360 px                                                                                                                    | Frame and the 360 px chat side by side                                                                                                |
| 1100           | In the drawer, 360 px                                                                                                                         | Side by side                                                                                                                          |
| 800            | In the drawer, the window less 56 px                                                                                                          | The frame takes the width; Chat opens the chat as a 360 px drawer over the frame's right, with its own Close; it starts hidden        |
| 390 (one pane) | The iPhone: the conversation's Library in the info sheet (section 8). A desktop window this narrow: the bot's Library in the full-width sheet | The iPhone: the sheet of section 8. A desktop window this narrow: the frame full width, and Chat opens the chat as a full-width sheet |

- **Themes**: everything uses the token set; the frame's ground stays white, as a Page's own styles expect, with a hairline in dark.
- **Keyboard**: the filters are one radio group; rows move with arrows; Pin is reached with Tab from its row. In the Page view, Tab goes through Close, Export…, Pin, Chat, the note's Links, the frame and the chat. Shift+Tab from the Page's first control leaves the frame. Menus move with Up, Down, Home and End and close with Escape. Each dialog keeps Tab and Shift+Tab inside the topmost one and returns focus to what opened it. ⌘E opens Export when the Export button would; ⌘↵ sends from the chat's field as the composer does.
- **Screen readers**: the Library tab panel is labelled "Library"; each group is a list labelled by its word; the freshness line is a status. The Page view is a `dialog` labelled by the title and described by the note. Pin is a toggle button with its state.
- **Motion**: only skeleton rows pulse, still under reduced motion. The Page view appears at once.

## 10. What the gateway's facts drive

Live on a development instance unless marked "source"; research sections in brackets.

| Shown                                                                | Driven by                                                                                                                                                                                                                                                                                                                                | Tier        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| The bot's tasks, newest first; "of 23"; the next batch               | `sessions.list {agentId}` with the rail's filters: `totalCount`, `hasMore`, `nextOffset` (§1)                                                                                                                                                                                                                                            | read        |
| Pictures, recordings, videos, files                                  | `artifacts.list {sessionKey, messageRole: "assistant"}` per task: The untyped call returns unpaged artifact summaries from the gateway's transcript projection. It can omit uploads. `type` `image`, `audio`, `video`, `file`; `{agentId}` alone refused (§1)                                                                            | read        |
| Each item's time; Today, This week, Older                            | The `timestamp` of the `chat.history` row with the entry's `messageSeq`; groups on the device, in its time zone (§1)                                                                                                                                                                                                                     | read        |
| Earlier history pages; "weren't read"                                | `chat.history {limit, offset}`, `hasMore`, `nextOffset` from the end; a row marked `__openclaw.truncated`, or the omission placeholder (§1; source)                                                                                                                                                                                      | read        |
| Pages; "Shown again below"                                           | `canvas` blocks in the bot's rows, `preview.viewId` and `title`; the same `viewId` in a later row (§2, §5)                                                                                                                                                                                                                               | read        |
| No Apps filter                                                       | MCP App views are `canvas` blocks with `mcpApp`, shown only with scripts (§9, source)                                                                                                                                                                                                                                                    |             |
| Links                                                                | `http` and `https` addresses in the bot's text (§1)                                                                                                                                                                                                                                                                                      | read        |
| The iPhone's pictures the person sent; "Some uploads may be missing" | `artifacts.list {sessionKey, type: "image", limit: 4}` and its cursor: five metadata entries, `source: "session-transcript-preview"`, `download.mode: "unsupported"`, an `image.url` and no inline PNG preview; the untyped list omitted the person's uploads, and `artifacts.get` and `artifacts.download` refused the entry tried (§1) | read        |
| The Page                                                             | `canvas.document.view {docId}`: `{html, sandboxUrl, sandboxPort}`, the HTML as written; `UNAVAILABLE` with one message on any failure (§2)                                                                                                                                                                                               | read        |
| Never used                                                           | `pluginSurfaceUrls.canvas`, `plugin.surface.refresh`, `sandboxUrl`, `sandboxPort`, `sandboxOrigin`, the block's `url`, `canvas.document.preview`, the handshake's `controlUiUrl`, plugin tab paths and `controlUiLinkReaders` (§2, §3)                                                                                                   |             |
| The frame and the note                                               | Research §4: for its fixtures, no script, form, popup, message or request; checkbox, menu and folded section change and are discarded on reopening; links replace the frame unless taken out. The zero-request guarantee is the builder's check per platform (section 6)                                                                 |             |
| The side chat                                                        | `chat.send` to the occurrence's task; refused on the read tier with `missing scope: operator.write` (§6)                                                                                                                                                                                                                                 | interactive |
| Export                                                               | The HTML from `canvas.document.view`, entrypoint only (§7)                                                                                                                                                                                                                                                                               | read        |
| Pins                                                                 | `users.prefs.get` (read), `users.prefs.set` with `expectedEntries`, `null` for an absent key (write), `conflict`, `value-too-large` at 4,096 bytes, 128 keys (source), `users.prefs.changed` with the profile and keys only, to every connection of the profile, the writer and read-only ones included (§8)                             | read, write |
| Pins on this device                                                  | `{status: "no_durable_identity"}` (§8, source)                                                                                                                                                                                                                                                                                           |             |

## 11. Parity rows reworded and decided

The seven rows as they read in `docs/parity.md`, statuses unchanged (`todo`). F-208, F-209, F-372 and F-373 carry the coordinator's decisions; a note under `same` only narrows the target. F-373's target is unchanged: the iPhone draws the unavailable state (section 8) until a rendering path there passes the zero-request check.

| Row   | Clawtrate target                                                                                                                                                                                                                                                                                                  | Gateway dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-208 | same; note: without the Apps filter: the gateway marks MCP App views, which need script execution that Clawtrate does not offer.                                                                                                                                                                                  | partial: `sessions.list {agentId}` gives the Bot's tasks; `artifacts.list {sessionKey, messageRole: "assistant"}` for each, not paged and with no time on its entries, and the time, Pages (`canvas` blocks) and links from `chat.history`, aggregated in the client (`operator.read`); pins in `users.prefs` on the person's profile (`users.prefs.get` `operator.read`, `users.prefs.set` `operator.write`, 4,096 bytes a key), kept on the device when the gateway answers `no_durable_identity`. History and artifact coverage are per task. Older or omitted history can hide Pages and links. No cross-task index or item count (`docs/research/library.md`). |
| F-209 | same; note: an earlier card of the same Page reads "Shown again below": the gateway keeps no revision of a Page, so nothing says it was updated.                                                                                                                                                                  | partial: `canvas.document.view {docId}` (`operator.read`) gives the Page's HTML; the side chat uses `chat.send` (`operator.write`). The hosted `pluginSurfaceUrls.canvas` is never used (`docs/decisions.md`, "Addresses a gateway hands the client"). Missing: on each platform, a rendering path with a check that sees zero requests; every way to a Page (a conversation card, a Library row, the Files hand-over) passes that check's gate, and until it passes a Page is unavailable there (same decision).                                                                                                                                                   |
| F-210 | better: share by exporting the Page as an HTML file, either as shown (scripts, link addresses and outside references taken out) or as the Bot made it, and the export screen says what each file is and that the original file can run scripts or load outside resources when opened; nothing is hosted publicly. | available: `canvas.document.view` (`operator.read`) gives the entrypoint only, files kept beside it omitted; the client writes the file, or hands it to the platform's share sheet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| F-371 | same                                                                                                                                                                                                                                                                                                              | partial: `artifacts.list {sessionKey}` can omit user uploads. The read-only image listing (`type: "image"`, up to four per cursor) returned five preview metadata entries, four plus one after the cursor, with unsupported download mode and no inline PNG preview in the tested reply. The tested preview image was refused by `artifacts.get` and `artifacts.download`. Links and Pages come from readable `chat.history` rows. Missing: a verified listing and open path for the user's uploads (`docs/research/library.md`).                                                                                                                                   |
| F-372 | same; note: without "Copy Link" and "Open in Web": the hosted Page route needs a capability that also serves the gateway's Control UI, and there is no shareable Page link; "Share" shares the Page as a file.                                                                                                    | partial: no shareable link to a Page exists: the hosted route `pluginSurfaceUrls.canvas` needs a capability that also serves the Control UI, and the document path and sandbox fields are locators Clawtrate ignores (`docs/decisions.md`, "Addresses a gateway hands the client"); `session.publicShare.set` shares a session, not a Page. Share uses the exported file (`canvas.document.view`, `operator.read`) (`docs/research/library.md`).                                                                                                                                                                                                                    |
| F-373 | better: Clawtrate design proposal: on iPhone a Page opens full screen with the latest saved version, and its close control returns to the chat at the same position (§9.5).                                                                                                                                       | partial: `canvas.document.view {docId}` (`operator.read`) gives the Page's HTML. Missing: a rendering path on the iPhone that passes the zero-request check; the iPhone app has no web view, so a Page is unavailable there (`docs/decisions.md`, "Addresses a gateway hands the client").                                                                                                                                                                                                                                                                                                                                                                          |
| F-374 | same; note: Clawtrate never runs a Page's scripts, so controls that need them do nothing; checkboxes, menus and folded sections change only this view; reopening reads the Page as it is then, and changes to controls in the previous view are discarded.                                                        | client only, once the platform's rendering path passes the zero-request check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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

- For a bot: its tasks (the rail's list, `totalCount`, the next offset), and per task tried, its items: each occurrence keyed by task, session ID and `messageSeq`, with the gateway's artifact ID where reported and a block index only where history confirms it, its kind, title, size, its time from history, and for a Page its `viewId` and whether a later row of the same transcript shows it again. Per task, the state of each source (completed, partial, failed) and the last confirmed rows; the time of the read.
- History pages read per task, at most 1,000 rows, whether or not the task has artifacts, stopping on `hasMore: false`, the budget or an offset that doesn't advance.
- Per bot, the pins as last confirmed and the value last observed (`null` when absent) for the next `expectedEntries`; the read after every write and on reconnect, never a resend; the re-read on `users.prefs.changed`; the fallback to device storage, keyed by the gateway's identity, only on `no_durable_identity`.
- For a Page: the gate's state for this platform; once it is open, the HTML read once per opening and its framed form (section 6), the count of scripts and the canonical link addresses taken out. Until then nothing, and for Export the entrypoint read only when chosen. None of the addresses the gateway puts beside the HTML.
- The side chat is the task's ordinary transcript subscription and outbox.

### What the gateway must supply

Nothing new. A Page revision, a cross-task index or a count would let the Library say more; none is needed for what it says.

### Order to build

1. The zero-request check for each platform's rendering path (section 6), and the gate in front of every way to a Page. The artifacts work's page route and card (#144, `viewer.tsx` and `cards.tsx`) move behind this gate, with "Shown again below", before either renderer is enabled.
2. The Library tab over the bot's tasks: tasks in batches, items, history for Pages and links, source states, times, groups, Show more, the freshness line and its notes, "Look in more tasks". Check F-208's listing.
3. The filters. Check F-208's filters as decided.
4. Pins with compare-and-set, the read after every write, resolution against session and message, conflict, limits, the change event; device pins on `no_durable_identity`. Check F-208's Pin.
5. The Page view behind the gate: the frame, the note, Links, the unavailable state. Check F-209 and F-374.
6. The side chat on the task's draft and outbox, with the access request inside the view. Check F-209's side chat.
7. Export and Share. Check F-210.
8. The iPhone's Library (the image listing for uploads), menu and Page sheet. Check F-371 and F-372; F-373 waits for an iPhone rendering path that passes the zero-request check, and until then the sheet of section 8 is drawn.

Files' "Sent in chat" view, which opening a file or a recording uses, comes from the artifacts work (#144), not yet on `main`.

### Prototype states

`prototype/library.html` takes every parameter `work.html` takes, and these. The fixtures are Marlow's tasks, today being Thursday, November 19 (`bot=marlow&task=m2`: Saturday's trail plan, with the Page shown twice). The gateway's answers are fixtures, counted, so the check sees what was read, parsed and drawn. The prototype bar's "Another device pins", "Owner approves access" and "Owner denies access" stand for what another device and the gateway's owner do.

| Parameter                | Values                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel=open&tab=library` | Marlow's Library in the Work pane                                                                                                                                                                 |
| `filter`                 | `all`, `pages`, `media`, `links`, `files`, `pinned`                                                                                                                                               |
| `lib`                    | `loading`, `partial` (one task's sources both failed, another's items failed), `error`, `offline`, `all` (every task tried)                                                                       |
| `items=none`             | No items found: the empty states                                                                                                                                                                  |
| `src=complete`           | No history read stopped at the limit or met an incomplete row                                                                                                                                     |
| `gate=closed`            | A desktop or web preview before its zero-request check passes (the iPhone is always closed)                                                                                                       |
| `pins`                   | `device` (the gateway keeps no preferences), `full`, `none`, `verify` (pins that couldn't be verified)                                                                                            |
| `pinfail`                | `conflict` (resolved by one read and retry), `conflict2`, `noanswer-before`, `noanswer-after` (the write reached the gateway), `limit`                                                            |
| `page`                   | `trail-guide`, `trail-guide-1` (the earlier occurrence), `packing-list` (no scripts, one link): the Page view                                                                                     |
| `pageload`               | `failed`, `large`                                                                                                                                                                                 |
| `chat`                   | `hidden`                                                                                                                                                                                          |
| `export`                 | `open` (with `page`); `exportread=failed`: the read for export fails; `exportfail=1`: the system refuses the file; `sharefail=1`: the share sheet can't be shown                                  |
| `width=phone`            | The iPhone's forms: with `panel=open&tab=library`, the conversation's Library in its info sheet; a Page opens the sheet of section 8. `device=desktop` shows a desktop window that narrow instead |
| `hold`                   | An item id: its touch-and-hold menu (phone)                                                                                                                                                       |
| `state=readonly`         | The read-only connection                                                                                                                                                                          |

## 13. Not covered here

- The Details tab, Files, Computer and Settings, and the artifact cards and media viewer themselves (`work-pane.md`, `bots.md`).
- Search across the Library: the gateway has none, and the design does not add one.
- MCP Apps, and any way to run a Page's scripts.
- Sharing a Page by a link or hosting it anywhere.
- The artifacts work's own page route and card (#144): they move behind section 6's gate and use "Shown again below" in that work, not here.
- A listing and open path for the person's own uploads on iPhone, which the gateway does not establish yet (section 8).
- An iPhone rendering path for Pages: F-373 stays `todo` until one passes the zero-request check (section 8).
- Pins of tasks or bots (the rail's pins, `visual-language.md` §7), which are a different thing.
