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
| The call's settings                           | `.call-settings`       | 7       |
| The live transcript                           | `.call-transcript`     | 6       |
| The "Voice chat" line                         | `.call-line`           | 10      |
| The memo's text and speed                     | `.memo-text`, `.speed` | 11      |

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

| Setting                                                                                          | Kept                                                                                                          | Why there                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each bot's voice, speed and language                                                             | The `clawtrate.voice` user preference on the gateway (`users.prefs`), so every device of the person uses them | The same store and the same compare-and-set as `clawtrate.sidebar` and `clawtrate.budgets` on `main` (`packages/core/README.md`); written at the interactive tier |
| The same, on a connection with no durable user (`users.prefs.get` answers `no_durable_identity`) | This device, per gateway identity (`gateway.identity.get`) and bot                                            | As the sidebar does when its `status` is `unavailable`                                                                                                            |
| The microphone                                                                                   | This device                                                                                                   | A device's names are its own                                                                                                                                      |
| The dictation route                                                                              | This device, per gateway                                                                                      | What a device can recognize is its own                                                                                                                            |
| A call's duration, for its line                                                                  | This device, for the calls it held (section 10)                                                               | Only the device that held the call counted it                                                                                                                     |
| "Where your voice goes" seen                                                                     | This device, per gateway, route and provider                                                                  | It is said to the person at this device                                                                                                                           |

Each per-bot control says where it is kept in one line: "Saved for Otto on Home gateway, so your other devices use it too." or, with no durable user, "Kept on this device for Otto." A write the gateway refuses or answers with a conflict follows the sidebar's way (it is applied again to the newer value, at most four times); one that still fails leaves the choice on this call and says "Couldn't save this for Otto: <the gateway's message, as text>." The gateway keeps at most 4,096 bytes in one preference (`value-too-large`, as `MAX_SIDEBAR_BYTES` records); a change past it is refused in those words. A setting changed on another device arrives on `users.prefs.changed` and applies from the next call; it never changes a call that is on.

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

- Every surface here is drawn at 1440, 1100, 800 and the 390 px one-pane layout, light and dark, in the product's tokens; at 390 the controls take touch sizes (44 px).
- Keyboard: every control is a button or a radio group; the call band's actions are in reading order (Mute, Transcript, Settings, Hang up); the call's settings and the consent sheet trap focus and return it to what opened them; Escape closes them.
- Screen readers: the band is a `region` named "Voice chat with Otto"; the microphone mark's words are its text, not only its colour; the live transcript is a `log`; disabled buttons carry their reason as a description.
- Motion: the microphone mark's pulse while listening and the phase's level meter hold still under reduced motion.

### Announcements

The conversation's polite live region speaks for voice, and only for these: "Listening", "Dictation stopped. The text is in your message.", "Voice chat with Otto started", "Muted", "Unmuted", "Voice chat ended", "Reconnecting the voice chat", "Voice chat with Otto reconnected", "Voice chat failed: Connection lost" (and the other reasons), "Voice: Cedar, from Otto's next reply", "The voice didn't change", "Language: Español, from what you say next", "The language didn't change". They go through the conversation's built announcer (`onAnnounce`, the polite `status` region). Live transcript lines are not announced; the transcript region is a `log` the person can read.

## 3. The two buttons in the composer

The built row is, in order: "Attach files" (+), the field, "How to send" (only while a run is on and the field has text), "Stopping…", Stop (while a run can be stopped), Send. The two buttons go after "How to send" and before "Stopping…" and Stop, so Stop and Send keep their place at the end of the row. They are the row's own round icon buttons (`icon-button`), quiet, the size of their neighbours; on touch, where those are 40 px, each has a 44 px hit area.

| Button                    | Label                                      | Shown                                                                                                                          | States                                                                                                                                                              |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microphone                | "Start dictation" (⌘D, Ctrl+D off the Mac) | Always, in the composer                                                                                                        | Ready; Listening (filled `--danger`, "Stop dictation"); Disabled with a reason (during a call; no route; no microphone; a page over plain http)                     |
| Voice chat (the waveform) | "Start voice chat"                         | Only while the composer is empty: no text, no attachment, no "/" or "@" chip (F-254); typing hides it, clearing shows it again | Ready; "In a voice chat" while this task's bot is on a call (pressed; it moves focus to the call band); Disabled with a reason (not set up; a page over plain http) |

A disabled button keeps focus and its reason as its description (`aria-description`, as the built Send does), so a keyboard or screen reader user hears why. "Not set up" and "Can't tell" come from `talk.catalog` (section 5). Both are shown during a run: a call or dictation does not depend on whether the bot is working.

**Keys.** ⌘D starts and stops dictation while the composer is reachable (the built `reachable()`) and no dialog is open. Held for more than 400 ms it is hold to talk: dictation stops when the key is released. Pressing and holding the microphone button does the same; on touch this is the microphone's own press, apart from Send's long press, which opens the send sheet as built. Escape in the field stops dictation and keeps the text; with a "/" or "@" menu open, Escape closes the menu first, as built. In a browser, ⌘D and Ctrl+D bookmark the page; the web preview asks for them and the button always works. Voice chat has no shortcut. ⌘D is taken by nothing in the app (research §9; the built window keys are ⌘., ⌘↵, ⌘I and ⌘L).

**Stop is the composer's.** Stop and ⌘. stop the bot's run, as built, during a call too; they neither end the call nor mute it. "Stop now" dictated and sent during a run is Stop, as when it is typed (the built `isStopNow`).

### Where the built composer would have to change

| Change                                                                                                                                    | In `Composer.tsx` today                                                     | Why                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| Two buttons in the row, after "How to send" and before "Stopping…" and Stop                                                               | The row ends: How to send, Stopping…, Stop, Send                            | Section 3                                                 |
| A voice state and its actions as props: the catalog's answer, this device's call, dictation                                               | The props have no voice                                                     | The buttons' states                                       |
| Dictated words go in at the caret through `setText`, which writes the draft, without `watchCaret`: dictated text opens no "/" or "@" menu | Text changes only from typing, pasting and the menus                        | Section 4                                                 |
| A dictation line under the row (`.dictation-line`) for "Listening", where the words go and the words not yet final                        | The field is a plain `textarea`, which cannot colour part of its text       | Section 4: words not yet final are never put in the field |
| ⌘D and its key-up in the window-wide key handler, under its `command()` and `reachable()` guards                                          | The handler has ⌘., ⌘↵, ⌘I and ⌘L                                           | Hold to talk                                              |
| `sendAs` stops dictation first; what is in the field is sent, and words not yet final are dropped                                         | `sendAs` sends the field                                                    | Section 4                                                 |
| Dictation's failures are notices on the shelf (`onNotice`, with "Try again" and "Dismiss")                                                | Built: the shelf already shows notices with a title, a reason and Try again | No new surface                                            |

Nothing else of the composer changes: its layout, the menus, the send modes, the shelf, drafts and attachments stay as built. The call band lives in `Conversation.tsx`, directly above the composer and under the usage notes (`UsageNotes`), and is not part of the composer.

## 4. Dictation

### Choosing the route

The first press opens the consent sheet for dictation, which lists the routes this device has, each a choice row with its sentence (section 2):

| Device                                                  | Routes listed                                                                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac, with a language the recognizer supports on its own | "On this Mac" and "Through Home gateway" (when the gateway's transcription is ready)                                                          |
| Mac, without one                                        | "Through Home gateway" only, with "On this Mac isn't available for English (United States): this Mac can't recognize it without the network." |
| Windows                                                 | "Through Home gateway" only, with "Windows has no speech recognition Clawtrate can use without sending your voice to Microsoft."              |
| iPhone                                                  | "On this iPhone", and "Through Home gateway"                                                                                                  |
| Neither available                                       | The sheet says "Dictation isn't available here" with the reasons, and offers only "Close". The button is then disabled with the same reason.  |

The choice is kept (section 2) and changed in Settings › Voice.

### Listening

- The button turns `--danger` with "Stop dictation". The dictation line under the composer's row says "Listening · Microphone on", then where the words go ("On this Mac" or "Through Home gateway").
- Words not yet final are shown only in the dictation line, after "Not final yet:", in `--text-faint`. Final words go into the field at the caret, through the composer's own `setText`, and take the draft's colour. The built field is a plain `textarea`, so nothing in it is ever a guess. On the gateway route partial and final words are `transcript.delta` and `transcript.done` (research §3); on the device, the recognizer's partial and final results.
- The text is the draft's: editable, unsent, kept with the draft as typed text is (`writeDraft`, per gateway and task). Dictation never sends, and dictated text opens no "/" or "@" menu.
- Stopping: the button, ⌘D, Escape, releasing the held key, sending the message (dictation stops, the final words are sent with the rest, and words not yet final are dropped), leaving the task, closing the window, the app going to the background on the iPhone. The region says "Dictation stopped. The text is in your message."
- The gateway route closes its session with `talk.session.close` when dictation stops, and the gateway closes it anyway when the connection ends or after 30 minutes (research §5). A session that ends while listening keeps the words already in the draft, and the shelf shows the notice "Dictation stopped." with "Home gateway ended it." Dictation is not started again by itself.

### When dictation can't start

What is known before pressing disables the button with its reason; what is learnt by trying is a notice on the composer's shelf (the built `onNotice`: a title, a reason, "Try again" where trying again can help, and "Dismiss").

| Cause                                                                 | Where                | The words                                                                        | Rests on                                                                                                                                |
| --------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The gateway's transcription isn't set up, and the device has no route | The button, disabled | "Dictation through Home gateway isn't set up on the gateway."                    | `talk.catalog` `transcription.ready: false`; create answers `UNAVAILABLE` "No realtime transcription provider registered" (research §1) |
| Not connected (gateway route)                                         | The button, disabled | "Not connected to Home gateway."                                                 | The connection's state                                                                                                                  |
| The gateway refused                                                   | A notice             | "Couldn't start dictation." and the gateway's message, as text, with "Try again" | The create's error, `MISSING_SCOPE` among them                                                                                          |
| The microphone refused, or none                                       | A notice             | Section 2's words, with "Try again"                                              | research §4                                                                                                                             |

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

- **Phase** from the relay's `talk.event` frames (research §2): "Listening" after `ready` and between replies; "Thinking" from `responseStarted` until audio; "Otto is speaking" while reply audio plays here. Nothing else is claimed.
- **Time** is counted on this device from `ready`, and labelled "on this device".
- **The microphone mark**: "Microphone on", or "Microphone off" while muted.
- **Mute** (`aria-pressed`): the device stops capturing and sends nothing, and the microphone is released. The band says "Muted. This device's microphone is off." and the button reads "Unmute". Unmuting opens the microphone again (the chosen one; section 2 if it is gone). The gateway is not told: muting is this device's.
- **Transcript** opens the live transcript under the band, a `log`: "You" and "Otto" lines from the frames' transcript events, words not yet final in `--text-faint`. Under it: "Saved in this task as it's said." The saved messages appear in the conversation as history brings them (section 10).
- **Settings** opens the call's settings (section 7).
- **Hang up** (`--danger`) ends the call (section 8).
- **Thirty minutes.** A relayed session lasts 30 minutes, counted from the start of the call's current session (a change of voice or language, or a reconnect, starts a new one). At its 28th minute the band adds "Home gateway ends calls after 30 minutes. This one ends at 5:59 PM." At 30 the gateway closes it (research §5): the band goes, the line is left (section 10), and the region says "Voice chat ended: Home gateway ends calls after 30 minutes."
- **The microphone goes away** during a call (its track ends; research §4): "The microphone stopped: USB Microphone was disconnected. Nothing is being sent." with "Use System Default" and "Hang up". The call stays open on the gateway until it ends by itself; nothing is sent meanwhile.
- **Typing during a call** is allowed: a message sent goes into the same task as usual.

Widths: at 1440, 1100 and 800 the band spans the conversation column above the composer. At 390 the actions wrap to a second row and Hang up keeps its place at the end; the time stays on the first row. Docked or not, the Work pane never covers it.

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

Consecutive saved messages whose `provenance.kind` is `realtime_voice` (research §6) are folded under one line, `.call-line`, a button in the transcript where they begin:

| Where                                           | The line                                                                                                              | Rests on                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The device that held the call                   | "Voice chat · 2:14", the duration it counted                                                                          | Its own count, kept with the task (section 2)        |
| Any other device, or this one without the count | "Voice chat · 6 turns · 5:31–5:36 PM"                                                                                 | The rows' count and their first and last `timestamp` |
| A call that saved nothing                       | On the device that held it: "Voice chat · 0:40 · nothing was saved". Elsewhere: nothing, since nothing is in the task |                                                      |

Pressing the line opens the transcript in place (F-111): the folded turns as the conversation's own messages, "You" and "Otto", each with its time. `aria-expanded` follows. Turns typed during the call stay between the spoken ones where they fall. The line is a heading-level landmark for moving by call.

## 11. Voice memos

A memo is an audio item a bot sent (research §8). Its card is the audio card of `work-pane.md` section 12, with two additions:

- **Speed**: the bot's speed (section 7), shown as "1×" on the player, which cycles through the speeds.
- **"Show text"**, an expander, when the item came from a `tts` call in the same run: the call's `text`, headed "The text this was made from". Without one: "No text came with this recording." Nothing is called a transcript.
- **Word highlighting (F-413) is not available**: under the text, in `--text-faint`, "Words aren't highlighted: the gateway gives no timing for each word." Nothing moves while it plays.

**Where its sound comes from** follows `docs/decisions.md`, "Addresses a gateway hands the client" (rows "An item a reply hands over" and "Every other address an item carries"; building it is #71). The item is asked for with `artifacts.download` (`operator.read`):

| The gateway answers                                                                                                   | The card                                                                                                                                                    | Rests on                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `encoding: "base64"` and `data`                                                                                       | Plays from those bytes as a `data:` address, decoded under the 5 MiB item limit; no HTTP request                                                            | The decision: bytes from the existing connection                                                            |
| A grant: top-level `url` on one of the two grant routes of the connection's own origin, with an unexpired `expiresAt` | The host fetches it, at most 5 MiB, with no redirect, cookie or credential but the grant; the grant's address never reaches the interface; then as above    | The decision: the host fetches, never a renderer or a viewer's browser                                      |
| A grant, on the iPhone                                                                                                | "This voice memo can't be played on this iPhone yet: Home gateway offers it as a download, and the iPhone app doesn't make downloads yet."                  | The decision: iPhone HTTP downloads stay unavailable until their check exists                               |
| An address the item carries (`audio_url`, or one `artifacts.download` passes through from the transcript)             | "This voice memo is at an address Clawtrate doesn't open by itself:" and the full address as text, with "Open in browser", which opens it outside Clawtrate | The decision: never fetched; opening follows the link row, and the full address is shown beside the control |
| More than 5 MiB                                                                                                       | "This voice memo is 7.2 MiB. Clawtrate fetches items up to 5 MiB, so it can't be played here."                                                              | The decision's size limit                                                                                   |
| A failure                                                                                                             | "Couldn't load the voice memo." with "Try again"                                                                                                            |                                                                                                             |

Nothing an address names is fetched by itself, on the gateway's origin or not. Playing a memo needs only read access. One recording plays at a time, and a memo pauses when a call starts.

## 12. Settings, Voice

A section of the Settings dialog (`bots.md` section 7), after the shell's own sections.

| Group              | Rows                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microphone (F-392) | "System Default", then each device by its name, a radio group. Before access is allowed, names are unknown: "Allow microphone access to see your microphones' names." with "Allow". The chosen device, when not connected: "USB Microphone isn't connected. Voice won't use another microphone without asking." "Kept on this device."                                |
| Dictation          | The route, as in section 4, each with its sentence; the unavailable ones with their reason                                                                                                                                                                                                                                                                            |
| Voice chat         | One line from `talk.catalog`: "Home gateway relays calls to OpenAI Realtime Voice." with the voice chat sentence of section 2, or "Voice chat isn't set up on Home gateway. Its owner sets up a voice provider in OpenClaw's Talk settings." or "Can't tell whether voice chat is set up on Home gateway."                                                            |
| Bots               | Each bot's kept voice, speed and language, read-only, with "Reset" per bot, and under them where they are kept: "Saved on Home gateway, so your other devices use them too.", or with no durable user "Kept on this device, for each bot: this connection has no user profile on the gateway." On a read-only connection "Reset" is disabled with "Needs more access" |

The device list follows `devicechange`: a device added appears, one removed is marked as not connected.

## 13. What each fact drives

| Shown                                                 | Driven by                                                                                                            | Tier                                | Evidence                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Voice chat set up, its provider's name                | `talk.catalog` `realtime.ready`, `activeProvider`, the provider's `label` and `transports`                           | read                                | research §1, live                                                                               |
| Dictation through the gateway set up                  | `talk.catalog` `transcription.ready`, `activeProvider`                                                               | read                                | research §1, live                                                                               |
| Starting a call                                       | `talk.session.create {sessionKey, voice?, language?, capabilities}` (realtime, `gateway-relay`, `agent-consult`)     | `operator.talk` (write)             | research §1 live refusals; §2 source                                                            |
| Sending audio                                         | `talk.session.appendAudio` (PCM16 24 kHz)                                                                            | `operator.talk`                     | research §2, source                                                                             |
| Phase, live transcript, a failure                     | `talk.event` frames to this connection                                                                               | read                                | research §2, source                                                                             |
| Hang up                                               | `talk.session.close`                                                                                                 | `operator.talk`                     | research §2, live (unknown id)                                                                  |
| A session ends with its connection, and at 30 minutes | Connection cleanup; `RELAY_SESSION_TTL_MS`                                                                           |                                     | research §5, source                                                                             |
| Reconnecting a call after a drop                      | A new `talk.session.create` on the same task after the reconnect, within 30 s                                        | `operator.talk`                     | research §5; not exercised                                                                      |
| One call at a time                                    | This client                                                                                                          |                                     | research §5                                                                                     |
| Voice                                                 | `talk.voice.set`, `talk.voice.change`, a replacement create, `talk.voice.complete`                                   | `operator.talk`                     | research §7, live (no call)                                                                     |
| Speed                                                 | This device's playback                                                                                               |                                     | research §7                                                                                     |
| Language                                              | `language` on `talk.session.create`; during a call, a second session, then `close` of the first                      | `operator.talk`                     | research §5 (two per connection), §7 live validation; the switch not exercised                  |
| Where each bot's voice, speed and language are kept   | `users.prefs.get` and `set` (`clawtrate.voice`, compare-and-set), `users.prefs.changed`                              | read to read it, write to change it | `docs/research/gateway-capabilities.md` (`users.prefs`, live); as `clawtrate.sidebar` on `main` |
| The "Voice chat" line and its transcript              | History rows with `provenance.kind: "realtime_voice"`; this device's count                                           | read                                | research §6, source                                                                             |
| Dictation through the gateway                         | `talk.session.create {mode: "transcription"}`, `appendAudio` (µ-law 8 kHz), `talk.event`, `close`                    | `operator.talk`                     | research §3                                                                                     |
| Dictation on the device                               | Apple's Speech framework with on-device required                                                                     |                                     | research §3, documented                                                                         |
| A memo and its text                                   | `artifacts.list`, `artifacts.download` (bytes or a grant, under `docs/decisions.md`); the run's `tts` call arguments | read                                | research §8, source                                                                             |
| No word highlighting                                  | No word timings exist                                                                                                |                                     | research §8                                                                                     |
| The microphone                                        | `getUserMedia`, `enumerateDevices`, `devicechange`, the track's `ended`; macOS's `askForMediaAccess`                 |                                     | research §4, documented                                                                         |

## 14. Parity rows

Rows reworded in `docs/parity.md`, statuses unchanged. Each target keeps its first word; a note after `same` only narrows it. The dependency column is replaced by the evidence.

| Row   | Clawtrate column                                                                                                                                                                                                                                  | Dependency column                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-111 | same; note: on the device that held the call the line shows the duration it counted; elsewhere it shows the saved turns' count and their first and last time.                                                                                     | partial: the relay saves each finalized utterance as a message with `provenance.kind: "realtime_voice"` and a timestamp (history, `operator.read`); no call record with a duration is readable; the duration is the device's own count (research §6).                                                                                                                                                                                                                                                                   |
| F-253 | same; note: the text comes from Apple's recognizer with on-device recognition required (macOS) or from the gateway's transcription session; Windows has the gateway route only; the screen names where the audio goes before the first recording. | partial: gateway route `talk.session.create {mode: "transcription", transport: "gateway-relay", brain: "none"}` with `appendAudio` and `close` (`operator.talk`, which `operator.write` satisfies), not exercised beyond its refusal with no transcription provider; device route: Apple's Speech framework with `requiresOnDeviceRecognition`; Chromium's recognition is not used (research §3).                                                                                                                       |
| F-254 | same; note: the call is relayed through the gateway (`talk.session.create`), never connected by the app to the voice provider.                                                                                                                    | partial, not exercised beyond its refusal with no voice provider: `talk.session.create` (realtime, `gateway-relay`, `agent-consult`) with the Bot's `sessionKey`, audio by `appendAudio`, `close`; frames from `talk.event` to the owning connection; `talk.catalog` (`operator.read`) says whether it is set up (research §1, §2). `talk.client.create` is not used: its media goes between the device and the provider's own address, which `docs/decisions.md` ("Addresses a gateway hands the client") never opens. |
| F-255 | same; note: the transcript is the text the Bot's `tts` call was given, headed "The text this was made from"; the check uses a memo made by a `tts` call.                                                                                          | partial: a memo is an audio item (`artifacts.list`, `artifacts.download`, `operator.read`), played from returned bytes or a grant the host fetches (`docs/decisions.md`); no transcript field exists; the text is the `tts` call's argument (research §8).                                                                                                                                                                                                                                                              |
| F-392 | same; note: device names appear once microphone access is allowed; a chosen device that isn't connected is never silently replaced.                                                                                                               | client only: `enumerateDevices`, `devicechange`; the choice is kept on the device (research §4).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F-409 | same; note: Apple's recognizer with on-device recognition required, or the gateway's transcription session.                                                                                                                                       | client only, or as F-253's gateway route (research §3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Rows met as written, their cells unchanged: F-407, F-408 and F-460 (entry points into states this design has), F-411, F-412, F-413 (its no-highlight branch applies), F-461.

Rows left as they are, for a decision. This design meets each target as it stands; only the dependency cells are out of date. Proposed cells, targets and statuses unchanged:

- **F-410**, target unchanged. Dependency: "partial, not exercised beyond its refusal with no call: every call is created with `capabilities: ["voice-selection"]`; `talk.voice.set {voice, voiceSessionId}` (`operator.write`) makes the gateway send `talk.voice.change` for a relayed call, and the client creates the replacement (`talk.session.create {…, voiceChangeId}`) and reports with `talk.voice.complete`; the gateway refuses only for a call without `voice-selection` or an empty voice list, or a voice outside the call's catalog (research §7). The Bot's voice is kept in the `clawtrate.voice` user preference (`users.prefs`), or on the device with no durable user."
- **F-462**, target unchanged. Dependency: "partial, not exercised: `language` (two lowercase letters) is accepted only by `talk.session.create`, which passes it to the realtime provider; no method changes it during a session (research §7). The client starts a second relayed session with the new `language` on the same `sessionKey` while the first runs (two per connection, research §5), moves the audio to it when it is `ready` and closes the first, so the change applies from what is said next; what a provider keeps across the two sessions is not established. Kept as F-410."
- **F-463**, target unchanged. Dependency: "partial, not exercised: the gateway closes a relayed session with its connection and forgets it ("Unknown Talk session" after a reconnect; research §5); resuming by `voiceSessionId` exists only for `talk.client.create`, whose media goes to the provider's own address, which `docs/decisions.md` never opens. The client resumes the call itself: after a reconnect within 30 seconds (Clawtrate's choice) it creates a new relayed session on the same `sessionKey` with the same voice and language, and the band, its time and its line continue as one call; what was said during the drop is not heard."

## 15. For builders

### What each part uses

| Part                                   | Uses                                                                         | New                                              |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| The two buttons and the dictation line | The composer's row (`Composer.tsx`), round icon buttons; the shelf's notices | `.mic-button`, `.call-button`, `.dictation-line` |
| The consent sheet                      | The small dialog; choice rows (`bots.md`)                                    | `.voice-consent`                                 |
| The call band                          | `--bg-bubble`, buttons, the avatar                                           | `.call-band`, `.mic-mark`                        |
| The live transcript                    | Message text styles                                                          | `.call-transcript` (`role="log"`)                |
| The call's settings                    | `.menu`'s surface, radio rows                                                | `.call-settings`                                 |
| The line                               | Event line, expander                                                         | `.call-line`                                     |
| Memos                                  | The audio card (`work-pane.md` §12)                                          | `.memo-text`, `.speed`                           |
| Settings › Voice                       | Settings sections and rows (`bots.md` §7)                                    |                                                  |

### What the host does

- **Permissions.** Electron's permission handler grants `media` for audio only, to the app's own audio requester and its own origin, and nothing else (`lockDownSession` allows only the clipboard today). On macOS, `systemPreferences.getMediaAccessStatus` and `askForMediaAccess("microphone")` after the person chose Start, and Speech Recognition for Apple dictation. The web preview asks its own origin for audio only, in a secure context. The iPhone asks for the microphone and speech recognition separately.
- **Packaging, for the packaging owner** (not changed here): `NSMicrophoneUsageDescription` in `mac.extendInfo`; an entitlements file with `com.apple.security.device.audio-input` for the hardened runtime; for the on-device dictation route, `NSSpeechRecognitionUsageDescription` and the native recognizer (a helper or a native module); `media-src` already allows `data:` for a memo's bytes. Nothing on Windows.
- **Audio.** The renderer captures and plays; the host sends and receives. Captured audio crosses the bridge to the host, which calls `appendAudio` only for a relay that is ready, whose provider was checked against the accepted one; reply audio crosses back. The web host's bridge frame limit (`MAX_BRIDGE_FRAME_BYTES`) bounds a frame on the bridge and nothing else. No audio is written to disk, a log, the bridge's replay or a crash report, and in-memory audio is dropped when capture or playback stops. The on-device dictation route gives raw audio only to the recognizer with on-device recognition required; it never crosses the gateway bridge.
- **Permission loss or a track that ends** stops capture and drops what wasn't sent (section 2); capture is opened again only by the person's choice.
- **One call per host**, across windows and tabs. A start is refused by the host before it reaches the gateway while any relay of this device is being created, is open, is closing or may still be open; a cancelled start's late answer is closed at once.
- **On a dropped connection**, the host stops capture and playback at once, marks every relay of that connection as possibly open until its scheduled end, and never starts a call by itself.

### What the engine supplies

- From `talk.catalog`, after every hello: whether voice chat and gateway dictation are ready, the active providers' labels, `transports`, voices by model.
- A call: its state (asking for the microphone, connecting, listening, thinking, speaking, muted, reconnecting, ending, ended, failed with its reason), its phase from frames, its live transcript, its time from the first `ready`, its current session and when that session started, its voice-change and language-change states.
- From history: runs of rows with `provenance.kind: "realtime_voice"`, folded per call, with count and first and last time; the device's own count joined by the task and the first row's time.
- For a memo: the matching `tts` call's `text`, when the item came from one in the same run.
- The settings kept per bot in `clawtrate.voice`, or on the device with no durable user, and the device's own (section 2).

### What the gateway must supply

Nothing new for what is designed here. A relayed session that survived its connection would let a reconnect keep what the provider heard (F-463), and a method that changed a session's language would avoid the second session (F-462); word timings would let a memo highlight its words (F-413). None is asked of a plugin: the design does without them, and says what each costs.

### Order to build

1. The microphone: permissions, the device list, Settings › Voice's Microphone group, the states of section 2. Check F-392.
2. The catalog read and the buttons' states, the access bar.
3. Dictation through the gateway, with its consent and states. Check F-253 (gateway route) and F-409's gateway route.
4. Dictation on the device, once the native recognizer is in place. Check F-253 and F-409.
5. A relayed call: start, band, mute, hang up, reconnecting, failures, 30 minutes. Check F-254, F-411, F-463.
6. One call at a time. Check F-412.
7. Voice, speed, language, with the `clawtrate.voice` preference. Check F-410, F-461, F-462.
8. The "Voice chat" line. Check F-111.
9. Memos, their text and speed. Check F-255, F-413.
10. The iPhone entry points with the iOS app. Check F-407, F-408, F-460.

### Prototype states

`prototype/voice.html` takes the prototype's own `theme`, `width`, `motion` and `chrome`, and these. The bar fires what the gateway and the device do.

| Parameter     | Values                                                                                                                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot`, `task` | `otto` (`o1`), `juniper` (`j1`), `pip` (`p1`)                                                                                                                                                                                                                                                                                           |
| `access`      | `read`, `write` (default)                                                                                                                                                                                                                                                                                                               |
| `run`         | `running`: the bot is working, so the composer shows Stop                                                                                                                                                                                                                                                                               |
| `prefs`       | `none`: the connection has no durable user, so settings are kept on this device                                                                                                                                                                                                                                                         |
| `voice`       | `ready` (default), `none` (not set up), `direct` (no relay), `unknown` (couldn't be read)                                                                                                                                                                                                                                               |
| `dict`        | `ready` (default), `none`                                                                                                                                                                                                                                                                                                               |
| `os`          | `mac` (default), `windows`, `web` (the browser preview on this computer), `remote` (the browser preview from another computer over plain http), `iphone`                                                                                                                                                                                |
| `ondevice`    | `0`: this Mac can't recognize the language on its own                                                                                                                                                                                                                                                                                   |
| `mic`         | `granted` (default), `prompt`, `denied`, `none`, `missing` (the chosen one isn't connected)                                                                                                                                                                                                                                             |
| `seen`        | `1`: where the audio goes was already shown                                                                                                                                                                                                                                                                                             |
| `state`       | `consent`, `dictconsent`, `dictating`, `dictfail`, `connecting`, `live`, `muted`, `speaking`, `transcript`, `settings`, `micgone`, `limit`, `second`, `ending`, `endfail`, `reconnecting`, `reconnected`, `failed` with `reason=drop`, `none` or `error`, `voicechange`, `voicefail`, `novoices`, `voicegone`, `langchange`, `langfail` |
| `line`        | `here` (this device's line), `elsewhere`, `empty`                                                                                                                                                                                                                                                                                       |
| `memo`        | `ready`, `text`, `notext`, `big`, `fail`, `address` (an address the item carries), `nohttp` (a grant, on the iPhone)                                                                                                                                                                                                                    |
| `page`        | `settings`: Settings › Voice                                                                                                                                                                                                                                                                                                            |

## 16. Not covered here

- **The composer itself**, as built: its layout, keys, menus, drafts and sending. This design adds what section 3 lists and nothing more.
- **Siri, Shortcuts and the Action Button's system screens**, and the iPhone app's own call screen beyond the band at 390 px: the iOS app is not on `main` yet.
- **A client-owned call** (`talk.client.create`), and with it the gateway's own resume by `voiceSessionId`: its media goes to the provider's address, which `docs/decisions.md` never opens (section 2).
- **Setting up a voice provider on the gateway**: OpenClaw's own Talk settings, which need admin.
- **Video in a call**, steering a bot's work by voice (`talk.session.steer`), and the gateway's spoken confirmations for high-impact actions: the bot asks for those in the call, and they are not drawn here.
- **Meeting transcripts** (`transcripts.*`) and the gateway's "Voice call changes" digest, which goes to a messaging channel, not to Clawtrate.
- **Text to speech of a typed reply** (`tts.*` settings, automatic TTS): a gateway setting with no row here.
