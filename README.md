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

Every start is a fresh, seeded gateway. It stops the gateway this checkout started before, deletes `~/.openclaw-dev` and creates it again empty. OpenClaw keeps credentials in the same SQLite stores a clean profile has, so the tool never reuses state rather than trying to prove old state clean. If `~/.openclaw-dev` was not created by this tool, or is a symlink, `start` refuses and changes nothing. The tool records every process it starts by PID and start time, and it deletes a state folder only with proof that nothing runs on it: every recorded process is gone and nothing listens on the instance's ports. A process counts as gone only when the system says there is no such process, or shows it as a zombie. When the tool cannot tell, for example because `ps` fails or prints something it cannot read, it treats the process as running, signals and deletes nothing, and says what it could not determine. So if the folder's gateway may be running and this checkout cannot prove it started it, `start` and `reset` refuse, say which instance is in use, and change nothing. `stop` signals only processes it can prove this checkout started; anything it cannot prove, it reports and leaves alone. A state folder made by an older version of the tool is refused for good; see [Migrating from an older version](#migrating-from-an-older-version). Because the gateway is new each time, preview hosts and the desktop app pair again after a start. The generated config must match one closed contract (only the scripted model, token auth on loopback, workspaces inside the instance, the tool allowlist and the rest; see `docs/decisions.md`); any other key or value stops `start` before the gateway runs.

Other commands: `pnpm dev-gateway status`, `stop`, `seed` (verify the running gateway's seed), `approve`, `reset` (stop, then delete the instance's state folder), `list` and `prune`. Commands that talk to the gateway refuse to run unless the gateway this checkout started on that state is still running.

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

Each plugin needs a `clawtrate-dev-contract.json` beside its manifest that says exactly which config entry and tools it turns on. `start` refuses a name that is not a real folder directly under `plugins/`, and any addition that would turn on a real model, another profile, credentials, shell commands, network beyond loopback or a denied tool. The default instance and `pnpm e2e` load none. [The opening](docs/decisions.md#development-gateway) is described in `docs/decisions.md`.

#### Migrating from an older version

Earlier versions of the tool recorded no process start times, so this version cannot prove anything about the state they left and refuses it for good: it never signals its processes, starts it over or deletes it. Move it aside once, by hand, from the checkout that started it. For the default instance:

1. Look up the old gateway's and scripted model's PIDs. That checkout's `tools/dev-gateway/.run/state.json` records them as `gatewayPid` and `providerPid`. Check that each is still that process with `ps -o pid,lstart,command -p <pid>`, then stop it with `kill <pid>`. Stop anything they started too (`pgrep -P <pid>` lists it).
2. Check that nothing listens on the instance's ports any more: `lsof -nP -iTCP:19001 -iTCP:19091 -sTCP:LISTEN` prints nothing.
3. Move the old state folder aside by renaming it: `mv ~/.openclaw-dev ~/.openclaw-dev.old`.
4. Delete that checkout's old run file: `rm tools/dev-gateway/.run/state.json`.
5. `pnpm dev-gateway start` now creates a new folder and succeeds.

For a named instance it is the same with `~/.openclaw-clawtrate-dev-<name>`, `tools/dev-gateway/.run/instances/<name>/state.json` and the ports its run file records. The tool never adopts, lists or deletes the folder you moved aside. Delete it yourself once you no longer need it.

#### Scenarios

The scripted model can put a run into every situation the live conversation has to show. Start a task with any bot and send a directive such as `#steps`, or a phrase from the table anywhere in a message ("Please show your work"). Several directives in one message run one after the other, so `#think #mcp #ask` reasons, calls the coding agent, then asks you a question. A number after `#slow`, `#slow-tool`, `#sleep` or `#mcp-slow` sets its length in seconds. `#help` lists them all. Directives take precedence over phrases; with several phrases, the longest wins.

| Directive        | Phrase                                 | What happens                                                                                                                          | Send it to    |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `#help`          | what scenarios can you play            | Lists every directive and phrase.                                                                                                     | any bot       |
| `#text`          | reply in plain text                    | Streamed text, no reasoning.                                                                                                          | any bot       |
| `#think`         | think before you answer                | Reasoning, then text.                                                                                                                 | any bot       |
| `#think-only`    | think without answering                | Reasoning only: no text and no tool. The gateway asks twice more for a visible answer, then ends the run in an error.                 | any bot       |
| `#steps`         | show your work                         | Reasoning, a tool call, more reasoning, another tool call, then text.                                                                 | any bot       |
| `#slow [N]`      | take your time                         | Reasoning, then text streamed slowly for N seconds (default 20): stop it, or queue a message behind it.                               | any bot       |
| `#slow-tool [N]` | run a slow tool                        | A tool call that takes N seconds (default 20): steer into it, stop it or queue behind it.                                             | any bot       |
| `#tool-fail`     | use a tool that fails                  | A tool call that fails (reading a file that does not exist), then text.                                                               | any bot       |
| `#long-output`   | print a long output                    | A tool whose output is long enough for the gateway to cut it (20,000 lines).                                                          | any bot       |
| `#read`          | read your instructions                 | One file read: the bot's own AGENTS.md.                                                                                               | any bot       |
| `#read-six`      | read six files                         | Six file reads in a row, with nothing between them.                                                                                   | any bot       |
| `#list`          | list your files                        | One folder listing of the bot's workspace.                                                                                            | any bot       |
| `#write`         | write a note                           | One file write in the bot's workspace (notes/scratch.md).                                                                             | any bot       |
| `#edit`          | edit a note                            | A file write, then an edit of the same file (notes/edit-me.md).                                                                       | any bot       |
| `#remember`      | save this to memory                    | A memory note: a write to the bot's daily memory file (memory/2026-11-17.md).                                                         | any bot       |
| `#search`        | search the web                         | A web search, answered by the scripted model server; nothing leaves the machine.                                                      | any bot       |
| `#sessions`      | list your tasks                        | A look at the bot's sessions (sessions_list).                                                                                         | any bot       |
| `#schedule`      | schedule a reminder                    | Creates a routine, then removes it (automations). Works only in runs started as the gateway's owner; see below.                       | any bot       |
| `#plan`          | show a plan                            | A tool with no kind of its own: a progress card with a finished three-step plan.                                                      | any bot       |
| `#approve`       | run a command I can approve            | Asks to run `ls` in Otto's workspace. The approval offers a reusable rule (allow-always).                                             | Otto          |
| `#approve-once`  | run a command I approve every time     | Asks to run `echo 'Hello from Otto.'` with per-call ask "always": the approval offers no reusable rule.                               | Otto          |
| `#exit-code`     | run a command that fails               | Asks to run `ls missing-folder`, which exits non-zero.                                                                                | Otto          |
| `#exec-timeout`  | run a command that times out           | Asks to run `sleep 5` with a 1 second limit, so it is stopped.                                                                        | Otto          |
| `#sleep [N]`     | run a slow command                     | Asks to run `sleep N` (default 20, at most 120): a slow shell command.                                                                | Otto          |
| `#ask`           | ask me a question                      | One question with options, through the gateway's question tool.                                                                       | any bot       |
| `#ask-many`      | ask me several questions               | Three questions in one card.                                                                                                          | any bot       |
| `#ask-multi`     | let me pick several                    | One multi-select question.                                                                                                            | any bot       |
| `#ask-text`      | ask me to type an answer               | A question meant to be answered in free text (every question also accepts typed text).                                                | any bot       |
| `#reply`         | reply with a note                      | A short note; what a bot answers when the other bot messages it.                                                                      | any bot       |
| `#message`       | message your partner                   | A message to the other bot of the pair, answered in the same call.                                                                    | Marlow or Pip |
| `#message-slow`  | message your slow partner              | A message to the other bot, which takes 15 seconds; the call returns before it answers, and the reply arrives later in the same task. | Marlow or Pip |
| `#message-fail`  | message your failing partner           | A message to the other bot, whose run ends in a model error.                                                                          | Marlow or Pip |
| `#message-ask`   | message your partner who asks          | A message to the other bot, which asks its own user a question before replying.                                                       | Marlow or Pip |
| `#mcp`           | ask the coding agent                   | A call to the stand-in coding agent over MCP; the result carries a link.                                                              | any bot       |
| `#mcp-slow [N]`  | ask the coding agent something slow    | A call to the coding agent that takes N seconds (default 20) to reply.                                                                | any bot       |
| `#mcp-error`     | ask the coding agent to run the checks | A call to the coding agent that returns an error.                                                                                     | any bot       |
| `#mcp-stop`      | start a coding task I can stop         | A call to the coding agent that does not finish for an hour: stop the run mid-call.                                                   | any bot       |
| `#model-error`   | fail with a model error                | The model request fails, so the run ends in an error.                                                                                 | any bot       |

Where it matters which bot you ask:

- **Shell commands** run only for Otto, and only after you approve each one. Every other bot's shell is denied, so `#approve` sent to Pip shows a denied step instead. Otto's scripted model only ever asks for the commands in the table. An approval with "allow always" lets that exact command run in Otto's workspace without asking again, until the instance is started over. [What can run](docs/decisions.md#what-can-run) says exactly what is allowed.
- **Bot-to-bot messages** go only between Marlow and Pip. A bot outside the pair asks Marlow, and the gateway refuses. A message goes to the other bot's main task ("Notes for Pip" in Marlow's list), and a bot may ask its user a question only in a task a person has written in, which the seed's example does.
- **Files** stay in the bot's own workspace: the gateway is configured to refuse file tools outside it.
- **Web search** goes to the scripted model server on loopback, through the gateway's bundled Ollama search provider, and returns three fixed results on the reserved `search.example` domain. Bots are offered only the tools these scenarios use; fetching web pages, the browser, tools that manage the gateway or its installation, and tools that reach the network or another device are switched off for every bot.
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
- `--port`, `--host` and `--data-dir` change where it listens and where it keeps the device identity.

### 3. Run the desktop app

```bash
pnpm desktop
```

This builds and starts the Electron app. The first run downloads the Electron binary. Development builds offer the same **Use the development gateway** button, and pair the same way.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm exec playwright install chromium   # once
pnpm e2e
pnpm scenarios
```

`pnpm scenarios` is the scenario check on an instance of its own. It starts an unseeded named instance, connects with the official gateway client as three paired operators (read and write; plus `operator.approvals`; plus `operator.questions`), triggers every scenario above, and asserts what the gateway emitted: each run's lifecycle, the reasoning and tool events in order, the question cards and their answers, the approval requests with the decisions they offer and their resolution, the bot-to-bot tool results and the recipients' runs, the MCP results, stops, steers and queued messages. Event payloads are checked against the schemas in `@openclaw/gateway-protocol`, and every tool call of every run, with its exact arguments, result and item, and every run's outcome, against the scenario that made it; a run the check does not assert fails it. It also checks that the tools the model is offered are exactly the allowed ones, and fails if a directive has no check. It prints one line per check and resets its instance afterwards, also on Ctrl-C. `pnpm e2e` runs the same checks on its own seeded instance (`e2e/scenarios.spec.ts`). What the checks found about the gateway is in [What the scenario check observed](docs/decisions.md#what-the-scenario-check-observed).

### Without a gateway: the fixture mode and the visual tests

```bash
pnpm fixture   # builds the interface on fixed sample data and serves it on 127.0.0.1:5341
pnpm visual    # screenshot, legibility and behaviour tests against the fixture mode
```

The fixture mode is the real interface fed a fixed state through the same bridge the hosts use. It needs no gateway and makes no request of its own. Pick what it shows from the address: `?scene=` with `main`, `connect`, `connect-error`, `connecting`, `pairing`, `reconnecting`, `reconnecting-unloaded`, `offline`, `offline-long-address`, `catching-up`, `synced`, `sync-pending`, `sync-failed`, `refresh-failed`, `load-failed`, `loading`, `discovery-error`, `discovering`, `empty`, `partial` or `zero-tasks`; `&bot=otto&task=agent:otto:disk-space` to open a task; `&panel=open`; `&theme=dark`. It is a separate build, never part of the desktop app or the web preview.

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
- `apps/desktop`: the Electron app and the web preview host.
- `tools/dev-gateway`: development gateway control and the scripted model server.
- `tools/brand`: the icon generator.
- `docs/decisions.md`: versions, protocol choices and why things are the way they are.

## License

MIT. See [LICENSE](LICENSE).
