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
- No configuration of its own: its config schema takes no keys.

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

1. **The `gateway` and `plugins` tools.** They read and change the gateway's settings and its plugins, so a bot with either can turn this plugin off or remove it.
2. **Commands on the gateway's machine outside a sandbox** (`exec` and `process`). A command runs as the gateway's user and can edit the gateway's settings and this plugin's files. Deny both tools to the bot, set its command policy to `deny`, or run its commands on another machine (`tools.exec.host: "node"`) or in a sandbox.
3. **Writing files outside its workspace.** The store is in the gateway's state folder. Keep `tools.fs.workspaceOnly: true`, or deny `write`, `edit` and `apply_patch`.

**What the plugin checks.** When it starts, it reads the gateway's settings and writes one warning to the gateway's log for each bot and each of the three it cannot rule out, for example `clawtrate-tool-rules: Bot otto may run commands on the gateway's machine outside a sandbox, …, so Clawtrate's rules are advice for it.` The check is conservative: a tool counts as denied only when a deny list names it (by name, alias, `*`, a pattern, or the groups `group:openclaw`, `group:automation`, `group:runtime` and `group:fs`) or an allow list leaves it out; a tool profile or an unknown group counts as offered. It is a warning, not a guarantee, and the plugin does not refuse to run. (The gateway's `security audit` command loads an installed plugin without running it, so the plugin cannot add these as audit findings.)

Also true, whatever is denied:

- A rule about a file tool is a rule about that tool, not about the file. A command, or another tool, can still reach the file where the bot may use it. A path is matched as the tool receives it, so a link inside the workspace that points elsewhere is matched by its own name.
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

**Limits** (Clawtrate's choices), per scope: 20 Allow rules, 20 Ask rules and 50 Never rules; a pattern of at most 1,000 characters; a note of at most 1,000; at most 16 tools per rule; rules for at most 64 bots. A save past any of them is refused whole and saves nothing. Nothing is ever removed by itself.

## What a device can do with it

| Method                                | Scope            | Parameters                                                                                           | Answer                                                                                                                                                                      |
| ------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawtrate-tool-rules.status`         | `operator.read`  | none                                                                                                 | `{plugin, version, rulesSchema, rules: {state: "available"} \| {state: "unavailable", reason}, hook: {registered, lastCallAt}, matches: {tools, fallback, exempt} \| null}` |
| `clawtrate-tool-rules.get`            | `operator.read`  | `scope?`                                                                                             | `{rulesSchema, scopes: {<scope>: {version, fallback, rules}}, limits}`                                                                                                      |
| `clawtrate-tool-rules.decisions.list` | `operator.read`  | `agentId?, sessionKey?, runId?, before?` (a time in ms, exclusive), `limit?` (1 to 500, default 100) | `{records, hasMore, retention: {days: 30, maxRecords: 50000}}`, newest first                                                                                                |
| `clawtrate-tool-rules.set`            | `operator.admin` | `scope, rules, fallback, expectedVersion`                                                            | the scope as saved: `{scope, version, fallback, rules}`                                                                                                                     |

The gateway enforces each scope when it admits the call: below admin, `set` is refused with `FORBIDDEN` and `details.missingScope: "operator.admin"`, before the plugin sees it.

**`set`** replaces a scope's rules and its fallback. `expectedVersion` is the scope's `version` as read (0 for a scope with no rules); any other number is refused. A rule given with its `id` keeps its version unless what it says changed; one without an `id` is new, version 1. A scope left with no rules and the fallback off is not kept, and its version starts again at 0.

**`status`** says only what the plugin itself knows: its version (`1.0.0`), the rules' schema (`1`), whether its hook is registered, when its hook last saw a tool call in this gateway process (`null` until it has), and what its rules match (`tools` by entry, `fallback`: the scopes that ask for every tool, `exempt: ["ask_user"]`). `hook.registered` is true when a registration of this plugin that had the gateway's hook interface registered the hook and its service is running; that is what the plugin can verify, not proof that the gateway calls it, which `lastCallAt` shows once it has. When the rules file cannot be read, `rules.state` is `unavailable` with the reason and `matches` is `null`.

**Refusals** carry one of the gateway's codes and a `details.reason`:

| Code              | `details.reason`                          | When                                                                                             |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `UNAVAILABLE`     | `rules_unavailable`                       | the rules file cannot be read (`get`, `set`); the message starts "Rules unavailable:"            |
| `UNAVAILABLE`     | `store_not_written`                       | the new rules could not be written; nothing changed                                              |
| `INVALID_REQUEST` | `version_conflict`                        | `expectedVersion` is not the scope's version; `details.currentVersion` is                        |
| `INVALID_REQUEST` | `limit`                                   | past a limit; `details` has `action`, `limit` and `count`, or `limit` and `length` for a pattern |
| `INVALID_REQUEST` | `bad_rule`, `unknown_rule`, `exempt_tool` | a rule that is not one, an `id` the scope does not have, a rule naming `ask_user`                |
| `INVALID_REQUEST` | `bad_scope`, `bad_request`                | a scope that is not `*` or a bot's id; a malformed `fallback`, `expectedVersion` or filter       |

**The event**, `plugin.clawtrate-tool-rules.changed`, on the read tier, with an empty payload, after every save and whenever the rules file changes on disk. Fetch again on receipt; nothing about a rule or a bot is in it.

## The card

An Ask is the gateway's own plugin approval: `plugin.approval.requested`, answered with `plugin.approval.resolve`. The plugin asks with:

- a title of at most 80 characters, `"<tool>: Clawtrate's rules plugin asks first"`;
- a description of at most 512 naming the rule and the target, for example `Asked by Clawtrate's rules plugin: otto's rule 'Ask first · notes/**', version 1 (rule 3f2a9c1b0d4e). The call: write on notes/disk-2026-11-18.md.`, or for the fallback `Asked by Clawtrate's rules plugin: "Ask when nothing else decides" is on for otto. …`;
- the target in the description is the call's own (a path or a command): the gateway shows the card only to those who can read the call (below);
- `severity: "warning"`, `timeoutMs: 600000` (the gateway keeps a plugin's wait to 10 minutes at most);
- `allowedDecisions: ["allow-once", "deny"]`, always. The gateway gives the plugin the decision alone, not which approval it answered or who answered, so nothing trusted could tell the plugin who may make a standing permission. The card never offers Always allow, and an answer never saves anything. A standing permission is an Allow rule, saved with `set` by admin.

What the gateway does with it (OpenClaw 2026.10.6, seen on a development gateway):

- The card reaches the device whose message started the run, and admin connections. Another device with `operator.approvals`, and a read-only device, do not receive it or list it.
- Allow once runs that call once; the next identical call asks again. Deny refuses it with "Denied by user. The tool call did not run."
- **A routine's run** has no one to ask: the gateway raises no card and refuses the call at once (the plugin's record shows the ask answered `cancelled`; the audit log counts the call `failed`). The routine's own summary can still say the work was done.
- **A run started by another bot's message** has no one to ask either: no card reaches any device, the call is refused with "Plugin approval required (gateway unavailable)", and the record shows `cancelled`.
- **A change while a card waits**: after a change to this plugin's rules, the card stays and Allow once runs the call. After a change to the gateway's settings (a bot's deny list was tried), the card stays listed, an answer is acknowledged, and the call fails with "Plugin approval required (gateway unavailable)".

## The store

The rules are in `<state folder>/clawtrate-tool-rules/rules.json`, the plugin's own file, mode `0600` in a `0700` folder:

- **Written atomically**: a temporary file in the same folder, flushed, renamed over the old one, and the folder flushed. A reader sees the old rules or the new ones, never part of either.
- **Versioned** per scope, for compare-and-set (`set`'s `expectedVersion`), and per rule, so a decision names a rule as it was.
- **Bounded** by the limits above, checked again whenever the file is read.
- **Read again whenever it changes on disk** (by its size, times and inode), and checked as strictly as a `set`. When it cannot be read (not JSON, another format or schema, a rule past a limit), the rules are **unavailable**: the plugin enforces nothing, says so in `status` and its log, records each call it passes with the source `rules-unavailable`, and refuses `get` and `set` rather than overwrite the file. To start again, move the file aside; a missing file is an empty store.
- **Not editable by a bot** only as far as the bot is denied the three things above. The plugin does not hide or sign the file.

## The decision record

`<state folder>/clawtrate-tool-rules/decisions.jsonl` holds, for each tool call the hook saw:

`{id, at, agentId, sessionKey, runId, callId, tool, decision, source, answer, answeredAt}`

- `callId` is the call's id hashed as the gateway's audit log hashes it (`sha256:` and the hex digest of the id), so a record and the audit log's `tool.action.*` records join by `runId` and `toolCallId`.
- `decision` is `block`, `ask`, `allow` (an Allow rule kept "Ask when nothing else decides" from asking) or `none`.
- `source` is `{kind: "rule", scope, ruleId, version, action}` (the rule as it was at that moment), `{kind: "fallback", scope}`, `{kind: "rules-unavailable"}`, or `null`.
- `answer` is the decision word the gateway gave the plugin for an ask (`allow-once`, `deny`, `timeout`, `cancelled`), with its time.

No arguments, results, paths, commands or call ids in the clear are stored or logged. Records are kept for 30 days and at most 50,000, the oldest dropped first; the file is compacted as they go. `decisions.list` is on the read tier, so every read connection can read every bot's records; the event carries none of it.

## What it guarantees, and what it cannot

While it runs, and its rules can be read, for every agent tool call that reaches the gateway's `before_tool_call` hook:

- a matching Never blocks the call, naming the rule, its version and its id in the call's result (`details.status: "blocked"`);
- a matching Ask, or "Ask when nothing else decides" with no matching Allow, raises the gateway's card with Allow once and Deny only;
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
6. **The plugin's own errors**: the gateway fails a tool call closed when a hook throws or takes longer than 15 seconds. The hook reads its rules from memory and does not wait on anything.

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

`pnpm scenarios` runs the rules checks on an instance of their own (`tools/dev-gateway/src/rules-checks.ts`), with an admin connection, Clawtrate's interactive tier, another device with approvals, one with read and write, and a read-only one: `status`, `get` and `decisions.list` answer at the read tier and `set` only for admin, with an empty event for every reader; an Ask's card reaches only the run's device and admin, with Allow once and Deny and a 10-minute wait, and Allow once runs the call once while the next identical call asks again; Deny refuses; a Never blocks with the rule named and no card; an Allow does not pass an Ask; "Ask when nothing else decides" asks, an Allow keeps it from asking, and `ask_user` is never asked; a save past each limit is refused and saves nothing; a routine's call is refused with no card; a setting changed while a card waits; the plugin turned off in the middle of a run; a call in a run another bot's message started (`#message-read`); and the log's warnings. Each decision record checked is joined to its audit record.

The plugin's own tests run with `pnpm test` (`plugins/clawtrate-tool-rules/test`).
