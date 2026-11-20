# Desktop release candidates

**Updating in place is not built yet.** The desktop host can verify a download. Installation is a later app change. Keep both tracks closed until installation exists and the signed upgrade trial below passes on all three systems.

## Make a candidate

Stable and Nightly each have a fixed feed. Stable uses `X.Y.Z`. A nightly takes the checked-in desktop version, increments its patch and appends the UTC day and numeric workflow run. For example, from `0.1.0`, run 9 on November 19, 2026 gives `0.1.1-nightly.20261119.9`. Run 10 follows it. Both precede stable `0.1.1`. A selected ref can have an old base. Check its version against the actual feeds.

The current Windows packager wraps its x64 payload in a 32-bit NSIS installer. The candidate check requires an AMD64 installer header, so the Windows job stops before upload. Producing a complete candidate requires a compatible installer toolchain or a revised check of the embedded application.

1. In Actions, choose **Desktop release candidate**, **Run workflow** and a reviewed source ref. Select `stable` and enter the exact version, or select `nightly` and leave the version blank. Nothing schedules a build. Treat a rerun as a dry-run retry. Start a fresh dispatch for a new candidate and retain its source commit and epoch.
2. A successful workflow retains `candidate-<version>` for three days. It contains two Mac ZIPs, a Windows installer, three build records, `update-feed.json` and `release-plan.json`. The native jobs check the staged Mac apps for ad hoc signatures and Windows for an unsigned installer before retention. The assembly job matches its files to those native jobs' checksums.
3. Read the verdict. **Refused** lists inconsistencies. **Complete and consistent** means the file names, file structures, architecture headers, sizes and hashes match, and the recorded build settings agree. The Mac check reads the executable named in the outer app's Info.plist. The Windows check requires an AMD64 PE32+ installer header. The installed payload needs a separate native check. Signing is **not checked by this plan**. A build record can be edited.

Use Node 26, Python 3 and a checkout with `pnpm install --frozen-lockfile`. To recheck the retained files, take the full source commit from the workflow run and the UTC build date from the retained plan. The workflow uses `https://updates.example/stable/feed.json` and `https://updates.example/nightly/feed.json`. Set `TRACK_URL` to the chosen track's build address and `OTHER_URL` to the other address, or `-` if absent.

```sh
node apps/desktop/packaging/release-plan.ts check candidate "$TRACK" "$VERSION" "$COMMIT" "$BUILD_DATE" "$TRACK_URL" "$OTHER_URL"
```

Exit 0 means complete and consistent. Exit 1 means refusal or an error reading or writing the candidate. Without comparison feeds the plan reports that the version was not compared with any published release.

## Owner procedure

### Choose the host, version and identities

1. Choose a direct HTTPS host and approve its costs. Use distinct fixed feeds such as `/stable/feed.json` and `/nightly/feed.json`. Store binaries in a version folder beside their feed, for example `/stable/0.1.1/Clawtrate-0.1.1-mac-arm64.zip`. The plan's local check of the address's form requires canonical unescaped paths and a distinct URL for each configured track. Both addresses, including an absent one, are compared across build records. Verify separately that the host answers, the TLS certificate is trusted by the app, and the bytes served match. The feed and its files must return HTTP 200 on the same origin and port without credentials or redirects. Ordinary GitHub Release download URLs redirect. Configure the feed and CDN to bypass caching or revalidate on every request.
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

Use an isolated HTTPS feed separate from both public tracks, accessible only to the trial machines. Install a signed predecessor compiled with that trial address. Place the exact prospective signed successor files on the trial origin. Generate a trial feed with the same track, version, date, sizes and hashes but with the trial file URLs. Fetch all three files from that origin, verify them, then move the trial feed to the successor. Keep the production candidate and its feed intact.

On Apple silicon, Intel Mac and Windows x64, start on the predecessor, check the trial feed in the app, download, install in place and relaunch. Verify the new version, signer continuity, installation location and preserved data. Record both versions, commits, file digests and results. Open a track only after two consecutive signed builds pass this trial on each system.

### Offer a version

Immediately before uploading, save the live feeds again and repeat the command above with `check` in place of `assemble`. Archive the verified prior feed. Upload the three immutable binaries first. GET each file through the normal CDN route without following redirects. Require HTTP 200 and compare byte length and base64 SHA-512 with the local plan. Only then atomically replace the chosen track's feed. GET it from its fixed URL and verify HTTP 200 and the exact local bytes. Put release notes on the project's release page.

Retain each track's active and last good feeds and files while they serve those roles. Retain files named by other supported manifests throughout their support period. Set and record a retention window for old cached offers before opening the track. Keep superseded files through that window unless withdrawing them.

### Withdraw a version

Restore and verify the last good feed, or disable the feed if this was the first release. Purge cached copies of the old feed. Then remove the withdrawn binaries from their public URLs and purge their CDN copies. Confirm that each withdrawn URL fails through the normal route. A client can hold an offer and request its file without checking the feed again. Removing the files stops those later downloads. In-flight transfers may finish and copies already downloaded remain on devices. Keep a private archive of the release record. Anyone who installed the bad build needs a newer signed build because the engine never downgrades.

The owner controls host costs, credentials, trials, retention, publication and withdrawal. The manual workflow uses read-only repository access and temporary workflow artifacts.
