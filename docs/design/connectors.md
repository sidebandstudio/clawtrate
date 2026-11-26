# Connectors: tool servers and apps for bots

How a person gives their bots tools that live outside Clawtrate: a tool server added by its address or as a program on the gateway's machine (slice 1), apps from the catalog (slice 2), a sign-in a bot asks for in the conversation (slice 3), and "What do you use every day?" and the iPhone (slice 4). It follows `visual-language.md`, `conversation.md`, `bots.md`, `controls.md` and `setup-effortless.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-004, F-047, F-217 to F-222, F-337 and F-380 to F-383. What the gateway does is in `docs/research/connectors.md`, cited as R§n. Section 13 lists every gateway fact this design rests on, for OpenClaw 2026.10.6 and 2026.11.10, each marked **established** (with the file and line, or the run) or **proposed**. Section 16 is for builders.

## For the owner: what slice 1 gives you

**After slice 1 you can give your bots a tool server from Clawtrate, with nothing typed in a terminal.** You paste the server's address, or name a program on the gateway's machine, and choose which bots get it. Clawtrate then shows you whether the gateway reached it, which tools it offers, and which bots can use them. If the server needs an account, Clawtrate takes you to the gateway's own sign-in page and approves your browser for you there. You can take the server away from one bot, or remove it altogether, from the same page.

**One walk-through: a notes server for Pip, in six clicks and one paste.** You use a notes service whose tool server is at `https://notes.example/mcp`. It needs no account.

| Click | You                                                              | Clawtrate                                                                                                                           |
| ----- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Open Pip's settings                                              | Its Tools group, with "Tool servers: none" and **Add**                                                                              |
| 2     | **Add**                                                          | The add form, with Pip already chosen (section 4)                                                                                   |
| -     | Paste `https://notes.example/mcp`                                | The name `notes` is filled in from the address                                                                                      |
| 3     | **Add**                                                          | Writes the server and Pip's choice in one change, then reads it back: "**Added notes.** Pip can use it." with Undo (sections 2, 4)  |
| 4     | **Try it with Pip**                                              | Opens a new task with Pip, with "What can you do with notes?" in the message field. Nothing is sent yet: a message uses Pip's model |
| 5     | **Send**                                                         | Pip runs. The gateway connects to the server for this turn                                                                          |
| 6     | Open **notes** (from the result card, or Settings, Tool servers) | "**Reached in Pip's task** at 5:12 PM: 8 tools", with their names (section 5)                                                       |

From Settings instead, it is one click more (Settings, Tool servers, Add a tool server), and the form starts with every bot ticked. Nothing on the way asks you to confirm what you just did (section 2, "What asks").

**If the server needs an account** (it says so when the gateway first reaches it, or you tick "Sign in with an account" when adding it), the server's page shows **Sign in**. That opens the gateway's own page for that server in your browser (section 6):

- **OpenClaw 2026.11.10.** The first time, the gateway's page shows a code such as `ABCD-EFGH`. Clawtrate asks for it, shows which browser is asking, and approves it. That is two more clicks and one code. Then **Sign in** on the gateway's page, the service's own consent page, and you are back.
- **OpenClaw 2026.10.6.** The first time, the gateway's page asks for the gateway's secret. Clawtrate copies it for you, and you paste it once. Then the same **Sign in**.

Either way, Clawtrate re-reads when you come back, and Pip has the tools on its next message.

**A program on the gateway's machine** (a server that runs as a command) is added the same way, at once. The form says, as you fill it in, that the gateway will run that program on its own computer as its user, and the server's page says so after. Clawtrate asks only where something can't be taken back: signing in (on the service's own page, and approving your browser for the gateway the first time), signing out, and removing a server whose key or sign-in would be lost. Everything else is done at once and shown, with Undo (section 2, "What asks").

### Decisions, each with a recommendation and its cost

| #   | Decision                                           | Recommended                                                                                                                                                                                                                                                                                                                                 | What it costs                                                                                                                                                                                                                                                                                                                                          | Other choices                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How sign-in works with nothing typed in a terminal | Open the gateway's own Settings page for the server in the person's browser. Clawtrate approves that browser itself, after showing which browser asks: by the gateway's pairing code on 2026.11.10, and by copying the gateway's secret for one paste on 2026.10.6. The gateway runs the sign-in and keeps it (established: facts 8 to 10). | The first sign-in from a browser has one extra step, the code or the paste. On a gateway on another computer, the browser must reach it at an address the gateway accepts for sign-in (HTTPS, Tailscale or a forwarded loopback port); the forwarded port is proposed, not established (section 15). Copying the secret puts it on the clipboard once. | (a) Clawtrate opens a second connection that declares a browser origin: refused, because Clawtrate signs in as itself and never poses as a browser. (b) A sign-in method in Clawtrate's own gateway plugin: OpenClaw offers plugins no MCP sign-in interface (fact 11), so it would depend on internals that change every release. (c) Ask OpenClaw for a sign-in method for apps like Clawtrate: not ours to schedule. |
| D2  | Which bots get a new server                        | From a bot's settings: that bot. From Settings: every bot, all ticked on the same form, so unticking is one click. A bot made later gets it too unless unticked then (established: fact 7).                                                                                                                                                 | One config change writes a deny for each bot left out. A bot created outside Clawtrate gets every server it isn't denied.                                                                                                                                                                                                                              | Off for every bot, as T3 Code is (`bots.md` §16): safer for a powerful server, but a step for every bot, every time.                                                                                                                                                                                                                                                                                                    |
| D3  | What asks                                          | Only destructive acts (section 2, "What asks"): a sign-in and approving a browser for the gateway, signing out, replacing a key, installing or removing an app, and removing a server that loses a key or sign-in. Adding any server, a program included, and choosing bots are done at once, shown, with Undo.                             | A program server reaches the gateway's machine with no stop; the form and the page state what it runs.                                                                                                                                                                                                                                                 | A question before a program server: one more click for something the person just typed and can remove at once.                                                                                                                                                                                                                                                                                                          |
| D4  | How the person sees it work                        | "Try it with <Bot>": a new task with a message ready, not sent. The page shows the gateway's tool listing for that task after the turn (established: fact 6).                                                                                                                                                                               | One message, which the person sends, using the bot's model. Until a bot runs, the page says "Not reached yet" and why.                                                                                                                                                                                                                                 | Clawtrate's computer connects to the server itself to list its tools: it would test the wrong machine and network, and couldn't run a program on the gateway's machine.                                                                                                                                                                                                                                                 |
| D5  | A key for the server                               | One optional field, "Key", saved as the `Authorization: Bearer` header, with one line saying the gateway keeps it unencrypted in its settings file (established: fact 15). Other headers under "More".                                                                                                                                      | The key sits in the gateway's settings in plain text, as every header does.                                                                                                                                                                                                                                                                            | Only free-form headers: a person must know the header's name.                                                                                                                                                                                                                                                                                                                                                           |
| D6  | Order after slice 1                                | Apps from the catalog (slice 2), then a sign-in a bot asks for in the conversation and bots connecting things for themselves (slice 3), then "What do you use every day?" and the iPhone (slice 4).                                                                                                                                         | The catalog waits for slice 2. Every app in it is a plugin, installed on the gateway's machine.                                                                                                                                                                                                                                                        | Catalog first: more to browse, but it installs code and its search needs the catalog online; a server by address works on any gateway.                                                                                                                                                                                                                                                                                  |

### What comes after slice 1

- **Slice 2, apps.** "Connect apps" from the rail: search, categories, featured apps, Add (a plugin install with its read-back), an app's page with its accounts and sign-in, turn off, remove (sections 8 and 9).
- **Slice 3, in the conversation.** A sign-in card when a bot calls a server's connect tool, and the meeting point with bots acting on Clawtrate: a bot that is asked to connect something (section 10).
- **Slice 4.** "What do you use every day?" at the top of Connect apps the first time, and the iPhone's Plugins sheet (section 11).

## Contents

1. Where it lives
2. Shared rules: components, access, writing and reading back, what asks, gateway text, announcements, input
3. Slice 1: Settings, Tool servers
4. Slice 1: Adding a tool server
5. Slice 1: A tool server's page
6. Slice 1: Signing in
7. Slice 1: Removing a tool server
8. Slice 2: Connect apps, Browse and Add
9. Slice 2: An app's page, accounts, turning off, removing
10. Slice 3: A sign-in in the conversation, and bots that connect things
11. Slice 4: What do you use every day?, and the iPhone
12. Widths, themes, keyboard, screen readers
13. The gateway's facts, on both versions
14. Parity rows
15. Not established, and what would establish it
16. For builders: slices, calls, rows and pull requests
17. Not covered here

## 1. Where it lives

```
Settings
  Tool servers (slice 1)            every server on the gateway; Add; each server's page
  Integrations                      T3 Code, which is a tool server too (bots.md §15 to §18)
A bot's settings, Tools group
  Tool servers: notes, local-search one line (F-047); opens Settings, Tool servers, filtered to this bot; Add
  What <Bot> may do                 controls.md §4: one line per server, `<server>__*`
the rail's "Connect apps" (slice 2)  the catalog; On this gateway; links to Tool servers
the conversation (slice 3)          a sign-in card from a bot's connect tool
Connect apps, first time (slice 4)  "What do you use every day?" at the top of Browse
```

- A tool server is gateway-wide, not a bot's: one entry in the gateway's settings, which every bot can reach unless its tool rules leave it out (fact 7). So its home is Settings, beside Integrations, and a bot's settings show which servers that bot can use.
- `t3code`, when T3 Code is added, is listed in Tool servers with "Managed in Integrations" and opens `bots.md` §16; its bots and sign-in stay there.
- Which tools of a server a bot may call, and whether it asks first, is `controls.md` §4 and §5. This design writes only the whole-server choice, `<server>__*` (section 5, "Bots").

## 2. Shared rules

### Components

Used from other parts: the Settings frame and section list, choice list, note, result, confirmation (role `alertdialog`), access bar (`bots.md` §2, §7); fact block (`visual-language.md` §9); command block with copy (`visual-language.md` §10); `.input` and the buttons (`visual-language.md` §4); the approve prompt (`setup-effortless.md` §5, "The prompt").

New, each defined once in `prototype/css/connectors.css` from existing tokens, with no new tokens:

| Component                  | What it is                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial (`.c-initial`)     | A server's or app's mark: a 40 px square, radius 10, on `--bg-bubble` with a 1 px `--border`, its first letter in `--text` at 17/500. 28 px in a row, 56 px on a page. Never a picture, never a colour.      |
| Server row (`.c-row`)      | A choice-list row: the initial, the name (15/500, mono), the address or "Runs a program" (13, faint), the state word, and the bots ("Pip, Otto" or "No bots"). 64 px; 72 on touch.                           |
| State word (`.c-pill`)     | A word in a 24 px pill: neutral on `--bg-bubble` ("Not reached yet", "Turned off"), `--warn-soft` to act on ("Needs sign-in", "Needs a key"), `--danger-soft` for a failure ("Can't reach it"). Never green. |
| Bot choice (`.c-bots`)     | A group of checkboxes, one per bot, each with its avatar at 22 px and name; with the group's own status line under it.                                                                                       |
| Goes and stays (`.c-goes`) | Two short lists under a page's actions, "Remove takes" and "It leaves", so Remove needs no screen of its own; each line 14 px.                                                                               |

### Access

Clawtrate asks for every scope at the first connection (`setup-effortless.md` §2), so an admin connection is the ordinary case. For a device paired before that:

| What                                                       | Tier  | Gateway                                                           |
| ---------------------------------------------------------- | ----- | ----------------------------------------------------------------- |
| See Tool servers, a server's page, its tool listing        | Read  | `config.get`, `tools.effective` (fact 1, 6)                       |
| Add, change, remove a server; choose its bots; set its key | Admin | `config.patch` (fact 1)                                           |
| Sign in: open the gateway's page, approve its browser      | Admin | `device.pair.code` on 2026.11.10, `device.pair.approve` (fact 10) |
| Sign out (2026.11.10)                                      | Admin | `mcp.authLogout` (fact 12)                                        |

Below admin, the access bar of `bots.md` §2 takes the place of the screen's action, with "Changing tool servers needs admin access." What the form holds is kept through the request. When `plugins.list.mutationAllowed` is `false` (the gateway's own settings are read-only, R§3), every page says "**This gateway's settings are read-only.** Tool servers can't be changed here." and shows no write and no request.

### Writing and reading back

Every write to a server is one `config.patch` (admin), and the screen says only what a fresh `config.get` shows (fact 1, fact 4):

1. **The revision reviewed.** The form, a confirmation or a page reads `config.get` when it opens and keeps its `hash`. That read is also where a taken name is found.
2. **One patch.** `raw: JSON.stringify(patch)` with `baseHash` set to that hash, never one read later. A server and its bots are one patch (section 4). An array that loses entries is named in `replacePaths` (fact 4).
3. **A changed revision.** The gateway refuses a stale hash (fact 1). The screen says "**The gateway's settings changed** while you were here. Check the server below and try again.", reads again, and shows the current entry. Nothing is sent again by itself.
4. **The read-back** compares the fields the person gave: the address, the transport, `auth`, the header names (values can't be compared: the gateway hides them, fact 3), or the program, every argument and the folder; and the bots' deny lists.

| The reply, then a fresh read                | The screen                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted, and the read matches              | The success line of that screen                                                                                                                                                             |
| Accepted, and the read differs              | "**Couldn't confirm the change.** The gateway has a different entry for notes." and the entry as read                                                                                       |
| No answer, or the read failed               | "Checking what the gateway has…", then the table again; if the read fails: "**Couldn't confirm the change.** The gateway's settings couldn't be read." with "Check again", which only reads |
| No answer, and the read matches             | "The gateway has notes with these settings." (the match can't say whose write it was)                                                                                                       |
| Refused, and the read shows nothing changed | "**Couldn't add notes:**" and the error in plain words (section 3, "Errors"), the field it names marked                                                                                     |

Only one write at a time per window: a second waits for the first's read-back.

### What asks

Clawtrate does what the person asked, shows what it did, and offers Undo. A question stays only for a destructive act: one that can't be undone, that concerns an account or credential, or that changes what runs inside OpenClaw. Every action of these slices is one of three:

| Action                                                                 | Outcome                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a server by address or as a program                                | Done at once; the result says what was added and which bots can use it, with **Undo** (section 4). For a program, the form and the result say what the gateway will run, where, and as whom     |
| Tick or untick a bot                                                   | Done at once; ticking again is the undo (section 5)                                                                                                                                             |
| Add a key to a server that has none                                    | Done at once, with **Undo**                                                                                                                                                                     |
| Try it with a bot                                                      | Not sent: the message waits in the field; sending is the person's own click and spends the bot's model                                                                                          |
| Remove a server with no key, headers or saved sign-in                  | Done at once, with **Undo** (section 7)                                                                                                                                                         |
| Remove a server with a key or headers, or (2026.11.10) a saved sign-in | Asks: the key or sign-in can't be put back (section 7)                                                                                                                                          |
| Replace a server's key                                                 | Asks: the old key can't be put back, because the gateway never shows it                                                                                                                         |
| Sign in                                                                | The sign-in is the person's own act on the service's page. Approving the browser for the gateway (2026.11.10) asks, in the approve prompt: it lets a new device control the gateway (section 6) |
| Copy the gateway's secret (2026.10.6)                                  | The button is the person's own act of handing it over; no second question (section 6)                                                                                                           |
| Sign out (2026.11.10)                                                  | Asks: it ends a sign-in that only the service's page can make again (section 6)                                                                                                                 |
| Add an app from the catalog                                            | Asks: it installs code into OpenClaw (section 8)                                                                                                                                                |
| Turn an app off or on                                                  | Done at once; the other is the undo (section 9)                                                                                                                                                 |
| Remove an app                                                          | Asks: its settings go and can't be put back (section 9)                                                                                                                                         |
| A bot asking in the conversation to be connected to something          | The design of a bot's tools on Clawtrate decides it (section 10)                                                                                                                                |

There is no setting that turns asking on or off.

### Gateway text is text

Every string the gateway or a server supplies (a server's name, a tool's name and description, an error, a notice) is inserted as text in every position, never as markup, and values in attributes are encoded for their context. No address a server or the gateway supplies is fetched or opened (`docs/decisions.md`, "Addresses a gateway hands the client"); the only address Clawtrate opens in slice 1 is the gateway's own Settings page, on the person's click (section 6).

### Announcements

One polite live region per window, after the read-back only: "Added notes", "Couldn't add notes", "Pip can use notes", "Otto can't use notes now", "Removed notes", "Browser approved", "Checking what the gateway has". Nothing is announced on a click alone.

### Input

- Settings is a modal dialog (`bots.md` §7): Tab stays inside; Escape closes the topmost layer (a confirmation, then the window); focus returns to the control that opened it.
- A confirmation puts focus on Cancel. Tab and Shift-Tab stay inside it.
- The kind of server ("By address", "Runs a program") is a radio group with one tab stop; Left and Right move and choose.
- The bots are checkboxes; Space toggles. Each change is written at once (section 5).

## 3. Slice 1: Settings, Tool servers

A section of Settings, after Integrations. It reads `config.get` `mcp.servers` (fact 1) and, for the state words, the most recent task of each chosen bot through `tools.effective` (fact 6).

| State                                | It shows                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                              | Three grey rows, `aria-busy`                                                                                                                                                                      |
| None                                 | "**No tool servers yet.** A tool server gives your bots tools from another app or service. Add one by its address, or as a program on the gateway's machine." and **Add a tool server** (primary) |
| Some                                 | One row each, sorted by name, then **Add a tool server**                                                                                                                                          |
| Couldn't load                        | "**Couldn't load the gateway's settings.**" and the reason, with "Try again"                                                                                                                      |
| The gateway's settings are read-only | The note of section 2, and the rows, with no Add                                                                                                                                                  |

**A row's state word**, from the tool listings of the bots that can use it (section 5, "Reached"): "8 tools" (neutral), "Not reached yet", "Needs sign-in" or "Needs a key" (warn), "Can't reach it" (danger), "Turned off" for `enabled: false`. A row with no bot that can use it says "No bots" in place of the bots. A plugin's server (slice 2) is not listed here; `t3code` is, as in section 1.

### Errors, in plain words

The gateway's error is translated where its meaning is known, and given as text under "Details" otherwise:

| The gateway says                                                                          | The screen says                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config base hash required` / `config changed since last load`                            | "The gateway's settings changed while you were here. Check the server below and try again." (never shown for a missing hash: Clawtrate always sends one) |
| `… url: Invalid URL` / `Expected http:// or https:// URL`                                 | "That isn't a server address. It starts with https://." on the Address field                                                                             |
| A mixed entry refused (2026.11.10, fact 5)                                                | Not reachable: the form writes one kind only                                                                                                             |
| `missing scope: operator.admin`                                                           | The access bar                                                                                                                                           |
| `Another plugin or config operation is already running`                                   | "The gateway is busy with another change. Try again in a moment." with "Try again"                                                                       |
| A listing diagnostic `ECONNREFUSED`, `fetch failed`, `ENOTFOUND`                          | "**The gateway can't reach notes.** Check that the server is running and that the gateway's machine can reach notes.example."                            |
| A listing diagnostic `authentication refused (401)`                                       | "**notes refused the gateway.** It needs a key or an account sign-in." with "Add a key" and "Sign in with an account"                                    |
| A listing diagnostic `spawn … ENOENT`                                                     | "**The gateway couldn't start the program.** /opt/example/bin/search-server isn't on the gateway's machine."                                             |
| A listing that hides an OAuth server's tools after a refused sign-in (2026.11.10, fact 6) | "**notes needs you to sign in again.**" and **Sign in**                                                                                                  |
| Anything else                                                                             | "**Couldn't <what was being done>.**" and the gateway's message as given, under "Details"                                                                |

## 4. Slice 1: Adding a tool server

**Add a tool server** opens one form in the section, with Back. It reads `config.get` when it opens (section 2, step 1).

| Field                    | Rule                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind                     | "By address" (default) or "Runs a program on the gateway's machine". A radio group                                                                                                                                                                                     |
| Address (by address)     | Required. Must be `https://`: "Enter the server's address." when empty; "That isn't a server address. It starts with https://." when it doesn't parse or isn't https (the gateway accepts `http` too, fact 1; Clawtrate's rule is narrower, F-221)                     |
| Name                     | Filled in from the address's host, first label, lowercased (`notes.example` → `notes`), until the person edits it. Letters, digits, `-` and `_`. Taken: "There's already a server named notes. Choose another name." The name bots see in tool names (`notes__search`) |
| Sign-in (by address)     | A checkbox, "Sign in with an account (OAuth)", off. On: `auth: "oauth"`. There is no client ID or secret: the gateway has no field for either (fact 1)                                                                                                                 |
| Key (by address)         | Optional password field. Saved as `Authorization: Bearer <key>`. Under it: "The gateway keeps the key in its settings file, unencrypted. Clawtrate can't show it again." **More** opens free header rows (name and value)                                              |
| Program (runs a program) | Required: "Enter the program to run." Trimmed at both ends                                                                                                                                                                                                             |
| Arguments                | One per line. Each line is one argument, trimmed at its ends; spaces inside stay; empty lines are dropped; no shell                                                                                                                                                    |
| Folder                   | Optional, trimmed; empty means no `cwd`                                                                                                                                                                                                                                |
| Bots                     | The bot choice (section 2): every bot ticked when the form is opened from Settings, only that bot when it is opened from a bot's settings (D2). Under it: "Each bot ticked can use every tool notes offers. What each may do with them is in its settings."            |

**Add** (primary) writes one patch (section 2):

```
{ mcp: { servers: { notes: entry } },
  agents: { entries: { otto: { tools: { deny: [...its deny, "notes__*"] } } } } }   // one per bot left out
```

| Kind           | `entry`                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| By address     | `{url, transport: "streamable-http"}`, plus `headers` with the key or headers given, plus `auth: "oauth"` when ticked |
| Runs a program | `{command, args, cwd?}`, `args` always an array (`[]` when none)                                                      |

When a bot left out has a tool allowlist that names the server, or a chosen bot has one that leaves it out, the patch says so in the bot choice's status line instead of writing an allow (section 5, "Withheld").

**What a program server does**, said on the form as soon as a program is typed, under the Bots, and repeated in the result, with nothing to confirm (section 2, "What asks"):

> Adds a server that the gateway starts on studio's machine when a bot needs it, as the user the gateway runs as: `/opt/example/bin/search-server`, with `--stdio` and `--index ./notes` (each argument on its own line, in mono), in `/srv/notes`. It can read and change what that user can, and reach the network. The gateway's settings show the program and its arguments to anyone who can read them, so don't put a key in them.

The machine is the gateway's name as this device knows it, or "the gateway's machine". The line shows the reviewed values (trimmed, empty argument lines dropped), and those values, no others, are what the patch writes and the read-back compares.

**The result**, after the read-back:

| Ending                  | It shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Added, the read matches | "**Added notes.** Pip can use it." (or "Pip and Otto can use it.", or "No bot can use it yet."), with **Try it with Pip** (primary; the first chosen bot), **Open notes** and **Undo**, which takes the entry and its rules back out with the same read-back. For a program, the line of "What a program server does" follows. With a key: "The gateway hides the key; Clawtrate can't show it again." With OAuth ticked: **Sign in** is primary instead, and Try it follows sign-in |
| Each other ending       | Section 2's table                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Try it with Pip** opens a new task with Pip and puts "What can you do with notes?" in the message field, with the cursor at its end. It sends nothing (section 2, "What asks"). After the turn, the server's page shows Pip's listing (section 5).

## 5. Slice 1: A tool server's page

Opening a row shows the page, with Back.

**Facts** (`.facts`), from `config.get` as read:

| Row     | Value                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name    | `notes` (mono)                                                                                                                                                               |
| Kind    | "By address" or "Runs a program on the gateway's machine"                                                                                                                    |
| Address | `https://notes.example/mcp`                                                                                                                                                  |
| Key     | "Saved. The gateway hides it." with **Replace key**, or **Add a key**; other headers by name                                                                                 |
| Sign-in | "With an account (OAuth)", or "None" with **Sign in with an account**; for an entry made elsewhere with per-requester identity: "Each person signs in from a chat" (slice 3) |
| Program | The program and each argument, in mono, as saved; the folder when set                                                                                                        |

**Reached.** For each chosen bot, Clawtrate reads `tools.effective` for that bot's most recent task and matches tools by `mcpServer` and notices by their `servers` (fact 6). The block shows the best of them and names the task and the time it was read:

| The listings say                                                                            | The block says                                                                                       |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Tools from this server in some chosen bot's task                                            | "**Reached in Pip's task** at 5:12 PM: 8 tools", and the tool names and descriptions folded under it |
| `mcp-stale-catalog`, `mcp-not-yet-connected` or `mcp-not-yet-listed` for it, or no task yet | "**Not reached yet.** The gateway connects to notes the next time Pip runs." and **Try it with Pip** |
| `mcp-server-diagnostic` for it                                                              | The plain words of section 3, "Errors", and the gateway's message under "Details"                    |
| No chosen bot                                                                               | "No bot can use notes." and the bot choice                                                           |
| The read is refused                                                                         | "Couldn't read Pip's tool listing." and "Check again"                                                |

Under it, always: "This is what the gateway listed for that task when it was read. A bot's own tool rules still decide which of these it may call." The listing is never called "Connected" or "Working": it is the gateway's listing at one moment, not a test of the server (fact 6).

**Bots**, the bot choice, every bot on the gateway:

- Each checkbox reflects `agents.entries.<id>.tools.deny` as read: ticked unless the deny names `notes__*` (or `notes__…` tools that cover every tool listed).
- Changing one writes at once: unticking adds `notes__*` to that bot's deny; ticking removes it, naming the deny list in `replacePaths` (fact 4). The checkbox shows "Saving…", then the read-back, announced ("Otto can't use notes now"). A refusal puts it back with "Couldn't change Otto: <plain words>."
- **Withheld.** When a ticked bot's listing has none of the server's tools while another bot's does, or its rules allow only named tools (`tools.allow`) and leave the server out, the line under it reads "Otto's tool rules don't offer notes's tools." with "Open Otto's rules" (`controls.md` §4). Clawtrate doesn't widen a bot's allowlist from here (fact 7).
- For a program server, the line under the group reads: "Each bot ticked can have the gateway start /opt/example/bin/search-server." Ticking more bots later asks nothing (section 2, "What asks").

**Actions:** **Try it with <first chosen bot>**, **Sign in** (OAuth entries, section 6), **Sign out** (2026.11.10, section 6), **Remove** (section 7). A row for `t3code` opens `bots.md` §16 instead.

## 6. Slice 1: Signing in

For an entry with `auth: "oauth"` that is enabled, shared (no `oauth.identity: "per-requester"`) and has no `oauth.authProfileId` (fact 9).

**Why the gateway's page.** The gateway starts an account sign-in only for a connection that comes from a browser (fact 8). Clawtrate reaches the gateway as its own app, with no browser origin, and never presents itself as a browser. The gateway's own Settings page is a browser page, and it signs in to a server in `mcp.servers` (fact 9). So Clawtrate opens that page, makes sure the browser may use it, and the gateway does the rest.

**Sign in** (admin) has four parts.

**The address.** Clawtrate opens `<the gateway's page address>/settings/mcp` (under the page's base path when one is configured) in the system browser. The page address is the one the gateway accepts for sign-in (fact 9): its `https` address or Tailscale address when the host knows one, or `http://127.0.0.1:<port>` when the gateway is on this computer or reached through an SSH forward (proposed for the forward, section 15). With none of these, the button is replaced by "**Signing in needs the gateway's page in a browser.** This gateway has no address a browser can sign in from. Give it an https or Tailscale address in its settings." and nothing opens.

**While the browser is out**, the section shows the steps, in the forms of `bots.md` §5: "On the gateway's page, find notes and choose **Sign in**.", "Approve access on the page notes.example shows." and "Come back here.", with **Open the gateway's page again** and **I'm back**.

**The browser's first visit.** The gateway lets a browser use its page only once it is connected and approved (fact 10). Clawtrate takes care of both:

| Version    | What the page asks                                   | What Clawtrate shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026.11.10 | "Pair this browser", then a code such as `ABCD-EFGH` | "**If the gateway's page shows a code,** enter it here." One input, formatted as typed. On a full code, `device.pair.code {code}` reads the request; the approve prompt of `setup-effortless.md` §5 shows what the browser reported (marked "reported"), its address as the gateway saw it, and "Gets full control of the gateway, as this app has." **Approve** sends `{code, requestId, decision: "approve"}`; "Not this one" rejects. "Browser approved. It connects by itself."                                                                                          |
| 2026.10.6  | "Gateway secret"                                     | "**If the gateway's page asks for its secret,** paste it there." with **Copy the gateway's secret** when the host holds the shared token (a gateway on this computer, read by `setup-effortless.md` §3's settings reader). "Copied. Paste it on the gateway's page. Clawtrate clears the clipboard in 60 seconds if it still holds it." Without it: "Paste the gateway's secret, from where you keep it." On a loopback address the gateway then approves the browser by itself; otherwise Clawtrate's approve prompt (`setup-effortless.md` §5) shows the browser's request |

The gateway's errors are shown in plain words: "This code has expired. Choose Pair this browser again on the gateway's page." and "No browser is waiting for this code. Check the code on the gateway's page." (fact 10). A code is approved only after the prompt shows what asked; it is never approved from the field alone.

**I'm back.** Clawtrate cannot read whether the gateway saved the sign-in: no method reports a server's sign-in state (fact 11). So it re-reads the listing and says what is known: "**The gateway's page signs in for every bot that can use notes.** Pip gets its tools on its next message." with **Try it with Pip**. After the next turn, the Reached block shows the tools, or "notes still refuses the gateway" with **Sign in** again.

**Sign out** (2026.11.10 only, admin) asks once (role `alertdialog`, focus on Cancel): "**Sign out of notes?** Every bot that uses it loses its tools until someone signs in again on the gateway's page." [Cancel] [Sign out]. Then `mcp.authLogout {serverName}` clears the gateway's saved sign-in (fact 12): "Signed out of notes. Bots that use it need a new sign-in." On 2026.10.6 there is no such method, so there is no Sign out; removing the entry leaves the sign-in (section 7).

## 7. Slice 1: Removing a tool server

On the server's page, under the actions, a line says what Remove does, so the button needs no screen of its own:

| Version    | Goes                                                                                               | Stays                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 2026.11.10 | The server's entry with its key and headers; its tools, for every bot; its saved sign-in (fact 13) | Nothing: Clawtrate also takes notes out of each bot's rules                                                                     |
| 2026.10.6  | The server's entry with its key and headers; its tools, for every bot                              | Its saved sign-in, in the gateway's state, unencrypted (fact 13). Adding a server with the same name and address finds it again |

**Remove**, by what it loses (section 2, "What asks"):

| The server has                                    | Remove                                                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No key, no headers, and no saved sign-in to lose  | Removes at once. "**Removed notes.**" with **Undo**, which writes the entry and the bots' rules back as they were read, with the same read-back. Undo lasts while the section is open                                                              |
| A key or headers, or (2026.11.10) `auth: "oauth"` | One question (role `alertdialog`, focus on Cancel): "**Remove notes?** Its key goes with it, and Clawtrate can't put it back: the gateway never shows a saved key." and, on 2026.11.10 with OAuth, "Its sign-in goes too." [Cancel] [Remove notes] |

The write is one patch: the entry `null` (with `replacePaths` for each array field of the entry, fact 4), and `notes__*` taken out of each bot's deny, naming those lists. After the read-back: "**Removed notes.** The gateway's settings no longer have it." only when the read finds no entry; "notes is still in the gateway's settings." with "Try again" when it does; section 2's table otherwise. Focus moves to the next row of Tool servers, or to Add when none is left.

## 8. Slice 2: Connect apps, Browse and Add

Slice 2 carries forward the catalog design reviewed twice in November, with every finding of those reviews applied (`docs/research/connectors.md` §2 to §4). Its states are listed here; its words follow the slice 1 rules above.

**The window.** The rail footer's "Connect apps" (F-030) opens it, the Settings frame at 800 × 640, with two sections: **Browse** and **On this gateway**. On this gateway lists installed plugins (Turned on, Turned off, and "Comes with OpenClaw (64)" folded) and ends with "Tool servers: 3" opening section 3.

**Browse** asks `plugins.catalog.browse {}` and `{intent: "featured"}` together (fact 18):

| State                              | It shows                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                            | The search field, three grey chips and four grey rows, `aria-busy`; after 4 s, "Still loading. The gateway is asking the catalog."                                                                                      |
| Loaded                             | "Search apps and skills"; chips, "All" first, then the categories in `order`; "Featured" with the featured rows; "All apps"                                                                                             |
| The overview has `remoteError`     | "**The catalog can't be reached from the gateway.** You can still see what's on this gateway." with "Try again" and the gateway's message under "Details"; no chips, no Featured, no Add; the rows the gateway returned |
| Only featured or categories failed | The overview's rows and their Add, with "Featured didn't load." or "Categories didn't load." in that group only                                                                                                         |
| Refused                            | "**Couldn't load the catalog.**" and the reason, with "Try again"                                                                                                                                                       |

A row has the initial, name, summary and, by `local`: **Add** (`action: "install"`), "Added", "Turned off", "Needs setup" (warn), "Not working" (danger), or "Not available". Search asks `browse {query}` and `skills.search {query}` after 300 ms; each group says which source answered, and a source that failed never reads as "No match". `nextCursor` gives "Show more".

**An app's page** (`plugins.catalog.get`): the initial at 56 px, name, author, "Official" when the catalog says so, summary; "What it adds" (its servers, "signs in with an account" where `auth: "oauth"`, its skills, required settings); "About" (the readme as plain text, twelve lines, then "Show all"; version; verification and security as given). A failed detail read: "**Couldn't load this app's details.**" with "Try again" and no Add.

**Add** is a plugin install, which puts code into OpenClaw on the gateway's machine. That can't be taken back cleanly, so it asks once (section 2, "What asks"):

> **Add Quillnote to studio?**
> Package `@quillnote-labs/quillnote` from ClawHub, version 2.4.1 (or "The gateway picks the release.").
> The gateway installs this package on its machine and runs it with the gateway's access. Every bot that isn't left out can use its tools.
> [Cancel] [Add]

The request comes from the catalog row's `local.install`, or `{source: "clawhub", packageName}` for a remote-only row, with `detail.selectedRelease.version` when given (R§3). An install-policy warning is shown with its findings and needs a new click, "Add anyway", that sends `acknowledgeInstallPolicyWarning: true` on the same request. Progress shows the six stages of `plugins.install.progress`; nothing cancels an install. The ending comes from a `plugins.list` read-back: "**Added Quillnote.** The gateway lists it as installed and turned on." (with "The gateway says it needs a restart." when `restartRequired`), "Couldn't add Quillnote:" and the reason, "Quillnote was installed but didn't start:" and the reason, or "Couldn't confirm the install." with "Check again". After Add, the app's bots are chosen on its page as in section 5, on the tools it lists.

## 9. Slice 2: An app's page, accounts, turning off, removing

An installed plugin's page reads `plugins.list`, `plugins.inspect` and, when it came from the catalog, `plugins.catalog.get`.

| The gateway reports                        | The page says                                                                                                   | Actions          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| `enabled`, `runtime.state: "active"`       | "Added"                                                                                                         | Turn off, Remove |
| `enabled`, `runtime.state: "unloaded"`     | "Added. The gateway reports it isn't loaded."                                                                   | Turn off, Remove |
| `disabled`                                 | "Turned off."                                                                                                   | Turn on, Remove  |
| `needs-setup`                              | "Needs setup on the gateway's page." and the missing fields the gateway names, with **Open the gateway's page** | Remove           |
| `error`, `runtime.state: "service-failed"` | "Not working:" and the error as given                                                                           | Turn off, Remove |
| `removable: false`                         | No Remove; for `origin: "bundled"`, "Comes with OpenClaw, so it can be turned off but not removed."             |                  |

**Accounts.** For each `plugins.inspect` `mcpAuth` row: the server's name, "Shared by everyone on this gateway", and "Needs sign-in." (`unauthenticated`), "Needs sign-in again." (`requires-authorization`), "Sign-in pending." (`pending-authorization`) or "Signed in. The gateway reports saved sign-in tokens." (`authorized`). A declared OAuth server with no row: "Sign-in status not reported." **Sign in** opens the plugin's page on the gateway (`/plugins/<id>`, its Accounts) by section 6's route; after "I'm back", Clawtrate reads `plugins.inspect` again, so a plugin's account, unlike a tool server, shows its new state. **Sign out** (2026.11.10) asks as in section 6, then calls `mcp.authLogout` on that server (fact 12). No method adds a second account to a plugin's server.

**Turn off** writes `plugins.setEnabled {enabled: false}` at once (Turn on is its undo) and reads back: "Turned off. Its settings and any saved sign-ins stay." **Turn on** the same.

**Remove** asks once (role `alertdialog`, focus on Cancel; section 2, "What asks"), with what goes and what stays in the question: Goes, the package's files, its settings, its tools, and on 2026.11.10 the saved sign-ins for its servers (fact 14); Stays, on 2026.10.6, any saved sign-ins, and on both, the gateway's off marker for it. The package can hold several plugins; the page names the ones `plugins.list` shows with it. After `plugins.uninstall`, a fresh `plugins.list` decides each: "No longer installed" (absent or `installed: false`) or "Still installed".

## 10. Slice 3: A sign-in in the conversation, and bots that connect things

**The connect card.** For a server with `oauth.identity: "per-requester"`, the gateway gives a bot a `<server>__connect` tool; its live result carries `details.mcpConnect {serverName, authorizationUrl}` (fact 16). Only then is the action card (`conversation.md` §8.3) a connect card: "**team-notes asks for a sign-in**", the sign-in address in full as text with **Copy sign-in address**, "To sign in, copy this address into a browser.", and "After you sign in, ask Pip again." The gateway sees every device that uses Clawtrate as one sender, so the card also says "This sign-in is shared by everyone who uses this gateway from Clawtrate." (R§7). History keeps no `mcpConnect`, so a reloaded task shows the ordinary card with the tool's name and its text, and no copy action. Opening the address from the card needs a row in `docs/decisions.md`, "Addresses a gateway hands the client", that names it; slice 3 starts with that decision. A per-requester entry also needs `gateway.publicOrigin`; without it the card says "**team-notes can't ask for a sign-in here:**" and the gateway's message.

**Where this meets a bot acting on Clawtrate.** What happens when a bot is asked in the conversation to connect something ("add my notes server"), and when a bot is asked what it can reach, belongs to the design of a bot's tools on Clawtrate (issue #669, `docs/design/bots-in-clawtrate.md`). This design supplies what that one needs: the same entry, bots and read-back as section 4, the same "What a program server does" line, and the facts of section 5 (the servers a bot isn't left out of, and the gateway's listing for its task). A bot never writes `mcp.servers` through any path this design adds.

## 11. Slice 4: What do you use every day?, and the iPhone

- **What do you use every day? (F-004).** Not a dialog: the first time Connect apps opens on this device, Browse begins with "What do you use every day?", "Pick the apps you use. Nothing is connected now; they come first here.", up to twelve of the catalog's featured apps to tick, and "Done". The ticks stay on this device and lead Browse as "You picked"; "Done" or leaving folds the block away for good on this device. When the catalog can't be reached or featured is empty, the block isn't shown, and it is shown the first time the catalog answers. Nothing interrupts the person to ask it.
- **The iPhone (F-380).** From the avatar menu, "Connect apps" opens the same window as one pane at a time, titled "Plugins": "Search plugins", the chips, "Featured" and rows with "Added" or "Add". Adding a tool server is on the desktop only; on the iPhone a server's page reads and says "Change it from Clawtrate on your computer." Choosing bots works on both.

## 12. Widths, themes, keyboard, screen readers

- **1440, 1100 and 800:** Settings is 800 × 640 (at 800, the window's width less 48 px); the section list is 208 px; the form's fields are 480 px at most.
- **390, one pane:** a sheet the height of the screen less 8 px; the section list is one pane and a section another, with Back. Rows are 72 px. A question (section 2, "What asks") is a card at the foot. The add form's Add button stays above the keyboard.
- **Themes:** dark by default, light offered; every surface is a token.
- **Keyboard:** everything in reading order; the kind is one tab stop; Escape closes the topmost layer; after Add the focus goes to the result's first action; after Remove, to the next row.
- **Screen readers:** a row is "<name>, <state>, <bots>"; the initial is decorative; the Reached block is a region named "Reached"; the live region's words are in section 2.
- **Reduced motion:** grey rows don't shimmer; the waiting dot doesn't pulse.

## 13. The gateway's facts, on both versions

Sources: `<10.6>` and `<11.10>` are the `openclaw` npm packages of those versions, `dist/` read without running anything; 2026.10.6 chunks are formatted, so lines are given, and 2026.11.10 chunks are minified to a line or two, so the symbol is given. "Run" is the probe of `docs/research/connectors/probe.ts` on a development gateway of that version (R§9). R§n is the research note.

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                            | 2026.10.6                                                                                                                                           | 2026.11.10                                                                                                                                                                                                                              | Drives                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | A tool server is an entry under `mcp.servers.<name>`, gateway-wide. It is added, changed and removed with `config.patch` (admin) and its `baseHash`; no other method writes one. A stale or missing hash is refused; a write to a name that exists replaces that entry, so the client checks names itself. No client ID or secret fields; `http` and `https` addresses accepted | Established: run (R§5); `<10.6>/dist/config-Bo7RGaun.mjs` lines 235-247, 689-746; method list `core-method-policy-DkntKRY_.mjs`                     | Established: run (R§9); method list `core-method-policy-DeU1xgVA.mjs`, which adds only `mcp.authLogout` and `mcp.events.list` among `mcp.*`; `config-BdqwXM6Q.mjs` "config base hash required"                                          | Sections 2, 4                  |
| 2   | A change applies without a restart; the next turn's discovery uses the new entry                                                                                                                                                                                                                                                                                                | Established: run (R§5)                                                                                                                              | Established: `<11.10>/docs/tools/mcp.md` line 42; run (R§9)                                                                                                                                                                             | Sections 4, 5                  |
| 3   | `config.get` hides header values (`__OPENCLAW_REDACTED__`) and shows a program and its arguments                                                                                                                                                                                                                                                                                | Established: run (R§5, §6)                                                                                                                          | Established: run (R§9)                                                                                                                                                                                                                  | Sections 4, 5                  |
| 4   | `null` removes an entry; an array that loses entries must be named in `replacePaths`                                                                                                                                                                                                                                                                                            | Established: run (R§5); `config-Bo7RGaun.mjs` lines 367-374                                                                                         | Established: `config-BdqwXM6Q.mjs` "would remove entries from array path(s)"; run (R§9)                                                                                                                                                 | Sections 2, 5, 7               |
| 5   | An entry with both an address and a program                                                                                                                                                                                                                                                                                                                                     | Accepted (run, R§9)                                                                                                                                 | Refused for new or edited entries: `<11.10>/docs/tools/mcp.md` line 131; run (R§9)                                                                                                                                                      | Section 4 writes one kind only |
| 6   | A server's tools are known only from `tools.effective {sessionKey}` for one task, after a run discovers them: tools carry `mcpServer`; notices `mcp-stale-catalog`, `mcp-not-yet-connected`, `mcp-not-yet-listed`, `mcp-server-diagnostic`. No method lists a server's tools before a run (`mcp.app.listTools` needs an open app view)                                          | Established: `tools-effective-VKbyCQ9I.mjs` lines 179-203, 239-285; `mcp-app-BdEDkVxk.mjs` `operationHandler`; run (R§5)                            | Established: `tools-effective-t16zsqin.mjs` (same notice names); `mcp-app-BHc6vLiE.mjs`; `<11.10>/docs/tools/mcp.md` lines 63-69 (a refused OAuth server's tools are hidden, with sign-in guidance in its diagnostic); run (R§9)        | Sections 3, 5; D4              |
| 7   | A server reaches every bot whose tool rules allow it; `agents.entries.<id>.tools.deny` with `<server>__*` leaves one bot out; an allowlist can withhold it, and a bot's own `tools.allow` doesn't reach past the gateway's                                                                                                                                                      | Established: run (R§9), and the earlier deny run (R§5); `<10.6>/docs/tools/mcp.md` line 10                                                          | Established: run (R§9); `<11.10>/docs/tools/mcp.md` line 10; no per-bot server key in the config schema                                                                                                                                 | Section 5; D2                  |
| 8   | `mcp.authLogin` needs admin and a browser origin; Clawtrate's connection has none and is refused                                                                                                                                                                                                                                                                                | Established: `mcp-auth-login-DAnddU_m.mjs` lines 19-44; run: "Open Settings on this Gateway to sign in, or use openclaw mcp login in its terminal." | Established: `mcp-auth-login-B4KXgtBN.mjs` (`browserOrigin`); run: "Open Settings on this Gateway to sign in, or sign in from its terminal: stop the Gateway …" (`mcp-oauth-identity-CYclCFmF.mjs` `mcpOAuthCliLoginSteps`)             | Section 6; D1                  |
| 9   | The gateway's Settings page (`/settings/mcp`) signs in to an enabled shared HTTP OAuth entry of `mcp.servers`, from its HTTPS, loopback or Tailscale address                                                                                                                                                                                                                    | Established (docs): `<10.6>/docs/tools/mcp.md` lines 145-149; `docs/cli/mcp/control-ui.md` line 14                                                  | Established (docs): `<11.10>/docs/tools/mcp.md` lines 200-206; `docs/cli/mcp/control-ui.md` line 14                                                                                                                                     | Section 6                      |
| 10  | A browser on the gateway's page needs the gateway's secret on its first connection; on loopback the gateway then approves it by itself. 2026.11.10 adds "Pair this browser": a code that an admin connection approves with `device.pair.code`                                                                                                                                   | Established (docs): `<10.6>/docs/web/control-ui.md` line 246; `docs/web/control-ui/connect-and-pair.md` line 60                                     | Established: `device-pair-code-CmW0vXto.mjs` (inspect `{code}`, decide `{code, requestId, decision}`, the refusal texts); `<11.10>/docs/web/control-ui/connect-and-pair.md` lines 79-110; run: unknown code refused (R§9)               | Section 6                      |
| 11  | No method reports a server's sign-in state; `plugins.inspect` `mcpAuth` covers a plugin's servers only. Plugins have no MCP sign-in interface in the SDK                                                                                                                                                                                                                        | Established: `mcp-auth-status-lGLhpwWr.mjs` lines 55-78; package `exports`                                                                          | Established: `mcp-auth-status-pBlVj9_H.mjs` `readPluginMcpAuthStatus`, used only by `management-service-B6thU7KZ.mjs`; package `exports`                                                                                                | Sections 6, 9; D1              |
| 12  | Signing out of a shared server from the app                                                                                                                                                                                                                                                                                                                                     | No method (method list)                                                                                                                             | `mcp.authLogout {serverName}` (admin) clears it, for a config entry or a plugin's server: `mcp-auth-logout-8YiNRmac.mjs`; run (R§9)                                                                                                     | Sections 6, 9                  |
| 13  | Removing a shared OAuth entry through `config.patch`                                                                                                                                                                                                                                                                                                                            | Leaves its saved sign-in in the gateway's state (run, R§6)                                                                                          | Clears it when the new config is accepted, and when its address changes: `server-reload-managed-Bi1FqAcY.mjs` `onConfigAccepted` → `mcp-config-mutation-BQWWzVul.mjs` `clearRetiredMcpOAuth`, `clearReplacedMcpOAuth` (source; not run) | Section 7                      |
| 14  | Uninstalling a plugin                                                                                                                                                                                                                                                                                                                                                           | Leaves its servers' saved sign-ins (source, R§4)                                                                                                    | Removes them: `<11.10>/docs/tools/mcp.md` line 219; `mcp-auth-status-pBlVj9_H.mjs` `clearRemovedPluginMcpOAuth` (source)                                                                                                                | Section 9                      |
| 15  | A header's value is kept in the gateway's settings file unencrypted; a sign-in's tokens in its state database unencrypted                                                                                                                                                                                                                                                       | Established: run (R§6)                                                                                                                              | Proposed the same: not re-run (section 15)                                                                                                                                                                                              | Sections 4, 7; D5              |
| 16  | A per-requester server gives a bot `<server>__connect`; its live result carries `details.mcpConnect`; requesters are told apart by channel, account and sender                                                                                                                                                                                                                  | Established: `agent-bundle-mcp-requester-connect-DyJtQr4y.mjs` lines 7-37; `mcp-oauth-identity-0fgjEqV6.mjs` lines 12-19                            | Established: `agent-bundle-mcp-requester-connect-Dch3p9yO.mjs`; `mcp-oauth-identity-CYclCFmF.mjs` `requesterMcpOAuthIdentity`                                                                                                           | Section 10                     |
| 17  | Clawtrate connects as `gateway-client` in `ui` mode with no `Origin`, from the desktop host and the web preview's host alike                                                                                                                                                                                                                                                    | Established: `packages/core/src/client.ts`, `packages/core/src/node/index.ts` (R§7)                                                                 | The same client                                                                                                                                                                                                                         | Section 6                      |
| 18  | The catalog methods and their scopes                                                                                                                                                                                                                                                                                                                                            | Established: run without ClawHub (R§2); method list                                                                                                 | Established: same names and scopes in the method list; behaviour without ClawHub proposed the same (section 15)                                                                                                                         | Section 8                      |
| 19  | A program server runs on the gateway's machine, as the gateway's user, when a run needs it                                                                                                                                                                                                                                                                                      | Established: docs and run (R§5)                                                                                                                     | Established: `<11.10>/docs/cli/mcp/transports.md`; 2026.11.10 also cleans up a `docker run` server's container (lines 40-62)                                                                                                            | Section 4                      |

**Where 2026.11.10 differs, what the app does on each.** Clawtrate tells the versions apart by what the gateway sends: `hello-ok.features.methods` lists `mcp.authLogout` and `device.pair.code` on 2026.11.10. Where only the version tells (facts 5, 13, 14), it compares the gateway's own `hello-ok` `server.version` with `openClawAtLeast(version, 2026, 11, 10)`, the shared helper in `packages/core/src/gateway-version.ts`, which slice 1's first pull request adds if `main` doesn't have it yet.

| Difference                 | 2026.10.6                      | 2026.11.10                                              |
| -------------------------- | ------------------------------ | ------------------------------------------------------- |
| Browser's first visit (D1) | Copy the secret, paste it once | Enter the page's code; Clawtrate approves it            |
| Sign out                   | Not offered                    | **Sign out**                                            |
| Removing an OAuth server   | "Stays: its saved sign-in"     | "Goes: its saved sign-in"                               |
| Removing a plugin          | "Stays: any saved sign-ins"    | "Goes: the saved sign-ins for its servers"              |
| Mixed entry                | Not written by Clawtrate       | Not written by Clawtrate; the gateway refuses it anyway |

## 14. Parity rows

The rows as `docs/parity.md` has them after this design; every status stays `todo`.

| Row   | Slice | Target                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-221 | 1     | better: Settings, Tool servers, "Add a tool server" by address: Address, Name filled in from it, an optional Key and headers, "Sign in with an account", and the bots that get it, then Add. No Client ID or Secret. An empty or non-HTTPS address shows an error and saves nothing; the form says the key is kept unencrypted.                                                                |
| F-381 | 1     | better: "Runs a program on the gateway's machine": Program, Arguments and Folder, with a line that shows the exact program and arguments, the machine and the user it runs as, then Add, done at once with Undo. An empty program shows an error and saves nothing.                                                                                                                            |
| F-222 | 1     | unchanged (better: each bot's settings choose which connectors it may use); slice 1 makes it true for tool servers, from the server's page and the bot's.                                                                                                                                                                                                                                      |
| F-337 | 1     | unchanged; slice 1's deny is the gateway-enforced part.                                                                                                                                                                                                                                                                                                                                        |
| F-218 | 1, 2  | better: a tool server says what the gateway listed for a bot's task (its tools, Not reached yet, Needs sign-in, Needs a key, Can't reach it, Turned off), never "Connected"; an app says Added, Needs setup, Turned off or Not working, and each account Needs sign-in, Needs sign-in again, Sign-in pending, Signed in (saved tokens) or Sign-in status not reported. There is no team admin. |
| F-382 | 1     | better: signing in finishes on the gateway's own page, opened from Clawtrate, which approves the browser; back in Clawtrate, the bot gets the tools on its next message, and an app's account shows its new state.                                                                                                                                                                             |
| F-047 | 1     | unchanged; slice 1 adds the Tool servers line to a bot's settings.                                                                                                                                                                                                                                                                                                                             |
| F-217 | 2     | same                                                                                                                                                                                                                                                                                                                                                                                           |
| F-219 | 2     | same                                                                                                                                                                                                                                                                                                                                                                                           |
| F-383 | 2, 3  | same                                                                                                                                                                                                                                                                                                                                                                                           |
| F-220 | 3     | same                                                                                                                                                                                                                                                                                                                                                                                           |
| F-004 | 4     | better: the first time Connect apps opens, Browse begins with "What do you use every day?": the catalog's featured apps to tick, and Done. Ticking connects nothing, and nothing interrupts to ask it. It is not shown when the catalog can't be reached.                                                                                                                                      |
| F-380 | 4     | same                                                                                                                                                                                                                                                                                                                                                                                           |

The gateway dependency cell of each is in `docs/parity.md`.

## 15. Not established, and what would establish it

| What                                                                                                             | Why it matters                                       | What would establish it                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A full sign-in through the gateway's Settings page on either version, against a server written for the test      | Section 6's whole route                              | A development gateway, a browser driven by the test on its loopback page, and a stand-in OAuth server on loopback: pair the browser (code on 2026.11.10, secret on 2026.10.6), Sign in, then a bot's listing |
| A browser reaching the page through an SSH forward, and being accepted for sign-in                               | Section 6, step 1, for a gateway on another computer | The same test with the page opened at a forwarded loopback port                                                                                                                                              |
| Removing a signed-in server clears its sign-in on 2026.11.10 (fact 13), and uninstalling a plugin does (fact 14) | Section 7's and 9's Goes and Stays                   | After the sign-in test, remove the entry, then add the same name and address and read the bot's listing: tools without a new sign-in mean it stayed                                                          |
| Header values and tokens unencrypted on 2026.11.10 (fact 15)                                                     | The Key field's line                                 | The same test, reading the development gateway's own files after the write                                                                                                                                   |
| Which bot's latest task is read for "Reached" when a bot has many                                                | Section 5's choice of task                           | Proposed: the task with the latest activity by `sessions.list`; a builder's check with two tasks                                                                                                             |
| The catalog without ClawHub on 2026.11.10, and any catalog with ClawHub                                          | Slice 2's states                                     | The fenced development gateway of 2026.11.10, then a permitted catalog fixture when slice 2 is built                                                                                                         |
| A connect card from a real run                                                                                   | Slice 3                                              | A scripted model that calls `<server>__connect` on a development gateway with `gateway.publicOrigin` on loopback                                                                                             |
| How the host learns the gateway's page address for a gateway on another computer                                 | Section 6, step 1                                    | Proposed: `gateway.identity.get` and the host's own route; a builder's check on each route the host supports                                                                                                 |

## 16. For builders: slices, calls, rows and pull requests

### Slice 1: a tool server, from adding it to seeing it work

| Part            | Gateway                                                                                                                                                      | Rows                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Tool servers    | `config.get`; `tools.effective` per chosen bot's latest task                                                                                                 | F-218 (servers)            |
| Add             | `config.get` (hash, names), one `config.patch` with the entry and the bots' denies, `config.get`                                                             | F-221, F-381, F-222        |
| A server's page | `config.get`, `tools.effective`, `config.patch` for bots and the key                                                                                         | F-218, F-222, F-337, F-047 |
| Sign in         | the gateway's page in the system browser; `device.pair.code` (2026.11.10), `device.pair.approve` (2026.10.6, not on loopback); `mcp.authLogout` (2026.11.10) | F-382                      |
| Remove          | one `config.patch` with `null` and the bots' denies, with `replacePaths`; `config.get`                                                                       | F-221, F-381               |

The engine supplies: the reviewed hash per write; one write at a time; the Reached computation over the chosen bots' tasks; gateway strings as text; the host supplies the gateway's page address and opens it, and copies and clears the secret on 2026.10.6.

Pull requests, each small enough to review alone, in this order:

1. **Core: tool servers, read-only.** `packages/core` reads `mcp.servers`, the bots' denies and each chosen bot's listing, and computes each server's state word and Reached block; unit tests on the listing shapes of both versions.
2. **Settings, Tool servers, read-only.** The section, the rows and a server's page, with no writes; the access bar; the read-only gateway note. Visual checks at 1440 and 390, dark and light.
3. **Add by address, and Remove.** The form, the one patch, the read-back table, the result with Try it; Remove with Goes and Stays per version.
4. **Bots on a server's page and in a bot's settings.** The checkboxes' writes and read-backs; the Withheld line; the Tool servers line in a bot's settings (F-047).
5. **A program on the gateway's machine.** The kind, its fields and the line saying what it runs.
6. **Sign in and sign out.** The page address from the host, the steps, the browser's first visit on each version, I'm back, and Sign out on 2026.11.10. Its first commit is the test of section 15's first row, on a development gateway of each version.

### Slice 2: apps

1. Connect apps, Browse and the catalog's failures, read-only. 2. An app's page and On this gateway, read-only, with Accounts. 3. Add, its question, progress and read-back. 4. Turn off, Turn on, Remove. 5. Sign in to an app's account by section 6's route. Rows F-217, F-218, F-219, F-030.

### Slice 3: in the conversation

1. A row in `docs/decisions.md` for the connect card's address, first. 2. The connect card and its history form. 3. With `bots-in-clawtrate.md`: a bot's proposal opening section 4's form. Rows F-220, F-383.

### Slice 4

1. "What do you use every day?" (F-004). 2. The iPhone's Plugins sheet (F-380).

### Prototype

`prototype/connectors.html`, with its state in the address (`prototype/README.md`); `prototype/css/connectors.css`, `prototype/js/connectors.js`, and `prototype/tools/checks/connectors.mjs`, which walks every state of slice 1 and the Browse, offline, app page, Add and account states of slice 2 at 1440, 1100, 800 and 390, dark and light. Its fixture keeps one inventory: a confirmed add, removal or bot change updates every list and page that shows it, and an unconfirmed one leaves them as they were. Captures are in `docs/screenshots/connectors-*.png`.

## 17. Not covered here

- What each bot may do with a server's tools, one tool at a time, and asking first: `controls.md` §4 and §5.
- T3 Code's own server, sign-in and limits: `bots.md` §15 to §18.
- Changing a server's address or program after it is added: Remove and Add again. The form filled in with its values is the next step.
- A server for one task only (2026.11.10 has per-task overrides): not designed.
- Interactive views a server can show (`mcp.app.*`): not designed.
- A skill's page and installing skills from the catalog.
- Device apps on the iPhone and the Mac (F-223, F-385): `device-node.md`.
