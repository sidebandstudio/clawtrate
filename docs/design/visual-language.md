# Clawtrate visual language

This document replaces the look of the first app shell. It keeps the shell's structure, file names and naming style, and changes everything visual. The prototype in `docs/design/prototype/` shows it assembled and working on local fixtures: `connect.html`, `pairing.html` and `app.html`. The prototype's `css/tokens.css` and `css/app.css` are written against the shell's own markup (`.shell`, `.rail`, `.main-pane`, `.status-strip`, `.transcript-wrap`, `.drawer-scrim`, `.work-panel`) and are the source for section 14, which says how to bring them into `packages/ui/src/styles/` one component at a time.

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
11. The status strip
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
7. **Nothing below 12 px, and every text colour reaches 4.5:1** on every surface it is allowed to sit on. Section 13 lists the one surface with restrictions. A disabled control changes its fill and text; it is never faded with opacity.
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
| `--list-width` | 312px | 0 (retired; keep 312px until the task column is removed, section 14 step 4) |
| `--panel-width` | 320px | 360px |
| `--header-height` | 52px | 56px, now the band the floating controls sit in |

New: `--weight-regular` 400, `--weight-medium` 500, `--weight-strong` 600; `--space-10` 40px; `--radius-pill` 999px; `--transcript-max` 760px; `--conversation-min` 440px; `--strip-band` 40px (the band under the title pill that is kept clear for the status strip); `--tap-min` 44px; `--avatar-row` 40px, `--avatar-pin` 56px, `--avatar-hero` 64px, `--avatar-pill` 22px. The motion tokens (`--dur-quick` 120ms, `--dur-base` 200ms, `--dur-settle` 420ms, `--ease-in-out`, and the `--loop-*` periods) are used by the state marks here and by the conversation components, and are defined once in this file.

## 3. Type

One family, Figtree, a variable sans. It is round and open at small sizes, which suits bubbles and round controls, and its figures are clear in times and sizes. JetBrains Mono stays for code. Instrument Sans and Instrument Serif are removed.

**Licence.** Figtree comes from the npm package `@fontsource-variable/figtree`, pinned to 5.3.0. The package declares the SIL Open Font License 1.1, copyright The Figtree Project Authors. That licence permits bundling and embedding the font in software under any licence, MIT included, provided the font is not sold by itself and its copyright notice and licence text travel with it; the font stays under the OFL while the app's code stays MIT. The app installs the package and lets the bundler include the font, as it already does for JetBrains Mono (also OFL 1.1). No font file is committed to this repository. The prototype pages name the faces and load them only from a local, ignored stylesheet that `prototype/tools/make-local-fonts.mjs` builds from the same pinned packages.

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

Disabled, every button takes `--bg-bubble` with `--text-faint` (4.7:1 or better) and keeps full opacity; a disabled round button does the same.

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
| Work pane | 64 px | `--avatar-hero` |
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
| Rail | 280 px (248 px below 900) | Bots, with tasks under them |
| Main pane | the rest | Holds the conversation and the Work pane |
| Conversation | never less than 440 px; 600 px or more beside a docked Work pane | Transcript column capped at 760 px and centred |
| Work pane | 360 px | A drawer by default. Docked only when the main pane is 960 px or wider. |

**When the Work pane docks.** The test is the reading width inside a bubble, not the width of the column. With a 600 px conversation, a long reply has about 450 px of text; below that, paragraphs become tall and the pane beside them is nearly as wide as the conversation. So the pane docks only when the main pane is at least 960 px (600 for the conversation, 360 for the pane), which is a 1240 px window with a 280 px rail. Below that it is a drawer over the right edge and the conversation keeps its full width.

Two containers carry the layout, so the same rules serve a narrow window, a split view and the phone: the element that holds the shell (`.app`) for the rail and the one-pane switch, and `.main-pane` for the Work pane.

| Window | Rail | Work pane | Conversation, pane closed | Conversation, pane open |
|---|---|---|---|---|
| 1440 | 280 | docked | 1160 | 800 |
| 1240 | 280 | docked | 960 | 600 |
| 1100 | 280 | drawer | 820 | 820, under the drawer |
| 800 | 248 | drawer | 552 | 552, under the drawer |
| below 688 | one pane at a time | full-width sheet | full width | under the sheet |

688 is where a 248 px rail leaves exactly 440 px for the conversation.

**The reader's place.** Opening or closing the pane, docking or undocking it, and resizing the window never move the reader. If the reader was at the bottom, they stay at the bottom. Otherwise the first message in view stays where it was while the text reflows around it.

## 7. The rail: bots and their tasks

### Structure

```
rail-top        search and new, top right; the left part drags the window
bot-list
  pin-grid      pinned bots as large tiles, three per row (when any are pinned)
  pin-tasks     the tasks of an unfolded pinned bot, right under the tiles
  rail-section  a small grey word, for the user's own sections
  bot-group     a bot, and its tasks when it is unfolded
    bot
    bot-toggle  folds or unfolds the tasks without opening the bot
    task-list
rail-footer     the gateway: a status dot, its name, its state; opens the gateway menu
```

There is no product name in the rail and no heading above the bots.

### Bot row

- 60 px tall (68 on touch), padded 10 px, radius 18.
- Avatar 40 px, 12 px gap, then two lines.
- Line one: the name (15/500) and, right-aligned, the time of the bot's latest activity (12, faint).
- Line two: a state mark when a task is running or failed, one line of preview (14, muted), and the unread dot at the right end.
- Time format: `now` while a task is running, today as `5:36 PM`, yesterday as `Yesterday`, within a week as `Mon`, older as `Nov 9`.
- Hover: `--bg-hover`. Selected: `--bg-selected`. Both are neutral.

**What a row says about a bot with several tasks.** A folded bot must not hide work in its older tasks, so its row is a summary of all of them, and its three signals are independent:

| Signal | Comes from | Where |
|---|---|---|
| Preview and time | The latest activity in any task | Line two, and the time |
| Unread | Any task that is unread, other than the one on screen | The dot at the right end of line two |
| Run state | The most urgent state among the tasks: waiting for you, failed or blocked, done with failures, working, idle | A mark at the start of line two |

So a bot whose newest task has been read still shows the dot for an older unread task, and a bot with a task running in the background shows the working mark and that task's activity while a different task is open. The shell knows two of these states today, working and failed; `conversation.md` adds the rest and gives the avatar a state of its own. The same summary applies to pinned tiles, where the mark or the dot sits beside the name, and to the phone.

### Tasks under a bot

Grok Bot gives a bot one conversation; a Clawtrate bot has many tasks. The arrangement keeps the single list and puts tasks inside it. Three things are tracked separately: the selected bot, the selected task, and which bots are unfolded.

**A bot with one task** looks and behaves like a plain row. Clicking it opens the task, and the row takes the selection. No task rows are shown. A new bot starts this way, so the simple case stays simple.

**A bot with several tasks:**

- Clicking it opens it and unfolds its tasks under it. The task opened is the one last opened for that bot; when there is none, the most recent. The most recent task never overrides a remembered one.
- The bot and its tasks sit in one faint block (55% of `--bg-hover`, radius 18). Only the current task is strongly filled (`--bg-selected`, radius 10, medium weight). The bot row inside the block has no fill.
- Opening another bot folds the one that was unfolded by being open. A bot the user unfolded by hand stays unfolded until they fold it, so two bots' tasks can be in view at once.
- Folding does not change the selection. A folded selected bot shows the selection on its row.
- The fold control is a small chevron that takes the time's place while the row is hovered or has focus. Clicking the open bot's row also folds and unfolds it. From the keyboard, Right unfolds and Left folds.
- Which bots the user unfolded or folded by hand persists across restarts.

**A task row** is one line, 34 px (44 on touch), indented 20 px from the block's edge:

- The title (14, muted; `--text` when current, unread or running). With no mark, the title has the whole row.
- At most one mark at the right, only when there is something to say: the working mark, the failed mark, or the unread dot. `conversation.md` adds the remaining states.
- A truncated title is available in full: a tooltip on hover and on keyboard focus, touch and hold on the phone, and always at the start of the task's transcript and in Details. The time of last activity is in the row's accessible description.

**How many.** Tasks are ordered by latest activity. Six are shown; the next row reads "Show all 14", with the total, and becomes "Show fewer". The current task is always among the six. Archived tasks are not listed here.

**New task** is the last row (a plus and the words, faint). It creates an empty task under the bot, selects it and focuses the composer. Shortcut: ⌘T. For a bot with one task, where no rows show, New task is in the bot's context menu and in the "+" button's menu at the top of the rail.

**Pinned bots** are tiles and have no room for rows. An unfolded pinned bot's tasks show as a block directly under the pin grid, in the same form.

**One pane (the phone).** The list is the same. Tapping a bot with one task opens it. Tapping a bot with several tasks unfolds them in place; tapping it again folds them; tapping a task opens it. There is no separate task-list screen, and Back from a conversation returns to this list.

**Semantics.** The bot is a `button` with `aria-expanded` when it has several tasks. Its name includes the number of tasks and what the summary shows: "Otto, 14 tasks, working, unread". The task list is a `ul` labelled "Otto's tasks". The current task has `aria-current="true"`. A single-task bot has `aria-current` itself.

### Pinned bots and sections

- Pinned bots: a three-column grid of tiles at the top. A tile is a 56 px avatar with the name under it (13, centred, one line) and the working mark or unread dot beside the name; radius 18, `--bg-selected` when open.
- Sections: a small grey word (13, faint, in the user's own casing) with 14 px above and 6 px below. No rule, no caps.

### Footer and the gateway menu

One row: a status dot, the gateway's name (14/500) with its state under it (12, faint). The dot is `--accent-line` when connected, `--warn` and pulsing while connecting or reconnecting, `--danger` when the gateway cannot be reached. The row always agrees with the status strip (section 11).

The row is a menu button. It opens the **gateway menu**, which replaces the shell's theme and disconnect icon buttons until Settings exists:

| Part | Content |
|---|---|
| Head | The gateway's name; under it the state, the address and, when known, the gateway's version |
| Theme | Three radio items: "Match the system", "Light", "Dark". The current one has a check. |
| Disconnect | One item in `--danger`. It disconnects and returns to the connection screen. |

- Surface: `.menu`, 256 px, `--bg-raised` with `--shadow-pop`, radius 14, items 34 px (44 on touch). It opens upward from the row. In the one-pane layout it opens downward from the round button at the top left, which carries the same status dot.
- Keyboard: Enter, Space or Up on the row opens it and focuses the current theme. Up and Down move between items, Home and End go to the ends, Enter or Space chooses. Escape, or a click outside, closes it and returns focus to the row.
- Roles: `menu`, with `menuitemradio` for the themes and `menuitem` for Disconnect; the row has `aria-haspopup="menu"` and `aria-expanded`. The row's accessible name carries the state: "Home gateway, connected. Open the gateway menu."

## 8. The conversation

### Header

No bar. Three things float over the top of the transcript in a 56 px band:

- **Title pill**, centred: a small identifier, not a toolbar. 36 px tall, at most 240 px wide, `--bg-raised` with `--shadow-raised`. A 22 px avatar, the bot's name (14/500), a middle dot, then the task's title (14, muted), which truncates. In the one-pane layout it is the avatar and the name only. It opens the Work pane. Its accessible name is always complete: "Otto, Disk almost full on the media box. Show details." With no task selected it is the bot alone, and the name says so.
- **Work pane button**, top right: a round icon button, pressed while the pane is open. ⌘\ toggles it.
- **Back**, top left: shown only in the one-pane layout.

**The protected top band.** The floating controls have one band of their own: 56 px for the pill and the buttons, then 40 px (`--strip-band`) for the status strip. The transcript's first line starts below both, so nothing is ever under them at rest. Text scrolling up fades out before it reaches the pill; when the status strip is showing, it fades out before it reaches the strip. The band is always reserved, so the transcript does not reflow when the strip appears or leaves.

### The task's name

The first line of every transcript is the task's title in full (14/500, centred, balanced over up to two lines). It is where the task is named on the phone, where the pill has no room for it.

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

### Jump to latest

The shell's `.jump-latest` keeps its behaviour: new output is followed only when the reader is within 96 px of the end; otherwise their place holds and the control appears. It is a pill centred 10 px above the foot of the transcript: 36 px, `--bg-raised` with `--shadow-pop`, the words "Jump to latest" and a down arrow. `conversation.md` gives it the states a running turn needs.

### Composer

One pill at the foot of the column, aligned with the bubbles' outer edges: 48 px, radius 24, `--bg-raised` with a `--border-strong` outline; the outline becomes `--accent-line` with a soft halo on focus. Inside: a round "+" on the left (attach), the text, and a round send button on the right. The send button is `--bg-inverse` when there is text and grey when there is none. Placeholder: "Message <Bot>".

| Situation | Composer |
|---|---|
| A task is open | The pill |
| No task is selected | No composer. There is nothing to send to; the empty state offers "New task". |
| The connection may only read | The pill filled with `--bg-bubble`, no controls: an eye icon and "This device can read but not send. Ask the gateway owner for write access." |
| Offline | The pill; placeholder "Offline. You can keep writing."; send disabled; the draft is kept |

### Empty, loading and failed

- **No task selected**: the bot's avatar at 64 px, "Pick a task", "Choose one of <Bot>'s tasks, or start a new one.", and the actions right there: "New task" (primary), and in the one-pane layout "Choose a task", which returns to the list.
- **A new task with no messages**: the avatar, "Nothing here yet", and "Say what you need, and <Bot> will take it from there." The composer has focus.
- **Loading**: the task's name, then three grey bubbles in the shape of an exchange, pulsing gently; still when motion is reduced.
- **Could not load, nothing saved**: "Could not load this conversation", the reason, and a default button "Try again".
- **Could not refresh, with saved content**: the saved conversation stays on screen. One line on `--danger-soft` above it says "Couldn't refresh this conversation. Showing what was loaded before." with "Try again".

## 9. The Work pane

**Frame.** The pane gets to its content quickly; identity takes the least room it can.

- A round Close button floats at the top right. There is no band reserved for it.
- **Who**: the avatar at 64 px, the bot's name (17/500) and its label (13, faint), centred, starting 20 px from the top.
- **Tabs**: plain words in a centred row: Details, Files, Computer. The chosen tab has a `--bg-selected` pill; the others are muted text. No underline, no box.
- **Content** starts about 200 px from the top and scrolls, 20 px from the edges.

**Details.** The task's title in full comes first (15/500, wrapping to two lines), above the facts, not squeezed into a row. Facts are label and value rows, 42 px each, in one `--bg-bubble` block with radius 18 and hairlines between rows. Groups after that are headed by a small grey word (13, faint). The rows in the prototype (model, where the bot runs, last activity) are examples of the frame; later flows decide the final set.

**Empty states** are words, not boxes: a 44 px round mark with an icon, a title (15/500), and one sentence saying what will appear.

| Tab | Empty title | Sentence |
|---|---|---|
| Files | No files yet | Files <Bot> reads or writes in this task appear here. |
| Computer | No screen to show | When <Bot> uses a browser or a desktop, you can watch it here. |
| Details, routines | (no title) | None yet. Ask <Bot> to do something on a schedule. |

**Drawer and docked.** Below a 960 px main pane it is a drawer: over the right edge, 360 px or the width less 56 px, radius 18 on its left corners, `--shadow-pop`, with the shell's `.drawer-scrim` over everything behind it. In the one-pane layout it is a full-width sheet. At 960 px and above it is docked, with the window's one hairline on its left edge.

| | Drawer or sheet | Docked |
|---|---|---|
| Role | `dialog`, `aria-modal="true"`, labelled "Work pane" | `complementary` (the `aside`) |
| Focus on open | Moves to Close | Stays where it was |
| Tab | Stays inside the pane | Follows the page |
| Behind it | Inert: not focusable, not clickable, hidden from assistive technology | Live |
| Closing | Close, Escape, a click on the scrim, ⌘\ | Close, ⌘\ |
| Focus on close | Returns to the control that opened it | Unchanged |

Crossing the docking width while the pane is open switches between the two without closing it.

**Tabs.** A tab list with one tab stop. Left and Right move to the next tab and select it, wrapping; Home and End go to the ends. Each tab controls a tab panel that is labelled by it and can take focus.

Opening or closing the pane keeps the reader's place (section 6).

## 10. Connection and pairing screens

One centred column, 360 px wide, on the bare stage. No card, no border, no shadow, no gradient.

**The mark** is the product's own: `packages/ui/src/assets/logo-mark.png`, the file `pnpm brand:icons` derives from the logo. It is shown at 56 px with a 16 px radius above the name on Connect, and alone above the title on Pairing. It is never redrawn. These are the only places the mark appears inside the app.

**Connect** (`connect.html`):

- The mark, the name (28/600), the slogan (15, muted).
- Two pill fields, 48 px, `--bg-inset`, placeholders as labels: "Gateway address" and "Token, for the first pairing only". Each has a visually hidden label.
- A primary button, full width: "Connect". While connecting it reads "Connecting…" and is disabled: `--bg-bubble` with `--text-faint`, never a faded primary.
- Under it a quiet button: "Use the development gateway", shown only when that gateway is present.
- One hint (13, faint): "Clawtrate works with an OpenClaw gateway you already run. It asks for read access only, and the token is used once."
- A failure appears between the fields and the buttons on `--danger-soft`: a medium-weight title ("Could not connect", or "Enter the gateway's address") and one sentence with the reason and what to check.

**Pairing** (`pairing.html`):

- The mark, then "Approve this device" (22/600) and one sentence: "<Gateway> has not seen this device before. Approve it once on the gateway's machine and Clawtrate connects by itself."
- The command to run, in one `--bg-inset` block with a copy button. One command, not a list of steps. Copying turns the button into a check and says "Copied" in a live region (the shell's `.copy-status`) for 1.6 seconds.
- "Waiting for approval" with a pulsing `--warn` dot, in a live region. After "Check now" finds nothing it reads "Not approved yet. Still waiting".
- What the device asks for, in plain words, as a chip: "Read bots, tasks and conversations". One chip per scope requested.
- A default button "Check now" ("Checking…" and disabled while it checks) and a quiet button "Use another gateway".
- A footer line (12, faint) with the request id and the device id, for support.

**The bots.** A row of characters stands along the foot of both screens, cropped by the bottom edge, at different sizes and tilts. They are decoration: `aria-hidden`, not interactive, and they do not move. They are in the page's flow, after the form with 24 px between, so they can never sit over it; when the form is tall, the page scrolls and they follow it. Below 640 px of height they are not shown at all, so the command, the waiting line and the way out always fit by themselves.

## 11. The status strip

The shell stays mounted with its cached content when the connection drops. One compact pill, the shell's `.status-strip`, reports it. It sits in the protected band under the title pill (section 8) and overlays the conversation, so nothing shifts when it appears or leaves and no message text is ever under it.

| State | Dot | Words | Action |
|---|---|---|---|
| Reconnecting | `--warn`, pulsing | **Reconnecting** · showing saved messages | Retry now |
| Cannot reach the gateway | `--danger` | **Can't reach <gateway>** · showing saved messages | Retry now |
| Connected, fetching what was missed | `--warn`, pulsing | **Connected** · catching up | none |
| Caught up | `--accent-line` | **Synced** · 3 new in this task (or "Synced" alone) | none; leaves after 4 seconds |
| Fetch failed | `--danger` | **Couldn't sync this task** | Try again |
| The gateway's bots and tasks failed to load | `--danger` | The gateway's message, or "Could not load this gateway's bots and tasks." | Retry now |

- The first part of each line is the state and always shows in full, with the action. The part after the middle dot is an explanation in `--text-muted`; it is the only part that shortens, and on a narrow column it shortens to nothing.
- The strip has `role="status"`. It is 34 px tall, at most the column's width less 24 px.
- One state drives the strip, the footer's dot and words, and the composer, so they cannot disagree: while the strip says reconnecting, the footer says "Reconnecting…" and the composer says "Offline. You can keep writing."
- Nothing in the conversation unmounts on reconnect, and anything the user had opened stays open. When synced items land below the fold, the reader's place holds and Jump to latest offers them.

## 12. Compact and phone layouts

**Drawer widths (below 1240).** Described in sections 6 and 9. The rail narrows to 248 px below 900.

**One pane (below 688, and the phone).** The rail is the list and the main pane is the detail.

- The list fills the width. The footer row is replaced by a round button at the top left: the Settings icon with the connection dot on it, which opens the gateway menu. Search and New stay top right.
- Rows are 68 px with 44 px avatars; task rows are 44 px; text is one step larger (17 px names and messages).
- Tasks unfold in place, as in section 7. Pinned tiles and their task block work the same way.
- In the conversation, Back is a round button at the top left and the Work pane button stays at the top right. The title pill between them is the avatar and the bot's name; the task is named at the start of the transcript and in Details.
- The Work pane is a full-width sheet with the same frame, and is modal.
- The composer keeps its form; its buttons are 40 px.
- The connection screens keep their column; the bots are scaled to 60%, and are hidden on a short screen.

The iOS app is built in React Native and does not use this CSS. The sizes, tokens and behaviour above are the specification for it; `[data-input="touch"]` in the prototype shows them.

## 13. Accessibility

**Contrast**, measured against every surface each colour is used on, with translucent fills composited over their real parents:

| Text | Light, lowest | Dark, lowest | Where the lowest is |
|---|---|---|---|
| `--text` | 13.9:1 | 11.2:1 | The selected task inside an unfolded bot (light); a soft accent fill (dark) |
| `--text-muted` | 5.4:1 | 6.1:1 | The selected task inside an unfolded bot (light) |
| `--text-faint` | 4.5:1 | 4.7:1 | The selected task inside an unfolded bot (light) |
| `--accent` as text | 4.6:1 | 7.9:1 | The same |
| `--warn` as text | 4.6:1 | 6.7:1 | A selected rail row; see the restriction below |
| `--danger` as text | 5.0:1 | 5.5:1 | |
| Text in your bubbles | 6.2:1 | 10.2:1 | |
| Disabled button text | 5.4:1 | 6.2:1 | `--text-faint` on `--bg-bubble` |

**One surface has a restriction.** The selected task's fill inside an unfolded bot is the darkest light surface (`#dededd` once its two fills are composited over the rail). On it `--warn` reaches only 4.4:1 in light theme, so warn-coloured text is never placed there: the current task's title is `--text`, and a task's state is a mark, not a word. `--accent-line` is for marks only (3.1:1 at worst in light); it is never text. In light theme `--text-faint` and `--text-muted` are close in value by necessity, so hierarchy between them comes from size and position.

Text fading under the floating controls and anything behind the drawer's scrim is deliberately concealed and is outside these figures.

**Focus.** Every control shows a 2 px `--accent-line` outline, 2 px out, on keyboard focus. Fields show the same as a ring.

**Keyboard.**

| Where | Keys |
|---|---|
| Anywhere | ⌘\ toggles the Work pane. ⌘K search, ⌘N new bot, ⌘T new task, ⌘I focus the composer. |
| Rail | Tab reaches every row. Up and Down move between rows; Home and End go to the ends. Right unfolds a bot, Left folds it; Left on a task goes to its bot. Enter opens. |
| Gateway menu | Section 7. |
| Work pane tabs | Left, Right, Home, End. |
| Drawer | Focus is kept inside. Escape closes it. |
| Composer | Enter sends, Shift+Enter adds a line. |

Tab order follows reading order: rail top, bots and tasks, footer, conversation header, transcript, composer, Work pane.

**Names.** Round buttons have `aria-label`s that say what they do. A bot row's name includes its number of tasks and its summary. The transcript is a focusable region so it can be scrolled from the keyboard.

**Motion.** This part of the design moves very little: a pulsing status dot, the loading bubbles and the working mark's arc. All stop when motion is reduced, whether by the system setting or by the app's own (`data-motion="reduce"` on the root, which the stylesheet honours the same way); the dot's colour, the mark's shape and the words beside them carry the state.

**Targets.** 32 px round buttons with at least 8 px between them on desktop; 40 px and larger on touch, with rows at 44 px or more.

## 14. Change list for the builder

Written against the shell as it is in `packages/ui/src/`: `App.tsx`, `Shell.tsx` (`Rail`, `TaskList`, `WorkPanel`, `StatusStrip`, `useSelection`, `Shell`), `Conversation.tsx` (`TranscriptView`, `Placeholder`, `Conversation`), `ConnectScreen.tsx`, `Avatar.tsx`, `icons.tsx`, and `styles/app.css`.

`prototype/css/app.css` is in the order of these steps. In each step, take the named section of that file together with the markup change, and delete the old rules the step lists. Each step leaves the app working and looking coherent, because a component's styles and markup change together. The stylesheet is never replaced in one go.

### What moves where

| Now | After | Step |
|---|---|---|
| `.shell` grid: rail, task list, main pane | `.shell` grid: rail, main pane | 4 |
| `Rail`: `.brand`, `.rail-section` "Bots", `.bot` (avatar, name, theme, count) | `Rail`: `.rail-top`, `.bot-group` holding `.bot` (avatar, name and time, preview and unread), `.bot-toggle`, `.task-list` | 4 |
| `TaskList`: `section.list-pane`, its `.pane-header`, `.task` with `.task-top`, `.task-preview`, `.task-status` | Removed. Its rows become one-line `.task` buttons inside the rail's `.bot-group`. | 4 |
| `.rail-tooltip` for bot names in the compact rail | `.rail-tooltip` for truncated task titles | 4 |
| `.rail-footer`: `.gateway-pill` (a status), theme button, disconnect button | `.rail-footer`: `.gateway-pill` as a menu button; `.gateway-menu` | 4 |
| `.main-pane` (a one-column grid) holding `StatusStrip`, `Conversation`, `.drawer-scrim`, `WorkPanel` | `.main-pane` (a flex row, container `main`) holding the same four, in the same order | 5 |
| `WorkPanel`: `.pane-header` with a title and Close, one `.work-empty` paragraph | `.work-close`, `.work-hero`, `.tabs`, `.work-sections` with three tab panels | 5 |
| `.drawer-scrim` (a button, shown below 1320 px) | The same button, shown whenever the pane is a drawer (main pane below 960 px) | 5 |
| `Conversation` header: `.pane-header.conversation-header` with `.back-button`, `.conversation-title` (h1 and a meta line), panel button | `.conversation-header` with `.header-side` (Back), `.title-pill`, `.header-side` (panel button) | 6 |
| `StatusStrip`: `.status-strip` in the main pane's flow | `.status-strip` positioned in the protected band; `data-strip` on `.conversation` | 6 |
| `.transcript-wrap` > `.transcript` > `.transcript-inner` > `article.turn` | The same three wrappers > `.task-line`, `.stamp`, `.msg` > `.bubble`, `details.steps` | 6 |
| `.jump-latest` | The same element, restyled | 6 |
| `footer.read-only-bar` | `footer.composer` (the pill; `data-readonly` when the connection may only read) | 6 |
| `ConnectScreen`: `.connect-card` with a `.panel` card, `.pair-steps`, two `.command` blocks | `.connect-card` with a bare `.panel`, one `.command`, `.copy-status`, `.waiting`, `.scopes`; `.ensemble` after the card | 7 |

Keep every `data-testid` on the element that takes over its role: `bot-list`, `bot`, `task-list`, `task`, `rail-tooltip`, `status-strip`, `transcript`, `transcript-turn` (on `.msg`), `live-turn`, `tool-call` (on `.step`), `jump-latest`, `work-panel`.

### Steps

1. **Fonts.** Add `@fontsource-variable/figtree` at 5.3.0 to `packages/ui/package.json` and import it in `src/index.ts`. Leave the Instrument packages until step 8.
2. **Tokens.** Replace the values in `styles/tokens.css` with those in `prototype/css/tokens.css`, keeping the shell's three theme selectors; both dark blocks get the same values. Add the new tokens. Keep `--list-width` at 312px for now. The app works with its old rules on the new values.
3. **Base, controls and avatars.** Take the sections "Base", "Controls" and "Avatars". The classes are unchanged (`.icon-button`, `.button`, `.input`, `.avatar`), so no markup changes except: give the element that holds the shell and the connection screen the class `app` (`App.tsx`), set `data-input="touch"` on the root when the primary pointer is coarse, and set `data-motion="reduce"` on it when the user asks for reduced motion in the app. In `icons.tsx` set the stroke to 1.6 and add search, plus, settings, x, arrow-up, file and screen from `prototype/js/icons.js`. In `Avatar.tsx` draw a character (body, colour, tilt, look, as in `prototype/js/icons.js`), derived from a stable hash of the bot's id when nothing is stored; show `avatarUrl` cropped to a circle when the bot has one; remove the emoji badge and the `badge` prop; delete `.avatar-emoji`. Stop generating pattern images for the seed bots in `tools/dev-gateway`.
4. **Rail and tasks.** Take "Shell" (the two-column grid), "State marks" and "Rail", with the Motion section's `orbit` and `ping`. Set `--list-width` to 0.
   - `Rail`: remove the brand row and the "Bots" heading; add `.rail-top` with Search and New. Render each bot as a `.bot-group` as in `prototype/js/app.js` (`renderRail`): the row, the fold control, and its `.task-list` when unfolded, ending in "Show all" and "New task". Pinned bots, when the data has them, render as `.pin-grid` and `.pin-tasks`.
   - `TaskList`: delete it, its `.list-pane` and its header. Move its "Showing the most recent tasks only" note (`.list-note`) to the end of the bot's task rows.
   - `useSelection`: keep `taskByBot`; it is the remembered task and it wins over the most recent. Add the set of bots unfolded or folded by hand, stored with `writePreference`. Keep marking a task read when it is left. Compute the bot's summary (latest activity, any unread, most urgent state) from all of its tasks.
   - `Shell`: selecting a bot no longer sets `view` to `"list"`. In the one-pane layout a bot with several tasks unfolds in place and selecting a task sets `view` to `"detail"`.
   - Footer: make `.gateway-pill` a menu button and add the gateway menu (section 7) with the theme choice and Disconnect; remove the two icon buttons. Keep the gateway details in the menu's head.
   - `.rail-tooltip`: show it for a truncated task title on hover and on keyboard focus.
   - Delete: `.brand`, `.brand-name`, `.bot-theme`, `.bot-count`, `.list-pane`, `.pane-title` rules that only the list used, `.task-top`, `.task-preview`, `.task-status`, the `.task[aria-current]::before` bar, and the `max-width: 979px` compact-rail block.
5. **Main pane and Work pane.** Take "Shell" (`.main-pane`) and "Work pane".
   - `.main-pane` becomes a flex row and a named container (`main`). The order of its children does not change.
   - `WorkPanel`: replace the header and the placeholder paragraph with `.work-close`, `.work-hero`, the tab list and three tab panels (section 9).
   - Behaviour: the pane is modal when it is a drawer and not when docked (the table in section 9). The shell already moves focus in when the drawer opens; add the focus trap, `inert` on `.rail` and `.conversation`, the dialog role, and the return of focus on close, and switch all of it off when docked. Keep the reader's place across opening and closing (`holdPlace` in `prototype/js/app.js`).
   - Delete the `min-width: 1320px` and `max-width: 1319px` blocks; the container query replaces them.
6. **Conversation.** Take "Conversation", "Markdown", "Composer", "Empty and loading states" and "Status strip".
   - Header: replace `.conversation-title` with the `.title-pill`; wrap Back and the panel button in `.header-side`. Drop the `.pane-header` class here.
   - `StatusStrip`: keep the component and its place in the markup. Change its text to the two-part form (`.status-strip-text` with the explanation in a `span`) and add the caught-up and sync-failed states (section 11). Set `data-strip="true"` on `.conversation` while it shows.
   - `TranscriptView`: keep `.transcript-wrap`, the scroller and its follow logic. Add `.task-line` first. Render each item as `.msg[data-role]` with a `.bubble` (`.md` for the bot), insert `.stamp` rows by the ten-minute rule, and fold a turn's reasoning and tool blocks into one `details.steps`. The live turn is a `.msg` whose bubble holds the live text.
   - `Placeholder` and the loading branch: the states in section 8, including "New task" in the no-task state and the retained-content line when a refresh fails.
   - Footer: replace `.read-only-bar` with the composer pill, in its read-only form while the connection may only read; render no composer when no task is selected.
   - Delete: `.pane-header`, `.conversation-title`, `.turn*`, `.user-mark`, `.system-row`, `.step-chevron`, `.step-kind`, `.step-reasoning-preview`, `.step-state`, `.step-body`, `.live-text`, `.read-only-bar`, and the `@container (max-width: 620px)` block.
7. **Connection screens.** Take "Connection and pairing screens". Remove the card and the numbered steps from `ConnectScreen.tsx`; build the centred column and the row of bots as in section 10. Keep every existing state and message, and `.copy-status`. The mark is `assets/logo-mark.png` at 56 px. Delete `.divider`, `.pair-steps`, `.pair-step`, `.pair-marker`, `.field-label`, `.request-id`, `.run-node`.
8. **Clean up.** Take "Motion" and "Compact layouts". Delete the `max-width: 759px` block; the `app` container query replaces it. Remove `@fontsource-variable/instrument-sans` and `@fontsource/instrument-serif` and their imports. Update the Brand section of `docs/decisions.md`: one typeface and its licence, the neutral palette, where the accent is used, and where the mark appears.
9. **Checks.** Update the e2e selectors that named removed elements. Then check, at 1440, 1240, 1100 and 800 px and at phone width, in both themes:
   - selecting a bot opens its remembered task; folding and unfolding do not change the selection; a folded bot still shows unread and running work;
   - the six-row cap, "Show all", "New task", and the arrow keys in the rail;
   - the Work pane docks at a 960 px main pane, is modal only as a drawer, and keeps the reader's place when toggled after scrolling;
   - the status strip, the footer and the composer agree in every connection state, and no text is under the strip;
   - the connection screens at 320 × 568 px;
   - reduced motion from the system and from `data-motion`.
