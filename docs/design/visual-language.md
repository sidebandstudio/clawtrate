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
9. **The bot's work reads as what it did.** Each action is one quiet line in plain words, and actions of one kind in a row share one. Reasoning and raw calls stay folded until asked for.
10. **One list.** Tasks live under their bot in the rail. There is no separate task column.

## 2. Tokens

The token names the shell uses are kept, so its rules pick up the new values. `prototype/css/tokens.css` is the file to copy. The "Old" columns below are the values in `packages/ui/src/styles/tokens.css` when this was written; they show what changes and are not a patch to apply. In the app, keep the shell's selectors (`:root`, the `prefers-color-scheme` block and `:root[data-theme]`); the prototype scopes themes to any element with `data-theme` only so that its gallery can show both at once.

### Colour, changed values

| Token             | Old light             | New light                                                             | Old dark                     | New dark                                                           |
| ----------------- | --------------------- | --------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `--bg`            | `#f4f5f2`             | `#ffffff`                                                             | `#0b0e14`                    | `#101112`                                                          |
| `--bg-rail`       | `#eceee9`             | `#f6f6f5`                                                             | `#080a0f`                    | `#0b0c0d`                                                          |
| `--bg-list`       | `#f8f9f6`             | `#f6f6f5`, the rail's value written out; deleted with the task column | `#0d1118`                    | `#0b0c0d`, the same                                                |
| `--bg-pane`       | `#ffffff`             | `#ffffff`                                                             | `#10141c`                    | `#101112`                                                          |
| `--bg-raised`     | `#ffffff`             | `#ffffff`                                                             | `#151a23`                    | `#1c1d1f`                                                          |
| `--bg-hover`      | `rgba(20,28,34,.045)` | `rgba(17,18,19,.05)`                                                  | `rgba(214,240,232,.05)`      | `rgba(255,255,255,.06)`                                            |
| `--bg-selected`   | `#e6f5f0`             | `rgba(17,18,19,.08)`                                                  | `rgba(62,230,193,.1)`        | `rgba(255,255,255,.1)`                                             |
| `--bg-inset`      | `#f3f5f2`             | `#f0f0ee`                                                             | `#0c1017`                    | `#1a1b1d`                                                          |
| `--bg-code`       | `#f2f4f1`             | `rgba(17,18,19,.06)`                                                  | `#0a0d13`                    | `rgba(255,255,255,.08)`                                            |
| `--border`        | `#dfe3dc`             | `rgba(17,18,19,.09)`                                                  | `#1d232d`                    | `rgba(255,255,255,.08)`                                            |
| `--border-strong` | `#cfd5cc`             | `rgba(17,18,19,.16)`                                                  | `#2a313d`                    | `rgba(255,255,255,.16)`                                            |
| `--text`          | `#151a1f`             | `#111213`                                                             | `#e6ebe9`                    | `#f3f3f2`                                                          |
| `--text-muted`    | `#474f55`             | `#55575b`                                                             | `#b0babd`                    | `#b4b6b9`                                                          |
| `--text-faint`    | `#5a6368`             | `#606266`                                                             | `#8b969b`                    | `#9d9fa2`                                                          |
| `--accent-soft`   | `#e6f5f0`             | `rgba(10,110,92,.1)`                                                  | `rgba(62,230,193,.12)`       | unchanged                                                          |
| `--warn`          | `#9a5b00`             | `#935600`                                                             | `#f0b45a`                    | unchanged                                                          |
| `--warn-soft`     | `#fbf1dc`             | `rgba(147,86,0,.1)`                                                   | `rgba(240,180,90,.12)`       | unchanged                                                          |
| `--danger-soft`   | `#fbe9e7`             | `rgba(179,38,30,.09)`                                                 | `rgba(255,138,128,.12)`      | unchanged                                                          |
| `--shadow-raised` | two soft shadows      | `0 0 0 1px rgba(17,18,19,.06), 0 2px 8px rgba(17,18,19,.08)`          | inset line and a deep shadow | `inset 0 0 0 1px rgba(255,255,255,.07), 0 4px 14px rgba(0,0,0,.4)` |
| `--stage-glow`    | radial gradient       | `none` (retired)                                                      | radial gradient              | `none` (retired)                                                   |

Unchanged: `--accent` (`#0a6e5c` / `#3ee6c1`), `--accent-strong`, `--accent-line` (`#0d8f77` / `#3ee6c1`), `--accent-on`, `--danger`. The accent still derives from the logo.

`--bg-selected` moving from a mint fill to a neutral one is the single change that most alters the feel: selection no longer spends the accent.

### Colour, new tokens

| Token                | Light                                                          | Dark                                                                | Use                                                 |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `--bg-bubble`        | `#f0f0ee`                                                      | `#1f2022`                                                           | The bot's bubbles, cards, grey buttons, fact blocks |
| `--bg-inverse`       | `#111213`                                                      | `#f3f3f2`                                                           | Primary buttons, the send button                    |
| `--text-inverse`     | `#ffffff`                                                      | `#111213`                                                           | Text on `--bg-inverse`                              |
| `--bubble-user`      | `#0a6e5c`                                                      | `#3ee6c1`                                                           | Your bubbles                                        |
| `--bubble-user-text` | `#ffffff`                                                      | `#04261f`                                                           | Text in your bubbles (6.2:1 and 10.2:1)             |
| `--bg-scrim`         | `rgba(17,18,19,.22)`                                           | `rgba(0,0,0,.5)`                                                    | Behind the Work pane drawer and phone sheets        |
| `--warn-line`        | `rgba(147,86,0,.32)`                                           | `rgba(240,180,90,.42)`                                              | Outline of something that needs you                 |
| `--danger-line`      | `rgba(179,38,30,.3)`                                           | `rgba(255,138,128,.42)`                                             | Outline of a failure                                |
| `--shadow-button`    | `0 0 0 1px rgba(17,18,19,.06), 0 1px 2px rgba(17,18,19,.06)`   | `inset 0 0 0 1px rgba(255,255,255,.06)`                             | Round buttons                                       |
| `--shadow-pop`       | `0 0 0 1px rgba(17,18,19,.06), 0 12px 36px rgba(17,18,19,.16)` | `inset 0 0 0 1px rgba(255,255,255,.07), 0 16px 44px rgba(0,0,0,.6)` | Menus, the strip, the drawer                        |

`--bubble-user` is its own token so that a later Appearance setting can switch your bubbles to neutral without touching the accent.

### Type, size and layout tokens

| Token             | Old                      | New                                                                                       |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `--font-ui`       | Instrument Sans Variable | `"Figtree Variable", "Figtree", ui-sans-serif, system-ui, sans-serif`                     |
| `--font-display`  | Instrument Serif         | alias of `--font-ui` (retired)                                                            |
| `--font-mono`     | JetBrains Mono           | unchanged                                                                                 |
| `--text-xs`       | 12px                     | 12px (unchanged)                                                                          |
| `--text-sm`       | 12.5px                   | 13px                                                                                      |
| `--text-md`       | 13.5px                   | 14px                                                                                      |
| `--text-base`     | 14px                     | 15px                                                                                      |
| `--text-lg`       | 16px                     | 17px                                                                                      |
| `--text-title`    | 24px                     | 28px                                                                                      |
| `--radius-sm`     | 5px                      | 10px                                                                                      |
| `--radius-md`     | 8px                      | 14px                                                                                      |
| `--radius-lg`     | 12px                     | 18px                                                                                      |
| `--rail-width`    | 228px                    | 280px                                                                                     |
| `--list-width`    | 312px                    | retired; keep 312px until the task column is removed (section 14, step 4), then delete it |
| `--panel-width`   | 320px                    | 360px                                                                                     |
| `--header-height` | 52px                     | 56px, now the band the floating controls sit in                                           |

New: `--weight-regular` 400, `--weight-medium` 500, `--weight-strong` 600; `--space-10` 40px; `--radius-pill` 999px; `--transcript-max` 760px; `--conversation-min` 440px; `--strip-band` 42px (the band under the title pill that is kept clear for the status strip: the 32 px of the strip that lie below the header band, a 2 px gap, and the 8 px over which text fades in; section 11); `--tap-min` 44px; `--avatar-row` 40px, `--avatar-pin` 56px, `--avatar-hero` 64px, `--avatar-pill` 22px. The motion tokens (`--dur-quick` 120ms, `--dur-base` 200ms, `--dur-settle` 420ms, `--ease-in-out`, and the `--loop-*` periods) are used by the state marks here and by the conversation components, and are defined once in this file.

## 3. Type

One family, Figtree, a variable sans. It is round and open at small sizes, which suits bubbles and round controls, and its figures are clear in times and sizes. JetBrains Mono stays for code. Instrument Sans and Instrument Serif are removed.

**Licence.** Figtree comes from the npm package `@fontsource-variable/figtree`, pinned to 5.3.0. The package declares the SIL Open Font License 1.1, copyright The Figtree Project Authors. That licence permits bundling and embedding the font in software under any licence, MIT included, provided the font is not sold by itself and its copyright notice and licence text travel with it; the font stays under the OFL while the app's code stays MIT. The app installs the package and lets the bundler include the font, as it already does for JetBrains Mono (also OFL 1.1). No font file is committed to this repository. The prototype pages name the faces and load them only from a local, ignored stylesheet that `prototype/tools/make-local-fonts.mjs` builds from the same pinned packages.

| Role                                                    | Size                        | Weight                                                   | Line height | Colour                     |
| ------------------------------------------------------- | --------------------------- | -------------------------------------------------------- | ----------- | -------------------------- |
| Message text, inputs                                    | 15                          | 400                                                      | 1.5         | `--text`                   |
| Bot name in the rail                                    | 15                          | 500                                                      | 20px        | `--text`                   |
| Preview line, task row, buttons, panel rows, title pill | 14                          | 400 (500 for buttons, the pill's name, the current task) | 20px        | `--text-muted` or `--text` |
| Event lines, section words, hints                       | 13                          | 400                                                      | 1.4         | `--text-faint`             |
| Stamps, times                                           | 12                          | 400                                                      | 1.3         | `--text-faint`             |
| Heading inside a reply                                  | 15                          | 600                                                      | 1.5         | `--text`                   |
| Work pane name                                          | 20                          | 500                                                      | 1.25        | `--text`                   |
| Screen title (pairing)                                  | 22                          | 600                                                      | 1.25        | `--text`                   |
| Product name (connect)                                  | 28                          | 600, tracking −0.01em                                    | 1.15        | `--text`                   |
| Code                                                    | 0.88em inline, 13 in blocks | 400                                                      | 1.5         | `--text`                   |

Rules: no uppercase labels, no added letter-spacing except on the two titles, no italics for interface text, tabular figures for times. On touch, message text and inputs are 17 px and names are 17 px.

## 4. Spacing, shape and surfaces

**Spacing.** The shell's 4 px scale stays. The rhythm that matters:

- 12 px from the window edge to a floating control; 8 px from the rail's edge to a row; 20 px from the stage's edge to the transcript column.
- 12 px between an avatar and its text.
- 9 × 14 px inside a bubble.
- 4 px between bubbles from one sender; 16 px when the sender changes; a stamp takes 22 px above and 10 px below.

**Radii.** Three: 10 px for insets and task rows, 18 px for bubbles, cards and the open bot group, fully round for buttons, pills, fields and the composer (the composer uses 24 px so it stays a pill when it grows to several lines). Menus and small cards use 14 px.

**Surfaces.**

| Surface     | Token                                                                     | Where                                                                                                    |
| ----------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Stage       | `--bg` / `--bg-pane`                                                      | Conversation, Work pane, connection screens                                                              |
| Rail        | `--bg-rail`                                                               | The sidebar. In light it is a step greyer than the stage; in dark a step darker. No border between them. |
| Raised fill | `--bg-bubble`                                                             | Bubbles, cards, fact blocks, grey buttons, the read-only composer                                        |
| Floating    | `--bg-raised` with `--shadow-button`, `--shadow-raised` or `--shadow-pop` | Round buttons, the title pill, the composer, menus, the strip, the drawer                                |

**Borders.** `--border` is used for the Work pane's left edge when docked, for table row rules, and for the rules inside a fact block. `--border-strong` outlines the composer. Nothing else is outlined. Avatars have no ring.

**Buttons.**

| Kind                     | Look                                                                                                                 | Use                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Round icon button, 32 px | `--bg-raised` and `--shadow-button`; `data-variant="quiet"` is transparent until hovered; pressed is `--bg-selected` | Every icon control     |
| Primary                  | `--bg-inverse` on `--text-inverse`, pill                                                                             | One per screen at most |
| Default                  | `--bg-bubble`, pill                                                                                                  | Secondary actions      |
| Quiet                    | Transparent, `--text-muted`                                                                                          | Tertiary actions       |

Disabled, every button takes `--bg-bubble` with `--text-faint` (4.7:1 or better) and keeps full opacity; a disabled round button does the same.

Sizes: 40 px default, 48 px (`data-size="lg"`, full width) on the connection screens, 30 px (`data-size="sm"`) inside cards and strips. Icons are 16 px with a 1.6 px round stroke, drawn for Clawtrate.

## 5. Avatars

Avatars are creatures, drawn for Clawtrate, and they carry the colour in the app. There are three families. Each has a part of its own that does the acting, and that part comes from Clawtrate: a claw, a shell, the white ball of the logo.

- **Clawlings**, the default: a soft body with a small mouth, eyes on stalks and a pair of pincers. Parts: a body (dome, tall, wide, round), eyes (two, splayed, short stalks, one eye) and claws (even, a fiddler's one big claw, big).
- **Shellfolk**: one shy cream critter, the same on every bot, wearing a shell in the bot's colour (spiral, turret, dome, spotted). The shell tells bots apart; the critter acts.
- **Lanterns**: round deep-sea critters whose curved antenna ends in the logo's white ball, held like a conductor's baton. Parts: a body (round, bell, oval, box), a lure (hook, flick, wave, reach) and one or two eyes.

Every family takes one of eight colours: green `#58c26f`, blue `#5b8dff`, orchid `#cf7ee8`, violet `#a98bff`, yellow `#f6bd3b`, pink `#ff6f9c`, sky `#45bdf5`, lime `#a5d955`. Pupils and mouths are `#16181b`, eye whites `#ffffff`, the ball `#f6f5f2` with a `#c9c6bf` rim so it holds on a light page. These are the same in light and dark.

**The palette guard.** No creature is drawn in a red lobster's colours (OpenClaw's mascot) or an orange crab's (Rust's Ferris): no saturated, mid-light hue from red through orange, 345° to 38°. Orange left the palette for orchid. Bodies stay abstract, never shellfish.

The construction is in `packages/core/src/avatar.ts`, which the app and the iPhone share: every shape as path data, circles, ellipses and rects on a 40-unit grid, the motions as keyframes, the choice and how it is kept. `prototype/avatars.html` shows each family in each state at each size, dark and light.

| Use                   | Size                | Token             |
| --------------------- | ------------------- | ----------------- |
| Message card          | 18 px               |                   |
| Title pill            | 22 px               | `--avatar-pill`   |
| Rail row              | 40 px (44 on touch) | `--avatar-row`    |
| Pinned tile           | 56 px               | `--avatar-pin`    |
| Work pane             | 64 px               | `--avatar-hero`   |
| Empty conversation    | 64 px               |                   |
| New bot, Edit picture | 104 px              | `--avatar-create` |

Below 21 px a creature drops its fine detail: mouths, the glint in waiting eyes, and the lines on shells, all under a pixel wide there. Silhouette, eyes, claws, lure and shell spots stay.

**States.** The creature acts out the state that `conversation.md` section 4 gives the avatar. The ring and the badge stay as that section draws them. Failed looks blocked; stopped looks idle.

| State    | Clawlings                                 | Shellfolk                             | Lanterns                                 |
| -------- | ----------------------------------------- | ------------------------------------- | ---------------------------------------- |
| idle     | Blinks, claws at rest                     | Out of its shell, blinking            | Blinks, lure still                       |
| thinking | Sways, stalks lean, eyes up               | Tilts its head, eyes up               | Watches its lure sway; the ball glows    |
| working  | Snaps its claws and bobs                  | Crawls along                          | Conducts with the lure and bobs          |
| waiting  | Waves a claw at you, eyes wide            | Stretches up toward you               | The ball lights with a ping, eyes on you |
| blocked  | Stalks and claws droop, colour fades      | Hides in its shell, only its eyes out | The lure droops and the ball goes dark   |
| done     | Hops with both claws up, holding the ball | Pops out happy                        | A happy bounce                           |

**Reduced motion.** Under the system's setting or the app's own, and while the connection is lost, nothing moves. Each state then holds a still pose that says the same thing, never a frame from the middle of a motion: the waving claw is held up, the drooping parts stay drooped, the lit ball keeps its halo.

Rules:

- No frame, ring, shadow or emoji badge beyond the state ring and badge.
- A bot whose gateway identity carries its own picture, uploaded or made elsewhere, shows that picture cropped to a circle at the same sizes, with the ring and badge.
- A bot with no picture gets a Clawling chosen from a stable hash of its id, so it looks the same on every device until someone picks one.
- A chosen creature is kept with the bot as its picture (`bots.md` section 3).
- Avatars do not appear beside messages. In a one-to-one conversation the bot is identified by the title pill.

## 6. Layout and widths

The window is two panes, with a third on request.

| Pane         | Width                                                            | Notes                                                                   |
| ------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Rail         | 280 px (248 px below 900)                                        | Bots, with tasks under them                                             |
| Main pane    | the rest                                                         | Holds the conversation and the Work pane                                |
| Conversation | never less than 440 px; 600 px or more beside a docked Work pane | Transcript column capped at 760 px and centred                          |
| Work pane    | 360 px                                                           | A drawer by default. Docked only when the main pane is 960 px or wider. |

**When the Work pane docks.** The test is the reading width inside a bubble, not the width of the column. With a 600 px conversation, a long reply has about 450 px of text; below that, paragraphs become tall and the pane beside them is nearly as wide as the conversation. So the pane docks only when the main pane is at least 960 px (600 for the conversation, 360 for the pane), which is a 1240 px window with a 280 px rail. Below that it is a drawer over the right edge and the conversation keeps its full width.

Two containers carry the layout, so the same rules serve a narrow window, a split view and the phone: the element that holds the shell (`.app`) for the rail and the one-pane switch, and `.main-pane` for the Work pane.

| Window    | Rail               | Work pane        | Conversation, pane closed | Conversation, pane open |
| --------- | ------------------ | ---------------- | ------------------------- | ----------------------- |
| 1440      | 280                | docked           | 1160                      | 800                     |
| 1240      | 280                | docked           | 960                       | 600                     |
| 1100      | 280                | drawer           | 820                       | 820, under the drawer   |
| 800       | 248                | drawer           | 552                       | 552, under the drawer   |
| below 688 | one pane at a time | full-width sheet | full width                | under the sheet         |

688 is where a 248 px rail leaves exactly 440 px for the conversation.

**The reader's place.** Opening or closing the pane, docking or undocking it, and resizing the window never move the reader. If the reader was at the bottom, they stay at the bottom. Otherwise the first message in view stays where it was while the text reflows around it.

## 7. The rail: bots and their tasks

### Structure

```
rail-top        search and new, top right; the left part drags the window
bot-list
  pin-grid      pinned bots as large tiles, three per row (when any are pinned)
  pin-tasks     the grid's one task block: its owner's name, then that bot's tasks
  rail-section  a small grey word, for the user's own sections
  bot-group     a bot, and its tasks when it is unfolded
    bot
    bot-toggle  folds or unfolds the tasks without opening the bot
    task-list
rail-footer     the gateway: a status dot, its name, its state; opens the gateway menu
```

There is no product name in the rail and no heading above the bots.

**Order.** Bots keep the order the shell has today: the gateway's default bot first, then the gateway's order. They are not re-sorted by activity, so a row never moves while it is being read. Tasks under a bot are ordered by latest activity, newest first, which is also what the shell does today. A sort control for bots (recent activity, name, manual) belongs to the later sidebar flow; when it lands, "recent activity" becomes its default.

**What the rail shows depends on what the connection may do.** Every control that creates something ("+", "New task" in all its places) is shown only when the connection may write (section 8, "May this connection write?"). On a read-only connection those controls are absent, not disabled: there is nothing the user can do in the app to enable them, and the reason is given once, in the composer's place. Search is shown once search exists.

### Bot row

- 60 px tall (68 on touch), padded 10 px, radius 18.
- Avatar 40 px, 12 px gap, then two lines.
- Line one: the name (15/500) and, right-aligned, the time of the bot's latest activity (12, faint).
- Line two: a state mark when a task is running or failed, one line of preview (14, muted), and the unread dot at the right end.
- Time format: `now` while a task is running, today as `5:36 PM`, yesterday as `Yesterday`, within a week as `Mon`, older as `Nov 9`.
- Hover: `--bg-hover`. Selected: `--bg-selected`. Both are neutral.

**What a row says about a bot with several tasks.** A folded bot must not hide work in its older tasks, so its row is a summary of all of them, and its three signals are independent:

| Signal           | Comes from                                                                                                   | Where                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Preview and time | The latest activity in any task                                                                              | Line two, and the time               |
| Unread           | Any task that is unread, other than the one on screen                                                        | The dot at the right end of line two |
| Run state        | The most urgent state among the tasks: waiting for you, failed or blocked, done with failures, working, idle | A mark at the start of line two      |

So a bot whose newest task has been read still shows the dot for an older unread task, and a bot with a task running in the background shows the working mark and that task's activity while a different task is open. The shell knows two of these states today, working and failed, and failed comes before working; `conversation.md` adds the rest and gives the avatar a state of its own. The same summary, with the same independence, applies to pinned tiles ("Pinned bots", below) and to the phone. A bot with no tasks has an empty summary: "No tasks yet" as its preview, no time, no mark, no dot.

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

- The title (14, muted; `--text` when current, unread or running), which takes the room the other two parts leave.
- The time of the task's last activity (12, faint, tabular), in the same short form as a bot's time: "now", "5:36 PM", "Mon", "Nov 9".
- At most one mark at the right, only when there is something to say: the working mark, the failed mark, or the unread dot. `conversation.md` adds the remaining states.
- A truncated title is available in full: a tooltip on hover and on keyboard focus, touch and hold on the phone, and always at the start of the task's transcript and in Details. The row's accessible name is the title, the time and the state.

**How many.** Tasks are ordered by latest activity. Six are shown; the next row reads "Show all 14", with the total, and becomes "Show fewer". The current task is always among the six. Archived tasks are not listed here.

**New task** creates an empty task under a bot, selects it and focuses the composer. It has four entry points, and each is shown only when the connection may write:

| Entry point                                                           | Where                                                                                  | Serves                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| The last row of an unfolded bot's tasks (a plus and the words, faint) | The rail                                                                               | A bot with several tasks                   |
| "New task for <Bot>" in the "+" menu                                  | The top of the rail                                                                    | The open bot, whatever its number of tasks |
| "New task" in a bot's own menu                                        | Right-click, Shift+F10 or the Menu key on its row or tile; touch and hold on the phone | Any bot, open or not                       |
| The shortcut                                                          | ⌘T in the desktop app; ⌥T in a browser, which keeps ⌘T for itself                      | The open bot                               |

A bot with one task shows no task rows, so its routes are the last three. When its second task is created the row becomes a group in place: it unfolds, the new task is its first row and is selected, and the composer has focus. The user never leaves the list to do it. "The rail's menus", below, specifies both menus.

**Pinned bots** are tiles and have no room for rows. Their tasks show in one block directly under the pin grid; "Pinned bots", below, says which bot's.

**One pane (a narrow window).** This is the desktop app in a window too narrow for two panes; the iPhone app has its own route, in section 12. The list is the same. Tapping a bot with one task opens it. Tapping a bot with several tasks unfolds them in place; tapping it again folds them; tapping a task opens it. There is no separate task-list screen, and Back from a conversation ("Back to bots") returns to this list.

**Semantics.** The bot is a `button` with `aria-expanded` when it has several tasks. Its name includes the number of tasks and what the summary shows: "Otto, 14 tasks, working, unread". The task list is a `ul` labelled "Otto's tasks". The current task has `aria-current="true"`. A single-task bot has `aria-current` itself.

### Pinned bots

Pinned bots are a three-column grid of tiles at the top of the list. A tile is a 56 px avatar with the name under it (13, centred, one line), radius 18.

**One task block, one owner.** Tiles have no room for rows, so the grid has a single task block directly under it, and at any moment it belongs to at most one pinned bot, its **owner**. The owner is tracked by itself, apart from the selected bot and from the bots unfolded in the list below. The block is the faint group fill (55% of `--bg-hover`, radius 18) and starts with a label, the owner's avatar at 16 px and its name (13, faint), so its rows are never read as another bot's. After the label come ordinary task rows with the same cap, "Show all" and "New task".

**What a tile shows.** These are independent, and all of them can be true at once:

| The bot is                                            | The tile shows                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Open (its task is in the conversation)                | The `--bg-selected` fill, and `aria-current="true"`                                                                              |
| The block's owner, but not open                       | The faint group fill, the same as the block under the grid                                                                       |
| Running a task, or has a failed one                   | A state mark on the avatar's top-right corner, on a disc of the rail's colour: failed before working, the same priority as a row |
| Holding an unread task (other than the one on screen) | The accent dot beside its name                                                                                                   |
| Idle and read                                         | Nothing but the avatar and the name                                                                                              |

So a pinned bot that is working and has an older unread task shows the mark and the dot together, and a failed one shows the failed mark with or without the dot. Only the owner's tile reports `aria-expanded="true"`; every other tile with several tasks reports `"false"`; a tile for a bot with one task has no `aria-expanded`. A tile's name is the same sentence as a row's: "Otto, 14 tasks, working, unread".

**What happens.**

| Action                                                             | Two panes                                                                                                                   | One pane (the phone)                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Click or tap a pinned bot with one task                            | Its task opens and the tile takes the selection. A block that was following the selection closes; one opened by hand stays. | The same, and the conversation is shown                                                         |
| Click or tap a pinned bot with several tasks that is not the owner | Its remembered task opens (or else its most recent), it becomes the owner, and the block switches to its tasks              | It becomes the owner and the block switches to its tasks. Nothing opens until a task is tapped. |
| Click or tap the owner's tile again                                | The block folds; there is no owner. The selection does not change. Clicking it again unfolds it.                            | The block folds                                                                                 |
| Right on a focused tile, or "Show tasks" in its menu               | That bot becomes the owner without being opened; the conversation does not change                                           | (tapping does this)                                                                             |
| Click or tap a task in the block                                   | That task opens; its bot becomes the selected bot if it was not                                                             | The same, and the conversation is shown                                                         |
| Open a bot from the list below                                     | A block that was following the selection closes; one opened by hand stays, labelled with its owner                          | The same                                                                                        |

"Opened by hand" means unfolded with Right, with the menu, by tapping on the phone, or by clicking an open tile that had been folded. A block opened by hand stays until the user folds it or gives it to another pinned bot, the same rule as a bot unfolded by hand in the list. Because the block has a single owner, two pinned bots' tasks are never shown at once, and no tile can claim to be expanded while its tasks are missing.

### Sections

A small grey word (13, faint, in the user's own casing) with 14 px above and 6 px below. No rule, no caps.

### The rail's menus

**The "+" menu.** The round "+" at the top of the rail is a menu button (`aria-haspopup="menu"`, `aria-expanded`). Its items: "New task for <Bot>", for the open bot, with ⌘T beside it; and "New bot", with ⌘N. With no bot open the first item is absent. On a read-only connection the button itself is absent.

**A bot's menu** opens on right-click on its row or tile, with Shift+F10 or the Menu key while the row has focus, and with touch and hold on the phone. Its items: "New task" (when the connection may write); "Show tasks" or "Hide tasks" (a bot with several tasks); "Pin" or "Unpin".

Both are `.menu` surfaces, 232 px wide, `--bg-raised` with `--shadow-pop`, radius 14, items 34 px (44 on touch), role `menu` with `menuitem`s. A menu opens with focus on its first item. Up and Down move, wrapping; Home and End go to the ends; Enter or Space chooses. Escape closes it and returns focus to the "+" or to the row; Tab or a click outside closes it.

### Footer and the gateway menu

One row: a status dot, the gateway's name (14/500) with its state under it (12, faint). The dot is `--accent-line` when connected, `--warn` and pulsing while connecting or reconnecting, `--danger` when the gateway cannot be reached. The row reports the gateway's presence and nothing else. It always agrees with the status strip about the connection (section 11); a task that failed to sync is the strip's news, and leaves this dot green because the gateway is connected.

The row is a menu button. It opens the **gateway menu**, which replaces the shell's theme and disconnect icon buttons until Settings exists:

| Part       | Content                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| Head       | The gateway's name; under it the state, the address and, when known, the gateway's version |
| Theme      | Three radio items: "Match the system", "Light", "Dark". The current one has a check.       |
| Disconnect | One item in `--danger`. It disconnects and returns to the connection screen.               |

- Surface: `.menu`, 256 px, `--bg-raised` with `--shadow-pop`, radius 14, items 34 px (44 on touch). It opens upward from the row. In the one-pane layout it opens downward from the round button at the top left, which carries the same status dot.
- Keyboard: Enter, Space, Up or Down on either trigger (the footer row, or the round button in the one-pane layout) opens it and puts focus on the checked theme. Inside, Up and Down move between items, wrapping; Home and End go to the ends; Enter or Space chooses. Escape closes it and returns focus to the trigger that opened it; Tab or a click outside closes it.
- Roles: `menu`, with `menuitemradio` for the themes and `menuitem` for Disconnect; the row has `aria-haspopup="menu"` and `aria-expanded`. The row's accessible name carries the state: "Home gateway, connected. Open the gateway menu."

## 8. The conversation

### Header

No bar. Three things float over the top of the transcript in a 56 px band:

- **Title pill**, centred: a small identifier, not a toolbar. 36 px tall, at most 240 px wide, `--bg-raised` with `--shadow-raised`. A 22 px avatar, the bot's name (14/500), a middle dot, then the task's title (14, muted), which truncates. In the one-pane layout it is the avatar and the name only. It opens the Work pane. Its accessible name is always complete: "Otto, Disk almost full on the media box. Show details." With no task selected it is the bot alone, and the name says so.
- **Work pane button**, top right: a round icon button, pressed while the pane is open. ⌘\ toggles it.
- **Back**, top left: shown only in the one-pane layout.

**The protected top band.** The floating controls have one band of their own: 56 px for the pill and the buttons, then 42 px (`--strip-band`) for the status strip, 98 px in all. The transcript's first line starts below both, so nothing is ever under them at rest. Text scrolling up fades out before it reaches the pill; while the status strip is showing, no text is visible at the strip's height or above it (section 11 gives the exact rule). The band is always reserved, so the transcript does not reflow when the strip appears or leaves.

### The task's name

The first line of every transcript is the task's title in full (14/500, centred, balanced over up to two lines). It is where the task is named on the phone, where the pill has no room for it. It is the conversation's heading: an `h1`, the only one on the screen, as the shell's title is today.

### Messages

- **Your messages** are right-aligned bubbles in `--bubble-user`, at most 78% of the column or 560 px.
- **The bot's messages** are left-aligned bubbles in `--bg-bubble`, at most 86% of the column or 640 px. Markdown renders inside: headings at 15/600, lists, tables with row rules and plain medium-weight headers, inline code on `--bg-code`, code blocks on `--bg-pane` with radius 10.
- Bubbles have one radius, 18 px, on every corner. There are no tails.
- 4 px between bubbles from one sender, 16 px when the sender changes.
- **No name, avatar or time beside a message.** A message's exact time is its tooltip, and is in its long-press menu on touch.
- **Stamps**: a centred line (12, faint) before the first message and wherever more than ten minutes pass between messages or the day changes: `Today 5:36 PM`, `Yesterday 9:02 AM`, `Mon, Nov 9 2:14 PM`.
- **Event lines**: something the bot did that is not a message is one quiet line (13, faint), aligned with the text inside the bubbles. A line about one of your own messages ("Sends when reconnected") is aligned to the right, under that bubble. The shell's system messages are event lines, centred.

### The bot's work, for now

Until the conversation components are built, the shell's own inspector is kept, and folded. Nothing it shows today is lost.

- Each run of consecutive thoughts and tool calls in a turn becomes one `details.steps`, closed by default. Its summary is an event line that counts what is inside: "Thought, used 2 tools", "Used 1 tool", "Thought".
- Opened, it shows the shell's rows in their original order inside one card (`--bg-bubble`, radius 18, the width of a bot's bubble). Each row is 32 px with a chevron and is itself a `details.step`:
  - a thought reads "Thought" and its first line, and opens to the full reasoning;
  - a tool call shows the tool's name on `--bg-code`, the one-line summary of its arguments, and its state at the right ("done", "failed" in `--danger`, "no result"), and opens to the full arguments and the result or the error, each in a code block on `--bg-pane` under a small label.
- Kept exactly: the order of blocks, the full reasoning, the full argument text, the result text (with "(empty)" for an empty one), the error and missing-result states, system messages, and live output, which is a bubble that grows.

`conversation.md` replaces the folded group with action cards, one plain-words line per action or per fold of one kind, shown without opening anything (its section 7); the per-call detail they open to is this one.

### Jump to latest

The shell's `.jump-latest` keeps its behaviour: new output is followed only when the reader is within 96 px of the end; otherwise their place holds and the control appears. It is a pill centred 10 px above the foot of the transcript: 36 px, `--bg-raised` with `--shadow-pop`, the words "Jump to latest" and a down arrow. `conversation.md` gives it the states a running turn needs.

### Composer

One pill at the foot of the column, aligned with the bubbles' outer edges: 48 px, radius 24, `--bg-raised` with a `--border-strong` outline; the outline becomes `--accent-line` with a soft halo on focus. Inside: a round "+" on the left (attach), the text, and a round send button on the right. The send button is `--bg-inverse` when it can send and grey when it cannot. Placeholder: "Message <Bot>".

**May this connection write?** One question decides the composer's form and every "New" control: do the scopes the gateway granted include writing, and does the host offer the command? When the answer is no, the composer is the read-only pill and nothing that creates is shown. Today the answer is always no: the client asks for `operator.read` only and the bridge has no command for sending or for creating a task (section 14, "What the bridge does not have yet").

**One send operation.** The Send button, Enter, and anything added later call the same operation, and it starts with the same guard: a task is open, the connection may write, and the draft has text that is not blank. The button is enabled exactly when the guard passes. When it fails, nothing changes: no bubble, no cleared draft, no moved focus.

| State                                          | The composer                                                                                                                                              | Send button     | Enter                                                                                                                                                                                                                                                         | Shift+Enter |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Task open, connected, draft has text           | The pill                                                                                                                                                  | Enabled         | Sends; the draft clears; focus stays in the field                                                                                                                                                                                                             | New line    |
| Task open, connected, draft empty or blank     | The pill                                                                                                                                                  | Disabled (grey) | Nothing                                                                                                                                                                                                                                                       | New line    |
| Reconnecting or offline, draft has text        | The pill; placeholder "Offline. Messages send when you reconnect."                                                                                        | Enabled         | The message is accepted: it appears right-aligned in the raised fill (`--bg-bubble`, `--text`), not yet in your colour, with "Sends when reconnected" under it. It is sent once when the connection returns and takes `--bubble-user` then. The draft clears. | New line    |
| Reconnecting or offline, draft empty or blank  | The same                                                                                                                                                  | Disabled        | Nothing                                                                                                                                                                                                                                                       | New line    |
| A composition is in progress (an input method) | The pill                                                                                                                                                  | As above        | Confirms the composition; never sends                                                                                                                                                                                                                         |             |
| The connection may only read                   | The pill filled with `--bg-bubble`, no field and no buttons: an eye icon and "This device can read but not send. Ask the gateway owner for write access." | None            | Nothing to type into                                                                                                                                                                                                                                          |             |
| No task is selected                            | No composer. There is nothing to send to.                                                                                                                 | None            |                                                                                                                                                                                                                                                               |             |

Sending while offline follows the parity list (a message sent offline is marked and is sent exactly once when the connection returns). It needs the host to hold the message. Until the host can, connection is added to the guard instead: offline, the button is disabled, Enter does nothing, the draft stays in the field, and the placeholder reads "Offline. You can keep writing." In both forms Enter and the button never differ. `conversation.md` adds the states a running turn needs (stop, queue, steer) on top of this guard.

### Empty, loading and failed

Where the transcript has no task line, the state's title is the screen's `h1`.

- **No task selected**: the bot's avatar at 64 px, "Pick a task", "Choose one of <Bot>'s tasks, or start a new one.", and the actions right there: "New task" (primary), and in the one-pane layout "Choose a task", which returns to the list. On a read-only connection the sentence is "Choose one of <Bot>'s tasks to read the conversation." and there is no "New task".
- **A bot with no tasks**: its row is selectable like any other. The conversation shows the avatar, "No tasks yet" and "Start a task and <Bot> will take it from there." with "New task"; read-only, "Conversations with <Bot> will be listed here." and no button.
- **No bots**: the rail's list holds a short note in place of rows ("No bots", "Bots appear here once the gateway has one."; while the gateway's bots are loading, "Loading bots" with `aria-busy`). The conversation shows "No bots to show" and "This gateway has no bots yet.", or "Loading" and "Loading this gateway's bots." There is no title pill and no Work pane button, since there is no bot for them to describe. A failed load is the status strip's last row (section 11). When the gateway's list of tasks was cut short, "Showing the most recent tasks only." is the last line of the rail's list, after the last bot.
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

| Tab               | Empty title       | Sentence                                                       |
| ----------------- | ----------------- | -------------------------------------------------------------- |
| Files             | No files yet      | Files <Bot> reads or writes in this task appear here.          |
| Computer          | No screen to show | When <Bot> uses a browser or a desktop, you can watch it here. |
| Details, routines | (no title)        | None yet. Ask <Bot> to do something on a schedule.             |

**Drawer and docked.** Below a 960 px main pane it is a drawer: over the right edge, 360 px or the width less 56 px, radius 18 on its left corners, `--shadow-pop`, with the shell's `.drawer-scrim` over everything behind it. In the one-pane layout it is a full-width sheet. At 960 px and above it is docked, with the window's one hairline on its left edge.

|                | Drawer or sheet                                                       | Docked                                         |
| -------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| Role           | `dialog`, `aria-modal="true"`, labelled "Work"                        | `complementary` (the `aside`, labelled "Work") |
| Focus on open  | Moves to Close                                                        | Stays where it was                             |
| Tab            | Stays inside the pane                                                 | Follows the page                               |
| Behind it      | Inert: not focusable, not clickable, hidden from assistive technology | Live                                           |
| Closing        | Close, Escape, a click on the scrim, ⌘\                               | Close, ⌘\                                      |
| Focus on close | Returns to the control that opened it                                 | Unchanged                                      |

Crossing the docking width while the pane is open switches between the two without closing it, and focus is never left on something that has just become inert:

| The open pane becomes          | Focus                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| A drawer (the window narrowed) | If focus is outside the pane it moves to Close; if it is inside, it stays. The rail and the conversation become inert. |
| Docked (the window widened)    | Stays where it is. The rail and the conversation stop being inert and the dialog role is removed.                      |

Whether the pane is a drawer is decided in one place, from the width of `.main-pane` (below 960 px), for the layout and for this behaviour alike. The buttons keep the shell's names: "Show work panel" and "Hide work panel" on the toggle, "Close work panel" on Close and on the scrim.

**Tabs.** A tab list with one tab stop. Left and Right move to the next tab and select it, wrapping; Home and End go to the ends. Each tab controls a tab panel that is labelled by it and can take focus.

Opening or closing the pane keeps the reader's place (section 6).

## 10. Connection and pairing screens

One centred column, 360 px wide, on the bare stage. No card, no border, no shadow, no gradient.

**The mark** is the product's own: `packages/ui/src/assets/logo-mark.png`, the file `pnpm brand:icons` derives from the logo. It is shown at 56 px with a 16 px radius above the name on Connect, and alone above the title on Pairing. It is never redrawn. These are the only places the mark appears inside the app.

**Connect** (`connect.html`):

- The mark, the name (28/600), the slogan (15, muted).
- Two pill fields, 48 px, `--bg-inset`, placeholders as labels: "Gateway address" and "Gateway token, for pairing". Each has a visually hidden label.
- A primary button, full width: "Connect". While connecting it reads "Connecting…" and is disabled: `--bg-bubble` with `--text-faint`, never a faded primary.
- Under it a quiet button: "Use the development gateway", shown only when that gateway is present.
- One hint (13, faint): "Clawtrate works with an OpenClaw gateway you already run. It asks for read access only."
- A failure appears between the fields and the buttons on `--danger-soft`: a medium-weight title ("Could not connect", or "Enter the gateway's address") and one sentence with the reason and what to check.

**Pairing** (`pairing.html`):

- The mark, then "Approve this device" (22/600) and one sentence: "<Gateway> has not seen this device before. Approve it once on the gateway's machine and Clawtrate connects by itself."
- The command to run, in one `--bg-inset` block with a copy button named "Copy approve command". One command, not a list of steps. The command is the one the host supplies for this gateway, and when the host also supplies a note about where to run it, the note is one line above the block (13, muted). The design never writes a command of its own; the one in the prototype is a fixture.
- **Copy says what happened.** The shell's `CommandLine` behaviour is kept as it is. When the clipboard took the command, the button becomes a check for 1.5 seconds and the live region under the block (`.copy-status`) says "Copied." When it could not (no clipboard, as over plain http, or permission refused), nothing claims success: the command's text is selected, the button stays a copy button, and the region says "Selected. Press ⌘C to copy." (Ctrl+C off the Mac), which stays as long as the selection does.
- "Waiting for approval, checking again in 4s" with a pulsing `--warn` dot, in a live region; the count is the host's own retry time. After "Check now" finds nothing it reads "Not approved yet, checking again in 5s".
- What the device asks for, in plain words, as a chip: "Read bots, tasks and conversations". One chip per scope requested.
- A default button "Check now" ("Checking…" and disabled while it checks) and a quiet button "Use another gateway".
- A footer line (12, faint) with the request id and the device id, for support.

**The bots.** A row of creatures from all three families stands along the foot of both screens, cropped by the bottom edge, at different sizes and tilts. They are decoration: `aria-hidden`, not interactive, and they do not move. They are in the page's flow, after the form with 24 px between, so they can never sit over it; when the form is tall, the page scrolls and they follow it. Below 640 px of height they are not shown at all, so the command, the waiting line and the way out always fit by themselves.

## 11. The status strip

The shell stays mounted with its cached content when the connection drops. One compact pill, the shell's `.status-strip`, reports it.

**Where it sits.** The strip belongs to the conversation. It is rendered inside `.conversation`, centred on the conversation's width, directly under the title pill: from 54 to 88 px below the conversation's top edge, 34 px tall, and at most the conversation's width less 24 px. Because it is placed in the conversation and not in the main pane, it is under the title pill at every width, and beside a docked Work pane it stays inside the conversation's 600 px or more: it can never reach the Work pane or be covered by it. It overlays the transcript, so nothing shifts when it appears or leaves. When Work is a drawer, the scrim covers the strip with the rest of the conversation and its action is inert with it; closing the drawer gives it back.

**Where transcript text may appear.** While the strip shows, the transcript is masked from the conversation's top edge: fully transparent down to 90 px (the strip's foot plus a 2 px gap), then fading in over 8 px, fully visible from 98 px. No part of a message is visible at the strip's height or above it, to its left and right included. Without the strip, text fades out under the title pill as section 8 describes. At rest the first line starts at 98 px in both cases, so the mask only ever hides text that the reader has scrolled up.

| State                                       | The strip's dot   | Words                                                                                                      | Action                       | In the app, it comes from                                                                                      |
| ------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Reconnecting                                | `--warn`, pulsing | **Reconnecting in 4s** · showing saved messages ("Reconnecting…" when there is no countdown)               | Retry now                    | The connection is reconnecting or connecting while the shell is mounted; the seconds are the host's retry time |
| Cannot reach the gateway                    | `--danger`        | **Can't reach <gateway>** · the host's error message when it gives one, otherwise "showing saved messages" | Retry now                    | The connection is in its error state                                                                           |
| Connected, fetching what was missed         | `--warn`, pulsing | **Connected** · catching up                                                                                | none                         | The connection has returned and the gateway's bots and tasks are loading again                                 |
| Caught up                                   | `--accent-line`   | **Synced** (with "· 3 new in this task" only when the count is known)                                      | none; leaves after 4 seconds | That load finishing. Shown only after a drop, never on first load.                                             |
| The open task failed to sync                | `--danger`        | **Couldn't sync this task**                                                                                | Try again                    | After a drop, the open task's transcript failed to reload and its saved messages are still shown               |
| The gateway's bots and tasks failed to load | `--danger`        | The gateway's message, or "Could not load this gateway's bots and tasks."                                  | Retry now                    | Discovery failed while connected                                                                               |

- **The strip's dot is the strip's own.** It takes the tone of the row above, not the gateway's presence. The rail's footer dot is the gateway's presence. The two agree whenever the news is about the connection (the first four rows). In the fifth row they differ on purpose: the gateway is connected, so the footer is green, and one task failed, so the strip is red.
- The first part of each line is the state and always shows in full, with the action. The part after the middle dot is an explanation in `--text-muted`; it is the only part that shortens, and on a narrow column it shortens to nothing. The whole line is the strip's tooltip.
- The strip has `role="status"`. Retry now and Try again are ordinary buttons, 26 px tall; on touch the strip keeps its size and the button's hit area grows to 44 px.
- One state drives the strip, the footer's dot and words, and the composer, so they cannot disagree: while the strip says reconnecting, the footer says "Reconnecting…" and the composer's placeholder is the offline one (section 8).
- A failed refresh that did not follow a drop is not the strip's: the conversation shows its own line above the saved messages (section 8). The two are never shown together.
- Nothing in the conversation unmounts on reconnect, and anything the user had opened stays open. When synced items land below the fold, the reader's place holds and Jump to latest offers them.

## 12. Compact and phone layouts

**Drawer widths (below 1240).** Described in sections 6 and 9. The rail narrows to 248 px below 900.

**One pane (a window narrower than 688).** The rail is the list and the main pane is the detail.

- The list fills the width. The footer row is replaced by a round button at the top left: the Settings icon with the connection dot on it, which opens the gateway menu. Search and New stay top right.
- Rows are 68 px with 44 px avatars; task rows are 44 px; text is one step larger (17 px names and messages).
- Tasks unfold in place, as in section 7. A pinned tile with several tasks gives the pin grid's one block to its bot when tapped and folds it when tapped again; the block's label says whose tasks they are (section 7, "Pinned bots").
- A bot's menu opens with touch and hold. "+" opens the same menu as on the desktop.
- In the conversation, Back ("Back to bots") is a round button at the top left and the Work pane button stays at the top right. The title pill between them is the avatar and the bot's name; the task is named at the start of the transcript and in Details.
- The Work pane is a full-width sheet with the same frame, and is modal.
- The composer keeps its form; its buttons are 40 px.
- The connection screens keep their column; the bots are scaled to 60%, and are hidden on a short screen.

**The iPhone app** is built in React Native and does not use this CSS. The sizes and tokens above are its specification, and `[data-input="touch"]` in the prototype shows them. Its navigation is its own, three screens deep:

| Screen            | Shows                                                                                       | Back goes to        |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| Home              | The bots: pinned tiles, then rows. Rows do not unfold; a row is the bot's summary.          |                     |
| A bot's task list | The bot's avatar and name, its task rows at touch sizes (title, time, mark), and "New task" | Home                |
| A task's chat     | The conversation                                                                            | The bot's task list |

Tapping a bot opens its task list, tapping a task opens its chat, Back returns to the task list, and Back again returns to Home. This holds for every bot, whatever its number of tasks. The narrow desktop window keeps the single unfolding list described above, because there the rail and its tasks are one pane.

## 13. Accessibility

**Contrast**, measured against every surface each colour is used on, with translucent fills composited over their real parents:

| Text                 | Light, lowest | Dark, lowest | Where the lowest is                                                         |
| -------------------- | ------------- | ------------ | --------------------------------------------------------------------------- |
| `--text`             | 13.9:1        | 11.2:1       | The selected task inside an unfolded bot (light); a soft accent fill (dark) |
| `--text-muted`       | 5.4:1         | 6.1:1        | The selected task inside an unfolded bot (light)                            |
| `--text-faint`       | 4.5:1         | 4.7:1        | The selected task inside an unfolded bot (light)                            |
| `--accent` as text   | 4.6:1         | 7.9:1        | The same                                                                    |
| `--warn` as text     | 4.6:1         | 6.7:1        | A selected rail row; see the restriction below                              |
| `--danger` as text   | 5.0:1         | 5.5:1        |                                                                             |
| Text in your bubbles | 6.2:1         | 10.2:1       |                                                                             |
| Disabled button text | 5.4:1         | 6.2:1        | `--text-faint` on `--bg-bubble`                                             |

**One surface has a restriction.** The selected task's fill inside an unfolded bot is the darkest light surface (`#dededd` once its two fills are composited over the rail). On it `--warn` reaches only 4.4:1 in light theme, so warn-coloured text is never placed there: the current task's title is `--text`, and a task's state is a mark, not a word. `--accent-line` is for marks only (3.1:1 at worst in light); it is never text. In light theme `--text-faint` and `--text-muted` are close in value by necessity, so hierarchy between them comes from size and position.

Text fading under the floating controls and anything behind the drawer's scrim is deliberately concealed and is outside these figures.

**Focus.** Every control shows a 2 px `--accent-line` outline, 2 px out, on keyboard focus. Fields show the same as a ring.

**Keyboard.**

| Where          | Keys                                                                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anywhere       | ⌘\ toggles the Work pane. ⌘K search, ⌘N new bot, ⌘T new task for the open bot (⌥T in a browser), ⌘I focus the composer. The "new" shortcuts do nothing on a read-only connection.                                                                              |
| Rail           | Tab reaches every row. Up and Down move between rows; Home and End go to the ends. Right unfolds a bot (for a pinned tile, gives it the task block), Left folds it; Left on a task goes to its bot. Enter opens. Shift+F10 or the Menu key opens a bot's menu. |
| Menus          | The gateway menu opens from its trigger with Enter, Space, Up or Down. In any menu, Up and Down move, Home and End go to the ends, Enter or Space chooses, Escape closes and returns focus to the trigger. Section 7.                                          |
| Work pane tabs | Left, Right, Home, End.                                                                                                                                                                                                                                        |
| Drawer         | Focus is kept inside. Escape closes it.                                                                                                                                                                                                                        |
| Composer       | Enter does what the Send button would do, and nothing when the button is disabled; Shift+Enter adds a line. Section 8 lists every state.                                                                                                                       |

Tab order follows reading order: rail top, bots and tasks, footer, conversation header, transcript, composer, Work pane.

**Names.** Round buttons have `aria-label`s that say what they do. A bot row's name includes its number of tasks and its summary. The transcript is a focusable region so it can be scrolled from the keyboard.

**Motion.** This part of the design moves very little: a pulsing status dot, the loading bubbles and the working mark's arc. All stop when motion is reduced, whether by the system setting or by the app's own (`data-motion="reduce"` on the root, which the stylesheet honours the same way); the dot's colour, the mark's shape and the words beside them carry the state.

**Targets.** 32 px round buttons with at least 8 px between them on desktop; 40 px and larger on touch, with rows at 44 px or more.

## 14. Change list for the builder

Written against the shell as it is in `packages/ui/src/`: `App.tsx`, `Shell.tsx` (`Rail`, `TaskList`, `WorkPanel`, `StatusStrip`, `useMediaQuery`, `useSelection`, `Shell`), `Conversation.tsx` (`ReasoningStep`, `ToolStep`, `Blocks`, `Turn`, `TranscriptView`, `Placeholder`, `Conversation`), `ConnectScreen.tsx` (`CommandLine`, `Countdown`, `PairingPanel`, `ConnectForm`), `Avatar.tsx`, `icons.tsx`, `preferences.ts`, `clipboard.ts`, `styles/tokens.css` and `styles/app.css`; and against the tests in `e2e/preview.spec.ts` and `packages/ui/test/`.

`prototype/css/app.css` is in the order of these steps. In each step, take the named sections of that file together with the markup change, and delete the old rules the step lists. The stylesheet is never replaced in one go.

**Each step leaves a working, coherent app.** A component's markup, its styles, the layout rules that depend on it and the tests that describe it change in the same step. After every step: `pnpm typecheck` and `pnpm test` pass, `pnpm e2e` passes with the test changes that step lists, and the app has been looked at in both themes at 1440, 1240, 1100, 800 and 390 px wide. "Keep" below means a test passes unchanged and still means what it meant.

**What the shell does well stays.** The raw tool-call inspector (full arguments, result, error and missing-result states), the empty and discovery states, the drawer's focus handling, the follow-and-jump behaviour of the transcript, the copy fallback over plain http, and the shell staying mounted through a reconnect are all kept. The steps restyle and move them; none is rebuilt.

### What the bridge does not have yet

The prototype runs on local fixtures and can send, create and pin. The app cannot yet: `packages/core/src/bridge.ts` has `connect`, `connectDevGateway`, `disconnect`, `retry`, `openSession` and `closeSession`, and the client asks for `operator.read` only. The restyle does not add commands, does not ask for more scope, and shows no control that would do nothing. One function, `canWrite(connection)`, answers "may this connection write?" (section 8); it returns false until a flow adds sending, and everything below marked "not rendered" is behind it or behind its own missing data.

| The design has                                                                                                 | It needs                                                                              | In this restyle                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The composer pill, Enter and Send, sending while offline                                                       | A send command, a write scope, and for the offline case a host that holds the message | Not built. The composer is always its read-only form, with the shell's sentence: "Read-only connection. Sending messages arrives in a later version." The other read-only sentence in section 8 is for a later connection that could write but was not granted it.                                                                         |
| New task: the row, the "+" item, the bot's menu item, the shortcut, the button in the empty states             | A command that creates a task                                                         | Not rendered. The empty states use their read-only sentences.                                                                                                                                                                                                                                                                              |
| "+" (new bot) and Search                                                                                       | Their own flows                                                                       | Not rendered. With neither button, `.rail-top` in the two-pane layout is only the drag band: 12 px tall, or the height the window controls need on the macOS desktop app. In the one-pane layout it still holds the gateway button.                                                                                                        |
| Pinned bots, sections, Pin and Unpin                                                                           | Pins and sections from the gateway                                                    | Not rendered, and their rules (`.pin*`, `.rail-section`) are not taken. Section 7 is the specification for the flow that adds them.                                                                                                                                                                                                        |
| A bot's menu                                                                                                   | Nothing new                                                                           | Built with the one item that has a source, "Show tasks" or "Hide tasks". A bot with one task has no items, so no menu opens.                                                                                                                                                                                                               |
| Strip: "Connected · catching up" and "Synced"                                                                  | Nothing new                                                                           | Built from state the shell already has: after the strip has shown a connection problem, `connection.status` returning to `connected` while `discovery.status` is `loading` is "catching up"; its change to `ready` shows "Synced" for 4 seconds. No count is shown, since nothing reports one. No timer invents a state.                   |
| Strip: "Couldn't sync this task" with "Try again"; the conversation's "Couldn't refresh" line with "Try again" | A way to reload one task                                                              | Built. The state is the open task's `transcript.status` being `error` while it still has items: the strip when that follows a connection problem, the line otherwise. "Try again" sends `closeSession` and then `openSession` for that task, which reloads its transcript today. If that proves unreliable, it sends the existing `retry`. |
| Strip: every other row                                                                                         | Nothing new                                                                           | Built. "Retry now" sends the existing `retry`, as it does today.                                                                                                                                                                                                                                                                           |
| Work pane facts                                                                                                | Nothing new                                                                           | Model is `bot.model` (the row is omitted when it is null); last activity is `task.updatedAt`. "Runs on" and the routines group are omitted. Files and Computer show their empty states.                                                                                                                                                    |
| The gateway menu's theme choice                                                                                | An explicit setter in `preferences.ts`                                                | Built in step 4.                                                                                                                                                                                                                                                                                                                           |
| Which bots are unfolded, by hand                                                                               | Nothing new                                                                           | Built with `readPreference` and `writePreference`.                                                                                                                                                                                                                                                                                         |
| Creatures as avatars                                                                                           | Nothing new                                                                           | Built: Clawlings, Shellfolk and Lanterns (section 5). A bot whose gateway identity has its own image shows the image.                                                                                                                                                                                                                      |

### What moves where

| Now                                                                                                                                                                                                                                                                                                                             | After                                                                                                                                                                                                                                                                          | Step                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `.shell` grid: rail, task list, main pane                                                                                                                                                                                                                                                                                       | `.shell` grid: rail, main pane                                                                                                                                                                                                                                                 | 4                        |
| `Rail`: `.brand` (mark and name), `.rail-section` "Bots", `.bot` (avatar with emoji badge, name, theme, count)                                                                                                                                                                                                                  | `Rail`: `.rail-top`, `.bot-group` holding `.bot` (avatar, name and time, preview and unread), `.bot-toggle`, `.task-list`                                                                                                                                                      | 4                        |
| `TaskList`: `section.list-pane`, its `.pane-header`, `.task` with `.task-top`, `.task-preview`, `.task-status`; its three empty states; `.list-note`                                                                                                                                                                            | Removed. Its rows become one-line `.task` buttons inside the rail's `.bot-group`; its empty states move to the rail and the conversation; `.list-note` becomes the last line of `.bot-list`.                                                                                   | 4                        |
| `.rail-tooltip` for bot names in the compact rail (below 980 px)                                                                                                                                                                                                                                                                | `.rail-tooltip` for a truncated task title, at any width                                                                                                                                                                                                                       | 4                        |
| `.rail-footer`: `.gateway-pill` (`role="status"`), a theme button that cycles, a disconnect button                                                                                                                                                                                                                              | `.rail-footer`: `.gateway-pill` as a menu button; `.gateway-menu` with three theme radios and Disconnect                                                                                                                                                                       | 4                        |
| The window is one pane below 760 px, with a 64 px icon rail below 980 px                                                                                                                                                                                                                                                        | One pane below 688 px of `.app`; the rail is 248 px below 900 px and is never icons only                                                                                                                                                                                       | 4                        |
| `.main-pane`: a one-column grid and an unnamed inline-size container, holding `StatusStrip`, `Conversation`, `.drawer-scrim`, `WorkPanel`                                                                                                                                                                                       | `.main-pane`: a flex row and the container `main`, holding `Conversation`, `.drawer-scrim`, `WorkPanel`                                                                                                                                                                        | 5 (the strip moves in 6) |
| Work is a drawer below a 1320 px window: a media query in CSS and `OVERLAY_QUERY` with `useMediaQuery` in `Shell.tsx`                                                                                                                                                                                                           | Work is a drawer below a 960 px main pane: a container query in CSS and one measurement of `.main-pane` in `Shell.tsx`                                                                                                                                                         | 5                        |
| `WorkPanel`: `.pane-header` with a title and Close, one `.work-empty` paragraph                                                                                                                                                                                                                                                 | `.work-close`, `.work-hero`, `.tabs`, `.work-sections` with three tab panels                                                                                                                                                                                                   | 5                        |
| `Conversation` header: `.pane-header.conversation-header` with `.back-button` ("Back to tasks"), `.conversation-title` (an `h1` and a meta line), the panel button                                                                                                                                                              | `.conversation-header` with `.header-side` (Back, "Back to bots"), `.title-pill`, `.header-side` (panel button). The `h1` becomes `.task-line`, the first line of the transcript.                                                                                              | 4 (the label), 6         |
| `StatusStrip`: `.status-strip`, already absolutely positioned, a child of `.main-pane` and centred on it; a tinted pill with one sentence                                                                                                                                                                                       | The same element as the first child of `.conversation`, centred on it; a neutral pill with its own dot and a two-part line; `data-strip` on `.conversation`                                                                                                                    | 6                        |
| `.transcript-wrap` > `.transcript` > `.transcript-inner` > `article.turn` (gutter with avatar, meta with author and time, body)                                                                                                                                                                                                 | The same three wrappers > `h1.task-line`, `.stamp`, and one `div.turn[data-role]` for each item, holding `.msg` > `.bubble` and `details.steps`                                                                                                                                | 6                        |
| `div.steps` holding always-visible `details.step` rows (`ReasoningStep`, `ToolStep`)                                                                                                                                                                                                                                            | `details.steps` (closed) > `summary.event-line` and `.steps-list` holding the same `details.step` rows, unchanged in content                                                                                                                                                   | 6                        |
| `.system-row`                                                                                                                                                                                                                                                                                                                   | `.event-line[data-side="center"]`                                                                                                                                                                                                                                              | 6                        |
| `.jump-latest`                                                                                                                                                                                                                                                                                                                  | The same element, restyled                                                                                                                                                                                                                                                     | 6                        |
| `footer.read-only-bar`, always shown                                                                                                                                                                                                                                                                                            | `footer.composer[data-readonly]`, shown when a task is selected                                                                                                                                                                                                                | 6                        |
| `ConnectScreen`: `.connect-card` holding `.connect-brand` (mark, `h1`, slogan), a `.panel` card and `.connect-foot`. `PairingPanel`: `ol.pair-steps` of three steps, with the one `CommandLine` in the second and the countdown in the third. `ConnectForm`: the development-gateway button, a `.divider`, two labelled fields. | `.connect-card` with a bare `.panel`. Pairing: the same one `CommandLine` (`.command` and `.copy-status`), `.waiting` with the same countdown, `.scopes`, the two buttons. Connect: two pill fields, Connect, then the development-gateway button. `.ensemble` after the card. | 7                        |

Test ids stay on the element that takes over each role: `bot-list`, `bot`, `task-list` (one for each unfolded bot), `task`, `rail-tooltip`, `status-strip`, `transcript`, `transcript-turn` (on `.turn`, one for each item, as now), `live-turn` (on the live `.turn`), `tool-call` (on its `details.step`, as now), `jump-latest`, `work-panel`. Accessible names that tests use stay too: "Show work panel", "Hide work panel", "Close work panel", "Copy approve command", "Use the development gateway", and a bot's name beginning "<Name>, N tasks".

### Steps

1. **Fonts.** Add `@fontsource-variable/figtree` at 5.3.0 to `packages/ui/package.json` and import it in `src/index.ts`. Leave the Instrument packages until step 8. Nothing looks different yet. Tests: no change.

2. **Tokens.** In `styles/tokens.css`, replace the colour, type, radius and shadow values with those in `prototype/css/tokens.css` and add the new tokens. Keep the shell's three theme selectors; both dark blocks get the same values.
   - Do not change the four layout sizes yet. `--rail-width` (228px), `--list-width` (312px), `--panel-width` (320px) and `--header-height` (52px) keep their old values, because the old three-column rules are still in place: with a 280 px rail beside the 312 px task column the conversation would fall under 440 px in windows narrower than about 1030 px, and with a 360 px docked pane in windows narrower than about 1390 px. Each changes in the step that rebuilds its pane (4, 5 and 6).
   - `--bg-list` is written as a literal, the rail's value, not as `var(--bg-rail)`.
   - The app now runs its old rules on the new values: Figtree, neutral greys, rounder corners, slightly larger text, the same layout.
   - `packages/ui/test/contrast.test.ts`: keep. It reads `tokens.css` and parses only hex and `rgba()` literals, which is why `--bg-list` stays a literal. It passes on the new values: the lowest results are 4.79:1 for `--text-faint` and 5.68:1 for `--text-muted` in light, 4.72:1 and 6.17:1 in dark, all on `--bg-selected`. Add `bg-bubble` to its `SURFACES`, and add the one case it cannot see today, `--bg-selected` over the open group's fill over the rail (section 13), where light `--text-faint` is 4.53:1. Its 12 px check keeps.
   - e2e: keep everything. The width test still passes because the layout sizes did not move.

3. **Base, controls, avatars and every caller of `Avatar`.** Take "Base", "Controls" and "Avatars", and from "Motion" the `[data-motion="reduce"]` rule, so the reduced-motion setting works from the first step that could animate.
   - `App.tsx`: wrap what it returns in `<div className="app">`, the container that the later layout rules query. Set `data-input="touch"` on the root element when the primary pointer is coarse, and `data-motion="reduce"` when the user asks for it in the app, beside `data-theme`.
   - `icons.tsx`: stroke 1.6; add search, plus, settings, x, arrow-up, file and screen from `prototype/js/icons.js`.
   - `Avatar.tsx`: draw a character (body, colour, tilt and look, as in `prototype/js/icons.js`) from a stable hash of the bot's id; show `avatarUrl` cropped to a circle when the bot has one; remove the emoji fallback, the emoji badge and the `badge` prop; delete `.avatar-emoji`. In the same step change every caller: `Rail` (`<Avatar bot={bot} badge />` loses `badge`), `TaskList`'s header, and the two in `Conversation.tsx`. The old layout stays; only what an avatar looks like changes.
   - `tools/dev-gateway`: stop generating pattern images for the seed bots (`avatars.ts`, and `--avatar` in `cli.ts`), so the development preview shows characters. This takes effect when the development gateway is next reset; until then the seed bots show their existing images in circles, which is the rule for a bot with an image.
   - Tests: no change. `packages/core/test/mapping.test.ts` still passes, because `emoji` stays in the core's `Bot`.

4. **Rail and tasks, with the one-pane and compact layouts.** This is the step that removes the task column, so the rules that decide how many panes there are move with it.
   - Take "Shell" (the two-column grid), "State marks", "Rail" without the `.pin*` rules, the Motion section's `orbit` and `ping`, and from "Compact layouts" the rail's width below 900 px, the whole one-pane block for `.app` below 688 px that concerns `.shell`, `.rail`, `.rail-top`, `.back-button` and the gateway button, and the `[data-input="touch"]` rules for `.bot`, `.task`, `.bot-toggle` and `.menu-item`.
   - Delete in the same step: the `max-width: 979px` block (the icon rail), the `max-width: 759px` block (the old one-pane switch), `.brand`, `.brand-name`, `.bot-theme`, `.bot-count`, `.list-pane` and the `.pane-title` rules only it used, `.task-top`, `.task-preview`, `.task-status`, `.run-node` inside the task list, and the `.task[aria-current]::before` bar. Move the macOS window-controls padding from `.brand` to `.rail-top`.
   - Tokens: `--rail-width` becomes 280px. Delete `--list-width` and `--bg-list`.
   - `Rail`: remove the brand row and the "Bots" heading; add `.rail-top`. Render each bot as a `.bot-group` as in `prototype/js/app.js` (`renderRail`, `taskRows`): the row, the fold control, and its `.task-list` when unfolded, ending in "Show all N". A task row keeps its `.task-time` from `shortTime(task.updatedAt)`, between the title and the mark. A bot with one task or none is a plain row. Keep `botLabel` and extend it with the summary: "Otto, 3 tasks, working, unread".
   - `TaskList`: delete it. Its states move, none is dropped. No bots: a note in `.bot-list` and the conversation's "No bots to show" state, with "Loading this gateway's bots." while `discovery.status` is `loading` (section 8). A bot with no tasks: a selectable plain row whose preview is "No tasks yet", and the conversation's "No tasks yet" state. `discovery.partial`: `.list-note` as the last line of `.bot-list`. Discovery errors stay in the status strip. The once-a-minute clock that refreshes relative times moves to `Rail`.
   - `useSelection`: selecting a task under any visible bot must be one operation. Replace `selectTask(key)`, which is bound to the current bot, with `selectTask(botId, key)`: mark the task being left as read, set the bot, store the task as that bot's remembered task, and persist both. `selectBot(id)` becomes "select that bot's remembered task, or else its first"; for a bot with no tasks it selects the bot alone. Keep `taskByBot`: it is the remembered task and it wins over the most recent. Exactly the selected task's session stays open on the host, as now. Add the set of bots unfolded by hand and whether the open bot was folded by hand, both persisted. Compute a bot's summary (latest activity, any unread by `isUnread`, failed before running) from all of its tasks; it must accept an empty list.
   - `Shell`: selecting a bot no longer sets `view` to `"list"`. In the one-pane layout a bot with several tasks unfolds in place, and selecting a task, or a bot with one task, sets `view` to `"detail"`. Change Back's label and title to "Back to bots" here, since the list it returns to is now the rail.
   - Footer: make `.gateway-pill` a menu button named "<gateway>, connected. Open the gateway menu." (the state word follows `statusLabel`), and add the gateway menu (section 7) with the gateway's details in its head, the three theme items and Disconnect, which sends the existing `disconnect`. Remove the two icon buttons.
   - `preferences.ts`: `useTheme` returns the choice and a setter that takes a `ThemeChoice`, in place of the cycle function. Choosing "Match the system" stores no theme and removes `data-theme`, so the existing CSS that follows the OS applies; "Light" and "Dark" store and set it. `?theme=` still overrides. The radios never call a cycle.
   - `.rail-tooltip`: show it for a task whose title is truncated (`scrollWidth` greater than `clientWidth`), on hover and on keyboard focus, at any width. Drop the `max-width: 979px` test in `showTip`.
   - After this step the app is two columns with the old conversation and the old Work pane in the second. Work still docks at 1320 px by the old rules, where the conversation is 720 px. At phone width the rail is the list and Back returns to it.
   - Tests: the table below, rows 1, 2, 3 and 5. `contrast.test.ts`: remove `bg-list` from `SURFACES`.

5. **Main pane and Work pane.** Take "Shell" (`.main-pane`) and "Work pane", with the `[data-input="touch"]` and one-pane rules for `.work-panel`, `.tab` and `.work-close`.
   - Tokens: `--panel-width` becomes 360px.
   - CSS: `.main-pane` becomes a flex row and the container `main`; the order of its children does not change. Delete the `min-width: 1320px` and `max-width: 1319px` blocks; the `@container main (min-width: 960px)` rule replaces them.
   - **One test for "is Work a drawer", in CSS and in code.** Delete `OVERLAY_QUERY` and `useMediaQuery`. In their place measure `.main-pane` with a `ResizeObserver` and set `overlay` to "narrower than 960 px", from one constant that the stylesheet's comment names. `drawerOpen` stays `panelOpen && overlay`. A window media query would be wrong twice: between 1240 and 1319 px the pane would look docked and behave as a drawer, and it cannot follow a shell that is narrower than its window.
   - **Adapt the existing focus effect; do not add a second one.** The effect on `drawerOpen` with `closeRef`, `toggleRef` and `drawerWasOpen` stays the only place that moves focus. Two changes: when `drawerOpen` becomes true, move focus to Close only if focus is not already inside the pane (this covers opening the drawer and narrowing the window with the pane open); when `drawerOpen` becomes false, return focus to the toggle only if the pane closed, not if it merely docked.
   - Add what the drawer lacks: Tab and Shift+Tab wrap inside the pane while `drawerOpen`, in the existing key handler; `inert` on `.rail` while `drawerOpen`, as `Conversation` already has; `role="dialog"` and `aria-modal="true"` on the `aside` while `drawerOpen`. Escape closes the drawer only: test `drawerOpen` where the handler tests `panelOpen`.
   - `WorkPanel`: replace the header and the placeholder paragraph with `.work-close` (it keeps `closeRef`, its label and its `tabIndex`), `.work-hero`, the tab list and three tab panels (section 9). It needs the bot and the task.
   - The reader's place: `TranscriptView` already follows new output at the end. Add one `ResizeObserver` on the scroller that, when its width changes, puts a reader who was at the end back at the end and otherwise restores the first visible item to where it was (`holdPlace` in `prototype/js/app.js`).
   - After this step Work docks from a 1240 px window and is a modal drawer below it, over the old conversation.
   - Tests: the table below, rows 3 and 4, and the three additions under it.

6. **Conversation.** Take "Conversation", "Markdown", "Composer", "Empty and loading states" and "Status strip", with the conversation's rules from "Compact layouts" and the `[data-input="touch"]` rules for `.bubble`, `.composer-input` and `.title-pill`.
   - Tokens: `--header-height` becomes 56px.
   - Header: replace `.conversation-title` with the `.title-pill`; wrap Back and the panel button in `.header-side`; drop the `.pane-header` class. The title pill opens the Work pane. With no bot there is no pill and no panel button.
   - `StatusStrip`: keep the component, its `role`, its test id, its half-second clock and "Retry now". Render it as the first child of `.conversation` (pass it to `Conversation` as a node), so it is centred on the conversation at every width. Give it its own dot, the two-part line (`.status-strip-text` with the explanation in a `span`) and the states of section 11, derived as "What the bridge does not have yet" says. The reconnecting line keeps its countdown, "Reconnecting in 4s", for `reconnecting` and for `connecting` alike. Set `data-strip="true"` on `.conversation` while it shows.
   - `TranscriptView`: keep `.transcript-wrap`, the scroller, `NEAR_BOTTOM_PX`, the follow logic and `.jump-latest`. Add `h1.task-line` first. Keep one wrapper for each item, `div.turn[data-role]` with `data-testid="transcript-turn"`; it loses its gutter, author and time and holds the item's bubbles and folded work in order. Each text block is a `.msg[data-role]` with a `.bubble` (`.md` for the bot). Insert `.stamp` rows by the ten-minute rule from `item.timestamp`; a message's exact time moves to its bubble's `title`. System items become centred event lines. The live turn keeps `data-testid="live-turn"` and is a `.turn` whose bubble holds the live text, or "Thinking".
   - `Blocks`, `ReasoningStep`, `ToolStep`: keep all three and what each row contains. Only the group changes: the `div.steps` that wraps a run of steps becomes `details.steps`, closed, with a `summary.event-line` that counts its contents ("Thought, used 2 tools") and a `.steps-list` holding the same rows in the same order. Take the prototype's rules for `.steps`, `.steps-list`, `.step`, `.step-chevron`, `.step-kind`, `.step-tool-name`, `.step-summary`, `.step-reasoning-preview`, `.step-state`, `.step-body`, `.code-label` and `.code-block` in place of the old ones. Full arguments, the result or error, "no result", and "(empty)" all remain reachable.
   - `Placeholder` and the loading branch: the states in section 8. The title is the `h1` when there is no task line. A transcript in `error` with items keeps its items under the "Couldn't refresh" line (or under the strip's "Couldn't sync this task" after a connection problem).
   - Footer: replace `.read-only-bar` with `footer.composer[data-readonly]`, and render it only when a task is selected.
   - Delete: `.pane-header`, `.conversation-title`, `.turn-gutter`, `.turn-main`, `.turn-meta`, `.turn-author`, `.turn-time`, `.turn-body`, `.user-mark`, `.system-row`, `.live-text`, `.read-only-bar`, the old `.steps` and `.step*` rules that the prototype's replace, the old tinted `.status-strip` rules, and the `@container (max-width: 620px)` block.
   - Tests: the table below, rows 1, 6 and 7, and the strip additions under it.

7. **Connection screens.** Take "Connection and pairing screens".
   - Keep, unchanged in behaviour: `CommandLine` with `copyText` and `selectContents` and its two messages; `Countdown`; the host's `pairing.approveCommand` and `pairing.approveNote`; the error's code, message and hint; the development-gateway button and its hint; the device and version line.
   - `PairingPanel`: remove the `ol.pair-steps` wrapper and its three headings. Order: the title, the sentence, the host's note when there is one, the `CommandLine`, the waiting line with its countdown, one chip for each of `pairing.requestedScopes` in plain words (an unknown scope shows its id), "Check now", "Use another gateway". The request id joins the foot line.
   - `ConnectForm`: the two fields become pill fields with visually hidden labels; "Connect" is the primary button and "Use the development gateway" the quiet one under it. Keep `h2#connect-title`, "Connect to your gateway", as the section's label, visually hidden: a test below relies on that heading belonging to the connection screen only.
   - Brand: on Connect, the mark (`alt=""`), the `h1` and the slogan. On Pairing, the mark alone with `alt` set to the product name, since no visible name accompanies it.
   - Add the row of characters after the card, and its short-screen rule.
   - Delete `.divider`, `.pair-steps`, `.pair-step`, `.pair-marker`, `.field-label`, `.request-id`, `.run-node`.
   - Tests: the table below, row 1, and the mark's check moved here from row 5.

8. **Clean up.** Nothing visible changes. Remove `@fontsource-variable/instrument-sans` and `@fontsource/instrument-serif` and their imports; delete `--font-display` and `--stage-glow` and any rule left without a user; remove the sun, moon and plug icons if nothing uses them. Update the Brand section of `docs/decisions.md`: one typeface and its licence, the neutral palette, where the accent is used, and where the mark appears.

9. **Final check**, at 1440, 1240, 1100, 800 and 390 px, in both themes:
   - selecting a bot opens its remembered task; folding and unfolding do not change the selection; a folded bot still shows unread and running work;
   - the six-row cap and "Show all"; the arrow keys in the rail; the gateway menu from the keyboard, opening with Up and with Down;
   - Work docks at a 960 px main pane (a 1240 px window) and is a drawer at 1239 px; it is modal only as a drawer; narrowing the window with it open moves focus to Close; the reader's place holds when it is toggled after scrolling;
   - the status strip is centred on the conversation and its action can be clicked beside a docked Work pane at 1240 px; no transcript text is visible at its height; the strip, the footer and the composer agree in every connection state;
   - no control is shown that does nothing: no "+", no Search, no "New task", no Pin;
   - the connection screens at 320 × 568 px, and the copy button with and without a clipboard;
   - reduced motion from the system and from `data-motion`.

### What each existing test means afterwards

`e2e/preview.spec.ts`, in file order. The step is where the change is made.

| #   | Test                                                                                      | Verdict                            | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|     | The `openTask` helper: click the bot, click the task, expect an `h1` named after the task | **Change** (step 4)                | Clicking the open bot's row now folds its tasks, so the helper must not click blindly. Click the bot only when its `aria-expanded` is not `"true"` and it is not a single-task row that is already current; then click the task inside that bot's `.bot-group`. Find the bot by its accessible name (`^Otto,`), not by its text, because a row now also contains a preview line. A bot with one task shows no task rows: clicking the bot is the whole action. The `h1` expectation keeps, because the task line is the `h1` (it passes against the old header until step 6 and against `.task-line` after it).                                                                                                                                                                                                                                                                                                                                  |
| 1   | "pairs with the development gateway and shows bots, tasks and a transcript"               | **Keep**, with three lines changed | Keep: the product-name heading, the host's command `pnpm dev-gateway approve` in `.panel .command code` and the absence of an unqualified command, the copy assertion with its two accepted messages, four bots in the order Juniper, Marlow, Otto, Pip (the design keeps the gateway's order), Otto's three tasks in their order (still by latest activity), four `transcript-turn`s with their text, three `tool-call`s. Change (step 4): scope the three-task count to Otto's `task-list`. Change (step 4): `getByRole("status")` containing "Connected" no longer exists, since the footer is a menu button; replace it with the button whose name matches `/, connected\. Open the gateway menu\.$/` and its dot's `data-status="connected"`. Change (step 6): before clicking the `read` call's summary, open the `details.steps` that contains it; the two content assertions then keep, and prove the raw arguments and result survived. |
| 2   | "a task stays read after it was opened"                                                   | **Keep**                           | It passes through the changed helper. After the reload, replace the bare click on Otto with the helper's "unfold if needed": Otto is restored as the open bot and is already unfolded, and a click would fold it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | "the conversation keeps its width and the work panel becomes a drawer"                    | **Keep, numbers changed**          | Keep the 440 px floor at 1440, 1100 and 800 px and the Escape that closes the drawer (the test is at 800 px there). Add (step 5): at 1240 px the pane is docked and the conversation is at least 600 px; at 1239 px it is a drawer. Change (step 4): the one-pane part moves from 700 px to 600 px, because the switch is now below 688 px; the button is "Back to bots"; `task-list` visible, `.conversation` hidden, and the `h1` after choosing a task all keep. Add: at 688 px both panes are visible and the conversation is at least 440 px.                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | "the overlay drawer takes keyboard focus and gives it back"                               | **Keep**                           | 1100 px is still a drawer and 1440 px is still docked, and every assertion keeps: focus to "Close work panel", six Tabs that never land in the conversation or on something covered, Escape returning focus to "Show work panel", docked opening leaving focus on "Hide work panel". Change (step 5): the last line presses Escape to tidy up while docked, where Escape no longer closes; click "Hide work panel" instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | "the compact rail names every bot"                                                        | **Replace** (step 4)               | There is no compact icon rail. Keep its first half as "the rail names every bot" at 800 px: the four names matching `^<Name>, \d+ tasks?` still pass, and the names are now also visible text. Replace the Marlow tooltip with the tooltip's new job: at 1100 px, where the rail is 280 px, focus Otto's task "Disk almost full on the media box", which is truncated beside its time, and expect `rail-tooltip` to hold its full title; focus "Weekly backup check", which fits, and expect no tooltip. If a font change makes the first title fit, add one long-titled task to a seed bot other than Otto in `tools/dev-gateway` and use that. Move the mark's check (step 7): `getByRole("img", { name: "Clawtrate" })` is asserted on the pairing screen in test 1, since the rail no longer shows the mark.                                                                                                                                 |
| 6   | "a streamed reply does not pull a reader away from older messages"                        | **Keep**                           | `transcript`, `transcript-turn`, `live-turn` and `jump-latest` keep their ids and behaviour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7   | "a dropped connection keeps the shell and shows one status strip"                         | **Keep**                           | The strip still contains "Reconnecting in Ns" for the injected `reconnecting` and `connecting` states, the four turns stay, and the rail does not move. Its last assertion, that no "Connect to your gateway" heading is present, keeps its meaning only because step 7 keeps that heading on the connection screen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Additions, each in the step that makes it true:

- Step 4: at 600 px, tapping a bot with several tasks unfolds it without leaving the list; tapping a task opens the conversation; "Back to bots" returns with the bot still unfolded. Folding the open bot leaves the conversation's `h1` unchanged.
- Step 4: the gateway menu opens with ArrowUp and with ArrowDown from its button with focus on the checked theme; choosing "Dark" sets `data-theme="dark"` and survives a reload; "Match the system" removes it.
- Step 5: while the drawer is open the pane has `role="dialog"` and `.rail` is inert; Tab from the last control in the pane returns to its first. With the pane open and docked at 1440 px and focus in the conversation, resizing to 1100 px moves focus to "Close work panel"; resizing back leaves the pane open, removes the role, and does not move focus.
- Step 6: with the bridge proxy's `reconnecting` state and Work open at 1240 px, the strip's centre is within 1 px of the conversation's centre, and the element at the centre of "Retry now" is that button. With the transcript scrolled, the transcript's computed mask is transparent down to the strip's foot.
- Step 6: opening a tool call's group and then the call shows "Arguments" and "Result"; a call with an error shows "failed" and "Error".
