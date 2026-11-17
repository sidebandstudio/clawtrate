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

This runs `openclaw --dev gateway run` on `ws://127.0.0.1:19001` with its state in `~/.openclaw-dev`, so it never touches a gateway you use day to day. It talks only to a scripted model server on `127.0.0.1:19091`; no model provider account is used. It then seeds four sample bots, each with its own instructions, and eleven conversations with reasoning and tool calls. Each seeded run is checked against its script. `pnpm dev-gateway up` does the same.

Every start is a fresh, seeded gateway. It stops the gateway the tool started before, deletes `~/.openclaw-dev` and creates it again empty. OpenClaw keeps credentials in the same SQLite stores a clean profile has, so the tool never reuses state rather than trying to prove old state clean. If `~/.openclaw-dev` was not created by this tool, or is a symlink, `start` refuses and changes nothing. Because the gateway is new each time, preview hosts and the desktop app pair again after a start.

Other commands: `pnpm dev-gateway status`, `stop`, `seed` (verify the running gateway's seed), `approve` and `reset` (stop, then delete the tool's own `~/.openclaw-dev`). Commands that talk to the gateway refuse to run unless the gateway this tool started on that state is still running.

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
```

### Without a gateway: the fixture mode and the visual tests

```bash
pnpm fixture   # builds the interface on fixed sample data and serves it on 127.0.0.1:5341
pnpm visual    # screenshot, legibility and behaviour tests against the fixture mode
```

The fixture mode is the real interface fed a fixed state through the same bridge the hosts use. It needs no gateway and makes no request of its own. Pick what it shows from the address: `?scene=` with `main`, `connect`, `connect-error`, `connecting`, `pairing`, `reconnecting`, `offline`, `catching-up`, `synced`, `sync-failed`, `refresh-failed`, `load-failed`, `loading`, `discovery-error`, `discovering`, `empty`, `partial` or `zero-tasks`; `&bot=otto&task=agent:otto:disk-space` to open a task; `&panel=open`; `&theme=dark`. It is a separate build, never part of the desktop app or the web preview.

`pnpm visual` compares screenshots with the baselines in `visual/baselines/`, which are taken on macOS and only valid there. After an intended change, `pnpm visual:update` rewrites them; look at every changed image before committing it.

`pnpm e2e` uses the development gateway. If none is running it starts one, then stops it again afterwards. It also starts a preview host with a fresh device identity, approves the pairing request it raises, and checks that the bots, a task list and a transcript render.

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
