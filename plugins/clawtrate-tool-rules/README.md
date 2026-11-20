# Clawtrate rules plugin

`clawtrate-tool-rules` is a plugin for an OpenClaw gateway. It decides each tool call a bot makes by rules you set: run it without asking, ask a person first, or never run it, for a whole tool or for what the tool acts on (a path, a command, a tool server's tool).

Clawtrate is an independent open-source project. It is not made by, affiliated with or endorsed by OpenClaw.

> **Status: development gateways only.** This plugin is written from the requirements in Clawtrate's [controls design](../../docs/design/controls.md#clawtrates-rules-plugin-clawtrate-tool-rules-p5), section 21, and its tests cover each of them. It has not yet had a security review of its own. Until it has, install it only on a development gateway, never on a gateway that holds real sign-ins.

> **It holds only while it runs.** A rule here is not a guarantee. When the plugin is not running, the gateway runs the calls it would have asked about or refused, with no card. The gateway's own settings (a bot's deny list, its command policy, its messaging list) hold with or without it, and nothing here can loosen them.

## What it adds

Without the plugin, the gateway can deny a tool outright (`tools.deny`), and asks before a command through its own command policy. It cannot ask before any other tool call, and it has no rules about what a tool acts on.

With the plugin:

- **Ask first** for any tool: the gateway's own approval card, with Allow once and Deny.
- **Never** for a tool, or only for some of what it acts on: the call is refused with the rule named.
- **Ask when nothing else decides**: every call no rule covers asks, except `ask_user`. An Allow rule keeps it from asking for the calls it covers, and does nothing else.
- **A decision record**: what the plugin decided for each call, metadata only, for 30 days, joinable to the gateway's audit log.

## What it needs

- OpenClaw 2026.10.6 (the version it is tested against). Plugin interfaces are marked experimental, so pin that version.
- A gateway state folder it can write to. The plugin keeps its files in `<state folder>/clawtrate-tool-rules/`.
- One optional setting, `cardDetails` (below, "The card"): `"auto"` (the default), `"full"` or `"redacted"`.

## Installing it

1. Install the plugin into the gateway's profile, for example from a checkout of Clawtrate:

   ```bash
   openclaw plugins install --link <checkout>/plugins/clawtrate-tool-rules
   ```

2. Enable it (`plugins.entries.clawtrate-tool-rules.enabled: true`). The gateway reloads plugins when that changes.
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
| `clawtrate-tool-rules.status`         | `operator.read`  | none                                                                                                                                                                    | `{plugin, version, rulesSchema, rules, enforcing, hook: {registered, lastCallAt}, matches: {tools, fallback, exempt} \| null, cardDetails: {mode, because}, decisions: {state, reason?}}`                                                                                  |
| `clawtrate-tool-rules.get`            | `operator.read`  | `scope?`                                                                                                                                                                | `{rulesSchema, scopes: {<scope>: {version, fallback, rules}}, limits}`                                                                                                                                                                                                     |
| `clawtrate-tool-rules.decisions.list` | `operator.read`  | `agentId?, sessionKey?, runId?` (each at most 512 characters), `before?` (a time in ms, exclusive), `cursor?` (a page's `nextCursor`), `limit?` (1 to 500, default 100) | `{records, hasMore, nextCursor?, retention: {days: 30, maxRecords: 50000}}`, newest first. Ask for the next page with `cursor: nextCursor`, which goes on after the last record listed, so records of the same millisecond are not skipped; `before` is a time filter only |
| `clawtrate-tool-rules.set`            | `operator.admin` | `scope, rules, fallback, expectedVersion`                                                                                                                               | the scope as saved: `{scope, version, fallback, rules}`                                                                                                                                                                                                                    |

The gateway enforces each scope when it admits the call: below admin, `set` is refused with `FORBIDDEN` and `details.missingScope: "operator.admin"`, before the plugin sees it.

**`set`** replaces a scope's rules and its fallback. `expectedVersion` is the scope's `version` as read (0 for a scope never saved); any other number is refused. A rule given with its `id` keeps its version unless what it says changed; one without an `id` is new, version 1. A scope's version never repeats: a scope emptied (no rules, the fallback off) is kept with its version, and `get` lists it, so a save based on a read from before the clear is refused, also after the scope is recreated. A version never passes the largest safe integer; a save that would is refused.

**`status`** says only what the plugin itself knows:

- `version` (`1.0.0`) and `rulesSchema` (`1`);
- `rules`, the three states of the rules file, never confused (below, "The store"): `{state: "none"}` (no file: nothing was ever saved), `{state: "read", readAt}` (read and checked, at that time), or `{state: "lost", reason, keptCopyReadAt}` (a file that cannot be used; `keptCopyReadAt` is when the copy still enforced was read, or `null` when there is none);
- `enforcing`, what the plugin applies to the next tool call: `"rules"`, `"kept-copy"`, `"ask-every-call"` (lost with no copy), `"nothing"` (no rules file) or `"not-enforced"` (its hook is not registered, or its service is not running). This is the field that says whether rules are being enforced;
- `hook.registered`: a registration of this plugin that had the gateway's hook interface registered the hook, and its service is running. That is what the plugin can verify, not proof that the gateway calls it. `hook.lastCallAt` is when the hook last saw a tool call in this gateway process (`null` until it has); it says nothing about the rules;
- `matches`, what the enforced rules match (`tools` by entry, `fallback`: the scopes that ask for every tool, `exempt: ["ask_user"]`), or `null` while every call is asked about;
- `cardDetails`, whether a card names what the call acts on (below, "The card");
- `decisions`, `{state: "kept"}` or `{state: "failing", reason}` when the decision record could not be read or written.

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

What the gateway does with it (OpenClaw 2026.10.6, seen on a development gateway):

- The card reaches the device whose message started the run, and admin connections. Another device with `operator.approvals`, and a read-only device, do not receive it or list it.
- Allow once authorizes only the pending call. OpenClaw can still cancel that call after accepting the answer, including when approvals overlap. Check the call result to see whether it ran. An identical later call asks again. Deny refuses it with "Denied by user. The tool call did not run."
- **A routine's run** has no one to ask: the gateway raises no card and refuses the call at once (the plugin's record shows the ask answered `cancelled`; the audit log counts the call `failed`). The routine's own summary can still say the work was done.
- **A run started by another bot's message** has no one to ask either: no card reaches any device, the call is refused with "Plugin approval required (gateway unavailable)", and the record shows `cancelled`.
- **A change while a card waits**: after a change to this plugin's rules, the card stays and Allow once runs the call. After a change to the gateway's settings (a bot's deny list was tried), the card stays listed, an answer is acknowledged, and the call fails with "Plugin approval required (gateway unavailable)".

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
- `decision` is `block`, `ask`, `allow` (an Allow rule kept "Ask when nothing else decides" from asking) or `none`.
- `source` is `{kind: "rule", scope, ruleId, version, action}` (the rule as it was at that moment), `{kind: "fallback", scope}`, `{kind: "rules-lost"}`, or `null`.
- `answer` is the decision word the gateway gave the plugin for an ask (`allow-once`, `deny`, `timeout`, `cancelled`), with its time.

The decision record keeps metadata only. Rules can contain saved patterns and notes. OpenClaw 2026.10.6 can log tool arguments after a denied or failed call, and its ordinary task events and transcripts can carry arguments and results. The plugin does not control those gateway records. Records are kept for 30 days and at most 50,000, the oldest dropped first. A record past 30 days is removed from the file when the plugin starts and by a timer of its own every hour, also on an idle gateway (the timer does not keep the gateway's process running), so the file holds none older than 30 days and an hour while the gateway runs and its rewrites succeed. A stopped gateway removes nothing until it starts again, and a rewrite that fails leaves expired records on disk until a later one succeeds; `status.decisions` says `failing` meanwhile. Past the 50,000, the oldest leave memory at once and the file at its next compaction, which happens when it holds a fifth more lines than records, never once per call. A file larger than 64 MiB is not read at start: it is set aside as `decisions.jsonl.oversize` beside it, unread, and a new record begun, and `status.decisions` says so. That notice lasts only until the next successful write, which can be the one that begins the new record. The set-aside file is removed thirty days after it was set aside, by the same pruning, when that time could be recorded on the file. When it could not, the plugin keeps the time in memory and tries to record it again at each pruning, and the file stays until that succeeds; after a restart the time is gone, and removal counts from the file's own last write, which can be sooner. Delete the file by hand whenever you like, as nothing reads it. A record that cannot be read at start (other than missing) is read again before anything is written to it: until it is, nothing is appended or rewritten, what the plugin decides meanwhile is kept in memory and written with the file's records once it can be read, and `status.decisions` says `failing`. A last line left torn by a write that did not finish is cut at start, so the next record starts a line of its own; if it cannot be cut, nothing is appended after it. A record that could not be written stays in memory, and the whole retained record is written again once a write succeeds; until then `status.decisions` says `failing`. Decisions are appended without being synced to disk, so the last lines may not survive a crash, and records waiting in memory to be written stay subject to the 30 days and the 50,000 cap. The plugin is the record's only writer: it appends to, repairs or replaces only the version of the file it last read or wrote, and a file changed from outside is read and merged with what it holds before anything is written; writes from outside at the same time as its own are not supported, as the check comes before the rename and a rename cannot compare and swap. `decisions.list` is on the read tier, so every read connection can read every bot's records; the event carries none of it.

## What it guarantees, and what it cannot

While it runs, for every agent tool call that reaches the gateway's `before_tool_call` hook, with the rules read (or, while they are lost, the copy read earlier; with no copy, every call but `ask_user` is asked about):

- a matching Never blocks the call, naming the rule, its version and its id in the call's result (`details.status: "blocked"`);
- A matching Ask or fallback requests the gateway's approval. Where the gateway can reach an eligible reviewer, the card offers only Allow once and Deny. With no eligible reviewer or if approval authority changes, OpenClaw can refuse the call.
- an Allow never passes an Ask or a Never;
- `ask_user` is never asked about or blocked;
- the call's parameters are never changed;
- the decision is recorded as above.

**What stays open.**

1. **When the plugin is not running**, nothing here holds: the gateway runs the calls the plugin would have asked about or refused, with no card. With the plugin turned off in its config, a run that starts afterwards runs its calls with no card. A run already going when it was turned off keeps the plugin as it started: its next call is still decided by the plugin (on a development gateway, it was still asked, and Allow once ran it). To hold a tool without the plugin, deny it in the bot's own settings.
2. **What never reaches the hook**: what an operator does through the gateway's own methods, and what other plugins' code does.
3. **Other plugins.** The hook is registered with the default priority. The gateway runs hooks in order of priority; a hook that runs before this one and blocks ends the decision, and the first plugin to ask is the one whose card is shown. A later plugin can still block after this one asked.
4. **What a pattern cannot see**: a file reached by a command or another tool, a link, a command run through a wrapper or a script (above).
5. **A routine, or a run another bot's message started**: an Ask there is a refusal, not a question (above).
6. **The plugin's own errors**: the gateway fails a tool call closed when a hook throws or takes longer than 15 seconds. The hook waits on nothing, but its work is synchronous: on each call it looks at the rules file's size and times, reads the file again only when they changed, and appends one line to the decision record.

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

`pnpm scenarios` runs the rules checks on an instance of their own (`tools/dev-gateway/src/rules-checks.ts`), with an admin connection, Clawtrate's interactive tier, another device with approvals, one with read and write, and a read-only one: rules lost with no copy read, where every call but `ask_user` gets the "could not be read" card and `status` says `ask-every-call`; rules lost after a copy was read, where the copy still blocks and `status` says when it was read; `status`, `get` and `decisions.list` answer at the read tier and `set` only for admin, with an empty event for every reader; an Ask's card reaches only the run's device and admin, with Allow once and Deny and a 10-minute wait, and Allow once runs the call once while the next identical call asks again; Deny refuses; a Never blocks with the rule named and no card; an Allow does not pass an Ask; "Ask when nothing else decides" asks, an Allow keeps it from asking, and `ask_user` is never asked; a save past each limit is refused and saves nothing; a Never caught by another spelling of the file's name, and an Allow of another spelling that does not keep the fallback from asking; with approval forwarding turned on with no destination, a card with no path, command or bot, and `cardDetails: "full"` bringing them back; a routine's call is refused with no card; a setting changed while a card waits; the plugin turned off in the middle of a run; a call in a run another bot's message started (`#message-read`); and the log's warnings. Each decision record checked is joined to its audit record.

The plugin's own tests run with `pnpm test` (`plugins/clawtrate-tool-rules/test`).
