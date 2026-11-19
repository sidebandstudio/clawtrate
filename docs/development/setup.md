# The first screen and the look on this computer

The desktop app's first screen asks "Where does OpenClaw run?" ([`docs/design/setup.md`](../design/setup.md)). "This computer" looks for OpenClaw's gateway on the computer the app runs on and pairs with it read-only after the app's own dialog. On a developer's computer that would find, and could pair with, the OpenClaw you use every day. So the look never sees the real computer from a checkout:

- A **development build** (`pnpm desktop`, `pnpm desktop:dev`) and **every automated run** look only in a **sandbox** you give them. Without one, "This computer" shows "Looking on this computer is off here", runs no program, and the app's output says why.
- The **web preview** keeps the address-and-token form as its first screen. `--setup-look` shows the new first screen, and it too looks only in a sandbox. It never pairs: it has no dialog of its own to ask first.
- Only a packaged app that nothing automates looks at the real computer, which is what a person installing Clawtrate gets.

An automated run is one with `CLAWTRATE_E2E_RUN` (set by the Playwright configs), `CLAWTRATE_AUTOMATED`, `CLAWTRATE_SCREENSHOT`, `VITEST` or `CI` in its environment, or an app started with `--remote-debugging-port`, `--remote-debugging-pipe`, `--inspect` or `--clawtrate-setup-sandbox`. The guard is `guardWorld` and `guardPort` in [`apps/desktop/src/setup/world.ts`](../../apps/desktop/src/setup/world.ts).

## A sandbox

A sandbox is a JSON file with four absolute paths and a name:

```json
{
  "home": "/tmp/clawtrate-sandbox/home",
  "openclaw": "/path/to/openclaw",
  "instance": "look",
  "stateDir": "/path/to/home/.openclaw-clawtrate-dev-look"
}
```

- `home` is a folder of its own, never your home folder. The look checks it for `~/.openclaw` and for OpenClaw's service files, lists the other profiles' folders in it by name, and gives it to every program as `HOME`, so OpenClaw's own scan of LaunchAgents sees only what you put there.
- `openclaw` is the program to run, usually what `which openclaw` prints. A path that doesn't exist gives "Clawtrate didn't find OpenClaw here".
- `instance` and `stateDir` are a development instance of your own and its state folder, as `pnpm dev-gateway start --instance <name>` prints them. That instance is the only profile the look asks about, with `--profile clawtrate-dev-<name>`; the default profile is never asked.

The guard refuses a sandbox whose home is your real home folder or contains it, one that would ask the default profile or read its state, and, before a code is made, any port but a named instance's (`19200` to `19999`, never `18789`).

## Running the first screen against a development instance

Start an instance with local pairing at the gateway's own default, so that Connect pairs silently, as it does on a person's computer:

```bash
pnpm dev-gateway start --instance look --default-local-pairing
```

Write a sandbox for it, then start the desktop app with it:

```bash
CLAWTRATE_SETUP_SANDBOX=/tmp/clawtrate-sandbox/sandbox.json pnpm desktop
```

"This computer" finds the instance, names its version, profile, how it listens and its service ("None, started by hand"), and Connect opens the app's dialog before anything is made. Without `--default-local-pairing` the instance asks before every device, and Connect ends on the pairing screen with `pnpm dev-gateway approve --instance look`.

To see other results, change the sandbox: an `openclaw` that doesn't exist (not found), an empty `.openclaw` folder in its home with no program (set up, program missing), a stopped instance (`pnpm dev-gateway stop --instance look`), a folder `.openclaw-work` in its home (another profile, named and not used), or a wrapper program that prints another version.

The web preview shows the same screens, without pairing:

```bash
pnpm preview:web --setup-look --setup-sandbox /tmp/clawtrate-sandbox/sandbox.json
```

Reset the instance when you are done: `pnpm dev-gateway reset --instance look`.

## The fixture

`pnpm fixture` serves every state on fixed data, with no host and no gateway: `?setup=first`, `looking`, `found`, `untested`, `stopped`, `not-found`, `connecting`, `code-failed` and the others listed in [`apps/desktop/src/fixture/setup.ts`](../../apps/desktop/src/fixture/setup.ts). The visual tests take their baselines from these.

## The checks

- `apps/desktop/test/setup-look.test.ts` runs the look on recorded outputs of OpenClaw 2026.10.6 and proves the guard's refusals.
- `apps/desktop/test/setup-connect.test.ts` runs Connect with a fake `openclaw` and the core's fake gateway: the dialog first, the code's one use, and every place the code must never reach.
- `packages/core/test/setup-token-gate.test.ts` proves the first token is written only for exactly read.
- `e2e/setup.spec.ts` drives the development build of the desktop app against `e2e-<run>-setup`, an instance `pnpm e2e` starts with `--default-local-pairing`, through sandboxes of the run's own. It needs Electron's binary, and skips without it.
- `pnpm check:packaged` gives the packaged app a sandbox for the run's instance (`--clawtrate-setup-sandbox`) and checks that the look sees that instance only.
