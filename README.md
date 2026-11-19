<p align="center">
  <img src="assets/brand/logo.png" width="112" height="112" alt="Clawtrate logo">
</p>

# Clawtrate

Your OpenClaw agents, orchestrated.

A desktop and iOS client for [OpenClaw](https://github.com/openclaw/openclaw). Clawtrate connects to an OpenClaw gateway you already run and gives it a bots-first interface: your bots in a sidebar, tasks under each bot, the conversation in the middle, and the bot's work beside it.

Clawtrate is an independent project and is not affiliated with OpenClaw or xAI.

Status: early development. This first version is read-only. It pairs with a gateway and shows your bots in one list, each drawn as its own character (or with the picture the gateway gives it), with its latest activity, whether it is working, and whether anything is unread. A bot with several tasks unfolds to show them under it. The open task reads as a conversation of bubbles; the bot's reasoning and tool calls are folded into one line per run and open to the full arguments and results. A Work pane beside the conversation shows the task's details, and becomes a drawer on narrower windows. The same interface works at phone width, one pane at a time. While the connection drops and returns, everything stays on screen and one small strip says what is happening.

## Quickstart

You need Node.js 26, pnpm 11 and the OpenClaw CLI (`openclaw`, version 2026.10.6) on your `PATH`.

```bash
pnpm install
```

### 1. Start the development gateway

```bash
pnpm dev-gateway start
```

This runs `openclaw --dev gateway run` on `ws://127.0.0.1:19001` with its state in `~/.openclaw-dev`, so it never touches a gateway you use day to day. It talks only to a scripted model server on `127.0.0.1:19091`; no model provider account is used. It then seeds four sample bots, each with its own instructions, eleven conversations with reasoning and tool calls, and seven finished examples of the live situations (see [Scenarios](#scenarios)). Each seeded run is checked against its script. `pnpm dev-gateway up` does the same.

Every start is a fresh, seeded gateway. It stops the gateway this checkout started before, deletes `~/.openclaw-dev` and creates it again empty. OpenClaw keeps credentials in the same SQLite stores a clean profile has, so the tool never reuses state rather than trying to prove old state clean. If `~/.openclaw-dev` was not created by this tool, or is a symlink, `start` refuses and changes nothing. The tool records every process it starts by PID and start time, and it deletes a state folder only with proof that nothing runs on it: every recorded process is gone and nothing listens on the instance's ports. A process counts as gone only when the system says there is no such process, or shows it as a zombie. When the tool cannot tell, for example because `ps` fails or prints something it cannot read, it treats the process as running, signals and deletes nothing, and says what it could not determine. So if the folder's gateway may be running and this checkout cannot prove it started it, `start` and `reset` refuse, say which instance is in use, and change nothing. `stop` signals only processes it can prove this checkout started; anything it cannot prove, it reports and leaves alone. An instance's development browser and its helper processes, which can outlive the gateway and leave its process tree, are found by their arguments naming the instance's own browser folder: `stop` and `reset` wait for them to exit, stop by PID any still running after 10 seconds, and `reset` deletes nothing until none is left. A state folder made by an older version of the tool is refused for good; see [Migrating from an older version](#migrating-from-an-older-version). Because the gateway is new each time, preview hosts and the desktop app pair again after a start. The generated config must match one closed contract (only the scripted model, token auth on loopback, workspaces inside the instance, the tool allowlist and the rest; see `docs/decisions.md`); any other key or value stops `start` before the gateway runs. That contract covers the configuration only; a plugin loaded with `--with-plugin` is code that runs with your own access (see [Plugins of this project](#plugins-of-this-project)).

Other commands: `pnpm dev-gateway status`, `stop`, `seed` (verify the running gateway's seed), `approve`, `reset` (stop, then delete the instance's state folder), `list`, `prune`, and on a named instance `lock` and `unlock` (see [Scripted provider accounts](#scripted-provider-accounts)). Commands that talk to the gateway refuse to run unless the gateway this checkout started on that state is still running.

#### Instances

What is described above is the default instance. One machine can run several development gateways at once, for example a long-lived preview and an end-to-end run in another checkout. Each is an instance, named with `--instance <name>` on any command or with `CLAWTRATE_DEV_INSTANCE`:

```bash
pnpm dev-gateway start --instance review
pnpm dev-gateway approve --instance review
CLAWTRATE_DEV_INSTANCE=review pnpm dev-gateway status
pnpm dev-gateway list       # every instance on this machine, its folder, ports and gateway
pnpm dev-gateway reset --instance review
pnpm dev-gateway prune      # machine-wide: remove every idle named instance, any checkout's
```

A name is 1 to 24 lowercase letters, digits and inner hyphens. The instance runs `openclaw --profile clawtrate-dev-<name>` with its state in `~/.openclaw-clawtrate-dev-<name>`, and `start` picks free ports for its gateway and scripted model between 19200 and 19999 and records them. Every rule above holds per instance: its own fresh folder and marker, its own run files in `tools/dev-gateway/.run/instances/<name>`, and no command for one instance acts on another instance's folder, gateway or processes. `reset` removes only the named instance. `start`, `stop`, `reset` and `prune` take a lock per instance, and port choice a lock for the machine, so no two of these commands act on the same instance at once. `start` holds its lock until the gateway is healthy, its exec policy checked and its bots seeded; a `stop` or `reset` issued meanwhile waits for it (up to ten minutes) and then acts on the finished instance. `status`, `seed`, `approve` and `list` take no lock. `list` and `prune` cover every instance on the machine and refuse `--instance`; `prune` is deliberate maintenance, removes only instances proven idle, and never the default one.

#### Plugins of this project

A named instance can load this checkout's own OpenClaw plugins, from `plugins/`, by name:

```bash
pnpm dev-gateway start --instance review --with-plugin <plugin> [--with-plugin <another>]
```

**A plugin loaded with `--with-plugin` is trusted code.** It runs inside the gateway with your full access to files, processes and the network. The guard constrains the gateway's configuration and the tools bots are given, not what plugin code does. Load only plugins from this repository that you have read. `start` prints this every time it loads a plugin.

What the guard does check:

- **Where it comes from.** The plugin's real path must be a direct child, by exactly that name, of the real path of this checkout's `plugins/`. Neither folder may be a link, and nothing inside the plugin may be one. `start` reads the folder once, writes that copy into the instance's state folder, records its digest, and the gateway loads only the copy. `seed` checks the copy against the digest again.
- **What it may set.** Beside its manifest, each plugin has a `clawtrate-dev-contract.json` that lists the exact config keys it sets and the exact tools it turns on, each with a declared kind:
  - a setting is a `flag`, a `count`, a `loopback-url` (parsed, with a loopback host), an `instance-path` (plain names, resolved inside the instance's state folder) or a `scripted-model-url` (a plain path, given as that path on the instance's own scripted model);
  - a tool is a `plugin-tool`, and may not be one the gateway provides itself;
  - there is no kind for free text, a command, an argument list, a credential or a model provider, and any other key or kind is refused.
- **What its manifest may declare.** Providers and sign-in methods only for the scripted account providers (`acme`, `globex`), and then only on an instance started with `--with-accounts`; no provider aliases, catalogues or endpoints.

One plugin of an instance may also declare `botBrowsers`: which seeded bots get a browser of their own, and two timings, each from a closed set. The tool then writes the whole browser setup itself and the guard refuses any other browser setting. [`plugins/clawtrate-computer`](plugins/clawtrate-computer/README.md), the plugin for watching and taking over a bot's browser, does this for Marlow and Pip, whose browsers can open only the instance's scripted pages on loopback:

```bash
pnpm dev-gateway start --instance browse --with-plugin clawtrate-computer
```

The default instance and `pnpm e2e` load no plugins. [The opening](docs/decisions.md#development-gateway) is described in `docs/decisions.md`.

#### Scripted provider accounts

```bash
pnpm dev-gateway start --instance acct --with-accounts --with-plugin clawtrate-dev-signin
pnpm dev-gateway lock --instance acct --agent <bot> --provider acme acme:home
```

A named instance can carry scripted provider accounts: two scripted providers on its own scripted model, labelled accounts of both in the shared store and one kept by Otto alone, a record of which account's credential reached the scripted model for every request, failures scripted per account, and scripted sign-ins (a link and a code, a browser sign-in with the code pasted back, an API key) through the gateway's own `models.authLogin`. `lock` and `unlock` set and clear a bot's one-account order through the gateway's command line. [`tools/dev-gateway/README.md`](tools/dev-gateway/README.md) explains all of it, the account checks and what the gateway did.

#### Migrating from an older version

Earlier versions of the tool recorded no process start times, so this version cannot prove anything about the state they left and refuses it for good: it never signals its processes, starts it over or deletes it. Move it aside once, by hand, from the checkout that started it. For the default instance:

1. Look up the old gateway's and scripted model's PIDs. That checkout's `tools/dev-gateway/.run/state.json` records them as `gatewayPid` and `providerPid`. Check that each is still that process with `ps -o pid,lstart,command -p <pid>`, then stop it with `kill <pid>`. Stop anything they started too (`pgrep -P <pid>` lists it).
2. Check that nothing listens on the instance's ports any more: `lsof -nP -iTCP:19001 -iTCP:19091 -sTCP:LISTEN` prints nothing.
3. Move the old state folder aside by renaming it: `mv ~/.openclaw-dev ~/.openclaw-dev.old`.
4. Delete that checkout's old run file: `rm tools/dev-gateway/.run/state.json`.
5. `pnpm dev-gateway start` now creates a new folder and succeeds.

For a named instance it is the same with `~/.openclaw-clawtrate-dev-<name>`, `tools/dev-gateway/.run/instances/<name>/state.json` and the ports its run file records. The tool never adopts, lists or deletes the folder you moved aside. Delete it yourself once you no longer need it.

#### Scenarios

The scripted model can put a run into every situation the live conversation has to show. Start a task with any bot and send a directive such as `#steps`, or a phrase from the table anywhere in a message ("Please show your work"). Several directives in one message run one after the other, so `#think #mcp #ask` reasons, calls the coding agent, then asks you a question. A number after `#slow`, `#stream`, `#slow-tool`, `#sleep` or `#mcp-slow` sets its length in seconds. `#help` lists them all. Directives take precedence over phrases; with several phrases, the longest wins. A turn the gateway starts on its own with one of the prompts it writes for that (a heartbeat or a wake with a queued system event, a turn that is only runtime context, a command that completed after its turn ended, a scheduled event with no content) gets `NO_REPLY`, the gateway's "nothing to say", so it leaves nothing in the task, whatever the event's text says. Two continuations are meant to be seen and are answered: another bot's reply arriving in the task after a `#message-slow` gets a short acknowledgement, and a reminder the gateway asks to relay is relayed (the scheduler is off here, so none runs). A turn started some other way, by a hook or a plugin for instance, with a prompt of its own, is not recognized; like any other message outside the table it gets a short reply saying the scripted model has none written for it.

| Directive          | Phrase                                 | What happens                                                                                                                                                                                                                    | Send it to                      |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `#help`            | what scenarios can you play            | Lists every directive and phrase.                                                                                                                                                                                               | any bot                         |
| `#text`            | reply in plain text                    | Streamed text, no reasoning.                                                                                                                                                                                                    | any bot                         |
| `#think`           | think before you answer                | Reasoning, then text.                                                                                                                                                                                                           | any bot                         |
| `#think-only`      | think without answering                | Reasoning only: no text and no tool. The gateway asks twice more for a visible answer, then ends the run in an error.                                                                                                           | any bot                         |
| `#steps`           | show your work                         | Reasoning, a tool call, more reasoning, another tool call, then text.                                                                                                                                                           | any bot                         |
| `#slow [N]`        | take your time                         | Reasoning, then text streamed slowly for N seconds (default 20): stop it, or queue a message behind it.                                                                                                                         | any bot                         |
| `#stream [N]`      | stream a long answer                   | Text streamed slowly for N seconds (default 10), with no reasoning first: a run still going when a client quits and opens again.                                                                                                | any bot                         |
| `#slow-tool [N]`   | run a slow tool                        | A tool call that takes N seconds (default 20): steer into it, stop it or queue behind it.                                                                                                                                       | any bot                         |
| `#tool-fail`       | use a tool that fails                  | A tool call that fails (reading a file that does not exist), then text.                                                                                                                                                         | any bot                         |
| `#long-output`     | print a long output                    | A tool whose output is long enough for the gateway to cut it (20,000 lines).                                                                                                                                                    | any bot                         |
| `#read`            | read your instructions                 | One file read: the bot's own AGENTS.md.                                                                                                                                                                                         | any bot                         |
| `#read-six`        | read six files                         | Six file reads in a row, with nothing between them.                                                                                                                                                                             | any bot                         |
| `#list`            | list your files                        | One folder listing of the bot's workspace.                                                                                                                                                                                      | any bot                         |
| `#write`           | write a note                           | One file write in the bot's workspace (notes/scratch.md).                                                                                                                                                                       | any bot                         |
| `#edit`            | edit a note                            | A file write, then an edit of the same file (notes/edit-me.md).                                                                                                                                                                 | any bot                         |
| `#write-large`     | write a long log                       | A file write, then an edit that appends to it, leaving it over the gateway's 256 KiB preview limit (logs/transcode.log, 300,000 bytes): the Work pane says it is too large to show, with the limit.                             | any bot                         |
| `#picture`         | look at the trail map                  | One file read of the picture seeded in Pip's workspace (pictures/trail-map.png). Pip's workspace also holds a small git checkout, `projects/trail-guide`, for a task started in it to compare its changes with the last commit. | Pip                             |
| `#remember`        | save this to memory                    | A memory note: a write to the bot's daily memory file (memory/2026-11-17.md).                                                                                                                                                   | any bot                         |
| `#search`          | search the web                         | A web search, answered by the scripted model server; nothing leaves the machine.                                                                                                                                                | any bot                         |
| `#sessions`        | list your tasks                        | A look at the bot's sessions (sessions_list).                                                                                                                                                                                   | any bot                         |
| `#schedule`        | schedule a reminder                    | Creates a routine, then removes it (automations). Works only in runs started as the gateway's owner; see below.                                                                                                                 | any bot                         |
| `#plan`            | show a plan                            | A tool with no kind of its own: a progress card with a finished three-step plan.                                                                                                                                                | any bot                         |
| `#approve`         | run a command I can approve            | Asks to run `ls` in Otto's workspace. The approval offers a reusable rule (allow-always).                                                                                                                                       | Otto                            |
| `#approve-once`    | run a command I approve every time     | Asks to run `echo 'Hello from Otto.'` with per-call ask "always": the approval offers no reusable rule.                                                                                                                         | Otto                            |
| `#exit-code`       | run a command that fails               | Asks to run `ls missing-folder`, which exits non-zero.                                                                                                                                                                          | Otto                            |
| `#exec-timeout`    | run a command that times out           | Asks to run `sleep 5` with a 1 second limit, so it is stopped.                                                                                                                                                                  | Otto                            |
| `#sleep [N]`       | run a slow command                     | Asks to run `sleep N` (default 20, at most 120): a slow shell command.                                                                                                                                                          | Otto                            |
| `#count`           | run a command that prints as it goes   | Asks to run a four-second `perl` loop that prints a line each second: its output streams while it runs, and the request carries the gateway's warning about inline code.                                                        | Otto                            |
| `#ask`             | ask me a question                      | One question with options, through the gateway's question tool.                                                                                                                                                                 | any bot                         |
| `#ask-many`        | ask me several questions               | Three questions in one card.                                                                                                                                                                                                    | any bot                         |
| `#ask-multi`       | let me pick several                    | One multi-select question.                                                                                                                                                                                                      | any bot                         |
| `#ask-text`        | ask me to type an answer               | A question meant to be answered in free text (every question also accepts typed text).                                                                                                                                          | any bot                         |
| `#reply`           | reply with a note                      | A short note; what a bot answers when the other bot messages it.                                                                                                                                                                | any bot                         |
| `#message`         | message your partner                   | A message to the other bot of the pair, answered in the same call.                                                                                                                                                              | Marlow or Pip                   |
| `#message-slow`    | message your slow partner              | A message to the other bot, which takes 15 seconds; the call returns before it answers, and the reply arrives later in the same task.                                                                                           | Marlow or Pip                   |
| `#message-fail`    | message your failing partner           | A message to the other bot, whose run ends in a model error.                                                                                                                                                                    | Marlow or Pip                   |
| `#message-ask`     | message your partner who asks          | A message to the other bot, which asks its own user a question before replying.                                                                                                                                                 | Marlow or Pip                   |
| `#mcp`             | ask the coding agent                   | A call to the stand-in coding agent over MCP; the result carries a link.                                                                                                                                                        | any bot                         |
| `#mcp-slow [N]`    | ask the coding agent something slow    | A call to the coding agent that takes N seconds (default 20) to reply.                                                                                                                                                          | any bot                         |
| `#mcp-error`       | ask the coding agent to run the checks | A call to the coding agent that returns an error.                                                                                                                                                                               | any bot                         |
| `#mcp-stop`        | start a coding task I can stop         | A call to the coding agent that does not finish for an hour: stop the run mid-call.                                                                                                                                             | any bot                         |
| `#model-error`     | fail with a model error                | The model request fails, so the run ends in an error.                                                                                                                                                                           | any bot                         |
| `#browse`          | open the scripted sign in page         | Opens the scripted sign-in page in a new tab of the bot's own browser.                                                                                                                                                          | a bot with a browser of its own |
| `#browse-read`     | read the open page                     | Reads the text of the bot's current tab.                                                                                                                                                                                        | a bot with a browser of its own |
| `#browse-slow`     | open the slow scripted page            | Navigates the current tab to a scripted page that takes eight seconds to load.                                                                                                                                                  | a bot with a browser of its own |
| `#browse-download` | download the scripted file             | Navigates the current tab to a scripted file that downloads slowly, over eight seconds.                                                                                                                                         | a bot with a browser of its own |
| `#browse-outside`  | open an outside address                | Navigates to an address outside loopback, then to another loopback port, and reads what the tab shows; both are refused.                                                                                                        | a bot with a browser of its own |

Where it matters which bot you ask:

- **Shell commands** run only for Otto, and only after you approve each one. Every other bot's shell is denied, so `#approve` sent to Pip shows a denied step instead. Otto's scripted model only ever asks for the commands in the table. An approval with "allow always" lets that exact command run in Otto's workspace without asking again, until the instance is started over. [What can run](docs/decisions.md#what-can-run) says exactly what is allowed.
- **Bot-to-bot messages** go only between Marlow and Pip. A bot outside the pair asks Marlow, and the gateway refuses. A message goes to the other bot's main task ("Notes for Pip" in Marlow's list), and a bot may ask its user a question only in a task a person has written in, which the seed's example does.
- **Files** stay in the bot's own workspace: the gateway is configured to refuse file tools outside it.
- **Web search** goes to the scripted model server on loopback, through the gateway's bundled Ollama search provider, and returns three fixed results on the reserved `search.example` domain. Bots are offered only the tools these scenarios use; fetching web pages, the browser, tools that manage the gateway or its installation, and tools that reach the network or another device are switched off for every bot.
- **Browsers** (`#browse` and the others): only on an instance started with `--with-plugin clawtrate-computer`, and only for Marlow and Pip, each in a browser of its own that reaches nothing but the scripted pages. Elsewhere the browser tool is off and these directives answer that the instance has no scripted pages.
- **Routines** (`#schedule`): the gateway offers its `automations` tool only in runs started as its owner, which the scenario check does through the CLI. Sent from a paired client, the run reports "Tool automations not found".
- **Questions and approvals** need a client with the right scopes. The read-only preview does not show them yet; answer from a client with `operator.questions` or `operator.approvals`.

After `start`, the seed has left finished examples, played through a paired client called "Clawtrate seed" that answers and approves as the user and is unpaired afterwards: Juniper's "Show your work" (reasoning and steps), "A step that fails" and "Hand off to the coding agent" (an MCP call); Pip's "Ask Marlow about the plan" (a bot-to-bot exchange) and "Which route on Saturday" (an answered question); Marlow's "Notes for Pip", where Pip's message arrived; and Otto's "List the workspace (approved)" (a resolved approval).

### 2. Open the web preview

```bash
pnpm preview:web
```

This builds the interface and serves it on `0.0.0.0:5310`. It prints a link with an access token, for example `http://localhost:5310/?token=…`, plus one per network address. Open that link from any machine that can reach this one. The token is generated at each start and printed once. Nothing is served without it.

In the browser, choose **Use the development gateway**. The gateway has not seen this device before, so Clawtrate shows a pairing request. Approve it:

```bash
pnpm dev-gateway approve
```

The page connects within a few seconds of approval. From then on, the device uses its own device token.

The gateway connection, the device key and pairing all live in the preview host process, not in the browser. That is why a plain `http://` page on another machine can pair at all. Useful flags (pnpm passes them through):

- `pnpm preview:web --dev-gateway` connects to the development gateway at startup.
- `pnpm preview:web --no-access-token` turns the access token off. It is only accepted with the development gateway. The host then opens nothing but the development gateway, and refuses to start if its data directory remembers another one; use a separate `--data-dir` for development.
- `pnpm preview:web --instance <name>` (or `CLAWTRATE_DEV_INSTANCE`) makes both of the above use that instance's gateway instead of the default instance's, but only while this checkout's `pnpm dev-gateway start --instance <name>` is provably the instance's current run and its gateway is running. That proof is read again from the instance's marker, this checkout's run file and the live process before every connection: the first one, a reconnect the user asks for, and every automatic retry. If it no longer holds, or cannot be determined, no socket is opened; the host shows that the gateway is not allowed and stops retrying it. The desktop app reads `CLAWTRATE_DEV_INSTANCE` the same way and applies the same proof to its development gateway.
- `pnpm preview:web --read-only` pins the connection to the read tier. The host asks the gateway for `operator.read` alone, even when its device was granted more, and never asks for more access; the interface shows the read-only conversation without "Request access", and every send, stop or answer is refused. Use it to show a gateway you only want watched.
- `--port`, `--host` and `--data-dir` change where it listens and where it keeps the device identity.

### 3. Run the desktop app

```bash
pnpm desktop
```

This builds and starts the Electron app. The first run downloads the Electron binary. Development builds offer the same **Use the development gateway** button, and pair the same way.

### 4. Package the desktop app

```bash
pnpm package:mac      # Clawtrate.app, a .dmg and a .zip for Apple silicon and Intel, in apps/desktop/dist
pnpm check:packaged   # launches the packaged app and pairs it with a development gateway of its own
```

`pnpm package:win` builds an x64 installer on Windows; CI installs it, runs the launch check against the installed app and uninstalls it. The builds are unsigned unless signing variables are set. [CONTRIBUTING.md](CONTRIBUTING.md) explains signing and how to open an unsigned build. A packaged app does not offer the development gateway.

## Checks

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks, the development gateway rules, what may be committed and packaging.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm exec playwright install chromium   # once
pnpm e2e
pnpm scenarios
```

`pnpm scenarios` is the scenario check on an instance of its own. It starts an unseeded named instance, connects with the official gateway client as three paired operators (read and write; plus `operator.approvals`; plus `operator.questions`), triggers every scenario above, and asserts what the gateway emitted: each run's lifecycle, the reasoning and tool events in order, the question cards and their answers, the approval requests with the decisions they offer and their resolution, the bot-to-bot tool results and the recipients' runs, the MCP results, stops, steers and queued messages. Event payloads are checked against the schemas in `@openclaw/gateway-protocol`, and every tool call of every run, with its exact arguments, result and item, and every run's outcome, against the scenario that made it; a run the check does not assert fails it. It also checks that the tools the model is offered are exactly the allowed ones, and fails if a directive has no check. Its instance has the scripted provider accounts and sign-ins, and after the scenario checks it runs the account checks ([`tools/dev-gateway/README.md`](tools/dev-gateway/README.md#the-account-checks)) with an admin client and a read-only one. It prints one line per check and resets its instance afterwards, also on Ctrl-C. Then it runs the computer checks (`tools/dev-gateway/src/computer-checks.ts`) on a second instance of its own started with `--with-plugin clawtrate-computer`: a bot's own browser, watching, taking over and handing back, expiry, a caller that leaves, a tab that closes, and the browser's confinement to loopback, each asserted from the gateway's answers ([the plugin's page](plugins/clawtrate-computer/README.md#on-a-clawtrate-development-gateway) lists them). `pnpm e2e` runs the scenario checks on its own seeded instance (`e2e/scenarios.spec.ts`). What the checks found about the gateway is in [What the scenario check observed](docs/decisions.md#what-the-scenario-check-observed).

### Without a gateway: the fixture mode and the visual tests

```bash
pnpm fixture   # builds the interface on fixed sample data and serves it on 127.0.0.1:5341 (CLAWTRATE_FIXTURE_PORT picks another)
pnpm visual    # screenshot, legibility and behaviour tests against the fixture mode
```

The fixture mode is the real interface fed a fixed state through the same bridge the hosts use. It needs no gateway and makes no request of its own. Pick what it shows from the address: `?scene=` with `main`, `connect`, `connect-error`, `connecting`, `pairing`, `reconnecting`, `reconnecting-unloaded`, `offline`, `offline-long-address`, `catching-up`, `synced`, `sync-pending`, `sync-failed`, `refresh-failed`, `load-failed`, `loading`, `discovery-error`, `discovering`, `empty`, `partial`, `zero-tasks`, `task-states`, `protocol-mismatch`, `pairing-rejected`, `pairing-expired`, `connect-unreachable`, `disconnected` or `offline-unreachable`; `&bot=otto&task=agent:otto:disk-space` to open a task; `&panel=open`; `&theme=dark`; `&pins=main,otto`, `&hidden=marlow` and `&sort=name` for the rail's arrangement; `&bubbles=neutral`. It is a separate build, never part of the desktop app or the web preview.

`pnpm visual` compares screenshots with the baselines in `visual/baselines/`, which are taken on macOS and only valid there. After an intended change, `pnpm visual:update` rewrites them; look at every changed image before committing it.

`pnpm e2e` never uses the default instance or its ports. Each run creates its own instance named `e2e-<random>`, plus an unseeded second instance so another gateway is always listening while it runs. It starts the gateway, its scripted model and a preview host with a fresh device identity on free ports, approves the pairing request the page raises, and checks that the bots, a task list and a transcript render, and that every other running instance is left as it was. Afterwards it removes exactly what it created: its two instances by name and run id, its preview host and its temporary folders, also when a test fails or the run is stopped with Ctrl-C or SIGTERM. A run killed outright, at any point, leaves a record in `tools/dev-gateway/.run/e2e/`, and the next `pnpm e2e` in the same checkout cleans it up once that run is proven to have ended. Every gateway, scripted model and preview host is written to a record before it can run, so none is left that the next run cannot find. A `dev-gateway` command or renderer build that the killed run left behind finishes on its own; the next run's cleanup of an instance waits for that instance's lock. If the next run cannot determine whether the earlier one has ended, or whether its preview host has exited, it leaves the record and the folders alone and says why. Runs in several checkouts, or several in one, can go at the same time.

## Logo and icons

The logo is `assets/brand/logo.png`. The desktop icons, the favicons and the mark inside the app are all generated from it:

```bash
pnpm brand:strip   # removes provenance and text metadata from the logo
pnpm brand:icons
```

To change the logo, replace that one file and run both commands. A unit test fails if the generated icons are older than the logo. The interface's accent color is taken from the mark and defined in `packages/ui/src/styles/tokens.css`.

## Repository

- `packages/core`: the gateway connection, device pairing, state stores and the mapping from gateway data to view models. It has no DOM or Node APIs; hosts inject the socket, storage and signing.
- `packages/ui`: the React interface shared by the desktop app and the web preview.
- `apps/desktop`: the Electron app, its packaging (`packaging/`) and the web preview host.
- `tools/dev-gateway`: development gateway control and the scripted model server.
- `tools/brand`: the icon generator.
- `docs/decisions.md`: versions, protocol choices and why things are the way they are.

## License

MIT. See [LICENSE](LICENSE).
