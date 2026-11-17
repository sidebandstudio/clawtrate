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
pnpm dev-gateway start
```

This runs `openclaw --dev gateway run` on `ws://127.0.0.1:19001` with its state in `~/.openclaw-dev`, so it never touches a gateway you use day to day. It talks only to a scripted model server on `127.0.0.1:19091`; no model provider account is used. It then seeds four sample bots with their own instructions and avatars, and eleven conversations with reasoning and tool calls. Each seeded run is checked against its script. `pnpm dev-gateway up` does the same.

Every start is a fresh, seeded gateway. It stops the gateway this checkout started before, deletes `~/.openclaw-dev` and creates it again empty. OpenClaw keeps credentials in the same SQLite stores a clean profile has, so the tool never reuses state rather than trying to prove old state clean. If `~/.openclaw-dev` was not created by this tool, or is a symlink, `start` refuses and changes nothing. If its gateway is running and another checkout started it, `start` and `reset` also refuse, say which instance is in use, and change nothing. Because the gateway is new each time, preview hosts and the desktop app pair again after a start.

Other commands: `pnpm dev-gateway status`, `stop`, `seed` (verify the running gateway's seed), `approve`, `reset` (stop, then delete the instance's state folder), `list` and `prune`. Commands that talk to the gateway refuse to run unless the gateway this checkout started on that state is still running.

#### Instances

What is described above is the default instance. One machine can run several development gateways at once, for example a long-lived preview and an end-to-end run in another checkout. Each is an instance, named with `--instance <name>` on any command or with `CLAWTRATE_DEV_INSTANCE`:

```bash
pnpm dev-gateway start --instance review
pnpm dev-gateway approve --instance review
CLAWTRATE_DEV_INSTANCE=review pnpm dev-gateway status
pnpm dev-gateway list       # every instance on this machine, its folder, ports and gateway
pnpm dev-gateway reset --instance review
pnpm dev-gateway prune      # remove named instances nothing is running on
```

A name is 1 to 24 lowercase letters, digits and inner hyphens. The instance runs `openclaw --profile clawtrate-dev-<name>` with its state in `~/.openclaw-clawtrate-dev-<name>`, and `start` picks free ports for its gateway and scripted model between 19200 and 19999 and records them. Every rule above holds per instance: its own fresh folder and marker, its own run files in `tools/dev-gateway/.run/instances/<name>`, and no command for one instance acts on another instance's folder, gateway or processes. `reset` removes only the named instance; `prune` never removes the default one.

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
- `pnpm preview:web --instance <name>` (or `CLAWTRATE_DEV_INSTANCE`) makes both of the above use that instance's gateway instead of the default instance's, as recorded by this checkout's `pnpm dev-gateway start --instance <name>`. The desktop app reads `CLAWTRATE_DEV_INSTANCE` the same way.
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

`pnpm e2e` never uses the default instance or its ports. Each run creates its own instance named `e2e-<random>`, plus an unseeded second instance so another gateway is always listening while it runs. It starts the gateway, its scripted model and a preview host with a fresh device identity on free ports, approves the pairing request the page raises, and checks that the bots, a task list and a transcript render, and that every other running instance is left as it was. Afterwards it stops what it started by PID and removes both instances' state, also when a test fails. Runs in several checkouts, or several in one, can go at the same time.

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
