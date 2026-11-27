# Clawtrate rules plugin

`clawtrate-tool-rules` is a plugin for an OpenClaw gateway. It decides each tool call a bot makes by rules you set: run it without asking, ask a person first, or never run it, for a whole tool or for what the tool acts on (a path, a command, a tool server's tool).

Clawtrate is an independent open-source project. It is not made by, affiliated with or endorsed by OpenClaw.

> **Status: development gateways only.** This plugin is written from the requirements in Clawtrate's [controls design](../../docs/design/controls.md#clawtrates-rules-plugin-clawtrate-tool-rules-p5), section 21, and its tests cover each of them. It has not yet had a security review of its own. Until it has, install it only on a development gateway, never on a gateway that holds real sign-ins.

> **It holds only while it runs.** A rule here is not a guarantee. When the plugin is not running, the gateway runs the calls it would have asked about or refused, with no card. The gateway's own settings (a bot's deny list, its command policy, its messaging list) hold with or without it, and nothing here can loosen them.

## What it adds

Without the plugin, the gateway can deny a tool outright (`tools.deny`), and asks before a command through its own command policy. It cannot ask before any other tool call, and it has no rules about what a tool acts on.

With the plugin:

- **Ask first** for any tool: the gateway's own approval card, with Allow once and Deny. The answer is for the rule the card showed: if that rule changed while the card waited, Allow once does not run the call unless the rules now would without asking. In a run another bot's message started or reached, an Ask asks no one and refuses the call; while that message waits in its task, so does every run that starts there.
- **Never** for a tool, or only for some of what it acts on: the call is refused with the rule named.
- **Ask when nothing else decides**: every call no rule covers asks, except `ask_user`. An Allow rule keeps it from asking for the calls it covers, and does nothing else.
- **A decision record**: what the plugin decided for each call, metadata only, for 30 days, joinable to the gateway's audit log.

## What it needs

- OpenClaw 2026.10.6 or 2026.11.10 (the versions it is tested against). Plugin interfaces are marked experimental, so pin one of them.
- A gateway state folder it can write to. The plugin keeps its files in `<state folder>/clawtrate-tool-rules/`.
- One optional setting, `cardDetails` (below, "The card"): `"auto"` (the default), `"full"` or `"redacted"`.

## Installing it

1. Install the plugin into the gateway's profile, for example from a checkout of Clawtrate:

   ```bash
   openclaw plugins install --link <checkout>/plugins/clawtrate-tool-rules
   ```

2. Enable it (`plugins.entries.clawtrate-tool-rules.enabled: true`). The gateway reloads plugins when that changes. An installed plugin's trusted tool policy registers only when it is enabled explicitly; its manifest declares the one it registers (`contracts.trustedToolPolicies: ["rules"]`).
3. Deny every bot what it must not have for the rules to mean anything (below).
4. Set rules from a connection with `operator.admin` (`clawtrate-tool-rules.set`).

## For the rules to mean anything

A rule of this plugin holds only against a bot that cannot change the gateway or the plugin's store. Deny each bot:

1. **The `gateway` and `plugins` tools.** The `gateway` tool reads the gateway's settings and can update and restart the gateway, and the `plugins` tool manages plugins, so a bot with either may be able to turn this plugin off, replace it or remove it.
2. **Commands on the gateway's machine outside a sandbox** (`exec` and `process`). A command runs as the gateway's user and can edit the gateway's settings and this plugin's files. Deny both tools to the bot, set its command policy to `deny`, or run its commands on another machine (`tools.exec.host: "node"`) or in a sandbox, with `tools.exec.host` not set to `"gateway"` and elevated exec closed for the bot (below): a sandboxed bot whose host is the gateway's machine runs its commands there.
3. **Writing to the store.** The store is in the gateway's state folder. `tools.fs.workspaceOnly: true` keeps writes inside the bot's workspace, which protects the store only when that workspace does not contain the store's folder (`<state folder>/clawtrate-tool-rules/`). Keep it, with a workspace that does not contain the rules store, or deny `write`, `edit` and `apply_patch`. The plugin warns at start about a bot whose workspace, resolved through any link, contains the store's folder.

**What the plugin checks.** When it starts, it reads the gateway's settings and writes one warning to the gateway's log for each bot and each of the three it cannot rule out, for example `clawtrate-tool-rules: Bot otto may run commands on the gateway's machine outside a sandbox, …, so Clawtrate's rules are advice for it.` The check is conservative and reads the settings as the gateway does:

- a tool counts as denied only when a deny list names it (by name, alias, `*`, a pattern, or the groups `group:openclaw`, `group:automation`, `group:runtime` and `group:fs`), or a non-empty allow list leaves it out. An empty allow list restricts nothing, and an allow list naming `write` also allows `apply_patch`. A tool profile or an unknown group counts as offered;
- commands run off the gateway's machine only on a node (`tools.exec.host: "node"`), or in a sandbox for every task (`sandbox.mode: "all"`) when the bot's host is not set to `"gateway"` and elevated exec cannot take its commands out of the sandbox. A bot sandboxed but with its host set to the gateway's machine is warned about, and so is one for which elevated exec is open: `tools.elevated.enabled` is not `false` for the gateway or the bot (unset counts as on, as the gateway reads it), and a sender can qualify, through a non-empty `tools.elevated.allowFrom.<channel>` list or, with none, a configured channel that could supply its own.

**A warning is a warning, not a protection.** It is written once, when the plugin starts; it blocks nothing, and the plugin runs either way. The settings that protect are the denies above, which the gateway enforces. (The gateway's `security audit` command loads an installed plugin without running it, so the plugin cannot add these as audit findings.)

Also true, whatever is denied:

- A rule about a file tool is a rule about that tool, not about the file. A command, or another tool, can still reach the file where the bot may use it.
- Path rules match workspace names supplied to file tools. Never and Ask also match the spelling forms listed under The rules. Links, hard links and mounts can expose a file under another name, outside those matches.
- A pattern on a command matches the command's text. It is advice against a bot that wants to get round it (`sudo rm`, `env rm`, a script). Never on the whole tool is the guarantee, and that belongs in the bot's own deny list, which the gateway enforces.

## The rules

Rules are kept per **scope**: `*` for every bot, or one bot's id. Each scope holds:

```json5
{
  version: 3, // counts this scope's saves; compare-and-set on it
  fallback: false, // "Ask when nothing else decides"
  rules: [
    {
      id: "3f2a9c1b0d4e", // given by the plugin
      version: 1, // counts this rule's own changes
      action: "never", // "allow" | "ask" | "never"
      tools: ["write", "edit", "apply_patch"],
      target: { kind: "path", pattern: "secrets/**" }, // optional
      note: "Keep keys away", // optional; the person's own words, never evaluated
      setAt: 1795060183361,
      setBy: "sha256:…", // a hash of the saving device's id, or null
    },
  ],
}
```

- **Tools** are the gateway's canonical tool names (lower case; `bash` is `exec`, `apply-patch` is `apply_patch`, `cron` is `automations`), or a tool server's tools as `<server>__<pattern>` (`coder__*`, `coder__deploy_*`). `ask_user` can never be named: a question already asks the person.
- **A target** names what the call acts on, only for tools whose parameter the plugin can read and validate:
  - `path`, for `read`, `write`, `edit`, `ls` and `apply_patch`: a path in the bot's workspace. `*` matches within a name, `**` (a whole name) across names, none included, so `secrets/**` matches `secrets` and everything under it. No `..`, `~`, `\`, `:` or leading `/`.
  - **Spellings.** After path parsing, a Never or Ask compares names by lowercasing, folding Unicode spaces including the narrow space before AM or PM, folding straight and curly apostrophes, and comparing composed and decomposed accents. An Allow uses the parsed workspace path without those additional folds. Never and Ask are evaluated first.
  - `command`, for `exec` and `process`: one line; `*` matches the rest of a word or of the line (`rm *`, `git push*`). The command must match whole.
- **A call whose parameter cannot be read acts on everything**: a Never or an Ask with a target applies to it, an Allow with a target does not cover it. The plugin cannot read:
  - a file tool's path that is missing, not text, given twice (`path` and `file_path`), longer than 4,096 characters, with a control character, a backslash or a colon, starting with `~` or `@`, with `..`, absolute outside the bot's workspace, or with an extension the gateway repairs before the tool runs;
  - every `apply_patch` call (the gateway only hints at its paths) and every `process` call (it carries no command);
  - a command with anything the shell would expand, chain or redirect (`;`, `&`, `|`, `$`, backquotes, `<`, `>`, globs, `~`, `#`, `\`, parentheses), an unterminated quote, a double-quoted `$`, `` ` ``, `\` or `!`, more than one line, or a first word that sets a variable (`FOO=1 rm x`). Quotes are removed and blanks run together before matching, so `'rm' -rf x` is `rm -rf x`.

**The order**, the same as the design's (section 3):

1. a matching **Never**, the bot's own rules first, then every bot's: the call is blocked with the rule named;
2. a matching **Ask**, in the same order: the gateway's card;
3. **Ask when nothing else decides**, on for the bot or for every bot: a matching Allow rule (either scope) lets the call through; otherwise the card;
4. otherwise the plugin decides nothing.

An Allow never passes an Ask or a Never, wherever either is set. `ask_user` is never asked about or blocked. The plugin never changes a call's parameters. The gateway's own checks are around it: a tool the gateway denied never reaches the plugin, and a command the plugin lets through still meets the bot's command policy and the machine's approvals file.

**Limits** (Clawtrate's choices), per scope: 20 Allow rules, 20 Ask rules and 50 Never rules; a pattern of at most 1,000 characters; a note of at most 1,000; at most 16 tools per rule; rules for at most 64 bots, and at most 1,000 scopes kept at all, emptied ones included. The whole store is at most 8 MiB (8,388,608 bytes) as written, the most the plugin reads back: a save that would pass it is refused with `store_too_large`, so every store saved can be read again. A save past any limit is refused whole and saves nothing. Nothing is ever removed by itself.

## What a device can do with it

| Method                                | Scope            | Parameters                                                                                                                                                              | Answer                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawtrate-tool-rules.status`         | `operator.read`  | none                                                                                                                                                                    | `{plugin, version, rulesSchema, rules, enforcing, hook: {registered, lastCallAt}, matches: {tools, fallback, exempt} \| null, cardDetails: {mode, because}, decisions: {state, reason?, setAside}}`                                                                        |
| `clawtrate-tool-rules.get`            | `operator.read`  | `scope?`                                                                                                                                                                | `{rulesSchema, scopes: {<scope>: {version, fallback, rules}}, limits}`                                                                                                                                                                                                     |
| `clawtrate-tool-rules.decisions.list` | `operator.read`  | `agentId?, sessionKey?, runId?` (each at most 512 characters), `before?` (a time in ms, exclusive), `cursor?` (a page's `nextCursor`), `limit?` (1 to 500, default 100) | `{records, hasMore, nextCursor?, retention: {days: 30, maxRecords: 50000}}`, newest first. Ask for the next page with `cursor: nextCursor`, which goes on after the last record listed, so records of the same millisecond are not skipped; `before` is a time filter only |
| `clawtrate-tool-rules.set`            | `operator.admin` | `scope, rules, fallback, expectedVersion`                                                                                                                               | the scope as saved: `{scope, version, fallback, rules}`                                                                                                                                                                                                                    |

The gateway enforces each scope when it admits the call: below admin, `set` is refused with `FORBIDDEN` and `details.missingScope: "operator.admin"`, before the plugin sees it.

**`set`** replaces a scope's rules and its fallback. `expectedVersion` is the scope's `version` as read (0 for a scope never saved); any other number is refused. A rule given with its `id` keeps its version unless what it says changed; one without an `id` is new, version 1. A scope's version never repeats: a scope emptied (no rules, the fallback off) is kept with its version, and `get` lists it, so a save based on a read from before the clear is refused, also after the scope is recreated. A version never passes the largest safe integer; a save that would is refused.

**`status`** says only what the plugin itself knows:

- `version` (`1.0.0`) and `rulesSchema` (`1`);
- `rules`, the three states of the rules file, never confused (below, "The store"): `{state: "none"}` (no file: nothing was ever saved), `{state: "read", readAt}` (read and checked, at that time), or `{state: "lost", reason, keptCopyReadAt}` (a file that cannot be used; `keptCopyReadAt` is when the copy still enforced was read, or `null` when there is none);
- `enforcing`, what the plugin applies to the next tool call: `"rules"`, `"kept-copy"`, `"ask-every-call"` (lost with no copy), `"nothing"` (no rules file) or `"not-enforced"` (its hook is not registered, or its service is not running). This is the field that says whether rules are being enforced;
- `hook.registered`: a registration of this plugin that had the gateway's trusted policies or its hook interface registered the decision, and its service is running. That is what the plugin can verify, not proof that the gateway calls it. `hook.lastCallAt` is when the decision last saw a tool call in this gateway process (`null` until it has); it says nothing about the rules. `hook.decidedBy` says what decided that call: `"policy"` (the trusted policy, whose cards' answers are looked at again) or `"hook"` (the ordinary hook, where the gateway did not run the policy: it has no trusted policies, or did not take this one; for a plugin not explicitly enabled both versions log a diagnostic, yet still ran the policy on a development gateway, so `decidedBy` said `policy`), or `null` before any call;
- `matches`, what the enforced rules match (`tools` by entry, `fallback`: the scopes that ask for every tool, `exempt: ["ask_user"]`), or `null` while every call is asked about;
- `cardDetails`, whether a card names what the call acts on (below, "The card");
- `decisions`, `{state: "kept", setAside}` or `{state: "failing", reason, setAside}` when the decision record could not be read or written. `setAside` is kept apart from that state: the records set aside as oversized that are still in the folder, oldest first, each `{file, setAsideAt}` (below, "The decision record"), or `null` when the folder cannot be read. `setAsideAt` is `null` for a file an earlier version set aside whose time cannot be read. A page that lists decisions can say from it that older decisions were set aside, and when.

**Refusals** carry one of the gateway's codes and a `details.reason`:

| Code              | `details.reason`                          | When                                                                                                           |
| ----------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `UNAVAILABLE`     | `rules_unavailable`                       | the rules are lost (`get`, `set`); the message starts "Rules unavailable:" and says what is enforced meanwhile |
| `UNAVAILABLE`     | `store_not_written`                       | the new rules could not be written; nothing changed                                                            |
| `INVALID_REQUEST` | `version_conflict`                        | `expectedVersion` is not the scope's version; `details.currentVersion` is                                      |
| `INVALID_REQUEST` | `store_too_large`                         | the whole store would pass 8 MiB; `details` has `limit` and `size`                                             |
| `INVALID_REQUEST` | `limit`                                   | past a limit; `details` has `action`, `limit` and `count`, or `limit` and `length` for a pattern               |
| `INVALID_REQUEST` | `bad_rule`, `unknown_rule`, `exempt_tool` | a rule that is not one, an `id` the scope does not have, a rule naming `ask_user`                              |
| `INVALID_REQUEST` | `bad_scope`, `bad_request`                | a scope that is not `*` or a bot's id; a malformed `fallback`, `expectedVersion` or filter                     |

**The event**, `plugin.clawtrate-tool-rules.changed`, on the read tier, with an empty payload, after every save and whenever the plugin sees that the rules file changed on disk: at the next tool call or method call, or within the hour on an idle gateway (its timer looks). Fetch again on receipt; nothing about a rule or a bot is in it.

## The card

An Ask is the gateway's own plugin approval: `plugin.approval.requested`, answered with `plugin.approval.resolve`. The plugin asks with:

- a title of at most 80 characters, `"<tool>: Clawtrate's rules plugin asks first"` (while the rules are lost with no copy, `"<tool>: Clawtrate's rules could not be read"`);
- a description of at most 512 characters naming the rule and, unless it is redacted, the target: `Asked by Clawtrate's rules plugin: otto's rule 'Ask first · notes/**', version 1 (rule 3f2a9c1b0d4e). The call: write on notes/disk-2026-11-18.md.`, or for the fallback `Asked by Clawtrate's rules plugin: "Ask when nothing else decides" is on for otto. …`;
- `severity: "warning"`, `timeoutMs: 600000` (the gateway keeps a plugin's wait to 10 minutes at most);
- `allowedDecisions: ["allow-once", "deny"]`, always. The gateway gives the plugin the decision alone, not which approval it answered or who answered, so nothing trusted could tell the plugin who may make a standing permission. The card never offers Always allow, and an answer never saves anything. A standing permission is an Allow rule, saved with `set` by admin.

**Who can receive a card, and what it says.** The gateway sends a card to the device whose message started the run and to admin connections (seen live, below). It can also send it further, where the gateway's owner configured that: plugin approval forwarding (`approvals.plugin.enabled`, to the originating chat or to configured targets), a channel's own reviewers for plugin approvals (`approvals.plugin.<channel>`), and a chat channel's native approvals for a run that started there. What it sends further is the plugin's title and description, the tool's name and, added by the gateway itself, the bot's id. So the plugin decides what its description carries, with the setting `cardDetails`:

| `cardDetails`      | When the gateway's config has                                                 | The description                                                                                                                                                                                       | `status.cardDetails`                                   |
| ------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `"auto"` (default) | no `approvals.plugin.enabled`, no `approvals.plugin.<channel>`, no `channels` | full: the rule by its scope, words and pattern, and the path or command                                                                                                                               | `{mode: "full", because: "no-forwarding"}`             |
| `"auto"` (default) | any of them                                                                   | redacted: the tool and the rule by id, version and action (`a rule for this bot (rule 3f2a9c1b0d4e, version 1, Ask first)`), and `The details are in Clawtrate.`; no path, command, pattern or bot id | `{mode: "redacted", because: "forwarding-configured"}` |
| `"full"`           | anything                                                                      | full                                                                                                                                                                                                  | `{mode: "full", because: "setting"}`                   |
| `"redacted"`       | anything                                                                      | redacted                                                                                                                                                                                              | `{mode: "redacted", because: "setting"}`               |

The plugin reads the gateway's current config for each card. A redacted card still carries the tool's name, and a forwarded one the bot's id, which the gateway adds and the plugin cannot remove. A full card can reach a forwarding destination only with `cardDetails: "full"`. A refused call's result identifies the matching rule. The gateway controls access to that result and to the original call arguments.

What the gateway does with it (OpenClaw 2026.10.6 and 2026.11.10, seen on a development gateway):

- The card reaches the device whose message started the run, and admin connections. Another device with `operator.approvals`, and a read-only device, do not receive it or list it.
- Allow once authorizes only the pending call. OpenClaw can still cancel that call after accepting the answer, including when approvals overlap. Check the call result to see whether it ran. An identical later call asks again. Deny refuses it with "Denied by user. The tool call did not run."
- **A routine's run** has no one to ask: the gateway raises no card and refuses the call at once (the plugin's record shows the ask answered `cancelled`; the audit log counts the call `failed`). The routine's own summary can still say the work was done.
- **A run another bot's message started or reached** asks no one: the plugin refuses an Ask there before any card, with "Refused by Clawtrate's rules plugin without asking anyone: …, and this run was started by a message from bot marlow. …", and the record shows `cancelled`. It does so on every version: 2026.10.6 could not raise the card for such a run, and 2026.11.10 would send it to admin connections, where someone could approve what a bot asked for without being told a bot asked. The plugin knows who started a run from the gateway's mark on the task's message (below).
- **A change while a card waits.** The card stays listed. After a change to this plugin's rules, Allow once runs the call only if the rule the card showed still asks at the same version, or the rules now let the call run without asking; otherwise the call is refused with "Refused by Clawtrate's rules plugin: the rules changed while the card waited, and … now says Never." (or names the rule that asks now). A change to the gateway's settings that denies the tool to this bot (its own `tools.deny` or the gateway's, by name, `*`, a pattern or a group the plugin knows) refuses the call too: "Refused by Clawtrate's rules plugin: the gateway's settings now deny write to this bot, a change made while the card waited. …". Any other change to the gateway's settings leaves the answer standing. That is where the versions differ: 2026.11.10 runs the call, and 2026.10.6 fails it itself with "Plugin approval required (gateway unavailable)" after any config change (a bot's deny list, another bot's, and the plugin's own `cardDetails` were tried). The plugin reads explicit deny lists only, not tool profiles or allow lists. 2026.11.10 holds a change to the plugin's own settings back until the card is answered.
- **The plugin turned off during a run**: that run's later calls are refused with no card (on 2026.10.6 by the plugin, which the gateway still runs for that run; on 2026.11.10 by the gateway, whose call to a turned-off plugin's policy fails: "blocked by rules: policy evaluation failed"). The plugin's note of the run's messages fails there too, which the gateway logs and passes over, writing the message. A run that starts afterwards is not ruled. Removing the plugin from the gateway's settings (its entry and its load path) is not read as turning it off: on 2026.10.6 a run already under way goes on being ruled, and asked about, until it ends.

**Who started a run, and which runs a bot's message reaches.** The gateway marks a task's user message that another task sent (`provenance: {kind: "inter_session", sourceSessionKey}`), names the run the message is to start (`idempotencyKey: "<run id>:user"`), and shows both to plugins before writing it (`before_message_write`). When a bot's `sessions_send` returns, its result says where the gateway put the message (`after_tool_call`: `status`, `runId`, `sessionKey`, `targetDisposition`). The plugin reads only those and the message's role, never a message's text, and keeps the sending bot's id and that run id. A message that waits behind a busy run is written when it is queued, and one steered into the busy run when the run takes it in; the plugin cannot tell the two apart when they are written. So a bot's message in a task:

- makes the run under way there the bot's from then on;
- waits until the run it names starts (noted at that run's first model call, `model_call_started`), which is the bot's;
- meanwhile makes every other run that starts in that task the bot's too, whoever's message started it (with two bots' messages waiting, the first one's);
- is let go only when its own run starts, or when the sending bot's `sessions_send` result says the gateway steered it into the run under way or the recipient has answered. On 2026.10.6 a steer's result comes before the run takes the message in and it is written; the plugin keeps that result (at most 1,000) until the message is, and the message then waits for nothing. If a person's message was written in that task after its latest run was noted, the steer may have gone into the person's run not noted yet, so the next run noted is the bot's too.

**What this costs a person.** While another bot's message waits in a task, or has steered into the run under way there, a person's own run in that task loses its cards: an Ask is refused, naming the bot, until the bot's message has started its own run or the gateway has said where it went. That covers the person's run that was busy when the bot's message came, and a person's message queued before the bot's that the gateway runs first (2026.11.10 does; 2026.10.6 ran the bot's first in the runs seen). It is the stricter meaning: a person is never asked to approve a call in a run a bot's message reached without being told a bot wants it. A bot's message that nothing lets go (its run never starts and its send's result is never seen, for example one the gateway folds into another queued run) keeps every run in that task the bot's until it is pushed out of the plugin's memory (below), and then for one more run, or until the gateway restarts. The plugin does not use `agent_end`, which says when a run ends: both versions hold that hook back from a plugin not granted conversation access (`plugins.entries.<id>.hooks.allowConversationAccess`), and this plugin asks for none. None of the hooks it uses needs it.

A message from this bot's own task (a subagent reporting back) counts as whoever that task's run stands for, so a person's own hand-off still asks and one another bot started stays that bot's; a task of its own the plugin knows nothing of counts as a bot's. The id is named only when it has a bot id's form; otherwise the reason says "another bot". It keeps at most 1,000 tasks, 1,000 runs, 1,000 tasks with bots' messages waiting and 16 waiting messages per task; past a limit a person's entry is let go first, and a bot's mark that must go (a run's, or a waiting message's with its task and the run it names) is kept among at most 1,000 forgotten ones and still counts as a bot's: a forgotten run stays the bot's, and a forgotten task's next run is. After a gateway restart, a run whose message the plugin did not see is taken as a person's.

## The store

The rules are in `<state folder>/clawtrate-tool-rules/rules.json`, the plugin's own file, mode `0600` in a `0700` folder:

- **Written atomically**: a temporary file in the same folder, flushed, renamed over the old one, and the folder flushed. A reader sees the old rules or the new ones, never part of either.
- **Versioned** per scope, for compare-and-set (`set`'s `expectedVersion`), and per rule, so a decision names a rule as it was.
- **Bounded** by the limits above, checked again whenever the file is read.
- **Written whole or not at all**: every byte is written and flushed before the rename; a write that falls short fails before it, and the old file and the rules in memory stay as they were.
- **Never larger than it reads**: a save is checked against the 8 MiB the plugin reads before anything changes on disk or in memory.
- The plugin checks the file's size, times and inode before reading it. Use `set` to change a running gateway's policy. To repair the file, stop the gateway, replace it with a complete valid store, and restart. Concurrent external edits are outside the store's consistency guarantee.
- **In one of three states**, which the plugin never confuses:
  - **No rules file**: nothing was ever saved. Nothing is decided.
  - **Rules read**: enforced.
  - **Rules lost**: a file is there and cannot be used (unreadable, larger than 8 MiB, not JSON, another format, a newer schema, an envelope that is not valid, a rule past a limit), or a file read earlier in this process is gone. A lost policy is never treated as an empty one. If this gateway process read good rules earlier, the plugin goes on enforcing that copy. If it never did, it asks before every tool call it sees other than `ask_user`, with a card saying Clawtrate's rules could not be read, so nothing a person forbade runs unasked. It never passes calls silently in this state. While the rules are lost and no earlier copy is held, a person can allow once a call that a lost Never would have refused; the card says the rules could not be read. While the policy is lost, `get` and `set` refuse the request. Restore a valid store to resume normal operation. Use a valid empty store only when you intend to clear the policy.
- **Each change of state is logged** when the plugin sees it (a warning when the rules are lost, saying what is enforced meanwhile; a line when they are read again), and the invalidation event is sent.
- **Not editable by a bot** only as far as the bot is denied the three things above. The plugin does not hide or sign the file.

## The decision record

`<state folder>/clawtrate-tool-rules/decisions.jsonl` holds, for each tool call the hook saw:

`{id, at, agentId, sessionKey, runId, callId, tool, rules, decision, source, answer, answeredAt}`

- `callId` is the call's id hashed as the gateway's audit log hashes it (`sha256:` and the hex digest of the id), so a record and the audit log's `tool.action.*` records join by `runId` and `toolCallId`.
- `rules` is the rules' state when the call was decided: `none`, `read`, `kept` (a kept copy) or `lost` (no copy: asked about). `ask_user` records `rules: null` because it is exempt before the plugin reads the rules.
- `decision` is `block`, `ask`, `allow` (an Allow rule kept "Ask when nothing else decides" from asking) or `none`. A call answered Allow once after its rule changed gets a second record, `block`, naming what the rules said when the answer came.
- `source` is `{kind: "rule", scope, ruleId, version, action}` (the rule as it was at that moment), `{kind: "fallback", scope}`, `{kind: "rules-lost"}`, `{kind: "turned-off"}` (a call of a run under way when the plugin was turned off), `{kind: "gateway-deny"}` (a call answered Allow once whose tool the gateway's settings came to deny while the card waited), or `null`.
- `answer` is the decision word the gateway gave the plugin for an ask (`allow-once`, `deny`, `timeout`, `cancelled`), with its time.

The decision record keeps metadata only. Rules can contain saved patterns and notes. OpenClaw 2026.10.6 can log tool arguments after a denied or failed call, and its ordinary task events and transcripts can carry arguments and results. The plugin does not control those gateway records. Records are kept for 30 days and at most 50,000, the oldest dropped first. A record past 30 days is removed from the file when the plugin starts and by a timer of its own every hour, also on an idle gateway (the timer does not keep the gateway's process running), so the file holds none older than 30 days and an hour while the gateway runs and its rewrites succeed. A stopped gateway removes nothing until it starts again, and a rewrite that fails leaves expired records on disk until a later one succeeds; `status.decisions` says `failing` meanwhile. Past the 50,000, the oldest leave memory at once and the file at its next compaction, which happens when it holds a fifth more lines than records, never once per call. A file larger than 64 MiB is not read at start: it is set aside beside it, unread, and a new record begun. Its new name is `decisions.jsonl.oversize-<when>-<random>`, where `<when>` is the time it was set aside in milliseconds, so a later one never replaces an earlier one. `status.decisions.setAside` names each set-aside file still there, with when it was set aside, through later writes and restarts. A set-aside file is removed thirty days after the time in its name, by the same pruning; the file's own times play no part. One an earlier version of the plugin set aside as `decisions.jsonl.oversize` is named and removed the same way, counting from its last modification. Delete a set-aside file by hand whenever you like, as nothing reads it; `status` stops naming it at once. A record that cannot be read at start (other than missing) is read again before anything is written to it: until it is, nothing is appended or rewritten, what the plugin decides meanwhile is kept in memory and written with the file's records once it can be read, and `status.decisions` says `failing`. A last line left torn by a write that did not finish is cut at start, so the next record starts a line of its own; if it cannot be cut, nothing is appended after it. A record that could not be written stays in memory, and the whole retained record is written again once a write succeeds; until then `status.decisions` says `failing`. Decisions are appended without being synced to disk, so the last lines may not survive a crash, and records waiting in memory to be written stay subject to the 30 days and the 50,000 cap. The plugin is the record's only writer: it appends to, repairs or replaces only the version of the file it last read or wrote, and a file changed from outside is read and merged with what it holds before anything is written; writes from outside at the same time as its own are not supported, as the check comes before the rename and a rename cannot compare and swap. `decisions.list` is on the read tier, so every read connection can read every bot's records; the event carries none of it.

## What it guarantees, and what it cannot

While it runs, for every agent tool call that reaches the gateway's trusted tool policies and `before_tool_call` hooks, with the rules read (or, while they are lost, the copy read earlier; with no copy, every call but `ask_user` is asked about):

- a matching Never blocks the call, naming the rule, its version and its id in the call's result (`details.status: "blocked"`);
- A matching Ask or fallback requests the gateway's approval. Where the gateway can reach an eligible reviewer, the card offers only Allow once and Deny. With no eligible reviewer or if approval authority changes, OpenClaw can refuse the call.
- Allow once runs the call only while the rule its card showed still asks at the same version, or the rules would now run the call without asking;
- in a run another bot's message started or reached, and in a run that starts in a task where a bot's message waits, an Ask refuses the call and no one is asked;
- an Allow never passes an Ask or a Never;
- `ask_user` is never asked about or blocked;
- the call's parameters are never changed;
- the decision is recorded as above.

**What stays open.**

1. **When the plugin is not running**, nothing here holds: the gateway runs the calls the plugin would have asked about or refused, with no card. With the plugin turned off in its config, a run that starts afterwards runs its calls with no card. A run already going when it was turned off makes no more calls (above). To hold a tool without the plugin, deny it in the bot's own settings.
2. **What never reaches the hook**: what an operator does through the gateway's own methods, and what other plugins' code does.
3. **Other plugins.** The decision is an installed plugin's trusted policy: the gateway runs bundled plugins' trusted policies first, then installed plugins' in the order they load, then ordinary hooks. A policy that runs before this one and blocks ends the decision, and the first to ask is the one whose card is shown. A later policy or hook can still block after this one asked, and a hook can ask again after its answer, except where a native tool relay defers its approval: there no ordinary hook of any plugin runs for a call this plugin asks about, before or after the answer.
4. **What a pattern cannot see**: a file reached by a command or another tool, a link, a command run through a wrapper or a script (above).
5. **A routine, or a run another bot's message started**: an Ask there is a refusal, not a question (above). Who started a run is what the gateway marked on the task's messages that the plugin saw; a run it has no note of is taken as a person's, and a person's run in a task a bot's message waits in or has steered into is refused as the bot's (above). Where the gateway asks at the moment a tool runs rather than before (a native tool relay that defers its approval), the plugin does not see the answer before the call, and a rule changed while that card waited is not looked at again.
6. **The plugin's own errors**: the gateway fails a tool call closed when a policy or hook throws or takes longer than 15 seconds. The decision waits on nothing, but its work is synchronous: on each call it looks at the rules file's size and times, reads the file again only when they changed, and appends one line to the decision record.

## Removing it

1. Remove `clawtrate-tool-rules` from `plugins.entries`, and its folder from `plugins.load.paths` (or run `openclaw plugins uninstall clawtrate-tool-rules`). From then on its rules do not hold.
2. Optionally delete `<state folder>/clawtrate-tool-rules/`, which holds the rules and the decision record.
3. Restore the tool policy you want in the gateway's own settings.

## On a Clawtrate development gateway

The development gateway of this repository loads the plugin on a named instance, never the default one:

```bash
pnpm dev-gateway start --instance <name> --with-plugin clawtrate-tool-rules
pnpm dev-gateway reset --instance <name>     # when you are done
```

Its [`clawtrate-dev-contract.json`](clawtrate-dev-contract.json) declares no setting and no tool, so the instance's config gains only the plugin's entry and load path, inside the closed config contract; every bot keeps the development config's denies (`gateway`, `plugins` and the rest), and only Otto can run commands, on the gateway's machine, so the plugin's log warns about Otto alone.

`pnpm scenarios` runs the rules checks on an instance of their own (`tools/dev-gateway/src/rules-checks.ts`), with an admin connection, Clawtrate's interactive tier, another device with approvals, one with read and write, and a read-only one: rules lost with no copy read, where every call but `ask_user` gets the "could not be read" card and `status` says `ask-every-call`; rules lost after a copy was read, where the copy still blocks and `status` says when it was read; `status`, `get` and `decisions.list` answer at the read tier and `set` only for admin, with an empty event for every reader; an Ask's card reaches only the run's device and admin, with Allow once and Deny and a 10-minute wait, and Allow once runs the call once while the next identical call asks again; Deny refuses; a Never blocks with the rule named and no card; an Allow does not pass an Ask; "Ask when nothing else decides" asks, an Allow keeps it from asking, and `ask_user` is never asked; a save past each limit is refused and saves nothing; a Never caught by another spelling of the file's name, and an Allow of another spelling that does not keep the fallback from asking; with approval forwarding turned on with no destination, a card with no path, command or bot, and `cardDetails: "full"` bringing them back; a routine's call is refused with no card; a rule changed while a card waits (to Allow it runs; to Never or another Ask it does not); a gateway setting changed while a card waits (a new deny of the tool for this bot refuses Allow once; a deny of another tool leaves it standing where the gateway does); the plugin turned off in the middle of a run, whose next call is refused with no card; a call in a run another bot's message started (`#message-read`), refused with no card and Marlow named; Marlow's message waiting behind a person's busy run with a person's message steered in after it, where neither run asks anyone; a person's messages queued around Marlow's ("Queue after this turn"), where the busy run, Marlow's run and a person's run the gateway starts before Marlow's ask no one while the person's run after it asks; Marlow's message steered into a person's run (`#message-steer-read`), which then asks no one, while the person's next run asks; two of Marlow's messages waiting, whose runs ask no one while the person's run after them asks; a task a person's run handed off (`#hand-off-read`), whose read is asked about, not refused as a bot's; and the log's warnings. The checks run on OpenClaw 2026.10.6 and 2026.11.10 and say beside each expectation where the two differ. Each decision record checked is joined to its audit record.

The plugin's own tests run with `pnpm test` (`plugins/clawtrate-tool-rules/test`).
