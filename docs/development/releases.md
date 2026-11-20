# Desktop release candidates

Stable and Nightly each have a feed. A feed offers one version to people who selected that track. The desktop engine compares the three version numbers first. At the same three numbers the stable build follows every nightly. Nightlies sort by UTC date, then by numeric run number.

The checked-in desktop package version is the last stable base. For example, from `0.1.0`, run 9 on November 19, 2026 gives `0.1.1-nightly.20261119.9`. Run 10 that day follows it. Both follow `0.1.0` and precede `0.1.1`. Keep the base current after releasing stable. Use a fresh run for a new candidate and never reuse a published version for different bytes.

## Make an unsigned candidate

1. In Actions, select **Desktop release candidate** and **Run workflow**. Choose the source ref. For Stable, choose `stable` and enter the exact version. For Nightly, choose `nightly` and leave the version blank. The workflow chooses the next patch, UTC date and workflow run number. An explicit nightly input must match that calculation. Starting the workflow by hand is the only trigger.
2. Download `candidate-<version>` within three days. It contains both Mac ZIPs, the Windows installer, a build receipt per file, `update-feed.json` and `release-plan.json`. Keep the receipts with the files. They record what the trusted builders observed. The feed fixes the size, SHA-512 and versioned address of each download.
3. Read the plan. `issues` lists inconsistent or missing evidence. `holds` lists reasons a consistent candidate cannot ship. A successful workflow has no issues, two ad hoc Mac apps, an unsigned Windows installer and placeholder feed addresses. Its verdict is **not publishable**.

To recheck a downloaded folder, run the following from the source checkout after `pnpm install`. Use the selected track's feed URL, the full commit from the run, and its UTC build time. The command reads the existing feed and rewrites the plan. Exit 0 means the local candidate passed, 1 means the plan found an inconsistency or could not run, and 2 means publication is on hold.

```sh
node apps/desktop/packaging/release-plan.ts check candidate "$TRACK" "$VERSION" "$COMMIT" "$BUILD_DATE" "$FEED_URL"
```

## Owner procedure

1. Choose a direct HTTPS host and approve its costs. Give each track a fixed feed address such as `/stable/feed.json` or `/nightly/feed.json`. Each file goes beside that feed in a folder named for the full version, for example `/stable/0.1.1/Clawtrate-0.1.1-mac-arm64.zip`. Serve the feed and files on one origin, with no credentials or redirects. Ordinary GitHub Release download URLs redirect. The engine refuses those redirects.
2. Prepare the signing identities on private build machines. macOS needs a Developer ID Application certificate in `CSC_LINK` with `CSC_KEY_PASSWORD`, or a keychain identity in `CSC_NAME`. For notarization, set one complete group from the table below. On Windows use a trusted signing certificate in `WIN_CSC_LINK` with `WIN_CSC_KEY_PASSWORD`, or the `CSC_LINK` and `CSC_KEY_PASSWORD` pair. Keep signed build logs private. [Packaging](packaging.md#signing-and-notarizing) covers certificate formats and preflight checks.
3. On Mac and Windows, check out the same approved full commit in fresh checkouts and run `pnpm install --frozen-lockfile`. Set the same `SOURCE_DATE_EPOCH` (whole UTC seconds) and build-time feed addresses on both. Set `CLAWTRATE_UPDATE_FEED_URL` for Stable and `CLAWTRATE_NIGHTLY_UPDATE_FEED_URL` for Nightly. From each checkout root run `node apps/desktop/packaging/candidate-build.ts staging <version>`. The command sets the package version for the build and restores it afterward. It records the checkout commit, build date, file digest and signature readback alongside each file.
4. Copy the contents of both staging folders into one new `candidate` folder. Set `BUILD_DATE` to the ISO UTC time of that epoch with milliseconds (for example `2026-11-19T00:00:00.000Z`). Run the recheck command above with `assemble` in place of `check`. Require exit 0. Inspect the signing identities against your intended Apple team and Windows publisher. The plan checks the Mac ZIP's Developer ID signature and stapled notarization ticket for a certificate build, and a valid Authenticode signature on the Windows installer.
5. Before offering the track, test two consecutive signed builds on Apple silicon, Intel Mac and Windows x64 in a controlled deployment. Install the older build, check its track, download the newer build through the app, apply it and relaunch. Verify the new version, signer continuity, installation location and preserved user data. Record the two commits, versions and results. The current desktop host can verify a download. Offering a track must wait for the in-place install path and successful device checks.
6. Keep the last good feed and its files for each track. Upload only the three new binaries to their immutable versioned paths. Fetch each URL directly over HTTPS without following redirects. Require HTTP 200, then compare the downloaded byte length and base64 SHA-512 with the plan. When all three match, atomically replace only that track's feed with the checked `update-feed.json`. Fetch the feed from its fixed address and compare it with the local copy. Put release notes on the project's release page.

| Notarization method   | Variables                                                  |
| --------------------- | ---------------------------------------------------------- |
| App Store Connect key | `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`    |
| Apple ID              | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Keychain profile      | `APPLE_KEYCHAIN_PROFILE`, optionally `APPLE_KEYCHAIN`      |

### Withdraw a release

Restore the last good feed at the affected track's fixed URL. Fetch it and verify that it still points to the retained files. The engine never downgrades. People who installed the withdrawn version need a newer signed fix. Preserve the last good files while any supported build or feed needs them.

Host selection, credentials, paid services, signed upgrade trials, tags, publication and withdrawal stay with the owner. The workflow has read-only repository access and retains its build outputs as temporary workflow artifacts. It has no schedule or publishing job.
