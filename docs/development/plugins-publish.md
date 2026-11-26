# Publishing the bots plugin to npm

A gateway on another computer installs Clawtrate's bots plugin from npm, as `@clawtrate/clawtrate-bots`. The workflow [`plugins-publish.yml`](../../.github/workflows/plugins-publish.yml) publishes it with npm's trusted publishing: npm accepts the workflow's GitHub OIDC token, so no npm token is stored anywhere. The design is section 6.9 of `docs/design/bots-in-clawtrate.md`.

## What it does

The workflow starts only by hand, on `main`, and a run from any other branch does nothing. It takes two inputs:

- `mode`: `publish` or `bootstrap`.
- `commit`: a full 40-character commit on `main`. It is empty by default, which means `main`'s head. The workflow refuses a commit that isn't an ancestor of `main`.

It runs on GitHub's standard Linux runner, with Node 26.13.0 and its npm 11.20.0, each pinned. Trusted publishing needs Node 22.14.0 or later and npm 11.5.1 or later ([npm's documentation](https://docs.npmjs.com/trusted-publishers), last edited 2026-10-06). The workflow can only read the repository. The one job that publishes also gets `id-token: write` and runs in the `npm` environment. It uses no secret.

[`apps/desktop/packaging/plugin-npm.ts`](../../apps/desktop/packaging/plugin-npm.ts) does the packing and publishing, and [its tests](../../apps/desktop/test/plugin-npm.test.ts) cover it.

## `publish`

1. The **Pack** job checks out `commit` and packs `plugins/clawtrate-bots`. It packs a copy of the folder with the repository's `LICENSE` and a `package.json` without `private`. The in-repo `package.json` keeps `private`, so nobody can publish it from a checkout by accident. It already has the scoped name and the `files` list, which leaves out the tests and the development gateway's contract file. Packing fails when that `package.json` has any dependency, has a version that isn't an exact `x.y.z`, or has no `files` list, and when the tarball lacks the plugin's manifest or the code it runs. The job uploads the tarball as the `package` artifact and prints its name, version and `sha512-…` integrity.
2. The **Publish** job checks that the tarball is still the bytes Pack hashed, then asks the registry for that version:
   - If the registry has no such version, it runs `npm publish <tarball> --provenance --access public`. It then reads `npm view @clawtrate/clawtrate-bots@<version> dist.integrity` back and fails unless it matches.
   - If the registry already has it with the same integrity, it publishes nothing and succeeds.
   - If the registry has it with another integrity, it fails. A published version is never replaced, so raise the plugin's version.
3. Publish puts the name, version, integrity and whether it published now in the summary and in the job's outputs. It uploads `plugins.lock.json` as the `plugins-lock` artifact, with the package, version, integrity and plugin id. A release reads this file to write the plugin's version and integrity into the signed app. That step is not built yet. A release has to dispatch this workflow, not call it with `workflow_call`. npm checks a trusted publisher against "the calling workflow's name instead of the workflow that actually contains the publish command" ([npm's troubleshooting](https://docs.npmjs.com/trusted-publishers)).

The same commit gives the same tarball. npm gives every file one fixed time and a fixed order, and the npm version is pinned.

## `bootstrap`

npm sets up a trusted publisher only on a package that already exists, so its first version has to be published once by hand. `bootstrap` packs that first version: `@clawtrate/clawtrate-bots@0.0.0`, a placeholder with no code. It holds a `package.json` with no `openclaw` entry and a README that says it is a placeholder, so it can't be installed as a plugin. The job uploads it as the `placeholder` artifact and prints its file name and integrity in the summary. It publishes nothing and doesn't get the OIDC token.

## After this workflow is on `main`

The owner does a one-time setup:

1. Run `bootstrap` and publish the placeholder by hand.
2. Set up the trusted publisher on npm. It names this workflow's file name and the `npm` environment.
3. Within two days, run `publish` once.

The steps are in section 6.9 of the design. Before the first `publish`, GitHub needs the `npm` environment, with deployments limited to the `main` branch, no tag rule and no secrets.
