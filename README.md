<p align="center">
  <img src="assets/brand/logo.png" width="112" height="112" alt="Clawtrate logo">
</p>

# Clawtrate

Your OpenClaw agents, orchestrated.

A desktop and iOS client for [OpenClaw](https://github.com/openclaw/openclaw). Clawtrate connects to an OpenClaw gateway you already run and gives it a bots-first interface: your bots in a sidebar, tasks under each bot, the conversation in the middle, and the bot's work beside it.

Clawtrate is an independent project and is not affiliated with OpenClaw or xAI.

Status: early development. This first version is read-only. It pairs with a gateway, lists bots and their tasks, and shows each conversation with its reasoning and tool calls.

## Quickstart

You need Node.js 26, pnpm 11 and the OpenClaw CLI (`openclaw`, version 2026.10.6) on your `PATH`.

```bash
pnpm install
```

### 1. Start the development gateway

```bash
pnpm dev-gateway up
```

This runs `openclaw --dev gateway run` on `ws://127.0.0.1:19001` with its state in `~/.openclaw-dev`, so it never touches a gateway you use day to day. It talks only to a scripted model server on `127.0.0.1:19091`; no model provider account is used. `up` then seeds four sample bots with their own instructions and avatars, and eleven conversations with reasoning and tool calls. Each seeded run is checked against its script.

Other commands: `pnpm dev-gateway status`, `stop`, `seed`, `approve` and `reset` (stop, then delete `~/.openclaw-dev`).

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
- `pnpm preview:web --no-access-token` turns the access token off. It is only accepted with the development gateway, and the host then refuses to connect anywhere else.
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

`pnpm e2e` uses the development gateway. If none is running it starts one, then stops it again afterwards. It also starts a preview host with a fresh device identity, approves the pairing request it raises, and checks that the bots, a task list and a transcript render.

## Logo and icons

The logo is `assets/brand/logo.png`. The desktop icons, the favicons and the mark inside the app are all generated from it:

```bash
pnpm brand:icons
```

To change the logo, replace that one file and run the command. A unit test fails if the generated icons are older than the logo. The interface's accent color is taken from the mark and defined in `packages/ui/src/styles/tokens.css`.

## Repository

- `packages/core`: the gateway connection, device pairing, state stores and the mapping from gateway data to view models. It has no DOM or Node APIs; hosts inject the socket, storage and signing.
- `packages/ui`: the React interface shared by the desktop app and the web preview.
- `apps/desktop`: the Electron app and the web preview host.
- `tools/dev-gateway`: development gateway control and the scripted model server.
- `tools/brand`: the icon generator.
- `docs/decisions.md`: versions, protocol choices and why things are the way they are.

## License

MIT. See [LICENSE](LICENSE).
