# Clawtrate installs its own plugins

How the app puts Clawtrate's own OpenClaw plugins on a person's gateway by itself, once, at first setup, and takes them off again, with no outside page, no terminal and no config file for the person (issue #796, part 3). This is a design: it builds nothing. Sections 3, 6 and 11 are written as the specification the install engine is built from.

It extends section 6 of `bots-in-clawtrate.md`, which designed this for `clawtrate-bots` alone, to all of Clawtrate's plugins. It settles what that section left open: what a gateway on another computer can take without a registry, whether loading needs a restart, and what a staged plugin does when the gateway starts again. Where the two documents differ, this one is later and corrects that section: an update or a preconfigured entry runs new code before any check (section 3); `plugins.uninstall` is not an Undo (section 12); and `setEnabled` must be told to preserve the gateway's allowlist (section 6).

**Established** marks what both OpenClaw versions' published packages show (`openclaw@2026.10.6`, the pin, and `openclaw@2026.11.10`), or what a run on a development gateway of each showed. Each fact says which. **Proposed** marks this design's choice. **Not established** marks what was not shown (section 13). `<1006>/…` and `<1110>/…` are paths inside each package. 2026.11.10's `dist/` is minified onto few lines, so for it the file and the function are named instead of a line.

**The runs.** A development instance of each version was started with `pnpm dev-gateway start --instance <name> --no-seed`, 2026.11.10 through `OPENCLAW_BIN`. It had paired operator connections at admin, read-and-write and read-only. Each plugin was packed with `npm pack --ignore-scripts`. The first round ran these on each version:

- an install with `enable: false`;
- `plugins.inspect`, then `plugins.setEnabled`, calling the plugin's own method before and after;
- the hook grant through `config.patch`;
- the archive moved away, then `plugins.reload`;
- installing again;
- `mode: "update"` to a newer and then an older version;
- `plugins.uninstall`;
- `gateway.restart.request`;
- a cold start, with the gateway process stopped and started again on the same state.

The revision added five cases on each version:

- an install with `enable: false` when the gateway's config already has an `enabled: true` entry for the plugin;
- an update with `enable: false` of a plugin that is enabled;
- the voice setting across uninstall and reinstall;
- uninstall of a plugin in `plugins.deny`;
- `setEnabled` against a `plugins.allow` that leaves the plugin out, with and without `allowlistPolicy: "preserve"`.

A `git://` URL served on loopback by a `git daemon` of the run's own stood in for a network git source. `terminal.upload` ran on 2026.10.6 only.

No gateway on another computer was reached. A development gateway listens on loopback, and a connection made to look remote with proxy headers is refused outright (`<1006>/dist/server-start-D6vaUNGz.mjs:7365-7372`). So what a remote connection may do was read from the source, and checked by calling OpenClaw's own rule (section 2).

## The page to decide from

- **On the gateway's own computer, nothing has to be published.** The app carries each plugin as a tarball outside its archive and gives the gateway the file's path. The gateway copies the file into its own managed folder, so the app writes nothing to disk (ran, both versions).
- **The gateway checks nothing that ties the bytes it activates to the bytes Clawtrate checked.** `npm-pack` reads the archive twice. Enabling takes no expected artifact, and the consent token covers the declarations, not the code. Worse, an install with `enable: false` still runs the new code at once in two cases: an update of a plugin that is enabled, and a plugin whose entry is already `enabled: true` (ran, both versions). So the engine works as follows:
  - It pins every identity and capability field.
  - It never stages over an enabled entry; to update, it turns the plugin off first.
  - It stops at any mismatch, any missing field and any lost reply.
  - It says plainly what window is left (section 3).
  - Full binding needs an operation on the gateway's side.
- **No restart.** Install, enable, update, reload and uninstall all apply while the gateway runs, and so does the config write that lets a hook run (ran, both versions). If a gateway ever asks for a restart, the engine stops and says so (section 7).
- **Over Clawtrate's SSH route, the gateway counts the connection as local**, because the forward arrives on its loopback. The app copies the tarball there over its own SSH connection (read, not run).
- **A gateway reached by its address can't take the app's own copy. This one case needs a publish** (sections 5 and 8). Nothing else waits for it.
- **Added at first setup: the reviewed release of `clawtrate-voice` only, and only on a gateway where section 3's checks pass.** The other four wait for their own reviews (section 9). The tool-rules plugin, and anything else that changes how a bot's commands are approved, is never switched on for anyone before its security review (issue #675, and the reviews of #678, #691 and #692).
- **What the person is told is the owner's call, and section 10 is written for either answer.** Either one line installs it, or Clawtrate asks once, plainly, saying what the plugin can see. Each answer covers first setup and people already paired. Both name the hook grant: it lets the plugin's hook receive each bot's prompts and messages.
- **Taking it off is "Take it off", not "Undo".** Removal edits the gateway's allow and deny lists and leaves a marker. It restores nothing (section 12).
- **No automatic updates yet** (section 11). Separate calls can't be ordered, so an older Clawtrate could put an older plugin back.

## Contents

1. Every way a gateway takes a plugin
2. Local and remote, and which connection is which
3. The engine on the gateway's own computer
4. The route over SSH
5. The route by address
6. Access, and the gateway's own policy
7. Restart
8. Publishing, for the route by address
9. The five plugins, and what each changes
10. What a person sees, and each failure
11. Updates, and two Clawtrates on one gateway
12. Taking a plugin off
13. Not established
14. What must exist first, and the order of pull requests

## 1. Every way a gateway takes a plugin

**Established** (both versions' `docs/gateway/protocol/rpc-system-and-channels.md`, `<1006>` lines 100-123, `<1110>` lines 103-126):

| Source                | What it names                                 | From a remote connection                                         |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `npm-pack`            | an archive's path on the gateway's computer   | refused                                                          |
| `local`               | a folder or archive on the gateway's computer | refused                                                          |
| `marketplace`         | a marketplace and a plugin                    | refused                                                          |
| `git`                 | a git URL and a ref                           | allowed for a network URL; a `file:` URL is refused              |
| `npm`                 | a registry package and exact version          | allowed; takes `expectedIntegrity`, `expectedPluginId` and `pin` |
| `clawhub`             | a package on OpenClaw's registry              | allowed                                                          |
| `official`, `bundled` | OpenClaw's own plugins                        | not for Clawtrate's                                              |

Each install also takes `mode: "install" | "update"`, `enable`, `acknowledgeInstallPolicyWarning` and `acknowledgeCapabilities: {reviewToken}`. The npm source accepts only a registry name and version. A URL, a git ref or any other protocol spec is refused (`<1006>/dist/npm-registry-spec-B_IER0ZB.mjs:17-28`; the same messages in `<1110>/dist/npm-registry-spec-D06XlvdA.mjs`), so a tarball on a web page can't be installed through it.

**Other ways in, and why none is the route:**

- **`plugins.load.paths` in the gateway's config** loads a folder in place. `pnpm dev-gateway start --with-plugin` uses it. The tool copies a checked snapshot of the plugin into the instance's own state folder, and writes that path and the plugin's entry into the config before the gateway starts (`tools/dev-gateway/src/dev-plugins.ts`, its header; `tools/dev-gateway/src/cli.ts:628`).
  - On a person's gateway it needs the files on that computer first.
  - The only folders a remote connection can write through the gateway's methods are a bot's workspace (`agents.files.set`, `sessions.files.set`) and a terminal's 24-hour temporary folder.
  - Code that runs inside the gateway must not live where a bot can rewrite it, or where it expires.
- **`skills.upload.*`** takes a skill archive into the default bot's workspace (`<1006>/docs/gateway/protocol/operator-methods.md:75-94`; `<1110>/…:114-133`). A skill is not a plugin.
- **The operator terminal** (`terminal.open`, `terminal.input`, `terminal.upload`, all `operator.admin`) could stage the archive and type `openclaw plugins install` into a shell on the gateway's computer.
  - `terminal.upload` staged a tarball in a private temporary folder, and `npm-pack` installed it from there on a local connection (ran, 2026.10.6; the same method is in `<1110>/docs/gateway/protocol/rpc-system-and-channels.md:290`).
  - As a route it opens a login shell outside any sandbox, in the person's home (the run's answer was `confined: false`).
  - It depends on `gateway.terminal.enabled` and an unsandboxed bot, and it gives no structured answer.
  - Rejected.

**The repository today.**

- **Nothing is published.** The registry answers 404 for `@clawtrate/clawtrate-bots`.
- **Only `clawtrate-bots` can be packed and published.**
  - `plugins-publish.yml` and `apps/desktop/packaging/plugin-npm.ts` handle it alone.
  - Their tests (`apps/desktop/test/plugin-npm.test.ts`) pin that one package and the lock's form (`docs/development/plugins-publish.md`, "The lock").
  - Its `bootstrap` mode ran once, on 2026-11-26, and packed the placeholder. The placeholder was not published, so no trusted publisher exists yet.
- **The other four `package.json`s have no `@clawtrate/` name and no `files` list.**
- **The voice plugin's manifest declares no hooks.** So `plugins.inspect` reports `declared.hooks: []` for it (ran, both), although its code registers a prompt hook, which needs the conversation-access grant. A declared-surface comparison can't see that hook until the manifest names it. The fix is in step 1 of section 14.
- **The READMEs describe manual steps.** Each one tells a gateway's owner to run `openclaw plugins install --link` from a checkout and to set the hook grant by hand. The voice plugin's README says "Clawtrate never writes the gateway's config". This design replaces both (section 14).

## 2. Local and remote, and which connection is which

**Established.** `plugins.install` refuses `npm-pack`, `local`, `marketplace` and a local git URL unless the gateway counts the connection as local. The error is "Local plugin artifacts require a connection from the Gateway host." (`<1006>/dist/plugins-mutations-ClrWTX5-.mjs:72-73`; the same check in `<1110>/dist/plugins-mutations-MjAXEDgk.mjs`).

A local connection is a direct one from a loopback address, with no forwarding or Tailscale headers (`<1006>/dist/ingress-attribution-BQX5Ye8B.mjs:107`, `message-handler-CRCo2VX0.mjs:3419`; `attributed("direct-local", …)` in `<1110>/dist/ingress-attribution-CsgYtK-V.mjs`).

The rule itself, `pluginInstallRequiresLocalHost`, was called from each version's own module with ten requests, and both versions answered the same (`<1006>/dist/install-source-plan-CNjlQOX3.mjs:22-31`; `<1110>/dist/install-source-plan-BXa2Slf_.mjs`):

- `npm-pack`, `local`, `marketplace` and a `file:` git URL need a local connection;
- `npm`, `clawhub`, and an `https`, `git://` or GitHub-shorthand git URL don't.

So, for Clawtrate's three kinds of route (`setup.md`):

- **This computer** (one-click Connect, #688 and #689, or an address typed as `ws://127.0.0.1`): the app's own socket to loopback. Local (ran: every install in the runs used such a connection).
- **SSH**: the app's forward is `ssh -L 127.0.0.1:<free port>:127.0.0.1:<gateway port>` (`docs/decisions.md`, "SSH to another computer"). The gateway's side of it is `sshd` connecting from loopback, so it is local by the rule above (read, not run). The paths it names are on that other computer.
- **By address** (`wss://`, Tailscale Serve, a LAN address): not local. Tailscale Serve's connections are attributed `tailscale-serve`, never `direct-local`.

**Proposed:** the app chooses the route by the connection it made, and confirms it by the gateway's answer. A refusal with the local-artifact error moves it to the route by address, never the other way.

## 3. The engine on the gateway's own computer

### 3.1 What the gateway binds, and what it doesn't

**Established:**

- **`npm-pack` reads the archive twice.** The metadata and integrity that `plugins.inspect` later reports come from one read (`resolveNpmPackArchiveMetadata`, `<1006>/dist/install-TaW64_lP.mjs:661`). The file is then opened again and copied into the gateway's managed folder (`stageNpmPackArchiveInManagedRoot`, the same file, line 655), and npm installs from that copy. The same two steps appear in `<1110>`'s `installPluginFromNpmPackArchive`. Over RPC `npm-pack` takes no expected integrity: the schema refuses the field (ran, both).
- **`enable: false` only skips the enabling step, and the change still applies at runtime.**
  - It writes no new entry and leaves `plugins.allow` and `plugins.deny` alone (`<1006>/dist/management-install-CiDYuS33.mjs:198-208`, the `persistPluginInstall` region).
  - It keeps an entry that already says `enabled: true`. Ran, both versions:
    - **A preconfigured entry.** With `plugins.entries.clawtrate-voice.enabled: true` written before the plugin existed, an install with `enable: false` came back with the plugin's source digest. `plugins.list` showed it `runtime.state: "active"`, and its method answered: the code ran before anything was inspected.
    - **An update.** With 0.1.0 enabled, `mode: "update"` with `enable: false` to 0.2.0 published a new runtime generation with a new source digest. `plugins.list` reported 0.2.0 active.
  - Only a fresh install with no entry stayed unloaded, across `gateway.restart.request` and a cold start of the process as well (ran, both).
- **Enabling takes no expected artifact.** `plugins.setEnabled` accepts `{pluginId, enabled, allowlistPolicy?, acknowledgeCapabilities?}` (`<1006>/dist/sessions-B6HQw2nf.mjs:909-914`; the same schema in `<1110>`).
- **The consent token doesn't bind the code.** `reviewToken` is a hash of the declared surface (`computeDeclaredSurfaceHash(declared)`, `<1006>/dist/capability-summary-CFDZfvsK.mjs:147`), and the declared surface comes from the manifest (line 91), not from the code.
- **After enabling, the runtime receipt names what was loaded.** `runtime.sourceDigests[<id>]` is a SHA-256 of the captured source. It was the same for the same package on both versions (voice 0.1.0: `ecb5bdf1…`), and it changed with the package (ran).

So OpenClaw has no operation that says "activate exactly the archive with this SHA-512". **Full binding of bytes to activation needs one on the gateway's side**, for example `plugins.setEnabled` or `plugins.install` taking an expected integrity or install hash, checked under its own mutation lock against the copy it loads. `plugins.reload` already takes `installHash` and `sourceDigests` preconditions (rpc page, `<1006>` line 118), but it doesn't enable.

### 3.2 The window that is left, and why it is accepted here

Two windows remain after the checks below:

- between the gateway's read of the archive's metadata and its copy of the archive;
- between `plugins.inspect` and `plugins.setEnabled`, while the staged copy sits in the gateway's own state folder.

To use either, a process has to write the app's tarball inside the app's resources, or the gateway's state folder, within seconds.

On a gateway on the same computer, reached by one-click Connect, Clawtrate's check has already shown that the gateway runs as this account (#688). The processes that can write either place are this account's, and an administrator's. Each of them can already rewrite the gateway's config, its installed plugins and OpenClaw itself, and read the gateway's token. The window gives them nothing they don't already have.

**So it is accepted for a gateway on the same computer after that check, and for the SSH route** (its folder is private to the account the person signs in as, which runs the gateway). It is not accepted for an address typed under Advanced: there is no such check there, and the engine doesn't run on it (3.3, step 0).

After activation, the engine compares `runtime.sourceDigests[<id>]` with the digest the release recorded (step 7). That detects different code once it has run, and turns it off. It does not prevent the code from running.

### 3.3 The sequence

**Proposed. This is the engine's specification.** Every step names its call, its comparison and where it stops.

**Stops.** "Stop" means: no further write, a line from section 10, and the gateway's own answer kept behind an "i". A lost reply is a stop: a timeout, a closed connection, or an answer missing a field this section compares. On the next connection, the engine starts again from step 1 and decides from what it reads. It never repeats a write blindly.

**The pin.** Built into the signed app, from the release's own packing, one entry per plugin the app carries. Any field missing from the pin means the plugin is not installed.

- `packageName`
- `version`, canonical `x.y.z`
- `pluginId`
- `integrity`, `sha512-…`
- `declared`: every group `plugins.inspect` reports, each as a sorted list: `channels`, `providers`, `tools`, `contracts`, `hooks`, `mcpServers`, `cliCommands`, `cliBackends`, `skills`, `dangerousConfigFlags`. A group the pin lacks, or one the gateway reports that the pin doesn't list, is a mismatch.
- `grants`, kept separately: the exact config the plugin is given. For `clawtrate-voice` that is `{hooks: {allowConversationAccess: true}}`.
- `sourceDigest`: `runtime.sourceDigests[<id>]` as the release's own run on a development gateway of each supported version recorded it, when the two agree.

**Step 0. Preconditions.**

- The connection is the app's own loopback connection made by one-click Connect, after its check (#688), or the SSH route (section 4).
- The gateway's confirmed grant on this connection includes `operator.admin` (section 6).
- `hello-ok.server.version` is a version the pin was recorded on.

If any of these fails, stop. The engine never asks for a scope.

**Step 1. Read.**

- `config.get` gives `hash` as H1 and `plugins`. `plugins.list` and `sessions.list` follow.
- Stop when any of these is true:
  - the plugin is in `plugins.deny`;
  - `plugins.allow` is non-empty and leaves it out;
  - `plugins.entries.<id>` exists in any form. `enabled: true` would run the stage at once, as above. `enabled: false` is the person's "taken off" marker (section 12). Any other entry is the gateway owner's. The one exception: the person's own "Add again" goes on when the entry is exactly `{enabled: false}`, which keeps the stage off.
  - `plugins.list` already lists the plugin. That case is section 11.

**Step 2. Stage.** `plugins.install {source: "npm-pack", archivePath: <the app's tarball>, enable: false}`. Never `mode: "update"`, never `acknowledgeInstallPolicyWarning`, never `acknowledgeCapabilities`.

Compare the answer:

- `ok: true`;
- `restartRequired: false`;
- `plugin.id`, `plugin.packageName` and `plugin.version` equal the pin;
- `runtime.sourceDigests` and `runtime.selectedEntries` have no entry for the plugin, which is the gateway's own statement that nothing of it was loaded (ran: both empty on a fresh stage).

Stop on any difference. One case stops with a step: `runtime.selectedEntries` or `sourceDigests` naming the plugin means its code ran. The engine then calls `plugins.setEnabled {pluginId, enabled: false}` and stops, whatever that call answers.

Other answers:

| Answer                                            | What the engine does                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `UNAVAILABLE` "already running" (ran, both)       | Wait (`retryAfterMs` when given, else 1, 2, 4 seconds), at most three tries, then stop |
| "plugin already exists"                           | Another device staged it: go back to step 1, which then stops for section 11           |
| The local-artifact error                          | Section 5's route                                                                      |
| `install_policy_warning_acknowledgement_required` | Stop with the warning; the engine never acknowledges a warning                         |
| Anything else                                     | Stop                                                                                   |

**Step 3. Inspect.** `plugins.inspect {pluginId}`. Compare, each field required:

- `plugin.id`, `plugin.version`;
- `source.kind` is `"npm"`, which is what an `npm-pack` install records (ran, both);
- `source.packageName` and `source.spec` (`<name>@<version>`);
- `source.integrity` equals the pin, with `source.integrityKind` `"ssri"`;
- every group of `declared` equals the pin;
- `reviewToken` is present.

On a difference, go to step 8.

**Step 4. Read again.** `config.get` gives H2. Every stop of step 1 applies again. The plugin's entry must still be absent, or exactly `{enabled: false}` for "Add again". `plugins.list` must show it with `runtime.state: "unloaded"`. Otherwise stop: another device or the owner acted in between.

**Step 5. Grant.** Only when the pin's `grants` aren't empty. If `sessions.list` shows a run going (`hasActiveRun`), wait for it, at most five minutes, then stop (section 7). Then `config.patch {baseHash: H2, raw: <exactly the pin's grants under plugins.entries.<id>>}`.

- A stale base hash: back to step 4 once, then stop.
- The new entry must hold only the grants, and for "Add again" the `enabled: false` it had; `enabled: true` in it is a stop.

**Step 6. Enable.** `plugins.setEnabled {pluginId, enabled: true, allowlistPolicy: "preserve", acknowledgeCapabilities: {reviewToken: <step 3's>}}`.

- The answer must have `ok: true` and `restartRequired: false`.
- "blocked by allowlist" and "blocked by denylist" (ran, both) are stops.

**Step 7. Confirm.**

- `plugins.list`: the plugin is `runtime.state: "active"` at the pinned version.
- `runtime.sourceDigests[<id>]` from step 6's answer equals the pin's `sourceDigest`, when the pin has one.
- `plugins.inspect` again: `source.integrity` still equals the pin.
- The plugin's own method answers, with the version it reports.

On any difference: `plugins.setEnabled {pluginId, enabled: false}`, then stop. The line then says what the gateway reports, for example "turned off; its entry says `enabled: false`".

**Step 8. Removing a stage that didn't match.**

- `plugins.uninstall {pluginId}` only when all of these still hold:
  - the plugin was absent at step 1;
  - step 2's answer named this id;
  - `plugins.list` still shows it unloaded;
  - neither `plugins.allow` nor `plugins.deny` names it (uninstall edits both, section 12).
- Otherwise leave it as staged, unloaded, and stop: its ownership or identity can no longer be shown to be this attempt's.
- After an uninstall, the line says what the gateway confirmed: "removed; the gateway reported it unloaded".

**The copy is the gateway's.** The gateway extracts the archive into `<state>/npm/projects/<id>/node_modules/<package>`. With the app's folder moved away, the plugin kept answering, and `plugins.reload` reloaded it from that copy (ran, both). So an app update, a move, or macOS's translocated launch doesn't break an installed plugin.

**Where the tarball lives.** The packaged app ships it outside `app.asar`: `Clawtrate.app/Contents/Resources/plugins/` on macOS, and `resources\plugins\` beside the executable on Windows (an `extraResources` entry in `apps/desktop/packaging/config.ts`). The gateway reads it with plain Node, which can't read inside an Electron archive. The app writes nothing on the person's disk. This keeps one-click Connect's rule that the app only reads OpenClaw's profile (#688).

## 4. The route over SSH

**Proposed, read and not run.** The SSH screens aren't built yet (`docs/decisions.md`, "SSH to another computer", "Not done here").

1. Over its existing SSH route, the app runs one more constant script, as it runs the LOOK. The script makes a private folder under that computer's temporary folder (`umask 077`, `mktemp -d`), writes the tarball from standard input, and prints the folder's path and the file's SHA-512. A SHA-512 that isn't the pin's is a stop.
2. Section 3.3's steps 0 to 8 run through the forward, with that path. The gateway counts the forward as local (section 2).
3. The app removes its folder by its exact path once the gateway has its copy, or at its next SSH contact if it couldn't then.

`terminal.upload` would do step 1 through the gateway's own methods; section 1 says why it is not the route.

## 5. The route by address

**Established:** no gateway method takes a plugin's bytes from a connection that isn't local. Such a connection can install only a package from a registry (`npm`, `clawhub`) or a git repository on the network.

**Proposed: npm, used only to stage.** Step 2 of section 3.3 becomes `plugins.install {source: "npm", spec: "@clawtrate/<plugin>@<exact version>", pin: true, expectedPluginId, expectedIntegrity: <the pin's>, enable: false}`. Steps 0 and 1, and 3 to 8, are unchanged, with these differences:

- **Step 0 also needs a confirmed admin grant on a remote connection**, and section 3.2's window is not accepted on its own merits here. The gateway's own `expectedIntegrity` check before it installs closes the archive window. Inspect-to-enable remains, open to processes of the account that runs the gateway on that computer, which can already rewrite that gateway.
- **What the gateway checks** (`bots-in-clawtrate.md` §6.3 cites each line):
  - it downloads from its own registry setting;
  - it refuses a different integrity before it installs ("aborted: npm package integrity drift detected", `<1006>/dist/npm-integrity-C9ZL9MoY.mjs:3-27`);
  - it refuses another plugin id;
  - it installs with `--ignore-scripts`.

  These were read, not run: running them needs a registry.

- **The pin is matched on its own.** Its integrity is that of the exact, dependency-free release tarball, which the release packs itself. That the registry later serves the same bytes is the gateway's check, not the pin's source (section 8).

It needs the packages published (section 8).

**The other way, which needs nobody in person, and why it is second.** A gateway can install from a network git URL pinned to a full commit: `plugins.install {source: "git", spec: "git:https://github.com/<owner>/<repo>.git@<40-hex commit>", enable: false}`. Ran on both versions from a `git://` URL on loopback:

- it installed with no install-policy warning;
- `plugins.inspect` reported `integrity: <the commit>` with `integrityKind: "git-commit"`;
- the plugin behaved as one installed from an archive.

It would need a small public repository whose commits each hold one plugin at its root. Its costs:

- the gateway clones the whole repository it is given (`git clone` without `--depth` when a ref is named, `<1006>/dist/git-install-BVB7NPXr.mjs:45-50`), so it can't be Clawtrate's own repository, which is about 2 GB;
- it needs `git` on the gateway's computer, which a container image or a Mac without its developer tools may lack;
- the code is bound only by a SHA-1 commit id, where npm's SHA-512 is checked before anything is written.

**Until a publish exists**, a gateway reached by its address gets no plugin, and Settings says so in one line (section 10).

## 6. Access, and the gateway's own policy

**Established** (`<1006>/dist/core-method-policy-DkntKRY_.mjs:186`, `205`, `1638`, `2004`, `2119`, `2580`; the rpc pages above; ran, both versions):

| Method                                                                         | Scope            |
| ------------------------------------------------------------------------------ | ---------------- |
| `plugins.install`, `plugins.setEnabled`, `plugins.uninstall`, `plugins.reload` | `operator.admin` |
| `config.patch`, `gateway.restart.request`, `terminal.upload`                   | `operator.admin` |
| `plugins.list`, `plugins.inspect`, `config.get`                                | `operator.read`  |

Ran: a read-only connection and a read-and-write connection asking `plugins.install` were both refused `missing scope: operator.admin`, and the read-only one could list the plugins. A plugin's own methods that aren't loaded answer `missing scope: operator.admin` to a connection below admin, and `unknown method` to an admin, as `docs/decisions.md` ("The rules plugin") records. The app tells a missing plugin from `hello-ok.features.methods`.

**Enabling can widen the gateway's allowlist.** Established, `<1006>/dist/management-mutations-BsUMS3ce.mjs:176-213` (`mutateManagedPluginEnabled`): a `setEnabled` without `allowlistPolicy: "preserve"` adds the plugin to a non-empty `plugins.allow`. Ran on both versions, with `plugins.allow: ["clawtrate-voice"]` and `clawtrate-bots` staged:

- `allowlistPolicy: "preserve"` answered "plugin "clawtrate-bots" could not be enabled (blocked by allowlist)" and changed nothing;
- the default call enabled it and rewrote the list as `["clawtrate-voice", "clawtrate-bots"]`.

With `clawtrate-bots` in `plugins.deny`, both calls answered "blocked by denylist".

**Proposed, and part of the specification:**

- **Every write is gated on the connection's current, confirmed grant.** That is the scopes the gateway confirmed for this device in the current hello, not what the app asked for. This applies to `plugins.install`, `config.patch`, `plugins.setEnabled` and `plugins.uninstall`. A connection whose grant lacks `operator.admin` changes nothing; it shows what `plugins.list` says (section 10). If the gateway refuses a write with a scope error mid-sequence, that is a stop.
- **The engine never asks for scopes.** Full control is asked for at pairing (`setup-effortless.md` §2) and through the consented upgrade, never here.
- **`allowlistPolicy: "preserve"` on every `setEnabled`.** The engine never adds a plugin to `plugins.allow` and never removes one from `plugins.deny`.
- **An explicit disable is honoured:** a plugin entry with `enabled: false`, installed or not, is the owner's, and so is a name in `plugins.deny`. Only the person's own "Add again" or "Turn on" in Clawtrate goes past it, and even then never past `plugins.deny`. Clearing deny is OpenClaw's own settings, in #794's design.

## 7. Restart

**Established: none is needed.** "These mutations wait for runtime application without restarting the Gateway" (both versions' rpc page, `<1006>` line 152, `<1110>` line 155). Every install, enable, update, reload and uninstall in the runs answered `restartRequired: false` and published a new runtime generation. A config write under `plugins` is applied hot (`<1006>/dist/config-reload-plan-BmEf0hE9.mjs:292-295`; the same rule in `<1110>/dist/config-reload-plan-BR9X4bST.mjs`). That rule's actions are `reloadPlugins` and `disposeMcpRuntimes`: the grant's `config.patch` disposes the gateway's MCP runtimes.

**What a person's bots and tasks experience.** A run already going keeps the plugins it started with: the rules checks saw a run go on asking after the rules plugin was turned off in the middle of it (`docs/decisions.md`, "The rules plugin"). The voice guide reaches each bot from the next system prompt the gateway builds. What disposing MCP runtimes does to an MCP call in flight was not run.

**Proposed:**

- **Defer while the gateway is busy.** The grant's `config.patch` (section 3.3, step 5) waits until `sessions.list` shows no run going, at most five minutes, and otherwise stops with "Clawtrate will add Bot voice when your bots are idle." It is tried again at the next connection.
- **Stop on an unexpected restart requirement.** Any answer with `restartRequired: true` (the docs name edited bundled code, which isn't Clawtrate's case) is a stop. The engine does not restart OpenClaw by itself. The line offers it: "OpenClaw needs a restart to finish adding Bot voice · Restart". That calls `gateway.restart.request {}`, which on both versions answered `status: "scheduled"` with a preflight ("safe to restart now", or the active work that defers it) and restarted the gateway in place (ran). Then the engine reads again from step 1. This is the owner's "one restart, for all plugins together, with one line", given to the person instead of done for them.

## 8. Publishing, for the route by address

Needed only for section 5's npm route. Everything in `plugins-publish.md` and `bots-in-clawtrate.md` §6.9 stands.

**On the repository's side (a pull request, no one in person):**

1. Each plugin to publish gets `"name": "@clawtrate/<folder>"` and a `files` list in its `package.json` (only `clawtrate-bots` has them).
2. `plugin-npm.ts` and `plugins-publish.yml` take the plugin as an input, one of a fixed list, and the lock holds one entry per plugin. Their tests cover each plugin. The packer keeps refusing any dependency field, so the one integrity covers all the code.
3. The release packs every plugin the app carries, from its own commit, and writes the pin (section 3.3) from that packing. It fails when a plugin's bytes changed but its version didn't.

**Once, by the owner in person, one sign-in for all five packages.** npm sets up trusted publishing only on a package that already exists (`docs.npmjs.com/trusted-publishers`, read 2026-11-26). The owner's bootstrap of each placeholder is required, and nobody else publishes anything by hand.

1. The release coordinator runs the workflow with `mode: bootstrap` for each of the five, and checks each placeholder's SHA-512 against the run's summary (`openssl dgst -sha512 -binary <file>.tgz | openssl base64 -A`).
2. The owner signs in to npm in a terminal with two-factor authentication (`npm login`). For each placeholder: `npm publish ./<file>.tgz --access public --tag bootstrap`, then `npm deprecate @clawtrate/<plugin>@0.0.0 "Placeholder: install a released version"`.
3. On npmjs.com, for each package:
   - **Settings**, **Trusted publishing**, GitHub Actions, with organization `sidebandstudio`, repository `clawtrate`, workflow `plugins-publish.yml` and environment `npm`;
   - then **Publishing access**: "Require two-factor authentication and disallow tokens".
4. `npm logout`.
5. Within two days, the release coordinator runs `mode: publish` for each of the five, which validates its trusted publisher.

**Real releases come only from that named workflow**, through OIDC, with no token anywhere. Each release afterwards dispatches it. A plugin that didn't change keeps its version and packs to the same bytes, so nothing new is published. The release compares the registry's integrity with its own packing and stops on a difference (`bots-in-clawtrate.md` §6.9, "The app's release"). No app installs a version its signed pin doesn't name.

## 9. The five plugins, and what each changes

Read from each plugin's README and code. Each loaded and answered on both versions when installed and enabled, except where the table says otherwise:

| Plugin                 | What it changes on a gateway once loaded                                                                                                                                                                                                                                                  | At first setup today                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clawtrate-voice`      | Adds Clawtrate's voice guide to the end of each bot's system prompt, in runs whose runner calls its hook, until a person turns it off. It needs the grant that lets its hook receive each bot's prompts and messages; its README says it reads nothing of them. It keeps one setting row. | **Its reviewed release, on gateways where section 3's checks pass.** That needs the manifest fix and the install's security review first (section 14). |
| `clawtrate-bots`       | Adds gateway methods that keep bots' proposed changes and a journal for Undo. It changes no bot by itself today (Apply is reported unavailable). Its tools and holds come later.                                                                                                          | No. Its install waits for the security review its own design requires (`bots-in-clawtrate.md` §10, step 4).                                            |
| `clawtrate-memory`     | Adds methods that list, read and change bots' notes and shared memory files from Clawtrate.                                                                                                                                                                                               | No. Development gateways only, until issue #41's security review.                                                                                      |
| `clawtrate-tool-rules` | Decides every tool call a bot makes by rules (run, ask first, never), through a hook on every call.                                                                                                                                                                                       | **No.** It changes how a bot's commands are approved, so it isn't switched on for anyone before issue #675 and the reviews of #678, #691 and #692.     |
| `clawtrate-computer`   | A browser of its own for each chosen bot, which people watch live and take over. Outside a Clawtrate development instance it registers nothing, by its own guard (`plugins/clawtrate-computer/index.js`; not checked by a run).                                                           | No: issue #29.                                                                                                                                         |

**Proposed:** the pin holds only plugins whose review allows them on everyone's gateway. A plugin joins it in the pull request that follows its review. From then on it is offered to gateways already set up by section 10's "already paired" variant.

## 10. What a person sees, and each failure

**The open question, with the owner:** does installing plugin code that runs inside OpenClaw, with a grant that lets its hook receive prompts and messages, count as a change to OpenClaw that the person must confirm? The design holds under either answer. Only the words and one click differ. Each variant is given for both moments.

**What every variant says about the grant**, in these words or the owner's: "Bot voice adds a short guide to each bot's instructions. To do that, OpenClaw lets the plugin see each bot's prompts and messages; it uses none of them."

**Where it applies.** These lines show only when section 3.3's step 0 can pass:

- the route is this computer, after one-click Connect's check, or later the SSH route;
- the grant being asked for, or held, is full control.

On any other route, or without full control, no line promises an install; the table at the end says what shows.

### First setup

**Variant A: installs with one line.** Directly below the consent line on the card that pairs (`setup-effortless.md` §2), one line:

> "Connecting also adds Clawtrate's plugin for Bot voice to this OpenClaw. It can see your bots' prompts and messages and uses none of them. You can take it off in Settings."

Connect is the consent, as it is for full control. The engine runs after the pairing confirms admin, while the first run goes on. The install took 5 to 13 seconds per plugin on a heavily loaded machine (ran).

**Variant B: asks once, plainly.** The card says nothing about it. After the first run's first screen, one card:

> "Add Bot voice to this OpenClaw? It adds a short guide to each bot's instructions so they talk plainly. To do that, OpenClaw lets the plugin see each bot's prompts and messages; it uses none of them. · Add · Not now"

"Not now" is kept on this device for this gateway, and the card doesn't come back. Settings keeps "Add Bot voice".

### A person already paired, when the app first carries a plugin

**Variant A.** The person's earlier grant of full control authorizes it, with one line saying so. At the next connection with full control, the engine runs, and the status line says once:

> "Added Clawtrate's voice plugin to OpenClaw. It can see your bots' prompts and messages and uses none of them. · Take it off"

**Variant B.** Their click authorizes it. Once, in the status line:

> "Bot voice needs Clawtrate's plugin on OpenClaw. It can see your bots' prompts and messages; it uses none of them. · Add · Not now"

"Not now" is kept as in variant B above.

### Afterwards, in both variants

- Settings, Conversation, Bot voice works with no link and no setup steps.
- Under it, quietly: "Clawtrate's voice plugin is on this gateway · Take it off". There is no Undo, because removing it restores nothing (section 12).
- The outside link Settings shows today (`packages/ui/src/Settings.tsx:392-413`) goes, as #796's first part asks.

### When it isn't installed

One line in the same place, with the gateway's own words behind an "i" where it gave any. Each describes the state the gateway confirmed.

| What happened                                                                                      | What the person sees                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| No full control on this connection                                                                 | "Clawtrate needs full control of this gateway to add its voice plugin." with setup's existing way to get it                                |
| A route the engine doesn't run on: by address before a publish, or an address typed under Advanced | "Clawtrate can't add its voice plugin to this gateway yet."                                                                                |
| The gateway refused the stage                                                                      | "OpenClaw didn't add Clawtrate's voice plugin." · Try again                                                                                |
| The install policy warned                                                                          | "OpenClaw warned about Clawtrate's voice plugin." with the warning, and Add anyway. Clawtrate never acknowledges a warning by itself.      |
| A mismatch at step 3, removed at step 8                                                            | "The plugin OpenClaw got didn't match the one this Clawtrate carries. Clawtrate removed it; the gateway reported it unloaded." · Try again |
| A mismatch it couldn't remove                                                                      | "The plugin OpenClaw got didn't match the one this Clawtrate carries. It is installed and not loaded; Clawtrate left it."                  |
| Turned off at step 7                                                                               | "Clawtrate turned off its voice plugin: what OpenClaw loaded didn't match. Its entry says enabled: false." · Try again                     |
| Busy                                                                                               | "Clawtrate will add Bot voice when your bots are idle."                                                                                    |
| A restart asked for                                                                                | "OpenClaw needs a restart to finish adding Bot voice · Restart"                                                                            |
| An entry that already exists, or a name in `plugins.allow` or `plugins.deny` that keeps it out     | "Turned off in the gateway's settings"                                                                                                     |
| Taken off by the person                                                                            | "Bot voice's plugin isn't on this gateway · Add again"                                                                                     |
| An installed version this app doesn't ship                                                         | Section 11's lines                                                                                                                         |

No line links to a page outside the app.

**Other places.** Only the desktop app installs: it carries the files and makes the local routes. The web viewer and the iPhone app (`apps/mobile`, another thread's) show what `plugins.list` and the plugin's methods say, and change nothing on the gateway's plugins.

## 11. Updates, and two Clawtrates on one gateway

**Established:**

- `plugins.list` gives each plugin's `version`, `packageName`, `enabled` and `runtime.state`, and `plugins.inspect` gives its source and integrity.
- **The gateway doesn't refuse an older version:** an update from 0.2.0 to 0.1.0 succeeded on both versions.
- **An update with `enable: false` of an enabled plugin runs the new code at once** (section 3.1).
- **No plugin mutation takes a precondition on the installed version or digest.** The gateway runs one plugin or config change at a time (`UNAVAILABLE` "already running", ran, both), but each request takes its own lease (`withPluginLifecycleLease`, `<1006>/dist/plugins-mutations-ClrWTX5-.mjs:37-43`). A device's read and its later update are two requests, so another device's update can run between them.

**Proposed: no automatic updates** until the gateway can compare the expected current version and digest under its own mutation lock. Until then, the read-before-write check narrows the race but doesn't remove it. If two devices raced, the gateway could end up running the older plugin until a person acts again. So nothing updates by itself.

**Comparing versions.** A version is canonical only as `x.y.z`: three non-negative integers with no leading zeros and nothing after them. Two versions compare numerically, part by part, date-shaped triples included (`2026.11.10` is newer than `2026.9.30`). These are left alone, with "This gateway has another copy of Bot voice's plugin; Clawtrate leaves it as it is.":

- a prerelease;
- a build suffix;
- any other form;
- the same version with another integrity;
- a package name, plugin id or source kind the pin doesn't know;
- a plugin installed another way (a linked checkout, a path, git).

**An update the person asks for.** It is offered only when every one of these holds:

- the installed copy is one Clawtrate shipped: its name, version and integrity are in this app's table of shipped releases, which the release carries forward;
- it is older than the pin;
- step 0 passes.

Settings shows: "A newer Bot voice plugin comes with this Clawtrate · Update". Update runs:

1. `config.get` and `plugins.list` (H1). The installed name, version and integrity are a shipped release older than the pin.
2. `plugins.setEnabled {pluginId, enabled: false}`, so that the staged update can't run, given 3.1.
3. `plugins.install {source: "npm-pack", archivePath, enable: false, mode: "update"}`, with step 2 of section 3.3's answer checks.
4. Section 3.3's steps 3 to 7. The grant is already there, so step 5 checks it and writes only what is missing.

A stop after step 2 leaves the plugin installed and turned off, and the line says so: "Bot voice's plugin is turned off; its entry says enabled: false. · Turn on". Bot voice is away for seconds during an update.

**A newer copy than this app ships** is never touched. The app uses it when its methods are ones the app knows. Each plugin keeps its previous method shapes working for at least two releases, as `bots-in-clawtrate.md` §6.5 says for the bots plugin. Otherwise the app shows "Update Clawtrate on this device to use Bot voice."

## 12. Taking a plugin off

**Established**, ran on both versions unless said:

- `plugins.uninstall {pluginId}` answers `removed: […]` with no restart.
  - For a plain plugin: `["plugin settings", "install record", "directory"]`.
  - For one in `plugins.deny`: `"denylist entry"` as well. Uninstall took it out of `plugins.deny`.
- The source also takes it out of `plugins.allow` (`removePluginRuntimePolicyFromConfig`, `<1006>/dist/uninstall-config-xiiqcHuc.mjs`).
- It removes the entry with its grants, and leaves `plugins.entries.<id>: {enabled: false}`.
- It restores no earlier version and no earlier config.
- Installing again stages the plugin with that entry still `false`, and only an explicit enable turns it on.
- **The voice setting survives:** with Bot voice set off, then uninstalled, reinstalled and enabled, `clawtrate-voice.get` still answered `on: false`.

**Proposed:**

- **"Take it off", never "Undo".** Take it off is `plugins.uninstall`, offered only when neither `plugins.allow` nor `plugins.deny` names the plugin. Uninstall would change those lists, which are the owner's. Otherwise the plugin is turned off instead (`plugins.setEnabled {enabled: false}`). The line says what the gateway confirmed: "Taken off; the gateway's entry for it says enabled: false." A real Undo would have to restore the earlier version, config and grants without overwriting changes made since. No OpenClaw method offers that.
- **The marker.** The `enabled: false` entry the gateway leaves is the record, on every device and across reinstalls, that the person took it off. Every write in section 3.3 checks for it first (step 1), and only the person's own "Add again" goes past it. Add again then enables the plugin explicitly, through the same steps.
- **Turn off** (the plugin's own switch, where it has one, such as Bot voice's) is the plugin's setting, not the plugin.
- Taking off `clawtrate-voice` asks nothing: what it keeps, it keeps. A plugin whose removal loses something a person can't get back (the bots plugin's journal) asks once, as `bots-in-clawtrate.md` §6.6 says.

## 13. Not established

- **A gateway on another computer:** no remote connection was made. Three things were read from both versions' source: the refusal of local sources to such a connection, the local attribution of an SSH forward, and the npm route's integrity check. OpenClaw's own local-host rule was called, and answered as section 2 says.
- **The packaged app's own path:** that a gateway reads a tarball inside a signed `Clawtrate.app` (and a translocated one), and a Windows install's `resources` folder. The runs used a folder laid out the same way, on macOS.
- **A gateway running as another account, in a container, or in WSL** on the same computer: its error for an unreadable or missing path was not seen. Step 0 keeps the engine off such a gateway.
- **The manifest fix:** the exact form OpenClaw's manifest accepts for the voice plugin's hook. Step 1 of section 14 checks it with `plugins.inspect` on both versions.
- **Whether `runtime.sourceDigests` is stable** across the versions a pin covers. It was the same on 2026.10.6 and 2026.11.10 for the same package; a newer OpenClaw may compute it differently, which is why the pin records it per version.
- **`terminal.upload` on 2026.11.10:** run on 2026.10.6 only; the same method and words are in its rpc page.
- **What disposing MCP runtimes does to an MCP call in flight.**
- **Whether `clawtrate-computer` registers nothing** when installed this way: its guard was read; the run asked it a method it doesn't have.

## 14. What must exist first, and the order of pull requests

**Before the engine can be built:**

- Nothing new from OpenClaw: every method is on both versions.
- A security review of section 3.3, which `bots-in-clawtrate.md` §10 step 4 already requires.
- The owner's answer to section 10's question. Both variants are specified, so the engine doesn't wait for it; only step 3 does.
- For the route by address only, section 8's publish.
- For full binding of bytes to activation, a gateway operation, asked of OpenClaw (section 3.1). The engine ships without it, inside section 3.2's limits.

**The order.** Each is small enough to review alone, and each is run on development gateways of both versions.

1. **The app carries its plugins**, built by another builder now, unchanged by this revision:
   - each listed plugin packed from the release's commit;
   - the tarballs under `extraResources`;
   - the pin, and the release check that a changed plugin has a new version;
   - only `clawtrate-voice` listed;
   - the voice plugin's `package.json` gets its `files` list.

   Added to the same step: **the voice plugin's manifest declares its prompt hook**, so that `plugins.inspect` reports it and the pin compares it. Nothing installs yet.

2. **The engine in core, from sections 3.3, 6 and 11:**
   - each call, comparison and stop, tested against both versions' frames, including the preconfigured-entry and update cases of section 3.1;
   - the development gateway gains `--install-plugin <name>`, which packs from the checkout and runs the sequence on a local connection (`bots-in-clawtrate.md` §6.8);
   - one e2e spec installs, refuses a mismatch, turns off and takes off the voice plugin on each version;
   - the release records each plugin's `sourceDigest` from that spec's run.

   Its security review lands with it. `docs/decisions.md` records that Clawtrate writes a plugin's approved grants when it installs that plugin, and the voice plugin's README drops its manual steps.

3. **What a person sees**, in the variant the owner chose:
   - the first-setup line or card;
   - the already-paired line;
   - the Bot voice row without its link;
   - Take it off and Add again;
   - section 10's lines, each tested by its exact words.

   Pictures at desktop and phone width.

4. **The update a person asks for** (section 11).
5. **Over SSH**, once the SSH screens exist: the copy script and its removal.
6. **By address**, once section 8's publish is done: the npm source with `expectedIntegrity`, and the packer and workflow for more than one plugin, which can land before the publish.
7. **Each other plugin**, in the pull request after its review: added to the pin, and offered to gateways already set up.

Steps 1 to 3 need no publish. They bring Bot voice only to a gateway on the person's own computer that Clawtrate reaches by one-click Connect, and that can read the app's tarball. A gateway reached any other way waits for step 5 or 6.
