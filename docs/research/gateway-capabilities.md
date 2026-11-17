# OpenClaw gateway capability map

What a Clawtrate client can do against an OpenClaw gateway, checked against the
schema and source that ship with OpenClaw 2026.10.6 and against a running
isolated gateway. Every method and event name below was checked in the shipped
schema or source. Rows also say whether a live call was made.

How to read the citations:

- `<openclaw>/…` is a path inside the installed `openclaw` npm package (find it
  with `npm root -g`, or follow the `openclaw` wrapper script, which runs
  `<openclaw>/dist/entry.js`). Bundled chunk names carry a build hash
  (`server-methods-list-Cv0-xJIK.mjs`). The hash changes every release. Search by the
  `//#region <source path>` marker at the top of each chunk instead.
- `schema` means `protocol.schema.json` in `@openclaw/gateway-protocol@2026.10.6`.
  Its `methods` map gives each core method's required scope and `since`
  release. Its `definitions` give request and result shapes. The gateway
  itself does not ship this file. It bundles the same TypeBox sources, marked
  `//#region packages/gateway-protocol/src/...`.
- "Live" means the call was made against the probe gateway described in
  section 4, with the pinned client, and the result matched the description.
  "Source" means read from shipped code or docs only.
- Docs paths are `<openclaw>/docs/...`. They match docs.openclaw.ai paths
  without the `.md` suffix.

## 1. Versions

### What is installed

| Item | Value | Where checked |
| --- | --- | --- |
| Gateway | `openclaw` 2026.10.6 | `openclaw --version`, `<openclaw>/package.json`, `hello-ok.server.version` (live) |
| Wire protocol | `PROTOCOL_VERSION = 4`, `MIN_CLIENT_PROTOCOL_VERSION = 4`, `MIN_NODE_PROTOCOL_VERSION = 3`, `MIN_PROBE_PROTOCOL_VERSION = 3` | `<openclaw>/dist/version-CwNT1gaY.mjs` (region `packages/gateway-protocol/src/version.ts`), `hello-ok.protocol = 4` (live) |
| Gateway protocol bundle | `<openclaw>/dist/gateway/protocol/index.js` plus the `packages/gateway-protocol/src/schema/*` regions spread across `dist/*.mjs` | source |
| Event list the gateway advertises | `GATEWAY_EVENTS` in `<openclaw>/dist/server-methods-list-Cv0-xJIK.mjs` (region `src/gateway/server-methods-list.ts`) | source, and identical to `hello-ok.features.events` (live) |
| Model adapter library | `<openclaw>/node_modules/@openclaw/ai` 2026.10.6 | source |

### What to pin

Pin **`@openclaw/gateway-client@2026.10.6`** and
**`@openclaw/gateway-protocol@2026.10.6`**, exact versions, both. The client
package depends on the protocol package at exactly the same version.

```bash
pnpm add --save-exact @openclaw/gateway-client@2026.10.6 @openclaw/gateway-protocol@2026.10.6
```

Browser and Expo hosts import `@openclaw/gateway-client/browser`. That entry
supplies the protocol client and device-auth lifecycle without Node built-ins
or `ws`. The host injects the WebSocket, storage and Ed25519 signing.

How this was verified:

1. `npm view @openclaw/gateway-client versions` lists 2026.10.6, published
   the same day as the gateway build. Current dist-tags are `latest`
   2026.11.4, `extended-stable` 2026.9.37 and `beta` 2026.11.5-beta.4.
2. The 2026.9.37, 2026.10.6 and 2026.11.4 tarballs all export
   `PROTOCOL_VERSION = 4` and `MIN_CLIENT_PROTOCOL_VERSION = 4`. The wire
   number alone therefore does not tell those releases apart.
3. The pinned client connected to the probe gateway with
   `minProtocol: 4, maxProtocol: 4` and received `hello-ok` with
   `protocol: 4` (live).
4. Fields added after 2026.10.6 break against this gateway. Request schemas
   are closed (`additionalProperties: false`), and the gateway enforces that.
   Live calls against 2026.10.6:
   - `sessions.list` with `ifRowsRevision` (added in 2026.11.x) returned
     `INVALID_REQUEST: invalid sessions.list params: at root: unexpected property 'ifRowsRevision'`.
   - `agent` with `createSessionIfMissing` (added in 2026.11.x) returned
     `INVALID_REQUEST ... unexpected property 'createSessionIfMissing'`.

The install guide inside the 2026.10.6 docs
(`<openclaw>/docs/gateway/clients.md`, "Install the packages") still names
2026.8.1 as the "verified stable release". That text is stale. 2026.8.1
predates 2026.9 and 2026.10 methods this client needs, such as
`computer.status`, `sessions.processes.list`, `memory.get` and
`cron.history`. Do not follow it.

### What breaks across versions

Diffing the schema between 2026.10.6 and 2026.11.4: no definitions were
removed, 58 were added and 107 changed. All changes were additive fields or
new methods. Methods added in 2026.11.x include `backup.recordOutcome`,
`debugProxy.capture`, `environments.adoptSuggestedProfile`, `mcp.events.list`,
`memory.search.owner`, `openclaw.setup.auto`, `projects.checkoutOptions`,
`secrets.store.allowedHosts`, `secrets.store.import`, `skills.workshop.undo`,
`ui.command.result` and `users.background.*`. Three methods changed scope:
`projects.searchRemote` and `worktrees.list` rose from `operator.read` to
`operator.write`, and `users.prefs.set` dropped from `operator.write` to
`operator.read`. Consequences:

- A newer client sending a newer optional field to an older gateway is
  rejected outright (shown above). This is the main break.
- An older client calling an older gateway with a newer-only method gets an
  unknown-method error. Use `hello-ok.features.methods` and
  `hello-ok.features.capabilities` for feature detection. The methods list is
  conservative. `push.test`, `sessions.usage`, `sessions.steer` and
  `chat.inject` are among the 23 schema methods that are callable but not
  advertised (live comparison of `hello-ok` with the schema)
  (`<openclaw>/docs/gateway/protocol/rpc-methods.md`).
- `HelloOk` is a closed object in the schema, and 2026.11.4 added
  `controlUiBasePath` to it. Whether the 2026.10.6 client rejects unknown
  `hello-ok` fields from a newer gateway is **unverified**. I could not find
  a schema check of inbound frames in the client bundle, and no newer gateway
  was available to test.
- Client ids and modes are closed enums (see section 2, Connect), so a new
  client identity cannot be introduced without an upstream change.

Policy for Clawtrate: pin client and gateway to the same release, record that
release in `docs/decisions.md`, and move both together.

## 2. Capability table

### Scopes

Every scope below was checked against the gateway's own policy table,
`CORE_GATEWAY_METHOD_POLICY` in `<openclaw>/dist/core-method-policy-DkntKRY_.mjs`.
It classifies all 519 core methods (`listCoreGatewayMethodNames`). Its base scopes match the schema `methods`
map exactly, with no differences. "dynamic" means the gateway decides from the
parameters. Those rules are in `<openclaw>/dist/method-scopes-BdXzw-yD.mjs`
and `<openclaw>/dist/session-method-scopes-base-CuhU2F_D.mjs`, and each row
below gives them.

The closed operator scope set has **ten** scopes (`KNOWN_OPERATOR_SCOPES` in
`<openclaw>/dist/operator-scopes-BO7_XQCg.mjs`): `operator.read`,
`operator.write`, `operator.admin`, `operator.sessions.read`,
`operator.sessions.write`, `operator.approvals`, `operator.questions`,
`operator.pairing`, `operator.talk` and `operator.talk.secrets`.

Implications (`operatorScopeSatisfied` in
`<openclaw>/dist/operator-scope-compat-Ci6GBcmU.mjs`):

- `operator.admin` satisfies every operator scope.
- `operator.write` satisfies `operator.read`, `operator.talk`,
  `operator.sessions.read` and `operator.sessions.write`.
- `operator.read` and `operator.sessions.write` each satisfy
  `operator.sessions.read`.
- `operator.approvals`, `operator.questions`, `operator.pairing` and
  `operator.talk.secrets` are satisfied only by themselves or by admin.

**`operator.sessions.read` and `operator.sessions.write`** are narrower
stand-ins for read and write on session-shaped methods
(`SESSION_READ_METHODS` and `SESSION_WRITE_METHODS` in
`session-method-scopes-base-CuhU2F_D.mjs`; admission in
`authorizeOperatorScopesForRequiredScope`, `method-scopes-BdXzw-yD.mjs`):

- `operator.sessions.read` admits, in place of `operator.read`, exactly these
  37 methods, in source order (`SESSION_READ_METHODS`, lines 4-41):
  `agent.identity.get`, `agents.list`, `canvas.document.preview`,
  `models.list`, `progressCard.get`, `projects.list`,
  `session.suggestions.list`, `session.reactions.list`,
  `sessions.groups.list`, `sessions.processes.list`, `sessions.list`,
  `sessions.subscribe`, `sessions.messages.subscribe`,
  `sessions.messages.unsubscribe`, `sessions.viewers.set`,
  `sessions.preview`, `sessions.describe`, `sessions.branches.list`,
  `sessions.get`, `sessions.github.options`, `sessions.github.status`,
  `sessions.resolve`, `sessions.search`, `sessions.files.list`,
  `sessions.files.get`, `sessions.files.assets`,
  `sessions.setInvolvement`, `chat.history`, `chat.startup`,
  `chat.metadata`, `chat.message.get`, `session.members.list`,
  `session.members.listEvidence`, `themes.get`, `themes.list`,
  `users.prefs.get`, `users.self`.
  `themes.set` and `themes.import` are not in the set; they need
  `operator.write` with no substitute. The session's sharing policy still
  applies.
- `operator.sessions.write` admits, in place of `operator.write`:
  `chat.send`, `chat.abort`, `sessions.create`, `sessions.patch`,
  `sessions.patchMany`, `sessions.fork`, `sessions.recover`,
  `sessions.send`, `sessions.steer`, `sessions.abort`,
  `sessions.processes.stop`, `sessions.goal.update`/`clear`, and
  `question.list`, `question.get`, `question.resolve`, `question.request`
  and `question.waitAnswer` in place of `operator.questions`. This holds
  only where the parameters would not need admin, and "mutation owners must
  bind the caller's own row". In practice it is for the caller's own
  sessions. The session-scope path also needs a verified user profile. A
  paired device holding read and write was refused every `question.*`
  call with "Session-scoped access requires a verified user profile", and
  got no question events. Clawtrate should request `operator.questions`
  (row 19, question cards).
  `sessions.github.publish` requires it directly. A plugin method can accept
  it through `sessionAccess.allowOwnSessionScope`.
- Neither one substitutes for read or write on any method outside these two
  source sets. Two other places name them: `sessions.github.publish`
  requires `operator.sessions.write` directly, and a plugin method may accept
  `operator.sessions.write` through `sessionAccess.allowOwnSessionScope`.
  Clawtrate does not need
  them for its own connection, but a shared or guest device could be paired
  with only these.

**What a connection with `operator.read` alone can do.** This is the
client's first connection, so it matters.

- It can read every bot, session, transcript and live stream:
  `agents.list`, `agent.identity.get`, `agents.files.list`/`get`,
  `agents.workspace.list`/`get`, `sessions.list`/`subscribe`/`describe`,
  `sessions.messages.subscribe`, `chat.history`, `chat.message.get`,
  `chat.metadata` and `artifacts.*`. It receives `chat`, `agent`,
  `session.*` and `sessions.changed` events.
- It can read models and tools (`models.list`, `tools.catalog`,
  `tools.effective`), usage (`usage.status`, `usage.cost`,
  `sessions.usage*`), schedules (`cron.list`, `cron.get`, `cron.status`,
  `cron.runs`, `cron.history`), memory (`memory.status`, `memory.search`,
  `memory.get`), nodes (`node.list`, `node.describe`), `computer.status`,
  `canvas.document.view`/`preview`, `talk.catalog`, `talk.config` without
  secrets, `tts.status`/`providers`/`personas`, `push.web.preferences.get`,
  and `config.get`/`config.schema`/`config.schema.lookup`. Secrets come back
  redacted in `config.get` (live: `__OPENCLAW_REDACTED__`).
- It can call `device.scopes.requestUpgrade` and `device.scopes.waitUpgrade`.
- It cannot send, abort, steer or create (`chat.send`, `chat.abort`,
  `sessions.create` and `sessions.send` need write).
- It cannot see or resolve approvals (`exec.approval.*`,
  `plugin.approval.*`, `approval.*` need `operator.approvals`), list devices
  (`device.pair.list` needs `operator.pairing`), or use talk.
- It cannot get the Web Push key: `push.web.vapidPublicKey` needs write.
  Nor can it touch any `browser.*` method or plugin method registered at
  write.

Live: a read-only device listed sessions and was refused `chat.send` with
`MISSING_SCOPE`/`operator.write`.

Status key: `available` means the gateway supports the flow today.
`partial` means it works with a gap a client cannot close alone. `missing`
means a plugin is needed.

### Summary

| # | Need | Status |
| --- | --- | --- |
| 1 | Connect, challenge signing, pairing, token reuse, scope upgrade, caps | available |
| 2 | List bots, identity, name, avatar, description | available (description is config-only) |
| 3 | Create, edit, delete a bot with all its settings | partial (admin; one bot edit spans three method families and is not atomic) |
| 4 | Sessions per bot, subscriptions, history, stable ids | available |
| 5 | Send, attach, abort, queue, steer | available (steer caveat) |
| 6 | Streaming text, thinking, run lifecycle | available |
| 7 | Tool events and bot-to-bot cards | available |
| 8 | Approvals | available for exec and plugin approvals; partial for per-bot rules on other tools |
| 9 | Schedules | available |
| 10 | Memory read, edit, delete | partial |
| 11 | Files and artifacts | available |
| 12 | Models and effort | available |
| 13 | Nodes and machine choice | available: whole-task device placement at write, exec routing at admin (row 20) |
| 14 | Tool permissions and exec policy per bot | available (admin; one atomic `config.patch`) |
| 15 | Usage, cost, context window | available |
| 16 | Notifications and mobile push | missing for a third-party iOS app |
| 17 | Voice and talk | available (not exercised live) |
| 18 | The bot's computer: browser, canvas, screens | partial |
| 19 | Questions, run behavior, reasoning, tool detail, bot-to-bot states, lists, attachments | available, with the gaps listed in row 19 |
| 20 | Shared conversations, side panel, computer signals, per-bot controls | see row 20; no native multi-bot session was found, a client can compose one |
| 21 | Routines, notifications, skills, connectors, secrets, voice, client as a node | see row 21 |

### 1. Connect, challenge, pairing, device tokens, scope upgrades, caps

- **Frames.** Request `{type:"req", id, method, params}`, response
  `{type:"res", id, ok, payload|error}`, event
  `{type:"event", event, payload, seq?, stateVersion?}`. Errors are
  `{code, message, details?, retryable?, retryAfterMs?}`. A missing scope is
  `code: "FORBIDDEN"` with
  `details: {code:"MISSING_SCOPE", missingScope, requiredScopes}`
  (`schema` `EventFrame`, `RequestFrame`, `ResponseFrame`,
  `MissingScopeErrorDetails`; live: `chat.send` from a read-only device
  returned `MISSING_SCOPE`, `missingScope: "operator.write"`).
- **Challenge.** The server's first frame is event `connect.challenge`,
  payload `{nonce, ts}`. The client replies with method `connect`, using
  `ConnectParams`: `{minProtocol, maxProtocol, client:{id, version, platform,
  mode, displayName?, deviceFamily?, instanceId?...}, role, scopes, caps,
  auth:{token?|deviceToken?|password?|bootstrapToken?}, device:{id,
  publicKey, signature, signedAt, nonce}, locale?, userAgent?}`. Set
  `signedAt` to the challenge `ts`. `device.id` is the hex SHA-256 of the
  raw 32-byte Ed25519 public key. `publicKey` and `signature` are base64url.
  The preferred signature payload is v3, `buildDeviceAuthPayloadV3` in
  `@openclaw/gateway-client` (source:
  `<openclaw>/dist/device-identity-DHDkFiu6.mjs`,
  `deriveDeviceIdFromPublicKey`; `<openclaw>/docs/gateway/protocol/auth.md`).
  Live: a Node host using the client's `deviceIdentity`,
  `hostDeps.signDevicePayload` and `hostDeps.publicKeyRawBase64UrlFromPem`
  connected successfully.
- **Client identity is a closed enum.** `client.id` must be one of
  `webchat-ui`, `openclaw-control-ui`, `openclaw-browser-copilot`,
  `openclaw-tui`, `webchat`, `cli`, `gateway-client`, `openclaw-macos`,
  `openclaw-linux`, `openclaw-ios`, `openclaw-watchos`, `openclaw-android`,
  `node-host`, `openclaw-worker`, `test`, `fingerprint` or `openclaw-probe`.
  `client.mode` must be one of `webchat`, `cli`, `ui`, `backend`, `node`,
  `worker`, `probe` or `test` (`schema` `ConnectParams`;
  `@openclaw/gateway-protocol/dist/client-info.mjs`). The probe used
  `id: "gateway-client"`, `mode: "ui"` and a free-text `displayName` (live).
  The display name is what other surfaces show: device lists, and
  `resolvedBy` on approvals. Avoid the `openclaw-*` app ids. The gateway gives
  native app ids special treatment (`isNativeAppUiClient`).
- **`hello-ok`** carries `protocol`, `server{version, buildId, connId,...}`,
  `features{methods[], events[], capabilities[]}`, `snapshot{presence, health,
  stateVersion, sessionDefaults, ...}`, `auth{role, scopes, deviceToken?,
  issuedAtMs?}`, `policy{maxPayload, maxBufferedBytes, tickIntervalMs,
  attachments{maxBytes, maxImageBytes}}` and `pluginSurfaceUrls{canvas}`
  (`schema` `HelloOk`). Live values: 505 advertised methods (506 with the probe plugin), 65 events and 41 capability flags;
  `maxPayload` 26214400, `tickIntervalMs` 30000,
  `attachments.maxBytes` 19464192, `attachments.maxImageBytes` 6291456.
- **Pairing.** A first connect from loopback with the shared token was
  approved silently (`approvedVia: "silent"`) and returned
  `hello-ok.auth.deviceToken` (live). Remote, LAN and tailnet connects
  create a pending request instead. The connect fails with
  `details.code: "PAIRING_REQUIRED"` and a request id. The owner approves
  with `device.pair.approve {requestId}` (`operator.pairing`) or
  `openclaw devices approve <requestId>`. Only `openclaw-control-ui` and
  `openclaw-tui` sockets are held open to receive `device.pair.resolved`.
  Other clients must reconnect (row 19, rejected or expired pairing; the
  remote path was not exercised live). Related methods:
  `device.pair.list`, `device.pair.reject`, `device.pair.remove`,
  `device.pair.rename`, `device.token.rotate`, `device.token.revoke` (all
  `operator.pairing`). Events: `device.pair.requested`,
  `device.pair.resolved`, `device.pair.changed`.
- **Device token reuse.** Reconnecting with only the stored device token,
  and no shared token, succeeded with `auth.method: "device-token"` and the
  stored scopes (live). Persist `deviceToken` with `auth.scopes`, keyed by
  device id and role.
- **Scope upgrade.** Call `device.scopes.requestUpgrade {scopes}` on the
  live socket (`operator.read`). The requested list must cover the
  connection's current scopes under the implication rules above; it does not
  have to add anything. An equal list is accepted, and `[operator.write]`
  covers a current `[operator.read]`. The handler checks this with
  `roleScopesAllow` (`<openclaw>/dist/devices-mOg4_HQd.mjs` lines 63-70). A
  configured operator role policy also caps the request (lines 54-61). It
  returns `{requestId}`
  and creates a pending pairing request even on loopback. After approval
  through `device.pair.approve`, `device.scopes.waitUpgrade {requestId}`
  resolves to `{status:"approved", requestId, deviceToken, scopes}`, or to
  `rejected` or `expired` (`schema` `ScopeUpgradeRequest`, `ScopeUpgradeWait`,
  `ScopeUpgradeResult`). Live: the request and approval worked. Reconnecting
  afterwards with the old stored token failed with
  `AUTH_DEVICE_TOKEN_MISMATCH`, so approval rotates the token. The client
  must take the new token from `waitUpgrade` on the original socket and
  persist it before reconnecting. `GatewayScopeUpgrade` in
  `@openclaw/gateway-client/scope-upgrade` does this.
- **Client caps.** These are declared in `connect.params.caps`. Registry
  (`GATEWAY_CLIENT_CAPS`, `@openclaw/gateway-protocol/client-info`):
  `agent-kind`, `approvals`, `chat-only-assistant-text`, `exec-approvals`,
  `inline-widgets`, `model-catalog-snapshot`, `model-selection-policy`,
  `run-tool-bindings`, `session-scoped-events`, `plugin-approvals`,
  `task-suggestions`, `terminal-offset-seq`, `terminal-session-metadata`,
  `terminal-upload-path-style`, `tool-events`, `ui-commands`, `ultrafast`,
  `usage-refreshing`. Two of these are mandatory for Clawtrate:
  - Without `tool-events` the connection silently receives no tool
    lifecycle events (`<openclaw>/docs/gateway/clients.md`).
  - Without `approvals` and `exec-approvals`, the gateway did not count the
    connection as an approval route. An exec that needed approval was
    auto-denied with `reason: "no-route"` and the tool error "Headless runs
    cannot wait for interactive exec approval" (live). With the caps, the
    same command produced `exec.approval.requested` and could be resolved.
- **Status: available.**

### 2. List bots and read identity

- `agents.list {}` (`operator.read`) returns `{defaultId, ownership,
  selectionRequired, mainKey, scope, agents:[{id, name,
  identity{name, theme, emoji, avatar?}, workspace, model{primary},
  thinkingLevels, thinkingDefault, agentRuntime, ...}]}` (live).
- `agent.identity.get {agentId?|sessionKey?}` (`operator.read`) returns
  `AgentIdentityResult {agentId, name?, nameSource?, avatar?, avatarSource?,
  avatarStatus?: none|local|remote|data, emoji?}` (live: an emoji-only bot
  returned `avatar: "🧭"`). An avatar is a workspace-relative image path, an
  `http(s)` URL or a `data:` URI. Local files are limited to 2 MB
  (`<openclaw>/docs/gateway/config-agents/entries-and-multi-agent.md`).
- There is no description field in the RPC shapes. Config has
  `agents.entries.<id>.description` and `identity.theme`; `theme` is
  returned by `agents.list`. Whether `agents.list` returns `description` is
  **unverified**: the probe bots had none set.
- Changes arrive through `config.changed`, payload `{path, hash, ts}`
  (`<openclaw>/dist/server-reload-managed-*.mjs`, the `config.changed`
  broadcast). It never carries config content. Refetch afterwards.
- **Status: available.** Description is config-only.

### 3. Create, edit and delete a bot

| Field | How | Scope |
| --- | --- | --- |
| name, emoji, avatar, workspace, model | `agents.create {name, workspace?, model?, emoji?, avatar?}` returns `{ok, agentId, name, workspace}`; `agents.update {agentId, name?, workspace?, model?: string\|null, agentRuntime?, emoji?, avatar?}` | `operator.admin` |
| delete | `agents.delete {agentId, deleteFiles?}` returns `{ok, agentId, removedBindings, removed[], failed[]}`; files go to trash | `operator.admin` |
| instructions / system prompt | workspace bootstrap files: `agents.files.list {agentId}`, `agents.files.get {agentId, name}`, `agents.files.set {agentId, name, content, expectedHash?, expectedMissing?}`. `get` and `set` accept `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md` and `MEMORY.md` (`ALLOWED_FILE_NAMES`). `agents.files.list` omits `IDENTITY.md` on purpose (`CORE_FILE_NAMES`), and omits `BOOTSTRAP.md` after onboarding (`<openclaw>/dist/agents-DAPW-UCQ.mjs` lines 259-267, 383; names in `<openclaw>/dist/workspace-bootstrap-policy-BQw7Lpx1.mjs`). `TOOLS.md` is not accepted | `operator.read` for list and get; `operator.admin` for set |
| reasoning effort default, tools, exec policy, bot-to-bot targets, description | `config.patch {raw, baseHash}` with a merge patch under `agents.entries.<id>` (`thinkingDefault`, `reasoningDefault`, `tools.*` as listed in row 14, `description`, `identity.*`). `baseHash` comes from `config.get().hash`; without it the patch is refused ("config base hash required") | `config.patch`, `config.set` and `config.apply` are `operator.admin`. `config.get`, `config.schema` and `config.schema.lookup` are `operator.read` |

Live: `agents.create`, `agents.update`, `agents.delete`, `agents.files.set`
and `config.patch` all succeeded. A patch setting `tools.deny: ["exec"]` on
one bot removed `exec` from the next model request. A call then failed with
"Tool exec not found". The patch hot-reloaded without a restart. Caveat:
`tools.effective` still listed `exec` for that session afterwards, so do not
treat it as the enforcement source.

Caveats: every write needs `operator.admin`. One bot edit takes several calls
across two families, and there is no single atomic update. Config writes go
through compare-and-swap on `baseHash`.

**Status: partial.** Everything is possible, but only for an admin
connection and not atomically. See plugin P1. The tool-permission part on
its own is one `config.patch` under `agents.entries.<id>.tools`, which is
atomic through `baseHash`. That is why row 14 is "available (admin)" while
this row, which also needs `agents.update` and `agents.files.set`, is
partial. Both rows use the same field list (row 14).

### 4. Sessions (tasks) per bot

- Session keys are `agent:<agentId>:main` for the bot's main thread and
  `agent:<agentId>:dashboard:<uuid>` for sessions made with
  `sessions.create` (live). Always pass `agentId` or an agent-prefixed key.
  Multi-agent gateways reject an unscoped `main` ("Multiple agents are
  configured, but session key "main" has no explicit owner").
- `sessions.list` (`operator.read`, `SessionsListParams`, closed):
  `limit, offset, agentId? (via filters), activeOnly, ownerFirst,
  rowMode:"compact", includeDerivedTitles, includeLastMessage, archived,
  group, label, ...`. It returns `{count, totalCount, limitApplied,
  nextOffset, hasMore, defaults, sessions:[row]}` (live).
- `sessions.subscribe {…list params}` (`operator.read`) returns
  `{subscribed:true, list}`, then a stream of `sessions.changed` events
  carrying `{sessionKey, agentId, sessionId, reason, session:<row>, ...}`
  (live). Install the listener before the call. Events can arrive before
  the response.
- `sessions.messages.subscribe {key, agentId?, subscriptionId?, mode?,
  includeApprovals?}` (`operator.read`) gives per-session live events:
  `session.message` (one committed transcript row, with `messageId`,
  `messageSeq` and `message`), `chat`, `agent`, and `session.approval`
  when `includeApprovals` is set. Pair it with
  `sessions.messages.unsubscribe`. `mode: "narration"` swaps token deltas
  for `session.narration` snapshots, which suits a sidebar.
  **`includeApprovals: true` needs more than read.** For a non-admin
  caller it requires `operator.approvals` and a paired device, otherwise
  the call is rejected: "sessions.messages.subscribe includeApprovals
  requires a paired device and gateway scope: operator.approvals"
  (`<openclaw>/dist/sessions-subscriptions-BO608Xgc.mjs` lines 69-72;
  `canReviewOperatorApproval` in
  `<openclaw>/dist/operator-approval-authorization-C9wV2RU-.mjs`). Admin
  bypasses this check. A read-only first connection must leave the flag
  out.
- History: `chat.history {sessionKey, agentId?, limit?, offset?, cursor?,
  messageId?, sessionId?, maxChars?, toolResultMaxChars?}`
  (`operator.read`) returns `{sessionKey, sessionId, messages[], nextOffset,
  hasMore, inFlightRun?, sessionInfo?}` (live).
  `chat.message.get {sessionKey, messageId}` fetches one row (live).
- **Stable ids.** Every row has `__openclaw.id`, the transcript entry
  identity, and `__openclaw.seq`. One stored record can project into several
  display rows, so key UI rows by `(id, index)`. Use `__openclaw.id` as a
  durable anchor, never numeric offsets (`<openclaw>/docs/gateway/clients.md`,
  "Use history metadata and stable anchors"). `session.message.messageId`
  equals `__openclaw.id` (live).
- Create, rename and archive: `sessions.create {agentId, label?, message?,
  model?, thinkingLevel?, permissionMode?, toolOverrides?, execNode?, cwd?,
  attachments?, ...}` returns `{ok, key, sessionId, entry, runStarted,
  runId?, runError?}` (live). The run starts but has not finished when this
  returns: wait on `runId`, for example with `agent.wait {runId, timeoutMs}`
  (`operator.write`), and check `runError`. Labels must be unique ("label
  already in use", live). Scope is dynamic: `operator.write`, but
  `operator.admin` if `execNode` or `toolOverrides` is present,
  `permissionMode` is `"full"`, or the session is incognito
  (`resolveSessionsCreateRequiredScope`).
- `sessions.patch` is `operator.write` only when every field is one of:
  `label`, `autoLabel`, `icon`, `color`, `category`, `boardFace`,
  `boardPresentation`, `pinned`, `archived`, `snoozedUntil`, `unread`,
  `model`, `agentRuntime`, `thinkingLevel`, `fastMode`, or a
  `permissionMode` other than `"full"`. The only other fields allowed at
  write are `key`, `agentId`, `expectedSessionId`,
  `expectedLifecycleRevision`, `expectedPermissionMode` and
  `expectedMarkedUnreadAt`. Any other field needs `operator.admin`:
  - `reasoningLevel`, `contextWindow`, `toolOverrides`, `execHost`,
    `execNode`, `sandboxMode`, `verboseLevel` and so on;
  - `execSecurity` and `execAsk` are retired: any request containing them,
    even `null`, fails with `INVALID_REQUEST` (live, row 20;
    `<openclaw>/docs/gateway/permission-modes.md`);
  - the guards `expectedToolOverrides`, `expectedSandboxMode` and
    `expectedNativeRuntimeConsent`. Adding one of these to a label-only
    patch makes it admin.

  Source: `SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS`,
  `SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS` and
  `resolveSessionsPatchRequiredScope`,
  `<openclaw>/dist/session-method-scopes-base-CuhU2F_D.mjs` lines 68-110.
- `sessions.delete` is `operator.write` only when `archivedOnly: true` and
  every key is one of `key`, `agentId`, `deleteTranscript`,
  `expectedSessionId` and `archivedOnly`. Anything else is
  `operator.admin`, including the valid guards `expectedLifecycleRevision`,
  `expectedSessionUpdatedAt` and `emitLifecycleHooks`
  (`SESSIONS_DELETE_WRITE_SCOPE_FIELDS` and
  `resolveSessionsDeleteRequiredScope`, same file, lines 94-100 and
  116-118). `sessions.describe {key}` (`operator.read`)
  returns one full row (live).
- **Status: available.**

### 5. Send, attach, abort, queue, steer

- `chat.send` (`operator.write`, `ChatSendParams`, closed): required
  `sessionKey`, `message`, `idempotencyKey`. Optional `agentId`,
  `attachments[]`, `queueMode: steer|followup|collect|interrupt`,
  `thinking`, `fastMode`, `timeoutMs`, `mentions` and `replyToId`. Returns
  `{runId, status:"started", messageSeq?}` (live).
- Attachment item:
  `{type, mimeType, fileName, content (base64), sizeBytes?, width?, height?,
  origin?: paste|file}`, open object (`schema`). Live: a 1×1 PNG with
  `type: "image"` was accepted, and the model turn carried
  `source_modality: "image"`. Limits, where they are enforced and the
  errors are in row 19 (attachments). In short: images 6 MiB and files 20
  MiB decoded, each checked by `chat.send`; the advertised `maxBytes`
  (about 18.56 MiB) is the largest file that fits the 25 MiB frame; an
  oversized frame closes the socket with 1009. There is no chunked upload
  for chat attachments.
- `sessions.send {key, message, agentId?, attachments?, thinking?,
  timeoutMs?, idempotencyKey?}` (`operator.write`) is the session-keyed
  equivalent.
- Abort: `chat.abort {sessionKey, agentId?, runId?, preserveSideRuns?,
  discardPendingInput?}` (`operator.write`) returns
  `{ok, aborted, runIds[]}` (live). `sessions.abort {key?, runId?,
  agentId?, clearQueued?}` (`operator.write`). Aborted runs end with
  `chat state:"aborted"` and `agent stream:"lifecycle" phase:"error"
  aborted:true` (live).
- Steer: `sessions.steer` (`operator.write`; not advertised, and its params
  are not in the published schema) is a **"Deprecated alias for chat.send
  queueMode interrupt"** (policy-table description,
  `<openclaw>/dist/core-method-policy-DkntKRY_.mjs` line 1856). That is why
  it interrupted, live: `{key, message}` returned
  `{runId, status:"started", interruptedActiveRun:true}`. Do not use it;
  use `chat.send` with an explicit `queueMode`. Separately,
  `chat.send` with `queueMode: "steer"` during a streaming text reply
  once aborted the active run. The steer run then failed with
  `chat state:"error"`, `errorMessage: "Session reader operation is no
  longer current"`. A later rerun did not reproduce this: the steer was
  injected into the active run (row 19, run behavior). With a real model, steering is meant to inject at tool
  boundaries (`<openclaw>/docs/concepts/queue-steering.md`). With the
  scripted model it interrupted. **Builders should cover steer with an e2e
  test and not assume in-place injection.**
- **Status: available**, with the steer caveat.

### 6. Streaming

Two projections exist. Pick one per view; consuming both double-counts text.

- `chat` event (`schema` `ChatEvent`, union by `state`):
  - `status`: `{runId, sessionKey, agentId, seq, phase}`. Phases:
    `waiting_for_state`, `preparing_workspace`, `naming_worktree`,
    `creating_worktree`, `running_setup`, `provisioning_environment`,
    `preparing_context`, `memory_flushing`, `starting_model`. There is
    optional `retry{attempt, maxAttempts, reason:"rate_limit"}`.
  - `delta`: `{deltaText, message?, replace?, usage?}`. The first frame per
    recipient carries a full `message` snapshot. `replace: true` means
    `deltaText` replaces the text (live: an empty replace precedes the final).
  - `final`: `{message, usage?, stopReason?}`; `aborted`:
    `{message?, errorMessage?, stopReason?}`; `error`: `{errorMessage,
    errorKind?, errorDetail?}`.
- `agent` event (`schema` `AgentEvent`: `{runId, seq, stream, ts, data,
  spawnedBy?, isHeartbeat?}` plus `sessionKey`, `agentId` and `sessionId`
  on the wire; `data` is untyped in the schema). Streams observed live:
  - `lifecycle`, with `data.phase` one of `start`, `model{provider, model}`,
    `waiting-approval`, `approval-resolved`, `finishing`, `end{stopReason,
    aborted, startedAt, endedAt, terminalReply{disposition, text},
    terminalReceipt}`, `error{error}`.
  - `run_status`: `{phase}`, mirroring the chat status phases.
  - `thinking`: `{text, delta}`. This is the reasoning stream. It is
    cumulative `text` plus the appended `delta`.
  - `assistant`: `{text, delta, itemId}`.
  - `usage`: `{outputTokens}`.
  - `tool`, `item` and `command_output`: see row 7.
  - Also emitted in source, not seen live: `plan`, `approval`,
    `compaction` (shape in row 19), `patch`, `execution`, `error`,
    `stdout`, `stderr`, `acp`
    (`stream: "<name>"` literals across `<openclaw>/dist/*.mjs`).
- Ordering: `payload.seq` is per run, and the outer frame `seq` is per
  connection. On a forward gap, reload history
  (`<openclaw>/docs/gateway/clients.md`).
- Reasoning shows up only when the model reports reasoning and visibility is
  on. The probe model had `reasoning: true`; per session use
  `sessions.patch {reasoningLevel}`, per bot `reasoningDefault` (on, off or
  stream).
- **Status: available.**

### 7. Tool events and bot-to-bot cards

You need `caps: ["tool-events"]` (row 1). For each tool call the connection
receives (live, every tool tried):

```text
agent stream:"item"  data:{itemId:"tool:<toolCallId>", toolCallId, name, kind:"tool",
                           phase:"start", title, status:"running", meta?, commandBearing, startedAt}
agent stream:"tool"  data:{phase:"start", name, toolCallId, args}
agent stream:"tool"  data:{phase:"update", name, toolCallId, partialResult:{content[], details}}   (long-running tools)
agent stream:"item"  data:{..., phase:"update", status:"running"}
agent stream:"command_output" data:{itemId:"command:<toolCallId>", phase:"delta"|"end", output, exitCode?, cwd?}  (exec only)
agent stream:"tool"  data:{phase:"result", name, toolCallId, meta?, isError, result:{content[], details}}
agent stream:"item"  data:{..., phase:"end", status:"completed", endedAt}
```

The `tool` frames on the wire also carry a `session` row snapshot, which can
be large. The transcript keeps the call as an assistant content block
`{type:"toolCall", id, name, arguments}` and the result as a
`{role:"toolResult", toolCallId, toolName, content, details, isError}` row
(live, `chat.history`). That lets a card be rebuilt from history after a
reconnect.

**Bot-to-bot messaging** uses the `sessions_send` tool (source: schema
`SessionsSendToolSchema` and output union `SessionsSendOutputSchema` in
`<openclaw>/dist/sessions-spawn-tool-CMHR26Kp.mjs`). Arguments:
`{sessionKey?, label?, agentId?, message, timeoutSeconds?, watch?, mode?:
notify|steer|followup|resume}`. Results include:

- `{runId, status:"ok", sessionKey, delivery:{status}, reply}`, the waited
  reply;
- `{runId, status:"accepted", sessionKey, targetDisposition:"queued"|"steered", delivery}`;
- `{runId, status:"timeout", error, sentBeforeError:true, sessionKey}`;
- `{runId, status:"no_reply", sessionKey, message}`;
- `{status:"queued", sessionKey, notificationId, durability:"process", runStarted:false}`;
- `{runId, status:"error"|"forbidden", error}`.

Live run (bot Pixel to bot Atlas):

- `tool start`: `{name:"sessions_send", args:{sessionKey:"agent:atlas:main",
  message:"Please list three colours.", timeoutSeconds:60}}`.
- The target run streamed on the same connection with its own
  `runId` and `sessionKey: "agent:atlas:main"`. That `runId` equals the
  result's `details.runId`.
- `tool result`: `result.details = {runId, sessionKey:"agent:atlas:main",
  status:"ok", delivery:{status:"skipped"}, reply:"Echo: Please list three colours."}`.
- The target transcript records the incoming turn as a user message
  wrapped in an inter-session envelope (`[Inter-session message]
  sourceSession=agent:pixel:main ... sourceTool=sessions_send`).

To render a "Messaged <bot>" card, match `data.name === "sessions_send"`.
Take the target from `args.sessionKey` (the `agent:<id>:` prefix), or from
`args.agentId`/`args.label`. The sent text is `args.message`, and the reply
is `result.details.reply`. To expand into the full exchange, open
`result.details.runId` in the target session. Use the events already
received for that `runId`, or reload the target's `chat.history`;
`ChatHistoryParams.inputRunIds` exists in the schema, but filtering by it is
**unverified**. Related
tools with the same tool event shape: `sessions_spawn` (sub-agent),
`agents_wait`, `subagents`, `conversations_send` and `conversations_turn`
(external channel addresses). Allowed targets are controlled per bot by
`agents.entries.<id>.tools.agentToAgent.send` (live: Pixel was allowed
`["atlas"]`).

**Status: available.**

### 8. Approvals

- Listing: `exec.approval.list {}` returns `[{id, request{command, cwd, host,
  nodeId, security, ask, agentId, sessionKey, runId, toolCallId,
  allowedDecisions[], commandAnalysis, resolvedPath}, createdAtMs,
  expiresAtMs, approvalKind:"exec"}]` (live). Also
  `exec.approval.get {id}`, `plugin.approval.list`, `approval.get` and
  `approval.history {}` (live: it returned the resolved exec approval with
  `presentation`, `decision` and `reason`). All use `operator.approvals`.
- Live events: `exec.approval.requested` (payload as one list item),
  `exec.approval.resolved {id, decision, resolvedBy, ts, request}`, and
  `plugin.approval.requested`/`resolved` (live for exec). With
  `includeApprovals` on the session subscription, a sanitized
  `session.approval {sessionKey, phase:"pending"|"terminal",
  approval{id, status, presentation{kind, commandText, host, agentId,
  allowedDecisions}, urlPath, createdAtMs, expiresAtMs, decision?, reason?}}`
  (live) also arrives. The run shows `agent lifecycle phase:"waiting-approval"`
  and then `"approval-resolved"`.
- Resolving: `exec.approval.resolve {id, decision}`, where decision is
  `allow-once`, `allow-always` or `deny`, returns `{ok:true}` (live).
  `plugin.approval.resolve {id, decision}`. Generic
  `approval.resolve {id, kind:"exec"|"plugin"|"system-agent", decision,
  grantExpiresInDays?}`. Standing grants: `exec.approval.grants.list`,
  `exec.approval.grants.revoke`.
- The connection must advertise `approvals` and `exec-approvals` caps, and
  `plugin-approvals` for plugin approvals. Otherwise approvals are
  auto-denied as `no-route` (row 1). Call `exec.approval.list` after
  `hello-ok` to backfill.
- Per-bot policy: `agents.entries.<id>.tools.exec.mode` is one of `deny`,
  `allowlist`, `ask`, `auto` or `full`, set via `config.patch` (admin).
  Each mode stands for a `security` / `ask` pair
  (`<openclaw>/docs/tools/permission-modes.md`):

  | Mode | security / ask | Behavior |
  | --- | --- | --- |
  | `deny` | `deny` / `off` | host exec blocked |
  | `allowlist` | `allowlist` / `off` | allowlisted commands run; misses are silently denied |
  | `ask` | `allowlist` / `on-miss` | allowlisted commands run; misses ask a human |
  | `auto` | `allowlist` / `on-miss` | as `ask`, but a miss first goes to the built-in auto-reviewer. Its `allow` verdict runs one low- or medium-risk command. `deny` returns a reason to the agent. `ask`, a review failure, or three denials in a row go to a human approval |
  | `full` | `full` / `off` | no ordinary prompts |

  - `exec.security` is `deny`, `allowlist` or `full`.
  - `exec.ask` is `off`, `on-miss` or `always`. `always` prompts on every
    command, and an `allow-always` grant does not suppress it
    (`<openclaw>/docs/tools/exec-approvals.md`).
  - A host's own `ask: "always"` in the approvals document wins over
    session or config defaults.
  - `mode` and the legacy `security`/`ask` fields cannot be in the same
    exec object. Config validation rejects the combination
    (`addExecPolicyModeConflictIssue`,
    `<openclaw>/dist/zod-schema.agent-runtime-iDxKMLd-.mjs` lines 403-416).
    To switch an object to a full legacy pair, remove `mode`; otherwise
    replace the object with a mode-only policy. So a merge patch must not
    add `ask:"always"` beside an existing per-bot `mode`.
  - Across layers, a higher layer with legacy fields drops an inherited
    `mode` and overrides only the fields it sets (`applyExecPolicyLayer`,
    `<openclaw>/dist/exec-policy-DDPEdabr.mjs` lines 3-22).
  - Under `auto`, a human sees an ordinary `exec.approval.requested` only
    for the escalated cases. The reviewer's verdicts are shown live in row
    20 (`tool phase:"review"`).
  Live: `mode: "ask"` on one bot turned an unlisted command into an
  approval. The host approvals document is
  `exec.approvals.get` / `exec.approvals.set {file, baseHash}`
  (`operator.admin`). It has `defaults` and a per-agent `agents` map (live
  `get`). Per session, `sessions.patch {permissionMode}` is `operator.write`
  except for `"full"`. `sessions.patch {execSecurity, execAsk}` is retired
  and refused with `INVALID_REQUEST`, even for admin (live, row 20).
- **Important default:** with no exec policy configured, the probe gateway
  resolved `security: "full", ask: "off"`. The scripted model's `exec`
  ran `uname -s` with no approval (live). Policy has to be global, because a
  bot created later inherits only the global value. The section 4 template
  sets `tools.exec.mode: "ask"`. Live: a bot created afterwards by
  `agents.create`, with no override, requested approval for `uname -s` with
  `security: "allowlist", ask: "on-miss"`.
- Approval rules for tools other than exec, for example "ask before Pixel
  messages another bot" or "ask before browser navigation", have no config
  surface. A plugin `before_tool_call` hook can return `requireApproval`
  (source: `<openclaw>/docs/plugins/hooks/tool-policy.md`). See plugin P5.
- Scope summary: every listing, event and resolve path needs
  `operator.approvals`, which `operator.write` does not imply. Policy edits
  need `operator.admin`.
- **Status: available** for exec and plugin approvals; **partial** for
  per-bot rules on other tools.

### 9. Schedules

- `cron.list {agentId?, includeDisabled?, ...}`, `cron.get`, `cron.status`,
  `cron.runs {id, limit?, offset?, statuses?}` and
  `cron.history {id, runId|runAtMs}` are `operator.read`. `cron.add`,
  `cron.update {id, patch}`, `cron.remove {id}` and
  `cron.run {id, mode?: due|force|if-enabled, waitTimeoutMs?}` are
  `operator.admin`. The event is `cron`.
- `CronAddParams` (closed): `{name, agentId?, schedule, sessionTarget:
  "main"|"isolated"|"current"|<key>, wakeMode:"next-heartbeat"|"now",
  payload, delivery?, enabled?, description?, ...}`.
  - `schedule` is one of `{kind:"at", at}`, `{kind:"every", everyMs}`,
    `{kind:"cron", expr, tz?}`, `{kind:"on-exit", command}` or
    `{kind:"stream", command[]}`.
  - `payload` is one of four kinds:
    - `{kind:"agentTurn", message, model?, fallbacks?, thinking?,
      timeoutSeconds?, lightContext?, toolsAllow?}`;
    - `{kind:"systemEvent", text, toolsAllow?}`;
    - `{kind:"command", argv, cwd?, env?, input?, timeoutSeconds?,
      outputMaxBytes?, toolsAllow?}`;
    - `{kind:"script", script, timeoutSeconds?, toolBudget?, toolsAllow?,
      toolsAllowIsDefault?}`.

    Source: `schema` `definitions.CronAddParams.properties.payload`.
- Live: add, list, run with `mode:"force"` (it returned the finished run
  inline: `{ok, enqueued, runId:"manual:<jobId>:<ms>:1",
  run{status:"ok", summary}}`), runs, update and remove all worked.
  `cron.history` requires `runId` or `runAtMs`.
- **Status: available.** Mutations are admin-only.

### 10. Memory

- Search and inspect: `memory.status {agentId}`,
  `memory.search {agentId, query}` and `memory.get` (`operator.read`;
  their params are not in the published schema). Live: `status` returned
  the backend and index state. `search` returned
  `{provider:"none", searchMode:"fts-only", results:[]}` even after a
  matching `MEMORY.md` was written, because the index had not been built.
  The gateway asked for `openclaw memory status --index --agent <id>`.
  `memory.get` requires "a provider-scoped memory reference", which only
  `memory.search {version:2}` returns (row 20, memory); untested.
- With `memory.search.provider: "none"` (the section 4 template),
  `memory.status` reports provider `none` and `memory.search` uses local
  full-text search only. Live: after `MEMORY.md` was written, search for a
  word in it returned that file, with `searchMode: "fts-only"`.
- Edit: memory is Markdown in the bot workspace. `MEMORY.md` is read and
  written through `agents.files.get`/`agents.files.set` (admin for set;
  live). Dated notes under `memory/` are refused by
  `agents.files.set` ("unsupported file"). They can be read through
  `agents.workspace.list {agentId, path?}` and
  `agents.workspace.get {agentId, path}` (live for `MEMORY.md`). Maintenance
  methods: `doctor.memory.status` and `doctor.memory.dreamDiary`
  (`operator.read`), the other `doctor.memory.*` repair methods
  (`operator.write`), and `migrations.memory.plan`/`apply`
  (`operator.admin`).
- Delete: there is no RPC to delete one memory item or file.
- A dated note written straight into `<workspace>/memory/` was **not**
  returned by `memory.search` within 13 s (live). The docs say memory files
  are watched and reindexed with a debounce
  (`<openclaw>/docs/concepts/memory-builtin.md` line 154). Which paths are
  watched, and how fast, is **unverified**.
- **Status: partial.** Read works. Editing through RPC covers only
  `MEMORY.md` and needs admin. There is no delete. See plugin P2.

### 11. Files and artifacts

- Workspace browsing: `agents.workspace.list {agentId, path?, offset?,
  limit?}` returns `{entries:[{path, name, kind, size, updatedAtMs}],
  totalEntries}`. `agents.workspace.get {agentId, path}` returns
  `{file{path, size, mimeType, encoding, content}}`. Both are
  `operator.read` (live).
- Session-scoped files: `sessions.files.list {sessionKey, path?, search?}`
  returns `{root, gitCheckout, files[], browser{entries}}` (live).
  `sessions.files.get {sessionKey, path}` (read). `sessions.files.set` and
  `sessions.files.reveal` (admin). `sessions.files.assets` (read).
  `sessions.diff` (read).
- Artifacts: `artifacts.list {sessionKey, runId?, type?:"image", limit?,
  cursor?}` (live: empty), `artifacts.get {artifactId, ...}`, and
  `artifacts.download {artifactId, sessionKey, transport?:"http"}`.
  Without `transport`, base64 data comes back over the socket. With
  `transport:"http"`, you get a five-minute, connection-bound URL under
  `/api/artifacts/download/`; add `?variant=thumbnail` for a PNG preview of
  at most 1200 px (`<openclaw>/docs/gateway/clients.md`). Images in the
  transcript are `{type:"image", artifactId, url, mimeType, ...}` blocks.
  `assistant.media.get` is also callable.
- **Status: available.** Only download over HTTP was not exercised live.

### 12. Models and effort

- `models.list {agentId?, sessionKey?, view?: default|configured|provider-config|all, includeDetails?}`
  (`operator.read`) returns `{models:[{id, name, provider, contextWindow,
  reasoning, thinkingLevels[{id,label}], thinkingDefault, available}]}`
  (live). `chat.metadata {agentId?, sessionKey?, includeModels?}` returns
  the models plus the slash-command list (live). Events: `models.snapshot`
  and `chat.metadata.changed`.
- Per session: `sessions.patch {key, model, thinkingLevel, fastMode}` is
  `operator.write` (live with `model:"fake/scripted", thinkingLevel:"high"`).
  `reasoningLevel` and `contextWindow` make the same call `operator.admin`
  (row 4). Model refs are
  `provider/modelId`. The thinking levels a model offers come from its
  entry (live: off, minimal, low, medium, high, ultra).
- Per bot: `agents.update {model}` (admin), plus `thinkingDefault`,
  `reasoningDefault` and `fastModeDefault` through `config.patch` (admin,
  live for `thinkingDefault`). `chat.send {thinking}` is a per-message
  override.
- **Status: available.**

### 13. Nodes and machine choice

- `node.list {}` and `node.describe {nodeId}` (`operator.read`; live: an
  empty list, since no node was paired). Pairing: `node.pair.list`,
  `node.pair.approve`, `node.pair.reject`, `node.pair.remove` and
  `node.rename` (`operator.pairing`). `node.pair.approve` adds a check based
  on the commands the node declares (`resolveNodePairApprovalScopes`,
  `<openclaw>/dist/node-pairing-authz-_-5BGyuw.mjs` lines 4-12):
  - no commands: `operator.pairing`;
  - any commands: `operator.pairing` plus `operator.write`;
  - any of `system.run.prepare`, `system.run`, `system.which`,
    `system.execApprovals.get`, `system.execApprovals.set`,
    `browser.proxy`, `browser.proxy.upload.v1`, `fs.listDir` or
    `terminal.upload`: `operator.pairing` plus `operator.admin`.
  - This is not at odds with `node.invoke` being `operator.write`.
    `node.invoke` refuses `system.execApprovals.get`/`set` outright with
    `INVALID_REQUEST` "node.invoke does not allow system.execApprovals.*;
    use exec.approvals.node.*"
    (`<openclaw>/dist/nodes-BW91tb1K.mjs` lines 697-699). The replacements
    `exec.approvals.node.get`/`set` are `operator.admin`
    (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 236-246).
  - `system.run` through `node.invoke` at write cannot carry approval
    flags (`approved`, `approvalDecision`) without a real `exec.approval.*`
    record (`sanitizeSystemRunParamsForForwarding`, same file).
  - So approval policy on a node is admin-only either way. Invoke with
  `node.invoke {nodeId, command, params?, idempotencyKey}` (dynamic:
  `operator.write`, or `operator.admin` for the admin-only node commands,
  which are the browser proxy commands, `fs.listDir` and terminal upload
  (`NODE_ADMIN_ONLY_INVOKE_COMMANDS` in
  `<openclaw>/dist/node-commands-Bxo-2Y4j.mjs`; dispatch in
  `method-scopes-BdXzw-yD.mjs`).
  Events: `node.pair.requested`, `node.pair.resolved`, `node.presence`,
  `node.hostStats`, `node.runnerInventory.changed` and
  `node.invoke.request`.
- Choosing where a bot's tools run:
  - a whole task, on a paired session-host device: `sessions.dispatch
    {key, deviceId}` or `{key, autoDevice:true}`, and `sessions.move` to a
    device, at **`operator.write`**, under the runtime and device
    conditions in row 20 (machine choice);
  - exec routing only, per session: `sessions.patch {execHost, execNode}`
    and `sessions.create {execNode}` (`schema`). Both need
    **`operator.admin`** (row 4);
  - per bot, `agents.entries.<id>.tools.exec.{host, node}` in config;
  - per browser call, `browser.request {target:"node", node:"<id>"}`.
- **Status: available.** Device placement is write-scoped; exec routing and
  per-bot defaults are admin. Live with a headless node
  (`openclaw --profile <dev> node run`): pairing, `node.list` fields,
  `node.hostStats`, and an exec routed to the node by `sessions.patch
  {execHost, execNode}` (row 20, machine choice).

### 14. Tool permissions and exec policy per bot

- Reading: `tools.catalog {agentId?, includePlugins?}` returns profiles
  (minimal, coding, messaging, full) and tool groups with
  `defaultProfiles`. `tools.effective {sessionKey}` returns the session's
  groups and tools (both `operator.read`, live).
- Writing per bot: `config.patch` under
  `agents.entries.<id>.tools.{profile, allow, alsoAllow, deny, exec.mode,
  exec.ask, exec.security, exec.host, exec.node, agentToAgent.send, fs,
  elevated}` (admin; live for `deny` and `exec.mode`).
- Per session: `sessions.patch {permissionMode: read-only|guarded|workspace}`
  and `sessions.create {permissionMode}` are `operator.write` (live with
  `permissionMode:"guarded"`).
  - `permissionMode: "full"` and `toolOverrides` need `operator.admin` on
    both methods.
  - `execHost` exists only on `sessions.patch`, where it needs
    `operator.admin`. `execSecurity` and `execAsk` are still in the schema
    but retired: requests with them fail `INVALID_REQUEST` (live, row 20).
- Host approvals: `exec.approvals.get`/`set` (admin).
- `exec.mode` values and the `exec.ask` and `exec.security` values they stand
  for are in row 8.
- **Status: available** for admin connections.
  - The per-bot part (`agents.entries.<id>.tools`) is a single
    `config.patch`, so it is atomic, unlike row 3.
  - Session overrides (`sessions.patch`, `sessions.create`) and the host
    approvals document (`exec.approvals.set`) are separate calls with their
    own guards. They are not part of that transaction.

### 15. Usage, cost and context

- `usage.status {}` (`operator.read`) returns provider quota windows (live:
  `{providers:[]}` with the fake provider). Advertise `usage-refreshing` to
  get a fast cold response.
- `usage.cost {agentId}` (`operator.read`) returns
  `{days, daily:[{date, input, output, cacheRead, cacheWrite, totalTokens,
  totalCost, ...}]}`. `agentId` is required on multi-agent gateways (live).
- `sessions.usage {key?, agentId?, range?, startDate?, endDate?}`,
  `sessions.usage.timeseries` and `sessions.usage.logs` give per-session
  token and cost history (live for `sessions.usage`).
- Context window: rows from `sessions.describe`, `chat.history.sessionInfo`
  and `sessions.changed` carry `contextTokens`, `inputTokens`,
  `outputTokens`, `totalTokens` and `contextBudgetStatus{contextTokenBudget,
  estimatedPromptTokens, remainingPromptBudgetTokens, reserveTokens,
  shouldCompact, route}` (live). The live `agent` stream also has `usage`
  frames.
- Do not poll usage for live lists. Rows on `sessions.changed` carry it
  (`<openclaw>/docs/gateway/clients.md`).
- **Status: available.**

### 16. Notifications and mobile push

- Web Push for browsers and PWAs: `push.web.vapidPublicKey` (live: it
  returned a key), `push.web.subscribe`, `push.web.unsubscribe`,
  `push.web.test` and `push.web.preferences.set` are `operator.write`;
  `push.web.preferences.get {endpoint}` is `operator.read`. Payloads are generic, and a tap opens the
  gateway's `/approve/<id>` page (`<openclaw>/docs/web/notifications.md`).
- iOS: only the official OpenClaw iOS app gets APNs. It registers with a
  hosted relay using App Attest and a StoreKit receipt, then sends the relay
  handle to the gateway as a **node-role** `node.event` with
  `event: "push.apns.register"` (source:
  `<openclaw>/dist/server-node-events-D7AhsYlE.mjs`;
  `<openclaw>/docs/platforms/ios.md`). `push.test` sends to such a node. The
  only knob is `gateway.push.apns.relay.baseUrl` for a custom relay that
  matches a custom build. A third-party app cannot pass the hosted relay's
  attestation.
- Expo push tokens have no RPC.
- **Status: missing** for a Clawtrate iOS app. See plugin P3. Desktop can
  use OS notifications driven by the events it already receives.

### 17. Voice and talk (brief)

- Talk methods need `operator.talk`, which `operator.write` also satisfies:
  `talk.mode {enabled, phase?}`, `talk.speak`, the gateway-relayed realtime
  audio methods `talk.session.create`, `appendAudio`, `cancelOutput`,
  `acknowledgeMark`, `submitToolResult`, `steer` and `close`, the
  client-owned realtime methods `talk.client.create`, `transcript`,
  `toolCall`, `steer` and `close`, and `talk.voice.get`/`set`/`complete`.
- `talk.catalog` is `operator.read`. `talk.config` is dynamic: `operator.read`,
  but with `includeSecrets: true` it needs both `operator.read` **and**
  `operator.talk.secrets`; admin satisfies both (`method-scopes-BdXzw-yD.mjs`,
  the `talk.config` branch).
- TTS is not covered by `operator.talk`. `tts.status`, `tts.providers` and
  `tts.personas` are `operator.read`. `tts.enable`, `tts.disable`,
  `tts.convert`, `tts.setProvider`, `tts.setPersona` and `tts.speak` are
  `operator.write` (policy table).
- Events: `talk.event`, `talk.mode` and `talk.voice.change`.
- `talk.agentId` is only the owner of Talk sessions created **without** an
  agent-scoped session key (config help text in
  `<openclaw>/dist/schema-CZzk-3S5.mjs` line 562;
  `<openclaw>/dist/session-sharing-D-SULyec.mjs` line 181).
  - To choose a bot per call, pass that bot's session key:
    `talk.session.create {sessionKey}` and `talk.client.create
    {sessionKey}`. Both schemas accept `sessionKey`, and neither accepts
    `agentId`.
  - Live, multi-agent, no `talk.agentId`: with no key, `talk.session.create`
    failed "Multiple agents are configured, but Talk session ownership has
    no explicit owner". With Pixel's key, both calls passed agent selection
    and stopped at the next check, "Realtime voice provider "openai" is
    not configured".
  - `talk.catalog {provider?, model?}` takes no key. On a multi-agent
    gateway it still needs `talk.agentId` (live:
    `AGENT_SELECTION_REQUIRED`).
- **Status: available** by schema. Not exercised beyond that error.

### 18. The bot's computer

> **Status of the computer-view work.** Plugin P4 below is a **research
> prototype**. It demonstrates that the view and takeover are feasible for
> an ordinary plugin. It has **not** passed a security review for shipping
> and must not be installed outside a development gateway. Builders write
> the shipped plugin from "Requirements for the shipped plugin" in
> section 3.

**Dedicated browser: live view and input are built in.** The bundled
`browser` plugin registers:

- `browser.request` with scope **`operator.admin`**
  (`BROWSER_REQUEST_GATEWAY_SCOPE` in
  `<openclaw>/dist/browser-gateway-contract-WuzRejvY.mjs`; registered in
  `<openclaw>/dist/plugin-registration-6Nzv0VmS.mjs`). It proxies the
  browser control routes: `{method, path, query?, body?, target?, node?}`.
- `browser.dashboard.request` with scope `operator.write`, session access
  and `requiredTool: "browser"` (same file). It drives a `browser:dashboard`
  widget for non-admin users.
- An upgrade route, `/browser/screencast`.

Route list: `<openclaw>/dist/routes-DV0YryHA.mjs`;
`<openclaw>/docs/tools/browser-control.md`.

Live sequence, using a headless managed Chromium:

1. `browser.request {method:"POST", path:"/start"}` returns
   `{ok, profile:"openclaw"}`. `GET /` reports `cdpPort` and `transport:"cdp"`.
2. `POST /tabs/open {url}` returns `{targetId, suggestedTargetId:"t1", title,
   url}`. `GET /tabs` lists tabs.
3. `POST /screencast {targetId?, maxWidth?, maxHeight?, quality?}` returns
   `{token, wsPath:"/browser/screencast?token=<48 hex>", expiresAtMs,
   targetId, url}`. The token is single use, lives 60 s and is bound to the
   requesting gateway connection.
4. Open a WebSocket to the gateway origin plus `wsPath`. Text frames are
   JSON, `{type:"ready", targetId, url, title}`, `meta` or `error`. Binary
   frames are a 4-byte big-endian header length, then a JSON header
   `{url, cssWidth, cssHeight, scrollX, scrollY, ts}`, then JPEG bytes.
   Live: 21 frames in about 5 s at 756×469, the first written out as a
   valid JPEG. Close codes: 4001 token, 4003 `navigation_blocked`, 4004
   `target_closed`, 4005 unsupported, 4006 `authority_revoked`, 1012
   shutdown.
5. Input goes through `POST /act {kind, ...}`. Kinds are `batch`, `click`,
   `clickCoords {x, y, button?, doubleClick?}`, `type`, `press {key}`,
   `hover`, `scrollIntoView`, `drag`, `select`, `fill`, `resize`, `wait`,
   `evaluate` and `close`; `insertText` is used for paste (live: `press`
   worked; `clickCoords` checked in source,
   `<openclaw>/dist/extensions/browser/runtime-api.d.ts`). There is no
   wheel kind. The Control UI scrolls with `evaluate`, which needs
   `browser.evaluateEnabled`, on by default. Also available:
   `GET /snapshot` (aria tree, live), `POST /screenshot`, `POST /navigate`,
   tab focus and close.

Caveats of the built-in route:

- `operator.admin` is required for the free-form browser. A non-admin
  connection is refused with `MISSING_SCOPE`/`operator.admin` (live, from a
  read and write device). It can use only `browser.dashboard.request`
  against a `browser:dashboard` widget in its own session.
- There is **no takeover arbitration** for the gateway browser. Agent and
  user input interleave. The takeover pause the docs describe exists only
  for cloud-worker desktops (`<openclaw>/docs/nodes/computer-use.md`).
- Headful launch is the default. Development gateways should set
  `browser.headless: true`.
- Screencast is unsupported for Chrome MCP existing-session profiles and for
  node-routed browsers (HTTP 501 or `SCREENCAST_UNSUPPORTED`). The Control
  UI falls back to `POST /screenshot` polling.
- Built-in screencast sessions are keyed by `${profileName}:${targetId}`
  (`<openclaw>/dist/session-Dy6QNgnj.mjs` line 256). The resource is a tab
  in a browser profile, not a chat session. By default the managed
  `openclaw` profile is shared by every session and every bot that uses the
  browser tool. Plugin P4 gives each bot its own profile.

**Canvas.** `hello-ok.pluginSurfaceUrls.canvas` is a scoped hosted URL
(live: present). Renew it with `plugin.surface.refresh`
(`operator.read`). Agents' canvas documents are fetched with
`canvas.document.view {docId}` and `canvas.document.preview`
(`operator.read`; live: an unknown id returned `UNAVAILABLE`). A client can
embed the hosted canvas URL in a web view.

**Node and desktop screens.**

- `computer.status {probe?}` (`operator.read`; live:
  `{configured:false, available:false}`).
- `computer.invoke {command:"screen.snapshot"|"computer.act", params,
  generation, idempotencyKey}` (`operator.write`) drives the gateway's or a
  node's computer-use provider. A paired node also exposes
  `screen.snapshot` and `screen.record` through `node.invoke`. These are
  still images and recordings, not a stream.
- Cloud-worker desktops have `desktop.observe` and `desktop.launch`
  (admin), with the takeover semantics above. **Unverified live.**

**Answer to the milestone question: (a) is true, demonstrated again with the
fixed prototype on the probe gateway.** An ordinary plugin, loaded into one
profile, gave a client holding only `operator.read` and `operator.write` a
live view of the bot's browser and control of a tab. The client never had
`operator.admin`. The prototype is `docs/research/dev-gateway/computer-plugin/`
(no dependencies, offline tests in `test.mjs`). The design and its exact
limits are in section 3, plugin P4.

**Isolation model: one browser per bot.** Each configured bot gets its own
managed browser profile (`browser.profiles.bot-atlas`, `bot-pixel`, each with
its own debugging port).
- The plugin's `before_tool_call` hook rewrites every `browser` call from
  that bot to use the bot's profile on the host browser (`target: "host"`).
- The hook handles both kinds of caller:
  - Configured bots may use only tab actions. Node, sandbox, dashboard and
    import routing are refused for them.
  - Other agents are refused any bot profile, whether named in `profile`
    or `into` (with the browser tool's trimming) or reached by default.
- A session may view or control exactly the tabs in its own bot's browser,
  as listed live by that browser's CDP endpoint. Nothing is inferred from
  tool results.
- All sessions of the same bot share that bot's browser and its view.
- Tabs an operator opens in the bot's profile through `browser.request` are
  part of that browser and are viewable by the bot's sessions.

Live result on a fresh profile, under a temporary `HOME` started by
`dev-gateway.sh`. Two non-admin viewer devices, A and B: each had
`hello-ok.auth.scopes` `["operator.read","operator.write"]`, and
`browser.request` was refused with `MISSING_SCOPE`.

1. **Pinning is host-authoritative.**
   - Atlas ran `browser open https://example.com`, then
     `browser open https://example.org` with `profile: "bot-pixel"` in the
     call. Pixel ran `browser open https://example.net`.
   - The browser tool's own results reported `browserTab.profile` as
     `bot-atlas`, `bot-atlas` and `bot-pixel`. Atlas's browser (port 19113)
     held example.com and example.org; Pixel's (port 19114) held
     example.net. The shared `openclaw` profile was never started.
   - Atlas's call with `target: "node"` was blocked by the hook.
2. **Operator tabs.** An admin `browser.request POST /tabs/open` with
   `query.profile: "bot-atlas"` opened a tab, and it appeared in
   `clawtrate-computer.tabs` for Atlas's session.
3. **Cross-bot refusal.** `view.open` on Atlas's tab from Pixel's session
   was refused: "tab is not in this bot's browser".
4. **Frames.** A one-use ticket from `view.open` opened
   `/clawtrate-computer/stream`. Frames used the built-in binary layout and
   header, `{url, cssWidth, cssHeight, scrollX, scrollY, ts}`. The first
   was a valid 756×469 JPEG; 24 frames arrived over the run.
5. **Takeover during a short call.** A 4 s bot browser call was running.
   `control.take` emitted the `draining` event and blocked new bot calls.
   It responded once, `{state:"granted", generation}`, 3.9 s later, after
   the call finished.
6. **Bot blocked.** While the user held control, the bot's next `browser`
   call returned the tool error "The user has control of this bot's
   browser".
7. **Lease holder.** Viewer B's `control.release` was refused, both without
   a generation and with A's generation copied: "only the current holder
   can release, with its generation". B's `control.take` was refused:
   "already held".
8. **Input.** `input` with `scroll` and `click`, carrying A's generation,
   worked. 22 new frames followed, and `scrollY` moved from 0 to 243.
9. **Release.** After `control.release` by A, the bot's next `browser` call
   succeeded.
10. **Fail closed.** A 25 s bot call was running when the user tried to take
    control. The take responded `{state:"busy", reason:"the bot is still
    acting in this browser", runningCalls:1}` after the 15 s drain budget,
    and left no lease. After the call finished, a retry was granted.
11. **Disconnect.** The holder dropped its gateway connection without
    releasing. The stream closed with `4006 authority_revoked` 17.6 s
    later, once renewals stopped. Viewer B saw the lease as `null` 22.6 s
    after the disconnect.

What the user must approve, compared with the built-in route:

- **With the plugin:** the client pairs as `operator.read` plus
  `operator.write`. The gateway owner configures one browser profile per
  bot and the plugin's `bots` map. No admin grant goes to the device.
- **Without the plugin:** the client must request `operator.admin`. On
  first pairing, include it in `connect.params.scopes`; later, use
  `device.scopes.requestUpgrade` with the current scopes plus
  `operator.admin`. The owner approves the pending request with
  `device.pair.approve` or `openclaw devices approve <requestId>`. The
  client then calls `browser.request {method:"POST", path:"/screencast"}`.
  That grant also covers config writes, agent edits and every other admin
  method.

**Status: partial** in the gateway. **Available with plugin P4**, for bots
configured with their own browser profile, within the limits under P4.

### 19. Conversation and shell details

This section fills in what the client needs to draw a conversation and its
sidebar. Each finding is marked:

- **live**: shown on the probe gateway with the scripted model;
- **source**: read from shipped code or docs;
- **unverified**: not settled, with what was tried.

The probe scenarios are `docs/research/dev-gateway/scenarios/*.mjs`. They run
against a launcher-started profile, through `probe-lib.mjs`, which refuses
any other target (see the scenarios README).

Question findings marked live were reproduced by committed scenarios:
- multiple choice with free text, two questions in one card, dismissal and
  plain-text answers: `questions.mjs` and `questions-plain-text.mjs`;
- expiry, abort while asking, and the read+write device's refused calls
  and missing events: `questions-expiry-abort-scope.mjs`.

The single-choice answer was seen in an earlier, uncommitted probe; its
shape is the same as the multiple-choice one.

#### Which events reach a connection

Events are filtered per connection by `EVENT_SCOPE_GUARDS`
(`<openclaw>/dist/server-start-D6vaUNGz.mjs` lines 4268-4330, region
`src/gateway/server-broadcast-scopes.ts`). Filtering is deny-by-default:
`hasEventScope` (same file, lines 4370-4378) drops any core event missing
from the table. The only exception is plugin events:
- an event broadcast with an explicit plugin scope needs that scope;
- an unlisted `plugin.*` event needs `operator.write`.

Do not expect an unlisted core event to reach clients. `session-read` means
`operator.read`, or `operator.sessions.read` for the caller's own
sessions.

| Scope needed | Events |
| --- | --- |
| none | `health`, `heartbeat`, `tick`, `shutdown`, `gateway.suspension`, `update.available` |
| session-read | `agent`, `chat`, `chat.metadata.changed`, `chat.side_result`, `progressCard.changed`, `sessions.changed`, `session.message`, `session.narration`, `session.observer`, `users.prefs.changed` |
| `operator.read` | `cron`, `presence`, `task`, `task.suggestion`, `talk.event`, `config.changed`, `mentions.changed`, `skills.changed`, `plugins.changed`, `node.presence`, `node.hostStats`, `session.operation`, `session.sharing`, `board.changed`, `ui.command`, `chat.send_timing`, `voicewake.changed` and others |
| `operator.approvals` | `exec.approval.requested`/`resolved`, `plugin.approval.requested`/`resolved`, `openclaw.approval.requested`/`resolved`, `session.approval` |
| `operator.questions` | `question.requested`, `question.resolved` |
| `operator.pairing` | `device.pair.requested`, `device.pair.resolved`, `device.pair.changed`, `device.pair.setup.*`, `node.pair.requested`, `node.pair.resolved` |
| `operator.talk` | `talk.mode`, `talk.voice.change` |
| `operator.admin` | `plugins.install.progress`, the update-run event |

Two narrower rules apply on top of the table:

- Question events can reach a connection without `operator.questions`
  only when the broker names it as the recipient (`questionRecipient`, same
  file lines 4514-4532). That needs session-write access and the current
  own-run recipient binding. It is not an exemption for every read/write
  subscriber.
- The `session-scoped-events` cap limits exactly six events to sessions
  subscribed with `sessions.messages.subscribe` (`SESSION_SUBSCRIPTION_EVENTS`,
  same file lines 4382-4390): `agent`, `chat`, `chat.side_result`,
  `session.observer`, `session.narration` and `session.tool`.
  - Question events follow their own recipient rules.
  - `sessions.changed`, `users.prefs.changed` and other session-related
    events follow their own publication paths.
  - Unsubscribing from a session's messages does not stop every event that
    mentions it.

Live: a read+write device did not receive `question.requested` at all.

#### Question cards (`ask_user`)

A bot asks with the `ask_user` tool. The tool is in the `coding` profile.
Its arguments are:

```text
{questions:[{id, header, question, options:[{label, description?}], multiSelect?}],
 timeoutSeconds?}
```

Limits (source: `AskUserToolSchema` in
`<openclaw>/dist/ask-user-tool-normalization-CAWKFwDq.mjs` lines 8-74):

- 1-3 questions, each with 2-4 options;
- `id` is snake_case;
- `header` is cut to 12 characters;
- option labels are up to 64 characters;
- the timeout defaults to 900 s and is clamped to 30-3600 s.

The tool adds `isOther: true` to every question, so free text is always
allowed.

- **Event** `question.requested`, payload `QuestionRecord` (live):

  ```text
  {id:"ask_<hash>", questions:[{questionId, header, question,
   options:[{label, description?}], multiSelect?, isOther:true}],
   agentId, sessionKey, runId, createdAtMs, expiresAtMs, status:"pending"}
  ```

  `QuestionRecord` also allows the following per question: `url`,
  `presentation:"form"`, `resource`, `answerFormat:"lines"`, `allowEmpty`,
  `defaultAnswers`, `isSecret` and `secretStore`. `ask_user` does not set
  them (`schema` `Question`).
- **Event** `question.resolved` is `{id, status, answers?}`.
  - `status` is `answered`, `cancelled` or `expired` (live: all three).
  - `answers` is `{answers:{<questionId>:[string…]}}`.
- **Methods** (all `operator.questions`, policy table in
  `<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 288-320):
  - `question.list {}` returns `{questions:[record]}`;
  - `question.get {id}` returns `{question}`;
  - `question.resolve` is either `{id, answers, resolvedBy?, resolutionId?,
    secretStoreAllowedHosts?}` or `{id, cancel, resolvedBy?}`
    (`QuestionResolveParams`);
  - `question.request` and `question.waitAnswer`. The agent runtime uses
    these two; a client does not need them.
- **Answering** (live):
  - Single choice: `{answers:{color:["Blue"]}}`.
  - Multiple choice with free text: `{answers:{langs:["TypeScript",
    "Kotlin (typed in)"]}}`. A typed answer is just another string.
  - Two questions in one card are answered in one call.
  - The tool result is `details:{status:"answered", answers}`, and the run
    continues.
- **Dismiss** (live): cancelling through `question.resolve` emits
  `question.resolved {status:"cancelled"}`. The tool returns
  `{status:"no_answer"}` with the text "The question was cancelled; proceed
  with best judgment." The run finishes normally.
- **No answer** (live, with a 30 s timeout): `question.resolved
  {status:"expired"}`. The tool returns `no_answer`, with the text "No answer
  arrived; proceed with best judgment." The run finishes normally
  (`noAnswerResult`, `<openclaw>/dist/ask-user-tool-rpHQnkkO.mjs` lines
  228-231 and 331-333).
- **Run stopped while asking** (live): `chat.abort` emits
  `question.resolved {status:"cancelled"}`. The tool result has `isError:
  true`, and the run ends `aborted`.
- **Plain text while a question is pending** (live): a normal `chat.send`
  answers the pending question.
  - For a single-choice question, the whole text is the answer.
  - For a multiple-choice question, the text is split on commas,
    semicolons and newlines (`<openclaw>/dist/gateway-question-DeNtr0r1.mjs`
    line 236).
  - In both probes the asking run then ended with `chat state:"error"`,
    `errorMessage: "SQLite transcript changed while preparing rewrite for
    …"`, while the answering send got its own run. The source does not make
    this failure deterministic; treat it as an observed race.
  - Clients should answer with `question.resolve` and not with text.
- One pending question per session. A second `ask_user` in the same
  session fails with "ask_user already has a pending question for this
  session".
- **Scope** (live): a paired device with `operator.read` and
  `operator.write` got no question events. Its `question.list`, `get` and
  `resolve` calls failed with `FORBIDDEN` "Session-scoped access requires a
  verified user profile." That error comes from the session-scope path
  (`authorizeAuthenticatedProfileForMethod`,
  `<openclaw>/dist/gateway-client-identity-E44CR5D-.mjs` line 28). The
  `operator.sessions.write` substitution in the scopes section therefore
  works only for an operator actor with a profile id, and that was not
  shown live. **Request `operator.questions`**. A device holding it
  received the events and resolved questions (live).
- A sidebar "waiting for you" flag:
  - Build a map `id -> {sessionKey, runId, agentId}` from `question.list`
    at connect and from `question.requested`.
  - Clear the entry by `id` on `question.resolved`, which carries only
    `{id, status, answers?}` and no `sessionKey`.
  - The run's lifecycle has no question phase (live: `start > model … end`
    only).

#### Run behavior

- **Queue modes** (live, both during a streamed reply and during a tool
  call). When `chat.send` omits `queueMode`, the effective mode is the
  first of these that is set (`resolveQueueSettingsCore`,
  `<openclaw>/dist/settings-PLT2JnYz.mjs` lines 49-65):
  1. the inline `queueMode` on the request, passed through at
     `<openclaw>/dist/chat-send-handler-D_7lP5Io.mjs` line 2830;
  2. the session's persisted `queueMode` (set with `/queue`);
  3. `messages.queue.byChannel.<channel>` for the request's channel;
  4. `messages.queue.mode`;
  5. `steer`.

  The same chain sets the cap (default 20), the drop policy (default
  `summarize`) and the debounce.

  - On the unconfigured probe, omission resolved to `steer` and behaved
    exactly like it (live).
  - A client that needs steer must send `queueMode:"steer"`.
  - A client that needs one answer per message must send
    `queueMode:"followup"`, and must allow for the cap and drop policy.
  - Lines 4995-4996 of the handler only route an explicit `steer` or
    `interrupt` at admission; they do not define the fallback.
  - `steer`: the message is injected into the active run. The send returns
    its own `runId`, and that run settles at once with an empty `chat
    final`. The answer streams under the active run's `runId`. During a
    tool call, the tool finished first, then the model got the steered
    text. Correction to row 5: an earlier probe saw a steer during
    streaming abort the run with "Session reader operation is no longer
    current". It did not happen again with the current scripted model.
    Keep the e2e test.
  - `followup` and `collect`: the active run finishes untouched, then the
    message gets its own run with its own final reply. The difference,
    batching several queued messages into one turn, was not exercised.
  - `interrupt`: the send returns `interruptedActiveRun: true`. The active
    run ends `chat state:"aborted"`, and the new run answers. Its partial
    text is not kept in history.
- **Interrupt in practice** (live): `chat.abort {sessionKey}` returns `{ok,
  aborted, runIds}`. The run ends `chat state:"aborted", stopReason:"rpc"`
  and `lifecycle end {status:"cancelled", aborted:true}`. A tool in flight
  reports `agent stream:"tool"`, `data:{phase:"result", name, toolCallId,
  isError:true, result:{content:[{type:"text", text:"Aborted"}],
  details:{}}}`.
- **A tool that never returns** (live): `chat.abort` cancels it. A 600 s
  MCP `slow_task` was aborted after 2 s, and the next run in the same
  session started within half a second.
- **Timeouts.** One observed case (live): a run with `chat.send
  {timeoutMs:3000}` during a 20 s MCP tool produced:
  - `agent stream:"tool"`, `data:{phase:"result", isError:true,
    result:{content:[{type:"text", text:"Aborted"}]}}`;
  - `agent stream:"lifecycle"`, `data:{phase:"error", error:"⚠️ Coder Slow
    Task failed"}`;
  - `chat {state:"error", errorMessage:"⚠️ Coder Slow Task failed"}`, with
    no `errorKind`. Here the tool failure masked the timeout.

  This is one case, not the contract. There is no separate timeout event,
  but structured timeout data exists when the runtime classifies the
  outcome as a timeout:
  - `chat` errors carry `errorKind:"timeout"`
    (`<openclaw>/dist/chat-send-handler-D_7lP5Io.mjs` lines 2923-2970);
  - terminal lifecycle data can carry `timeoutPhase`, `providerStarted`
    and `stopReason`
    (`<openclaw>/dist/agent-run-terminal-outcome-Bhd03MJM.mjs` lines
    251-272).

  Accept both a generic tool failure and an explicit timeout
  classification, and never parse the error text.

  `timeoutMs` is an execution budget, not a wall-clock deadline: it pauses
  while the run waits for an approval and resumes with what is left
  (`<openclaw>/dist/builtin-openclaw-CcrkVuBH.mjs` lines 11382-11458). A
  product limit that includes human waits needs its own client deadline and
  `chat.abort`.

  An exec that hits its own timeout is a tool error with `details:
  {status:"failed", failureKind:"overall-timeout", timedOut:true,
  exitSignal:"SIGTERM"}` (see tool events below).
- **Compaction.**
  - Manual: `/compact [focus]` sent with `chat.send` works from
    `operator.write` (live). The reply is a `chat final` whose message is a
    status notice (`openclawStatusNotice: true`), "⚙️ Compacted (120 → 33)".
  - History gains a row `{role:"system", __openclaw:{kind:"compaction",
    tokensBefore, tokensAfter, id, itemId}}` (live).
  - Under the default `compaction.mode: "safeguard"`, the scripted
    summary failed the quality audit. The reply said "⚙️ Compaction failed:
    …" and history was unchanged (live).
  - `sessions.compact` needs `operator.admin` (live: "missing scope").
  - Automatic: it runs near the context limit or after an overflow error
    (`<openclaw>/docs/concepts/compaction.md`). The run then streams
    `agent stream:"compaction"` with `{phase:"start", itemId?}` and
    `{phase:"end", itemId?, completed, willRetry, outcome, reason?}`
    (source: `<openclaw>/dist/builtin-openclaw-CcrkVuBH.mjs` lines
    4911-4991; not triggered live).
  - Watch `sessions.list` row `contextBudgetStatus` for an approaching
    compaction.
- **Pending approvals** (live, an exec approval held open):
  - a new message in `steer` mode (the probe's resolved default) leaves it pending, and
    `exec.approval.list` still lists it;
  - `interrupt` cancels it;
  - `chat.abort` cancels it, and the run ends `aborted`;
  - a run `timeoutMs` shorter than the wait does not end a run blocked on
    the approval, because the budget pauses: the approval stayed listed.

  These observations cover the synchronous exec path. There, the tool
  waits for the decision, so the run stays open while the approval is
  pending (`<openclaw>/dist/bash-tools-Cig8cES0.mjs` lines 1213-1255).

  That is not a general guarantee. Exec also has a detached follow-up path
  (same file, lines 1284-1411). It starts a background waiter and returns an
  approval-pending tool result at once (lines 426-478), and the run carries
  on without the decision. The path is used:
  - when no approval route is available;
  - for the `/diagnostics` and `/export-trajectory` commands;
  - when exec defaults set `approvalFollowupMode`.

  Plugin and general approvals are records of their own as well.

  Treat run termination and approval state as independent facts:
  - Reconcile pending exec, plugin and general approvals by `id`, run and
    session.
  - If a pending action must be closed when its run ends, deny it explicitly
    with `exec.approval.resolve`, `plugin.approval.resolve` or
    `approval.resolve` (`operator.approvals`).
  - Do not assume a finished run withdrew permission to execute.
- **Side runs and helpers** (source):
  - `/btw` and `/side` run a one-shot side question that never enters
    history. The answer arrives as `chat.side_result` (session-read)
    (`<openclaw>/docs/tools/btw.md`).
  - `chat.abort {preserveSideRuns:true}` leaves `/btw` runs running
    (`turnKind === "btw"`, `<openclaw>/dist/chat-abort-runtime-DN2xZ73h.mjs`
    lines 226 and 245).
  - Approvals raised by sub-agents reach the parent's subscribers through
    the persisted ancestor audience of `session.approval`. The event's
    `sourceSessionKey` names the raising session and `sessionKey` the
    audience (`<openclaw>/docs/gateway/protocol/rpc-bootstrap-and-events.md`).
    Live: own-session approvals carry both keys equal. A sub-agent's exec
    could not raise an approval at all (row 20).
- **Parallel runs** (source):
  - one run at a time per session, through the `session:<key>` lane;
  - across sessions, the global cap is `agents.defaults.maxConcurrent`,
    default `max(8, CPUs × 4)` (`<openclaw>/dist/agent-limits-CB2bq0ey.mjs`
    lines 4-20);
  - sub-agents: 8 per spawning session (`agents.defaults.subagents.
    maxConcurrent`);
  - there is no per-bot limit.
- **Reset** (live):
  - `/new` and `/reset` sent with `chat.send` from `operator.write` are
    refused with the reply "⚠️ You are not authorized to reset this
    session. Gateway resets require operator.admin…";
  - `sessions.reset {key}` (admin) keeps the `sessionId`, changes
    `lifecycleRevision`, and leaves a single `[reset]` boundary row in
    history.

#### Reasoning

Live, a run with reasoning, a tool and more reasoning emitted, in order:

```text
seq 3  lifecycle start      seq 5  lifecycle model
seq 6-7  thinking {text, delta}           (segment 1)
seq 9  item start  itemId "tool:<id>"      seq 10 tool start
seq 11 tool result                         seq 12 item end
seq 13 lifecycle model
seq 15 thinking {text, delta}             (segment 2, text restarts)
seq 17 assistant {text, delta, itemId "<runId>:2"}
seq 18 lifecycle finishing   seq 20 lifecycle end
```

- Reasoning carries no item id and no segment marker. Order is the
  per-run `payload.seq`.
- The real boundary is a new assistant message: reasoning state resets
  when one starts (`handleMessageStart`,
  `<openclaw>/dist/builtin-openclaw-CcrkVuBH.mjs` lines 5823-5828).
- On the wire, the boundaries visible to a client are the tool items
  between messages and `lifecycle phase:"model"`.
  `lifecycle phase:"model"` usually accompanies a new message, but it is
  also emitted when the response's model identity changes (same file, lines
  7419-7440).
- Within a segment, `text` is cumulative and `delta` is the appended part.
- When new text does not extend the previous text, `emitReasoningStream`
  sends the whole new text as `delta` (same file, lines 8358-8379). That is
  a replacement, not an explicit new-segment marker. A replacement within
  one message cannot always be told apart from a new segment on this
  stream alone.
- History keeps reasoning as `{type:"thinking", thinking}` blocks in each
  assistant row, before that row's `toolCall` or `text` block.
- A run with reasoning and no tool emits the following, and one assistant
  row `[thinking, text]` (live):

  ```text
  lifecycle start, model, thinking…, assistant…, finishing, model, end
  ```

#### Tool events in depth

- **Titles** (source): the fixed parts of `item.title` and `meta` are
  English labels built from the tool name and arguments
  (`resolveToolDisplay`, `<openclaw>/dist/tool-display-H962ONhl.mjs`).
  `connect.locale` is not read.
  - `exec` also takes an optional agent-authored `title`, described as a
    short purpose (`<openclaw>/dist/typebox-X-jU33BZ.mjs` lines 37-47).
    - `resolveExecTitle` collapses whitespace, sanitizes and redacts it,
      then cuts it to 120 characters (`tool-display-H962ONhl.mjs` lines
      815-831).
    - `resolveExecDetail` puts it ahead of the command-derived text.
    - It reaches `meta` and the composed item title.
    - It is free text in whatever language the model wrote.
  - `chat.toolTitles` is deprecated and returns `{titles:{}, disabled:true}`
    (`<openclaw>/docs/gateway/protocol/rpc-session-control.md`).
  - Localize the fixed labels in the client. Show authored purposes as
    they are. Do not treat a whole title as a translation key.
- **Error kinds** (live):
  - A thrown or aborted tool gives `tool result {isError:true}`, with text
    content. The text is "Aborted" for aborts and run timeouts.
  - An exec that exceeds its own timeout gives `isError:true, details:
    {status:"failed", exitCode:null, exitSignal:"SIGTERM", failureKind:
    "overall-timeout", exitReason:"overall-timeout", timedOut:true,
    durationMs}`.
  - An exec that exits non-zero is **not** an error: `isError:false,
    details:{status:"completed", exitCode:1, exitReason:"exit"}`, and the
    text ends "(Command exited with code 1)".
  - A plugin block (P5) is a blocked tool result (source:
    `<openclaw>/dist/agent-tools.before-tool-call-B71Yo63P.mjs` lines 3322,
    3384 and 3687).
    - The hook returns `{block:true, blockReason:"…"}`.
    - The result's text content carries the reason.
    - The result's `details` has `status:"blocked"`, the host-owned code
      `deniedReason:"plugin-before-tool-call"` and `reason` (the
      `blockReason`).
- **Long output** (live, about 1 MB of exec output):
  - `command_output` deltas stop at a retention cap. The first line says
    "[earlier output was discarded at the retention cap…]".
  - The `tool result` text is about 8 000 characters and ends
    "…(truncated)…".
  - The `toolResult` history row holds 8 000 characters, with
    `__openclaw.truncated` and `reason`.
  - To see more, raise `chat.history {maxChars}`. `toolResultMaxChars`
    only lowers the limit further for tool text and cannot raise it past
    `maxChars`, whose default is 8 000
    (`<openclaw>/dist/chat-display-projection.canvas-OCRpCKvQ.mjs` lines
    165-184).
  - `chat.message.get` also returned more (live: 31 996 characters).
  - Neither can recover output already dropped at the process retention
    cap.
- **Raw fields** (live):
  - Call: `tool start {name, toolCallId, args}`, and history
    `{type:"toolCall", id, name, arguments}`.
  - Result: `tool result {name, toolCallId, isError, commandBearing, meta?,
    result:{content[], details}}`, and history `{role:"toolResult",
    toolCallId, toolName, content, details, isError}`.
  - MCP tools are named `<server>__<tool>` (live: `coder__slow_task`), and
    `details` carries the MCP `structuredContent`.
    - Both parts are the effective safe names: characters outside
      `[A-Za-z0-9_-]` are replaced, the server part is cut to 30
      characters, the total to 64, and a `-<n>` suffix resolves collisions
      (`<openclaw>/dist/agent-bundle-mcp-names-CFVETBL6.mjs` lines 3-72).
    - Use the advertised or event name verbatim. Do not build it from raw
      MCP server and tool names, and do not parse it back into them.

#### Bot-to-bot (`sessions_send`) recipient states

Live, Pixel to Atlas, each in a new task:

| Recipient state | What the sender sees |
| --- | --- |
| replied in time | `{status:"ok", runId, sessionKey, delivery:{status:"skipped"}, reply}` |
| accepted, still working | `{status:"accepted", runId, sessionKey, targetDisposition:"queued", delivery:{status:"pending"}}`. Returned for a 0 s wait and also for 2 s and 6 s waits on a slow recipient; no `status:"timeout"` was observed |
| replied later | one assistant row in the **sender's** session with `provenance:{kind:"inter_session", sourceSessionKey, sourceTool:"sessions_send"}`, `senderLabel:"Forwarded from <agentId>"`, `senderSession:{sessionKey, agentId}`. It starts a new sender run, which answers it |
| asks its user | `accepted` as above; `question.requested` carries the **recipient's** `sessionKey`, `agentId` and `runId`, with no field naming the sender; after the answer, the late reply arrives as above |
| finished without a reply (`NO_REPLY`) | the gateway re-prompted the recipient ("The previous attempt did not produce a user-visible answer…") and the sender got `status:"ok"` with that reply; `status:"no_reply"` exists in the schema but was not produced |
| stopped | `{status:"error", error:"agent error", sentBeforeError:true, runId, sessionKey}` |
| with `watch:true` | as `accepted`, plus `watched:true`; the later reply arrives as above |

- **What establishes what for a `sessions_send` card.** The interface
  must not claim more than these.
  - **Sent**: the tool result's `details.status` is `ok`, `accepted` or
    `queued`, or the result is an error with `sentBeforeError:true`. A
    `tool start` event alone means only that the send was requested.
  - **Recipient run**: when the result carries `runId`, it equals the
    recipient run's `runId` (live). That run's `agent` and `chat` events
    are then exactly attributable to this send. A `queued` result has no
    `runId`.
  - **Replied, in the same call**: `status:"ok"` with `reply`.
  - **Replied later**: **not established for a given send.** The late
    row in the sender's session carries `provenance.sourceSessionKey`,
    `sourceTool`, `senderLabel` and `senderSession`. It carries no send id
    and no run id (`runAgentStep`,
    `<openclaw>/dist/sessions-spawn-tool-CMHR26Kp.mjs` lines 638-667;
    delivery at lines 874-880).
    - Several sends to the same recipient can be outstanding at once. So
      "the most recent accepted send" can attach send A's reply to send B.
    - With exactly one outstanding send to that recipient, the match is a
      heuristic.
    - With more than one, keep the reply unmatched and the cards Unknown.
    - An exact general match needs a plugin-provided receipt.
    - A sub-agent's completion uses `sourceTool:"subagent_announce"`;
      it is not this path.
- **Recipient waiting on an approval**: possible. The source admits a
  recipient's approval request subject to scopes and live run authority;
  it has no rule against nested runs (row 20). Live, a recipient raised a
  card when the sender's run was started from a device holding
  `operator.admin`. From a read/write/approvals/questions device, the
  recipient's exec failed to register its approval. That failure is not
  explained. Keep recipient approval-card handling.
- **Who may message whom** (source:
  `<openclaw>/docs/concepts/session-tool.md`, "Sending cross-session
  messages"):
  - the global `tools.agentToAgent` policy: `enabled: false` blocks
    ordinary cross-agent access, and `allow` restricts the permitted agent
    pairs. With the default session visibility `all`, cross-agent sends are
    open;
  - per bot, an outbound list `agents.entries.<id>.tools.agentToAgent.send`
    (admin; `[]` denies, omission keeps the global policy; live with
    `["atlas"]`);
  - session visibility rules.

  There is no inbound list per recipient. A plugin `before_tool_call` hook
  can check `args.sessionKey` (P5).
- **Usage by trigger.** A recipient run is a normal run in the
  recipient's session, and its usage counts toward that session.
  - `sessions.usage` rows carry a nested `usage` object with
    `usage.totalCost`. While it is being computed, `usage` is `null` and the
    row has `computing:true` (`<openclaw>/dist/usage-DNHtJAIp.mjs` lines
    1102-1124).
  - `estimatedCostUsd` is a different field, on `sessions.list` rows
    (`schema` `SessionRow`).
  - The recipient's turn is marked by inter-session provenance, but no
    usage field names the trigger. No per-trigger cost split exists, so do
    not charge a recipient session's whole total to one send.

#### External coding agent over MCP

- **What establishes what for an external (MCP) call.** The interface
  must not claim more than these.
  - **Requested, so "Sending"**: `item start {status:"running"}` and
    `tool start {toolCallId, args}`.
    - This does **not** prove the call was made. The start event is emitted
      before argument validation and before `before_tool_call` hooks.
    - Unexecuted calls also get a start, for example when cancelled or
      skipped by steering (`prepareToolCallEntry` and
      `completeUnstartedToolCall`, `<openclaw>/dist/agent-core-DlqC-il7.mjs`
      lines 1127, 1256, 1354 and 1505).
    - A history `toolCall` block is the model's request. It survives even
      when the tool never ran.
  - **Call made**: **not established** by any generic event or field. The
    runtime tracks `executionStarted` internally but does not project it to
    clients. Entering the MCP client also does not prove the server
    accepted the request.
  - **Call returned**: a `tool result` with `isError:false`. Its
    `result.content` and `details.structuredContent` are the server's
    reply.
    - An `isError:true` result can come from the gateway (validation,
      hooks, abort) or from the server. The generic result does not say
      which.
    - Acceptance or completion beyond that holds only where the tool's own
      result contract states it.
  - **Stopped**: a result `isError:true` with text "Aborted" (live) means
    the run stopped the call. Delivery stays **Unknown**: the call may
    never have been sent, or may have reached the server.
    - When the request was in flight, the MCP client sends
      `notifications/cancelled {requestId, reason}` (live, row 20).
    - The client cannot observe that notification.
- **Progress**: none is forwarded. A long call shows its start events, then
  nothing until it ends. The runtime calls the MCP SDK's `callTool` with a
  timeout and an abort signal and no `onprogress`
  (`<openclaw>/dist/agents/agent-bundle-mcp-runtime.js` lines 709-726).
  The stand-in server sends no progress, so the probe was not itself a
  forwarding test.
- **Identifiers**: `toolCallId`, the item id `tool:<toolCallId>`, `runId`
  and `sessionKey`. A coding-thread id exists only in the tool's own result
  (`structuredContent.threadId`, live, section 5).

#### Lists and metadata

- **Time fields** (live values on a new task):
  - session rows: `createdAt`, `updatedAt`, `lastInteractionAt`,
    `lastActivityAt`, `snapshotAt`, `pinnedAt`, `archivedAt`, `snoozedAt`,
    `lastReadAt` and `markedUnreadAt` are in the published `SessionRow`
    schema;
  - the gateway also projects `startedAt` and `endedAt` of the latest run.
    These two are **not** in the published schema
    (`<openclaw>/dist/session-utils-display-BwAgrLkG.mjs` lines 49-85), so
    types generated from the schema will lack them;
  - live: all were present except the unset pin, archive, snooze and read
    times;
  - messages: `timestamp`, set at creation, and
    `__openclaw.recordTimestampMs`, set when written to the transcript;
  - all are epoch milliseconds. Sort the sidebar by `lastInteractionAt`
    (`sessions.list` and `sessions.search` `scope.sortBy` accept
    `updatedAt`, `lastInteractionAt` and `activity`).
- **`sessions.search`** (`operator.read`, `SessionsSearchParams`):
  - params are one of two closed forms; the schema rejects `scope`
    together with a top-level `agentId` or `sessionKeys`
    (`<openclaw>/dist/src-BSx5Woe0.mjs` lines 1786-1833, the `not` rule):

    ```text
    {query, sessionKeys:[1-200], agentId?, limit?}
    {query, scope:{agentId?, activeMinutes?, activeOnly?, sortBy?, label?,
                   projectId?, workspaceDir?, exclude*…}, limit?}
    ```

    `limit` is 1-25. There is no cursor, offset or time range, so older
    matches cannot be paged;
  - result: `{results:[{sessionKey, sessionId, messageId, role:
    user|assistant, timestamp, snippet, score}], sessions?:[compact rows],
    indexing?, truncated?, archivedTranscriptsExcluded?}`;
  - live: with `sessionKeys` or with `scope` it returned both matching
    rows with snippets;
  - on a multi-agent gateway, `query` alone is schema-valid but the
    handler fails because it cannot resolve an owner ("session key "main"
    has no explicit owner"). `agentId` without `sessionKeys` fails
    ("agentId requires sessionKeys"); put an agent filter in
    `scope.agentId` instead.
- **Rejected or expired pairing** (source):
  - `device.pair.resolved` is `{requestId, deviceId, decision, ts}`.
  - Broadcasts to `operator.pairing` connections carry `decision:
    "approved"` or `"rejected"` (`<openclaw>/dist/devices-mOg4_HQd.mjs`
    lines 101, 400 and 437).
  - The connecting socket itself is held open and told only when its
    `client.id` is `openclaw-control-ui` or `openclaw-tui`
    (`waitForResolution`,
    `<openclaw>/dist/message-handler-CRCo2VX0.mjs` line 2057). It then gets
    `device.pair.resolved` with `decision` `approved`, `rejected` or
    `expired`, then a close with code 1008 and reason `pairing <decision>`
    (lines 2193-2209; `waitForDevicePairingResolution`,
    `<openclaw>/dist/device-pairing-D17Yb5Sp.mjs`, `"expired"` at
    `expiresAtMs`). A superseded request closes without the event.
  - A `gateway-client` connect is refused with `PAIRING_REQUIRED` and gets
    no later event. It must reconnect: a reconnect after rejection or
    expiry creates a new request. It cannot tell the two apart without
    `operator.pairing` (**unverified live**: the remote pairing path still
    needs a non-loopback connect).
- **`users.prefs`** (`<openclaw>/dist/users-BUx10Lx0.mjs` lines 161-163
  and 403-426):
  - `users.prefs.get {keys?:[≤32]}` (`operator.read`) returns `{status:
    "ok", entries:{<key>:<any JSON>}}` or `{status:"no_durable_identity"}`;
  - `users.prefs.set {entries:{≤32}, expectedEntries?}`
    (`operator.write`) returns `ok`, `conflict` or `no_durable_identity`;
  - keys are 1-256 characters, and a profile holds at most 128 keys
    (`USER_PREFS_LIMIT_EXCEEDED`);
  - `expectedEntries` is a compare-and-set, and a `null` there means "must
    be absent";
  - a `null` value deletes the key (`writeUserPreferences`,
    `<openclaw>/dist/user-preferences.store-BbmywMbP.mjs` lines 109-125;
    deletion not exercised live);
  - event `users.prefs.changed {profileId, keys}` (session-read).
  - Live: a paired device stored and read back, unchanged,
    `{"clawtrate.sidebar":{pins:["atlas"], sections:[{name:"Work",
    bots:["pixel"]}], hidden:[], order:["atlas","pixel"]}}`. So pins,
    sections, hidden bots and manual order fit in one key.
  - A shared-token backend connection gets `no_durable_identity`. The store
    is per user profile, so every device of that user sees it.
- **Default or primary bot** (source:
  `<openclaw>/dist/agent-list-NuNAO01y.mjs` lines 28-67):
  - `agents.list` returns `defaultId` and puts it first;
  - with one agent it is that agent; in an explicit multi-agent config it
    is the first configured entry;
  - there is no method or config field to set it, and reordering
    `agents.entries` through `config.patch` (admin) is the only lever;
  - store a Clawtrate "primary bot" in `users.prefs`.
- **Reactions** (live):
  - `session.reactions.set {sessionKey, messageId, emoji, remove?}`
    (`operator.write`) returns `{messageId, reactions:[{emoji, count,
    identities:[{id, label}]}], mirror:{status, reason?}}`. `remove:true`
    removes the reaction.
  - `session.reactions.list {sessionKey}` (`operator.read`) returns
    `{sessionId, reactions:{<messageId>:[…]}}`.
  - Event `session.reaction {sessionKey, agentId, sessionId, messageId,
    emoji, action:"added"|"removed", actor:{type, id, label}, reactions}`.
- **Reply threads** (live): `chat.send {replyToId}` makes the user row a
  reply reference. `chat.history` shows it as:

  ```text
  message.__openclaw.replyToId
  message.__openclaw.replyToPreview = {text, senderLabel?}       (optional)
  message.__openclaw.replyToMessage =
      {ok:true, message:<projected original>}
    | {ok:false, unavailableReason:"not_found"|"not_visible"|"oversized"}
  ```

  - `replyToPreview` is stored with the user turn
    (`<openclaw>/dist/user-turn-transcript.metadata-1icjdgH0.mjs` lines
    47-63).
  - `replyToMessage` is added by the history reader at read time
    (`<openclaw>/dist/chat-history-reply-messages-OLz_LDJu.mjs` lines
    41-102). The original may no longer be available.
  - This is a reference, not a separate thread. No thread-listing method
    exists.

#### Attachments

Live and source agree on these ceilings:

| Ceiling | Value | Enforced in | Error |
| --- | --- | --- | --- |
| WebSocket frame | 26 214 400 bytes (25 MiB) after `connect`; 65 536 before | `ws` `maxPayload`, raised after the handshake (`<openclaw>/dist/ws-connection-Cq7PPwbb.mjs` lines 559-584; constants in `<openclaw>/dist/server-constants-BH_EolwD.mjs`) | the socket closes with code **1009** and no response (live: "gateway closed (1009)"; gateway log "Max payload size exceeded") |
| image | 6 291 456 bytes decoded | `parseMessageWithAttachments` (`<openclaw>/dist/chat-attachments-Bmvu3oSJ.mjs` line 232; `MAX_IMAGE_BYTES` in `constants-GzjKtFvA.mjs`) | `chat.send` fails `INVALID_REQUEST`, "Error: attachment big.png: image exceeds size limit (6291457 > 6291456 bytes)" (live) |
| any file | `agents.defaults.mediaMaxMb`, default 20 MiB decoded | `prepareMediaAttachment` (same file, line 24), with `resolveChatAttachmentMaxBytes` (`chat-send-handler-D_7lP5Io.mjs` line 3167) | `INVALID_REQUEST`, "attachment <name>: exceeds size limit (<n> > <max> bytes)" (source) |
| advertised `hello-ok.policy.attachments.maxBytes` | 19 464 192 = `min(mediaMaxMb, floor((25 MiB − envelope slack) × 3/4))` | not enforced as such; it is the largest single file whose base64 fits the frame (`chat-attachment-policy-B0H4omOp.mjs`, `chat-attachment-frame-budget-BBmKdOhk.mjs`) | live: a 19 464 193-byte text file was **accepted**, because the 20 MiB file check passed and the frame still fit |

- So "about 18.5 MiB per file" is the advertised safe size, not a gateway
  check. The frame is the real limit for a whole `chat.send`: several
  files must fit in one 25 MiB frame together.
- A save failure returns `UNAVAILABLE` "[Gateway Error] Failed to save
  intercepted media to disk…" (`MediaOffloadError`,
  `chat-send-handler-D_7lP5Io.mjs` line 3215).
- For a text-only model, `chat.send` does not reject an image. It passes a
  model-support check to the parser, and a `false` result offloads the
  image to managed media instead of sending it inline. The usual size and
  save-failure checks still apply (`<openclaw>/dist/chat-send-handler-D_7lP5Io.mjs`
  lines 3154-3189; `<openclaw>/dist/chat-attachments-Bmvu3oSJ.mjs` lines
  225-257). The "active model does not accept image inputs" rejection
  applies only to entrypoints that disallow inline images without forced
  offload.

### 20. Side panel and per-bot controls

Same markings as row 19: **live**, **source** or **unverified**. "Live" means
a committed script in `docs/research/dev-gateway/scenarios/` reproduces it
(its README lists the row 20 files). A failed probe is evidence about that
probe, not about the version. Every absence below names the search behind
it, and every `operator.admin` claim names the lower-scope paths checked.

**Lower-scope search, used throughout this row.** The method map in the
pinned `schema` was scanned for every non-admin method in the families
`agents.*`, `config.*`, `exec.*`, `cron.*`, `memory.*`, `skills.*`,
`mcp.*`, `secrets.*`, `models.*`, `environments.*`, `node.*`, `plugins.*`
and `tools.*`, plus `sessions.dispatch` and `sessions.move`. The non-admin
results:
- read: `agents.list`, `agents.files.list/get`, `agents.workspace.list/get`,
  `config.get/schema/schema.lookup`, `memory.*`, `models.list`,
  `models.authStatus`;
- write: `skills.library.*`, `mcp.app.*` writes, `tools.invoke`, and
  `sessions.dispatch`/`sessions.move` with device targets.

Where a claim below says **`operator.admin`**, no method in that list does
the same job unless the claim names one.

Node fixtures for this row were started with `openclaw --profile <probe>
node run --host 127.0.0.1 --port 19101 --no-tls --display-name <name>` under
the launcher's controlled environment.

#### Conversations shared by several bots

- **No native multi-agent session was found**, and every session belongs
  to one executing agent. Evidence:
  - the key is `agent:<agentId>:…`, and the transcript lives in that
    agent's own store (`<openclaw>/docs/concepts/multi-agent.md`, "Each
    agent has its own");
  - live: `chat.send` on Atlas's session with `agentId:"pixel"` failed
    with `INVALID_REQUEST` "agent "pixel" does not match session key agent
    "atlas"";
  - the method map has no group or multi-agent conversation method
    (search: method names containing `group`, `member`, `participant`,
    `discussion`, `swarm`). `sessions.groups.*` organizes the sidebar.
- **Membership is access metadata**, not a second executing agent.
  `session.members.add {sessionKey, identityId}` (`operator.write`)
  accepts an id from the session's known identities: the caller, every
  projected session creator, and human profiles (`knownSessionIdentities`,
  `<openclaw>/dist/sessions-sharing-DX8n-lby.mjs` lines 32-58 and
  245-263).
  - Creators keep their `createdActor.type`, so an agent that created a
    session through spawn can be a known identity.
  - Live: the invented ids `pixel` and `agent:pixel` were "unknown
    identity". That shows only that those two strings were unknown, not a
    human-only rule.
  - Adding an agent identity does not change who executes the session.
- `chat.send` `mentions` are human profile mentions (`{profileId, start,
  end}`, at most 10).
- **What a client can compose:**
  - one session per bot, with `sessions.create` (`operator.write`);
  - a group-to-sessions mapping held by the client or a plugin;
  - a merged view from `chat.history`, `session.message` and `agent`/`chat`
    events, each carrying `sessionKey` and `agentId` (`operator.read`);
  - targeting with `chat.send {sessionKey}` per bot, and coordination
    between bots with `sessions_send`.

  Shared context, turn-taking and answer selection must then be designed
  in the client or plugin; the gateway stores no shared transcript.

#### Approvals raised outside the user's own run

- **What the source permits**: helpers and recipients can raise approval
  cards, subject to scopes and live run authority. The source has no rule
  against nested runs.
  - Admission: `callGatewayTool` (`<openclaw>/dist/gateway-0s_-cY-q.mjs`
    lines 276, 310 and 397) resolves the required scopes and the live
    runtime identity.
  - It then dispatches either in-process or through the transport
    fallback (`<openclaw>/dist/in-process-gateway-BE6BFDfY.mjs` line 94;
    `server-plugin-in-process-dispatch-woZlNPqI.mjs` lines 36 and 204).
  - In-process, the requested scopes are projected through the captured
    source or operator authority; minimum scopes are not an escalation.
  - An exec approval request needs `operator.approvals` (or admin, which
    satisfies it) and valid run-bound authority after that dispatch.
- **What the probe showed** (live, `helper-and-recipient-approvals.mjs`,
  which reports `CARD`, `FAILED`, `RAN` or `UNKNOWN` from the child's own
  call and result):
  - parent run started from a device holding `operator.admin`: a
    `sessions_spawn` helper and a `sessions_send` recipient each raised a
    real card (`CARD`);
  - parent run started from a device holding read, write, approvals and
    questions: each child's exec result was `isError:true`, "Exec approval
    registration failed: GatewayClientRequestError: missing scope:
    operator.approvals" (`FAILED`).

  Why the second case lacked the scope remains **unexplained**: the dispatch
  path the nested call took was not traced.
- So: keep helper and recipient approval-card handling.
  - The gateway delivers child approvals to ancestor audiences
    (`session.approval`, row 19).
  - `chat.abort` cancels controlled descendants
    (`<openclaw>/dist/chat-abort-handler-ta8mBb_q.mjs` lines 183-205).
  - Run-bound approvals are cancelled when their owner ends.
  - Live: once the parent run had already finished (a spawn returns
    `accepted` at once), `chat.abort` on the parent's session aborted
    nothing (`runIds:[]`). The helper's card stayed pending until the probe
    denied it. Cancellation of a child card by stopping a still-active
    parent was not shown.
- **Side runs** (`/btw`) on the direct-provider path are one-shot provider
  calls without tools (`<openclaw>/docs/tools/btw.md`). Codex-harness side
  questions and CLI backends have their own contracts, so this does not
  hold for every runtime. `chat.abort {preserveSideRuns:true}` spares BTW
  runs.

#### A settings change while an approval is pending

Live, `members-mcpcancel-settings.mjs settings`:

| Change | Pending approval | Run |
| --- | --- | --- |
| `sessions.patch {permissionMode:"guarded"}` (write) | resolved `deny`, `resolvedBy:"approval-scope-closed"` | in this probe the change could not be applied, so the patch returned `UNAVAILABLE` "Permissions were saved, but could not be applied…" and the run ended `aborted` |
| `config.patch` setting the bot's `tools.exec.mode` to `full` (admin; restored exactly afterwards) | still listed after 4 s | waited, then finished after the probe denied it |

The source has three outcomes for a permission change
(`<openclaw>/dist/sessions-patch-permissions.runtime-BdqqviLC.mjs` lines
48-84):
- **applied**: approvals from the old permissions are cancelled and the
  run continues with the new policy;
- **refused before saving**: an active run that cannot apply permissions
  gets `INVALID_REQUEST` "This run cannot apply permissions while
  active…";
- **saved but not applied**: the run is stopped and the patch returns
  `UNAVAILABLE`, as in the probe.

A client must not treat every permission patch as a Stop. The config
observation shows only that this one config change left the approval
pending.

`sessions.patch {execSecurity, execAsk}` is retired. Requests carrying
either field, even `null`, fail with `INVALID_REQUEST`
(`<openclaw>/dist/sessions-patch-DIr6Po0r.mjs` line 127; live).

#### MCP cancellation

When a run is aborted during an MCP call, the server received
`notifications/cancelled {requestId, reason:"AbortError: agent run
aborted"}`. The stand-in server's `received_notifications` tool reported
it (live, `members-mcpcancel-settings.mjs mcpcancel`).

#### Files and the library (side panel)

- **Tree**: page through it with `agents.workspace.list {agentId, path?,
  offset?, limit?}` (`operator.read`), one directory per call.
  - `limit` defaults to 250, maximum 500
    (`<openclaw>/dist/agents-workspace-Gm2ASifr.mjs` lines 14-15).
  - It returns `{path, parentPath?, entries:[{path, name, kind:
    file|directory, size?, updatedAtMs?}], totalEntries, offset}`.
  - Live: a directory entry had `updatedAtMs` and no `size`; a file had
    both.
- **Read and preview**:
  - `agents.workspace.get {agentId, path}` (`operator.read`) returns
    `{file:{path, name, size, updatedAtMs, mimeType, encoding:
    utf8|base64, content}}`.
  - `sessions.files.get {sessionKey, path}` (`operator.read`) adds `kind`,
    `previewKind` (live `"text"`), `contentEncoding` and a SHA-256 `hash`.
  - Limits: previews are capped at 262 144 bytes
    (`WORKSPACE_PREVIEW_MAX_BYTES`,
    `<openclaw>/dist/workspace-file-limits-loc-yzkf.mjs`), and
    agent-workspace images at 5 242 880 bytes
    (`agents-workspace-Gm2ASifr.mjs` line 13).
  - Supported agent-workspace previews are UTF-8 text and recognized
    image formats (same file, lines 115-139), not arbitrary binary
    files.
- **What a task touched**: `sessions.files.list {sessionKey}`
  (`operator.read`) lists files the session `modified` or `read`.
  - Fields: `{path, workspacePath, name, kind, missing, size,
    updatedAtMs}`, plus `browser.entries` with `sessionKind`.
  - `sessions.diff {sessionKey, scope?:all|uncommitted|commit, commit?}`
    gives git file stats. Outside a git checkout it returns
    `unavailableReason:"not_git"` (live).
- **Which step produced a file**: the file tools' events. Live, a `write`
  call carried `tool start {toolCallId, args:{path, content}}` and a result
  `details:{changed, created, diff, firstChangedLine, patch}`. Join on
  `toolCallId` and `runId`. No producing-step field was found on
  `sessions.files.list` or workspace entries (schema definitions
  `SessionsFilesListResult`, `AgentsWorkspaceListResult`).
- **Live changes**: no workspace or file-change event was found. Search:
  the events advertised in `hello-ok.features.events` and
  `<openclaw>/dist/server-methods-list-Cv0-xJIK.mjs`.
  - Live: a write produced only `agent`, `chat`, `sessions.changed`,
    `session.message` and `presence`.
  - Refreshing on file-tool `tool result` events misses changes made by
    shell commands or outside the gateway.
- **Artifacts across a bot's tasks**: `artifacts.list` needs `sessionKey`
  or `runId` (live: "artifacts require sessionKey or runId"). `limit` is
  1-4 and it pages with `cursor`, so one task can take several calls.
- **Downloads**: `artifacts.download {artifactId, sessionKey|runId,
  transport?:"http"}` (`operator.read`) returns `{artifact, encoding?,
  data?, url?, expiresAt?}` (`schema` `ArtifactsDownloadResult`;
  `<openclaw>/dist/artifacts-CVcZMNpQ.mjs` lines 568-640).
  - The mode is `artifact.download.mode`.
  - `bytes`: top-level `encoding:"base64"` and `data`.
  - `url`: top-level `url`, plus `expiresAt` for a managed or HTTP
    download (with `transport:"http"`, a five-minute, connection-bound
    URL).
  - An artifact whose mode is `unsupported` makes the call fail with
    `artifact_download_unsupported`.
  - The HTTP form was not fetched live.
  - No general route serves workspace files over HTTP (search: workspace
    handlers and the HTTP route list); read them with
    `agents.workspace.get`. `sessions.files.assets` serves session preview
    assets under its own contract.

#### Computer signals

| Signal | Source of truth | Shown |
| --- | --- | --- |
| Gateway computer available | `computer.status {probe?}` (`operator.read`) → `{configured, available, computerUse?, error?}`. `probe:false` is a passive read. `probe` defaults to true, which prepares the computer (`<openclaw>/dist/computer-service-C6lOH7z0.mjs` lines 334-341; `<openclaw>/docs/nodes/computer-use.md`) | live: `{configured:false, available:false}` without a provider |
| Node connected, last seen | `node.list`/`node.describe` (`operator.read`): `connected`, `connectedAtMs`, `lastConnectedAtMs`, `lastSeenAtMs`, `lastSeenReason`, `approvalState`, `paired`, `commands`, `caps`, `hostStats`, `pathEnv`, `platform`, `version`, `deviceFamily`, `modelIdentifier`, `sessionHost` | live (`node-pairing-hoststats.mjs`) |
| Heartbeat and free disk | `node.hostStats {nodeId, hostStats:{cpuCount, loadAverage[3], memoryTotalBytes, memoryFreeBytes, diskTotalBytes?, diskAvailableBytes?, updatedAtMs}}` every 60 s (`NODE_HOST_STATS_INTERVAL_MS`, `<openclaw>/dist/node-host-stats-DL3iDh5d.mjs`), also on `node.list`. Disk figures are optional, for the node's sampled volume. A node started with `--commands` (restricted surface) sends none | live |
| Asleep | no sleep state was found in the node, presence or computer schemas. A disconnected node is not evidence of sleep. Mobile nodes refresh presence by sending the node-to-gateway message `node.event {event:"node.presence.alive"}` with a `trigger`; the gateway stores it as `lastSeenReason`, so operators read `node.list`. The operator `node.presence` event carries activity updates, not `trigger` (`<openclaw>/dist/server-node-events-D7AhsYlE.mjs` lines 53-63 and 746-795) | source |
| Needs a human | no dedicated computer signal was found (search: the event list and computer methods). A bot can ask with `ask_user` (row 19), offering "Done" and "Skip", and resumes on the answer. Cloud environments have a `take_control` action (`<openclaw>/docs/nodes/computer-use.md`); not investigated | source |
| Recovery | no physical-computer recover method was found. The only method names containing "recover" are `sessions.recover` and `worktrees.recoverRemoval`, which act on other resources. Nodes reconnect on their own, and `computer.status {probe:true}` re-prepares the gateway computer | source |
| What a node reports | its pairing request: `caps`, `commands`, `bins`, `platform`, `deviceFamily`, `modelIdentifier`, `version` (live, `node.pair.list`) | live |

Paired client devices: `device.pair.list` (`operator.pairing`)
`paired[]` carries `deviceId`, `displayName`, `platform`, `clientId`,
`role`, `scopes`, `approvedVia`, `createdAtMs`, `approvedAtMs`,
`lastSeenAtMs`, `lastSeenReason` and `connected` (live). No last-opened
field was found (schema `DevicePairListResult`, node list fields).
`lastSeenAtMs` is also updated by background alive messages and token
authentication, so label it "Last seen".

Live pairing behavior on loopback:
- The node was approved silently.
- Restarting it with a wider command surface created a new pending request,
  and `node.pair.approve` emitted `node.pair.resolved {decision:"approved"}`.
- Some commands were withheld until approved.

#### Model and reasoning effort

- **Smallest scope**:
  - per task, `operator.write` (`sessions.patch {model, thinkingLevel,
    fastMode}`, row 12);
  - per turn, `operator.write` (`chat.send {thinking, fastMode}`);
  - per bot, **`operator.admin`** (`agents.update {model}`, and
    `config.patch` for `thinkingDefault`, `reasoningDefault`,
    `fastModeDefault`). Lower path checked: no non-admin `agents.*` or
    `config.*` method writes per-agent defaults;
  - `sessions.patch {reasoningLevel, contextWindow}` is
    **`operator.admin`**. Those fields are outside the write-scope field
    set (`resolveSessionsPatchRequiredScope`,
    `<openclaw>/dist/session-method-scopes-base-CuhU2F_D.mjs` lines
    101-105).
- **Precedence** (`<openclaw>/docs/tools/thinking.md`, "Resolution order"):
  1. message directive;
  2. session override;
  3. bot `thinkingDefault`;
  4. bot per-model `params.thinking`;
  5. shared per-model default;
  6. global `thinkingDefault`;
  7. the provider's default.
- **When a change applies** (`<openclaw>/docs/concepts/model-failover.md`,
  "Live model switching"): a user-driven model change made with
  `sessions.patch` marks a pending live switch. The active run may adopt it
  in the same turn; otherwise the next turn starts from it.
- **Effort a turn ran with**: no complete, supported public per-turn
  actual-effort field was found.
  - Live: history rows carry `provider`, `model`, `usage`, `stopReason`
    and `responseId`, and `lifecycle phase:"model"` carries `{provider,
    model}` (`effort-and-models.mjs`).
  - Internally the transcript records `thinking_level_change` entries
    (`<openclaw>/dist/sdk-DoZOl8zm.mjs` lines 89-93 and 174-191). They are
    not a complete public per-turn API.
  - A client can store the `chat.send.thinking` it sent and label it
    "requested".
- **Models and what they support** (live): `models.list {agentId,
  includeDetails:true}` returns `{id, name, provider, contextWindow, local,
  input, reasoning, tags, thinkingLevels[{id, label}], thinkingDefault,
  available}`.
- **Plugin at a lower scope** (feasible, not built):
  - Entry points: an ordinary plugin can register a write-scope method with
    `api.registerGatewayMethod`, and change config with
    `api.runtime.config.mutateConfigFile` and a `baseHash`
    (`<openclaw>/dist/config-contracts-C65kIjn4.d.ts` line 44653).
  - It must:
    - validate the model and level against the bot's current
      `models.list` and the operator's allowed selection;
    - refuse provider, auth, runtime, fallback and any other config path;
    - keep the revision check.

#### Tool permissions and approvals

- **Default review (`exec.mode: "auto"`)**:
  - Live, with a scripted reviewer (`exec-auto-review.mjs`, allow and deny
    verdicts only):
    - `agent stream:"tool"` emits `{phase:"review", name:"exec", toolCallId,
      approvalReviewOutcome:"reviewing", review:{id:"guardian:<toolCallId>",
      label:"Guardian", status:"in_progress"}}`;
    - then `approvalReviewOutcome` is `approved` or `denied`, with
      `review.riskLevel` and `review.rationale`;
    - the result has `details.approvalReviewOutcome`, and its text starts
      "Exec auto-review allowed once (risk=low): …" or "Exec denied by
      auto-review (risk=high): …".
  - From source, not exercised:
    - an `ask` verdict or a reviewer failure becomes an ordinary
      `exec.approval.requested`;
    - three denials in a row in one session escalate to a human;
    - without a reviewer model, the default reviewer asks
      (`<openclaw>/dist/exec-auto-review-BFvTJS5y.mjs`;
      `<openclaw>/dist/bash-tools-Cig8cES0.mjs` lines 490-525;
      `<openclaw>/dist/exec-auto-reviewer-C7ldeGpx.mjs` lines 61-215).
  - Settings: `tools.exec.reviewer.{model, thinking, fastMode, timeoutMs}`
    (`<openclaw>/docs/tools/exec.md`).
  - No generic native reviewer for other tools was found. The only other
    reviewed request kind is a dashboard widget capability (`requestKind`
    in `exec-auto-reviewer-C7ldeGpx.mjs`). For other tools, "ask" is a
    plugin `before_tool_call` returning `requireApproval` (P5).
- **What a card shows**: an interactive gateway exec request carries
  `request.command`, `commandArgv?`, `cwd`, `host`, `nodeId`, `agentId`,
  `security`, `ask`, `warningText` and `commandAnalysis {commandCount,
  nestedCommandCount, riskKinds[], warningLines[]}`
  (`<openclaw>/dist/bash-tools.exec-approval-request-DeVkQIN2.mjs` lines
  94-105; schema `ExecApprovalRequestParams`).
  - `commandText` belongs to an optional `systemRunPlan`, to the
    `session.approval` presentation, and to stored allowlist entries; it
    is not a root request field.
  - Each request states the decisions it offers (`allowedDecisions` /
    `unavailableDecisions`), and only those are accepted.
- **`allow-always` is conditional and per execution host**
  (`<openclaw>/docs/tools/exec-approvals.md` lines 244, 286 and 501-533;
  `<openclaw>/dist/src-BSx5Woe0.mjs` lines 4515-4626):
  - It is offered only when the request allows it. Inline-eval and
    unbindable command forms do not get a reusable rule.
  - For a gateway-host command, it writes an allowlist entry under
    `agents.<agentId>.allowlist` in the gateway's approvals document.
    - The entry is bound to that bot, the exact argv (`argPattern`) and
      the working directory.
    - Entry fields: `id`, `pattern`, `argPattern`,
      `source:"allow-always"`, `lastUsedAt`, `lastResolvedPath`. No grant
      time is stored (search: the allowlist entry schema).
  - Read and edit the rules with `exec.approvals.get`/`set`; for a node
    host, its own policy is `exec.approvals.node.get`/`set`. All four are
    **`operator.admin`**: no `exec.*` method below admin reads or writes
    rules.
  - Rules shared by all bots go in `file.agents["*"].allowlist`.
    `defaults` holds only `security`, `ask`, `askFallback` and
    `autoAllowSkills` (`<openclaw>/dist/exec-approvals-resolver-DmLXnc-C.mjs`
    lines 7-12; `<openclaw>/dist/src-BSx5Woe0.mjs` lines 4442-4447).
  - An effective `ask:"always"` still prompts despite a saved rule.
  - Codex MCP calls write `agents.<agentId>.mcpTools[{server, tool, source,
    addedAt}]`. Plugin approvals are durable only if the plugin implements
    it.
- **Standing grants: two kinds.**
  - **Routine (cron) grants**: an `allow-always` on an approval raised by a
    cron run mints a grant. It is bound to the bot, the job and its
    definition, and the exact command, working directory and environment.
    - `exec.approval.grants.list {limit?≤500}` (`operator.approvals`)
      returns `{grantId, mintedByApprovalId, agentId, cronJobId,
      cronJobName, command, cwd, createdAtMs, expiresAtMs|null,
      revokedAtMs|null, revokedBy|null, lastUsedAtMs|null, useCount}`.
    - `exec.approval.grants.revoke {grantId}` returns `revoked`,
      `already-revoked` or `not-found`. These two methods expose this
      ledger only.
    - Duration: `grantExpiresInDays` on `approval.resolve`/
      `exec.approval.resolve` is an integer, 1-3650 days (`schema`).
      Omitted, it uses `tools.exec.grantExpiryDays` or no expiry. A
      sub-day value is not accepted.
    - Live (`routines.mjs`, row 21): mint, list, reuse on the next run,
      revoke.
  - **Placement-scoped grants** for eligible high-risk plugin node
    commands: an `allow-always` can retain a grant bound to the plugin,
    command, approval scope, agent, session, node pairing generation and
    active remote-exec placement.
    - It lasts at most 30 days (`PLACEMENT_GRANT_TTL_MS = 2592e6`,
      `<openclaw>/dist/server-aux-handlers-Bbmano5U.mjs` line 1693;
      lines 1374-1419 and 1693-1760).
    - It is invalidated on placement, pairing, runtime or approval
      changes (`<openclaw>/dist/node-invoke-plugin-policy-BrRmTyKE.mjs`
      lines 114-145 and 485-501).
    - No listing or revocation method for these grants was found (search:
      `exec.*` and `approval.*` methods).
    - Source only.
- **Rules expressible with the gateway's own config** (all
  **`operator.admin`**; lower path checked: none in the list above):
  - allow and deny per bot: `agents.entries.<id>.tools.{profile, allow,
    alsoAllow, deny}`;
  - ask, for exec only: `tools.exec.mode` `ask` or `auto`, plus the
    host allowlists;
  - outbound bot messaging per bot:
    `agents.entries.<id>.tools.agentToAgent.send`. The top-level
    `tools.agentToAgent` accepts only `enabled` and `allow`
    (`<openclaw>/dist/zod-schema.agent-runtime-iDxKMLd-.mjs` lines 586-591
    and 640-651).
- **Tool action log**: `audit.activity.list {kind:"tool_action", agentId?,
  sessionKey?, runId?, status?, …}`, `audit.list` and `audit.run.inspect`
  (all `operator.read`; source, not called live).
  - The recorder persists `tool.action.started` and `tool.action.finished`
    records whether or not an approval was involved
    (`<openclaw>/dist/audit-recorder-BuwLkiwR.mjs` lines 131-199).
  - Each record (`schema` `AuditActivityToolActionV1`) carries `eventId`,
    `occurredAt`, `actor`, `agentId`, `sessionKey?`, `runId`,
    `toolCallId?`, `toolName?`, `action`, `status` and
    `redaction:"metadata_only"`.
  - `audit.run.inspect` adds available decision evidence and its coverage.
  - These records do not by themselves say which global, bot, grant or
    default-review rule allowed each action.
- **What locks a rule** (`<openclaw>/docs/tools/exec-approvals.md` lines
  24-36; `<openclaw>/docs/gateway/permission-modes.md`, "Policy
  precedence"):
  - the effective policy is the stricter of `tools.exec.*` and the
    execution host's approvals document, which can only tighten;
  - a host-local `ask:"always"` keeps prompting;
  - a session `permissionMode:"full"` (admin) is the exception to the
    approvals-file floors **on the gateway host only**. A node still
    enforces its own policy: an unmatched allowlist/off command can be
    denied, and node `ask:"always"` still prompts;
  - `/exec` per-turn overrides can only tighten.
- **Smallest scopes**:
  - resolving cards, cron grants and history: `operator.approvals`;
  - session `permissionMode` other than `full`: `operator.write`;
  - per-bot rules, `exec.approvals.*`, `exec.approvals.node.*` and
    `permissionMode:"full"`: **`operator.admin`**. For `full`, the patch
    scope function makes it admin (`session-method-scopes-base` line 103).
- **Plugin at a lower scope** (feasible, not built): a write-scope method
  (`api.registerGatewayMethod`) using `api.runtime.config.mutateConfigFile`
  could add per-bot restrictions. It must:
  - compare against the current effective policy inside the guarded
    mutation;
  - accept only additive denies and stricter modes. Replacing a deny or
    allowlist with `ask` can loosen policy.

  A config change does not by itself cancel pending approvals.

#### Memory

- **Recommendation**: new clients should send `memory.search {version:2}`,
  keep each hit's complete `reference` as an opaque value, and pass it
  unchanged to `memory.get`. Treat the default (v1) response as a
  compatibility branch for the built-in backend only. `memory.get` needs
  the reference shape, not a `version` field.
- **`memory.search` has two response versions**
  (`<openclaw>/dist/memory-search-CKxnFvV7.mjs` lines 34-140;
  `<openclaw>/dist/memory-provider-DcxG9TJs.mjs` lines 33-66 and 145-160).
  All three methods are `operator.read`.
  - **Default** (no `version`, or `version:1`): `{agentId, provider,
    searchMode, results, …staleness, warning?}`. `results` are the
    built-in backend's hits, `{path, startLine, endLine, score,
    textScore, snippet, source:"memory"|"sessions", provenance?}`. Live,
    `provenance` held `{originClass, sessionKind, observedAt}`
    (`memory-save-search.mjs`).
    - This path refuses provider-runtime memory plugins, with "retry
      memory.search with version: 2".
    - The `provenance` fields come from the built-in backend and are not
      a stable cross-provider contract.
  - **`version:2`**: `{version:2, agentId, providerId, hits, nextCursor?,
    coverage, warning?}`.
    - Each hit is `{reference:{providerId, id, revision?, fragment?},
      excerpt, score?, source, citations, automaticRecall?}`.
    - Line numbers appear only inside `citations`, and `reference.id` is
      opaque (a path only for the built-in adapter;
      `<openclaw>/dist/memory-runtime-CH6-OvYH.mjs` lines 146-192).
    - `cursor` works only where the provider paginates.
  - Params: `{agentId, query, maxResults? (≤50, default 20), minScore?,
    cursor?, sources?, version?}`.
- **`memory.get {agentId, reference, from?, lines?}`** needs a v2
  `reference`.
- **`memory.status {agentId}`** always returns the v2 envelope:
  `{version:2, agentId, providerId, status:"ready"|"degraded"|
  "unavailable", message?, details?}`.
  - Implementation detail is optional. Live, the built-in backend put it
    under `details.legacy`, with `dirty`, file and chunk counts, and an
    embedding `cache.maxEntries` of 50 000. That is a cache limit, not a
    memory capacity.
- **Where an item came from**: search names a file or reference, not the
  bot run or chat that wrote it. Session lineage exists only for
  automatically ingested memories and is used by the CLI `openclaw memory
  forget` (`<openclaw>/docs/concepts/memory-provenance.md`).
- **Shared memory**: no provider-neutral shared-memory inventory RPC was
  found; `memory.*` has only the three methods, all keyed by `agentId`.
  - Each bot searches its own memory (live: Pixel's search did not find
    Atlas's note).
  - Sharing is a common folder in `memory.search.extraPaths` (config,
    **`operator.admin`**; no lower path in the list above)
    (`<openclaw>/docs/concepts/multi-agent.md`).
- **Pinning**: no pin method or pinned-item field was found. The only
  method names containing "pin" are `skills.curator.pin/unpin`, which pin
  skills. Memory is Markdown: `MEMORY.md` plus `memory/*.md`, injected
  under the bootstrap limits.
- **The bot saving a memory by itself**: no memory-save event was found in
  the advertised event list.
  - Live: the bot's `write` to `MEMORY.md` and `memory/<date>.md` emitted
    ordinary `tool` events with `args.path`.
  - Watching file-tool results catches only writes through those tools.
- **Reindex**: no reindex method was found (`memory.*` has three methods).
  The default search response named the CLI rebuild (`openclaw memory
  status --index --agent <id>`).
- **Plugin at a lower scope**:
  - P2 covers edit and delete.
  - A reindex method is **unverified**. The public plugin runtime has no
    generic memory-reindex call, and a provider's refresh belongs to the
    memory provider. A plugin would need an owner-supported refresh
    adapter, or a controlled CLI invocation for the gateway's own profile,
    with admission and cancellation.

#### Machine choice

- **Per task, on a paired device: `operator.write`.**
  - `sessions.dispatch {key, deviceId}` or `{key, autoDevice:true}`, and
    `sessions.move` with a device target, are write-scoped.
    `sessions.dispatch` with `profileId` (a cloud worker profile) and
    `sessions.move` to a profile are admin
    (`resolveDynamicSessionMutationRequiredScope`,
    `<openclaw>/dist/method-scopes-BdXzw-yD.mjs` lines 13-19; schema
    `SessionsDispatchParams`, `SessionsMoveParams`).
  - Conditions (`<openclaw>/dist/sessions-dispatch-C5D4yJ51.mjs` lines
    215-300; `<openclaw>/dist/placement-session-runtime-CB5fjWJK.mjs`
    lines 17-31):
    - the session's runtime must declare placement support. The built-in
      `openclaw` runtime declares `worker-turn` with device placement, and
      other harnesses declare it through `cloudPlacement`;
    - the device must be a paired node that hosts sessions (`sessionHost`,
      from `openclaw node run --session-host`), pass the device
      eligibility check, and have capacity. `autoDevice` picks among
      eligible hosts;
    - archived sessions are refused.
  - This moves the whole task's execution to the device, with its own
    remote workspace. It was not exercised live: the fixtures were not
    session hosts.
- **Per task, exec routing only: `operator.admin`.** `sessions.patch
  {execHost:"node", execNode}` and `sessions.create {execNode}` route only
  exec calls, and both are admin.
  - Live (`node-routed-exec.mjs`): the write device was refused, "missing
    scope: operator.admin".
  - With admin, an exec in that task ran on the node.
- **Per bot**: `agents.entries.<id>.tools.exec.{host, node}` through
  `config.patch` (**`operator.admin`**; no lower path in the list above).
- **What a node must declare**: `system.run` (and `system.run.prepare`,
  `system.which`) for exec routing. A device placement runtime can require
  further `requiredNodeCommands`. Commands that pair only with admin are
  in row 13.
- **Working directory on a node**: with no explicit `workdir` and no
  session `execCwd`, the node uses its own default. Live, `pwd` printed the
  node host process's directory. An explicit `workdir` or session cwd is
  passed through (`resolveExecWorkdir`,
  `<openclaw>/dist/bash-tools-Cig8cES0.mjs` lines 2548-2558;
  `<openclaw>/dist/sessions-patch-DIr6Po0r.mjs` lines 98-106). So a node can
  run in a chosen per-bot or per-task folder.
- **Isolation between bots on one machine**:
  - A workspace directory is the bot's default working directory, not an
    OS sandbox for processes.
  - OpenClaw's own file tools are confined to the session root in the
    `read-only`, `guarded` and `workspace` permission modes, without a
    container. `full` lifts that, while required roots and sandbox
    restrictions still apply (`<openclaw>/docs/gateway/permission-modes.md`
    lines 14-21).
  - Shell `exec` has its own, broader authority under exec policy.
  - Browser profiles are global (`browser.defaultProfile`). No per-agent
    browser-profile config key was found (search: the agent config
    schema in `zod-schema.agent-runtime-iDxKMLd-.mjs`); P4 enforces per-bot
    profiles (row 18).
- **Plugin at a lower scope**: prefer the native write-scope placement
  above. A plugin that pins exec routing at write would use
  `api.runtime.agent.session.patchSessionEntry`
  (`config-contracts-C65kIjn4.d.ts` line 44713) from a method declared
  with `sessionAccess:{mode:"write"}`. It must:
  - bind the exact agent, session id and lifecycle;
  - check the exact allowed (bot, node) pair;
  - clear a stale cwd when the node changes;
  - recheck pairing and approval when publishing.

#### Usage

- **By bot**: `usage.cost {agentId}` and `sessions.usage {agentId}`
  `aggregates.byAgent`. **By task**: `sessions.usage {key}`. All
  `operator.read`.
  - `sessions.usage` rows carry a nested `usage` object with `totalCost`
    and token totals, or `usage:null` with `computing:true`
    (`<openclaw>/dist/usage-DNHtJAIp.mjs` lines 1102-1124).
  - `sessions.list` rows carry `estimatedCostUsd` instead.
- **By source**: `sessions.usage` `aggregates` has `byModel`,
  `byProvider`, `byAgent`, `byChannel` and `byCreator` (live keys).
  - No grouping by routine was found in that rollup. Derive it from
    session keys (`…:cron:…`) or from `cron.runs` usage (row 21).
  - `byCreator` can name an agent that created a session, but not every
    bot that later sent into an existing session. Inter-session provenance
    (row 19) marks those turns.
- **Currency**: estimated **USD**, from `models.providers.<p>.models[].cost`
  in USD per 1M tokens (`<openclaw>/docs/reference/token-use.md`, "Cost
  estimation").
  - Totals: `{input, output, cacheRead, cacheWrite, totalTokens, totalCost,
    inputCost, outputCost, cacheReadCost, cacheWriteCost,
    missingCostEntries}` (live keys).
- **Context window**: row 15.
- **Provider limits**: `usage.status` →
  `providers[].windows[{label, usedPercent, resetAt?}]`, plus balances and
  budgets where the provider reports them
  (`<openclaw>/dist/provider-usage.fetch.claude-Dhz9Brye.mjs` lines 14-57).
  Live: `{providers:[]}` with the fake provider.
- **Budgets and cutoffs**: no user-defined budget store or token-budget
  admission control was found (search: method and definition names
  containing "budget" in the schema; provider-reported budgets are a
  different thing).
  - A client can count tokens per period from `sessions.usage` and
    `sessions.usage.timeseries`/`logs`, taking one latest total per
    session or using deltas.
  - It can refuse its own new `chat.send` calls at the limit, and pause a
    routine with `cron.update {patch:{enabled:false}}`
    (**`operator.admin`**).
  - `chat.abort` stops a run; it is not admission control.
  - Other clients and channels are not bound by a client-side budget.

#### Creating, duplicating, importing, exporting and deleting a bot

- **Create**: `agents.create`, then `config.patch` and `agents.files.set`
  (all **`operator.admin`**, row 3; no non-admin `agents.*` writer exists
  in the list above). Not atomic.
- **Duplicate and import over RPC**: no method was found (search: the
  `agents.*` and `claws.*` method names).
- **Export**: no export RPC was found. The experimental CLI has `openclaw
  claws export <agent> --out <path>`, a portable package, and a matching
  install (`<openclaw>/docs/cli/claws.md`). Over RPC, an export can be
  assembled at `operator.read` from `config.get` (secrets redacted),
  `agents.files.get` and `agents.workspace.get`.
- **Delete**: `agents.delete {agentId, deleteFiles?=true}`
  (**`operator.admin`**). It journals the cleanup
  (`<openclaw>/dist/agents-DAPW-UCQ.mjs` lines 810-1048):
  - always: the config entry and the bot's bindings, its cron jobs and
    exec-approval entries (line 874), and its session-store entries. The
    purge at line 927 runs whether or not `deleteFiles` is set, so "keep
    files" does not keep sessions usable;
  - with `deleteFiles`: an attempt to move the workspace (including
    memory), agent directory and session files to the Trash;
  - paths shared with a surviving bot are kept, and protected shared or
    inherited store owners are refused;
  - the reply is `{ok:true, removedBindings, removed[], failed[],
    purgeFailed?}`. An `ok` reply can still report failures, and the
    journal is kept for a retry. Show `failed[]` and `purgeFailed`.
  - No atomic preview was found. A best-effort preview reads
    `agents.workspace.list` (paged), `sessions.list {agentId}` and
    `cron.list {includeDisabled:true}` (`operator.read`).
- **Plugin at a lower scope** (feasible, not built): create-from-template
  through a write-scope plugin method and `mutateConfigFile`. It must:
  - reserve and validate the agent id;
  - allocate a fresh owned workspace and agent directory, never an
    existing host path;
  - enforce the fixed model and tool template and the creator's
    authority;
  - handle partial setup.

  Delete should stay admin.

### 21. Routines, notifications, skills, connectors, secrets, voice and the client as a node

Markings as in rows 19 and 20: **live** means a committed scenario in
`docs/research/dev-gateway/scenarios/` reproduces it (named in brackets);
**source** names the code or docs path; **unverified** says what was tried.
A failed probe is evidence about that probe, not about the version. Each
absence names its search. Each `operator.admin` claim was checked against
the non-admin method inventory at the top of row 20.

The scenarios are observational scripts against the scripted fake gateway,
not passing parity checks. They do not show real delivery, OS permission
prompts, APNs decryption, real-provider voice, or completed external side
effects.

#### Routines

- **Methods and scopes** (`schema` method map; row 9):
  - reads, all `operator.read`: `cron.list`, `cron.get`, `cron.status`,
    `cron.runs`, `cron.history`;
  - writes, all **`operator.admin`**: `cron.add`, `cron.update {id,
    patch}`, `cron.remove`, `cron.run`. Lower path checked: every non-admin
    `cron.*` method is a read. The bot's own `automations` tool (below)
    acts with the bot's authority, not the client's.
  - Pause and resume is `cron.update {patch:{enabled}}`.
  - Plugin at a lower scope (**unverified proposal**): pause, resume and
    run-now of existing jobs at `operator.write`.
    - Entry point: a method registered with `api.registerGatewayMethod`
      receives handler options whose context includes the serving cron
      service (`<openclaw>/dist/registry-Ctt4xQAS.mjs` line 1650;
      `GatewayCronServiceContract`, `config-contracts-C65kIjn4.d.ts` line
      53941).
    - It must update through `updateWithPrecondition`, with a check on the
      current job and revision (line 13395), not on a job id taken from the
      client alone.
    - It must check the caller's current session or bot authority over that
      job.
    - It must refuse payload and schedule edits.

    This relies on host context rather than a stable SDK facility, so it
    must be proven before use. Creating jobs should stay admin, because a
    payload runs tools unattended.
- **The bot's own tool**: the `automations` tool (legacy name `cron`, in the
  `coding` profile; `<openclaw>/dist/cron-tool-B3cH3Sr5.mjs` lines
  1318-1340).
  - Turns that are not an authenticated channel owner or Control UI
    administrator see and manage only caller-visible jobs (same file, line
    1288).
- **The `cron` event** (`operator.read`, scoped to the job's owner or target
  session; `<openclaw>/dist/server-cron-CyxgB4A1.mjs` lines 3455-3470) is
  `{jobId, action, job?, …}` (live, `routines.mjs`, `routine-history.mjs`):
  - `added` and `updated`, with `job` and `nextRunAtMs`;
  - `started {runAtMs}`;
  - `finished {status: ok|error|skipped, completionStatus: succeeded|failed|unknown,
    error?, diagnostics?, summary, delivered, deliveryStatus, delivery,
    sessionId, sessionKey, runId, runAtMs, durationMs, nextRunAtMs, model,
    provider, usage}`;
  - `removed`.

  A run in progress lies between `started` and `finished`, and the job's
  `state.runningAtMs` is set.
- **Run now**: `cron.run {id, mode:"force"}` returns at once with `{ok,
  enqueued:true, runId:"manual:<jobId>:<ms>:<n>"}` (live). If the run
  finished within `waitTimeoutMs`, `run` holds the finished entry.
- **Refused runs** (live, `routines.mjs`): `cron.run` answers `{ok:true,
  ran:false, reason}`:
  - `already-running` while a run is active (single-flight);
  - `disabled` for `mode:"if-enabled"` on a paused job;
  - `not-due` for `mode:"due"`.

  Pausing a job that has a run waiting ends that run, `finished
  {status:"error", error:"Cron job disabled by operator."}` (observed in
  the first probe).
- **The session a run uses** (live): an isolated run gets its own session
  `agent:<agentId>:cron:<jobId>:run:<sessionId>`.
  - That key is the marker for activity a routine triggered. Its `agent` and
    `chat` events carry it in `sessionKey`.
  - No event field names the trigger. The search for one covered the
    `agent` event's top-level keys on a cron run: `runId`, `sessionKey`,
    `sessionId`, `agentId`, `stream`, `data`, `seq`, `ts` (live,
    `routine-history.mjs`).
  - The run session is not a `sessions.list` row, and `chat.history` on
    its key returned no rows (live).
  - Read a run's transcript with `cron.history {id, runAtMs|runId}`
    (`operator.read`). It returns `{messages, activity?}`, and the run
    started with the scheduler's unattended-run instructions (live).
- **Run log**: `cron.runs {id, limit?, offset?, statuses?}` entries carry
  `status`, `completionStatus`, `error`, `summary`, `runId`, `diagnostics`,
  `runAtMs`, `durationMs`, `nextRunAtMs`, `model`, `provider`, `usage
  {input_tokens, output_tokens, total_tokens}`, delivery fields,
  `sessionId`, `sessionKey` and `jobName` (live). That is per-run usage.
- **Next run and time zones**: `job.state.nextRunAtMs` and
  `cron.status.nextWakeAtMs` (live: a `0 9 * * *` job with `tz:
  "Europe/Paris"` gave 08:00 UTC).
  - `tz` is an IANA name and applies to `cron` expressions and to `at`
    times without an offset.
  - A cron expression without `tz` uses the gateway host's time zone. An
    `at` time without an offset is UTC.
  - Top-of-hour expressions are staggered by up to 5 minutes unless
    `staggerMs` is set (`<openclaw>/docs/automation/cron-jobs/schedules.md`).
- **Retention and limits** (source,
  `<openclaw>/docs/automation/cron-jobs/managing-jobs.md` "Maintenance";
  `how-it-works.md`):
  - isolated run sessions are pruned after `cron.sessionRetention`
    (default 24 h);
  - run history is kept 7 days, at most 2 000 rows per job;
  - one-shot jobs delete themselves after a successful run;
  - recurring errors back off 30 s, 1 min, 5 min, 15 min, then 60 min;
  - `cron.skipMissedJobs` skips slots missed while the gateway was down.
- **Delivery**: the default delivery announces to a channel. With no
  channel configured, the run's model work completed, but the run ended
  `status:"error"`, "Channel is required (no configured channels
  detected)…" (live).
  - That observation is not a general rule. The documented contract keeps
    payload execution in `status` and whole-run completion in
    `completionStatus`. A delivery-only failure can leave `status:"ok"`
    with `completionStatus:"failed"`, unless `delivery.bestEffort` is set
    (`<openclaw>/docs/automation/cron-jobs/managing-jobs.md` line 153).
  - Read both fields. Use `delivery:{mode:"none"}` to keep results in
  history only (live, `routine-history.mjs`).
- **Approvals from a routine** (live, `routines.mjs`):
  - The run raised an ordinary `exec.approval.requested` in its run
    session, with `request.scope = {kind:"standing-grant", automation,
    command}` and decisions `allow-once`, `allow-always` and `deny`.
  - `allow-always` with `grantExpiresInDays:1` minted a standing grant
    (`exec.approval.grants.list`: `cronJobId`, `cronJobName`, `command`,
    `cwd`, `createdAtMs`, `expiresAtMs` one day later, `useCount`).
  - The next forced run executed the same command without asking.
  - With no approval-capable client connected, the request is denied at
    once (`<openclaw>/docs/tools/exec-approvals.md`, "Standing grants for
    automations").
- **Other triggers** (source; the `CronJob` schema has no webhook field,
  and its `trigger` is `{script, once?}`):
  - schedule kinds `at`, `every`, `cron`, `on-exit` (a watched command
    exits) and `stream` (lines from a supervised command);
  - `trigger.script`, a condition gate run when the schedule is due;
  - `pacing.min`/`max`, a bounded dynamic cadence
    (`<openclaw>/docs/automation/cron-jobs/schedules.md`).
  - **Inbound webhooks** exist, but not as routine triggers. `POST
    <hooks.path>/agent` and `/wake` start an agent turn or a wake (HTTP
    200 `{ok, runId}`).
    - They are off by default and configured under `hooks.{enabled, token,
      path, allowedAgentIds, mappings, allowRequestSessionKey}` (admin
      config; the docs say to restart the gateway after changing them).
    - They authenticate with a dedicated hook token. A run uses a
      generated `hook:<uuid>` session unless the configuration allows a
      caller-chosen key
      (`<openclaw>/docs/automation/cron-jobs/webhooks.md`).
    - Not exercised live.

#### Notifications and push

- **What the gateway pushes**: Web Push to subscribed endpoints.
  - Categories: `approvalRequested` (on by default), `agentFinished`,
    `agentQuestion`, `humanMentioned` and `scheduledTaskFailed`.
  - Detail level: `private` (default), `identified` or `detailed`. Even
    `detailed` carries only sanitized labels; message text, commands and
    output never enter the payload.
  - Quiet hours `{enabled, startMinute, endMinute, timeZone}`, default off,
    22:00-07:00 UTC. Matching sends are dropped, not queued.
  - An `agentIds` filter.
  - Defaults are in `<openclaw>/dist/push-web-store.records-AJFEBd3j.mjs`
    lines 16-31; behavior in `<openclaw>/docs/web/notifications.md`.
  - Account defaults are stored per user profile under the `users.prefs`
    key `notifications.web.v1`. A per-device layer can mute a device or
    override categories.
- **Who can register**: `push.web.subscribe {endpoint, keys:{p256dh,
  auth}}` (`operator.write`) needs a paired device identity. The endpoint
  must be any `https://` URL under 2 048 characters, with no host allowlist
  (`isValidWebPushEndpoint`, same file line 148).
  - Live (`web-push.mjs`): a non-browser client subscribed with an endpoint
    on a closed loopback port. `push.web.preferences.get {endpoint}`
    returned `{durableIdentity, user, device, effective}`, and unsubscribe
    worked.
  - Sends use standard Web Push encryption to the subscriber's keys
    (`webPush.sendNotification`,
    `<openclaw>/dist/push-web-BDeMIeg_.mjs` line 296).
  - So a Clawtrate service could own an HTTPS endpoint and forward the
    encrypted payload to APNs, for the app to decrypt. That is P3 without a
    gateway plugin. It is **unverified**: no delivery was attempted.
- **Native APNs** stays limited, as row 16 says.
  - The official app registers through a relay with App Attest, as a
    node-role `node.event push.apns.register`.
  - Direct APNs needs the app vendor's signing key in the gateway
    environment (`OPENCLAW_APNS_TEAM_ID`, `OPENCLAW_APNS_KEY_ID`,
    `OPENCLAW_APNS_PRIVATE_KEY_P8`;
    `<openclaw>/docs/platforms/ios.md`, local builds).
  - A self-hoster cannot hold Clawtrate's key. A custom relay is possible
    only as "a deliberately separate custom relay build"
    (`gateway.push.apns.relay.baseUrl`). The gateway also accepts no
    Live Activity push tokens. A search of `dist/` for `liveActivity` and
    `pushToStart` found only two unrelated UI names
    (`sidebarLiveActivity`, a TUI activity schema).
- **Presence**: `system-presence` and `presence.query` (`operator.read`)
  give each connection's `clientId`, `mode`, `platform`, `deviceFamily`,
  `onlineSince`, `lastInputSeconds` and `lastActivityAt` (live). These are
  self-declared at `connect`, which is how a desktop client is told apart
  from a phone.
- **Holding a push while a desktop is active**: does not exist. The event
  push region (`<openclaw>/dist/server-start-D6vaUNGz.mjs` lines
  2612-2775) has no presence or viewer check; a search for presence,
  viewer, online, connected, suppress and skip there found nothing. A
  client-side or P3 rule is needed.
- **What a notification names**: the notification built for an event is
  `{category, title, body, tag, path?}`, for example `path: "ask/<id>"` for
  a question (`resolveEventWebPushNotification`, same file, line 2618
  onward).
  - The encrypted payload actually sent is `{title, body, tag, renotify,
    url}`. Here `url` is the Control UI address for `path`, and the title can
    carry the device's label (`<openclaw>/dist/server-start-D6vaUNGz.mjs`
    lines 2675-2744; sent by `push-web-BDeMIeg_.mjs` line 296).
  - No gateway identifier field was found. The `url` origin can help tell
    gateways apart; mapping each subscription endpoint to its gateway also
    works.

#### Skills

All methods and scopes are from the `schema` method map; live parts are in
`skills-library-and-workshop.mjs`.

- **List and status**:
  - `skills.status {agentId?, sessionKey?}` (`operator.read`) returns
    `{workspaceDir, managedSkillsDir, agentId, skills:[{name, description,
    source, bundled, skillKey, always, disabled, blockedByAllowlist,
    eligible, …}]}` (live).
  - Search and detail: `skills.search`, `skills.detail`, `skills.skillCard`
    (`operator.read`).
- **The user's library** (live):
  - reads, `operator.read` (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs`
    lines 939-949): `skills.library.list {scope: mine|team|all}` and
    `skills.library.read {skillId, revision?}`;
  - writes, `operator.write`: `skills.library.save {skillId?,
    expectedRevision|null, slug, content, files?}` returns
    `{state:"published", target:"personal", entry:{skillId, slug, revision,
    enabled, shared, …}}`;
  - `skills.library.mutate {skillId, expectedRevision, action: share |
    unshare | transfer | remove | enable | disable | rollback}`. Live:
    `disable` set `enabled:false`, and `remove` returned `state:"removed"`.
  - Every write is a compare-and-set on the 64-hex `revision`.
  - `skills.library.activate {sessionKey, action: attach|detach|refresh,
    skillId?, revision?}` changes one task's selections.
  - A task pins skill revisions. Publishing a new revision does not change
    an existing session's selection. `activate` with `refresh` (or attach)
    updates it and returns `sessionActivation:"next-turn"`
    (`<openclaw>/dist/skills-library-f1x0CvB1.mjs` lines 274-291). New
    sessions start from the current selections.
- **Per bot**: `agents.entries.<id>.skills` is an allowlist; `[]` means no
  skills (`<openclaw>/docs/tools/skills-config.md`, config, **admin**).
  - Global enablement of an installed skill is `skills.update {skillKey,
    enabled}`, also **`operator.admin`**.
  - Lower path checked: `skills.library.mutate {action:"enable"|"disable"}`
    (`operator.write`) switches the user's **library** skills, not
    installed or per-bot skills. `skills.library.activate` attaches one to a
    single task.
  - Plugin at a lower scope (**unverified proposal**): a per-bot skill
    switch at `operator.write` would use `api.registerGatewayMethod` and
    `api.runtime.config.mutateConfigFile` with `baseHash` and `afterWrite`
    (`<openclaw>/dist/config-contracts-C65kIjn4.d.ts` line 44646). It must:
    - check the caller's current authenticated access to that bot or
      session (`registry-runtime-session-ownership-Ce5YcIfj.mjs` line 80);
    - accept only skills from an admin-approved set;
    - write only `agents.entries.<id>.skills`.

    A caller-supplied bot id or path is not authorization, and the plugin
    must never install or enable skill code.
- **Where skills live**:
  - bundled skills under the package;
  - managed skills (`managedSkillsDir`);
  - the bot's workspace;
  - the bot's own learned skills under
    `<agentDir>/workshop-skills/<name>/SKILL.md`, with the newest 10
    versions kept;
  - the library in the state database
  (`<openclaw>/docs/tools/skill-workshop.md`, "Where files live").
- **A bot creating or editing a skill ("teach a task")**: `/learn
  [request]` asks the bot to save the current workflow with its
  `skill_workshop` tool (`coding` profile). That tool has **two
  contracts**, chosen per run (`<openclaw>/dist/openclaw-tools-DV-z1IAc.mjs`
  lines 14127-14139):
  - **Personal library** (`SkillLibraryWorkshopSchema`, same file lines
    13747-13790, implemented at 13794-13830): actions `list`, `read`,
    `create`, `update`, `share`, `unshare`, `transfer`, `activate`,
    `remove`, `rollback`, with `name`, `skill_id`, `expected_revision`,
    `proposal_content`, `files`, `delete_files`.
    - Results are library entries, and changes show in
      `skills.library.list`, not in the workshop change feed.
    - The library target is `personal` when the actor has a profile and
      either several profiles exist or the actor is not admin. It is
      `workspace` for the admin case
      (`<openclaw>/dist/state/openclaw-state-read.worker.js` lines
      113661-113667).
    - Authoring is bound to ordinary attributed human turns
      (`<openclaw>/dist/skill-library-authoring-jJOx1dv3.mjs` line 557).
  - **Learned workshop** (`SkillWorkshopToolSchema`, lines 13918-13936):
    `create`, `patch`, `write_file`, `remove_file`, `archive`, `restore`,
    with `content`, `old_text`, `new_text`.
    - Offered when there is no library authoring for the run. When the
      library target is `workspace`, the workshop is offered alongside it
      and selected by omitting `target`.
    - Changes show in `skills.workshop.changes`.
  - Background review can also save skills, and a change posts "💾 Learned:
    updated `<name>` (…). Say "undo"…" into the conversation.
  - The change feed is `skills.workshop.changes {agentId, limit?, beforeMs?}`
    (`operator.read`); `skills.workshop.list` and `read` are
    `operator.read`; `archive` and `restore` are **`operator.admin`** (live:
    "missing scope: operator.admin" at write). Lower path checked: no
    non-admin `skills.workshop.*` writer exists.
  - `skills.changed {reason}` is broadcast about 30 s after a skills-folder
    change (`<openclaw>/dist/server-startup-early-BquJMfnW.mjs` lines
    40-58).
  - Live (`skills-library-and-workshop.mjs`): on the probe's non-admin
    profile the run got the personal-library contract.
    - `{action:"create", name, proposal_content}` published a library entry
      (`state:"published"`, `target:"personal"`).
    - The workshop-style `{action:"create", name, content}` was rejected
      ("content: schema is false"). That is the source behavior, not a
      failure.
    - Learned-workshop creation was not exercised.
- **Delete**: library `mutate {action:"remove"}` (`operator.write`, live).
  Workshop skills are archived, not deleted.

#### Connectors and MCP servers

- **Catalog**: plugins, which is how most connectors ship, have a
  categorized catalog at `operator.read` (source; not called live, because
  it queries ClawHub, an outside service):
  - `plugins.catalog.categories {}` returns `{categories:[{slug, label,
    description, icon, order, pinnedPackages?}]}`;
  - `plugins.catalog.browse {query?, intent?: all|bundled|trending|official|
    featured, category?, cursor?, pageSize?≤100}` returns items with
    `catalog {name, summary, author, official, categories, icon, …}` and
    `local {present, installed, enabled, state, pluginId?, install?}`;
  - `plugins.catalog.get {id, version?}` returns details;
  - `plugins.list` gives the installed inventory
    (`<openclaw>/docs/gateway/protocol/rpc-system-and-channels.md` lines
    95-99; `schema` `PluginsCatalog*`).

  Installing is `plugins.install` (**`operator.admin`**). Lower path
  checked: no non-admin method installs, enables or uninstalls a plugin.
  This holds for installation only, not every plugin write:
  `plugins.sessionAction` is dynamic, taking a registered action's
  declared scopes or `operator.write` by default
  (`<openclaw>/dist/method-scopes-BdXzw-yD.mjs` lines 66-90). Raw MCP servers are not in that catalog, and
  `tools.catalog` does not list them (live: no `coder` entry). Configured
  servers are in `config.get` `mcp.servers` (`operator.read`, secrets
  redacted). `mcp.app.*` covers interactive MCP Apps.
- **Adding a server** (lower path checked: no non-admin method writes
  `mcp.servers`): `config.patch` on `mcp.servers.<name>` with
  `{command, args, env?, cwd?}` for a command server, or `{url, transport,
  headers?, auth?:"oauth"}` for a remote one (**`operator.admin`**;
  `<openclaw>/docs/cli/mcp/transports.md`).
  - Live (`mcp-servers.mjs`): a second command server added by
    `config.patch` was callable on the next turn without a restart, as
    `coder2__list_threads`.
  - Removing one whose `args` would shrink needs `replacePaths`.
  - Plugin at a lower scope: not advisable. A command server runs an
    arbitrary program on the host; a remote-URL-only allowlist plugin would
    have to enforce HTTPS, an admin-set host allowlist, and no stdio.
- **Auth state and accounts**:
  - For a raw MCP server in `mcp.servers`, no method reporting sign-in
    state or accounts was found. The search covered every `mcp.*` method
    (only `mcp.app.*` and `mcp.authLogin` exist). Tokens live in the state
    database (`mcp_oauth_stores`). An unsigned server is left out of the
    bot's tools rather than failing the turn (same doc).
  - Plugin-backed connectors report a coarse state: `plugins.list` and the
    catalog's `local.state` are `enabled`, `disabled`, `needs-setup`,
    `not-installed` or `error` (`operator.read`; `schema`
    `PluginsListResult`). No per-account list was found there.
- **Signing in**: `mcp.authLogin {sessionId, serverName}`
  (**`operator.admin`**, enforced again inside the handler; no non-admin
  sign-in method was found; `<openclaw>/dist/mcp-auth-login-DAnddU_m.mjs`
  lines 16-90).
  - It runs a wizard session that asks the client to open an authorization
    URL; follow the URL the wizard gives. The shared operator flow redirects
    to the gateway's `/oauth/provider/callback`
    (`<openclaw>/dist/provider-browser-auth-BOjjbaDz.mjs` lines 10 and 60;
    `mcp-auth-login-DAnddU_m.mjs` lines 62 and 89-95). The wait limit is
    10 minutes.
  - `/oauth/mcp/callback` belongs to the separate per-requester flow
    below.
  - It requires a connection that came from a browser origin, otherwise:
    "Open Settings on this Gateway to sign in, or use openclaw mcp login in
    its terminal".
  - Live: on the stdio `coder` server it refused with "This connector cannot
    use operator browser sign-in".
  - Per-requester accounts (`oauth.identity:"per-requester"`) send each
    sender a single-use sign-in link through `gateway.publicOrigin`.
  - Not performed: no outside sign-in was attempted.
- **Tools per bot**: `agents.entries.<id>.tools.{allow, deny}` with
  `bundle-mcp`, exact names or globs such as `coder__*`, using the safe
  server prefix (row 19) (**admin**, source:
  `<openclaw>/docs/gateway/config-tools/tool-policy.md`).
- **A bot asking to add a server**: no such tool was found. Tool `name:`
  literals in `dist/` containing "mcp" were searched, and none was found;
  the `coding` profile describes the bot's `gateway` tool as update-only. A bot with `exec` could run `openclaw mcp` commands under exec
  approval.

#### Drafts and secure input

- **Drafts**: no draft object or draft tool exists. No method name and no
  tool `name:` literal in `dist/` contains "draft".
  - Approval decisions are only `allow-once`, `allow-always` and `deny`
    (row 20), so arguments cannot be edited at approval (F-344, F-453).
  - Editable defaults (`defaultAnswers`) are produced only by the agent
    harness's structured input (`<openclaw>/dist/structured-input-BIzCMO3F.mjs`,
    `gateway-question-dispatch-BcIWFUex.mjs`; search: `defaultAnswers` in
    `dist/`).
  - No plugin-SDK entry point for raising a question was found. In
    `dist/plugin-sdk/*.d.ts`, `question-gateway-runtime.d.ts` resolves
    questions from channels and `decisions.d.ts` covers model-scored
    decisions.
  - A plugin could still provide its own draft tool, methods and event
    (plugin API, section 3). **Unverified**.
- **Secrets without the transcript**: the bot's `secrets` tool (`request`,
  `list`, `delete`) asks the user for a credential through a masked
  question card (`isSecret`, `secretStore {name, kind, allowedHosts,
  reason}`).
  - The answer goes to the shared secret store; the bot sees only metadata
    and a SecretRef (`<openclaw>/docs/tools/secrets.md`).
  - **Creating** a secret-store question needs `operator.admin` plus
    trusted live agent-runtime authority. The handler refuses otherwise
    ("secret store questions require an operator.admin client",
    `<openclaw>/dist/question-BTDP13J4.mjs` lines 96-112). The tool
    registers its question with `scopes:[ADMIN_SCOPE]`
    (`openclaw-tools-DV-z1IAc.mjs` lines 10874-10887).
  - The user **answers** with `question.resolve {answers,
    secretStoreAllowedHosts}` (`operator.questions`, plus session
    access).
  - The egress proxy substitutes the secret only in requests to
    `allowedHosts`.
  - Operator store methods: `secrets.store.list`, `set` and `delete`.
  - Operator store methods are **`operator.admin`** (lower path checked:
    no non-admin `secrets.*` method exists; the bot's request is answered
    at `operator.questions`).
  - Live (`secrets-request.mjs`):
    - with the run started from a device holding `operator.admin` and
      `operator.questions`, a masked question arrived (`isSecret:true`,
      `secretStore {name, kind:"secret", allowedHosts, reason}`). The
      probe answered it, and the run finished.
    - The submitted value was absent from every event and from the
      transcript, and the probe deleted its own entry.
    - An earlier run started without `operator.admin` failed with "missing
      scope: operator.questions". That is consistent with the creation
      gate above, though the exact error was not traced.
- **A password vault** of logins, cards and contacts: not found. Method
  names containing `vault`, `password` or `credential` give only
  `plugins.credentials.inspect`; secrets are `secrets.*`.
  - The secret store holds named values limited by host, not per bot.
  - Filling a website form without the bot seeing the value is possible
    only by the user typing during a P4 takeover.
  - Plugin at a lower scope: a per-bot vault plugin would have to keep
    values out of tool results and transcripts, scope entries to bots and
    hosts, and release them only through egress substitution or a
    user-driven fill.

#### Voice

All from source unless marked: `schema` Talk definitions;
`<openclaw>/docs/gateway/protocol/rpc-talk-config-and-agents.md`;
`<openclaw>/docs/nodes/talk.md`.

- **Starting a call**:
  - `talk.session.create` for gateway-owned relay, transcription or
    managed-room sessions;
  - `talk.client.create` for client-owned WebRTC or provider WebSocket.

  Both are `operator.talk`, which `operator.write` satisfies.
- **The bot for a call**: pass its `sessionKey` (live in row 17).
- **Per-call settings.** The two create methods are closed schemas with
  different fields (`schema` `TalkClientCreateParams`,
  `TalkSessionCreateParams`):
  - both take `sessionKey`, `provider`, `model`, `voice`, `vadThreshold`,
    `silenceDurationMs`, `prefixPaddingMs`, `reasoningEffort`, `mode:
    realtime|stt-tts|transcription`, `transport` and `brain:
    agent-consult|direct-tools|none`;
  - only `talk.session.create` takes `language` (two letters) and `ttlMs`
    (1 s to 1 h). `talk.client.create` rejects both, and adds
    `voiceSessionId` and `capabilities`.
  - The host passes `language` to its transcription session branch
    (`<openclaw>/dist/handlers-CjWbukvo.mjs` line 5036), not to every
    realtime route.
  - No method that changes language mid-call was found (talk method list).
    A language change means a new or reconfigured call, under client
    policy.
- **Changing the voice** changes an **active call**; it is not a stored
  default.
  - `talk.voice.set {voice, sessionKey?, voiceSessionId?}` selects exactly
    one active call owned by the caller. With no active call it fails ("No
    active voice call is available").
  - It checks that the call can change voice and that the voice is in the
    call's catalog (`handlers-CjWbukvo.mjs` lines 598-616).
  - For a client-owned call, the gateway sends `talk.voice.change` to that
    connection (line 5307). The client creates the replacement and
    acknowledges readiness with `talk.voice.complete` (line 5313 onward).
  - No per-bot voice setting was found (talk docs; the voice schemas take a
    session or voice session, not an agent). Keep the bot's preferred voice
    in client state or `users.prefs`, and pass it as `voice` when creating
    later calls.
- **Reconnect after a drop**: `talk.client.create` resumes the logical call
  when the client passes the same `voiceSessionId` while replacing the
  provider transport. Accepted work outlives a replaced connection
  (`realtime-sessions.md`). Gateway-relay sessions emit
  `session.replaced`. Not exercised live: no realtime provider is
  configured on the probe.
- **Concurrent calls**: the docs give 8 concurrent sessions per gateway and
  a 30-minute TTL for the GPT-Live route. A general limit was not found.
- **Transcripts and timing**:
  - `talk.event` (`operator.read`) carries `{id, type, sessionId, turnId?,
    seq, timestamp, …, payload}`, with types including
    `transcript.delta/done`, `output.text.*`, `output.audio.*`, `tool.*`,
    `usage.metrics` and `latency.metrics`.
  - Client-owned calls append finalized `{role, text, timestamp?}` items to
    the bot's session with `talk.client.transcript` (idempotent
    `entryId`).
  - Meeting captures: `transcripts.list`, `get`, `export` and `status`
    (`operator.read`), and `transcripts.summarize` (`operator.write`).
  - There are no word timings. A search of the sources for `wordTimings`,
    `word_timestamps` and `wordTimestamps` found nothing. Timing is per
    event only.

#### The client acting as a node

Live, in `client-node.mjs`:
- A client connected with `role:"node"`, `client.id:"node-host"`,
  `mode:"node"`, `platform:"macos"`, `deviceFamily:"Mac"`, `commands`,
  `permissions` and no scopes.
- On loopback it was paired silently.
- The operator called `node.invoke {nodeId, command, params, timeoutMs,
  idempotencyKey}` (`operator.write`). The node received
  `node.invoke.request {id, nodeId, command, paramsJSON, timeoutMs}` and
  answered `node.invoke.result {id, nodeId, ok, payload}`. The operator got
  `{ok, nodeId, command, payload}`.
- A request the node did not answer failed with `UNAVAILABLE` "TIMEOUT:
  node invoke timed out after 2003 ms".

What a client must declare and what that costs:
- **Commands are filtered by platform.**
  - The allowed set is the platform's defaults, plus approved desktop host
    commands, plus `gateway.nodes.commands.allow` (admin config; no
    non-admin `node.*` method changes the allowlist).
    Dangerous commands such as `camera.snap`, `screen.record`, `sms.send`
    and `contacts.add` are left out unless that config allows them
    (`resolveNodeCommandAllowlistInternal`,
    `<openclaw>/dist/node-command-policy-I3ly1VaT.mjs` lines 187-219).
  - Platform defaults (same file, lines 1-118): iOS gets `camera.list`,
    `location.get`, `device.info`, `device.status`, `contacts.search`,
    `calendar.events`, `reminders.list`, `photos.latest`,
    `motion.activity`, `motion.pedometer` and `system.notify`. macOS
    adds `device.apps`, among others.
  - Live: the custom command `clawtrate.app.open` was dropped from the
    pairing and refused, "node command not allowed: "clawtrate.app.open" is
    not in the allowlist for platform "macos"".
  - So opening an app on the device needs an admin config allowlist entry,
    or a gateway plugin registering a node-invoke policy with
    `api.registerNodeInvokePolicy` (`config-contracts-C65kIjn4.d.ts` line
    43155). That policy must still apply the caller, session and node checks
    and platform admission; a node reporting `permissions` replaces none of
    them.
- **Pairing**:
  - Off loopback, a node pairing waits for `node.pair.approve`
    (`operator.pairing`), plus `operator.write` when commands are declared,
    plus **`operator.admin`** for the system, browser and file commands
    (row 13).
  - Each new command surface needs a new approval (row 20, live).
- **Timeouts and progress**:
  - The caller's `timeoutMs` reaches the node, and an ordinary operator gets
    only the final `node.invoke` result.
  - `node.invoke.progress` is a **node-to-gateway** RPC. It is accepted
    only when a progress consumer is registered for that invoke;
    otherwise it is ignored (`<openclaw>/dist/nodes-BW91tb1K.mjs` line
    419; `node-registry.invoke-stream-CTVbIuYL.mjs` lines 79-97).
  - The public `node.invoke` path sets up a streaming consumer only for an
    owner-bound synthetic plugin client (`nodes-BW91tb1K.mjs` line 688).
    So duplex progress, `node.invoke.input` and the 30 s idle timeout
    (`NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS`,
    `<openclaw>/dist/node-commands-Bxo-2Y4j.mjs`) belong to that separately
    admitted streaming path. They give a Clawtrate operator connection no
    progress event.
- **Deferred commands on iOS** (source):
  - An iOS or iPadOS node can answer `NODE_BACKGROUND_UNAVAILABLE` for
    `camera.*`, `screen.*` and `talk.*` commands, or for plugin commands
    declared foreground-restricted (`nodes-BW91tb1K.mjs` lines 492-500).
  - The gateway then queues the operator's request and returns
    `QUEUED_UNTIL_FOREGROUND` with a `queuedActionId` (lines 969-1016).
  - The node fetches queued actions with the node-role methods
    `node.pending.pull` and `node.pending.ack` when it returns to the
    foreground.
  - The queue holds actions for 10 minutes, at most 64 per node
    (`nodes-policy-DtB0mmj2.mjs` lines 9-10).
  - It excludes agent-runtime calls and calls forwarding approval
    authority, so it does not replay a bot's request after a late
    permission answer.
  - A backgrounded iOS node can therefore stay connected and defer work. Do
    not infer disconnection from backgrounding.
  - Not exercised live: the probe node was a macOS stand-in.
- **Permissions**: the node reports `permissions` at connect. The only
  gateway use found is `permissions.accessibility`, which gates node
  presence-activity reports (`<openclaw>/dist/nodes-BW91tb1K.mjs` line 56).
  No use for admitting `node.invoke` was found in that file or
  `node-command-policy-I3ly1VaT.mjs`, so the node must refuse commands it
  cannot serve.
- The bot reaches node commands through its `nodes` tool. An operator calls
  `node.invoke`, which is `operator.write` except for the admin-only node
  commands (row 13).

#### Remaining items

- **"Always allow" on an expired approval** (live, `expired-approval.mjs`):
  - An `exec.approval.request {timeoutMs:2000}` returned `decision:null`
    when it expired.
  - A later `exec.approval.resolve {decision:"allow-always"}` failed with
    `INVALID_REQUEST` "approval already resolved" (`APPROVAL_ALREADY_RESOLVED`).
  - `exec.approval.get` then answered "unknown or expired approval id"
    (`APPROVAL_NOT_FOUND`, "Re-request the action").
  - The approvals document was unchanged.
  - Saving only the rule therefore needs `exec.approvals.set`
    (**`operator.admin`**) or a P5 rule.
- **Credentials a bot can reach** (live, `credentials-and-tools.mjs`):
  - model credentials per bot: `models.authStatus {agentId}`
    (`operator.read`) returns `providers:[{provider, status, profiles,
    apiKey:{source}}]`;
  - the shared secret store: `secrets.store.list` (**`operator.admin`**;
    the bot's `secrets list` shows metadata), which is the same for every
    bot and limited by host;
  - plugin credentials: `plugins.credentials.inspect` (**`operator.admin`**);
  - environment variables of exec.

  No per-bot credential list in one call was found among the read methods
  above.
- **Image generation**: the `image_generate` tool exists (source `core`,
  `coding` profile), and `view_image` with it (live: `tools.effective` and
  `tools.catalog`). It needs a configured image provider; none was
  exercised.
- **Proactive check-ins**: the per-bot heartbeat is
  `agents.entries.<id>.heartbeat.{every, prompt, timeoutSeconds}`
  (**admin** config, no non-admin method writes it;
  `<openclaw>/docs/gateway/heartbeat.md`).
- **Shareable links**: `session.publicShare.set {sessionKey,
  expectedSessionId, enabled}` (`operator.write`) returns a `v1.` share
  token for a session. A shareable link to a Page (canvas document) was not
  found: the only method name containing "share" is
  `session.publicShare.set`.

## 3. Plugin API

### Structure and install

A plugin is a folder or package with an `openclaw.plugin.json` manifest
(`id`, `name`, `description`, `categories`, `activation.onStartup`,
`configSchema`, and `contracts.tools` when it adds agent tools) and an ESM
entry listed under `package.json` `openclaw.extensions`. The entry exports
`{ id, name, description, register(api) }`. `definePluginEntry` from
`openclaw/plugin-sdk/plugin-entry` is the typed form
(`<openclaw>/docs/plugins/building-plugins.md`,
`<openclaw>/docs/plugins/manifest.md`). A working minimal plugin is
committed at `docs/research/dev-gateway/probe-plugin/`. It needs no
dependencies.

Registrars used or checked (types in
`<openclaw>/dist/config-contracts-C65kIjn4.d.ts`, `OpenClawPluginApi`):

- `api.registerGatewayMethod(name, handler, { scope?, profileAccess?,
  sessionAccess?, shareKey? })`. The handler receives
  `{ params, respond(ok, payload?, error?), client, context, req, ... }`.
  Core prefixes `config.*`, `exec.approvals.*`, `wizard.*` and `update.*`
  are forced to `operator.admin`. `sessionAccess: { mode, requiredTool,
  allowOwnSessionScope }` admits callers per session.
- `api.registerHttpRoute({ path, auth: "gateway"|"plugin", match?:
  "exact"|"prefix", handler(req, res), handleUpgrade? })` serves HTTP and
  WebSocket upgrades on the gateway port.
- `api.registerService({ id, start(ctx), stop() })`. `ctx.gatewayEvents.emit(name,
  payload, { scope })` broadcasts an event named `plugin.<pluginId>.<name>`.
  The name is one lowercase segment, the payload is bounded JSON, and the
  scope is read, write or admin (`<openclaw>/docs/plugins/sdk-entrypoints/registration-mode.md`;
  `<openclaw>/dist/services-CDza9GQm.mjs`).
  `ctx.gatewayEvents.onSessionsChanged(fn)` observes session changes.
  `context.broadcast(event, payload, opts)` is also available in method
  handlers.
- `api.registerTool(...)`, `api.on("before_tool_call", handler)` (block,
  rewrite params, or `requireApproval`), and other hooks
  (`<openclaw>/docs/plugins/hooks/tool-policy.md`).
- `api.on("after_tool_call", handler)` receives `{toolName, params, runId,
  toolCallId, result, error, durationMs}` and a context with `agentId`,
  `sessionKey` and `sessionId`. Live: for the `browser` tool,
  `result.details` carried `targetId` and `browserTab{targetId, profile}`.
- `api.pluginConfig` holds the plugin's own config block,
  `plugins.entries.<id>.config`, validated by the manifest's `configSchema`
  (live).
- `sessionAccessAuthority` is handed to handlers registered with
  `sessionAccess`. It has `target{agentId, sessionKey, sessionId}`,
  `assertCurrent()` and `retain()` (types in `config-contracts-C65kIjn4.d.ts`,
  `GatewaySessionAccessAuthority`). The only `sessionAccess.mode` is
  `"write"`.
- **Not available to user-installed plugins:**
  - `api.runtime.gateway.request` throws "Gateway requests are only
    available to bundled or trusted official plugins"
    (`<openclaw>/dist/server-plugins-BDDXcpzF.mjs` line 953). It would also
    carry only `operator.write`
    (`<openclaw>/docs/plugins/sdk-runtime/gateway-and-nodes.md`). A plugin
    therefore cannot call `browser.request`.
  - The same gate covers session facts, profile identity and GitHub account
    lookup (same file, lines 390, 638 and 923).
  - The `plugin-sdk/browser-config` and `plugin-sdk/browser-cdp` subpaths
    are private host runtime, not third-party contracts
    (`<openclaw>/docs/plugins/sdk-subpaths.md`).
  - No hook intercepts gateway methods. Hooks see agent tool calls only, so
    a plugin cannot stop an operator's `browser.request` or
    `browser.dashboard.request`.
- **Module instances:** the host loaded the plugin module more than once.
  State written by the `after_tool_call` hook was not visible to the
  gateway-method handler until it moved to a `globalThis` slot (live). The
  same slot survives plugin replacement. Plan for both.
- **Service ids are global.** Two plugins that both registered a service
  with id `events` collided ("service already registered: events"), and the
  second plugin's service did not start (live). Prefix service ids with the
  plugin id.

Verified live against the probe gateway, with the plugin installed into
that profile only:

```bash
openclaw --profile <dev> plugins install --link <checkout>/docs/research/dev-gateway/probe-plugin --force
# "Applied in Gateway generation N": hot-installed, no restart
```

- `clawtrate-probe.ping {note}` returned `{pong:true, at, emitted:true}`.
- The connection received event `plugin.clawtrate-probe.pinged` with payload
  `{at, note}`.
- `GET /clawtrate-probe/health` returned 401 without auth and
  `200 {"ok":true}` with `Authorization: Bearer <gateway token>`.

Install scope: `--profile <name>` keeps the install inside that profile. It
added `plugins.load.paths` and `plugins.entries.<id>.enabled` to that
profile's config only. Linked installs are for development; packaged
installs use `npm-pack:` or ClawHub specs. All plugin APIs are marked
experimental, so pin the host version.

### Plugins for partial and missing rows

Each step names its entry point and the authority it needs. "Shown" means
demonstrated on the probe gateway; everything else is **unverified**.

**P1, `clawtrate-bots` (row 3, partial).** One typed bot editor.

- `clawtrate-bots.get {agentId}` and
  `clawtrate-bots.update {agentId, expectedRevision, patch}`, registered with
  `api.registerGatewayMethod` at `scope: "operator.admin"`. That is the
  same authority as `agents.update` and `config.patch` today; the gain is
  one validated call instead of several.
- Config writes would use `api.runtime.config.mutateConfigFile`, and
  bootstrap files would be written into the workspace that
  `api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId)` returns. Both
  are listed in `PluginRuntimeCore` (`config-contracts-C65kIjn4.d.ts`) and
  are not in the official-only gate list above, but neither was called from
  a user-installed plugin: **unverified**.
- Event `plugin.clawtrate-bots.changed {agentId, revision}` through the
  service's `ctx.gatewayEvents.emit` (emission shown with the probe plugin).

**P2, `clawtrate-memory` (row 10, partial).**

- `clawtrate-memory.list`, `read`, `write` and `delete`, each `{agentId,
  path, content?, expectedHash?}`. They are registered at `operator.admin`,
  matching `agents.files.set`. Paths are confined to `MEMORY.md` and
  `memory/**/*.md`.
- Files are located with `api.runtime.agent.resolveAgentWorkspaceDir`
  (**unverified** from a user plugin) and changed with plain `node:fs`
  writes. The plugin runs in the gateway process with its file access.
- Reindex: there is no runtime method for it; `PluginRuntime` has none. The
  plan relies on the memory backend's file watcher
  (`<openclaw>/docs/concepts/memory-builtin.md` line 154). A live direct
  write under `memory/` was **not** picked up by `memory.search` within
  13 s, so this step is unverified and may need a reindex path. Options to
  test are `openclaw memory status --index --agent <id>`, run by the plugin
  as a subprocess, or confirming the watcher's paths and debounce.
- Event `plugin.clawtrate-memory.changed {agentId, path}`.

**P3, `clawtrate-push` (row 16, missing).**

- `clawtrate-push.register {expoPushToken, platform}` and `unregister`, at
  `operator.write`. The token is kept in plugin state, keyed by the
  caller's paired device id from the method's `client` argument.
- Triggers would come from `api.runtime.events.onAgentEvent` (listed in
  `PluginRuntimeCore`) for run completion, and from a `before_tool_call` /
  `after_tool_call` pair for tools that wait on approvals. No plugin-facing
  subscription to `exec.approval.requested` was found.
- Sending to Expo's push service is an outbound call from the gateway host;
  make it opt-in. Nothing in P3 was demonstrated: **unverified**.

**P4, `clawtrate-computer` (row 18).** Live view and user takeover of a
bot's own browser, without `operator.admin`. The prototype is
`docs/research/dev-gateway/computer-plugin/index.js`, with offline tests in
`test.mjs` beside it (`node test.mjs`, no gateway needed). Everything in the
table was **shown** live (row 18) unless marked.

Plugin config (`plugins.entries.clawtrate-computer.config`), with each
profile also declared under `browser.profiles` with the same port:

```json
{ "bots": { "atlas": { "profile": "bot-atlas", "cdpUrl": "http://127.0.0.1:19113" },
            "pixel": { "profile": "bot-pixel", "cdpUrl": "http://127.0.0.1:19114" } },
  "drainTimeoutMs": 15000 }
```

Entry points and authority:

| Step | Entry point | Authority and checks |
| --- | --- | --- |
| Give each bot its own browser | `api.on("before_tool_call")` for `toolName === "browser"`. Selectors are read the way the tool reads them: trimmed, with empty meaning absent. A configured bot may use only `status`, `start`, `tabs`, `open`, `focus`, `close`, `snapshot`, `screenshot`, `navigate`, `text` and `act`. Other actions, `importprofile` among them, are refused, and so are `node`, `dashboard`, `into` and any `target` but `host`. The hook then returns `{params: {...params, action, profile: <bot profile>, target: "host"}}`. Another agent is refused a bot profile named in `profile` or `into`, and `dashboard` selectors. The plugin refuses to load if `browser.defaultProfile` is a bot profile | Hook context's `agentId`, from the host. The browser tool's own result reported the pinned profile (live). With `target: "host"`, the tool never picks a node or sandbox, and refuses when host control is not allowed (`<openclaw>/dist/browser-request-CRdbSjXm.mjs` lines 1567 and 1593). The allowlist, target pin and import refusal were checked offline only |
| List, view, take, release, renew, input | `api.registerGatewayMethod("clawtrate-computer.*", …, { scope: "operator.write", sessionAccess: { mode: "write", requiredTool: "browser" } })` | The host checks the session, sharing and the session's browser tool policy. The plugin maps `sessionAccessAuthority.target.agentId` to that bot's browser and requires the tab to be in its live CDP target list |
| Stream | `api.registerHttpRoute({ path: "/clawtrate-computer/stream", auth: "plugin", handleUpgrade })` with a hand-written WebSocket handshake | One-use, 60 s, 192-bit ticket from `view.open`, deleted before any await. The stream closes when `view.renew` stops for 20 s, when the retained session authority fails, or when the tab goes away |
| Frames and input | CDP over the target's debugger URL: `Page.startScreencast`, `Page.screencastFrameAck`, `Input.dispatchMouseEvent`, `Input.insertText` (Node's global `fetch` and `WebSocket`) | Each `cdpUrl` must be the literal `http://127.0.0.1:<port>` or `http://[::1]:<port>`, or the config is rejected. Discovery uses `redirect: "error"`. A target is used only if its `webSocketDebuggerUrl` is exactly `ws://<same host>:<same port>/devtools/page/<id>` |
| Block the bot while the user drives | the same `before_tool_call` hook returns `{block: true, blockReason}` while any lease exists on that bot's profile | Only that bot's browser calls are affected, from all its sessions |
| Track running bot calls | `before_tool_call` records the host's run id and tool call id together; `after_tool_call` removes only the matching record, and only for the same agent. A browser call without both ids is refused | The same `runId:toolCallId` identity the host uses for its own call bookkeeping |
| Events | `ctx.gatewayEvents.emit("control", …)` gives `plugin.clawtrate-computer.control {profile, targetId, holder, state}`, with states `draining`, `granted`, `busy`, `released`, `expired`, `revoked` and `tab-closed` | Scope `operator.read`: every reader sees it, not only that bot's sessions |

Contract:

- **`control.take {sessionKey, targetId}`.**
  - It emits a `draining` event at once and blocks new bot calls on the
    bot's profile. It sends **one** response after the wait: `{state:
    "granted", generation, renewWithinMs}` or `{state: "busy", reason,
    runningCalls}`.
  - There is no `draining` response; show that state locally, or from the
    event.
  - If a bot browser call is still running after `drainTimeoutMs` (default
    15 s), the take **fails closed**: no lease remains, and the client should
    say "the bot is still acting" and let the user retry. It returns
    `CONFLICT` if anyone holds or is taking the tab.
- **`control.release` and `input`.** These need the holder's connection and
  the lease's `generation`, an unguessable 128-bit id. Other viewers get
  `FORBIDDEN`. Input, release and expiry run one at a time on each lease. Input rechecks that the lease is still the same one, still
  granted and still authorized after connecting and before every CDP
  command. Input that started under a lease cannot land after that lease
  ends (offline test C-03b).
- **`view.renew {sessionKey, targetId, streamId, generation?}`.** This does
  two separate renewals.
  - Stream renewal: any viewer admitted to the tab's bot renews its own
    stream (`streamId` from its `view.open`). The stream must match that
    bot and tab, otherwise the reply is `NOT_FOUND`.
  - Lease renewal: the lease is renewed as well only when the call comes
    from the lease holder's connection with the current `generation`.
  - The reply is `{ok: true, renewWithinMs, leaseRenewed}`. A missing or
    wrong `generation`, or another viewer's call, still renews the stream,
    but returns `leaseRenewed: false` and leaves the lease's expiry clock
    alone.
- **`input {kind: "click"|"scroll"|"text", x?, y?, deltaY?, text?}`.**
  Scroll uses a CDP wheel event.
- **Frames.** They use the built-in screencast's binary layout and header,
  `{url, cssWidth, cssHeight, scrollX, scrollY, ts}`, so one decoder serves
  both. Text messages are `ready` and `meta`. Close codes are `4004
  target_closed`, `4006 authority_revoked` and `1000` on close.

Limits:

- **Isolation is per bot, not per session.** Sessions of the same bot share
  its browser, and so share what they can view and take. Tabs opened in the
  bot's profile by an operator through `browser.request` are part of that
  browser, and are viewable by the bot's sessions (live).
- **The block is per bot, not per tab.** While a user holds one tab, all of
  that bot's browser calls are refused. Bot calls name tabs by handles such
  as `t1` that a plugin cannot resolve.
- **Unconfigured bots** keep using the shared `openclaw` profile and get no
  view. While bots have their own browsers, unconfigured agents also lose
  browser dashboards, because a dashboard widget can name any profile.
- **Operators are not blocked.** `browser.request` (admin) and
  `browser.dashboard.request` (write) are gateway methods, and no hook
  reaches them, so an admin client or a dashboard widget can still drive a
  bot's browser during a lease. The bot itself might reach the browser by
  other means the hook does not cover, such as `exec`. That is not
  verified either way.
- **A stuck call keeps takeover unavailable.** A bot call that never
  produces `after_tool_call` keeps that bot's takeover busy until the
  gateway restarts. The plugin cannot cancel the call. `agent_end` would
  give run-level cleanup, but user-installed plugins need
  `hooks.allowConversationAccess` to use it
  (`<openclaw>/dist/registry-Ctt4xQAS.mjs` lines 2597-2607 and 2830).
  Whether `after_tool_call` fires for an aborted run is **unverified**.
- **Not bound to the connection.** Plugins receive no connection-closed
  signal, and `sessionAccessAuthority.retain()` did not abort when the
  viewer disconnected (live). Streams and leases therefore expire through
  renewal: call `view.renew` about every 5 s, passing the lease's
  `generation` while holding control. Each renewal re-runs the host's
  session access check.
- **Policy bypass.** Frames and input go straight over CDP, so they skip
  the browser plugin's navigation checks: a user click can follow a link
  the bot could not open. The prototype reports `meta` on navigation; it
  does not retire the stream or recheck the URL as the built-in stream
  does.
- **Config is trusted.** The owner's `bots` map decides which profile
  belongs to which bot. Each profile's `cdpPort` in `browser.profiles` must
  match the plugin's `cdpUrl`; the plugin does not read the browser config.
- **Not demonstrated live:** `text` input, the `computer` tool,
  node-routed browsers, an unconfigured agent naming a bot profile (covered
  only by the offline test), and two viewers taking at the same moment
  (the second gets `CONFLICT` in code and in the offline test).

**P5, `clawtrate-tool-rules` (row 8, partial for non-exec tools).**

- An `api.on("before_tool_call")` handler reads a per-bot rule table from
  `api.pluginConfig`, `{agentId, tool, action: "allow"|"ask"|"deny"}`, and
  returns `block` (shown in P4) or `requireApproval`. `requireApproval` is
  **unverified**; it should surface as `plugin.approval.requested` and be
  resolved with `plugin.approval.resolve`.
- Methods `clawtrate-tool-rules.get` and `set` at `operator.admin`.

No plugin is proposed for rows 13 and 17: the surface exists but was not
exercised. For steer (row 5), a test is needed first, not a plugin.

### Requirements for the shipped plugin

The P4 prototype is a feasibility demonstration, not a shippable plugin.
Builders write the shipped computer-view plugin from this list. Each item is
meant to be checked by a test or a review finding.

**Security review.**

- [ ] The shipped plugin gets its own security review before it is installed
      on any gateway other than a development gateway. Passing the
      prototype's tests does not count.

**Browser isolation (fixed in the prototype; keep and test).**

- [ ] Read every selector the way the browser tool reads it before any
      ownership check: strings trimmed, empty meaning absent. Cover the
      omitted profile, which resolves to `browser.defaultProfile` or
      `openclaw`. Refuse configurations where the default is a bot's
      profile. (R3-01; tests R3-01a-c.)
- [ ] Track bot browser calls by the host's run id and tool call id
      together. Refuse a call that lacks either. Remove only the matching
      record, and only for the same agent. (R3-02; tests R3-02a-c.)
- [ ] Refuse `importprofile` for bot callers. Refuse imports into a
      reserved bot profile, by trimmed `into`, from every agent the hook
      sees. (R3-03; test R3-03.)
- [ ] Allow bots only an explicit list of tab actions, and refuse
      everything else. The prototype allows `status`, `start`, `tabs`,
      `open`, `focus`, `close`, `snapshot`, `screenshot`, `navigate`, `text`
      and `act`. Extend it only after review. (Test R3-03b.)
- [ ] Pin every rewritten bot call to `target: "host"` and the bot's
      profile. Refuse node, sandbox and dashboard selectors. Refuse the
      call when host browser control is not allowed, rather than routing
      elsewhere. (R3-05; test R3-05.)
- [ ] Derive view and control rights only from the host-checked session's
      agent and that bot's live CDP target list. Never derive them from
      tool results. (Tests C-01a-d.)

**Takeover and lease (fixed in the prototype; keep and test).**

- [ ] Fail closed: if a bot call is still running at the drain deadline, do
      not grant control. (Test C-02a.)
- [ ] Only the holder, with the lease generation, can release or send
      input. Run input, release and expiry one at a time. Recheck the lease
      and authority before every command. (Tests C-03a-b.)
- [ ] Use CDP endpoints only on literal loopback, with no redirects, and
      only with a debugger URL on the same address and port. (Tests
      C-05a-c.)

**Deadlines and cancellation (N-01, not done in the prototype).**

- [ ] Put deadlines on CDP discovery, WebSocket connect and every command
      reply.
- [ ] Cancel aborts through setup and active commands. Close connections
      that finish opening after their stream or lease ended.
- [ ] Settle queued input before returning control to the bot. Release,
      expiry and service shutdown must complete even when a transport stage
      is stalled. Test each stage stalled.
- [ ] Define how replacing a browser or profile retires its streams and
      leases.

**Tests still missing (N-02, not done in the prototype).**

- [ ] A positive control: a valid click, text and scroll must actually be
      dispatched.
- [ ] Delayed revocation of the retained session authority during a stream
      and during input; lease expiry; serialization at the command level.
- [ ] A debugger URL on the right loopback address but the wrong port must
      be refused. Cover IPv6, credentials in the URL, other schemes, and a
      simulated redirect, not only the fetch option.

**Stated limits the shipped plugin must address or document.**

- [ ] Operator gateway calls (`browser.request`, `browser.dashboard.request`)
      bypass the tool hooks and can drive a bot's browser during a user
      takeover.
- [ ] Direct CDP input and frames skip the browser plugin's navigation
      policy.
- [ ] A takeover blocks browser calls from every session of the bot, not
      one tab.
- [ ] Other tools may reach a browser outside the `browser` tool hook,
      such as the `computer` tool or `exec`. Account for them in the
      isolation policy.

## 4. Development gateway recipe

Everything here was run against an isolated profile and port, and is
committed under `docs/research/dev-gateway/`:

| File | Purpose |
| --- | --- |
| `dev-gateway.sh` | `start`, `check-env`, `stop` and `reset`. Refuses unsafe profile names and any existing state folder, so every start uses a new, empty one. Runs everything under a controlled environment, records real PIDs, and stops with a kill-after-timeout. |
| `fake-openai.mjs` | Scripted fake model provider: OpenAI Chat Completions streaming on loopback, no dependencies. |
| `openclaw.dev.json` | Gateway config template, described below. It loads the two plugins below from the checkout. |
| `seed.mjs` | Creates bots and tasks, waits for every run, and verifies the transcripts; exits non-zero on any failure. |
| `fake-coding-mcp.mjs` | Stand-in coding-agent MCP server (section 5). |
| `probe-plugin/` | Minimal plugin proving methods, events and routes (section 3). Also reports the gateway's environment variable names for `check-env`. |
| `computer-plugin/` | Prototype of plugin P4: browser view and takeover without admin (section 3), with offline tests. |
| `probe-lib.mjs` | Probe client helper: pairs a device identity on loopback with chosen scopes and caps, records events, waits for a run's terminal event. |
| `scenarios/` | The probe scripts behind row 19, with a README. |

Profile and port: the project uses `--dev` (state in `~/.openclaw-dev`, port
19001). The launcher deliberately refuses that profile: it accepts only names
matching `^[a-z0-9]+(-[a-z0-9]+)*-(dev|probe)$`, such as `clawtrate-dev`, and
never `default` in any letter case. The template's gateway port is 19101.
Another port needs a change in the template, `PORT` in the script, and the
`cdpPort` values.

```bash
# 1. Start: refuses unsafe names and any existing state folder,
#    creates a new profile from the template, starts the fake model and the gateway
PROFILE=clawtrate-dev docs/research/dev-gateway/dev-gateway.sh start

# 2. Ask the running gateway which environment variable names it really has
PROFILE=clawtrate-dev docs/research/dev-gateway/dev-gateway.sh check-env
#   ... "ok: the gateway sees only the launcher's variables"

# 3. Seed and verify (needs @openclaw/gateway-client@2026.10.6 installed)
OPENCLAW_DEV_URL=ws://127.0.0.1:19101 \
OPENCLAW_DEV_TOKEN="$(cat "${TMPDIR:-/tmp}/openclaw-clawtrate-dev-run/token")" \
  node docs/research/dev-gateway/seed.mjs

# 4. Stop, then delete the profile the launcher created
PROFILE=clawtrate-dev docs/research/dev-gateway/dev-gateway.sh stop
PROFILE=clawtrate-dev docs/research/dev-gateway/dev-gateway.sh reset
```

### Isolation: what the template does and what it does not

The development gateway must not reach a real model or a hosted service with
the developer's credentials. Model routing alone does not guarantee that.

- **Profile selection.** OpenClaw maps `--profile <name>` to
  `~/.openclaw-<name>`, but `default`, in any letter case, maps to the real
  `~/.openclaw` (`resolveProfileStateDir`,
  `<openclaw>/dist/profile-utils-BsmgdpgZ.mjs`).
  - The launcher validates the name before it touches any file. It then
    resolves the state folder once, and passes `OPENCLAW_STATE_DIR`,
    `OPENCLAW_CONFIG_PATH` and `OPENCLAW_PROFILE` explicitly with
    `--profile`, so the script and the CLI cannot disagree.
    `applyCliProfileEnv` keeps explicit values that do not point at the
    default profile (`<openclaw>/dist/profile-D1GpjMFM.mjs` lines 83-96).
  - Live, under a temporary `HOME`: `default`, `Default`, `DEFAULT`, `dev`,
    an empty name, `roster`, `../roster-probe`, a name with `/../` and
    `Roster-Probe` were all refused (exit 2), and the temporary `HOME` was
    still empty afterwards.
- **State reuse.** At startup OpenClaw loads `<state>/.env` and
  `<config dir>/.env`. It also loads `~/.config/openclaw/gateway.env` unless
  the state folder is explicit and not the default
  (`resolveGlobalDotEnvFiles`, `<openclaw>/dist/dotenv-global-CNTZ1AEX.mjs`
  lines 118-135; `createTrustedGatewayEnvLoader`,
  `<openclaw>/dist/pre-bootstrap-fvJUb9k2.mjs` lines 336-358).
  - `env -i` alone therefore does not keep credentials out, and this
    release also keeps model credentials in SQLite state. So the launcher
    does not try to prove an old folder clean. `start` refuses whenever the
    state folder already exists, or is a symlink, and names the reset
    command. It then creates the folder with plain `mkdir`, so it never
    reuses one. `reset` deletes only a folder carrying the launcher's marker
    file `.clawtrate-dev-gateway`.
  - Tested under a temporary `HOME`, without starting a gateway: an existing
    marked folder containing `state/openclaw.sqlite`, and a symlinked state
    folder, were both refused with exit 3, and nothing was started.
- **Environment.** OpenClaw resolves provider credentials from environment
  variables per provider (`resolveEnvApiKey` in
  `<openclaw>/dist/model-auth-env-dEPoNA3I.mjs`).
  - The launcher starts the fake model and the gateway with `env -i`. It
    passes `HOME`, `PATH`, `TMPDIR`, `DO_NOT_TRACK=1`,
    `OPENCLAW_DEV_TOKEN` and the three `OPENCLAW_*` location variables.
  - `check-env` asks the running gateway, after OpenClaw's own loaders,
    for its variable names, through the admin-only probe-plugin method
    `clawtrate-probe.envNames` and `openclaw gateway call` with
    `--expect-url ws://127.0.0.1:19101`. It fails on any name outside an
    allowlist.
  - Live: the gateway reported the launcher's names plus six it adds
    itself, none carrying a value in: `OPENCLAW_CLI`,
    `OPENCLAW_GATEWAY_PORT` and `OPENCLAW_PATH_BOOTSTRAPPED` from OpenClaw,
    `PWD` and `SHLVL` from the bash wrapper, and `__CF_USER_TEXT_ENCODING`
    from macOS.
  - To prove the check sees loader-injected values: a `.env` holding
    `FAKE_PLANTED_KEY` was put into the marked state folder, and the
    gateway was started directly, bypassing the launcher's refusal.
    `check-env` reported "UNEXPECTED variables in the gateway:
    FAKE_PLANTED_KEY" and exited 4.
  - Run every `openclaw` CLI call for the dev profile the same way: the
    script's `oc` helper does.
- **Memory embeddings.** Memory search is on by default and defaults to the
  `openai` embeddings provider whatever `models.mode` says
  (`DEFAULT_MEMORY_EMBEDDING_PROVIDER` and `produceMemorySearchConfig` in
  `<openclaw>/dist/memory-search-C0yT-zqb.mjs`). The template sets
  `memory.search.provider: "none"`. That provider has no embedding adapter,
  so search is local full-text only (live: `memory.status` reported
  provider `none`, and `memory.search` returned a hit with
  `searchMode: "fts-only"`).
- **Models.** `models.mode: "replace"` with the single `fake` provider means
  agent turns and utility calls go to the fake. Live: every run was answered
  with the fake's scripted text, and runs failed when the fake was stopped.
  The template also sets `models.catalogRefresh.enabled: false`, which stops
  the hosted model catalog fetch.
- **Other network traffic.**
  - `update.checkOnStart: false` stops the update check and the anonymous
    update ping.
  - `discovery.mdns.mode: "off"` stops LAN advertising.
  - Telemetry is off by default, and `DO_NOT_TRACK=1` keeps it off.
  - Bot tools can still reach the internet: `web_fetch`, the browser, MCP
    servers, and exec if approved.

  The template has none of the credentials those would need, but it is not
  a network sandbox.
- **Exec policy.** It is global, `tools.exec.mode: "ask"`, so bots created
  later inherit it. Live: Ledger, created by `seed.mjs` with no override,
  asked for approval for `uname -s` (`security: "allowlist",
  ask: "on-miss"`). Without approval-capable clients, such requests are
  denied as `no-route`. Pixel also denies `exec` outright.
- **Browser.** The template sets `browser.headless: true` and declares one
  profile per bot (`bot-atlas` on 19113, `bot-pixel` on 19114) beside the
  shared `openclaw` profile (19112), for plugin P4.
- **Plugins.** They are loaded from the checkout through `plugins.load.paths`
  and `plugins.entries`. OpenClaw logs that it "can't verify where this
  plugin came from"; that is expected for local paths.

### Other facts the recipe depends on (live unless noted)

- **Custom provider base URL: yes.** `models.providers.<id>.baseUrl` with
  `api: "openai-completions"` (or `openai-responses`) points at any
  OpenAI-compatible server. A non-secret `apiKey` such as `"fake-local"` is
  accepted for loopback URLs (`<openclaw>/docs/gateway/local-models.md`).
- The fake streams `delta.reasoning_content` for thinking. The adapter
  also accepts `reasoning` and `reasoning_text`
  (`<openclaw>/node_modules/@openclaw/ai/dist/openai-completions-transport-BRjxCG1C.mjs`).
  It streams `delta.content` for text, and `delta.tool_calls[{index, id,
  function{name, arguments}}]` with `finish_reason: "tool_calls"` for tools.
  Scripted directives in the user's message:
  - `#tool <name> <json>`: one tool call;
  - `#ask <sessionKey> <message>`: a `sessions_send` bot-to-bot call;
  - `#slow <seconds> <text>`: slow streaming, for abort and steer tests;
  - anything else: reasoning, then `Echo: <text>`.

  After a tool result it replies `Tool <name> returned: <result>`. Utility
  calls (recaps, titles) get a fixed sentence.
- `tools.toolSearch: false` is required. Custom providers otherwise get
  structured Tool Search, which hides real tools behind `tool_search`,
  `tool_describe` and `tool_call`.
- `agents.ownership: "explicit"` is required once there are two or more
  bots.
- Seeding uses the loopback-only trusted backend identity:
  `client.id: "gateway-client"`, `mode: "backend"`, shared token, no
  device. Clawtrate itself must use a device identity.
- **`seed.mjs`.** For each step it:
  - creates the task with `sessions.create`, failing on `runError` or a
    missing `runId`;
  - waits for the run's terminal outcome with `agent.wait {runId}`, failing
    on any status other than `ok`;
  - applies `chat.inject` steps only after the previous run has finished;
  - checks `chat.history` for the expected assistant text or tool result.

  Live, on a fresh profile it printed `ok` for all five tasks:
  - Atlas: "Laptop comparison" (scripted reply plus an injected row);
  - Atlas: "Workspace listing" (`ls` tool);
  - Atlas: "Hand off to the coding agent" (`coder__send_message`, with the
    stand-in MCP server's reply verified);
  - Pixel: "Ask Atlas" (`sessions_send` with `status: "ok"`);
  - Ledger: "Weekly plan".

  It exits 0. With the fake model stopped it exited 1: "run … ended with
  error: The request took too long". Labels must be unique, so run it
  against a fresh profile, or set `SEED_LABEL_SUFFIX`.
- **Stopping.** `dev-gateway.sh stop` sends SIGTERM to the recorded PIDs and
  waits up to 60 s, then sends SIGKILL. In the first round, one gateway took
  more than two minutes to exit after SIGTERM, because plugin service
  disposal ran past its budget. In this round, stops took about 2 s. The
  script records the PID of the exec'd process itself, not a wrapping
  shell; an earlier version recorded the subshell, which would have left
  the gateway running.

## 5. Messaging T3 Code

There are three ways an OpenClaw bot can call an external coding-agent app
that exposes MCP tools and threads:

1. **MCP server (recommended).** Add the app's MCP endpoint under
   `mcp.servers.<name>`: `{command, args}` for stdio, or `{url, headers?}`
   for Streamable HTTP or SSE (`<openclaw>/docs/tools/mcp.md`). Keep
   secrets in env or SecretRefs, never as literals. The tools reach the
   model as **`<server>__<tool>`** and go through the normal tool profile,
   allow, deny and approval policy.
2. **Plugin tool.** `api.registerTool({ name: "t3_send", ... })` wraps the
   app's API. Tool events use the registered name and whatever `details`
   the plugin returns. This allows a clean shape, but the plugin owns the
   transport and auth.
3. **Skill.** A `SKILL.md` that tells the bot to run a CLI through `exec`.
   The events are ordinary `exec` events with command text. They are hard
   to recognize reliably and they go through exec approvals. Avoid this.

A real T3 Code integration is **unverified**. The events below come from the
committed stand-in server, not from T3 Code.

Verified tool events for the MCP path. These came from a stand-in server,
`docs/research/dev-gateway/fake-coding-mcp.mjs`, configured as
`mcp.servers.coder` and exposing `send_message({threadId?, message})` and
`list_threads()`. Live:

```text
agent stream:"item" data:{name:"coder__send_message", kind:"tool", phase:"start", title:"Coder Send Message", ...}
agent stream:"tool" data:{phase:"start", name:"coder__send_message", toolCallId, args:{message:"Fix the failing login test"}}
agent stream:"tool" data:{phase:"result", name:"coder__send_message", isError:false,
  result:{content:[{type:"text", text:"structuredContent:\n{…}"}],
          details:{mcpServer:"coder", mcpTool:"send_message",
                   structuredContent:{threadId:"thread-1", reply:"…"}}}}
agent stream:"item" data:{..., phase:"end", status:"completed"}
```

Rendering a "Messaged T3 Code" card:

- Recognize it by `result.details.mcpServer` equal to the configured server
  name, for example `t3code`. Before the result arrives, use the
  `data.name` prefix `<server>__`.
- `args` are the message sent. `details.structuredContent` holds the
  thread id and reply when the server returns structured content. Otherwise
  parse `result.content[0].text`.
- Keep a client-side map from MCP server name to display name and icon,
  such as `t3code` to "T3 Code". Show the raw call behind the card, as the
  parity goals require.

T3 Code's actual MCP transport, endpoint, tool names and auth model are
**unverified**. Its tools will appear as `<server>__<toolName>`, using
whatever server name the owner chooses in `mcp.servers`.

## 6. Risks

- **Protocol stability for third-party clients.**
  - Client ids and modes are closed enums with no third-party slot.
  - Request schemas are closed, so version skew fails loudly.
  - The `methods` list in `hello-ok` is deliberately incomplete.
  - The docs' "verified stable" package (2026.8.1) lags the gateway by about seven
    weeks.
  - Plugin APIs are labeled experimental.
  - Releases are frequent (2026.10.6 to 2026.11.4 in 25 days, with 107
    changed definitions).

  Mitigations: lock client and gateway to the same release, gate features
  on `features.capabilities` and the presence of methods, and run e2e tests
  against that exact gateway in CI.
- **Single trusted operator.**
  - Gateway-authenticated callers are trusted operators. Exec approvals are
    "not a per-user auth boundary" (`<openclaw>/docs/tools/exec-approvals.md`).
  - Many Clawtrate flows need `operator.admin`:
    - bot editing and per-bot policy;
    - schedule changes;
    - the built-in browser view;
    - `chat.inject`;
    - routing exec to a node and per-session tool overrides (`execNode`,
      `toolOverrides` on `sessions.patch` or `sessions.create`); placing a
      whole task on a device with `sessions.dispatch`/`sessions.move` is
      write-scoped (row 20);
    - per-session exec placement (`execHost`, only on `sessions.patch`;
      `execSecurity` and `execAsk` are retired).

    A phone holding admin can do anything to the gateway, including config
    writes.

  Mitigations: pair mobile as read, write and approvals by default, with
  admin requested on demand through `device.scopes.requestUpgrade`. Move
  admin-only flows behind narrower plugin methods where possible. P4 shows
  this works for the browser view. A plugin method at a lower scope is
  itself a privilege decision, so review each one.
- **Default exec posture.** An unconfigured gateway ran model-requested
  shell commands with no approval. Clawtrate should show the effective exec
  mode per bot prominently, and warn on `full`.
- **Approvals need caps.** A client that forgets `approvals` or
  `exec-approvals` causes silent denials (`no-route`), not prompts.
- **Attachments.** Base64 in one WebSocket frame: per-file ceilings come
  from `hello-ok.policy.attachments` (observed 18.5 MiB and 6 MiB), the
  frame limit is `policy.maxPayload` (25 MiB), and there is no resumable
  upload. Large files need another path, such as a workspace write by a
  plugin or `terminal.upload`, which is admin.
- **Event volume.**
  - `agent stream:"tool"` frames embed a full session row snapshot.
  - The operator connection received the target bot's run events in a
    bot-to-bot exchange without subscribing to that session.

  Mobile clients should use `mode:"narration"` and `rowMode:"compact"`
  where possible, and test bandwidth.
- **Steer semantics.** `sessions.steer` is a deprecated alias for
  `queueMode: "interrupt"`. `chat.send {queueMode:"steer"}` is unverified
  with a real model. With the scripted model it interrupted the running
  reply, and one steer run failed with a "no longer current" error.
- **Memory search defaults to a hosted embeddings provider.** It is
  `openai`, regardless of model routing, and picks up credentials from the
  environment. The development template turns it off
  (`memory.search.provider: "none"`). A real gateway's memory settings decide
  whether memory text leaves the host; Clawtrate's memory view should show
  them.
- **Inherited environment.** Any `openclaw` process (gateway or CLI) started
  from a shell with provider keys can use them. Development tooling must
  start it with a controlled environment (section 4).
- **Personal data in events.** Session rows and message metadata carry the
  gateway owner's display name and avatar URL (`createdActor.label`,
  `senderName`). The probe derived these from the host account. Never
  commit captured event logs or screenshots of real gateways to this
  repository.
- **Gateway shutdown can hang** past SIGTERM (section 4), which matters
  for test harness teardown. Record the PID of the gateway process itself,
  not a wrapping shell.
- **Mobile push** depends on a plugin plus a third-party push service
  (row 16). The official relay is closed to other apps.
- **Browser takeover.** Built in, agent and user input race. P4 gives each
  bot its own browser and blocks that bot while the user holds control. It
  refuses takeover outright while the bot is still acting, and a stuck
  call keeps takeover unavailable. It does not block other operators
  calling `browser.request`. Its frames and
  input go over raw CDP and skip the browser plugin's navigation policy.
  The loopback CDP port is unauthenticated, so any local process on the
  gateway host can already drive the managed browser.
- **Plugin runtime quirks.** The host loads a plugin module more than once,
  and module state is not shared between those loads. Service ids are
  global across plugins. Several runtime
  helpers, including in-process gateway requests, are reserved for bundled
  or official plugins. Plugin designs must be proven on the pinned gateway,
  not inferred from the SDK docs.
