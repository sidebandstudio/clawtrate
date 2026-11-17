# Contributing

## Setup

You need Node.js 26, pnpm 11 and, for anything that talks to a gateway, the OpenClaw CLI (`openclaw`, version 2026.10.6) on your `PATH`.

```bash
pnpm install
pnpm exec playwright install chromium   # once, for the end-to-end and visual tests
```

The [README](README.md) explains the development gateway, the web preview and the desktop app. [`docs/decisions.md`](docs/decisions.md) records versions and why things are the way they are; add to it when you make a choice a later contributor needs to know about. [`docs/parity.md`](docs/parity.md) is the definition of done.

## Checks

All of these must pass before work is handed over:

```bash
pnpm lint        # ESLint and Prettier
pnpm typecheck
pnpm test        # unit tests
pnpm e2e         # end-to-end tests against a development gateway of their own
pnpm visual      # screenshots and behaviour of the fixture mode; the baselines are macOS ones
```

CI runs lint, typecheck and the unit tests on Linux, `pnpm e2e` on Linux with OpenClaw 2026.10.6 from npm, and `pnpm visual` and an unsigned `pnpm package:mac` on macOS 15.

## The development gateway

Develop only against development gateway instances started by `pnpm dev-gateway`. Never run `openclaw` without `--dev` or `--profile clawtrate-dev-<name>`, never against your default profile, and never read or write `~/.openclaw`. If another checkout may be running the default instance (port 19001), use a named instance of your own:

```bash
pnpm dev-gateway start --instance <name>
pnpm dev-gateway reset --instance <name>   # when you are done
```

`pnpm e2e` and `pnpm check:packaged` always create, and remove, their own instances. Never copy credentials from another OpenClaw profile; the development gateway uses a scripted model. Stop only processes you started, by PID.

## Publication

The repository is public, so every commit is published. Commit no secrets or tokens, no private hostnames or IP addresses, no usernames or home-directory paths, no email addresses, no personal data, and no third-party images or copied assets. Commits are small and describe the change, with no co-author trailers, no "generated with" lines and no tool or agent attribution.

## Packaging the desktop app

```bash
pnpm package:mac      # on macOS: Clawtrate.app, a .dmg and a .zip for Apple silicon and Intel
pnpm check:packaged   # on macOS: launches the packaged app and pairs it with its own development gateway
pnpm package:win      # on Windows: an NSIS installer for x64
```

The output goes to `apps/desktop/dist`, which git ignores. The icons come from `assets/brand/logo.png` through `pnpm brand:icons`; packaging refuses icons older than the logo. Nothing is published or uploaded: releasing belongs to the project's owner.

`pnpm check:packaged` runs the app from `apps/desktop/dist`, not from source, with a temporary data folder (`--user-data-dir`), so it never touches the data of a Clawtrate you use. It checks the window, its title and the connect screen, that its renderer runs in the operating system's sandbox, that the page has no Node and stays on its own content, then pairs with a new development gateway instance, shows the seeded bots and a transcript, checks the data folder is private, and quits the app. It then removes its instances and temporary folder, and puts back the one file a launch changes outside that folder: the bundle id's preferences in `~/Library/Preferences`, restored to its earlier bytes or removed if the run created it. Apple's Python, which the command line tools install, must be present: the check uses it to ask the kernel whether the renderer is sandboxed.

### Signing and notarizing

Without signing variables the macOS app is signed ad hoc (no certificate, no keychain) and not notarized, and the Windows installer is not signed. To sign, set these in the environment of `pnpm package:mac` or `pnpm package:win`; no code changes.

macOS, signing with a Developer ID Application certificate, one of:

- `CSC_LINK` (the `.p12` file's path, or its base64) and `CSC_KEY_PASSWORD`;
- `CSC_NAME`, the name of an identity already in the keychain, without the `Developer ID Application:` prefix.

macOS, notarizing, which runs only when signing is on, one of:

- `APPLE_API_KEY` (path to the App Store Connect `.p8` key), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`;
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`;
- `APPLE_KEYCHAIN_PROFILE` (a `notarytool store-credentials` profile), optionally with `APPLE_KEYCHAIN`.

Signing turns on the hardened runtime with electron-builder's default entitlements.

Windows: `WIN_CSC_LINK` (a `.pfx` file's path, or its base64) and `WIN_CSC_KEY_PASSWORD`. `CSC_LINK` and `CSC_KEY_PASSWORD` also work when the build runs on Windows.

### Opening an unsigned build

An app you built yourself opens normally. One downloaded from elsewhere is quarantined, and macOS says it cannot verify it. Either open it once, then choose **Open Anyway** in System Settings → Privacy & Security, or remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Clawtrate.app
```

On Windows, SmartScreen warns about an unsigned installer; choose **More info**, then **Run anyway**.
