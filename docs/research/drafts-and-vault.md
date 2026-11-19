# Drafts, the Vault and secure input: what the gateway allows

What an OpenClaw gateway lets Clawtrate do for three things: a message a bot wants to send that waits for the person as a draft, secrets kept on the gateway and which bots can use them, and a secret typed into the app. It was checked against OpenClaw 2026.10.6 and is the evidence behind `docs/design/drafts-and-vault.md`. It settles the dependency cells of `docs/parity.md` rows F-181 to F-184, F-261, F-338, F-341 to F-346 and F-453.

How to read the citations, as in `gateway-capabilities.md` and `setup-flow.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Chunk names carry a build hash that changes with every release; search by the `//#region <source path>` marker instead. Line numbers are of the 2026.10.6 chunks.
- **Live** means it was run on a development instance and the result is quoted. **Source** means it was read in shipped code or bundled docs only (read-only-from-source). **Unverified** marks what could not be run here, with the reason.

Where things were run:

- **One named development instance**, `d8vault`, started by this checkout with `pnpm dev-gateway start --instance d8vault --no-seed` (gateway on a loopback port the tool chose). Nothing else was touched.
- **A research plugin**, [`dev-gateway/drafts-probe-plugin`](dev-gateway/drafts-probe-plugin/index.js), installed on that instance only with `openclaw --profile clawtrate-dev-d8vault plugins install --link --force <its folder>` and `plugins enable clawtrate-drafts-probe`. It adds two stand-in send tools, `probe_send_email` and `probe_send_slack_message`, which send nothing: each returns exactly the arguments it received, and the size and SHA-256 of each attached file as it read them when it ran. A `before_tool_call` hook, switched by its `mode` method, rewrites their arguments (`rewrite`), holds them with `requireApproval` (`hold`), or mutates its own returned arguments after the hold (`hold-mutate`). A trusted tool policy holds a call and its ordinary hook then rechecks attached files after the answer (`trusted`). `after_tool_call` keeps what the tools received, in memory.
- **The research scripted model**, [`dev-gateway/fake-openai.mjs`](dev-gateway/fake-openai.mjs), on loopback port 19777. The development gateway's own scripted model plays only its fixed scenarios and cannot call a plugin's tool or `secrets`, so on this instance only, with `openclaw --profile clawtrate-dev-d8vault config set`, a provider `research` pointed at it, Marlow and Pip were put on `research/scripted`, and `probe_send_email`, `probe_send_slack_message` and `secrets` were added to `tools.allow`. Its `#tool <name> <json>` makes one tool call with exactly those arguments. Juniper (`main`) stayed on the development model for the `#write` probe.
- **The probes**, [`dev-gateway/drafts-probe/probe.ts`](dev-gateway/drafts-probe/probe.ts), run as `node docs/research/dev-gateway/drafts-probe/probe.ts d8vault <scenario>`. They connect through `tools/dev-gateway`'s own paired operator client, with `operator.read`, `write`, `approvals`, `questions` and `admin`, and the client capabilities `tool-events`, `approvals`, `exec-approvals` and `plugin-approvals`. Each scenario prints what it saw and asserts nothing.

Every value submitted was made up (`example-secret-value-<uuid>`, entry names `D8_EXAMPLE_…`, addresses at `example.com` and `example.org`). No email, Slack message or account of any service was used. The instance was reset afterwards (section 9).

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | Can an approval decision change a call's arguments? | No. A plugin approval offers `allow-once`, `allow-always` and `deny`, and resolving one takes only the decision. The request the client receives carries no arguments. **Live** and **source**. | 1 |
| 2 | Can a plugin's `before_tool_call` hook replace a call's arguments? | Yes. A hook that returned `params` changed what the tool received, for a plugin's tool and for the gateway's own `write` (the file on disk held the hook's text). The client's tool event and the transcript's tool call still showed the bot's original arguments. **Live.** | 1 |
| 3 | Can it hold a call, and what does the person's answer send? | Yes, with `requireApproval`. Allow once ran the call with the arguments the hook returned when it asked; Deny ran nothing. The gateway copies those arguments when the hold starts: the plugin changed its own object afterwards and the tool still received the original. So the hook that asked cannot apply a later edit. **Live.** | 1 |
| 3a | Can a person's edit reach the tool after all? | Yes, with a second hold. A trusted tool policy held the call; the person's edit went to the plugin through its own method (`operator.approvals`), bound to that call id; after the answer the plugin's ordinary hook returned the edited `params` with a second `requireApproval`, and after Allow once on that second hold the tool received the edit. Returning the edited `params` without the second hold was refused: "Tool call parameters changed after trusted approval", and the tool did not run. Deny on either hold, a changed file, or a gateway restart sent nothing. **Live.** | 1a |
| 4 | Which tools send an email or a Slack message here, and how does a plugin know one? | No email-sending tool is built in; the bundled `imap` plugin only receives mail. Slack is a channel, and the built-in `message` tool sends through configured channels. **Source.** A hook knows a tool only by its name: its event carries `toolName`, `params`, `runId` and `toolCallId`, and its context names the bot and task but not which plugin owns the tool. **Live.** | 2 |
| 5 | Can a plugin know an attached file changed between the draft and the send? | Partly, and only with the trusted tier. A file changed while an ordinary hold waited was sent changed. A trusted tool policy that held the call, followed by the same plugin's ordinary hook rechecking the file after the answer, refused the changed file and nothing ran; an unchanged file was sent. For an edited draft the recheck runs before the second hold, and a file changed during that hold was sent changed (section 1b). **Live.** | 3, 1b |
| 5a | Who can see a held draft or a question? | Read-only: neither (refused, no event). Another device with approvals: no hold listed, no event. A second admin, and the run's own device: the hold. Only admin lists the Vault. **Live** (section 1b). | 1b |
| 6 | What does the bot's `secrets` tool do with a made-up value? | It raises a masked question (`isSecret`, `secretStore {name, kind, allowedHosts, reason}`). The value travels once, in `question.resolve`; the answer the gateway keeps reads `"stored"`. The value was in no event, no transcript, no store listing, no gateway log and no model request, and was in plain text in the instance's state database. A run started without admin could not ask at all. **Live.** | 4 |
| 7 | The Vault: what does `secrets.store.*` offer? | One store for the whole gateway (`scopeKind: "team"`), admin only for list, set and delete. Entries are named values with allowed hosts; nothing in them names a bot. Another bot listed an entry Pip had asked for, and deleted it. Delete answers `ok` even for an entry that is not there, and keeps the value for 30 days. **Live** and **source**. | 5 |
| 8 | Can an item be limited to chosen bots? | Not by the gateway. A plugin can refuse a bot's `secrets` calls, and a bot's own deny list can remove the tool, but neither stops a stored value being used by every bot through the gateway's egress substitution or a setting that refers to it. **Source**, with the listing and deletion **live**. | 5 |
| 9 | A password manager? | The bundled 1Password plugin gives a bot a `onepassword` tool whose values the model does see. Electron's documentation describes no password-manager or system fill for an app's own field, and says Electron does not support arbitrary Chrome extensions. **Source** (Electron's documentation). | 6 |
| 10 | What does the app keep of a secret typed into it? | One frame carries it: `question.resolve` (`answers.answers.<questionId>[0]`) for a masked question, or `secrets.store.set` (`value`) for the Vault. Neither answer, nor any event the client received, carried it back. | 7 |

## 1. Holding a call, and its arguments

### What an approval decision can carry (source, live)

- A plugin approval's decisions are `allow-once`, `allow-always` and `deny` (`<openclaw>/docs/plugins/hooks/tool-policy.md` lines 47-55). `plugin.approval.resolve` takes `{id, decision}`. Live, `hold-allow`: `{"ok":true}` for `{id, decision: "allow-once"}`.
- The request the client receives carries no arguments. Live, `hold-allow`, the whole `plugin.approval.requested` payload: `{"approvalKind":"plugin","id":"plugin:…","request":{"pluginId":"clawtrate-drafts-probe","title":"Send this draft?","description":"Research hold of probe_send_email","scope":null,"detail":null,"severity":null,"toolName":"probe_send_email","toolCallId":"call_…","policySubject":{…},"allowedDecisions":["allow-once","deny"],"agentId":"pip","sessionKey":"agent:pip:dashboard:…","runId":"…","turnSourceChannel":"webchat",…},"createdAtMs":…,"expiresAtMs":…}`. `plugin.approval.list` returned the same record.
- A hold needs a connected client that claims the `plugin-approvals` capability. Live: with only `tool-events`, the call failed at once, `"Plugin approval unavailable (no approval route)"`, and the plugin's `onResolution` received `cancelled`.

### A hook replaces the arguments (live)

- `rewrite`, a plugin's tool: the hook returned `{params: {...event.params, body: "REWRITTEN BY THE HOOK"}}`. The tool received `"body":"REWRITTEN BY THE HOOK"`, and `after_tool_call` saw the same. The client's `agent` tool event (`phase: "start"`) showed the bot's original body, and `chat.history` held both: the bot's call with the original, and the tool's result echoing the rewrite.
- `rewrite-write`, the gateway's own `write` (Juniper's `#write` on the development model): the tool event showed `"content":"# Scratch\n\n- Check the trail map.\n"`, the tool reported `Successfully wrote 21 bytes`, and `notes/scratch.md` on disk read `REWRITTEN BY THE HOOK`.

So what a client sees as a call's arguments is the bot's call, not necessarily what the tool received. Only the tool's own result, or a plugin's `after_tool_call`, knows what was sent.

### Holding, and what the answer sends (live, source)

- `hold-allow`: the hook returned `{params: <a copy of event.params>, requireApproval: {title, description, timeoutMs: 600000, allowedDecisions: ["allow-once", "deny"]}}`. Before the answer only the tool's `start` event existed. After Allow once the tool received the held arguments exactly.
- `hold-deny`, the Slack stand-in: after Deny the result was `"Denied by user. The tool call did not run."` (with the gateway's instruction not to retry), and the tool never ran.
- `hold-mutate`: after the hold began, the plugin changed the `body` of the very object it had returned (`mutate` answered `{"mutated":"body"}`). After Allow once the tool received the original body. The gateway copies the returned arguments when the hold starts: `resolveBeforeToolCallApprovalOutcome` clones them (`<openclaw>/dist/agent-tools.before-tool-call-B71Yo63P.mjs` line 1010) and on an allow merges that copy over the call's (lines 784-789, 873-877).
- When several hooks answer, "the first `requireApproval` wins … It freezes the selected parameter snapshot: later handlers can block but cannot change the approved parameters", each handler sees "an isolated copy of the original event, not prior returned rewrites", and "the last returned `params` wins until an approval is requested" (`tool-policy.md` lines 66-73; `<openclaw>/dist/hooks-Cydhx3JC.mjs` lines 831-850). A lower-priority `block` still blocks (line 82). **Source.** So a hook that asks and also returns the arguments it saw makes the held snapshot exactly those arguments, even when an earlier hook rewrote them.
- A hook could also wait inside itself: `before_tool_call` handlers time out after 15 s by default and a plugin may set its own `timeoutMs` (`hooks-Cydhx3JC.mjs` lines 351-354; `<openclaw>/dist/registry-Ctt4xQAS.mjs` line 606). Such a wait is not a hold the gateway knows of: no card, no expiry, no answer route. **Source**, not designed on.

### Two facts about the plugin itself (live)

- The gateway evaluated the research plugin's module more than once: with state kept in module variables, a mode set through its method was never seen by its hook, while its tools and methods shared a record. With the state in one object on `globalThis`, all three agreed. A plugin that holds drafts must keep its state where every evaluation finds it.
- The hook's event had the keys `params`, `runId`, `toolCallId` and `toolName`; its context `abortSignal`, `agentId`, `channelId`, `requester`, `runId`, `sessionId`, `sessionKey`, `toolCallId`, `toolName` and `trace`. Nothing named the plugin that owns the tool (`toolOwnerPluginId` was absent).

## 1a. An edit after a trusted hold (round 1)

The question: section 1 shows the hook that asks for a hold cannot apply a later edit, and section 3 shows that the same plugin's ordinary hook runs after a trusted policy's hold is answered. Can that ordinary hook apply an edit the person gave the plugin before the answer? Run on the same named instance, started again for this, with the research plugin's modes `trusted-edit` and `trusted-edit-approve`, its method `clawtrate-drafts-probe.edit {toolCallId, params}` registered at `operator.approvals`, and the scenarios `edit-plain`, `edit-approve`, `edit-deny-first`, `edit-deny-second`, `edit-file`, `edit-restart` and `edit-readonly`. The run was started by the admin client; the edit was sent by a second client holding read, write, approvals and questions, not admin. The bot's call: `{"to":["dana@example.com"],"cc":["lee@example.org"],"subject":"Media box report","body":"The disk is 91% full. …","attachments":["outbox/report.txt"]}`. The edit: `to` with `sam@example.net` added, `subject: "Media box report: disk at 91%"`, `body: "EDITED BY THE PERSON"`.

Steps and what came back, the same in every scenario up to the answer:

1. The trusted policy held the call: `plugin.approval.requested`, title "Send this draft?", the call id, no arguments. The second client did not receive it (as `controls.md` section 20, row 30).
2. The second client called `edit` with a call id the plugin wasn't holding: refused. With the held call's id: `{"stored":true}`. A second `edit` for the same call: refused. The client saw each refusal only as `"gateway request failed"`; the plugin's own reason does not reach it.
3. From a read-only connection (`edit-readonly`), `edit` was refused by the gateway: `"missing scope: operator.approvals"`.
4. The method's handler receives its caller's connection: `client.connect` with `scopes`, `device`, `caps`, `role` and `auth`, and `client.connId` (key names recorded, values not kept).

After the first answer:

| Scenario | What the ordinary hook returned after the answer | What happened | What the tool received |
|---|---|---|---|
| `edit-plain` | The edited `params`, no hold | Refused: `"Tool call parameters changed after trusted approval"` (as `tool-policy.md` lines 253-262 and `agent-tools.before-tool-call` lines 3413-3421 say) | Nothing: it did not run |
| `edit-approve` | The edited `params` with a second `requireApproval` | A second `plugin.approval.requested`, title "Send the edited draft?", the same call id, **no arguments**. Allow once on it | **The edit**: `to: ["dana@example.com","sam@example.net"]`, `subject: "Media box report: disk at 91%"`, `body: "EDITED BY THE PERSON"`, the attachment unchanged; `after_tool_call` saw the same. No further hold |
| `edit-deny-second` | As `edit-approve`; Deny on the second hold | "Denied by user. The tool call did not run." | Nothing |
| `edit-deny-first` | Nothing: Deny on the first hold ends the call before the ordinary hook | "Denied by user. The tool call did not run."; no second hold | Nothing; the stored edit was never used |
| `edit-file` | `block`: the file recheck runs before the edit, and `report.txt` had changed (28 bytes, then 44) | `status: "blocked"`, "An attached file changed after the draft was shown. Nothing was sent."; no second hold | Nothing |

- **An edit after the answer**: refused by the plugin in every scenario (`entry.answered` set by the trusted hold's `onResolution`).
- **What the conversation keeps**: the client's tool `start` event and the bot's call in `chat.history` still carried the bot's original arguments; the tool's result (the stand-in's echo) carried the edit. Only the plugin's record says that the bot asked for one thing and the edited version was sent.
- **A restart in between** (`edit-restart`): hold, edit stored, then `gateway.restart.request`. The trusted hold's `onResolution` received `cancelled`, the call failed with "Plugin approval required (gateway unavailable)", the approval list was empty afterwards, answering the old id was refused ("unknown or expired approval id"), the edit was never applied, and the edited text was in no history. The plugin's state survived this in-process restart because it lives on `globalThis`; a process restart would lose it.

So an edit can reach the tool, at this strength: the person answers twice. The first answer releases the bot's call to the plugin; the plugin swaps in the edit and holds again; the second answer, on a hold whose arguments the gateway froze as the edit, sends it.

## 1b. Four more behaviors, confirmed for the review (round 1 fixes)

Run on the same named instance, started again and set up as above, with the scenarios `edit-file-second`, `scopes`, `store-env` and `edit-abort`, then reset.

- **A file changed during the second hold** (`edit-file-second`). The plugin's recheck after the first answer saw `report.txt` unchanged (28 bytes). The file was then rewritten while the second hold waited, and after Allow once on it the tool read 45 bytes (`sha256 d5ed87b6…`). The gateway runs no hook between the second answer and the tool (`agent-tools.before-tool-call` lines 3373-3437). The edited body, with two spaces and a line break (`"EDITED  twice-spaced\nsecond line"`), arrived exactly.
- **Who can see a hold or a question** (`scopes`), while the run owner's call was held:

  | Connection | `plugin.approval.list` | The hold's event | `question.list`, `question.get` | `secrets.store.list` |
  |---|---|---|---|---|
  | Read only | Refused, "missing scope: operator.approvals" | Not received | Refused, "missing scope: operator.questions" | Refused, "missing scope: operator.admin" |
  | Another device with read, write, approvals and questions | `[]` | Not received | — | Refused, "missing scope: operator.admin" |
  | A second admin connection | The hold | — | — | — |
  | The run's own device (admin) | The hold | Received | — | — |

  The gateway lets a client see one approval only if it holds admin, or holds approvals and is the device the approval is bound to (`canAccessOperatorApproval`, `<openclaw>/dist/operator-approval-authorization-C9wV2RU-.mjs` lines 5-22). Neither list carries the call's arguments.
- **An environment entry** (`store-env`). `secrets.store.set` with `kind: "env"` and `allowedHosts: []` was refused, "Allowed hosts apply only to secret entries."; without hosts it was saved, and `secrets.store.list` returned its value (`value`, 54 characters). Source: `toProtocolStoreEntry` returns `value` for `env` entries (`secrets-VYaSXWxr.mjs` lines 18-38), and the store hands `env` values to commands as plain environment (`<openclaw>/dist/secret-store-CwR360wK.mjs` lines 208-227).
- **Stopping the run during the second hold** (`edit-abort`). `chat.abort` answered `{"aborted":true}` and the run ended `aborted`, but `plugin.approval.list` right afterwards still listed the second hold; answering it was refused, "approval already resolved", and the tool did not run.

Read in source only, for the same review:

- A masked answer can come back as an error after the value was stored: `"Secret store entry was saved, but runtime refresh failed. Resolve provider errors and retry secrets.reload; do not resubmit this answer."` (`<openclaw>/dist/question-BTDP13J4.mjs` lines 317-367).
- `secrets.store.set` and `delete` can likewise answer with an error after they committed: "Secret store entry was saved, but post-write runtime refresh failed…" and "Secret store entry was deleted, but the active runtime could not refresh…" (`secrets-VYaSXWxr.mjs` lines 96-130). Their success answer is `{ok: true, reloaded}`.
- A deleted row keeps its value until a purge removes rows deleted more than 30 days earlier (`<openclaw>/dist/secret-store-validation-C11QxAUr.mjs` lines 11-25); a later write of the same name revives the row with the new value (`<openclaw>/dist/openclaw-state-worker-runtime-D_3s_wGm.mjs` lines 804-828).
- The secrets tool's `currentPolicy` is `available` (the complete host list), `omitted`, `missing`, `kind_changed` or `unavailable` (`<openclaw>/dist/openclaw-tools-DV-z1IAc.mjs` lines 10767-10812).
- The message tool also takes `targets`, `replyTo` and `threadId` (lines 6675-6681, 6805-6808), so one `target` alone may not be the whole destination.

## 2. Which tools send, and what a card can show

- **Email.** No tool the gateway provides sends email: the tool catalogue of 2026.10.6 has none (`tools/dev-gateway/src/cli.ts`, `GATEWAY_TOOLS`), the bundled `imap` plugin "watch[es] IMAP mailboxes and dispatch[es] authenticated incoming email" (`<openclaw>/dist/extensions/imap/openclaw.plugin.json`), and the gateway's Gmail watcher is incoming too. An email tool comes from a connector: a plugin or an MCP server (issue #85). **Source.**
- **Slack.** Slack is a channel, and the built-in `message` tool sends "across configured channels" (`<openclaw>/docs/tools/index.md` line 94; `<openclaw>/dist/openclaw-tools-DV-z1IAc.mjs` lines 8083-8090). Its arguments include `action`, `channel`, `accountId`, `target` or `targets`, `message`, `media`, `attachments`, `buffer`, `replyTo` and `threadId` (lines 6675-6810), and it adjusts its target in `prepareBeforeToolCallParams` before hooks run. It is denied on every development instance and was not run. **Source**, unverified live.
- **Recognising one.** A hook matches a tool by its canonical name only (`<openclaw>/dist/hook-types-CoUXuQe1.mjs` lines 12-34) and receives no owner (section 1). So a plugin that treats some tools as sends needs its own list of tool names, and for each, which argument holds the recipients, the subject, the body and the files. Anything else is not a draft.
- **What a card can show.** Exactly the held arguments: for the email stand-in `from`, `to`, `cc`, `subject`, `body` and `attachments` (paths); for the Slack stand-in `workspace`, `to`, `thread` and `text`. Live, `hold-allow` and `hold-deny`. Whether a real tool's arguments name the account it sends from depends on that tool.
- **What was sent.** The stand-ins' results reported exactly what they received (`details.received`), so a card could read it back. A real tool reports what it chooses; where it reports nothing, only the held arguments are known.

## 3. An attached file that changed

- **Ordinary hold** (`file-hold`): `outbox/report.txt` was 28 bytes when the hook held the call; while the card waited it was rewritten to 44 bytes; after Allow once the tool read and "sent" 44 bytes (`sha256 441e6371…`). Nothing of the plugin runs between the answer and the tool, so an ordinary hold can check files only when the bot asks.
- **Trusted hold, then a recheck** (`file-trusted`): a trusted tool policy (`api.registerTrustedToolPolicy`) returned the `requireApproval`, and recorded the file's hash (28 bytes, `sha256 18f0cb48…`). The gateway runs ordinary `before_tool_call` hooks after a trusted policy's approval completes, with the approved arguments (`tool-policy.md` lines 253-262; `agent-tools.before-tool-call-B71Yo63P.mjs` lines 3330-3420). The same plugin's ordinary hook read the file again (44 bytes, `441e6371…`) and returned `block`. The result: `{"status":"blocked","deniedReason":"plugin-before-tool-call","reason":"An attached file changed after the draft was shown. Nothing was sent."}`, and the tool never ran. With the file unchanged (`file-trusted-unchanged`) the call ran.
- **What it takes.** An installed plugin may register a trusted policy only if its manifest declares the policy's id in `contracts.trustedToolPolicies` and the plugin is explicitly enabled (`registry-Ctt4xQAS.mjs` lines 1359-1378). Its approval must name the plugin: without `pluginId` the gateway refused it, `"Plugin approval request rejected: signed plugin approval owner is unavailable"` (live, first attempt).
- **Who reads what, when.** The plugin reads each attached file on the gateway's machine, inside the bot's workspace, twice: when the bot asks, and after the person's answer, just before the tool runs. Clawtrate reads nothing. A file the plugin cannot read, or a path outside the workspace, cannot be checked. A file changed after the recheck, while the tool runs, is not caught.
- **Ordering with other hooks.** Trusted policies run before ordinary hooks, so a rules plugin's ordinary Ask for the same tool would ask again after the draft's answer, and its Never would block after it (`agent-tools.before-tool-call-B71Yo63P.mjs` lines 3290-3420). **Source.**

## 4. The bot's `secrets` tool and the masked question

Live, `secrets`, run from the probe client (admin and questions) in a task of Pip's, with a made-up value:

- **The event.** `question.requested`: `{"id":"ask_…","questions":[{"questionId":"secret_value","header":"API key","question":"Provide the secret for D8_EXAMPLE_TOKEN_….","options":[],"isSecret":true,"secretStore":{"name":"D8_EXAMPLE_TOKEN_…","kind":"secret","allowedHosts":["api.example.com"],"reason":"Research: a made-up token"}}],"agentId":"pip","sessionKey":"…","runId":"…","createdAtMs":…,"expiresAtMs":…,"status":"pending"}`. It waits 15 minutes (`expiresAtMs - createdAtMs` = 900,000).
- **What the answer travels in.** `question.resolve {id, answers: {answers: {secret_value: [<value>]}}, secretStoreAllowedHosts: ["api.example.com"]}`. The gateway answered `{"status":"answered","answers":{"answers":{"secret_value":["stored"]}}}`: the record keeps `"stored"`, not the value.
- **What the bot got.** The tool's result: `Stored; value hidden.` and `{"status":"stored","name":…,"kind":"secret","ref":{"source":"store","provider":"default","id":…},"currentPolicy":{"status":"available","allowedHosts":["api.example.com"]}}`.
- **Where the value was afterwards**, searched for byte for byte:

  | Place | The value |
  |---|---|
  | Every event the probe client received | Absent |
  | `chat.history` of the task (the entry's name was present) | Absent |
  | `secrets.store.list` | Absent; the entry listed with `kind`, `allowedHosts`, times and `updatedBy` |
  | The gateway's log for the instance | Absent (the name too) |
  | The development model's log, and every request the research model received (the name was in three) | Absent |
  | The instance's state folder | Present once, in plain text: `state/openclaw.sqlite`, table `secret_store_entries`, column `value` |

- **Who updated it.** `updatedBy` held a person's display name: the gateway takes it from the connection's authenticated user profile, else the client's display name or id (`storeUpdatedBy`, `<openclaw>/dist/secrets-VYaSXWxr.mjs` lines 40-42). A bot sees it (below).
- **Who can ask.** From a connection holding read, write, approvals and questions but not admin (`secrets-noadmin`), the bot's call failed at once, `"missing scope: operator.questions"`, and no question was raised. The tool registers its question with the admin scope, and the gateway requires "`operator.admin` plus the agent's trusted, live runtime authority" (`<openclaw>/docs/tools/secrets.md` line 125). The masked question exists only in a run started from a connection with admin; the gateway's message names the wrong scope.
- **What a request is.** Protected only: "Requests are protected-secret only" (`secrets.md` line 31); submitting replaces an existing entry's value; skipping or letting it expire tells the bot `no_answer` (`secrets.md`, "Answering a request"). There is no request that uses a value once without storing it.

## 5. The Vault: the shared secret store

- **Methods.** `secrets.store.list`, `secrets.store.set {name, value, kind: "secret" | "env", allowedHosts?}` and `secrets.store.delete {name}`, each `operator.admin` (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 2409-2427; schemas in `<openclaw>/dist/agents-models-skills-D_vYckoD.mjs` lines 405-430). No method reveals a protected value. Changing an entry's hosts is a `set`, which needs the value again. Live, `store`: without admin, list and set were refused, `"missing scope: operator.admin"`.
- **Scope.** "A Gateway-wide, team-scoped place … available to every Gateway process using the same state database" (`<openclaw>/docs/gateway/secrets/secret-store-and-egress.md` line 14). Every entry read back had `scopeKind: "team"`. The table has an `identity` scope too, but "identity-scoped secrets are not supported" (line 152). Nothing in an entry names a bot.
- **Kinds.** `secret` (protected, write-only after saving) and `env` (agent-readable: its value is listed and handed to commands) (lines 18-19).
- **Read back** (live, `store`): `set` answered `{"ok":true,"reloaded":false}`; the listing then showed the entry with its `allowedHosts` and no value. A second `set` with other hosts replaced them (`updatedAtMs` moved). `delete` answered `ok`, and the listing no longer had it. **A second `delete` of the same name also answered `ok`**: the answer does not prove the entry was there, only the listing does.
- **Removal keeps the value.** After a bot deleted an entry (below), its row had `deleted_at_ms` set and the value still in it. "Deleted entries are purged after 30 days" (`secrets.md`, `delete`).
- **What another bot sees, and does** (live, `secrets` and `secrets-delete-by-other`): Marlow's `secrets list` showed the entry Pip had asked for: `D8_EXAMPLE_TOKEN_… | secret | hosts: api.example.com | updated: … | by: <the account's name>`, with no value. Marlow's `secrets delete` answered `{"ok":true,"reloaded":false}` and the entry left the store's listing.
- **Use by bots.** A protected value is used only through a setting that refers to it (a SecretRef) or the egress proxy, which, when `secrets.egressProxy.enabled`, substitutes it in HTTPS requests from commands on the gateway's machine to its allowed hosts (`secrets.md`, "Using a stored credential"; line 14 above). Neither path looks at which bot runs. **Source**; the egress proxy is off on development instances and was not run.
- **Limiting an item to chosen bots.** The gateway has no such setting. What exists: a bot's own deny list can remove `secrets` from what it is offered (`docs/design/controls.md` section 20, row 2), and a plugin's hook can refuse a bot's `secrets` calls (row 5). Both stop that bot listing, asking and deleting through the tool; neither stops it using a value through egress or a setting. A bot that can run commands on the gateway's machine can also read the state database. So "limited to chosen bots" can be claimed of nothing.

## 6. A password manager

- **On the gateway.** The bundled `onepassword` plugin has "a policy-controlled agent tool that reads a curated set of 1Password fields", with a policy per item (`auto`, `approve`, `deny`) and standing grants per bot and item. "The value is model-visible for that execution" (`<openclaw>/docs/plugins/onepassword.md` lines 12-40, 247). **Source**; not run, since no account may be used here.
- **In the app.** Electron's documentation describes no autofill or password-manager fill for an app's own fields: the `session`, `webContents` and `webPreferences` pages say nothing of it. Its extensions page says Electron "supports a subset of the Chrome Extensions API, primarily to support DevTools extensions and Chromium-internal extensions" and "does not support arbitrary Chrome extensions from the store" (electronjs.org/docs/latest/api/extensions). **Source**, from Electron's documentation; not tried. So a manager's browser extension is not expected to reach Clawtrate's field, and nothing documents the system's fill reaching it. Pasting works in any text field. iOS was not researched; the iOS app is not on `main`.
- **An order.** Nothing on the gateway makes a bot try the shared store, then a password manager, then a person. Each bot chooses which tool to call.

## 7. What the app keeps of a secret

- A secret typed into Clawtrate leaves in one request frame: `question.resolve` with the value at `answers.answers.<questionId>[0]` (section 4), or `secrets.store.set` with `value` (section 5).
- The answers to both carried no value back, and neither did any event the client received, `chat.history`, `secrets.store.list` or `question.list`'s resolved record, which keeps `"stored"` (section 4). So a snapshot, a log, a Raw view or a draft built only from what the gateway sends back cannot contain it; what the app itself writes is the design's to forbid.

## 8. What could not be proven here

- A real email or Slack tool, the `message` tool live, and what a real tool's result reports of what it sent: no account may be used. The stand-ins show what a hook and a card can do with any tool's arguments.
- Filling a website's sign-in form without the bot being able to read it: the only proven way to put text into a bot's browser is a person typing during a takeover (`docs/design/work-pane.md` section 18), and the bot can read the page afterwards.
- The egress proxy substituting a stored value: it needs `secrets.egressProxy.enabled` and an outside host, neither allowed on a development instance.
- Whether the system's or a password manager's fill reaches an Electron field: Electron's documentation is silent, and no manager may be opened here.
- Whether a hot install of a plugin registers its hooks before a restart: the first runs here were confounded by the module-state fact in section 1, so this note claims nothing about it. Its gateway was restarted in place with `gateway.restart.request` (admin) between plugin changes.

## 9. The instance afterwards

`d8vault` was reset with `pnpm dev-gateway reset --instance d8vault` once the probes were done, and the research model's process was stopped by its PID; for sections 1a and 1b it was started again the same way, set up as above, and reset again afterwards. Its state folder held only made-up values: the entries `D8_EXAMPLE_TOKEN_…` and `D8_EXAMPLE_STORE_…` with values `example-secret-value-<uuid>`, the stand-ins' made-up addresses at `example.com` and `example.org`, and the file `outbox/report.txt` with two lines of made-up text.

## Files

- [`dev-gateway/drafts-probe-plugin/`](dev-gateway/drafts-probe-plugin/): the research plugin (no dependencies).
- [`dev-gateway/drafts-probe/probe.ts`](dev-gateway/drafts-probe/probe.ts): for section 1b, `edit-file-second`, `scopes`, `store-env` and `edit-abort`; and the scenarios `rewrite`, `rewrite-write`, `hold-allow`, `hold-deny`, `hold-mutate`, `file-hold`, `file-trusted`, `file-trusted-unchanged`, `secrets`, `secrets-noadmin`, `secrets-delete-by-other` and `store`; and, for section 1a, `edit-plain`, `edit-approve`, `edit-deny-first`, `edit-deny-second`, `edit-file`, `edit-restart` and `edit-readonly`.
- [`dev-gateway/fake-openai.mjs`](dev-gateway/fake-openai.mjs): the research scripted model, unchanged.
