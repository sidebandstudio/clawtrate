# Settings

Settings as a whole: the sections it has and their order, several gateways (adding, switching, removing), Appearance, spelling, hardware acceleration, Updates and "Update required", and two tools for a task: Compact, and a report of free disk on the machine a bot works on. This is the sixth part of the design, after `visual-language.md`, `conversation.md`, `bots.md`, `work-pane.md`, `setup.md` and `controls.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-010, F-158, F-159, F-228 to F-231, F-279, F-388 to F-391, F-393 to F-395 and F-458. What the gateway, Electron and the app's own code do is in `docs/research/settings.md`; every state below names the fact it rests on, and section 16 lists them. Section 18 is for builders.

One rule sits above the rest: **a row says what was read back, and nothing else.** A save, a switch and a removal each say what is true afterwards, step by step, including after a failure in the middle. Where nothing can establish a behaviour, the screen says less: no update source means no "Check for Updates"; no translation means no Language setting; no way to see a screen saver means the rule for installing an update does not mention one.

Five facts from the research shape the design:

- **One gateway is connected at a time.** Clawtrate saves a separate connection for each gateway, and a gateway is told apart by `gateway.identity.get`, which answers only after a connection has authenticated (research §1). Switching closes one connection and opens another.
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
11. A protocol refusal: Update required, and a gateway that needs updating
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
conversation, rail and strip      a protocol refusal: that connection's alone; gateways stay reachable
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
| The empty rail and the status strip                                                      | `visual-language.md` §7, §11                    | A protocol refusal                                    |
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

**The sections, in order.** The list is the `nav` of `bots.md` §7; a section that is not built yet is still listed where it will go, so the order does not move later. Gateway, Accounts, Usage and Machines are built (`packages/ui/src/Settings.tsx`); their names and pages stay as they are.

**Who owns each setting.** Each page carries one line saying where its settings live and who else sees them, and what read-only access can do there. For the pages this design draws, the line is the one below; the others keep their own designs' read and change rules, and the column only records them.

| Section             | What it holds                                   | Specified in                                            | Where it lives, who sees it, and read-only access                                                                                                                                                                                                                                                              | Desktop | iPhone |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| Gateway             | The gateway in use, as built                    | `packages/ui/src/Settings.tsx`, `setup.md` §8, §14, §15 | "Saved on this device. Read-only access lets you switch, add or remove saved connections here."                                                                                                                                                                                                                | Yes     | Yes    |
| Your gateways       | Every saved gateway                             | Section 4                                               | The same line                                                                                                                                                                                                                                                                                                  | Yes     | Yes    |
| Accounts            | The gateway's accounts                          | `bots.md` §7 (built)                                    | This gateway, shared with everyone who uses it; reads at read-only, changes need admin (`bots.md` §7)                                                                                                                                                                                                          | Yes     | Yes    |
| Integrations        | T3 Code                                         | `bots.md` §15-18                                        | The T3 Code switch: "Saved to your profile on this gateway", or "This gateway hasn't linked this connection to a profile" when `users.prefs` answers `no_durable_identity`; the switch needs the interactive tier. The server and each bot's T3 Code: this gateway, shared; changes need admin (`bots.md` §15) | Yes     | Yes    |
| Permissions, Memory | Rules, shared memory                            | `controls.md` §7, §13                                   | This gateway, shared; reads and changes as `controls.md` gives them, including its admin-only reads                                                                                                                                                                                                            | Yes     | Yes    |
| Usage               | Limits, usage, budgets                          | `controls.md` §16, §17 (built)                          | Figures: this gateway, shared. Budgets: your profile on this gateway (`users.prefs`, saved at the interactive tier); read-only shows values only (as built)                                                                                                                                                    | Yes     | Yes    |
| Machines            | Machines, their approvals, paired devices       | `controls.md` §15 (built)                               | This gateway, shared; a machine's approvals need admin to read and change, this device's own name needs device access, another's record needs admin (as built)                                                                                                                                                 | Yes     | Yes    |
| Appearance          | Theme, Your messages                            | Section 8                                               | "Applies on this device." (Kept for this viewer, in the interface's storage)                                                                                                                                                                                                                                   | Yes     | Yes    |
| Notifications       | Kept for issues #76 and #77                     | Not here                                                | Not here                                                                                                                                                                                                                                                                                                       | —       | —      |
| System              | Spelling, hardware acceleration                 | Section 9                                               | "Applies on this device." (Kept in the host app's settings file)                                                                                                                                                                                                                                               | Yes     | No     |
| Updates             | The version, and updates when there is a source | Section 10                                              | "Applies on this device." (Kept in the host app's settings file)                                                                                                                                                                                                                                               | Yes     | No     |

On the web preview the Gateway and Your gateways line says "Saved on this preview's host, shared by every browser that uses it. Read-only access lets you switch, add or remove saved connections here."

The web preview host has no System and no Updates: a browser does its own spelling and acceleration, and the preview updates when its host does.

**The Gateway pane** stays as built, with one change: "Use another gateway" (today the `disconnect` command, which forgets the gateway) becomes "Other gateways", which opens Your gateways. Forgetting a gateway is Remove (section 7), which says what it removes. setup.md's "Remove this gateway…" in this pane opens the same confirmation.

## 4. Your gateways

A sentence: "Clawtrate saves a separate connection for each gateway and uses one at a time." Then one choice list, and "Add gateway…" under it:

| Row                | Title            | Line under it                         | End                                         |
| ------------------ | ---------------- | ------------------------------------- | ------------------------------------------- |
| The gateway in use | "Home gateway"   | "gateway.local · In use"              | chevron: opens the Gateway pane             |
| Another gateway    | "Studio gateway" | "devbox, over SSH · Last used Nov 18" | "Switch" (default, small), then the chevron |

- A gateway's name is the rail's (`gatewayLabel`, or the route's name from `setup.md`); its line is its route as setup names it, and "In use" or when this device last connected to it.
- "Last used" is this device's record of its last hello there. Nothing is read from a gateway that is not connected: no state, no bots, no version.
- With no other gateway, the list has one row and the sentence under it reads "Add another gateway to switch between them here or from the gateway menu."

**A gateway's page** (not the one in use). Title: its name, with Back to Your gateways. A fact block:

| Row               | Value                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route             | "devbox, over SSH" or the address                                                                                                                                          |
| Last used         | "Nov 18, 4:02 PM"                                                                                                                                                          |
| This device there | "Last paired here · Nov 18, 4:02 PM": what this device recorded at its last hello. Nothing says it is paired now, because nothing is read from a gateway that isn't in use |
| Identity          | The first 12 characters of the gateway's id, in mono, or "Not read"                                                                                                        |

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

**A saved connection, before and after hello.** Each saved gateway has its own saved connection. Its routes are keyed by setup's stable route key (`setup.md` §2, "Routes"): the OpenClaw profile and port for this computer; the pinned host key, the resolved SSH target and the gateway's port on that computer for SSH, never the forward's local port; the address for an address route. A token is kept for one route and offered on no other.

- **Before hello**, setup's rules for reusing a credential apply (`setup.md` §15): on a route whose gateway can't be authenticated before the token is sent, the saved token is not sent by itself, and the person reconnects; on this computer and over SSH it goes by itself only to the gateway's port on a computer authenticated first.
- **The limit, plainly**, as setup states it: on those routes a saved token goes to whatever answers at that trusted address before the answer can be identified. Another process of the same account could hold the port while the gateway is stopped; the identity check after hello finds it only after the token was sent.
- **After hello, the identity check comes first.** Discovery (the bots, the task list), the restored selection (the open bot and task) and every write wait for `gateway.identity.get` on that route to match the identity saved for it. The core today starts discovery alongside the identity request (`packages/core/src/client.ts`, the discovery after hello), so the builder moves it behind the check.
- **An identity that can't be read** (the call fails or doesn't answer) keeps the connection out of use: the rail is empty, nothing is loaded or sent, and the strip says "Clawtrate can't confirm this is Studio gateway" with "Retry".
- **A changed identity** disconnects, drops that route's token, and the strip says "This address now leads to a different gateway" with "Review" (`setup.md` §15), which opens the gateway's page; nothing of the old gateway is shown or sent there.

**What gateways share, and what they don't.** This host has one device signing key, so every gateway paired from it sees the same public device id (research §2). Each saved route has its own token and its own held scopes in host storage, and neither is offered on another route. Drafts, the rail's arrangement, the open bot and task, what this viewer read and the unfolded bots are kept under a local key Clawtrate gives the gateway when it is saved, never under its address: an address that later leads to a different gateway inherits none of them.

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
| Hello; the identity check under way                 | Empty, "Confirming this is Studio gateway…"; no bot, task, composer or New                  | "Connecting to Studio gateway"                                                     | "Switching" on Studio's row           |
| The identity matches                                | Studio's bots, its tasks, its permissions                                                   | —                                                                                  | Studio "In use"                       |
| The identity can't be read                          | Empty                                                                                       | "Clawtrate can't confirm this is Studio gateway", with "Retry"                     | Studio "Not confirmed"                |
| Studio can't be reached                             | Empty, "Can't reach Studio gateway"                                                         | "Can't reach Studio gateway" · its reason, with "Retry" and "Back to Home gateway" | Studio "Can't reach it"               |
| Studio's identity differs from the one saved for it | Empty                                                                                       | "This address now leads to a different gateway" (`setup.md` §15)                   | Studio "A different gateway answered" |

**The badge and unread marks.** The dock or taskbar badge and the unread marks read the open gateway's tasks (`packages/ui/src/Shell.tsx`). As the old gateway closes they go to zero, and nothing is delivered from the closing connection; they come back only from the new gateway's tasks, after its identity check. A notification already delivered carries the gateway it came from, and opening it goes to that gateway, through the switch and its confirmation. Notification settings stay with issues #76 and #77.

"Switched to Studio gateway" is announced after the hello and the identity check. Bots, tasks and transcripts of a gateway are in memory only, so returning loads them again; the rail's arrangement, the open bot and task, and the drafts come back from this device's storage for that gateway (section 18).

## 7. Removing a gateway

"Remove…" on a gateway's page, or the Gateway pane's "Remove this gateway…" for the one in use, opens a confirmation built from what is on this device and what the connection holds at that moment. Every item is a fact; none is a guess.

> **Remove Studio gateway from this device?**
> Nothing on the gateway changes.
>
> Removed from this device
>
> - Its saved connection: its route, devbox, over SSH, with the key Clawtrate pinned for it and its SSH settings
> - Its route's device token and the access it holds
> - Drafts in 2 tasks
> - Its preferences on this device: how its bots are arranged, the open bot and task, what you read, and the bots you unfolded
>
> Stays
>
> - On Studio gateway: its bots, tasks, accounts and settings. Nothing there changes.
> - On Studio gateway: this device's record, device 9c2e41. Clawtrate doesn't ask the gateway to remove it. To remove it, run this on the gateway's computer:
>   `openclaw devices remove 9c2e41…` [copy]
> - This device's key. Home gateway knows this device by it too.
> - Clawtrate's own settings on this device: Appearance, System and Updates.
>
> [Cancel] [Remove] (`--danger-soft`)

**What is removed on this device, each record by name.** The saved connection (its address or route, any credential kept for a first pairing, and whether it was suspended); each route's device token and held scopes; the key pinned for an SSH route and its SSH settings (`setup.md` §8); the gateway's preferences under its local key (drafts, the rail's arrangement, the open bot and task, what this viewer read, the unfolded bots); for the gateway in use, its connection, open or waiting; a message waiting to be sent to it, named by count. What stays: this device's key, Clawtrate's own settings, and everything the gateway keeps.

- **The command** is the host's, for that gateway's profile, as the approve command is (`docs/decisions.md`, "Pairing"; `setup.md` §2, rule 11). The design never writes it.
- **With admin on the gateway in use**, the record's "Stays" item is replaced by a checkbox, unticked: "Also remove this device's record from Home gateway. That ends this device's access to Home gateway through every route." It is offered only while the connection holds `operator.admin`; for a gateway that is not connected it is never offered.
- **On an SSH route Clawtrate started OpenClaw on**, setup's checkbox, "Also stop OpenClaw on devbox (Clawtrate started it)", is added with setup's rules (`setup.md` §8), and its line says "Stopping OpenClaw ends any run in progress there." On the desktop the host's native dialog repeats the lists.
- **On the web preview**, one host serves every browser that uses it (`docs/decisions.md`, "Viewers"): a switch or a removal there affects every viewer of that host, and the confirmation says "This preview's host is shared: removing it here removes it for every browser that uses this host. Drafts kept in other browsers stay there." Data kept in a browser can be cleared only in the browser that removes.
- Items with nothing in them are left out ("Drafts in 2 tasks" only when there are drafts).

**The steps, in order, each reported only once it is on disk.**

1. When the record box is ticked: `device.pair.remove` with this device's own id. The gateway deletes the record first and then reconciles its runtime before it answers, and it ends this device's connections (research §3; the handler in `devices-*.mjs`), so a failure or a closed connection after the call proves neither that the record is gone nor that it stays. Only a successful answer naming this device's id counts as removed. A refusal the gateway sends before acting (a missing scope, a denial) counts as refused. Anything else (an error after the call, a result naming another id, no answer before the connection closes) is unclear, and nothing else is done until the person chooses.
2. Disconnect, when it is the gateway in use; stop the route's forward by its PID (`setup.md` §8).
3. Delete the saved connection, each route's token and held scopes, the pinned key and SSH settings.
4. Delete the gateway's preferences under its local key.
5. After each delete, read what is on disk, by reopening the store, not from its cache. The host's store today can report a value it failed to write (issue #170): its cache changes before the write, and `get` reads the cache. The read-back of this section depends on that fix. A retry first reads what is still there, and removes only that.

**How it ended.** The same lists, each item marked by what was read back:

| Outcome                                                          | Title                                                 | Then                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every step on disk, the gateway not asked                        | "Studio gateway is removed from this device"          | The lists, every "Removed" item done; the record's line says "Clawtrate did not ask the gateway to remove this device's record." with the command. When it was the gateway in use and others are saved: Your gateways, "Not connected. Choose a gateway to use."; when none is left, setup's first screen                                            |
| Every step on disk, after a successful answer naming this device | "Home gateway is removed from this device"            | Under "Removed": "Gateway removed this device's record. That ends this device's access to Home gateway through every route."                                                                                                                                                                                                                         |
| The gateway refused before acting                                | "Home gateway refused to remove this device's record" | "Nothing was removed. Home gateway said: <the error category>." with "Remove from this device only" and "Cancel"; afterwards the record's line says "Home gateway refused to remove it." with the command                                                                                                                                            |
| An unclear answer                                                | "Gateway record could not be confirmed"               | "Clawtrate asked Home gateway to remove this device's record and got no answer it can read. The record may be gone, and this device's access with it. Nothing else was removed." with "Remove from this device only" and "Cancel"; the final result keeps "Gateway record could not be confirmed." with where to look and the command, never "Stays" |
| A local step failed                                              | "Couldn't remove everything"                          | Each item marked done, left or not tried; "Try again" checks what is left and removes only that                                                                                                                                                                                                                                                      |

## 8. Appearance

Two groups, each a `.seg`:

- **Theme**: "Follow system", "Light", "Dark". The same preference the gateway menu sets (`packages/ui/src/preferences.ts`, `useTheme`); choosing it here or there changes both. The gateway menu's item, "Match the system" as built, takes the same words, so one preference has one name.
- **Your messages**: "Accent", "Neutral", with a small sample bubble of each beside the choice. The same preference as the gateway menu's "Your messages" (`useBubbles`).

Both apply at once and are read back (section 2). The page's line is "Applies on this device."; the choices are kept per viewer, in the interface's storage, so a phone and a desktop choose for themselves.

## 9. System: spelling and hardware acceleration

Desktop only. Two rows, each a title (15/500), a line under it, and a switch at the end.

**Check spelling while typing**, on by default on macOS (Electron's spellchecker is on by default, research §10).

| System  | Line under it                                                                                                                                                                                                                                                             | Facts                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | "Uses macOS's own spelling checker, in the languages macOS is set to."                                                                                                                                                                                                    | `session.setSpellCheckerEnabled`; the language list is macOS's, and Electron cannot set it                                                                                                                    |
| Windows | "Spelling is unavailable in this build." and no switch, until a dictionary comes with the app, or the person chooses a download after seeing the address it comes from. Once one is there, the row says spelling is active only after `spellcheck-dictionary-initialized` | Hunspell dictionaries, downloaded from a CDN by default (`electron.d.ts`, `setSpellCheckerDictionaryDownloadURL`); the app's request filter (`apps/desktop/src/main/index.ts`, `lockDownSession`); issue #171 |

- On, a misspelled word in the composer is underlined; right-click gives the suggestions and "Add to dictionary" (`context-menu`'s `dictionarySuggestions` and `misspelledWord`). Fields where spelling means nothing (addresses, names, search) keep `spellcheck="false"`, as today.
- On Windows the dictionary would come from a CDN by default, and the app contacts no host the person didn't choose. Whether today's request filter stops that fetch is not established; issue #171 finds out and stops it. So the Windows row says "Spelling is unavailable in this build." and F-393 stays `todo` for Windows (section 17). The same rule holds for Updates: a check happens only when the person chooses it, against a source the app names (section 10).

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

**With an update source** (drawn as a future example in the prototype, labelled "When releases are published"). Each state comes from the update engine's typed state (issue #68, `UpdateState` in `apps/desktop/src/main/update/engine.ts` on its branch); the engine checks, downloads and keeps a file only when its size and SHA-512 match the feed, and installs nothing. On macOS and Windows:

| Screen state                | Engine state                                                 | Updates row                                                                                                             | Actions                         |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| No source                   | `not-configured`                                             | "This copy can't check for updates: no update source is set up for it."                                                 | none                            |
| Not checked                 | `idle`                                                       | "Not checked yet."                                                                                                      | "Check for Updates"             |
| Checking                    | `checking`                                                   | "Checking updates.example.com…"                                                                                         | none                            |
| No newer version            | `up-to-date`                                                 | "No newer version was offered for this build by its update source. Checked at 5:41 PM."                                 | "Check for Updates"             |
| Offered                     | `available {version}`                                        | "Clawtrate 0.2.0 is offered by the update source."                                                                      | "Download"                      |
| Downloading                 | `downloading {received, total}`                              | "Downloading Clawtrate 0.2.0… 41 of 120 MB"                                                                             | none                            |
| Downloaded, installable     | `ready` and the installer confirms this build can install it | "Clawtrate 0.2.0 is downloaded, and its size and checksum match the update source. Ready to install."                   | "Restart to Update" (primary)   |
| Downloaded, not installable | `ready`, no such confirmation                                | "Clawtrate 0.2.0 is downloaded, and its size and checksum match the update source. This build can't install it itself." | none                            |
| Check failed                | `failed {stage: "check"}`                                    | "Couldn't check for updates."                                                                                           | "Try again"                     |
| No file for this system     | `failed {cause: "no-file-for-this-system"}`                  | "The update source has no file for this system."                                                                        | "Check for Updates"             |
| Download failed             | `failed {stage: "download"}`                                 | "Couldn't download the update. Try again."                                                                              | "Try again", which checks again |
| After the restart           | the running app's own version                                | "Clawtrate 0.2.0 is running."                                                                                           | "Check for Updates"             |

- **Nothing says "up to date".** `up-to-date` means only that the source the check used offered nothing newer for this build.
- **A build that can't install updates itself says so** above the facts: "This build can't install updates itself." (an unsigned build, a development build, or one the updater doesn't support). "Restart to Update" appears only when the updater confirms a download it can install.
- **The app contacts the source only when the person chooses.** Under the button: "Checks updates.example.com for a newer build, only when you choose to." The address is the build's own; nothing checks by itself, and "Download" is a second choice. Installing an update already downloaded needs no further fetch.
- **Words are never "verified" or "secure"**: the engine checks size and checksum against the feed, which carries no signature, and the screens say exactly that until the integrated engine reports what it verified and how.
- Whether quitting and reopening also installs a downloaded update depends on the updater the builder chooses (Electron's own `autoUpdater` applies one at the next start); the screen says so only for the updater in use, by platform.
- "Restart to Update" asks first when something waits to be sent, with section 9's confirmation and the title "Restart to update?".

**The automatic restart.** Updates says "Automatic restart is unavailable in this build." and offers no switch, until the app can establish every condition of F-391. Today it can't:

- **Locked, in effect.** `lock-screen` fires when the system is about to lock (`electron.d.ts`), so the rule needs `getSystemIdleState(600)` to read `locked` at the moment of deciding, on macOS and Windows.
- **The screen saver** is reported by nothing in Electron, so F-391's "or the screensaver is on" can't be honoured by itself.
- **Idle for ten minutes**: `getSystemIdleTime()` at least 600, on every system.
- **No active run, established, not assumed.** The status line describes one selected task (`packages/ui/src/Conversation.tsx`), the client keeps only the newest task rows and its discovery can be partial (`packages/core/src/client.ts`), and a reconnect, a switch or a missed event gives no positive "idle" answer. Unknown, reconnecting, loading, partial or stale activity on any connected gateway blocks the restart, as does a message waiting to be sent or confirmed.
- A manual restart can apply a downloaded update by itself on macOS (Electron's `autoUpdater` applies one at the next start), whatever this rule says; how each platform's installer behaves on a manual restart is described once the update engine provides installing (issue #68).

The checks for it, when it is built: another client starts a run in a task that isn't selected, and the restart doesn't happen; the gateway is disconnected, and the restart doesn't happen.

**Linux.** This repository builds no Linux package (research §4). A Linux package, when there is one, shows the version and "Updates are managed by your package manager.", with no switch and no button. A copy run from source shows the development build's line.

**iPhone.** No Updates section: the App Store or TestFlight updates the app.

## 11. A protocol refusal: Update required, and a gateway that needs updating

The connect handshake refuses a client whose protocol range doesn't include the gateway's with `PROTOCOL_MISMATCH` and the protocol the gateway speaks, `expectedProtocol` (research §7, live). The refusal comes before the gateway authenticates anything, and it carries a protocol, not a product version. The client compares `expectedProtocol` with the whole range it offered: above the range's top, this build is the older; below its bottom, the gateway is.

**The refusal belongs to that connection.** Nothing else is asked of that gateway after it (the core already sends no request after a mismatch, `packages/core/src/client.ts`). The app stays the app:

- The rail is empty, with "Can't use Home gateway"; there is no composer and no New.
- In place of the conversation, "Can't use Home gateway" and "The address saved for Home gateway replied with protocol 5. This version of Clawtrate speaks protocol 4." The words say "the address saved for", because the answer came before anything identified the gateway.
- The strip says "Can't use Home gateway · protocol 5", with "Try again".
- "Try again" makes a new handshake. The refusal stays, through a check for updates, a failed check or download, and a restart, until a handshake succeeds; a repeated refusal adds "Tried again at 5:42 PM: protocol 5 again."
- "Your gateways" opens Settings, Your gateways: the list, Switch, Add gateway and Remove stay reachable, with one saved gateway as well as several. The Gateway pane says "Can't use it", the problem line as built, and "Remove this gateway…".
- A product version is shown only as last seen, with its date ("Last seen: OpenClaw 2026.4.2 on Nov 12"), never as the gateway's version now.

**This build is the older** (`expectedProtocol` above its range):

- "Update required to use Home gateway. Other gateways aren't affected."
- Desktop, when the updater (issue #68) offers a replacement this build can install (section 10): "Update", which opens Updates. Otherwise, with no source, on a development build, or on a build that can't install updates itself: "This copy can't update itself. A newer Clawtrate is needed to use Home gateway."
- iPhone: "Look for a newer Clawtrate in the App Store, or in TestFlight if you test it there." It says where to look, not that a newer build exists.

**The gateway is the older** (`expectedProtocol` below the range): the same refusal, with "Update OpenClaw on the gateway's computer to use it with this version." in place of the update lines.

**F-010's rule**, "more than 14 days old and a newer version exists", needs the client's release date and an update feed. There is no feed, and publishing one is its own unit of work, so that rule shows nothing in this design. When it is designed, a blocking "Update" waits on an installable newer build. What this section designs is row F-518 (section 17), with one check parameterized by direction and by the number of saved gateways (section 18).

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

**Typing `/compact`** in the composer is the same thing, under the same rule: while a run is active in the task, the composer doesn't send it and says "Compact is available when this run ends. The gateway would stop a run still going a minute after you compact."; otherwise it is drawn as the button's. If a run starts in another client after Compact was sent, the gateway's stopped-run outcome below is what shows.

**What Compact does.** It sends `/compact` with `chat.send` and an idempotency key of its own, then waits for the gateway's reply in that task's history: a row from `model: "gateway-injected"` with the same key (research §8). It decides nothing from the button press.

**In the transcript.** The `/compact` message and the gateway's reply are not drawn as bubbles. One event line takes their place, at the reply's position, and says what the gateway reported and no more:

| What history shows, matched to this send                                                              | The line                                                                                                                    | Announced                                     |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Waiting for the reply                                                                                 | "Compacting Juniper's context…" with the working mark                                                                       | —                                             |
| A `compaction` marker with `tokensBefore` and `tokensAfter`                                           | "The gateway reported a compaction · 9.7k → 2.1k tokens", and the turns before it folded under it                           | "The gateway reported a compaction"           |
| A `compaction` marker without sizes (the gateway's "Compaction finished (resulting context unknown)") | "The gateway reported a compaction.", and the fold                                                                          | as above                                      |
| A reply that says it skipped                                                                          | "Nothing to compact yet."                                                                                                   | "Nothing to compact yet"                      |
| A reply that says it failed                                                                           | "The gateway reported that compaction failed." with "Show the gateway's reply", which opens the reply's text as text        | "The gateway reported that compaction failed" |
| A reply that says a run was stopped                                                                   | The line for its outcome, and under it, in `--warn`: "The gateway stopped the run that was going. Send that message again." | as above                                      |
| No matching outcome yet, after the history was read                                                   | "Clawtrate hasn't confirmed compaction." with "Refresh history", which reads the task's history again                       | "Compaction not confirmed"                    |

A history read without a marker proves nothing about the context, so no line says the context is unchanged; a failure is only what the gateway reported.

**The fold.** Only a `compaction` marker matched to the send makes a fold. The turns between the previous marker (or the start) and this one are folded under the line, with a disclosure "3 earlier turns" (the client's count of the person's turns there). Opened, they read as they did, with one line at their foot: "These are earlier turns in this transcript. The gateway reported a compaction here." The gateway says the transcript keeps every message and that recent messages stay intact, and it doesn't say which turns it summarized, so the fold claims nothing about which of them the bot still sees (research §8). The fold is closed when the task opens; it remembers being opened while the task stays open.

## 14. Free disk on the bot's machine

A report, never a clean-up: the gateway offers a client no clean-up of a machine's files (research §9), so nothing here deletes anything.

**Where the figures come from.** Only from a machine the gateway names for this bot, as `work-pane.md` §16 establishes it, and the note names the volume that was measured:

| The bot is set to work on               | Figures                                                                       | The volume named                                                                                                                             | The time                                 |
| --------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A node                                  | The node's `node.hostStats`, or the copy on its `node.list` record            | "The volume containing media-box's home folder": the node measures its home folder's volume (`os.homedir()`)                                 | The node's sample time, `updatedAtMs`    |
| The gateway's machine, a mount matched  | `system.info`, read when the task opens and every 10 minutes while it is open | "The volume containing Otto's workspace": the entry of `disks` whose path is the longest that contains the bot's `workspace` (`agents.list`) | "Checked at", the time Clawtrate read it |
| The gateway's machine, no mount matched | The same read                                                                 | "The volume containing the gateway's state folder" (`diskPath`), and "The workspace volume was unavailable."                                 | "Checked at"                             |

`system.info`'s list of volumes can be cut short when its collection times out, so a missing match says the workspace volume was unavailable and never calls the state folder's volume the workspace's. Both reads are `operator.read`, so a read-only connection sees the report.

**When.** Below 5 GB free, or below 5 percent of the volume (Clawtrate's choice), a note above the composer of each of that bot's tasks:

> Otto is set to run commands on media-box. The volume containing media-box's home folder has 2.1 GB free of 512 GB, as of 5:40 PM.
> Clawtrate deletes nothing. Whether Otto asks before it deletes a file depends on its command rules.
> [Show the computer] [Otto's rules] [×]

For the gateway's own machine: "Otto is set to run commands on the gateway's machine. The volume containing the gateway's state folder has 4.2 GB free of 994 GB. The workspace volume was unavailable. Checked at 5:40 PM.", or, when a mount matched, "The volume containing Otto's workspace has 4.2 GB free of 994 GB. Checked at 5:40 PM."

- "Is set to" because it is a setting, not proof of where a command ran (`work-pane.md` §16).
- "Show the computer" opens the Work pane's Computer tab, where the machine block has the same figures. "Otto's rules" opens Otto's Settings tab at what it may do (`controls.md` §4).
- Closed with ×, it stays closed until the free space changes by a gigabyte or more.
- A node's figures older than three minutes say so: "as of 5:31 PM. media-box hasn't sent newer figures." A machine that reports no disk gets no note.
- The note is a partial report for F-159: naming the largest items once and waiting for a fresh yes before deleting is the bot's own work in its turn, and the note claims neither.

## 15. Widths, themes, keyboard, screen readers, motion

| Concern        | Rule                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1440, 1100     | The Settings dialog is 800 × 640 (`bots.md` §2); every section scrolls inside it                                                                                                                                                                                               |
| 800            | The dialog takes the window's width less 48 px; the section list stays at 208 px                                                                                                                                                                                               |
| 390 (iPhone)   | The list first, full width; a section replaces it with Back (`bots.md` §7). No System, no Updates. A refusal gives the iPhone's words. The gateway menu opens downward from the round button at the top left (`visual-language.md` §7)                                         |
| Themes         | Every state in light and dark, from the tokens only                                                                                                                                                                                                                            |
| Keyboard       | Section 2, Input. Every action in every walk can be done without a pointer                                                                                                                                                                                                     |
| Screen readers | Each section's title is its `h3`; switches have their row's title as their name and its line as their description; the removal lists are lists; the compacted line is a `button` with `aria-expanded` that names the count; the low-disk note is a `region` named "Disk space" |
| Motion         | The working mark is a still ring when motion is reduced                                                                                                                                                                                                                        |

## 16. What each fact drives

| Shown or done                                                         | Rests on                                                                                                                                                                      | Research |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| One gateway in use; switching closes one connection and opens another | The core holds one connection; a message is never sent to another gateway                                                                                                     | §1, §6   |
| A second gateway apart from a second route                            | `gateway.identity.get` (`operator.read`) after hello                                                                                                                          | §1       |
| Each gateway's own pairing                                            | Device tokens keyed by route; one device key on the host                                                                                                                      | §1, §2   |
| Discovery and writes wait for the identity check                      | `gateway.identity.get` answers only after authentication; the core starts discovery alongside it today                                                                        | §1       |
| The removal's "Removed" list                                          | The host's and the interface's storage, item by item                                                                                                                          | §2       |
| "This device's record" stays, with the command                        | `device.pair.remove` needs `operator.pairing`; refused at read and interactive (live)                                                                                         | §3       |
| "Also remove this device's record" with admin                         | Admin removed its own record; the result names the id and the connection ends (live)                                                                                          | §3       |
| No "Check for Updates" today                                          | `publish: null`; no updater in the app                                                                                                                                        | §4       |
| What an update would need                                             | Squirrel.Mac needs a signed app; Electron cannot update NSIS; electron-builder's updater with a publish provider                                                              | §4       |
| The update screens' states                                            | The update engine's typed states (issue #68); install eligibility is not among them                                                                                           | §4       |
| The automatic restart, unavailable                                    | `lock-screen` fires before the lock; no screen-saver signal; the status line is one task's, the task list bounded and discovery possibly partial                              | §5, §6   |
| "No run is active" can't be established today                         | The selected task's run state; bounded rows; partial discovery                                                                                                                | §6       |
| A protocol refusal, either way                                        | `PROTOCOL_MISMATCH` with `expectedProtocol` before authentication (live), compared with the offered range                                                                     | §7       |
| Compact: the button, the wait, the lines                              | `/compact` through `chat.send` (`operator.write`); the gateway-injected reply with the send's key; skipped and failed replies (live)                                          | §8       |
| Compact unavailable during a run                                      | `/compact` waits up to 60 s, then stops the run (live)                                                                                                                        | §8       |
| The fold and its line                                                 | The `compaction` marker matched to the send, sizes only when present; the transcript keeps every message; recent messages kept intact; no word on which turns were summarized | §8       |
| Free disk, and deleting nothing                                       | `node.hostStats`, `system.info`, `agents.list` workspace (all `operator.read`, live for the last two); no client clean-up of files                                            | §9       |
| No Language setting                                                   | No translation in the interface                                                                                                                                               | §10      |
| Spelling on each system                                               | Electron's spellchecker; macOS's checker; Hunspell on Windows                                                                                                                 | §10      |
| Hardware acceleration needs a restart                                 | `app.disableHardwareAcceleration()` before ready                                                                                                                              | §10      |
| No security key setting                                               | No gateway support                                                                                                                                                            | §10      |

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

**Added**: F-518, a protocol refusal held to its connection, in both directions, with the gateways still reachable (section 11). `todo`.

## 18. For builders

### What each part uses

| Part                            | Existing                                        | New          |
| ------------------------------- | ----------------------------------------------- | ------------ |
| Your gateways, a gateway's page | Settings frame, choice list, fact block         | none         |
| Gateway menu group              | `.menu`, `menuitemradio`                        | none         |
| Removing                        | Confirmation, command block                     | Removal list |
| Appearance                      | `.seg`                                          | none         |
| System, Updates                 | Switch, fact block, confirmation                | none         |
| A protocol refusal              | The empty rail, the status strip, notes         | none         |
| Compact                         | Details tab, event line, steps fold, access bar | none         |
| Low disk                        | The note above the composer                     | none         |

### What the host does

| Need                                       | How                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saved gateways                             | One saved connection per gateway in host storage, under a local key of its own: its name, its routes under setup's stable route keys (`setup.md` §2), the identity saved for each route, each route's token and held scopes, the last hello's time and access. The `connection` key becomes the entry in use. Token records are keyed by route key, not URL                                                                    |
| Switching                                  | Close the connection; open the chosen gateway's route under setup's credential-reuse rules (`setup.md` §15); hold discovery, the restored selection and every write until `gateway.identity.get` matches the saved identity; an unreadable identity keeps the connection out of use with Retry; a changed one disconnects and drops that route's token. Generation checks fence old work; they don't authenticate a new answer |
| Removing                                   | The steps of section 7, each followed by a read of what is on disk after reopening the store (issue #170 makes that read true); the answer to the interface is the list with each item's state, and a retry starts from what is still there                                                                                                                                                                                    |
| The command to remove this device's record | `openclaw [--profile <p>] devices remove <deviceId>`, chosen by the host as the approve command is                                                                                                                                                                                                                                                                                                                             |
| The app's own settings                     | A file in the app's data folder, read before `app.whenReady()`: `spellcheck`, `hardwareAcceleration`, and, when automatic restart can be offered, its switch. Writes answer with the file's contents and Electron's reading. Appearance is not here: it is kept per viewer in the interface's storage (`packages/ui/src/preferences.ts`)                                                                                       |
| Spelling                                   | `session.defaultSession.setSpellCheckerEnabled`; a `context-menu` handler for suggestions. On Windows nothing is fetched unless the person chose it after seeing its address; issue #171 establishes what the app does today and stops it                                                                                                                                                                                      |
| Hardware acceleration                      | `app.disableHardwareAcceleration()` before ready when the file says off; `app.isHardwareAccelerationEnabled()` in the answer; "Restart now" is `app.relaunch()` then `app.quit()`                                                                                                                                                                                                                                              |
| Updates                                    | Until the owner publishes: report "no source" and nothing else. Then: the update engine (issue #68) for checking and downloading, a check only when the person chooses one, the installer the builder chooses for each platform, and the screen states of section 10 from the engine's typed states                                                                                                                            |
| Unsent messages                            | A count per gateway and bot of messages waiting to send or to be confirmed, for the confirmations                                                                                                                                                                                                                                                                                                                              |

**The interface's storage, per gateway.** `clawtrate.bot`, `clawtrate.tasks`, `clawtrate.seen` and `clawtrate.unfolded` hold the gateway's ids without naming it (research §2). They are keyed by gateway, as the rail's arrangement is, before switching ships; otherwise one gateway's open task is looked for in another, and a removal cannot remove them.

**What the update screens need from the update engine** that its typed states don't give today: a reading of whether this build can install what it downloads (signed, supported by the platform's installer), and the install-and-restart operation with its outcome; a direct retry after a failed download (`download()` starts only from `available`); the time of the last check; the source's address for the screen to name; and a cancellation outcome if the screens offer one. The running version after a restart is the app's own (`app.getVersion()`).

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
2. **Saved gateways, switching and the gateway menu** (F-230, F-389), with checks that one gateway's bots, tasks and permissions never show under another, that a message waiting for one is never sent to another, and two that change the answer at a saved address: a different gateway at the same address, and a reused local SSH forward port. Each records which credentials and requests leave the client before the identity check, and what the renderer shows (nothing of either gateway until the check passes).
3. **Removing** (F-390), with a check for each step's failure.
4. **Appearance** (F-228's built part), **System** (F-393 on macOS, F-394).
5. **Compact and its line** (F-279), against the development gateway: skipped and failed replies are live; a success needs a scripted model that writes a summary.
6. **Low disk** (F-159's report).
7. **Updates** (F-231, F-391, F-458) only once the owner publishes releases; until then the "no source" line.

**F-518's check**, when it is built: one check, parameterized by the gateway's protocol (above this build's range, below it) and by the saved gateways (one, two). Against a development gateway that answers with that protocol, it asserts the words of section 11, that no request goes out on that connection after the refusal, that "Try again" makes a new handshake and the refusal stays until one succeeds, and that Your gateways, Add gateway and Remove are reachable.

### The prototype's states and walks

`settings.html` takes every parameter `controls.html` takes, and these:

| Parameter                | Values                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open=settings&section=` | `gateway`, `gateways`, `appearance`, `system`, `updates` (and every section of `bots.html` and `controls.html`)                                                                                                                                                                                                                           |
| `gw`                     | `studio`: that gateway's page                                                                                                                                                                                                                                                                                                             |
| `gateways`               | `one`: Home gateway alone                                                                                                                                                                                                                                                                                                                 |
| `waiting`                | `1`: a message to Otto waits to be sent                                                                                                                                                                                                                                                                                                   |
| `switchfail`             | `1`: Studio gateway can't be reached                                                                                                                                                                                                                                                                                                      |
| `remove`                 | `studio` or `home`: that removal's confirmation open; `rmfail=remote` (refused before acting), `unknown` (an unclear answer) or `local`; `host=web`: the web preview's shared host                                                                                                                                                        |
| `os`                     | `mac`, `windows`, `linux`                                                                                                                                                                                                                                                                                                                 |
| `build`                  | `dev`: a copy run from source                                                                                                                                                                                                                                                                                                             |
| `feed`                   | `1`: an update source exists (the future example); `upd=idle`, `checking`, `current`, `available`, `downloading`, `ready`, `failcheck`, `nofile`, `faildl`, `restarted`; `install=1`: this build can install what it downloads; `next=update`, `failcheck` or `nofile`: what Check for Updates finds; `dl=fail`: the first download fails |
| `spell`                  | `off`; with `os=windows`, spelling is unavailable in this build                                                                                                                                                                                                                                                                           |
| `hw`                     | `pending`, `off`                                                                                                                                                                                                                                                                                                                          |
| `required`               | `client` or `gateway`: a protocol refusal on Home gateway; `retryok=1`: the next handshake succeeds; `install=1` with `feed=1`: the updater offers a replacement this build can install                                                                                                                                                   |
| `compact`                | `running`, `compacting`, `done`, `nosizes`, `skipped`, `failed`, `stopped`, `unconfirmed` (open Juniper's task "Heat pump vs. gas furnace"); `reply=` the same values: what the next Compact gets                                                                                                                                         |
| `disk`                   | `node`, `stale` (a node's old sample), `gateway` (no mount matched), `matched`: the low-disk note in Otto's tasks                                                                                                                                                                                                                         |
| `add`                    | `1`: the setup flow's stand-in open                                                                                                                                                                                                                                                                                                       |

The check walks these by clicking, and asserts each destination's words:

| Walk                                                             | From                                           | Through                                                                              | To                                                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Switch, nothing waiting                                          | The gateway menu                               | Studio gateway                                                                       | Studio's bots only; "Switched to Studio gateway"                                                                             |
| Switch, a message waiting                                        | `waiting=1`, the gateway menu                  | the confirmation, Switch                                                             | Studio in use; Cancel leaves Home in use                                                                                     |
| Switch fails                                                     | `switchfail=1`                                 | Studio gateway, "Back to Home gateway"                                               | Home in use again                                                                                                            |
| Add a new gateway                                                | Your gateways                                  | Add gateway…, the stand-in's "Paired: a new gateway"                                 | "Added Lab gateway", three gateways                                                                                          |
| Add the same gateway                                             | Your gateways                                  | Add gateway…, "Paired: the same gateway"                                             | "Home gateway is already here", two gateways                                                                                 |
| Add, cancelled                                                   | Your gateways                                  | Add gateway…, Cancel                                                                 | "Nothing was added", Home in use                                                                                             |
| Remove another gateway                                           | Studio's page                                  | Remove…, the lists, Remove                                                           | "Studio gateway is removed from this device"; one gateway                                                                    |
| Remove the gateway in use, with admin                            | Gateway pane                                   | Remove this gateway…, the record checkbox, Remove                                    | "Gateway removed this device's record…"; "Not connected. Choose a gateway to use."                                           |
| Remove, the gateway refuses                                      | `remove=home&rmfail=remote`                    | the box, Remove, Remove from this device only                                        | "Home gateway refused to remove this device's record", nothing removed; then removed, the record "refused"                   |
| Remove, an unclear answer                                        | `remove=home&rmfail=unknown`                   | the box, Remove, Remove from this device only                                        | "Gateway record could not be confirmed", nothing else removed; the final result keeps it                                     |
| Remove, a local step fails                                       | `remove=studio&rmfail=local`                   | Remove, Try again                                                                    | Removed                                                                                                                      |
| Appearance                                                       | Appearance                                     | Dark, Neutral                                                                        | the page dark; neutral bubbles                                                                                               |
| Spelling                                                         | System                                         | the switch                                                                           | "Spelling isn't checked"                                                                                                     |
| Hardware acceleration                                            | System                                         | the switch, Restart now                                                              | "Off. Clawtrate draws without the graphics hardware."                                                                        |
| Updates, no source                                               | Updates                                        | —                                                                                    | "no update source"; no button, no switch                                                                                     |
| Updates, with a source                                           | `feed=1&install=1&next=update`                 | Check for Updates, Download, Restart to Update (with `waiting=1`, the confirmation)  | "No newer version was offered…" without `next`; offered, downloading, "Ready to install", then "Clawtrate 0.2.0 is running." |
| A protocol refusal (F-518), each direction, one and two gateways | `required=client` or `gateway`, `gateways=one` | Try again; Your gateways; with `retryok=1`, Try again                                | still refused, "protocol 5 again"; the list with Add gateway and Remove; connected                                           |
| Compact                                                          | Juniper's task, Details                        | Compact; also typed; with `reply=nosizes`, `failed`, `unconfirmed` (Refresh history) | "Compacting…", then "The gateway reported a compaction", the fold opening "3 earlier turns"; each reply's own line           |
| Compact while running, read-only                                 | `compact=running`; `access=read`               | —                                                                                    | disabled with its sentence; the access bar                                                                                   |
| Low disk                                                         | `disk=node`                                    | Show the computer                                                                    | the Computer tab                                                                                                             |

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
