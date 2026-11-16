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
- **Scopes.** Only `operator.read`. Everything this slice shows (`agents.list`, `sessions.subscribe`, `sessions.list`, `chat.history`, `sessions.messages.subscribe`) needs only that scope.
- **Capabilities.** `caps` is empty. Live tool events arrive only with `tool-events`, and this slice does not render them, so it does not claim to. Tool calls are shown from history, where the gateway records them in full. Advertise `tool-events` when the live tool view is built.
- **Pairing.** The core waits for `connect.challenge` and signs the v3 device payload through the host's signer. It sends `connect` with the shared gateway token as bootstrap auth. On `PAIRING_REQUIRED` it shows the request id, the gateway's hint and the approve command. It retries every 3 seconds, which keeps the same request id, so the app connects by itself once someone approves. After approval it stores `hello-ok.auth.deviceToken` and stops sending, and stops storing, the bootstrap token.
- **Device tokens are scoped to one gateway URL.** The token store key includes the URL, so a token issued by one gateway is never offered to another.
- **Session list.** `sessions.subscribe` with list parameters gives the subscription and the snapshot in one call, and is re-established after every reconnect. Changes that arrive while the snapshot is in flight trigger a trailing `sessions.list`. `sessions.changed` deltas are merged field by field into cached rows: present fields replace, `null` clears, omitted fields stay. Keyless or unknown events trigger a debounced list refresh. Nothing polls.
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
- `--no-access-token` is accepted only when the development gateway's connection file exists. In that mode the host refuses `connect` to any URL other than the development gateway.
- The development gateway's bootstrap token stays in the host. **Use the development gateway** sends a command, never the token.

## Development gateway

- **Profile.** Every OpenClaw command passes `--dev`, and also sets `OPENCLAW_PROFILE=dev`, `OPENCLAW_STATE_DIR=~/.openclaw-dev`, `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json` and `OPENCLAW_GATEWAY_PORT=19001`. The tool refuses `--profile`. `reset` deletes only `~/.openclaw-dev`, after checking the path.
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

- **Seeding** goes through the real gateway with `openclaw --dev agent --agent <id> --session-key agent:<id>:<task> --message …`. The command waits for the run's terminal outcome. The seeder requires `status: "ok"`, `summary: "completed"`, no abort, a `stop` stop reason and a final text that matches the script exactly. After each task it reads `chat.history` and checks the number of user turns, that every scripted tool call has a result and none failed, and that the session ends on a completed reply. Any mismatch fails the seed. Task titles are set with `sessions.patch` labels. A second `seed` verifies the existing sessions instead of duplicating them.
- **Bots.** Four invented bots: Juniper (research), Otto (home server operations), Marlow (editing) and Pip (planning). Juniper is the gateway's built-in `main` agent, restyled rather than replaced. Every gateway has one, it is the system and heartbeat agent, and deleting it fights the gateway. Each bot gets its own `AGENTS.md` and a generated PNG avatar. The gateway returns the avatar as a data URI in `agents.list`, which a remote browser can render. The scripted tool calls use only `ls`, `read` and `write` inside each bot's workspace.
- **Sandbox config.** In addition to the provider settings above:
  - `gateway.nodes.pairing.autoApproveLocal: false`: loopback devices are approved like any other, so the pairing flow is exercised for real.
  - `tools.exec.mode: "deny"`: global, so every bot inherits it, including bots created later. Without a policy the gateway resolves `security: "full", ask: "off"`. The mode cannot be combined with `security` or `ask` in the same object; the gateway rejects that.
  - `tools.toolSearch: false`: tools are offered directly rather than behind `tool_search` and `tool_call` wrappers. The seeded tools were already offered directly, but later flows such as bot-to-bot messages need it.
  - `memory.search: { enabled: false, provider: "none" }`: memory search sits outside `models` and defaults to hosted embeddings.
  - `discovery.mdns.mode: "off"`, `update.checkOnStart: false` and the memory plugin's dreaming job off.
- **Enforcement.** `start` re-reads the config and refuses to run if any of these guarantees is missing; it asks for a `reset`. `start` and `seed` both read the gateway's effective exec policy with `openclaw --dev approvals get` and fail unless every bot's effective exec security is `deny`. Unit tests cover the generated config.
- **Processes.** `start` records the PIDs it spawned in `tools/dev-gateway/.run/state.json`, which is git-ignored, along with the logs and the connection file. `stop` sends SIGTERM to those PIDs, waits up to 15 seconds, then sends SIGKILL, and does the same for any direct child the gateway left behind. The e2e teardown stops the preview host the same way after 10 seconds, and stops the gateway only if the test started it. Nothing is ever stopped by name.
- **Ports.** Gateway 19001, scripted model 19091, web preview 5310, e2e preview host 5317 (loopback only).

### Checked against the gateway research notes

The research notes (merged separately) recommend four things. This branch does all four:

- exact `2026.10.6` pins;
- `models.mode: "replace"` with `tools.toolSearch: false`;
- an explicit exec policy, here a global `deny`;
- a bounded stop that then kills the PID.

## Brand

- `assets/brand/logo.png` is the only hand-placed brand file. `pnpm brand:icons` (`tools/brand/src/make-icons.ts`) derives everything else from it with a small PNG codec, so no native image dependency is needed. The outputs are the Electron icons (`apps/desktop/resources/icon.png`, `icon-mac.png`, `icon.icns`, `icon.ico`), the favicons, and the in-app mark (`packages/ui/src/assets/logo-mark.png`). `assets/brand/generated.json` records the logo's hash, and a unit test fails when the icons are older than the logo.
- The logo file carries C2PA provenance metadata from the image generator, including that generator's icon. The derived icons are written fresh and carry none of it.
- Accent tokens come from the mark's mint. Dark theme: `--accent` `#3ee6c1` (12.2:1 on `#0b0e14`), hover `#6cf0d3`, text on accent `#04261f`. Light theme, where the raw mint is only 1.6:1 on white: `--accent` `#0a6e5c` (6.2:1 on white), hover `#06624f`, soft fill `#e6f5f0` (accent text on it 5.5:1), indicator line `#0d8f77` (4.0:1, above the 3:1 minimum for non-text).
- Type is Instrument Sans for the interface, Instrument Serif for titles and JetBrains Mono for tool calls. All three are open-licensed and installed from npm, so the app loads no fonts from the network.

## Not done yet

- The work panel is an empty frame for files, plan and raw tool calls.
- The app does not page back through history beyond 200 rows.
- There is no packaged Electron build or installer; `pnpm desktop` runs from source.
- The Expo app has not been started; `apps/mobile` does not exist yet.
