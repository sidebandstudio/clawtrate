# Clawtrate visual language

This document replaces the look of the first app shell. It keeps the shell's structure, file names and naming style, and changes everything visual. The prototype in `docs/design/prototype/` shows it assembled: `connect.html`, `pairing.html` and `app.html`. The prototype's `css/tokens.css` and `css/app.css` are written as drop-in replacements for the two files in `packages/ui/src/styles/`.

The conversation components (the working view, step cards, Messaged cards, approval and question cards, the composer during a run) are the second part of this design. They are specified in `docs/design/conversation.md`, in this same language.

## Contents

1. Principles
2. Tokens
3. Type
4. Spacing, shape and surfaces
5. Avatars
6. Layout and widths
7. The rail: bots and their tasks
8. The conversation
9. The Work pane
10. Connection and pairing screens
11. The connection strip
12. Compact and phone layouts
13. Accessibility
14. Change list for the builder

## 1. Principles

Each of these is a rule a reviewer can check.

1. **Two surfaces and one raised fill.** The rail and the stage are the two surfaces. Bubbles, cards and fields use one raised fill. There is no third background.
2. **Fill separates, lines do not.** The window has one hairline, beside a docked Work pane. Tables inside a reply have row rules. Nothing else has a border.
3. **No header bars.** Controls float: round buttons and one title pill. No pane has a title strip.
4. **Neutral chrome.** Greys carry no tint. There are no gradients or glows.
5. **Colour belongs to the bots and to you.** The avatars are the colour in the app. The accent appears on your own bubbles, on unread, on a bot that is working, on focus and on links. Selection and primary buttons are neutral.
6. **One typeface, two weights.** Regular and medium. Semibold only for headings inside a reply and for the product name. A mono face only for code.
7. **Nothing below 12 px, and every text colour reaches 4.5:1** on every surface it can sit on.
8. **Messages are bubbles.** No name, avatar or time beside a message. Time is a centred stamp between blocks.
9. **The bot's work is quiet until asked for.** Thoughts and tool calls fold into one line.
10. **One list.** Tasks live under their bot in the rail. There is no separate task column.

## 2. Tokens

The token names the shell uses are kept, so its rules pick up the new values. `prototype/css/tokens.css` is the file to copy. In the app, keep the shell's selectors (`:root`, the `prefers-color-scheme` block and `:root[data-theme]`); the prototype scopes themes to any element with `data-theme` only so that its gallery can show both at once.

### Colour, changed values

| Token | Old light | New light | Old dark | New dark |
|---|---|---|---|---|
| `--bg` | `#f4f5f2` | `#ffffff` | `#0b0e14` | `#101112` |
| `--bg-rail` | `#eceee9` | `#f6f6f5` | `#080a0f` | `#0b0c0d` |
| `--bg-list` | `#f8f9f6` | alias of `--bg-rail` | `#0d1118` | alias of `--bg-rail` |
| `--bg-pane` | `#ffffff` | `#ffffff` | `#10141c` | `#101112` |
| `--bg-raised` | `#ffffff` | `#ffffff` | `#151a23` | `#1c1d1f` |
| `--bg-hover` | `rgba(20,28,34,.045)` | `rgba(17,18,19,.05)` | `rgba(214,240,232,.05)` | `rgba(255,255,255,.06)` |
| `--bg-selected` | `#e6f5f0` | `rgba(17,18,19,.08)` | `rgba(62,230,193,.1)` | `rgba(255,255,255,.1)` |
| `--bg-inset` | `#f3f5f2` | `#f0f0ee` | `#0c1017` | `#1a1b1d` |
| `--bg-code` | `#f2f4f1` | `rgba(17,18,19,.06)` | `#0a0d13` | `rgba(255,255,255,.08)` |
| `--border` | `#dfe3dc` | `rgba(17,18,19,.09)` | `#1d232d` | `rgba(255,255,255,.08)` |
| `--border-strong` | `#cfd5cc` | `rgba(17,18,19,.16)` | `#2a313d` | `rgba(255,255,255,.16)` |
| `--text` | `#151a1f` | `#111213` | `#e6ebe9` | `#f3f3f2` |
| `--text-muted` | `#5b646b` | `#55575b` | `#9aa5a8` | `#b4b6b9` |
| `--text-faint` | `#848c91` | `#606266` | `#6b767b` | `#9d9fa2` |
| `--accent-soft` | `#e6f5f0` | `rgba(10,110,92,.1)` | `rgba(62,230,193,.12)` | unchanged |
| `--warn` | `#9a5b00` | `#935600` | `#f0b45a` | unchanged |
| `--warn-soft` | `#fbf1dc` | `rgba(147,86,0,.1)` | `rgba(240,180,90,.12)` | unchanged |
| `--danger-soft` | `#fbe9e7` | `rgba(179,38,30,.09)` | `rgba(255,138,128,.12)` | unchanged |
| `--shadow-raised` | two soft shadows | `0 0 0 1px rgba(17,18,19,.06), 0 2px 8px rgba(17,18,19,.08)` | inset line and a deep shadow | `inset 0 0 0 1px rgba(255,255,255,.07), 0 4px 14px rgba(0,0,0,.4)` |
| `--stage-glow` | radial gradient | `none` (retired) | radial gradient | `none` (retired) |

Unchanged: `--accent` (`#0a6e5c` / `#3ee6c1`), `--accent-strong`, `--accent-line` (`#0d8f77` / `#3ee6c1`), `--accent-on`, `--danger`. The accent still derives from the logo.

`--bg-selected` moving from a mint fill to a neutral one is the single change that most alters the feel: selection no longer spends the accent.

### Colour, new tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg-bubble` | `#f0f0ee` | `#1f2022` | The bot's bubbles, cards, grey buttons, fact blocks |
| `--bg-inverse` | `#111213` | `#f3f3f2` | Primary buttons, the send button |
| `--text-inverse` | `#ffffff` | `#111213` | Text on `--bg-inverse` |
| `--bubble-user` | `#0a6e5c` | `#3ee6c1` | Your bubbles |
| `--bubble-user-text` | `#ffffff` | `#04261f` | Text in your bubbles (6.2:1 and 10.2:1) |
| `--bg-scrim` | `rgba(17,18,19,.22)` | `rgba(0,0,0,.5)` | Behind the Work pane drawer and phone sheets |
| `--warn-line` | `rgba(147,86,0,.32)` | `rgba(240,180,90,.42)` | Outline of something that needs you |
| `--danger-line` | `rgba(179,38,30,.3)` | `rgba(255,138,128,.42)` | Outline of a failure |
| `--shadow-button` | `0 0 0 1px rgba(17,18,19,.06), 0 1px 2px rgba(17,18,19,.06)` | `inset 0 0 0 1px rgba(255,255,255,.06)` | Round buttons |
| `--shadow-pop` | `0 0 0 1px rgba(17,18,19,.06), 0 12px 36px rgba(17,18,19,.16)` | `inset 0 0 0 1px rgba(255,255,255,.07), 0 16px 44px rgba(0,0,0,.6)` | Menus, the strip, the drawer |

`--bubble-user` is its own token so that a later Appearance setting can switch your bubbles to neutral without touching the accent.

### Type, size and layout tokens

| Token | Old | New |
|---|---|---|
| `--font-ui` | Instrument Sans | `"Figtree Variable", "Figtree", ui-sans-serif, system-ui, sans-serif` |
| `--font-display` | Instrument Serif | alias of `--font-ui` (retired) |
| `--font-mono` | JetBrains Mono | unchanged |
| `--text-xs` | 11px | 12px |
| `--text-sm` | 12px | 13px |
| `--text-md` | 13px | 14px |
| `--text-base` | 14px | 15px |
| `--text-lg` | 16px | 17px |
| `--text-title` | 24px | 28px |
| `--radius-sm` | 5px | 10px |
| `--radius-md` | 8px | 14px |
| `--radius-lg` | 12px | 18px |
| `--rail-width` | 228px | 280px |
| `--list-width` | 312px | 0 (retired) |
| `--panel-width` | 320px | 360px |
| `--header-height` | 52px | 56px, now the band the floating controls sit in |

New: `--weight-regular` 400, `--weight-medium` 500, `--weight-strong` 600; `--space-10` 40px; `--radius-pill` 999px; `--transcript-max` 760px; `--conversation-min` 440px; `--tap-min` 44px; `--avatar-row` 40px, `--avatar-pin` 56px, `--avatar-hero` 88px, `--avatar-pill` 22px. The motion tokens (`--dur-quick` 120ms, `--dur-base` 200ms, `--dur-settle` 420ms, `--ease-in-out`, and the `--loop-*` periods) are used by the conversation components and are defined here so there is one token file.

## 3. Type

One family, Figtree, an open-licensed variable sans (SIL OFL) available as `@fontsource-variable/figtree`. It is round and open at small sizes, which suits bubbles and round controls, and its figures are clear in times and sizes. JetBrains Mono stays for code. Instrument Sans and Instrument Serif are removed.

| Role | Size | Weight | Line height | Colour |
|---|---|---|---|---|
| Message text, inputs | 15 | 400 | 1.5 | `--text` |
| Bot name in the rail | 15 | 500 | 20px | `--text` |
| Preview line, task row, buttons, panel rows, title pill | 14 | 400 (500 for buttons, the pill's name, the current task) | 20px | `--text-muted` or `--text` |
| Event lines, section words, hints | 13 | 400 | 1.4 | `--text-faint` |
| Stamps, times | 12 | 400 | 1.3 | `--text-faint` |
| Heading inside a reply | 15 | 600 | 1.5 | `--text` |
| Work pane name | 20 | 500 | 1.25 | `--text` |
| Screen title (pairing) | 22 | 600 | 1.25 | `--text` |
| Product name (connect) | 28 | 600, tracking −0.01em | 1.15 | `--text` |
| Code | 0.88em inline, 13 in blocks | 400 | 1.5 | `--text` |

Rules: no uppercase labels, no added letter-spacing except on the two titles, no italics for interface text, tabular figures for times. On touch, message text and inputs are 17 px and names are 17 px.

## 4. Spacing, shape and surfaces

**Spacing.** The shell's 4 px scale stays. The rhythm that matters:

- 12 px from the window edge to a floating control; 8 px from the rail's edge to a row; 20 px from the stage's edge to the transcript column.
- 12 px between an avatar and its text.
- 9 × 14 px inside a bubble.
- 4 px between bubbles from one sender; 16 px when the sender changes; a stamp takes 22 px above and 10 px below.

**Radii.** Three: 10 px for insets and task rows, 18 px for bubbles, cards and the open bot group, fully round for buttons, pills, fields and the composer (the composer uses 24 px so it stays a pill when it grows to several lines). Menus and small cards use 14 px.

**Surfaces.**

| Surface | Token | Where |
|---|---|---|
| Stage | `--bg` / `--bg-pane` | Conversation, Work pane, connection screens |
| Rail | `--bg-rail` | The sidebar. In light it is a step greyer than the stage; in dark a step darker. No border between them. |
| Raised fill | `--bg-bubble` | Bubbles, cards, fact blocks, grey buttons, the read-only composer |
| Floating | `--bg-raised` with `--shadow-button`, `--shadow-raised` or `--shadow-pop` | Round buttons, the title pill, the composer, menus, the strip, the drawer |

**Borders.** `--border` is used for the Work pane's left edge when docked, for table row rules, and for the rules inside a fact block. `--border-strong` outlines the composer. Nothing else is outlined. Avatars have no ring.

**Buttons.**

| Kind | Look | Use |
|---|---|---|
| Round icon button, 32 px | `--bg-raised` and `--shadow-button`; `data-variant="quiet"` is transparent until hovered; pressed is `--bg-selected` | Every icon control |
| Primary | `--bg-inverse` on `--text-inverse`, pill | One per screen at most |
| Default | `--bg-bubble`, pill | Secondary actions |
| Quiet | Transparent, `--text-muted` | Tertiary actions |

Sizes: 40 px default, 48 px (`data-size="lg"`, full width) on the connection screens, 30 px (`data-size="sm"`) inside cards and strips. Icons are 16 px with a 1.6 px round stroke, drawn for Clawtrate.

## 5. Avatars

Avatars are characters, and they carry the colour in the app. A character is three choices:

- a **body**: one of eight flat shapes (pebble, block, arch, bloom, disc, hex, drop, gem);
- a **colour**: one flat fill;
- a **face**: a dark visor with two round eyes. The visor's tilt and the direction the eyes look give each bot its own expression.

The construction is in `prototype/js/icons.js`: a 40-unit grid, the body filling it, a visor 22.4 × 9.6 units with fully round ends in `#16181b`, and eyes of radius 2.05 in white. The visor and eyes are the same in light and dark, since they sit on the body's colour.

| Use | Size | Token |
|---|---|---|
| Rail row | 40 px (44 on touch) | `--avatar-row` |
| Pinned tile | 56 px | `--avatar-pin` |
| Work pane | 88 px | `--avatar-hero` |
| Title pill | 22 px | `--avatar-pill` |
| Empty conversation | 64 px | |

Rules:

- No frame, ring, shadow or emoji badge.
- A bot whose gateway identity carries an image shows that image cropped to a circle at the same sizes.
- A bot with no image gets a body and colour chosen from a stable hash of its id, so it looks the same on every device until the user picks one. The picker (eight bodies, a row of colours) is a later flow; this document fixes only how a character is drawn.
- Avatars do not appear beside messages. In a one-to-one conversation the bot is identified by the title pill.

Prototype palette, for the builder who adds the picker: `#58c26f`, `#5b8dff`, `#ff8552`, `#a98bff`, `#f6bd3b`, `#ff6f9c`, `#45bdf5`, `#a5d955`. The visor reads against every one of them at 5.6:1 or better.

## 6. Layout and widths

The window is two panes, with a third on request.

| Pane | Width | Notes |
|---|---|---|
| Rail | 280 px (248 px below 900) | Bots, with tasks under the open bot |
| Conversation | the rest, never less than 440 px | Transcript column capped at 760 px and centred |
| Work pane | 360 px | Docked when there is room for it and 440 px of conversation; otherwise a drawer |

The element that holds the shell (`.app`, the app's `#root`) is a size container, and the layout responds to its width, so the same rules serve a narrow window, a split view and the phone.

| Container width | Rail | Work pane | Conversation at that width |
|---|---|---|---|
| 1080 and up | 280 | docked, 360 | 440 at 1080, 800 at 1440 |
| 900–1079 | 280 | drawer over the right edge | 620–799 |
| 688–899 | 248 | drawer | 440–651; at 800 it is 552 |
| below 688 | one pane at a time | full-width sheet | full width |

688 is where a 248 px rail leaves exactly 440 px for the conversation.

## 7. The rail: bots and their tasks

### Structure

```
rail-top        search and new, top right; the left part drags the window
bot-list
  pin-grid      pinned bots as large tiles, three per row (when any are pinned)
  rail-section  a small grey word, for the user's own sections
  bot-group     a bot, and its tasks when it is open
    bot
    task-list
rail-footer     the gateway: a status dot, its name, its state; settings
```

There is no product name in the rail and no heading above the bots.

### Bot row

- 60 px tall (68 on touch), padded 10 px, radius 18.
- Avatar 40 px, 12 px gap, then two lines. Line one: the name (15/500) and, right-aligned, the time of the bot's latest activity (12, faint). Line two: one line of preview (14, muted), with the unread dot at its right end when there is unread activity.
- The preview is the latest message in the bot's most recent task, as plain text. When the latest item is not text it is described in words ("Asked a question", "Sent a file").
- Time format: today as `5:36 PM`, yesterday as `Yesterday`, within a week as `Mon`, older as `Nov 9`.
- Hover: `--bg-hover`. Selected: `--bg-selected`. Both are neutral.
- Unread: an 8 px dot in `--accent-line`. This is the only accent in the rail at rest.

### Tasks under a bot

Grok Bot gives a bot one conversation; a Clawtrate bot has many tasks. The arrangement keeps the single list and puts tasks inside it:

- **A bot with one task looks and behaves like a plain row.** Clicking it opens the task. No task rows are shown. A new bot starts this way, so the simple case stays simple.
- **A bot with several tasks unfolds when opened.** Clicking the bot opens its most recent task and shows its tasks under it. The bot and its tasks sit in one soft block (`--bg-hover`, radius 18), and the current task carries the selection (`--bg-selected`, radius 10, medium weight). The bot row inside the block has no fill of its own.
- **Only the open bot is unfolded** by default. Another bot can be unfolded without switching to it: the disclosure on hover, or Right Arrow when the row has focus. Left Arrow folds it.
- **A task row is one line**, 34 px (44 on touch), indented to align with the bot's name: the title (14, muted; `--text` when current or unread) and at most one mark at the right. In this document the mark is the unread dot; the conversation specification adds the run states. The time of last activity is the row's tooltip, not text, so titles keep the width.
- Tasks are ordered by latest activity. Six are shown; a seventh row reads "Show all 14". Archived tasks are not listed here.
- The last row is **New task** (a plus and the words, faint). It creates a task, selects it and focuses the composer. Shortcut: ⌘T.
- A folded bot row speaks for all its tasks: its preview, time and unread dot come from the most recent one, and its state is the most urgent of theirs.
- **Pinned bots** are tiles and have no room for rows. When a pinned bot with several tasks is open, its tasks show as a block directly under the pin grid, headed by nothing, in the same form.

Semantics: the bot is a `button` with `aria-expanded` when it has several tasks; the task list is a `ul` labelled "<Bot>'s tasks"; the current task has `aria-current="true"`.

### Pinned bots and sections

- Pinned bots: a three-column grid of tiles at the top. A tile is a 56 px avatar with the name under it (13, centred, one line), radius 18, `--bg-selected` when open.
- Sections: a small grey word (13, faint, in the user's own casing) with 14 px above and 6 px below. No rule, no caps.

### Footer

One row: a status dot, the gateway's name (14/500) with its state under it (12, faint), and a quiet round Settings button. The dot is `--accent-line` when connected, `--warn` and pulsing while connecting or reconnecting, `--danger` when the connection failed. Clicking the row opens gateway settings. The theme switch and Disconnect move into Settings; until Settings exists they go in a menu on this row.

## 8. The conversation

### Header

No bar. Three things float over the top of the transcript in a 56 px band:

- **Title pill**, centred: 36 px tall, `--bg-raised` with `--shadow-raised`. A 22 px avatar, the bot's name (14/500), then the task's title (14, muted, truncated). It opens the Work pane. Accessible name: "<Bot>, <task>. Show details."
- **Work pane button**, top right: a round icon button, pressed while the pane is open. ⌘\ toggles it.
- **Back**, top left: shown only in the one-pane layout.

The transcript scrolls under these and fades out towards the top (a mask from 22 px to 66 px), so text never collides with the pill at full strength.

### Messages

- **Your messages** are right-aligned bubbles in `--bubble-user`, at most 78% of the column or 560 px.
- **The bot's messages** are left-aligned bubbles in `--bg-bubble`, at most 86% of the column or 640 px. Markdown renders inside: headings at 15/600, lists, tables with row rules and plain medium-weight headers, inline code on `--bg-code`, code blocks on `--bg-pane` with radius 10.
- Bubbles have one radius, 18 px, on every corner. There are no tails.
- 4 px between bubbles from one sender, 16 px when the sender changes.
- **No name, avatar or time beside a message.** A message's exact time is its tooltip, and is in its long-press menu on touch.
- **Stamps**: a centred line (12, faint) before the first message and wherever more than ten minutes pass between messages or the day changes: `Today 5:36 PM`, `Yesterday 9:02 AM`, `Mon, Nov 9 2:14 PM`.
- **Event lines**: something the bot did that is not a message is one quiet line (13, faint), aligned with the text inside the bubbles.

### The bot's work, for now

Until the conversation components are built, a turn's thoughts and tool calls fold into one event line, "Used 2 tools", which opens to plain rows: the tool name on `--bg-code` and a one-line summary. This replaces the shell's always-open "Thought" and tool rows. `conversation.md` replaces it with the activity block.

### Composer

One pill at the foot of the column, aligned with the bubbles' outer edges: 48 px, radius 24, `--bg-raised` with a `--border-strong` outline; the outline becomes `--accent-line` with a soft halo on focus. Inside: a round "+" on the left (attach), the text, and a round send button on the right. The send button is `--bg-inverse` when there is text and grey when there is none. Placeholder: "Message <Bot>".

A connection that may only read keeps the pill, filled with `--bg-bubble` and no controls: an eye icon and "This device can read but not send. Ask the gateway owner for write access."

### Empty and loading

- **No task selected**: the bot's avatar at 64 px, "Pick a task", and "Choose one of <Bot>'s tasks, or start a new one."
- **A task with no messages**: the avatar, "Nothing here yet", and "Say what you need, and <Bot> will take it from there."
- **Could not load**: "Could not load this conversation", the reason, and a default button "Try again". Whatever was last loaded stays on screen.
- **Loading**: three grey bubbles in the shape of an exchange, pulsing gently; still when motion is reduced.

## 9. The Work pane

The pane is about a third of a wide window. Its frame:

- A 56 px band with one round Close button, top right.
- **Who**: the avatar at 88 px, the bot's name (20/500), and its label (14, faint), centred.
- **Tabs**: plain words in a centred row: Details, Files, Computer. The chosen tab has a `--bg-selected` pill; the others are muted text. No underline, no box.
- **Content**, scrolling, 20 px from the edges. Groups are headed by a small grey word (13, faint). Facts are label and value rows, 44 px each, inside one `--bg-bubble` block with radius 18 and hairlines between rows.

Empty states are words, not boxes: a 44 px round mark with an icon, a title (15/500), and one sentence saying what will appear.

| Tab | Empty title | Sentence |
|---|---|---|
| Files | No files yet | Files <Bot> reads or writes in this task appear here. |
| Computer | No screen to show | When <Bot> uses a browser or a desktop, you can watch it here. |
| Details, routines | (no title) | None yet. Ask <Bot> to do something on a schedule. |

The Details tab in the prototype shows the task, the model, where the bot runs and the last activity. Those rows are examples of the frame; later flows decide the final set.

Docked, the pane has the window's one hairline on its left edge. When there is not room, it is a drawer: over the right edge, 360 px or the width less 56 px, radius 18 on its left corners, `--shadow-pop`, with `--bg-scrim` over the rest. A click on the scrim or Escape closes it. In the one-pane layout it is a full-width sheet. Opening or closing the pane never changes the conversation's scroll position or state.

## 10. Connection and pairing screens

One centred column, 360 px wide, on the bare stage. No card, no border, no shadow, no gradient.

**Connect** (`connect.html`):

- The mark (56 px, radius 16), the name (28/600), the slogan (15, muted).
- Two pill fields, 48 px, `--bg-inset`, placeholders as labels: "Gateway address" and "Token, for the first pairing only". Each has a visually hidden label.
- A primary button, full width: "Connect" ("Connecting…" while busy, disabled). Under it a quiet button: "Use the development gateway", shown only when that gateway is present.
- One hint (13, faint): "Clawtrate works with an OpenClaw gateway you already run. It asks for read access only, and the token is used once."
- A failure appears between the fields and the buttons on `--danger-soft`: a medium-weight title ("Could not connect") and one sentence with the reason and what to check.

**Pairing** (`pairing.html`):

- The mark, then "Approve this device" (22/600) and one sentence: "<Gateway> has not seen this device before. Approve it once on the gateway's machine and Clawtrate connects by itself."
- The command to run, in one `--bg-inset` block with a copy button. One command, not a list of steps.
- "Waiting for approval" with a pulsing `--warn` dot, in a live region.
- What the device asks for, in plain words, as a chip: "Read bots, tasks and conversations". One chip per scope requested.
- A default button "Check now" and a quiet button "Use another gateway".
- A footer line (12, faint) with the request id and the device id, for support.

**The ensemble.** Along the foot of both screens stands a row of characters, cropped by the bottom edge, at different sizes and tilts. They are decoration: `aria-hidden`, not interactive, and they do not move.

## 11. The connection strip

The shell stays mounted with its cached content when the connection drops. One compact pill reports it. It overlays the top of the conversation, directly under the title pill, so nothing shifts when it appears or leaves. In the shell's markup it stays `.banner`; it is placed in the conversation's grid cell rather than in a row of its own.

| State | Dot | Words | Action |
|---|---|---|---|
| Reconnecting | `--warn`, pulsing | Reconnecting · showing saved messages | Retry now |
| Cannot reach the gateway | `--danger` | Can't reach <gateway> · showing saved messages | Retry now |
| Connected, fetching what was missed | `--warn`, pulsing | Connected · catching up | none |
| Caught up | `--accent-line` | Synced · 3 new in this task (or "Synced" alone) | none; leaves after 4 seconds |
| Fetch failed | `--danger` | Couldn't sync this task | Try again |

Rules: the strip has `role="status"`. The second part of each line is muted and truncates first on a narrow column. Nothing in the conversation unmounts on reconnect, and anything the user had expanded stays expanded. The rail's footer shows the same state on its dot and in its second line. When synced items land below the fold, the reader's position holds and the "Jump to latest" control (in `conversation.md`) offers them.

## 12. Compact and phone layouts

**Drawer widths (688–1079).** Described in section 9. The rail narrows to 248 px below 900.

**One pane (below 688, and the phone).** The rail is the list and the conversation is the detail.

- The list fills the width. The footer row is replaced by a round button at the top left: the Settings icon with the connection dot on it. Search and New stay top right.
- Rows are 68 px with 44 px avatars; task rows are 44 px; text is one step larger (17 px names and messages).
- **Tapping a bot with one task opens it.** **Tapping a bot with several tasks unfolds them in place**, and tapping a task opens it. Tapping the unfolded bot again folds it. This is the same list as on the desktop; only the open step differs, because the detail is a separate screen.
- In the conversation, Back is a round button at the top left and the Work pane button stays at the top right. The title pill sits between them and truncates the task title first.
- The Work pane is a full-width sheet with the same frame.
- The composer keeps its form; its buttons are 40 px.
- The connection screens keep their column; the ensemble is scaled to 60%.

The iOS app is built in React Native and does not use this CSS. The sizes, tokens and behaviour above are the specification for it; `[data-input="touch"]` in the prototype shows them.

## 13. Accessibility

**Contrast**, measured against every surface each colour is used on, including hovered and selected rows and soft fills:

| Text | Light, lowest | Dark, lowest |
|---|---|---|
| `--text` | 14.3:1 | 11.2:1 |
| `--text-muted` | 5.5:1 | 6.1:1 |
| `--text-faint` | 4.7:1 | 4.7:1 |
| `--accent` as text | 4.7:1 | 7.9:1 |
| `--warn` as text | 4.5:1 | 6.7:1 |
| `--danger` as text | 5.0:1 | 5.5:1 |
| Text in your bubbles | 6.2:1 | 10.2:1 |

`--accent-line` is for marks only (3.1:1 at worst in light); it is never text. In light theme `--text-faint` and `--text-muted` are close in value by necessity, so hierarchy between them comes from size and position.

**Focus.** Every control shows a 2 px `--accent-line` outline, 2 px out, on keyboard focus. Fields show the same as a ring.

**Keyboard.** Tab order follows the reading order: rail top, bots and tasks, footer, conversation header, transcript, composer, Work pane. In the rail, Up and Down move between rows, Right unfolds a bot, Left folds it, Enter opens. ⌘\ toggles the Work pane, Escape closes a drawer or sheet, ⌘K opens search, ⌘N a new bot, ⌘T a new task, ⌘I focuses the composer.

**Names.** Round buttons have `aria-label`s that say what they do. A bot row's name includes its count of tasks and "unread" when it applies. The transcript is a focusable region so it can be scrolled from the keyboard.

**Motion.** This part of the design moves very little: a pulsing status dot and the loading bubbles. Both stop under reduced motion, where the dot's colour and the words beside it carry the state.

**Targets.** 32 px round buttons with at least 8 px between them on desktop; 40 px and larger on touch, with rows at 44 px or more.

## 14. Change list for the builder

In order. Each step leaves the app working.

1. **Fonts.** In `packages/ui/package.json` add `@fontsource-variable/figtree` and remove `@fontsource-variable/instrument-sans` and `@fontsource/instrument-serif`. In `packages/ui/src/index.ts` import Figtree in their place. Keep JetBrains Mono.
2. **Tokens.** Replace `packages/ui/src/styles/tokens.css` with `docs/design/prototype/css/tokens.css`, keeping the shell's three theme selectors. Both dark blocks get the same values, as now.
3. **Styles.** Replace `packages/ui/src/styles/app.css` with `docs/design/prototype/css/app.css`. Classes that no longer exist: `.brand`, `.brand-name`, `.bot-theme`, `.bot-count`, `.avatar-emoji`, `.list-pane`, `.pane-header`, `.pane-title`, `.task-top`, `.task-preview`, `.task-status`, `.run-node`, `.conversation-title`, `.turn*`, `.user-mark`, `.system-row`, `.step-chevron`, `.step-kind`, `.step-reasoning-preview`, `.step-state`, `.step-body`, `.live-text`, `.read-only-bar`, `.work-placeholder`, `.divider`, `.pair-steps`, `.pair-step`, `.pair-marker`, `.field-label`, `.request-id`.
4. **Root.** Give the element that holds the shell the class `app` (`App.tsx`), and set `data-input="touch"` on the root when the primary pointer is coarse.
5. **Icons** (`icons.tsx`). Stroke width 1.6. Add: search, plus, settings, back, x, arrow-up, file, screen, lock. The paths are in `prototype/js/icons.js`.
6. **Avatar** (`Avatar.tsx`). Draw a character from a body, a colour, a tilt and a look, as in `prototype/js/icons.js`. With no stored choice, derive them from a stable hash of the bot's id. Show `avatarUrl` cropped to a circle when the bot has one. Remove the emoji badge and the `badge` prop. Stop generating pattern images for the seed bots in `tools/dev-gateway` so they show characters.
7. **Rail** (`Shell.tsx`, `Rail`). Remove the brand row. Add `.rail-top` with Search and New. Render each bot as a `.bot-group`: the `.bot` row (avatar, name and time, preview and unread dot), and under the open bot with several tasks its `.task-list`, ending in New task. Mark the open group `data-open="true"`; mark a single-task bot `aria-current`. Replace the footer with the gateway row and a Settings button; move the theme switch and Disconnect into a menu on that row.
8. **Task list** (`Shell.tsx`, `TaskList`). Delete the pane. Its rows move into the rail as one-line `.task` buttons. Keep `data-testid="task-list"` and `data-testid="task"` on the new elements so the e2e tests find them. Selecting a bot now also selects its most recent task.
9. **Grid** (`Shell.tsx`, `.shell`). Two columns and the Work pane: `data-panel` stays. `Banner` stays a child of `.shell`; the new rules place it over the conversation. Add `data-view="list|detail"` for the one-pane layout, set to `detail` when a task is opened and to `list` by Back.
10. **Conversation** (`Conversation.tsx`). Replace the header bar with `.conversation-header` holding Back, the `.title-pill` and the Work pane button. Render each transcript item as `.msg[data-role]` holding a `.bubble` (with `.md` for the bot); keep `data-testid="transcript-turn"` on `.msg`. Insert `.stamp` rows by the ten-minute rule. Fold a turn's reasoning and tool blocks into one `details.steps` with an `.event-line` summary; keep `data-testid="tool-call"` on each `.step`. Replace the read-only bar with the composer pill in its read-only form. Rewrite the empty, error and loading states as in section 8. Follow new output only when the reader is within 80 px of the bottom.
11. **Work pane** (`Shell.tsx`, `WorkPanel`). Replace the header and the three placeholder sections with the Close band, `.work-hero`, `.tabs` and the tab content with its empty states. Close on Escape and on a click on the scrim when it is a drawer.
12. **Connection screens** (`ConnectScreen.tsx`). Remove the card and the numbered steps. Build the centred column and the ensemble as in section 10. Keep every existing state and message; only their arrangement changes.
13. **Decisions.** Update the Brand section of `docs/decisions.md`: one typeface, the neutral palette, and where the accent is used.
14. **Checks.** Update the e2e selectors that named removed elements, retake the screenshots at 1440, 1100 and 800 px and at phone width in both themes, and compare them with `docs/design/prototype/`.
