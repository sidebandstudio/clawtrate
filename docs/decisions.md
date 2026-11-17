# Decisions

Each entry gives the decision, the reason, and what a later builder should know.

## Versions

| Component                       | Version                     | Notes                                                                                                                                                                                                                                                                       |
| ------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw gateway tested against | 2026.10.6 (build `fe06181`) | `hello-ok.server.version` reports `2026.10.6`.                                                                                                                                                                                                                              |
| `@openclaw/gateway-client`      | 2026.10.6, exact pin        | Same release train as the gateway.                                                                                                                                                                                                                                          |
| `@openclaw/gateway-protocol`    | 2026.10.6, exact pin        | The client depends on this exact version.                                                                                                                                                                                                                                   |
| Wire protocol                   | 4                           | Sent as `minProtocol: 4, maxProtocol: 4`; the gateway answers `protocol: 4`.                                                                                                                                                                                                |
| Node.js                         | 26                          | The tools and the web host run TypeScript directly with Node's type stripping.                                                                                                                                                                                              |
| TypeScript                      | 6.0.3                       | typescript-eslint 8.72 supports TypeScript below 6.1, so TypeScript 7 is not used yet.                                                                                                                                                                                      |
| Electron                        | 45.3.2                      | 45.3.3 was younger than pnpm's minimum release age when this was set up. pnpm 11 fails installs whose build scripts are unreviewed, so `pnpm-workspace.yaml` declines Electron's with `allowBuilds: electron: false`; Electron downloads its binary the first time it runs. |

The client packages from 2026.11.x also report protocol 4. The gateway research notes found that they send request fields gateway 2026.10.6 rejects as "unexpected property"; this branch did not test them. Upgrade the packages and the gateway together, and retest `pnpm e2e`.

## Connecting to the gateway

- **Client identity.** `connect` sends `client.id: "gateway-client"` and `client.mode: "ui"`, with a `displayName` of "Clawtrate Desktop" or "Clawtrate Web". The gateway accepts only ids from its registry, and the other ids name OpenClaw's own products. `gateway-client` with mode `backend` is a reserved trust path for internal helpers, so we use mode `ui`.
- **Scopes.** Every `connect` requests exactly `operator.read`, including reconnects with a stored device token. Everything this slice shows (`agents.list`, `sessions.subscribe`, `sessions.list`, `chat.history`, `sessions.messages.subscribe`) needs only that scope. The pinned device-auth lifecycle would otherwise reuse a stored token's granted scopes as the request, so the token store reports the requested scopes to it and keeps the grant in a separate `grantedScopes` field, and the client refuses to send a plan whose scopes differ.
- **Capabilities.** `caps` is empty. Live tool events arrive only with `tool-events`, and this slice does not render them, so it does not claim to. Tool calls are shown from history, where the gateway records them in full. Advertise `tool-events` when the live tool view is built.
- **Pairing.** The core waits for `connect.challenge` and signs the v3 device payload through the host's signer. It sends `connect` with the shared gateway token as bootstrap auth. On `PAIRING_REQUIRED` it shows the request id and an approve command chosen by the host: `pnpm dev-gateway approve` for the development gateway, otherwise `openclaw devices approve <requestId>` with a line saying the gateway's owner runs it on the gateway's machine. An unqualified `openclaw` command is never shown for the development gateway, because it would address the default profile. It retries every 3 seconds, which keeps the same request id, so the app connects by itself once someone approves. After approval it stores `hello-ok.auth.deviceToken` and stops sending, and stops storing, the bootstrap token.
- **Device tokens are scoped to one gateway URL.** The token store key includes the URL, so a token issued by one gateway is never offered to another.
- **Session list.** `sessions.subscribe` with list parameters gives the subscription and the snapshot in one call, and is re-established after every reconnect. The list is read in pages of 200 (`hasMore`, `nextOffset`) until the gateway reports no more, up to 50 pages; reaching that ceiling sets `discovery.partial` and the task list says so. Changes that arrive while the snapshot is in flight trigger a trailing re-read. `sessions.changed` deltas are merged field by field into cached rows: present fields replace, `null` clears, omitted fields stay. Event rows follow the same membership rules as the list query (`excludeCron`, `excludeSubagents`, archived), mirrored from the gateway's own filter: a known row that stops qualifying is dropped, and an unknown row is never inserted from an event, because its payload cannot prove membership; the filtered list is re-read instead. Nothing polls.
- **Discovery.** After hello, bots and tasks load independently. A failed read sets `discovery.status: "error"` with a message, keeps whatever loaded before, and the status strip offers a retry, which reloads without reconnecting.
- **Reconnecting.** Once a connection has reached hello, every later drop and failed attempt is `reconnecting`, never `connecting`, and reopening the same gateway keeps the cached bots, tasks and transcripts. The interface keeps the shell mounted whenever it has data.
- **Viewers.** The host keeps one client; each Electron window and each browser tab gets its own bridge session. Transcripts are reference-counted across sessions, so one viewer closing a task does not close it for another, and a closed tab releases what it held.
- **Transcripts.** Opening a task subscribes with `sessions.messages.subscribe` and reads `chat.history` (200 rows). `session.message` and terminal `chat` events reload history. Streaming `chat` deltas show the run's live text through the client package's `GatewayChatStreamProjection`. Earlier pages (`hasMore`) are not loaded yet.

## Core layout

- Core builds on `@openclaw/gateway-client/browser` (`GatewayProtocolClient` and `GatewayBrowserDeviceAuthLifecycle`), not on the Node `GatewayClient`. The browser entry takes an injected socket and uses no Node built-ins, so it can run in Electron, Node and Expo.
- The host passes in a WebSocket factory, a key/value store, a device signer and its client identity (`packages/core/src/host.ts`). The only globals core uses are `setTimeout`, `clearTimeout` and `URL`, declared in `src/globals.d.ts`.
- The Node implementations live behind a separate entry point, `@clawtrate/core/node`, instead of a separate package. They are a JSON file store, an Ed25519 key in a 0600 PEM file, and the built-in WebSocket. Electron's main process and the web host share them. ESLint stops shared core code from importing `node:*` or using Node and DOM globals.
- Hosts and the renderer talk through one bridge contract (`packages/core/src/bridge.ts`). The host pushes whole state snapshots, coalesced to one per 16 ms. The renderer sends a few validated commands. Selection lives in the renderer.

## Apps

- `apps/desktop` holds the Electron main process, the preload script, the renderer entry and the web host. The interface itself is in `packages/ui`, so the desktop renderer and the browser load the same components.
- Electron runs with `contextIsolation` and `sandbox` on. The preload script is CommonJS because sandboxed preloads must be, and it exposes three functions. The window never navigates, and links open in the system browser.
- `CLAWTRATE_SCREENSHOT=<path>` makes Electron render offscreen, save a PNG and quit. It is there so the app can be checked on a machine nobody is looking at.

## Web preview host

- The host binds `0.0.0.0:5310` by default and keeps the gateway connection, the device key and pairing in Node. Browsers on other machines usually reach it over plain `http`, which is not a secure context, so signing could not happen in the browser anyway.
- Access token: 24 random bytes, generated at each start and printed once. A request carrying the valid token gets a `HttpOnly; SameSite=Strict` cookie and a redirect that removes the token from the URL. Every asset request and the `/bridge` WebSocket need the cookie. The WebSocket also checks that `Origin` matches `Host`. Comparisons are constant time. Static files are confined to the build directory.
- The development endpoint is the fixed `ws://127.0.0.1:19001`. The dev tooling's connection file supplies only its token; a file naming any other URL is ignored.
- `--no-access-token` is accepted only when that file exists. The client is then told to open nothing but the development endpoint, checked before every connection, saved, typed or retried. If the host's data directory remembers another gateway, the host refuses to start rather than resume it without a token.
- Unauthenticated upgrade requests are untrusted input: a malformed cookie is an invalid credential, and any parsing failure is answered with 400 or 401 instead of reaching the process.
- The development gateway's bootstrap token stays in the host. **Use the development gateway** sends a command, never the token.

## Development gateway

- **Profile.** Every OpenClaw command passes `--dev`, and also sets `OPENCLAW_PROFILE=dev`, `OPENCLAW_STATE_DIR=~/.openclaw-dev`, `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json` and `OPENCLAW_GATEWAY_PORT=19001`. The tool refuses `--profile`. `reset` deletes only `~/.openclaw-dev`, after checking the path.
- **State is never reused.** OpenClaw loads a profile's own `.env` and auth stores at startup, after the environment allowlist has been applied, and keeps credentials in SQLite stores (`agents/<agent>/agent/openclaw-agent.sqlite`, `state/openclaw.sqlite`) that a clean profile also has with empty tables. No inspection of an old folder could prove it clean, so there is one way to start the gateway: `start` (and its alias `up`) stops the gateway the tool started, deletes `~/.openclaw-dev`, creates it again empty with a `.clawtrate-dev-gateway` marker holding a new random run id, then configures, starts and seeds. The folder counts as the tool's own only if, checked without following links, the path is a real directory and the marker is a regular file written by the tool. Anything else is refused untouched; the tool never deletes a folder it does not own. `reset` deletes only the tool's own folder.
- **One boundary for OpenClaw.** Every `openclaw` subprocess, including the health check behind `status`, `seed` and `approve`, goes through one runner in `tools/dev-gateway/src/env.ts`. Before spawning it checks that the state folder is the tool's own and either was created by the start in progress or belongs to the gateway recorded at start, in both the marker and the run file, which must still be running. Otherwise it reports why and spawns nothing. OpenClaw always runs with the state folder as its working directory, so no `.env` in the caller's directory is read.
- **Environment.** OpenClaw and the scripted provider run with an allowlist: `PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `TZ` and `USER`, plus `HOME` and the dev profile variables. Everything else is dropped, including provider keys, auth tokens, base URLs and `NODE_OPTIONS`. A unit test checks this against a shell that sets them.
- **The scripted model** (`tools/dev-gateway/src/fake-provider.ts`) speaks the OpenAI Chat Completions streaming API on `127.0.0.1:19091`. It is registered as a custom provider:

  ```json
  "models": {
    "mode": "replace",
    "providers": {
      "scripted": {
        "baseUrl": "http://127.0.0.1:19091/v1",
        "api": "openai-completions",
        "apiKey": "scripted-dev-provider",
        "models": [{ "id": "dev-1", "reasoning": true, "input": ["text"], "contextWindow": 128000, "maxTokens": 8192 }]
      }
    }
  },
  "agents": { "defaults": { "model": { "primary": "scripted/dev-1" }, "thinkingDefault": "low" } }
  ```

  `models.mode: "replace"` keeps bundled and discovered providers out. The `apiKey` is a placeholder; the scripted server ignores it. Reasoning is streamed as `reasoning_content` deltas, which the `openai-completions` adapter shows only when thinking is not `off`, so seeded turns use `--thinking low`. Tool calls are standard streamed `tool_calls`. Replies are chosen by the user's prompt and the number of rounds since it, so the same conversation always produces the same output. The gateway prefixes user text with a timestamp and sometimes appends a runtime block; the planner strips both before matching.

- **Seeding** goes through the real gateway with `openclaw --dev agent --agent <id> --session-key agent:<id>:<task> --message …`. The command waits for the run's terminal outcome. The seeder requires `status: "ok"`, `summary: "completed"`, no abort, a `stop` stop reason and a final text that matches the script exactly. After each task it reads `chat.history` and checks the number of user turns, that every scripted tool call has a result and none failed, and that the session ends on a completed reply. Any mismatch fails the seed. Task titles are set with `sessions.patch` labels. Every start seeds its new gateway; running `seed` again verifies the existing sessions instead of duplicating them.
- **Bots.** Four invented bots: Juniper (research), Otto (home server operations), Marlow (editing) and Pip (planning). Juniper is the gateway's built-in `main` agent, restyled rather than replaced. Every gateway has one, it is the system and heartbeat agent, and deleting it fights the gateway. Each bot gets its own `AGENTS.md`; the interface draws its avatar as a character. The scripted tool calls use only `ls`, `read` and `write` inside each bot's workspace.
- **Sandbox config.** In addition to the provider settings above:
  - `gateway.nodes.pairing.autoApproveLocal: false`: loopback devices are approved like any other, so the pairing flow is exercised for real.
  - `tools.exec.mode: "deny"`: global, so every bot inherits it, including bots created later. Without a policy the gateway resolves `security: "full", ask: "off"`. The mode cannot be combined with `security` or `ask` in the same object; the gateway rejects that.
  - `tools.toolSearch: false`: tools are offered directly rather than behind `tool_search` and `tool_call` wrappers. The seeded tools were already offered directly, but later flows such as bot-to-bot messages need it.
  - `memory.search: { enabled: false, provider: "none" }`: memory search sits outside `models` and defaults to hosted embeddings.
  - `discovery.mdns.mode: "off"`, `update.checkOnStart: false` and the memory plugin's dreaming job off.
- **Enforcement.** `start` writes the config fresh and refuses to run if any of these guarantees is missing. `start` and `seed` both read the gateway's effective exec policy with `openclaw --dev approvals get` and fail unless every bot's effective exec security is `deny`. Unit tests cover the generated config.
- **Processes.** `start` records its run id and the PIDs it spawned in `tools/dev-gateway/.run/state.json`, which is git-ignored, along with the logs and the connection file, and the same run id and PIDs in the state folder's marker. `stop` sends SIGTERM to those PIDs, waits up to 15 seconds, then sends SIGKILL, and does the same for any direct child the gateway left behind. The e2e teardown stops the preview host the same way after 10 seconds, and stops the gateway only if the test started it. Nothing is ever stopped by name.
- **Ports.** Gateway 19001, scripted model 19091, web preview 5310, e2e preview host 5317 (loopback only), fixture mode 5341 (loopback only).

### Checked against the gateway research notes

The research notes (merged separately) recommend four things. This branch does all four:

- exact `2026.10.6` pins;
- `models.mode: "replace"` with `tools.toolSearch: false`;
- an explicit exec policy, here a global `deny`;
- a bounded stop that then kills the PID.

## Brand

- `assets/brand/logo.png` is the only hand-placed brand file. `pnpm brand:icons` (`tools/brand/src/make-icons.ts`) derives everything else from it with a small PNG codec, so no native image dependency is needed. The outputs are the Electron icons (`apps/desktop/resources/icon.png`, `icon-mac.png`, `icon.icns`, `icon.ico`), the favicons, and the in-app mark (`packages/ui/src/assets/logo-mark.png`). `assets/brand/generated.json` records the logo's hash, and a unit test fails when the icons are older than the logo.
- The logo must not carry provenance, text or camera metadata (`caBX`, `tEXt`, `iTXt`, `zTXt`, `eXIf` chunks). `pnpm brand:strip` removes them in place and copies every other chunk byte for byte, so the pixels do not change. `pnpm brand:icons` refuses a logo that still has them, and a unit test checks the committed file.
- Accent tokens come from the mark's mint. Dark theme: `--accent` `#3ee6c1`, hover `#6cf0d3`, text on accent `#04261f`. Light theme, where the raw mint is only 1.6:1 on white: `--accent` `#0a6e5c` (6.2:1 on white), hover `#06624f`, indicator line `#0d8f77` (above the 3:1 minimum for non-text).
- **Palette.** The chrome is neutral grey with no tint (`docs/design/visual-language.md`, section 2): two surfaces, the rail and the stage, and one raised fill for bubbles and cards. Selection and primary buttons are neutral too. The accent appears only on your own bubbles (`--bubble-user`, its own token so it can later be switched to neutral), on unread dots, on a working mark, on focus rings and on links. Colour otherwise belongs to the bots' avatars.
- **Avatars.** A bot without a picture is drawn as a character, a flat body and colour with a dark visor, chosen from a stable hash of its id (`packages/ui/src/Avatar.tsx`), so it looks the same on every device. A bot whose gateway identity has a picture shows the picture cropped to a circle. The development gateway no longer generates pattern pictures for its seed bots, so the preview shows characters.
- **Where the mark appears.** Inside the app the mark appears only on the connection and pairing screens, at 56 px. The rail has no product name.
- **Type.** One family, Figtree (`@fontsource-variable/figtree` 5.3.0), in two weights, with JetBrains Mono (`@fontsource-variable/jetbrains-mono` 5.3.0) for code. Both are under the SIL Open Font License 1.1, which allows bundling them in an MIT app as long as the fonts are not sold alone and their notice travels with them; the font packages carry it. The bundler includes the fonts from the packages, so the app loads no fonts from the network and no font file is committed. Instrument Sans and Instrument Serif are removed.

## Interface: the visual language

The shell follows `docs/design/visual-language.md`, built in the order of its section 14. What a later builder should know:

- **One test for each layout switch, shared with the stylesheet.** `packages/ui/src/layout.ts` holds the two widths: one pane below 688 px of `.app`, and Work docked from 960 px of `.main-pane`. The stylesheet's container queries use the same numbers, and the code measures the same elements with a `ResizeObserver`, so the layout and the behaviour that depends on it (the drawer's dialog role, focus, `inert`) cannot disagree.
- **Selection.** `packages/ui/src/selection.ts` keeps the selected bot, the remembered task for each bot (it wins over the most recent), the bots unfolded by hand and whether the open bot was folded by hand; the last two persist. A bot's row summarises all of its tasks with three independent signals (latest activity, unread, run state, failed before working).
- **May this connection write?** `canWrite` in `packages/ui/src/access.ts` returns false: the client asks for `operator.read` and the bridge has no command that writes. Nothing that creates or sends is rendered; the composer is the read-only pill.
- **The strip.** `packages/ui/src/StatusStrip.tsx` derives every state from what the shell already has. After a connection problem the shell is "dropped" until bots, tasks and the open task have loaded again, then "Synced" shows for four seconds. "Try again" for one task sends `closeSession` and then `openSession`.
- **Following the end of a transcript.** The view follows new output while the reader is at the end. A scroll the reader did not make, such as content growing when fonts arrive, keeps following; only the reader moving up stops it. Width changes keep the first item in view in place.

Where the build departs from the specification, and why:

- **Task rows show no time.** The specification gives a task row its title and at most one mark, with the time in the accessible description; the prototype's screenshots show a time on each row. The specification was followed, so long titles have the row's full width. `F-425` asks for the time in the row; it is in the row's description and in Details, not visible.
- **The title pill opens Work and does not close it**, as the specification says; the panel button toggles. Its name always ends "Show details."
- **A failed discovery in the strip** reads "Could not load this gateway's bots and tasks", with the gateway's message as the explanation after the dot. The gateway's message alone can be long, and the first part of the strip never shortens.
- **A task with no messages** says "Messages between you and <Bot> in this task will appear here." The specification's "Say what you need" invites typing, which a read-only connection cannot do.
- **The development gateway's hint** ("127.0.0.1:19001, started with `pnpm dev-gateway up`") moved into the button's tooltip, so the connect screen has the one hint the design gives it.
- **A connection error** is titled "Could not connect"; the error's code stays visible, small, under the sentence, for support.
- **System messages** are centred event lines outside `.turn`, as before, so `transcript-turn` still counts user and assistant items only.
- **The gateway's name** is its address (host and port): the gateway does not report a name.
- **The task-title tooltip** shows on any focus, not only keyboard focus, so a test can focus a row and see it.
- **Pins, sections, search, "+" and New task** are not rendered (section 14 says so). The `.pin*` and `.rail-section` rules, the composer's field and send button and the extra state marks were not brought over, and the rail's top is a 12 px drag band (40 px in the macOS app).

## Fixture mode and visual tests

- **Fixture mode.** `apps/desktop/src/fixture/` is a separate Vite entry (`apps/desktop/vite.fixture.config.ts`, output `out/fixture`) that renders the shared `App` through a `ClawtrateBridge` holding fixed state: five bots (one with a picture, one with one task, one with fourteen, a long name), a long transcript with reasoning and tool calls in every state, and scenes for pairing, reconnecting, catching up, synced, a task that failed to sync or load, an empty gateway and more. It cannot reach a packaged app: neither the Electron build nor the web preview's build refers to it, and `apps/desktop/test/fixture-isolation.test.ts` fails if one does. Its page sets `connect-src 'none'`, and a visual test checks that it requests nothing but its own files. `pnpm fixture` serves it on `127.0.0.1:5341`.
- **Visual tests.** `pnpm visual` (`playwright.visual.config.ts`, tests in `visual/`) builds and serves the fixture and runs three things: screenshots of the connect, pairing and main views, Work closed and open, in light and dark at 1440, 1100 and 800 px and at phone width (390 × 844 with a touch pointer), plus the phone's bot list; a legibility audit over fourteen states in both themes at 1440 px and phone width that measures every rendered text node's size (at least 12 px) and its contrast against its composited background (at least 4.5:1), skipping only what is inert behind the drawer's scrim; and behaviour checks for the rail, the Work pane, the strip and the phone. The clock is fixed and the time zone is America/New_York, so times are stable.
- **Tolerance.** A pixel differs when its colour moves more than Playwright's 0.2 threshold; a screenshot passes with at most 0.2% of pixels different. Animations are stopped and the caret hidden.
- **The baselines are specific to macOS.** Font rasterising differs between operating systems, so the baselines live under `visual/baselines/darwin/` and only that platform can compare against them. They are not part of the CI workflow. They were approved by the builder's own review, not yet by the owner.

## Not done yet

- The Work pane shows the task's details; its Files and Computer tabs are empty states until those flows exist.
- Read and unread is tracked per viewer in local storage. Marking a task read on the gateway needs a write scope.
- The app does not page back through history beyond 200 rows.
- There is no packaged Electron build or installer; `pnpm desktop` runs from source.
- The Expo app has not been started; `apps/mobile` does not exist yet.
