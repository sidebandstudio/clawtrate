# Conversation components

How a running turn looks, moves and reads. This is the second part of the design; `visual-language.md` is the first and defines the tokens, type, surfaces, the rail and the plain transcript this builds on.

The behaviour these components must have is set out in the teardown's design proposals (`docs/research/grok-bot-flows.md`, sections 4.1, 5.6, 6.1, 6.2 and 8.8) and checked by `docs/parity.md`. This document decides appearance, wording, motion and input, and for every control it shows it says what the control does, how it is reached from the keyboard and what it is called. Parity ids are given beside each requirement. Section 22 says what each part starts from in the shell as it is built and what the builder changes there. Section 23 lists the parity rows whose wording has to change and why.

One rule sits above the rest: **no label claims more than the gateway has reported.** A card says "Sent" when an event says the message was accepted, not when the call started. An approval's outcome says the command can run, not that it ran. While the connection is down, nothing on screen looks live.

The prototype shows all of it: `prototype/gallery.html` has every component in every state, and `prototype/conversation.html` plays one scripted turn inside the shell. The styles are in `prototype/css/conversation.css` and the markup in `prototype/js/components.js`, one function per component.

## Contents

1. How the pieces fit
2. Shared rules: tokens, motion, input, announcements
3. What the connection may do
4. The state avatar
5. The status line
6. Streaming text and message captions
7. The activity block
8. Steps
9. Raw: what the gateway sent
10. The Messaged card
11. The Messaged T3 Code card
12. Approval cards
13. Question cards
14. While a bot waits on you
15. The composer during a run
16. Stop
17. Turn errors and notes
18. Following and Jump to latest
19. After a reconnect
20. Rows in the rail
21. What the gateway's events drive
22. Building on the shell as built
23. Where this goes beyond the proposals, and the parity rows to reword
24. Not covered here

## 1. How the pieces fit

A turn in the transcript, top to bottom, in the order things arrive:

```
your bubble
  progress bubble            what the bot says as it goes
  activity line              "Working · 3 steps", opens into the steps
  Messaged card              one per message to another bot or to T3 Code
  approval or question card  when the bot needs you
  reply bubble               streams in
  status line                the avatar and a phrase; always last, leaves when the run ends
```

Calm by default: a finished turn is bubbles and a few one-line cards. Complete on demand: every line opens in place, and every step and every card, of every kind, can show what the gateway actually sent (section 9).

Everything that opens does so in place and grows downward. Nothing above an opened element moves. Folded content uses the browser's own disclosure (`details` and `summary`), so each has a keyboard path and find-in-page reaches folded text.

## 2. Shared rules

### Tokens

This part adds no colour tokens. It uses the set in `visual-language.md`. The tokens it is the first to use:

| Token            | Value                                                    | Use                                                                              |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `--warn-line`    | `rgba(147,86,0,.32)` light, `rgba(240,180,90,.42)` dark  | Outline of a pending approval card                                               |
| `--danger-line`  | `rgba(179,38,30,.3)` light, `rgba(255,138,128,.42)` dark | Reserved for a failure outline; fills use `--danger-soft`                        |
| `--dur-quick`    | 120ms                                                    | Chevrons turning, opened content fading in                                       |
| `--dur-base`     | 200ms                                                    | A new step, a new phrase, a shelf row, the Jump control, the status line leaving |
| `--dur-settle`   | 420ms                                                    | The nod when a run completes                                                     |
| `--ease-out`     | `cubic-bezier(.2,.8,.2,1)`                               | Everything that happens once                                                     |
| `--ease-in-out`  | `cubic-bezier(.45,0,.2,1)`                               | Loops that go back and forth                                                     |
| `--loop-think`   | 2600ms                                                   | Thinking: one sway                                                               |
| `--loop-work`    | 1200ms                                                   | Working: one orbit of the ring; the bob takes half                               |
| `--loop-shimmer` | 2000ms                                                   | The light across the status phrase                                               |
| `--loop-nudge`   | 2600ms                                                   | Waiting for you: one lean, one ping                                              |
| `--loop-blink`   | 5600ms                                                   | Idle: one blink                                                                  |
| `--loop-caret`   | 1200ms                                                   | The streaming caret's breath                                                     |
| `--tap-min`      | 44px                                                     | Smallest touch hit area                                                          |

### Surfaces

| Thing                                                                           | Surface                                                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Activity line, event lines, notes, the status line                              | None. Text on the stage.                                                                                                               |
| Open activity block, Messaged cards, request cards, shelf rows, the access bar  | `--bg-bubble`, radius 18, at most 640 px wide. Beside a docked Work pane the conversation is 600 px and they take the column's 560 px. |
| Code, what was sent, option lists, the full request, a raw panel, inside a card | `--bg-pane`, radius 10 or 14                                                                                                           |
| Buttons on a card                                                               | `--bg-selected`; the primary stays `--bg-inverse`                                                                                      |
| A pending approval                                                              | The card, plus a 1.5 px `--warn-line` outline                                                                                          |
| A failed turn, a failed step under a folded block                               | `--danger-soft`                                                                                                                        |

Text is never faded with opacity. A message that has not been sent uses the neutral raised fill with `--text` (section 6), not a dimmed version of your bubble.

### Motion

Motion says what state something is in. It never makes anyone wait: no enter animation delays content, nothing is held back to finish a transition, and removed elements go at once except the status line's 200 ms fade.

**Reduced motion** comes two ways, as in the shell: the system setting (`@media (prefers-reduced-motion: reduce)`) and the app's own (`[data-motion="reduce"]` on the root). Every rule for a still form is written under both. Every loop stops and every transition is instant. Each state keeps a still form that says the same thing, listed with each component below. (F-291)

**A lost connection** stops every motion that stands for the gateway's work, whatever the motion setting (section 19).

### Input

- **Pointer.** Hover shows full text for anything truncated, as a tooltip.
- **Touch.** Every hover has a tap or a touch-and-hold equivalent, listed with each component.
- **Keyboard.** Everything that opens is a `summary` or a button with `aria-expanded`: Tab reaches it, Enter or Space opens and closes it. Focus order follows reading order. New content never takes focus. When something that holds focus is replaced (a card resolving, a step finishing), focus moves to the same control in what replaced it, or to the replacement's first control.
- **Shortcuts** are written for the Mac. On Windows and Linux, Ctrl stands for ⌘ and Alt for ⌥. A shortcut that belongs to a card applies while focus is inside that card and wins there over a window-wide shortcut with the same keys; outside the card the window-wide one applies. (F-072)

**Hit areas.** Sizes in this document are what is drawn. On touch, every control's hit area is at least 44 × 44 px, extended invisibly where the drawing is smaller. Desktop row heights are not touch targets and stay compact.

| Control                                          | Drawn, desktop | Drawn, touch      | Hit area, touch |
| ------------------------------------------------ | -------------- | ----------------- | --------------- |
| Copy button                                      | 24 px          | 32 px             | 44 px           |
| Text buttons on a card ("Raw", "Show all")       | 24 px tall     | 28 px tall        | 44 px tall      |
| The Readable and Raw tabs                        | 26 px tall     | 36 px tall        | 44 px tall      |
| Buttons on a request card                        | 36 px          | 48 px, full width | 48 px           |
| Jump to latest                                   | 36 px          | 44 px             | 44 px           |
| Rows that open (steps, cards, the activity line) | 30 to 40 px    | 44 px             | 44 px           |

### State marks

A 12 px mark, used in task rows, beside state words and as the avatar's badge. Shape carries the meaning, so colour is never the only cue.

| Mark             | Shape                                | Colour                                    |
| ---------------- | ------------------------------------ | ----------------------------------------- |
| working, sending | An arc travelling round a faint ring | `--accent-line` (sending: `--text-muted`) |
| waiting          | A solid dot that pings               | `--warn`                                  |
| blocked          | A disc with a bar                    | `--warn`                                  |
| failed           | A disc with an exclamation mark      | `--danger`                                |
| stopped          | A disc with a square                 | `--text-faint`                            |
| done             | A disc with a check                  | `--accent-line`                           |
| check            | A check alone                        | The text colour                           |
| unread           | A dot                                | `--accent-line`                           |
| queued, unknown  | A hollow ring                        | `--text-faint`                            |

The hollow ring means two things, so it never stands alone: the word beside it says which. Reduced motion: the arc holds still at one position; the ping becomes a fixed halo.

### Announcements

The conversation has one polite live region. It speaks changes a sighted reader would notice at a glance and nothing else:

- a run's lifecycle: "Otto is working", "Otto is waiting for you", "Stopping", "Stopped", "Otto finished", "Otto couldn't finish";
- the connection and access: "Reconnecting", "Connected", "Access requested", "You can now send, stop and answer";
- the result of an action the user took: "Copied arguments", "Couldn't copy. The text is selected.", "Queued", "Held until you answer".

It does not speak each phrase, each step or the elapsed time.

## 3. What the connection may do

A gateway grants a connection one of three tiers. The conversation is useful on every one of them, and each feature asks only for the tier it needs.

| Tier        | The conversation shows                                                                                                                                                                                                     | The conversation offers                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read        | The transcript, live work as it happens (the status line, steps, Messaged cards), and Raw for what the gateway sends. The gateway does not send pending approvals or questions on this tier, so they are not shown at all. | Reading, opening, copying. No composer, no Stop, no answers.                                                                                          |
| Interactive | Everything above, and pending approvals and questions                                                                                                                                                                      | Sending, stopping, answering                                                                                                                          |
| Admin       | The same conversation                                                                                                                                                                                                      | Management screens elsewhere: saved permission rules, a bot's own model. Requested the first time such a screen is opened, never by the conversation. |

One function answers "may this connection write?", the shell's `canWrite(connection)`. It is true on the interactive and admin tiers when the host offers the commands, and it decides the composer, Stop, the answers on cards and every "New" control.

**The access bar** takes the composer's place on the read tier. It is a shelf row on `--bg-bubble` at the foot of the column, the composer's width.

| State               | The bar says                                                                                                                                                                                                                                                                                                                    | Actions                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Read-only           | An eye, "**Read-only.** You can follow Otto's work here. Approvals and questions aren't shown on this connection."                                                                                                                                                                                                              | "Request access" (primary) |
| Sending the request | "Asking the gateway…"                                                                                                                                                                                                                                                                                                           | none                       |
| Requested           | "**Waiting for the gateway's owner.** Approve this request on the gateway's machine:", then the command the host supplies in a `--bg-pane` line with a copy button, then "This changes by itself as soon as the owner approves or denies the request, or it expires.", then "Request 7c41d09e" in mono with its own copy button | none                       |
| Denied              | "**The request was denied.** Nothing changed. This device can still read."                                                                                                                                                                                                                                                      | "Request again"            |
| Expired             | "**The request expired** before it was approved."                                                                                                                                                                                                                                                                               | "Request again"            |
| Couldn't ask        | "**Couldn't send the request.**" and the reason                                                                                                                                                                                                                                                                                 | "Try again"                |

The gateway answers a request for more access by a continuous wait (`device.scopes.waitUpgrade`), so the bar needs no countdown and no "Check now". It has no "Cancel request" either: the gateway has no way to withdraw a request it holds, and only the owner's decision or its expiry ends one. While the connection is down the bar keeps its words and offers no action, since asking needs the gateway.

- One request covers sending, stopping and answering. The app makes it when the user chooses "Request access"; it is never made silently, and it never asks for admin.
- The command and the request id come from the host. The design never writes a command of its own.
- While requested, the bar keeps its place and the conversation stays live above it. Leaving the task and coming back shows the same state.
- **When access arrives**, the bar is replaced by the composer without moving the transcript, the status strip says "**Access granted** · you can send, stop and answer" for 4 seconds, and the same words are announced. If focus was in the bar it moves to the composer's field; otherwise it stays where it was. Approvals and questions that were pending arrive as cards under the ordinary rules: they do not take focus, the status line and the rail change to "Waiting for you", and Jump to latest reads "Needs you" when a card is out of view (section 14).

**A wait this device cannot see.** If the gateway reports that a run is waiting while the connection is on the read tier, the status line reads "Waiting for an answer" in `--text-muted` with the blocked badge, and a note sits above it: "Otto is waiting for an approval or an answer. This device can't see it on a read-only connection." with "Request access". Nothing is shown when the gateway does not report the wait.

**A request this device can see but not answer** (a tier or capability short of the one the request needs) is a card with the title and summary, the tag "Needs approval", no buttons, and one line: "You can read this request but not answer it from this device." with "Request access". Its full request and Raw still open.

**Keyboard and names.** The bar is a `region` named "Access". Its buttons are ordinary buttons in reading order; the copy buttons are named "Copy approve command" and "Copy request id". Nothing in it has a shortcut.

Where a gateway offers no way to step up at all, the bar says "**Read-only.** This gateway does not let this device send." and has no button.

## 4. The state avatar

The avatar is the first signal. Three layers say the state, so that no single one has to be seen:

- **The face** (characters only): where the eyes look and how the body moves.
- **The ring**: an arc that travels round the avatar while a tool is running. 1.5 px, 4 px outside the avatar, `--accent-line` on a faint track.
- **The badge**: a state mark at the top right, with a 2 px halo in the surface colour, for the states that need you or went wrong.

| State           | Entered when                                                                        | Eyes                             | Motion                                      | Ring          | Badge                                | Still form                                |
| --------------- | ----------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------- | ------------- | ------------------------------------ | ----------------------------------------- |
| idle            | No active run in any of the bot's tasks                                             | Round, looking the bot's own way | A blink every 5.6 s, staggered between bots | none          | none                                 | Eyes open                                 |
| thinking        | A run is active and no tool step is running                                         | Turned up                        | Sways 4° each way, 2.6 s                    | none          | none                                 | Eyes turned up                            |
| working         | A tool step is running                                                              | Straight ahead                   | Bobs, 0.6 s each way                        | Orbits, 1.2 s | none                                 | The arc held in place beside the avatar   |
| waiting for you | A card from the bot's runs is pending                                               | Wide, on the viewer              | Leans in: grows to 110% and back, 2.6 s     | none          | waiting, pinging                     | Wide eyes and the badge with a fixed halo |
| blocked         | The gateway or the bot's machine is unreachable, or the run needs a settings change | Half closed                      | None. Slumped 5°                            | none          | blocked                              | The same                                  |
| done            | A run completed and its task has not been opened since                              | Smiling                          | One nod, 420 ms, then still                 | none          | none; the row carries the unread dot | Smiling eyes                              |
| failed          | The latest run failed and its task has not been opened since                        | Half closed                      | None. Slumped 5°                            | none          | failed                               | The same                                  |
| stopped         | The latest run was stopped; until the next run or until the task is opened          | As idle                          | None                                        | none          | stopped                              | The same                                  |

**One order, everywhere.** When several states apply, to one run or across a bot's tasks, the most urgent wins, in this order: waiting for you; failed or blocked; done with failures; working; thinking; done; stopped; idle. Done with failures is the done face with the failed badge. A queued task counts as idle for the avatar. Section 20 uses the same order for the rail and gives its fixtures. When waiting wins while the machine is unreachable, the avatar shows waiting with the blocked badge. (F-086, F-422, F-426)

A bot with its own picture has no face to move. For it the ring also says thinking, as a full ring that breathes between 35% and 100% over 2.6 s (held at 50% under reduced motion), and the badge and ring carry everything else: done is the picture with no ring and no badge, told from idle by the row's unread dot.

Accessible name: the avatar is `role="img"` with the name "<Bot>, <state>", for example "Otto, working". Where it sits inside a control that already speaks the state, it is hidden from assistive technology. (F-020, F-086)

Sizes: 64 px in the Work pane, 56 px pinned, 40 px in the rail, 28 px in the status line, 22 px in the title pill and in a card's live status, 20 px in the Jump control. Below 28 px the ring sits 3 px out.

## 5. The status line

The last thing in a running turn: the bot's avatar at 28 px and one short phrase. No bubble. It is flush left with the bubbles, 10 px below whatever came last.

**Anatomy.** Avatar with state; phrase (14 px, `--text-muted`); elapsed time (12 px, `--text-faint`, tabular, `m:ss`). The whole line is one button, 40 px tall, with a pill hover.

**Lifecycle.**

| Moment                                       | What shows                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| You send                                     | The avatar and the phrase "Thinking" appear at once. The phrase is never empty. (F-081, F-082, F-085)        |
| A step starts                                | Its phrase replaces "Thinking" at once, and the avatar is working. (F-082)                                   |
| Bubbles, cards and steps arrive              | They render above the line. The line stays put. (F-081, F-089)                                               |
| A card is pending                            | "Waiting for you", in `--warn`; the avatar is waiting. (F-292)                                               |
| Stop is pressed                              | "Stopping…"; the avatar is idle; no shimmer. (F-097)                                                         |
| The run reaches completed, stopped or failed | The line is removed: it fades and lifts 4 px over 200 ms. No message says only that the bot is done. (F-089) |

**The phrase.** While a step runs it is that step's running title (section 8). Otherwise it is "Thinking". The gateway's own status phases give it more to say when no step is running:

| Source                                                          | Phrase                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| No step running                                                 | Thinking                                                              |
| A step running                                                  | The step's running title, for example "Reading backup-2026-11-15.log" |
| The gateway is reviewing a command before it runs               | Reviewing a command                                                   |
| A message to another bot, once the gateway says it was accepted | Waiting for Marlow                                                    |
| Status phase preparing a workspace or environment               | Setting up the workspace                                              |
| Status phase preparing context or flushing memory               | Gathering context                                                     |
| Status with a retry                                             | Rate limited. Retrying, attempt 2 of 5                                |
| A pending card                                                  | Waiting for you                                                       |
| A wait reported on a read-only connection                       | Waiting for an answer                                                 |
| Stop pressed                                                    | Stopping…                                                             |
| The machine is unreachable                                      | Can't reach <machine>                                                 |
| The connection is lost                                          | Reconnecting. Last seen <last phrase, lower case>                     |

Phrases are in the user's language, have no bot name in front and no trailing ellipsis except "Stopping…". A phrase the gateway supplies for a tool the app does not know is shown as sent, in English. (F-082, F-083)

**Motion.** A light crosses the phrase while the avatar is thinking or working: a band of `--text` moving over `--text-faint`, left to right, every 2 s. It stops when the state is anything else. A new phrase rises 5 px and fades in over 200 ms; the old one is replaced at once. Reduced motion: plain `--text-muted` text, replaced at once. (F-084, F-291)

**Elapsed time** is the wall-clock time since the run's start as the gateway reported it, so it is right after a reload and on a second device. It is not shown when the gateway gave no start time, and it is hidden, not frozen at a number, while the connection is lost.

**Input.**

- Hover: the full phrase as a tooltip, for when it is truncated. (F-087)
- Click, tap or Enter: opens the activity block and brings the running step into view. With no step yet, it does nothing and says so in its name.
- Accessible name: "Otto, working: Reading backup-2026-11-15.log. Show steps."
- Screen readers hear lifecycle changes through the announcer (section 2), not every phrase.

## 6. Streaming text and message captions

- Reply text streams into its bubble as the gateway emits it. A caret follows the last character: 2 px wide, the height of the text, `--accent-line`, breathing between 100% and 35% over 1.2 s (steady under reduced motion). The bubble has `aria-busy="true"` until the message is complete. Text is never revealed more slowly than it arrives. (F-095, F-433)
- Progress messages the bot writes mid-run are ordinary bubbles. (F-088)

A caption is a 12 px line under a bubble, on the bubble's side:

| Caption                          | Under                                                 | When                                                                                                                        |
| -------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Incomplete                       | A reply                                               | The run failed or was stopped while it streamed. The text stays. (F-433)                                                    |
| Steer                            | Your bubble                                           | The gateway accepted it into a running turn. (F-096)                                                                        |
| Steer · restarted the turn       | Your bubble                                           | The gateway reports that the steer interrupted the turn and restarted it. Never shown on a guess.                           |
| Failed to send · Resend · Delete | Your bubble                                           | The send failed. The first part is `--danger`. "Resend" sends the same text again; "Delete" removes the bubble. (F-075)     |
| Sends when reconnected           | Your bubble, in the neutral raised fill with `--text` | Written while offline and held by the host. It is sent once when the connection returns and takes your colour then. (F-287) |

A message that has not been sent is never drawn in your colour and never dimmed: white on a dimmed accent falls to 2.7:1.

## 7. The activity block

Every run with at least one step has one block, placed where the run's first step began. A run whose only steps are reasoning still has one. (F-090)

**Folded** it is the quiet line from `visual-language.md`: 13 px, `--text-faint`, 30 px tall, with a chevron.

| Run                                 | Line                        |
| ----------------------------------- | --------------------------- |
| Not finished                        | Working · 3 steps           |
| Completed                           | Worked for 1m 12s · 9 steps |
| Completed, every step was reasoning | Thought for 8s              |
| Stopped                             | Stopped after 40s · 4 steps |
| Failed                              | Failed after 12s · 2 steps  |
| Any of these with failed steps      | … · 1 failed, in `--danger` |
| The connection is lost mid-run      | Last seen working · 3 steps |

A run with no step has no block. Durations read `48s`, `1m 12s`, `1h 04m`; a duration the gateway did not report is left out, never shown as zero. (F-090, F-092, F-423)

**Failed steps stay in view.** Under a folded line, each failed step shows as its own row on a `--danger-soft` block, and opens like any step. A failure cannot hide behind a summary. A command that exits with a non-zero code is not a failed step (section 8). (F-092, F-294)

**Open**, the line becomes the head of a card: `--bg-bubble`, radius 18, 640 px at most, listing the steps in order. New steps append while it is open, each rising 4 px over 200 ms. A footer gives the run's model, the effort requested for the task or turn (the gateway does not dependably report the effort a turn actually used, so the footer says "low effort requested", never "used"), and the run id with a copy button named "Copy run id". A value the gateway did not report reads "effort not reported"; nothing is filled in. The same model and effort are the folded line's tooltip. (F-091, F-044)

**What keeps it open or folded.**

- It starts folded.
- Whether it is open is kept while steps arrive, while the reader scrolls away and back, and across switching tasks. (F-429)
- When the run ends, an open block folds once, unless a step inside it is open or keyboard focus is inside it. Opening the list is watching, and watching ends with the run; opening a step is reading, and reading is not interrupted. The reader's place is held as it folds (section 18).
- That fold happens only at the moment the run ends. It is not repeated when history is replayed after a reconnect, and a block the reader opens again afterwards stays open like any other.

**Input.** Click, tap or Enter on the line opens and closes it. It is a `summary` whose name is its text.

## 8. Steps

A step is a tool call, a segment of reasoning the gateway exposes, a message to another bot, a handoff to T3 Code, or an approval that belongs to no tool call. Reasoning arrives as segments ordered among the tool calls, and each segment is its own step, in that order. An approval for a tool call is that step's waiting status, not a second step, so a command that needed approval counts once; the approval's own events stay in that step's Raw. (F-090, F-091)

**Folded**, a step is one row, 34 px (44 on touch): an icon for its kind, a title, a detail in mono, a status at the right, and a chevron. In a column narrower than 560 px the detail moves to a second line under the title; it is never dropped. (F-430)

| Status    | Row                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| running   | The icon is the working mark; the title is `--text`                                                                  |
| done      | Icon `--text-faint`; title `--text-muted`; the status is how long it took                                            |
| failed    | Icon, title and status in `--danger`; the status reads "Failed", "Timed out" or "Aborted"                            |
| waiting   | Icon and status in `--warn`; the status reads "Waiting for you"                                                      |
| not run   | Title `--text-faint`; the status reads "Denied", "Stopped" or "Not run"                                              |
| last seen | While the connection is lost, a running step keeps its title, stops moving, and its status reads "Last seen running" |

**Titles** are plain words, and change tense with the status. For the kinds below the app writes the title from the tool's name and arguments, in the user's language. For any other tool it shows the title the gateway sends, which is fixed English, unchanged.

| Kind                               | Icon             | Running               | Done                                    | Failed                    | Detail                                               |
| ---------------------------------- | ---------------- | --------------------- | --------------------------------------- | ------------------------- | ---------------------------------------------------- |
| Read a file                        | page with lines  | Reading notes.md      | Read notes.md                           | Couldn't read notes.md    | 96 lines                                             |
| Write or edit a file               | pencil           | Writing notes.md      | Wrote notes.md                          | Couldn't write notes.md   | +4 lines                                             |
| List a folder                      | folder           | Looking through logs  | Looked through logs                     | Couldn't open logs        | 9 files                                              |
| Search                             | magnifier        | Searching for "cache" | Searched for "cache"                    | Search failed             | 12 results                                           |
| Open a web page                    | globe            | Opening example.org   | Opened example.org                      | Couldn't open example.org | the page title                                       |
| Run a command                      | terminal         | Running mv            | Ran mv                                  | Couldn't run mv           | the exit code, "exit 0" or "exit 1"                  |
| Run a command, under review        | terminal         | Reviewing mv          |                                         |                           | the path                                             |
| Run a command, awaiting approval   | terminal         | Wants to run mv       |                                         |                           | the path                                             |
| Run a command, denied              | terminal         |                       | Didn't run mv                           |                           | the path                                             |
| Reasoning                          | dot between arcs | Thinking              | Thought                                 |                           | its first line, in the interface face                |
| Message a bot                      | speech           | Messaging Marlow      | Messaged Marlow                         | Couldn't message Marlow   | the card's state, lower case                         |
| Hand off to T3 Code                | code brackets    | Calling T3 Code       | Called T3 Code                          | Couldn't reach T3 Code    | the card's state, lower case                         |
| Save to memory                     | bookmark         | Saving to memory      | Saved to memory                         | Couldn't save to memory   | the first words saved                                |
| Any other tool                     | diamond          | The gateway's title   | The gateway's title                     | The gateway's title       | the first argument                                   |
| A call a rule or the review denied | the tool's icon  |                       | Blocked by policy, or Blocked by review |                           | the call. Status "Not run", shown as failed. (F-334) |

**How a command ended** is said exactly, because the gateway distinguishes these:

| The gateway reports                              | Row                                                                                                                                             | Counted as failed                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Exit code 0                                      | "Ran mv", detail "exit 0", status the duration                                                                                                  | no                                       |
| A non-zero exit code                             | "Ran grep", detail "exit 1" in `--text`, status the duration. The code is shown plainly; it is the command's answer, not a failure of the step. | no                                       |
| The command hit its own time limit               | "mv timed out", status "Timed out", detail "its 120s limit"                                                                                     | yes                                      |
| The run hit its time limit while the command ran | "mv was cut off", status "Aborted", detail "the run's 50m limit"                                                                                | yes; the run ends as failed (section 17) |
| The tool reported an error                       | "Couldn't run mv", status "Failed"                                                                                                              | yes                                      |

**The automatic review.** When the gateway reviews a command before anyone is asked, the step carries the review's record: in progress, approved or denied, with a risk level and a one-line reason once it has decided. It applies to commands only. The review does not itself ask anyone; what happens after it denies is the gateway's, and the interface shows whichever follows.

| Review                                      | The step                                                                                                | Opened, the readable view adds                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| In progress                                 | "Reviewing mv", the working mark                                                                        | "Review: in progress"                                                                                          |
| Approved                                    | The command runs; the row shows nothing extra. Quiet.                                                   | One line in `--text-muted`: "Reviewed automatically: approved. Low risk. Moves one folder inside /srv."        |
| Denied, and the gateway then asks           | The step waits ("Wants to run mv") and the approval card follows (section 12)                           | "Reviewed automatically: not approved. High risk." and the reason; the card's full request shows the same line |
| Denied, and the gateway refuses the command | "Blocked by review", status "Not run", shown as a failed step, so it stays in view under a folded block | "Reviewed automatically: denied. High risk." and the reason, in `--text`; "The command was not run."           |

**Open**, only that step opens. Others keep updating, new ones keep arriving, and nothing above it moves. (F-293) Every step, of every kind, has two views, switched by a tab list at the top (Readable, Raw):

- **Readable.** The inputs as label and value rows, then the result. A running step shows its output as the gateway streams it, with the streaming caret, under "Output so far". (F-432) A step with nothing to add says so in one line ("The gateway sent no result for this step.") and is never an empty box.
- **Raw.** What the gateway sent, as section 9 defines it. (F-093, F-094)

What each kind's readable view holds:

| Kind                | Readable view                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Read                | The file's path; the content                                                                                |
| Write or edit       | The path; what was added and removed                                                                        |
| List                | The folder; the entries                                                                                     |
| Search              | The query and where; the matches                                                                            |
| Web page            | The address and the page title; the extracted text                                                          |
| Command             | The command, the machine, the folder; the review's line; the output; the exit code                          |
| Reasoning           | Its text, 14 px, `--text-muted`, at most 62 characters wide                                                 |
| Message a bot       | Who it was sent to and the card's state; the sent text; "Show the card", which scrolls to its Messaged card |
| Hand off to T3 Code | The target fields and the card's state; the sent text; "Show the card"                                      |
| Memory              | What was saved                                                                                              |
| Other               | The arguments as rows; the result                                                                           |

**Long output** shows eight lines in full and stops there, with "Show all 96 lines" under it. Nothing is drawn half-faded: the eighth line is as readable as the first. Shown in full, the block scrolls inside itself up to 280 px (60% of the height on a phone) and the button reads "Show fewer". The count is the number of lines there really are. Copy always copies all of it.

**Output the gateway cut.** The gateway shortens long results, and where it cuts depends on the path a result took and on its settings, so the app assumes no fixed size. A result is treated as cut when the gateway flags it or when its text ends with the gateway's own truncation marker, which is shown as received. The block then ends with a line on `--warn-soft`. When what was received is plain text, the line gives its real size: "Truncated by the gateway. 7,946 characters were received; the rest was not sent." When it is a structured result, whose text is not a simple prefix of the original, the line says only "Truncated by the gateway. The rest was not sent." "Show all" counts only the lines received, and Copy copies what was received and says so ("Copied what was received").

**Loading.** A step's detail is fetched when it is first opened. While it loads, the body is one line, "Loading this step…", with `aria-busy`. If that fails: "Couldn't load this step." with "Try again". A step rebuilt from history may lack timing; the status then shows nothing where the duration would be, never zero. When the gateway exposes no reasoning there are no Thought steps and nothing else changes.

**Copy** follows section 9. On touch, touch and hold on a step offers "Copy result", which copies exactly the result text the readable view shows, and "Copy raw". (F-093, F-431)

**Keyboard.** Tab moves through the steps in order; Enter or Space opens one. Inside it, Tab goes to the tab list, then the copy buttons, then "Show all". The tab list is one tab stop: Left and Right move between Readable and Raw and select, Home and End go to the ends. Each tab names its panel (`aria-controls`), and each panel is labelled by its tab. A step's name is its title, detail and status: "Read backup-2026-11-15.log, 96 lines, 0.6 seconds".

## 9. Raw: what the gateway sent

Every step and every card has Raw, on the desktop and on the phone. It is one component, so that two builders do not invent two.

**Where it is.**

| On                                                                                                                  | How Raw opens                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A step                                                                                                              | The Raw tab of the step                                                                                                                 |
| A Messaged card, a T3 Code card, an approval (pending or resolved), a question (pending or resolved), a failed turn | A text button "Raw" at the end of the card's actions. It is a disclosure: `aria-expanded`, and the panel is the next thing in the card. |
| An event line ("Message from Pip")                                                                                  | The line is a `summary`; opened, it shows the message and its "Raw" button                                                              |

**What it holds**, top to bottom, on `--bg-pane`:

| Part              | Content                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tool              | The exact tool name, in mono, with a copy button. Only for tool calls.                                                                                             |
| Arguments         | The arguments as received, as formatted JSON                                                                                                                       |
| Result, or Error  | The result as received. An error is on `--danger-soft`. A call still running says "No result yet. This call is still running."                                     |
| Event as received | For reasoning, an approval, a question, an incoming message or a turn error: the event itself, and the resolving event when there is one, each under its own label |
| Timing            | Started, ended, took. Each value has a copy button. A value not reported is "not reported".                                                                        |
| Identifiers       | Whatever the events carry: tool call, item, run, session, and for a card the approval, question or recipient ids. Each has a copy button.                          |

Nothing is invented to fill a part. A step that is not a tool call has no Tool or Arguments part.

Raw is the gateway's own record: the event or the method's result, in the gateway's shape and with the gateway's field names, not the app's model of it. Where the app shows something it sent (the answer to a question, a decision on an approval), the part is labelled as sent and holds the parameters as sent. The prototype's sample panels are marked: a part that follows the gateway's schema says "as the gateway sends it", and any other says it is a sample in the app's own shape. A builder takes field names from the gateway's schema, never from a sample.

For a tool call, the panel ends with a link, "Open in the gateway's action record". The gateway keeps a readable record of tool actions with their time, bot, task, run, call and outcome, including actions that needed no approval; the link opens that record at this call. The record's own screen is not part of this design.

**States.**

| State                    | The panel shows                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                  | "Loading what the gateway sent…", `aria-busy`                                                                                                                           |
| Loaded                   | The parts above                                                                                                                                                         |
| Truncated by the gateway | The parts as received, and under the cut block the truncation line from section 8, with the size received when it is plain text                                         |
| Not available            | One sentence saying why: "The gateway did not keep this event.", "This event is older than the history the gateway returned.", or "Not sent on a read-only connection." |
| Couldn't load            | "Couldn't load what the gateway sent." with "Try again"                                                                                                                 |

**Copy.** Every code block and every value in Timing and Identifiers has a copy button, and each is named for exactly what it copies: "Copy arguments", "Copy result", "Copy tool call id". It copies that text in full, including lines the view has folded, and never anything else.

- When the clipboard took it, the icon becomes a check for 1.4 s and the announcer says "Copied arguments".
- When it did not, the icon becomes a warning for 1.4 s, the text it would have copied is selected, and the announcer says "Couldn't copy. The text is selected." Nothing claims success.

**Keyboard and focus.** "Raw" is a button: Enter or Space opens and closes the panel, and focus stays on the button. The panel follows it in the tab order. Escape with focus inside the panel closes it and returns focus to "Raw". On a phone the panel is the same panel, inside the card, scrolling with the transcript; long blocks scroll inside themselves as in section 8.

## 10. The Messaged card

One card for each message a bot sends to another bot. It sits in the transcript where the message was sent, stays when the activity block is folded, and the same message is also a step in the block. (F-119, F-439)

**Folded**, one line, 40 px (44 on touch): the word "Messaged", the recipient's avatar at 20 px and name, the first line of the message in `--text-muted`, and the state at the right with its mark. In a column narrower than 560 px it is two lines: "Messaged", the recipient and the state on the first; the message's first line on the second. The words "Messaged" and "Message from" are never dropped, and the state word is never shortened. (F-122)

**States.** Each state is something an event established. There is no state for something the gateway does not report.

| State                | Mark and colour     | Established by                                                                                                                                                                                                                                |
| -------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call started         | sending             | The gateway reported the start of the tool call. A start comes before the call is checked or allowed, and it is also reported for a call that is then skipped, so it is never proof that the call was made or that the message was delivered. |
| Waiting for approval | waiting, `--warn`   | A pending approval request names this tool call. The call had already started; it is held until the request is answered. (F-312)                                                                                                              |
| Sent                 | check               | The call returned and its result says the recipient accepted the message                                                                                                                                                                      |
| Working              | working, `--accent` | The result named the recipient's run, and that run's own events show it active                                                                                                                                                                |
| Recipient waiting    | waiting, `--warn`   | That run is waiting on its user: it asked a question, or it needs an approval                                                                                                                                                                 |
| No reply yet         | hollow ring         | That run finished, or the call returned, without a reply. This includes a result that reports a timeout and says the message was sent before the error: the message went, and a reply may still come.                                         |
| Replied              | check, `--accent`   | A reply arrived that an identifier ties to this message                                                                                                                                                                                       |
| Recipient stopped    | stopped             | That run ended as stopped or cancelled without a reply (F-434)                                                                                                                                                                                |
| Recipient failed     | failed, `--danger`  | That run ended as failed. The message was delivered; the failure is the recipient's.                                                                                                                                                          |
| Failed               | failed, `--danger`  | The call returned an error, and nothing in the result says the message was sent                                                                                                                                                               |
| Blocked by policy    | failed, `--danger`  | A messaging policy forbade the call (F-311)                                                                                                                                                                                                   |
| Not sent             | stopped             | The approval was denied or expired; or the call was skipped before it ran, because the run was steered or cancelled; or the sender was stopped and the gateway confirms the call was never made (F-436)                                       |
| Unknown              | hollow ring         | The sender was stopped before the call returned and the gateway cannot say whether it was delivered                                                                                                                                           |

**Transitions.** The card follows this graph, not a list order. The start is the first thing the gateway reports about a call, and there is no second start when a held call resumes.

```
Call started ─► Waiting for approval ─► Call started     (allowed: the same call goes on)
     │                   └────────────► Not sent         (denied or expired)
     ├─► Blocked by policy
     ├─► Not sent                       (skipped before it ran)
     ├─► Sent ─► Working ⇄ Recipient waiting
     │     │        │
     │     └────────┴─► Replied | No reply yet | Recipient stopped | Recipient failed
     ├─► No reply yet                   (a timeout that says the message was sent)
     ├─► Failed                         (an error, with nothing to say it was sent)
     └─► Unknown | Not sent             (the sender was stopped)

No reply yet ─► Replied          only on a reply an identifier ties to this message
Unknown      ─► whatever a later event that names this message establishes
```

- Replied, Recipient stopped, Recipient failed, Failed, Blocked by policy and Not sent are final. Nothing changes a final card.
- Working and Recipient waiting may alternate as the recipient asks and is answered. From either, the recipient's run ending as failed gives Recipient failed, so the sender's card never stays Working after the recipient failed.
- Where the result does not name the recipient's run, the card goes from Sent straight to Replied or No reply yet.
- **A late reply** is attached to its card only when an identifier ties it there. Otherwise the card stays as it was and the reply arrives as an incoming message, "Message from Marlow" (below).
- Two events belong to one card only when the gateway's identifiers say so. A replayed event updates the card it names and never makes a second one; an event older than the card's state is ignored. (F-309, F-435, F-469)

**Open**, in place (F-121):

- **What was sent**: the sender's avatar and name, "sent" and the time the call was issued, then the exact text on a `--bg-pane` inset. Attachments are chips under it. (F-123, F-128)
- **What came back**: one row for the recipient, led by its avatar, then what the state allows:

| State                | The recipient's row and what follows                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting for approval | "This message waits for your approval. Nothing has been sent."                                                                                                                                                         |
| Call started         | "Otto began this call. Nothing yet shows that it was made."                                                                                                                                                            |
| Sent                 | "Marlow received it. No reply yet."                                                                                                                                                                                    |
| Working              | The recipient's state avatar at 22 px, its name and its current phrase on one row, updating as its steps change: "Marlow · Reading the house log". Nothing else: the folded line already says Working. (F-438)         |
| Recipient waiting    | "Marlow asked a question in its own task and is waiting for the answer.", or "Marlow needs your approval in its own task." Either has "Open in Marlow", which goes to that card.                                       |
| No reply yet         | "Marlow's run finished without a reply." or, after a timeout, "The message was sent, and no reply came in time." Then: "A reply that names this message appears here; any other arrives as a message from Marlow."     |
| Replied              | "Marlow replied" and the time, then the reply on an inset                                                                                                                                                              |
| Recipient stopped    | "Marlow's run for this message was stopped before it replied."                                                                                                                                                         |
| Recipient failed     | "Marlow received it, and its run for this message then failed.", then the reason when the gateway gives one                                                                                                            |
| Failed               | "The call failed.", then the error text                                                                                                                                                                                |
| Blocked by policy    | "A messaging rule stopped this: <the rule>. Nothing was sent."                                                                                                                                                         |
| Not sent             | "You denied the approval. Nothing was sent.", "The approval expired. Nothing was sent.", "Otto moved on before making this call. Nothing was sent.", or "Otto was stopped before the call was made. Nothing was sent." |
| Unknown              | "Otto was stopped before the call returned. The gateway cannot say whether Marlow received it."                                                                                                                        |

- **Actions**, in this order, each present only when it can do something:

| Action               | Present when                                                    | Does                                                                                                                                                                        | Name                                                    |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| "Show the approval"  | Waiting for approval                                            | Scrolls to the approval card and focuses it                                                                                                                                 | Show the approval for this message                      |
| "Open in Marlow"     | The result named the recipient's task                           | Selects the recipient's task, scrolled to its "Message from Otto" card, which is open and focused                                                                           | Open this message in Marlow's task                      |
| "Show full exchange" | The two bots have exchanged more than this message in this task | Replaces the two rows above with every message between them in this task, oldest first, read-only. It reads "Show only this message" while open. Focus stays on the button. | Show every message between Otto and Marlow in this task |
| "Raw"                | Always                                                          | Section 9: the send call's name, arguments, result, timing and identifiers                                                                                                  | Raw                                                     |

**Coming back.** "Open in Marlow" records where the reader was. On the receiving card, "Open in Otto" returns there: the sender's task, the transcript at the scroll position it had, the card still open, focus on "Open in Marlow". ⌘[ does the same.

**The receiving side.** The recipient's task starts the run with a "Message from <Bot>" card. It is the same component with the sender in the name slot, and its state is the recipient's own run. (F-120, F-437, F-469)

| State           | Established by                                | Opened                                                                                                                                      |
| --------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Working         | The run is active                             | The sent text and attachments; the recipient's own status line is at the foot of the transcript as usual                                    |
| Waiting for you | The run asked a question or needs an approval | The sent text; "Marlow asked you a question below." or "Marlow needs your approval below.", with "Show the question" or "Show the approval" |
| Replied         | The run produced the reply that was returned  | The sent text, then "Marlow replied" and the reply                                                                                          |
| Completed       | The run finished without a reply              | The sent text; "This run finished without a reply to Otto."                                                                                 |
| Failed          | The run failed                                | The sent text and the reason in one sentence                                                                                                |
| Stopped         | The run was stopped or cancelled              | The sent text; "This run was stopped before it replied."                                                                                    |

Working and Waiting for you may alternate. Completed becomes Replied when a later reply is tied to the message by an identifier. A run that failed or was cancelled maps to Failed or Stopped and stays there. Its actions are "Open in Otto" (present when the sender's task is known) and "Raw".

**Lines that are not cards.**

- A message that no card on screen accounts for (one a bot did not ask for, or a late reply no identifier ties to a card) is an event line, "Message from" with the avatar and name. It opens to the message's text and "Raw".
- A count line, "2 messages with Otto", stands for an exchange that has no card of its own, and opens to that exchange, read-only. The same exchange is never shown as both a card and a count line. (F-120, F-125)

**Input.** Click, tap or Enter on the folded line opens and closes the card; its name is the line in full, "Messaged Marlow: Write a two-line entry for the house log. Replied." Touch and hold offers "Copy message" and "Copy raw". (F-440)

**Elsewhere.** While the recipient works, its avatar in the rail is working and its row says so. (F-126)

## 11. The Messaged T3 Code card

The same component, for work a bot sends to T3 Code. It is drawn only from the bot's own tool events on the gateway. The app never connects to T3 Code and has no setting for it. (F-132, F-138)

**Identity.** The text "T3 Code" and a mark drawn for Clawtrate: code brackets in a 20 px rounded tile on `--bg-inverse`. No third-party logo.

| State                | Mark               | Established by                                                                                                                                                     |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Call started         | sending            | The gateway reported the start of the tool call. That is never proof the call was made. While the call runs the gateway reports nothing more: no progress arrives. |
| Waiting for approval | waiting, `--warn`  | A pending approval request names this tool call. The call is held until the request is answered.                                                                   |
| Call made            | check              | The call returned without an error. That means the call was made, not that the work is finished.                                                                   |
| Delivery unknown     | hollow ring        | The bot was stopped before the call returned and the gateway cannot say whether it was made                                                                        |
| Failed               | failed, `--danger` | The call returned an error (F-314)                                                                                                                                 |
| Not sent             | stopped            | The approval was denied or expired, the call was skipped before it ran, or the bot was stopped and the gateway confirms the call was never made                    |

**Transitions.** Call started, then Call made or Failed. A call that needs approval goes from Call started to Waiting for approval and, when allowed, back to Call started: it is the same call, and no second start is reported. A stop before the call returns leads to Not sent or Delivery unknown. Delivery unknown moves to Call made or Failed only when a later tool event carries an identifier that names this call. Call made, Failed and Not sent are final.

After Call made, a later tool event that names this call (the bot checking on the work) adds its result to the card under its own time; the state stays Call made, because the app cannot tell from a result whether the work is finished. With no such identifier each call is its own card, and nothing is matched by project or thread name. (F-134, F-313, F-441, F-442, F-443, F-470)

**Open:**

- **What was sent**: the exact text from the call's arguments, and under it a chip for each target field the arguments contain (project, thread, branch). A field that is absent has no chip; nothing is filled in.
- **What came back**:

| State                | Text                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call started         | "Otto began this call. Nothing yet shows that it was made, and nothing more is reported until it returns."                                                                  |
| Waiting for approval | "This call waits for your approval. Nothing has been sent."                                                                                                                 |
| Call made            | "The call returned" and the time, then the result text as received. Under it: "This shows the call was made. It does not show that the work is finished."                   |
| Delivery unknown     | "Otto was stopped before the call returned. The gateway cannot say whether T3 Code received it."                                                                            |
| Failed               | "The call failed.", then the error text                                                                                                                                     |
| Not sent             | "You denied the approval. Nothing was sent.", "Otto moved on before making this call. Nothing was sent.", or "Otto was stopped before the call was made. Nothing was sent." |

- **Files**, as chips, only when a result or a gateway attachment carries them. (F-135)
- **"Open thread"**, only when a result carries a link. It is a link named "Open the T3 Code thread in your browser", it opens the system browser when chosen, and nothing is fetched before that. With no link in the result there is no such control. (F-135)
- **"Raw"**: section 9.

**When the bot is stopped** and the card already reads Call made, the card keeps that state and adds a line in medium weight: "The call was made. Work handed to T3 Code may continue there." The stop note says the same. A call that had not returned when the bot was stopped gets no such line: it is Delivery unknown, or Not sent when the gateway confirms it. (F-137, F-470)

Touch and hold offers "Copy sent text" and "Copy raw". (F-444) The Work pane's Coding section lists these cards across the bot's tasks; its rows use this card's folded form. (F-136)

## 12. Approval cards

Approvals appear only on the interactive tier (section 3).

**Who is asking.** Most approvals come from the bot's own run in its own task. One can also come from a helper the bot started, or from a bot that another bot messaged. The card always names who is asking and on whose behalf:

| Raised by                       | Title                                     | Line under the summary                          | Where the card is                                                                                     |
| ------------------------------- | ----------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The task's own bot              | "Otto wants to run a command"             | none                                            | Otto's task                                                                                           |
| A helper the bot started        | "A helper of Otto wants to run a command" | "Asked by a helper Otto started for this task." | Otto's task                                                                                           |
| A bot that another bot messaged | "Marlow wants to run a command"           | "Marlow is working on a message from Otto."     | Marlow's task. In Otto's task the Messaged card reads Recipient waiting and leads there (section 10). |

Stopping the parent run cancels the approvals its helpers and recipients raised, and they close as "Cancelled".

**Pending.** A card with a 1.5 px `--warn-line` outline, the one loud thing in a quiet transcript.

- **Title** (17 px, semibold): "Otto wants to run a command", "Otto wants to message Marlow". The title names the bot and the kind of action. (F-163)
- **Tag**, top right: "Needs approval" on `--warn-soft`.
- **Summary** (15 px): one sentence saying what will happen, with the machine in bold. It says only what the command does.
- **Warnings**, when the gateway gives them, each on its own line in `--warn` with a triangle: "This can't be undone", "This changes sign-in or security settings", "This shares your data outside this chat". (F-171)
- **"Show full request"**: opens an inset with the reason, the exact command in mono with a copy button, label and value rows from the request (runs on, folder, asked by, the gateway's warning about the command when it gives one, and the automatic review's line when there was one), and at its foot, when the cause is known, one line that says why the gateway asked, with the action that goes with it: "Manage settings" when the host's policy or the automatic review asked, and "Edit rule" when one of the user's own rules asked, which needs Clawtrate's rules plugin. Both open Settings, under Permissions, which needs admin access to change; closing it returns to the card with focus on the link. It reads "Hide full request" when open. (F-164, F-170)
- **Buttons**, 36 px, one for each decision the request offers and no other: "Allow once" (primary), "Always allow…" (default) when the request offers a reusable rule, and at the far right "Deny" (quiet), which every request offers. (F-163, F-329)
- **"Raw"**, a text button at the end of the card: the request as the gateway sent it (section 9).
- **A footer line** when the card will expire or came from somewhere other than this conversation: "Expires in 28 minutes; the command is not run if it does." (F-168)

Every request says which decisions it offers, and some commands offer no reusable rule. Then the buttons are "Allow" and "Deny". (F-329)

**Deny is always visible.** It is on the card in every pending state: beside the first buttons, beside the form's buttons while the form is open, while a decision is being sent, after the gateway refused one, and while the outcome of one is unknown. On a phone the buttons stack at full width, 48 px each, and Deny is the last of them in every one of those states.

**"Always allow…"** appears only when the request's own list of allowed decisions includes it. The gateway leaves it out when the bot or the machine is set to always ask, and when it finds nothing reusable to save for the command. It opens a form on an inset under the summary.

The form shows what a request of that kind carries and nothing else. The gateway does not tell the client in advance which rule it will save, and it returns no saved rule when it confirms, so the form never shows one: it says what will be saved in words, no more precisely than the gateway decides it.

For a command, the rows are the request's own fields, and a row whose field is absent is not shown:

| Row     | Shows                                                                                  | The request's field                  |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| Command | The command, in mono, and its arguments as a list when the request gives them          | `command`, `commandArgv`             |
| Folder  | The folder it runs in                                                                  | `cwd`                                |
| Runs on | The gateway's host, or the machine it was sent to                                      | `host`, `nodeId`                     |
| Bot     | The bot that asked                                                                     | `agentId`                            |
| For     | For a request raised by a routine: the routine's name and the command the grant covers | `scope`, when it is a standing grant |

Under the rows, one sentence says what "Always allow" saves for this kind of request:

| Kind of request                  | What is saved                                                                                                                                                                               | The sentence                                                                                                                                                                             | A lifetime                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An ordinary command              | One or more entries on that host's allowlist. The gateway works out what they match from the command: it can be the program with any arguments, or this exact command. They have no expiry. | "The gateway will add this to media-box's allowlist, so Otto is not asked again for commands it matches. The gateway decides what that covers; it can be wider than this exact command." | None. The form has no Lasts row.                                                                                                                                                    |
| A command raised by a routine    | A standing grant for that routine, that command and that folder                                                                                                                             | "The routine Weekly cleanup may run this command without asking."                                                                                                                        | A number of whole days, from 1 to 3650, in a field filled with the request's own default when it gives one. Left empty, the gateway applies its default. There is no shorter grant. |
| Any other request that offers it | Whatever the gateway keeps for that kind                                                                                                                                                    | "The gateway will remember this decision for requests it treats as the same."                                                                                                            | None, unless the request's scope gives one in days                                                                                                                                  |

Then the buttons: "Allow and save" (primary), "Back", and at the far right "Deny". A number of days outside 1 to 3650 shows "Between 1 and 3650 days." under the field and disables "Allow and save" until it is corrected.

After the gateway confirms, the resolved card links to "Saved rules" in Settings, under Permissions. Standing grants are listed and revoked there with the same access that answers approvals; they do not need admin. A host's allowlist is part of that host's configuration, and reading or editing it does need admin, so for an ordinary command the resolved card says which host's allowlist the entry went to and that seeing the list needs admin access.

**A narrower rule is not part of this form.** A rule the user shapes by hand (this exact command only, one bot or all bots, a lifetime for an ordinary command, an "ask" that outranks an allow) is not something the installed gateway saves from an approval. It depends on Clawtrate's rules plugin, and its form is designed with that plugin (section 24).

**What happens to a decision.** Choosing "Allow once", "Allow and save" or "Deny" sends the decision. The card is not marked resolved until the gateway answers, and there are three answers, never two:

| The gateway's answer                                          | The card                                                                                                                                                     | Buttons                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None yet                                                      | "Sending your decision…" in place of the sentence                                                                                                            | The chosen button is disabled and reads "Sending…"; Back is disabled. Deny stays: choosing it sends a second decision, and the gateway keeps whichever it applied first.                                              |
| It applied this decision                                      | The resolved card (below)                                                                                                                                    |                                                                                                                                                                                                                       |
| It refused, with a reason                                     | On `--danger-soft`: "The gateway refused this decision." and its reason, then "The request is still open."                                                   | "Try again", "Allow once instead" when the refused decision was a save, Back, Deny                                                                                                                                    |
| The request was already resolved                              | The resolved card for the decision that won, with who made it when the gateway says: "Denied by another reviewer at 5:25 PM. Your decision was not applied." |                                                                                                                                                                                                                       |
| No answer came: the connection dropped, or the call timed out | On `--warn-soft`: "No answer from the gateway. Your decision may or may not have been applied." It never says the command did not run.                       | "Check again", and Deny. No allow is offered again until the request's state is known. Deny stays because it is safe to send: if the earlier decision was applied, the gateway answers with it and the card shows it. |

In the last case the client asks the gateway for the request's state as soon as it can, and again on "Check again". If the request is resolved, the card shows the winner. If it is still pending, the decision was not applied, and the card returns to its choices. Until one of those is known the card stays as it is.

**When the run has already ended.** A pending approval does not always keep its run open. The card then carries a line under the summary, in medium weight, and it says only what is known:

| The gateway reports              | The line                                                                         | Buttons                                                 |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| The request is still pending     | "Otto's run has ended. This request is still open, and you can still answer it." | Those the request offers                                |
| The request is no longer pending | "Otto's run has ended and this request is closed."                               | None. The card folds to the state the gateway gives it. |

What follows an allow is not stated in advance. The gateway may run the command and pass the result back to the bot's task; whatever it does shows in the transcript when it happens.

**Resolved**, the card folds to one line, 40 px: a tag, the summary, the time, and a chevron. The sentence under it says what the gateway has reported and no more. Allowing a command is not proof that it ran: whether it ran, and how it ended, is on its step.

| Tag                         | When                                                       | Sentence when opened                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed once (`--accent`)   | The gateway confirmed "allow once"                         | Allowed once. The command can run now. Otto will ask again next time. (F-325)                                                                                                                                                                                                                                                                                                 |
| Always allowed (`--accent`) | The gateway confirmed "allow always"                       | Allowed, and saved. The command can run now. Then what was saved, in the form's own words: for an ordinary command, "Added to media-box's allowlist. The gateway decides what it covers. Seeing that list needs admin access."; for a routine's command, "The routine Weekly cleanup may run this command without asking, until Dec 16." Then the link "Saved rules". (F-166) |
| Denied                      | The gateway confirmed the denial                           | Denied. The command was not run. Otto won't do this, and won't ask again until you send another message. (F-165)                                                                                                                                                                                                                                                              |
| Expired                     | It was not answered in time                                | Expired at 5:53 PM without an answer. The command was not run. (F-168)                                                                                                                                                                                                                                                                                                        |
| Closed: the run ended       | The run finished and the request can no longer be answered | The run ended before this was answered. The command was not run. (F-418)                                                                                                                                                                                                                                                                                                      |
| Closed: the run failed      | The run failed first                                       | The run failed before this was answered. The command was not run.                                                                                                                                                                                                                                                                                                             |
| Cancelled                   | You pressed Stop                                           | You stopped the run before answering. The command was not run.                                                                                                                                                                                                                                                                                                                |

Opened, a resolved card also shows the full request and "Raw", which then holds the request and the resolving event. A resolved card is a record of that moment: if what was saved is removed or runs out later, the card does not change, and the next request for that command shows a card again. When the gateway reports that saving replaced an older rule, the sentence adds "It replaced the oldest rule: '…'"; the installed gateway reports no such thing, and the line belongs to Clawtrate's rules plugin. (F-416)

**After it expired.** An expired request cannot be answered again on the installed gateway, so the opened card has no action there. Where Clawtrate's rules plugin is present and offers a rule for future requests, the card has "Always allow next time". It opens that plugin's form, with "Save rule for next time" as its primary button and no Deny, since there is nothing left to refuse. Saving changes future requests only and never runs the expired command; the sentence then reads "Rule saved for next time. Nothing was run." (F-328)

**The permission order.** The gateway decides; the app never works out a verdict of its own, and it never implies that a review or a question happened when none did. There are two things to tell apart: what the installed gateway does by itself for a command, and the order of Clawtrate's own rules, part of which exists only with Clawtrate's rules plugin.

What the installed gateway can do with a command, and what the user sees:

| The gateway's outcome                                                                                                                                               | What the user sees                                                                                                        | What it names                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Its policy refuses the command: the host does not allow commands, or the command is not allowed there                                                               | A failed step, "Blocked by policy", status "Not run". No card; nothing to approve.                                        | What the result says, as given                                                      |
| Its policy allows the command with no request: the host gives full access with asking off, or the command is on the host's allowlist, or a standing grant covers it | An ordinary step that runs. No card and no review line.                                                                   | Nothing, unless the result says what allowed it; then one line in the readable view |
| The automatic review ran and approved it                                                                                                                            | An ordinary step with the quiet review line (section 8)                                                                   | The review's risk level and reason                                                  |
| The automatic review ran and denied it                                                                                                                              | What follows in the events: an approval card if the gateway then asks, or a failed step "Blocked by review" if it refuses | The review's risk level and reason                                                  |
| It asks: the host is set to always ask, or the command is not on the allowlist                                                                                      | An approval card with the decisions the request offers                                                                    | The request's fields                                                                |
| It would ask, and nobody can be asked there                                                                                                                         | A failed step with the gateway's message                                                                                  | The message, as given                                                               |

The order of Clawtrate's rules, strongest first; the first that applies is the one shown. The last column says what each row needs:

| #   | Rule                                                          | What the user sees                                                                                                                           | Needs                                                                                                                                              |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A denial configured on the gateway                            | A failed step, "Blocked by policy". "Decided by: the gateway's policy", and its reason when it gives one.                                    | The installed gateway                                                                                                                              |
| 2   | A deny rule for this bot                                      | The same failed step. "Decided by: Otto's rule", and the rule.                                                                               | The rules plugin                                                                                                                                   |
| 3   | An "ask" rule that matches, even though an allow also matches | An approval card. In the full request: "Asked because of Otto's rule 'ask before deleting'. It outranks the saved allow.", with "Edit rule". | The rules plugin. Without it, the nearest thing is a host set to always ask, which asks for every command and offers no "Always allow".            |
| 4   | A saved allow that still applies                              | An ordinary step that runs, with one line in the readable view naming what allowed it, when the result says                                  | The installed gateway for an allowlist entry or a routine's grant; the rules plugin for an allow with a scope or a lifetime of the user's choosing |
| 5   | The automatic review, when nothing above applies              | By its verdict, as in the table above                                                                                                        | The installed gateway, where the review is switched on. It applies to commands only.                                                               |

- With the review switched off, the installed gateway does what its policy says: it runs the command, asks, or refuses. It does not ask by default.
- Something the user said earlier in the conversation is not a permission.
- A capability the connection lacks is not a denial. That is section 3's card that can be read but not answered.

**Keyboard.**

- The card does not take focus when it arrives. "Review" on the composer's shelf, or ⌘J, moves focus to it; the card is a `region` named "Otto wants to run a command. Needs approval."
- Tab order: Show full request, Allow once, Always allow…, Deny, Raw. With the form open: Show full request, the form's rows (read as text, followed by the days field when the request has one), Allow and save, Back, Deny, Raw.
- "Always allow…" has `aria-expanded` and opens the form with focus on "Allow and save". Escape, or Back, closes the form and returns focus to "Always allow…".
- ⌘↵ with focus anywhere in the card is Allow once, and with the form open it is Allow and save. Inside the card it wins over the window's own ⌘↵; in the composer ⌘↵ still sends. Deny has no shortcut.
- When the card resolves while focus is inside it, focus moves to the resolved card's line.

**Phone.** The buttons are full width and stacked in the same order, with Deny last. Tapping "Show full request" opens it in place. (F-172, F-251)

## 13. Question cards

Questions appear only on the interactive tier. This card is for the ordinary questions a bot asks with its ask-user tool: one to three at a time, each with two to four options, each allowing one answer or several, and each answerable in the user's own words. A bot that wants the user to do something asks it here.

**Which records this card takes.** The gateway's question record is wider than that tool. A record gets this card when every question in it passes this test: it has between two and four options; each option is a label, with or without a description, and nothing else (no value, picture, resource or preview); and the question has none of a form presentation, a resource, a link, a secret, a lines format, an allowance for an empty answer, or default answers. The own-answer field is shown when the question says it accepts another answer, which the ask-user tool always sets. An option's second line is its description, shown when the option carries a nonempty one; the ask-user tool keeps a description the bot gives.

Any other question record is shown readable and not answerable: a card titled "Otto asked something this app can't answer yet", each question's text and its options as plain text, the record's state, and "Raw". It has no option rows, no field and no Dismiss. The run stays waiting, the shelf row reads "Otto asked a question this app can't answer", and nothing is sent for it. Forms and secrets among such records are section 24's.

**Pending.** A card with no outline: questions are part of the conversation.

- **A quiet round Dismiss button** at the top right, named "Dismiss Otto's questions". (F-112)
- **Each question** is a block: its title (17 px, semibold; 15 px when there are several), "Choose all that apply." under it when several answers are allowed, its options, and its own "Type your own answer" field. Blocks are separated by 16 px. With several questions a small count leads each title: "1 of 3".
- **Options** are rows on one inset with rules between them: a letter in a 24 px tile, the option, and an optional second line in `--text-muted`. Rows are 44 px (52 on touch). (F-112)
- **"Type your own answer"**: a pill field. Typing in it clears that question's chosen options, and choosing an option clears the field. (F-303)

**Answering.**

| The card has                  | How it is answered                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One question, one answer      | Choosing an option answers at once. A typed answer is sent with Enter or the field's round send button.                                                                          |
| One question, several answers | Chosen rows fill their letter tile and show a check. "Send answer" (primary) is enabled once something is chosen or typed, with "2 chosen" beside it. (F-114)                    |
| Two or three questions        | Each is answered in its block. "Send answers" (primary) is at the foot, enabled when every question has an answer, with "2 of 3 answered" beside it. Nothing is sent until then. |

**After.** The card keeps each title, now in 14 px `--text-muted`, and shrinks to what was answered. The bot does not repeat the question. (F-113)

| State     | Under each title                                                                                    | What the bot is told                                 |
| --------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Answered  | The letter and the answer with a check, one row per answer; a typed answer is the text with a check | The answers                                          |
| Dismissed | "Dismissed"                                                                                         | That there is no answer. The run carries on. (F-302) |
| Expired   | "Expired without an answer"                                                                         | That there is no answer. The run carries on.         |
| Cancelled | "Cancelled: you stopped the run"                                                                    | Nothing; the run is over                             |
| Closed    | "Closed: the run ended" or "Closed: the run failed"                                                 | Nothing                                              |

Pending or resolved, the card ends with "Raw": the question event, and the answer event once there is one.

**A message typed in the composer while a question is pending is not the answer.** It is held and sent into the run once the question is answered or dismissed (section 15).

**Keyboard.**

- The card does not take focus when it arrives; "Review" or ⌘J moves focus to its first option. The card is a `region` named "Otto asks: <the first title>".
- One answer: the options are a radio group with one tab stop. Up and Down move the focus, Space or Enter chooses the focused option, and pressing an option's letter chooses it directly.
- Several answers: the options are checkboxes in a group; Up and Down move, Space or the letter toggles, and ⌘↵ sends when "Send answer" is enabled.
- Tab goes from the options to the own-answer field, to the next question, then to "Send answers", then "Raw". Letters choose options only while focus is in that question's options, never while typing.
- Escape with focus in the card dismisses it, after "Send answers" or a typed draft would be lost only once: the first Escape clears a typed answer, the next dismisses.
- When the card resolves, focus moves to the resolved card.

**Phone.** The same card. Options are 52 px rows, the own-answer field is 48 px, and "Send answers" is full width. Long questions wrap; the card scrolls with the transcript.

## 14. While a bot waits on you

Quiet until something needs you; then it says so in five places at once, in the same colour and the same words.

| Place           | What shows                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The card        | An approval: the warn outline and the "Needs approval" tag. A question: the card itself.                                                                               |
| The status line | "Waiting for you" in `--warn`; the avatar leaning in, with its badge (F-292)                                                                                           |
| The composer    | A shelf row on `--warn-soft`: "Otto needs your approval to run a command" or "Otto asked you a question", with "Review", which scrolls to the card and focuses it (⌘J) |
| The task row    | The waiting mark                                                                                                                                                       |
| The bot row     | The waiting avatar, and "Waiting for you: approve a command" or "Waiting for you: a question" in `--warn` (F-021)                                                      |

The Jump control reads "Needs you" when the card is out of view (section 18).

**What typing does.** A message sent while an approval is pending joins the run and leaves the approval pending; the shelf row does not change. A message sent while a question is pending is held, and as soon as there is text the shelf row reads "Otto asked a question. A message sent now is held until you answer."

**Several at once.** Pending cards are kept as a list. The run is waiting while the list is not empty, so answering one of two leaves everything above in place for the other. "Review" and "Needs you" go to the oldest pending card. It all clears the moment the last pending card is answered, expires or is dismissed. (F-302)

## 15. The composer during a run

The pill from `visual-language.md`, with what a run adds. Send stays; Stop appears beside it. On the read tier the access bar stands in its place (section 3). (F-097)

| Run                    | Placeholder                                | Controls after the text                                     |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| None                   | Message Otto                               | Send                                                        |
| Running                | Steer Otto                                 | Stop, Send. With text: the mode word, "Steer", before them. |
| Waiting on an approval | Answer above, or message Otto              | The same                                                    |
| Waiting on a question  | Answer above, or message Otto              | Stop, Send. With text: the mode word reads "Hold".          |
| Stopping               | Queue a message for Otto                   | "Stopping…", Send                                           |
| Offline                | Offline. Messages send when you reconnect. | Send (`visual-language.md`, section 8, with its fallback)   |

- **Send** is the round `--bg-inverse` button, grey when it cannot send. Its name says what it will do: "Send", "Steer this turn", "Queue after this turn", "Hold until you answer".
- **Stop** is a round `--bg-bubble` button holding a 10 px square. It turns `--danger-soft` on hover. Its name is "Stop Otto". It is there while the run is running or waiting, and gone while it is stopping.
- **The mode word** says what plain Enter will do during a run: "Steer", "Queue" or "Hold". It is a menu button named "How to send: Steer" that opens upward.

**One send operation.** Enter, the Send button, the menu, "Send now" on a queued row and anything added later all go through it. Its guard is the one in `visual-language.md`, section 8: a task is open, the connection may write, and there is text or an attachment within the limits. Then:

| When                                             | Plain Enter or Send                                                                                                                                                                                                                                                        | Where the message is shown                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| No run                                           | Starts a run                                                                                                                                                                                                                                                               | Your bubble                                                    |
| A run is running, or waiting on an approval only | Steer: the message joins the run. Pending approvals stay pending.                                                                                                                                                                                                          | Your bubble, captioned "Steer" once the gateway accepts it     |
| A question is pending                            | Hold, in every mode (plain Enter, ⌥↵, the menu): the message is kept and released when the last pending question in its task is settled (see "Held and queued messages"). While the run is stopping, the stopping rule comes first: the message is queued and stays unsent | A shelf row, "Held until you answer", with "Edit" and "Cancel" |
| The mode is Queue                                | Queue: the message starts the next run when this one ends                                                                                                                                                                                                                  | A shelf row, "Queued", with "Send now" and "Cancel"            |
| The run is stopping                              | Queue, whatever the mode and whether or not a question is pending; a confirmed Stop then leaves it "Not sent"                                                                                                                                                              | The same shelf row, without "Send now"                         |
| Offline                                          | The host holds it and sends it once on reconnect                                                                                                                                                                                                                           | Your bubble in the neutral fill, "Sends when reconnected"      |

| Other ways to send     | Keys | Does                                                                                                                                                                                                                          |
| ---------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue after this turn  | ⌥↵   | Queues this one message. It does not change the mode, so the mode word still shows what plain Enter does.                                                                                                                     |
| Start as new task      | ⇧⌘↵  | Creates a task under the same bot and runs the message there. This task's draft clears, the new task appears in the rail with the working mark, and the announcer says "Started as a new task". This task stays open. (F-282) |
| Choosing from the menu |      | "Steer this turn" or "Queue after this turn" sets the mode for the rest of this run; it returns to Steer when the run ends. "Start as new task" sends at once.                                                                |

**The menu.** During a run it opens from the mode word. With no run it opens from Send: by right-click, by touch and hold, and from the keyboard with Shift+F10 or the Menu key while Send has focus. Items: "Steer this turn ↵" (or "Hold until you answer ↵"), "Queue after this turn ⌥↵", "Start as new task ⇧⌘↵"; with no run, "Send ↵" and "Start as new task ⇧⌘↵". It is a `menu`; the current mode is a checked `menuitemradio`. It opens with focus on the checked item, Up and Down move, Enter chooses, and Escape closes it and returns focus to what opened it. (F-061, F-096)

**Keys.** Enter sends as the mode word says. Shift+Enter adds a line. ⌥Enter queues. ⇧⌘Enter starts a new task. ⌘. stops. ⌘J goes to what needs you. ⌘I focuses the composer. ⌘Enter sends from anywhere in the window except inside a pending card, where it answers the card (section 12). (F-072)

**The shelf** is a stack of rows above the pill, each 40 px on `--bg-bubble`, newest at the bottom. A row rises 4 px over 200 ms.

| Row                                           | Content                                                                                                       | Actions                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queued message                                | The hollow ring, "Queued" and the text                                                                        | "Send now" (steers it into the current run through the same operation; absent while the run is stopping and while a question is pending), "Cancel" (F-280, F-281, F-421) |
| Held message                                  | The hollow ring, "Held until you answer" and the text                                                         | "Edit" (puts the text back in the field and removes the row), "Cancel". Never "Send now".                                                                                |
| A message left after Stop                     | The stopped mark, "Not sent" and the text                                                                     | "Send" (follows the normal send rules: it starts a run with it, or, if the person has since started another run, goes as a message sent then would), "Remove"            |
| A queued message the gateway refused to start | On `--danger-soft`: "Couldn't start", the reason, the text                                                    | "Try again", "Delete". The message is never removed silently. It keeps its queue origin and this row through every refusal, until it starts or is deleted.               |
| Needs you                                     | Section 14                                                                                                    | "Review"                                                                                                                                                                 |
| Notice                                        | On `--danger-soft`: a title and a reason, such as "Otto failed to respond. The model provider is overloaded." | "Try again", Dismiss; "Clear all" when there are several (F-103, F-300)                                                                                                  |

**Held and queued messages: one rule.** A pending question holds every outgoing message in its task. Neither a held nor a queued message is in the transcript until it is sent, because it has not been.

| When                                                                          | Held messages                                                                                                                                                                                                                      | Queued messages                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A message is sent while a question is pending, by Enter, Send, ⌥↵ or the menu | It is held, after any already held                                                                                                                                                                                                 | Unchanged. "Send now" is not offered on any of them while a question is pending. |
| One of several pending questions is settled                                   | Still held                                                                                                                                                                                                                         | Unchanged                                                                        |
| The last pending question is answered, dismissed or expires                   | Released in the order they were sent, each as a message sent at that moment would be: into the run while it runs, queued while it is stopping. One sent with Queue (⌥↵ or the Queue mode) stays queued, after those already queued | "Send now" is offered again                                                      |
| The run ends by itself, completed or failed, with messages still held         | The run's questions close; then the messages still held become queued messages, after those already queued                                                                                                                         | They start in order, one run each                                                |
| Stop is confirmed (section 16)                                                | They stay on the shelf as "Not sent"                                                                                                                                                                                               | They stay on the shelf as "Not sent". Nothing starts by itself.                  |
| The stop request fails                                                        | Unchanged                                                                                                                                                                                                                          | Unchanged                                                                        |
| "Start as new task" is chosen while a question is pending                     | Not held: the message goes to the new task, which has no pending question                                                                                                                                                          |                                                                                  |

A "Not sent" row stays until the user chooses "Send" or "Remove". "Send" follows the normal send rules: with no run active it starts a run with that message; if the person has since started another run, it goes as a message sent at that moment would. Sending a new message from the composer starts a run with the new message and leaves those rows where they are.

**Attachments** are chips inside the pill, above the text: a file icon, the name, the size, and a remove button named "Remove <name>". The gateway's limits are checked as files are added, so a refusal is seen before anything is sent:

| Limit                     | A chip over it                                                        | Under the chips                                                          |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 6 MiB for an image        | On `--danger-soft`: the name, and "8.2 MB. Images can be up to 6 MB." |                                                                          |
| 20 MiB for any other file | The same, "Files can be up to 20 MB."                                 |                                                                          |
| 25 MiB for the message    | Chips stay as they are                                                | "27.4 MB attached. A message can carry up to 25 MB.", on `--danger-soft` |

While any refusal shows, Send is disabled and its tooltip and description give the reason. Removing a file clears it.

**Phone.** One row: attach, the text, the mode word when there is text, Stop, Send, each with a 44 px hit area. The mode word keeps its place and its menu opens as a sheet from the foot of the screen; touch and hold on Send opens the same sheet. The sheet is a `menu` with the same items, 52 px rows; tapping outside it or Escape closes it and returns focus to Send.

## 16. Stop

1. Pressing Stop, or ⌘., asks the gateway to stop the run and moves it to stopping. The phrase reads "Stopping…", Stop leaves the composer, and a message sent now is queued. (F-097, F-421)
2. When the gateway confirms, pending approvals and questions close as "Cancelled", including those raised by the run's helpers and by bots it messaged, the status line leaves and a note takes its place. Nothing starts by itself after a stop: messages that were held or queued, or released and not yet sent, stay on the shelf, marked "Not sent", until the user sends or removes each one (section 15). A message already on its way to the gateway is not touched; it settles as the gateway answers it.

The note is 13 px `--text-muted`, led by the stopped mark:

> **Stopped after 40s.** Completed steps are not undone.
>
> - Stopped with it: Marlow's run for this message.
> - The call to T3 Code was made. Work handed to T3 Code may continue there.

It lists every helper run, bot run and process the gateway reports as stopped, and names what may continue. It claims nothing the gateway did not report: a call that had started and not returned is listed as "The message to Marlow may or may not have been delivered." Completed steps, cards and text stay where they are. (F-098, F-137, F-296, F-297, F-298, F-299)

| What happens                                 | What shows                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The gateway confirms the stop                | The note above                                                                                                                                                                                                                                               |
| The stop request fails                       | The run returns to running: Stop comes back, the status line shows the run's real state again, pending cards stay pending, held and queued messages stay as they were, and a notice on the shelf reads "Couldn't stop Otto." with the reason and "Try again" |
| The run finished before the stop took effect | "**Finished before Stop took effect.** The turn completed normally." (F-419)                                                                                                                                                                                 |
| The run was stopped from somewhere else      | It goes straight to stopped, without "Stopping…": "**Stopped after 40s**, from another device or session." and the same list                                                                                                                                 |

## 17. Turn errors and notes

**A failed turn** ends with a card on `--danger-soft`: a triangle, a semibold title ("Otto couldn't finish this turn"), the reason in one or two sentences, and actions: "Try again", "Copy request ID", "Raw", and a round Dismiss. It is `role="alert"`. (F-102, F-301)

- "Try again" sends the same message as a new run.
- "Copy request ID" copies the id and reports it as any copy does (section 9). "Raw" is the error event as received. Dismiss, named "Dismiss this error", folds the card to an event line, "Otto couldn't finish this turn", which opens it again.
- The reason says what is known and what was not undone: "The model provider is overloaded. Nothing ran after step 4, and steps already completed are not undone."
- A rate limit retries by itself first, and the status line says so. The card appears only when the retries are used up.
- Reply text that had begun stays, captioned "Incomplete".
- Pending cards close as "Closed: the run failed". Queued messages stay queued and start in order.

**Time limits.** The gateway says which limit was hit, and the words follow it.

| Limit                                  | What shows                                                                                                                                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A command's own limit                  | A failed step, "mv timed out", "its 120s limit" (section 8). The run goes on.                                                                                                                                                                                              |
| The run's limit                        | The run ends as failed. The step that was running reads "mv was cut off", "Aborted". The card's title is "Otto's turn reached its 50 minute limit", and its reason "The gateway ended the turn so it would not hang. Send a message to pick up where it left off." (F-100) |
| Several tool calls in a row timing out | A note in the Stop note's form: "**Stopped after 3 tool calls in a row timed out.** media-box may not be responding." (F-101)                                                                                                                                              |

## 18. Following and Jump to latest

**Following.** The reader is following when the end of the transcript is within 96 px of the foot of the view. That is decided before each change, and then:

- a reader who was following stays at the end, whatever changed: new output, a card arriving or resolving, the shelf or the composer growing or shrinking, the standing-allow form opening, the Work pane docking;
- a reader who was not following keeps their place: the text at the reading line, just under the protected band at the top, stays where it is while things change above or below it. This is the shell's own rule for a change of width, extended to every change of content.

So when an approval arrives and the shelf row appears, or the standing-allow form opens, the status line is still the last thing in view, at any width.

One thing limits following: what the reader has just opened stays in view. If staying at the end would push the first line of a step, a card or a form the reader opened above the top of the view, that line is held at the top instead, and the reader is no longer following. Nobody is scrolled away from what they opened to keep the status line in view.

A reader who is not following and opens something whose content falls below the foot of the view (a Raw panel, the full request) has it brought into view by the smallest scroll that shows it, and never past its first line.

**Jump to latest** is the shell's `.jump-latest` control (see `visual-language.md`), with the states a run needs. It shows only while the reader is not following and its destination is out of view: centred 10 px above the foot of the transcript, a pill on `--bg-raised` with `--shadow-pop`, 36 px (44 on touch), at most 380 px wide. It rises 6 px and fades in over 200 ms.

| State              | Content                                                                           | Destination                                                                                              |
| ------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A card is pending  | The waiting mark, "Needs you" in `--warn`, and an arrow                           | The oldest pending card. The arrow points up when that card is above the view and down when it is below. |
| A run is active    | The bot's avatar at 20 px in its real state, the current phrase, and a down arrow | The end                                                                                                  |
| New output, no run | "Jump to latest", or "3 new", and a down arrow                                    | The end                                                                                                  |

A pending card comes first, then a live run, then new output. Choosing the control scrolls to its destination; for a card it also moves focus to the card. The control leaves when its destination comes into view.

## 19. After a reconnect

The status strip reports the connection from inside the conversation, in the band under the title pill (`visual-language.md`, sections 8 and 11). One state drives the strip, the rail's footer, the status line and the composer. For a conversation that was mid-run:

| Moment                | Strip                                                                                                                 | Status line                                                                                                                                   | Composer                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| The connection drops  | **Reconnecting in 4s** · showing saved messages, with "Retry now"                                                     | Stays, and stops moving: the avatar is blocked, the phrase reads "Reconnecting. Last seen reading the backup log", the elapsed time is hidden | The offline form        |
| Reconnected, fetching | **Connected** · catching up                                                                                           | Unchanged                                                                                                                                     | Unchanged               |
| Caught up             | **Synced**, for 4 seconds. A count ("· 3 new in this task") is added only if the core reports one; today it does not. | Shows the run's real state again                                                                                                              | Back to the run's state |
| The fetch failed      | **Couldn't sync this task**, with "Try again"                                                                         | Unchanged                                                                                                                                     | Unchanged               |

**A lost connection never looks like live work.** One flag for the whole window, not one per component, turns off everything that stands for work on the gateway, and marks what is left as last seen. The flag is `data-connection="lost"` on `.app`, set whenever the connection's status is anything but connected:

| Where                                                                                                 | While the connection is lost                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Every state avatar: the status line, the rail, pinned tiles, a card's recipient row, the Jump control | No ring orbits and no body bobs, sways or leans. The avatar keeps its last face. The open task's bot shows blocked. |
| Every working or waiting mark: task rows, steps, cards' state words                                   | Still. The arc holds one position; the waiting dot has no ping.                                                     |
| The status phrase                                                                                     | No shimmer. "Reconnecting. Last seen …"                                                                             |
| A running step                                                                                        | Status "Last seen running"                                                                                          |
| A Messaged or T3 Code card that was Call started or Working                                           | The state word keeps its last value with "last seen" before it: "Last seen working"                                 |
| The activity line                                                                                     | "Last seen working · 3 steps"                                                                                       |
| A bot's row in the rail                                                                               | Its last preview, led by "Last seen:"                                                                               |
| The streaming caret                                                                                   | Still                                                                                                               |

The strip's own dot, and the footer's, may pulse: that motion is the connection attempt, which the app does know about.

- What was missed is fetched again and merged in place, without enter animations. No message, step or card appears twice: each is matched by its identifiers and updates the one already on screen. (F-107, F-442)
- Nothing unmounts and nothing the reader had opened folds: an open block, an open step with its chosen view, an open card with its Raw panel all survive. (F-104)
- The reader's place holds. New items below the fold bring up Jump to latest.
- If the fetch fails, what was on screen stays. (F-105)

In the prototype, "Drop the connection" in the bar shows all of this during the scripted run.

## 20. Rows in the rail

The rail's arrangement, the folded-bot rule and the task rows are defined in `visual-language.md`, section 7. This section adds the states a run brings.

**A bot row** speaks for all of the bot's tasks. One table decides every part of it, so the parts cannot disagree:

| Part                | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The avatar's state  | The most urgent state among the bot's tasks, in the order of section 4: waiting for you; failed or blocked; done with failures; working; thinking; done; stopped; idle. (F-426)                                                                                                                                                                                                                                                                                                                            |
| The failure badge   | Shown with failed, and with done with failures (on the done face)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Line two            | If any task is waiting for you: "Waiting for you: approve a command", or "…: a question", in `--warn`, whatever happened since in other tasks. Otherwise, by the avatar's state: failed, "Couldn't finish: provider overloaded" in `--danger`; blocked, "Can't reach media-box" in `--warn`; done with failures, "Finished with 1 failed step" in `--danger`; working, the working task's current phrase; thinking, "Thinking". For done, stopped and idle: the latest message in any task. (F-021, F-295) |
| The time            | "now" while a run is active; since it began waiting, for waiting; otherwise the time of the latest activity                                                                                                                                                                                                                                                                                                                                                                                                |
| The unread dot      | An 8 px accent dot at the end of line two when any task other than the one on screen is unread. Independent of everything above. (F-022)                                                                                                                                                                                                                                                                                                                                                                   |
| The accessible name | "<Bot>, <N> tasks, <state>", with ", unread" when the dot shows                                                                                                                                                                                                                                                                                                                                                                                                                                            |

With the state avatar, the run-state mark that the plain shell puts at the start of line two moves onto the avatar: the ring for working, the badge for waiting, blocked and failed.

Fixtures for the order:

| The bot's tasks                                                       | The row shows                                                                           |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| One waiting, one working                                              | Waiting, and "Waiting for you: …"                                                       |
| One done with failures, one working                                   | Done with failures, its failed badge, "Finished with 1 failed step", and the unread dot |
| The same, after the done-with-failures task is opened                 | Working, the working task's phrase                                                      |
| One waiting since ten minutes ago, another that finished a minute ago | Waiting, "Waiting for you: …", and the unread dot for the finished task                 |
| One working, one unread                                               | Working, the working task's phrase, and the unread dot                                  |
| One stopped, one idle                                                 | Stopped, with its badge, and the latest message                                         |

A pinned tile shows the same avatar state, with the unread dot beside the name.

**A task row** is its title, the time of its last activity, and at most one mark at the right. (F-057, F-425)

| Task               | Mark       | Title          | Accessible name ends   |
| ------------------ | ---------- | -------------- | ---------------------- |
| working            | working    | `--text`       | ", working"            |
| waiting for you    | waiting    | `--text`       | ", needs you"          |
| blocked            | blocked    |                | ", blocked"            |
| failed             | failed     |                | ", last run failed"    |
| done with failures | failed     |                | ", done with failures" |
| done, unread       | unread dot | `--text`       | ", unread"             |
| stopped            | stopped    |                | ", stopped"            |
| queued             | queued     |                | ", queued"             |
| idle               | none       | `--text-muted` |                        |

The time is 12 px, `--text-faint`, tabular, in the rail's short form ("now", "5:36 PM", "Mon"), between the title and the mark. It is part of the row's accessible name. A task's state is always a mark and never a word, because warn-coloured text is not allowed on the selected task's fill (`visual-language.md`, section 13). Opening a task clears done, done with failures, stopped and their marks. (F-022, F-295)

**The phone** uses the same rows at touch sizes: 44 px avatars, 44 px task rows.

## 21. What the gateway's events drive

Names are from `docs/research/gateway-capabilities.md`. Each capability gates its own feature and never the whole conversation: a connection without one still shows everything else.

| Shown                        | Driven by                                                                                                                                                               | Needs                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| A run starts                 | `chat.send` returning a run id; `agent` stream `lifecycle`, phase `start`                                                                                               | Read to see it; interactive to send     |
| Status phases, retries       | `chat` state `status`, with `phase` and `retry`                                                                                                                         | Read                                    |
| Reasoning steps              | `agent` stream `thinking`, as segments in order among the tool calls. Absent when the model reports none or visibility is off.                                          | Read                                    |
| A step starts, updates, ends | `agent` streams `item` and `tool`, phases start, update, result                                                                                                         | Read, with `tool-events`                |
| Output as it arrives         | `agent` stream `tool` phase `update`; stream `command_output`                                                                                                           | Read                                    |
| A failed step                | A tool result with `isError`; a time limit from the result's structured timeout                                                                                         | Read                                    |
| The automatic review         | The review record on the command's step                                                                                                                                 | Read                                    |
| Reply text                   | `chat` state `delta`, then `final`                                                                                                                                      | Read                                    |
| A card is pending            | `exec.approval.requested`, `plugin.approval.requested`; the question request                                                                                            | Interactive. Not sent on the read tier. |
| A card is answered           | `exec.approval.resolved`; lifecycle phase `approval-resolved`; the question's answer                                                                                    | Interactive                             |
| Messaged card                | A tool event named `sessions_send`: the target from its arguments, the reply and the recipient's run id from its result; the recipient's run from that run's own events | Read                                    |
| Messaged T3 Code card        | A tool event whose name starts with the configured server's prefix, or whose result names that server                                                                   | Read                                    |
| The run ends                 | `chat` state `final`, `aborted` or `error`; lifecycle phase `end` or `error`                                                                                            | Read                                    |
| A gap                        | A jump in the event sequence, or a reconnect: reload the history                                                                                                        | Read                                    |

Three things depend on the gateway more than the rest:

- **What "started" proves.** A tool's start event is reported before the call is checked or allowed, and also for a call that is then skipped. It shows that the bot began the call and nothing about whether it was made or delivered. That is why both Messaged cards begin at Call started, and why a call can go from there to Waiting for approval and back.
- **The recipient's state on a Messaged card.** Working and Recipient waiting need the send's result to name the recipient's run. Where it does not, the card goes from Sent to Replied or No reply yet.
- **Rules.** An approval request says which decisions it offers and carries the command, its arguments, the folder, the host or machine, the bot and, for a routine's request, the scope of the grant. It does not carry the rule that "allow always" will save, and the confirmation does not return one. Standing grants are listed and revoked with the access that answers approvals; a host's allowlist needs admin.
- **Effort.** The gateway reports the effort requested for a task or turn. The effort a turn used is not a dependable field and is never shown.

## 22. Building on the shell as built

The shell is built, in `packages/ui/src/`, to `visual-language.md`. Its tokens, type, surfaces, the rail, the Work pane, the status strip and the plain transcript are as that document says, and this document's names for them (`--bg-bubble`, `--strip-band`, `--tap-min`, the `--loop-*` and `--dur-*` tokens, `.jump-latest`, `.status-strip`, `.task-time`, `[data-input="touch"]`) are the names in `styles/tokens.css` and `styles/app.css`. This is what each part here starts from and what changes. What is marked "keep" has tests in `e2e/` and `visual/` that still describe it.

| Part                                         | In the shell today                                                                                                                                                                                                                                                             | The builder's change                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access (section 3)                           | `access.ts`: `canWrite(connection)` always returns false. `Conversation.tsx` renders `footer.composer[data-readonly="true"]`, "Read-only connection. You can view conversations.", whenever a task is open.                                                                    | `canWrite` becomes the tier check. The read-only footer becomes the access bar. The core client gains the request for the interactive tier and its state (asking, requested with its id and command, denied, expired), and the bridge gains the commands to ask and to cancel, beside the ones that send, stop and answer.                                                                            |
| The composer (section 15)                    | Only the read-only form. The pill's field and send button are in `prototype/css/app.css` under "Composer" and were not taken into `styles/app.css`, because nothing could send.                                                                                                | Take those rules, build the pill as `visual-language.md` section 8 describes it, then add what section 15 adds.                                                                                                                                                                                                                                                                                       |
| The state avatar (section 4)                 | `Avatar.tsx`: `Avatar({ bot })` draws `Character` from `characterFor(id)`, or the bot's image. It has no state.                                                                                                                                                                | Give the character a state (the eyes for each state are in `prototype/js/icons.js`, `character(id, state)`), and add the wrapper that carries the ring and the badge (`.presence` in `prototype/css/conversation.css`). An `Avatar` with no state stays what it is today.                                                                                                                             |
| State marks (section 2)                      | `.glyph` with working, check, failed and unread                                                                                                                                                                                                                                | Add sending, waiting, blocked, stopped, done and queued, from `prototype/css/app.css` under "State marks".                                                                                                                                                                                                                                                                                            |
| The status line (section 5)                  | While a run streams, `TranscriptView` renders `div.turn[data-testid="live-turn"]` whose bubble holds the live text, or the word "Thinking" (`span.thinking`) before any text.                                                                                                  | Keep `live-turn` for the streaming bubble. "Thinking" leaves the bubble and becomes the status line's phrase, so there is never an empty bubble. Delete `.thinking`.                                                                                                                                                                                                                                  |
| The activity block and steps (sections 7, 8) | `Steps`: one `details.steps` for each run of consecutive thoughts and tool calls in an item, its `summary.event-line` labelled by `stepsLabel`, holding `ReasoningStep` and `ToolStep` rows (`data-testid="tool-call"`) that open to the reasoning or to Arguments and Result. | One `.activity` for each run, placed where the run's first step began; its rows are this document's `.step`. Keep `data-testid="tool-call"` on a tool step. `stepsLabel` gives way to the line in section 7. The interim `.steps` and `.steps-list` rules are deleted. History the gateway returns without run boundaries keeps one block for each item's steps, labelled "N steps" with no duration. |
| Raw (section 9)                              | The tool row's body: Arguments and Result or Error, with "(empty)" for an empty result                                                                                                                                                                                         | It becomes the Raw tab's Arguments and Result parts. The readable view, timing, identifiers and copy are new.                                                                                                                                                                                                                                                                                         |
| Following (section 18)                       | `NEAR_BOTTOM_PX = 96` and the follow-at-the-end logic; `useHoldPlace` holds the text at the reading line through a change of width                                                                                                                                             | Keep both. Extend `useHoldPlace` to changes of content (a block folding, a card resolving, the shelf or the composer changing height), and add the rule for what the reader has just opened.                                                                                                                                                                                                          |
| Jump to latest (section 18)                  | `button.jump-latest[data-testid="jump-latest"]`: "Jump to latest", shown when new activity arrives while the reader is away from the end                                                                                                                                       | Add the live and the pending-card states, their destinations and their order. It is 36 px at every size today; add the 44 px touch size.                                                                                                                                                                                                                                                              |
| The status strip (section 19)                | `StatusStrip.tsx`: `useSyncPhase` and `stripFor` give Reconnecting with its countdown, Can't reach, Couldn't load bots and tasks, Couldn't sync this task, Connected · catching up, and Synced with no count                                                                   | Keep. Add the "Access granted" row. Set `data-connection="lost"` on `.app` from the same connection state.                                                                                                                                                                                                                                                                                            |
| Motion and touch (section 2)                 | `App.tsx` sets `data-motion="reduce"` from the app's preference and `data-input="touch"` when the primary pointer is coarse; `styles/app.css` also honours the system's reduced-motion setting                                                                                 | Used as they are.                                                                                                                                                                                                                                                                                                                                                                                     |
| Rows in the rail (section 20)                | `selection.ts`: `summarize()` gives a bot's preview, time, unread and a state that is failed, working or nothing; `botLabel` speaks them. `Rail.tsx` draws a task row as title, `.task-time` and one `.task-mark` slot, with the time in the row's name.                       | `summarize` returns the state and line two of section 20's table, and the run-state mark at the start of a bot's line two goes, because the avatar now carries it. The task row is kept; its mark slot takes the new marks.                                                                                                                                                                           |
| What the core knows                          | `Task.status` is running, done, failed or idle. A transcript item is text, reasoning and tool-call blocks; `Transcript.live` is a run id and its text.                                                                                                                         | The conversation engine supplies runs, steps with their status and timing, pending and resolved cards, Messaged cards and the tier. This document says what is shown for each; the engine's types are its own. Task statuses for waiting, blocked, done with failures, stopped and queued come from it.                                                                                               |

## 23. Where this goes beyond the proposals, and the parity rows to reword

The proposals say what must be true. These are the places where this design adds a state, a rule or a control they do not have, or reads one differently.

| What                                          | In the proposals                                                                       | Here                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avatar states                                 | Six: idle, thinking, working, waiting, blocked, done                                   | Eight: failed and stopped are added, each with its place in the one priority order (section 4).                                                       |
| Avatars with a picture                        | Not addressed                                                                          | The ring and the badge carry the state, since there is no face to move.                                                                               |
| An approval as a step                         | Every approval is a step                                                               | An approval for a tool call is that step's waiting status, and its events stay in the step's Raw; an approval with no tool call is a step of its own. |
| The activity block when a run ends            | Its open or folded state is kept while steps arrive, across scrolling and across tasks | The same, and an open block folds once when the run ends unless a step in it is open or focus is inside it. A block reopened afterwards persists.     |
| Status phrases                                | "Thinking", the running step's summary, "Waiting for you", "Stopping…"                 | The same, plus phrases for the gateway's status phases, the review, retries, an unreachable machine and a lost connection (section 5).                |
| Elapsed time                                  | Not addressed                                                                          | Shown on the status line, from the run's reported start.                                                                                              |
| Where the Send menu lives                     | On the Send button                                                                     | During a run, on a mode word beside Send, on the desktop and on the phone; with no run, on Send.                                                      |
| Queued messages                               | A "Queued" chip on the message                                                         | A row on a shelf above the composer, with "Send now" and "Cancel".                                                                                    |
| A steer that the gateway turns into a restart | Not addressed                                                                          | The caption reads "Steer · restarted the turn", only when the gateway reports it.                                                                     |
| Jump to latest                                | Not addressed                                                                          | Three states with one priority (section 18).                                                                                                          |
| A reconnect during a run                      | The strip and the refetch                                                              | Also: everything that stood for live work stops and is marked last seen (section 19).                                                                 |
| Tiers                                         | Not addressed                                                                          | The read tier has an access bar in the composer's place and no approvals or questions (section 3).                                                    |
| Call started                                  | Sending, then Sent                                                                     | The first state of both Messaged cards, because the start of a call does not prove it was made. Sent, or Call made, needs the result.                 |

**Parity rows to reword.** Only the Clawtrate column changes; the description of Grok Bot stays. Rows not listed here are met as written, including F-054, F-425 (task rows show the last-activity time) and F-427 (the iPhone app keeps its own route; `visual-language.md`, section 12).

| Row   | New wording for the Clawtrate column                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why                                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| F-021 | better: while a bot waits for an answer, its avatar shows the waiting state and badge, and its preview starts "Waiting for you" in Clawtrate's own warning colour; the state clears as soon as nothing is pending.                                                                                                                                                                                                                                                               | Appearance only; the function is kept.                                                                      |
| F-057 | better: each task shows its own status (working, waiting for you, blocked, failed, done, done with failures, stopped, queued, idle) as a shape mark with the status in its accessible name, in the sidebar (desktop, iPad) or the task list (iPhone) (FC-06, §4.1).                                                                                                                                                                                                              | A mark and a name in place of a word.                                                                       |
| F-061 | better: the Send menu's "Queue after this turn" adds the message as a "Queued" row on the shelf above the composer, and it runs when the current run ends (§5.6).                                                                                                                                                                                                                                                                                                                | The chip becomes a shelf row.                                                                               |
| F-064 | better: the user's messages are right-aligned rounded bubbles filled with Clawtrate's own accent, derived from its logo; Appearance can switch this to neutral.                                                                                                                                                                                                                                                                                                                  | The binding identity decision.                                                                              |
| F-072 | same; note: inside a pending approval or question card, Cmd/Ctrl+Enter answers that card and does not send.                                                                                                                                                                                                                                                                                                                                                                      | Shortcut precedence.                                                                                        |
| F-086 | better: as written, with two more states, failed and stopped, each with a badge; the priority order is waiting for you, failed or blocked, done with failures, working, thinking, done, stopped, idle.                                                                                                                                                                                                                                                                           | Two added states.                                                                                           |
| F-090 | better: as written, where a step is a tool call, an exposed reasoning segment, a Bot-to-Bot message, a handoff, or an approval that belongs to no tool call.                                                                                                                                                                                                                                                                                                                     | One step per action.                                                                                        |
| F-091 | better: clicking or tapping the activity block expands it into step cards, one per tool call, exposed reasoning segment, Bot-to-Bot message, handoff and standalone approval; an approval for a tool call is that step's waiting status and its events stay in the step's raw view; new cards append live while it is expanded (FC-05).                                                                                                                                          | One step per action.                                                                                        |
| F-134 | better: the Messaged T3 Code card's state is Call started, Waiting for approval or Delivery unknown (non-terminal), or Call made, Failed or Not sent (terminal), derived only from the Bot's tool events; Call made means the call returned, not that the work finished (§6.2).                                                                                                                                                                                                  | The start of a call does not prove it was made, and a result does not prove completion.                     |
| F-137 | better: stopping the Bot stops only its gateway run; a card that already reads Call made keeps that state and adds "The call was made. Work handed to T3 Code may continue there."; a call that had not returned stays Delivery unknown, or Not sent when the gateway confirms it (F-470) (§6.2)                                                                                                                                                                                 | The app cannot know that work continues, and a stop before the result proves no call.                       |
| F-163 | better: an approval card has a title naming the Bot ("&lt;Bot&gt; wants to run a command"), a "Needs approval" tag in Clawtrate's warning colour, a one-sentence summary, "Show full request", and "Allow once" (primary), "Always allow…", which opens a form showing what is saved, and "Deny", which stays visible in every pending state.                                                                                                                                    | Own wording; Deny always visible.                                                                           |
| F-167 | better: "Always allow" appears only when the request offers that decision; its form shows the request's own fields (the command, the folder, the host or machine, the Bot, and for a routine's request the routine) and says in words what the gateway keeps for that kind of request; a lifetime in whole days, from 1 to 3650, is offered only for requests that mint a dated grant; a scope or a lifetime of the user's choosing depends on Clawtrate's rules plugin (FC-09). | The gateway shows no rule in advance and returns none; an ordinary command's allowlist entry has no expiry. |
| F-169 | better: sending a new message joins the run and leaves pending approval cards open; pressing Stop closes them as "Cancelled".                                                                                                                                                                                                                                                                                                                                                    | The gateway keeps approvals pending through a steer.                                                        |
| F-313 | better: a later tool event updates the card only when identifiers carried in the gateway's tool events name it; without one, the card stays at Call made (§6.2).                                                                                                                                                                                                                                                                                                                 | Follows F-134.                                                                                              |
| F-429 | better: an expanded activity block stays expanded after scrolling away and back, and after switching to another task and returning; when the run ends it folds once, unless a step in it is open or focus is inside it, and a block reopened after that stays open (§5.6).                                                                                                                                                                                                       | The terminal fold.                                                                                          |
| F-430 | better: a collapsed step card shows a kind icon, a summary, a detail and a status; in a narrow column the detail moves to a second line; on desktop, hovering a truncated summary shows it in full (§5.6).                                                                                                                                                                                                                                                                       | The narrow row keeps its detail.                                                                            |
| F-470 | better: stop-before-result fixture, parameterized: when the gateway confirms the call was not made, the card ends as "Not sent"; when the gateway cannot say, the card reads "Delivery unknown" and stays so with no further event; a later correlated result then moves it to Call made or Failed (§6.2).                                                                                                                                                                       | Follows F-134.                                                                                              |

Not every case in the teardown's sections 5.6 and 8.8 has a specimen here. Section 24 lists what is left to other components.

## 24. Not covered here

- Secure Form and Computer cards, and with them the order between the vault, a password manager and a Secure Form. They use the card frame here (`--bg-bubble`, radius 18, a 17 px title, a tag at the top right, buttons along the foot), and a run counts them among its pending cards, so a steer or an answer to another card never clears them.
- Requests for permissions on the phone itself: pending, timed out, granted and re-evaluated, resumed once, blocked by policy.
- Draft, file and link cards.
- The Permissions page, where standing grants are listed and revoked, a host's allowlist is shown to an admin, and the audit log and limits live. (F-178, F-324)
- Clawtrate's rules plugin and its rule form: rules the user shapes by hand, with a scope and a lifetime of their choosing, deny and ask rules for a bot, and saving a rule after a request expired. Sections 12 and 23 mark what depends on it.
- Question records that are forms, carry a resource or a link, or ask for a secret. Section 13 shows them readable and not answerable until they have a design.
- Changing the model or the effort. Both belong to the task and the turn; a bot's own default needs the admin tier.
- The Work pane's Coding section, beyond the card form its rows use. (F-136)
- A conversation shared by several bots.
- The gateway's record of tool actions, which Raw links to.
