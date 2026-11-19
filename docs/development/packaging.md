# Packaging the desktop app

```bash
pnpm package:mac      # on macOS: Clawtrate.app, a .dmg and a .zip for Apple silicon and Intel
pnpm package:win      # on Windows: an NSIS installer for x64
pnpm check:packaged   # launches the app the command above built; on macOS it also pairs it with a development gateway
```

The output goes to `apps/desktop/dist`, which git ignores. Each command packages only on its own operating system. The icons come from `assets/brand/logo.png` through `pnpm brand:icons`; packaging refuses icons older than the logo. Nothing is published or uploaded: releasing belongs to the project's owner. A packaged app does not offer the development gateway.

`pnpm check:packaged` runs the app from `apps/desktop/dist`, not from source, with a temporary data folder (`--user-data-dir`), so it never touches the data of a Clawtrate you use. It checks the window, its title and the connect screen, that the binary's fuses are the ones packaging sets, that its renderer runs in the operating system's sandbox, that the page has no Node and stays on its own content, then pairs with a new development gateway instance, shows the seeded bots and a transcript, checks the data folder is private, and quits the app. It then removes its instances and temporary folder, and puts back the one file a launch changes outside that folder: the bundle id's preferences in `~/Library/Preferences`, restored to its earlier bytes or removed if the run created it. Apple's Python, which the command line tools install, must be present: the check uses it to ask the kernel whether the renderer is sandboxed.

## On Windows

Building the installer needs Node.js 26, pnpm 11 and git on x64 Windows; it needs neither the OpenClaw CLI nor administrator rights. Clone with LF line endings, because Prettier checks for them and Git for Windows converts to CRLF by default:

```bash
git clone -c core.autocrlf=false <repository URL>
pnpm install
pnpm package:win
```

`pnpm package:win` writes `apps/desktop/dist/Clawtrate-<version>-win-x64.exe`, the installer, and `apps/desktop/dist/win-unpacked`, the app it installs, which runs as it is. electron-builder downloads Electron into `%LOCALAPPDATA%\electron\Cache` and its NSIS and 7-Zip tools into `%LOCALAPPDATA%\electron-builder\Cache` (or `ELECTRON_BUILDER_CACHE`), about 175 MB together.

`pnpm check:packaged` then starts `win-unpacked\Clawtrate.exe` with a temporary data folder; with `CLAWTRATE_PACKAGED_APP` set to the folder the installer installed into, it starts that app instead, as CI does. Run it from a terminal in your own desktop session, since it opens the app's window; Playwright needs no browser download for it. On Windows it checks that the window is titled Clawtrate, the page comes from the app's archive and shows the connect screen, the page has no Node and stays on its own content, the bridge and the content security policy, that the executable's fuses are the ones packaging sets, that the renderers run at untrusted integrity (the sandbox), that a count sent through `setBadge` puts an overlay on its taskbar button and zero clears it, that a second launch hands over to the running app, and that the app closes when asked and leaves nothing running. The four tests that need a development gateway are reported as skipped: the development gateway controller does not run on Windows ([docs/decisions.md](../decisions.md#packaging) says why). The first run can spend half a minute in the sandbox test while PowerShell compiles the small helper that reads the processes' integrity levels.

## Signing and notarizing

Without signing variables the macOS app is signed ad hoc (no certificate, no keychain) and not notarized, and the Windows installer is not signed. To sign, set these in the environment of `pnpm package:mac` or `pnpm package:win`; no code changes.

macOS, signing with a Developer ID Application certificate, one of:

- `CSC_LINK` (the `.p12` file's path, or its base64) and `CSC_KEY_PASSWORD`;
- `CSC_NAME`, the name of an identity already in the keychain, without the `Developer ID Application:` prefix.

macOS, notarizing, which runs only when signing is on, one of:

- `APPLE_API_KEY` (path to the App Store Connect `.p8` key), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`;
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`;
- `APPLE_KEYCHAIN_PROFILE` (a `notarytool store-credentials` profile), optionally with `APPLE_KEYCHAIN`.

Signing turns on the hardened runtime with electron-builder's default entitlements. Notarizing runs only with one complete set; a partial set (an `APPLE_ID` without its password, say), or notarizing credentials without a signing identity, stops `pnpm package:mac` before it builds, naming the variables and never their values. So does a notarizing variable or `CSC_NAME` that is set but blank: electron-builder counts a value of spaces as given and would pick a different method than the build announced.

Windows: `WIN_CSC_LINK` (a `.pfx` file's path, or its base64) and `WIN_CSC_KEY_PASSWORD`. `CSC_LINK` and `CSC_KEY_PASSWORD` also work when the build runs on Windows: electron-builder takes `WIN_CSC_LINK` if it is set at all, even empty, and `CSC_LINK` otherwise, and the password the same way, each on its own.

A certificate and its password go together. A build given one without the other stops before it starts, naming the missing variable; it never builds unsigned, or with an empty password, without saying so. For a certificate that has no password, set the password variable to an empty string (`CSC_KEY_PASSWORD=`). A certificate variable that is set but blank stops the build too, and so does a blank `WIN_` variable that would hide a generic one electron-builder would otherwise use.

Before it builds, every build prints its signing plan in one line, such as `Signing plan: none. The macOS app will be signed ad hoc and not notarized.`, and a macOS build then reads each app's signature back with `codesign --display` and prints `ad hoc` or `certificate`. It fails if that is not what the variables asked for: electron-builder skips signing in a pull request's CI run even with an identity set. These lines are Clawtrate's own and name variables, never their values. electron-builder's own output is passed through unchanged, and it can print the signing identity's name and hash, the identities in a keychain when the one asked for is missing, and the path of a certificate file it cannot read, so keep the log of a signed build private.

## The update feed

Nothing in the app reads a feed yet; the update screens are later work. The build fixes two things for them:

- `CLAWTRATE_UPDATE_FEED_URL`: the feed's `https` address, written into the main process when it is built. Without it the build has no feed and makes no update request. The packaged app cannot change it.
- `SOURCE_DATE_EPOCH`: the build's own release date, in seconds; the time of the build without it. "Update required" counts 14 days from this date.

After packaging, `node packaging/feed.ts <https address of the folder>` in `apps/desktop` writes `dist/update-feed.json`, naming each artifact of this version in `dist` with its size and SHA-512. Run it with the build's `SOURCE_DATE_EPOCH`. It uploads nothing: publish the feed at the build's address and the files in that folder, on the same host, served directly, since the app follows no redirect. [docs/decisions.md](../decisions.md#updates-and-release-signing) has the format and what is checked before an install.

## Opening an unsigned build

An app you built yourself opens normally. One downloaded from elsewhere is quarantined, and macOS says it cannot verify it. Either open it once, then choose **Open Anyway** in System Settings → Privacy & Security, or remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Clawtrate.app
```

On Windows, SmartScreen warns about an unsigned installer; choose **More info**, then **Run anyway**.

## Logo and icons

The logo is `assets/brand/logo.png`. The desktop icons, the favicons and the mark inside the app are all generated from it:

```bash
pnpm brand:strip   # removes provenance and text metadata from the logo
pnpm brand:icons
```

To change the logo, replace that one file and run both commands. A unit test fails if the generated icons are older than the logo. The interface's accent color is taken from the mark and defined in `packages/ui/src/styles/tokens.css`.
