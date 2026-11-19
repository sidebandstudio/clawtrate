# The first screen and the look on this computer

The desktop app's first screen asks "Where does OpenClaw run?" ([`docs/design/setup.md`](../design/setup.md)). "This computer" looks for OpenClaw's gateway on the computer the app runs on and pairs with it read-only after the app's own dialog. On a developer's computer that would find, and could pair with, the OpenClaw you use every day. So the look never sees the real computer from a checkout.

## What must be sandboxed

A run must be sandboxed when any of these holds (`mustSandbox` in [`apps/desktop/src/setup/world.ts`](../../apps/desktop/src/setup/world.ts)):

- the app is not packaged (`pnpm desktop`, `pnpm desktop:dev`);
- any of the variables `CLAWTRATE_E2E_RUN`, `CLAWTRATE_AUTOMATED`, `CLAWTRATE_SCREENSHOT`, `CLAWTRATE_SETUP_SANDBOX`, `VITEST` or `CI` is present at all, an empty value included;
- the app was started with any of the switches `--remote-debugging-port`, `--remote-debugging-pipe`, `--inspect`, `--inspect-brk` or `--clawtrate-setup-sandbox`.

The web preview always counts as sandboxed when it is started with `--setup-look`.

A packaged app started with none of these is a person's app, and it looks at the real computer. Nothing can tell a packaged app driven by other automation from one a person opened. So **nothing may automate a packaged app without the sandbox switch**. `pnpm check:packaged` gives it one on every launch, the second launch included, and `test/sandboxed-launches.test.ts` checks that it does.

A run that must be sandboxed and was given no sandbox refuses the real computer and says so in its output. It then looks at an empty world, with no program, no profile and no home, and shows "Clawtrate didn't find OpenClaw here" on every machine. A sandbox that would reach the real computer is refused outright, with "Looking on this computer is off here" and the reason.

## A sandbox

A sandbox is a small JSON file in the system's temporary folder, with four absolute paths and a name:

```json
{
  "home": "/tmp/clawtrate-sandbox-…/home",
  "openclaw": "/tmp/clawtrate-sandbox-…/bin/openclaw",
  "instance": "look",
  "stateDir": "<your home folder>/.openclaw-clawtrate-dev-look"
}
```

The guard refuses, before any program starts, each of these:

- A file outside the temporary folder, a link, or one whose values don't have their shape.
- A home that is your home folder, above it or inside it. The same goes for the programs' `HOME` and their working folder.
- The default profile, or any profile but `clawtrate-dev-<instance>`. The default development instance and `preview-accounts` are never accepted.
- A state folder that is, or reaches through a link, your default `~/.openclaw`, compared with links resolved on both sides. A state folder whose `openclaw.json` is a link.
- A program inside the default state, or reached through a link into it.
- **A program that isn't the repository's stand-in for `openclaw`.**
- Before a code is made, any port but the instance's own gateway port, as `pnpm dev-gateway start` recorded it. OpenClaw's default port 18789 is never accepted.

### Why a stand-in

OpenClaw's own `gateway status --json` lists your whole launchd job list (`launchctl list`) and inspects other `ai.openclaw.*` jobs in it. It also chooses the address it probes itself, from the service's arguments, its environment or its config, whatever home and state folder it is given. `--deep` also reads the system's LaunchAgent and LaunchDaemon folders. So in a sandbox the look never runs the real program for status, and never runs the deep status at all.

Its program is [`e2e/openclaw-stand-in.ts`](../../e2e/openclaw-stand-in.ts). It answers `gateway status --json` from the instance's recorded facts: its marker's port, its config's bind, whether that port listens, and whether `/healthz` answers on it. It runs the real `openclaw` only for `--version`, `config get gateway.auth.mode --json` and `qr --json --voice-node --url ws://127.0.0.1:<that port>`, with `--profile clawtrate-dev-<instance>`, and it refuses everything else. What the real program prints for status is covered by recorded outputs in the unit tests.

## Running the first screen against a development instance

Start an instance with local pairing at the gateway's own default, so that Connect pairs silently, as it does on a person's computer:

```bash
pnpm dev-gateway start --instance look --default-local-pairing
```

Write a sandbox for it; this prints the sandbox file's path:

```bash
node e2e/setup-sandbox.ts --instance look
```

Start the desktop app with it:

```bash
CLAWTRATE_SETUP_SANDBOX=<that path> pnpm desktop
```

"This computer" finds the instance and names its version, profile, how it listens and its service ("None registered"). Connect opens the app's dialog before anything is made. Without `--default-local-pairing` the instance asks before every device, and Connect ends on the pairing screen with `pnpm dev-gateway approve --instance look`.

You can see other results by changing the sandbox:

- an `openclaw` that doesn't exist gives "not found";
- an empty `.openclaw` folder in its home, with no program, gives "set up, program missing";
- a stopped instance (`pnpm dev-gateway stop --instance look`) gives "installed but not running";
- a folder `.openclaw-work` in its home is named as another profile and not used;
- `"version"` in the stand-in's facts file (`stand-in.json` beside the sandbox) gives another version.

The web preview shows the same screens, without pairing:

```bash
pnpm preview:web --setup-look --setup-sandbox <that path>
```

Reset the instance when you are done: `pnpm dev-gateway reset --instance look`.

## The fixture

`pnpm fixture` serves every state on fixed data, with no host and no gateway: `?setup=first`, `looking`, `found`, `found-paired`, `untested`, `stopped`, `cant-run`, `endpoint`, `not-found`, `connecting`, `code-failed`, `bots` and the others listed in [`apps/desktop/src/fixture/setup.ts`](../../apps/desktop/src/fixture/setup.ts). The visual tests take their baselines from these.

## The checks

- `apps/desktop/test/setup-look.test.ts` runs the look on recorded outputs of OpenClaw 2026.10.6, with every command checked against the runner's exact list. It also proves each of the guard's refusals with a case that only that check catches.
- `apps/desktop/test/setup-connect.test.ts` runs Connect with a fake `openclaw` and the core's fake gateway:
  - the dialog comes first, in the words that are true for this device;
  - the facts are checked again after the dialog, and the code is used once;
  - the code reaches none of the places it must never go;
  - a cancel starts nothing more;
  - the runner's exact commands, working folder and kill after a grace hold.
- `apps/desktop/test/setup-stand-in.test.ts` runs the stand-in with a fake real program and a local health server.
- `packages/core/test/setup-token-gate.test.ts` covers the core's part:
  - the first token is written only for exactly read;
  - a later grant is held to what was asked;
  - nothing the gateway echoes reaches state or a log.
- `e2e/setup.spec.ts` starts an instance of its own, `e2e-<run>-setup`, with `--default-local-pairing`, and records it before it starts. It drives the development build of the desktop app against that instance through sandboxes with the stand-in. It needs Electron's binary and a display.
- `pnpm check:packaged` gives the packaged app a sandbox with the stand-in for the run's instance on every launch. It checks that the look sees that instance only.
