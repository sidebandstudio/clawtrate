<p align="center">
  <img src="assets/brand/logo.png" width="112" height="112" alt="Clawtrate logo">
</p>

# Clawtrate

Your OpenClaw agents, orchestrated.

Clawtrate is a free, open-source desktop app for [OpenClaw](https://github.com/openclaw/openclaw). It connects to a gateway you already run and puts your bots in a sidebar, with tasks under each bot, the conversation in the middle and the bot's work beside it. A run's actions sit behind one line under the reply and open to plain-words cards, while approvals, questions and messages to other bots stay in view.

Clawtrate is an independent project and is not affiliated with OpenClaw.

## Install the Mac beta

Clawtrate is in beta on macOS 13 or later, for Apple silicon and Intel. Builds are signed with a Developer ID and notarized by Apple. Download it from [clawtrate.dev](https://clawtrate.dev), or install from Terminal:

```bash
brew install --cask sidebandstudio/tap/clawtrate
```

Or use the installer script:

```bash
curl -fsSL https://clawtrate.dev/install.sh | sh
```

This beta connects to an OpenClaw gateway you already run. Choose **Advanced**, enter your gateway's address and token, and approve the device if the gateway asks. If you are new to OpenClaw, [install OpenClaw](https://docs.openclaw.ai/install) first. You bring your own gateway and model provider. In Settings, check for Beta updates to download verified builds and restart into them.

Windows builds are not published yet. The iPhone app is in development in `apps/mobile` and has no release yet.

## What works today

- Connect to an OpenClaw gateway you already run, through Advanced with its address and token.
- See your bots with their avatars and unread activity.
- Start, rename, pin, archive and delete tasks under each bot.
- Send messages, watch replies stream in, and ask the gateway to steer or stop a run.
- Open a run's actions from one line under the reply as plain-words cards, while approvals, questions and messages to other bots stay in view. Turn on commands and raw calls in Settings, Advanced.
- Answer approvals and questions in place.
- Read cards for bot-to-bot messages and for T3 Code calls that the gateway reports.
- Browse a task's files in the Work pane beside the conversation.
- Create a bot on an available provider account. Sign-ins stay on the gateway, and Clawtrate never sees the credentials.
- Read and edit a bot's root memory.
- Track per-bot usage with weekly budget warnings.
- View, create, edit, pause and run routines, with run history and a week calendar.
- Choose where each bot runs commands.
- Watch a gateway in read-only mode.
- Run the same interface from a checkout as a desktop app on macOS and Windows, or in a browser through the web preview host.

## Where it is going

Work in progress, not yet in the beta:

- Built-in OpenClaw setup, and pairing with OpenClaw on the same Mac without typing a token.
- Connecting to another computer over SSH in read-only mode.
- Per-bot tool permissions (allow, ask or never).
- A model and reasoning effort for each bot and each task.
- Watching a bot's browser and taking control. Its plugin only runs on development gateways so far.
- The iPhone app.
- Plans for notifications, search and voice.

The plan is in [docs/roadmap.md](docs/roadmap.md), and every part of it has an issue.

## Run from a checkout

You need Node.js 26, pnpm 11 and the OpenClaw CLI, version 2026.10.6.

```bash
pnpm install
pnpm dev-gateway start   # a throwaway gateway with a scripted model and four sample bots
pnpm preview:web         # serves the interface and prints a link with an access token
```

Open the link, choose **Use the development gateway**, and approve the pairing:

```bash
pnpm dev-gateway approve
```

`pnpm desktop` starts the Electron app instead. The development gateway keeps its state in a folder of its own and answers with a scripted model, so it never touches a gateway you use or any model provider account. [docs/development](docs/development/README.md) explains the rest.

## How it works

OpenClaw runs the bots, and Clawtrate is only the client. A host process holds the gateway connection and the device key. On the desktop that host is Electron's main process, and for a browser it is the web preview host. The interface never talks to the gateway. It reads state snapshots from the host and sends it commands. Where the gateway is missing something a feature needs, the project adds an OpenClaw plugin under `plugins/`. [docs/architecture.md](docs/architecture.md) goes through the pieces.

## Documentation

| Read                                           | For                                                      |
| ---------------------------------------------- | -------------------------------------------------------- |
| [docs/development](docs/development/README.md) | Running, testing and packaging Clawtrate from a checkout |
| [docs/architecture.md](docs/architecture.md)   | How the pieces fit together                              |
| [docs/roadmap.md](docs/roadmap.md)             | What is left to build, and who has each part             |
| [docs/parity.md](docs/parity.md)               | The definition of done, one checked behavior per row     |
| [docs/decisions.md](docs/decisions.md)         | Why things are the way they are                          |
| [docs/README.md](docs/README.md)               | Every document in the repository                         |

## Contributing

Clawtrate is built in the open, and help is welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to pick something up without colliding with work in progress. Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

## License

MIT. See [LICENSE](LICENSE).
