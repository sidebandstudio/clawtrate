# Roster (working name)

A desktop and iOS client for OpenClaw. It gives an OpenClaw gateway you already run a bots-first interface: your bots in a sidebar, tasks under each bot, the bot's work beside the conversation, and fine-grained control over each bot.

Open source, MIT licensed. Everything in this repository must be fit to publish: no secrets, no private hostnames or IPs, no personal data, no third-party images or copied assets.

## What we are building

- The bar is the full user flow of Grok Bot, xAI's personal agent app, plus the controls its users say they lack. Those controls are per-bot model and reasoning effort, per-bot tool permissions and approval rules, an editable memory viewer, a choice of which machine a bot works on, and the raw tool calls behind every card.
- `docs/parity.md` is the definition of done. Every flow has a stable id such as `F-012`. Work is done when its flow passes an automated check.
- This is a client. The agent runtime is the user's OpenClaw gateway. Where the gateway lacks something a flow needs, add it as an OpenClaw plugin under `plugins/`.
- Own identity. Match layout and interaction patterns freely. Never use Grok, xAI or OpenClaw names, logos, icons or copied assets as our branding.

## Layout

- `packages/core` holds the gateway connection, device identity, state stores and the mapping from gateway events to view models. No DOM and no Node-only APIs in shared code. The host injects WebSocket, storage and signing, so the same core runs in Electron, Node and Expo.
- `packages/ui` holds React components shared by the desktop app and the web preview.
- `apps/desktop` is the Electron, Vite and React app. The same renderer also runs in a browser through a small Node host, for remote review and self-hosted web use.
- `apps/mobile` is the Expo iOS app. It consumes `packages/core`.
- `plugins/` holds OpenClaw plugins that fill gateway gaps.
- `tools/dev-gateway` starts, seeds and resets the development gateway.
- `docs/research` holds the Grok Bot flow teardown and the gateway capability map.

A builder may change this layout when it has a reason. Record the reason in `docs/decisions.md`.

## Rules

- Develop only against the development gateway: `openclaw --dev`, state in `~/.openclaw-dev`, port 19001. Never run `openclaw` without `--dev` or `--profile`. Never read or write `~/.openclaw`.
- Never copy credentials from another OpenClaw profile. The development gateway uses the scripted fake model provider in `tools/dev-gateway`.
- Build on the official `@openclaw/gateway-client` and `@openclaw/gateway-protocol` packages, pinned to an exact version, tested against the gateway version named in `docs/decisions.md`.
- Request the smallest operator scopes a feature needs. A read-only connection must stay useful.
- Stop only processes you started, by PID. Never kill by process name.
- TypeScript strict. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm e2e` must pass before work is handed over.
- Commits are small and describe the change. No co-author trailers, no "generated with" lines, no tool or agent attribution anywhere.
