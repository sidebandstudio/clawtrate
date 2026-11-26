# Publishing the bots plugin to npm

A gateway on another computer installs Clawtrate's bots plugin from npm, as `@clawtrate/clawtrate-bots`. The workflow [`plugins-publish.yml`](../../.github/workflows/plugins-publish.yml) publishes it with npm's trusted publishing: npm accepts the workflow's GitHub OIDC token, so no npm token is stored anywhere. The design is section 6.9 of `docs/design/bots-in-clawtrate.md`.

## What it does

The workflow starts only by hand, on `main`. Its one input is `mode`: `publish` or `bootstrap`. There is no commit to choose. Both jobs check out the run's own commit, which is `main`'s head when the run started, and run the script from that commit. Each job first checks that the run's ref is exactly `refs/heads/main`. A job's `if:` alone would let `refs/heads/Main` through, because GitHub compares there without case. Pack then checks that the commit is on `main`, read fresh from the repository.

It runs on GitHub's standard Linux runner, with Node 26.13.0 and its npm 11.20.0, each pinned. Trusted publishing needs Node 22.14.0 or later and npm 11.5.1 or later ([npm's documentation](https://docs.npmjs.com/trusted-publishers), last edited 2026-10-06). The workflow can only read the repository. The one job that publishes also gets `id-token: write` and runs in the `npm` environment. It uses no secret.

[`apps/desktop/packaging/plugin-npm.ts`](../../apps/desktop/packaging/plugin-npm.ts) does the packing and publishing, and [its tests](../../apps/desktop/test/plugin-npm.test.ts) cover it.

## `publish`

1. The **Pack** job packs `plugins/clawtrate-bots`. It copies into a clean folder only the files its `package.json` `files` list names, plus its README, the repository's `LICENSE` and a `package.json` without `private`. Nothing else in the plugin's folder is packed, such as a `.npmrc` of its own. The in-repo `package.json` keeps `private`, so nobody can publish it from a checkout by accident.

   Packing fails when any of these is true:
   - `package.json` has any dependency, or a `main`, `bin` or `browser` field.
   - Its version isn't an exact `x.y.z`.
   - Its `files` list is missing or holds anything but plain relative paths.
   - It has no `openclaw.extensions`.
   - `openclaw.plugin.json`'s id isn't the plugin's folder name.
   - The list leaves out the manifest or a file OpenClaw runs.
   - A listed folder holds a link or a name starting with a dot.
   - The tarball's files aren't exactly the expected ones.

   The job uploads the tarball as the `package` artifact and prints its commit, name, version and `sha512-…` integrity.

2. The **Publish** job checks that the tarball is still the bytes Pack hashed, and that its own `package.json` and `openclaw.plugin.json` name the package, version and plugin id Pack reported. Then it asks the registry for that version:
   - If the registry has no such version, it checks again that the run's commit is on `main`. Then it runs `npm publish <tarball> --provenance --access public` and reads `npm view @clawtrate/clawtrate-bots@<version> dist.integrity` back. It fails unless the two integrities match.
   - If the registry already has it with the same integrity, it publishes nothing and succeeds.
   - If the registry has it with another integrity, it fails. A published version is never replaced, so raise the plugin's version.
3. Publish puts the commit, name, version, integrity and whether it published now in the summary and in the job's outputs. It uploads `plugins.lock.json` as the `plugins-lock` artifact.

The same files give the same tarball. npm gives every file one fixed time and a fixed order, and the npm version is pinned.

A failed Publish job doesn't prove nothing was published, because npm may have taken the version before a later step failed. Run the workflow again on the same `main`. If the registry has that version with the same integrity, the job publishes nothing and writes the lock.

## The lock

`plugins.lock.json` describes the published bytes. Each entry is read from the tarball's own `package.json` and `openclaw.plugin.json`, not from the checkout:

```json
{
  "plugins": [
    {
      "name": "@clawtrate/clawtrate-bots",
      "version": "0.1.0",
      "integrity": "sha512-…",
      "pluginId": "clawtrate-bots",
      "tools": [],
      "hooks": [],
      "commit": "<the full commit packed>"
    }
  ]
}
```

- `integrity` is the registry's `dist.integrity`, which matched the tarball's own.
- `tools` and `hooks` are what the manifest declares, counted the way OpenClaw 2026.10.6 counts them for its capability review (`buildPluginCapabilitySummary`). `tools` is `contracts.tools` together with the keys of `toolMetadata`, and `hooks` is `hooks`. Both are sorted and empty when the manifest declares none.

The app installs the plugin disabled, compares what `plugins.inspect` reports against the list built into the signed app, and only then enables it. The release that builds that list reads this lock. That step is not built yet.

The release can't call this workflow with `workflow_call`. npm checks a trusted publisher against "the calling workflow's name instead of the workflow that actually contains the publish command" ([npm's troubleshooting](https://docs.npmjs.com/trusted-publishers)). So the release dispatches it on `main`, which packs `main`'s head. A plugin that didn't change keeps its version, and the same files give the same tarball. So the release also packs the plugin from its own release commit and compares that integrity with the lock's. A difference fails the release.

## `bootstrap`

npm sets up a trusted publisher only on a package that already exists, so its first version has to be published once by hand. `bootstrap` packs that first version: `@clawtrate/clawtrate-bots@0.0.0`, a placeholder with no code. It holds a `package.json` with no `openclaw` entry and a README that says it is a placeholder, so it can't be installed as a plugin. The job uploads it as the `placeholder` artifact and prints its commit, file name and integrity in the summary. It publishes nothing and doesn't get the OIDC token.

## Setting it up

This is done once, after the workflow is on `main`, in this order:

1. **Create the `npm` environment first**, and check it before you register anything with npm. In the repository's settings, add an environment named `npm`. Under deployment branches, choose selected branches with one rule: the branch `main`. It has no secrets. Check it:

   ```bash
   gh api repos/{owner}/{repo}/environments/npm --jq .deployment_branch_policy
   gh api repos/{owner}/{repo}/environments/npm/deployment-branch-policies --jq '.branch_policies[] | {name, type}'
   ```

   The first command must print `{"custom_branch_policies":true,"protected_branches":false}`. The second must print one rule, `{"name":"main","type":"branch"}`. This repository's `npm` environment is set up this way.

   This comes first because GitHub creates a missing environment, with no protection, when a workflow job names it. The workflow doesn't check the rule itself. GitHub's documentation lists reading an environment under the Actions permission, and the workflow's token has only `contents: read`.

2. Run `bootstrap` and publish the placeholder by hand.
3. Set up the trusted publisher on npm. It names this workflow's file name and the `npm` environment.
4. Within two days, run `publish` once.

Section 6.9 of the design has the exact steps for 2 to 4.
