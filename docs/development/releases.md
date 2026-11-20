# Desktop releases

A Mac beta is cut on the maintainer's Mac with `pnpm release:beta` and published as a GitHub prerelease, with its feed on the website. That is [Beta for macOS](#beta-for-macos). Stable builds and Windows builds go through [release candidates](#make-a-candidate) and the [owner procedure](#owner-procedure).

## Beta for macOS

The owner has authorized publishing Mac betas. The track reads "Beta" in the app and on the site. [Decisions](../decisions.md#the-beta-track) says why its code identifier is still `nightly`, and [where a beta's files live](../decisions.md#where-a-betas-files-live).

### Before the first beta

- **The vault** holds five values, read with `fleet secret get <NAME> --scope personal` at run time:
  - `APPLE_CLAWTRATE_DEVELOPER_ID_P12_BASE64`: the Developer ID Application certificate and its private key, exported from Keychain Access as a `.p12` and base64-encoded (`base64 -i cert.p12`);
  - `APPLE_CLAWTRATE_DEVELOPER_ID_P12_PASSWORD`: the password the `.p12` was exported with;
  - `APPLE_CLAWTRATE_NOTARY_API_KEY_P8`: an App Store Connect API key with the Developer role, the `.p8` file's text or its base64;
  - `APPLE_CLAWTRATE_NOTARY_API_KEY_ID`: that key's ten-character ID;
  - `APPLE_CLAWTRATE_NOTARY_ISSUER_ID`: the issuer ID shown above the keys in App Store Connect.
- **GitHub**: `gh` signed in as someone who may create releases in `sidebandstudio/clawtrate`. Pages is on, with GitHub Actions as its source and `clawtrate.dev` as its custom domain, so the Site workflow can deploy.
- **The Mac**: Xcode's command line tools (`codesign`, `spctl`, `xcrun stapler`, `notarytool`), Node 26 and pnpm.
- **The app**: an update installs in place only from a Developer ID build that has the install step (#202) and Restart (#204). A beta cut before they are on `main` still checks and downloads its successor, but cannot restart into it.

### Cut a beta

From a clean checkout of `main` at the commit to release, with no `apps/desktop/dist`:

```sh
git switch main && git pull --ff-only
pnpm install --frozen-lockfile
pnpm release:beta
```

If the vault lacks any of the five values, the script names the missing ones and stops before building. Otherwise it:

1. chooses the version: the checked-in version with its patch raised, the UTC day and the next run number that no tag, draft or staged release has used, for example `0.1.1-beta.20261120.1`, and refuses one that is not newer than every tag;
2. writes the certificate and the key into a new private temporary folder, which it removes on every exit, Ctrl-C included, and builds with only those signing variables, the Beta feed address and the build date (`candidate-build.ts`, the same build the release candidates use);
3. builds and signs both apps, has Apple notarize each, and requires the packager's own reading of each signature to be a certificate;
4. unpacks each zip and checks the app in it: bundle id, version, architecture (`lipo`), `codesign --verify --deep --strict`, a Developer ID Application signature, `spctl --assess --type execute` accepting it as notarized, and `xcrun stapler validate`. Should a ticket be missing, it staples the app, zips it again and checks it all again. Both apps must have the same team;
5. writes `.release/beta/<version>/`: the two zips, `feed.json` (the Beta feed, naming each zip at its release download address with its size and SHA-512), `latest-mac.json` (the team and each architecture's version, address and SHA-256, for the site's install script), `notes.md` and `release.json`, the record of every file's size and hashes;
6. removes `apps/desktop/dist` and prints the files, their SHA-256 and the command that publishes them.

Only Apple's notary service receives anything. A failed build prints the end of its log with every secret replaced by `[redacted]`. Keep the full output private anyway: electron-builder can print identity names.

### Check it before publishing

The script has checked each app as it ships. Before publishing, read `notes.md` and `latest-mac.json`, and confirm that the version, the commit and the team are the ones you expect. To look yourself, unpack a zip with `ditto -x -k` into a new folder and run `spctl --assess --type execute --verbose=2` and `xcrun stapler validate` on the app. Opening it there starts a real app with your own data folder, so do that only on a Mac set aside for it.

### Publish it

```sh
pnpm release:beta --publish <version>
```

It publishes only what was prepared, and:

1. hashes every file in `.release/beta/<version>/` again and refuses any that changed;
2. requires the commit to be on `origin/main`, the tag to be unused and the version to be newer than every tag;
3. refuses a team other than the one in the `latest-mac.json` the site serves now;
4. creates the release `v<version>` as a draft prerelease with the zips, `feed.json` and `latest-mac.json`, checks that GitHub holds each file at its size, and only then publishes it;
5. downloads every file back through its public address and compares its size and SHA-512 with the record;
6. waits up to 15 minutes for `https://clawtrate.dev/updates/beta/feed.json` to serve the new feed. Publishing the release starts the Site workflow. Pages can cache the old feed for up to ten minutes. If the wait ends, run the Site workflow by hand and check the feed.

A beta on the Beta track then finds it with Check for Updates in Settings → Updates and downloads it when the person chooses. Restart installs it once #202 and #204 are on `main`. New installs come from the site: the download link, or the install script, which reads `latest-mac.json`.

### Withdraw a beta

```sh
pnpm release:beta --withdraw <version>
```

It makes the release a draft again, which removes its files from their public addresses at once, and the Site workflow deploys the previous beta's feed, or no feed when it was the first. It waits until the site stops offering the version. An app that checked earlier can still hold the offer, but its download now fails. Copies already downloaded stay on those Macs, and the engine never downgrades, so whoever installed the withdrawn beta needs a newer one: fix the problem and cut the next beta. Keep the draft as the record, and never reuse its version; the script counts drafts.

### What only a signed build shows

The tests and the unsigned launch check show the release files, the redirect rule and that a newer build opens the same data folder, device key and saved connection. Two consecutive Developer ID beta builds are needed to show that Squirrel.Mac accepts the successor's designated requirement and hands the app over, and that the person's pairing and tasks are there after the real restart. That is the owner's trial.

### The owner's signed trial

**Mac, Apple silicon and Intel.** On each architecture use two consecutive Developer ID-signed, notarized builds and their exact ZIPs on an isolated feed. Inspect the designated requirement and full version in each signed bundle. Test both allowed track transitions. Try an unsigned or ad hoc app, another signer, an unsafe or different archive, another architecture, another product and an older or unrelated same-identity release. Observe ShipIt state during Check, Download and an ordinary quit before Restart. None should stage an update. After confirmed Restart, record loopback requests, ATS and proxy behavior, listener closure, OS security-service traffic and the order of staging. Exercise quit during stage, helper error and retry, canceled authorization and supported writable and protected installation locations. Complete a restart and check data preservation. Independently compare intended and installed bundle identities. Confirm that Clawtrate reports only the version it actually reads after relaunch.

**Windows x64.** Prepare consecutive signed builds for a controlled trial of the currently gated path. Derive `CLAWTRATE_WINDOWS_UPDATE_CERT_SHA256` from the actual signing leaf's DER bytes and independently compare the pin, product, setup marker and full Stable and Beta versions on both releases. Establish cache-only trust on a fresh trial machine with warm and empty chain and revocation caches. Include timestamped, expired, revoked, wrong-leaf, other-product and older signed inputs. Exercise long, short and volume paths, a custom location with spaces and ordinary special characters, both registrations and coexisting installations. Verify per-user handoff and refusal of unproved elevated modes. Before enabling any elevated mode, establish exact package sharing, loader, overlay and embedded payload reads throughout elevation, including refusal or canceled UAC. Prove that a failed start or blocked quit leaves other installations and processes alone. Record exit order, one handoff, independent OS egress, final location, preserved app data and the newly running version. Keep the Windows tracks closed pending the results.

## Release candidates

**In-place installation is not on `main` yet.** The desktop host can verify a download. Installation is a later app change. Keep Stable and Windows closed until installation exists and the signed upgrade trial below passes on all three systems. The Mac beta above is published with the owner's authorization, and its first two signed builds are its trial.

## Make a candidate

Stable and Beta each have a fixed feed. Stable uses `X.Y.Z`. A beta takes the checked-in desktop version, increments its patch and appends the UTC day and numeric workflow run. For example, from `0.1.0`, run 9 on November 19, 2026 gives `0.1.1-beta.20261119.9`. Run 10 follows it. Both precede stable `0.1.1`. A selected ref can have an old base. Check its version against the actual feeds.

The Windows packager wraps its x64 app in a 32-bit NSIS installer. Before upload, the Windows job reads the PE header of `apps/desktop/dist/win-unpacked/Clawtrate.exe` and requires AMD64. It records that observation alongside the installer.

1. In Actions, choose **Desktop release candidate**, **Run workflow** and a reviewed source ref. Select `stable` and enter the exact version, or select `nightly` (the Beta track) and leave the version blank. Rerunning failed jobs keeps a successful version selection. Rerunning all jobs selects a new epoch and can change the beta's date after UTC midnight. Start a fresh dispatch for a new candidate and retain its source commit and epoch.
2. A successful workflow retains `candidate-<version>` for three days. It contains two Mac ZIPs, a Windows installer, three build records, `update-feed.json` and `release-plan.json`. The native jobs check the staged Mac apps for ad hoc signatures and Windows for an unsigned installer before retention. The assembly job matches its files to those native jobs' checksums.
3. Read the verdict. **Refused** lists inconsistencies. **Complete and consistent** means the file names, file structures, architecture headers, sizes and hashes match, and the recorded build settings agree. The Mac check reads the executable named in the outer app's Info.plist. The plan checks for Windows PE executable structure. The owner's Windows check establishes that the file is the expected installer and that it installs the intended x64 app. When present, the Windows build record attributes the unpacked app's architecture to the build job. That observation has no effect on the verdict. Signing is **not checked by this plan**. A build record can be edited.

Use Node 26, Python 3 and a checkout with `pnpm install --frozen-lockfile`. To recheck the retained files, take the full source commit from the workflow run and the UTC build date from the retained plan. The workflow uses `https://updates.example/stable/feed.json` and `https://updates.example/nightly/feed.json`. Set `TRACK_URL` to the chosen track's build address and `OTHER_URL` to the other address, or `-` if absent.

```sh
node apps/desktop/packaging/release-plan.ts check candidate "$TRACK" "$VERSION" "$COMMIT" "$BUILD_DATE" "$TRACK_URL" "$OTHER_URL"
```

Exit 0 means complete and consistent. Exit 1 means refusal or an error reading or writing the candidate. Without comparison feeds the plan reports that the version was not compared with any published release.

## Owner procedure

### Choose the host, version and identities

1. Choose a direct HTTPS host and approve its costs. Use distinct fixed feeds such as `/stable/feed.json` and `/beta/feed.json`. Store binaries in a version folder beside their feed, for example `/stable/0.1.1/Clawtrate-0.1.1-mac-arm64.zip`. The plan's local check of the address's form requires canonical unescaped paths and a distinct URL for each configured track. Both addresses, including an absent one, are compared across build records. Verify separately that the host answers, the TLS certificate is trusted by the app, and the bytes served match. The feed and its files must return HTTP 200 on the same origin and port without credentials or redirects. Ordinary GitHub Release download URLs redirect. Configure the feed and CDN to bypass caching or revalidate on every request.
2. Save a local copy of each feed currently served and keep a private release history. After withdrawal the current feed alone cannot tell you the highest version ever offered. Choose a new version above the versions it supersedes, including the withdrawn version. Never reuse a published version or object name. Keep nightlies between the last stable and the next intended stable.
3. Prepare the same trusted signing identities used for the preceding build. On Mac, use a Developer ID Application certificate in `CSC_LINK` with `CSC_KEY_PASSWORD`, or an identity in `CSC_NAME`. For notarization, use `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN_PROFILE` with optional `APPLE_KEYCHAIN`. On Windows use `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`, or `CSC_LINK` and `CSC_KEY_PASSWORD`. Keep credentials and signed build logs on private builders. See [Packaging](packaging.md#signing-and-notarizing).

### Build and verify the exact bytes

On both native builders use fresh checkouts of the approved commit. Install dependencies and set the same `SOURCE_DATE_EPOCH` (whole UTC seconds), `CLAWTRATE_UPDATE_FEED_URL` and `CLAWTRATE_NIGHTLY_UPDATE_FEED_URL`. Preserve the epoch selected for the candidate. For a nightly, its UTC day must match the version. Run `node apps/desktop/packaging/candidate-build.ts staging <version>` from each checkout root. Copy both folders' contents into one fresh `candidate` directory. Set `BUILD_DATE` to the epoch in UTC ISO format with milliseconds.

Pass paths to the saved current feeds, selected track first, other track second. Use `-` for a track with no previous feed. The comparison runs offline. Investigate every refusal and check the private release history before uploading.

```sh
node apps/desktop/packaging/release-plan.ts assemble candidate "$TRACK" "$VERSION" "$COMMIT" "$BUILD_DATE" "$TRACK_URL" "$OTHER_URL" "$CURRENT_FEED" "$OTHER_FEED"
```

On Apple silicon and Intel Mac, extract each final ZIP, verify its bundle ID, internal version, architecture, Developer ID signature, expected team and stapled notarization ticket against the intended release. On Windows verify the final installer's Authenticode trust and expected publisher. Inspect the installed app's identity, internal version and x64 executable. Recheck the digests after transferring the files.

### Trial on an isolated feed

Use a separate HTTPS endpoint to exercise the chosen track on the trial machines. Restrict network access to those machines and serve the feed and files directly, without HTTP credentials. Compile the signed predecessor's chosen track to use this trial address and leave its other track unset. Place the exact prospective signed successor files on the trial origin. Generate a trial feed with the chosen track, successor version and date, and the trial file URLs, sizes and hashes. Fetch all three files from that origin and verify them before pointing the trial feed at the successor. The successor retains its compiled production addresses when it relaunches. Keep both production feeds closed and leave the production candidate files and feed intact.

On Apple silicon, Intel Mac and Windows x64, start on the predecessor, check the trial feed in the app, download, install in place and relaunch. Verify the new version, signer continuity, installation location and preserved data. Record both versions, commits, file digests and results. Open a track only after two consecutive signed builds pass this trial on each system.

### Offer a version

Immediately before uploading, save the live feeds again and repeat the command above with `check` in place of `assemble`. Archive the verified prior feed if there was one. Upload the three immutable binaries first. GET each file through the normal CDN route without following redirects. Require HTTP 200 and compare byte length and base64 SHA-512 with the local plan. Only then atomically replace the chosen track's feed. GET it from its fixed URL and verify HTTP 200 and the exact local bytes. Put release notes on the project's release page.

Retain each track's active and last good feeds and files while they serve those roles. Retain files named by other supported manifests throughout their support period. Set and record a retention window for old cached offers before opening the track. Keep superseded files through that window unless withdrawing them.

### Withdraw a version

Restore and verify the last good feed, or disable the feed if this was the first release. Purge cached copies of the old feed. Then remove the withdrawn binaries from their public URLs and purge their CDN copies. Confirm that each withdrawn URL fails through the normal route. A client can hold an offer and request its file without checking the feed again. Removing the files stops those later downloads. In-flight transfers may finish and copies already downloaded remain on devices. Keep a private archive of the release record. Anyone who installed the bad build needs a newer signed build because the engine never downgrades.

The owner controls host costs, credentials, trials, retention, publication and withdrawal. The manual workflow uses read-only repository access and temporary workflow artifacts.
