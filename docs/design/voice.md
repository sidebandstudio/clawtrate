# Voice

Speaking to a bot instead of typing: dictation into the composer, a voice chat with a bot, the voice, speed and language of a call, the line a call leaves in the conversation, a bot's voice memos, and the microphone setting. This part of the design builds on `visual-language.md` and `conversation.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-111, F-253 to F-255, F-392, F-407 to F-413 and F-460 to F-463. What the gateway, the operating systems and the browser engine do is in `docs/research/voice.md` (cited as research §n); every state below names the fact it rests on, and section 13 lists them. Section 15 is for builders.

Two rules sit above the rest. **Before the microphone opens, every time, the screen has named in full where the audio goes, and the person has accepted that destination; the app never sends it anywhere else.** And **the screen says only what the gateway or the device established**: where a thing cannot be made true, the claim is taken away rather than held up. Nothing is called private. "Mute" and "Hang up" say what happened on this device, and say more only when the gateway answered.

Seven facts from the research, the gateway's source and `main` shape the design:

- **A call is relayed through the gateway, or it is not made** (research §2). On a relayed call the audio goes from this device to the person's gateway over the connection Clawtrate already holds, and the gateway sends it on to the voice provider it names. The other route the gateway offers, a client-owned call, has the device connect to the provider's own address; Clawtrate does not use it (section 2).
- **A relayed session cannot be resumed, and its end is known only from the gateway** (research §5). When a connection closes, the gateway starts its cleanup without waiting for it, and a new connection can neither use the old session nor learn when it is gone. So after a drop the call has failed, and a new one waits until the old one is known to have ended (section 8).
- **What was said can be saved in the task as text** (research §6). The gateway queues each finalized caption to be saved as an ordinary message, marked as spoken, with an id that names its voice session; every device sees what was saved. Only the device that held the call knows how long it lasted.
- **The gateway says whether voice is set up, at the read tier** (research §1). `talk.catalog` answers `ready` for voice chat and for dictation through the gateway, and names the provider. It is a snapshot: the start asks for that provider by its id and checks the answer.
- **Dictation has two routes with a stated destination** (research §3): Apple's recognizer on this Mac or iPhone, with on-device recognition required, and the gateway's transcription session. Chromium's own speech recognition is not used: it sends audio to a Google service. Windows has the gateway route only.
- **Speed is the device's; a session's language is fixed when it starts; a voice is changed on the call only through the gateway's change** (research §7). A language chosen during a call is for the next calls. There are no word timings for a memo (research §8).
- **What a bot or the gateway supplies follows `docs/decisions.md`, "Addresses a gateway hands the client"**: a memo is played from bytes the gateway returns or from a download grant the host fetches, only after Play; any other address is never fetched; names, messages and addresses are text (sections 2 and 11).

The prototype walks every path to its outcome: `prototype/voice.html`, with the state in the address (section 15). Its styles are in `prototype/css/voice.css`, its behaviour in `prototype/js/voice.js`, and `prototype/tools/checks/voice.mjs` fires the gateway's and the device's events one at a time and asserts each state's words and structure, and what the fixture would have opened, sent, fetched or played. The system's own prompts are drawn as Clawtrate's pictures of them, labelled as pictures.

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
composer row, as built                  [+] [field] [How to send] [mic] [waveform] [Stopping… / Stop] [Send]
  mic                                    dictation (section 4): text into the draft, unsent
  waveform                               voice chat (section 5), only while the composer is empty
dictation line (under the row)           "Listening", where the words go, words not yet final
call band (above the composer)           the call (section 6)
call band                                bot, phase, time on this device, microphone mark,
                                         Mute, Transcript, Settings, Hang up (section 6)
transcript                               the "Voice chat" line after a call (section 10),
                                         a bot's voice memo card (section 11)
Settings › Voice                         microphone, dictation route, what voice chat uses (section 12)
iPhone entry points                      Siri and Shortcuts "Start Dictation" and "Start Voice Chat",
                                         the Action Button (section 5, "Entry points")
```

The composer is built on `main` (`packages/ui/src/Composer.tsx`, `conversation.md` section 13): attachments, the "/" and "@" menus, the send modes, Stop and the shelf's notes. This design places two buttons in its row and one line under it, and says what dictated text does in the draft; section 3 lists every place where the built composer would have to change, and nothing else of it changes. The call band is a new surface between the transcript and the composer, in the conversation (`Conversation.tsx`), not part of the composer.

## 2. Shared rules

### Components used

| Thing                                                      | From                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| The composer, its row, its draft, its shelf's notes        | `conversation.md` section 13; built in `packages/ui/src/Composer.tsx` |
| Round icon buttons, quiet and pressed                      | `visual-language.md` section 4                                        |
| The access bar and "Request access"                        | `conversation.md` section 3; built in `AccessBar.tsx`                 |
| The status strip and reconnecting                          | `visual-language.md` section 8                                        |
| Event lines in the transcript                              | `conversation.md` section 2                                           |
| The audio card and its player                              | `work-pane.md` section 12 (F-117)                                     |
| A small dialog with a title, one paragraph and two buttons | The stop confirmation, `work-pane.md` section 18                      |
| Settings, a section, rows and choice rows                  | `bots.md` section 7                                                   |
| The menu surface                                           | `.menu`, `visual-language.md` section 4                               |

### New components

| Component                                     | Class                  | Section |
| --------------------------------------------- | ---------------------- | ------- |
| The microphone button and its listening state | `.mic-button`          | 3, 4    |
| The dictation line under the composer's row   | `.dictation-line`      | 4       |
| The voice chat button                         | `.call-button`         | 3, 5    |
| Where the audio goes, before the first use    | `.voice-consent`       | 2, 4, 5 |
| The call band                                 | `.call-band`           | 6       |
| The microphone mark                           | `.mic-mark`            | 2       |
| The call's settings, a dialog | `.v-call-settings` | 7 |
| The live transcript                           | `.call-transcript`     | 6       |
| The "Voice chat" line                         | `.call-line`           | 10      |
| The memo's speed | `.speed` | 11 |

### Tokens

No new token. The microphone mark is `--danger` (a filled dot) while the microphone is open, and the hollow ring in `--text-faint` while it is not; the word beside it says which, so colour is never the only cue. The call band is `--bg-bubble` with a hairline, radius 18; failed, it is `--danger-soft`.

### Where the audio goes

Every route has one sentence. Before the microphone opens, the consent sheet names, in full and never cut short, the gateway (its name in the rail's footer) and the provider (its `label` in `talk.catalog`, as text), and says the sentence; Settings › Voice says it too (section 12). Long names wrap.

| Route | The sentence | Rests on |
|---|---|---|
| Voice chat | "Your voice goes to Home gateway, which sends it to OpenAI Realtime Voice. The gateway can save finalized captions as text in this task. Clawtrate discards its audio buffers when capture or playback stops. The gateway and provider manage their own copies." | research §2, §6 |
| Dictation through the gateway | "Your voice goes to Home gateway, which sends it to OpenAI Realtime Transcription and sends the text back. The words go into your message as an editable draft, and nothing is posted to the task until you send it. Clawtrate discards its audio buffers when capture stops. The gateway and provider manage their own copies." | research §3 |
| Dictation on this Mac or iPhone | "Apple's speech recognition turns your voice into text on this Mac. Clawtrate requires on-device recognition, so the recognizer doesn't send your voice over the network. The words go into your message as an editable draft." Offered only where the recognizer is eligible with on-device recognition required, on the Mac and the iPhone alike. | research §3 |

"Clawtrate discards its audio buffers" is a rule for the builder: no audio is written to disk, to a log, to a crash report or to the bridge's history, and in-memory audio is dropped when capture or playback stops (section 15). Nothing here promises what the gateway or the provider keep. A route whose destination cannot be stated is not offered: Chromium's speech recognition, and on-device dictation on Windows (research §3).

**Consent.** Acceptance is remembered on this device for the gateway identity (`gateway.identity.get`), the route and the provider's id; it is asked for again when the provider's id or its label changes. Its buttons are the route's action ("Start voice chat", "Start dictation") and "Cancel". A route chosen in Settings is a choice, not consent. The gate is the same for every entry point (the buttons, ⌘D, Siri, Shortcuts, the Action Button), for every retry and for every new session.

- **An unknown destination.** When `talk.catalog` couldn't be read, the sheet says "Can't verify where your voice would go" and "Clawtrate couldn't read which voice provider Home gateway uses, so it doesn't start a voice chat.", with "Retry", which reads the catalog again, and "Cancel". Nothing is created and the microphone stays closed.
- **The provider asked for by id.** A call is created with the accepted provider's id (`talk.session.create {provider, …}`), and the answer's `provider` is checked before any audio is sent. If the gateway chose another provider, or the answer can't be checked, the unused session is closed at once, nothing is sent, and the sheet asks again for what the gateway did choose: "Home gateway chose a different voice provider than it listed. Nothing was sent." (The catalog is a snapshot, and can change between reading it and starting.)

**What the gateway hands the client** follows `docs/decisions.md`, "Addresses a gateway hands the client". A call's audio is bytes on the connection Clawtrate already holds (`appendAudio` out, `talk.event` in), never an address. A client-owned call would hand the device a provider's address and credential to connect to, an address the gateway supplies, which that rule never fetches or opens: so Clawtrate does not create one (section 16). Every name, message, caption, voice and address a bot or the gateway supplies is shown as text, never as markup, and an address in one stays text, never a link. The bot's picture in the call band is the rail's, under the same rule (a checked `data:` picture, otherwise its letter). A memo is section 11. "Open System Settings" and "Open Settings" open the system's own pages, addresses Clawtrate writes, not ones the gateway supplies.

### Where settings are kept

None of these has a gateway setting (research §7), so Clawtrate keeps them itself:

| Setting | Kept | Why there |
|---|---|---|
| Each bot's voice, speed and language for its next calls | The `clawtrate.voice` user preference on the gateway (`users.prefs`), so every device of the person uses them | The same store and compare-and-set as `clawtrate.sidebar` and `clawtrate.budgets` on `main` (`packages/core/README.md`); written at the interactive tier |
| The same, when `users.prefs.get` answers `no_durable_identity` | This device, per gateway identity (`gateway.identity.get`) and bot | As the sidebar does when its `status` is `unavailable` |
| The microphone | This device | A device's names are its own |
| The dictation route | This device, per gateway | What a device can recognize is its own |
| A call's duration, for its line | This device, with the exact voice session ids it held (section 10) | Only the device that held the call counted it |
| Accepted destinations | This device, per gateway identity, route and provider id (section 2) | They were said to the person at this device |

**Reading.** The preference is validated on read; a value that isn't one of the allowed rates, a known language code or a plain voice name is ignored for that field. Only a confirmed `no_durable_identity` makes the device keep the settings; a read that fails for access, identity or any other reason stays unknown: "Couldn't read Otto's saved voice settings on Home gateway, so changes aren't saved.", and nothing is written. Speed then changes only this device's playback, labelled as for now.

**Writing.** One field of one bot at a time, with `users.prefs.set` and `expectedEntries` (a compare-and-set). The control says "Saving…" until the write, or a fresh read, confirms this bot's value; then "Saved for Otto on Home gateway, so your other devices use it too." On a conflict the client reads again, changes only this bot's requested field, and tries again within the sidebar's bound (four times), so a field another device changed is kept. On a refusal the last confirmed value stays, and the words say so: "Couldn't save: <the gateway's message, as text>. Otto's saved voice is still Alloy." (with "This call may differ." when the call already uses the new voice). "Reset" and speed follow the same rule. A change made on another device arrives on `users.prefs.changed`, applies from the next call, and is said as that; it never changes a call that is on. The gateway keeps at most 4,096 UTF-8 bytes of each preference's JSON (`value-too-large`, the `user-preferences` validation); a change past it is refused in those words. Every value shown is labelled as what it is: this call's, the next calls' saved one, or one changed elsewhere. Rates come only from the allowed list; bot names, provider names, voices, messages and addresses are text.

### Access

| Connection       | Dictation                         | Voice chat                        | Playing a memo | Settings › Voice                                     |
| ---------------- | --------------------------------- | --------------------------------- | -------------- | ---------------------------------------------------- |
| Read-only        | Not offered: there is no composer | Not offered: there is no composer | Works          | Read; "Reset" and the routes say "Needs more access" |
| Interactive tier | Works when a route is available   | Works when set up                 | Works          | Works                                                |

On a read-only connection the built conversation shows the access bar in the composer's place (`AccessBar.tsx`: "Read-only. You can follow Otto's work here. Approvals and questions aren't shown on this connection." with "Request access"), and no composer at all, so neither button exists there; this design adds nothing to that bar. Its one request covers voice too: the interactive tier (`operator.write`) satisfies `operator.talk`, and Clawtrate never asks for `operator.talk` alone or for admin (`docs/decisions.md`, "Scopes, in tiers"). Settings › Voice says "Dictation and voice chat need more access on this connection." A gateway that still answers `MISSING_SCOPE` for a talk method on an interactive connection is shown as that refusal (sections 4 and 5).

### The microphone

- **Asked for only after Start.** The person's Start (after consent) is what asks the system:
  - macOS: the microphone permission (`askForMediaAccess`), and for dictation on the Mac also Speech Recognition. Refused: "Clawtrate can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone." with "Open System Settings"; for speech, "Clawtrate can't use speech recognition. Allow it in System Settings › Privacy & Security › Speech Recognition."
  - iPhone: the microphone, and for Apple dictation speech recognition, each asked separately. Refused: "Clawtrate can't use the microphone. Allow it in Settings › Clawtrate." with "Open Settings"; for speech, "Clawtrate can't use speech recognition. Allow it in Settings › Clawtrate."
  - Windows: no prompt; the desktop microphone privacy setting decides, and a device that won't open says "Clawtrate couldn't open the microphone. Check Settings › Privacy & security › Microphone."
  - The web preview: its own origin's audio-only permission, in a secure context; refused: "This page can't use the microphone. Allow it in this browser's site settings." Over plain http from another computer it has no microphone (research §4): both buttons are disabled, described "This page can't use a microphone: a browser allows one only over https or on this computer itself."
  While a prompt is open, the band or the dictation line says "Waiting for microphone access…". Nothing is recorded or sent before it is allowed.
- **At most one route has the microphone at a time.** The microphone button is disabled during a call ("The microphone is in use by the voice chat.").
- **While the microphone is open there is always a mark**, "Microphone on" or "Microphone off", in the dictation line or in the call band, and the band says "Listening" only once a capture track is live and the relay is ready (section 6).
- **No microphone**: "No microphone found."
- **The chosen microphone is not connected**: "USB Microphone isn't connected." with "Use System Default this time", which leaves the stored choice as it is, and "Choose another". It never uses another microphone silently (section 12).
- **The microphone stops** (its track ends, the device goes away or permission is withdrawn): capture stops, audio not yet sent is dropped, and the band says "Microphone stopped. No new audio is being sent." It names a cause only when it is known: "USB Microphone was disconnected." (from `devicechange`) or "Microphone access was turned off." (from the permission). Capture comes back only when the person chooses "Turn microphone back on", after permission and the device are checked again.
- **Unmute** reopens capture the same way, and says "Unmuted" only once the track is live.
- **Going to the background** (iPhone) stops capture and playback; the call stays muted, "Muted when Clawtrate went to the background. Unmute to go on.", until the person unmutes. Closing the window or the app, or leaving the task's page, ends dictation and hangs up (section 8).
- **Device names in Settings** (F-392): names are shown only after access is allowed. "Allow" first says "To show your microphones' names, Clawtrate opens the microphone for a moment and closes it at once. Nothing is recorded or sent." with "Continue" and "Cancel"; the stream it opens is stopped as soon as the list is read.

### Widths, themes, keyboard, screen readers, motion

- Every surface here is drawn at 1440, 1100, 800 and the 390 px one-pane layout, light and dark, in the product's tokens; at 390 the controls take touch sizes (44 px hit areas).
- **The phone's one pane.** Back shows the list; choosing a bot shows its tasks; choosing a task opens its conversation. The call is shown in the list too (section 9), and "Show" always reaches its band.
- **Dialogs.** The consent sheet, the second-call question and the call's settings are modal dialogs: focus moves into them, stays there, Escape closes them, and focus returns to what opened them.
- **Choices.** A group of choice rows is a radio group with one tab stop; arrows, Home and End move and choose, and Space chooses. The call's voice, speed and language are native selects.
- **Focus survives updates.** A phase or a caption changing never takes focus from the control that has it, and never moves the field's caret.
- Screen readers: the band is a `region` named "Voice chat with Otto"; the microphone mark's words are its text, not only its colour; the live captions are a `log` with `aria-live="off"`; disabled buttons carry their reason as a description.
- Motion: the microphone mark's pulse holds still under reduced motion.

### Announcements

The conversation's one polite status region speaks for voice, one change at a time, and only once what it says is true on screen: "Listening", "Dictation stopped. The text is in your message." (or "Dictation stopped."), "Voice chat with Otto started" (once a capture track is live and the relay ready), "Muted", "Unmuted" (once the track is live again), "Voice chat ended", "Ended on this device. Home gateway did not confirm the call ended.", "Couldn't start voice chat", "Voice chat failed: Connection lost" (and the other reasons), "Reconnected to Home gateway. The voice session could not be resumed.", "Microphone stopped. No new audio is being sent.", "Voice: Cedar, from Otto's next reply.", "Voice didn't change". They go through the conversation's built announcer (`onAnnounce`, the polite `status` region). Captions are not announced.

## 3. The two buttons in the composer

The built row is, in order: "Attach files" (+), the field, "How to send" (only while a run is on and the field has text), "Stopping…", Stop (while a run can be stopped), Send (`Composer.tsx`). The two buttons go after "How to send" and before "Stopping…" and Stop, so Stop and Send keep their place at the end of the row. They are the row's own round icon buttons (`icon-button`), quiet, the size of their neighbours; on touch, where those are 40 px, each has a 44 px hit area.

| Button | Label | Shown | States |
|---|---|---|---|
| Microphone | Desktop: "Start voice input" (⌘D, Ctrl+D off the Mac); iPhone: "Start dictation" | Always, in the composer | Ready; Listening (filled `--danger`, "Stop voice input" or "Stop dictation"); Disabled with a reason (during a call; a page over plain http) |
| Voice chat (the waveform) | "Start voice chat" | Only while the built `hasContent` is false: no text, no attachment (pending or refused), no "/" or "@" chip (F-254). While dictating, it stays shown as long as only words not yet final exist | Ready; "In a voice chat" while this task's bot is on a call (pressed; it moves focus to the call band); Disabled with a reason (not set up; a page over plain http; an earlier session may still be open, section 8) |

A disabled button keeps focus and its reason as its description (`aria-description`, as the built Send does), so a keyboard or screen reader user hears why. Pressing the waveform while dictating stops dictation first, then checks again that no final words entered the draft before it starts anything. Both buttons are shown during a run.

**Keys.** ⌘D starts and stops dictation when the composer is reachable (the built `reachable()`, with its `command()` key) and no dialog is open; key repeats and keys pressed while an input method is composing are ignored. Held for more than 400 ms it is hold to talk: dictation stops when either key is released, whichever goes first, and when the window loses focus. Pressing and holding the microphone button does the same; a hold also ends when the pointer is cancelled or loses capture, when the task changes and when the composer goes away, and it stops exactly the dictation it started. On touch, the microphone's press is apart from Send's long press, which opens the send sheet as built. Escape in the field closes an open "/" or "@" menu first, through the built handler; otherwise it stops dictation and keeps the text. In the web preview ⌘D and Ctrl+D stay the browser's bookmark keys, and the button is the way to dictate. Voice chat has no shortcut. ⌘D is taken by nothing in the app (research §9; the built window keys are ⌘., ⌘↵, ⌘I and ⌘L).

**Stop is the composer's.** Stop and ⌘. stop the bot's run, as built, during a call too; they neither end the call nor mute it. "Stop now" dictated and sent during a run is Stop under the same conditions as when it is typed (the built `isStopNow`, with its own guards).

### Where the built composer would have to change

| Change | In `Composer.tsx` today | Why |
|---|---|---|
| Two buttons in the row, after "How to send" and before "Stopping…" and Stop | The row ends: How to send, Stopping…, Stop, Send | Section 3 |
| A voice state and its actions as props: the catalog's answer, this device's call, dictation | The props have no voice | The buttons' states |
| The waveform's rule is the built `hasContent` | It already decides Send | F-254 |
| Final words edit the current selection of the current task's draft, after any edit made since, through `setText`, without `watchCaret`; files and chips are kept | Text changes only from typing, pasting and the menus | Section 4 |
| A dictation line under the row (`.dictation-line`) for "Listening", where the words go and the words not yet final | The field is a plain `textarea`, which cannot colour part of its text | Section 4: words not yet final are never put in the field |
| ⌘D and its key-ups in the window-wide key handler, under its `command()` and `reachable()` guards; nothing in the web preview | The handler has ⌘., ⌘↵, ⌘I and ⌘L | Hold to talk |
| The microphone button and a lifecycle subscription stop dictation when a draft is handed to send; later results of that dictation are dropped | `sendAs` sends the field | The send path itself stays the composer's (#18): any change to `sendAs` or to the key dispatch is made with #18 |
| Dictation's failures are notices on the shelf (`onNotice`, with "Try again" and "Dismiss") | Built: the shelf already shows notices with a title, a reason and Try again | No new surface |

Nothing else of the composer changes: its layout, the menus, the send modes, the shelf, drafts, attachments and a failed send's restoration stay as built. The call band lives in `Conversation.tsx`, directly above the composer and under the usage notes (`UsageNotes`), and is not part of the composer.

## 4. Dictation

### Choosing the route

The first press opens the consent sheet for dictation, which lists the routes this device has, each a choice row (one tab stop; arrows, Home, End and Space) with its sentence in full (section 2):

| Device | Routes listed |
|---|---|
| Mac, with a language the recognizer supports on its own | "On this Mac" and "Through Home gateway" (when the gateway's transcription is ready) |
| Mac, without one | "Through Home gateway" only, with "On this Mac isn't available for English (United States): this Mac can't recognize it without the network." |
| Windows | "Through Home gateway" only, with "Windows has no speech recognition Clawtrate can use without sending your voice to Microsoft." |
| iPhone | "On this iPhone", and "Through Home gateway" |
| Neither available | The sheet says "Dictation isn't available here" with the reasons, and offers only "Close". |

The chosen route is kept (section 2) and can be changed in Settings › Voice; that choice is not consent, and each route's destination is accepted on its own.

### Listening

- Dictation uses the route chosen now. The button turns `--danger`. The dictation line under the composer's row says "Listening · Microphone on", then where the words go ("On this Mac" or "Through Home gateway"). On the gateway route it says "Connecting to Home gateway…" until that transcription session's `ready`, and no audio is sent before it.
- Words not yet final are shown only in the dictation line, after "Not final yet:", in `--text-faint`. Final words edit the current selection in the current task's draft, after every edit typed since, through the composer's own `setText`, and the caret moves after them. The built field is a plain `textarea`, so nothing in it is ever a guess. On the gateway route the final words are `transcript.done` with text; partial words and empty control envelopes are never put in the draft (research §3). On the device, the recognizer's final results.
- The text is the draft's: editable, unsent, kept with the draft as typed text is (`writeDraft`, per gateway and task). Dictation never sends, and dictated text opens no "/" or "@" menu. Files and chips are left as they are.
- **Stopping**: the button, ⌘D, Escape, releasing a held key, the cases in section 3, leaving the task, closing the window, the app going to the background on the iPhone. The region says "Dictation stopped. The text is in your message." when final words went in, and "Dictation stopped." when none did. A result that arrives for another task, or for a dictation already stopped by a task change, is dropped.
- **The gateway route on an ordinary stop** closes its session once (`talk.session.close`) and, while the gateway drains it (up to five seconds), still takes that session's final words into the same draft.
- **Sending** hands the draft over as built: what is in the field then is sent, and any later result of that dictation is dropped. A failed send follows the built shelf and restores the draft.
- **A lost connection** on the gateway route stops dictation and keeps the words already in the draft; the shelf says "Dictation stopped." with "Gateway connection lost.", or "Home gateway ended it." only when the gateway's own close event arrived. Dictation never starts again by itself.

### When dictation can't start

What is known before pressing disables the button with its reason; what is learnt by trying is a notice on the composer's shelf (the built `onNotice`: a title, a reason, "Try again" where trying again can help, and "Dismiss").

| Cause | Where | The words | Rests on |
|---|---|---|---|
| No route this device can use | The consent sheet | "Dictation isn't available here", with the reasons | research §3 |
| The gateway refused | A notice | "Couldn't start dictation." and the gateway's message, as text, with "Try again" | The create's error, `MISSING_SCOPE` among them |
| The microphone refused, or none | A notice | "Microphone not allowed." with the platform's words (section 2), or "No microphone found.", with "Try again" | research §4 |
| Speech recognition refused (Apple route) | A notice | "Speech recognition not allowed." with the platform's words, and "Try again" | research §3 |

## 5. Starting a voice chat

### What the button finds first

The client reads `talk.catalog` after every hello and when Settings › Voice opens (research §1).

| The catalog says | The voice chat button | Pressing it |
|---|---|---|
| `realtime.ready: true`, its active provider offers `gateway-relay` | Ready | The walk below |
| `realtime.ready: false` | Disabled: "Voice chat isn't set up on Home gateway." | Nothing |
| Ready, but the active provider offers no `gateway-relay` | Disabled: "Home gateway's voice provider talks to apps directly, which Clawtrate doesn't do." | Nothing |
| Couldn't be read (`AGENT_SELECTION_REQUIRED`, a failure) | Ready, described "Can't tell whether voice chat is set up on Home gateway." | "Can't verify where your voice would go", with "Retry" (section 2); nothing is created |

The not-set-up sentence is all the client can establish: the provider is set up by the gateway's owner in OpenClaw's own Talk settings, which need admin (research §1). Settings › Voice says that much. A ready catalog means the gateway is configured; it does not establish that a session will be ready.

### The walk

Every start passes the same gate, in this order: connected; no earlier relay of this device that is being created, is open, is closing or may still be open (section 8); a known destination; consent for it (section 2); then the system's permission and the device.

1. **Where your voice goes**, when this destination hasn't been accepted (section 2). "Cancel" returns focus to the button, and nothing opens.
2. **The microphone.** "Waiting for microphone access…" while the system asks; refused or no device: section 2, and nothing is sent to the gateway.
3. **Connecting.** `talk.session.create {sessionKey, provider, voice?, language?, capabilities: ["voice-selection"]}` for the open task (research §2, §7). The band says "Connecting to Otto…" with "Cancel". Capture may already be open, and the mark says so, but nothing is sent until the relay is ready.
4. **Ready.** The create's answer (with the provider checked, section 2), then the `ready` event of that same relay, matched by id; a `ready` that arrives before the answer is held until its id matches it. With a live capture track and a ready relay the band says "Listening", the time starts, and the region says "Voice chat with Otto started".

| At step 3 the gateway answers | The band |
|---|---|
| A refusal, such as `UNAVAILABLE` with `talkIssue.code: "realtime_unavailable"` | "Couldn't start voice chat", and the gateway's message as text: "Realtime voice provider "openai" is not configured." (live, research §1). No call was made, so nothing says one ended. |
| "Too many active realtime relay sessions…" | "Couldn't start voice chat", with that message |
| Another provider than the one asked for | The unused session is closed and the sheet asks again (section 2) |
| No answer, and the connection drops | "Voice chat failed", "Connection lost" (section 8) |
| Not connected when pressed | "Voice chat failed", "No connection" |

**"Cancel" during connecting** stops capture at once and drops the attempt. If the create answers afterwards, that relay is closed at once and nothing is attached to it; until its close is confirmed, the next start waits ("Ending the previous voice session…").

A call is started only on the open task, so the bot is the task's (`sessionKey` selects it; research §2, the map's section 17).

### Entry points (iPhone)

Siri, Shortcuts and the Action Button only open states this design already has (F-407, F-408, F-460), through the same gate:

| Entry point | Opens |
|---|---|
| "Start Dictation" (Siri, Shortcuts) | The last open task's composer, dictating on the chosen route, after consent and permission as above; an existing draft is kept, and the words go in at the caret |
| "Start Voice Chat" (Siri, Shortcuts), with a bot | That bot's last task, never another bot's, and the walk above. If that task has a draft, nothing starts: the draft is kept and the shelf says "Voice chat not started. Start Voice Chat needs an empty message. Your draft is kept." |
| The Action Button, "Start Voice Chat" | The same, for the bot it was set up with; pressed during a call, it hangs up as Hang up does (section 8) |

No system screen is drawn here: the system draws its own.

## 6. On a call

```
call-band   [Otto]  Voice chat with Otto · Listening              2:14 on this device
            ● Microphone on       Mute   Transcript   Settings          Hang up
```

Everything the band says comes from an event it can match to this call's own relay, by id, on the current connection:

- **Phase.** "Connecting to Otto…" until a successful create and that relay's `ready`. "Listening" needs both a live capture track and the ready relay; with a ready relay but no track yet, "Opening the microphone…". "Thinking" from `responseStarted` until playback starts or the response ends. "Otto is speaking" from the moment this device starts playing reply audio until it has drained or been cleared; a caption or a received frame alone never makes it "speaking". "Muted" and "Microphone stopped" as in section 2. A receipt for `appendAudio` means only that the gateway accepted the audio.
- **Time** is counted on this device from `ready`, and labelled "on this device".
- **The microphone mark**: "Microphone on" only while a capture track is live.
- **Mute** (`aria-pressed`): capture stops and nothing is sent; the band says "Muted. This device's microphone is off." and the button reads "Unmute". Unmuting reopens capture (section 2). The gateway is not told: muting is this device's.
- **Transcript** (visible "Transcript", named "Show transcript" or "Hide transcript", `aria-expanded`) opens the live captions under the band: a `log` with `aria-live="off"`, so nothing in it is announced. "You" and "Otto" lines from this relay's `transcript` events only; words not yet final in `--text-faint`, final when the matching provider event says so, and marked "Saved" only when the history row with the same id arrives (section 10). Under them: "Live captions. Saved turns appear in this task." Captions of any other voice session, from this device or another, never change this band.
- **Settings** opens the call's settings (section 7).
- **Hang up** (`--danger`) ends the call (section 8). Before the relay is ready the same place says "Cancel".
- **The scheduled end.** The create answers `expiresAt` (epoch seconds), the relay's scheduled end. Two minutes before it the band adds "This session is scheduled to end at 5:59 PM." A `close` event ends the call whenever it comes ("Voice chat ended"); an ordinary `completed` close is not said to be the schedule's.
- **A stream error** (an `error` frame for this relay): local media stops, and the call has failed (section 8).
- **Typing during a call** is allowed: a message sent goes into the same task as usual. Stop and ⌘. are the composer's (section 3).

Widths: at 1440, 1100 and 800 the band spans the conversation column above the composer, on two rows: the title and time, then the microphone mark and the actions. At 390 it has three: the title and time; the microphone mark; then Mute, Transcript, Settings and Hang up together on one row, Hang up at its end. Docked or not, the Work pane never covers it.

## 7. Voice, speed and language

The band's "Settings" opens a small dialog, "Voice chat settings for Otto", that traps focus, closes with Escape or "Close", and returns focus to "Settings". It has three groups. Each says what applies to this call and, separately, what is saved for the next ones and whether that save is confirmed (section 2).

### Voice (F-410)

- **What can be chosen.** `talk.voice.get` by the call's current `voiceSessionId`. The voices it returns are offered, in a native select, only when it answers `canChange: true`. Otherwise: "OpenAI Realtime Voice offers no voices to choose from for this call." and no list.
- **Choosing a voice** sends `talk.voice.set {voice, voiceSessionId}` and keeps it pending: the dialog and the band say "Changing to Cedar… The current reply may stop." The choice of the same voice sends nothing (the gateway would answer `applied` with no change).
- **The gateway's request.** On the matching `talk.voice.change` with `phase: "requested"`, the client creates exactly one replacement: `talk.session.create {voiceChangeId, sessionKey, language, capabilities: ["voice-selection"]}`, with the original task and language. When the replacement is ready, the client stops routing audio to the original, drops the original's queued output, closes the original, and completes with `talk.voice.complete {changeId, voiceSessionId: <the replacement's>, outcome: "ready"}`.
- **Applied, then saved.** The new voice is shown only when `talk.voice.set` answers `status: "applied"` for that replacement on the current connection: "Voice: Cedar, from Otto's next reply.", announced once. Only then is the choice saved for Otto (section 2): "Saving…", then the confirmed note.
- **When it doesn't change.** A refusal of the set ("Voice is not in this call's catalog…", "A voice change is already in progress…", a timeout after 60 seconds): "Voice didn't change: <the gateway's message>. Still using Alloy." A replacement that fails while the original still works: the client completes with `outcome: "failed"`, closes the replacement if there is one, and says the same. If the original has already ended, or the connection dropped, the call's own failure or unconfirmed end is shown instead (section 8), never a changed voice. The saved choice stays the last confirmed one.
- **"Default for future calls"** clears the saved voice, so later calls send no `voice`; it doesn't change this call: "Otto's next calls use the provider's default voice. This call keeps Cedar." There is no "Default" voice to set on a call: `talk.voice.set` has none.
- **A change the device didn't ask for** (a `requested` change with no pending choice of this device): declined with `talk.voice.complete {outcome: "failed"}` before any replacement is created; the band says "Otto asked for a different voice. Clawtrate kept Alloy for this call."
- **A saved voice the provider no longer lists**: the call starts without it, and the band says once "Ember isn't offered by Home gateway any more, so this call uses the provider's default voice." The saved choice is kept.
- **Changed on another device**: applies from the next call, and is said as that ("Changed on another device: voice Sage from Otto's next call."); it never changes this call.

### Speed (F-461)

- 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2×, a native select. It changes how fast this device plays what the bot says, at once, and nothing on the gateway (research §7). The row says "Plays at 1.5× on this device." The choice is saved for Otto as in section 2, with the same "Saving…" and confirmation, and another device plays at that speed from its next call.
- The same speed applies to this bot's voice memos (section 11).

### Language (F-462)

- **This call keeps its language.** A session's language is set only when it is created (`talk.session.create {language}`, two lowercase letters), and no method changes it on a running session (research §7). The dialog says "This call: Español requested. The provider decides how it uses it." when this call was created with a language, and "This call: provider default." when it was created without one.
- **"Language for new calls"** saves the bot's language for its next calls (section 2): "Provider default", which sends none and leaves the provider's own setting in force, or a language. It changes nothing on this call and starts no other session.
- "Español requested" is all that is shown about a language: the gateway passes it to the realtime provider, and no answer says what the provider does with it, so nothing says the provider understands or detects it.
- On dictation through the gateway the language is not offered: "The gateway's dictation doesn't take a language in this version." On the device route the language is the recognizer's.

## 8. Ending a call, and a call that fails

### Hang up

Hang up (and "End and Chat", section 9) stops capture and playback at once and drops any start still pending. Then the band waits for the gateway:

| Step | The band | Rests on |
|---|---|---|
| Hang up | The microphone is released and the reply audio stops; "Ending…" | This device |
| The gateway answers `talk.session.close`, or sends that relay's own terminal `close` event | The band goes; the line is left (section 10); "Voice chat ended" | research §2 |
| The close fails, or no answer comes | The band goes; the line is left with "Ended on this device. Home gateway did not confirm the call ended.", announced in the same words. The next start waits (below) | research §5 |

A relay whose end wasn't confirmed may still be open. Until the gateway confirms it (its `close` event, matched by id), or until its scheduled end (`expiresAt` from its create) has passed, the voice chat button is disabled, described "The previous voice session may still be open on Home gateway. A new voice chat can start after 6:06 PM, when that session is scheduled to end." While a close is still waiting for its answer: "Ending the previous voice session…". Starts, handovers and ends are serialized by the host, across its windows and tabs, by connection, task and attempt.

### When the connection drops (F-463)

The app reconnects to the gateway by itself (the status strip, as always). The call does not. The gateway starts closing a connection's sessions when it sees the socket close, without waiting for that to finish; a new connection can neither use the old session ("Talk session is not owned by this connection" while the gateway still holds it, "Unknown Talk session" once it has forgotten it) nor learn when its cleanup ended (research §5). So:

| Step | The band |
|---|---|
| The connection drops | "Voice chat failed", "Connection lost", "Microphone off. Reconnecting to Home gateway…"; capture and playback stop at once; the line is left with the time this device counted; the region says "Voice chat failed: Connection lost" |
| The app is connected again (hello) | "Reconnected to Home gateway. The voice session could not be resumed. This device stopped sending audio when it detected the drop.", then "The previous voice session may still be open on Home gateway. A new voice chat can start after 6:06 PM, when that session is scheduled to end." A hello starts no media and announces no reconnected call. |
| The old session's scheduled end has passed | "Start a new voice chat", which goes through the whole gate (section 5) and keeps the bot's voice and language choices, under their usual checks; the new call has its own time |

Nothing starts a call by itself. Captions already saved stay in the task, and the measured time of the call that dropped stays on its line. The 30 minutes are the gateway's schedule for a relay, not evidence of when its cleanup ended; Clawtrate uses the scheduled end only because nothing earlier establishes that the old session is gone.

### A call that fails (F-411)

The band turns `--danger-soft`, says "Voice chat failed" and one reason, with "Dismiss". When nothing may still be open and the connection is there, the voice chat button offers "Start voice chat", which starts a new call.

| Reason | Second line | When |
|---|---|---|
| "Connection lost" | As above | The connection drops during a call, or while one was starting |
| "No connection" | "This device isn't connected to Home gateway. Start again when it reconnects." | Pressed while not connected |
| "The call ended unexpectedly" | "Home gateway ended the call: <its reason, as text>." | An `error` frame, or a `close` frame with reason `error`, for a relay that was ready (research §2) |

A refusal at the start is not a failed call: it is "Couldn't start voice chat" (section 5).

## 9. One call at a time

- **This device holds at most one call** (F-412), across all its windows and tabs, since they share one connection (research §5). The gateway itself allows two relay sessions per connection, and another device can hold its own call with the same bot at the same time.
- Pressing "Start voice chat" in another task while a call is on asks, in a small dialog: title "End the current voice chat?", body "You're in a voice chat with Otto. Ending it starts one with Juniper.", buttons "End and Chat" (default) and "Cancel". "End and Chat" hangs up (section 8): the next call starts only after the gateway confirms the old relay ended, and then goes through the whole gate (section 5). If the end isn't confirmed, nothing starts, and the line and the button say why. "Cancel" leaves the call as it was and returns focus. Escape is Cancel.
- The call is shown wherever its bot and task are listed, on every width, the phone's list included: the rail's preview and the task row say "In a voice chat · Microphone on" (or off). In another task the conversation shows "In a voice chat with Otto · Microphone on" with "Show", which opens the call's task and moves focus to the band; it never captures audio by itself.
- Another device sees nothing of this call while it runs: the gateway sends its frames only to the connection that holds it (research §2). It sees the saved turns arrive in the task.

## 10. After a call: the "Voice chat" line

Saved history rows with `provenance.kind: "realtime_voice"` carry an id of the form `voice:<voiceSessionId>:<n>` (the relay's caption id, which the gateway also uses for the stored message, and history shows in `__openclaw.id`; research §6). The transcript groups them by that voice session, never by their order or their times, so two calls with the same times, or a typed message between two turns, are never mixed. One `.call-line` button stands where a session's first saved row is:

| Where | The line | Rests on |
|---|---|---|
| The device that held the call | "Voice chat · 2:14", the time it counted for that voice session | Its own count, kept with the exact voice session ids it held (section 2) |
| Any other device | "Voice chat · 6 turns · 5:31–5:36 PM" | The saved rows of that session, their count and their first and last time |
| A call this device held with no saved row found in the history it read | "Voice chat · 0:07 · No saved turns found" | Its own count, and the history it actually checked |
| A spoken row with no voice session id | Shown on its own, marked "Spoken · 5:31 PM" | No reliable id to group it by |

A call is never given turns it didn't save: a silent or refused call has no sample transcript, and a short call keeps the time it measured. Pressing the line opens its turns in place (F-111): the saved messages, "You" and "Otto", each with its time; `aria-expanded` follows. Turns typed during the call stay where they fall. The line is a heading-level landmark for moving by call.

## 11. Voice memos

A memo is an audio item a bot sent (research §8). Its card is the audio card of `work-pane.md` section 12: the item's name and length from `artifacts.list` first, with Play. Nothing is downloaded or played when the card is drawn, hovered or read.

**Play, and only Play, asks for this item** by its artifact id (`artifacts.download`, `operator.read`). What the answer may be follows `docs/decisions.md`, "Addresses a gateway hands the client" (rows "An item a reply hands over" and "Every other address an item carries"; building it is #71):

| The gateway answers | The card | Rests on |
|---|---|---|
| `encoding: "base64"` and `data` | Decoded under the 5 MiB item limit, checked to be playable audio, and played as a `data:` address; no HTTP request | The decision: bytes from the existing connection |
| A grant: a top-level `url` on one of the two grant routes of the connection's own origin, with an unexpired top-level `expiresAt` | The host fetches it (desktop and web preview), at most 5 MiB, with no userinfo, no redirect and no credential but the grant; the grant's address never reaches the interface; then as above | The decision: the host fetches, never a renderer or a viewer's browser |
| A grant, on the iPhone | "This voice memo can't be played on this iPhone yet: Home gateway offers it as a download, and the iPhone app doesn't make downloads yet." Inline bytes still play there. | The decision: iPhone HTTP downloads wait for their check |
| An expired grant, another route or another origin | "Clawtrate didn't fetch this voice memo: Home gateway's answer isn't a download it fetches by itself." | The decision's grant check |
| A grant whose fetch tries to redirect | "Couldn't load the voice memo: the download tried to redirect, which Clawtrate doesn't follow." with "Try again" | The decision: no redirects |
| More than 5 MiB | "This voice memo is larger than 5 MiB, so Clawtrate can't play it here." A size is named only when the metadata gave one. | The decision's size limit |
| An address the item carries (`audio_url`, or one passed through from the transcript) | The full address as text, under "This voice memo is at an address Clawtrate doesn't open by itself:", with "Open in browser" and "Opens in your browser." on the desktop, "Open outside Clawtrate" and "Opens outside Clawtrate." on the iPhone, through the shared link rule; an address of any other scheme is text only, with no button | The decision: never fetched in the app; opening follows the link row |
| A failure | "Couldn't load the voice memo." with "Try again", which returns the card to Play; nothing is asked again until Play | |

**One recording at a time.** A play still waiting for its answer is dropped when the task changes or a call starts. A playing memo is paused before a call can use audio, and starting or ending a call never resumes it. Playing a memo needs only read access.

- **Speed**: the bot's speed (section 7), shown as "1×" on the player, which cycles through the speeds. With write access it is saved as in section 2; on a read-only connection, or when the saved settings couldn't be read, it changes only this device's playback for now: "1.25× for now, on this device."
- **No text.** The gateway gives no verified link between this recording and the text a `tts` call was given: one run can make several clips, and an item is not tied to the call that made it (research §8). So the card says "No text came with this recording." and shows no text; nothing is joined by order or by run.
- **Word highlighting (F-413) is not available**: "Words aren't highlighted: the gateway gives no timing for each word." Nothing moves while it plays.

## 12. Settings, Voice

A section of the Settings dialog (`bots.md` section 7), after the shell's own sections.

| Group | Rows |
|---|---|
| Microphone (F-392) | "System Default", then each device by its name, a radio group. Before access is allowed, names are unknown: "Allow microphone access to see your microphones' names." with "Allow", which first explains the brief opening (section 2). The chosen device, when not connected: "USB Microphone isn't connected. Voice won't use another microphone without asking." "Kept on this device." |
| Dictation | The routes, as in section 4, each with its sentence in full; the unavailable ones with their reason. "Choosing a route here starts nothing; its first use still says where your voice goes." |
| Voice chat | The voice chat sentence of section 2, from `talk.catalog`, or "Voice chat isn't set up on Home gateway. Its owner sets up a voice provider in OpenClaw's Talk settings." or "Can't tell whether voice chat is set up on Home gateway." |
| Bots | Each bot's saved voice ("Provider default" when none), speed and language, read-only, with "Reset" per bot, and under them where they are kept: "Saved on Home gateway, so your other devices use them too.", "Kept on this device, for each bot: this connection has no user profile on the gateway.", or "Couldn't read the saved voice settings on Home gateway." A write in progress or its outcome is said per bot (section 2). On a read-only connection, or when the settings couldn't be read, "Reset" is disabled with its reason. |

On a read-only connection the section also says "Dictation and voice chat need more access on this connection." The device list follows `devicechange`: a device added appears, one removed is marked as not connected.

## 13. What each fact drives

| Shown | Driven by | Tier | Evidence |
|---|---|---|---|
| Voice chat set up, its provider's id and name | `talk.catalog` `realtime.ready`, `activeProvider`, the provider's `label` and `transports` | read | research §1, live |
| Dictation through the gateway set up | `talk.catalog` `transcription.ready`, `activeProvider` | read | research §1, live |
| Starting a call, its provider checked | `talk.session.create {sessionKey, provider, voice?, language?, capabilities}` (realtime, `gateway-relay`, `agent-consult`); its answer's `provider`, `relaySessionId`, `voiceSessionId`, `expiresAt` | `operator.talk` (write) | research §1 live refusals; §2 source |
| Listening | The relay's `ready`, matched by id, and a live capture track | read | research §2, source |
| Sending audio | `talk.session.appendAudio` (PCM16 24 kHz), to a ready relay only | `operator.talk` | research §2, source |
| Thinking, speaking, captions, a failure | `talk.event` frames to this connection, by relay id; local playback | read | research §2, source |
| Hang up, confirmed | `talk.session.close`'s answer, or that relay's `close` event | `operator.talk` | research §2, §5, source |
| A drop ends the call; nothing resumes | Asynchronous connection cleanup; ownership by connection; "Unknown Talk session" once forgotten | | research §5, source |
| The next start's wait | The relay's `expiresAt`, its scheduled end | | research §5, source |
| One call at a time | This client's host | | research §5 |
| Voice | `talk.voice.get` (`canChange`, voices), `talk.voice.set`, `talk.voice.change` `requested`, one replacement create with `voiceChangeId`, `talk.voice.complete`, `applied` | `operator.talk` | research §7, source and live (no call) |
| Speed | This device's playback | | research §7 |
| Language for new calls | `language` on `talk.session.create` | `operator.talk` | research §7, live validation |
| Where each bot's settings are kept | `users.prefs.get` and `set` (`clawtrate.voice`, `expectedEntries`), `users.prefs.changed`, 4,096 bytes per value | read to read it, write to change it | `docs/research/gateway-capabilities.md` (`users.prefs`, live); as `clawtrate.sidebar` on `main` |
| The "Voice chat" line and its turns | History rows with `provenance.kind: "realtime_voice"` and ids `voice:<voiceSessionId>:<n>`; this device's count | read | research §6, source |
| Dictation through the gateway | `talk.session.create {mode: "transcription"}`, its `ready`, `appendAudio` (µ-law 8 kHz), `transcript.done`, `close` and its drain | `operator.talk` | research §3 |
| Dictation on the device | Apple's Speech framework with on-device required | | research §3, documented |
| A memo | `artifacts.list`, then on Play `artifacts.download` (bytes or a grant, under `docs/decisions.md`) | read | research §8, source |
| No text and no word highlighting | No verified link from a recording to a `tts` call; no word timings | | research §8 |
| The microphone | `getUserMedia`, `enumerateDevices`, `devicechange`, the track's `ended`, the permission's state; macOS's `askForMediaAccess` | | research §4, documented |

## 14. Parity rows

Rows reworded in `docs/parity.md`, statuses unchanged. Each target keeps its first word; a note after `same` only narrows it; no target is weakened to fit this design. Where the gateway can't honor a target, the dependency cell names what is missing.

| Row | Clawtrate column | Dependency column |
|---|---|---|
| F-111 | same | partial: verified voice event ids (`voice:<voiceSessionId>:<n>`, the relay's caption id, which the stored message keeps and history shows in `__openclaw.id`; `operator.read`) group saved history by voice session; the holding device records elapsed time. A shared call-duration record is unavailable, so another device shows the saved turns' count and times, not a duration (research §6). |
| F-253 | same; note: the text comes from Apple's recognizer with on-device recognition required (macOS) or from the gateway's transcription session; Windows has the gateway route only; the screen names where the audio goes before the first recording. | partial: gateway route `talk.session.create {mode: "transcription", transport: "gateway-relay", brain: "none"}` with `appendAudio` and `close` (`operator.talk`, which `operator.write` satisfies), not exercised beyond its refusal with no transcription provider; device route: Apple's Speech framework with `requiresOnDeviceRecognition`; Chromium's recognition is not used (research §3). |
| F-254 | same; note: the call is relayed through the gateway (`talk.session.create`), never connected by the app to the voice provider. | partial, not exercised beyond its refusal with no voice provider: `talk.session.create` (realtime, `gateway-relay`, `agent-consult`) with the Bot's `sessionKey`, audio by `appendAudio`, `close`; frames from `talk.event` to the owning connection; `talk.catalog` (`operator.read`) says whether it is set up (research §1, §2). `talk.client.create` is not used: its media goes between the device and the provider's own address, which `docs/decisions.md` ("Addresses a gateway hands the client") never opens. |
| F-255 | same | partial: artifacts deliver the audio under the item policy (`artifacts.list`, `artifacts.download`, `operator.read`; `docs/decisions.md`, "Addresses a gateway hands the client"). The attachment has no transcript field or verified spoken-word timing. TTS source text can be shown only if the exact tool-output association is established; in 2026.10.6 it is not, so no transcript is shown (research §8). |
| F-392 | same; note: device names appear once microphone access is allowed; a chosen device that isn't connected is never silently replaced. | client only: `enumerateDevices`, `devicechange`; the choice is kept on the device (research §4). |
| F-409 | same; note: Apple's recognizer with on-device recognition required, or the gateway's transcription session. | client only, or as F-253's gateway route (research §3). |

Rows whose target is left as written, with their dependency cell corrected:

- **F-410**, target unchanged, `todo`. Dependency: "partial, source only beyond no-call, ownership and validation probes: relay create opts into `voice-selection`; `talk.voice.get` exposes `canChange` and the active catalog; for a changed supported voice `talk.voice.set` sends the owner `talk.voice.change`; "applied" waits for a fresh matching provider-ready replacement, removal of the original and a matching `talk.voice.complete` (`operator.talk`, implied by `operator.write`). The setter has no Default reset. The replacement may fail or be cancelled, and the prior call may already have ended. The last confirmed bot preference is kept in `clawtrate.voice` (`users.prefs`), or on the device with a confirmed `no_durable_identity`. A provider-backed check is still needed (research §7)."
- **F-462**, target unchanged, `todo`. Dependency: "partial: `talk.session.create` validates two lowercase letters; the realtime relay passes the request into the bridge; the transcription branch ignores it; `talk.client.create` rejects it. Missing for this target: an in-session setter or a provider acknowledgement that a language or auto-detection applies from the next utterance. Two relays may serve the same task (two realtime slots per connection), but with no atomic handover, no guaranteed continuity and no proven provider result. The design saves a language for new calls only (research §5, §7)."
- **F-463**, target unchanged, `todo`. Dependency: "partial, with a gap for this target over a relay in 2026.10.6: when the gateway detects a socket's closure it starts asynchronous cleanup; an old id can still be owned by the old connection, or be unknown after removal; a reconnect cannot resume it and gets no cross-connection cleanup acknowledgement. The client can keep the band's local time and create a new provider session once release and consent are established; neither same-session continuity nor at most one live gateway session through a drop is established. `talk.client.create` has a separate provider transport and a limited resume path, outside the relayed design (research §5)."

What the design does for those three: F-410 changes a call's voice only through the gateway's handshake and says so only once it applied (section 7); F-462 keeps a call's language and saves a language for new calls, so its target waits for a provider that acknowledges a language mid-session; F-463 ends a dropped call and waits for the old session's end before a new one, so its target waits for a relay that survives its connection or a release the client can see.

Rows met as written, their cells unchanged: F-407, F-408 and F-460 (entry points into states this design has), F-411, F-412, F-413 (its no-highlight branch applies), F-461.

## 15. For builders

### What each part uses

| Part                                   | Uses                                                                         | New                                              |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| The two buttons and the dictation line | The composer's row (`Composer.tsx`), round icon buttons; the shelf's notices | `.mic-button`, `.call-button`, `.dictation-line` |
| The consent sheet                      | The small dialog; choice rows (`bots.md`)                                    | `.voice-consent`                                 |
| The call band                          | `--bg-bubble`, buttons, the avatar                                           | `.call-band`, `.mic-mark`                        |
| The live transcript                    | Message text styles                                                          | `.call-transcript` (`role="log"`)                |
| The call's settings | The small dialog; native selects | `.v-call-settings` |
| The line                               | Event line, expander                                                         | `.call-line`                                     |
| Memos | The audio card (`work-pane.md` §12) | `.speed` |
| Settings › Voice                       | Settings sections and rows (`bots.md` §7)                                    |                                                  |

### What the host does

- **Permissions.** Electron's permission handler grants `media` for audio only, to the app's own audio requester and its own origin, and nothing else (`lockDownSession` allows only the clipboard today). On macOS, `systemPreferences.getMediaAccessStatus` and `askForMediaAccess("microphone")` after the person chose Start, and Speech Recognition for Apple dictation. The web preview asks its own origin for audio only, in a secure context. The iPhone asks for the microphone and speech recognition separately.
- **Packaging, for the packaging owner** (not changed here): `NSMicrophoneUsageDescription` in `mac.extendInfo`; an entitlements file with `com.apple.security.device.audio-input` for the hardened runtime; for the on-device dictation route, `NSSpeechRecognitionUsageDescription` and the native recognizer (a helper or a native module); `media-src` already allows `data:` for a memo's bytes. Nothing on Windows.
- **Audio.** The renderer captures and plays; the host sends and receives. Captured audio crosses the bridge to the host, which calls `appendAudio` only for a relay that is ready, whose provider was checked against the accepted one; reply audio crosses back. The web host's bridge frame limit (`MAX_BRIDGE_FRAME_BYTES`) bounds a frame on the bridge and nothing else. No audio is written to disk, a log, the bridge's replay or a crash report, and in-memory audio is dropped when capture or playback stops. The on-device dictation route gives raw audio only to the recognizer with on-device recognition required; it never crosses the gateway bridge.
- **Permission loss or a track that ends** stops capture and drops what wasn't sent (section 2); capture is opened again only by the person's choice.
- **One call per host**, across windows and tabs. A start is refused by the host before it reaches the gateway while any relay of this device is being created, is open, is closing or may still be open; a cancelled start's late answer is closed at once.
- **On a dropped connection**, the host stops capture and playback at once, marks every relay of that connection as possibly open until its scheduled end, and never starts a call by itself.

### What the engine supplies

- From `talk.catalog`, after every hello: whether voice chat and gateway dictation are ready, the active providers' ids and labels, `transports`, voices by model.
- A call: its attempt, connection generation and task; its state (asking for the microphone, connecting, listening, thinking, speaking, muted, microphone stopped, ending, ended, ended unconfirmed, refused, failed with its reason); each relay it holds, by id, with its provider and scheduled end, and whether that relay is open, closing, closed or may be open; capture and playback as the device reports them; its captions by id, final and saved from their own events; its time from `ready`; a pending voice change through each of its steps.
- From history: rows with `provenance.kind: "realtime_voice"` grouped by the voice session in their ids; spoken rows without one, singly; the device's own count joined by the exact voice session ids it held.
- For a memo: its metadata, and on Play the answer for that item, classified by the core's rule.
- The settings in `clawtrate.voice` per bot, each field's last confirmed value and any write in progress, or the device's own with a confirmed `no_durable_identity`, or unknown.

### What the gateway must supply

Nothing new for what is designed here. Three targets wait on it: a relayed session that survives its connection, or a release a new connection can see (F-463); a way to change a session's language with an acknowledgement (F-462); word timings (F-413). A provider-backed check of the voice change is still needed for F-410. None is asked of a plugin: the design does without them, and says what each costs.

### Order to build

1. The microphone: permissions per platform, the device list, Settings › Voice's Microphone group, the states of section 2. Check F-392.
2. The catalog read, consent per destination and the buttons' states.
3. Dictation through the gateway, with its consent and states. Check F-253 (gateway route) and F-409's gateway route.
4. Dictation on the device, once the native recognizer is in place. Check F-253 and F-409.
5. A relayed call: the gate, start, band, mute, hang up with its confirmation, a drop, failures, the scheduled end. Check F-254, F-411.
6. One call at a time, with the host's serialization. Check F-412.
7. Voice through the gateway's change, speed, language for new calls, with the `clawtrate.voice` preference. Check F-410, F-461.
8. The "Voice chat" line. Check F-111.
9. Memos and their speed. Check F-255, F-413.
10. The iPhone entry points with the iOS app. Check F-407, F-408, F-460.

### Prototype states

`prototype/voice.html` takes the prototype's own `theme`, `width`, `motion` and `chrome`, and these. Nothing records, plays, fetches or opens: the microphone, the gateway and the player are counters (`window.voice.S.io`), and the gateway's and the device's events are fired one at a time by the bar or by `window.voice.ev(name, data)`. With `auto=0` nothing answers by itself.

| Parameter | Values |
|---|---|
| `bot`, `task` | `otto` (`o1`), `juniper` (`j1`), `pip` (`p1`) |
| `access` | `read`, `write` (default) |
| `run` | `running`: the bot is working, so the composer shows Stop |
| `prefs` | `none`: no durable user, so settings are kept on this device; `unknown`: the saved settings couldn't be read |
| `voice` | `ready` (default), `none` (not set up), `direct` (no relay), `unknown` (couldn't be read) |
| `provider` | `openai-eu`: the same label as before under another id, so consent is asked again |
| `drift` | `1`: the gateway answers the create with another provider |
| `dict` | `ready` (default), `none` |
| `route` | `device` or `gateway`: the dictation route already chosen |
| `os` | `mac` (default), `windows`, `web` (the browser preview on this computer), `remote` (the browser preview from another computer over plain http), `iphone` |
| `ondevice` | `0`: this Mac can't recognize the language on its own |
| `mic` | `granted` (default), `prompt`, `denied`, `none`, `missing` (the chosen one isn't connected) |
| `speech` | `prompt`, `denied`: Apple speech recognition |
| `seen` | `1`: these destinations were accepted before |
| `long` | `1`: long gateway and provider names |
| `inject` | `1`: markup-shaped names, voice, refusal and caption, which must show as text |
| `files`, `token`, `picker`, `draft` | `pending` or `refused`; `slash` or `mention`; `1`: the "/" menu open; a draft's text |
| `state` | `consent`, `dictconsent`, `dictating`, `dictfail`, `connecting`, `live`, `muted`, `speaking`, `thinking`, `transcript`, `settings`, `micgone`, `revoked`, `background`, `limit`, `second`, `ending`, `unconfirmed`, `lost`, `reconnected`, `refused`, `failed` with `reason=none` or `error`, `voicechange`, `voicefail`, `novoices`, `langsaved`, `voicegone` |
| `line` | `here` (this device's line), `elsewhere`, `interleave` (two calls and a typed message), `noid`, `empty` |
| `memo` | `inline` (default), `grant`, `expired`, `wrongroute`, `redirect`, `big`, `fail`, `address`, `scheme`, `nohttp` (a grant, on the iPhone), `two` (two clips and an attachment) |
| `shortcut` | `dict`, `call` (with `shortcutbot`), `action` |
| `page` | `settings`: Settings › Voice |

## 16. Not covered here

- **The composer itself**, as built: its layout, keys, menus, drafts and sending. This design adds what section 3 lists and nothing more.
- **Siri, Shortcuts and the Action Button's system screens**, and the iPhone app's own call screen beyond the band at 390 px: the iOS app is not on `main` yet.
- **A client-owned call** (`talk.client.create`), and with it the gateway's own resume by `voiceSessionId`: its media goes to the provider's address, which `docs/decisions.md` never opens (section 2).
- **A language change during a call**, and resuming a call after a drop: the gateway establishes neither (sections 7 and 8).
- **Setting up a voice provider on the gateway**: OpenClaw's own Talk settings, which need admin.
- **Video in a call**, steering a bot's work by voice (`talk.session.steer`), and the gateway's spoken confirmations for high-impact actions: the bot asks for those in the call, and they are not drawn here.
- **Meeting transcripts** (`transcripts.*`) and the gateway's "Voice call changes" digest, which goes to a messaging channel, not to Clawtrate.
- **Text to speech of a typed reply** (`tts.*` settings, automatic TTS): a gateway setting with no row here.
