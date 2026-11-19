# Connectors: what the gateway allows

What Clawtrate can show and do for connectors (the plugin catalog, adding a connector, a connector's state and sign-in, and tool servers a person adds by address or by command), checked against OpenClaw 2026.10.6. It is the evidence behind `docs/design/connectors.md` and settles the dependency cells of `docs/parity.md` rows F-004, F-217 to F-221 and F-380 to F-383. The capability map's section 21, "Connectors and MCP servers", is the starting point; where this note differs from it, the note says so.

How to read the citations, as in `gateway-capabilities.md` and `setup-flow.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Chunk names carry a build hash that changes with every release; search by the `//#region <source path>` marker at the top of each chunk. Line numbers are of the 2026.10.6 chunks.
- `schema` is `protocol.schema.json` in `@openclaw/gateway-protocol@2026.10.6`.
- **Tried** means it was run on a development instance and the result is quoted. **Source** means it was read in shipped code. **Docs** means it was read in the bundled documentation only. **Not tried** says why.

Where things were run: one named development instance, `d11conn`, started by this checkout with `pnpm dev-gateway start --instance d11conn` and seeded as usual. The probes are in [`connectors/probe.ts`](connectors/probe.ts) and use this project's own client (`packages/core`) where the desktop app would. Two devices were paired: one left at `operator.read`, one raised to `operator.admin` through `device.scopes.requestUpgrade` and the gateway's own `devices approve`. Every secret was a made-up `example-…` string; every address was loopback, a reserved `.example` name or the documentation range `192.0.2.0/24`. No plugin was installed, no catalog was fetched and no outside sign-in was made. The instance was reset afterwards (section 9).

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | Is a development instance confined to loopback? | It was not. On start the gateway asked `catalog.openclaw.ai:443`, and `plugins.list`, every `plugins.catalog.*` method, `plugins.search`, `skills.search` and `plugins.install` ask `clawhub.ai`. The tool now sets the gateway's own `proxy.proxyUrl` to the instance's scripted model, which refuses and logs each such request. **Tried**: the log shows each host, and every later result in this note was taken behind it. | 1 |
| 2 | Where does the catalog come from, and what do its methods return without it? | From ClawHub over HTTPS, joined with what the gateway has on disk. Without ClawHub: `plugins.list` still answers (the gateway's 70 plugins, bundled or known); `plugins.catalog.browse` answers with only what is on the gateway and a `remoteError` ("ClawHub is unavailable: … Installed plugins remain available."), after about 14 s of retries; `featured` and `trending` answer nothing but the error; `plugins.catalog.categories` fails (`UNAVAILABLE`, "Plugin categories are unavailable: … Retry to reconnect to ClawHub."); `plugins.catalog.get` for a plugin on the gateway answers from disk, for one only on ClawHub fails; `plugins.search` and `skills.search` fail. **Tried.** | 2 |
| 3 | What is "Add"? | `plugins.install {source, packageName \| pluginId, version?, acknowledgeCapabilities?, acknowledgeInstallPolicyWarning?}`, `operator.admin`. For ClawHub and official sources the gateway downloads the package from ClawHub, extracts it, installs its npm dependencies with `--ignore-scripts`, and loads it into the running gateway, without a restart (`restartRequired` says when one is needed). It reports stages to the connection that asked (`plugins.install.progress`: resolve, download, extract, files, dependencies, runtime). It can refuse first with a capability review or an install-policy warning that must be acknowledged. A failure after the files were written is reported with `details.persistence`. **Source**; tried only up to the download, which the instance refused. | 3 |
| 4 | Turning a connector off and on, and removing one | `plugins.setEnabled` and `plugins.uninstall`, `operator.admin`, each answering with the plugin's new state and a runtime generation; a bundled plugin cannot be removed ("bundled plugin cannot be uninstalled: … disable it instead"); a second change straight after the first was refused once ("Another plugin or config operation is already running; retry when it completes."). **Tried.** Uninstall keeps an `enabled: false` marker and does not touch stored sign-ins. **Docs, source.** | 4 |
| 5 | Adding, reading back and removing a server | `config.patch` on `mcp.servers.<name>` (`operator.admin`): accepted and applied without a restart; read back through `config.get` with header values as `__OPENCLAW_REDACTED__`; removed with `null`, and a command server's `args` needs `replacePaths`. The gateway refuses a bad or non-http(s) address, and a `clientId` or `clientSecret` (no such fields), and accepts an empty command or neither command nor address. Whether a server answers is known only after a bot's next run: then the gateway's tool list for that task lists its tools, or a warning naming the failure. **Tried.** | 5 |
| 6 | Where are a header and a sign-in kept? | A header is written in plain text into the gateway's configuration file and is never read back by a client; it goes when the server is removed. A sign-in's access and refresh tokens are kept in plain text in the gateway's state database (`state/openclaw.sqlite`, `mcp_oauth_stores`) and stay there when the server is removed through `config.patch`. **Tried.** | 6 |
| 7 | Sign-in | `mcp.authLogin {sessionId, serverName}`, `operator.admin`, only for a shared OAuth server and only on a connection with a browser origin; it runs a wizard whose one step carries the sign-in page (`externalUrl`, which must be `https`), returns to the gateway's `/oauth/provider/callback`, and ends `done` or with an error; 10 minutes. **Tried** end to end on loopback with a stand-in OAuth server, on a web chat connection declaring a loopback origin; this project's client is refused ("Open Settings on this Gateway to sign in, or use openclaw mcp login in its terminal."). A per-requester server is refused there and gives the bot a `<server>__connect` tool instead. **Source.** | 7 |
| 8 | What the gateway reports about a connector | A plugin: `state` and `runtime.state` in `plugins.list` (**tried**), and, for the OAuth servers a plugin declares, `mcpAuth [{serverName, state}]` in `plugins.inspect` (**source**; no plugin on the instance declares one). A server in `mcp.servers`: its configuration, and the latest tool list's notices; no sign-in state and no accounts. **Tried.** | 8 |

## 1. Confining the instance to loopback

The rules for this work say an instance reaches nothing beyond loopback. Reading the catalog's source first showed that it was not so: `plugins.list` calls `listManagedPlugins`, which loads the hosted official catalog (`<openclaw>/dist/management-service-B1oc-TT4.mjs` lines 219-227), fetched from `https://clawhub.ai/v1/feeds/plugins` with the host pinned to `clawhub.ai` (`official-external-plugin-catalog-source-8hS3NARf.mjs` lines 13, 152), and the other catalog methods call ClawHub's API at `https://clawhub.ai` unless `OPENCLAW_CLAWHUB_URL` is set (`clawhub-client-B-TQ3xH6.mjs` lines 136, 155), which the tool's environment allowlist drops. **Source.** The development config already turned off update checks and mDNS; nothing kept the catalog off the network.

So the tool now writes `proxy.proxyUrl: "http://127.0.0.1:<scripted model port>"` into every instance's config (`docs/decisions.md`, "Sandbox config"). With a proxy set, the gateway routes its HTTP and WebSocket clients through it, and in the default `loopbackMode: "gateway-only"` loopback connects directly (`<openclaw>/docs/security/network-proxy.md`, "How routing works"). The scripted model answers a tunnel request with 403, and any other proxied request with a 403 body, and logs "refused a request beyond loopback" with the host (`tools/dev-gateway/src/fake-provider.ts`; unit test `tools/dev-gateway/test/egress.test.ts`).

**Tried.** The gateway logged `[proxy] routing process HTTP traffic through external proxy http://127.0.0.1:19770`, and the scripted model's log then showed:

```
refused a request beyond loopback: CONNECT catalog.openclaw.ai:443      (on start, before any client connected)
refused a request beyond loopback: CONNECT clawhub.ai:443               (seeding; then every catalog read)
refused a request beyond loopback: CONNECT 192.0.2.10:443               (a tool server at a documentation-range address)
```

**The one start before the fence.** The first start of `d11conn` in this work came before the fence, so it reached the network as every instance on `main` does; it left no log of its requests, so this is what the gateway's source and the identical fenced starts show:

- On start, one `GET https://catalog.openclaw.ai/models/v2/catalog.json`, the remote model catalog refresh (`<openclaw>/dist/remote-overlay-Bpv95iW5.mjs` line 288; `remote-refresh-BsfrKP5f.mjs` lines 47-80). Its only header of OpenClaw's own is `Accept: application/json`; `If-None-Match` and `If-Modified-Since` are added only when a catalog was stored before, which a fresh instance has not. No query and no body.
- During seeding, a few seconds later, HTTPS to `clawhub.ai`. The fenced log shows only the host (`CONNECT clawhub.ai:443`), not the path. By the source, the gateway's requests to that host are its plugin catalog's; the most likely one at that point is the official plugin feed, `GET https://clawhub.ai/v1/feeds/plugins` (`official-external-plugin-catalog-source-8hS3NARf.mjs` line 13), with conditional headers only from a stored snapshot. Which request it was is not established.
- Neither request carries the instance's name, profile, gateway token, device identity or anything from its state. Each tells the host this machine's network address and the time.

No client call was made on that start.

## 2. The catalog

### Where entries come from (source)

- `plugins.catalog.browse {query?, intent?: all|bundled|trending|official|featured, category?, cursor?, pageSize?}` (`operator.read`; `<openclaw>/dist/plugins-BwrCfcpt.mjs` lines 340-390). With no query, category or cursor and `intent: "all"` it asks ClawHub for an overview (items and categories); `bundled` asks ClawHub nothing; anything else asks ClawHub's catalog. Each answer is joined with the gateway's own inventory, `listManagedPlugins`. When ClawHub fails, it still answers `ok`, with only what is on the gateway (for `all`, `bundled` and `official`), the cursor it was given, and `remoteError`.
- Each item (`schema` `PluginDiscoveryEntry`): `id`; `catalog {name, packageName?, summary?, author?, official, categories[], icon?, imageUrl?, latestVersion?, downloads?, installs?, verificationTier?, featured?, trending?, …}`; `local {present, installed, enabled, state: enabled|disabled|needs-setup|not-installed|error, pluginId?, install?, action: install|manage|unavailable}`.
- `plugins.catalog.categories {}` returns `{categories: [{slug, label, description, icon, order, pinnedPackages?}]}`, from ClawHub only (line 392). With no ClawHub it fails.
- `plugins.catalog.get {id, version?}` (lines 394-454): for a ClawHub id, ClawHub's details joined with any local copy, or, when ClawHub fails and the plugin is on the gateway, the local details with `detail.remoteError` "ClawHub details are unavailable: …. Showing installed plugin metadata." and `downloadability: {status: "unknown"}`. The detail (`schema` `PluginsCatalogGetResult`) can carry `readme`, `author`, `verification`, `security`, `configuration [{name, required, sensitive}]`, `mcpServers`, `mcpServerDetails [{name, url?, transport?, auth?: oauth|api-key|none, …}]`, `skills`, `versions`, `compatibility`.
- `plugins.list` (`operator.read`, lines 266-290): every plugin the gateway knows, installed or listed in the official catalog, each with `state`, `enabled`, `installed`, `origin`, `removable`, `categories`, `catalogId` and `runtime {state: unloaded|disabled|active|service-failed, error?}`; and `mutationAllowed`.
- The skills half of "Search across apps and skills" is `skills.search {query?, limit?}` (`operator.read`), which asks ClawHub too.
- `catalog.icon` and `imageUrl` are ClawHub's; the design draws no icon (section 2 of the design), so no icon address is ever used.

### On the instance, behind the fence (tried)

On the read-only device, `catalog` in the probe:

| Call | Answer |
|---|---|
| `plugins.list {}` | `ok`, 70 plugins: bundled ones (`origin: "bundled"`, `removable: false`) in every state, and official ones not installed (`state: "not-installed"`); one diagnostic. One row: `{"id":"github","name":"GitHub","installed":true,"enabled":true,"state":"enabled","removable":false,"categories":["developer-tools"],"origin":"bundled","catalogId":"local_Z2l0aHVi","runtime":{"state":"active"}}`. About 2 s. |
| `plugins.catalog.categories {}` | `UNAVAILABLE`: "Plugin categories are unavailable: fetch failed \| … Proxy response (403) !== 200 when HTTP Tunneling \| UND_ERR_ABORTED. Retry to reconnect to ClawHub." About 15 s. |
| `plugins.catalog.browse {}` | `ok`, 66 items, all on the gateway (`local.present: true`), `remoteError`: "ClawHub is unavailable: … Installed plugins remain available." About 14 s: the log shows four attempts at 0, 1, 4 and 14 s. |
| `browse {intent: "bundled"}` | `ok`, 64 items, no `remoteError`. Under 1 s. |
| `browse {intent: "featured"}` | `ok`, no items, `remoteError` without the last sentence. |
| `browse {intent: "official"}` | `ok`, 66 items, "… Bundled plugins remain available." |
| `browse {query: "notes"}` | `ok`, one local item, `remoteError`. |
| `browse {category: "productivity"}` | `ok`, two local items (Logbook, Workboard), `remoteError`. |
| `plugins.catalog.get {id: "local_Z2l0aHVi"}` | `ok`, from disk: `catalog {name, packageName, summary, official, author, categories, latestVersion}`, `detail {origin: "local", author, readme, repositoryUrl, documentationUrl, contracts, …}`. |
| `plugins.catalog.get {id: <a ClawHub id>}` | the id must match `^[A-Za-z0-9_-]+$`; a ClawHub id for a plugin not on the gateway needs ClawHub. |
| `plugins.inspect {pluginId: "github"}` | `ok`: `plugin`, `source {kind: "bundled"}`, `declared {tools, hooks, mcpServers, skills, …}`, `components`, `grants`, `overview`. |
| `plugins.search`, `skills.search` | `UNAVAILABLE`, the fetch error. |
| `plugins.install` on this device | `FORBIDDEN`, "missing scope: operator.admin". |

What follows for the design: without ClawHub there are no categories, no recommended list, no search beyond the gateway's own plugins, no skills search and nothing to add; what the gateway has stays listed and manageable. A full-catalog call takes about 14 s to say so, the bundled list under a second.

## 3. Adding a connector

**Method and scope (source).** `plugins.install` is `operator.admin` (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 2016-2021), checked again before each persistent step (`plugins-mutations-ClrWTX5-.mjs` lines 20-24). Its parameters (`schema` `PluginsInstallParams`) choose a source: `clawhub {packageName, version?, expectedIntegrity?}`, `official {pluginId}`, `npm`, `git`, `local`, `npm-pack`, `marketplace`, `bundled`. Local paths, archives and marketplaces need a connection from the gateway's own machine (line 73). For the catalog, `local.install` names the source to use (`{source: "clawhub", packageName}` or `{source: "official", pluginId}`).

**What it does on the gateway's machine (source, docs).** Resolve the release, download the package from ClawHub, extract it into the gateway's managed plugin folder, install its npm dependencies (with `--ignore-scripts`, `install-package-dir-D5h3GpAL.mjs` line 80), then load it into the running gateway. The connection that asked receives `plugins.install.progress {activityId, stage: resolve|download|extract|files|dependencies|runtime, status: started|completed|failed, requestId}` (lines 26-29; `schema` `PluginsInstallProgressEvent`). "Control UI actions and the Gateway plugin-management RPCs apply plugin changes without restarting the Gateway" (`<openclaw>/docs/plugins/manage-plugins.md` lines 277-279); the result's `restartRequired` says when a restart is still needed. The plugin's code then runs inside the gateway, with the gateway's access.

**Refusals before anything is written (source).** The gateway can refuse first with `details.capabilityConsentCode: "PLUGIN_CAPABILITY_CONSENT_REQUIRED"` and `{pluginId, reviewToken, widened}` (the tools, hooks, servers and so on the plugin declares), or with an install-policy warning (`installPolicyCode`, findings with `ruleId`, `severity: info|warn|critical`, `message`, `file?`, `line?`). A second call with `acknowledgeCapabilities {reviewToken}` or `acknowledgeInstallPolicyWarning: true` proceeds (`plugins-lifecycle-error-61PGW2_G.mjs` lines 22-50). ClawHub trust errors come with their own code.

**A failure in the middle (source).** The error carries `details.persistence {operation: "install", pluginId}` when the package was written but loading it failed, and `details.runtime` with the generation of any change already applied; its message then ends "An earlier runtime change from this operation was applied in Gateway generation N." (`lifecycle-CvKiePUp.mjs` lines 69-86). So after any failure, what is on the gateway is known only by reading `plugins.list` again.

**On the instance (tried, up to the download).** As admin: `plugins.install {source: "clawhub", packageName: "example-notes"}` answered `UNAVAILABLE` "fetch failed | … Proxy response (403) …" with `details.pluginInstallRejected: true`, after six refused tunnels to `clawhub.ai`; `{source: "official", pluginId: "example-notes"}` answered `INVALID_REQUEST` "unknown official plugin catalog entry: example-notes"; `plugins.list` afterwards had no such plugin. Nothing was downloaded. Everything after the download (consent, dependencies, loading, progress events, `restartRequired`, a failure after the files were written) is **source only**: the only plugins this work may load are this repository's own, through `--with-plugin`, and neither declares a connector.

**A bot adding an app (docs, source).** The gateway has an owner-only `plugins` tool that can list, inspect, search, install (official or ClawHub), enable, disable, uninstall and reload plugins through the running gateway (`<openclaw>/docs/plugins/manage-plugins.md` lines 325-333; `openclaw-tools-DV-z1IAc.mjs` line 1678, with `reviewToken` "Capability review acknowledged by the operator"). The capability map found no tool that adds a raw server; that still holds. The development instance denies `plugins` to every bot, and the scripted model never calls it. **Not tried.**

## 4. Turning off, turning on and removing (tried)

As admin, on the bundled `geolocation` plugin:

- `plugins.setEnabled {pluginId, enabled: false}`: `{ok, restartRequired: false, runtime {operationId, generation: 3, pluginIds}, plugin {…, enabled: false, state: "disabled"}}`; `plugins.list` read back `state: "disabled"`, `runtime.state: "unloaded"`.
- Straight after: `enabled: true` answered `UNAVAILABLE` "Another plugin or config operation is already running; retry when it completes."; the same call a moment later succeeded (`generation: 4`, `state: "enabled"`).
- `plugins.uninstall {pluginId: "geolocation"}`: `INVALID_REQUEST` "bundled plugin cannot be uninstalled: geolocation; disable it instead". `plugins.list` marks such a plugin `removable: false`.
- `plugins.uninstall {pluginId: "example-notes"}`: "Plugin not found: example-notes".
- The read-only device: `plugins.setEnabled` refused, "missing scope: operator.admin".

Removing an installed plugin (**docs**, `<openclaw>/docs/plugins/manage-plugins.md` lines 409-425): uninstall removes the install record, the plugin's settings, its entries in allow and deny lists and its load paths, and its files unless `keepFiles`; it keeps an exact `enabled: false` marker; a Claw that references the plugin may break. The uninstall code does not clear stored MCP sign-ins (`clearMcpOAuth*` is called only from the CLI's `mcp` commands and `/mcp` handlers, `mcp-config-mutation-Dv_-OyHo.mjs` lines 36-59). **Source.**

## 5. A server by address or by command (tried)

`servers` and `discover` in the probe, as admin. The stand-in remote server is an in-process Streamable HTTP server on `127.0.0.1` with one tool, `echo`; the command server is the tool's own stand-in coding agent (`tools/dev-gateway/src/coding-agent-mcp.ts`), run by this Node with the instance's folder as its working directory.

**The fields** (`config.schema.lookup "mcp.servers.*"`): `enabled, command, args, env, cwd, url (format uri), transport: stdio|sse|streamable-http, headers, connectionTimeoutMs, requestTimeoutMs, supportsParallelToolCalls, auth: "oauth", oauth, sslVerify, clientCert, clientKey, toolFilter, codex`; under `oauth` only `identity: shared|per-requester, authProfileId, scope, redirectUrl, clientMetadataUrl`, `additionalProperties: false`, all `reloadKind: "hot"`.

| Write (`config.patch`) | Answer | Read back, and the tool list |
|---|---|---|
| `probe-remote: {url: "http://127.0.0.1:<port>/mcp", transport: "streamable-http", headers: {"X-Example": "example-header-value"}}` | `ok`, `changedPaths: ["mcp.servers.probe-remote"]`, `requiresRestart: false` | `config.get`: `{"url": …, "transport": "streamable-http", "headers": {"X-Example": "__OPENCLAW_REDACTED__"}}`. Before any run, `tools.effective` had a notice `mcp-stale-catalog`: "MCP servers … changed since the current runtime catalog was discovered. MCP tools will appear here after the next agent run discovers them." After Pip's next run the stand-in had received `initialize`, `notifications/initialized`, `GET /mcp` and `tools/list`, each with `x-example: example-header-value`. |
| the same server as `coder` (the only server name whose tools this instance offers bots) | `ok` | After a run: group `{"id": "mcp", "label": "MCP server tools", "source": "mcp"}` with `coder__echo`. |
| `oauth: {clientId, clientSecret}` | `INVALID_REQUEST`: "invalid config: mcp.servers.probe-remote.oauth: Unrecognized keys: \"clientId\", \"clientSecret\"" | nothing written |
| `url: "not an address"` | "… url: Invalid URL; … url: Expected http:// or https:// URL" | nothing written |
| `url: "ftp://127.0.0.1/mcp"` | "… url: Expected http:// or https:// URL" | nothing written |
| `{args: ["x"]}`, `{command: ""}` | `ok` | written; after a run, no tools and no notice for it |
| a closed loopback port | `ok` | after a run: warning `mcp-server-diagnostic:probe-closed`: "MCP server \"probe-closed\": fetch failed \| connect ECONNREFUSED 127.0.0.1:60672 \| ECONNREFUSED; server unavailable; retry after 2026-11-19T13:05:06.558Z. Check server reachability or reload MCP after fixing it." |
| `https://192.0.2.10/mcp` | `ok` | after a run: the same warning with the fence's 403 |
| `{command: "/nonexistent/example-command"}` | `ok` | after a run: "MCP server \"probe-nocmd\": spawn /nonexistent/example-command ENOENT; server unavailable; …" |
| `{command: <this Node>, args: [<stand-in script>], cwd}` | `ok` | read back whole, command and arguments in plain text |
| all of them `null` | `INVALID_REQUEST`: "config.patch would remove entries from array path(s): mcp.servers.probe-cmd.args, …. Pass replacePaths with the exact path(s) when this is intentional, or use config.apply for full-config replacement." | nothing removed |
| the same with `replacePaths` naming each `args` | `ok`, `changedPaths` naming each | `config.get` lists only `coder`; the tool list has nothing of them |

Also tried: with `auth: "oauth"` and no sign-in yet, the tool list's notice was `mcp-not-yet-connected`: "MCP servers … are configured but not connected for this session yet. MCP tools will appear here after an agent run discovers them." `tools.effective` needs a task (`sessionKey`) and answers for that task (`<openclaw>/dist/tools-effective-VKbyCQ9I.mjs` lines 45, 181, 189).

**The revision (source, and a reviewer's probe).** For these paths `config.patch` requires `baseHash`, the `hash` of the last `config.get`: without it the gateway answers "config base hash required for mcp.servers.<name>.…; re-run config.get and retry with baseHash", and with an older one "config changed since last load; re-run config.get and retry" (`<openclaw>/dist/config-Bo7RGaun.mjs` lines 235-247, 689-746). The patch is then merged into the object. The probe here always sent the hash just read (`connectors/probe.ts`, `patch`).

What follows for the design: a save is confirmed by `config.get`; whether a server works is known only after a bot's run, from that task's tool list, and only as of that run. The gateway does not refuse an empty command, so Clawtrate does. It accepts plain `http` anywhere; Clawtrate's own rule can be narrower. There is nowhere to put a client ID or secret: OpenClaw registers itself with the server (dynamic client registration, which the stand-in received as `POST /register`), or uses `clientMetadataUrl`.

**What a command server is (source, docs).** The gateway runs `command` with `args`, `env` and `cwd` on its own machine, as the user it runs as, whenever a run needs the server's tools (`<openclaw>/docs/cli/mcp/transports.md`; the stand-in ran as the instance's own process). OpenClaw drops interpreter-startup and loader variables from `env` (same doc, line 43). Writing one needs `operator.admin`, as every `mcp.servers` write does.

## 6. Where a header, a command and a sign-in are kept (tried)

- **Headers** are written as given into the gateway's configuration file: after the write, `openclaw.json` in the instance's folder contained `example-header-value`; after the server's removal it did not. `config.get` shows the name and `__OPENCLAW_REDACTED__`. No method returns the value to a client. A header can also be a reference (`${ENV}` or a SecretRef) that the gateway resolves; **docs**.
- **A command and its arguments** are written and read back in plain text, as above.
- **A sign-in.** After an approved sign-in (section 7) the state database `state/openclaw.sqlite` had a row in `mcp_oauth_stores` whose `store_json` held the stand-in's access and refresh tokens in plain text, with `clientInformation`, `discoveryState`, `tokensAuthorizationServerUrl` and `tokenExpiresAt`. A refused or cancelled sign-in left a row with the client registration and no tokens. Removing the server with `config.patch` left every row. The store key is the server's name and a hash of its name and address (`mcp-oauth-identity-0fgjEqV6.mjs` lines 4-11), so the same name at the same address finds the old sign-in again. For a per-requester entry `logout` refuses ("Remove or replace the server to clear requester credentials."), and `unset` removes the entry and clears both the shared row and every requester row (`mcp-cli-DZoNoIpy.mjs` lines 684-700; `mcp-oauth-D1MVIya2.mjs` lines 507-518). `openclaw mcp logout <name>` and `openclaw mcp unset <name>` on the gateway's machine clear it (`<openclaw>/docs/cli/mcp/registry.md` line 87; `mcp-config-mutation-Dv_-OyHo.mjs` lines 44-59); no gateway method does.
- This agrees with the drafts research on another branch (`docs/research/drafts-and-vault.md`, section 4 there), which found the gateway's secret store's values in plain text in the same database.

## 7. Sign-in

### `mcp.authLogin` (tried)

`signin` in the probe. `mcp.authLogin {sessionId, serverName}` (`schema` `McpAuthLoginParams`), `operator.admin` (`core-method-policy-DkntKRY_.mjs` line 2935), checked in this order (`<openclaw>/dist/mcp-auth-login-DAnddU_m.mjs` lines 16-107):

| Connection and server | Answer |
|---|---|
| The read-only device | "missing scope: operator.admin" |
| This project's client, admin, a server with `auth: "oauth"` | "Open Settings on this Gateway to sign in, or use openclaw mcp login in its terminal." (no browser origin) |
| The same, the stdio `coder` server, a `per-requester` server, or a name that does not exist | "This connector cannot use operator browser sign-in. Check its existing account settings." |
| A second device, connected as client `webchat-ui` in `webchat` mode with `Origin: http://127.0.0.1:<gateway port>`, approved for `operator.read` and `operator.admin`, against a stand-in that asks for OAuth | `{sessionId, done: false, status: "running"}`, then `wizard.next` gave one step: `{"type":"progress","message":"Complete sign-in in your browser.","executor":"gateway","externalUrl":"https://signin.example/authorize?response_type=code&client_id=example-registered-client&code_challenge=…&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A19740%2Foauth%2Fprovider%2Fcallback&state=…&resource=…"}` |

Before publishing that step the gateway had read the stand-in's protected-resource and authorization-server metadata and registered itself (`POST /register`). The page at `signin.example` was never opened: the probe played the browser by sending the redirect the page would send straight to the gateway's callback on loopback.

| Outcome | The gateway's callback page | `wizard.next` | The stand-in received |
|---|---|---|---|
| Approved (`code` and `state`) | 200, "Provider sign-in. Sign-in response received. Return to OpenClaw for the sign-in result." | `{"done": true, "status": "done"}` | `POST /token` |
| Refused (`error=access_denied`) | 400, "Provider sign-in. Sign-in was not completed. Return to OpenClaw for the sign-in result." | `{"done": true, "status": "error", "error": "Sign-in did not finish. Check the connector settings and try again, or run openclaw mcp login with this connector's name in this Gateway's terminal."}` | no token request |
| Cancelled (`wizard.cancel`) | not reached | `{"status": "cancelled", "error": "cancelled"}` | no token request |

**Source, for the rest:**

- The sign-in page's address must be `https` without credentials ("Provider sign-in requires an HTTPS authorization URL.", `provider-browser-auth-BOjjbaDz.mjs` line 78).
- The return address is the gateway's own `/oauth/provider/callback` on the origin the connection declared: an `https` origin that is the gateway's host, `http` only from a local client on a loopback host, or the gateway's published Tailscale origin (lines 10, 21-31). With none of these the wizard fails with "Browser sign-in needs a secure Gateway address reachable from your browser. …" (lines 13-17).
- The wait is 10 minutes (`timeoutMs: 6e5`, `mcp-auth-login-DAnddU_m.mjs` lines 90, 107); then "Browser sign-in expired. Retry /login." The session belongs to the connection that started it and ends with it (`gateway-capabilities.md`, row 21; `provider-accounts-and-t3-code.md`, A.2 step 5).
- Only a server that is HTTP, `auth: "oauth"`, without `oauth.authProfileId`, and shared (not per-requester) can be signed in this way (`mcp-auth-status-lGLhpwWr.mjs` lines 9-15, 56-62).
- How a sign-in is known to have finished: only the wizard's last answer, on the connection that started it. The web chat connection received no event about it; no other connection was watched.

**What Clawtrate's connection is.** Both apps connect through their host. The web preview starts the same host runtime as the desktop app (`apps/desktop/src/web-host/main.ts`, `startHostRuntime({kind: "web"})`), which creates the same Node client (`apps/desktop/src/host/runtime.ts`); it opens its socket with `new WebSocket(url)` and no `Origin` (`packages/core/src/node/index.ts`) and connects as `gateway-client` in `ui` mode (`packages/core/src/client.ts`). The viewer's browser talks only to the preview host, never to the gateway. So the gateway answers both apps "Open Settings on this Gateway to sign in, or use openclaw mcp login in its terminal." (tried with this project's client). The web chat connection above was a probe of the gateway's rule, not a route for Clawtrate: Clawtrate does not present a connection as a browser to be given a method the gateway withholds from its own kind of connection (`docs/design/connectors.md` §10).

**What the terminal command can find (source).** `openclaw mcp login <name>` looks the name up only in the configuration's own `mcp.servers` (`mcp-cli-DZoNoIpy.mjs` lines 38-49 and 634-640, through `listConfiguredMcpServers`, `mcp-config-DUgS2Rr7.mjs` lines 71-90), while `mcp.authLogin` also resolves the servers enabled plugins declare (`mcp-auth-status-lGLhpwWr.mjs` lines 55-62). For a server only a plugin declares, the command ends with "No MCP server named …"; an entry of the same name in `mcp.servers` with another URL would sign in to a different server. It refuses a per-requester entry ("Senders connect from the channel via the MCP connect flow.") and one without `auth: "oauth"`. When a saved sign-in is already there it prints "MCP OAuth credentials saved" without an address (lines 649-654).

**The gateway's own command line (docs, source).** `openclaw mcp login <name>` prints the address, listens for the return on loopback for 5 minutes (`MCP_OAUTH_CALLBACK_TIMEOUT_MS = 3e5`, `mcp-cli-DZoNoIpy.mjs` line 54) and prints "MCP OAuth credentials saved for \"<name>\"." (line 644); `openclaw mcp login <name> --code <code>` finishes it when the browser is elsewhere. `openclaw mcp status --verbose` shows, on the gateway's machine, whether stored tokens need authorization (`<openclaw>/docs/cli/mcp/registry.md` line 79). **Not tried**: the CLI's login would need a real OAuth page.

### A per-requester server (source)

With `oauth.identity: "per-requester"` (which needs `gateway.publicOrigin`), the gateway gives a bot, for each such server not yet connected for the sender, one tool `<server>__connect` ("Connect your <server> account.", `agent-bundle-mcp-requester-connect-DyJtQr4y.mjs` lines 38-60). When the bot calls it the result is:

- without `gateway.publicOrigin`: text and `details.status: "error"`, "MCP server \"<server>\" needs requester sign-in, but gateway.publicOrigin is not configured. Ask the operator to set the public Gateway HTTP(S) origin." (lines 7-19);
- already connected: "MCP server \"<server>\" is connected. Its tools become available on the next message." (lines 22-27);
- otherwise text "Connect MCP server \"<server>\" at <address>\nAfter sign-in completes, the server's tools become available on the next message." and `details.mcpConnect {serverName, authorizationUrl}` (lines 28-37).

The sign-in returns to `<gateway.publicOrigin>/oauth/mcp/callback`, whose pages read "You're connected. Return to the chat.", "Sign-in wasn't completed. Ask the bot to connect again." or "This sign-in link expired or was already used. Ask the bot to connect again." (`mcp-oauth-callback-CCokV4wv.mjs` lines 13-27). A link is single use, and "any chat participant who opens one connects their own account to the sender the link was issued for" (`<openclaw>/docs/cli/mcp/transports.md` line 134). No method lists the accounts connected this way; nothing tells the client that a sign-in finished. Accounts are told apart by channel, account and sender (`mcp-oauth-identity-0fgjEqV6.mjs` lines 12-19), with no device in the key. For an ordinary `chat.send` from a client that is not the gateway's own operator UI, the sender is the client's protocol id (`gateway-client-identity-E44CR5D-.mjs` lines 63-78, used at `chat-send-handler-D_7lP5Io.mjs` lines 2552-2569), and the runtime picks requester connections by that sender (`agent-bundle-mcp-manager-api-BmCGGpKy.mjs` lines 750-758). Clawtrate connects as `gateway-client` from every device (`packages/core/src/client.ts`, `CLIENT_ID`), so every device of it is one requester. **Source.** **Not tried**: it needs a bot run that calls the connect tool, which the scripted model does not do.

A shared server that is not signed in is left out of a bot's tools rather than failing the run (`<openclaw>/docs/cli/mcp/transports.md` line 97); the bot gets no connect tool for it, so nothing in the conversation asks for its sign-in.

## 8. What the gateway reports about a connector

| Kind | Facts | Of the sign-in | Accounts |
|---|---|---|---|
| A plugin (bundled or installed) | `plugins.list`: `state` (`enabled`, `disabled`, `needs-setup` (off, with required settings missing), `not-installed`, `error`), `runtime.state` (`active`, `unloaded`, `disabled`, `service-failed`) with `runtime.error`, `removable`, `version`, `origin`. **Tried.** | `plugins.inspect {pluginId}` (`operator.read`): for an enabled plugin's declared HTTP OAuth servers, `mcpAuth [{serverName, state: authorized \| requires-authorization \| pending-authorization \| unauthenticated}]`, read from the stored tokens without contacting the server; `authorized` means tokens are stored, with their expiry, not that they still work (`management-service-B1oc-TT4.mjs` lines 506-538; `mcp-oauth-D1MVIya2.mjs` lines 14-21). Also `credentials [{label, status: configured \| missing \| invalid \| unresolved}]` for settings the plugin declares. **Source**: no plugin on the instance declares a server. | One shared sign-in per declared server. No list. |
| A server in `mcp.servers` | `config.get` (redacted); the latest tool list for a task: the server's tools, or `mcp-not-yet-connected`, `mcp-stale-catalog` or `mcp-server-diagnostic:<name>` with the failure. **Tried.** | Nothing. `mcpAuth` covers only a plugin's own servers. `openclaw mcp status` on the gateway's machine is the only place. **Tried** (the method's absence), **docs** (the command). | Nothing. A second shared sign-in at the same address needs a second entry under another name (section 6). |

The capability map said "No per-account list was found there"; that holds. What it did not have is `mcpAuth`, which gives a plugin connector a sign-in state.

## 9. Instances and cleanup

- `d11conn`: started four times (the first before the fence, then with it), probed as above, and reset with `pnpm dev-gateway reset --instance d11conn` when the work was done. Its folder held only the made-up values above.
- The stand-in servers ran inside the probe's own process and ended with it.

## 10. What could not be tried here

| What | Why | Marked |
|---|---|---|
| A real catalog: categories, recommended, search results, a ClawHub plugin's details | It is fetched from ClawHub, which nothing here may reach | source |
| Installing, consent, install-policy warnings, progress, a failure after the files were written | It downloads from ClawHub; the only plugins this work may load are this repository's own, which declare no connector | source |
| `mcpAuth` for a plugin connector | No plugin on the instance declares a server | source |
| A per-requester sign-in from chat | Needs a bot run that calls `<server>__connect`; the scripted model does not | source |
| `openclaw mcp login` | Needs a real OAuth page | docs |
| A sign-in through an SSH forward, or from the web preview's browser on another machine | No second machine; this work runs no SSH server | source |
| A bot's `plugins` tool | Denied to every bot on the instance, and the scripted model does not call it | docs |

## Files

- [`connectors/probe.ts`](connectors/probe.ts): `pair`, `upgrade`, `call`, `catalog`, `plugins`, `servers`, `discover`, `signin` (with `--browser` and `--outcome approve|refuse|cancel`), `refused`, `devices`.
