# Conversation components

How a running turn looks, moves and reads. This is the second part of the design; `visual-language.md` is the first and defines the tokens, type, surfaces, the rail and the plain transcript this builds on.

The behaviour these components must have is set out in the teardown's design proposals (`docs/research/grok-bot-flows.md`, sections 4.1, 5.6, 6.1, 6.2 and 8.8) and checked by `docs/parity.md`. This document decides appearance, wording, motion and input. Parity ids are given beside each requirement.

The prototype shows all of it: `prototype/gallery.html` has every component in every state, and `prototype/conversation.html` plays one scripted turn inside the shell. The styles are in `prototype/css/conversation.css` and the markup in `prototype/js/components.js`, one function per component.

## Contents

1. How the pieces fit
2. Shared rules: tokens, motion, input
3. The state avatar
4. The status line
5. Streaming text and message captions
6. The activity block
7. Steps
8. The Messaged card
9. The Messaged T3 Code card
10. Approval cards
11. Question cards
12. While a bot waits on you
13. The composer during a run
14. Stop
15. Turn errors and notes
16. Jump to latest
17. After a reconnect
18. Rows in the rail
19. What the gateway's events drive
20. Where this goes beyond the proposals
21. Not covered here

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

Calm by default: a finished turn is bubbles and a few one-line cards. Complete on demand: every line opens in place, and every step and card can show what the gateway actually sent.

Everything that opens does so in place and grows downward. Nothing above an opened element moves. All of it uses the browser's own disclosure (`details` and `summary`), so each has a keyboard path and find-in-page reaches folded text.

## 2. Shared rules

### Tokens

This part adds no colour tokens. It uses the set in `visual-language.md`. The tokens it is the first to use:

| Token | Value | Use |
|---|---|---|
| `--warn-line` | `rgba(147,86,0,.32)` light, `rgba(240,180,90,.42)` dark | Outline of a pending approval card |
| `--danger-line` | `rgba(179,38,30,.3)` light, `rgba(255,138,128,.42)` dark | Reserved for a failure outline; fills use `--danger-soft` |
| `--dur-quick` | 120ms | Chevrons turning, opened content fading in |
| `--dur-base` | 200ms | A new step, a new phrase, a shelf row, the Jump control, the status line leaving |
| `--dur-settle` | 420ms | The nod when a run completes |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | Everything that happens once |
| `--ease-in-out` | `cubic-bezier(.45,0,.2,1)` | Loops that go back and forth |
| `--loop-think` | 2600ms | Thinking: one sway |
| `--loop-work` | 1200ms | Working: one orbit of the ring; the bob takes half |
| `--loop-shimmer` | 2000ms | The light across the status phrase |
| `--loop-nudge` | 2600ms | Waiting on you: one lean, one ping |
| `--loop-blink` | 5600ms | Idle: one blink |
| `--loop-caret` | 1200ms | The streaming caret's breath |
| `--tap-min` | 44px | Smallest touch target |

### Surfaces

| Thing | Surface |
|---|---|
| Activity line, event lines, notes, the status line | None. Text on the stage. |
| Open activity block, Messaged cards, request cards, shelf rows | `--bg-bubble`, radius 18, at most 640 px wide. Beside a docked Work pane the conversation is 600 px and they take the column's 560 px. |
| Code, what was sent, option lists, the full request, inside a card | `--bg-pane`, radius 10 or 14 |
| Buttons on a card | `--bg-selected`; the primary stays `--bg-inverse` |
| A pending approval | The card, plus a 1.5 px `--warn-line` outline |
| A failed turn, a failed step under a folded block | `--danger-soft` |

### Motion

Motion says what state something is in. It never makes anyone wait: no enter animation delays content, nothing is held back to finish a transition, and removed elements go at once except the status line's 200 ms fade.

**Reduced motion** is `[data-motion="reduce"]` on the root, set by the host from the system setting. Every loop stops and every transition is instant. Each state keeps a still form that says the same thing, listed with each component below. (F-291)

### Input

- **Pointer.** Hover shows full text for anything truncated, as a tooltip.
- **Touch.** Every hover has a tap or a touch-and-hold equivalent, listed with each component. Targets are at least 44 px.
- **Keyboard.** Everything that opens is a `summary`: Tab reaches it, Enter or Space opens and closes it. Focus order follows reading order. New content never takes focus.

### State marks

A 12 px mark, used in task rows, beside state words and as the avatar's badge. Shape carries the meaning, so colour is never the only cue.

| Mark | Shape | Colour |
|---|---|---|
| working, sending | An arc travelling round a faint ring | `--accent-line` (sending: `--text-muted`) |
| waiting | A solid dot that pings | `--warn` |
| blocked | A disc with a bar | `--warn` |
| failed | A disc with an exclamation mark | `--danger` |
| stopped | A disc with a square | `--text-faint` |
| done | A disc with a check | `--accent-line` |
| check | A check alone | The text colour |
| unread | A dot | `--accent-line` |
| queued | A hollow ring | `--text-faint` |

Reduced motion: the arc holds still at one position; the ping becomes a fixed halo.

## 3. The state avatar

The avatar is the first signal. Three layers say the state, so that no single one has to be seen:

- **The face** (characters only): where the eyes look and how the body moves.
- **The ring**: an arc that travels round the avatar while a tool is running. 1.5 px, 4 px outside the avatar, `--accent-line` on a faint track.
- **The badge**: a state mark at the top right, with a 2 px halo in the surface colour, for the states that need you or went wrong.

| State | Entered when | Eyes | Motion | Ring | Badge | Still form |
|---|---|---|---|---|---|---|
| idle | No active run in any of the bot's tasks | Round, looking the bot's own way | A blink every 5.6 s, staggered between bots | none | none | Eyes open |
| thinking | A run is active and no tool step is running | Turned up | Sways 4° each way, 2.6 s | none | none | Eyes turned up |
| working | A tool step is running | Straight ahead | Bobs, 0.6 s each way | Orbits, 1.2 s | none | The arc held in place beside the avatar |
| waiting on you | A card from the bot's runs is pending | Wide, on the viewer | Leans in: grows to 110% and back, 2.6 s | none | waiting, pinging | Wide eyes and the badge with a fixed halo |
| blocked | The gateway or the bot's machine is unreachable, or the run needs a settings change | Half closed | None. Slumped 5° | none | blocked | The same |
| done | A run completed and its task has not been opened since | Smiling | One nod, 420 ms, then still | none | none; the row carries the unread dot | Smiling eyes |
| failed | The latest run failed and its task has not been opened since | Half closed | None. Slumped 5° | none | failed | The same |
| stopped | The latest run was stopped; until the next run or until the task is opened | As idle | None | none | stopped | The same |

When several states apply, the order is: waiting, blocked or failed, working, thinking, done, idle. When waiting wins while the machine is unreachable, the avatar shows waiting with the blocked badge. (F-086, F-422)

A bot with its own picture has no face to move. For it the ring also says thinking, as a full ring that breathes between 35% and 100% over 2.6 s (held at 50% under reduced motion), and the badge and ring carry everything else.

Accessible name: the avatar is `role="img"` with the name "<Bot>, <state>", for example "Otto, working". Where it sits inside a control that already speaks the state, it is hidden from assistive technology. (F-020, F-086)

Sizes: 64 px in the Work pane, 56 px pinned, 40 px in the rail, 28 px in the status line, 22 px in the title pill and in a card's live status, 20 px in the Jump control. Below 28 px the ring sits 3 px out.

## 4. The status line

The last thing in a running turn: the bot's avatar at 28 px and one short phrase. No bubble. It is flush left with the bubbles, 10 px below whatever came last.

**Anatomy.** Avatar with state; phrase (14 px, `--text-muted`); elapsed time (12 px, `--text-faint`, tabular, `m:ss`). The whole line is one button, 40 px tall, with a pill hover.

**Lifecycle.**

| Moment | What shows |
|---|---|
| You send | The avatar appears at once, thinking. (F-081) |
| A step starts | Its phrase appears at once, and the avatar is working. (F-082) |
| No step has started within 1 second | The phrase "Thinking" appears. (F-082, F-083, F-085) |
| Bubbles, cards and steps arrive | They render above the line. The line stays put. (F-081, F-089) |
| A card is pending | "Waiting for you", in `--warn`; the avatar is waiting. (F-292) |
| Stop is pressed | "Stopping…"; the avatar is idle; no shimmer. (F-097) |
| The run reaches completed, stopped or failed | The line is removed: it fades and lifts 4 px over 200 ms. No message says only that the bot is done. (F-089) |

The line always has an accessible name, including in the first second: "Otto, thinking. Show steps." (F-085)

**The phrase.** While a step runs it is that step's running title (section 7). Otherwise it is "Thinking". The gateway's own status phases give it more to say when no step is running:

| Source | Phrase |
|---|---|
| No step running | Thinking |
| A step running | The step's running title, for example "Reading backup-2026-11-15.log" |
| A message to another bot, once that bot's run has started | Waiting for Marlow |
| Status phase preparing a workspace or environment | Setting up the workspace |
| Status phase preparing context or flushing memory | Gathering context |
| Status with a retry | Rate limited. Retrying, attempt 2 of 5 |
| A pending card | Waiting for you |
| Stop pressed | Stopping… |
| The machine is unreachable | Can't reach <machine> |
| The connection is lost | Reconnecting. Last seen <last phrase, lower case> |

Phrases are in the user's language, have no bot name in front and no trailing ellipsis except "Stopping…". (F-082, F-083)

**Motion.** A light crosses the phrase while the avatar is thinking or working: a band of `--text` moving over `--text-faint`, left to right, every 2 s. It stops when the state is anything else. A new phrase rises 5 px and fades in over 200 ms; the old one is replaced at once. Reduced motion: plain `--text-muted` text, replaced at once. (F-084, F-291)

**Input.**

- Hover: the full phrase as a tooltip, for when it is truncated. (F-087)
- Click or Enter: opens the activity block and brings the running step into view.
- Tap: the same. (F-087)
- Screen readers hear a state change (thinking, working, waiting, stopping) through a polite live region, not every phrase.

**Elapsed time** counts from the send and shows once there is a phrase. It gives the difference between working and stuck a number.

## 5. Streaming text and message captions

- Reply text streams into its bubble as the gateway emits it. A caret follows the last character: 2 px wide, the height of the text, `--accent-line`, breathing between 100% and 35% over 1.2 s (steady under reduced motion). The bubble has `aria-busy="true"` until the message is complete. Text is never revealed more slowly than it arrives. (F-095, F-433)
- Progress messages the bot writes mid-run are ordinary bubbles. (F-088)

A caption is a 12 px line under a bubble, on the bubble's side:

| Caption | Under | When |
|---|---|---|
| Incomplete | A reply | The run failed or was stopped while it streamed. The text stays. (F-433) |
| Steer | Your bubble | It was delivered into a running turn. (F-096) |
| Failed to send · Resend · Delete | Your bubble | The send failed. The first part is `--danger`. (F-075) |
| Sends when reconnected | Your bubble, at 60% | Written while offline. (F-287) |

If the gateway reports that a steer interrupted the turn and restarted it, the caption reads "Steer · restarted the turn". The capability map notes that steering may do this.

## 6. The activity block

Every run with at least one step has one block, placed where the run's first step began. (F-090)

**Folded** it is the quiet line from `visual-language.md`: 13 px, `--text-faint`, 30 px tall, with a chevron.

| Run | Line |
|---|---|
| Not finished | Working · 3 steps |
| Completed | Worked for 1m 12s · 9 steps |
| Completed, every step was reasoning | Thought for 8s |
| Stopped | Stopped after 40s · 4 steps |
| Failed | Failed after 12s · 2 steps |
| Any of these with failed steps | … · 1 failed, in `--danger` |

A run with no step has no block. Durations read `48s`, `1m 12s`, `1h 04m`. (F-090, F-092, F-423)

**Failed steps stay in view.** Under a folded line, each failed step shows as its own row on a `--danger-soft` block, and opens like any step. A failure cannot hide behind a summary. (F-092, F-294)

**Open**, the line becomes the head of a card: `--bg-bubble`, radius 18, 640 px at most, listing the steps in order. New steps append while it is open, each rising 4 px over 200 ms. A footer gives the model, the effort and the run id with a copy button; the same model and effort are the folded line's tooltip. (F-091, F-044)

**What keeps it open or folded.**

- It starts folded.
- Whether it is open is kept while steps arrive, while the reader scrolls away and back, and across switching tasks. (F-429)
- When the run ends, an open block folds, unless a step inside it is open or keyboard focus is inside it. Opening the list is watching, and watching ends with the run; opening a step is reading, and reading is not interrupted. The reader's place is held as it folds (section 16).

**Input.** Click, tap or Enter on the line opens and closes it. It is a `summary` whose name is its text.

## 7. Steps

A step is a tool call, a stretch of reasoning the gateway exposes, a message to another bot, a handoff to T3 Code, or an approval that belongs to no tool call. An approval for a tool call is that step's waiting status, not a second step, so a command that needed approval counts once.

**Folded**, a step is one row, 34 px (44 on touch): an icon for its kind, a title, a detail in mono, a status at the right, and a chevron. (F-430)

| Status | Row |
|---|---|
| running | The icon is the working mark; the title is `--text` |
| done | Icon `--text-faint`; title `--text-muted`; the status is how long it took |
| failed | Icon, title and status in `--danger`; the status reads "Failed" |
| waiting | Icon and status in `--warn`; the status reads "Waiting for you" |
| not run | Title `--text-faint`; the status reads "Denied", "Stopped" or "Not run" |

**Titles** are plain words, and change tense with the status:

| Kind | Icon | Running | Done | Failed | Detail |
|---|---|---|---|---|---|
| Read a file | page with lines | Reading notes.md | Read notes.md | Couldn't read notes.md | 214 lines |
| Write or edit a file | pencil | Writing notes.md | Wrote notes.md | Couldn't write notes.md | +4 lines |
| List a folder | folder | Looking through logs | Looked through logs | Couldn't open logs | 9 files |
| Search | magnifier | Searching for "cache" | Searched for "cache" | Search failed | 12 results |
| Open a web page | globe | Opening example.org | Opened example.org | Couldn't open example.org | the page title |
| Run a command | terminal | Running mv | Ran mv | mv failed | exit 0, or the path |
| Run a command, awaiting approval | terminal | Wants to run mv | | | the path |
| Run a command, denied | terminal | | Didn't run mv | | the path |
| Reasoning | dot between arcs | Thinking | Thought | | its first line, in the interface face |
| Message a bot | speech | Messaging Marlow | Messaged Marlow | Couldn't message Marlow | the card's state, lower case |
| Hand off to T3 Code | code brackets | Messaging T3 Code | Messaged T3 Code | Couldn't reach T3 Code | what the result says, for example "accepted, thread 18" |
| Save to memory | bookmark | Saving to memory | Saved to memory | Couldn't save to memory | the first words saved |
| Any other tool | diamond | Using <the gateway's title> | Used <title> | <title> failed | the first argument |
| A call a rule denied | the tool's icon | | Blocked by policy | | the call. Status "Not run", shown as failed. (F-334) |

A truncated title shows in full on hover. (F-430)

**Open**, only that step opens. Others keep updating, new ones keep arriving, and nothing above it moves. (F-293) It has two views, switched by a two-part control at the top (a tab list: Readable, Raw):

- **Readable.** The inputs as label and value rows, then the result. A running step shows its output as the gateway streams it, with the streaming caret, under "Output so far". (F-432)
- **Raw.** What the gateway sent. For a tool call: the exact tool name, the arguments, the result or the error, the timing (started, ended, took) and the identifiers (tool call, item, run, session). For reasoning, a message or an approval: the event as received and its identifiers, with no invented tool fields. Every value has a copy button. (F-093, F-094)

A reasoning step's readable view is its text, 14 px, `--text-muted`, at most 62 characters wide.

**Long output** shows eight lines and fades out, with "Show all 214 lines" under it. Shown in full, the block scrolls inside itself up to 280 px. Copy always copies all of it. Output is never loaded until the step is opened.

**Copy.** A copy button turns into a check for 1.4 s. On touch, touch and hold on a step offers "Copy result", which copies exactly the result text the readable view shows, and "Copy raw". (F-093, F-431)

**When detail is missing.** A step rebuilt from history after a reconnect may lack timing; the status then shows nothing where the duration would be, never zero. When the gateway exposes no reasoning there are no Thought steps and nothing else changes.

**Keyboard.** Tab moves through the steps in order, Enter opens one, and inside it Tab goes to the view control, the copy buttons, and "Show all". The view control follows the tab pattern: Left and Right change the view.

## 8. The Messaged card

One card for each message a bot sends to another bot. It sits in the transcript where the message was sent, stays when the activity block is folded, and the same message is also a step in the block. (F-119, F-439)

**Folded**, one line, 40 px (44 on touch): the word "Messaged", the recipient's avatar at 20 px and name, the first line of the message in `--text-muted`, and the state at the right with its mark. (F-122)

| State | Mark and colour | Moves there when |
|---|---|---|
| Sending | sending | The send call started |
| Waiting for approval | waiting, `--warn` | The sender's outgoing policy is "ask me" and an approval card is pending (F-312) |
| Sent | check | The call returned successfully |
| Working | working, `--accent` | The recipient's run for this message is queued, running or stopping |
| Recipient waiting | waiting, `--warn` | That run is waiting on its user |
| No reply yet | queued | That run completed without a reply. A later reply still moves it on. |
| Unknown | hollow ring | The sender was stopped and the gateway could not say whether the call completed |
| Replied | check, `--accent` | A correlated reply arrived |
| Failed | failed, `--danger` | The call returned an error, or the recipient's run failed |
| Blocked by policy | failed, `--danger` | A messaging policy forbade it (F-311) |
| Not sent | stopped | The approval was denied, or the sender was stopped before the call returned (F-436) |
| Recipient stopped | stopped | The recipient's run ended as stopped or cancelled without a reply (F-434) |

A card moves only forward through this list. A late event for an earlier state never moves it back, and the last five states are final. Two events belong to one card only when the gateway's identifiers say so; a replayed event updates the card it names. (F-309, F-435, F-469)

**Open**, in place (F-121):

- What was sent: the sender's avatar and name, "sent" and the time, then the exact text on a `--bg-pane` inset. Attachments are chips under it. (F-123, F-128)
- What came back: the recipient's avatar and name, "replied" and the time, then the reply on an inset. While the recipient works, this slot holds the recipient's live status line, its avatar at 22 px with its state and its phrase, updating as its steps change. (F-438) On failure it holds one sentence saying what happened.
- Actions: "Open in Marlow", "Open full exchange", and at the right "Raw". (F-124, F-308)

"Open in <Bot>" goes to the recipient's task for this message; going back returns here at the same place with the card still open. "Open full exchange" shows every message between the two bots in this task, read-only, and its Close returns to the card, still open. "Raw" shows the tool call as received.

**The receiving side.** The recipient's task starts the run with a "Message from <Bot>" card. It is the same component with the sender in the name slot, and its state is the recipient's own run: Working, Waiting for you, Replied, Completed, Failed, Stopped. Its "Open in <Bot>" goes to the sender's task at the matching card. (F-120, F-437, F-469)

**Lines that are not cards.** A message a bot did not ask for arrives as an event line, "Message from" with the avatar and name. A count line, "2 messages with Otto", stands for an exchange that has no card of its own. (F-120, F-125)

**Input.** Click, tap or Enter opens and closes the card. Touch and hold offers "Copy message" and "Copy raw". (F-440)

**Elsewhere.** While the recipient works, its avatar in the rail is working and its row says so. (F-126)

## 9. The Messaged T3 Code card

The same component, for work a bot sends to T3 Code. It is drawn only from the bot's own tool events on the gateway. The app never connects to T3 Code and has no setting for it. (F-132, F-138)

**Identity.** The text "T3 Code" and a mark drawn for Clawtrate: code brackets in a 20 px rounded tile on `--bg-inverse`. No third-party logo.

| State | Mark | Moves there when |
|---|---|---|
| Sending | sending | The tool call started |
| Sent | check | The call returned and its result says the work was accepted |
| Delivery unknown | hollow ring | The bot was stopped before the call returned and the gateway cannot say whether it completed |
| Done | check, `--accent` | A correlated tool result carries a final result |
| Failed | failed, `--danger` | The call or a correlated result returned an error (F-314) |
| Not sent | stopped | The bot was stopped before the call returned and the gateway confirms it was not made |

Forward only; Done, Failed and Not sent are final. After Sent the card changes only when a later tool event carries identifiers that name it. With no such identifier each call is its own card, and nothing is matched by project or thread name. (F-134, F-313, F-441, F-442, F-443, F-470)

**Open:**

- What was sent: the exact text from the tool call's arguments, and under it a chip for each target field the arguments contain (project, thread, branch). A field that is absent has no chip. (F-133)
- What came back: the result text and its time. At Sent with nothing more: "Thread 18. No result yet. This card changes only if Otto checks on the work." At Failed: the error text.
- Files, as chips, only when the tool result or a gateway attachment carries them. (F-135)
- "Open thread", only when the tool result carries a link. It opens in the system browser when chosen, and nothing is fetched before that. (F-135)
- "Raw": the tool call and result as received.

**When the bot is stopped** after the work was sent, the card keeps its state and adds a line in medium weight: "Work already sent to T3 Code continues there." The stop note says the same. (F-137)

Touch and hold offers "Copy sent text" and "Copy raw". (F-444) The Work pane's Coding section lists these cards across the bot's tasks; its rows use this card's folded form. (F-136)

## 10. Approval cards

**Pending.** A card with a 1.5 px `--warn-line` outline, the one loud thing in a quiet transcript.

- **Title** (17 px, semibold): "<Bot> wants to run a command", "<Bot> wants to message Marlow". The title names the bot and the kind of action. (F-163)
- **Tag**, top right: "Needs approval" on `--warn-soft`.
- **Summary** (15 px): one sentence saying what will happen, with the machine in bold.
- **Warnings**, when the gateway gives them, each on its own line in `--warn` with a triangle: "This can't be undone", "This changes sign-in or security settings", "This shares your data outside this chat". (F-171)
- **"Show full request"**: opens an inset with the reason, the exact command in mono with a copy button, label and value rows (runs on, folder, asked by), and "Raw". It reads "Hide full request" when open. (F-164)
- **Buttons**, 36 px (48 and stacked on touch): "Allow once" (primary), "Always allow…" (default), and at the far right "Deny" (quiet). Deny is always there. (F-163, F-170, F-329)
- **A footer line** when the card will expire or came from somewhere other than this conversation: "Asked by the routine Weekly cleanup. Expires in 28 minutes; the command is not run if it does." (F-168)

When the gateway offers no rule to save, the buttons are "Allow" and "Deny". (F-329)

**"Always allow…"** replaces the buttons with a form on an inset, so a standing permission is never granted without seeing what it covers:

| Row | Control |
|---|---|
| Rule | The exact rule the gateway would save, in mono. For a command this is the program and what it matches, for example "/bin/mv, any arguments, on media-box". |
| Applies to | "<Bot> only" or "All bots" |
| Lasts | "1 hour", "1 day" or "Until I revoke" |

Below it one sentence states the result in words and changes as the choices change: "Otto can do this without asking until this time tomorrow. You can revoke it in Permissions." Then "Allow and save rule" (primary) and "Back". (F-166, F-167)

**Resolved**, the card folds to one line, 40 px: a tag, the summary, the time, and a chevron.

| Tag | When | Sentence when opened |
|---|---|---|
| Allowed once (`--accent`) | Allow once | Otto ran this once. It will ask again next time. (F-325) |
| Always allowed (`--accent`) | Allow and save rule | Otto ran this, and can run it again without asking until tomorrow, 5:25 PM. Then the rule, its scope and "Revoke". (F-166) |
| Denied | Deny | Otto won't do this, and won't ask again until you send another message. (F-165) |
| Expired | It was not answered in time | The command was not run. (F-168) |
| Closed by your message | You sent a steer | Your message closed this request. The command was not run. (F-169) |
| Closed: the run ended | The run finished first | The command was not run. (F-418) |
| Closed: the run failed | The run failed first | The command was not run. |
| Cancelled | You pressed Stop | You stopped the run before answering. The command was not run. |

Opened, a resolved card also shows the full request. When saving the rule pushed out an older one, the sentence adds "Replaced the oldest rule: '…'". (F-416)

**A call a rule denied** never becomes a card. It appears as a failed step, "Blocked by policy", naming the rule. (F-334)

**Keyboard.** The card does not take focus when it arrives. "Review" on the composer's shelf, or ⌘J, moves focus to it. Tab order inside: Show full request, Allow once, Always allow…, Deny. With focus anywhere in the card, ⌘↵ is Allow once and Escape closes the form. Deny has no shortcut. Scope and duration are radio groups: arrow keys move, Space chooses.

**Phone.** Tapping the card opens the full request. The buttons are full width, stacked, in the same order. (F-172, F-251)

## 11. Question cards

**Pending.** A card with no outline: questions are part of the conversation.

- **Title** (17 px, semibold), and a quiet round Dismiss button at the top right. (F-112)
- **Options** as rows on one inset with rules between them: a letter in a 24 px tile, the option, and an optional second line in `--text-muted`. Rows are 44 px (52 on touch). (F-112)
- **"Type your own answer"**: a pill field with a round send button, grey until there is text. (F-303)
- **Several answers**: "Choose all that apply." under the title; chosen rows fill their letter tile and show a check; "Send answer" (primary) is disabled until one is chosen, with "2 chosen" beside it. (F-114)

**Answered**, the card keeps its title, now in 14 px `--text-muted`, and shrinks to the chosen rows: the letter, the answer and a check. The bot does not repeat the question. (F-113)

| State | Row under the title |
|---|---|
| Answered | The letter and the answer, with a check; one row per answer |
| Answered in your own words | The text, with a check |
| Dismissed | "Dismissed". The bot is told and carries on; it may ask again. (F-302) |
| Closed | "Closed: the run ended", "Closed: the run failed" or "Cancelled" |

**Keyboard.** One answer: the options are a radio group; Up and Down move, and Enter or the option's letter answers. Several answers: the letter or Space toggles, and ⌘↵ sends. Escape dismisses, when focus is in the card.

## 12. While a bot waits on you

Quiet until something needs you; then it says so in five places at once, in the same colour and the same words.

| Place | What shows |
|---|---|
| The card | The warn outline and the "Needs approval" tag |
| The status line | "Waiting for you" in `--warn`; the avatar leaning in, with its badge (F-292) |
| The composer | A shelf row on `--warn-soft`: "Otto needs your approval to run a command", with "Review", which scrolls to the card and focuses it |
| The task row | The waiting mark |
| The bot row | The waiting avatar, and "Waiting for you: approve a command" in `--warn` (F-021) |

The Jump control reads "Needs you" when the card is out of view (section 16). When you start typing, the shelf row changes to "Sending will close Otto's approval request", because a steer closes open approval cards. (F-169) A question stays open through a steer.

It all clears the moment the last pending card is answered, expires or is dismissed.

## 13. The composer during a run

The pill from `visual-language.md`, with what a run adds. Send stays; Stop appears beside it. (F-097)

| Run | Placeholder | Controls after the text |
|---|---|---|
| None | Message Otto | Send |
| Running | Steer Otto | Stop, Send. With text: a mode word, "Steer", before them. |
| Waiting on you | Answer above, or message Otto | The same |
| Stopping | Queue a message for Otto | "Stopping…", Send |
| Offline | Offline. You can keep writing. | Send, disabled. The draft is kept. (F-073) |

- **Send** is the round `--bg-inverse` button, grey with nothing typed.
- **Stop** is a round `--bg-bubble` button holding a 10 px square. It turns `--danger-soft` on hover. Its name is "Stop <Bot>". It is there while the run is running or waiting, and gone while it is stopping.
- **The mode word** says what Enter will do during a run: "Steer" or "Queue". It is a menu button that opens upward: "Steer this turn ↵", "Queue after this turn ⌥↵", "Start as new task ⇧⌘↵". With no run, the same menu (Send, Start as new task) opens from a right-click or a long press on Send. (F-061, F-096, F-282)

**Keys.** Enter sends, or steers during a run. Shift+Enter adds a line. ⌥Enter queues. ⇧⌘Enter starts a new task with the message. ⌘. stops. ⌘I focuses the composer. (F-072)

**The shelf** is a stack of rows above the pill, each 40 px on `--bg-bubble`, newest at the bottom. A row rises 4 px over 200 ms.

| Row | Content | Actions |
|---|---|---|
| Queued message | The queued mark, "Queued" and the text | "Send now" (steers; absent while stopping), "Cancel" (F-280, F-281, F-421) |
| A queued message the gateway refused | On `--danger-soft`: "Couldn't start", the reason, the text | "Delete" |
| Needs you | Section 12 | "Review" |
| Notice | On `--danger-soft`: a title and a reason, such as "Otto failed to respond. The model provider is overloaded." | "Try again", Dismiss; "Clear all" when there are several (F-103, F-300) |

Queued messages wait on the shelf, not in the transcript, because they have not been sent. Each becomes a bubble when it starts.

**Phone.** One row: attach, the text, Stop, Send, each 40 px. There is no mode word; touch and hold on Send opens a sheet with the three ways to send.

## 14. Stop

1. Pressing Stop, or ⌘., moves the run to stopping. The phrase reads "Stopping…", Stop leaves the composer, pending cards close as "Cancelled", and a message sent now is queued. (F-097, F-421)
2. When the gateway confirms, the status line leaves and a note takes its place.

The note is 13 px `--text-muted`, led by the stopped mark:

> **Stopped after 40s.** Completed steps are not undone.
> - Stopped with it: Marlow's run for this message, and one command on media-box.
> - Work already sent to T3 Code continues there.

It lists every helper run, bot run and process that was stopped, and names what continues. Completed steps, cards and text stay where they are. (F-098, F-137, F-296, F-297, F-298, F-299)

If the run finished before the stop took effect, the note reads "**Finished before Stop took effect.** The turn completed normally." (F-419)

## 15. Turn errors and notes

**A failed turn** ends with a card on `--danger-soft`: a triangle, a semibold title ("Otto couldn't finish this turn"), the reason in one or two sentences, and actions: "Try again", "Copy request ID", "Raw", and a round Dismiss. It is `role="alert"`. (F-102, F-301)

- "Try again" sends the same message as a new run.
- The reason says what is known and what was not undone: "The model provider is overloaded. Nothing ran after step 4, and steps already completed are not undone."
- A rate limit retries by itself first, and the status line says so. The card appears only when the retries are used up.
- Reply text that had begun stays, captioned "Incomplete".

**Notes** use the Stop note's form.

| Note | Text |
|---|---|
| Turn limit | **Stopped at the 50 minute turn limit** so it would not hang. Send a message to pick up where it left off. (F-100) |
| Timeouts | **Stopped after 3 tool calls in a row timed out.** media-box may not be responding. (F-101) |

## 16. Jump to latest

This is the shell's `.jump-latest` control (see `visual-language.md`), with the states a run needs. New output is followed only when the reader is within 96 px of the end. Otherwise the reader's place holds, and the control appears, centred 10 px above the foot of the transcript: a pill on `--bg-raised` with `--shadow-pop`, 36 px (40 on touch), at most 380 px wide. It rises 6 px and fades in over 200 ms.

| State | Content |
|---|---|
| New output, no run | "Jump to latest", or "3 new", and a down arrow |
| A run is active | The bot's avatar at 20 px with its state, the current phrase, and a down arrow |
| A card is pending | The waiting mark, "Needs you" in `--warn`, and an arrow pointing to the card, up or down |

Choosing it scrolls to the end, or to the pending card and focuses it, and the control leaves. It also leaves when the reader scrolls back to the end.

The same rule holds when things change above the reader: a block folding at the end of a run, a card resolving, older messages loading, the Work pane docking. The message at the top of the view stays where it is.

## 17. After a reconnect

The status strip reports the connection from the protected band under the title pill (`visual-language.md`, sections 8 and 11), so it never sits over message text and nothing reflows when it comes and goes. One state drives the strip, the rail's footer, the status line and the composer. For a conversation that was mid-run:

| Moment | Strip | Status line | Composer |
|---|---|---|---|
| The connection drops | **Reconnecting** · showing saved messages, with "Retry now" | Stays, and stops moving: the avatar is blocked, the phrase reads "Reconnecting. Last seen reading the backup log", the elapsed time is hidden | "Offline. You can keep writing."; send disabled |
| Reconnected, fetching | **Connected** · catching up | Unchanged | Unchanged |
| Caught up | **Synced** · 3 new in this task, for 4 seconds; "Synced" alone when nothing was missed | Shows the run's real state again | Back to the run's state |
| The fetch failed | **Couldn't sync this task**, with "Try again" | Unchanged | Unchanged |

- The app does not animate what it cannot see: while disconnected no ring orbits and no phrase shimmers.
- What was missed is fetched again and merged in place, without enter animations. No message, step or card appears twice: each is matched by its identifiers and updates the one already on screen. (F-107, F-442)
- Nothing unmounts and nothing the reader had opened folds: an open block, an open step with its chosen view, and an open card all survive. (F-104)
- The reader's place holds. New items below the fold bring up Jump to latest.
- If the fetch fails, what was on screen stays. (F-105)

In the prototype, "Drop the connection" in the bar shows all of this during the scripted run.

## 18. Rows in the rail

The rail's arrangement, the folded-bot rule and the task rows are defined in `visual-language.md`, section 7. This section adds the states a run brings.

**A bot row** speaks for all of the bot's tasks through three independent signals, so work in one task never hides news in another:

| Signal | Shows | Comes from |
|---|---|---|
| The avatar's state | The face, ring and badge of section 3 | The most urgent state among the bot's tasks: waiting for you, failed or blocked, done with failures, working, done, idle (F-426) |
| Line two and the time | What the bot last said or is doing now | The latest activity in any task |
| The unread dot | An 8 px accent dot at the end of line two | Any unread task other than the one on screen (F-022) |

With the state avatar, the run-state mark that the plain shell puts at the start of line two moves onto the avatar: the ring for working, the badge for waiting, blocked and failed.

| Bot's state | Avatar | Line two | Time |
|---|---|---|---|
| working | working, with the ring | The current phrase, `--text-muted` | now |
| thinking | thinking | Thinking | now |
| waiting for you | waiting, with its badge | "Waiting for you: approve a command" or "…: a question", in `--warn` (F-021) | since it began waiting |
| blocked | blocked, with its badge | "Can't reach media-box", in `--warn` | |
| failed | failed, with its badge | "Couldn't finish: provider overloaded", in `--danger` | |
| done with failures | done, with the failed badge | "Finished with 1 failed step", in `--danger`, and the unread dot (F-295) | |
| done, unread | done | The latest message, and the unread dot | |
| idle | idle | The latest message | |

A bot working in one task while another task is unread shows the working avatar, the working task's phrase and the unread dot together. The row's accessible name is "<Bot>, <state>", with ", unread" when it applies. (F-020) A pinned tile shows the same avatar state, with the unread dot beside the name.

**A task row** is its title and at most one mark at the right. (F-057)

| Task | Mark | Title | Accessible name ends |
|---|---|---|---|
| working | working | `--text` | ", working" |
| waiting for you | waiting | `--text` | ", needs you" |
| blocked | blocked | | ", blocked" |
| failed | failed | | ", last run failed" |
| done with failures | failed | | ", done with failures" |
| done, unread | unread dot | `--text` | ", unread" |
| queued | queued | | ", queued" |
| idle | none | `--text-muted` | |

A task's state is always a mark and never a word, because warn-coloured text is not allowed on the selected task's fill (`visual-language.md`, section 13). Opening a task clears done, done with failures and their marks. (F-022, F-295)

**The phone** uses the same rows at touch sizes: 44 px avatars, 44 px task rows.

## 19. What the gateway's events drive

Names are from `docs/research/gateway-capabilities.md`. The connection must advertise `tool-events`, `approvals` and `exec-approvals`.

| Shown | Driven by |
|---|---|
| A run starts | `chat.send` returning a run id; `agent` stream `lifecycle`, phase `start` |
| Status phases, retries | `chat` state `status`, with `phase` and `retry` |
| Reasoning steps | `agent` stream `thinking`. Absent when the model reports none or visibility is off. |
| A step starts, updates, ends | `agent` streams `item` and `tool`, phases start, update, result |
| Output as it arrives | `agent` stream `tool` phase `update`; stream `command_output` |
| A failed step | A tool result with `isError` |
| Reply text | `chat` state `delta`, then `final` |
| A card is pending | `exec.approval.requested`, `plugin.approval.requested`; lifecycle phase `waiting-approval` |
| A card is answered | `exec.approval.resolved`; lifecycle phase `approval-resolved` |
| Messaged card | A tool event named `sessions_send`: the target from its arguments, the reply and the recipient's run id from its result; the recipient's run from that run's own events |
| Messaged T3 Code card | A tool event whose name starts with the configured server's prefix, or whose result names that server |
| The run ends | `chat` state `final`, `aborted` or `error`; lifecycle phase `end` or `error` |
| A gap | A jump in the event sequence, or a reconnect: reload the history |

Three things depend on the gateway more than the rest:

- **Questions.** The capability map lists the question methods and their scope but not their events. Where a gateway gives the client no question event, the bot's question arrives as an ordinary message and is answered in the composer.
- **Expiry of a standing allow.** The map shows grants expiring in whole days. "1 hour" needs a finer expiry from the gateway or a plugin; until then the Lasts row offers only what the gateway can keep.
- **The recipient's state on a Messaged card.** Working and Recipient waiting need the recipient's run to be identifiable before the send returns. Where it is not, the card goes from Sending to Replied.

## 20. Where this goes beyond the proposals

The proposals say what must be true. These are the places where this design adds a state, a rule or a control they do not have, or reads one differently.

| What | In the proposals | Here |
|---|---|---|
| Avatar states | Six: idle, thinking, working, waiting, blocked, done | Eight: failed and stopped are added. Failed shares blocked's place in the priority order and its slumped face, with its own badge. Stopped is the idle face with a square badge until the next run or until the task is opened. |
| Avatars with a picture | Not addressed | The ring and the badge carry the state, since there is no face to move. |
| An approval as a step | Every approval is a step | An approval for a tool call is that step's waiting status; only an approval with no tool call is a step of its own. A command that needed approval is counted once. |
| The activity block when a run ends | Its open or folded state is kept while steps arrive, across scrolling and across tasks | The same, and in addition an open block folds when the run ends unless a step in it is open or focus is inside it. |
| Status phrases | "Thinking", the running step's summary, "Waiting for you", "Stopping…" | The same, plus phrases for the gateway's own status phases, retries, an unreachable machine and a lost connection (section 4). |
| Elapsed time | Not addressed | Shown on the status line, counting from the send. |
| Where the Send menu lives | On the Send button | During a run, on a mode word beside Send ("Steer" or "Queue"); with no run, on a right-click or long press of Send. |
| Queued messages | A "Queued" chip on the message | A row on a shelf above the composer, with "Send now" and "Cancel"; the message enters the transcript when it starts. |
| A steer that the gateway turns into a restart | Not addressed | The caption reads "Steer · restarted the turn". |
| Jump to latest | Not addressed | Three states: new output, a live run, a pending card (section 16). |
| A reconnect during a run | The strip and the refetch | Also: the status line stops moving and says what it last saw (section 17). |
| A standing allow's duration | 1 hour, 1 day, until revoked | The same three, with the note that the gateway's grants are in whole days today (section 19). |

Every run state in section 5.6, every Messaged and T3 Code card state in sections 6.1 and 6.2, the receiving side's six states and the permission order in section 8.8 are shown as written. None is dropped.

## 21. Not covered here

- Group chats, and approval cards inside them (F-080, F-179, F-289, F-290).
- Secure Form, Computer, draft, file and link cards. They use the card frame here: `--bg-bubble`, radius 18, a 17 px title, a tag at the top right, buttons along the foot.
- The Permissions page, where a standing allow is revoked (F-178, F-324).
- The Work pane's Coding section, beyond the card form its rows use (F-136).
