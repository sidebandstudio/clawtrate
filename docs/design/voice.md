# Voice

Speaking to a bot instead of typing: dictation into the composer, a voice chat with a bot, the voice, speed and language of a call, the line a call leaves in the conversation, a bot's voice memos, and the microphone setting. This part of the design builds on `visual-language.md` and `conversation.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-111, F-253 to F-255, F-392, F-407 to F-413 and F-460 to F-463. What the gateway, the operating systems and the browser engine do is in `docs/research/voice.md` (cited as research §n); every state below names the fact it rests on, and section 13 lists them. Section 15 is for builders.

One rule sits above the rest: **before the microphone first opens for a route, the screen names where the audio goes, and the app never sends it anywhere else.** Nothing is called private. "Mute" and "Hang up" say what happened on this device, and say more only when the gateway answered.

Six facts from the research shape the design:

- **A call is relayed through the gateway, or it is not made** (research §2). On a relayed call the audio goes from this device to the person's gateway over the connection Clawtrate already holds, and the gateway sends it on to the voice provider it names. The other route the gateway offers, a client-owned call, has the device connect to the provider's own host; Clawtrate does not use it, because the app contacts no host but the gateway by itself.
- **A relayed call ends with its connection, and after 30 minutes** (research §5). The gateway closes every call a connection owned when that connection closes, so a call is never resumed after a drop. The app reconnects to the gateway by itself, as it always does, and the person starts a new call.
- **What was said is saved in the task as text** (research §6). Each finalized utterance becomes an ordinary message, marked as spoken. Every device sees it. Only the device that held the call knows how long it lasted.
- **The gateway says whether voice is set up, at the read tier** (research §1). `talk.catalog` answers `ready` for voice chat and for dictation through the gateway, and names the provider. A read-only connection is refused every call and every gateway dictation with `operator.talk` missing.
- **Dictation has two routes with a stated destination** (research §3): Apple's recognizer on this Mac or iPhone, with on-device recognition required, and the gateway's transcription session. Chromium's own speech recognition is not used: it sends audio to a Google service. Windows has the gateway route only.
- **Speed is the device's, language is fixed when a call starts, and a voice changes only on a call** (research §7). There are no word timings for a memo (research §8).

The prototype walks every path to its outcome: `prototype/voice.html`, with the state in the address (section 15). Its styles are in `prototype/css/voice.css`, its behaviour in `prototype/js/voice.js`, and `prototype/tools/checks/voice.mjs` clicks through every walk and asserts each state's words and structure. The system's own microphone prompt is drawn as Clawtrate's picture of one, labelled as a picture.

## Contents

1. How the pieces fit
2. Shared rules: components, where the audio goes, where settings are kept, access, the microphone, widths and input, announcements
3. The two buttons in the composer
4. Dictation
5. Starting a voice chat
6. On a call
7. Voice, speed and language
8. Ending a call, and a call that fails
9. One call at a time
10. After a call: the "Voice chat" line
11. Voice memos
12. Settings, Voice
13. What each fact drives
14. Parity rows
15. For builders
16. Not covered here

## 1. How the pieces fit

```
composer action area (owned by #18)     [mic]  [waveform, only while the draft is empty]  [send]
  mic                                    dictation (section 4): text into the draft, unsent
  waveform                               voice chat (section 5): the call band above the composer
call band                                bot, phase, time on this device, microphone mark,
                                         Mute, Transcript, Settings, Hang up (section 6)
transcript                               the "Voice chat" line after a call (section 10),
                                         a bot's voice memo card (section 11)
Settings › Voice                         microphone, dictation route, what voice chat uses (section 12)
iPhone entry points                      Siri and Shortcuts "Start Dictation" and "Start Voice Chat",
                                         the Action Button (section 5, "Entry points")
```

The composer is the maintainers' (#18). This design adds two buttons to its existing action area and says what their states are and what dictated text does in the draft; nothing else of the composer changes. The call band is a new surface between the transcript and the composer, not part of the composer.

## 2. Shared rules

### Components used

| Thing | From |
|---|---|
| The composer, its action area, its draft | `conversation.md` section 13 (fixed; #18) |
| Round icon buttons, quiet and pressed | `visual-language.md` section 4 |
| The access bar and "Request access" | `conversation.md` section 3 |
| The status strip and reconnecting | `visual-language.md` section 8 |
| Event lines in the transcript | `conversation.md` section 2 |
| The audio card and its player | `work-pane.md` section 12 (F-117) |
| A small dialog with a title, one paragraph and two buttons | The stop confirmation, `work-pane.md` section 18 |
| Settings, a section, rows and choice rows | `bots.md` section 7 |
| The menu surface | `.menu`, `visual-language.md` section 4 |

### New components

| Component | Class | Section |
|---|---|---|
| The microphone button and its listening state | `.mic-button` | 3, 4 |
| The voice chat button | `.call-button` | 3, 5 |
| Where the audio goes, before the first use | `.voice-consent` | 2, 4, 5 |
| The call band | `.call-band` | 6 |
| The microphone mark | `.mic-mark` | 2 |
| The call's settings | `.call-settings` | 7 |
| The live transcript | `.call-transcript` | 6 |
| The "Voice chat" line | `.call-line` | 10 |
| The memo's text and speed | `.memo-text`, `.speed` | 11 |

### Tokens

No new token. The microphone mark is `--danger` (a filled dot) while the microphone is open, and the hollow ring in `--text-faint` while it is not; the word beside it says which, so colour is never the only cue. The call band is `--bg-bubble` with a hairline, radius 18; failed, it is `--danger-soft`.

### Where the audio goes

Every route has one sentence, said before its first use (the consent sheet, sections 4 and 5) and always in Settings › Voice (section 12). The gateway's name is its name in the rail's footer; the provider's is its `label` in `talk.catalog`, shown as text.

| Route | The sentence | Rests on |
|---|---|---|
| Voice chat | "Your voice goes to Home gateway over this connection, and the gateway sends it to OpenAI Realtime Voice, which listens and speaks Otto's replies. What you both say is saved as text in this task. Clawtrate doesn't keep the recording." | research §2, §6 |
| Dictation through the gateway | "Your voice goes to Home gateway, which sends it to OpenAI Realtime Transcription and sends the text back. Nothing of it is saved in the task. Clawtrate doesn't keep the recording." | research §3 |
| Dictation on this Mac (or iPhone) | "Apple's speech recognition turns your voice into text on this Mac, with its network use turned off. It's offered only for languages this Mac can recognize on its own." | research §3 |

"Clawtrate doesn't keep the recording" is a rule for the builder: no audio is written to disk, to a log, to a crash report or to the bridge's history (section 15). Nothing here says what the gateway or the provider keep: the gateway saves the text (research §6), and what a provider does is the provider's.

A route whose destination cannot be stated is not offered: Chromium's speech recognition, and on-device dictation on Windows (research §3).

The consent sheet is shown once per route, per gateway and per provider, on this device; it is shown again when the provider's label changes. Its buttons are the route's action ("Start voice chat", "Start dictation") and "Cancel". Nothing opens the microphone before the person chooses the action.

### Where settings are kept

Every voice setting is this device's, kept by the host per gateway identity (`gateway.identity.get`) and per bot, and never written to the gateway: none of them has a gateway setting (research §7). Each control says so in one line: "Kept on this device for Otto." Another device of the same person has its own.

| Setting | Kept |
|---|---|
| The microphone | per device |
| The dictation route | per device and gateway |
| Each bot's voice, speed and language | per device, gateway and bot |
| A call's duration, for its line | per device, for calls it held (section 10) |
| "Where your voice goes" seen | per device, gateway, route and provider |

### Access

| Connection | Dictation on the device | Dictation through the gateway | Voice chat | Playing a memo |
|---|---|---|---|---|
| Read-only | Works: it needs no gateway | The access bar: "Dictating through the gateway needs more access." | The access bar: "A voice chat needs more access." | Works |
| Interactive tier | Works | Works when set up | Works when set up | Works |

The interactive tier (`operator.write`) satisfies `operator.talk`; Clawtrate never asks for `operator.talk` alone or for admin (`docs/decisions.md`, "Scopes, in tiers"). The buttons are present on a read-only connection; pressing one shows the access bar in the composer's place, as everywhere else. On a read-only connection the draft is never shown (`conversation.md` section 3), so on-device dictation is offered only where a draft exists: on a read-only connection, nowhere.

### The microphone

- **At most one route has the microphone at a time.** Starting a call while dictating stops dictation and keeps its text; the microphone button is disabled during a call ("The microphone is in use by the voice chat.").
- **While the microphone is open there is always a mark**: in the microphone button while dictating, in the call band while on a call, with the words "Microphone on" or "Microphone off". The system's own indicator is the system's.
- **The system's prompt** (macOS, the first time; never on Windows, research §4): while it is open the button or band says "Waiting for microphone access…". Refused: "Clawtrate can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone." with "Open System Settings". On Windows, when the device can't be opened: "Clawtrate can't use the microphone. Check Settings › Privacy & security › Microphone." Nothing else is recorded or sent.
- **No microphone**: "No microphone found."
- **The chosen microphone is not connected**: "USB Microphone isn't connected." with "Use System Default this time" and "Choose another". It never uses another microphone silently (section 12).
- **The browser preview from another computer over plain http** has no microphone (research §4): both buttons are disabled, with the description "This page can't use a microphone: a browser allows one only over https or on this computer itself." From `localhost`, the browser's own prompt applies, drawn as "Waiting for microphone access…".

### Widths, themes, keyboard, screen readers, motion

- Every surface here is drawn at 1440, 1100, 800 and the 390 px one-pane layout, light and dark, in the product's tokens; at 390 the controls take touch sizes (44 px).
- Keyboard: every control is a button or a radio group; the call band's actions are in reading order (Mute, Transcript, Settings, Hang up); the call's settings and the consent sheet trap focus and return it to what opened them; Escape closes them.
- Screen readers: the band is a `region` named "Voice chat with Otto"; the microphone mark's words are its text, not only its colour; the live transcript is a `log`; disabled buttons carry their reason as a description.
- Motion: the microphone mark's pulse while listening and the phase's level meter hold still under reduced motion.

### Announcements

The conversation's polite live region speaks for voice, and only for these: "Listening", "Dictation stopped. The text is in your message.", "Voice chat with Otto started", "Muted", "Unmuted", "Voice chat ended", "Voice chat failed: Connection lost" (and the other reasons), "Voice: Cedar, from Otto's next reply", "The voice didn't change". Live transcript lines are not announced; the transcript region is a `log` the person can read.

## 3. The two buttons in the composer

Both sit in the composer's existing action area, left of Send, 32 px round icon buttons (44 on touch), quiet.

| Button | Label | Shown | States |
|---|---|---|---|
| Microphone | "Start dictation" (⌘D, Ctrl+D off the Mac) | Always, where a draft exists | Ready; Listening (filled `--danger`, "Stop dictation"); Disabled with a reason (during a call; not set up; no microphone; a page over plain http) |
| Voice chat (the waveform) | "Start voice chat" | Only while the draft is empty (F-254); typing hides it, clearing shows it again | Ready; "In a voice chat" while this task's bot is on a call (pressed; it moves focus to the call band); Disabled with a reason (not set up; a page over plain http) |

A disabled button keeps focus and its reason as its description, so a keyboard or screen reader user hears why. "Not set up" and "Can't tell" come from `talk.catalog` (section 5).

**Keys.** ⌘D starts and stops dictation while the composer is on screen and no dialog is open. Held for more than 400 ms it is hold to talk: dictation stops when the key is released. Pressing and holding the microphone button does the same. Escape stops dictation and keeps the text. In a browser, ⌘D and Ctrl+D bookmark the page; the web preview asks for them and the button always works. Voice chat has no shortcut. None of this changes the composer's own keys (#18); ⌘D is taken by nothing in the app (research §9).

## 4. Dictation

### Choosing the route

The first press opens the consent sheet for dictation, which lists the routes this device has, each a choice row with its sentence (section 2):

| Device | Routes listed |
|---|---|
| Mac, with a language the recognizer supports on its own | "On this Mac" and "Through Home gateway" (when the gateway's transcription is ready) |
| Mac, without one | "Through Home gateway" only, with "On this Mac isn't available for English (United States): this Mac can't recognize it without the network." |
| Windows | "Through Home gateway" only, with "Windows has no speech recognition Clawtrate can use without sending your voice to Microsoft." |
| iPhone | "On this iPhone", and "Through Home gateway" |
| Neither available | The sheet says "Dictation isn't available here" with the reasons, and offers only "Close". The button is then disabled with the same reason. |

The choice is kept (section 2) and changed in Settings › Voice. A read-only connection lists the gateway route with "Needs more access" and no choice row for it.

### Listening

- The button turns `--danger` with "Stop dictation", and the microphone mark beside the draft says "Listening · Microphone on".
- Text goes in at the caret, through the composer's own way of changing its draft. Words not yet final are shown in `--text-faint` with a dotted underline; final words take the draft's colour. On the gateway route partial and final words are `transcript.delta` and `transcript.done` (research §3); on the device, the recognizer's partial and final results.
- The text is the draft's: editable, unsent, kept with the draft as typed text is (#18). Dictation never sends.
- Stopping: the button, ⌘D, Escape, releasing the held key, sending the message (dictation stops first and its final words stay in the message), leaving the task, closing the window, the app going to the background on the iPhone. The region says "Dictation stopped. The text is in your message."
- The gateway route closes its session with `talk.session.close` when dictation stops, and the gateway closes it anyway when the connection ends or after 30 minutes (research §5). A session that ends while listening ("Dictation stopped: Home gateway ended it.") keeps the words already in the draft.

### When dictation can't start

| Cause | What the button and its line say | Rests on |
|---|---|---|
| The gateway's transcription isn't set up | "Dictation through Home gateway isn't set up on the gateway." | `talk.catalog` `transcription.ready: false`; create answers `UNAVAILABLE` "No realtime transcription provider registered" (research §1) |
| Read-only | The access bar, "Dictating through the gateway needs more access." | `MISSING_SCOPE operator.talk` |
| Not connected (gateway route) | "Not connected to Home gateway." | The connection's state |
| The gateway refused for another reason | "Couldn't start dictation: <the gateway's message, as text>." with "Try again" | The create's error |
| The microphone | Section 2 | research §4 |

## 5. Starting a voice chat

### What the button finds first

The client reads `talk.catalog` after every hello and when Settings › Voice opens (research §1).

| The catalog says | The voice chat button | Pressing it |
|---|---|---|
| `realtime.ready: true`, its active provider offers `gateway-relay` | Ready | Starts (below) |
| `realtime.ready: false` | Disabled: "Voice chat isn't set up on Home gateway." | Nothing |
| Ready, but the active provider offers no `gateway-relay` | Disabled: "Home gateway's voice provider talks to apps directly, which Clawtrate doesn't do." | Nothing |
| Couldn't be read (`AGENT_SELECTION_REQUIRED`, a failure) | Ready, described "Can't tell whether voice chat is set up on Home gateway." | Starts; the create's answer says |
| Read-only connection | Ready | The access bar |

The not-set-up sentence is all the client can establish: the provider is set up by the gateway's owner in OpenClaw's own Talk settings, which need admin (research §1). Settings › Voice says that much.

### The walk

1. **Where your voice goes**, the first time (section 2). "Cancel" returns focus to the button and nothing opens.
2. **The microphone.** If the system must ask: "Waiting for microphone access…" in the call band, with "Cancel". Refused or no device: section 2, and nothing is sent to the gateway.
3. **Connecting.** `talk.session.create {sessionKey, voice?, language?, capabilities: ["voice-selection"]}` for the open task (research §2, §7). The band says "Connecting to Otto…" with "Cancel". The microphone is open from step 2, the mark says "Microphone on", and no audio is sent until the gateway answers.
4. **Ready.** The answer, then the session's `ready` event: the band says "Listening", the time starts, and the region says "Voice chat with Otto started".

| At step 3 the gateway answers | The band |
|---|---|
| `UNAVAILABLE` with `talkIssue.code: "realtime_unavailable"` | "Voice chat failed", "The call ended unexpectedly", and the gateway's message as text: "Realtime voice provider "openai" is not configured." (live, research §1) |
| "Too many active realtime relay sessions…" | "Voice chat failed", "The call ended unexpectedly", "Home gateway has too many calls open right now." |
| No answer and the connection drops | "Voice chat failed", "Connection lost" (section 8) |
| Not connected when pressed | "Voice chat failed", "No connection" |

A call is started only on the open task, so the bot is the task's (`sessionKey` selects it; research §2, the map's section 17).

### Entry points (iPhone)

Siri, Shortcuts and the Action Button only open states this design already has (F-407, F-408, F-460):

| Entry point | Opens |
|---|---|
| "Start Dictation" (Siri, Shortcuts) | The last open task's composer, dictating on the iPhone route; the consent sheet if it was never chosen |
| "Start Voice Chat" (Siri, Shortcuts), with a bot | That bot's last task, and step 1 or 2 of the walk above |
| The Action Button, "Start Voice Chat" | The same; pressed during a call, it hangs up (section 8) |

No system screen is drawn here: the system draws its own.

## 6. On a call

```
call-band   [Otto]  Voice chat with Otto · Listening              2:14 on this device
            ● Microphone on       Mute   Transcript   Settings          Hang up
```

- **Phase** from the relay's `talk.event` frames (research §2): "Listening" after `ready` and between replies; "Thinking" from `responseStarted` until audio; "Otto is speaking" while reply audio plays here. Nothing else is claimed.
- **Time** is counted on this device from `ready`, and labelled "on this device".
- **The microphone mark**: "Microphone on", or "Microphone off" while muted.
- **Mute** (`aria-pressed`): the device stops capturing and sends nothing, and the microphone is released. The band says "Muted. This device's microphone is off." and the button reads "Unmute". Unmuting opens the microphone again (the chosen one; section 2 if it is gone). The gateway is not told: muting is this device's.
- **Transcript** opens the live transcript under the band, a `log`: "You" and "Otto" lines from the frames' transcript events, words not yet final in `--text-faint`. Under it: "Saved in this task as it's said." The saved messages appear in the conversation as history brings them (section 10).
- **Settings** opens the call's settings (section 7).
- **Hang up** (`--danger`) ends the call (section 8).
- **Thirty minutes.** At 28 minutes the band adds "Home gateway ends calls after 30 minutes. This one ends at 5:59 PM." At 30 the gateway closes it (research §5): the band goes, the line is left (section 10), and the region says "Voice chat ended: Home gateway ends calls after 30 minutes."
- **The microphone goes away** during a call (its track ends; research §4): "The microphone stopped: USB Microphone was disconnected. Nothing is being sent." with "Use System Default" and "Hang up". The call stays open on the gateway until it ends by itself; nothing is sent meanwhile.
- **Typing during a call** is allowed: a message sent goes into the same task as usual.

Widths: at 1440, 1100 and 800 the band spans the conversation column above the composer. At 390 the actions wrap to a second row and Hang up keeps its place at the end; the time stays on the first row. Docked or not, the Work pane never covers it.

## 7. Voice, speed and language

The call's Settings open a `menu`-surface panel (`.call-settings`) under the band with three rows. Each says where it is kept: "Kept on this device for Otto."

### Voice (F-410)

- The list is the voices the call's provider offers for its model, from the create's answer or `talk.catalog` (`voices`, `voicesByModel`), with "Default" first, which means sending none.
- Choosing one on a call that allows it calls `talk.voice.set {voice, voiceSessionId}`. "Changing to Cedar…" while the gateway replaces the call's connection (research §7); the client answers `talk.voice.change` with a replacement session and `talk.voice.complete`. When the gateway answers: "Voice: Cedar, from Otto's next reply." Refused or failed: "The voice didn't change: <the gateway's message>." The call goes on with its voice either way.
- A call the gateway says can't change voices ("This client cannot change voices during a call", or no voice list): the row says "This call can't change voices. Cedar is used from your next call with Otto." and the choice is kept.
- The kept voice is sent as `voice` when the next call starts. If the provider no longer lists it, the call starts without it and the band says once "Cedar isn't offered by Home gateway any more, so this call uses its default voice." The kept choice returns to Default.

### Speed (F-461)

- 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2×, a radio group. It changes how fast this device plays what the bot says, at once, and nothing on the gateway (research §7). The row says "Plays at 1.5× on this device."
- The same speed applies to this bot's voice memos (section 11).

### Language (F-462)

- "Auto-detect" (sending none) or a language, sent as its two-letter code when a call starts (research §7).
- During a call the row says "Applies to your next call. A call's language is set when it starts." Changing it changes the kept choice only.
- The row also says what the gateway does with it: "Home gateway passes it to its voice provider." On dictation through the gateway it is not offered: "The gateway's dictation doesn't take a language in this version." On the device route the language is the recognizer's.

## 8. Ending a call, and a call that fails

### Hang up

| Step | The band | Rests on |
|---|---|---|
| Hang up | The microphone is released and the reply audio stops at once; "Ending…" | This device |
| The gateway answers `talk.session.close` | The band goes; the line is left (section 10); "Voice chat ended" | research §2 |
| The close fails or isn't answered | The band goes; the line is left, with under it: "Ended on this device. Home gateway didn't confirm; it ends the call when this connection closes, or after 30 minutes." | research §5 |

### A call that fails (F-411)

The band turns `--danger-soft`, says "Voice chat failed" and one reason, with "Dismiss". When the connection is back, the voice chat button offers "Start voice chat", which starts a new call.

| Reason | Second line | When |
|---|---|---|
| "Connection lost" | "The connection to Home gateway dropped, and the gateway ends a call when its connection closes. What was said is saved in this task." | The connection drops during a call (research §5) |
| "No connection" | "This device isn't connected to Home gateway. Start again when it reconnects." | Pressed while not connected |
| "The call ended unexpectedly" | "Home gateway ended the call: <its reason, as text>." | An `error` or `close` frame with reason `error` (research §2), or a refusal at the start |

**Reconnecting by itself (F-463).** The app reconnects to the gateway by itself (the status strip, as always). The call can't be resumed: the gateway closed it with the connection (research §5). So the band says "Connection lost" at once, never "Reconnecting the call", and nothing starts a new call by itself: that would open the microphone without the person asking.

## 9. One call at a time

- **This device holds at most one call** (F-412), across all its windows and tabs, since they share one connection (research §5). The gateway itself allows two per connection, and another device can hold its own call with the same bot at the same time.
- Pressing "Start voice chat" in another task while a call is on asks, in a small dialog: title "End the current voice chat?", body "You're in a voice chat with Otto. Ending it starts one with Juniper.", buttons "End and Chat" (default) and "Cancel". "End and Chat" hangs up (section 8) and, once the band has gone, starts the new call from step 1 or 2. "Cancel" leaves the call as it was and returns focus. Escape is Cancel.
- Another device sees nothing of this call while it runs: the gateway sends its frames only to the connection that holds it (research §2). It sees the saved turns arrive in the task.

## 10. After a call: the "Voice chat" line

Consecutive saved messages whose `provenance.kind` is `realtime_voice` (research §6) are folded under one line, `.call-line`, a button in the transcript where they begin:

| Where | The line | Rests on |
|---|---|---|
| The device that held the call | "Voice chat · 2:14", the duration it counted | Its own count, kept with the task (section 2) |
| Any other device, or this one without the count | "Voice chat · 6 turns · 5:31–5:36 PM" | The rows' count and their first and last `timestamp` |
| A call that saved nothing | On the device that held it: "Voice chat · 0:40 · nothing was saved". Elsewhere: nothing, since nothing is in the task | |

Pressing the line opens the transcript in place (F-111): the folded turns as the conversation's own messages, "You" and "Otto", each with its time. `aria-expanded` follows. Turns typed during the call stay between the spoken ones where they fall. The line is a heading-level landmark for moving by call.

## 11. Voice memos

A memo is an audio item a bot sent (research §8). Its card is the audio card of `work-pane.md` section 12, with two additions:

- **Speed**: the bot's speed (section 7), shown as "1×" on the player, which cycles through the speeds.
- **"Show text"**, an expander, when the item came from a `tts` call in the same run: the call's `text`, headed "The text this was made from". Without one: "No text came with this recording." Nothing is called a transcript.
- **Word highlighting (F-413) is not available**: under the text, in `--text-faint`, "Words aren't highlighted: the gateway gives no timing for each word." Nothing moves while it plays.

Fetching follows the remote-content rule (#71): the host fetches the item from the gateway, up to 5 MiB. Larger: "This voice memo is 7.2 MB. Clawtrate fetches items up to 5 MB, so it can't be played here." Failed: "Couldn't load the voice memo." with "Try again". Playing a memo needs only read access. One recording plays at a time, and a memo pauses when a call starts.

## 12. Settings, Voice

A section of the Settings dialog (`bots.md` section 7), after the shell's own sections.

| Group | Rows |
|---|---|
| Microphone (F-392) | "System Default", then each device by its name, a radio group. Before access is allowed, names are unknown: "Allow microphone access to see your microphones' names." with "Allow". The chosen device, when not connected: "USB Microphone isn't connected. Voice won't use another microphone without asking." "Kept on this device." |
| Dictation | The route, as in section 4, each with its sentence; the unavailable ones with their reason |
| Voice chat | One line from `talk.catalog`: "Home gateway relays calls to OpenAI Realtime Voice." with the voice chat sentence of section 2, or "Voice chat isn't set up on Home gateway. Its owner sets up a voice provider in OpenClaw's Talk settings." or "Can't tell whether voice chat is set up on Home gateway." |
| Bots | Each bot's kept voice, speed and language, read-only, with "Reset" per bot |

The device list follows `devicechange`: a device added appears, one removed is marked as not connected.

## 13. What each fact drives

| Shown | Driven by | Tier | Evidence |
|---|---|---|---|
| Voice chat set up, its provider's name | `talk.catalog` `realtime.ready`, `activeProvider`, the provider's `label` and `transports` | read | research §1, live |
| Dictation through the gateway set up | `talk.catalog` `transcription.ready`, `activeProvider` | read | research §1, live |
| Starting a call | `talk.session.create {sessionKey, voice?, language?, capabilities}` (realtime, `gateway-relay`, `agent-consult`) | `operator.talk` (write) | research §1 live refusals; §2 source |
| Sending audio | `talk.session.appendAudio` (PCM16 24 kHz) | `operator.talk` | research §2, source |
| Phase, live transcript, a failure | `talk.event` frames to this connection | read | research §2, source |
| Hang up | `talk.session.close` | `operator.talk` | research §2, live (unknown id) |
| A call ends with its connection, and at 30 minutes | Connection cleanup; `RELAY_SESSION_TTL_MS` | | research §5, source |
| One call at a time | This client | | research §5 |
| Voice | `talk.voice.set`, `talk.voice.change`, a replacement create, `talk.voice.complete` | `operator.talk` | research §7, live (no call) |
| Speed | This device's playback | | research §7 |
| Language | `language` on `talk.session.create` | `operator.talk` | research §7, live validation |
| The "Voice chat" line and its transcript | History rows with `provenance.kind: "realtime_voice"`; this device's count | read | research §6, source |
| Dictation through the gateway | `talk.session.create {mode: "transcription"}`, `appendAudio` (µ-law 8 kHz), `talk.event`, `close` | `operator.talk` | research §3 |
| Dictation on the device | Apple's Speech framework with on-device required | | research §3, documented |
| A memo and its text | `artifacts.list`, `artifacts.download`; the run's `tts` call arguments | read | research §8, source |
| No word highlighting | No word timings exist | | research §8 |
| The microphone | `getUserMedia`, `enumerateDevices`, `devicechange`, the track's `ended`; macOS's `askForMediaAccess` | | research §4, documented |

## 14. Parity rows

Rows reworded in `docs/parity.md`, statuses unchanged. The Clawtrate column narrows with a note; the dependency column is replaced by the evidence.

| Row | Clawtrate column | Dependency column |
|---|---|---|
| F-111 | same; note: on the device that held the call the line shows the duration it counted; elsewhere it shows the saved turns' count and their first and last time. | partial: the relay saves each finalized utterance as a message with `provenance.kind: "realtime_voice"` and a timestamp (history, `operator.read`); no call record with a duration is readable; the duration is the device's own count (research §6). |
| F-253 | same; note: the text comes from Apple's recognizer with on-device recognition required (macOS) or from the gateway's transcription session; Windows has the gateway route only; the screen names where the audio goes before the first recording. | partial: gateway route `talk.session.create {mode: "transcription", transport: "gateway-relay", brain: "none"}` with `appendAudio` and `close` (`operator.talk`, which `operator.write` satisfies), not exercised beyond its refusal with no transcription provider; device route: Apple's Speech framework with `requiresOnDeviceRecognition`; Chromium's recognition is not used (research §3). |
| F-254 | same; note: the call is relayed through the gateway (`talk.session.create`), never connected by the app to the voice provider. | partial, not exercised beyond its refusal with no voice provider: `talk.session.create` (realtime, `gateway-relay`, `agent-consult`) with the Bot's `sessionKey`, audio by `appendAudio`, `close`; frames from `talk.event` to the owning connection; `talk.catalog` (`operator.read`) says whether it is set up (research §1, §2). |
| F-255 | same; note: "the transcript" is the text the Bot's `tts` call was given, labelled as such; a memo without one says so. | partial: a memo is an audio item (`artifacts.list`, `artifacts.download`, `operator.read`); no transcript field exists; the text is the `tts` call's argument (research §8). |
| F-392 | same; note: device names appear once microphone access is allowed; a chosen device that isn't connected is never silently replaced. | client only: `enumerateDevices`, `devicechange`; the choice is kept on the device (research §4). |
| F-409 | same; note: Apple's recognizer with on-device recognition required, or the gateway's transcription session. | client only, or as F-253's gateway route (research §3). |

Rows met as written, their cells unchanged: F-407, F-408 and F-460 (entry points into states this design has), F-411, F-412, F-413 (its no-highlight branch applies), F-461.

Rows that must differ, left as they are and raised for a decision:

- **F-463** ("If the connection drops, the app tries to reconnect on its own first", with a note that the same call resumes). A relayed call is closed by the gateway with its connection, and the only route that resumes, a client-owned call, has the app connect to the provider's host itself. Proposed: "same; note: the app reconnects to the gateway on its own; a relayed call ends with its connection, so the call ends with "Voice chat failed" and "Connection lost", and "Start voice chat" starts a new one."
- **F-462** ("applies from the user's next utterance"). A call's language is fixed when it starts; no method changes it. Proposed: "better: changing "Language" or choosing "Auto-detect" applies from the next call and persists for that Bot on this device; during a call the setting says so."
- **F-410** ("changes the voice from the Bot's next spoken reply in the current call"). True when the gateway allows a change on the call; when it does not, the change applies from the next call. Proposed: "better: changing "Voice" changes the voice from the Bot's next spoken reply in the current call when the gateway allows it, otherwise from the next call, and persists for that Bot on this device."

## 15. For builders

### What each part uses

| Part | Uses | New |
|---|---|---|
| The two buttons | The composer's action area (#18), round icon buttons | `.mic-button`, `.call-button` |
| The consent sheet | The small dialog; choice rows (`bots.md`) | `.voice-consent` |
| The call band | `--bg-bubble`, buttons, the avatar | `.call-band`, `.mic-mark` |
| The live transcript | Message text styles | `.call-transcript` (`role="log"`) |
| The call's settings | `.menu`'s surface, radio rows | `.call-settings` |
| The line | Event line, expander | `.call-line` |
| Memos | The audio card (`work-pane.md` §12) | `.memo-text`, `.speed` |
| Settings › Voice | Settings sections and rows (`bots.md` §7) | |

### What the host does

- **Permissions.** `lockDownSession` grants `media` for audio only, to the app's own pages, and nothing else. On macOS, `systemPreferences.getMediaAccessStatus` and `askForMediaAccess("microphone")` before the first capture.
- **Packaging, for the packaging owner** (not changed here): `NSMicrophoneUsageDescription` in `mac.extendInfo`; an entitlements file with `com.apple.security.device.audio-input` for the hardened runtime; for the on-device dictation route, `NSSpeechRecognitionUsageDescription` and the native recognizer (a helper or a native module); `media-src` already allows `data:` for a memo's bytes. Nothing on Windows.
- **Audio.** The renderer captures and plays; the host sends and receives. Captured audio crosses the bridge to the host, which calls `appendAudio`; reply audio crosses back. The web host's bridge frame limit (`MAX_BRIDGE_FRAME_BYTES`) bounds a chunk. No audio is written to disk, a log, the bridge's replay or a crash report. Captured audio goes nowhere but the gateway, and only while a session the gateway accepted is open.
- **One call per host**, across windows and tabs. A second create is refused by the host before it reaches the gateway.
- **On a dropped connection**, the host ends the call at once, without a close (the gateway has closed it), and never starts one by itself.

### What the engine supplies

- From `talk.catalog`, after every hello: whether voice chat and gateway dictation are ready, the active providers' labels, `transports`, voices by model.
- A call: its state (asking for the microphone, connecting, listening, thinking, speaking, muted, ending, ended, failed with its reason), its phase from frames, its live transcript, its time from `ready`, its voice-change state.
- From history: runs of rows with `provenance.kind: "realtime_voice"`, folded per call, with count and first and last time; the device's own count joined by the task and the first row's time.
- For a memo: the matching `tts` call's `text`, when the item came from one in the same run.
- The settings kept per device, gateway and bot (section 2).

### What the gateway must supply

Nothing new for what is designed here. Resuming a relayed call after a drop (F-463) and changing a call's language (F-462) would need the gateway; word timings (F-413) too. None is asked of a plugin: the design says less instead.

### Order to build

1. The microphone: permissions, the device list, Settings › Voice's Microphone group, the states of section 2. Check F-392.
2. The catalog read and the buttons' states, the access bar.
3. Dictation through the gateway, with its consent and states. Check F-253 (gateway route) and F-409's gateway route.
4. Dictation on the device, once the native recognizer is in place. Check F-253 and F-409.
5. A relayed call: start, band, mute, hang up, failures, 30 minutes. Check F-254, F-411.
6. One call at a time. Check F-412.
7. Voice, speed, language. Check F-410, F-461, F-462 as decided.
8. The "Voice chat" line. Check F-111.
9. Memos, their text and speed. Check F-255, F-413.
10. The iPhone entry points with the iOS app. Check F-407, F-408, F-460.

### Prototype states

`prototype/voice.html` takes the prototype's own `theme`, `width`, `motion` and `chrome`, and these. The bar fires what the gateway and the device do.

| Parameter | Values |
|---|---|
| `bot`, `task` | `otto` (`o1`), `juniper` (`j1`), `pip` (`p1`) |
| `access` | `read`, `write` (default) |
| `voice` | `ready` (default), `none` (not set up), `direct` (no relay), `unknown` (couldn't be read) |
| `dict` | `ready` (default), `none` |
| `os` | `mac` (default), `windows`, `web` (the browser preview on this computer), `remote` (the browser preview from another computer over plain http), `iphone` |
| `ondevice` | `0`: this Mac can't recognize the language on its own |
| `mic` | `granted` (default), `prompt`, `denied`, `none`, `missing` (the chosen one isn't connected) |
| `seen` | `1`: where the audio goes was already shown |
| `state` | `consent`, `dictconsent`, `dictating`, `connecting`, `live`, `muted`, `speaking`, `transcript`, `settings`, `micgone`, `limit`, `second`, `ending`, `endfail`, `failed` with `reason=drop`, `none` or `error`, `voicechange`, `voicefail`, `novoicechange`, `voicegone` |
| `line` | `here` (this device's line), `elsewhere`, `empty` |
| `memo` | `ready`, `text`, `notext`, `big`, `fail` |
| `page` | `settings`: Settings › Voice |

## 16. Not covered here

- **The composer itself** (#18): its layout, keys, drafts and sending. This design adds two buttons and inserts text through the composer's own way of changing its draft; anything more is raised on #18.
- **Siri, Shortcuts and the Action Button's system screens**, and the iPhone app's own call screen beyond the band at 390 px: the iOS app is not on `main` yet.
- **A client-owned call** (`talk.client.create`), and with it resuming a call after a drop: it would have the app connect to the provider's host (section 1).
- **Setting up a voice provider on the gateway**: OpenClaw's own Talk settings, which need admin.
- **Video in a call**, steering a bot's work by voice (`talk.session.steer`), and the gateway's spoken confirmations for high-impact actions: the bot asks for those in the call, and they are not drawn here.
- **Meeting transcripts** (`transcripts.*`) and the gateway's "Voice call changes" digest, which goes to a messaging channel, not to Clawtrate.
- **Text to speech of a typed reply** (`tts.*` settings, automatic TTS): a gateway setting with no row here.
