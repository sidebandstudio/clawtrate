# Clawtrate

Your OpenClaw agents, orchestrated.

A desktop and iOS client for OpenClaw. It gives an OpenClaw gateway you already run a bots-first interface: your bots in a sidebar, tasks under each bot, the bot's work beside the conversation, and fine-grained control over each bot.

Open source, MIT licensed. This repository is public, so every commit is published. Commit no secrets or tokens, no private hostnames or IP addresses, no usernames or home-directory paths, no email addresses, no personal data, and no third-party images or copied assets.

## What we are building

- The bar is the full user flow of Grok Bot, xAI's personal agent app, plus the controls its users say they lack. Those controls are per-bot model and reasoning effort, per-bot tool permissions and approval rules, an editable memory viewer, a choice of which machine a bot works on, and the raw tool calls behind every card.
- `docs/parity.md` is the definition of done. Every flow has a stable id such as `F-012`. Work is done when its flow passes an automated check.
- This is a client. The agent runtime is the user's OpenClaw gateway. Where the gateway lacks something a flow needs, add it as an OpenClaw plugin under `plugins/`.
- Own identity. The name Clawtrate and the slogan "Your OpenClaw agents, orchestrated." are fixed. Saying what Clawtrate works with, including naming OpenClaw, is fine. Match layout and interaction patterns freely. Never use OpenClaw's, Grok's or xAI's logos, icons or copied assets.
- The logo is `assets/brand/logo.png`. App icons, the favicon and the interface's accent color derive from that one file, so it can be swapped in one place.

## Layout

- `packages/core` holds the gateway connection, device identity, state stores and the mapping from gateway events to view models. No DOM and no Node-only APIs in shared code. The host injects WebSocket, storage and signing, so the same core runs in Electron, Node and Expo.
- `packages/ui` holds React components shared by the desktop app and the web preview.
- `apps/desktop` is the Electron, Vite and React app. The same renderer also runs in a browser through a small Node host, for remote review and self-hosted web use.
- `apps/mobile` is the Expo iOS app. It consumes `packages/core`.
- `plugins/` holds OpenClaw plugins that fill gateway gaps.
- `tools/dev-gateway` starts, seeds and resets the development gateway.
- `docs/research` holds the Grok Bot flow teardown and the gateway capability map.

Workspace packages are named under the `@clawtrate` scope, for example `@clawtrate/core`.

A builder may change this layout when it has a reason. Record the reason in `docs/decisions.md`.

## Rules

- Develop only against development gateway instances started by `pnpm dev-gateway`. The default instance is `openclaw --dev`, state in `~/.openclaw-dev`, port 19001. A named instance (`--instance <name>` or `CLAWTRATE_DEV_INSTANCE`) is `openclaw --profile clawtrate-dev-<name>`, state in `~/.openclaw-clawtrate-dev-<name>`, on free ports the tool chooses and records. Use a named instance when another checkout may be running the default one. `pnpm e2e` always creates its own instance. Never run `openclaw` without `--dev` or `--profile clawtrate-dev-<name>`, never against the default profile, and never read or write `~/.openclaw`.
- Never copy credentials from another OpenClaw profile. The development gateway uses the scripted fake model provider in `tools/dev-gateway`.
- Build on the official `@openclaw/gateway-client` and `@openclaw/gateway-protocol` packages, pinned to an exact version, tested against the gateway version named in `docs/decisions.md`.
- Request the smallest operator scopes a feature needs. A read-only connection must stay useful.
- Stop only processes you started, by PID. Never kill by process name.
- TypeScript strict. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm e2e` must pass before work is handed over.
- Commits are small and describe the change. No co-author trailers, no "generated with" lines, no tool or agent attribution anywhere.
