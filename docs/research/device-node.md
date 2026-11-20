# Clawtrate as a node: what the gateway allows

What it takes for Clawtrate to be a device a bot can send commands to (a node), checked against OpenClaw 2026.10.6: who may pair a node and at which tier, what a device can offer and who decides, what a call to a node looks like from both ends, what holds a permission and a late answer, what the gateway does with a phone in the background, and what the share sheet and the two Shortcuts actions call. It is the evidence behind `docs/design/device-node.md` and the rows F-185, F-223, F-245, F-246, F-347, F-348, F-384, F-385, F-406, F-451 and F-452.

How to read the citations, as in `setup-flow.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Bundled chunk names carry a build hash that changes with every release; search by the `//#region <source path>` marker at the top of each chunk instead. Line numbers are of the 2026.10.6 chunks.
- `schema` is `protocol.schema.json` in `@openclaw/gateway-protocol@2026.10.6`.
- **Live** means it was run, and the result is quoted. **Source** means it was read in shipped code only (read-only-from-source). **Unverified** marks what was only read and could not be run here, with the reason.

Where things were run:

- **Two development instances** of my own, started from this checkout: `d16node` (`pnpm dev-gateway start --instance d16node --no-seed`), which, like every instance, sets `gateway.nodes.pairing.autoApproveLocal` to `false`, so a first pairing waits even on loopback; and `d16local` (the same with `--default-local-pairing`), which leaves that setting at the gateway's default. Both on loopback, both reset afterwards.
- **The probe** `device-node/node-probe.ts`, which opens operator connections with the official `@openclaw/gateway-client` at the tier each experiment names, and a **stand-in node**. After pairing, the operators reconnect with their device token alone, as Clawtrate does (`packages/core/src/client.ts`, "Once paired, the device token is the credential"): the gateway treats a caller that presents the shared token as no particular device and skips its ownership checks (section 1.4).
- **The stand-in node** connects with `role: "node"` as a macOS device and declares only five commands invented for this note, `clawtrate.probe.echo`, `.refuse`, `.silent`, `.late` and `.slow`. It answers them with fixed text, a fixed refusal, no answer, an answer after the caller's limit, or an answer after 3 seconds. It runs no program, reads no file and asks the operating system for nothing. It never declares a system, shell, browser, file, screen, camera, location, notification or app command. The instances' bots cannot reach it: every bot's `nodes` tool is denied in the development configuration (`tools/dev-gateway/src/cli.ts`, `DENIED_TOOLS`). Only the probe's own operator connections call it. What the real commands do is read in the source and marked as such.
- **Not exercised here**: an iOS node (the iPhone app is not on `main`), a node off loopback through a real network, a bot calling a node, and every command the gateway itself knows.

## Summary

| #   | Question                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Section |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Who may pair a node, at which tier?          | Two approvals, not one. **First the device**: a node's first connect is refused `PAIRING_REQUIRED` with `requestedRole: "node"`, a device pairing request. Only an admin connection, or `openclaw devices approve` on the gateway's computer, can approve a request that includes the node role; the device's own operator connection, at pairing and write, was refused and could reject it. **Then the command surface**: once connected, the node files a `node.pair.requested` with the commands the gateway kept and `requiredApproveScopes`. Pairing alone was refused `missing scope: operator.write`; the node's own device at pairing and write approved it; another device without admin was refused "node pairing approval denied"; admin approved any. Only admin removed a node. With `autoApproveLocal` at its default, a node on loopback was paired silently, commands included. **Live.** The admin tier for the system, browser and file commands is **source**: this probe never declares them.     | 1       |
| 2   | One device as operator and node?             | It works and is one device in the gateway's list with both roles. A node request that waits when the same device then asks to pair as an operator is merged into one request for both roles; approving that request pairs both. **Live.** So Clawtrate must not file its node request while its own operator pairing or a scope request waits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 1.3     |
| 3   | What may a device offer?                     | The platform's defaults (macOS: location, contacts, calendar, reminders, photos, device, camera list, `device.apps`; iOS likewise, without `device.apps`; **source**), plus approved desktop host commands, plus `gateway.nodes.commands.allow`, minus `deny`. A declared command outside that set is **dropped silently** from the request, and a call to it is refused "node command not allowed: … is not in the allowlist for platform "macos"". The allowlist is admin configuration, readable at read. What the gateway kept is read back with `node.describe` at read. **Live.** No default command reaches Messages, Mail or Notes (**source**).                                                                                                                                                                                                                                                                                                       | 2       |
| 4   | A call to a node, from both ends             | `node.invoke` at write (read refused). The node gets `node.invoke.request {id, nodeId, command, paramsJSON, timeoutMs, idempotencyKey}`, with the time left, 30 000 ms when the caller gives none, and answers `node.invoke.result`. A refusal reaches the caller as `"<code>: <message>"` in the node's own words; no answer, `"TIMEOUT: node invoke timed out"`; an answer after that is acknowledged `{ignored: true}` and reaches no one; a node not connected, `"node not connected"`. **Live.** A bot's `nodes` tool puts the same message after `agent=<id> node=<node> gateway=<gateway> action=<action>:` (**source**).                                                                                                                                                                                                                                                                                                                          | 3       |
| 5   | Permission and resume                        | Nothing in the gateway holds a call for five minutes, re-runs a call after a late Allow, or knows the hour. The reported `permissions` do not admit a call (a call to a node reporting the permission false ran); a newly granted permission files a new surface request at pairing and write. **Live.** Each later call is checked at the time it is made: an allowlist entry removed while a call waited ended it `POLICY_CHANGED`. **Live.** So the five minutes and the hour are the app's own, and running the original request again is cut.                                                                                                                                                                                                                                                                                                                                                                                       | 4       |
| 6   | The phone in the background                  | **Source only.** An iOS node that answers `NODE_BACKGROUND_UNAVAILABLE` for a camera, screen or talk command has an operator's call queued for 10 minutes, at most 64 per node. Calls from a bot's run and calls carrying approval authority are never queued: the bot gets the node's own words at once, and nothing is replayed when the phone comes back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 5       |
| 7   | Taking back a Mac app                        | Removing the allowlist entry while a call waited ended the call at once, `"POLICY_CHANGED: node command is no longer allowed"`, and the node's later answer was ignored; the node had already received the request. Later calls were refused. Removing the node ended a waiting call `"node pairing changed while invocation was active"`. **Live.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 6       |
| 8   | The share sheet, Siri and Shortcuts          | `agents.list` (`defaultId`) and `users.prefs.get` answer at read; `sessions.create {agentId, message}` started a task and a run at write and was refused at read. **Live.** Everything on the iPhone itself is **unverified** here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 7       |
| 9   | Which approval card a node's permission uses | None of the gateway's. An ordinary `node.invoke` makes no approval record (only `system.run` binds to one, **source**), so a node's permission question is the app's own, asked on the device that holds the permission, which need not be the device whose message started the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 8       |

## 1. Pairing a node

### 1.1 Two requests: the device, then its commands

A connection with `role: "node"` is a device. Its first connect, with the shared token and a new device key, was refused on `d16node`:

```
node connect: {"code":"NOT_PAIRED","details":{"code":"PAIRING_REQUIRED","reason":"not-paired","requestId":"248b4c9d-…","deviceId":"c503a740…","requestedRole":"node", …}}
admin device.pair.list pending: [{"deviceId":"c503a740d592","displayName":"Clawtrate research N-drop","role":"node","roles":["node"],"scopes":[],"platform":"macos","clientId":"node-host","silent":false,
  "keys":["requestId","deviceId","publicKey","displayName","platform","deviceFamily","clientId","clientMode","role","roles","scopes","silent","isRepair","ts"]}]
admin node.pair.list: {"pending":[],"paired":[]}
```

So the first request is a device pairing request (`device.pair.*`), and it lists no commands. Once admin approved it, the node connected (`{"role":"node","scopes":[]}`) and filed a second request, for its command surface:

```
admin node.pair.list: {"pending":[{"nodeId":"c503a740d592","displayName":"Clawtrate research N-drop","platform":"macos","deviceFamily":"Mac","commands":[],"requiredApproveScopes":["operator.pairing"],
  "keys":["requestId","nodeId","clientId","clientMode","displayName","platform","version","deviceFamily","caps","commands","requiredApproveScopes","ts"]}]}
```

`commands` is empty because nothing was allowlisted yet (section 2). With the invented commands allowlisted, the same request listed them and asked for `["operator.pairing","operator.write"]`. The request also carries `permissions`, `modelIdentifier` and `remoteIp` when the node reports them (`toPublicPendingRequest`, `<openclaw>/dist/device-pairing-node.records-DzsUStjj.mjs` lines 7-28). `requiredApproveScopes` comes from `resolveNodePairApprovalScopes` (`<openclaw>/dist/node-pairing-authz-_-5BGyuw.mjs` line 8): no commands, pairing; any command, pairing and write; any of `system.run.prepare`, `system.run`, `system.which`, `system.execApprovals.get`, `system.execApprovals.set`, `browser.proxy`, `browser.proxy.upload.v1`, `fs.listDir` or `terminal.upload`, pairing and admin. **Source** for the last: the probe never declares those.

Events: `device.pair.requested` and `device.pair.resolved`, then `node.pair.requested` and `node.pair.resolved`, reached the pairing-scope operators (**live**, section 1.6).

### 1.2 Who approved what, live

Operators paired at each tier, then reconnected with their device token alone. Three new nodes, `N0` to `N2`, with the invented commands allowlisted:

```
# the device request (role node)
another device at pairing, device.pair.list: []
another device at pairing, device.pair.approve N0: {"ok":false,"error":"device pairing approval denied","code":"INVALID_REQUEST"}
(c) its own operator lists: [{"deviceId":"380ffd3e5f17","roles":["node"]}]
(c) its own operator approves its node-role request: {"ok":false,"error":"device pairing approval denied","code":"INVALID_REQUEST"}
(c) its own operator rejects it: {"ok":true, …}
admin device.pair.approve N0: {"ok":true}

# the command surface
another device at pairing, node.pair.list: {"pending":[],"paired":[]}
another device at pairing, approve N0: {"ok":false,"error":"node pairing approval denied","code":"INVALID_REQUEST"}
another device at pairing+write, approve N0: {"ok":false,"error":"node pairing approval denied","code":"INVALID_REQUEST"}
another device at pairing+write, reject N0: {"ok":false,"error":"node pairing rejection denied","code":"INVALID_REQUEST"}
N1's own device at pairing, node.pair.list: {"pending":[{"nodeId":"1fa27bdae021", … "requiredApproveScopes":["operator.pairing","operator.write"]}],"paired":[]}
N1's own device at pairing, approve N1: {"ok":false,"error":"missing scope: operator.write","code":"FORBIDDEN","details":{"code":"MISSING_SCOPE","missingScope":"operator.write","requiredScopes":["operator.pairing","operator.write"]}}
N1's own device at pairing+write, approve N2: {"ok":false,"error":"node pairing approval denied","code":"INVALID_REQUEST"}
N1's own device at pairing+write, approve N1: {"ok":true}
admin approve N0: {"ok":true}
admin reject N2: {"ok":true}
```

(`(c)` is the `same` experiment: a device paired as an operator at pairing and write, then asking for the node role.)

Why, in the source:

- **The device request.** `device.pair.approve` from a caller without admin goes through `authorizePairingDecision` (`<openclaw>/dist/devices-mOg4_HQd.mjs` line 303): another device's request is `device-ownership-mismatch`, and approving any request that includes a role other than operator is `role-management-requires-admin`. Rejecting one's own request passes (line 304: the role check is for `approve` only). `device.pair.list` gives such a caller only its own device (live: another device listed nothing).
- **The surface.** `node.pair.approve` checks ownership first (`enforcePendingNodePairingOwnership`, `<openclaw>/dist/nodes-BW91tb1K.mjs`, before line 1060) and then the scopes the commands need (`approveNodePairing` with `callerScopes`, line 1105). `node.pair.list` gives a caller without admin only its own device (line 1094).
- **"Its own device"** is the device a caller authenticated as with a device token: `callerDeviceId` is set only when `isDeviceTokenAuth` (`<openclaw>/dist/device-management-security-Dx--n3Fk.mjs` line 8; `message-handler-CRCo2VX0.mjs` line 3172).

So, for Clawtrate's kind of connection:

| Step                              | Clawtrate's own operator, without admin                                                                 | Another device without admin | Admin connection | The gateway's computer                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------- | -------------------------------------------------- |
| See the device request            | Its own only                                                                                            | Its own only                 | All              | `openclaw devices list`                            |
| Approve the device (role node)    | No                                                                                                      | No                           | Yes              | `openclaw devices approve <requestId>`             |
| Reject the device request         | Its own                                                                                                 | No                           | Yes              | `openclaw devices reject <requestId>` (not run)    |
| See the surface request           | Its own only                                                                                            | Its own only                 | All              | `openclaw nodes pending` (named in the gateway's hint, not run) |
| Approve the surface: no commands  | Its own, at pairing                                                                                     | No                           | Yes              | `openclaw nodes approve <requestId>` (named in the gateway's hint, not run) |
| Approve the surface: commands     | Its own, at pairing and write                                                                           | No                           | Yes              | the same                                           |
| Approve the surface: system, browser and file commands | No: they need admin (**source**)                                                | No                           | Yes (**source**) | the same                                           |
| Remove the node                   | No (section 6)                                                                                          | No                           | Yes              | not run                                            |

A caller that presents the shared token instead of a device token is no particular device: on the first run of this experiment, with shared-token operators, another device at pairing and write approved N0's surface. Clawtrate never sends the shared token once paired, so the table above is its case.

### 1.3 One device, both roles

Clawtrate would be one device to the gateway with both roles, so that its own operator connection can approve its own surface (section 1.2). Two orders were tried:

```
(a) operator hello: {"role":"operator","scopes":["operator.read"]}
(a) the same device connects as a node: {"code":"PAIRING_REQUIRED"}
(a) pending device requests: [{"deviceId":"40431d8763f6","role":"node","roles":["node"],"scopes":[]}]
(a) the operator reconnects asking pairing+write: {"code":"AUTH_SCOPE_MISMATCH","message":"unauthorized: device token scope mismatch (re-pair or approve scope upgrade)"}
(a) admin approves it: {"ok":true}
(a) the device now: [{"deviceId":"40431d8763f6","roles":["operator","node"],"scopes":["operator.read"]}]

(b) node first: {"code":"PAIRING_REQUIRED"}
(b) then the same device as an operator: {"code":"PAIRING_REQUIRED"}
(b) pending device requests: [{"deviceId":"b3d15c1ccb71","role":"operator","roles":["node","operator"],"scopes":["operator.read"]}]
```

- Paired as an operator first, the device's node request was a request of its own, and approving it kept the operator scopes as they were.
- With the node request waiting, a new operator request from the same device was **merged** into it: one request, `roles: ["node","operator"]`. Approving it pairs both roles. In the first run of the `tiers` experiment, a scope request approved with `openclaw devices approve` on the gateway's computer also paired the device's waiting node role (`N1-as-operator`, `roles: ["node","operator"]` afterwards).
- Not tried: `device.scopes.requestUpgrade` while the device's node request waits. Whether it merges in the same way is **unverified**.

### 1.4 On loopback, with the gateway's default

On `d16local`, with `autoApproveLocal` unset:

```
node with commands on loopback: {"hello":{"role":"node","scopes":[]}}
node.pair.list: {"pending":[],"paired":[{"nodeId":"2d98535b8dfb","displayName":"Clawtrate research N-loopback","commands":["clawtrate.probe.echo", … ,"clawtrate.probe.slow"]}]}
```

The device and its first command surface were both approved without anyone. `shouldAllowSilentLocalPairing` (`<openclaw>/dist/node-connect-reconcile-CAkPC2vI.mjs` line 178) allows it for a local connection unless `autoApproveLocal` is `false`, and the first surface is marked silent whatever it declares (line 380, `!pairedNode && params.initialSurfaceSilent`). A later change of the surface is not silent: it waits for `node.pair.approve` (section 4.2 shows one). That the admin-tier commands would also be paired silently on loopback is **source**; the probe never declares them.

The same node through a loopback proxy that adds `X-Forwarded-For` was refused before pairing, `HTTP 403 proxy_attribution_required`, as in `setup-flow.md` section 1. A connection that is not local is never paired silently (line 179, `locality === "remote"`); the instances with `autoApproveLocal: false` are the live picture of that wait.

### 1.5 What the approver sees

The device request: `displayName`, `platform`, `deviceFamily`, `clientId`, `clientMode`, `role`, `roles`, `scopes`, `silent`, `isRepair`, `ts` and the public key. The surface request: `displayName`, `platform`, `version`, `deviceFamily`, `caps`, `commands` (already filtered, section 2), `permissions`, `requiredApproveScopes` and `ts`, with `modelIdentifier` and `remoteIp` when reported. Every one of these is written by the device asking. **Live** (the key lists above).

### 1.6 Who hears about a request

**Live**, the `events` experiment, three operators of other devices connected with their device tokens while a new node was paired:

```
watch-pairing (device token) heard: ["device.pair.requested","device.pair.resolved","node.pair.requested","node.pair.resolved"]
watch-read-write (device token) heard: []
watch-read (device token) heard: []
```

So a device holding `operator.pairing` hears every device's requests, though it can list and decide only its own (section 1.2); read and write hear none. An event is a prompt to read the list again, never the list itself.

## 2. What a device offers

### 2.1 The gateway's list

`resolveNodeCommandAllowlistInternal` (`<openclaw>/dist/node-command-policy-I3ly1VaT.mjs` line 187) builds what a node may be called with: the platform's defaults (`PLATFORM_DEFAULTS`, line 69), plus Talk and Watch commands for nodes that report those surfaces, plus plugin defaults, plus, on a desktop, the desktop host commands the node had approved (`DESKTOP_HOST_COMMANDS`, line 53: the system, file, browser, MCP and screen commands), plus `gateway.nodes.commands.allow`, minus `gateway.nodes.commands.deny`. **Source.**

| Platform | Defaults (source)                                                                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS      | `camera.list`, `location.get`, `device.info`, `device.status`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `system.notify`; on an iPhone also `watch.status`, `watch.notify` |
| macOS    | `camera.list`, `camera.ptz.status`, `location.get`, `device.info`, `device.status`, `device.apps`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, and the desktop commands (`system.run`, `system.which`, `system.notify`, `fs.listDir`, `browser.proxy`, `screen.snapshot`, `computer.act` and others), of which the desktop host ones count only once approved |

Left out unless the allowlist names them (`DEFAULT_DANGEROUS_NODE_COMMANDS`, line 59): `camera.snap`, `camera.clip`, `camera.ptz.control`, `screen.record`, `contacts.add`, `calendar.add`, `reminders.add`, `sms.send`, `sms.search`, `health.summary`. `wizard.appRecommendations: false` removes `device.apps` (line 212).

Nothing in the defaults reads or sends messages or mail, or reads notes. A Mac app such as Messages, Mail or Notes needs a command the gateway does not know: an allowlist entry, or a plugin that registers a node-invoke policy (`api.registerNodeInvokePolicy`, `docs/research/gateway-capabilities.md`, "The client acting as a node"). What such a command does on the Mac is the node's own code.

### 2.2 A command that is not allowed

**Live**, on `d16node` before any allowlist entry, the node declaring the five invented commands:

```
admin node.pair.list: {"pending":[{… "commands":[],"requiredApproveScopes":["operator.pairing"]}]}
node.describe: {… "commands":[], "approvalState":"approved","paired":true,"connected":true}
invoke clawtrate.probe.echo: {"ok":false,"error":"node command not allowed: \"clawtrate.probe.echo\" is not in the allowlist for platform \"macos\"","code":"INVALID_REQUEST","details":{"reason":"command not allowlisted","command":"clawtrate.probe.echo"}}
```

Dropped silently: the node's hello said nothing about it, the request listed nothing, and only a call reveals it, with the gateway's sentence (`buildNodeCommandRejectionHint`, `<openclaw>/dist/nodes-BW91tb1K.mjs` line 400, which also has sentences for a denied command, a dangerous one and a surface still waiting for approval). So what a device offers is what `node.describe` reads back, never what the app declared.

### 2.3 The owner's allowlist

```
allowlist the invented commands: {"ok":true}            # config.patch, admin
config.get gateway.nodes (admin): {"pairing":{"autoApproveLocal":false},"commands":{"allow":["clawtrate.probe.echo", …]}}
config.get at read: {"nodes":{"pairing":{"autoApproveLocal":false},"commands":{"allow":["clawtrate.probe.echo", …]}}}
allowlist emptied while the call waits: {"ok":false,"error":"config.patch would remove entries from array path(s): gateway.nodes.commands.allow. Pass replacePaths with the exact path(s) when this is intentional, or use config.apply for full-config replacement."}
```

The allowlist is admin configuration, read back at read, and removing an entry needs `replacePaths: ["gateway.nodes.commands.allow"]` in the same `config.patch`. No `node.*` method changes it. It applies to every node and every bot: no per-bot setting for node commands was found. Which bots can call a node at all is each bot's `nodes` tool, a tool permission (`docs/design/controls.md`).

## 3. A call to a node

### 3.1 Live, from both ends

A node `N-invoke` paired with the commands allowlisted; an operator at read and write, and one at read:

```
[node] got node.invoke.request {"id":"ac618ebc-8e0","command":"clawtrate.probe.echo","paramsJSON":"{\"note\":\"fixed probe parameters\"}","timeoutMs":2993}
writer echo: {"ok":true,"result":{"ok":true,"nodeId":"dad8f7cf…","command":"clawtrate.probe.echo","payload":{"text":"Fixed answer from the stand-in node."},"payloadJSON":null}}
writer refuse: {"ok":false,"error":"NOT_ALLOWED_ON_DEVICE: The person has not allowed this on the stand-in node.","code":"UNAVAILABLE","details":{"nodeError":{"code":"NOT_ALLOWED_ON_DEVICE","message":"The person has not allowed this on the stand-in node."},"nodeCommandDispatched":true}}
writer silent, 2000 ms: {"ok":false,"ms":2006,"error":"TIMEOUT: node invoke timed out","code":"UNAVAILABLE","details":{"nodeError":{"code":"TIMEOUT","message":"node invoke timed out"},"nodeCommandDispatched":true}}
writer late, 2000 ms: {"ok":false,"ms":2003,"error":"TIMEOUT: node invoke timed out", …}
[node] node.invoke.result for clawtrate.probe.late answered: {"ok":true,"ignored":true}
[node] got node.invoke.request {… "command":"clawtrate.probe.silent", … "timeoutMs":30000}
writer silent, no timeoutMs: {"ok":false,"ms":30056,"error":"TIMEOUT: node invoke timed out", …}
reader echo: {"ok":false,"error":"missing scope: operator.write","code":"FORBIDDEN"}
writer undeclared clawtrate.probe.other: {"ok":false,"error":"node command not allowed: \"clawtrate.probe.other\" is not in the allowlist for platform \"macos\"", …}
node.describe after it left: {"connected":false,"lastSeenReason":"connect","approvalState":"approved"}
writer echo, node offline: {"ok":false,"ms":89,"error":"node not connected","code":"UNAVAILABLE","details":{"code":"NOT_CONNECTED","nodeError":{"code":"NOT_CONNECTED","message":"node not connected"},"nodeCommandDispatched":false}}
```

- **The request** carries the time left (`timeoutMs`), 30 000 ms when the caller gave none. Its builder also sets `sessionKey` when the caller passed one (`buildNodeInvokeRequest`, `<openclaw>/dist/node-invoke-request-NMUgqchA.mjs` line 3); the published `NodeInvokeRequestEvent` (`schema`) does not list it. A bot's `nodes` tool passes its task's key only for the raw `invoke` action, not for `location_get` and the other named actions (`<openclaw>/dist/openclaw-tools-DV-z1IAc.mjs`, `executeNodeCommandAction`). So the node knows which task asked only sometimes. **Source.**
- **A refusal** reaches the caller as `"<code>: <message>"`, the node's own words, with `nodeCommandDispatched: true`. The schema bounds neither (`NodeInvokeResultParams.error`, `schema`), so the words are whatever the node writes.
- **No answer** ends the call at the caller's limit, `TIMEOUT`. **An answer after it** is acknowledged to the node as `{"ok":true,"ignored":true}` and reaches no one ("late invoke result ignored", `nodes-BW91tb1K.mjs` line 470).
- **A node not connected**: the gateway tries to wake it, then answers `NOT_CONNECTED` with `nodeCommandDispatched: false` (line 814).
- `node.invoke` is write; the admin-only commands are the browser proxy, `fs.listDir` and `terminal.upload` (line 706). `node.list` and `node.describe` answer at read, with `commands`, `permissions`, `connected`, `lastSeenAtMs` and `approvalState`.

### 3.2 What the bot sees

A bot reaches a node through its `nodes` tool, which calls `node.invoke` (`callNodesToolNodeInvoke`). A failure is rethrown as `agent=<agent> node=<node> gateway=<gateway> action=<action>: <message>` (`openclaw-tools-DV-z1IAc.mjs` lines 9719-9729), where `<message>` is the gateway's message above. So the bot reads the node's refusal in the node's words, "TIMEOUT: node invoke timed out" for no answer in time, and "node not connected" for a node that is gone. **Source**: the development gateway denies every bot's `nodes` tool, so no bot called the stand-in node. The same tool has `pending`, `approve` and `reject` actions for node pairing, which ask the gateway for the scopes the request needs (`resolveNodePairApproveScopes`, line 9588); what a bot's run is granted was not exercised.

## 4. Permission and resume

### 4.1 What holds a permission

The node reports `permissions` at connect. The gateway records them and shows them in `node.describe`, and does not use them to admit a call: `N-invoke` reported `{"clawtrate.probe": false}` and every call above was still delivered to it. **Live.** The only gateway use found is `permissions.accessibility` for presence reports (`gateway-capabilities.md`, "The client acting as a node"). So the node enforces its own permission and refuses what it cannot serve.

### 4.2 A permission granted later

```
reconnect reporting the permission granted: {"hello":{"role":"node","scopes":[]}}
node.pair.list: [{… "permissions":{"clawtrate.probe":true},"requiredApproveScopes":["operator.pairing","operator.write"]}]
node.describe permissions: {"clawtrate.probe":false}
a call meanwhile: {"ok":true}
admin approves the new surface: true
node.describe permissions after: {"clawtrate.probe":true}
reconnect reporting it withdrawn: {"hello":{"role":"node","scopes":[]}}
node.pair.list: []
```

A permission newly reported as granted files a new surface request (`node-connect-reconcile-CAkPC2vI.mjs` line 355); until it is approved the gateway keeps showing the old value, and calls go on being delivered. A permission withdrawn needs no approval. **Live.**

### 4.3 The five minutes, the hour, and once

Searched in `nodes-BW91tb1K.mjs`, `nodes-policy-DtB0mmj2.mjs`, `node-command-policy-I3ly1VaT.mjs` and the `nodes` tool: no five-minute or one-hour limit for a node's permission, no record of a refused call, and nothing that runs a call again. The only timers are the call's own limit (30 s unless the caller sets one, live) and the background queue's 10 minutes (section 5). **Source.**

| The rule (F-348, F-451, F-452)                                  | Who could enforce it                                                                                                       | What the design does                                                                                                                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The card waits five minutes, then reads "Timed out"             | Only the node: the call itself ends at its own limit, 30 s by default, and the bot sets its own (`invokeTimeoutMs`)        | The app's: the card on the device answers the call while the call lasts and stays open five minutes from the request. The builder's test: a fake clock at 4:59 and 5:00.  |
| Allowing within an hour lets the bot pick the request up        | Nothing: the gateway does not re-deliver a call, never queues a bot's call (section 5), and a node cannot start a bot's turn | Cut. Allowing after the call ended saves the permission for later requests and says that nothing ran.                                                                     |
| …once, and only if the policy still allows it                   | The gateway checks every new call when it is made (live: `POLICY_CHANGED`, "not in the allowlist")                       | Holds for the bot's next call, by the gateway. "Once" is cut: nothing limits how often a bot asks.                                                                           |
| Allowing after an hour saves the permission for later requests  | Only the node: its own permission store                                                                                   | The app's: the same as any allow after the call ended. The builder's test: allow at 61 minutes, then a new request is served and nothing else is sent.                    |

## 5. The phone in the background (source only)

`shouldQueueAsPendingForegroundAction` (`<openclaw>/dist/nodes-BW91tb1K.mjs` line 493) queues a failed call only when the node's platform is iOS or iPadOS, the command is `camera.*`, `screen.*`, `talk.*` or a plugin command declared foreground-restricted, and the node's error is `NODE_BACKGROUND_UNAVAILABLE`. Then (line 973) only if the caller is not an agent runtime (`!client?.internal?.agentRuntimeIdentity`) and carries no forwarded approval authority. The queue keeps an action 10 minutes, at most 64 per node (`nodeInvokePolicy.pendingActionTtlMs: 6e5`, `pendingActionMaxPerNode: 64`, `<openclaw>/dist/nodes-policy-DtB0mmj2.mjs` lines 9-10). The caller is answered `UNAVAILABLE` "node command queued until iOS returns to foreground" with `QUEUED_UNTIL_FOREGROUND` and a `queuedActionId`. When the node returns it pulls with `node.pending.pull` and acknowledges with `node.pending.ack`; a pull drops actions the current allowlist no longer admits (`resolveAllowedPendingNodeActions`, line 547). The gateway also tries an APNs wake (`maybeWakeNodeWithApns`), which needs the node to have registered for push.

What that means for a bot: its call comes from its run, an agent runtime, so it is never queued. The bot gets the node's own error at once, through the `nodes` tool, and nothing is replayed for it when the phone comes back. A phone whose app was suspended and whose socket closed is simply not connected (`NOT_CONNECTED`, section 3.1). None of Clawtrate's own screens call `node.invoke`, so nothing of Clawtrate's is ever in that queue. Not exercised live: the probe's node was a macOS stand-in.

## 6. Taking it back

**Live**, with a call waiting on `clawtrate.probe.slow` (answered after 3 s, limit 8 s):

```
allowlist emptied while the call waits: {"ok":true}                    # config.patch with replacePaths
the waiting call ended: {"ok":false,"ms":1296,"error":"POLICY_CHANGED: node command is no longer allowed","code":"UNAVAILABLE","details":{"nodeError":{"code":"POLICY_CHANGED","message":"node command is no longer allowed"},"nodeCommandDispatched":true}}
[node] node.invoke.result for clawtrate.probe.slow answered: {"ok":true,"ignored":true}
a new call after: {"ok":false,"error":"node command not allowed: \"clawtrate.probe.echo\" is not in the allowlist for platform \"macos\""}
node.describe commands after: []

the node's own device removes it: {"ok":false,"error":"node pairing removal denied","code":"INVALID_REQUEST"}
another device at pairing removes it: {"ok":false,"error":"node pairing removal denied","code":"INVALID_REQUEST"}
admin removes it while the call waits: {"ok":true,"result":{"nodeId":"cc13439f…"}}
the waiting call ended: {"ok":false,"ms":1107,"error":"node pairing changed while invocation was active","code":"UNAVAILABLE","details":{"code":"PAIRING_CHANGED"}}
the node connects again: {"code":"NOT_PAIRED","details":{"code":"PAIRING_REQUIRED","reason":"role-upgrade","requestedRole":"node","approvedRoles":["operator"], …}}
```

- Removing an allowlist entry stops the gateway at once: the waiting call ends, the node's answer is ignored, later calls are refused, and the node's surface reads back without the command. It cannot undo what the node already did with the request it received (`nodeCommandDispatched: true`).
- Removing the node needs admin: a caller without it, even the node's own device, is refused (`node.pair.remove`, `nodes-BW91tb1K.mjs` line 1211, `role-management-requires-admin`). The device keeps its other roles, and the node connecting again asks for the role afresh.
- The node can always refuse by itself, at once, whatever the gateway allows.

## 7. The share sheet, Siri and Shortcuts

**Live**, on `d16node`:

```
agents.list at read: {"defaultId":"main","agents":["main","marlow","otto","pip"]}
users.prefs.get at read: {"keys":[]}
sessions.create with a message at read: {"ok":false,"error":"missing scope: operator.write"}
sessions.create with a message at write: {"ok":true,"keys":["ok","key","sessionId","entry","runStarted","publicRead","runId","status","messageSeq","resolved"],"key":"agent:main:dashboard:9cf3ef10-…","runId":true}
```

- The primary bot is the design on the branch `d6-bots-lifecycle-design` (not merged): the person's preference `clawtrate.primary` in `users.prefs`, `{bot: <id>}`, or the gateway's default bot (`agents.list` `defaultId`) when the key is absent, `{bot: null}`, or names a bot no longer listed. Reading it is read; choosing it is write.
- Starting a task with a message is `sessions.create {agentId, message, idempotencyKey}` at write, the same call as New chat in the app; files go through the composer's attachment path (F-284), which this note does not re-test.
- On the iPhone, **unverified** here, since the app is not on `main`: what a share extension receives, whether it can use the app's paired device credential through a shared keychain, whether it can open the app, and what an App Intent's confirmation shows. The design names each as a builder's proof.

## 8. Approval cards and a node's permission

A gateway approval is a record the gateway keeps and sends to the device that started the run and to admin connections (`docs/design/controls.md`, section 3). An ordinary `node.invoke` makes none: the only approval binding on the node path is for `system.run` (`sanitizeSystemRunParamsForForwarding`, `nodes-BW91tb1K.mjs` lines 246-382). So a node's question to its person ("Allow Location?") is not a gateway approval: no card for it reaches any other device, nothing records the answer, and the answer means only what the node then does. It is asked on the node, which is the device that holds the permission, and that need not be the device whose message started the run.

## 9. What this note did not establish

- An iOS node, its background behaviour and APNs wake: source only.
- A bot calling a node: the development gateway denies the `nodes` tool, so the bot's view is source only.
- The admin tier for the system, browser and file commands, and their silent pairing on loopback: source only, never declared.
- `device.scopes.requestUpgrade` while the same device's node request waits.
- Pairing across a real network: the proxy check stopped at `proxy_attribution_required`.
- Everything on the iPhone itself for the share sheet, Siri and Shortcuts.
