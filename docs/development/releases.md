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
- **GitHub**: `gh` signed in as someone who may create releases in `sidebandstudio/clawtrate` and start its workflows: Contents and Actions write access. `gh auth login` gives both; a fine-grained token needs both, or `--publish` and `--withdraw` change the release and then cannot start the Site workflow. Pages is on, with GitHub Actions as its source and `clawtrate.dev` as its custom domain, so the Site workflow can deploy. The `github-pages` environment allows deployments from the `main` branch only, with no tag rule: a tag rule would let anyone who can push a `v*` tag deploy that tag's own copy of the workflow, which is weaker than requiring a merge to `main`. So a release event does not deploy the site; the release commands start the Site workflow on `main` themselves. That workflow is the site's only deploy. It deploys nothing until `site/index.html` is on `main` and a beta is published, while a `__CLAWTRATE_…__` template token is left, or while `site/install.sh` pins the placeholder `APPLE_CLAWTRATE_TEAM_ID` or another team than the beta's. Before the first beta, put the Developer ID team in `CLAWTRATE_TEAM_ID` in `site/install.sh`.
- **The Mac**: Xcode's command line tools (`codesign`, `spctl`, `xcrun stapler`, `notarytool`), Node 26 and pnpm, and Apple's Developer ID intermediate certificate (Xcode installs it; otherwise it is at [Apple's certificate authority](https://www.apple.com/certificateauthority/)).
- **The app**: an update installs in place only from a Developer ID build that has the install step (#202) and the Restart screen (#204), both on `main`, so every beta has them.

### Cut a beta

Use a dedicated, clean checkout of `main` at the commit to release. Keep other builds in separate checkouts until preparation finishes. The candidate temporarily changes `apps/desktop/package.json`, and electron-vite writes to `apps/desktop/out/`.

```sh
git switch main && git pull --ff-only
pnpm install --frozen-lockfile
pnpm release:beta
```

The script keeps its state in one private folder per macOS user, `~/Library/Application Support/clawtrate-release` (mode 700). It finds that folder from your account, not from `TMPDIR` or `HOME`, so every shell and checkout you release from shares it.

First it takes the release lock there. It writes `locks/release-<pid>-<token>.lock`, a file of its own with its pid, its start time and a random token, then reads every other lock file:

- A run that is alive with the start time it recorded holds the lock, and this run refuses.
- A run whose pid no longer exists has ended. Its file is removed, and its leftovers are recovered next (see [If a run is killed](#if-a-run-is-killed)).
- Anything else is ambiguous: a file it cannot read, or a running pid that started at another time than its lock records. The run refuses and names the file rather than guess.

A run only ever removes its own lock file and those of runs that have certainly ended. If the vault lacks any of the five values, the script names the missing ones and stops before building. Otherwise it:

1. chooses the version: the checked-in version with its patch raised, the UTC day and the next run number that no tag, draft or staged release has used, for example `0.1.1-beta.20261120.1`. It refuses a version that is not newer than every tag. It then creates `.release/beta/<version>/`, only if no one has, with this run's marker inside (`.clawtrate-release-run`, holding its pid and a random token). If the folder appears first, it stops and leaves it as it is;
2. makes a signing folder, `clawtrate-signing-XXXXXX`, in the state folder, and a keychain in it that locks itself after an hour unused and when the Mac sleeps. The certificate and its password go to `/usr/bin/security` on its standard input, one command at a time, each one's status checked. The notary key's path, id and issuer go to `/usr/bin/xcrun notarytool` on its standard input. No secret is ever in a command's arguments or environment. The certificate's file is deleted as soon as its import returns, and the key's file (`notary.p8`) as soon as `notarytool` has stored it, so neither exists when the build starts. If making that folder or recording the run in it fails, the run removes what it had reserved;
3. builds and signs both apps with `candidate-build.ts`, the same build the release candidates use. The build gets only ordinary variables (`PATH`, `HOME`, the locale and caches), the keychain, the identity's hash, the notary profile's name, the Beta feed address and the build date.
   - electron-builder writes the beta's packaged artifacts into `build/` in the signing folder (`CLAWTRATE_PACKAGE_OUTPUT`). Ordinary `pnpm package:mac` writes its packaged artifacts to `apps/desktop/dist`.
   - For the build only, the keychain goes first on your keychain search list, with your other keychains after it in their order and your default keychain unchanged. electron-builder asks `codesign` for the identity by name with `--keychain`, and `codesign` finds no identity in a keychain that is not on the list. The list as it was is recorded in the signing folder first.
   - When the build ends, the run reads the list again before writing anything. If it is exactly what the run put there, the recorded list goes back. If it holds the run's keychain among other changes, made by you or another tool meanwhile, only the run's keychain comes off and those changes stay. If it is already the recorded list, nothing is written. If it cannot be read, or no longer holds the run's keychain, the run writes nothing. What it writes counts only once it reads back as written.
   - Apple notarizes each app, and the packager's own reading of each signature must be a certificate;
4. copies each zip into the private folder, unpacks the copy and checks the app in it: bundle id, version, architecture (`lipo`), `codesign --verify --deep --strict`, a Developer ID Application signature by the keychain's team, `spctl --assess --type execute` accepting it as notarized, and `xcrun stapler validate`. Every one of these tools must succeed and print what is expected. Should a ticket be missing, it staples the app, zips it again, unpacks that zip and checks it all again. Then it runs the update helper's ZIP preflight on the zip as it will be staged, built from `inspect-archive.m` by `packaging/mac/check-zip.m`, and stops, naming the zip and the check, on a zip every installed app would refuse with `mac-archive`;
5. writes `.release/beta/<version>/` from those verified copies, then removes its marker. The folder holds:
   - the two zips;
   - `feed.json`, the Beta feed, naming each zip at its release download address with its size and SHA-512;
   - `latest-mac.json`, the team and each architecture's version, address and SHA-256, for the site's install script;
   - `notes.md`;
   - `release.json`, the record of every file's size and hashes;
6. removes the signing folder, with the build output in it, and its lock file. It prints the files, their SHA-256, the SHA-256 of `release.json` and the command that publishes them, which includes that digest. Keep the digest somewhere outside the staging folder: publishing requires it, and it is what ties the staged files to the ones that passed the checks.

Only Apple's notary service receives anything.

A failed run first puts your search list back. Then it removes its build output and its own version's folder in `.release/beta/`, but that folder only while it still carries this run's marker and holds no `release.json`. A staged release is never removed, and a folder without the marker is left in place and named. If removing them fails, the list has already been put back.

The list may not read back as written, or the run may be unable to tell what to put back. Either way the run stops with the command or the reason, and keeps both the signing folder (with its `search-list.json`) and its lock file. The next run then recovers the list from them before anything else.

A failed build prints the path of its log, not the log: electron-builder's output can name the identity, its hash and the team. Keep that log and the script's output private.

### If a run is killed

A normal exit, an error, Ctrl-C and `kill` (SIGTERM) put your keychain search list back by the rule above. Once that is verified, they remove the signing folder and the run's lock file. Ctrl-C and `kill` first stop the build and everything it started, a stalled notarization included, and wait for all of it to end.

A run killed outright (`kill -9`, a crash or a power cut) leaves its lock file and its `clawtrate-signing-XXXXXX` folder in `~/Library/Application Support/clawtrate-release`. What the folder holds depends on when the run was killed:

- during the certificate's import by `security`: possibly the certificate's file, readable by your user;
- while `notarytool` stores the key: possibly the key's file (`notary.p8`), readable by your user;
- at any later point: the keychain. Its password died with the run, but it stays unlocked, and usable by your user's processes, until it locks itself after an hour or when the Mac sleeps;
- also the build output, and `search-list.json`, your keychain search list from before the build.

If the release process was force-killed during the build, its detached build group can still be signing or notarizing. Before retrying or removing anything, confirm that the build and its workers have exited. The `pid` file identifies only the release process. If you cannot establish which workers belonged to that run, leave its files and keychain list in place. After a machine restart, those workers have exited.

The next `pnpm release:beta` does this before anything else:

- It removes the lock file of any run whose pid no longer exists. A lock file it cannot read, or one whose pid is running but started at another time, stops it, naming the file.
- It removes each signing folder whose recorded run (`pid` inside it) has ended, and refuses while that run is still going. Before removing a folder, it recovers the search list by the same rule as a run's own restore and says what it did. When it cannot tell what to put back, it writes nothing, keeps the folder and stops.
- It leaves alone, and names, a folder with no `pid`, which may be a run that is just starting.

A run whose restore could not be verified keeps its folder and its lock file on purpose, and printed the command or the reason.

To clean up yourself, recover the list before you remove the folder. Once the folder is gone, so is `search-list.json`, the only record of your list from before the build. Check the run first:

```sh
S="$(node -p 'require("node:os").userInfo().homedir')/Library/Application Support/clawtrate-release"
cat "$S"/clawtrate-signing-XXXXXX/pid          # the run's process id
ps -p <that pid> -o lstart=                    # no row: the run has ended
```

Keep other releases and tools that edit the keychain search list idle during manual recovery. The read and write are separate operations. Readback can verify the result but cannot detect an edit overwritten between them.

If the run ended before writing `search-list.json`, the command checks whether its keychain is on the current list. If it is absent, the ended run's folder can be removed without changing the list. If it is present, keep the folder for inspection. With a record, the command follows the same recovery rule as the release script.

```sh
/usr/bin/python3 -I - "$S"/clawtrate-signing-XXXXXX <<'PY'
import json, os, subprocess, sys
folder = sys.argv[1]
keychain = os.path.join(folder, "release.keychain-db")
names = {keychain, os.path.join(os.path.realpath(folder), "release.keychain-db")}
def read():
    out = subprocess.run(["/usr/bin/security", "list-keychains", "-d", "user"], capture_output=True, text=True, check=True).stdout
    lines = [line.strip() for line in out.splitlines() if line.strip()]
    if any(len(line) < 3 or line[0] != '"' or line[-1] != '"' or '"' in line[1:-1] for line in lines):
        sys.exit("Could not read the search list. Keep the folder.")
    return [line[1:-1] for line in lines]
now = read()
print("The list now:             ", now)
try:
    with open(os.path.join(folder, "search-list.json")) as saved:
        record = json.load(saved)
except FileNotFoundError:
    if names & set(now):
        sys.exit("No recovery record and the release keychain is listed. Keep the folder.")
    print("No recovery record. The release keychain is absent. No restore is needed.")
    sys.exit(0)
if not isinstance(record, list) or not all(isinstance(path, str) for path in record):
    sys.exit("Invalid recovery record. Keep the folder.")
print("Recorded before the build:", record)
if now == record:
    print("The list is already the recorded one: nothing to write.")
    sys.exit(0)
if not names & set(now):
    sys.exit("The list no longer holds this run's keychain and is not the recorded one: nothing written. Compare it with search-list.json yourself.")
installed = [keychain] + [path for path in record if path not in names]
target = record if [keychain if path in names else path for path in now] == installed else [path for path in now if path not in names]
subprocess.run(["/usr/bin/security", "list-keychains", "-d", "user", "-s", *target], check=True)
after = read()
print("Written:                  ", target)
print("Read back:                ", after)
sys.exit(0 if after == target else "The list does NOT read back as written: remove nothing, and check it.")
PY
```

If the command reports that no restore is needed, the list already matches the record, or the readback matches what it wrote, recovery is complete.

If the release preserved your edits but its readback failed, its keychain may already be absent and the list may differ from the original record. Check the current list against the target from the failed run's restore message, path by path and in order. If they match and the release keychain is absent, recovery is complete. If you cannot verify the target, keep the recovery files.

Once recovery is complete and the run and its workers have exited, remove that folder and its lock file:

```sh
rm -rf "$S"/clawtrate-signing-XXXXXX           # that folder only
cat "$S"/locks/release-<pid>-<token>.lock      # the pid and start time it recorded
rm "$S"/locks/release-<pid>-<token>.lock       # that file only, once that pid has ended
```

A failed run's version folder that it could not remove carries its marker, `.clawtrate-release-run`. A folder without it was not that run's, and the script leaves it and names it. If the certificate's or the key's file may have been copied, revoke it (the key in App Store Connect, the certificate in the developer account) and put a new one in the vault.

### Check it before publishing

The script has checked each app as it ships. Before publishing, read `notes.md` and `latest-mac.json`, and confirm that the version, the commit and the team are the ones you expect. To look yourself, unpack a zip with `ditto -x -k` into a new folder and run `spctl --assess --type execute --verbose=2` and `xcrun stapler validate` on the app. Opening it there starts a real app with your own data folder, so do that only on a Mac set aside for it.

### Publish it

```sh
pnpm release:beta --publish <version> <release.json sha256>
```

Use the command preparation printed. It publishes only what was prepared, and:

1. reads `release.json` once and refuses it unless its SHA-256 is the one given, before trusting anything in it. It then requires `.release/beta/<version>/` to hold exactly the two zips, `feed.json`, `latest-mac.json`, `notes.md` and `release.json`; `release.json` to name this version, its tag, a full commit, a team and exactly those four files; every file to have its recorded size and hashes; the feed and `latest-mac.json` to name those zips, each at its own canonical name, by size and digest, under this tag and team; and `notes.md` to be the notes the record makes;
2. asks GitHub whether the commit is on `sidebandstudio/clawtrate`'s `main`, whatever this checkout's `origin` is, and refuses if it is not or GitHub cannot say; then requires the tag to be unused and the version to be newer than every tag;
3. reads the team from every earlier beta on GitHub, drafts included, and refuses another team or one it cannot read. Only a listing with no earlier beta counts as the first;
4. creates the release `v<version>` as a draft prerelease with the zips, `feed.json`, `latest-mac.json` and, as text, the notes it checked. It requires the draft to hold exactly those files, fully uploaded, each with GitHub's SHA-256 digest of the prepared bytes, and those notes, and only then publishes it. It reads the release back afterwards: it goes on only once GitHub lists it as public, and says so when the command failed but the release is public, or that the state is unconfirmed when it cannot read it;
5. downloads every file back through its public address and compares its size and SHA-512 with the record;
6. starts the Site workflow on `main` (`gh workflow run site.yml --ref main`), only once GitHub lists the release as public and every public file matches, and waits up to 15 minutes for `https://clawtrate.dev/updates/beta/feed.json` to serve the new feed. Pages can cache the old feed for up to ten minutes. If the workflow cannot be started, or the wait ends, the script says so: look at the Site workflow's run on `main`, start it there by hand if needed, and check the feed.

A beta on the Beta track then finds it with Check for Updates in Settings → Updates and downloads it when the person chooses. Restart to Update installs it once the person confirms (#202 and #204, both on `main`). New installs come from the site: the download link, or the install script, which reads `latest-mac.json`.

### Withdraw a beta

```sh
pnpm release:beta --withdraw <version>
```

It makes the release a draft again and reads it back to report that GitHub lists it as a draft, or that the state is unconfirmed when it cannot read it. Once GitHub lists it as a draft, it starts the Site workflow on `main`, which deploys the feed and download page of the newest beta still published. A release changed by hand on GitHub, made a draft or deleted, changes nothing on the site until someone runs `gh workflow run site.yml --repo sidebandstudio/clawtrate --ref main`. The script first waits up to 15 minutes for the Site workflow's runs on `main` to finish, since a run that checked the release before it became a draft can still deploy its feed. It then waits up to 15 minutes, each request to the feed's own address with its own deadline and no redirect followed, and no answer that arrives after the wait counted, until the site serves the remaining beta's own `feed.json`, byte for byte by GitHub's digest of it, or, when GitHub lists no other published beta, answers that address with a 404. It reports any other feed, the same version's included, a redirect, a failed connection, another status or a body that is not a feed, and exits 1.

Withdrawing the only published beta leaves the site as it was: with no beta to fill the download page from, the Site workflow deploys nothing, so the last deployment keeps serving the withdrawn feed and the script says so. Cut a fixed beta, or unpublish the Pages site in the repository's settings until there is one. GitHub's download addresses can keep answering from caches for a while; the signed trial is where to see how long. The app may still show the offer, and a cached download can still answer. Copies already downloaded stay on those Macs, and the engine never downgrades, so whoever installed the withdrawn beta needs a newer one: fix the problem and cut the next beta. Keep the draft as the record, and never reuse its version; the script counts drafts.

### Rolling back after the credentials move

The first release with secure storage moves each data folder's device key and tokens into `credentials.bin` ([decisions.md](../decisions.md), "Rolling back after the move"). From that release on, a rollback is a newer signed build that reads that record; never reinstall an earlier build over a person's data folder. To run an earlier build for comparison, give it a separate, disposable data folder.

### What only a signed build shows

The tests and the unsigned launch check show the release files, the redirect rule and that a newer build opens the same data folder, device key and saved connection. Two consecutive Developer ID beta builds are needed to show that Squirrel.Mac accepts the successor's designated requirement and hands the app over, and that the person's pairing and tasks are there after the real restart. That is the owner's trial.

### The owner's signed trial

**Mac, Apple silicon and Intel.** On each architecture use two consecutive Developer ID-signed, notarized builds and their exact ZIPs on an isolated feed. Inspect the designated requirement and full version in each signed bundle. Test both allowed track transitions. Try an unsigned or ad hoc app, another signer, an unsafe or different archive, another architecture, another product and an older or unrelated same-identity release. Observe ShipIt state during Check, Download and an ordinary quit before Restart. None should stage an update. After confirmed Restart, record loopback requests, ATS and proxy behavior, listener closure, OS security-service traffic and the order of staging. Exercise quit during stage, helper error and retry, canceled authorization and supported writable and protected installation locations. Complete a restart and check data preservation. Independently compare intended and installed bundle identities. Confirm that Clawtrate reports only the version it actually reads after relaunch.

**Windows x64.** Prepare consecutive signed builds for a controlled trial of the currently gated path. Derive `CLAWTRATE_WINDOWS_UPDATE_CERT_SHA256` from the actual signing leaf's DER bytes and independently compare the pin, product, setup marker and full Stable and Beta versions on both releases. Establish cache-only trust on a fresh trial machine with warm and empty chain and revocation caches. Include timestamped, expired, revoked, wrong-leaf, other-product and older signed inputs. Exercise long, short and volume paths, a custom location with spaces and ordinary special characters, both registrations and coexisting installations. Verify per-user handoff and refusal of unproved elevated modes. Before enabling any elevated mode, establish exact package sharing, loader, overlay and embedded payload reads throughout elevation, including refusal or canceled UAC. Prove that a failed start or blocked quit leaves other installations and processes alone. Record exit order, one handoff, independent OS egress, final location, preserved app data and the newly running version. Keep the Windows tracks closed pending the results.

## Release candidates

**In-place installation (#202) and the Restart screen (#204) are on `main`.** Keep Stable and Windows closed until the signed upgrade trial passes on all three systems. The Mac beta above is published with the owner's authorization, and its first two signed builds are its trial.

## Make a candidate

Stable and Beta each have a fixed feed. Stable uses `X.Y.Z`. A beta takes the checked-in desktop version, increments its patch and appends the UTC day and numeric workflow run. For example, from `0.1.0`, run 9 on November 19, 2026 gives `0.1.1-beta.20261119.9`. Run 10 follows it. Both precede stable `0.1.1`. A selected ref can have an old base. Check its version against the actual feeds.

The Windows packager wraps its x64 app in a 32-bit NSIS installer. Before upload, the Windows job reads the PE header of `apps/desktop/dist/win-unpacked/Clawtrate.exe` and requires AMD64. It records that observation alongside the installer.

1. In Actions, choose **Desktop release candidate**, **Run workflow** and a reviewed source ref. Select `stable` and enter the exact version, or select `beta` and leave the version blank. The workflow passes the Beta track on as `nightly`, its identifier in the code. Rerunning failed jobs keeps a successful version selection. Rerunning all jobs selects a new epoch and can change the beta's date after UTC midnight. Start a fresh dispatch for a new candidate and retain its source commit and epoch.
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
2. Save a local copy of each feed currently served and keep a private release history. After withdrawal the current feed alone cannot tell you the highest version ever offered. Choose a new version above the versions it supersedes, including the withdrawn version. Never reuse a published version or object name. Keep betas between the last stable and the next intended stable.
3. Prepare the same trusted signing identities used for the preceding build. On Mac, use a Developer ID Application certificate in `CSC_LINK` with `CSC_KEY_PASSWORD`, or an identity in `CSC_NAME`. For notarization, use `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN_PROFILE` with optional `APPLE_KEYCHAIN`. On Windows use `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`, or `CSC_LINK` and `CSC_KEY_PASSWORD`. Keep credentials and signed build logs on private builders. See [Packaging](packaging.md#signing-and-notarizing).

### Build and verify the exact bytes

On both native builders use fresh checkouts of the approved commit. Install dependencies and set the same `SOURCE_DATE_EPOCH` (whole UTC seconds), `CLAWTRATE_UPDATE_FEED_URL` and `CLAWTRATE_NIGHTLY_UPDATE_FEED_URL`. Preserve the epoch selected for the candidate. For a beta, its UTC day must match the version. Run `node apps/desktop/packaging/candidate-build.ts staging <version>` from each checkout root. Copy both folders' contents into one fresh `candidate` directory. Set `BUILD_DATE` to the epoch in UTC ISO format with milliseconds.

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
