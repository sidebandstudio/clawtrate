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
pnpm mobile:check  # on a Mac, after pnpm mobile:build: the iOS app in the Simulator (see The iOS app)
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

## The iOS app

`apps/mobile` is the iOS app (Expo SDK 58, React Native 0.88). It runs the same `packages/core` as the desktop app. Building and checking it needs a Mac with:

- Xcode 27 or later and an iOS Simulator runtime with an iPhone 17, 16, 17 Pro or 18 Pro. Neither `xcode-select` nor sudo is needed: the scripts use `DEVELOPER_DIR` when it is set, otherwise the Xcode `xcode-select` points at, otherwise the newest Xcode in `/Applications`. Xcode 26 does not compile Expo SDK 58.
- CocoaPods (1.17 was used).
- For the checks: a Java runtime, 17 or later, and Maestro. They were run with Temurin JRE 21.0.13 and Maestro 2.12.1, unpacked without sudo into `~/.local/share/temurin-jre-21.0.13` and `~/.local/share/maestro-2.12.1`, where the check finds them; elsewhere, set `JAVA_HOME` and `MAESTRO` (the `maestro` executable). Maestro 2.12.1 checks its servers for a newer version and can send an error report even with its analytics off, so the run keeps it on this machine: it sets `MAESTRO_CLI_NO_ANALYTICS=1`, `MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true` and `MAESTRO_DISABLE_UPDATE_CHECK=true`, and points `MAESTRO_API_URL` at a loopback port nothing listens on. To run Maestro by hand (`maestro hierarchy`, a flow under `apps/mobile/build/maestro`), set the same four first, for example `MAESTRO_API_URL=http://127.0.0.1:9`. The run also gives Maestro's runner ten minutes to start on the device (`MAESTRO_DRIVER_STARTUP_TIMEOUT`), which it can need on a loaded machine.
- The OpenClaw CLI, as for the desktop's end-to-end tests.

No Expo account, Apple account, team or signing identity is used.

```bash
pnpm mobile:build   # expo prebuild, pod install and a Release build for the Simulator, into apps/mobile/build
pnpm mobile:check   # the Simulator checks
CLAWTRATE_IOS_SHOTS=/some/folder pnpm mobile:check   # and a screenshot of each screen in light and dark
```

`apps/mobile/ios` is written by `expo prebuild` from `app.json` and is not committed. The build bundles the JavaScript into the app, so no Metro server runs. `pnpm mobile:check` creates a Simulator device of its own ("Clawtrate checks <run>"), boots it without opening the Simulator window, installs the build and starts a development gateway instance of its own (`ios-<run>`); it then drives the app through Maestro and asserts what is on screen. It works over SSH with nobody at the screen. When it ends, also on failure or Ctrl-C, it stops the driver, shuts down and deletes its device and resets its instance, and says so if any of that fails; a run killed outright is cleaned up by the next one. It knows its device by the identifier it recorded and its instance by its run id, and never touches another Simulator device or instance. A run takes about 25 minutes on a busy machine, most of it the gateway's seeding. `pnpm lint`, `pnpm typecheck` and `pnpm test` cover the app's code and its unit tests on any platform.

## Packaging the desktop app

```bash
pnpm package:mac      # on macOS: Clawtrate.app, a .dmg and a .zip for Apple silicon and Intel
pnpm package:win      # on Windows: an NSIS installer for x64
pnpm check:packaged   # launches the app the command above built; on macOS it also pairs it with a development gateway
```

The output goes to `apps/desktop/dist`, which git ignores. Each command packages only on its own operating system. The icons come from `assets/brand/logo.png` through `pnpm brand:icons`; packaging refuses icons older than the logo. Nothing is published or uploaded: releasing belongs to the project's owner.

`pnpm check:packaged` runs the app from `apps/desktop/dist`, not from source, with a temporary data folder (`--user-data-dir`), so it never touches the data of a Clawtrate you use. It checks the window, its title and the connect screen, that its renderer runs in the operating system's sandbox, that the page has no Node and stays on its own content, then pairs with a new development gateway instance, shows the seeded bots and a transcript, checks the data folder is private, and quits the app. It then removes its instances and temporary folder, and puts back the one file a launch changes outside that folder: the bundle id's preferences in `~/Library/Preferences`, restored to its earlier bytes or removed if the run created it. Apple's Python, which the command line tools install, must be present: the check uses it to ask the kernel whether the renderer is sandboxed.

### On Windows

Building the installer needs Node.js 26, pnpm 11 and git on x64 Windows; it needs neither the OpenClaw CLI nor administrator rights. Clone with LF line endings, because Prettier checks for them and Git for Windows converts to CRLF by default:

```bash
git clone -c core.autocrlf=false <repository URL>
pnpm install
pnpm package:win
```

`pnpm package:win` writes `apps/desktop/dist/Clawtrate-<version>-win-x64.exe`, the installer, and `apps/desktop/dist/win-unpacked`, the app it installs, which runs as it is. electron-builder downloads Electron into `%LOCALAPPDATA%\electron\Cache` and its NSIS and 7-Zip tools into `%LOCALAPPDATA%\electron-builder\Cache` (or `ELECTRON_BUILDER_CACHE`), about 175 MB together.

`pnpm check:packaged` then starts `win-unpacked\Clawtrate.exe` with a temporary data folder. Run it from a terminal in your own desktop session, since it opens the app's window; Playwright needs no browser download for it. On Windows it checks that the window is titled Clawtrate, the page comes from the app's archive and shows the connect screen, the page has no Node and stays on its own content, the bridge and the content security policy, that the renderers run at untrusted integrity (the sandbox), that a count sent through `setBadge` puts an overlay on its taskbar button and zero clears it, that a second launch hands over to the running app, and that the app closes when asked and leaves nothing running. The tests that need a development gateway are reported as skipped: no development gateway runs on Windows. The first run can spend half a minute in the sandbox test while PowerShell compiles the small helper that reads the processes' integrity levels.

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
