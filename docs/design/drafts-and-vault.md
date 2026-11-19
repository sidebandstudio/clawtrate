# Drafts, the Vault and secure input

Three things a bot can ask of the person: to look at a message before it goes (a draft), to keep a secret for it (the Vault), and to type a secret it must never see (secure input). This part follows `visual-language.md`, `conversation.md`, `bots.md`, `work-pane.md` and `controls.md`, in the same language and with the same tokens. The evidence for every state is `docs/research/drafts-and-vault.md` ("research" below, by section), run on a development instance of OpenClaw 2026.10.6 with a research plugin and stand-in send tools.

What must be true is in `docs/parity.md`: the draft rows F-181, F-182, F-341 to F-345 and F-453; the secure input rows F-183, F-184 and F-346; and the Vault rows F-261 and F-338. This document decides appearance, wording and input, and names the gateway fact each state rests on (section 11). Section 12 is what Clawtrate's drafts plugin (issue #89) must do, as a list of hooks the research proved. Section 13 rewords dependency cells and lists the rows where this design must differ from the target, for a decision.

Three facts shape everything here, and the design never draws past them:

- **An answer cannot carry an edit.** A held call's answer is Allow once or Deny, the request carries no arguments, and the gateway copies the arguments when the hold starts; a change made afterwards did not reach the tool (research §1). So a draft card shows exactly what will be sent and lets the person send it or not. An edited draft is a new call the bot must make, and the card says so in its own words.
- **What a draft holds, a plugin holds.** No gateway setting holds a send for the person. Clawtrate's drafts plugin does, while it runs, and it fails open like the rules plugin (`controls.md` section 2): every place a draft would be says which plugin holds it and its state.
- **The Vault is the gateway's shared secret store.** One store for every bot on the gateway, admin only, named values with allowed hosts; nothing in an entry names a bot, and any bot offered the Secrets tool lists and can remove every entry (research §5). So the Vault never says an item is limited to a bot.

The prototype shows all of it: `prototype/drafts.html`, with its states from the address (section 14). The styles are in `prototype/css/drafts.css` and the behaviour in `prototype/js/drafts.js`; `prototype/tools/checks/drafts.mjs` checks them.

## Contents

1. How the pieces fit
2. Shared rules: what holds a draft, access, components, input, what the app keeps
3. The draft card
4. Editing a draft
5. Disable drafts for a bot
6. Settings, Drafts
7. The masked secret card
8. Settings, Vault
9. The Secure Form, password managers, and where a bot's secrets come from
10. Phone, themes, keyboard and screen reader
11. What the gateway's facts drive
12. Clawtrate's drafts plugin (#89)
13. Parity rows
14. For builders
15. Not covered here

## 1. How the pieces fit

```
conversation                  the draft card (3, 4) and the masked secret card (7), in the
                              card family of conversation.md §12 and §13; both count as
                              pending cards (conversation.md §14)
gateway menu, Settings (⌘,)   bots.md §7's frame; after controls.md's sections:
  Drafts                        which bots' sends wait as drafts, the plugin's state (6)
  Vault                         the gateway's shared secret store (8, 9)
```

Settings keeps `bots.md` section 7's two-pane frame; Drafts and Vault follow Machines (`controls.md` section 1), each with its title as its `h3`. Nothing is added to a bot's Settings tab: the drafts switch for a bot lives on the card (section 5) and in Settings, Drafts (section 6).

## 2. Shared rules

### What holds a draft

| Held by                       | What it covers                                                                                                                                     | Holds when Clawtrate and its plugins are gone                                                                              | How the gateway shows it                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clawtrate's drafts plugin** | Holding a send for the person; pinning what is sent to what the card shows; checking attached files again after the answer; which bots' sends wait | **No.** With the plugin gone the bot's send runs, or is refused or asked about, as its rules say (`controls.md` section 3) | A plugin approval (`plugin.approval.requested`) whose `request.pluginId` is the drafts plugin, and a refused call whose reason the plugin wrote |
| **The gateway**               | The shared secret store, its admin scope, its write-only protected values, the masked question                                                     | Yes                                                                                                                        | `secrets.store.*`, `question.requested` with `isSecret`                                                                                         |

**The plugin's state** is shown where a draft can be: in Settings, Drafts, and on the card's foot. It comes from the plugin's own status method (section 12), never from the method list alone (`controls.md` section 20, row 34). The states and their words are the rules plugin's (`controls.md` section 2), with its name: "Drafts plugin answered at 5:46 PM.", "Drafts methods unavailable on this gateway.", "Clawtrate's drafts plugin isn't answering.", "Clawtrate's drafts plugin is version 0.9; drafts need 1.0 or newer.", "Checking Clawtrate's drafts plugin…". The mark is `controls.md`'s plug mark, "Only while Clawtrate's drafts plugin runs", and while it is not running, "Not held now: the drafts plugin isn't running" in `--danger`.

When the drafts plugin is not running, no draft card can appear. The page says so in one note, and never shows a switch as if it held: "Clawtrate's drafts plugin isn't answering, so nothing waits as a draft. Otto, Pip and Marlow send as their rules allow."

### Access

A connection is judged by the scopes the gateway granted it (`controls.md` section 2). Every scope is asked for on its own, by the access bar's explicit request (`bots.md` section 2, `conversation.md` section 3); nothing is upgraded silently, and the page stays as it was when a request is denied.

| What                             | Read                                          | Interactive tier (write, approvals, questions)                      | Admin                                   |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| A draft card                     | Reads it; "Answering needs approvals access." | Sends, discards, edits (section 4)                                  | The same, and "Disable drafts for Otto" |
| The masked secret card           | Reads it; "Answering needs questions access." | Saves, skips                                                        | The same                                |
| A bot asking for a secret at all | —                                             | **The bot cannot ask** in a run this connection started (section 7) | It can                                  |
| Settings, Drafts                 | Sees                                          | Sees                                                                | Changes which bots' sends wait          |
| Settings, Vault                  | "Seeing the Vault needs admin access."        | The same                                                            | Sees, adds, replaces, removes           |

The bar's words: "Answering needs approvals access.", "Answering needs questions access.", "Changing drafts needs admin access.", "Seeing the Vault needs admin access. The gateway shows its secret store to admin connections only."

### Components used

| Component                                                                                             | From                               | Used for                               |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| Card frame, tag, summary, full request, buttons along the foot, Raw, the three answers to a decision  | `conversation.md` §12              | The draft card, the masked secret card |
| The question card's resolved forms                                                                    | `conversation.md` §13              | The masked secret card after an answer |
| Pending cards, the shelf row, the status line                                                         | `conversation.md` §14              | Both cards wait like an approval       |
| Settings frame, fact block, `.b-open` rows, note, switch, dialog, confirmation (`role="alertdialog"`) | `bots.md` §2, §7, §8               | Settings, Drafts and Vault             |
| The access bar and its request                                                                        | `bots.md` §2, `conversation.md` §3 | Every place below the scope it needs   |
| The plug mark, the plugin's state line                                                                | `controls.md` §2                   | Draft cards, Settings, Drafts          |
| Copy button and its two outcomes                                                                      | `conversation.md` §9               | A secret's name and its reference      |

### New components

Each is defined once, in `prototype/css/drafts.css`, from existing tokens. No colour token is added.

| Component                  | What it is                                                                                                                                                                           | Tokens                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Draft rows (`.d-rows`)     | An inset of label and value rows (From, To, Cc, Subject; Workspace, To, Thread), labels 13 px faint in a fixed column, values 15 px, a recipient list wrapping, never cut            | `--bg-inset`, `--text-faint`    |
| Draft body (`.d-body`)     | The message text in 15 px, pre-wrapped, folded at eight lines with "Show more" and "Show less"                                                                                       | `--text`                        |
| Attachment row (`.d-file`) | A file's name, its size, and under it the check line ("Checked when Otto asked, 5:42 PM")                                                                                            | `--bg-inset`, `--text-faint`    |
| Secure field (`.d-secure`) | The Secure Form's field: a pill input of type `password`, no autocomplete, no spelling, no capitalisation, with "Show" that reveals the typed value until the next keystroke or blur | `--bg-inset`, `--border-strong` |
| Hosts list (`.d-hosts`)    | Allowed hosts as removable chips and a field to add one; "No hosts: this secret can't be sent anywhere by the egress proxy." when empty                                              | `--bg-selected`                 |
| Vault row (`.d-vrow`)      | A `.b-open` row: the name in mono, its kind word, its hosts, "Updated Nov 19"                                                                                                        | `--bg-bubble`                   |

### Input

- Neither card takes focus when it arrives. "Review" on the composer's shelf, or ⌘J, moves focus to the oldest pending card (`conversation.md` section 14).
- The draft card's tab order: Show full request, Show more, the attachments, Send, Edit, Discard, Raw; "Disable drafts for Otto" is the last link of its foot. ⌘↵ inside the card is Send. Discard has no shortcut.
- The masked secret card's tab order: the field, Show, the hosts, Save securely, Skip, Raw. Enter in the field saves when it has a value. Escape clears the field; it never skips.
- One polite live region announces: "Sent", "Not sent", "Discarded", "Edits sent to Otto", "Saved securely", "Skipped", "Removed", "Couldn't save", and the access request's phrases. A value is never announced, and the field is never named by its value.

### What the app keeps

A secret typed into Clawtrate leaves the app once, in one request frame: `question.resolve` with the value at `answers.answers.<questionId>[0]` for a masked question, or `secrets.store.set` with `value` for the Vault (research §7). Then:

- The field is cleared the moment the gateway answers, whatever the answer; on "No answer" too. Nothing of it is kept to retry: "Try again" asks for the value again.
- It is never written to disk, a snapshot, a draft, a log, a crash report, a notification or the clipboard by the app, and never placed in Raw. Raw shows the question and the resolved event, whose answer the gateway keeps as `"stored"` (research §4).
- The field is excluded from any state the app restores: reopening a task, a reconnect or a reload shows it empty.
- On the phone the card is covered before the system takes the app switcher's snapshot (`work-pane.md` section 17).

## 3. The draft card

A draft is a send the bot made that Clawtrate's drafts plugin is holding for the person: a call of a tool on the plugin's list of sending tools (section 12), held by a plugin approval. The card is the approval card of `conversation.md` section 12 in a draft's form. Its content is the held arguments, which the plugin pinned when it asked, so the card shows what will be sent and nothing else (research §1). It is never filled from the bot's call as the client saw it: a hook can change arguments after that (research §1), so the client's tool event is shown only in Raw.

**The email draft** (F-181):

- **Title** (17 px, semibold): "New email". The tag at the top right: "Ready to send" on `--warn-soft` with a dot.
- **Line under the title** (13 px, muted): "Otto wants to send this from its email tool, mail_send." The tool's name is the one in the request (`request.toolName`); `mail_send` stands for a connector's tool (issue #85).
- **Rows** (`.d-rows`): From, To, Cc and Subject, each only when the tool's mapping (section 12) names that argument and the call carries it. A recipient list wraps. "From" is what the call says; when the tool's mapping has no sender argument the row reads "From: the account Otto's email tool is set up with. The tool doesn't say which." (F-181's rows, issue #85.)
- **Body** (`.d-body`), folded at eight lines with "Show more"; open, "Show less".
- **Attachments** (`.d-file`), one row each: name, size, and "Checked when Otto asked, 5:42 PM. Checked again before it's sent." (section 3, "A file that changed").
- **Buttons**: "Send email" (primary), "Edit" (default), and at the far right "Discard" (quiet). Under them, at the foot, "Disable drafts for Otto" (a text link; admin only) and the plugin's mark: "Held by Clawtrate's drafts plugin. It waits up to 10 minutes."
- **Show full request** opens an inset with the request's own fields: tool, bot, task, the time it was asked and when it expires, and the plugin's title and description.
- **Raw**: the request as the gateway sent it, the bot's call from the task's events, and the pinned arguments from the plugin (`clawtrate-drafts.get`).

**The Slack draft** (F-345, F-453): the same card, titled "Slack message", with Workspace, To and Thread rows and "Send message". The line under the title names the tool; for the gateway's own `message` tool it reads "Otto wants to post this through its Slack channel, with the message tool."

**Decisions and their three answers.** "Send email" is Allow once; "Discard" is Deny. Each follows `conversation.md` section 12's table exactly: "Sending…" until the gateway answers; the applied answer; "The gateway refused this decision." with its reason and "The draft is still waiting."; "Already answered on another device at 5:25 PM. Your decision was not applied."; and "No answer from the gateway. Your decision may or may not have been applied." with "Check again" and Discard. Discard stays visible in every pending state.

**After Send.** Allowing is not sending. The card reads what happened from the call's own result, never from the decision:

| What the gateway reports                                                                | Tag                     | The sentence                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tool's result reports what it sent (the stand-in's `details.received`, research §2) | "Answered"              | "Sent from otto@example.com to dana@example.com, cc lee@example.org, with report.txt (28 bytes), at 5:43 PM. Read back from the email tool's result." |
| The same, for the Slack draft                                                           | "Answered"              | "Posted to #ops in Example Co, in the thread Disk alerts, at 5:43 PM. Read back from the message tool's result."                                      |
| The tool succeeded but reports nothing of what it sent                                  | "Answered"              | "The email tool reported it sent this at 5:43 PM. It doesn't say what it sent; this is what you approved."                                            |
| The tool failed                                                                         | "Not sent" (`--danger`) | "The email tool failed: " and its message. "Nothing in its result says it was sent."                                                                  |
| The plugin refused it: a file changed                                                   | "Not sent" (`--danger`) | Below                                                                                                                                                 |
| No result yet                                                                           | "Sending…"              | "Sending. Otto's email tool hasn't reported back."                                                                                                    |

The resolved card folds to one line, 40 px: the tag, "New email to dana@example.com", the time, and a chevron; opened, it shows the rows, the body and the sentence as of that moment. It is the record of that send; nothing later changes it. (F-181's "Answered", F-342.)

**After Discard**: "Discarded" (neutral), "Discarded at 5:43 PM. Nothing was sent. Otto was told you discarded it." The gateway tells the bot "Denied by user. The tool call did not run." (research §1). (F-343.)

**Expired, closed, cancelled**: as `conversation.md` section 12, with "Nothing was sent." in place of "The command was not run.": "Expired at 5:52 PM without an answer. Nothing was sent.", "The run ended before this was answered. Nothing was sent.", "You stopped the run before answering. Nothing was sent."

**A file that changed** (F-341). The drafts plugin checks each attached file twice, on the gateway's machine: when the bot asks, and again after the person's answer, just before the tool runs; if it changed, the plugin refuses the call and nothing runs (research §3). Clawtrate reads no file itself.

- Pending, each file's line: "Checked when Otto asked, 5:42 PM. Checked again before it's sent."
- After Send, when the plugin refused: tag "Not sent", and "report.txt changed after Otto asked (28 bytes then, 44 now), so nothing was sent. Otto was told why. If it asks again, the new draft appears below." The numbers are the plugin's, from its refusal (section 12). The card does not reopen: that request is over, and only a new call can be sent (research §1).
- A file the plugin could not read when the bot asked, or one outside the bot's workspace: "Couldn't check report.txt: it isn't in Otto's workspace. If it changes before it's sent, Clawtrate can't tell." Send stays offered.
- A change while the tool runs, after the second check, is not caught, and the card doesn't claim it is: the line says "before it's sent", never "while it's sent".

**On a read-only connection** the card is shown readable, as `conversation.md` section 3: the rows, the body, the files, no buttons, and the access bar's "Answering needs approvals access." with its request.

## 4. Editing a draft

An answer cannot carry new text, and a change after the hold does not reach the tool (research §1). So "Edit" makes the card editable, and sending the edit is two steps the card names before either happens.

- **Edit** turns To, Cc and Subject (or To and Thread) into fields and the body into a text area, with the held values. The tag stays "Ready to send". Under the fields, on `--bg-inset`: "Edits can't be added to a waiting request. Sending your version discards this one and asks Otto to send yours instead. Otto's new email will wait here for you again." Buttons: "Send your version to Otto" (primary), "Cancel edit", and Discard at the far right.
- **Send your version to Otto**:
  1. Discard (Deny) this request, read back as Discarded. If the gateway refuses or doesn't answer, step 2 does not happen, and the card says so: "This request is still waiting, so your version wasn't sent to Otto." with "Try again".
  2. Send one message into the task, shown in the transcript as the person's own message: "Please send this instead:" followed by the edited fields as label and value lines and the body. It is an ordinary message (`chat.send`), so the bot may or may not make the new call.
  - The old card resolves as "Discarded: you sent your own version to Otto at 5:44 PM."
- **The new draft** is a new card, made from Otto's new call like any other. Clawtrate compares its held arguments with the version the person sent, field by field, and says the result on one line under the title, from the arguments alone:
  - "Matches the version you sent at 5:44 PM."
  - "Differs from the version you sent at 5:44 PM: Subject, Body." The differing rows carry a "Changed" mark, and "Show what you sent" opens the person's version beside it.
- If no new draft arrives, nothing claims one will: the transcript shows what the bot did.
- Edits are not kept anywhere but the card while it is open, and the message itself; closing the edit discards them.

(F-344's "editable in the card", F-453's "edited text".)

## 5. Disable drafts for a bot

"Disable drafts for Otto" (F-182) opens a confirmation (`role="alertdialog"`):

- Title: "Send Otto's emails and messages without drafts?"
- Text: "Otto's sends through mail_send and the message tool won't wait for you. They'll run as Otto's rules allow: what Otto may do (open). This is a setting of Clawtrate's drafts plugin; it holds only while the plugin runs."
- Buttons: "Send without drafts" (primary), "Cancel".

It saves one change to the drafts plugin's settings (section 12) and is announced only when the plugin's read-back agrees: "Drafts off for Otto." A refused or unanswered save keeps the card and says "Couldn't save. Drafts are still on for Otto." The card that offered it stays pending: turning drafts off changes later sends, not this one ("This draft is still waiting for you."). Below admin, the link is absent. Drafts are turned back on in Settings, Drafts.

"Subject to review" is not said: the gateway's automatic review covers commands only (`conversation.md` section 12), so a bot's sends without drafts follow its rules and nothing else.

## 6. Settings, Drafts

The section's title "Drafts", then:

- The plugin's state line (section 2), then a note: "When a bot sends an email or a message through one of these tools, Clawtrate's drafts plugin holds it here until you send or discard it. It holds only while the plugin runs."
- **Bots**: one row per bot with a switch, "Drafts" on or off, from the plugin's read (`clawtrate-drafts.get`). Admin changes it; the switch moves only when the read-back agrees, and says "Saving…" until then. Below admin, the switches are disabled with the access bar's "Changing drafts needs admin access."
- **Sending tools**: the plugin's list, read only, one row per tool: its name in mono, and what the card shows from it ("To from `to`, Cc from `cc`, Subject from `subject`, Body from `body`, files from `attachments`"). A tool not on the list never makes a draft; its calls follow the bot's rules.
- Not running: the switches are drawn, disabled, with the mark "Not held now: the drafts plugin isn't running", and the note of section 2. Nothing says a send waits.

## 7. The masked secret card

When a bot calls its Secrets tool to ask for a credential, the gateway raises a masked question (`isSecret`, `secretStore {name, kind, allowedHosts, reason}`, research §4). `conversation.md` section 13 shows such a record readable and not answerable; this is its design (F-184).

**Pending**, in the card frame with no outline, as a question:

- **Title** (17 px): "Otto asks for a secret". Tag: "Secret" on `--bg-selected`.
- **Rows**: Name (the entry's name in mono, with copy), Why (the bot's reason, as given, in quotation marks), and "It will be saved to your gateway's shared secret store." When an entry of that name exists: "This replaces the value saved as STORE_API_KEY on Nov 19."
- **Allowed hosts** (`.d-hosts`): the hosts the bot proposed, as chips the person can remove, and a field to add one. "The egress proxy sends this secret only to these hosts." Empty: "No hosts: the egress proxy won't send this secret anywhere. Settings that refer to it can still use it." The list sent is the one shown (`secretStoreAllowedHosts`).
- **The Secure Form's field** (`.d-secure`, section 9), labelled "Secret value", placeholder "Paste or type the value".
- **Buttons**: "Save securely" (primary, enabled once the field has a value) and "Skip" (quiet). The foot: "Never shown to Otto, and not kept by Clawtrate. Bots on this gateway see its name and hosts, not its value."
- **Raw**: the question record as the gateway sent it.

**After Save securely** (`question.resolve` with the value and the hosts):

| The gateway's answer   | The card                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None yet               | "Saving…"; the field is disabled                                                                                                                                                                                                                             |
| `answered`             | Tag "Saved", "Saved securely to your gateway as PRICE_TRACKER_KEY at 5:44 PM. Otto can't read it back." Then, when the bot's tool result arrives, its hosts as read back: "Allowed hosts now: api.example.com." (`currentPolicy`). The value's field is gone |
| Refused, with a reason | On `--danger-soft`: "The gateway didn't save it." and the reason. "Type it again to retry." The field is empty                                                                                                                                               |
| Already resolved       | "Already answered on another device." or "This request was skipped." Nothing is sent                                                                                                                                                                         |
| No answer              | On `--warn-soft`: "No answer from the gateway. The secret may or may not have been saved." with "Check", which reads the question's state (`question.get`): answered shows Saved; pending returns to the empty field                                         |

The field is emptied on every one of these (section 2).

**Skip** resolves the question with `cancel`: "Skipped. Otto was told no secret arrived." Expired: "Expired without an answer. Otto was told no secret arrived." Closed and cancelled: as `conversation.md` section 13.

**When the bot can't ask.** The gateway raises the masked question only in a run started from a connection with admin access (research §4). In a run started from the interactive tier, the bot's call fails at once with the gateway's own message, "missing scope: operator.questions". The action card shows that failure as any failed call (`conversation.md` §7.3), and its opened view adds one line: "Inferred: the gateway lets a bot ask for a secret only in a run started from a connection with admin access. This device has read, write, approvals and questions." Nothing offers to type the secret into the chat.

**On a read-only connection**: the card readable, the field absent, "Answering needs questions access." and the request.

## 8. Settings, Vault

The gateway's shared secret store, shown as it is (F-261). Admin only: below admin, the section is the access bar with "Seeing the Vault needs admin access. The gateway shows its secret store to admin connections only." and its request, and nothing else.

**The list.** A note first: "Secrets on this gateway. Every bot on the gateway can use them, through the hosts each allows; none can read a protected value back." Then "New item" (default) at its right, then one row per entry (`.d-vrow`), sorted by name:

- the name in mono; its kind: "Protected" or "Readable by bots"; its hosts ("api.example.com", or "No hosts"); "Updated Nov 19".
- **Empty**: "No secrets yet. A bot can ask for one in a conversation, or add one here."
- **Loading**: three skeleton rows. **Error**: "Couldn't read the Vault." and "Try again".

**An item's page** (a Settings page with a quiet round Back):

- Facts: Name (with copy), Kind, Allowed hosts, Updated, and "Reference: store · default · STORE_API_KEY" (with copy), the SecretRef settings use.
- **Who can use it**, as a note, true of every item: "Any bot on this gateway can use this through settings that refer to it, and, when the egress proxy is on, in commands on the gateway's machine sent to its hosts. Any bot offered the Secrets tool sees its name and hosts and can remove it. The gateway doesn't limit an item to chosen bots." Below it, the bots offered the Secrets tool, by name, from what each was last offered (`tools.effective`), labelled with its date.
- A protected value is never shown, and there is no Reveal. A "Readable by bots" item says so: "Bots can read this value: it is listed to them and given to their commands."
- Buttons: "Replace…" (default) and "Remove…" (quiet, `--danger`).

**New item and Replace…** open a dialog, the Secure Form (section 9): Name (uppercase letters, digits and underscores; "Use letters, digits and _" when invalid), the value's field, Kind ("Protected" by default, "Readable by bots"), and Allowed hosts. Replace fills Name and hosts and asks for the value again, because the gateway changes an entry only by setting its value (research §5). An existing name: "STORE_API_KEY exists. Saving replaces its value and hosts." Buttons "Save" (primary), "Cancel".

- **Saving**: one `secrets.store.set`, then `secrets.store.list`. "Saved." only when the listing shows the name with that kind and those hosts; the dialog closes on the new row. If the set answered but the listing disagrees or fails: "The gateway accepted it, but the Vault couldn't confirm it. Check the list." and the list is read again. Refused: "Couldn't save." and the reason; the field is emptied.

**Remove…** opens a confirmation (`role="alertdialog"`) that names what happens:

- Title: "Remove STORE_API_KEY?"
- Text: "Every bot on this gateway loses it: Otto, Pip, Marlow and Juniper. Settings that refer to it stop working: plugins.entries.price-tracker.config.apiKey. The gateway keeps the removed value for 30 days, then deletes it." The settings named are those in the gateway's settings that refer to the name, from `config.get`; with none, "No setting refers to it."
- Buttons: "Remove" (primary, `--danger`), "Cancel".
- **Removing**: one `secrets.store.delete`, then the listing. The gateway answers `ok` even for a name that isn't there (research §5), so "Removed. Otto, Pip, Marlow and Juniper can no longer use STORE_API_KEY." appears only when the listing no longer has it. Still listed: "The gateway answered, but STORE_API_KEY is still listed." with "Try again". Listing unreadable: "Removed? The gateway answered, but the Vault couldn't be read to confirm." with "Check".

**Logins, cards and contact details** are not kinds the store has: an entry is a name and a value. The Vault offers none of them.

## 9. The Secure Form, password managers, and where a bot's secrets come from

**The Secure Form** is Clawtrate's own field for a secret: the field of the masked secret card (section 7) and of the Vault's dialog (section 8). It is a single-line `password` input with `autocomplete="off"`, `spellcheck="false"` and `autocapitalize="off"`; "Show" reveals the typed value until the next keystroke or blur. Paste works. What it sends and what it keeps are section 2's.

It is not a form that fills a website's sign-in. Nothing proven puts a typed value into a site without the bot being able to read it afterwards (research §8), so Clawtrate draws no such card (section 15).

**A password manager.** What the app can say, and does, on the field's help line ("About filling this field"):

- "Clawtrate's field is its own. Electron, the framework it is built on, documents no password-manager or system fill for an app's fields, and doesn't run browser extensions such as password managers. Copy the value from your password manager and paste it." (research §6, from Electron's documentation.)
- On the iPhone this line is absent until it is researched (section 15).

**Where a bot's secrets come from.** Under the Vault's list, a fixed note, "Where a bot's secrets come from", with three short paragraphs:

- "This Vault: values the gateway keeps. A bot never reads a protected value; the gateway uses it for the bot."
- "A password manager the gateway offers a bot, such as its 1Password plugin: the value is given to the bot, which can see it."
- "Asking you: the bot asks in the conversation, and you type it into Clawtrate's field. It's saved here."
- Then: "Nothing on the gateway makes a bot try these in an order. Each bot chooses which to use." (research §6.)

## 10. Phone, themes, keyboard and screen reader

- **390 px, one pane**: both cards fill the column; the draft rows stack label over value; buttons stack at full width, 48 px, in the order Send, Edit, Discard, with Discard last in every state (`conversation.md` section 12). The hosts chips wrap. Settings sections open as pages with Back (`bots.md` section 19).
- **1100 and 800**: the cards keep their 640 px maximum; Settings keeps its two panes at 1100 and becomes one pane with Back at 800.
- **Themes**: light and dark from the tokens alone; the tags use `--warn-soft`, `--accent-soft`, `--danger-soft` and `--bg-selected` with their text tokens.
- **Screen reader**: a draft card is a `region` named "New email to dana@example.com. Ready to send."; the masked secret card "Otto asks for a secret: PRICE_TRACKER_KEY."; the field's label is "Secret value", its description the foot line. The rows are a description list. The "Changed" marks after an edit are words, never colour alone.

## 11. What the gateway's facts drive

| #   | Fact                                                                                                                                                                | Drives                                                                                        | Source                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | A plugin approval's answer is `allow-once`, `allow-always` or `deny`, and its request carries title, description, tool, call id, bot, task and expiry, no arguments | Send and Discard only; the card is filled from the plugin's pinned arguments, not the request | Research §1, live (`hold-allow`)                                            |
| 2   | A hook's returned `params` replace what the tool receives; the client's tool event still shows the bot's call                                                       | The card shows the pinned arguments; the bot's call only in Raw                               | Research §1, live (`rewrite`, `rewrite-write`)                              |
| 3   | The gateway copies the held arguments when the hold starts; a later change didn't reach the tool                                                                    | Editing is a new call (section 4)                                                             | Research §1, live (`hold-mutate`); `agent-tools.before-tool-call` line 1010 |
| 4   | Deny: "Denied by user. The tool call did not run."                                                                                                                  | Discarded's sentence                                                                          | Research §1, live (`hold-deny`)                                             |
| 5   | A hold needs a connected client claiming `plugin-approvals`, or it fails at once, "no approval route"                                                               | Clawtrate claims it with the approvals scope (`packages/core` `capsFor`)                      | Research §1, live                                                           |
| 6   | No built-in email tool; Slack through the `message` tool's channels                                                                                                 | The plugin's list of sending tools (section 12); F-181's rows come from a connector (#85)     | Research §2, source                                                         |
| 7   | A hook knows a tool by name only                                                                                                                                    | A list of tool names with an argument mapping each                                            | Research §1, §2, live                                                       |
| 8   | A send tool's result says what it sent only if it chooses to                                                                                                        | "Read back from the tool's result", or "doesn't say what it sent"                             | Research §2, live (stand-ins)                                               |
| 9   | An ordinary hold can't see a file change after the answer; a trusted policy's hold, then the plugin's ordinary hook, refused a changed file and ran nothing         | The two checks; "Not sent: report.txt changed"                                                | Research §3, live (`file-hold`, `file-trusted`, `file-trusted-unchanged`)   |
| 10  | The masked question: `isSecret`, `secretStore`, 15 minutes; the value in `question.resolve`; the record keeps `"stored"`; the tool's result has `currentPolicy`     | The masked secret card and its read-back                                                      | Research §4, live (`secrets`)                                               |
| 11  | The value was in no event, transcript, store listing, gateway log or model request; it is in plain text in the gateway's state database                             | "Never shown to Otto, and not kept by Clawtrate"; nothing claims the gateway encrypts it      | Research §4, live                                                           |
| 12  | A run started without admin can't raise the masked question: "missing scope: operator.questions"                                                                    | Section 7's inferred line                                                                     | Research §4, live (`secrets-noadmin`)                                       |
| 13  | `secrets.store.list`, `set`, `delete` are admin; set needs the value; entries are team-scoped and name no bot                                                       | The Vault is admin only; Replace asks for the value; no per-bot limit                         | Research §5, live (`store`), source                                         |
| 14  | Another bot lists and deletes any entry through its Secrets tool                                                                                                    | "Any bot offered the Secrets tool … can remove it"                                            | Research §5, live (`secrets`, `secrets-delete-by-other`)                    |
| 15  | Delete answers `ok` for an absent name; a removed value is kept 30 days                                                                                             | Removed only from the read-back; the 30 days in the confirmation                              | Research §5, live, source                                                   |
| 16  | The 1Password plugin's values are model-visible; Electron documents no fill for an app's field                                                                      | Section 9's help line and sources note                                                        | Research §6, source                                                         |
| 17  | No order among the store, a password manager and asking                                                                                                             | "Nothing on the gateway makes a bot try these in an order"                                    | Research §6                                                                 |
| 18  | The plugin's module may be evaluated more than once                                                                                                                 | Section 12                                                                                    | Research §1, live                                                           |

## 12. Clawtrate's drafts plugin (#89)

Written from this list, each item checked by a test or a review, with its own security review before it is installed on any gateway that is not a development gateway. Like the rules plugin, it fails open when it is gone, so nothing it does is presented as a guarantee (section 2). Each item names the hook the research proved.

**What it must do.**

- [ ] **Know the sending tools by name.** Keep a list of tool names, each with a mapping from its arguments to To, Cc, Subject, Body, Workspace, Thread, From and files. Match on `event.toolName` alone: the hook gets no owner (research §1, §2). Ship the gateway's `message` tool with `action: "send"` and the connectors of #85 as they arrive; anything else is not a draft.
- [ ] **Hold from the trusted tier.** Register a trusted tool policy (`api.registerTrustedToolPolicy`) for the listed tools, declared in `contracts.trustedToolPolicies`, with the plugin explicitly enabled. It returns `requireApproval` with `pluginId` set to its own id, `allowedDecisions: ["allow-once", "deny"]`, `timeoutMs: 600000`, a title of at most 80 characters and a description of at most 512. Without `pluginId` the gateway refused it (research §3).
- [ ] **Pin what is shown.** Return the arguments it saw as `params` with the hold, so the snapshot the gateway copies is exactly what the card shows; keep that snapshot by call id for `get` (research §1).
- [ ] **Check files twice.** Hash each attached file inside the bot's workspace when it holds; in its ordinary `before_tool_call` hook, which runs after the trusted approval with the approved arguments, hash them again and return `block` with a reason naming the file and both sizes when one differs (research §3). Refuse a path outside the workspace, through a link or a hard link, and report a file it couldn't read as unchecked.
- [ ] **Read back what was sent.** In `after_tool_call`, record for the call id whether the tool reported success, and whatever its result says it sent; never infer success from a missing error (`tool-policy.md`, "Tool call observation").
- [ ] **Keep state where every evaluation finds it**: one object for the hook, the trusted policy, the tools and the methods (research §1).
- [ ] Methods: `clawtrate-drafts.status` (read: version, whether the trusted policy and the hook are registered, the last call it saw); `clawtrate-drafts.get {toolCallId}` (approvals: the pinned arguments, the file checks, and, after the call, the read-back); `clawtrate-drafts.settings.get` (read) and `clawtrate-drafts.settings.set {bots, expectedVersion}` (admin: which bots' sends wait). An empty invalidation event; readers fetch again on receipt.

**What it must never do.** Change a held call's arguments after asking; send anything itself; read or keep a file's content beyond its hash and size; keep a call's arguments after the call has ended and its card has read them back; carry recipients, subjects, bodies or paths in an event a broader audience can read; ask about any tool not on its list; make a standing permission from an answer.

**What it leaves to others.** Whether a bot may send at all is the bot's rules (`controls.md`): a rules-plugin Never still blocks after a draft's answer, and a rules-plugin Ask for the same tool would ask a second time, after the draft (research §3, source); `controls.md` decides that pairing.

## 13. Parity rows

Every target stands as written. Only dependency cells are reworded, to what the research found; statuses stay `todo`.

| Row   | The dependency cell becomes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-181 | plugin: the drafts plugin of #89 (not built) holds the send with a trusted tool policy's `requireApproval` (**live** with a research plugin and a stand-in tool), shown from `plugin.approval.requested` and answered with `plugin.approval.resolve` (`operator.approvals`); the request carries no arguments, so the rows come from the plugin's pinned arguments (`clawtrate-drafts.get`). No email tool is built in; it must come from a connector (#85). A hold needs a client claiming `plugin-approvals`.                                                                                       |
| F-182 | plugin: a per-bot setting of the drafts plugin (#89, not built; `clawtrate-drafts.settings.set`, `operator.admin`), holding only while it runs. The gateway's automatic review covers commands only, so a send without drafts follows the bot's rules (`controls.md`).                                                                                                                                                                                                                                                                                                                                |
| F-183 | none: no proven way fills a website's sign-in without the bot being able to read it afterwards; typing during a takeover (`work-pane.md` §18) leaves the value on the page. The secret store's egress proxy substitutes values only in HTTPS requests from commands.                                                                                                                                                                                                                                                                                                                                  |
| F-184 | available: the bot's `secrets` tool `request` raises `question.requested` with `isSecret` and `secretStore {name, kind, allowedHosts, reason}`, only in a run started from a connection with `operator.admin` (otherwise the tool fails, "missing scope: operator.questions"); answered with `question.resolve {answers, secretStoreAllowedHosts}` (`operator.questions`); the record keeps "stored". **Live**: the value was in no event, transcript, store listing, gateway log or model request, and was stored in plain text in the gateway's state database; protected entries are never listed. |
| F-261 | partial: the shared secret store (`secrets.store.list`, `set`, `delete`, `operator.admin`) holds team-scoped named values (`secret` or `env`) with allowed hosts; no logins, cards or contact types, and no per-bot limit: any bot offered the `secrets` tool lists every entry and can delete it (**live**). A bot's deny list or a plugin hook can stop a bot's `secrets` calls, not its use of a value through settings or the egress proxy.                                                                                                                                                       |
| F-338 | none: nothing on the gateway orders the store, a password manager and asking the person; each bot chooses its tool. The store can't be limited to chosen bots (F-261), the bundled 1Password plugin's values are model-visible, and no Secure Form fills a site (F-183).                                                                                                                                                                                                                                                                                                                              |
| F-341 | plugin: the drafts plugin of #89 hashes attached files when it holds (trusted tool policy) and again in its ordinary `before_tool_call` hook after the answer, and blocks a changed file; **live** with a research plugin: a changed file was refused and the tool never ran; an ordinary hold alone sent the changed file.                                                                                                                                                                                                                                                                           |
| F-342 | plugin: Allow once (`plugin.approval.resolve`, `operator.approvals`) runs the call once with the arguments the drafts plugin pinned when it held (**live**); what was sent is read back from the tool's result only where the tool reports it. No email tool is built in (#85).                                                                                                                                                                                                                                                                                                                       |
| F-343 | plugin: Deny (`plugin.approval.resolve`, `operator.approvals`) refuses the held call, "Denied by user. The tool call did not run." (**live**, for an email and a Slack stand-in). No email tool is built in (#85); Slack goes through the `message` tool's channels.                                                                                                                                                                                                                                                                                                                                  |
| F-344 | plugin: an answer can't carry arguments, and the gateway copies the held arguments when the hold starts (**live**: a change after the hold didn't reach the tool), so an edited draft is a new call: the held one is denied and the edit is sent to the bot as a message; the bot's new call is held and compared with the edit.                                                                                                                                                                                                                                                                      |
| F-345 | plugin: as F-181, for a Slack tool (the gateway's `message` tool through a configured Slack channel, or a connector of #85).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F-346 | none: the masked question always saves to the shared store ("requests are protected-secret only"); there is no request that uses a value once without saving it, and no Secure Form fills a site (F-183).                                                                                                                                                                                                                                                                                                                                                                                             |
| F-453 | plugin: sending once as F-342; the edited text reaches the tool only through a new call (F-344), held and compared field by field before it is sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Rows for a decision**, where the design must differ from the target. Each row is left as it is:

- **F-182**: "subject to review" can't hold for a send: the gateway's review covers commands only.
- **F-183**: no Secure Form that fills a website is drawn; nothing proven keeps the value from the bot.
- **F-261**: the store has no logins, cards or contact types, and Clawtrate can't limit an item to chosen bots (the target's FC-02).
- **F-338**: nothing orders the sources, and the Vault restriction it tests can't exist.
- **F-341**: nothing is sent, but the card doesn't reopen: the request is over, and the bot must ask again for a new draft. The hold also comes from the trusted tier, where the issue named the rules plugin's ask.
- **F-344, F-453**: the edit is sent through the bot as a new call, held again and compared; it is not sent from the card that was edited.
- **F-346**: there is no "use once and don't save".

## 14. For builders

### What each part uses

| Part                   | Existing components                                                               | New                                |
| ---------------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| The draft card         | Card frame, tag, full request, buttons, Raw, the three answers, plug mark         | `.d-rows`, `.d-body`, `.d-file`    |
| Editing                | `.input`, text area, note                                                         | —                                  |
| The masked secret card | Card frame, the question card's resolved forms, copy                              | `.d-secure`, `.d-hosts`            |
| Settings, Drafts       | Settings frame, switch, note, plugin state line                                   | —                                  |
| Settings, Vault        | Settings frame, fact block, `.b-open`, dialog, confirmation, access bar, skeleton | `.d-vrow`, `.d-secure`, `.d-hosts` |

### What the engine supplies

- For a plugin approval whose `request.pluginId` is the drafts plugin: the plugin's pinned arguments and file checks (`clawtrate-drafts.get`), the tool's mapping, and after the call its read-back; the approval itself as `conversation.md` section 22 already supplies it.
- For a question record with `isSecret`: the record, and the call's result once it arrives (`currentPolicy`); never the value.
- The Vault: `secrets.store.list` on open and after every write, with each write's answer and its read-back kept apart; the settings that refer to a name, from `config.get`; the bots offered `secrets`, from `tools.effective` with its date.
- The drafts plugin's state, read on connect, on its invalidation event and every 60 seconds while a page that shows it is open.

### Order

1. Prove the drafts plugin's hold, pin, recheck and read-back on a development gateway with stand-in tools (research §1 to §3 show each hook), then its status and settings.
2. The masked secret card (it needs no plugin): F-184, with the value's path checked as research §4 did.
3. The Vault read-only, then its writes with read-back: F-261's part that exists.
4. The draft card from a held stand-in: F-181, F-345, F-342, F-343, F-453's send.
5. A changed file: F-341. Editing as a new call: F-344, F-453's edit. Disable drafts: F-182.

### Prototype states

`prototype/drafts.html` takes `theme`, `width`, `motion` and `chrome` like every page, and:

| Parameter | Values                                                                                                                                                                                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`    | `draft` (the default), `secret`, `vault`, `drafts`                                                                                                                                                                                                                                                                                  |
| `kind`    | `email` (the default), `slack`: which draft (with `view=draft`)                                                                                                                                                                                                                                                                     |
| `d`       | The draft card's state: `pending` (the default), `full` (full request open), `sending`, `sent`, `sentnoreport`, `failed`, `discarded`, `refused`, `noanswer`, `already`, `expired`, `closed`, `cancelled`, `filechanged`, `unchecked`, `edit`, `editsent`, `editfailed`, `match`, `differs`, `disable`, `disabled`, `disablefailed` |
| `s`       | The masked secret card: `pending` (the default), `typed`, `hosts`, `exists` (the name is in the Vault already), `saving`, `saved`, `refused`, `noanswer`, `already`, `skipped`, `expired`, `cannotask`                                                                                                                              |
| `v`       | Settings, Vault: `list` (the default), `empty`, `loading`, `error`, `item`, `new`, `replace`, `saved`, `unconfirmed`, `failed`, `remove`, `removed`, `stilllisted`, `removeunknown`                                                                                                                                                 |
| `p`       | Settings, Drafts and the card's foot: `running` (the default), `stopped`, `absent`                                                                                                                                                                                                                                                  |
| `access`  | `admin` (the default), `interactive`, `read`                                                                                                                                                                                                                                                                                        |
| `req`     | The access request: `requested`, `denied`                                                                                                                                                                                                                                                                                           |

Every path is walked by clicking: Send to Sent, Discard to Discarded, Edit to the new draft that matches or differs, a changed file to Not sent, Disable to Drafts off; Save securely to Saved, Skip to Skipped, No answer to Check to Saved; New item to Saved, Remove to Removed. The prototype bar picks what the gateway does next: "Gateway answers" (applied, the default; refused; already answered; no answer) for a decision, a secret or a drafts switch; "Vault" (confirmed, unconfirmed, unreadable or refused) for a Vault write; "Tool result" (reports what it sent, says nothing, fails); and "Otto's new call" (matches or differs from an edit). Its buttons "Change report.txt", "Expire", "Run ends" and "Stop" are the events a waiting card reacts to.

`gallery.html` has a section, "Drafts and the Vault", with a link to every state above.

## 15. Not covered here

- Connectors and their accounts (#85): which email and Slack tools exist, which account a send comes from, and how their arguments map to a draft's rows. This design needs from each a tool name and that mapping, and reads its result for what it sent.
- The approval and question cards themselves (`conversation.md` §12, §13), the rules and the Permissions page (`controls.md`), a bot's settings (`bots.md`): used as they are.
- Routines and check-ins, and links into the app: other designs. A routine's send can't wait for anyone (`controls.md` section 3, "When nobody can be asked"); what a draft does there is the routines design's.
- The iPhone's own permission requests, and whether the iPhone's AutoFill reaches the Secure Form: not researched, and the iOS app is not on `main`.

Cut from this design because nothing proven supports them, each waiting for a capability the gateway doesn't have:

- **A Secure Form that signs in to a website** ("Sign in to <site>", "Filled directly to <site>") and "Securely save to Bot's vault": waits for a fill the bot cannot read back. F-183 and F-346 stay `todo`.
- **Editing a waiting draft in place**: waits for an approval answer that can carry arguments.
- **A Vault item limited to chosen bots**, and an order among the store, a password manager and asking: wait for a store that scopes entries to bots and for a gateway-side order. F-261's better target and F-338 stay `todo`.
- **Logins, cards and contact details** as Vault kinds: the store keeps names and values only.
