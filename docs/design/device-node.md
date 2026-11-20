# This device for bots: the node, the share sheet, Siri and Shortcuts

How the Mac or the iPhone Clawtrate runs on becomes a device a bot can ask for things, such as a calendar, a location or the person's Messages, and how things come into Clawtrate from the rest of the phone. The gateway calls such a device a **node**. This part of the design comes after `visual-language.md`, `conversation.md`, `bots.md`, `work-pane.md`, `controls.md` and `setup.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`: F-185, F-223, F-347, F-348, F-384, F-385, F-451 and F-452 for the device, and F-245, F-246 and F-406 for the share sheet, Siri and Shortcuts. What the gateway does is in `docs/research/device-node.md`, from OpenClaw 2026.10.6's source and from live runs against development instances with a stand-in node; every state below names the fact it rests on, and section 13 lists them. Section 15 is for builders.

A node is a device a bot can send commands to, so one rule sits above the rest: **nothing a bot asks of this device is done unless the person allowed that app on this device, and no screen says more than the gateway read back.** The gateway admits a call by its own lists and never looks at what the device says it allows (research §4.1), so this device enforces its own permissions and refuses, in words the bot gets, whatever it will not serve. And Clawtrate's node never offers a command that runs a program, reads or lists files, uses a browser, or records the screen: it declares only the commands for the apps of section 5, each served by Clawtrate's own code.

The prototype shows all of it: `prototype/device.html`, with the state in the address (section 15). The styles are in `prototype/css/device.css`, the behaviour in `prototype/js/device.js`, and `prototype/tools/checks/device.mjs` clicks through every walk and asserts each state's words and structure.

## Contents

1. How the pieces fit
2. Shared rules: what holds what, the two approvals, one device with two roles, access, words, components, input
3. This Mac and This iPhone, off
4. Turning it on
5. What this device offers
6. A Mac app outside the defaults: the owner's choice
7. A request on this device: the permission card
8. What a bot is told
9. The phone in the background
10. Other devices asking to be used by bots
11. The share sheet
12. Siri and Shortcuts
13. What the gateway's facts drive
14. Parity rows
15. For builders
16. Not covered here

## 1. How the pieces fit

```
Settings (⌘,), after Machines        This Mac (desktop) or This iPhone (iPhone)
  off                                  the switch, the apps it would offer, what is never offered (section 3)
  turning on                           the host's confirmation; the device request; the command surface (section 4)
  on                                   each app: on this device, and on the gateway (section 5)
    Messages, Mail, Notes                the owner's allowlist, admin, and the words before the choice (section 6)
  Requests for this device             requests that named no task (section 7)
Settings, Machines                   Devices asking to be used by bots, for admin (section 10)
a task on the device that is asked   the permission card (section 7); "While Clawtrate was in the background" (section 9)
the bot's own task, anywhere         the bot's action card for its call, as conversation.md draws it, with the words of section 8
iPhone, outside the app              the share sheet (section 11); List Bots and Send Message (section 12)
```

The desktop and the iPhone have the same page with the same parts; only the name, the apps and the background rules differ. The page is a Settings section in the frame of `bots.md` §7, placed after Machines (`controls.md` §15), whose title is its `h3`.

## 2. Shared rules

### What holds what

| Held by          | What                                                                                                                                                  | How it shows                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **The gateway**  | Whether this device is paired as a node; which of its commands it accepted; the owner's allowlist; which bots are offered the tool that reaches nodes | Read back: `node.describe`, `node.pair.list`, `config.get`, a bot's tools (`controls.md` §2)    |
| **This device**  | Whether each app is allowed for bots on this device; the permission card; whether the app is open; what it answers                                    | Clawtrate's own store on this device, and the operating system's own permission for Clawtrate |
| **Neither**      | Running a request again after a late Allow; how often a bot asks; what the bot says afterwards                                                         | Not offered (section 7)                                                                         |

Every line says which of the two holds it. The gateway mark of `controls.md` §2, "The gateway enforces this", goes only on what the gateway itself refuses: a command it did not accept, or an allowlist entry removed. An app allowed or not on this device carries a new mark, **"This device enforces this"**, with the device icon: it holds while Clawtrate runs on this device and answers as section 8 says, and nowhere else.

### The two approvals

Being used by bots takes two approvals on the gateway, one after the other (research §1.1):

1. **The device.** The node's first connect asks the gateway to pair this device in the node role. Only an admin connection, or `openclaw devices approve` on the gateway's computer, can approve it. This device's own connection, without admin, can see the request and cancel it, and nothing more (research §1.2). On the gateway's own computer, with the gateway's default setting, the gateway approves it by itself (research §1.4).
2. **Its commands.** Once connected, the node asks for its commands to be accepted. The gateway keeps only the commands its lists allow and drops the rest without saying so (research §2.2). This device's own operator connection can approve its own commands when it holds device access (`operator.pairing`) and write; an admin connection can approve any device's (research §1.2).

A later change of the commands, or a permission newly reported as granted, asks again at step 2 (research §4.2). Removing the node needs admin (research §6).

### One device, two roles

Clawtrate is one device to the gateway, with its operator connection (`setup.md`) and its node connection, the same key and the same name. That is what lets it approve its own commands without admin. The gateway combines a waiting node request with a new operator request from the same device into one request for both roles, and approving that pairs both (research §1.3). So:

- The host starts the node connection only once this device is paired as an operator and has no request of its own waiting: no first pairing, no request for more access.
- While this device's node request waits, the access bar's "Request access" is unavailable, with the reason: "This Mac's request to be used by bots is waiting. Ask for more access once it is answered: the gateway would combine the two." And while a request for more access waits, turning the node on is unavailable with the same reason the other way round.
- When this device approves its own commands, the host first reads the request and compares its commands and permissions with what it declared. Anything else, and it approves nothing and shows what differs: "The request lists commands this Mac didn't ask for. Clawtrate didn't approve it."

Whether `device.scopes.requestUpgrade` would also merge into a waiting node request is not established (research §1.3); the first two rules make the question moot.

### Access

A connection is judged by the scopes the gateway granted it, as in `controls.md` §2. The node connection itself holds no operator scope.

| What                                                     | Needs                                                                                        | Below it                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| See this page, what this device offers, its state        | Read (`node.describe`, `config.get`)                                                         | —                                                                                                          |
| Turn the node on or off on this device                   | Nothing from the operator tier; the host's confirmation                                      | —                                                                                                          |
| Approve this device as a node                            | Admin, or the gateway's computer                                                             | The command to run there (section 4)                                                                       |
| Approve this device's own commands                       | Device access and write (`operator.pairing`, `operator.write`)                               | "Approving this Mac's commands needs device access." with "Request access" for `operator.pairing` only    |
| Allow a Mac app outside the defaults                     | Admin (`config.patch`)                                                                        | "Messages needs the gateway's owner. Adding it to the gateway's allowlist needs admin access."            |
| Remove this device or another from the gateway           | Admin (`node.pair.remove`)                                                                    | "Removing it from the gateway needs admin access."                                                         |
| See and approve other devices that ask to be used by bots | Admin                                                                                       | "Approving other devices for bots needs admin access."                                                     |
| Share into Clawtrate, Send Message                       | Write (`sessions.create`)                                                                     | The share sheet's and the action's own failure (sections 11, 12)                                          |
| List Bots                                                | Read (`agents.list`)                                                                          | —                                                                                                          |

Device access is requested on its own, never with another scope, by the access bar of `bots.md` §2 with `controls.md`'s words, and the page stays as it was if it is denied. Admin is the explicit request of `bots.md` §2.

### Words

- The page never says "safe", "secure", "private" or "protected". What this device enforces is said as what it does: "Clawtrate asks you first", "Clawtrate answers that you chose Don't allow".
- Device names, bot names, command names and everything in a request are data from the gateway or from the device that wrote them: shown as text, in mono where they are names, never as links, and bounded in length with the whole value in Raw. A request's parameters are shown, never followed: an address in them is text (the remote content rule on the branch `e3-remote-content-rule`).
- What a person sees about a request is what this device received. A request that never reached it is never described as if it had.

### Components used

| Component                                                        | From                                | Used for                                             |
| ---------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Settings frame, its sections, Back                              | `bots.md` §7                        | This Mac, This iPhone; Machines' block              |
| Fact block (`.facts`), group word, note (`.b-note`), switch (`.b-switch`) | `visual-language.md` §9, `bots.md` §2 | Every page                                |
| The access bar and its request                                  | `bots.md` §2, `conversation.md` §3  | Device access, admin                                 |
| The command block and its copy button                           | `visual-language.md` §10            | The approve command for the gateway's computer      |
| The host's confirmation                                         | `setup.md` §2                       | Turning the node on                                  |
| Step list (`.s-steps`)                                          | `setup.md` §2                       | Turning on; allowing a Mac app                       |
| Confirmation (`role="alertdialog"`)                             | `bots.md` §2                        | Allowing and taking back a Mac app; stopping; approving another device |
| The approval card's frame                                       | `conversation.md` §12               | The permission card's frame only (section 7)         |
| The mark (`.c-mark`)                                            | `controls.md` §2                    | "The gateway enforces this", "This device enforces this" |
| The composer and its attachments                               | `conversation.md` §15, F-284        | What the share sheet and Send Message hand over      |

### New components

Each is defined once, in `prototype/css/device.css`, from existing tokens. No colour token is added.

| Component                 | What it is                                                                                                                                                                                                                                  | Tokens                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| App row (`.d-app`)        | One app this device can offer: its 32 px glyph, its name (15/500), and two fact lines under it (13), "On this Mac: …" and "On the gateway: …", each with its mark; at the right its value word or its action. 64 px or taller, 72 on touch | `--bg-bubble`, `--text-faint`     |
| State line (`.d-state`)   | The node's state in one line with a dot: connected (`--accent-line`), waiting (`--warn`), not connected (`--text-faint`), removed (`--danger`), and its time                                                                                | `--accent-line`, `--warn`        |
| Permission card (`.d-ask`) | The approval card's frame (`--warn-line` outline while it waits, a 17 px title, a tag, buttons along the foot) with the tag "Needs permission" and a countdown line                                                                         | `--warn-line`, `--warn-soft`      |
| Share sheet (`.d-share`)  | The iPhone share sheet's Clawtrate view: a To row, the items as chips, the note field, Send; drawn as a sheet over a stand-in of the sharing app                                                                                           | `--bg-raised`, `--shadow-pop`     |
| System panel (`.d-sys`, prototype only) | The prototype's picture of Siri's or Shortcuts' result and confirmation. It is a stand-in; the phone draws its own                                                                                                       | `--bg-raised`                     |

### Input

- A switch is a `switch` role with its label; changing it opens the host's confirmation or a confirmation dialog first where the section says so, and nothing is announced until the gateway's read-back agrees.
- An app row is a group: its name, its two fact lines and its action are read in that order; its action is the row's only tab stop.
- The permission card does not take focus when it arrives; it is a `region` named "Otto wants Location on this iPhone. Needs permission." Allow is the default button; Escape does nothing to it.
- One polite live region announces: "This Mac can be used by bots", "Waiting for the gateway's owner", "Calendar allowed", "Messages turned off", "Sent to Juniper", and the access request's own phrases.

## 3. This Mac and This iPhone, off

Settings, **This Mac** (on the iPhone, **This iPhone**), the first time and whenever the node is off:

- The switch row: "Let bots use this Mac", off. Under it (13, muted): "Bots that may use other devices could then ask this Mac for the apps you allow below. Each app asks you on this Mac first."
- "Bots that may use other devices", one line read from each bot's tools (`controls.md` §2, the fact "Offered"): "In their latest tasks, the gateway offered Otto the tool for other devices. Juniper, Marlow and Pip weren't offered it." with "Open a bot's permissions". With no listing yet: "The gateway hasn't listed these bots' tools yet." On the development gateway every bot is denied it.
- The apps it would offer (section 5), shown and disabled, each with "Off".
- **What this Mac never offers**, a short fixed block: "Clawtrate never lets a bot run programs, read or list files, use a browser or record the screen on this Mac. Those commands exist on the gateway; this Mac doesn't offer them." The gateway's own lists include such commands for desktops (research §2.1), so this is said, not implied.

Facts under the apps: "Device name: Studio Mac" (the name the gateway will show; `Rename` is in Machines, `controls.md` §15), and "Gateway: devbox, OpenClaw 2026.10.6".

## 4. Turning it on

Turning the switch on registers this device in the node role, so the host prepares it and shows its own confirmation (`setup.md` §2): **"Let bots on devbox use this Mac?"**, detail "Clawtrate connects to the gateway as a device bots can send requests to. It offers Location, Contacts, Calendar and Reminders, and asks you before each one is used. The gateway's owner approves this device first." The commands it lists are exactly what the node declares. Cancel leaves the switch off and nothing is sent.

Then a step list (`setup.md`'s `.s-steps`), each step from what the gateway answered:

1. **"Asking the gateway"**: the node connects. The gateway answers at once.
2. **"Waiting for the gateway's owner to approve this Mac"** while `PAIRING_REQUIRED` with `requestedRole: "node"` holds:
   - Below admin: "Approving a device for bots needs admin access. On devbox, approve this request for the default profile:" with the command block `openclaw devices approve 3c9b20e4-6f1d-4a7e-9b21-58d0c4e7a6f3` (the profile and wording of `setup.md` §9; on an address route, "with `--profile <name>` if the gateway doesn't use the default profile"), the waiting line and "Check now" as the pairing screen has them, and "Cancel request".
   - With admin: "You're connected with admin access, so you can approve this Mac yourself." with "Approve this Mac" (primary). It approves exactly the request the host read, `device.pair.approve`.
   - "Cancel request" is `device.pair.reject` on this device's own request, which the gateway allows (research §1.2), and the switch goes off.
3. **"Approving this Mac's commands"**: the node connects again and asks for its commands. With device access and write, the host compares the request with what it declared (section 2) and approves it, `node.pair.approve`. Without device access, the step waits: "Approving this Mac's commands needs device access." with "Request access" for `operator.pairing` alone, and for the gateway's computer "or on devbox: `openclaw nodes approve <requestId>`". (The gateway names that command in its own messages; research §1.2 did not run it.)
4. **"Reading back what the gateway accepted"**: `node.describe`. Done only when it reads `paired`, `connected` and the commands. The page then shows section 5.

**On the gateway's own computer**, with `autoApproveLocal` at the gateway's default, steps 2 and 3 pass without anyone (research §1.4). The page then says so once, under the state line: "The gateway approved this Mac by itself, because Clawtrate runs on the gateway's own computer."

**Failures**, each in place of the step that failed, with what is on the gateway after it: "The gateway's owner rejected this Mac. Nothing is offered to bots." (a `device.pair.resolved` with `rejected`); "The gateway didn't answer. This Mac isn't connected as a device for bots." with "Try again"; "The gateway accepted none of this Mac's commands" when step 4 reads an empty list (section 5).

## 5. What this device offers

The page once the node is on. At the top, the state line, from `node.describe`:

| State                         | From                                                       | The line                                                                           |
| ----------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Connected                     | `connected: true`, `approvalState: "approved"`              | "Connected. Bots can send requests to this Mac. Approved Nov 19, 5:31 PM."        |
| Commands waiting for approval | A pending `node.pair.list` entry for this device             | "A change waits for approval: Messages." with section 4's step 3                  |
| Not connected                 | `connected: false`                                         | "Not connected. Bots that ask this Mac are told it isn't connected. Last seen 5:02 PM." with "Connect again" |
| Removed                       | `node.pair.resolved` with `removed`, or the device no longer listed | "The gateway's owner removed this Mac as a device for bots. Turn it on again to ask anew." The switch reads off |

Then **the apps**, one app row each, in this order. On the desktop: Location, Contacts, Calendar, Reminders, then Messages, Mail and Notes (F-385). On the iPhone: Calendar, Contacts, Location, Reminders, then Alarms and Home (F-223). Each row has two lines:

- **"On this Mac"** (this device enforces this), its value word at the right:
  - **Allow**: not decided yet. The first request asks with the permission card (section 7). Pressing Allow here allows it at once, with no card, after the operating system's own question where it has one.
  - **Allowed**: requests for it are answered. The row's menu has "Turn off".
  - **Denied**: the person chose Don't allow, here or on a card. Requests are refused at once with section 8's words. Its action is "Allow".
  - **Turned off in System Settings** (on the iPhone, "in Settings"): the operating system refuses Clawtrate. Its action is "Open Settings" (F-347). Clawtrate can't ask again; only the person can, there.
- **"On the gateway"**, from `node.describe` `commands`, never from what Clawtrate declared:
  - **"Offered to bots"**, with the gateway's mark, when the app's command is listed.
  - **"Waiting for approval"** while a surface request lists it.
  - **"Not offered: the gateway's allowlist doesn't include it"** when Clawtrate declared it and the gateway's read-back lacks it. That is how a dropped command shows: the gateway dropped it without saying so (research §2.2). For the defaults this should not happen; when it does, the row says "Not offered by the gateway" and the reason it gave, if any.

The first four apps on each platform are among the gateway's defaults (`location.get`, `contacts.search`, `calendar.events`, `reminders.list`; research §2.1). Messages, Mail, Notes, Alarms and Home are commands of Clawtrate's own, which no default allows: their rows read "Not offered" until the owner adds them (section 6).

Under the apps, **"Bots that can use this Mac"** as in section 3, and **"What bots are told"**, a disclosure with section 8's table, so the person can see the exact words.

**Turning the node off.** The switch, off, asks first: **"Stop letting bots use this Mac?"**, "Bots that ask this Mac will be told it isn't connected. The gateway keeps this Mac as a device until its owner removes it." With admin, a checkbox "Also remove it from the gateway" (`node.pair.remove`), read back by its absence from `node.list`. Then "Stop" and Cancel. The node disconnects at once; an app's request being answered is answered "TURNED_OFF_ON_DEVICE" (section 8).

## 6. A Mac app outside the defaults: the owner's choice

Messages, Mail and Notes on the desktop, and Alarms and Home on the iPhone, need a command the gateway doesn't know, so the gateway's owner must add it to the gateway's allowlist, `gateway.nodes.commands.allow`, with admin. The allowlist is for every node and every bot (research §2.3): which bots can then ask is each bot's tool for other devices.

**Below admin**, the row's action is "Allow…", which opens a note in place: "Messages needs the gateway's owner. Adding it to the gateway's allowlist needs admin access." with the access bar's "Request admin access". Nothing else changes.

**With admin**, "Allow…" opens a confirmation, **before** anything is written:

> **Let bots use Messages on this Mac?**
>
> Otto can use other devices, so Otto could then use Messages on this Mac: whatever Messages can do with your account here, Otto could do. That includes reading your conversations and sending messages as you.
>
> The gateway's allowlist is for every bot. A bot given the tool for other devices later could use Messages too. Clawtrate still asks you on this Mac before the first request.
>
> [Allow Messages] [Cancel]

The bots named are those section 3's line names, by name; with none: "No bot can use other devices now. A bot given that tool later could use Messages on this Mac: …". Nothing calls it safe. Mail says "reading your mail and sending mail as you"; Notes, "reading and changing your notes"; Alarms, "setting and removing alarms"; Home, "controlling your home's accessories".

"Allow Messages" then runs as steps, each read back:

1. **"Adding Messages to the gateway's allowlist"**: one `config.patch` with the current hash, then `config.get` until the entry is there.
2. **"Asking the gateway to accept it"**: the node connects again declaring it; a surface request appears. This device approves its own (section 4, step 3); without device access the step waits as there.
3. **"Reading back"**: `node.describe` lists the command. Then "On the gateway: Offered to bots" and "On this Mac: Allow".

A failure says what the gateway holds then: after step 1 fails, "Nothing changed on the gateway."; after step 2 fails, "Messages is on the gateway's allowlist, but the gateway hasn't accepted it from this Mac yet." with "Try again" and "Remove it from the allowlist"; when another client changed the configuration first (the hash no longer matches), "The gateway's settings changed since Clawtrate read them. Nothing was written." with "Try again".

**Taking it back**, from the row's menu once allowed:

- **"Turn off on this Mac"** (anyone): the app reads Denied at once. A request this Mac is answering for it is stopped and answered "TURNED_OFF_ON_DEVICE"; anything Messages already did, a message already sent, stays done. The allowlist entry stays.
- **"Remove from the gateway's allowlist"** (admin): a confirmation, "Bots will no longer be able to ask any device for Messages. A request waiting for this Mac ends at once, and the bot is told the command is no longer allowed. What this Mac already did is not undone." Then one `config.patch` that replaces the list without the entry (`replacePaths`, research §2.3), read back by `config.get` and by `node.describe` no longer listing it. The gateway ends a waiting call at once with "POLICY_CHANGED" and ignores this Mac's later answer (research §6).

## 7. A request on this device: the permission card

When a request arrives for an app that is not yet decided (Allow), this device asks its person before answering. This is not one of the gateway's approvals: the gateway keeps no record of it, it reaches no other device, and an answer means only what this device then does (research §8). The card uses the approval card's frame from `conversation.md` §12 (outline, title, tag, buttons along the foot, Deny last) and none of its states or words.

**Where it shows.** On this device only. When the request carries the task's key (`sessionKey`, research §3.1), the card is placed in that task, after the bot's latest step, and the bot is named. When it carries none, the card goes to "Requests for this device" at the top of This Mac's page, and a one-line banner at the top of the window, "A request for Calendar on this Mac", opens it. The device that sent the message that started the run may be another one: it never sees this card, only the bot's call and its outcome (section 8).

**Pending**, while the call is open (the request's `timeoutMs`, 30 seconds unless the caller set another):

- Title: "Otto wants Calendar on this Mac" (no task key: "A request wants Calendar on this Mac").
- Tag: "Needs permission", on `--warn-soft`.
- Summary: "Otto asked, through the gateway, to read your calendar's events. Allowing lets any bot that can use this Mac read them from now on."
- "Show request": the command and its parameters as text (`calendar.events`, the date range), and Raw.
- Buttons: "Allow" (primary) and, at the far right, "Don't allow" (quiet).
- Foot: "Otto's request waits until 5:44:30 PM. If you answer after that, Allow keeps Calendar allowed for next time." The time is the request's arrival plus its `timeoutMs`; the line counts the last 10 seconds.

This device answers the call itself just before its limit runs out, so the bot is never left with a bare timeout: two seconds before, if nobody has answered, it refuses with "NO_ANSWER_ON_DEVICE" (section 8).

**The outcomes**, each from what this device did and what the gateway answered it (`node.invoke.result` returns `{ok}` or `{ok, ignored: true}`, research §3.1):

| What happened                                       | The card's tag     | Its words                                                                                                                                    | What the bot got                |
| --------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Allow, while the call was open; the gateway took the answer | Allowed    | "Allowed. This Mac sent Otto's request its answer at 5:44 PM. Calendar is allowed for bots from now on."                                    | The events                      |
| Allow, but the gateway had stopped waiting          | Allowed            | "Allowed. The request had ended when this Mac answered, so nothing reached Otto. Calendar is allowed for next time."                        | Its call's end, `TIMEOUT`       |
| Don't allow                                         | Not allowed        | "Not allowed. Otto was told you chose Don't allow. Calendar stays Denied until you change it in This Mac."                                   | "NOT_ALLOWED_ON_DEVICE: …"      |
| No answer before the call's limit                   | Needs permission   | "Otto's request ended at 5:44 PM and nothing was sent. You can still allow Calendar for next time." with "Allow for next time" and "Don't allow" | "NO_ANSWER_ON_DEVICE: …"   |
| Allow for next time, any time later                 | Allowed for next time | "Allowed for next time. Otto's request ended at 5:44 PM and wasn't run. Otto will be answered the next time it asks." (F-452)             | Nothing more                    |
| Five minutes after the request, still no answer     | Timed out          | "Timed out. Nothing was sent, and Calendar is still not allowed. Change it in This Mac." (F-348)                                             | Nothing more                    |
| The operating system refuses Clawtrate              | Turned off         | "Calendar is turned off for Clawtrate in System Settings." with "Open Settings" (F-347); no Allow                                             | "TURNED_OFF_IN_SETTINGS: …"     |

- The card stays answerable for **five minutes** from the request, then reads Timed out. This is this device's rule; the gateway knows nothing of it (research §4.3).
- **No request runs again.** Allowing after the call ended saves the permission and runs nothing; the card says so. A bot that asks again later is answered, and its new call passes the gateway's checks as they are then: if the owner removed the command meanwhile, the gateway refuses the new call itself (research §6). Clawtrate never sends a message for the person, and never asks the bot to try again.
- A resolved card folds to one line, 40 px, like a resolved approval card, and opens to its words and the request.
- **Two requests for the same app** while one card waits: one card, "Otto asked twice", and one answer for both.

## 8. What a bot is told

Every refusal this device writes is a fixed code and a sentence, and the bot reads them as `"<code>: <sentence>"`, after its tool's own prefix (research §3.2). The words never include anything the request carried.

| Code                     | Sentence                                                                                      | When                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `NOT_ALLOWED_ON_DEVICE`  | "The person chose Don't allow for Calendar on Studio Mac."                                    | The app is Denied, or the person pressed Don't allow                 |
| `NO_ANSWER_ON_DEVICE`    | "No one answered on Studio Mac in time. Calendar is not allowed yet."                          | The card was pending when the call's limit came                      |
| `TURNED_OFF_IN_SETTINGS` | "Calendar is turned off for Clawtrate in Studio Mac's System Settings."                        | The operating system refuses Clawtrate                               |
| `TURNED_OFF_ON_DEVICE`   | "Calendar was turned off on Studio Mac while this request was answered."                      | Turned off, or the node stopped, during a request                    |
| `NOT_OPEN_ON_DEVICE`     | "Clawtrate isn't open on iPhone, so no one could be asked. Ask again when it is open."         | The iPhone app is in the background (section 9)                      |
| `NOT_SERVED`             | "Studio Mac doesn't answer this request."                                                     | A command Clawtrate doesn't serve, or parameters it doesn't accept   |
| `UNAVAILABLE_ON_DEVICE`  | "Calendar couldn't answer on Studio Mac."                                                     | The app itself failed                                                |

The gateway's own words reach the bot in the same way when the gateway refuses before this device is asked: "node command not allowed: … is not in the allowlist", "node not connected", "TIMEOUT: node invoke timed out", "POLICY_CHANGED: node command is no longer allowed" (research §3.1, §6). On the person's other devices, the bot's call is an ordinary action card (`conversation.md` §8.3) whose failed state shows that message as given; this design doesn't change it.

## 9. The phone in the background

The iPhone answers requests only while Clawtrate is open (F-384). The gateway has a queue for an iPhone in the background, but it never holds a bot's call, only an operator's, and only for camera, screen and talk commands, none of which Clawtrate offers (research §5). So:

- **While Clawtrate is in the background and still connected**, every request is refused at once with "NOT_OPEN_ON_DEVICE". Nothing is queued and nothing is answered later.
- **Once the operating system suspends it**, the socket closes and the gateway reports the device not connected; a bot that asks is told "node not connected". Clawtrate does not register for wake-up pushes in this version.
- **When the person opens Clawtrate again**, a grey event line at the top of the task each request named, or in "Requests for this device": "While Clawtrate was in the background, Otto asked this iPhone for your location at 5:41 PM. Otto was told Clawtrate wasn't open." Only requests this device received are listed. Under the list, once: "Requests made while this iPhone wasn't connected never reached it; the bot was told the device wasn't connected."
- This iPhone's state line reads "Connected while Clawtrate is open" and, in the background, the gateway's "Last seen".

## 10. Other devices asking to be used by bots

Settings, Machines (`controls.md` §15) gains one block above "Paired devices", for admin: **"Devices asking to be used by bots"**. It lists both kinds of request (research §1.5), newest first, each with what the device wrote about itself, as data:

- A new device: "Kitchen iPad asks to be a device bots can use", "iPadOS, asked 5:20 PM". "Approve" and "Reject" (`device.pair.approve`, `device.pair.reject`).
- A device's commands: "Kitchen iPad asks to offer: Location, Calendar" with the command names in mono under the words, and its reported permissions. When it lists any command that needs admin (`requiredApproveScopes` includes `operator.admin`: the system, browser and file commands), the row says so in `--warn`: "It also offers commands that run programs or read files on it: `system.run`, `fs.listDir`." "Approve" and "Reject" (`node.pair.approve`, `node.pair.reject`).

Approve opens a confirmation naming exactly what the request lists: "Approve Kitchen iPad for bots? Bots that can use other devices will be able to ask it for Location and Calendar. What the device does with a request is up to the device." With admin-tier commands: "…and to run programs and read files on it." Approved and rejected are said only once the list reads back without the request.

The block is fed by `device.pair.requested` and `node.pair.requested`, which every device with device access hears for every device (research §1.6), and read with `device.pair.list` and `node.pair.list`, which give a connection without admin only its own device. So below admin the block is one line, "Approving other devices for bots needs admin access.", with the admin request, and never a list: an event is a prompt to read again, and the read would show nothing.

## 11. The share sheet

On the iPhone, "Clawtrate" in the share sheet opens Clawtrate's own sheet over the sharing app (F-245):

- **To**: the primary bot, its picture and name, from the person's `clawtrate.primary` preference, or the gateway's default bot when there is none or the bot is gone (the design on `d6-bots-lifecycle-design`, section 3). Tapping it lists the bots this device last read, as a radio list.
- **The items**, as chips: a link as its full address in text (never fetched, no preview), a file with its name and size, a picture as a thumbnail drawn on the phone from the shared bytes. An item over the composer's limits (F-074) is marked "Too large to send" and can't be sent.
- **"Add a note"**, the message field.
- **Send** (primary) and Cancel.

**What Send does, exactly**: one new task with the To bot, `sessions.create {agentId, message}` with the note as its message, and the items through the composer's attachment path (F-284), from this iPhone's paired connection, at the moment Send is pressed. Nothing is sent before. "Sent to Juniper" shows only after the gateway answers with the task; the sheet then closes, and the task is in Juniper's list.

**When the sheet can't finish** (F-406): no gateway saved, the connection is read-only, the gateway doesn't answer within 10 seconds, or an item is too large. The sheet says which, in one line ("Clawtrate can't reach the gateway from here." / "This iPhone's connection is read-only. Sending needs the interactive tier."), with **"Open in Clawtrate"**: Clawtrate opens on a new task with the To bot and the note and items in its composer, unsent, where the person sends it or not. What is in the composer is a draft on this device until then.

## 12. Siri and Shortcuts

Two actions (F-246):

- **List Bots** reads `agents.list` and returns the bots' names in the gateway's order, the primary bot first. Siri says "You have four bots: Juniper, Marlow, Otto and Pip." When the gateway can't be reached: "Clawtrate couldn't reach the gateway." with no list: a list from memory would pass for current.
- **Send Message** takes a bot (the primary bot by default) and the message. Before anything is sent, it always shows the bot and the whole text and asks "Send to Juniper?" with Send and Cancel. On Send: one new task, `sessions.create {agentId, message}`, as the share sheet. "Sent to Juniper." only once the gateway answered. When it can't (read-only, not reachable, no gateway saved): "Clawtrate couldn't send this: <reason>." with "Open in Clawtrate", which puts the message in a new task's composer, unsent.

Neither action works on a bot's or the gateway's say-so: they run only when the person runs them, and the gateway's answers are shown as data.

## 13. What the gateway's facts drive

| Fact                                                                                                                                     | Source (research) | Shown                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| A node's first connect is a device request, `requestedRole: "node"`; only admin or the gateway's computer approves it                     | §1.1, §1.2        | Section 4, step 2: the command, or "Approve this Mac" for admin; "Cancel request"     |
| `device.pair.reject` of one's own request works without admin                                                                             | §1.2              | "Cancel request"                                                                      |
| The command surface: `node.pair.requested`, `requiredApproveScopes`; own device at pairing and write approves                             | §1.1, §1.2        | Section 4, step 3; "Approving this Mac's commands needs device access"                |
| One device: a waiting node request merges with a new operator request                                                                     | §1.3              | The two rules of section 2; "Request access" unavailable while it waits               |
| Loopback with the default: device and first surface approved silently                                                                     | §1.4              | "The gateway approved this Mac by itself…"                                            |
| A declared command outside the lists is dropped silently; `node.describe` reads back what was kept                                        | §2.2              | "On the gateway" from the read-back; "Not offered: the gateway's allowlist doesn't include it" |
| Platform defaults; nothing for Messages, Mail or Notes                                                                                    | §2.1              | Which rows need the owner                                                             |
| `gateway.nodes.commands.allow`: admin to write, read to read; `replacePaths` to remove                                                     | §2.3              | Section 6's steps and removal                                                         |
| `node.invoke.request` with `timeoutMs` (30 000 by default) and, sometimes, `sessionKey`                                                    | §3.1              | The card's deadline; the bot named or not; where the card goes                       |
| A refusal reaches the caller as `"<code>: <message>"`; a late answer is `ignored`; a node gone is `NOT_CONNECTED`                          | §3.1              | Section 8's words; the card's "nothing reached Otto"                                  |
| `permissions` don't admit a call; a newly granted one asks for approval again                                                              | §4.1, §4.2        | "This device enforces this"; "A change waits for approval"                            |
| No five minutes, no hour, no re-run in the gateway                                                                                        | §4.3              | The card's five minutes are this device's; nothing runs again                         |
| The background queue excludes a bot's calls; 10 minutes, 64                                                                               | §5                | Section 9: refuse at once, list on return                                             |
| Removing an allowlist entry ends a waiting call `POLICY_CHANGED`; removing a node needs admin                                              | §6                | Section 6's taking back; section 5's Stop                                             |
| Pairing-scope devices hear every device's requests, list only their own                                                                    | §1.6              | Section 10: admin only, one line below                                                |
| `agents.list` `defaultId` and `users.prefs` at read; `sessions.create` at write                                                            | §7                | Sections 11 and 12                                                                    |

## 14. Parity rows

Every target in `docs/parity.md` stands as written. This design rewords dependency cells only, with statuses unchanged:

- **F-185, F-223, F-347, F-348, F-384, F-385, F-451 and F-452**: the shared sentence about pairing becomes the two approvals, with the device request needing admin or the gateway's computer and the silent loopback pairing including the first command surface (research §1).
- **F-245**: the primary bot is the preference of the bots-lifecycle design, falling back to `defaultId`, and a new task is `sessions.create` (live, research §7).
- **F-246**: Send Message is `sessions.create` (live).
- **F-452**: what remains is this device's own permission store; nothing in the gateway runs a call again (research §4.3).

**Rows that need a decision** (left as they are; the report proposes wording):

- **F-451**: its target asks that allowing within an hour re-evaluates and runs the original device operation once, and the card reads "Resumed". Nothing can: the gateway doesn't re-deliver a call or queue a bot's, and a node can't start a bot's turn (research §4.3, §5). This design saves the permission and runs nothing; a later request passes the gateway's checks then, which covers the row's "Blocked by policy" variant for the new call.
- **F-348**: its target says the bot "continues without the phone app and says so". The card reads Timed out after five minutes and the bot is told at once why it got nothing (section 8); what the bot then says is the bot's.

Each row's check, in the prototype check and later in the app:

| Row   | Check                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------- |
| F-185 | A request for an undecided app shows the card with Allow; Allow while the call is open answers it                          |
| F-223 | This iPhone lists Calendar, Contacts, Location, Reminders, Alarms and Home, each with Allow, Allowed or Denied            |
| F-347 | An app turned off by the operating system: the card and the row offer Open Settings and no Allow                           |
| F-348 | Five minutes with no answer: the card reads Timed out; the bot was told `NO_ANSWER_ON_DEVICE`                            |
| F-384 | In the background the iPhone refuses with `NOT_OPEN_ON_DEVICE`; on return the list says what was refused                  |
| F-385 | This Mac lists Messages, Mail, Notes, Reminders, Calendar, Location and Contacts, each with its own Allow                  |
| F-451 | (unmet as written) Allowing after the call ended runs nothing and says so                                                 |
| F-452 | Allowing more than an hour later saves the permission; the next request is answered; nothing else is sent                 |
| F-245 | The share sheet shows the primary bot in To, Add a note and Send; Send makes one task                                      |
| F-406 | When it can't send, "Open in Clawtrate" opens the composer with the items, unsent                                         |
| F-246 | List Bots returns the names; Send Message asks first, then makes one task                                                  |

## 15. For builders

### What each part uses

| Part                         | Existing components                                                             | New                          |
| ---------------------------- | ------------------------------------------------------------------------------- | ---------------------------- |
| This Mac, This iPhone        | Settings frame, switch, fact block, note, access bar, command block, step list | `.d-app`, `.d-state`         |
| The owner's choice           | Confirmation, step list, access bar                                            |                              |
| The permission card          | The approval card's frame, Raw, event line                                     | `.d-ask`                     |
| Machines' block              | Fact block, confirmation                                                       | `.d-app` (as a request row)  |
| The share sheet, Siri        | The composer's attachments                                                     | `.d-share`, `.d-sys` (stand-in) |

### What the host does

- **The node connection** lives in the host (Electron's main process; the iPhone app's own process), never in the renderer, with the same device key as the operator connection, `role: "node"`, `client.id: "node-host"`, `mode: "node"`, the platform and device family, the fixed list of commands of section 5 for that platform, and the permissions this device holds. It starts only under section 2's rules, and only after the host's confirmation.
- **Its answers** come from code of Clawtrate's own for each command: no command is passed to a shell, no program is started, and no parameter becomes a path, an address or a program's argument without the command's own checks. Unknown commands and parameters are refused `NOT_SERVED`.
- **The card's clock**: the request's arrival plus `timeoutMs` for the call, five minutes for the card, both on this device's monotonic clock.
- **Its own approval** compares the surface request's commands and permissions with what it declared before calling `node.pair.approve`.

### What the engine supplies

- This device's node state from `node.describe` and `node.pair.list`, re-read on `node.pair.requested`, `node.pair.resolved` and `device.pair.resolved`, and every 60 seconds while the page is open.
- For each app: what this device declared, what the gateway read back, and the local permission, kept apart.
- Which bots are offered the tool for other devices, from `controls.md`'s "Offered" fact with its date.
- The primary bot from `users.prefs` and `agents.list`, as the bots-lifecycle design supplies it.

### Order

1. **Prove on a development gateway first**, with a stand-in node as in research §1: the two approvals, the own-device approval, the merge rule's guard (no node request while an operator request waits, and the reverse), `device.scopes.requestUpgrade` while a node request waits.
2. The node connection in the host with the fixed command list and the refusal words of section 8, answering nothing else. Check F-384's refusal.
3. This Mac and This iPhone, read back. Check F-223, F-385.
4. The permission card and its clocks, on fake time. Check F-185, F-347, F-348, F-452, and F-451's part.
5. The owner's choice with admin. Check F-385's Messages, Mail and Notes.
6. Machines' block. 
7. The iPhone: background refusals and the return list; then the share sheet and the two actions, each first proved on a device: that a share extension can use the paired credential through a shared keychain, that it can open the app, and that the App Intent's confirmation shows before sending. Check F-245, F-406, F-246.

### Prototype states

`prototype/device.html?screen=<id>`, with the shared `theme`, `width`, `motion` and `chrome` parameters, and `access` (`read`, `write` for the interactive tier, `pairing` for the interactive tier with device access, `admin`, the default). `width=phone` shows the iPhone's screens.

| Screen                      | What it shows                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `mac-off`                   | This Mac, off; with `via=silent` the walk passes the approvals by itself                              |
| `mac-confirm`               | The host's confirmation for turning it on                                                             |
| `mac-waiting-device`        | Waiting for the owner: the command (below admin) or "Approve this Mac" (admin)                        |
| `mac-waiting-surface`       | Approving its commands: by itself (`access=pairing` or `admin`), or the device access bar             |
| `mac-on`                    | The apps, both facts each; `via=silent` adds the silent-pairing line                                  |
| `mac-messages-confirm`      | The owner's choice, admin                                                                             |
| `mac-messages-steps`        | Its steps; `fail=2` stops at step 2                                                                   |
| `mac-messages-needadmin`    | Below admin                                                                                           |
| `mac-messages-on`           | Messages offered and allowed, with its menu                                                           |
| `mac-messages-remove`       | Removing it from the allowlist                                                                        |
| `mac-stop`                  | Stopping, with "Also remove it from the gateway" for admin                                            |
| `mac-offline`, `mac-removed` | Not connected; removed by the owner                                                                   |
| `mac-request`               | A request that named no task, in "Requests for this device", with the banner                          |
| `machines`                  | Devices asking to be used by bots, admin; `access=write` shows the one line                           |
| `phone-on`                  | This iPhone                                                                                           |
| `card-pending`, `card-sent`, `card-ignored`, `card-dontallow`, `card-ended`, `card-later`, `card-timedout`, `card-settings` | The permission card's states |
| `phone-back`                | Back from the background                                                                              |
| `share`, `share-to`, `share-sent`, `share-cant`, `share-draft` | The share sheet, choosing the bot, sent, can't finish, the composer it opens |
| `siri-list`, `siri-list-fail`, `siri-confirm`, `siri-sent`, `siri-fail` | The two actions                                             |

The check walks: turning on to `mac-on` below admin and with admin, and silently; cancelling the request; the owner's choice to `mac-messages-on`, and its failure at step 2; below admin; turning Messages off and removing it; stopping; approving and rejecting another device; the card from pending to each outcome; the share sheet to sent, to another bot, and to "Open in Clawtrate" and the draft; Send Message to sent and to its failure.

## 16. Not covered here

- What each command returns, its parameters and their checks: each command's own build issue. This design fixes which commands exist and how they are refused.
- Approval cards, their timing and who receives them: `controls.md` and `conversation.md`. The permission card borrows only the frame.
- A bot's tool for other devices as a line of its permissions: `controls.md` §4 lists it under "Anything else".
- Wake-up pushes for an iPhone in the background (APNs), and the gateway's queue for camera, screen and talk.
- Commands that run programs, read files, use a browser or record the screen on this device: never offered by this design.
- Links into the app (#80), and files in a chat beyond handing them to the composer (F-284, #54).
- Approving for the person on the gateway's computer from Clawtrate: `setup.md` §9 keeps that manual.

Cut because nothing proven supports them:

- **Running a request again after a late Allow, once** (F-451): nothing in the gateway re-delivers a call, the background queue never holds a bot's call, and a node can't start a bot's turn (research §4.3, §5).
- **A permission for one bot only**: the gateway's allowlist and a node's commands are for every bot, and the node knows the asking task only sometimes (research §2.3, §3.1). Which bots can ask is each bot's own tool permission.
- **Telling the bot after a late Allow**: it would be a message the person didn't write. The person writes one if they want.
