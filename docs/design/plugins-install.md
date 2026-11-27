# Clawtrate installs its own plugins

How the app puts Clawtrate's own OpenClaw plugins on a person's gateway by itself, once, at first setup, and takes them off again, with no outside page, no terminal and no config file for the person (issue #796, part 3). This is a design: it builds nothing. Sections 3, 6 and 11 are written as the specification the install engine is built from; section 3.5 walks every scenario through every step.

It extends section 6 of `bots-in-clawtrate.md`, which designed this for `clawtrate-bots` alone, to all of Clawtrate's plugins. It settles what that section left open: what a gateway on another computer can take without a registry, whether loading needs a restart, and what a staged plugin does when the gateway starts again. Where the two documents differ, this one is later and corrects that section: an update, a preconfigured entry, or a grant written beside a stage runs new code before any check (section 3); `plugins.uninstall` is not an Undo and the engine doesn't use it (section 12); and `setEnabled` must be told to preserve the gateway's allowlist (section 6).

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

The second revision ran section 3.4's sequence end to end on each version: an install, Add again, Turn on and an update. It also ran:

- a grant written beside a fresh stage, without `enabled: false`;
- an unrelated config write while a plugin was staged;
- an owner's deny and an owner's revoked grant between the last check and the enable;
- two devices staging at the same moment.

Section 3.5 says which rows ran.

A `git://` URL served on loopback by a `git daemon` of the run's own stood in for a network git source. `terminal.upload` ran on 2026.10.6 only.

No gateway on another computer was reached. A development gateway listens on loopback, and a connection made to look remote with proxy headers is refused outright (`<1006>/dist/server-start-D6vaUNGz.mjs:7365-7372`). So what a remote connection may do was read from the source, and checked by calling OpenClaw's own rule (section 2).

## The page to decide from

- **On the gateway's own computer, nothing has to be published.** The app carries each plugin as a tarball outside its archive and gives the gateway the file's path. The gateway copies the file into its own managed folder, so the app writes nothing to disk (ran, both versions).
- **The gateway installs exactly the bytes it inspected, but it doesn't tie its enable to them.** Enabling takes no expected artifact, and the consent token covers the declarations, not the code. Worse, the plugin's code runs before any check in three cases (ran, both versions):
  - an install with `enable: false` over an entry that already says `enabled: true`;
  - an update of a plugin that is enabled;
  - a grant written beside a fresh stage.
- **So the engine keeps an explicit `enabled: false` from its first write until its final enable.** It also:
  - pins every identity and capability field, and the source digest per OpenClaw version;
  - reads before every write;
  - stops at any mismatch, missing field or lost reply;
  - never removes anything.

  One window is left, of seconds, open only to someone who can already rewrite the gateway (section 3.2). Closing it needs an operation on the gateway's side.

- **No restart.** Install, enable, update, reload and uninstall all apply while the gateway runs, and so does the config write that lets a hook run (ran, both versions). If a gateway ever asks for a restart, the engine stops and says so (section 7).
- **Over Clawtrate's SSH route, the gateway counts the connection as local**, because the forward arrives on its loopback. The app copies the tarball there over its own SSH connection (read, not run).
- **A gateway reached by its address can't take the app's own copy. This one case needs a publish** (sections 5 and 8). Nothing else waits for it.
- **Added at first setup: the reviewed release of `clawtrate-voice` only, and only on a gateway where section 3's checks pass.** The other four wait for their own reviews (section 9). The tool-rules plugin, and anything else that changes how a bot's commands are approved, is never switched on for anyone before its security review (issue #675, and the reviews of #678, #691 and #692).
- **What the person is told is the owner's call, and section 10 is written for either answer.** Either one line installs it, or Clawtrate asks once, plainly, saying what the plugin can see. Each answer covers first setup and people already paired. Both name the hook grant: it lets the plugin's hook receive each bot's prompts and messages.
- **Taking it off is "Take it off", not "Undo".** It turns the plugin off and leaves it installed. Uninstall edits the gateway's allow and deny lists and takes no precondition, so the engine never calls it (section 12).
- **No automatic updates yet** (section 11). The gateway accepts an older version over a newer one, and separate calls can't be ordered, so only the person starts an update.

## Contents

1. Every way a gateway takes a plugin
2. Local and remote, and which connection is which
3. The engine
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
- **A native plugin's manifest can't declare its hooks.** `plugins.inspect` reports `declared.hooks: []` for the voice plugin (ran, both), although its code registers a prompt hook, which needs the conversation-access grant. Both versions build a manifest record for a plugin that isn't a bundle with `hooks: []` whatever its manifest says (`buildPluginManifestRecord`, `<1006>/dist/manifest-registry-build-BGqXwGUm.mjs:388`; the same in `<1110>/dist/manifest-registry-build-DR3ZGZqm.mjs`): a copy whose manifest named `before_prompt_build` still inspected as `hooks: []` on both (ran). Only a bundle's manifest carries hooks, and those name hook folders. So the pin compares the hook's grant instead (`grants`, and `plugins.inspect`'s `grants.hooks`), and the app's packer refuses a manifest that names `hooks`.
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

## 3. The engine

### 3.1 What the gateway binds, and what it doesn't

**Established:**

- **The bytes installed are the bytes inspected.** `npm-pack` reads the archive's metadata first (`resolveNpmPackArchiveMetadata`, `<1006>/dist/install-TaW64_lP.mjs:661`), then opens the file again and copies it into the gateway's managed folder (`stageNpmPackArchiveInManagedRoot`, line 655), and npm installs from that copy. Before the install is published, the gateway compares the version and integrity npm recorded in its lockfile with the first read, and refuses a difference (`verifyInstalledNpmResolution`, the `install-managed-npm` region, lines 203-216). The same steps are in `<1110>`'s `installPluginFromNpmPackArchive`. So what `plugins.inspect` reports is what was installed. Over RPC `npm-pack` takes no expected integrity: the schema refuses the field (ran, both). So the engine compares the inspected integrity with its pin (step 4).
- **Writing a plugin's entry can start it.** Ran on both versions:
  - **A fresh stage is not explicitly off.** A fresh `npm-pack` stage leaves the entry `{config: {}}` with no `enabled` key, and the plugin unloaded.
  - **A grant alone starts it.** Writing only the grant into that entry, `{hooks: {allowConversationAccess: true}}`, loaded the plugin and ran its hook before any `setEnabled`. A hook grant qualifies an otherwise eligible plugin to start when `enabled` is unset (`hasExplicitHookPolicyConfig`, `<1006>/dist/gateway-startup-plugin-loader-DycwJ6YX.mjs:49-51`; the same rule in `<1110>`'s startup loader).
  - **An existing enable is kept.** An install with `enable: false` keeps an entry that already says `enabled: true`: with such an entry written before the plugin existed, the stage ran at once. An update with `enable: false` of an enabled plugin also published the new code at once.
  - **Under an explicit `enabled: false`, nothing loads:** not the stage, not an update's stage, not the grant written beside it, and not an unrelated config write afterwards.
- **Enabling takes no expected artifact.** `plugins.setEnabled` accepts `{pluginId, enabled, allowlistPolicy?, acknowledgeCapabilities?}` (`<1006>/dist/sessions-B6HQw2nf.mjs:909-914`; the same schema in `<1110>`). It enabled a plugin over an entry that said `enabled: false` (ran, both). It enforces `plugins.deny` always, and `plugins.allow` with `allowlistPolicy: "preserve"`, inside its own request (section 6; ran, both).
- **The consent token doesn't bind the code.** `reviewToken` is a hash of the declared surface (`computeDeclaredSurfaceHash(declared)`, `<1006>/dist/capability-summary-CFDZfvsK.mjs:147`), and that surface comes from the manifest (line 91).
- **After enabling, the runtime receipt names what loaded.** `runtime.sourceDigests[<id>]` is a SHA-256 of the captured source. It was the same for the same package on both versions (voice 0.1.0: `ecb5bdf1…`) and different for a different package (ran).
- **No plugin mutation takes a precondition.** Neither `plugins.install` nor `plugins.setEnabled` nor `plugins.uninstall` takes an expected version, integrity, install hash or config hash. Only `plugins.reload` takes preconditions (`installHash`, `sourceDigests`; rpc page, `<1006>` line 118), and it doesn't enable. Each request takes its own lifecycle lease (`withPluginLifecycleLease`, `<1006>/dist/plugins-mutations-ClrWTX5-.mjs:37-43`), so a read and a later write are never under one lock. `config.patch` is the one write that takes a precondition, the `baseHash` of the whole config.

**So full binding of the verified artifact to the enable needs an operation on the gateway's side**, for example `plugins.setEnabled` taking an expected integrity or install hash and comparing it, under its own lease, with the copy it loads. Until OpenClaw has one, the engine works within 3.2.

### 3.2 What the engine guarantees, and the window that is left

**The engine guarantees** that the plugin's code is never loaded before the final enable. From the first write until step 7, the entry says `enabled: false` (3.1). Every stop, crash and lost reply before step 7 therefore leaves the plugin off. The gateway itself guarantees that the bytes installed are the bytes inspected (3.1).

**The window left is between step 6 (the last check) and step 7's commit:**

- **Another admin can replace the staged package through RPC** (`plugins.install … mode: "update"`) in that interval.
- **A process of the account the gateway runs as can write the gateway's managed folder** in that interval.

Both are seconds long. Who can use them:

- **An admin connection.** It can already install, enable and replace any plugin on that gateway, and change its config.
- **A process of the gateway's own account.** It can already rewrite the gateway's config, its plugins and OpenClaw itself, and read its token.

The window gives neither of them anything they don't already have.

**What catches it afterwards:** step 7's answer must carry the pin's `sourceDigest` for this OpenClaw version, and step 8 re-reads everything. A replaced package shows another digest, and the engine turns it off at once. This detects code that has already run once; it doesn't prevent it.

**Where it is accepted:**

- on a gateway on the same computer, after one-click Connect's check that the gateway runs as this account (#688);
- over Clawtrate's SSH route, whose folder is private to the signed-in account that runs the gateway;
- on the route by address, where the gateway's own `expectedIntegrity` check covers the download (section 5).

**Where the engine doesn't run:** an address typed under Advanced that points at this computer. Nothing there shows which account runs the gateway, so it takes the route by address instead.

**An owner's change during the window is not lost, with one exception:**

- **Deny, or an allowlist that leaves the plugin out.** `setEnabled` enforces both inside its own request ("blocked by denylist", ran, both).
- **The grant revoked.** The plugin is enabled without its hook running. Step 8 compares the entry's grants and turns the plugin off (ran, both: the hook reported `needs-conversation-access` and the entry showed `allowConversationAccess: false`).
- **The plugin uninstalled.** `setEnabled` answers "plugin not installed".
- **The exception: the owner writing `enabled: false`.** It is already `false`, so the write changes nothing a client can see. The engine can't tell that intent apart, and step 7 enables over it. This is the one owner change the engine can't preserve. It needs the gateway-side precondition above.

### 3.3 The pin, and what is read before every write

**The pin.** Built into the signed app from the release's own packing. Each entry describes one plugin the app carries. If any field is missing, the plugin is not offered.

- `packageName`, and `version` in canonical `x.y.z` form;
- `pluginId`, and `integrity` (`sha512-…`) of the exact, dependency-free tarball;
- `declared`: every group `plugins.inspect` reports, each as a sorted list. The groups are `channels`, `providers`, `tools`, `contracts`, `hooks`, `mcpServers`, `cliCommands`, `cliBackends`, `skills` and `dangerousConfigFlags`. A group missing on either side is a mismatch.
  - **`declared.hooks` is always empty for Clawtrate's plugins, and the manifest can't change that.** A plugin that isn't a bundle has no way to declare its hooks to OpenClaw:
    - neither version's manifest type has a `hooks` field: `PluginManifest`, `<1006>/dist/types.openclaw-yUy4bDSr.d.ts:7867` and `<1110>/dist/types.openclaw-D8uW-XQA.d.ts:8470`;
    - neither version's manifest reader reads one: `loadPluginManifest`, `<1006>/dist/manifest--jjvMb9t.mjs:983`, and the same function in `<1110>/dist/manifest-registry-BDiVz1qN.mjs`;
    - both build the record of a plugin that isn't a bundle with `hooks: []`: `buildPluginManifestRecord`, `<1006>/dist/manifest-registry-build-BGqXwGUm.mjs:388`, and the same function in `<1110>/dist/manifest-registry-build-DR3ZGZqm.mjs`;
    - both versions' manifest docs say not to use the manifest for "registering native runtime hooks" (`docs/plugins/manifest.md:42` in each);
    - ran, both versions: a copy of the voice plugin whose manifest named `before_prompt_build` still inspected as `declared.hooks: []`.

    So the pin can't name the hook in `declared`; if it did, step 4 would find a mismatch on every gateway. The app's packer refuses a manifest that names `hooks`. The hook is carried instead by its grant: a test of the app registers the plugin's code with a stand-in host and requires the pin's `grants` to cover every hook the code registers, and steps 6 and 8 require `plugins.inspect`'s `grants.hooks` to report that grant in effect (row 5i).
- `grants`, kept separately: the fields of the plugin's entry that grant it something, merged into the entry as they are. For `clawtrate-voice` that is `{hooks: {allowConversationAccess: true}}`, so the entry gets `hooks.allowConversationAccess: true`.
- `sourceDigests`: `runtime.sourceDigests[<id>]` for each OpenClaw version the release ran it on. This is mandatory: a gateway whose version has no recorded digest gets no install (step 0).

**The entry's shapes.** Every step names the plugin's entry, `plugins.entries.<id>`, by one of these shapes and no other way:

| Shape   | The entry                     |
| ------- | ----------------------------- |
| `none`  | no entry                      |
| `OFF`   | `{enabled: false}`            |
| `OFF+G` | `{enabled: false, ...grants}` |
| `ON+G`  | `{enabled: true, ...grants}`  |

An entry has a shape when it has exactly the shape's fields with the shape's values, compared deeply. It may also have an empty `config: {}`, which the gateway adds by itself (ran, both). Any other field, or a `config` that isn't empty, means it has no shape. For a plugin whose `grants` are empty, `OFF+G` is `OFF` and `ON+G` is `{enabled: true}`.

**Policy OK**, read from `config.get`:

- the plugin is not in `plugins.deny`;
- `plugins.allow` is empty, or names the plugin;
- the entry has one of the four shapes.

**The expected state** at each point, by mode:

| After step | Install, Add again                                | Turn on                                        | Update                                              |
| ---------- | ------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| 1 (chosen) | not listed; `none` (Install) or `OFF` (Add again) | listed `unloaded` at the pin; `OFF` or `OFF+G` | listed `active` at an older shipped release; `ON+G` |
| 2          | not listed; `OFF`                                 | as after step 1                                | listed `unloaded` at the older release; `OFF+G`     |
| 3 and 4    | listed `unloaded` at the pin; `OFF`               | as after step 1                                | listed `unloaded` at the pin; `OFF+G`               |
| 5 and 6    | listed `unloaded` at the pin; `OFF+G`             | listed `unloaded` at the pin; `OFF+G`          | listed `unloaded` at the pin; `OFF+G`               |
| 7 and 8    | listed `active` at the pin; `ON+G`                | the same                                       | the same                                            |

"At the pin" means the pin's version and, from step 4 on, `plugins.inspect`'s `source.integrity` equal to the pin's.

**Before every write** of steps 2, 3, 5 and 7, the engine does all of these. If any fails, it stops without writing:

1. It reads `config.get`, `plugins.list` and `sessions.list`.
2. It requires **policy OK**.
3. It requires the **expected state** after the previous step, from the table above.
4. It requires **not busy**. If `sessions.list` shows a run going (`hasActiveRun`), it waits for it to end, five minutes at most, then stops with "Clawtrate will finish adding Bot voice when your bots are idle". Every write here reloads plugins and disposes the gateway's MCP runtimes (section 7).

**The one write that skips all of this is turning the plugin off on a mismatch** (steps 3, 7 and 8): `plugins.setEnabled {pluginId, enabled: false, allowlistPolicy: "preserve"}`. It goes ahead whatever is running and whatever the state. If it doesn't apply, it is retried after 1, 2, 4, 8, 16 and 30 seconds, then every 30 seconds while connected. It is retried again at every connection after that (the record keeps it as "turning off"), until a read shows the entry `OFF+G` or `OFF` and the plugin `unloaded`. Meanwhile the line says: "Clawtrate is turning off its voice plugin; until OpenClaw confirms, it may be running."

**The device's record.** For each gateway and plugin, the device keeps one record of the attempt it is running: its mode, the pin's integrity, the last step it completed (or "turning off"), the write it sent whose reply hasn't come, step 7's `runtime.sourceDigests[<id>]` once it answered (#832), and the `config.get` hash after its own last write. It lives in the device's own storage, one per gateway and plugin, and is registered with its bound in `owners.ts` by the engine's pull request. It is dropped when the attempt ends, enabled or stopped for good.

**Resume, and a write whose reply was lost.** At the next connection, a device with a record reads, and compares the gateway with the expected state:

- **The state after the record's last step:** the engine goes on from the next step.
- **The state after the step that follows it:** that step's write applied, but its reply was lost. The engine goes on from the step after that. For a lost stage (a record at step 2, with the plugin now listed `unloaded` at the pin's version and the entry `OFF`, or `OFF+G` for Update), that is step 4. Step 4's inspect then checks the bytes, as for any stage.
- **A record of "turning off":** the disable goes on (above).
- **A record whose step 7 was sent, with the entry `ON+G`:** step 7's write applied but its reply was lost. Step 7's lost-reply rule decides.
- **A record whose step 7 was sent, with the entry still `OFF+G`:** a stop with the line for what the read shows, never a retry. The entry may be the owner's own disable; the person's "Turn on" picks it up (#832).
- **A record at step 7, with step 7's digest:** the engine goes on at step 8 with that digest (#832).
- **Anything else:** the device drops the record and stops, and the line says what the read shows. The person's "Turn on" or "Add again" (section 12) picks it up later from that state.

A device without a record never takes over another device's attempt. When it finds an entry `OFF` or `OFF+G` it didn't write, it waits up to 60 seconds for `plugins.changed` before showing any line: the other device is probably finishing.

**Stops and lost replies.** "Stop" means no further write, and a line from section 10 that says the state the last read confirmed. The gateway's own answer is kept behind an "i". A lost reply is a stop: a timeout, a closed connection, or an answer missing a field this section compares. The engine never repeats a write blindly: the next connection reads first, and resumes only by the record, as above.

- **A stop before step 7** leaves nothing running, because every state before step 7 is `enabled: false`.
- **A lost reply at step 7 or later** leaves the state unknown until a read shows it. Until then the line says only that Clawtrate lost touch with OpenClaw, never that the plugin is off.

### 3.4 The steps

**Modes.** The engine runs in one of four modes, chosen at step 1:

- **Install**: the plugin is not listed and has no entry. First setup, or a person already paired (section 10).
- **Add again**: the plugin is not listed, and its entry is `OFF`, which an uninstall elsewhere leaves. Only by the person's click.
- **Turn on**: the plugin is listed `unloaded` at the pin's version, and its entry is `OFF` or `OFF+G`. It is the person's click after Take it off (section 12), or after a stop.
- **Update**: the plugin is listed `active` at an older release Clawtrate shipped, and its entry is `ON+G`. Only by the person's click (section 11).

**Step 0. Preconditions, per source.**

| Source             | The connections it runs on                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm-pack` (local) | the app's own loopback socket after one-click Connect's check (#688), or Clawtrate's SSH route (section 4)                                                          |
| `npm` (by address) | any connection to the gateway, `wss://`, Tailscale Serve, a LAN address, or an address typed under Advanced, once the pin's release is published (sections 5 and 8) |

On either source, the gateway's confirmed grant on this connection must include `operator.admin` (section 6), and `hello-ok.server.version` must be one of the pin's `sourceDigests` versions. Otherwise stop. The engine never asks for a scope.

**Step 1. Read and choose the mode.** Read `config.get`, `plugins.list` and `sessions.list`. Choose the mode by the list above; the entry's shape and the listing must match it exactly. Every other state is a stop:

- the plugin is listed at another version, or with another integrity;
- the entry is `ON+G`, or `{enabled: true}`, for a plugin that isn't listed;
- deny or the allowlist keeps it out;
- the entry has no shape: it holds fields of the owner's;
- and the rest of section 10's lines.

For **Update**, also call `plugins.inspect`: the installed integrity and version must be a release in this app's table of shipped releases, and older than the pin.

Create the record, with the mode and step 1.

**Step 2. Off first.**

- **Install:** `config.patch {baseHash, raw: {plugins: {entries: {<id>: {enabled: false}}}}}`, which makes the entry `OFF`. A stale base hash goes back to step 1, once.
- **Update:** `plugins.setEnabled {pluginId, enabled: false, allowlistPolicy: "preserve"}`. Then read again. The disable must have applied: the entry is `OFF+G` and the plugin is listed `unloaded` (ran, both). The plugin was running before this write, so if its reply is lost the line says it may still be running until a read shows it off (#832).
- **Add again and Turn on:** the entry is already `OFF` or `OFF+G`. Nothing is written.

Record the step.

**Step 3. Stage.** Install, Add again and Update only. Call `plugins.install {source: "npm-pack", archivePath: <the app's tarball>, enable: false}`.

- **Update** adds `mode: "update"`.
- **The route by address** uses `{source: "npm", spec: "<packageName>@<version>", pin: true, expectedPluginId, expectedIntegrity}` in place of the archive (section 5).
- **Never** `acknowledgeInstallPolicyWarning`, and never `acknowledgeCapabilities`.

The answer must show:

- `ok: true` and `restartRequired: false`;
- `plugin.id`, `plugin.packageName` and `plugin.version` equal to the pin;
- `plugin.enabled: false`;
- no entry for the plugin in `runtime.sourceDigests` or `runtime.selectedEntries` (ran: none on every stage under `enabled: false`).

If any of these is missing, stop.

If a source digest or selected entry names the plugin, its code ran. The engine turns it off by the one write that skips the checks (3.3), and stops.

Other answers:

| Answer                                            | What the engine does                                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAVAILABLE` "already running" (ran, both)       | Wait (`retryAfterMs` when given, else 1, 2 and 4 seconds), three tries at most, then stop. Every write does the same: a write just after a config change is often answered this way (ran, both; `mutationAccepted: false` on 2026.11.10) |
| "plugin already exists"                           | Another device staged it. Stop; that device's record carries its attempt                                                                                                                                                                 |
| The local-artifact error                          | Stop, and use the route by address when it is eligible (step 0)                                                                                                                                                                          |
| `install_policy_warning_acknowledgement_required` | Stop, with the warning. Clawtrate never acknowledges one, and offers no way past it                                                                                                                                                      |
| Anything else                                     | Stop                                                                                                                                                                                                                                     |

Record the step.

**Step 4. Verify the installed artifact.** All four modes. Call `plugins.inspect {pluginId}`. Each of these fields is required, and must equal the pin:

- `plugin.id` and `plugin.version`;
- `source.kind` is `"npm"` (what both `npm-pack` and `npm` record; ran, both);
- `source.packageName`, and `source.spec`, which is `<name>@<version>`;
- `source.integrity`, with `source.integrityKind` `"ssri"`;
- every group of `declared`;
- `reviewToken`, which must be present. Keep it.

On a difference, stop. The plugin stays installed, `unloaded`, with the entry `OFF`, or `OFF+G` for Update and Turn on. Nothing is removed (3.6). Record the step.

**Step 5. Grant.** Only when the entry is `OFF`; an `OFF+G` entry skips this step. Call `config.patch {baseHash, raw: {plugins: {entries: {<id>: {enabled: false, ...grants}}}}}`. For `clawtrate-voice` that is `{enabled: false, hooks: {allowConversationAccess: true}}`.

The `enabled: false` is written in the same patch as the grant, every time.

Then read again. The entry must be `OFF+G`, and the plugin must still be listed `unloaded` (ran, both). A stale base hash goes back to the read before this step, once. Record the step.

**Step 6. The last check.** Run the "before every write" read, plus `plugins.inspect` again. All of these must hold:

- the entry is `OFF+G`;
- policy OK;
- the plugin is listed `unloaded` at the pin's version;
- `source.integrity` still equals the pin;
- the hook grants it reports are the pin's: in `grants.hooks`, each of the pin's `grants.hooks` is `{effective, configured}` with the pinned value, and `allowPromptInjection` is in effect. A plugin that isn't a bundle can't declare its hooks (section 1), so this is the gateway's one report about the hook its code registers. A test of the app holds the pin's grants to every hook the plugin's code registers.

Record the step.

**Step 7. Enable.** Call `plugins.setEnabled {pluginId, enabled: true, allowlistPolicy: "preserve", acknowledgeCapabilities: {reviewToken: <step 6's>}}`. The token comes from step 6's `plugins.inspect`, which every resume runs before step 7, so a token is never kept across a connection (#832).

The answer must show:

- `ok: true` and `restartRequired: false`;
- `runtime.sourceDigests[<id>]` equal to the pin's digest for this OpenClaw version.

"blocked by allowlist", "blocked by denylist" and "plugin not installed" are stops; the plugin stays as it was.

If the digest differs or is missing, the engine turns the plugin off by the one write that skips the checks (3.3), and stops.

**If the reply is lost**, the engine has no digest. On reconnecting it reads:

- **The entry is `ON+G`:** the engine turns the plugin off by the one write that skips the checks (3.3), waits for the read that shows `OFF+G` and `unloaded`, then runs step 6 and step 7 once more, to get the digest from step 7's answer. If that reply is lost too, it turns the plugin off and stops.
- **The entry is still `OFF+G`:** a stop, never a retry: the entry may be the owner's disable (#832). The person's "Turn on" picks it up.
- **Anything else:** a stop, with the line for what the read shows.

**Step 8. Confirm.** Read `config.get`, `plugins.list` and `plugins.inspect`, and call the plugin's own method. All of these must hold:

- step 7's `runtime.sourceDigests[<id>]`, from its answer or from the device's record, equals the pin's digest for this OpenClaw version;
- the entry is `ON+G`;
- policy OK;
- the plugin is listed `runtime.state: "active"` at the pin's version;
- `source.integrity` still equals the pin;
- the hook grants it reports are the pin's, as in step 6;
- the method answers, with the version it reports.

If all hold, the result is **enabled, confirmed**, and the record is dropped. Otherwise the engine turns the plugin off by the one write that skips the checks (3.3), and stops. The line says "it may be running" until a read shows it off, then what that read shows.

### 3.5 Every scenario, walked through every step

**The walk table** gives the entry's shape after each step, with the plugin's runtime state where it changes. It uses the shapes of 3.3, shortened:

- `F` is `OFF`;
- `F+g` is `OFF+G`;
- `T+g` is `ON+G`;
- `—` is no entry, or nothing written;
- `x` means the step doesn't apply.

"Ran" means the row ran on development gateways of both versions in this design's runs, with the same result on each; "read" means it is derived from the source and the runs of the steps it uses. Every row ends at **enabled, confirmed**, or at a named stop with the plugin's code not loaded, except the two rows marked ⚠, which are 3.2's window.

| #    | Scenario                                                   | 1 read | 2 off                                                           | 3 stage                                | 4 verify                 | 5 grant                             | 6 check            | 7 enable            | 8 confirm                                                         | Ends with                                                                                                                      | Run               |
| ---- | ---------------------------------------------------------- | ------ | --------------------------------------------------------------- | -------------------------------------- | ------------------------ | ----------------------------------- | ------------------ | ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 1    | Install                                                    | —      | F                                                               | F, unloaded                            | F                        | F+g, unloaded                       | F+g                | T+g, active         | T+g                                                               | enabled, confirmed                                                                                                             | ran               |
| 2    | Add again (entry `{enabled: false}`, not listed)           | F      | F                                                               | F, unloaded                            | F                        | F+g, unloaded                       | F+g                | T+g, active         | T+g                                                               | enabled, confirmed                                                                                                             | ran               |
| 3    | Turn on (listed `unloaded` at the pin, `F` or `F+g`)       | F      | F                                                               | x                                      | F                        | F+g                                 | F+g                | T+g, active         | T+g                                                               | enabled, confirmed                                                                                                             | ran, steps 6 to 8 |
| 4    | Update the person asks for (listed older, `T+g`)           | T+g    | F+g, unloaded                                                   | F+g, newer, unloaded                   | F+g                      | x (has g)                           | F+g                | T+g, active         | T+g                                                               | enabled, confirmed at the new version                                                                                          | ran               |
| 5a   | Stop after step 2                                          | —      | F                                                               | stop                                   |                          |                                     |                    |                     |                                                                   | off; the record resumes at step 3                                                                                              | read              |
| 5b   | Lost reply at step 3 (the stage applied)                   | —      | F                                                               | F, unloaded, reply lost                | F                        | F+g                                 | F+g                | T+g, active         | T+g                                                               | the record at step 2 finds the stage: goes on at step 4; enabled, confirmed                                                    | read              |
| 5c   | Stop after step 3 (busy, crash)                            | —      | F                                                               | F, unloaded, stop                      |                          |                                     |                    |                     |                                                                   | off; resumes at step 4                                                                                                         | read              |
| 5d   | Stop at step 4 (mismatch)                                  | —      | F                                                               | F                                      | stop                     |                                     |                    |                     |                                                                   | installed, off; "didn't match", nothing removed                                                                                | read              |
| 5e   | Stop after step 5 (busy five minutes, lost reply)          | —      | F                                                               | F                                      | F                        | F+g, stop                           |                    |                     |                                                                   | off; resumes at step 6                                                                                                         | read              |
| 5f   | Stop at step 6 (the state changed)                         | —      | F                                                               | F                                      | F                        | F+g                                 | stop               |                     |                                                                   | off; the line says what changed                                                                                                | read              |
| 5g   | Lost reply at step 7                                       | —      | F                                                               | F                                      | F                        | F+g                                 | F+g                | ? (reply lost)      | reads: T+g → off, then steps 6 and 7 once more; F+g → stop (#832) | enabled, confirmed with step 7's digest; or turned off after a second lost reply; the line says only "lost touch" until a read | read              |
| 5h   | Step 8 finds a difference                                  | —      | F                                                               | F                                      | F                        | F+g                                 | F+g                | T+g                 | → F+g, by the disable that skips the checks                       | turned off; "may be running" until a read shows it off                                                                         | read              |
| 5i   | The hook's grant not in effect as the gateway reports it   | —      | F                                                               | F                                      | F                        | F+g                                 | stop, if at step 6 | T+g, if past step 6 | → F+g, by the disable that skips the checks                       | off; nothing enabled at step 6, or turned off at step 8                                                                        | read              |
| 6    | Two devices start at once (the second after the slash)     | — / —  | F / stale base hash: back to step 1, finds F without its record | F / x                                  | F / x                    | F+g / x                             | F+g / x            | T+g / x             | T+g / reads it                                                    | enabled, confirmed by the first; the second waits for `plugins.changed`, then shows it on                                      | in part           |
| 7a   | Owner denies after step 1, before step 6                   | —      | F                                                               | F (install leaves deny alone)          | F                        | stop at the read before step 5 or 6 |                    |                     |                                                                   | off; "Turned off in the gateway's settings"                                                                                    | read              |
| 7b   | Owner denies between step 6 and step 7                     | —      | F                                                               | F                                      | F                        | F+g                                 | F+g                | blocked             |                                                                   | off; "Turned off in the gateway's settings"                                                                                    | ran               |
| 7c   | Owner writes `enabled: true` before step 3                 | —      | F → T                                                           | stop (read)                            |                          |                                     |                    |                     |                                                                   | the owner's choice; Clawtrate stops and stages nothing                                                                         | read              |
| 7d   | Owner writes `enabled: true` after step 3                  | —      | F                                                               | F → T: active                          | stop (unloaded expected) |                                     |                    |                     |                                                                   | the owner ran it; Clawtrate stops; "Turned on in the gateway's settings"                                                       | read              |
| 7e   | Owner revokes the grant between step 6 and step 7          | —      | F                                                               | F                                      | F                        | F+g                                 | F+g → F, no g      | T, hook off         | → F                                                               | turned off at step 8; "Turned off in the gateway's settings"                                                                   | ran               |
| 7f ⚠ | Owner writes `enabled: false` between step 6 and step 7    | —      | F                                                               | F                                      | F                        | F+g                                 | F+g                | T+g                 | T+g                                                               | enabled over the owner's no-op write (3.2's one exception)                                                                     | read              |
| 7g   | Owner uninstalls between step 6 and step 7                 | —      | F                                                               | F                                      | F                        | F+g                                 | F+g                | not installed       |                                                                   | stop; "Add again" (entry `OFF`)                                                                                                | read              |
| 8 ⚠  | Another admin replaces the stage between step 6 and step 7 | —      | F                                                               | F                                      | F                        | F+g                                 | F+g                | T+g, other digest   | → F+g                                                             | turned off at step 7; the replaced code ran once                                                                               | read              |
| 9    | Route by address, with npm                                 | —      | F                                                               | F, unloaded (npm, `expectedIntegrity`) | F                        | F+g                                 | F+g                | T+g, active         | T+g                                                               | enabled, confirmed                                                                                                             | read              |

Row numbers 5a to 5h walk a stop or a lost reply at each step. Rows 1, 2 and 4 ran end to end on both versions, with the calls of 3.4. Row 3 ran from step 6, from a listed plugin whose entry said `enabled: false` with its grant; its step 4 is row 2's. Row 1 ran with an unrelated config write between steps 5 and 6, which loaded nothing. Row 6 ran in part: a second device's stage, sent at the same moment, was answered "already running", and after the first device's install the entry was the stage's own. The two devices' `config.patch` race on one base hash was read, not run, because both test writes left the config unchanged. Rows 7b and 7e ran with the owner's change written between the step 6 read and step 7.

### 3.6 Nothing is removed by the engine

`plugins.uninstall` takes no precondition. It edits `plugins.allow` and `plugins.deny` (section 12), and it can't tell this attempt's stage from another device's later one. So the engine never calls it. A stage that didn't match stays installed under `enabled: false`, where it never loads. The line offers nothing that removes it. Removing it is OpenClaw's own plugin settings (#794).

**Where the tarball lives.** The packaged app ships it outside `app.asar`: `Clawtrate.app/Contents/Resources/plugins/` on macOS, and `resources\plugins\` beside the executable on Windows (an `extraResources` entry in `apps/desktop/packaging/config.ts`). The gateway reads it with plain Node, which can't read inside an Electron archive. It copies it into `<state>/npm/projects/<id>/node_modules/<package>`. With the app's folder moved away, the plugin kept answering, and `plugins.reload` reloaded it from that copy (ran, both). The app writes nothing on the person's disk, which keeps one-click Connect's rule that it only reads OpenClaw's profile (#688).

## 4. The route over SSH

**Proposed, read and not run.** The SSH screens aren't built yet (`docs/decisions.md`, "SSH to another computer", "Not done here").

1. Over its existing SSH route, the app runs one more constant script, as it runs the LOOK. The script makes a private folder under that computer's temporary folder (`umask 077`, `mktemp -d`), writes the tarball from standard input, and prints the folder's path and the file's SHA-512. A SHA-512 that isn't the pin's is a stop.
2. Section 3.4's steps 0 to 8 run through the forward, with that path. The gateway counts the forward as local (section 2).
3. The app removes its folder by its exact path once the gateway has its copy, or at its next SSH contact if it couldn't then.

`terminal.upload` would do step 1 through the gateway's own methods; section 1 says why it is not the route.

## 5. The route by address

**Established:** no gateway method takes a plugin's bytes from a connection that isn't local. Such a connection can install only a package from a registry (`npm`, `clawhub`) or a git repository on the network.

**Proposed: npm, used only to stage.** Step 3 of section 3.4 becomes `plugins.install {source: "npm", spec: "@clawtrate/<plugin>@<exact version>", pin: true, expectedPluginId, expectedIntegrity: <the pin's>, enable: false}`. Every other step is the same, under the same `enabled: false`.

- **When the route by address is eligible** (section 3.4, step 0): on any connection with a confirmed admin grant, once the pin's release is published. The gateway's own `expectedIntegrity` check, before it installs, covers the download. The window between the last check and the enable is section 3.2's, open to an admin or to the account that runs that gateway. Both can already rewrite it.
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
- **`allowlistPolicy: "preserve"` on every `setEnabled`, enabling and disabling alike:** `plugins.setEnabled {pluginId, enabled: true, allowlistPolicy: "preserve", acknowledgeCapabilities: {reviewToken}}` and `plugins.setEnabled {pluginId, enabled: false, allowlistPolicy: "preserve"}`. The engine never adds a plugin to `plugins.allow` and never removes one from `plugins.deny`. It never calls `plugins.uninstall`, which does both (section 12).
- **An explicit disable is honoured.** A plugin entry with `enabled: false`, installed or not, is the owner's, and so is a name in `plugins.deny`. The marker is checked before each write (section 3.3), not only at the start. Only the person's own "Add again" or "Turn on" in Clawtrate goes past `enabled: false`, and nothing goes past `plugins.deny`. Clearing deny belongs to OpenClaw's own settings, in #794's design. The one disable the engine can't see is described in section 3.2.

## 7. Restart

**Established: none is needed.** "These mutations wait for runtime application without restarting the Gateway" (both versions' rpc page, `<1006>` line 152, `<1110>` line 155). Every install, enable, update, reload and uninstall in the runs answered `restartRequired: false` and published a new runtime generation. A config write under `plugins` is applied hot (`<1006>/dist/config-reload-plan-BmEf0hE9.mjs:292-295`; the same rule in `<1110>/dist/config-reload-plan-BR9X4bST.mjs`). That rule's actions are `reloadPlugins` and `disposeMcpRuntimes`: the grant's `config.patch` disposes the gateway's MCP runtimes.

**What a person's bots and tasks experience.** A run already going keeps the plugins it started with: the rules checks saw a run go on asking after the rules plugin was turned off in the middle of it (`docs/decisions.md`, "The rules plugin"). The voice guide reaches each bot from the next system prompt the gateway builds. What disposing MCP runtimes does to an MCP call in flight was not run.

**Proposed:**

- **Defer every write while the gateway is busy.** Each write in section 3.4 waits until `sessions.list` shows no run going, at most five minutes (section 3.3). Otherwise it stops with "Clawtrate will finish adding Bot voice when your bots are idle.", and the device's record resumes it at the next connection. Every state before step 7, where these waits are, is `enabled: false`. The one exception is turning the plugin off on a mismatch, which doesn't wait (section 3.3).
- **Stop on an unexpected restart requirement.** Any answer with `restartRequired: true` (the docs name edited bundled code, which isn't Clawtrate's case) is a stop. The engine does not restart OpenClaw by itself. The line offers it as the person's own action: "OpenClaw needs a restart to finish adding Bot voice · Restart". Only that click calls `gateway.restart.request {}`, which on both versions answered `status: "scheduled"` with a preflight ("safe to restart now", or the active work that defers it) and restarted the gateway in place (ran). After it, the engine resumes by its record, from the step it stopped at. This is the owner's "one restart, for all plugins together, with one line", given to the person instead of done for them.

## 8. Publishing, for the route by address

Needed only for section 5's npm route. Everything in `plugins-publish.md` and `bots-in-clawtrate.md` §6.9 stands.

**On the repository's side (a pull request, no one in person):**

1. Each plugin to publish gets `"name": "@clawtrate/<folder>"` and a `files` list in its `package.json` (only `clawtrate-bots` has them).
2. `plugin-npm.ts` and `plugins-publish.yml` take the plugin as an input, one of a fixed list, and the lock holds one entry per plugin. Their tests cover each plugin. The packer keeps refusing any dependency field, so the one integrity covers all the code.
3. The release packs every plugin the app carries, from its own commit, and writes the pin (section 3.3) from that packing. That includes each source digest, recorded by the e2e spec on each supported OpenClaw version. It fails when a plugin's bytes changed but its version didn't, or when a digest is missing.

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

| Plugin                 | What it changes on a gateway once loaded                                                                                                                                                                                                                                                  | At first setup today                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawtrate-voice`      | Adds Clawtrate's voice guide to the end of each bot's system prompt, in runs whose runner calls its hook, until a person turns it off. It needs the grant that lets its hook receive each bot's prompts and messages; its README says it reads nothing of them. It keeps one setting row. | **Its reviewed release, on gateways where section 3's checks pass.** That needs the install's security review first (section 14).                  |
| `clawtrate-bots`       | Adds gateway methods that keep bots' proposed changes and a journal for Undo. It changes no bot by itself today (Apply is reported unavailable). Its tools and holds come later.                                                                                                          | No. Its install waits for the security review its own design requires (`bots-in-clawtrate.md` §10, step 4).                                        |
| `clawtrate-memory`     | Adds methods that list, read and change bots' notes and shared memory files from Clawtrate.                                                                                                                                                                                               | No. Development gateways only, until issue #41's security review.                                                                                  |
| `clawtrate-tool-rules` | Decides every tool call a bot makes by rules (run, ask first, never), through a hook on every call.                                                                                                                                                                                       | **No.** It changes how a bot's commands are approved, so it isn't switched on for anyone before issue #675 and the reviews of #678, #691 and #692. |
| `clawtrate-computer`   | A browser of its own for each chosen bot, which people watch live and take over. Outside a Clawtrate development instance it registers nothing, by its own guard (`plugins/clawtrate-computer/index.js`; not checked by a run).                                                           | No: issue #29.                                                                                                                                     |

**Proposed:** the pin holds only plugins whose review allows them on everyone's gateway. A plugin joins it in the pull request that follows its review. From then on it is offered to gateways already set up by section 10's "already paired" variant.

## 10. What a person sees, and each failure

**The open question, with the owner:** does installing plugin code that runs inside OpenClaw, with a grant that lets its hook receive prompts and messages, count as a change to OpenClaw that the person must confirm? The design holds under either answer. Only the words and one click differ. Each variant is given for both moments.

**What every variant says about the grant**, in these words or the owner's: "Bot voice adds a short guide to each bot's instructions. To do that, OpenClaw lets the plugin see each bot's prompts and messages; it uses none of them."

**Where it applies.** These lines show only when section 3.4's step 0 can pass:

- the route is this computer, after one-click Connect's check; later the SSH route; or, after the publish, a gateway reached by its address;
- the grant being asked for, or held, is full control.

On any other route, or without full control, no line promises an install; the table at the end says what shows.

### First setup

**Variant A: installs with one line.** Directly below the consent line on the card that pairs (`setup-effortless.md` §2), one line:

> "Connecting also adds Clawtrate's plugin for Bot voice to this OpenClaw. It can see your bots' prompts and messages and uses none of them. You can take it off in Settings."

Connect is the consent, as it is for full control. The engine runs after the pairing confirms admin, while the first run goes on. On the development gateways a stage took 5 to 13 seconds on a heavily loaded machine.

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
- Under it, quietly: "Clawtrate's voice plugin is on this gateway · Take it off". There is no Undo, because taking it off restores nothing (section 12). When it is off: "Clawtrate's voice plugin is off on this gateway · Turn on".
- The outside link Settings shows today (`packages/ui/src/Settings.tsx:392-413`) goes, as #796's first part asks.

### When it isn't installed

One line in the same place, with the gateway's own words behind an "i" where it gave any. Each line describes only the state the engine's last read confirmed, never one it assumed.

| What happened                                                                             | What the person sees                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No full control on this connection                                                        | "Clawtrate needs full control of this gateway to add its voice plugin." with setup's existing way to get it                                          |
| A route the engine doesn't run on yet (by address before a publish)                       | "Clawtrate can't add its voice plugin to this gateway yet."                                                                                          |
| The gateway refused the stage                                                             | "OpenClaw didn't add Clawtrate's voice plugin." · Try again                                                                                          |
| The install policy warned                                                                 | "OpenClaw warned about Clawtrate's voice plugin, so Clawtrate didn't add it." with the warning behind the "i". There is no way past it in Clawtrate. |
| A mismatch at step 4                                                                      | "The plugin OpenClaw got didn't match the one this Clawtrate carries. OpenClaw has it installed and off."                                            |
| Turned off at step 7 or 8                                                                 | "Clawtrate turned off its voice plugin: what OpenClaw loaded didn't match. Its entry says enabled: false." · Try again                               |
| A lost reply before step 7                                                                | "Clawtrate lost touch with OpenClaw while adding Bot voice. It is off; Clawtrate goes on when it reconnects."                                        |
| A lost reply at step 7 or later                                                           | "Clawtrate lost touch with OpenClaw while turning on Bot voice. It shows the plugin's state once it reads it again."                                 |
| Turning off on a mismatch, not yet confirmed                                              | "Clawtrate is turning off its voice plugin; until OpenClaw confirms, it may be running."                                                             |
| Busy                                                                                      | "Clawtrate will finish adding Bot voice when your bots are idle."                                                                                    |
| A restart asked for                                                                       | "OpenClaw needs a restart to finish adding Bot voice · Restart" (the person's own action)                                                            |
| An entry of the owner's, or a name in `plugins.allow` or `plugins.deny` that keeps it out | "Turned off in the gateway's settings"                                                                                                               |
| The owner turned it on in OpenClaw's settings before Clawtrate checked it (row 7d)        | "Turned on in the gateway's settings; Clawtrate didn't check this copy."                                                                             |
| Not listed, with the entry `{enabled: false}`                                             | "Bot voice's plugin isn't on this gateway · Add again"                                                                                               |
| Listed and off                                                                            | "Clawtrate's voice plugin is off on this gateway · Turn on"                                                                                          |
| An installed version this app doesn't ship                                                | Section 11's lines                                                                                                                                   |

No line links to a page outside the app.

**Other places.** Only the desktop app installs: it carries the files and makes the local routes. The web viewer and the iPhone app (`apps/mobile`, another thread's) show what `plugins.list` and the plugin's methods say, and change nothing on the gateway's plugins.

## 11. Updates, and two Clawtrates on one gateway

**Established:**

- `plugins.list` gives each plugin's `version`, `packageName`, `enabled` and `runtime.state`, and `plugins.inspect` gives its source and integrity.
- **The gateway doesn't refuse an older version:** an update from 0.2.0 to 0.1.0 succeeded on both versions.
- **An update with `enable: false` of an enabled plugin runs the new code at once** (section 3.1).
- **No plugin mutation takes a precondition on the installed version or digest.** The gateway runs one plugin or config change at a time (`UNAVAILABLE` "already running", ran, both), but each request takes its own lease (`withPluginLifecycleLease`, `<1006>/dist/plugins-mutations-ClrWTX5-.mjs:37-43`). A device's read and its later update are two requests, so another device's update can run between them.

**Proposed: no automatic updates** until the gateway can compare the expected current version and digest under its own mutation lock.

**The downgrade window, plainly.** The gateway accepts an older version over a newer one. Picture two devices with full control, each with a Clawtrate that ships a different version, whose people press Update within the same second or so:

- the older app's read can come before the newer app's install;
- its own install can then commit after the newer app's.

The gateway would then run the older release. That release is still one a signed Clawtrate shipped, and it passed that app's checks. The newer app's step 8 sees a version that isn't its own and turns the plugin off, so Bot voice stays off until a person presses Update again.

Nobody else can use this window: it needs two people with full control pressing Update at nearly the same time. It can't be closed from the client. Because of it, nothing updates by itself.

**Comparing versions.** A version is canonical only as `x.y.z`: three non-negative integers, with no leading zeros and nothing after them. Two versions compare numerically, part by part, date-shaped triples included (`2026.11.10` is newer than `2026.9.30`). These are left alone, with "This gateway has another copy of Bot voice's plugin; Clawtrate leaves it as it is.":

- a prerelease, a build suffix, or any other form;
- the same version with another integrity;
- a package name, plugin id or source kind the pin doesn't know;
- a plugin installed another way: a linked checkout, a path, or git.

**An update the person asks for** is section 3.4's Update mode, walked as row 4 of section 3.5. It is offered only when all of these hold:

- `plugins.inspect` shows the installed integrity and version as a release in this app's table of shipped releases, which the release carries forward;
- it is older than the pin;
- step 0 passes.

Settings shows: "A newer Bot voice plugin comes with this Clawtrate · Update". During an update Bot voice is off for seconds. A stop after its step 2 leaves the plugin installed and off, and the line says so: "Clawtrate's voice plugin is off on this gateway · Turn on". Turn on then runs Turn on mode, verifying the installed artifact first (step 4). If the installed artifact is still the older shipped release, the line offers Update instead.

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

- **"Take it off", never "Undo".** Take it off turns the plugin off and removes its grant. It runs only after the before-write read of section 3.3, and makes two writes:
  - `plugins.setEnabled {pluginId, enabled: false, allowlistPolicy: "preserve"}`;
  - then `config.patch {baseHash, raw: {plugins: {entries: {<id>: {enabled: false, <each top-level field of grants>: null}}}}}`, for `clawtrate-voice` `{enabled: false, hooks: null}`, which leaves the entry `OFF`.

  The plugin stays installed, unloaded, under `enabled: false`. The line says what the next read confirmed: "Taken off; OpenClaw has it installed and off." It never calls `plugins.uninstall`:
  - uninstall takes no precondition;
  - it edits `plugins.allow` and `plugins.deny`, which are the owner's;
  - a read before it can't protect those lists from an edit in between.

  A real Undo would have to restore the earlier version, config and grants without overwriting changes made since. No OpenClaw method offers that.

- **The marker.** An entry that is `OFF` or `OFF+G` (section 3.3) is the record, on every device and across reinstalls, that the plugin is off on purpose. This holds whether the plugin is installed (Take it off, or a stop) or not (an uninstall elsewhere). Every write in section 3.4 checks it first. Only the person's own "Turn on" or "Add again" goes past it, and each verifies the installed artifact before it enables anything.
- **Turn off** (the plugin's own switch, where it has one, such as Bot voice's) is the plugin's setting, not the plugin.
- **Taking off `clawtrate-voice` asks nothing.** It removes nothing, and the voice setting survives (ran). A plugin whose removal loses something a person can't get back, such as the bots plugin's journal, asks once, as `bots-in-clawtrate.md` §6.6 says.

## 13. Not established

- **A gateway on another computer:** no remote connection was made. Three things were read from both versions' source: the refusal of local sources to such a connection, the local attribution of an SSH forward, and the npm route's integrity check. OpenClaw's own local-host rule was called, and answered as section 2 says.
- **The packaged app's own path:** that a gateway reads a tarball inside a signed `Clawtrate.app` (and a translocated one), and a Windows install's `resources` folder. The runs used a folder laid out the same way, on macOS.
- **A gateway running as another account, in a container, or in WSL** on the same computer: its error for an unreadable or missing path was not seen. Step 0 keeps the `npm-pack` route off such a gateway.
- **Whether `runtime.sourceDigests` is stable** across the versions a pin covers. It was the same on 2026.10.6 and 2026.11.10 for the same package; a newer OpenClaw may compute it differently, which is why the pin records it per version.
- **`terminal.upload` on 2026.11.10:** run on 2026.10.6 only; the same method and words are in its rpc page.
- **What disposing MCP runtimes does to an MCP call in flight.**
- **Two devices' `config.patch` on one base hash** (section 3.5, row 6). `config.patch` takes `baseHash`, which the engine relies on to refuse the second. The run's two writes changed nothing, so the refusal wasn't seen.
- **Rows 5, 7a, 7c, 7d, 7f, 7g, 8 and 9 of section 3.5:** read, as built from steps that ran.
- **The local routes as people reach them.** The runs used a development gateway on macOS, reached through a direct loopback socket. One-click Connect's own checked socket, a gateway installed by OpenClaw's own setup, and the SSH forward weren't exercised.
- **Whether `clawtrate-computer` registers nothing** when installed this way: its guard was read; the run asked it a method it doesn't have.

## 14. What must exist first, and the order of pull requests

**Before the engine can be built:**

- Nothing new from OpenClaw: every method is on both versions.
- A security review of sections 3.3 and 3.4, which `bots-in-clawtrate.md` §10 step 4 already requires.
- The owner's answer to section 10's question. Both variants are specified, so the engine doesn't wait for it; only step 3 does.
- For the route by address only, section 8's publish.
- For full binding of the verified artifact to the enable, and for an update that can't be reordered, a gateway operation with a precondition, asked of OpenClaw (sections 3.1 and 11). The engine ships without it, inside section 3.2's limits.

**The order.** Each is small enough to review alone, and each is run on development gateways of both versions.

1. **The app carries its plugins**, built by another builder now, unchanged by this revision:
   - each listed plugin packed from the release's commit;
   - the tarballs under `extraResources`;
   - the pin, and the release check that a changed plugin has a new version;
   - only `clawtrate-voice` listed;
   - the voice plugin's `package.json` gets its `files` list.

   It was to add the voice plugin's prompt hook to its manifest, so that `plugins.inspect` reported it; no manifest of a plugin that isn't a bundle can (section 1), so the pin compares the hook's grant instead. Nothing installs yet.

2. **The engine in core, from sections 3.3, 3.4, 6 and 11:**
   - each call, comparison and stop, and the device's record with its bound in `owners.ts`;
   - a test per row of section 3.5's table, against both versions' frames, including the preconfigured-entry, grant and update cases of section 3.1;
   - the development gateway gains `--install-plugin <name>`, which packs from the checkout and runs the sequence on a local connection (`bots-in-clawtrate.md` §6.8);
   - one e2e spec runs rows 1 to 4, 7b and 7e on each version;
   - the release records each plugin's `sourceDigest` from that spec's run.

   Its security review lands with it. `docs/decisions.md` records that Clawtrate writes a plugin's approved grants when it installs that plugin, and the voice plugin's README drops its manual steps.

3. **What a person sees**, in the variant the owner chose:
   - the first-setup line or card;
   - the already-paired line;
   - the Bot voice row without its link;
   - Take it off, Turn on and Add again;
   - section 10's lines, each tested by its exact words.

   Pictures at desktop and phone width.

4. **The update a person asks for** (section 11; row 4 of section 3.5).
5. **Over SSH**, once the SSH screens exist: the copy script and its removal.
6. **By address**, once section 8's publish is done: the npm source with `expectedIntegrity`, and the packer and workflow for more than one plugin, which can land before the publish.
7. **Each other plugin**, in the pull request after its review: added to the pin, and offered to gateways already set up.

Steps 1 to 3 need no publish. They bring Bot voice only to a gateway on the person's own computer that Clawtrate reaches by one-click Connect, and that can read the app's tarball. What ran was a development gateway on macOS over a direct loopback socket (section 13). A gateway reached any other way waits for step 5 or 6.
