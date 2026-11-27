# Clawtrate installs its own plugins

How the app puts Clawtrate's own OpenClaw plugins on a person's gateway by itself, once, at first setup, keeps them current with the app, and takes them off again, with no outside page, no terminal and no config file for the person (issue #796, part 3). This is a design: it builds nothing.

It extends section 6 of `bots-in-clawtrate.md`, which designed this for `clawtrate-bots` alone, to all of Clawtrate's plugins, and settles what that section left open: what a gateway on another computer can take without a registry, whether loading needs a restart, and what a staged plugin does when the gateway starts again. Where the two documents say the same thing, this one points there.

**Established** marks what both OpenClaw versions' published packages show (`openclaw@2026.10.6`, the pin, and `openclaw@2026.11.10`) or what a run on a development gateway of each showed; each fact says which. **Proposed** marks this design's choice. **Not established** marks what was not shown (section 13). `<1006>/…` and `<1110>/…` are paths inside each package. 2026.11.10's `dist/` is minified onto few lines, so for it the file and the function are named instead of a line.

**The runs.** A development instance of each version, started with `pnpm dev-gateway start --instance <name> --no-seed` (2026.11.10 through `OPENCLAW_BIN`), with paired operator connections at admin, read-and-write and read-only. Each plugin was packed with `npm pack --ignore-scripts` into a read-only folder laid out like a packaged app's resources. Then, on each version: install with `enable: false`, `plugins.inspect`, `plugins.setEnabled`, the plugin's own method before and after, the hook grant through `config.patch`, the archive moved away, `plugins.reload`, install again, `mode: "update"` to a newer and then an older version, `plugins.uninstall`, `gateway.restart.request`, and a cold start: the gateway process stopped and started again on the same state. A `git://` URL served on loopback by a `git daemon` of the run's own stood in for a network git source. `terminal.upload` ran on 2026.10.6 only. No gateway on another computer was reached: a development gateway listens on loopback, and a connection made to look remote with proxy headers is refused outright (`<1006>/dist/server-start-D6vaUNGz.mjs:7365-7372`), so what a remote connection may do is read from the source and checked by calling OpenClaw's own rule (section 2).

## The page to decide from

- **On the gateway's own computer, nothing has to be published.** The app carries each plugin as a tarball outside its archive and hands the gateway its path: `plugins.install {source: "npm-pack", archivePath, enable: false}`. The gateway copies it into its own managed folder, so the app writes nothing to disk and the copy survives the app being moved or updated (ran, both versions).
- **No restart.** Installing, enabling, updating, reloading and removing a plugin all apply while the gateway runs, and the plugin's methods answer at once; so does the config write that lets its hook run (ran, both versions). The decided "one restart" stays only as the fallback for a gateway that ever answers `restartRequired: true`, which neither version did.
- **A gateway on another computer reached through Clawtrate's SSH route counts as local too**, because the forward arrives on its loopback. The app copies the tarball there over its own SSH connection and installs it the same way (read, not run).
- **A gateway on another computer reached by its address can't take the app's own copy.** Every source that names a file is refused to a connection that isn't local. What remains is a package from a registry or a git repository on the network. **This one case needs a publish.** The design uses npm, which the gateway itself checks by SHA-512 before writing anything; it needs the owner once, in person, for an npm sign-in (section 8). Nothing else waits for it.
- **Safe for everyone at first setup today: `clawtrate-voice` only.** The other four wait for their own reviews (section 9). The tool-rules plugin and anything else that changes how a bot's commands are approved is never switched on for anyone before its security review (issue #675, and the reviews of #678, #691 and #692).
- **What a person sees:** one line on the Connect card, "Connecting also adds Clawtrate's plugin for Bot voice to this OpenClaw. You can take it off in Settings.", and nothing else unless something fails. Taking it off is Undo, from Settings, with nothing asked.

## Contents

1. Every way a gateway takes a plugin
2. Local and remote, and which connection is which
3. The route on the gateway's own computer
4. The route over SSH
5. The route by address
6. Access
7. Restart
8. Publishing, for the route by address
9. The five plugins, and what each changes
10. What a person sees, and each failure
11. Keeping current, and two Clawtrates on one gateway
12. Removal and Undo
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

Each install also takes `mode: "install" | "update"`, `enable`, `acknowledgeInstallPolicyWarning` and `acknowledgeCapabilities: {reviewToken}`. The npm source accepts only a registry name and version: a URL, a git ref or any other protocol spec is refused (`<1006>/dist/npm-registry-spec-B_IER0ZB.mjs:17-28`; the same messages in `<1110>/dist/npm-registry-spec-D06XlvdA.mjs`), so a tarball on a web page can't be installed through it.

**Other ways in, and why none is the route:**

- **`plugins.load.paths` in the gateway's config** loads a folder in place. It is what `pnpm dev-gateway start --with-plugin` uses: the tool copies a checked snapshot of the plugin into the instance's own state folder and writes that path and the plugin's entry into the config before the gateway starts (`tools/dev-gateway/src/dev-plugins.ts`, its header; `tools/dev-gateway/src/cli.ts:628`). For a person's gateway it needs the files on that computer first, and the only folders a remote connection can write through the gateway's methods are a bot's workspace (`agents.files.set`, `sessions.files.set`) and a terminal's 24-hour temporary folder. Code that runs inside the gateway must not live where a bot can rewrite it, or expire.
- **`skills.upload.*`** takes a skill archive into the default bot's workspace (`<1006>/docs/gateway/protocol/operator-methods.md:75-94`; `<1110>/…:114-133`). A skill is not a plugin.
- **The operator terminal** (`terminal.open`, `terminal.input`, `terminal.upload`, all `operator.admin`) could stage the archive and type `openclaw plugins install` into a shell on the gateway's computer. `terminal.upload` staged a tarball in a private temporary folder, and `npm-pack` installed it from there on a local connection (ran, 2026.10.6; the same method in `<1110>/docs/gateway/protocol/rpc-system-and-channels.md:290`). As a route it opens a login shell outside any sandbox in the person's home (the run's answer: `confined: false`), depends on `gateway.terminal.enabled` and an unsandboxed bot, and gives no structured answer. Rejected.

**The repository today.** None of the plugins is published: the registry answers 404 for `@clawtrate/clawtrate-bots`. `plugins-publish.yml` and `apps/desktop/packaging/plugin-npm.ts` pack and publish `clawtrate-bots` only; their tests (`apps/desktop/test/plugin-npm.test.ts`) pin that one package and the lock's form (`docs/development/plugins-publish.md`, "The lock"). Its `bootstrap` mode ran once, on 2026-11-26, and packed the placeholder; the placeholder was not published, so no trusted publisher exists yet. The other four `package.json`s have no `@clawtrate/` name and no `files` list. Each plugin's README tells a gateway's owner to run `openclaw plugins install --link` from a checkout and set the hook grant by hand, and the voice plugin's says "Clawtrate never writes the gateway's config" (`plugins/clawtrate-voice/README.md`); this design replaces both (section 14).

## 2. Local and remote, and which connection is which

**Established.** `plugins.install` refuses `npm-pack`, `local`, `marketplace` and a local git URL unless the gateway counts the connection as local: "Local plugin artifacts require a connection from the Gateway host." (`<1006>/dist/plugins-mutations-ClrWTX5-.mjs:72-73`; the same check in `<1110>/dist/plugins-mutations-MjAXEDgk.mjs`). Local is a direct connection from a loopback address with no forwarding or Tailscale headers (`<1006>/dist/ingress-attribution-BQX5Ye8B.mjs:107`, `message-handler-CRCo2VX0.mjs:3419`; `attributed("direct-local", …)` in `<1110>/dist/ingress-attribution-CsgYtK-V.mjs`). The rule itself, `pluginInstallRequiresLocalHost`, was called from each version's own module with ten requests and answered the same on both: `npm-pack`, `local`, `marketplace` and a `file:` git URL need a local connection; `npm`, `clawhub` and an `https`, `git://` or GitHub-shorthand git URL don't (`<1006>/dist/install-source-plan-CNjlQOX3.mjs:22-31`; `<1110>/dist/install-source-plan-BXa2Slf_.mjs`).

So, for Clawtrate's three kinds of route (`setup.md`):

- **This computer** (one-click Connect, #688 and #689, and an address typed as `ws://127.0.0.1`): the app's own socket to loopback. Local (ran: every install in this design's runs used such a connection).
- **SSH**: the app's forward is `ssh -L 127.0.0.1:<free port>:127.0.0.1:<gateway port>` (`docs/decisions.md`, "SSH to another computer"), so the gateway's side of it is `sshd` connecting from loopback. Local by the rule above (read, not run). The paths it names are on that other computer.
- **By address** (`wss://`, Tailscale Serve, a LAN address): not local. Tailscale Serve's connections are attributed `tailscale-serve`, never `direct-local`.

**Proposed:** the app chooses the route by the connection it made and confirms it by the gateway's answer: a refusal with the local-artifact error moves it to the route by address, never the other way.

## 3. The route on the gateway's own computer

**Proposed, every step run on both versions:**

1. **The app carries the tarballs.** The packaged app ships each plugin's tarball under its resources, outside `app.asar`: `Clawtrate.app/Contents/Resources/plugins/` on macOS, `resources\plugins\` beside the executable on Windows (an `extraResources` entry in `apps/desktop/packaging/config.ts`). The gateway reads the file with plain Node, which can't read inside an Electron archive. Built into the signed app with them, a list: for each plugin its package name, exact version, `sha512-…` integrity, plugin id, and the tools, hooks and contracts its manifest declares (the lock of `plugins-publish.md`, made for every plugin the app carries).
2. **Read first.** `config.get` and `plugins.list`. Stop for a plugin in `plugins.deny`, one a non-empty `plugins.allow` leaves out after Clawtrate added it, or one taken off before (section 12): each is the gateway owner's choice (`bots-in-clawtrate.md` §6.4).
3. **Stage it without running it:** `plugins.install {source: "npm-pack", archivePath: <the app's tarball>, enable: false}`. Ran: each of the five installed, the first three from a folder no one could write; the answer is `restartRequired: false` with an empty runtime receipt; the plugin's methods are unknown afterwards; no config entry is written.
4. **Check what was staged:** `plugins.inspect {pluginId}`. Ran: `source.integrity` is exactly the tarball's SHA-512 (`integrityKind: "ssri"`) on both versions, the same bytes giving the same value on both; with the version, the package name, `declared` (tools, hooks, contracts) and a `reviewToken`. Compare all of them with the built-in list. `npm-pack` itself takes no expected integrity (the schema refuses the field, ran on both), so this comparison is the check.
5. **Grant what its manifest needs, then enable it:** for `clawtrate-voice`, `config.patch {baseHash}` writing `plugins.entries.clawtrate-voice.hooks.allowConversationAccess: true`; then `plugins.setEnabled {pluginId, enabled: true, acknowledgeCapabilities: {reviewToken}}`. Ran: `restartRequired: false`, and `clawtrate-voice.get` answered at once with `hook.state: "needs-conversation-access"`, then `"allowed"` a few seconds after the grant, with no restart.
6. **Confirm** the plugin's own method answers, and that `plugins.list` shows it `runtime.state: "active"`.
7. **On any difference in step 4,** `plugins.uninstall`. Nothing of it ran.

**The copy is the gateway's.** The gateway extracts the archive into `<state>/npm/projects/<id>/node_modules/<package>`; with the app's folder moved away, the plugin kept answering and `plugins.reload` reloaded it from that copy (ran, both). So an app update, a move to another folder or macOS's translocated launch doesn't break an installed plugin.

**Staged is not loaded, across a restart too.** `plugins.list` reports a staged plugin `enabled: true` while its `runtime.state` is `"unloaded"`, because `enable: false` writes no entry and the list shows the default policy (`<1006>/dist/management-install-CiDYuS33.mjs:198-208`). After `gateway.restart.request` and after a cold start of the gateway process on the same state, every staged plugin stayed unloaded and its methods unknown, while the enabled ones loaded (ran, both versions). So an interrupted install never runs unchecked code later. A person's own `openclaw plugins enable` would run it; that is their action.

**Two devices at once.** The gateway runs one plugin or config change at a time and answers a second with `UNAVAILABLE`, "Another plugin or config operation is already running; retry when it completes." (ran, both; 2026.11.10 adds `details.mutationAccepted: false`). Installing what is already there answers "plugin already exists … (delete it first)". The app waits and tries again, and treats "already exists" as "read and compare".

**What the app writes on the person's disk itself: nothing.** The gateway reads the app's file and writes its own folder. This keeps one-click Connect's rule that the app only reads OpenClaw's profile (#688). Its check covers this case well: it already shows that the gateway at that socket runs as this account, so the account can read the app's resources. An address typed under Advanced has no such check: a gateway there may run as another account or in a container, where the path doesn't exist or can't be read. The gateway then answers an error, and the app takes the route by address (section 5).

## 4. The route over SSH

**Proposed, read and not run** (the SSH screens aren't built yet; `docs/decisions.md`, "SSH to another computer", "Not done here"):

1. Over its existing SSH route, the app runs one more constant script, as it runs the LOOK: it makes a private folder under that computer's temporary folder (`umask 077`, `mktemp -d`), writes the tarball from standard input, and prints the folder's path and the file's SHA-512.
2. Through the forward, steps 2 to 7 of section 3 with that path. The gateway counts the forward as local (section 2).
3. The app removes its folder by its exact path once the gateway has its copy, and at its next SSH contact if it couldn't then.

`terminal.upload` would do step 1 through the gateway's own methods; section 1 says why it is not the route.

## 5. The route by address

**Established:** no gateway method takes a plugin's bytes from a connection that isn't local. What such a connection can install is a package from a registry (`npm`, `clawhub`) or a git repository on the network.

**Proposed: npm,** with the gateway's own checks: `plugins.install {source: "npm", spec: "@clawtrate/<plugin>@<exact version>", pin: true, expectedPluginId, expectedIntegrity, enable: false}`, then steps 4 to 7 of section 3. The gateway downloads from its own registry setting, refuses a different integrity before it installs ("aborted: npm package integrity drift detected", `<1006>/dist/npm-integrity-C9ZL9MoY.mjs:3-27`), refuses another plugin id, and installs with `--ignore-scripts` (`bots-in-clawtrate.md` §6.3, where each is cited). That the npm route refuses other bytes was read, not run: running it needs a registry. It needs the packages published (section 8).

**The other way, which needs nobody in person, and why it is second.** A gateway installs from a network git URL pinned to a full commit: `plugins.install {source: "git", spec: "git:https://github.com/<owner>/<repo>.git@<40-hex commit>", enable: false}`. Ran on both versions from a `git://` URL on loopback: it installed with no install-policy warning, `plugins.inspect` reported `integrity: <the commit>` with `integrityKind: "git-commit"`, and the plugin behaved as one installed from an archive. It would need a small public repository whose commits each hold one plugin at its root:

- the gateway clones the whole repository given (`git clone` without `--depth` when a ref is named, `<1006>/dist/git-install-BVB7NPXr.mjs:45-50`), so it can't be Clawtrate's own repository, about 2 GB;
- it needs `git` on the gateway's computer, which a container image or a Mac without its developer tools may lack;
- the code is bound by a SHA-1 commit id, against npm's SHA-512 checked before anything is written.

The release coordinator could make that repository and publish to it with the release machine's existing GitHub sign-in. If the owner would rather not take part at all, this is the way; the sequence is the same except for the source.

**Until a publish exists,** a gateway reached by its address gets no plugin, and Settings says so in one line (section 10). Everything else in this design ships without it.

## 6. Access

**Established** (`<1006>/dist/core-method-policy-DkntKRY_.mjs:186`, `205`, `1638`, `2004`, `2119`, `2580`; the rpc pages above; ran, both versions):

| Method                                                                         | Scope            |
| ------------------------------------------------------------------------------ | ---------------- |
| `plugins.install`, `plugins.setEnabled`, `plugins.uninstall`, `plugins.reload` | `operator.admin` |
| `config.patch`, `gateway.restart.request`, `terminal.upload`                   | `operator.admin` |
| `plugins.list`, `plugins.inspect`, `config.get`                                | `operator.read`  |

Ran: a read-only and a read-and-write connection asking `plugins.install` were refused `missing scope: operator.admin`; the read-only one listed the plugins. A plugin's own methods that aren't loaded answer a connection below admin `missing scope: operator.admin` and an admin `unknown method`, as `docs/decisions.md` ("The rules plugin") records; the app tells a missing plugin from `hello-ok.features.methods`.

**Proposed:** only a connection with full control installs, updates or takes off a plugin. Clawtrate asks for full control at its first pairing (`setup-effortless.md` §2), so first setup normally has it. A connection without it changes nothing and shows what `plugins.list` says (section 10).

## 7. Restart

**Established: none is needed.** "These mutations wait for runtime application without restarting the Gateway" (both versions' rpc page, `<1006>` line 152, `<1110>` line 155). Every install, enable, update, reload and uninstall in the runs answered `restartRequired: false` and published a new runtime generation, and a config write under `plugins` is applied hot, reloading plugins (`<1006>/dist/config-reload-plan-BmEf0hE9.mjs:292-295`; the same rule in `<1110>/dist/config-reload-plan-BR9X4bST.mjs`).

**What a person's bots and tasks experience.** By the source nothing restarts, and in the runs each plugin answered within seconds of each change. A run already going keeps the plugins it started with: the rules checks saw a run go on asking after the rules plugin was turned off in the middle of it (`docs/decisions.md`, "The rules plugin"). The voice guide reaches each bot from the next system prompt the gateway builds. The hot reload of a config write under `plugins` also disposes the gateway's MCP runtimes (same line of `config-reload-plan`); what that does to an MCP call in flight was not run. **Proposed:** on a gateway with a run going (`sessions.list`, `hasActiveRun`), the app waits for it to end before the grant's `config.patch`, at most a few minutes, and then writes it.

**If a gateway ever answers `restartRequired: true`** (the docs name edited bundled code, which isn't Clawtrate's case): one restart for all the plugins together, at the end of first setup, with one line, "Restarting OpenClaw once to finish adding Clawtrate's plugins." The app calls `gateway.restart.request {}`. Ran on both: it answered `status: "scheduled"` with a preflight ("safe to restart now", or the active work that defers it), restarted the gateway in place, and the client reconnected by itself. The app then reads `plugins.list` again and goes on. A restart that doesn't come back is the connection's own failure state.

## 8. Publishing, for the route by address

Needed only for section 5's npm route. Everything in `plugins-publish.md` and `bots-in-clawtrate.md` §6.9 stands; for more than one plugin:

**On the repository's side (a pull request, no one in person):**

1. Each plugin to publish gets `"name": "@clawtrate/<folder>"` and a `files` list in its `package.json` (only `clawtrate-bots` has them).
2. `plugin-npm.ts` and `plugins-publish.yml` take the plugin as an input, one of a fixed list, and the lock holds an entry per plugin. Their tests cover each.
3. The release packs every plugin the app carries, from its own commit, and fails when a plugin's bytes changed but its version didn't.

**Once, by the owner in person, one sign-in for all five packages** (npm sets up trusted publishing only on a package that already exists, `docs.npmjs.com/trusted-publishers`, read 2026-11-26):

1. The release coordinator runs the workflow with `mode: bootstrap` for each of the five and checks each placeholder's SHA-512 against the run's summary (`openssl dgst -sha512 -binary <file>.tgz | openssl base64 -A`).
2. The owner signs in to npm in a terminal with two-factor authentication (`npm login`), and for each placeholder: `npm publish ./<file>.tgz --access public --tag bootstrap`, then `npm deprecate @clawtrate/<plugin>@0.0.0 "Placeholder: install a released version"`.
3. For each package on npmjs.com: **Settings**, **Trusted publishing**, GitHub Actions, organization `sidebandstudio`, repository `clawtrate`, workflow `plugins-publish.yml`, environment `npm`. Then **Publishing access**: "Require two-factor authentication and disallow tokens".
4. `npm logout`.
5. Within two days, the release coordinator runs `mode: publish` for each of the five, which validates its trusted publisher. Each plugin's first real version is published then, whether or not the app carries it yet; no app installs a version its signed list doesn't name.

**Each release afterwards, nobody in person:** the release dispatches `mode: publish` for each plugin; a plugin that didn't change keeps its version and packs to the same bytes, so nothing new is published; the release compares the registry's integrity with its own packing and stops on a difference (`bots-in-clawtrate.md` §6.9, "The app's release").

## 9. The five plugins, and what each changes

**Read from each plugin's README and code; each loaded and answered on both versions when installed and enabled by section 3's steps, except where the table says:**

| Plugin                 | What it changes on a gateway once loaded                                                                                                                                                                                        | At first setup today                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `clawtrate-voice`      | Adds Clawtrate's voice guide to the end of each bot's system prompt, in runs whose runner calls its hook, until a person turns it off; reads nothing of the conversation; keeps one setting row.                                | **Yes.** It needs the hook grant (`allowConversationAccess`), which Clawtrate writes as part of installing it.                             |
| `clawtrate-bots`       | Adds gateway methods that keep bots' proposed changes and a journal for Undo; changes no bot by itself today (Apply is reported unavailable). Its tools and holds come later.                                                   | No: its install waits for the security review its own design requires (`bots-in-clawtrate.md` §10, step 4).                                |
| `clawtrate-memory`     | Adds methods that list, read and change bots' notes and shared memory files from Clawtrate.                                                                                                                                     | No: development gateways only until issue #41's security review.                                                                           |
| `clawtrate-tool-rules` | Decides every tool call a bot makes by rules (run, ask first, never), through a hook on every call.                                                                                                                             | **No.** It changes how a bot's commands are approved: not switched on for anyone before issue #675 and the reviews of #678, #691 and #692. |
| `clawtrate-computer`   | A browser of its own for each chosen bot, which people watch live and take over. Outside a Clawtrate development instance it registers nothing, by its own guard (`plugins/clawtrate-computer/index.js`; not checked by a run). | No: issue #29.                                                                                                                             |

**Proposed:** the app's built-in list holds only the plugins installed for everyone. A plugin joins it in the pull request that follows its review, and from then on the app adds it to gateways already set up (section 10) with the same line.

## 10. What a person sees, and each failure

**First setup.** Directly below the consent line on every card that pairs (`setup-effortless.md` §2), one line: "Connecting also adds Clawtrate's plugin for Bot voice to this OpenClaw. You can take it off in Settings." Connect is the consent, as it is for full control. After Connect the install runs in the background while the first run goes on; it takes seconds (ran: 5 to 13 seconds per plugin on a heavily loaded machine), and there is nothing more to see when it works.

**Already set up, when the app first carries a plugin:** the app installs it at its next connection with full control, and the status line says once: "Added Clawtrate's voice plugin to OpenClaw · Undo".

**Afterwards:** Settings, Conversation, Bot voice works with no link and no setup steps. Under it, quietly: "Clawtrate's voice plugin is on this gateway · Take it off". The outside link Settings shows today (`packages/ui/src/Settings.tsx:392-413`) goes, as #796's first part asks.

**When it isn't installed**, one line in the same place, with the gateway's own words behind an "i" where it gave any:

| What happened                                                                 | What the person sees                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The connection has no full control                                            | "Clawtrate needs full control of this gateway to add its voice plugin." with setup's existing way to get it                          |
| A gateway reached by its address, before a publish                            | "Clawtrate can't add its voice plugin to a gateway it reaches by its address yet."                                                   |
| The gateway refused the install (an error, an unreadable path)                | "OpenClaw didn't add Clawtrate's voice plugin." · Try again                                                                          |
| The install policy warned (`install_policy_warning_acknowledgement_required`) | "OpenClaw warned about Clawtrate's voice plugin." with the warning, and Add anyway; Clawtrate never acknowledges a warning by itself |
| What was staged isn't the app's copy                                          | "The plugin OpenClaw got didn't match the one this Clawtrate carries, so Clawtrate removed it. None of it ran." · Try again          |
| The plugin didn't start (`setEnabled` failed, or its method doesn't answer)   | "Clawtrate's voice plugin didn't start on this gateway." · Try again; it is left turned off                                          |
| A restart was needed and the gateway didn't come back                         | The connection's own state, then the line above once it is back                                                                      |
| Taken off, turned off or denied in the gateway's settings                     | "Turned off in the gateway's settings" · Add again                                                                                   |
| A newer version is on the gateway than this app knows                         | Nothing, when the plugin's methods are ones the app knows; otherwise "Update Clawtrate on this device to use Bot voice."             |

No line links to a page outside the app.

**Other places.** Only the desktop app installs: it carries the files and makes the local routes. The web viewer and the iPhone app (`apps/mobile`, another thread's) show what `plugins.list` and the plugin's methods say and change nothing on the gateway's plugins.

## 11. Keeping current, and two Clawtrates on one gateway

**Established:** `plugins.list` gives each plugin's `version`, `packageName`, `enabled` and `runtime.state`; `plugins.inspect` gives its source and integrity. `mode: "update"` replaces an installed plugin and keeps its enabled state. **The gateway doesn't refuse an older version:** an update from 0.2.0 to 0.1.0 succeeded on both versions.

**Proposed:**

- At each connection with full control, and on `plugins.changed`, the app compares each plugin in its list with what the gateway has.
- **Same version and integrity:** nothing.
- **Older, and Clawtrate's own** (its package name, installed from an archive or npm): update by section 3's steps with `mode: "update"`.
- **Newer:** never touched. The app uses it when its methods are ones the app knows (each plugin keeps its previous method shapes working for at least two releases, as `bots-in-clawtrate.md` §6.5 says for the bots plugin), and otherwise shows the line in section 10.
- **Same version, other bytes, or installed another way** (a linked checkout, a path, git): left alone, as `bots-in-clawtrate.md` §6.7 says.
- Because the gateway takes an older version, the app reads `plugins.list` immediately before each update. Two devices can still race between that read and the update; the newer app sees the lower version at its next `plugins.changed` and updates again, so the newest copy wins.
- A release fails when a plugin's bytes changed but its version didn't (section 8), so a version always names one set of bytes.

## 12. Removal and Undo

**Established** (ran, both versions): `plugins.uninstall {pluginId}` answers `removed: ["plugin settings", "install record", "directory"]`, with no restart; it leaves `plugins.entries.<id>.enabled: false` and nothing else of the entry (the hook grant goes), and adds nothing to `plugins.deny`. Installing the same plugin again then stages it with that entry still `false`, so only a deliberate enable turns it on.

**Proposed:**

- **Take it off** (Undo of the install): `plugins.uninstall`. The entry it leaves (`enabled: false`) is the record, on every device, that the person took it off: no Clawtrate adds it again by itself. **Add again** installs it by section 3's steps and enables it.
- **Turn off** (the plugin's own switch, where it has one, such as Bot voice's): the plugin's setting, not the plugin.
- Taking off `clawtrate-voice` loses only its on-or-off row, so it asks nothing. A plugin whose removal loses something a person can't get back (the bots plugin's journal) asks once, as `bots-in-clawtrate.md` §6.6 says.
- What a plugin keeps outside its install folder (the voice setting's row, the rules plugin's store in the state folder) is not in `plugins.uninstall`'s list of what it removed; whether it removes a plugin's rows in the gateway's database was not run (section 13).

## 13. Not established

- **A gateway on another computer:** no remote connection was made. The refusal of local sources to it, the local attribution of an SSH forward, and the npm route's integrity check are read from both versions' source; OpenClaw's own local-host rule was called and answered as section 2 says.
- **The packaged app's own path:** that a gateway reads a tarball inside a signed `Clawtrate.app` (and a translocated one) and a Windows install's `resources` folder was not run; the runs used a read-only folder laid out the same way, on macOS.
- **A gateway as another account, in a container, or in WSL** on the same computer: the gateway's error for an unreadable or missing path was not seen.
- **`terminal.upload` on 2026.11.10:** run on 2026.10.6 only; the same method and words are in its rpc page.
- **What the hot reload's disposal of MCP runtimes does to an MCP call in flight.**
- **Whether `plugins.uninstall` removes a plugin's rows in the gateway's database.**
- **Whether `clawtrate-computer` registers nothing** when installed by section 3 on a development instance: its guard was read; the run asked it a method it doesn't have.

## 14. What must exist first, and the order of pull requests

**Before it can be built:** nothing new from OpenClaw: every method is on both versions. A security review of the install sequence (sections 3 and 11), which `bots-in-clawtrate.md` §10 step 4 already requires. For the route by address only, section 8's publish.

**The order**, each small enough to review alone, each run on development gateways of both versions:

1. **The app carries its plugins.** Packing each listed plugin from the release's commit, the tarballs under `extraResources`, the built-in list with integrity and declared surface, and the release check that a changed plugin has a new version. Only `clawtrate-voice` is listed. The voice plugin's `package.json` gets its `files` list. Nothing installs yet.
2. **The install engine in core.** Read, stage, inspect and compare, grant, enable, confirm, uninstall on a difference, retry when busy, the update and newer-version rules, and the record of a plugin taken off; tested against both versions' frames. The development gateway gains `--install-plugin <name>`, which packs from the checkout and runs this sequence on a local connection (`bots-in-clawtrate.md` §6.8), and one e2e spec installs, updates and takes off the voice plugin on each version. Its security review lands with it. `docs/decisions.md` records that Clawtrate writes a plugin's hook grant when it installs that plugin, and the voice plugin's README drops its manual steps.
3. **What a person sees.** The line on the Connect card, the status line for those already set up, the Bot voice row without its link, Take it off and Add again, and section 10's lines, each tested by its exact words. Pictures at desktop and phone width.
4. **Over SSH,** once the SSH screens exist: the copy script and its removal.
5. **By address,** once section 8's publish is done: the npm source with `expectedIntegrity`, and the packer and workflow for more than one plugin (which can land before the publish).
6. **Each other plugin**, in the pull request after its review: added to the built-in list, and installed on gateways already set up with the same line.

Steps 1 to 3 need no publish and bring Bot voice to every gateway on the person's own computer.
