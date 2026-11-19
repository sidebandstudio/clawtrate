<p align="center">
  <img src="assets/brand/logo.png" width="112" height="112" alt="Clawtrate logo">
</p>

# Clawtrate

Your OpenClaw agents, orchestrated.

Clawtrate is a desktop and iOS app for [OpenClaw](https://github.com/openclaw/openclaw). It connects to a gateway you already run and puts your bots in a sidebar, with tasks under each bot, the conversation in the middle and the bot's work beside it. Each thing a bot does shows up as a short card in plain words, and the raw tool call is one click further.

Clawtrate is an independent project and is not affiliated with OpenClaw or xAI.

> [!NOTE]
> Clawtrate is in early development and has no release yet. The desktop app works against a development gateway, and the iOS app is not on `main` yet.

## What works today

- Pair with a gateway as a new device and see every bot, with its picture, its latest activity and what is unread.
- Start, rename, pin, archive and delete tasks under each bot, and arrange the sidebar in sections.
- Send messages, watch the reply stream in, and stop a run.
- Read what a bot did as plain-words cards, and answer its approvals and questions in place.
- See messages between bots, and calls to T3 Code, as cards you can open.
- Browse a task's files in the Work pane beside the conversation.
- Create a bot on the provider account you pick. Sign-ins stay on the gateway, and Clawtrate never sees the credentials.
- Watch a gateway without being able to change anything, in read-only mode.
- Run the same interface as a desktop app on macOS and Windows, or in a browser through the web preview host.

## Where it is going

The next big piece is fine-grained control over each bot: its model and reasoning effort, which tools it may use and when it has to ask, its memory, and which machine it works on. After that come a live view of a bot's browser that you can take over, and the iOS app. The plan is in [docs/roadmap.md](docs/roadmap.md), and every part of it has an issue.

## Try it

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
