# Settings

Settings as a whole: the sections it has and their order, several gateways (adding, switching, removing), Appearance, spelling, hardware acceleration, Updates and "Update required", and two tools for a task: Compact, and a report of free disk on the machine a bot works on. This is the sixth part of the design, after `visual-language.md`, `conversation.md`, `bots.md`, `work-pane.md`, `setup.md` and `controls.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-010, F-158, F-159, F-228 to F-231, F-279, F-388 to F-391, F-393 to F-395 and F-458. What the gateway, Electron and the app's own code do is in `docs/research/settings.md`; every state below names the fact it rests on, and section 16 lists them. Section 18 is for builders.

One rule sits above the rest: **a row says what was read back, and nothing else.** A save, a switch and a removal each say what is true afterwards, step by step, including after a failure in the middle. Where nothing can establish a behaviour, the screen says less: no update source means no "Check for Updates"; no translation means no Language setting; no way to see a screen saver means the rule for installing an update does not mention one.

Five facts from the research shape the design:

- **One gateway is connected at a time**, each with its own device tokens, and a gateway is told apart by `gateway.identity.get` (research §1). Switching closes one connection and opens another.
- **This device's record on a gateway can be removed by this client only with admin access**: `device.pair.remove` needs `operator.pairing`, which the client never asks for, and admin includes it. Below admin the record stays, and its owner removes it on the gateway's computer (research §3).
- **There is no update source.** Packaging writes no feed, no updater is in the app, and Windows' installer is not one Electron's own updater can update (research §4). Everything about checking and installing is drawn for when the owner publishes one, and labelled so.
- **Electron sees a locked screen and idle time on macOS and Windows, and nothing reports a screen saver** (research §5).
- **`/compact` during a run waits up to a minute and then ends the run** (research §8, live), so Compact is offered only when no run is active.

The prototype walks every path to its outcome: `prototype/settings.html`, with the state in the address (`prototype/README.md`). The styles are in `prototype/css/settings.css`, the behaviour in `prototype/js/settings.js`, and `prototype/tools/checks/settings.mjs` clicks through every walk and asserts each state's words and structure.

## Contents

1. How the pieces fit
2. Shared rules: components, access, saving, input, announcements
3. Settings as a whole
4. Your gateways
5. Adding a gateway
6. Switching gateways
7. Removing a gateway
8. Appearance
9. System: spelling and hardware acceleration
10. Updates
11. Update required, and a gateway that needs updating
12. Not offered: Language, security keys, routing traffic
13. Compact
14. Free disk on the bot's machine
15. Widths, themes, keyboard, screen readers, motion
16. What each fact drives
17. Parity rows
18. For builders
19. Not covered here

## 1. How the pieces fit

```
gateway menu (rail footer)        the gateway in use; Gateways: one radio item each, Add gateway…; Settings
Settings (⌘,)                     two panes: the list of sections, the section
  Gateway                           as built, for the gateway in use; "Your gateways" replaces "Use another gateway"
  Your gateways                     every saved gateway: In use, or Switch; Add gateway…; a gateway's page with Remove…
  Accounts, Integrations            bots.md §7, §15-18
  Permissions, Memory, Usage, Machines   controls.md §7, §13, §16, §15
  Appearance                        Theme; Your messages
  (Notifications)                   a place kept for issues #76 and #77; nothing drawn
  System (desktop)                  Check spelling while typing; Use hardware acceleration
  Updates (desktop)                 the version; with no update source, that and nothing else
full window                       Update required: this Clawtrate is older than the gateway's protocol
Work pane, Details tab            Context: Compact
transcript                        a compacted line that folds the turns before it
above the composer                low disk on the machine the bot is set to work on
```

**Where Settings sits beside the pages others are building.** Settings is about this device and about the gateway as a whole. A bot's own pages stay in the Work pane's Settings tab: its model and effort (`bots.md` §9), what it may do and where it runs (`controls.md` §4 and §14), and its usage and budget (`controls.md` §16 and §17). Settings links to them and does not repeat them; Usage and Machines in Settings are `controls.md`'s, for every bot and every machine.

## 2. Shared rules

### Components used

| Component                                                                                | From                                            | Used for                                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Settings frame, section list, section head and Back                                      | `bots.md` §2, §7                                | Every section                                         |
| Choice list (`.b-choices`), switch (`.b-switch`), note (`.b-note`), result (`.b-result`) | `bots.md` §2                                    | Gateways, the switches, notes, how a removal ended    |
| Fact block (`.facts`), group word                                                        | `visual-language.md` §9                         | A gateway's page, Updates                             |
| Confirmation (`.b-confirm`, role `alertdialog`)                                          | `bots.md` §7                                    | Switching with unsent messages, removing, restarting  |
| The access bar and its request                                                           | `conversation.md` §3, `bots.md` §2              | Compact on a read-only connection                     |
| The status strip                                                                         | `visual-language.md` §11                        | Connecting to the gateway switched to, and failing to |
| Command block and copy button                                                            | `visual-language.md` §10                        | The command that removes this device's record         |
| Event line, steps fold                                                                   | `visual-language.md` §8, `conversation.md` §7.4 | The compacted line and what it folds                  |
| The note above the composer                                                              | `controls.md` §16 ("Near a provider's limit")   | Low disk                                              |
| The connection column                                                                    | `visual-language.md` §10                        | Update required                                       |
| The two-way switch (`.seg`)                                                              | `conversation.md` §8                            | Theme, Your messages                                  |

### New components

One, defined in `prototype/css/settings.css` from existing tokens:

| Component                | What it is                                                                                                                                                                                                                                                                                                 | Tokens                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Removal list (`.s-goes`) | Two short lists under a confirmation's sentence, "Removed from this device" and "Stays", each item a line of 14 with a 16 px mark (a cross in `--text-muted`, a check in `--text-faint`). After the removal the same list is the result, each item marked by what was read back: done, left, or not tried. | `--text-muted`, `--text-faint`, `--danger` |

No new tokens.

### Access

- Everything in Appearance, System and Updates is this device's own and needs nothing from the gateway: a read-only connection changes them like any other.
- Switching and adding gateways change only this device. Adding pairs read-only, as setup does (`setup.md` §2, rule 5).
- Removing a gateway removes this device's records at any access. Removing this device's record on the gateway is offered only while the connection to that gateway holds `operator.admin` (research §3). Admin is never asked for to make it possible: below admin the confirmation names the record and the command its owner runs.
- Compact sends a message, so it needs the interactive tier (`operator.write`, research §8). On a read-only connection Compact is absent and the access bar asks for the interactive tier, the same request as `conversation.md` §3.

### Saving and reading back

Every preference here is written, then read back, and only what was read back is shown:

- **The interface's preferences** (Theme, Your messages) are written to the interface's storage and read again at once. When the read does not return what was written, the choice applies to this window until Clawtrate closes, and the section says so: "Clawtrate couldn't save this. It applies until you close Clawtrate."
- **The app's preferences** (spelling, hardware acceleration, automatic updates) are written by the host to its own settings file, and the host answers with what the file holds after the write and, where Electron has a reading, what Electron reports (`session.isSpellCheckerEnabled()`, `app.isHardwareAccelerationEnabled()`). A switch moves only when that answer comes. A failed write leaves the switch as it was, with "Couldn't save. Try again."

### Input

- Settings is the modal dialog of `bots.md` §7: focus stays inside, Escape closes it (an open confirmation first), focus returns to the control that opened it.
- A switch is a `button` with role `switch` and `aria-checked`; Space and Enter flip it.
- A choice in a `.seg` is a radio group with one tab stop; arrows move and choose.
- In the gateway menu the gateways are `menuitemradio`; Up and Down move, Enter chooses.
- A confirmation puts focus on Cancel. A checkbox in it is a real checkbox with its label.

### Announcements

The Settings dialog's polite live region (`bots.md` §2) announces, only once each is read back: "Switched to Studio gateway", "Couldn't reach Studio gateway", "Added Lab gateway", "Studio gateway is removed from this device", "Theme: Dark", "Your messages: Neutral", "Spelling is checked", "Spelling isn't checked", "Hardware acceleration turns off when Clawtrate restarts", "Compacted", "Nothing to compact yet", "Couldn't compact", and the copy results. Nothing is announced on a click alone.

## 3. Settings as a whole

**The sections, in order.** The list is the `nav` of `bots.md` §7; a section that is not built yet is still listed where it will go, so the order does not move later.

| Section                              | What it holds                                     | Specified in                                            | Desktop | iPhone |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------- | ------- | ------ |
| Gateway                              | The gateway in use, as built                      | `packages/ui/src/Settings.tsx`, `setup.md` §8, §14, §15 | Yes     | Yes    |
| Your gateways                        | Every saved gateway                               | Section 4                                               | Yes     | Yes    |
| Accounts                             | The gateway's accounts                            | `bots.md` §7                                            | Yes     | Yes    |
| Integrations                         | T3 Code                                           | `bots.md` §15-18                                        | Yes     | Yes    |
| Permissions, Memory, Usage, Machines | Rules, shared memory, usage, machines and devices | `controls.md` §7, §13, §16, §15                         | Yes     | Yes    |
| Appearance                           | Theme, Your messages                              | Section 8                                               | Yes     | Yes    |
| Notifications                        | Kept for issues #76 and #77                       | Not here                                                | —       | —      |
| System                               | Spelling, hardware acceleration                   | Section 9                                               | Yes     | No     |
| Updates                              | The version, and updates when there is a source   | Section 10                                              | Yes     | No     |

The web preview host has no System and no Updates: a browser does its own spelling and acceleration, and the preview updates when its host does.

**The Gateway pane** stays as built, with one change: "Use another gateway" (today the `disconnect` command, which forgets the gateway) becomes "Other gateways", which opens Your gateways. Forgetting a gateway is Remove (section 7), which says what it removes. setup.md's "Remove this gateway…" in this pane opens the same confirmation.

## 4. Your gateways

A sentence: "Clawtrate uses one gateway at a time. Each keeps its own pairing on this device, and nothing from one is sent to another." "Add gateway…" (default) at its right. Then one choice list:

| Row                | Title            | Line under it                         | End                                         |
| ------------------ | ---------------- | ------------------------------------- | ------------------------------------------- |
| The gateway in use | "Home gateway"   | "gateway.local · In use"              | chevron: opens the Gateway pane             |
| Another gateway    | "Studio gateway" | "devbox, over SSH · Last used Nov 18" | "Switch" (default, small), then the chevron |

- A gateway's name is the rail's (`gatewayLabel`, or the route's name from `setup.md`); its line is its route as setup names it, and "In use" or when this device last connected to it.
- "Last used" is this device's record of its last hello there. Nothing is read from a gateway that is not connected: no state, no bots, no version.
- With no other gateway, the list has one row and the sentence under it reads "Add another gateway to switch between them here or from the gateway menu."

**A gateway's page** (not the one in use). Title: its name, with Back to Your gateways. A fact block:

| Row               | Value                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Route             | "devbox, over SSH" or the address                                                                                    |
| Last used         | "Nov 18, 4:02 PM"                                                                                                    |
| This device there | "Paired, device 9c2e41"; the access it held at its last hello, "Read-only" or "Can send, stop and answer" or "Admin" |
| Identity          | The first 12 characters of the gateway's id, in mono, or "Not read"                                                  |

"Switch to Studio gateway" (primary), and "Remove…" (quiet, `--danger`) at the far right. For the gateway in use the page is the Gateway pane.

## 5. Adding a gateway

"Add gateway…", in Your gateways or the gateway menu, opens the setup flow's first screen, "Where does OpenClaw run?" (`setup.md` §3), with Cancel in its top left, in place of the app. Above its question one line: "Adding a gateway. Home gateway stays saved; Cancel goes back to it." What follows is setup's, unchanged: the look, the host's confirmations, pairing read-only.

While setup connects to the new gateway, the gateway in use is disconnected (one connection at a time, research §1). If anything waits to be sent to it, "Add gateway…" first asks, as switching does (section 6).

**How it ends.** After the new gateway's first hello, Clawtrate reads `gateway.identity.get` and compares it with every saved gateway's:

| What was read                   | Result screen                                                                                                                                                                                               | Afterwards                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A new identity                  | "Added Lab gateway" · "Clawtrate is connected to it, read-only. Home gateway stays saved: switch back from the gateway menu."                                                                               | The new gateway is in use and listed; the rail shows its bots                                                           |
| The identity of a saved gateway | "Home gateway is already here" · "This address leads to Home gateway. Clawtrate keeps its saved pairing and didn't add a second entry. A second way to reach one gateway is a route, in Settings, Gateway." | The token just issued for the new address is dropped; Clawtrate reconnects to Home gateway with its own token           |
| No identity (the call failed)   | "Added 198.51.100.7" · "Lab gateway didn't say who it is, so Clawtrate keeps it under its address."                                                                                                         | Listed under its address, as the rail's arrangement is (`docs/decisions.md`, "The rail's arrangement is this device's") |
| Setup cancelled, or it failed   | "Nothing was added" · "Clawtrate is connected to Home gateway again."                                                                                                                                       | Home gateway in use                                                                                                     |

Each line about the gateway in use is written only after its hello: if Home gateway can't be reached on the way back, the screen says "Clawtrate couldn't reach Home gateway" with "Try again", and the strip says the same.

## 6. Switching gateways

**From the gateway menu.** The menu (`visual-language.md` §7) gains a group under its head: the label "Gateways", one `menuitemradio` for each saved gateway, the one in use checked, and "Add gateway…". Choosing another gateway switches to it. Settings, Your gateways, "Switch" does the same.

**When something would be lost.** Messages accepted by the composer and not yet sent, or sent and not yet confirmed, live in memory and are never sent to another gateway (`docs/decisions.md`, "Closing a task keeps the user's words"). When there are any, a confirmation names them, counted at that moment:

> **Switch to Studio gateway?**
> 1 message to Otto hasn't been sent to Home gateway yet. Switching discards it: it isn't kept as a draft. Runs on Home gateway keep going.
> [Cancel] [Switch]

- **Discarded, exactly.** Today such a message lives only in the core's memory; opening another gateway's address resets that state (`packages/core/src/client.ts`, the connection's `initialState` when the address differs), and nothing puts the text back in the composer. So the sentence says it is discarded, and the design adds no machinery to keep it.
- A message that was sent and not yet confirmed is counted apart, because the gateway may already have it: "1 message to Otto was sent to Home gateway and isn't confirmed yet. Switching stops following it; Home gateway may still have it."
- With nothing waiting there is no confirmation. Drafts, the text still in a composer, are kept on this device for each gateway's address (`packages/ui/src/Composer.tsx`) and come back on return.
- Adding a gateway and restarting Clawtrate ask the same way, with the same words for what happens to the message.

**Each step, as it is.**

| Step                                                | The rail                                                                                    | The status strip                                                                   | Settings, Your gateways               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| Closing Home gateway                                | Home's bots leave at once: no bot, task or permission of one gateway is shown under another | —                                                                                  | "Switching" on Studio's row           |
| Connecting to Studio gateway                        | "Loading this gateway's bots."                                                              | "Connecting to Studio gateway"                                                     | as above                              |
| Hello, then identity                                | Studio's bots, its tasks, its permissions                                                   | —                                                                                  | Studio "In use"                       |
| Studio can't be reached                             | Empty, "Can't reach Studio gateway"                                                         | "Can't reach Studio gateway" · its reason, with "Retry" and "Back to Home gateway" | Studio "Can't reach it"               |
| Studio's identity differs from the one saved for it | Empty                                                                                       | "This address now leads to a different gateway" (`setup.md` §15)                   | Studio "A different gateway answered" |

"Switched to Studio gateway" is announced after the hello and the identity check. Bots, tasks and transcripts of a gateway are in memory only, so returning loads them again; the rail's arrangement, the open bot and task, and the drafts come back from this device's storage for that gateway (section 18).

## 7. Removing a gateway

"Remove…" on a gateway's page, or the Gateway pane's "Remove this gateway…" for the one in use, opens a confirmation built from what is on this device and what the connection holds at that moment. Every item is a fact; none is a guess.

> **Remove Studio gateway from this device?**
>
> Removed from this device
>
> - Its pairing: the device token Clawtrate keeps for its route
> - Its route: devbox, over SSH, with the key Clawtrate pinned for it (`setup.md` §8)
> - Drafts in 2 tasks
> - How you arranged its bots in the rail, and the task last open
>
> Stays
>
> - On Studio gateway: its bots, tasks, accounts and settings. Nothing there changes.
> - On Studio gateway: this device's record, device 9c2e41. To remove it, run this on the gateway's computer:
>   `openclaw devices remove 9c2e41…` [copy]
> - This device's key. Home gateway knows this device by it too.
>
> [Cancel] [Remove] (`--danger-soft`)

- **The command** is the host's, for that gateway's profile, as the approve command is (`docs/decisions.md`, "Pairing"; `setup.md` §2, rule 11). The design never writes it.
- **With admin on the gateway in use**, the "Stays" item about the record is replaced by a checkbox, unticked: "Also remove this device's record from Home gateway". It is offered only while the connection holds `operator.admin`; for a gateway that is not connected it is never offered.
- **On an SSH route Clawtrate started OpenClaw on**, setup's own checkbox, "Also stop OpenClaw on devbox (Clawtrate started it)", is added, with setup's rules (`setup.md` §8). On the desktop the host's native dialog repeats both lists.
- Items with nothing in them are left out ("Drafts in 2 tasks" only when there are drafts).

**The steps, in order, each read back.**

1. When the record box is ticked: `device.pair.remove` with this device's own id. The gateway ends the connection after it answers (research §3, live), so nothing can be read over it afterwards: the read-back is the gateway's own result, and only a result that names this device's id counts as removed. A refusal, an error, a result naming another id, or no answer before the connection closes all count as not removed, and nothing else is done (below).
2. Disconnect, when it is the gateway in use; stop the route's forward by its PID (`setup.md` §8).
3. Delete the route's device tokens, then read the store: no token record for that route is left.
4. Delete the saved route and its pinned key, then read them.
5. Delete this device's drafts, rail arrangement and open task for that gateway, then read them.

**How it ended.** The same two lists, each item marked by what was read back:

| Outcome                                            | Title                                                                    | Then                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every step done                                    | "Studio gateway is removed from this device"                             | The lists, every "Removed" item done; this device's record is listed as removed only when the gateway's result named it, and otherwise stays under "Stays" with its command. When it was the gateway in use and others are saved: Your gateways, "Not connected. Choose a gateway to use." with Switch on each; when none is left, setup's first screen |
| The gateway refused or failed to remove the record | "Home gateway didn't remove this device's record"                        | "Nothing was removed. Home gateway said: <the error category>." with "Remove from this device only" and "Cancel"                                                                                                                                                                                                                                        |
| No answer before the connection closed             | "Clawtrate can't tell whether Home gateway removed this device's record" | "Nothing else was removed. Look for this device in Home gateway's device list on the gateway's computer." with "Remove from this device only" and "Cancel"                                                                                                                                                                                              |
| A local step failed                                | "Couldn't remove everything"                                             | Each item marked done, left or not tried; "Try again" repeats only what is left                                                                                                                                                                                                                                                                         |

## 8. Appearance

Two groups, each a `.seg`:

- **Theme**: "Follow system", "Light", "Dark". The same preference the gateway menu sets (`packages/ui/src/preferences.ts`, `useTheme`); choosing it here or there changes both. The gateway menu's item, "Match the system" as built, takes the same words, so one preference has one name.
- **Your messages**: "Accent", "Neutral", with a small sample bubble of each beside the choice. The same preference as the gateway menu's "Your messages" (`useBubbles`).

Both apply at once and are read back (section 2). They are this device's, per viewer: a phone and a desktop choose for themselves.

## 9. System: spelling and hardware acceleration

Desktop only. Two rows, each a title (15/500), a line under it, and a switch at the end.

**Check spelling while typing**, on by default (Electron's spellchecker is on by default, research §10).

| System  | Line under it                                                                                                                                                                                                                                                              | Facts                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| macOS   | "Uses macOS's own spelling checker, in the languages macOS is set to."                                                                                                                                                                                                     | `session.setSpellCheckerEnabled`; the language list is macOS's, and Electron cannot set it            |
| Windows | Before the dictionary is ready: "Uses a dictionary for English (United States), which Clawtrate downloads once." Ready: "Checks English (United States)." Failed: "Couldn't download the dictionary for English (United States). Spelling isn't checked." with "Try again" | The language matches the system's locale; `spellcheck-dictionary-initialized` and `-download-failure` |

- On, a misspelled word in the composer is underlined; right-click gives the suggestions and "Add to dictionary" (`context-menu`'s `dictionarySuggestions` and `misspelledWord`). Fields where spelling means nothing (addresses, names, search) keep `spellcheck="false"`, as today.
- On Windows the app's request filter cancels every request outside its own files (research §10), and the dictionary comes from a CDN. Until a builder has shown the dictionary arrives, the Windows row is `todo` (section 17).

**Use hardware acceleration**, on by default. "Turn off if Clawtrate draws badly or flickers on this computer." Off is a choice for the next start, because Electron can turn it off only before the app is ready (research §10):

| State                             | Line under it                                         | Action        |
| --------------------------------- | ----------------------------------------------------- | ------------- |
| On                                | the sentence above                                    | —             |
| Turned off, not restarted         | "Turns off when Clawtrate restarts."                  | "Restart now" |
| Off (read back after the restart) | "Off. Clawtrate draws without the graphics hardware." | —             |
| Turned on again, not restarted    | "Turns on when Clawtrate restarts."                   | "Restart now" |

"Restart now", when nothing waits to be sent, restarts at once (`app.relaunch()`, then quit). When something waits, a confirmation: "Restart Clawtrate?" "1 message to Otto hasn't been sent yet. Restarting discards it: it isn't kept as a draft. Runs on Home gateway keep going." with "Cancel" and "Restart".

## 10. Updates

Desktop only. A fact block, then what the source allows.

| Row     | Value                  |
| ------- | ---------------------- |
| Version | "Clawtrate 0.1.0"      |
| Updates | One of the lines below |

**Today: no update source.** Packaging publishes nothing and the app has no updater (research §4). The row says "This copy can't check for updates: no update source is set up for it." There is no "Check for Updates", no "Automatic Updates" switch and no update track. A copy run from source says instead "A development build. It doesn't update itself." This is what every copy shows until the owner publishes releases.

**With an update source** (drawn as a future example in the prototype, labelled "When releases are published"). On macOS and Windows:

| State          | Updates row                                                                                                              | Actions                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Not checked    | "Checked at 9:05 AM" or nothing                                                                                          | "Check for Updates"           |
| Checking       | "Checking for updates…"                                                                                                  | none                          |
| Up to date     | "You're up to date. Checked at 5:41 PM." (`update-not-available`)                                                        | "Check for Updates"           |
| Downloading    | "Downloading Clawtrate 0.2.0…" (`update-available`; no percentage, since Electron's `autoUpdater` has no progress event) | none                          |
| Ready          | "Clawtrate 0.2.0 is ready. It installs when Clawtrate restarts." (`update-downloaded`)                                   | "Restart to Update" (primary) |
| Couldn't check | "Couldn't check for updates."                                                                                            | "Try again"                   |

- "It installs when Clawtrate restarts" is exact: a downloaded update installs at the next start, whether Clawtrate restarts itself or the person quits and reopens it (research §4).
- "Restart to Update" asks first when something waits to be sent, with section 9's confirmation and the title "Restart to update?".

**Automatic Updates** (a switch under the row, on macOS and Windows, off by default until the owner chooses otherwise): "Install a downloaded update by itself while you're away: when the screen is locked, the computer has been idle for 10 minutes, and no run is active on the gateway Clawtrate is using." And under it, in faint: "Clawtrate can't tell when a screen saver is on, so only a locked screen counts."

- **The rule**, all three at once: the screen is locked (`lock-screen` without a later `unlock-screen`, or `getSystemIdleState(600)` is `locked`); `getSystemIdleTime()` is at least 600; and no run is active, which means no task on the connected gateway has a run in progress and Clawtrate holds no message waiting to send or to be confirmed (research §5, §6). Runs on other gateways are not connected, cannot be seen, and are not stopped by a restart.
- The host checks the rule once a minute while an update is ready, and once more just before restarting.
- A screen saver is not in the rule: nothing in Electron reports one.

**Linux.** This repository builds no Linux package (research §4). A Linux package, when there is one, shows the version and "Updates are managed by your package manager.", with no switch and no button. A copy run from source shows the development build's line.

**iPhone.** No Updates section: the App Store or TestFlight updates the app.

## 11. Update required, and a gateway that needs updating

The connect handshake is the only thing that makes an update required: the gateway refuses a client whose protocol it does not speak with `PROTOCOL_MISMATCH` and the protocol it speaks, `expectedProtocol` (research §7, live). The client compares it with its own.

**This Clawtrate is too old** (`expectedProtocol` above the client's). The whole window shows the connection column (`visual-language.md` §10): the mark, then

- Title: "Update required"
- "Home gateway speaks protocol 5. This version of Clawtrate speaks protocol 4, so it can't use it."
- Desktop, no update source: "This copy can't update itself. Install a newer Clawtrate to use Home gateway."
- Desktop, with an update source: "Update" (primary), which checks, then downloads with section 10's states, then "Restart to Update".
- iPhone: "Update Clawtrate in the App Store, or in TestFlight if you test it there."
- "Switch gateway" (default) when another gateway is saved, opening the gateway list in the window; "Try again" (quiet), which runs the handshake again.

Nothing else is asked of that gateway while the window shows (the core already sends no request after a mismatch, `packages/core/src/client.ts`). Other gateways are not affected.

**The gateway is too old** (`expectedProtocol` below the client's). This is not "Update required" for the person's Clawtrate. The Gateway pane's problem line, as built, says "This gateway speaks another protocol" with both versions, and one sentence more: "Update OpenClaw on the gateway's computer to use it with this version." The rail and the strip show "Can't use Home gateway" with "Switch gateway" when another is saved.

**F-010's rule**, "more than 14 days old and a newer version exists", needs the client's release date and an update feed. There is no feed, and publishing one is its own unit of work, so that rule shows nothing in this design. What this section designs is row F-518 (section 17).

## 12. Not offered: Language, security keys, routing traffic

- **Language** (F-229, F-388). The interface is English only: no translation, no catalogue, no locale handling (research §10). A Language setting would have nothing to choose, so Settings has none. When a second language ships, the setting is "Match the system" plus each shipped language, and "Match the system" falls back to English, as the rows say.
- **Security keys for a bot's browser** (F-395). A bot's browser runs on the gateway's machine or a node, and the gateway has no way to reach a key plugged into this computer (research §10). A switch would do nothing on any system, so Settings has none.
- **"Route traffic through this computer"** (F-158) is `not planned`: Clawtrate's bots already work on the person's own machines, and no routed-request count exists.

## 13. Compact

**Where.** The Work pane's Details tab, which is about the open task (`bots.md` §8), gains a group "Context" after the task's facts: one sentence and the button.

| State           | Sentence                                                                                                        | Button                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Available       | "Compact asks the gateway to replace older turns in Juniper's context with a summary. Every turn stays here."   | "Compact" (default, small)                   |
| A run is active | "Compact is available when this run ends. The gateway would stop a run still going a minute after you compact." | "Compact", disabled                          |
| Compacting      | "Compacting…" with the working mark                                                                             | none                                         |
| Read-only       | "Compacting sends a message, which needs this device to be able to send."                                       | none; the access bar below, "Request access" |

Typing `/compact` in the composer is the same thing and is drawn the same way.

**What Compact does.** It sends `/compact` with `chat.send` and an idempotency key of its own, then waits for the gateway's reply in that task's history: a row from `model: "gateway-injected"` with the same key (research §8). It decides nothing from the button press.

**In the transcript.** The `/compact` message and the gateway's reply are not drawn as bubbles. One event line takes their place, at the reply's position:

| What history shows                                       | The line                                                                                                                       | Announced                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Waiting for the reply                                    | "Compacting Juniper's context…" with the working mark                                                                          | —                        |
| A `compaction` row with `tokensBefore` and `tokensAfter` | "Context compacted · 9.7k → 2.1k tokens", and the turns before it folded under it (below)                                      | "Compacted"              |
| A reply that says it skipped                             | "Nothing to compact yet."                                                                                                      | "Nothing to compact yet" |
| A reply that says it failed, and no `compaction` row     | "Couldn't compact. Juniper's context is as it was." with "Show the gateway's reply", which opens the reply's text as text      | "Couldn't compact"       |
| A reply that says a run was stopped                      | The failure or success line, and under it, in `--warn`: "The gateway stopped the run that was going. Send that message again." | as above                 |

**The fold.** Only a `compaction` row makes a fold. The turns between the previous compaction row (or the start) and this one are folded under the line, with a disclosure "3 earlier turns" (the client's count of the person's turns there). Opened, they read as they did, with one line at their foot: "Juniper's context now holds a summary of these and its most recent messages." The gateway says the transcript keeps every message and that recent messages stay intact, so the line never says these turns are gone, and never says which of them the bot still sees word for word (research §8). The fold is closed when the task opens; it remembers being opened while the task stays open.

## 14. Free disk on the bot's machine

A report, never a clean-up: the gateway offers a client no clean-up of a machine's files (research §9), so nothing here deletes anything.

**Where the figures come from.** Only from a machine the gateway names for this bot, as `work-pane.md` §16 establishes it:

| The bot is set to work on | Figures                                                                       | Volume                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A node                    | The node's `node.hostStats`, or the copy on its `node.list` record            | The node's home volume                                                                                                                |
| The gateway's machine     | `system.info`, read when the task opens and every 10 minutes while it is open | The entry of `disks` whose path is the longest that contains the bot's `workspace` (`agents.list`), else the gateway's state folder's |

Both are `operator.read`, so a read-only connection sees the report.

**When.** Below 5 GB free, or below 5 percent of the volume (Clawtrate's choice), a note above the composer of each of that bot's tasks:

> Otto is set to run commands on media-box, which has 2.1 GB free of 512 GB, as of 5:40 PM.
> Clawtrate deletes nothing. Whether Otto asks before it deletes a file depends on its command rules.
> [Show the computer] [Otto's rules] [×]

For the gateway's own machine: "Otto is set to run commands on the gateway's machine. The volume with its workspace has 4.2 GB free of 994 GB, as of 5:40 PM."

- "Is set to" because it is a setting, not proof of where a command ran (`work-pane.md` §16).
- "Show the computer" opens the Work pane's Computer tab, where the machine block has the same figures. "Otto's rules" opens Otto's Settings tab at what it may do (`controls.md` §4).
- Closed with ×, it stays closed until the free space changes by a gigabyte or more.
- Figures older than three minutes say so, as `work-pane.md` §16 does; a machine that reports no disk gets no note.
- Naming the largest items, and asking before deleting, is the bot's own work in its turn (F-159); the note does not claim the bot will ask.

## 15. Widths, themes, keyboard, screen readers, motion

| Concern        | Rule                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1440, 1100     | The Settings dialog is 800 × 640 (`bots.md` §2); every section scrolls inside it                                                                                                                                                                                               |
| 800            | The dialog takes the window's width less 48 px; the section list stays at 208 px                                                                                                                                                                                               |
| 390 (iPhone)   | The list first, full width; a section replaces it with Back (`bots.md` §7). No System, no Updates. "Update required" is the iPhone's words. The gateway menu opens downward from the round button at the top left (`visual-language.md` §7)                                    |
| Themes         | Every state in light and dark, from the tokens only                                                                                                                                                                                                                            |
| Keyboard       | Section 2, Input. Every action in every walk can be done without a pointer                                                                                                                                                                                                     |
| Screen readers | Each section's title is its `h3`; switches have their row's title as their name and its line as their description; the removal lists are lists; the compacted line is a `button` with `aria-expanded` that names the count; the low-disk note is a `region` named "Disk space" |
| Motion         | The working mark is a still ring when motion is reduced                                                                                                                                                                                                                        |

## 16. What each fact drives

| Shown or done                                                         | Rests on                                                                                                                             | Research |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| One gateway in use; switching closes one connection and opens another | The core holds one connection; a message is never sent to another gateway                                                            | §1, §6   |
| A second gateway apart from a second route                            | `gateway.identity.get` (`operator.read`) after hello                                                                                 | §1       |
| Each gateway's own pairing                                            | Device tokens keyed by route                                                                                                         | §1, §2   |
| The removal's "Removed" list                                          | The host's and the interface's storage, item by item                                                                                 | §2       |
| "This device's record" stays, with the command                        | `device.pair.remove` needs `operator.pairing`; refused at read and interactive (live)                                                | §3       |
| "Also remove this device's record" with admin                         | Admin removed its own record; the result names the id and the connection ends (live)                                                 | §3       |
| No "Check for Updates" today                                          | `publish: null`; no updater in the app                                                                                               | §4       |
| What an update would need                                             | Squirrel.Mac needs a signed app; Electron cannot update NSIS; electron-builder's updater with a publish provider                     | §4       |
| "It installs when Clawtrate restarts"                                 | A downloaded update is applied at the next start                                                                                     | §4       |
| The automatic update rule, without a screen saver                     | `lock-screen`, `unlock-screen`, `getSystemIdleState`, `getSystemIdleTime`; nothing reports a screen saver                            | §5       |
| "No run is active"                                                    | The connected gateway's run state and this client's unsent messages                                                                  | §6       |
| Update required, and a gateway too old                                | `PROTOCOL_MISMATCH` with `expectedProtocol` (live)                                                                                   | §7       |
| Compact: the button, the wait, the lines                              | `/compact` through `chat.send` (`operator.write`); the gateway-injected reply with the send's key; skipped and failed replies (live) | §8       |
| Compact unavailable during a run                                      | `/compact` waits up to 60 s, then stops the run (live)                                                                               | §8       |
| The fold and its line                                                 | The `compaction` row; the transcript keeps every message; recent messages kept intact                                                | §8       |
| Free disk, and deleting nothing                                       | `node.hostStats`, `system.info`, `agents.list` workspace (all `operator.read`, live for the last two); no client clean-up of files   | §9       |
| No Language setting                                                   | No translation in the interface                                                                                                      | §10      |
| Spelling on each system                                               | Electron's spellchecker; macOS's checker; Hunspell on Windows                                                                        | §10      |
| Hardware acceleration needs a restart                                 | `app.disableHardwareAcceleration()` before ready                                                                                     | §10      |
| No security key setting                                               | No gateway support                                                                                                                   | §10      |

## 17. Parity rows

**Reworded** in `docs/parity.md`, statuses unchanged unless named. The dependency cells, to the evidence:

| Row          | The dependency cell                                                                                                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-010        | No update feed today, and publishing one is its own unit of work; the protocol refusal is row F-518                                                                                                                                                         |
| F-159        | Adds `system.info` for the gateway's own machine, the volumes, and that no clean-up a client can ask for frees a machine's files                                                                                                                            |
| F-229, F-388 | No translation catalogue exists today: English only, no translation files or locale handling                                                                                                                                                                |
| F-230        | One connection at a time through the setup flow's pairing; `gateway.identity.get` tells a second gateway from a second route                                                                                                                                |
| F-231        | Needs an update source: none is published; a signed macOS build; electron-builder's updater on Windows                                                                                                                                                      |
| F-279        | The live replies (skipped, failed with history unchanged, a run ended after about a minute), the reply's `gateway-injected` row and key; the gateway does not say which turns were summarized; a success needs a scripted model that writes a summary first |
| F-389        | One connection at a time; messages waiting to send are dropped after a confirmation that names them                                                                                                                                                         |
| F-390        | The device record stays below admin, with the live refusals; admin removes it with `device.pair.remove`                                                                                                                                                     |
| F-391        | What Electron reports on macOS and Windows, and that nothing reports a screen saver                                                                                                                                                                         |
| F-393        | Electron's spellchecker per system, and the Windows dictionary download against the app's request filter                                                                                                                                                    |
| F-394        | `app.disableHardwareAcceleration()` only before ready, so a restart                                                                                                                                                                                         |
| F-395        | What was looked for and not found: no method names a security key, WebAuthn, FIDO or a passkey. Status `gap`                                                                                                                                                |
| F-458        | No Linux package is built today                                                                                                                                                                                                                             |

**Targets decided** (round 1): F-228 is "same in kind": Theme (Follow system, Light, Dark) and the fill of your own messages (Accent, Neutral), each saved and read back (section 8). F-279: Compact asks the gateway, and the fold's line gives the sizes before and after that the gateway reported (section 13). F-391: without the screen saver, which nothing reports, on macOS and Windows (section 10). F-010 stays as it is, `todo`, waiting on an update source. F-229 and F-388 stay `todo`: no Language setting until a second language ships (section 12). F-395 is `gap`: the design draws no switch.

**Added**: F-518, "Update required" from the gateway refusing this client's protocol as too old, and the strip when the gateway is the one too old (section 11). `todo`.

## 18. For builders

### What each part uses

| Part                            | Existing                                        | New          |
| ------------------------------- | ----------------------------------------------- | ------------ |
| Your gateways, a gateway's page | Settings frame, choice list, fact block         | none         |
| Gateway menu group              | `.menu`, `menuitemradio`                        | none         |
| Removing                        | Confirmation, command block                     | Removal list |
| Appearance                      | `.seg`                                          | none         |
| System, Updates                 | Switch, fact block, confirmation                | none         |
| Update required                 | The connection column                           | none         |
| Compact                         | Details tab, event line, steps fold, access bar | none         |
| Low disk                        | The note above the composer                     | none         |

### What the host does

| Need                                       | How                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved gateways                             | A list in host storage, one entry per gateway: its name, routes (`setup.md` §2), the identity read for each route, the last hello's time and access. The `connection` key becomes the entry in use. Token records stay keyed as they are                                                                                                             |
| Switching                                  | Close the connection, open the chosen gateway's route with its own token. The existing generation checks drop anything that finishes after the switch (`docs/decisions.md`)                                                                                                                                                                          |
| Removing                                   | The steps of section 7, each followed by a read of what it deleted; the answer to the interface is the list with each item's state                                                                                                                                                                                                                   |
| The command to remove this device's record | `openclaw [--profile <p>] devices remove <deviceId>`, chosen by the host as the approve command is                                                                                                                                                                                                                                                   |
| The app's own settings                     | A file in the app's data folder, read before `app.whenReady()`: `spellcheck`, `hardwareAcceleration`, `autoUpdate`. Writes answer with the file's contents and Electron's reading                                                                                                                                                                    |
| Spelling                                   | `session.defaultSession.setSpellCheckerEnabled`; a `context-menu` handler for suggestions; on Windows the dictionary events, and a decision on how the dictionary reaches the app past `lockDownSession`                                                                                                                                             |
| Hardware acceleration                      | `app.disableHardwareAcceleration()` before ready when the file says off; `app.isHardwareAccelerationEnabled()` in the answer; "Restart now" is `app.relaunch()` then `app.quit()`                                                                                                                                                                    |
| Updates                                    | Until the owner publishes: report "no source" and nothing else. Then: Electron's `autoUpdater` on macOS (signed build, the existing `.zip`), electron-builder's updater for the NSIS installer on Windows, a publish provider in `packaging/config.ts` so `app-update.yml` and `latest*.yml` are written; the rule of section 10 from `powerMonitor` |
| Unsent messages                            | A count per gateway and bot of messages waiting to send or to be confirmed, for the confirmations                                                                                                                                                                                                                                                    |

**The interface's storage, per gateway.** `clawtrate.bot`, `clawtrate.tasks`, `clawtrate.seen` and `clawtrate.unfolded` hold the gateway's ids without naming it (research §2). They are keyed by gateway, as the rail's arrangement is, before switching ships; otherwise one gateway's open task is looked for in another, and a removal cannot remove them.

### What the engine supplies

| Need                               | Supplied by                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The gateway's identity after hello | `gateway.identity.get`, already read (`ConnectionState.gatewayId`)                                                                                                                                         |
| Who is too old                     | `ConnectionState.error.protocol {gateway, client}`, already set on `PROTOCOL_MISMATCH`                                                                                                                     |
| Removing this device's record      | `device.pair.remove {deviceId}`, only with `canAdmin`                                                                                                                                                      |
| Compact                            | `chat.send` with the text `/compact` and its own key; the task's history rows with their `model` and `idempotencyKey`; the `compaction` row. The mapping of `conversation.md` §22 gains the compacted line |
| Disk                               | `node.list`, the `node.hostStats` event, `system.info`, `agents.list`'s `workspace`                                                                                                                        |
| Whether a run is active            | The run state the status line uses                                                                                                                                                                         |

### Order

1. **Per-gateway storage** in the interface (above), with its migration: today's un-scoped keys belong to the gateway in use at the first start after the change.
2. **Saved gateways, switching and the gateway menu** (F-230, F-389), with checks that one gateway's bots, tasks and permissions never show under another, and that a message waiting for one is never sent to another.
3. **Removing** (F-390), with a check for each step's failure.
4. **Appearance** (F-228's built part), **System** (F-393 on macOS, F-394).
5. **Compact and its line** (F-279), against the development gateway: skipped and failed replies are live; a success needs a scripted model that writes a summary.
6. **Low disk** (F-159's report).
7. **Updates** (F-231, F-391, F-458) only once the owner publishes releases; until then the "no source" line.

### The prototype's states and walks

`settings.html` takes every parameter `controls.html` takes, and these:

| Parameter                | Values                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `open=settings&section=` | `gateway`, `gateways`, `appearance`, `system`, `updates` (and every section of `bots.html` and `controls.html`)   |
| `gw`                     | `studio`: that gateway's page                                                                                     |
| `gateways`               | `one`: Home gateway alone                                                                                         |
| `waiting`                | `1`: a message to Otto waits to be sent                                                                           |
| `switchfail`             | `1`: Studio gateway can't be reached                                                                              |
| `remove`                 | `studio` or `home`: that removal's confirmation open; `rmfail=remote`, `unknown` or `local`                       |
| `os`                     | `mac`, `windows`, `linux`                                                                                         |
| `build`                  | `dev`: a copy run from source                                                                                     |
| `feed`                   | `1`: an update source exists (the future example); `upd=checking`, `current`, `downloading`, `ready`, `error`     |
| `spell`                  | `off`, `downloading`, `failed` (Windows)                                                                          |
| `hw`                     | `pending`, `off`                                                                                                  |
| `required`               | `client` or `gateway`                                                                                             |
| `compact`                | `running`, `compacting`, `done`, `skipped`, `failed`, `stopped` (open Juniper's task "Heat pump vs. gas furnace") |
| `disk`                   | `node`, `gateway`: the low-disk note in Otto's tasks                                                              |
| `add`                    | `1`: the setup flow's stand-in open                                                                               |

The check walks these by clicking, and asserts each destination's words:

| Walk                                  | From                             | Through                                              | To                                                                                             |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Switch, nothing waiting               | The gateway menu                 | Studio gateway                                       | Studio's bots only; "Switched to Studio gateway"                                               |
| Switch, a message waiting             | `waiting=1`, the gateway menu    | the confirmation, Switch                             | Studio in use; Cancel leaves Home in use                                                       |
| Switch fails                          | `switchfail=1`                   | Studio gateway, "Back to Home gateway"               | Home in use again                                                                              |
| Add a new gateway                     | Your gateways                    | Add gateway…, the stand-in's "Paired: a new gateway" | "Added Lab gateway", three gateways                                                            |
| Add the same gateway                  | Your gateways                    | Add gateway…, "Paired: the same gateway"             | "Home gateway is already here", two gateways                                                   |
| Add, cancelled                        | Your gateways                    | Add gateway…, Cancel                                 | "Nothing was added", Home in use                                                               |
| Remove another gateway                | Studio's page                    | Remove…, the lists, Remove                           | "Studio gateway is removed from this device"; one gateway                                      |
| Remove the gateway in use, with admin | Gateway pane                     | Remove this gateway…, the record checkbox, Remove    | Removed; "Not connected. Choose a gateway to use."                                             |
| Remove, the gateway refuses           | `remove=home&rmfail=remote`      | Remove                                               | "Home gateway didn't remove this device's record", nothing removed                             |
| Remove, no answer                     | `remove=home&rmfail=unknown`     | Remove                                               | "Clawtrate can't tell whether Home gateway removed this device's record", nothing else removed |
| Remove, a local step fails            | `remove=studio&rmfail=local`     | Remove, Try again                                    | Removed                                                                                        |
| Appearance                            | Appearance                       | Dark, Neutral                                        | the page dark; neutral bubbles                                                                 |
| Spelling                              | System                           | the switch                                           | "Spelling isn't checked"                                                                       |
| Hardware acceleration                 | System                           | the switch, Restart now                              | "Off. Clawtrate draws without the graphics hardware."                                          |
| Updates, no source                    | Updates                          | —                                                    | "no update source"; no button, no switch                                                       |
| Updates, with a source                | `feed=1`                         | Check for Updates                                    | "You're up to date"; then `upd=ready`, Restart to Update with `waiting=1`, the confirmation    |
| Update required                       | `required=client`                | —                                                    | "Update required" and Switch gateway; at phone width the App Store line                        |
| Compact                               | Juniper's task, Details          | Compact                                              | "Compacting…", then "Context compacted", the fold opening "3 earlier turns"                    |
| Compact while running, read-only      | `compact=running`; `access=read` | —                                                    | disabled with its sentence; the access bar                                                     |
| Low disk                              | `disk=node`                      | Show the computer                                    | the Computer tab                                                                               |

## 19. Not covered here

- Notifications (issues #76 and #77): the place in the section list is kept, and nothing of it is designed here.
- Search (issue #78), including searching Settings.
- Several routes to one gateway (issue #13, `setup.md` §15): Add route, ordering, failover.
- The setup flow itself (`setup.md`), the Accounts pane and Integrations (`bots.md` §7, §15-18), and the controls pages (`controls.md`), which this design only lists and points to.
- A bot's model and effort, usage, and where a bot runs, which are being built as their own pages.
- Routines and check-ins (`automation.md`) and links into the app (`links.md`).
- Connecting to two gateways at once, or seeing another gateway's runs while one is in use.
- A focus for Compact (`/compact <focus>`), and the automatic compaction's own events.
- An update track (Stable, Beta), release notes, and rolling back.
- The microphone (F-392), Language (section 12), security keys (section 12).
- Publishing releases and signing them, which are the owner's.
