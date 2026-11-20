# Voice

Speaking to a bot instead of typing: dictation into the composer, a voice chat with a bot, the voice, speed and language of a call, the line a call leaves in the conversation, a bot's voice memos, and the microphone setting. This part of the design builds on `visual-language.md` and `conversation.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-111, F-253 to F-255, F-392, F-407 to F-413 and F-460 to F-463. What the gateway, the operating systems and the browser engine do is in `docs/research/voice.md` (cited as research §n); every state below names the fact it rests on, and section 13 lists them. Section 15 is for builders.

One rule sits above the rest: **before the microphone first opens for a route, the screen names where the audio goes, and the app never sends it anywhere else.** Nothing is called private. "Mute" and "Hang up" say what happened on this device, and say more only when the gateway answered.

Seven facts from the research and from `main` shape the design:

- **A call is relayed through the gateway, or it is not made** (research §2). On a relayed call the audio goes from this device to the person's gateway over the connection Clawtrate already holds, and the gateway sends it on to the voice provider it names. The other route the gateway offers, a client-owned call, has the device connect to the provider's own host; Clawtrate does not use it, because the app contacts no host but the gateway by itself.
- **A relayed session ends with its connection, and after 30 minutes** (research §5). The gateway closes every session a connection owned when that connection closes, so the gateway never resumes one after a drop. The app reconnects to the gateway by itself, as it always does, and after a short drop it starts the call again by itself, as a new relayed session on the same task, and says so (section 8).
- **What was said is saved in the task as text** (research §6). Each finalized utterance becomes an ordinary message, marked as spoken. Every device sees it. Only the device that held the call knows how long it lasted.
- **The gateway says whether voice is set up, at the read tier** (research §1). `talk.catalog` answers `ready` for voice chat and for dictation through the gateway, and names the provider. A read-only connection is refused every call and every gateway dictation with `operator.talk` missing.
- **Dictation has two routes with a stated destination** (research §3): Apple's recognizer on this Mac or iPhone, with on-device recognition required, and the gateway's transcription session. Chromium's own speech recognition is not used: it sends audio to a Google service. Windows has the gateway route only.
- **Speed is the device's; a session's language is set when it starts; a voice is changed on the call by the gateway** (research §7). Changing the language during a call starts a new relayed session for the call before the old one closes, as the gateway itself does for a voice (section 7). There are no word timings for a memo (research §8).
- **What a bot or the gateway supplies follows `docs/decisions.md`, "Addresses a gateway hands the client"**: a memo is played from bytes the gateway returns or from a download grant the host fetches; any other address is never fetched by itself; a provider's name and a gateway's message are text (sections 2 and 11).

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

Every route has one sentence, said before its first use (the consent sheet, sections 4 and 5) and always in Settings › Voice (section 12). The gateway's name is its name in the rail's footer; the provider's is its `label` in `talk.catalog`, shown as text.

| Route                             | The sentence                                                                                                                                                                                                                               | Rests on        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| Voice chat                        | "Your voice goes to Home gateway over this connection, and the gateway sends it to OpenAI Realtime Voice, which listens and speaks Otto's replies. What you both say is saved as text in this task. Clawtrate doesn't keep the recording." | research §2, §6 |
| Dictation through the gateway     | "Your voice goes to Home gateway, which sends it to OpenAI Realtime Transcription and sends the text back. Nothing of it is saved in the task. Clawtrate doesn't keep the recording."                                                      | research §3     |
| Dictation on this Mac (or iPhone) | "Apple's speech recognition turns your voice into text on this Mac, with its network use turned off. It's offered only for languages this Mac can recognize on its own."                                                                   | research §3     |

"Clawtrate doesn't keep the recording" is a rule for the builder: no audio is written to disk, to a log, to a crash report or to the bridge's history (section 15). Nothing here says what the gateway or the provider keep: the gateway saves the text (research §6), and what a provider does is the provider's.

A route whose destination cannot be stated is not offered: Chromium's speech recognition, and on-device dictation on Windows (research §3).

**What the gateway hands the client** follows `docs/decisions.md`, "Addresses a gateway hands the client". A call's audio is bytes on the connection Clawtrate already holds (`appendAudio` out, `talk.event` in), never an address. A client-owned call would hand the device a provider's address and credential to connect to, an address the gateway supplies, which that rule never fetches or opens: so Clawtrate does not create one (section 16). The provider's `label`, a gateway's refusal and a voice's name are shown as text: an address inside one stays text, never a link. The bot's picture in the call band is the rail's, under the same rule (a checked `data:` picture, otherwise its letter). A memo is section 11. "Open System Settings" opens the system's own Microphone pane, an address Clawtrate writes, not one the gateway supplies.

The consent sheet is shown once per route, per gateway and per provider, on this device; it is shown again when the provider's label changes. Its buttons are the route's action ("Start voice chat", "Start dictation") and "Cancel". Nothing opens the microphone before the person chooses the action.

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

| The catalog says                                                   | The voice chat button                                                                         | Pressing it                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------- |
| `realtime.ready: true`, its active provider offers `gateway-relay` | Ready                                                                                         | Starts (below)                   |
| `realtime.ready: false`                                            | Disabled: "Voice chat isn't set up on Home gateway."                                          | Nothing                          |
| Ready, but the active provider offers no `gateway-relay`           | Disabled: "Home gateway's voice provider talks to apps directly, which Clawtrate doesn't do." | Nothing                          |
| Couldn't be read (`AGENT_SELECTION_REQUIRED`, a failure)           | Ready, described "Can't tell whether voice chat is set up on Home gateway."                   | Starts; the create's answer says |

The not-set-up sentence is all the client can establish: the provider is set up by the gateway's owner in OpenClaw's own Talk settings, which need admin (research §1). Settings › Voice says that much.

### The walk

1. **Where your voice goes**, the first time (section 2). "Cancel" returns focus to the button and nothing opens.
2. **The microphone.** If the system must ask: "Waiting for microphone access…" in the call band, with "Cancel". Refused or no device: section 2, and nothing is sent to the gateway.
3. **Connecting.** `talk.session.create {sessionKey, voice?, language?, capabilities: ["voice-selection"]}` for the open task (research §2, §7); every call asks for `voice-selection`, so the gateway lets it change voices (section 7). The band says "Connecting to Otto…" with "Cancel". The microphone is open from step 2, the mark says "Microphone on", and no audio is sent until the gateway answers.
4. **Ready.** The answer, then the session's `ready` event: the band says "Listening", the time starts, and the region says "Voice chat with Otto started".

| At step 3 the gateway answers                               | The band                                                                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAVAILABLE` with `talkIssue.code: "realtime_unavailable"` | "Voice chat failed", "The call ended unexpectedly", and the gateway's message as text: "Realtime voice provider "openai" is not configured." (live, research §1) |
| "Too many active realtime relay sessions…"                  | "Voice chat failed", "The call ended unexpectedly", "Home gateway has too many calls open right now."                                                            |
| No answer and the connection drops                          | "Voice chat failed", "Connection lost" (section 8)                                                                                                               |
| Not connected when pressed                                  | "Voice chat failed", "No connection"                                                                                                                             |

A call is started only on the open task, so the bot is the task's (`sessionKey` selects it; research §2, the map's section 17).

### Entry points (iPhone)

Siri, Shortcuts and the Action Button only open states this design already has (F-407, F-408, F-460):

| Entry point                                      | Opens                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| "Start Dictation" (Siri, Shortcuts)              | The last open task's composer, dictating on the iPhone route; the consent sheet if it was never chosen |
| "Start Voice Chat" (Siri, Shortcuts), with a bot | That bot's last task, and step 1 or 2 of the walk above                                                |
| The Action Button, "Start Voice Chat"            | The same; pressed during a call, it hangs up (section 8)                                               |

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

The call's Settings open a `menu`-surface panel (`.call-settings`) under the band with three rows. Each says where it is kept (section 2): "Saved for Otto on Home gateway, so your other devices use it too."

### Voice (F-410)

- The list is the voices the call's provider offers for its model, from the create's answer or `talk.catalog` (`voices`, `voicesByModel`), with "Default" first, which means sending none.
- Choosing one calls `talk.voice.set {voice, voiceSessionId}`. For a relayed call the gateway answers with `talk.voice.change`; the client creates the replacement session (`talk.session.create {…, voiceChangeId}`) and reports with `talk.voice.complete` (research §7: "Setting a voice reconnects that call while preserving its chat and captions"). Meanwhile the row says "Changing to Cedar…" and the call goes on. When the replacement is ready: "Voice: Cedar, from Otto's next reply." The choice is kept for Otto at once.
- Refused or failed ("Voice is not in this call's catalog", a failed replacement): "The voice didn't change: <the gateway's message, as text>." The call goes on with its voice, and the kept choice stays what it was.
- The provider lists no voices for its model: the row says "OpenAI Realtime Voice offers no voices to choose from on Home gateway." and shows no list. (The gateway refuses a change only then, or for a call created without `voice-selection`, which Clawtrate never creates.)
- The kept voice is sent as `voice` when the next call starts. If the provider no longer lists it, the call starts without it and the band says once "Cedar isn't offered by Home gateway any more, so this call uses its default voice." The kept choice returns to Default.

### Speed (F-461)

- 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2×, a radio group. It changes how fast this device plays what the bot says, at once, and nothing on the gateway (research §7). The row says "Plays at 1.5× on this device." The choice is kept for Otto (section 2), so another device plays at the same speed.
- The same speed applies to this bot's voice memos (section 11).

### Language (F-462)

- "Auto-detect" (sending none) or a language, sent as its two-letter code when a session starts (research §7). "Home gateway passes it to its voice provider."
- **During a call**, a session's language cannot change (no method changes it; research §7), so choosing one starts a new relayed session for the same call: `talk.session.create {sessionKey, voice, language, capabilities}` on the same task, while the old session still runs (the gateway allows two per connection; research §5). When the new one is `ready`, the device sends its audio there and closes the old one with `talk.session.close`. Meanwhile the row says "Changing the language to Español…", and the old session keeps listening, so nothing said is lost. Then: "Language: Español, from what you say next." The band, its time and its transcript stay as they are: to the person it is one call. A reply the old session was still speaking is cut off.
- Refused or failed: "The language didn't change: <the gateway's message, as text>. The call goes on as before." The old session goes on, and the kept choice stays what it was.
- What the provider keeps of the call across the two sessions is not established (the bundled docs say a voice change preserves the chat and captions; nothing says so for this). The turns already said are saved in the task either way (section 10).
- On dictation through the gateway the language is not offered: "The gateway's dictation doesn't take a language in this version." On the device route the language is the recognizer's.

## 8. Ending a call, and a call that fails

### Hang up

| Step                                     | The band                                                                                                                                                                | Rests on    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Hang up                                  | The microphone is released and the reply audio stops at once; "Ending…"                                                                                                 | This device |
| The gateway answers `talk.session.close` | The band goes; the line is left (section 10); "Voice chat ended"                                                                                                        | research §2 |
| The close fails or isn't answered        | The band goes; the line is left, with under it: "Ended on this device. Home gateway didn't confirm; it ends the call when this connection closes, or after 30 minutes." | research §5 |

### When the connection drops (F-463)

The app reconnects to the gateway by itself (the status strip, as always). The gateway closed the call's session with the connection (research §5), and resuming a session by `voiceSessionId` exists only for client-owned calls, which Clawtrate does not create (section 2). So the client resumes the call itself, with a new relayed session:

| Step                                                              | The band                                                                                                                                                                                                            | What happens                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The connection drops                                              | "Voice chat with Otto · Reconnecting…", the time still counting, "Microphone off", and "The connection to Home gateway dropped. Nothing is being sent. The call starts again here when it reconnects." with Hang up | The microphone is released; reply audio stops; the region says "Reconnecting the voice chat"                                                                                        |
| The app is connected again within 30 seconds (Clawtrate's choice) | Back to "Listening", with the note "Reconnected. Home gateway closed the call's session when the connection dropped, so the call goes on in a new one. Nothing said while it was down was heard."                   | `talk.session.create` with the same `sessionKey`, voice and language; the microphone opens again only if the call was not muted; the region says "Voice chat with Otto reconnected" |
| Not connected within 30 seconds, or the new session is refused    | "Voice chat failed", below                                                                                                                                                                                          | Nothing more is tried                                                                                                                                                               |
| Hang up while reconnecting                                        | The band goes; the line is left                                                                                                                                                                                     | Nothing is sent to the gateway                                                                                                                                                      |

The microphone is opened again by itself only for a call the person started and did not end, and never after 30 seconds. At most one call is active throughout: the old session is gone before the new one is created. The time and the line count it as one call (section 10).

### A call that fails (F-411)

The band turns `--danger-soft`, says "Voice chat failed" and one reason, with "Dismiss". When the connection is back, the voice chat button offers "Start voice chat", which starts a new call.

| Reason                        | Second line                                                                                                           | When                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| "Connection lost"             | "The connection to Home gateway dropped and didn't come back within 30 seconds. What was said is saved in this task." | The connection stays down past 30 seconds during a call, or drops while connecting                         |
| "No connection"               | "This device isn't connected to Home gateway. Start again when it reconnects."                                        | Pressed while not connected                                                                                |
| "The call ended unexpectedly" | "Home gateway ended the call: <its reason, as text>."                                                                 | An `error` or `close` frame with reason `error` (research §2), or a refusal at the start or at a reconnect |

## 9. One call at a time

- **This device holds at most one call** (F-412), across all its windows and tabs, since they share one connection (research §5). The gateway itself allows two sessions per connection, and Clawtrate uses the second only for a moment, while a change of voice or language hands the call over to a new session (section 7); another device can hold its own call with the same bot at the same time.
- Pressing "Start voice chat" in another task while a call is on asks, in a small dialog: title "End the current voice chat?", body "You're in a voice chat with Otto. Ending it starts one with Juniper.", buttons "End and Chat" (default) and "Cancel". "End and Chat" hangs up (section 8) and, once the band has gone, starts the new call from step 1 or 2. "Cancel" leaves the call as it was and returns focus. Escape is Cancel.
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

- **Permissions.** `lockDownSession` grants `media` for audio only, to the app's own pages, and nothing else. On macOS, `systemPreferences.getMediaAccessStatus` and `askForMediaAccess("microphone")` before the first capture.
- **Packaging, for the packaging owner** (not changed here): `NSMicrophoneUsageDescription` in `mac.extendInfo`; an entitlements file with `com.apple.security.device.audio-input` for the hardened runtime; for the on-device dictation route, `NSSpeechRecognitionUsageDescription` and the native recognizer (a helper or a native module); `media-src` already allows `data:` for a memo's bytes. Nothing on Windows.
- **Audio.** The renderer captures and plays; the host sends and receives. Captured audio crosses the bridge to the host, which calls `appendAudio`; reply audio crosses back. The web host's bridge frame limit (`MAX_BRIDGE_FRAME_BYTES`) bounds a chunk. No audio is written to disk, a log, the bridge's replay or a crash report. Captured audio goes nowhere but the gateway, and only while a session the gateway accepted is open.
- **One call per host**, across windows and tabs. A second call's create is refused by the host before it reaches the gateway; the second session of a language change belongs to the same call.
- **On a dropped connection**, the host releases the microphone at once and sends no close (the gateway has closed the session). If the connection is back within 30 seconds and the person has not hung up, it creates the call's new session (section 8); otherwise the call has failed. It never starts a call the person did not start.
- **The voice preference.** `clawtrate.voice` is read at every connect and on `users.prefs.changed`, and changed with a compare-and-set, as `clawtrate.sidebar` is.

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
