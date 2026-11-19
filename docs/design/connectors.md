# Connectors

How a person finds and adds apps for their bots (the catalog, "Connect apps"), what a connector's page says about it and its sign-in, how a sign-in is started from that page and from a card in the conversation, how a tool server is added by its address or as a command, how each is removed, and the first-run question "What do you use every day?". This part of the design follows `visual-language.md`, `conversation.md`, `bots.md`, `work-pane.md`, `setup.md` and `controls.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-004, F-217 to F-221 and F-380 to F-383; the rail button that opens it is F-030. What the gateway does is in `docs/research/connectors.md` (cited as R§n). Every state below names the fact it rests on, and section 17 lists them. Section 18 lists the rows. Section 19 is for builders.

One rule sits above the rest: **a connector's page says what the gateway reported, and when, and nothing else.** The gateway reports a plugin's state, and a sign-in it holds for a plugin's own server; for a server added by address or command it reports neither a sign-in nor accounts, only what a bot's last run found. So the page says "Not reported" where the gateway is silent, and never draws "Connected" from a call that once worked.

Five facts from the research shape the design:

- **The catalog is ClawHub's.** Categories, Recommended, search and everything that can be added come from ClawHub, fetched by the gateway. When the gateway cannot reach it, the catalog shows only what is already on the gateway, and a full-catalog request takes about 14 seconds to say so (R§2).
- **Adding a connector installs code on the gateway's machine.** It downloads a package, installs its dependencies there and runs it inside the gateway, without a restart. It needs admin, and it can stop first to ask for a review of what the plugin may do (R§3).
- **A tool server's tools show only in the gateway's tool listing for a task, as of when it was read.** A save is confirmed by reading the gateway's settings back; a listing names what the gateway has discovered for one task, not a run, a time of use or every bot (R§5).
- **A sign-in from a page needs a connection that comes from a browser.** Both apps reach the gateway through their host as the same client, with no browser origin, and Clawtrate does not present itself as a browser; so both give the gateway's own sign-in steps instead, and the gateway keeps the tokens (R§7).
- **What the gateway keeps, it does not encrypt.** A header's value is kept by the gateway in its settings file, and a sign-in's tokens in its state, not encrypted there; a removed server's sign-in stays (R§6).

The prototype walks every path to its outcome: `prototype/connectors.html`, with the state in the address (`prototype/README.md`). The styles are in `prototype/css/connectors.css`, the behaviour in `prototype/js/connectors.js`, and `prototype/tools/checks/connectors.mjs` clicks through every walk and asserts each state's words and structure.

## Contents

1. How the pieces fit
2. Shared rules: components, the drawn initial, access, writing and reading back, input, announcements
3. Connect apps: the window
4. Browse: search, categories, Recommended
5. When the catalog can't be reached
6. Add
7. On this gateway
8. A connector's page
9. A tool server's page
10. Signing in from a page
11. A sign-in in the conversation
12. Adding a server by address
13. Adding a server started by a command
14. Removing
15. What do you use every day? (F-004)
16. Widths, iPhone, themes, read-only, keyboard, screen readers
17. What the gateway's facts drive
18. Parity rows
19. For builders
20. Not covered here

## 1. How the pieces fit

```
rail footer, "Connect apps" (F-030)   the Connect apps window, on Browse
  Browse                                search across apps and skills, categories, Recommended, Add
    a catalog row                         its page: what it is, what it may do, Add
  On this gateway                       every plugin the gateway lists, and every tool server
    a connector's page                    state, apps, accounts and their sign-in, Turn off, Remove
    a tool server's page                  address or command, the gateway's tool listing for a task, sign-in "Not reported", Remove
  Add a custom connector                by URL (Remote HTTPS) or as a command (Command)
the conversation                      a connect card when a bot asks you to sign in to a server
first run, once                       "What do you use every day?": tick apps; nothing is connected
iPhone, the avatar menu               "Plugins": the same window as one pane at a time
```

Which connectors each bot may use is the bot's Settings tab (`controls.md` §4, F-222); a connector's page links there and does not repeat it. The account a bot runs its model on is `bots.md` §4 to §13; T3 Code is `bots.md` §15 to §18. Both are sign-ins of other kinds and are not repeated here.

## 2. Shared rules

### Components used

| Component                                                                                           | From                                           | Used for                                                             |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Dialog, dialog head, Settings frame (`.b-dialog`, `.b-head`, `.b-settings`, `.b-nav`, `.b-section`) | `bots.md` §2, §7                               | The Connect apps window and its panes                                |
| Choice list (`.b-choices`), note (`.b-note`), result (`.b-result`), numbered steps (`.b-steps`)     | `bots.md` §2                                   | Rows, notes, how an add or a removal ended, the command-line sign-in |
| Confirmation (`.b-confirm`, role `alertdialog`)                                                     | `bots.md` §7                                   | Add, a command server, Remove                                        |
| Fact block (`.facts`), group word, empty state                                                      | `visual-language.md` §9                        | A connector's and a server's facts                                   |
| The access bar and its request                                                                      | `conversation.md` §3, `bots.md` §2             | Every admin action                                                   |
| Command block and copy button                                                                       | `visual-language.md` §10, `conversation.md` §9 | The gateway's own commands                                           |
| Step list (`.s-steps`)                                                                              | `setup.md` §2                                  | Adding a connector, stage by stage                                   |
| Action card                                                                                         | `conversation.md` §7, §8.3                     | A bot's call that asks for a sign-in                                 |
| `.input`, primary, default and quiet buttons                                                        | `visual-language.md` §4                        | Every field and button                                               |

### New components

Each is defined once, in `prototype/css/connectors.css`, from existing tokens.

| Component                  | What it is                                                                                                                                                                                                                                                                                                                                                                         | Tokens                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Initial (`.c-initial`)     | A connector's mark: a 40 px square, radius 10, on `--bg-bubble` with a 1 px `--border`, holding the first letter of its name in `--text` at 17/500. 28 px in a card, 56 px on a page. Every connector has the same one; nothing distinguishes one by colour.                                                                                                                       | `--bg-bubble`, `--border`, `--radius-sm` |
| Catalog row (`.c-row`)     | A choice-list row with the initial, the name (15/500), the summary (13, faint, two lines at most) and, at its end, the action or the state pill. 64 px; 72 on touch.                                                                                                                                                                                                               | as `.b-choice`                           |
| State pill (`.c-pill`)     | A word in a 24 px pill: neutral on `--bg-bubble` ("Added", "Turned off", "Comes with OpenClaw"), `--warn-soft` for something to act on ("Needs sign-in", "Needs setup"), `--danger-soft` for a failure ("Not working"). Never green, never the accent.                                                                                                                             | the soft fills                           |
| Chip row (`.c-chips`)      | The categories: pills of 32 px in one scrolling row, radio group, the chosen one `--bg-selected`.                                                                                                                                                                                                                                                                                  | `--bg-bubble`, `--bg-selected`           |
| Account row (`.c-account`) | One sign-in: who it belongs to ("Shared by everyone on this gateway"), its state in words with when it was last known, and its action.                                                                                                                                                                                                                                             | as `.b-choice`                           |
| Removal list (`.c-goes`)   | Two short lists in a confirmation, "Goes" and "Stays", each item a line of 14 with a 16 px mark (a cross in `--text-muted`, a check in `--text-faint`). After the removal the same lists are the result, each item marked by what was read back. The same component as the Settings design's removal list (`settings.md` §2, in review); whichever merges second uses the other's. | `--text-muted`, `--text-faint`           |
| Connect card (`.c-card`)   | The card in the conversation for a sign-in a bot asked for, in the action-card family: the initial, a title, one line, the sign-in page's host beside its button.                                                                                                                                                                                                                  | as the action card                       |

No new tokens.

### The drawn initial, and no other marks

A connector is shown by its name and its initial, never by a picture. The catalog offers an icon and an image address (`catalog.icon`, `catalog.imageUrl`); Clawtrate never fetches or draws either (R§2), which also follows the rule for addresses a gateway hands the client (`docs/decisions.md`, in review on `e3-remote-content-rule`: an address not listed there is never fetched). No product's logo, icon or colour appears in Clawtrate or in this design; the prototype's connectors have invented names.

### Access

| What                                                                              | Tier                                | Fact                                                                                                                                       |
| --------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Browse, search, a catalog page, On this gateway, a connector's or a server's page | Read                                | `plugins.catalog.*`, `plugins.list`, `plugins.inspect`, `skills.search`, `config.get`, `tools.effective` are `operator.read` (R§2, §5, §8) |
| Add, Turn off, Turn on, Remove a connector                                        | Admin                               | `plugins.install`, `plugins.setEnabled`, `plugins.uninstall` (R§3, §4)                                                                     |
| Add, change or remove a tool server                                               | Admin                               | `config.patch` (R§5)                                                                                                                       |
| Sign in from a page                                                               | Admin                               | None from Clawtrate: the gateway's own steps, on its machine or in its Settings (section 10)                                               |
| Open a sign-in page from a connect card                                           | Any tier that sees the conversation | The bot asked; opening a page writes nothing to the gateway                                                                                |
| Tick apps in "What do you use every day?"                                         | Any                                 | Kept on this device                                                                                                                        |

Admin is asked for only when the person chooses an action that needs it, never on opening the window. On the read and interactive tiers the action's place holds the access bar of `bots.md` §2: "**Read-only.**" (read) or "**Admin access needed.**" (interactive), then the screen's words, and "Request admin access". The words: "Adding apps needs admin access." (Browse, a catalog page), "Changing connectors needs admin access." (a connector's page), "Changing tool servers needs admin access." (a server's page), "Adding a custom connector needs admin access." (the form). The request, its waiting, denied, expired and granted states are that bar's, unchanged. What the screen held (a typed address, the arguments) is kept through the request. Values are shown at every tier; controls that change them are absent, not disabled, below admin.

### Writing and reading back

Every change is written, then read back, and the screen says what the read-back shows, step by step:

- **A connector** (add, turn off, turn on, remove): the gateway's answer gives the plugin's new state; Clawtrate then reads `plugins.list` and shows that row. After any failure, and after a request that got no answer, it reads `plugins.list` before it says anything about what is on the gateway.
- **A tool server**: `config.patch`, then `config.get`. The page shows the entry as `config.get` returns it.
- **Busy.** "Another plugin or config operation is already running" (R§4) is shown as "The gateway is busy with another change. Try again in a moment." with "Try again"; nothing is retried by itself.
- **No answer** (the connection dropped or the call timed out): "Checking what the gateway has…", then the read-back's result. A write is never sent twice before that read.

### Input

- The window is a modal dialog: Tab stays inside, Escape closes it (an open confirmation first), focus returns to the control that opened it.
- The section list is a `nav`; a section's title takes focus when it opens.
- The category chips are a radio group with one tab stop; Left and Right move and choose.
- The search field is a `search` landmark; typing filters as it is typed, Escape clears it.
- A confirmation puts focus on Cancel. In the window and in a confirmation, Tab and Shift-Tab stay inside; closing it returns focus to the control that opened it.

### Announcements

One polite live region for the window announces, each only once it is read back: "Loading the catalog", "Showing what's on this gateway", "12 apps", "No apps match", "Adding Quillnote", "Added Quillnote", "Couldn't add Quillnote", "Turned off Ledgerkin", "Turned on Ledgerkin", "Removed Quillnote", "Added notes-work", "Couldn't add notes-work", "Removed notes-work", "Waiting for the sign-in", "Signed in to Calendrop", "Sign-in didn't finish", "Sign-in cancelled", "Asking the gateway", "Admin access granted", and the copy results. Nothing is announced on a click alone.

## 3. Connect apps: the window

The rail footer's "Connect apps" (F-030, built in #16) opens it on Browse. The window is the Settings frame of `bots.md` §7, 800 × 640: the list of sections on the rail's surface, and the section.

| Section                | Holds                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| Browse                 | Search, categories, Recommended, and every catalog row (sections 4 to 6) |
| On this gateway        | Every plugin the gateway lists, then every tool server (section 7)       |
| Add a custom connector | The form of sections 12 and 13                                           |

The window's title is "Connect apps". On the phone it is a sheet, one pane at a time (section 16).

## 4. Browse: search, categories, Recommended

**Opening.** Browse asks `plugins.catalog.browse {}` (with no query, ClawHub's overview with its categories) and, at the same time, `plugins.catalog.browse {intent: "featured"}` (R§2).

| State                        | It shows                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loading                      | The search field, a chip row of three grey pills, and four grey rows, `aria-busy`. After 4 s, under them: "Still loading. The gateway is asking the catalog."                                                |
| Loaded                       | The search field "Search across apps and skills"; the chips, "All" first, then the categories in their `order`; "Recommended for you" with the featured rows; then "All apps" with every row of the overview |
| The catalog can't be reached | Section 5                                                                                                                                                                                                    |
| The gateway refused          | A `--danger-soft` note: "**Couldn't load the catalog.**" and the gateway's message, with "Try again"                                                                                                         |

**A row** has the initial, the name, the summary, and at its end:

| The row's `local`             | Its end                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `action: "install"`           | "Add" (a default button, 28 px); below admin, no button |
| Installed, `state: "enabled"` | the pill "Added"                                        |
| `state: "disabled"`           | "Turned off"                                            |
| `state: "needs-setup"`        | "Needs setup" (warn)                                    |
| `state: "error"`              | "Not working" (danger)                                  |
| `action: "unavailable"`       | "Not available" in faint text, no button                |

Choosing a row opens its page (section 6); "Add" goes straight to the confirmation of section 6.

**"Recommended for you"** is the gateway's featured list (`intent: "featured"`), the same for everyone on this gateway. Its line says so: "Featured in the catalog." When a person ticked apps in "What do you use every day?" (section 15), a group "You picked" comes first, with those rows. With neither, the group is absent.

**Categories.** A chip shows its category's `label`; choosing it asks `browse {category: <slug>}` and lists the rows under the chip's label. "All" returns to the overview.

**Search** asks `browse {query}` and `skills.search {query}` as the person types, after 300 ms without a key. Results come in two groups, "Apps" and "Skills". A skill row has the initial, the skill's name and description, and opens the skill in its own page, which is not designed here (section 20). With no match in either: "No apps or skills match "<query>"." The chips and Recommended are hidden while a query is in the field.

**More.** When the gateway returns `nextCursor`, "Show more" at the foot of the list asks the next page.

## 5. When the catalog can't be reached

When `browse` comes back with `remoteError`, or `categories` and `featured` fail, the gateway answered with what it has itself (R§2). Browse then says so and shows that, carefully:

- A note at the top, neutral: "**The catalog can't be reached from the gateway.** You can still see and manage what's on this gateway. Apps to add come back when the gateway can reach the catalog." with "Try again". Under it, the gateway's message as given, in `--text-faint`, folded behind "Details".
- No chips and no Recommended: "Categories and recommendations come from the catalog." in the place of the chips.
- The rows the gateway returned, under "On this gateway", each with its state pill. None has "Add".
- The search field reads "Search what's on this gateway". A search lists the gateway's own rows that match; the Skills group says "Searching skills needs the catalog."
- The window does not ask again by itself. "Try again" asks once more; it takes as long as the first time ("Asking the catalog… This can take up to 15 seconds.").

## 6. Add

**A catalog page.** Choosing a row opens its page in the section, with Back. It shows the initial at 56 px, the name (20/500), "by <author>", "Official" when `catalog.official`, and the summary; then, from `plugins.catalog.get` (R§2):

- "What it adds": its servers (`mcpServers`, with "signs in with OAuth" where `auth: "oauth"`), its skills by name, and the settings it needs (`configuration`, marked "required").
- "About": the readme as plain text (the first 12 lines, "Show all" for the rest), its version, and the verification and security summary as given.
- At the foot, "Add" (primary), or the access bar below admin.

Links in the readme follow the rule for links (`docs/decisions.md`, in review): shown as text with their full address, opened only when chosen.

**The confirmation** (role `alertdialog`, focus on Cancel):

> **Add Quillnote to the gateway?**
> The gateway downloads Quillnote 2.4.1 from the catalog and installs it, with the packages it depends on, on the gateway's machine. It then runs inside the gateway, with the gateway's access, and its tools are offered to bots that don't deny them. The gateway doesn't restart.
> [Cancel] [Add]

The version is the catalog's `latestVersion`. "Bots that don't deny them" links to `controls.md` §4.

**Then the gateway may ask first** (R§3), before anything is written:

| The gateway answered                                       | The screen                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A capability review (`PLUGIN_CAPABILITY_CONSENT_REQUIRED`) | A second confirmation: "**Quillnote asks for more than the catalog listed.**" and the list the gateway gave (`widened`: tools, hooks, servers, and so on, each by name), "Add anyway" and "Cancel". "Add anyway" sends the same request with the review token. |
| An install-policy warning                                  | "**The gateway's install check found something.**" with each finding (its severity in words, its message, the file and line when given), "Add anyway" and "Cancel"                                                                                             |
| A ClawHub trust error                                      | The refusal result below ("Couldn't add Quillnote:" and the gateway's message). Nothing to acknowledge.                                                                                                                                                        |

**While it installs**, a step list from `plugins.install.progress` (R§3), each step started, done or failed: "Finding the release", "Downloading", "Unpacking", "Writing files", "Installing what it needs", "Starting it on the gateway". Cancel is absent: the gateway has no way to stop an install.

**How it ended**, after `plugins.list` is read back:

| The answer                            | The read-back     | The result                                                                                                                                                                                         |
| ------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`, `restartRequired: false`        | listed, `enabled` | "**Added Quillnote.** The gateway lists it as installed and turned on." and "Open Quillnote" (its page). Whether a bot is offered its tools is that bot's tool rules' business (`controls.md` §4). |
| `ok`, `restartRequired: true`         | listed            | "**Added Quillnote.** The gateway says it needs a restart before Quillnote works." Clawtrate does not restart the gateway.                                                                         |
| A refusal before anything was written | not listed        | "**Couldn't add Quillnote:** <message>. The gateway lists nothing new." with "Try again"                                                                                                           |
| A failure with `persistence`          | listed, `error`   | "**Quillnote was installed but didn't start:** <message>." with "Open Quillnote" (its page, where Remove is)                                                                                       |
| No answer                             | as read           | "Checking what the gateway has…", then one of the above                                                                                                                                            |

Whatever the answer, the read-back wins: when `plugins.list` disagrees with what the answer implied, the result states what it lists now.

## 7. On this gateway

Every plugin `plugins.list` returns as installed, then every entry of `config.get` `mcp.servers` (R§2, §5). A search field filters both.

- **Plugins**, in two groups, "Turned on" and "Turned off", each row with the initial, the name, its description and its state pill. Plugins that come with OpenClaw are many (64 on a fresh gateway of this version), so they are folded behind one more group, "Comes with OpenClaw (64)", which opens in place.
- **Tool servers**, under that word, each row with the server's name in mono, its address or its command, and "Added by address" or "Runs a command". There is no state pill: the gateway reports none (section 9).
- "Add a custom connector" at the foot opens section 12.

## 8. A connector's page

A plugin's page: the initial at 56 px, the name, "by <author>" or "Comes with OpenClaw", the version, the state in words, the description; then "Tools", "Accounts", and the actions. It reads `plugins.list` (the row), `plugins.inspect {pluginId}` and, when it came from the catalog, `plugins.catalog.get` (R§8).

**Tools** lists what the plugin gives, from `inspect`'s `components`: each server ("quillnote, a tool server"), each skill, each command. Under the list: "Which bots may use these is in each bot's settings." linking to `controls.md` §4.

**The state**, from `plugins.list` and `inspect`:

| The gateway reports                              | The page says                                                                                                                                                                                                                 | Its actions      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `enabled`, `runtime.state: "active"`, no sign-in | "Added"                                                                                                                                                                                                                       | Turn off, Remove |
| `enabled`, `runtime.state: "unloaded"`           | "Added. Not loaded yet: it loads when a bot first needs it."                                                                                                                                                                  | Turn off, Remove |
| `disabled`                                       | "Turned off. Its tools aren't offered to any bot."                                                                                                                                                                            | Turn on, Remove  |
| `needs-setup`                                    | "Needs setup. Open Settings on the gateway to finish setup." When `inspect` reports credential fields with `status: "missing"`, their labels follow: "The gateway reports missing: Account address." No other field is named. | Remove           |
| `error`, or `runtime.state: "service-failed"`    | "Not working:" and `runtime.error` or `error`, as given                                                                                                                                                                       | Turn off, Remove |
| `removable: false`                               | (any of the above) and "Comes with OpenClaw, so it can be turned off but not removed."                                                                                                                                        | no Remove        |

Editing a plugin's settings is not designed here (section 20); "Needs setup" says where to finish it, and names only fields the gateway reports missing.

**Accounts.** One row per server the gateway reports in `inspect` `mcpAuth`, named by its `serverName` and "Shared by everyone on this gateway", since one sign-in per server is what the gateway keeps (R§8). A server the plugin declares with OAuth (its `declared.mcpServers`, with `auth: "oauth"` in the catalog's `mcpServerDetails`) that has no row gets one too, reading "Sign-in status not reported." No expiry is shown: the gateway does not report one.

| `mcpAuth.state`                                    | The row says                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `unauthenticated`                                  | "Needs sign-in." (warn)                                                                                         |
| `requires-authorization`                           | "Needs sign-in again." (warn)                                                                                   |
| `pending-authorization`                            | "Sign-in pending."                                                                                              |
| `authorized`                                       | "Signed in. The gateway reports saved sign-in tokens." and, under it, "Whether they still work isn't reported." |
| No row for a server the plugin declares with OAuth | "Sign-in status not reported."                                                                                  |

Under the rows: "Open Settings on your OpenClaw gateway to sign in to <server>." and "Check again" (section 10). The gateway's terminal command cannot find a plugin's own server, so it is not offered here (R§7). There is no "Connected": `authorized` means the gateway holds tokens, not that they work (R§8). A plugin with no sign-in has no Accounts group. When the plugin is turned off, `inspect` reports no sign-in, and the group says "The gateway reports sign-ins only while Quillnote is turned on."

"Add another account" is not offered for a plugin: the gateway keeps one sign-in per declared server, and no method adds a second (R§8). For a server added by address it is section 9's.

**Turn off and Turn on** write `plugins.setEnabled`, then read back. Turning off says first, in the confirmation: "Turn off Quillnote? The gateway stops offering its tools. Its settings and any saved sign-ins stay." with "Cancel" and "Turn off". Turning on needs no confirmation.

## 9. A tool server's page

A server from `mcp.servers` has no catalog entry and no plugin state. Its page shows the facts as `config.get` returns them, the gateway's tool listing for a task, and "Not reported" for the rest (R§5, §8).

**Facts** (`.facts`):

| Row                 | Value                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name on the gateway | `notes-work` (mono)                                                                                                                                                                                                                                                             |
| Kind                | "Added by address" or "Runs a command"                                                                                                                                                                                                                                          |
| Address             | `https://notes.example/mcp` (remote)                                                                                                                                                                                                                                            |
| Headers             | each header's name, and "Hidden: the gateway doesn't show saved values. Kept by the gateway in its settings file, not encrypted there." (remote)                                                                                                                                |
| Sign-in             | "Signs in with OAuth" when `auth: "oauth"`; for an existing per-requester entry (`oauth.identity: "per-requester"`, made outside Clawtrate), "Uses the gateway's requester sign-in. Set up and use it in a channel where the gateway identifies each sender."; otherwise "None" |
| Command             | the command and each argument, in mono, as saved (command)                                                                                                                                                                                                                      |
| Runs in             | the working folder, when set (command)                                                                                                                                                                                                                                          |

**Gateway tool listing**, from `tools.effective` for one task, by default the most recent task of the bot the person last opened, with the task named and a menu to choose another (R§5). Its tools are matched by their `mcpServer`, its notices by their `servers`:

| The listing says                                                                         | The page says                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Tools whose `mcpServer` is this server                                                   | "Gateway tool listing for Pip's task, read at 5:12 PM: 8 tools", and the tool names folded under it     |
| `mcp-not-yet-connected`, `mcp-not-yet-listed` or `mcp-stale-catalog`, naming this server | "The gateway hasn't listed this server's tools for this task." and the notice's words, folded           |
| `mcp-server-diagnostic:<name>`                                                           | "Gateway tool listing for Pip's task, read at 5:12 PM:" and the gateway's message as given, in `--warn` |
| Nothing about it                                                                         | "Not reported: the gateway's tool listing for this task doesn't mention this server."                   |

Under it: "A listing shows what the gateway has discovered for this task. A bot's tool rules still decide what it is offered." The time is when Clawtrate read the listing, not when anything ran.

**Sign-in: "Not reported."** Under it, always: "The gateway doesn't report whether it's signed in to this server, or for whom. A bot's run shows whether its tools work." For a shared OAuth server the page offers "Sign in" (section 10). For an existing per-requester entry: "Uses the gateway's requester sign-in. Set up and use it in a channel where the gateway identifies each sender." Clawtrate offers no sign-in for it (section 11).

**Accounts.** The gateway keeps one shared sign-in per server name and address (R§6). So a second account at the same address is a second server under another name. "Add another account" is offered only for a shared OAuth server ("Sign in with OAuth"); its line says "A second name for the same server, with its own sign-in. Bots tell them apart by name." It opens section 12 with the address and the header names filled in, the header values and the name left empty, and under the headers: "Enter any header values this server needs. Saved values are hidden." The label a person types is the name.

What the page can never say: that the server is signed in, for whom, until when, or that it works now.

## 10. Signing in from a page

"Sign in" on a server's page, and on a plugin's account row (section 8). It needs admin; below admin the access bar takes its place (section 2).

**The rule.** The gateway starts a browser sign-in (`mcp.authLogin`) only for a connection that comes from a browser (R§7). Clawtrate never presents a connection as a browser to be given what the gateway withholds from its own kind of connection. Both apps reach the gateway through their host, the desktop app's main process or the web preview's host, as the same client: `gateway-client` in `ui` mode, with no `Origin` (R§7). In the web preview the viewer's browser shows Clawtrate's page, but it is not the gateway's client. So both apps sign in the same way: neither calls `mcp.authLogin`, and both give the gateway's own sign-in steps.

**Which sign-in a page gives** depends on where the server is defined, because the gateway's terminal command reads only its own settings (R§7):

| The server                                                                                                                                                              | The page gives                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An entry in the gateway's settings (`mcp.servers`) that is enabled, has an HTTP URL and `auth: "oauth"`, is shared (not per-requester) and has no `oauth.authProfileId` | The command-line sign-in, below, with the entry's exact configured name                                                                                                                |
| A plugin's own server (an account row of section 8, named by the gateway's `mcpAuth[].serverName`)                                                                      | "Open Settings on your OpenClaw gateway to sign in to calendrop." and "Check again", which reads `plugins.inspect` again; it is read again too when the window comes back to the front |
| Any other entry (per-requester, an auth-profile override, not OAuth, turned off)                                                                                        | No sign-in from Clawtrate                                                                                                                                                              |

**The command-line sign-in:**

1. "On the gateway's machine, run:" and `openclaw mcp login notes-work` in the command block, the entry's exact name, with the gateway's profile option when the host knows the gateway runs under a named profile.
2. "If it prints an address, open it in a browser and sign in."
3. "If the terminal is listening for the callback, it waits up to five minutes. Follow the terminal's instructions to finish with a code if the callback cannot reach it."
4. "It may also find a saved sign-in and say so without printing an address."

Under the steps: "Or sign in from Settings on the gateway's own web page." The page the browser lands on is the gateway's own, not Clawtrate's ("Sign-in response received. Return to OpenClaw for the sign-in result.", R§7). Afterwards the server's page reads what it read before, "Not reported": the gateway reports no sign-in state for an entry of its settings, so Clawtrate cannot see whether the command signed in.

## 11. A sign-in in the conversation

**"Each person signs in" is not offered for Clawtrate chat.** For a server with `oauth.identity: "per-requester"` the gateway keeps one sign-in per requester, told apart by channel, account and sender, with no device in it (R§7). For a client like Clawtrate the sender is the client's own id, `gateway-client`, the same on every device of this app. Two people who use one gateway from Clawtrate are one requester to it, and would share one sign-in. So the form of section 12 offers no per-requester choice, and an existing per-requester entry says on its page: "Uses the gateway's requester sign-in. Set up and use it in a channel where the gateway identifies each sender."

**A live connect result.** If a bot in a Clawtrate task calls such a server's `<server>__connect` tool anyway, the call's live result can carry `details.mcpConnect {serverName, authorizationUrl}` (R§7). Only then is the action card (`conversation.md` §8.3) a connect card, and it says what the gateway can and cannot tell apart:

| The call's result                                                                       | The card                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `details.mcpConnect {serverName, authorizationUrl}`, observed live for this call        | Initial, "**team-notes asks for a sign-in**", "The gateway sees every device using Clawtrate as one sender, so this sign-in is shared by everyone who uses this gateway from Clawtrate.", the sign-in address in full (below), "Open in your browser", and under it "After you sign in, ask Pip again." |
| "MCP server "team-notes" is connected. Its tools become available on the next message." | The ordinary card, with the gateway's words as its result                                                                                                                                                                                                                                               |
| `details.status: "error"` (no public address)                                           | "**team-notes can't ask for a sign-in here:**" and the message as given ("… gateway.publicOrigin is not configured. Ask the operator to set the public Gateway HTTP(S) origin.")                                                                                                                        |

- After "Open in your browser", the card reads "Opened at 5:12 PM. If the page didn't finish, open it again." and the button becomes "Reopen". It opens the same address. The gateway tells the client nothing when the sign-in finishes, so the card never says it did.
- The link is single use and expires. A link already used or expired lands on the gateway's page "This sign-in link expired or was already used. Ask the bot to connect again." The card cannot know that in advance and does not guess.
- **Anyone who opens the link completes the sign-in** (R§7). Under its button: "Anyone who opens this link completes this sign-in." In a task more than one person can read, that line is in `--warn`.
- **A sign-in address** follows the rule for addresses the gateway hands the client (`docs/decisions.md`, in review on `e3-remote-content-rule`): it opens only when the person chooses "Open in your browser", in the system browser, and the full address is shown first, its host in medium weight on the first line and the whole address under it in mono, with a copy button.

**A shared server says nothing in the conversation.** A shared OAuth server that is not signed in is left out of the bot's tools; the bot gets no connect tool and the gateway sends no card (R§7). The server's page (section 9) is where its sign-in starts.

## 12. Adding a server by address

"Add a custom connector", Type "Remote HTTPS". It needs admin.

| Field      | Rule                                                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name       | Required. Letters, digits, hyphens and underscores. The name bots see in tool names (`notes-work__…`). A name already on the gateway: "There's already a server named notes-work."                                                                                |
| Server URL | Required. "Enter the server's URL." when empty. Not a URL: "Enter a URL that starts with https://." A URL that is not `https`: "Use the server's https:// URL." Nothing is saved until it is `https`. (Clawtrate's rule; the gateway itself accepts `http`, R§5.) |
| Headers    | Optional, name and value rows, "Add a header". The value field is a password field. Under them: "Kept by the gateway in its settings file, not encrypted there. Clawtrate can't read a value back once it's saved."                                               |
| Sign-in    | A radio group: "None" and "Sign in with OAuth". There is no "Each person signs in" (section 11).                                                                                                                                                                  |

There is no Client ID and no Client Secret: the gateway has no field for either and refuses them (R§5). OpenClaw registers itself with the server when it signs in.

**The write.** Every write to a server entry follows one contract (R§5):

1. **The revision reviewed.** When the form opens (and when "Add another account" fills it in), Clawtrate reads `config.get` and keeps its `hash`. That read is also where a name already on the gateway is found: "There's already a server named notes-work."
2. **The patch.** `config.patch` (admin) with `raw: JSON.stringify({mcp: {servers: {[name]: entry}}})` and `baseHash` set to that `hash`, never a hash read later. The entry is exactly:

   | Kind                               | `entry`                                                                            |
   | ---------------------------------- | ---------------------------------------------------------------------------------- |
   | Remote HTTPS, Sign-in "None"       | `{url, transport: "streamable-http", headers?}`                                    |
   | Remote HTTPS, "Sign in with OAuth" | `{url, transport: "streamable-http", headers?, auth: "oauth"}`                     |
   | Command (section 13)               | `{command, args, cwd?}`, with `args` always an array, `[]` when there are none     |
   | Removal (section 14)               | `null`, with `replacePaths: ["mcp.servers.<name>.args"]` when the entry has `args` |

3. **A changed revision.** When the gateway answers that its settings changed since that read ("config changed since last load"), nothing is sent again with a newer hash: "The gateway's settings changed. Review the current entry before trying again." The form reads `config.get` again and shows what is there now. An entry of the same name made elsewhere in the meantime is a conflict, never overwritten: "There's already a server named notes-work on the gateway."
4. **The read-back.** After an accepted write, after a refusal and after no answer, Clawtrate reads `config.get` and compares the fields the person reviewed: the address, the transport, `auth` and the header names (remote), or the command, every argument and the working folder (command). Header values cannot be compared: the gateway hides them (`__OPENCLAW_REDACTED__`), so their names are the most that can be verified.

| The read-back                                                      | The section shows                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The entry, with every reviewed field as reviewed                   | "**Added notes-work.** The gateway lists this server." and "Open notes-work"; for a command server also "The gateway can start this program when it needs this server." With "Sign in with OAuth": "Sign in" as the next step. Nothing is said about bots or runs: whether a bot is offered its tools is its tool rules' business. |
| No such entry, after a refusal                                     | "**Couldn't add notes-work:**" and each of the gateway's issues as given ("mcp.servers.notes-work.url: Expected http:// or https:// URL"), the field it names marked. Nothing saved.                                                                                                                                               |
| No such entry, after no answer                                     | "**notes-work wasn't added.**" with "Try again", which starts again from a new read                                                                                                                                                                                                                                                |
| An entry that differs from what was reviewed, or a read that fails | "**Couldn't confirm the change.**" and what the read showed, with "Check again"                                                                                                                                                                                                                                                    |

## 13. Adding a server started by a command

"Add a custom connector", Type "Command". Only an admin connection reaches it; below admin the access bar takes the form's place.

| Field          | Rule                                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name           | As section 12                                                                                                                                                                                  |
| Command        | Required: "Enter the command." Clawtrate refuses an empty command; the gateway would accept one and do nothing with it (R§5). Spaces at its start and end are removed.                         |
| Arguments      | One per line. Each line is one argument: spaces at its start and end are removed, spaces inside it stay part of that argument, and a line left empty is dropped. Nothing goes through a shell. |
| Working folder | Optional. Spaces at its start and end are removed; left empty, the entry has no `cwd`.                                                                                                         |

Under the fields: "The gateway runs this program on its own machine, as the user the gateway runs as, whenever a bot's run needs its tools. It can do anything that user can." and "The gateway can show saved commands and arguments to operators who can read its settings." (a command and its arguments are read back in full, R§6; no secret belongs in them). "Continue" opens the confirmation.

**The confirmation**, before anything is written (role `alertdialog`, focus on Cancel). It shows the reviewed values, and those same values, no others, are what the write sends (section 12's contract):

> **Run this command on the gateway's machine?**
> Home gateway will run, on its own machine (`studio.example`), as the user it runs as:
> Program: `/opt/example/bin/search-server`
> Arguments: `--stdio`, `--index ./notes`, each on its own line, or "No arguments"
> Working folder: `/srv/notes`, shown only when one was given
> It runs whenever a bot's run needs search-index's tools, with that user's access to files, programs and the network.
> [Cancel] [Add command server]

Each argument is shown on its own line, in mono, never shortened, so an argument with spaces in it reads as one. The machine is the gateway's address as this device knows it, or "the gateway's machine" when that is all it knows.

- Tab and Shift-Tab stay inside the confirmation, as in every dialog here. Cancel and Escape close it and put focus back on "Continue", with every field as it was typed.
- "Add command server" writes `{command, args, cwd?}` and reads back by section 12's contract; the result compares the command, every argument and the working folder with what was confirmed.

## 14. Removing

Every removal is a confirmation that says exactly what goes and what stays, then a result in the same two lists, each item marked by what was read back (the removal list, section 2).

**A connector** (`plugins.uninstall`, admin, R§4):

> **Remove Quillnote from the gateway?**
> Goes: Quillnote's files on the gateway's machine; its settings on the gateway; its tools.
> Stays: any saved sign-ins, kept by the gateway in its state, not encrypted there; a note on the gateway that Quillnote is off, so nothing turns it back on by itself.
> [Cancel] [Remove]

After the removal, `plugins.list` is read: "Removed Quillnote. The gateway no longer lists it." A connector that comes with OpenClaw has no Remove (section 8).

**A tool server** (section 12's contract: `null`, with `replacePaths` for a command's arguments, and the `hash` read when the confirmation opened, R§5):

> **Remove notes-work from the gateway?**
> Goes: the server's entry in the gateway's settings, with its headers; its tools.
> Stays: "Removing this entry leaves any saved sign-ins in the gateway's state. The gateway keeps them unencrypted." The gateway finds them again if a server with the same name and URL is added.
> To clear them, run `openclaw mcp logout notes-work` on the gateway's machine before removing the entry, or remove it there with `openclaw mcp unset notes-work`, which clears them too.
> [Cancel] [Remove]

The sign-in lines are for an OAuth entry only, and the commands carry the gateway's profile option when the host knows it. For an existing per-requester entry `logout` refuses, so the line is: "To remove it and clear them, run `openclaw mcp unset team-notes` on the gateway's machine instead." (R§6). An entry without OAuth has no sign-in line. Then `config.get` is read, and "Removed notes-work. The gateway's settings no longer have it." is said only when that read has no such entry. When the read still has it: "notes-work is still there: <the gateway's reason>." with "Try again". When the settings changed since the confirmation opened: "The gateway's settings changed. Review the current entry before trying again." When the read fails: "Couldn't confirm the change."

## 15. What do you use every day? (F-004)

On a gateway the person already runs, first run ends with the app open and read-only (`setup.md` §7). The question comes once after that, on the first gateway this device connects to, as a dialog over the app, and never again on this device.

- Title "What do you use every day?", the search field "Search apps", and a grid of twelve tiles: the catalog's featured apps (`browse {intent: "featured"}`), each an initial and a name, a checkbox each. "Skip" and "Next".
- The line under the title: "Pick the apps you use. Nothing is connected now; they come first in Connect apps."
- Ticking keeps the choice on this device only. "Next" closes the dialog and the ticked apps lead Browse as "You picked" (section 4). Nothing is written to the gateway, and the read-only connection is enough.
- **When the catalog can't be reached**, or the featured list is empty, the question is not asked: there would be nothing true to pick from. It is asked on a later start when the catalog answers. Connect apps stays in the rail.
- The row is desktop only (F-004); the iPhone does not ask it.

What the tiles cannot do: shape which bots are suggested, as Grok Bot's do. Clawtrate suggests no bots (F-005 creates one only when there are none).

## 16. Widths, iPhone, themes, read-only, keyboard, screen readers

- **1440, 1100 and 800**: the window is 800 × 640 (at 800, the window's width less 48 px). The section list is 208 px; a catalog row's summary wraps at two lines.
- **390, the one-pane layout**: a sheet the height of the screen less 8 px. The section list is one pane; a section another, with Back. The chips scroll sideways inside their row; rows are 72 px. A confirmation is a card at the foot.
- **iPhone (F-380)**: from the avatar menu, "Connect apps" opens the same sheet, titled "Plugins" on Browse, with "Search plugins", the category chips, "Featured" for Recommended, and rows with "Added" or "Add". Add a custom connector is desktop only (F-221, F-381); a server's page is read-only on the iPhone and says "Change it from Clawtrate on your computer."
- **Themes**: every surface is a token; nothing is drawn in a fixed colour.
- **Read-only**: everything reads; the actions' places hold the access bar.
- **Keyboard**: everything is reachable in reading order; the chip row and the sign-in radio group have one tab stop each.
- **Screen readers**: a row's name is "<name>, <state or Add>, <summary>"; the initial is decorative. The live region's words are in section 2.
- **Reduced motion**: the loading rows do not shimmer; the waiting dot does not pulse.

## 17. What the gateway's facts drive

| #   | Fact                                                                                                                                                                                                                                                                                                                      | Where                                       | Drives                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| 1   | The catalog and its categories come from ClawHub, joined with the gateway's own plugins                                                                                                                                                                                                                                   | R§2, source                                 | Browse, chips, Recommended (sections 4, 15)                    |
| 2   | Without ClawHub, `browse` answers with the gateway's plugins and `remoteError`, after about 14 s; `categories`, `featured`, `search`, `skills.search` fail                                                                                                                                                                | R§2, tried                                  | Section 5; the picker not asked                                |
| 3   | `plugins.install` is admin, downloads and runs code on the gateway's machine, without a restart, with progress stages                                                                                                                                                                                                     | R§3, source; refused at the download, tried | Section 6                                                      |
| 4   | A capability review or install-policy warning can come first; a failure after writing carries `persistence`                                                                                                                                                                                                               | R§3, source                                 | Section 6's second confirmation and results                    |
| 5   | `plugins.setEnabled` and `uninstall` answer with the new state; a bundled plugin can't be removed; a change can be refused as busy                                                                                                                                                                                        | R§4, tried                                  | Sections 2, 8                                                  |
| 6   | Uninstall keeps an `enabled: false` marker and the stored sign-in                                                                                                                                                                                                                                                         | R§4, docs and source                        | Section 14                                                     |
| 7   | `plugins.list`: `state`, `runtime.state`, `removable`                                                                                                                                                                                                                                                                     | R§8, tried                                  | Section 8's states                                             |
| 8   | `plugins.inspect` `mcpAuth` for a plugin's own OAuth servers                                                                                                                                                                                                                                                              | R§8, source                                 | Section 8's Accounts                                           |
| 9   | `config.patch` on `mcp.servers`, read back through `config.get`; headers redacted; command and arguments read back as saved; removal needs `replacePaths` for `args`                                                                                                                                                      | R§5, tried                                  | Sections 9, 12 to 14                                           |
| 10  | The gateway refuses a bad or non-http(s) address and a client ID or secret; accepts an empty command                                                                                                                                                                                                                      | R§5, tried                                  | Sections 12, 13 (Clawtrate's own checks)                       |
| 11  | `tools.effective` is the current listing for one task: a server's discovered tools (`mcpServer`), or a notice naming it (`mcp-not-yet-connected`, `mcp-not-yet-listed`, `mcp-stale-catalog`, `mcp-server-diagnostic`); it names no run, no time of use and no other bot, and every tool still passes the bot's tool rules | R§5, tried and source                       | Section 9's tool listing                                       |
| 12  | A header and a command are kept by the gateway in its settings file, not encrypted there; a sign-in's tokens in its state, not encrypted there, and kept after the server is removed                                                                                                                                      | R§6, tried                                  | Sections 9, 12, 14                                             |
| 13  | `mcp.authLogin` needs admin and a browser origin, publishes an https page and returns to the gateway's callback; 10 minutes                                                                                                                                                                                               | R§7, tried (a probe of the gateway's rule)  | Section 10: Clawtrate never calls it                           |
| 14  | Both apps reach the gateway as `gateway-client` in `ui` mode with no `Origin`, through their host; the web preview's browser is not the gateway's client                                                                                                                                                                  | R§7, source                                 | Section 10: one sign-in for both apps                          |
| 15  | A per-requester server gives the bot `<server>__connect`, whose live result carries the sign-in page; the link is single use and opens for whoever holds it. The gateway tells requesters apart by channel, account and sender, and Clawtrate's sender is its client id on every device                                   | R§7, source                                 | Sections 9, 11, 12: no per-requester choice for Clawtrate chat |
| 16  | A server added by address or command has no sign-in state and no accounts                                                                                                                                                                                                                                                 | R§8, tried                                  | Section 9's "Not reported"                                     |
| 17  | One shared sign-in per server name and address                                                                                                                                                                                                                                                                            | R§6, source                                 | Section 9's "Add another account"                              |
| 18  | `openclaw mcp login`, `--code`, `logout` on the gateway's machine                                                                                                                                                                                                                                                         | R§7, docs                                   | Sections 10, 14                                                |
| 19  | The owner-only `plugins` tool can install a plugin from a conversation                                                                                                                                                                                                                                                    | R§3, docs                                   | Row F-383                                                      |

## 18. Parity rows

The rows' targets and statuses stay as they are. The gateway dependency cells are reworded to what the research established:

| Row   | Gateway dependency, reworded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-004 | partial: the tiles are the catalog's featured apps, `plugins.catalog.browse {intent: "featured"}` (`operator.read`), which needs the gateway to reach ClawHub; without it the question is not asked (connectors.md §15). The ticks are kept on this device.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F-217 | partial: `plugins.catalog.categories`, `plugins.catalog.browse {query?, category?, intent?, cursor?}` and `plugins.catalog.get` (`operator.read`) come from ClawHub joined with the gateway's own plugins; skills from `skills.search` (`operator.read`); "Recommended for you" is `intent: "featured"`. Without ClawHub, `browse` answers with only the gateway's plugins and a `remoteError` after about 14 s, and categories, featured, search and skills search fail (tried behind a loopback fence). "Add" is `plugins.install` (`operator.admin`), which downloads and runs the package on the gateway's machine without a restart (source). Raw MCP servers are not in the catalog: `config.get` `mcp.servers` (`operator.read`, redacted). |
| F-218 | partial: plugins report `state` (`enabled`, `disabled`, `needs-setup`, `not-installed`, `error`) and `runtime.state` in `plugins.list` (tried), and, for their own OAuth servers, `plugins.inspect` `mcpAuth` `authorized`, `requires-authorization`, `pending-authorization` or `unauthenticated`, read from stored tokens (source); `authorized` says tokens are stored, not that they work. Raw MCP servers report no sign-in state; a task's `tools.effective` lists their tools or a failure only after a run (tried).                                                                                                                                                                                                                        |
| F-219 | partial: a plugin's server has one shared sign-in (`plugins.inspect` `mcpAuth`); a raw server's sign-in is kept per server name and address, so a second shared account is a second entry under another name; `oauth.identity: "per-requester"` keeps one per sender. No method lists accounts (`mcp.*`, `plugins.*`).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F-220 | partial: only a per-requester server asks in the conversation: the bot gets `<server>__connect`, whose result carries `details.mcpConnect {serverName, authorizationUrl}`, returning through `<gateway.publicOrigin>/oauth/mcp/callback`; the link is single use, and the gateway does not tell the client when it finishes (source). A shared server's sign-in is `mcp.authLogin {sessionId, serverName}` (`operator.admin`, a connection with a browser origin), which publishes an https page, returns to `/oauth/provider/callback` and waits 10 minutes (tried end to end on loopback); Clawtrate's present connection is refused ("Open Settings on this Gateway to sign in, or use openclaw mcp login in its terminal.").                   |
| F-221 | partial: `config.patch` on `mcp.servers.<name>` with `{url, transport, headers?, auth?: "oauth", oauth?}` (`operator.admin`), read back with `config.get` (headers `__OPENCLAW_REDACTED__`; kept by the gateway in its settings file, not encrypted there); the gateway refuses a non-http(s) address and has no client ID or secret (`oauth` takes only `identity`, `authProfileId`, `scope`, `redirectUrl`, `clientMetadataUrl`; tried).                                                                                                                                                                                                                                                                                                         |
| F-380 | partial: as F-217.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| F-381 | available: `config.patch` on `mcp.servers.<name>` with `{command, args, cwd?}` (`operator.admin`), read back with `config.get`; the gateway accepts an empty command, so the client refuses it; removing one needs `replacePaths` for `args` (tried).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| F-382 | partial: as F-220; the shared flow's return page is the gateway's own, "Sign-in response received. Return to OpenClaw for the sign-in result." (tried); the result reaches the client as the wizard's `done`. "Connected" is not reported for raw MCP servers (F-218).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F-383 | partial: the gateway's owner-only `plugins` tool can install an official or ClawHub plugin from a conversation (docs); no Bot tool adds a raw server. A server added with `config.patch` (`operator.admin`) is usable on the next turn without a restart (live).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Targets reworded** (round 1 decisions), statuses unchanged:

| Row   | Clawtrate target                                                                                                                                                                                                                                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-004 | better: after the first connection, Clawtrate offers "What do you use every day?" once: a search box and the catalog's recommended apps to tick, with Next and Skip. Ticking connects nothing. It is not offered when the gateway's catalog cannot be reached.                                                                                        |
| F-218 | better: a connector's state says only what the gateway reports: Added, Needs sign-in, Signed in (tokens are stored; Clawtrate does not claim a working connection), Turned off, and Not reported for a tool server; with Sign in, Sign in again and Remove. There is no team admin.                                                                   |
| F-219 | better: a connector's page shows its description, its tools and its sign-in as the gateway reports it: one shared sign-in for a plugin; for a tool server, "Add another account" adds a second entry under a label.                                                                                                                                   |
| F-221 | better: "Add a custom connector" with Type "Remote HTTPS": Server URL and optional HTTP headers, then "Add to gateway". There is no Client ID or Client Secret: the gateway does not accept them. Saving with an empty or non-HTTPS URL shows an error and saves nothing, and the form says that a header's value is kept by the gateway unencrypted. |
| F-381 | better: "Add a custom connector" with Type "Command": Command and Arguments, then a confirmation that shows the exact command and arguments and says it runs on the gateway's machine as the gateway's user, for an admin connection only. Saving with an empty command shows an error and saves nothing.                                             |
| F-382 | better: finishing an app's sign-in in the browser ends on the gateway's own page; back in Clawtrate the connector shows what the gateway then reports (Signed in, or Not reported for a tool server) and never "Connected" on its own word.                                                                                                           |

Beside the states F-218 names, a connector's page also shows two more the gateway reports: "Needs setup" (`needs-setup`) and "Not working" (`error`, or `runtime.state: "service-failed"`), section 8.

## 19. For builders

### What each part uses

| Part                 | Gateway                                                                                                                       | Engine                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Browse               | `plugins.catalog.browse` (overview, `featured`, `category`, `query`, `cursor`), `plugins.catalog.categories`, `skills.search` | the catalog store, a 300 ms debounce, the `remoteError` flag           |
| A catalog page       | `plugins.catalog.get`                                                                                                         | readme as text                                                         |
| Add                  | `plugins.install`, `plugins.install.progress`, then `plugins.list`                                                            | the install record: request id, stages, the result after the read-back |
| On this gateway      | `plugins.list`, `config.get`                                                                                                  |                                                                        |
| A connector's page   | `plugins.list`, `plugins.inspect`, `plugins.setEnabled`, `plugins.uninstall`                                                  |                                                                        |
| A tool server's page | `config.get`, `tools.effective` per bot's latest task, `config.patch`                                                         | the "last signed in from Clawtrate" record, kept on this device        |
| Sign-in              | none: the gateway's own steps (section 10); afterwards `plugins.inspect` for a plugin                                         | the host supplies the profile option for the commands                  |
| The connect card     | the tool result's `details.mcpConnect`                                                                                        | a kind in the action-card mapping (`conversation.md` §8)               |
| The picker           | `plugins.catalog.browse {intent: "featured"}`                                                                                 | the ticks, on this device                                              |

### What the engine supplies

- A catalog store that keeps the last overview, its time, and whether it came with `remoteError`.
- One write at a time per window: a second change waits for the read-back of the first.
- A server write carries the `config.get` `hash` read when the person reviewed it, and the exact entry of section 12; its result comes only from the read-back's comparison.
- The command and the profile option for `openclaw mcp login` and `logout` come from the host, as the approve command does (`bots.md` §2).

### Order

1. On this gateway and a connector's page, read-only (rows F-218 in part).
2. Browse, its states without ClawHub first (F-217, F-380).
3. A tool server's page and adding one by address and by command (F-221, F-381).
4. Add, with its confirmations and results (F-217).
5. Sign-in from a page: the gateway's own steps, the same in both apps (F-220, F-382).
6. The connect card (F-220).
7. The picker (F-004).

### Prototype states

`connectors.html?screen=<id>`, one per state; the README lists the parameters. The prototype draws the Settings frame and the confirmation again (`.c-window`, `.c-frame`, `.c-confirm`) so that its one-pane layout follows the prototype frame's width; in the app they are `bots.md`'s. The walks the check clicks: Browse to a catalog page to Add, through the review, progress and each ending; the catalog unreachable and Try again; a search with results and with none; On this gateway to a connector's page in every state, Turn off and on, and Remove; a server's page in every state of its last run, "Add another account", and Remove; adding a server by address with each error and each ending; adding a command through its confirmation; the gateway's sign-in steps for a tool server and for a plugin's server; the connect card, opened and reopened, and its error; the picker, ticked, then Browse with "You picked"; and each admin action on a read-only connection, through the request.

## 20. Not covered here

- **Which connectors each bot may use** (F-222): `controls.md` §4.
- **Provider accounts and T3 Code**: `bots.md`.
- **First run before the app opens**: `setup.md`.
- **A skill's page** and installing skills from the catalog: a design of its own.
- **Editing a plugin's settings** ("Needs setup"): the gateway's own settings page, until Settings designs it.
- **MCP Apps** (`mcp.app.*`, interactive views a server can show): not designed.
- **Changing a tool server** after it is added (other than removing it and adding it again): not designed; the same form with its values filled in is the obvious next step.
- **Signing a per-requester account out**: no gateway method exists.
- **Device apps on the iPhone** ("This iPhone": Calendar, Contacts, Location): another design.
- **Routines and check-ins, and links into the app**: other contributors' designs.
