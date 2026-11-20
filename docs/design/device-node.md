# This device for bots: the node, the share sheet, Siri and Shortcuts

How the Mac or the iPhone Clawtrate runs on becomes a device a bot can ask for things, such as a calendar, a location or the person's Messages, and how things come into Clawtrate from the rest of the phone. The gateway calls such a device a **node**. This part of the design comes after `visual-language.md`, `conversation.md`, `bots.md`, `work-pane.md`, `controls.md` and `setup.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`: F-185, F-223, F-347, F-348, F-384, F-385, F-451 and F-452 for the device, and F-245, F-246 and F-406 for the share sheet, Siri and Shortcuts. What the gateway does is in `docs/research/device-node.md`, from OpenClaw 2026.10.6's source and from live runs against a development instance with stand-in nodes; every state below names the fact it rests on, and section 13 lists them. Section 15 is for builders.

A node is a device any caller the gateway admits can send commands to, so three rules sit above the rest:

1. **Nothing is done on this device for an app the person has not allowed on this device.** The gateway admits a call by its own lists and never looks at what the device says it allows (research §4.1), so this device keeps its own permission for each app, refuses everything else itself, and checks that permission again just before it acts and just before it answers.
2. **This device does not know who sent a request, or from which chat.** A request carries a command, its parameters, a deadline and, sometimes, a task's key that the caller chose (research §3.1, §7.1). The screen says what the request named, as the request named it, and never who asked.
3. **No screen says more than the gateway or this device established at that moment.** What the gateway lists is said with the time it was read; what this device did is said as what it did; what a caller received is never said, because this device cannot see it.

And Clawtrate's node never offers a command that runs a program, reads or lists files, uses a browser, or records the screen: it declares only the commands of section 5, each served by Clawtrate's own code.

The prototype shows all of it: `prototype/device.html`, with the state in the address (section 15). The styles are in `prototype/css/device.css`, the behaviour in `prototype/js/device.js`, and `prototype/tools/checks/device.mjs` clicks through every walk and asserts each state's words and structure.

## Contents

1. How the pieces fit
2. Shared rules: what holds what, the node's own key and credential, access, words, components, input
3. This Mac and This iPhone, off
4. Turning it on
5. What this device offers
6. An app outside the defaults: the owner's choice
7. A request on this device: the permission card
8. What this device sends back, and what it records
9. Stopping, taking back, and the phone in the background
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
  turning on                           the host's confirmation; the node-only code; the read-back (section 4)
  on                                   each app: on this device, and listed by the gateway (section 5)
    Messages, Mail, Notes (Mac),         the owner's allowlist, admin, and the words before the choice (section 6)
    Alarms, Home (iPhone)
  Requests to this device              every request this device received and what it did (section 8)
Settings, Machines                   Devices asking to be used by bots, for admin (section 10)
the task a request named, if listed  the permission card (section 7)
the bot's own task, anywhere         the bot's action card for its call, as conversation.md draws it
iPhone, outside the app              the share sheet (section 11); List Bots and Send Message (section 12)
```

The desktop and the iPhone have the same page with the same parts; only the name, the apps and the background rules differ. The page is a Settings section in the frame of `bots.md` §7, placed after Machines (`controls.md` §15), whose title is its `h3`. On the iPhone the frame is one pane: the section fills the width, with "Settings" as Back.

## 2. Shared rules

### What holds what

| Held by                        | What                                                                                                                                                | How it shows                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **The gateway**                | Whether the node is paired and connected; which of its commands the gateway listed; the owner's allowlist; which bots' latest tasks listed the tool | Read back, each with its time: `node.describe`, `config.get`, a bot's tools (`controls.md` §2) |
| **This device**                | Whether each app is allowed for bots here; each request it received, what it did and what the gateway acknowledged                                  | Clawtrate's own store on this device, and the operating system's own permission for Clawtrate  |
| **This node cannot establish** | Who sent a request, from which chat; what a caller received; running a request again; what a bot says afterwards                                    | Not shown. Section 7 and section 8 say what is shown instead                                   |

**Marks.** Three marks, each with one meaning:

- **"Listed by the gateway, [time]"** (the eye icon of `controls.md` §2's "Offered" fact) for confirmed listings: a command in `node.describe`, an entry in the allowlist, a bot's latest listing. It says what a read showed then; it promises nothing about the next call.
- **"The gateway refused this request"** (the approval icon) only on an observed refusal. A command absent from a listing carries no refusal mark: absence is what a read showed, not a refusal.
- **"This device refuses this"** (the device icon) only on a Denied or OS-blocked row. It holds while Clawtrate runs on this device, and nowhere else. An undecided row says it will ask, and an Allowed row carries no refusal mark.

### The node's own key and credential

Clawtrate's node is **a device of its own on the gateway**, with a key of its own that the host makes and keeps, beside this device's operator connection (`setup.md`). Clawtrate declares the name ‘Studio Mac (bots)’. On the connected page use the name the gateway lists. It never shares the operator's key: on the operator's key, the gateway turns a node credential into a request to add a role and spends it (research §1.7).

**Its credential is a node-only setup code from an admin connection** (research §1.7, live):

1. The operator connection, holding admin, calls `device.pair.setupCode {bootstrapProfile: "node", includeQr: false, publicUrl: <the currently authenticated gateway WebSocket URL>}`. The gateway answers with a code for the node role only, no operator scope, valid 10 minutes and once. On a token-authenticated loopback development gateway, admin requested a node-only code with `publicUrl` set to the current gateway URL. Read and write plus pairing were refused for scope. A fresh node key presenting the code paired and its approved commands were read back.
2. Require `access:"node"`, a usable unexpired code and the same normalized address. Use the host's existing route, endpoint and TLS policy for the sole connection attempt, at the same host connection generation. Reject a reply that selects a different endpoint. Keep the code in the host. It is never shown, stored or logged; nothing in the renderer sees it. The host uses its bootstrap token at once, on the node's own key.
3. The gateway pairs the node in the node role and approves its first command surface without a further approval: the admin who asked for the code is that approval.
4. The gateway gives the node its own device token, which the host keeps in its secure store, tied to this gateway's address and to the node role. It reconnects on that token alone.

Only admin can get a new node sign-in. A device with a saved node sign-in can reconnect on it without admin. Below admin, with no saved node sign-in, turning it on is unavailable (section 4). Nothing else gives this device a node credential: it never reads or asks for the shared token (`setup.md`), and no route through the gateway's own computer is designed here (research §1.7).

**Recovery.** When the gateway refuses the node's token (`AUTH_DEVICE_TOKEN_MISMATCH`, a revoked or removed node), the node stops, and the page says "The gateway refused this Mac's device sign-in." Turning it on again makes a new key and asks for a new code, with explicit admin access. Show the previous node entry in Machines if a successful gateway read lists it. A sign-in refusal alone doesn't establish whether the entry was revoked or removed.

**One node per gateway per host.** The host runs one node connection for a gateway, never two. The gateway keeps one connection per key and replaces an older one with a newer (`<openclaw>/dist/node-registry-BDoE1KtJ.mjs` lines 371-375 and 430-434, source), so the page states two facts, each on its own evidence: "This host's node socket has a hello." when it does, and "The gateway listed Studio Mac (bots) as connected at 5:31 PM." when `node.describe` says so. The shipped registry unregisters a previous slot on a replacement without closing that socket in `unregister` (`node-registry-BDoE1KtJ.mjs:430–469`). An older hello plus a fresh listing for the key cannot establish which socket has that slot. Keep the host singleton and keep "This Mac can be used by bots" out of the live region. Announce the confirmed listing. "Not connected" shows the moment the host's socket closes, whatever the reason.

**The node reports no permissions.** The gateway does not use them (research §4.1), and a permission reported as newly granted would open a new request for approval (research §4.2). This device's permissions stay on this device.

### Access

A connection is judged by the scopes the gateway granted it, as in `controls.md` §2. The node connection holds no operator scope.

| What                                                    | Needs                                                | Below it                                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| See this page, the gateway's lists, this device's state | Read (`node.describe`, `config.get`)                 | —                                                                                                                                       |
| Turn the node on with a new sign-in (a node-only code)  | Admin (`device.pair.setupCode`)                      | "Letting bots use this Mac needs admin access: only an admin connection can get this Mac's device sign-in." with "Request admin access" |
| Turn it on again with this device's saved node sign-in  | The saved sign-in; the gateway's read-back           | —                                                                                                                                       |
| Turn the node off, turn an app off, on this device      | Nothing from the gateway; the host acts first        | —                                                                                                                                       |
| Allow an app on this device                             | Nothing from the gateway; the person, on this device | —                                                                                                                                       |
| Add an app outside the defaults to the allowlist        | Admin (`config.patch`, `node.pair.approve`)          | "Adding it to the gateway's allowlist needs admin access."                                                                              |
| Remove the node, or another device, from the gateway    | Admin (`node.pair.remove`)                           | "Removing it from the gateway needs admin access."                                                                                      |
| See and approve other devices asking to be used by bots | Admin                                                | "Approving other devices for bots needs admin access."                                                                                  |
| Share into Clawtrate, Send Message                      | Write (`sessions.create`)                            | The share sheet's and the action's own known no-send (sections 11, 12)                                                                  |
| List Bots                                               | Read (`agents.list`)                                 | —                                                                                                                                       |

Admin is the explicit request of `bots.md` §2; the page stays as it was if it is denied.

### Words

- The page never says "safe", "secure", "private" or "protected", never "your own chat", and never names who sent a request. What this device does is said as what it does: "Clawtrate asks you before an app's first use", "This device refused it".
- **Allow is ongoing.** There is no "Allow once". Every Allow, on a card or on a row, allows that app for every later request that reaches this device, from any caller the gateway admits, until the person turns it off; the words say so before the tap.
- Device names, bot names, task names, command names and everything in a request are data from the gateway or from whoever sent it: shown as text, never as markup or links, in mono where they are names, bounded in length with the whole value in Raw. A request's parameters are shown, never followed: an address in them is text, as `docs/decisions.md` ("Addresses a gateway hands the client") has it for everything a gateway relays.
- What a person sees about a request is what this device received and did. A request that never reached it is never described as if it had.

### Components used

| Component                                                                 | From                                  | Used for                                                       |
| ------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| Settings frame, its sections, Back                                        | `bots.md` §7                          | This Mac, This iPhone (one pane); Machines' block              |
| Fact block (`.facts`), group word, note (`.b-note`), switch (`.b-switch`) | `visual-language.md` §9, `bots.md` §2 | Every page                                                     |
| The access bar and its request                                            | `bots.md` §2, `conversation.md` §3    | Admin                                                          |
| The host's confirmation                                                   | `setup.md` §2                         | Turning the node on                                            |
| Step list (`.s-steps`)                                                    | `setup.md` §2                         | Turning on; adding an app                                      |
| Confirmation (`role="alertdialog"`)                                       | `bots.md` §2                          | Adding and removing an app; stopping; approving another device |
| The approval card's frame                                                 | `conversation.md` §12                 | The permission card's frame only (section 7)                   |
| The mark (`.c-mark`)                                                      | `controls.md` §2                      | The three marks above                                          |
| The composer and its attachments                                          | `conversation.md` §15, F-284          | What the share sheet and Send Message hand over                |

### New components

Each is defined once, in `prototype/css/device.css`, from existing tokens. No colour token is added.

| Component                               | What it is                                                                                                                                                                                                                           | Tokens                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| App row (`.d-app`)                      | One app this device can offer: its 32 px glyph, its name (15/500), and two fact lines under it (13), "On this Mac: …" and "Gateway: …", each with its mark; at the right its value word and its action. 64 px or taller, 72 on touch | `--bg-bubble`, `--text-faint` |
| State line (`.d-state`)                 | The node's state in one line with a dot: connected (`--accent-line`), waiting (`--warn`), not connected (`--text-faint`), refused or removed (`--danger`), and its time                                                              | `--accent-line`, `--warn`     |
| Permission card (`.d-ask`)              | The approval card's frame (`--warn-line` outline while it waits, a 17 px title, a tag, buttons along the foot) with the tag "Needs permission" and a deadline line                                                                   | `--warn-line`, `--warn-soft`  |
| Request record (`.d-record`)            | One row in "Requests to this device": time, app, command in mono, the task as named, what this device did, what the gateway acknowledged                                                                                             | `--bg-bubble`                 |
| Share sheet (`.d-share`)                | The iPhone share sheet's Clawtrate view: a To row, the items as chips, the note field, Send; drawn as a sheet over a stand-in of the sharing app                                                                                     | `--bg-raised`, `--shadow-pop` |
| System panel (`.d-sys`, prototype only) | The prototype's picture of Siri's or Shortcuts' panel. It is a stand-in; the phone draws its own                                                                                                                                     | `--bg-raised`                 |

### Input

- A switch is a `switch` role with its label; changing it opens the host's confirmation or a confirmation first where the section says so, and nothing is announced until the read-back agrees.
- An app row is a group named for its app; its two fact lines and its actions are read in that order; each action is named for its app ("Allow Calendar", "Turn off Messages").
- Request actions (Allow, Don't allow, Approve, Reject, Stop, Send) are buttons; going somewhere is a link.
- The permission card does not take focus when it arrives; it is a `region` named "Location requested on this iPhone. Needs permission." Escape does nothing to it.
- A dialog, the share sheet and the system panel take focus on their title, keep Tab and Shift+Tab inside, make everything behind them inert, and close on Escape with their Cancel.
- The share sheet's bot list is a radio group: one tab stop, Up and Down move and choose.
- One polite live region announces: "The gateway listed Studio Mac (bots) as connected at 5:31 PM.", "Calendar allowed", "Messages turned off", "Stopped on this Mac", "Sent to Juniper", and the access request's own phrases.

## 3. This Mac and This iPhone, off

Settings, **This Mac** (on the iPhone, **This iPhone**), the first time and whenever the node is off:

- The switch row: "Let bots use this Mac", off. Under it (13, muted): "Bots, and other devices connected to the gateway with write access, could then send this Mac requests for the apps you allow below. Clawtrate asks you before an app's first use."
- **"Bots offered the tool in their latest listed tasks"**, read from each bot's tools (`controls.md` §2, the "Offered" fact): "Otto (listed Nov 19). Juniper and Marlow: not offered (listed Nov 18, Nov 19). Pip: no listing yet." with "Open a bot's permissions" and the listing mark. Only when every bot has a listing and none shows the tool: "The latest listings did not show a bot with the tool." On the development gateway every bot is denied it. A bot's listing changes when its setup changes or it runs again; the line says what the listings showed, not what a bot can do next.
- The apps it would offer (section 5), shown and disabled, each with "Off".
- **What this Mac never offers**, a short fixed block: "Clawtrate never lets a bot run programs, read or list files, use a browser or record the screen on this Mac. Those commands exist on the gateway; this Mac doesn't offer them." The gateway's own lists include such commands for desktops (research §2.1), so this is said, not implied.

Facts under the apps: "Device name: Studio Mac (bots)" (the name the gateway will list it under), and "Gateway: devbox, OpenClaw 2026.10.6".

## 4. Turning it on

**Below admin**, with no saved node sign-in, the switch is unavailable, with the line of section 2's access table and "Request admin access". Nothing is sent.

**With a saved node sign-in** (after Stop, which keeps it), branch before requesting a code. After local confirmation ("Clawtrate will connect with this Mac's saved device sign-in. The next screen shows what the gateway listed."), "Connecting with this Mac's saved device sign-in" uses the saved key and token, then performs the same `node.describe` read as step 3 below. Until that read succeeds the local request fence stays closed. If the gateway refuses the token, present the existing sign-in refusal and the new-key recovery with explicit admin access (section 2). No code is requested on this path, at any access.

**With admin**, turning the switch on shows the host's own confirmation (`setup.md` §2): **"Let bots on devbox use this Mac?"**, detail: "Clawtrate will ask the connected gateway for a one-time sign-in for this Mac as a device for bots. The next screen shows what the gateway listed. It offers Location, Contacts, Calendar and Reminders (`location.get`, `contacts.search`, `calendar.events`, `reminders.list`). Clawtrate asks you before an app's first use. Later requests that reach this device may use an app you allowed without asking again." The commands named are exactly what the node declares. Cancel leaves the switch off and nothing is sent.

Then a step list (`setup.md`'s `.s-steps`), each step done only on its positive read-back:

1. **"Getting this Mac's device sign-in"**: `device.pair.setupCode` with `publicUrl` (section 2). Done when the gateway answers with a usable, unexpired code whose `access` is `node` for the same normalized address.
2. **"Connecting as a device for bots"**: the node connects on its own key with the code. Done when its hello says `role: "node"`.
3. **"Reading back what the gateway lists"**: `node.describe` for the node. Done when it reads `paired: true`, `approvalState: "approved"`, `connected: true`, and a command list that is a subset of what this Mac declared. Then the page shows section 5.

What each other read-back leads to, in place of the step:

| Read-back                                                        | The words                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Step 1 refused for missing admin                                 | Only a missing-admin response says "The gateway didn't give this Mac a device sign-in: it needs admin access." The switch stays off                                                                                      |
| Step 1, any other failure                                        | "Couldn't get this Mac's device sign-in." Show the supplied reason as text when available, using the underlying gateway error as text for other refusal reasons. Switch stays off, with "Try again"                      |
| Step 2 with no answer                                            | Close the local attempt before offering "Try again". Say "This Mac stopped trying to connect. The gateway pairing couldn't be confirmed." Retry begins with a fresh bootstrap only if there is no valid saved node token |
| Step 2: `PAIRING_REQUIRED`, or the code refused                  | "The gateway didn't pair this Mac with the code." with the gateway's reason as text, and "Try again"                                                                                                                     |
| Step 3 can't be read                                             | "Couldn't read what the gateway lists." Offer Check again, with no local dispatch while initial activation is pending                                                                                                    |
| Step 3: the commands wait for approval (`approvalState` pending) | A proved pending command request shows only the pending commands. With admin: the host compares the request as below, then "Approve its commands" (`node.pair.approve`)                                                  |
| Step 3: the list is a strict subset of what this Mac declared    | If a read lists a strict subset, show the named omissions and finish using that confirmed subset; each app it lacks reads as section 5 says                                                                              |
| Step 3: the list has a command this Mac didn't declare           | If the list contains anything outside the fixed declaration, close this node's connection and say so: "The gateway lists commands this Mac doesn't offer. Clawtrate disconnected it." with the commands as text          |

While connecting, the switch is not checked; each step's done mark follows its own read.

A first-time activation starts every local app grant at Not decided unless the operating system has already refused access. Pairing never creates a local Allow. A reconnect keeps any evidenced prior grant.

**Comparing a request before approving it.** Whenever this device approves a command request for its own node (here, and in section 6), the host first reads the request and its current declaration. It approves only if the request's commands are among the declared ones, and names any declared command the request leaves out as "not in the request". Compare the pending request and current declaration again before sending `node.pair.approve {requestId}`. Stop if the visible snapshot changed: "The pending request changed since Clawtrate read it. Clawtrate approved nothing." with what differs. Re-read the resulting commands and disconnect this node if any exceeds its declaration. The RPC does not take an expected command list, so approving is never taken as listing.

## 5. What this device offers

The page once the node is on. At the top, the state line, from the host's connection and `node.describe`, each read with its time:

| State            | From                                                                            | The line                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Connected        | The host's own connection has its hello; `node.describe` `connected: true`      | Two facts: "This host's node socket has a hello." and "The gateway listed Studio Mac (bots) as connected at 5:31 PM."          |
| Commands waiting | `node.describe` `approvalState` not approved, or a pending surface for the node | "A change of its commands waits for approval: Messages." with section 4's comparison                                           |
| Not connected    | The host's socket is closed                                                     | "Not connected. Clawtrate is trying again." The gateway's own view, once read: "The gateway last saw it at 5:02 PM (connect)." |
| Sign-in refused  | The gateway refused the node's token                                            | "The gateway refused this Mac's device sign-in. Turn it on again to get a new one." The switch reads off                       |
| Not listed       | `node.describe` answers `unknown nodeId`                                        | "The gateway no longer lists this Mac as a device for bots." The switch reads off                                              |
| Couldn't read    | The read failed                                                                 | "Couldn't read the gateway. Last read 5:31 PM." Nothing else on the page changes                                               |

Then **the apps**, one app row each, in this order. On the desktop: Location, Contacts, Calendar, Reminders, then Messages, Mail and Notes (F-385). On the iPhone: Calendar, Contacts, Location, Reminders, then Alarms and Home (F-223). Each row has two lines:

- **"On this Mac"** (this device refuses what isn't allowed), its value word and its action at the right:
  - **Not decided**, with "Allow" (named "Allow Calendar"): the row says "Clawtrate asks you first", and the first request asks with the permission card (section 7). Under the row, before the tap: "Allow lets every request for Calendar that reaches this Mac read your calendar's events, from now on, until you turn it off." Allow then sets Allowed at once, after the operating system's own question where it has one.
  - **Allowed**, with "Turn off": requests for it are answered.
  - **Denied**, with "Allow": the person chose Don't allow, here or on a card, or turned it off. Requests are refused at once (section 8). The same sentence under the row discloses what Allow lets through before the tap.
  - **Turned off in System Settings** (on the iPhone, "in Settings"), with "Open Settings" (F-347): the operating system refuses Clawtrate. Clawtrate can't ask again; only the person can, there.
- **"Gateway"**, from `node.describe` `commands`, never from what Clawtrate declared, with the listing mark and its time:
  - **"Listed, [time]"** only for a complete set of the app's commands.
  - **"Listed, [time]: [commands]"** on a partial read, with the missing commands named.
  - **"Waiting for approval"** while a surface for the node is pending.
  - **"Not listed when read at [time]"** on an empty read. The gateway drops what its lists don't allow without saying why (research §2.2), so the row gives no reason it wasn't told. Show "The gateway's allowlist didn't include [command] when read at [time]" only for entries read as absent.

The two lines are separate gates and neither sets the other: a request is answered only when the gateway delivered it and this device allows the app.

The first four apps on each platform are among the gateway's defaults (`location.get`, `contacts.search`, `calendar.events`, `reminders.list`; research §2.1). Messages, Mail, Notes, Alarms and Home are commands of Clawtrate's own, which no default allows (section 6).

Under the apps: **"Requests to this device"** (section 8), **"Bots offered the tool in their latest listed tasks"** as in section 3, and **"Examples of what this device sends back"**, a disclosure with section 8's table filled in with this device's own name, labelled "Examples. Each request's record shows the code and sentence this device actually sent."

## 6. An app outside the defaults: the owner's choice

Messages, Mail and Notes on the desktop, and Alarms and Home on the iPhone, need commands the gateway doesn't know, so they must be added to the gateway's allowlist, `gateway.nodes.commands.allow`, with admin. Each app has a fixed handler with named operations, and only these:

| App      | Commands (the allowlist entries)                     | What Clawtrate's handler does                                                                            |
| -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Messages | `clawtrate.messages.read`, `clawtrate.messages.send` | Read the messages of a conversation the request names; send a text message to one person or conversation |
| Mail     | `clawtrate.mail.search`, `clawtrate.mail.send`       | Search mail and read the messages found; send one message                                                |
| Notes    | `clawtrate.notes.search`, `clawtrate.notes.create`   | Search notes and read the notes found; create a note                                                     |
| Alarms   | `clawtrate.alarms.list`, `clawtrate.alarms.set`      | List alarms Clawtrate set; set or remove one                                                             |
| Home     | `clawtrate.home.list`, `clawtrate.home.control`      | List accessories; turn one on or off, or set its level                                                   |

The parameters and checks of each are that command's own build issue (section 16). The allowlist is for every node and every caller (research §2.3).

**Below admin**, the row's action is "Add…", which opens a note in place: "Adding it to the gateway's allowlist needs admin access." with "Request admin access". Nothing else changes.

**With admin**, "Add…" opens a confirmation, **before** anything is written:

> **Let bots ask this Mac for Messages?**
>
> Clawtrate adds `clawtrate.messages.read` and `clawtrate.messages.send` to the gateway's allowlist. With them, a request that reaches this Mac can read the messages of a conversation it names and send a text message as you.
>
> The allowlist is for the whole gateway. Bots offered the tool in their latest listed tasks: Otto (listed Nov 19); Pip has no listing yet. A bot whose setup changes, a bot added later, and any device connected to the gateway with write access can send such requests too.
>
> This doesn't allow Messages on this Mac. This keeps this Mac's current Messages choice. You can change that choice here.
>
> [Add Messages] [Cancel]

The bots named and their dates are section 3's line at that moment. Mail's line: "search your mail and read what it finds, and send a message as you"; Notes: "search your notes and read what it finds, and create a note"; Alarms: "list the alarms Clawtrate set, and set or remove one"; Home: "list your home's accessories and turn them on or off or set their level".

"Add Messages" then runs as steps, each done on its read-back:

1. **"Writing Messages to the gateway's allowlist"**: one `config.patch` with the current hash. Done for the requested **allowlist edit** comes from a stored read: when `config.get` shows both entries in the stored settings.
2. **"Asking the gateway to list them for this Mac"**: the node connects again declaring them; a command request appears. The host compares it (section 4) and approves it with the admin connection (`node.pair.approve`): the node's own key has no operator connection, and another device's approval needs admin (research §1.2).
3. **"Reading back"**: `node.describe` lists the commands. Then "Gateway: Listed, 5:33 PM". A separate timestamped `node.describe` line states what is listed for this node and never implies every node was checked.

For stored and active read-back report each individually, including stored-only, active-list-only and read failure: "The gateway's stored settings list `clawtrate.messages.read` and `clawtrate.messages.send` (read 5:33 PM)." and, apart, "The gateway listed them for Studio Mac (bots) at 5:33 PM.", or that either read showed otherwise, or "Couldn't read the gateway's allowlist."

**The gateway step never changes this device's decision.** After it, Messages on this Mac reads what it read before: **Not decided** for a first add, with its own "Allow" (section 5); **Denied** if the person had denied or turned it off. A gateway change keeps a local denial; a later re-add after the person turned the app off asks again.

A failure says what was read then, never "Nothing changed" without a read: after step 1 fails with an answer, "The gateway refused this change: [reason]." Show the entries actually read, or "Couldn't read the gateway's allowlist."; with no answer, "Clawtrate couldn't confirm whether the gateway's settings changed." with "Check again" (a read, not a write); after step 2, "The gateway's settings list Messages, but the gateway doesn't list it for this Mac yet." with "Try again" and "Remove it from the allowlist"; after a hash conflict, "The gateway's settings changed since Clawtrate read them. Clawtrate didn't write this change." with "Try again". Retry after a hash conflict re-reads before proposing the patch again.

**Removing it from the allowlist** (admin), from the row: a confirmation, "Remove `clawtrate.messages.read` and `clawtrate.messages.send` from the gateway-wide allowlist? If that removes the commands from the active policy, the gateway can end waiting calls and refuse later calls for them. An operation this Mac already started may finish. This Mac keeps its Messages choice." Then one `config.patch` that replaces the list without the entries (`replacePaths`, research §2.3), with the stored and active read-back reported individually as above. The gateway ends a waiting call with "POLICY_CHANGED" and ignores this Mac's later answer (research §6). Turning the app off on this Mac is a separate action (section 9).

## 7. A request on this device: the permission card

When a request arrives for an app that is not decided, this device asks its person before doing anything. This is not one of the gateway's approvals: the gateway keeps no record of it, it reaches no other device, and an answer means only what this device then does (research §8). The card uses the approval card's frame from `conversation.md` §12 (outline, title, tag, buttons along the foot) and none of its states or words.

**Where it shows.** On this device only. When the request names a task (`sessionKey`) that this device lists, the card is placed in that task after its latest step; otherwise in "Requests to this device" at the top of This Mac's page, with a one-line banner, "A request for Calendar on this Mac", that opens it. Either way the card says what the request named, and only that (section 2's second rule).

**One card per request.** A second request for the same app while a card waits gets a card of its own, with its own parameters and deadline. Resolve the card by this connection and its request ID. Keep every other card's own parameters, deadline and outcome. Allow sets the app's standing choice for new requests. It dispatches only the selected request after the local checks. Turning the app off closes pending cards for that app. The runtime keeps the same request identity in the record: each card and each record carries its own request ID, task key, parameters and budget, and its Raw shows them. Nothing is done for a request the person has not seen.

**Pending**:

- Title: "Location requested on this iPhone".
- Tag: "Needs permission", on `--warn-soft`.
- What the request named: "The request names a task of Otto's, "Plan Saturday". This iPhone can't confirm who sent it." With a key this device doesn't list: "The request names a task this iPhone doesn't list (`agent:otto:…`). This iPhone can't confirm who sent it." With none: "The request names no task. This iPhone can't confirm who sent it."
- What Allow does, before the tap: "Allow gets your location for this request, and lets every later request for Location that reaches this iPhone get it, until you turn it off."
- "Show request": the command and its parameters as text (`location.get`, its accuracy), and Raw.
- Buttons: "Allow" (primary) and, at the far right, "Don't allow" (quiet).
- Foot: "Clawtrate closes this card by 5:44:30 PM." The time is this device's own limit, below; it promises nothing about the gateway's deadline.

**One timing rule.** At receipt, set a local decision limit from the smaller of the supplied remaining budget and five minutes. A nonpositive budget closes immediately. A missing budget uses a 30-second local limit. The gateway's timer can end earlier. At the five-minute cap, if an unanswered request arrived with a larger budget, attempt `NO_ANSWER_ON_DEVICE` while the socket is open and record the reply acknowledgement if one arrives. At the request's local budget limit, close the card and send nothing. Either way the card then reads **Timed out** and has no Allow; this device's monotonic clock keeps the limit (research §3.1).

Whether the gateway still waits is learned only from its acknowledgement of an answer (section 8).

**The outcomes.** Each says what this device did, and what the gateway acknowledged, and nothing about what any caller received:

| What happened                                                         | Tag         | The words                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allow; this device got the location and sent it; the gateway accepted | Allowed     | "Allowed. This iPhone got your location and sent it at 5:44 PM; the gateway accepted the answer. This request set Location to Allowed."                                                                                                                                                         |
| Allow; sent; the gateway ignored the answer                           | Allowed     | "Allowed. This iPhone got your location and sent it at 5:44 PM. The gateway ignored this device's answer. This request set Location to Allowed."                                                                                                                                                |
| Allow; sent; no acknowledgement                                       | Allowed     | "Allowed. This iPhone got your location and sent it at 5:44 PM. Clawtrate couldn't confirm the gateway received it. This request set Location to Allowed."                                                                                                                                      |
| Don't allow; the refusal was accepted                                 | Not allowed | "Not allowed. This iPhone didn't run the request and sent the refusal `NOT_ALLOWED_ON_DEVICE` at 5:44 PM; the gateway accepted it. This request set Location to Denied."                                                                                                                        |
| Don't allow; the refusal was ignored                                  | Not allowed | "Not allowed. This iPhone didn't run the request and sent the refusal `NOT_ALLOWED_ON_DEVICE` at 5:44 PM. The gateway ignored this device's answer. This request set Location to Denied."                                                                                                       |
| The app turned off while the card waited                              | Turned off  | "Location was turned off on this iPhone while the request waited. This iPhone didn't run it and sent the refusal `TURNED_OFF_ON_DEVICE`; the gateway accepted it." (or ignored it, or no acknowledgement, as above)                                                                             |
| The node stopped while the card waited                                | Stopped     | "Clawtrate stopped answering on this iPhone. This iPhone didn't run it and sent the refusal `TURNED_OFF_ON_DEVICE`; the gateway accepted it." (or ignored it, or no acknowledgement, or "Sent nothing" when the socket had closed)                                                              |
| The operating system refuses Clawtrate                                | Turned off  | "Location is turned off for Clawtrate in Settings. This iPhone didn't run the request." with "Open Settings" (F-347); no Allow                                                                                                                                                                  |
| The request's local budget limit came with no answer                  | Timed out   | "Timed out at 5:44 PM. This iPhone didn't run it. No permission was set by this request." Sent nothing. With "Location in This iPhone" (F-348)                                                                                                                                                  |
| The five-minute cap came first, for a larger budget                   | Timed out   | "No answer by 5:49 PM, this iPhone's five-minute limit. This iPhone didn't run it and sent `NO_ANSWER_ON_DEVICE`; the gateway accepted it." (or "The gateway ignored this device's answer.", or "Clawtrate couldn't confirm the gateway received it.") "No permission was set by this request." |

Each outcome is historical: it says what this request did to the app's setting, and the current setting stays on the app's row, because another request can change it. A completed answer that the gateway ignored says "The gateway ignored this device's answer" without inferring the reason.

- **No request runs again.** A timed-out request stays closed. To allow the app for later requests, at any time, the person uses the app's row: the card's "Location in This iPhone" goes there, and Allow on the row changes the permission and sends nothing (F-452). A later request is answered only if it reaches this device then, and it passes the gateway's checks as they are then: if the owner removed the command meanwhile, the gateway refuses it itself (research §6).
- "Resumed" is never said: nothing resumes (research §4.3).
- A resolved card folds to one line, 40 px, closed, like a resolved approval card, and opens to its words, the request and Raw.

## 8. What this device sends back, and what it records

**What it sends.** Every refusal this device writes is a fixed code and a sentence naming the app and this device, sent as `node.invoke.result` with `ok: false`. A caller that gets it reads `"<code>: <sentence>"` (research §3.1; for a bot, after its tool's own prefix, research §3.2). The words never include anything the request carried. Examples, for This iPhone:

| Code                     | Sentence                                                                  | When                                                               |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `NOT_ALLOWED_ON_DEVICE`  | "Location is not allowed on iPhone."                                      | The app is Denied, or the person pressed Don't allow               |
| `NO_ANSWER_ON_DEVICE`    | "No one answered on iPhone within five minutes. Location is not decided." | A caller's deadline was beyond the five-minute cap (section 7)     |
| `TURNED_OFF_IN_SETTINGS` | "Location is turned off for Clawtrate in iPhone's Settings."              | The operating system refuses Clawtrate                             |
| `TURNED_OFF_ON_DEVICE`   | "Location was turned off on iPhone before the request was run."           | Turned off, or the node stopping, before the operation started     |
| `NOT_OPEN_ON_DEVICE`     | "Clawtrate isn't open on iPhone, so no one could be asked."               | The iPhone app is in the background (section 9)                    |
| `NOT_SERVED`             | "iPhone doesn't answer this request."                                     | A command Clawtrate doesn't serve, or parameters it doesn't accept |
| `UNAVAILABLE_ON_DEVICE`  | "Location couldn't answer on iPhone."                                     | The app itself failed                                              |

**Checking again before acting and before answering.** Just before it starts the app's operation, and again just before it sends any answer, the host reads the app's permission, the app's state and the request's deadline. If the app is no longer allowed, or the deadline has passed, it does not start, or does not send what it got; it records which.

**What it records.** "Requests to this device" keeps one record for every request this device received, kept on this device for 30 days, newest first, including requests refused automatically with no card. Each record has:

- when it arrived, the app, the command and its parameters (as text, in Raw);
- what the request named, as section 7 says it;
- **what this device did**: "Didn't run it" (refused, or ended, before the operation started), with what ended it: the app named when the person turned it off ("Messages was turned off on this Mac"), and "Clawtrate stopped answering on this Mac." when the node stopped; "Ran it" (the operation started; for an action such as sending a message, what it did stays done); after Stop or Turn off during an operation, "Stopped the operation" only if the native cancellation result confirms it, otherwise "Started it. Clawtrate couldn't confirm whether it stopped" or the demonstrated effect, for example "Sent the message before Stop.";
- **what it sent**: the code and sentence, "the result", or **"Sent nothing"**, the explicit local outcome of sending no result (then there is no acknowledgement). If the operation had started, the record says so even when its result never went out;
- **what the gateway acknowledged**: "The gateway accepted it.", "The gateway ignored this device's answer.", or "Clawtrate couldn't confirm the gateway received it.";
- Raw: the request's own ID, its parameters, and for a refusal the actual outgoing code and sentence.

Keep a record for each request that reached this node, even when the gateway later times out, changes policy or removes the pairing. In the node record show only the operation, its local send attempt and what the gateway acknowledged. Requests that never reached the node have no record here. A record never says what a caller received or what a bot said; on the person's other devices, the bot's call is an ordinary action card (`conversation.md` §8.3) whose state follows what the gateway reported to that call.

## 9. Stopping, taking back, and the phone in the background

**Stop takes effect on this device first.** Turning the switch off asks first: **"Stop letting bots use this Mac?"**, "This Mac stops answering at once, here, whether or not the gateway can be reached. An operation already started can't always be undone: a message already sent stays sent. This Mac keeps its saved device sign-in, so turning it on again needs no new code. This Mac's separate operator sign-in and the gateway's allowlist stay as read." With admin, a checkbox "Also remove this Mac's node pairing from the gateway". Then "Stop" and Cancel. On Stop, in this order:

1. The host stops taking requests. Each request not yet started is refused `TURNED_OFF_ON_DEVICE` while the node can still send; each card closes as "Stopped", "Clawtrate stopped answering on this Mac."
2. An operation already started is cancelled where its app allows that, and recorded as "Stopped the operation" only if the native cancellation result confirms it; otherwise "Started it. Clawtrate couldn't confirm whether it stopped", or the demonstrated effect ("Sent the message before Stop."), or "Ran it" when it had finished.
3. The host closes the node connection and keeps the node's token, so turning it on again needs no new code.
4. With the checkbox, `node.pair.remove`, done when `node.describe` answers `unknown nodeId`. For Stop plus removal, clear the saved node credential only on confirmed absence; when the removal can't be confirmed the saved sign-in is kept, and a later refusal of it is the sign-in refusal of section 2, never a new credential made silently.

The page then says what it established: "Stopped on this Mac." Then say whether the node is listed and its connection state only from a fresh read, one of: "The gateway lists this Mac as a device, not connected (read 5:40 PM)."; "Removed from the gateway (read 5:40 PM)."; "Couldn't remove it from the gateway: <reason>. It's stopped on this Mac."; "Gateway status couldn't be checked." (with the checkbox, "Clawtrate couldn't confirm the removal."). Then whether the saved sign-in was kept ("This Mac keeps its saved device sign-in: turning it on again uses it, with no new code.") or cleared after a confirmed removal. Then, when the allowlist was read: "The gateway's allowlist still lists `clawtrate.messages.read`, `clawtrate.messages.send` (read 5:40 PM)." The apps' decisions on this Mac stay as they were. The Requests to this device section stays on the stopped and the off page, including when the gateway couldn't be reached.

**Turning an app off** ("Turn off Messages", on every Allowed row, on both devices) is the same, for one app: it takes effect on this device at once, without the gateway; requests not started are refused `TURNED_OFF_ON_DEVICE`; one already started is cancelled where its app allows and recorded as section 8 says; the records name the app ("Messages was turned off on this Mac"). The row reads Denied; the gateway's line is unchanged, and its allowlist entry, if any, stays (section 6 removes it).

**The phone in the background.** The iPhone answers requests only while Clawtrate is open (F-384). The gateway's queue for an iPhone in the background never holds a bot's call, and only holds camera, screen and talk commands, none of which Clawtrate offers (research §5). So:

- **When Clawtrate leaves the foreground**, each card closes as "Turned off", each request not started is refused, and while connected every new request is refused at once with `NOT_OPEN_ON_DEVICE`. An operation already started is cancelled or finishes as its app allows, and is recorded as what it was.
- **Once the operating system suspends the app**, its socket closes at a moment the app doesn't choose, and the gateway notices it later still (not established, research §9). The page says nothing about it until the app is open again and reads the gateway.
- **When the person opens Clawtrate again**, "Requests to this device" shows what this device received meanwhile, one record each, as section 8 says. Under it, once: "Requests made while this iPhone wasn't connected never reached it."
- This iPhone's state line reads "Connected while Clawtrate is open", and, once read, the gateway's "last saw it at 5:02 PM (connect)".

**This iPhone, off and on.** The iPhone's switch works as the Mac's, with its own confirmation, steps and Stop.

## 10. Other devices asking to be used by bots

Settings, Machines (`controls.md` §15) gains one block above "Paired devices": **"Devices asking to be used by bots"**. With admin it lists both kinds of request (research §1.5), newest first, each with what the device wrote about itself, as data, and the request's ID:

- A new device: "Kitchen iPad requests the node role." with "iPadOS, asked 5:20 PM". "Approve" and "Reject" (`device.pair.approve`, `device.pair.reject`).
- A device's commands: "Workshop PC requests `location.get`, `system.run`, `fs.listDir`. These commands need admin approval.", with the exact command IDs in mono. Where the displayed command IDs are `system.run` and `fs.listDir`, add in `--warn`: "If approved and permitted, these commands can run a program or list files on Workshop PC." `requiredApproveScopes` alone doesn't tell which operations the exact commands do, so nothing else is said about them. "Approve" and "Reject" (`node.pair.approve`, `node.pair.reject`).

Approving a new device opens "Approve Kitchen iPad as a device for bots?", "Kitchen iPad requests the node role. Its commands are a separate request, approved separately. What a device does with a request is up to the device." Approving commands opens a confirmation naming exactly what the request lists: "Approve Workshop PC's commands?", "Workshop PC requests `location.get`, `system.run`, `fs.listDir`. If approved and permitted, these commands can run a program or list files on Workshop PC."

After a decision the block says only what a read or a matched event established, each with its time:

- A role is confirmed by the resulting device entry: "Kitchen iPad's device entry lists the node role (read 5:22 PM)."
- Commands are confirmed by their present listing: "The gateway lists these commands for Workshop PC (read 5:22 PM): …".
- A refused action: show the refusal, "The gateway refused the approval: <reason>.", and retain the request's row, with "The request is still pending (read 5:22 PM)." if the ID is still pending.
- A rejection: match the `device.pair.resolved` or `node.pair.resolved` event to the request ID before giving the rejection result: "The gateway reported request `5d2e…` rejected."
- "The request is no longer pending" only when the right scope's successful read lacks it and the exact decision is otherwise unconfirmed.
- A read that fails: "Couldn't read the gateway. Clawtrate can't tell what happened to Kitchen iPad's request." with "Check again"; never that anything was approved, rejected or removed.

The block is fed by `device.pair.requested` and `node.pair.requested`, which every device with device access hears for every device (research §1.6), and read with `device.pair.list` and `node.pair.list`, which give a connection without admin only its own device. Below admin, keep the existing two sections independent. The new request block shows the admin access line, "Approving other devices for bots needs admin access.", with the admin request, and never a list: an event is a prompt to read again, and the read would show nothing. Paired devices shows the `controls.md` §15 device-access line below pairing ("Seeing paired devices needs device access." with "Request access"), the permitted subset at pairing (this device's own records: "Only this device's own records are listed. Seeing other devices needs admin access."), and the whole list only at admin (`docs/decisions.md`, `device.pair.list`).

## 11. The share sheet

On the iPhone, "Clawtrate" in the share sheet opens Clawtrate's own sheet over the sharing app (F-245):

- **To**: the primary bot, its picture and name: the gateway's default bot, `agents.list` `defaultId` (`docs/decisions.md`, "Read-only flows", "The primary bot"). Tapping it lists the bots this device last read, as a radio group.
- **The items**, as chips: a link as its full address in text (never fetched, no preview), a file with its name and size, a picture as a thumbnail drawn on the phone from the shared bytes. An item over the composer's limits (F-074; `docs/decisions.md`, "Attachments") or of a kind the composer doesn't send is marked "Can't be sent" and left out, with the reason.
- **"Add a note"**, the message field.
- **Send** (primary) and **Cancel**, which closes the sheet, sends nothing and keeps nothing.

Choosing another bot keeps the note as edited and the items as chosen.

**What Send does, exactly**: one new task with the To bot, `sessions.create {agentId, message, attachments, idempotencyKey}`, with the note as its message (a link is text in it) and the items as attachments in the composer's form (research §7), from this iPhone's paired connection, at the moment Send is pressed. Nothing is sent before. The key is made once for that send. "Sent to Juniper" shows only when the gateway answers with the task; the sheet then closes. Acceptance is all it says: whether Juniper's model can read a picture depends on its model, and the sheet doesn't claim it.

**When it is known that nothing was sent** (F-406): no gateway saved, the connection is read-only, the gateway couldn't be reached before sending, or no item can be sent. The sheet says which in one line, with **"Open in Clawtrate"**: Clawtrate opens on a new task with the chosen bot, the note exactly as edited and the chosen items in its composer, unsent. When there is no gateway, or the chosen bot is no longer listed, the draft has no bot, and the composer asks which bot before it can send. The draft is kept on this device until it is sent or deleted.

**When the reply is lost** (the request was sent, no answer came within 10 seconds, or the connection dropped after sending): Clawtrate couldn't confirm whether the gateway received this. Keep the saved gateway address, the paired credential context, the original hello's `server.bootId`, the send time, the key and the exact arguments. Check again may submit that same operation only within four minutes and only when the current hello matches the saved address, credential context and nonempty boot ID. A different or missing boot ID, a change of credentials or gateway, or the end of the window shows "Clawtrate still couldn't confirm it. Look in Juniper's tasks before sending again." Open Juniper opens that bot's task list. Until then offer Close, which dismisses the sheet without making another request. Keep the unconfirmed status with the operation. Once the gateway gives an accepted result, reconcile it with the original task.

In the sheet: "Clawtrate couldn't confirm whether the gateway received this." and "Check again uses the original send." Close, not Cancel, is offered for a pending, unknown or acknowledged result. A dismissed unknown share says "Closed. Clawtrate couldn't confirm whether it was sent." Only Cancel before submission says "Nothing was sent."

## 12. Siri and Shortcuts

Two actions (F-246):

- **List Bots** reads `agents.list` and returns the bots' names in the gateway's order, the primary bot first: "You have four bots: Juniper, Marlow, Otto and Pip." When the gateway can't be reached: "Clawtrate couldn't reach the gateway." with no list: a list from memory would pass for current.
- **Send Message** takes a bot (the primary bot by default) and the message. Before anything is sent, it shows the chosen bot and the exact text and asks "Send to Juniper?" with Send and Cancel. Cancel sends nothing. On Send: one new task, `sessions.create {agentId, message, idempotencyKey}`, with the share sheet's rules for a lost reply: its eventual native sending uses the same guarded path. "Sent to Juniper." only once the gateway answered. When it is known nothing was sent: "Clawtrate couldn't send this: <reason>." with "Open in Clawtrate", which puts the message in a new task's composer, unsent.

**On a locked iPhone**, both actions need the phone unlocked before anything else: no bot name, message text or result is shown, spoken or read, and nothing is sent, until it is. Siri says only "Unlock your iPhone to use Clawtrate." Both actions run only when the person runs them, and the gateway's answers are shown as data.

**Until it is proven on a device** that the system shows Send Message's confirmation with the bot and the exact text before sending, on a locked and an unlocked phone and when run from a shortcut, Send Message does not send: it opens Clawtrate with the message in the chosen bot's new task composer, unsent ("Open in Clawtrate to send it"). Its send path above is built after that proof (section 15).

## 13. What the gateway's facts drive

| Fact                                                                                                                                                                                                                                                                               | Source (research) | Shown                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A device paired as an operator can't connect as a node on its operator token                                                                                                                                                                                                       | §1.7              | The node has a credential of its own                                                                                                                    |
| On a token-authenticated loopback development gateway, admin requested a node-only code with `publicUrl` set to the current gateway URL. Read and write plus pairing were refused for scope. A fresh node key presenting the code paired and its approved commands were read back. | §1.7              | Section 4: admin only; below it the switch is unavailable                                                                                               |
| On a key of its own, the code pairs the node and approves its first commands; on the operator's key it opens a role upgrade and is spent                                                                                                                                           | §1.7              | Section 2: the node's own key; section 4's three read-backs                                                                                             |
| A revoked node token is refused; a new code on the same key opens a role upgrade                                                                                                                                                                                                   | §1.7              | Recovery: a new key and a new code                                                                                                                      |
| A later command request: the node's own key has no operator connection; another device's approval needs admin                                                                                                                                                                      | §1.2              | Section 6, step 2: the admin connection approves after comparing                                                                                        |
| A declared command outside the lists is dropped silently; `node.describe` reads back what was kept                                                                                                                                                                                 | §2.2              | "Gateway: Listed, [time]", "Listed, [time]: [commands]" or "Not listed when read at [time]", with no reason the gateway didn't give and no refusal mark |
| Platform defaults; nothing for Messages, Mail, Notes, Alarms or Home                                                                                                                                                                                                               | §2.1              | Which rows need the owner                                                                                                                               |
| `gateway.nodes.commands.allow`: admin to write, read to read; `replacePaths` to remove                                                                                                                                                                                             | §2.3              | Section 6's steps and removal                                                                                                                           |
| `node.invoke.request` carries `timeoutMs` (30 000 by default) and, only when the caller sets it, `sessionKey`                                                                                                                                                                      | §3.1              | The card's deadline; "the request names …"                                                                                                              |
| `sessions.list` `kind` is `direct` for any task outside cron, helpers and groups, another device's task included                                                                                                                                                                   | §7.1              | Section 2's second rule: no screen says whose chat a request came from                                                                                  |
| `node.invoke.result` answers `{ok}` or `{ok, ignored: true}`; it doesn't carry the caller's outcome                                                                                                                                                                                | §3.1              | Section 7's outcomes and section 8's records say what the gateway acknowledged                                                                          |
| A writer at another device can call `node.invoke`; a node's reported `permissions` don't admit a call                                                                                                                                                                              | §3.1, §4.1        | Section 2's first rule; "any device connected to the gateway with write access"                                                                         |
| A newly reported permission opens a new request                                                                                                                                                                                                                                    | §4.2              | The node reports no permissions                                                                                                                         |
| No five minutes, no hour, no re-run in the gateway                                                                                                                                                                                                                                 | §4.3              | The five-minute cap is this device's; nothing runs again                                                                                                |
| The background queue excludes a bot's calls; 10 minutes, 64                                                                                                                                                                                                                        | §5                | Section 9: refuse at once, record on return                                                                                                             |
| Removing an allowlist entry ends a waiting call `POLICY_CHANGED`; removing a node needs admin                                                                                                                                                                                      | §6                | Section 6's removal; section 9's Stop                                                                                                                   |
| Pairing-scope devices hear every device's requests and list only their own                                                                                                                                                                                                         | §1.6              | Section 10: admin only, one line below                                                                                                                  |
| `agents.list` `defaultId` at read; `sessions.create` with a message and attachments at write; An identical retry within the original start and authenticated owner's cache returns the original task                                                                               | §7                | Sections 11 and 12, and "Check again"                                                                                                                   |

## 14. Parity rows

No target is changed and no status. The three proposals of the first draft (F-348, F-384, F-451) are withdrawn: those rows keep their targets, and their dependency cells record the gateway's gaps. What each row gets from this design:

| Row   | What this design shows                                                                                                                                                                                                                        | Met as written?                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| F-185 | The permission card for a phone app, "Needs permission" and Allow. It names the task the request named, never the bot as the asker: nothing establishes who sent it (section 7)                                                               | No: the card can't say a bot needs permission, only that a request named its task                             |
| F-223 | This iPhone lists Calendar, Contacts, Location, Alarms, Reminders and Home with Allow, Allowed or Denied. Alarms and Home also need the owner's allowlist (section 6)                                                                         | Yes, as the rows of section 5; Alarms and Home answer only once added                                         |
| F-245 | The share sheet with the primary bot in To, Add a note and Send; one task per send, Check again uses the original task-creation cache                                                                                                         | Yes, on the gateway's side; the native share extension is unverified                                          |
| F-246 | List Bots and Send Message, on an unlocked phone. Send Message hands off a draft until its confirmation is proven (section 12)                                                                                                                | Not yet: Send Message doesn't send until that proof                                                           |
| F-347 | A permission the operating system refuses: card and row offer "Open Settings". A permission the person denied in Clawtrate: the row offers Allow, here                                                                                        | Partial. Open Settings is offered after an OS denial. Clawtrate's own denial is changed on the local app row. |
| F-348 | The card reads Timed out at this device's local decision limit, the smaller of the request's remaining budget and five minutes. The gateway limits its own call and can end earlier; whether the bot continues and says so is not established | No: the gateway's gap, recorded in the row                                                                    |
| F-384 | The iPhone answers only while open, and refuses in the background. Nothing establishes which chat, or whose, a request came from, so the iPhone does not limit requests to the person's own chat                                              | No: the gateway's gap, recorded in the row                                                                    |
| F-385 | This Mac lists Messages, Mail, Notes, Reminders, Calendar, Location and Contacts, each with its own Allow; Messages, Mail and Notes also need the owner's allowlist                                                                           | Yes, as the rows of section 5; the three answer only once added                                               |
| F-406 | "Open in Clawtrate" with the exact draft, when it is known nothing was sent; "Check again" when that isn't known                                                                                                                              | Known-no-send fallback drawn. Native draft handoff is unverified.                                             |
| F-451 | Nothing resumes: a timed-out request stays closed, and the card never says "Resumed"                                                                                                                                                          | No: the gateway's gap, recorded in the row                                                                    |
| F-452 | Allowing the app on its row, any time after the request ended (at 61 minutes, say), changes the permission and sends nothing; the request stays closed                                                                                        | Yes                                                                                                           |

**Dependency cells** (applied in `docs/parity.md`, statuses unchanged): F-348, F-384 and F-451 carry the gateway's gaps; F-185, F-223, F-347, F-385 and F-452 the node's own credential and the two lines; F-245 and F-246 what was live and what wasn't.

Each row's check, in the prototype check and later in the app:

| Row   | Check                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-185 | A request for an undecided app shows the card with Allow and what Allow lets through; the card names the request's task as named, and never who asked  |
| F-223 | This iPhone lists the six apps, each with its value and its own actions                                                                                |
| F-347 | An app the operating system refuses: card and row offer Open Settings and no Allow; a denied local grant offers only local Allow to change that choice |
| F-348 | With no answer, the card reads Timed out at its moment; nothing was run                                                                                |
| F-384 | In the background the iPhone refuses with `NOT_OPEN_ON_DEVICE`; on return the records list what was received; no screen says "your own chat"           |
| F-385 | This Mac lists the seven apps, each with its own Allow; adding Messages leaves it Not decided on this Mac                                              |
| F-406 | A known no-send opens the composer with the note as edited; a lost reply offers Check again and no draft                                               |
| F-451 | No state says "Resumed"; a timed-out request stays closed                                                                                              |
| F-452 | At 61 minutes, Allow on the row changes the permission; the request's record still reads Timed out and nothing is sent                                 |
| F-245 | The share sheet shows the primary bot in To, Add a note and Send; Send makes one task                                                                  |
| F-246 | List Bots returns the names; Send Message shows bot and text first; a locked phone shows nothing until unlocked                                        |

## 15. For builders

### What each part uses

| Part                    | Existing components                                                        | New                             |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| This Mac, This iPhone   | Settings frame, switch, fact block, note, access bar, step list, the marks | `.d-app`, `.d-state`            |
| The owner's choice      | Confirmation, step list, access bar                                        |                                 |
| The permission card     | The approval card's frame, Raw, event line                                 | `.d-ask`                        |
| Requests to this device | Fact block, Raw                                                            | `.d-record`                     |
| Machines' block         | Fact block, confirmation                                                   |                                 |
| The share sheet, Siri   | The composer's attachments                                                 | `.d-share`, `.d-sys` (stand-in) |

### What the host does

- **The node connection** lives in the host (Electron's main process; the iPhone app's own process), never in the renderer: one per gateway, on the node's own key (section 2), with `role: "node"`, `client.id: "node-host"`, `mode: "node"`, the platform and device family, the fixed commands of section 5 for that platform, and no permissions. It starts only after the host's confirmation and a node-only code, and keeps its token tied to the gateway's address and the node role.
- **Its answers** come from Clawtrate's own handler for each command: no command is passed to a shell, no program is started, nothing in a request is opened, fetched, or made into a path or a program's argument. Unknown commands and parameters are refused `NOT_SERVED`.
- **Its fence**: Stop and Turn off act in the host before any network call; the permission, the app's state and the deadline are read again before an operation starts and before an answer is sent (section 8).
- **Its clock**: each request's local decision limit (the smaller of its remaining budget and five minutes, 30 seconds when none is supplied, closed at once when nonpositive), on this device's monotonic clock; at the cap, the `NO_ANSWER_ON_DEVICE` attempt and its acknowledgement if one arrives.
- **Its comparison** of a command request with the current declaration before any `node.pair.approve` (section 4).
- **Its records**: one per received request, on this device, 30 days.

### What the engine supplies

- The node's state from `node.describe`, re-read on `node.pair.requested`, `node.pair.resolved` and `device.pair.resolved`, and every 60 seconds while the page is open, each with its time.
- For each app: what this device declared, what the gateway read back with its time, and the local permission, kept apart.
- Each bot's latest listing of the tool for other devices, with its date, from `controls.md`'s "Offered" fact.
- The primary bot from `agents.list` `defaultId`.

### Order

1. **Prove on a development gateway first**, with a stand-in node on loopback as in research §1.7: the node-only code, pairing on the node's own key, reconnecting on its token, a revoked token, and a command request approved by admin after the comparison.
2. The node connection in the host with the fixed commands, the fence and the refusals of section 8, answering nothing else. Check F-384's background refusal.
3. This Mac and This iPhone, read back. Check F-223, F-385.
4. The permission card, its timing rule and the records, on fake time, with an acknowledgement that is accepted, ignored and missing. Check F-185, F-347, F-348, F-451, F-452.
5. Stop and Turn off with the gateway unreachable. The owner's choice with admin, in both orders with a local decision. Check F-385's Messages, Mail and Notes.
6. Machines' block.
7. The iPhone, each first proved on a device or simulator: an in-flight request when the app leaves the foreground, and what the gateway sees before the socket closes; that a share extension can use the paired credential through a shared keychain and can open the app; that the App Intents need an unlocked phone and show Send Message's confirmation with the bot and the exact text, from Siri and from a shortcut, with Cancel sending nothing. Until the last is proven, Send Message hands off a draft. Check F-245, F-406, F-246.

### Prototype states

`prototype/device.html?screen=<id>`, with the shared `theme`, `width`, `motion` and `chrome` parameters, and `access` (`read`, `write` for the interactive tier, `admin`, the default). The iPhone's screens (`phone-`, `card-`, `share`, `siri-`) open at phone width unless `width` says otherwise. `app=mail` or `app=notes` gives the owner's choice for that app; `own=listed` its state once added, with `local=allowed` or `local=denied` this Mac's decision for it; `prior=denied` a local denial before the add; `dev=phone` the owner's choice on This iPhone; `half=<app>` an app whose read lists only its first command; `read=both|stored|active|fail` what the stored and the active read-back each showed after an add or a removal; `allowed` and `off` apps allowed or turned off on this device; `history=1` example grants and records made before (without it, every app is Not decided except one the operating system refuses, as after a first-time activation); `link=down` a gateway that can't be reached; `lost=1` a share whose reply is lost, `late=1` past the key's window, `nobot=1` a draft with no bot; `to=<bot>`, `note=<text>` and `msg=<text>` the share sheet's bot and note and Send Message's text; `readfail=1` a failed read in Machines; `ack=ignored` a refusal the gateway ignored; `devname` and `taskname` a supplied device or task name, to show they stay text.

| Screen                                                                                                                                                                                                                                                                                                                                                                                                   | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mac-off`                                                                                                                                                                                                                                                                                                                                                                                                | This Mac, off; below admin the switch is unavailable                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mac-confirm`                                                                                                                                                                                                                                                                                                                                                                                            | The host's confirmation for turning it on                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mac-steps`, `phone-steps`                                                                                                                                                                                                                                                                                                                                                                               | The three read-backs, each done after its own read (`at=1`, `at=2`); `fail=code` (missing admin), `fail=codeother` (any other refusal), `fail=hello` (no hello), `fail=pair`, `fail=read` (the first read unavailable), `fail=pending` (only the pending commands, compared again before approving; `approved=1` after it, reading the resulting commands), `fail=changed` (the request changed: nothing approved), `fail=extra`; `subset=1` a strict subset, finished with it |
| `mac-on`                                                                                                                                                                                                                                                                                                                                                                                                 | The apps, both facts each; `calendar=allowed`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mac-messages-confirm`, `mac-messages-steps`, `mac-messages-needadmin`                                                                                                                                                                                                                                                                                                                                   | The owner's choice (`app=mail`, `app=notes`); its steps (`fail=1` refused with its reason, `reread=fail`, `fail=1quiet`, `fail=2`, `fail=hash`); below admin                                                                                                                                                                                                                                                                                                                   |
| `mac-messages-on`, `mac-messages-remove`, `mac-messages-removed`                                                                                                                                                                                                                                                                                                                                         | Messages listed, with this Mac's own decision and the two read-backs; removing it from the allowlist; what each read showed after (`read=`)                                                                                                                                                                                                                                                                                                                                    |
| `mac-stop`, `mac-stopped`                                                                                                                                                                                                                                                                                                                                                                                | Stopping; what was established after (`link=down`, `removed=1` a confirmed removal that clears the saved sign-in, `removed=unknown` with the gateway unreachable, `removed=fail`), and the records Stop and Turn off left; `saved=1` the saved node sign-in, which turns it on again without a code at any access (`mac-confirm`, `mac-steps` with `saved=1`)                                                                                                                  |
| `mac-offline`, `mac-refused`, `phone-refused`, `mac-unlisted`                                                                                                                                                                                                                                                                                                                                            | Not connected; sign-in refused, recovered only with a new code from admin; no longer listed                                                                                                                                                                                                                                                                                                                                                                                    |
| `mac-request`                                                                                                                                                                                                                                                                                                                                                                                            | A request that named no task, with the banner, and the records                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `machines`                                                                                                                                                                                                                                                                                                                                                                                               | Devices asking to be used by bots, admin (`ipad=` and `pc=` `approved`, `refused`, `rejected`, `gone`; `readfail=1`); `access=write` shows the admin line and the device-access line, `access=pairing` this device's own records                                                                                                                                                                                                                                               |
| `phone-off`, `phone-confirm`, `phone-steps`, `phone-on`, `phone-stop`, `phone-stopped`                                                                                                                                                                                                                                                                                                                   | This iPhone, off, turning on, on, and stopping                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `card-pending` (`task=other`, `task=none`, `second=1` two requests with their own IDs, `done=<id>:allowed\|denied` what each card's own control did, `budget=short` a 12-second budget, `budget=cap` a 10-minute one), `card-sent`, `card-ignored`, `card-unconfirmed`, `card-dontallow`, `card-turnedoff`, `card-stopped`, `card-timedout`, `card-cap` (`ack=accepted\|ignored\|none`), `card-settings` | The permission card's states. They show the words only: no clock, cancellation or acknowledgement is proved by a result fixture alone; the host proves them on fake time (Order, step 4)                                                                                                                                                                                                                                                                                       |
| `phone-back`                                                                                                                                                                                                                                                                                                                                                                                             | Back from the background, with the records                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `share`, `share-to`, `share-sent`, `share-cant`, `share-unsure`, `share-draft`, `share-closed`                                                                                                                                                                                                                                                                                                           | The share sheet: choosing the bot, sent, a known no-send, a lost reply, the composer it opens, cancelled                                                                                                                                                                                                                                                                                                                                                                       |
| `siri-list`, `siri-list-fail`, `siri-locked`, `siri-confirm`, `siri-handoff`, `siri-sent`, `siri-fail`, `siri-cancelled`                                                                                                                                                                                                                                                                                 | The two actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`prototype/tools/checks/device.mjs` walks every path above to its outcome, and has lines that fail without each rule of this design: the node's credential and the read-backs, the two gates in both orders, what the card and the records say for each acknowledgement, the timing rule, Stop and Turn off with the gateway unreachable, the share sheet's edited note and lost reply, and the locked phone. It also checks that supplied names stay text, that no state says "Resumed", "your own chat" or names who asked, and every state at desktop and phone width in both themes.

## 16. Not covered here

- What each command returns, its parameters and their checks: each command's own build issue. This design fixes which commands exist, what each app's handler may do, and how they are refused.
- Approval cards, their timing and who receives them: `controls.md` and `conversation.md`. The permission card borrows only the frame.
- A bot's tool for other devices as a line of its permissions: `controls.md` §4 lists it under "Anything else".
- Wake-up pushes for an iPhone in the background (APNs), and the gateway's queue for camera, screen and talk.
- Commands that run programs, read files, use a browser or record the screen on this device: never offered by this design.
- Links into the app (#80), and files in a chat beyond handing them to the composer (F-284, #54).
- A node credential without an admin connection: no route is established (research §1.7).

Cut because nothing proven supports them:

- **Running a request again after a late Allow, once** (F-451): nothing in the gateway re-delivers a call, the background queue never holds a bot's call, and a node can't start a bot's turn (research §4.3, §5).
- **Answering only the person's own chats** (F-384): nothing the gateway sends a node establishes who started a request or from which chat (research §7.1).
- **Naming who asked**: the request carries no caller; a task's key is the caller's own parameter (research §3.1, §7.1).
- **Saying what a caller received**: the gateway's acknowledgement to the node doesn't carry it (research §3.1).
- **A permission for one bot only**: the gateway's allowlist and a node's commands are for every caller (research §2.3).
- **Telling the bot after a late Allow**: it would be a message the person didn't write. The person writes one if they want.
