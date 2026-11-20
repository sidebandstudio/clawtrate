# Contributing

Clawtrate is young and moves fast. A small team builds most of it, a lot of it with coding agents, against a plan that is public down to the last issue. Help is welcome. This page explains how to take part without building something twice or colliding with work that is already under way.

## Where things stand

- There is no release yet. The desktop app runs against a development gateway, and the iOS app is not on `main` yet.
- The plan is [docs/roadmap.md](docs/roadmap.md). It splits the work into milestones, and each piece is an issue.
- The definition of done is [docs/parity.md](docs/parity.md). Each row is one behavior with a stable id such as `F-012`, and a row is done when an automated check whose title starts with that id passes.
- The maintainers merge their own work once its checks pass. Review time for outside pull requests is limited for now, so talk on the issue before you start anything large.

## Picking something to work on

Issues marked `help wanted` are written so that someone new can start from the issue text alone. The first line of every plan issue gives its state. "In progress, maintainers" means someone is on it, so leave it alone. "Waiting" names what it waits on. "Open" means you can take it.

Comment on the issue before you start, with a short plan, and a maintainer assigns it to you. [Taking a segment](docs/roadmap.md#taking-a-segment) in the roadmap lists which files a piece of work owns and which ones it shares, so that two streams of work do not collide.

For a bug, open a bug report. For something new, open an idea first. A pull request for a feature that has no agreed issue may be closed.

## Setup

You need Node.js 26, pnpm 11 and, for anything that talks to a gateway, the OpenClaw CLI (`openclaw`, version 2026.10.6) on your `PATH`.

```bash
pnpm install
pnpm exec playwright install chromium   # once, for the end-to-end and visual tests
pnpm dev-gateway start
pnpm preview:web
```

[docs/development](docs/development/README.md) covers the web preview, the desktop app, the development gateway, the tests and packaging. On Windows, clone with `git clone -c core.autocrlf=false` so that Prettier sees the LF line endings it checks for.

## The development gateway

Develop only against development gateway instances started by `pnpm dev-gateway`. Never run `openclaw` without `--dev` or `--profile clawtrate-dev-<name>`, never against your default profile, and never read or write `~/.openclaw`. If another checkout may be running the default instance on port 19001, use a named instance of your own:

```bash
pnpm dev-gateway start --instance <name>
pnpm dev-gateway reset --instance <name>   # when you are done
```

`pnpm e2e` and `pnpm check:packaged` always create, and remove, their own instances. Never copy credentials from another OpenClaw profile. The development gateway uses a scripted model. Stop only processes you started, by PID.

## Checks

All of these must pass before work is handed over:

```bash
pnpm lint        # ESLint and Prettier
pnpm typecheck
pnpm test        # unit tests
pnpm e2e         # end-to-end tests against a development gateway of their own
pnpm visual      # screenshots and behavior of the fixture mode; the baselines are macOS ones
```

Run `pnpm scenarios` too when you change the development gateway or its scenarios. The visual baselines are only valid on macOS. If you are on another system, say so in the pull request, and CI's macOS job is the check. [Testing](docs/development/testing.md) explains what each check covers and what CI runs.

## Signing and releases

CI packages macOS builds with an ad hoc signature and Windows builds without a signature. The owner runs the packaging scripts with signing credentials for a release. Enabled macOS notarization submits the build to Apple. The owner publishes releases separately. These are the variables, all read at build time only; never commit their values:

- macOS signing: `CSC_LINK` and `CSC_KEY_PASSWORD` (set empty for a certificate without a password), or `CSC_NAME`.
- macOS notarizing, with signing on, one complete set: `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`; or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`; or `APPLE_KEYCHAIN_PROFILE`, optionally with `APPLE_KEYCHAIN`.
- Windows signing: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` (or `CSC_LINK` and `CSC_KEY_PASSWORD` on Windows).
- The update feed: `CLAWTRATE_UPDATE_FEED_URL`, an `https` address such as `https://updates.example/clawtrate/feed.json`, and `SOURCE_DATE_EPOCH`, the build's release date in seconds.

[Packaging](docs/development/packaging.md#signing-and-notarizing) says what each does, and [docs/decisions.md](docs/decisions.md#updates-and-release-signing) what an update verifies.

## Pull requests

One issue, one pull request. Start the body with `Closes #123`, or `Part of #123` when the issue needs more than one pull request. Smaller pull requests merge sooner. Every pull request gets a `size:` label, from XS to XXL, so you can see how big yours is.

`main` gets one squashed commit per pull request, and its whole message is the pull request's title with its number. Write the title for someone reading the history a year from now, who sees nothing else.

The title says what changes for the person using Clawtrate, in plain words and under 72 characters, after a type: `feat`, `fix`, `docs`, `test`, `ci`, `refactor` or `chore`.

| Good                                                      | Not like this                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `feat: watch a bot's browser and take control`            | `fix(core): guard the lease generation in releaseControl`                                           |
| `fix: a stopped run no longer restarts after a reconnect` | `Merge the engine follow-up: Stop on every path, checks that wait on the gateway's own state, and…` |
| `docs: explain how to add a scenario`                     | `Update files`                                                                                      |

Describe the problem in a sentence or two, then explain the change and how you checked it. Use short, plain sentences, and delete the template's comments. Interface changes need before and after screenshots at desktop and phone width.

CodeRabbit reviews every pull request into `main` that is not a draft. Its comments are advice: check each one against the code, fix the real ones, and reply with the reason when one is wrong. Nothing waits on it.

End your pull request with the model and harness that did the work. For example, `AI: gpt-6.2-astra via Codex (T3 Code)` identifies the model and the coding agent that ran it. If several pairs contributed changes, put each on its own line in the final paragraph. If you used no AI, end with `No AI used.` Keep the footer current when someone adds changes. Reviewers must verify it before they approve or merge.

You are responsible for every line you submit. Read the diff before opening the pull request. Keep co-author trailers, "generated with" lines and tool credits out of commit messages and pull request titles.

Keep your branch mergeable. When `main` moves under it and it conflicts, merge `main` into it and run the checks again.

## Publication

The repository is public, so every commit, pull request and issue is published. Commit no secrets or tokens, no private hostnames or IP addresses, no usernames or home-directory paths, no email addresses, no personal data, and no third-party images or copied assets. The same goes for pull request titles and bodies. Commits on your branch are small and describe the change.

## Security

Report security problems privately, as [SECURITY.md](SECURITY.md) describes, and never in a public issue.

## License

Clawtrate is MIT licensed, and so is everything you contribute to it.
